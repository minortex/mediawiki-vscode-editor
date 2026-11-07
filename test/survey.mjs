import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));
const Parser = require('wikiparser-node');
const OpenCC = require('opencc-js');
const { WebSocketServer } = require('ws');
const toSimp = OpenCC.Converter({ from: 'tw', to: 'cn' });

const SCRIPT = fs.readFileSync(
  new URL('../userscript/vcpedia-vscode-editor.user.js', import.meta.url),
  'utf8'
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchT = (u, o = {}) => fetch(u, { ...o, signal: AbortSignal.timeout(2000) });
const API = 'https://vcpedia.cn/api.php';
const BROWSER = Number(process.env.BROWSER_PORT || 9222);

async function api(params) {
  try {
    const u = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
    return await (await fetchT(u, { headers: { 'user-agent': 'survey/2.0' } })).json();
  } catch {
    return {};
  }
}
async function randomNs(ns, n) {
  const d = await api({ action: 'query', list: 'random', rnnamespace: ns, rnlimit: n });
  return (d.query?.random || []).map((r) => r.title);
}
async function categoryMembers(cat, n) {
  const d = await api({ action: 'query', list: 'categorymembers', cmtitle: '分类:' + cat, cmlimit: n, cmnamespace: 0 });
  return (d.query?.categorymembers || []).map((r) => r.title);
}
async function canParse(title) {
  const d = await api({ action: 'parse', page: title, prop: 'text' });
  return !d.error && (d.parse?.text?.length || 0) > 40;
}

function simplify(s) { try { return toSimp(s); } catch { return s; } }
function extractItems(text) {
  const root = Parser.parse(text);
  const items = [];
  const add = (value, start) => {
    const s = simplify(String(value || '').replace(/<!--|-->/g, '').replace(/\s+/g, ' ').trim());
    if (/\.(jpe?g|png|gif|svg|webp|ogg|mp3|webm|pdf)$/i.test(s)) return;
    if (s.length >= 2 && s.length <= 60) items.push({ start, text: s });
  };
  const walk = (node) => {
    const name = node.constructor.name;
    if (name === 'LinkToken') {
      const raw = node.toString();
      const m = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(raw);
      add(m ? (m[2] || m[1]) : raw, node.getAbsoluteIndex());
      return;
    }
    if (name === 'AstText') {
      const raw = node.toString();
      const base = node.getAbsoluteIndex();
      let cursor = 0;
      for (const part of raw.split(/[•·、,，;；\n]+/)) {
        const idx = raw.indexOf(part, cursor);
        add(part, base + Math.max(0, idx));
        cursor = Math.max(cursor, idx + part.length);
      }
      return;
    }
    for (const child of node.childNodes || []) walk(child);
  };
  for (const child of root.childNodes || []) walk(child);
  items.sort((a, b) => a.start - b.start);
  return items;
}
function pickItems(items) {
  const usable = items.filter(
    (it) => /[\u4e00-\u9fff]/.test(it.text) && it.text.length >= 3 && it.text.length <= 24
  );
  const picks = [];
  for (const frac of [0.2, 0.75]) {
    if (!usable.length) break;
    const it = usable[Math.min(usable.length - 1, Math.floor(usable.length * frac))];
    if (!picks.some((p) => p.text === it.text)) picks.push(it);
  }
  return picks;
}

const candidates = [];
const push = (t) => { if (t && !candidates.includes(t)) candidates.push(t); };
for (const t of await randomNs(0, 2)) push(t);
for (const t of await randomNs(10, 2)) if (!/(\.css|\/doc|\/styles|\.js)$/i.test(t)) push(t);
for (const t of await randomNs(4, 2)) push(t);
for (const t of await randomNs(828, 1)) if (!/\/doc$/i.test(t)) push(t);
for (const cat of ['软件', '活动', '2024年音乐专辑', 'Synthesizer V']) {
  for (const t of await categoryMembers(cat, 1)) push(t);
}
const PAGES = [];
for (const t of candidates) {
  if (t.startsWith('VCPedia:') || await canParse(t)) PAGES.push(t);
  if (PAGES.length >= 9) break;
}
console.log('pages:', PAGES);

async function newTarget(url) {
  return (await fetchT('http://127.0.0.1:' + BROWSER + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })).json();
}
function pageUrl(title) {
  const t = title.replace(/ /g, '_');
  return 'https://vcpedia.cn/' + t.split('/').map((s) => encodeURIComponent(s).replace(/%3A/gi, ':')).join('/');
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => reject(new Error('connect timeout')), 2000);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        send: (method, params = {}) =>
          Promise.race([
            new Promise((res) => {
              const i = ++id;
              pending.set(i, res);
              ws.send(JSON.stringify({ id: i, method, params }));
            }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout')), 1500)),
          ]),
        close: () => ws.close(),
      });
    });
    ws.addEventListener('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: 8927,
  verifyClient: (i, d) => d(!i.req.headers.origin || i.req.headers.origin === 'https://vcpedia.cn'),
});
wss.on('error', (err) => {
  console.error('cannot listen on 8927 (stop VSCodium first):', err.message);
  process.exit(1);
});
const state = { socket: null, sessionId: null };
wss.on('connection', (ws) => {
  state.socket = ws;
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw);
      if (m.type === 'open') state.sessionId = m.sessionId;
    } catch {}
  });
  ws.on('close', () => { if (state.socket === ws) state.socket = null; });
});

async function getText(title) {
  const d = await api({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: title });
  return d.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content ?? null;
}

const results = [];
for (const title of PAGES) {
  state.socket = null;
  state.sessionId = null;

  let text = null;
  try { text = await getText(title); } catch {}
  if (text == null) { results.push([title, '-', 'NO WIKITEXT']); continue; }
  const picks = pickItems(extractItems(text));
  if (!picks.length) { results.push([title, '-', 'NO ITEMS']); continue; }

  let target = null;
  let cdp = null;
  try {
    target = await newTarget(pageUrl(title));
    cdp = await connect(target.webSocketDebuggerUrl);
  } catch (e) {
    results.push([title, '-', 'OPEN-FAIL']);
    if (target) await fetchT('http://127.0.0.1:' + BROWSER + '/json/close/' + target.id).catch(() => {});
    continue;
  }
  const ev = async (expr) => {
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      return r.result?.result?.value;
    } catch { return undefined; }
  };

  let loaded = false;
  for (let i = 0; i < 8; i++) {
    if (await ev(`!!(window.mw && mw.config.get('wgPageName').replace(/_/g,' ') === ${JSON.stringify(title.replace(/_/g, ' '))} && document.querySelector('#mw-content-text'))`)) {
      loaded = true; break;
    }
    await sleep(250);
  }
  if (!loaded) {
    results.push([title, '-', 'LOAD-TIMEOUT']);
    await fetchT('http://127.0.0.1:' + BROWSER + '/json/close/' + target.id).catch(() => {});
    cdp.close();
    continue;
  }

  await ev(`document.getElementById('vcpe-fab')?.remove(); document.querySelector('.vcpe-bar')?.remove();`);
  await ev(SCRIPT);
  for (let i = 0; i < 8; i++) {
    if (await ev(`document.getElementById('vcpe-fab')?.textContent === 'VSCode 编辑'`)) break;
    await sleep(250);
  }
  await ev(`document.getElementById('vcpe-fab').click()`);
  let ready = false;
  for (let i = 0; i < 8; i++) {
    if (await ev(`(document.querySelector('.vcpe-bar .vcpe-status')?.textContent || '').includes('预览已更新')`)) {
      ready = true; break;
    }
    await sleep(250);
  }
  // wait for the open message (session id) from this page
  for (let i = 0; i < 8 && !state.sessionId; i++) await sleep(250);
  if (!ready) {
    results.push([title, '-', 'PREVIEW-TIMEOUT']);
    await fetchT('http://127.0.0.1:' + BROWSER + '/json/close/' + target.id).catch(() => {});
    cdp.close();
    continue;
  }

  for (const item of picks) {
    const present = await ev(`document.querySelector('#mw-content-text').textContent.includes(${JSON.stringify(item.text)})`);
    let overlay = null;
    if (present && state.socket && state.socket.readyState === 1 && state.sessionId) {
      state.socket.send(JSON.stringify({ type: 'scroll', sessionId: state.sessionId, text: item.text, occurrence: 1 }));
      await sleep(600);
      overlay = await ev(`(() => {
        const boxes = [...document.body.children].filter(el => el.tagName === 'DIV' && (el.getAttribute('style') || '').includes('outline'));
        const b = boxes[boxes.length - 1];
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { center: Math.round((r.top + r.bottom) / 2), vh: innerHeight, h: Math.round(r.height) };
      })()`);
    }
    const ok = overlay && Math.abs(overlay.center - overlay.vh / 2) < overlay.vh * 0.4;
    results.push([
      title,
      item.text.slice(0, 14),
      !present ? 'NOT IN PREVIEW' : ok ? 'ok' : overlay ? 'off-center' : 'no overlay',
      overlay?.center ?? '-',
      overlay?.h ?? '-',
    ]);
  }

  await ev(`document.querySelector('.vcpe-cancel')?.click()`).catch(() => {});
  await sleep(150);
  await fetchT('http://127.0.0.1:' + BROWSER + '/json/close/' + target.id).catch(() => {});
  cdp.close();
  state.socket = null;
  state.sessionId = null;
  await sleep(150);
}

for (const c of wss.clients) c.terminate();
wss.close();
console.log('\n=== results ===');
for (const r of results) console.log(r.join(' | '));
process.exit(0);
