/* InPageEdit NEXT plugin: edit pages in VSCode.
 * Load from your personal JS (after InPageEdit loads), or inject its contents.
 */
(function () {
  'use strict';
  if (window.__mweIpeRegistered) return;
  window.__mweIpeRegistered = true;

  var WS_URL = 'ws://127.0.0.1:8927';
  var RECONNECT_MS = 5000;
  var API = window.mw && mw.util && mw.util.wikiScript
    ? mw.util.wikiScript('api')
    : new URL('/api.php', location.origin).href;

  var socket = null;
  var connected = false;
  var registered = false;
  var session = null;
  var previewTimer = null;
  var previewSeq = 0;

  // ---------- hide the native quick-edit modal before it paints ----------
  function ensureGuardStyle() {
    if (document.getElementById('mwe-ipe-guard-style')) return;
    var style = document.createElement('style');
    style.id = 'mwe-ipe-guard-style';
    style.textContent = [
      '.ipe-modal-modal__window.ipe-quickEdit{display:none!important;}',
      '.ipe-modal-backdrop:has(+ .ipe-modal-modal .ipe-quickEdit){display:none!important;}',
    ].join('\n');
    document.head.append(style);
  }

  // ---------- bottom bar ----------
  var barStyleId = 'mwe-ipe-bar-style';

  function ensureBarStyle() {
    if (document.getElementById(barStyleId)) return;
    var style = document.createElement('style');
    style.id = barStyleId;
    style.textContent = [
      '.mwe-ipe-bar{position:fixed;left:0;right:0;bottom:0;z-index:2147483001;display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#fff;border-top:2px solid #3366cc;padding:10px 16px;box-shadow:0 -2px 12px rgba(0,0,0,.15);font-size:14px;color:#202122;}',
      '.mwe-ipe-bar .mwe-ipe-status{flex:1 1 180px;color:#72777d;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.mwe-ipe-bar .mwe-ipe-status.error{color:#d33;}',
      '.mwe-ipe-bar .mwe-ipe-status.ok{color:#14866d;}',
      '.mwe-ipe-bar input[type=text]{flex:1 1 220px;min-width:160px;padding:6px 10px;border:1px solid #a2a9b1;border-radius:4px;font-size:14px;}',
      '.mwe-ipe-bar select{padding:6px 10px;border:1px solid #a2a9b1;border-radius:4px;background:#fff;font-size:14px;color:#202122;}',
      '.mwe-ipe-bar button{padding:6px 14px;border-radius:4px;border:1px solid #a2a9b1;background:#f8f9fa;cursor:pointer;font-size:14px;color:#202122;}',
      '.mwe-ipe-bar button:hover{background:#eaecf0;}',
      '.mwe-ipe-bar button.is-primary{background:#3366cc;border-color:#3366cc;color:#fff;font-weight:600;}',
      '.mwe-ipe-bar button.is-primary:hover{background:#2a56a8;}',
      '.mwe-ipe-bar .mwe-ipe-link{color:#3366cc;font-size:13px;text-decoration:none;cursor:pointer;white-space:nowrap;}',
      '.mwe-ipe-bar .mwe-ipe-link:hover{text-decoration:underline;}',
      '.mwe-ipe-bar label{display:flex;align-items:center;gap:4px;white-space:nowrap;}',
      'body.mwe-ipe-editing{padding-bottom:96px;}',
    ].join('\n');
    document.head.append(style);
  }

  function refreshBar() {
    var bar = document.querySelector('.mwe-ipe-bar');
    if (!bar || !session) return;
    var submit = bar.querySelector('.mwe-ipe-submit');
    if (submit) submit.disabled = !!session.remoteDirty || !!session.busy;
    if (session.remoteDirty) {
      setStatus('VSCode 里有未保存修改，先保存文件（Ctrl+S）');
    }
  }

  function setBusy(busy) {
    if (session) session.busy = !!busy;
    var bar = document.querySelector('.mwe-ipe-bar');
    if (!bar) return;
    bar.querySelectorAll('button').forEach(function (b) { b.disabled = !!busy; });
    if (busy) setStatus('提交中…');
  }

  function setStatus(text, kind) {
    var el = document.querySelector('.mwe-ipe-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'mwe-ipe-status' + (kind ? ' ' + kind : '');
  }

  function ensureBar() {
    ensureBarStyle();
    var bar = document.querySelector('.mwe-ipe-bar');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'mwe-ipe-bar';
    bar.innerHTML =
      '<span class="mwe-ipe-status">VSCode 编辑中</span>' +
      '<input type="text" class="mwe-ipe-summary" placeholder="编辑摘要">' +
      '<select class="mwe-ipe-watchlist">' +
      '<option value="preferences">遵循 MW 首选</option>' +
      '<option value="nochange">保持当前状态</option>' +
      '<option value="watch">添加到监视列表</option>' +
      '<option value="unwatch">从监视列表移除</option>' +
      '</select>' +
      '<label><input type="checkbox" class="mwe-ipe-minor"> 小编辑</label>' +
      '<label><input type="checkbox" class="mwe-ipe-reload" checked> 保存后刷新</label>' +
      '<button class="mwe-ipe-submit is-primary">提交</button>' +
      '<button class="mwe-ipe-diff">差异</button>' +
      '<a class="mwe-ipe-link mwe-ipe-upload">快速上传</a>' +
      '<a class="mwe-ipe-link mwe-ipe-templates">使用的模板</a>' +
      '<a class="mwe-ipe-link mwe-ipe-images">使用的图片</a>' +
      '<button class="mwe-ipe-cancel">取消</button>';
    document.body.append(bar);
    document.body.classList.add('mwe-ipe-editing');
    bar.querySelector('.mwe-ipe-submit').addEventListener('click', function () {
      requestSave(bar);
    });
    bar.querySelector('.mwe-ipe-cancel').addEventListener('click', function () {
      cancelEdit();
    });
    bar.querySelector('.mwe-ipe-upload').addEventListener('click', function () {
      var qu = window.ipe && window.ipe.get && window.ipe.get('quickUpload');
      if (qu && qu.showModal) qu.showModal();
    });
    bar.querySelector('.mwe-ipe-templates').addEventListener('click', function () {
      if (!session) return;
      var tu = window.ipe && window.ipe.get && window.ipe.get('templatesUsed');
      if (tu && tu.showModal) tu.showModal({ title: session.title });
    });
    bar.querySelector('.mwe-ipe-images').addEventListener('click', function () {
      showImagesUsed();
    });
    bar.querySelector('.mwe-ipe-diff').addEventListener('click', function () {
      if (!session) return;
      var qd = window.ipe && window.ipe.get && window.ipe.get('quickDiff');
      if (!qd) return;
      var from = (session.wikiPage.revisions && session.wikiPage.revisions[0] && session.wikiPage.revisions[0].content) || '';
      if (from === session.text) return;
      qd.comparePages({
        fromtitle: session.title,
        fromtext: from,
        totitle: session.title,
        totext: session.text,
        topst: true,
      });
    });
    return bar;
  }

  function status(text) {
    setStatus(text);
  }

  // ---------- api ----------
  function apiPost(params) {
    return fetch(API, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(Object.assign({ format: 'json', formatversion: '2' }, params)),
    }).then(function (r) { return r.json(); });
  }

  // ---------- websocket ----------
  function fetchSiteInfo() {
    var params = {
      action: 'query',
      meta: 'siteinfo',
      siprop: 'general|namespaces|namespacealiases|magicwords|functionhooks|extensiontags|variables|interwikimap',
      format: 'json',
      formatversion: '2',
    };
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 20000) : null;
    return fetch(API + '?' + new URLSearchParams(params), {
      credentials: 'include',
      signal: controller ? controller.signal : undefined,
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data.error) throw new Error(data.error.code + ': ' + data.error.info);
        if (!data.query || !data.query.general) throw new Error('站点没有返回 siteinfo');
        return data.query;
      })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  function notifyOffline(message, title) {
    var text = message || 'VSCode 扩展未连接。请手动打开 VSCode，并确认已安装并启用 MediaWiki 扩展。';
    var modal = (ipeContext && ipeContext.modal)
      || (window.ipe && window.ipe.get && window.ipe.get('modal'));
    if (modal && typeof modal.notify === 'function') {
      modal.notify('warning', {
        title: title || 'VSCode 未连接',
        content: text,
        position: 'top right',
        closeAfter: {time: 8000, resetOnHover: true},
      });
      return;
    }
    var old = document.getElementById('mwe-offline-notice');
    if (old) old.remove();
    var box = document.createElement('div');
    box.id = 'mwe-offline-notice';
    box.style.cssText = 'position:fixed;top:20px;right:20px;z-index:2147483003;max-width:360px;background:#fff;color:#202122;border:1px solid #a2a9b1;border-left:4px solid #fc3;padding:12px 14px;border-radius:4px;font-size:13px;line-height:1.5;box-shadow:0 2px 12px rgba(0,0,0,.2);';
    box.textContent = text;
    document.body.append(box);
    setTimeout(function () { box.remove(); }, 8000);
  }

  var registeredWiki = null;
  var registeringWiki = null;
  var registerSeq = 0;
  var registerWaiters = {};
  var pendingStart = null;
  var ipeContext = null;
  var sessionQueryPromise = null;
  var sessionQuerySeq = 0;
  var sessionWaiters = {};

  function ensureWikiRegistered() {
    if (registeredWiki) return Promise.resolve(registeredWiki);
    if (registeringWiki) return registeringWiki;
    registeringWiki = fetchSiteInfo()
      .then(function (query) {
        var requestId = 'reg-' + Date.now() + '-' + (++registerSeq);
        return new Promise(function (resolve, reject) {
          var timer = setTimeout(function () {
            delete registerWaiters[requestId];
            reject(new Error('扩展未响应站点注册'));
          }, 15000);
          registerWaiters[requestId] = {resolve: resolve, reject: reject, timer: timer, query: query};
          send({
            type: 'register-wiki',
            requestId: requestId,
            origin: location.origin,
            api: API,
            name: (window.mw && mw.config && mw.config.get('wgSiteName')) || location.host,
            siteinfo: query,
          });
        });
      })
      .then(function (query) {
        registeredWiki = query;
        registeringWiki = null;
        return query;
      })
      .catch(function (error) {
        registeringWiki = null;
        throw error;
      });
    return registeringWiki;
  }

  function onWikiRegistered(msg) {
    var waiter = registerWaiters[msg.requestId];
    if (!waiter) return;
    clearTimeout(waiter.timer);
    delete registerWaiters[msg.requestId];
    if (msg.ok) waiter.resolve(waiter.query);
    else waiter.reject(new Error(msg.error || '站点注册失败'));
  }

  function connect() {
    if (socket && socket.readyState <= 1) return;
    socket = new WebSocket(WS_URL);
    socket.addEventListener('open', function () {
      connected = true;
      var notice = document.getElementById('mwe-offline-notice');
      if (notice) notice.remove();
      (async function () {
        try {
          await ensureWikiRegistered();
          var existing = await queryExistingSession();
          if (existing) {
            await adoptSession(existing);
            pendingStart = null;
            return;
          }
        } catch (e) {
          status('站点注册失败：' + ((e && e.message) || e), 'error');
        }
        if (pendingStart) {
          var pending = pendingStart;
          pendingStart = null;
          startEdit(pending).catch(function (e) {
            status('启动失败：' + ((e && e.message) || e), 'error');
          });
        }
      })();
    });
    socket.addEventListener('close', function () {
      connected = false;
      sessionQueryPromise = null;
      setTimeout(connect, RECONNECT_MS);
    });
    socket.addEventListener('error', function () { try { socket.close(); } catch (e) {} });
    socket.addEventListener('message', function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'wiki-registered') {
        onWikiRegistered(msg);
        return;
      }
      if (msg.type === 'session-result') {
        onSessionResult(msg);
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
        scrollToOccurrence(msg.text, msg.occurrence, msg.scope, msg.label, msg.prev, msg.next, msg.labelOccurrence);
      } else if (msg.type === 'save') {
        setStatus('正在提交…');
        saveEdit(msg.text, msg.summary, msg.minor);
      } else if (msg.type === 'finish') {
        if (msg.result === 'closed') restorePage();
        endSession();
      }
    });
  }

  function send(msg) {
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  // ---------- text context / locate ----------
  function drawBox(rect) {
    if (!rect || (!rect.width && !rect.height)) return false;
    var top = rect.top + window.scrollY;
    var left = rect.left + window.scrollX;
    window.scrollTo({
      top: Math.max(0, top - window.innerHeight / 2 + rect.height / 2),
      behavior: 'auto',
    });
    var box = document.createElement('div');
    box.style.cssText =
      'position:absolute;left:' + left + 'px;top:' + top + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px;' +
      'pointer-events:none;z-index:2147482999;outline:2px solid #3366cc;' +
      'background:rgba(51,102,204,.15);border-radius:2px;';
    document.body.append(box);
    setTimeout(function () { box.remove(); }, 1600);
    return true;
  }

  function revealHidden(el) {
    var node = el;
    while (node && node !== document.body) {
      var style = window.getComputedStyle(node);
      if (style.display === 'none') {
        var toggle = node.querySelector('.mw-collapsible-toggle a');
        if (toggle) { toggle.click(); return true; }
        node.style.display = '';
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function buildTextContext(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var nodes = [];
    var raw = '';
    var node;
    while ((node = walker.nextNode())) {
      if (node.parentElement && node.parentElement.closest('script,style,.vc-preview')) continue;
      var start = raw.length;
      raw += node.nodeValue;
      nodes.push({ node: node, start: start, end: raw.length });
    }
    var norm = '';
    var map = [];
    var space = false;
    for (var i = 0; i < raw.length; i++) {
      if (/\s/.test(raw[i])) {
        if (!space) { norm += ' '; map.push(i); space = true; }
      } else {
        norm += raw[i];
        map.push(i);
        space = false;
      }
    }
    return { nodes: nodes, norm: norm, map: map };
  }

  function findRangeIn(ctx, needle, occurrence) {
    var text = String(needle || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    var index = -1;
    var seen = 0;
    while ((index = ctx.norm.indexOf(text, index + 1)) >= 0) {
      seen++;
      if (seen < occurrence) continue;
      var rawStart = ctx.map[index];
      var rawEnd = (ctx.map[Math.min(index + text.length - 1, ctx.map.length - 1)] || rawStart) + 1;
      var head = ctx.nodes.find(function (n) { return rawStart >= n.start && rawStart < n.end; });
      var tail = ctx.nodes.find(function (n) { return rawEnd <= n.end && rawEnd > n.start; });
      if (!head || !tail) continue;
      var range = document.createRange();
      range.setStart(head.node, rawStart - head.start);
      range.setEnd(tail.node, rawEnd - tail.start);
      return range;
    }
    return null;
  }

  function scrollToOccurrence(text, occurrence, scope, label, prev, next, labelOccurrence) {
    if (!text) return false;
    var all = document.querySelector('#mw-content-text');
    if (!all) return false;
    var root = all;
    if (scope && scope.type === 'poem') {
      root = all.querySelectorAll('.poem')[scope.index];
      if (!root) return false;
    }
    var wanted = Math.max(1, Number(occurrence) || 1);
    var candidates = [];
    function push(value, occ) {
      var needle = String(value || '').replace(/\s+/g, ' ').trim();
      if (needle.length < 2) return;
      if (candidates.some(function (c) { return c.needle === needle; })) return;
      candidates.push({ needle: needle, occurrence: occ });
    }
    if (scope) {
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
    var ctx = buildTextContext(root);
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      var range = findRangeIn(ctx, candidate.needle, candidate.occurrence);
      if (!range) continue;
      var rect = range.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) {
        if (drawBox(rect)) return true;
        continue;
      }
      var el = range.startContainer && range.startContainer.parentElement;
      if (el && revealHidden(el)) {
        (function (needle, occ) {
          setTimeout(function () {
            var again = findRangeIn(ctx, needle, occ);
            if (again) drawBox(again.getBoundingClientRect());
          }, 150);
        })(candidate.needle, candidate.occurrence);
        return true;
      }
    }
    return false;
  }

  function editUrlFor(href) {
    try {
      var url = new URL(href, location.href);
      url.searchParams.set('external-editor', '1');
      return url.href;
    } catch (e) {
      return href;
    }
  }

  function consumeAutoEdit() {
    var url = new URL(location.href);
    if (url.searchParams.get('external-editor') !== '1') return null;
    var section = url.searchParams.get('external-editor-section');
    url.searchParams.delete('external-editor');
    url.searchParams.delete('external-editor-section');
    try {
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (e) {}
    return {section: section == null || section === '' ? undefined : Number(section)};
  }

  function isArticleLink(a) {
    if (a.closest('.mw-editsection')) return false;
    if (a.classList.contains('new') || a.classList.contains('external')) return false;
    var url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return false;
    var q = url.searchParams;
    if (q.get('action') || q.get('oldid') || q.get('diff') || q.get('redlink')) return false;
    if (url.pathname.indexOf('/Special:') >= 0 || url.pathname.indexOf('特殊:') >= 0) return false;
    if (url.pathname === location.pathname && url.hash) return false;
    return true;
  }

  function textAtPoint(x, y) {
    var range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint) {
      var pos = document.caretPositionFromPoint(x, y);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    }
    if (!range || !range.startContainer || range.startContainer.nodeType !== Node.TEXT_NODE) return null;
    var value = range.startContainer.nodeValue || '';
    var index = range.startOffset || 0;
    var s = value.slice(Math.max(0, index - 40), Math.min(value.length, index + 40))
      .replace(/\s+/g, ' ').trim();
    return s.length >= 2 ? s : null;
  }

  // ---------- preview ----------
  function executeScripts(root) {
    if (!root) return;
    root.querySelectorAll && root.querySelectorAll('script').forEach(function (old) {
      if (old.dataset.mweExecuted) return;
      var script = document.createElement('script');
      for (var i = 0; i < old.attributes.length; i++) {
        script.setAttribute(old.attributes[i].name, old.attributes[i].value);
      }
      script.textContent = old.textContent;
      script.dataset.mweExecuted = '1';
      old.replaceWith(script);
    });
  }

  function applyFull(html) {
    var root = document.querySelector('#mw-content-text');
    if (!root) return;
    if (session && !session.fullOriginal) {
      session.fullOriginal = Array.prototype.slice.call(root.childNodes);
    }
    var temp = document.createElement('div');
    temp.innerHTML = html;
    root.replaceChildren.apply(root, temp.childNodes);
    executeScripts(root);
    if (window.mw && window.mw.hook && typeof jQuery === 'function') {
      mw.hook('wikipage.content').fire(jQuery(root));
    }
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 250);
  }

  async function renderPreview() {
    if (!session) return;
    if (session.section != null) {
      setStatus('VSCode 编辑中（章节预览暂不支持）');
      return;
    }
    var seq = ++previewSeq;
    var params = {
      action: 'parse',
      contentmodel: 'wikitext',
      title: session.title,
      text: session.text,
      pst: '1',
      preview: '1',
      disableeditsection: '1',
      disablelimitreport: '1',
      prop: 'text',
    };
    var data;
    try {
      data = await apiPost(params);
    } catch (e) {
      if (seq === previewSeq) status('预览失败：' + e.message);
      return;
    }
    if (seq !== previewSeq || !data.parse) return;
    applyFull(data.parse.text);
    setStatus('预览已更新 ' + new Date().toLocaleTimeString());
  }

  // ---------- edit session ----------
  function onBeforeUnload(e) {
    if (session && (session.changed || session.remoteDirty)) {
      e.preventDefault();
      e.returnValue = '还有未提交的修改，确定离开？';
      return e.returnValue;
    }
  }

  function restorePage() {
    var root = document.querySelector('#mw-content-text');
    if (root && session && session.fullOriginal) {
      root.replaceChildren.apply(root, session.fullOriginal);
      session.fullOriginal = null;
    }
  }

  function endSession() {
    session = null;
    clearTimeout(previewTimer);
    window.removeEventListener('beforeunload', onBeforeUnload);
    var bar = document.querySelector('.mwe-ipe-bar');
    if (bar) bar.remove();
    document.body.classList.remove('mwe-ipe-editing');
  }

  function queryExistingSession() {
    if (sessionQueryPromise) return sessionQueryPromise;
    if (!connected) return Promise.resolve(null);
    var requestId = 'session-' + Date.now() + '-' + (++sessionQuerySeq);
    sessionQueryPromise = new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete sessionWaiters[requestId];
        reject(new Error('扩展未响应会话查询'));
      }, 8000);
      sessionWaiters[requestId] = {resolve: resolve, reject: reject, timer: timer};
      if (!send({
        type: 'session-query',
        requestId: requestId,
        origin: location.origin,
        title: window.mw && mw.config && mw.config.get('wgPageName'),
      })) {
        clearTimeout(timer);
        delete sessionWaiters[requestId];
        reject(new Error('扩展未连接'));
      }
    }).catch(function (error) {
      sessionQueryPromise = null;
      throw error;
    });
    return sessionQueryPromise;
  }

  function onSessionResult(msg) {
    var waiter = sessionWaiters[msg.requestId];
    if (!waiter) return;
    clearTimeout(waiter.timer);
    delete sessionWaiters[msg.requestId];
    if (!msg.ok) waiter.reject(new Error(msg.error || '会话查询失败'));
    else waiter.resolve(msg.session || null);
  }

  async function adoptSession(info) {
    if (!info || session) return;
    var wikiPage;
    if (ipeContext && ipeContext.wikiPage) {
      try {
        wikiPage = info.revid
          ? await ipeContext.wikiPage.newFromRevision(info.revid, info.section)
          : await ipeContext.wikiPage.newFromTitle(info.title, false, info.section);
      } catch (e) {
        status('恢复会话失败：' + ((e && e.message) || e), 'error');
        return;
      }
    }
    if (!wikiPage) {
      status('无法恢复编辑会话：InPageEdit wikiPage 不可用', 'error');
      return;
    }
    session = {
      id: info.sessionId,
      title: info.title,
      section: info.section,
      text: info.text,
      wikiPage: wikiPage,
      remoteDirty: !!info.dirty,
      changed: false,
      busy: false,
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    showBar(null);
    document.body.classList.remove('ipe-modal-no-scroll');
    setStatus('已恢复 VSCode 编辑会话');
    schedulePreview();
  }

  async function startEdit(payload) {
    var options = payload.options;
    var modal = payload.modal;
    var wikiPage = payload.wikiPage;
    if (session) return;
    if (!connected) {
      pendingStart = payload;
      notifyOffline();
      return;
    }
    try {
      await ensureWikiRegistered();
      var existing = await queryExistingSession();
      if (existing) {
        await adoptSession(existing);
        return;
      }
    } catch (e) {
      var message = '站点注册失败：' + ((e && e.message) || e) + '。请更新网页端脚本并刷新页面。';
      status(message, 'error');
      notifyOffline(message, '站点注册失败');
      return;
    }
    var rev = wikiPage.revisions && wikiPage.revisions[0];
    session = {
      id: 's' + Date.now(),
      title: (wikiPage.pageInfo && wikiPage.pageInfo.title) || options.title,
      section: options.section,
      text: (rev && rev.content) || '',
      wikiPage: wikiPage,
      remoteDirty: false,
      changed: false,
      busy: false,
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    showBar(modal);
    document.body.classList.remove('ipe-modal-no-scroll');
    setStatus('VSCode 编辑中，保存文件即刷新预览');
    send({
      type: 'open',
      sessionId: session.id,
      title: session.title,
      section: session.section,
      text: session.text,
      revid: rev && rev.revid,
      basetimestamp: rev && rev.timestamp,
      starttimestamp: new Date().toISOString(),
      wiki: location.origin,
    });
  }

  function showImagesUsed() {
    if (!session) return;
    var modalSvc = window.ipe && window.ipe.get && window.ipe.get('modal');
    if (!modalSvc) return;
    fetch(API + '?action=parse&format=json&formatversion=2&prop=images&page=' + encodeURIComponent(session.title))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var images = (d.parse && d.parse.images) || [];
        var box = document.createElement('div');
        if (!images.length) {
          box.textContent = '没有使用的图片。';
        } else {
          var ol = document.createElement('ol');
          images.forEach(function (t) {
            var name = /^File:/i.test(t) ? t : 'File:' + t;
            var li = document.createElement('li');
            var a = document.createElement('a');
            a.href = '/wiki/' + encodeURIComponent(name);
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = name;
            li.appendChild(a);
            ol.appendChild(li);
          });
          box.appendChild(ol);
        }
        modalSvc.show({
          title: '使用的图片',
          content: box,
          sizeClass: 'dialog',
          draggable: true,
          backdrop: false,
        });
      });
  }

  function cancelEdit() {
    if (!session) return;
    var pending = session.remoteDirty || session.changed;
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
    try {
      send({ type: 'finish', sessionId: session.id, result: pending ? 'discarded' : 'unchanged' });
    } catch (e) {}
    window.removeEventListener('beforeunload', onBeforeUnload);
    restorePage();
    endSession();
  }

  function showBar(modal) {
    try { modal.close(); } catch (e) {}
    ensureBar();
  }

  function requestSave(bar) {
    if (!session) return;
    if (session.remoteDirty) {
      setStatus('VSCode 里有未保存修改，先保存文件（Ctrl+S）', 'error');
      return;
    }
    setBusy(true);
    var summaryInput = bar.querySelector('.mwe-ipe-summary');
    var minorInput = bar.querySelector('.mwe-ipe-minor');
    var watchInput = bar.querySelector('.mwe-ipe-watchlist');
    var reloadInput = bar.querySelector('.mwe-ipe-reload');
    session.watchlist = watchInput ? watchInput.value : 'nochange';
    session.reload = !!(reloadInput && reloadInput.checked);
    setStatus('正在保存文件…');
    send({
      type: 'request-save',
      sessionId: session.id,
      summary: summaryInput ? summaryInput.value : '',
      minor: !!(minorInput && minorInput.checked),
    });
  }

  async function saveEdit(text, summary, minor) {
    if (!session) return;
    try {
      await session.wikiPage.edit({
        text: text,
        summary: summary || '',
        minor: !!minor,
        section: session.section,
        watchlist: session.watchlist || 'nochange',
      });
      window.removeEventListener('beforeunload', onBeforeUnload);
      send({ type: 'save-result', sessionId: session.id, ok: true });
      send({ type: 'finish', sessionId: session.id, result: 'saved', summary: summary || '', minor: !!minor });
      setStatus(session.reload === false ? '已保存' : '已保存，正在刷新…', 'ok');
      setBusy(false);
      if (session.reload !== false) setTimeout(function () { location.reload(); }, 800);
    } catch (e) {
      var message = (e && e.message) || String(e);
      setBusy(false);
      send({ type: 'save-result', sessionId: session.id, ok: false, error: message });
      setStatus('保存失败：' + message, 'error');
    }
  }

  // ---------- click -> locate ----------
  document.addEventListener('click', function (e) {
    if (!session) return;
    if (e.target.closest && !e.target.closest('#mw-content-text')) return;
    var a = e.target.closest && e.target.closest('a');
    if (a) {
      if (!isArticleLink(a)) return;
      e.preventDefault();
      window.open(editUrlFor(a.href), '_blank', 'noopener');
      return;
    }
    var text = textAtPoint(e.clientX, e.clientY);
    if (text) send({ type: 'locate', sessionId: session.id, text: text });
  }, true);

  // ---------- registration ----------
  function register(ipeCtx) {
    if (registered || !ipeCtx) return;
    registered = true;
    ipeContext = ipeCtx;
    ensureGuardStyle();
    connect();
    ipeCtx.plugin({
      name: 'vscode-editor',
      apply: function (ctx) {
        ctx.on('quick-edit/show-modal', function (payload) {
          try { payload.modal.close(); } catch (e) {}
          document.body.classList.remove('ipe-modal-no-scroll');
        });
        ctx.on('quick-edit/wiki-page', function (payload) {
          startEdit(payload).catch(function (e) {
            status('启动失败：' + ((e && e.message) || e));
          });
        });
      },
    });
    var autoEdit = consumeAutoEdit();
    if (autoEdit) {
      setTimeout(function () {
        try {
          var title = window.mw && mw.config && mw.config.get('wgPageName');
          if (!title) throw new Error('无法读取当前页面标题');
          if (typeof ipeCtx.quickEdit !== 'function') throw new Error('InPageEdit 缺少 quickEdit');
          ipeCtx.quickEdit({title: title, section: autoEdit.section});
        } catch (e) {
          status('自动进入编辑失败：' + ((e && e.message) || e), 'error');
        }
      }, 0);
    }
  }

  if (window.ipe) {
    register(window.ipe);
  } else if (window.mw && window.mw.hook) {
    window.mw.hook('InPageEdit.ready').add(function (ipeCtx) { register(ipeCtx); });
    var tries = 0;
    var timer = setInterval(function () {
      if (registered || ++tries > 20) { clearInterval(timer); return; }
      if (window.ipe) { clearInterval(timer); register(window.ipe); }
    }, 500);
  } else {
    (window.__IPE_MODULES__ = window.__IPE_MODULES__ || []).push(function (ipeCtx) { register(ipeCtx); });
  }
})();
