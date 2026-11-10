import Parser from 'wikiparser-node';

type ParserToken = ReturnType<typeof Parser.parse>;

export interface IndexedDocument {
  uri: {fsPath: string};
  version: number;
  getText(): string;
}

export interface AstIndexNode {
  token: ParserToken;
  start: number;
  end: number;
  type: string;
  name: string;
  level: number;
  path: string;
  depth: number;
  parent: AstIndexNode | undefined;
  children: AstIndexNode[];
}

export interface AstIndex {
  version: number;
  root: AstIndexNode;
  nodes: AstIndexNode[];
  byType: Map<string, AstIndexNode[]>;
  templates: Map<string, AstIndexNode[]>;
  links: Map<string, AstIndexNode[]>;
  parameters: Map<string, AstIndexNode[]>;
  headings: Map<string, AstIndexNode[]>;
  extensionTags: Map<string, AstIndexNode[]>;
}

const indexCache = new Map<string, {version: number; index: AstIndex}>();

function pushMap(
  map: Map<string, AstIndexNode[]>,
  key: string,
  node: AstIndexNode,
): void {
  const values = map.get(key);
  if (values) values.push(node);
  else map.set(key, [node]);
}

function addNode(
  node: AstIndexNode,
  index: AstIndex,
): void {
  index.nodes.push(node);
  pushMap(index.byType, node.type, node);
  if (node.type === 'template-name') {
    pushMap(index.templates, node.token.toString().trim().toLowerCase(), node);
  } else if (node.type === 'link-target') {
    pushMap(index.links, node.token.toString().trim().toLowerCase(), node);
  } else if (node.type === 'parameter-key') {
    pushMap(index.parameters, node.token.toString().trim(), node);
  } else if (node.type === 'heading-title') {
    pushMap(index.headings, node.token.toString().trim().toLowerCase(), node);
  } else if (node.type === 'ext') {
    const name = String(node.name || '').trim().toLowerCase();
    if (name) pushMap(index.extensionTags, name, node);
  }
}

export function buildAstIndex(root: ParserToken, version = 0): AstIndex {
  const index: AstIndex = {
    version,
    root: undefined as unknown as AstIndexNode,
    nodes: [],
    byType: new Map(),
    templates: new Map(),
    links: new Map(),
    parameters: new Map(),
    headings: new Map(),
    extensionTags: new Map(),
  };

  const visit = (
    token: ParserToken,
    parent: AstIndexNode | undefined,
    path: string,
    depth: number,
  ): AstIndexNode => {
    const start = token.getAbsoluteIndex();
    const text = token.toString();
    const node: AstIndexNode = {
      token,
      start,
      end: start + text.length,
      type: String(token.type),
      name: typeof (token as ParserToken & {name?: unknown}).name === 'string'
        ? String((token as ParserToken & {name?: string}).name)
        : '',
      level: String(token.type) === 'heading'
        ? (text.trim().match(/^=+/)?.[0].length || 6)
        : 0,
      path,
      depth,
      parent,
      children: [],
    };
    addNode(node, index);
    const childNodes = token.childNodes as ParserToken[] | undefined;
    if (childNodes) {
      for (let i = 0; i < childNodes.length; i++) {
        node.children.push(visit(childNodes[i], node, `${path}.${i}`, depth + 1));
      }
    }
    return node;
  };

  index.root = visit(root, undefined, '0', 0);
  return index;
}

export function astIndexFor(document: IndexedDocument, root?: unknown): AstIndex {
  const key = document.uri.fsPath;
  const cached = indexCache.get(key);
  if (cached && cached.version === document.version) return cached.index;
  const token = (root ?? Parser.parse(document.getText())) as ParserToken;
  const index = buildAstIndex(token, document.version);
  indexCache.set(key, {version: document.version, index});
  return index;
}

export function nodeAtOffset(index: AstIndex, offset: number): AstIndexNode | undefined {
  let low = 0;
  let high = index.nodes.length - 1;
  let last = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (index.nodes[middle].start <= offset) {
      last = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  let best: AstIndexNode | undefined;
  for (let i = last; i >= 0; i--) {
    const node = index.nodes[i];
    if (node.end <= offset) continue;
    if (node.start > offset) continue;
    if (!best || node.depth > best.depth || (node.depth === best.depth && node.end < best.end)) {
      best = node;
    }
  }
  return best;
}

export function nodesOfType(index: AstIndex, type: string): AstIndexNode[] {
  return index.byType.get(type) || [];
}

export function findNodesByText(index: AstIndex, text: string): AstIndexNode[] {
  const needle = text.trim().toLowerCase();
  if (!needle) return [];
  return index.nodes.filter(node =>
    node.type === 'text' && node.token.toString().trim().toLowerCase() === needle,
  );
}
