'use strict';

const vscode = require('vscode');
const DIAGNOSTIC_SOURCE = 'WikiLint';

function toRange(range: any): any {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

function toPosition(position: any): {line: number; character: number} {
  return {line: position.line, character: position.character};
}

function offsetAt(document: any, position: any): number {
  if (typeof document.offsetAt === 'function') return document.offsetAt(position);
  const lines = document.getText().split('\n');
  let offset = 0;
  for (let i = 0; i < position.line && i < lines.length; i++) offset += lines[i].length + 1;
  return offset + position.character;
}

function toLspRange(range: any): any {
  return {
    start: {line: range.start.line, character: range.start.character},
    end: {line: range.end.line, character: range.end.character},
  };
}

function toDiagnostic(diagnostic: any): any {
  const result = new vscode.Diagnostic(
    toRange(diagnostic.range),
    diagnostic.message,
    Math.max(0, (diagnostic.severity ?? 2) - 1)
  );
  result.source = diagnostic.source || DIAGNOSTIC_SOURCE;
  if (diagnostic.code !== undefined) result.code = diagnostic.code;
  if (diagnostic.data !== undefined) result.data = diagnostic.data;
  return result;
}

function toLspDiagnostic(diagnostic: any): any {
  return {
    range: toLspRange(diagnostic.range),
    message: diagnostic.message,
    severity: (diagnostic.severity ?? 1) + 1,
    code: typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code,
    source: diagnostic.source,
    data: diagnostic.data,
  };
}

function toCompletionItemKind(kind: any): number {
  if (typeof kind === 'number') return Math.max(0, kind - 1);
  return vscode.CompletionItemKind[kind] ?? vscode.CompletionItemKind.Text;
}

function toMarkdown(value: any): any {
  if (typeof value === 'string') return new vscode.MarkdownString(value);
  if (value && value.kind === 'markdown') return new vscode.MarkdownString(value.value);
  return new vscode.MarkdownString(value?.value ?? '');
}

function toHoverContents(contents: any): any[] {
  if (!contents) return [];
  if (typeof contents === 'string') return [contents];
  if (Array.isArray(contents)) return contents.map(toHoverContents).flat();
  if (contents.kind) return [toMarkdown(contents)];
  if (contents.language) {
    return [new vscode.MarkdownString(`\`\`\`${contents.language}\n${contents.value}\n\`\`\``)];
  }
  return [toMarkdown(contents)];
}

function toWorkspaceEdit(edit: any, document: any): any {
  const result = new vscode.WorkspaceEdit();
  if (!edit) return undefined;
  const changes: Record<string, any[]> = edit.changes || {};
  for (const [uri, edits] of Object.entries(changes)) {
    const target = uri ? vscode.Uri.parse(uri) : document.uri;
    for (const change of edits) result.replace(target, toRange(change.range), change.newText);
  }
  for (const change of edit.documentChanges || []) {
    if (change.textDocument?.uri && change.edits) {
      const target = vscode.Uri.parse(change.textDocument.uri);
      for (const item of change.edits) result.replace(target, toRange(item.range), item.newText);
    }
  }
  return result;
}

module.exports = {
  toRange,
  toPosition,
  offsetAt,
  toLspRange,
  toDiagnostic,
  toLspDiagnostic,
  toCompletionItemKind,
  toMarkdown,
  toHoverContents,
  toWorkspaceEdit,
};
