// 实机验证 Docker 联动启动：真拉起 Docker Desktop + 容器（不经过 DSH，单跑一次）。
// 跑法：node test/m4-docker-live.mjs
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDockerReady } from '../lib/gateway/docker.js';

const lines = [];
const log = (m) => { lines.push(m); console.log(m); };
const t0 = Date.now();
const report = await ensureDockerReady({
  container: 'napcat-gw',
  timeoutMs: 300000,
  pollIntervalMs: 5000,
  log,
});
const evidence = {
  kind: '实机：Docker 联动启动',
  at: new Date().toISOString(),
  elapsedMs: Date.now() - t0,
  report,
  logs: lines,
};
writeFileSync(join(process.cwd(), 'm4-docker-live-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(`\n结果：${report.result}（${Math.round((Date.now() - t0) / 1000)}s）详情=${report.detail ?? '-'}`);
