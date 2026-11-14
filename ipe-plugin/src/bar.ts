import type {Session} from './types'

export const BAR_STYLE_ID = 'mwe-ipe-bar-style'

export interface SaveForm {
  summary: string
  minor: boolean
  watchlist: string
}

/** Read the editable fields; callers never touch the bar's DOM. */
export function readForm(bar: HTMLDivElement): SaveForm {
  return {
    summary: bar.querySelector<HTMLInputElement>('.mwe-ipe-summary-input')?.value || '',
    minor: !!bar.querySelector<HTMLInputElement>('.mwe-ipe-minor-box')?.checked,
    watchlist: bar.querySelector<HTMLSelectElement>('.mwe-ipe-watchlist')?.value || 'nochange',
  }
}

export interface BarActions {
  submit(form: SaveForm): void
  cancel(): void
  upload(): void
  templates(): void
  images(): void
  diff(): void
}

export interface BarOptions {
  translate(message: string, ...args: string[]): string
  getSession(): Session | null
  actions: BarActions
}

export function createBarUi({translate, getSession, actions}: BarOptions) {
  let barResizeObserver: ResizeObserver | null = null

  function ensureBarStyle(): void {
    let style = document.getElementById(BAR_STYLE_ID) as HTMLStyleElement | null
    if (!style) {
      style = document.createElement('style')
      style.id = BAR_STYLE_ID
      document.head.append(style)
    }
    style.textContent = [
      '.mwe-ipe-bar{position:fixed;left:0;right:0;bottom:0;z-index:900;display:flex;gap:4px 8px;align-items:center;flex-wrap:wrap;background:#fff;border-top:2px solid #3366cc;padding:6px 12px;box-shadow:0 -2px 12px rgba(0,0,0,.15);font-size:13px;color:#202122;box-sizing:border-box;}',
      '.mwe-ipe-bar .mwe-ipe-status{flex:1 1 200px;min-width:0;color:#72777d;line-height:1.35;white-space:normal;overflow-wrap:anywhere;}',
      '.mwe-ipe-bar .mwe-ipe-status.error{color:#d33;}',
      '.mwe-ipe-bar .mwe-ipe-status.ok{color:#14866d;}',
      '.mwe-ipe-bar .mwe-ipe-controls{display:flex;flex:2 1 340px;flex-wrap:wrap;align-items:center;gap:6px;min-width:0;}',
      '.mwe-ipe-bar .mwe-ipe-summary{display:flex;flex:1 1 200px;align-items:center;gap:6px;min-width:0;}',
      '.mwe-ipe-bar .mwe-ipe-summary input[type=text]{flex:1 1 auto;min-width:0;height:32px;box-sizing:border-box;padding:0 10px;border:1px solid #a2a9b1;border-radius:4px;font-size:14px;}',
      '.mwe-ipe-bar select{flex:0 0 auto;padding:4px 8px;border:1px solid #a2a9b1;border-radius:4px;background:#fff;font-size:13px;color:#202122;}',
      '.mwe-ipe-bar button{flex:0 0 auto;height:32px;box-sizing:border-box;padding:0 14px;border-radius:4px;border:1px solid #a2a9b1;background:#f8f9fa;cursor:pointer;font-size:14px;color:#202122;}',
      '.mwe-ipe-bar button:hover{background:#eaecf0;}',
      '.mwe-ipe-bar button.is-primary{background:#3366cc;border-color:#3366cc;color:#fff;font-weight:600;}',
      '.mwe-ipe-bar button.is-primary:hover{background:#2a56a8;}',
      '.mwe-ipe-bar .mwe-ipe-cancel{margin-left:auto;}',
      '.mwe-ipe-bar label{display:flex;align-items:center;gap:4px;white-space:nowrap;}',
      '.mwe-ipe-bar .mwe-ipe-minor{gap:3px;font-size:11px;color:#54595d;}',
      '.mwe-ipe-bar .mwe-ipe-more-wrap{position:relative;flex:0 0 auto;}',
      '.mwe-ipe-bar .mwe-ipe-more{padding:0 10px;font-size:16px;line-height:1;letter-spacing:1px;}',
      '.mwe-ipe-bar .mwe-ipe-menu{position:absolute;bottom:100%;right:0;display:flex;flex-direction:column;gap:2px;min-width:150px;padding:4px;background:#fff;border:1px solid #a2a9b1;border-radius:4px;box-shadow:0 2px 10px rgba(0,0,0,.18);}',
      '.mwe-ipe-bar .mwe-ipe-menu[hidden]{display:none;}',
      '.mwe-ipe-bar .mwe-ipe-menu select{width:100%;}',
      '.mwe-ipe-bar .mwe-ipe-menu-item{border:0;background:transparent;text-align:left;padding:6px 8px;border-radius:3px;font-size:13px;}',
      '.mwe-ipe-bar .mwe-ipe-menu-item:hover{background:#eaecf0;}',
      '@media (max-width:760px){.mwe-ipe-bar{padding:6px 10px;}.mwe-ipe-bar .mwe-ipe-status,.mwe-ipe-bar .mwe-ipe-controls,.mwe-ipe-bar .mwe-ipe-summary{flex-basis:100%;}}',
      'body.mwe-ipe-editing{padding-bottom:calc(var(--mwe-ipe-bar-height, 96px) + 16px);}',
      'body.mwe-ipe-editing #ipe-edit-toolbox{bottom:var(--mwe-ipe-bar-height, 96px);transform:none;}',
    ].join('\n')
  }

  function syncBarHeight(): void {
    const bar = document.querySelector<HTMLElement>('.mwe-ipe-bar')
    document.documentElement.style.setProperty(
      '--mwe-ipe-bar-height',
      `${bar?.offsetHeight ?? 0}px`,
    )
  }

  function setStatus(text: string, kind?: string): void {
    const el = document.querySelector('.mwe-ipe-status')
    if (!el) return
    el.textContent = text || ''
    el.className = 'mwe-ipe-status' + (kind ? ' ' + kind : '')
    // The bar height changes when a long status wraps; keep the page padding
    // in step even if the ResizeObserver callback is throttled.
    syncBarHeight()
  }

  function refreshBar(): void {
    const bar = document.querySelector('.mwe-ipe-bar')
    const session = getSession()
    if (!bar || !session) return
    const submit = bar.querySelector<HTMLButtonElement>('.mwe-ipe-submit')
    if (submit) submit.disabled = !!session.remoteDirty || !!session.busy
    if (session.remoteDirty) {
      setStatus(translate('VSCode has unsaved changes; save the file first (Ctrl+S)'))
    }
  }

  function setBusy(busy: boolean): void {
    const session = getSession()
    if (session) session.busy = !!busy
    const bar = document.querySelector('.mwe-ipe-bar')
    if (!bar) return
    bar.querySelectorAll('button').forEach(button => {
      button.disabled = !!busy
    })
    if (busy) setStatus(translate('Submitting…'))
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
      `<span class="mwe-ipe-status">${translate('Editing in VSCode')}</span>` +
      '<div class="mwe-ipe-controls">' +
      '<div class="mwe-ipe-summary">' +
      `<input type="text" class="mwe-ipe-summary-input" placeholder="${translate('Edit summary')}">` +
      `<label class="mwe-ipe-minor"><input type="checkbox" class="mwe-ipe-minor-box"> ${translate('Minor edit')}</label>` +
      '</div>' +
      `<button class="mwe-ipe-diff">${translate('Diff')}</button>` +
      '<div class="mwe-ipe-more-wrap">' +
      `<button class="mwe-ipe-more" aria-haspopup="true" aria-expanded="false" aria-label="${translate('More')}" title="${translate('More')}">⋯</button>` +
      '<div class="mwe-ipe-menu" hidden>' +
      `<select class="mwe-ipe-watchlist" aria-label="${translate('Watchlist')}">` +
      `<option value="preferences">${translate('Follow MediaWiki preference')}</option>` +
      `<option value="nochange">${translate('Keep current status')}</option>` +
      `<option value="watch">${translate('Add to watchlist')}</option>` +
      `<option value="unwatch">${translate('Remove from watchlist')}</option>` +
      '</select>' +
      `<button class="mwe-ipe-menu-item mwe-ipe-upload">${translate('Quick upload')}</button>` +
      `<button class="mwe-ipe-menu-item mwe-ipe-templates">${translate('Templates used')}</button>` +
      `<button class="mwe-ipe-menu-item mwe-ipe-images">${translate('Images used')}</button>` +
      '</div>' +
      '</div>' +
      `<button class="mwe-ipe-cancel">${translate('Cancel')}</button>` +
      `<button class="mwe-ipe-submit is-primary">${translate('Submit')}</button>` +
      '</div>'
    document.body.append(bar)
    attachBarMetrics(bar)
    bar.querySelector('.mwe-ipe-submit')?.addEventListener('click', () => {
      actions.submit(readForm(bar))
    })
    bar.querySelector('.mwe-ipe-cancel')?.addEventListener('click', () => {
      actions.cancel()
    })
    bar.querySelector('.mwe-ipe-upload')?.addEventListener('click', () => {
      actions.upload()
    })
    bar.querySelector('.mwe-ipe-templates')?.addEventListener('click', () => {
      actions.templates()
    })
    bar.querySelector('.mwe-ipe-images')?.addEventListener('click', () => {
      actions.images()
    })
    bar.querySelector('.mwe-ipe-diff')?.addEventListener('click', () => {
      actions.diff()
    })
    const moreWrap = bar.querySelector<HTMLElement>('.mwe-ipe-more-wrap')
    const moreButton = bar.querySelector<HTMLButtonElement>('.mwe-ipe-more')
    const menu = bar.querySelector<HTMLElement>('.mwe-ipe-menu')
    let menuTimer: number | undefined
    const setMenu = (open: boolean): void => {
      if (!menu) return
      menu.hidden = !open
      moreButton?.setAttribute('aria-expanded', String(open))
    }
    const openMenu = (): void => {
      window.clearTimeout(menuTimer)
      setMenu(true)
    }
    const closeMenuSoon = (): void => {
      window.clearTimeout(menuTimer)
      menuTimer = window.setTimeout(() => setMenu(false), 120)
    }
    moreWrap?.addEventListener('mouseenter', openMenu)
    moreWrap?.addEventListener('mouseleave', closeMenuSoon)
    moreButton?.addEventListener('click', event => {
      event.stopPropagation()
      window.clearTimeout(menuTimer)
      setMenu(!!menu?.hidden)
    })
    menu?.addEventListener('click', event => {
      // Keep the native watchlist dropdown open while picking an option.
      if (event.target instanceof Element && event.target.closest('select')) return
      window.clearTimeout(menuTimer)
      setMenu(false)
    })
    menu?.addEventListener('change', () => {
      window.clearTimeout(menuTimer)
      setMenu(false)
    })
    bar.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('.mwe-ipe-more-wrap')) return
      window.clearTimeout(menuTimer)
      setMenu(false)
    })
    return bar
  }

  /** Drop the bar's observers and the layout variable (session end). */
  function detach(): void {
    barResizeObserver?.disconnect()
    barResizeObserver = null
    document.documentElement.style.removeProperty('--mwe-ipe-bar-height')
  }

  return {ensureBar, refreshBar, setBusy, setStatus, syncBarHeight, detach}
}
