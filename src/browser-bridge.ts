import type { ExtensionMessage } from './protocol';
import {startWsServer, type SocketLike} from './ws-server';

export interface StartOptions {
  port: number;
  allowedOrigin?: string;
  onMessage(msg: any, ws: SocketLike): void | Promise<void>;
  onConnection?(ws: SocketLike, req?: unknown): void;
  onError?(error: Error): void;
}

interface PendingRequest {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class BrowserBridge {
  private wss: any = null;
  private readonly pending = new Map<string, PendingRequest>();
  private sequence = 0;

  get connectionCount(): number {
    return this.wss?.clients?.size ?? 0;
  }

  start(options: StartOptions): void {
    this.wss = startWsServer({
      port: options.port,
      allowedOrigin: options.allowedOrigin,
      onConnection: (ws: SocketLike, req?: unknown) => {
        options.onConnection?.(ws, req);
      },
      onError: (error: Error) => options.onError?.(error),
      onMessage: (msg: any, ws: SocketLike) => {
        if (this.resolveRequest(msg)) return;
        const result = options.onMessage(msg, ws);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(() => {});
        }
      },
    });
  }

  stop(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('浏览器连接已关闭'));
    }
    this.pending.clear();
    try {
      this.wss?.close();
    } catch {}
    this.wss = null;
  }

  send(ws: SocketLike, message: ExtensionMessage | Record<string, unknown>): boolean {
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  broadcast(message: ExtensionMessage | Record<string, unknown>): number {
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

  request<T = any>(
    ws: SocketLike,
    message: Record<string, unknown>,
    timeoutMs = 5000,
  ): Promise<T> {
    const requestId = `req-${++this.sequence}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('浏览器未响应请求'));
      }, timeoutMs);
      this.pending.set(requestId, {resolve, reject, timer});
      if (!this.send(ws, {...message, requestId})) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error('浏览器未连接'));
      }
    });
  }

  private resolveRequest(msg: any): boolean {
    if (!msg || typeof msg.requestId !== 'string') return false;
    const pending = this.pending.get(msg.requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(msg.requestId);
    if (msg.ok === false) pending.reject(new Error(msg.error || '浏览器请求失败'));
    else pending.resolve(msg);
    return true;
  }
}
