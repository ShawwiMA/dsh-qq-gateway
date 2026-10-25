// 变异测试：故意把 L3 判据改成"永远算自己的"，验证 m1-run 里那两条"外来 turn 零回传"的断言
// 真有牙——如果变异后仍然零回传，说明断言是空的。
// 跑法：node ~/.dsh/bundles/dsh-qq-gateway/test/m1-mutation.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { TurnTracker, TURN_VERDICT } from '../lib/gateway/protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// 必须在 createGateway 之前打补丁：模块实例是同一个
TurnTracker.prototype.verdict = () => ({ verdict: TURN_VERDICT.OWN, ownRid: 'mutant-rid', foreignRids: [] });

const { createFakeDsh } = await import('./fake-dsh.mjs');
const { connectFakeNapCat } = await import('./fake-napcat.mjs');
const { createGateway } = await import('../lib/gateway/gateway.js');

const MAIN_QQ = 10001;
const BOT_QQ = 10002;
const TOKEN = 'm1-test-token';
const SESSION = 'session-fake-target';
const logs = [];
const fake = createFakeDsh({ sessionId: SESSION });
fake.emitSeed();
const gw = createGateway({
  ctx: fake.ctx,
  config: { host: '127.0.0.1', port: 0, path: '/onebot', token: TOKEN, mainQQ: MAIN_QQ, botQQ: BOT_QQ, sessionId: SESSION },
  logger: (m) => logs.push(m),
});
await gw.start();
const napcat = await connectFakeNapCat({ url: `ws://127.0.0.1:${gw.port()}/onebot`, token: TOKEN, botQQ: BOT_QQ, mainQQ: MAIN_QQ });
await delay(50);

const gui = fake.guiTurn({ rid: `gui-${Date.now()}`, replyText: 'GUI 的回复（变异后不该被拦）' });
await gui.done;
await delay(80);
const afterGui = napcat.replies().length;

const cont = fake.hostContinuationTurn({ replyText: '宿主续跑回复（变异后不该被拦）' });
await cont.done;
await delay(80);
const afterCont = napcat.replies().length;

await napcat.close();
await gw.stop();

const caught = afterGui > 0 && afterCont > 0;
const evidence = {
  kind: 'M1 变异测试：把 L3 判据改成永远 OWN',
  at: new Date().toISOString(),
  mutation: 'TurnTracker.prototype.verdict => OWN',
  repliesAfterGuiTurn: afterGui,
  repliesAfterHostContinuationTurn: afterCont,
  assertionHasTeeth: caught,
  gatewayLogs: logs,
};
writeFileSync(join(ROOT, 'm1-mutation-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

console.log(`变异后：GUI turn 回传 ${afterGui} 条，宿主续跑 turn 回传 ${afterCont} 条`);
console.log(caught ? 'OK  断言有牙：L3 一破，回传立刻漏出来' : 'BAD 断言是空的：变异了还是零回传，得重写断言');
process.exitCode = caught ? 0 : 1;
