'use strict';

const Parser = require('wikiparser-node');

function deepestToken(document, offset, root) {
  if (!root) return undefined;
  const position = document.positionAt(offset);
  let node = root.elementFromPoint(position.character, position.line);
  while (node?.childNodes?.length) {
    const child = node.childNodes.find((candidate) => {
      const start = candidate.getAbsoluteIndex();
      return start <= offset && offset < start + candidate.toString().length;
    });
    if (!child) break;
    node = child;
  }
  while (node && node.type === 'text') node = node.parentNode;
  return node;
}

function descendant(node, type) {
  if (!node) return undefined;
  if (node.type === type) return node;
  for (const child of node.childNodes || []) {
    const found = descendant(child, type);
    if (found) return found;
  }
  return undefined;
}

function findDefinitionTarget({document, position, root, config, pageTitle}) {
  const offset = typeof document.offsetAt === 'function'
    ? document.offsetAt(position)
    : (() => {
      const lines = document.getText().split('\n');
      let value = 0;
      for (let i = 0; i < position.line && i < lines.length; i++) value += lines[i].length + 1;
      return value + position.character;
    })();
  const node = deepestToken(document, offset, root);
  if (!node) return undefined;
  let raw;
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
    const container = parent?.type === 'link'
      || parent?.type === 'category'
      || parent?.type === 'file'
      || (parent?.type === 'magic-word' && parent.name === 'invoke')
      || parent?.type === 'template'
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
    const title = Parser.normalizeTitle(value, ns, false, config, pageTitle ? {page: pageTitle} : undefined);
    if (!title.valid || title.interwiki) return undefined;
    return {title: title.title, fragment: title.fragment};
  } catch {
    return undefined;
  }
}

module.exports = {findDefinitionTarget};
