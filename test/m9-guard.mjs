// M9 离线验收：入站防护纯逻辑（限流 / 重复内容 / 突发合并 / 事件门控）。
// 零依赖、零 IO，时钟全部注入；跑法：node test/m9-guard.mjs
// 覆盖：默认频控与补满、自动禁回阶梯与冷却、主号免疫、内容去重与窗口、合并判定、
//       事件门控与独立桶、计数快照与 reset。

import assert from 'node:assert/strict';

import { createGuard } from '../lib/gateway/guard.js';

const START = 1_700_000_000_000;
const AUTO_MUTE_REASON = '频控自动禁回：短时间消息过多';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL  ${name} — ${err?.message ?? err}`);
  }
}

/** 可拨时钟：模块只能通过注入的 now() 看到时间，测试只改 t。 */
function makeClock(start = START) {
  return {
    t: start,
    now() {
      return this.t;
    },
    advance(ms) {
      this.t += ms;
      return this.t;
    },
  };
}

console.log('=== M9：消息限流 ===');

check('默认 10 条/分钟：前 10 条放行，第 11 条 rate-limit，60 秒后补满恢复', () => {
  const clock = makeClock();
  const guard = createGuard({ now: () => clock.now() });

  for (let i = 1; i <= 10; i += 1) {
    assert.deepEqual(
      guard.checkMessage({ userId: '10001', source: 'private', text: `第 ${i} 条` }),
      { ok: true },
      `第 ${i} 条应放行`,
    );
  }

  assert.deepEqual(
    guard.checkMessage({ userId: '10001', source: 'private', text: '第 11 条' }),
    { ok: false, reason: 'rate-limit', autoMute: null },
  );
  assert.equal(guard.countersSnapshot().rateLimited, 1);

  clock.advance(60_000);
  assert.deepEqual(
    guard.checkMessage({ userId: '10001', source: 'private', text: '第 12 条' }),
    { ok: true },
    '60 秒后桶应补满',
  );
});

check('连续限流阶梯：5 次触发一次自动禁回（10 分钟），成功放行/触发后都要重新累计', () => {
  const clock = makeClock();
  const guard = createGuard({ config: { rateLimitPerMinute: 1 }, now: () => clock.now() });
  const send = (text) => guard.checkMessage({ userId: '20001', source: 'group', text });

  assert.deepEqual(send('首条放行'), { ok: true });
  for (let i = 1; i <= 4; i += 1) {
    assert.deepEqual(send(`第一轮-${i}`), { ok: false, reason: 'rate-limit', autoMute: null });
  }
  assert.equal(guard.countersSnapshot().autoMuted, 0, '不满 5 次不许自动禁回');

  clock.advance(60_000);
  assert.deepEqual(send('成功放行一次'), { ok: true }, '60 秒后恢复一个令牌');
  for (let i = 1; i <= 4; i += 1) {
    assert.equal(send(`第二轮-${i}`).autoMute, null, '成功放行应清零连续计数，前 4 次不触发');
  }
  assert.deepEqual(send('第二轮-第 5 次'), {
    ok: false,
    reason: 'rate-limit',
    autoMute: { minutes: 10, reason: AUTO_MUTE_REASON },
  });
  assert.equal(guard.countersSnapshot().autoMuted, 1);

  // 触发后连续计数清零；冷却期内再攒 5 次也不许再触发。
  for (let i = 1; i <= 5; i += 1) {
    assert.deepEqual(send(`冷却期-${i}`), { ok: false, reason: 'rate-limit', autoMute: null });
  }
  assert.equal(guard.countersSnapshot().autoMuted, 1, '10 分钟冷却期内不许第二次自动禁回');

  // 冷却过去后要重新攒 5 次，而不是“一次就触发”。
  clock.advance(10 * 60_000 + 1);
  assert.deepEqual(send('冷却后放行'), { ok: true });
  for (let i = 1; i <= 4; i += 1) {
    assert.equal(send(`第三轮-${i}`).autoMute, null, '冷却后也要重新累计 5 次');
  }
  assert.equal(send('第三轮-第 5 次').autoMute?.minutes, 10);
  assert.equal(guard.countersSnapshot().autoMuted, 2);
});

check('reset()：清空连续限流计数，重新触发必须再攒满 5 次', () => {
  const clock = makeClock();
  const guard = createGuard({ config: { rateLimitPerMinute: 1 }, now: () => clock.now() });
  const send = (text) => guard.checkMessage({ userId: '20002', source: 'group', text });

  assert.deepEqual(send('首条'), { ok: true });
  for (let i = 0; i < 3; i += 1) send(`重置前-${i}`);
  assert.equal(guard.countersSnapshot().rateLimited, 3);

  guard.reset();
  assert.deepEqual(guard.countersSnapshot(), {
    rateLimited: 0, duplicates: 0, eventsDropped: 0, autoMuted: 0, merged: 0,
  });

  // reset 同时清桶：原来空的桶重新是满的。
  assert.deepEqual(send('重置后首条'), { ok: true });
  for (let i = 1; i <= 4; i += 1) {
    assert.equal(send(`重置后-${i}`).autoMute, null, '计数已清零，前 4 次不触发');
  }
  assert.equal(send('重置后-第 5 次').autoMute?.minutes, 10);
  assert.equal(guard.countersSnapshot().autoMuted, 1);
});

check('主号连发 100 条全部放行：不限流、不去重、永不自动禁回', () => {
  const clock = makeClock();
  const guard = createGuard({ config: { rateLimitPerMinute: 1 }, now: () => clock.now() });
  for (let i = 0; i < 100; i += 1) {
    assert.deepEqual(
      guard.checkMessage({
        userId: '10001',
        source: 'private',
        text: '完全相同的文本',
        isMain: true,
      }),
      { ok: true },
      `主号第 ${i + 1} 条应放行`,
    );
  }
  assert.deepEqual(guard.countersSnapshot(), {
    rateLimited: 0, duplicates: 0, eventsDropped: 0, autoMuted: 0, merged: 0,
  });
});

console.log('\n=== M9：重复内容 ===');

check('同文本窗口内第二次 duplicate，窗口外放行；不同用户同一文本互不影响', () => {
  const clock = makeClock();
  const guard = createGuard({ config: { rateLimitPerMinute: 100 }, now: () => clock.now() });

  assert.deepEqual(
    guard.checkMessage({ userId: '30001', source: 'group', text: '  Hello   World  ' }),
    { ok: true },
  );
  assert.deepEqual(
    guard.checkMessage({ userId: '30001', source: 'group', text: 'hello world' }),
    { ok: false, reason: 'duplicate', autoMute: null },
    '大小写/空白归一后应命中同一指纹',
  );
  assert.equal(
    guard.checkMessage({ userId: '30002', source: 'group', text: 'hello world' }).ok,
    true,
    '不同用户同一文本不该互相误杀',
  );

  clock.advance(10 * 60_000 + 1);
  assert.equal(
    guard.checkMessage({ userId: '30001', source: 'group', text: 'HELLO WORLD' }).ok,
    true,
    '窗口外允许重发',
  );
  assert.equal(guard.countersSnapshot().duplicates, 1);
});

check('空正文/非字符串正文不做指纹：不会被去重误杀', () => {
  const clock = makeClock();
  const guard = createGuard({ now: () => clock.now() });
  for (const text of ['', '   ', undefined, 123, null, {}]) {
    assert.deepEqual(
      guard.checkMessage({ userId: '30003', source: 'private', text }),
      { ok: true },
      `正文 ${String(text)} 按空正文处理`,
    );
  }
  assert.equal(guard.countersSnapshot().duplicates, 0);
  assert.equal(guard.countersSnapshot().rateLimited, 0);
});

console.log('\n=== M9：突发合并判定 ===');

check('canMerge：同人同源窗口内 true；不同人/换源/超窗/满 10 条 false', () => {
  const guard = createGuard({ config: { burstMergeMs: 1500 }, now: () => START });
  const base = {
    kind: 'message',
    source: 'group',
    userId: '40001',
    text: '第一句',
    at: 1000,
    mergedCount: 1,
  };

  assert.equal(guard.canMerge(base, { ...base, text: '第二句', at: 2500 }), true, '差值正好 1500 应合并');
  assert.equal(guard.canMerge(base, { ...base, userId: '40002', at: 1500 }), false, '不同人不能合并');
  assert.equal(guard.canMerge(base, { ...base, source: 'private', at: 1500 }), false, '不同来源不能合并');
  assert.equal(guard.canMerge(base, { ...base, kind: 'notice', at: 1500 }), false, '非消息不能合并');
  assert.equal(guard.canMerge(base, { ...base, text: '   ', at: 1500 }), false, '空白正文不能合并');
  assert.equal(guard.canMerge(base, { ...base, text: 123, at: 1500 }), false, '非字符串正文不能合并');
  assert.equal(guard.canMerge(base, { ...base, at: 2501 }), false, '超出 1500ms 不能合并');
  assert.equal(
    guard.canMerge({ ...base, mergedCount: 9 }, { ...base, at: 1500 }),
    true,
    '合并到 9 条仍可继续',
  );
  assert.equal(
    guard.canMerge({ ...base, mergedCount: 10 }, { ...base, at: 1500 }),
    false,
    '合并满 10 条停止',
  );
  assert.equal(guard.canMerge(null, base), false, 'null 输入不 throw，直接 false');
  assert.equal(guard.canMerge(base, undefined), false);

  assert.equal(guard.countersSnapshot().merged, 2, '只有两次 true 计数');
});

console.log('\n=== M9：事件门控 ===');

check('checkEvent：meta_event 直接放行，不占事件桶、不记 dropped', () => {
  const clock = makeClock();
  const guard = createGuard({ config: { rateLimitPerMinute: 1 }, now: () => clock.now() });
  for (let i = 0; i < 100; i += 1) {
    assert.deepEqual(
      guard.checkEvent({
        event: { kind: 'meta_event', type: 'meta_event.heartbeat', userId: '50000', time: i },
      }),
      { ok: true },
      `心跳 ${i} 应放行`,
    );
  }
  assert.deepEqual(guard.countersSnapshot(), {
    rateLimited: 0, duplicates: 0, eventsDropped: 0, autoMuted: 0, merged: 0,
  });
});

check('checkEvent：同 key 30 秒内 duplicate，窗口外放行', () => {
  const clock = makeClock();
  const guard = createGuard({ config: { rateLimitPerMinute: 100 }, now: () => clock.now() });
  const event = {
    kind: 'notice',
    type: 'notice.group_recall',
    userId: '50001',
    groupId: '60001',
    time: 111,
  };

  assert.deepEqual(guard.checkEvent({ event }), { ok: true });
  assert.deepEqual(guard.checkEvent({ event }), { ok: false, reason: 'duplicate', autoMute: null });
  assert.equal(guard.countersSnapshot().duplicates, 1);
  assert.equal(guard.countersSnapshot().eventsDropped, 1);

  clock.advance(29_999);
  assert.equal(guard.checkEvent({ event }).ok, false, '29.999 秒仍在窗口内');
  clock.advance(1);
  assert.equal(guard.checkEvent({ event }).ok, true, '满 30 秒后可再放行');
});

check('checkEvent：超过每分钟额度返回 rate-limit；事件桶与消息桶互相独立', () => {
  const clock = makeClock();
  const guard = createGuard({ config: { rateLimitPerMinute: 3 }, now: () => clock.now() });

  // 同一个 userId 的消息桶先被打空，不影响事件桶。
  for (let i = 1; i <= 3; i += 1) {
    assert.equal(
      guard.checkMessage({ userId: '50002', source: 'group', text: `占消息桶-${i}` }).ok,
      true,
    );
  }
  assert.equal(
    guard.checkMessage({ userId: '50002', source: 'group', text: '占消息桶-4' }).ok,
    false,
  );

  for (let i = 0; i < 3; i += 1) {
    assert.equal(
      guard.checkEvent({ event: { kind: 'notice', type: `notice.t${i}`, userId: '50002', time: i } }).ok,
      true,
      `事件桶独立，第 ${i + 1} 条应放行`,
    );
  }
  assert.deepEqual(
    guard.checkEvent({ event: { kind: 'notice', type: 'notice.t4', userId: '50002', time: 4 } }),
    { ok: false, reason: 'rate-limit', autoMute: null },
  );

  const snap = guard.countersSnapshot();
  assert.equal(snap.rateLimited, 2, '消息限流 1 次 + 事件限流 1 次');
  assert.equal(snap.eventsDropped, 1);
});

check('checkEvent：连续限流 5 次同样触发自动禁回', () => {
  const clock = makeClock();
  const guard = createGuard({ config: { rateLimitPerMinute: 1 }, now: () => clock.now() });
  assert.equal(
    guard.checkEvent({ event: { kind: 'notice', type: 'notice.a', userId: '90001', time: 1 } }).ok,
    true,
  );
  let last = null;
  for (let i = 0; i < 5; i += 1) {
    last = guard.checkEvent({
      event: { kind: 'notice', type: `notice.b${i}`, userId: '90001', time: 10 + i },
    });
  }
  assert.deepEqual(last.autoMute, { minutes: 10, reason: AUTO_MUTE_REASON });
  assert.deepEqual(guard.countersSnapshot(), {
    rateLimited: 5,
    duplicates: 0,
    eventsDropped: 5,
    autoMuted: 1,
    merged: 0,
  });
});

console.log('\n=== M9：计数与边界 ===');

check('countersSnapshot 五项数值自洽、是独立对象；reset() 清桶并归零', () => {
  const clock = makeClock();
  const guard = createGuard({ now: () => clock.now() });

  // 消息：10 条放行 + 5 条限流（第 5 条触发自动禁回）
  for (let i = 1; i <= 10; i += 1) {
    assert.equal(guard.checkMessage({ userId: '70001', source: 'group', text: `正常-${i}` }).ok, true);
  }
  for (let i = 1; i <= 5; i += 1) {
    guard.checkMessage({ userId: '70001', source: 'group', text: `超发-${i}` });
  }
  assert.equal(guard.countersSnapshot().rateLimited, 5);
  assert.equal(guard.countersSnapshot().autoMuted, 1);

  // 60 秒后桶补满，给去重留出令牌
  clock.advance(60_000);
  assert.equal(guard.checkMessage({ userId: '70001', source: 'group', text: '重复内容' }).ok, true);
  assert.deepEqual(
    guard.checkMessage({ userId: '70001', source: 'group', text: '  重复内容  ' }),
    { ok: false, reason: 'duplicate', autoMute: null },
  );

  // meta 事件不计数；普通事件打满 10 条后第 11 条限流
  assert.equal(
    guard.checkEvent({ event: { kind: 'meta_event', type: 'meta_event.heartbeat' } }).ok,
    true,
  );
  for (let i = 0; i < 10; i += 1) {
    assert.equal(
      guard.checkEvent({ event: { kind: 'notice', type: `notice.k${i}`, userId: '70002', time: i } }).ok,
      true,
    );
  }
  assert.deepEqual(
    guard.checkEvent({ event: { kind: 'notice', type: 'notice.k11', userId: '70002', time: 11 } }),
    { ok: false, reason: 'rate-limit', autoMute: null },
  );

  assert.equal(
    guard.canMerge(
      { kind: 'message', source: 'group', userId: '70001', text: 'a', at: 0, mergedCount: 1 },
      { kind: 'message', source: 'group', userId: '70001', text: 'b', at: 1000 },
    ),
    true,
  );

  assert.deepEqual(guard.countersSnapshot(), {
    rateLimited: 6,
    duplicates: 1,
    eventsDropped: 1,
    autoMuted: 1,
    merged: 1,
  });

  // 快照必须是新对象，外部改它不能污染内部账本。
  const snapshot = guard.countersSnapshot();
  snapshot.rateLimited = 999;
  assert.equal(guard.countersSnapshot().rateLimited, 6);

  guard.reset();
  assert.deepEqual(guard.countersSnapshot(), {
    rateLimited: 0, duplicates: 0, eventsDropped: 0, autoMuted: 0, merged: 0,
  });
  assert.deepEqual(
    guard.checkMessage({ userId: '70001', source: 'group', text: '重置后' }),
    { ok: true },
    'reset 后桶应重新是满的',
  );
});

check('配置兜底与覆盖：rateLimitPerMinute 最小 1 / 非法回默认 10；autoMuteMinutes 生效', () => {
  const clock = makeClock();

  const zero = createGuard({ config: { rateLimitPerMinute: 0 }, now: () => clock.now() });
  assert.equal(zero.checkMessage({ userId: '80001', source: 'private', text: 'a' }).ok, true);
  assert.equal(zero.checkMessage({ userId: '80001', source: 'private', text: 'b' }).ok, false);

  const junk = createGuard({ config: { rateLimitPerMinute: 'abc' }, now: () => clock.now() });
  for (let i = 0; i < 10; i += 1) {
    assert.equal(junk.checkMessage({ userId: '80002', source: 'private', text: `ok-${i}` }).ok, true);
  }
  assert.equal(junk.checkMessage({ userId: '80002', source: 'private', text: '第 11 条' }).ok, false);

  const custom = createGuard({
    config: { rateLimitPerMinute: 1, autoMuteMinutes: 3 },
    now: () => clock.now(),
  });
  assert.equal(custom.checkMessage({ userId: '80003', source: 'group', text: '首条' }).ok, true);
  let last = null;
  for (let i = 0; i < 5; i += 1) {
    last = custom.checkMessage({ userId: '80003', source: 'group', text: `灌水-${i}` });
  }
  assert.equal(last.autoMute?.minutes, 3, 'autoMuteMinutes 覆盖应生效');

  // config.js 约定 autoMuteMinutes=0 是“只丢弃、不自动禁回”；不能把 0 透传给 mute.js（那里 0=永久）。
  const off = createGuard({
    config: { rateLimitPerMinute: 1, autoMuteMinutes: 0 },
    now: () => clock.now(),
  });
  assert.equal(off.checkMessage({ userId: '80004', source: 'group', text: '首条' }).ok, true);
  let blocked = null;
  for (let i = 0; i < 5; i += 1) {
    blocked = off.checkMessage({ userId: '80004', source: 'group', text: `自动禁回关闭-${i}` });
  }
  assert.equal(blocked.autoMute, null, 'autoMuteMinutes=0 不返回禁回指令');
  assert.equal(off.countersSnapshot().autoMuted, 0);
});

check('边界：userId 空仍按外部用户限流；isMain 不是 true 不享受豁免', () => {
  const clock = makeClock();
  const guard = createGuard({ config: { rateLimitPerMinute: 1 }, now: () => clock.now() });

  assert.equal(guard.checkMessage({ userId: '', source: 'group', text: 'a' }).ok, true);
  assert.deepEqual(
    guard.checkMessage({ userId: '', source: 'group', text: 'b' }),
    { ok: false, reason: 'rate-limit', autoMute: null },
  );
  assert.equal(
    guard.checkMessage({ userId: '', source: 'group', text: 'c', isMain: 'true' }).ok,
    false,
    '字符串 "true" 不算主号',
  );
});

console.log(`\n=== 汇总：${passed}/${passed + failed} 通过 ===`);
if (failed > 0) {
  console.log(`FAILED ${failed}`);
  process.exit(1);
}
console.log('ALL PASS');
