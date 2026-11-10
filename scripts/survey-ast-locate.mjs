#!/usr/bin/env node
/**
 * AST + scope + occurrence survey.
 *
 * This tool does not use the text fallback. It measures whether an AST-indexed
 * source item can be located in the corresponding rendered section using only:
 *
 *   scope (nearest heading) + text + occurrence in that scope
 *
 * Usage:
 *   npm run compile
 *   node scripts/survey-ast-locate.mjs --wiki https://vcpedia.cn --pages 10
 *
 * Public pages work anonymously. For a private wiki, pass --cookie or
 * WIKI_COOKIE with the session cookie header.
 */
import fs from 'node:fs';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
let itemsUtil;
let astIndex;
try {
  itemsUtil = require('../out/editor/items.js');
  astIndex = require('../out/editor/ast-index.js');
} catch {
  console.error('Missing compiled output. Run `npm run compile` first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const wiki = String(option('wiki', 'https://vcpedia.cn')).replace(/\/+$/, '');
const pageCount = Math.max(1, Number(option('pages', 10)) || 10);
const cookie = option('cookie', process.env.WIKI_COOKIE || '');
const outputJson = args.includes('--json');
const inputPath = option('input', '');
const api = `${wiki}/api.php`;

function normalize(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

async function apiGet(params) {
  const url = `${api}?${new URLSearchParams({format: 'json', formatversion: '2', ...params})}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: cookie ? {cookie, 'user-agent': 'mediawiki-vscode-editor/ast-survey'} : {
      'user-agent': 'mediawiki-vscode-editor/ast-survey',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function randomTitles(namespace, limit) {
  const data = await apiGet({
    action: 'query',
    list: 'random',
    rnnamespace: namespace,
    rnlimit: limit,
  });
  return (data.query?.random || []).map(item => item.title);
}

function headingKey(value) {
  return normalize(
    itemsUtil.simplify(
      String(value || '')
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
        .replace(/\[\[([^\]]+)\]\]/g, '$1')
        .replace(/<[^>]*>/g, ''),
    ),
  );
}

async function renderedSections(title) {
  console.error(`  sections: ${title}`);
  const full = await apiGet({action: 'parse', page: title, prop: 'text|sections'});
  if (full.error || !full.parse?.text) return null;
  const sections = new Map();
  sections.set('', normalize(full.parse.text));
  const sectionList = full.parse.sections || [];
  console.error(`  sections: ${title}: ${sectionList.length}`);
  for (const section of sectionList) {
    if (!section.index || Number(section.level) > 2) continue;
    const data = await apiGet({
      action: 'parse',
      page: title,
      section: section.index,
      prop: 'text',
    });
    if (!data.error && data.parse?.text) {
      sections.set(headingKey(section.line), normalize(data.parse.text));
    }
  }
  return {root: normalize(full.parse.text), sections};
}

async function collectPages() {
  const quotas = [[0, 4], [10, 2], [4, 1], [14, 1], [6, 1], [0, 1]];
  const pages = [];
  const seen = new Set();
  async function add(title) {
    if (seen.has(title) || pages.length >= pageCount) return false;
    seen.add(title);
    const data = await apiGet({
      action: 'query',
      prop: 'revisions',
      rvprop: 'content|timestamp',
      rvslots: 'main',
      titles: title,
    });
    const page = data.query?.pages?.[0];
    const text = page?.revisions?.[0]?.slots?.main?.content;
    if (!text || text.length < 300) return false;
    if (/\.(css|js|json)$/i.test(title)) return false;
    const prose = itemsUtil.extractItems(text).some(item =>
      /\p{Script=Han}{2,}/u.test(item.text),
    );
    if (!prose) return false;
    const rendered = await renderedSections(title);
    if (!rendered || rendered.root.length < 200) return false;
    pages.push({title, ns: page.ns, text, rendered});
    console.error(`  page: [${page.ns}] ${title}`);
    return true;
  }
  for (const [ns, quota] of quotas) {
    const titles = await randomTitles(ns, 8);
    let added = 0;
    for (const title of titles) {
      if (added >= quota || pages.length >= pageCount) break;
      if (await add(title)) added++;
    }
  }
  while (pages.length < pageCount) {
    let added = false;
    for (const title of await randomTitles(0, 8)) {
      if (await add(title)) {
        added = true;
        break;
      }
    }
    if (!added) break;
  }
  return pages;
}

function sourceTargets(page) {
  const index = astIndex.buildAstIndex(require('wikiparser-node').parse(page.text));
  const targets = [];
  for (const item of itemsUtil.extractItemsFromIndex(index)) {
    if (!/\p{Script=Han}{2,}/u.test(item.text) || item.text.length < 2 || item.text.length > 60) {
      continue;
    }
    if (item.type === 'parameter-key' || /[=|{}]|^\/\*|^Category:|^分类:/u.test(item.text)) {
      continue;
    }
    targets.push({
      ...item,
      scope: item.section,
      occurrence: item.sectionOccurrence,
    });
  }
  return {index, targets};
}

function sourceLine(text, offset) {
  let line = 0;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function documentFor(text, name) {
  const lines = text.split('\n');
  const offsets = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  return {
    uri: {fsPath: `/tmp/ast-survey-${name}.wiki`},
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

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) >= 0) {
    count++;
    index += needle.length;
  }
  return count;
}

function sampleTargets(targets) {
  if (!targets.length) return [];
  const result = [];
  for (const fraction of [0.15, 0.45, 0.8]) {
    const target = targets[Math.min(targets.length - 1, Math.floor(targets.length * fraction))];
    if (target && !result.some(item => item.path === target.path)) result.push(target);
  }
  const duplicate = targets.find(target => target.occurrence > 1);
  if (duplicate && !result.some(item => item.path === duplicate.path)) result.push(duplicate);
  return result;
}

console.error(`survey: ${wiki}, ${pageCount} pages`);
const pages = inputPath
  ? JSON.parse(fs.readFileSync(inputPath, 'utf8')).map(page => ({
      ...page,
      rendered: {root: page.rendered.root, sections: new Map(Object.entries(page.rendered.sections))},
    }))
  : await collectPages();
console.error(`collected: ${pages.length} pages`);
const report = [];
let totals = {pages: pages.length, targets: 0, sampled: 0, scopeMissing: 0, forwardOk: 0, reverseOk: 0, reverseFail: 0, occurrenceShort: 0, duplicateTargets: 0};
for (const page of pages) {
  console.error(`analyze: [${page.ns}] ${page.title}`);
  const doc = documentFor(page.text, page.title);
  const {targets} = sourceTargets(page);
  const sampled = sampleTargets(targets);
  const rows = [];
  for (const target of sampled) {
    totals.sampled++;
    const section = target.scope
      ? page.rendered.sections.get(target.scope)
      : page.rendered.root;
    if (!section) {
      totals.scopeMissing++;
      rows.push({text: target.text, scope: target.scope, occurrence: target.occurrence, result: 'scope-missing'});
      continue;
    }
    const count = countOccurrences(section, target.text);
    const ok = count >= target.occurrence;
    if (ok) totals.forwardOk++;
    else totals.occurrenceShort++;
    if (target.occurrence > 1) totals.duplicateTargets++;
    const expected = sourceLine(page.text, target.start);
    const reverseLine = itemsUtil.findLineByText(doc, target.text, undefined, {
      fallback: false,
      section: target.scope,
      occurrence: target.occurrence,
    });
    const reverse = reverseLine === expected;
    if (reverse) totals.reverseOk++;
    else totals.reverseFail++;
    rows.push({
      text: target.text,
      scope: target.scope || '(lead)',
      occurrence: target.occurrence,
      previewCount: count,
      line: expected + 1,
      reverse: reverse ? 'ok' : `line-${reverseLine + 1}`,
      result: ok ? 'ok' : 'occurrence-short',
    });
  }
  totals.targets += targets.length;
  report.push({
    title: page.title,
    ns: page.ns,
    chars: page.text.length,
    nodes: astIndex.buildAstIndex(require('wikiparser-node').parse(page.text)).nodes.length,
    targets: targets.length,
    duplicateTargets: targets.filter(target => target.occurrence > 1).length,
    rows,
  });
}

if (outputJson) {
  console.log(JSON.stringify({totals, report}, null, 2));
} else {
  for (const page of report) {
    console.log(`\n[${page.ns}] ${page.title} (${page.chars} chars, ${page.targets} targets)`);
    for (const row of page.rows) {
      console.log(`  ${row.result.padEnd(18)} reverse=${row.reverse.padEnd(8)} scope=${row.scope} occurrence=${row.occurrence}/${row.previewCount} line=${row.line} text=${row.text}`);
    }
  }
  console.log('\nTOTAL', JSON.stringify(totals));
}
