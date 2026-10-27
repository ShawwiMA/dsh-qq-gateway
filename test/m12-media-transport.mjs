// M12 媒体下载传输层校验（2026-10-27，评审第三轮）。
//   评审原话：还需覆盖 IPv4 映射 IPv6，并校验实际连接地址与重定向；下载也需要在读取过程中执行大小上限。
// 覆盖：IPv6 全形态判定、URL 里的 IPv6 字面量、生产下载路径（node:http 自连）的
//   钉 IP / 远端核对 / 逐跳重定向 / 流式限长；离线全用本地 127.0.0.1 测试服务器。
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

import { assertSafeUrl, isPrivateIp, safeFetchMedia } from '../lib/gateway/url-guard.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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

await check('isPrivateIp：IPv4 映射（两种写法）、兼容、NAT64、6to4、Teredo 全覆盖', async () => {
  const priv = [
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:0a00:0001',
    '::127.0.0.1', '::10.0.0.1',
    '64:ff9b::7f00:1', '64:ff9b::a00:1',
    '2002:7f00:1::', '2002:0a00:1::',
    '2001:0::1', '2001:0000:4136:e378:8000:63bf:3fff:fdd2',
    'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1',
  ];
  for (const ip of priv) assert.equal(isPrivateIp(ip), true, `${ip} 应判私`);
  const pub = ['::ffff:8.8.8.8', '::ffff:808:808', '2001:4860:4860::8888', '2606:4700:4700::1111'];
  for (const ip of pub) assert.equal(isPrivateIp(ip), false, `${ip} 应判公`);
  return `${priv.length} 种私网形态`;
});

await check('assertSafeUrl：带方括号的 IPv6 字面量按同样规则判', async () => {
  for (const bad of ['http://[::ffff:7f00:1]/a.png', 'http://[::1]/a.png', 'http://[64:ff9b::7f00:1]/a.png']) {
    const result = await assertSafeUrl(bad);
    assert.equal(result.ok, false, `${bad} 应被拒绝`);
  }
  const ok = await assertSafeUrl('http://[::ffff:808:808]/a.png');
  assert.equal(ok.ok, true);
  return 'IPv6 URL 校验生效';
});

// ---------------------------------------------------------------------------
// 生产下载路径（未注入 fetchImpl → node:http 自连 + 钉 IP + 流式限长）
// ---------------------------------------------------------------------------
const stats = { requests: 0, aborted: 0, lastRemote: '' };
const server = http.createServer((req, res) => {
  stats.requests += 1;
  stats.lastRemote = req.socket.remoteAddress ?? '';
  if (req.url === '/ok') {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG_BYTES.length });
    res.end(PNG_BYTES);
    return;
  }
  if (req.url === '/redir') {
    res.writeHead(302, { location: '/ok' });
    res.end();
    return;
  }
  if (req.url === '/big') {
    // 2MB，无 content-length，慢速写出：验证边读边限流
    res.writeHead(200, { 'content-type': 'image/png' });
    let sent = 0;
    const chunk = Buffer.alloc(65536, 0x41);
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

try {
  await check('生产路径：allowPrivate 关闭时本机地址在发起请求前就被拒', async () => {
    const before = stats.requests;
    const result = await safeFetchMedia(`http://127.0.0.1:${PORT}/ok`, { allowPrivate: false, timeoutMs: 3000 });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /内网|本机/);
    assert.equal(stats.requests, before, '不该真的发请求');
    return '前置拒绝生效';
  });

  await check('生产路径：域名解析到内网（注入解析器）同样拒绝且不连接', async () => {
    const before = stats.requests;
    const result = await safeFetchMedia('http://inner.example/ok', {
      allowPrivate: false,
      timeoutMs: 3000,
      resolveHost: async () => ['127.0.0.1'],
    });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /内网/);
    assert.equal(stats.requests, before);
    return '解析层拒绝生效';
  });

  await check('生产路径：钉 IP 连接（Host 头用域名，连接走注入的 IP）', async () => {
    const result = await safeFetchMedia(`http://whatever.example:${PORT}/ok`, {
      allowPrivate: true,
      timeoutMs: 3000,
      resolveHost: async () => ['127.0.0.1'],
    });
    assert.equal(result.ok, true);
    assert.equal(result.mediaType, 'image/png');
    assert.equal(Buffer.compare(result.bytes, PNG_BYTES), 0);
    return `bytes=${result.bytes.length} remote=${stats.lastRemote}`;
  });

  await check('生产路径：302 重定向逐跳跟随', async () => {
    const before = stats.requests;
    const result = await safeFetchMedia(`http://127.0.0.1:${PORT}/redir`, {
      allowPrivate: true,
      timeoutMs: 3000,
      resolveHost: async () => ['127.0.0.1'],
    });
    assert.equal(result.ok, true);
    assert.equal(Buffer.compare(result.bytes, PNG_BYTES), 0);
    assert.equal(stats.requests, before + 2, '应发两次请求（跳 + 目标）');
    return '重定向跟随生效';
  });

  await check('生产路径：读取过程中超限立即中断（2MB > 1MB 上限）', async () => {
    const before = stats.requests;
    const abortedBefore = stats.aborted;
    const result = await safeFetchMedia(`http://127.0.0.1:${PORT}/big`, {
      allowPrivate: true,
      maxBytes: 1024 * 1024,
      timeoutMs: 10000,
      resolveHost: async () => ['127.0.0.1'],
    });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /过大/);
    assert.equal(stats.requests, before + 1);
    await delay(300); // 给服务端 close 事件一点时间记账
    assert.ok(stats.aborted > abortedBefore, '服务端应观察到连接被客户端中断');
    return '流式限长生效';
  });

  await check('生产路径：更小的上限同样立即中断', async () => {
    const result = await safeFetchMedia(`http://127.0.0.1:${PORT}/big`, {
      allowPrivate: true,
      maxBytes: 1024,
      timeoutMs: 3000,
      resolveHost: async () => ['127.0.0.1'],
    });
    assert.equal(result.ok, false);
    assert.match(String(result.error), /过大/);
    return '小上限中断生效';
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
}

const failed = results.filter((item) => !item.ok);
console.log(`\nM12 传输层校验：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.error('失败项：', failed.map((item) => item.name).join(' | '));
  process.exit(1);
}
console.log('ALL PASS');
