const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'database.json');
const MAX_BYTES = 500 * 1024 * 1024;
const SAVE_TTL = 30 * 24 * 60 * 60 * 1000;
const MAX_HISTORY_PER_PLAYER_MODE = 30;
const MODES = {
  easy: { rows: 9, cols: 9, mines: 10 },
  medium: { rows: 16, cols: 16, mines: 40 },
  hard: { rows: 16, cols: 30, mines: 99 }
};

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) atomicWrite(DB_FILE, { version: 1, bestScores: [], saves: [], history: [] });

// ---------- 身份：HMAC 签名 HttpOnly Cookie ----------
const IDENTITY_COOKIE = 'msid';
const COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
let IDENTITY_SECRET = process.env.IDENTITY_SECRET || '';
if (!IDENTITY_SECRET) {
  const secretFile = path.join(DATA_DIR, '.identity-secret');
  try { IDENTITY_SECRET = fs.readFileSync(secretFile, 'utf8').trim(); } catch { /* 首次启动生成 */ }
  if (!/^[A-Za-z0-9_-]{32,}$/.test(IDENTITY_SECRET)) {
    IDENTITY_SECRET = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(secretFile, IDENTITY_SECRET, { mode: 0o600 });
  }
}
function signPlayerId(pid) {
  return pid + '.' + crypto.createHmac('sha256', IDENTITY_SECRET).update(pid).digest('base64url');
}
function verifySignedPlayerId(v) {
  if (typeof v !== 'string') return null;
  const dot = v.lastIndexOf('.');
  if (dot <= 0) return null;
  const pid = v.slice(0, dot);
  if (!validPlayerId(pid)) return null;
  const expected = crypto.createHmac('sha256', IDENTITY_SECRET).update(pid).digest();
  let got;
  try { got = Buffer.from(v.slice(dot + 1), 'base64url'); } catch { return null; }
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  return pid;
}
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* 跳过畸形段 */ }
  }
  return out;
}
// 任何 HTTP 请求进来：有效签名 cookie → 采用其中身份；否则签发新身份并种 cookie（刷新缓存也不会丢身份）
app.use((req, res, next) => {
  const pid = verifySignedPlayerId(parseCookies(req.headers.cookie)[IDENTITY_COOKIE]);
  if (pid) { req.playerId = pid; return next(); }
  const fresh = id(16);
  res.cookie(IDENTITY_COOKIE, signPlayerId(fresh), {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: COOKIE_MAX_AGE_MS, secure: req.secure
  });
  req.playerId = fresh;
  next();
});

// ---------- HTTP 速率限制 ----------
function httpRateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, h] of hits) if (now - h.start >= windowMs) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now(), k = req.ip || 'unknown';
    let h = hits.get(k);
    if (!h || now - h.start >= windowMs) { h = { start: now, count: 0 }; hits.set(k, h); }
    if (++h.count > max) return res.status(429).json({ error: '请求过于频繁，请稍后再试。' });
    next();
  };
}
app.use('/api', httpRateLimit({ windowMs: 60_000, max: 60 }));
function atomicWrite(file, value) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}
function readDB() {
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  return { version: 1, bestScores: db.bestScores || [], saves: db.saves || [], history: db.history || [] };
}
function sizeOf(db) { return Buffer.byteLength(JSON.stringify(db), 'utf8'); }
function trimDB(db) {
  const now = Date.now();
  db.saves = db.saves.filter(s => now - Date.parse(s.updatedAt || s.createdAt) <= SAVE_TTL);
  db.history.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const counts = new Map();
  db.history = db.history.filter(h => {
    const key = h.playerId + ':' + h.difficulty, n = counts.get(key) || 0;
    if (n >= MAX_HISTORY_PER_PLAYER_MODE) return false;
    counts.set(key, n + 1); return true;
  });
  // Keep best scores first, then saves, then history. Delete low-value records until under cap.
  while (sizeOf(db) > MAX_BYTES && db.history.length) db.history.pop();
  while (sizeOf(db) > MAX_BYTES && db.saves.length) {
    db.saves.sort((a, b) => Date.parse(a.updatedAt || a.createdAt) - Date.parse(b.updatedAt || b.createdAt));
    db.saves.shift();
  }
  while (sizeOf(db) > MAX_BYTES && db.bestScores.length) {
    db.bestScores.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    db.bestScores.shift();
  }
  if (sizeOf(db) > MAX_BYTES) throw new Error('数据库超过 500 MiB，请迁移到 SQLite/PostgreSQL。');
  return db;
}
function saveDB(db) { trimDB(db); atomicWrite(DB_FILE, db); }
function id(bytes = 16) { return crypto.randomBytes(bytes).toString('hex'); }
function safeName(s) { return String(s || 'Player').replace(/[<>"']/g, '').trim().slice(0, 24) || 'Player'; }
function validPlayerId(s) { s = String(s || ''); return /^[a-f0-9]{16,80}$/i.test(s) ? s : null; }
function neighbors(i, rows, cols) {
  const r = Math.floor(i / cols), c = i % cols, out = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const rr = r + dr, cc = c + dc;
    if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) out.push(rr * cols + cc);
  }
  return out;
}
function countMines(board, rows, cols) {
  for (let i = 0; i < board.length; i++) board[i].count = board[i].mine ? 0 : neighbors(i, rows, cols).filter(n => board[n].mine).length;
}

// Conservative no-guess solver: flood-fill plus numbered-cell constraints and subset deductions.
function solverCanFinish(board, rows, cols, start) {
  const opened = new Set(), flags = new Set();
  function flood(i) {
    const stack = [i];
    while (stack.length) {
      const x = stack.pop();
      if (opened.has(x) || flags.has(x) || board[x].mine) continue;
      opened.add(x);
      if (board[x].count === 0) for (const n of neighbors(x, rows, cols)) if (!opened.has(n) && !board[n].mine) stack.push(n);
    }
  }
  flood(start);
  const safeTotal = board.filter(c => !c.mine).length;
  for (let turn = 0; opened.size < safeTotal && turn < board.length * 3; turn++) {
    let changed = false;
    const constraints = [];
    for (const x of opened) {
      const ns = neighbors(x, rows, cols);
      const unknown = ns.filter(n => !opened.has(n) && !flags.has(n));
      const remain = board[x].count - ns.filter(n => flags.has(n)).length;
      if (unknown.length && remain >= 0 && remain <= unknown.length) {
        constraints.push({ cells: new Set(unknown), remain });
        if (remain === 0) { unknown.forEach(flood); changed = true; }
        else if (remain === unknown.length) { unknown.forEach(n => flags.add(n)); changed = true; }
      }
    }
    for (let a = 0; a < constraints.length; a++) for (let b = 0; b < constraints.length; b++) {
      if (a === b) continue;
      const A = constraints[a], B = constraints[b];
      if (A.cells.size >= B.cells.size) continue;
      let subset = true;
      for (const x of A.cells) if (!B.cells.has(x)) { subset = false; break; }
      if (!subset) continue;
      const diff = [...B.cells].filter(x => !A.cells.has(x));
      const remaining = B.remain - A.remain;
      if (remaining === 0) { diff.forEach(flood); changed = true; }
      else if (remaining === diff.length) { diff.forEach(n => flags.add(n)); changed = true; }
    }
    if (!changed) return false;
  }
  return opened.size === safeTotal;
}
function generateBoard(difficulty, maxAttempts = 12000) {
  const cfg = MODES[difficulty];
  if (!cfg) throw new Error('难度无效');
  const { rows, cols, mines } = cfg, total = rows * cols;
  // First click is a fixed, safe opening with a safe 3x3 neighborhood.
  const start = Math.floor(rows / 2) * cols + Math.floor(cols / 2);
  const protectedCells = new Set([start, ...neighbors(start, rows, cols)]);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const positions = new Set();
    while (positions.size < mines) {
      const n = crypto.randomInt(total);
      if (!protectedCells.has(n)) positions.add(n);
    }
    const board = Array.from({ length: total }, (_, i) => ({ mine: positions.has(i), count: 0, revealed: false, flagged: false }));
    countMines(board, rows, cols);
    if (solverCanFinish(board, rows, cols, start)) return {
      rows, cols, mines, board, firstIndex: start, firstClickPending: true,
      status: 'playing', elapsedSeconds: 0, startedAt: null, paused: false,
      createdAt: new Date().toISOString()
    };
  }
  throw new Error('未能在重试次数内生成可解棋盘，请再次尝试。');
}
function elapsed(g) {
  if (g.status !== 'playing' || g.paused || !g.startedAt) return g.elapsedSeconds || 0;
  return (g.elapsedSeconds || 0) + Math.floor((Date.now() - g.startedAt) / 1000);
}
function stopClock(g) { g.elapsedSeconds = elapsed(g); g.startedAt = null; }
function startClock(g) { if (!g.startedAt && !g.paused && g.status === 'playing') g.startedAt = Date.now(); }
function publicState(g) {
  return { difficulty: g.difficulty, rows: g.rows, cols: g.cols, mines: g.mines, status: g.status,
    paused: g.paused, elapsedSeconds: elapsed(g),
    board: g.board.map(c => ({ revealed: c.revealed, flagged: c.flagged,
      count: c.revealed && !c.mine ? c.count : 0, mine: g.status === 'lost' && c.mine })) };
}
function reveal(g, index) {
  if (!Number.isInteger(index) || index < 0 || index >= g.board.length || g.status !== 'playing' || g.paused) return;
  if (g.firstClickPending) {
    g.firstClickPending = false; index = g.firstIndex; startClock(g);
  }
  const cell = g.board[index];
  if (!cell || cell.revealed || cell.flagged) return;
  if (cell.mine) {
    cell.revealed = true; g.status = 'lost'; stopClock(g);
    g.board.forEach(c => { if (c.mine) c.revealed = true; }); return;
  }
  const stack = [index];
  while (stack.length) {
    const i = stack.pop(), c = g.board[i];
    if (c.revealed || c.flagged || c.mine) continue;
    c.revealed = true;
    if (c.count === 0) for (const n of neighbors(i, g.rows, g.cols)) if (!g.board[n].revealed && !g.board[n].mine) stack.push(n);
  }
  if (g.board.every(c => c.mine || c.revealed)) { g.status = 'won'; stopClock(g); }
}
function persistGame(g) {
  const elapsedNow = elapsed(g);
  const db = readDB();
  const snapshot = {
    saveId: g.saveId || id(16), playerId: g.playerId, playerName: g.playerName,
    difficulty: g.difficulty, rows: g.rows, cols: g.cols, mines: g.mines,
    board: g.board, firstIndex: g.firstIndex, firstClickPending: g.firstClickPending,
    status: g.status, elapsedSeconds: elapsedNow, paused: true,
    createdAt: g.createdAt, updatedAt: new Date().toISOString()
  };
  const i = db.saves.findIndex(s => s.saveId === snapshot.saveId);
  if (i >= 0) db.saves[i] = snapshot; else db.saves.push(snapshot);
  saveDB(db); g.saveId = snapshot.saveId;
}
function saveBest(g) {
  const db = readDB();
  let best = db.bestScores.find(s => s.playerId === g.playerId && s.difficulty === g.difficulty);
  const now = new Date().toISOString();
  if (!best) {
    best = { playerId: g.playerId, player: g.playerName, difficulty: g.difficulty, seconds: g.elapsedSeconds, createdAt: now, updatedAt: now };
    db.bestScores.push(best);
  } else {
    best.player = g.playerName; best.updatedAt = now;
    if (g.elapsedSeconds < best.seconds) { best.seconds = g.elapsedSeconds; best.createdAt = now; }
  }
  db.history.push({ id: id(8), playerId: g.playerId, player: g.playerName, difficulty: g.difficulty,
    seconds: g.elapsedSeconds, outcome: g.status, createdAt: now });
  saveDB(db);
}
const games = new Map();
function leaderboard(difficulty) {
  return readDB().bestScores.filter(s => !difficulty || s.difficulty === difficulty)
    .sort((a, b) => a.seconds - b.seconds || a.createdAt.localeCompare(b.createdAt)).slice(0, 100);
}
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/leaderboard', (req, res) => res.json(leaderboard(MODES[req.query.difficulty] ? req.query.difficulty : null)));
app.get('/api/saves', (req, res) => {
  const pid = req.playerId;
  res.json(readDB().saves.filter(s => s.playerId === pid).map(s => ({ saveId: s.saveId, difficulty: s.difficulty,
    elapsedSeconds: s.elapsedSeconds, createdAt: s.createdAt, updatedAt: s.updatedAt }))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
});

// ---------- Socket 连接：Origin 校验 + 身份校验 ----------
io.use((socket, next) => {
  const h = socket.handshake.headers;
  const origin = h.origin;
  if (!origin) return next(new Error('缺少 Origin，拒绝连接。'));
  let originHost;
  try { originHost = new URL(origin).host; } catch { return next(new Error('Origin 无效。')); }
  // 反向代理会把 Host 改写成内部地址，公开域名在 X-Forwarded-Host 里，两者都放行
  const allowed = new Set();
  for (const key of ['host', 'x-forwarded-host']) {
    const v = h[key];
    if (typeof v === 'string') v.split(',').map(s => s.trim()).forEach(x => { if (x) allowed.add(x); });
  }
  if (!allowed.has(originHost)) return next(new Error('Origin 不被允许。'));
  const pid = verifySignedPlayerId(parseCookies(h.cookie)[IDENTITY_COOKIE]);
  if (!pid) return next(new Error('身份无效，请刷新页面重试。'));
  socket.data.playerId = pid;
  next();
});

// 事件级速率限制 + 统一防崩溃（畸形参数/回调不会击穿进程）
function limitEvent(socket, event, { windowMs, max }, handler) {
  socket.on(event, (...args) => {
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    const store = socket.data.rateLimit || (socket.data.rateLimit = new Map());
    const now = Date.now();
    let h = store.get(event);
    if (!h || now - h.start >= windowMs) { h = { start: now, count: 0 }; store.set(event, h); }
    if (++h.count > max) { if (cb) cb({ error: '操作过于频繁，请稍后再试。' }); return; }
    try { handler(...args); }
    catch (e) { console.error(`处理 ${event} 事件时出错:`, e); if (cb) cb({ error: '服务器内部错误。' }); }
  });
}

io.on('connection', socket => {
  const pid = socket.data.playerId;
  limitEvent(socket, 'create-game', { windowMs: 60_000, max: 10 }, ({ name, difficulty } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') cb = () => {};
    try {
      if (!MODES[difficulty]) return cb({ error: '请选择有效难度。' });
      const gameId = id(6).toUpperCase();
      const g = { ...generateBoard(difficulty), gameId, playerId: pid, playerName: safeName(name), difficulty,
        socketId: socket.id, saveId: id(16), scoreSaved: false };
      games.set(gameId, g); socket.join(gameId); socket.data.gameId = gameId;
      cb({ gameId, state: publicState(g) });
    } catch (e) { cb({ error: e.message || '创建游戏失败。' }); }
  });
  limitEvent(socket, 'reveal', { windowMs: 10_000, max: 120 }, ({ index } = {}) => {
    const g = games.get(socket.data.gameId); if (!g || g.socketId !== socket.id) return;
    reveal(g, index);
    if (g.status === 'won' && !g.scoreSaved) {
      g.scoreSaved = true;
      try { saveBest(g); } catch (e) { console.error('Could not save score:', e.message); }
      io.to(g.gameId).emit('game-finished', { outcome: 'won', seconds: g.elapsedSeconds });
      games.delete(g.gameId);
    } else if (g.status === 'lost') {
      io.to(g.gameId).emit('game-finished', { outcome: 'lost', seconds: g.elapsedSeconds }); games.delete(g.gameId);
    }
    io.to(g.gameId).emit('game-state', publicState(g));
  });
  limitEvent(socket, 'toggle-flag', { windowMs: 10_000, max: 60 }, ({ index } = {}) => {
    const g = games.get(socket.data.gameId);
    if (!g || g.socketId !== socket.id || g.status !== 'playing' || g.paused || !Number.isInteger(index) || !g.board[index] || g.board[index].revealed) return;
    g.board[index].flagged = !g.board[index].flagged;
    io.to(g.gameId).emit('game-state', publicState(g));
  });
  limitEvent(socket, 'pause', { windowMs: 60_000, max: 30 }, () => {
    const g = games.get(socket.data.gameId); if (!g || g.socketId !== socket.id || g.status !== 'playing') return;
    if (!g.paused) { stopClock(g); g.paused = true; } else { g.paused = false; startClock(g); }
    try { persistGame(g); } catch (e) { console.error('Autosave failed:', e.message); }
    io.to(g.gameId).emit('game-state', publicState(g));
  });
  limitEvent(socket, 'save-and-exit', { windowMs: 60_000, max: 10 }, (cb = () => {}) => {
    if (typeof cb !== 'function') cb = () => {};
    const g = games.get(socket.data.gameId); if (!g || g.socketId !== socket.id) return cb({ error: '没有正在进行的游戏。' });
    try { stopClock(g); g.paused = true; persistGame(g); games.delete(g.gameId); socket.leave(g.gameId); socket.data.gameId = null; cb({ saveId: g.saveId }); }
    catch (e) { cb({ error: '保存失败：' + e.message }); }
  });
  limitEvent(socket, 'exit-without-save', { windowMs: 60_000, max: 30 }, () => {
    const g = games.get(socket.data.gameId); if (!g || g.socketId !== socket.id) return;
    games.delete(g.gameId); socket.leave(g.gameId); socket.data.gameId = null;
  });
  limitEvent(socket, 'resume-save', { windowMs: 60_000, max: 10 }, ({ saveId, name } = {}, cb = () => {}) => {
    if (typeof cb !== 'function') cb = () => {};
    try {
      const db = readDB(), index = db.saves.findIndex(s => s.saveId === saveId && s.playerId === pid);
      if (index < 0) return cb({ error: '没有找到存档，可能已过期或已被清理。' });
      const snapshot = db.saves.splice(index, 1)[0]; saveDB(db);
      const gameId = id(6).toUpperCase();
      const g = { ...snapshot, gameId, playerName: safeName(name || snapshot.playerName), socketId: socket.id,
        startedAt: null, paused: true, scoreSaved: false };
      games.set(gameId, g); socket.join(gameId); socket.data.gameId = gameId;
      cb({ gameId, state: publicState(g) });
    } catch (e) { cb({ error: e.message || '恢复存档失败。' }); }
  });
  limitEvent(socket, 'leaderboard-request', { windowMs: 60_000, max: 30 }, (difficulty, cb = () => {}) => { if (typeof cb === 'function') cb(leaderboard(MODES[difficulty] ? difficulty : null)); });
  socket.on('disconnect', () => {
    const g = games.get(socket.data.gameId);
    if (g && g.socketId === socket.id && g.status === 'playing') {
      try { persistGame(g); } catch (e) { console.error('Disconnect autosave failed:', e.message); }
      games.delete(g.gameId);
    }
  });
});
// 兜底：任何漏网的异常只记日志，不允许一条畸形数据包击杀整个进程
process.on('uncaughtException', e => console.error('uncaughtException:', e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
server.listen(PORT, () => console.log(`扫雷竞速已启动：http://localhost:${PORT}`));
