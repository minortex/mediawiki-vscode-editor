import {getJQuery, getMw} from './mw'
import type {ParseResponse, Session} from './types'

export interface PreviewOptions {
  translate(message: string, ...args: string[]): string
  request(params: Record<string, string>): Promise<ParseResponse>
  getSession(): Session | null
  setStatus(text: string, kind?: string): void
}

export function createPreview({translate, request, getSession, setStatus}: PreviewOptions) {
  let previewTimer: number | undefined
  let previewSeq = 0

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
    const session = getSession()
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

  function restorePage(): void {
    const root = document.querySelector('#mw-content-text')
    const session = getSession()
    if (root && session?.fullOriginal) {
      root.replaceChildren(...session.fullOriginal)
      session.fullOriginal = undefined
    }
  }

  function schedulePreview(): void {
    clearTimeout(previewTimer)
    previewTimer = window.setTimeout(renderPreview, 250)
  }

  async function renderPreview(): Promise<boolean> {
    const session = getSession()
    if (!session) return false
    const seq = ++previewSeq
    let data: ParseResponse
    try {
      data = await request({
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
        const detail = error instanceof Error ? error.message : String(error)
        setStatus(translate('Preview failed: {{ $1 }}', detail))
      }
      return false
    }
    if (seq !== previewSeq || !data.parse?.text) return false
    applyFull(data.parse.text)
    setStatus(
      session.conflict
        ? translate(
            'Edit conflict detected; conflict markers are loaded. Resolve them before submitting.',
          )
        : translate('Preview updated at {{ $1 }}', new Date().toLocaleTimeString()),
      session.conflict ? 'error' : undefined,
    )
    return true
  }

  /** Stop a queued preview (session end). */
  function cancel(): void {
    clearTimeout(previewTimer)
    previewSeq++
  }

  return {schedulePreview, renderPreview, restorePage, cancel}
}
