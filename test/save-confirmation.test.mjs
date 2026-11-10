import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const vscodeMock = {
  workspace: {textDocuments: []},
  window: {
    setStatusBarMessage() {},
    showWarningMessage() {},
    showErrorMessage() {},
  },
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
    ws: null,
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

  await controller.confirmSaved({sessionId: 's1', origin: 'https://example.org'}, ws);
  assert.equal(fs.existsSync(fsPath), false);
  assert.equal(manager.get('s1'), undefined);
  assert.deepEqual(deleted, [fsPath]);
  assert.deepEqual(messages.at(-1), {type: 'save-confirmed-result', sessionId: 's1', ok: true});
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
  await controller.confirmSaved({sessionId: 's1', origin: 'https://example.org'}, ws);
  assert.equal(fs.existsSync(fsPath), true);
  assert.equal(manager.get('s1')?.state, 'draft');
  assert.deepEqual(deleted, []);
  fs.rmSync(dir, {recursive: true, force: true});
});
