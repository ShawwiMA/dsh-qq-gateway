// M2 离线验收：防回环收口 + 队列硬化。
// 覆盖：媒体回执（含节流/去重/空白文本）、turn 超时与迟到归属、断线补发、溢出丢最旧、token 轮换、状态字段。
// 跑法：node ~/.dsh/bundles/dsh-qq-gateway/test/m2-run.mjs
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { createFakeDsh } from './fake-dsh.mjs';
import { connectFakeNapCat, expectReject } from './fake-napcat.mjs';
import { createGateway, normalizeConfig } from '../lib/gateway/gateway.js';
import { DROP, analyzeMessage, parseInbound } from '../lib/gateway/protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const MAIN_QQ = 10001;
const BOT_QQ = 10002;
const TOKEN = 'm2-test-token';
const PATH = '/onebot';
const SESSION = 'session-fake-target';

const results = [];
const scenarioCounters = {};

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

/** M5 起投给宿主的文本首块前面带一行来源说明；断言正文时剥掉它。 */
function bodyOf(call) {
  const text = call?.request?.content?.[0]?.text ?? '';
  const sep = text.indexOf('\n\n');
  return sep === -1 ? text : text.slice(sep + 2);
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
  unsupportedNoticeIntervalMs: 3000,
};

/** 起一套「假 NapCat 可连 + 假宿主」的网关。 */
async function boot({ config = {}, now } = {}) {
  const fake = createFakeDsh({ sessionId: SESSION });
  fake.emitSeed();
  const logs = [];
  const gw = createGateway({ ctx: fake.ctx, config: { ...cfgBase, ...config }, logger: (m) => logs.push(m), now });
  await gw.start();
  const url = `ws://127.0.0.1:${gw.port()}${PATH}`;
  // 每个 env 一份独立计数快照，用现有快照数取名，避免互相覆盖
  const seq = Object.keys(scenarioCounters).length + 1;
  const env = {
    fake,
    gw,
    logs,
    url,
    async connect(token = gw.config.token) {
      const nc = await connectFakeNapCat({ url, token, botQQ: BOT_QQ, mainQQ: MAIN_QQ });
      await waitFor(() => gw.status().peers >= 1, { label: 'peer registered' });
      return nc;
    },
    /** 收到帧就正常回一个回合；返回该回合的回复文本 */
    async answer(index, replyText, { stepMs = 5 } = {}) {
      const call = env.fake.calls.prompt[index];
      const turn = env.fake.startTurnFor(call.requestId, { replyText, stepMs });
      await turn.done;
      return turn;
    },
    async close() {
      await gw.stop();
      scenarioCounters[`scenario-${seq}`] = { ...gw.counters };
    },
  };
  return env;
}

console.log('=== M2：单元断言（纯逻辑） ===');

await check('analyzeMessage：文本/图片/语音/图文混合 分类正确', () => {
  assert.deepEqual(analyzeMessage([{ type: 'text', data: { text: ' hi ' } }]), { text: 'hi', media: [] });
  assert.deepEqual(analyzeMessage([{ type: 'image', data: { file: 'a.png' } }]), { text: '', media: ['image'] });
  assert.deepEqual(analyzeMessage([{ type: 'text', data: {} }, { type: 'image', data: {} }]).media, ['image']);
  assert.deepEqual(analyzeMessage([{ type: 'record', data: {} }, { type: 'face', data: { id: 1 } }]).media, ['record', 'face']);
  assert.deepEqual(analyzeMessage('  纯字符串  '), { text: '纯字符串', media: [] });
  assert.deepEqual(analyzeMessage(undefined), { text: '', media: [] });
});

await check('parseInbound：图片帧放行（M4.1 起图片可投递），语音帧仍按媒体丢弃', () => {
  const frame = {
    post_type: 'message', message_type: 'private', user_id: MAIN_QQ, self_id: BOT_QQ,
    message_id: 77, message: [{ type: 'image', data: { file: 'a.png' } }],
  };
  const image = parseInbound(frame, cfgBase);
  assert.equal(image.ok, true);
  assert.deepEqual(image.msg.images, [{ file: 'a.png', url: '', summary: '' }]);
  assert.deepEqual(image.msg.media, [], '图片不算不支持的媒体');

  const voice = parseInbound({ ...frame, message: [{ type: 'record', data: {} }] }, cfgBase);
  assert.equal(voice.ok, false);
  assert.equal(voice.reason, DROP.EMPTY_TEXT);
  assert.deepEqual(voice.media, ['record']);
  assert.equal(voice.messageId, '77');

  const blank = parseInbound({ ...frame, message: [{ type: 'text', data: { text: '   ' } }] }, cfgBase);
  assert.equal(blank.reason, DROP.EMPTY_TEXT);
  assert.deepEqual(blank.media, [], '空白文本没有媒体段 → 不该触发回执');
});

await check('normalizeConfig：M2 新字段默认值/覆盖/非法值', () => {
  const d = normalizeConfig({});
  assert.equal(d.unsupportedReply, '目前仅支持文本消息');
  assert.equal(d.unsupportedNoticeIntervalMs, 3000);
  assert.equal(d.offlineBufferMax, 32);
  const o = normalizeConfig({ unsupportedReply: '', unsupportedNoticeIntervalMs: 0, offlineBufferMax: 0 });
  assert.equal(o.unsupportedReply, '', '置空 = 关闭媒体回执');
  assert.equal(o.unsupportedNoticeIntervalMs, 0);
  assert.throws(() => normalizeConfig({ offlineBufferMax: -1 }), /offlineBufferMax/);
  assert.throws(() => normalizeConfig({ turnTimeoutMs: 'abc' }), /turnTimeoutMs/);
  assert.throws(() => normalizeConfig({ deliveryMode: 'turbo' }), /deliveryMode/);
});

console.log('\n=== M2：媒体回执（图文/语音不再石沉大海） ===');

async function scenarioMedia() {
  const clock = { t: 1_700_000_000_000 };
  const env = await boot({ now: () => clock.t });
  let nc = null;
  try {
    nc = await env.connect();

    await check('媒体回执：纯语音 → 回「目前仅支持文本消息」，不投宿主、不占回合', async () => {
      nc.sendVoiceOnly({ messageId: 2001 });
      await waitFor(() => nc.replies().length === 1, { label: 'media notice' });
      const notice = nc.replies()[0];
      assert.equal(notice.action, 'send_private_msg');
      assert.equal(notice.params.message, '目前仅支持文本消息');
      assert.equal(notice.params.user_id, MAIN_QQ, '回执发给主号');
      assert.equal(env.fake.calls.prompt.length, 0, '不支持的媒体不该投给宿主');
      assert.equal(env.gw.counters.unsupportedNotified, 1);
      assert.equal(env.gw.counters.dropped['empty-text'], 1);
      assert.equal(env.gw.status().busy, false, '回执不占单飞闸门');
      assert.equal(env.gw.status().queueDepth, 0);
      return `notice="${notice.params.message}"`;
    });

    await check('媒体回执：语音同样回执；节流窗口内不重复回', async () => {
      nc.sendVoiceOnly({ messageId: 2002 });
      await delay(150);
      assert.equal(nc.replies().length, 1, '节流窗口内不许再回');
      assert.equal(env.gw.counters.unsupportedNoticeSuppressed, 1);
      assert.equal(env.gw.counters.dropped['empty-text'], 2);
      return `suppressed=${env.gw.counters.unsupportedNoticeSuppressed}`;
    });

    await check('媒体回执：同 message_id 重发不重复回执', async () => {
      nc.sendVoiceOnly({ messageId: 2001 });
      await delay(150);
      assert.equal(nc.replies().length, 1);
      assert.equal(env.gw.counters.dedupeHits, 1);
      assert.equal(env.gw.counters.dropped['empty-text'], 3);
      return `dedupeHits=${env.gw.counters.dedupeHits}`;
    });

    await check('媒体回执：节流窗口过去后可以再回一条', async () => {
      clock.t += 3001;
      nc.sendVoiceOnly({ messageId: 2003 });
      await waitFor(() => nc.replies().length === 2, { label: 'second notice' });
      assert.equal(env.gw.counters.unsupportedNotified, 2);
      return 'notified=2';
    });

    await check('空白文本不回执（别刷屏），但照样不投宿主', async () => {
      clock.t += 3001;
      nc.sendBlankText({ messageId: 2004 });
      await delay(150);
      assert.equal(nc.replies().length, 2, '空白文本不是"发不出文本"，不该回执');
      assert.equal(env.gw.counters.dropped['empty-text'], 5, '5 条无正文帧：语音×3 + 重复语音 + 空白文本');
      assert.equal(env.fake.calls.prompt.length, 0);
      return `dropped.empty-text=${env.gw.counters.dropped['empty-text']}`;
    });

    await check('文本+语音混合：有正文就正常投递（语音段忽略），不触发媒体回执', async () => {
      const before = env.fake.calls.prompt.length;
      nc.sendSegments({
        segments: [{ type: 'text', data: { text: '看图' } }, { type: 'record', data: { file: 'v.amr' } }],
        messageId: 2005,
      });
      await waitFor(() => env.fake.calls.prompt.length === before + 1, { label: 'mixed prompt' });
      const mixedCall = env.fake.calls.prompt[before];
      assert.equal(mixedCall.request.content.length, 1);
      assert.match(mixedCall.request.content[0].text, /^【QQ私聊】主号：/);
      assert.equal(bodyOf(mixedCall), '看图');
      await env.answer(before, '混合消息的回复');
      await waitFor(() => nc.replies().length === 3, { label: 'relay for mixed' });
      assert.equal(nc.replies()[2].params.message, '混合消息的回复');
      assert.equal(env.gw.counters.unsupportedNotified, 2, '混合消息不该产生回执');
      return `relayed=${env.gw.counters.relayed}`;
    });

    await check('红线回归：媒体回执不影响 L3（GUI 回合仍零回传）', async () => {
      const before = nc.replies().length;
      const skipped = env.gw.counters.skippedForeign;
      const turn = env.fake.guiTurn({ rid: `gui-media-${Date.now()}`, replyText: 'GUI 的话不该出去', stepMs: 5 });
      await turn.done;
      await delay(80);
      assert.equal(nc.replies().length, before);
      assert.equal(env.gw.counters.skippedForeign, skipped + 1);
      assert.equal(env.gw.counters.relayed + env.gw.counters.unsupportedNotified, nc.replies().length);
      return `relayed=${env.gw.counters.relayed} notified=${env.gw.counters.unsupportedNotified}`;
    });
  } finally {
    if (nc) await nc.close();
    await env.close();
  }
}

console.log('\n=== M2：turn 超时与迟到归属 ===');

async function scenarioTimeout() {
  const env = await boot({ config: { turnTimeoutMs: 800 } });
  let nc = null;
  try {
    nc = await env.connect();

    await check('超时：投递后没有 turn/end → 记 timeouts、不推 QQ、放开单飞闸门让队列继续', async () => {
      nc.sendPrivate({ text: '不会有人回答的消息', messageId: 3001 });
      await waitFor(() => env.fake.calls.prompt.length === 1, { label: 'prompt 1' });
      nc.sendPrivate({ text: '排队等着的第二条', messageId: 3002 });
      await waitFor(() => env.gw.status().queueDepth === 1, { label: 'second queued' });

      const t0 = Date.now();
      await waitFor(() => env.gw.counters.timeouts === 1, { label: 'timeout', timeoutMs: 3000 });
      const ms = Date.now() - t0;
      assert.ok(ms >= 700 && ms < 2500, `超时应≈800ms，实际 ${ms}ms`);
      assert.equal(nc.replies().length, 0, '超时不推 QQ');
      assert.equal(env.gw.status().timedOutRids, 1, '超时的 rid 进 timedOut 集合备查');
      // 闸门没放开的话，排队那条永远不会被投出去（变异测试钉的就是这条）
      assert.equal(env.gw.status().queueDepth, 0, '超时那一刻排队的那条应该已经被自动放出来');

      await waitFor(() => env.fake.calls.prompt.length === 2, { label: 'prompt 2 auto-released' });
      assert.equal(bodyOf(env.fake.calls.prompt[1]), '排队等着的第二条');
      return `timeout ${ms}ms，队列自动继续`;
    });

    await check('超时不影响后续回合：第二条的回复正常回传，闸门回到空闲', async () => {
      await env.answer(1, '第二条的回复');
      await waitFor(() => nc.replies().length === 1, { label: 'relay after timeout' });
      assert.equal(nc.replies()[0].params.message, '第二条的回复');
      assert.equal(env.gw.counters.relayed, 1);
      assert.equal(env.gw.status().busy, false, '回合结束后闸门要空出来');
      assert.equal(env.gw.status().inFlightRids, 0, '在飞集合要清空');
      return `relayed=${env.gw.counters.relayed}`;
    });

    await check('超时回合迟到回来：认出来但不回传（skippedTimeoutLate）', async () => {
      const rid1 = env.fake.calls.prompt[0].requestId;
      const turn = env.fake.startTurnFor(rid1, { replyText: '迟到的回复不该出去', stepMs: 5 });
      await turn.done;
      await delay(80);
      assert.equal(env.gw.counters.skippedTimeoutLate, 1);
      assert.equal(env.gw.counters.skippedForeign, 0, '不许把超时回合误判成外来回合');
      assert.equal(nc.replies().length, 1, '迟到回复不回传');
      return `skippedTimeoutLate=${env.gw.counters.skippedTimeoutLate}`;
    });
  } finally {
    if (nc) await nc.close();
    await env.close();
  }

  // 真实宿主形态：user/message 早于超时就已经到了（tracker 里已经躺着我们的 rid）
  const env2 = await boot({ config: { turnTimeoutMs: 400 } });
  let nc2 = null;
  try {
    nc2 = await env2.connect();
    await check('超时（真机形态）：user/message 早到、turn/end 迟到 → 只记 timeout，迟到产出零回传', async () => {
      nc2.sendPrivate({ text: '慢回合', messageId: 3003 });
      await waitFor(() => env2.fake.calls.prompt.length === 1, { label: 'prompt' });
      const rid = env2.fake.calls.prompt[0].requestId;
      // 每步 120ms：user/message 在 ~720ms 到达，超时 400ms 先触发，turn/end 在 ~1.6s 才到
      const turn = env2.fake.startTurnFor(rid, { replyText: '慢回合的产出不该出去', stepMs: 120 });
      await waitFor(() => env2.gw.counters.timeouts === 1, { label: 'timeout while turn runs', timeoutMs: 2000 });
      assert.equal(nc2.replies().length, 0);
      await turn.done;
      await delay(80);
      assert.equal(env2.gw.counters.skippedTimeoutLate, 1, '迟到的 turn/end 要归到 timeout 账上');
      assert.equal(env2.gw.counters.skippedForeign, 0);
      assert.equal(env2.gw.counters.relayed, 0);
      assert.equal(nc2.replies().length, 0, '迟到的产出一条都不许出去');
      assert.equal(env2.gw.status().timedOutRids, 0, '对完账就该把 timedOut rid 消费掉');
      return `timeouts=${env2.gw.counters.timeouts} late=${env2.gw.counters.skippedTimeoutLate}`;
    });
  } finally {
    if (nc2) await nc2.close();
    await env2.close();
  }
}

console.log('\n=== M2：断线重连与补发缓冲 ===');

async function scenarioOffline() {
  const env = await boot({ config: { turnTimeoutMs: 8000 } });
  let nc = null;
  let nc2 = null;
  try {
    nc = await env.connect();

    await check('断线补发：断线期间产生的回传先进缓冲，不丢', async () => {
      nc.sendPrivate({ text: '断线期间的问题', messageId: 4001 });
      await waitFor(() => env.fake.calls.prompt.length === 1, { label: 'prompt' });
      await nc.close();
      await waitFor(() => env.gw.status().peers === 0, { label: 'peer gone' });
      await env.answer(0, '断线期间的回复');
      await waitFor(() => env.gw.counters.relayed === 1, { label: 'relayed' });
      assert.equal(env.gw.status().offlineBufferDepth, 1, '发不出去的回传必须进缓冲');
      assert.equal(env.gw.counters.offlineBuffered, 1);
      assert.equal(env.gw.counters.sendFailures, 1);
      return `buffered=${env.gw.counters.offlineBuffered} depth=${env.gw.status().offlineBufferDepth}`;
    });

    await check('断线期间红线不松：外来回合照样零补发', async () => {
      const depth = env.gw.status().offlineBufferDepth;
      const skipped = env.gw.counters.skippedForeign;
      const turn = env.fake.hostContinuationTurn({ replyText: '宿主自己续跑的，不许补发', stepMs: 5 });
      await turn.done;
      await delay(80);
      assert.equal(env.gw.status().offlineBufferDepth, depth, '外来回合不许进补发缓冲');
      assert.equal(env.gw.counters.skippedForeign, skipped + 1);
      return `skippedForeign=${env.gw.counters.skippedForeign}`;
    });

    await check('重连：缓冲的回传自动补齐，且只补一次', async () => {
      nc2 = await env.connect();
      await waitFor(() => env.gw.counters.offlineFlushed === 1, { label: 'flushed' });
      await waitFor(() => nc2.replies().length === 1, { label: 'backfilled reply' });
      assert.equal(nc2.replies()[0].params.message, '断线期间的回复');
      assert.equal(nc2.replies()[0].params.user_id, MAIN_QQ);
      assert.equal(env.gw.status().offlineBufferDepth, 0);
      await delay(120);
      assert.equal(nc2.replies().length, 1, '补发不许重复');
      return `flushed=${env.gw.counters.offlineFlushed}`;
    });

    await check('重连后链路照常：新消息正常往返', async () => {
      const base = env.fake.calls.prompt.length;
      nc2.sendPrivate({ text: '重连之后的新消息', messageId: 4002 });
      await waitFor(() => env.fake.calls.prompt.length === base + 1, { label: 'prompt after reconnect' });
      await env.answer(base, '重连后的回复');
      await waitFor(() => nc2.replies().length === 2, { label: 'reply after reconnect' });
      assert.equal(nc2.replies()[1].params.message, '重连后的回复');
      return `relayed=${env.gw.counters.relayed}`;
    });
  } finally {
    if (nc2) await nc2.close();
    await env.close();
  }
}

console.log('\n=== M2：有界队列溢出丢最旧 ===');

async function scenarioOverflow() {
  // 2026-10-26 安全升级：这里只测队列溢出，显式关掉连发合并（默认 1500ms 会把同人连发并成一条）
  const env = await boot({ config: { maxQueue: 2, turnTimeoutMs: 8000, burstMergeMs: 0 } });
  let nc = null;
  try {
    nc = await env.connect();

    await check('溢出：队列压到上限，丢的条数记账', async () => {
      nc.sendPrivate({ text: '第1条', messageId: 5001 });
      await waitFor(() => env.fake.calls.prompt.length === 1, { label: 'prompt 1 (busy)' });
      for (const [i, id] of [[2, 5002], [3, 5003], [4, 5004], [5, 5005]]) {
        nc.sendPrivate({ text: `第${i}条`, messageId: id });
      }
      await waitFor(() => env.gw.counters.overflowDropped === 2, { label: 'overflow' });
      const st = env.gw.status();
      assert.equal(st.queueDepth, 2, `队列应被压到上限 2，实际 ${st.queueDepth}`);
      assert.equal(st.config.maxQueue, 2);
      assert.equal(env.fake.calls.prompt.length, 1, '在飞回合没结束前不许投新的');
      return `queueDepth=2 overflowDropped=2`;
    });

    await check('溢出丢的是最旧的：实际投递顺序 = 第1、第4、第5条', async () => {
      const texts = [];
      for (let i = 0; i < 3; i += 1) {
        const { value: call } = await waitFor(() => env.fake.calls.prompt[i], { label: `prompt ${i}` });
        const body = bodyOf(call);
        texts.push(body);
        await env.answer(i, `${body} 的回复`);
      }
      assert.deepEqual(texts, ['第1条', '第4条', '第5条'], '第2、3条应被丢弃');
      await waitFor(() => nc.replies().length === 3, { label: 'three replies' });
      const replyTexts = nc.replies().map((r) => r.params.message);
      assert.deepEqual(replyTexts, ['第1条 的回复', '第4条 的回复', '第5条 的回复']);
      return texts.join(' → ');
    });
  } finally {
    if (nc) await nc.close();
    await env.close();
  }
}

console.log('\n=== M2：token 轮换 ===');

async function scenarioToken() {
  const env = await boot({ config: { turnTimeoutMs: 8000 } });
  let nc = null;
  let nc2 = null;
  try {
    nc = await env.connect(TOKEN);

    await check('token 轮换：旧 token 立刻 401；单 peer 下新 token 要等旧连接断开', async () => {
      assert.equal(env.gw.setToken('m2-rotated'), 'm2-rotated');
      assert.equal(env.gw.counters.tokenRotations, 1);
      const bad = await expectReject({ url: env.url, token: TOKEN });
      assert.equal(bad.rejected, true, `旧 token 应被拒，实际 ${bad.reason}`);
      assert.match(bad.reason, /401/);
      // 2026-10-26 安全升级：网关只保留一条 peer，旧连接还在时新 token 也连不进来
      const blocked = await env.connect('m2-rotated');
      await waitFor(() => blocked.closed === true, { label: 'second peer rejected' });
      assert.equal(env.gw.status().peers, 1, '单 peer：旧连接不能被新连接替换');
      assert.ok(env.gw.counters.extraPeers >= 1, '多余连接要被记账');
      // 旧连接正常断开后，新 token 才能建立唯一的那条连接
      await nc.close();
      nc = null;
      await waitFor(() => env.gw.status().peers === 0, { label: 'old peer gone' });
      nc2 = await env.connect('m2-rotated');
      assert.equal(env.gw.status().peers, 1, '断开后新连接应成为唯一 peer');
      return 'old → 401，单 peer 拒绝并发，断开后 new → 连上';
    });

    await check('轮换之后链路照常往返', async () => {
      nc2.sendPrivate({ text: '轮换之后', messageId: 6001 });
      await waitFor(() => env.fake.calls.prompt.length === 1, { label: 'prompt after rotation' });
      await env.answer(0, '轮换后的回复');
      await waitFor(() => nc2.replies().length === 1, { label: 'reply after rotation' });
      assert.equal(nc2.replies()[0].params.message, '轮换后的回复');
      return `tokenRotations=${env.gw.counters.tokenRotations}`;
    });
  } finally {
    if (nc2) await nc2.close();
    if (nc) await nc.close();
    await env.close();
  }

  const env2 = await boot({ config: { token: '', turnTimeoutMs: 8000 } });
  let c1 = null;
  let c2 = null;
  try {
    await check('空 token：启动留警告、谁都能连；setToken 之后立刻开始要 token', async () => {
      c1 = await env2.connect('');
      assert.equal(env2.gw.status().tokenConfigured, false);
      assert.ok(env2.logs.some((l) => l.includes('accepts any client')), '启动时要留警告日志');
      env2.gw.setToken('fresh-token');
      assert.equal(env2.gw.status().tokenConfigured, true);
      const bad = await expectReject({ url: env2.url, token: '' });
      assert.equal(bad.rejected, true, `setToken 之后无 token 必须被拒，实际 ${bad.reason}`);
      // 单 peer：空 token 期间连着的那条要先断开，新 token 才能接管
      await c1.close();
      c1 = null;
      await waitFor(() => env2.gw.status().peers === 0, { label: 'old peer gone (empty token)' });
      c2 = await env2.connect('fresh-token');
      assert.equal(env2.gw.status().peers, 1);
      return 'warning + 轮换生效';
    });
  } finally {
    if (c2) await c2.close();
    if (c1) await c1.close();
    await env2.close();
  }
}

console.log('\n=== M2：状态字段 ===');

async function scenarioStatus() {
  const env = await boot({});
  let nc = null;
  try {
    nc = await env.connect();
    await check('状态端点：M2 新增字段齐全，计数自洽', async () => {
      nc.sendVoiceOnly({ messageId: 7001 });
      await waitFor(() => nc.replies().length === 1, { label: 'notice' });
      const st = env.gw.status();
      for (const key of ['state', 'peers', 'busy', 'queueDepth', 'offlineBufferDepth', 'inFlightRids', 'timedOutRids', 'openTurns', 'tokenConfigured', 'counters']) {
        assert.ok(key in st, `status.${key} 缺失`);
      }
      for (const key of ['unsupportedNotified', 'unsupportedNoticeSuppressed', 'offlineBuffered', 'offlineFlushed', 'offlineDropped', 'skippedTimeoutLate', 'tokenRotations', 'overflowDropped', 'timeouts']) {
        assert.equal(typeof st.counters[key], 'number', `counters.${key} 缺失`);
      }
      assert.equal(st.counters.relayed + st.counters.unsupportedNotified, nc.replies().length);
      assert.equal(st.config.unsupportedReply, '目前仅支持文本消息');
      assert.equal(st.config.offlineBufferMax, 32);
      assert.equal(st.config.unsupportedNoticeIntervalMs, 3000);
      return `relayed=${st.counters.relayed} notified=${st.counters.unsupportedNotified} depth=${st.offlineBufferDepth}`;
    });
  } finally {
    if (nc) await nc.close();
    await env.close();
  }
}

console.log('\n=== M2：连接清理（半开断线不留僵尸） ===');

async function scenarioZombiePeer() {
  const env = await boot({ config: { turnTimeoutMs: 8000 } });
  try {
    await check('客户端直接断 TCP（不发 WS close）：peers 归零', async () => {
      const nc = await env.connect();
      assert.equal(env.gw.status().peers, 1);
      nc.peer.socket.destroy();
      await waitFor(() => env.gw.status().peers === 0, { timeoutMs: 3000, label: 'peer cleaned' });
      return `peers=${env.gw.status().peers}`;
    });

    await check('连续 3 次直接断线：每次 peers 都归零（无累积）', async () => {
      for (let i = 1; i <= 3; i += 1) {
        const nc = await env.connect();
        assert.equal(env.gw.status().peers, 1, `第 ${i} 次连接后 peers 应为 1`);
        nc.peer.socket.destroy();
        await waitFor(() => env.gw.status().peers === 0, { timeoutMs: 3000, label: `第 ${i} 次清理` });
      }
      assert.equal(env.gw.status().peers, 0);
      return `connections=${env.gw.counters.connections}`;
    });

    await check('断线风暴后仍可重连，且正常往返', async () => {
      const base = env.fake.calls.prompt.length;
      const nc = await env.connect();
      assert.equal(env.gw.status().peers, 1);
      nc.sendPrivate({ text: '断线风暴之后还活着吗', messageId: 5001 });
      await waitFor(() => env.fake.calls.prompt.length === base + 1, { label: 'prompt' });
      await env.answer(base, '还活着');
      await waitFor(() => nc.replies().length === 1, { label: 'reply' });
      assert.equal(nc.replies()[0].params.message, '还活着');
      await nc.close();
      await waitFor(() => env.gw.status().peers === 0, { label: 'clean close' });
      return `relayed=${env.gw.counters.relayed}`;
    });
  } finally {
    await env.close();
  }
}

const scenarios = [
  ['媒体回执', scenarioMedia],
  ['turn 超时', scenarioTimeout],
  ['断线重连', scenarioOffline],
  ['连接清理', scenarioZombiePeer],
  ['队列溢出', scenarioOverflow],
  ['token 轮换', scenarioToken],
  ['状态字段', scenarioStatus],
];

for (const [label, fn] of scenarios) {
  try {
    await fn();
  } catch (err) {
    record(`${label}：场景本身崩了`, false, err?.stack ?? String(err));
  }
}

const failed = results.filter((r) => !r.ok);
const evidence = {
  milestone: 'M2',
  kind: '防回环收口 + 队列硬化（离线）',
  at: new Date().toISOString(),
  node: process.version,
  config: { ...cfgBase, token: '<redacted>' },
  totals: { assertions: results.length, passed: results.length - failed.length, failed: failed.length },
  assertions: results,
  scenarioCounters,
};
writeFileSync(join(ROOT, 'm2-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
console.log(`证据：${join(ROOT, 'm2-evidence.json')}`);
process.exitCode = failed.length ? 1 : 0;
