// M14 生产调用链校验（2026-10-27，评审第四轮）。
//   评审原话：实际媒体调用仍把默认 fetch 传入，走到了测试下载分支，因此连接地址绑定和逐跳大小限制
//   没有生效；请再检查 6to4 地址中的 IPv4 提取，并补充覆盖生产调用链的测试。
// 覆盖：
//   1) 6to4 / NAT64 本地用途 / IPv4 转译 / ISATAP 的内嵌 IPv4 提取（回归：之前取尾部字节）；
//   2) safeFetchMedia 的通道选择（未注入 → node-http；注入全局 fetch → 仍 node-http；注入假 fetch → fetch）；
//   3) 真网关生产调用链（不注入 fetchImpl，全局 fetch 换成会抛错的桩）：
//      入站图片下载 / 出站非主号 URL 图片代下载 / 流式限长 / 重定向逐跳重新校验。
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createFakeDsh } from './fake-dsh.mjs';
import { connectFakeNapCat } from './fake-napcat.mjs';
import { createGateway } from '../lib/gateway/gateway.js';
import { isPrivateIp, safeFetchMedia } from '../lib/gateway/url-guard.js';

const MAIN_QQ = 10001;
const BOT_QQ = 10002;
const TOKEN = 'm14-token';
const PATH = '/onebot';
const SESSION = 'session-fake-target';
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
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

// ---------------------------------------------------------------------------
// 1) IPv6 过渡形态的内嵌 IPv4 提取
// ---------------------------------------------------------------------------
await check('6to4：内嵌 IPv4 从第 3–6 字节取（尾部是公网字节也算私网）', async () => {
  // 内嵌 192.168.1.1，尾部是 8.8.8.8 —— 旧代码取尾部字节会误判成公网
  for (const ip of [
    '2002:c0a8:101:808:808:808:808:808',
    '2002:0a00:0001::1',
    '2002:7f00:0001::1',
    '2002:ac10:0001:0:0:0:0:1',
    '2002:a9fe:0001::1',
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} 应判私（内嵌 IPv4 是私网）`);
  }
  // 内嵌公网 IPv4 的 6to4 仍放行
  for (const ip of ['2002:808:808::1', '2002:410:0001::1', '2002:2606:4700:0:0:0:0:1']) {
    assert.equal(isPrivateIp(ip), false, `${ip} 应判公（内嵌 IPv4 是公网）`);
  }
  return '6to4 取字节 2–5';
});

await check('其他过渡形态：NAT64 本地用途整段拒 / IPv4 转译 / ISATAP', async () => {
  assert.equal(isPrivateIp('64:ff9b:1::1'), true, '64:ff9b:1::/48 是本地用途，应拒');
  assert.equal(isPrivateIp('::ffff:0:10.0.0.1'), true, 'IPv4 转译内嵌私网，应拒');
  assert.equal(isPrivateIp('::ffff:0:8.8.8.8'), false, 'IPv4 转译内嵌公网，应放');
  assert.equal(isPrivateIp('2001:4860:4860:0:0:5efe:10.0.0.1'), true, 'ISATAP 内嵌私网，应拒');
  assert.equal(isPrivateIp('2001:4860:4860:0:0:5efe:8.8.8.8'), false, 'ISATAP 内嵌公网，应放');
  return '5 种形态';
});

// ---------------------------------------------------------------------------
// 本地测试服务器（只监听 127.0.0.1）
// ---------------------------------------------------------------------------
const stats = { requests: 0, aborted: 0, uas: [] };
const server = http.createServer((req, res) => {
  stats.requests += 1;
  stats.uas.push(String(req.headers['user-agent'] ?? ''));
  const remote = req.socket.remoteAddress ?? '';
  if (req.url === '/ok.png') {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG_BYTES.length });
    res.end(PNG_BYTES);
    return;
  }
  if (req.url === '/redir-file') {
    res.writeHead(302, { location: 'file:///C:/Windows/win.ini' });
    res.end();
    return;
  }
  if (req.url === '/redir-loop') {
    res.writeHead(302, { location: '/redir-loop' });
    res.end();
    return;
  }
  if (req.url === '/big') {
    res.writeHead(200, { 'content-type': 'image/png' }); // 故意不给 content-length
    const chunk = Buffer.alloc(65536, 0x41);
    let sent = 0;
    res.on('error', () => {});
    const timer = setInterval(() => {
      if (sent >= 2 * 1024 * 1024) {
        clearInterval(timer);
        res.end();
        return;
      }
      sent += chunk.length;
      try {
        res.write(chunk);
      } catch {
        clearInterval(timer);
      }
    }, 5);
    res.on('close', () => {
      clearInterval(timer);
      if (!res.writableEnded) stats.aborted += 1;
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;

// ---------------------------------------------------------------------------
// 2) 通道选择
// ---------------------------------------------------------------------------
const TMP = mkdtempSync(join(tmpdir(), 'm14-'));

try {
  await check('传输通道：不注入 fetch 走 node-http（钉 IP + 流式限长生效）', async () => {
    const result = await safeFetchMedia(`http://127.0.0.1:${PORT}/ok.png`, { allowPrivate: true, timeoutMs: 3000 });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.transport, 'node-http');
    assert.equal(Buffer.compare(result.bytes, PNG_BYTES), 0);
    return `transport=${result.transport}`;
  });

  await check('传输通道：把全局 fetch 当注入传进来，也必须回落到 node-http', async () => {
    const result = await safeFetchMedia(`http://127.0.0.1:${PORT}/ok.png`, {
      allowPrivate: true, timeoutMs: 3000, fetchImpl: globalThis.fetch,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.transport, 'node-http', '传全局 fetch 不许走测试分支');
    return '全局 fetch 被识别为「没注入」';
  });

  await check('传输通道：注入假 fetch 才走 fetch 分支（离线测试用）', async () => {
    const fake = async () => ({
      ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength),
    });
    const result = await safeFetchMedia('https://img.example.com/a.png', {
      allowPrivate: false, timeoutMs: 3000, fetchImpl: fake, resolveHost: async () => ['93.184.216.34'],
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.transport, 'fetch');
    return '假 fetch 仍可用';
  });

  // -------------------------------------------------------------------------
  // 3) 真网关生产调用链：全局 fetch 换成会抛错的桩，看还能不能跑通
  // -------------------------------------------------------------------------
  const realFetch = globalThis.fetch;
  let globalFetchCalls = 0;
  globalThis.fetch = () => {
    globalFetchCalls += 1;
    throw new Error('全局 fetch 不该被媒体下载调用');
  };

  const fake = createFakeDsh({ sessionId: SESSION });
  fake.emitSeed();
  const baseCfg = {
    replyDelayMode: 'off',
    host: '127.0.0.1', port: 0, path: PATH, token: TOKEN,
    mainQQ: MAIN_QQ, botQQ: BOT_QQ, sessionId: SESSION,
    maxQueue: 8, turnTimeoutMs: 5000,
    statusEnabled: false,
    logFilePath: join(TMP, 'gw.log'),
    allowListPath: join(TMP, 'allow.json'),
    muteStatePath: join(TMP, 'mute.json'),
    outboxDir: join(TMP, 'outbox'),
    // 测试要连 127.0.0.1；DNS 也注入，避免真解析
    mediaUrlAllowPrivate: true,
    maxSendImageBytes: 10 * 1024 * 1024,
    sendTimeoutMs: 5000,
  };
  const resolveHost = async () => ['127.0.0.1'];
  // 注意：deps 里**没有** fetchImpl —— 这就是生产形态
  const gw = createGateway({ ctx: fake.ctx, config: baseCfg, logger: () => {}, deps: { resolveHost, imageTimeoutMs: 4000 } });
  let nc;
  try {
    await gw.start();
    nc = await connectFakeNapCat({ url: `ws://127.0.0.1:${gw.port()}${PATH}`, token: TOKEN, botQQ: BOT_QQ, mainQQ: MAIN_QQ });
    nc.startAutoRespond(); // send_* 之类动作要回 message_id，否则网关自己会算超时
    await waitFor(() => gw.status().peers >= 1, { label: 'peer registered' });

    await check('生产链（入站）：伪造帧里的图片 URL 由 node-http 通道下载，宿主收到 image 内容块', async () => {
      const uaBefore = stats.uas.length;
      const before = fake.calls.prompt.length;
      nc.sendImageOnly({ messageId: 4001, file: 'pic.png', url: `http://img.example.com:${PORT}/ok.png` });
      await waitFor(() => fake.calls.prompt.length === before + 1, { label: 'inbound prompt' });
      const prompt = fake.calls.prompt[before];
      const content = prompt.request.content ?? [];
      const image = content.find((part) => part.type === 'image');
      assert.ok(image, `宿主没收到 image 内容块：${JSON.stringify(content).slice(0, 160)}`);
      assert.equal(Buffer.from(image.data, 'base64').length, PNG_BYTES.length);
      assert.ok(stats.uas.slice(uaBefore).includes('dsh-qq-gateway/1.0'), '本地服务器没看到网关的 UA，说明没走 node:http');
      const turn = fake.startTurnFor(prompt.requestId, { replyText: '收到图了', stepMs: 5 });
      await turn.done;
      return '入站走生产通道';
    });

    await check('生产链（出站）：非主号 URL 图片由网关代下载后以 base64 发出', async () => {
      const uaBefore = stats.uas.length;
      await gw.sendMessage({
        source: 'private', userId: 20001, via: 'tool',
        parts: [{ type: 'image', url: `http://img.example.com:${PORT}/ok.png` }],
      });
      assert.ok(stats.uas.slice(uaBefore).includes('dsh-qq-gateway/1.0'), '没走 node:http 生产通道');
      const action = await nc.waitForAction((item) => item.action === 'send_private_msg' && JSON.stringify(item).includes('base64://'), {
        label: 'send_private_msg(base64)',
      });
      assert.ok(action, 'NapCat 没收到 base64 图片段');
      return '出站走生产通道';
    });

    await check('生产链：流式大小上限真的生效（读的过程中就断，不等收完）', async () => {
      const abortedBefore = stats.aborted;
      const gwSmall = createGateway({
        ctx: fake.ctx,
        config: { ...baseCfg, maxSendImageBytes: 1024 },
        logger: () => {},
        deps: { resolveHost, imageTimeoutMs: 4000 },
      });
      try {
        const err = await gwSmall.sendMessage({
          source: 'private', userId: 20001, via: 'tool',
          parts: [{ type: 'image', url: `http://img.example.com:${PORT}/big` }],
        }).then(() => null, (e) => e);
        assert.ok(err instanceof Error, '超限应抛错');
        assert.match(String(err.message), /过大/, String(err.message));
        await delay(300);
        assert.ok(stats.aborted > abortedBefore, '服务端应观察到连接被中途掐断');
      } finally {
        await gwSmall.stop();
      }
      return '边读边限生效';
    });

    await check('生产链：重定向每一跳都重新校验（第 2 跳 file:// 被拒）', async () => {
      const before = stats.requests;
      const err = await gw.sendMessage({
        source: 'private', userId: 20001, via: 'tool',
        parts: [{ type: 'image', url: `http://img.example.com:${PORT}/redir-file` }],
      }).then(() => null, (e) => e);
      assert.ok(err instanceof Error, '重定向到 file:// 应被拒');
      assert.match(String(err.message), /http\/https/, String(err.message));
      assert.equal(stats.requests, before + 1, '只该请求第一跳');
      return '逐跳校验生效';
    });

    await check('生产链：重定向死循环按跳数上限拒绝', async () => {
      const err = await gw.sendMessage({
        source: 'private', userId: 20001, via: 'tool',
        parts: [{ type: 'image', url: `http://img.example.com:${PORT}/redir-loop` }],
      }).then(() => null, (e) => e);
      assert.ok(err instanceof Error, '死循环应被拒');
      assert.match(String(err.message), /重定向/, String(err.message));
      return '跳数上限生效';
    });

    await check('整条链路没有碰过全局 fetch', async () => {
      assert.equal(globalFetchCalls, 0, `全局 fetch 被调用了 ${globalFetchCalls} 次`);
      return '全局 fetch 调用次数 0';
    });
  } finally {
    globalThis.fetch = realFetch;
    try {
      if (nc) nc.close?.();
      await gw.stop();
    } catch {
      // 收尾失败不影响结论
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(TMP, { recursive: true, force: true });
}

const failed = results.filter((item) => !item.ok);
console.log(`\nM14 生产调用链校验：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.error('失败项：', failed.map((item) => item.name).join(' | '));
  process.exit(1);
}
console.log('ALL PASS');
