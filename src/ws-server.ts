import { WebSocketServer } from 'ws';

export interface SocketLike {
  send(data: string): void;
  on(event: string, listener: (...args: any[]) => void): void;
  origin?: string;
  readyState?: number;
}

export interface WsServerOptions {
  port: number;
  allowedOrigin?: string;
  onMessage?(msg: any, ws: SocketLike): void;
  onConnection?(ws: SocketLike, req: any): void;
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
    verifyClient: (info: any, done: (ok: boolean, code?: number, message?: string) => void) => {
      const origin = info.req.headers.origin;
      if (!origin || !allowedOrigin || allowedOrigin === '*' || origin === allowedOrigin) {
        done(true);
      } else {
        done(false, 403, 'forbidden origin');
      }
    },
  });

  wss.on('connection', (ws: any, req) => {
    ws.origin = req?.headers?.origin;
    ws.on('message', (raw: any) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      onMessage?.(msg, ws);
    });
    onConnection?.(ws, req);
  });

  wss.on('error', (err) => onError?.(err));
  return wss;
}
