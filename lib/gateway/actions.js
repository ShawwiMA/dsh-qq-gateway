// OneBot 11 动作目录 + 参数校验归一化 + 出站消息段构造（纯逻辑：不碰网络、不碰 cordis）。
//
// 对接目标：NapCat（反向 WS 的 OneBot 11 实现）。文档核对日期：2026-10-17。
// 核对来源：
//   - OneBot 11 公开 API 规范：https://github.com/botuniverse/onebot-11 （api/public.md）
//   - NapCat API 总表与兼容情况：https://doc.napneko.icu/onebot/api
//   - NapCat 消息段定义：https://doc.napneko.icu/onebot/segment
//   - NapCat 单接口 OpenAPI：https://napcat.apifox.cn
//     （get_private_file_url / set_input_status / set_msg_emoji_like / set_online_status /
//       set_qq_profile / _send_group_notice / get_file / mark_msg_as_read / get_group_msg_history /
//       set_group_portrait 等逐条核对过参数名）
//   说明：当前离线环境抓不到官方 public.md 的 raw 页面，标准动作以 NapCat 兼容表中的 OneBot 11 API
//   清单交叉核对；NapCat 扩展（go-cqhttp 与 napcat 两组）以 apifox 单接口文档为准。
//
// 约定：
//   - ACTIONS 里 napcatOnly=true 表示不在 OneBot 11 标准 public API 内（go-cqhttp / NapCat 扩展）。
//     本网关只对接 NapCat，所以可以调用；换实现前要先做能力探测。
//   - normalizeAction 只做「类型归一化 + 必填/未知参数校验」，不做语义校验（例如 send_msg 的
//     user_id/group_id 二选一由上层按 message_type 保证），权限风险看 risk 字段，由上层闸门决定。
//   - 消息段输入用简化格式 { type:'text', text }，同时兼容直接传 OneBot 段格式 { type, data:{...} }，
//     方便把收到的消息原样转发（forward 节点里很常见）。输出的 data 一律是 OneBot 11 数组格式。
//   - 契约里 contact 段写成 {type:'contact', type:'qq'|'group', id}，type 键重复、JS 字面量写不出来，
//     这里用 contact_type（另外兼容 sub_type / data.type 两种写法）。
//   - image/record/video/file 的本地 path 会读成 base64://；非图片的 base64 在 NapCat 里是
//     尽力而为（有些场景只认 URL 或文件标识），失败时以 NapCat 返回的错误为准。

import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';

/** 本地文件读取上限（10MB）：图片 / 语音 / 视频 / 文件走 base64 时共用这个上限。 */
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 单条消息最多允许的消息段数。 */
export const MAX_SEGMENTS = 50;

const BASE64_PREFIX = 'base64://';

/**
 * 出站文件策略（2026-10-26 安全升级）。policy 由 gateway.sendMessage 注入；
 * 直接调用 buildSegments 的离线测试不传 policy = 不限制（保持旧行为）。
 * - mode 'all'    ：不限制（仅调试）
 * - mode 'main'   ：只有主号发起的那一轮、或内部渲染（markdown 截图）能发本机文件；
 *                   其他人只能发文字或 http(s) URL
 * - mode 'outbox' ：非主号只能发 outboxDir 目录内的文件；base64/file 原始字节段仍只给主号
 */
function isTrustedSender(policy) {
  return Boolean(policy && (policy.isMain === true || policy.internal === true));
}

/** base64:// / data: / file 标识这类「原始字节」来源，是否允许当前发起者使用。 */
function allowRawBytes(policy) {
  if (!policy) return true;
  const mode = String(policy.mode ?? 'main');
  if (mode === 'all') return true;
  return isTrustedSender(policy);
}

/** 本机路径能不能作为出站文件；返回 {ok:true} 或 {ok:false,error}。 */
function checkOutboundPath(policy, absolutePath) {
  if (!policy) return { ok: true };
  const mode = String(policy.mode ?? 'main');
  if (mode === 'all') return { ok: true };
  if (isTrustedSender(policy)) return { ok: true };
  if (mode !== 'outbox') {
    return { ok: false, error: '只有主号回合可以发送本机文件；其他人只能发文字或 http(s) 图片 URL' };
  }
  const base = String(policy.outboxDir ?? '').trim();
  if (!base) return { ok: false, error: '非主号发送本机文件需要先配置 outboxDir' };
  // UNC（\\host\share）会触发 SMB 认证，把 NTLM 哈希送给对方，一律拒绝
  if (/^[\\/]{2}/.test(String(absolutePath))) return { ok: false, error: '不允许 UNC 网络路径' };
  const target = resolvePath(String(absolutePath));
  const outbox = resolvePath(base);
  const rel = relative(outbox, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: '文件不在出站目录（outboxDir）内，已拒绝' };
  }
  return { ok: true };
}

/**
 * 媒体 URL 协议校验（2026-10-27 评审补充）。
 * 只接受 http/https —— file://、data:、base64://、ftp://、UNC 等一律拒绝：
 * 这些来源会把「本机文件」重新塞回发送链路，绕过 fileSendPolicy 的权限校验。
 */
export function checkMediaUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, error: 'URL 为空' };
  if (value.length > 4096) return { ok: false, error: 'URL 过长（超过 4096 字符）' };
  if (/[\s\u0000-\u001f]/.test(value)) return { ok: false, error: 'URL 里不允许空白或控制字符' };
  if (!/^https?:\/\/[^\s]+$/i.test(value)) {
    const shown = value.length > 40 ? `${value.slice(0, 40)}…` : value;
    return { ok: false, error: `媒体 url 只允许 http/https（收到 ${shown}；file:// / data: / base64:// 等来源一律拒绝）` };
  }
  return { ok: true, url: value };
}

/** 按文件头（魔术字节）识别图片格式；认不出返回空串。 */
function sniffImageMime(bytes) {
  if (!bytes || bytes.length < 2) return '';
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return '';
}

/** 默认读文件实现（同步）；测试用 opts.readFile 注入替身。 */
function defaultReadFile(absolutePath) {
  return { bytes: readFileSync(absolutePath), path: absolutePath };
}

/** 取段落字段：优先简化格式的顶层字段，其次 OneBot 段格式的 data.xxx。 */
function segmentField(part, name) {
  if (part && part[name] !== undefined) return part[name];
  const data = part && part.data;
  if (data && typeof data === 'object' && !Array.isArray(data) && data[name] !== undefined) return data[name];
  return undefined;
}

/**
 * 把 path / url / base64 / file 四种媒体来源归一成 OneBot 的 data.file。
 * - path：读本地文件（默认 readFileSync，可注入 opts.readFile），校验大小；图片再校验魔术字节 → base64://
 * - url：原样透传（NapCat 自己下载）
 * - base64：没有 base64:// 前缀就补上（data: URL 不补）
 * - file：原样透传（NapCat 的文件标识 / URL / 本地路径）
 * 非图片的 base64（record/video/file）NapCat 支持是尽力而为；超限或读失败照样报错。
 *
 * @param {'image'|'record'|'video'|'file'} type
 * @param {object} part - 简化格式或 OneBot 段
 * @param {{maxImageBytes:number, readFile:Function|null}} options
 * @returns {{ok:true, file:string}|{ok:false, error:string}}
 */
function resolveMediaFile(type, part, options) {
  const isImage = type === 'image';
  const label = isImage ? '图片' : '文件';

  const rawPath = segmentField(part, 'path');
  if (rawPath !== undefined && rawPath !== null && String(rawPath).trim() !== '') {
    const absolutePath = resolvePath(String(rawPath));
    const pathCheck = checkOutboundPath(options.policy, absolutePath);
    if (!pathCheck.ok) return pathCheck;
    const reader = typeof options.readFile === 'function' ? options.readFile : defaultReadFile;
    let bytes;
    try {
      const read = reader(absolutePath);
      bytes = Buffer.isBuffer(read) ? read : read && read.bytes;
    } catch (err) {
      return { ok: false, error: `读取${label}失败：${absolutePath}（${err?.code ?? err?.message ?? '未知错误'}）` };
    }
    if (!Buffer.isBuffer(bytes)) {
      return { ok: false, error: `读取${label}失败：${absolutePath}（readFile 没有返回字节）` };
    }
    if (bytes.length === 0) return { ok: false, error: `${label}是空文件：${absolutePath}` };
    if (bytes.length > options.maxImageBytes) {
      return { ok: false, error: `${label}过大：${bytes.length} 字节，上限 ${options.maxImageBytes} 字节` };
    }
    if (isImage && !sniffImageMime(bytes)) {
      return { ok: false, error: `图片格式不支持：${absolutePath}（只支持 png/jpeg/gif/webp/bmp，按文件头识别）` };
    }
    return { ok: true, file: `${BASE64_PREFIX}${bytes.toString('base64')}` };
  }

  const rawUrl = segmentField(part, 'url');
  if (rawUrl !== undefined && rawUrl !== null && String(rawUrl) !== '') {
    // 2026-10-27 评审补充：url 只接受 http(s)，否则可把本机文件包成 file:// / data: 绕过权限校验
    const urlCheck = checkMediaUrl(rawUrl);
    if (!urlCheck.ok) return urlCheck;
    return { ok: true, file: urlCheck.url };
  }

  const rawBase64 = segmentField(part, 'base64');
  if (rawBase64 !== undefined && rawBase64 !== null && String(rawBase64) !== '') {
    if (!allowRawBytes(options.policy)) {
      return { ok: false, error: '非主号回合不允许发送 base64 内容（防本机文件转码外发）' };
    }
    const value = String(rawBase64).trim();
    if (value.startsWith(BASE64_PREFIX) || value.startsWith('data:')) return { ok: true, file: value };
    return { ok: true, file: `${BASE64_PREFIX}${value.replace(/\s+/g, '')}` };
  }

  const rawFile = segmentField(part, 'file');
  if (rawFile !== undefined && rawFile !== null && String(rawFile) !== '') {
    if (!allowRawBytes(options.policy)) {
      return { ok: false, error: '非主号回合不允许发送 file 标识内容（防本机文件转码外发）' };
    }
    return { ok: true, file: String(rawFile) };
  }

  return { ok: false, error: `${type} 段需要 path/url/base64/file 之一` };
}

/**
 * 构造 OneBot 11 消息段数组。
 *
 * @param {string|Array<object|string>} parts - 字符串（纯文本）或段落数组
 * @param {object} [opts]
 * @param {number} [opts.maxImageBytes=10485760] - 本地文件读取上限（图片/语音/视频/文件共用）
 * @param {(absolutePath:string)=>{bytes:Buffer, path:string}} [opts.readFile] - 测试注入用；默认 readFileSync
 * @returns {{ok:true, segments:Array<object>}|{ok:false, error:string}}
 */
export function buildSegments(parts, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const maxImageBytes = Number.isFinite(options.maxImageBytes) && options.maxImageBytes > 0
    ? options.maxImageBytes
    : DEFAULT_MAX_IMAGE_BYTES;
  const segmentOptions = {
    maxImageBytes,
    readFile: typeof options.readFile === 'function' ? options.readFile : null,
    // 安全升级：出站本机文件分级（gateway.sendMessage 注入；不传 = 不限制，保持旧行为）
    policy: options.policy ?? null,
  };

  let list;
  if (typeof parts === 'string') list = [parts];
  else if (Array.isArray(parts)) list = parts;
  else return { ok: false, error: '消息段需要是字符串或消息段数组' };
  if (list.length === 0) return { ok: false, error: '消息段数组不能为空' };
  if (list.length > MAX_SEGMENTS) {
    return { ok: false, error: `消息段数量超过上限 ${MAX_SEGMENTS}（当前 ${list.length} 个）` };
  }

  const segments = [];
  for (let index = 0; index < list.length; index += 1) {
    const built = buildSegment(list[index], index, segmentOptions);
    if (!built.ok) return { ok: false, error: built.error };
    segments.push(built.segment);
  }
  return { ok: true, segments };
}

/** 构造单个消息段；index 只用于错误信息里定位第几段。 */
function buildSegment(part, index, options) {
  const prefix = `第 ${index + 1} 个消息段`;
  if (typeof part === 'string') return { ok: true, segment: { type: 'text', data: { text: part } } };
  if (!part || typeof part !== 'object' || Array.isArray(part)) {
    return { ok: false, error: `${prefix}不是对象` };
  }
  const type = part.type;
  if (typeof type !== 'string' || type === '') return { ok: false, error: `${prefix}缺少 type` };
  const reject = (reason) => ({ ok: false, error: `${prefix}（${type}）：${reason}` });

  switch (type) {
    case 'text': {
      const value = segmentField(part, 'text');
      const text = value === undefined || value === null ? '' : String(value);
      return { ok: true, segment: { type: 'text', data: { text } } };
    }
    case 'at': {
      const value = segmentField(part, 'qq');
      const qq = value === undefined || value === null ? '' : String(value).trim();
      if (qq !== 'all' && !/^\d+$/.test(qq)) {
        return reject(`qq 不合法：${qq || '(空)'}（需要 QQ 号或 "all"）`);
      }
      return { ok: true, segment: { type: 'at', data: { qq } } };
    }
    case 'reply': {
      const id = segmentField(part, 'message_id') ?? segmentField(part, 'id');
      if (id === undefined || id === null || String(id) === '') {
        return reject('缺少 message_id（或 id）');
      }
      return { ok: true, segment: { type: 'reply', data: { id: String(id) } } };
    }
    case 'image':
    case 'record':
    case 'video':
    case 'file': {
      const resolved = resolveMediaFile(type, part, options);
      if (!resolved.ok) return reject(resolved.error);
      const data = { file: resolved.file };
      if (type === 'file') {
        const name = segmentField(part, 'name');
        if (name !== undefined && name !== null && String(name) !== '') data.name = String(name);
      }
      return { ok: true, segment: { type, data } };
    }
    case 'face': {
      const id = segmentField(part, 'id');
      if (id === undefined || id === null || String(id) === '') {
        return reject('缺少 id（QQ 内置表情 ID）');
      }
      return { ok: true, segment: { type: 'face', data: { id: String(id) } } };
    }
    case 'mface': {
      const data = {};
      const emojiId = segmentField(part, 'emoji_id');
      const summary = segmentField(part, 'summary');
      const url = segmentField(part, 'url');
      if (emojiId !== undefined && emojiId !== null) data.emoji_id = String(emojiId);
      if (summary !== undefined && summary !== null) data.summary = String(summary);
      if (url !== undefined && url !== null && String(url).trim() !== '') {
        // 2026-10-27 评审补充：表情的 url 也是 NapCat 会去下载的媒体地址，同样只收 http(s)
        const urlCheck = checkMediaUrl(url);
        if (!urlCheck.ok) return reject(urlCheck.error);
        data.url = urlCheck.url;
      }
      return { ok: true, segment: { type: 'mface', data } };
    }
    case 'json': {
      let value = part.data;
      // 已经是 OneBot 段格式 {type:'json',data:{data:...}} 时剥一层
      if (value && typeof value === 'object' && !Array.isArray(value)
        && Object.prototype.hasOwnProperty.call(value, 'data')) {
        value = value.data;
      }
      if (value === undefined || value === null) return reject('缺少 data（JSON 字符串或对象）');
      if (typeof value === 'string') {
        if (value.trim() === '') return reject('data 是空字符串');
        return { ok: true, segment: { type: 'json', data: { data: value } } };
      }
      if (typeof value === 'object') {
        let text;
        try {
          text = JSON.stringify(value);
        } catch (err) {
          return reject(`data 无法序列化成 JSON（${err?.message ?? '未知错误'}）`);
        }
        return { ok: true, segment: { type: 'json', data: { data: text } } };
      }
      return reject('data 需要是 JSON 字符串或对象');
    }
    case 'markdown': {
      const content = segmentField(part, 'content');
      if (content === undefined || content === null || String(content) === '') return reject('缺少 content');
      return { ok: true, segment: { type: 'markdown', data: { content: String(content) } } };
    }
    case 'share': {
      const url = segmentField(part, 'url');
      if (url === undefined || url === null || String(url).trim() === '') return reject('缺少 url');
      // 2026-10-27 评审补充：卡片链接同样只收 http(s)，其他协议一律拒绝
      const urlCheck = checkMediaUrl(url);
      if (!urlCheck.ok) return reject(urlCheck.error);
      const data = { url: urlCheck.url };
      for (const key of ['title', 'content', 'image']) {
        const value = segmentField(part, key);
        if (value !== undefined && value !== null && String(value) !== '') data[key] = String(value);
      }
      return { ok: true, segment: { type: 'share', data } };
    }
    case 'contact': {
      const dataField = part.data && typeof part.data === 'object' && !Array.isArray(part.data) ? part.data : {};
      const contactType = part.contact_type ?? part.sub_type ?? dataField.type;
      const id = part.id ?? dataField.id;
      if (contactType !== 'qq' && contactType !== 'group') {
        return reject('contact_type 需要是 qq 或 group（也可用 sub_type 或 data.type）');
      }
      if (id === undefined || id === null || String(id) === '') return reject('缺少 id');
      return { ok: true, segment: { type: 'contact', data: { type: contactType, id: String(id) } } };
    }
    case 'dice':
    case 'rps':
    case 'shake':
      return { ok: true, segment: { type, data: {} } };
    default:
      if (type === 'poke' || type === 'nod') {
        return reject('不支持该类消息段；发戳一戳请改用 qq_action 的 send_poke 动作');
      }
      return reject('不支持的消息段类型（支持 text/at/reply/image/face/mface/record/video/file/'
        + 'json/markdown/share/contact/dice/rps/shake）');
  }
}

// ---------------------------------------------------------------------------
// 动作目录
// ---------------------------------------------------------------------------

/** 目录项工厂：ACTIONS 里每一项都是这个结构。 */
function action(category, risk, summary, napcatOnly, params = []) {
  return { category, risk, summary, napcatOnly, params };
}

/** 参数描述工厂。enum 额外带 values。 */
function param(name, type, required, desc, extra = {}) {
  return { name, type, required, desc, ...extra };
}

const groupId = () => param('group_id', 'qq', true, '群号');
const userId = () => param('user_id', 'qq', true, 'QQ 号');
const messageParam = () => param('message', 'message', true, '消息：字符串（纯文本，不解析 CQ 码）或消息段数组');
const messageId = () => param('message_id', 'msgid', true, '消息 ID');
const noCache = () => param('no_cache', 'bool', false, '是否绕过缓存（NapCat 扩展）');
const forwardNodes = () => param('messages', 'forward', true, '转发节点数组：[{user_id?, nickname?, content}]');
const requestFlag = () => param('flag', 'string', true, '请求 flag（从上报的 request 事件里取）');

/**
 * OneBot 11 动作目录（面向 NapCat）。键就是动作名。
 * category: message|media|query|manage|meta；risk: read|write|destructive。
 */
export const ACTIONS = {
  // ---- message：收发消息 / 媒体 / 消息扩展 ----
  send_private_msg: action('message', 'write', '发私聊消息', false, [
    userId(),
    messageParam(),
    param('auto_escape', 'bool', false, '是否把字符串消息当纯文本（不解析 CQ 码）'),
  ]),
  send_group_msg: action('message', 'write', '发群消息', false, [
    groupId(),
    messageParam(),
    param('auto_escape', 'bool', false, '是否把字符串消息当纯文本（不解析 CQ 码）'),
  ]),
  send_msg: action('message', 'write', '发消息（私聊/群聊二选一）', false, [
    param('message_type', 'enum', true, '消息类型', { values: ['private', 'group'] }),
    messageParam(),
    param('user_id', 'qq', false, 'QQ 号（message_type=private 时必填）'),
    param('group_id', 'qq', false, '群号（message_type=group 时必填）'),
    param('auto_escape', 'bool', false, '是否把字符串消息当纯文本（不解析 CQ 码）'),
  ]),
  delete_msg: action('message', 'write', '撤回消息', false, [messageId()]),
  get_msg: action('message', 'read', '获取单条消息', false, [messageId()]),
  get_forward_msg: action('message', 'read', '获取合并转发消息', false, [messageId()]),
  send_private_forward_msg: action('message', 'write', '发私聊合并转发', true, [userId(), forwardNodes()]),
  send_group_forward_msg: action('message', 'write', '发群合并转发', true, [groupId(), forwardNodes()]),
  mark_msg_as_read: action('message', 'write', '标记消息已读', true, [messageId()]),
  set_msg_emoji_like: action('message', 'write', '给消息贴表情回应', true, [
    messageId(),
    param('emoji_id', 'string', true, '表情 ID'),
    param('set', 'bool', false, 'true 贴表情 / false 取消（默认 true）'),
  ]),
  send_poke: action('message', 'write', '戳一戳（私聊只传 user_id，群聊再传 group_id）', true, [
    userId(),
    param('group_id', 'qq', false, '群号（群聊戳一戳时传）'),
  ]),
  set_input_status: action('message', 'write', '设置「正在输入」状态', true, [
    userId(),
    param('event_type', 'int', true, 'NapCat 输入状态事件类型（原样透传）'),
  ]),
  send_like: action('message', 'write', '给好友点赞', false, [
    userId(),
    param('times', 'int', false, '点赞次数（默认 10，注意调用频率）'),
  ]),
  get_image: action('message', 'read', '获取图片文件信息/下载地址', false, [
    param('file', 'string', true, '图片文件标识'),
  ]),
  get_record: action('message', 'read', '获取语音文件', false, [
    param('file', 'string', true, '语音文件标识'),
    param('out_format', 'enum', false, '输出格式', { values: ['mp3', 'amr', 'wav', 'silk'] }),
  ]),
  get_file: action('message', 'read', '获取文件信息/下载地址', true, [
    param('file', 'string', false, '文件路径、URL 或 Base64'),
    param('file_id', 'string', false, '文件 ID'),
  ]),
  can_send_image: action('message', 'read', '检查是否可发图片', false, []),
  can_send_record: action('message', 'read', '检查是否可发语音', false, []),

  // ---- query：只读查询 ----
  get_login_info: action('query', 'read', '获取登录号信息', false, []),
  get_status: action('query', 'read', '获取运行状态', false, []),
  get_version_info: action('query', 'read', '获取版本信息', false, []),
  get_stranger_info: action('query', 'read', '获取陌生人信息', false, [userId(), noCache()]),
  get_friend_list: action('query', 'read', '获取好友列表', false, [noCache()]),
  get_group_list: action('query', 'read', '获取群列表', false, [noCache()]),
  get_group_info: action('query', 'read', '获取群信息', false, [groupId(), noCache()]),
  get_group_member_info: action('query', 'read', '获取群成员信息', false, [groupId(), userId(), noCache()]),
  get_group_member_list: action('query', 'read', '获取群成员列表', false, [groupId(), noCache()]),
  get_group_honor_info: action('query', 'read', '获取群荣誉信息', false, [
    groupId(),
    param('type', 'enum', false, '荣誉类型（默认 all）', {
      values: ['all', 'talkative', 'performer', 'legend', 'strong_newbie', 'emotion'],
    }),
  ]),
  get_group_at_all_remain: action('query', 'read', '获取群 @全体成员 剩余次数', true, [groupId()]),
  get_group_msg_history: action('query', 'read', '获取群消息历史', true, [
    groupId(),
    param('message_seq', 'string', false, '起始消息序号'),
    param('count', 'int', false, '拉取条数（默认 20）'),
    param('reverse_order', 'bool', false, '是否反向排序'),
    param('disable_get_url', 'bool', false, '是否禁用获取 URL'),
    param('parse_mult_msg', 'bool', false, '是否解析合并消息'),
    param('quick_reply', 'bool', false, '是否快速回复'),
  ]),
  get_friend_msg_history: action('query', 'read', '获取私聊消息历史', true, [
    userId(),
    param('count', 'int', false, '拉取条数'),
  ]),
  get_essence_msg_list: action('query', 'read', '获取群精华消息列表', true, [groupId()]),
  get_group_file_system_info: action('query', 'read', '获取群文件系统信息', true, [groupId()]),
  get_group_root_files: action('query', 'read', '获取群根目录文件列表', true, [groupId()]),
  get_group_files_by_folder: action('query', 'read', '获取群子目录文件列表', true, [
    groupId(),
    param('folder_id', 'string', true, '文件夹 ID'),
  ]),
  get_group_file_url: action('query', 'read', '获取群文件下载链接', true, [
    groupId(),
    param('file_id', 'string', true, '文件 ID'),
    param('busid', 'int', true, '文件类型 busid'),
  ]),
  get_private_file_url: action('query', 'read', '获取私聊文件下载链接', true, [
    param('file_id', 'string', true, '文件 ID'),
    param('user_id', 'qq', false, '对方 QQ 号（NapCat 示例里会带）'),
  ]),
  // 拉人进群的替代路径：这两个都走 NTQQ 原生接口（不走 WebApi，不需要容器能访问 qun.qq.com）
  get_group_share_link: action('query', 'read', '获取群分享/加群链接（原生接口，发给好友点开可申请/加入）', true, [
    groupId(),
    param('need_short_url', 'bool', false, '是否要短链接（默认 true，qm.qq.com/q/xxx）'),
  ]),
  ArkShareGroup: action('query', 'read', '获取群分享 Ark 卡片 JSON（可当 json 消息段发给好友，点击加群）', true, [groupId()]),
  send_group_ark_share: action('query', 'read', '获取群分享 Ark 卡片 JSON（ArkShareGroup 的别名，NapCat 新名字）', true, [groupId()]),

  // ---- manage：群/账号管理（风险后果自负，dangerous 类要做二次确认） ----
  set_group_kick: action('manage', 'destructive', '群组踢人', false, [
    groupId(),
    userId(),
    param('reject_add_request', 'bool', false, '是否拒绝该成员之后的加群请求'),
  ]),
  set_group_ban: action('manage', 'destructive', '群组单人禁言', false, [
    groupId(),
    userId(),
    param('duration', 'int', false, '禁言时长（秒），0 表示解除禁言，默认 1800'),
  ]),
  set_group_anonymous_ban: action('manage', 'destructive', '群组匿名用户禁言', false, [
    groupId(),
    param('flag', 'string', true, '匿名用户标识（事件 anonymous.flag，兼容别名 anonymous_flag）'),
    param('duration', 'int', false, '禁言时长（秒），默认 1800'),
  ]),
  set_group_whole_ban: action('manage', 'destructive', '群组全员禁言', false, [
    groupId(),
    param('enable', 'bool', false, 'true 开启 / false 关闭（默认 true）'),
  ]),
  set_group_admin: action('manage', 'write', '设置/取消群管理员', false, [
    groupId(),
    userId(),
    param('enable', 'bool', false, 'true 设置 / false 取消（默认 true）'),
  ]),
  set_group_card: action('manage', 'write', '设置群名片（群备注）', false, [
    groupId(),
    userId(),
    param('card', 'string', false, '群名片，空字符串表示清除'),
  ]),
  set_group_name: action('manage', 'write', '设置群名', false, [
    groupId(),
    param('group_name', 'string', true, '新群名'),
  ]),
  set_group_leave: action('manage', 'destructive', '退出群组', false, [
    groupId(),
    param('is_dismiss', 'bool', false, '是否解散群（仅群主可用）'),
  ]),
  set_group_special_title: action('manage', 'write', '设置群成员专属头衔', false, [
    groupId(),
    userId(),
    param('special_title', 'string', false, '专属头衔，空字符串表示取消'),
  ]),
  set_friend_add_request: action('manage', 'write', '处理加好友请求', false, [
    requestFlag(),
    param('approve', 'bool', true, '是否同意'),
    param('remark', 'string', false, '同意后的好友备注'),
  ]),
  set_group_add_request: action('manage', 'write', '处理加群请求/邀请', false, [
    requestFlag(),
    param('sub_type', 'enum', true, '请求类型', { values: ['add', 'invite'] }),
    param('approve', 'bool', true, '是否同意'),
    param('reason', 'string', false, '拒绝理由'),
  ]),
  set_essence_msg: action('manage', 'write', '设为群精华消息', true, [messageId()]),
  delete_essence_msg: action('manage', 'destructive', '移出群精华消息', true, [messageId()]),
  upload_group_file: action('manage', 'write', '上传群文件', true, [
    groupId(),
    param('file', 'string', true, '本地文件路径或 URL'),
    param('name', 'string', true, '群文件里显示的文件名'),
    param('folder', 'string', false, '目标文件夹 ID'),
  ]),
  delete_group_file: action('manage', 'destructive', '删除群文件', true, [
    groupId(),
    param('file_id', 'string', true, '群文件 ID'),
    param('busid', 'int', true, '文件类型 busid'),
  ]),
  upload_private_file: action('manage', 'write', '上传私聊文件', true, [
    userId(),
    param('file', 'string', true, '本地文件路径或 URL'),
    param('name', 'string', true, '文件名'),
  ]),
  _send_group_notice: action('manage', 'write', '发送群公告', true, [
    groupId(),
    param('content', 'string', true, '公告内容'),
    param('image', 'string', false, '公告图片路径或 URL'),
    param('pinned', 'int', false, '是否置顶（0/1，默认 0）'),
    param('type', 'int', false, '公告类型（默认 1）'),
    param('confirm_required', 'int', false, '是否需要确认（0/1，默认 1）'),
    param('is_show_edit_card', 'int', false, '是否显示修改群名片引导（0/1，默认 0）'),
    param('tip_window_type', 'int', false, '弹窗类型（默认 0）'),
  ]),
  _get_group_notice: action('manage', 'read', '获取群公告', true, [groupId()]),
  _del_group_notice: action('manage', 'destructive', '删除群公告', true, [
    groupId(),
    param('notice_id', 'string', true, '公告 ID（_get_group_notice 返回的 notice_id）'),
  ]),
  set_online_status: action('manage', 'write', '设置在线状态', true, [
    param('status', 'int', true, '在线状态码：10 在线 / 30 离开 / 40 隐身 / 50 忙碌 / 60 Q我吧 / 70 请勿打扰'),
    param('ext_status', 'int', true, '扩展状态码（普通状态填 0）'),
    param('battery_status', 'int', true, '电量状态码（普通状态填 0）'),
  ]),
  set_qq_profile: action('manage', 'write', '设置 QQ 资料', true, [
    param('nickname', 'string', true, '昵称'),
    param('personal_note', 'string', false, '个性签名'),
    param('sex', 'int', false, '性别：0 未知 / 1 男 / 2 女'),
  ]),
  set_qq_avatar: action('manage', 'write', '设置 QQ 头像', true, [
    param('file', 'string', true, '头像文件路径、URL 或 base64'),
  ]),
  set_group_portrait: action('manage', 'write', '设置群头像', true, [
    groupId(),
    param('file', 'string', true, '头像文件路径或 URL'),
  ]),
};

// ---------------------------------------------------------------------------
// 参数归一化
// ---------------------------------------------------------------------------

/**
 * 少数参数在不同实现里叫法不同：以 NapCat 为准，别名兼容规范/旧写法。
 * get_forward_msg：OneBot 规范参数叫 id，NapCat 用 message_id。
 * set_group_anonymous_ban：规范里 flag 是现行参数，anonymous_flag 已弃用但仍有人传。
 */
const PARAM_ALIASES = {
  get_forward_msg: { id: 'message_id' },
  set_group_anonymous_ban: { anonymous_flag: 'flag' },
};

/** 数字或纯数字字符串 → 安全整数；否则 null。 */
function safeInt(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  }
  return null;
}

/** 消息 ID：安全整数转 Number，其余非空字符串原样保留（兼容 NapCat 哈希 ID / UUID）。 */
function msgIdValue(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : String(value);
  if (typeof value !== 'string' || value === '') return null;
  if (/^\d+$/.test(value)) {
    const number = Number(value);
    if (Number.isSafeInteger(number)) return number;
  }
  return value;
}

/** 普通对象判断（null / 数组都算不合法）。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** forward 参数 → OneBot node 段数组。 */
function normalizeForward(actionName, paramName, value) {
  const prefix = `动作 ${actionName} 的参数 ${paramName}`;
  if (!Array.isArray(value)) return { ok: false, error: `${prefix} 需要是转发节点数组` };
  if (value.length === 0) return { ok: false, error: `${prefix} 不能是空数组` };
  const nodes = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isPlainObject(item)) return { ok: false, error: `${prefix} 第 ${index + 1} 条不是对象` };
    let content;
    if (typeof item.content === 'string') {
      content = [{ type: 'text', data: { text: item.content } }];
    } else if (Array.isArray(item.content)) {
      const built = buildSegments(item.content);
      if (!built.ok) return { ok: false, error: `${prefix} 第 ${index + 1} 条的 content：${built.error}` };
      content = built.segments;
    } else {
      return { ok: false, error: `${prefix} 第 ${index + 1} 条缺少 content（字符串或消息段数组）` };
    }
    const data = { content };
    if (item.user_id !== undefined) {
      const id = safeInt(item.user_id);
      if (id === null) {
        return { ok: false, error: `${prefix} 第 ${index + 1} 条的 user_id 需要是 QQ 号（数字或纯数字字符串）` };
      }
      data.user_id = id;
    }
    if (item.nickname !== undefined) data.nickname = String(item.nickname);
    nodes.push({ type: 'node', data });
  }
  return { ok: true, nodes };
}

/** 单个参数归一化，返回 {ok:true,value} 或 {ok:false,error}。 */
function normalizeParam(actionName, spec, value) {
  const bad = (expect) => ({ ok: false, error: `动作 ${actionName} 的参数 ${spec.name} 需要是 ${expect}` });
  switch (spec.type) {
    case 'qq':
    case 'int': {
      const number = safeInt(value);
      if (number === null) {
        return bad(spec.type === 'qq'
          ? 'QQ 号（数字或纯数字字符串，安全整数范围内）'
          : '整数（数字或纯数字字符串，安全整数范围内）');
      }
      return { ok: true, value: number };
    }
    case 'string':
      if (typeof value !== 'string') return bad('字符串');
      return { ok: true, value };
    case 'bool':
      if (typeof value !== 'boolean') return bad('布尔值 true/false');
      return { ok: true, value };
    case 'msgid': {
      const id = msgIdValue(value);
      if (id === null) return bad('消息 ID（数字或非空字符串）');
      return { ok: true, value: id };
    }
    case 'message': {
      if (typeof value === 'string') {
        return { ok: true, value: [{ type: 'text', data: { text: value } }] };
      }
      if (!Array.isArray(value)) return bad('字符串或消息段数组');
      const built = buildSegments(value);
      if (!built.ok) return { ok: false, error: `动作 ${actionName} 的参数 ${spec.name}：${built.error}` };
      return { ok: true, value: built.segments };
    }
    case 'forward': {
      const forwarded = normalizeForward(actionName, spec.name, value);
      if (!forwarded.ok) return forwarded;
      return { ok: true, value: forwarded.nodes };
    }
    case 'array':
      if (!Array.isArray(value)) return bad('数组');
      return { ok: true, value };
    case 'object':
      if (!isPlainObject(value)) return bad('对象');
      return { ok: true, value };
    case 'enum': {
      const values = Array.isArray(spec.values) ? spec.values : [];
      if (typeof value !== 'string' || !values.includes(value)) {
        return bad(`以下之一：${values.join(' / ')}`);
      }
      return { ok: true, value };
    }
    default:
      return { ok: false, error: `动作 ${actionName} 的参数 ${spec.name} 类型未实现：${spec.type}` };
  }
}

/**
 * 校验并归一化动作参数。
 * 忽略值为 undefined 的键；未知参数、缺必填、类型不对都返回中文错误。
 *
 * @param {string} name - 动作名（ACTIONS 的键）
 * @param {object} [args] - 调用方给的对象
 * @returns {{ok:true, action:string, params:object}|{ok:false, error:string}}
 */
export function normalizeAction(name, args = {}) {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(ACTIONS, name)) {
    return { ok: false, error: `未知动作：${String(name)}` };
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: `动作 ${name} 的参数必须是对象` };
  }
  const def = ACTIONS[name];
  const aliases = PARAM_ALIASES[name] ?? {};
  const specs = new Map(def.params.map((spec) => [spec.name, spec]));
  const input = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const target = Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : key;
    if (!specs.has(target)) return { ok: false, error: `动作 ${name} 不支持参数 ${key}` };
    if (input[target] !== undefined) {
      return { ok: false, error: `动作 ${name} 的参数 ${key} 与 ${target} 重复，只能给一个` };
    }
    input[target] = value;
  }
  const params = {};
  for (const spec of def.params) {
    const value = input[spec.name];
    if (value === undefined) {
      if (spec.required) {
        return { ok: false, error: `动作 ${name} 缺少必填参数 ${spec.name}（${spec.desc}）` };
      }
      continue;
    }
    const normalized = normalizeParam(name, spec, value);
    if (!normalized.ok) return { ok: false, error: normalized.error };
    params[spec.name] = normalized.value;
  }
  return { ok: true, action: name, params };
}

// ---------------------------------------------------------------------------
// 目录查询辅助（给工具注册/模型看）
// ---------------------------------------------------------------------------

/** 全部动作名。 */
export function actionNames() {
  return Object.keys(ACTIONS);
}

/**
 * 列动作目录（浅拷贝，调用方随便改返回值不会污染 ACTIONS）。
 * @param {{category?:string}} [filter]
 * @returns {Array<{name:string, category:string, risk:string, summary:string, params:Array<object>}>}
 */
export function listActions(filter = {}) {
  const filterObject = filter && typeof filter === 'object' ? filter : {};
  const category = typeof filterObject.category === 'string' ? filterObject.category : '';
  const entries = [];
  for (const [name, def] of Object.entries(ACTIONS)) {
    if (category && def.category !== category) continue;
    entries.push({
      name,
      category: def.category,
      risk: def.risk,
      summary: def.summary,
      params: def.params.map((spec) => ({
        ...spec,
        ...(Array.isArray(spec.values) ? { values: [...spec.values] } : {}),
      })),
    });
  }
  return entries;
}

/**
 * 单行动作签名说明：'send_group_msg(group_id, message)：发群消息'。
 * 只列必填参数（可选参数看 listActions/ACTIONS）；未知动作返回 null。
 */
export function describeAction(name) {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(ACTIONS, name)) return null;
  const def = ACTIONS[name];
  const required = def.params.filter((spec) => spec.required).map((spec) => spec.name);
  return `${name}(${required.join(', ')})：${def.summary}`;
}

/** 动作风险等级；未知动作返回 null。 */
export function actionRisk(name) {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(ACTIONS, name)) return null;
  return ACTIONS[name].risk;
}
