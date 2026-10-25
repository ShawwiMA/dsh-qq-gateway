// M8：禁回（禁止回复）—— 主号在 QQ 里发 /mute 随时生效，DSH 里也能用 qq_mute 工具直接改。
//
// 设计要点：
// 1) 纯逻辑 + 一个 JSON 文件，跟 authz.js 一样不碰 cordis，离线测试直接指临时文件就能跑。
// 2) 状态落盘 + fs.watchFile 轮询（500ms）：**手改文件也算数**，不用重启 DSH 就热生效。
// 3) 主号永远不被禁（要能发 /unmute 自救）。
// 4) 时长语义统一：分钟数；0 / 永久 / forever = 一直禁到 /unmute。
// 5) 返回给 QQ 的文字必须精确说清"禁了谁、到几点"，不做模糊表述。

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** 默认落盘路径：~/.dsh/storages/qq-gateway-mute.json */
export const DEFAULT_MUTE_FILE = join(homedir(), '.dsh', 'storages', 'qq-gateway-mute.json');

/** QQ 号：5-15 位数字，返回字符串；不合法返回 ''。 */
export function normalizeQQ(value) {
  const qq = String(value ?? '').trim();
  return /^\d{5,15}$/.test(qq) ? qq : '';
}

/**
 * 解析时长。返回 { ok:true, minutes }（0=永久）或 { ok:false }。
 * 支持：10 / 10m / 10分钟 / 30分 / 2h / 2小时 / 1d / 0 / 永久 / forever / inf
 */
export function parseDuration(raw, defaultMinutes = 30) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === '') return { ok: true, minutes: normalizeMinutes(defaultMinutes) };
  if (['0', '永久', 'forever', 'inf', '∞', '一直'].includes(text)) return { ok: true, minutes: 0 };
  let match = /^(\d{1,4})(?:m|min|分钟|分)?$/.exec(text);
  if (match) return { ok: true, minutes: normalizeMinutes(Number(match[1])) };
  match = /^(\d{1,3})(?:h|hour|小时|时)$/.exec(text);
  if (match) return { ok: true, minutes: normalizeMinutes(Number(match[1]) * 60) };
  match = /^(\d{1,2})(?:d|day|天)$/.exec(text);
  if (match) return { ok: true, minutes: normalizeMinutes(Number(match[1]) * 1440) };
  return { ok: false };
}

/** 分钟数夹在 0..43200（30 天），小数向上取整；0 保留为"永久"。 */
export function normalizeMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(43200, Math.ceil(n));
}

/** 剩余分钟数（向上取整）；永久返回 null。 */
export function remainingMinutes(until, nowMs = Date.now()) {
  if (until === null || until === undefined) return null;
  const at = Date.parse(until);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - nowMs) / 60000));
}

/** 人类可读的剩余时长：45 分钟 / 1 小时 5 分 / 永久。 */
export function formatRemaining(until, nowMs = Date.now()) {
  const left = remainingMinutes(until, nowMs);
  if (left === null) return '永久';
  if (left <= 0) return '已结束';
  if (left < 60) return `${left} 分钟`;
  const hours = Math.floor(left / 60);
  const mins = left % 60;
  return mins ? `${hours} 小时 ${mins} 分` : `${hours} 小时`;
}

/** 到期时间的人类可读形式（本地时区 HH:MM）。 */
export function formatUntil(until) {
  if (until === null || until === undefined) return '直到 /unmute';
  const at = Date.parse(until);
  if (!Number.isFinite(at)) return '直到 /unmute';
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 创建禁回状态。
 * @param {object} [options]
 * @param {string|null} [options.file] - JSON 落盘路径；空字符串=用默认路径；null=只在内存里（离线测试）
 * @param {number} [options.defaultMinutes=30] - 不给时长时默认禁多久
 * @param {(message: string) => void} [options.log]
 * @param {() => number} [options.nowMs] - 时间源（测试注入）
 * @param {number} [options.pollMs=500] - 文件轮询间隔（热加载）
 */
export function createMuteState({
  file = '',
  defaultMinutes = 30,
  log = () => {},
  nowMs = () => Date.now(),
  pollMs = 500,
} = {}) {
  // file === null → 纯内存（测试用）；'' → 默认落盘路径
  const resolvedFile = file === null ? '' : (file || DEFAULT_MUTE_FILE);
  let global = null; // { until: ISO|null, setAt, by, reason }
  const peers = new Map(); // qq -> { until, setAt, reason }
  let loaded = false;
  let lastError = null;
  let lastWrittenMtime = 0;
  let watching = false;

  function prune(now = nowMs()) {
    if (global && global.until && Date.parse(global.until) <= now) global = null;
    for (const [qq, entry] of [...peers.entries()]) {
      if (entry.until && Date.parse(entry.until) <= now) peers.delete(qq);
    }
  }

  function load(force = false) {
    if (loaded && !force) return;
    loaded = true;
    if (!resolvedFile) {
      prune();
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(resolvedFile, 'utf8'));
      global = normalizeEntry(parsed?.global);
      peers.clear();
      const source = parsed?.peers && typeof parsed.peers === 'object' ? parsed.peers : {};
      for (const [qq, entry] of Object.entries(source)) {
        const id = normalizeQQ(qq);
        const normalized = normalizeEntry(entry);
        if (id && normalized) peers.set(id, normalized);
      }
      try {
        lastWrittenMtime = statSync(resolvedFile).mtimeMs;
      } catch {
        lastWrittenMtime = 0;
      }
      prune();
      log(`mute state loaded (global=${global ? 'on' : 'off'}, peers=${peers.size}) from ${resolvedFile}`);
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        lastError = err?.message ?? String(err);
        log(`mute state load failed: ${lastError}`);
      }
    }
  }

  function normalizeEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const until = typeof entry.until === 'string' && entry.until ? entry.until : null;
    return {
      until,
      setAt: typeof entry.setAt === 'string' ? entry.setAt : '',
      reason: typeof entry.reason === 'string' ? entry.reason : '',
      by: typeof entry.by === 'string' ? entry.by : '',
    };
  }

  function save() {
    if (!resolvedFile) return { ok: true, memoryOnly: true };
    try {
      const payload = JSON.stringify({
        version: 1,
        savedAt: new Date(nowMs()).toISOString(),
        global,
        peers: Object.fromEntries(peers.entries()),
      }, null, 2);
      mkdirSync(dirname(resolvedFile), { recursive: true });
      const tmp = `${resolvedFile}.tmp`;
      writeFileSync(tmp, payload, 'utf8');
      renameSync(tmp, resolvedFile);
      try {
        lastWrittenMtime = statSync(resolvedFile).mtimeMs;
      } catch {
        lastWrittenMtime = 0;
      }
      lastError = null;
      return { ok: true };
    } catch (err) {
      lastError = err?.message ?? String(err);
      log(`mute state save failed: ${lastError}`);
      return { ok: false, error: lastError };
    }
  }

  /** 热加载：外部（人/脚本/DSH）改了 JSON 就重新读，不重启 DSH。 */
  function watch() {
    if (watching || !resolvedFile) return;
    watching = true;
    watchFile(resolvedFile, { interval: pollMs }, () => {
      try {
        const mtime = statSync(resolvedFile).mtimeMs;
        if (mtime === lastWrittenMtime) return; // 刚才是自己写的
        loaded = false;
        load();
        log('mute state hot-reloaded from file');
      } catch {
        // 只有文件确实不存在才当"删除 = 全部解禁"；
        // 自己 save() 的 rename 瞬间 stat 偶尔失败，那种情况文件还在，不能清内存状态。
        if (existsSync(resolvedFile)) return;
        global = null;
        peers.clear();
        lastWrittenMtime = 0;
        log('mute state file removed -> all mutes cleared');
      }
    });
    log(`mute state watching ${resolvedFile} (poll ${pollMs}ms)`);
  }

  function close() {
    if (!watching) return;
    watching = false;
    unwatchFile(resolvedFile);
  }

  /** 主号永远不进禁回判断。 */
  function isMuted(qq, mainQQ = '') {
    load();
    if (String(qq) === String(mainQQ) && String(mainQQ) !== '') return false;
    prune();
    const id = normalizeQQ(qq);
    if (id && peers.has(id)) return true;
    return Boolean(global);
  }

  function setGlobal({ minutes = null, reason = '', by = '' } = {}) {
    load();
    const mins = minutes === null || minutes === undefined
      ? normalizeMinutes(defaultMinutes)
      : normalizeMinutes(minutes);
    global = {
      until: mins === 0 ? null : new Date(nowMs() + mins * 60000).toISOString(),
      setAt: new Date(nowMs()).toISOString(),
      reason: String(reason ?? ''),
      by: String(by ?? ''),
    };
    save();
    return { ok: true, scope: 'global', minutes: mins, until: global.until };
  }

  function setPeer(qq, { minutes = null, reason = '' } = {}) {
    load();
    const id = normalizeQQ(qq);
    if (!id) return { ok: false, error: 'bad-qq' };
    const mins = minutes === null || minutes === undefined
      ? normalizeMinutes(defaultMinutes)
      : normalizeMinutes(minutes);
    const entry = {
      until: mins === 0 ? null : new Date(nowMs() + mins * 60000).toISOString(),
      setAt: new Date(nowMs()).toISOString(),
      reason: String(reason ?? ''),
      by: 'main',
    };
    peers.set(id, entry);
    save();
    return { ok: true, scope: 'peer', qq: id, minutes: mins, until: entry.until };
  }

  function clearPeer(qq) {
    load();
    const id = normalizeQQ(qq);
    if (!id) return { ok: false, error: 'bad-qq' };
    const removed = peers.delete(id);
    if (removed) save();
    return { ok: true, removed, qq: id };
  }

  function clearAll() {
    load();
    const had = Boolean(global) || peers.size > 0;
    global = null;
    peers.clear();
    if (had) save();
    return { ok: true, cleared: had };
  }

  /** 当前生效的禁回清单（已过期的不算）。 */
  function list() {
    load();
    prune();
    const now = nowMs();
    const rows = [];
    if (global) {
      rows.push({
        scope: 'global',
        remainingMinutes: remainingMinutes(global.until, now),
        until: global.until,
        reason: global.reason,
        setAt: global.setAt,
      });
    }
    for (const [qq, entry] of [...peers.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      rows.push({
        scope: 'peer',
        qq,
        remainingMinutes: remainingMinutes(entry.until, now),
        until: entry.until,
        reason: entry.reason,
        setAt: entry.setAt,
      });
    }
    return rows;
  }

  /** 状态端点用。 */
  function snapshot() {
    const rows = list();
    return {
      file: resolvedFile || null,
      enabled: true,
      activeCount: rows.length,
      global: rows.find((row) => row.scope === 'global') ?? null,
      peers: rows.filter((row) => row.scope === 'peer'),
      lastError,
    };
  }

  /** 供 QQ 指令渲染的文字。 */
  function describe() {
    const rows = list();
    if (rows.length === 0) return '当前没有禁回，所有消息正常回。';
    const now = nowMs();
    const lines = rows.map((row) => {
      const who = row.scope === 'global' ? '全局（主号除外）' : `QQ ${row.qq}`;
      const left = formatRemaining(row.until, now);
      const tail = row.until ? `（到 ${formatUntil(row.until)}）` : '';
      return `${who}：${left}${tail}${row.reason ? `｜${row.reason}` : ''}`;
    });
    return `当前禁回：\n${lines.join('\n')}`;
  }

  function usage() {
    return '用法：\n/mute            全局禁回（默认时长）\n/mute 10         全局禁回 10 分钟\n/mute QQ号        只禁某个号\n/mute QQ号 10     禁某个号 10 分钟\n/mute all 30      全局禁回 30 分钟\n/mute list        查看当前禁回\n/unmute           全部解除\n/unmute QQ号      只解除某个号';
  }

  /**
   * 处理主号的 /mute、/unmute 指令。
   * 返回要回给主号的文字；不是禁回指令返回 null（交给 /allow /deny 那边）。
   */
  function handleCommand(cmd) {
    if (!cmd || (cmd.command !== 'mute' && cmd.command !== 'unmute')) return null;
    const arg = String(cmd.arg ?? '').trim();
    const tokens = arg ? arg.split(/\s+/) : [];

    if (cmd.command === 'unmute') {
      if (tokens.length === 0 || ['all', '全部', '所有'].includes(tokens[0].toLowerCase())) {
        const res = clearAll();
        return res.cleared ? '已解除全部禁回' : '本来就没有禁回';
      }
      const qq = normalizeQQ(tokens[0]);
      if (!qq) return `用法：/unmute 或 /unmute 123456789\n${usage()}`;
      const res = clearPeer(qq);
      return res.removed ? `已解除 QQ ${qq} 的禁回` : `QQ ${qq} 本来就没被禁回`;
    }

    // /mute
    if (tokens.length > 0 && ['list', '状态', 'show'].includes(tokens[0].toLowerCase())) {
      return describe();
    }
    if (tokens.length === 0) {
      const res = setGlobal({});
      return `已全局禁回（主号除外），${formatRemaining(res.until)}${res.until ? `到 ${formatUntil(res.until)}` : ''}。发 /unmute 解除`;
    }
    const first = tokens[0].toLowerCase();
    if (['all', '全部', '所有人'].includes(first)) {
      const parsed = parseDuration(tokens[1], defaultMinutes);
      if (!parsed.ok) return `时长看不懂：${tokens[1] ?? ''}\n${usage()}`;
      const res = setGlobal({ minutes: parsed.minutes, reason: tokens.slice(2).join(' ') });
      return `已全局禁回（主号除外）${res.minutes === 0 ? '（永久）' : ` ${formatRemaining(res.until)}`}${res.until ? `，到 ${formatUntil(res.until)}` : ''}。发 /unmute 解除`;
    }
    const qq = normalizeQQ(tokens[0]);
    if (qq) {
      const parsed = parseDuration(tokens[1], defaultMinutes);
      if (!parsed.ok) return `时长看不懂：${tokens[1] ?? ''}\n${usage()}`;
      const res = setPeer(qq, { minutes: parsed.minutes, reason: tokens.slice(2).join(' ') });
      return `已禁回 QQ ${qq}${res.minutes === 0 ? '（永久）' : ` ${formatRemaining(res.until)}`}${res.until ? `，到 ${formatUntil(res.until)}` : ''}。发 /unmute ${qq} 解除`;
    }
    // 第一个 token 既不是 QQ 也不是 all：当成全局时长
    const parsed = parseDuration(tokens[0], defaultMinutes);
    if (!parsed.ok) return `看不懂：${tokens[0]}\n${usage()}`;
    const res = setGlobal({ minutes: parsed.minutes, reason: tokens.slice(1).join(' ') });
    return `已全局禁回（主号除外）${res.minutes === 0 ? '（永久）' : ` ${formatRemaining(res.until)}`}${res.until ? `，到 ${formatUntil(res.until)}` : ''}。发 /unmute 解除`;
  }

  return {
    file: resolvedFile,
    load,
    save,
    watch,
    close,
    isMuted,
    setGlobal,
    setPeer,
    clearPeer,
    clearAll,
    list,
    snapshot,
    describe,
    usage,
    handleCommand,
    get lastError() {
      return lastError;
    },
  };
}
