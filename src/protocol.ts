/** Shared WebSocket protocol between the VSCode extension and browser scripts. */

export type SessionState = 'attached' | 'detached' | 'draft';

export interface WikiIdentity {
  id: string;
  name: string;
  origin: string;
}

export interface SessionSnapshot {
  sessionId: string;
  title: string;
  section: number | null;
  text: string;
  dirty: boolean;
  state: SessionState;
  revid?: number;
  basetimestamp?: string;
  starttimestamp?: string;
  wiki: WikiIdentity;
}

export interface OpenMessage {
  type: 'open';
  sessionId: string;
  title: string;
  section?: number | null;
  text: string;
  revid?: number;
  basetimestamp?: string;
  starttimestamp?: string;
  wiki?: string;
}

export interface RegisterWikiMessage {
  type: 'register-wiki';
  requestId: string;
  origin: string;
  api: string;
  name?: string;
  siteinfo: unknown;
}

export interface SessionQueryMessage {
  type: 'session-query';
  requestId: string;
  origin: string;
  title: string;
}

export interface OpenResultMessage {
  type: 'open-result';
  requestId: string;
  opened: boolean;
}

export interface FinishMessage {
  type: 'finish';
  sessionId: string;
  result: 'saved' | 'discarded' | 'unchanged' | 'closed';
  summary?: string;
  minor?: boolean;
}

export interface LocateMessage {
  type: 'locate';
  sessionId: string;
  text: string;
}

export interface RequestSaveMessage {
  type: 'request-save';
  sessionId: string;
  summary?: string;
  minor?: boolean;
}

export interface SaveResultMessage {
  type: 'save-result';
  sessionId: string;
  requestId?: string;
  ok: boolean;
  error?: string;
}

export interface SaveConfirmedMessage {
  type: 'save-confirmed';
  sessionId: string;
  origin?: string;
}

export interface HeartbeatMessage {
  type: 'heartbeat';
  sessionId?: string;
}

export type BrowserMessage =
  | OpenMessage
  | RegisterWikiMessage
  | SessionQueryMessage
  | OpenResultMessage
  | FinishMessage
  | LocateMessage
  | RequestSaveMessage
  | SaveResultMessage
  | SaveConfirmedMessage
  | HeartbeatMessage;

export interface WikiRegisteredMessage {
  type: 'wiki-registered';
  requestId: string;
  ok: boolean;
  wiki?: WikiIdentity;
  error?: string;
}

export interface SessionResultMessage {
  type: 'session-result';
  requestId: string;
  ok: boolean;
  session?: SessionSnapshot | null;
  error?: string;
}

export interface NavigateEditMessage {
  type: 'navigate-edit';
  requestId: string;
  title: string;
  fragment?: string;
}

export interface SessionStateMessage {
  type: 'session-state';
  sessionId: string;
  state: SessionState;
  editorOpen: boolean;
  dirty: boolean;
}

export interface UpdateMessage {
  type: 'update';
  sessionId: string;
  text: string;
}

export interface DirtyStateMessage {
  type: 'state';
  sessionId: string;
  dirty: boolean;
}

export interface ScrollMessage {
  type: 'scroll';
  sessionId: string;
  text: string;
  occurrence: number;
  scope?: unknown;
  label?: string | null;
  labelOccurrence?: number;
  prev?: string | null;
  next?: string | null;
}

export interface SaveMessage {
  type: 'save';
  sessionId: string;
  requestId?: string;
  text: string;
  summary?: string;
  minor?: boolean;
}

export interface SaveConfirmedResultMessage {
  type: 'save-confirmed-result';
  sessionId: string;
  ok: boolean;
  error?: string;
}

export interface EditorClosedMessage {
  type: 'editor-closed';
  sessionId: string;
}

export interface PreemptedMessage {
  type: 'preempted';
  sessionId: string;
}

export interface ClosedMessage {
  type: 'closed';
  sessionId: string;
  result: 'saved' | 'discarded' | 'unchanged' | 'closed';
}

export type ExtensionMessage =
  | WikiRegisteredMessage
  | SessionResultMessage
  | NavigateEditMessage
  | SessionStateMessage
  | UpdateMessage
  | DirtyStateMessage
  | ScrollMessage
  | SaveMessage
  | SaveConfirmedResultMessage
  | FinishMessage
  | EditorClosedMessage
  | PreemptedMessage
  | ClosedMessage;
