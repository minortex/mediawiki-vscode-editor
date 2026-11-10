import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const itemsUtil = require('../out/editor/items.js');
const {buildAstIndex, nodeAtOffset} = require('../out/editor/ast-index.js');
const Parser = require('wikiparser-node');

function document(text) {
  const lines = text.split('\n');
  const offsets = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  return {
    uri: {fsPath: `/tmp/ast-index-${Math.random()}.wiki`},
    version: 1,
    getText: () => text,
    positionAt(value) {
      let line = 0;
      while (line + 1 < offsets.length && offsets[line + 1] <= value) line++;
      return {line};
    },
    lineCount: lines.length,
    lineAt(line) {
      return {text: lines[line]};
    },
  };
}

const text = [
  '== 标题 ==',
  '{{Songbox',
  '|演唱 = 诗岸',
  '|作词 = 诗岸',
  '}}',
  '正文第一次提到诗岸。',
  '=== 另一节 ===',
  '正文第二次提到诗岸。',
].join('\n');

test('AST index exposes node ranges and deep nodes', () => {
  const root = Parser.parse(text);
  const index = buildAstIndex(root);
  assert.ok(index.nodes.length > 5);
  assert.ok(index.nodes.some(node => node.type === 'template-name'));
  assert.ok(index.nodes.some(node => node.type === 'parameter-key'));
  const offset = text.indexOf('诗岸');
  const node = nodeAtOffset(index, offset);
  assert.ok(node);
  assert.equal(node.type, 'text');
  assert.ok(node.start <= offset && node.end > offset);
});

test('strict reverse lookup uses only index items, never line fallback', () => {
  const doc = document(text);
  const line = itemsUtil.findLineByText(doc, '第二次提到诗岸', undefined, {fallback: false});
  assert.equal(line, 7);
  assert.equal(
    itemsUtil.findLineByText(doc, '页面中不存在的文本', undefined, {fallback: false}),
    -1,
  );
  assert.equal(
    itemsUtil.findLineByText(doc, '正文第二次提到诗岸。', undefined, {fallback: true}),
    7,
  );
});
