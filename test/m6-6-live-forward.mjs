// M6.6 真机验收：合并转发能被网关读出来，真正送到模型面前。
//
// 做法：不碰真 QQ——临时以「NapCat 协议端」身份连运行中的网关（同一反向 WS + token），
// 注入一条带 forward 段的主号私聊，网关发出的 get_forward_msg 由本脚本按真机形状
// （{messages:[{sender:{nickname},message:[...]}]}）应答，之后模型如果提到转发内容，
// 就能证明内容确实进了 prompt。所有 send_* 也由本脚本应答，真 QQ 端零消息。
//
// 跑法（网关必须在跑且已加载 M6.6 代码）：
//   node ~/.dsh/bundles/dsh-qq-gateway/test/m6-6-live-forward.mjs
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { connectWs } from '../lib/gateway/ws.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const LOG_PATH = join(ROOT, 'm4-gateway.log');

const WS_URL = process.env.QQGW_WS_URL || 'ws://127.0.0.1:8792/onebot';
const STATUS_URL = process.env.QQGW_STATUS_URL || 'http://127.0.0.1:8793/dsh-qq-gateway/status';
const TOKEN = process.env.QQGW_TOKEN || 'YOUR_TOKEN';
const MAIN_QQ = 10001;
const BOT_QQ = 10002;

const FWD_ID = 'LIVE-FWD-M66';
const FWD_NODES = [
  { sender: { nickname: '小明', user_id: 10001 }, message: [{ type: 'text', data: { text: '第一条' } }] },
  { sender: { nickname: '小红', user_id: 10002 }, message: [{ type: 'text', data: { text: '第二条' } }] },
];

const INJECT_TEXT = [
  '自动化验收（M6.6 合并转发读取）。这条消息里带了一条合并转发记录，请只回答一行：',
  '「昵称：正文」——取转发记录里第一条的发送者昵称和正文。不要调用任何工具，直接回文字。',
].join('\n');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function readStatus() {
  const res = await fetch(STATUS_URL);
  const body = await res.json();
  return body.status ?? body;
}

function tailLines(text, count = 30) {
  return text.split(/\r?\n/).filter(Boolean).slice(-count);
}

const before = await readStatus();
const logOffset = statSync(LOG_PATH).size;
const countersBefore = before.counters;

const peer = await connectWs(WS_URL, { headers: { Authorization: `Bearer ${TOKEN}` } });
const actions = [];
peer.on('text', (text) => {
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return;
  }
  if (!frame || typeof frame.action !== 'string') return;
  actions.push(frame);
  let data = {};
  if (frame.action === 'get_login_info') data = { user_id: BOT_QQ, nickname: 'ShawwiMAのDS' };
  else if (frame.action === 'get_version_info') data = { app_name: 'NapCat.Onebot', app_version: '4.18.37', protocol_version: 'v11' };
  else if (frame.action === 'get_forward_msg') data = { messages: FWD_NODES };
  else if (/^send_/.test(frame.action)) data = { message_id: `live-fwd-${actions.length}` };
  peer.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: frame.echo }));
});

await delay(800);
peer.send(JSON.stringify({
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  message_id: `live-fwd-${Date.now()}`,
  user_id: MAIN_QQ,
  self_id: BOT_QQ,
  time: Math.floor(Date.now() / 1000),
  raw_message: INJECT_TEXT,
  font: 0,
  sender: { user_id: MAIN_QQ, nickname: 'ShawwiMA', sex: 'unknown', age: 0 },
  message: [
    { type: 'text', data: { text: INJECT_TEXT } },
    { type: 'forward', data: { id: FWD_ID } },
  ],
  post_format: 'array',
}));
console.log('已注入带合并转发的验收消息，等模型回答（最多 240s）…');

const DEADLINE = Date.now() + 240000;
const sendActions = () => actions.filter((a) => a.action === 'send_private_msg' || a.action === 'send_group_msg');
const textOf = (action) => JSON.stringify(action.params?.message ?? '');
const mentionsContent = (text) => text.includes('小明') && text.includes('第一条');

let logAppend = '';
let forwardAction = null;
let resolvedLine = null;
let sawUnsupported = false;

while (Date.now() < DEADLINE) {
  await delay(1000);
  logAppend = readFileSync(LOG_PATH).subarray(logOffset).toString('utf8');
  forwardAction = forwardAction ?? actions.find((a) => a.action === 'get_forward_msg') ?? null;
  resolvedLine = resolvedLine ?? logAppend.split(/\r?\n/).find((line) => line.includes('forward resolved')) ?? null;
  sawUnsupported = sawUnsupported || logAppend.includes('unsupported media frame');
  if (sendActions().some((a) => mentionsContent(textOf(a)))) break;
}

const after = await readStatus();
const forwardReadDelta = (after.counters.forwardRead ?? 0) - (countersBefore.forwardRead ?? 0);
const unsupportedDelta = (after.counters.unsupportedNotified ?? 0) - (countersBefore.unsupportedNotified ?? 0);

await new Promise((resolve) => {
  peer.on('close', resolve);
  peer.close(1000);
  setTimeout(resolve, 2000);
});

const answeredWithContent = sendActions().some((a) => mentionsContent(textOf(a)));

console.log('\n--- 验收观测 ---');
console.log(`网关发出的 get_forward_msg: ${forwardAction ? JSON.stringify(forwardAction.params) : '(无)'}`);
console.log(`日志 forward resolved: ${resolvedLine ?? '(无)'}`);
console.log(`模型回传内容含「小明/第一条」: ${answeredWithContent}`);
console.log(`unsupported media 日志: ${sawUnsupported}`);
console.log(`forwardRead: ${countersBefore.forwardRead ?? 0} -> ${after.counters.forwardRead ?? 0}`);
console.log(`出站 action: ${sendActions().map((a) => `${a.action}=${textOf(a).slice(0, 60)}`).join(' | ') || '(无)'}`);

record('网关按 id 调了 get_forward_msg（segment.data.id 正确解析）', Boolean(forwardAction) && String(forwardAction.params?.message_id ?? '') === FWD_ID);
record('日志记录 forward resolved 且节点数=2', Boolean(resolvedLine) && /nodes=2/.test(resolvedLine));
record('模型回答里出现了转发内容（说明真正进了 prompt）', answeredWithContent);
record('没有把合并转发当「不支持的媒体」回执', !sawUnsupported && unsupportedDelta === 0);
record('计数器 forwardRead +1', forwardReadDelta === 1);

const failed = results.filter((r) => !r.ok);
const evidence = {
  milestone: 'M6.6',
  kind: '真机合并转发读取验收（临时假 NapCat 端注入，真 QQ 端零消息）',
  at: new Date().toISOString(),
  ws: WS_URL,
  statusUrl: STATUS_URL,
  injected: { text: INJECT_TEXT, forwardId: FWD_ID, nodes: FWD_NODES },
  observations: {
    forwardActionParams: forwardAction?.params ?? null,
    resolvedLine,
    answeredWithContent,
    sawUnsupported,
    forwardReadBefore: countersBefore.forwardRead ?? null,
    forwardReadAfter: after.counters.forwardRead ?? null,
    actions: actions.map((a) => ({ action: a.action, params: a.params ?? null })),
    logTail: tailLines(logAppend),
  },
  totals: { checks: results.length, passed: results.length - failed.length, failed: failed.length },
  results,
};
writeFileSync(join(ROOT, 'm6-6-live-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
console.log(`证据：${join(ROOT, 'm6-6-live-evidence.json')}`);
process.exitCode = failed.length ? 1 : 0;
