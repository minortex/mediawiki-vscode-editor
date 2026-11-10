import type {InPageEdit, IWikiPage, QuickEditEventPayload} from '@inpageedit/core'

const WS_URL = 'ws://127.0.0.1:8927'
const RECONNECT_MS = 5000

interface Session {
  id: string
  title: string
  section: number | 'new' | undefined
  text: string
  wikiPage: IWikiPage
  remoteDirty: boolean
  changed: boolean
  busy: boolean
  watchlist?: any
  reload?: boolean
  fullOriginal?: Node[]
}

interface Waiter {
  resolve: (value: any) => void
  reject: (error: any) => void
  timer: number
  query?: any
}

const getMw = (): any => (window as any).mw
const getMwConfig = (key: string): any => getMw()?.config?.get?.(key)
const getMwUtil = (): any => getMw()?.util
const getJQuery = (): any => (window as any).jQuery

function apiUrl(): string {
  const util = getMwUtil()
  return util && typeof util.wikiScript === 'function'
    ? util.wikiScript('api')
    : new URL('/api.php', location.origin).href
}

export default {
  name: 'vscode-editor',
  inject: ['quickEdit', 'quickUpload', 'templatesUsed', 'quickDiff'],
  apply(ctx: InPageEdit) {
    const API = apiUrl()

    let socket: WebSocket | null = null
    let connected = false
    let session: Session | null = null
    let previewTimer: number | undefined
    let previewSeq = 0
    let reconnectTimer: number | undefined
    let disposed = false

    let registeredWiki: any = null
    let registeringWiki: Promise<any> | null = null
    let registerSeq = 0
    const registerWaiters: Record<string, Waiter> = {}
    let pendingStart: QuickEditEventPayload | null = null
    let sessionQueryPromise: Promise<any> | null = null
    let sessionQuerySeq = 0
    const sessionWaiters: Record<string, Waiter> = {}

    // ---------- hide the native quick-edit modal before it paints ----------
    function ensureGuardStyle(): void {
      if (document.getElementById('mwe-ipe-guard-style')) return
      const style = document.createElement('style')
      style.id = 'mwe-ipe-guard-style'
      style.textContent = [
        '.ipe-modal-modal__window.ipe-quickEdit{display:none!important;}',
        '.ipe-modal-backdrop:has(+ .ipe-modal-modal .ipe-quickEdit){display:none!important;}',
      ].join('\n')
      document.head.append(style)
    }

    // ---------- bottom bar ----------
    const barStyleId = 'mwe-ipe-bar-style'

    function ensureBarStyle(): void {
      if (document.getElementById(barStyleId)) return
      const style = document.createElement('style')
      style.id = barStyleId
      style.textContent = [
        '.mwe-ipe-bar{position:fixed;left:0;right:0;bottom:0;z-index:2147483001;display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#fff;border-top:2px solid #3366cc;padding:10px 16px;box-shadow:0 -2px 12px rgba(0,0,0,.15);font-size:14px;color:#202122;}',
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
        'body.mwe-ipe-editing{padding-bottom:96px;}',
      ].join('\n')
      document.head.append(style)
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

    function ensureBar(): HTMLDivElement {
      ensureBarStyle()
      let bar = document.querySelector<HTMLDivElement>('.mwe-ipe-bar')
      if (bar) return bar
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
      document.body.classList.add('mwe-ipe-editing')
      bar.querySelector('.mwe-ipe-submit')?.addEventListener('click', () => {
        requestSave(bar!)
      })
      bar.querySelector('.mwe-ipe-cancel')?.addEventListener('click', () => {
        cancelEdit()
      })
      bar.querySelector('.mwe-ipe-upload')?.addEventListener('click', () => {
        const quickUpload = ctx.quickUpload
        if (quickUpload) void quickUpload.showModal()
      })
      bar.querySelector('.mwe-ipe-templates')?.addEventListener('click', () => {
        if (!session) return
        const templatesUsed = (ctx as any).templatesUsed
        if (templatesUsed) void templatesUsed.showModal({title: session.title})
      })
      bar.querySelector('.mwe-ipe-images')?.addEventListener('click', () => {
        showImagesUsed()
      })
      bar.querySelector('.mwe-ipe-diff')?.addEventListener('click', () => {
        if (!session) return
        const quickDiff = ctx.quickDiff
        if (!quickDiff) return
        const from = session.wikiPage.revisions[0]?.content || ''
        if (from === session.text) return
        quickDiff.comparePages({
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

    // ---------- api ----------
    function apiPost(params: Record<string, any>): Promise<any> {
      return fetch(API, {
        method: 'POST',
        credentials: 'include',
        headers: {'content-type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams(Object.assign({format: 'json', formatversion: '2'}, params)),
      }).then(response => response.json())
    }

    // ---------- websocket ----------
    function fetchSiteInfo(): Promise<any> {
      const params = {
        action: 'query',
        meta: 'siteinfo',
        siprop: 'general|namespaces|namespacealiases|magicwords|functionhooks|extensiontags|variables|interwikimap',
        format: 'json',
        formatversion: '2',
      }
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? window.setTimeout(() => controller.abort(), 20000) : null
      return fetch(API + '?' + new URLSearchParams(params), {
        credentials: 'include',
        signal: controller ? controller.signal : undefined,
      })
        .then(response => {
          if (!response.ok) throw new Error('HTTP ' + response.status)
          return response.json()
        })
        .then(data => {
          if (data.error) throw new Error(data.error.code + ': ' + data.error.info)
          if (!data.query || !data.query.general) throw new Error('站点没有返回 siteinfo')
          return data.query
        })
        .finally(() => {
          if (timer) clearTimeout(timer)
        })
    }

    function notifyOffline(message?: string, title?: string): void {
      const text = message || 'VSCode 扩展未连接。请手动打开 VSCode，并确认已安装并启用 MediaWiki 扩展。'
      const modal = ctx.modal
      if (modal && typeof modal.notify === 'function') {
        modal.notify('warning', {
          title: title || 'VSCode 未连接',
          content: text,
          position: 'top right',
          closeAfter: {time: 8000, resetOnHover: true},
        } as any)
        return
      }
      const old = document.getElementById('mwe-offline-notice')
      if (old) old.remove()
      const box = document.createElement('div')
      box.id = 'mwe-offline-notice'
      box.style.cssText =
        'position:fixed;top:20px;right:20px;z-index:2147483003;max-width:360px;background:#fff;color:#202122;border:1px solid #a2a9b1;border-left:4px solid #fc3;padding:12px 14px;border-radius:4px;font-size:13px;line-height:1.5;box-shadow:0 2px 12px rgba(0,0,0,.2);'
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
      const modal = ctx.modal
      if (modal && typeof modal.notify === 'function') {
        modal.notify('warning', {
          title: '弹窗被拦截',
          content: link,
          position: 'top right',
          closeAfter: {time: 10000, resetOnHover: true},
        } as any)
      } else {
        notifyOffline('弹窗被拦截，请手动打开目标页面。', '需要打开页面')
      }
    }

    function openNavigate(msg: any): void {
      let url: URL
      try {
        url = new URL(getMwUtil().getUrl(msg.title), location.href)
      } catch {
        send({type: 'open-result', requestId: msg.requestId, opened: false})
        return
      }
      url.searchParams.set('external-editor', '1')
      if (msg.fragment) url.hash = msg.fragment
      const name = 'mwe-edit:' + encodeURIComponent(msg.title)
      let win: Window | null = null
      try {
        win = window.open(url.href, name)
      } catch {
        // popup blocked
      }
      if (!win) {
        showOpenLink(url.href)
        send({type: 'open-result', requestId: msg.requestId, opened: false})
        return
      }
      try {
        win.focus()
      } catch {
        // ignore
      }
      send({type: 'open-result', requestId: msg.requestId, opened: true})
    }

    function ensureWikiRegistered(): Promise<any> {
      if (registeredWiki) return Promise.resolve(registeredWiki)
      if (registeringWiki) return registeringWiki
      registeringWiki = fetchSiteInfo()
        .then(query => {
          const requestId = 'reg-' + Date.now() + '-' + ++registerSeq
          return new Promise<any>((resolve, reject) => {
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
              name: getMwConfig('wgSiteName') || location.host,
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

    function onWikiRegistered(msg: any): void {
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
        const notice = document.getElementById('mwe-offline-notice')
        if (notice) notice.remove()
        void (async () => {
          try {
            await ensureWikiRegistered()
            const existing = await queryExistingSession()
            if (existing) {
              await adoptSession(existing)
              pendingStart = null
              return
            }
          } catch (e) {
            status('站点注册失败：' + (e instanceof Error ? e.message : String(e)), 'error')
          }
          if (session) {
            restorePage()
            endSession()
            notifyOffline('扩展没有该会话，已退出编辑态。', '会话已结束')
            return
          }
          if (pendingStart) {
            const pending = pendingStart
            pendingStart = null
            startEdit(pending).catch(e => {
              status('启动失败：' + (e instanceof Error ? e.message : String(e)), 'error')
            })
          }
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
        } catch {
          // ignore
        }
      })
      socket.addEventListener('message', event => {
        let msg: any
        try {
          msg = JSON.parse(event.data)
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
        if (!session || msg.sessionId !== session.id) return
        if (msg.type === 'update') {
          session.text = msg.text
          session.changed = true
          schedulePreview()
        } else if (msg.type === 'state') {
          session.remoteDirty = !!msg.dirty
          refreshBar()
        } else if (msg.type === 'scroll') {
          scrollToOccurrence(
            msg.text,
            msg.occurrence,
            msg.scope,
            msg.label,
            msg.prev,
            msg.next,
            msg.labelOccurrence
          )
        } else if (msg.type === 'save') {
          setStatus('正在提交…')
          void saveEdit(msg.text, msg.summary, msg.minor)
        } else if (msg.type === 'finish') {
          if (msg.result === 'closed') restorePage()
          endSession()
          if (window.name.indexOf('mwe-edit:') === 0 && msg.result !== 'closed') {
            window.setTimeout(() => window.close(), 50)
          }
        } else if (msg.type === 'editor-closed') {
          restorePage()
          endSession()
          notifyOffline('编辑器已关闭，草稿已保留。', '编辑器已关闭')
        } else if (msg.type === 'preempted') {
          restorePage()
          endSession()
          notifyOffline('已在另一个标签继续编辑。', '会话已转移')
        }
      })
    }

    function send(msg: Record<string, any>): boolean {
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
        'position:absolute;left:' + left + 'px;top:' + top + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px;' +
        'pointer-events:none;z-index:2147482999;outline:2px solid #3366cc;' +
        'background:rgba(51,102,204,.15);border-radius:2px;'
      document.body.append(box)
      window.setTimeout(() => box.remove(), 1600)
      return true
    }

    function revealHidden(el: Element): boolean {
      let node: Element | null = el
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

    interface TextContext {
      nodes: Array<{node: Text; start: number; end: number}>
      norm: string
      map: number[]
    }

    function buildTextContext(root: Element): TextContext {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const nodes: Array<{node: Text; start: number; end: number}> = []
      let raw = ''
      let node: Node | null
      while ((node = walker.nextNode())) {
        const parent = (node as Text).parentElement
        if (parent && parent.closest('script,style,.vc-preview')) continue
        const start = raw.length
        raw += node.nodeValue || ''
        nodes.push({node: node as Text, start, end: raw.length})
      }
      let norm = ''
      const map: number[] = []
      let space = false
      for (let i = 0; i < raw.length; i++) {
        if (/\s/.test(raw[i])) {
          if (!space) {
            norm += ' '
            map.push(i)
            space = true
          }
        } else {
          norm += raw[i]
          map.push(i)
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
        const head = context.nodes.find(n => rawStart >= n.start && rawStart < n.end)
        const tail = context.nodes.find(n => rawEnd <= n.end && rawEnd > n.start)
        if (!head || !tail) continue
        const range = document.createRange()
        range.setStart(head.node, rawStart - head.start)
        range.setEnd(tail.node, rawEnd - tail.start)
        return range
      }
      return null
    }

    function scrollToOccurrence(
      text: string,
      occurrence: number,
      scope: any,
      label?: string,
      prev?: string,
      next?: string,
      labelOccurrence?: number
    ): boolean {
      if (!text) return false
      const all = document.querySelector('#mw-content-text')
      if (!all) return false
      let root: Element = all
      if (scope && scope.type === 'poem') {
        const poem = all.querySelectorAll('.poem')[scope.index]
        if (!poem) return false
        root = poem
      }
      const wanted = Math.max(1, Number(occurrence) || 1)
      const candidates: Array<{needle: string; occurrence: number}> = []
      function push(value: string | undefined, occ: number): void {
        const needle = String(value || '').replace(/\s+/g, ' ').trim()
        if (needle.length < 2) return
        if (candidates.some(c => c.needle === needle)) return
        candidates.push({needle, occurrence: occ})
      }
      if (scope) {
        push(text, wanted)
      } else {
        if (label) {
          push(label + ' ' + text, labelOccurrence || 1)
          push(label + text, labelOccurrence || 1)
        }
        if (next) {
          push(text + ' ' + next, 1)
          push(text + next, 1)
        }
        if (prev) {
          push(prev + ' ' + text, 1)
          push(prev + text, 1)
        }
        push(text, wanted)
      }
      const context = buildTextContext(root)
      for (const candidate of candidates) {
        const range = findRangeIn(context, candidate.needle, candidate.occurrence)
        if (!range) continue
        const rect = range.getBoundingClientRect()
        if (rect && (rect.width || rect.height)) {
          if (drawBox(rect)) return true
          continue
        }
        const el = range.startContainer.parentElement
        if (el && revealHidden(el)) {
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

    function consumeAutoEdit(): {section?: number | 'new'} | null {
      const url = new URL(location.href)
      if (url.searchParams.get('external-editor') !== '1') return null
      const section = url.searchParams.get('external-editor-section')
      url.searchParams.delete('external-editor')
      url.searchParams.delete('external-editor-section')
      try {
        history.replaceState(null, '', url.pathname + url.search + url.hash)
      } catch {
        // ignore
      }
      return {section: section == null || section === '' ? undefined : (Number(section) as number)}
    }

    function isArticleLink(a: HTMLAnchorElement): boolean {
      if (a.closest('.mw-editsection')) return false
      if (a.classList.contains('new') || a.classList.contains('external')) return false
      const url = new URL(a.href, location.href)
      if (url.origin !== location.origin) return false
      const q = url.searchParams
      if (q.get('action') || q.get('oldid') || q.get('diff') || q.get('redlink')) return false
      if (url.pathname.indexOf('/Special:') >= 0 || url.pathname.indexOf('特殊:') >= 0) return false
      if (url.pathname === location.pathname && url.hash) return false
      return true
    }

    function textAtPoint(x: number, y: number): string | null {
      let range: Range | null = null
      const documentWithCaret = document as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null
        caretPositionFromPoint?: (x: number, y: number) => {offsetNode: Node; offset: number} | null
      }
      if (documentWithCaret.caretRangeFromPoint) {
        range = documentWithCaret.caretRangeFromPoint(x, y)
      } else if (documentWithCaret.caretPositionFromPoint) {
        const pos = documentWithCaret.caretPositionFromPoint(x, y)
        if (pos) {
          range = document.createRange()
          range.setStart(pos.offsetNode, pos.offset)
          range.collapse(true)
        }
      }
      if (!range || !range.startContainer || range.startContainer.nodeType !== Node.TEXT_NODE) {
        return null
      }
      const value = range.startContainer.nodeValue || ''
      const index = range.startOffset || 0
      const s = value
        .slice(Math.max(0, index - 40), Math.min(value.length, index + 40))
        .replace(/\s+/g, ' ')
        .trim()
      return s.length >= 2 ? s : null
    }

    // ---------- preview ----------
    function executeScripts(root: Element): void {
      if (!root) return
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
      if (mw?.hook && typeof getJQuery() === 'function') {
        mw.hook('wikipage.content').fire(getJQuery()(root))
      }
    }

    function schedulePreview(): void {
      clearTimeout(previewTimer)
      previewTimer = window.setTimeout(renderPreview, 250)
    }

    async function renderPreview(): Promise<void> {
      if (!session) return
      if (session.section != null) {
        setStatus('VSCode 编辑中（章节预览暂不支持）')
        return
      }
      const seq = ++previewSeq
      const params = {
        action: 'parse',
        contentmodel: 'wikitext',
        title: session.title,
        text: session.text,
        pst: '1',
        preview: '1',
        disableeditsection: '1',
        disablelimitreport: '1',
        prop: 'text',
      }
      let data: any
      try {
        data = await apiPost(params)
      } catch (e) {
        if (seq === previewSeq) status('预览失败：' + (e instanceof Error ? e.message : String(e)))
        return
      }
      if (seq !== previewSeq || !data.parse) return
      applyFull(data.parse.text)
      setStatus('预览已更新 ' + new Date().toLocaleTimeString())
    }

    // ---------- edit session ----------
    function onBeforeUnload(event: BeforeUnloadEvent): string | void {
      if (session && (session.changed || session.remoteDirty)) {
        event.preventDefault()
        event.returnValue = '还有未提交的修改，确定离开？'
        return event.returnValue
      }
    }

    function restorePage(): void {
      const root = document.querySelector('#mw-content-text')
      if (root && session && session.fullOriginal) {
        root.replaceChildren(...session.fullOriginal)
        session.fullOriginal = undefined
      }
    }

    function endSession(): void {
      session = null
      clearTimeout(previewTimer)
      window.removeEventListener('beforeunload', onBeforeUnload)
      const bar = document.querySelector('.mwe-ipe-bar')
      if (bar) bar.remove()
      document.body.classList.remove('mwe-ipe-editing')
    }

    function queryExistingSession(): Promise<any> {
      if (sessionQueryPromise) return sessionQueryPromise
      if (!connected) return Promise.resolve(null)
      const requestId = 'session-' + Date.now() + '-' + ++sessionQuerySeq
      sessionQueryPromise = new Promise<any>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          delete sessionWaiters[requestId]
          reject(new Error('扩展未响应会话查询'))
        }, 8000)
        sessionWaiters[requestId] = {resolve, reject, timer}
        if (
          !send({
            type: 'session-query',
            requestId,
            origin: location.origin,
            title: getMwConfig('wgPageName'),
          })
        ) {
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

    function onSessionResult(msg: any): void {
      const waiter = sessionWaiters[msg.requestId]
      if (!waiter) return
      clearTimeout(waiter.timer)
      delete sessionWaiters[msg.requestId]
      if (!msg.ok) waiter.reject(new Error(msg.error || '会话查询失败'))
      else waiter.resolve(msg.session || null)
    }

    async function adoptSession(info: any): Promise<void> {
      if (!info || session) return
      let wikiPage: IWikiPage | undefined
      try {
        wikiPage = info.revid
          ? await ctx.wikiPage.newFromRevision(info.revid, info.section)
          : await ctx.wikiPage.newFromTitle(info.title, false, info.section)
      } catch (e) {
        status('恢复会话失败：' + (e instanceof Error ? e.message : String(e)), 'error')
        return
      }
      if (!wikiPage) {
        status('无法恢复编辑会话：InPageEdit wikiPage 不可用', 'error')
        return
      }
      session = {
        id: info.sessionId,
        title: info.title,
        section: info.section,
        text: info.text,
        wikiPage,
        remoteDirty: !!info.dirty,
        changed: false,
        busy: false,
      }
      window.addEventListener('beforeunload', onBeforeUnload)
      showBar(null)
      document.body.classList.remove('ipe-modal-no-scroll')
      setStatus('已恢复 VSCode 编辑会话')
      schedulePreview()
    }

    async function startEdit(payload: QuickEditEventPayload): Promise<void> {
      const options = payload.options
      const modal = payload.modal
      const wikiPage = payload.wikiPage
      if (session) return
      if (!connected) {
        pendingStart = payload
        notifyOffline()
        return
      }
      try {
        await ensureWikiRegistered()
        const existing = await queryExistingSession()
        if (existing) {
          await adoptSession(existing)
          return
        }
      } catch (e) {
        const message =
          '站点注册失败：' +
          (e instanceof Error ? e.message : String(e)) +
          '。请更新网页端脚本并刷新页面。'
        status(message)
        notifyOffline(message, '站点注册失败')
        return
      }
      const rev = wikiPage.revisions?.[0]
      session = {
        id: 's' + Date.now(),
        title: wikiPage.pageInfo?.title || options.title,
        section: options.section,
        text: (rev && rev.content) || '',
        wikiPage,
        remoteDirty: false,
        changed: false,
        busy: false,
      }
      window.addEventListener('beforeunload', onBeforeUnload)
      showBar(modal)
      document.body.classList.remove('ipe-modal-no-scroll')
      setStatus('VSCode 编辑中，保存文件即刷新预览')
      send({
        type: 'open',
        sessionId: session.id,
        title: session.title,
        section: session.section,
        text: session.text,
        revid: rev && rev.revid,
        basetimestamp: rev && rev.timestamp,
        starttimestamp: new Date().toISOString(),
        wiki: location.origin,
      })
    }

    function showImagesUsed(): void {
      if (!session) return
      const modal = ctx.modal
      if (!modal) return
      fetch(
        API +
          '?action=parse&format=json&formatversion=2&prop=images&page=' +
          encodeURIComponent(session.title)
      )
        .then(response => response.json())
        .then(data => {
          const images: string[] = (data.parse && data.parse.images) || []
          const box = document.createElement('div')
          if (!images.length) {
            box.textContent = '没有使用的图片。'
          } else {
            const list = document.createElement('ol')
            images.forEach(title => {
              const name = /^File:/i.test(title) ? title : 'File:' + title
              const item = document.createElement('li')
              const link = document.createElement('a')
              link.href = '/wiki/' + encodeURIComponent(name)
              link.target = '_blank'
              link.rel = 'noopener'
              link.textContent = name
              item.append(link)
              list.append(item)
            })
            box.append(list)
          }
          modal.show({
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
            : '还有未提交到站点的修改，确定放弃？'
        )
      ) {
        return
      }
      try {
        send({type: 'finish', sessionId: session.id, result: pending ? 'discarded' : 'unchanged'})
      } catch {
        // ignore
      }
      window.removeEventListener('beforeunload', onBeforeUnload)
      restorePage()
      endSession()
    }

    function showBar(modal: any): void {
      try {
        if (modal) modal.close()
      } catch {
        // ignore
      }
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
      session.watchlist = watchInput ? watchInput.value : 'nochange'
      session.reload = !!(reloadInput && reloadInput.checked)
      setStatus('正在保存文件…')
      send({
        type: 'request-save',
        sessionId: session.id,
        summary: summaryInput ? summaryInput.value : '',
        minor: !!(minorInput && minorInput.checked),
      })
    }

    async function saveEdit(text: string, summary: string, minor: boolean): Promise<void> {
      if (!session) return
      try {
        await session.wikiPage.edit({
          text,
          summary: summary || '',
          minor: !!minor,
          section: session.section,
          watchlist: session.watchlist || 'nochange',
        })
        window.removeEventListener('beforeunload', onBeforeUnload)
        send({type: 'save-result', sessionId: session.id, ok: true})
        send({
          type: 'finish',
          sessionId: session.id,
          result: 'saved',
          summary: summary || '',
          minor: !!minor,
        })
        setStatus(session.reload === false ? '已保存' : '已保存，正在刷新…', 'ok')
        setBusy(false)
        if (session.reload !== false) {
          window.setTimeout(() => location.reload(), 800)
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        setBusy(false)
        send({type: 'save-result', sessionId: session.id, ok: false, error: message})
        setStatus('保存失败：' + message, 'error')
      }
    }

    // ---------- click -> locate ----------
    function onClick(event: MouseEvent): void {
      if (!session) return
      const target = event.target as Element | null
      if (target?.closest && !target.closest('#mw-content-text')) return
      const anchor = target?.closest?.('a') as HTMLAnchorElement | null
      if (anchor) {
        if (!isArticleLink(anchor)) return
        event.preventDefault()
        window.open(editUrlFor(anchor.href), '_blank', 'noopener')
        return
      }
      const text = textAtPoint(event.clientX, event.clientY)
      if (text) send({type: 'locate', sessionId: session.id, text})
    }

    // ---------- registration / lifecycle ----------
    ensureGuardStyle()
    connect()

    ctx.on('quick-edit/show-modal', payload => {
      try {
        payload.modal.close()
      } catch {
        // ignore
      }
      document.body.classList.remove('ipe-modal-no-scroll')
    })

    ctx.on('quick-edit/wiki-page', payload => {
      startEdit(payload).catch(e => {
        status('启动失败：' + (e instanceof Error ? e.message : String(e)))
      })
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
      } catch {
        // ignore
      }
      socket = null
      document.removeEventListener('click', onClick, true)
      restorePage()
      endSession()
      document.getElementById('mwe-ipe-guard-style')?.remove()
      document.getElementById(barStyleId)?.remove()
      document.getElementById('mwe-offline-notice')?.remove()
    })

    const autoEdit = consumeAutoEdit()
    if (autoEdit) {
      window.setTimeout(() => {
        if (disposed) return
        try {
          const title = getMwConfig('wgPageName')
          if (!title) throw new Error('无法读取当前页面标题')
          if (typeof ctx.quickEdit !== 'function') throw new Error('InPageEdit 缺少 quickEdit')
          void ctx.quickEdit({title, section: autoEdit.section})
        } catch (e) {
          status('自动进入编辑失败：' + (e instanceof Error ? e.message : String(e)), 'error')
        }
      }, 0)
    }
  },
}
