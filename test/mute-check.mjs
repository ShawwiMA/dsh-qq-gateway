// M8 禁回（mute）离线自检：纯逻辑 + 临时文件，不碰 cordis / WS / QQ。
// 覆盖：时长解析、主号免疫、定时过期、落盘重启、文件热加载、/mute /unmute 指令文案。

import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_MUTE_FILE,
  createMuteState,
  formatRemaining,
  parseDuration,
  remainingMinutes,
} from '../lib/gateway/mute.js';

const MAIN = '10001';
const PEER = '20002';

let pass = 0;
let fail = 0;

async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}: ${err?.message ?? err}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'qqgw-mute-'));
const peerFile = join(dir, 'peer.json');
const persistFile = join(dir, 'persist.json');
const hotFile = join(dir, 'hot.json');

console.log('=== M8：禁回 纯逻辑 ===');

await check('默认落盘路径在 ~/.dsh/storages 下', () => {
  assert.ok(DEFAULT_MUTE_FILE.endsWith('qq-gateway-mute.json'), DEFAULT_MUTE_FILE);
  assert.ok(DEFAULT_MUTE_FILE.includes('.dsh'), DEFAULT_MUTE_FILE);
});

await check('时长解析：纯数字/分钟/小时/天/永久/非法', () => {
  assert.deepEqual(parseDuration(''), { ok: true, minutes: 30 });
  assert.deepEqual(parseDuration('', 5), { ok: true, minutes: 5 });
  assert.deepEqual(parseDuration('10'), { ok: true, minutes: 10 });
  assert.deepEqual(parseDuration('10分钟'), { ok: true, minutes: 10 });
  assert.deepEqual(parseDuration('2h'), { ok: true, minutes: 120 });
  assert.deepEqual(parseDuration('2小时'), { ok: true, minutes: 120 });
  assert.deepEqual(parseDuration('1d'), { ok: true, minutes: 1440 });
  assert.deepEqual(parseDuration('0'), { ok: true, minutes: 0 });
  assert.deepEqual(parseDuration('永久'), { ok: true, minutes: 0 });
  assert.deepEqual(parseDuration('abc'), { ok: false });
  assert.deepEqual(parseDuration('-5'), { ok: false });
});

await check('剩余时间文案：分钟/小时/永久', () => {
  const now = Date.now();
  assert.equal(remainingMinutes(new Date(now + 45 * 60000).toISOString(), now), 45);
  assert.equal(formatRemaining(new Date(now + 45 * 60000).toISOString(), now), '45 分钟');
  assert.equal(formatRemaining(new Date(now + 125 * 60000).toISOString(), now), '2 小时 5 分');
  assert.equal(formatRemaining(null, now), '永久');
});

await check('只看某个号：禁了 PEER，主号和其他人不受影响', () => {
  let clock = 1_700_000_000_000;
  const mute = createMuteState({ file: peerFile, defaultMinutes: 30, nowMs: () => clock });
  const res = mute.setPeer(PEER, { minutes: 10, reason: '测试' });
  assert.equal(res.ok, true);
  assert.equal(mute.isMuted(PEER, MAIN), true);
  assert.equal(mute.isMuted(MAIN, MAIN), false);
  assert.equal(mute.isMuted('20001', MAIN), false);
  assert.equal(mute.list().length, 1);
  const snap = mute.snapshot();
  assert.equal(snap.activeCount, 1);
  assert.equal(snap.peers[0].qq, PEER);
  assert.equal(snap.peers[0].remainingMinutes, 10);
  mute.close();
});

await check('全局禁回：主号仍然免疫', () => {
  let clock = 1_700_000_000_000;
  const mute = createMuteState({ file: null, nowMs: () => clock });
  mute.setGlobal({ minutes: 5 });
  assert.equal(mute.isMuted('123456789', MAIN), true);
  assert.equal(mute.isMuted(MAIN, MAIN), false);
  assert.equal(mute.isMuted(PEER, MAIN), true);
  mute.close();
});

await check('到期自动失效（不用手动清）', () => {
  let clock = 1_700_000_000_000;
  const mute = createMuteState({ file: null, nowMs: () => clock });
  mute.setPeer(PEER, { minutes: 1 });
  assert.equal(mute.isMuted(PEER, MAIN), true);
  clock += 61_000;
  assert.equal(mute.isMuted(PEER, MAIN), false);
  assert.equal(mute.list().length, 0);
  mute.close();
});

await check('0 分钟 = 永久，直到解除', () => {
  let clock = 1_700_000_000_000;
  const mute = createMuteState({ file: null, nowMs: () => clock });
  mute.setPeer(PEER, { minutes: 0 });
  clock += 365 * 24 * 3600_000;
  assert.equal(mute.isMuted(PEER, MAIN), true);
  assert.equal(mute.list()[0].remainingMinutes, null);
  mute.close();
});

await check('落盘后新实例能读回（等价 DSH 重启）', () => {
  const clock = 1_700_000_000_000;
  const first = createMuteState({ file: persistFile, nowMs: () => clock });
  first.setPeer(PEER, { minutes: 20 });
  first.close();
  const second = createMuteState({ file: persistFile, nowMs: () => clock });
  assert.equal(second.isMuted(PEER, MAIN), true);
  const cleared = second.clearAll();
  assert.equal(cleared.cleared, true);
  assert.equal(second.isMuted(PEER, MAIN), false);
  second.close();
});

await check('热加载：外部改 JSON 不重启就生效', async () => {
  const clock = Date.now();
  const mute = createMuteState({ file: hotFile, pollMs: 30, nowMs: () => clock });
  mute.watch();
  assert.equal(mute.isMuted(PEER, MAIN), false);
  writeFileSync(hotFile, JSON.stringify({
    version: 1,
    global: null,
    peers: { [PEER]: { until: new Date(clock + 600_000).toISOString(), setAt: '', reason: '外部写入' } },
  }), 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(mute.isMuted(PEER, MAIN), true, '外部写入的禁回应该已生效');
  rmSync(hotFile);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(mute.isMuted(PEER, MAIN), false, '删掉状态文件应该全部解禁');
  mute.close();
});

await check('主号 /mute、/unmute 指令：文案精确、非法参数不改状态', () => {
  const clock = Date.now();
  const mute = createMuteState({ file: null, nowMs: () => clock, defaultMinutes: 30 });
  assert.equal(mute.handleCommand({ command: 'mute', arg: 'list' }), '当前没有禁回，所有消息正常回。');
  assert.equal(mute.handleCommand({ command: 'allow', arg: PEER }), null);

  const globalText = mute.handleCommand({ command: 'mute', arg: '10' });
  assert.ok(globalText.includes('已全局禁回'), globalText);
  assert.ok(globalText.includes('10 分钟'), globalText);
  assert.equal(mute.isMuted(PEER, MAIN), true);

  const bad = mute.handleCommand({ command: 'mute', arg: 'abc' });
  assert.ok(bad.includes('看不懂'), bad);
  assert.equal(mute.snapshot().activeCount, 1, '非法参数不应该改状态');

  mute.handleCommand({ command: 'unmute', arg: '' });
  assert.equal(mute.isMuted(PEER, MAIN), false);

  const peerText = mute.handleCommand({ command: 'mute', arg: `${PEER} 5 测试` });
  assert.ok(peerText.includes(`已禁回 QQ ${PEER}`), peerText);
  assert.ok(peerText.includes('5 分钟'), peerText);
  assert.equal(mute.isMuted(MAIN, MAIN), false);

  const listText = mute.handleCommand({ command: 'mute', arg: 'list' });
  assert.ok(listText.includes(PEER), listText);

  const unmuteText = mute.handleCommand({ command: 'unmute', arg: PEER });
  assert.ok(unmuteText.includes('已解除'), unmuteText);
  assert.equal(mute.isMuted(PEER, MAIN), false);
  mute.close();
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
