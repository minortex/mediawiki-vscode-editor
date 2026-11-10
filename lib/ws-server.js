'use strict';

const { WebSocketServer } = require('ws');

/**
 * Minimal local WebSocket server shared by the extension and the test mock.
 * Only loopback connections from the configured origin are accepted.
 */
function startWsServer({ port, allowedOrigin, onMessage, onConnection, onError }) {
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

  wss.on('connection', (ws, req) => {
    ws.origin = req?.headers?.origin;
    ws.on('message', (raw) => {
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

function broadcast(wss, msg) {
  const data = JSON.stringify(msg);
  let count = 0;
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(data);
      count++;
    }
  }
  return count;
}

module.exports = { startWsServer, broadcast };
