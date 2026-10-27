// 媒体 URL 安全层 v2（2026-10-27，评审第三轮）。
//
// 覆盖三层：
//   1) 协议/字面量：只允许 http/https；拒绝私网/回环/链路本地/CGNAT/组播/本机名的**字面量**；
//   2) IPv6 全形态：IPv4-mapped（::ffff:1.2.3.4 与 ::ffff:7f00:1 两种写法）、NAT64(64:ff9b::/96)、
//      6to4(2002::/16)、IPv4-compatible(::1.2.3.4)、Teredo(2001::/32)、ULA、链路本地、组播、文档段；
//   3) 实际连接：生产路径用 node:http/https 自己连接，自定义 lookup 把**经过校验的 IP 钉死**为连接地址，
//      连上后再核对 socket.remoteAddress；重定向逐跳（最多 3 跳）；下载**边读边计数**，超限立即销毁请求。
// 离线测试仍可注入 fetchImpl（假响应），走测试路径；未注入时一律走上面第 3 层。
// 注意：调用方**不许**把 globalThis.fetch 当默认值传进来（会被当成测试注入）；本模块已做防御，
// 传进来的若是全局 fetch 仍然走生产路径。
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

export const DEFAULT_MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const IPV4_PRIVATE = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const LOCAL_HOST_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.lan', '.home.arpa'];
const LOCAL_HOST_NAMES = new Set([
  'localhost', 'localhost.localdomain',
  'host.docker.internal', 'gateway.docker.internal', 'docker.for.win.localhost',
  'metadata.google.internal', 'metadata',
]);

/** IPv4 → 无符号整数；非法返回 null。 */
function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value * 256) + n;
  }
  return value;
}

/** 把 IPv6 解析成 16 字节；支持 :: 压缩与内嵌 IPv4（映射/兼容写法）。非法返回 null。 */
function ipv6Bytes(raw) {
  const lower = String(raw ?? '').toLowerCase().trim();
  if (!lower) return null;
  let head = lower;
  let v4 = null;
  // 内嵌 IPv4 尾部：::ffff:1.2.3.4 / ::1.2.3.4 / 2002:…::1.2.3.4
  const withV4 = /^([0-9a-f:]+):(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (withV4 && withV4[1].includes(':')) {
    head = withV4[1];
    v4 = withV4[2];
  }
  const target = v4 ? 6 : 8; // 内嵌 IPv4 占最后两个 hextet 的位置
  const parts = head.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const zeroRun = parts.length === 2 ? target - left.length - right.length : 0;
  if (parts.length === 2 && zeroRun < 1) return null;
  if (parts.length === 1 && left.length !== target) return null;
  if (left.length + right.length > target) return null;
  const words = [];
  for (const group of [...left, ...Array(zeroRun).fill('0'), ...right]) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    words.push(parseInt(group, 16));
  }
  if (words.length !== target) return null;
  const bytes = [];
  for (const word of words) {
    bytes.push((word >> 8) & 0xff, word & 0xff);
  }
  if (v4) {
    const n = ipv4ToInt(v4);
    if (n === null) return null;
    bytes.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

/** 判断一个 IP 字面量是不是「不该让媒体下载打过去」的地址。 */
export function isPrivateIp(raw) {
  const ip = String(raw ?? '').trim();
  if (!ip) return true;
  const family = isIP(ip);
  if (family === 4) {
    const value = ipv4ToInt(ip);
    if (value === null) return true;
    for (const [base, bits] of IPV4_PRIVATE) {
      const baseValue = ipv4ToInt(base);
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((value & mask) === (baseValue & mask)) return true;
    }
    return false;
  }
  if (family === 6) {
    const bytes = ipv6Bytes(ip);
    if (!bytes) return true;
    const slice = (from, to) => bytes.slice(from, to);
    // 取出指定 4 字节当 IPv4 继续判（各过渡机制的内嵌位置不一样，见下）
    const v4Private = (from) => isPrivateIp(slice(from, from + 4).join('.'));
    if (bytes.every((b) => b === 0)) return true; // ::
    if (slice(0, 12).every((b) => b === 0) && bytes[15] === 1) return true; // ::1
    // IPv4 映射 ::ffff:0:0/96（::ffff:1.2.3.4 与 ::ffff:7f00:1 两种写法都归这里）
    if (slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return v4Private(12);
    // IPv4 转译 ::ffff:0:0:0/96（SIIT），内嵌 IPv4 同样在尾部
    if (slice(0, 8).every((b) => b === 0) && bytes[8] === 0xff && bytes[9] === 0xff
      && bytes[10] === 0x00 && bytes[11] === 0x00) return v4Private(12);
    // IPv4 兼容 ::a.b.c.d
    if (slice(0, 12).every((b) => b === 0)) return v4Private(12);
    if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
      // 64:ff9b:1::/48 是「本地用途」NAT64，不可能是公网目标；/96 形态内嵌 IPv4 在尾部
      if (bytes[4] === 0x00 && bytes[5] === 0x01) return true;
      if (slice(4, 12).every((b) => b === 0)) return v4Private(12);
      return true; // 其他非标准 NAT64 形态一律拒
    }
    // 6to4 2002::/16：内嵌 IPv4 在 **第 3–6 字节**（bits 16–47），不在尾部。
    // 取错位置会把 2002:c0a8:101:808:808:808:808:808（内嵌 192.168.1.1）误判成公网。
    if (bytes[0] === 0x20 && bytes[1] === 0x02) return v4Private(2);
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true; // Teredo 2001::/32
    // ISATAP：接口标识里出现 0000:5efe:<IPv4>
    if (bytes[8] === 0x00 && bytes[9] === 0x00 && bytes[10] === 0x5e && bytes[11] === 0xfe) return v4Private(12);
    if ((bytes[0] & 0xfe) === 0xfc) return true; // ULA fc00::/7
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // link-local fe80::/10
    if ((bytes[0] & 0xff) === 0xff) return true; // multicast
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // 2001:db8::/32 文档
    return false;
  }
  return true;
}

/** 主机名本身是不是明显的本机/内网名。 */
export function hostLooksLocal(host) {
  const name = String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!name) return true;
  if (LOCAL_HOST_NAMES.has(name)) return true;
  if (LOCAL_HOST_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  if (!name.includes('.')) return true;
  return false;
}

/** 默认解析器：返回全部 A/AAAA。 */
async function defaultResolveHost(host) {
  const rows = await lookup(host, { all: true, verbatim: true });
  return rows.map((row) => row.address);
}

/** 不查 DNS 的基础校验：协议 + 字面量 IP + 本机名（allowPrivate=true 仅放行字面量/主机名，不放开 DNS 层）。 */
function checkUrlBasics(raw, allowPrivate = false) {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, error: 'URL 为空' };
  if (value.length > 4096) return { ok: false, error: 'URL 过长（超过 4096 字符）' };
  if (/[\s\u0000-\u001f]/.test(value)) return { ok: false, error: 'URL 里不允许空白或控制字符' };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'URL 解析失败' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `媒体 url 只允许 http/https（收到 ${parsed.protocol}）` };
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!allowPrivate && isPrivateIp(host)) return { ok: false, error: `媒体 url 指向内网/本机地址（${host}），已拒绝` };
    return { ok: true, url: parsed.toString(), hostname: host, parsed };
  }
  if (!allowPrivate && hostLooksLocal(host)) {
    return { ok: false, error: `媒体 url 指向本机/内网主机名（${host}），已拒绝` };
  }
  return { ok: true, url: parsed.toString(), hostname: host, parsed };
}

/**
 * 只做「校验」的入口（主号直传、qq_notice 等不代下载的路径）：
 * 基础校验 + 域名解析结果校验（解析到内网/混合结果也拒）。
 * 注意：这一层管不了 DNS 重绑定；要完全钉死连接地址，走 safeFetchMedia 的生产下载路径。
 */
export async function assertSafeUrl(raw, { allowPrivate = false, resolveHost = defaultResolveHost } = {}) {
  const basics = checkUrlBasics(raw, allowPrivate);
  if (!basics.ok) return basics;
  if (isIP(basics.hostname)) return { ok: true, url: basics.url };
  let addresses;
  try {
    addresses = await resolveHost(basics.hostname);
  } catch (err) {
    return { ok: false, error: `媒体 url 域名解析失败（${basics.hostname}）：${err?.code ?? err?.message ?? 'unknown'}` };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return { ok: false, error: `媒体 url 域名没有解析结果（${basics.hostname}）` };
  }
  if (!allowPrivate) {
    const bad = addresses.find((address) => isPrivateIp(address));
    if (bad) return { ok: false, error: `媒体 url 域名解析到内网/本机地址（${basics.hostname} → ${bad}），已拒绝` };
  }
  return { ok: true, url: basics.url };
}

/** 单次连接：钉 IP + 核对远端 + 流式限长 + 处理重定向。 */
function connectOnce(basics, { connectIp, family, maxBytes, timeoutMs, allowPrivate }) {
  return new Promise((resolve) => {
    const parsed = basics.parsed;
    const mod = parsed.protocol === 'https:' ? https : http;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = mod.request({
      hostname: parsed.hostname, // Host 头 / TLS SNI 仍用域名
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { accept: 'image/*,*/*;q=0.8', 'user-agent': 'dsh-qq-gateway/1.0' },
      servername: parsed.protocol === 'https:' ? parsed.hostname : undefined,
      // 关键：把校验过的 IP 钉成实际连接地址（单次解析，无重绑定窗口）
      // Node 24 的自定义 lookup 回调第二参是地址对象数组（同 dns.lookup all:true 形状）
      lookup: (_host, _opts, callback) => callback(null, [{ address: connectIp, family }]),
      timeout: Math.max(1000, Number(timeoutMs) || 15000),
    }, (res) => {
      // 连上后核对实际远端地址
      const remote = String(res.socket?.remoteAddress ?? '');
      if (remote && !allowPrivate && isPrivateIp(remote)) {
        res.destroy();
        finish({ ok: false, error: `媒体下载连接到了内网地址（${remote}），已断开` });
        return;
      }
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        const location = res.headers.location;
        res.resume();
        if (!location) {
          finish({ ok: false, error: `重定向缺少 Location（HTTP ${status}）` });
          return;
        }
        try {
          finish({ redirect: new URL(location, basics.url).toString() });
        } catch {
          finish({ ok: false, error: '重定向地址解析失败' });
        }
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        finish({ ok: false, error: `媒体下载失败：HTTP ${status}` });
        return;
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        finish({ ok: false, error: `媒体过大：${declared} 字节（上限 ${maxBytes}）` });
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          // 边读边限：超限立刻断，不等收完
          res.destroy();
          finish({ ok: false, error: `媒体过大：超过 ${maxBytes} 字节，已中断下载` });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        finish({
          ok: true,
          transport: 'node-http',
          bytes: Buffer.concat(chunks),
          mediaType: String(res.headers['content-type'] ?? ''),
          finalUrl: basics.url,
        });
      });
      res.on('error', (err) => {
        finish({ ok: false, error: `媒体读取失败：${err?.message ?? 'unknown'}` });
      });
    });
    req.on('error', (err) => {
      finish({ ok: false, error: `媒体连接失败：${err?.code ?? err?.message ?? 'unknown'}` });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`download timeout after ${timeoutMs}ms`));
    });
    req.end();
  });
}

/**
 * 生产下载路径：node:http/https 自己连。
 * - lookup 把「解析并校验过的 IP」钉死为实际连接地址（单次解析，无重绑定窗口）；
 * - 连上后核对 socket.remoteAddress 再开始收数据；
 * - 重定向逐跳、每跳重新解析校验（最多 3 跳）；
 * - 边读边计数，超过 maxBytes 立即销毁请求。
 */
async function downloadHttp(raw, {
  maxBytes = DEFAULT_MAX_MEDIA_BYTES,
  timeoutMs = 15000,
  maxRedirects = MAX_REDIRECTS,
  allowPrivate = false,
  resolveHost = defaultResolveHost,
} = {}) {
  let current = String(raw ?? '').trim();
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const basics = checkUrlBasics(current, allowPrivate);
    if (!basics.ok) return basics;
    let connectIp;
    let family;
    if (isIP(basics.hostname)) {
      if (!allowPrivate && isPrivateIp(basics.hostname)) {
        return { ok: false, error: `媒体 url 指向内网/本机地址（${basics.hostname}），已拒绝` };
      }
      connectIp = basics.hostname;
      family = isIP(basics.hostname);
    } else {
      // 域名：只解析一次，校验 + 连接共用同一份地址
      let addresses;
      try {
        addresses = await resolveHost(basics.hostname);
      } catch (err) {
        return { ok: false, error: `媒体 url 域名解析失败（${basics.hostname}）：${err?.code ?? err?.message ?? 'unknown'}` };
      }
      if (!Array.isArray(addresses) || addresses.length === 0) {
        return { ok: false, error: `媒体 url 域名没有解析结果（${basics.hostname}）` };
      }
      const allowed = allowPrivate ? addresses : addresses.filter((address) => !isPrivateIp(address));
      if (!allowed.length) {
        return { ok: false, error: `媒体 url 域名解析到内网/本机地址（${basics.hostname}），已拒绝` };
      }
      [connectIp] = allowed;
      family = isIP(connectIp) || 4;
    }
    const result = await connectOnce(basics, { connectIp, family, maxBytes, timeoutMs, allowPrivate });
    if (result.redirect) {
      if (hop >= maxRedirects) return { ok: false, error: `重定向超过 ${maxRedirects} 次` };
      current = result.redirect;
      continue;
    }
    return result;
  }
  return { ok: false, error: `重定向超过 ${maxRedirects} 次` };
}

/** 离线测试用的 fetch 版本（保持可注入、可断言）。 */
async function fetchBased(raw, {
  maxBytes, timeoutMs, maxRedirects, allowPrivate, fetchImpl, resolveHost,
} = {}) {
  let current = String(raw ?? '').trim();
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const checked = await assertSafeUrl(current, { allowPrivate, resolveHost });
    if (!checked.ok) return checked;
    let response;
    try {
      response = await fetchImpl(checked.url, {
        redirect: 'manual',
        headers: { accept: 'image/*,*/*;q=0.8' },
        signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 15000)),
      });
    } catch (err) {
      return { ok: false, error: `媒体下载失败：${err?.name ?? err?.message ?? 'unknown'}` };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get?.('location');
      if (!location) return { ok: false, error: `重定向缺少 Location（HTTP ${response.status}）` };
      try {
        current = new URL(location, checked.url).toString();
      } catch {
        return { ok: false, error: '重定向地址解析失败' };
      }
      continue;
    }
    if (!response.ok) return { ok: false, error: `媒体下载失败：HTTP ${response.status}` };
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, error: `媒体过大：${declared} 字节（上限 ${maxBytes}）` };
    }
    let bytes;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      return { ok: false, error: `媒体读取失败：${err?.message ?? 'unknown'}` };
    }
    if (bytes.length > maxBytes) return { ok: false, error: `媒体过大：${bytes.length} 字节（上限 ${maxBytes}）` };
    return {
      ok: true,
      transport: 'fetch',
      bytes,
      mediaType: String(response.headers?.get?.('content-type') ?? ''),
      finalUrl: checked.url,
    };
  }
  return { ok: false, error: `重定向超过 ${maxRedirects} 次` };
}

/**
 * 下载媒体入口：
 * - 未注入 fetchImpl（生产）：走 downloadHttp（钉 IP + 逐跳校验 + 流式限长）；
 * - 注入 fetchImpl（离线测试）：走 fetchBased（逐跳 assertSafeUrl + 读完后校验大小）。
 * 防御：调用方如果把「默认的全局 fetch」当注入传进来，仍按生产路径处理——
 * 否则钉 IP / 远端核对 / 流式限长会被静默绕过（2026-10-27 评审第四轮）。
 * 返回值里的 transport 标明这次实际走的通道（node-http / fetch），供测试断言。
 */
export async function safeFetchMedia(raw, {
  maxBytes = DEFAULT_MAX_MEDIA_BYTES,
  timeoutMs = 15000,
  maxRedirects = MAX_REDIRECTS,
  allowPrivate = false,
  fetchImpl,
  resolveHost = defaultResolveHost,
} = {}) {
  const injected = typeof fetchImpl === 'function' && fetchImpl !== globalThis.fetch ? fetchImpl : undefined;
  if (injected) {
    return fetchBased(raw, { maxBytes, timeoutMs, maxRedirects, allowPrivate, fetchImpl: injected, resolveHost });
  }
  return downloadHttp(raw, { maxBytes, timeoutMs, maxRedirects, allowPrivate, resolveHost });
}
