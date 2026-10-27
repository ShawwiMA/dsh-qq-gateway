// M11 媒体 URL SSRF 校验（2026-10-27，评审 #99 第二轮意见）。
//   评审原话：非主号发送的 HTTP 媒体地址仍可指向协议端的本机或内网服务；请限制这些地址及重定向目标。
// 覆盖：IP/主机名判定、DNS 解析结果判定、重定向逐跳校验、非主号 URL 由网关代下载、网关出站集成。
// 全程离线：假 DNS（resolveHost 注入）+ 假 fetch，不碰真网络。
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeDsh } from './fake-dsh.mjs';
import { createGateway } from '../lib/gateway/gateway.js';
import { buildSegments, TRUSTED_MEDIA } from '../lib/gateway/actions.js';
import { assertSafeUrl, hostLooksLocal, isPrivateIp, safeFetchMedia } from '../lib/gateway/url-guard.js';

const TMP = mkdtempSync(join(tmpdir(), 'm11-qqgw-'));
const MAIN_QQ = 10001;
const SESSION = 'session-m11-target';
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

const PUBLIC_IP = '93.184.216.34';
const resolvePublic = async () => [PUBLIC_IP];
const resolvePrivate = async () => ['10.1.2.3'];
const resolveMixed = async () => [PUBLIC_IP, '127.0.0.1'];

/** 假 fetch：按 URL 脚本返回，记录每次请求的 URL。 */
function makeFetch(script) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const step = script(String(url));
    if (step instanceof Error) throw step;
    return {
      status: step.status ?? 200,
      ok: (step.status ?? 200) >= 200 && (step.status ?? 200) < 300,
      headers: { get: (name) => step.headers?.[name.toLowerCase()] ?? null },
      async arrayBuffer() { return step.body ?? Buffer.from(PNG_BASE64, 'base64'); },
    };
  };
  return { impl, calls };
}

await check('isPrivateIp：私网/回环/链路本地/CGNAT/组播全部判私，公网判公', async () => {
  const priv = ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1',
    '::ffff:127.0.0.1'];
  for (const ip of priv) assert.equal(isPrivateIp(ip), true, `${ip} 应判私`);
  for (const ip of ['8.8.8.8', '93.184.216.34', '2001:4860:4860::8888']) {
    assert.equal(isPrivateIp(ip), false, `${ip} 应判公`);
  }
  return `${priv.length} 个私网地址`;
});

await check('hostLooksLocal：本机名/内网名/单标签名判危险', async () => {
  for (const name of ['localhost', 'host.docker.internal', 'metadata.google.internal', 'printer.local', 'nas.lan', 'intranet', 'foo.internal']) {
    assert.equal(hostLooksLocal(name), true, `${name} 应判本机/内网`);
  }
  for (const name of ['example.com', 'gchat.qpic.cn']) assert.equal(hostLooksLocal(name), false);
  return '主机名规则生效';
});

await check('assertSafeUrl：本机/内网/元数据地址拒绝，公网放行', async () => {
  for (const bad of ['http://127.0.0.1/a.png', 'http://localhost/a.png', 'http://10.0.0.5/a.png',
    'http://192.168.1.2/a.png', 'http://169.254.169.254/latest/meta-data', 'http://host.docker.internal:6099/',
    'http://[::1]/a.png', 'ftp://example.com/a.png', 'file:///C:/x.png']) {
    const result = await assertSafeUrl(bad, { resolveHost: resolvePublic });
    assert.equal(result.ok, false, `${bad} 应被拒绝`);
  }
  const ok = await assertSafeUrl('https://gchat.qpic.cn/a.png', { resolveHost: resolvePublic });
  assert.equal(ok.ok, true);
  return '地址校验生效';
});

await check('assertSafeUrl：域名解析到内网/混合结果也拒绝', async () => {
  const privateResult = await assertSafeUrl('https://evil.example/a.png', { resolveHost: resolvePrivate });
  assert.equal(privateResult.ok, false);
  assert.match(String(privateResult.error), /内网/);
  const mixedResult = await assertSafeUrl('https://evil.example/a.png', { resolveHost: resolveMixed });
  assert.equal(mixedResult.ok, false);
  const dnsFail = await assertSafeUrl('https://broken.example/a.png', { resolveHost: async () => { throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); } });
  assert.equal(dnsFail.ok, false);
  assert.match(String(dnsFail.error), /解析失败/);
  return 'DNS 结果校验生效';
});

await check('safeFetchMedia：重定向到内网被拒，重定向到公网可跟随', async () => {
  const { impl } = makeFetch((url) => (
    url.includes('gchat.qpic.cn')
      ? { status: 302, headers: { location: 'http://127.0.0.1:6099/private' } }
      : { status: 200 }
  ));
  const blocked = await safeFetchMedia('https://gchat.qpic.cn/a.png', {
    fetchImpl: impl, resolveHost: resolvePublic, maxBytes: 1024 * 1024,
  });
  assert.equal(blocked.ok, false);
  assert.match(String(blocked.error), /内网|本机/);

  const chain = makeFetch((url) => (
    url.endsWith('/a.png')
      ? { status: 301, headers: { location: 'https://gchat.qpic.cn/b.png' } }
      : { status: 200, body: Buffer.from(PNG_BASE64, 'base64') }
  ));
  const followed = await safeFetchMedia('https://gchat.qpic.cn/a.png', {
    fetchImpl: chain.impl, resolveHost: resolvePublic, maxBytes: 1024 * 1024,
  });
  assert.equal(followed.ok, true);
  assert.equal(chain.calls.length, 2);
  return '逐跳校验生效';
});

await check('safeFetchMedia：超大响应/超多重定向被拒', async () => {
  const big = makeFetch(() => ({ status: 200, headers: { 'content-length': String(2 * 1024 * 1024) } }));
  const tooBig = await safeFetchMedia('https://gchat.qpic.cn/a.png', {
    fetchImpl: big.impl, resolveHost: resolvePublic, maxBytes: 1024 * 1024,
  });
  assert.equal(tooBig.ok, false);
  assert.match(String(tooBig.error), /过大/);

  const loop = makeFetch(() => ({ status: 302, headers: { location: 'https://gchat.qpic.cn/loop' } }));
  const tooMany = await safeFetchMedia('https://gchat.qpic.cn/loop', {
    fetchImpl: loop.impl, resolveHost: resolvePublic, maxRedirects: 2,
  });
  assert.equal(tooMany.ok, false);
  assert.match(String(tooMany.error), /重定向/);
  return '大小/跳数限制生效';
});

await check('buildSegments：Symbol 受信标记允许非主号发 base64（仅网关内部可伪造）', async () => {
  const policy = { mode: 'main', outboxDir: '', isMain: false, internal: false };
  const denied = buildSegments([{ type: 'image', base64: PNG_BASE64 }], { policy });
  assert.equal(denied.ok, false);
  const allowed = buildSegments([{ type: 'image', base64: PNG_BASE64, [TRUSTED_MEDIA]: true }], { policy });
  assert.equal(allowed.ok, true);
  // JSON 里伪造不了 Symbol
  const forged = JSON.parse(JSON.stringify({ type: 'image', base64: PNG_BASE64 }));
  assert.equal(buildSegments([forged], { policy }).ok, false);
  return 'Symbol 标记生效';
});

await check('网关集成：非主号 URL 图片由网关代下载；内网 URL 直接拒绝', async () => {
  const fake = createFakeDsh({ sessionId: SESSION });
  fake.emitSeed();
  const { impl, calls } = makeFetch((url) => {
    if (url.includes('/redirect')) return { status: 302, headers: { location: 'http://127.0.0.1/private' } };
    return { status: 200, body: Buffer.from(PNG_BASE64, 'base64') };
  });
  const gw = createGateway({
    ctx: fake.ctx,
    config: {
      host: '127.0.0.1', port: 0, path: '/onebot', token: 'm11-token',
      mainQQ: MAIN_QQ, botQQ: 10002, sessionId: SESSION,
      replyDelayMode: 'off', statusEnabled: false,
      logFilePath: join(TMP, 'gw.log'), allowListPath: join(TMP, 'allow.json'),
      muteStatePath: join(TMP, 'mute.json'), outboxDir: join(TMP, 'outbox'),
    },
    logger: () => {},
    deps: { fetchImpl: impl, resolveHost: resolvePublic },
  });
  try {
    const blocked = await gw.sendMessage({
      source: 'private', userId: 20001, parts: [{ type: 'image', url: 'http://127.0.0.1:6099/x.png' }], via: 'tool',
    }).then(() => null, (err) => err);
    assert.ok(blocked instanceof Error, '内网 URL 应抛错');
    assert.match(String(blocked.message), /媒体 URL 被拒绝/);

    const redirectBlocked = await gw.sendMessage({
      source: 'private', userId: 20001, parts: [{ type: 'image', url: 'https://gchat.qpic.cn/redirect' }], via: 'tool',
    }).then(() => null, (err) => err);
    assert.ok(redirectBlocked instanceof Error, '重定向到内网应抛错');
    assert.match(String(redirectBlocked.message), /远程图片获取失败/);

    const ok = await gw.sendMessage({
      source: 'private', userId: 20001, parts: [{ type: 'image', url: 'https://gchat.qpic.cn/ok.png' }], via: 'tool',
    });
    assert.equal(ok.ok, true);
    assert.ok(calls.includes('https://gchat.qpic.cn/ok.png'));
    assert.match(JSON.stringify(ok), /send_private_msg|ok/i);
    return '代下载链路生效';
  } finally {
    await gw.stop();
  }
});

const failed = results.filter((item) => !item.ok);
console.log(`\nM11 SSRF 校验：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.error('失败项：', failed.map((item) => item.name).join(' | '));
  process.exit(1);
}
console.log('ALL PASS');
