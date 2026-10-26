// M9 离线安全回归：手写 WS 服务端的握手/帧/超时加固。
// 零依赖，只用 node:net + 手写 HTTP/WS 帧，不需要真 NapCat / Docker / DSH。
// 跑法：node test/m9-ws-security.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { acceptKey, createWsServer, decodeFrames } from '../lib/gateway/ws.js';

const TOKEN = 'm9-secret-token';
const results = [];
const peers = new Set();
const rawSockets = new Set();

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : undefined);
  } catch (err) {
    record(name, false, err?.message ?? String(err));
  }
}

async function waitFor(fn, { timeoutMs = 2000, label = 'condition', intervalMs = 10 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const value = fn();
    if (value) return { value, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout ${timeoutMs}ms waiting for ${label}`);
    await delay(intervalMs);
  }
}

async function startServer(options = {}) {
  const rejects = [];
  const server = createWsServer({
    host: '127.0.0.1',
    port: 0,
    path: '/onebot',
    token: TOKEN,
    onReject: (code, message) => rejects.push({ code, message }),
    onConnection: (peer) => {
      peers.add(peer);
      peer.on('close', () => peers.delete(peer));
    },
    ...options,
  });
  const addr = await server.listen();
  return {
    ...server,
    port: addr.port,
    rejects,
    async stop() {
      for (const peer of peers) {
        try {
          peer.socket.destroy();
        } catch {
          // 已经关了
        }
      }
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        // 注意用底层 http.Server 的 close(cb)：createWsServer 返回的 close 是 Promise 包装，
        // 不接受回调，直接调它会让这里的 finish 永远等不到。
        try {
          server.server.close(finish);
        } catch {
          finish();
        }
        try {
          server.server.closeAllConnections?.();
        } catch {
          // 老版本 Node 没有这个方法
        }
        const timer = setTimeout(finish, 1000);
        timer.unref?.();
      });
      for (const socket of rawSockets) {
        try {
          socket.destroy();
        } catch {
          // 已经关了
        }
      }
      rawSockets.clear();
    },
  };
}

/** 裸 TCP 连接：不做 HTTP 握手，握手超时用例就靠它。 */
async function rawTcp(port) {
  const socket = connect({ host: '127.0.0.1', port });
  rawSockets.add(socket);
  const conn = {
    socket,
    buf: Buffer.alloc(0),
    closed: false,
    error: null,
    head: '',
    status: 0,
    bodyOffset: -1,
    key: '',
  };
  socket.on('data', (chunk) => {
    conn.buf = Buffer.concat([conn.buf, chunk]);
  });
  socket.on('error', (err) => {
    conn.error = err;
  });
  socket.on('close', () => {
    conn.closed = true;
  });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.setNoDelay(true);
  return conn;
}

/** 发一条手写 WS 握手请求，读到 HTTP 响应头为止。 */
async function openRaw(port, { requestLine = 'GET /onebot HTTP/1.1', headers = {} } = {}) {
  const conn = await rawTcp(port);
  const key = randomBytes(16).toString('base64');
  const lines = [
    requestLine,
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  ];
  conn.key = key;
  conn.requestLine = requestLine;
  conn.socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  const { value: head } = await waitFor(() => {
    const idx = conn.buf.indexOf('\r\n\r\n');
    return idx === -1 ? null : conn.buf.subarray(0, idx).toString('latin1');
  }, { timeoutMs: 2000, label: 'HTTP 响应头' });
  conn.head = head;
  conn.status = Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0);
  conn.bodyOffset = conn.buf.indexOf('\r\n\r\n') + 4;
  return conn;
}

function waitClosed(conn, timeoutMs = 2000) {
  return waitFor(() => conn.closed, { timeoutMs, label: '连接关闭' });
}

/** 手写客户端的帧头；masked 时附带 4 字节掩码键（不写 payload）。 */
function frameHeader(len, { fin = true, opcode = 0x1, masked = true } = {}) {
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = (fin ? 0x80 : 0) | opcode;
  if (!masked) return head;
  head[1] |= 0x80;
  return Buffer.concat([head, Buffer.from([0x12, 0x34, 0x56, 0x78])]);
}

/** 从客户端缓冲区里解出服务端发来的帧（跳过 HTTP 响应头）。 */
function framesOf(conn) {
  if (conn.bodyOffset < 0) return [];
  return decodeFrames(conn.buf.subarray(conn.bodyOffset)).frames;
}

console.log('=== M9：握手加固 ===');

await check('畸形请求行 GET http:// → 400，进程不死，随后同一服务仍能正常握手', async () => {
  const s = await startServer({});
  try {
    const bad = await openRaw(s.port, { requestLine: 'GET http:// HTTP/1.1' });
    assert.equal(bad.status, 400, `期望 400，实际 ${bad.status}`);
    await waitClosed(bad, 2000);
    assert.deepEqual(s.rejects.map((r) => r.code), [400], 'onReject 应记录 400');
    const good = await openRaw(s.port, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(good.status, 101, `畸形请求之后正常握手应 101，实际 ${good.status}`);
    assert.equal(/sec-websocket-accept:\s*(\S+)/i.exec(good.head)?.[1], acceptKey(good.key));
    return '400 → 进程存活 → 101';
  } finally {
    await s.stop();
  }
});

await check('带 Origin 头 → 403（默认 allowOrigin=false）', async () => {
  const s = await startServer({});
  try {
    const c = await openRaw(s.port, {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'http://evil.example' },
    });
    assert.equal(c.status, 403, `期望 403，实际 ${c.status}`);
    await waitClosed(c, 2000);
    assert.deepEqual(s.rejects.map((r) => r.code), [403]);
    return '403 + 断开';
  } finally {
    await s.stop();
  }
});

console.log('\n=== M9：token 校验 ===');

await check('token：错误 Bearer → 401、不传 → 401、正确 → 101', async () => {
  const s = await startServer({});
  try {
    const wrong = await openRaw(s.port, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401, `错误 token 期望 401，实际 ${wrong.status}`);
    const none = await openRaw(s.port);
    assert.equal(none.status, 401, `不传 token 期望 401，实际 ${none.status}`);
    const ok = await openRaw(s.port, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 101, `正确 token 期望 101，实际 ${ok.status}`);
    await waitClosed(wrong, 2000);
    await waitClosed(none, 2000);
    assert.deepEqual(s.rejects.map((r) => r.code), [401, 401]);
    return '401 / 401 / 101';
  } finally {
    await s.stop();
  }
});

await check('query token 默认关闭；显式 allowQueryToken=true 才认', async () => {
  const strict = await startServer({});
  try {
    const q1 = await openRaw(strict.port, {
      requestLine: `GET /onebot?access_token=${TOKEN} HTTP/1.1`,
    });
    assert.equal(q1.status, 401, `默认不应认 query token，实际 ${q1.status}`);
    await waitClosed(q1, 2000);
  } finally {
    await strict.stop();
  }
  const loose = await startServer({ allowQueryToken: true });
  try {
    const q2 = await openRaw(loose.port, {
      requestLine: `GET /onebot?access_token=${TOKEN} HTTP/1.1`,
    });
    assert.equal(q2.status, 101, `allowQueryToken=true 应接受 query token，实际 ${q2.status}`);
    return '默认 401，显式开启 101';
  } finally {
    await loose.stop();
  }
});

console.log('\n=== M9：超时 ===');

await check('握手超时：只建 TCP 不发数据，200ms 的服务器 2 秒内关闭', async () => {
  const s = await startServer({ handshakeTimeoutMs: 200 });
  try {
    const c = await rawTcp(s.port);
    const { ms } = await waitClosed(c, 2000);
    assert.ok(ms >= 100, `关闭得太快，不像是 200ms 握手超时（${ms}ms）`);
    assert.ok(ms <= 1900, `超过 2 秒才关闭（${ms}ms）`);
    assert.equal(s.rejects.at(-1)?.code, 408, '应记录 408');
    return `${ms}ms 后关闭`;
  } finally {
    await s.stop();
  }
});

await check('空闲超时：升级成功后静默，300ms 的服务器 1 秒内关闭', async () => {
  const s = await startServer({ idleTimeoutMs: 300 });
  try {
    const c = await openRaw(s.port, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(c.status, 101);
    const { ms } = await waitClosed(c, 1000);
    assert.ok(ms >= 100, `关闭得太快（${ms}ms）`);
    assert.ok(ms <= 950, `1 秒内应关闭（${ms}ms）`);
    return `${ms}ms 后关闭`;
  } finally {
    await s.stop();
  }
});

console.log('\n=== M9：帧上限 ===');

await check('声明 2MB 的帧（maxFrameBytes=1024）→ close 1009 断开，进程存活', async () => {
  const s = await startServer({ maxFrameBytes: 1024 });
  try {
    const c = await openRaw(s.port, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(c.status, 101);
    // 只发帧头（声明 2MB），不真发 2MB：服务端必须在收全 payload 之前就拒绝。
    c.socket.write(frameHeader(2 * 1024 * 1024));
    await waitClosed(c, 2000);
    const close = framesOf(c).find((f) => f.opcode === 0x8);
    assert.ok(close, '应收到服务端的 close 帧');
    assert.equal(close.payload.readUInt16BE(0), 1009, `close code 应为 1009，实际 ${close.payload.readUInt16BE(0)}`);
    const alive = await openRaw(s.port, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(alive.status, 101, '攻击连接关闭后服务应仍可握手');
    return '1009 + 进程存活';
  } finally {
    await s.stop();
  }
});

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
for (const socket of rawSockets) {
  try {
    socket.destroy();
  } catch {
    // 已经关了
  }
}
process.exit(failed.length ? 1 : 0);
