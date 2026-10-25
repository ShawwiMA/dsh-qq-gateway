// M3：配置 Schema —— 单一事实来源（默认值、类型、取值范围、说明）都在这里。
//
// 为什么不导出 Schemastery 的 Config：与 dsh-ops 同样的理由 —— 宿主半侧不 import
// 任何 @deepseek-ai/* 值，配置校验自己写，报错必须指名到字段；这样离线测试也能直接复用。
//
// 三条规则：
// 1) 未知字段直接报错，不静默忽略（拼错的键不生效比报错更难查）。
// 2) 数字允许数字字符串（cordis.yml 里常写成带引号的字符串），但必须真的是数字。
// 3) QQ 号按字符串处理（19 位账号用 Number 会丢精度），但接受数字输入。

/** 配置值不合法时抛这个错，消息自带插件前缀，日志里一眼能认出来。 */
export class ConfigError extends Error {
  constructor(message) {
    super(`dsh-qq-gateway config: ${message}`);
    this.name = 'ConfigError';
  }
}

/**
 * 声明式字段表：默认值 / 类型 / 范围 / 说明都在这里，文档和 `/status` 共用一份。
 * type: 'string' | 'qq' | 'number' | 'enum' | 'boolean' | 'path'
 */
export const CONFIG_FIELDS = [
  { key: 'host', type: 'string', default: '127.0.0.1', desc: '反向 WS 监听地址；容器连宿主要用 0.0.0.0，默认只本机' },
  { key: 'port', type: 'number', default: 8792, integer: true, min: 0, max: 65535, desc: '反向 WS 监听端口；0 表示由系统分配（测试用）' },
  { key: 'path', type: 'path', default: '/onebot', desc: '反向 WS 路径，必须与 NapCat 的 ws-reverse URL 一致' },
  { key: 'token', type: 'string', default: '', desc: '握手校验用的 Bearer token；置空=接受任何客户端（仅限本机调试）' },
  { key: 'mainQQ', type: 'qq', default: '', desc: '主号 QQ（始终可回；也是授权名单的管理员）' },
  { key: 'botQQ', type: 'qq', default: '', desc: '小号 QQ（协议端登录的号；self_id 必须等于它）' },
  { key: 'groupRequireMention', type: 'boolean', default: true, desc: '群消息必须 @ 小号才处理（只接 @ 的）' },
  { key: 'allowAllPrivate', type: 'boolean', default: false, desc: '私聊放行全部好友（true=不查授权名单；群聊仍只接 @）' },
  { key: 'adminEnabled', type: 'boolean', default: true, desc: '允许主号用 /allow /deny /list 远程维护私聊授权名单' },
  { key: 'allowListPath', type: 'string', default: '', desc: '授权名单落盘路径；空=~/.dsh/storages/qq-gateway-allow-list.json（重启不丢）' },
  { key: 'logFilePath', type: 'string', default: '', desc: '文件日志路径（真机排查用）；空=~/.dsh/storages/qq-gateway.log' },
  { key: 'muteStatePath', type: 'string', default: '', desc: '禁回状态落盘路径；空=~/.dsh/storages/qq-gateway-mute.json（改文件即热生效）' },
  { key: 'muteDefaultMinutes', type: 'number', default: 30, integer: true, min: 0, max: 43200, desc: '禁回默认时长（分钟）；0=默认永久，直到 /unmute' },
  { key: 'sessionId', type: 'string', default: '', desc: '目标 DSH 会话 id（消息只投递到这个会话）' },
  { key: 'maxQueue', type: 'number', default: 256, integer: true, min: 1, max: 100000, desc: '等待投递的有界队列上限，溢出丢最旧' },
  { key: 'turnTimeoutMs', type: 'number', default: 180000, integer: true, min: 0, max: 86400000, desc: '单回合等待上限，超时放开闸门但不回传；0=不设超时' },
  { key: 'ridTtlMs', type: 'number', default: 1800000, integer: true, min: 0, max: 86400000, desc: 'requestId 记账保质期（超时回合迟到对账用）' },
  { key: 'deliveryMode', type: 'enum', values: ['queue', 'steer'], default: 'queue', desc: '投递方式：queue=排队（推荐），steer=插队' },
  { key: 'unsupportedReply', type: 'string', default: '目前仅支持文本消息', desc: '图片/语音等无正文消息的回执内容；置空=关闭回执' },
  { key: 'unsupportedNoticeIntervalMs', type: 'number', default: 3000, integer: true, min: 0, max: 600000, desc: '媒体回执节流窗口，防对方连发图片刷爆 QQ' },
  { key: 'offlineBufferMax', type: 'number', default: 32, integer: true, min: 0, max: 10000, desc: '断线期间回传补发缓冲上限；0=不缓冲直接丢' },
  { key: 'eventPromptTypes', type: 'string', default: 'request,notice.group_recall,notice.friend_recall,notice.group_increase,notice.group_decrease,notice.group_admin,notice.group_ban,notice.friend_add,notice.essence,notice.group_file_upload', desc: '哪些入站事件要投进会话（逗号分隔，支持 notice.* 通配）；空=只记录不投递' },
  { key: 'maxEventBuffer', type: 'number', default: 200, integer: true, min: 1, max: 10000, desc: '事件环形缓冲上限（qq_events 可查）' },
  { key: 'heartbeatTimeoutMs', type: 'number', default: 90000, integer: true, min: 0, max: 3600000, desc: '心跳超时判定（ms）：超过这么久没心跳状态里标 stale；0=不判定' },
  { key: 'toolsEnabled', type: 'boolean', default: true, desc: '是否注册 qq_* 模型工具（发消息/发图/撤回/动作目录/事件/状态）' },
  { key: 'managementEnabled', type: 'boolean', default: true, desc: '是否允许 qq_action 执行写/破坏性管理动作（查询类不受限）' },
  { key: 'markdownReplyMode', type: 'enum', values: ['off', 'auto', 'image'], default: 'auto', desc: '助手回复里的 Markdown 怎么发到 QQ：off=纯文本；auto=长且像 Markdown 才渲染成图片；image=总是渲染成图片（QQ 不渲染 Markdown）' },
  { key: 'markdownImageMaxWidth', type: 'number', default: 720, integer: true, min: 320, max: 1600, desc: 'Markdown 渲染成图片时的最大宽度（像素）' },
  { key: 'relayDedupeMode', type: 'enum', values: ['off', 'turn'], default: 'turn', desc: '助手文字自动回传的去重：turn=本回合已用 qq_send 发过带文字的消息就不再自动回传（防 QQ 端双发）；off=关闭' },
  { key: 'replyDelayMode', type: 'enum', values: ['off', 'human'], default: 'human', desc: '助手回复的拟人延迟：human=按字数幂律 + 指数长尾抖动着等一会儿再发；off=算完立刻发' },
  { key: 'replyDelayMinMs', type: 'number', default: 800, integer: true, min: 0, max: 60000, desc: '拟人延迟下限（ms）：再短的回复也至少等这么久' },
  { key: 'replyDelayMaxMs', type: 'number', default: 12000, integer: true, min: 0, max: 600000, desc: '拟人延迟上限（ms）：必须 >= replyDelayMinMs' },
  { key: 'replyDelayPerCharMs', type: 'number', default: 60, integer: true, min: 0, max: 2000, desc: '每个字折算的打字时间（ms）；实际按字符数 0.85 次方算，长回复不会线性爆炸' },
  { key: 'replyDelayTailMs', type: 'number', default: 2500, integer: true, min: 0, max: 600000, desc: '看消息/发呆停顿的指数分布均值（ms）：长尾来源，0=只算打字时间' },
  { key: 'containerProxyPort', type: 'number', default: 0, integer: true, min: 0, max: 65535, desc: '容器网络直连代理监听端口：Docker Desktop 手动代理指向死地址时填它的端口（如 7892）；0=关闭' },
  { key: 'sendTimeoutMs', type: 'number', default: 15000, integer: true, min: 1000, max: 120000, desc: '发消息/动作等 NapCat 响应的超时（ms）' },
  { key: 'maxSendImageBytes', type: 'number', default: 10485760, integer: true, min: 1024, max: 104857600, desc: '出站图片/文件读取大小上限（字节）' },
  { key: 'autoStartDocker', type: 'boolean', default: false, desc: 'DSH 启动时自动拉起 Docker Desktop 和容器（打开 DSH 就能用 QQ）' },
  { key: 'stopDockerOnExit', type: 'boolean', default: false, desc: 'DSH 退出时停掉容器和 Docker Desktop（热重载不会误停）' },
  { key: 'dockerContainer', type: 'string', default: 'napcat-gw', desc: '联动启动时要确保运行的容器名' },
  { key: 'dockerDesktopPath', type: 'string', default: '', desc: 'Docker Desktop 可执行文件路径；空=自动找常见安装位置' },
  { key: 'dockerStartTimeoutMs', type: 'number', default: 180000, integer: true, min: 10000, max: 600000, desc: '等 Docker 引擎就绪的上限（毫秒）' },
  { key: 'statusEnabled', type: 'boolean', default: true, desc: '是否启动只读状态端点' },
  { key: 'statusHost', type: 'string', default: '127.0.0.1', desc: '状态端点监听地址；只读，默认只本机能看' },
  { key: 'statusPort', type: 'number', default: 8793, integer: true, min: 0, max: 65535, desc: '状态端点端口；0=系统分配（测试用）' },
  { key: 'statusPath', type: 'path', default: '/dsh-qq-gateway/status', desc: '状态端点路径，GET only' },
];

/** 字段名列表（顺序即文档顺序）。 */
export const CONFIG_KEYS = CONFIG_FIELDS.map((field) => field.key);

/** 默认配置对象（每次返回新对象，调用方改了不会污染别人）。 */
export function defaultConfig() {
  const cfg = {};
  for (const field of CONFIG_FIELDS) cfg[field.key] = field.default;
  return cfg;
}

/** 供文档/自检使用的 schema 快照（只读副本）。 */
export function configSchema() {
  return CONFIG_FIELDS.map((field) => ({ ...field }));
}

function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toNumber(field, value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  throw new ConfigError(`${field.key} must be a number, got ${describe(value)}`);
}

function validateField(field, value) {
  switch (field.type) {
    case 'string': {
      if (typeof value !== 'string') throw new ConfigError(`${field.key} must be a string, got ${describe(value)}`);
      return value;
    }
    case 'qq': {
      // 保留调用方给的类型（数字还是字符串）：OneBot 帧里的 user_id 就按配置原样发回，
      // 上一版 M1/M2 用例就是按数字断言的，这里不做隐式转换。字符串只去首尾空白。
      if (typeof value === 'number') {
        if (!Number.isInteger(value) || value <= 0) {
          throw new ConfigError(`${field.key} must be a positive integer QQ number, got ${describe(value)}`);
        }
        return value;
      }
      if (typeof value !== 'string') throw new ConfigError(`${field.key} must be a QQ number or string, got ${describe(value)}`);
      const trimmed = value.trim();
      if (trimmed !== '' && !/^\d{5,15}$/.test(trimmed)) {
        throw new ConfigError(`${field.key} must be a QQ number (5-15 digits) or empty, got ${describe(value)}`);
      }
      return trimmed;
    }
    case 'number': {
      const num = toNumber(field, value);
      if (!Number.isFinite(num)) throw new ConfigError(`${field.key} must be a finite number, got ${describe(value)}`);
      if (field.integer && !Number.isInteger(num)) throw new ConfigError(`${field.key} must be an integer, got ${describe(value)}`);
      if (field.min !== undefined && num < field.min) throw new ConfigError(`${field.key} must be >= ${field.min}, got ${describe(value)}`);
      if (field.max !== undefined && num > field.max) throw new ConfigError(`${field.key} must be <= ${field.max}, got ${describe(value)}`);
      return num;
    }
    case 'enum': {
      if (!field.values.includes(value)) {
        throw new ConfigError(`${field.key} must be one of ${field.values.map(describe).join(', ')}, got ${describe(value)}`);
      }
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') throw new ConfigError(`${field.key} must be a boolean, got ${describe(value)}`);
      return value;
    }
    case 'path': {
      if (typeof value !== 'string' || !value.startsWith('/') || value.trim() === '') {
        throw new ConfigError(`${field.key} must be an absolute path starting with "/", got ${describe(value)}`);
      }
      return value;
    }
    default:
      throw new ConfigError(`${field.key} has unsupported schema type ${field.type}`);
  }
}

/**
 * 校验并补默认值。返回可直接交给 createGateway 的配置对象。
 * 未知字段直接抛 ConfigError（拼错键不会静默失效）。
 */
export function normalizeConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`config must be an object, got ${describe(raw)}`);
  }
  const unknown = Object.keys(raw).filter((key) => !CONFIG_KEYS.includes(key));
  if (unknown.length) {
    throw new ConfigError(
      `unknown key(s) ${unknown.map(describe).join(', ')}; accepted keys are ${CONFIG_KEYS.map(describe).join(', ')}`,
    );
  }
  const cfg = defaultConfig();
  for (const field of CONFIG_FIELDS) {
    if (raw[field.key] === undefined) continue;
    if (raw[field.key] === null) {
      // null 视同未配置，用默认值，避免 YAML 里 `key:` 留空直接炸掉
      continue;
    }
    cfg[field.key] = validateField(field, raw[field.key]);
  }
  // 跨字段约束：单字段校验管不到顺序关系，在这里补
  if (cfg.replyDelayMaxMs < cfg.replyDelayMinMs) {
    throw new ConfigError(
      `replyDelayMaxMs must be >= replyDelayMinMs, got max=${cfg.replyDelayMaxMs} < min=${cfg.replyDelayMinMs}`,
    );
  }
  return cfg;
}

/** 启动前必填项：缺哪个报哪个，别让用户猜。 */
export function missingConfig(cfg) {
  const missing = [];
  if (!cfg.sessionId) missing.push('sessionId');
  if (!cfg.mainQQ) missing.push('mainQQ');
  if (!cfg.botQQ) missing.push('botQQ');
  return missing;
}

/** 状态端点用的配置快照：token 只报"配没配"，绝不回显原值。 */
export function publicConfig(cfg) {
  return {
    host: cfg.host,
    port: cfg.port,
    path: cfg.path,
    mainQQ: String(cfg.mainQQ),
    botQQ: String(cfg.botQQ),
    groupRequireMention: cfg.groupRequireMention,
    allowAllPrivate: cfg.allowAllPrivate,
    adminEnabled: cfg.adminEnabled,
    allowListPath: cfg.allowListPath,
    logFilePath: cfg.logFilePath,
    sessionId: String(cfg.sessionId),
    maxQueue: cfg.maxQueue,
    turnTimeoutMs: cfg.turnTimeoutMs,
    ridTtlMs: cfg.ridTtlMs,
    deliveryMode: cfg.deliveryMode,
    unsupportedReply: cfg.unsupportedReply,
    unsupportedNoticeIntervalMs: cfg.unsupportedNoticeIntervalMs,
    offlineBufferMax: cfg.offlineBufferMax,
    eventPromptTypes: cfg.eventPromptTypes,
    maxEventBuffer: cfg.maxEventBuffer,
    heartbeatTimeoutMs: cfg.heartbeatTimeoutMs,
    toolsEnabled: cfg.toolsEnabled,
    managementEnabled: cfg.managementEnabled,
    markdownReplyMode: cfg.markdownReplyMode,
    markdownImageMaxWidth: cfg.markdownImageMaxWidth,
    relayDedupeMode: cfg.relayDedupeMode,
    replyDelayMode: cfg.replyDelayMode,
    replyDelayMinMs: cfg.replyDelayMinMs,
    replyDelayMaxMs: cfg.replyDelayMaxMs,
    replyDelayPerCharMs: cfg.replyDelayPerCharMs,
    replyDelayTailMs: cfg.replyDelayTailMs,
    containerProxyPort: cfg.containerProxyPort,
    sendTimeoutMs: cfg.sendTimeoutMs,
    maxSendImageBytes: cfg.maxSendImageBytes,
    autoStartDocker: cfg.autoStartDocker,
    stopDockerOnExit: cfg.stopDockerOnExit,
    dockerContainer: cfg.dockerContainer,
    tokenConfigured: Boolean(cfg.token),
  };
}
