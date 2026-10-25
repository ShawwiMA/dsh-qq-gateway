// M2 变异测试：故意把 M2 的关键实现改坏，跑 M2 套件，验证断言真的会挂（断言有牙）。
// 做法：把 lib/ 和 test/ 拷到临时目录，改一份坏代码，跑那边的 m2-run.mjs，只认 FAIL 行。
// 跑法：node ~/.dsh/bundles/dsh-qq-gateway/test/m2-mutation.mjs
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const MUTATIONS = [
  {
    name: '超时后不放开单飞闸门',
    file: 'lib/gateway/gateway.js',
    find: "          releaseTurn('timeout');",
    replace: '          /* 变异：超时不放闸门 */',
    expectFail: '超时：投递后没有 turn/end',
  },
  {
    name: '断线回传不缓冲（直接丢）',
    file: 'lib/gateway/gateway.js',
    find: 'if (cfg.offlineBufferMax <= 0) {',
    replace: 'if (true) {',
    expectFail: '断线补发：断线期间产生的回传先进缓冲',
  },
  {
    name: '媒体回执不节流',
    file: 'lib/gateway/gateway.js',
    find: 'if (nowMs - lastUnsupportedNoticeAt < cfg.unsupportedNoticeIntervalMs) {',
    replace: 'if (false) {',
    expectFail: '媒体回执：语音同样回执；节流窗口内不重复回',
  },
  {
    name: 'L3 判据放宽成"带 rid 就算自己的"',
    file: 'lib/gateway/protocol.js',
    find: 'for (const rid of this.rids) (gate.has(rid) ? own : foreign).push(rid);',
    replace: 'for (const rid of this.rids) own.push(rid);',
    expectFail: '红线回归：媒体回执不影响 L3',
  },
];

const tmp = mkdtempSync(join(tmpdir(), 'qqgw-m2-mut-'));
const results = [];

function prepare() {
  rmSync(join(tmp, 'lib'), { recursive: true, force: true });
  rmSync(join(tmp, 'test'), { recursive: true, force: true });
  cpSync(join(ROOT, 'lib'), join(tmp, 'lib'), { recursive: true, filter: (src) => !src.includes('rev3') });
  cpSync(join(ROOT, 'test'), join(tmp, 'test'), { recursive: true });
}

for (const mutation of MUTATIONS) {
  prepare();
  const target = join(tmp, mutation.file);
  const before = readFileSync(target, 'utf8');
  const hits = before.split(mutation.find).length - 1;
  const mutated = before.replace(mutation.find, mutation.replace);
  writeFileSync(target, mutated, 'utf8');

  const run = spawnSync(process.execPath, [join(tmp, 'test', 'm2-run.mjs')], {
    cwd: tmp,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180000,
  });
  const stdout = run.stdout ?? '';
  const failLines = stdout.match(/^FAIL {2}.+$/gm) ?? [];
  const expectedHit = failLines.some((line) => line.includes(mutation.expectFail));
  const ok = hits === 1 && run.status === 1 && expectedHit && failLines.length <= 8;
  results.push({
    mutation: mutation.name,
    file: mutation.file,
    patchHits: hits,
    exitCode: run.status,
    failedAssertions: failLines.map((l) => l.replace(/^FAIL {2}/, '')),
    expectedAssertion: mutation.expectFail,
    expectedAssertionFailed: expectedHit,
    caught: ok,
  });
  console.log(`${ok ? 'CAUGHT' : 'MISSED'}  ${mutation.name} → exit=${run.status} 挂 ${failLines.length} 条${expectedHit ? `（含"${mutation.expectFail}"）` : `（没有预期的"${mutation.expectFail}"！）`}`);
  if (hits !== 1) console.log(`  注意：补丁命中 ${hits} 次，期望 1 次`);
  if (run.error) console.log(`  运行错误：${run.error.message}`);
}

rmSync(tmp, { recursive: true, force: true });

const missed = results.filter((r) => !r.caught);
const evidence = {
  milestone: 'M2',
  kind: '变异测试：M2 断言是否真的有牙',
  at: new Date().toISOString(),
  baseline: 'node test/m2-run.mjs → 24/24 通过',
  totals: { mutations: results.length, caught: results.length - missed.length, missed: missed.length },
  results,
};
writeFileSync(join(ROOT, 'm2-mutation-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

console.log(`\n=== 变异测试：${results.length - missed.length}/${results.length} 被抓到 ===`);
for (const m of missed) console.log(`  MISSED ${m.mutation}`);
console.log(`证据：${join(ROOT, 'm2-mutation-evidence.json')}`);
process.exitCode = missed.length ? 1 : 0;
