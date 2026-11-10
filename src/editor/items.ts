import Parser from 'wikiparser-node';
import {createRequire} from 'node:module';

const localRequire = createRequire(__filename);

export interface ItemScope {
  type: 'poem';
  index: number;
}

export interface LocateItem {
  start: number;
  text: string;
  scope: ItemScope | null;
  label: string | null;
  prev: string | null;
  next: string | null;
  labelOccurrence: number;
}

export interface LocateDocument {
  uri: {fsPath: string};
  version: number;
  getText(): string;
  positionAt(offset: number): {line: number};
  lineCount: number;
  lineAt(line: number): {text: string};
}

interface LocateToken {
  constructor: {name: string};
  type: string;
  name?: string;
  childNodes?: readonly LocateToken[];
  toString(): string;
  getAbsoluteIndex(): number;
}

let toSimplified: ((text: string) => string) | null = null;
const itemCache = new Map<string, {version: number; items: LocateItem[]}>();

export function simplify(text: string): string {
  if (!toSimplified) {
    try {
      const opencc = localRequire('opencc-js') as {
        Converter(options: {from: string; to: string}): (text: string) => string;
      };
      toSimplified = opencc.Converter({from: 'tw', to: 'cn'});
    } catch {
      toSimplified = value => value;
    }
  }
  return toSimplified ? toSimplified(text) : text;
}

export function extractItems(text: string, root?: unknown): LocateItem[] {
  if (text.length > 300000) return [];
  const tree = (root ?? Parser.parse(text)) as LocateToken;
  const items: LocateItem[] = [];
  let poemCount = 0;

  const add = (
    value: unknown,
    start: number,
    scope: ItemScope | null,
    label: string | null,
  ): void => {
    const normalized = simplify(
      String(value || '')
        .replace(/<!--|-->/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    if (/\.(jpe?g|png|gif|svg|webp|ogg|mp3|webm|pdf)$/i.test(normalized)) return;
    if (!/[\p{L}\p{N}]/u.test(normalized)) return;
    if (normalized.length >= 2 && normalized.length <= 60) {
      items.push({
        start,
        text: normalized,
        scope,
        label: label || null,
        prev: null,
        next: null,
        labelOccurrence: 0,
      });
    }
  };

  const walk = (
    node: LocateToken,
    scope: ItemScope | null = null,
    label: string | null = null,
  ): void => {
    const name = node.constructor.name;
    if (name === 'ExtToken' && String(node.name).toLowerCase() === 'poem') {
      scope = {type: 'poem', index: poemCount++};
      label = null;
    }
    if (name === 'ParameterToken') {
      const paramName = simplify(
        String(node.childNodes?.[0] || '')
          .replace(/\s+/g, ' ')
          .trim(),
      );
      for (const child of (node.childNodes || []).slice(1)) walk(child, scope, paramName);
      return;
    }
    if (name === 'TranscludeToken') {
      for (const child of (node.childNodes || []).slice(1)) walk(child, scope, label);
      return;
    }
    if (name === 'LinkToken') {
      const raw = node.toString();
      const match = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(raw);
      add(
        match ? match[2] || match[1] : raw,
        node.getAbsoluteIndex(),
        scope,
        label,
      );
      return;
    }
    if (name === 'AstText') {
      const raw = node.toString();
      const base = node.getAbsoluteIndex();
      let cursor = 0;
      for (const part of raw.split(/[•·、,，;；\n]+/)) {
        const index = raw.indexOf(part, cursor);
        add(part, base + Math.max(0, index), scope, label);
        cursor = Math.max(cursor, index + part.length);
      }
      return;
    }
    for (const child of node.childNodes || []) walk(child, scope, label);
  };

  for (const child of tree.childNodes || []) walk(child);
  items.sort((a, b) => a.start - b.start);
  for (let index = 0; index < items.length; index++) {
    items[index].prev = index > 0 ? items[index - 1].text.slice(-24) : null;
    items[index].next =
      index < items.length - 1 ? items[index + 1].text.slice(0, 24) : null;
  }

  const labelCounts = new Map<string, number>();
  for (const item of items) {
    if (!item.label) continue;
    const key = [
      item.scope?.type || '',
      item.scope?.index ?? '',
      item.label,
      item.text,
    ].join('\u0001');
    const count = (labelCounts.get(key) || 0) + 1;
    labelCounts.set(key, count);
    item.labelOccurrence = count;
  }
  return items;
}

export function itemsFor(doc: LocateDocument, root?: unknown): LocateItem[] {
  const cached = itemCache.get(doc.uri.fsPath);
  if (cached && cached.version === doc.version) return cached.items;
  let items: LocateItem[] = [];
  try {
    items = extractItems(doc.getText(), root);
  } catch {
    items = [];
  }
  itemCache.set(doc.uri.fsPath, {version: doc.version, items});
  return items;
}

export function itemAt(items: LocateItem[], offset: number): number {
  let best = -1;
  for (let index = 0; index < items.length; index++) {
    if (items[index].start <= offset) best = index;
    else break;
  }
  return best;
}

export function occurrenceOf(items: LocateItem[], index: number): number {
  const target = items[index];
  const keyOf = (item: LocateItem): string =>
    item.scope ? `${item.scope.type}:${item.scope.index}` : '';
  const key = keyOf(target);
  let count = 0;
  for (let cursor = 0; cursor <= index; cursor++) {
    if (items[cursor].text === target.text && keyOf(items[cursor]) === key) count++;
  }
  return count;
}

export function findLineByText(
  doc: LocateDocument,
  text: string,
  root?: unknown,
): number {
  const needle = simplify(String(text || '').trim());
  if (!needle) return -1;
  const items = itemsFor(doc, root);
  const hit = items.find(item => item.text.includes(needle) || needle.includes(item.text));
  if (hit) return doc.positionAt(hit.start).line;
  for (let line = 0; line < doc.lineCount; line++) {
    if (simplify(doc.lineAt(line).text).includes(needle)) return line;
  }
  return -1;
}
