/* 首点即开端到端测试：node test/first-click.js（需先启动服务器） */
const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3987';
const { io } = require('socket.io-client');
let passed = 0, failed = 0;
const ok = (name, cond, extra) => { if (cond) { passed++; console.log('  PASS', name); } else { failed++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const res = await fetch(BASE + '/');
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  const s = await new Promise((resolve, reject) => {
    const sock = io(BASE, { extraHeaders: { Origin: BASE, Cookie: cookie }, transports: ['websocket'], reconnection: false, timeout: 5000 });
    sock.on('connect', () => resolve(sock));
    sock.on('connect_error', reject);
  });

  let latest = null, gameError = null;
  s.on('game-state', x => { latest = x; });
  s.on('game-error', x => { gameError = x && x.error; });
  const waitFor = async (cond, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(50); } return false; };

  const g = await new Promise(res => s.emit('create-game', { name: 'T', difficulty: 'easy' }, res));
  ok('开局即返回 81 格全暗棋盘', g.state && g.state.board.length === 81 && g.state.board.every(c => !c.revealed));

  // 点左上角 (index 0)：棋盘应围绕它即时生成并翻开
  latest = null; gameError = null;
  s.emit('reveal', { index: 0 });
  ok('点击的左上角格子已翻开', await waitFor(() => latest && latest.board[0].revealed), latest && latest.board[0]);
  ok('周围一圈全部安全', [1, 9, 10].every(i => latest.board[i].revealed && !latest.board[i].mine));
  ok('没有触发生成失败提示', gameError === null, gameError);

  // 保存/恢复流程在未点击前（board 为 null 的存档）
  const g2 = await new Promise(res => s.emit('create-game', { name: 'T2', difficulty: 'easy' }, res));
  const save2 = await new Promise(res => s.emit('save-and-exit', res));
  ok('未点击时保存退出成功', !!save2.saveId, save2);
  const r2 = await new Promise(res => s.emit('resume-save', { saveId: save2.saveId, name: 'T2' }, res));
  ok('恢复未点击的存档成功且全暗', !!r2.gameId && r2.state.board.every(c => !c.revealed));
  ok('恢复后处于暂停态', r2.state.paused === true);

  // 恢复后再点击右下角也能正常开局（恢复的存档处于暂停态，先继续游戏）
  s.emit('pause');
  latest = null; gameError = null;
  s.emit('reveal', { index: 80 });
  ok('恢复存档后点击右下角已翻开', await waitFor(() => latest && latest.board[80].revealed), latest && latest.board[80]);
  ok('第二次点击未触发生成失败提示', gameError === null, gameError);

  s.close();
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('测试脚本异常:', e); process.exit(1); });
