'use strict';

let wikiParser: any = null;
let toSimplified: ((text: string) => string) | null = null;
const itemCache = new Map<string, {version: number; items: any[]}>();

function simplify(text) {
  if (!toSimplified) {
    try {
      const OpenCC = require('opencc-js');
      toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' });
    } catch {
      toSimplified = (s) => s;
    }
  }
  const converter = toSimplified;
  return converter ? converter(text) : text;
}

function extractItems(text: string, root?: any): any[] {
  if (text.length > 300000) return [];
  if (!root) {
    wikiParser ||= require('wikiparser-node');
    root = wikiParser.parse(text);
  }
  const items: any[] = [];
  let poemCount = 0;
  const add = (value: any, start: any, scope: any, label: any) => {
    const s = simplify(String(value || '').replace(/<!--|-->/g, '').replace(/\s+/g, ' ').trim());
    if (/\.(jpe?g|png|gif|svg|webp|ogg|mp3|webm|pdf)$/i.test(s)) return;
    if (!/[\p{L}\p{N}]/u.test(s)) return;
    if (s.length >= 2 && s.length <= 60) items.push({start, text: s, scope, label: label || null});
  };
  const walk = (node: any, scope: any = null, label: any = null) => {
    const name = node.constructor.name;
    if (name === 'ExtToken' && String(node.name).toLowerCase() === 'poem') {
      scope = {type: 'poem', index: poemCount++};
      label = null;
    }
    if (name === 'ParameterToken') {
      const paramName = simplify(String(node.childNodes?.[0] || '').replace(/\s+/g, ' ').trim());
      for (const child of (node.childNodes || []).slice(1)) walk(child, scope, paramName);
      return;
    }
    if (name === 'TranscludeToken') {
      for (const child of (node.childNodes || []).slice(1)) walk(child, scope, label);
      return;
    }
    if (name === 'LinkToken') {
      const raw = node.toString();
      const m = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(raw);
      add(m ? (m[2] || m[1]) : raw, node.getAbsoluteIndex(), scope, label);
      return;
    }
    if (name === 'AstText') {
      const raw = node.toString();
      const base = node.getAbsoluteIndex();
      let cursor = 0;
      for (const part of raw.split(/[•·、,，;；\n]+/)) {
        const idx = raw.indexOf(part, cursor);
        add(part, base + Math.max(0, idx), scope, label);
        cursor = Math.max(cursor, idx + part.length);
      }
      return;
    }
    for (const child of node.childNodes || []) walk(child, scope, label);
  };
  for (const child of root.childNodes || []) walk(child);
  items.sort((a, b) => a.start - b.start);
  for (let i = 0; i < items.length; i++) {
    items[i].prev = i > 0 ? items[i - 1].text.slice(-24) : null;
    items[i].next = i < items.length - 1 ? items[i + 1].text.slice(0, 24) : null;
  }
  const labelCounts = new Map();
  for (const item of items) {
    if (!item.label) {
      item.labelOccurrence = 0;
      continue;
    }
    const key = [item.scope?.type || '', item.scope?.index ?? '', item.label, item.text].join('\u0001');
    const n = (labelCounts.get(key) || 0) + 1;
    labelCounts.set(key, n);
    item.labelOccurrence = n;
  }
  return items;
}

function itemsFor(doc: any, root?: any): any[] {
  const cached = itemCache.get(doc.uri.fsPath);
  if (cached && cached.version === doc.version) return cached.items;
  let items: any[] = [];
  try {
    items = extractItems(doc.getText(), root);
  } catch {
    items = [];
  }
  itemCache.set(doc.uri.fsPath, {version: doc.version, items});
  return items;
}

function itemAt(items, offset) {
  let best = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].start <= offset) best = i;
    else break;
  }
  return best;
}

function occurrenceOf(items, index) {
  const target = items[index];
  const keyOf = (item) => item.scope ? `${item.scope.type}:${item.scope.index}` : '';
  const key = keyOf(target);
  let count = 0;
  for (let i = 0; i <= index; i++) {
    if (items[i].text === target.text && keyOf(items[i]) === key) count++;
  }
  return count;
}

function findLineByText(doc: any, text: string, root?: any): number {
  const needle = simplify(String(text || '').trim());
  if (!needle) return -1;
  const items = itemsFor(doc, root);
  const hit = items.find((it) => it.text.includes(needle) || needle.includes(it.text));
  if (hit) return doc.positionAt(hit.start).line;
  for (let i = 0; i < doc.lineCount; i++) {
    if (simplify(doc.lineAt(i).text).includes(needle)) return i;
  }
  return -1;
}

module.exports = {simplify, extractItems, itemsFor, itemAt, occurrenceOf, findLineByText};
