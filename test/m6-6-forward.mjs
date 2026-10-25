// M6.6 离线验收：合并转发（QQ 聊天记录）能被读出来投给模型。
// 覆盖：纯逻辑解析/格式化 / 纯转发消息进门 / 文字+转发 / inline 展开 / 读取失败占位 /
//       节点数上限截断 / 群消息 @ 小号 + 转发 / 不再回「目前仅支持文本消息」/ 计数自洽。
// 跑法：node ~/.dsh/bundles/dsh-qq-gateway/test/m6-6-forward.mjs
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { createFakeDsh } from './fake-dsh.mjs';
import { connectFakeNapCat } from './fake-napcat.mjs';
import { createGateway } from '../lib/gateway/gateway.js';
import {
  DROP,
  extractForwardSegments,
  formatForwardNodes,
  formatNodeBody,
  parseInbound,
} from '../lib/gateway/protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const MAIN_QQ = 10001;
const BOT_QQ = 10002;
const TOKEN = 'm6-6-token';
const PATH = '/onebot';
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

async function waitFor(fn, { timeoutMs = 4000, label = 'condition', intervalMs = 5 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout ${timeoutMs}ms waiting for ${label}`);
    await delay(intervalMs);
  }
}

// 转发节点样本：纯文字 / 群名片 + 文字 + @
// （图片节点在 M6.7 单独验：M6.7 起转发里的图会真下载投给模型，正文标签变成 [图片N]）
const NODES_OK = [
  { sender: { nickname: '小明', user_id: 10001 }, message: [{ type: 'text', data: { text: '第一条' } }] },
  {
    sender: { card: '群友甲', user_id: 10002 },
    message: [
      { type: 'text', data: { text: '看这个' } },
      { type: 'at', data: { qq: '10003' } },
    ],
  },
];
const EXPECTED_BODY = '1. 小明：第一条\n2. 群友甲：看这个@10003';

const cfgBase = {
  // 拟人延迟会拖慢回传，回归用例只验机制不验时延 → 一律关掉（时延本身由 human-delay-check.mjs 覆盖）
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
};

const frameBase = { post_type: 'message', message_type: 'private', user_id: MAIN_QQ, self_id: BOT_QQ, message_id: 1 };

console.log('=== M6.6：合并转发段解析（纯逻辑） ===');

await check('extractForwardSegments：抽 forward 段的 id，inline content 也认，普通段忽略', () => {
  assert.deepEqual(
    extractForwardSegments([
      { type: 'text', data: { text: 'hi' } },
      { type: 'forward', data: { id: 'FWD-1' } },
      { type: 'forward', data: { content: [{ message: [{ type: 'text', data: { text: 'x' } }] }] } },
      { type: 'node', data: { message_id: 'FWD-2' } },
      { type: 'forward', data: {} },
    ]),
    [{ id: 'FWD-1', content: null }, { id: '', content: [{ message: [{ type: 'text', data: { text: 'x' } }] }] }, { id: 'FWD-2', content: null }],
  );
});

await check('formatNodeBody：文字拼接、图片/表情打标签、@ 带出号码', () => {
  assert.equal(formatNodeBody([{ type: 'text', data: { text: 'a' } }, { type: 'image', data: {} }]), 'a[图片]');
  assert.equal(formatNodeBody([{ type: 'face', data: { id: '14' } }, { type: 'text', data: { text: 'b' } }]), '[表情]b');
  assert.equal(formatNodeBody([{ type: 'text', data: { text: 'hi ' } }, { type: 'at', data: { qq: 10003 } }]), 'hi @10003');
  assert.equal(formatNodeBody([{ type: 'record', data: {} }]), '[语音]');
  assert.equal(formatNodeBody('纯字符串'), '纯字符串');
});

await check('formatForwardNodes：编号 + 昵称，超 maxNodes 截断并写明总数', () => {
  const ok = formatForwardNodes(NODES_OK);
  assert.equal(ok.text, EXPECTED_BODY);
  assert.equal(ok.count, 2);
  assert.equal(ok.shown, 2);
  assert.equal(ok.truncated, false);

  const many = Array.from({ length: 60 }, (_, i) => ({
    sender: { nickname: `人${i + 1}` },
    message: [{ type: 'text', data: { text: `第${i + 1}条` } }],
  }));
  const trimmed = formatForwardNodes(many, { maxNodes: 50, maxChars: 4000 });
  assert.equal(trimmed.shown, 50);
  assert.equal(trimmed.count, 60);
  assert.equal(trimmed.truncated, true);
  assert.match(trimmed.text, /共 60 条，只展示前 50 条）$/);

  const chars = formatForwardNodes(many, { maxNodes: 50, maxChars: 20 });
  assert.ok(chars.shown < 50, '字数上限也要生效');
});

await check('parseInbound：纯转发消息放行（不再当空消息丢），语音仍按不支持丢弃', () => {
  const forward = parseInbound({ ...frameBase, message: [{ type: 'forward', data: { id: 'FWD-1' } }] }, cfgBase);
  assert.equal(forward.ok, true);
  assert.equal(forward.msg.text, '');
  assert.deepEqual(forward.msg.forwards, [{ id: 'FWD-1', content: null }]);
  assert.deepEqual(forward.msg.media, [], 'forward 不算不支持的媒体');

  const voice = parseInbound({ ...frameBase, message: [{ type: 'record', data: { file: 'v.amr' } }] }, cfgBase);
  assert.equal(voice.ok, false);
  assert.equal(voice.reason, DROP.EMPTY_TEXT);
  assert.deepEqual(voice.media, ['record']);

  const mix = parseInbound({
    ...frameBase,
    message: [{ type: 'text', data: { text: '帮我看看这段' } }, { type: 'forward', data: { id: 'FWD-2' } }],
  }, cfgBase);
  assert.equal(mix.ok, true);
  assert.equal(mix.msg.text, '帮我看看这段');
  assert.equal(mix.msg.forwards.length, 1);
});

console.log('\n=== M6.6：网关真把转发内容投给模型 ===');

const fake = createFakeDsh({ sessionId: SESSION });
fake.emitSeed();
const logs = [];
const gw = createGateway({
  ctx: fake.ctx,
  config: cfgBase,
  logger: (m) => logs.push(m),
  deps: { fetchImpl: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }), imageTimeoutMs: 400 },
});
await gw.start();
const url = `ws://127.0.0.1:${gw.port()}${PATH}`;
const nc = await connectFakeNapCat({ url, token: TOKEN, botQQ: BOT_QQ, mainQQ: MAIN_QQ });
await waitFor(() => gw.status().peers >= 1, { label: 'peer registered' });
// send_* 自动应答；get_forward_msg 留给测试手动回（要分别造成功/失败/形状异常）
nc.startAutoRespond((action) => (action.action === 'get_forward_msg' ? false : undefined));

async function nextPrompt(label) {
  const before = fake.calls.prompt.length;
  await waitFor(() => fake.calls.prompt.length === before + 1, { label, timeoutMs: 4000 });
  return fake.calls.prompt[before];
}
async function answerLast(replyText = '收到') {
  const index = fake.calls.prompt.length - 1;
  const turn = fake.startTurnFor(fake.calls.prompt[index].requestId, { replyText, stepMs: 5 });
  await turn.done;
}
/** 等网关发出的 get_forward_msg 动作并回包 */
async function answerForward({ id, data = { messages: NODES_OK }, status = 'ok', retcode = 0 } = {}) {
  const action = await nc.waitForAction(
    (a) => a.action === 'get_forward_msg' && String(a.params?.message_id ?? '') === String(id),
    { label: `get_forward_msg(${id})` },
  );
  nc.respondToAction({ echo: action.echo, data, status, retcode });
  return action;
}

await check('私聊只发一条合并转发：网关调 get_forward_msg(message_id)，节点内容进 prompt', async () => {
  const before = fake.calls.prompt.length;
  const repliesBefore = nc.replies().length;
  nc.sendSegments({ segments: [{ type: 'forward', data: { id: 'FWD-OK' } }], messageId: 7001 });
  const action = await answerForward({ id: 'FWD-OK' });
  assert.deepEqual(action.params, { message_id: 'FWD-OK' }, '参数名必须归一成 NapCat 的 message_id');

  await waitFor(() => fake.calls.prompt.length === before + 1, { label: 'forward prompt' });
  const content = fake.calls.prompt[before].request.content;
  assert.deepEqual(content.map((p) => p.type), ['text', 'text'], '来源说明 + 转发正文');
  assert.match(content[0].text, /^【QQ私聊】主号：/);
  assert.match(content[1].text, /^\[合并转发\] 共 2 条\n/);
  assert.equal(content[1].text, `[合并转发] 共 2 条\n${EXPECTED_BODY}`);
  assert.equal(gw.counters.forwardRead, 1);
  assert.equal(gw.counters.forwardFailures, 0);
  assert.equal(nc.replies().length, repliesBefore, '转发消息不该被回「目前仅支持文本消息」');
  assert.equal(gw.counters.unsupportedNotified, 0);

  await answerLast('看到了，是小明和群友甲的聊天记录');
  await waitFor(() => nc.replies().length === repliesBefore + 1, { label: 'forward relay' });
  assert.equal(nc.replies()[repliesBefore].params.message, '看到了，是小明和群友甲的聊天记录');
  return `content=${content[1].text.split('\n').length}行`;
});

await check('文字 + 合并转发：正文在前、转发块在后，两个文字块都投递', async () => {
  const before = fake.calls.prompt.length;
  nc.sendSegments({
    segments: [{ type: 'text', data: { text: '这记录里有啥' } }, { type: 'forward', data: { id: 'FWD-MIX' } }],
    messageId: 7002,
  });
  await answerForward({ id: 'FWD-MIX' });
  await waitFor(() => fake.calls.prompt.length === before + 1, { label: 'mixed forward prompt' });
  const content = fake.calls.prompt[before].request.content;
  assert.deepEqual(content.map((p) => p.type), ['text', 'text']);
  const first = content[0].text;
  assert.ok(first.includes('这记录里有啥'), '首块要带原文');
  assert.ok(first.includes('【QQ私聊】'), '首块要带来源说明');
  assert.equal(content[1].text, `[合并转发] 共 2 条\n${EXPECTED_BODY}`);
  await answerLast('记录里是小明发的第一条');
  await waitFor(() => nc.replies().length >= 2, { label: 'mixed relay' });
  return 'text+forward 两段';
});

await check('协议端已经 inline 展开内容：直接用，不再发 get_forward_msg', async () => {
  const before = fake.calls.prompt.length;
  const forwardActionsBefore = nc.actions.filter((a) => a.action === 'get_forward_msg').length;
  nc.sendSegments({
    segments: [{ type: 'forward', data: { id: 'INLINE-1', content: NODES_OK } }],
    messageId: 7003,
  });
  await waitFor(() => fake.calls.prompt.length === before + 1, { label: 'inline forward prompt' });
  const content = fake.calls.prompt[before].request.content;
  assert.equal(content.length, 2);
  assert.equal(content[1].text, `[合并转发] 共 2 条\n${EXPECTED_BODY}`);
  assert.equal(nc.actions.filter((a) => a.action === 'get_forward_msg').length, forwardActionsBefore, '不该多发动作');
  await answerLast('inline 内容已收到');
  await waitFor(() => nc.replies().length >= 3, { label: 'inline relay' });
  return 'inline 0 次动作调用';
});

await check('get_forward_msg 失败：prompt 里写明读取失败，不静默、不卡闸门、仍可回传', async () => {
  const before = fake.calls.prompt.length;
  nc.sendSegments({ segments: [{ type: 'forward', data: { id: 'FWD-FAIL' } }], messageId: 7004 });
  await answerForward({ id: 'FWD-FAIL', data: {}, status: 'failed', retcode: 100 });
  await waitFor(() => fake.calls.prompt.length === before + 1, { label: 'failing forward prompt' });
  const content = fake.calls.prompt[before].request.content;
  assert.equal(content.length, 2);
  assert.match(content[1].text, /^\[合并转发消息，内容读取失败：/);
  assert.equal(gw.counters.forwardFailures, 1);
  assert.equal(gw.counters.forwardRead, 3, '前面三次成功不受影响');
  assert.equal(gw.status().busy, true, '这一回合正常在跑，没卡死');
  await answerLast('转发内容没读到，麻烦直接发我文字');
  await waitFor(() => nc.replies().length >= 4, { label: 'failure relay' });
  assert.equal(nc.replies().at(-1).params.message, '转发内容没读到，麻烦直接发我文字');
  return '失败占位 + 正常回传';
});

await check('返回形状不对（data 没有 messages）：按失败处理，不抛异常', async () => {
  const before = fake.calls.prompt.length;
  nc.sendSegments({ segments: [{ type: 'forward', data: { id: 'FWD-SHAPE' } }], messageId: 7005 });
  await answerForward({ id: 'FWD-SHAPE', data: { foo: 'bar' } });
  await waitFor(() => fake.calls.prompt.length === before + 1, { label: 'bad shape prompt' });
  const content = fake.calls.prompt[before].request.content;
  assert.match(content[1].text, /内容读取失败：unexpected get_forward_msg shape/);
  assert.equal(gw.counters.forwardFailures, 2);
  await answerLast('形状不对也收到了');
  return '形状异常降级';
});

await check('节点数超限：仍投递并写明「共 N 条，只展示前 M 条」', async () => {
  const before = fake.calls.prompt.length;
  const many = Array.from({ length: 60 }, (_, i) => ({
    sender: { nickname: `人${i + 1}` },
    message: [{ type: 'text', data: { text: `第${i + 1}条` } }],
  }));
  nc.sendSegments({ segments: [{ type: 'forward', data: { id: 'FWD-MANY' } }], messageId: 7006 });
  await answerForward({ id: 'FWD-MANY', data: { messages: many } });
  await waitFor(() => fake.calls.prompt.length === before + 1, { label: 'many nodes prompt' });
  const text = fake.calls.prompt[before].request.content[1].text;
  assert.match(text, /^\[合并转发\] 共 60 条/);
  assert.match(text, /共 60 条，只展示前 50 条）$/);
  assert.equal(text.split('\n').length >= 50, true);
  await answerLast('条数太多，只看前 50 条');
  return '60 条 → 展示 50 条';
});

await check('群里 @小号 + 合并转发：照常进门，来源说明是群聊', async () => {
  const before = fake.calls.prompt.length;
  nc.sendFrame({
    post_type: 'message',
    message_type: 'group',
    group_id: 123456,
    message_id: 7007,
    user_id: MAIN_QQ,
    self_id: BOT_QQ,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: MAIN_QQ, nickname: '群友', card: '群友' },
    message: [
      { type: 'at', data: { qq: String(BOT_QQ) } },
      { type: 'forward', data: { id: 'FWD-GROUP' } },
    ],
    post_format: 'array',
  });
  await answerForward({ id: 'FWD-GROUP' });
  await waitFor(() => fake.calls.prompt.length === before + 1, { label: 'group forward prompt' });
  const content = fake.calls.prompt[before].request.content;
  assert.match(content[0].text, /^【QQ群聊】群 123456｜/);
  assert.equal(content[1].text, `[合并转发] 共 2 条\n${EXPECTED_BODY}`);
  await answerLast('群里的记录也看到了');
  await waitFor(() => nc.groupReplies().length >= 1, { label: 'group forward relay' });
  assert.equal(nc.groupReplies()[0].params.message, '群里的记录也看到了');
  return '群聊转发 ok';
});

await check('计数自洽 + 日志留痕', () => {
  assert.equal(gw.counters.forwardRead, 5);
  assert.equal(gw.counters.forwardFailures, 2);
  assert.equal(gw.counters.unsupportedNotified, 0, '转发不该触发「目前仅支持文本消息」');
  assert.ok(logs.some((m) => m.includes('forward resolved (get_forward_msg')), '成功日志要标明来源');
  assert.ok(logs.some((m) => m.includes('forward resolve failed')), '失败也要留日志');
  return `forwardRead=${gw.counters.forwardRead} forwardFailures=${gw.counters.forwardFailures}`;
});

await nc.close();
await gw.stop();

const failed = results.filter((r) => !r.ok);
const evidence = {
  milestone: 'M6.6',
  kind: '合并转发进会话（离线验收）',
  at: new Date().toISOString(),
  node: process.version,
  totals: { checks: results.length, passed: results.length - failed.length, failed: failed.length },
  results,
  counters: { ...gw.counters },
  notes: [
    'forward 段不再算“不支持的媒体”，纯转发消息能进门（以前会被当空消息丢）',
    '内容靠 get_forward_msg(message_id) 取回；协议端 inline 展开时直接用、不额外发动作',
    '有界：一条消息最多 3 段转发、每段最多 50 条节点 / 4000 字，超出写明截断',
    '读取失败不静默：prompt 里写「内容读取失败：原因」，回合照常可回传',
    '文本渲染：文字原样、图片 [图片]、语音 [语音]、@ 带出号码、嵌套转发 [合并转发]',
  ],
};
writeFileSync(join(ROOT, 'm6-6-forward-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
console.log(`证据：${join(ROOT, 'm6-6-forward-evidence.json')}`);
process.exitCode = failed.length ? 1 : 0;
