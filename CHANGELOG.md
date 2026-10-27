# Changelog

## 1.0.3 — 2026-10-27

媒体 URL 协议与权限校验（插件收录评审 #99 复核意见）。详见 [docs/M10-媒体URL校验-结论.md](docs/M10-媒体URL校验-结论.md)。

- 媒体段的 `url` 只接受 http/https：`file://`、`data:`、`base64://`、`ftp://`、UNC 等一律拒绝，堵住「非主号用 url 绕过文件发送限制」
- `mface.url`、`share.url` 同规则校验
- `qq_notice` 与 `qq_action` 同权限：写动作只认主号回合；公告图片只收 http(s) URL
- 新增 `test/m10-media-url.mjs`（7 条断言），共 21 套离线套件全绿

## 1.0.2 — 2026-10-26

安全升级（不改消息收发语义）。审计发现、加固清单与残余风险见 [docs/M9-安全升级-结论.md](docs/M9-安全升级-结论.md)。

- 连接层：握手畸形 URL 不再让宿主崩溃；默认拒绝带 Origin 的握手；token 只认 Authorization 头、sha256 常量时间比较、非环回强制 >=32 位；单帧/单消息大小上限；握手 5s / 空闲 120s 超时；同时只保留一条 peer
- 入站层：新增按来源限流 + 阶梯自动禁回、重复内容去重、连发合并（合成一个回合）；事件也要过禁回/限流/去重；好友/加群申请默认不投模型
- 出站层：本机文件出站分级（`fileSendPolicy`，默认只有主号回合可发，UNC 拒绝）；`qq_action` 写/破坏性动作只认主号回合
- 日志默认给 QQ 号/群号/消息 id 打码；状态端点支持 `statusToken`
- 队列：满时主号消息插队并挤掉最旧的非主号消息，主号消息内部顺序不乱
- 新增 14 项配置（共 60 项），默认值即安全侧；`token` 改为必填
- 测试：新增 m9-guard / m9-ws-security / m9-security 三套，共 20 套约 220 条断言
- 文档：新增 SECURITY.md 与 docs/M9-安全升级-结论.md

## 1.0.0 — 2026-10-25

首个公开发布版本（npm：`dsh-qq-gateway@1.0.0`）。

- 反向 WebSocket 接入 NapCat / OneBot 11，QQ 消息投递到指定 DSH 会话并回传回复
- 文字 / 图片 / 合并转发（含转发内图片）收发；Markdown 渲染成图片再发
- 9 个 `qq_*` 模型工具；约 90 个 OneBot 动作目录；事件查询
- 主号 QQ 管理指令：`/allow`、`/deny`、`/list`、`/mute`、`/unmute`、`/help`
- 拟人延迟（幂律 + 指数长尾）与禁回（按时长 / 指定人，状态落盘热加载）
- 掉线自动重连、断线回传缓冲、只读状态端点、Windows 下 Docker Desktop 联动启动
- 数据文件统一落在 `~/.dsh/storages/`，升级不丢
- 离线回归 17 套（约 190 条断言），GitHub Actions 在 Windows + Node 22/24 上跑
