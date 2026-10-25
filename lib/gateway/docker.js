// Docker 联动启动：DSH 起来时如果 Docker Desktop 或 NapCat 容器没在跑，自动把它们拉起来，
// 这样「打开 DSH 就能用 QQ」不用每次手动开 Docker。
//
// 设计取舍：
//   1) 完全旁路：拉起动作在后台做，绝不阻塞网关监听（反向 WS 先起来，NapCat 连上就通）。
//   2) 全程可注入：execFile/spawn/时钟都能替换，离线测试不需要真 Docker。
//   3) 只读优先：先查状态，能不动就不动；只有"引擎没起 / 容器没跑"才出手。
//   4) 失败不炸宿主：超时、找不到 Docker Desktop、docker start 失败都只记日志 + 状态里留原因。
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Windows 上 Docker Desktop 的常见安装位置（配置里可覆盖）。 */
export const DESKTOP_CANDIDATES = [
  'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
  'C:\\Program Files (x86)\\Docker\\Docker\\Docker Desktop.exe',
];

export const DOCKER_RESULT = {
  OK: 'ok',
  DISABLED: 'disabled',
  TIMEOUT: 'timeout',
  DESKTOP_MISSING: 'desktop-missing',
  ENGINE_ERROR: 'engine-error',
  CONTAINER_MISSING: 'container-missing',
  CONTAINER_ERROR: 'container-error',
};

/** 真环境下的命令执行器（测试用注入的假实现替换）。 */
export function createDockerRunner({ execFileImpl = execFileAsync, spawnImpl = spawn } = {}) {
  return {
    /** 跑一条 docker 命令，返回 stdout（去首尾空白）；失败抛错。 */
    async docker(args, timeoutMs = 15000) {
      const result = await execFileImpl('docker', args, {
        timeout: timeoutMs,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      });
      return String(result?.stdout ?? '').trim();
    },
    /** 拉起 Docker Desktop（detached，不占着调用方）。 */
    launch(exe) {
      const child = spawnImpl(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
      child?.unref?.();
    },
  };
}

function sleepReal(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 确保 Docker 引擎 + 目标容器可用。
 * @param {object} options
 * @param {string} options.container - 容器名（默认 napcat-gw）
 * @param {string} [options.desktopPath] - Docker Desktop 可执行文件路径（空=自动找）
 * @param {number} [options.timeoutMs] - 等引擎起来的上限
 * @param {(message: string) => void} [options.log]
 * @param {object} [options.runner] - createDockerRunner() 的返回值（测试注入）
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {(path: string) => boolean} [options.exists]
 * @param {number} [options.pollIntervalMs]
 * @returns {Promise<{ok: boolean, result: string, engine: string, container: string, detail?: string, ms: number}>}
 */
export async function ensureDockerReady(options = {}) {
  const startedAt = Date.now();
  const container = String(options.container ?? 'napcat-gw');
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 180000;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) && options.pollIntervalMs > 0 ? options.pollIntervalMs : 5000;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const runner = options.runner ?? createDockerRunner();
  const sleep = options.sleep ?? sleepReal;
  const exists = options.exists ?? existsSync;
  const done = (result, detail) => ({
    ok: result === DOCKER_RESULT.OK,
    result,
    engine: result === DOCKER_RESULT.TIMEOUT || result === DOCKER_RESULT.ENGINE_ERROR ? 'down' : 'up',
    container: result === DOCKER_RESULT.OK ? 'running' : 'unknown',
    ...(detail === undefined ? {} : { detail }),
    ms: Date.now() - startedAt,
  });

  const pingEngine = async () => {
    try {
      const version = await runner.docker(['info', '--format', '{{.ServerVersion}}'], 10000);
      return version || 'unknown';
    } catch {
      return '';
    }
  };

  const ensureContainer = async () => {
    let running = '';
    try {
      running = await runner.docker(['inspect', '-f', '{{.State.Running}}', container], 15000);
    } catch (err) {
      // inspect 失败多半是"没这个容器"
      const detail = String(err?.message ?? err).split('\n')[0];
      log(`docker: 容器 ${container} 查不到（${detail}），需要先 docker run 创建`);
      return done(DOCKER_RESULT.CONTAINER_MISSING, detail);
    }
    if (running === 'true') {
      log(`docker: 容器 ${container} 已在运行`);
      return done(DOCKER_RESULT.OK);
    }
    try {
      log(`docker: 容器 ${container} 没在跑 -> docker start`);
      await runner.docker(['start', container], 60000);
      log(`docker: 容器 ${container} 已启动`);
      return done(DOCKER_RESULT.OK);
    } catch (err) {
      const detail = String(err?.message ?? err).split('\n')[0];
      log(`docker: 容器 ${container} 启动失败：${detail}`);
      return done(DOCKER_RESULT.CONTAINER_ERROR, detail);
    }
  };

  // 1) 引擎已经在跑：只检查容器
  const firstPing = await pingEngine();
  if (firstPing) {
    log(`docker: 引擎已在运行（${firstPing}）`);
    return await ensureContainer();
  }

  // 2) 引擎没起：找 Docker Desktop 并拉起，轮询等它可用
  const exe = String(options.desktopPath || '').trim()
    || DESKTOP_CANDIDATES.find((candidate) => exists(candidate));
  if (!exe) {
    log('docker: 找不到 Docker Desktop 可执行文件，跳过联动启动（可在配置里写 dockerDesktopPath）');
    return done(DOCKER_RESULT.DESKTOP_MISSING, 'Docker Desktop not found');
  }
  try {
    log(`docker: 引擎没起 -> 拉起 Docker Desktop（${exe}）`);
    runner.launch(exe);
  } catch (err) {
    const detail = String(err?.message ?? err).split('\n')[0];
    log(`docker: 拉起 Docker Desktop 失败：${detail}`);
    return done(DOCKER_RESULT.ENGINE_ERROR, detail);
  }

  const deadline = Date.now() + timeoutMs;
  let lastDetail = '';
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const version = await pingEngine();
    if (version) {
      log(`docker: 引擎已就绪（${version}，等了 ${Math.round((Date.now() - startedAt) / 1000)}s）`);
      return await ensureContainer();
    }
    lastDetail = 'engine still down';
  }
  log(`docker: 等 Docker 引擎超时（${Math.round(timeoutMs / 1000)}s），放弃；下次启动再试`);
  return done(DOCKER_RESULT.TIMEOUT, lastDetail || `engine not ready in ${timeoutMs}ms`);
}
