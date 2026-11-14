import type {
  BrowserMessage,
  ExtensionMessage,
  NavigateEditMessage,
  SaveMessage,
} from '../protocol';
import {startWsServer, type SocketLike} from './server';
import type {WebSocketServer} from 'ws';
import type {IncomingMessage} from 'node:http';
import {l10n} from 'vscode';

type OutgoingRequest = Omit<NavigateEditMessage, 'requestId'> | Omit<SaveMessage, 'requestId'>;

export interface StartOptions {
  port: number;
  allowedOrigin?: string;
  onMessage(msg: BrowserMessage, ws: SocketLike): void | Promise<void>;
  onConnection?(ws: SocketLike, req: IncomingMessage): void;
  onError?(error: Error): void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class BrowserBridge {
  private wss: WebSocketServer | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private sequence = 0;

  get connectionCount(): number {
    return this.wss?.clients.size ?? 0;
  }

  start(options: StartOptions): void {
    this.wss = startWsServer({
      port: options.port,
      allowedOrigin: options.allowedOrigin,
      onConnection: (ws, req) => options.onConnection?.(ws, req),
      onError: error => options.onError?.(error),
      onMessage: (msg, ws) => {
        if (this.resolveRequest(msg)) return;
        const result = options.onMessage(msg, ws);
        if (result instanceof Promise) result.catch(() => {});
      },
    });
  }

  stop(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(l10n.t('Browser connection closed')));
    }
    this.pending.clear();
    try {
      this.wss?.close();
    } catch {}
    this.wss = null;
  }

  send(ws: SocketLike, message: ExtensionMessage): boolean {
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  broadcast(message: ExtensionMessage): number {
    if (!this.wss) return 0;
    const data = JSON.stringify(message);
    let count = 0;
    for (const client of this.wss.clients) {
      if (client.readyState === 1) {
        client.send(data);
        count++;
      }
    }
    return count;
  }

  request<T = unknown>(ws: SocketLike, message: OutgoingRequest, timeoutMs = 5000): Promise<T> {
    const requestId = `req-${++this.sequence}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(l10n.t('The browser did not respond to the request')));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      });
      if (!this.send(ws, {...message, requestId} as ExtensionMessage)) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error(l10n.t('Browser is not connected')));
      }
    });
  }

  private resolveRequest(msg: BrowserMessage): boolean {
    if (!('requestId' in msg) || typeof msg.requestId !== 'string') return false;
    const pending = this.pending.get(msg.requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(msg.requestId);
    if ('ok' in msg && msg.ok === false) {
      const error = 'error' in msg && typeof msg.error === 'string'
        ? msg.error
        : l10n.t('Browser request failed');
      pending.reject(new Error(error));
    } else {
      pending.resolve(msg);
    }
    return true;
  }
}
