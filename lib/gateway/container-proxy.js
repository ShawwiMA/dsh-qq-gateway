/**
 * M6.2：容器网络小代理（给 Docker Desktop 的「手动代理」当活靶子）。
 *
 * 背景（2026-10-17 实测）：
 *   本机 Docker Desktop 配了手动 HTTP/HTTPS 代理 http://127.0.0.1:7892，但 7892 上
 *   并没有代理程序在跑。Docker Desktop 会把容器出网的 80/443 转给这个死地址，于是
 *   容器里所有 HTTP(S) 都失败（curl 报 TLS EOF），NapCat 走 WebApi 的功能全部报
 *   「Client network socket disconnected before secure TLS connection was established」：
 *     - _send_group_notice 群公告
 *     - _get_group_notice / _del_group_notice
 *     - get_essence_msg_list 群精华
 *     - get_group_honor_info 群荣誉
 *   而 QQ 本身的消息收发走的是 NT 协议，不受影响，所以“只有这些功能坏”。
 *
 * 本模块在宿主 127.0.0.1:7892 起一个最小直连代理（HTTP 转发 + CONNECT 隧道），
 * 让 Docker 的代理设置有个活的目标。它是纯旁路：
 *   - 只监听 127.0.0.1（不是 0.0.0.0）；
 *   - 只做 TCP 转发，不解析、不记录请求内容；
 *   - 配置 containerProxyPort=0 可完全关闭；
 *   - 端口被占（比如用户真的开了自己的代理）时返回 ok:false，网关只降级记日志。
 *
 * 根治办法仍是改 Docker Desktop 代理设置（关掉手动代理），本代理是“不重启 Docker
 * 也能用”的兼容方案。
 */
import http from 'node:http';
import net from 'node:net';

const MAX_HEADER_BYTES = 64 * 1024;

/**
 * 创建一个直连代理实例（不调用 listen 就不占端口）。
 *
 * @param {object} [options]
 * @param {number} [options.port=7892] - 监听端口（要和 Docker Desktop 代理设置一致）
 * @param {string} [options.host='127.0.0.1'] - 监听地址，默认只本机
 * @param {(message: string) => void} [options.log] - 日志
 * @param {number} [options.timeoutMs=20000] - 单连接空闲超时
 */
export function createContainerProxy({ port = 7892, host = '127.0.0.1', log = () => {}, timeoutMs = 20000 } = {}) {
  const boundPort = Number.isFinite(port) && port >= 0 ? Math.floor(port) : 7892;
  const bindHost = typeof host === 'string' && host ? host : '127.0.0.1';
  const idleTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000;
  const stats = {
    httpRequests: 0,
    tunnels: 0,
    errors: 0,
    bytesUp: 0,
    bytesDown: 0,
  };
  let server = null;
  let actualPort = null;
  let lastError = null;

  function safeLog(message) {
    try {
      log(message);
    } catch {
      // 日志失败不影响代理
    }
  }

  /** 普通 HTTP 转发：请求行是绝对 URI（http://host/path）时直接发给目标。 */
  function handleHttp(req, res) {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      stats.errors += 1;
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('container-proxy: bad request url');
      return;
    }
    if (target.protocol !== 'http:') {
      stats.errors += 1;
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('container-proxy: only http:// absolute-form is supported');
      return;
    }
    stats.httpRequests += 1;
    const upstream = http.request({
      host: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: req.headers,
      timeout: idleTimeoutMs,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.on('data', (chunk) => {
        stats.bytesDown += chunk.length;
      });
      upstreamRes.pipe(res);
    });
    upstream.on('timeout', () => {
      stats.errors += 1;
      upstream.destroy(new Error('upstream timeout'));
    });
    upstream.on('error', (err) => {
      stats.errors += 1;
      lastError = err.message;
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`container-proxy: upstream error: ${err.message}`);
      } else {
        res.destroy();
      }
    });
    req.on('data', (chunk) => {
      stats.bytesUp += chunk.length;
    });
    req.pipe(upstream);
  }

  /** CONNECT 隧道：HTTPS 就是走这条。 */
  function handleConnect(req, clientSocket, head) {
    const [rawHost, rawPort] = String(req.url).split(':');
    const targetHost = rawHost || '';
    const targetPort = Number(rawPort) || 443;
    if (!targetHost) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    stats.tunnels += 1;
    const upstream = net.connect(targetPort, targetHost, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) {
        stats.bytesUp += head.length;
        upstream.write(head);
      }
      upstream.on('data', (chunk) => {
        stats.bytesDown += chunk.length;
      });
      clientSocket.on('data', (chunk) => {
        stats.bytesUp += chunk.length;
      });
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.setTimeout(idleTimeoutMs, () => {
      stats.errors += 1;
      upstream.destroy(new Error('tunnel timeout'));
    });
    upstream.on('error', (err) => {
      stats.errors += 1;
      lastError = err.message;
      if (!clientSocket.destroyed) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
    });
    clientSocket.on('error', () => upstream.destroy());
  }

  /** 开始监听：成功 {ok:true,host,port}，失败 {ok:false,error}（端口被占很常见，不抛）。 */
  function listen() {
    if (server) return Promise.resolve({ ok: true, host: bindHost, port: actualPort });
    return new Promise((resolve) => {
      const instance = http.createServer((req, res) => handleHttp(req, res));
      instance.on('connect', (req, socket, head) => handleConnect(req, socket, head));
      instance.on('clientError', (_err, socket) => {
        stats.errors += 1;
        try {
          socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        } catch {
          // 已断开就算了
        }
      });
      instance.once('error', (err) => {
        stats.errors += 1;
        lastError = err?.message ?? String(err);
        resolve({ ok: false, error: lastError });
      });
      instance.listen(boundPort, bindHost, () => {
        server = instance;
        const address = instance.address();
        actualPort = address && typeof address === 'object' ? address.port : boundPort;
        safeLog(`container-proxy listening on ${bindHost}:${actualPort} (Docker Desktop 代理设置的目标)`);
        resolve({ ok: true, host: bindHost, port: actualPort });
      });
    });
  }

  /** 停止监听（可重复调用）。 */
  function close() {
    return new Promise((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      const closing = server;
      server = null;
      actualPort = null;
      try {
        closing.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  /** 给状态端点/自检看的快照。 */
  function status() {
    return {
      // port=0 是"系统分配端口"（测试用），只要在监听就算启用
      enabled: boundPort > 0 || Boolean(server),
      host: bindHost,
      port: actualPort ?? (boundPort || null),
      listening: Boolean(server),
      lastError,
      stats: { ...stats },
    };
  }

  return { listen, close, status, stats };
}

export { MAX_HEADER_BYTES };
