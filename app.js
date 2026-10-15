const socket = io();
const $ = id => document.getElementById(id);
const MODE_NAMES = { easy: '简单', medium: '中等', hard: '困难' };
let playerId = localStorage.getItem('minesweeperPlayerId') || '';
let gameId = null, state = null, toastTimer = null, timerBase = 0, timerStartedAt = null;
function toast(msg) { $('toast').textContent = msg; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2800); }
function playerName() { return $('playerName').value.trim() || 'Player'; }
function fmt(n) { n = Math.max(0, Number(n) || 0); return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`; }
function ensurePlayer() {
  socket.emit('new-player-id', playerId, result => {
    playerId = result.playerId; localStorage.setItem('minesweeperPlayerId', playerId); loadSaves(); loadLeaderboard();
  });
}
socket.on('connect', () => { $('connection').textContent = '已连接'; ensurePlayer(); });
socket.on('disconnect', () => { $('connection').textContent = '连接断开'; toast('连接断开。服务器会尝试自动保存当前游戏。'); });
socket.on('game-state', s => { state = s; timerBase = s.elapsedSeconds || 0; timerStartedAt = s.status === 'playing' && !s.paused ? Date.now() : null; render(s); });
socket.on('game-finished', r => { timerBase = r.seconds; timerStartedAt = null; $('timer').textContent = fmt(r.seconds); toast(r.outcome === 'won' ? `通关成功！用时 ${fmt(r.seconds)}，最佳成绩已更新。` : '本局失败，可以重新开始。'); loadLeaderboard(); });
setInterval(() => { if (state) $('timer').textContent = fmt(timerBase + (timerStartedAt ? Math.floor((Date.now()-timerStartedAt)/1000) : 0)); }, 250);
function startGame() {
  $('startBtn').disabled = true;
  socket.emit('create-game', { playerId, name: playerName(), difficulty: $('difficulty').value }, result => {
    $('startBtn').disabled = false; if (result.error) return toast(result.error); enterGame(result);
  });
}
function enterGame(result) { gameId = result.gameId; state = result.state; $('lobby').classList.add('hidden'); $('game').classList.remove('hidden'); $('gameIdLabel').textContent = gameId; timerBase = state.elapsedSeconds || 0; timerStartedAt = null; render(state); }
function leaveGame() { gameId = null; state = null; timerStartedAt = null; $('game').classList.add('hidden'); $('lobby').classList.remove('hidden'); loadSaves(); loadLeaderboard(); }
$('startBtn').addEventListener('click', startGame);
$('pauseBtn').addEventListener('click', () => socket.emit('pause'));
$('resumeBtn').addEventListener('click', () => socket.emit('pause'));
$('saveExitBtn').addEventListener('click', () => { if (!confirm('将当前进度保存到服务器，并退出本局？')) return; socket.emit('save-and-exit', r => { if (r.error) return toast(r.error); leaveGame(); toast('进度已保存，服务器重启后仍可恢复。'); }); });
$('exitBtn').addEventListener('click', () => { if (!confirm('退出且不保存本局进度？')) return; socket.emit('exit-without-save'); leaveGame(); toast('已退出，本局进度未保存。'); });
function render(s) {
  $('mineCounter').textContent = s.mines; $('timer').textContent = fmt(s.elapsedSeconds);
  $('pauseOverlay').classList.toggle('hidden', !s.paused); $('pauseBtn').textContent = s.paused ? '继续' : '暂停'; $('pauseBtn').disabled = s.status !== 'playing';
  $('gameMessage').textContent = s.status === 'won' ? `通关成功！用时 ${fmt(s.elapsedSeconds)}。` : s.status === 'lost' ? '踩到地雷，本局结束。' : s.paused ? '计时已暂停。' : `难度：${MODE_NAMES[s.difficulty]}。左键翻开，右键插旗。首次翻格会打开安全起点。`;
  const board = $('board'); const cellSize = window.innerWidth < 600 ? 26 : 32; board.style.gridTemplateColumns = `repeat(${s.cols}, ${cellSize}px)`; board.replaceChildren();
  s.board.forEach((cell, index) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'cell' + (cell.revealed ? ' revealed' : '') + (cell.mine ? ' mine' : '') + (cell.flagged ? ' flagged' : '');
    b.disabled = s.status !== 'playing' || s.paused || cell.revealed; b.textContent = cell.mine ? '✹' : cell.flagged ? '⚑' : cell.revealed && cell.count ? cell.count : '';
    b.addEventListener('click', () => socket.emit('reveal', { index })); b.addEventListener('contextmenu', e => { e.preventDefault(); socket.emit('toggle-flag', { index }); });
    if (cell.revealed && cell.count) b.style.color = ['', '#2872c8', '#23804a', '#d24a43', '#7251a4', '#b45c24', '#278b9b', '#222', '#777'][cell.count] || '#26344d';
    board.appendChild(b);
  });
}
function loadSaves() {
  if (!playerId) return;
  fetch('/api/saves?playerId=' + encodeURIComponent(playerId)).then(r => r.json()).then(saves => {
    const root = $('saves'); root.replaceChildren();
    if (!saves.length) { root.className = 'empty'; root.textContent = '暂无存档。游戏中选择“保存并退出”后，存档会显示在这里。'; return; }
    root.className = '';
    saves.forEach(s => {
      const row = document.createElement('div'); row.className = 'save-row'; const info = document.createElement('div'); info.className = 'save-info';
      const title = document.createElement('strong'); title.textContent = `${MODE_NAMES[s.difficulty]} · ${fmt(s.elapsedSeconds)}`;
      const meta = document.createElement('small'); meta.textContent = `保存于 ${new Date(s.updatedAt).toLocaleString()}`; info.append(title, meta);
      const btn = document.createElement('button'); btn.className = 'small'; btn.textContent = '恢复'; btn.addEventListener('click', () => socket.emit('resume-save', { playerId, saveId: s.saveId, name: playerName() }, result => { if (result.error) return toast(result.error); enterGame(result); }));
      row.append(info, btn); root.appendChild(row);
    });
  }).catch(() => { $('saves').textContent = '无法读取存档。'; });
}
function loadLeaderboard() {
  fetch('/api/leaderboard?difficulty=' + encodeURIComponent($('leaderboardDifficulty').value)).then(r => r.json()).then(entries => {
    const root = $('leaderboard'); root.replaceChildren();
    if (!entries.length) { root.className = 'empty'; root.textContent = '暂无通关记录。'; return; }
    root.className = 'leaderboard'; const table = document.createElement('table'); const thead = document.createElement('thead'); thead.innerHTML = '<tr><th>#</th><th>玩家</th><th>难度</th><th>最佳时间</th><th>日期</th></tr>'; table.appendChild(thead);
    const tbody = document.createElement('tbody'); entries.forEach((e, i) => { const tr = document.createElement('tr'); [i+1, e.player, MODE_NAMES[e.difficulty], fmt(e.seconds), new Date(e.createdAt).toLocaleDateString()].forEach(v => { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); }); tbody.appendChild(tr); }); table.appendChild(tbody); root.appendChild(table);
  }).catch(() => { $('leaderboard').textContent = '无法读取排行榜。'; });
}
$('refreshSaves').addEventListener('click', loadSaves); $('leaderboardDifficulty').addEventListener('change', loadLeaderboard);
