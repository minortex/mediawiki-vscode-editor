'use strict';

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { BrowserBridge } = require('./out/browser-bridge');
const language = require('./lib/language');
const wikis = require('./lib/wikis');
const { normalizeOrigin } = require('./lib/wiki-config');
const { SessionStore } = require('./out/session-store');
const { SessionManager } = require('./out/session-manager');

let bridge = null;
let statusBar = null;
let languageFeatures = null;
let sessionStore = null;
let sessionManager = null;
const dirtyTimers = new Map(); // fsPath -> timeout
const syncTimers = new Map(); // sessionId -> timeout

// 只有这些结果代表用户在页面上明确确认过，才允许删除临时文件
const DELETE_RESULTS = new Set(['saved', 'unchanged', 'discarded']);

function config() {
  return vscode.workspace.getConfiguration('mediawikiEditor');
}

async function ensureSessionEditor(meta) {
  let doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === meta.fsPath);
  if (!doc) {
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.file(meta.fsPath));
    } catch {
      return undefined;
    }
  }
  if (languageFeatures) {
    try {
      doc = await languageFeatures.apply(doc, meta.wiki, meta.title);
    } catch {}
  }
  await vscode.window.showTextDocument(doc, { preview: false });
  if (languageFeatures) languageFeatures.check(doc, meta.wiki, meta.title).catch(() => {});
  meta.state = 'detached';
  return doc;
}

function safeName(title) {
  return title.replace(/[\\/:*?"<>|\r\n]/g, '_');
}

function defaultDir() {
  if (process.platform === 'win32') {
    const base =
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'mediawiki-edit');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'mediawiki-edit');
  }
  const base =
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'mediawiki-edit');
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

function updateStatus() {
  if (!statusBar) return;
  const connected = bridge?.connectionCount || 0;
  statusBar.text = connected
    ? '$(vm-active) MediaWiki: 已连接'
    : '$(vm-outline) MediaWiki: 等待浏览器';
  statusBar.tooltip = '点击查看连接状态';
  statusBar.show();
}

function push(doc) {
  const sessionId = sessionManager?.idForPath(doc.uri.fsPath);
  if (!sessionId || !bridge) return false;
  const count = bridge.broadcast({
    type: 'update',
    sessionId,
    text: doc.getText(),
  });
  if (count > 0) {
    vscode.window.setStatusBarMessage('MediaWiki: 已把保存内容推送到浏览器预览', 5000);
  }
  return count > 0;
}

function notifyDirty(doc) {
  const sessionId = sessionManager?.idForPath(doc.uri.fsPath);
  if (!sessionId || !bridge) return;
  bridge.broadcast({type: 'state', sessionId, dirty: doc.isDirty});
}

async function closeAndDelete(fsPath) {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
  if (doc && doc.isDirty) {
    // 用户已在页面上确认，先把内容刷到临时文件，避免再弹一次保存提示
    try {
      await doc.save();
    } catch {}
  }
  const tab = vscode.window.tabGroups?.all
    ?.flatMap((group) => group.tabs)
    .find((t) => t.input?.uri?.fsPath === fsPath);
  if (tab) {
    try {
      await vscode.window.tabGroups.close(tab);
    } catch {}
  }
  try {
    await fs.promises.unlink(fsPath);
  } catch {}
}

let wikiParser = null;
let toSimplified = null;

function simplify(text) {
  if (!toSimplified) {
    try {
      const OpenCC = require('opencc-js');
      toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' });
    } catch {
      toSimplified = (s) => s;
    }
  }
  return toSimplified(text);
}
const itemCache = new Map(); // fsPath -> { version, items }

function extractItems(text) {
  if (text.length > 300000) return [];
  wikiParser ||= require('wikiparser-node');
  const root = wikiParser.parse(text);
  const items = [];
  let poemCount = 0;
  const add = (value, start, scope, label) => {
    const s = simplify(
      String(value || '')
        .replace(/<!--|-->/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    );
    if (/\.(jpe?g|png|gif|svg|webp|ogg|mp3|webm|pdf)$/i.test(s)) return;
    if (!/[\p{L}\p{N}]/u.test(s)) return;
    if (s.length >= 2 && s.length <= 60) {
      items.push({ start, text: s, scope, label: label || null });
    }
  };
  const walk = (node, scope, label) => {
    const name = node.constructor.name;
    // <poem> renders inside .poem; restrict matching to that container so
    // repeated lyrics are not matched against the same words in infoboxes.
    if (name === 'ExtToken' && String(node.name).toLowerCase() === 'poem') {
      scope = { type: 'poem', index: poemCount++ };
      label = null;
    }
    // Only the value part of a parameter is rendered; skip the parameter name
    // but keep it as a label for context matching.
    if (name === 'ParameterToken') {
      const paramName = simplify(String(node.childNodes?.[0] || '').replace(/\s+/g, ' ').trim());
      for (const child of (node.childNodes || []).slice(1)) walk(child, scope, paramName);
      return;
    }
    // The template name is not rendered text either; skip it and visit parameters.
    if (name === 'TranscludeToken') {
      for (const child of (node.childNodes || []).slice(1)) walk(child, scope, label);
      return;
    }
    if (name === 'LinkToken') {
      const raw = node.toString();
      const m = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(raw);
      add(m ? (m[2] || m[1]) : raw, node.getAbsoluteIndex(), scope, label);
      return;
    }
    if (name === 'AstText') {
      const raw = node.toString();
      const base = node.getAbsoluteIndex();
      let cursor = 0;
      for (const part of raw.split(/[•·、,，;；\n]+/)) {
        const idx = raw.indexOf(part, cursor);
        add(part, base + Math.max(0, idx), scope, label);
        cursor = Math.max(cursor, idx + part.length);
      }
      return;
    }
    for (const child of node.childNodes || []) walk(child, scope, label);
  };
  for (const child of root.childNodes || []) walk(child);
  items.sort((a, b) => a.start - b.start);
  for (let i = 0; i < items.length; i++) {
    items[i].prev = i > 0 ? items[i - 1].text.slice(-24) : null;
    items[i].next = i < items.length - 1 ? items[i + 1].text.slice(0, 24) : null;
  }
  const labelCounts = new Map();
  for (const item of items) {
    if (!item.label) {
      item.labelOccurrence = 0;
      continue;
    }
    const key = [item.scope?.type || '', item.scope?.index ?? '', item.label, item.text].join('\u0001');
    const n = (labelCounts.get(key) || 0) + 1;
    labelCounts.set(key, n);
    item.labelOccurrence = n;
  }
  return items;
}

function itemsFor(doc) {
  const cached = itemCache.get(doc.uri.fsPath);
  if (cached && cached.version === doc.version) return cached.items;
  let items = [];
  try {
    items = extractItems(doc.getText());
  } catch {
    items = [];
  }
  itemCache.set(doc.uri.fsPath, { version: doc.version, items });
  return items;
}

function itemAt(items, offset) {
  let best = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].start <= offset) best = i;
    else break;
  }
  return best;
}

function occurrenceOf(items, index) {
  const target = items[index];
  const keyOf = (item) =>
    item.scope ? `${item.scope.type}:${item.scope.index}` : '';
  const key = keyOf(target);
  let count = 0;
  for (let i = 0; i <= index; i++) {
    if (items[i].text === target.text && keyOf(items[i]) === key) count++;
  }
  return count;
}

function findLineByText(doc, text) {
  const needle = simplify(String(text || '').trim());
  if (!needle) return -1;
  const items = itemsFor(doc);
  const hit = items.find((it) => it.text.includes(needle) || needle.includes(it.text));
  if (hit) return doc.positionAt(hit.start).line;
  for (let i = 0; i < doc.lineCount; i++) {
    if (simplify(doc.lineAt(i).text).includes(needle)) return i;
  }
  return -1;
}

let suppressScrollUntil = 0;

function revealLine(editor, line) {
  const pos = new vscode.Position(line, 0);
  suppressScrollUntil = Date.now() + 700;
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  vscode.window.setStatusBarMessage(`MediaWiki: 定位到第 ${line + 1} 行`, 2000);
}

async function locateInEditor(msg) {
  if (!msg.text) return;
  const meta = sessionManager?.get(msg.sessionId);
  if (!meta) return;
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === meta.fsPath);
  if (!doc) return;
  const line = findLineByText(doc, msg.text);
  if (line < 0) return;
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  revealLine(editor, line);
}

async function handleRequestSave(msg) {
  const meta = sessionManager?.get(msg.sessionId);
  if (!meta) return;
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === meta.fsPath);
  if (!doc) return;
  if (doc.isDirty) await doc.save();
  const count = bridge.broadcast({
    type: 'save',
    sessionId: msg.sessionId,
    text: doc.getText(),
    summary: msg.summary,
    minor: msg.minor,
  });
  if (!count) {
    vscode.window.showWarningMessage('MediaWiki: 浏览器未连接，无法提交。');
  }
}

async function openSession(msg, ws, wiki) {
  const root = config().get('tempDir') || defaultDir();
  const dir = wikis.directoryFor(root, wiki);
  await fs.promises.mkdir(dir, { recursive: true });
  const suffix = msg.section != null ? `.s${msg.section}` : '';
  const fsPath = path.join(dir, `${safeName(msg.title)}${suffix}.${stamp()}.wiki`);

  await fs.promises.writeFile(fsPath, msg.text, 'utf8');
  let doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
  if (languageFeatures) {
    try {
      doc = await languageFeatures.apply(doc, wiki, msg.title);
    } catch {}
  }
  await vscode.window.showTextDocument(doc, { preview: false });
  if (languageFeatures) languageFeatures.check(doc, wiki, msg.title).catch(() => {});

  sessionManager?.add(msg.sessionId, {
    fsPath,
    ws,
    title: msg.title,
    section: msg.section ?? null,
    wiki,
    revid: msg.revid,
    basetimestamp: msg.basetimestamp,
    starttimestamp: msg.starttimestamp,
    created: Date.now(),
    state: 'attached',
    autoRestore: true,
  });

  const label = msg.section != null ? `${msg.title} § ${msg.section}` : msg.title;
  vscode.window.setStatusBarMessage(
    `MediaWiki: 正在编辑 ${wiki.name} 的 ${label}，保存文件即刷新浏览器预览`,
    8000
  );
}

async function finishSession(msg) {
  const meta = sessionManager?.get(msg.sessionId);
  if (!meta) return;
  clearTimeout(dirtyTimers.get(meta.fsPath));
  dirtyTimers.delete(meta.fsPath);

  if (!DELETE_RESULTS.has(msg.result)) {
    // closed / 断线 / 未知状态：保留编辑器与文件，绝不自动删除
    sessionManager?.markDraft(msg.sessionId);
    vscode.window.showWarningMessage(
      `MediaWiki: 编辑会话已断开，临时文件保留：${meta.fsPath}`
    );
    return;
  }

  sessionManager?.remove(msg.sessionId);
  await closeAndDelete(meta.fsPath);
  vscode.window.setStatusBarMessage(
    msg.result === 'saved' ? 'MediaWiki: 已在浏览器提交保存' : 'MediaWiki: 编辑会话已结束',
    5000
  );
}

async function saveInPage(sessionId, text, summary, minor) {
  const meta = sessionManager?.get(sessionId);
  if (!meta?.ws || !bridge) {
    vscode.window.showWarningMessage('MediaWiki: 浏览器未连接，无法提交。');
    return {ok: false, error: '浏览器未连接'};
  }
  try {
    const reply = await bridge.request(meta.ws, {type: 'save', sessionId, text, summary, minor}, 15000);
    return {ok: !!reply.ok, error: reply.error};
  } catch (error) {
    vscode.window.showWarningMessage(`MediaWiki: 提交失败：${error.message}`);
    return {ok: false, error: error.message};
  }
}

function sameOrigin(a, b) {
  try {
    return normalizeOrigin(a) === normalizeOrigin(b);
  } catch {
    return false;
  }
}

async function requestBrowserNavigate({wiki, title, fragment}) {
  const meta = sessionManager?.values().find(
    (item) => item.ws && sameOrigin(item.wiki.origin, wiki.origin)
  );
  if (!meta?.ws || !bridge) {
    vscode.window.showWarningMessage('MediaWiki: 浏览器未连接，无法打开目标页面。');
    return false;
  }
  try {
    const reply = await bridge.request(meta.ws, {type: 'navigate-edit', title, fragment}, 5000);
    if (!reply.opened) {
      vscode.window.showWarningMessage(
        'MediaWiki: 浏览器拦截了目标页面，请允许本站弹窗后重试。'
      );
    }
    return !!reply.opened;
  } catch (error) {
    vscode.window.showWarningMessage(`MediaWiki: 打开目标页面失败：${error.message}`);
    return false;
  }
}

async function handleRegisterWiki(msg, ws, context) {
  const requestId = msg.requestId;
  const reply = (payload) => {
    try {
      ws.send(JSON.stringify({type: 'wiki-registered', requestId, ...payload}));
    } catch {}
  };
  try {
    if (!requestId) throw new Error('缺少 requestId');
    if (!ws.origin || !msg.origin || !sameOrigin(msg.origin, ws.origin)) {
      throw new Error('站点来源与浏览器连接不一致');
    }
    const before = wikis.find(context, msg.origin);
    const entry = await wikis.upsert(context, {
      origin: msg.origin,
      api: msg.api,
      name: msg.name,
      siteinfo: msg.siteinfo,
    });
    if (!before || before.siteinfoHash !== entry.siteinfoHash) {
      languageFeatures?.refresh();
    }
    reply({ok: true, wiki: {id: entry.id, name: entry.name, origin: entry.origin}});
  } catch (error) {
    reply({ok: false, error: error.message});
  }
}


function normalizePageName(value) {
  return String(value || '').replace(/_/gu, ' ').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function pageUrl(wiki, title) {
  const encoded = encodeURIComponent(String(title).replace(/ /gu, '_'))
    .replace(/%2F/giu, '/')
    .replace(/%3A/giu, ':');
  try {
    return new URL((wiki.articlePath || `${wiki.origin}/$1`).replace(/\$1/gu, encoded), wiki.origin).href;
  } catch {
    return undefined;
  }
}

async function handleSessionQuery(msg, ws, context) {
  const requestId = msg.requestId;
  const reply = (payload) => {
    try {
      ws.send(JSON.stringify({type: 'session-result', requestId, ...payload}));
    } catch {}
  };
  try {
    if (!requestId) throw new Error('缺少 requestId');
    if (!ws.origin || !msg.origin || !sameOrigin(msg.origin, ws.origin)) {
      throw new Error('站点来源与浏览器连接不一致');
    }
    const title = normalizePageName(msg.title);
    if (!title) return reply({ok: true, session: null});
    const candidates = (sessionManager ? sessionManager.entries() : [])
      .filter(([, meta]) => sameOrigin(meta.wiki.origin, msg.origin)
        && normalizePageName(meta.title) === title
        && (meta.state !== 'draft' || meta.autoRestore))
      .sort(([, a], [, b]) => {
        const af = a.section == null ? 0 : 1;
        const bf = b.section == null ? 0 : 1;
        return af - bf || b.created - a.created;
      });
    let picked;
    for (const [sessionId, meta] of candidates) {
      if (meta.state === 'draft') {
        const editor = await ensureSessionEditor(meta);
        if (!editor) continue;
      }
      let text;
      try {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === meta.fsPath);
        text = doc ? doc.getText() : await fs.promises.readFile(meta.fsPath, 'utf8');
      } catch {
        continue;
      }
      picked = {sessionId, meta, text};
      break;
    }
    if (!picked) return reply({ok: true, session: null});
    const {sessionId, meta, text} = picked;
    if (meta.ws && meta.ws !== ws) {
      try {
        meta.ws.send(JSON.stringify({type: 'preempted', sessionId}));
      } catch {}
    }
    sessionManager?.attach(sessionId, ws);
    sessionManager?.markAttached(sessionId);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === meta.fsPath);
    reply({
      ok: true,
      session: {
        sessionId,
        title: meta.title,
        section: meta.section,
        text,
        dirty: !!doc?.isDirty,
        state: meta.state,
        revid: meta.revid,
        basetimestamp: meta.basetimestamp,
        starttimestamp: meta.starttimestamp,
        wiki: {id: meta.wiki.id, name: meta.wiki.name, origin: meta.wiki.origin},
      },
    });
    updateStatus();
  } catch (error) {
    reply({ok: false, error: error.message});
  }
}


async function restoreDraft() {
  const drafts = sessionManager ? sessionManager.drafts() : [];
  if (!drafts.length) {
    vscode.window.showInformationMessage('MediaWiki: 没有可恢复的草稿。');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    drafts.map(([sessionId, meta]) => ({
      label: meta.title,
      description: meta.section == null ? meta.wiki.name : `${meta.wiki.name} § ${meta.section}`,
      detail: meta.fsPath,
      sessionId,
      meta,
    })),
    {placeHolder: '选择要恢复的草稿'}
  );
  if (!picked) return;
  const doc = await ensureSessionEditor(picked.meta);
  if (!doc) {
    vscode.window.showErrorMessage('MediaWiki: 草稿文件不存在，无法恢复。');
    return;
  }
  vscode.window.showInformationMessage(`MediaWiki: 已恢复 ${picked.meta.title} 的草稿。`);
}

function handleMessage(msg, ws, context) {
  if (msg.type === 'register-wiki') {
    handleRegisterWiki(msg, ws, context).catch(() => {});
  } else if (msg.type === 'session-query') {
    handleSessionQuery(msg, ws, context).catch(() => {});
  } else if (msg.type === 'open') {
    const wiki = wikis.resolve(context, msg.wiki, ws.origin);
    if (!wiki) {
      vscode.window.showWarningMessage(
        `MediaWiki: 未注册的 wiki（${msg.wiki || ws.origin || '未知来源'}）。请确认网页端脚本已更新并刷新页面。`
      );
      return;
    }
    openSession(msg, ws, wiki).catch((err) =>
      vscode.window.showErrorMessage(`MediaWiki: ${err.message}`)
    );
  } else if (msg.type === 'finish') {
    finishSession(msg).catch(() => {});
  } else if (msg.type === 'locate') {
    locateInEditor(msg).catch(() => {});
  } else if (msg.type === 'request-save') {
    handleRequestSave(msg).catch((err) =>
      vscode.window.showErrorMessage(`MediaWiki: ${err.message}`)
    );

  }
}

function activate(context) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'mediawikiEditor.status';
  updateStatus();

  const port = config().get('port');
  const allowedOrigin = config().get('allowedOrigin');

  sessionStore = new SessionStore(
    context.globalStorageUri ? path.join(context.globalStorageUri.fsPath, 'sessions.json') : undefined
  );
  sessionManager = new SessionManager(sessionStore, () => updateStatus());
  sessionManager.load();
  languageFeatures = language.registerLanguageFeatures(context, {navigateEdit: requestBrowserNavigate});

  bridge = new BrowserBridge();
  bridge.start({
    port,
    allowedOrigin,
    onMessage: (msg, ws) => handleMessage(msg, ws, context),
    onConnection: (ws) => {
      sessionManager?.registerSocket(ws);
      ws.on('close', () => {
        sessionManager?.detachWs(ws);
        updateStatus();
      });
      updateStatus();
    },
    onError: (err) => {
      vscode.window.showErrorMessage(
        `MediaWiki: 本地服务启动失败（端口 ${port}）：${err.message}`
      );
    },
  });

  context.subscriptions.push(
    statusBar,
    ...wikis.register(context, () => languageFeatures?.refresh()),
    vscode.commands.registerCommand('mediawikiEditor.push', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('MediaWiki: 当前没有打开的文件。');
        return;
      }
      if (!push(editor.document)) {
        vscode.window.showInformationMessage(
          'MediaWiki: 当前文件不是编辑会话，或浏览器未连接。'
        );
      }
    }),
    vscode.commands.registerCommand('mediawikiEditor.save', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('MediaWiki: 当前没有打开的文件。');
        return;
      }
      const sessionId = sessionManager?.idForPath(editor.document.uri.fsPath);
      if (!sessionId) {
        vscode.window.showInformationMessage('MediaWiki: 当前文件不是编辑会话。');
        return;
      }
      const summary = await vscode.window.showInputBox({
        prompt: '编辑摘要',
        value: '[VSCode]',
      });
      if (summary === undefined) return;
      const result = await saveInPage(sessionId, editor.document.getText(), summary, false);
      if (result.ok) {
        await finishSession({ sessionId, result: 'saved' });
        vscode.window.showInformationMessage('MediaWiki: 已通过 InPageEdit 保存。');
      } else {
        vscode.window.showErrorMessage(`MediaWiki: 保存失败：${result.error}`);
      }
    }),
    vscode.commands.registerCommand('mediawikiEditor.restoreDraft', () => restoreDraft()),
    vscode.commands.registerCommand('mediawikiEditor.openPage', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('MediaWiki: 当前没有打开的文件。');
        return;
      }
      const sessionId = sessionManager?.idForPath(editor.document.uri.fsPath);
      const meta = sessionId ? sessionManager?.get(sessionId) : undefined;
      if (!meta) {
        vscode.window.showInformationMessage('MediaWiki: 当前文件不是编辑会话。');
        return;
      }
      const url = pageUrl(meta.wiki, meta.title);
      if (!url) {
        vscode.window.showErrorMessage('MediaWiki: 无法生成页面地址。');
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
      vscode.window.setStatusBarMessage(`MediaWiki: 已在浏览器打开 ${meta.title}`, 5000);
    }),
    vscode.commands.registerCommand('mediawikiEditor.check', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('MediaWiki: 当前没有打开的文件。');
        return;
      }
      if (!languageFeatures) return;
      try {
        const document = await languageFeatures.apply(editor.document);
        await languageFeatures.check(document);
      } catch (error) {
        vscode.window.showErrorMessage(`MediaWiki: 语言检查失败：${error.message}`);
      }
    }),
    vscode.commands.registerCommand('mediawikiEditor.status', () => {
      const connected = bridge?.connectionCount || 0;
      vscode.window.showInformationMessage(
        `MediaWiki: 端口 ${config().get('port')}，${connected} 个浏览器连接，` +
          `${sessionManager?.values().length || 0} 个活动编辑会话。`
      );
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!sessionManager?.idForPath(doc.uri.fsPath)) return;
      push(doc);
      notifyDirty(doc);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const sessionId = sessionManager?.idForPath(doc.uri.fsPath);
      const meta = sessionId ? sessionManager?.get(sessionId) : undefined;
      if (!meta || meta.state === 'draft') return;
      clearTimeout(dirtyTimers.get(meta.fsPath));
      dirtyTimers.delete(meta.fsPath);
      if (meta.ws) {
        try {
          meta.ws.send(JSON.stringify({type: 'editor-closed', sessionId}));
        } catch {}
      }
      sessionManager?.markDraft(sessionId);
      vscode.window.showInformationMessage(
        `MediaWiki: 编辑器已关闭，草稿已保留。可运行「MediaWiki: 恢复编辑草稿」。`
      );
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      const sessionId = sessionManager?.idForPath(event.textEditor.document.uri.fsPath);
      if (!sessionId || !bridge) return;
      if (Date.now() < suppressScrollUntil) return;
      const line = event.selections[0]?.active.line ?? 0;
      clearTimeout(syncTimers.get(sessionId));
      syncTimers.set(
        sessionId,
        setTimeout(() => {
          syncTimers.delete(sessionId);
          const doc = event.textEditor.document;
          const items = itemsFor(doc);
          const offset = doc.offsetAt(
            event.selections[0]?.active || new vscode.Position(line, 0)
          );
          const itemIndex = itemAt(items, offset);
          if (itemIndex < 0) return; // no candidate: keep the last preview position
          const item = items[itemIndex];
          bridge?.broadcast({
            type: 'scroll',
            sessionId,
            text: item.text,
            occurrence: occurrenceOf(items, itemIndex),
            scope: item.scope,
            label: item.label,
            labelOccurrence: item.labelOccurrence,
            prev: item.prev,
            next: item.next,
          });
        }, 200)
      );
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const fsPath = event.document.uri.fsPath;
      if (!sessionManager?.idForPath(fsPath)) return;
      clearTimeout(dirtyTimers.get(fsPath));
      dirtyTimers.set(
        fsPath,
        setTimeout(() => {
          dirtyTimers.delete(fsPath);
          notifyDirty(event.document);
        }, 120)
      );
    })
  );
}

function deactivate() {
  sessionManager?.persist();
  languageFeatures?.dispose();
  languageFeatures = null;
  bridge?.stop();
  bridge = null;
}

module.exports = { activate, deactivate };
