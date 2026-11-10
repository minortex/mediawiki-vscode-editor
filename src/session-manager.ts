import type { SessionState } from './protocol';
import type { SessionStore, StoredSession, StoredWiki } from './session-store';

export interface SocketLike {
  send(data: string): void;
  readyState?: number;
}

export interface SessionMeta {
  fsPath: string;
  ws: SocketLike | null;
  title: string;
  section: number | null;
  wiki: StoredWiki;
  revid?: number;
  basetimestamp?: string;
  starttimestamp?: string;
  created: number;
  state: SessionState;
  autoRestore: boolean;
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
        ws: null,
        title: entry.title,
        section: entry.section ?? null,
        wiki: entry.wiki,
        revid: entry.revid,
        basetimestamp: entry.basetimestamp,
        starttimestamp: entry.starttimestamp,
        created: entry.created || Date.now(),
        state: 'draft',
        autoRestore: entry.autoRestore !== false,
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
      section: meta.section,
      wiki: meta.wiki,
      revid: meta.revid,
      basetimestamp: meta.basetimestamp,
      starttimestamp: meta.starttimestamp,
      created: meta.created,
      state: meta.state,
      autoRestore: meta.autoRestore,
    };
  }

  add(sessionId: string, meta: SessionMeta): void {
    this.sessions.set(sessionId, meta);
    this.byPath.set(meta.fsPath, sessionId);
    if (meta.ws) this.addWsSession(meta.ws, sessionId);
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
    if (meta.ws) this.wsSessions.get(meta.ws)?.delete(sessionId);
    this.persist();
    this.onChange();
    return meta;
  }

  attach(sessionId: string, ws: SocketLike): void {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    if (meta.ws && meta.ws !== ws) this.wsSessions.get(meta.ws)?.delete(sessionId);
    meta.ws = ws;
    this.addWsSession(ws, sessionId);
    this.persist();
    this.onChange();
  }

  detachSession(sessionId: string): void {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    if (meta.ws) this.wsSessions.get(meta.ws)?.delete(sessionId);
    meta.ws = null;
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
      meta.ws = null;
      if (meta.state !== 'draft') meta.state = 'detached';
    }
    if (ids.length) {
      this.persist();
      this.onChange();
    }
    return ids;
  }

  markDraft(sessionId: string, autoRestore = false): void {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    if (meta.ws) this.wsSessions.get(meta.ws)?.delete(sessionId);
    meta.ws = null;
    meta.state = 'draft';
    meta.autoRestore = autoRestore;
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
    return this.entries().filter(([, meta]) => meta.state === 'draft');
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
