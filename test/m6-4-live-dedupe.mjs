// M6.4 真机验收：防双发「本回合已用 qq_send 发过文字 → 助手文字不再自动回传」。
//
// 做法：不碰真 QQ，也不让模型自己乱发——临时以「NapCat 协议端」身份连上运行中的网关
// （同一个反向 WS、同一个 token），注入一条主号私聊消息，让 QQ 网关会话真的跑一个回合；
// 网关发出来的所有 action 都由本脚本应答并记账，所以真 QQ 端收不到任何消息。
//
// 成功判据（三条同时满足）：
//   1) 看到 qq_send 发出的 send_private_msg（模型确实走了工具通道）；
//   2) 追加日志里有 "assistant text NOT relayed ... tool message already sent"；
//   3) 没有第二条 send_private_msg，且 duplicateRepliesSuppressed +1。
// 对照组（relayDedupeMode=off 时）会在日志里出现 "relayed turn" 和第二条 action——本脚本只跑在线模式。
//
// 跑法（网关必须在跑）：node ~/.dsh/bundles/dsh-qq-gateway/test/m6-4-live-dedupe.mjs
import assert from 'node:assert/strict';
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

const INJECT_TEXT = [
  '自动化验收（M6.4 防双发），只做两件事，不要多做：',
  '① 用 qq_send 工具把「M6.4-A 工具通道」发到当前对话；',
  '② 最终回复写一句「M6.4-B 总结通道」。',
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

function readLogSince(offset) {
  const buf = readFileSync(LOG_PATH);
  return buf.subarray(offset).toString('utf8');
}

function tailLines(text, count = 40) {
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
  const data = frame.action === 'get_login_info'
    ? { user_id: BOT_QQ, nickname: 'ShawwiMAのDS（验收假端）' }
    : frame.action === 'get_version_info'
      ? { app_name: 'NapCat.Onebot', app_version: '4.18.37', protocol_version: 'v11' }
      : /^send_/.test(frame.action)
        ? { message_id: `live-accept-${actions.length}` }
        : {};
  peer.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: frame.echo }));
});

await delay(800);
peer.send(JSON.stringify({
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  message_id: `live-accept-${Date.now()}`,
  user_id: MAIN_QQ,
  self_id: BOT_QQ,
  time: Math.floor(Date.now() / 1000),
  raw_message: INJECT_TEXT,
  font: 0,
  sender: { user_id: MAIN_QQ, nickname: 'ShawwiMA', sex: 'unknown', age: 0 },
  message: [{ type: 'text', data: { text: INJECT_TEXT } }],
  post_format: 'array',
}));
console.log(`已注入验收消息，等 QQ 网关会话跑完这一回合（最多 240s）…`);

const DEADLINE = Date.now() + 240000;
let logAppend = '';
let after = before;
let sawToolSend = false;
let sawExtraSend = false;
let suppressLine = null;
let relayLine = null;

while (Date.now() < DEADLINE) {
  await delay(1000);
  logAppend = readLogSince(logOffset);
  const sends = actions.filter((a) => a.action === 'send_private_msg' || a.action === 'send_group_msg');
  sawToolSend = sends.some((a) => JSON.stringify(a.params?.message ?? '').includes('M6.4-A'));
  sawExtraSend = sends.some((a) => !JSON.stringify(a.params?.message ?? '').includes('M6.4-A'));
  if (!suppressLine) {
    suppressLine = logAppend.split(/\r?\n/).find((line) => line.includes('assistant text NOT relayed')) ?? null;
  }
  if (!relayLine) {
    relayLine = logAppend.split(/\r?\n/).find((line) => line.includes('relayed turn')) ?? null;
  }
  if (suppressLine || relayLine) break;
}

after = await readStatus();
const duplicateDelta = after.counters.duplicateRepliesSuppressed - (countersBefore.duplicateRepliesSuppressed ?? 0);
const relayedDelta = after.counters.relayed - (countersBefore.relayed ?? 0);

await new Promise((resolve) => {
  peer.on('close', resolve);
  peer.close(1000);
  setTimeout(resolve, 2000);
});

console.log('\n--- 验收观测 ---');
console.log(`qq_send 工具通道已发出: ${sawToolSend}`);
console.log(`第二条自动回传: ${sawExtraSend}`);
console.log(`日志去重行: ${suppressLine ?? '(无)'}`);
console.log(`日志回传行: ${relayLine ?? '(无)'}`);
console.log(`duplicateRepliesSuppressed: ${countersBefore.duplicateRepliesSuppressed} -> ${after.counters.duplicateRepliesSuppressed}`);
console.log(`relayed: ${countersBefore.relayed} -> ${after.counters.relayed}`);
console.log(`抓到的 action: ${actions.map((a) => a.action).join(', ') || '(无)'}`);

record('真机日志确实抓到工具通道发送（说明模型走了 qq_send）', sawToolSend);
record('没有第二条重复消息（send_* action 只有一条）', sawToolSend && !sawExtraSend);
record('日志明确记录「不回传」而不是「已回传」', Boolean(suppressLine) && !relayLine);
record('计数器 duplicateRepliesSuppressed +1、relayed 不变', duplicateDelta === 1 && relayedDelta === 0);

const failed = results.filter((r) => !r.ok);
const evidence = {
  milestone: 'M6.4',
  kind: '真机防双发验收（临时假 NapCat 端注入，真 QQ 端零消息）',
  at: new Date().toISOString(),
  ws: WS_URL,
  statusUrl: STATUS_URL,
  injectedText: INJECT_TEXT,
  observations: {
    sawToolSend,
    sawExtraSend,
    suppressLine,
    relayLine,
    duplicateBefore: countersBefore.duplicateRepliesSuppressed,
    duplicateAfter: after.counters.duplicateRepliesSuppressed,
    relayedBefore: countersBefore.relayed,
    relayedAfter: after.counters.relayed,
    actions: actions.map((a) => ({ action: a.action, message: a.params?.message ?? null })),
    logTail: tailLines(logAppend, 20),
  },
  totals: { checks: results.length, passed: results.length - failed.length, failed: failed.length },
  results,
};
writeFileSync(join(ROOT, 'm6-4-live-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
console.log(`证据：${join(ROOT, 'm6-4-live-evidence.json')}`);
process.exitCode = failed.length ? 1 : 0;
