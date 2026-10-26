// M3：只读状态端点（GET /dsh-qq-gateway/status）。
//
// 刻意做成独立的小 HTTP 服务，而不是挂到反向 WS 那个端口上：
//   1) 反向 WS 端口在 M4 要监听 0.0.0.0 给容器连，状态不能跟着暴露出去；
//      statusHost 默认 127.0.0.1，只有本机能看到。
//   2) 只读到底：只认 GET/HEAD，不解析请求体，没有任何写入口。
// 零依赖，只用 node:http。
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

/** 常量时间比较两个 token（先各自 sha256，长度差异不提前返回）。 */
function sameToken(given, expected) {
  const a = createHash('sha256').update(String(given ?? '')).digest();
  const b = createHash('sha256').update(String(expected ?? '')).digest();
  return timingSafeEqual(a, b);
}

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function send(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...HEADERS,
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

/**
 * @param {object} options
 * @param {string} options.host - 监听地址（默认 127.0.0.1）
 * @param {number} options.port - 监听端口，0 表示系统分配
 * @param {string} options.path - 端点路径，必须完全匹配
 * @param {() => object} options.snapshot - 每次请求现取状态（拿到的永远是最新计数）
 * @param {string} [options.token] - 非空时要求 Authorization: Bearer <token>（非环回监听必须配）
 * @param {(message: string) => void} [options.log]
 */
export function createStatusServer({ host = '127.0.0.1', port = 8793, path = '/dsh-qq-gateway/status', snapshot, token = '', log = () => {} } = {}) {
  if (typeof snapshot !== 'function') throw new Error('createStatusServer: snapshot must be a function');

  const server = createServer((req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`).pathname;
    } catch {
      pathname = '/';
    }
    if (pathname !== path) {
      send(res, 404, { error: 'not_found', path: pathname, endpoint: path });
      return;
    }
    if (token) {
      const auth = String(req.headers.authorization ?? '');
      const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1] ?? '';
      if (!sameToken(bearer, token)) {
        send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
        return;
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, { error: 'method_not_allowed', method: String(req.method), allow: 'GET, HEAD' }, { allow: 'GET, HEAD' });
      return;
    }
    let body;
    try {
      body = snapshot();
    } catch (err) {
      log(`status snapshot failed: ${err?.message ?? String(err)}`);
      send(res, 500, { error: 'snapshot_failed', message: String(err?.message ?? err) });
      return;
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, HEADERS);
      res.end();
      return;
    }
    send(res, 200, body);
  });

  server.on('clientError', (err, socket) => {
    // 只读端点：收到坏请求直接断开，不写任何业务数据
    if (err?.code === 'ECONNRESET' || !socket.writable) return;
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    } catch {
      socket.destroy();
    }
  });

  return {
    server,
    path,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(server.address()));
    }),
    address: () => server.address(),
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
