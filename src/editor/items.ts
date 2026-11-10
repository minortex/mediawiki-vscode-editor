import Parser from 'wikiparser-node';
import {createRequire} from 'node:module';
import {astIndexFor, buildAstIndex, nodeAtOffset, type AstIndex, type AstIndexNode} from './ast-index';

const localRequire = createRequire(__filename);

export interface ItemScope {
  type: 'poem';
  index: number;
}

export interface LocateItem {
  start: number;
  end: number;
  path: string;
  type: string;
  text: string;
  section: string;
  sectionOccurrence: number;
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

export function extractItemsFromIndex(index: AstIndex): LocateItem[] {
  const items: LocateItem[] = [];
  let poemCount = 0;

  const add = (
    value: unknown,
    node: AstIndexNode,
    start: number,
    section: string,
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
    if (normalized.length < 2 || normalized.length > 60) return;
    if (/^[|{}]|^\/\*|^Category:|^分类:/u.test(normalized)) return;
    items.push({
      start,
      end: node.end,
      path: node.path,
      type: node.type,
      text: normalized,
      section,
      sectionOccurrence: 0,
      scope,
      label: label || null,
      prev: null,
      next: null,
      labelOccurrence: 0,
    });
  };

  const NON_RENDERABLE = new Set([
    'template-name',
    'module',
    'module-name',
    'attr-key',
    'comment',
    'nowiki',
    'pre',
    'code',
    'math',
    'syntaxhighlight',
    'templatestyles',
  ]);
  const NON_RENDERABLE_EXT = new Set([
    'style',
    'script',
    'nowiki',
    'pre',
    'code',
    'math',
    'syntaxhighlight',
    'templatestyles',
  ]);
  const headingName = (node: AstIndexNode): string =>
    simplify(
      node.token
        .toString()
        .trim()
        .replace(/^=+|=+$/g, '')
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
        .replace(/\[\[([^\]]+)\]\]/g, '$1')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    );

  const walk = (
    node: AstIndexNode,
    section = '',
    scope: ItemScope | null = null,
    label: string | null = null,
  ): void => {
    if (NON_RENDERABLE.has(node.type)) return;
    if (node.type === 'ext' && NON_RENDERABLE_EXT.has(node.name.toLowerCase())) return;
    if (node.type === 'ext' && node.name.toLowerCase() === 'poem') {
      scope = {type: 'poem', index: poemCount++};
      label = null;
    }
    if (node.type === 'parameter') {
      const paramName = simplify(
        String(node.children[0]?.token.toString() || '')
          .replace(/\s+/g, ' ')
          .trim(),
      );
      for (const child of node.children.slice(1)) walk(child, section, scope, paramName);
      return;
    }
    if (node.type === 'transclude') {
      for (const child of node.children.slice(1)) walk(child, section, scope, label);
      return;
    }
    if (node.type === 'link') {
      const raw = node.token.toString();
      const match = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(raw);
      add(match ? match[2] || match[1] : raw, node, node.start, section, scope, label);
      return;
    }
    if (node.type === 'text') {
      const raw = node.token.toString();
      const base = node.start;
      let cursor = 0;
      for (const part of raw.split(/[•·、,，;；\n]+/)) {
        const index = raw.indexOf(part, cursor);
        add(part, node, base + Math.max(0, index), section, scope, label);
        cursor = Math.max(cursor, index + part.length);
      }
      return;
    }
    for (const child of node.children) walk(child, section, scope, label);
  };

  walk(index.root);
  items.sort((a, b) => a.start - b.start);
  const headings = index.nodes
    .filter(node => node.type === 'heading' && node.level > 0 && node.level <= 2)
    .sort((a, b) => a.start - b.start)
    .map(node => ({start: node.start, text: headingName(node)}));
  for (const item of items) {
    let section = '';
    for (const heading of headings) {
      if (heading.start > item.start) break;
      section = heading.text;
    }
    item.section = section;
  }
  for (let index = 0; index < items.length; index++) {
    items[index].prev = index > 0 ? items[index - 1].text.slice(-24) : null;
    items[index].next =
      index < items.length - 1 ? items[index + 1].text.slice(0, 24) : null;
  }

  const sectionCounts = new Map<string, number>();
  const labelCounts = new Map<string, number>();
  for (const item of items) {
    const sectionKey = `${item.section}\u0001${item.text}`;
    const sectionCount = (sectionCounts.get(sectionKey) || 0) + 1;
    sectionCounts.set(sectionKey, sectionCount);
    item.sectionOccurrence = sectionCount;
    if (!item.label) continue;
    const key = [
      item.section,
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

export function extractItems(text: string, root?: unknown): LocateItem[] {
  if (text.length > 300000) return [];
  const token = (root ?? Parser.parse(text)) as Parameters<typeof buildAstIndex>[0];
  return extractItemsFromIndex(buildAstIndex(token));
}

export function itemsFor(doc: LocateDocument, root?: unknown): LocateItem[] {
  const cached = itemCache.get(doc.uri.fsPath);
  if (cached && cached.version === doc.version) return cached.items;
  let items: LocateItem[] = [];
  try {
    items = extractItemsFromIndex(astIndexFor(doc, root));
  } catch {
    items = [];
  }
  itemCache.set(doc.uri.fsPath, {version: doc.version, items});
  return items;
}

export function templateSectionFor(
  doc: LocateDocument,
  offset: number,
  root?: unknown,
): string | undefined {
  const index = astIndexFor(doc, root);
  let node = nodeAtOffset(index, offset);
  while (node && node.type !== 'template' && node.type !== 'transclude') node = node.parent;
  if (!node) return undefined;
  const headings = index.nodes
    .filter(item => item.type === 'heading' && item.level > 0 && item.level <= 2)
    .sort((a, b) => a.start - b.start);
  let section = '';
  for (const heading of headings) {
    if (heading.start > node.start) break;
    section = heading.token
      .toString()
      .trim()
      .replace(/^=+|=+$/g, '')
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]]+)\]\]/g, '$1')
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return section;
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

export interface FindLineOptions {
  fallback?: boolean;
  section?: string;
  occurrence?: number;
}

export function findLineByText(
  doc: LocateDocument,
  text: string,
  root?: unknown,
  options: FindLineOptions = {},
): number {
  const needle = simplify(String(text || '').trim());
  if (!needle) return -1;
  const items = itemsFor(doc, root).filter(
    item => options.section === undefined || item.section === options.section,
  );
  let hit: LocateItem | undefined;
  let bestScore = 0;
  for (const item of items) {
    const score =
      item.text === needle
        ? 3
        : item.text.includes(needle)
          ? 2
          : needle.includes(item.text)
            ? 1
            : 0;
    if (score > bestScore) {
      hit = item;
      bestScore = score;
    }
  }
  if (hit && options.occurrence !== undefined) {
    const scoped = items.find(
      item =>
        item.text === hit!.text &&
        item.sectionOccurrence === options.occurrence,
    );
    if (scoped) hit = scoped;
  }
  if (hit) return doc.positionAt(hit.start).line;
  if (options.fallback === false) return -1;
  for (let line = 0; line < doc.lineCount; line++) {
    if (simplify(doc.lineAt(line).text).includes(needle)) return line;
  }
  return -1;
}
