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

`mainQQ`、`botQQ`、`sessionId` 必填；`token` 强烈建议填，空 token 等于谁都能连。`sessionId` 在 DSH 会话详情 / URL 里找，格式是 `session-...`。

## 配置项（46 个）

字段表以 `lib/gateway/config.js` 的 `CONFIG_FIELDS` 为唯一来源；未知字段直接报错，拼错键不会静默失效。

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `host` | string | 127.0.0.1 | 反向 WS 监听地址；容器连宿主要用 0.0.0.0，默认只本机 |
| `port` | number | 8792 | 反向 WS 监听端口；0 表示由系统分配（测试用） |
| `path` | path | /onebot | 反向 WS 路径，必须与 NapCat 的 ws-reverse URL 一致 |
| `token` | string | (空) | 握手校验用的 Bearer token；置空=接受任何客户端（仅限本机调试） |
| `mainQQ` | qq | (空) | 主号 QQ（始终可回；也是授权名单的管理员） |
| `botQQ` | qq | (空) | 小号 QQ（协议端登录的号；self_id 必须等于它） |
| `groupRequireMention` | boolean | true | 群消息必须 @ 小号才处理（只接 @ 的） |
| `allowAllPrivate` | boolean | false | 私聊放行全部好友（true=不查授权名单；群聊仍只接 @） |
| `adminEnabled` | boolean | true | 允许主号用 /allow /deny /list 远程维护私聊授权名单 |
| `allowListPath` | string | (空) | 授权名单落盘路径；空=~/.dsh/storages/qq-gateway-allow-list.json（重启不丢） |
| `logFilePath` | string | (空) | 文件日志路径（真机排查用）；空=~/.dsh/storages/qq-gateway.log |
| `muteStatePath` | string | (空) | 禁回状态落盘路径；空=~/.dsh/storages/qq-gateway-mute.json（改文件即热生效） |
| `muteDefaultMinutes` | number | 30 | 禁回默认时长（分钟）；0=默认永久，直到 /unmute |
| `sessionId` | string | (空) | 目标 DSH 会话 id（消息只投递到这个会话） |
| `maxQueue` | number | 256 | 等待投递的有界队列上限，溢出丢最旧 |
| `turnTimeoutMs` | number | 180000 | 单回合等待上限，超时放开闸门但不回传；0=不设超时 |
| `ridTtlMs` | number | 1800000 | requestId 记账保质期（超时回合迟到对账用） |
| `deliveryMode` | enum | queue / queue\|steer | 投递方式：queue=排队（推荐），steer=插队 |
| `unsupportedReply` | string | 目前仅支持文本消息 | 图片/语音等无正文消息的回执内容；置空=关闭回执 |
| `unsupportedNoticeIntervalMs` | number | 3000 | 媒体回执节流窗口，防对方连发图片刷爆 QQ |
| `offlineBufferMax` | number | 32 | 断线期间回传补发缓冲上限；0=不缓冲直接丢 |
| `eventPromptTypes` | string | request,notice.group_recall,notice.friend_recall,notice.group_increase,notice.group_decrease,notice.group_admin,notice.group_ban,notice.friend_add,notice.essence,notice.group_file_upload | 哪些入站事件要投进会话（逗号分隔，支持 notice.* 通配）；空=只记录不投递 |
| `maxEventBuffer` | number | 200 | 事件环形缓冲上限（qq_events 可查） |
| `heartbeatTimeoutMs` | number | 90000 | 心跳超时判定（ms）：超过这么久没心跳状态里标 stale；0=不判定 |
| `toolsEnabled` | boolean | true | 是否注册 qq_* 模型工具（发消息/发图/撤回/动作目录/事件/状态） |
| `managementEnabled` | boolean | true | 是否允许 qq_action 执行写/破坏性管理动作（查询类不受限） |
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
| `autoStartDocker` | boolean | false | DSH 启动时自动拉起 Docker Desktop 和容器（打开 DSH 就能用 QQ） |
| `stopDockerOnExit` | boolean | false | DSH 退出时停掉容器和 Docker Desktop（热重载不会误停） |
| `dockerContainer` | string | napcat-gw | 联动启动时要确保运行的容器名 |
| `dockerDesktopPath` | string | (空) | Docker Desktop 可执行文件路径；空=自动找常见安装位置 |
| `dockerStartTimeoutMs` | number | 180000 | 等 Docker 引擎就绪的上限（毫秒） |
| `statusEnabled` | boolean | true | 是否启动只读状态端点 |
| `statusHost` | string | 127.0.0.1 | 状态端点监听地址；只读，默认只本机能看 |
| `statusPort` | number | 8793 | 状态端点端口；0=系统分配（测试用） |
| `statusPath` | path | /dsh-qq-gateway/status | 状态端点路径，GET only |

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

`toolsEnabled: false` 可整体关掉；`managementEnabled: false` 只禁写/破坏性动作，查询照常。

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

- `token` 必填且用随机串；`host: 0.0.0.0` + 空 token = 局域网内谁都能连。
- 状态端点默认只听 `127.0.0.1`，别往公网映射。
- `managementEnabled: false` 可禁止模型执行踢人、禁言、退群等破坏性动作。
- 小号有被 QQ 风控 / 踢下线的风险，与插件无关；建议别用主号当小号。

## 已知限制

1. 破坏性管理动作（踢人、禁言、设管理员、改群名、退群、删群文件、处理申请等）只做了协议级测试，没有在真群里逐个验证，效果取决于 NapCat / QQ，后果自负。
2. 语音、视频、文件**出站**没有真机验证；图片最稳。合并转发出站验证过。
3. NapCat 关闭 `reportSelfMessage` 时，自己发的消息不会以 `message_sent` 事件上报。
4. 群消息撤回窗口是 QQ 服务器的 2 分钟限制，超时撤回会原样报错。
5. 事件默认会投进会话、占用模型回合；嫌吵把 `eventPromptTypes` 置空（事件仍能 `qq_events` 查）。
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

## 开发

```text
lib/index.js              插件入口：校验配置、起网关、注册工具
lib/gateway/gateway.js    核心：反向 WS、队列、投递、回传、状态
lib/gateway/config.js     46 个配置项的声明式 Schema（文档同源）
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

- **离线测试**（不需要真 QQ / Docker）：`npm test`，17 套约 190 条断言；CI 在 Windows + Node 22/24 上自动跑。`*-live.mjs` 系列需要真实 NapCat（环境变量 `QQGW_TOKEN`、`QQGW_BOT` 等），自己按需跑。
- **改代码生效**：插件已被 DSH 加载，改 `lib/` 下的文件后不会自动重载，需要触发插件重载（改 profile patch 触发 `patchReload`，或重启 DSH）。改配置项一般只需重载 patch。
- 提交前跑一遍 `npm test`（`prepublishOnly` 也会跑）。

## License

MIT，见 [LICENSE](./LICENSE)。
