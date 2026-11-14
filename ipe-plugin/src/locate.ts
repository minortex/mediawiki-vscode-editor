import type {PointText, ScrollScope, TemplateBlockTarget, TextContext} from './types'

type CaretDocument = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null
}

export function drawBox(rect: DOMRect): boolean {
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

export function revealHidden(element: Element): boolean {
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

export function buildTextContext(root: Element, scopeRange?: Range): TextContext {
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

export function findRangeIn(context: TextContext, needle: string, occurrence: number): Range | null {
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

export function headingText(heading: Element): string {
  const clone = heading.cloneNode(true) as Element
  clone.querySelectorAll('.mw-editsection').forEach(item => item.remove())
  return clone.textContent?.replace(/\s+/g, ' ').trim() || ''
}

export function sectionRange(scope?: string): Range | undefined {
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

export function highlightSection(section?: string): boolean {
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

/** Relative weights for template-block candidates; higher is a better match. */
const SCORE = {
  entry: 300,
  title: 200,
  text: 80,
  param: 10,
  navbox: 20,
  infobox: 15,
  longText: 5,
  longTextLength: 100,
  maxParams: 8,
  min: 60,
} as const

interface BlockMatcher {
  name: string
  entry: string
  params: string[]
}

interface ScoredBlock {
  element: Element
  score: number
  titleMatch: boolean
  textMatch: boolean
  entryMatch: boolean
}

function scoreBlock(element: Element, matcher: BlockMatcher): ScoredBlock | null {
  const text = compactText(element.textContent || '')
  if (!text) return null
  const title = blockTitle(element)
  const titleMatch = Boolean(matcher.name && title.includes(matcher.name))
  const textMatch = Boolean(matcher.name && text.includes(matcher.name))
  const entryMatch =
    Boolean(matcher.entry) &&
    element.matches('.pm-card') &&
    compactText(element.querySelector('.pm-title, .pm-title-txt')?.textContent || '') ===
      matcher.entry
  let score = 0
  if (titleMatch) score += SCORE.title
  else if (textMatch) score += SCORE.text
  if (entryMatch) score += SCORE.entry
  const matchedParams = matcher.params.filter(value => text.includes(value)).length
  score += Math.min(SCORE.maxParams, matchedParams) * SCORE.param
  if (element.matches('table.navbox, .navbox')) score += SCORE.navbox
  if (element.matches('.infobox, .infoBox')) score += SCORE.infobox
  if (text.length > SCORE.longTextLength) score += SCORE.longText
  return score >= SCORE.min ? {element, score, titleMatch, textMatch, entryMatch} : null
}

export function highlightTemplate(target: TemplateBlockTarget): boolean {
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
    '.pm-card',
  ].join(',')
  const matcher: BlockMatcher = {
    name: compactText(target.name),
    entry: compactText(target.params?.['条目'] || ''),
    params: Object.values(target.params)
      .map(compactText)
      .filter(value => value.length >= 2),
  }
  const entryMatches: ScoredBlock[] = []
  const titleMatches: ScoredBlock[] = []
  const textMatches: ScoredBlock[] = []
  for (const element of root.querySelectorAll(selector)) {
    if (range && !range.intersectsNode(element)) continue
    const candidate = scoreBlock(element, matcher)
    if (!candidate) continue
    if (candidate.entryMatch) entryMatches.push(candidate)
    if (candidate.titleMatch) titleMatches.push(candidate)
    if (candidate.textMatch) textMatches.push(candidate)
  }
  // 纯参数命中不算数：只有块标题/正文含模板名，或条目参数与卡片标题一致，
  // 才可能是真正的模板块；否则宁可不动，也不要跳到无关位置。
  const pool = entryMatches.length
    ? entryMatches
    : titleMatches.length
      ? titleMatches
      : textMatches
  if (!pool.length) return false
  pool.sort((a, b) => b.score - a.score)
  const chosen = pool[Math.min(target.occurrence - 1, pool.length - 1)]?.element
  if (!(chosen instanceof HTMLElement)) return false
  revealHidden(chosen)
  return drawBox(chosen.getBoundingClientRect())
}

export function scrollToOccurrence(
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

export function editUrlFor(href: string): string {
  try {
    const url = new URL(href, location.href)
    url.searchParams.set('external-editor', '1')
    return url.href
  } catch {
    return href
  }
}

export function consumeAutoEdit(): boolean {
  const url = new URL(location.href)
  if (url.searchParams.get('external-editor') !== '1') return false
  url.searchParams.delete('external-editor')
  url.searchParams.delete('external-editor-section')
  try {
    history.replaceState(null, '', url.pathname + url.search + url.hash)
  } catch {}
  return true
}

export function isArticleLink(anchor: HTMLAnchorElement): boolean {
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

export function textAtPoint(x: number, y: number): PointText | null {
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
