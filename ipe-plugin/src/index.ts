import type {
  IPEModal,
  InPageEdit,
  IWikiPage,
  WatchlistAction,
} from '@inpageedit/core'

const WS_URL = 'ws://127.0.0.1:8927'
const RECONNECT_MS = 5000
const PENDING_CONFIRM_KEY = 'mwe-ipe-pending-save-confirmation'

interface MwConfig {
  get<T = unknown>(key: string): T | undefined
}

interface MwUtil {
  wikiScript(script: string): string
  getUrl(title: string): string
}

interface MwHook {
  fire(...args: unknown[]): void
}

interface MwHookFactory {
  (name: string): MwHook
}

interface MediaWiki {
  config?: MwConfig
  util?: MwUtil
  hook?: MwHookFactory
}

interface BrowserWindow extends Window {
  mw?: MediaWiki
  jQuery?: (root: Element) => unknown
}

interface SiteError {
  code?: string
  info?: string
}

interface SiteInfoResponse {
  error?: SiteError
  query?: unknown
}

interface ParseResponse {
  parse?: {
    text?: string
    images?: string[]
  }
}

interface SessionInfo {
  sessionId: string
  title: string
  text: string
  dirty?: boolean
  revid?: number
  basetimestamp?: string
  starttimestamp?: string
}

interface Session {
  id: string
  title: string
  text: string
  wikiPage: IWikiPage
  remoteDirty: boolean
  changed: boolean
  busy: boolean
  conflict?: boolean
  watchlist?: WatchlistAction
  reload?: boolean
  fullOriginal?: Node[]
}

interface PendingConfirm {
  sessionId: string
  origin: string
}

interface TextContext {
  nodes: Array<{node: Text; start: number; end: number}>
  norm: string
  map: number[]
}

interface ScrollScope {
  type: 'poem'
  index: number
}

interface TemplatesUsedService {
  showModal(options?: {title?: string; wikiPage?: IWikiPage}): unknown
}

interface WikiRegisteredMessage {
  type: 'wiki-registered'
  requestId: string
  ok: boolean
  error?: string
}

interface SessionResultMessage {
  type: 'session-result'
  requestId: string
  ok: boolean
  session?: SessionInfo | null
  busy?: boolean
  error?: string
}

interface SessionQueryResult {
  session: SessionInfo | null
  busy: boolean
}

interface NavigateEditMessage {
  type: 'navigate-edit'
  requestId: string
  title: string
  fragment?: string
}

interface UpdateMessage {
  type: 'update'
  sessionId: string
  text: string
}

interface DirtyStateMessage {
  type: 'state'
  sessionId: string
  dirty: boolean
}

interface ScrollTextMessage {
  type: 'scroll'
  kind?: 'text'
  sessionId: string
  text: string
  occurrence: number
  section?: string
  scope?: ScrollScope
  label?: string
  labelOccurrence?: number
  prev?: string
  next?: string
  template?: TemplateBlockTarget
}

interface ScrollSectionMessage {
  type: 'scroll'
  kind: 'section'
  sessionId: string
  section?: string
}

interface TemplateBlockTarget {
  name: string
  params: Record<string, string>
  section: string
  occurrence: number
}

interface ScrollTemplateMessage {
  type: 'scroll'
  kind: 'template'
  sessionId: string
  template: TemplateBlockTarget
}

type ScrollMessage =
  | ScrollTextMessage
  | ScrollSectionMessage
  | ScrollTemplateMessage

interface SaveMessage {
  type: 'save'
  sessionId: string
  requestId?: string
  text: string
  summary?: string
  minor?: boolean
}

interface FinishMessage {
  type: 'finish'
  sessionId: string
  result: 'saved' | 'discarded' | 'unchanged' | 'closed'
}

interface EditorClosedMessage {
  type: 'editor-closed'
  sessionId: string
}

interface PreemptedMessage {
  type: 'preempted'
  sessionId: string
}

interface SaveConfirmedResultMessage {
  type: 'save-confirmed-result'
  sessionId: string
  ok: boolean
}

type IncomingMessage =
  | WikiRegisteredMessage
  | SessionResultMessage
  | NavigateEditMessage
  | UpdateMessage
  | DirtyStateMessage
  | ScrollMessage
  | SaveMessage
  | FinishMessage
  | EditorClosedMessage
  | PreemptedMessage
  | SaveConfirmedResultMessage

type OutgoingMessage =
  | {
      type: 'register-wiki'
      requestId: string
      origin: string
      api: string
      name: string
      siteinfo: unknown
    }
  | {
      type: 'session-query'
      requestId: string
      origin: string
      title: string | undefined
      windowId: string
    }
  | {
      type: 'open'
      sessionId: string
      title: string
      text: string
      revid?: number
      basetimestamp?: string
      starttimestamp: string
      windowId: string
      wiki: string
    }
  | {
      type: 'save-result'
      sessionId: string
      requestId?: string
      ok: boolean
      error?: string
    }
  | {
      type: 'finish'
      sessionId: string
      result: 'saved' | 'discarded' | 'unchanged'
      summary?: string
      minor?: boolean
    }
  | {type: 'request-save'; sessionId: string; summary?: string; minor?: boolean}
  | {
      type: 'conflict'
      sessionId: string
      remoteText: string
      remoteRevid?: number
      remoteTimestamp?: string
      message?: string
    }
  | {
      type: 'locate'
      sessionId: string
      text: string
      section?: string
      occurrence?: number
    }
  | {type: 'save-confirmed'; sessionId: string; origin: string}
  | {type: 'open-result'; requestId: string; opened: boolean}

interface Waiter<T> {
  resolve(value: T): void
  reject(error: Error): void
  timer: number
  query?: T
}

type CaretDocument = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null
}

const browserWindow = window as unknown as BrowserWindow

const getMw = (): MediaWiki | undefined => browserWindow.mw
const getMwConfig = <T = unknown>(key: string): T | undefined => getMw()?.config?.get<T>(key)
const getMwUtil = (): MwUtil | undefined => getMw()?.util
const getJQuery = (): ((root: Element) => unknown) | undefined => browserWindow.jQuery

function apiUrl(): string {
  const util = getMwUtil()
  return util?.wikiScript ? util.wikiScript('api') : new URL('/api.php', location.origin).href
}

function parseWatchlist(value: string): WatchlistAction {
  switch (value) {
    case 'preferences':
    case 'watch':
    case 'unwatch':
      return value as WatchlistAction
    default:
      return 'nochange' as WatchlistAction
  }
}

export default {
  name: 'vscode-editor',
  inject: ['toolbox', 'quickUpload', 'templatesUsed', 'quickDiff'],
  apply(ctx: InPageEdit) {
    const API = apiUrl()
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
    let previewTimer: number | undefined
    let previewSeq = 0
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
    let barResizeObserver: ResizeObserver | null = null

    function readPendingConfirm(): PendingConfirm | null {
      try {
        const raw = sessionStorage.getItem(PENDING_CONFIRM_KEY)
        if (!raw) return null
        const value: unknown = JSON.parse(raw)
        if (!value || typeof value !== 'object' || !('sessionId' in value)) return null
        const sessionId = value.sessionId
        if (typeof sessionId !== 'string') return null
        const origin = 'origin' in value && typeof value.origin === 'string'
          ? value.origin
          : location.origin
        return {sessionId, origin}
      } catch {
        return null
      }
    }

    function storePendingConfirm(sessionId: string): void {
      pendingConfirm = {sessionId, origin: location.origin}
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
        origin: location.origin,
      })) {
        pendingConfirmSent = true
      }
    }

    const barStyleId = 'mwe-ipe-bar-style'

    function ensureBarStyle(): void {
      let style = document.getElementById(barStyleId) as HTMLStyleElement | null
      if (!style) {
        style = document.createElement('style')
        style.id = barStyleId
        document.head.append(style)
      }
      style.textContent = [
        '.mwe-ipe-bar{position:fixed;left:0;right:0;bottom:0;z-index:900;display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#fff;border-top:2px solid #3366cc;padding:10px 16px;box-shadow:0 -2px 12px rgba(0,0,0,.15);font-size:14px;color:#202122;}',
        '.mwe-ipe-bar .mwe-ipe-status{flex:1 1 180px;color:#72777d;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.mwe-ipe-bar .mwe-ipe-status.error{color:#d33;}',
        '.mwe-ipe-bar .mwe-ipe-status.ok{color:#14866d;}',
        '.mwe-ipe-bar input[type=text]{flex:1 1 220px;min-width:160px;padding:6px 10px;border:1px solid #a2a9b1;border-radius:4px;font-size:14px;}',
        '.mwe-ipe-bar select{padding:6px 10px;border:1px solid #a2a9b1;border-radius:4px;background:#fff;font-size:14px;color:#202122;}',
        '.mwe-ipe-bar button{padding:6px 14px;border-radius:4px;border:1px solid #a2a9b1;background:#f8f9fa;cursor:pointer;font-size:14px;color:#202122;}',
        '.mwe-ipe-bar button:hover{background:#eaecf0;}',
        '.mwe-ipe-bar button.is-primary{background:#3366cc;border-color:#3366cc;color:#fff;font-weight:600;}',
        '.mwe-ipe-bar button.is-primary:hover{background:#2a56a8;}',
        '.mwe-ipe-bar .mwe-ipe-link{color:#3366cc;font-size:13px;text-decoration:none;cursor:pointer;white-space:nowrap;}',
        '.mwe-ipe-bar .mwe-ipe-link:hover{text-decoration:underline;}',
        '.mwe-ipe-bar label{display:flex;align-items:center;gap:4px;white-space:nowrap;}',
        'body.mwe-ipe-editing{padding-bottom:calc(var(--mwe-ipe-bar-height, 96px) + 16px);}',
        'body.mwe-ipe-editing #ipe-edit-toolbox{transform:translateY(calc(-1 * var(--mwe-ipe-bar-height, 96px)));}',
      ].join('\n')
    }

    function refreshBar(): void {
      const bar = document.querySelector('.mwe-ipe-bar')
      if (!bar || !session) return
      const submit = bar.querySelector<HTMLButtonElement>('.mwe-ipe-submit')
      if (submit) submit.disabled = !!session.remoteDirty || !!session.busy
      if (session.remoteDirty) {
        setStatus('VSCode 里有未保存修改，先保存文件（Ctrl+S）')
      }
    }

    function setBusy(busy: boolean): void {
      if (session) session.busy = !!busy
      const bar = document.querySelector('.mwe-ipe-bar')
      if (!bar) return
      bar.querySelectorAll('button').forEach(button => {
        button.disabled = !!busy
      })
      if (busy) setStatus('提交中…')
    }

    function setStatus(text: string, kind?: string): void {
      const el = document.querySelector('.mwe-ipe-status')
      if (!el) return
      el.textContent = text || ''
      el.className = 'mwe-ipe-status' + (kind ? ' ' + kind : '')
    }

    function attachBarMetrics(bar: HTMLElement): void {
      document.body.classList.add('mwe-ipe-editing')
      barResizeObserver?.disconnect()
      barResizeObserver = new ResizeObserver(syncBarHeight)
      barResizeObserver.observe(bar)
      syncBarHeight()
    }

    function ensureBar(): HTMLDivElement {
      ensureBarStyle()
      let bar = document.querySelector<HTMLDivElement>('.mwe-ipe-bar')
      if (bar) {
        attachBarMetrics(bar)
        return bar
      }
      bar = document.createElement('div')
      bar.className = 'mwe-ipe-bar'
      bar.innerHTML =
        '<span class="mwe-ipe-status">VSCode 编辑中</span>' +
        '<input type="text" class="mwe-ipe-summary" placeholder="编辑摘要">' +
        '<select class="mwe-ipe-watchlist">' +
        '<option value="preferences">遵循 MW 首选</option>' +
        '<option value="nochange">保持当前状态</option>' +
        '<option value="watch">添加到监视列表</option>' +
        '<option value="unwatch">从监视列表移除</option>' +
        '</select>' +
        '<label><input type="checkbox" class="mwe-ipe-minor"> 小编辑</label>' +
        '<label><input type="checkbox" class="mwe-ipe-reload" checked> 保存后刷新</label>' +
        '<button class="mwe-ipe-submit is-primary">提交</button>' +
        '<button class="mwe-ipe-diff">差异</button>' +
        '<a class="mwe-ipe-link mwe-ipe-upload">快速上传</a>' +
        '<a class="mwe-ipe-link mwe-ipe-templates">使用的模板</a>' +
        '<a class="mwe-ipe-link mwe-ipe-images">使用的图片</a>' +
        '<button class="mwe-ipe-cancel">取消</button>'
      document.body.append(bar)
      attachBarMetrics(bar)
      bar.querySelector('.mwe-ipe-submit')?.addEventListener('click', () => {
        requestSave(bar)
      })
      bar.querySelector('.mwe-ipe-cancel')?.addEventListener('click', () => {
        cancelEdit()
      })
      bar.querySelector('.mwe-ipe-upload')?.addEventListener('click', () => {
        void ctx.quickUpload?.showModal()
      })
      bar.querySelector('.mwe-ipe-templates')?.addEventListener('click', () => {
        if (!session) return
        void templatesUsed?.showModal({title: session.title})
      })
      bar.querySelector('.mwe-ipe-images')?.addEventListener('click', () => {
        showImagesUsed()
      })
      bar.querySelector('.mwe-ipe-diff')?.addEventListener('click', () => {
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
      })
      return bar
    }

    function status(text: string, kind?: string): void {
      setStatus(text, kind)
    }

    // ---------- API ----------
    function apiPost(params: Record<string, string>): Promise<ParseResponse> {
      return fetch(API, {
        method: 'POST',
        credentials: 'include',
        headers: {'content-type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams(Object.assign({format: 'json', formatversion: '2'}, params)),
      }).then(response => response.json() as Promise<ParseResponse>)
    }

    function fetchSiteInfo(): Promise<unknown> {
      const params = new URLSearchParams({
        action: 'query',
        meta: 'siteinfo',
        siprop: 'general|namespaces|namespacealiases|magicwords|functionhooks|extensiontags|variables|interwikimap',
        format: 'json',
        formatversion: '2',
      })
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? window.setTimeout(() => controller.abort(), 20000) : null
      return fetch(`${API}?${params}`, {
        credentials: 'include',
        signal: controller?.signal,
      })
        .then(response => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.json() as Promise<SiteInfoResponse>
        })
        .then(data => {
          if (data.error) throw new Error(`${data.error.code}: ${data.error.info}`)
          if (!data.query) throw new Error('站点没有返回 siteinfo')
          return data.query
        })
        .finally(() => {
          if (timer) clearTimeout(timer)
        })
    }

    function notifyOffline(message?: string, title?: string): void {
      const text = message || 'VSCode 扩展未连接。请手动打开 VSCode，并确认已安装并启用 MediaWiki 扩展。'
      if (ctx.modal?.notify) {
        ctx.modal.notify('warning', {
          title: title || 'VSCode 未连接',
          content: text,
          position: 'top right',
          closeAfter: {time: 8000, resetOnHover: true},
        } as Parameters<typeof ctx.modal.notify>[1])
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
      window.setTimeout(() => box.remove(), 8000)
    }

    function showOpenLink(url: string): void {
      const link = document.createElement('a')
      link.href = url
      link.target = '_blank'
      link.rel = 'noopener'
      link.textContent = '打开目标页面'
      link.style.cssText = 'color:#36c;text-decoration:underline;cursor:pointer;'
      if (ctx.modal?.notify) {
        ctx.modal.notify('warning', {
          title: '弹窗被拦截',
          content: link,
          position: 'top right',
          closeAfter: {time: 10000, resetOnHover: true},
        } as Parameters<typeof ctx.modal.notify>[1])
      } else {
        notifyOffline('弹窗被拦截，请手动打开目标页面。', '需要打开页面')
      }
    }

    function openNavigate(msg: NavigateEditMessage): void {
      let url: URL
      try {
        const util = getMwUtil()
        if (!util?.getUrl) throw new Error('mw.util.getUrl 不可用')
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
      registeringWiki = fetchSiteInfo()
        .then(query => {
          const requestId = `reg-${Date.now()}-${++registerSeq}`
          return new Promise<unknown>((resolve, reject) => {
            const timer = window.setTimeout(() => {
              delete registerWaiters[requestId]
              reject(new Error('扩展未响应站点注册'))
            }, 15000)
            registerWaiters[requestId] = {resolve, reject, timer, query}
            send({
              type: 'register-wiki',
              requestId,
              origin: location.origin,
              api: API,
              name: getMwConfig<string>('wgSiteName') || location.host,
              siteinfo: query,
            })
          })
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
      else waiter.reject(new Error(msg.error || '站点注册失败'))
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
            status(
              `站点注册失败：${error instanceof Error ? error.message : String(error)}`,
              'error',
            )
          }
          if (session) {
            restorePage()
            endSession()
            notifyOffline('扩展没有该会话，已退出编辑态。', '会话已结束')
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
          schedulePreview()
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
          setStatus('正在提交…')
          void saveEdit(msg.text, msg.summary, msg.minor, msg.requestId)
        } else if (msg.type === 'finish') {
          if (msg.result === 'closed') restorePage()
          endSession()
          if (msg.result !== 'closed') closeIfOpenedHere()
        } else if (msg.type === 'editor-closed') {
          restorePage()
          endSession()
          closeIfOpenedHere()
          notifyOffline('已退出编辑状态。', '编辑器已关闭')
        } else if (msg.type === 'preempted') {
          restorePage()
          endSession()
          notifyOffline('已在另一个标签继续编辑。', '会话已转移')
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

    // ---------- text context / locate ----------
    function drawBox(rect: DOMRect): boolean {
      if (!rect || (!rect.width && !rect.height)) return false
      const top = rect.top + window.scrollY
      const left = rect.left + window.scrollX
      window.scrollTo({
        top: Math.max(0, top - window.innerHeight / 2 + rect.height / 2),
        behavior: 'auto',
      })
      const box = document.createElement('div')
      box.style.cssText =
        `position:absolute;left:${left}px;top:${top}px;width:${rect.width}px;height:${rect.height}px;` +
        'pointer-events:none;z-index:899;outline:2px solid #3366cc;' +
        'background:rgba(51,102,204,.15);border-radius:2px;'
      document.body.append(box)
      window.setTimeout(() => box.remove(), 1600)
      return true
    }

    function revealHidden(element: Element): boolean {
      let node: Element | null = element
      while (node && node !== document.body) {
        const style = window.getComputedStyle(node)
        if (style.display === 'none') {
          const toggle = node.querySelector('.mw-collapsible-toggle a')
          if (toggle) {
            ;(toggle as HTMLElement).click()
            return true
          }
          ;(node as HTMLElement).style.display = ''
          return true
        }
        node = node.parentElement
      }
      return false
    }

    function buildTextContext(root: Element, scopeRange?: Range): TextContext {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const nodes: Array<{node: Text; start: number; end: number}> = []
      let raw = ''
      let node: Node | null
      while ((node = walker.nextNode())) {
        const parent = (node as Text).parentElement
        if (parent?.closest('script,style,.vc-preview')) continue
        if (scopeRange && !scopeRange.intersectsNode(node)) continue
        const start = raw.length
        raw += node.nodeValue || ''
        nodes.push({node: node as Text, start, end: raw.length})
      }
      let norm = ''
      const map: number[] = []
      let space = false
      for (let index = 0; index < raw.length; index++) {
        if (/\s/.test(raw[index])) {
          if (!space) {
            norm += ' '
            map.push(index)
            space = true
          }
        } else {
          norm += raw[index]
          map.push(index)
          space = false
        }
      }
      return {nodes, norm, map}
    }

    function findRangeIn(context: TextContext, needle: string, occurrence: number): Range | null {
      const text = String(needle || '').replace(/\s+/g, ' ').trim()
      if (!text) return null
      let index = -1
      let seen = 0
      while ((index = context.norm.indexOf(text, index + 1)) >= 0) {
        seen++
        if (seen < occurrence) continue
        const rawStart = context.map[index]
        const rawEnd =
          (context.map[Math.min(index + text.length - 1, context.map.length - 1)] || rawStart) + 1
        const head = context.nodes.find(item => rawStart >= item.start && rawStart < item.end)
        const tail = context.nodes.find(item => rawEnd <= item.end && rawEnd > item.start)
        if (!head || !tail) continue
        const range = document.createRange()
        range.setStart(head.node, rawStart - head.start)
        range.setEnd(tail.node, rawEnd - tail.start)
        return range
      }
      return null
    }

    function headingText(heading: Element): string {
      const clone = heading.cloneNode(true) as Element
      clone.querySelectorAll('.mw-editsection').forEach(item => item.remove())
      return clone.textContent?.replace(/\s+/g, ' ').trim() || ''
    }

    function sectionRange(scope?: string): Range | undefined {
      const root = document.querySelector('#mw-content-text')
      if (!scope || !root) return undefined
      const headings = [...root.querySelectorAll('h2')]
      const index = headings.findIndex(heading => headingText(heading) === scope)
      if (index < 0) return undefined
      const range = document.createRange()
      range.setStartBefore(headings[index])
      const next = headings[index + 1]
      if (next) range.setEndBefore(next)
      else range.setEnd(root, root.childNodes.length)
      return range
    }

    function highlightSection(section?: string): boolean {
      const root = document.querySelector('#mw-content-text')
      if (!root) return false
      const headings = [...root.querySelectorAll('h2')]
      const heading = section
        ? headings.find(item => headingText(item) === section)
        : undefined
      const target =
        heading?.nextElementSibling ||
        heading ||
        root.querySelector('p, .mw-parser-output > *')
      return target ? drawBox(target.getBoundingClientRect()) : false
    }

    function compactText(value: string): string {
      return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
    }

    function blockTitle(element: Element): string {
      const title = element.querySelector(
        '.navbox-title, caption, .infobox-title, .infoBoxTitle, .mbox-text, th',
      )
      return compactText(title?.textContent || '')
    }

    function highlightTemplate(target: TemplateBlockTarget): boolean {
      const root = document.querySelector('#mw-content-text')
      if (!root) return false
      const range = sectionRange(target.section)
      const selector = [
        'table',
        '.navbox',
        '.infobox',
        '.infoBox',
        '.hatnote',
        '.dablink',
        '.mbox',
        '.ambox',
        '.cq-quote',
        '[class*="quote"]',
        '[class*="box"]',
      ].join(',')
      const name = compactText(target.name)
      const params = Object.values(target.params)
        .map(compactText)
        .filter(value => value.length >= 2)
      const scored: Array<{
        element: Element
        score: number
        titleMatch: boolean
        textMatch: boolean
        navbox: boolean
      }> = []
      const titleMatches: typeof scored = []
      const textMatches: typeof scored = []
      for (const element of root.querySelectorAll(selector)) {
        if (range && !range.intersectsNode(element)) continue
        const text = compactText(element.textContent || '')
        if (!text) continue
        const title = blockTitle(element)
        const titleMatch = Boolean(name && title.includes(name))
        const textMatch = Boolean(name && text.includes(name))
        let score = 0
        if (titleMatch) score += 200
        else if (textMatch) score += 80
        const matchedParams = params.filter(value => text.includes(value)).length
        score += Math.min(8, matchedParams) * 10
        const navbox = element.matches('table.navbox, .navbox')
        if (navbox) score += 20
        if (element.matches('.infobox, .infoBox')) score += 15
        if (text.length > 100) score += 5
        if (score >= 60) {
          const candidate = {element, score, titleMatch, textMatch, navbox}
          scored.push(candidate)
          if (titleMatch) titleMatches.push(candidate)
          if (textMatch) textMatches.push(candidate)
        }
      }
      // 模板名出现在多个块时，标题匹配才是真正的模板块；
      // 只有标题缺失时才退回正文匹配，避免参数值命中无关的导航盒。
      let pool = titleMatches.length ? titleMatches : textMatches
      if (!pool.length) {
        pool = scored.filter(item => !item.navbox)
      }
      pool.sort((a, b) => b.score - a.score)
      const chosen = pool[Math.min(target.occurrence - 1, pool.length - 1)]?.element
      if (!chosen) return highlightSection(target.section)
      if (chosen instanceof HTMLElement) {
        revealHidden(chosen)
        return drawBox(chosen.getBoundingClientRect())
      }
      return highlightSection(target.section)
    }

    function scrollToOccurrence(
      text: string,
      occurrence: number,
      section?: string,
      scope?: ScrollScope,
      label?: string,
      prev?: string,
      next?: string,
      labelOccurrence?: number,
    ): boolean {
      if (!text) return false
      const all = document.querySelector('#mw-content-text')
      if (!all) return false
      let root: Element = all
      if (scope?.type === 'poem') {
        const poem = all.querySelectorAll('.poem')[scope.index]
        if (!poem) return false
        root = poem
      }
      const wanted = Math.max(1, Number(occurrence) || 1)
      const candidates: Array<{needle: string; occurrence: number}> = []
      const push = (value: string | undefined, count: number): void => {
        const needle = String(value || '').replace(/\s+/g, ' ').trim()
        if (needle.length < 2) return
        if (candidates.some(candidate => candidate.needle === needle)) return
        candidates.push({needle, occurrence: count})
      }
      if (scope) {
        push(text, wanted)
      } else {
        if (label) {
          push(`${label} ${text}`, labelOccurrence || 1)
          push(label + text, labelOccurrence || 1)
        }
        if (next) {
          push(`${text} ${next}`, 1)
          push(text + next, 1)
        }
        if (prev) {
          push(`${prev} ${text}`, 1)
          push(prev + text, 1)
        }
        push(text, wanted)
      }
      const scoped = sectionRange(section)
      const context = buildTextContext(root, scoped)
      for (const candidate of candidates) {
        const range = findRangeIn(context, candidate.needle, candidate.occurrence)
        if (!range) continue
        const rect = range.getBoundingClientRect()
        if (rect && (rect.width || rect.height)) {
          if (drawBox(rect)) return true
          continue
        }
        const element = range.startContainer.parentElement
        if (element && revealHidden(element)) {
          window.setTimeout(() => {
            const again = findRangeIn(context, candidate.needle, candidate.occurrence)
            if (again) drawBox(again.getBoundingClientRect())
          }, 150)
          return true
        }
      }
      return false
    }

    function editUrlFor(href: string): string {
      try {
        const url = new URL(href, location.href)
        url.searchParams.set('external-editor', '1')
        return url.href
      } catch {
        return href
      }
    }

    function consumeAutoEdit(): boolean {
      const url = new URL(location.href)
      if (url.searchParams.get('external-editor') !== '1') return false
      url.searchParams.delete('external-editor')
      url.searchParams.delete('external-editor-section')
      try {
        history.replaceState(null, '', url.pathname + url.search + url.hash)
      } catch {}
      return true
    }

    function isArticleLink(anchor: HTMLAnchorElement): boolean {
      if (anchor.closest('.mw-editsection')) return false
      if (anchor.classList.contains('new') || anchor.classList.contains('external')) return false
      const url = new URL(anchor.href, location.href)
      if (url.origin !== location.origin) return false
      const query = url.searchParams
      if (query.get('action') || query.get('oldid') || query.get('diff') || query.get('redlink')) {
        return false
      }
      if (url.pathname.includes('/Special:') || url.pathname.includes('特殊:')) return false
      if (url.pathname === location.pathname && url.hash) return false
      return true
    }

    interface PointText {
      text: string
      section: string
      occurrence: number
    }

    function sectionForPoint(node: Node): string {
      const root = document.querySelector('#mw-content-text')
      if (!root) return ''
      const headings = [...root.querySelectorAll('h2')]
      let section = ''
      for (const heading of headings) {
        if (heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
          section = headingText(heading)
        }
      }
      return section
    }

    function textAtPoint(x: number, y: number): PointText | null {
      const caretDocument = document as CaretDocument
      let range: Range | null = null
      if (caretDocument.caretRangeFromPoint) {
        range = caretDocument.caretRangeFromPoint(x, y)
      } else if (document.caretPositionFromPoint) {
        const position = document.caretPositionFromPoint(x, y)
        if (position) {
          range = document.createRange()
          range.setStart(position.offsetNode, position.offset)
          range.collapse(true)
        }
      }
      if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return null
      const value = range.startContainer.nodeValue || ''
      const index = range.startOffset || 0
      const whole = value.replace(/\s+/g, ' ').trim()
      const text =
        whole.length >= 2 && whole.length <= 60
          ? whole
          : value
              .slice(Math.max(0, index - 40), Math.min(value.length, index + 40))
              .replace(/\s+/g, ' ')
              .trim()
      if (text.length < 2) return null
      const section = sectionForPoint(range.startContainer)
      let occurrence = 1
      try {
        const prefix = document.createRange()
        const root = document.querySelector('#mw-content-text')
        const heading = [...(root?.querySelectorAll('h2') || [])].find(item => headingText(item) === section)
        if (heading) prefix.setStartBefore(heading)
        else if (root) prefix.setStart(root, 0)
        else prefix.setStart(range.startContainer, 0)
        prefix.setEnd(range.startContainer, index)
        const before = prefix.toString().replace(/\s+/g, ' ')
        let cursor = 0
        occurrence = 1
        while ((cursor = before.indexOf(text, cursor)) >= 0) {
          occurrence++
          cursor += text.length
        }
      } catch {}
      return {text, section, occurrence}
    }

    // ---------- preview ----------
    function executeScripts(root: Element): void {
      root.querySelectorAll<HTMLScriptElement>('script').forEach(old => {
        if (old.dataset.mweExecuted) return
        const script = document.createElement('script')
        for (const attribute of Array.from(old.attributes)) {
          script.setAttribute(attribute.name, attribute.value)
        }
        script.textContent = old.textContent
        script.dataset.mweExecuted = '1'
        old.replaceWith(script)
      })
    }

    function applyFull(html: string): void {
      const root = document.querySelector('#mw-content-text')
      if (!root) return
      if (session && !session.fullOriginal) {
        session.fullOriginal = Array.from(root.childNodes)
      }
      const temp = document.createElement('div')
      temp.innerHTML = html
      root.replaceChildren(...Array.from(temp.childNodes))
      executeScripts(root)
      const mw = getMw()
      const jQuery = getJQuery()
      if (mw?.hook && jQuery) mw.hook('wikipage.content').fire(jQuery(root))
    }

    function schedulePreview(): void {
      clearTimeout(previewTimer)
      previewTimer = window.setTimeout(renderPreview, 250)
    }

    async function renderPreview(): Promise<boolean> {
      if (!session) return false
      const seq = ++previewSeq
      let data: ParseResponse
      try {
        data = await apiPost({
          action: 'parse',
          contentmodel: 'wikitext',
          title: session.title,
          text: session.text,
          pst: '1',
          preview: '1',
          disableeditsection: '1',
          disablelimitreport: '1',
          prop: 'text',
        })
      } catch (error) {
        if (seq === previewSeq) {
          status(`预览失败：${error instanceof Error ? error.message : String(error)}`)
        }
        return false
      }
      if (seq !== previewSeq || !data.parse?.text) return false
      applyFull(data.parse.text)
      setStatus(
        session.conflict
          ? '检测到编辑冲突，已载入冲突标记；处理后再提交'
          : `预览已更新 ${new Date().toLocaleTimeString()}`,
        session.conflict ? 'error' : undefined,
      )
      return true
    }

    // ---------- edit session ----------
    function restorePage(): void {
      const root = document.querySelector('#mw-content-text')
      if (root && session?.fullOriginal) {
        root.replaceChildren(...session.fullOriginal)
        session.fullOriginal = undefined
      }
    }

    function syncBarHeight(): void {
      const bar = document.querySelector<HTMLElement>('.mwe-ipe-bar')
      document.documentElement.style.setProperty(
        '--mwe-ipe-bar-height',
        `${bar?.offsetHeight ?? 0}px`,
      )
    }

    function endSession(): void {
      session = null
      clearTimeout(previewTimer)
      barResizeObserver?.disconnect()
      barResizeObserver = null
      document.documentElement.style.removeProperty('--mwe-ipe-bar-height')
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
      sessionQueryPromise = new Promise<SessionQueryResult>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          delete sessionWaiters[requestId]
          reject(new Error('扩展未响应会话查询'))
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
          reject(new Error('扩展未连接'))
        }
      }).catch(error => {
        sessionQueryPromise = null
        throw error
      })
      return sessionQueryPromise
    }

    function onSessionResult(msg: SessionResultMessage): void {
      const waiter = sessionWaiters[msg.requestId]
      if (!waiter) return
      clearTimeout(waiter.timer)
      delete sessionWaiters[msg.requestId]
      if (!msg.ok) waiter.reject(new Error(msg.error || '会话查询失败'))
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
        status(`恢复会话失败：${error instanceof Error ? error.message : String(error)}`, 'error')
        return
      }
      session = {
        id: info.sessionId,
        title: info.title,
        text: info.text,
        wikiPage,
        remoteDirty: !!info.dirty,
        changed: false,
        busy: false,
        conflict: false,
      }
      showBar(null)
      document.body.classList.remove('ipe-modal-no-scroll')
      setStatus('已恢复 VSCode 编辑会话')
      schedulePreview()
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
            '该页面已经在另一个浏览器窗口或 VSCode 编辑会话中。请先关闭那边的编辑会话后再试。',
            '页面已在编辑中',
          )
          return
        }
        if (existing.session) {
          await adoptSession(existing.session)
          return
        }
        const title = getMwConfig<string>('wgPageName')
        if (!title) throw new Error('无法读取当前页面标题')
        const wikiPage = await ctx.wikiPage.newFromTitle(title, false)
        const revision = wikiPage.revisions[0]
        session = {
          id: `s${Date.now()}`,
          title,
          text: revision?.content || '',
          wikiPage,
          remoteDirty: false,
          changed: false,
          busy: false,
          conflict: false,
        }
        showBar(null)
        document.body.classList.remove('ipe-modal-no-scroll')
        setStatus('VSCode 编辑中，保存文件即刷新预览')
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
        const message = `启动编辑失败：${
          error instanceof Error ? error.message : String(error)
        }。请确认 VSCode 扩展已启动并已更新网页端脚本。`
        status(message, 'error')
        notifyOffline(message, '启动编辑失败')
      }
    }

    function showImagesUsed(): void {
      if (!session || !ctx.modal) return
      fetch(
        `${API}?action=parse&format=json&formatversion=2&prop=images&page=${encodeURIComponent(session.title)}`,
      )
        .then(response => response.json() as Promise<ParseResponse>)
        .then(data => {
          const images = data.parse?.images || []
          const box = document.createElement('div')
          if (!images.length) {
            box.textContent = '没有使用的图片。'
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
            title: '使用的图片',
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
            ? 'VSCode 里还有未保存的修改，放弃并关闭编辑器？'
            : '还有未提交到站点的修改，确定放弃？',
        )
      ) {
        return
      }
      send({
        type: 'finish',
        sessionId: session.id,
        result: pending ? 'discarded' : 'unchanged',
      })
      restorePage()
      endSession()
      closeIfOpenedHere()
    }

    function showBar(modal: IPEModal | null): void {
      try {
        modal?.close()
      } catch {}
      ensureBar()
    }

    function requestSave(bar: HTMLDivElement): void {
      if (!session) return
      if (session.remoteDirty) {
        setStatus('VSCode 里有未保存修改，先保存文件（Ctrl+S）', 'error')
        return
      }
      setBusy(true)
      const summaryInput = bar.querySelector<HTMLInputElement>('.mwe-ipe-summary')
      const minorInput = bar.querySelector<HTMLInputElement>('.mwe-ipe-minor')
      const watchInput = bar.querySelector<HTMLSelectElement>('.mwe-ipe-watchlist')
      const reloadInput = bar.querySelector<HTMLInputElement>('.mwe-ipe-reload')
      session.watchlist = parseWatchlist(watchInput?.value || 'nochange')
      session.reload = !!reloadInput?.checked
      setStatus('正在保存文件…')
      send({
        type: 'request-save',
        sessionId: session.id,
        summary: summaryInput?.value || '',
        minor: !!minorInput?.checked,
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

    function reportConflict(
      latest: IWikiPage,
      message: string,
    ): boolean {
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
      setStatus('检测到编辑冲突，已载入冲突标记；处理后再提交', 'error')
      return true
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
        const baseRevid = session.wikiPage.revisions[0]?.revid
        let latest: IWikiPage | null = null
        try {
          latest = await latestPageForSession()
        } catch {}
        const latestRevid = latest?.revisions[0]?.revid
        if (
          baseRevid !== undefined &&
          latestRevid !== undefined &&
          latestRevid !== baseRevid &&
          latest
        ) {
          setBusy(false)
          reportConflict(latest, '页面已被其他人修改。')
          send({type: 'save-result', sessionId, requestId, ok: false, error: '编辑冲突'})
          return
        }
        if (latest) session.wikiPage = latest
        await session.wikiPage.edit({
          text,
          summary: summary || '',
          minor: !!minor,
          watchlist: session.watchlist || parseWatchlist('nochange'),
        })
          session.text = text
        session.changed = false
        session.conflict = false
        storePendingConfirm(sessionId)
        send({type: 'save-result', sessionId, requestId, ok: true})
        send({
          type: 'finish',
          sessionId,
          result: 'saved',
          summary: summary || '',
          minor: !!minor,
        })
        if (session.reload !== false) {
          setStatus('已保存，正在刷新并等待确认…', 'ok')
          setBusy(false)
          window.setTimeout(() => location.reload(), 800)
          return
        }
        const shown = await renderPreview()
        if (shown) {
          setStatus('已保存，新内容已显示', 'ok')
          sendPendingConfirm()
        } else {
          setStatus('已保存，但未能确认新内容；临时文件保留，刷新页面后会再次确认', 'error')
        }
        setBusy(false)
        endSession()
      } catch (error) {
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
          setStatus(`保存失败：${message}`, 'error')
        }
      }
    }

    // ---------- click -> locate ----------
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

    // ---------- lifecycle ----------
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
      tooltip: '在 VSCode 中编辑整页',
      onClick: () => {
        void beginPageEdit()
      },
    })

    document.addEventListener('click', onClick, true)

    ctx.on('dispose', () => {
      disposed = true
      connected = false
      clearTimeout(reconnectTimer)
      clearTimeout(previewTimer)
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
      ctx.toolbox?.removeButton(editButtonId)
      restorePage()
      endSession()
      document.getElementById(barStyleId)?.remove()
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
