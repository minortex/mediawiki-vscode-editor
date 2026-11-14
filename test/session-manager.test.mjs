import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {SessionStore} = require('../out/sessions/store.js');
const {SessionManager} = require('../out/sessions/manager.js');

test('session manager persists, detaches, drafts and restores', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-manager-'));
  const file = path.join(dir, 'sessions.json');
  const temp = path.join(dir, 'page.wiki');
  fs.writeFileSync(temp, 'text');
  const store = new SessionStore(file);
  const manager = new SessionManager(store);
  const ws = {send() {}};

  manager.add('s1', {
    fsPath: temp,
    ws,
    title: 'Page',
    section: null,
    wiki: {id: 'example.org', name: 'Example', origin: 'https://example.org'},
    created: 1,
    state: 'attached',
    autoRestore: true,
  });
  assert.equal(manager.get('s1')?.state, 'attached');
  assert.equal(manager.idForPath(temp), 's1');

  manager.detachWs(ws);
  assert.equal(manager.get('s1')?.state, 'detached');
  assert.equal(manager.get('s1')?.ws, null);

  manager.markDraft('s1', false);
  assert.equal(manager.get('s1')?.state, 'draft');
  assert.equal(manager.drafts().length, 1);

  await manager.flush();
  const reloaded = new SessionManager(new SessionStore(file));
  reloaded.load();
  assert.equal(reloaded.get('s1')?.state, 'draft');
  assert.equal(reloaded.get('s1')?.autoRestore, false);
  assert.equal(reloaded.idForPath(temp), 's1');

  reloaded.remove('s1');
  assert.equal(reloaded.get('s1'), undefined);
  assert.equal(reloaded.idForPath(temp), undefined);
});

test('a restored draft becomes detached, a closed draft stays', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-manager-restored-'));
  const file = path.join(dir, 'sessions.json');
  const manager = new SessionManager(new SessionStore(file));
  const base = {
    ws: null,
    title: 'Page',
    section: null,
    wiki: {id: 'example.org', name: 'Example', origin: 'https://example.org'},
    created: 1,
    state: 'draft',
  };
  manager.add('kill', {...base, fsPath: path.join(dir, 'kill.wiki'), autoRestore: true});
  manager.add('closed', {...base, fsPath: path.join(dir, 'closed.wiki'), autoRestore: false});

  manager.markRestored('kill');
  assert.equal(manager.get('kill')?.state, 'detached');
  manager.markRestored('closed');
  assert.equal(manager.get('closed')?.state, 'draft');

  // An active session is left alone.
  manager.add('attached', {...base, fsPath: path.join(dir, 'attached.wiki'), autoRestore: true, state: 'attached'});
  manager.markRestored('attached');
  assert.equal(manager.get('attached')?.state, 'attached');
  fs.rmSync(dir, {recursive: true, force: true});
});

test('a pending save confirmation becomes a restorable draft after a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-manager-awaiting-'));
  const file = path.join(dir, 'sessions.json');
  const temp = path.join(dir, 'page.wiki');
  fs.writeFileSync(temp, 'text');
  const manager = new SessionManager(new SessionStore(file));
  manager.add('s1', {
    fsPath: temp,
    ws: null,
    title: 'Page',
    section: null,
    wiki: {id: 'example.org', name: 'Example', origin: 'https://example.org'},
    created: 1,
    state: 'attached',
    autoRestore: true,
  });
  manager.markAwaitingConfirm('s1');
  assert.equal(manager.drafts().length, 0);
  await manager.flush();

  const reloaded = new SessionManager(new SessionStore(file));
  reloaded.load();
  assert.equal(reloaded.get('s1')?.state, 'draft');
  assert.equal(reloaded.get('s1')?.awaitingConfirm, false);
  assert.equal(reloaded.drafts().length, 1);

  reloaded.remove('s1');
  fs.rmSync(dir, {recursive: true, force: true});
});

test('loading drops sessions whose temp file is gone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-manager-missing-'));
  const file = path.join(dir, 'sessions.json');
  const existing = path.join(dir, 'keep.wiki');
  fs.writeFileSync(existing, 'text');
  const base = {
    title: 'Page',
    section: null,
    wiki: {id: 'example.org', name: 'Example', origin: 'https://example.org'},
    created: 1,
    state: 'draft',
    autoRestore: true,
  };
  fs.writeFileSync(
    file,
    JSON.stringify([
      {sessionId: 'keep', fsPath: existing, ...base},
      {sessionId: 'gone', fsPath: path.join(dir, 'gone.wiki'), ...base},
    ]),
  );
  assert.deepEqual(
    new SessionStore(file).load().map(entry => entry.sessionId),
    ['keep'],
  );
  fs.rmSync(dir, {recursive: true, force: true});
});

test('closePageOnConfirm survives a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-manager-confirm-'));
  const file = path.join(dir, 'sessions.json');
  const temp = path.join(dir, 'page.wiki');
  fs.writeFileSync(temp, 'text');
  const manager = new SessionManager(new SessionStore(file));
  manager.add('s1', {
    fsPath: temp,
    ws: null,
    title: 'Page',
    section: null,
    wiki: {id: 'example.org', name: 'Example', origin: 'https://example.org'},
    created: 1,
    state: 'attached',
    autoRestore: true,
  });
  manager.get('s1').closePageOnConfirm = true;
  manager.markAwaitingConfirm('s1');
  await manager.flush();

  const reloaded = new SessionManager(new SessionStore(file));
  reloaded.load();
  assert.equal(reloaded.get('s1')?.closePageOnConfirm, true);
  assert.equal(reloaded.get('s1')?.state, 'draft');
  assert.equal(reloaded.get('s1')?.awaitingConfirm, false);
  fs.rmSync(dir, {recursive: true, force: true});
});
