// M6.2 验收：容器网络直连代理（HTTP 转发 + CONNECT 隧道 + 端口占用降级）。
// 不碰 Docker、不碰外网：目标服务都在本机临时端口上。
// 跑法：node ~/.dsh/bundles/dsh-qq-gateway/test/container-proxy-check.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { createContainerProxy } from '../lib/gateway/container-proxy.js';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : undefined);
  } catch (err) {
    record(name, false, err.message);
  }
}

/** 起一个本机 HTTP 目标服务，返回 {port, close}。 */
function startHttpTarget() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`pong:${req.url}`);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** 起一个本机 TCP echo 服务（给 CONNECT 隧道用），返回 {port, close}。 */
function startTcpEcho() {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('data', (chunk) => socket.write(chunk));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

/** 通过代理发一个 HTTP 请求（绝对 URI 形式）。 */
function httpViaProxy(proxyPort, targetUrl) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: targetUrl,
      headers: { host: new URL(targetUrl).host },
      timeout: 5000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('proxy request timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** 通过代理开一个 CONNECT 隧道并做 echo 往返。 */
function tunnelEcho(proxyPort, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1');
    let buffer = '';
    let established = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('tunnel timeout'));
    }, 5000);
    socket.on('connect', () => {
      socket.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      if (!established) {
        buffer += chunk.toString('utf8');
        const split = buffer.indexOf('\r\n\r\n');
        if (split === -1) return;
        const head = buffer.slice(0, split);
        assert.match(head, /200 Connection Established/i, `CONNECT 应返回 200，实际：${head}`);
        established = true;
        socket.write('ping-through-tunnel');
        return;
      }
      const text = chunk.toString('utf8');
      if (text.includes('ping-through-tunnel')) {
        clearTimeout(timer);
        socket.destroy();
        resolve('tunnel echo ok');
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

console.log('=== M6.2：容器网络直连代理 ===');

const target = await startHttpTarget();
const echo = await startTcpEcho();
const proxy = createContainerProxy({ port: 0, host: '127.0.0.1', timeoutMs: 4000 });
const started = await proxy.listen();
assert.equal(started.ok, true, `代理应能监听：${started.error}`);
const proxyPort = proxy.status().port;

try {
  await check('HTTP 转发：绝对 URI 请求转发到目标并回传正文', async () => {
    const res = await httpViaProxy(proxyPort, `http://127.0.0.1:${target.port}/hello`);
    assert.equal(res.status, 200);
    assert.equal(res.body, 'pong:/hello');
    assert.ok(proxy.status().stats.httpRequests >= 1);
    return `${res.status} ${res.body}`;
  });

  await check('CONNECT 隧道：HTTPS 用的 TCP 隧道能双向透传', async () => {
    const detail = await tunnelEcho(proxyPort, echo.port);
    assert.ok(proxy.status().stats.tunnels >= 1);
    return detail;
  });

  await check('目标不可达：返回 502 且不崩、错误计入 stats.errors', async () => {
    const before = proxy.status().stats.errors;
    const res = await httpViaProxy(proxyPort, 'http://127.0.0.1:1/nope').catch((err) => ({ status: 0, body: err.message }));
    // 端口 1 连不上，expect 502 或连接被代理关闭
    assert.ok(res.status === 502 || res.status === 0, `应失败，实际 ${JSON.stringify(res)}`);
    assert.ok(proxy.status().stats.errors > before);
    return res.status === 502 ? '502' : 'proxy socket closed';
  });

  await check('status()/close() 形状正确，close 后端口释放', async () => {
    const snapshot = proxy.status();
    assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.listening, true);
    assert.equal(typeof snapshot.stats.httpRequests, 'number');
    await proxy.close();
    assert.equal(proxy.status().listening, false);
    const second = createContainerProxy({ port: proxyPort, host: '127.0.0.1' });
    const again = await second.listen();
    assert.equal(again.ok, true, `端口释放后应能重新监听：${again.error}`);
    await second.close();
    return 'close + 重新监听 ok';
  });

  await check('端口被占用：listen 返回 ok:false 而不是抛异常（用户真开了代理时的降级）', async () => {
    const first = createContainerProxy({ port: 0, host: '127.0.0.1' });
    const firstStarted = await first.listen();
    assert.equal(firstStarted.ok, true);
    const samePort = first.status().port;
    const second = createContainerProxy({ port: samePort, host: '127.0.0.1' });
    const result = await second.listen();
    assert.equal(result.ok, false);
    assert.match(result.error, /EADDRINUSE|address already in use/i);
    await first.close();
    await second.close();
    return result.error;
  });
} finally {
  await proxy.close();
  await target.close();
  await echo.close();
}

await delay(10);
console.log('\n=== 汇总 ===');
const passed = results.filter((item) => item.ok).length;
const failed = results.length - passed;
console.log(`${failed === 0 ? 'PASS' : 'FAIL'} ${passed} / ${results.length}`);
process.exit(failed === 0 ? 0 : 1);
