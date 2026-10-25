// M1 离线验收：假 NapCat + 假宿主跑通往返，并用断言钉住 L1/L2/L3。
// 跑法：node ~/.dsh/bundles/dsh-qq-gateway/test/m1-run.mjs
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { createFakeDsh } from './fake-dsh.mjs';
import { connectFakeNapCat, expectReject } from './fake-napcat.mjs';
import { createGateway, normalizeConfig } from '../lib/gateway/gateway.js';
import {
  DROP,
  Dedupe,
  RidGate,
  TURN_VERDICT,
  TurnTracker,
  assistantText,
  extractText,
  parseInbound,
} from '../lib/gateway/protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const MAIN_QQ = 10001;
const BOT_QQ = 10002;
const TOKEN = 'm1-test-token';
const PATH = '/onebot';
const SESSION = 'session-fake-target';

const results = [];
const gwLogs = [];

/** M5 起投给宿主的文本首块前面带一行来源说明；断言正文时剥掉它。 */
function bodyOf(call) {
  const text = call?.request?.content?.[0]?.text ?? '';
  const sep = text.indexOf('\n\n');
  return sep === -1 ? text : text.slice(sep + 2);
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function check(name, fn) {
  try {
    const detail = fn();
    record(name, true, typeof detail === 'string' ? detail : undefined);
  } catch (err) {
    record(name, false, err.message);
  }
}

async function checkAsync(name, fn) {
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
    if (value) return { value, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout ${timeoutMs}ms waiting for ${label}`);
    await delay(intervalMs);
  }
}

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
  // M6：事件默认只记录不投递（这里把旧断言隔离干净；事件投递在 m6 用例里单独验）
  eventPromptTypes: '',
};

console.log('=== M1 离线往返：单元断言（纯逻辑，不碰网络） ===');

check('extractText: 只取 text 段，图片/表情不占位', () => {
  assert.equal(extractText([{ type: 'text', data: { text: 'hi' } }, { type: 'face', data: { id: 1 } }]), 'hi');
  assert.equal(extractText([{ type: 'image', data: { file: 'a.png' } }]), '', '纯图片消息没有可投正文');
  assert.equal(extractText('  空白  '), '空白');
  assert.equal(extractText(undefined), '');
});

check('parseInbound: 正常私聊帧放行', () => {
  const r = parseInbound(
    { post_type: 'message', message_type: 'private', user_id: MAIN_QQ, self_id: BOT_QQ, message_id: 7, message: [{ type: 'text', data: { text: 'hi' } }], post_format: 'array' },
    cfgBase,
  );
  assert.equal(r.ok, true);
  assert.equal(r.msg.text, 'hi');
  assert.equal(r.msg.messageId, '7');
});

check('parseInbound: L1/L2 六种帧全被挡，且原因分类正确', () => {
  const cases = [
    ['action-response', { status: 'ok', retcode: 0, echo: 'x', post_type: 'message', message_type: 'private', user_id: MAIN_QQ, self_id: BOT_QQ, message: [{ type: 'text', data: { text: 'hi' } }] }],
    ['not-message', { post_type: 'notice', user_id: MAIN_QQ, self_id: BOT_QQ }],
    ['group-no-mention', { post_type: 'message', message_type: 'group', group_id: 123, user_id: MAIN_QQ, self_id: BOT_QQ, message: [{ type: 'text', data: { text: 'hi' } }] }],
    ['not-private', { post_type: 'message', message_type: 'other', user_id: MAIN_QQ, self_id: BOT_QQ, message: [{ type: 'text', data: { text: 'hi' } }] }],
    ['wrong-user', { post_type: 'message', message_type: 'private', user_id: 99999, self_id: BOT_QQ, message: [{ type: 'text', data: { text: 'hi' } }] }],
    ['wrong-self', { post_type: 'message', message_type: 'private', user_id: MAIN_QQ, self_id: MAIN_QQ, message: [{ type: 'text', data: { text: 'hi' } }] }],
    // M4.1 起图片能投递，这里用语音段验证"真不支持且无正文"的帧仍被挡
    ['empty-text', { post_type: 'message', message_type: 'private', user_id: MAIN_QQ, self_id: BOT_QQ, message: [{ type: 'record', data: { file: 'a.amr' } }] }],
  ];
  for (const [reason, frame] of cases) {
    const r = parseInbound(frame, cfgBase);
    assert.equal(r.ok, false, `${reason} should be dropped`);
    assert.equal(r.reason, DROP[reason.toUpperCase().replace(/-/g, '_')], `reason for ${reason}`);
  }
  return `${cases.length} 种帧`;
});

check('Dedupe: 同 id 第二次算重复，容量满丢最旧', () => {
  const d = new Dedupe({ max: 2 });
  assert.equal(d.seen('a'), false);
  assert.equal(d.seen('a'), true);
  assert.equal(d.seen('b'), false);
  assert.equal(d.seen('c'), false);
  assert.equal(d.seen('a'), false, '最旧的 a 应已被挤出');
  assert.equal(d.seen(''), false, '空 id 不参与判重');
});

check('RidGate: 命中即消费 + TTL 过期 + 上限', () => {
  let now = 1000;
  const gate = new RidGate({ ttlMs: 100, max: 3, now: () => now });
  gate.issue('r1');
  assert.equal(gate.has('r1'), true);
  assert.equal(gate.consume('r1'), true);
  assert.equal(gate.consume('r1'), false, '一个 rid 只能用一次');
  gate.issue('r2');
  now += 101;
  assert.equal(gate.has('r2'), false, 'TTL 过后必须失效');
  for (const r of ['a', 'b', 'c', 'd']) gate.issue(r);
  assert.equal(gate.size, 3, '上限之外的应被挤掉');
});

check('TurnTracker: 只认 rpcId 命中，4 条注入事件不构成 own', () => {
  const gate = new RidGate();
  gate.issue('mine');
  const t = new TurnTracker(1);
  t.noteUserSource({ kind: 'user', rpcId: 'mine' });
  for (const kind of ['agent-instructions', 'runtime-context', 'skill-catalog', 'time-context']) t.noteUserSource({ kind });
  assert.equal(t.injectedUserMessages, 4);
  assert.equal(t.verdict(gate).verdict, TURN_VERDICT.OWN);
  assert.equal(t.verdict(gate).ownRid, 'mine');

  const foreign = new TurnTracker(2);
  foreign.noteUserSource({ kind: 'user', rpcId: 'gui-someone-else' });
  for (const kind of ['agent-instructions', 'runtime-context', 'skill-catalog', 'time-context']) foreign.noteUserSource({ kind });
  assert.equal(foreign.verdict(gate).verdict, TURN_VERDICT.FOREIGN);

  const onlyInjected = new TurnTracker(3);
  for (const kind of ['agent-instructions', 'runtime-context', 'skill-catalog', 'time-context']) onlyInjected.noteUserSource({ kind });
  assert.equal(onlyInjected.verdict(gate).verdict, TURN_VERDICT.FOREIGN, '没有 rpcId 的 turn 必须零回传');

  const two = new TurnTracker(4);
  gate.issue('second');
  two.noteUserSource({ kind: 'user', rpcId: 'mine' });
  two.noteUserSource({ kind: 'user', rpcId: 'second' });
  assert.equal(two.verdict(gate).verdict, TURN_VERDICT.AMBIGUOUS, '一 turn 两 rid 必须判歧义');
});

check('assistantText: 只取 text 块，reasoning/tool-call 不推', () => {
  const text = assistantText({
    content: [
      { type: 'reasoning', text: '想一下' },
      { type: 'text', text: '第一段' },
      { type: 'tool-call', id: 't1', name: 'x', arguments: '{}' },
      { type: 'text', text: '第二段' },
    ],
  });
  assert.equal(text, '第一段\n第二段');
});

check('normalizeConfig: deliveryMode 只能 queue/steer', () => {
  assert.throws(() => normalizeConfig({ deliveryMode: 'turbo' }), /deliveryMode/);
});

console.log('\n=== M1 离线往返：集成断言（假 NapCat ↔ 真网关 ↔ 假宿主） ===');

const fake = createFakeDsh({ sessionId: SESSION });
fake.emitSeed();
const gw = createGateway({
  ctx: fake.ctx,
  config: cfgBase,
  logger: (msg) => gwLogs.push(msg),
});

let napcat = null;
try {
  const started = await gw.start();
  const url = `ws://127.0.0.1:${gw.port()}${PATH}`;

  await checkAsync('启动：监听 127.0.0.1 临时端口，目标是硬编码会话', () => {
    assert.equal(started.state, 'listening');
    assert.ok(started.listening.port > 0);
    assert.equal(started.config.sessionId, SESSION);
    assert.equal(started.tokenConfigured, true);
    return url;
  });

  await checkAsync('token：错 token 的握手被 401 拒绝', async () => {
    const bad = await expectReject({ url, token: 'wrong-token' });
    assert.equal(bad.rejected, true, `应该被拒，实际 ${bad.reason}`);
    assert.match(bad.reason, /401/);
    return bad.reason;
  });

  await checkAsync('token：无 token 的握手同样被拒', async () => {
    const bad = await expectReject({ url, token: '' });
    assert.equal(bad.rejected, true);
    return bad.reason;
  });

  await checkAsync('连接：正确 token 连上，peers=1', async () => {
    napcat = await connectFakeNapCat({ url, token: TOKEN, botQQ: BOT_QQ, mainQQ: MAIN_QQ });
    await waitFor(() => gw.status().peers === 1, { label: 'peer registered' });
    return `peers=${gw.status().peers}`;
  });

  await checkAsync('端到端：私聊帧 → prompt（契约形状）→ 假宿主回放 → send_private_msg', async () => {
    const t0 = Date.now();
    napcat.sendPrivate({ text: '你好，这是第一条', messageId: 1001 });
    await waitFor(() => fake.calls.prompt.length === 1, { label: 'prompt call' });
    const ackMs = Date.now() - t0;
    const call = fake.calls.prompt[0];
    assert.match(call.requestId, /^qqgw-/);
    assert.equal(call.request.sessionId, SESSION);
    assert.equal(call.request.mode, 'queue');
    assert.equal(call.signalPresent, true, 'AbortSignal 必须传（M0 坑点 1）');
    assert.equal(call.request.content.length, 1);
    assert.match(call.request.content[0].text, /^【QQ私聊】主号：/);
    assert.equal(bodyOf(call), '你好，这是第一条');

    const turn = fake.startTurnFor(call.requestId, { replyText: '收到：你好，这是第一条' });
    await turn.done;
    const reply = await napcat.waitForAction((a) => a.action === 'send_private_msg', { label: 'send_private_msg' });
    assert.equal(reply.params.message, '收到：你好，这是第一条');
    assert.equal(reply.params.user_id, MAIN_QQ, '回给主号，不是小号');
    assert.equal(typeof reply.echo, 'string');
    await delay(60);
    assert.equal(napcat.replies().length, 1, '一个 turn 只能回一条');
    assert.ok(!reply.params.message.includes('先想一下'), 'reasoning 不许推出去');
    return `收帧→prompt ${ackMs}ms，回帧 1 条，echo=${reply.echo}`;
  });

  await checkAsync('L3 回归（M0 坑点 2）：宿主 4 条无 rpcId 注入事件不触发回传', async () => {
    assert.ok(gw.counters.injectedUserMessages >= 4, `应至少看到 4 条注入事件，实际 ${gw.counters.injectedUserMessages}`);
    const ownTurn = fake.events.filter((e) => e.type === 'turn/end').length;
    assert.ok(ownTurn >= 1);
    assert.equal(napcat.replies().length, 1);
    return `注入事件 ${gw.counters.injectedUserMessages} 条，回传仍是 1 条`;
  });

  await checkAsync('L3：GUI 发起的 turn（别人的 rpcId）零回传', async () => {
    const before = napcat.replies().length;
    const skippedBefore = gw.counters.skippedForeign;
    const t = fake.guiTurn({ rid: `gui-${Date.now()}`, replyText: 'GUI 的回复不该出去' });
    await t.done;
    await delay(80);
    assert.equal(napcat.replies().length, before);
    assert.equal(gw.counters.skippedForeign, skippedBefore + 1);
    return `skippedForeign=${gw.counters.skippedForeign}`;
  });

  await checkAsync('L3：宿主自己续跑的 turn（一条 rpcId 都没有）零回传', async () => {
    const before = napcat.replies().length;
    const skippedBefore = gw.counters.skippedForeign;
    const t = fake.hostContinuationTurn({ replyText: '续跑回复不该出去' });
    await t.done;
    await delay(80);
    assert.equal(napcat.replies().length, before);
    assert.equal(gw.counters.skippedForeign, skippedBefore + 1);
    return `skippedForeign=${gw.counters.skippedForeign}`;
  });

  await checkAsync('L2：伪造来源帧（别人/冒名/群/notice/语音/echo）一条都不投', async () => {
    const promptsBefore = fake.calls.prompt.length;
    const droppedBefore = { ...gw.counters.dropped };
    const noticesBefore = gw.counters.notices;
    napcat.sendPrivate({ text: '陌生人的私聊', messageId: 1101, userId: 99999 });
    napcat.sendPrivate({ text: '冒名 self_id', messageId: 1102, selfId: MAIN_QQ });
    napcat.sendGroup({ text: '群消息', messageId: 1103 });
    // M6：notice 不再是"not-message 垃圾帧"，而是被事件管线收下并计数（不投给宿主）
    napcat.sendNotice();
    // M4.1 起图片是能投递的，这里改用语音段验证"真不支持的媒体"仍然零投递
    napcat.sendVoiceOnly({ messageId: 1104 });
    napcat.sendEchoResponse({ echo: 'qqgw-1' });
    await delay(200);
    assert.equal(fake.calls.prompt.length, promptsBefore, '一个都不许投给宿主');
    const delta = (k) => (gw.counters.dropped[k] ?? 0) - (droppedBefore[k] ?? 0);
    assert.equal(delta('wrong-user'), 1);
    assert.equal(delta('wrong-self'), 1);
    assert.equal(delta('group-no-mention'), 1);
    assert.equal(delta('not-message'), 0, 'M6 起 notice 走事件管线，不再记 not-message');
    assert.equal(gw.counters.notices - noticesBefore, 1, 'notice 帧应被事件管线收下');
    assert.equal(delta('empty-text'), 1);
    assert.equal(delta('action-response'), 1);
    return '5 帧挡 + notice 计入事件';
  });

  await checkAsync('去重：同 message_id 第二帧不重复投递', async () => {
    const base = fake.calls.prompt.length;
    // M2 起这里必须等"本回合自己的回传"落地：媒体回执也会往 replies() 里加东西，
    // 用 >=2 这种宽松条件会在回执还没到时提前返回，把后面的基线带偏。
    const repliesBefore = napcat.replies().length;
    napcat.sendPrivate({ text: '重复消息', messageId: 1201 });
    await waitFor(() => fake.calls.prompt.length === base + 1, { label: 'first prompt' });
    napcat.sendPrivate({ text: '重复消息', messageId: 1201 });
    await delay(120);
    assert.equal(fake.calls.prompt.length, base + 1, '重复帧不该再投');
    assert.equal(gw.counters.dedupeHits, 1);
    const t = fake.startTurnFor(fake.calls.prompt[base].requestId, { replyText: '去重轮的回复' });
    await t.done;
    await waitFor(() => napcat.replies().length === repliesBefore + 1, { label: 'dedupe turn reply' });
    return `dedupeHits=${gw.counters.dedupeHits}`;
  });

  await checkAsync('非阻塞 + 单飞：收帧立刻投递，turn 在跑时新消息只排队', async () => {
    const base = fake.calls.prompt.length;
    const repliesBefore = napcat.replies().length;
    const t0 = Date.now();
    napcat.sendPrivate({ text: '串行 A', messageId: 1301 });
    await waitFor(() => fake.calls.prompt.length === base + 1, { label: 'prompt A' });
    const ackMs = Date.now() - t0;

    const turnA = fake.startTurnFor(fake.calls.prompt[base].requestId, { replyText: 'A 的回复', stepMs: 25 });
    await delay(80);
    assert.equal(gw.status().busy, true, 'A 应在飞');
    napcat.sendEchoResponse({ echo: 'during-turn' });
    napcat.sendPrivate({ text: '串行 B', messageId: 1302 });
    await delay(60);
    const during = gw.status();
    assert.equal(fake.calls.prompt.length, base + 1, '单飞：A 没结束不许投 B');
    assert.equal(during.queueDepth, 1, `B 应在队列里，实际 queueDepth=${during.queueDepth}`);
    assert.ok(gw.counters.dropped['action-response'] >= 2, 'turn 进行中的 echo 帧也要被丢');

    await turnA.done;
    await waitFor(() => fake.calls.prompt.length === base + 2, { label: 'prompt B after A' });
    const gapMs = Date.now() - t0;
    assert.ok(ackMs < 200, `收帧到投递应很快，实际 ${ackMs}ms`);
    assert.ok(gapMs > 250, `B 必须等 A 结束，实际 ${gapMs}ms`);
    const turnB = fake.startTurnFor(fake.calls.prompt[base + 1].requestId, { replyText: 'B 的回复' });
    await turnB.done;
    await waitFor(() => napcat.replies().length === repliesBefore + 2, { label: 'two more replies' });
    const texts = napcat.replies().slice(-2).map((r) => r.params.message);
    assert.deepEqual(texts, ['A 的回复', 'B 的回复'], '顺序不许乱');
    return `A 收帧→投递 ${ackMs}ms，B 等了 ${gapMs}ms，顺序 A→B`;
  });

  await checkAsync('中断：turn/end=aborted 的 own turn 不回传', async () => {
    const before = napcat.replies().length;
    const skippedBefore = gw.counters.skippedAborted;
    const base = fake.calls.prompt.length;
    napcat.sendPrivate({ text: '会被打断', messageId: 1401 });
    await waitFor(() => fake.calls.prompt.length === base + 1, { label: 'prompt for aborted turn' });
    const t = fake.startTurnFor(fake.calls.prompt[base].requestId, { replyText: '不该出去的回复', abortKind: 'user' });
    await t.done;
    await delay(80);
    assert.equal(napcat.replies().length, before);
    assert.equal(gw.counters.skippedAborted, skippedBefore + 1);
    return `skippedAborted=${gw.counters.skippedAborted}`;
  });

  await checkAsync('假宿主够严：未知方法要炸、少传 signal 要炸、同 requestId 幂等', async () => {
    assert.throws(() => fake.ctx.sessionController.noSuchMethod(), /unknown sessionController method/);
    await assert.rejects(
      () => fake.ctx.sessionController.prompt({ requestId: 'x', sessionId: SESSION, mode: 'queue', content: [{ type: 'text', text: 'hi' }] }),
      /throwIfAborted/,
    );
    const first = await fake.ctx.sessionController.prompt(
      { requestId: 'idem-1', sessionId: SESSION, mode: 'queue', content: [{ type: 'text', text: 'hi' }] },
      new AbortController().signal,
    );
    const second = await fake.ctx.sessionController.prompt(
      { requestId: 'idem-1', sessionId: SESSION, mode: 'queue', content: [{ type: 'text', text: 'hi' }] },
      new AbortController().signal,
    );
    assert.deepEqual(first, { accepted: true });
    assert.deepEqual(second, { accepted: true });
    return '严格模式生效';
  });

  await checkAsync('状态端点数据齐全（M3 要用的那些计数）', async () => {
    const st = gw.status();
    for (const key of ['peers', 'busy', 'queueDepth', 'inFlightRids', 'tokenConfigured', 'counters']) {
      assert.ok(key in st, `status.${key} 缺失`);
    }
    // M2 起：发给 QQ 的私聊消息 = 回合回复 + 媒体回执，两者分开计数
    assert.equal(
      st.counters.relayed + st.counters.unsupportedNotified,
      napcat.replies().length,
      '回传条数 = 回合回复 + 媒体回执',
    );
    assert.equal(st.counters.skippedForeign, 2);
    return `relayed=${st.counters.relayed} skippedForeign=${st.counters.skippedForeign} inbound=${st.counters.inboundFrames}`;
  });
} finally {
  if (napcat) await napcat.close();
  await gw.stop();
}

const failed = results.filter((r) => !r.ok);
const evidence = {
  milestone: 'M1',
  kind: '假 NapCat + 假宿主 离线往返',
  at: new Date().toISOString(),
  node: process.version,
  config: { ...cfgBase, token: '<redacted>' },
  totals: { assertions: results.length, passed: results.length - failed.length, failed: failed.length },
  assertions: results,
  counters: gw.counters,
  gatewayLogs: gwLogs,
};
writeFileSync(join(ROOT, 'm1-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length) {
  for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
}
console.log('日志：');
for (const l of gwLogs) console.log(`  gw: ${l}`);
console.log(`证据：${join(ROOT, 'm1-evidence.json')}`);
process.exitCode = failed.length ? 1 : 0;
