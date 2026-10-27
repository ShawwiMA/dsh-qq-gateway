# M11 媒体 URL SSRF 校验结论（2026-10-27，评审第二轮）

背景：评审 #99 第二轮指出：**非主号发送的 HTTP 媒体地址仍可指向协议端（NapCat 容器）的本机或内网服务**，要求限制这些地址及重定向目标。

## 一、问题

1. `buildSegments` 只做了协议白名单（1.0.3），没有校验目标地址：`http://127.0.0.1:6099/`、`http://192.168.x.x/`、`http://host.docker.internal:8792/` 会被原样交给 NapCat，由容器替发送者去访问。
2. `mface.url` 同理（远程表情 URL 由 NapCat 下载）。
3. 重定向：URL 指向公网但 30x 跳到内网时，协议端会照跳，网关看不到。
4. 入站图片 URL 下载（宿主侧）也没有目标地址校验，伪造帧可借它探测内网。

## 二、修复（1.0.4）

1. 新增 `lib/gateway/url-guard.js`：
   - `isPrivateIp()`：IPv4/IPv6 回环、私网、链路本地、CGNAT(100.64/10)、组播、保留段、IPv4-mapped 等全判私；
   - `hostLooksLocal()`：`localhost`、`*.local`、`*.internal`、`*.lan`、`host.docker.internal`、单标签主机名等；
   - `assertSafeUrl()`：协议 + 主机名 + DNS 解析结果校验（域名解析到内网/混合结果也拒）；
   - `safeFetchMedia()`：自己下载，**逐跳**校验 30x 目标（最多 3 跳），Content-Length / 实际字节双限，超时。
2. 出站（`gateway.sendMessage` 新增 `sanitizeOutboundParts()`）：
   - 所有媒体段 URL 先过 `assertSafeUrl`；
   - **非主号回合**：网关自己用 `safeFetchMedia` 下载 → 转 base64（`Symbol` 受信标记）再交给 NapCat，协议端不再替外部用户访问任何地址；语音/视频/文件 URL 直接拒绝（只允许图片）。
   - 主号回合保留 URL 直传（仍校验协议与目标地址；重定向由协议端处理，属所有者可控范围）。
   - `qq_notice` 图片走 `gateway.assertSafeMediaUrl()` 同一套校验。
3. 入站（`media.js`）：图片 URL 下载改用 `safeFetchMedia`，逐跳校验 + 大小上限，默认拒私网（`mediaUrlAllowPrivate` 可显式放开，仅调试）。
4. 新增配置 `mediaUrlAllowPrivate`（默认 `false`，共 61 项）。
5. 新增 `test/m11-media-ssrf.mjs`（8 条断言），覆盖 IP/主机名/DNS/重定向/大小/跳数/受信标记/网关集成。

## 三、验证

- `node test/m11-media-ssrf.mjs`：8/8 通过；
- `npm test`：22 套离线套件全绿（真实图片链路回归同步调整测试域名与注入解析器）。

## 四、残余风险

- DNS rebinding（校验用一次解析、实际下载再解析）无法在 Node fetch 里彻底消除；如需更强隔离，建议给 NapCat 容器加网络策略/代理白名单。
- 主号回合的 URL 直传仍由 NapCat 下载，重定向目标不受网关校验（主号是所有者，属可控范围）；要完全封闭可把 `fileSendPolicy` 设为最严并只允许 outbox。
