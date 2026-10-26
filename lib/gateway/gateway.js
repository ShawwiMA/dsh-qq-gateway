// 网关总线：反向 WS 收帧 → L1/L2 门控 → 去重 → 有界队列 → 单飞投递 → 旁听会话事件 → L3 判定 → 回传。
// 只依赖注入进来的 ctx（sessionController + on），不 import cordis，方便离线用假宿主跑。
// M2 硬化：媒体回执、turn 超时归属、断线补发缓冲、溢出丢最旧、运行时 token 轮换。
import { fileURLToPath } from 'node:url';

import { createWsServer } from './ws.js';
import { createStatusServer } from './status-server.js';
import { DEFAULT_IMAGE_TIMEOUT_MS, resolveImage } from './media.js';
import { ensureDockerReady } from './docker.js';
import { scheduleDockerShutdown } from './shutdown.js';
import { createAllowList, parseAdminCommand } from './authz.js';
import { createMuteState } from './mute.js';
// 安全升级：入站限流 / 重复内容 / 连发合并 / 事件门控（纯逻辑，可注入时钟）
import { createGuard } from './guard.js';
import {
  CONFIG_FIELDS,
  CONFIG_KEYS,
  ConfigError,
  configSchema,
  defaultConfig,
  missingConfig,
  normalizeConfig,
  publicConfig,
} from './config.js';
import {
  Dedupe,
  DROP,
  MAX_FORWARD_IMAGES,
  MAX_PROMPT_IMAGES,
  RidGate,
  TURN_VERDICT,
  TurnTracker,
  assistantText,
  formatForwardNodes,
  parseInbound,
} from './protocol.js';
// M6：入站事件（notice/request/meta_event/message_sent）解析与存储
import {
  EventStore,
  describeEvent,
  eventKey,
  matchesEventFilter,
  parseEventFrame,
} from './events.js';
// M6：出站能力（动作目录/参数归一化/消息段构造）
import { actionRisk, buildSegments, normalizeAction } from './actions.js';
// M6.1：QQ 聊天框不渲染 Markdown → 渲染成图片再发（Edge headless + Pillow 裁边）
import { looksLikeMarkdown, renderMarkdownToImage } from './markdown-image.js';
import { computeReplyDelayMs, createReplyTimeline } from './human-delay.js';

// M3：配置 Schema 搬进 config.js（单一事实来源）。这里继续导出同名符号，
// 离线测试和旧 import 不用改路径；DEFAULT_CONFIG 仍是"默认值对象"。
export {
  CONFIG_FIELDS,
  CONFIG_KEYS,
  ConfigError,
  configSchema,
  defaultConfig,
  missingConfig,
  normalizeConfig,
  publicConfig,
};

export const DEFAULT_CONFIG = defaultConfig();

function emptyCounters() {
  return {
    inboundFrames: 0,
    accepted: 0,
    dropped: {},
    dedupeHits: 0,
    overflowDropped: 0,
    prompts: 0,
    promptErrors: 0,
    promptsAccepted: 0,
    timeouts: 0,
    skippedTimeoutLate: 0,
    turnsSettled: 0,
    ownTurns: 0,
    relayed: 0,
    skippedForeign: 0,
    skippedAmbiguous: 0,
    skippedAborted: 0,
    skippedEmpty: 0,
    skippedUnauthorized: 0,
    skippedNoMention: 0,
    skippedSelfMessage: 0,
    adminCommands: 0,
    // M8：被禁回丢掉的消息条数（正常是 0；排查"为什么没回"先看它）
    mutedSkipped: 0,
    // 安全升级（2026-10-26）：频控 / 内容去重 / 连发合并 / 事件门控
    rateLimited: 0,
    duplicates: 0,
    mergedMessages: 0,
    autoMuted: 0,
    priorityQueued: 0,
    queueFullDropped: 0,
    eventDropped: 0,
    extraPeers: 0,
    injectedUserMessages: 0,
    foreignSessionEvents: 0,
    actionsSent: 0,
    sendFailures: 0,
    imageParts: 0,
    imageFailures: 0,
    // M6.6：合并转发（get_forward_msg 取回节点内容）
    forwardRead: 0,
    forwardFailures: 0,
    // M6.7：合并转发节点里的图片（真下载后投给模型）
    forwardImages: 0,
    forwardImageFailures: 0,
    unsupportedNotified: 0,
    unsupportedNoticeSuppressed: 0,
    offlineBuffered: 0,
    offlineFlushed: 0,
    offlineDropped: 0,
    tokenRotations: 0,
    connections: 0,
    rejectedConnections: 0,
    // M6.1：Markdown → 图片
    markdownRendered: 0,
    markdownRenderFailures: 0,
    markdownFallbacks: 0,
    // M6.4：本回合工具已发过带文字的消息 → 助手文字不再自动回传（防 QQ 端双发）
    duplicateRepliesSuppressed: 0,
    // M6：入站事件 + 出站能力计数
    notices: 0,
    requests: 0,
    metaEvents: 0,
    messageSentEvents: 0,
    eventPrompts: 0,
    skippedEventReply: 0,
    outboundMessages: 0,
    recalls: 0,
    recallFailures: 0,
    actionCalls: 0,
    actionFailures: 0,
  };
}

const MAX_TRACKERS = 64;
// M6.6：合并转发读取上限（一条消息最多几段转发、每次最多几条节点、正文最多多少字）
const MAX_FORWARD_SEGMENTS = 3;
const MAX_FORWARD_NODES = 50;
const MAX_FORWARD_CHARS = 4000;
/** 启动后多久还没看到 NapCat 连接就告警（小号可能没登录、需要扫码）。 */
const LOGIN_WATCHDOG_MS = 120000;
/** DSH 退出后拉起联动关闭助手的路径（detached 子进程，父进程退出也跑得完）。 */
const SHUTDOWN_HELPER = fileURLToPath(new URL('./shutdown-helper.mjs', import.meta.url));

/**
 * @param {object} options
 * @param {object} options.ctx - 宿主（离线测试注入假宿主）
 * @param {object} [options.config]
 * @param {(message: string) => void} [options.logger]
 * @param {() => number} [options.now] - 媒体回执节流用的时钟（可注入）
 * @param {object} [options.deps] - 图片下载依赖（离线测试注入假 fetch / 调超时）
 * @param {Function} [options.deps.fetchImpl] - 下载图片用；默认全局 fetch
 * @param {number} [options.deps.imageTimeoutMs] - 单图下载/动作超时
 */
export function createGateway({ ctx, config = {}, logger, now, deps = {} } = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  // M6.1：Markdown 渲染器（离线测试注入假实现，避免依赖本机 Edge/Python）
  const renderMarkdown = typeof deps.renderMarkdown === 'function' ? deps.renderMarkdown : renderMarkdownToImage;
  const imageTimeoutMs = Number.isFinite(deps.imageTimeoutMs) && deps.imageTimeoutMs > 0
    ? deps.imageTimeoutMs
    : DEFAULT_IMAGE_TIMEOUT_MS;
  const cfg = normalizeConfig(config);
  const log = typeof logger === 'function' ? logger : () => {};
  // now 只用于媒体回执节流（离线测试可注入假时钟）；rid TTL、定时器一律用真时间。
  const mediaClock = typeof now === 'function' ? now : () => Date.now();
  const counters = emptyCounters();
  const dedupe = new Dedupe({ max: 1024 });
  // 安全升级：限流 / 重复内容 / 连发合并 / 事件门控。主号豁免，其他来源按配置限速。
  const guard = createGuard({
    config: cfg,
    log: (message) => log(`[guard] ${message}`),
  });
  const ridGate = new RidGate({ ttlMs: cfg.ridTtlMs });
  // 超时过的 rid 单独记一份：迟到的 turn/end 靠它认出来，避免被当成"外来回合"
  const timedOutGate = new RidGate({ ttlMs: cfg.ridTtlMs });
  const queue = [];
  const peers = new Set();
  const offline = [];
  const trackers = new Map();
  let busy = false;
  let currentRid = null;
  let currentMsg = null;
  let turnTimer = null;
  let ridSeq = 0;
  let echoSeq = 0;
  // 图片下载的 get_image 动作要等 NapCat 的响应：echo → { resolve, reject, timer }
  const actionWaiters = new Map();
  let openTurnKey = null;
  let lastUnsupportedNoticeAt = Number.NEGATIVE_INFINITY;
  let state = 'idle';
  // M7：拟人延迟的发送时刻记账（保证先算好的回复不会被后一条抢跑）
  const replyTimeline = createReplyTimeline();
  // 真机上宿主日志抓不到，prompt 失败的具体原因只留在这份快照里，经只读状态端点暴露。
  let lastPromptError = null;
  // M6：事件环形缓冲（qq_events / 状态端点读它），以及最近发出消息的记账（撤回用）
  const eventStore = new EventStore({ max: cfg.maxEventBuffer });
  const sentMessages = [];
  const MAX_SENT_TRACKED = 50;
  // M6.4：本回合「工具已经发过什么」的记账 —— qq_send 发一遍 + 助手文字自动回传又发一遍 = QQ 端双发
  const outboundSends = [];
  const MAX_OUTBOUND_TRACKED = 64;
  // M6：NapCat 账号缓存（连上时主动查一次）；心跳/生命周期只更新事件存储
  let account = null;
  let serverVersion = null;
  let toolNames = [];
  // M6.2：容器网络直连代理状态（index.js 启动代理后回填，状态端点可查）
  let containerProxyInfo = null;
  let lastHeartbeatLoggedOnline = null;
  // M5：私聊授权名单（主号始终允许；名单内的人也能回，反向往发）
  const allowList = createAllowList({ file: cfg.allowListPath || '', log });
  const isAllowedSender = (qq) => String(qq) === String(cfg.mainQQ) || allowList.has(qq);
  // M8：禁回（禁止回复）。主号 /mute、DSH 里的 qq_mute 工具、手改 JSON 三条路都能改；
  // 状态落盘 + fs.watchFile 轮询，改完 0.5 秒内生效，不用重启 DSH。
  const muteState = createMuteState({
    file: cfg.muteStatePath || '',
    defaultMinutes: cfg.muteDefaultMinutes,
    log,
  });
  muteState.load();
  muteState.watch();

  function bump(map, key) {
    map[key] = (map[key] ?? 0) + 1;
  }

  /** 把一条已经序列化好的帧发给所有在线 peer，返回实际发出去几条。 */
  function deliver(payload) {
    let sent = 0;
    for (const peer of peers) {
      if (peer.closed) continue;
      peer.send(payload);
      sent += 1;
    }
    return sent;
  }

  /**
   * 发一个 OneBot action。没有任何 peer 在线时进有界补发缓冲（M2）：NapCat 重连后自动补齐。
   * 注意：补发只影响"发不出去"这一种情况，不改变任何 L3 判定结果。
   */
  function sendAction(action, params) {
    echoSeq += 1;
    const echo = `qqgw-${echoSeq}`;
    const payload = JSON.stringify({ action, params, echo });
    counters.actionsSent += 1;
    const sent = deliver(payload);
    if (sent) return { echo, sent, payload, buffered: false };
    counters.sendFailures += 1;
    if (cfg.offlineBufferMax <= 0) {
      counters.offlineDropped += 1;
      log(`no peer connected -> dropped ${action} (offline buffer disabled)`);
      return { echo, sent: 0, payload, buffered: false };
    }
    while (offline.length >= cfg.offlineBufferMax) {
      offline.shift();
      counters.offlineDropped += 1;
    }
    offline.push(payload);
    counters.offlineBuffered += 1;
    log(`no peer connected -> buffered ${action} (depth=${offline.length})`);
    return { echo, sent: 0, payload, buffered: true };
  }

  /** 新连接上来时把缓冲里的回传补齐；发不出去就留着，顺序不变。 */
  function flushOffline() {
    let flushed = 0;
    while (offline.length) {
      if (!deliver(offline[0])) break;
      offline.shift();
      counters.offlineFlushed += 1;
      flushed += 1;
    }
    if (flushed) log(`flushed ${flushed} buffered action(s) to the new peer (depth=${offline.length})`);
    return flushed;
  }

  /** 一条消息的回复目标：私聊回发送者本人，群聊回群里。 */
  function replyTargetOf(msg) {
    if (!msg) return { kind: 'private', userId: cfg.mainQQ };
    if (msg.source === 'group' && (msg.rawGroupId ?? msg.groupId)) {
      return { kind: 'group', groupId: msg.rawGroupId ?? msg.groupId };
    }
    return { kind: 'private', userId: msg.rawUserId ?? msg.userId ?? cfg.mainQQ };
  }

  /**
   * M6.4：记账「工具往哪个对话发过带文字的消息」。
   * 只记带文字段的消息：纯图片/文件不算（发张图之后助手再补一句解释，不该被当成重复吞掉）。
   */
  function recordToolSend({ source, targetId, parts, rid }) {
    const text = (Array.isArray(parts) ? parts : [])
      .filter((part) => part && part.type === 'text')
      .map((part) => String(part.text ?? ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return;
    outboundSends.push({ at: Date.now(), key: `${source}:${String(targetId)}`, text, rid: rid ?? null });
    while (outboundSends.length > MAX_OUTBOUND_TRACKED) outboundSends.shift();
  }

  /**
   * M6.4：本回合是不是已经用工具往同一个对话发过带文字的消息。
   * 是 → 自动回传助手文字就是双发，必须压掉（rid 精确到回合，不会误伤别的回合）。
   */
  function findToolSendThisTurn(target, rid) {
    if (cfg.relayDedupeMode === 'off' || !rid) return null;
    const targetId = target.kind === 'group' ? target.groupId : target.userId;
    const key = `${target.kind}:${String(targetId)}`;
    for (let i = outboundSends.length - 1; i >= 0; i -= 1) {
      const entry = outboundSends[i];
      if (entry.key === key && entry.rid === rid) return entry;
    }
    return null;
  }

  /**
   * M7：把一次"自动回传"按拟人延迟推后执行。返回实际等待毫秒数（0=立即执行）。
   * 只影响助手文字自动回传；qq_send / qq_notice 这类工具调用是明确指令，不延迟。
   */
  function withHumanDelay({ text, where, run }) {
    const delayMs = computeReplyDelayMs({ text, cfg });
    if (delayMs <= 0) {
      run();
      return 0;
    }
    const waitMs = Math.max(0, replyTimeline.reserve(delayMs) - Date.now());
    log(`reply delay ${waitMs}ms (拟人) -> ${where} (${String(text).length} chars)`);
    const timer = setTimeout(() => {
      // 网关已经被停掉了（DSH 退出/热重载）就别再发了
      if (state === 'stopped') return;
      run();
    }, waitMs);
    timer.unref?.();
    return waitMs;
  }

  /**
   * 按来源把回复发给对应的人/群（M5：绝不能一律发回主号）。
   * 群聊回复只发文字、不 @ 人，避免 @ 提醒刷屏和自激。
   * M6：改走 sendMessage（等响应拿 message_id，供 qq_recall 撤回），失败只记日志不抛。
   * M7：发送动作先进 withHumanDelay，拟人延迟后再真发。
   */
  function sendReply(msg, text) {
    const target = replyTargetOf(msg);
    const body = String(text);
    const parts = [{ type: 'text', text: body }];
    const where = target.kind === 'group' ? `group ${target.groupId}` : `QQ ${target.userId}`;
    withHumanDelay({
      text: body,
      where,
      run: () => {
        void sendMessage({
          source: target.kind,
          userId: target.userId,
          groupId: target.groupId,
          parts,
          via: 'relay',
        }).then(() => {
          log(`reply -> ${where} (${body.length} chars)`);
        }).catch((err) => {
          counters.sendFailures += 1;
          log(`reply -> ${where} failed: ${err?.message ?? String(err)}`);
        });
      },
    });
    return target;
  }

  /**
   * M6.1：把 Markdown 渲染成图片再发（QQ 聊天框不渲染 Markdown；NapCat 的 markdown 段
   * 在普通号上实测发送超时，所以走"截图成图片"这条稳路）。
   * 渲染失败要抛错，由调用方决定回退纯文本。
   */
  async function sendMarkdownMessage({ source, userId, groupId, markdown, caption, timeoutMs, via } = {}) {
    const text = String(markdown ?? '').trim();
    if (!text) throw new Error('Markdown 内容为空');
    const rendered = await renderMarkdown(text, {
      maxWidth: cfg.markdownImageMaxWidth,
    });
    if (!rendered || rendered.ok !== true) {
      counters.markdownRenderFailures += 1;
      throw new Error(`Markdown 渲染失败：${rendered?.error ?? '未知原因'}`);
    }
    counters.markdownRendered += 1;
    const parts = [];
    if (caption) parts.push({ type: 'text', text: String(caption) });
    parts.push({ type: 'image', path: rendered.path });
    const result = await sendMessage({ source, userId, groupId, parts, timeoutMs, via, internal: true });
    log(`markdown rendered (${rendered.width}x${rendered.height}, ${rendered.bytes ?? '?'}B, ${rendered.ms ?? '?'}ms) -> ${source}`);
    return {
      ...result,
      markdown_image: {
        path: rendered.path,
        width: rendered.width,
        height: rendered.height,
        bytes: rendered.bytes ?? null,
        ms: rendered.ms ?? null,
      },
    };
  }

  /**
   * M6.1：助手文字回传。按 markdownReplyMode 决定发纯文本还是渲染成图片：
   * - off：永远纯文本；
   * - auto：文字够长且像 Markdown（标题/表格/代码块/多列表项…）才渲染；
   * - image：总是渲染。
   * 渲染失败自动回退纯文本，绝不把这条回复吞掉。
   */
  function relayAssistantText(msg, text, rid) {
    const target = replyTargetOf(msg);
    // M6.4：本回合已经用 qq_send 往同一个对话发过带文字的消息 → 自动回传就是 QQ 端双发，压掉
    const prior = findToolSendThisTurn(target, rid);
    if (prior) {
      counters.duplicateRepliesSuppressed += 1;
      const where = target.kind === 'group' ? `group ${target.groupId}` : `QQ ${target.userId}`;
      log(`assistant text not relayed: this turn already sent a tool message to ${where} (${prior.text.length} chars) -> avoid double send`);
      return 'skipped-duplicate';
    }
    const mode = cfg.markdownReplyMode;
    const body = String(text);
    const shouldRender = mode === 'image' || (mode === 'auto' && body.length >= 80 && looksLikeMarkdown(body));
    if (!shouldRender) {
      sendReply(msg, body);
      return 'text';
    }
    // M7：图片回复同样按拟人延迟发（渲染失败回退纯文本时会再走一次延迟，不影响正确性）
    withHumanDelay({
      text: body,
      where: target.kind === 'group' ? `group ${target.groupId}` : `QQ ${target.userId}`,
      run: () => {
        void sendMarkdownMessage({
          source: target.kind,
          userId: target.userId,
          groupId: target.groupId,
          markdown: body,
          via: 'relay',
        }).catch((err) => {
          counters.markdownFallbacks += 1;
          log(`markdown reply render failed -> fallback to text: ${err?.message ?? String(err)}`);
          sendReply(msg, body);
        });
      },
    });
    return 'markdown-image';
  }

  /**
   * 发一个需要等响应的 OneBot action（目前只有图片下载的 get_image 用）。
   * 响应按 echo 认领：谁先回用谁，迟到的响应当普通噪声丢掉（不影响 L3 判定）。
   */
  function requestAction(action, params, timeoutMs = imageTimeoutMs) {
    echoSeq += 1;
    const echo = `qqgw-req-${echoSeq}`;
    return new Promise((resolve, reject) => {
      // 多 peer 时（例如换 token 后旧连接还没断）只问最新连上来的那个：
      // NapCat 真机只有一个，旧的可能是僵尸连接，把响应发错人就永远等不到。
      const candidates = [...peers].filter((p) => !p.closed);
      const peer = candidates[candidates.length - 1];
      if (!peer) {
        reject(new Error(`no peer connected for action ${action}`));
        return;
      }
      const timer = setTimeout(() => {
        actionWaiters.delete(echo);
        reject(new Error(`action ${action} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      actionWaiters.set(echo, {
        resolve: (value) => {
          clearTimeout(timer);
          actionWaiters.delete(echo);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          actionWaiters.delete(echo);
          reject(err);
        },
      });
      counters.actionsSent += 1;
      // 只发给第一个在线 peer：NapCat 只有一个，没必要广播把响应弄乱
      try {
        peer.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        const waiter = actionWaiters.get(echo);
        actionWaiters.delete(echo);
        clearTimeout(timer);
        counters.sendFailures += 1;
        waiter?.reject?.(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** QQ 号/群号：纯数字转 Number（安全整数内），否则原样交给 NapCat 报错。 */
  function toQqNumber(value) {
    const text = String(value ?? '').trim();
    if (!/^\d+$/.test(text)) return value;
    const num = Number(text);
    return Number.isSafeInteger(num) ? num : text;
  }

  /** 从发消息的 action 响应里取 message_id（统一成字符串，兼容 number/string）。 */
  function extractMessageId(data) {
    if (!data || typeof data !== 'object') return null;
    const id = data.message_id ?? data.messageId ?? null;
    if (id === null || id === undefined || id === '') return null;
    return String(id);
  }

  /** 一条待发消息的简述（状态端点 / 撤回日志用，避免把整段 base64 存下来）。 */
  function previewOf(parts) {
    const list = Array.isArray(parts) ? parts : [];
    const text = list.filter((part) => part && part.type === 'text').map((part) => String(part.text ?? '')).join(' ').trim();
    if (text) return text.length > 80 ? `${text.slice(0, 80)}…` : text;
    const kinds = list.map((part) => part?.type).filter(Boolean);
    return kinds.length ? `[${kinds.join('+')}]` : '';
  }

  /** 最近发出消息的有界记账（撤回时按 message_id 找）。 */
  function recordSentMessage(record) {
    if (!record?.messageId) return record;
    sentMessages.push(record);
    while (sentMessages.length > MAX_SENT_TRACKED) sentMessages.shift();
    return record;
  }

  /**
   * M6 出站能力：发一条消息（富媒体由 actions.buildSegments 拼段），等 NapCat 响应拿 message_id。
   * 没有 peer 时退回离线缓冲（消息不丢，但拿不到 message_id，撤回会失败）。
   */
  async function sendMessage({ source, userId, groupId, parts, timeoutMs, via, internal = false } = {}) {
    // 安全升级：出站本机文件按「谁触发了这一轮」分级（main / outbox / all），见 config.fileSendPolicy。
    // internal=true 是网关自己的受信渲染产物（如 Markdown 截图），不受限制。
    const built = buildSegments(parts, {
      maxImageBytes: cfg.maxSendImageBytes,
      policy: {
        mode: cfg.fileSendPolicy,
        outboxDir: cfg.outboxDir,
        isMain: isMainUser(currentMsg?.userId),
        internal: internal === true,
      },
    });
    if (!built.ok) throw new Error(`消息段构造失败：${built.error}`);
    if (!built.segments.length) throw new Error('消息段为空');
    const kind = source === 'group' ? 'group' : 'private';
    const targetId = kind === 'group' ? String(groupId ?? '').trim() : String(userId ?? '').trim();
    if (!targetId) throw new Error(kind === 'group' ? '缺少 group_id' : '缺少 user_id');
    const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
    // 单段纯文本沿用字符串形态（兼容 M1-M5 的断言和 NapCat 习惯），富媒体才用消息段数组
    const singleText = built.segments.length === 1 && built.segments[0].type === 'text';
    const message = singleText ? String(built.segments[0].data.text) : built.segments;
    const params = kind === 'group'
      ? { group_id: toQqNumber(targetId), message }
      : { user_id: toQqNumber(targetId), message };
    let response = null;
    if (peers.size === 0) {
      // 断线：进离线补发缓冲，不阻塞工具调用
      sendAction(action, params);
      log(`sendMessage: no peer -> buffered ${action}`);
    } else {
      response = await requestAction(action, params, timeoutMs ?? cfg.sendTimeoutMs);
    }
    if (response) counters.outboundMessages += 1;
    const record = {
      messageId: response ? extractMessageId(response.data) : null,
      at: Date.now(),
      source: kind,
      groupId: kind === 'group' ? targetId : null,
      userId: kind === 'private' ? targetId : null,
      preview: previewOf(parts),
      recalled: false,
    };
    if (record.messageId) recordSentMessage(record);
    // M6.4：工具发的消息记账（relay/system 不记），回合收尾时据此决定还要不要自动回传助手文字
    if ((via ?? 'tool') === 'tool') recordToolSend({ source: kind, targetId, parts, rid: currentRid });
    return {
      ok: true,
      action,
      source: kind,
      groupId: record.groupId,
      userId: record.userId,
      messageId: record.messageId,
      segments: built.segments,
    };
  }

  /** M6：撤回。不传 id 时撤回最近一条拿到 message_id 的网关消息。 */
  async function recall({ messageId } = {}) {
    let id = messageId;
    if (id === undefined || id === null || id === '') {
      const last = [...sentMessages].reverse().find((m) => m.messageId && !m.recalled);
      if (!last) throw new Error('没有可撤回的消息：网关还没发出过带 message_id 的消息（或已全部撤回）');
      id = last.messageId;
    }
    const norm = normalizeAction('delete_msg', { message_id: id });
    if (!norm.ok) throw new Error(norm.error);
    try {
      const response = await requestAction('delete_msg', norm.params, cfg.sendTimeoutMs);
      counters.recalls += 1;
      for (const m of sentMessages) if (String(m.messageId) === String(id)) m.recalled = true;
      return { ok: true, messageId: String(id), response: response?.data ?? null };
    } catch (err) {
      counters.recallFailures += 1;
      throw err;
    }
  }

  /** M6：通用 OneBot 动作调用（目录/参数校验在 actions.js，权限闸门在这里）。 */
  async function callAction(name, params = {}, opts = {}) {
    const norm = normalizeAction(name, params);
    if (!norm.ok) throw new Error(norm.error);
    const risk = actionRisk(name) ?? 'write';
    if (cfg.managementEnabled === false && risk !== 'read') {
      throw new Error(`管理动作已禁用（managementEnabled=false）：${name}`);
    }
    counters.actionCalls += 1;
    try {
      const response = await requestAction(norm.action, norm.params, opts.timeoutMs ?? cfg.sendTimeoutMs);
      // 处理完加好友/加群申请后，把对应事件标记为已处理（qq_events 的 pending 会减少）
      if ((name === 'set_friend_add_request' || name === 'set_group_add_request') && norm.params.flag !== undefined) {
        eventStore.resolveRequest(norm.params.flag);
      }
      return { ok: true, action: norm.action, data: response?.data ?? null, retcode: response?.retcode ?? 0 };
    } catch (err) {
      counters.actionFailures += 1;
      throw err;
    }
  }

  /** M6：当前正在处理的 QQ 对话（工具省略目标时用）。 */
  function currentContext() {
    const msg = currentMsg;
    if (!msg) return { active: false, kind: null, source: null, groupId: null, userId: null, messageId: null };
    if (msg.kind === 'event') {
      const event = msg.event ?? {};
      const groupId = event.groupId ?? null;
      const userId = event.userId ?? null;
      return {
        active: true,
        kind: 'event',
        source: groupId ? 'group' : 'private',
        groupId,
        userId: groupId ? null : userId,
        messageId: event.messageId ?? null,
        eventType: event.type ?? null,
      };
    }
    return {
      active: true,
      kind: 'message',
      source: msg.source ?? null,
      groupId: msg.groupId ?? null,
      userId: msg.userId ?? null,
      messageId: msg.messageId ?? null,
    };
  }

  /** 事件对模型可见时的精简形态（去掉 raw 原始帧，避免把整帧塞进上下文）。 */
  function compactEvent(event) {
    return {
      seq: event.seq,
      at: event.at,
      kind: event.kind,
      type: event.type,
      subType: event.subType ?? null,
      groupId: event.groupId ?? null,
      userId: event.userId ?? null,
      operatorId: event.operatorId ?? null,
      targetId: event.targetId ?? null,
      messageId: event.messageId ?? null,
      flag: event.flag ?? null,
      comment: event.comment ?? null,
      duration: event.duration ?? null,
      file: event.file ?? null,
      status: event.status ?? null,
      interval: event.interval ?? null,
      description: describeEvent(event),
    };
  }

  /** M6：给 qq_events 工具用的查询接口。 */
  function listEvents({ kind, sinceSeq, limit, pendingOnly } = {}) {
    const maxLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    let events;
    if (pendingOnly) {
      events = eventStore.requests();
      if (kind) events = events.filter((event) => event.kind === kind);
      events = events.slice(-maxLimit);
    } else {
      events = eventStore.list({ kind, sinceSeq, limit: maxLimit });
    }
    const snapshot = eventStore.snapshot();
    return {
      total: eventStore.size,
      events: events.map(compactEvent),
      pending_requests: pendingOnly ? [] : snapshot.pendingRequests.map(compactEvent),
      heartbeat: snapshot.heartbeat,
      lifecycle: snapshot.lifecycle,
      counters: snapshot.counters,
    };
  }

  /** 事件投给模型时的正文（明确告诉模型：直接输出文字不会发到 QQ）。 */
  function buildEventPrompt(event) {
    const lines = [
      `【QQ 事件通知】${describeEvent(event)}`,
      `事件类型：${event.type}${event.subType ? `（${event.subType}）` : ''}`,
    ];
    if (event.groupId) lines.push(`群号：${event.groupId}`);
    if (event.userId) lines.push(`相关 QQ：${event.userId}`);
    if (event.messageId) lines.push(`消息 id：${event.messageId}`);
    if (event.kind === 'request') {
      lines.push(`申请 flag：${event.flag ?? '(缺失)'}；处理方式：qq_action → set_friend_add_request / set_group_add_request`);
    }
    lines.push('说明：这是 QQ 侧事件，不是用户提问。需要发消息/操作请调用 qq_send、qq_recall、qq_action；本回合直接输出的文字不会发到 QQ。');
    return lines.join('\n');
  }

  /** 事件要不要投给模型：按 eventPromptTypes 过滤；自己触发的撤回不再叫模型一轮。 */
  function shouldPromptEvent(event) {
    if (event.kind === 'notice' && (event.type === 'notice.group_recall' || event.type === 'notice.friend_recall')) {
      const actor = String(event.operatorId ?? event.userId ?? '');
      if (actor && actor === String(cfg.botQQ)) return false;
    }
    return true;
  }

  function enqueueEventPrompt(event) {
    if (!cfg.eventPromptTypes) return false;
    // 安全升级：好友/加群申请的附言是外部可控文本，默认不投给模型（要自动处理申请再显式打开）
    if (event.kind === 'request' && !cfg.eventPromptRequests) return false;
    const key = eventKey(event);
    if (!matchesEventFilter(key, cfg.eventPromptTypes)) return false;
    if (!shouldPromptEvent(event)) return false;
    if (queue.length >= cfg.maxQueue) {
      counters.overflowDropped += 1;
      log(`event ${key} prompt dropped: queue full (${queue.length})`);
      return false;
    }
    counters.eventPrompts += 1;
    queue.push({ kind: 'event', event });
    pump();
    return true;
  }

  /** M6：一帧非 message 帧（notice/request/meta_event/message_sent）的统一入口。 */
  function handleEvent(event) {
    const stored = eventStore.push(event);
    if (event.kind === 'notice') counters.notices += 1;
    else if (event.kind === 'request') counters.requests += 1;
    else if (event.kind === 'meta_event') counters.metaEvents += 1;
    else if (event.kind === 'message_sent') counters.messageSentEvents += 1;
    if (event.kind === 'meta_event' && event.type === 'meta_event.heartbeat') {
      // 心跳每 30s 一帧，只在在线状态变化时记日志，避免刷日志
      const online = Boolean(event.status?.online);
      if (lastHeartbeatLoggedOnline !== online) {
        lastHeartbeatLoggedOnline = online;
        log(`heartbeat: online=${online} good=${event.status?.good} interval=${event.interval ?? '?'}ms`);
      }
      return stored;
    }
    log(`event ${event.type}${event.groupId ? ` group=${event.groupId}` : ''}${event.userId ? ` user=${event.userId}` : ''}`);
    // 元事件/自己发的消息只记录，不投给模型（否则每个心跳都要烧一轮）
    if (event.kind === 'meta_event' || event.kind === 'message_sent') return stored;
    enqueueEventPrompt(stored);
    return stored;
  }

  function heartbeatInfo() {
    const heartbeat = eventStore.heartbeat();
    if (!heartbeat) return null;
    const ageMs = eventStore.heartbeatAgeMs();
    return {
      at: heartbeat.at ?? null,
      interval: heartbeat.interval ?? null,
      online: heartbeat.status?.online ?? null,
      good: heartbeat.status?.good ?? null,
      ageMs,
      stale: cfg.heartbeatTimeoutMs > 0 && (ageMs ?? Number.POSITIVE_INFINITY) > cfg.heartbeatTimeoutMs,
    };
  }

  function lifecycleInfo() {
    const lifecycle = eventStore.lifecycle();
    if (!lifecycle) return null;
    return { at: lifecycle.at ?? null, subType: lifecycle.subType ?? null };
  }

  /** 连上 NapCat 后主动查一次账号/版本（状态端点、qq_status 用；失败只记日志）。 */
  async function refreshAccount() {
    try {
      const loginRes = await requestAction('get_login_info', {}, cfg.sendTimeoutMs);
      const userId = String(loginRes?.data?.user_id ?? '');
      if (userId) {
        account = { userId, nickname: String(loginRes?.data?.nickname ?? '') };
        log(`login info: QQ ${account.userId}${account.nickname ? ` (${account.nickname})` : ''}`);
      }
    } catch (err) {
      log(`get_login_info 失败：${err?.message ?? String(err)}`);
    }
    try {
      const versionRes = await requestAction('get_version_info', {}, cfg.sendTimeoutMs);
      serverVersion = versionRes?.data ?? null;
      if (serverVersion) {
        log(`OneBot 版本：${serverVersion.app_name ?? '?'} ${serverVersion.app_version ?? serverVersion.version ?? ''}`.trim());
      }
    } catch (err) {
      log(`get_version_info 失败：${err?.message ?? String(err)}`);
    }
  }

  /** 收到动作响应：认领 echo；没人在等的响应直接忽略。 */
  function resolveActionResponse(raw) {
    const echo = raw?.echo;
    if (typeof echo !== 'string' || !echo) return false;
    const waiter = actionWaiters.get(echo);
    if (!waiter) return false;
    if (raw.status === 'failed' || (typeof raw.retcode === 'number' && raw.retcode !== 0)) {
      waiter.reject(new Error(`action failed: ${String(raw.message ?? raw.wording ?? raw.retcode)}`));
    } else {
      waiter.resolve(raw);
    }
    return true;
  }

  /** 媒体回执：同 message_id 不重复回，节流窗口内也不重复回。 */
  function notifyUnsupported(parsed) {
    if (!cfg.unsupportedReply) return { sent: false, reason: 'disabled' };
    if (parsed.messageId && dedupe.seen(parsed.messageId)) {
      counters.dedupeHits += 1;
      return { sent: false, reason: 'duplicate' };
    }
    const nowMs = mediaClock();
    if (nowMs - lastUnsupportedNoticeAt < cfg.unsupportedNoticeIntervalMs) {
      counters.unsupportedNoticeSuppressed += 1;
      log(`unsupported media frame (${parsed.media.join('+')}) -> notice suppressed by throttle`);
      return { sent: false, reason: 'throttled' };
    }
    lastUnsupportedNoticeAt = nowMs;
    sendReply(parsed, cfg.unsupportedReply);
    counters.unsupportedNotified += 1;
    log(`unsupported media frame (${parsed.media.join('+')}) -> replied "${cfg.unsupportedReply}"`);
    return { sent: true, reason: 'notified' };
  }

  function releaseTurn(reason) {
    if (turnTimer) {
      clearTimeout(turnTimer);
      turnTimer = null;
    }
    if (currentRid) {
      // 收尾时把还挂在这个 rid 上的 tracker 清掉，防止 turn/end 永远不来时 Map 无限长。
      // 超时例外：tracker 留着，迟到的 turn/end 才有东西可对账（M2）。
      for (const [key, tracker] of trackers) {
        if (!tracker.rids.has(currentRid)) continue;
        if (reason === 'timeout') tracker.timedOutAt = Date.now();
        else trackers.delete(key);
      }
    }
    busy = false;
    currentRid = null;
    currentMsg = null;
    log(`turn released (${reason})`);
    pump();
  }

  /** 超时留下的 tracker 有保质期，顺带给 Map 兜个上限。 */
  function sweepTrackers() {
    const nowMs = Date.now();
    for (const [key, tracker] of trackers) {
      if (tracker.timedOutAt && nowMs - tracker.timedOutAt > cfg.ridTtlMs) trackers.delete(key);
    }
    while (trackers.size > MAX_TRACKERS) trackers.delete(trackers.keys().next().value);
  }

  function settleTurn(tracker, reason) {
    counters.turnsSettled += 1;
    // 超时过的 rid 迟到回来：认出来，仍然零回传（这一回合已经记过 timeout）
    const lateRid = [...tracker.rids].find((rid) => timedOutGate.has(rid)) ?? tracker.timedOutRid ?? null;
    if (lateRid) {
      timedOutGate.consume(lateRid);
      counters.skippedTimeoutLate += 1;
      log(`late turn/end for timed-out rid ${lateRid} -> not relayed`);
      if (currentRid && tracker.rids.has(currentRid)) releaseTurn('late-timeout');
      return { verdict: 'timeout-late', ownRid: null, relayed: false };
    }
    const { verdict, ownRid } = tracker.verdict(ridGate);
    const isOurTurn = Boolean(currentRid && tracker.rids.has(currentRid));
    let relayed = false;
    if (verdict === TURN_VERDICT.OWN) {
      counters.ownTurns += 1;
      ridGate.consume(ownRid);
      if (reason?.kind !== 'completed') {
        counters.skippedAborted += 1;
        log(`own turn ${tracker.turn} ended ${String(reason?.kind)} -> not relayed`);
      } else if (!tracker.text) {
        counters.skippedEmpty += 1;
        log(`own turn ${tracker.turn} produced no assistant text -> not relayed`);
      } else if (currentMsg && currentMsg.kind === 'event') {
        // M6：事件通知回合的助手文字不回传 QQ（否则模型看到"已撤回"之类会往群里发一句话）
        counters.skippedEventReply += 1;
        log(`own turn ${tracker.turn} (event ${currentMsg.event?.type ?? '?'}) -> assistant text not relayed`);
      } else {
        // M5：回给这条消息的发送者（私聊本人 / 群聊原群），不是一律回主号
        // M6.1：Markdown 回复按配置渲染成图片（失败自动回退纯文本）
        // M6.4：本回合工具已经发过带文字的消息 → 不再自动回传（否则 QQ 端双发）
        const target = replyTargetOf(currentMsg);
        const mode = relayAssistantText(currentMsg, tracker.text, currentRid);
        const where = target.kind === 'group' ? `group ${target.groupId}` : `QQ ${target.userId}`;
        if (mode === 'skipped-duplicate') {
          log(`turn ${tracker.turn} assistant text NOT relayed to ${where}: tool message already sent this turn (${tracker.text.length} chars)`);
        } else {
          counters.relayed += 1;
          relayed = true;
          log(`relayed turn ${tracker.turn} (${tracker.text.length} chars, ${mode}) to ${where}`);
        }
      }
    } else if (verdict === TURN_VERDICT.FOREIGN) {
      counters.skippedForeign += 1;
      log(`turn ${tracker.turn} skipped: no in-flight rpcId (injected user/message=${tracker.injectedUserMessages})`);
    } else {
      counters.skippedAmbiguous += 1;
      log(`turn ${tracker.turn} skipped: multiple in-flight rpcIds`);
    }
    if (isOurTurn) releaseTurn(relayed ? 'relayed' : 'settled-without-relay');
    return { verdict, ownRid, relayed };
  }

  function onSessionEvent(session, event) {
    if (!session || String(session.id) !== String(cfg.sessionId)) {
      counters.foreignSessionEvents += 1;
      return;
    }
    const type = event?.type;
    const data = event?.data ?? {};
    if (type === 'turn/start') {
      sweepTrackers();
      const key = data.turn ?? 'current';
      trackers.set(key, new TurnTracker(data.turn ?? null));
      openTurnKey = key;
      return;
    }
    // 注意：user/message 的 data 是 UserMessage 本身，**没有 turn 字段**（M0/M1 实测），
    // 所以只能挂到最近一次 turn/start 开的那个 tracker 上；assistant/message、turn/end 才有 turn。
    if (type === 'user/message') {
      const key = openTurnKey ?? data.turn ?? 'current';
      let tracker = trackers.get(key);
      if (!tracker) {
        tracker = new TurnTracker(data.turn ?? null);
        trackers.set(key, tracker);
      }
      const source = data.source;
      const rid = source && typeof source.rpcId === 'string' ? source.rpcId : '';
      if (!rid) counters.injectedUserMessages += 1;
      tracker.noteUserSource(source);
      if (rid && timedOutGate.has(rid)) tracker.timedOutRid = rid;
      return;
    }
    if (type === 'assistant/message') {
      const key = openTurnKey ?? data.turn ?? 'current';
      const tracker = trackers.get(key);
      if (tracker) tracker.noteAssistantText(assistantText(data.message));
      return;
    }
    if (type === 'turn/end') {
      const key = data.turn ?? openTurnKey ?? 'current';
      let tracker = trackers.get(key);
      // 字段对不上时以 rid 为准：谁带着我们在飞的 rid，谁就是这一轮。
      // 只在"这个 key 上没有 tracker、或那个 tracker 一条 rid 都没有"时兜底，
      // 否则会把别的回合的 tracker 抢过来结算（超时回合迟到时尤其危险）。
      if ((!tracker || tracker.rids.size === 0) && currentRid) {
        for (const [k, t] of trackers) {
          if (t.rids.has(currentRid)) {
            tracker = t;
            trackers.delete(k);
            break;
          }
        }
      }
      trackers.delete(key);
      if (!tracker) tracker = new TurnTracker(data.turn ?? null);
      tracker.ended = data.reason ?? null;
      settleTurn(tracker, data.reason);
    }
  }

  /**
   * 主号的管理指令（/allow /deny /list /help）：网关自己处理，不进 DSH 会话。
   * 返回 true = 已消费。只有主号私聊能触发（onFrame 里已限定）。
   */
  function handleAdminCommand(msg) {
    const cmd = parseAdminCommand(msg.text);
    if (!cmd) return false;
    counters.adminCommands += 1;
    // M8：/mute、/unmute（禁回）—— 解析和时间语义都在 mute.js，这里只转发并回执
    const muteReply = muteState.handleCommand(cmd);
    if (muteReply !== null) {
      sendReply(msg, muteReply);
      log(`admin: ${cmd.command}${cmd.arg ? ` ${cmd.arg}` : ''} -> ${muteReply.replace(/\n/g, ' / ')}`);
      return true;
    }
    if (cmd.command === 'allow') {
      const [qq = '', ...noteParts] = cmd.arg.split(/\s+/);
      const res = allowList.add(qq, noteParts.join(' '));
      if (!res.ok) {
        sendReply(msg, '用法：/allow 123456789（5-15 位 QQ 号，可加备注）');
      } else if (res.added) {
        sendReply(msg, `已授权 QQ ${qq} 可回私聊（名单 ${res.count} 人）`);
        log(`admin: allow ${qq} (added, ${res.count} total)`);
      } else {
        sendReply(msg, `QQ ${qq} 已在名单里（名单 ${res.count} 人）`);
      }
      return true;
    }
    if (cmd.command === 'deny') {
      const [qq = ''] = cmd.arg.split(/\s+/);
      if (String(qq) === String(cfg.mainQQ)) {
        sendReply(msg, '主号始终可回，不需要取消');
        return true;
      }
      const res = allowList.remove(qq);
      if (!res.ok) {
        sendReply(msg, '用法：/deny 123456789（5-15 位 QQ 号）');
      } else if (res.removed) {
        sendReply(msg, `已移除 QQ ${qq}（名单 ${res.count} 人）`);
        log(`admin: deny ${qq} (removed, ${res.count} total)`);
      } else {
        sendReply(msg, `QQ ${qq} 不在名单里（名单 ${res.count} 人）`);
      }
      return true;
    }
    if (cmd.command === 'list') {
      const list = allowList.list();
      const open = cfg.allowAllPrivate === true ? '当前私聊不限：全部好友都可回\n' : '';
      const text = open + (list.length === 0
        ? '授权名单为空（主号始终可回）'
        : `授权名单（${list.length} 人）：\n${list.map((entry, index) => `${index + 1}. ${entry.qq}${entry.note ? `（${entry.note}）` : ''}`).join('\n')}`);
      sendReply(msg, text);
      return true;
    }
    // help
    sendReply(msg, 'QQ 网关指令：\n/allow QQ号  授权某人私聊\n/deny QQ号   取消授权\n/list        查看名单\n/mute        禁回（默认 30 分钟，主号除外）\n/mute QQ号 10  只禁某个号 10 分钟\n/mute list   看当前禁回\n/unmute      全部解除\n主号始终可回；群聊只回 @ 小号的消息');
    return true;
  }

  function onFrame(peer, text) {
    counters.inboundFrames += 1;
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      bump(counters.dropped, 'not-json');
      return;
    }
    // M6：非 message 帧（notice/request/meta_event/message_sent）走事件管线，不再当噪声丢弃
    if (raw && typeof raw === 'object' && typeof raw.post_type === 'string' && raw.post_type !== 'message') {
      const parsedEvent = parseEventFrame(raw, { botQQ: cfg.botQQ });
      if (!parsedEvent.ok) {
        bump(counters.dropped, parsedEvent.reason);
        return;
      }
      const event = parsedEvent.event;
      // 安全升级：事件帧也必须过禁回和限流（之前这条路径绕过了全部门控）
      if (event.kind !== 'meta_event' && event.userId && muteState.isMuted(event.userId, cfg.mainQQ)) {
        counters.mutedSkipped = (counters.mutedSkipped ?? 0) + 1;
        return;
      }
      const eventGate = guard.checkEvent({ event, isMain: isMainUser(event.userId) });
      if (!eventGate.ok) {
        counters.eventDropped += 1;
        if (eventGate.reason === 'rate-limit') counters.rateLimited += 1;
        else counters.duplicates += 1;
        applyAutoMute(eventGate.autoMute, event.userId ?? event.groupId);
        log(`event dropped (${eventGate.reason}): ${event.type}`);
        return;
      }
      handleEvent(event);
      return;
    }
    const parsed = parseInbound(raw, cfg, { isAllowed: isAllowedSender });
    if (!parsed.ok) {
      // 带 echo 的动作响应先认领（图片下载在等它），再算一次丢弃计数
      if (parsed.reason === DROP.ACTION_RESPONSE) resolveActionResponse(raw);
      bump(counters.dropped, parsed.reason);
      if (parsed.reason === DROP.WRONG_USER) counters.skippedUnauthorized += 1;
      else if (parsed.reason === DROP.GROUP_NO_MENTION) counters.skippedNoMention += 1;
      else if (parsed.reason === DROP.SELF_MESSAGE) counters.skippedSelfMessage += 1;
      // 只有"对方确实发了东西、但发的是语音/表情这类真不支持的媒体"才回执；纯空白文本不回，免得刷屏。
      if (parsed.reason === DROP.EMPTY_TEXT && parsed.media?.length) notifyUnsupported(parsed);
      return;
    }
    if (dedupe.seen(parsed.msg.messageId)) {
      counters.dedupeHits += 1;
      return;
    }
    // 主号的 /allow /deny /list 由网关处理，不投给 DSH
    if (cfg.adminEnabled
      && parsed.msg.source === 'private'
      && String(parsed.msg.userId) === String(cfg.mainQQ)
      && handleAdminCommand(parsed.msg)) return;
    // M8：禁回 —— 被禁的人发的消息直接丢，不投给 DSH，也不占回合（主号永远不受影响）
    if (muteState.isMuted(parsed.msg.userId, cfg.mainQQ)) {
      counters.mutedSkipped = (counters.mutedSkipped ?? 0) + 1;
      log(`muted: drop inbound message from ${parsed.msg.userId}`);
      return;
    }
    // 安全升级：按来源限流 + 重复内容去重（主号豁免，见 guard.js）
    const gate = guard.checkMessage({
      userId: parsed.msg.userId,
      source: parsed.msg.source,
      text: parsed.msg.text,
      isMain: isMainUser(parsed.msg.userId),
    });
    if (!gate.ok) {
      if (gate.reason === 'rate-limit') counters.rateLimited += 1;
      else counters.duplicates += 1;
      applyAutoMute(gate.autoMute, parsed.msg.userId);
      log(`dropped inbound (${gate.reason}) from ${parsed.msg.userId}`);
      return;
    }
    counters.accepted += 1;
    enqueueIncoming(
      { ...parsed.msg, kind: 'message', at: Date.now(), mergedCount: 1 },
      isMainUser(parsed.msg.userId),
    );
    pump();
  }

  function isMainUser(userId) {
    return String(userId ?? '') !== '' && String(userId) === String(cfg.mainQQ);
  }

  /** 频控触发自动禁回（主号永远不在此列）。 */
  function applyAutoMute(info, qq) {
    if (!info) return;
    const id = String(qq ?? '').trim();
    if (!id || id === String(cfg.mainQQ)) return;
    counters.autoMuted += 1;
    try {
      muteState.setPeer(id, { minutes: info.minutes, reason: info.reason });
      log(`auto-mute QQ ${id} ${info.minutes} 分钟（${info.reason}）`);
    } catch (err) {
      log(`auto-mute failed: ${err?.message ?? String(err)}`);
    }
  }

  /**
   * 入队：主号插队；同来源窗口内的纯文字连发合并进上一条（只跑一个回合）；
   * 队列满时挤掉最旧的非主号消息，主号消息不丢。
   */
  function enqueueIncoming(msg, main) {
    const tail = queue[queue.length - 1];
    const tailPending = tail && tail !== currentMsg;
    if (cfg.burstMergeMs > 0 && tailPending && guard.canMerge(tail, msg)) {
      tail.text = `${tail.text}\n${msg.text}`;
      tail.mergedCount = (tail.mergedCount ?? 1) + 1;
      tail.at = msg.at;
      // 合并后图片/合并转发不丢：都挂到同一条消息上
      if (Array.isArray(msg.images) && msg.images.length) {
        tail.images = [...(Array.isArray(tail.images) ? tail.images : []), ...msg.images];
      }
      if (Array.isArray(msg.forwards) && msg.forwards.length) {
        tail.forwards = [...(Array.isArray(tail.forwards) ? tail.forwards : []), ...msg.forwards];
      }
      counters.mergedMessages += 1;
      log(`merged burst message from ${msg.userId} (${tail.mergedCount} 条) -> one turn`);
      return;
    }
    if (main) {
      // 主号消息插到队首「主号块」的末尾：既享受插队（越过外部用户的消息），
      // 又保持主号自己多条消息的先后顺序（全部 unshift 会把顺序倒过来）。
      let at = 0;
      while (at < queue.length && isMainUser(queue[at].userId)) at += 1;
      queue.splice(at, 0, msg);
      counters.priorityQueued += 1;
      if (queue.length > cfg.maxQueue) {
        // 满了：先挤掉最旧的非主号消息（外部用户不能挤占主号额度）；
        // 队列里全是主号时，丢最旧的一条（主号块头部），保持剩下的顺序不乱。
        let dropAt = -1;
        for (let i = at; i < queue.length; i += 1) {
          if (!isMainUser(queue[i].userId)) {
            dropAt = i;
            break;
          }
        }
        if (dropAt === -1) dropAt = 0;
        queue.splice(dropAt, 1);
        counters.overflowDropped += 1;
      }
      return;
    }
    if (queue.length >= cfg.maxQueue) {
      counters.overflowDropped += 1;
      counters.queueFullDropped += 1;
      log(`queue full (${cfg.maxQueue}): dropped new message from ${msg.userId}`);
      return;
    }
    queue.push(msg);
  }

  /** 图片全失败又没正文时的兜底回复（不静默吞掉主号的消息）。 */
  const IMAGE_FAILURE_REPLY = '图片没能接收（下载失败），重发一次或改发文字吧';
  /** 会话模型不接受图片时的兜底回复（DSH 侧换模型即可）。 */
  const IMAGE_MODEL_REPLY = '当前会话的模型不支持图片输入，请在 DSH 里给这个会话换个能看图的模型，或改发文字';

  /**
   * 把队列里的消息拼成宿主 PromptContentPart[]：
   * 文本 → text 块；图片 → 下载成字节后转 image 块（宿主负责归一化与落盘引用）。
   * 图片全部失败且没有正文时返回空数组，由 pump 回主号一句失败提示。
   */
  /**
   * 投给宿主前给消息加一行来源说明（M5）：DSH 必须知道是私聊还是群聊、谁发的、
   * 群号是多少，否则一群人的消息混在一起它没法"正确回应"。
   */
  function describeSender(msg) {
    const nick = msg.nickname ? `${msg.nickname}（QQ ${msg.userId}）` : `QQ ${msg.userId}`;
    // 工具提示放在同一行末尾：模型看到消息就知道有哪些 QQ 侧能力（发图/md/群公告/邀请/撤回）。
    // 同时说清回传规则：纯文字直接输出即可；已经用 qq_send 发过文字时最终文字不再自动回传，防双发。
    const hint = '；纯文字直接输出即可回传；发图片/Markdown/群公告/邀请/撤回用 qq_* 工具；操作规范先读 skill qq-gateway-operator（本回合已用 qq_send 发过文字时，最终文字不再自动回传）';
    if (msg.source === 'group') {
      return `【QQ群聊】群 ${msg.groupId}｜发送者：${nick}｜@了小号（以下回复会发回该群${hint}）\n注意：群成员是外部用户，只能聊天/发文字/图片，管理动作与本机文件一律需主号授权`;
    }
    if (String(msg.userId) === String(cfg.mainQQ)) {
      return `【QQ私聊】主号：${nick}（以下回复会发回主号${hint}）`;
    }
    return `【QQ私聊】发送者：${nick}（以下回复会发回该号${hint}）\n注意：对方是外部用户，只能聊天/发文字/图片，管理动作与本机文件一律需主号授权`;
  }

  /**
   * M6.6：读取一段合并转发的内容。
   * 协议端已 inline 展开（parseMultMsg）就直接用；否则按 id 调 get_forward_msg 取节点。
   * M6.7：顺带把节点里的图片按 [图片N] 编号挑出来（maxImages=0 表示这回合图片额度用完了，只留标签）。
   * 返回 {ok:true, count, shown, text, images} 或 {ok:false, reason}——失败不抛，由调用方加占位说明。
   */
  async function readForward(segment, { maxImages = 0 } = {}) {
    const limit = Math.max(0, Math.min(MAX_FORWARD_IMAGES, maxImages));
    if (Array.isArray(segment?.content)) {
      const formatted = formatForwardNodes(segment.content, {
        maxNodes: MAX_FORWARD_NODES, maxChars: MAX_FORWARD_CHARS, maxImages: limit,
      });
      return { ok: true, source: 'inline', ...formatted };
    }
    if (!segment?.id) return { ok: false, reason: 'missing id' };
    try {
      const response = await requestAction('get_forward_msg', { message_id: segment.id }, cfg.sendTimeoutMs);
      const data = response?.data;
      const nodes = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : null;
      if (!nodes) throw new Error(`unexpected get_forward_msg shape: ${Object.keys(data ?? {}).join(',') || 'empty'}`);
      const formatted = formatForwardNodes(nodes, {
        maxNodes: MAX_FORWARD_NODES, maxChars: MAX_FORWARD_CHARS, maxImages: limit,
      });
      return { ok: true, source: 'get_forward_msg', ...formatted };
    } catch (err) {
      return { ok: false, reason: err?.message ?? String(err) };
    }
  }

  async function buildPromptContent(msg) {
    // M6：事件通知不是用户消息——正文由 buildEventPrompt 生成，本回合助手文字不回传 QQ
    if (msg && msg.kind === 'event') {
      return [{ type: 'text', text: buildEventPrompt(msg.event) }];
    }
    const content = [];
    let usable = 0;
    let headerAdded = false;
    let imageParts = 0;
    const header = describeSender(msg);
    if (msg.text) {
      // 连发合并标记：让模型知道这是一串消息，一次回复即可，不用逐条回
      const merged = Number(msg.mergedCount) > 1 ? `[对方在短时间内连发 ${msg.mergedCount} 条，已合并]\n` : '';
      content.push({ type: 'text', text: `${header}\n\n${merged}${msg.text}` });
      usable += 1;
      headerAdded = true;
    }
    const images = Array.isArray(msg.images) ? msg.images : [];
    for (const segment of images) {
      try {
        const image = await resolveImage(segment, {
          fetchImpl,
          requestAction,
          timeoutMs: imageTimeoutMs,
          log: (message) => log(`image: ${message}`),
        });
        if (!headerAdded) {
          content.push({ type: 'text', text: header });
          headerAdded = true;
        }
        content.push({ type: 'image', mediaType: image.mediaType, data: image.data, name: image.name });
        usable += 1;
        imageParts += 1;
        counters.imageParts += 1;
        log(`image resolved (${image.source}, ${image.bytes}B, ${image.mediaType})`);
      } catch (err) {
        counters.imageFailures += 1;
        log(`image resolve failed: ${err?.message ?? String(err)}; file=${String(segment.file).slice(0, 80)} url=${String(segment.url).slice(0, 80)}`);
      }
    }
    // M6.6：合并转发 —— 取回节点内容，作为额外文字块投给模型
    // M6.7：节点里的图片真下载下来投图，正文里用 [图片N] 编号对应
    const forwards = Array.isArray(msg.forwards) ? msg.forwards.slice(0, MAX_FORWARD_SEGMENTS) : [];
    for (const segment of forwards) {
      const slots = Math.max(0, MAX_PROMPT_IMAGES - imageParts);
      const result = await readForward(segment, { maxImages: slots });
      if (!headerAdded) {
        content.push({ type: 'text', text: header });
        headerAdded = true;
      }
      if (result.ok) {
        counters.forwardRead += 1;
        content.push({ type: 'text', text: `[合并转发] 共 ${result.count} 条\n${result.text}` });
        usable += 1;
        log(`forward resolved (${result.source}, id=${segment.id || 'inline'}, nodes=${result.count}, shown=${result.shown}, chars=${result.text.length}, images=${result.images.length})`);
        if (result.images.length) {
          const mapping = result.images
            .map((img) => `${img.label}=第${img.nodeIndex}条${img.who ? `（${img.who}）` : ''}`)
            .join('；');
          content.push({ type: 'text', text: `[合并转发里的图片] ${mapping}` });
          for (const img of result.images) {
            try {
              const image = await resolveImage(img, {
                fetchImpl,
                requestAction,
                timeoutMs: imageTimeoutMs,
                log: (message) => log(`forward image ${img.label}: ${message}`),
              });
              content.push({ type: 'image', mediaType: image.mediaType, data: image.data, name: image.name });
              usable += 1;
              imageParts += 1;
              counters.forwardImages += 1;
              log(`forward image resolved (${img.label}, node=${img.nodeIndex}, ${image.source}, ${image.bytes}B, ${image.mediaType})`);
            } catch (err) {
              counters.forwardImageFailures += 1;
              content.push({ type: 'text', text: `[${img.label} 下载失败：${String(err?.message ?? err).slice(0, 120)}]` });
              log(`forward image resolve failed (${img.label}, node=${img.nodeIndex}, file=${String(img.file).slice(0, 60)}): ${err?.message ?? String(err)}`);
            }
          }
        }
      } else {
        counters.forwardFailures += 1;
        content.push({ type: 'text', text: `[合并转发消息，内容读取失败：${String(result.reason).slice(0, 120)}]` });
        usable += 1;
        log(`forward resolve failed (id=${segment.id || 'inline'}): ${result.reason}`);
      }
    }
    // 来源说明本身不算可投递内容：正文/图片全失败时必须回执，不能只投一行说明
    return usable > 0 ? content : [];
  }

  async function pump() {
    if (busy) return;
    const msg = queue.shift();
    if (!msg) return;
    // M8：排队期间被禁回 → 直接丢，不再起回合（防止"设完还回一条"）
    if (muteState.isMuted(msg.userId, cfg.mainQQ)) {
      counters.mutedSkipped = (counters.mutedSkipped ?? 0) + 1;
      log(`muted: drop queued message from ${msg.userId}`);
      queueMicrotask(() => pump());
      return;
    }
    if (!ctx?.sessionController?.prompt) {
      counters.promptErrors += 1;
      log('sessionController.prompt unavailable');
      return;
    }
    busy = true;
    currentMsg = msg;
    ridSeq += 1;
    const rid = `qqgw-${Date.now().toString(36)}-${ridSeq.toString(36)}`;
    ridGate.issue(rid);
    currentRid = rid;
    const abort = new AbortController();
    const content = await buildPromptContent(msg);
    if (content.length === 0) {
      // 只有失败的图片、没有任何可投递内容：告诉主号，别静默（也不占回合、不推假回复）
      log(`message ${String(msg.messageId)} had no usable content (images failed) -> replied failure notice`);
      sendReply(msg, IMAGE_FAILURE_REPLY);
      ridGate.consume(rid);
      busy = false;
      currentRid = null;
      currentMsg = null;
      queueMicrotask(() => pump());
      return;
    }
    const request = {
      requestId: rid,
      sessionId: cfg.sessionId,
      mode: cfg.deliveryMode,
      content,
    };
    counters.prompts += 1;
    try {
      const value = await ctx.sessionController.prompt(request, abort.signal);
      if (!value || value.accepted !== true) throw new Error(`prompt not accepted: ${JSON.stringify(value)}`);
      counters.promptsAccepted += 1;
      if (cfg.turnTimeoutMs > 0) {
        turnTimer = setTimeout(() => {
          counters.timeouts += 1;
          // 超时不推 QQ，但必须放开单飞闸门，否则队列永远卡住
          timedOutGate.issue(rid);
          ridGate.consume(rid);
          log(`timeout after ${cfg.turnTimeoutMs}ms waiting for turn/end of ${rid} -> not relayed`);
          releaseTurn('timeout');
        }, cfg.turnTimeoutMs);
        turnTimer.unref?.();
      }
    } catch (err) {
      counters.promptErrors += 1;
      lastPromptError = {
        at: new Date().toISOString(),
        message: err?.message ?? String(err),
        code: err?.code ?? null,
        // RemoteError 的附加信息（比如 reason）原样留着，别在诊断时丢线索
        data: err?.data ?? null,
      };
      ridGate.consume(rid);
      log(`prompt failed: ${err?.message ?? String(err)}`);
      // 图片被宿主的模型能力挡下（session/attachment-invalid + MODEL_DOES_NOT_SUPPORT_IMAGES）：
      // 必须回主号一句，否则主号会以为消息石沉大海
      if (content.some((part) => part.type === 'image') && err?.code === 'session/attachment-invalid') {
        sendReply(currentMsg || msg, IMAGE_MODEL_REPLY);
        log('prompt rejected: session model does not accept images -> notified sender');
      }
      if (turnTimer) {
        clearTimeout(turnTimer);
        turnTimer = null;
      }
      busy = false;
      currentRid = null;
      currentMsg = null;
      queueMicrotask(() => pump());
    }
  }

  let statusServer = null;
  let statusServerError = null;
  let startedAtMs = null;
  // M4.2：Docker 联动启动的最近一次结果（状态端点可查；null=还没跑过）
  let dockerReport = null;
  let dockerTask = null;
  // M5.2：首次连上 NapCat 的时间 + 登录看门狗（启动后久无连接就告警）
  let firstPeerAt = null;
  let loginWatchdog = null;

  const server = createWsServer({
    host: cfg.host,
    port: cfg.port,
    path: cfg.path,
    // getter：token 轮换立刻对新的握手生效
    token: () => cfg.token,
    // 安全升级：默认只认 Authorization 头、拒绝带 Origin 的握手、限制帧大小（防 OOM）
    allowQueryToken: cfg.allowQueryToken,
    allowOrigin: cfg.allowOrigin,
    maxFrameBytes: cfg.maxFrameBytes,
    maxMessageBytes: cfg.maxMessageBytes,
    onReject: (code, message) => {
      counters.rejectedConnections += 1;
      log(`handshake rejected: ${code} ${message}`);
    },
    onConnection: (peer, info) => {
      // 安全升级：OneBot 正常只有一条连接。多余连接直接掐掉，
      // 防「后连的 peer 接管所有出站动作、窃听回复」（token 泄露时尤其重要）。
      if (peers.size >= 1) {
        counters.extraPeers += 1;
        log('extra onebot peer rejected (single peer only)');
        try {
          peer.socket?.destroy?.();
        } catch {
          // 已经断开就算了
        }
        return;
      }
      peers.add(peer);
      counters.connections += 1;
      if (!firstPeerAt) firstPeerAt = new Date();
      log(`onebot peer connected from ${peer.socket.remoteAddress ?? '?'} path=${info.url.pathname}`);
      peer.on('text', (text) => onFrame(peer, text));
      peer.on('close', () => peers.delete(peer));
      peer.on('error', () => peers.delete(peer));
      flushOffline();
      // M6：连上后主动查一次账号/版本（失败只记日志）；心跳/生命周期由 NapCat 推
      void refreshAccount();
    },
  });

  /** 状态端点的实际地址（没起来就是 null，原因在 error 里）。 */
  function statusEndpoint() {
    const addr = statusServer?.address();
    const bound = addr && typeof addr === 'object' ? addr : null;
    return {
      enabled: Boolean(cfg.statusEnabled),
      host: cfg.statusHost,
      port: bound?.port ?? null,
      path: cfg.statusPath,
      url: bound ? `http://${cfg.statusHost}:${bound.port}${cfg.statusPath}` : null,
      error: statusServerError,
    };
  }

  function status() {
    const wsAddr = server.address();
    const wsBound = wsAddr && typeof wsAddr === 'object' ? wsAddr : null;
    return {
      state,
      startedAt: startedAtMs ? new Date(startedAtMs).toISOString() : null,
      uptimeMs: startedAtMs ? Date.now() - startedAtMs : null,
      listening: { host: cfg.host, port: wsBound?.port ?? cfg.port, path: cfg.path },
      statusEndpoint: statusEndpoint(),
      peers: peers.size,
      busy,
      queueDepth: queue.length,
      offlineBufferDepth: offline.length,
      inFlightRids: ridGate.size,
      timedOutRids: timedOutGate.size,
      openTurns: trackers.size,
      tokenConfigured: Boolean(cfg.token),
      counters,
      // 安全升级：频控 / 去重 / 合并 / 自动禁回的实时计数
      guard: guard.countersSnapshot(),
      // 最近一次 prompt 失败的原始原因（只读诊断用；null 表示没失败过）
      lastPromptError,
      // M4.2：Docker 联动启动结果；null=没开或还没跑完
      docker: dockerReport,
      // M6.2：容器网络直连代理（Docker Desktop 手动代理指向死地址时的兜底；index.js 回填，可为 getter）
      containerProxy: typeof containerProxyInfo === 'function' ? containerProxyInfo() : containerProxyInfo,
      // M5：私聊授权名单快照（主号始终可回，count 只算额外授权的人）
      authz: {
        file: allowList.file || null,
        count: allowList.count,
        lastError: allowList.lastError,
      },
      // M8：禁回状态快照（/mute 或 qq_mute 工具改的就是它；文件热加载）
      mute: muteState.snapshot(),
      // M5.2 + M6：小号登录/连接状态（peers=0 且 waitingSeconds 大 = 没登录，需要扫码；
      // heartbeat.stale=true = 连着但心跳停了，账号可能被踢/断网）
      login: {
        connected: peers.size > 0,
        firstPeerAt: firstPeerAt ? firstPeerAt.toISOString() : null,
        waitingSeconds: startedAtMs && peers.size === 0 ? Math.round((Date.now() - startedAtMs) / 1000) : 0,
        account,
        version: serverVersion,
        heartbeat: heartbeatInfo(),
        lifecycle: lifecycleInfo(),
      },
      // M6：事件快照（qq_events 工具与状态端点共用同一份数据）
      events: eventStore.snapshot(),
      // M6：工具注册情况（index.js 注册后回填）
      tools: { enabled: Boolean(cfg.toolsEnabled), names: [...toolNames] },
      // M6：最近发出的消息（撤回用；只记账拿到 message_id 的）
      sent: {
        tracked: sentMessages.length,
        last: sentMessages.length ? sentMessages[sentMessages.length - 1] : null,
      },
      // 状态里只报"token 配没配"，绝不回显原值
      config: publicConfig(cfg),
    };
  }

  async function start() {
    const missing = missingConfig(cfg);
    if (missing.length) throw new Error(`dsh-qq-gateway config missing: ${missing.join(', ')}`);
    if (!cfg.token) log('warning: config.token is empty, the reverse-WS endpoint accepts any client');
    if (!ctx || typeof ctx.on !== 'function') throw new Error('ctx.on is required');
    ctx.on('session/event', onSessionEvent);
    // patch 热重载时旧实例可能还没把 8792 放开，新实例一上来就 EADDRINUSE.
    // 实测（2026-10-17）：不重试的结局是新实例直接启动失败、旧实例已停 → 网关彻底没了。
    // 所以这里重试几次，给旧实例一点关闭时间；真被别的程序占着才抛错。
    const listenRetries = 10;
    let addr = null;
    for (let attempt = 1; attempt <= listenRetries; attempt += 1) {
      try {
        addr = await server.listen();
        break;
      } catch (err) {
        if (err?.code !== 'EADDRINUSE' || attempt === listenRetries) throw err;
        log(`ws listen EADDRINUSE on ${cfg.host}:${cfg.port} -> retry ${attempt}/${listenRetries} in 600ms（旧实例可能还在关）`);
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }
    state = 'listening';
    startedAtMs = Date.now();
    log(`listening ws://${cfg.host}:${addr.port}${cfg.path} target session=${cfg.sessionId}`);
    // M3：状态端点是旁路 —— 起不来只降级（消息链路照常），原因留在 statusEndpoint.error 里
    if (cfg.statusEnabled) {
      // 实测：patch 热重载时旧实例的状态端口可能还没放开，新实例一上来就 EADDRINUSE。
      // 重试几次通常就能接上；3 次都失败才真降级（消息链路不受影响）。
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        statusServer = createStatusServer({
          host: cfg.statusHost,
          port: cfg.statusPort,
          path: cfg.statusPath,
          // 非环回监听时由 index.js 强制要求 statusToken >=32 位
          token: cfg.statusToken,
          snapshot: status,
          log,
        });
        try {
          const statusAddr = await statusServer.listen();
          log(`status endpoint listening http://${cfg.statusHost}:${statusAddr.port}${cfg.statusPath} (read-only)`);
          break;
        } catch (err) {
          const failed = statusServer;
          statusServer = null;
          statusServerError = err?.message ?? String(err);
          try {
            await failed.close();
          } catch {
            // 没起来的服务端关不掉也无所谓
          }
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 700));
        }
      }
      if (!statusServer) {
        log(`warning: status endpoint failed on ${cfg.statusHost}:${cfg.statusPort} (${statusServerError}); QQ relay continues`);
      }
    }
    // M4.2：Docker 联动启动 —— 纯旁路，绝不阻塞 WS 监听（NapCat 连上来就能用）。
    // 打开 DSH 时 Docker Desktop / 容器没在跑，这里会自动拉起来，QQ 网关随后自动重连。
    if (cfg.autoStartDocker) {
      dockerTask = ensureDockerReady({
        container: cfg.dockerContainer,
        desktopPath: cfg.dockerDesktopPath,
        timeoutMs: cfg.dockerStartTimeoutMs,
        log,
        runner: deps.dockerRunner,
        sleep: deps.sleep,
        exists: deps.exists,
      }).then((report) => {
        dockerReport = report;
        log(`docker 联动启动：${report.result}（${Math.round(report.ms / 1000)}s）${report.detail ? ` — ${report.detail}` : ''}`);
      }).catch((err) => {
        dockerReport = { ok: false, result: 'error', detail: String(err?.message ?? err), ms: 0 };
        log(`docker 联动启动异常：${String(err?.message ?? err)}`);
      });
    }
    // M5.2：登录看门狗 —— 启动后 120s 还没有 NapCat 连进来 = 小号没登录上（多半要扫码），
    // 日志明确说出来；状态端点 login.waitingSeconds 也能看到等了多久。
    if (loginWatchdog) clearTimeout(loginWatchdog);
    loginWatchdog = setTimeout(() => {
      loginWatchdog = null;
      if (peers.size === 0) {
        log(`warning: 启动 ${Math.round(LOGIN_WATCHDOG_MS / 1000)}s 仍没有 NapCat 连接 —— 小号可能未登录，去 NapCat WebUI 扫码（打开 DSH 后正常应在 1 分钟内连上）`);
      }
    }, LOGIN_WATCHDOG_MS);
    loginWatchdog.unref?.();
    return status();
  }

  async function stop() {
    state = 'stopped';
    // M8：停掉禁回状态文件轮询（否则离线测试/热重载后事件循环不退出）
    muteState.close();
    if (loginWatchdog) {
      clearTimeout(loginWatchdog);
      loginWatchdog = null;
    }
    // M5.2：DSH 退出时联动关闭 Docker。用 detached 助手（父进程退出后仍会跑完），
    // 助手等几秒后查 DSH 进程 PID：还活着 = patch 热重载，跳过；PID 没了 = 真退出，停 Docker。
    if (cfg.stopDockerOnExit) {
      try {
        const wsAddr = server.address();
        const boundPort = wsAddr && typeof wsAddr === 'object' ? wsAddr.port : cfg.port;
        scheduleDockerShutdown({
          helperPath: SHUTDOWN_HELPER,
          container: cfg.dockerContainer,
          port: boundPort,
          parentPid: process.pid,
          graceMs: Number.isFinite(deps.shutdownGraceMs) ? deps.shutdownGraceMs : 8000,
          logPath: deps.shutdownLogPath,
          spawnImpl: deps.spawnImpl,
          execPath: deps.execPath,
        });
        log(`docker 联动关闭：已安排退出后停止容器 ${cfg.dockerContainer}（热重载会自动跳过）`);
      } catch (err) {
        log(`docker 联动关闭：安排失败（${String(err?.message ?? err)}）`);
      }
    }
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = null;
    for (const peer of peers) peer.close(1001);
    peers.clear();
    offline.length = 0;
    trackers.clear();
    queue.length = 0;
    // 先放状态端口再关 WS：热重载时新实例要抢同一个端口，谁慢谁 EADDRINUSE
    const closingStatus = statusServer;
    statusServer = null;
    if (closingStatus) {
      try {
        await closingStatus.close();
      } catch {
        // 已经关了就算了
      }
    }
    await server.close();
    startedAtMs = null;
  }

  /** 运行时轮换 token：握手现取，改完立刻生效（旧的 token 下一次握手就 401）。 */
  function setToken(next) {
    cfg.token = String(next ?? '');
    counters.tokenRotations += 1;
    log(cfg.token
      ? 'token rotated: new token active for the next handshake'
      : 'token cleared: endpoint accepts any client');
    return cfg.token;
  }

  return {
    config: cfg,
    counters,
    status,
    start,
    stop,
    setToken,
    port: () => {
      const addr = server.address();
      return addr && typeof addr === 'object' ? addr.port : null;
    },
    /** 状态端点实际端口（没起来返回 null）；M3 验收和 M4 自检用。 */
    statusPort: () => {
      const addr = statusServer?.address();
      return addr && typeof addr === 'object' ? addr.port : null;
    },
    offlineDepth: () => offline.length,
    /** 仅供离线测试使用：不用真 WS 也能直接喂帧。 */
    feedText: (text) => onFrame(null, text),
    // M6 能力接口（tools.js / 自检脚本用）
    sendMessage,
    sendMarkdownMessage,
    recall,
    callAction,
    listEvents,
    currentContext,
    eventStore,
    describeEvent,
    renderMarkdown,
    // M8：禁回接口（qq_mute 工具 / 自检脚本用；状态端点读的是同一份）
    mute: {
      state: muteState,
      isMuted: (qq) => muteState.isMuted(qq, cfg.mainQQ),
      setPeer: (qq, options) => muteState.setPeer(qq, options),
      setGlobal: (options) => muteState.setGlobal(options),
      clearPeer: (qq) => muteState.clearPeer(qq),
      clearAll: () => muteState.clearAll(),
      list: () => muteState.list(),
      describe: () => muteState.describe(),
    },
    /** 工具注册后由 index.js 回填，状态端点里能看到注册了哪些 qq_* 工具 */
    setToolNames: (names) => {
      toolNames = Array.isArray(names) ? names.map(String) : [];
      return toolNames;
    },
    /** M6.2：容器网络直连代理状态回填（index.js 启动代理后调用） */
    setContainerProxyInfo: (info) => {
      containerProxyInfo = info ?? null;
      return containerProxyInfo;
    },
  };
}
