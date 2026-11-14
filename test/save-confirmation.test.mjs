import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import Module, {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
class WorkspaceEdit {
  replace(uri, range, text) {
    this.uri = uri;
    this.range = range;
    this.text = text;
  }
}
class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}
const vscodeMock = {
  workspace: {textDocuments: [], applyEdit: async () => true},
  l10n: {t: (message, ...args) =>
    message.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')},
  window: {
    setStatusBarMessage() {},
    showWarningMessage() {},
    showInformationMessage() {},
    showErrorMessage() {},
    showTextDocument: async () => undefined,
  },
  WorkspaceEdit,
  Range,
};
const loadModule = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return loadModule.call(this, request, parent, isMain);
};
const {SessionManager} = require('../out/sessions/manager.js');
const {SessionStore} = require('../out/sessions/store.js');
const {createSessionController} = require('../out/sessions/controller.js');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwe-save-confirm-'));
  const fsPath = path.join(dir, 'page.wiki');
  fs.writeFileSync(fsPath, 'old', 'utf8');
  const manager = new SessionManager(new SessionStore(undefined));
  manager.add('s1', {
    fsPath,
    sockets: new Set(),
    title: 'Page',
    section: null,
    wiki: {id: 'w', name: 'Wiki', origin: 'https://example.org'},
    created: 1,
    state: 'attached',
    autoRestore: true,
  });
  const deleted = [];
  const messages = [];
  const vscode = vscodeMock;
  vscode.workspace.textDocuments = [];
  const controller = createSessionController({
    vscode,
    fs,
    path,
    sessionManager: manager,
    getBridge: () => null,
    wikis: {},
    context: {},
    config: () => ({get: () => undefined}),
    defaultDir: () => dir,
    safeName: value => value,
    stamp: () => 'now',
    closeAndDelete: async value => {
      deleted.push(value);
      fs.rmSync(value, {force: true});
    },
    updateStatus() {},
    clearDirty() {},
    getLanguageFeatures: () => undefined,
  });
  const ws = {
    origin: 'https://example.org',
    send(value) {
      messages.push(JSON.parse(value));
    },
  };
  return {dir, fsPath, manager, controller, deleted, messages, vscode, ws};
}

test('saved finish keeps the temp file until the browser confirms the new page', async () => {
  const {dir, fsPath, manager, controller, deleted, ws, messages} = fixture();
  await controller.finish({sessionId: 's1', result: 'saved'});
  assert.equal(fs.existsSync(fsPath), true);
  assert.ok(manager.get('s1'));
  assert.deepEqual(deleted, []);

  await controller.query(
    {requestId: 'q1', origin: 'https://example.org', title: 'Page'},
    ws
  );
  assert.equal(messages.at(-1).type, 'session-result');
  assert.equal(messages.at(-1).session, null);

  await controller.confirmSaved(
    {sessionId: 's1', origin: 'https://example.org', revid: 42},
    ws
  );
  assert.equal(fs.existsSync(fsPath), false);
  assert.equal(manager.get('s1'), undefined);
  assert.deepEqual(deleted, [fsPath]);
  assert.deepEqual(messages.at(-1), {type: 'save-confirmed-result', sessionId: 's1', ok: true});
  fs.rmSync(dir, {recursive: true, force: true});
});

test('edited compares the current text with the original page hash', () => {
  const {dir, manager, controller} = fixture();
  manager.get('s1').originalHash = createHash('sha256').update('old').digest('hex');
  assert.equal(controller.edited('s1', 'old'), false);
  assert.equal(controller.edited('s1', 'new'), true);
  manager.get('s1').originalHash = undefined;
  assert.equal(controller.edited('s1', 'new'), undefined);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('confirmation sends finish when the page should close', async () => {
  const {dir, fsPath, manager, controller, ws, messages} = fixture();
  manager.attach('s1', ws);
  manager.get('s1').closePageOnConfirm = true;
  await controller.finish({sessionId: 's1', result: 'saved'});
  await controller.confirmSaved(
    {sessionId: 's1', origin: 'https://example.org', revid: 42},
    ws
  );
  assert.equal(fs.existsSync(fsPath), false);
  assert.ok(
    messages.some(message => message.type === 'finish' && message.result === 'saved'),
  );
  fs.rmSync(dir, {recursive: true, force: true});
});

test('a confirmation without a revision id keeps the temp file', async () => {
  const {dir, fsPath, manager, controller, deleted, ws, messages} = fixture();
  await controller.finish({sessionId: 's1', result: 'saved'});
  await controller.confirmSaved({sessionId: 's1', origin: 'https://example.org'}, ws);
  assert.equal(fs.existsSync(fsPath), true);
  assert.ok(manager.get('s1'));
  assert.deepEqual(deleted, []);
  assert.deepEqual(messages.at(-1), {
    type: 'save-confirmed-result',
    sessionId: 's1',
    ok: false,
    error: 'The confirmation carried no revision id; the temp file was kept',
  });
  fs.rmSync(dir, {recursive: true, force: true});
});

test('discard and unchanged still remove the temp file immediately', async () => {
  const {dir, fsPath, manager, controller, deleted} = fixture();
  await controller.finish({sessionId: 's1', result: 'discarded'});
  assert.equal(fs.existsSync(fsPath), false);
  assert.equal(manager.get('s1'), undefined);
  assert.deepEqual(deleted, [fsPath]);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('post-save local edits keep the file as a draft even after confirmation', async () => {
  const {dir, fsPath, manager, controller, deleted, vscode, ws} = fixture();
  await controller.finish({sessionId: 's1', result: 'saved'});
  vscode.workspace.textDocuments.push({uri: {fsPath}, isDirty: true});
  await controller.confirmSaved(
    {sessionId: 's1', origin: 'https://example.org', revid: 42},
    ws
  );
  assert.equal(fs.existsSync(fsPath), true);
  assert.equal(manager.get('s1')?.state, 'draft');
  assert.deepEqual(deleted, []);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('a failed save keeps the temp file as a draft when the session closes', async () => {
  const {dir, fsPath, manager, controller, deleted} = fixture();
  controller.markSaveFailed('s1');
  await controller.finish({sessionId: 's1', result: 'discarded'});
  assert.equal(fs.existsSync(fsPath), true);
  assert.equal(manager.get('s1')?.state, 'draft');
  assert.deepEqual(deleted, []);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('an edit conflict writes git-style markers into the open document', async () => {
  const {dir, fsPath, manager, controller, vscode} = fixture();
  const text = '首行\n本地内容\n尾行\n';
  let applied;
  vscode.workspace.textDocuments = [
    {
      uri: {fsPath},
      getText: () => text,
      positionAt: offset => ({offset}),
    },
  ];
  vscode.workspace.applyEdit = async edit => {
    applied = edit;
    return true;
  };
  await controller.handleConflict({
    type: 'conflict',
    sessionId: 's1',
    remoteText: '首行\n远端内容\n尾行\n',
    remoteRevid: 42,
    remoteTimestamp: '2026-11-10T00:00:00Z',
  });
  assert.ok(applied);
  assert.match(applied.text, /<<<<<<< VSCode local version/);
  assert.match(applied.text, /=======/);
  assert.match(applied.text, />>>>>>> Site latest revision \(rev 42\)/);
  assert.match(applied.text, /本地内容/);
  assert.match(applied.text, /远端内容/);
  assert.equal(manager.get('s1')?.revid, 42);
  assert.equal(manager.get('s1')?.basetimestamp, '2026-11-10T00:00:00Z');
  fs.rmSync(dir, {recursive: true, force: true});
});

test('multiple browser tabs share one editing session', async () => {
  const {dir, manager, controller, messages, ws: owner} = fixture();
  manager.attach('s1', owner);
  manager.get('s1').windowId = 'window-owner';
  await controller.query(
    {
      requestId: 'q1',
      origin: 'https://example.org',
      title: 'Page',
      windowId: 'window-owner',
    },
    owner,
  );
  assert.equal(messages.at(-1).session.sessionId, 's1');

  const second = {
    origin: 'https://example.org',
    messages: [],
    send(value) {
      this.messages.push(JSON.parse(value));
    },
  };
  await controller.query(
    {
      requestId: 'q2',
      origin: 'https://example.org',
      title: 'Page',
      windowId: 'window-second',
    },
    second,
  );
  assert.equal(second.messages.at(-1).busy, undefined);
  assert.equal(second.messages.at(-1).session.sessionId, 's1');
  assert.deepEqual([...manager.get('s1')?.sockets], [owner, second]);
  assert.equal(
    messages.some(message => message.type === 'preempted'),
    false,
  );
  assert.equal(manager.get('s1')?.state, 'attached');

  manager.detachWs(owner);
  assert.equal(manager.get('s1')?.state, 'attached');
  assert.equal(manager.get('s1')?.sockets.has(second), true);

  manager.detachWs(second);
  assert.equal(manager.get('s1')?.state, 'detached');
  assert.equal(manager.get('s1')?.sockets.size, 0);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('a finished session notifies every attached tab', async () => {
  const {dir, manager, controller, messages, ws: owner} = fixture();
  manager.attach('s1', owner);
  const second = {
    origin: 'https://example.org',
    messages: [],
    send(value) {
      this.messages.push(JSON.parse(value));
    },
  };
  manager.attach('s1', second);
  await controller.finish({sessionId: 's1', result: 'unchanged'});
  const finish = {type: 'finish', sessionId: 's1', result: 'unchanged'};
  assert.deepEqual(messages.at(-1), finish);
  assert.deepEqual(second.messages.at(-1), finish);
  assert.equal(manager.get('s1'), undefined);
  fs.rmSync(dir, {recursive: true, force: true});
});
