/**
 * dsh-qq-gateway —— QQ 消息网关(DSH 插件入口)
 *
 * 目标链路(单向):
 *   QQ 主号 → QQ 小号(协议端/NapCat) → 本插件 → 指定 DSH 会话 → 回复回 QQ 主号
 *
 * 里程碑:M0 契约探针、M1 离线往返、M2 队列硬化、M3 配置 Schema + 只读状态端点已完成;
 * M4 才做真机联调(NapCat 容器),所以本入口现在**只校验配置并尝试起网关**,
 * 配置不全就报一行日志退出,绝不拖垮宿主启动。
 *
 * 注意:这里不再有任何"启动即建会话/发消息"的探针代码 —— M0 探针会烧 token,
 * 已经永久移除,别再加回来。
 */
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { createGateway, missingConfig, normalizeConfig } from './gateway/gateway.js'

// 真机上宿主 logger 只进 Electron 控制台、不落盘，M4 联调时错误看不到。
// 顺手把同样一行追加到文件日志；写日志失败绝不影响网关。
// 默认落在 ~/.dsh/storages/qq-gateway.log：npm 安装的包目录不写东西（升级/重装不丢数据），
// 配置 logFilePath 可覆盖；授权名单同理（allowListPath）。
const DATA_DIR = join(homedir(), '.dsh', 'storages')
let LOG_PATH = join(DATA_DIR, 'qq-gateway.log')
const LOG_MAX_BYTES = 512 * 1024
// 安全升级（2026-10-26）：文件日志默认把 QQ 号/群号/消息 id 打码（保留首 2 末 2），
// 把日志贴到 issue/聊天里时不会连带暴露关系链；config.maskLogQQ=false 可关闭。
let maskLogQQ = true

/** 只打码 5-15 位纯数字（QQ 号/群号/消息 id），不碰时间戳和路径。 */
function maskDigits(text) {
  return String(text).replace(/(?<![\w.-])\d{5,15}(?![\w.-])/g, (digits) => (
    digits.length <= 4 ? digits : `${digits.slice(0, 2)}***${digits.slice(-2)}`
  ))
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host ?? '').trim().toLowerCase())
}

/** 启动前的安全组合校验：非环回必须配长 token，状态端点同理。 */
function securityBlockers(cfg) {
  const problems = []
  const token = String(cfg.token ?? '').trim()
  if (!token) {
    problems.push('token 不能为空：反向 WS 端点靠它鉴权，请填至少 32 位随机串')
  } else if (!isLoopbackHost(cfg.host) && token.length < 32) {
    problems.push(`host=${cfg.host} 不是环回地址，token 必须 >= 32 位（当前 ${token.length} 位）`)
  }
  if (!isLoopbackHost(cfg.host) && cfg.allowQueryToken) {
    problems.push('非环回监听时不允许 allowQueryToken=true（token 会进 URL / 代理日志）')
  }
  if (cfg.statusEnabled && !isLoopbackHost(cfg.statusHost)) {
    const statusToken = String(cfg.statusToken ?? '').trim()
    if (statusToken.length < 32) {
      problems.push(`statusHost=${cfg.statusHost} 不是环回地址，statusToken 必须 >= 32 位`)
    }
  }
  return problems
}

function fileLog(level, message) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true })
    const body = maskLogQQ ? maskDigits(message) : String(message)
    const entry = `${new Date().toISOString()} [${level}] ${body}\n`
    let size = 0
    try {
      size = statSync(LOG_PATH).size
    } catch {
      // 文件还不存在
    }
    if (size > LOG_MAX_BYTES) writeFileSync(LOG_PATH, entry, 'utf8')
    else appendFileSync(LOG_PATH, entry, 'utf8')
  } catch {
    // 日志写不进去也不能砸了消息链路
  }
}

export const name = 'qq-gateway'
export const inject = ['sessionController']

export function apply(ctx, rawConfig) {
  const logger = ctx.logger('qq-gateway')
  const log = (message) => {
    logger.info(message)
    fileLog('info', message)
  }

  let cfg
  try {
    cfg = normalizeConfig(rawConfig ?? {})
  } catch (err) {
    const message = `[M3] 配置不合法,网关不会启动: ${err?.message ?? String(err)}`
    logger.error(message)
    fileLog('error', message)
    return { gateway: null, error: err?.message ?? String(err) }
  }

  const missing = missingConfig(cfg)
  if (missing.length) {
    const message = `[M3] 配置缺少必填项 ${missing.join(', ')},网关不会启动(补齐后重启 DSH 生效)`
    logger.error(message)
    fileLog('error', message)
    return { gateway: null, error: `missing config: ${missing.join(', ')}` }
  }

  // 数据默认落 ~/.dsh/storages/（包目录保持干净，升级/重装不丢）；配置项可覆盖。
  // 两个字段回写成"实际生效值"，状态端点里看到的路径就是真正在用的。
  LOG_PATH = cfg.logFilePath || LOG_PATH
  cfg.logFilePath = LOG_PATH
  if (!cfg.allowListPath) cfg.allowListPath = join(DATA_DIR, 'qq-gateway-allow-list.json')
  maskLogQQ = cfg.maskLogQQ !== false
  // 出站本机文件的唯一白名单目录：默认在 storages 下，启动时就建好；
  // 文件发不出去比发出去更安全，目录建不出来只记日志，不拦网关启动。
  if (!cfg.outboxDir) cfg.outboxDir = join(DATA_DIR, 'qq-gateway-outbox')
  try {
    mkdirSync(cfg.outboxDir, { recursive: true })
  } catch {
    // 目录建不出来只影响发本地文件
  }

  // 安全组合校验（2026-10-26）：不满足就拒绝启动，绝不带着空 token 监听非环回地址。
  const blockers = securityBlockers(cfg)
  if (blockers.length) {
    const message = `[安全] 网关启动被拒绝：${blockers.join('；')}`
    logger.error(message)
    fileLog('error', message)
    return { gateway: null, error: message }
  }

  // M5.2：退出联动关闭的助手要把结果写进同一份文件日志（真机证据来源）
  const gateway = createGateway({ ctx, config: cfg, logger: log, deps: { shutdownLogPath: LOG_PATH } })
  ctx.effect(() => () => { void gateway.stop() }, 'qq-gateway: 反向 WS + 只读状态端点')

  // M6.2：容器网络直连代理。本机 Docker Desktop 的手动代理指向 127.0.0.1:7892，
  // 但那个端口没有代理在跑 → 容器里 HTTP(S) 全挂，NapCat 的 WebApi 功能（群公告/精华/荣誉）
  // 报 TLS 错误。这里在宿主 127.0.0.1 起一个最小直连代理顶上（纯旁路，只监听本机）。
  // 配置 containerProxyPort=0 关闭；端口被占（用户真开了代理）只记日志降级。
  if (cfg.containerProxyPort > 0) {
    void (async () => {
      try {
        const { createContainerProxy } = await import('./gateway/container-proxy.js')
        const proxy = createContainerProxy({ port: cfg.containerProxyPort, host: '127.0.0.1', log })
        ctx.effect(() => () => { void proxy.close() }, 'qq-gateway: 容器网络直连代理')
        const result = await proxy.listen()
        // 传 getter：状态端点每次读都能看到实时 stats（隧道/转发计数）
        gateway.setContainerProxyInfo(() => ({ ...proxy.status(), error: result.ok ? null : result.error }))
        if (result.ok) {
          log(`[M6.2] 容器网络直连代理已监听 ${result.host}:${result.port}（供 Docker Desktop 代理设置使用）`)
        } else {
          log(`[M6.2] 容器网络直连代理没起来（端口 ${cfg.containerProxyPort}）：${result.error}；群公告/精华等 WebApi 功能可能继续报 TLS 错误`)
        }
      } catch (err) {
        const message = `[M6.2] 容器网络直连代理启动失败（不影响消息链路）：${err?.message ?? String(err)}`
        logger.error(message)
        fileLog('error', message)
      }
    })()
  }

  // M6：注册 qq_* 模型工具。tools 是可选依赖：拿不到/导入失败时只跳过工具注册，
  // 消息链路照常（绝不让工具模块的问题拖垮网关本体）。
  void (async () => {
    try {
      if (!cfg.toolsEnabled) {
        log('[M6] config.toolsEnabled=false，qq_* 工具不注册')
        return
      }
      const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
      if (!tools || typeof tools.register !== 'function') {
        log('[M6] tools 服务不可用，qq_* 工具不注册（消息链路不受影响）')
        return
      }
      const { createQqTools } = await import('./gateway/tools.js')
      const definitions = createQqTools({ gateway, config: cfg, logger: log })
      for (const definition of definitions) {
        ctx.effect(() => tools.register(definition), `qq-gateway/tool:${definition.name}`)
      }
      gateway.setToolNames(definitions.map((definition) => definition.name))
      log(`[M6] 已注册 qq_* 工具 ${definitions.length} 个：${definitions.map((definition) => definition.name).join(', ')}`)
    } catch (err) {
      const message = `[M6] qq_* 工具注册失败（消息链路不受影响）：${err?.message ?? String(err)}`
      logger.error(message)
      fileLog('error', message)
    }
  })()

  gateway.start().then((st) => {
    log(`[M3] 网关已启动 ws://${cfg.host}:${st.listening.port}${cfg.path} -> 会话 ${cfg.sessionId}`)
    if (st.statusEndpoint.url) log(`[M3] 状态端点(只读): ${st.statusEndpoint.url}`)
    else log(`[M3] 状态端点不可用: ${st.statusEndpoint.error ?? 'disabled'}`)
  }).catch((err) => {
    const message = `[M3] 网关启动失败: ${err?.message ?? String(err)}`
    logger.error(message)
    fileLog('error', message)
  })

  return { gateway }
}
