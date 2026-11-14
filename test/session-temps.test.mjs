import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {removeOrphanTemps} = require('../out/sessions/temps.js');

const OLD = new Date('2026-01-01T00:00:00Z');

function makeTemp(root, host, name, mtime) {
  const dir = path.join(root, host);
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'text');
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

test('orphan temp cleanup keeps referenced files and recent writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mwe-temps-'));
  const orphan = makeTemp(root, 'wiki.example', 'Page.20260101-120000.wiki', OLD);
  const kept = makeTemp(root, 'wiki.example', 'Keep.20260101-120000.wiki', OLD);
  const fresh = makeTemp(root, 'wiki.example', 'Fresh.20260101-120000.wiki', new Date());
  const other = makeTemp(root, 'wiki.example', 'notes.txt', OLD);

  const removed = await removeOrphanTemps(root, [kept]);

  assert.deepEqual(removed, [orphan]);
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(kept), true);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(other), true);
  fs.rmSync(root, {recursive: true, force: true});
});
