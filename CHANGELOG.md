# Changelog

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
