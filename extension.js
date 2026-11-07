'use strict';

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { startWsServer, broadcast } = require('./lib/ws-server');

let wss = null;
let statusBar = null;
const byPath = new Map(); // fsPath -> { sessionId, title, section }

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
  const session = byPath.get(doc.uri.fsPath);
  if (!session || !wss) return false;
  const count = broadcast(wss, {
    type: 'update',
    sessionId: session.sessionId,
    text: doc.getText(),
  });
  if (count > 0) {
    vscode.window.setStatusBarMessage('VCPedia: 已把保存内容推送到浏览器预览', 5000);
  }
  return count > 0;
}

async function openSession(msg) {
  const dir = config().get('tempDir') || path.join(os.tmpdir(), 'vcpedia-edit');
  await fs.promises.mkdir(dir, { recursive: true });
  const suffix = msg.section != null ? `.s${msg.section}` : '';
  const fsPath = path.join(dir, `${safeName(msg.title)}${suffix}.wiki`);
  const uri = vscode.Uri.file(fsPath);

  let doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
  if (doc && doc.isDirty) {
    vscode.window.showWarningMessage(
      `VCPedia: ${path.basename(fsPath)} 还有未保存修改，未覆盖。先保存或关闭它再重新发起编辑。`
    );
    await vscode.window.showTextDocument(doc, { preview: false });
    return;
  }
  if (doc) {
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    doc = undefined;
  }

  await fs.promises.writeFile(fsPath, msg.text, 'utf8');
  doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });

  byPath.set(fsPath, {
    sessionId: msg.sessionId,
    title: msg.title,
    section: msg.section,
  });

  const label = msg.section != null ? `${msg.title} § ${msg.section}` : msg.title;
  vscode.window.setStatusBarMessage(
    `VCPedia: 正在编辑 ${label}，保存文件即刷新浏览器预览`,
    8000
  );
  push(doc);
}

function finishSession(msg) {
  for (const [fsPath, session] of byPath) {
    if (session.sessionId === msg.sessionId) byPath.delete(fsPath);
  }
  vscode.window.setStatusBarMessage(
    msg.result === 'saved' ? 'VCPedia: 已在浏览器提交保存' : 'VCPedia: 已取消编辑',
    6000
  );
}

function handleMessage(msg, ws) {
  if (msg.type === 'open') {
    openSession(msg).catch((err) =>
      vscode.window.showErrorMessage(`VCPedia: ${err.message}`)
    );
  } else if (msg.type === 'finish') {
    finishSession(msg);
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
      ws.on('close', updateStatus);
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
          `${byPath.size} 个活动编辑会话。`
      );
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (byPath.has(doc.uri.fsPath)) push(doc);
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
