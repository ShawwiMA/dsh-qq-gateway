// M4.2 离线验收：Docker 联动启动（DSH 起来时自动拉起 Docker Desktop + NapCat 容器）。
// 全用假 runner，不碰真 Docker；覆盖：已在运行 / 容器停着 / 引擎没起 / 超时 / 找不到 Desktop / 容器不存在 / 网关接线。
// 跑法：node ~/.dsh/bundles/dsh-qq-gateway/test/m4-docker.mjs
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakeDsh } from './fake-dsh.mjs';
import { createGateway, normalizeConfig, publicConfig } from '../lib/gateway/gateway.js';
import { DOCKER_RESULT, ensureDockerReady } from '../lib/gateway/docker.js';
import { buildShutdownPlan, performShutdown, scheduleDockerShutdown } from '../lib/gateway/shutdown.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

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

/** 假 runner：按脚本回答 docker 命令，记录所有调用。 */
function makeRunner(handlers = {}) {
  const calls = [];
  return {
    calls,
    async docker(args) {
      calls.push(args);
      const handler = handlers[args[0]];
      if (!handler) throw new Error(`fake runner: unexpected docker ${args.join(' ')}`);
      return handler(args, calls);
    },
    launch(exe) {
      calls.push(['__launch__', exe]);
    },
  };
}
const launches = (runner) => runner.calls.filter((c) => c[0] === '__launch__');
const engineUp = () => '27.0.0';
const noSleep = async () => {};

console.log('=== M4.2：配置字段 ===');

await check('normalizeConfig：autoStartDocker/dockerContainer/dockerDesktopPath/dockerStartTimeoutMs 默认值与校验', () => {
  const d = normalizeConfig({});
  assert.equal(d.autoStartDocker, false, '默认关闭，需要显式开');
  assert.equal(d.stopDockerOnExit, false, '退出联动关闭默认也关闭（由 profile 显式开）');
  assert.equal(d.dockerContainer, 'napcat-gw');
  assert.equal(d.dockerDesktopPath, '');
  assert.equal(d.dockerStartTimeoutMs, 180000);
  assert.equal(normalizeConfig({ autoStartDocker: true }).autoStartDocker, true);
  assert.equal(normalizeConfig({ stopDockerOnExit: true }).stopDockerOnExit, true);
  assert.equal(normalizeConfig({ dockerStartTimeoutMs: '60000' }).dockerStartTimeoutMs, 60000);
  assert.throws(() => normalizeConfig({ autoStartDocker: 'yes' }), /autoStartDocker/);
  assert.throws(() => normalizeConfig({ stopDockerOnExit: 'yes' }), /stopDockerOnExit/);
  assert.throws(() => normalizeConfig({ dockerStartTimeoutMs: 1000 }), /dockerStartTimeoutMs/);
  const pub = publicConfig(normalizeConfig({ autoStartDocker: true, stopDockerOnExit: true }));
  assert.equal(pub.autoStartDocker, true);
  assert.equal(pub.stopDockerOnExit, true);
  assert.equal(pub.dockerContainer, 'napcat-gw');
});

console.log('\n=== M4.2：引擎/容器状态判定 ===');

await check('引擎在跑 + 容器在跑：不动手，只查两项', async () => {
  const runner = makeRunner({
    info: () => engineUp(),
    inspect: () => 'true',
  });
  const report = await ensureDockerReady({ container: 'napcat-gw', runner, sleep: noSleep, exists: () => true });
  assert.equal(report.result, DOCKER_RESULT.OK);
  assert.equal(report.ok, true);
  assert.equal(launches(runner).length, 0, '已经在跑就不该拉起 Docker Desktop');
  assert.equal(runner.calls.filter((c) => c[0] === 'start').length, 0, '不该 start 容器');
  return `calls=${runner.calls.length}`;
});

await check('引擎在跑 + 容器停着：docker start 一次', async () => {
  const runner = makeRunner({
    info: () => engineUp(),
    inspect: () => 'false',
    start: () => 'napcat-gw',
  });
  const report = await ensureDockerReady({ container: 'napcat-gw', runner, sleep: noSleep, exists: () => true });
  assert.equal(report.result, DOCKER_RESULT.OK);
  assert.deepEqual(runner.calls.filter((c) => c[0] === 'start'), [['start', 'napcat-gw']]);
  return 'started';
});

await check('引擎没起：先拉起 Docker Desktop，轮询到就绪后再确认容器', async () => {
  let infoCalls = 0;
  const logs = [];
  const runner = makeRunner({
    info: () => {
      infoCalls += 1;
      if (infoCalls < 3) throw new Error('engine down');
      return engineUp();
    },
    inspect: () => 'false',
    start: () => 'napcat-gw',
  });
  const report = await ensureDockerReady({
    container: 'napcat-gw',
    runner,
    sleep: noSleep,
    exists: () => true,
    log: (m) => logs.push(m),
  });
  assert.equal(report.result, DOCKER_RESULT.OK);
  assert.equal(launches(runner).length, 1, '应该拉起一次 Docker Desktop');
  assert.equal(infoCalls, 3, '轮询到第 3 次才成功');
  assert.deepEqual(runner.calls.filter((c) => c[0] === 'start'), [['start', 'napcat-gw']]);
  assert.ok(logs.some((m) => m.includes('引擎没起')), '日志要说明引擎没起');
  assert.ok(logs.some((m) => m.includes('引擎已就绪')), '日志要说明等到了');
  return `logs=${logs.length} infoCalls=${infoCalls}`;
});

await check('引擎一直起不来：超时报错，不抛异常', async () => {
  const runner = makeRunner({ info: () => { throw new Error('down'); } });
  const report = await ensureDockerReady({
    container: 'napcat-gw',
    runner,
    sleep: noSleep,
    exists: () => true,
    timeoutMs: 2000,
    pollIntervalMs: 1,
  });
  assert.equal(report.result, DOCKER_RESULT.TIMEOUT);
  assert.equal(report.ok, false);
  assert.equal(launches(runner).length, 1);
  return `result=${report.result}`;
});

await check('找不到 Docker Desktop：跳过且不抛异常', async () => {
  const runner = makeRunner({ info: () => { throw new Error('down'); } });
  const report = await ensureDockerReady({
    container: 'napcat-gw',
    runner,
    sleep: noSleep,
    exists: () => false,
    timeoutMs: 1000,
  });
  assert.equal(report.result, DOCKER_RESULT.DESKTOP_MISSING);
  assert.equal(launches(runner).length, 0);
  return 'skipped';
});

await check('容器不存在（inspect 失败）：报 container-missing，不抛异常', async () => {
  const runner = makeRunner({
    info: () => engineUp(),
    inspect: () => { throw new Error('no such container'); },
  });
  const report = await ensureDockerReady({ container: 'napcat-gw', runner, sleep: noSleep, exists: () => true });
  assert.equal(report.result, DOCKER_RESULT.CONTAINER_MISSING);
  assert.match(report.detail, /no such container/);
  return 'container-missing';
});

console.log('\n=== M5.2：Docker 联动关闭（DSH 退出时停容器 + Docker Desktop） ===');

function makeSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { unref() {} };
  };
  return { calls, fn };
}

await check('buildShutdownPlan：默认先停容器再停 Docker Desktop；--no-desktop 只停容器', () => {
  assert.deepEqual(buildShutdownPlan({ container: 'napcat-gw' }), [
    { action: 'container', name: 'napcat-gw', args: ['stop', 'napcat-gw'] },
    { action: 'desktop', name: 'docker-desktop', args: ['desktop', 'stop'] },
  ]);
  assert.deepEqual(buildShutdownPlan({ container: 'x', stopDesktop: false }).map((s) => s.action), ['container']);
});

await check('performShutdown：DSH 进程还活着（热重载）→ 跳过，一条 docker 命令都不跑', async () => {
  const runs = [];
  const logs = [];
  const res = await performShutdown({
    container: 'napcat-gw',
    graceMs: 0,
    parentPid: 4242,
    alive: () => true,
    runner: async (cmd, args) => { runs.push(args); },
    sleep: noSleep,
    log: (m) => logs.push(m),
  });
  assert.equal(res.result, 'skipped');
  assert.equal(runs.length, 0);
  assert.ok(logs.some((m) => m.includes('热重载')), '日志要说明是热重载才跳过');
});

await check('performShutdown：DSH 进程已退出 → docker stop 容器 → docker desktop stop', async () => {
  const runs = [];
  const res = await performShutdown({
    container: 'napcat-gw',
    graceMs: 0,
    parentPid: 4242,
    alive: () => false,
    runner: async (cmd, args) => { runs.push({ cmd, args }); },
    sleep: noSleep,
    log: () => {},
  });
  assert.equal(res.result, 'stopped');
  assert.deepEqual(runs, [
    { cmd: 'docker', args: ['stop', 'napcat-gw'] },
    { cmd: 'docker', args: ['desktop', 'stop'] },
  ]);
});

await check('performShutdown：拿不到 parentPid 时退回端口探测（端口在听 → 跳过）', async () => {
  const runs = [];
  const res = await performShutdown({
    container: 'napcat-gw',
    graceMs: 0,
    port: 8792,
    listen: async () => true,
    runner: async (cmd, args) => { runs.push(args); },
    sleep: noSleep,
    log: () => {},
  });
  assert.equal(res.result, 'skipped');
  assert.equal(runs.length, 0);
});

await check('performShutdown：Docker Desktop 停不掉只记 partial，不抛异常', async () => {
  const logs = [];
  const res = await performShutdown({
    container: 'napcat-gw',
    graceMs: 0,
    port: 0,
    runner: async (cmd, args) => {
      if (args[0] === 'desktop') throw new Error('desktop cli not supported');
    },
    sleep: noSleep,
    log: (m) => logs.push(m),
  });
  assert.equal(res.result, 'partial');
  assert.ok(res.steps.some((s) => s.action === 'desktop' && s.ok === false));
  assert.ok(logs.some((m) => m.includes('Docker Desktop 停止失败')));
});

await check('performShutdown：容器 stop 报错但 Docker Desktop 停成功 → 仍记 stopped（容器随引擎关）', async () => {
  const logs = [];
  const res = await performShutdown({
    container: 'napcat-gw',
    graceMs: 0,
    port: 0,
    // 实测现场：DSH 退出时引擎已在自行关闭，docker stop 报 Command failed
    runner: async (cmd, args) => {
      if (args[0] === 'stop') {
        const err = new Error('Command failed: docker stop napcat-gw');
        err.stderr = 'error during connect: daemon is shutting down';
        throw err;
      }
    },
    sleep: noSleep,
    log: (m) => logs.push(m),
  });
  assert.equal(res.result, 'stopped');
  assert.ok(res.steps.some((s) => s.action === 'container' && s.ok === false));
  assert.ok(logs.some((m) => m.includes('daemon is shutting down')), '失败原因（stderr）要写进日志');
  assert.ok(logs.some((m) => m.includes('容器随引擎一起关')));
});

await check('scheduleDockerShutdown：detached + ELECTRON_RUN_AS_NODE，参数齐全（带 parent-pid）', () => {
  const spawn = makeSpawn();
  scheduleDockerShutdown({
    helperPath: 'C:\\bundle\\lib\\gateway\\shutdown-helper.mjs',
    container: 'napcat-gw',
    port: 8792,
    parentPid: 4242,
    graceMs: 5000,
    logPath: 'C:\\bundle\\m4-gateway.log',
    spawnImpl: spawn.fn,
    execPath: 'electron.exe',
  });
  assert.equal(spawn.calls.length, 1);
  const call = spawn.calls[0];
  assert.equal(call.cmd, 'electron.exe');
  assert.deepEqual(call.args, [
    'C:\\bundle\\lib\\gateway\\shutdown-helper.mjs',
    '--container', 'napcat-gw',
    '--port', '8792',
    '--grace', '5000',
    '--parent-pid', '4242',
    '--log', 'C:\\bundle\\m4-gateway.log',
  ]);
  assert.equal(call.opts.detached, true);
  assert.equal(call.opts.stdio, 'ignore');
  assert.equal(call.opts.env.ELECTRON_RUN_AS_NODE, '1');
});

console.log('\n=== M4.2：网关接线（autoStartDocker=true 时启动就拉起） ===');

await check('网关 start() 后状态里能看到 docker 联动结果；WS 不被阻塞', async () => {
  const fake = createFakeDsh({ sessionId: 'session-fake-target' });
  fake.emitSeed();
  const runner = makeRunner({
    info: () => engineUp(),
    inspect: () => 'false',
    start: () => 'napcat-gw',
  });
  const logs = [];
  const gw = createGateway({
    ctx: fake.ctx,
    config: {
      host: '127.0.0.1', port: 0, path: '/onebot', token: 't', mainQQ: 10001, botQQ: 10002,
      sessionId: 'session-fake-target', autoStartDocker: true,
    },
    logger: (m) => logs.push(m),
    deps: { dockerRunner: runner, sleep: noSleep, exists: () => true },
  });
  const t0 = Date.now();
  await gw.start();
  const startMs = Date.now() - t0;
  assert.ok(startMs < 3000, `start() 不该等 Docker，实际 ${startMs}ms`);
  assert.ok(gw.port() > 0, '反向 WS 端口要已经监听');
  // 联动是后台任务，等它落状态
  for (let i = 0; i < 100 && gw.status().docker === null; i += 1) await new Promise((r) => setTimeout(r, 10));
  const st = gw.status();
  assert.ok(st.docker, 'status.docker 应该有结果');
  assert.equal(st.docker.result, DOCKER_RESULT.OK);
  assert.equal(st.config.autoStartDocker, true);
  assert.deepEqual(runner.calls.filter((c) => c[0] === 'start'), [['start', 'napcat-gw']]);
  await gw.stop();
  return `start()=${startMs}ms docker=${st.docker.result}`;
});

await check('autoStartDocker=false（默认）时完全不碰 Docker', async () => {
  const fake = createFakeDsh({ sessionId: 'session-fake-target' });
  fake.emitSeed();
  const runner = makeRunner({});
  const gw = createGateway({
    ctx: fake.ctx,
    config: { host: '127.0.0.1', port: 0, path: '/onebot', token: 't', mainQQ: 10001, botQQ: 10002, sessionId: 'session-fake-target' },
    logger: () => {},
    deps: { dockerRunner: runner, sleep: noSleep, exists: () => true },
  });
  await gw.start();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(runner.calls.length, 0, '没开 autoStartDocker 就不该跑 docker 命令');
  assert.equal(gw.status().docker, null);
  await gw.stop();
  return 'no docker calls';
});

await check('热重载保护：8792 被旧实例占着时自动重试接上（不会直接启动失败）', async () => {
  // 实测踩过：patch 热重载时新实例抢不到 8792 就直接失败，旧实例又已停 → 网关彻底没了
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const port = blocker.address().port;
  const fake = createFakeDsh({ sessionId: 'session-fake-target' });
  fake.emitSeed();
  const logs = [];
  const gw = createGateway({
    ctx: fake.ctx,
    config: { host: '127.0.0.1', port, path: '/onebot', token: 't', mainQQ: 10001, botQQ: 10002, sessionId: 'session-fake-target', statusEnabled: false },
    logger: (m) => logs.push(m),
  });
  const startPromise = gw.start();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await new Promise((resolve) => blocker.close(resolve));
  await startPromise;
  assert.equal(gw.port(), port, '重试后应该绑上原端口');
  assert.ok(logs.some((m) => m.includes('EADDRINUSE')), '日志里要留下重试痕迹');
  await gw.stop();
  return `retried then bound :${port}`;
});

await check('stopDockerOnExit=true：stop() 安排 detached 关闭助手（不真跑 docker）', async () => {
  const fake = createFakeDsh({ sessionId: 'session-fake-target' });
  fake.emitSeed();
  const spawn = makeSpawn();
  const logs = [];
  const gw = createGateway({
    ctx: fake.ctx,
    config: {
      host: '127.0.0.1', port: 0, path: '/onebot', token: 't', mainQQ: 10001, botQQ: 10002,
      sessionId: 'session-fake-target', statusEnabled: false, stopDockerOnExit: true,
    },
    logger: (m) => logs.push(m),
    deps: { spawnImpl: spawn.fn, shutdownGraceMs: 100, shutdownLogPath: 'C:\\tmp\\m4-gateway.log' },
  });
  await gw.start();
  const boundPort = gw.port();
  await gw.stop();
  assert.equal(spawn.calls.length, 1, '退出时应安排一次联动关闭');
  const call = spawn.calls[0];
  assert.match(call.args[0], /shutdown-helper\.mjs$/);
  assert.deepEqual(call.args.slice(1, 7), ['--container', 'napcat-gw', '--port', String(boundPort), '--grace', '100']);
  assert.equal(call.args.includes('--parent-pid'), true, '要带 DSH 进程 PID 供助手判热重载');
  assert.equal(call.args[call.args.indexOf('--parent-pid') + 1], String(process.pid));
  assert.equal(call.args.includes('--log'), true, '要把助手日志接到同一份文件');
  assert.equal(call.opts.detached, true);
  assert.equal(call.opts.env.ELECTRON_RUN_AS_NODE, '1');
  assert.ok(logs.some((m) => m.includes('docker 联动关闭：已安排')), '日志要留痕');
  return `helper→${call.args[0].split('\\').pop()}`;
});

await check('stopDockerOnExit=false（默认）：stop() 不安排联动关闭', async () => {
  const fake = createFakeDsh({ sessionId: 'session-fake-target' });
  fake.emitSeed();
  const spawn = makeSpawn();
  const gw = createGateway({
    ctx: fake.ctx,
    config: {
      host: '127.0.0.1', port: 0, path: '/onebot', token: 't', mainQQ: 10001, botQQ: 10002,
      sessionId: 'session-fake-target', statusEnabled: false,
    },
    logger: () => {},
    deps: { spawnImpl: spawn.fn },
  });
  await gw.start();
  await gw.stop();
  assert.equal(spawn.calls.length, 0);
  return 'no shutdown spawn';
});

const failed = results.filter((r) => !r.ok);
const evidence = {
  milestone: 'M4.2',
  kind: 'Docker 联动启动（离线验收）',
  at: new Date().toISOString(),
  node: process.version,
  totals: { checks: results.length, passed: results.length - failed.length, failed: failed.length },
  results,
};
writeFileSync(join(ROOT, 'm4-docker-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
console.log(`证据：${join(ROOT, 'm4-docker-evidence.json')}`);
process.exitCode = failed.length ? 1 : 0;
