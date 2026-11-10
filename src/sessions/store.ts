import fs from 'node:fs';
import path from 'node:path';
import type {SessionState} from '../protocol';
import type {WikiRecord} from '../wiki/registry';

export interface StoredSession {
  sessionId: string;
  fsPath: string;
  title: string;
  section: number | null;
  wiki: WikiRecord;
  revid?: number;
  basetimestamp?: string;
  starttimestamp?: string;
  windowId?: string;
  created: number;
  state: SessionState;
  autoRestore: boolean;
  awaitingConfirm?: boolean;
}

export class SessionStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string | undefined) {}

  load(): StoredSession[] {
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
      const record = item as Partial<StoredSession>;
      return typeof record.sessionId === 'string'
        && typeof record.fsPath === 'string'
        && typeof record.wiki?.origin === 'string'
        && fs.existsSync(record.fsPath);
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
        await fs.promises.writeFile(tmp, data, 'utf8');
        await fs.promises.rename(tmp, file);
      })
      .catch(() => {});
  }
}
