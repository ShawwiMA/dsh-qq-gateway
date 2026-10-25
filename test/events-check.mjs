// events 纯逻辑验收：OneBot 11 四类非 message 帧的解析归一化 / 中文描述 / 过滤 / 有界存储。
// 跑法：node ~/.dsh/bundles/dsh-qq-gateway/test/events-check.mjs
import assert from 'node:assert/strict';

import {
  EVENT,
  EventStore,
  describeEvent,
  eventKey,
  matchesEventFilter,
  parseEventFrame,
} from '../lib/gateway/events.js';

const BOT = 10002;
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function check(name, fn) {
  try {
    const detail = fn();
    record(name, true, typeof detail === 'string' ? detail : undefined);
  } catch (err) {
    record(name, false, err.message);
  }
}

/** 补默认 self_id/time 的帧，省得每个用例都写。 */
function frame(extra) {
  return { self_id: BOT, time: 1700000000, ...extra };
}

/** 解析并断言成功，返回归一化事件。 */
function ev(extra, opts = { botQQ: BOT }) {
  const parsed = parseEventFrame(frame(extra), opts);
  assert.equal(parsed.ok, true, `帧应解析成功：${JSON.stringify(extra)}`);
  return parsed.event;
}

console.log('=== events 纯逻辑验收 ===');

check('parseEventFrame: 坏帧被拒（not-object / not-event）', () => {
  for (const bad of [null, undefined, 42, 'x', []]) {
    assert.deepEqual(parseEventFrame(bad, { botQQ: BOT }), { ok: false, reason: 'not-object' });
  }
  for (const bad of [{}, { post_type: 'message', message_type: 'private' }, { post_type: 'action_response' }]) {
    assert.deepEqual(parseEventFrame(bad, { botQQ: BOT }), { ok: false, reason: 'not-event' });
  }
});

check('parseEventFrame: group_recall（带 operator_id）归一化', () => {
  const parsed = parseEventFrame(frame({
    post_type: 'notice',
    notice_type: 'group_recall',
    group_id: 123456,
    user_id: 10001,
    operator_id: 9001,
    message_id: 99,
  }), { botQQ: BOT });
  assert.equal(parsed.ok, true);
  const e = parsed.event;
  assert.equal(e.kind, EVENT.NOTICE);
  assert.equal(e.type, 'notice.group_recall');
  assert.equal(e.subType, null);
  assert.equal(e.groupId, '123456');
  assert.equal(e.userId, '10001');
  assert.equal(e.operatorId, '9001');
  assert.equal(e.messageId, '99');
  assert.equal(e.selfId, String(BOT));
  assert.equal(e.time, 1700000000);
  assert.equal(e.raw.post_type, 'notice');
});

check('parseEventFrame: notice 各类型字段映射', () => {
  const cases = [
    ['friend_recall', { user_id: 10001, message_id: 9 }, { userId: '10001', messageId: '9' }],
    ['group_recall', { group_id: 123, user_id: 10001, operator_id: 9001, message_id: 9 }, { groupId: '123', userId: '10001', operatorId: '9001', messageId: '9' }],
    ['group_increase', { group_id: 123, user_id: 10001, operator_id: 9001, sub_type: 'approve' }, { subType: 'approve', operatorId: '9001' }],
    ['group_decrease', { group_id: 123, user_id: 10001, operator_id: 9001, sub_type: 'kick' }, { subType: 'kick' }],
    ['group_admin', { group_id: 123, user_id: 10001, sub_type: 'set' }, { subType: 'set' }],
    ['group_ban', { group_id: 123, user_id: 10001, operator_id: 9001, duration: 600, sub_type: 'ban' }, { subType: 'ban', duration: 600 }],
    ['friend_add', { user_id: 10001 }, { userId: '10001' }],
    ['group_file_upload', { group_id: 123, user_id: 10001, file: { id: 'f1', name: 'a.txt', size: 1234, url: 'https://x/a.txt' } }, { file: { id: 'f1', name: 'a.txt', size: 1234, url: 'https://x/a.txt' } }],
    ['group_card', { group_id: 123, user_id: 10001, card_new: '新名片', card_old: '旧名片' }, { cardNew: '新名片', cardOld: '旧名片' }],
    ['essence', { group_id: 123, message_id: 9, operator_id: 9001, sub_type: 'add' }, { subType: 'add', messageId: '9' }],
    ['offline_file', { user_id: 10001, file: { name: 'b.zip', size: 99, url: 'https://x/b.zip' } }, { file: { id: null, name: 'b.zip', size: 99, url: 'https://x/b.zip' } }],
    ['notify', { sub_type: 'poke', group_id: 123, user_id: 10001, target_id: 9001 }, { subType: 'poke', targetId: '9001' }],
  ];
  for (const [noticeType, extra, expected] of cases) {
    const e = ev({ post_type: 'notice', notice_type: noticeType, ...extra });
    assert.equal(e.kind, EVENT.NOTICE);
    assert.equal(e.type, `notice.${noticeType}`);
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual(e[key], value, `${noticeType}.${key}`);
    }
  }
  return `${cases.length} 种 notice_type`;
});

check('parseEventFrame: 未知 notice_type 不丢帧', () => {
  const e = ev({ post_type: 'notice', notice_type: 'group_msg_emoji_like', group_id: 123456, user_id: 10001 });
  assert.equal(e.kind, EVENT.NOTICE);
  assert.equal(e.type, 'notice.group_msg_emoji_like');
  assert.equal(e.groupId, '123456');
  assert.equal(e.userId, '10001');
});

check('parseEventFrame: request friend / group', () => {
  const friend = ev({ post_type: 'request', request_type: 'friend', user_id: 10001, flag: 'abc', comment: '你好' });
  assert.equal(friend.kind, EVENT.REQUEST);
  assert.equal(friend.type, 'request.friend');
  assert.equal(friend.userId, '10001');
  assert.equal(friend.flag, 'abc');
  assert.equal(friend.comment, '你好');
  assert.equal(friend.groupId, null);
  assert.equal(eventKey(friend), 'request');

  const group = ev({ post_type: 'request', request_type: 'group', group_id: 123456, user_id: 10001, flag: 'g1', comment: '申请理由' });
  assert.equal(group.type, 'request.group');
  assert.equal(group.groupId, '123456');
  assert.equal(group.flag, 'g1');
  return 'friend + group';
});

check('parseEventFrame: meta_event heartbeat / lifecycle', () => {
  const hb = ev({ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 30000, status: { online: true, good: true } });
  assert.equal(hb.kind, EVENT.META_EVENT);
  assert.equal(hb.type, 'meta_event.heartbeat');
  assert.equal(hb.interval, 30000);
  assert.deepEqual(hb.status, { online: true, good: true });
  assert.equal(eventKey(hb), 'meta_event.heartbeat');

  const enable = ev({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'enable' });
  assert.equal(enable.type, 'meta_event.lifecycle');
  assert.equal(enable.subType, 'enable');
  assert.equal(eventKey(enable), 'meta_event.lifecycle');
  assert.equal(ev({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'disable' }).subType, 'disable');
  return 'heartbeat + enable/disable';
});

check('parseEventFrame: message_sent private / group', () => {
  const priv = ev({ post_type: 'message_sent', message_type: 'private', message_id: 88, user_id: 10001 });
  assert.equal(priv.kind, EVENT.MESSAGE_SENT);
  assert.equal(priv.type, 'message_sent.private');
  assert.equal(priv.messageType, 'private');
  assert.equal(priv.messageId, '88');
  assert.equal(priv.userId, '10001');
  assert.equal(priv.groupId, null);
  assert.equal(eventKey(priv), 'message_sent');

  const grp = ev({ post_type: 'message_sent', message_type: 'group', message_id: 77, group_id: 123456, user_id: 10001 });
  assert.equal(grp.type, 'message_sent.group');
  assert.equal(grp.messageId, '77');
  assert.equal(grp.groupId, '123456');
  return 'private + group';
});

check('parseEventFrame: self_id 校验（不一致拒绝、一致/缺省放行）', () => {
  const base = { post_type: 'notice', notice_type: 'friend_add', user_id: 10001 };
  assert.deepEqual(parseEventFrame(frame({ ...base, self_id: 999 }), { botQQ: BOT }), { ok: false, reason: 'wrong-self' });
  assert.equal(parseEventFrame(frame(base), { botQQ: BOT }).ok, true);
  assert.equal(parseEventFrame(frame({ ...base, self_id: '10002' }), { botQQ: BOT }).ok, true, '数字/字符串不敏感');
  const noSelf = parseEventFrame({ post_type: 'notice', notice_type: 'friend_add', user_id: 10001 });
  assert.equal(noSelf.ok, true);
  assert.equal(noSelf.event.selfId, null);
  assert.equal(parseEventFrame(frame(base), null).ok, true, 'opts 缺省放行');
});

check('parseEventFrame: 缺 time 用当前时间（unix 秒）', () => {
  const before = Math.floor(Date.now() / 1000);
  const parsed = parseEventFrame({ post_type: 'notice', notice_type: 'friend_add', user_id: 1, self_id: BOT });
  const after = Math.floor(Date.now() / 1000);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.event.time >= before && parsed.event.time <= after, `time=${parsed.event.time}`);
});

check('describeEvent: 12+ 类型中文描述带关键字段', () => {
  const cases = [
    [{ post_type: 'notice', notice_type: 'group_recall', group_id: 123456, user_id: 10001, message_id: 99 }, ['群', '123456', '10001', '99']],
    [{ post_type: 'notice', notice_type: 'group_recall', group_id: 123456, user_id: 10001, operator_id: 9001, message_id: 99 }, ['9001', '撤回']],
    [{ post_type: 'notice', notice_type: 'group_decrease', group_id: 123456, user_id: 10002, operator_id: 10001, sub_type: 'kick' }, ['被踢出', '10002', '10001']],
    [{ post_type: 'notice', notice_type: 'group_increase', group_id: 123456, user_id: 10002, operator_id: 10001, sub_type: 'approve' }, ['新增成员', '批准入群', '10002']],
    [{ post_type: 'notice', notice_type: 'group_ban', group_id: 123456, user_id: 10002, operator_id: 10001, duration: 600, sub_type: 'ban' }, ['禁言', '600', '10002']],
    [{ post_type: 'notice', notice_type: 'group_ban', group_id: 123456, user_id: 10002, operator_id: 10001, sub_type: 'lift_ban' }, ['解除禁言', '10002']],
    [{ post_type: 'notice', notice_type: 'friend_recall', user_id: 10001, message_id: 99 }, ['好友', '10001', '99', '撤回']],
    [{ post_type: 'notice', notice_type: 'friend_add', user_id: 10001 }, ['新增好友', '10001']],
    [{ post_type: 'notice', notice_type: 'group_file_upload', group_id: 123456, user_id: 10001, file: { id: 'f1', name: 'a.txt', size: 1234, url: 'https://x/a.txt' } }, ['上传了文件', 'a.txt', '1234']],
    [{ post_type: 'notice', notice_type: 'group_card', group_id: 123456, user_id: 10001, card_new: '新名片', card_old: '旧名片' }, ['群名片', '旧名片', '新名片']],
    [{ post_type: 'notice', notice_type: 'essence', group_id: 123456, message_id: 99, operator_id: 9001, sub_type: 'add' }, ['精华', '99', '9001']],
    [{ post_type: 'notice', notice_type: 'offline_file', user_id: 10001, file: { name: 'b.zip', size: 99, url: 'https://x/b.zip' } }, ['离线文件', 'b.zip', '99']],
    [{ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: 123456, user_id: 10001, target_id: 10002 }, ['戳了戳', '10001', '10002']],
    [{ post_type: 'notice', notice_type: 'group_admin', group_id: 123456, user_id: 10001, sub_type: 'set' }, ['管理员', '10001']],
    [{ post_type: 'request', request_type: 'friend', user_id: 10001, flag: 'abc', comment: '你好' }, ['加好友申请', '10001', 'flag=abc', '你好']],
    [{ post_type: 'request', request_type: 'group', group_id: 123456, user_id: 10001, flag: 'abc', comment: '想进群' }, ['加群申请', '10001', '123456', 'flag=abc']],
    [{ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 30000, status: { online: true, good: true } }, ['心跳', '在线', 'good', '30000']],
    [{ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 5000, status: { online: false, good: false } }, ['心跳', '离线', '异常', '5000']],
    [{ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'enable' }, ['连接生命周期', 'enable']],
    [{ post_type: 'message_sent', message_type: 'private', message_id: 88, user_id: 10001 }, ['私聊', '88', '10001']],
    [{ post_type: 'message_sent', message_type: 'group', message_id: 77, group_id: 123456 }, ['群消息', '77', '123456']],
  ];
  for (const [raw, keywords] of cases) {
    const text = describeEvent(ev(raw));
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0, '描述不能为空');
    assert.equal(text.includes('\n'), false, `描述不应含换行：${text}`);
    for (const keyword of keywords) {
      assert.ok(text.includes(String(keyword)), `${text} 应包含 ${keyword}`);
    }
  }
  assert.ok(cases.length >= 12);
  return `${cases.length} 种描述`;
});

check('describeEvent: 未知 notice_type 仍有可读描述', () => {
  const text = describeEvent(ev({ post_type: 'notice', notice_type: 'group_msg_emoji_like', group_id: 123456, user_id: 10001 }));
  assert.ok(text.includes('group_msg_emoji_like'), text);
  assert.ok(text.includes('123456'), text);
  assert.equal(text.includes('\n'), false, text);
});

check('describeEvent: 附言里的换行被压成一行', () => {
  const text = describeEvent(ev({ post_type: 'request', request_type: 'friend', user_id: 10001, flag: 'f1', comment: '第一行\n第二行' }));
  assert.equal(text.includes('\n'), false, text);
  assert.ok(text.includes('第一行'), text);
  assert.ok(text.includes('第二行'), text);
});

check('eventKey: 四类事件键', () => {
  assert.equal(eventKey(ev({ post_type: 'notice', notice_type: 'group_recall', group_id: 1, user_id: 2, message_id: 3 })), 'notice.group_recall');
  assert.equal(eventKey(ev({ post_type: 'request', request_type: 'friend', user_id: 2, flag: 'f' })), 'request');
  assert.equal(eventKey(ev({ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 1, status: {} })), 'meta_event.heartbeat');
  assert.equal(eventKey(ev({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' })), 'meta_event.lifecycle');
  assert.equal(eventKey(ev({ post_type: 'message_sent', message_type: 'private', message_id: 5, user_id: 2 })), 'message_sent');
  assert.equal(eventKey(null), '');
});

check('matchesEventFilter: 精确 / notice.* / * / 逗号串 / 空过滤', () => {
  const cases = [
    ['notice.group_recall', 'notice.group_recall', true],
    ['notice.group_recall', 'notice.*', true],
    ['notice.group_recall', '*', true],
    ['notice.group_recall', 'notice.*,request', true],
    ['notice.group_recall', 'meta_event.*', false],
    ['request', 'notice.*, request', true],
    ['request', 'request', true],
    ['meta_event.heartbeat', 'meta_event.*', true],
    ['meta_event.heartbeat', 'notice.*', false],
    ['message_sent', 'message_sent', true],
    ['notice.group_recall', '', false],
    ['notice.group_recall', '   ', false],
    ['notice.group_recall', [], false],
    ['notice.group_recall', null, false],
    ['notice.group_recall', ['notice.*', 'meta_event.*'], true],
  ];
  for (const [key, filter, expected] of cases) {
    assert.equal(matchesEventFilter(key, filter), expected, `${key} vs ${JSON.stringify(filter)}`);
  }
  return `${cases.length} 组过滤`;
});

check('EventStore: push 赋 seq/at 并返回存储事件', () => {
  let nowMs = 1700000000000;
  const store = new EventStore({ now: () => nowMs });
  const first = store.push(ev({ post_type: 'notice', notice_type: 'friend_add', user_id: 10001 }));
  nowMs += 1234;
  const second = store.push(ev({ post_type: 'notice', notice_type: 'group_recall', group_id: 123456, user_id: 10001, message_id: 9 }));
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(first.at, '2023-11-14T22:13:20.000Z');
  assert.equal(second.at, '2023-11-14T22:13:21.234Z');
  assert.equal(store.size, 2);
  return `seq=${first.seq},${second.seq}`;
});

check('EventStore: 超过 max 丢最旧，size 有界', () => {
  const store = new EventStore({ max: 3 });
  for (let i = 0; i < 5; i += 1) store.push(ev({ post_type: 'notice', notice_type: 'friend_add', user_id: 10000 + i }));
  assert.equal(store.size, 3);
  assert.deepEqual(store.list().map((event) => event.seq), [3, 4, 5]);
  assert.equal(store.counters().total, 5, '累计计数不受裁剪影响');
  assert.equal(store.counters().byKind.notice, 5);
  assert.ok(!store.list().some((event) => event.userId === '10000'), '最旧的应被挤掉');
});

check('EventStore: list 按 kind / sinceSeq / limit 过滤', () => {
  const store = new EventStore({ max: 10 });
  store.push(ev({ post_type: 'notice', notice_type: 'group_recall', group_id: 1, user_id: 10001, message_id: 1 }));
  store.push(ev({ post_type: 'notice', notice_type: 'friend_add', user_id: 10001 }));
  store.push(ev({ post_type: 'request', request_type: 'friend', user_id: 10001, flag: 'f1' }));
  store.push(ev({ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 30000, status: { online: true, good: true } }));
  store.push(ev({ post_type: 'message_sent', message_type: 'private', message_id: 88, user_id: 10001 }));
  assert.deepEqual(store.list().map((event) => event.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(store.list({ kind: 'notice' }).map((event) => event.seq), [1, 2]);
  assert.deepEqual(store.list({ sinceSeq: 2 }).map((event) => event.seq), [3, 4, 5]);
  assert.deepEqual(store.list({ sinceSeq: 2, limit: 2 }).map((event) => event.seq), [3, 4]);
  assert.deepEqual(store.list({ limit: 0 }), []);
  assert.equal(store.list().length, 5);
  return 'kind/sinceSeq/limit 自洽';
});

check('EventStore: recent(n) 取最近 n 条（旧的在前）', () => {
  const store = new EventStore({ max: 10 });
  for (let i = 0; i < 5; i += 1) store.push(ev({ post_type: 'notice', notice_type: 'friend_add', user_id: 10000 + i }));
  assert.deepEqual(store.recent(2).map((event) => event.seq), [4, 5]);
  assert.deepEqual(store.recent().map((event) => event.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(store.recent(0), []);
});

check('EventStore: requests / resolveRequest', () => {
  const store = new EventStore();
  store.push(ev({ post_type: 'request', request_type: 'friend', user_id: 10001, flag: 'f1', comment: '你好' }));
  store.push(ev({ post_type: 'request', request_type: 'group', group_id: 123456, user_id: 10002, flag: 'g1' }));
  store.push(ev({ post_type: 'notice', notice_type: 'friend_add', user_id: 10001 }));
  assert.equal(store.requests().length, 2);
  const resolved = store.resolveRequest('f1');
  assert.equal(resolved.flag, 'f1');
  assert.equal(resolved.resolved, true);
  assert.deepEqual(store.requests().map((event) => event.flag), ['g1']);
  assert.equal(store.resolveRequest('f1'), null, '重复 resolve 返回 null');
  assert.equal(store.resolveRequest('nope'), null);
  assert.equal(store.resolveRequest(null), null);
  assert.equal(store.resolveRequest('g1').flag, 'g1');
  assert.equal(store.requests().length, 0);
  return '重复/未知 flag 返回 null';
});

check('EventStore: heartbeat / heartbeatAgeMs（注入 now 测超时）', () => {
  let nowMs = 1700000000000;
  const store = new EventStore({ now: () => nowMs });
  assert.equal(store.heartbeat(), null);
  assert.equal(store.heartbeatAgeMs(), null, '没有心跳返回 null');
  store.push(ev({ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 30000, status: { online: true, good: true } }));
  assert.equal(store.heartbeat().type, 'meta_event.heartbeat');
  assert.equal(store.heartbeatAgeMs(), 0);
  nowMs += 30000;
  assert.equal(store.heartbeatAgeMs(), 30000);
  assert.equal(store.heartbeat().interval, 30000);
  nowMs += 999;
  assert.equal(store.heartbeatAgeMs(), 30999);
  return '注入 now 后 ageMs 精确';
});

check('EventStore: lifecycle 取最近一次', () => {
  const store = new EventStore();
  assert.equal(store.lifecycle(), null);
  store.push(ev({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' }));
  store.push(ev({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'enable' }));
  const life = store.lifecycle();
  assert.equal(life.kind, EVENT.META_EVENT);
  assert.equal(life.subType, 'enable');
});

check('EventStore: counters 按 kind / key 累计', () => {
  const store = new EventStore({ max: 100 });
  store.push(ev({ post_type: 'notice', notice_type: 'group_recall', group_id: 1, user_id: 10001, message_id: 1 }));
  store.push(ev({ post_type: 'notice', notice_type: 'group_recall', group_id: 1, user_id: 10002, message_id: 2 }));
  store.push(ev({ post_type: 'notice', notice_type: 'friend_add', user_id: 10003 }));
  store.push(ev({ post_type: 'request', request_type: 'friend', user_id: 10004, flag: 'f1' }));
  store.push(ev({ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 30000, status: { online: true, good: true } }));
  store.push(ev({ post_type: 'message_sent', message_type: 'private', message_id: 88, user_id: 10005 }));
  const counters = store.counters();
  assert.equal(counters.total, 6);
  assert.deepEqual(counters.byKind, { notice: 3, request: 1, meta_event: 1, message_sent: 1 });
  assert.equal(counters.byKey['notice.group_recall'], 2);
  assert.equal(counters.byKey['notice.friend_add'], 1);
  assert.equal(counters.byKey.request, 1);
  assert.equal(counters.byKey['meta_event.heartbeat'], 1);
  assert.equal(counters.byKey.message_sent, 1);
  return 'kind/key 计数自洽';
});

check('EventStore: snapshot 形状完整', () => {
  let nowMs = 1700000000000;
  const store = new EventStore({ now: () => nowMs });
  store.push(ev({ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 30000, status: { online: true, good: true } }));
  nowMs += 5000;
  store.push(ev({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'enable' }));
  store.push(ev({ post_type: 'request', request_type: 'friend', user_id: 10001, flag: 'f1' }));
  store.push(ev({ post_type: 'notice', notice_type: 'friend_recall', user_id: 10001, message_id: 9 }));
  const snap = store.snapshot();
  assert.deepEqual(Object.keys(snap).sort(), ['counters', 'heartbeat', 'lifecycle', 'pendingRequests', 'recent', 'total']);
  assert.equal(snap.total, 4);
  assert.equal(snap.counters.total, 4);
  assert.equal(snap.counters.byKind.notice, 1);
  assert.equal(snap.heartbeat.interval, 30000);
  assert.equal(snap.heartbeat.online, true);
  assert.deepEqual(snap.heartbeat.status, { online: true, good: true });
  assert.equal(typeof snap.heartbeat.at, 'string');
  assert.ok(snap.heartbeat.ageMs >= 0);
  assert.equal(snap.lifecycle.subType, 'enable');
  assert.equal(typeof snap.lifecycle.at, 'string');
  assert.equal(snap.pendingRequests.length, 1);
  assert.equal(snap.pendingRequests[0].flag, 'f1');
  assert.equal(snap.recent.length, 4);
  assert.equal(snap.recent[0].type, 'meta_event.heartbeat', 'recent 旧的在前');
  assert.equal(snap.heartbeat.ageMs, store.heartbeatAgeMs());
  return `total=${snap.total} recent=${snap.recent.length} age=${snap.heartbeat.ageMs}ms`;
});

check('EventStore: snapshot.recent 最多 10 条', () => {
  const store = new EventStore({ max: 20 });
  for (let i = 0; i < 12; i += 1) store.push(ev({ post_type: 'notice', notice_type: 'friend_add', user_id: 10000 + i }));
  assert.equal(store.snapshot().recent.length, 10);
  assert.equal(store.snapshot().recent[0].seq, 3);
  return 'recent 截到 10 条';
});

const failed = results.filter((item) => !item.ok);
console.log(`\nPASS ${results.length - failed.length} / FAIL ${failed.length}`);
if (failed.length) {
  for (const item of failed) console.log(`  FAIL ${item.name} — ${item.detail}`);
}
process.exitCode = failed.length ? 1 : 0;
