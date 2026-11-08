'use strict';

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { startWsServer, broadcast } = require('./lib/ws-server');

let wss = null;
let statusBar = null;

const sessions = new Map(); // sessionId -> { fsPath, ws, title, section }
const byPath = new Map(); // fsPath -> sessionId
const wsSessions = new Map(); // ws -> Set<sessionId>
const dirtyTimers = new Map(); // fsPath -> timeout
const syncTimers = new Map(); // sessionId -> timeout

// 只有这些结果代表用户在页面上明确确认过，才允许删除临时文件
const DELETE_RESULTS = new Set(['saved', 'unchanged', 'discarded']);

function config() {
  return vscode.workspace.getConfiguration('vcpediaEditor');
}

function safeName(title) {
  return title.replace(/[\\/:*?"<>|\r\n]/g, '_');
}

function defaultDir() {
  if (process.platform === 'win32') {
    const base =
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'vcpedia-edit');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'vcpedia-edit');
  }
  const base =
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'vcpedia-edit');
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
  const connected = wss
    ? [...wss.clients].filter((c) => c.readyState === 1).length
    : 0;
  statusBar.text = connected
    ? '$(vm-active) VCPedia: 已连接'
    : '$(vm-outline) VCPedia: 等待浏览器';
  statusBar.tooltip = '点击查看连接状态';
  statusBar.show();
}

function push(doc) {
  const sessionId = byPath.get(doc.uri.fsPath);
  if (!sessionId || !wss) return false;
  const count = broadcast(wss, {
    type: 'update',
    sessionId,
    text: doc.getText(),
  });
  if (count > 0) {
    vscode.window.setStatusBarMessage('VCPedia: 已把保存内容推送到浏览器预览', 5000);
  }
  return count > 0;
}

function notifyDirty(doc) {
  const sessionId = byPath.get(doc.uri.fsPath);
  if (!sessionId || !wss) return;
  broadcast(wss, { type: 'state', sessionId, dirty: doc.isDirty });
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
  vscode.window.setStatusBarMessage(`VCPedia: 定位到第 ${line + 1} 行`, 2000);
}

async function locateInEditor(msg) {
  if (!msg.text) return;
  const meta = sessions.get(msg.sessionId);
  if (!meta) return;
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === meta.fsPath);
  if (!doc) return;
  const line = findLineByText(doc, msg.text);
  if (line < 0) return;
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  revealLine(editor, line);
}

async function openSession(msg, ws) {
  const dir = config().get('tempDir') || defaultDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const suffix = msg.section != null ? `.s${msg.section}` : '';
  const fsPath = path.join(dir, `${safeName(msg.title)}${suffix}.${stamp()}.wiki`);

  await fs.promises.writeFile(fsPath, msg.text, 'utf8');
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
  await vscode.window.showTextDocument(doc, { preview: false });

  sessions.set(msg.sessionId, {
    fsPath,
    ws,
    title: msg.title,
    section: msg.section,
  });
  byPath.set(fsPath, msg.sessionId);
  wsSessions.get(ws)?.add(msg.sessionId);

  const label = msg.section != null ? `${msg.title} § ${msg.section}` : msg.title;
  vscode.window.setStatusBarMessage(
    `VCPedia: 正在编辑 ${label}，保存文件即刷新浏览器预览`,
    8000
  );
}

async function finishSession(msg) {
  const meta = sessions.get(msg.sessionId);
  if (!meta) return;
  sessions.delete(msg.sessionId);
  byPath.delete(meta.fsPath);
  wsSessions.get(meta.ws)?.delete(msg.sessionId);
  clearTimeout(dirtyTimers.get(meta.fsPath));
  dirtyTimers.delete(meta.fsPath);

  if (!DELETE_RESULTS.has(msg.result)) {
    // closed / 断线 / 未知状态：保留编辑器与文件，绝不自动删除
    vscode.window.showWarningMessage(
      `VCPedia: 编辑会话已断开，临时文件保留：${meta.fsPath}`
    );
    return;
  }

  await closeAndDelete(meta.fsPath);
  vscode.window.setStatusBarMessage(
    msg.result === 'saved' ? 'VCPedia: 已在浏览器提交保存' : 'VCPedia: 编辑会话已结束',
    5000
  );
}

const saveWaiters = new Map();

function saveInPage(sessionId, text, summary, minor) {
  return new Promise((resolve) => {
    if (!sessions.has(sessionId) || !wss) {
      resolve({ ok: false, error: '编辑会话不存在' });
      return;
    }
    const timer = setTimeout(() => {
      saveWaiters.delete(sessionId);
      resolve({ ok: false, error: '页面未响应保存请求' });
    }, 15000);
    saveWaiters.set(sessionId, { resolve, timer });
    const count = broadcast(wss, { type: 'save', sessionId, text, summary, minor });
    if (!count) {
      clearTimeout(timer);
      saveWaiters.delete(sessionId);
      resolve({ ok: false, error: '浏览器未连接' });
    }
  });
}

function handleMessage(msg, ws) {
  if (msg.type === 'open') {
    openSession(msg, ws).catch((err) =>
      vscode.window.showErrorMessage(`VCPedia: ${err.message}`)
    );
  } else if (msg.type === 'finish') {
    finishSession(msg).catch(() => {});
  } else if (msg.type === 'locate') {
    locateInEditor(msg).catch(() => {});
  } else if (msg.type === 'save-result') {
    const waiter = saveWaiters.get(msg.sessionId);
    if (waiter) {
      clearTimeout(waiter.timer);
      saveWaiters.delete(msg.sessionId);
      waiter.resolve({ ok: !!msg.ok, error: msg.error });
    }
  }
}

function activate(context) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'vcpediaEditor.status';
  updateStatus();

  const port = config().get('port');
  const allowedOrigin = config().get('allowedOrigin');

  wss = startWsServer({
    port,
    allowedOrigin,
    onMessage: handleMessage,
    onConnection: (ws) => {
      wsSessions.set(ws, new Set());
      ws.on('close', () => {
        const ids = wsSessions.get(ws) || new Set();
        wsSessions.delete(ws);
        for (const sessionId of ids) {
          finishSession({ sessionId, result: 'disconnected' }).catch(() => {});
        }
        updateStatus();
      });
      updateStatus();
    },
    onError: (err) => {
      vscode.window.showErrorMessage(
        `VCPedia: 本地服务启动失败（端口 ${port}）：${err.message}`
      );
    },
  });

  context.subscriptions.push(
    statusBar,
    vscode.commands.registerCommand('vcpediaEditor.push', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('VCPedia: 当前没有打开的文件。');
        return;
      }
      if (!push(editor.document)) {
        vscode.window.showInformationMessage(
          'VCPedia: 当前文件不是编辑会话，或浏览器未连接。'
        );
      }
    }),
    vscode.window.registerUriHandler({
      handleUri() {
        vscode.window.setStatusBarMessage('VCPedia: 已就绪，等待浏览器连接…', 5000);
      },
    }),
    vscode.commands.registerCommand('vcpediaEditor.save', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('VCPedia: 当前没有打开的文件。');
        return;
      }
      const sessionId = byPath.get(editor.document.uri.fsPath);
      if (!sessionId) {
        vscode.window.showInformationMessage('VCPedia: 当前文件不是编辑会话。');
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
        vscode.window.showInformationMessage('VCPedia: 已通过 InPageEdit 保存。');
      } else {
        vscode.window.showErrorMessage(`VCPedia: 保存失败：${result.error}`);
      }
    }),
    vscode.commands.registerCommand('vcpediaEditor.status', () => {
      const connected = wss
        ? [...wss.clients].filter((c) => c.readyState === 1).length
        : 0;
      vscode.window.showInformationMessage(
        `VCPedia: 端口 ${config().get('port')}，${connected} 个浏览器连接，` +
          `${sessions.size} 个活动编辑会话。`
      );
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!byPath.has(doc.uri.fsPath)) return;
      push(doc);
      notifyDirty(doc);
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      const sessionId = byPath.get(event.textEditor.document.uri.fsPath);
      if (!sessionId || !wss) return;
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
          broadcast(wss, {
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
      if (!byPath.has(fsPath)) return;
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
  if (wss) {
    for (const client of wss.clients) client.terminate();
    wss.close();
    wss = null;
  }
}

module.exports = { activate, deactivate };
