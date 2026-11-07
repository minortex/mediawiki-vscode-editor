'use strict';

// 仅用于本地测试：模拟 VSCode 扩展的协议行为。
const { startWsServer } = require('../lib/ws-server');

const wss = startWsServer({
  port: 8927,
  allowedOrigin: 'https://vcpedia.cn',
  onConnection: () => console.log('[mock] browser connected'),
  onError: (err) => console.error('[mock] error:', err.message),
  onMessage: (msg, ws) => {
    console.log(
      '[mock] recv',
      msg.type,
      'session=' + msg.sessionId,
      'title=' + msg.title,
      'section=' + msg.section,
      'len=' + (msg.text || '').length
    );
    if (msg.type === 'open') {
      setTimeout(() => {
        const edited = String(msg.text) + '\n\nVSCode 测试标记';
        ws.send(JSON.stringify({ type: 'update', sessionId: msg.sessionId, text: edited }));
        console.log('[mock] sent update, len=' + edited.length);
      }, 800);
    }
    if (msg.type === 'finish') {
      console.log('[mock] finish result=' + msg.result, 'summary=' + msg.summary);
    }
  },
});

wss.on('listening', () => console.log('[mock] ws listening on 8927'));
