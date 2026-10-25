// M5 离线验收：多人消息真正能进同一个 DSH 会话，并且回复回到正确的人/群。
// 覆盖：私聊白名单（主号 /allow 远程授权、落盘重启不丢）/ 群聊只接 @ / 来源标注 /
// 回复路由（私聊回本人、群聊回原群）/ 非主号不能管理名单 / 防回环。
// 跑法：node ~/.dsh/bundles/dsh-qq-gateway/test/m5-multi.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { createFakeDsh } from './fake-dsh.mjs';
import { connectFakeNapCat } from './fake-napcat.mjs';
import { createGateway } from '../lib/gateway/gateway.js';
import { DROP, parseInbound } from '../lib/gateway/protocol.js';
import { createAllowList, parseAdminCommand } from '../lib/gateway/authz.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const MAIN_QQ = 10001;
const BOT_QQ = 10002;
const FRIEND_QQ = 20001;
const STRANGER_QQ = 29999;
const GROUP_ID = 30001;
const TOKEN = 'm5-test-token';
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

/** M5 起文本首块前面带一行来源说明；断言正文时剥掉它。 */
function bodyOf(call) {
  const text = call?.request?.content?.[0]?.text ?? '';
  const sep = text.indexOf('\n\n');
  return sep === -1 ? text : text.slice(sep + 2);
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
  adminEnabled: true,
  groupRequireMention: true,
};

const isAllowedForTest = (qq) => String(qq) === String(MAIN_QQ) || String(qq) === String(FRIEND_QQ);

console.log('=== M5：授权名单与指令（纯逻辑） ===');

await check('parseAdminCommand：英文/中文别名都认，普通消息不误判', () => {
  assert.deepEqual(parseAdminCommand('/allow 12345'), { command: 'allow', arg: '12345' });
  assert.deepEqual(parseAdminCommand('/授权 12345 小明'), { command: 'allow', arg: '12345 小明' });
  assert.deepEqual(parseAdminCommand('/DENY 12345'), { command: 'deny', arg: '12345' });
  assert.deepEqual(parseAdminCommand('/list'), { command: 'list', arg: '' });
  assert.deepEqual(parseAdminCommand('/help'), { command: 'help', arg: '' });
  assert.equal(parseAdminCommand('allow 123'), null, '不带斜杠不是指令');
  assert.equal(parseAdminCommand('/allowme 123'), null, '未知指令不是管理指令');
  assert.deepEqual(parseAdminCommand('/list 你好'), { command: 'list', arg: '你好' });
  return '6 种写法';
});

await check('createAllowList：增删查 + 落盘 + 重新加载，文件是 UTF-8 无 BOM', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqgw-m5-authz-'));
  const file = join(dir, 'allow-list.json');
  try {
    const list = createAllowList({ file });
    assert.equal(list.count, 0);
    assert.deepEqual(list.add('12345', '小明').ok, true);
    assert.equal(list.has('12345'), true);
    assert.equal(list.add('bad').ok, false, '非法 QQ 要拒绝');
    assert.equal(list.count, 1);
    assert.deepEqual(list.list().map((e) => e.qq), ['12345']);
    const raw = readFileSync(file);
    assert.notEqual(raw[0], 0xef, '落盘文件不许有 BOM');
    const reloaded = createAllowList({ file });
    assert.equal(reloaded.has('12345'), true, '新实例要从文件读出来');
    assert.equal(reloaded.count, 1);
    assert.equal(reloaded.remove('12345').removed, true);
    assert.equal(reloaded.count, 0);
    assert.equal(createAllowList({ file }).has('12345'), false, '删除要落盘');
    return `file=${file.split('\\').pop()}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log('\n=== M5：parseInbound 多人门控（纯逻辑） ===');

const frameBase = { post_type: 'message', self_id: BOT_QQ, message_id: 1 };

await check('私聊：授权好友放行并带出来源/昵称；陌生人按 wrong-user 挡掉', () => {
  const ok = parseInbound({
    ...frameBase, message_type: 'private', user_id: FRIEND_QQ,
    sender: { user_id: FRIEND_QQ, nickname: '小明' },
    message: [{ type: 'text', data: { text: '你好' } }],
  }, cfgBase, { isAllowed: isAllowedForTest });
  assert.equal(ok.ok, true);
  assert.equal(ok.msg.source, 'private');
  assert.equal(ok.msg.userId, String(FRIEND_QQ));
  assert.equal(ok.msg.nickname, '小明');
  assert.equal(ok.msg.groupId, null);

  const bad = parseInbound({
    ...frameBase, message_type: 'private', user_id: STRANGER_QQ,
    message: [{ type: 'text', data: { text: '陌生人' } }],
  }, cfgBase, { isAllowed: isAllowedForTest });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, DROP.WRONG_USER);
  return '好友放行 / 陌生人挡';
});

await check('allowAllPrivate=true：陌生人私聊也放行，群聊仍只接 @', () => {
  const cfg = { ...cfgBase, allowAllPrivate: true };
  const any = parseInbound({
    ...frameBase, message_type: 'private', user_id: STRANGER_QQ,
    sender: { user_id: STRANGER_QQ, nickname: '陌生人' },
    message: [{ type: 'text', data: { text: '我也是好友' } }],
  }, cfg, { isAllowed: isAllowedForTest });
  assert.equal(any.ok, true, '开启后不再查授权名单');
  assert.equal(any.msg.source, 'private');
  assert.equal(any.msg.nickname, '陌生人');

  const group = parseInbound({
    ...frameBase, message_type: 'group', group_id: GROUP_ID, user_id: STRANGER_QQ,
    message: [{ type: 'text', data: { text: '群里没 @' } }],
  }, cfg, { isAllowed: isAllowedForTest });
  assert.equal(group.ok, false);
  assert.equal(group.reason, DROP.GROUP_NO_MENTION, '群聊仍要 @');
  return '私聊不限 / 群仍门控';
});

await check('群聊：没 @小号 挡掉（group-no-mention），@了才放行并带群号/群名片', () => {
  const noMention = parseInbound({
    ...frameBase, message_type: 'group', group_id: GROUP_ID, user_id: 20002,
    sender: { user_id: 20002, nickname: '群友A', card: 'A 的小号' },
    message: [{ type: 'text', data: { text: '没 @' } }],
  }, cfgBase, { isAllowed: isAllowedForTest });
  assert.equal(noMention.ok, false);
  assert.equal(noMention.reason, DROP.GROUP_NO_MENTION);

  const mentioned = parseInbound({
    ...frameBase, message_type: 'group', group_id: GROUP_ID, user_id: 20002,
    sender: { user_id: 20002, nickname: '群友A', card: 'A 的小号' },
    message: [{ type: 'at', data: { qq: String(BOT_QQ) } }, { type: 'text', data: { text: '@小号 在吗' } }],
  }, cfgBase, { isAllowed: isAllowedForTest });
  assert.equal(mentioned.ok, true);
  assert.equal(mentioned.msg.source, 'group');
  assert.equal(mentioned.msg.groupId, String(GROUP_ID));
  assert.equal(mentioned.msg.nickname, 'A 的小号', '群名片优先于昵称');
  assert.equal(mentioned.msg.mentioned, true);
  assert.deepEqual(mentioned.msg.media, [], '@ 段不算不支持的媒体');
  assert.equal(mentioned.msg.text, '@小号 在吗');
  return '群号/群名片/@ 判定都对';
});

await check('防回环：小号自己的消息、self_id 不对的帧一律挡', () => {
  const self = parseInbound({
    ...frameBase, message_type: 'group', group_id: GROUP_ID, user_id: BOT_QQ,
    message: [{ type: 'at', data: { qq: String(BOT_QQ) } }, { type: 'text', data: { text: '自己的话' } }],
  }, cfgBase, { isAllowed: isAllowedForTest });
  assert.equal(self.ok, false);
  assert.equal(self.reason, DROP.SELF_MESSAGE);

  const wrongSelf = parseInbound({
    ...frameBase, self_id: MAIN_QQ, message_type: 'private', user_id: MAIN_QQ,
    message: [{ type: 'text', data: { text: 'hi' } }],
  }, cfgBase, { isAllowed: isAllowedForTest });
  assert.equal(wrongSelf.ok, false);
  assert.equal(wrongSelf.reason, DROP.WRONG_SELF);
  return 'self-message / wrong-self';
});

console.log('\n=== M5：端到端（私聊多人 + 群 @ + 主号指令） ===');

const allowDir = mkdtempSync(join(tmpdir(), 'qqgw-m5-e2e-'));
const ALLOW_FILE = join(allowDir, 'allow-list.json');

async function boot({ allowListPath = '', config = {} } = {}) {
  const fake = createFakeDsh({ sessionId: SESSION });
  fake.emitSeed();
  const gw = createGateway({ ctx: fake.ctx, config: { ...cfgBase, allowListPath, ...config }, logger: () => {} });
  await gw.start();
  const url = `ws://127.0.0.1:${gw.port()}${PATH}`;
  return {
    fake,
    gw,
    url,
    async connect() {
      const nc = await connectFakeNapCat({ url, token: TOKEN, botQQ: BOT_QQ, mainQQ: MAIN_QQ });
      await waitFor(() => gw.status().peers >= 1, { label: 'peer registered' });
      return nc;
    },
    async answer(index, replyText) {
      const turn = fake.startTurnFor(fake.calls.prompt[index].requestId, { replyText, stepMs: 5 });
      await turn.done;
    },
    async close() {
      await gw.stop();
    },
  };
}

const env = await boot({ allowListPath: ALLOW_FILE });
const nc = await env.connect();

await check('主号私聊：来源标注 → DSH，回复回主号', async () => {
  const before = env.fake.calls.prompt.length;
  nc.sendPrivate({ text: '主号说话', messageId: 5001 });
  await waitFor(() => env.fake.calls.prompt.length === before + 1, { label: 'main prompt' });
  const call = env.fake.calls.prompt[before];
  assert.match(call.request.content[0].text, /^【QQ私聊】主号：ShawwiMA（QQ 10001）/);
  assert.equal(bodyOf(call), '主号说话');
  await env.answer(before, '主号的回复');
  const reply = await nc.waitForAction((a) => a.action === 'send_private_msg' && a.params.message === '主号的回复', { label: 'main reply' });
  assert.equal(reply.params.user_id, MAIN_QQ);
  return 'ok';
});

await check('主号 /allow：回执 + 落盘 + 不进 DSH', async () => {
  const promptsBefore = env.fake.calls.prompt.length;
  nc.sendPrivate({ text: `/allow ${FRIEND_QQ} 测试好友`, messageId: 5002 });
  const ack = await nc.waitForAction((a) => a.action === 'send_private_msg' && String(a.params.message).includes('已授权'), { label: 'allow ack' });
  assert.match(ack.params.message, /已授权 QQ 20001/);
  assert.equal(env.gw.counters.adminCommands, 1);
  assert.equal(env.gw.status().authz.count, 1);
  assert.equal(env.fake.calls.prompt.length, promptsBefore, '指令不能投给 DSH');
  const saved = JSON.parse(readFileSync(ALLOW_FILE, 'utf8'));
  assert.equal(saved.allowed[0].qq, String(FRIEND_QQ));
  assert.equal(saved.allowed[0].note, '测试好友');
  assert.notEqual(readFileSync(ALLOW_FILE)[0], 0xef, '落盘文件不许有 BOM');
  return `authz.count=${env.gw.status().authz.count}`;
});

await check('授权好友私聊：来源标注正确，回复发给该好友（不是主号）', async () => {
  const before = env.fake.calls.prompt.length;
  nc.sendPrivate({ text: '好友来了', messageId: 5003, userId: FRIEND_QQ, nickname: '小明' });
  await waitFor(() => env.fake.calls.prompt.length === before + 1, { label: 'friend prompt' });
  const call = env.fake.calls.prompt[before];
  assert.match(call.request.content[0].text, /^【QQ私聊】发送者：小明（QQ 20001）/);
  assert.equal(bodyOf(call), '好友来了');
  await env.answer(before, '好友你好，我是小号');
  const reply = await nc.waitForAction((a) => a.action === 'send_private_msg' && a.params.message === '好友你好，我是小号', { label: 'friend reply' });
  assert.equal(reply.params.user_id, FRIEND_QQ, '回复必须回好友，不能回主号');
  return `reply→${reply.params.user_id}`;
});

await check('群 @小号：投递 → DSH，回复回原群（send_group_msg）', async () => {
  const before = env.fake.calls.prompt.length;
  nc.sendGroup({ text: '群里问一句', messageId: 5004, groupId: GROUP_ID, userId: 20002, nickname: '群友A', card: 'A 的小号', mention: true });
  await waitFor(() => env.fake.calls.prompt.length === before + 1, { label: 'group prompt' });
  const call = env.fake.calls.prompt[before];
  assert.match(call.request.content[0].text, /^【QQ群聊】群 30001｜发送者：A 的小号（QQ 20002）｜@了小号/);
  assert.equal(bodyOf(call), '群里问一句');
  await env.answer(before, '群里回复一句');
  const reply = await nc.waitForAction((a) => a.action === 'send_group_msg' && a.params.message === '群里回复一句', { label: 'group reply' });
  assert.equal(reply.params.group_id, GROUP_ID);
  assert.equal(nc.replies().filter((r) => r.params.message === '群里回复一句').length, 0, '群回复不许走私聊');
  return `reply→group ${reply.params.group_id}`;
});

await check('群消息没 @小号：不投掷、不回话，计入 skippedNoMention', async () => {
  const promptsBefore = env.fake.calls.prompt.length;
  const repliesBefore = nc.actions.length;
  const skippedBefore = env.gw.counters.skippedNoMention;
  nc.sendGroup({ text: '没 @ 的消息', messageId: 5005, userId: 20002, mention: false });
  await delay(150);
  assert.equal(env.fake.calls.prompt.length, promptsBefore);
  assert.equal(nc.actions.length, repliesBefore, '没 @ 不许回话');
  assert.equal(env.gw.counters.skippedNoMention, skippedBefore + 1);
  return `skippedNoMention=${env.gw.counters.skippedNoMention}`;
});

await check('防回环实测：群消息 user_id=小号自己 → 丢弃，不进 DSH', async () => {
  const promptsBefore = env.fake.calls.prompt.length;
  const skippedBefore = env.gw.counters.skippedSelfMessage;
  nc.sendGroup({ text: '小号自己', messageId: 5006, groupId: GROUP_ID, userId: BOT_QQ, nickname: '小号', mention: true });
  await delay(150);
  assert.equal(env.fake.calls.prompt.length, promptsBefore);
  assert.equal(env.gw.counters.skippedSelfMessage, skippedBefore + 1);
  return `skippedSelfMessage=${env.gw.counters.skippedSelfMessage}`;
});

await check('未授权私聊：静默丢弃，不投不答', async () => {
  const promptsBefore = env.fake.calls.prompt.length;
  const actionsBefore = nc.actions.length;
  nc.sendPrivate({ text: '陌生人消息', messageId: 5007, userId: STRANGER_QQ, nickname: '陌生人' });
  await delay(150);
  assert.equal(env.fake.calls.prompt.length, promptsBefore);
  assert.equal(nc.actions.length, actionsBefore, '未授权私聊不许回话');
  return '静默丢弃';
});

await check('非主号不能管理名单：发 /deny 主号 无效且照常当普通消息投递', async () => {
  const before = env.fake.calls.prompt.length;
  const countBefore = env.gw.status().authz.count;
  nc.sendPrivate({ text: `/deny ${MAIN_QQ}`, messageId: 5008, userId: FRIEND_QQ, nickname: '小明' });
  await waitFor(() => env.fake.calls.prompt.length === before + 1, { label: 'friend command as text' });
  assert.equal(env.gw.status().authz.count, countBefore, '非主号改不动名单');
  assert.equal(bodyOf(env.fake.calls.prompt[before]), `/deny ${MAIN_QQ}`);
  await env.answer(before, '收到');
  return `authz.count=${env.gw.status().authz.count} 未变`;
});

await check('主号 /list：回执带名单内容', async () => {
  nc.sendPrivate({ text: '/list', messageId: 5009 });
  const ack = await nc.waitForAction((a) => a.action === 'send_private_msg' && String(a.params.message).includes('授权名单'), { label: 'list ack' });
  assert.match(ack.params.message, new RegExp(String(FRIEND_QQ)));
  return 'list ack ok';
});

await check('主号 /deny：移除后该号私聊立刻被挡', async () => {
  nc.sendPrivate({ text: `/deny ${FRIEND_QQ}`, messageId: 5010 });
  await nc.waitForAction((a) => a.action === 'send_private_msg' && String(a.params.message).includes('已移除'), { label: 'deny ack' });
  assert.equal(env.gw.status().authz.count, 0);
  const promptsBefore = env.fake.calls.prompt.length;
  nc.sendPrivate({ text: '移除后再说话', messageId: 5011, userId: FRIEND_QQ, nickname: '小明' });
  await delay(150);
  assert.equal(env.fake.calls.prompt.length, promptsBefore, '移除后不该再投递');
  return 'deny 生效';
});

// 持久化：主号重新授权后关网关，新实例读同一文件
nc.sendPrivate({ text: `/allow ${FRIEND_QQ}`, messageId: 5012 });
await nc.waitForAction((a) => a.action === 'send_private_msg' && String(a.params.message).includes('已授权'), { label: 're-allow ack' });
await nc.close();
await env.close();

await check('持久化：网关重启后名单还在（同一文件）', async () => {
  const env2 = await boot({ allowListPath: ALLOW_FILE });
  try {
    assert.equal(env2.gw.status().authz.count, 1, '重启后名单应恢复');
    assert.equal(env2.gw.status().authz.file, ALLOW_FILE);
    return `count=${env2.gw.status().authz.count}`;
  } finally {
    await env2.close();
  }
});

rmSync(allowDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
const evidence = {
  milestone: 'M5',
  kind: '多人消息：私聊白名单 + 群聊只接 @ + 回复路由（离线验收）',
  at: new Date().toISOString(),
  node: process.version,
  totals: { total: results.length, passed: results.length - failed.length, failed: failed.length },
  results,
};
const { writeFileSync } = await import('node:fs');
writeFileSync(join(ROOT, 'm5-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
console.log(`证据：${join(ROOT, 'm5-evidence.json')}`);
process.exitCode = failed.length ? 1 : 0;
