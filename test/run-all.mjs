// 一键离线回归：不需要真 QQ、真 Docker、真 DSH，全部用假 NapCat / 假宿主跑。
// 用法：npm test  或  node test/run-all.mjs
//
// 不进包（package.json 的 files 只有 lib / cordis.patch.yml / README / LICENSE），
// 所以 npm 安装后的目录里没有这些测试；要在源码目录跑。
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// 顺序按依赖从基础到高层；全是离线套件。真机脚本（*-live.mjs、m4-probe.mjs）不在这里。
const SUITES = [
  'm1-run.mjs',
  'm2-run.mjs',
  'm3-run.mjs',
  'm4-docker.mjs',
  'm4-image.mjs',
  'm5-multi.mjs',
  'm6-full.mjs',
  'm6-4-dedupe.mjs',
  'm6-6-forward.mjs',
  'm6-7-forward-images.mjs',
  'm8-mute-e2e.mjs',
  'actions-check.mjs',
  'events-check.mjs',
  'mute-check.mjs',
  'markdown-image-check.mjs',
  'human-delay-check.mjs',
  'container-proxy-check.mjs',
  // 安全升级（2026-10-26）：入站防护单测 / WS 握手与帧上限 / 端到端安全策略
  'm9-guard.mjs',
  'm9-ws-security.mjs',
  'm9-security.mjs',
]

const results = []
for (const [index, suite] of SUITES.entries()) {
  console.log(`\n${'='.repeat(60)}\n[${index + 1}/${SUITES.length}] ${suite}\n${'='.repeat(60)}`)
  const startedAt = Date.now()
  const run = spawnSync(process.execPath, [join(HERE, suite)], { stdio: 'inherit' })
  const ms = Date.now() - startedAt
  const ok = run.status === 0
  results.push({ suite, ok, ms })
  if (!ok) {
    console.error(`\n✗ ${suite} 失败（exit ${run.status ?? 'null'}，${ms}ms），后面的套件不再跑`)
    break
  }
}

const passed = results.filter((r) => r.ok).length
const failed = results.filter((r) => !r.ok)
console.log(`\n${'-'.repeat(60)}`)
console.log(`离线回归：${passed}/${SUITES.length} 套件通过`)
if (failed.length) {
  console.log(`失败：${failed.map((r) => r.suite).join(', ')}`)
  process.exitCode = 1
}
