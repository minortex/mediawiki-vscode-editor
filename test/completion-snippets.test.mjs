import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {snippetsAt} = require('../out/language/snippets.js');

const env = {
  tags: ['ref', 'div', 'span'],
  voidTags: ['references', 'br'],
  redirection: ['#redirect', '#重定向'],
};

const match = (text, after = '', environment = env) =>
  snippetsAt(text, text.length, after, environment);

test('a single apostrophe offers all quote styles', () => {
  const result = match("'");
  assert.equal(result.id, 'quote-single');
  assert.deepEqual([result.start, result.end], [0, 1]);
  assert.deepEqual(
    result.items.map(item => item.label),
    ['粗体', '斜体', '粗斜体'],
  );
  assert.equal(result.items[0].body, "'''${1:文字}'''");
  assert.equal(result.items[0].preselect, true);
  assert.equal(result.items[1].body, "''${1:文字}''");
  assert.equal(result.items[2].body, "'''''${1:文字}'''''");
});

test('quotes become paired snippets', () => {
  const italic = match("''");
  assert.equal(italic.id, 'quote-italic');
  assert.deepEqual([italic.start, italic.end], [0, 2]);
  assert.equal(italic.items[0].body, "''${1:文字}''");
  assert.equal(italic.items[0].preselect, true);

  const bold = match("'''");
  assert.equal(bold.id, 'quote-bold');
  assert.equal(bold.items[0].body, "'''${1:文字}'''");

  const both = match("'''''");
  assert.equal(both.id, 'quote-both');
  assert.equal(both.items[0].body, "'''''${1:文字}'''''");

  assert.equal(match("''''''"), undefined);
});

test('quote snippets work mid-line', () => {
  const result = match("前文''");
  assert.equal(result.id, 'quote-italic');
  assert.deepEqual([result.start, result.end], [2, 4]);
});

test('headings offer levels and preselect the typed one', () => {
  const result = match('==');
  assert.equal(result.id, 'heading');
  assert.deepEqual([result.start, result.end], [0, 2]);
  assert.equal(result.items.length, 6);
  const level2 = result.items.find(item => item.label === 'H2 标题');
  assert.equal(level2.body, '== ${1:标题} ==');
  assert.equal(level2.preselect, true);
  assert.equal(
    result.items.filter(item => item.preselect).length,
    1,
  );

  const indented = match('  =');
  assert.equal(indented.id, 'heading');
  assert.equal(indented.start, 2);
});

test('signatures replace three or four tildes', () => {
  const result = match('~~~');
  assert.equal(result.id, 'signature');
  assert.equal(result.items[0].body, '~~~~');
  assert.equal(result.items[0].preselect, true);
  assert.equal(result.items[1].body, '~~~~~');
  assert.equal(match('~~~~~'), undefined);
});

test('redirect keywords are recognized case-insensitively', () => {
  const result = match('#REDIRECT');
  assert.equal(result.id, 'redirect');
  assert.equal(result.items[0].body, '#REDIRECT [[${1:页面名}]]');
  assert.deepEqual([result.start, result.end], [0, 9]);

  const localized = match('  #重定向');
  assert.equal(localized.id, 'redirect');
  assert.equal(localized.start, 2);

  assert.equal(match('#redir'), undefined);
});

test('known tags become paired snippets', () => {
  const ref = match('<ref');
  assert.equal(ref.id, 'tag');
  assert.equal(ref.items[0].label, '<ref name="…">…</ref>');
  assert.equal(ref.items[0].body, '<ref name="${1:名称}">${2:内容}</ref>');

  const br = match('<br');
  assert.equal(br.items[0].body, '<br/>');

  const references = match('<references');
  assert.equal(references.items[0].body, '<references/>');

  assert.equal(match('<unknown'), undefined);
});

test('openers only complete when the closer is missing', () => {
  assert.equal(match('[[', ']]'), undefined);
  assert.equal(match('[[', '').items[0].body, '[[${1:页面名}]]');

  assert.equal(match('{{', '}}'), undefined);
  assert.equal(match('{{', '').items[0].body, '{{${1:模板名}}}');

  assert.equal(match('{{{', '}}}'), undefined);
  assert.equal(match('{{{', '').items[0].body, '{{{${1:参数名}}}}}');

  assert.equal(match('<!--', '-->'), undefined);
  assert.equal(match('<!--', '').items[0].body, '<!-- ${1:注释} -->');

  assert.equal(match('-{', '}-'), undefined);
  assert.equal(match('-{', '').items[0].body, '-{${1:文本}}-');
});

test('table skeleton needs an unclosed table start', () => {
  assert.equal(match('{|', '|}'), undefined);
  const result = match('{|', '');
  assert.equal(result.id, 'table');
  assert.match(result.items[0].body, /^\{\| /);
  assert.match(result.items[0].body, /\|\}$/);
});

test('horizontal rule replaces a dash run', () => {
  const result = match('---');
  assert.equal(result.id, 'hr');
  assert.equal(result.items[0].body, '----');
  assert.deepEqual([result.start, result.end], [0, 3]);
});
