import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {functionSnippet} = require('../out/language/function-snippets.js');
const defaultConfig = require('wikiparser-node/config/default.json');
const config = {parserFunction: defaultConfig.parserFunction};

test('builds a snippet for #if', () => {
  assert.equal(
    functionSnippet('#if', config),
    '#if:${1:test string}|${2:value if test string is not empty}|${3:value if test string is empty or only white space}',
  );
});

test('builds a multi-line switch skeleton', () => {
  assert.equal(
    functionSnippet('#switch', config),
    '#switch:${1:comparison string}\n|${2:case}=${3:result}\n|#default=${4:默认}\n',
  );
});

test('builds a snippet for #invoke', () => {
  assert.equal(
    functionSnippet('#invoke', config),
    '#invoke:${1:module name}|${2:function name}|${3:args}',
  );
});

test('resolves localized aliases through the site config', () => {
  assert.equal(
    functionSnippet('#如果', config),
    '#如果:${1:test string}|${2:value if test string is not empty}|${3:value if test string is empty or only white space}',
  );
});

test('preserves a full-width colon', () => {
  assert.equal(functionSnippet('#expr', config, '：'), '#expr：${1:expression}');
});

test('unsupported or empty signatures stay name-only', () => {
  assert.equal(functionSnippet('#unknown', config), undefined);
  assert.equal(functionSnippet('#language', config), undefined);
});

test('uses the first signature when several are available', () => {
  assert.equal(functionSnippet('#time', config), '#time:${1:format string}');
});
