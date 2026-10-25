// M6.7 真机验收：合并转发节点里的图片能真下载、真投到模型眼前。
//
// 做法：不碰真 QQ——临时以「NapCat 协议端」身份连运行中的网关（同一反向 WS + token），
// 注入一条带 forward 段的主号私聊；网关发来的 get_forward_msg 由本脚本按真机形状应答，
// 节点里放的是真实 QQ 图片直链（小志 2026-10-17 那条购物截图，3 张）。
// 网关只把 action 发给「最后一个连上的 peer」，所以真 NapCat 收不到 send_private_msg，
// 模型回传内容由本脚本截获，真 QQ 端零消息。
//
// 判据：模型回传里出现图片实际内容（始祖鸟/冲锋衣/橙色/3532 之类），才说明图真进了 prompt。
//
// 跑法（网关必须在跑且已加载 M6.7 代码；图片直链 rkey 有时效，失效会报 URL 过期）：
//   node ~/.dsh/bundles/dsh-qq-gateway/test/m6-7-live-forward-images.mjs
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

const FWD_ID = 'LIVE-FWD-M67';

// 真机形状（2026-10-18 13:02 用 qq_action get_forward_msg 从 QQ 取回的真实节点）
const IMG1 = 'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=EhSgpgAOOhhZNnqu3kjbKn4Jm6LI0BjsvBAg_gooueHH8P_AlwMyBHByb2RQgLsvWhA0jR3KSzf7n-eGpHWW94IeegIrGoIBAm5q&rkey=CAQSMEInk4N2W_DOFX3lE7fSwvuBs4fSqyHxA9Sr26BrL8K-5_FKXCiqnbWW64EACLfF4w';
const IMG2 = 'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=EhSDtkRJ0-tHtqRv9vddHFmRAm-zJBjwwXwg_goovK3U8P_AlwMyBHByb2RQgLsvWhC34c50Tr0Rxik6Z8A9kpfWegKpU4IBAm5q&rkey=CAQSMEInk4N2W_DOFX3lE7fSwvuBs4fSqyHxA9Sr26BrL8K-5_FKXCiqnbWW64EACLfF4w';
const IMG3 = 'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=EhSMqjWxy1qx_MmmgCqRl6Fc-_NkSBigpGwg_gootKfN8P_AlwMyBHByb2RQgLsvWhCO6LeGqAho4bALJqJFiGu0egIM14IBAm5q&rkey=CAQSMEInk4N2W_DOFX3lE7fSwvuBs4fSqyHxA9Sr26BrL8K-5_FKXCiqnbWW64EACLfF4w';

const node = (nickname, ...message) => ({ sender: { nickname, user_id: 1094950020 }, message });
const FWD_NODES = [
  node('随风也随你', { type: 'image', data: { file: '962EF3908FE441B699D8371070DC146B.png', url: IMG1, summary: '' } }),
  node('随风也随你', { type: 'image', data: { file: 'D11CBEF9BE0E3ADC3A37C747D73250AC.png', url: IMG2, summary: '' } }),
  node('随风也随你', { type: 'image', data: { file: '4E797D849203F9D0DF21770554C6A8C8.png', url: IMG3, summary: '' } }),
  node('随风也随你', { type: 'text', data: { text: '犹豫了好几天，不知道买哪个颜色。' } }),
  node('随风也随你', { type: 'text', data: { text: '主要是颜色，款式一样的。' } }),
];

const INJECT_TEXT = [
  '自动化验收（M6.7 合并转发看图）。这条消息带了一条合并转发，里面有 3 张图。',
  '请只回答一行：图片里卖的是什么、什么颜色、标价多少。不要调用任何工具，直接回文字。',
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
  else if (/^send_/.test(frame.action)) data = { message_id: `live-m67-${actions.length}` };
  peer.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: frame.echo }));
});

await delay(800);
peer.send(JSON.stringify({
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  message_id: `live-m67-${Date.now()}`,
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
console.log('已注入带 3 张真图的合并转发，等模型回答（最多 240s）…');

const DEADLINE = Date.now() + 240000;
const sendActions = () => actions.filter((a) => a.action === 'send_private_msg' || a.action === 'send_group_msg');
const textOf = (action) => String(action.params?.message ?? '');
// 图片实际内容的关键词：始祖鸟/冲锋衣/BETA/橙/3532/得物
const VISION_HINTS = ['始祖鸟', '冲锋衣', 'BETA', '得物', '橙', '3532'];
const looksLikeVision = (text) => VISION_HINTS.some((word) => text.includes(word));

let logAppend = '';
let forwardAction = null;
let sawUnsupported = false;
let imagesResolved = 0;

while (Date.now() < DEADLINE) {
  await delay(1000);
  logAppend = readFileSync(LOG_PATH).subarray(logOffset).toString('utf8');
  forwardAction = forwardAction ?? actions.find((a) => a.action === 'get_forward_msg') ?? null;
  sawUnsupported = sawUnsupported || logAppend.includes('unsupported media frame');
  imagesResolved = Math.max(imagesResolved, (logAppend.match(/forward image resolved \(/g) ?? []).length);
  if (sendActions().some((a) => looksLikeVision(textOf(a)))) break;
  if (imagesResolved === 0 && Date.now() > DEADLINE - 200000) break; // 图都没下下来，别干等
}

const after = await readStatus();
const forwardImagesDelta = (after.counters.forwardImages ?? 0) - (countersBefore.forwardImages ?? 0);
const forwardImageFailuresDelta = (after.counters.forwardImageFailures ?? 0) - (countersBefore.forwardImageFailures ?? 0);
const resolvedLine = logAppend.split(/\r?\n/).find((line) => line.includes('forward resolved')) ?? null;
const imageLines = logAppend.split(/\r?\n/).filter((line) => line.includes('forward image resolved ('));
const replyActions = sendActions();
const replyText = replyActions.map(textOf).find(looksLikeVision) ?? replyActions.map(textOf).at(-1) ?? '';

await new Promise((resolve) => {
  peer.on('close', resolve);
  peer.close(1000);
  setTimeout(resolve, 2000);
});

const answeredWithVision = replyActions.some((a) => looksLikeVision(textOf(a)));

console.log('\n--- 验收观测 ---');
console.log(`网关发出的 get_forward_msg: ${forwardAction ? JSON.stringify(forwardAction.params) : '(无)'}`);
console.log(`日志 forward resolved: ${resolvedLine ?? '(无)'}`);
console.log(`日志 forward image resolved: ${imageLines.length} 条\n${imageLines.map((l) => `  ${l}`).join('\n')}`);
console.log(`模型回传: ${replyText.slice(0, 300)}`);
console.log(`forwardImages: ${countersBefore.forwardImages ?? 0} -> ${after.counters.forwardImages ?? 0}（失败 +${forwardImageFailuresDelta}）`);
console.log(`unsupported media 日志: ${sawUnsupported}`);

record('网关按 id 调了 get_forward_msg', Boolean(forwardAction) && String(forwardAction.params?.message_id ?? '') === FWD_ID);
record('日志记录 forward resolved 且 nodes=5/images=3', Boolean(resolvedLine) && /nodes=5/.test(resolvedLine) && /images=3/.test(resolvedLine));
record('3 张真图全部下载成功（forwardImages +3，无失败）', forwardImagesDelta === 3 && forwardImageFailuresDelta === 0);
record('模型回答里出现了图片实际内容（说明图真进了 prompt，不是只看到占位）', answeredWithVision);
record('没有把合并转发当「不支持的媒体」回执', !sawUnsupported);

const failed = results.filter((r) => !r.ok);
const evidence = {
  milestone: 'M6.7',
  kind: '真机合并转发图片验收（真实 QQ 图片直链 + 临时假 NapCat 端注入，真 QQ 端零消息）',
  at: new Date().toISOString(),
  ws: WS_URL,
  statusUrl: STATUS_URL,
  injected: { text: INJECT_TEXT, forwardId: FWD_ID, nodes: FWD_NODES },
  observations: {
    forwardActionParams: forwardAction?.params ?? null,
    resolvedLine,
    imageLines,
    replyText,
    forwardImagesBefore: countersBefore.forwardImages ?? null,
    forwardImagesAfter: after.counters.forwardImages ?? null,
    forwardImageFailuresDelta,
    sawUnsupported,
    logTail: tailLines(logAppend),
  },
  totals: { checks: results.length, passed: results.length - failed.length, failed: failed.length },
  results,
};
writeFileSync(join(ROOT, 'm6-7-live-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
console.log(`证据：${join(ROOT, 'm6-7-live-evidence.json')}`);
process.exitCode = failed.length ? 1 : 0;
