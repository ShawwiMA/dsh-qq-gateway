// M6 全能力离线验收：入站事件（notice/request/meta_event/message_sent）、meta 心跳/生命周期、
// 出站富媒体（图片/表情/卡片/JSON/markdown…）、撤回、动作目录/参数校验/查询/管理动作闸门、
// qq_* 工具注册与执行。全程假 NapCat + 假宿主，不碰真 QQ。
//
// 跑法：node ~/.dsh/bundles/dsh-qq-gateway/test/m6-full.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { createFakeDsh } from './fake-dsh.mjs';
import { connectFakeNapCat } from './fake-napcat.mjs';
import { createGateway } from '../lib/gateway/gateway.js';
import { createQqTools, qqToolNames } from '../lib/gateway/tools.js';
import { listActions, normalizeAction } from '../lib/gateway/actions.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const MAIN_QQ = 10001;
const BOT_QQ = 10002;
const GROUP_ID = 123456;
const TOKEN = 'm6-token';
const PATH = '/onebot';
const SESSION = 'session-fake-target';

// 1x1 透明 PNG（合法图片字节；网关要按扩展名+魔数放行，再转 base64:// 发出去）
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TMP = mkdtempSync(join(tmpdir(), 'm6-qqgw-'));
const PNG_PATH = join(TMP, 'send.png');
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

/** 假 NapCat 的自动应答：只回网关会问的动作，其余给空对象。 */
function responder(action) {
  switch (action.action) {
    case 'get_login_info':
      return { user_id: BOT_QQ, nickname: '测试小号' };
    case 'get_version_info':
      return { app_name: 'NapCat', app_version: '4.8.0', protocol_version: 'v11' };
    case 'get_status':
      return { online: true, good: true };
    case 'get_group_list':
      return [{ group_id: GROUP_ID, group_name: 'DS测试群', member_count: 2 }];
    case 'get_group_msg_history':
      return [{ message_id: 7001, sender: { user_id: MAIN_QQ }, message: '历史消息' }];
    case 'get_essence_msg_list':
      return [];
    case 'get_group_share_link':
      return { url: 'https://qm.qq.com/q/m6test' };
    case 'ArkShareGroup':
      return '{"app":"com.tencent.contact.lua","prompt":"群名片: DS测试群","meta":{"contact":{"nickname":"DS测试群"}},"view":"contact","ver":"0.0.0.1"}';
    case '_send_group_notice':
      return null;
    default:
      return undefined; // send_* 由 FakeNapCat 默认给自增 message_id，其余给 {}
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
  // M6：只把「加好友/加群申请」和「群/好友撤回」投给模型，其余事件只记录（测试过滤逻辑）
  eventPromptTypes: 'request,notice.group_recall,notice.friend_recall',
  heartbeatTimeoutMs: 60000,
  // 离线测试不碰真实数据：日志/名单/禁回都落临时目录；状态端点关掉（真网关也占 8793）
  logFilePath: join(TMP, 'm6-gateway.log'),
  allowListPath: join(TMP, 'allow-list.json'),
  muteStatePath: join(TMP, 'mute.json'),
  statusEnabled: false,
};

/** 假的 Markdown 渲染器：m6 离线测试不依赖本机 Edge/Python（真实渲染另有 markdown-image-check）。 */
const FAKE_MD_BYTES = Buffer.from(PNG_BASE64, 'base64');
async function fakeRenderMarkdown(markdown, opts = {}) {
  if (!String(markdown ?? '').trim()) return { ok: false, error: 'Markdown 内容为空' };
  return {
    ok: true,
    path: PNG_PATH,
    width: opts.maxWidth ?? 720,
    height: 200,
    bytes: FAKE_MD_BYTES.length,
    ms: 1,
  };
}

/** 直接 createGateway（工具目录自己拿）的测试台。 */
async function boot(extraConfig = {}, extraDeps = {}) {
  const fake = createFakeDsh({ sessionId: SESSION });
  fake.emitSeed();
  const logs = [];
  const gw = createGateway({
    ctx: fake.ctx,
    config: { ...baseConfig, ...extraConfig },
    logger: (m) => logs.push(m),
    deps: { renderMarkdown: fakeRenderMarkdown, ...extraDeps },
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

/** 发一条 QQ 消息并等宿主收到 prompt，返回 prompt 记录。 */
async function sendAndGetPrompt(env, frameSender) {
  const before = env.fake.calls.prompt.length;
  frameSender();
  await waitFor(() => env.fake.calls.prompt.length === before + 1, { label: 'prompt' });
  return env.fake.calls.prompt[before];
}

async function answerPrompt(env, replyText = '收到') {
  const index = env.fake.calls.prompt.length - 1;
  const requestId = env.fake.calls.prompt[index].requestId;
  const turn = env.fake.startTurnFor(requestId, { replyText, stepMs: 5 });
  await turn.done;
}

/** 事件通知回合：只回一个带文字的 turn，断言不会往 QQ 发任何东西。 */
async function answerEventPrompt(env) {
  const before = env.fake.calls.prompt.length;
  await waitFor(() => env.fake.calls.prompt.length === Math.max(before, 1), { label: 'event prompt', timeoutMs: 200 });
  await answerPrompt(env, '（事件通知，不需要回复用户）');
}

/** 假宿主收到的最后一条 prompt 正文。 */
function lastPromptText(env) {
  const call = env.fake.calls.prompt[env.fake.calls.prompt.length - 1];
  return call?.request?.content?.map((part) => part.text ?? '').join('\n') ?? '';
}

console.log('=== M6：动作目录 / 参数校验（纯逻辑） ===');

await check('动作目录覆盖四大类，get_login_info 等关键动作都在', () => {
  const all = listActions();
  assert.ok(all.length >= 50, `动作太少：${all.length}`);
  const names = new Set(all.map((action) => action.name));
  for (const name of [
    'send_private_msg', 'send_group_msg', 'send_msg', 'delete_msg', 'get_msg', 'get_forward_msg',
    'send_group_forward_msg', 'send_private_forward_msg', 'set_msg_emoji_like', 'send_poke',
    'mark_msg_as_read', 'set_input_status', 'send_like',
    'get_login_info', 'get_status', 'get_version_info', 'get_group_list', 'get_group_member_list',
    'get_friend_list', 'get_stranger_info', 'get_group_msg_history', 'get_essence_msg_list',
    'set_group_kick', 'set_group_ban', 'set_group_admin', 'set_group_card', 'set_group_name',
    'set_group_leave', 'set_essence_msg', 'set_friend_add_request', 'set_group_add_request',
    'upload_group_file', 'delete_group_file', 'set_online_status', 'set_qq_profile',
  ]) {
    assert.ok(names.has(name), `动作目录缺少 ${name}`);
  }
  const categories = new Set(all.map((action) => action.category));
  for (const category of ['message', 'query', 'manage']) assert.ok(categories.has(category), `缺少类别 ${category}`);
  const risks = new Set(all.map((action) => action.risk));
  for (const risk of ['read', 'write', 'destructive']) assert.ok(risks.has(risk), `缺少风险级别 ${risk}`);
  return `${all.length} 个动作`;
});

await check('参数校验：缺必填/未知参数/类型错误都被拒，字符串消息自动包成 text 段', () => {
  assert.equal(normalizeAction('get_login_info', {}).ok, true);
  assert.equal(normalizeAction('get_login_info', { x: 1 }).ok, false, '未知参数应被拒');
  assert.equal(normalizeAction('send_group_msg', { message: 'hi' }).ok, false, '缺 group_id 应被拒');
  assert.equal(normalizeAction('send_group_msg', { group_id: 'abc', message: 'hi' }).ok, false, '非数字群号应被拒');
  const ok = normalizeAction('send_group_msg', { group_id: GROUP_ID, message: 'hi' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.params.message, [{ type: 'text', data: { text: 'hi' } }], '字符串消息应包成 text 段');
  assert.equal(ok.params.group_id, GROUP_ID);
  return '校验/归一化 ok';
});

console.log('\n=== M6：连接 / 心跳 / 生命周期 ===');

const env = await boot();
try {
  await check('连上后主动查账号与版本（get_login_info / get_version_info）', async () => {
    await waitFor(() => env.gw.status().login.account?.userId === String(BOT_QQ), { label: 'account cached' });
    await waitFor(() => env.gw.status().login.version?.app_name === 'NapCat', { label: 'version cached' });
    const status = env.gw.status();
    assert.equal(status.login.account.userId, String(BOT_QQ));
    assert.equal(status.login.account.nickname, '测试小号');
    assert.equal(status.login.version.app_name, 'NapCat');
    return `account=${status.login.account.userId} version=${status.login.version.app_version}`;
  });

  await check('qq_recall：一条消息都没发过时明确报错，不静默成功', async () => {
    const res = await callTool(env.tools, 'qq_recall', {});
    assert.equal(res.ok, false);
    assert.match(res.error, /没有可撤回/);
    return res.error;
  });

  await check('心跳：在线状态写进 status.login.heartbeat，且不产生 prompt', async () => {
    const promptsBefore = env.fake.calls.prompt.length;
    env.nc.sendHeartbeat({ status: { online: true, good: true }, interval: 30000 });
    await waitFor(() => env.gw.status().login.heartbeat !== null, { label: 'heartbeat' });
    const hb = env.gw.status().login.heartbeat;
    assert.equal(hb.online, true);
    assert.equal(hb.good, true);
    assert.equal(hb.interval, 30000);
    assert.equal(hb.stale, false, '刚收到心跳不该 stale');
    assert.ok(hb.ageMs < 5000, `ageMs=${hb.ageMs}`);
    assert.equal(env.fake.calls.prompt.length, promptsBefore, '心跳不许投给模型');
    assert.ok(env.gw.counters.metaEvents >= 1);
    return `ageMs=${hb.ageMs} interval=${hb.interval}`;
  });

  await check('心跳：online=false 能反映到状态里（掉线可观测）', async () => {
    env.nc.sendHeartbeat({ status: { online: false, good: false }, interval: 30000 });
    await waitFor(() => env.gw.status().login.heartbeat?.online === false, { label: 'offline heartbeat' });
    return 'online=false visible';
  });

  await check('生命周期：lifecycle enable/disable 记录进事件与状态', async () => {
    const before = env.gw.counters.metaEvents;
    env.nc.sendLifecycle({ subType: 'enable' });
    await waitFor(() => env.gw.status().login.lifecycle?.subType === 'enable', { label: 'lifecycle enable' });
    env.nc.sendLifecycle({ subType: 'disable' });
    await waitFor(() => env.gw.status().login.lifecycle?.subType === 'disable', { label: 'lifecycle disable' });
    assert.ok(env.gw.counters.metaEvents >= before + 2);
    assert.equal(env.gw.counters.notices, 0, 'meta 事件不该混进 notice 计数');
    return 'enable/disable ok';
  });

  console.log('\n=== M6：入站事件（notice / request / message_sent） ===');

  await check('群撤回通知：投给模型（含事件类型/群号/消息 id），助手文字不回传 QQ', async () => {
    const promptsBefore = env.fake.calls.prompt.length;
    const repliesBefore = env.nc.replies().length;
    env.nc.sendNotice({ noticeType: 'group_recall', groupId: GROUP_ID, userId: MAIN_QQ, messageId: 4242 });
    await waitFor(() => env.fake.calls.prompt.length === promptsBefore + 1, { label: 'event prompt' });
    const text = lastPromptText(env);
    assert.match(text, /【QQ 事件通知】/);
    assert.match(text, /撤回了消息 4242/);
    assert.match(text, new RegExp(`群号：${GROUP_ID}`));
    assert.match(text, /不会发到 QQ/, '要明确告诉模型直接输出不会发出去');
    await answerPrompt(env, '这条文字不该被发到 QQ');
    await delay(120);
    assert.equal(env.nc.replies().length, repliesBefore, '事件回合的助手文字不许回传');
    assert.ok(env.gw.counters.skippedEventReply >= 1);
    return '事件正文与零回传 ok';
  });

  await check('未在过滤表里的事件只记录不打断模型（poke）', async () => {
    const promptsBefore = env.fake.calls.prompt.length;
    env.nc.sendNotice({ noticeType: 'notify', subType: 'poke', groupId: GROUP_ID, userId: MAIN_QQ, targetId: BOT_QQ });
    await waitFor(() => env.gw.counters.notices >= 2, { label: 'notice counted' });
    await delay(120);
    assert.equal(env.fake.calls.prompt.length, promptsBefore, '未配置的事件不投给模型');
    const events = env.gw.listEvents({ kind: 'notice' }).events;
    assert.ok(events.some((e) => e.type === 'notice.notify' && /戳了戳/.test(e.description)), '事件应被记录并可查');
    return `${events.length} 条 notice 记录`;
  });

  await check('加好友申请：投给模型且带 flag；用 qq_action 处理后 pending 清空', async () => {
    const promptsBefore = env.fake.calls.prompt.length;
    env.nc.sendRequest({ requestType: 'friend', userId: MAIN_QQ, comment: '加个好友', flag: 'flag-f1' });
    await waitFor(() => env.fake.calls.prompt.length === promptsBefore + 1, { label: 'request prompt' });
    const text = lastPromptText(env);
    assert.match(text, /加好友申请/);
    assert.match(text, /flag-f1/);
    await answerPrompt(env);
    await delay(80);
    assert.equal(env.gw.listEvents({ pendingOnly: true }).events.length, 1, '申请应处于待处理');
    const handled = await callTool(env.tools, 'qq_action', {
      action: 'set_friend_add_request',
      params: { flag: 'flag-f1', approve: true },
    });
    assert.equal(handled.ok, true, JSON.stringify(handled));
    const action = await env.nc.waitForAction((a) => a.action === 'set_friend_add_request', { label: 'set_friend_add_request' });
    assert.equal(action.params.flag, 'flag-f1');
    assert.equal(action.params.approve, true);
    assert.equal(env.gw.listEvents({ pendingOnly: true }).events.length, 0, '处理完 pending 应为空');
    return 'flag 透传 + pending 清理';
  });

  await check('message_sent（reportSelfMessage）：记录但不投给模型', async () => {
    const promptsBefore = env.fake.calls.prompt.length;
    const sentBefore = env.gw.counters.messageSentEvents;
    env.nc.sendMessageSent({ messageType: 'private', userId: MAIN_QQ, messageId: 5001 });
    await waitFor(() => env.gw.counters.messageSentEvents === sentBefore + 1, { label: 'message_sent counted' });
    await delay(80);
    assert.equal(env.fake.calls.prompt.length, promptsBefore, '自己发的消息不该投给模型');
    assert.ok(env.gw.listEvents({ kind: 'message_sent' }).events.length >= 1);
    return 'message_sent 记录 ok';
  });

  console.log('\n=== M6：出站文本 / 目标解析 / 富媒体 / 撤回 ===');

  await check('qq_send 默认目标=当前 QQ 对话；消息 id 被捕获，助手文字不再重复回传（M6.4 防双发）', async () => {
    const prompt = await sendAndGetPrompt(env, () => env.nc.sendPrivate({ text: '发个消息试试', messageId: 2001 }));
    assert.match(prompt.request.content[0].text, /【QQ私聊】/);
    const sent = await callTool(env.tools, 'qq_send', { text: '工具发的私聊' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(sent.target.kind, 'private');
    assert.equal(sent.target.user_id, String(MAIN_QQ));
    assert.ok(sent.message_id, '应拿到 message_id');
    const action = await env.nc.waitForAction(
      (a) => a.action === 'send_private_msg' && a.params.message === '工具发的私聊',
      { label: 'tool send_private' },
    );
    assert.equal(action.params.user_id, MAIN_QQ);
    assert.equal(env.gw.currentContext().kind, 'message');
    await answerPrompt(env, '这是助手回复');
    await delay(120);
    assert.equal(
      env.nc.actions.filter((a) => a.action === 'send_private_msg' && a.params.message === '这是助手回复').length,
      0,
      '本回合工具已发过文字，助手文字不该再自动回传（否则 QQ 端双发）',
    );
    assert.equal(env.gw.counters.duplicateRepliesSuppressed, 1);
    return `message_id=${sent.message_id} suppressed=1`;
  });

  await check('qq_send 显式群目标：发 send_group_msg，参数是原始群号', async () => {
    const sent = await callTool(env.tools, 'qq_send', { group_id: GROUP_ID, text: '群里的工具消息' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const action = await env.nc.waitForAction(
      (a) => a.action === 'send_group_msg' && a.params.message === '群里的工具消息',
      { label: 'tool send_group' },
    );
    assert.equal(action.params.group_id, GROUP_ID);
    assert.equal(sent.target.kind, 'group');
    return 'group send ok';
  });

  await check('qq_send 在非网关会话里没目标 → 明确报错（不误发）', async () => {
    const res = await callTool(env.tools, 'qq_send', { text: '不该发出去' }, { agent: { id: 'session-gui' } });
    assert.equal(res.ok, false);
    assert.match(res.error, /必须显式/);
    return res.error;
  });

  await check('qq_send 发图片：本机路径 → base64:// 消息段，消息 id 入账，qq_recall 默认撤回它', async () => {
    const sent = await callTool(env.tools, 'qq_send', { text: '看图', image: PNG_PATH });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const action = await env.nc.waitForAction(
      (a) => a.action === 'send_private_msg' && Array.isArray(a.params.message),
      { label: 'image message' },
    );
    const image = action.params.message.find((segment) => segment.type === 'image');
    assert.ok(image, '消息段里应有 image');
    assert.match(image.data.file, /^base64:\/\//);
    assert.deepEqual(action.params.message.find((segment) => segment.type === 'text'), { type: 'text', data: { text: '看图' } });
    assert.ok(sent.message_id, '发图也要拿到 message_id');
    const recalled = await callTool(env.tools, 'qq_recall', {});
    assert.equal(recalled.ok, true, JSON.stringify(recalled));
    assert.equal(String(recalled.message_id), String(sent.message_id));
    const del = await env.nc.waitForAction((a) => a.action === 'delete_msg', { label: 'delete_msg' });
    assert.equal(String(del.params.message_id), String(sent.message_id));
    assert.ok(env.gw.counters.recalls >= 1);
    return `image+recall message_id=${sent.message_id}`;
  });

  await check('qq_send 图片路径不存在 → 结构化失败，不产生 action', async () => {
    const before = env.nc.actions.length;
    const res = await callTool(env.tools, 'qq_send', { image: join(TMP, 'nope.png') });
    assert.equal(res.ok, false);
    await delay(60);
    assert.equal(env.nc.actions.length, before, '失败时不该发任何 action');
    return res.error;
  });

  await check('qq_send segments：表情 / JSON 卡片 / @ / 引用 都能拼成消息段数组', async () => {
    const sent = await callTool(env.tools, 'qq_send', {
      group_id: GROUP_ID,
      segments: [
        { type: 'at', qq: MAIN_QQ },
        { type: 'face', id: 1 },
        { type: 'json', data: { app: 'test', title: '卡片' } },
        { type: 'reply', message_id: 777 },
      ],
    });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const action = await env.nc.waitForAction(
      (a) => a.action === 'send_group_msg' && Array.isArray(a.params.message) && a.params.message.length >= 4,
      { label: 'segments message' },
    );
    const types = action.params.message.map((segment) => segment.type);
    for (const type of ['at', 'face', 'json', 'reply']) assert.ok(types.includes(type), `缺少 ${type} 段`);
    return types.join('+');
  });

  await check('qq_send markdown：渲染成图片再发（假渲染器），带 markdown_image 元信息', async () => {
    const res = await callTool(env.tools, 'qq_send', {
      user_id: MAIN_QQ,
      markdown: '# 标题\n\n- 第一项\n- 第二项',
      text: '看这个',
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.rendered, 'image');
    assert.equal(res.markdown_image.width, 720);
    assert.ok(res.markdown_image.height > 0);
    const action = await env.nc.waitForAction(
      (a) => a.action === 'send_private_msg' && Array.isArray(a.params.message) && a.params.message.some((s) => s.type === 'image'),
      { label: 'markdown image' },
    );
    const types = action.params.message.map((segment) => segment.type);
    assert.deepEqual(types, ['text', 'image'], '附言在前、渲染图在后');
    return `markdown -> ${types.join('+')}`;
  });

  await check('qq_notice：群公告走 _send_group_notice，布尔参数转 0/1', async () => {
    const res = await callTool(env.tools, 'qq_notice', {
      group_id: GROUP_ID,
      content: '公告正文\n第二行',
      pinned: true,
      confirm_required: false,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    const action = await env.nc.waitForAction((a) => a.action === '_send_group_notice', { label: '_send_group_notice' });
    assert.equal(action.params.group_id, GROUP_ID);
    assert.equal(action.params.content, '公告正文\n第二行');
    assert.equal(action.params.pinned, 1);
    assert.equal(action.params.confirm_required, 0);
    return 'notice params ok';
  });

  await check('qq_invite：拿群分享链接；给 user_id 时私聊发群名片 Ark 卡片（json 段）+ 链接', async () => {
    const linkOnly = await callTool(env.tools, 'qq_invite', { group_id: GROUP_ID });
    assert.equal(linkOnly.ok, true, JSON.stringify(linkOnly));
    assert.equal(linkOnly.url, 'https://qm.qq.com/q/m6test');
    assert.equal(linkOnly.sent, false);
    const res = await callTool(env.tools, 'qq_invite', {
      group_id: GROUP_ID,
      user_id: MAIN_QQ,
      send_style: 'both',
      text: '回来吧',
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.sent, true);
    assert.equal(res.card, true);
    assert.ok(res.message_id, '邀请消息应拿到 message_id');
    const action = await env.nc.waitForAction(
      (a) => a.action === 'send_private_msg' && Array.isArray(a.params.message) && a.params.message.some((s) => s.type === 'json'),
      { label: 'invite card' },
    );
    assert.equal(action.params.user_id, MAIN_QQ);
    const json = action.params.message.find((s) => s.type === 'json');
    assert.match(json.data.data, /com\.tencent\.contact\.lua/);
    const text = action.params.message.find((s) => s.type === 'text');
    assert.match(text.data.text, /qm\.qq\.com\/q\/m6test/);
    return 'ark card + link ok';
  });

  await check('qq_send 拒绝 NapCat 发不出去的段（markdown/share），并给出替代方案', async () => {
    const markdown = await callTool(env.tools, 'qq_send', {
      group_id: GROUP_ID,
      segments: [{ type: 'markdown', content: '# 标题' }],
    });
    assert.equal(markdown.ok, false);
    assert.match(markdown.error, /markdown 参数/);
    const share = await callTool(env.tools, 'qq_send', {
      group_id: GROUP_ID,
      segments: [{ type: 'share', url: 'https://x' }],
    });
    assert.equal(share.ok, false);
    assert.match(share.error, /qq_invite/);
    return 'fallback hints ok';
  });

  await check('markdownReplyMode=auto：长且像 Markdown 的助手回复自动渲染成图片发回', async () => {
    await sendAndGetPrompt(env, () => env.nc.sendPrivate({ text: '给我一段带排版的说明', messageId: 3001 }));
    const markdown = '# 大肥鱼能力\n\n## 能做的事\n- 读写本机文件、跑脚本\n- 屏幕操控：开窗、点击、截图\n'
      + '- Office 文档读写\n\n> 群里要 @，私聊不用。\n\n| 名字 | 都能叫 |\n| --- | --- |\n| 大肥鱼 | DS |';
    await answerPrompt(env, markdown);
    const action = await env.nc.waitForAction(
      (a) => a.action === 'send_private_msg' && Array.isArray(a.params.message) && a.params.message.some((s) => s.type === 'image'),
      { label: 'auto markdown relay' },
    );
    assert.equal(action.params.user_id, MAIN_QQ);
    assert.ok(env.gw.counters.markdownRendered >= 1);
    return 'auto relay rendered ok';
  });

  await check('qq_recall：不存在的 message_id 由 NapCat 报错时，工具返回结构化失败', async () => {
    // 假 NapCat 默认对 delete_msg 回 success；临时让它对 999999 不应答，由测试手动回 failed。
    env.nc.stopAutoRespond();
    env.nc.startAutoRespond((action) => (action.action === 'delete_msg' && String(action.params?.message_id) === '999999'
      ? false
      : responder(action)));
    const pending = callTool(env.tools, 'qq_recall', { message_id: 999999 });
    const del = await env.nc.waitForAction((a) => a.action === 'delete_msg' && String(a.params.message_id) === '999999', { label: 'delete_msg failed case' });
    env.nc.respondToAction({ echo: del.echo, status: 'failed', retcode: 100, data: null });
    const res = await pending;
    assert.equal(res.ok, false);
    assert.match(res.error, /action failed|delete_msg|失败/i);
    env.nc.stopAutoRespond();
    env.nc.startAutoRespond(responder);
    return res.error;
  });

  console.log('\n=== M6：qq_action 查询 / 管理动作 / 闸门 ===');

  await check('qq_action 查询类：get_login_info / get_group_list / get_group_msg_history', async () => {
    const login = await callTool(env.tools, 'qq_action', { action: 'get_login_info' });
    assert.equal(login.ok, true, JSON.stringify(login));
    assert.equal(login.data.user_id, BOT_QQ);
    const groups = await callTool(env.tools, 'qq_action', { action: 'get_group_list' });
    assert.equal(groups.ok, true);
    assert.equal(groups.data[0].group_name, 'DS测试群');
    const history = await callTool(env.tools, 'qq_action', { action: 'get_group_msg_history', params: { group_id: GROUP_ID, count: 2 } });
    assert.equal(history.ok, true);
    assert.equal(history.data[0].message_id, 7001);
    return '3 个查询动作 ok';
  });

  await check('qq_action 管理动作：managementEnabled=true 能发，未知动作/未知参数被拒', async () => {
    assert.equal(env.gw.config.managementEnabled, true);
    const ban = await callTool(env.tools, 'qq_action', {
      action: 'set_group_ban',
      params: { group_id: GROUP_ID, user_id: MAIN_QQ, duration: 60 },
    });
    assert.equal(ban.ok, true, JSON.stringify(ban));
    await env.nc.waitForAction((a) => a.action === 'set_group_ban', { label: 'set_group_ban' });
    const unknown = await callTool(env.tools, 'qq_action', { action: 'no_such_action' });
    assert.equal(unknown.ok, false);
    const badParam = await callTool(env.tools, 'qq_action', { action: 'set_group_ban', params: { group_id: GROUP_ID } });
    assert.equal(badParam.ok, false);
    return '管理动作可达 + 参数校验';
  });

  await check('managementEnabled=false 时管理动作被闸门挡住，查询类不受影响', async () => {
    const saved = env.gw.config.managementEnabled;
    env.gw.config.managementEnabled = false;
    try {
      const ban = await callTool(env.tools, 'qq_action', {
        action: 'set_group_kick',
        params: { group_id: GROUP_ID, user_id: MAIN_QQ },
      });
      assert.equal(ban.ok, false);
      assert.match(ban.error, /managementEnabled|禁用/);
      const query = await callTool(env.tools, 'qq_action', { action: 'get_status' });
      assert.equal(query.ok, true, '查询类不该被闸门挡');
    } finally {
      env.gw.config.managementEnabled = saved;
    }
    return '闸门 ok';
  });

  await check('qq_send_poke / 点赞 / 已读 / 打字状态等小动作都能走到对应 OneBot 动作', async () => {
    const poke = await callTool(env.tools, 'qq_action', { action: 'send_poke', params: { user_id: MAIN_QQ } });
    assert.equal(poke.ok, true, JSON.stringify(poke));
    await env.nc.waitForAction((a) => a.action === 'send_poke', { label: 'send_poke' });
    const like = await callTool(env.tools, 'qq_action', { action: 'send_like', params: { user_id: MAIN_QQ, times: 1 } });
    assert.equal(like.ok, true);
    await env.nc.waitForAction((a) => a.action === 'send_like', { label: 'send_like' });
    const read = await callTool(env.tools, 'qq_action', { action: 'mark_msg_as_read', params: { message_id: 7001 } });
    assert.equal(read.ok, true);
    await env.nc.waitForAction((a) => a.action === 'mark_msg_as_read', { label: 'mark_msg_as_read' });
    const typing = await callTool(env.tools, 'qq_action', { action: 'set_input_status', params: { user_id: MAIN_QQ, event_type: 1 } });
    assert.equal(typing.ok, true);
    return '4 个小动作 ok';
  });

  await check('qq_actions 目录工具：分类/关键词过滤可用', async () => {
    const all = await callTool(env.tools, 'qq_actions', {});
    assert.equal(all.ok, true);
    assert.ok(all.count >= 50, `count=${all.count}`);
    const query = await callTool(env.tools, 'qq_actions', { category: 'query' });
    assert.ok(query.actions.every((action) => action.category === 'query'));
    const ban = await callTool(env.tools, 'qq_actions', { keyword: 'ban' });
    assert.ok(ban.actions.some((action) => action.name === 'set_group_ban'));
    return `all=${all.count} query=${query.count}`;
  });

  await check('qq_events：kind / limit / since_seq / pending_only 查询都自洽', async () => {
    const all = await callTool(env.tools, 'qq_events', { limit: 5 });
    assert.equal(all.ok, true);
    assert.ok(all.events.length <= 5);
    const notices = await callTool(env.tools, 'qq_events', { kind: 'notice', limit: 100 });
    assert.ok(notices.events.every((event) => event.kind === 'notice'));
    const firstSeq = notices.events[0].seq;
    const newer = await callTool(env.tools, 'qq_events', { since_seq: firstSeq, limit: 100 });
    assert.ok(newer.events.every((event) => event.seq > firstSeq), 'since_seq 过滤');
    const pending = await callTool(env.tools, 'qq_events', { pending_only: true });
    assert.ok(Array.isArray(pending.events));
    return `total=${all.total} notices=${notices.events.length}`;
  });

  await check('qq_status：包含 login/events/tools/sent 与心跳，且不泄漏 token', async () => {
    const res = await callTool(env.tools, 'qq_status', {});
    assert.equal(res.ok, true);
    const status = res.status;
    for (const key of ['login', 'events', 'tools', 'sent', 'counters']) assert.ok(key in status, `缺少 ${key}`);
    assert.ok(status.login.heartbeat, '应有心跳信息');
    assert.equal(JSON.stringify(status).includes(TOKEN), false, '状态里不许出现 token 原值');
    assert.ok(qqToolNames().every((name) => env.tools[name]), `${qqToolNames().length} 个工具都在`);
    return `tools=${qqToolNames().length}`;
  });
} finally {
  await env.stop();
}

console.log('\n=== M6：index.js 注册链路（真 ctx.effect + tools.register） ===');

async function bootViaIndex() {
  const fake = createFakeDsh({ sessionId: SESSION });
  fake.emitSeed();
  const registered = new Map();
  const toolsService = {
    register(definition) {
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
  };
  const disposers = [];
  const logs = [];
  const ctx = {
    sessionController: fake.ctx.sessionController,
    on: (type, handler) => fake.ctx.on(type, handler),
    logger: () => ({ info: (message) => logs.push(message), warn: () => {}, error: (message) => logs.push(`ERROR ${message}`) }),
    effect: (fn) => {
      const disposer = fn();
      disposers.push(disposer);
      return disposer;
    },
    get: (key) => (key === 'tools' ? toolsService : undefined),
  };
  const indexModule = await import('../lib/index.js');
  const result = indexModule.apply(ctx, { ...baseConfig });
  const gw = result.gateway;
  await waitFor(() => gw.port() !== null, { label: 'gateway listening', timeoutMs: 8000 });
  await waitFor(() => registered.size === qqToolNames().length, { label: 'tools registered', timeoutMs: 8000 });
  const nc = await connectFakeNapCat({
    url: `ws://127.0.0.1:${gw.port()}${PATH}`,
    token: TOKEN,
    botQQ: BOT_QQ,
    mainQQ: MAIN_QQ,
  });
  nc.startAutoRespond(responder);
  await waitFor(() => gw.status().peers === 1, { label: 'peer registered' });
  return {
    fake,
    gw,
    nc,
    registered,
    logs,
    async stop() {
      await nc.close();
      await gw.stop();
      for (const dispose of disposers.reverse()) {
        try {
          await dispose();
        } catch {
          // 卸载阶段失败不影响断言
        }
      }
    },
  };
}

const idx = await bootViaIndex();
try {
  await check('index.js：qq_* 工具全部注册（含 qq_notice / qq_invite），名字与目录一致', () => {
    assert.deepEqual([...idx.registered.keys()].sort(), [...qqToolNames()].sort());
    assert.deepEqual(idx.gw.status().tools.names.slice().sort(), [...qqToolNames()].sort());
    assert.match(idx.logs.join('\n'), new RegExp(`已注册 qq_\\* 工具 ${qqToolNames().length} 个`));
    return qqToolNames().join(',');
  });

  await check('index.js：注册出来的工具能真正执行（qq_status / qq_action）', async () => {
    const statusTool = idx.registered.get('qq_status');
    const statusResult = await statusTool.execute({}, toolExec);
    assert.equal(statusResult.ok, true);
    const actionTool = idx.registered.get('qq_action');
    const login = await actionTool.execute({ action: 'get_login_info' }, toolExec);
    assert.equal(login.ok, true, JSON.stringify(login));
    assert.equal(login.data.user_id, BOT_QQ);
    // 走 index 链路时 qq_send 也应能发（默认目标=主号）
    const sendTool = idx.registered.get('qq_send');
    const sent = await sendTool.execute({ text: 'index 链路发一条' }, toolExec);
    assert.equal(sent.ok, true, JSON.stringify(sent));
    await idx.nc.waitForAction(
      (a) => a.action === 'send_private_msg' && a.params.message === 'index 链路发一条',
      { label: 'index path send' },
    );
    return `registered=${idx.registered.size}`;
  });
} finally {
  await idx.stop();
}

console.log('\n=== M6：汇总 ===');
const passed = results.filter((item) => item.ok).length;
const failed = results.length - passed;
for (const item of results.filter((entry) => !entry.ok)) console.log(`FAIL  ${item.name} — ${item.detail}`);
console.log(`${failed === 0 ? 'PASS' : 'FAIL'} ${passed} / ${results.length}`);
try {
  writeFileSync(
    join(HERE, '..', 'm6-evidence.json'),
    `${JSON.stringify({ at: new Date().toISOString(), offlineOnly: true, passed, failed, results }, null, 2)}\n`,
    'utf8',
  );
  console.log(`证据：${join(HERE, '..', 'm6-evidence.json')}`);
} catch (err) {
  console.log(`证据写入失败：${err?.message ?? String(err)}`);
}
process.exit(failed === 0 ? 0 : 1);
