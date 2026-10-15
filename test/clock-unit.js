/* 计时器单元测试：node test/clock-unit.js（验证终局停表不再归零） */
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
const core = src.slice(src.indexOf('function elapsed'), src.indexOf('function publicState'));
const run = new Function(core + `
  const results = [];
  // 场景 1：胜利时先改状态后停表（旧 bug 的触发路径）
  const g1 = { status: 'playing', paused: false, startedAt: Date.now() - 5300, elapsedSeconds: 0 };
  g1.status = 'won'; stopClock(g1);
  results.push(['先改状态再停表，用时应约 5 秒', g1.elapsedSeconds >= 4 && g1.elapsedSeconds <= 7, g1.elapsedSeconds]);
  // 场景 2：失败时同样路径
  const g2 = { status: 'playing', paused: false, startedAt: Date.now() - 2300, elapsedSeconds: 0 };
  g2.status = 'lost'; stopClock(g2);
  results.push(['失败局停表不归零', g2.elapsedSeconds >= 1 && g2.elapsedSeconds <= 4, g2.elapsedSeconds]);
  // 场景 3：暂停两次累计
  const g3 = { status: 'playing', paused: false, startedAt: Date.now() - 2100, elapsedSeconds: 0 };
  stopClock(g3); g3.paused = true;
  g3.paused = false; startClock(g3); g3.startedAt = Date.now() - 1100; // 模拟恢复后又玩了 1 秒
  stopClock(g3);
  results.push(['暂停续玩累计时间', g3.elapsedSeconds >= 2 && g3.elapsedSeconds <= 4, g3.elapsedSeconds]);
  // 场景 4：从未开始计时的对局
  const g4 = { status: 'playing', paused: true, startedAt: null, elapsedSeconds: 0 };
  stopClock(g4);
  results.push(['未开局停表安全', g4.elapsedSeconds === 0 && g4.startedAt === null, g4.elapsedSeconds]);
  return results;
`);
let failed = 0;
for (const [name, ok, actual] of run()) {
  console.log(ok ? '  PASS' : '  FAIL', name, '实际值:', actual);
  if (!ok) failed++;
}
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
