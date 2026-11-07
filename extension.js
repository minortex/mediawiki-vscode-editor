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
const pendingDelete = new Set(); // fsPath awaiting a successful close
const wsSessions = new Map(); // ws -> Set<sessionId>

function config() {
  return vscode.workspace.getConfiguration('vcpediaEditor');
}

function safeName(title) {
  return title.replace(/[\\/:*?"<>|\r\n]/g, '_');
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

async function removeFile(fsPath) {
  pendingDelete.delete(fsPath);
  try {
    await fs.promises.unlink(fsPath);
  } catch {}
}

/**
 * Close the editor for this session. If the buffer has unsaved changes VSCode
 * shows its own save prompt; the temporary file is removed only after the
 * document really closes.
 */
async function closeDocAndFile(fsPath) {
  pendingDelete.add(fsPath);
  try {
    const tab = vscode.window.tabGroups?.all
      ?.flatMap((group) => group.tabs)
      .find((t) => t.input?.uri?.fsPath === fsPath);
    if (tab) {
      const closed = await vscode.window.tabGroups.close(tab);
      if (closed === false) return; // user kept it open in the save prompt
      await removeFile(fsPath);
      return;
    }
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
    if (!doc) {
      await removeFile(fsPath);
      return;
    }
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  } catch {
    // fall back to onDidCloseTextDocument, which still holds pendingDelete
  }
}

async function openSession(msg, ws) {
  const dir = config().get('tempDir') || path.join(os.tmpdir(), 'vcpedia-edit');
  await fs.promises.mkdir(dir, { recursive: true });
  const suffix = msg.section != null ? `.s${msg.section}` : '';
  const fsPath = path.join(dir, `${safeName(msg.title)}${suffix}.wiki`);

  let doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
  if (doc && doc.isDirty) {
    vscode.window.showWarningMessage(
      `VCPedia: ${path.basename(fsPath)} 还有未保存修改，未覆盖。先保存或关闭它再重新发起编辑。`
    );
    await vscode.window.showTextDocument(doc, { preview: false });
    return;
  }

  const previous = byPath.get(fsPath);
  if (previous) {
    await finishSession({ sessionId: previous, result: 'replaced' });
  }
  if (doc) {
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    doc = undefined;
  }

  await fs.promises.writeFile(fsPath, msg.text, 'utf8');
  doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
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
  sessions.delete(msg.sessionId);
  if (!meta) return;
  byPath.delete(meta.fsPath);
  wsSessions.get(meta.ws)?.delete(msg.sessionId);
  await closeDocAndFile(meta.fsPath);
  vscode.window.setStatusBarMessage(
    msg.result === 'saved'
      ? 'VCPedia: 已在浏览器提交保存'
      : 'VCPedia: 编辑会话已结束',
    5000
  );
}

function handleMessage(msg, ws) {
  if (msg.type === 'open') {
    openSession(msg, ws).catch((err) =>
      vscode.window.showErrorMessage(`VCPedia: ${err.message}`)
    );
  } else if (msg.type === 'finish') {
    finishSession(msg).catch(() => {});
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
          finishSession({ sessionId, result: 'closed' }).catch(() => {});
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
      if (byPath.has(doc.uri.fsPath)) push(doc);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (pendingDelete.has(doc.uri.fsPath)) removeFile(doc.uri.fsPath);
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
