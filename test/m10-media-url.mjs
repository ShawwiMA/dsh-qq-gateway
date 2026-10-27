// M10 媒体 URL 协议与权限校验（2026-10-27，评审补充项）。
//   评审原话：媒体 url 字段仍未限制协议，可绕过非主号的文件发送限制。
//   这里验证：url / mface.url / share.url 只接受 http(s)；本机文件来源统一走 fileSendPolicy；
//   qq_notice 与 qq_action 的写动作只认主号回合。
// 零依赖、纯逻辑；不碰网络、不碰真 QQ。
import assert from 'node:assert/strict';

import { buildSegments, checkMediaUrl } from '../lib/gateway/actions.js';
import { createQqTools } from '../lib/gateway/tools.js';

const MAIN_QQ = 10001;
const SESSION = 'session-m10-target';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
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

const BAD_URLS = [
  'file:///C:/Users/you/secret.png',
  'file://localhost/etc/passwd',
  'data:image/png;base64,iVBORw0KGgo=',
  'base64://iVBORw0KGgo=',
  'ftp://example.com/a.png',
  'javascript:alert(1)',
  'C:\\Users\\you\\secret.png',
  '\\\\evil-host\\share\\secret.png',
  'http://',
  'https://example.com/a b.png',
];

check('checkMediaUrl：只接受 http/https，其余来源全部拒绝', () => {
  for (const bad of BAD_URLS) {
    const result = checkMediaUrl(bad);
    assert.equal(result.ok, false, `${bad} 应被拒绝`);
    assert.match(String(result.error), /http|空白|过长/, `${bad} 的报错应说明原因`);
  }
  assert.deepEqual(checkMediaUrl('https://gchat.qpic.cn/a.png'), { ok: true, url: 'https://gchat.qpic.cn/a.png' });
  assert.deepEqual(checkMediaUrl('http://example.com/a.png'), { ok: true, url: 'http://example.com/a.png' });
  return `${BAD_URLS.length} 种非法来源被拒`;
});

check('buildSegments image/record/video/file：url 走协议校验（非主号也绕不过）', () => {
  for (const type of ['image', 'record', 'video', 'file']) {
    for (const bad of BAD_URLS) {
      // 即使 policy 允许（例如主号回合），url 也只能是 http(s)
      const result = buildSegments([{ type, url: bad }], { policy: { mode: 'main', isMain: true } });
      assert.equal(result.ok, false, `${type} + ${bad} 应被拒绝`);
    }
    const ok = buildSegments([{ type, url: 'https://gchat.qpic.cn/a.png' }], { policy: { mode: 'main' } });
    assert.equal(ok.ok, true, `${type} 的 http(s) URL 应放行`);
  }
  return '4 种媒体段 × 非法来源全拒';
});

check('mface / share 段里的 url 同样只收 http(s)', () => {
  const mfaceBad = buildSegments([{ type: 'mface', emoji_id: '1', summary: '[x]', url: 'file:///C:/x.png' }]);
  assert.equal(mfaceBad.ok, false);
  const mfaceOk = buildSegments([{ type: 'mface', emoji_id: '1', summary: '[x]', url: 'https://x/a.png' }]);
  assert.equal(mfaceOk.ok, true);
  const shareBad = buildSegments([{ type: 'share', url: 'file:///C:/x.png' }]);
  assert.equal(shareBad.ok, false);
  const shareOk = buildSegments([{ type: 'share', url: 'https://qm.qq.com/x' }]);
  assert.equal(shareOk.ok, true);
  return 'mface/share 协议校验生效';
});

check('纯文字 URL 段（text）不受影响，仍可正常发', () => {
  assert.equal(buildSegments([{ type: 'text', text: 'file:///C:/x.png 只是文字' }]).ok, true);
  return 'text 不受影响';
});

// ---------------------------------------------------------------------------
// 工具层：qq_notice / qq_action 的权限与协议
// ---------------------------------------------------------------------------
const calls = [];
let turnState = { active: false, userId: null };
const stub = {
  async sendMessage() { return { ok: true }; },
  async callAction(action, params) {
    calls.push({ action, params });
    return { ok: true, action, data: null, retcode: 0 };
  },
  currentContext: () => turnState,
};
const baseCfg = {
  mainQQ: MAIN_QQ,
  sessionId: SESSION,
  sendTimeoutMs: 1000,
  highRiskActionsRequireMain: true,
};
const tools = createQqTools({ gateway: stub, config: baseCfg, logger: () => {} });
const byName = (name) => tools.find((tool) => tool.name === name);
const exec = (name, args) => byName(name).execute(args, { agent: { id: SESSION } });
const asMain = () => { turnState = { active: true, userId: MAIN_QQ }; };
const asGuest = () => { turnState = { active: true, userId: 20001 }; };

await check('qq_notice：非主号回合（含其他会话）直接拒绝', async () => {
  turnState = { active: false, userId: null };
  const res = await exec('qq_notice', { group_id: 123456, content: 'x' });
  assert.equal(res.ok, false);
  assert.match(String(res.error), /主号/);
  asGuest();
  const res2 = await exec('qq_notice', { group_id: 123456, content: 'x' });
  assert.equal(res2.ok, false);
  assert.match(String(res2.error), /主号/);
  return '非主号被拒';
});

await check('qq_notice：主号回合也只收 http(s) 公告图片', async () => {
  asMain();
  calls.length = 0;
  for (const bad of ['C:\\Users\\you\\a.png', 'file:///C:/a.png', 'base64://AAAA']) {
    const res = await exec('qq_notice', { group_id: 123456, content: 'x', image: bad });
    assert.equal(res.ok, false, `${bad} 应被拒绝`);
    assert.match(String(res.error), /http/);
  }
  const okRes = await exec('qq_notice', { group_id: 123456, content: 'x', image: 'https://gchat.qpic.cn/a.png' });
  assert.equal(okRes.ok, true);
  assert.equal(calls.at(-1).params.image, 'https://gchat.qpic.cn/a.png');
  return '公告图片协议校验生效';
});

await check('qq_action：写动作非主号被拒，查询类放行', async () => {
  asGuest();
  const write = await exec('qq_action', { action: 'set_group_ban', params: { group_id: 1, user_id: 2, duration: 60 } });
  assert.equal(write.ok, false);
  assert.match(String(write.error), /主号/);
  const read = await exec('qq_action', { action: 'get_status' });
  assert.equal(read.ok, true);
  return '写拒读放';
});

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------
const failed = results.filter((item) => !item.ok);
console.log(`\nM10 媒体 URL 校验：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.error('失败项：', failed.map((item) => item.name).join(' | '));
  process.exit(1);
}
console.log('ALL PASS');
