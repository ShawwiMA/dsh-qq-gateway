// 协议层：OneBot 11 私聊帧归一化 + L1/L2 门控 + 去重 + L3 rpcId 闸门 + 正文提取。
// 全是纯逻辑，不碰网络、不碰 cordis，离线可单测。

export const DROP = {
  NOT_JSON: 'not-json',
  NOT_OBJECT: 'not-object',
  ACTION_RESPONSE: 'action-response',
  NOT_MESSAGE: 'not-message',
  // 既不是 supported 的私聊也不是群聊（频道/临时会话等）；历史名字保留，测试仍按它断言
  NOT_PRIVATE: 'not-private',
  // 私聊发送者不在允许范围（主号 + 授权名单）
  WRONG_USER: 'wrong-user',
  WRONG_SELF: 'wrong-self',
  // 小号自己发的消息（防回环第二道闸）
  SELF_MESSAGE: 'self-message',
  // 群消息没有 @ 小号（只接 @ 的）
  GROUP_NO_MENTION: 'group-no-mention',
  EMPTY_TEXT: 'empty-text',
};

// 这些段不算"不支持的媒体"：@、回复引用、表情小图标、戳一戳之类，静默忽略。
const PASSIVE_SEGMENTS = new Set(['at', 'reply', 'face', 'mface', 'shake', 'poke', 'nod']);

export const TURN_VERDICT = { OWN: 'own', FOREIGN: 'foreign', AMBIGUOUS: 'ambiguous' };

/**
 * 把一个 OneBot 消息段数组/字符串拆成 {text, media}。
 * text 只取 text 段：图片/表情/语音这些一律不占位（否则"只有一张图"会被当成有正文投进宿主）。
 * media 记录非文本段的类型，用来决定要不要回一句"目前仅支持文本消息"（M2）。
 */
export function analyzeMessage(message) {
  if (typeof message === 'string') return { text: message.trim(), media: [] };
  if (!Array.isArray(message)) return { text: '', media: [] };
  const parts = [];
  const media = [];
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type === 'text') parts.push(String(seg.data?.text ?? ''));
    else if (typeof seg.type === 'string') media.push(seg.type);
  }
  return { text: parts.join('').trim(), media };
}

/** 只要正文的旧调用点（兼容保留）。 */
export function extractText(message) {
  return analyzeMessage(message).text;
}

/** 宿主一条消息最多接受的图片数（attachment-local 的 maxImagesPerMessage 默认值）。 */
export const MAX_PROMPT_IMAGES = 20;

/**
 * 从消息段里挑出图片段，只留下载要用的字段。
 * 图片现在会真正投给宿主（M4.1），所以不再算"不支持的媒体"。
 */
export function extractImageSegments(message) {
  if (!Array.isArray(message)) return [];
  const images = [];
  for (const seg of message) {
    if (!seg || typeof seg !== 'object' || seg.type !== 'image') continue;
    const data = seg.data && typeof seg.data === 'object' ? seg.data : {};
    images.push({
      file: typeof data.file === 'string' ? data.file : '',
      url: typeof data.url === 'string' ? data.url : '',
      summary: typeof data.summary === 'string' ? data.summary : '',
    });
  }
  return images;
}

// 合并转发段：OneBot 11 里是 {type:'forward', data:{id}}；有的实现把内容 inline 进 data.content。
export const FORWARD_SEGMENT_TYPES = new Set(['forward', 'node']);

/** 从消息段里挑出合并转发段：{id, content}。content 有值说明协议端已经把内容展开好了。 */
export function extractForwardSegments(message) {
  if (!Array.isArray(message)) return [];
  const forwards = [];
  for (const seg of message) {
    if (!seg || typeof seg !== 'object' || !FORWARD_SEGMENT_TYPES.has(seg.type)) continue;
    const data = seg.data && typeof seg.data === 'object' ? seg.data : {};
    // 优先级有讲究：真机实测 get_forward_msg 只认转发 id（res_id/forward_id），
    // 传普通 message_id 会报「消息已过期或者为内层消息，无法获取转发消息」。
    const id = data.id ?? data.res_id ?? data.forward_id ?? data.message_id ?? '';
    const content = Array.isArray(data.content) ? data.content : null;
    if (String(id) === '' && !content) continue;
    forwards.push({ id: String(id ?? ''), content });
  }
  return forwards;
}

// 节点正文里非文本段的短标签；没列的段统一 [类型]。
const NODE_MEDIA_LABELS = {
  image: '[图片]', record: '[语音]', video: '[视频]', file: '[文件]',
  face: '[表情]', mface: '[表情]', json: '[卡片]', xml: '[卡片]', markdown: '[Markdown]',
  music: '[音乐]', dice: '[骰子]', rps: '[猜拳]', poke: '[戳一戳]', shake: '[窗口抖动]',
  at: '', reply: '', nod: '',
};

// 合并转发里的图片上限：一段转发最多挑几张（宿主单条消息总共只收 20 张）。
export const MAX_FORWARD_IMAGES = 9;

/**
 * 把节点里的消息段压成一行文字（只留文本 + 媒体标签）。
 * M6.7：传 collect（{images, maxImages, nodeIndex, who}）时，图片段不只留标签，
 * 还会按出现顺序编号成 [图片1]、[图片2]… 并塞进 collect.images，供调用方真下载后投给模型。
 */
export function formatNodeBody(message, collect = null) {
  if (typeof message === 'string') return message.trim();
  if (!Array.isArray(message)) return '';
  let out = '';
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type === 'text') { out += String(seg.data?.text ?? ''); continue; }
    if (FORWARD_SEGMENT_TYPES.has(seg.type)) { out += '[合并转发]'; continue; }
    if (typeof seg.type !== 'string') continue;
    if (seg.type === 'at') {
      const qq = seg.data?.qq;
      out += qq === 'all' ? '@全体成员 ' : `@${String(qq ?? '')} `;
      continue;
    }
    if (seg.type === 'image' && collect && collect.images.length < collect.maxImages) {
      const data = seg.data && typeof seg.data === 'object' ? seg.data : {};
      const index = collect.images.length + 1;
      collect.images.push({
        label: `图片${index}`,
        index,
        nodeIndex: collect.nodeIndex,
        who: collect.who,
        file: typeof data.file === 'string' ? data.file : '',
        url: typeof data.url === 'string' ? data.url : '',
        summary: typeof data.summary === 'string' ? data.summary : '',
      });
      out += `[图片${index}]`;
      continue;
    }
    if (NODE_MEDIA_LABELS[seg.type] !== undefined) {
      out += NODE_MEDIA_LABELS[seg.type];
      continue;
    }
    if (PASSIVE_SEGMENTS.has(seg.type)) continue;
    out += `[${seg.type}]`;
  }
  return out.replace(/[ \t]+$/g, '').trim();
}

/**
 * 把 get_forward_msg 返回的节点数组压成一段可投递的文字。
 * 有界：最多 maxNodes 条、总字数最多 maxChars（超了写明还剩多少条）、最多 maxImages 张图。
 * maxImages > 0 时节点里的图片会编号成 [图片N] 并收集到 images（file/url/summary + 所属条数/发送者）。
 * 返回 {text, count, shown, truncated, images}。
 */
export function formatForwardNodes(nodes, { maxNodes = 50, maxChars = 4000, maxImages = 0 } = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const shown = [];
  const images = [];
  let chars = 0;
  let truncated = false;
  for (let i = 0; i < list.length && shown.length < maxNodes; i += 1) {
    const node = list[i] && typeof list[i] === 'object' ? list[i] : {};
    const sender = node.sender && typeof node.sender === 'object' ? node.sender : {};
    const who = senderNickname(sender) || (sender.user_id !== undefined ? String(sender.user_id) : '');
    const collect = maxImages > 0
      ? { images, maxImages, nodeIndex: shown.length + 1, who }
      : null;
    const body = formatNodeBody(node.message ?? node.content, collect) || '[空消息]';
    const line = `${shown.length + 1}. ${who ? `${who}：` : ''}${body}`;
    if (chars + line.length > maxChars) {
      truncated = true;
      break;
    }
    shown.push(line);
    chars += line.length + 1;
  }
  if (shown.length < list.length) truncated = true;
  const tail = truncated ? `\n……（共 ${list.length} 条，只展示前 ${shown.length} 条）` : '';
  return { text: `${shown.join('\n')}${tail}`, count: list.length, shown: shown.length, truncated, images };
}

/** 取发送者昵称/群名片（OneBot 在 sender 里给，缺了就用空串）。 */
export function senderNickname(sender) {
  if (!sender || typeof sender !== 'object') return '';
  if (typeof sender.card === 'string' && sender.card.trim()) return sender.card.trim();
  if (typeof sender.nickname === 'string' && sender.nickname.trim()) return sender.nickname.trim();
  return '';
}

/** 消息段里被 @ 的 QQ 号列表（含 "all"）。 */
export function extractMentions(message) {
  if (!Array.isArray(message)) return [];
  const mentions = [];
  for (const seg of message) {
    if (!seg || typeof seg !== 'object' || seg.type !== 'at') continue;
    const qq = seg.data?.qq;
    if (qq !== undefined && qq !== null && String(qq) !== '') mentions.push(String(qq));
  }
  return mentions;
}

/**
 * L1 + L2 门控：放行「主号/授权名单的私聊消息」和「@ 了小号的群消息」。
 * 返回 {ok:true,msg} 或 {ok:false,reason,media?,messageId?,userId?,groupId?,source?}
 * （后几个字段只用于给原发送者回执，不参与投递）。
 *
 * @param {object} raw - OneBot 帧
 * @param {object} cfg - 已归一化的配置
 * @param {object} [options]
 * @param {(qq: string) => boolean} [options.isAllowed] - 私聊是否允许（缺省只放行 mainQQ）
 */
export function parseInbound(raw, cfg, options = {}) {
  if (raw === null || typeof raw !== 'object') return { ok: false, reason: DROP.NOT_OBJECT };
  const hasEcho = Object.prototype.hasOwnProperty.call(raw, 'echo');
  if (hasEcho && (raw.status !== undefined || raw.retcode !== undefined)) {
    return { ok: false, reason: DROP.ACTION_RESPONSE };
  }
  if (raw.post_type !== 'message') return { ok: false, reason: DROP.NOT_MESSAGE };
  if (raw.message_type !== 'private' && raw.message_type !== 'group') {
    return { ok: false, reason: DROP.NOT_PRIVATE };
  }
  const selfId = String(raw.self_id ?? '');
  if (selfId !== String(cfg.botQQ)) return { ok: false, reason: DROP.WRONG_SELF };

  const isAllowed = typeof options.isAllowed === 'function'
    ? options.isAllowed
    : (qq) => String(qq) === String(cfg.mainQQ);

  const source = raw.message_type === 'private' ? 'private' : 'group';
  const userId = String(raw.user_id ?? raw.sender?.user_id ?? '');
  const groupId = source === 'group' ? String(raw.group_id ?? '') : null;
  if (userId && userId === selfId) {
    return { ok: false, reason: DROP.SELF_MESSAGE, userId, groupId, source };
  }
  if (source === 'private' && cfg.allowAllPrivate !== true && !isAllowed(userId)) {
    return { ok: false, reason: DROP.WRONG_USER, userId, groupId, source };
  }
  const mentions = extractMentions(raw.message);
  const mentioned = mentions.includes(selfId);
  if (source === 'group' && cfg.groupRequireMention !== false && !mentioned) {
    return { ok: false, reason: DROP.GROUP_NO_MENTION, userId, groupId, source };
  }
  if (source === 'group' && !groupId) {
    return { ok: false, reason: DROP.NOT_PRIVATE, userId, groupId, source };
  }

  const { text, media } = analyzeMessage(raw.message);
  const allImages = extractImageSegments(raw.message);
  const images = allImages.slice(0, MAX_PROMPT_IMAGES);
  // 合并转发段：本身没正文，但内容能靠 get_forward_msg 取回来，所以不能按"空消息"丢弃。
  const forwards = extractForwardSegments(raw.message);
  const supportedMedia = (type) => type !== 'image' && !PASSIVE_SEGMENTS.has(type) && !FORWARD_SEGMENT_TYPES.has(type);
  if (!text && images.length === 0 && forwards.length === 0) {
    return {
      ok: false,
      reason: DROP.EMPTY_TEXT,
      media: media.filter((type) => !PASSIVE_SEGMENTS.has(type) && !FORWARD_SEGMENT_TYPES.has(type)),
      messageId: String(raw.message_id ?? ''),
      userId,
      rawUserId: raw.user_id,
      groupId,
      rawGroupId: raw.group_id,
      source,
    };
  }
  const warnings = [];
  if (typeof raw.message === 'string') warnings.push('message-post-format-string');
  if (allImages.length > images.length) warnings.push('image-limit-trimmed');
  const msg = {
    messageId: String(raw.message_id ?? ''),
    selfId,
    userId,
    // 回复时用帧里的原始值（数字/字符串都照原样发回，OneBot 两种都认）
    rawUserId: raw.user_id,
    rawGroupId: raw.group_id,
    source,
    groupId,
    nickname: senderNickname(raw.sender),
    mentioned,
    text,
    images,
    forwards,
    // 图片/合并转发已经能投递、@/引用/表情静默忽略，这里只剩语音/文件这类真不支持的段
    media: media.filter(supportedMedia),
    time: typeof raw.time === 'number' ? raw.time : Math.floor(Date.now() / 1000),
    warnings,
  };
  return { ok: true, msg };
}

/** 有界去重：按 OneBot message_id 判重，超过容量丢最旧的。 */
export class Dedupe {
  constructor({ max = 1024 } = {}) {
    this.max = max;
    this.seenIds = new Set();
  }

  /** 第一次见到返回 false，重复返回 true。 */
  seen(id) {
    if (!id) return false;
    if (this.seenIds.has(id)) return true;
    this.seenIds.add(id);
    if (this.seenIds.size > this.max) {
      const oldest = this.seenIds.values().next().value;
      this.seenIds.delete(oldest);
    }
    return false;
  }
}

/** 在飞 rid 集合：带 TTL、有上限、命中即消费（一次性）。 */
export class RidGate {
  constructor({ ttlMs = 30 * 60 * 1000, max = 512, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.now = now;
    this.inflight = new Map();
  }

  issue(rid) {
    this.sweep();
    this.inflight.set(rid, this.now() + this.ttlMs);
    while (this.inflight.size > this.max) {
      const oldest = this.inflight.keys().next().value;
      this.inflight.delete(oldest);
    }
    return rid;
  }

  has(rid) {
    const exp = this.inflight.get(rid);
    if (exp === undefined) return false;
    if (exp <= this.now()) {
      this.inflight.delete(rid);
      return false;
    }
    return true;
  }

  consume(rid) {
    const hit = this.has(rid);
    if (hit) this.inflight.delete(rid);
    return hit;
  }

  sweep() {
    const t = this.now();
    for (const [rid, exp] of this.inflight) if (exp <= t) this.inflight.delete(rid);
  }

  get size() {
    this.sweep();
    return this.inflight.size;
  }
}

/**
 * 一个 turn 的归属判定器。
 * 只做一件事：把这个 turn 里出现过的 rpcId 收集起来，最后用 RidGate 判「是不是我发起的」。
 * 不依赖事件顺序、不依赖第几条、不依赖事件类型——M0 实测宿主每回合注入 4 条无 rpcId 的 user/message。
 */
export class TurnTracker {
  constructor(turn = null) {
    this.turn = turn;
    this.rids = new Set();
    this.injectedUserMessages = 0;
    this.texts = [];
    this.assistantMessages = 0;
    this.ended = null;
  }

  noteUserSource(source) {
    const rid = source && typeof source.rpcId === 'string' ? source.rpcId : '';
    if (rid) this.rids.add(rid);
    else this.injectedUserMessages += 1;
  }

  noteAssistantText(text) {
    this.assistantMessages += 1;
    if (text) this.texts.push(text);
  }

  /** @returns {{verdict:string, ownRid:string|null, foreignRids:string[]}} */
  verdict(gate) {
    const own = [];
    const foreign = [];
    for (const rid of this.rids) (gate.has(rid) ? own : foreign).push(rid);
    if (own.length === 0) return { verdict: TURN_VERDICT.FOREIGN, ownRid: null, foreignRids: foreign };
    if (own.length > 1) return { verdict: TURN_VERDICT.AMBIGUOUS, ownRid: null, foreignRids: foreign };
    return { verdict: TURN_VERDICT.OWN, ownRid: own[0], foreignRids: foreign };
  }

  get text() {
    return this.texts.join('\n\n').trim();
  }
}

/** 只取 assistant 消息里的 text 块；reasoning / tool-call 一律不推。 */
export function assistantText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}
