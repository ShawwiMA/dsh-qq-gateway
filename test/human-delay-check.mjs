// 拟人延迟自检（离线，不碰网络）：只测纯逻辑 + 配置接线，跑完打印 PASS/FAIL 明细。
// 用法：node test/human-delay-check.mjs
import assert from 'node:assert/strict';

import { computeReplyDelayMs, createReplyTimeline, effectiveLength } from '../lib/gateway/human-delay.js';
import { ConfigError, defaultConfig, normalizeConfig } from '../lib/gateway/config.js';
import { createGateway } from '../lib/gateway/gateway.js';

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(`PASS ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}

// 固定序列 rng：按顺序吐给定值，用完后循环，方便断言可复现
function seq(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

check('mode=off 返回 0', () => {
  const cfg = { ...defaultConfig(), replyDelayMode: 'off' };
  assert.equal(computeReplyDelayMs({ text: '随便一段话', cfg }), 0);
});

check('默认配置下落在 [min, max] 区间内', () => {
  const cfg = defaultConfig();
  for (let i = 0; i < 500; i += 1) {
    const text = '字'.repeat(i % 300);
    const delay = computeReplyDelayMs({ text, cfg });
    assert.ok(delay >= cfg.replyDelayMinMs, `低于下限: ${delay}`);
    assert.ok(delay <= cfg.replyDelayMaxMs, `高于上限: ${delay}`);
    assert.ok(Number.isInteger(delay), `不是整数: ${delay}`);
  }
});

check('字越多等越久（同一组随机数）', () => {
  const cfg = defaultConfig();
  const short = computeReplyDelayMs({ text: '好', cfg, rng: seq([0.5, 0.5]) });
  const medium = computeReplyDelayMs({ text: '字'.repeat(50), cfg, rng: seq([0.5, 0.5]) });
  const long = computeReplyDelayMs({ text: '字'.repeat(400), cfg, rng: seq([0.5, 0.5]) });
  assert.ok(short < medium && medium < long, `不单调: ${short} ${medium} ${long}`);
  // 次线性：字数涨 8 倍，时间不该跟着涨 8 倍
  assert.ok(long - cfg.replyDelayMinMs < 8 * (medium - cfg.replyDelayMinMs), '长回复是线性爆炸，不是次线性');
});

check('长尾：均值明显大于中位数（指数分布特征）', () => {
  const cfg = defaultConfig();
  const samples = [];
  for (let i = 0; i < 4000; i += 1) samples.push(computeReplyDelayMs({ text: '十个字左右的回复', cfg }));
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  assert.ok(mean > median + 300, `没有长尾: mean=${mean.toFixed(0)} median=${median}`);
});

check('effectiveLength：中文按 1、半角按 0.5、空白不计', () => {
  assert.equal(effectiveLength('你好'), 2);
  assert.equal(effectiveLength('ab'), 1);
  assert.equal(effectiveLength('a b'), 1);
  assert.equal(effectiveLength('你好ab'), 3);
  assert.equal(effectiveLength(''), 0);
});

check('timeline 保证后一条不抢跑', () => {
  let clock = 1000;
  const timeline = createReplyTimeline({ now: () => clock });
  const first = timeline.reserve(5000);
  const second = timeline.reserve(100);
  assert.equal(first, 6000);
  assert.ok(second >= first + 1, `第二条抢跑了: ${second} < ${first}+1`);
  clock = 9000; // 时间跳过后仍按 max(now+delay, cursor) 走
  const third = timeline.reserve(100);
  assert.equal(third, 9100);
});

check('配置：默认值接上，且 max<min 会报错', () => {
  const cfg = normalizeConfig({});
  assert.equal(cfg.replyDelayMode, 'human');
  assert.equal(cfg.replyDelayMinMs, 800);
  assert.equal(cfg.replyDelayMaxMs, 12000);
  assert.equal(cfg.replyDelayPerCharMs, 60);
  assert.equal(cfg.replyDelayTailMs, 2500);
  const tuned = normalizeConfig({ replyDelayPerCharMs: '120', replyDelayMaxMs: 30000 });
  assert.equal(tuned.replyDelayPerCharMs, 120, '数字字符串应被接受');
  assert.throws(() => normalizeConfig({ replyDelayMinMs: 9000, replyDelayMaxMs: 1000 }), ConfigError);
  assert.throws(() => normalizeConfig({ replyDelayMode: 'fast' }), ConfigError);
});

check('网关模块能正常加载（没语法/引用错）', () => {
  assert.equal(typeof createGateway, 'function');
});

console.log(results.join('\n'));
console.log(process.exitCode ? '\n有失败项' : '\n全部通过');
