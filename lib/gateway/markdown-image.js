// Markdown → PNG 渲染（给 QQ 回复用：QQ 客户端不渲染 Markdown，所以渲染成图片再当图片消息发）。
//
// 为什么用截图方案：
//   - QQ 聊天窗不解析 Markdown，直接发源码就是一堆 # 和 **；
//   - NapCat 的 markdown 消息段走的是 QQ 官方 Markdown 能力，需要签名/权限，实测调用超时；
//   - 「本地 HTML → Edge headless 截图 → PNG 当 image 消息段发」零第三方依赖、渲染效果可控，
//     比在 QQ 端拼富文本稳定得多。
//
// 外部依赖（都靠运行期探测，不走 npm 依赖）：
//   - Microsoft Edge（Chromium headless，用 --screenshot 出图）；
//   - Python 3 + Pillow（只负责裁掉截图底部空白；没有它也能出图，只是白边变多）。
//
// 失败降级策略：
//   - 任何异常（Edge 不存在 / 超时 / 写文件失败 / PNG 非法）一律返回 { ok:false, error:'中文原因' }，
//     绝不抛未捕获异常；
//   - Pillow 裁剪失败不算整体失败：保留未裁剪的原图，返回 ok:true 并在 warning 里说明；
//   - 临时目录用完只清理 HTML / Edge profile 等中间文件，截图 PNG 必须保留（调用方要拿去发图）。
//
// 约定：只用 node 内置模块，ESM，零第三方依赖。markdownToHtml / looksLikeMarkdown 是纯字符串
// 处理、无 IO，可离线单测；renderMarkdownToImage 才碰文件与子进程。

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 渲染默认参数；renderMarkdownToImage 的 opts 会逐项覆盖。 */
export const DEFAULT_RENDER_OPTIONS = Object.freeze({
  maxWidth: 720,
  fontSize: 15,
  padding: 24,
  maxChars: 8000,
  timeoutMs: 25000,
});

/** Edge 常见安装路径（按顺序探测，可用 opts.edgePath 覆盖）。 */
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** 截图高度估算上限：超过这个高度就不再往上加，避免 Edge 吃掉太多内存。 */
const MAX_SCREENSHOT_HEIGHT = 16000;

/** 最小截图高度：内容很少时也不要低于这个值，省得 Edge 给个奇怪的视口。 */
const MIN_SCREENSHOT_HEIGHT = 600;

const HTML_ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/** HTML 转义：正文、代码、属性值统一走这里（不接受裸 HTML，全部当文本）。 */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/** 属性值转义（和正文同一套规则，引号已覆盖）。 */
function escapeAttr(value) {
  return escapeHtml(value);
}

/** 取整并夹到 [min, max]；非法值用 fallback。 */
function clampInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

/** 把文本截成一行摘要，塞进中文错误信息里用。 */
function tail(text, limit = 240) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length > limit ? `…${value.slice(-limit)}` : value;
}

// ---------------------------------------------------------------------------
// Markdown → HTML：块级解析
// ---------------------------------------------------------------------------

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^\s{0,3}(#{1,6})[ \t]+(.*)$/;
const HR_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_RE = /^\s{0,3}>[ \t]?(.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const BLANK_RE = /^\s*$/;

/** 判断一行是不是「除段落以外」的块起始；段落遇到它要断开。 */
function isBlockStart(lines, index) {
  const line = lines[index];
  return FENCE_RE.test(line)
    || HEADING_RE.test(line)
    || HR_RE.test(line)
    || QUOTE_RE.test(line)
    || LIST_RE.test(line)
    || isTableStart(lines, index);
}

/** GFM 表格：本行含 |，下一行是 |---|:---:| 这种分隔行。 */
function isTableStart(lines, index) {
  if (index + 1 >= lines.length) return false;
  const head = lines[index];
  const separator = lines[index + 1];
  if (!head.includes('|') || !separator.includes('-')) return false;
  const cells = splitTableRow(separator);
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

/** 拆表格行：支持 \| 转义，首尾竖线不算空单元格。 */
function splitTableRow(line) {
  let source = String(line ?? '').trim();
  if (source.startsWith('|')) source = source.slice(1);
  if (source.endsWith('|')) source = source.slice(0, -1);
  const cells = [];
  let buffer = '';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\' && source[i + 1] === '|') {
      buffer += '|';
      i += 1;
    } else if (ch === '|') {
      cells.push(buffer.trim());
      buffer = '';
    } else {
      buffer += ch;
    }
  }
  cells.push(buffer.trim());
  return cells;
}

/** 单元格对齐方式 → 内联 style。 */
function tableAlignStyle(cell) {
  const raw = String(cell ?? '').trim();
  if (/^:.+:$/.test(raw)) return ' style="text-align:center"';
  if (/:$/.test(raw)) return ' style="text-align:right"';
  if (/^:/.test(raw)) return ' style="text-align:left"';
  return '';
}

/** 解析围栏代码块（语言名只保留成 class，不做高亮）。 */
function parseFence(lines, start) {
  const open = FENCE_RE.exec(lines[start]);
  const marker = open[1][0];
  const language = (open[2].trim().split(/\s+/)[0] || '').replace(/[^\w-]/g, '');
  const codeLines = [];
  let index = start + 1;
  while (index < lines.length) {
    const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[index]);
    if (close && close[1][0] === marker && close[1].length >= open[1].length) {
      index += 1;
      break;
    }
    codeLines.push(lines[index]);
    index += 1;
  }
  const languageClass = language ? ` class="language-${escapeAttr(language)}"` : '';
  const html = `<pre><code${languageClass}>${escapeHtml(codeLines.join('\n'))}</code></pre>`;
  return { html, next: index };
}

/** 解析引用块：剥掉 > 后递归当普通块解析，嵌套引用和引用里的列表都能出来。 */
function parseBlockquote(lines, start) {
  const quoted = [];
  let index = start;
  while (index < lines.length) {
    const match = QUOTE_RE.exec(lines[index]);
    if (!match) break;
    quoted.push(match[1]);
    index += 1;
  }
  return { html: `<blockquote>${parseBlockLines(quoted)}</blockquote>`, next: index };
}

/** 解析 GFM 表格（表头 + 分隔行 + 数据行）。 */
function parseTable(lines, start) {
  const headerCells = splitTableRow(lines[start]);
  const separatorCells = splitTableRow(lines[start + 1]);
  const alignStyles = headerCells.map((_, index) => tableAlignStyle(separatorCells[index]));
  let index = start + 2;
  const rows = [];
  while (index < lines.length && !BLANK_RE.test(lines[index]) && lines[index].includes('|')) {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }
  const head = headerCells
    .map((cell, cellIndex) => `<th${alignStyles[cellIndex]}>${renderInline(cell)}</th>`)
    .join('');
  const body = rows
    .map((cells) => `<tr>${headerCells
      .map((_, cellIndex) => `<td${alignStyles[cellIndex]}>${renderInline(cells[cellIndex] ?? '')}</td>`)
      .join('')}</tr>`)
    .join('\n');
  const html = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  return { html, next: index };
}

/**
 * 解析列表：支持 - * + 与 1. / 1) 两种，缩进两格算一层嵌套（最多 3 层）。
 * 续行（比当前项多缩进的非列表行）并入上一项，条目之间允许空行。
 */
function parseList(lines, start) {
  const items = [];
  let index = start;
  while (index < lines.length) {
    const match = LIST_RE.exec(lines[index]);
    if (!match) break;
    const indent = match[1].replace(/\t/g, '  ').length;
    const depth = Math.min(3, Math.floor(indent / 2));
    const ordered = /\d/.test(match[2]);
    let text = match[3].trim();
    index += 1;
    while (index < lines.length) {
      const next = lines[index];
      if (BLANK_RE.test(next)) break;
      if (LIST_RE.test(next) || isBlockStart(lines, index)) break;
      const nextIndent = next.replace(/\t/g, '  ').length - next.trimStart().length;
      if (nextIndent <= indent) break;
      text += ` ${next.trim()}`;
      index += 1;
    }
    items.push({ depth, ordered, text });
    let probe = index;
    while (probe < lines.length && BLANK_RE.test(lines[probe])) probe += 1;
    if (probe < lines.length && LIST_RE.test(lines[probe])) {
      index = probe;
      continue;
    }
    break;
  }
  return { html: buildListHtml(items), next: index };
}

/** 把扁平列表项按 depth 还原成嵌套 <ul>/<ol>。 */
function buildListHtml(items) {
  let index = 0;

  function walk(depth) {
    const first = items[index];
    const ordered = first.ordered;
    const tag = ordered ? 'ol' : 'ul';
    let html = `<${tag}>`;
    while (index < items.length && items[index].depth === depth && items[index].ordered === ordered) {
      html += `<li>${renderInline(items[index].text)}`;
      index += 1;
      while (index < items.length && items[index].depth > depth) {
        html += walk(items[index].depth);
      }
      html += '</li>';
    }
    return `${html}</${tag}>`;
  }

  let html = '';
  while (index < items.length) html += walk(items[index].depth);
  return html;
}

/** 块级解析主循环：逐行走状态机，输出 HTML 片段数组。 */
function parseBlockLines(lines) {
  const html = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (BLANK_RE.test(line)) {
      index += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const block = parseFence(lines, index);
      html.push(block.html);
      index = block.next;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      html.push('<hr>');
      index += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const block = parseBlockquote(lines, index);
      html.push(block.html);
      index = block.next;
      continue;
    }

    if (isTableStart(lines, index)) {
      const block = parseTable(lines, index);
      html.push(block.html);
      index = block.next;
      continue;
    }

    if (LIST_RE.test(line)) {
      const block = parseList(lines, index);
      html.push(block.html);
      index = block.next;
      continue;
    }

    // 剩余都当段落：段内换行保留成 <br>，空行结束段落。
    const paragraph = [];
    while (index < lines.length) {
      if (BLANK_RE.test(lines[index])) break;
      if (paragraph.length > 0 && isBlockStart(lines, index)) break;
      paragraph.push(lines[index].trim());
      index += 1;
    }
    html.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
  }
  return html.join('\n');
}

// ---------------------------------------------------------------------------
// Markdown → HTML：行内解析
// ---------------------------------------------------------------------------

const INLINE_CODE_RE = /(`+)([\s\S]*?)\1/g;
const LINK_RE = /(?<!!)\[([^\]\n]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
// URL 字符集排除中日韩文字与全角标点，避免把「https://a.com的」整串吞掉。
const BARE_URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'`\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]+/g;
const PLACEHOLDER_RE = /\u0000(\d+)\u0000/g;
const PLACEHOLDER_FULL_RE = /^\u0000\d+\u0000$/;
const URL_TRAILING_PUNCT_RE = /[)\]}>.,;:!?，。；：！？、）】」』"'…]+$/;

/** 只放行 http(s)/mailto/邮箱；其他 scheme（javascript: 等）直接不给 href。 */
function safeHref(raw) {
  const url = String(raw ?? '').trim();
  if (!url) return '';
  if (/^(?:https?|mailto):/i.test(url)) return url;
  if (/^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(url)) return `mailto:${url}`;
  return '';
}

/** 在已转义文本上做粗体/删除线/斜体替换（占位符里没有这些符号，不会误伤）。 */
function renderEmphasis(escapedText) {
  return escapedText
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/(^|[^\w*])\*(?!\*)(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?!_)(?=\S)([^_\n]*?\S)_(?![\w_])/g, '$1<em>$2</em>');
}

/** 链接显示文字：先转义，再做强调（链接文字里的行内代码占位符会提前还原）。 */
function renderLinkLabel(label, tokens) {
  const escaped = escapeHtml(label);
  const resolved = escaped.replace(PLACEHOLDER_RE, (_, number) => tokens[Number(number)] ?? '');
  return renderEmphasis(resolved);
}

/** 转义除占位符以外的所有字符（占位符里是已经生成好的可信 HTML）。 */
function escapeOutsideTokens(text) {
  return text
    .split(/(\u0000\d+\u0000)/)
    .map((part) => (PLACEHOLDER_FULL_RE.test(part) ? part : escapeHtml(part)))
    .join('');
}

/**
 * 行内渲染：行内代码 → Markdown 链接 → 裸 URL → HTML 转义 → 强调 → 还原占位符。
 * 链接文字后一律用小字附上真实 URL（图片里没法 hover 看 title）。
 */
function renderInline(raw) {
  const text = String(raw ?? '');
  if (!text) return '';
  const tokens = [];
  const stash = (generated) => `\u0000${tokens.push(generated) - 1}\u0000`;

  // 1) 行内代码先占位：代码里的 * _ [ ] 不参与后续格式。
  let joined = '';
  let cursor = 0;
  for (const match of text.matchAll(INLINE_CODE_RE)) {
    joined += text.slice(cursor, match.index);
    joined += stash(`<code>${escapeHtml(match[2].replace(/\n/g, ' '))}</code>`);
    cursor = match.index + match[0].length;
  }
  joined += text.slice(cursor);

  // 2) Markdown 链接：显示文字 + 小字 URL；不安全 scheme 只显示文字。
  joined = joined.replace(LINK_RE, (whole, label, url) => {
    const href = safeHref(url);
    const labelText = String(label).trim();
    const urlText = String(url).trim();
    const display = renderLinkLabel(label, tokens);
    const showUrl = labelText !== urlText;
    const suffix = showUrl ? `<span class="link-url">（${escapeHtml(urlText)}）</span>` : '';
    if (!href) return stash(`${display}${suffix}`);
    return stash(`<a href="${escapeAttr(href)}" title="${escapeAttr(urlText)}">${display}</a>${suffix}`);
  });

  // 3) 裸 URL 自动链接。
  joined = joined.replace(BARE_URL_RE, (whole) => {
    const trailing = URL_TRAILING_PUNCT_RE.exec(whole)?.[0] ?? '';
    const url = whole.slice(0, whole.length - trailing.length);
    if (url.length < 10) return whole;
    const href = /^www\./i.test(url) ? `http://${url}` : url;
    return `${stash(`<a href="${escapeAttr(href)}" title="${escapeAttr(href)}">${escapeHtml(url)}</a>`)}${trailing}`;
  });

  // 4) 正文转义（不接受裸 HTML，一律当文本）。
  joined = escapeOutsideTokens(joined);

  // 5) 强调。
  joined = renderEmphasis(joined);

  // 6) 还原行内代码 / 链接占位符。
  return joined.replace(PLACEHOLDER_RE, (_, number) => tokens[Number(number)] ?? '');
}

// ---------------------------------------------------------------------------
// 公开的纯函数 API
// ---------------------------------------------------------------------------

/**
 * 判断一段文本是否「像 Markdown」：只认强特征，正常聊天句子和纯数字返回 false。
 * 强特征：标题 / 围栏代码块 / 表格 / 引用 / 分割线 / 至少两个列表项 / 粗体或删除线。
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function looksLikeMarkdown(text) {
  if (typeof text !== 'string') return false;
  const source = text.replace(/\r\n?/g, '\n').trim();
  if (!source) return false;
  const lines = source.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s{0,3}#{1,6}[ \t]+\S/.test(line)) return true;
    if (/^\s{0,3}(?:`{3,}|~{3,})/.test(line)) return true;
    if (/^\s{0,3}>[ \t]?\S/.test(line)) return true;
    if (HR_RE.test(line)) return true;
    if (isTableStart(lines, index)) return true;
  }

  if (/\*\*(?=\S)[\s\S]*?\S\*\*/.test(source)) return true;
  if (/~~(?=\S)[\s\S]*?\S~~/.test(source)) return true;

  const listItems = lines.filter((line) => /^\s*(?:[-*+]|\d{1,9}[.)])[ \t]+\S/.test(line));
  if (listItems.length >= 2) return true;

  return false;
}

/** 生成完整 HTML（含内嵌 CSS）：白底深色字、固定 maxWidth、正文不出现横向滚动。 */
export function markdownToHtml(markdown, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const maxWidth = clampInt(options.maxWidth, DEFAULT_RENDER_OPTIONS.maxWidth, 200, 2000);
  const fontSize = clampInt(options.fontSize, DEFAULT_RENDER_OPTIONS.fontSize, 9, 40);
  const padding = clampInt(options.padding, DEFAULT_RENDER_OPTIONS.padding, 0, 120);
  const codeFontSize = Math.max(11, Math.round(fontSize * 0.88));
  const body = parseBlockLines(String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n'));

  const h1 = Math.round(fontSize * 1.75);
  const h2 = Math.round(fontSize * 1.45);
  const h3 = Math.round(fontSize * 1.25);
  const h4 = Math.round(fontSize * 1.12);
  const h5 = Math.round(fontSize * 1.0);
  const h6 = Math.round(fontSize * 0.95);
  const tableFontSize = Math.max(11, Math.round(fontSize * 0.93));
  const linkUrlFontSize = Math.max(10, Math.round(fontSize * 0.8));

  const css = [
    '*{box-sizing:border-box}',
    'html,body{margin:0;padding:0;background:#ffffff}',
    `body{width:${maxWidth}px;padding:${padding}px;color:#1f2328;`
      + `font:${fontSize}px/1.7 "Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif;`
      + '-webkit-font-smoothing:antialiased;overflow-wrap:break-word}',
    'p{margin:0 0 12px}',
    `.markdown > :first-child{margin-top:0}`,
    `.markdown > :last-child{margin-bottom:0}`,
    'h1,h2,h3,h4,h5,h6{margin:20px 0 10px;font-weight:700;line-height:1.35;overflow-wrap:break-word}',
    `h1{font-size:${h1}px;padding-bottom:8px;border-bottom:1px solid #d8dee4}`,
    `h2{font-size:${h2}px;padding-bottom:6px;border-bottom:1px solid #eaeef2}`,
    `h3{font-size:${h3}px}`,
    `h4{font-size:${h4}px}`,
    `h5{font-size:${h5}px}`,
    `h6{font-size:${h6}px;color:#57606a}`,
    'ul,ol{margin:0 0 12px;padding-left:26px}',
    'li{margin:4px 0}',
    'li > ul,li > ol{margin:4px 0}',
    `code{font-family:Consolas,"Cascadia Mono","Courier New",monospace;font-size:${codeFontSize}px;`
      + 'background:#eff1f3;border-radius:4px;padding:1px 5px}',
    `pre{margin:0 0 14px;padding:12px 14px;background:#f6f8fa;border:1px solid #eaeef2;border-radius:8px;`
      + `white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;`
      + `font-size:${codeFontSize}px;line-height:1.55}`,
    'pre code{display:block;background:transparent;border-radius:0;padding:0;font-size:inherit;'
      + 'white-space:inherit;word-break:inherit;overflow-wrap:inherit}',
    'blockquote{margin:0 0 14px;padding:4px 0 4px 14px;border-left:4px solid #d0d7de;'
      + 'color:#57606a;background:#f6f8fa}',
    'blockquote > :last-child{margin-bottom:0}',
    `table{border-collapse:collapse;margin:0 0 14px;max-width:100%;font-size:${tableFontSize}px}`,
    'th,td{border:1px solid #d0d7de;padding:6px 12px;text-align:left;vertical-align:top;overflow-wrap:break-word}',
    'th{background:#f6f8fa;font-weight:600}',
    'hr{height:0;margin:18px 0;border:0;border-top:1px solid #d8dee4}',
    'a{color:#0969da;text-decoration:none;overflow-wrap:break-word}',
    `.link-url{color:#6e7781;font-size:${linkUrlFontSize}px;word-break:break-all}`,
  ].join('\n');

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>Markdown</title>',
    `<style>\n${css}\n</style>`,
    '</head>',
    '<body>',
    `<div class="markdown">\n${body}\n</div>`,
    '</body>',
    '</html>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 进程 / 文件 / PNG 工具
// ---------------------------------------------------------------------------

/**
 * 起一个子进程并等它结束，带超时强杀；任何失败都通过返回值表达，不 reject。
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{timeoutMs?:number, cwd?:string}} [options]
 * @returns {Promise<{ok:boolean, code:number|null, signal:string|null, timedOut:boolean,
 *   stdout:string, stderr:string, error:(Error|null)}>}
 */
function runProcess(file, args, options = {}) {
  const timeoutMs = clampInt(options.timeoutMs, 25000, 100, 10 * 60 * 1000);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        ok: false, code: null, signal: null, timedOut: false, stdout: '', stderr: '', error: err,
      });
      return;
    }

    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    let timer = null;
    let hardTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve(result);
    };

    const settleFrom = (extra) => finish({
      ok: !timedOut && extra.code === 0,
      code: extra.code ?? null,
      signal: extra.signal ?? null,
      timedOut,
      stdout,
      stderr,
      error: extra.error ?? null,
    });

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // 杀不掉就等硬超时兜底
      }
      hardTimer = setTimeout(() => settleFrom({ code: null }), 5000);
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 20000) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 20000) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => settleFrom({ code: null, error: err }));
    child.on('close', (code, signal) => settleFrom({ code, signal }));
  });
}

/** 解析 PNG 文件头拿宽高；不是 PNG 返回 null。 */
function pngSize(bytes) {
  if (!bytes || bytes.length < 24) return null;
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** 探测 Edge：opts.edgePath 优先，其次两个常见安装路径。 */
function resolveEdgePath(injected) {
  if (injected !== undefined && injected !== null && String(injected).trim() !== '') {
    const path = String(injected);
    if (existsSync(path)) return { ok: true, path };
    return { ok: false, error: `找不到 Edge 可执行文件：${path}（请检查 edgePath 配置）` };
  }
  for (const candidate of EDGE_CANDIDATES) {
    if (existsSync(candidate)) return { ok: true, path: candidate };
  }
  return {
    ok: false,
    error: `找不到 Microsoft Edge：已探测 ${EDGE_CANDIDATES.join(' 和 ')}，可用 edgePath 指定`,
  };
}

/** 估算截图高度：宁可估大也不估小（估小了内容会被视口裁掉，裁图救不回来）。 */
function estimateScreenshotHeight(markdown, options) {
  const { maxWidth, fontSize, padding } = options;
  const lineHeight = Math.max(12, Math.round(fontSize * 1.7));
  const contentWidth = Math.max(160, maxWidth - padding * 2);
  const charsPerLine = Math.max(12, Math.floor(contentWidth / (fontSize * 1.15)));
  let total = padding * 2 + 60;
  for (const line of String(markdown ?? '').split('\n')) {
    const rows = Math.max(1, Math.ceil([...line].length / charsPerLine));
    total += rows * lineHeight;
    if (BLANK_RE.test(line)) total += Math.round(lineHeight * 0.5);
    if (/^\s{0,3}#{1,6}[ \t]+/.test(line)) total += Math.round(fontSize * 1.5);
    if (FENCE_RE.test(line)) total += 16;
  }
  const estimated = Math.ceil(total * 1.25);
  return Math.min(MAX_SCREENSHOT_HEIGHT, Math.max(MIN_SCREENSHOT_HEIGHT, estimated));
}

/**
 * 用 Edge headless 截图；失败返回中文原因。
 *
 * 坑：msedge 进程 exit 0 之后截图文件不是立刻落盘的（实测延迟 0.5~2 秒，机器上开着正式
 * Edge 时更明显），所以不能 spawn 一结束就 stat，要轮询等文件出现且大小稳定在 1KB 以上。
 */
async function captureWithEdge(options) {
  const {
    edgePath, htmlPath, pngPath, width, height, timeoutMs, workDir,
  } = options;
  const profileDir = join(workDir, 'edge-profile');
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--force-device-scale-factor=1',
    `--user-data-dir=${profileDir}`,
    `--screenshot=${pngPath}`,
    `--window-size=${width},${height}`,
    pathToFileURL(htmlPath).href,
  ];

  const result = await runProcess(edgePath, args, { timeoutMs, cwd: workDir });
  if (result.timedOut) {
    return { ok: false, error: `Edge 截图超时（${timeoutMs} 毫秒），已强制结束进程` };
  }
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      return { ok: false, error: `找不到 Edge 可执行文件：${edgePath}` };
    }
    return { ok: false, error: `无法启动 Edge：${result.error.message ?? result.error.code ?? '未知错误'}` };
  }
  if (result.code !== 0) {
    const detail = tail(result.stderr) || tail(result.stdout) || '没有输出';
    return { ok: false, error: `Edge 截图失败（退出码 ${result.code}）：${detail}` };
  }

  // 等待截图文件延迟落盘：进程退出 ≠ 文件写完。
  const waitDeadline = Date.now() + 8000;
  let screenshotBytes = 0;
  while (Date.now() < waitDeadline) {
    try {
      if (existsSync(pngPath)) {
        screenshotBytes = statSync(pngPath).size;
        if (screenshotBytes > 1000) break;
      }
    } catch {
      screenshotBytes = 0;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (screenshotBytes <= 1000) {
    return {
      ok: false,
      error: `Edge 进程已退出（退出码 ${result.code}），但 8 秒内没有等到有效的截图文件`
        + '（可能被正在运行的 Edge 单实例吞掉，或 headless 截图参数不被当前版本支持）',
    };
  }
  return { ok: true };
}

// Pillow 裁图脚本：找非白像素外接框，底部留 padding，宽度保持不变（宽度本来就等于 maxWidth）。
const CROP_SCRIPT = [
  'import sys',
  'from PIL import Image, ImageChops',
  'path = sys.argv[1]',
  'pad = int(sys.argv[2]) if len(sys.argv) > 2 else 24',
  'im = Image.open(path).convert("RGB")',
  'w, h = im.size',
  'white = Image.new("RGB", im.size, (255, 255, 255))',
  'diff = ImageChops.difference(im, white).convert("L")',
  'mask = diff.point(lambda v: 255 if v > 5 else 0)',
  'bbox = mask.getbbox()',
  'if bbox is None:',
  '    sys.exit(0)',
  'left = max(0, bbox[0] - pad)',
  'top = max(0, bbox[1] - pad)',
  'right = w',
  'bottom = min(h, bbox[3] + pad)',
  'if top == 0 and bottom >= h:',
  '    sys.exit(0)',
  'im.crop((left, top, right, bottom)).save(path)',
].join('\n');

/** 用 Python + Pillow 裁掉底部（宽度保持 maxWidth）；失败只返回原因，原图保留。 */
async function cropWithPillow(options) {
  const {
    pythonPath, pngPath, padding, timeoutMs,
  } = options;
  const result = await runProcess(
    pythonPath,
    ['-c', CROP_SCRIPT, pngPath, String(padding)],
    { timeoutMs },
  );
  if (result.timedOut) return { ok: false, error: `Python 裁剪超时（${timeoutMs} 毫秒）` };
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      return { ok: false, error: `找不到 Python 可执行文件：${pythonPath}，未执行裁剪` };
    }
    return { ok: false, error: `无法启动 Python：${result.error.message ?? '未知错误'}` };
  }
  if (result.code !== 0) {
    const detail = tail(result.stderr) || '没有输出';
    return { ok: false, error: `Pillow 裁剪失败（退出码 ${result.code}）：${detail}` };
  }
  return { ok: true };
}

/** 清理临时目录里除截图以外的中间文件（HTML / Edge profile / 半成品）。 */
function cleanupWorkDir(workDir, keepPath) {
  if (!workDir) return;
  let entries;
  try {
    entries = readdirSync(workDir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(workDir, name);
    if (keepPath && full === keepPath) continue;
    try {
      rmSync(full, { recursive: true, force: true });
    } catch {
      // 尽力而为：残留一点临时文件不影响出图
    }
  }
}

// ---------------------------------------------------------------------------
// 主 API
// ---------------------------------------------------------------------------

/**
 * 把 Markdown 渲染成一张 PNG（Edge headless 截图 + Pillow 裁白边）。
 *
 * @param {unknown} markdown - Markdown 源文本；空/全空白返回 ok:false
 * @param {object} [opts]
 * @param {string} [opts.edgePath] - Edge 可执行文件路径，默认自动探测
 * @param {string} [opts.pythonPath='python'] - Python 可执行文件
 * @param {number} [opts.timeoutMs=25000] - 单次子进程超时（毫秒）
 * @param {number} [opts.maxWidth=720] - 图片宽度（px）
 * @param {number} [opts.fontSize=15] - 正文字号（px）
 * @param {string} [opts.workDir] - 临时目录的父目录，默认 os.tmpdir()
 * @param {number} [opts.padding=24] - 正文内边距 + 裁剪留白（px）
 * @param {number} [opts.maxChars=8000] - 超过则截断并加「…（内容过长已截断）」
 * @returns {Promise<
 *   {ok:true, path:string, width:number, height:number, bytes:number, ms:number,
 *    truncated?:boolean, warning?:string}
 *   | {ok:false, error:string}>}
 */
export async function renderMarkdownToImage(markdown, opts = {}) {
  const startedAt = Date.now();
  const options = opts && typeof opts === 'object' ? opts : {};
  const maxWidth = clampInt(options.maxWidth, DEFAULT_RENDER_OPTIONS.maxWidth, 200, 2000);
  const fontSize = clampInt(options.fontSize, DEFAULT_RENDER_OPTIONS.fontSize, 9, 40);
  const padding = clampInt(options.padding, DEFAULT_RENDER_OPTIONS.padding, 0, 120);
  const maxChars = clampInt(options.maxChars, DEFAULT_RENDER_OPTIONS.maxChars, 100, 200000);
  const timeoutMs = clampInt(options.timeoutMs, DEFAULT_RENDER_OPTIONS.timeoutMs, 1000, 10 * 60 * 1000);
  const pythonPath = options.pythonPath ? String(options.pythonPath) : 'python';

  let source = typeof markdown === 'string' ? markdown : markdown === undefined || markdown === null ? '' : String(markdown);
  source = source.replace(/\r\n?/g, '\n').trim();
  if (!source) {
    return { ok: false, error: 'Markdown 内容为空（或全是空白），无法渲染成图片' };
  }

  let truncated = false;
  if (source.length > maxChars) {
    source = `${source.slice(0, maxChars).replace(/\s+$/u, '')}\n\n…（内容过长已截断）`;
    truncated = true;
  }

  const edge = resolveEdgePath(options.edgePath);
  if (!edge.ok) return { ok: false, error: edge.error };

  let workDir = '';
  let pngPath = '';
  try {
    const baseDir = options.workDir ? String(options.workDir) : tmpdir();
    if (options.workDir) mkdirSync(baseDir, { recursive: true });
    workDir = mkdtempSync(join(baseDir, 'dsh-md-image-'));
    const htmlPath = join(workDir, 'markdown.html');
    pngPath = join(workDir, 'markdown.png');

    const html = markdownToHtml(source, { maxWidth, fontSize, padding });
    const height = estimateScreenshotHeight(source, { maxWidth, fontSize, padding });

    try {
      writeFileSync(htmlPath, html, 'utf8');
    } catch (err) {
      return { ok: false, error: `写入临时 HTML 失败：${err?.message ?? '未知错误'}` };
    }

    const captured = await captureWithEdge({
      edgePath: edge.path,
      htmlPath,
      pngPath,
      width: maxWidth,
      height,
      timeoutMs,
      workDir,
    });
    if (!captured.ok) {
      cleanupWorkDir(workDir, '');
      return captured;
    }

    let screenshotBytes;
    try {
      screenshotBytes = readFileSync(pngPath);
    } catch (err) {
      cleanupWorkDir(workDir, '');
      return { ok: false, error: `读取截图失败：${err?.message ?? '未知错误'}` };
    }
    const rawSize = pngSize(screenshotBytes);
    if (!rawSize) {
      cleanupWorkDir(workDir, '');
      return { ok: false, error: 'Edge 生成的截图不是有效的 PNG 文件' };
    }

    // 裁剪是锦上添花：失败就用原图，不让整条链路失败。
    const cropTimeoutMs = Math.min(timeoutMs, 15000);
    const crop = await cropWithPillow({
      pythonPath, pngPath, padding, timeoutMs: cropTimeoutMs,
    });
    let warning = '';
    if (!crop.ok) warning = `裁剪失败，已保留未裁剪原图：${crop.error}`;

    let finalBytes;
    try {
      finalBytes = readFileSync(pngPath);
    } catch (err) {
      cleanupWorkDir(workDir, '');
      return { ok: false, error: `读取裁剪后的图片失败：${err?.message ?? '未知错误'}` };
    }
    const size = pngSize(finalBytes);
    if (!size) {
      cleanupWorkDir(workDir, '');
      return { ok: false, error: '裁剪后的图片不是有效的 PNG 文件' };
    }

    cleanupWorkDir(workDir, pngPath);

    const result = {
      ok: true,
      path: pngPath,
      width: size.width,
      height: size.height,
      bytes: finalBytes.length,
      ms: Date.now() - startedAt,
    };
    if (truncated) result.truncated = true;
    if (warning) result.warning = warning;
    return result;
  } catch (err) {
    cleanupWorkDir(workDir, '');
    return { ok: false, error: `渲染 Markdown 图片失败：${err?.message ?? String(err)}` };
  }
}
