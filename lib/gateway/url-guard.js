// 媒体 URL 安全层（2026-10-27，评审补充：非主号 HTTP 媒体地址可指向协议端本机/内网 → SSRF）。
//
// 目标：所有会「被下载」的媒体 URL 都要过协议 + 目标地址 + 重定向校验。
// - 协议：只允许 http/https
// - 目标：拒绝回环 / 私网 / 链路本地 / CGNAT / 组播 / 本机名（localhost、*.local、host.docker.internal…），
//   域名先解析再判 IP（注入 resolveHost 便于离线测试）
// - 重定向：自己下载时逐跳校验；最多 3 跳
// 纯逻辑 + 可注入 fetch/解析器，离线可测。
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const DEFAULT_MAX_MEDIA_BYTES = 20 * 1024 * 1024;

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
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    // IPv4-mapped（::ffff:127.0.0.1）按内嵌 IPv4 判
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateIp(mapped[1]);
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA fc00::/7
    if (/^fe[89ab]/.test(lower)) return true; // link-local fe80::/10
    if (lower.startsWith('ff')) return true; // multicast
    if (lower.startsWith('2001:db8')) return true; // 文档地址
    return false;
  }
  return true; // 不是合法 IP：按危险处理（调用方应先按域名分支）
}

/** 主机名本身是不是明显的本机/内网名。 */
export function hostLooksLocal(host) {
  const name = String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!name) return true;
  if (LOCAL_HOST_NAMES.has(name)) return true;
  if (LOCAL_HOST_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  if (!name.includes('.')) return true; // 单标签主机名（内网常见）
  return false;
}

/** 默认解析器：返回全部 A/AAAA。 */
async function defaultResolveHost(host) {
  const rows = await lookup(host, { all: true, verbatim: true });
  return rows.map((row) => row.address);
}

/**
 * 校验一个媒体 URL 能不能被下载。
 * @returns {Promise<{ok:true, url:string}|{ok:false, error:string}>}
 */
export async function assertSafeUrl(raw, { allowPrivate = false, resolveHost = defaultResolveHost } = {}) {
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
    if (!allowPrivate && isPrivateIp(host)) {
      return { ok: false, error: `媒体 url 指向内网/本机地址（${host}），已拒绝` };
    }
    return { ok: true, url: parsed.toString() };
  }
  if (hostLooksLocal(host)) {
    if (!allowPrivate) return { ok: false, error: `媒体 url 指向本机/内网主机名（${host}），已拒绝` };
    return { ok: true, url: parsed.toString() };
  }
  let addresses;
  try {
    addresses = await resolveHost(host);
  } catch (err) {
    return { ok: false, error: `媒体 url 域名解析失败（${host}）：${err?.code ?? err?.message ?? 'unknown'}` };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return { ok: false, error: `媒体 url 域名没有解析结果（${host}）` };
  }
  if (!allowPrivate) {
    const bad = addresses.find((address) => isPrivateIp(address));
    if (bad) return { ok: false, error: `媒体 url 域名解析到内网/本机地址（${host} → ${bad}），已拒绝` };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * 自己下载媒体（用于非主号回合的 URL：逐跳校验重定向、限制大小）。
 * @returns {Promise<{ok:true, bytes:Buffer, mediaType:string, finalUrl:string}|{ok:false, error:string}>}
 */
export async function safeFetchMedia(raw, {
  maxBytes = DEFAULT_MAX_MEDIA_BYTES,
  timeoutMs = 15000,
  maxRedirects = 3,
  allowPrivate = false,
  fetchImpl = globalThis.fetch,
  resolveHost = defaultResolveHost,
} = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch 不可用' };
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
      bytes,
      mediaType: String(response.headers?.get?.('content-type') ?? ''),
      finalUrl: checked.url,
    };
  }
  return { ok: false, error: `重定向超过 ${maxRedirects} 次` };
}
