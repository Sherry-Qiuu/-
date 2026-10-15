/* 生成速度基准测试：node benchmark-gen.js */
const fs = require('fs');
const src = fs.readFileSync('server.js', 'utf8');
const core = src.slice(src.indexOf('function neighbors'), src.indexOf('function elapsed'));
const bench = new Function('crypto', core + `
const MODES = { easy:{rows:9,cols:9,mines:10}, medium:{rows:16,cols:16,mines:40}, hard:{rows:16,cols:30,mines:99} };
function generateBoard(difficulty, maxAttempts = 12000) {
  const cfg = MODES[difficulty];
  const { rows, cols, mines } = cfg, total = rows * cols;
  const start = Math.floor(rows / 2) * cols + Math.floor(cols / 2);
  const protectedCells = new Set([start, ...neighbors(start, rows, cols)]);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const positions = new Set();
    while (positions.size < mines) { const n = crypto.randomInt(total); if (!protectedCells.has(n)) positions.add(n); }
    const board = Array.from({ length: total }, (_, i) => ({ mine: positions.has(i), count: 0, revealed: false, flagged: false }));
    countMines(board, rows, cols);
    if (solverCanFinish(board, rows, cols, start)) return attempt + 1;
  }
  return -1;
}
const out = [];
for (const d of ['easy', 'medium', 'hard']) {
  const t0 = Date.now();
  const n = 5;
  const attempts = [];
  for (let i = 0; i < n; i++) attempts.push(generateBoard(d));
  out.push(d + ': ' + attempts.join(',') + ' 次尝试 | 平均 ' + ((Date.now() - t0) / n).toFixed(0) + ' ms/盘');
}
return out.join('\\n');
`);
console.log(bench(require('crypto')));
