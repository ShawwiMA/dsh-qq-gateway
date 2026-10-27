# dsh-qq-gateway

[![npm version](https://img.shields.io/npm/v/dsh-qq-gateway.svg)](https://www.npmjs.com/package/dsh-qq-gateway)
[![CI](https://github.com/ShawwiMA/dsh-qq-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/ShawwiMA/dsh-qq-gateway/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-qq-gateway.svg)](./LICENSE)

把 QQ 接到 DeepSeek Harness 的插件：小号（NapCat / OneBot 11）收消息 → 投给指定 DSH 会话 → 助手回复自动回传 QQ。

- 收 / 发文字、图片、合并转发（连转发里的图片也能读）
- 助手回复的 Markdown 可渲染成图片再发（QQ 不渲染 Markdown）
- 9 个 `qq_*` 模型工具：发消息、撤回、群公告、拉群、任意 OneBot 动作、动作目录、事件查询、状态、禁回
- 主号在 QQ 里直接发 `/allow`、`/mute` 等指令，网关自己执行，不占用模型回合
- 拟人延迟（按字数 + 长尾抖动）、禁回（按时长 / 指定人），状态落盘、改文件热生效
- 掉线自动重连、断线回传缓冲、Docker + NapCat 联动启动（Windows Docker Desktop）
- 只读状态端点，出问题先看它

## 工作原理

```text
QQ 好友 / 群
   │ 消息
   ▼
NapCat（协议端，登录小号）
   │ OneBot 11 反向 WebSocket
   ▼
dsh-qq-gateway（本插件，监听 0.0.0.0:8792/onebot）
   │ 投递到指定 DSH 会话
   ▼
DSH 助手
   │ 回复 / 调用 qq_* 工具
   ▼
dsh-qq-gateway ── OneBot API ──► NapCat ──► QQ
```

单向：所有 QQ 消息只投到一个 `sessionId`，回复也只回 QQ。私聊默认只回主号（或授权名单，`allowAllPrivate: true` 则全放开）；群聊默认只回 @ 小号的消息。

## 环境要求

- DSH ≥ 0.2.0（桌面端 / Web）
- Node.js 22.19+ 或 24+
- [NapCat](https://napneko.github.io/) 或其他 OneBot 11 协议端，登录一个 QQ 小号
- 一个 QQ 主号，用来收回复、发管理指令

## 安装

1. 装插件：

   ```bash
   dsh plugin --profile desktop add dsh-qq-gateway
   ```

   `desktop` 换成自己的 profile 名。插件以 bundle 形式挂载，入口 id 是 `qq-gateway`。

2. 启动 NapCat 并登录小号，在 NapCat「网络配置 → OneBot 11」里加一条**反向 WebSocket**：

   - 地址：`ws://host.docker.internal:8792/onebot`（NapCat 在 Docker 里）；宿主机直跑填 `ws://127.0.0.1:8792/onebot`
   - Token：与配置里的 `token` 完全一致
   - 消息格式选 `array`（推荐）；`reportSelfMessage` 建议关闭

3. 给插件配参数。编辑 `~/.dsh/profiles/<profile>/cordis.patch.yml`，加（或改）这一段：

   ```yaml
   - id: qq-gateway
     name: dsh-qq-gateway
     config:
       host: 0.0.0.0
       port: 8792
       path: /onebot
       token: 换成一串随机字符
       mainQQ: 10001            # 主号：收回复、发管理指令
       botQQ: 10002             # 小号：NapCat 登录的号
       sessionId: session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```

4. 重启 DSH（或触发插件重载）。日志里出现 `网关已启动 ws://...` 就通了。

`mainQQ`、`botQQ`、`sessionId` 必填；`token` 必填（监听非环回地址时还要求 >= 32 位随机串，否则启动直接拒绝）。`sessionId` 在 DSH 会话详情 / URL 里找，格式是 `session-...`。

## 配置项（61 个）

字段表以 `lib/gateway/config.js` 的 `CONFIG_FIELDS` 为唯一来源；未知字段直接报错，拼错键不会静默失效。

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `host` | string | 127.0.0.1 | 反向 WS 监听地址；容器连宿主要用 0.0.0.0，默认只本机；非环回时强制 token |
| `port` | number | 8792 | 反向 WS 监听端口；0 表示由系统分配（测试用） |
| `path` | path | /onebot | 反向 WS 路径，必须与 NapCat 的 ws-reverse URL 一致 |
| `token` | string | (空) | 握手校验用的 Bearer token；必填，非环回地址要求 >= 32 位（空 token 只允许监听 127.0.0.1） |
| `allowQueryToken` | boolean | false | 是否允许从 URL query（access_token）取 token；默认只认 Authorization 头，防 token 进代理日志 |
| `allowOrigin` | boolean | false | 是否放行带 Origin 头的握手；默认拒绝（NapCat 不带 Origin，浏览器必带） |
| `maxFrameBytes` | number | 4194304 | 反向 WS 单帧上限（字节）；超限发 close 1009 断开，防超大包 OOM |
| `maxMessageBytes` | number | 16777216 | 反向 WS 单条消息（分片累计）上限（字节）；超限断开 |
| `mainQQ` | qq | (空) | 主号 QQ（始终可回；也是授权名单的管理员） |
| `botQQ` | qq | (空) | 小号 QQ（协议端登录的号；self_id 必须等于它） |
| `groupRequireMention` | boolean | true | 群消息必须 @ 小号才处理（只接 @ 的） |
| `allowAllPrivate` | boolean | false | 私聊放行全部好友（true=不查授权名单；群聊仍只接 @） |
| `adminEnabled` | boolean | true | 允许主号用 /allow /deny /list 远程维护私聊授权名单 |
| `allowListPath` | string | (空) | 授权名单落盘路径；空=~/.dsh/storages/qq-gateway-allow-list.json（重启不丢） |
| `logFilePath` | string | (空) | 文件日志路径（真机排查用）；空=~/.dsh/storages/qq-gateway.log |
| `maskLogQQ` | boolean | true | 文件日志里的 QQ 号/群号/消息 id 是否打码（默认打码，防日志外泄暴露关系链） |
| `muteStatePath` | string | (空) | 禁回状态落盘路径；空=~/.dsh/storages/qq-gateway-mute.json（改文件即热生效） |
| `muteDefaultMinutes` | number | 30 | 禁回默认时长（分钟）；0=默认永久，直到 /unmute |
| `rateLimitPerMinute` | number | 10 | 单个来源（QQ 号/群）每分钟最多触发多少条消息或事件；超出丢弃，主号不受限 |
| `autoMuteMinutes` | number | 10 | 连续触发限流时自动禁回的时长（分钟）；0=只丢弃不自动禁回 |
| `dupWindowMinutes` | number | 10 | 重复内容去重窗口（分钟）：同一人同一段文字窗口内只投一次；0=关闭 |
| `sessionId` | string | (空) | 目标 DSH 会话 id（消息只投递到这个会话） |
| `maxQueue` | number | 256 | 等待投递的有界队列上限；满时主号消息仍入队并挤掉最旧的非主号消息 |
| `burstMergeMs` | number | 1500 | 同一来源连发的合并窗口（ms）：窗口内的纯文字消息合并成一个模型回合；0=不合并 |
| `turnTimeoutMs` | number | 180000 | 单回合等待上限，超时放开闸门但不回传；0=不设超时 |
| `ridTtlMs` | number | 1800000 | requestId 记账保质期（超时回合迟到对账用） |
| `deliveryMode` | enum | queue / queue\|steer | 投递方式：queue=排队（推荐），steer=插队 |
| `unsupportedReply` | string | 目前仅支持文本消息 | 图片/语音等无正文消息的回执内容；置空=关闭回执 |
| `unsupportedNoticeIntervalMs` | number | 3000 | 媒体回执节流窗口，防对方连发图片刷爆 QQ |
| `offlineBufferMax` | number | 32 | 断线期间回传补发缓冲上限；0=不缓冲直接丢 |
| `eventPromptTypes` | string | request,notice.group_recall,... | 哪些入站事件要投进会话（逗号分隔，支持 notice.* 通配）；空=只记录不投递 |
| `eventPromptRequests` | boolean | false | 是否把好友/加群申请投给模型（默认不投：陌生人附言是注入面；要自动处理申请再打开） |
| `maxEventBuffer` | number | 200 | 事件环形缓冲上限（qq_events 可查） |
| `heartbeatTimeoutMs` | number | 90000 | 心跳超时判定（ms）：超过这么久没心跳状态里标 stale；0=不判定 |
| `toolsEnabled` | boolean | true | 是否注册 qq_* 模型工具（发消息/发图/撤回/动作目录/事件/状态） |
| `managementEnabled` | boolean | true | 是否允许 qq_action 执行写/破坏性管理动作（查询类不受限） |
| `highRiskActionsRequireMain` | boolean | true | 写/破坏性管理动作是否只允许主号发起的那一轮调用（默认是） |
| `markdownReplyMode` | enum | auto / off\|auto\|image | 助手回复里的 Markdown 怎么发到 QQ：off=纯文本；auto=长且像 Markdown 才渲染成图片；image=总是渲染成图片（QQ 不渲染 Markdown） |
| `markdownImageMaxWidth` | number | 720 | Markdown 渲染成图片时的最大宽度（像素） |
| `relayDedupeMode` | enum | turn / off\|turn | 助手文字自动回传的去重：turn=本回合已用 qq_send 发过带文字的消息就不再自动回传（防 QQ 端双发）；off=关闭 |
| `replyDelayMode` | enum | human / off\|human | 助手回复的拟人延迟：human=按字数幂律 + 指数长尾抖动着等一会儿再发；off=算完立刻发 |
| `replyDelayMinMs` | number | 800 | 拟人延迟下限（ms）：再短的回复也至少等这么久 |
| `replyDelayMaxMs` | number | 12000 | 拟人延迟上限（ms）：必须 >= replyDelayMinMs |
| `replyDelayPerCharMs` | number | 60 | 每个字折算的打字时间（ms）；实际按字符数 0.85 次方算，长回复不会线性爆炸 |
| `replyDelayTailMs` | number | 2500 | 看消息/发呆停顿的指数分布均值（ms）：长尾来源，0=只算打字时间 |
| `containerProxyPort` | number | 0 | 容器网络直连代理监听端口：Docker Desktop 手动代理指向死地址时填它的端口（如 7892）；0=关闭 |
| `sendTimeoutMs` | number | 15000 | 发消息/动作等 NapCat 响应的超时（ms） |
| `maxSendImageBytes` | number | 10485760 | 出站图片/文件读取大小上限（字节） |
| `outboxDir` | string | (空) | 出站本机文件的唯一白名单目录；空=~/.dsh/storages/qq-gateway-outbox（启动时创建） |
| `fileSendPolicy` | enum | main / main\|outbox\|all | 本机文件出站策略：main=只有主号回合能发（推荐）；outbox=非主号只能发 outboxDir 内文件；all=不限制（仅调试） |
| `autoStartDocker` | boolean | false | DSH 启动时自动拉起 Docker Desktop 和容器（打开 DSH 就能用 QQ） |
| `stopDockerOnExit` | boolean | false | DSH 退出时停掉容器和 Docker Desktop（热重载不会误停） |
| `dockerContainer` | string | napcat-gw | 联动启动时要确保运行的容器名 |
| `dockerDesktopPath` | string | (空) | Docker Desktop 可执行文件路径；空=自动找常见安装位置 |
| `dockerStartTimeoutMs` | number | 180000 | 等 Docker 引擎就绪的上限（毫秒） |
| `statusEnabled` | boolean | true | 是否启动只读状态端点 |
| `statusHost` | string | 127.0.0.1 | 状态端点监听地址；只读，默认只本机能看；非环回必须配 statusToken |
| `statusPort` | number | 8793 | 状态端点端口；0=系统分配（测试用） |
| `statusPath` | path | /dsh-qq-gateway/status | 状态端点路径，GET only |
| `statusToken` | string | (空) | 状态端点 Bearer token；空=不校验（仅限 127.0.0.1）；非环回必须 >= 32 位 |
| `mediaUrlAllowPrivate` | boolean | false | 是否允许媒体 URL 指向本机/内网地址（默认禁，防 SSRF；仅调试用） |

## 主号管理指令

在 QQ 私聊里以 `/` 开头发，网关自己执行并回执，**不会**投给模型。中文别名同样可用。

| 指令 | 作用 |
| --- | --- |
| `/allow <QQ> [备注]` | 授权某人可以私聊回消息（别名：`/授权`） |
| `/deny <QQ>` | 取消授权（别名：`/取消`、`/移除`） |
| `/list` | 看授权名单（别名：`/名单`） |
| `/mute` | 全局禁回，默认 `muteDefaultMinutes` 分钟（别名：`/禁言`、`/静默`、`/禁回`） |
| `/mute <QQ> <分钟>` | 只禁某个人；分钟省略用默认；`0` = 永久直到解除 |
| `/mute list` | 看当前禁回（谁、还剩多久） |
| `/unmute` / `/unmute <QQ>` | 全部解除 / 只解一个人（别名：`/解除`、`/解禁`） |
| `/help` | 指令速查（别名：`/帮助`） |

规则：

- 主号永远不受禁回影响，指令只认主号私聊。
- 禁回只丢**消息**，撤回、入群、好友申请这类事件照常记录（`qq_events` 能查）。
- 禁回状态存 `~/.dsh/storages/qq-gateway-mute.json`，改这个文件 0.5 秒内热生效；删文件等于全部解除。
- 除了 QQ 指令，DSH 里也可以用 `qq_mute` 工具，或在 DSH 配置里改。

## 模型工具

| 工具 | 作用 |
| --- | --- |
| `qq_send` | 发消息：文字 / 图片（路径或 URL）/ @ / 表情 / 语音 / 视频 / 文件 / 卡片 / 合并转发，支持原始消息段 |
| `qq_recall` | 撤回消息；不传 id 就撤最近一条网关发出的 |
| `qq_notice` | 发群公告（走 NapCat WebApi） |
| `qq_invite` | 拉人进群：拿群链接 / 私聊发群名片 Ark |
| `qq_action` | 调任意 OneBot 11 动作（约 90 个，`qq_actions` 可查目录） |
| `qq_actions` | 查 OneBot 动作目录（可按类别 / 关键词过滤） |
| `qq_events` | 查最近事件：撤回、成员增减、管理员变动、禁言、好友/加群申请、精华、群文件等 |
| `qq_status` | 看网关状态：连接、账号、心跳、队列、计数、禁回、工具列表 |
| `qq_mute` | 禁回 / 解除 / 查看（全局或指定 QQ，按时长） |

`toolsEnabled: false` 可整体关掉；`managementEnabled: false` 只禁写/破坏性动作，查询照常；`highRiskActionsRequireMain: true`（默认）让写/破坏性动作只在主号发起的那一轮可用。

配套技能 `qq-gateway-operator` 随插件包提供（`skills/qq-gateway-operator/SKILL.md`），**不再放进全局技能目录**；主客判定、越权拒绝、防注入这几条也已内联在来源头提示里，所以别的会话不会加载它。

## 禁回与拟人延迟

- **拟人延迟**：助手回复不是秒回，按字符数做幂律折算打字时间，再叠一个指数长尾的「看消息/发呆」停顿，封顶 `replyDelayMaxMs`。只影响自动回传，模型主动 `qq_send` 不受影响。`replyDelayMode: off` 关闭。
- **禁回**：见上节。优先级高于投递：消息入口丢一次，排队出队再确认一次，不会出现「设完禁回还回一条」。

## 状态端点

只读 GET，默认 `http://127.0.0.1:8793/dsh-qq-gateway/status`：

```bash
curl -s http://127.0.0.1:8793/dsh-qq-gateway/status
```

顶层字段：`state`、`startedAt`、`uptimeMs`、`listening`、`statusEndpoint`、`peers`、`busy`、`queueDepth`、`offlineBufferDepth`、`inFlightRids`、`timedOutRids`、`openTurns`、`tokenConfigured`、`login`（账号 + 心跳）、`counters`、`docker`、`containerProxy`、`authz`、`mute`、`events`、`tools`、`sent`、`config`。

排查顺序：`peers` 是不是 0 → `login.heartbeat.online` → `queueDepth` / `busy` → `counters.mutedSkipped`、`counters.skippedUnauthorized` → `lastPromptError`。

## 数据文件

默认都在 `~/.dsh/storages/`（配置项可改；插件包目录本身不写数据，升级 / 重装不丢）：

- `qq-gateway-allow-list.json` — 私聊授权名单
- `qq-gateway-mute.json` — 禁回状态（改它热生效）
- `qq-gateway.log` — 文件日志，512 KB 自动轮转重写

## 安全

部署检查清单、漏洞报告方式、已知边界见 [SECURITY.md](./SECURITY.md)。2026-10-26 做过一轮安全升级，下面几条是默认值的取舍：

**默认值就是安全侧**（2026-10-26 安全升级），几处关键取舍：

连接层
- `token` 必填；监听非环回（`0.0.0.0`）时还要求 >= 32 位，否则启动直接拒绝。空 token 只允许 `127.0.0.1`。
- 握手只认 `Authorization: Bearer`；URL query 传 token（`allowQueryToken`）默认关。
- 带 `Origin` 头的握手默认拒绝（NapCat 不带 Origin，浏览器必带，防跨站 WebSocket）。
- 单帧 / 单条消息有大小上限（`maxFrameBytes` / `maxMessageBytes`），超限回 close 1009 并断开；握手 5 秒、空闲 120 秒超时；同一时间只保留一条 NapCat 连接，多余连接直接掐掉。
- 状态端点支持 `statusToken`；监听非环回时必须配 >= 32 位。

入站层
- 按来源限流（`rateLimitPerMinute`，默认 10 条/分钟），主号豁免；连续超限会阶梯式自动禁回（`autoMuteMinutes`，0=只丢弃不自动禁回）。
- 同一人同一段文字在 `dupWindowMinutes` 窗口内只投一次（换个 message_id 也算重复）。
- 同一来源在 `burstMergeMs` 窗口内的纯文字连发合并成一个回合，只回一次。
- 队列满时主号消息仍入队，挤掉最旧的非主号消息；非主号新消息直接丢。
- 事件（撤回/群文件/申请等）也要过禁回和限流；好友/加群申请默认不投给模型（`eventPromptRequests: true` 才投）。
- 日志默认给 QQ 号/群号/消息 id 打码（`maskLogQQ`）。

出站层
- 本机文件只允许「主号发起的那一轮」发送（`fileSendPolicy: main`）；`outbox` 模式非主号只能发 `outboxDir` 内文件；UNC 网络路径一律拒绝。
- 媒体 `url` 只接受 `http(s)`：`file://`、`data:`、`base64://`、UNC 等一律拒绝（`mface` / `share` 段同规则），防止把本机文件包成 URL 绕过权限。
- 媒体 URL 的**目标地址**也校验：私网、回环、链路本地、`localhost` / `host.docker.internal` 等本机名、解析到内网的域名一律拒绝；非主号回合的 URL 由网关自己逐跳校验重定向后下载，再转 base64 交给 NapCat（`mediaUrlAllowPrivate` 可放开，仅调试）。
- IPv6 全形态同样判私（`::ffff:x.x.x.x` 两种写法、NAT64、6to4、Teredo 等）；生产下载走 node 自连：解析后**钉死 IP** 连接、核对实际远端地址、边读边限长（超限立即中断）。
- `qq_action` 与 `qq_notice` 的写/破坏性动作只认主号回合（`highRiskActionsRequireMain`）；公告图片只收 http(s) URL；查询类不受限。

其它
- 提示词注入只能降低、不能消灭：真正的边界是「会话里有哪些工具」。建议网关会话不开 shell / 写盘 / 屏控，模型即使被骗也拿不到东西。
- 小号有被 QQ 风控 / 踢下线的风险，与插件无关；建议别用主号当小号。
- 状态端点默认只听 `127.0.0.1`，别往公网映射。

## 已知限制

1. 破坏性管理动作（踢人、禁言、设管理员、改群名、退群、删群文件、处理申请等）只做了协议级测试，没有在真群里逐个验证，效果取决于 NapCat / QQ，后果自负。
2. 语音、视频、文件**出站**没有真机验证；图片最稳。合并转发出站验证过。
3. NapCat 关闭 `reportSelfMessage` 时，自己发的消息不会以 `message_sent` 事件上报。
4. 群消息撤回窗口是 QQ 服务器的 2 分钟限制，超时撤回会原样报错。
5. 事件默认只把通知类（撤回/成员变动/群文件等）投进会话，好友/加群申请默认不投（`eventPromptRequests: true` 才投）；嫌吵把 `eventPromptTypes` 置空（事件仍能 `qq_events` 查）。
6. 消息只投一个会话（`sessionId`），不支持多会话路由。
7. `autoStartDocker` / `stopDockerOnExit` 只适配了 Windows 的 Docker Desktop；其他系统手动开 Docker。
8. 依赖 `@deepseek-ai/dsh-tools`（注册 `qq_*` 工具用），由 DSH 宿主提供；拿不到时工具不注册，消息链路照常。

## 故障排查

- **状态端点打不开**：`statusEnabled` 关了 / 端口被占（`statusPort: 0` 换随机端口）。
- **`peers: 0`**：NapCat 反向 WS 没连上。检查地址、路径、token；容器里连宿主机用 `host.docker.internal`，插件监听要 `0.0.0.0`。
- **收到消息但没回复**：`sessionId` 写错 / 会话被归档 / 群消息没 @ 小号 / 私聊不在名单且 `allowAllPrivate: false` / 被禁回（`mute.activeCount`、`counters.mutedSkipped`）/ 主号以外的私聊默认不回。
- **QQ 收到两遍**：保持 `relayDedupeMode: turn`。
- **回复很慢**：`replyDelayMode: human` 的正常表现；要立刻发改 `off`。
- **日志**：`~/.dsh/storages/qq-gateway.log`（`logFilePath` 可改）。

## 文档

`docs/` 是开发过程的里程碑记录（已脱敏，只留方法和结论，想自己改的可以直接看）：

- [M0 契约探针](docs/M0-契约探针-结论.md) — 宿主 / OneBot 的事件形状与契约
- [M1 离线往返](docs/M1-离线往返-结论.md) — 假 NapCat + 假宿主打通投递与回传
- [M2 队列硬化](docs/M2-队列硬化-结论.md) — 防回环、超时、断线补发、溢出丢最旧
- [M3 配置与状态端点](docs/M3-配置与状态端点-结论.md) — 配置 Schema 与只读状态
- [M4 实机部署](docs/M4-实机部署-结论.md) — Docker + NapCat 真机联调记录
- [M6 全能力对接](docs/M6-全能力对接-结论.md) — 事件、富媒体、动作目录、模型工具
- [M7 拟人延迟](docs/M7-拟人延迟-结论.md) — 幂律 + 指数长尾
- [M8 禁回](docs/M8-禁回-结论.md) — 热加载禁回与三条入口
- [M9 安全升级](docs/M9-安全升级-结论.md) — 审计发现、加固清单、残余风险
- [M10 媒体 URL 校验](docs/M10-媒体URL校验-结论.md) — 协议白名单与工具权限（评审补充）
- [M11 媒体 URL SSRF 校验](docs/M11-媒体URL-SSRF-结论.md) — 目标地址、DNS、重定向与代下载
- [M12 媒体下载传输层](docs/M12-媒体下载传输层-结论.md) — IPv6 全形态、钉 IP、实际地址核对、流式限长
- [M13 渗透自测报告](docs/M13-渗透自测报告.md) — 私网/重定向 URL、非主号越权、提示词注入的攻击→拦截对照

## 开发

```text
lib/index.js              插件入口：校验配置、起网关、注册工具
lib/gateway/gateway.js    核心：反向 WS、队列、投递、回传、状态
lib/gateway/guard.js      入站限流 / 内容去重 / 连发合并 / 事件门控
lib/gateway/config.js     60 个配置项的声明式 Schema（文档同源）
lib/gateway/ws.js         反向 WS 服务端（握手 token、心跳、断线清理）
lib/gateway/tools.js      9 个 qq_* 模型工具
lib/gateway/actions.js    OneBot 动作目录 + 消息段构造
lib/gateway/events.js     事件归一化与中文描述
lib/gateway/mute.js       禁回（解析、落盘、热加载）
lib/gateway/human-delay.js 拟人延迟（幂律 + 指数长尾）
lib/gateway/docker.js     Docker Desktop / 容器联动启动
lib/gateway/status-server.js 只读状态端点
lib/gateway/container-proxy.js 容器网络直连代理
```

- **离线测试**（不需要真 QQ / Docker）：`npm test`，24 套约 260 条断言；CI 在 Windows + Node 22/24 上自动跑。测试脚本在源码仓库里，不随 npm 包发布；`*-live.mjs` 系列需要真实 NapCat，自己按需跑。
- **改代码生效**：插件已被 DSH 加载，改 `lib/` 下的文件后不会自动重载，需要触发插件重载（改 profile patch 触发 `patchReload`，或重启 DSH）。改配置项一般只需重载 patch。
- 提交前跑一遍 `npm test`（`prepublishOnly` 也会跑）。

## License

MIT，见 [LICENSE](./LICENSE)。
