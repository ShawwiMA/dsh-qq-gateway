// 最小 RFC6455 实现：握手 + 分帧。零依赖，服务端/客户端共用。
// 只实现 OneBot 反向 WS 用得到的部分：text 帧、ping/pong、close、分片重组。
// 不实现 permessage-deflate（不宣告即不会协商），不做 TLS（只监听 127.0.0.1）。
// M9 安全加固：握手/空闲超时、帧与消息上限、Origin/query token 收紧、token 常量时间比较。
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { connect as netConnect } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_FRAME_BYTES = 1048576;
const DEFAULT_MAX_MESSAGE_BYTES = 4194304;

export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

export function encodeFrame(payload, { opcode = 0x1, mask = false } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  if (!mask) return Buffer.concat([header, data]);
  header[1] |= 0x80;
  const key = randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) masked[i] = data[i] ^ key[i % 4];
  return Buffer.concat([header, key, masked]);
}

/**
 * 从缓冲区里解帧。
 * maxFrameBytes > 0 时，帧头一声明超限就返回 error（不必等 payload 收全），
 * 让 WsPeer 立刻 1009 断开 —— 恶意客户端声明 2GB 也不会先把数据缓冲进内存。
 */
export function decodeFrames(buf, { maxFrameBytes = 0 } = {}) {
  const frames = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (p + 2 > buf.length) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (p + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    if (maxFrameBytes > 0 && len > maxFrameBytes) {
      return {
        frames,
        rest: buf.subarray(off),
        error: { code: 1009, message: `frame too large: ${len} > ${maxFrameBytes}` },
      };
    }
    let maskKey = null;
    if (masked) {
      if (p + 4 > buf.length) break;
      maskKey = buf.subarray(p, p + 4);
      p += 4;
    }
    if (p + len > buf.length) break;
    let payload = buf.subarray(p, p + len);
    if (masked) {
      const copy = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i += 1) copy[i] = payload[i] ^ maskKey[i % 4];
      payload = copy;
    }
    frames.push({ fin, opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/** 定长摘要后再比较：提前 return 长度差异会泄露 token 长度。 */
function tokenEquals(expected, provided) {
  const a = createHash('sha256').update(String(expected)).digest();
  const b = createHash('sha256').update(String(provided)).digest();
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** 一条 WS 连接。事件：text / close / error。 */
export class WsPeer {
  #onData;

  #onFrame;

  #raw;

  #destroyed = false;

  constructor(socket, {
    isClient = false,
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
    maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  } = {}) {
    this.socket = socket;
    this.isClient = isClient;
    this.maxFrameBytes = maxFrameBytes > 0 ? maxFrameBytes : 0;
    this.maxMessageBytes = maxMessageBytes > 0 ? maxMessageBytes : 0;
    this.closed = false;
    this.notified = false;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.handlers = { text: [], close: [], error: [] };
    this.#onData = (chunk) => this.feed(chunk);
    this.#onFrame = (f) => this.handleFrame(f);
    this.#raw = (buf) => {
      if (this.closed) return;
      try {
        socket.write(buf);
      } catch (err) {
        this.emit('error', err);
      }
    };
    socket.on('data', this.#onData);
    socket.on('error', (err) => {
      this.closed = true;
      this.emit('error', err);
    });
    // HTTP upgrade 出来的 socket 是半开模式：对端发完 FIN 只触发 'end'，不会自动关写侧，
    // 于是 'close' 永远不来，网关 peers 里就会留下永远删不掉的僵尸连接（实测复现）。
    // WebSocket 没有半开语义，收到 'end' 就立刻把写侧也关掉；同时先把 closed 置 true，
    // 让 deliver() 立刻跳过这条连接，不再往死 socket 里写。
    socket.on('end', () => {
      if (this.notified) return;
      this.closed = true;
      try {
        socket.end();
      } catch {
        // 对端已经没了就算了
      }
    });
    // 静默断网（没 FIN）靠 TCP keepalive 兜底：默认 60s 空闲开始探测，探测失败会触发 'error'/'close'。
    try {
      socket.setKeepAlive(true, 60000);
    } catch {
      // 某些平台不支持就算了
    }
    // 本端主动 close() 会先把 closed 置 true，但底层 socket 真关掉时 'close' 事件必须照发，
    // 否则上层（网关的 peers 集合）会一直留着已经死掉的连接 —— M2 断线用例踩到的就是这个。
    socket.on('close', () => {
      if (this.notified) return;
      this.notified = true;
      this.closed = true;
      this.emit('close', {});
    });
  }

  on(ev, fn) {
    (this.handlers[ev] ??= []).push(fn);
    return this;
  }

  emit(ev, arg) {
    for (const fn of this.handlers[ev] ?? []) {
      try {
        fn(arg);
      } catch {
        // 监听器抛错不能连累连接
      }
    }
  }

  /** 兜底销毁；重复调用不会二次 destroy。 */
  #destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    try {
      this.socket.destroy();
    } catch {
      // 已经没了就算了
    }
  }

  feed(chunk) {
    if (this.closed) return;
    this.buf = Buffer.concat([this.buf, chunk]);
    const { frames, rest, error } = decodeFrames(this.buf, { maxFrameBytes: this.maxFrameBytes });
    this.buf = rest;
    for (const f of frames) {
      if (this.closed) break;
      this.#onFrame(f);
    }
    if (error && !this.closed) {
      this.buf = Buffer.alloc(0);
      this.fail(error.code ?? 1009);
    }
  }

  handleFrame(f) {
    if (f.opcode === 0x8) {
      this.close(1000);
      return;
    }
    if (f.opcode === 0x9) {
      this.#raw(encodeFrame(f.payload, { opcode: 0xa, mask: this.isClient }));
      return;
    }
    if (f.opcode === 0xa) return;
    if (f.opcode === 0x0) {
      if (!this.frag) return;
      if (this.maxMessageBytes > 0 && this.frag.length + f.payload.length > this.maxMessageBytes) {
        this.fail(1009);
        return;
      }
      this.frag = Buffer.concat([this.frag, f.payload]);
      if (f.fin) {
        const whole = this.frag;
        this.frag = null;
        this.emit('text', whole.toString('utf8'));
      }
      return;
    }
    if (f.opcode === 0x1 || f.opcode === 0x2) {
      if (this.maxMessageBytes > 0 && f.payload.length > this.maxMessageBytes) {
        this.fail(1009);
        return;
      }
      if (f.fin) {
        this.emit('text', f.payload.toString('utf8'));
        return;
      }
      this.frag = f.payload;
    }
  }

  send(text) {
    this.#raw(encodeFrame(text, { opcode: 0x1, mask: this.isClient }));
  }

  close(code = 1000) {
    if (this.closed) return;
    this.closed = true;
    try {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(code, 0);
      this.socket.write(encodeFrame(b, { opcode: 0x8, mask: this.isClient }));
    } catch {
      // 对端已经没了就算了
    }
    try {
      this.socket.end();
    } catch {
      // 同上
    }
  }

  /**
   * 超限/协议错误：先把 close 帧尽量刷出去（直接 destroy 会丢缓冲里的 close 帧），
   * 再兜底 destroy。重复调用安全。
   */
  fail(code = 1009) {
    if (this.closed) {
      this.#destroy();
      return;
    }
    this.closed = true;
    let wrote = false;
    try {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(code, 0);
      this.socket.end(encodeFrame(b, { opcode: 0x8, mask: this.isClient }));
      wrote = true;
    } catch {
      // 写不进去就直接销毁
    }
    if (!wrote) {
      this.#destroy();
      return;
    }
    // end() 负责冲刷 close 帧；对端不读时靠这个定时器真正销毁，避免半开残留。
    // unref：这个兜底计时器不该拖住宿主/测试进程退出。
    const timer = setTimeout(() => this.#destroy(), 250);
    timer.unref?.();
  }
}

function reject(socket, code, message, onReject) {
  if (!socket.destroyed) {
    try {
      socket.write(
        `HTTP/1.1 ${code} ${message}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
      );
    } catch {
      // 写不进去直接销毁
    }
  }
  try {
    onReject?.(code, message);
  } catch {
    // 统计回调抛错不能影响拒绝本身
  }
  try {
    socket.destroy();
  } catch {
    // 已经关闭就算了
  }
}

/**
 * 反向 WS 服务端：NapCat 主动连过来。
 * token 可以是字符串，也可以是 getter —— getter 让网关能在运行时轮换 token（M2），握手时现取。
 *
 * 安全参数（都可选，均有默认值）：
 * - handshakeTimeoutMs：TCP 连上后多久没升级成 WS 就 408 断开。
 * - idleTimeoutMs：升级成功后多久没有任何收发就断开；0 = 关闭空闲超时。
 * - maxFrameBytes：单帧 payload 上限，超限 close 1009 后断开。
 * - maxMessageBytes：分片累计消息上限，超限 close 1009 后断开。
 * - allowQueryToken：是否允许 URL ?access_token= 兜底（默认 false，只认 Authorization 头）。
 * - allowOrigin：是否接受带 Origin 的请求（默认 false；浏览器必带，NapCat 不带）。
 */
export function createWsServer({
  host = '127.0.0.1',
  port = 0,
  path = '/onebot',
  token = '',
  onConnection,
  onReject,
  handshakeTimeoutMs = 5000,
  idleTimeoutMs = 120000,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  allowQueryToken = false,
  allowOrigin = false,
} = {}) {
  const server = createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh-qq-gateway: websocket endpoint only\n');
  });

  // 每条裸连接的握手/升级状态。WeakMap 不持有 socket，连接没了就自动回收。
  const socketStates = new WeakMap();

  server.on('connection', (socket) => {
    const state = { upgraded: false, rejected: false };
    socketStates.set(socket, state);
    // 每个 socket 都必须有 error 监听：NapCat 异常断线时的 ECONNRESET 若无人接管,
    // 会升级成 uncaughtException 把宿主进程直接带走。
    socket.on('error', () => {});
    socket.on('timeout', () => {
      if (state.rejected) return;
      if (!state.upgraded) {
        // 只建 TCP 不写 HTTP 的慢速握手（探活/攻击都会撞上）。
        state.rejected = true;
        reject(socket, 408, 'handshake timeout', onReject);
        return;
      }
      // 升级成功后这里就是空闲超时：socket.setTimeout 会在每次收/发时自动重置。
      try {
        socket.destroy();
      } catch {
        // 已经没了
      }
    });
    if (handshakeTimeoutMs > 0) socket.setTimeout(handshakeTimeoutMs);
  });

  server.on('upgrade', (req, socket, head) => {
    const state = socketStates.get(socket) ?? { upgraded: false, rejected: false };
    try {
      if (state.rejected) return;
      // req.url 是客户端给的任意字符串（绝对形式、坏端口等），URL 构造会抛 ERR_INVALID_URL。
      // 以前没包 try/catch，`GET http://` 就能让异常冒到事件循环、整个进程退出（实测）。
      let url;
      try {
        url = new URL(req.url ?? '/', 'http://127.0.0.1');
      } catch {
        state.rejected = true;
        reject(socket, 400, 'bad request url', onReject);
        return;
      }
      // 浏览器一定会带 Origin；NapCat 不带。默认拒绝跨站来源，挡掉网页里的跨站 WS 连接。
      if (!allowOrigin && req.headers.origin !== undefined) {
        state.rejected = true;
        reject(socket, 403, 'origin not allowed', onReject);
        return;
      }
      if (path && url.pathname !== path) {
        state.rejected = true;
        reject(socket, 404, 'not found', onReject);
        return;
      }
      const expected = typeof token === 'function' ? token() : token;
      const auth = String(req.headers.authorization ?? '');
      const fromHeader = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
      const bearer = fromHeader
        ?? (allowQueryToken ? url.searchParams.get('access_token') : null)
        ?? '';
      // expected 为空 = 跳过校验（是否强制非空由上层决定，M2 的空 token 行为保持不变）。
      if (expected && !tokenEquals(expected, bearer)) {
        state.rejected = true;
        reject(socket, 401, 'unauthorized', onReject);
        return;
      }
      const key = req.headers['sec-websocket-key'];
      if (!key) {
        state.rejected = true;
        reject(socket, 400, 'missing Sec-WebSocket-Key', onReject);
        return;
      }
      // 升级成功：把握手超时换成空闲超时（0 = 不设空闲超时）。
      state.upgraded = true;
      socket.setTimeout(idleTimeoutMs > 0 ? idleTimeoutMs : 0);
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
          + 'Upgrade: websocket\r\n'
          + 'Connection: Upgrade\r\n'
          + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
      );
      const peer = new WsPeer(socket, { isClient: false, maxFrameBytes, maxMessageBytes });
      if (head && head.length) peer.feed(head);
      try {
        onConnection?.(peer, { url, token: bearer });
      } catch {
        // 回调抛错时 101 已经发出去了，没法再回 HTTP 错误，只能拆掉这条连接。
        peer.close(1011);
      }
    } catch {
      // 整个 upgrade 回调体兜底：任何异常都不能冒到事件循环。
      state.rejected = true;
      if (state.upgraded) {
        try {
          socket.destroy();
        } catch {
          // 已经关了
        }
      } else {
        reject(socket, 400, 'bad request', onReject);
      }
    }
  });

  return {
    server,
    listen: () => new Promise((resolve, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(port, host, () => resolve(server.address()));
    }),
    address: () => server.address(),
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

/** WS 客户端：测试里假冒 NapCat。 */
export function connectWs(url, { headers = {}, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, rejectPromise) => {
    const u = new URL(url);
    const socket = netConnect({ host: u.hostname, port: Number(u.port || 80) });
    const key = randomBytes(16).toString('base64');
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      rejectPromise(err);
    };
    const timer = setTimeout(() => fail(new Error(`ws connect timeout after ${timeoutMs}ms`)), timeoutMs);
    socket.on('error', fail);
    socket.on('connect', () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      socket.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n`
          + `Host: ${u.host}\r\n`
          + 'Upgrade: websocket\r\n'
          + 'Connection: Upgrade\r\n'
          + `Sec-WebSocket-Key: ${key}\r\n`
          + 'Sec-WebSocket-Version: 13\r\n'
          + extra
          + '\r\n',
      );
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      socket.off('data', onData);
      clearTimeout(timer);
      const head = buf.subarray(0, idx).toString('utf8');
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0);
      if (status !== 101) {
        socket.destroy();
        settled = true;
        rejectPromise(new Error(`handshake failed: ${head.split('\r\n')[0]}`));
        return;
      }
      const got = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
      if (got !== acceptKey(key)) {
        socket.destroy();
        settled = true;
        rejectPromise(new Error('bad Sec-WebSocket-Accept'));
        return;
      }
      const peer = new WsPeer(socket, { isClient: true });
      const restBytes = buf.subarray(idx + 4);
      settled = true;
      resolve(peer);
      // 握手响应后面可能紧跟同一批到达的数据帧（服务端一连上就发东西时很常见）。
      // 必须等调用方挂好监听器再喂：WsPeer.emit 对没人监听的事件是直接丢的。
      // M2 断线补发用例踩到的就是这个 —— 补发的回传和 101 响应挤在同一个 TCP 段里。
      if (restBytes.length) queueMicrotask(() => peer.feed(restBytes));
    };
    socket.on('data', onData);
  });
}
