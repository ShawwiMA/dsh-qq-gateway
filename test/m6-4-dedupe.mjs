// M6.4 离线验收：修「同一条 QQ 消息回两遍」。
//
// 现象（2026-10-17 真机日志 m4-gateway.log turn 75-82）：
//   tool qq_send -> group ... message_id=xxx     ← 模型用工具发了一遍
//   relayed turn 75 (23 chars, text) to group    ← 回合结束又把助手文字自动回传了一遍
// 根因：出站有两条通道（工具显式发 + 助手文字自动回传），模型两条都用了就双发。
//
// 修法：本回合已经用 qq_send 往同一个对话发过带文字的消息 → 回合结束时不再自动回传。
// 纯图片/文件发送不算（发完图还想补一句解释，不该被吞）；rid 精确到回合，不误伤别的回合。
//
// 跑法：node ~/.dsh/bundles/dsh-qq-gateway/test/m6-2-dedupe.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { createFakeDsh } from './fake-dsh.mjs';
import { connectFakeNapCat } from './fake-napcat.mjs';
import { createGateway } from '../lib/gateway/gateway.js';
import { createQqTools } from '../lib/gateway/tools.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const MAIN_QQ = 10001;
const BOT_QQ = 10002;
const GROUP_ID = 123456;
const TOKEN = 'm6-2-token';
const PATH = '/onebot';
const SESSION = 'session-fake-target';

// 1x1 透明 PNG：qq_send 发图片要用真实文件
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TMP = mkdtempSync(join(tmpdir(), 'm6-2-qqgw-'));
const PNG_PATH = join(TMP, 'pic.png');
writeFileSync(PNG_PATH, Buffer.from(PNG_BASE64, 'base64'));

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

const baseConfig = {
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
};

/** 假 NapCat 自动应答：只回网关启动时会问的几个查询动作。 */
function responder(action) {
  switch (action.action) {
    case 'get_login_info':
      return { user_id: BOT_QQ, nickname: '测试小号' };
    case 'get_version_info':
      return { app_name: 'NapCat', app_version: '4.8.0' };
    default:
      return undefined;
  }
}

async function boot(extraConfig = {}) {
  const fake = createFakeDsh({ sessionId: SESSION });
  fake.emitSeed();
  const logs = [];
  const gw = createGateway({
    ctx: fake.ctx,
    config: { ...baseConfig, ...extraConfig },
    logger: (m) => logs.push(m),
  });
  await gw.start();
  const nc = await connectFakeNapCat({
    url: `ws://127.0.0.1:${gw.port()}${PATH}`,
    token: TOKEN,
    botQQ: BOT_QQ,
    mainQQ: MAIN_QQ,
  });
  nc.startAutoRespond(responder);
  await waitFor(() => gw.status().peers === 1, { label: 'peer registered' });
  const tools = Object.fromEntries(
    createQqTools({ gateway: gw, config: gw.config, logger: () => {} }).map((definition) => [definition.name, definition]),
  );
  return {
    fake,
    gw,
    nc,
    logs,
    tools,
    async stop() {
      await nc.close();
      await gw.stop();
    },
  };
}

const toolExec = { agent: { id: SESSION } };
const callTool = async (tools, name, args = {}, exec = toolExec) => tools[name].execute(args, exec);

async function sendAndGetPrompt(env, frameSender) {
  const before = env.fake.calls.prompt.length;
  frameSender();
  await waitFor(() => env.fake.calls.prompt.length === before + 1, { label: 'prompt' });
  return env.fake.calls.prompt[before];
}

async function answerPrompt(env, replyText = '收到') {
  const index = env.fake.calls.prompt.length - 1;
  const turn = env.fake.startTurnFor(env.fake.calls.prompt[index].requestId, { replyText, stepMs: 5 });
  await turn.done;
}

const textsOf = (actions) => actions.map((action) => (typeof action.params.message === 'string' ? action.params.message : '[富媒体]'));

console.log('=== M6.4：双通道去重（离线） ===');

const env = await boot();
try {
  await check('本回合已用 qq_send 发过文字 → 助手文字不再自动回传，QQ 端只收到 1 条', async () => {
    await sendAndGetPrompt(env, () => env.nc.sendPrivate({ text: '在吗', messageId: 6001 }));
    const sent = await callTool(env.tools, 'qq_send', { text: '在，说。' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    await answerPrompt(env, '在，说。');
    await delay(120);
    const replies = env.nc.replies();
    assert.equal(replies.length, 1, `本该只发 1 条，实际 ${replies.length} 条：${JSON.stringify(textsOf(replies))}`);
    assert.equal(replies[0].params.message, '在，说。');
    assert.equal(env.gw.counters.duplicateRepliesSuppressed, 1);
    assert.equal(env.gw.counters.relayed, 0);
    return 'tool send=1, relay=0';
  });

  await check('本回合没用工具发文字 → 助手文字照常回传（去重不误伤）', async () => {
    await sendAndGetPrompt(env, () => env.nc.sendPrivate({ text: '再问一句', messageId: 6002 }));
    await answerPrompt(env, '正常回传');
    await waitFor(() => env.nc.replies().length === 2, { label: 'relay' });
    assert.equal(env.nc.replies()[1].params.message, '正常回传');
    assert.equal(env.gw.counters.relayed, 1);
    assert.equal(env.gw.counters.duplicateRepliesSuppressed, 1, '这一回合不该再去重');
    return 'relay=1';
  });

  await check('工具只发图片（没有文字段） → 助手解释文字仍然回传（不吞正文）', async () => {
    await sendAndGetPrompt(env, () => env.nc.sendPrivate({ text: '发张图', messageId: 6003 }));
    const sent = await callTool(env.tools, 'qq_send', { image: PNG_PATH });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    await answerPrompt(env, '图来了，看一下');
    await waitFor(() => env.nc.replies().length === 4, { label: 'relay after media' });
    assert.equal(env.nc.replies()[2].params.message.constructor, Array, '第 3 条应该是富媒体消息段数组');
    assert.equal(env.nc.replies()[3].params.message, '图来了，看一下');
    assert.equal(env.gw.counters.duplicateRepliesSuppressed, 1, '纯图片不该触发去重');
    return 'media send + text relay 都保留';
  });

  await check('空闲时（没有在飞回合）用 qq_send 发消息，不影响后续回合回传', async () => {
    const sent = await callTool(env.tools, 'qq_send', { text: '空闲发的' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    await sendAndGetPrompt(env, () => env.nc.sendPrivate({ text: '接下来这句', messageId: 6004 }));
    await answerPrompt(env, '该回传这句');
    await waitFor(() => env.nc.replies().length === 6, { label: 'relay after idle send' });
    assert.equal(env.nc.replies()[5].params.message, '该回传这句');
    return 'idle 工具发送不参与去重';
  });

  await check('群聊同样去重（群号 number/string 两种形态能对上）', async () => {
    await sendAndGetPrompt(env, () => env.nc.sendGroup({ text: '群里的问题', messageId: 6005, groupId: GROUP_ID, mention: true }));
    const sent = await callTool(env.tools, 'qq_send', { text: '群里工具先回' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(sent.target.kind, 'group');
    await answerPrompt(env, '群里助手再回');
    await delay(120);
    const groupReplies = env.nc.groupReplies();
    assert.equal(groupReplies.length, 1, `群里本该只发 1 条，实际 ${groupReplies.length} 条：${JSON.stringify(textsOf(groupReplies))}`);
    assert.equal(groupReplies[0].params.message, '群里工具先回');
    assert.equal(env.gw.counters.duplicateRepliesSuppressed, 2);
    return 'group 双发已压掉';
  });

  await check('提示词写明去重规则（纯文字直接输出；已用 qq_send 发过文字时最终文字不再回传）', async () => {
    const call = env.fake.calls.prompt[env.fake.calls.prompt.length - 1];
    const text = call.request.content.map((part) => part.text ?? '').join('\n');
    assert.match(text, /纯文字直接输出即可回传/);
    assert.match(text, /最终文字不再自动回传/);
    return 'prompt hint ok';
  });
} finally {
  await env.stop();
}

// 对照组：关掉开关必须能复现旧的双发，证明修复点确实在去重逻辑上，而不是别处的副作用。
const offEnv = await boot({ relayDedupeMode: 'off' });
try {
  await check('relayDedupeMode=off：恢复旧行为（工具发一遍 + 助手文字再发一遍，能复现双发）', async () => {
    await sendAndGetPrompt(offEnv, () => offEnv.nc.sendPrivate({ text: '关掉去重试试', messageId: 6101 }));
    const sent = await callTool(offEnv.tools, 'qq_send', { text: '工具先回' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    await answerPrompt(offEnv, '助手再回');
    await waitFor(() => offEnv.nc.replies().length === 2, { label: 'both sends' });
    assert.deepEqual(textsOf(offEnv.nc.replies()), ['工具先回', '助手再回']);
    assert.equal(offEnv.gw.counters.duplicateRepliesSuppressed, 0);
    return '双发已复现（对照组）';
  });
} finally {
  await offEnv.stop();
}

const failed = results.filter((r) => !r.ok);
const evidence = {
  milestone: 'M6.4',
  kind: '双通道去重（工具发送 + 助手文字自动回传）',
  at: new Date().toISOString(),
  node: process.version,
  totals: { checks: results.length, passed: results.length - failed.length, failed: failed.length },
  results,
  counters: { duplicateRepliesSuppressed: env.gw.counters.duplicateRepliesSuppressed, relayed: env.gw.counters.relayed },
  rootCause: [
    '出站有两条通道：qq_send 工具显式发 + 回合结束 relayAssistantText 自动回传助手文字',
    '真机日志 turn 75-82 每回合都是 tool qq_send 紧接 relayed turn -> 用户看到两条',
  ],
  fix: [
    'sendMessage 给工具发送记账（只记带文字段的目标+rid），relay 前查本回合是否已发过',
    '命中则跳过自动回传并计 duplicateRepliesSuppressed；纯图片/文件不参与去重',
    'relayDedupeMode=off 可退回旧行为（对照组已验证能复现双发）',
  ],
};
writeFileSync(join(ROOT, 'm6-4-dedupe-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
console.log(`证据：${join(ROOT, 'm6-4-dedupe-evidence.json')}`);
process.exitCode = failed.length ? 1 : 0;
