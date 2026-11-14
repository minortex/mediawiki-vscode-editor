/**
 * Load the locally built InPageEdit plugin into the page's real InPageEdit
 * instance, the same way the plugin registry does (`ipe.plugin(module)`), so
 * the plugin runs with the genuine InPageEdit context: its toolbox button,
 * i18n, modal and wikiPage services.
 *
 * Use it to test `ipe-plugin` without publishing a new registry version. The
 * plugin still talks to the running VSCode extension on ws://127.0.0.1:8927
 * (or WS_PORT).
 *
 * Prerequisites:
 *   npm run build:ipe
 *   Chrome with --remote-debugging-port=9222 and a wiki page with InPageEdit
 *   loaded (window.ipe must exist, i.e. the InPageEdit gadget is active)
 *
 * Usage:
 *   node scripts/inject-plugin.mjs
 *   TARGET_URL=https://example.org/wiki/Sandbox node scripts/inject-plugin.mjs
 *   BROWSER_PORT=9333 WS_PORT=8930 node scripts/inject-plugin.mjs --reload
 *
 * Without TARGET_URL the first ready wiki tab is used. Pass --reload to force
 * a fresh page reload before injecting.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(REPO, 'package.json'));
const {WebSocket} = require('ws');

const CDP_PORT = Number(process.env.BROWSER_PORT || 9222);
const WS_PORT = Number(process.env.WS_PORT || 8927);
const TARGET_URL = process.env.TARGET_URL || '';
const FORCE_RELOAD = process.argv.includes('--reload');
const NOT_A_PAGE = /^(chrome|chrome-extension|devtools|edge|about):/iu;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const READY = 'document.readyState === "complete" && !!window.mw && !!mw.config.get("wgPageName")';
const IPE_READY = `${READY} && !!window.ipe && typeof window.ipe.plugin === "function"`;

async function cdpJson(pathname, init) {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}${pathname}`, init);
  return response.json();
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {perMessageDeflate: false});
    const timer = setTimeout(() => reject(new Error('cdp connect timeout')), 5000);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data.toString());
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      entry(msg);
    });
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        send(method, params = {}) {
          return new Promise(res => {
            const id = ++seq;
            pending.set(id, res);
            ws.send(JSON.stringify({id, method, params}));
          });
        },
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function probeTab(wsUrl, expression, timeoutMs = 8000) {
  const cdp = await connectCdp(wsUrl);
  try {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const reply = await Promise.race([
        cdp.send('Runtime.evaluate', {expression, returnByValue: true}),
        sleep(1500).then(() => undefined),
      ]);
      if (reply?.result?.result?.value === true) return true;
      await sleep(300);
    }
    return false;
  } finally {
    cdp.close();
  }
}

function sameUrl(a, b) {
  if (a === b) return true;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

async function resolveTarget() {
  const targets = await cdpJson('/json/list');
  if (TARGET_URL) {
    const existing = targets.find(item => item.type === 'page' && sameUrl(item.url, TARGET_URL))
      ?? targets.find(item => item.type === 'page' && item.url.startsWith(TARGET_URL));
    if (existing) return {target: existing, opened: false};
    const opened = await cdpJson(`/json/new?${encodeURIComponent(TARGET_URL)}`, {method: 'PUT'});
    return {target: opened, opened: true};
  }
  for (const page of targets.filter(item => item.type === 'page' && !NOT_A_PAGE.test(item.url))) {
    try {
      // Background tabs can stall ResourceLoader; bring the tab forward first.
      await cdpJson(`/json/activate/${page.id}`).catch(() => undefined);
      if (await probeTab(page.webSocketDebuggerUrl, IPE_READY)) {
        return {target: page, opened: false};
      }
    } catch {}
  }
  throw new Error('no MediaWiki page with InPageEdit found; open one or set TARGET_URL');
}

function injectionScript(pluginSource) {
  return `(() => {
  // Replace a previous instance instead of stacking copies.
  try {
    window.__ipeDev?.scope?.dispose?.()
  } catch {}
  const src = ${JSON.stringify(pluginSource)}
  ;(0, eval)(src.replace(/export\\s*\\{\\s*(\\w+)\\s+as\\s+default\\s*\\};?/, 'window.__plugin = $1;'))
  const plugin = window.__plugin
  if (typeof plugin?.apply !== 'function') {
    return {installed: false, error: 'plugin bundle has no apply()'}
  }
  // Same path the InPageEdit registry uses: the real ctx resolves inject,
  // renders the toolbox button and provides i18n / wikiPage / modal.
  const scope = window.ipe.plugin(plugin)
  window.__ipeDev = {plugin, scope}
  return {
    installed: true,
    ipe: window.ipe.version,
    toolboxEntry: !!window.ipe.toolbox?.buttons?.some?.(entry => entry.id === 'vscode-editor-page'),
    injected: !!window.__ipeDev,
  }
})()`;
}

async function main() {
  const pluginPath = path.join(REPO, 'ipe-plugin/dist/index.mjs');
  if (!fs.existsSync(pluginPath)) throw new Error('missing build: run npm run build:ipe');
  const pluginSource = fs
    .readFileSync(pluginPath, 'utf8')
    .replaceAll('ws://127.0.0.1:8927', `ws://127.0.0.1:${WS_PORT}`);

  const {target, opened} = await resolveTarget();
  await cdpJson(`/json/activate/${target.id}`).catch(() => undefined);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  const evaluate = async (expression, timeoutMs = 20000) => {
    const reply = await Promise.race([
      cdp.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}),
      sleep(timeoutMs).then(() => { throw new Error('evaluate timeout'); }),
    ]);
    if (reply.result?.exceptionDetails) {
      const details = reply.result.exceptionDetails;
      throw new Error(details.exception?.description || details.text || 'evaluate failed');
    }
    return reply.result?.result?.value;
  };
  const waitFor = async (label, fn, timeoutMs = 40000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const value = await fn();
        if (value) return value;
      } catch {}
      await sleep(200);
    }
    throw new Error(`timeout: ${label}`);
  };

  try {
    if (FORCE_RELOAD) {
      console.log('reloading the page before injecting…');
      await evaluate('location.reload(); true').catch(() => undefined);
    }
    await waitFor('page with InPageEdit ready', async () => {
      try {
        return await evaluate(IPE_READY);
      } catch {
        return false;
      }
    });
    const result = await evaluate(injectionScript(pluginSource));
    if (result?.installed !== true) {
      throw new Error(result?.error || 'injection failed');
    }
    // apply() waits for the injected IPE services, so the toolbox entry can
    // appear a moment after ipe.plugin() returns.
    await waitFor('plugin applied', async () => {
      try {
        return await evaluate(
          '!!window.ipe?.toolbox?.buttons?.some?.(entry => entry.id === "vscode-editor-page")',
        );
      } catch {
        return false;
      }
    }, 15000);
    console.log(`plugin loaded into InPageEdit ${result.ipe} on ${target.url}`);
    console.log('the edit button is in the InPageEdit toolbox, same as a published plugin.');
    console.log(`VSCode extension expected on ws://127.0.0.1:${WS_PORT}`);
    if (opened) console.log('opened a new tab for TARGET_URL.');
  } finally {
    cdp.close();
  }
}

await main();
