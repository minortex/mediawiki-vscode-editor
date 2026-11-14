import type {SessionState} from '../protocol';
import type {SocketLike} from '../browser/server';
import type {WikiRecord} from '../wiki/registry';
import type {SessionStore, StoredSession} from './store';

export interface SessionMeta {
  fsPath: string;
  sockets: Set<SocketLike>;
  title: string;
  wiki: WikiRecord;
  revid?: number;
  basetimestamp?: string;
  starttimestamp?: string;
  windowId?: string;
  created: number;
  state: SessionState;
  autoRestore: boolean;
  awaitingConfirm?: boolean;
  originalHash?: string;
  /** Close the browser page after the save is confirmed. */
  closePageOnConfirm?: boolean;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionMeta>();
  private readonly byPath = new Map<string, string>();
  private readonly wsSessions = new Map<SocketLike, Set<string>>();

  constructor(
    private readonly store: SessionStore,
    private readonly onChange: () => void = () => {},
  ) {}

  load(): void {
    for (const entry of this.store.load()) {
      const meta: SessionMeta = {
        fsPath: entry.fsPath,
        sockets: new Set(),
        title: entry.title,
        wiki: entry.wiki,
        revid: entry.revid,
        basetimestamp: entry.basetimestamp,
        starttimestamp: entry.starttimestamp,
        windowId: entry.windowId,
        created: entry.created || Date.now(),
        state: 'draft',
        autoRestore: entry.autoRestore !== false,
        // A confirmation that outlived the browser cannot complete; keep the
        // file as a restorable draft instead of an invisible session.
        awaitingConfirm: false,
        originalHash: entry.originalHash,
        closePageOnConfirm: entry.closePageOnConfirm === true,
      };
      this.sessions.set(entry.sessionId, meta);
      this.byPath.set(meta.fsPath, entry.sessionId);
    }
    this.onChange();
  }

  persist(): void {
    this.store.save(this.entries().map(([sessionId, meta]) => this.serialize(sessionId, meta)));
  }

  flush(): Promise<void> {
    return this.store.flush();
  }

  private serialize(sessionId: string, meta: SessionMeta): StoredSession {
    return {
      sessionId,
      fsPath: meta.fsPath,
      title: meta.title,
      wiki: meta.wiki,
      revid: meta.revid,
      basetimestamp: meta.basetimestamp,
      starttimestamp: meta.starttimestamp,
      windowId: meta.windowId,
      created: meta.created,
      state: meta.state,
      autoRestore: meta.autoRestore,
      awaitingConfirm: meta.awaitingConfirm,
      originalHash: meta.originalHash,
      closePageOnConfirm: meta.closePageOnConfirm,
    };
  }

  add(sessionId: string, meta: SessionMeta): void {
    this.sessions.set(sessionId, meta);
    this.byPath.set(meta.fsPath, sessionId);
    if (meta.sockets.size) {
      for (const ws of meta.sockets) this.addWsSession(ws, sessionId);
    }
    this.persist();
    this.onChange();
  }

  get(sessionId: string): SessionMeta | undefined {
    return this.sessions.get(sessionId);
  }

  idForPath(fsPath: string): string | undefined {
    return this.byPath.get(fsPath);
  }

  forPath(fsPath: string): SessionMeta | undefined {
    const id = this.byPath.get(fsPath);
    return id ? this.sessions.get(id) : undefined;
  }

  entries(): Array<[string, SessionMeta]> {
    return [...this.sessions.entries()];
  }

  values(): SessionMeta[] {
    return [...this.sessions.values()];
  }

  remove(sessionId: string): SessionMeta | undefined {
    const meta = this.sessions.get(sessionId);
    if (!meta) return undefined;
    this.sessions.delete(sessionId);
    this.byPath.delete(meta.fsPath);
    for (const ws of meta.sockets) this.wsSessions.get(ws)?.delete(sessionId);
    meta.sockets.clear();
    this.persist();
    this.onChange();
    return meta;
  }

  attach(sessionId: string, ws: SocketLike): void {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    meta.sockets.add(ws);
    this.addWsSession(ws, sessionId);
    this.persist();
    this.onChange();
  }

  detachSession(sessionId: string): void {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    for (const ws of meta.sockets) this.wsSessions.get(ws)?.delete(sessionId);
    meta.sockets.clear();
    if (meta.state !== 'draft') meta.state = 'detached';
    this.persist();
    this.onChange();
  }

  detachWs(ws: SocketLike): string[] {
    const ids = [...(this.wsSessions.get(ws) || new Set<string>())];
    this.wsSessions.delete(ws);
    for (const id of ids) {
      const meta = this.sessions.get(id);
      if (!meta) continue;
      meta.sockets.delete(ws);
      if (meta.sockets.size === 0 && meta.state !== 'draft') meta.state = 'detached';
    }
    if (ids.length) {
      this.persist();
      this.onChange();
    }
    return ids;
  }

  markDraft(sessionId: string, autoRestore = false, clearAwaitingConfirm = false): void {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    for (const ws of meta.sockets) this.wsSessions.get(ws)?.delete(sessionId);
    meta.sockets.clear();
    meta.state = 'draft';
    meta.autoRestore = autoRestore;
    if (clearAwaitingConfirm) meta.awaitingConfirm = false;
    this.persist();
    this.onChange();
  }

  markAwaitingConfirm(sessionId: string): void {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    meta.awaitingConfirm = true;
    this.persist();
    this.onChange();
  }

  updateRevision(
    sessionId: string,
    revid?: number,
    basetimestamp?: string,
  ): void {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    if (revid !== undefined) meta.revid = revid;
    if (basetimestamp !== undefined) meta.basetimestamp = basetimestamp;
    this.persist();
    this.onChange();
  }

  markRestored(sessionId: string): void {
    const meta = this.sessions.get(sessionId);
    if (!meta || meta.state !== 'draft' || !meta.autoRestore) return;
    meta.state = 'detached';
    this.persist();
    this.onChange();
  }

  markAttached(sessionId: string): void {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    meta.state = 'attached';
    meta.autoRestore = true;
    this.persist();
    this.onChange();
  }

  drafts(): Array<[string, SessionMeta]> {
    return this.entries().filter(([, meta]) => meta.state === 'draft' && !meta.awaitingConfirm);
  }

  registerSocket(ws: SocketLike): void {
    if (!this.wsSessions.has(ws)) this.wsSessions.set(ws, new Set());
  }

  addWsSession(ws: SocketLike, sessionId: string): void {
    let set = this.wsSessions.get(ws);
    if (!set) {
      set = new Set();
      this.wsSessions.set(ws, set);
    }
    set.add(sessionId);
  }
}
