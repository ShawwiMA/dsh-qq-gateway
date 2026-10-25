// M7 验收（离线）：拟人延迟真的把"自动回传"推后了，且顺序不乱。
// 跑法：node test/human-delay-live.mjs
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import { createFakeDsh } from './fake-dsh.mjs';
import { connectFakeNapCat } from './fake-napcat.mjs';
import { createGateway } from '../lib/gateway/gateway.js';
import { createQqTools } from '../lib/gateway/tools.js';
import { createReplyTimeline } from '../lib/gateway/human-delay.js';

const MAIN_QQ = 10001;
const BOT_QQ = 10002;
const TOKEN = 'm7-test-token';
const PATH = '/onebot';
const SESSION = 'session-fake-target';

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push(`FAIL  ${name} — ${err.message}`);
    process.exitCode = 1;
  }
}

async function waitFor(fn, { timeoutMs = 5000, label = 'condition', intervalMs = 5 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const value = fn();
    if (value) return { value, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout ${timeoutMs}ms waiting for ${label}`);
    await delay(intervalMs);
  }
}

// 固定 400ms 延迟：min=max=400、每字 0ms、长尾 0ms → 算出来必须是 400
const FIXED_DELAY_MS = 400;
async function boot(extraConfig = {}) {
  const fake = createFakeDsh({ sessionId: SESSION });
  fake.emitSeed();
  const logs = [];
  const gw = createGateway({
    ctx: fake.ctx,
    config: {
      host: '127.0.0.1', port: 0, path: PATH, token: TOKEN, mainQQ: MAIN_QQ, botQQ: BOT_QQ,
      sessionId: SESSION,
      replyDelayMode: 'human',
      replyDelayMinMs: FIXED_DELAY_MS,
      replyDelayMaxMs: FIXED_DELAY_MS,
      replyDelayPerCharMs: 0,
      replyDelayTailMs: 0,
      ...extraConfig,
    },
    logger: (m) => logs.push(m),
  });
  await gw.start();
  const nc = await connectFakeNapCat({ url: `ws://127.0.0.1:${gw.port()}${PATH}`, token: TOKEN, botQQ: BOT_QQ, mainQQ: MAIN_QQ });
  nc.startAutoRespond(); // 发消息类 action 自动回 { message_id }，否则会等满 sendTimeoutMs
  await waitFor(() => gw.status().peers === 1, { label: 'peer registered' });
  return { fake, gw, nc, logs };
}

await check('拟人延迟：回复不秒发，约 400ms 后才发出', async () => {
  const env = await boot();
  try {
    env.nc.sendPrivate({ text: '在吗', messageId: 6001 });
    const { value: call } = await waitFor(() => env.fake.calls.prompt[0], { label: 'prompt delivered' });
    const turn = env.fake.startTurnFor(call.requestId, { replyText: '在的', stepMs: 1 });
    await turn.done;
    const sentAt = Date.now();
    await waitFor(() => env.nc.replies().length === 1, { label: 'reply sent' });
    const waitedMs = Date.now() - sentAt;
    assert.ok(waitedMs >= FIXED_DELAY_MS - 80, `发得太快: ${waitedMs}ms < ${FIXED_DELAY_MS}ms`);
    assert.equal(env.nc.replies()[0].params.message, '在的');
    assert.ok(env.logs.some((line) => line.includes('reply delay')), '日志里没有延迟记录');
    return `等了 ${waitedMs}ms`;
  } finally {
    await env.gw.stop();
  }
});

await check('拟人延迟：关闭时立刻发（不回归旧行为）', async () => {
  const env = await boot({ replyDelayMode: 'off' });
  try {
    env.nc.sendPrivate({ text: '在吗', messageId: 6002 });
    const { value: call } = await waitFor(() => env.fake.calls.prompt[0], { label: 'prompt delivered' });
    const turn = env.fake.startTurnFor(call.requestId, { replyText: '在的', stepMs: 1 });
    await turn.done;
    const sentAt = Date.now();
    await waitFor(() => env.nc.replies().length === 1, { label: 'reply sent' });
    const waitedMs = Date.now() - sentAt;
    assert.ok(waitedMs < 200, `关了还在拖: ${waitedMs}ms`);
    return `等了 ${waitedMs}ms`;
  } finally {
    await env.gw.stop();
  }
});

await check('工具调用 qq_send 不受拟人延迟影响（明确指令该发就发）', async () => {
  const env = await boot();
  try {
    const tools = Object.fromEntries(
      createQqTools({ gateway: env.gw, config: env.gw.config, logger: () => {} }).map((def) => [def.name, def]),
    );
    assert.ok(tools.qq_send, '没拿到 qq_send 工具');
    const t0 = Date.now();
    await tools.qq_send.execute({ user_id: MAIN_QQ, text: '直接发' }, { agent: { id: SESSION } });
    // 工具是一次 OneBot action，直接出去，不该等
    await waitFor(() => env.nc.replies().length >= 1, { label: 'tool send' });
    const waitedMs = Date.now() - t0;
    assert.ok(waitedMs < 300, `工具发送被拖了: ${waitedMs}ms`);
    return `等了 ${waitedMs}ms`;
  } finally {
    await env.gw.stop();
  }
});

await check('多条回复顺序不乱（timeline 记账生效）', async () => {
  let clock = 10_000;
  const timeline = createReplyTimeline({ now: () => clock });
  const a = timeline.reserve(2000);
  const b = timeline.reserve(0); // 后算出来的短延迟不能抢跑
  assert.ok(b > a, `${b} 抢到了 ${a} 前面`);
  return `${a} < ${b}`;
});

console.log(results.join('\n'));
console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
