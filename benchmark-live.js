/* 实测线上开局延迟：node benchmark-live.js */
const BASE = 'https://minesweeper-arena-34333.app.workbuddy.host';
const { io } = require('socket.io-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const t0 = Date.now();
  const res = await fetch(BASE + '/');
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  console.log('首页加载 + 种 cookie:', Date.now() - t0, 'ms');

  const t1 = Date.now();
  const s = io(BASE, { extraHeaders: { Origin: BASE, Cookie: cookie }, transports: ['websocket'], reconnection: false, timeout: 15000 });
  await new Promise((ok, bad) => { s.on('connect', ok); s.on('connect_error', bad); setTimeout(() => bad(new Error('超时')), 15000); });
  console.log('Socket 连接:', Date.now() - t1, 'ms');

  for (const diff of ['easy', 'easy', 'medium', 'hard']) {
    const t2 = Date.now();
    const g = await new Promise(res => s.emit('create-game', { name: 'Bench', difficulty: diff }, res));
    console.log(`create-game ${diff}:`, Date.now() - t2, 'ms', g.gameId ? '' : JSON.stringify(g));
    if (g.gameId) { s.emit('exit-without-save'); await sleep(300); }
  }
  s.close();
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
