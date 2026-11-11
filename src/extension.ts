import * as vscode from 'vscode';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {BrowserBridge} from './browser/bridge';
import type {SocketLike} from './browser/server';
import * as itemsUtil from './editor/items';
import {templateTargetAt} from './editor/templates';
import {registerLanguageFeatures, type LanguageFeatures} from './language/features';
import * as wikis from './wiki/registry';
import {SessionStore} from './sessions/store';
import {SessionManager, type SessionMeta} from './sessions/manager';
import {createSessionController, type SessionController} from './sessions/controller';
import type {BrowserMessage, LocateMessage} from './protocol';

let bridge: BrowserBridge | null = null;
let statusBar: vscode.StatusBarItem | null = null;
let languageFeatures: LanguageFeatures | null = null;
let sessionStore: SessionStore | null = null;
let sessionManager: SessionManager | null = null;
let sessionController: SessionController | null = null;
const dirtyTimers = new Map<string, NodeJS.Timeout>();
const syncTimers = new Map<string, NodeJS.Timeout>();

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('mediawikiEditor');
}

function safeName(title: string): string {
  return title.replace(/[\\/:*?"<>|\r\n]/g, '_');
}

function defaultDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'mediawiki-edit');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'mediawiki-edit');
  }
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'mediawiki-edit');
}

function stamp(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function updateStatus(): void {
  if (!statusBar) return;
  const connected = bridge?.connectionCount || 0;
  statusBar.text = connected
    ? '$(vm-active) MediaWiki: 已连接'
    : '$(vm-outline) MediaWiki: 等待浏览器';
  statusBar.tooltip = '点击查看连接状态';
  statusBar.show();
}

function push(doc: vscode.TextDocument): boolean {
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

function notifyDirty(doc: vscode.TextDocument): void {
  const sessionId = sessionManager?.idForPath(doc.uri.fsPath);
  if (!sessionId || !bridge) return;
  bridge.broadcast({type: 'state', sessionId, dirty: doc.isDirty});
}

function clearDirty(fsPath: string): void {
  const timer = dirtyTimers.get(fsPath);
  if (timer) clearTimeout(timer);
  dirtyTimers.delete(fsPath);
}

function sendFinish(
  meta: SessionMeta,
  sessionId: string,
  result: 'saved' | 'discarded' | 'unchanged' | 'closed',
): void {
  if (!meta.ws) return;
  try {
    meta.ws.send(JSON.stringify({type: 'finish', sessionId, result}));
  } catch {}
}

async function closeEditor(fsPath: string): Promise<void> {
  const tab = vscode.window.tabGroups.all
    .flatMap(group => group.tabs)
    .find(
      item =>
        item.input instanceof vscode.TabInputText &&
        item.input.uri.fsPath === fsPath,
    );
  if (tab) {
    try {
      await vscode.window.tabGroups.close(tab);
    } catch {}
  }
}

async function closeAndDelete(fsPath: string): Promise<void> {
  const doc = vscode.workspace.textDocuments.find(
    document => document.uri.fsPath === fsPath,
  );
  if (doc?.isDirty) {
    try {
      await doc.save();
    } catch {}
  }
  await closeEditor(fsPath);
  try {
    await fs.promises.unlink(fsPath);
  } catch {}
}

let suppressScrollUntil = 0;

function revealLine(editor: vscode.TextEditor, line: number): void {
  const position = new vscode.Position(line, 0);
  suppressScrollUntil = Date.now() + 700;
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(
    new vscode.Range(position, position),
    vscode.TextEditorRevealType.InCenter,
  );
  vscode.window.setStatusBarMessage(`MediaWiki: 定位到第 ${line + 1} 行`, 2000);
}

async function locateInEditor(msg: LocateMessage): Promise<void> {
  if (!msg.text) return;
  const meta = sessionManager?.get(msg.sessionId);
  if (!meta) return;
  const doc = vscode.workspace.textDocuments.find(
    document => document.uri.fsPath === meta.fsPath,
  );
  if (!doc) return;
  const line = itemsUtil.findLineByText(
    doc,
    msg.text,
    languageFeatures?.ast(doc),
    {section: msg.section, occurrence: msg.occurrence},
  );
  if (line < 0) return;
  const editor = await vscode.window.showTextDocument(doc, {preview: false});
  revealLine(editor, line);
}

function handleMessage(
  msg: BrowserMessage,
  ws: SocketLike,
  context: vscode.ExtensionContext,
): void {
  const controller = sessionController;
  if (!controller) return;
  if (msg.type === 'register-wiki') {
    controller.registerWiki(msg, ws).catch(() => {});
  } else if (msg.type === 'session-query') {
    controller.query(msg, ws).catch(() => {});
  } else if (msg.type === 'open') {
    const wiki = wikis.resolve(context, msg.wiki, ws.origin);
    if (!wiki) {
      vscode.window.showWarningMessage(
        `MediaWiki: 未注册的 wiki（${msg.wiki || ws.origin || '未知来源'}）。请确认网页端脚本已更新并刷新页面。`,
      );
      return;
    }
    controller.open(msg, ws, wiki).catch((error: unknown) =>
      vscode.window.showErrorMessage(
        `MediaWiki: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  } else if (msg.type === 'finish') {
    controller.finish(msg).catch(() => {});
  } else if (msg.type === 'save-result' && msg.ok) {
    controller.markSaved(msg.sessionId);
  } else if (msg.type === 'save-result') {
    controller.markSaveFailed(msg.sessionId);
  } else if (msg.type === 'conflict') {
    controller.handleConflict(msg).catch((error: unknown) =>
      vscode.window.showErrorMessage(
        `MediaWiki: 载入冲突失败：${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  } else if (msg.type === 'save-confirmed') {
    controller.confirmSaved(msg, ws).catch(() => {});
  } else if (msg.type === 'locate') {
    locateInEditor(msg).catch(() => {});
  } else if (msg.type === 'request-save') {
    controller.requestSave(msg).catch((error: unknown) =>
      vscode.window.showErrorMessage(
        `MediaWiki: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

function activate(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'mediawikiEditor.status';
  updateStatus();

  const port = config().get<number>('port', 8927);
  const allowedOrigin = config().get<string>('allowedOrigin', '*');

  sessionStore = new SessionStore(
    context.globalStorageUri
      ? path.join(context.globalStorageUri.fsPath, 'sessions.json')
      : undefined,
  );
  sessionManager = new SessionManager(sessionStore, () => updateStatus());
  sessionManager.load();
  sessionController = createSessionController({
    sessionManager,
    getBridge: () => bridge ?? undefined,
    wikis: wikis.wikiRegistry,
    context,
    config,
    defaultDir,
    safeName,
    stamp,
    closeAndDelete,
    updateStatus,
    clearDirty,
    getLanguageFeatures: () => languageFeatures ?? undefined,
  });
  languageFeatures = registerLanguageFeatures(context, {
    navigateEdit: request => sessionController!.navigate(request),
  });

  bridge = new BrowserBridge();
  bridge.start({
    port,
    allowedOrigin,
    onMessage: (msg, ws) => handleMessage(msg, ws, context),
    onConnection: ws => {
      sessionManager?.registerSocket(ws);
      ws.on('close', () => {
        sessionManager?.detachWs(ws);
        updateStatus();
      });
      updateStatus();
    },
    onError: error => {
      vscode.window.showErrorMessage(
        `MediaWiki: 本地服务启动失败（端口 ${port}）：${error.message}`,
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
          'MediaWiki: 当前文件不是编辑会话，或浏览器未连接。',
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
      const result = await sessionController!.saveInPage(
        sessionId,
        editor.document.getText(),
        summary,
        false,
      );
      if (result.ok) {
        await sessionController!.finish({type: 'finish', sessionId, result: 'saved'});
        vscode.window.showInformationMessage(
          'MediaWiki: 已提交，等待浏览器显示新内容后清理临时文件。',
        );
      } else {
        vscode.window.showErrorMessage(`MediaWiki: 保存失败：${result.error}`);
      }
    }),
    vscode.commands.registerCommand('mediawikiEditor.closeSession', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage('MediaWiki: 当前没有打开的文件。');
        return;
      }
      const sessionId = sessionManager?.idForPath(editor.document.uri.fsPath);
      const meta = sessionId ? sessionManager?.get(sessionId) : undefined;
      if (!sessionId || !meta) {
        vscode.window.showInformationMessage('MediaWiki: 当前文件不是编辑会话。');
        return;
      }
      const controller = sessionController!;

      if (meta.awaitingConfirm) {
        meta.closePageOnConfirm = true;
        await closeEditor(meta.fsPath);
        vscode.window.showInformationMessage(
          'MediaWiki: 已提交，等待浏览器确认后关闭页面并清理临时文件。',
        );
        return;
      }

      const doc = editor.document;
      const edited = controller.edited(sessionId, doc.getText()) ?? true;
      if (!edited) {
        sendFinish(meta, sessionId, 'unchanged');
        await controller.finish({type: 'finish', sessionId, result: 'unchanged'});
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        `MediaWiki: ${meta.title} 有未提交的修改，关闭前要保存吗？`,
        {modal: true},
        '保存并关闭',
        '放弃修改',
      );
      if (!choice) return;
      if (choice === '放弃修改') {
        sendFinish(meta, sessionId, 'discarded');
        await controller.finish({type: 'finish', sessionId, result: 'discarded'});
        return;
      }

      const summary = await vscode.window.showInputBox({
        prompt: '编辑摘要',
        value: '[VSCode]',
      });
      if (summary === undefined) return;

      if (!meta.ws) {
        if (doc.isDirty) await doc.save();
        sessionManager?.markDraft(sessionId);
        await closeEditor(meta.fsPath);
        vscode.window.showWarningMessage(
          'MediaWiki: 浏览器未连接，已保存为草稿。',
        );
        return;
      }

      const result = await controller.saveInPage(
        sessionId,
        doc.getText(),
        summary,
        false,
      );
      if (!result.ok) {
        vscode.window.showErrorMessage(`MediaWiki: 保存失败：${result.error}`);
        return;
      }
      meta.closePageOnConfirm = true;
      await controller.finish({type: 'finish', sessionId, result: 'saved'});
      await closeEditor(meta.fsPath);
      vscode.window.showInformationMessage(
        'MediaWiki: 已提交，等待浏览器确认后关闭页面并清理临时文件。',
      );
    }),
    vscode.commands.registerCommand('mediawikiEditor.restoreDraft', () =>
      sessionController!.restoreDraft(),
    ),
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
      const url = sessionController!.pageUrl(meta.wiki, meta.title);
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
        vscode.window.showErrorMessage(
          `MediaWiki: 语言检查失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }),
    vscode.commands.registerCommand('mediawikiEditor.status', () => {
      const connected = bridge?.connectionCount || 0;
      vscode.window.showInformationMessage(
        `MediaWiki: 端口 ${config().get('port')}，${connected} 个浏览器连接，` +
          `${sessionManager?.values().length || 0} 个活动编辑会话。`,
      );
    }),
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (!sessionManager?.idForPath(doc.uri.fsPath)) return;
      push(doc);
      notifyDirty(doc);
    }),
    vscode.workspace.onDidCloseTextDocument(doc => {
      const sessionId = sessionManager?.idForPath(doc.uri.fsPath);
      const meta = sessionId ? sessionManager?.get(sessionId) : undefined;
      if (
        !meta ||
        meta.state === 'draft' ||
        meta.awaitingConfirm ||
        meta.closePageOnConfirm
      ) {
        return;
      }
      const timer = dirtyTimers.get(meta.fsPath);
      if (timer) clearTimeout(timer);
      dirtyTimers.delete(meta.fsPath);
      if (meta.ws) {
        try {
          meta.ws.send(JSON.stringify({type: 'editor-closed', sessionId}));
        } catch {}
      }
      if (sessionId) sessionManager?.markDraft(sessionId);
      vscode.window.showInformationMessage(
        'MediaWiki: 编辑器已关闭，草稿已保留。可运行「MediaWiki: 恢复编辑草稿」。',
      );
    }),
    vscode.window.onDidChangeTextEditorSelection(event => {
      const sessionId = sessionManager?.idForPath(event.textEditor.document.uri.fsPath);
      if (!sessionId || !bridge) return;
      if (Date.now() < suppressScrollUntil) return;
      const line = event.selections[0]?.active.line ?? 0;
      const existing = syncTimers.get(sessionId);
      if (existing) clearTimeout(existing);
      syncTimers.set(
        sessionId,
        setTimeout(() => {
          syncTimers.delete(sessionId);
          const doc = event.textEditor.document;
          const items = itemsUtil.itemsFor(
            doc,
            doc.getText().length <= 300000 ? languageFeatures?.ast(doc) : undefined,
          );
          const offset = doc.offsetAt(
            event.selections[0]?.active || new vscode.Position(line, 0),
          );
          const itemIndex = itemsUtil.itemAt(items, offset);
          const item = itemIndex >= 0 ? items[itemIndex] : undefined;
          const exact = !!item && item.start <= offset && item.end >= offset;
          if (!exact) {
            const target = templateTargetAt(
              doc,
              offset,
              languageFeatures?.ast(doc),
            );
            if (target) {
              bridge?.broadcast({
                type: 'scroll',
                kind: 'template',
                sessionId,
                template: {
                  name: target.name,
                  params: target.params,
                  section: target.section,
                  occurrence: target.occurrence,
                },
              });
              return;
            }
            const section = itemsUtil.templateSectionFor(
              doc,
              offset,
              languageFeatures?.ast(doc),
            );
            if (section !== undefined) {
              bridge?.broadcast({
                type: 'scroll',
                kind: 'section',
                sessionId,
                section,
              });
              return;
            }
          }
          if (!item) return;
          const template = templateTargetAt(
            doc,
            offset,
            languageFeatures?.ast(doc),
          );
          bridge?.broadcast({
            type: 'scroll',
            kind: 'text',
            sessionId,
            text: item.text,
            occurrence: item.sectionOccurrence,
            section: item.section,
            scope: item.scope,
            label: item.label,
            labelOccurrence: item.labelOccurrence,
            prev: item.prev,
            next: item.next,
            template: template
              ? {
                  name: template.name,
                  params: template.params,
                  section: template.section,
                  occurrence: template.occurrence,
                }
              : undefined,
          });
        }, 200),
      );
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      const fsPath = event.document.uri.fsPath;
      if (!sessionManager?.idForPath(fsPath)) return;
      const existing = dirtyTimers.get(fsPath);
      if (existing) clearTimeout(existing);
      dirtyTimers.set(
        fsPath,
        setTimeout(() => {
          dirtyTimers.delete(fsPath);
          notifyDirty(event.document);
        }, 120),
      );
    }),
  );
}

function deactivate(): void {
  sessionManager?.persist();
  languageFeatures?.dispose();
  languageFeatures = null;
  bridge?.stop();
  bridge = null;
}

export {activate, deactivate};
