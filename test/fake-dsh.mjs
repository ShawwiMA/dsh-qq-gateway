// 假宿主：忠实复刻 M0 实测到的 rpcId 契约与事件序列（照抄 m0-evidence.json / 真机会话日志）。
// 原则：比真宿主**更严**，不更宽。插件少传参数、传错形状、调不存在的方法，这里都要炸。
// 唯一真相来源：~/.dsh/bundles/dsh-qq-gateway/m0-evidence.json 与 M0-契约探针-结论.md
import { setTimeout as delay } from 'node:timers/promises';

const SYSTEM_PROMPT =
  'You are an AI agent powered by DeepSeek Harness.\n\nYou are a coding agent. (fake-dsh: 截断，只保留形状)';

const INJECTED_USER_SOURCES = [
  { kind: 'agent-instructions', form: 'instructions', baseline: true },
  { kind: 'runtime-context', form: 'snapshot', sections: [] },
  { kind: 'skill-catalog', form: 'catalog', entries: [] },
  { kind: 'time-context', form: 'snapshot', sections: [] },
];

function assertPromptShape(request) {
  if (!request || typeof request !== 'object') throw new TypeError('fake-dsh: prompt request must be an object');
  if (typeof request.requestId !== 'string' || !request.requestId) {
    throw new TypeError('fake-dsh: requestId must be a non-empty string');
  }
  if (request.mode !== 'queue' && request.mode !== 'steer') {
    throw new TypeError(`fake-dsh: mode must be 'queue' or 'steer', got ${String(request.mode)}`);
  }
  if (!Array.isArray(request.content) || request.content.length === 0) {
    throw new TypeError('fake-dsh: content must be a non-empty array of PromptContentPart');
  }
  for (const part of request.content) {
    if (!part || typeof part !== 'object') throw new TypeError('fake-dsh: content part must be an object');
    const ok = (part.type === 'text' && typeof part.text === 'string')
      || (part.type === 'image' && typeof part.data === 'string' && typeof part.mediaType === 'string')
      || (part.type === 'file' && typeof part.receiptId === 'string');
    if (!ok) throw new TypeError(`fake-dsh: bad content part ${JSON.stringify(part).slice(0, 80)}`);
  }
  if (typeof request.sessionId !== 'string' || !request.sessionId) {
    throw new TypeError('fake-dsh: sessionId must be a non-empty string');
  }
}

export function createFakeDsh({ sessionId = 'session-fake-target', cwd = 'C:\\fake\\cwd' } = {}) {
  const listeners = { 'session/event': [] };
  const events = [];
  const calls = { create: [], prompt: [], cancel: [], rename: [], inspect: [], list: [], selectModel: [] };
  const seenRequestIds = new Set();
  const promptArgs = new Map();
  let seq = 0;
  let turnNo = 0;
  const turnWaiters = new Map();

  const session = {
    id: sessionId,
    header: { version: 4, id: sessionId, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0 },
    get seq() {
      return seq;
    },
  };

  function emit(type, data) {
    seq += 1;
    const event = { type, seq, time: Date.now(), data };
    events.push(event);
    for (const fn of listeners['session/event']) {
      fn(session, event);
    }
    if (type === 'turn/end') {
      const waiters = turnWaiters.get(data.turn) ?? [];
      turnWaiters.delete(data.turn);
      for (const w of waiters) w(event);
    }
    return event;
  }

  function waitForTurnEnd(turn, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const list = turnWaiters.get(turn) ?? [];
      const timer = setTimeout(() => reject(new Error(`fake-dsh: turn ${turn} never ended`)), timeoutMs);
      list.push((event) => {
        clearTimeout(timer);
        resolve(event);
      });
      turnWaiters.set(turn, list);
    });
  }

  /** 照抄 M0 抓到的一整个 turn 的事件序列。返回 {turn, done}。 */
  function replayTurn({
    rid = null,
    replyText = '（假宿主默认回复）',
    abortKind = null,
    stepMs = 10,
    variant = 'own',
    title = 'fake-dsh turn',
  } = {}) {
    turnNo += 1;
    const turn = turnNo;
    const done = waitForTurnEnd(turn);
    const userMessages = [];
    if (variant === 'own') userMessages.push({ role: 'user', source: { kind: 'user', rpcId: rid }, content: [{ type: 'text', text: '[fake-dsh] 注入的 prompt' }] });
    else if (variant === 'foreign-rid') userMessages.push({ role: 'user', source: { kind: 'user', rpcId: rid }, content: [{ type: 'text', text: '[fake-dsh] GUI 敲的字' }] });
    for (const source of INJECTED_USER_SOURCES) {
      userMessages.push({ role: 'user', source, content: [{ type: 'text', text: `<fake-dsh injected ${source.kind}>` }] });
    }

    const script = [
      ['agent/inbox/spliced', { turn, messages: 1 }],
      ['turn/start', { turn }],
      ['agent/inbox/spliced', { turn, messages: userMessages.length }],
      ['step/start', { turn, step: 1 }],
      ['system/message', { turn, step: 1, message: { role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: SYSTEM_PROMPT }] } }],
      ...userMessages.map((m) => ['user/message', m]),
      ['request/header', { header: { config: { provider: 'fake', model: 'fake-model' } }, reason: 'initial' }],
      ['request/context', { provider: 'fake', model: 'fake-model' }],
      ['session/title', { title: `${title} #${turn}` }],
      ['session/title-llm-request', { turn, step: 1 }],
      ['session-log-deepseek/delivery-accepted', { turn, step: 1, part: 1 }],
      ['session-log-deepseek/delivery-accepted', { turn, step: 1, part: 2 }],
      ['session/title', { title: `${title} #${turn} (final)` }],
      ['assistant/message', {
        turn,
        step: 1,
        message: {
          role: 'assistant',
          source: { kind: 'model', provider: 'fake', model: 'fake-model' },
          content: [
            { type: 'reasoning', text: '[fake-dsh] 先想一下（不应被回传）' },
            { type: 'text', text: replyText },
          ],
        },
        stream: [],
      }],
      ['step/end', { turn, step: 1 }],
      ['turn/end', { turn, reason: abortKind ? { kind: 'aborted', reason: { kind: abortKind } } : { kind: 'completed' } }],
      ['session/title', { title: `${title} #${turn} (closed)` }],
    ];

    (async () => {
      for (const [type, data] of script) {
        await delay(stepMs);
        emit(type, data);
      }
    })().catch(() => {});

    return { turn, done };
  }

  const sessionController = {
    async create(request = {}) {
      calls.create.push(request);
      if (request.cwd !== undefined && typeof request.cwd !== 'string') {
        throw new TypeError('fake-dsh: create.cwd must be a string');
      }
      return { sessionId: request.sessionId ?? sessionId, agentPreset: 'ptc' };
    },
    async prompt(request, signal) {
      assertPromptShape(request);
      calls.prompt.push({ request, signalPresent: Boolean(signal), requestId: request.requestId });
      // 真机行为：宿主实现里直接调 signal.throwIfAborted()，少传第二参就是 TypeError
      if (!signal || typeof signal.throwIfAborted !== 'function') {
        throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')");
      }
      signal.throwIfAborted();
      if (request.sessionId !== sessionId) {
        const err = new Error(`fake-dsh: session not found: ${request.sessionId}`);
        err.code = 'session/not-found';
        throw err;
      }
      if (seenRequestIds.has(request.requestId)) {
        // 真机行为（dsh-agent-loop:855）：同 requestId 重复投递幂等，不再产生新 turn
        return { accepted: true };
      }
      seenRequestIds.add(request.requestId);
      promptArgs.set(request.requestId, { ...request, _signal: signal });
      return { accepted: true };
    },
    cancel(request = {}) {
      calls.cancel.push(request);
      return { accepted: true };
    },
    async rename(request = {}) {
      calls.rename.push(request);
      return { title: request.title, seq: seq + 1 };
    },
    async inspect(request = {}) {
      calls.inspect.push(request);
      return { meta: session.header, inheritedEventCount: 0, events: events.slice(-5) };
    },
    async list() {
      calls.list.push({});
      return { items: [{ agentAvailable: true, sessionId, updatedAt: Date.now(), running: false, blank: false, cwd }] };
    },
    async selectModel(request = {}) {
      calls.selectModel.push(request);
      return { selected: { provider: 'fake', model: 'fake-model' } };
    },
  };

  // 未实现的方法必须炸，防止插件偷偷依赖宽松假接口
  const strictController = new Proxy(sessionController, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || prop in target) return Reflect.get(target, prop, receiver);
      throw new Error(`fake-dsh: unknown sessionController method '${String(prop)}'`);
    },
  });

  const ctx = {
    sessionController: strictController,
    on(event, handler) {
      if (!(event in listeners)) throw new Error(`fake-dsh: unknown event '${event}'`);
      listeners[event].push(handler);
      return () => {
        const idx = listeners[event].indexOf(handler);
        if (idx >= 0) listeners[event].splice(idx, 1);
      };
    },
    logger: () => () => {},
  };

  return {
    ctx,
    session,
    sessionId,
    events,
    calls,
    promptArgs,
    /** 目标会话的种子事件（真机每个会话都有这 4 条） */
    emitSeed() {
      emit('permission/preset', { preset: 'ptc' });
      emit('sandbox/mode', { mode: 'workspace-write' });
      emit('approval/policy', { policy: 'ask' });
      emit('subagent/model-selection-policy', { policy: 'inherit' });
    },
    /** 插件投递 prompt 之后，由测试决定什么时候回放这个 turn */
    startTurnFor(requestId, opts = {}) {
      const args = promptArgs.get(requestId);
      if (!args) throw new Error(`fake-dsh: no recorded prompt for ${requestId}`);
      return replayTurn({ rid: requestId, ...opts });
    },
    /** GUI 直接敲字：也是一个带 rpcId 的 turn，但那个 rid 不在插件的在飞集合里 */
    guiTurn(opts = {}) {
      return replayTurn({ variant: 'foreign-rid', rid: opts.rid ?? `gui-${Date.now()}`, ...opts });
    },
    /** 宿主自己续跑：只有 4 条无 rpcId 的注入消息，一条 rpcId 都没有 */
    hostContinuationTurn(opts = {}) {
      return replayTurn({ variant: 'injected-only', ...opts });
    },
    /** 迟到/过期 rid 的 turn（TTL 已过） */
    staleRidTurn({ rid, ...opts } = {}) {
      return replayTurn({ variant: 'foreign-rid', rid: rid ?? 'stale-rid', ...opts });
    },
    waitForTurnEnd,
  };
}
