import * as vscode from 'vscode';
import Parser from 'wikiparser-node';
import type {Config} from 'wikiparser-node';
import {setting, createConfigLoader} from './config';
import {buildSemanticTokens, SEMANTIC_LEGEND} from './semantic';
import {findDefinitionTarget} from './definition';
import {snippetsAt} from './snippets';
import {functionSnippet} from './function-snippets';
import {
  toCompletionItemKind,
  toDiagnostic,
  toHoverContents,
  toLspDiagnostic,
  toLspRange,
  toMarkdown,
  toPosition,
  toRange,
  toWorkspaceEdit,
  type CodeAction as LspCodeAction,
  type ColorInformation as LspColorInformation,
  type ColorPresentation as LspColorPresentation,
  type DocumentHighlight as LspDocumentHighlight,
  type DocumentLink as LspDocumentLink,
  type DocumentSymbol as LspDocumentSymbol,
  type FoldingRange as LspFoldingRange,
  type Hover as LspHover,
  type InlayHint as LspInlayHint,
  type SignatureHelp as LspSignatureHelp,
} from './convert';
import type {WikiRecord} from '../wiki/registry';

type ParserToken = ReturnType<typeof Parser.parse>;
type ParserLanguageService = ReturnType<typeof Parser.createLanguageService> & {config: Config};
type ParserCompletionItem = NonNullable<
  Awaited<ReturnType<ParserLanguageService['provideCompletionItems']>>
>[number];

const LANGUAGE_ID = 'mediawiki-wikitext';
const SELECTOR: vscode.DocumentSelector = [
  {language: LANGUAGE_ID, scheme: 'file'},
  {language: LANGUAGE_ID, scheme: 'untitled'},
];

export interface NavigateEditRequest {
  wiki: WikiRecord;
  title: string;
  fragment?: string;
}

export interface LanguageFeaturesOptions {
  navigateEdit?(request: NavigateEditRequest): Promise<boolean> | boolean;
}

export interface LanguageFeatures {
  languageId: string;
  apply(
    document: vscode.TextDocument,
    wiki?: WikiRecord,
    pageTitle?: string,
  ): Promise<vscode.TextDocument>;
  dispose(): void;
  check(document: vscode.TextDocument, wiki?: WikiRecord, pageTitle?: string): Promise<void>;
  refresh(): void;
  ast(document: vscode.TextDocument): ParserToken | undefined;
}

const enabled = (): boolean => setting('languageFeatures', true);
const diagnosticWarnings = (): boolean => setting('diagnosticsWarnings', false);
const diagnosticDelay = (): number =>
  Math.max(0, Number(setting('diagnosticsDelay', 400)) || 0);
const diagnosticMaxLength = (): number =>
  Math.max(0, Number(setting('diagnosticsMaxLength', 100000)) || 0);

const SNIPPET_BLOCKED_TAGS: Record<string, true> = {
  nowiki: true,
  pre: true,
  source: true,
  syntaxhighlight: true,
  math: true,
  chem: true,
  ce: true,
  score: true,
  graph: true,
  timeline: true,
  hiero: true,
  templatedata: true,
  imagemap: true,
  gallery: true,
  charinsert: true,
  mapframe: true,
  maplink: true,
  phonos: true,
  rss: true,
  section: true,
  quiz: true,
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function registerLanguageFeatures(
  context: vscode.ExtensionContext,
  options: LanguageFeaturesOptions = {},
): LanguageFeatures {
  const services = new Map<string, ParserLanguageService>();
  const timers = new Map<string, NodeJS.Timeout>();
  const documentWikis = new Map<string, WikiRecord>();
  const documentPages = new Map<string, string>();
  const astCache = new Map<string, {version: number; root: ParserToken}>();
  const configLoader = createConfigLoader(context.extensionPath);
  const lspItems = new WeakMap<
    vscode.CompletionItem,
    {item: ParserCompletionItem; service: ParserLanguageService}
  >();
  const lspActions = new WeakMap<
    vscode.CodeAction,
    {action: LspCodeAction; service: ParserLanguageService; document: vscode.TextDocument}
  >();
  const diagnostics = vscode.languages.createDiagnosticCollection('mediawiki');

  function serviceFor(document: vscode.TextDocument): ParserLanguageService | undefined {
    if (!enabled()) return undefined;
    const key = document.uri.toString();
    let service = services.get(key);
    if (!service) {
      service = Object.assign(Parser.createLanguageService({uri: document.uri}), {
        config: Parser.getConfig(clone(configLoader.load(documentWikis.get(key)))),
      });
      services.set(key, service);
    }
    return service;
  }

  function disposeService(uri: vscode.Uri, forget = false): void {
    const key = uri.toString();
    const service = services.get(key);
    if (service) {
      services.delete(key);
      Promise.resolve(service.destroy?.()).catch(() => {});
    }
    const timer = timers.get(key);
    if (timer) {
      clearTimeout(timer);
      timers.delete(key);
    }
    diagnostics.delete(uri);
    if (forget) {
      documentWikis.delete(key);
      documentPages.delete(key);
      astCache.delete(key);
    }
  }

  function resetServices(): void {
    configLoader.clear();
    astCache.clear();
    for (const key of [...services.keys()]) disposeService(vscode.Uri.parse(key));
    for (const document of vscode.workspace.textDocuments) {
      if (document.languageId === LANGUAGE_ID) schedule(document, 0);
    }
  }

  function isExtensionParameter(
    root: ParserToken,
    position: {line: number; character: number},
  ): boolean {
    let node = root.elementFromPoint(position.character, position.line) as
      | ParserToken
      | undefined;
    while (node && node.type !== 'param-line') {
      node = node.parentNode as ParserToken | undefined;
    }
    if (!node) return false;
    let parent = node.parentNode as ParserToken | undefined;
    while (parent && parent.type !== 'ext') {
      parent = parent.parentNode as ParserToken | undefined;
    }
    return parent?.type === 'ext';
  }

  async function runDiagnostics(document: vscode.TextDocument): Promise<void> {
    const service = serviceFor(document);
    if (!service) return;
    const maxLength = diagnosticMaxLength();
    if (maxLength > 0 && document.getText().length > maxLength) {
      diagnostics.delete(document.uri);
      return;
    }
    const version = document.version;
    let result;
    try {
      result = await service.provideDiagnostics(document.getText(), diagnosticWarnings());
    } catch {
      return;
    }
    if (document.version !== version || services.get(document.uri.toString()) !== service) {
      return;
    }
    const warnings = diagnosticWarnings();
    const root = result.some(item => item.code === 'no-ignored') ? astFor(document) : undefined;
    diagnostics.set(
      document.uri,
      result
        .filter(item => {
          if (
            item.code === 'no-ignored' &&
            root &&
            isExtensionParameter(root, item.range.start)
          ) {
            return false;
          }
          return warnings || item.severity === 1 || item.severity === undefined;
        })
        .map(toDiagnostic),
    );
  }

  function schedule(document: vscode.TextDocument, delay = diagnosticDelay()): void {
    if (!enabled() || document.languageId !== LANGUAGE_ID) return;
    const key = document.uri.toString();
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        runDiagnostics(document).catch(() => {});
      }, delay),
    );
  }

  async function apply(
    document: vscode.TextDocument,
    wiki?: WikiRecord,
    pageTitle?: string,
  ): Promise<vscode.TextDocument> {
    if (wiki) documentWikis.set(document.uri.toString(), wiki);
    if (pageTitle) documentPages.set(document.uri.toString(), pageTitle);
    if (!enabled() || document.languageId === LANGUAGE_ID) return document;
    return vscode.languages.setTextDocumentLanguage(document, LANGUAGE_ID);
  }

  function astFor(document: vscode.TextDocument): ParserToken | undefined {
    const key = document.uri.toString();
    const cached = astCache.get(key);
    if (cached && cached.version === document.version) return cached.root;
    const service = serviceFor(document);
    if (!service) return undefined;
    try {
      const root = Parser.parse(document.getText(), false, undefined, service.config);
      astCache.set(key, {version: document.version, root});
      return root;
    } catch {
      return undefined;
    }
  }

  function snippetSuppressed(
    document: vscode.TextDocument,
    position: vscode.Position,
    allowComment: boolean,
  ): boolean {
    const maxLength = diagnosticMaxLength();
    if (maxLength > 0 && document.getText().length > maxLength) return false;
    let root: ParserToken | undefined;
    try {
      root = astFor(document);
    } catch {
      return false;
    }
    if (!root) return false;
    try {
      let node = root.elementFromPoint(position.character, position.line) as
        | ParserToken
        | undefined;
      while (node) {
        if (node.type === 'comment' && !allowComment) return true;
        if (node.type === 'ext' || node.type === 'ext-inner') {
          const name = typeof node.name === 'string' ? node.name.toLowerCase() : '';
          if (Object.hasOwn(SNIPPET_BLOCKED_TAGS, name)) return true;
        }
        node = node.parentNode as ParserToken | undefined;
      }
    } catch {
      return false;
    }
    return false;
  }

  async function openDefinition(wiki: WikiRecord, target: {title: string; fragment?: string}): Promise<boolean> {
    if (!options.navigateEdit) return false;
    return !!(await options.navigateEdit({
      wiki,
      title: target.title,
      fragment: target.fragment,
    }));
  }

  const provider: vscode.FoldingRangeProvider &
    vscode.DocumentSymbolProvider &
    vscode.CompletionItemProvider &
    vscode.HoverProvider &
    vscode.SignatureHelpProvider &
    vscode.DocumentLinkProvider &
    vscode.DefinitionProvider &
    vscode.ReferenceProvider &
    vscode.DocumentHighlightProvider &
    vscode.RenameProvider &
    vscode.CodeActionProvider &
    vscode.DocumentColorProvider &
    vscode.InlayHintsProvider = {
    async provideFoldingRanges(
      document: vscode.TextDocument,
    ): Promise<vscode.FoldingRange[]> {
      const service = serviceFor(document);
      if (!service) return [];
      const ranges: LspFoldingRange[] = await service.provideFoldingRanges(document.getText());
      return ranges.map(range => {
        const kind =
          range.kind === 'comment'
            ? vscode.FoldingRangeKind.Comment
            : range.kind === 'imports'
              ? vscode.FoldingRangeKind.Imports
              : range.kind === 'region'
                ? vscode.FoldingRangeKind.Region
                : undefined;
        return new vscode.FoldingRange(range.startLine, range.endLine, kind);
      });
    },

    async provideDocumentSymbols(
      document: vscode.TextDocument,
    ): Promise<vscode.DocumentSymbol[]> {
      const service = serviceFor(document);
      if (!service) return [];
      const symbols: LspDocumentSymbol[] = await service.provideDocumentSymbols(document.getText());
      const convert = (symbol: LspDocumentSymbol): vscode.DocumentSymbol => {
        const result = new vscode.DocumentSymbol(
          symbol.name,
          symbol.detail || '',
          Math.max(0, symbol.kind - 1),
          toRange(symbol.range),
          toRange(symbol.selectionRange),
        );
        result.children = (symbol.children || []).map(convert);
        return result;
      };
      return symbols.map(convert);
    },

    async provideCompletionItems(
      document: vscode.TextDocument,
      position: vscode.Position,
    ): Promise<vscode.CompletionItem[] | undefined> {
      const service = serviceFor(document);
      if (!service) return undefined;
      const items: ParserCompletionItem[] | undefined = await service.provideCompletionItems(
        document.getText(),
        toPosition(position),
      );
      const colon = /[：]$/u.test(
        document.lineAt(position.line).text.slice(0, position.character),
      )
        ? '：'
        : ':';
      return items?.map(item => {
        const kind = toCompletionItemKind(item.kind);
        const result = new vscode.CompletionItem(item.label, kind);
        if (item.detail) result.detail = item.detail;
        if (item.documentation) result.documentation = toMarkdown(item.documentation);
        if (item.sortText) result.sortText = item.sortText;
        if (item.filterText) result.filterText = item.filterText;
        if (item.insertText) result.insertText = item.insertText;
        if (item.preselect) result.preselect = item.preselect;
        if (item.commitCharacters) result.commitCharacters = item.commitCharacters;
        if (item.textEdit && 'range' in item.textEdit) {
          result.range = toRange(item.textEdit.range);
          result.insertText = item.textEdit.newText;
        }
        if (item.insertTextFormat === 2) {
          result.insertText = new vscode.SnippetString(
            typeof result.insertText === 'string' ? result.insertText : item.label,
          );
        }
        if (kind === vscode.CompletionItemKind.Function) {
          const snippet = functionSnippet(item.label, service.config, colon);
          if (snippet) {
            result.insertText = new vscode.SnippetString(snippet);
            if (snippet.includes('\n')) result.keepWhitespace = true;
          }
        }
        lspItems.set(result, {item, service});
        return result;
      });
    },

    resolveCompletionItem(item: vscode.CompletionItem): vscode.CompletionItem {
      const stored = lspItems.get(item);
      if (!stored) return item;
      const resolved = stored.service.resolveCompletionItem(stored.item);
      if (resolved.documentation) item.documentation = toMarkdown(resolved.documentation);
      if (resolved.detail) item.detail = resolved.detail;
      return item;
    },

    async provideHover(
      document: vscode.TextDocument,
      position: vscode.Position,
    ): Promise<vscode.Hover | undefined> {
      const service = serviceFor(document);
      if (!service) return undefined;
      const hover: LspHover | undefined = await service.provideHover(
        document.getText(),
        toPosition(position),
      );
      if (!hover) return undefined;
      return new vscode.Hover(
        toHoverContents(hover.contents),
        hover.range ? toRange(hover.range) : undefined,
      );
    },

    async provideSignatureHelp(
      document: vscode.TextDocument,
      position: vscode.Position,
    ): Promise<vscode.SignatureHelp | undefined> {
      const service = serviceFor(document);
      if (!service) return undefined;
      const help: LspSignatureHelp | undefined = await service.provideSignatureHelp(
        document.getText(),
        toPosition(position),
      );
      if (!help) return undefined;
      const signatures = help.signatures.map(signature => {
        const information = new vscode.SignatureInformation(
          signature.label,
          signature.documentation ? toMarkdown(signature.documentation) : undefined,
        );
        information.parameters = (signature.parameters || []).map(
          parameter => new vscode.ParameterInformation(parameter.label),
        );
        return information;
      });
      const result = new vscode.SignatureHelp();
      result.signatures = signatures;
      result.activeSignature = help.activeSignature ?? 0;
      result.activeParameter = help.activeParameter ?? 0;
      return result;
    },

    async provideDocumentLinks(
      document: vscode.TextDocument,
    ): Promise<vscode.DocumentLink[]> {
      const service = serviceFor(document);
      if (!service) return [];
      const links: LspDocumentLink[] = await service.provideLinks(document.getText());
      return links
        .filter(link => !!link.target)
        .map(link => new vscode.DocumentLink(toRange(link.range), vscode.Uri.parse(link.target!)));
    },

    async provideDefinition(
      document: vscode.TextDocument,
      position: vscode.Position,
    ): Promise<vscode.Location[] | undefined> {
      const service = serviceFor(document);
      if (!service) return undefined;
      const target = findDefinitionTarget({
        document,
        position,
        root: astFor(document),
        config: service.config,
        pageTitle: documentPages.get(document.uri.toString()),
      });
      if (target) {
        const wiki = documentWikis.get(document.uri.toString());
        if (wiki && (await openDefinition(wiki, target))) return undefined;
      }
      const locations = await service.provideDefinition(
        document.getText(),
        toPosition(position),
      );
      return (locations || []).map(
        location => new vscode.Location(document.uri, toRange(location.range)),
      );
    },

    async provideReferences(
      document: vscode.TextDocument,
      position: vscode.Position,
    ): Promise<vscode.Location[] | undefined> {
      const service = serviceFor(document);
      if (!service) return undefined;
      const locations = await service.provideReferences(
        document.getText(),
        toPosition(position),
      );
      return (locations || []).map(
        location => new vscode.Location(document.uri, toRange(location.range)),
      );
    },

    async provideDocumentHighlights(
      document: vscode.TextDocument,
      position: vscode.Position,
    ): Promise<vscode.DocumentHighlight[] | undefined> {
      const service = serviceFor(document);
      if (!service) return undefined;
      const highlights: LspDocumentHighlight[] | undefined =
        await service.provideDocumentHighlights(
          document.getText(),
          toPosition(position),
        );
      return (highlights || []).map(
        highlight =>
          new vscode.DocumentHighlight(
            toRange(highlight.range),
            Math.max(0, (highlight.kind ?? 1) - 1),
          ),
      );
    },

    async prepareRename(
      document: vscode.TextDocument,
      position: vscode.Position,
    ): Promise<vscode.Range | undefined> {
      const service = serviceFor(document);
      if (!service) return undefined;
      const range = await service.resolveRenameLocation(
        document.getText(),
        toPosition(position),
      );
      return range ? toRange(range) : undefined;
    },

    async provideRenameEdits(
      document: vscode.TextDocument,
      position: vscode.Position,
      newName: string,
    ): Promise<vscode.WorkspaceEdit | undefined> {
      const service = serviceFor(document);
      if (!service) return undefined;
      const edit = await service.provideRenameEdits(
        document.getText(),
        toPosition(position),
        newName,
      );
      return toWorkspaceEdit(edit, document);
    },

    async provideCodeActions(
      document: vscode.TextDocument,
      range: vscode.Range,
      actionContext: vscode.CodeActionContext,
    ): Promise<vscode.CodeAction[]> {
      const service = serviceFor(document);
      if (!service) return [];
      const lspDiagnostics = actionContext.diagnostics.map(toLspDiagnostic);
      const actions: LspCodeAction[] = await service.provideCodeAction(lspDiagnostics);
      const text = document.getText();
      const lines = text.split(/\r?\n/u);
      const lastLine = Math.max(0, lines.length - 1);
      const end =
        range.end.line > lastLine
          ? new vscode.Position(lastLine, lines[lastLine].length)
          : range.end;
      const refactors =
        end.line > range.start.line || end.character > range.start.character
          ? await service.provideRefactoringAction(text, {
              start: toPosition(range.start),
              end: toPosition(end),
            })
          : [];
      return [...actions, ...refactors].map(action => {
        const result = new vscode.CodeAction(
          action.title,
          vscode.CodeActionKind.Empty.append(String(action.kind || 'quickfix')),
        );
        if (action.isPreferred) result.isPreferred = true;
        if (action.edit) result.edit = toWorkspaceEdit(action.edit, document);
        if (action.command) {
          result.command = {
            title: action.command.title,
            command: action.command.command,
            arguments: action.command.arguments,
          };
        }
        lspActions.set(result, {action, service, document});
        return result;
      });
    },

    resolveCodeAction(action: vscode.CodeAction): vscode.CodeAction {
      const stored = lspActions.get(action);
      if (!stored) return action;
      const resolved = stored.service.resolveCodeAction(stored.action);
      if (resolved.edit) action.edit = toWorkspaceEdit(resolved.edit, stored.document);
      return action;
    },

    async provideDocumentColors(
      document: vscode.TextDocument,
    ): Promise<vscode.ColorInformation[]> {
      const service = serviceFor(document);
      if (!service) return [];
      const colors: LspColorInformation[] = await service.provideDocumentColors(document.getText());
      return colors.map(
        item =>
          new vscode.ColorInformation(
            toRange(item.range),
            new vscode.Color(
              item.color.red,
              item.color.green,
              item.color.blue,
              item.color.alpha,
            ),
          ),
      );
    },

    provideColorPresentations(
      color: vscode.Color,
      colorContext: {document: vscode.TextDocument; range: vscode.Range},
    ): vscode.ColorPresentation[] {
      const service = serviceFor(colorContext.document);
      if (!service) return [];
      const presentations: LspColorPresentation[] = service.provideColorPresentations({
        color: {
          red: color.red,
          green: color.green,
          blue: color.blue,
          alpha: color.alpha,
        },
        range: toLspRange(colorContext.range),
      });
      return presentations.map(presentation => {
        const result = new vscode.ColorPresentation(presentation.label);
        if (presentation.textEdit) {
          result.textEdit = vscode.TextEdit.replace(
            toRange(presentation.textEdit.range),
            presentation.textEdit.newText,
          );
        }
        return result;
      });
    },

    async provideInlayHints(
      document: vscode.TextDocument,
    ): Promise<vscode.InlayHint[]> {
      const service = serviceFor(document);
      if (!service) return [];
      const hints: LspInlayHint[] = await service.provideInlayHints(document.getText());
      return hints.map(hint => {
        const label =
          typeof hint.label === 'string'
            ? hint.label
            : hint.label.map(part => part.value).join('');
        return new vscode.InlayHint(
          new vscode.Position(hint.position.line, hint.position.character),
          label,
          hint.kind,
        );
      });
    },
  };

  const snippetProvider: vscode.CompletionItemProvider = {
    provideCompletionItems(
      document: vscode.TextDocument,
      position: vscode.Position,
    ): vscode.CompletionItem[] | vscode.CompletionList | undefined {
      if (!enabled()) return undefined;
      const service = serviceFor(document);
      if (!service) return undefined;
      const line = document.lineAt(position.line).text;
      const context = snippetsAt(line, position.character, line.slice(position.character), {
        tags: [...service.config.ext, ...service.config.html[0], ...service.config.html[1]],
        voidTags: [...service.config.html[2], 'references'],
        redirection: service.config.redirection,
      });
      if (!context || snippetSuppressed(document, position, context.id === 'comment')) {
        return undefined;
      }
      const range = new vscode.Range(
        position.line,
        context.start,
        position.line,
        context.end,
      );
      const filterText = line.slice(context.start, context.end);
      const seen = new Set<string>();
      const items: vscode.CompletionItem[] = [];
      for (const [index, item] of context.items.entries()) {
        const key = `${item.label}\u0000${item.body}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const completion = new vscode.CompletionItem(
          item.label,
          vscode.CompletionItemKind.Snippet,
        );
        completion.detail = item.detail;
        if (item.documentation) {
          completion.documentation = new vscode.MarkdownString(
            item.documentation,
          );
        }
        completion.insertText = new vscode.SnippetString(item.body);
        completion.range = range;
        completion.filterText = item.filterText ?? filterText;
        completion.sortText = item.sortText ?? `0${index}`;
        if (item.preselect) completion.preselect = true;
        if (item.body.includes('\n')) completion.keepWhitespace = true;
        items.push(completion);
      }
      return context.incomplete ? new vscode.CompletionList(items, true) : items;
    },
  };

  context.subscriptions.push(
    diagnostics,
    vscode.languages.registerFoldingRangeProvider(SELECTOR, provider),
    vscode.languages.registerDocumentSymbolProvider(SELECTOR, provider),
    vscode.languages.registerCompletionItemProvider(
      SELECTOR,
      provider,
      '#',
      ':',
      '：',
      '|',
      '{',
      '[',
      '=',
    ),
    vscode.languages.registerCompletionItemProvider(
      SELECTOR,
      snippetProvider,
      "'",
      '<',
      '~',
      '-',
      '#',
      '{',
      '[',
      '=',
    ),
    vscode.languages.registerHoverProvider(SELECTOR, provider),
    vscode.languages.registerSignatureHelpProvider(SELECTOR, provider, ':', '：', '|'),
    vscode.languages.registerDocumentLinkProvider(SELECTOR, provider),
    vscode.languages.registerDefinitionProvider(SELECTOR, provider),
    vscode.languages.registerReferenceProvider(SELECTOR, provider),
    vscode.languages.registerDocumentHighlightProvider(SELECTOR, provider),
    vscode.languages.registerRenameProvider(SELECTOR, provider),
    vscode.languages.registerCodeActionsProvider(SELECTOR, provider, {
      providedCodeActionKinds: [
        vscode.CodeActionKind.QuickFix,
        vscode.CodeActionKind.RefactorRewrite,
      ],
    }),
    vscode.languages.registerColorProvider(SELECTOR, provider),
    vscode.languages.registerInlayHintsProvider(SELECTOR, provider),
    vscode.languages.registerDocumentSemanticTokensProvider(SELECTOR, {
      provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens | undefined {
        if (!enabled()) return undefined;
        const maxLength = diagnosticMaxLength();
        if (maxLength > 0 && document.getText().length > maxLength) return undefined;
        const root = astFor(document);
        return root ? buildSemanticTokens(document, root) : undefined;
      },
    }, SEMANTIC_LEGEND),
    {
      dispose: () => {
        for (const key of [...services.keys()]) disposeService(vscode.Uri.parse(key), true);
      },
    },
    vscode.workspace.onDidOpenTextDocument(document => schedule(document, 0)),
    vscode.workspace.onDidChangeTextDocument(event => schedule(event.document)),
    vscode.workspace.onDidSaveTextDocument(document => schedule(document, 0)),
    vscode.workspace.onDidCloseTextDocument(document => disposeService(document.uri, true)),
    vscode.workspace.onDidChangeConfiguration(event => {
      const keys = [
        'languageFeatures',
        'diagnosticsWarnings',
        'diagnosticsDelay',
        'diagnosticsMaxLength',
        'parserConfig',
      ];
      if (!keys.some(key => event.affectsConfiguration(`mediawikiEditor.${key}`))) return;
      resetServices();
      for (const document of vscode.workspace.textDocuments) {
        if (document.languageId === LANGUAGE_ID) schedule(document, 0);
      }
    }),
  );

  for (const document of vscode.workspace.textDocuments) {
    if (document.languageId === LANGUAGE_ID) schedule(document, 0);
  }

  return {
    languageId: LANGUAGE_ID,
    apply,
    dispose: () => {
      for (const key of [...services.keys()]) disposeService(vscode.Uri.parse(key), true);
    },
    check: async (document, wiki, pageTitle) => {
      if (wiki) documentWikis.set(document.uri.toString(), wiki);
      if (pageTitle) documentPages.set(document.uri.toString(), pageTitle);
      await runDiagnostics(document);
    },
    refresh: resetServices,
    ast: document => astFor(document),
  };
}
