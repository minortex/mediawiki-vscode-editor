'use strict';

const vscode = require('vscode');

const SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(
  ['namespace', 'keyword', 'parameter', 'string', 'property', 'comment', 'operator'],
  []
);
const SEMANTIC_TYPES = {
  'template-name': 'namespace',
  'magic-word-name': 'keyword',
  'parameter-key': 'parameter',
  'link-target': 'string',
  category: 'string',
  file: 'string',
  'ext-link-url': 'string',
  'free-ext-link': 'string',
  'attr-key': 'property',
  comment: 'comment',
  'double-underscore': 'keyword',
  'heading-title': 'keyword',
  quote: 'keyword',
  hr: 'operator',
  'table-syntax': 'operator',
};

function buildSemanticTokens(document, root) {
  const builder = new vscode.SemanticTokensBuilder(SEMANTIC_LEGEND);
  const walk = (node) => {
    const type = SEMANTIC_TYPES[node.type];
    if (type) {
      const text = node.toString();
      const start = document.positionAt(node.getAbsoluteIndex());
      const end = document.positionAt(node.getAbsoluteIndex() + text.length);
      if (text && start.line === end.line) {
        builder.push(start.line, start.character, text.length, SEMANTIC_LEGEND.tokenTypes.indexOf(type));
      }
      return;
    }
    for (const child of node.childNodes || []) walk(child);
  };
  walk(root);
  return builder.build();
}

module.exports = {SEMANTIC_LEGEND, buildSemanticTokens};
