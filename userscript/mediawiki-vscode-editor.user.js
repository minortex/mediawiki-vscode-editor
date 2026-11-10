// ==UserScript==
// @name         MediaWiki ⇄ VSCode 外部编辑器
// @namespace    mediawiki-vscode-editor
// @version      0.6.0
// @description  在 MediaWiki 站点发起编辑，用 VSCode 改，保存即预览，浏览器内提交
// @match        *://*/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  if (!window.mw || !mw.config || !mw.config.get('wgPageName')) return;

  console.info('[mediawiki-vscode] userscript 0.6.0 loaded');

  const WS_URL = 'ws://127.0.0.1:8927';
  const RECONNECT_MS = 1000;

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

  async function ensureWikiRegistered() {
    if (registeredWiki) return registeredWiki;
    if (registeringWiki) return registeringWiki;
    registeringWiki = (async () => {
      const data = await apiGet({
        action: 'query',
        meta: 'siteinfo',
        siprop: 'general|namespaces|namespacealiases|magicwords|functionhooks|extensiontags|variables|interwikimap',
      });
      if (!data?.query?.general) throw new Error('站点没有返回 siteinfo');
      const requestId = `reg-${Date.now()}-${++registerSeq}`;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          registerWaiters.delete(requestId);
          reject(new Error('扩展未响应站点注册'));
        }, 15000);
        registerWaiters.set(requestId, {resolve, reject, timer});
        if (!send({
          type: 'register-wiki',
          requestId,
          origin: location.origin,
          api: apiUrl,
          name: mw.config.get('wgSiteName') || location.host,
          siteinfo: data.query,
        })) {
          clearTimeout(timer);
          registerWaiters.delete(requestId);
          reject(new Error('扩展未连接'));
        }
      });
      await response;
      registeredWiki = data.query;
      registeringWiki = null;
      return data.query;
    })().catch((error) => {
      registeringWiki = null;
      throw error;
    });
    return registeringWiki;
  }

  // ---------- 连接 VSCode 扩展 ----------
  let socket = null;
  let connected = false;
  let session = null;
  let pendingEdit = null;
  let registeredWiki = null;
  let registeringWiki = null;
  let registerSeq = 0;
  const registerWaiters = new Map();

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
      ensureWikiRegistered().catch((error) => {
        notify(`站点注册失败：${error.message}`, 6000);
      });
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
      if (msg.type === 'wiki-registered') {
        const waiter = registerWaiters.get(msg.requestId);
        if (waiter) {
          clearTimeout(waiter.timer);
          registerWaiters.delete(msg.requestId);
          if (msg.ok) waiter.resolve();
          else waiter.reject(new Error(msg.error || '站点注册失败'));
        }
        return;
      }
      if (!session || msg.sessionId !== session.id) return;
      if (msg.type === 'update') {
        session.text = msg.text;
        session.changed = true;
        schedulePreview();
      } else if (msg.type === 'state') {
        session.remoteDirty = !!msg.dirty;
        refreshBar();
      } else if (msg.type === 'scroll') {
        scrollToOccurrence(
          msg.text,
          msg.occurrence,
          msg.scope,
          msg.label,
          msg.prev,
          msg.next,
          msg.labelOccurrence
        );
      }
    });
  }

  function send(msg) {
    if (!connected || !socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(msg));
    return true;
  }

  // ---------- 界面 ----------
  const css = `
    .mwe-fab{position:fixed;right:20px;bottom:24px;z-index:2147483000;display:flex;gap:8px;align-items:center;
      background:#3366cc;color:#fff;border:none;border-radius:999px;padding:10px 16px;font-size:14px;font-weight:600;
      box-shadow:0 2px 10px rgba(0,0,0,.3);cursor:pointer}
    .mwe-fab:hover{background:#2a56a8}
    .mwe-fab.offline{background:#72777d}
    .mwe-sec{margin-left:6px;padding:0 6px;border:1px solid #a2a9b1;border-radius:3px;font-size:12px;
      text-decoration:none;background:#f8f9fa;color:#3366cc}
    .mwe-sec:hover{background:#eaf3ff}
    .mwe-bar{position:fixed;left:0;right:0;bottom:0;z-index:2147483001;display:flex;gap:10px;align-items:center;
      flex-wrap:wrap;background:#fff;border-top:2px solid #3366cc;padding:10px 16px;
      box-shadow:0 -2px 12px rgba(0,0,0,.15);font-size:14px;color:#202122}
    .mwe-bar .mwe-title{font-weight:700;margin-right:4px}
    .mwe-bar .mwe-status{color:#72777d}
    .mwe-bar input[type=text]{flex:1 1 260px;min-width:180px;padding:6px 10px;border:1px solid #a2a9b1;border-radius:4px}
    .mwe-bar button{padding:6px 14px;border-radius:4px;border:1px solid #a2a9b1;background:#f8f9fa;cursor:pointer}
    .mwe-bar button.mwe-save{background:#3366cc;border-color:#3366cc;color:#fff;font-weight:600}
    .mwe-bar button:disabled{opacity:.5;cursor:not-allowed}
    .mwe-bar label{display:flex;align-items:center;gap:4px;white-space:nowrap}
    body.mwe-editing{padding-bottom:80px}
  `;

  function injectStyle() {
    if (document.getElementById('mwe-style')) return;
    const s = document.createElement('style');
    s.id = 'mwe-style';
    s.textContent = css;
    document.head.append(s);
  }

  function ensureFab() {
    if (document.getElementById('mwe-fab')) return;
    const btn = document.createElement('button');
    btn.id = 'mwe-fab';
    btn.className = 'mwe-fab';
    btn.textContent = 'VSCode 编辑';
    btn.addEventListener('click', () => startEdit(null));
    document.body.append(btn);
    refreshStatus();
  }

  function refreshStatus() {
    const fab = document.getElementById('mwe-fab');
    if (fab) {
      fab.classList.remove('offline');
      fab.textContent = connected ? 'VSCode 编辑' : '启动 VSCode';
      fab.title = connected ? 'VSCode 扩展已连接' : '点击启动 VSCode 并开始编辑';
    }
    const st = document.querySelector('.mwe-status');
    if (st) st.textContent = connected ? '已连接 VSCode' : 'VSCode 扩展未连接，等待重连…';
  }

  function addSectionButtons() {
    const content = document.querySelector('#mw-content-text .mw-parser-output');
    if (!content) return;
    content.querySelectorAll('.mw-editsection a[href*="action=edit"]').forEach((a) => {
      if (a.parentElement.querySelector('.mwe-sec')) return;
      const section = new URL(a.href, location.href).searchParams.get('section');
      if (section == null) return;
      const link = document.createElement('a');
      link.className = 'mwe-sec';
      link.href = '#';
      link.textContent = 'VSCode';
      link.title = '用 VSCode 编辑本节';
      link.addEventListener('click', (e) => { e.preventDefault(); startEdit(section); });
      a.after(link);
    });
  }

  function notify(text, ms = 3200) {
    let el = document.getElementById('mwe-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mwe-toast';
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
    let el = document.querySelector('.mwe-bar');
    if (el) return el;
    el = document.createElement('div');
    el.className = 'mwe-bar';
    el.innerHTML = `
      <span class="mwe-title"></span>
      <span class="mwe-status"></span>
      <input type="text" class="mwe-summary" placeholder="编辑摘要">
      <label><input type="checkbox" class="mwe-minor"> 小编辑</label>
      <button class="mwe-save">保存更改</button>
      <button class="mwe-cancel">取消</button>
    `;
    document.body.append(el);
    el.querySelector('.mwe-save').addEventListener('click', submit);
    el.querySelector('.mwe-cancel').addEventListener('click', cancel);
    return el;
  }

  function setBusy(busy) {
    const el = document.querySelector('.mwe-bar');
    if (!el) return;
    el.querySelector('.mwe-save').disabled = busy || !!session?.remoteDirty;
    el.querySelector('.mwe-cancel').disabled = busy;
  }

  function refreshBar() {
    const el = document.querySelector('.mwe-bar');
    if (!el || !session) return;
    el.querySelector('.mwe-save').disabled = !!session.remoteDirty;
    if (session.remoteDirty) {
      el.querySelector('.mwe-status').textContent =
        'VSCode 里有未保存修改，先保存文件（Ctrl+S）';
    }
  }

  // ---------- 编辑会话 ----------
  let previewTimer = null;
  let previewSeq = 0;

  function schedulePreview() {
    const el = document.querySelector('.mwe-bar .mwe-status');
    if (el) el.textContent = '预览更新中…';
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 250);
  }

  async function startEdit(section) {
    if (session) return;
    if (!connected) {
      pendingEdit = { section: section == null ? null : Number(section) };
      notify('VSCode 扩展未连接。请手动打开 VSCode，并确认已安装/启用 mediawiki-vscode-editor 扩展。', 8000);
      return;
    }
    try {
      await ensureWikiRegistered();
    } catch (error) {
      notify(`站点注册失败：${error.message}`, 6000);
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
    b.querySelector('.mwe-title').textContent =
      section == null ? title : `${title} § ${section}`;
    b.querySelector('.mwe-status').textContent = '已发送到 VSCode，等待编辑…';
    b.querySelector('.mwe-summary').value = '';
    b.querySelector('.mwe-minor').checked = false;
    document.body.classList.add('mwe-editing');
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
      if (old.dataset.mweExecuted) return;
      const script = document.createElement('script');
      for (const attr of old.attributes) script.setAttribute(attr.name, attr.value);
      script.textContent = old.textContent;
      script.dataset.mweExecuted = '1';
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
      if (seq === previewSeq) bar().querySelector('.mwe-status').textContent = '预览失败：' + e.message;
      return;
    }
    if (seq !== previewSeq) return;
    if (data.error) {
      bar().querySelector('.mwe-status').textContent = '预览失败：' + data.error.info;
      return;
    }
    const html = data.parse.text;
    if (session.section == null) {
      applyFull(html);
    } else if (!applySection(html, session.section)) {
      bar().querySelector('.mwe-status').textContent =
        '无法在页面中定位该章节，未应用预览（页面保持原样）';
      return;
    }
    const st = bar().querySelector('.mwe-status');
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
    const summary = b.querySelector('.mwe-summary').value.trim();
    const minor = b.querySelector('.mwe-minor').checked;
    setBusy(true);
    b.querySelector('.mwe-status').textContent = '提交中…';
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
          b.querySelector('.mwe-status').textContent =
            '保存冲突：页面在你编辑期间被修改，请取消后重新编辑。';
          setBusy(false);
          return;
        }
        throw new Error(r.error.info || r.error.code);
      }
      send({ type: 'finish', sessionId: session.id, result: 'saved', summary, minor });
      session = null;
      document.body.classList.remove('mwe-editing');
      b.remove();
      location.reload();
    } catch (e) {
      b.querySelector('.mwe-status').textContent = '提交失败：' + e.message;
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
    document.body.classList.remove('mwe-editing');
    document.querySelector('.mwe-bar')?.remove();
  }

  // ---------- 启动 ----------
  function isArticleLink(a) {
    if (a.classList.contains('mwe-sec')) return false;
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

  function drawBox(rect) {
    if (!rect || (!rect.width && !rect.height)) return false;
    const top = rect.top + window.scrollY;
    const left = rect.left + window.scrollX;
    window.scrollTo({
      top: Math.max(0, top - window.innerHeight / 2 + rect.height / 2),
      behavior: 'auto',
    });
    const box = document.createElement('div');
    box.style.cssText =
      `position:absolute;left:${left}px;top:${top}px;width:${rect.width}px;height:${rect.height}px;` +
      'pointer-events:none;z-index:2147482999;outline:2px solid #3366cc;' +
      'background:rgba(51,102,204,.15);border-radius:2px;';
    document.body.append(box);
    setTimeout(() => box.remove(), 1600);
    return true;
  }

  function revealHidden(el) {
    let node = el;
    while (node && node !== document.body) {
      const style = window.getComputedStyle(node);
      if (style.display === 'none') {
        const toggle = node.querySelector('.mw-collapsible-toggle a');
        if (toggle) {
          toggle.click();
          return true;
        }
        node.style.display = '';
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function buildTextContext(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let raw = '';
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest('script,style,.vc-preview')) continue;
      const start = raw.length;
      raw += node.nodeValue;
      nodes.push({ node, start, end: raw.length });
    }
    // Map whitespace-normalized text back to raw offsets, so full-width spaces
    // in <poem> lines still match the normalized text sent from VSCode.
    let norm = '';
    const map = [];
    let space = false;
    for (let i = 0; i < raw.length; i++) {
      if (/\s/.test(raw[i])) {
        if (!space) {
          norm += ' ';
          map.push(i);
          space = true;
        }
      } else {
        norm += raw[i];
        map.push(i);
        space = false;
      }
    }
    return { nodes, norm, map };
  }

  function findRangeIn(ctx, needle, occurrence) {
    const text = String(needle || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return null;
    let index = -1;
    let seen = 0;
    while ((index = ctx.norm.indexOf(text, index + 1)) >= 0) {
      seen++;
      if (seen < occurrence) continue;
      const rawStart = ctx.map[index];
      const rawEnd = (ctx.map[Math.min(index + text.length - 1, ctx.map.length - 1)] || rawStart) + 1;
      const head = ctx.nodes.find((n) => rawStart >= n.start && rawStart < n.end);
      const tail = ctx.nodes.find((n) => rawEnd <= n.end && rawEnd > n.start);
      if (!head || !tail) continue;
      const range = document.createRange();
      range.setStart(head.node, rawStart - head.start);
      range.setEnd(tail.node, rawEnd - tail.start);
      return range;
    }
    return null;
  }

  function scrollToOccurrence(text, occurrence, scope, label, prev, next, labelOccurrence) {
    if (!text) return false;
    const all = document.querySelector('#mw-content-text');
    if (!all) return false;
    let root = all;
    if (scope && scope.type === 'poem') {
      root = all.querySelectorAll('.poem')[scope.index];
      if (!root) return false;
    }
    const wanted = Math.max(1, Number(occurrence) || 1);
    const candidates = [];
    const push = (value, occ) => {
      const needle = String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (needle.length < 2) return;
      if (candidates.some((c) => c.needle === needle)) return;
      candidates.push({ needle, occurrence: occ });
    };
    if (scope) {
      // The container-scoped occurrence is already exact.
      push(text, wanted);
    } else {
      if (label) {
        push(label + ' ' + text, labelOccurrence || 1);
        push(label + text, labelOccurrence || 1);
      }
      if (next) {
        push(text + ' ' + next, 1);
        push(text + next, 1);
      }
      if (prev) {
        push(prev + ' ' + text, 1);
        push(prev + text, 1);
      }
      push(text, wanted);
    }
    const ctx = buildTextContext(root);
    for (const candidate of candidates) {
      const range = findRangeIn(ctx, candidate.needle, candidate.occurrence);
      if (!range) continue;
      const rect = range.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) {
        if (drawBox(rect)) return true;
        continue;
      }
      const el = range.startContainer?.parentElement;
      if (el && revealHidden(el)) {
        const retry = () => {
          const again = findRangeIn(ctx, candidate.needle, candidate.occurrence);
          if (again) drawBox(again.getBoundingClientRect());
        };
        setTimeout(retry, 150);
        return true;
      }
    }
    return false;
  }

  function textAtPoint(x, y) {
    let range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    }
    if (!range || !range.startContainer || range.startContainer.nodeType !== Node.TEXT_NODE) {
      return null;
    }
    const value = range.startContainer.nodeValue || '';
    const index = range.startOffset || 0;
    const s = value
      .slice(Math.max(0, index - 40), Math.min(value.length, index + 40))
      .replace(/\s+/g, ' ')
      .trim();
    return s.length >= 2 ? s : null;
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
          url.searchParams.set('external-editor', '1');
          window.open(url.toString(), '_blank', 'noopener');
          return;
        }
        const text = textAtPoint(e.clientX, e.clientY);
        if (text) send({ type: 'locate', sessionId: session.id, text });
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
    if (new URLSearchParams(location.search).get('external-editor') === '1') {
      const u = new URL(location.href);
      u.searchParams.delete('external-editor');
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
