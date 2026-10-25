// M4 实机探针：以「假 NapCat 客户端」的身份连真正的网关（127.0.0.1:8792），
// 验证去重、图片进会话、不支持媒体的回执、单回合只回传一次（反回环），并对比状态端点计数。
//
// 用法：QQGW_TOKEN=xxx node test/m4-probe.mjs
// 可选：QQGW_WS、QQGW_STATUS 覆盖默认地址。
//
// 注意：网关会把回传动作广播给所有已连接 peer，所以跑探针时 NapCat 也在线，
// 主号 QQ 会真收到回复 —— 这是预期的端到端证据，不是 bug。
import { createServer } from 'node:http';
import { connectWs } from '../lib/gateway/ws.js';

const WS_URL = process.env.QQGW_WS ?? 'ws://127.0.0.1:8792/onebot';
const STATUS_URL = process.env.QQGW_STATUS ?? 'http://127.0.0.1:8793/dsh-qq-gateway/status';
const TOKEN = process.env.QQGW_TOKEN ?? '';
const MAIN_QQ = Number(process.env.QQGW_MAIN ?? 10001);
const BOT_QQ = Number(process.env.QQGW_BOT ?? 10002);
const REPLY_TIMEOUT_MS = 90000;

// 1x1 透明 PNG：图片链路的真字节（宿主会照常收）
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

if (!TOKEN) {
  console.error('缺少 QQGW_TOKEN 环境变量');
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readStatus() {
  try {
    const res = await fetch(STATUS_URL, { signal: AbortSignal.timeout(3000) });
    return await res.json();
  } catch {
    return null;
  }
}

function frame({ id, text, segments }) {
  return JSON.stringify({
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    self_id: BOT_QQ,
    user_id: MAIN_QQ,
    message_id: id,
    time: Math.floor(Date.now() / 1000),
    raw_message: text ?? '',
    message: segments ?? [{ type: 'text', data: { text: text ?? '' } }],
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// 本地图床：让网关能按 http url 真下载到图片字节
const imageServer = createServer((req, res) => {
  if ((req.url ?? '').startsWith('/pic')) {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG_BYTES.length });
    res.end(PNG_BYTES);
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => imageServer.listen(0, '127.0.0.1', resolve));
const imageUrl = `http://127.0.0.1:${imageServer.address().port}/pic.png`;
console.log(`本地图床：${imageUrl}`);

const actions = [];
const peer = await connectWs(WS_URL, { headers: { Authorization: `Bearer ${TOKEN}` }, timeoutMs: 5000 });
peer.on('text', (text) => {
  try {
    const value = JSON.parse(text);
    if (value && typeof value.action === 'string') actions.push(value);
  } catch {
    // 不是动作帧就忽略
  }
});
const replies = () => actions.filter((a) => a.action === 'send_private_msg');

const before = await readStatus();
if (!before) console.log('WARN 状态端点不可用，计数对比跳过（只看动作帧）');

/** 等到 replies() 里出现一条满足条件的（按序号取，避免匹配到旧动作）。 */
async function waitForReply(minIndex, predicate = () => true, { label = 'reply', timeoutMs = REPLY_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = replies();
    for (let i = minIndex; i < list.length; i += 1) {
      if (predicate(list[i])) return list[i];
    }
    await sleep(400);
  }
  throw new Error(`timeout ${timeoutMs}ms waiting for ${label}`);
}

// 1) 去重：同一 message_id 连发两次，只允许产生一个回合、一条回传
const dupId = `probe-dup-${Date.now()}`;
const dupText = '测试4（探针去重）';
const dupRepliesBefore = replies().length;
const dupPromptsBefore = before?.counters.prompts ?? null;
peer.send(frame({ id: dupId, text: dupText }));
await sleep(600);
peer.send(frame({ id: dupId, text: dupText }));
const dupReply = await waitForReply(dupRepliesBefore, () => true, { label: 'dup reply' });
const dupRepliesAfter = replies().length;
await sleep(2500); // 给「如果去重失效」的第二个回合留出发回时间
check('去重：重复 message_id 只回传一条', replies().length === dupRepliesAfter,
  `首次回复="${String(dupReply.params?.message ?? '').slice(0, 30)}" 回传数=${replies().length}`);

// 2) 图片：图片必须真正进会话（拿到图片字节 + 有一条回传，不静默）
const imageReplyBefore = replies().length;
peer.send(frame({ id: `probe-img-${Date.now()}`, segments: [{ type: 'image', data: { file: 'probe.png', url: imageUrl } }] }));
let imageReply = null;
try {
  imageReply = await waitForReply(imageReplyBefore, () => true, { label: 'image reply' });
} catch {
  imageReply = null;
}
const imageText = String(imageReply?.params?.message ?? '');
check('图片：进会话并回传（不是「不支持」也不再静默）', Boolean(imageReply) && !imageText.includes('下载失败'),
  imageReply ? `回复="${imageText.slice(0, 60)}"` : '没有回传');

// 3) 不支持的媒体（语音）：回执「目前仅支持文本消息」
const mediaBefore = replies().length;
peer.send(frame({
  id: `probe-media-${Date.now()}`,
  segments: [{ type: 'record', data: { file: 'probe.amr' } }],
}));
let notice = null;
try {
  notice = await waitForReply(mediaBefore, (a) => String(a.params?.message ?? '').includes('仅支持文本'), { label: 'media notice', timeoutMs: 20000 });
} catch {
  notice = null;
}
check('语音：回执「目前仅支持文本消息」', Boolean(notice), notice ? `notice="${notice.params.message}"` : '没收到回执');

// 4) 反回环：回合稳定后计数不再长（网关自己的回传不会被当成新输入）
await sleep(3000);
const mid = await readStatus();
await sleep(1500);
const after = await readStatus();
if (after?.counters && before) {
  const delta = (key) => (after.counters[key] ?? 0) - (before.counters?.[key] ?? 0);
  check('去重计数', delta('dedupeHits') >= 1, `dedupeHits +${delta('dedupeHits')}`);
  check('图片被下载并投递', delta('imageParts') >= 1, `imageParts +${delta('imageParts')} imageFailures +${delta('imageFailures')}`);
  check('媒体回执计数', delta('unsupportedNotified') >= 1, `unsupportedNotified +${delta('unsupportedNotified')}`);
  check('反回环：无外部回合被回传', delta('skippedForeign') === 0, `skippedForeign +${delta('skippedForeign')}`);
  check('反回环：回合稳定后无新投递', (mid.counters?.prompts ?? 0) === after.counters.prompts,
    `prompts 中段=${mid.counters?.prompts} 末段=${after.counters.prompts}`);
  console.log(`INFO peers=${after.peers} openTurns=${after.openTurns} prompts +${delta('prompts')} accepted +${delta('promptsAccepted')} errors +${delta('promptErrors')} relayed +${delta('relayed')}`);
  if (dupPromptsBefore !== null) console.log(`INFO 去重回合：prompts 起点=${dupPromptsBefore}`);
}

peer.close(1000);
imageServer.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n探针结果：${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length ? 1 : 0;
