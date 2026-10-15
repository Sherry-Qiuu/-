/* Origin 校验场景回归：node test/origin-scenarios.js（需先启动服务器） */
const { io } = require('socket.io-client');
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3987';
function tryConn(desc, headers, expectPass) {
  return new Promise(res => {
    const s = io(BASE, { extraHeaders: headers, transports: ['websocket'], reconnection: false, timeout: 4000 });
    s.on('connect', () => { console.log((expectPass ? 'PASS 连接成功' : 'FAIL 不该通过但连上了'), desc); s.close(); res(expectPass); });
    s.on('connect_error', e => { console.log(expectPass ? 'FAIL 应通过却被拒: ' + desc + ' -> ' + e.message : 'PASS 按预期拒绝: ' + desc + ' -> ' + e.message); res(!expectPass); });
  });
}
(async () => {
  const r = await fetch(BASE + '/');
  const c = (r.headers.get('set-cookie') || '').split(';')[0];
  let ok = true;
  ok &= await tryConn('正常直连', { Origin: BASE, Cookie: c }, true);
  ok &= await tryConn('伪造外域', { Origin: 'http://evil.example.com', Cookie: c }, false);
  ok &= await tryConn('代理场景 Host 被改写', { Origin: 'https://minesweeper-arena-34333.app.workbuddy.host', Host: 'internal.sandbox.local', 'X-Forwarded-Host': 'minesweeper-arena-34333.app.workbuddy.host', Cookie: c }, true);
  ok &= await tryConn('代理场景但外域 Origin', { Origin: 'https://evil.example.com', Host: 'internal.sandbox.local', 'X-Forwarded-Host': 'minesweeper-arena-34333.app.workbuddy.host', Cookie: c }, false);
  process.exit(ok ? 0 : 1);
})();
