import {test} from 'node:test';
import assert from 'node:assert/strict';
import Module, {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const vscodeMock = {
  l10n: {t: message => message},
};
const loadModule = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return loadModule.call(this, request, parent, isMain);
};
const {markConflict} = require('../out/sessions/conflict.js');

test('conflict markers keep common prefix and suffix outside the block', () => {
  const local = ['首行', '本地一', '本地二', '尾行'].join('\n');
  const remote = ['首行', '远端一', '尾行'].join('\n');
  assert.equal(
    markConflict(local, remote, '站点最新版本（rev 9）'),
    [
      '首行',
      '<<<<<<< VSCode local version',
      '本地一',
      '本地二',
      '=======',
      '远端一',
      '>>>>>>> 站点最新版本（rev 9）',
      '尾行',
    ].join('\n'),
  );
});

test('identical texts do not create markers', () => {
  assert.equal(markConflict('same\n', 'same\n', '远端'), 'same\n');
});

test('no common lines marks the whole file', () => {
  const marked = markConflict('local', 'remote', '远端');
  assert.match(marked, /^<<<<<<< VSCode local version\nlocal\n=======\nremote\n>>>>>>> 远端$/);
});
