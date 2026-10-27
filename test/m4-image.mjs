// M4.1 离线验收：主号发的图片能真正进 DSH 会话（image 内容块），不支持的媒体仍回执。
// 覆盖：url 下载 / get_image 动作兜底 / 文本+图片 / 图片下载失败的回执 / 语音仍回执 / 计数自洽。
// 跑法：node ~/.dsh/bundles/dsh-qq-gateway/test/m4-image.mjs
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { createFakeDsh } from './fake-dsh.mjs';
import { connectFakeNapCat } from './fake-napcat.mjs';
import { createGateway } from '../lib/gateway/gateway.js';
import { DROP, extractImageSegments, parseInbound } from '../lib/gateway/protocol.js';
import { sniffMediaType } from '../lib/gateway/media.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const MAIN_QQ = 10001;
const BOT_QQ = 10002;
const TOKEN = 'm4-image-token';
const PATH = '/onebot';
const SESSION = 'session-fake-target';

// 1x1 透明 PNG（合法图片字节，宿主会照常收）
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');

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
function bodyOf(content) {
  const text = content?.[0]?.text ?? '';
  const sep = text.indexOf('\n\n');
  return sep === -1 ? text : text.slice(sep + 2);
}

/** 假 fetch：只认约定的测试域名，返回 PNG 字节或失败。 */
const fakeFetchCalls = [];
async function fakeFetch(url) {
  fakeFetchCalls.push(url);
  if (url.includes('/broken')) {
    return { ok: false, status: 502, arrayBuffer: async () => new ArrayBuffer(0) };
  }
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength),
  };
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
};

const fake = createFakeDsh({ sessionId: SESSION });
fake.emitSeed();
const logs = [];
const gw = createGateway({
  ctx: fake.ctx,
  config: cfgBase,
  logger: (m) => logs.push(m),
  // 2026-10-27：媒体 URL 现在要过 SSRF 校验，测试域名注入假 DNS 避免真解析
  deps: { fetchImpl: fakeFetch, imageTimeoutMs: 400, resolveHost: async () => ['93.184.216.34'] },
});
await gw.start();
const url = `ws://127.0.0.1:${gw.port()}${PATH}`;
const nc = await connectFakeNapCat({ url, token: TOKEN, botQQ: BOT_QQ, mainQQ: MAIN_QQ });
await waitFor(() => gw.status().peers >= 1, { label: 'peer registered' });

/** 等宿主收到下一条 prompt，并带上它的 content。 */
async function nextPrompt(label) {
  const before = fake.calls.prompt.length;
  await waitFor(() => fake.calls.prompt.length === before + 1, { label, timeoutMs: 4000 });
  return fake.calls.prompt[before];
}
async function answerLast(replyText = '收到图片了') {
  const index = fake.calls.prompt.length - 1;
  const turn = fake.startTurnFor(fake.calls.prompt[index].requestId, { replyText, stepMs: 5 });
  await turn.done;
}

console.log('=== M4.1：图片段解析（纯逻辑） ===');

await check('extractImageSegments：抽出 file/url，非图片段忽略', () => {
  const images = extractImageSegments([
    { type: 'text', data: { text: 'hi' } },
    { type: 'image', data: { file: 'a.png', url: 'https://x/a.png', summary: '[图片]' } },
    { type: 'record', data: { file: 'v.amr' } },
    { type: 'image', data: {} },
  ]);
  assert.deepEqual(images, [
    { file: 'a.png', url: 'https://x/a.png', summary: '[图片]' },
    { file: '', url: '', summary: '' },
  ]);
});

await check('parseInbound：图片帧放行并带出 images，语音帧仍按媒体丢弃', () => {
  const base = {
    post_type: 'message', message_type: 'private', user_id: MAIN_QQ, self_id: BOT_QQ, message_id: 1,
  };
  const image = parseInbound({ ...base, message: [{ type: 'image', data: { file: 'a.png', url: 'https://x/a.png' } }] }, cfgBase);
  assert.equal(image.ok, true);
  assert.equal(image.msg.text, '');
  assert.deepEqual(image.msg.images, [{ file: 'a.png', url: 'https://x/a.png', summary: '' }]);
  assert.deepEqual(image.msg.media, []);

  const voice = parseInbound({ ...base, message: [{ type: 'record', data: { file: 'v.amr' } }] }, cfgBase);
  assert.equal(voice.ok, false);
  assert.equal(voice.reason, DROP.EMPTY_TEXT);
  assert.deepEqual(voice.media, ['record']);
});

await check('sniffMediaType：png/jpeg/gif/webp 认得出', () => {
  assert.equal(sniffMediaType(PNG_BYTES), 'image/png');
  assert.equal(sniffMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(sniffMediaType(Buffer.from('GIF89a............')), 'image/gif');
  assert.equal(sniffMediaType(Buffer.from('RIFF0000WEBP....')), 'image/webp');
  assert.equal(sniffMediaType(Buffer.from('not an image at all')), '');
});

console.log('\n=== M4.1：图片真正投进会话 ===');

await check('纯图片：下载 url → 宿主收到 image 内容块（不是「不支持」回执）', async () => {
  nc.sendImageOnly({ messageId: 3001, file: 'pic.png', url: 'https://img.example.com/img/pic.png' });
  const call = await nextPrompt('image prompt');
  assert.equal(call.request.content.length, 2, '来源说明 + 图片两个块');
  assert.match(call.request.content[0].text, /^【QQ私聊】主号：/);
  const part = call.request.content[1];
  assert.equal(part.type, 'image');
  assert.equal(part.mediaType, 'image/png');
  assert.equal(part.data, PNG_BASE64);
  assert.equal(part.name, 'qq-image.png');
  assert.equal(gw.counters.imageParts, 1);
  assert.equal(gw.counters.imageFailures, 0);
  assert.equal(gw.counters.unsupportedNotified, 0, '图片不该再回「不支持」');
  await answerLast('收到图片了');
  await waitFor(() => nc.replies().length === 1, { label: 'image relay' });
  assert.equal(nc.replies()[0].params.message, '收到图片了');
  return `imagePart=${part.mediaType} ${part.data.length}B`;
});

await check('文本+图片：两个内容块按顺序投递，回传正常', async () => {
  const before = fake.calls.prompt.length;
  nc.sendMixed({ text: '这张图是什么', messageId: 3002, file: 'pic.png', url: 'https://img.example.com/img/pic.png' });
  await waitFor(() => fake.calls.prompt.length === before + 1, { label: 'mixed prompt' });
  const content = fake.calls.prompt[before].request.content;
  assert.deepEqual(content.map((p) => p.type), ['text', 'image']);
  assert.equal(bodyOf(content), '这张图是什么');
  assert.equal(content[1].data, PNG_BASE64);
  await answerLast('这是测试图');
  await waitFor(() => nc.replies().length === 2, { label: 'mixed relay' });
  assert.equal(nc.replies()[1].params.message, '这是测试图');
  return `content=${content.map((p) => p.type).join('+')}`;
});

await check('只有 file 没有 url：走 get_image 动作兜底，拿到 base64:// 后照样投递', async () => {
  const before = fake.calls.prompt.length;
  nc.sendImageOnly({ messageId: 3003, file: 'local-only.jpg' });
  const action = await nc.waitForAction((a) => a.action === 'get_image', { label: 'get_image action' });
  nc.respondToAction({ echo: action.echo, data: { file: `base64://${PNG_BASE64}` } });
  await waitFor(() => fake.calls.prompt.length === before + 1, { label: 'prompt via get_image' });
  const content = fake.calls.prompt[before].request.content;
  assert.equal(content.length, 2, '来源说明 + 图片两个块');
  assert.equal(content[1].type, 'image');
  assert.equal(content[1].data, PNG_BASE64);
  assert.ok(logs.some((m) => m.includes('image resolved (get_image')), '日志要标明来源是 get_image');
  await answerLast('收到，图片已解析');
  await waitFor(() => nc.replies().length === 3, { label: 'get_image relay' });
  return `source=get_image action=${action.action}`;
});

console.log('\n=== M4.1：失败路径（不静默） ===');

await check('图片下载失败且没有正文：回主号「图片没能接收」，不投宿主、不占闸门', async () => {
  const promptsBefore = fake.calls.prompt.length;
  const repliesBefore = nc.replies().length;
  nc.sendImageOnly({ messageId: 3004, file: 'broken.jpg', url: 'https://img.example.com/broken.jpg' });
  await waitFor(() => nc.replies().length === repliesBefore + 1, { label: 'failure notice' });
  const notice = nc.replies()[repliesBefore];
  assert.equal(notice.params.message, '图片没能接收（下载失败），重发一次或改发文字吧');
  assert.equal(fake.calls.prompt.length, promptsBefore, '图片没拿到就不该投给宿主');
  assert.equal(gw.counters.imageFailures, 1);
  assert.equal(gw.status().busy, false, '失败不能卡住单飞闸门');
  return `notice="${notice.params.message}"`;
});

await check('图片失败但有正文：正文照投，不额外刷回执', async () => {
  const before = fake.calls.prompt.length;
  const repliesBefore = nc.replies().length;
  nc.sendMixed({ text: '虽然图挂了但文字还在', messageId: 3005, file: 'broken.jpg', url: 'https://img.example.com/broken.jpg' });
  await waitFor(() => fake.calls.prompt.length === before + 1, { label: 'text-only prompt' });
  assert.equal(fake.calls.prompt[before].request.content.length, 1);
  assert.equal(bodyOf(fake.calls.prompt[before].request.content), '虽然图挂了但文字还在');
  await delay(120);
  assert.equal(nc.replies().length, repliesBefore, '有正文就不该再发失败回执');
  assert.equal(gw.counters.imageFailures, 2);
  await answerLast('好的，只有文字也处理');
  await waitFor(() => nc.replies().length === repliesBefore + 1, { label: 'text relay' });
  return `imageFailures=${gw.counters.imageFailures}`;
});

await check('语音仍然回执「目前仅支持文本消息」（图片支持不改变不支持的媒体行为）', async () => {
  const repliesBefore = nc.replies().length;
  nc.sendVoiceOnly({ messageId: 3006 });
  await waitFor(() => nc.replies().length === repliesBefore + 1, { label: 'voice notice' });
  assert.equal(nc.replies()[repliesBefore].params.message, '目前仅支持文本消息');
  assert.equal(gw.counters.unsupportedNotified, 1);
  return 'voice notice ok';
});

await nc.close();
await gw.stop();

const failed = results.filter((r) => !r.ok);
const evidence = {
  milestone: 'M4.1',
  kind: '图片消息进会话（离线验收）',
  at: new Date().toISOString(),
  node: process.version,
  totals: { checks: results.length, passed: results.length - failed.length, failed: failed.length },
  results,
  counters: { ...gw.counters },
  fetchCalls: fakeFetchCalls,
  notes: [
    '图片走 url → base64:// file → http file → get_image 动作 四级兜底',
    '宿主自己做图片归一化/落盘；网关只负责拿到合法字节并判对 mediaType',
    '图片失败时：有正文就投正文，没正文就回主号一句失败提示，绝不静默',
  ],
};
writeFileSync(join(ROOT, 'm4-image-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
console.log(`证据：${join(ROOT, 'm4-image-evidence.json')}`);
process.exitCode = failed.length ? 1 : 0;
