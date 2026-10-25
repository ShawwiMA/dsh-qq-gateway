// Docker 联动关闭：DSH 退出后把 NapCat 容器和 Docker Desktop 停掉。
//
// 为什么需要 detached 子进程：DSH 关闭时不会等插件的异步清理，直接在 stop() 里
// await docker 命令基本跑不完。所以这里 spawn 一个独立助手（shutdown-helper.mjs），
// 父进程退出后它继续跑完。
//
// 为什么要延迟 + 端口探测：profile patch 热重载也会触发插件 stop()，但新实例马上
// 会重新监听同一个端口。助手等几秒后先探端口：新网关已在监听 → 认为是热重载，
// 跳过停止；端口没人听 → 才是真的退出，执行 docker stop + docker desktop stop。
//
// 全程可注入（spawn / 命令执行 / 端口探测 / sleep），离线测试不碰真 Docker。
import { execFile, spawn } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 探测进程是否还活着（热重载判定用；PID 在 = DSH 没退出）。 */
export function isProcessAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但没权限发信号，也算活着
    return err?.code === 'EPERM';
  }
}

/** 探测本机端口是否有人监听（没有 parentPid 时的兜底判据）。 */
export function isPortListening({ port, host = '127.0.0.1', timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    if (!Number.isFinite(Number(port)) || Number(port) <= 0) {
      resolve(false);
      return;
    }
    const socket = net.connect({ port: Number(port), host });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 关闭步骤（顺序固定：先停容器，再停 Docker Desktop）。 */
export function buildShutdownPlan({ container = 'napcat-gw', stopDesktop = true } = {}) {
  const plan = [{ action: 'container', name: container, args: ['stop', String(container)] }];
  if (stopDesktop) plan.push({ action: 'desktop', name: 'docker-desktop', args: ['desktop', 'stop'] });
  return plan;
}

/**
 * 执行联动关闭。
 * @param {object} [options]
 * @param {string} [options.container]
 * @param {boolean} [options.stopDesktop] - 是否连 Docker Desktop 一起停
 * @param {number} [options.graceMs] - 先等多久（给热重载新实例留出绑定端口的时间）
 * @param {number} [options.port] - 网关端口（没有 parentPid 时用它兜底判热重载）
 * @param {number} [options.parentPid] - 发起方 DSH 进程 PID；仍在 = 热重载，跳过停止
 * @param {(message: string) => void} [options.log]
 * @param {(opts: object) => Promise<boolean>} [options.listen] - 端口探测（测试注入）
 * @param {(pid: number) => boolean} [options.alive] - 进程存活探测（测试注入）
 * @param {Function} [options.runner] - execFile 风格实现（测试注入）
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @returns {Promise<{result: string, steps: object[], ms: number}>}
 */
export async function performShutdown(options = {}) {
  const startedAt = Date.now();
  const container = String(options.container ?? 'napcat-gw');
  const stopDesktop = options.stopDesktop !== false;
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : 8000;
  const port = Number(options.port ?? 0);
  const parentPid = Number(options.parentPid ?? 0);
  const log = typeof options.log === 'function' ? options.log : () => {};
  const listen = options.listen ?? isPortListening;
  const alive = options.alive ?? isProcessAlive;
  const runner = options.runner ?? execFileAsync;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  if (graceMs > 0) await sleep(graceMs);
  // 真正的判据：DSH 进程还活着（PID 存活）就是 patch 热重载，绝不能停 Docker。
  // 只看端口不够——DSH 重启得快时新实例会赶在助手探测前绑上端口，被误判成热重载
  // （2026-10-17 实测踩过：7 秒内重开 DSH，Docker 没被停）。
  if (parentPid > 0 && alive(parentPid)) {
    log('docker 联动关闭：DSH 进程仍在运行，跳过停止（热重载）');
    return { result: 'skipped', steps: [], ms: Date.now() - startedAt };
  }
  // 兜底：没传 parentPid 时退回端口探测（新实例在监听 = 热重载）
  if (parentPid <= 0 && port > 0) {
    const listening = await listen({ port });
    if (listening) {
      log('docker 联动关闭：检测到网关仍在监听，跳过停止（热重载）');
      return { result: 'skipped', steps: [], ms: Date.now() - startedAt };
    }
  }

  const steps = [];
  for (const step of buildShutdownPlan({ container, stopDesktop })) {
    try {
      await runner('docker', step.args, { timeout: step.action === 'desktop' ? 120000 : 90000, windowsHide: true });
      steps.push({ action: step.action, ok: true });
      log(step.action === 'container'
        ? `docker 联动关闭：容器 ${container} 已停止`
        : 'docker 联动关闭：Docker Desktop 已停止');
    } catch (err) {
      const stderr = String(err?.stderr ?? '').trim().split('\n')[0];
      const message = stderr || String(err?.message ?? err).split('\n')[0];
      steps.push({ action: step.action, ok: false, detail: message });
      log(step.action === 'container'
        ? `docker 联动关闭：容器 ${container} 停止失败（${message}）`
        : `docker 联动关闭：Docker Desktop 停止失败（${message}）`);
    }
  }
  const containerStep = steps.find((step) => step.action === 'container');
  const desktopStep = steps.find((step) => step.action === 'desktop');
  let result;
  if (containerStep?.ok) {
    // 容器停了；Desktop 没让停（如 --no-desktop 或命令失败）就是 partial
    result = desktopStep && !desktopStep.ok ? 'partial' : 'stopped';
  } else if (desktopStep?.ok) {
    // 实测踩过：DSH 退出时 Docker 引擎可能已在自行关闭，docker stop 报错；
    // 但 Docker Desktop 停掉后容器必然一起停，目标已达成，按 stopped 记。
    log('docker 联动关闭：容器停止命令失败，但 Docker Desktop 已停（容器随引擎一起关）');
    result = 'stopped';
  } else {
    result = 'partial';
  }
  return { result, steps, ms: Date.now() - startedAt };
}

/**
 * 把关闭助手拉成 detached 子进程（父进程退出后仍会跑完）。
 * DSH 桌面端的 process.execPath 是 Electron，需要 ELECTRON_RUN_AS_NODE=1 才能当 node 用。
 * @returns {object|null} 子进程；未安排返回 null
 */
export function scheduleDockerShutdown(options = {}) {
  const helperPath = String(options.helperPath ?? '');
  if (!helperPath) return null;
  const container = String(options.container ?? 'napcat-gw');
  const port = Number(options.port ?? 0);
  const graceMs = Number.isFinite(options.graceMs) ? options.graceMs : 8000;
  const parentPid = Number(options.parentPid ?? 0);
  const logPath = String(options.logPath ?? '');
  const spawnImpl = options.spawnImpl ?? spawn;
  const execPath = options.execPath ?? process.execPath;
  const args = [helperPath, '--container', container, '--port', String(port), '--grace', String(graceMs)];
  if (parentPid > 0) args.push('--parent-pid', String(parentPid));
  if (logPath) args.push('--log', logPath);
  const child = spawnImpl(execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child?.unref?.();
  return child ?? null;
}
