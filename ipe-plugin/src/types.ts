import type {IWikiPage, WatchlistAction} from '@inpageedit/core'

export interface SiteError {
  code?: string
  info?: string
}

export interface SiteInfoResponse {
  error?: SiteError
  query?: unknown
}

export interface ParseResponse {
  parse?: {
    text?: string
    images?: string[]
  }
}

export interface SessionInfo {
  sessionId: string
  title: string
  text: string
  dirty?: boolean
  revid?: number
  basetimestamp?: string
  starttimestamp?: string
}

export interface Session {
  id: string
  title: string
  text: string
  wikiPage: IWikiPage
  remoteDirty: boolean
  changed: boolean
  busy: boolean
  conflict?: boolean
  watchlist?: WatchlistAction
  fullOriginal?: Node[]
}

export interface PendingConfirm {
  sessionId: string
  origin: string
  /** Revision proven to hold the saved content; the temp file needs it. */
  revid: number
}

export interface EditResult {
  newrevid?: number
  nochange?: boolean
}

export interface RevisionInfo {
  revid: number
  parentid?: number
  content?: string
  slots?: {main?: {content?: string}}
}

export interface RevisionQueryResponse {
  error?: SiteError
  query?: {
    pages?: Array<{missing?: boolean; revisions?: RevisionInfo[]}>
  }
}

export interface TextContext {
  nodes: Array<{node: Text; start: number; end: number}>
  norm: string
  map: number[]
}

export interface PointText {
  text: string
  section: string
  occurrence: number
}

export interface ScrollScope {
  type: 'poem'
  index: number
}

export interface TemplateBlockTarget {
  name: string
  params: Record<string, string>
  section: string
  occurrence: number
}

export interface TemplatesUsedService {
  showModal(options?: {title?: string; wikiPage?: IWikiPage}): unknown
}

export interface WikiRegisteredMessage {
  type: 'wiki-registered'
  requestId: string
  ok: boolean
  error?: string
}

export interface SessionResultMessage {
  type: 'session-result'
  requestId: string
  ok: boolean
  session?: SessionInfo | null
  busy?: boolean
  error?: string
}

export interface SessionQueryResult {
  session: SessionInfo | null
  busy: boolean
}

export interface NavigateEditMessage {
  type: 'navigate-edit'
  requestId: string
  title: string
  fragment?: string
}

export interface UpdateMessage {
  type: 'update'
  sessionId: string
  text: string
}

export interface DirtyStateMessage {
  type: 'state'
  sessionId: string
  dirty: boolean
}

export interface ScrollTextMessage {
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

export interface ScrollSectionMessage {
  type: 'scroll'
  kind: 'section'
  sessionId: string
  section?: string
}

export interface ScrollTemplateMessage {
  type: 'scroll'
  kind: 'template'
  sessionId: string
  template: TemplateBlockTarget
}

export type ScrollMessage =
  | ScrollTextMessage
  | ScrollSectionMessage
  | ScrollTemplateMessage

export interface SaveMessage {
  type: 'save'
  sessionId: string
  requestId?: string
  text: string
  summary?: string
  minor?: boolean
}

export interface FinishMessage {
  type: 'finish'
  sessionId: string
  result: 'saved' | 'discarded' | 'unchanged' | 'closed'
}

export interface EditorClosedMessage {
  type: 'editor-closed'
  sessionId: string
}

export interface PreemptedMessage {
  type: 'preempted'
  sessionId: string
}

export interface SaveConfirmedResultMessage {
  type: 'save-confirmed-result'
  sessionId: string
  ok: boolean
}

export type IncomingMessage =
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

export type OutgoingMessage =
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
  | {type: 'save-confirmed'; sessionId: string; revid: number; origin: string}
  | {type: 'open-result'; requestId: string; opened: boolean}

export interface Waiter<T> {
  resolve(value: T): void
  reject(error: Error): void
  timer: number
  query?: T
}
