import * as vscode from 'vscode';
import Parser from 'wikiparser-node';
import type {ConfigData} from 'wikiparser-node';

export interface DefinitionTarget {
  title: string;
  fragment?: string;
}

type ParserToken = ReturnType<typeof Parser.parse>;

interface NormalizeTitleWithPage {
  (
    title: string,
    defaultNs?: number,
    include?: boolean,
    config?: ConfigData,
    options?: {page?: string},
  ): ReturnType<typeof Parser.normalizeTitle>;
}

interface DefinitionInput {
  document: vscode.TextDocument;
  position: vscode.Position;
  root?: ParserToken;
  config?: ConfigData;
  pageTitle?: string;
}

function deepestToken(
  document: vscode.TextDocument,
  offset: number,
  root?: ParserToken,
): ParserToken | undefined {
  if (!root) return undefined;
  const position = document.positionAt(offset);
  let node: ParserToken | undefined = root.elementFromPoint(position.character, position.line);
  while (node?.childNodes?.length) {
    const child = (node.childNodes as ParserToken[]).find(candidate => {
      const start = candidate.getAbsoluteIndex();
      return start <= offset && offset < start + candidate.toString().length;
    });
    if (!child) break;
    node = child;
  }
  while (node && String(node.type) === 'text') {
    node = node.parentNode as ParserToken | undefined;
  }
  return node;
}

function descendant(node: ParserToken | undefined, type: string): ParserToken | undefined {
  if (!node) return undefined;
  if (node.type === type) return node;
  for (const child of node.childNodes as ParserToken[]) {
    const found = descendant(child, type);
    if (found) return found;
  }
  return undefined;
}

export function findDefinitionTarget({
  document,
  position,
  root,
  config,
  pageTitle,
}: DefinitionInput): DefinitionTarget | undefined {
  const offset = document.offsetAt(position);
  const node = deepestToken(document, offset, root);
  if (!node) return undefined;
  let raw: string | undefined;
  let ns = 0;
  if (node.type === 'template-name') {
    raw = node.toString();
    ns = 10;
  } else if (node.type === 'invoke-module') {
    raw = node.toString();
    ns = 828;
  } else if (node.type === 'link-target') {
    raw = node.toString();
    ns = node.parentNode?.type === 'category' ? 14 : node.parentNode?.type === 'file' ? 6 : 0;
  } else {
    const parent = node.parentNode;
    const container =
      parent?.type === 'link' ||
      parent?.type === 'category' ||
      parent?.type === 'file' ||
      (parent?.type === 'magic-word' && 'name' in parent && parent.name === 'invoke') ||
      parent?.type === 'template'
        ? parent
        : node;
    const template = descendant(container, 'template-name');
    const module = descendant(container, 'invoke-module');
    const link = descendant(container, 'link-target');
    if (template) {
      raw = template.toString();
      ns = 10;
    } else if (module) {
      raw = module.toString();
      ns = 828;
    } else if (link) {
      raw = link.toString();
      ns = link.parentNode?.type === 'category' ? 14 : link.parentNode?.type === 'file' ? 6 : 0;
    }
  }
  if (!raw) return undefined;
  let value = raw.trim();
  if (ns === 10 && value.startsWith(':')) {
    ns = 0;
    value = value.slice(1);
  }
  try {
    const normalizeTitle = Parser.normalizeTitle.bind(Parser) as NormalizeTitleWithPage;
    const title = pageTitle
      ? normalizeTitle(value, ns, false, config, {page: pageTitle})
      : normalizeTitle(value, ns, false, config);
    if (!title.valid || title.interwiki) return undefined;
    return {title: title.title, fragment: title.fragment};
  } catch {
    return undefined;
  }
}
