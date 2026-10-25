// M8 禁回端到端验收：真起网关（假 NapCat + 假 DSH），验证
// 1) 主号 /mute QQ 5 → 回执「已禁回 QQ ...」+ 落盘 + 不进 DSH
// 2) 被禁的人发消息 → 不投 DSH、不回任何话、mutedSkipped +1
// 3) 主号不受影响，照常回
// 4) /mute list、/unmute
// 5) 热加载：外部改状态文件 / 删文件，0.5~1 秒内生效，不用重启
// 6) qq_mute 工具（DSH 侧）直接改状态，UI 立即生效
// 跑法：node ~/.dsh/bundles/dsh-qq-gateway/test/m8-mute-e2e.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createFakeDsh } from './fake-dsh.mjs';
import { connectFakeNapCat } from './fake-napcat.mjs';
import { createGateway } from '../lib/gateway/gateway.js';

const MAIN_QQ = 10001;
const BOT_QQ = 10002;
const FRIEND_QQ = 20001;
const PATH = '/onebot';
const TOKEN = 'm8-test-token';
const SESSION = 'session-fake-target';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : undefined);
  } catch (err) {
    record(name, false, err.message);
  }
}
async function waitFor(fn, { timeoutMs = 4000, label = 'condition', intervalMs = 10 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout ${timeoutMs}ms waiting for ${label}`);
    await delay(intervalMs);
  }
}
function bodyOf(call) {
  const text = call?.request?.content?.[0]?.text ?? '';
  const sep = text.indexOf('\n\n');
  return sep === -1 ? text : text.slice(sep + 2);
}

const cfgBase = {
  replyDelayMode: 'off',
  host: '127.0.0.1',
  port: 0,
  path: PATH,
  token: TOKEN,
  mainQQ: MAIN_QQ,
  botQQ: BOT_QQ,
  sessionId: SESSION,
  maxQueue: 8,
  turnTimeoutMs: 5000,
  ridTtlMs: 30 * 60 * 1000,
  adminEnabled: true,
  groupRequireMention: true,
  allowAllPrivate: true,
  muteDefaultMinutes: 30,
};

const dir = mkdtempSync(join(tmpdir(), 'qqgw-m8-'));
const MUTE_FILE = join(dir, 'mute.json');

const fake = createFakeDsh({ sessionId: SESSION });
fake.emitSeed();
const gw = createGateway({
  ctx: fake.ctx,
  config: { ...cfgBase, muteStatePath: MUTE_FILE },
  logger: () => {},
});
await gw.start();
const url = `ws://127.0.0.1:${gw.port()}${PATH}`;
const nc = await connectFakeNapCat({ url, token: TOKEN, botQQ: BOT_QQ, mainQQ: MAIN_QQ });
await waitFor(() => gw.status().peers >= 1, { label: 'peer registered' });

async function answer(index, replyText) {
  const turn = fake.startTurnFor(fake.calls.prompt[index].requestId, { replyText, stepMs: 5 });
  await turn.done;
}

console.log('=== M8：禁回 端到端 ===');

await check('主号 /mute QQ 5：回执精确 + 落盘 + 不进 DSH', async () => {
  const before = fake.calls.prompt.length;
  nc.sendPrivate({ text: `/mute ${FRIEND_QQ} 5`, messageId: 6001 });
  const ack = await nc.waitForAction((a) => a.action === 'send_private_msg' && String(a.params.message).includes('已禁回'), { label: 'mute ack' });
  assert.match(ack.params.message, new RegExp(`已禁回 QQ ${FRIEND_QQ}`));
  assert.match(ack.params.message, /5 分钟/);
  assert.equal(gw.status().mute.activeCount, 1);
  assert.equal(fake.calls.prompt.length, before, '指令不能投给 DSH');
  const saved = JSON.parse(readFileSync(MUTE_FILE, 'utf8'));
  assert.ok(saved.peers[String(FRIEND_QQ)], '状态要落盘');
  return ack.params.message.replace(/\n/g, ' ');
});

await check('被禁的人发消息：不投 DSH、不回任何话', async () => {
  const promptsBefore = fake.calls.prompt.length;
  const repliesBefore = nc.replies().length;
  nc.sendPrivate({ text: '在吗？', messageId: 6002, userId: FRIEND_QQ, nickname: '小志' });
  await delay(300);
  assert.equal(fake.calls.prompt.length, promptsBefore, '禁回期间不能起回合');
  assert.equal(nc.replies().length, repliesBefore, '禁回期间不能回话');
  assert.equal(gw.counters.mutedSkipped, 1);
  return 'dropped';
});

await check('主号不受影响：照常投递 + 回传', async () => {
  const before = fake.calls.prompt.length;
  nc.sendPrivate({ text: '主号说话', messageId: 6003 });
  await waitFor(() => fake.calls.prompt.length === before + 1, { label: 'main prompt' });
  assert.equal(bodyOf(fake.calls.prompt[before]), '主号说话');
  await answer(before, '主号的回复');
  const reply = await nc.waitForAction((a) => a.action === 'send_private_msg' && a.params.message === '主号的回复', { label: 'main reply' });
  assert.equal(reply.params.user_id, MAIN_QQ);
  return 'ok';
});

await check('/mute list：列出被禁的人', async () => {
  nc.sendPrivate({ text: '/mute list', messageId: 6004 });
  const ack = await nc.waitForAction((a) => a.action === 'send_private_msg' && String(a.params.message).includes('当前禁回'), { label: 'list ack' });
  assert.match(ack.params.message, new RegExp(String(FRIEND_QQ)));
  return 'ok';
});

await check('热加载：外部改状态文件，1 秒内生效，不用重启 DSH', async () => {
  // 外部（人 / 脚本 / DSH 的 bash）直接写 JSON：全局禁回 30 分钟
  writeFileSync(MUTE_FILE, JSON.stringify({
    version: 1,
    global: { until: new Date(Date.now() + 30 * 60_000).toISOString(), setAt: new Date().toISOString(), reason: '外部写入' },
    peers: {},
  }, null, 2), 'utf8');
  const promptsBefore = fake.calls.prompt.length;
  await delay(900);
  nc.sendPrivate({ text: '我还能说话吗', messageId: 6005, userId: FRIEND_QQ, nickname: '小志' });
  await delay(300);
  assert.equal(fake.calls.prompt.length, promptsBefore, '外部写入的禁回也要生效');
  assert.equal(gw.status().mute.global !== null, true);

  // 删掉文件 = 全部解禁
  rmSync(MUTE_FILE);
  await delay(900);
  nc.sendPrivate({ text: '现在呢', messageId: 6006, userId: FRIEND_QQ, nickname: '小志' });
  await waitFor(() => fake.calls.prompt.length === promptsBefore + 1, { label: 'friend prompt after clear' });
  await answer(promptsBefore, '收到');
  return 'hot reload ok';
});

await check('/unmute：解除后立刻恢复正常', async () => {
  const promptsBefore = fake.calls.prompt.length;
  nc.sendPrivate({ text: `/mute ${FRIEND_QQ} 5`, messageId: 6010 });
  await waitFor(() => gw.status().mute.activeCount === 1, { label: 'mute applied' });
  nc.sendPrivate({ text: `/unmute ${FRIEND_QQ}`, messageId: 6007 });
  await waitFor(() => gw.status().mute.activeCount === 0, { label: 'unmute applied' });
  const lastReply = nc.replies().at(-1);
  assert.match(String(lastReply?.params?.message ?? ''), /已解除/);
  nc.sendPrivate({ text: '解除了吗', messageId: 6008, userId: FRIEND_QQ, nickname: '小志' });
  await waitFor(() => fake.calls.prompt.length === promptsBefore + 1, { label: 'friend prompt after unmute' });
  return 'ok';
});

await check('qq_mute 工具（DSH 侧）直接改状态：立即生效', async () => {
  const { createQqTools } = await import('../lib/gateway/tools.js');
  const tools = createQqTools({ gateway: gw, config: gw.config, logger: () => {} });
  const muteTool = tools.find((t) => t.name === 'qq_mute');
  assert.ok(muteTool, '必须注册 qq_mute');
  const promptsBefore = fake.calls.prompt.length;
  const muted = await muteTool.execute({ action: 'mute', qq: String(FRIEND_QQ), minutes: 3, reason: '工具测试' });
  assert.equal(muted.ok, true, JSON.stringify(muted));
  nc.sendPrivate({ text: '工具禁了吗', messageId: 6009, userId: FRIEND_QQ, nickname: '小志' });
  await delay(300);
  assert.equal(fake.calls.prompt.length, promptsBefore, '工具禁回也要生效');
  const listed = await muteTool.execute({ action: 'list' });
  assert.equal(listed.ok, true);
  assert.ok(String(listed.text).includes(String(FRIEND_QQ)));
  const cleared = await muteTool.execute({ action: 'unmute' });
  assert.equal(cleared.ok, true);
  assert.equal(gw.status().mute.activeCount, 0);
  return 'ok';
});

await nc.close();
await gw.stop();
rmSync(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length > 0) process.exitCode = 1;
