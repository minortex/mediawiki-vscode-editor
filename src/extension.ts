'use strict';

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { BrowserBridge } = require('./browser-bridge');
const itemsUtil = require('./items');
const language = require('./language');
const wikis = require('./wikis');
const { SessionStore } = require('./session-store');
const { SessionManager } = require('./session-manager');
const { createSessionController } = require('./session-controller');

let bridge: any = null;
let statusBar: any = null;
let languageFeatures: any = null;
let sessionStore: any = null;
let sessionManager: any = null;
let sessionController: any = null;
const dirtyTimers = new Map(); // fsPath -> timeout
const syncTimers = new Map(); // sessionId -> timeout

// 只有这些结果代表用户在页面上明确确认过，才允许删除临时文件
const DELETE_RESULTS = new Set(['saved', 'unchanged', 'discarded']);

function config() {
  return vscode.workspace.getConfiguration('mediawikiEditor');
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

function clearDirty(fsPath) {
  clearTimeout(dirtyTimers.get(fsPath));
  dirtyTimers.delete(fsPath);
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
  const line = itemsUtil.findLineByText(doc, msg.text);
  if (line < 0) return;
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  revealLine(editor, line);
}

function handleMessage(msg, ws, context) {
  if (msg.type === 'register-wiki') {
    sessionController.registerWiki(msg, ws).catch(() => {});
  } else if (msg.type === 'session-query') {
    sessionController.query(msg, ws).catch(() => {});
  } else if (msg.type === 'open') {
    const wiki = wikis.resolve(context, msg.wiki, ws.origin);
    if (!wiki) {
      vscode.window.showWarningMessage(
        `MediaWiki: 未注册的 wiki（${msg.wiki || ws.origin || '未知来源'}）。请确认网页端脚本已更新并刷新页面。`
      );
      return;
    }
    sessionController.open(msg, ws, wiki).catch((err) =>
      vscode.window.showErrorMessage(`MediaWiki: ${err.message}`)
    );
  } else if (msg.type === 'finish') {
    sessionController.finish(msg).catch(() => {});
  } else if (msg.type === 'locate') {
    locateInEditor(msg).catch(() => {});
  } else if (msg.type === 'request-save') {
    sessionController.requestSave(msg).catch((err) =>
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
  sessionController = createSessionController({
    vscode,
    fs,
    path,
    sessionManager,
    getBridge: () => bridge,
    wikis,
    context,
    config,
    defaultDir,
    safeName,
    stamp,
    closeAndDelete,
    updateStatus,
    clearDirty,
    getLanguageFeatures: () => languageFeatures,
  });
  languageFeatures = language.registerLanguageFeatures(context, {
    navigateEdit: (request) => sessionController.navigate(request),
  });

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
      const result = await sessionController.saveInPage(sessionId, editor.document.getText(), summary, false);
      if (result.ok) {
        await sessionController.finish({ sessionId, result: 'saved' });
        vscode.window.showInformationMessage('MediaWiki: 已通过 InPageEdit 保存。');
      } else {
        vscode.window.showErrorMessage(`MediaWiki: 保存失败：${result.error}`);
      }
    }),
    vscode.commands.registerCommand('mediawikiEditor.restoreDraft', () => sessionController.restoreDraft()),
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
      const url = sessionController.pageUrl(meta.wiki, meta.title);
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
          const items = itemsUtil.itemsFor(doc);
          const offset = doc.offsetAt(
            event.selections[0]?.active || new vscode.Position(line, 0)
          );
          const itemIndex = itemsUtil.itemAt(items, offset);
          if (itemIndex < 0) return; // no candidate: keep the last preview position
          const item = items[itemIndex];
          bridge?.broadcast({
            type: 'scroll',
            sessionId,
            text: item.text,
            occurrence: itemsUtil.occurrenceOf(items, itemIndex),
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
