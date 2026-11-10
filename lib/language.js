'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const Parser = require('wikiparser-node');

const LANGUAGE_ID = 'mediawiki-wikitext';
const SELECTOR = [
  {language: LANGUAGE_ID, scheme: 'file'},
  {language: LANGUAGE_ID, scheme: 'untitled'},
];
const DIAGNOSTIC_SOURCE = 'WikiLint';
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

function setting(key, fallback) {
  const value = vscode.workspace.getConfiguration('mediawikiEditor').get(key);
  return value === undefined ? fallback : value;
}

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

function resolveConfigPath(extensionPath, wiki) {
  if (wiki?.configPath) return wiki.configPath;
  const configured = String(setting('parserConfig', '') || '').trim();
  if (!configured) return path.join(extensionPath, 'config', 'vcpedia.json');
  if (path.isAbsolute(configured)) return configured;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || extensionPath;
  return path.resolve(folder, configured);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toRange(range) {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character
  );
}

function toPosition(position) {
  return {line: position.line, character: position.character};
}

function offsetAt(document, position) {
  if (typeof document.offsetAt === 'function') return document.offsetAt(position);
  const lines = document.getText().split('\n');
  let offset = 0;
  for (let i = 0; i < position.line && i < lines.length; i++) offset += lines[i].length + 1;
  return offset + position.character;
}

function toLspRange(range) {
  return {
    start: {line: range.start.line, character: range.start.character},
    end: {line: range.end.line, character: range.end.character},
  };
}

function toDiagnostic(diagnostic) {
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

function toLspDiagnostic(diagnostic) {
  return {
    range: toLspRange(diagnostic.range),
    message: diagnostic.message,
    severity: (diagnostic.severity ?? 1) + 1,
    code: typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code,
    source: diagnostic.source,
    data: diagnostic.data,
  };
}

function toCompletionItemKind(kind) {
  if (typeof kind === 'number') return Math.max(0, kind - 1);
  return vscode.CompletionItemKind[kind] ?? vscode.CompletionItemKind.Text;
}

function toMarkdown(value) {
  if (typeof value === 'string') return new vscode.MarkdownString(value);
  if (value && value.kind === 'markdown') return new vscode.MarkdownString(value.value);
  return new vscode.MarkdownString(value?.value ?? '');
}

function toHoverContents(contents) {
  if (!contents) return [];
  if (typeof contents === 'string') return [contents];
  if (Array.isArray(contents)) return contents.map(toHoverContents).flat();
  if (contents.kind) return [toMarkdown(contents)];
  if (contents.language) {
    return [new vscode.MarkdownString(`\`\`\`${contents.language}\n${contents.value}\n\`\`\``)];
  }
  return [toMarkdown(contents)];
}

function toWorkspaceEdit(edit, document) {
  const result = new vscode.WorkspaceEdit();
  if (!edit) return undefined;
  const changes = edit.changes || {};
  for (const [uri, edits] of Object.entries(changes)) {
    const target = uri ? vscode.Uri.parse(uri) : document.uri;
    for (const change of edits) {
      result.replace(target, toRange(change.range), change.newText);
    }
  }
  for (const change of edit.documentChanges || []) {
    if (change.textDocument?.uri && change.edits) {
      const target = vscode.Uri.parse(change.textDocument.uri);
      for (const item of change.edits) {
        result.replace(target, toRange(item.range), item.newText);
      }
    }
  }
  return result;
}

function registerLanguageFeatures(context) {
  const extensionPath = context.extensionPath;
  const services = new Map(); // uri -> LanguageService
  const timers = new Map(); // uri -> timeout
  const documentWikis = new Map(); // uri -> wiki
  const documentPages = new Map(); // uri -> page title
  const astCache = new Map(); // uri -> {version, root}
  const configs = new Map(); // config path -> raw config
  const lspItems = new WeakMap(); // vscode.CompletionItem -> LSP item
  const lspActions = new WeakMap(); // vscode.CodeAction -> LSP action
  const diagnostics = vscode.languages.createDiagnosticCollection('mediawiki');

  function loadConfig(wiki) {
    const file = resolveConfigPath(extensionPath, wiki);
    if (configs.has(file)) return configs.get(file);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      const fallback = path.join(extensionPath, 'config', 'vcpedia.json');
      if (file !== fallback) {
        vscode.window.showWarningMessage(
          `MediaWiki: 无法读取解析配置 ${file}，改用内置 vcpedia 配置：${error.message}`
        );
        raw = JSON.parse(fs.readFileSync(fallback, 'utf8'));
      } else {
        throw error;
      }
    }
    configs.set(file, raw);
    return raw;
  }

  function serviceFor(document) {
    if (!enabled()) return undefined;
    const key = document.uri.toString();
    let service = services.get(key);
    if (!service) {
      service = Parser.createLanguageService({uri: document.uri});
      service.config = Parser.getConfig(clone(loadConfig(documentWikis.get(key))));
      services.set(key, service);
    }
    return service;
  }

  function disposeService(uri, forget = false) {
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
    configs.clear();
    astCache.clear();
    for (const key of [...services.keys()]) {
      disposeService(vscode.Uri.parse(key));
    }
    for (const document of vscode.workspace.textDocuments) {
      if (document.languageId === LANGUAGE_ID) schedule(document, 0);
    }
  }

  async function runDiagnostics(document) {
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
        .filter((item) => warnings || item.severity === 1 || item.severity === undefined)
        .map(toDiagnostic)
    );
  }

  function schedule(document, delay = diagnosticDelay()) {
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

  function apply(document, wiki, pageTitle) {
    if (wiki) documentWikis.set(document.uri.toString(), wiki);
    if (pageTitle) documentPages.set(document.uri.toString(), pageTitle);
    if (!enabled()) return document;
    if (document.languageId === LANGUAGE_ID) return document;
    return vscode.languages.setTextDocumentLanguage(document, LANGUAGE_ID);
  }


  function astFor(document) {
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

  function deepestToken(document, offset) {
    const root = astFor(document);
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

  function definitionTarget(document, position) {
    const node = deepestToken(document, offsetAt(document, position));
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
    const service = serviceFor(document);
    if (!service) return undefined;
    try {
      const page = documentPages.get(document.uri.toString());
      const title = Parser.normalizeTitle(
        value,
        ns,
        false,
        service.config,
        page ? {page} : undefined
      );
      if (!title.valid || title.interwiki) return undefined;
      return {title: title.title, fragment: title.fragment};
    } catch {
      return undefined;
    }
  }

  function editUrl(wiki, title, fragment) {
    const base = wiki.articlePath || `${wiki.origin}/$1`;
    let url;
    try {
      const encoded = encodeURIComponent(title.replace(/ /gu, '_'))
        .replace(/%2F/giu, '/')
        .replace(/%3A/giu, ':');
      url = new URL(base.replace(/\$1/gu, encoded), wiki.origin);
    } catch {
      return undefined;
    }
    url.searchParams.set('external-editor', '1');
    if (fragment) url.hash = fragment;
    return url.href;
  }

  async function openDefinition(wiki, target) {
    if (!target) return false;
    const pageTitle = target.title;
    const url = editUrl(wiki, pageTitle, target.fragment);
    if (!url) return false;
    await vscode.env.openExternal(vscode.Uri.parse(url));
    vscode.window.setStatusBarMessage(
      `MediaWiki: 已在浏览器打开 ${pageTitle}，等待编辑器会话…`,
      5000
    );
    return true;
  }

  const provider = {
    async provideFoldingRanges(document) {
      const service = serviceFor(document);
      if (!service) return [];
      const ranges = await service.provideFoldingRanges(document.getText());
      return ranges.map((range) => {
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

    async provideDocumentSymbols(document) {
      const service = serviceFor(document);
      if (!service) return [];
      const symbols = await service.provideDocumentSymbols(document.getText());
      const convert = (symbol) => {
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

    async provideCompletionItems(document, position) {
      const service = serviceFor(document);
      if (!service) return undefined;
      const items = await service.provideCompletionItems(
        document.getText(),
        toPosition(position)
      );
      if (!items) return undefined;
      return items.map((item) => {
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

    resolveCompletionItem(item) {
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

    async provideHover(document, position) {
      const service = serviceFor(document);
      if (!service) return undefined;
      const hover = await service.provideHover(document.getText(), toPosition(position));
      if (!hover) return undefined;
      return new vscode.Hover(
        toHoverContents(hover.contents),
        hover.range ? toRange(hover.range) : undefined
      );
    },

    async provideSignatureHelp(document, position) {
      const service = serviceFor(document);
      if (!service) return undefined;
      const help = await service.provideSignatureHelp(
        document.getText(),
        toPosition(position)
      );
      if (!help) return undefined;
      const signatures = help.signatures.map((signature) => {
        const information = new vscode.SignatureInformation(
          signature.label,
          signature.documentation ? toMarkdown(signature.documentation) : undefined
        );
        information.parameters = (signature.parameters || []).map(
          (parameter) => new vscode.ParameterInformation(parameter.label)
        );
        return information;
      });
      return new vscode.SignatureHelp(
        signatures,
        help.activeSignature ?? 0,
        help.activeParameter ?? 0
      );
    },

    async provideDocumentLinks(document) {
      const service = serviceFor(document);
      if (!service) return [];
      const links = await service.provideLinks(document.getText());
      return links
        .filter((link) => link.target)
        .map((link) => new vscode.DocumentLink(toRange(link.range), vscode.Uri.parse(link.target)));
    },

    async provideDefinition(document, position) {
      const target = definitionTarget(document, position);
      if (target) {
        const wiki = documentWikis.get(document.uri.toString());
        if (wiki && await openDefinition(wiki, target)) return undefined;
      }
      const service = serviceFor(document);
      if (!service) return undefined;
      const locations = await service.provideDefinition(
        document.getText(),
        toPosition(position)
      );
      return (locations || []).map(
        (location) =>
          new vscode.Location(
            location.uri ? vscode.Uri.parse(location.uri) : document.uri,
            toRange(location.range)
          )
      );
    },

    async provideReferences(document, position) {
      const service = serviceFor(document);
      if (!service) return undefined;
      const locations = await service.provideReferences(
        document.getText(),
        toPosition(position)
      );
      return (locations || []).map(
        (location) =>
          new vscode.Location(
            location.uri ? vscode.Uri.parse(location.uri) : document.uri,
            toRange(location.range)
          )
      );
    },

    async provideDocumentHighlights(document, position) {
      const service = serviceFor(document);
      if (!service) return undefined;
      const highlights = await service.provideDocumentHighlights(
        document.getText(),
        toPosition(position)
      );
      return (highlights || []).map(
        (highlight) =>
          new vscode.DocumentHighlight(
            toRange(highlight.range),
            Math.max(0, (highlight.kind ?? 1) - 1)
          )
      );
    },

    async prepareRename(document, position) {
      const service = serviceFor(document);
      if (!service) return undefined;
      const range = await service.resolveRenameLocation(
        document.getText(),
        toPosition(position)
      );
      return range ? toRange(range) : undefined;
    },

    async provideRenameEdits(document, position, newName) {
      const service = serviceFor(document);
      if (!service) return undefined;
      const edit = await service.provideRenameEdits(
        document.getText(),
        toPosition(position),
        newName
      );
      return toWorkspaceEdit(edit, document);
    },

    async provideCodeActions(document, range, actionContext) {
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
      return [...actions, ...refactors].map((action) => {
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

    resolveCodeAction(action) {
      const stored = lspActions.get(action);
      if (!stored) return action;
      const resolved = stored.service.resolveCodeAction(stored.action);
      if (resolved.edit) action.edit = toWorkspaceEdit(resolved.edit, stored.document);
      return action;
    },

    async provideDocumentColors(document) {
      const service = serviceFor(document);
      if (!service) return [];
      const colors = await service.provideDocumentColors(document.getText());
      return colors.map(
        (item) =>
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

    provideColorPresentations(color, colorContext) {
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
      return presentations.map((presentation) => {
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

    async provideInlayHints(document) {
      const service = serviceFor(document);
      if (!service) return [];
      const hints = await service.provideInlayHints(document.getText());
      return hints.map((hint) => {
        const label = typeof hint.label === 'string'
          ? hint.label
          : hint.label.map((part) => part.value ?? part.label).join('');
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
      provideDocumentSemanticTokens(document, token) {
        if (!enabled()) return undefined;
        const maxLength = diagnosticMaxLength();
        if (maxLength > 0 && document.getText().length > maxLength) return undefined;
        const root = astFor(document);
        if (!root) return undefined;
        const builder = new vscode.SemanticTokensBuilder(SEMANTIC_LEGEND);
        const walk = (node) => {
          if (token.isCancellationRequested) return;
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
      },
    }),
    {dispose: () => { for (const key of [...services.keys()]) disposeService(vscode.Uri.parse(key), true); }},
    vscode.workspace.onDidOpenTextDocument((document) => schedule(document, 0)),
    vscode.workspace.onDidChangeTextDocument((event) => schedule(event.document)),
    vscode.workspace.onDidSaveTextDocument((document) => schedule(document, 0)),
    vscode.workspace.onDidCloseTextDocument((document) => disposeService(document.uri, true)),
    vscode.workspace.onDidChangeConfiguration((event) => {
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
    check: (document, wiki, pageTitle) => {
      if (wiki) documentWikis.set(document.uri.toString(), wiki);
      if (pageTitle) documentPages.set(document.uri.toString(), pageTitle);
      return runDiagnostics(document);
    },
    refresh: resetServices,
  };
}

module.exports = {LANGUAGE_ID, registerLanguageFeatures};
