/* 不同起点位置的生成开销对比：node test/bench-attempts.js */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const core = src.slice(src.indexOf('function neighbors'), src.indexOf('function elapsed'));
const run = new Function('crypto', core + `
const MODES = { easy:{rows:9,cols:9,mines:10}, medium:{rows:16,cols:16,mines:40}, hard:{rows:16,cols:30,mines:99} };
function gen(difficulty, start, maxAttempts = 12000) {
  const cfg = MODES[difficulty];
  const { rows, cols, mines } = cfg, total = rows * cols;
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
const cases = [
  ['easy', 0, '左上角'], ['easy', 4, '上边中'], ['easy', 40, '正中央'], ['easy', 80, '右下角'],
  ['medium', 0, '左上角'], ['medium', 135, '正中央'], ['medium', 255, '右下角'],
  ['hard', 0, '左上角'], ['hard', 239, '正中央'], ['hard', 479, '右下角']
];
for (const [d, start, label] of cases) {
  const t0 = Date.now(); const n = 3; const res = [];
  for (let i = 0; i < n; i++) res.push(gen(d, start));
  const avgMs = (Date.now() - t0) / n;
  out.push(d.padEnd(6) + label.padEnd(5) + ' 尝试次数 ' + res.join('/') + '  平均 ' + avgMs.toFixed(0) + ' ms');
}
return out.join('\\n');
`);
console.log(run(require('crypto')));
