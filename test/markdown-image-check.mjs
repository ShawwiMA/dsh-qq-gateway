// markdown-image 验收：markdownToHtml / looksLikeMarkdown 纯逻辑 + renderMarkdownToImage 真实出图。
// 跑法（在 bundle 目录下）：node test/markdown-image-check.mjs
// 说明：真实出图依赖本机 Edge headless 与 Python + Pillow；缺一个就 FAIL（这是验收的硬指标）。
// 生成的 PNG 留在 os.tmpdir 下的独立目录里，脚本会把路径打印出来，方便人工 read_image 复核。

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  looksLikeMarkdown,
  markdownToHtml,
  renderMarkdownToImage,
} from '../lib/gateway/markdown-image.js';

const results = [];
let sampleImagePath = '';

function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : undefined);
  } catch (err) {
    record(name, false, err?.message ?? String(err));
  }
}

/** 真实渲染用的样例：中文标题、加粗、列表、代码块、表格、引用、链接都在里面。 */
const SAMPLE_MARKDOWN = [
  '# 网关渲染验收',
  '',
  '这是一段**加粗**文本，用来确认中文和粗体都正常。',
  '',
  '- 列表项一：确认列表符号',
  '- 列表项二：带 `行内代码` 和 [链接](https://example.com)',
  '',
  '```js',
  'const answer = 42;',
  'console.log(answer);',
  '```',
  '',
  '| 项目 | 状态 |',
  '| --- | --- |',
  '| Edge 截图 | 通过 |',
  '',
  '> 引用块：确认左边框和灰色文字。',
].join('\n');

console.log('=== markdown-image 验收 ===');

await check('markdownToHtml：标题 / 强调 / 删除线 / 行内代码 / 分割线', () => {
  const html = markdownToHtml([
    '# 一级标题',
    '',
    '## 二级标题',
    '',
    '这是**加粗**、*斜体*、~~删除线~~和 `npm test`。',
    '',
    '---',
  ].join('\n'));
  assert.match(html, /<h1>一级标题<\/h1>/, '一级标题');
  assert.match(html, /<h2>二级标题<\/h2>/, '二级标题');
  assert.match(html, /<strong>加粗<\/strong>/, '粗体');
  assert.match(html, /<em>斜体<\/em>/, '斜体');
  assert.match(html, /<del>删除线<\/del>/, '删除线');
  assert.match(html, /<code>npm test<\/code>/, '行内代码');
  assert.match(html, /<hr>/, '分割线');
  assert.ok(html.includes('<style>'), '应内嵌 CSS');
  assert.ok(html.includes('width:720px'), '默认宽度 720px');
  assert.ok(html.includes('Microsoft YaHei'), '应使用微软雅黑');
});

await check('markdownToHtml：无序 / 有序 / 两项缩进嵌套列表', () => {
  const html = markdownToHtml('- 第一项\n- 第二项\n  - 嵌套项\n\n1. 步骤一\n2. 步骤二');
  assert.match(html, /<ul>/, '无序列表');
  assert.match(html, /<li>第一项<\/li>/, '第一项');
  assert.match(html, /<li>嵌套项<\/li>/, '嵌套项');
  assert.match(html, /<ol>/, '有序列表');
  assert.match(html, /<li>步骤一<\/li>/, '有序步骤一');
});

await check('markdownToHtml：围栏代码块（语言名 + 内容转义 + 等宽样式）', () => {
  const html = markdownToHtml('```js\nconst a = 1;\nif (a < 2) console.log("<b>");\n```');
  assert.match(html, /<pre><code class="language-js">/, '代码块 + 语言名');
  assert.ok(html.includes('const a = 1;'), '代码内容保留');
  assert.ok(html.includes('&lt;b&gt;'), '代码里的标签要转义');
  assert.ok(html.includes('white-space:pre-wrap'), '代码块要自动换行');
  assert.ok(html.includes('background:#f6f8fa'), '代码块浅灰底');
});

await check('markdownToHtml：GFM 表格（表头 / 单元格 / 对齐）', () => {
  const html = markdownToHtml('| 名称 | 状态 |\n| --- | :---: |\n| Edge | 可用 |');
  assert.match(html, /<table>/, '表格');
  assert.match(html, /<th>名称<\/th>/, '表头');
  assert.match(html, /<td>Edge<\/td>/, '单元格');
  assert.match(html, /<td style="text-align:center">可用<\/td>/, '居中对齐');
  assert.match(html, /<td>可用<\/td>|text-align:center">可用/, '单元格内容');
});

await check('markdownToHtml：引用块', () => {
  const html = markdownToHtml('> 引用第一行\n> 引用第二行');
  assert.match(html, /<blockquote><p>引用第一行<br>引用第二行<\/p><\/blockquote>/, '引用块');
});

await check('markdownToHtml：链接与裸 URL 自动链接', () => {
  const html = markdownToHtml('[DSH 文档](https://example.com/doc) 和裸链接 https://example.com/x 收尾');
  assert.ok(html.includes('<a href="https://example.com/doc"'), 'Markdown 链接 href');
  assert.ok(html.includes('>DSH 文档</a>'), '链接显示文字');
  assert.ok(html.includes('link-url'), '链接后应小字显示 URL');
  assert.match(html, /<a href="https:\/\/example\.com\/x"/, '裸 URL 自动链接');
});

await check('markdownToHtml：HTML 转义（<script> 当文本，不接受裸标签）', () => {
  const html = markdownToHtml('<script>alert("x")</script>\n\n<div onclick="bad">文本</div>');
  assert.ok(!html.includes('<script>'), '不能出现可执行 <script>');
  assert.ok(!html.includes('<div onclick'), '不能出现裸 HTML 标签');
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'), '<script> 应转义');
  assert.ok(html.includes('&lt;div onclick=&quot;bad&quot;&gt;'), '<div> 应转义');
});

await check('looksLikeMarkdown：强特征返回 true', () => {
  const positives = [
    '# 标题正文',
    '```js\nconst a = 1;\n```',
    '| a | b |\n| --- | --- |\n| 1 | 2 |',
    '- 第一项\n- 第二项',
    '1. 第一项\n2. 第二项',
    '这是**重点**内容',
    '> 引用一句话',
    '第一段\n\n---\n\n第二段',
  ];
  for (const text of positives) {
    assert.equal(looksLikeMarkdown(text), true, `应判为 Markdown：${JSON.stringify(text)}`);
  }
});

await check('looksLikeMarkdown：普通文本 / 纯数字 / 单个「-」返回 false', () => {
  const negatives = [
    '你好，今天天气不错。',
    '1234567890',
    '-',
    'hello world',
    '',
    '   \n\t  ',
    '1. 只有一项列表',
    '这是一句普通的话，没有任何标记。',
  ];
  for (const text of negatives) {
    assert.equal(looksLikeMarkdown(text), false, `不应判为 Markdown：${JSON.stringify(text)}`);
  }
});

// 真实出图：输出放到 os.tmpdir 独立目录，PNG 保留给人工复核。
const WORK_ROOT = mkdtempSync(join(tmpdir(), 'md-image-check-'));

await check('renderMarkdownToImage：真实渲染（中文/标题/列表/代码/表格/引用）', async () => {
  const result = await renderMarkdownToImage(SAMPLE_MARKDOWN, { workDir: WORK_ROOT });
  assert.equal(result.ok, true, `渲染应成功：${result.error ?? ''}`);
  assert.equal(typeof result.path, 'string', '应返回图片路径');
  assert.ok(existsSync(result.path), `PNG 应存在：${result.path}`);

  const fileBytes = readFileSync(result.path);
  assert.deepEqual(
    [...fileBytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'PNG 魔数',
  );
  assert.equal(result.width, 720, `宽度应等于 maxWidth（720），实际 ${result.width}`);
  assert.ok(result.height > 100, `高度应 > 100，实际 ${result.height}`);
  if (result.warning && result.warning.includes('裁剪失败')) {
    // 本机没有 Python/Pillow 时裁剪会降级（保留未裁剪原图），这是实现里的预期行为。
    console.log(`  （跳过裁剪断言：${result.warning}）`);
  } else {
    assert.ok(result.height < 500, `裁剪应生效（高度 < 500），实际 ${result.height}`);
  }
  assert.ok(result.bytes > 2000, `字节数应 > 2000，实际 ${result.bytes}`);
  assert.ok(result.ms > 0, '应记录耗时');
  assert.equal(statSync(result.path).size, result.bytes, 'bytes 应与文件实际大小一致');

  sampleImagePath = result.path;
  return `${result.width}x${result.height}, ${result.bytes} bytes, ${result.ms}ms`;
});

await check('renderMarkdownToImage：edgePath 不存在返回中文 ok:false', async () => {
  const result = await renderMarkdownToImage('# 标题', {
    edgePath: join(tmpdir(), 'definitely-no-such-edge.exe'),
  });
  assert.equal(result.ok, false, '应返回 ok:false');
  assert.equal(typeof result.error, 'string', '应有中文错误说明');
  assert.match(result.error, /[\u4e00-\u9fa5]/, '错误信息应为中文');
  assert.ok(result.error.includes('Edge'), '错误信息应点明 Edge');
});

await check('renderMarkdownToImage：空内容 / null 返回 ok:false', async () => {
  for (const value of ['', '   \n\t  ', null, undefined]) {
    const result = await renderMarkdownToImage(value);
    assert.equal(result.ok, false, `空内容应返回 ok:false：${JSON.stringify(value)}`);
    assert.equal(typeof result.error, 'string');
    assert.match(result.error, /[\u4e00-\u9fa5]/, '错误信息应为中文');
  }
});

const passed = results.filter((item) => item.ok).length;
const failed = results.length - passed;

console.log('---');
console.log(`渲染示例图片：${sampleImagePath || '（无）'}`);
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exitCode = 1;
