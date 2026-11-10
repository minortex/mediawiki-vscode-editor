'use strict';

const vscode = require('vscode');
const Parser = require('wikiparser-node');
const {setting, createConfigLoader} = require('./language/config');
const {buildSemanticTokens} = require('./language/semantic');
const {findDefinitionTarget} = require('./language/definition');
const convert = require('./language/convert');

const LANGUAGE_ID = 'mediawiki-wikitext';
const SELECTOR = [
  {language: LANGUAGE_ID, scheme: 'file'},
  {language: LANGUAGE_ID, scheme: 'untitled'},
];
const {
  toRange, toPosition, toLspRange, toDiagnostic, toLspDiagnostic,
  toCompletionItemKind, toMarkdown, toHoverContents, toWorkspaceEdit,
} = convert;
function enabled() {
  return setting('languageFeatures', true);
}

function diagnosticWarnings() {
  return setting('diagnosticsWarnings', false);
}

function diagnosticDelay() {
  return Math.max(0, Number(setting('diagnosticsDelay', 400)) || 0);
}

function diagnosticMaxLength() {
  return Math.max(0, Number(setting('diagnosticsMaxLength', 100000)) || 0);
}

function clone(value: any): any {
  return JSON.parse(JSON.stringify(value));
}

function registerLanguageFeatures(context: any, options: any = {}) {
  const extensionPath = context.extensionPath;
  const services = new Map(); // uri -> LanguageService
  const timers = new Map(); // uri -> timeout
  const documentWikis = new Map(); // uri -> wiki
  const documentPages = new Map(); // uri -> page title
  const astCache = new Map(); // uri -> {version, root}
  const configLoader = createConfigLoader(extensionPath);
  const lspItems = new WeakMap(); // vscode.CompletionItem -> LSP item
  const lspActions = new WeakMap(); // vscode.CodeAction -> LSP action
  const diagnostics = vscode.languages.createDiagnosticCollection('mediawiki');

  function serviceFor(document: any): any {
    if (!enabled()) return undefined;
    const key = document.uri.toString();
    let service = services.get(key);
    if (!service) {
      service = Parser.createLanguageService({uri: document.uri});
      service.config = Parser.getConfig(clone(configLoader.load(documentWikis.get(key))));
      services.set(key, service);
    }
    return service;
  }

  function disposeService(uri: any, forget = false): void {
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

  function resetServices() {
    configLoader.clear();
    astCache.clear();
    for (const key of [...services.keys()]) {
      disposeService(vscode.Uri.parse(key));
    }
    for (const document of vscode.workspace.textDocuments) {
      if (document.languageId === LANGUAGE_ID) schedule(document, 0);
    }
  }

  async function runDiagnostics(document: any): Promise<void> {
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
    if (document.version !== version || services.get(document.uri.toString()) !== service) return;
    const warnings = diagnosticWarnings();
    diagnostics.set(
      document.uri,
      result
        .filter((item: any) => warnings || item.severity === 1 || item.severity === undefined)
        .map(toDiagnostic)
    );
  }

  function schedule(document: any, delay = diagnosticDelay()): void {
    if (!enabled() || document.languageId !== LANGUAGE_ID) return;
    const key = document.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        runDiagnostics(document).catch(() => {});
      }, delay)
    );
  }

  function apply(document: any, wiki?: any, pageTitle?: any): any {
    if (wiki) documentWikis.set(document.uri.toString(), wiki);
    if (pageTitle) documentPages.set(document.uri.toString(), pageTitle);
    if (!enabled()) return document;
    if (document.languageId === LANGUAGE_ID) return document;
    return vscode.languages.setTextDocumentLanguage(document, LANGUAGE_ID);
  }


  function astFor(document: any): any {
    const key = document.uri.toString();
    const cached = astCache.get(key);
    if (cached && cached.version === document.version) return cached.root;
    const service = serviceFor(document);
    if (!service) return undefined;
    try {
      const root = Parser.parse(
        document.getText(),
        false,
        undefined,
        service.config
      );
      astCache.set(key, {version: document.version, root});
      return root;
    } catch {
      return undefined;
    }
  }

  async function openDefinition(wiki: any, target: any): Promise<boolean> {
    if (!target) return false;
    if (typeof options.navigateEdit !== 'function') return false;
    return !!(await options.navigateEdit({
      wiki,
      title: target.title,
      fragment: target.fragment,
    }));
  }

  const provider = {
    async provideFoldingRanges(document: any) {
      const service = serviceFor(document);
      if (!service) return [];
      const ranges = await service.provideFoldingRanges(document.getText());
      return ranges.map((range: any) => {
        const kind = range.kind === 'comment'
          ? vscode.FoldingRangeKind.Comment
          : range.kind === 'imports'
            ? vscode.FoldingRangeKind.Imports
            : range.kind === 'region'
              ? vscode.FoldingRangeKind.Region
              : undefined;
        return new vscode.FoldingRange(range.startLine, range.endLine, kind);
      });
    },

    async provideDocumentSymbols(document: any) {
      const service = serviceFor(document);
      if (!service) return [];
      const symbols = await service.provideDocumentSymbols(document.getText());
      const convert = (symbol: any) => {
        const result = new vscode.DocumentSymbol(
          symbol.name,
          symbol.detail || '',
          Math.max(0, symbol.kind - 1),
          toRange(symbol.range),
          toRange(symbol.selectionRange)
        );
        result.children = (symbol.children || []).map(convert);
        return result;
      };
      return symbols.map(convert);
    },

    async provideCompletionItems(document: any, position: any) {
      const service = serviceFor(document);
      if (!service) return undefined;
      const items = await service.provideCompletionItems(
        document.getText(),
        toPosition(position)
      );
      if (!items) return undefined;
      return items.map((item: any) => {
        const result = new vscode.CompletionItem(
          item.label,
          toCompletionItemKind(item.kind)
        );
        if (item.detail) result.detail = item.detail;
        if (item.documentation) {
          result.documentation = Array.isArray(item.documentation)
            ? item.documentation.map(toMarkdown)
            : toMarkdown(item.documentation);
        }
        if (item.sortText) result.sortText = item.sortText;
        if (item.filterText) result.filterText = item.filterText;
        if (item.insertText) result.insertText = item.insertText;
        if (item.preselect) result.preselect = item.preselect;
        if (item.commitCharacters) result.commitCharacters = item.commitCharacters;
        if (item.textEdit) {
          result.range = toRange(item.textEdit.range);
          result.insertText = item.textEdit.newText;
        }
        if (item.insertTextFormat === 2) {
          result.insertText = new vscode.SnippetString(result.insertText ?? item.label);
        }
        if (item.data !== undefined) result.data = item.data;
        lspItems.set(result, {item, service});
        return result;
      });
    },

    resolveCompletionItem(item: any) {
      const stored = lspItems.get(item);
      if (!stored) return item;
      const resolved = stored.service.resolveCompletionItem(stored.item);
      if (resolved.documentation) {
        item.documentation = Array.isArray(resolved.documentation)
          ? resolved.documentation.map(toMarkdown)
          : toMarkdown(resolved.documentation);
      }
      if (resolved.detail) item.detail = resolved.detail;
      return item;
    },

    async provideHover(document: any, position: any) {
      const service = serviceFor(document);
      if (!service) return undefined;
      const hover = await service.provideHover(document.getText(), toPosition(position));
      if (!hover) return undefined;
      return new vscode.Hover(
        toHoverContents(hover.contents),
        hover.range ? toRange(hover.range) : undefined
      );
    },

    async provideSignatureHelp(document: any, position: any) {
      const service = serviceFor(document);
      if (!service) return undefined;
      const help = await service.provideSignatureHelp(
        document.getText(),
        toPosition(position)
      );
      if (!help) return undefined;
      const signatures = help.signatures.map((signature: any) => {
        const information = new vscode.SignatureInformation(
          signature.label,
          signature.documentation ? toMarkdown(signature.documentation) : undefined
        );
        information.parameters = (signature.parameters || []).map(
          (parameter: any) => new vscode.ParameterInformation(parameter.label)
        );
        return information;
      });
      return new vscode.SignatureHelp(
        signatures,
        help.activeSignature ?? 0,
        help.activeParameter ?? 0
      );
    },

    async provideDocumentLinks(document: any) {
      const service = serviceFor(document);
      if (!service) return [];
      const links = await service.provideLinks(document.getText());
      return links
        .filter((link: any) => link.target)
        .map((link: any) => new vscode.DocumentLink(toRange(link.range), vscode.Uri.parse(link.target)));
    },

    async provideDefinition(document: any, position: any) {
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
        if (wiki && await openDefinition(wiki, target)) return undefined;
      }
      const locations = await service.provideDefinition(
        document.getText(),
        toPosition(position)
      );
      return (locations || []).map(
        (location: any) =>
          new vscode.Location(
            location.uri ? vscode.Uri.parse(location.uri) : document.uri,
            toRange(location.range)
          )
      );
    },

    async provideReferences(document: any, position: any) {
      const service = serviceFor(document);
      if (!service) return undefined;
      const locations = await service.provideReferences(
        document.getText(),
        toPosition(position)
      );
      return (locations || []).map(
        (location: any) =>
          new vscode.Location(
            location.uri ? vscode.Uri.parse(location.uri) : document.uri,
            toRange(location.range)
          )
      );
    },

    async provideDocumentHighlights(document: any, position: any) {
      const service = serviceFor(document);
      if (!service) return undefined;
      const highlights = await service.provideDocumentHighlights(
        document.getText(),
        toPosition(position)
      );
      return (highlights || []).map(
        (highlight: any) =>
          new vscode.DocumentHighlight(
            toRange(highlight.range),
            Math.max(0, (highlight.kind ?? 1) - 1)
          )
      );
    },

    async prepareRename(document: any, position: any) {
      const service = serviceFor(document);
      if (!service) return undefined;
      const range = await service.resolveRenameLocation(
        document.getText(),
        toPosition(position)
      );
      return range ? toRange(range) : undefined;
    },

    async provideRenameEdits(document: any, position: any, newName: any) {
      const service = serviceFor(document);
      if (!service) return undefined;
      const edit = await service.provideRenameEdits(
        document.getText(),
        toPosition(position),
        newName
      );
      return toWorkspaceEdit(edit, document);
    },

    async provideCodeActions(document: any, range: any, actionContext: any) {
      const service = serviceFor(document);
      if (!service) return [];
      const lspDiagnostics = actionContext.diagnostics.map(toLspDiagnostic);
      const actions = await service.provideCodeAction(lspDiagnostics);
      const text = document.getText();
      const lines = text.split(/\r?\n/u);
      const lastLine = Math.max(0, lines.length - 1);
      const end = range.end.line > lastLine
        ? new vscode.Position(lastLine, lines[lastLine].length)
        : range.end;
      const refactors = end.line > range.start.line || end.character > range.start.character
        ? await service.provideRefactoringAction(text, {
          start: toPosition(range.start),
          end: toPosition(end),
        })
        : [];
      return [...actions, ...refactors].map((action: any) => {
        const result = new vscode.CodeAction(
          action.title,
          vscode.CodeActionKind.Empty.append(action.kind || 'quickfix')
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

    resolveCodeAction(action: any) {
      const stored = lspActions.get(action);
      if (!stored) return action;
      const resolved = stored.service.resolveCodeAction(stored.action);
      if (resolved.edit) action.edit = toWorkspaceEdit(resolved.edit, stored.document);
      return action;
    },

    async provideDocumentColors(document: any) {
      const service = serviceFor(document);
      if (!service) return [];
      const colors = await service.provideDocumentColors(document.getText());
      return colors.map(
        (item: any) =>
          new vscode.ColorInformation(
            toRange(item.range),
            new vscode.Color(
              item.color.red,
              item.color.green,
              item.color.blue,
              item.color.alpha
            )
          )
      );
    },

    provideColorPresentations(color: any, colorContext: any) {
      const service = serviceFor(colorContext.document);
      if (!service) return [];
      const presentations = service.provideColorPresentations({
        color: {
          red: color.red,
          green: color.green,
          blue: color.blue,
          alpha: color.alpha,
        },
        range: toLspRange(colorContext.range),
      });
      return presentations.map((presentation: any) => {
        const result = new vscode.ColorPresentation(presentation.label);
        if (presentation.textEdit) {
          result.textEdit = vscode.TextEdit.replace(
            toRange(presentation.textEdit.range),
            presentation.textEdit.newText
          );
        }
        return result;
      });
    },

    async provideInlayHints(document: any) {
      const service = serviceFor(document);
      if (!service) return [];
      const hints = await service.provideInlayHints(document.getText());
      return hints.map((hint: any) => {
        const label = typeof hint.label === 'string'
          ? hint.label
          : hint.label.map((part: any) => part.value ?? part.label).join('');
        return new vscode.InlayHint(
          new vscode.Position(hint.position.line, hint.position.character),
          label,
          hint.kind
        );
      });
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
      '='
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
      resolveProvider: true,
    }),
    vscode.languages.registerColorProvider(SELECTOR, provider),
    vscode.languages.registerInlayHintsProvider(SELECTOR, provider),
    vscode.languages.registerDocumentSemanticTokensProvider(SELECTOR, {
      provideDocumentSemanticTokens(document: any, token: any) {
        if (!enabled()) return undefined;
        const maxLength = diagnosticMaxLength();
        if (maxLength > 0 && document.getText().length > maxLength) return undefined;
        const root = astFor(document);
        if (!root) return undefined;
        return buildSemanticTokens(document, root);
      },
    }),
    {dispose: () => { for (const key of [...services.keys()]) disposeService(vscode.Uri.parse(key), true); }},
    vscode.workspace.onDidOpenTextDocument((document: any) => schedule(document, 0)),
    vscode.workspace.onDidChangeTextDocument((event: any) => schedule(event.document)),
    vscode.workspace.onDidSaveTextDocument((document: any) => schedule(document, 0)),
    vscode.workspace.onDidCloseTextDocument((document: any) => disposeService(document.uri, true)),
    vscode.workspace.onDidChangeConfiguration((event: any) => {
      const keys = [
        'languageFeatures',
        'diagnosticsWarnings',
        'diagnosticsDelay',
        'diagnosticsMaxLength',
        'parserConfig',
      ];
      if (!keys.some((key) => event.affectsConfiguration(`mediawikiEditor.${key}`))) return;
      resetServices();
      for (const document of vscode.workspace.textDocuments) {
        if (document.languageId === LANGUAGE_ID) schedule(document, 0);
      }
    })
  );

  for (const document of vscode.workspace.textDocuments) {
    if (document.languageId === LANGUAGE_ID) schedule(document, 0);
  }

  return {
    languageId: LANGUAGE_ID,
    apply,
    dispose: () => { for (const key of [...services.keys()]) disposeService(vscode.Uri.parse(key), true); },
    check: (document: any, wiki: any, pageTitle: any) => {
      if (wiki) documentWikis.set(document.uri.toString(), wiki);
      if (pageTitle) documentPages.set(document.uri.toString(), pageTitle);
      return runDiagnostics(document);
    },
    refresh: resetServices,
    ast: (document: any) => astFor(document),
  };
}

module.exports = {LANGUAGE_ID, registerLanguageFeatures};
