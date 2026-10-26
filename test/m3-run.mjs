// M3 离线验收：配置 Schema（严格校验 + 默认值）和只读状态端点。
// 覆盖：默认值、未知字段拒绝、类型/范围/枚举报错、数字字符串、token 不回显、
//       GET/HEAD 200、非 GET 405、错路径 404、计数实时性、端口冲突降级、关闭后端口释放。
// 跑法：node ~/.dsh/bundles/dsh-qq-gateway/test/m3-run.mjs
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { createFakeDsh } from './fake-dsh.mjs';
import { connectFakeNapCat } from './fake-napcat.mjs';
import {
  CONFIG_FIELDS,
  CONFIG_KEYS,
  ConfigError,
  configSchema,
  createGateway,
  defaultConfig,
  normalizeConfig,
  publicConfig,
} from '../lib/gateway/gateway.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const MAIN_QQ = 10001;
const BOT_QQ = 10002;
const TOKEN = 'm3-test-token';
const PATH = '/onebot';
const SESSION = 'session-fake-target';
const STATUS_PATH = '/dsh-qq-gateway/status';

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

async function waitFor(fn, { timeoutMs = 4000, label = 'condition', intervalMs = 5 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const value = fn();
    if (value) return { value, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout ${timeoutMs}ms waiting for ${label}`);
    await delay(intervalMs);
  }
}

/** 发一个裸 HTTP 请求，返回状态码/头/文本；用于打状态端点。 */
function httpReq(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

const cfgBase = {
  // 拟人延迟会拖慢回传，回归用例只验机制不验时延 → 一律关掉（时延本身由 human-delay-check.mjs 覆盖）
  replyDelayMode: 'off',
  host: '127.0.0.1',
  port: 0,
  path: PATH,
  token: TOKEN,
  mainQQ: MAIN_QQ,
  botQQ: BOT_QQ,
  sessionId: SESSION,
  maxQueue: 8,
  turnTimeoutMs: 5000,
  ridTtlMs: 30 * 60 * 1000,
  statusPort: 0,
};

async function boot({ config = {} } = {}) {
  const fake = createFakeDsh({ sessionId: SESSION });
  fake.emitSeed();
  const logs = [];
  const gw = createGateway({ ctx: fake.ctx, config: { ...cfgBase, ...config }, logger: (m) => logs.push(m) });
  await gw.start();
  const env = {
    fake,
    gw,
    logs,
    url: `ws://127.0.0.1:${gw.port()}${PATH}`,
    async connect() {
      const nc = await connectFakeNapCat({ url: env.url, token: gw.config.token, botQQ: BOT_QQ, mainQQ: MAIN_QQ });
      await waitFor(() => gw.status().peers >= 1, { label: 'peer registered' });
      return nc;
    },
    async answer(index, replyText) {
      const call = env.fake.calls.prompt[index];
      const turn = env.fake.startTurnFor(call.requestId, { replyText, stepMs: 5 });
      await turn.done;
      return turn;
    },
    async close() {
      await gw.stop();
    },
  };
  return env;
}

console.log('=== M3：配置 Schema（纯逻辑） ===');

await check('Schema：全部字段都有默认值，CONFIG_KEYS 与字段表一致', () => {
  const cfg = normalizeConfig({});
  assert.equal(CONFIG_FIELDS.length, 60);
  assert.deepEqual(CONFIG_KEYS, CONFIG_FIELDS.map((f) => f.key));
  assert.equal(CONFIG_KEYS.length, 60);
  assert.deepEqual(cfg, defaultConfig());
  assert.equal(cfg.port, 8792);
  assert.equal(cfg.statusPort, 8793);
  assert.equal(cfg.statusPath, STATUS_PATH);
  assert.equal(cfg.statusEnabled, true);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.statusHost, '127.0.0.1');
  return `fields=${CONFIG_KEYS.length}`;
});

await check('Schema：configSchema 是只读副本，改它不影响字段表', () => {
  const schema = configSchema();
  assert.equal(schema.length, CONFIG_FIELDS.length);
  schema[0].default = 'tampered';
  assert.notEqual(CONFIG_FIELDS[0].default, 'tampered');
  assert.ok(CONFIG_FIELDS.every((f) => typeof f.desc === 'string' && f.desc.length > 0), '每个字段都要有说明');
  return 'desc 齐全';
});

await check('Schema：未知字段直接报错，不静默忽略', () => {
  assert.throws(
    () => normalizeConfig({ turnTimeout: 1000 }),
    (err) => err instanceof ConfigError && /unknown key/.test(err.message) && /turnTimeout/.test(err.message) && /turnTimeoutMs/.test(err.message),
  );
  return '未知键被点名';
});

await check('Schema：类型/范围/枚举/路径 报错都指名到字段', () => {
  assert.throws(() => normalizeConfig({ maxQueue: 'abc' }), /maxQueue must be a number/);
  assert.throws(() => normalizeConfig({ maxQueue: 0 }), /maxQueue must be >= 1/);
  assert.throws(() => normalizeConfig({ port: 70000 }), /port must be <= 65535/);
  assert.throws(() => normalizeConfig({ turnTimeoutMs: -1 }), /turnTimeoutMs must be >= 0/);
  assert.throws(() => normalizeConfig({ maxQueue: 1.5 }), /maxQueue must be an integer/);
  assert.throws(() => normalizeConfig({ deliveryMode: 'turbo' }), /deliveryMode must be one of/);
  assert.throws(() => normalizeConfig({ path: 'onebot' }), /path must be an absolute path/);
  assert.throws(() => normalizeConfig({ statusEnabled: 'yes' }), /statusEnabled must be a boolean/);
  assert.throws(() => normalizeConfig({ mainQQ: 'abc' }), /mainQQ must be a QQ number/);
  assert.throws(() => normalizeConfig({ host: 5 }), /host must be a string/);
  return '10 类非法值全部被拒';
});

await check('Schema：数字字符串可接受，null 视同未配置，QQ 保留原类型（数字/字符串都认）', () => {
  const cfg = normalizeConfig({ port: '9001', maxQueue: '4', mainQQ: 12345678, botQQ: '87654321', turnTimeoutMs: null });
  assert.equal(cfg.port, 9001);
  assert.equal(typeof cfg.port, 'number');
  assert.equal(cfg.maxQueue, 4);
  assert.equal(cfg.mainQQ, 12345678, '数字输入不转字符串，线上 user_id 才和 M1/M2 断言一致');
  assert.equal(cfg.botQQ, '87654321', '字符串输入保留字符串');
  assert.equal(cfg.turnTimeoutMs, 180000, 'null 应回落到默认值');
  return 'coercion ok';
});

await check('Schema：publicConfig 不回显 token，只报 tokenConfigured', () => {
  const pub = publicConfig(normalizeConfig({ token: 'super-secret' }));
  assert.equal(pub.tokenConfigured, true);
  assert.equal(JSON.stringify(pub).includes('super-secret'), false);
  assert.equal('token' in pub, false);
  return 'token 不外泄';
});

console.log('\n=== M3：只读状态端点（真起 HTTP 服务） ===');

async function scenarioEndpoint() {
  const env = await boot({});
  let nc = null;
  try {
    nc = await env.connect();
    const st0 = env.gw.status();
    assert.equal(st0.statusEndpoint.enabled, true);
    const port = env.gw.statusPort();
    assert.ok(port > 0, '状态端点应已监听');
    assert.equal(st0.statusEndpoint.url, `http://127.0.0.1:${port}${STATUS_PATH}`);

    await check('GET /dsh-qq-gateway/status：200 + JSON，字段齐全', async () => {
      const res = await httpReq(port, STATUS_PATH);
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /application\/json/);
      assert.equal(res.headers['cache-control'], 'no-store');
      const body = JSON.parse(res.body);
      for (const key of ['state', 'startedAt', 'uptimeMs', 'listening', 'statusEndpoint', 'peers', 'busy', 'queueDepth', 'offlineBufferDepth', 'inFlightRids', 'timedOutRids', 'openTurns', 'tokenConfigured', 'counters', 'config', 'login', 'events', 'tools', 'sent']) {
        assert.ok(key in body, `status.${key} 缺失`);
      }
      assert.equal(body.state, 'listening');
      assert.equal(body.peers, 1);
      assert.equal(body.config.sessionId, SESSION);
      assert.equal(body.config.tokenConfigured, true);
      assert.equal(JSON.stringify(body).includes(TOKEN), false, '状态里不许出现 token 原值');
      assert.ok(body.uptimeMs >= 0);
      return `peers=${body.peers} uptime=${body.uptimeMs}ms`;
    });

    await check('HEAD：200 且无正文；GET 与 HEAD 结果一致', async () => {
      const get = await httpReq(port, STATUS_PATH);
      const head = await httpReq(port, STATUS_PATH, 'HEAD');
      assert.equal(head.status, 200);
      assert.equal(head.body, '');
      assert.equal(head.headers['content-type'], get.headers['content-type']);
      return 'HEAD 只回头';
    });

    await check('只读：POST/PUT/DELETE 一律 405 + Allow: GET, HEAD', async () => {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const res = await httpReq(port, STATUS_PATH, method);
        assert.equal(res.status, 405, `${method} 应 405`);
        assert.match(res.headers.allow, /GET/);
        const body = JSON.parse(res.body);
        assert.equal(body.error, 'method_not_allowed');
      }
      return '4 种写方法全拒';
    });

    await check('错路径 404，不泄漏别的路径', async () => {
      const res = await httpReq(port, '/');
      assert.equal(res.status, 404);
      const body = JSON.parse(res.body);
      assert.equal(body.error, 'not_found');
      assert.equal(body.endpoint, STATUS_PATH);
      return '404 正常';
    });

    await check('计数实时：消息往返后 relayed=1、uptime 增长、计数与回复条数自洽', async () => {
      const before = JSON.parse((await httpReq(port, STATUS_PATH)).body);
      nc.sendPrivate({ text: 'M3 状态端点的消息', messageId: 8001 });
      await waitFor(() => env.fake.calls.prompt.length === 1, { label: 'prompt' });
      const during = JSON.parse((await httpReq(port, STATUS_PATH)).body);
      assert.equal(during.busy, true, '回合在飞时 busy 应可见');
      await env.answer(0, 'M3 的回复');
      await waitFor(() => nc.replies().length === 1, { label: 'relay' });
      const after = JSON.parse((await httpReq(port, STATUS_PATH)).body);
      assert.equal(after.counters.relayed, 1);
      assert.equal(after.counters.inboundFrames >= 1, true);
      assert.equal(after.busy, false);
      assert.equal(after.queueDepth, 0);
      assert.ok(after.uptimeMs >= before.uptimeMs);
      assert.equal(after.counters.relayed + after.counters.unsupportedNotified, nc.replies().length);
      return `relayed=${after.counters.relayed} busy(在飞时)=${during.busy}`;
    });
  } finally {
    if (nc) await nc.close();
    await env.close();
  }
}

async function scenarioDisabled() {
  const env = await boot({ config: { statusEnabled: false } });
  let nc = null;
  try {
    await check('statusEnabled=false：不起状态端点，消息链路照常', async () => {
      const st = env.gw.status();
      assert.equal(st.statusEndpoint.enabled, false);
      assert.equal(st.statusEndpoint.url, null);
      assert.equal(env.gw.statusPort(), null);
      assert.equal(env.fake.calls.prompt.length, 0);
      nc = await env.connect();
      nc.sendPrivate({ text: '没有状态端点也要能聊', messageId: 8101 });
      await waitFor(() => env.fake.calls.prompt.length === 1, { label: 'prompt without status' });
      await env.answer(0, '聊上了');
      await waitFor(() => nc.replies().length === 1, { label: 'relay without status' });
      return `relayed=${env.gw.counters.relayed}`;
    });
  } finally {
    if (nc) await nc.close();
    await env.close();
  }
}

async function scenarioPortConflict() {
  // 先占住一个端口，再让状态端点去抢：应当只降级，不拖垮消息链路
  const squatter = createServer();
  await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
  const takenPort = squatter.address().port;
  const env = await boot({ config: { statusPort: takenPort } });
  let nc = null;
  try {
    await check('状态端点端口被占用：降级为不可用，错误可查，消息链路照常', async () => {
      const st = env.gw.status();
      assert.equal(st.statusEndpoint.enabled, true);
      assert.equal(st.statusEndpoint.url, null);
      assert.ok(st.statusEndpoint.error, '必须写明起不来的原因');
      assert.equal(env.gw.statusPort(), null);
      nc = await env.connect();
      nc.sendPrivate({ text: '端口冲突时也要能聊', messageId: 8201 });
      await waitFor(() => env.fake.calls.prompt.length === 1, { label: 'prompt under conflict' });
      await env.answer(0, '依然通');
      await waitFor(() => nc.replies().length === 1, { label: 'relay under conflict' });
      assert.ok(env.logs.some((l) => l.includes('status endpoint failed')), '降级要留日志');
      return st.statusEndpoint.error.slice(0, 60);
    });
  } finally {
    if (nc) await nc.close();
    await env.close();
    await new Promise((resolve) => squatter.close(resolve));
  }
}

async function scenarioClose() {
  const env = await boot({});
  try {
    await check('stop 之后状态端口释放，连不上', async () => {
      const port = env.gw.statusPort();
      assert.ok(port > 0);
      const ok = await httpReq(port, STATUS_PATH);
      assert.equal(ok.status, 200);
      await env.close();
      // 端口关掉后再连，具体错误随连接状态不同：拒绝/复位/被挂断都算已释放
      await assert.rejects(() => httpReq(port, STATUS_PATH), /ECONNREFUSED|ECONNRESET|socket hang up/);
      return `端口 ${port} 已释放`;
    });
  } finally {
    await env.close();
  }
}

for (const [label, fn] of [['只读状态端点', scenarioEndpoint], ['关闭状态端点', scenarioDisabled], ['端口冲突降级', scenarioPortConflict], ['stop 释放端口', scenarioClose]]) {
  try {
    await fn();
  } catch (err) {
    record(`${label}：场景本身崩了`, false, err?.stack ?? String(err));
  }
}

const failed = results.filter((r) => !r.ok);
const evidence = {
  milestone: 'M3',
  kind: '配置 Schema + 只读状态端点（离线）',
  at: new Date().toISOString(),
  node: process.version,
  config: { ...cfgBase, token: '<redacted>' },
  totals: { assertions: results.length, passed: results.length - failed.length, failed: failed.length },
  assertions: results,
};
writeFileSync(join(ROOT, 'm3-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
console.log(`证据：${join(ROOT, 'm3-evidence.json')}`);
process.exitCode = failed.length ? 1 : 0;
