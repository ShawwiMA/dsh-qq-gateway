// 私聊授权名单（M5）：主号在 QQ 里发 /allow、/deny、/list 就能远程维护；
// 名单落盘（原子写，UTF-8 无 BOM），DSH/Docker 重启后不丢。
// 纯逻辑 + 一个可选文件，离线测试直接指临时文件就能跑，不碰 cordis。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 指令别名 → 规范指令名。主号只认这几个，其他消息原样进 DSH。 */
const COMMAND_ALIASES = {
  allow: 'allow',
  授权: 'allow',
  deny: 'deny',
  取消: 'deny',
  移除: 'deny',
  list: 'list',
  名单: 'list',
  // M8：禁回（禁止回复）。时长语义见 gateway/mute.js。
  mute: 'mute',
  禁言: 'mute',
  静默: 'mute',
  禁回: 'mute',
  unmute: 'unmute',
  解除: 'unmute',
  解禁: 'unmute',
  解除静默: 'unmute',
  help: 'help',
  帮助: 'help',
}

/** 解析主号发来的管理指令；不是指令返回 null（普通消息照常投递）。 */
export function parseAdminCommand(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const match = /^\/([^\s]+)\s*([\s\S]*)$/.exec(trimmed)
  if (!match) return null
  const command = COMMAND_ALIASES[match[1].toLowerCase()]
  if (!command) return null
  return { command, arg: match[2].trim() }
}

/** QQ 号：5-15 位数字，返回字符串；不合法返回 ''。 */
export function normalizeQQ(value) {
  const qq = String(value ?? '').trim()
  return /^\d{5,15}$/.test(qq) ? qq : ''
}

/**
 * 创建名单。file 为空时只在内存里生效（离线测试 / 没配路径时）。
 * @param {object} [options]
 * @param {string} [options.file] - JSON 落盘路径
 * @param {(message: string) => void} [options.log]
 * @param {() => string} [options.now] - 时间戳（测试可注入）
 */
export function createAllowList({ file = '', log = () => {}, now = () => new Date().toISOString() } = {}) {
  const entries = new Map()
  let loaded = false
  let lastError = null

  function load() {
    if (loaded) return
    loaded = true
    if (!file) return
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const list = Array.isArray(parsed?.allowed) ? parsed.allowed : []
      for (const item of list) {
        const qq = normalizeQQ(typeof item === 'string' ? item : item?.qq)
        if (!qq) continue
        entries.set(qq, {
          note: typeof item?.note === 'string' ? item.note : '',
          addedAt: typeof item?.addedAt === 'string' ? item.addedAt : '',
        })
      }
      log(`allow list loaded (${entries.size} entries) from ${file}`)
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        lastError = err?.message ?? String(err)
        log(`allow list load failed: ${lastError}`)
      }
    }
  }

  function save() {
    if (!file) return { ok: false, reason: 'no-file' }
    try {
      const payload = JSON.stringify({
        version: 1,
        savedAt: now(),
        allowed: [...entries.entries()].map(([qq, value]) => ({ qq, note: value.note, addedAt: value.addedAt })),
      }, null, 2)
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      // writeFileSync 默认 utf8 且不写 BOM —— 这里刻意不用任何 BOM 选项
      writeFileSync(tmp, payload, 'utf8')
      renameSync(tmp, file)
      lastError = null
      return { ok: true }
    } catch (err) {
      lastError = err?.message ?? String(err)
      log(`allow list save failed: ${lastError}`)
      return { ok: false, reason: 'io' }
    }
  }

  function has(qq) {
    load()
    return entries.has(normalizeQQ(qq))
  }

  function add(qq, note = '') {
    load()
    const id = normalizeQQ(qq)
    if (!id) return { ok: false, reason: 'bad-qq' }
    const existed = entries.has(id)
    entries.set(id, { note: String(note ?? ''), addedAt: existed ? entries.get(id).addedAt : now() })
    const saved = save()
    return { ok: true, added: !existed, count: entries.size, saved }
  }

  function remove(qq) {
    load()
    const id = normalizeQQ(qq)
    if (!id) return { ok: false, reason: 'bad-qq' }
    const existed = entries.delete(id)
    if (existed) save()
    return { ok: true, removed: existed, count: entries.size }
  }

  function list() {
    load()
    return [...entries.entries()]
      .map(([qq, value]) => ({ qq, note: value.note, addedAt: value.addedAt }))
      .sort((a, b) => a.qq.localeCompare(b.qq))
  }

  return {
    file,
    has,
    add,
    remove,
    list,
    get count() {
      load()
      return entries.size
    },
    get loaded() {
      return loaded
    },
    get lastError() {
      return lastError
    },
  }
}
