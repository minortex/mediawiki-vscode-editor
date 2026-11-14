import type {InPageEdit, IWikiPage, WatchlistAction} from '@inpageedit/core'
import {createApi} from './api'
import {BAR_STYLE_ID, createBarUi} from './bar'
import type {SaveForm} from './bar'
import {messages} from './i18n'
import {
  consumeAutoEdit,
  editUrlFor,
  highlightSection,
  highlightTemplate,
  isArticleLink,
  scrollToOccurrence,
  textAtPoint,
} from './locate'
import {apiUrl, getMwConfig, getMwUtil} from './mw'
import {createPreview} from './preview'
import type {
  EditResult,
  IncomingMessage,
  NavigateEditMessage,
  OutgoingMessage,
  PendingConfirm,
  Session,
  SessionInfo,
  SessionQueryResult,
  SessionResultMessage,
  TemplatesUsedService,
  Waiter,
  WikiRegisteredMessage,
} from './types'

const WS_URL = 'ws://127.0.0.1:8927'
const RECONNECT_MS = 5000
const PENDING_CONFIRM_KEY = 'mwe-ipe-pending-save-confirmation'
const NOTICE_MS = 3000

function parseWatchlist(value: string): WatchlistAction {
  switch (value) {
    case 'preferences':
    case 'watch':
    case 'unwatch':
      // WatchlistAction is a string enum and not a runtime export of the core
      // package, so the narrowed literal still needs the enum cast.
      return value as WatchlistAction
    default:
      return 'nochange' as WatchlistAction
  }
}

/** Build a session; transient flags default to a fresh editing state. */
function createSession(
  init: Pick<Session, 'id' | 'title' | 'text' | 'wikiPage'> & Partial<Session>,
): Session {
  return {
    remoteDirty: false,
    changed: false,
    busy: false,
    conflict: false,
    ...init,
  }
}

export default {
  name: 'vscode-editor',
  inject: ['toolbox', 'i18n', 'quickUpload', 'templatesUsed', 'quickDiff'],
  apply(ctx: InPageEdit) {
    // IPE's i18n manager is shared with the whole app, so register our strings
    // under a namespace: bare keys such as "Submit" would override its own.
    const NAMESPACE = 'vscode-editor'
    const i18n = ctx.i18n.manager
    const translate = (message: string, ...args: string[]): string => {
      const text = i18n.translate(`${NAMESPACE}.${message}`, ...args)
      // Untranslated languages resolve to the namespaced key itself.
      return text.startsWith(`${NAMESPACE}.`) ? text.slice(NAMESPACE.length + 1) : text
    }
    for (const language of ['zh', 'zh-cn', 'zh-hans']) {
      i18n.setLanguageData(language, {[NAMESPACE]: messages})
    }

    const api = createApi({apiUrl: apiUrl(), translate})
    const windowId = (() => {
      try {
        const key = 'mwe-ipe-window-id'
        let value = sessionStorage.getItem(key)
        if (!value) {
          value =
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(36).slice(2)}`
          sessionStorage.setItem(key, value)
        }
        return value
      } catch {
        return `${Date.now()}-${Math.random().toString(36).slice(2)}`
      }
    })()
    const templatesUsed = (ctx as InPageEdit & {templatesUsed?: TemplatesUsedService}).templatesUsed

    let socket: WebSocket | null = null
    let connected = false
    let session: Session | null = null
    let reconnectTimer: number | undefined
    let disposed = false

    let registeredWiki: unknown = null
    let registeringWiki: Promise<unknown> | null = null
    let registerSeq = 0
    const registerWaiters: Record<string, Waiter<unknown>> = {}
    let sessionQueryPromise: Promise<SessionQueryResult> | null = null
    let sessionQuerySeq = 0
    const sessionWaiters: Record<string, Waiter<SessionQueryResult>> = {}
    let pendingConfirm: PendingConfirm | null = null
    let pendingAutoEdit = false
    let pendingConfirmSent = false

    const bar = createBarUi({
      translate,
      getSession: () => session,
      actions: {
        submit: form => requestSave(form),
        cancel: () => cancelEdit(),
        upload: () => {
          void ctx.quickUpload?.showModal()
        },
        templates: () => showTemplatesUsed(),
        images: () => showImagesUsed(),
        diff: () => showDiff(),
      },
    })
    const {ensureBar, refreshBar, setBusy, setStatus, syncBarHeight} = bar
    const preview = createPreview({
      translate,
      request: params => api.request(params),
      getSession: () => session,
      setStatus,
    })

    function readPendingConfirm(): PendingConfirm | null {
      try {
        const raw = sessionStorage.getItem(PENDING_CONFIRM_KEY)
        if (!raw) return null
        const value: unknown = JSON.parse(raw)
        if (!value || typeof value !== 'object') return null
        const record = value as {sessionId?: unknown; origin?: unknown; revid?: unknown}
        if (typeof record.sessionId !== 'string') return null
        // Without a revision id the temp file must not be removed.
        if (
          typeof record.revid !== 'number' ||
          !Number.isInteger(record.revid) ||
          record.revid <= 0
        ) {
          return null
        }
        const origin = typeof record.origin === 'string' ? record.origin : location.origin
        return {sessionId: record.sessionId, origin, revid: record.revid}
      } catch {
        return null
      }
    }

    function storePendingConfirm(sessionId: string, revid: number): void {
      pendingConfirm = {sessionId, origin: location.origin, revid}
      pendingConfirmSent = false
      try {
        sessionStorage.setItem(PENDING_CONFIRM_KEY, JSON.stringify(pendingConfirm))
      } catch {
        // sessionStorage unavailable; the in-memory marker still works.
      }
    }

    function clearPendingConfirm(): void {
      pendingConfirm = null
      pendingConfirmSent = false
      try {
        sessionStorage.removeItem(PENDING_CONFIRM_KEY)
      } catch {}
    }

    function sendPendingConfirm(): void {
      if (!pendingConfirm || pendingConfirmSent) return
      if (pendingConfirm.origin !== location.origin) return
      if (send({
        type: 'save-confirmed',
        sessionId: pendingConfirm.sessionId,
        revid: pendingConfirm.revid,
        origin: location.origin,
      })) {
        pendingConfirmSent = true
      }
    }

    /**
     * IPE's notify options intersect IPEModalOptions with a different position
     * union, so `position` cannot be typed through; its default is already
     * "top right", which is what the notices below want.
     */
    interface NotifyOptions {
      title?: string
      content?: string | Element
      closeAfter?: {time: number; resetOnHover?: boolean}
    }
    function notifyWarning(options: NotifyOptions): void {
      ctx.modal?.notify('warning', options)
    }

    function notifyOffline(message?: string, title?: string): void {
      const text =
        message ||
        translate(
          'VSCode extension is not connected. Open VSCode and make sure the MediaWiki extension is installed and enabled.',
        )
      if (ctx.modal) {
        notifyWarning({
          title: title || translate('VSCode not connected'),
          content: text,
          closeAfter: {time: NOTICE_MS, resetOnHover: true},
        })
        return
      }
      const old = document.getElementById('mwe-offline-notice')
      if (old) old.remove()
      const box = document.createElement('div')
      box.id = 'mwe-offline-notice'
      box.style.cssText =
        'position:fixed;top:20px;right:20px;z-index:901;max-width:360px;background:#fff;color:#202122;border:1px solid #a2a9b1;border-left:4px solid #fc3;padding:12px 14px;border-radius:4px;font-size:13px;line-height:1.5;box-shadow:0 2px 12px rgba(0,0,0,.2);'
      box.textContent = text
      document.body.append(box)
      window.setTimeout(() => box.remove(), NOTICE_MS)
    }

    function showOpenLink(url: string): void {
      const link = document.createElement('a')
      link.href = url
      link.target = '_blank'
      link.rel = 'noopener'
      link.textContent = translate('Open target page')
      link.style.cssText = 'color:#36c;text-decoration:underline;cursor:pointer;'
      if (ctx.modal) {
        notifyWarning({
          title: translate('Popup blocked'),
          content: link,
          closeAfter: {time: NOTICE_MS, resetOnHover: true},
        })
      } else {
        notifyOffline(
          translate('The popup was blocked; open the target page manually.'),
          translate('Page needs to be opened'),
        )
      }
    }

    function openNavigate(msg: NavigateEditMessage): void {
      let url: URL
      try {
        const util = getMwUtil()
        if (!util?.getUrl) throw new Error(translate('mw.util.getUrl is unavailable'))
        url = new URL(util.getUrl(msg.title), location.href)
      } catch {
        send({type: 'open-result', requestId: msg.requestId, opened: false})
        return
      }
      url.searchParams.set('external-editor', '1')
      if (msg.fragment) url.hash = msg.fragment
      const name = `mwe-edit:${encodeURIComponent(msg.title)}`
      let win: Window | null = null
      try {
        win = window.open(url.href, name)
      } catch {}
      if (!win) {
        showOpenLink(url.href)
        send({type: 'open-result', requestId: msg.requestId, opened: false})
        return
      }
      send({type: 'open-result', requestId: msg.requestId, opened: true})
    }

    function ensureWikiRegistered(): Promise<unknown> {
      if (registeredWiki) return Promise.resolve(registeredWiki)
      if (registeringWiki) return registeringWiki
      registeringWiki = api.fetchSiteInfo()
        .then(query => {
          const requestId = `reg-${Date.now()}-${++registerSeq}`
          const {promise, resolve, reject} = Promise.withResolvers<unknown>()
          const timer = window.setTimeout(() => {
            delete registerWaiters[requestId]
            reject(new Error(translate('Extension did not respond to site registration')))
          }, 15000)
          registerWaiters[requestId] = {resolve, reject, timer, query}
          send({
            type: 'register-wiki',
            requestId,
            origin: location.origin,
            api: apiUrl(),
            name: getMwConfig<string>('wgSiteName') || location.host,
            siteinfo: query,
          })
          return promise
        })
        .then(query => {
          registeredWiki = query
          registeringWiki = null
          return query
        })
        .catch(error => {
          registeringWiki = null
          throw error
        })
      return registeringWiki
    }

    function onWikiRegistered(msg: WikiRegisteredMessage): void {
      const waiter = registerWaiters[msg.requestId]
      if (!waiter) return
      clearTimeout(waiter.timer)
      delete registerWaiters[msg.requestId]
      if (msg.ok) waiter.resolve(waiter.query)
      else waiter.reject(new Error(msg.error || translate('Site registration failed')))
    }

    function connect(): void {
      if (disposed) return
      if (socket && socket.readyState <= WebSocket.OPEN) return
      socket = new WebSocket(WS_URL)
      socket.addEventListener('open', () => {
        connected = true
        document.getElementById('mwe-offline-notice')?.remove()
        sendPendingConfirm()
        const startPendingAutoEdit = (): void => {
          const pending = pendingAutoEdit
          pendingAutoEdit = false
          if (pending && !session) void beginPageEdit()
        }
        void (async () => {
          try {
            await ensureWikiRegistered()
            const existing = await queryExistingSession()
            if (existing.session) {
              await adoptSession(existing.session)
              return
            }
            if (existing.busy) {
              // 页面刷新时旧 WebSocket 可能还没完成 close；稍后重查一次。
              window.setTimeout(async () => {
                try {
                  const retry = await queryExistingSession(true)
                  if (retry.session) {
                    await adoptSession(retry.session)
                    return
                  }
                } catch {}
                startPendingAutoEdit()
              }, 500)
              return
            }
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            setStatus(translate('Site registration failed: {{ $1 }}', detail), 'error')
          }
          if (session) {
            preview.restorePage()
            endSession()
            notifyOffline(
              translate('The extension no longer has this session; editing has been closed.'),
              translate('Session ended'),
            )
            return
          }
          startPendingAutoEdit()
        })()
      })
      socket.addEventListener('close', () => {
        connected = false
        sessionQueryPromise = null
        if (!disposed) reconnectTimer = window.setTimeout(connect, RECONNECT_MS)
      })
      socket.addEventListener('error', () => {
        try {
          socket?.close()
        } catch {}
      })
      socket.addEventListener('message', event => {
        let msg: IncomingMessage
        try {
          msg = JSON.parse(event.data) as IncomingMessage
        } catch {
          return
        }
        if (msg.type === 'wiki-registered') {
          onWikiRegistered(msg)
          return
        }
        if (msg.type === 'session-result') {
          onSessionResult(msg)
          return
        }
        if (msg.type === 'navigate-edit') {
          openNavigate(msg)
          return
        }
        if (msg.type === 'save-confirmed-result') {
          if (pendingConfirm && msg.sessionId === pendingConfirm.sessionId && msg.ok) {
            clearPendingConfirm()
          }
          return
        }
        if (!session || msg.sessionId !== session.id) return
        if (msg.type === 'update') {
          session.text = msg.text
          session.changed = true
          preview.schedulePreview()
        } else if (msg.type === 'state') {
          session.remoteDirty = !!msg.dirty
          refreshBar()
        } else if (msg.type === 'scroll') {
          if (msg.kind === 'section') {
            highlightSection(msg.section)
          } else if (msg.kind === 'template') {
            highlightTemplate(msg.template)
          } else {
            const moved = scrollToOccurrence(
              msg.text,
              msg.occurrence,
              msg.section,
              msg.scope,
              msg.label,
              msg.prev,
              msg.next,
              msg.labelOccurrence,
            )
            if (!moved && msg.template) highlightTemplate(msg.template)
          }
        } else if (msg.type === 'save') {
          setStatus(translate('Submitting…'))
          void saveEdit(msg.text, msg.summary, msg.minor, msg.requestId)
        } else if (msg.type === 'finish') {
          if (msg.result === 'closed') preview.restorePage()
          endSession()
          if (msg.result !== 'closed') closeIfOpenedHere()
        } else if (msg.type === 'editor-closed') {
          preview.restorePage()
          endSession()
          closeIfOpenedHere()
          notifyOffline(translate('Exited editing mode.'), translate('Editor closed'))
        } else if (msg.type === 'preempted') {
          preview.restorePage()
          endSession()
          notifyOffline(
            translate('Editing continued in another tab.'),
            translate('Session transferred'),
          )
        }
      })
    }

    function send(msg: OutgoingMessage): boolean {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg))
        return true
      }
      return false
    }

    function endSession(): void {
      session = null
      preview.cancel()
      bar.detach()
      document.querySelector('.mwe-ipe-bar')?.remove()
      document.body.classList.remove('mwe-ipe-editing')
    }

    /** Only tabs opened by the extension for editing can be closed by script. */
    function closeIfOpenedHere(): void {
      if (window.name.indexOf('mwe-edit:') === 0) {
        window.setTimeout(() => window.close(), 50)
      }
    }

    function queryExistingSession(force = false): Promise<SessionQueryResult> {
      if (!force && sessionQueryPromise) return sessionQueryPromise
      if (!connected) return Promise.resolve({session: null, busy: false})
      const requestId = `session-${Date.now()}-${++sessionQuerySeq}`
      const {promise, resolve, reject} = Promise.withResolvers<SessionQueryResult>()
      const timer = window.setTimeout(() => {
        delete sessionWaiters[requestId]
        reject(new Error(translate('Extension did not respond to the session query')))
      }, 8000)
      sessionWaiters[requestId] = {resolve, reject, timer}
      if (!send({
        type: 'session-query',
        requestId,
        origin: location.origin,
        title: getMwConfig<string>('wgPageName'),
        windowId,
      })) {
        clearTimeout(timer)
        delete sessionWaiters[requestId]
        reject(new Error(translate('Extension not connected')))
      }
      const query = promise.catch((error: unknown) => {
        sessionQueryPromise = null
        throw error
      })
      sessionQueryPromise = query
      return query
    }

    function onSessionResult(msg: SessionResultMessage): void {
      const waiter = sessionWaiters[msg.requestId]
      if (!waiter) return
      clearTimeout(waiter.timer)
      delete sessionWaiters[msg.requestId]
      if (!msg.ok) waiter.reject(new Error(msg.error || translate('Session query failed')))
      else waiter.resolve({session: msg.session || null, busy: !!msg.busy})
    }

    async function adoptSession(info: SessionInfo): Promise<void> {
      if (session) return
      let wikiPage: IWikiPage
      try {
        wikiPage = info.revid
          ? await ctx.wikiPage.newFromRevision(info.revid)
          : await ctx.wikiPage.newFromTitle(info.title, false)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        setStatus(translate('Failed to resume the session: {{ $1 }}', detail), 'error')
        return
      }
      session = createSession({
        id: info.sessionId,
        title: info.title,
        text: info.text,
        wikiPage,
        remoteDirty: !!info.dirty,
      })
      ensureBar()
      document.body.classList.remove('ipe-modal-no-scroll')
      setStatus(translate('Resumed the VSCode editing session'))
      preview.schedulePreview()
    }

    async function beginPageEdit(auto = false): Promise<void> {
      if (session) return
      if (!connected) {
        if (auto) {
          pendingAutoEdit = true
          return
        }
        notifyOffline()
        return
      }
      pendingAutoEdit = false
      try {
        await ensureWikiRegistered()
        const existing = await queryExistingSession(true)
        if (existing.busy) {
          notifyOffline(
            translate(
              'This page is already being edited in another browser window or VSCode session. Close that session first.',
            ),
            translate('Page already being edited'),
          )
          return
        }
        if (existing.session) {
          await adoptSession(existing.session)
          return
        }
        const title = getMwConfig<string>('wgPageName')
        if (!title) throw new Error(translate('Unable to read the current page title'))
        const wikiPage = await ctx.wikiPage.newFromTitle(title, false)
        const revision = wikiPage.revisions[0]
        session = createSession({
          id: `s${Date.now()}`,
          title,
          text: revision?.content || '',
          wikiPage,
        })
        ensureBar()
        document.body.classList.remove('ipe-modal-no-scroll')
        setStatus(translate('Editing in VSCode; save the file to refresh the preview'))
        send({
          type: 'open',
          sessionId: session.id,
          title: session.title,
          text: session.text,
          revid: revision?.revid,
          basetimestamp: revision?.timestamp,
          starttimestamp: new Date().toISOString(),
          windowId,
          wiki: location.origin,
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const message = translate(
          'Failed to start editing: {{ $1 }}. Make sure the VSCode extension is running and the web plugin is up to date.',
          detail,
        )
        setStatus(message, 'error')
        notifyOffline(message, translate('Failed to start editing'))
      }
    }

    function showTemplatesUsed(): void {
      if (!session) return
      void templatesUsed?.showModal({title: session.title})
    }

    function showDiff(): void {
      if (!session) return
      const from = session.wikiPage.revisions[0]?.content || ''
      if (from === session.text) return
      ctx.quickDiff?.comparePages({
        fromtitle: session.title,
        fromtext: from,
        totitle: session.title,
        totext: session.text,
        topst: true,
      })
    }

    function showImagesUsed(): void {
      if (!session || !ctx.modal) return
      fetch(
        `${apiUrl()}?action=parse&format=json&formatversion=2&prop=images&page=${encodeURIComponent(session.title)}`,
      )
        .then(response => response.json() as Promise<{parse?: {images?: string[]}}>)
        .then(data => {
          const images = data.parse?.images || []
          const box = document.createElement('div')
          if (!images.length) {
            box.textContent = translate('No images are used.')
          } else {
            const list = document.createElement('ol')
            for (const title of images) {
              const name = /^File:/i.test(title) ? title : `File:${title}`
              const item = document.createElement('li')
              const link = document.createElement('a')
              link.href = `/wiki/${encodeURIComponent(name)}`
              link.target = '_blank'
              link.rel = 'noopener'
              link.textContent = name
              item.append(link)
              list.append(item)
            }
            box.append(list)
          }
          ctx.modal?.show({
            title: translate('Images used'),
            content: box,
            sizeClass: 'dialog',
            draggable: true,
            backdrop: false,
          })
        })
    }

    function cancelEdit(): void {
      if (!session) return
      const pending = session.remoteDirty || session.changed
      if (
        pending &&
        !confirm(
          session.remoteDirty
            ? translate('VSCode still has unsaved changes. Discard them and close the editor?')
            : translate('There are changes not yet saved to the site. Discard them?'),
        )
      ) {
        return
      }
      send({
        type: 'finish',
        sessionId: session.id,
        result: pending ? 'discarded' : 'unchanged',
      })
      preview.restorePage()
      endSession()
      closeIfOpenedHere()
    }

    function requestSave(form: SaveForm): void {
      if (!session) return
      if (session.remoteDirty) {
        setStatus(translate('VSCode has unsaved changes; save the file first (Ctrl+S)'), 'error')
        return
      }
      setBusy(true)
      session.watchlist = parseWatchlist(form.watchlist)
      setStatus(translate('Saving the file…'))
      send({
        type: 'request-save',
        sessionId: session.id,
        summary: form.summary,
        minor: form.minor,
      })
    }

    function isEditConflict(error: unknown): boolean {
      const value = error as {
        code?: unknown
        message?: unknown
        data?: {error?: {code?: unknown}}
      }
      return (
        value?.code === 'editconflict' ||
        value?.data?.error?.code === 'editconflict' ||
        /editconflict|编辑冲突/i.test(String(value?.message || ''))
      )
    }

    async function latestPageForSession(): Promise<IWikiPage | null> {
      if (!session) return null
      return ctx.wikiPage.newFromTitle(session.title, false, undefined, true)
    }

    function reportConflict(latest: IWikiPage, message: string): boolean {
      if (!session) return false
      const revision = latest.revisions[0]
      if (!revision) return false
      session.wikiPage = latest
      session.conflict = true
      send({
        type: 'conflict',
        sessionId: session.id,
        remoteText: revision.content || '',
        remoteRevid: revision.revid,
        remoteTimestamp: revision.timestamp,
        message,
      })
      setStatus(
        translate(
          'Edit conflict detected; conflict markers are loaded. Resolve them before submitting.',
        ),
        'error',
      )
      return true
    }

    /** Latest revision check that must pass before editing. */
    async function latestForSave(): Promise<{
      baseRevid: number | undefined
      latest: IWikiPage | null
      changedRemotely: boolean
    }> {
      const baseRevid = session?.wikiPage.revisions[0]?.revid
      let latest: IWikiPage | null = null
      try {
        latest = await latestPageForSession()
      } catch {}
      const latestRevid = latest?.revisions[0]?.revid
      return {
        baseRevid,
        latest,
        changedRemotely:
          baseRevid !== undefined &&
          latestRevid !== undefined &&
          latestRevid !== baseRevid &&
          !!latest,
      }
    }

    async function applyEdit(
      text: string,
      summary: string | undefined,
      minor: boolean | undefined,
    ): Promise<EditResult> {
      if (!session) return {}
      const result = await session.wikiPage.edit({
        text,
        summary: summary || '',
        minor: !!minor,
        watchlist: session.watchlist || parseWatchlist('nochange'),
      })
      return api.readEditResult(result.data?.edit)
    }

    function completeSave(
      sessionId: string,
      requestId: string | undefined,
      revid: number,
      summary: string | undefined,
      minor: boolean | undefined,
    ): void {
      storePendingConfirm(sessionId, revid)
      send({type: 'save-result', sessionId, requestId, ok: true})
      send({
        type: 'finish',
        sessionId,
        result: 'saved',
        summary: summary || '',
        minor: !!minor,
      })
      setStatus(translate('Saved; reloading and waiting for confirmation…'), 'ok')
      setBusy(false)
      window.setTimeout(() => location.reload(), 800)
    }

    function failSave(sessionId: string, requestId: string | undefined, message: string): void {
      setBusy(false)
      send({type: 'save-result', sessionId, requestId, ok: false, error: message})
    }

    async function handleSaveError(
      sessionId: string,
      requestId: string | undefined,
      error: unknown,
    ): Promise<void> {
      const message = error instanceof Error ? error.message : String(error)
      setBusy(false)
      send({type: 'save-result', sessionId, requestId, ok: false, error: message})
      let conflictSent = false
      if (isEditConflict(error)) {
        try {
          const latest = await latestPageForSession()
          if (latest) conflictSent = reportConflict(latest, message)
        } catch {}
      }
      if (!conflictSent) {
        setStatus(translate('Save failed: {{ $1 }}', message), 'error')
      }
    }

    async function saveEdit(
      text: string,
      summary: string | undefined,
      minor: boolean | undefined,
      requestId?: string,
    ): Promise<void> {
      if (!session) return
      const sessionId = session.id
      try {
        const {baseRevid, latest, changedRemotely} = await latestForSave()
        if (changedRemotely) {
          setBusy(false)
          reportConflict(latest!, translate('The page was changed by someone else.'))
          send({type: 'save-result', sessionId, requestId, ok: false, error: '编辑冲突'})
          return
        }
        if (latest) session.wikiPage = latest
        const edit = await applyEdit(text, summary, minor)
        session.text = text
        session.changed = false
        session.conflict = false
        // The temp file may only be cleaned up once a revision id proves the
        // save landed; anything else keeps it for a retry.
        const revid = await api.savedRevid(session.title, text, edit, baseRevid)
        if (revid === undefined) {
          const message = translate(
            'The save was submitted but no revision id could be confirmed; the temp file was kept',
          )
          failSave(sessionId, requestId, message)
          setStatus(translate('Save unconfirmed: {{ $1 }}', message), 'error')
          return
        }
        completeSave(sessionId, requestId, revid, summary, minor)
      } catch (error) {
        await handleSaveError(sessionId, requestId, error)
      }
    }

    function onClick(event: MouseEvent): void {
      if (!session) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('#mw-content-text') == null) return
      const anchor = target.closest('a')
      if (anchor instanceof HTMLAnchorElement) {
        if (!isArticleLink(anchor)) return
        event.preventDefault()
        window.open(editUrlFor(anchor.href), '_blank', 'noopener')
        return
      }
      const point = textAtPoint(event.clientX, event.clientY)
      if (point) {
        send({
          type: 'locate',
          sessionId: session.id,
          text: point.text,
          section: point.section,
          occurrence: point.occurrence,
        })
      }
    }

    function createEditIcon(): SVGElement {
      const ns = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(ns, 'svg')
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.setAttribute('width', '24')
      svg.setAttribute('height', '24')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '2')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
      const path = document.createElementNS(ns, 'path')
      path.setAttribute('d', 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z')
      svg.append(path)
      return svg
    }

    const editButtonId = 'vscode-editor-page'
    pendingConfirm = readPendingConfirm()
    connect()

    ctx.toolbox?.addButton({
      id: editButtonId,
      group: 'group1',
      icon: createEditIcon(),
      tooltip: translate('Edit the whole page in VSCode'),
      onClick: () => {
        void beginPageEdit()
      },
    })

    document.addEventListener('click', onClick, true)
    window.addEventListener('resize', syncBarHeight)

    ctx.on('dispose', () => {
      disposed = true
      connected = false
      clearTimeout(reconnectTimer)
      preview.cancel()
      for (const requestId of Object.keys(registerWaiters)) {
        clearTimeout(registerWaiters[requestId].timer)
        delete registerWaiters[requestId]
      }
      for (const requestId of Object.keys(sessionWaiters)) {
        clearTimeout(sessionWaiters[requestId].timer)
        delete sessionWaiters[requestId]
      }
      try {
        socket?.close()
      } catch {}
      socket = null
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('resize', syncBarHeight)
      ctx.toolbox?.removeButton(editButtonId)
      preview.restorePage()
      endSession()
      document.getElementById(BAR_STYLE_ID)?.remove()
      document.getElementById('mwe-offline-notice')?.remove()
    })

    const autoEdit = consumeAutoEdit()
    if (autoEdit) {
      window.setTimeout(() => {
        if (disposed) return
        void beginPageEdit(true)
      }, 0)
    }
  },
}
