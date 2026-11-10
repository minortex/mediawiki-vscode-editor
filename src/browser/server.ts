import type {IncomingMessage} from 'node:http';
import {WebSocketServer, type RawData} from 'ws';
import type {BrowserMessage} from '../protocol';

export interface SocketLike {
  send(data: string): void;
  on(event: 'close', listener: () => void): this;
  on(event: 'message', listener: (data: RawData) => void): this;
  origin?: string;
  readyState?: number;
}

export interface WsServerOptions {
  port: number;
  allowedOrigin?: string;
  onMessage?(msg: BrowserMessage, ws: SocketLike): void;
  onConnection?(ws: SocketLike, req: IncomingMessage): void;
  onError?(error: Error): void;
}

export function startWsServer({
  port,
  allowedOrigin,
  onMessage,
  onConnection,
  onError,
}: WsServerOptions): WebSocketServer {
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    verifyClient: (info, done) => {
      const origin = info.req.headers.origin;
      if (!origin || !allowedOrigin || allowedOrigin === '*' || origin === allowedOrigin) {
        done(true);
      } else {
        done(false, 403, 'forbidden origin');
      }
    },
  });

  wss.on('connection', (socket, req) => {
    const ws = socket as typeof socket & SocketLike;
    ws.origin = req.headers.origin;
    ws.on('message', raw => {
      let msg: BrowserMessage;
      try {
        msg = JSON.parse(raw.toString()) as BrowserMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || !('type' in msg) || typeof msg.type !== 'string') {
        return;
      }
      onMessage?.(msg, ws);
    });
    onConnection?.(ws, req);
  });

  wss.on('error', (error: Error) => onError?.(error));
  return wss;
}
