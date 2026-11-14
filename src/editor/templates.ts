import {astIndexFor, nodeAtOffset, type AstIndex, type AstIndexNode} from './ast-index';
import type {TemplateBlockTarget} from '../protocol';

export interface TemplateTarget extends TemplateBlockTarget {
  start: number;
  end: number;
}

interface TemplateDocument {
  uri: {fsPath: string};
  version: number;
  getText(): string;
}

const cache = new Map<string, {version: number; targets: TemplateTarget[]}>();

function normalizeName(value: string): string {
  return value
    .trim()
    .replace(/^Template:/i, '')
    .replace(/[{}]/g, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function compactName(value: string): string {
  return normalizeName(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function nodeText(node: AstIndexNode): string {
  return node.token
    .toString()
    .trim()
    .replace(/^=+|=+$/g, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sectionFor(index: AstIndex, start: number): string {
  let section = '';
  for (const node of index.nodes) {
    if (node.type !== 'heading' || node.level <= 0 || node.level > 2) continue;
    if (node.start > start) break;
    section = nodeText(node);
  }
  return section;
}

function buildTargets(index: AstIndex): TemplateTarget[] {
  const targets: TemplateTarget[] = [];
  const occurrences = new Map<string, number>();
  for (const node of index.nodes) {
    if (node.type !== 'template') continue;
    const nameNode = node.children.find(child => child.type === 'template-name');
    if (!nameNode) continue;
    const name = normalizeName(nameNode.token.toString());
    if (!name) continue;
    const params: Record<string, string> = {};
    let positional = 0;
    for (const child of node.children) {
      if (child.type !== 'parameter') continue;
      const key = child.children[0] ? nodeText(child.children[0]).toLowerCase() : '';
      params[key || String(++positional)] = nodeText(child.children[1] || child);
    }
    const section = sectionFor(index, node.start);
    const key = `${section}\u0001${compactName(name)}`;
    const occurrence = (occurrences.get(key) || 0) + 1;
    occurrences.set(key, occurrence);
    targets.push({
      name,
      params,
      section,
      occurrence,
      start: node.start,
      end: node.end,
    });
  }
  return targets;
}

export function templateTargetsFor(doc: TemplateDocument, root?: unknown): TemplateTarget[] {
  const key = doc.uri.fsPath;
  const cached = cache.get(key);
  if (cached && cached.version === doc.version) return cached.targets;
  const targets = buildTargets(astIndexFor(doc, root));
  cache.set(key, {version: doc.version, targets});
  return targets;
}

export function templateTargetAt(
  doc: TemplateDocument,
  offset: number,
  root?: unknown,
): TemplateTarget | undefined {
  const index = astIndexFor(doc, root);
  let node = nodeAtOffset(index, offset);
  while (node && node.type !== 'template') node = node.parent;
  if (!node) return undefined;
  return templateTargetsFor(doc, index.root.token).find(target => target.start === node.start);
}
