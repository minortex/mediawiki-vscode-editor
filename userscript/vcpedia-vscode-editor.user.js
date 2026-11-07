// ==UserScript==
// @name         VCPedia ⇄ VSCode 外部编辑器
// @namespace    vcpedia-vscode-editor
// @version      0.2.4
// @description  在 vcpedia.cn 上发起编辑，用 VSCode 改，保存即预览，浏览器内提交
// @match        https://vcpedia.cn/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  console.info('[vcpedia-vscode] userscript 0.2.4 loaded');

  const WS_URL = 'ws://127.0.0.1:8927';
  const RECONNECT_MS = 1000;
  // 默认 vscodium://；VS Code 可在本站控制台执行
  // localStorage.setItem('vcpe-editor-scheme', 'vscode') 切换
  const EDITOR_SCHEME =
    localStorage.getItem('vcpe-editor-scheme') || 'vscodium';
  const EDITOR_URI = `${EDITOR_SCHEME}://local.vcpedia-vscode-editor/wake`;

  // ---------- 与站点 API 交互 ----------
  const scriptPath = (window.mw && mw.config.get('wgScriptPath')) || '';
  const apiUrl = `${location.origin}${scriptPath}/api.php`;

  async function apiGet(params) {
    const u = new URL(apiUrl);
    u.search = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
    const r = await fetch(u, { credentials: 'same-origin' });
    return r.json();
  }

  async function apiPost(params) {
    const r = await fetch(apiUrl, {
      method: 'POST',
      credentials: 'same-origin',
      body: new URLSearchParams({ format: 'json', formatversion: '2', ...params }),
    });
    return r.json();
  }

  // ---------- 连接 VSCode 扩展 ----------
  let socket = null;
  let connected = false;
  let session = null;
  let pendingEdit = null;
  let lastLaunch = 0;

  function connect() {
    try {
      socket = new WebSocket(WS_URL);
    } catch {
      setTimeout(connect, RECONNECT_MS);
      return;
    }
    socket.addEventListener('open', () => {
      connected = true;
      refreshStatus();
      if (pendingEdit) {
        const pending = pendingEdit;
        pendingEdit = null;
        startEdit(pending.section);
      }
    });
    socket.addEventListener('close', () => {
      connected = false;
      refreshStatus();
      setTimeout(connect, RECONNECT_MS);
    });
    socket.addEventListener('error', () => { try { socket.close(); } catch {} });
    socket.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!session || msg.sessionId !== session.id) return;
      if (msg.type === 'update') {
        session.text = msg.text;
        session.changed = true;
        schedulePreview();
      } else if (msg.type === 'state') {
        session.remoteDirty = !!msg.dirty;
        refreshBar();
      } else if (msg.type === 'scroll') {
        if (scrollToText(msg.texts)) return;
        const el = msg.template
          ? templateMap.get(normTemplate(msg.template))
          : null;
        if (el) el.scrollIntoView({ block: 'center' });
        else scrollToPosition(msg.heading, msg.ratio, msg.center);
      }
    });
  }

  function launchEditor() {
    if (Date.now() - lastLaunch < 10000) return;
    lastLaunch = Date.now();
    notify('正在启动 VSCode…');
    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    frame.src = EDITOR_URI;
    document.body.append(frame);
    setTimeout(() => frame.remove(), 3000);
  }

  function send(msg) {
    if (!connected || !socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(msg));
    return true;
  }

  // ---------- 界面 ----------
  const css = `
    .vcpe-fab{position:fixed;right:20px;bottom:24px;z-index:2147483000;display:flex;gap:8px;align-items:center;
      background:#3366cc;color:#fff;border:none;border-radius:999px;padding:10px 16px;font-size:14px;font-weight:600;
      box-shadow:0 2px 10px rgba(0,0,0,.3);cursor:pointer}
    .vcpe-fab:hover{background:#2a56a8}
    .vcpe-fab.offline{background:#72777d}
    .vcpe-sec{margin-left:6px;padding:0 6px;border:1px solid #a2a9b1;border-radius:3px;font-size:12px;
      text-decoration:none;background:#f8f9fa;color:#3366cc}
    .vcpe-sec:hover{background:#eaf3ff}
    .vcpe-bar{position:fixed;left:0;right:0;bottom:0;z-index:2147483001;display:flex;gap:10px;align-items:center;
      flex-wrap:wrap;background:#fff;border-top:2px solid #3366cc;padding:10px 16px;
      box-shadow:0 -2px 12px rgba(0,0,0,.15);font-size:14px;color:#202122}
    .vcpe-bar .vcpe-title{font-weight:700;margin-right:4px}
    .vcpe-bar .vcpe-status{color:#72777d}
    .vcpe-bar input[type=text]{flex:1 1 260px;min-width:180px;padding:6px 10px;border:1px solid #a2a9b1;border-radius:4px}
    .vcpe-bar button{padding:6px 14px;border-radius:4px;border:1px solid #a2a9b1;background:#f8f9fa;cursor:pointer}
    .vcpe-bar button.vcpe-save{background:#3366cc;border-color:#3366cc;color:#fff;font-weight:600}
    .vcpe-bar button:disabled{opacity:.5;cursor:not-allowed}
    .vcpe-bar label{display:flex;align-items:center;gap:4px;white-space:nowrap}
    body.vcpe-editing{padding-bottom:80px}
    .vcpe-hit{outline:2px solid #3366cc;background:rgba(51,102,204,.08)}
  `;

  function injectStyle() {
    if (document.getElementById('vcpe-style')) return;
    const s = document.createElement('style');
    s.id = 'vcpe-style';
    s.textContent = css;
    document.head.append(s);
  }

  function ensureFab() {
    if (document.getElementById('vcpe-fab')) return;
    const btn = document.createElement('button');
    btn.id = 'vcpe-fab';
    btn.className = 'vcpe-fab';
    btn.textContent = 'VSCode 编辑';
    btn.addEventListener('click', () => startEdit(null));
    document.body.append(btn);
    refreshStatus();
  }

  function refreshStatus() {
    const fab = document.getElementById('vcpe-fab');
    if (fab) {
      fab.classList.remove('offline');
      fab.textContent = connected ? 'VSCode 编辑' : '启动 VSCode';
      fab.title = connected ? 'VSCode 扩展已连接' : '点击启动 VSCode 并开始编辑';
    }
    const st = document.querySelector('.vcpe-status');
    if (st) st.textContent = connected ? '已连接 VSCode' : 'VSCode 扩展未连接，等待重连…';
  }

  function addSectionButtons() {
    const content = document.querySelector('#mw-content-text .mw-parser-output');
    if (!content) return;
    content.querySelectorAll('.mw-editsection a[href*="action=edit"]').forEach((a) => {
      if (a.parentElement.querySelector('.vcpe-sec')) return;
      const section = new URL(a.href, location.href).searchParams.get('section');
      if (section == null) return;
      const link = document.createElement('a');
      link.className = 'vcpe-sec';
      link.href = '#';
      link.textContent = 'VSCode';
      link.title = '用 VSCode 编辑本节';
      link.addEventListener('click', (e) => { e.preventDefault(); startEdit(section); });
      a.after(link);
    });
  }

  function notify(text, ms = 3200) {
    let el = document.getElementById('vcpe-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'vcpe-toast';
      el.style.cssText =
        'position:fixed;right:20px;bottom:84px;z-index:2147483002;max-width:360px;' +
        'background:#202122;color:#fff;padding:10px 14px;border-radius:6px;font-size:13px;' +
        'box-shadow:0 2px 10px rgba(0,0,0,.35)';
      document.body.append(el);
    }
    el.textContent = text;
    el.style.display = 'block';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.display = 'none'; }, ms);
  }

  function bar() {
    let el = document.querySelector('.vcpe-bar');
    if (el) return el;
    el = document.createElement('div');
    el.className = 'vcpe-bar';
    el.innerHTML = `
      <span class="vcpe-title"></span>
      <span class="vcpe-status"></span>
      <input type="text" class="vcpe-summary" placeholder="编辑摘要">
      <label><input type="checkbox" class="vcpe-minor"> 小编辑</label>
      <button class="vcpe-save">保存更改</button>
      <button class="vcpe-cancel">取消</button>
    `;
    document.body.append(el);
    el.querySelector('.vcpe-save').addEventListener('click', submit);
    el.querySelector('.vcpe-cancel').addEventListener('click', cancel);
    return el;
  }

  function setBusy(busy) {
    const el = document.querySelector('.vcpe-bar');
    if (!el) return;
    el.querySelector('.vcpe-save').disabled = busy || !!session?.remoteDirty;
    el.querySelector('.vcpe-cancel').disabled = busy;
  }

  function refreshBar() {
    const el = document.querySelector('.vcpe-bar');
    if (!el || !session) return;
    el.querySelector('.vcpe-save').disabled = !!session.remoteDirty;
    if (session.remoteDirty) {
      el.querySelector('.vcpe-status').textContent =
        'VSCode 里有未保存修改，先保存文件（Ctrl+S）';
    }
  }

  // ---------- 编辑会话 ----------
  let previewTimer = null;
  let previewSeq = 0;

  function schedulePreview() {
    const el = document.querySelector('.vcpe-bar .vcpe-status');
    if (el) el.textContent = '预览更新中…';
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 250);
  }

  async function startEdit(section) {
    if (session) return;
    if (!connected) {
      pendingEdit = { section: section == null ? null : Number(section) };
      launchEditor();
      setTimeout(() => {
        if (!connected && pendingEdit) {
          notify('仍未检测到 VSCode 扩展，确认已安装 vcpedia-vscode-editor。', 6000);
        }
      }, 15000);
      return;
    }
    const title = mw.config.get('wgPageName');
    if (!title) return;
    const params = {
      action: 'query',
      prop: 'revisions',
      rvprop: 'content|ids|timestamp',
      rvslots: 'main',
      titles: title,
    };
    if (section != null) params.rvsection = section;
    const data = await apiGet(params);
    const page = data?.query?.pages?.[0];
    const rev = page?.revisions?.[0];
    const slot = rev?.slots?.main;
    if (!rev || !slot || slot.content == null) {
      notify('无法获取页面源码：' + (slot?.nosuchsection ? '该章节不存在' : '未知错误'));
      return;
    }
    const id = `s${Date.now()}`;
    session = {
      id,
      title,
      section: section == null ? null : Number(section),
      text: slot.content,
      base: rev.timestamp,
      start: new Date().toISOString(),
      patch: null,
      fullOriginal: null,
      changed: false,
      remoteDirty: false,
    };
    injectStyle();
    const b = bar();
    b.querySelector('.vcpe-title').textContent =
      section == null ? title : `${title} § ${section}`;
    b.querySelector('.vcpe-status').textContent = '已发送到 VSCode，等待编辑…';
    b.querySelector('.vcpe-summary').value = '';
    b.querySelector('.vcpe-minor').checked = false;
    document.body.classList.add('vcpe-editing');
    send({
      type: 'open',
      sessionId: id,
      title,
      section: session.section,
      text: session.text,
      revid: rev.revid,
      basetimestamp: rev.timestamp,
      starttimestamp: session.start,
    });
    renderPreview();
  }

  function sectionNodes(heading) {
    const level = Number(heading.tagName.slice(1));
    const parent = heading.parentNode;
    const nodes = [];
    let node = heading;
    while (node && node.parentNode === parent) {
      nodes.push(node);
      node = node.nextElementSibling;
      if (node && /^H[1-6]$/.test(node.tagName) && Number(node.tagName.slice(1)) <= level) break;
    }
    return nodes;
  }

  function findSectionHeading(root, section, parsedHeading) {
    // 1. by the section number in the existing edit links
    for (const a of root.querySelectorAll('.mw-editsection a[href*="action=edit"]')) {
      const s = new URL(a.href, location.href).searchParams.get('section');
      if (s === String(section)) return a.closest('h1,h2,h3,h4,h5,h6');
    }
    // 2. by the headline anchor id returned by the parser
    const id =
      parsedHeading?.id || parsedHeading?.querySelector('.mw-headline')?.id;
    if (id) {
      for (const h of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
        if (h.id === id || h.querySelector('.mw-headline')?.id === id) return h;
      }
    }
    return null;
  }

  function revertPatch() {
    const patch = session && session.patch;
    if (!patch) return;
    for (const n of patch.inserted) n.remove();
    const ref = patch.parent.contains(patch.next) ? patch.next : null;
    for (const n of patch.oldNodes) patch.parent.insertBefore(n, ref);
    session.patch = null;
  }

  function applySection(parsedHtml, section) {
    const root = document.querySelector('#mw-content-text');
    const temp = document.createElement('div');
    temp.innerHTML = parsedHtml;
    const newRoot = temp.firstElementChild;
    if (!newRoot) return false;
    const newHeading = newRoot.querySelector('h1,h2,h3,h4,h5,h6');
    if (!newHeading) return false;
    revertPatch();
    const anchor = findSectionHeading(root, section, newHeading);
    if (!anchor) return false;
    const newNodes = sectionNodes(newHeading);
    const oldNodes = sectionNodes(anchor);
    if (!newNodes.length || !oldNodes.length) return false;
    const parent = anchor.parentNode;
    const next = oldNodes[oldNodes.length - 1].nextSibling;
    for (const n of oldNodes) n.remove();
    const inserted = [];
    try {
      for (const n of newNodes) {
        parent.insertBefore(n, next);
        inserted.push(n);
      }
    } catch (e) {
      for (const n of inserted) n.remove();
      for (const n of oldNodes) parent.insertBefore(n, next);
      throw e;
    }
    for (const n of inserted) executeScripts(n);
    session.patch = { parent, next, oldNodes, inserted };
    return true;
  }

  function executeScripts(root) {
    if (!root) return;
    root.querySelectorAll?.('script').forEach((old) => {
      if (old.dataset.vcpeExecuted) return;
      const script = document.createElement('script');
      for (const attr of old.attributes) script.setAttribute(attr.name, attr.value);
      script.textContent = old.textContent;
      script.dataset.vcpeExecuted = '1';
      old.replaceWith(script);
    });
  }

  function applyFull(html) {
    const root = document.querySelector('#mw-content-text');
    if (!session.fullOriginal) session.fullOriginal = [...root.childNodes];
    const temp = document.createElement('div');
    temp.innerHTML = html;
    root.replaceChildren(...temp.childNodes);
    executeScripts(root);
    if (window.mw?.hook && typeof jQuery === 'function') mw.hook('wikipage.content').fire(jQuery(root));
  }

  async function renderPreview() {
    if (!session) return;
    const seq = ++previewSeq;
    const text = session.text;
    const params = {
      action: 'parse',
      contentmodel: 'wikitext',
      title: session.title,
      text,
      pst: '1',
      preview: '1',
      disableeditsection: '1',
      disablelimitreport: '1',
      prop: 'text|displaytitle|parsewarnings',
    };
    if (session.section != null) params.section = String(session.section);
    let data;
    try {
      data = await apiPost(params);
    } catch (e) {
      if (seq === previewSeq) bar().querySelector('.vcpe-status').textContent = '预览失败：' + e.message;
      return;
    }
    if (seq !== previewSeq) return;
    if (data.error) {
      bar().querySelector('.vcpe-status').textContent = '预览失败：' + data.error.info;
      return;
    }
    const html = data.parse.text;
    if (session.section == null) {
      applyFull(html);
    } else if (!applySection(html, session.section)) {
      bar().querySelector('.vcpe-status').textContent =
        '无法在页面中定位该章节，未应用预览（页面保持原样）';
      return;
    }
    buildTemplateMap();
    const st = bar().querySelector('.vcpe-status');
    st.textContent = `预览已更新 ${new Date().toLocaleTimeString()}`;
    addSectionButtons();
  }

  async function submit() {
    if (!session) return;
    if (session.remoteDirty) {
      notify('VSCode 里有未保存修改，先保存文件（Ctrl+S）再提交。');
      return;
    }
    const b = bar();
    const summary = b.querySelector('.vcpe-summary').value.trim();
    const minor = b.querySelector('.vcpe-minor').checked;
    setBusy(true);
    b.querySelector('.vcpe-status').textContent = '提交中…';
    try {
      const tok = await apiGet({ action: 'query', meta: 'tokens', type: 'csrf' });
      const token = tok?.query?.tokens?.csrftoken;
      if (!token) throw new Error('无法获取 CSRF token');
      const params = {
        action: 'edit',
        title: session.title,
        text: session.text,
        summary,
        minor: minor ? '1' : undefined,
        token,
        basetimestamp: session.base,
        starttimestamp: session.start,
        watchlist: 'nochange',
      };
      if (session.section != null) params.section = String(session.section);
      const r = await apiPost(params);
      if (r.error) {
        if (r.error.code === 'editconflict') {
          b.querySelector('.vcpe-status').textContent =
            '保存冲突：页面在你编辑期间被修改，请取消后重新编辑。';
          setBusy(false);
          return;
        }
        throw new Error(r.error.info || r.error.code);
      }
      send({ type: 'finish', sessionId: session.id, result: 'saved', summary, minor });
      session = null;
      document.body.classList.remove('vcpe-editing');
      b.remove();
      location.reload();
    } catch (e) {
      b.querySelector('.vcpe-status').textContent = '提交失败：' + e.message;
      setBusy(false);
    }
  }

  function cancel() {
    if (!session) return;
    const pending = session.remoteDirty || session.changed;
    if (
      pending &&
      !confirm(
        session.remoteDirty
          ? 'VSCode 里还有未保存的修改，放弃并关闭编辑器？'
          : '还有未提交到站点的修改，确定放弃？'
      )
    ) {
      return;
    }
    send({
      type: 'finish',
      sessionId: session.id,
      result: pending ? 'discarded' : 'unchanged',
    });
    if (session.patch) revertPatch();
    if (session.fullOriginal) {
      const root = document.querySelector('#mw-content-text');
      root.replaceChildren(...session.fullOriginal);
      session.fullOriginal = null;
      if (window.mw?.hook && typeof jQuery === 'function') {
        mw.hook('wikipage.content').fire(jQuery(root));
      }
    }
    session = null;
    document.body.classList.remove('vcpe-editing');
    document.querySelector('.vcpe-bar')?.remove();
  }

  // ---------- 启动 ----------
  function isArticleLink(a) {
    if (a.classList.contains('vcpe-sec')) return false;
    if (a.closest('.mw-editsection')) return false;
    if (a.classList.contains('new') || a.classList.contains('external')) return false;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return false;
    const q = url.searchParams;
    if (q.get('action') || q.get('oldid') || q.get('diff') || q.get('redlink')) return false;
    if (url.pathname.includes('/Special:') || url.pathname.includes('特殊:')) return false;
    if (url.pathname === location.pathname && url.hash) return false;
    return true;
  }

  function normTemplate(name) {
    return String(name || '')
      .trim()
      .replace(/^Template:/i, '')
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  let templateMap = new Map();

  function templateNameOf(el) {
    try {
      const mw = JSON.parse(el.getAttribute('data-mw') || '{}');
      const parts = Array.isArray(mw.parts) ? mw.parts : [];
      for (const part of parts) {
        const target = part?.template?.target;
        if (!target) continue;
        let raw = target.href ? target.href.replace(/^\.\/Template:/i, '') : target.wt;
        try {
          raw = decodeURIComponent(raw);
        } catch {}
        const name = normTemplate(raw);
        if (name) return name;
      }
    } catch {}
    return null;
  }

  function containerFor(el, root) {
    const section = el.closest('section');
    if (section && section.getBoundingClientRect().height > 40) return section;
    let node = el.parentElement;
    while (node && node !== root) {
      if (node.getBoundingClientRect().height > 40) return node;
      node = node.parentElement;
    }
    return el;
  }

  function buildTemplateMap() {
    templateMap = new Map();
    const root = document.querySelector('#mw-content-text');
    if (!root) return;
    root.querySelectorAll('[data-mw]').forEach((el) => {
      const name = templateNameOf(el);
      if (!name || templateMap.has(name)) return;
      const container = containerFor(el, root);
      templateMap.set(name, container);
      container.setAttribute('data-vcpe-template', name);
    });
  }

  function findTextElement(root, text) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('script,style')) continue;
      if (node.nodeValue && node.nodeValue.includes(text)) {
        return node.parentElement;
      }
    }
    return null;
  }

  function scrollToText(texts) {
    if (!Array.isArray(texts) || !texts.length) return false;
    const root = document.querySelector('#mw-content-text');
    if (!root) return false;
    for (const text of texts) {
      const el = findTextElement(root, text);
      if (!el) continue;
      el.scrollIntoView({ block: 'center' });
      el.classList.add('vcpe-hit');
      setTimeout(() => el.classList.remove('vcpe-hit'), 1600);
      return true;
    }
    return false;
  }

  function previewHeadings() {
    const root = document.querySelector('#mw-content-text');
    if (!root) return [];
    return [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(
      (h) => h.id || h.querySelector('.mw-headline, span[id]')
    );
  }

  function locateFromPoint(clientY) {
    const heads = previewHeadings();
    let index = -1;
    for (let i = 0; i < heads.length; i++) {
      if (heads[i].getBoundingClientRect().top <= clientY) index = i;
      else break;
    }
    const root = document.querySelector('#mw-content-text');
    const rect = root.getBoundingClientRect();
    const base = index >= 0 ? heads[index].getBoundingClientRect().top : rect.top;
    const next =
      index + 1 < heads.length ? heads[index + 1].getBoundingClientRect().top : rect.bottom;
    const span = Math.max(1, next - base);
    const ratio = Math.max(0, Math.min(1, (clientY - base) / span));
    return { heading: index, ratio };
  }

  function scrollToPosition(heading, ratio, center) {
    const heads = previewHeadings();
    const root = document.querySelector('#mw-content-text');
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const index = Math.min(heading ?? -1, heads.length - 1);
    const base =
      index >= 0
        ? heads[index].getBoundingClientRect().top + window.scrollY
        : rect.top + window.scrollY;
    const next =
      index + 1 < heads.length
        ? heads[index + 1].getBoundingClientRect().top + window.scrollY
        : rect.bottom + window.scrollY;
    const span = Math.max(1, next - base);
    const target = base + (ratio || 0) * span;
    const offset = center ? window.innerHeight * 0.25 : 80;
    window.scrollTo({ top: Math.max(0, target - offset), behavior: 'auto' });
  }

  function boot() {
    if (mw.config.get('wgAction') !== 'view') return;
    injectStyle();
    ensureFab();
    addSectionButtons();
    connect();

    document.addEventListener('keydown', (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        startEdit(null);
      }
    });

    // 编辑中的预览里点内链：新标签打开目标页并直接进入编辑预览
    document.addEventListener(
      'click',
      (e) => {
        if (!session) return;
        if (!e.target.closest('#mw-content-text')) return;
        const a = e.target.closest('a');
        if (a) {
          if (!isArticleLink(a)) return;
          e.preventDefault();
          const url = new URL(a.href, location.href);
          url.searchParams.set('vcpe-edit', '1');
          window.open(url.toString(), '_blank', 'noopener');
          return;
        }
        const tplEl = e.target.closest('[data-vcpe-template]');
        const mwEl = e.target.closest('[data-mw]');
        const template = tplEl
          ? tplEl.getAttribute('data-vcpe-template')
          : mwEl
            ? templateNameOf(mwEl)
            : null;
        if (template) {
          send({ type: 'locate', sessionId: session.id, template });
          return;
        }
        const { heading, ratio } = locateFromPoint(e.clientY);
        send({ type: 'locate', sessionId: session.id, heading, ratio });
      },
      true
    );

    // 有未保存/未提交内容时，阻止直接关闭标签
    window.addEventListener('beforeunload', (e) => {
      if (!session) return;
      if (session.remoteDirty || session.changed) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // 关闭/刷新标签：无改动才算确认，有改动只通知断开（文件保留）
    window.addEventListener('pagehide', () => {
      if (!session) return;
      const clean = !session.changed && !session.remoteDirty;
      send({
        type: 'finish',
        sessionId: session.id,
        result: clean ? 'unchanged' : 'closed',
      });
    });

    // 由链接跳转打开的新标签，自动进入编辑预览
    if (new URLSearchParams(location.search).get('vcpe-edit') === '1') {
      const u = new URL(location.href);
      u.searchParams.delete('vcpe-edit');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
      setTimeout(() => startEdit(null), 100);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
