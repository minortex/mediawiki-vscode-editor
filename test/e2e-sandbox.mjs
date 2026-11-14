/**
 * End-to-end check against a real wiki page in an existing Chrome instance:
 * the built InPageEdit plugin (ipe-plugin/dist/index.mjs) is injected over CDP,
 * and the VSCode extension side runs the compiled SessionController (out/).
 *
 * What it proves: a save is only cleaned up after the wiki reports a revision
 * id, the confirmation carries that id, the temp file is deleted only then,
 * and the stored revision really contains the submitted text. It also walks
 * the failure chain: an edit answer without a revision id keeps the temp file
 * and the session, the extension rejects a confirmation without a revision
 * id, a retry can still succeed, and the no-change fallback accepts the
 * latest revision only when its content matches the submission.
 *
 * Prerequisites:
 *   npm run compile && npm run build:ipe
 *   Chrome with --remote-debugging-port=9222 and a logged-in session
 *   Nothing else listening on WS_PORT (the VSCode extension must be closed)
 *
 * Usage:
 *   node test/e2e-sandbox.mjs
 *   TARGET_URL=https://example.org/wiki/Sandbox node test/e2e-sandbox.mjs
 *   BROWSER_PORT=9333 WS_PORT=8930 node test/e2e-sandbox.mjs
 *
 * Without TARGET_URL it reuses the wiki tab that is already open in the
 * browser (the first one whose MediaWiki context is ready).
 *
 * WARNING: it performs a real edit of the target page (appends an "E2E revid
 * check" line), so use a sandbox page you own.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(REPO, 'package.json'));
const {WebSocketServer, WebSocket} = require('ws');

const WS_PORT = Number(process.env.WS_PORT || 8927);
const CDP_PORT = Number(process.env.BROWSER_PORT || 9222);
const NOT_A_PAGE = /^(chrome|chrome-extension|devtools|edge|about):/iu;

const results = [];
const ok = (name, detail) => results.push({name, ok: true, detail});
const bad = (name, detail) => results.push({name, ok: false, detail});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The extension side: compiled SessionController with a minimal vscode stub. */
function bootExtension(tempRoot, origin) {
  const vscodeStub = {
    Uri: {file: p => ({fsPath: p})},
    workspace: {
      textDocuments: [],
      applyEdit: async () => true,
      openTextDocument: async uri => ({
        uri,
        isDirty: false,
        getText: () => fs.readFileSync(uri.fsPath, 'utf8'),
      }),
    },
    l10n: {t: (message, ...args) => String(message).replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '')},
    window: {
      setStatusBarMessage() {},
      showWarningMessage() {},
      showInformationMessage() {},
      showErrorMessage() {},
      showTextDocument: async () => undefined,
    },
    WorkspaceEdit: class {},
    Range: class {},
    StatusBarAlignment: {Right: 2},
  };

  const loadModule = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscodeStub;
    return loadModule.call(this, request, parent, isMain);
  };
  const {SessionManager} = require(path.join(REPO, 'out/sessions/manager.js'));
  const {SessionStore} = require(path.join(REPO, 'out/sessions/store.js'));
  const {createSessionController} = require(path.join(REPO, 'out/sessions/controller.js'));

  const state = {
    manager: new SessionManager(new SessionStore(undefined), () => {}),
    deleted: [],
    confirmations: [],
    opens: [],
    saveResults: [],
    vscode: vscodeStub,
  };
  const pendingRequests = new Map();
  let requestSeq = 0;
  const bridge = {
    send(ws, message) {
      try {
        ws.send(JSON.stringify(message));
        return true;
      } catch {
        return false;
      }
    },
    request(ws, message, timeoutMs = 20000) {
      const requestId = `req-${++requestSeq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(requestId);
          reject(new Error('request timeout'));
        }, timeoutMs);
        pendingRequests.set(requestId, {resolve, reject, timer});
        if (!this.send(ws, {...message, requestId})) {
          clearTimeout(timer);
          pendingRequests.delete(requestId);
          reject(new Error('browser not connected'));
        }
      });
    },
  };
  function settleRequest(msg) {
    const pending = pendingRequests.get(msg.requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pendingRequests.delete(msg.requestId);
    if (msg.ok === false) pending.reject(new Error(msg.error || 'browser request failed'));
    else pending.resolve(msg);
    return true;
  }

  const wikis = {
    directoryFor(root, wiki) {
      return path.join(root, wiki.id);
    },
    resolve() {
      return undefined;
    },
    async upsert() {
      return {id: 'e2e', name: 'E2E', origin, siteinfoHash: 'h0'};
    },
  };
  const wiki = {id: 'e2e', name: 'E2E', origin, articlePath: '/wiki/$1'};

  const controller = createSessionController({
    sessionManager: state.manager,
    getBridge: () => bridge,
    wikis,
    context: {},
    config: () => ({get: () => undefined}),
    defaultDir: () => tempRoot,
    safeName: value => String(value).replace(/[^\w.-]+/g, '_'),
    stamp: () => 'now',
    closeAndDelete: async fsPath => {
      state.deleted.push(fsPath);
      fs.rmSync(fsPath, {force: true});
    },
    updateStatus() {},
    clearDirty() {},
    getLanguageFeatures: () => undefined,
  });

  function dispatch(msg, ws) {
    if (settleRequest(msg)) return;
    try {
      if (msg.type === 'register-wiki') void controller.registerWiki(msg, ws);
      else if (msg.type === 'session-query') void controller.query(msg, ws);
      else if (msg.type === 'open') {
        state.opens.push(msg);
        void controller.open(msg, ws, wiki);
      } else if (msg.type === 'finish') void controller.finish(msg);
      else if (msg.type === 'save-result') {
        state.saveResults.push(msg);
        if (msg.ok) controller.markSaved(msg.sessionId);
        else controller.markSaveFailed(msg.sessionId);
      } else if (msg.type === 'conflict') void controller.handleConflict(msg);
      else if (msg.type === 'save-confirmed') {
        state.confirmations.push(msg);
        void controller.confirmSaved(msg, ws);
      } else if (msg.type === 'request-save') void controller.requestSave(msg, ws);
    } catch {}
  }

  return {state, controller, dispatch};
}

async function cdpJson(pathname, init) {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}${pathname}`, init);
  return response.json();
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {perMessageDeflate: false});
    const timer = setTimeout(() => reject(new Error('cdp connect timeout')), 5000);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data.toString());
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      entry(msg);
    });
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        send(method, params = {}) {
          return new Promise(res => {
            const id = ++seq;
            pending.set(id, res);
            ws.send(JSON.stringify({id, method, params}));
          });
        },
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function injectionScript(pluginSource) {
  return `(() => {
  const translate = (key, ...args) =>
    String(key).replace(/\\{\\{\\s*\\$(\\d+)\\s*\\}\\}/g, (_, i) => args[Number(i) - 1] ?? '')
  const api = () => new mw.Api()
  const revisionContent = rev => rev.slots?.main?.content ?? rev.content
  async function latest(title) {
    const reply = await api().get({
      action: 'query', formatversion: '2', prop: 'revisions',
      rvprop: 'ids|content|timestamp', rvslots: 'main', titles: title, rvlimit: '1',
    })
    const rev = reply.query.pages[0].revisions[0]
    return {revid: rev.revid, content: revisionContent(rev), timestamp: rev.timestamp}
  }
  async function byRevid(revid) {
    const reply = await api().get({
      action: 'query', formatversion: '2', prop: 'revisions',
      rvprop: 'ids|content|timestamp', rvslots: 'main', revids: String(revid),
    })
    const rev = reply.query.pages[0].revisions[0]
    return {revid: rev.revid, content: revisionContent(rev), timestamp: rev.timestamp}
  }
  function pageFor(title, revision) {
    return {
      title,
      revisions: [revision],
      async edit(payload) {
        // Fallback-chain probes: answer without touching the wiki so the
        // "no new revision" cases can be exercised repeatedly.
        const failEdit = window.__e2e?.failEdit
        if (failEdit === 'norevid') {
          return {data: {edit: {result: 'Success', pageid: 1, title, contentmodel: 'wikitext'}}}
        }
        if (failEdit === 'nochange') {
          return {data: {edit: {result: 'Success', pageid: 1, title, contentmodel: 'wikitext', nochange: true}}}
        }
        const data = await api().postWithToken('csrf', {
          action: 'edit', title, formatversion: '2',
          text: payload.text,
          summary: payload.summary || '',
          minor: payload.minor ? 1 : 0,
          watchlist: payload.watchlist || 'nochange',
        })
        return {data}
      },
    }
  }
  const button = document.createElement('button')
  button.id = 'e2e-edit'
  button.style.display = 'none'
  const ctx = {
    i18n: {manager: {translate, setLanguageData() {}}},
    toolbox: {addButton(options) { button.onclick = options.onClick; document.body.append(button); return button }, removeButton() {}},
    on() {},
    modal: {show() {}, close() {}, notify() {}},
    wikiPage: {
      async newFromTitle(title) { return pageFor(title, await latest(title)) },
      async newFromRevision(revid) { return pageFor(mw.config.get('wgPageName'), await byRevid(revid)) },
    },
    quickDiff: {comparePages() {}},
    quickUpload: {showModal() {}},
    templatesUsed: {showModal() {}},
  }
  const NativeWebSocket = window.WebSocket
  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols)
      this.addEventListener('open', () => { window.__wsOpen = true })
      this.addEventListener('close', () => { window.__wsOpen = false })
    }
  }
  const src = ${JSON.stringify(pluginSource)}
  ;(0, eval)(src.replace(/export\\s*\\{\\s*(\\w+)\\s+as\\s+default\\s*\\};?/, 'window.__plugin = $1;'))
  window.__plugin.apply(ctx)
  window.__e2e = {click: () => button.click(), latest}
  const PENDING_KEY = 'mwe-ipe-pending-save-confirmation'
  let clicked = false
  const timer = setInterval(() => {
    if (clicked) { clearInterval(timer); return }
    // After a reload that still owes a save-confirmed, stay idle.
    if (sessionStorage.getItem(PENDING_KEY)) { clearInterval(timer); return }
    if (!window.__wsOpen) return
    if (document.querySelector('.mwe-ipe-bar')) { clearInterval(timer); return }
    clicked = true
    clearInterval(timer)
    button.click()
  }, 200)
  return {installed: typeof window.__plugin?.apply === 'function'}
})()`;
}

function sameUrl(a, b) {
  if (a === b) return true;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/** Probe one tab for a ready MediaWiki context. */
async function isWikiTab(wsUrl) {
  const cdp = await connectCdp(wsUrl);
  try {
    const reply = await Promise.race([
      cdp.send('Runtime.evaluate', {
        expression: 'document.readyState === "complete" && !!window.mw && typeof mw.loader?.using === "function" && typeof mw.Api === "function" && !!mw.config.get("wgPageName")',
        returnByValue: true,
      }),
      sleep(5000).then(() => undefined),
    ]);
    return reply?.result?.result?.value === true;
  } finally {
    cdp.close();
  }
}

/**
 * TARGET_URL (or the legacy SANDBOX_URL) wins; otherwise reuse the wiki tab
 * that is already open in the browser. A missing tab is opened from the URL.
 */
async function resolveTarget(targets) {
  const requested = process.env.TARGET_URL || process.env.SANDBOX_URL || '';
  if (requested) {
    const existing = targets.find(item => item.type === 'page' && sameUrl(item.url, requested))
      ?? targets.find(item => item.type === 'page' && item.url.startsWith(requested));
    if (existing) return {pageUrl: existing.url, target: existing, openedTarget: false};
    const opened = await cdpJson(`/json/new?${encodeURIComponent(requested)}`, {method: 'PUT'});
    return {pageUrl: opened.url || requested, target: opened, openedTarget: true};
  }
  const pages = targets.filter(item => item.type === 'page' && !NOT_A_PAGE.test(item.url));
  for (const page of pages) {
    try {
      if (await isWikiTab(page.webSocketDebuggerUrl)) {
        return {pageUrl: page.url, target: page, openedTarget: false};
      }
    } catch {}
  }
  throw new Error('no MediaWiki page found in the browser; open one or set TARGET_URL');
}

async function main() {
  const pluginPath = path.join(REPO, 'ipe-plugin/dist/index.mjs');
  if (!fs.existsSync(pluginPath)) throw new Error('missing build: run npm run build:ipe');
  if (!fs.existsSync(path.join(REPO, 'out/sessions/controller.js'))) {
    throw new Error('missing build: run npm run compile');
  }
  // The bundle hardcodes the extension port; follow WS_PORT when overridden.
  const pluginSource = fs
    .readFileSync(pluginPath, 'utf8')
    .replaceAll('ws://127.0.0.1:8927', `ws://127.0.0.1:${WS_PORT}`);
  const {pageUrl, target, openedTarget} = await resolveTarget(await cdpJson('/json/list'));
  const ORIGIN = new URL(pageUrl).origin;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mwe-e2e-'));
  const {state, controller, dispatch} = bootExtension(tempRoot, ORIGIN);

  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: WS_PORT,
    verifyClient: (info, done) => done(!info.req.headers.origin || info.req.headers.origin === ORIGIN),
  });
  wss.on('connection', (ws, req) => {
    // The controller validates the socket origin itself.
    ws.origin = req.headers.origin;
    ws.on('message', raw => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      dispatch(msg, ws);
    });
  });
  await new Promise(resolve => wss.once('listening', resolve));
  console.log(`extension ws on :${WS_PORT}, cdp on :${CDP_PORT}`);
  console.log(`target page: ${pageUrl}${openedTarget ? ' (opened a fresh tab)' : ''}`);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);

  const evaluate = async (expression, timeoutMs = 15000) => {
    const reply = await Promise.race([
      cdp.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}),
      sleep(timeoutMs).then(() => { throw new Error('evaluate timeout'); }),
    ]);
    if (reply.result?.exceptionDetails) {
      const details = reply.result.exceptionDetails;
      throw new Error(details.exception?.description || details.text || 'evaluate failed');
    }
    return reply.result?.result?.value;
  };
  const waitFor = async (label, fn, timeoutMs = 20000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const value = await fn();
        if (value) return value;
      } catch {}
      await sleep(150);
    }
    throw new Error(`timeout: ${label}`);
  };

  try {
    // Background tabs can stall their ResourceLoader queue; activate first.
    await cdpJson(`/json/activate/${target.id}`).catch(() => undefined);
    const stale = await evaluate('!!window.__plugin').catch(() => true);
    if (stale) {
      // Fresh page state: drop a stale plugin/harness instance before injecting.
      await evaluate('location.reload(); true').catch(() => undefined);
    }
    // A leftover confirmation would keep the injected plugin idle.
    await evaluate("sessionStorage.removeItem('mwe-ipe-pending-save-confirmation'); true").catch(() => undefined);
    try {
      await waitFor(
        'page ready',
        () => evaluate('document.readyState === "complete" && !!window.mw && !window.__plugin && typeof mw.loader?.using === "function" && typeof mw.Api === "function" && !!mw.config.get("wgPageName")'),
        60000,
      );
    } catch (error) {
      const debug = await evaluate(`({
        ready: document.readyState,
        plugin: !!window.__plugin,
        loader: typeof window.mw?.loader?.using,
        api: typeof window.mw?.Api,
        page: window.mw?.config?.get?.('wgPageName'),
        rlq: typeof window.RLQ,
      })`).catch(() => undefined);
      throw new Error(`${error.message}; state=${JSON.stringify(debug)}`);
    }

    const startRevid = await evaluate(`new mw.Api().get({
      action: 'query', formatversion: '2', prop: 'revisions', rvprop: 'ids',
      rvslots: 'main', titles: mw.config.get('wgPageName'), rvlimit: '1',
    }).then(r => r.query.pages[0].revisions[0].revid)`);

    const injected = await evaluate(injectionScript(pluginSource));
    if (injected?.installed) ok('plugin injected into the page', JSON.stringify(injected));
    else bad('plugin injected into the page', JSON.stringify(injected));

    const setFailEdit = mode => evaluate(`window.__e2e.failEdit = ${JSON.stringify(mode)}; true`);
    const openSession = async index => {
      await evaluate('window.__e2e.click(); true');
      const open = await waitFor(`open session ${index}`, () => state.opens[index], 30000);
      const fsPath = await waitFor(
        `temp file ${index}`,
        () => state.manager.get(open.sessionId)?.fsPath,
        10000,
      );
      return {open, fsPath, original: fs.readFileSync(fsPath, 'utf8')};
    };
    const submitSave = async (fsPath, text, summary) => {
      state.vscode.workspace.textDocuments = [{
        uri: {fsPath},
        isDirty: false,
        getText: () => text,
      }];
      const before = state.saveResults.length;
      const clicked = await evaluate(`(() => {
        const summary = document.querySelector('.mwe-ipe-summary-input')
        if (summary) summary.value = ${JSON.stringify(summary)}
        const submit = document.querySelector('.mwe-ipe-submit')
        if (!submit) return 'no-submit'
        submit.click()
        return 'clicked'
      })()`);
      if (clicked !== 'clicked') throw new Error(`submit not available: ${clicked}`);
      return waitFor(`save-result ${before}`, () => state.saveResults[before], 45000);
    };
    // A successful save always reloads the page; re-inject so the pending
    // confirmation and the next phase have a live plugin instance.
    const reinjectAfterReload = async () => {
      await waitFor('page reload', async () => {
        try {
          return await evaluate('document.readyState === "complete" && !!window.mw && typeof mw.Api === "function" && !window.__plugin');
        } catch {
          return false;
        }
      }, 40000);
      const again = await evaluate(injectionScript(pluginSource));
      if (again?.installed !== true) throw new Error('re-injection after reload failed');
    };
    const verifyRevision = async (revid, marker) => {
      // The plugin may close a tab it opened once the save is confirmed, so
      // verify the stored revision from a fresh tab sharing profile cookies.
      const verifyTarget = await cdpJson(`/json/new?${encodeURIComponent(pageUrl)}`, {method: 'PUT'});
      const verifyCdp = await connectCdp(verifyTarget.webSocketDebuggerUrl);
      const verifyEvaluate = async expression => {
        const reply = await Promise.race([
          verifyCdp.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}),
          sleep(20000).then(() => { throw new Error('verify evaluate timeout'); }),
        ]);
        if (reply.result?.exceptionDetails) {
          throw new Error(reply.result.exceptionDetails.text || 'verify failed');
        }
        return reply.result?.result?.value;
      };
      try {
        await waitFor('verify tab ready', async () => {
          try {
            return await verifyEvaluate('document.readyState === "complete" && !!window.mw && typeof mw.Api === "function" && !!mw.config.get("wgPageName")');
          } catch {
            return false;
          }
        }, 40000);
        return await verifyEvaluate(`new mw.Api().get({
          action: 'query', formatversion: '2', prop: 'revisions',
          rvprop: 'ids|content', rvslots: 'main', revids: String(${revid}),
        }).then(r => {
          const rev = r.query.pages[0].revisions[0]
          const content = rev.slots?.main?.content ?? rev.content
          return {revid: rev.revid, hasMarker: content.includes(${JSON.stringify(marker)})}
        })`);
      } finally {
        verifyCdp.close();
        await cdpJson(`/json/close/${verifyTarget.id}`).catch(() => undefined);
      }
    };

    // ---- phase 1: a normal save gets a revid and cleans up ----
    const first = await openSession(0);
    ok('session opened', `${first.open.sessionId} -> ${first.fsPath} (${fs.statSync(first.fsPath).size} bytes)`);
    const marker = `E2E revid check ${new Date().toISOString()}`;
    const nextText = `${first.original.replace(/\s*$/u, '')}\n\n${marker}\n`;
    const firstResult = await submitSave(first.fsPath, nextText, 'E2E atomic save check');
    if (firstResult.ok === true) ok('save-result reported success', JSON.stringify(firstResult));
    else bad('save-result reported success', JSON.stringify(firstResult));
    if (firstResult.ok === true) await reinjectAfterReload();

    const confirmed = await waitFor('revid confirmation', () => state.confirmations[0], 45000);
    const revid = Number(confirmed.revid);
    if (Number.isInteger(revid) && revid > 0 && revid > startRevid) {
      ok('save-confirmed carries the new revid', `revid=${revid} (before=${startRevid})`);
    } else {
      bad('save-confirmed carries the new revid', JSON.stringify({revid: confirmed.revid, startRevid}));
    }

    await waitFor('temp file deleted', () => !fs.existsSync(first.fsPath), 15000);
    ok('temp file deleted after revid confirmation', first.fsPath);
    if (state.manager.get(first.open.sessionId)) bad('session removed after cleanup', 'still present');
    else ok('session removed after cleanup', first.open.sessionId);

    const verify = await verifyRevision(revid, marker);
    if (verify?.revid === revid && verify?.hasMarker) {
      ok('wiki revision matches the confirmation', JSON.stringify(verify));
    } else {
      bad('wiki revision matches the confirmation', JSON.stringify({verify, revid}));
    }

    // ---- phase 2: edit answer without a revid keeps file and session ----
    await setFailEdit('norevid');
    const failed = await openSession(1);
    const failedMarker = `E2E fallback check ${new Date().toISOString()}`;
    const failedText = `${failed.original.replace(/\s*$/u, '')}\n\n${failedMarker}\n`;
    const confirmationsBeforeFailure = state.confirmations.length;
    const unconfirmed = await submitSave(failed.fsPath, failedText, 'E2E fallback check');
    if (unconfirmed.ok === false) {
      ok('save without revid is reported as unconfirmed', JSON.stringify(unconfirmed));
    } else {
      bad('save without revid is reported as unconfirmed', JSON.stringify(unconfirmed));
    }
    if (/未能确认|no revision id could be confirmed/u.test(String(unconfirmed.error || ''))) {
      ok('unconfirmed error names the missing revision id', unconfirmed.error);
    } else {
      bad('unconfirmed error names the missing revision id', String(unconfirmed.error || ''));
    }
    await sleep(1500);
    if (state.confirmations.length === confirmationsBeforeFailure) {
      ok('no save-confirmed without a revid', `confirmations=${state.confirmations.length}`);
    } else {
      bad('no save-confirmed without a revid', JSON.stringify(state.confirmations.slice(confirmationsBeforeFailure)));
    }
    if (fs.existsSync(failed.fsPath)) ok('temp file kept when no revid', failed.fsPath);
    else bad('temp file kept when no revid', failed.fsPath);
    if (state.manager.get(failed.open.sessionId)) ok('session kept when no revid', failed.open.sessionId);
    else bad('session kept when no revid', failed.open.sessionId);

    // ---- phase 3: the extension rejects a confirmation without a revid ----
    const guardSocket = {
      origin: ORIGIN,
      sent: [],
      send(value) {
        this.sent.push(JSON.parse(value));
      },
    };
    controller.markSaved(failed.open.sessionId);
    await controller.confirmSaved(
      {type: 'save-confirmed', sessionId: failed.open.sessionId, origin: ORIGIN},
      guardSocket,
    );
    const guardReply = guardSocket.sent.at(-1);
    if (guardReply?.ok === false) {
      ok('extension rejects save-confirmed without revid', JSON.stringify(guardReply));
    } else {
      bad('extension rejects save-confirmed without revid', JSON.stringify(guardReply));
    }
    if (fs.existsSync(failed.fsPath)) ok('extension keeps the temp file without revid', failed.fsPath);
    else bad('extension keeps the temp file without revid', failed.fsPath);
    if (state.manager.get(failed.open.sessionId)) ok('extension keeps the session without revid', failed.open.sessionId);
    else bad('extension keeps the session without revid', failed.open.sessionId);

    // ---- phase 4: retrying the same session succeeds and cleans up ----
    await setFailEdit('');
    const retry = await submitSave(failed.fsPath, failedText, 'E2E retry check');
    if (retry.ok === true) ok('retry after unconfirmed save succeeds', JSON.stringify(retry));
    else bad('retry after unconfirmed save succeeds', JSON.stringify(retry));
    if (retry.ok === true) await reinjectAfterReload();
    const retryConfirmed = await waitFor('retry confirmation', () => state.confirmations[1], 45000);
    const retryRevid = Number(retryConfirmed.revid);
    if (Number.isInteger(retryRevid) && retryRevid > revid) {
      ok('retry confirmed a newer revid', `revid=${retryRevid} (previous=${revid})`);
    } else {
      bad('retry confirmed a newer revid', JSON.stringify({retryRevid, revid}));
    }
    await waitFor('retry temp file deleted', () => !fs.existsSync(failed.fsPath), 15000);
    ok('retry temp file deleted after confirmation', failed.fsPath);
    if (state.manager.get(failed.open.sessionId)) bad('retry session removed', 'still present');
    else ok('retry session removed', failed.open.sessionId);
    const retryVerify = await verifyRevision(retryRevid, failedMarker);
    if (retryVerify?.revid === retryRevid && retryVerify?.hasMarker) {
      ok('retry revision matches the confirmation', JSON.stringify(retryVerify));
    } else {
      bad('retry revision matches the confirmation', JSON.stringify({retryVerify, retryRevid}));
    }

    // ---- phase 5: nochange fallback accepts the latest revision by content ----
    await setFailEdit('nochange');
    const nochange = await openSession(2);
    const nochangeResult = await submitSave(nochange.fsPath, nochange.original, 'E2E nochange check');
    if (nochangeResult.ok === true) ok('nochange submit is accepted', JSON.stringify(nochangeResult));
    else bad('nochange submit is accepted', JSON.stringify(nochangeResult));
    if (nochangeResult.ok === true) await reinjectAfterReload();
    const nochangeConfirmed = await waitFor('nochange confirmation', () => state.confirmations[2], 45000);
    if (Number(nochangeConfirmed.revid) === retryRevid) {
      ok('nochange fallback reuses the latest revision id', `revid=${nochangeConfirmed.revid}`);
    } else {
      bad('nochange fallback reuses the latest revision id', JSON.stringify({got: nochangeConfirmed.revid, retryRevid}));
    }
    await waitFor('nochange temp file deleted', () => !fs.existsSync(nochange.fsPath), 15000);
    ok('nochange temp file deleted after confirmation', nochange.fsPath);
    const latestAfter = await evaluate(`new mw.Api().get({
      action: 'query', formatversion: '2', prop: 'revisions', rvprop: 'ids',
      rvslots: 'main', titles: mw.config.get('wgPageName'), rvlimit: '1',
    }).then(r => r.query.pages[0].revisions[0].revid)`);
    if (latestAfter === retryRevid) ok('nochange did not create a revision', `latest=${latestAfter}`);
    else bad('nochange did not create a revision', JSON.stringify({latestAfter, retryRevid}));
  } catch (error) {
    bad('harness', error instanceof Error ? error.message : String(error));
  } finally {
    console.log('\n=== results ===');
    for (const result of results) {
      console.log(`${result.ok ? 'PASS' : 'FAIL'} | ${result.name} | ${result.detail || ''}`);
    }
    const failed = results.filter(result => !result.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    cdp.close();
    if (openedTarget) await cdpJson(`/json/close/${target.id}`).catch(() => undefined);
    for (const client of wss.clients) client.terminate();
    wss.close();
    fs.rmSync(tempRoot, {recursive: true, force: true});
    process.exit(failed ? 1 : 0);
  }
}

await main();
