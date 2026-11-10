import * as vscode from 'vscode';
import type {
  CodeAction,
  ColorInformation,
  ColorPresentation,
  CompletionItem,
  Diagnostic,
  DocumentHighlight,
  DocumentLink,
  DocumentSymbol,
  FoldingRange,
  Hover,
  InlayHint,
  MarkupContent,
  Position,
  Range,
  SignatureHelp,
  TextDocumentEdit,
  TextEdit,
  WorkspaceEdit,
} from 'vscode-languageserver-types';

const DIAGNOSTIC_SOURCE = 'WikiLint';

export function toRange(range: Range): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

export function toPosition(position: vscode.Position | Position): Position {
  return {line: position.line, character: position.character};
}

export function offsetAt(document: vscode.TextDocument, position: vscode.Position): number {
  return document.offsetAt(position);
}

export function toLspRange(range: vscode.Range): Range {
  return {
    start: {line: range.start.line, character: range.start.character},
    end: {line: range.end.line, character: range.end.character},
  };
}

export function toDiagnostic(diagnostic: Diagnostic): vscode.Diagnostic {
  const message =
    typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value;
  const result = new vscode.Diagnostic(
    toRange(diagnostic.range),
    message,
    Math.max(0, (diagnostic.severity ?? 2) - 1),
  );
  result.source = diagnostic.source || DIAGNOSTIC_SOURCE;
  if (typeof diagnostic.code === 'string' || typeof diagnostic.code === 'number') {
    result.code = diagnostic.code;
  }
  return result;
}

export function toLspDiagnostic(diagnostic: vscode.Diagnostic): Diagnostic {
  return {
    range: toLspRange(diagnostic.range),
    message: diagnostic.message,
    severity: Math.min(4, (diagnostic.severity ?? 1) + 1) as Diagnostic['severity'],
    code: typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code,
    source: diagnostic.source,
  };
}

export function toCompletionItemKind(kind: number | string | undefined): vscode.CompletionItemKind {
  if (typeof kind === 'number') return Math.max(0, kind - 1);
  if (typeof kind === 'string') {
    const mapped = vscode.CompletionItemKind[kind as keyof typeof vscode.CompletionItemKind];
    return typeof mapped === 'number' ? mapped : vscode.CompletionItemKind.Text;
  }
  return vscode.CompletionItemKind.Text;
}

function isMarkupContent(value: unknown): value is MarkupContent {
  return !!value && typeof value === 'object' && 'kind' in value && 'value' in value;
}

function markdown(value: string): vscode.MarkdownString {
  return new vscode.MarkdownString(value);
}

export function toMarkdown(value: unknown): vscode.MarkdownString {
  if (typeof value === 'string') return markdown(value);
  if (isMarkupContent(value)) return markdown(value.value);
  return markdown('');
}

export function toHoverContents(contents: Hover['contents']): Array<string | vscode.MarkdownString> {
  if (typeof contents === 'string') return [contents];
  if (Array.isArray(contents)) {
    const result: Array<string | vscode.MarkdownString> = [];
    for (const content of contents) {
      if (typeof content === 'string') {
        result.push(content);
      } else {
        result.push(markdown(`\`\`\`${content.language}\n${content.value}\n\`\`\``));
      }
    }
    return result;
  }
  return [markdown(contents.value)];
}

export function toWorkspaceEdit(
  edit: WorkspaceEdit | undefined,
  document: vscode.TextDocument,
): vscode.WorkspaceEdit | undefined {
  if (!edit) return undefined;
  const result = new vscode.WorkspaceEdit();
  for (const [uri, edits] of Object.entries(edit.changes || {})) {
    const target = uri ? vscode.Uri.parse(uri) : document.uri;
    for (const change of edits) result.replace(target, toRange(change.range), change.newText);
  }
  for (const change of edit.documentChanges || []) {
    if (!('textDocument' in change)) continue;
    const textEdit: TextDocumentEdit = change;
    const target = vscode.Uri.parse(textEdit.textDocument.uri);
    for (const item of textEdit.edits) {
      if ('newText' in item) {
        result.replace(target, toRange(item.range), item.newText);
      }
    }
  }
  return result;
}

export type {
  CodeAction,
  ColorInformation,
  ColorPresentation,
  CompletionItem,
  Diagnostic,
  DocumentHighlight,
  DocumentLink,
  DocumentSymbol,
  FoldingRange,
  Hover,
  InlayHint,
  Position,
  Range,
  SignatureHelp,
  TextEdit,
  WorkspaceEdit,
};
