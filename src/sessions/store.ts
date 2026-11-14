import fs from 'node:fs';
import path from 'node:path';
import type {SessionState} from '../protocol';
import type {WikiRecord} from '../wiki/registry';

export interface StoredSession {
  sessionId: string;
  fsPath: string;
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

export class SessionStore {
  private queue: Promise<void> = Promise.resolve();

  /** Temp files from the removed section-editing mode, kept out of the index. */
  readonly legacySectionPaths: string[] = [];

  constructor(private readonly filePath: string | undefined) {}

  load(): StoredSession[] {
    this.legacySectionPaths.length = 0;
    if (!this.filePath) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is StoredSession => {
      if (!item || typeof item !== 'object') return false;
      const record = item as Partial<StoredSession> & {section?: unknown};
      if (
        typeof record.sessionId !== 'string'
        || typeof record.fsPath !== 'string'
        || typeof record.wiki?.origin !== 'string'
        || !fs.existsSync(record.fsPath)
      ) {
        return false;
      }
      // Section text must never be treated as a whole page.
      if (record.section != null) {
        this.legacySectionPaths.push(record.fsPath);
        return false;
      }
      return true;
    });
  }

  flush(): Promise<void> {
    return this.queue;
  }

  save(records: StoredSession[]): void {
    if (!this.filePath) return;
    const file = this.filePath;
    const data = `${JSON.stringify(records, null, 2)}\n`;
    this.queue = this.queue
      .then(async () => {
        await fs.promises.mkdir(path.dirname(file), {recursive: true});
        const tmp = `${file}.tmp`;
        const handle = await fs.promises.open(tmp, 'w');
        try {
          await handle.writeFile(data, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.promises.rename(tmp, file);
        // Best effort: persist the rename itself on filesystems that need it.
        try {
          const dir = await fs.promises.open(path.dirname(file), 'r');
          try {
            await dir.sync();
          } finally {
            await dir.close();
          }
        } catch {}
      })
      .catch(() => {});
  }
}
