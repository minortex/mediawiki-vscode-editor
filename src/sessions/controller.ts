import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
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
  requestSave(msg: RequestSaveMessage): Promise<void>;
  restoreDraft(): Promise<void>;
  pageUrl(wiki: WikiRecord, title: string): string | undefined;
  ensureSessionEditor(meta: SessionMeta): Promise<vscode.TextDocument | undefined>;
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
    meta.state = 'detached';
    return doc;
  }

  async function open(msg: OpenMessage, ws: SocketLike, wiki: WikiRecord): Promise<void> {
    const root = config().get<string>('tempDir') || defaultDir();
    const dir = wikis.directoryFor(root, wiki);
    await fs.promises.mkdir(dir, {recursive: true});
    const suffix = msg.section != null ? `.s${msg.section}` : '';
    const fsPath = path.join(dir, `${safeName(msg.title)}${suffix}.${stamp()}.wiki`);

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
      ws,
      title: msg.title,
      section: msg.section ?? null,
      wiki,
      revid: msg.revid,
      basetimestamp: msg.basetimestamp,
      starttimestamp: msg.starttimestamp,
      windowId: msg.windowId,
      created: Date.now(),
      state: 'attached',
      autoRestore: true,
    });

    const label = msg.section != null ? `${msg.title} § ${msg.section}` : msg.title;
    vscode.window.setStatusBarMessage(
      `MediaWiki: 正在编辑 ${wiki.name} 的 ${label}，保存文件即刷新浏览器预览`,
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
      sessionManager.markDraft(msg.sessionId);
      vscode.window.showWarningMessage(
        `MediaWiki: 提交未成功，临时文件已保留为草稿：${meta.fsPath}`,
      );
      return;
    }
    if (msg.result !== 'saved' && msg.result !== 'unchanged' && msg.result !== 'discarded') {
      sessionManager.markDraft(msg.sessionId);
      vscode.window.showWarningMessage(`MediaWiki: 编辑会话已断开，临时文件保留：${meta.fsPath}`);
      return;
    }
    if (msg.result === 'saved') {
      saveFailures.delete(msg.sessionId);
      sessionManager.markAwaitingConfirm(msg.sessionId);
      vscode.window.setStatusBarMessage(
        'MediaWiki: 已提交，等待浏览器确认新内容后清理临时文件',
        5000,
      );
      return;
    }
    saveFailures.delete(msg.sessionId);
    sessionManager.remove(msg.sessionId);
    await closeAndDelete(meta.fsPath);
    vscode.window.setStatusBarMessage('MediaWiki: 编辑会话已结束', 5000);
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
        `MediaWiki: 检测到编辑冲突，但找不到本地文件：${meta.fsPath}`,
      );
      return;
    }
    const local = doc.getText();
    const label = msg.remoteRevid
      ? `站点最新版本（rev ${msg.remoteRevid}）`
      : '站点最新版本';
    const merged = markConflict(local, msg.remoteText, label);
    if (merged === local) {
      vscode.window.showWarningMessage(
        'MediaWiki: 提交冲突，但本地内容与站点最新内容一致。',
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
        'MediaWiki: 提交冲突，但无法写入冲突标记。本地文件已保留。',
      );
      return;
    }
    await vscode.window.showTextDocument(doc, {preview: false});
    vscode.window.showWarningMessage(
      'MediaWiki: 检测到编辑冲突，已将本地版本与站点最新版本写入编辑器。请处理冲突标记后重新提交。',
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
        throw new Error('站点来源与浏览器连接不一致');
      }
      if (ws.origin && meta.wiki.origin && !sameOrigin(meta.wiki.origin, ws.origin)) {
        throw new Error('会话不属于当前站点');
      }
      const doc = vscode.workspace.textDocuments.find(
        document => document.uri.fsPath === meta.fsPath,
      );
      if (doc?.isDirty) {
        sessionManager.markDraft(msg.sessionId, false, true);
        vscode.window.showWarningMessage(
          `MediaWiki: 浏览器已显示新内容，但本地文件还有未提交修改，已保留为草稿：${meta.fsPath}`,
        );
        reply({ok: true});
        return;
      }
      clearDirty(meta.fsPath);
      sessionManager.remove(msg.sessionId);
      await closeAndDelete(meta.fsPath);
      vscode.window.setStatusBarMessage('MediaWiki: 浏览器已显示新内容，临时文件已清理', 5000);
      reply({ok: true});
    } catch (error) {
      reply({ok: false, error: errorMessage(error)});
      vscode.window.showWarningMessage(`MediaWiki: 清理临时文件失败：${errorMessage(error)}`);
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
      if (!requestId) throw new Error('缺少 requestId');
      if (!ws.origin || !msg.origin || !sameOrigin(msg.origin, ws.origin)) {
        throw new Error('站点来源与浏览器连接不一致');
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
      busy?: boolean;
      error?: string;
    }): void => {
      const response: SessionResultMessage = {
        type: 'session-result',
        requestId,
        ok: payload.ok,
        session: payload.session,
        busy: payload.busy,
        error: payload.error,
      };
      try {
        ws.send(JSON.stringify(response));
      } catch {}
    };
    try {
      if (!requestId) throw new Error('缺少 requestId');
      if (!ws.origin || !msg.origin || !sameOrigin(msg.origin, ws.origin)) {
        throw new Error('站点来源与浏览器连接不一致');
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
        .sort(([, a], [, b]) => {
          const af = a.section == null ? 0 : 1;
          const bf = b.section == null ? 0 : 1;
          return af - bf || b.created - a.created;
        });
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
      const sameWindow =
        !!msg.windowId && !!meta.windowId && msg.windowId === meta.windowId;
      const socketAlive =
        !!meta.ws &&
        (meta.ws.readyState === undefined || meta.ws.readyState === 1);
      if (socketAlive && meta.ws !== ws && !sameWindow) {
        reply({ok: true, session: null, busy: true});
        return;
      }
      if (meta.ws && meta.ws !== ws) {
        try {
          meta.ws.send(JSON.stringify({type: 'preempted', sessionId}));
        } catch {}
      }
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
          section: meta.section,
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
      .find(item => item.ws && sameOrigin(item.wiki.origin, request.wiki.origin));
    if (!meta?.ws || !getBridge()) {
      vscode.window.showWarningMessage('MediaWiki: 浏览器未连接，无法打开目标页面。');
      return false;
    }
    try {
      const reply = await getBridge()!.request<{opened: boolean}>(
        meta.ws,
        {type: 'navigate-edit', title: request.title, fragment: request.fragment},
        5000,
      );
      if (!reply.opened) {
        vscode.window.showWarningMessage(
          'MediaWiki: 浏览器拦截了目标页面，请允许本站弹窗后重试。',
        );
      }
      return !!reply.opened;
    } catch (error) {
      vscode.window.showWarningMessage(`MediaWiki: 打开目标页面失败：${errorMessage(error)}`);
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
    if (!meta?.ws || !getBridge()) {
      vscode.window.showWarningMessage('MediaWiki: 浏览器未连接，无法提交。');
      return {ok: false, error: '浏览器未连接'};
    }
    try {
      const doc = vscode.workspace.textDocuments.find(
        document => document.uri.fsPath === meta.fsPath,
      );
      if (doc?.isDirty) await doc.save();
      const reply = await getBridge()!.request<{ok: boolean; error?: string}>(
        meta.ws,
        {type: 'save', sessionId, text, summary, minor},
        15000,
      );
      return {ok: !!reply.ok, error: reply.error};
    } catch (error) {
      vscode.window.showWarningMessage(`MediaWiki: 提交失败：${errorMessage(error)}`);
      return {ok: false, error: errorMessage(error)};
    }
  }

  async function requestSave(msg: RequestSaveMessage): Promise<void> {
    const meta = sessionManager.get(msg.sessionId);
    if (!meta) return;
    const doc = vscode.workspace.textDocuments.find(
      document => document.uri.fsPath === meta.fsPath,
    );
    if (!doc) return;
    if (doc.isDirty) await doc.save();
    getBridge()?.broadcast({
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
      vscode.window.showInformationMessage('MediaWiki: 没有可恢复的草稿。');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      drafts.map(([sessionId, meta]) => ({
        label: meta.title,
        description: meta.section == null ? meta.wiki.name : `${meta.wiki.name} § ${meta.section}`,
        detail: meta.fsPath,
        sessionId,
        meta,
      })),
      {placeHolder: '选择要恢复的草稿'},
    );
    if (!picked) return;
    const doc = await ensureSessionEditor(picked.meta);
    if (!doc) {
      vscode.window.showErrorMessage('MediaWiki: 草稿文件不存在，无法恢复。');
      return;
    }
    vscode.window.showInformationMessage(`MediaWiki: 已恢复 ${picked.meta.title} 的草稿。`);
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
  };
}
