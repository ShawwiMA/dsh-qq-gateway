// 事件层：OneBot 11 非 message 帧（notice / request / meta_event / message_sent）的
// 解析归一化、中文一句话描述、过滤匹配和有界事件存储。
// 全是纯逻辑，不碰网络、不碰 cordis，离线可单测；gateway.js 只负责把帧递进来。

export const EVENT = {
  NOTICE: 'notice',
  REQUEST: 'request',
  META_EVENT: 'meta_event',
  MESSAGE_SENT: 'message_sent',
};

const EVENT_KINDS = new Set(Object.values(EVENT));

/** 空值归一：undefined / null / '' → null，其余转字符串（QQ 号、群号统一按字符串存）。 */
function str(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

/** 数字归一：只认有限数字，其余 → null。 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 帧时间：OneBot 给 unix 秒；没有就退回当前时间。 */
function frameTime(raw) {
  return typeof raw.time === 'number' && Number.isFinite(raw.time)
    ? raw.time
    : Math.floor(Date.now() / 1000);
}

/** 文件对象归一：{id,name,size,url}；给字符串时当文件名兜底。 */
function normFile(file) {
  if (file === undefined || file === null) return null;
  if (typeof file === 'string') return { id: null, name: file, size: null, url: null };
  if (typeof file !== 'object' || Array.isArray(file)) return null;
  return {
    id: str(file.id),
    name: str(file.name),
    size: num(file.size),
    url: str(file.url),
  };
}

/** 事件公共字段：能取到就填，取不到一律 null（后续字段由各解析器补齐）。 */
function baseEvent(kind, type, raw) {
  return {
    kind,
    type,
    subType: null,
    time: frameTime(raw),
    selfId: str(raw.self_id),
    groupId: null,
    userId: null,
    operatorId: null,
    targetId: null,
    messageId: null,
    flag: null,
    comment: null,
    duration: null,
    cardNew: null,
    cardOld: null,
    file: null,
    status: null,
    interval: null,
    messageType: null,
    raw,
  };
}

/** notice：notice_type 原样进 type 后缀，未知类型也不丢帧（方便日志排查）。 */
function parseNotice(raw) {
  const noticeType = typeof raw.notice_type === 'string' && raw.notice_type ? raw.notice_type : 'unknown';
  const event = baseEvent(EVENT.NOTICE, `notice.${noticeType}`, raw);
  event.subType = str(raw.sub_type);
  event.groupId = str(raw.group_id);
  event.userId = str(raw.user_id);
  event.operatorId = str(raw.operator_id);
  event.targetId = str(raw.target_id);
  event.messageId = str(raw.message_id);
  event.duration = num(raw.duration);
  event.cardNew = str(raw.card_new);
  event.cardOld = str(raw.card_old);
  event.file = normFile(raw.file);
  return event;
}

/** request：friend / group 用 request_type 细分；flag/comment 原样留着给后续处理。 */
function parseRequest(raw) {
  const requestType = typeof raw.request_type === 'string' && raw.request_type ? raw.request_type : 'unknown';
  const event = baseEvent(EVENT.REQUEST, `request.${requestType}`, raw);
  event.groupId = str(raw.group_id);
  event.userId = str(raw.user_id);
  event.flag = str(raw.flag);
  event.comment = str(raw.comment);
  return event;
}

/** meta_event：heartbeat 留 status/interval，lifecycle 留 sub_type（connect/enable/disable）。 */
function parseMetaEvent(raw) {
  const metaType = typeof raw.meta_event_type === 'string' && raw.meta_event_type ? raw.meta_event_type : 'unknown';
  const event = baseEvent(EVENT.META_EVENT, `meta_event.${metaType}`, raw);
  event.subType = str(raw.sub_type);
  if (metaType === 'heartbeat') {
    event.status = raw.status && typeof raw.status === 'object' ? raw.status : null;
    event.interval = num(raw.interval);
  }
  return event;
}

/** message_sent：自己发出的消息，用 message_type 细分 private/group。 */
function parseMessageSent(raw) {
  const messageType = typeof raw.message_type === 'string' && raw.message_type ? raw.message_type : 'unknown';
  const event = baseEvent(EVENT.MESSAGE_SENT, `message_sent.${messageType}`, raw);
  event.messageType = messageType;
  event.messageId = str(raw.message_id);
  event.groupId = str(raw.group_id);
  event.userId = str(raw.user_id);
  return event;
}

/**
 * 解析一个已 JSON.parse 的 OneBot 帧。
 * 只认 notice / request / meta_event / message_sent；普通 message 帧仍归协议层 parseInbound 处理。
 *
 * @param {object} raw
 * @param {{botQQ?: string|number}} [opts] - botQQ 用于校验 self_id（两边都有且不一致就拒）
 * @returns {{ok:true,event:object}|{ok:false,reason:'not-object'|'not-event'|'wrong-self'}}
 */
export function parseEventFrame(raw, opts = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'not-object' };
  }
  const postType = raw.post_type;
  if (!EVENT_KINDS.has(postType)) return { ok: false, reason: 'not-event' };
  const options = opts && typeof opts === 'object' ? opts : {};
  const botQQ = str(options.botQQ);
  const selfId = str(raw.self_id);
  if (botQQ !== null && selfId !== null && selfId !== botQQ) {
    return { ok: false, reason: 'wrong-self' };
  }

  let event;
  if (postType === EVENT.NOTICE) event = parseNotice(raw);
  else if (postType === EVENT.REQUEST) event = parseRequest(raw);
  else if (postType === EVENT.META_EVENT) event = parseMetaEvent(raw);
  else event = parseMessageSent(raw);
  return { ok: true, event };
}

/** 缺字段时的占位文案。 */
function tag(value) {
  return value === null || value === undefined || value === '' ? '未知' : String(value);
}

/** 拼接可选的补充片段（空片段丢掉）。 */
function joinParts(...parts) {
  return parts.filter(Boolean).join('，');
}

/** 把事件描述成一句中文；返回字符串不含换行。 */
function describeOne(event) {
  switch (event.type) {
    case 'notice.friend_recall':
      return `好友 ${tag(event.userId)} 撤回了消息 ${tag(event.messageId)}`;
    case 'notice.group_recall':
      if (event.operatorId && event.operatorId !== event.userId) {
        return `群 ${tag(event.groupId)} 里 ${tag(event.userId)} 的消息 ${tag(event.messageId)} 被 ${tag(event.operatorId)} 撤回`;
      }
      return `群 ${tag(event.groupId)} 的群友 ${tag(event.userId)} 撤回了消息 ${tag(event.messageId)}`;
    case 'notice.group_increase': {
      const how = event.subType === 'approve'
        ? '批准入群'
        : event.subType === 'invite'
          ? '邀请入群'
          : tag(event.subType);
      const op = event.operatorId ? `，操作者 ${event.operatorId}` : '';
      return `群 ${tag(event.groupId)} 新增成员 ${tag(event.userId)}（方式：${how}${op}）`;
    }
    case 'notice.group_decrease':
      if (event.subType === 'kick') return `群 ${tag(event.groupId)} 里 ${tag(event.userId)} 被踢出（操作者 ${tag(event.operatorId)}）`;
      if (event.subType === 'kick_me') return `自己在群 ${tag(event.groupId)} 被踢出（操作者 ${tag(event.operatorId)}）`;
      if (event.subType === 'leave') return `群 ${tag(event.groupId)} 的成员 ${tag(event.userId)} 退群了`;
      return `群 ${tag(event.groupId)} 的成员 ${tag(event.userId)} 离群（方式：${tag(event.subType)}）`;
    case 'notice.group_admin':
      if (event.subType === 'set') return `群 ${tag(event.groupId)} 的 ${tag(event.userId)} 被设为管理员`;
      if (event.subType === 'unset') return `群 ${tag(event.groupId)} 的 ${tag(event.userId)} 被取消管理员`;
      return `群 ${tag(event.groupId)} 的 ${tag(event.userId)} 管理员状态变更为 ${tag(event.subType)}`;
    case 'notice.group_ban':
      if (event.subType === 'lift_ban') {
        return `群 ${tag(event.groupId)} 里 ${tag(event.userId)} 被 ${tag(event.operatorId)} 解除禁言`;
      }
      return `群 ${tag(event.groupId)} 里 ${tag(event.userId)} 被 ${tag(event.operatorId)} 禁言 ${tag(event.duration)} 秒`;
    case 'notice.friend_add':
      return `新增好友 ${tag(event.userId)}`;
    case 'notice.group_file_upload': {
      const file = event.file ?? {};
      return `群 ${tag(event.groupId)} 里 ${tag(event.userId)} 上传了文件 ${tag(file.name ?? file.id)}（大小 ${tag(file.size)} 字节）`;
    }
    case 'notice.group_card':
      return `群 ${tag(event.groupId)} 里 ${tag(event.userId)} 的群名片从「${tag(event.cardOld)}」改为「${tag(event.cardNew)}」`;
    case 'notice.essence': {
      const verb = event.subType === 'delete' ? '取消精华' : '设为精华';
      return `群 ${tag(event.groupId)} 里消息 ${tag(event.messageId)} 被 ${tag(event.operatorId)} ${verb}`;
    }
    case 'notice.offline_file': {
      const file = event.file ?? {};
      return `好友 ${tag(event.userId)} 发来离线文件 ${tag(file.name ?? file.id)}（大小 ${tag(file.size)} 字节）`;
    }
    case 'notice.notify': {
      const sub = event.subType ?? 'unknown';
      if (sub === 'poke') {
        return event.groupId
          ? `群 ${tag(event.groupId)} 里 ${tag(event.userId)} 戳了戳 ${tag(event.targetId)}`
          : `好友 ${tag(event.userId)} 戳了戳你`;
      }
      if (sub === 'lucky_king') return `群 ${tag(event.groupId)} 里 ${tag(event.userId)} 成为运气王`;
      if (sub === 'honor') {
        const honor = str(event.raw?.honor_type);
        return `群 ${tag(event.groupId)} 里 ${tag(event.userId)} 获得群荣誉${honor ? ` ${honor}` : ''}`;
      }
      if (sub === 'input_status') return `群 ${tag(event.groupId)} 里 ${tag(event.userId)} 正在输入`;
      return event.groupId
        ? `群 ${tag(event.groupId)} 收到通知 ${sub}（用户 ${tag(event.userId)}，目标 ${tag(event.targetId)}）`
        : `收到通知 ${sub}（用户 ${tag(event.userId)}，目标 ${tag(event.targetId)}）`;
    }
    case 'request.friend':
      return `收到加好友申请：QQ ${tag(event.userId)}，flag=${tag(event.flag)}${event.comment ? `，附言：${event.comment}` : ''}`;
    case 'request.group':
      return `收到加群申请：QQ ${tag(event.userId)} 申请加入群 ${tag(event.groupId)}，flag=${tag(event.flag)}${event.comment ? `，附言：${event.comment}` : ''}`;
    case 'meta_event.heartbeat': {
      const status = event.status && typeof event.status === 'object' ? event.status : null;
      const interval = event.interval === null || event.interval === undefined ? '未知' : event.interval;
      if (!status) return `心跳：间隔 ${interval}ms`;
      return `心跳：${status.online ? '在线' : '离线'}，${status.good ? 'good' : '异常'}，间隔 ${interval}ms`;
    }
    case 'meta_event.lifecycle':
      return `连接生命周期：${tag(event.subType)}`;
    default:
      break;
  }

  if (event.kind === EVENT.MESSAGE_SENT) {
    if (event.messageType === 'group') return `已发送群消息 ${tag(event.messageId)} 到群 ${tag(event.groupId)}`;
    if (event.messageType === 'private') return `已发送私聊消息 ${tag(event.messageId)} 给 QQ ${tag(event.userId)}`;
    return `已发送消息 ${tag(event.messageId)}（类型 ${tag(event.messageType)}）`;
  }
  if (event.kind === EVENT.NOTICE) {
    const noticeName = String(event.type ?? 'notice.unknown').replace(/^notice\./, '');
    const name = event.subType ? `${noticeName}/${event.subType}` : noticeName;
    const bits = joinParts(
      event.groupId ? `群 ${event.groupId}` : null,
      event.userId ? `用户 ${event.userId}` : null,
      event.operatorId ? `操作者 ${event.operatorId}` : null,
      event.messageId ? `消息 ${event.messageId}` : null,
    );
    return bits ? `收到通知 ${name}（${bits}）` : `收到通知 ${name}`;
  }
  if (event.kind === EVENT.REQUEST) {
    return `收到请求 ${tag(event.type)}：QQ ${tag(event.userId)}，flag=${tag(event.flag)}`;
  }
  if (event.kind === EVENT.META_EVENT) {
    return `元事件 ${tag(event.type)}${event.subType ? `：${event.subType}` : ''}`;
  }
  return `事件 ${tag(event.type)}`;
}

/**
 * 中文一句话描述，给模型/日志看。
 * 保证不含换行（附言里的 \r\n\t 会被压成空格）。
 */
export function describeEvent(event) {
  if (!event || typeof event !== 'object') return '未知事件';
  return describeOne(event).replace(/[\r\n\t]+/g, ' ').trim();
}

/**
 * 过滤用的稳定键：
 * notice → 'notice.group_recall' 等；request → 'request'；
 * meta_event → 'meta_event.heartbeat' / 'meta_event.lifecycle'；message_sent → 'message_sent'。
 */
export function eventKey(event) {
  if (!event || typeof event !== 'object') return '';
  if (event.kind === EVENT.NOTICE) {
    return typeof event.type === 'string' && event.type ? event.type : 'notice.unknown';
  }
  if (event.kind === EVENT.REQUEST) return EVENT.REQUEST;
  if (event.kind === EVENT.META_EVENT) {
    return typeof event.type === 'string' && event.type ? event.type : 'meta_event.unknown';
  }
  if (event.kind === EVENT.MESSAGE_SENT) return EVENT.MESSAGE_SENT;
  return typeof event.type === 'string' ? event.type : '';
}

/** 过滤条件归一：字符串（逗号分隔）或数组，都拆成模式列表；空 → 空列表。 */
function normalizeFilter(filter) {
  if (filter === undefined || filter === null) return [];
  const list = Array.isArray(filter) ? filter : [filter];
  const patterns = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    for (const piece of item.split(',')) {
      const pattern = piece.trim();
      if (pattern) patterns.push(pattern);
    }
  }
  return patterns;
}

/**
 * 过滤匹配：支持精确键、'notice.*' 前缀通配、'*' 全通配。
 * filter 为空（''、空白、[]、null）时不匹配任何事件。
 *
 * @param {string} key - eventKey(event) 的结果
 * @param {string|string[]|null} filter
 * @returns {boolean}
 */
export function matchesEventFilter(key, filter) {
  if (typeof key !== 'string' || key === '') return false;
  const patterns = normalizeFilter(filter);
  if (patterns.length === 0) return false;
  for (const pattern of patterns) {
    if (pattern === '*' || pattern === key) return true;
    if (pattern.endsWith('.*') && key.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

/** 有界事件存储：seq 从 1 递增、超 max 丢最旧；counters 是累计值，size 是当前缓冲条数。 */
export class EventStore {
  constructor({ max = 200, now } = {}) {
    this.max = Number.isFinite(max) && max > 0 ? Math.floor(max) : 200;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.items = [];
    this.seqCounter = 0;
    this.total = 0;
    this.byKind = {
      [EVENT.NOTICE]: 0,
      [EVENT.REQUEST]: 0,
      [EVENT.META_EVENT]: 0,
      [EVENT.MESSAGE_SENT]: 0,
    };
    this.byKey = {};
  }

  /** 注入的 now 兜底成毫秒数。 */
  nowMs() {
    const value = this.now();
    return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
  }

  /** 存一条事件：赋 seq + at(ISO)，返回存下来的副本；超过 max 丢最旧。 */
  push(event) {
    if (!event || typeof event !== 'object') throw new TypeError('EventStore.push 需要事件对象');
    const stored = { ...event, seq: this.seqCounter + 1, at: new Date(this.nowMs()).toISOString() };
    this.seqCounter += 1;
    if (stored.kind === EVENT.REQUEST) stored.resolved = false;
    this.items.push(stored);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    this.total += 1;
    this.byKind[stored.kind] = (this.byKind[stored.kind] ?? 0) + 1;
    const key = eventKey(stored);
    if (key) this.byKey[key] = (this.byKey[key] ?? 0) + 1;
    return stored;
  }

  /** 按 kind 过滤、seq > sinceSeq、最多 limit 条（旧的在前）。 */
  list({ kind, sinceSeq, limit } = {}) {
    let out = this.items;
    if (kind !== undefined && kind !== null) out = out.filter((event) => event.kind === kind);
    if (typeof sinceSeq === 'number' && Number.isFinite(sinceSeq)) {
      out = out.filter((event) => event.seq > sinceSeq);
    }
    if (typeof limit === 'number' && Number.isFinite(limit)) {
      out = out.slice(0, Math.max(0, Math.floor(limit)));
    }
    return out.slice();
  }

  /** 最近 n 条（旧的在前）。 */
  recent(n = 10) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return [];
    return this.items.slice(-Math.floor(n));
  }

  /** 还没 resolve 的 request 事件（旧的在前）。 */
  requests() {
    return this.items.filter((event) => event.kind === EVENT.REQUEST && !event.resolved);
  }

  /** 标记某个 request（按 flag）已处理；返回被标记的事件，找不到返回 null。 */
  resolveRequest(flag) {
    if (flag === undefined || flag === null) return null;
    const needle = String(flag);
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const event = this.items[i];
      if (event.kind === EVENT.REQUEST && !event.resolved && event.flag === needle) {
        event.resolved = true;
        return event;
      }
    }
    return null;
  }

  /** 最近一次 heartbeat 事件或 null。 */
  heartbeat() {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i].type === 'meta_event.heartbeat') return this.items[i];
    }
    return null;
  }

  /** 距离最近心跳的毫秒数（按事件落库时间算）；没有心跳返回 null。 */
  heartbeatAgeMs() {
    const beat = this.heartbeat();
    if (!beat) return null;
    const atMs = Date.parse(beat.at);
    if (!Number.isFinite(atMs)) return null;
    return Math.max(0, this.nowMs() - atMs);
  }

  /** 最近一次 lifecycle 事件或 null。 */
  lifecycle() {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i].type === 'meta_event.lifecycle') return this.items[i];
    }
    return null;
  }

  /** 累计计数：total / byKind / byKey（不受缓冲裁剪影响）。 */
  counters() {
    return {
      total: this.total,
      byKind: { ...this.byKind },
      byKey: { ...this.byKey },
    };
  }

  /** 状态快照：给 /status 之类用。 */
  snapshot() {
    const beat = this.heartbeat();
    const life = this.lifecycle();
    return {
      total: this.total,
      counters: this.counters(),
      heartbeat: beat
        ? {
          at: beat.at,
          interval: beat.interval,
          status: beat.status,
          online: beat.status && typeof beat.status === 'object' ? Boolean(beat.status.online) : null,
          ageMs: this.heartbeatAgeMs(),
        }
        : null,
      lifecycle: life ? { subType: life.subType, at: life.at } : null,
      pendingRequests: this.requests(),
      recent: this.recent(10),
    };
  }

  get size() {
    return this.items.length;
  }
}
