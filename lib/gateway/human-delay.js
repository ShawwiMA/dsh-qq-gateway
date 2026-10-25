// M7：拟人延迟 —— 助手回复不秒发。
//
// 为什么要有：模型算完就把整段回复甩出去，QQ 那头看到的是"零点几秒回一大段"，
// 一看就不是人；而且秒回、等间隔回都是风控爱抓的特征。这里给自动回传加一层非线性延迟：
//   1) 打字时间按字符数**次线性**增长（指数 0.85）：回 5 个字和回 500 个字不该差 100 倍；
//   2) 速度抖动（0.7~1.3 倍），每次都不一样，不会出现固定节奏；
//   3) 看消息/发呆/打字停顿用**指数分布**，长尾：大多数时候很快，偶尔拖很久。
// 只算时间，不发消息；纯逻辑，不碰网络、不碰 cordis，rng 可注入，离线可单测。

/** 打字速度按字符权重算：中文/全角 1，ASCII 等窄字符 0.5。 */
export function effectiveLength(text) {
  const body = String(text ?? '').replace(/\s+/g, '');
  let weight = 0;
  for (const ch of body) {
    const code = ch.codePointAt(0);
    // 0x2E80 起是 CJK 部首/汉字/假名/全角标点，按整字算；其余（英文数字半角符号）算半个
    weight += code >= 0x2e80 ? 1 : 0.5;
  }
  return weight;
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function unit(rng) {
  const value = Number(rng());
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

/**
 * 算这条回复该等多久再发（毫秒整数）。
 * cfg 只读 5 个字段：replyDelayMode / replyDelayMinMs / replyDelayMaxMs /
 * replyDelayPerCharMs / replyDelayTailMs。mode=off 直接返回 0。
 *
 * 延迟 = 下限 + 打字时间 + 长尾停顿，最后夹在 [min, max] 之间。
 * 非线性体现在两处：字符数开 0.85 次方；停顿取 -ln(1-0.99u)（指数分布，均值≈tail）。
 */
export function computeReplyDelayMs({ text = '', cfg = {}, rng = Math.random } = {}) {
  if (!cfg || cfg.replyDelayMode === 'off') return 0;
  const min = Math.max(0, finiteOr(cfg.replyDelayMinMs, 800));
  const max = Math.max(min, finiteOr(cfg.replyDelayMaxMs, 12000));
  const perChar = Math.max(0, finiteOr(cfg.replyDelayPerCharMs, 60));
  const tail = Math.max(0, finiteOr(cfg.replyDelayTailMs, 2500));
  const chars = effectiveLength(text);
  const speed = 0.7 + 0.6 * unit(rng); // 打字快慢抖动
  const typing = perChar * Math.pow(chars, 0.85) * speed;
  const pause = tail * -Math.log(1 - 0.99 * unit(rng)); // 指数分布长尾
  const raw = min + typing + pause;
  return Math.round(Math.min(max, Math.max(min, raw)));
}

/**
 * 回复发送时刻的记账器：保证先算好的回复不会被后一条抢跑。
 * 多条回复几乎同时生成时（模型连发），各自延迟不同，只按 delay 排序会乱序，
 * 这里始终取 max(现在+delay, 上一条的发送时刻)，后进排队。
 */
export function createReplyTimeline({ now = Date.now } = {}) {
  let cursor = 0;
  return {
    /** 预约一个发送时刻（绝对毫秒时间戳）。 */
    reserve(delayMs) {
      const current = now();
      const at = Math.max(current + Math.max(0, Math.round(finiteOr(delayMs, 0))), cursor);
      cursor = at + 1;
      return at;
    },
    /** 当前游标（测试用）。 */
    get cursor() {
      return cursor;
    },
  };
}
