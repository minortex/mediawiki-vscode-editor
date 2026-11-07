'use strict';

// 开发联调用的假 VSCode 后端：只实现协议，不打开编辑器。
//   MOCK_MODE=dirty   收到 open 后回一条 state(dirty:true)   （默认）
//   MOCK_MODE=update  收到 open 后回一条 update(text+标记)
//   MOCK_PORT=8927    监听端口
const { startWsServer } = require('../lib/ws-server');

const mode = process.env.MOCK_MODE || 'dirty';
const port = Number(process.env.MOCK_PORT || 8927);

const wss = startWsServer({
  port,
  allowedOrigin: 'https://vcpedia.cn',
  onConnection: () => console.log('[mock] browser connected'),
  onError: (err) => {
    console.error('[mock] error:', err.message);
    process.exit(1);
  },
  onMessage: (msg, ws) => {
    console.log(
      '[mock] recv',
      msg.type,
      'session=' + msg.sessionId,
      'title=' + msg.title,
      'section=' + msg.section
    );
    if (msg.type === 'open') {
      if (mode === 'template') {
        setTimeout(() => {
          if (ws.readyState !== 1) return;
          ws.send(
            JSON.stringify({
              type: 'scroll',
              sessionId: msg.sessionId,
              heading: -1,
              ratio: 0,
              center: true,
              texts: ['幸福刑'],
            })
          );
          console.log('[mock] sent scroll template');
        }, 800);
      } else if (mode === 'update') {
        setTimeout(() => {
          const text = String(msg.text) + '\n\nVSCode 测试标记';
          ws.send(JSON.stringify({ type: 'update', sessionId: msg.sessionId, text }));
          console.log('[mock] sent update');
        }, 600);
      } else {
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'state', sessionId: msg.sessionId, dirty: true }));
          console.log('[mock] sent state dirty');
        }, 400);
      }
    }
    if (msg.type === 'finish') {
      console.log('[mock] finish', msg.result, msg.summary || '');
    }
  },
});

wss.on('listening', () => console.log(`[mock] ws on ${port}, mode=${mode}`));
