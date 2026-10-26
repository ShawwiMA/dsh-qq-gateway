// M9：入站防护 —— 限流 / 重复内容 / 突发合并判定 / 事件门控。
//
// 为什么单独一层：
// 1) 网关主循环只该关心“投不投、合不合”，把这些判定抽出来才能离线拨钟测试；
// 2) 零依赖、零 IO、不碰 cordis，所有时间都从注入的 now() 取，测试里想快进就快进；
// 3) 外部字段一律不可信，所以模块在任何输入下都不 throw：防护自己崩了等于把入站口敞开。
//    边界输入统一按安全侧收口：userId 空当身份不明的外部用户（不享受主号豁免），
//    正文非字符串/空白当空正文（不建指纹），config 缺字段或脏值回默认值。

const RATE_WINDOW_MS = 60_000; // 令牌桶口径：capacity 个令牌 / 60 秒
const AUTO_MUTE_STREAK = 5; // 同一来源（source:userId）连续被限流 5 次
const AUTO_MUTE_COOLDOWN_MS = 10 * 60_000; // 两次自动禁回至少隔 10 分钟
const EVENT_DUP_WINDOW_MS = 30_000; // 事件去重窗口
const MERGE_LIMIT = 10; // 同一串最多合并 10 条，再往后单发
const CACHE_LIMIT = 2048; // 指纹/事件缓存上限，FIFO 淘汰，防止长跑后内存涨爆
const AUTO_MUTE_REASON = '频控自动禁回：短时间消息过多';

const DEFAULTS = {
  rateLimitPerMinute: 10,
  dupWindowMinutes: 10,
  burstMergeMs: 1500,
  autoMuteMinutes: 10,
};

/** 只认对象（数组、null 都算脏输入）。 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 只认有限数字；null / undefined / 空串 / 脏字符串一律回默认值。 */
function finiteOr(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 外部标量转字符串：对象/数组/布尔/null 一律当空串，避免 '[object Object]' 混进 key。 */
function textOf(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  return '';
}

/** 来源归一（private / group 之类）；空来源留给调用方兜底。 */
function normalizeSource(value) {
  return textOf(value).trim();
}

/** QQ 号/群号归一：统一按字符串比较，'123' 和 123 视为同一个人。 */
function normalizeId(value) {
  return textOf(value).trim();
}

/**
 * 正文归一：小写 + 连续空白压成一个空格 + 首尾去空白。
 * QQ 转发、复制粘贴常改大小写和换行，不归一化就抓不住“同一句话被刷两遍”。
 */
function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 非空正文：非字符串、纯空白都算空（安全侧，不建指纹也不参与合并）。 */
function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 事件身份：优先 userId，没有就按群兜底，再没有就 '?'。
 * 同一身份共用一个事件令牌桶；桶 key 会在外面加 'event:' 前缀，和消息桶彻底分开。
 */
function eventIdentity(event) {
  const userId = normalizeId(event.userId);
  if (userId) return userId;
  return `group:${event.groupId ?? '?'}`;
}

/**
 * 事件去重 key，按规格拼：type|userId|groupId|time。
 * time 是 OneBot 的 unix 秒，同一秒内同人同群的同类事件会被当成重复——这正是想要的，
 * NapCat 断线重连会把旧事件重放一遍。
 */
function eventDedupeKey(event) {
  return `${event.type}|${event.userId ?? ''}|${event.groupId ?? ''}|${event.time ?? ''}`;
}

/** 计数器初始值；reset() 也复用这一份结构。 */
function emptyCounters() {
  return { rateLimited: 0, duplicates: 0, eventsDropped: 0, autoMuted: 0, merged: 0 };
}

/**
 * 创建入站防护器。
 *
 * @param {object} [options]
 * @param {object} [options.config] - rateLimitPerMinute / dupWindowMinutes / burstMergeMs / autoMuteMinutes
 * @param {(message: string) => void} [options.log] - 只在自动禁回这类“要人知道”的时刻写一行
 * @param {() => number} [options.now] - 毫秒时间源；测试注入，生产就是 Date.now
 * @returns {{
 *   checkMessage: (msg: {userId?: unknown, source?: unknown, text?: unknown, isMain?: unknown}) => object,
 *   checkEvent: (input: {event?: unknown, isMain?: unknown}) => object,
 *   canMerge: (prev: unknown, next: unknown) => boolean,
 *   countersSnapshot: () => {rateLimited: number, duplicates: number, eventsDropped: number, autoMuted: number, merged: number},
 *   reset: () => void,
 * }}
 */
export function createGuard({ config = {}, log = () => {}, now = () => Date.now() } = {}) {
  const cfg = isObject(config) ? config : {};
  const logFn = typeof log === 'function' ? log : () => {};
  const nowFn = typeof now === 'function' ? now : () => Date.now();

  // 配置一次算好：后续每次判定不再重复做类型判断，也保证同一实例口径稳定。
  // rateLimitPerMinute 同时是桶容量和“每 60 秒补多少”，最小 1；0/负数/脏值不能变成“全放行”。
  const rateLimitPerMinute = Math.max(
    1,
    Math.floor(finiteOr(cfg.rateLimitPerMinute, DEFAULTS.rateLimitPerMinute)),
  );
  const dupWindowMs = Math.max(0, finiteOr(cfg.dupWindowMinutes, DEFAULTS.dupWindowMinutes)) * 60_000;
  const burstMergeMs = Math.max(0, finiteOr(cfg.burstMergeMs, DEFAULTS.burstMergeMs));
  const autoMuteConfigured = cfg.autoMuteMinutes ?? DEFAULTS.autoMuteMinutes;
  const autoMuteDigits = finiteOr(autoMuteConfigured, DEFAULTS.autoMuteMinutes);
  const autoMuteMinutes = autoMuteDigits >= 0 ? autoMuteDigits : DEFAULTS.autoMuteMinutes;
  // config.js 约定 autoMuteMinutes=0 表示“只丢弃、不自动禁回”。
  // 这里必须自己拦：mute.js 里 minutes=0 是“永久”，直接透传会把 0 变成永久禁言。
  const autoMuteEnabled = autoMuteMinutes > 0;

  const refillPerMs = rateLimitPerMinute / RATE_WINDOW_MS;

  let counters = emptyCounters();
  const buckets = new Map(); // `${source}:${userId}` / `event:${identity}` -> { tokens, at }
  const fingerprints = new Map(); // 消息指纹 -> 首次出现时间（Map 插入序 = FIFO）
  const eventSeen = new Map(); // 事件 key -> 首次出现时间
  const messageStreaks = new Map(); // 消息发送上下文 -> 连续被限流次数
  const eventStreaks = new Map(); // 事件身份 -> 连续被限流次数
  // 消息和事件的自动禁回冷却分开存：两边的 key 命名空间不同，共用一张表会串味。
  const lastMessageMuteAt = new Map(); // 消息 scope -> 上次自动禁回时间
  const lastEventMuteAt = new Map(); // 事件身份 -> 上次自动禁回时间

  /** 注入的时间源；坏值/抛错退系统时间，和 mute.js 的处理保持一致。 */
  function clock() {
    try {
      const value = nowFn();
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  }

  /** 日志是旁路；写日志失败不影响防护判定。 */
  function emit(message) {
    try {
      logFn(message);
    } catch {
      // 忽略
    }
  }

  function bucketFor(key, at) {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: rateLimitPerMinute, at };
      buckets.set(key, bucket);
    }
    return bucket;
  }

  /** 取一个令牌；桶空返回 false。时间回拨不补 token，避免靠反复拨钟白嫖额度。 */
  function takeToken(bucket, at) {
    if (at > bucket.at) {
      bucket.tokens = Math.min(
        rateLimitPerMinute,
        bucket.tokens + (at - bucket.at) * refillPerMs,
      );
      bucket.at = at;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /**
   * 记一次“被限流”，并跑自动禁回阶梯：
   * 同一来源连续 limit 且中间没有成功放行 -> 到 5 次；且距上次自动禁回超过 10 分钟 -> 触发。
   * 触发后连续计数清零（下次要重新攒），冷却起点刷新为当前时间。
   */
  function noteRateLimited(scopeKey, streaks, lastMutes, at) {
    counters.rateLimited += 1;
    const streak = (streaks.get(scopeKey) ?? 0) + 1;
    streaks.set(scopeKey, streak);
    const last = lastMutes.get(scopeKey) ?? -Infinity;
    if (autoMuteEnabled && streak >= AUTO_MUTE_STREAK && at - last > AUTO_MUTE_COOLDOWN_MS) {
      streaks.set(scopeKey, 0);
      lastMutes.set(scopeKey, at);
      counters.autoMuted += 1;
      emit(`${scopeKey} 连续被限流 ${AUTO_MUTE_STREAK} 次，自动禁回 ${autoMuteMinutes} 分钟`);
      return {
        ok: false,
        reason: 'rate-limit',
        autoMute: { minutes: autoMuteMinutes, reason: AUTO_MUTE_REASON },
      };
    }
    return { ok: false, reason: 'rate-limit', autoMute: null };
  }

  /** 窗口内是否见过；没见过/已过期就记一笔，超上限淘汰最旧的（FIFO）。 */
  function seenRecently(cache, key, at, windowMs) {
    const first = cache.get(key);
    if (first !== undefined && at - first < windowMs) return true;
    // 过期/新指纹：删了再插，保证 Map 插入序就是“最近一次新增”的顺序，
    // 超上限时删最旧的那条，缓存不会无限长。
    cache.delete(key);
    cache.set(key, at);
    if (cache.size > CACHE_LIMIT) {
      cache.delete(cache.keys().next().value);
    }
    return false;
  }

  /** 消息去重：空正文/非字符串不建指纹，否则所有人发的空消息会互相误杀。 */
  function isDuplicateMessage(scopeKey, text, at) {
    const normalized = normalizeText(text);
    if (!normalized) return false;
    // \u0000 分隔：QQ 号是数字、正文任意，用不可见字符避免“12+34”和“1+234”之类的拼接歧义。
    return seenRecently(fingerprints, `${scopeKey}\u0000${normalized}`, at, dupWindowMs);
  }

  /**
   * 消息入站判定。
   * 返回 {ok:true} 或 {ok:false, reason:'rate-limit'|'duplicate', autoMute:null|{minutes,reason}}。
   */
  function checkMessage(input = {}) {
    const args = isObject(input) ? input : {};
    // 主号免疫：自己的运维指令必须随时能进来，限流/去重/自动禁回一概不套。
    if (args.isMain === true) return { ok: true };

    const at = clock();
    const source = normalizeSource(args.source) || 'unknown';
    const userId = normalizeId(args.userId);
    const bucketKey = `${source}:${userId}`;

    const bucket = bucketFor(bucketKey, at);
    // 先限流后去重：刷屏者拿重复内容硬刷也该吃频控；规格条目顺序也是限流在前。
    if (!takeToken(bucket, at)) {
      return noteRateLimited(bucketKey, messageStreaks, lastMessageMuteAt, at);
    }

    if (isDuplicateMessage(bucketKey, args.text, at)) {
      counters.duplicates += 1;
      return { ok: false, reason: 'duplicate', autoMute: null };
    }

    // 真正放行一次才清连续限流计数；重复内容不算“成功放行”，不打断计时。
    messageStreaks.delete(bucketKey);
    return { ok: true };
  }

  /**
   * 事件入站判定（notice / request / message_sent 等）。
   * 返回形状和 checkMessage 一致。
   */
  function checkEvent(input = {}) {
    const args = isObject(input) ? input : {};
    const event = isObject(args.event) ? args.event : {};

    // 心跳/生命周期只进事件存储，不进限流：NapCat 心跳几秒一次，被频控挡掉只会误判“网关掉线”。
    if (event.kind === 'meta_event') return { ok: true };
    if (args.isMain === true) return { ok: true };

    const at = clock();
    const identity = eventIdentity(event);
    const bucketKey = `event:${identity}`;

    const bucket = bucketFor(bucketKey, at);
    if (!takeToken(bucket, at)) {
      counters.eventsDropped += 1;
      return noteRateLimited(identity, eventStreaks, lastEventMuteAt, at);
    }

    if (seenRecently(eventSeen, eventDedupeKey(event), at, EVENT_DUP_WINDOW_MS)) {
      counters.duplicates += 1;
      counters.eventsDropped += 1;
      return { ok: false, reason: 'duplicate', autoMute: null };
    }

    eventStreaks.delete(identity);
    return { ok: true };
  }

  /**
   * 突发合并判定：同人、同源、两条都是带正文的消息，且时间差在 burstMergeMs 内，
   * 并且这一串还没到合并上限（prev.mergedCount 默认 1，到 10 就停止合并）。
   */
  function canMerge(prev, next) {
    if (!isObject(prev) || !isObject(next)) return false;
    if (prev.kind !== 'message' || next.kind !== 'message') return false;

    // 空来源/空 userId 不当成“同一个人”：身份不明时宁可不合并，别把两个人的话拼一起。
    const source = normalizeSource(prev.source);
    if (!source || source !== normalizeSource(next.source)) return false;

    const userId = normalizeId(prev.userId);
    if (!userId || userId !== normalizeId(next.userId)) return false;

    if (!hasText(prev.text) || !hasText(next.text)) return false;

    const delta = Number(next.at) - Number(prev.at);
    if (!Number.isFinite(delta) || delta > burstMergeMs) return false;

    const mergedCount = Number(prev.mergedCount ?? 1);
    if (!(mergedCount < MERGE_LIMIT)) return false;

    // 本模块没有单独的“确认合并”入口，判定为可合并就记一次；Lead 每次只调一次。
    counters.merged += 1;
    return true;
  }

  /** 计数的只读快照（新对象，外部改不到内部账本）。 */
  function countersSnapshot() {
    return { ...counters };
  }

  /** 清空桶、指纹、事件窗口、阶梯状态和计数。 */
  function reset() {
    buckets.clear();
    fingerprints.clear();
    eventSeen.clear();
    messageStreaks.clear();
    eventStreaks.clear();
    lastMessageMuteAt.clear();
    lastEventMuteAt.clear();
    counters = emptyCounters();
  }

  return { checkMessage, checkEvent, canMerge, countersSnapshot, reset };
}
