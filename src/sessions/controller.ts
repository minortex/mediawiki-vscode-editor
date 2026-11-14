import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {BrowserBridge} from '../browser/bridge';
import type {SocketLike} from '../browser/server';
import type {SessionManager, SessionMeta} from './manager';
import type {WikiRecord, WikiRegistry} from '../wiki/registry';
import {normalizeOrigin} from '../wiki/config';
import type {LanguageFeatures, NavigateEditRequest} from '../language/features';
import {markConflict} from './conflict';
import type {
  ConflictMessage,
  FinishMessage,
  WikiIdentity,
  OpenMessage,
  RegisterWikiMessage,
  RequestSaveMessage,
  SaveConfirmedMessage,
  SaveConfirmedResultMessage,
  SessionQueryMessage,
  SessionResultMessage,
  WikiRegisteredMessage,
} from '../protocol';

export interface SessionControllerDeps {
  sessionManager: SessionManager;
  getBridge(): BrowserBridge | undefined;
  wikis: WikiRegistry;
  context: vscode.ExtensionContext;
  config(): vscode.WorkspaceConfiguration;
  defaultDir(): string;
  safeName(title: string): string;
  stamp(): string;
  closeAndDelete(fsPath: string): Promise<void>;
  updateStatus(): void;
  clearDirty(fsPath: string): void;
  getLanguageFeatures(): LanguageFeatures | undefined;
}

export interface SaveOutcome {
  ok: boolean;
  error?: string;
}

export interface SessionController {
  open(msg: OpenMessage, ws: SocketLike, wiki: WikiRecord): Promise<void>;
  finish(msg: FinishMessage): Promise<void>;
  markSaved(sessionId: string): void;
  markSaveFailed(sessionId: string): void;
  handleConflict(msg: ConflictMessage): Promise<void>;
  confirmSaved(msg: SaveConfirmedMessage, ws: SocketLike): Promise<void>;
  registerWiki(msg: RegisterWikiMessage, ws: SocketLike): Promise<void>;
  query(msg: SessionQueryMessage, ws: SocketLike): Promise<void>;
  navigate(request: NavigateEditRequest): Promise<boolean>;
  saveInPage(
    sessionId: string,
    text: string,
    summary: string,
    minor: boolean,
  ): Promise<SaveOutcome>;
  requestSave(msg: RequestSaveMessage, ws: SocketLike): Promise<void>;
  restoreDraft(): Promise<void>;
  pageUrl(wiki: WikiRecord, title: string): string | undefined;
  ensureSessionEditor(meta: SessionMeta): Promise<vscode.TextDocument | undefined>;
  /** undefined when the original content hash is not known (old session). */
  edited(sessionId: string, text: string): boolean | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameOrigin(a: unknown, b: unknown): boolean {
  try {
    return normalizeOrigin(a) === normalizeOrigin(b);
  } catch {
    return false;
  }
}

function liveSocket(meta: SessionMeta): SocketLike | undefined {
  for (const ws of meta.sockets) {
    if (ws.readyState === undefined || ws.readyState === 1) return ws;
  }
  return undefined;
}

function sendFinishTo(
  sockets: Iterable<SocketLike>,
  sessionId: string,
  result: 'saved' | 'discarded' | 'unchanged' | 'closed',
): void {
  for (const ws of sockets) {
    try {
      ws.send(JSON.stringify({type: 'finish', sessionId, result}));
    } catch {}
  }
}

export function createSessionController(deps: SessionControllerDeps): SessionController {
  const {
    sessionManager,
    getBridge,
    wikis,
    context,
    config,
    defaultDir,
    safeName,
    stamp,
    closeAndDelete,
    updateStatus,
    clearDirty,
    getLanguageFeatures,
  } = deps;

  const saveFailures = new Set<string>();

  async function ensureSessionEditor(
    meta: SessionMeta,
  ): Promise<vscode.TextDocument | undefined> {
    let doc = vscode.workspace.textDocuments.find(
      document => document.uri.fsPath === meta.fsPath,
    );
    if (!doc) {
      try {
        doc = await vscode.workspace.openTextDocument(vscode.Uri.file(meta.fsPath));
      } catch {
        return undefined;
      }
    }
    const language = getLanguageFeatures();
    if (language) {
      try {
        doc = await language.apply(doc, meta.wiki, meta.title);
      } catch {}
    }
    await vscode.window.showTextDocument(doc, {preview: false});
    language?.check(doc, meta.wiki, meta.title).catch(() => {});
    if (meta.sockets.size === 0) meta.state = 'detached';
    return doc;
  }

  async function open(msg: OpenMessage, ws: SocketLike, wiki: WikiRecord): Promise<void> {
    const root = config().get<string>('tempDir') || defaultDir();
    const dir = wikis.directoryFor(root, wiki);
    await fs.promises.mkdir(dir, {recursive: true});
    const fsPath = path.join(dir, `${safeName(msg.title)}.${stamp()}.wiki`);

    await fs.promises.writeFile(fsPath, msg.text, 'utf8');
    let doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
    const language = getLanguageFeatures();
    if (language) {
      try {
        doc = await language.apply(doc, wiki, msg.title);
      } catch {}
    }
    await vscode.window.showTextDocument(doc, {preview: false});
    language?.check(doc, wiki, msg.title).catch(() => {});

    sessionManager.add(msg.sessionId, {
      fsPath,
      sockets: new Set([ws]),
      title: msg.title,
      wiki,
      revid: msg.revid,
      basetimestamp: msg.basetimestamp,
      starttimestamp: msg.starttimestamp,
      windowId: msg.windowId,
      created: Date.now(),
      state: 'attached',
      autoRestore: true,
      originalHash: createHash('sha256').update(msg.text).digest('hex'),
    });

    vscode.window.setStatusBarMessage(
      vscode.l10n.t(
        'MediaWiki: Editing {0} on {1}; save the file to refresh the browser preview',
        msg.title,
        wiki.name,
      ),
      8000,
    );
  }

  async function finish(msg: FinishMessage): Promise<void> {
    const meta = sessionManager.get(msg.sessionId);
    if (!meta) return;
    clearDirty(meta.fsPath);
    if (
      saveFailures.has(msg.sessionId) &&
      msg.result !== 'saved'
    ) {
      const sockets = [...meta.sockets];
      sessionManager.markDraft(msg.sessionId);
      sendFinishTo(sockets, msg.sessionId, 'closed');
      vscode.window.showWarningMessage(
        vscode.l10n.t(
          'MediaWiki: Commit failed; the temp file was kept as a draft: {0}',
          meta.fsPath,
        ),
      );
      return;
    }
    if (msg.result !== 'saved' && msg.result !== 'unchanged' && msg.result !== 'discarded') {
      const sockets = [...meta.sockets];
      sessionManager.markDraft(msg.sessionId);
      sendFinishTo(sockets, msg.sessionId, 'closed');
      vscode.window.showWarningMessage(
        vscode.l10n.t(
          'MediaWiki: The editing session was disconnected; the temp file was kept: {0}',
          meta.fsPath,
        ),
      );
      return;
    }
    if (msg.result === 'saved') {
      saveFailures.delete(msg.sessionId);
      sessionManager.markAwaitingConfirm(msg.sessionId);
      vscode.window.setStatusBarMessage(
        vscode.l10n.t(
          'MediaWiki: Submitted; waiting for the browser to confirm the new content before cleanup',
        ),
        5000,
      );
      return;
    }
    saveFailures.delete(msg.sessionId);
    const sockets = [...meta.sockets];
    sessionManager.remove(msg.sessionId);
    await closeAndDelete(meta.fsPath);
    sendFinishTo(sockets, msg.sessionId, msg.result);
    vscode.window.setStatusBarMessage(vscode.l10n.t('MediaWiki: Editing session ended'), 5000);
  }

  function markSaved(sessionId: string): void {
    saveFailures.delete(sessionId);
    if (!sessionManager.get(sessionId)) return;
    sessionManager.markAwaitingConfirm(sessionId);
  }

  function markSaveFailed(sessionId: string): void {
    if (sessionManager.get(sessionId)) saveFailures.add(sessionId);
  }

  async function handleConflict(msg: ConflictMessage): Promise<void> {
    const meta = sessionManager.get(msg.sessionId);
    if (!meta) return;
    markSaveFailed(msg.sessionId);
    if (msg.remoteRevid !== undefined || msg.remoteTimestamp !== undefined) {
      sessionManager.updateRevision(
        msg.sessionId,
        msg.remoteRevid,
        msg.remoteTimestamp,
      );
    }
    const doc = vscode.workspace.textDocuments.find(
      document => document.uri.fsPath === meta.fsPath,
    );
    if (!doc) {
      vscode.window.showWarningMessage(
        vscode.l10n.t(
          'MediaWiki: Edit conflict detected, but the local file is missing: {0}',
          meta.fsPath,
        ),
      );
      return;
    }
    const local = doc.getText();
    const label = msg.remoteRevid
      ? vscode.l10n.t('Site latest revision (rev {0})', String(msg.remoteRevid))
      : vscode.l10n.t('Site latest revision');
    const merged = markConflict(local, msg.remoteText, label);
    if (merged === local) {
      vscode.window.showWarningMessage(
        vscode.l10n.t(
          'MediaWiki: The submission conflicted, but the local content matches the latest site content.',
        ),
      );
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      doc.uri,
      new vscode.Range(doc.positionAt(0), doc.positionAt(local.length)),
      merged,
    );
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      vscode.window.showWarningMessage(
        vscode.l10n.t(
          'MediaWiki: The submission conflicted, but the conflict markers could not be written. The local file was kept.',
        ),
      );
      return;
    }
    await vscode.window.showTextDocument(doc, {preview: false});
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        'MediaWiki: Edit conflict detected; the local and latest site versions were written to the editor. Resolve the markers and submit again.',
      ),
    );
  }

  async function confirmSaved(msg: SaveConfirmedMessage, ws: SocketLike): Promise<void> {
    const reply = (payload: {ok: boolean; error?: string}): void => {
      const response: SaveConfirmedResultMessage = {
        type: 'save-confirmed-result',
        sessionId: msg.sessionId,
        ...payload,
      };
      try {
        ws.send(JSON.stringify(response));
      } catch {}
    };
    const meta = sessionManager.get(msg.sessionId);
    if (!meta) {
      reply({ok: true});
      return;
    }
    if (saveFailures.has(msg.sessionId)) {
      sessionManager.markDraft(msg.sessionId, false, true);
      reply({ok: true});
      return;
    }
    try {
      if (msg.origin && ws.origin && !sameOrigin(msg.origin, ws.origin)) {
        throw new Error(vscode.l10n.t('Site origin does not match the browser connection'));
      }
      if (ws.origin && meta.wiki.origin && !sameOrigin(meta.wiki.origin, ws.origin)) {
        throw new Error(vscode.l10n.t('The session does not belong to the current site'));
      }
      const revid = msg.revid;
      if (typeof revid !== 'number' || !Number.isInteger(revid) || revid <= 0) {
        throw new Error(
          vscode.l10n.t(
            'The confirmation carried no revision id; the temp file was kept',
          ),
        );
      }
      const doc = vscode.workspace.textDocuments.find(
        document => document.uri.fsPath === meta.fsPath,
      );
      if (doc?.isDirty) {
        const sockets = [...meta.sockets];
        sessionManager.markDraft(msg.sessionId, false, true);
        vscode.window.showWarningMessage(
          vscode.l10n.t(
            'MediaWiki: The browser already shows the new content, but the local file still has unsubmitted changes; it was kept as a draft: {0}',
            meta.fsPath,
          ),
        );
        reply({ok: true});
        sendFinishTo(sockets, msg.sessionId, 'closed');
        return;
      }
      const sockets = [...meta.sockets];
      clearDirty(meta.fsPath);
      sessionManager.remove(msg.sessionId);
      await closeAndDelete(meta.fsPath);
      vscode.window.setStatusBarMessage(
        vscode.l10n.t(
          'MediaWiki: Confirmed revision {0}; the temp file was cleaned up',
          String(revid),
        ),
        5000,
      );
      reply({ok: true});
      sendFinishTo(sockets, msg.sessionId, 'saved');
    } catch (error) {
      reply({ok: false, error: errorMessage(error)});
      vscode.window.showWarningMessage(
        vscode.l10n.t('MediaWiki: Failed to clean up the temp file: {0}', errorMessage(error)),
      );
    }
  }

  async function registerWiki(
    msg: RegisterWikiMessage,
    ws: SocketLike,
  ): Promise<void> {
    const requestId = msg.requestId;
    const reply = (payload: {ok: boolean; wiki?: WikiIdentity; error?: string}): void => {
      const response: WikiRegisteredMessage = {
        type: 'wiki-registered',
        requestId,
        ok: payload.ok,
        wiki: payload.wiki,
        error: payload.error,
      };
      try {
        ws.send(JSON.stringify(response));
      } catch {}
    };
    try {
      if (!requestId) throw new Error(vscode.l10n.t('Missing requestId'));
      if (!ws.origin || !msg.origin || !sameOrigin(msg.origin, ws.origin)) {
        throw new Error(vscode.l10n.t('Site origin does not match the browser connection'));
      }
      const before = wikis.resolve(context, msg.origin);
      const entry = await wikis.upsert(context, {
        origin: msg.origin,
        api: msg.api,
        name: msg.name,
        siteinfo: msg.siteinfo,
      });
      if (!before || before.siteinfoHash !== entry.siteinfoHash) {
        getLanguageFeatures()?.refresh();
      }
      reply({ok: true, wiki: {id: entry.id, name: entry.name, origin: entry.origin}});
    } catch (error) {
      reply({ok: false, error: errorMessage(error)});
    }
  }

  function normalizePageName(value: string | undefined): string {
    return String(value || '')
      .replace(/_/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .toLowerCase();
  }

  async function query(msg: SessionQueryMessage, ws: SocketLike): Promise<void> {
    const requestId = msg.requestId;
    const reply = (payload: {
      ok: boolean;
      session?: SessionResultMessage['session'];
      error?: string;
    }): void => {
      const response: SessionResultMessage = {
        type: 'session-result',
        requestId,
        ok: payload.ok,
        session: payload.session,
        error: payload.error,
      };
      try {
        ws.send(JSON.stringify(response));
      } catch {}
    };
    try {
      if (!requestId) throw new Error(vscode.l10n.t('Missing requestId'));
      if (!ws.origin || !msg.origin || !sameOrigin(msg.origin, ws.origin)) {
        throw new Error(vscode.l10n.t('Site origin does not match the browser connection'));
      }
      const title = normalizePageName(msg.title);
      if (!title) {
        reply({ok: true, session: null});
        return;
      }
      const candidates = sessionManager
        .entries()
        .filter(
          ([, meta]) =>
            sameOrigin(meta.wiki.origin, msg.origin) &&
            normalizePageName(meta.title) === title &&
            !meta.awaitingConfirm &&
            (meta.state !== 'draft' || meta.autoRestore),
        )
        .sort(([, a], [, b]) => b.created - a.created);
      let picked:
        | {sessionId: string; meta: SessionMeta; text: string}
        | undefined;
      for (const [sessionId, meta] of candidates) {
        if (meta.state === 'draft') {
          const editor = await ensureSessionEditor(meta);
          if (!editor) continue;
        }
        let text: string;
        try {
          const doc = vscode.workspace.textDocuments.find(
            document => document.uri.fsPath === meta.fsPath,
          );
          text = doc ? doc.getText() : await fs.promises.readFile(meta.fsPath, 'utf8');
        } catch {
          continue;
        }
        picked = {sessionId, meta, text};
        break;
      }
      if (!picked) {
        reply({ok: true, session: null});
        return;
      }
      const {sessionId, meta, text} = picked;
      sessionManager.attach(sessionId, ws);
      sessionManager.markAttached(sessionId);
      const doc = vscode.workspace.textDocuments.find(
        document => document.uri.fsPath === meta.fsPath,
      );
      reply({
        ok: true,
        session: {
          sessionId,
          title: meta.title,
          text,
          dirty: !!doc?.isDirty,
          state: meta.state,
          revid: meta.revid,
          basetimestamp: meta.basetimestamp,
          starttimestamp: meta.starttimestamp,
          wiki: {id: meta.wiki.id, name: meta.wiki.name, origin: meta.wiki.origin},
        },
      });
      updateStatus();
    } catch (error) {
      reply({ok: false, error: errorMessage(error)});
    }
  }

  async function navigate(request: NavigateEditRequest): Promise<boolean> {
    const meta = sessionManager
      .values()
      .find(item => liveSocket(item) && sameOrigin(item.wiki.origin, request.wiki.origin));
    const ws = meta && liveSocket(meta);
    if (!ws || !getBridge()) {
      vscode.window.showWarningMessage(
        vscode.l10n.t('MediaWiki: The browser is not connected; cannot open the target page.'),
      );
      return false;
    }
    try {
      const reply = await getBridge()!.request<{opened: boolean}>(
        ws,
        {type: 'navigate-edit', title: request.title, fragment: request.fragment},
        5000,
      );
      if (!reply.opened) {
        vscode.window.showWarningMessage(
          vscode.l10n.t(
            'MediaWiki: The browser blocked the target page. Allow popups for this site and try again.',
          ),
        );
      }
      return !!reply.opened;
    } catch (error) {
      vscode.window.showWarningMessage(
        vscode.l10n.t('MediaWiki: Failed to open the target page: {0}', errorMessage(error)),
      );
      return false;
    }
  }

  async function saveInPage(
    sessionId: string,
    text: string,
    summary: string,
    minor: boolean,
  ): Promise<SaveOutcome> {
    const meta = sessionManager.get(sessionId);
    const ws = meta && liveSocket(meta);
    if (!meta || !ws || !getBridge()) {
      vscode.window.showWarningMessage(
        vscode.l10n.t('MediaWiki: The browser is not connected; cannot submit.'),
      );
      return {ok: false, error: vscode.l10n.t('Browser is not connected')};
    }
    try {
      const doc = vscode.workspace.textDocuments.find(
        document => document.uri.fsPath === meta.fsPath,
      );
      if (doc?.isDirty) await doc.save();
      const reply = await getBridge()!.request<{ok: boolean; error?: string}>(
        ws,
        {type: 'save', sessionId, text, summary, minor},
        15000,
      );
      return {ok: !!reply.ok, error: reply.error};
    } catch (error) {
      vscode.window.showWarningMessage(
        vscode.l10n.t('MediaWiki: Submission failed: {0}', errorMessage(error)),
      );
      return {ok: false, error: errorMessage(error)};
    }
  }

  async function requestSave(msg: RequestSaveMessage, ws: SocketLike): Promise<void> {
    const meta = sessionManager.get(msg.sessionId);
    if (!meta) return;
    const doc = vscode.workspace.textDocuments.find(
      document => document.uri.fsPath === meta.fsPath,
    );
    if (!doc) return;
    if (doc.isDirty) await doc.save();
    getBridge()?.send(ws, {
      type: 'save',
      sessionId: msg.sessionId,
      text: doc.getText(),
      summary: msg.summary,
      minor: msg.minor,
    });
  }

  async function restoreDraft(): Promise<void> {
    const drafts = sessionManager.drafts();
    if (!drafts.length) {
      vscode.window.showInformationMessage(
        vscode.l10n.t('MediaWiki: There are no drafts to restore.'),
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      drafts.map(([sessionId, meta]) => ({
        label: meta.title,
        description: meta.wiki.name,
        detail: meta.fsPath,
        sessionId,
        meta,
      })),
      {placeHolder: vscode.l10n.t('Select the draft to restore')},
    );
    if (!picked) return;
    const doc = await ensureSessionEditor(picked.meta);
    if (!doc) {
      vscode.window.showErrorMessage(
        vscode.l10n.t('MediaWiki: The draft file does not exist; cannot restore.'),
      );
      return;
    }
    vscode.window.showInformationMessage(
      vscode.l10n.t('MediaWiki: Restored the draft for {0}.', picked.meta.title),
    );
  }

  function edited(sessionId: string, text: string): boolean | undefined {
    const meta = sessionManager.get(sessionId);
    if (!meta?.originalHash) return undefined;
    return createHash('sha256').update(text).digest('hex') !== meta.originalHash;
  }

  function pageUrl(wiki: WikiRecord, title: string): string | undefined {
    const encoded = encodeURIComponent(String(title).replace(/ /gu, '_'))
      .replace(/%2F/giu, '/')
      .replace(/%3A/giu, ':');
    try {
      return new URL(
        (wiki.articlePath || `${wiki.origin}/$1`).replace(/\$1/gu, encoded),
        wiki.origin,
      ).href;
    } catch {
      return undefined;
    }
  }

  return {
    open,
    finish,
    markSaved,
    markSaveFailed,
    handleConflict,
    confirmSaved,
    registerWiki,
    query,
    navigate,
    saveInPage,
    requestSave,
    restoreDraft,
    pageUrl,
    ensureSessionEditor,
    edited,
  };
}
