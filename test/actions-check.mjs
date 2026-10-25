// actions.js 离线验收：动作目录 / 参数归一化 / 出站消息段构造（纯逻辑，不碰网络）。
// 覆盖：全部动作的最小合法参数、缺必填/未知参数/类型错误、buildSegments 全部段落类型、
//       图片魔术字节/超限/不存在路径、forward 节点转换、poke 段被拒。
// 跑法：node test/actions-check.mjs（在 bundle 目录下）
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import {
  ACTIONS,
  DEFAULT_MAX_IMAGE_BYTES,
  MAX_SEGMENTS,
  actionNames,
  actionRisk,
  buildSegments,
  describeAction,
  listActions,
  normalizeAction,
} from '../lib/gateway/actions.js';

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
    record(name, false, err?.message ?? String(err));
  }
}
function expectRejected(result, pattern, label) {
  assert.equal(result.ok, false, `${label} 应该被拒绝，实际却通过`);
  assert.equal(typeof result.error, 'string', `${label} 缺少中文错误信息`);
  assert.ok(result.error.length > 0, `${label} 错误信息为空`);
  assert.match(result.error, pattern, `${label} 的错误信息不够具体：${result.error}`);
}

// 契约里必须覆盖的动作清单（63 个；后 4 个是 M6.1 补的群公告/群分享链接）
const EXPECTED_NAMES = [
  'send_private_msg', 'send_group_msg', 'send_msg', 'delete_msg', 'get_msg', 'get_forward_msg',
  'send_private_forward_msg', 'send_group_forward_msg', 'mark_msg_as_read', 'set_msg_emoji_like',
  'send_poke', 'set_input_status', 'send_like', 'get_image', 'get_record', 'get_file',
  'can_send_image', 'can_send_record',
  'get_login_info', 'get_status', 'get_version_info', 'get_stranger_info', 'get_friend_list',
  'get_group_list', 'get_group_info', 'get_group_member_info', 'get_group_member_list',
  'get_group_honor_info', 'get_group_at_all_remain', 'get_group_msg_history',
  'get_friend_msg_history', 'get_essence_msg_list', 'get_group_file_system_info',
  'get_group_root_files', 'get_group_files_by_folder', 'get_group_file_url', 'get_private_file_url',
  'set_group_kick', 'set_group_ban', 'set_group_anonymous_ban', 'set_group_whole_ban',
  'set_group_admin', 'set_group_card', 'set_group_name', 'set_group_leave',
  'set_group_special_title', 'set_friend_add_request', 'set_group_add_request', 'set_essence_msg',
  'delete_essence_msg', 'upload_group_file', 'delete_group_file', 'upload_private_file',
  '_send_group_notice', '_get_group_notice', 'set_online_status', 'set_qq_profile',
  'set_qq_avatar', 'set_group_portrait',
  // M6.1：拉人进群用的群分享链接 / Ark 卡片，以及删群公告
  'get_group_share_link', 'ArkShareGroup', 'send_group_ark_share', '_del_group_notice',
];

// 1x1 透明 PNG（合法图片字节）
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

const TMP = mkdtempSync(join(tmpdir(), 'qq-actions-'));
const PNG_PATH = join(TMP, 'pic.png');
const JPEG_PATH = join(TMP, 'pic.jpg');
const BMP_PATH = join(TMP, 'pic.bmp');
const BAD_PATH = join(TMP, 'bad.png');
const REC_PATH = join(TMP, 'voice.amr');
const MISSING_PATH = join(TMP, 'missing.png');
writeFileSync(PNG_PATH, PNG_BYTES);
writeFileSync(JPEG_PATH, JPEG_BYTES);
writeFileSync(BMP_PATH, Buffer.concat([Buffer.from('BM'), Buffer.alloc(26)]));
writeFileSync(BAD_PATH, Buffer.from('这不是图片，只是改了扩展名'));
writeFileSync(REC_PATH, Buffer.from('#!AMR\n fake voice bytes'));

/** 按参数 type 生成一个合法的最小值。 */
function sampleValue(spec) {
  switch (spec.type) {
    case 'qq': return 10001;
    case 'int': return 10;
    case 'string': return 'x';
    case 'bool': return true;
    case 'message': return '你好';
    case 'msgid': return 12345;
    case 'forward': return [{ user_id: 10001, nickname: '测试', content: '转发内容' }];
    case 'array': return [1];
    case 'object': return { a: 1 };
    case 'enum': return spec.values[0];
    default: throw new Error(`测试不认识参数类型：${spec.type}`);
  }
}
/** 只带必填参数的最小调用参数。 */
function minimalArgs(name) {
  const args = {};
  for (const spec of ACTIONS[name].params) if (spec.required) args[spec.name] = sampleValue(spec);
  return args;
}

// ===========================================================================
console.log('=== 动作目录 ===');

check('动作目录覆盖契约里的全部动作', () => {
  assert.equal(actionNames().length, EXPECTED_NAMES.length);
  for (const name of EXPECTED_NAMES) assert.ok(ACTIONS[name], `缺少动作 ${name}`);
});

check('每个动作都有合法的 category/risk/summary/napcatOnly/params', () => {
  const categories = new Set(['message', 'media', 'query', 'manage', 'meta']);
  const risks = new Set(['read', 'write', 'destructive']);
  const types = new Set(['qq', 'int', 'string', 'bool', 'message', 'msgid', 'forward', 'array', 'object', 'enum']);
  for (const name of actionNames()) {
    const def = ACTIONS[name];
    assert.ok(categories.has(def.category), `${name} 的 category 不合法：${def.category}`);
    assert.ok(risks.has(def.risk), `${name} 的 risk 不合法：${def.risk}`);
    assert.equal(typeof def.summary, 'string', `${name} 缺少 summary`);
    assert.ok(def.summary.length > 0, `${name} 的 summary 为空`);
    assert.equal(typeof def.napcatOnly, 'boolean', `${name} 的 napcatOnly 不是布尔`);
    assert.ok(Array.isArray(def.params), `${name} 的 params 不是数组`);
    const seen = new Set();
    for (const spec of def.params) {
      assert.equal(typeof spec.name, 'string', `${name} 有参数缺 name`);
      assert.ok(!seen.has(spec.name), `${name} 的参数 ${spec.name} 重复`);
      seen.add(spec.name);
      assert.ok(types.has(spec.type), `${name}.${spec.name} 的 type 不合法：${spec.type}`);
      assert.equal(typeof spec.required, 'boolean', `${name}.${spec.name} 的 required 不是布尔`);
      assert.equal(typeof spec.desc, 'string', `${name}.${spec.name} 缺 desc`);
      if (spec.type === 'enum') assert.ok(Array.isArray(spec.values) && spec.values.length > 0, `${name}.${spec.name} 缺 values`);
    }
  }
});

check('危险动作的风险分级正确（kick/ban/leave/delete 类必须是 destructive）', () => {
  for (const name of ['set_group_kick', 'set_group_ban', 'set_group_anonymous_ban', 'set_group_whole_ban',
    'set_group_leave', 'delete_essence_msg', 'delete_group_file']) {
    assert.equal(actionRisk(name), 'destructive', `${name} 应为 destructive`);
  }
  assert.equal(actionRisk('send_group_msg'), 'write');
  assert.equal(actionRisk('delete_msg'), 'write', '撤回消息按契约是 write');
  assert.equal(actionRisk('get_group_list'), 'read');
  assert.equal(actionRisk('no_such_action'), null);
});

check('describeAction 生成签名，未知动作返回 null', () => {
  assert.equal(describeAction('send_group_msg'), 'send_group_msg(group_id, message)：发群消息');
  assert.equal(describeAction('get_status'), 'get_status()：获取运行状态');
  assert.equal(describeAction('no_such_action'), null);
});

check('listActions 支持 category 过滤，返回的浅拷贝不污染目录', () => {
  const all = listActions();
  assert.equal(all.length, actionNames().length);
  const messageActions = listActions({ category: 'message' });
  assert.ok(messageActions.length > 0);
  assert.ok(messageActions.every((item) => item.category === 'message'));
  assert.deepEqual(Object.keys(messageActions[0]).sort(), ['category', 'name', 'params', 'risk', 'summary']);
  const before = ACTIONS[messageActions[0].name].params.length;
  messageActions[0].params.push({ name: '注入参数' });
  assert.equal(ACTIONS[messageActions[0].name].params.length, before, '修改返回值不该污染 ACTIONS');
  assert.equal(listActions({ category: 'media' }).length, 0);
});

// ===========================================================================
console.log('\n=== 参数归一化 ===');

check('每个动作都能用最小合法参数归一化成功', () => {
  for (const name of actionNames()) {
    const args = minimalArgs(name);
    const result = normalizeAction(name, args);
    assert.equal(result.ok, true, `${name} 归一化失败：${result.error}`);
    assert.equal(result.action, name);
    assert.deepEqual(Object.keys(result.params).sort(), Object.keys(args).sort(), `${name} 归一化后参数集合不一致`);
  }
  return `${actionNames().length} 个动作`;
});

check('可选参数按类型归一化，undefined 可选参数被忽略', () => {
  const result = normalizeAction('send_group_msg', {
    group_id: '123456',
    message: [{ type: 'text', text: 'hi' }],
    auto_escape: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.params.group_id, 123456);
  assert.deepEqual(result.params.message, [{ type: 'text', data: { text: 'hi' } }]);
  assert.equal(result.params.auto_escape, true);

  const noOptional = normalizeAction('set_group_ban', { group_id: 1, user_id: 2, duration: undefined });
  assert.equal(noOptional.ok, true);
  assert.deepEqual(noOptional.params, { group_id: 1, user_id: 2 });
});

check('缺必填参数被拒，错误信息指出动作名与参数名', () => {
  for (const name of actionNames()) {
    const required = ACTIONS[name].params.filter((spec) => spec.required);
    if (required.length === 0) continue;
    const args = {};
    for (const spec of required.slice(1)) args[spec.name] = sampleValue(spec);
    const result = normalizeAction(name, args);
    expectRejected(result, new RegExp(name), `${name} 缺 ${required[0].name}`);
    assert.match(result.error, new RegExp(required[0].name), `${name} 的错误没提参数名`);
  }
});

check('未知参数被拒，错误信息指出动作名与参数名', () => {
  for (const name of ['send_group_msg', 'get_group_list', 'set_group_ban']) {
    const args = { ...minimalArgs(name), no_such_param: 1 };
    const result = normalizeAction(name, args);
    expectRejected(result, new RegExp(name), `${name} 带未知参数`);
    assert.match(result.error, /no_such_param/, `${name} 的错误没提参数名`);
  }
  const unknownAction = normalizeAction('no_such_action', {});
  expectRejected(unknownAction, /no_such_action/, '未知动作');
});

check('类型错误被拒（qq/int/string/bool/message/enum/forward）', () => {
  const cases = [
    ['send_group_msg', { group_id: '12a', message: 'x' }, /group_id/],
    ['send_group_msg', { group_id: 1.5, message: 'x' }, /group_id/],
    ['send_group_msg', { group_id: 1, message: 42 }, /message/],
    ['send_group_msg', { group_id: 1, message: 'x', auto_escape: 'yes' }, /auto_escape/],
    ['set_group_ban', { group_id: 1, user_id: 2, duration: '5秒' }, /duration/],
    ['get_group_honor_info', { group_id: 1, type: 'bogus' }, /type/],
    ['send_msg', { message_type: 'channel', message: 'x' }, /message_type/],
    ['send_group_forward_msg', { group_id: 1, messages: [{ content: 42 }] }, /messages/],
    ['send_group_forward_msg', { group_id: 1, messages: [] }, /messages/],
    ['set_friend_add_request', { flag: 'f' }, /approve/],
  ];
  for (const [name, args, pattern] of cases) {
    const result = normalizeAction(name, args);
    expectRejected(result, pattern, `${name} 类型错误`);
    assert.match(result.error, new RegExp(name), `${name} 的错误没提动作名`);
  }
});

check('qq/int 只接受安全整数（数字或纯数字字符串）', () => {
  assert.equal(normalizeAction('send_private_msg', { user_id: '10001', message: 'x' }).params.user_id, 10001);
  assert.equal(normalizeAction('get_group_info', { group_id: 123 }).params.group_id, 123);
  expectRejected(normalizeAction('send_private_msg', { user_id: '10001.5', message: 'x' }), /user_id/, '小数 QQ 号');
  expectRejected(normalizeAction('send_private_msg', { user_id: ' 10001', message: 'x' }), /user_id/, '带空格 QQ 号');
  expectRejected(normalizeAction('get_group_info', { group_id: true }), /group_id/, '布尔群号');
});

check('msgid 兼容数字/数字字符串/非数字字符串（NapCat 哈希 ID 可能是字符串）', () => {
  assert.deepEqual(normalizeAction('delete_msg', { message_id: 123 }).params, { message_id: 123 });
  assert.deepEqual(normalizeAction('delete_msg', { message_id: '456' }).params, { message_id: 456 });
  assert.deepEqual(normalizeAction('delete_msg', { message_id: 'a1b2c3' }).params, { message_id: 'a1b2c3' });
  const huge = '9007199254740993';
  assert.deepEqual(normalizeAction('delete_msg', { message_id: huge }).params, { message_id: huge });
  expectRejected(normalizeAction('delete_msg', { message_id: {} }), /message_id/, '对象当消息 ID');
  expectRejected(normalizeAction('delete_msg', { message_id: '' }), /message_id/, '空字符串当消息 ID');
});

check('参数别名：get_forward_msg 的 id、set_group_anonymous_ban 的 anonymous_flag', () => {
  assert.deepEqual(normalizeAction('get_forward_msg', { id: 7 }).params, { message_id: 7 });
  const ban = normalizeAction('set_group_anonymous_ban', { group_id: 1, anonymous_flag: 'abc', duration: 60 });
  assert.equal(ban.ok, true, ban.error);
  assert.deepEqual(ban.params, { group_id: 1, flag: 'abc', duration: 60 });
  expectRejected(
    normalizeAction('set_group_anonymous_ban', { group_id: 1, flag: 'a', anonymous_flag: 'b' }),
    /重复/,
    '别名与原参数同时给',
  );
});

check('message 参数：字符串包成 text 段，不解析 CQ 码', () => {
  const result = normalizeAction('send_group_msg', { group_id: 1, message: 'hi [CQ:at,qq=1]' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.params.message, [{ type: 'text', data: { text: 'hi [CQ:at,qq=1]' } }]);
});

check('forward 参数转换成 OneBot node 段', () => {
  const result = normalizeAction('send_group_forward_msg', {
    group_id: 100,
    messages: [
      { user_id: '10001', nickname: '阿里', content: '第一行' },
      { nickname: '测试', content: [{ type: 'text', text: 'hi' }, { type: 'face', id: 14 }] },
    ],
  });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.params.messages, [
    { type: 'node', data: { user_id: 10001, nickname: '阿里', content: [{ type: 'text', data: { text: '第一行' } }] } },
    { type: 'node', data: { nickname: '测试', content: [{ type: 'text', data: { text: 'hi' } }, { type: 'face', data: { id: '14' } }] } },
  ]);
});

// ===========================================================================
console.log('\n=== 消息段构造 ===');

check('buildSegments：字符串当纯文本，不解析 CQ 码', () => {
  assert.deepEqual(buildSegments('纯文本 [CQ:face,id=1]'), {
    ok: true,
    segments: [{ type: 'text', data: { text: '纯文本 [CQ:face,id=1]' } }],
  });
  return 'string → text';
});

check('buildSegments：text / dice / rps / shake', () => {
  const result = buildSegments([
    { type: 'text', text: '哈喽' },
    { type: 'dice' },
    { type: 'rps' },
    { type: 'shake' },
  ]);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.segments, [
    { type: 'text', data: { text: '哈喽' } },
    { type: 'dice', data: {} },
    { type: 'rps', data: {} },
    { type: 'shake', data: {} },
  ]);
});

check('buildSegments：at（数字 / 字符串 / all）', () => {
  const result = buildSegments([{ type: 'at', qq: 10001 }, { type: 'at', qq: '10002' }, { type: 'at', qq: 'all' }]);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.segments.map((seg) => seg.data.qq), ['10001', '10002', 'all']);
  expectRejected(buildSegments([{ type: 'at', qq: 'abc' }]), /qq/, '非法 at qq');
});

check('buildSegments：reply（message_id 或 id）', () => {
  assert.deepEqual(buildSegments([{ type: 'reply', message_id: 42 }]).segments, [{ type: 'reply', data: { id: '42' } }]);
  assert.deepEqual(buildSegments([{ type: 'reply', id: 'abc' }]).segments, [{ type: 'reply', data: { id: 'abc' } }]);
  expectRejected(buildSegments([{ type: 'reply' }]), /message_id/, 'reply 缺 id');
});

check('buildSegments：image url / file / base64 透传与补前缀', () => {
  assert.deepEqual(buildSegments([{ type: 'image', url: 'https://x/a.png' }]).segments, [
    { type: 'image', data: { file: 'https://x/a.png' } },
  ]);
  assert.deepEqual(buildSegments([{ type: 'image', file: 'file://abc123' }]).segments, [
    { type: 'image', data: { file: 'file://abc123' } },
  ]);
  assert.deepEqual(buildSegments([{ type: 'image', base64: PNG_BASE64 }]).segments, [
    { type: 'image', data: { file: `base64://${PNG_BASE64}` } },
  ]);
  assert.deepEqual(buildSegments([{ type: 'image', base64: `base64://${PNG_BASE64}` }]).segments, [
    { type: 'image', data: { file: `base64://${PNG_BASE64}` } },
  ]);
  assert.deepEqual(buildSegments([{ type: 'image', base64: 'data:image/png;base64,AAAA' }]).segments, [
    { type: 'image', data: { file: 'data:image/png;base64,AAAA' } },
  ]);
});

check('buildSegments：image 本地 path 读文件（png/jpeg/bmp 都认）', () => {
  const png = buildSegments([{ type: 'image', path: PNG_PATH }]);
  assert.equal(png.ok, true, png.error);
  assert.equal(png.segments[0].data.file, `base64://${PNG_BASE64}`);
  assert.equal(buildSegments([{ type: 'image', path: JPEG_PATH }]).ok, true);
  assert.equal(buildSegments([{ type: 'image', path: BMP_PATH }]).ok, true);
  return 'png/jpeg/bmp';
});

check('buildSegments：readFile 可注入，收到的是绝对路径', () => {
  const calls = [];
  const result = buildSegments([{ type: 'image', path: 'relative/pic.png' }], {
    readFile: (absolutePath) => {
      calls.push(absolutePath);
      return { bytes: PNG_BYTES, path: absolutePath };
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(calls.length, 1);
  assert.ok(isAbsolute(calls[0]), `readFile 应拿到绝对路径，实际 ${calls[0]}`);
  assert.equal(result.segments[0].data.file, `base64://${PNG_BASE64}`);
});

check('buildSegments：图片魔术字节不对要报错', () => {
  const result = buildSegments([{ type: 'image', path: BAD_PATH }]);
  expectRejected(result, /图片格式不支持/, '假 png');
  assert.match(result.error, /bad\.png/);
});

check('buildSegments：图片超过 maxImageBytes 要报错', () => {
  const result = buildSegments([{ type: 'image', path: PNG_PATH }], { maxImageBytes: 10 });
  expectRejected(result, /图片过大/, '超限图片');
  assert.match(result.error, /上限 10 字节/);
});

check('buildSegments：图片路径不存在要报错（含路径与错误码）', () => {
  const result = buildSegments([{ type: 'image', path: MISSING_PATH }]);
  expectRejected(result, /读取图片失败/, '不存在的图片');
  assert.match(result.error, /missing\.png/);
});

check('buildSegments：record / video 的 url、path、base64', () => {
  const record = buildSegments([{ type: 'record', url: 'https://x/v.amr' }]);
  assert.equal(record.ok, true, record.error);
  assert.deepEqual(record.segments, [{ type: 'record', data: { file: 'https://x/v.amr' } }]);

  const local = buildSegments([{ type: 'record', path: REC_PATH }]);
  assert.equal(local.ok, true, local.error);
  assert.equal(local.segments[0].data.file, `base64://${Buffer.from('#!AMR\n fake voice bytes').toString('base64')}`);

  const video = buildSegments([{ type: 'video', base64: 'AAAA' }]);
  assert.deepEqual(video.segments, [{ type: 'video', data: { file: 'base64://AAAA' } }]);
  expectRejected(buildSegments([{ type: 'record' }]), /record/, 'record 无来源');
});

check('buildSegments：file 段带 name，本地 path 转 base64', () => {
  const fromUrl = buildSegments([{ type: 'file', url: 'https://x/doc.pdf', name: '文档.pdf' }]);
  assert.equal(fromUrl.ok, true, fromUrl.error);
  assert.deepEqual(fromUrl.segments, [{ type: 'file', data: { file: 'https://x/doc.pdf', name: '文档.pdf' } }]);

  const fromPath = buildSegments([{ type: 'file', path: REC_PATH, name: '语音.amr' }]);
  assert.equal(fromPath.ok, true, fromPath.error);
  assert.equal(fromPath.segments[0].data.name, '语音.amr');
  assert.ok(fromPath.segments[0].data.file.startsWith('base64://'));
});

check('buildSegments：json（对象序列化 / 字符串透传）', () => {
  const fromObject = buildSegments([{ type: 'json', data: { app: 'com.test', prompt: '[测试]' } }]);
  assert.equal(fromObject.ok, true, fromObject.error);
  assert.deepEqual(fromObject.segments, [{ type: 'json', data: { data: '{"app":"com.test","prompt":"[测试]"}' } }]);

  const jsonText = '{"app":"com.test"}';
  assert.deepEqual(buildSegments([{ type: 'json', data: jsonText }]).segments, [
    { type: 'json', data: { data: jsonText } },
  ]);
  expectRejected(buildSegments([{ type: 'json' }]), /data/, 'json 缺 data');
});

check('buildSegments：markdown', () => {
  assert.deepEqual(buildSegments([{ type: 'markdown', content: '# 标题\n正文' }]).segments, [
    { type: 'markdown', data: { content: '# 标题\n正文' } },
  ]);
  expectRejected(buildSegments([{ type: 'markdown' }]), /content/, 'markdown 缺 content');
});

check('buildSegments：share', () => {
  assert.deepEqual(buildSegments([{ type: 'share', url: 'https://x', title: '标题', content: '描述', image: 'https://x/i.png' }]).segments, [
    { type: 'share', data: { url: 'https://x', title: '标题', content: '描述', image: 'https://x/i.png' } },
  ]);
  expectRejected(buildSegments([{ type: 'share' }]), /url/, 'share 缺 url');
});

check('buildSegments：contact（contact_type / sub_type / data.type 三种写法）', () => {
  assert.deepEqual(buildSegments([{ type: 'contact', contact_type: 'qq', id: 10001 }]).segments, [
    { type: 'contact', data: { type: 'qq', id: '10001' } },
  ]);
  assert.deepEqual(buildSegments([{ type: 'contact', sub_type: 'group', id: '123' }]).segments, [
    { type: 'contact', data: { type: 'group', id: '123' } },
  ]);
  assert.deepEqual(buildSegments([{ type: 'contact', data: { type: 'qq', id: '1' } }]).segments, [
    { type: 'contact', data: { type: 'qq', id: '1' } },
  ]);
  expectRejected(buildSegments([{ type: 'contact', contact_type: 'friend', id: 1 }]), /contact_type/, '非法 contact 类型');
});

check('buildSegments：兼容 OneBot 原样段格式（字段在 data 里）', () => {
  assert.deepEqual(buildSegments([{ type: 'text', data: { text: '原样段' } }]).segments, [
    { type: 'text', data: { text: '原样段' } },
  ]);
  assert.deepEqual(buildSegments([{ type: 'face', data: { id: 14 } }]).segments, [
    { type: 'face', data: { id: '14' } },
  ]);
  assert.deepEqual(buildSegments([{ type: 'image', data: { file: 'abc.jpg' } }]).segments, [
    { type: 'image', data: { file: 'abc.jpg' } },
  ]);
});

check('buildSegments：空数组 / 超过 50 段报错，恰好 50 段通过', () => {
  expectRejected(buildSegments([]), /不能为空/, '空数组');
  const fifty = Array.from({ length: MAX_SEGMENTS }, (_, index) => ({ type: 'text', text: `t${index}` }));
  assert.equal(buildSegments(fifty).ok, true);
  const overflow = [...fifty, { type: 'text', text: 'overflow' }];
  expectRejected(buildSegments(overflow), /上限 50/, '51 段');
});

check('buildSegments：poke 段被拒并提示改用 qq_action send_poke', () => {
  const result = buildSegments([{ type: 'poke', id: 1 }]);
  expectRejected(result, /poke/, 'poke 段');
  assert.match(result.error, /send_poke/);
});

check('buildSegments：其它不支持类型 / 坏段落结构报错', () => {
  expectRejected(buildSegments([{ type: 'music', id: 1 }]), /不支持的消息段类型/, 'music 段');
  expectRejected(buildSegments([null]), /不是对象/, 'null 段');
  expectRejected(buildSegments([{ text: '没有 type' }]), /缺少 type/, '缺 type');
  expectRejected(buildSegments(42), /字符串或消息段数组/, '非法 parts');
});

check('DEFAULT_MAX_IMAGE_BYTES 默认是 10MB', () => {
  assert.equal(DEFAULT_MAX_IMAGE_BYTES, 10 * 1024 * 1024);
});

// ===========================================================================
rmSync(TMP, { recursive: true, force: true });

const failed = results.filter((item) => !item.ok);
console.log(`\nPASS ${results.length - failed.length} / FAIL ${failed.length}`);
for (const item of failed) console.log(`  FAIL ${item.name} — ${item.detail}`);
process.exitCode = failed.length ? 1 : 0;
