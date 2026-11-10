/* InPageEdit NEXT plugin: edit pages in VSCode.
 * Load from your personal JS (after InPageEdit loads), or inject its contents.
 */
(function () {
  'use strict';
  if (window.__vcpeIpeRegistered) return;
  window.__vcpeIpeRegistered = true;

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
    if (document.getElementById('vcpe-ipe-guard-style')) return;
    var style = document.createElement('style');
    style.id = 'vcpe-ipe-guard-style';
    style.textContent = [
      '.ipe-modal-modal__window.ipe-quickEdit{display:none!important;}',
      '.ipe-modal-backdrop:has(+ .ipe-modal-modal .ipe-quickEdit){display:none!important;}',
    ].join('\n');
    document.head.append(style);
  }

  // ---------- bottom bar ----------
  var barStyleId = 'vcpe-ipe-bar-style';

  function ensureBarStyle() {
    if (document.getElementById(barStyleId)) return;
    var style = document.createElement('style');
    style.id = barStyleId;
    style.textContent = [
      '.vcpe-ipe-bar{position:fixed;left:0;right:0;bottom:0;z-index:2147483001;display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#fff;border-top:2px solid #3366cc;padding:10px 16px;box-shadow:0 -2px 12px rgba(0,0,0,.15);font-size:14px;color:#202122;}',
      '.vcpe-ipe-bar .vcpe-ipe-status{flex:1 1 180px;color:#72777d;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.vcpe-ipe-bar .vcpe-ipe-status.error{color:#d33;}',
      '.vcpe-ipe-bar .vcpe-ipe-status.ok{color:#14866d;}',
      '.vcpe-ipe-bar input[type=text]{flex:1 1 220px;min-width:160px;padding:6px 10px;border:1px solid #a2a9b1;border-radius:4px;font-size:14px;}',
      '.vcpe-ipe-bar select{padding:6px 10px;border:1px solid #a2a9b1;border-radius:4px;background:#fff;font-size:14px;color:#202122;}',
      '.vcpe-ipe-bar button{padding:6px 14px;border-radius:4px;border:1px solid #a2a9b1;background:#f8f9fa;cursor:pointer;font-size:14px;color:#202122;}',
      '.vcpe-ipe-bar button:hover{background:#eaecf0;}',
      '.vcpe-ipe-bar button.is-primary{background:#3366cc;border-color:#3366cc;color:#fff;font-weight:600;}',
      '.vcpe-ipe-bar button.is-primary:hover{background:#2a56a8;}',
      '.vcpe-ipe-bar .vcpe-ipe-link{color:#3366cc;font-size:13px;text-decoration:none;cursor:pointer;white-space:nowrap;}',
      '.vcpe-ipe-bar .vcpe-ipe-link:hover{text-decoration:underline;}',
      '.vcpe-ipe-bar label{display:flex;align-items:center;gap:4px;white-space:nowrap;}',
      'body.vcpe-ipe-editing{padding-bottom:96px;}',
    ].join('\n');
    document.head.append(style);
  }

  function refreshBar() {
    var bar = document.querySelector('.vcpe-ipe-bar');
    if (!bar || !session) return;
    var submit = bar.querySelector('.vcpe-ipe-submit');
    if (submit) submit.disabled = !!session.remoteDirty || !!session.busy;
    if (session.remoteDirty) {
      setStatus('VSCode 里有未保存修改，先保存文件（Ctrl+S）');
    }
  }

  function setBusy(busy) {
    if (session) session.busy = !!busy;
    var bar = document.querySelector('.vcpe-ipe-bar');
    if (!bar) return;
    bar.querySelectorAll('button').forEach(function (b) { b.disabled = !!busy; });
    if (busy) setStatus('提交中…');
  }

  function setStatus(text, kind) {
    var el = document.querySelector('.vcpe-ipe-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'vcpe-ipe-status' + (kind ? ' ' + kind : '');
  }

  function ensureBar() {
    ensureBarStyle();
    var bar = document.querySelector('.vcpe-ipe-bar');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.className = 'vcpe-ipe-bar';
    bar.innerHTML =
      '<span class="vcpe-ipe-status">VSCode 编辑中</span>' +
      '<input type="text" class="vcpe-ipe-summary" placeholder="编辑摘要">' +
      '<select class="vcpe-ipe-watchlist">' +
      '<option value="preferences">遵循 MW 首选</option>' +
      '<option value="nochange">保持当前状态</option>' +
      '<option value="watch">添加到监视列表</option>' +
      '<option value="unwatch">从监视列表移除</option>' +
      '</select>' +
      '<label><input type="checkbox" class="vcpe-ipe-minor"> 小编辑</label>' +
      '<label><input type="checkbox" class="vcpe-ipe-reload" checked> 保存后刷新</label>' +
      '<button class="vcpe-ipe-submit is-primary">提交</button>' +
      '<button class="vcpe-ipe-diff">差异</button>' +
      '<a class="vcpe-ipe-link vcpe-ipe-upload">快速上传</a>' +
      '<a class="vcpe-ipe-link vcpe-ipe-templates">使用的模板</a>' +
      '<a class="vcpe-ipe-link vcpe-ipe-images">使用的图片</a>' +
      '<button class="vcpe-ipe-cancel">取消</button>';
    document.body.append(bar);
    document.body.classList.add('vcpe-ipe-editing');
    bar.querySelector('.vcpe-ipe-submit').addEventListener('click', function () {
      requestSave(bar);
    });
    bar.querySelector('.vcpe-ipe-cancel').addEventListener('click', function () {
      cancelEdit();
    });
    bar.querySelector('.vcpe-ipe-upload').addEventListener('click', function () {
      var qu = window.ipe && window.ipe.get && window.ipe.get('quickUpload');
      if (qu && qu.showModal) qu.showModal();
    });
    bar.querySelector('.vcpe-ipe-templates').addEventListener('click', function () {
      if (!session) return;
      var tu = window.ipe && window.ipe.get && window.ipe.get('templatesUsed');
      if (tu && tu.showModal) tu.showModal({ title: session.title });
    });
    bar.querySelector('.vcpe-ipe-images').addEventListener('click', function () {
      showImagesUsed();
    });
    bar.querySelector('.vcpe-ipe-diff').addEventListener('click', function () {
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
  function connect() {
    if (socket && socket.readyState <= 1) return;
    socket = new WebSocket(WS_URL);
    socket.addEventListener('open', function () { connected = true; });
    socket.addEventListener('close', function () {
      connected = false;
      setTimeout(connect, RECONNECT_MS);
    });
    socket.addEventListener('error', function () { try { socket.close(); } catch (e) {} });
    socket.addEventListener('message', function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
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
      if (old.dataset.vcpeExecuted) return;
      var script = document.createElement('script');
      for (var i = 0; i < old.attributes.length; i++) {
        script.setAttribute(old.attributes[i].name, old.attributes[i].value);
      }
      script.textContent = old.textContent;
      script.dataset.vcpeExecuted = '1';
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
    var bar = document.querySelector('.vcpe-ipe-bar');
    if (bar) bar.remove();
    document.body.classList.remove('vcpe-ipe-editing');
  }

  async function startEdit(payload) {
    var options = payload.options;
    var modal = payload.modal;
    var wikiPage = payload.wikiPage;
    if (session) return;
    if (!connected) {
      status('VSCode 扩展未连接（端口 8927）');
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
    var summaryInput = bar.querySelector('.vcpe-ipe-summary');
    var minorInput = bar.querySelector('.vcpe-ipe-minor');
    var watchInput = bar.querySelector('.vcpe-ipe-watchlist');
    var reloadInput = bar.querySelector('.vcpe-ipe-reload');
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
      window.open(a.href, '_blank', 'noopener');
      return;
    }
    var text = textAtPoint(e.clientX, e.clientY);
    if (text) send({ type: 'locate', sessionId: session.id, text: text });
  }, true);

  // ---------- registration ----------
  function register(ipeCtx) {
    if (registered || !ipeCtx) return;
    registered = true;
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
