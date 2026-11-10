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
