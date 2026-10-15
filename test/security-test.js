/* 安全与稳定性回归测试：node test/security-test.js（先单独启动服务器） */
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3987';
const { io } = require('socket.io-client');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS', name); }
  else { failed++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(path, cookie) {
  const res = await fetch(BASE + path, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: await res.text(), setCookie };
}
function cookieVal(setCookie) {
  if (!setCookie) return null;
  return setCookie.split(';')[0];
}
function connect(cookie, origin) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  return new Promise((resolve, reject) => {
    const s = io(BASE, { extraHeaders: headers, transports: ['websocket'], reconnection: false, timeout: 5000 });
    s.on('connect', () => resolve(s));
    s.on('connect_error', e => { s.close(); reject(new Error(e.message)); });
    setTimeout(() => { s.close(); reject(new Error('连接超时')); }, 6000);
  });
}
const emitAck = (s, event, ...args) => new Promise(res => s.emit(event, ...args, res));

(async () => {
  console.log('== 1. HTTP 身份 Cookie ==');
  let r = await get('/');
  ok('首页 200', r.status === 200);
  const c1 = cookieVal(r.setCookie);
  ok('首次访问种下 msid cookie', !!c1 && c1.startsWith('msid='));
  const pid1 = c1 ? c1.slice(5).split('.')[0] : '';
  ok('玩家 ID 为 32 位 hex', /^[a-f0-9]{32}$/.test(pid1), pid1);
  ok('cookie 带 HttpOnly', /httponly/i.test(r.setCookie));
  r = await get('/', c1);
  ok('有效 cookie 复访不再重发', !r.setCookie, r.setCookie);
  r = await get('/api/saves', c1);
  ok('有效 cookie 查存档返回 []', r.status === 200 && JSON.parse(r.body).length === 0);

  console.log('== 2. 伪造 cookie 拒绝 ==');
  const forgedPid = 'a'.repeat(32);
  const forged = `msid=${forgedPid}.ZmFrZXNpZ25hdHVyZQ`;
  r = await get('/api/saves', forged);
  ok('伪造 cookie 被拒并重新签发', r.status === 200 && !!r.setCookie && r.setCookie.includes('msid=') && !r.setCookie.startsWith(`msid=${forgedPid}`));
  r = await get('/api/saves', 'msid=not-signed-at-all');
  ok('无签名 cookie 被拒并重新签发', r.status === 200 && !!r.setCookie);

  console.log('== 3. Socket Origin / 身份校验 ==');
  let err = null;
  try { await connect(null); } catch (e) { err = e.message; }
  ok('缺少 Origin 被拒', !!err, err);
  err = null;
  try { await connect(c1, 'http://evil.example.com'); } catch (e) { err = e.message; }
  ok('异源 Origin 被拒', !!err, err);
  err = null;
  try { await connect(null, BASE); } catch (e) { err = e.message; }
  ok('无身份 cookie 被拒', !!err && /身份/.test(err), err);

  const s = await connect(c1, BASE);
  ok('合法连接成功', s.connected);

  console.log('== 4. 正常对局流程（创建/暂停/保存退出/恢复/放弃）==');
  const g = await emitAck(s, 'create-game', { name: 'Tester', difficulty: 'easy' });
  ok('创建游戏返回 gameId', !!g.gameId, g);
  ok('初始棋盘 81 格', g.state && g.state.board.length === 81);
  s.emit('reveal', { index: 40 });
  await sleep(400);
  s.emit('pause');
  await sleep(300);
  const save = await emitAck(s, 'save-and-exit');
  ok('保存退出返回 saveId', !!save.saveId, save);
  r = await get('/api/saves', c1);
  const saves = JSON.parse(r.body);
  ok('存档出现在 /api/saves', saves.some(x => x.saveId === save.saveId));
  const resumed = await emitAck(s, 'resume-save', { saveId: save.saveId, name: 'Tester' });
  ok('恢复存档成功', !!resumed.gameId, resumed);
  s.emit('exit-without-save');
  await sleep(300);

  console.log('== 5. 崩溃回归：畸形数据包不得击杀服务器 ==');
  await new Promise(res => { s.emit('save-and-exit', {}); setTimeout(res, 200); }); // 非函数参数
  await new Promise(res => { s.emit('create-game', {}, {}); setTimeout(res, 200); }); // 非函数回调 + 缺难度
  await new Promise(res => { s.emit('reveal', { index: 'bogus' }); setTimeout(res, 200); });
  await new Promise(res => { s.emit('resume-save', 'not-an-object'); setTimeout(res, 200); });
  await new Promise(res => { s.emit('toggle-flag'); setTimeout(res, 200); });
  r = await get('/health');
  ok('服务器仍然存活（/health 200）', r.status === 200 && JSON.parse(r.body).ok === true);
  const g2 = await emitAck(s, 'create-game', { name: 'After', difficulty: 'easy' });
  ok('崩溃攻击后仍能正常开局', !!g2.gameId, g2);
  const lb = await emitAck(s, 'leaderboard-request', 'easy');
  ok('排行榜请求正常', Array.isArray(lb));
  s.close();

  console.log('== 6. HTTP 速率限制 ==');
  let got429 = false;
  for (let i = 0; i < 70; i++) {
    const rr = await get('/api/leaderboard?difficulty=easy');
    if (rr.status === 429) { got429 = true; break; }
  }
  ok('超频请求返回 429', got429);

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('测试脚本异常:', e); process.exit(1); });
