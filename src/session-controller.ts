'use strict';

const {normalizeOrigin} = require('./wiki-config');

function createSessionController(deps: any): any {
  const {
    vscode,
    fs,
    path,
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

  function sameOrigin(a: any, b: any): boolean {
    try {
      return normalizeOrigin(a) === normalizeOrigin(b);
    } catch {
      return false;
    }
  }

  async function ensureSessionEditor(meta: any): Promise<any> {
    let doc = vscode.workspace.textDocuments.find((d: any) => d.uri.fsPath === meta.fsPath);
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
    if (language) language.check(doc, meta.wiki, meta.title).catch(() => {});
    meta.state = 'detached';
    return doc;
  }

  async function open(msg: any, ws: any, wiki: any): Promise<void> {
    const root = config().get('tempDir') || defaultDir();
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
    if (language) language.check(doc, wiki, msg.title).catch(() => {});

    sessionManager.add(msg.sessionId, {
      fsPath,
      ws,
      title: msg.title,
      section: msg.section ?? null,
      wiki,
      revid: msg.revid,
      basetimestamp: msg.basetimestamp,
      starttimestamp: msg.starttimestamp,
      created: Date.now(),
      state: 'attached',
      autoRestore: true,
    });

    const label = msg.section != null ? `${msg.title} § ${msg.section}` : msg.title;
    vscode.window.setStatusBarMessage(
      `MediaWiki: 正在编辑 ${wiki.name} 的 ${label}，保存文件即刷新浏览器预览`,
      8000
    );
  }

  async function finish(msg: any): Promise<void> {
    const meta = sessionManager.get(msg.sessionId);
    if (!meta) return;
    clearDirty(meta.fsPath);
    if (!new Set(['saved', 'unchanged', 'discarded']).has(msg.result)) {
      sessionManager.markDraft(msg.sessionId);
      vscode.window.showWarningMessage(`MediaWiki: 编辑会话已断开，临时文件保留：${meta.fsPath}`);
      return;
    }
    sessionManager.remove(msg.sessionId);
    await closeAndDelete(meta.fsPath);
    vscode.window.setStatusBarMessage(
      msg.result === 'saved' ? 'MediaWiki: 已在浏览器提交保存' : 'MediaWiki: 编辑会话已结束',
      5000
    );
  }

  async function registerWiki(msg: any, ws: any): Promise<void> {
    const requestId = msg.requestId;
    const reply = (payload: any) => {
      try {
        ws.send(JSON.stringify({type: 'wiki-registered', requestId, ...payload}));
      } catch {}
    };
    try {
      if (!requestId) throw new Error('缺少 requestId');
      if (!ws.origin || !msg.origin || !sameOrigin(msg.origin, ws.origin)) {
        throw new Error('站点来源与浏览器连接不一致');
      }
      const before = wikis.find(context, msg.origin);
      const entry = await wikis.upsert(context, {
        origin: msg.origin,
        api: msg.api,
        name: msg.name,
        siteinfo: msg.siteinfo,
      });
      if (!before || before.siteinfoHash !== entry.siteinfoHash) getLanguageFeatures()?.refresh();
      reply({ok: true, wiki: {id: entry.id, name: entry.name, origin: entry.origin}});
    } catch (error) {
      reply({ok: false, error: error.message});
    }
  }

  function normalizePageName(value: any): string {
    return String(value || '').replace(/_/gu, ' ').replace(/\s+/gu, ' ').trim().toLowerCase();
  }

  async function query(msg: any, ws: any): Promise<void> {
    const requestId = msg.requestId;
    const reply = (payload: any) => {
      try {
        ws.send(JSON.stringify({type: 'session-result', requestId, ...payload}));
      } catch {}
    };
    try {
      if (!requestId) throw new Error('缺少 requestId');
      if (!ws.origin || !msg.origin || !sameOrigin(msg.origin, ws.origin)) {
        throw new Error('站点来源与浏览器连接不一致');
      }
      const title = normalizePageName(msg.title);
      if (!title) return reply({ok: true, session: null});
      const candidates = sessionManager.entries()
        .filter(([, meta]: [string, any]) => sameOrigin(meta.wiki.origin, msg.origin)
          && normalizePageName(meta.title) === title
          && (meta.state !== 'draft' || meta.autoRestore))
        .sort(([, a]: [string, any], [, b]: [string, any]) => {
          const af = a.section == null ? 0 : 1;
          const bf = b.section == null ? 0 : 1;
          return af - bf || b.created - a.created;
        });
      let picked;
      for (const [sessionId, meta] of candidates) {
        if (meta.state === 'draft') {
          const editor = await ensureSessionEditor(meta);
          if (!editor) continue;
        }
        let text;
        try {
          const doc = vscode.workspace.textDocuments.find((d: any) => d.uri.fsPath === meta.fsPath);
          text = doc ? doc.getText() : await fs.promises.readFile(meta.fsPath, 'utf8');
        } catch {
          continue;
        }
        picked = {sessionId, meta, text};
        break;
      }
      if (!picked) return reply({ok: true, session: null});
      const {sessionId, meta, text} = picked;
      if (meta.ws && meta.ws !== ws) {
        try {
          meta.ws.send(JSON.stringify({type: 'preempted', sessionId}));
        } catch {}
      }
      sessionManager.attach(sessionId, ws);
      sessionManager.markAttached(sessionId);
      const doc = vscode.workspace.textDocuments.find((d: any) => d.uri.fsPath === meta.fsPath);
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
      reply({ok: false, error: error.message});
    }
  }

  async function navigate({wiki, title, fragment}: any): Promise<boolean> {
    const meta = sessionManager.values().find(
      (item: any) => item.ws && sameOrigin(item.wiki.origin, wiki.origin)
    );
    if (!meta?.ws || !getBridge()) {
      vscode.window.showWarningMessage('MediaWiki: 浏览器未连接，无法打开目标页面。');
      return false;
    }
    try {
      const reply = await getBridge().request(meta.ws, {type: 'navigate-edit', title, fragment}, 5000);
      if (!reply.opened) {
        vscode.window.showWarningMessage('MediaWiki: 浏览器拦截了目标页面，请允许本站弹窗后重试。');
      }
      return !!reply.opened;
    } catch (error) {
      vscode.window.showWarningMessage(`MediaWiki: 打开目标页面失败：${error.message}`);
      return false;
    }
  }

  async function saveInPage(sessionId: any, text: any, summary: any, minor: any): Promise<any> {
    const meta = sessionManager.get(sessionId);
    if (!meta?.ws || !getBridge()) {
      vscode.window.showWarningMessage('MediaWiki: 浏览器未连接，无法提交。');
      return {ok: false, error: '浏览器未连接'};
    }
    try {
      const reply = await getBridge().request(
        meta.ws,
        {type: 'save', sessionId, text, summary, minor},
        15000
      );
      return {ok: !!reply.ok, error: reply.error};
    } catch (error) {
      vscode.window.showWarningMessage(`MediaWiki: 提交失败：${error.message}`);
      return {ok: false, error: error.message};
    }
  }

  async function requestSave(msg: any): Promise<void> {
    const meta = sessionManager.get(msg.sessionId);
    if (!meta) return;
    const doc = vscode.workspace.textDocuments.find((d: any) => d.uri.fsPath === meta.fsPath);
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

  async function restoreDraft() {
    const drafts = sessionManager.drafts();
    if (!drafts.length) {
      vscode.window.showInformationMessage('MediaWiki: 没有可恢复的草稿。');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      drafts.map(([sessionId, meta]: [string, any]) => ({
        label: meta.title,
        description: meta.section == null ? meta.wiki.name : `${meta.wiki.name} § ${meta.section}`,
        detail: meta.fsPath,
        sessionId,
        meta,
      })),
      {placeHolder: '选择要恢复的草稿'}
    );
    if (!picked) return;
    const doc = await ensureSessionEditor(picked.meta);
    if (!doc) {
      vscode.window.showErrorMessage('MediaWiki: 草稿文件不存在，无法恢复。');
      return;
    }
    vscode.window.showInformationMessage(`MediaWiki: 已恢复 ${picked.meta.title} 的草稿。`);
  }

  function pageUrl(wiki: any, title: any): string | undefined {
    const encoded = encodeURIComponent(String(title).replace(/ /gu, '_'))
      .replace(/%2F/giu, '/')
      .replace(/%3A/giu, ':');
    try {
      return new URL((wiki.articlePath || `${wiki.origin}/$1`).replace(/\$1/gu, encoded), wiki.origin).href;
    } catch {
      return undefined;
    }
  }

  return {open, finish, registerWiki, query, navigate, saveInPage, requestSave, restoreDraft, pageUrl, ensureSessionEditor};
}

module.exports = {createSessionController};
