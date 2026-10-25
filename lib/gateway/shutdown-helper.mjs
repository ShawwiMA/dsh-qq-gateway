#!/usr/bin/env node
// DSH 退出后执行的联动关闭助手（由 lib/gateway/shutdown.js 的 scheduleDockerShutdown
// 以 detached 方式拉起，父进程退出后仍会跑完）。
//
// 流程：等 grace 秒 → 探网关端口（在听 = 热重载，跳过）→ docker stop 容器 →
// docker desktop stop。所有结果追加到 --log 指定的文件（真机证据唯一来源）。
import { appendFileSync } from 'node:fs';

import { performShutdown } from './shutdown.js';

function readArg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const logPath = readArg('log');
const log = (message) => {
  try {
    if (logPath) appendFileSync(logPath, `${new Date().toISOString()} [info] ${message}\n`);
  } catch {
    // 日志写不进去也不能影响关闭流程
  }
};

const result = await performShutdown({
  container: readArg('container', 'napcat-gw'),
  port: Number(readArg('port', '8792')),
  graceMs: Number(readArg('grace', '8000')),
  parentPid: Number(readArg('parent-pid', '0')),
  stopDesktop: !process.argv.includes('--no-desktop'),
  log,
});

log(`docker 联动关闭：结束（${result.result}，${Math.round(result.ms / 1000)}s）`);
process.exitCode = result.result === 'partial' ? 1 : 0;
