// OneBot 图片段 → 宿主可直接接收的 base64 图片（M4.1：主号发图能进 DSH 会话）。
//
// NapCat 的图片段通常长这样：
//   { type: 'image', data: { file: 'xxx.jpg', url: 'https://gchat.qpic.cn/...', file_size: '12345', ... } }
// 但不同版本/场景给的东西不一样（有时只有 file、有时 url 需要下载、有时是 base64://），
// 所以这里按「url → base64:// file → http file → get_image 动作」的顺序逐个试，全失败才报错。
//
// 宿主限制（attachment-local 默认值）：单图 ≤ 20MB，格式 png/jpeg/webp/gif，一消息 ≤ 20 张。
// 宿主自己会做尺寸归一化，这里只管「拿到合法字节 + 判对 mediaType」。
import { setTimeout as delay } from 'node:timers/promises';

/** 单图字节上限，与宿主 attachment-local 的 maxImageBytes 默认值保持一致。 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** 单次下载/动作超时。 */
export const DEFAULT_IMAGE_TIMEOUT_MS = 15000;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) QQGateway/1.0';
const BASE64_PREFIX = 'base64://';

/** 按 magic bytes 认图片格式；认不出返回空串。 */
export function sniffMediaType(bytes) {
  if (!bytes || bytes.length < 12) return '';
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return '';
}

function extensionOf(mediaType) {
  if (mediaType === 'image/png') return 'png';
  if (mediaType === 'image/gif') return 'gif';
  if (mediaType === 'image/webp') return 'webp';
  return 'jpg';
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !value) return null;
  const bytes = Buffer.from(value, 'base64');
  // base64:// 后面可能是 URL-safe 或带参数的形式，长度对不上就当失败
  return bytes.length ? bytes : null;
}

/**
 * 把一条 OneBot 图片段解析成宿主可用的图片内容。
 * @param {{file?: string, url?: string, summary?: string}} segment
 * @param {object} deps
 * @param {Function} [deps.fetchImpl] - 可注入（离线测试用假 fetch）
 * @param {(action: string, params: object, timeoutMs?: number) => Promise<any>} [deps.requestAction]
 * @param {(message: string) => void} [deps.log]
 * @param {number} [deps.timeoutMs]
 * @returns {Promise<{mediaType: string, data: string, name: string, bytes: number, source: string}>}
 */
export async function resolveImage(segment, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const timeoutMs = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : DEFAULT_IMAGE_TIMEOUT_MS;
  const file = String(segment?.file ?? '');
  const url = String(segment?.url ?? '');
  const attempts = [];

  const fetchUrl = async (target) => {
    if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
    if (!/^https?:\/\//i.test(target)) throw new Error('not-an-http-url');
    const res = await fetchImpl(target, {
      headers: { 'user-agent': USER_AGENT, accept: 'image/*,*/*;q=0.8' },
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!res || res.ok !== true) throw new Error(`http ${res?.status ?? 'unknown'}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length) throw new Error('empty body');
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`too large ${bytes.length}`);
    return bytes;
  };

  const tryBytes = async (label, getter) => {
    try {
      const bytes = await getter();
      if (bytes && bytes.length) {
        attempts.push(`${label}:ok(${bytes.length}B)`);
        return bytes;
      }
      attempts.push(`${label}:empty`);
    } catch (err) {
      attempts.push(`${label}:${err?.message ?? String(err)}`);
    }
    return null;
  };

  let bytes = null;
  let source = '';
  if (/^https?:\/\//i.test(url)) {
    bytes = await tryBytes('url', () => fetchUrl(url));
    if (bytes) source = 'url';
  }
  if (!bytes && file.startsWith(BASE64_PREFIX)) {
    bytes = await tryBytes('file-base64', async () => decodeBase64(file.slice(BASE64_PREFIX.length)));
    if (bytes) source = 'file-base64';
  }
  if (!bytes && /^https?:\/\//i.test(file)) {
    bytes = await tryBytes('file-url', () => fetchUrl(file));
    if (bytes) source = 'file-url';
  }
  if (!bytes && typeof deps.requestAction === 'function' && file) {
    bytes = await tryBytes('get_image', async () => {
      const value = await deps.requestAction('get_image', { file }, timeoutMs);
      const data = value?.data ?? {};
      const raw = typeof data.file === 'string' ? data.file : typeof data.base64 === 'string' ? data.base64 : '';
      if (raw.startsWith(BASE64_PREFIX)) return decodeBase64(raw.slice(BASE64_PREFIX.length));
      if (typeof data.base64 === 'string' && data.base64) return decodeBase64(data.base64);
      if (/^https?:\/\//i.test(String(data.url ?? ''))) return fetchUrl(String(data.url));
      if (/^https?:\/\//i.test(raw)) return fetchUrl(raw);
      // 只有容器内路径（宿主读不到）这种情况直接判失败，别让调用方等
      throw new Error(`unusable get_image payload ${JSON.stringify(data).slice(0, 120)}`);
    });
    if (bytes) source = 'get_image';
  }

  if (!bytes) {
    log(`image unavailable (${attempts.join(', ') || 'no source'})`);
    throw new Error(`image unavailable (${attempts.join(', ') || 'no usable source'})`);
  }

  const sniffed = sniffMediaType(bytes);
  const mediaType = sniffed || 'image/jpeg';
  return {
    mediaType,
    data: bytes.toString('base64'),
    name: `qq-image.${extensionOf(mediaType)}`,
    bytes: bytes.length,
    source,
  };
}

/** 给测试/调试用：等一会儿（避免测试文件重复写 delay 逻辑）。 */
export { delay as imageDelay };
