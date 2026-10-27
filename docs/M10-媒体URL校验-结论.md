# M10 媒体 URL 协议与权限校验结论（2026-10-27）

背景：插件收录评审（polang233/dsh-plugin-index #99）复核 1.0.2 后指出：**媒体 url 字段未限制协议，可绕过非主号的文件发送限制**。本里程碑只修这一项，目标是让所有媒体来源走同一套协议 + 权限校验。

## 一、问题

1. `buildSegments` 的 image / record / video / file 段，`url` 分支把字符串原样透传给 NapCat，不校验协议。非主号回合虽然被禁止 `path` / `base64` / `file`，但可以用 `url: "file:///..."`、`data:`、`base64://`、UNC 路径把本机文件塞回发送链路。
2. `mface` 段的 `url`、`share` 段的 `url` 同样原样透传。
3. `qq_notice` 的 `image` 参数直接进 `_send_group_notice`：既没有协议校验，也没有主号回合校验（任何触发会话的人/其他 DSH 会话都能调）。

## 二、修复

1. `lib/gateway/actions.js` 新增 `checkMediaUrl()`：只接受 `http://` / `https://`；拒绝空值、超长（>4096）、空白/控制字符，以及 `file://`、`data:`、`base64://`、`ftp://`、UNC 等。
2. `resolveMediaFile` 的 `url` 分支、`mface.url`、`share.url` 全部走该校验（后者返回明确的字段级报错）。
3. 权限统一：
   - `path` → 仍受 `fileSendPolicy`（main / outbox / all）约束；
   - `base64` / `file` 原始字节 → 仍只允许主号回合或内部渲染；
   - `url` → 任何回合都可用，但必须 http(s)（不读本机文件）；
   - `qq_notice` → 写动作，增加 `highRiskActionsRequireMain` 主号回合校验，`image` 只收 http(s) URL（NapCat 在容器里读不到本机路径）。
4. 测试：新增 `test/m10-media-url.mjs`（7 条断言）。

## 三、验证

- `node test/m10-media-url.mjs`：7/7 通过（10 种非法来源、4 类媒体段、mface/share、qq_notice 权限与协议、qq_action 权限）。
- `npm test`：21 套离线套件全绿（不含真机脚本）。

## 四、残余风险

- URL 目标没有做私网 IP 黑名单（SSRF 面）：入站图片 URL 由 NapCat/QQ 提供，出站 URL 由会话发起者显式给出；后续可按需加域名/IP 策略。
- 本次不改变「主号回合可以发本机文件」这一设计：主号是所有者，且默认可控。
