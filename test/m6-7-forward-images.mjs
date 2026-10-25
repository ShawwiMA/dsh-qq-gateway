// M6.7 离线验收：合并转发节点里的图片能真下载下来投给模型。
// 覆盖：编号收集（maxImages 上限、编号与条数/发送者对应）/ maxImages=0 保持旧标签 /
//       网关把图片作为 image 内容块投递 + 映射说明 / 下载失败占位 / 单段最多 9 张 / inline 展开 /
//       文字+转发+直发图混合 / 计数自洽。
// 跑法：node ~/.dsh/bundles/dsh-qq-gateway/test/m6-7-forward-images.mjs
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { createFakeDsh } from './fake-dsh.mjs';
import { connectFakeNapCat } from './fake-napcat.mjs';
import { createGateway } from '../lib/gateway/gateway.js';
import { formatForwardNodes } from '../lib/gateway/protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const MAIN_QQ = 10001;
const BOT_QQ = 10002;
const TOKEN = 'm6-7-token';
const PATH = '/onebot';
const SESSION = 'session-fake-target';

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');
const PNG_BUF = PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength);

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
async function waitFor(fn, { timeoutMs = 5000, label = 'condition', intervalMs = 5 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout ${timeoutMs}ms waiting for ${label}`);
    await delay(intervalMs);
  }
}

const img = (url) => ({ type: 'image', data: { file: url.split('/').pop(), url } });
const text = (t) => ({ type: 'text', data: { text: t } });
const node = (who, ...segs) => ({ sender: { nickname: who }, message: segs });

const NODES_MIX = [
  node('小明', text('第一条')),
  node('群友甲', text('看这个'), img('https://fake.local/pic1.png'), img('https://fake.local/pic2.png')),
  node('小红', img('https://fake.local/pic3.png')),
  node('小红', img('https://fake.local/pic4.png')),
];

console.log('=== M6.7：转发节点图片编号收集（纯逻辑） ===');

await check('formatForwardNodes(maxImages=3)：图片编号 [图片1..3]，带所属条数与发送者', () => {
  const out = formatForwardNodes(NODES_MIX, { maxImages: 3 });
  assert.equal(out.text, '1. 小明：第一条\n2. 群友甲：看这个[图片1][图片2]\n3. 小红：[图片3]\n4. 小红：[图片]');
  assert.equal(out.images.length, 3);
  assert.deepEqual(out.images.map((i) => [i.label, i.nodeIndex, i.who, i.url]), [
    ['图片1', 2, '群友甲', 'https://fake.local/pic1.png'],
    ['图片2', 2, '群友甲', 'https://fake.local/pic2.png'],
    ['图片3', 3, '小红', 'https://fake.local/pic3.png'],
  ]);
});

await check('maxImages=0（默认）：保持旧的 [图片] 标签，不收集', () => {
  const out = formatForwardNodes(NODES_MIX);
  assert.equal(out.images.length, 0);
  assert.match(out.text, /2\. 群友甲：看这个\[图片\]\[图片\]/);
});

await check('截断/超上限时：只收集展示出来的节点、单段最多 maxImages 张', () => {
  const many = Array.from({ length: 12 }, (_, i) => node(`人${i + 1}`, img(`https://fake.local/m${i + 1}.png`)));
  const capped = formatForwardNodes(many, { maxImages: 9 });
  assert.equal(capped.images.length, 9);
  assert.match(capped.text, /9\. 人9：\[图片9\]\n10\. 人10：\[图片\]/);

  const short = formatForwardNodes(NODES_MIX, { maxNodes: 2, maxImages: 5 });
  assert.equal(short.shown, 2);
  assert.equal(short.images.length, 2, '第 3/4 条被截断，图也不该收集');
});

console.log('\n=== M6.7：网关把转发里的图片投给模型 ===');

const fake = createFakeDsh({ sessionId: SESSION });
fake.emitSeed();
const logs = [];
const fetched = [];
async function fakeFetch(url) {
  fetched.push(url);
  if (url.includes('broken')) return { ok: false, status: 502, arrayBuffer: async () => new ArrayBuffer(0) };
  return { ok: true, status: 200, arrayBuffer: async () => PNG_BUF };
}
const gw = createGateway({
  ctx: fake.ctx,
  config: {
    host: '127.0.0.1', port: 0, path: PATH, token: TOKEN, mainQQ: MAIN_QQ, botQQ: BOT_QQ,
    sessionId: SESSION, maxQueue: 8, turnTimeoutMs: 5000, ridTtlMs: 30 * 60 * 1000, replyDelayMode: 'off',
  },
  logger: (m) => logs.push(m),
  deps: { fetchImpl: fakeFetch, imageTimeoutMs: 500 },
});
await gw.start();
const url = `ws://127.0.0.1:${gw.port()}${PATH}`;
const nc = await connectFakeNapCat({ url, token: TOKEN, botQQ: BOT_QQ, mainQQ: MAIN_QQ });
await waitFor(() => gw.status().peers >= 1, { label: 'peer registered' });
// get_forward_msg 手动回包（要分别造成功/失败/inline）
nc.startAutoRespond((action) => (action.action === 'get_forward_msg' ? false : undefined));

let messageId = 7100;
async function sendForward({ id, nodes = NODES_MIX, status = 'ok', retcode = 0, text: caption = '' } = {}) {
  const before = fake.calls.prompt.length;
  const segments = caption ? [text(caption), { type: 'forward', data: { id } }] : [{ type: 'forward', data: { id } }];
  messageId += 1;
  nc.sendSegments({ segments, messageId });
  const action = await nc.waitForAction(
    (a) => a.action === 'get_forward_msg' && String(a.params?.message_id ?? '') === String(id),
    { label: `get_forward_msg(${id})` },
  );
  nc.respondToAction({ echo: action.echo, data: { messages: nodes }, status, retcode });
  await waitFor(() => fake.calls.prompt.length === before + 1, { label: 'forward prompt' });
  const turn = fake.startTurnFor(fake.calls.prompt[before].requestId, { replyText: '收到', stepMs: 5 });
  await turn.done;
  return fake.calls.prompt[before].request.content;
}

await check('转发含 4 张图：正文编号 + 映射说明 + 4 个 image 内容块（真下载）', async () => {
  const content = await sendForward({ id: 'FWD-IMG' });
  assert.deepEqual(content.map((p) => p.type), ['text', 'text', 'text', 'image', 'image', 'image', 'image']);
  assert.match(content[0].text, /^【QQ私聊】主号：/);
  assert.match(content[1].text, /^\[合并转发\] 共 4 条\n/);
  assert.match(content[2].text, /^\[合并转发里的图片\] 图片1=第2条（群友甲）；图片2=第2条（群友甲）；图片3=第3条（小红）；图片4=第4条（小红）$/);
  for (const part of content.slice(3)) {
    assert.equal(part.type, 'image');
    assert.equal(part.mediaType, 'image/png');
    assert.ok(part.data.length > 50, 'base64 图片字节要真填进去');
  }
  assert.equal(fetched.filter((u) => u.includes('fake.local/pic')).length, 4, '4 张都要走下载');
  assert.equal(gw.counters.forwardImages, 4);
  assert.equal(gw.counters.forwardImageFailures, 0);
  assert.ok(logs.some((m) => /forward image resolved \(图片4, node=4/.test(m)), '日志要有每张图的解析结果');
});

await check('图片下载失败：占位说明写清哪张失败，正文照常投递，不算整条失败', async () => {
  const nodes = [node('小明', text('看这个'), img('https://fake.local/broken.png')), node('小红', text('好'))];
  const content = await sendForward({ id: 'FWD-BROKEN', nodes });
  const types = content.map((p) => p.type);
  assert.deepEqual(types, ['text', 'text', 'text', 'text'], '映射 + 失败占位都是文本，没有 image 块');
  assert.match(content[2].text, /^\[合并转发里的图片\] 图片1=第1条（小明）$/);
  assert.match(content[3].text, /^\[图片1 下载失败：/);
  assert.match(content[1].text, /看这个\[图片1\]/);
  assert.equal(gw.counters.forwardImageFailures, 1);
  assert.equal(gw.counters.forwardImages, 4, '成功数不变');
});

await check('一段转发 12 张图：只下载前 9 张，剩下的保留 [图片] 标签', async () => {
  const nodes = Array.from({ length: 12 }, (_, i) => node(`人${i + 1}`, img(`https://fake.local/cap${i + 1}.png`)));
  const content = await sendForward({ id: 'FWD-CAP', nodes });
  const images = content.filter((p) => p.type === 'image');
  assert.equal(images.length, 9);
  assert.match(content[2].text, /图片9=第9条（人9）$/);
  assert.match(content[1].text, /10\. 人10：\[图片\]/);
  assert.equal(gw.counters.forwardImages, 13);
});

await check('文字 + 转发（含图）：来源说明只加一次，直发图和转发图都在', async () => {
  messageId += 1;
  const before = fake.calls.prompt.length;
  const nodes = [node('小红', img('https://fake.local/inline1.png'))];
  nc.sendSegments({
    segments: [
      text('帮我看看聊天记录'),
      img('https://fake.local/direct.png'),
      { type: 'forward', data: { id: 'FWD-MIX' } },
    ],
    messageId,
  });
  const action = await nc.waitForAction((a) => a.action === 'get_forward_msg' && a.params?.message_id === 'FWD-MIX', { label: 'get_forward_msg(FWD-MIX)' });
  nc.respondToAction({ echo: action.echo, data: { messages: nodes }, status: 'ok', retcode: 0 });
  await waitFor(() => fake.calls.prompt.length === before + 1, { label: 'mixed prompt' });
  const content = fake.calls.prompt[before].request.content;
  const turn = fake.startTurnFor(fake.calls.prompt[before].requestId, { replyText: '收到', stepMs: 5 });
  await turn.done;
  assert.deepEqual(content.map((p) => p.type), ['text', 'image', 'text', 'text', 'image']);
  assert.match(content[0].text, /^【QQ私聊】主号：[\s\S]*帮我看看聊天记录$/);
  assert.match(content[2].text, /^\[合并转发\] 共 1 条/);
  assert.match(content[3].text, /^\[合并转发里的图片\] 图片1=第1条（小红）$/);
  assert.equal(gw.counters.forwardImages, 14);
  assert.equal(gw.counters.imageParts, 1);
});

await check('inline 展开（data.content）：不额外调 get_forward_msg，图照样下载', async () => {
  messageId += 1;
  const before = fake.calls.prompt.length;
  const actionsBefore = nc.actions.filter((a) => a.action === 'get_forward_msg').length;
  nc.sendSegments({
    segments: [{ type: 'forward', data: { content: [node('小明', text('看图'), img('https://fake.local/inline2.png'))] } }],
    messageId,
  });
  await waitFor(() => fake.calls.prompt.length === before + 1, { label: 'inline prompt' });
  const content = fake.calls.prompt[before].request.content;
  const turn = fake.startTurnFor(fake.calls.prompt[before].requestId, { replyText: '收到', stepMs: 5 });
  await turn.done;
  assert.deepEqual(content.map((p) => p.type), ['text', 'text', 'text', 'image']);
  assert.match(content[1].text, /^\[合并转发\] 共 1 条\n1\. 小明：看图\[图片1\]$/);
  assert.equal(
    nc.actions.filter((a) => a.action === 'get_forward_msg').length,
    actionsBefore,
    'inline 不该再发 get_forward_msg',
  );
  assert.equal(gw.counters.forwardImages, 15);
});

const failed = results.filter((r) => !r.ok);
const summary = {
  ok: failed.length === 0,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.map((r) => r.name),
  counters: {
    forwardRead: gw.counters.forwardRead,
    forwardImages: gw.counters.forwardImages,
    forwardImageFailures: gw.counters.forwardImageFailures,
    imageParts: gw.counters.imageParts,
  },
};
writeFileSync(join(ROOT, 'm6-7-forward-images-evidence.json'), JSON.stringify({ summary, results }, null, 2));
await gw.stop();
console.log(`\n${summary.ok ? '全部通过' : '有失败'}：${summary.passed}/${summary.total}`);
if (!summary.ok) process.exitCode = 1;
