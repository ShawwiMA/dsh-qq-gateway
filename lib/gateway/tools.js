/**
 * M6：QQ 网关模型工具（qq_*）—— 把网关能力暴露给 DSH 会话里的模型。
 *
 * 设计要点：
 * 1) 工具用 ctx.tools.register 全局注册：QQ 网关会话和普通 GUI 会话都能看到。
 * 2) 「当前 QQ 对话」= 网关正在处理的那条入站消息/事件。只有 QQ 网关会话
 *    （sessionId 一致）才能省略 user_id/group_id；其他会话必须显式给目标，
 *    避免在 GUI 里随口一句就发到 QQ。
 * 3) 发图片/文件不能给容器内路径：NapCat 跑在 Docker 里看不到宿主机路径，
 *    所以工具只收「本机绝对路径」或 http(s) URL，由网关读文件转 base64 再发。
 * 4) 所有 execute 都捕获异常并返回 {ok:false,error}，不把异常丢给宿主——
 *    模型看到结构化失败比看到一个红叉更好自查。
 *
 * 依赖：@deepseek-ai/dsh-tools 的 defineTool。bundle 目录已建 node_modules 软链
 * （与 dsh-plugin-screen-control 同做法），缺它时 index.js 会跳过工具注册。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

import { actionRisk, describeAction, listActions } from './actions.js';

/** 统一的模型可见文本渲染。 */
function asText(value, hint) {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  return [{ type: 'text', text: hint ? `${body}\n${hint}` : body }];
}

/** 把 JSON 值转成一行可读的键值串（qq_actions 目录用）。 */
function formatParams(params) {
  if (!Array.isArray(params) || params.length === 0) return '（无参数）';
  return params
    .map((p) => `${p.name}${p.required ? '' : '?'}(${p.type})${p.desc ? ` ${p.desc}` : ''}`)
    .join('；');
}

/** 组装 qq_send 的消息段：简单参数 + segments 数组按顺序拼起来。 */
function partsOf(args) {
  const parts = [];
  if (args.reply_to !== undefined && args.reply_to !== null && args.reply_to !== '') {
    parts.push({ type: 'reply', message_id: args.reply_to });
  }
  if (args.at !== undefined && args.at !== null && args.at !== '') {
    parts.push({ type: 'at', qq: args.at });
  }
  if (args.text !== undefined && args.text !== null && args.text !== '') {
    parts.push({ type: 'text', text: String(args.text) });
  }
  if (args.image !== undefined && args.image !== null && args.image !== '') {
    const image = String(args.image);
    parts.push(/^https?:\/\//i.test(image) ? { type: 'image', url: image } : { type: 'image', path: image });
  }
  if (Array.isArray(args.segments)) parts.push(...args.segments);
  return parts;
}

/**
 * 解析发送目标：
 * - 显式 group_id → 群聊；显式 user_id → 私聊；
 * - 都没给：只有 QQ 网关会话能用「当前对话」兜底（没有在飞对话时回退到主号私聊）。
 */
function resolveTarget(args, exec, cfg, gateway) {
  const groupId = args.group_id !== undefined && args.group_id !== null ? String(args.group_id).trim() : '';
  const userId = args.user_id !== undefined && args.user_id !== null ? String(args.user_id).trim() : '';
  if (groupId) return { source: 'group', groupId };
  if (userId) return { source: 'private', userId };
  const inGatewaySession = String(exec?.agent?.id ?? '') === String(cfg.sessionId);
  if (!inGatewaySession) {
    throw new Error('当前不在 QQ 网关会话里：必须显式传 group_id（群）或 user_id（私聊）');
  }
  const current = gateway.currentContext();
  if (current && current.active && current.source) {
    if (current.source === 'group' && current.groupId) return { source: 'group', groupId: current.groupId };
    if (current.source === 'private' && current.userId) return { source: 'private', userId: current.userId };
  }
  if (cfg.mainQQ) return { source: 'private', userId: String(cfg.mainQQ) };
  throw new Error('没有正在处理的 QQ 对话，也没有配置 mainQQ 兜底：请显式传 group_id 或 user_id');
}

/** 事件列表的渲染：每条一行，带 seq/时间/类型。 */
function formatEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return '（没有事件）';
  return events
    .map((e) => `#${e.seq} ${e.at ?? ''} [${e.type}] ${e.description ?? ''}`)
    .join('\n');
}

/**
 * 生成全部 qq_* 工具定义。index.js 负责注册（ctx.tools.register），
 * 离线测试可以直接调 createQqTools(...) 拿定义再调 execute。
 *
 * @param {object} options
 * @param {object} options.gateway - createGateway 返回的网关对象（含 sendMessage/recall/callAction/listEvents/currentContext/status）
 * @param {object} options.config - 已归一化的配置
 * @param {(message: string) => void} [options.logger]
 */
export function createQqTools({ gateway, config: cfg, logger } = {}) {
  if (!gateway || typeof gateway.sendMessage !== 'function') {
    throw new Error('createQqTools: gateway.sendMessage 不可用');
  }
  const log = typeof logger === 'function' ? logger : () => {};
  const sendTimeoutMs = Number(cfg?.sendTimeoutMs) > 0 ? Number(cfg.sendTimeoutMs) : 15000;
  const toolList = [];

  const add = (definition) => {
    toolList.push(definition);
    return definition;
  };

  add(defineTool({
    name: 'qq_send',
    description: '通过 QQ 网关发消息（文字/图片/@/表情/语音/视频/文件/卡片/合并转发等）。' +
      '不给目标时发到当前 QQ 对话（只在 QQ 网关会话里可用）；其他会话必须显式给 group_id 或 user_id。' +
      '图片给本机绝对路径或 http(s) URL（NapCat 在 Docker 里，看不到宿主机路径，网关会读文件转 base64）。' +
      'QQ 聊天框**不渲染 Markdown**：要发排版好的 md，用 markdown 参数（网关渲染成图片再发），不要塞进 text。' +
      '复杂消息用 segments 传 OneBot 消息段数组，支持 type: text/at/reply/image/face/mface/record/video/file/json/contact/dice/rps/shake。' +
      '注意：NapCat 普通账号不支持发送 markdown / share 段（实测 markdown 超时、share 报未知消息类型），要用 markdown 参数或 qq_invite。',
    parameters: {
      user_id: { type: 'json', description: '私聊对象 QQ 号；与 group_id 二选一；都不给=当前 QQ 对话' },
      group_id: { type: 'json', description: '群号；与 user_id 二选一' },
      text: { type: 'string', description: '纯文本内容（给了 markdown 时作为图片的附言）' },
      markdown: { type: 'string', description: 'Markdown 文本：网关用 Edge 渲染成图片再发（QQ 不渲染 md）。支持标题/列表/表格/代码块/引用' },
      image: { type: 'string', description: '单张图片：本机绝对路径或 http(s) URL（多张用 segments）' },
      at: { type: 'string', description: '群消息里 @ 某人（QQ 号）或填 all 表示 @全体成员' },
      reply_to: { type: 'json', description: '引用回复的消息 id（OneBot message_id）' },
      segments: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'OneBot 消息段数组，按顺序追加' },
    },
    timeoutMs: sendTimeoutMs + 15000,
    output: { schema: { type: 'json' }, render: (_args, value) => asText(value, '提示：拿到 message_id 后 2 分钟内可以用 qq_recall 撤回。') },
    execute: async (args, exec) => {
      try {
        const target = resolveTarget(args, exec, cfg, gateway);
        // M6.4：只有 QQ 网关会话里的工具发送才参与"防双发"记账；GUI 里手动发的消息不算。
        const via = String(exec?.agent?.id ?? '') === String(cfg.sessionId) ? 'tool' : 'external';
        if (args.markdown !== undefined && args.markdown !== null && String(args.markdown).trim() !== '') {
          const result = await gateway.sendMarkdownMessage({
            ...target,
            markdown: String(args.markdown),
            caption: args.text ? String(args.text) : undefined,
            via,
          });
          log(`tool qq_send markdown -> ${target.source} message_id=${result.messageId ?? '(未捕获)'}`);
          return {
            ok: true,
            rendered: 'image',
            message_id: result.messageId ?? null,
            action: result.action,
            target: result.source === 'group' ? { kind: 'group', group_id: result.groupId } : { kind: 'private', user_id: result.userId },
            markdown_image: result.markdown_image,
          };
        }
        const parts = partsOf(args);
        if (parts.length === 0) return { ok: false, error: '没有可发送的内容：text / markdown / image / segments 至少给一个' };
        // NapCat 普通账号发不出去的段，提前给可执行的替代方案（比把 NapCat 的报错原样丢给用户好）
        const unsupported = parts.find((part) => part && (part.type === 'markdown' || part.type === 'share'));
        if (unsupported) {
          return {
            ok: false,
            error: unsupported.type === 'markdown'
              ? 'NapCat 普通账号不支持 markdown 消息段（实测发送超时）：要发 Markdown 请用 qq_send 的 markdown 参数（网关渲染成图片再发）'
              : 'NapCat 不支持 share 消息段（实测报「未知的消息类型：share」）：发群邀请用 qq_invite（Ark 群卡片）',
          };
        }
        const result = await gateway.sendMessage({ ...target, parts, via });
        log(`tool qq_send -> ${result.source} ${result.source === 'group' ? result.groupId : result.userId} message_id=${result.messageId ?? '(未捕获)'}`);
        return {
          ok: true,
          message_id: result.messageId ?? null,
          action: result.action,
          target: result.source === 'group' ? { kind: 'group', group_id: result.groupId } : { kind: 'private', user_id: result.userId },
        };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  }));

  add(defineTool({
    name: 'qq_recall',
    description: '撤回 QQ 消息（OneBot delete_msg）。不传 message_id 时撤回当前 QQ 对话里最近一条由网关发出、' +
      '且成功拿到 message_id 的消息。注意 QQ 群消息撤回窗口只有 2 分钟（服务器强制），超时会失败。',
    parameters: {
      message_id: { type: 'json', description: '要撤回的消息 id；不传=最近一条网关发出的消息' },
    },
    timeoutMs: sendTimeoutMs + 5000,
    output: { schema: { type: 'json' }, render: (_args, value) => asText(value) },
    execute: async (args) => {
      try {
        const result = await gateway.recall({ messageId: args.message_id });
        return { ok: true, message_id: result.messageId, via: 'delete_msg' };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  }));

  add(defineTool({
    name: 'qq_notice',
    description: '发送群公告（NapCat _send_group_notice）。注意：这个动作走 NapCat 的 WebApi（qun.qq.com），' +
      '需要 NapCat 容器能访问外网；报 TLS/网络错误时把原文告诉用户，一般是容器代理/网络问题，不是参数问题。' +
      '发完可以 qq_action _get_group_notice 查看（拿 notice_id），要删用 _del_group_notice。',
    parameters: {
      group_id: { type: 'json', required: true, description: '群号' },
      content: { type: 'string', required: true, description: '公告正文（纯文本，支持换行）' },
      image: { type: 'string', description: '公告图片：本机绝对路径或 http(s) URL（可选）' },
      pinned: { type: 'boolean', description: '是否置顶，默认 false' },
      confirm_required: { type: 'boolean', description: '是否要求成员确认已读，默认 true' },
      is_show_edit_card: { type: 'boolean', description: '是否显示改群名片引导，默认 false' },
    },
    timeoutMs: sendTimeoutMs + 15000,
    output: { schema: { type: 'json' }, render: (_args, value) => asText(value) },
    execute: async (args) => {
      try {
        const params = {
          group_id: args.group_id,
          content: args.content,
          pinned: args.pinned === true ? 1 : 0,
          confirm_required: args.confirm_required === false ? 0 : 1,
          is_show_edit_card: args.is_show_edit_card === true ? 1 : 0,
        };
        if (args.image) params.image = args.image;
        const result = await gateway.callAction('_send_group_notice', params);
        log('tool qq_notice ok');
        return { ok: true, action: result.action, data: result.data ?? null };
      } catch (err) {
        return {
          ok: false,
          error: `${err?.message ?? String(err)}（群公告走 NapCat WebApi，需要容器能访问 qun.qq.com；TLS/网络错误一般是容器代理没配好）`,
        };
      }
    },
  }));

  add(defineTool({
    name: 'qq_invite',
    description: '拉人进群：先拿群分享/加群链接（NapCat get_group_share_link，原生接口），给了 user_id 时私聊把' +
      '「群名片 Ark 卡片」（ArkShareGroup 的 JSON，点击可进群）或链接发给对方。' +
      '不给 user_id 只返回链接，由你自己决定怎么发（qq_send 发文本链接也行）。',
    parameters: {
      group_id: { type: 'json', required: true, description: '群号' },
      user_id: { type: 'json', description: '要私聊邀请的 QQ 号；不给=只返回链接' },
      text: { type: 'string', description: '附言，默认「点击加入群聊」' },
      send_style: { type: 'string', enum: ['card', 'text', 'both'], description: '发法：card=群名片 Ark 卡片（默认，可点进群）/ text=纯文本链接 / both=卡片+链接' },
    },
    timeoutMs: sendTimeoutMs + 20000,
    output: { schema: { type: 'json' }, render: (_args, value) => asText(value) },
    execute: async (args) => {
      try {
        const link = await gateway.callAction('get_group_share_link', { group_id: args.group_id, need_short_url: true });
        const url = typeof link.data === 'string' ? link.data : link.data?.url;
        if (!url) return { ok: false, error: `get_group_share_link 没返回 url：${JSON.stringify(link.data ?? null).slice(0, 200)}` };
        const result = { ok: true, group_id: String(args.group_id), url, sent: false };
        const inviteText = args.text || '点击加入群聊';
        if (args.user_id !== undefined && args.user_id !== null && String(args.user_id).trim() !== '') {
          const style = args.send_style ?? 'card';
          const parts = [];
          let cardSent = false;
          if (style === 'card' || style === 'both') {
            // share 段 NapCat 发不出去（实测报「未知的消息类型：share」），所以卡片走 Ark JSON：
            // ArkShareGroup 返回 com.tencent.contact.lua 群名片，作为 json 段发出去 QQ 会渲染成可点群卡片。
            try {
              const ark = await gateway.callAction('ArkShareGroup', { group_id: args.group_id });
              if (typeof ark.data === 'string' && ark.data.trim().startsWith('{')) {
                parts.push({ type: 'json', data: ark.data });
                cardSent = true;
              }
            } catch (err) {
              log(`qq_invite ArkShareGroup 失败，回退文本链接：${err?.message ?? String(err)}`);
            }
            if (!cardSent) parts.push({ type: 'text', text: `${inviteText}：${url}` });
          }
          if (style === 'text' || (style === 'both' && cardSent)) {
            parts.push({ type: 'text', text: `${inviteText}：${url}` });
          }
          if (parts.length === 0) parts.push({ type: 'text', text: `${inviteText}：${url}` });
          const sent = await gateway.sendMessage({ source: 'private', userId: args.user_id, parts });
          result.sent = true;
          result.user_id = String(args.user_id);
          result.style = style;
          result.card = cardSent;
          result.message_id = sent.messageId ?? null;
          log(`tool qq_invite -> private ${args.user_id} card=${cardSent} url=${url}`);
        } else {
          log(`tool qq_invite link group=${args.group_id} url=${url}`);
        }
        return result;
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  }));

  add(defineTool({
    name: 'qq_action',
    description: '调用任意 OneBot 11 动作（查询/管理/其他）。先用 qq_actions 查动作名和参数。' +
      '查询类动作永远可用；写/破坏性管理动作（踢人、禁言、改群名、退群、删精华、处理加好友/加群请求等）' +
      '需要网关配置 managementEnabled=true（默认开）。返回 NapCat 的 data 原样。',
    parameters: {
      action: { type: 'string', required: true, description: 'OneBot 动作名，例如 get_login_info / get_group_list / _send_group_notice / get_group_share_link / _get_group_notice / _del_group_notice' },
      params: { type: 'object', additionalProperties: true, description: '动作参数对象；没有参数就传 {} 或省略' },
    },
    timeoutMs: sendTimeoutMs + 5000,
    output: { schema: { type: 'json' }, render: (_args, value) => asText(value) },
    execute: async (args) => {
      const action = typeof args.action === 'string' ? args.action.trim() : '';
      if (!action) return { ok: false, error: '缺少 action；先调用 qq_actions 查可用动作和参数' };
      try {
        const known = describeAction(action);
        if (!known) return { ok: false, error: `未知 action "${action}"：先调用 qq_actions 查目录（动作名必须与 OneBot/NapCat 完全一致）` };
        // 安全升级：写/破坏性动作只允许「主号发起的那一轮」触发；其他会话、其他人一律拒绝。
        // 查询类动作不受影响（模型查群信息/历史不需要主号）。
        const risk = actionRisk(action) ?? 'write';
        if (risk !== 'read' && cfg?.highRiskActionsRequireMain !== false) {
          const turn = typeof gateway.currentContext === 'function' ? gateway.currentContext() : null;
          if (!turn?.active || String(turn.userId ?? '') !== String(cfg.mainQQ)) {
            return { ok: false, error: `写/破坏性动作（${action}）只能由主号发起：当前不是主号回合` };
          }
        }
        const result = await gateway.callAction(action, args.params ?? {});
        log(`tool qq_action ${action} ok`);
        return { ok: true, action: result.action, data: result.data ?? null, retcode: result.retcode ?? 0 };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  }));

  add(defineTool({
    name: 'qq_actions',
    description: '列出 QQ 网关支持的全部 OneBot 动作目录：动作名、类别（message/media/query/manage/meta）、' +
      '风险级别（read/write/destructive）、参数名与类型。发复杂动作前先查这个，别猜参数名。',
    parameters: {
      category: { type: 'string', enum: ['message', 'media', 'query', 'manage', 'meta'], description: '只看某个类别；省略=全部' },
      keyword: { type: 'string', description: '按动作名/说明里的关键词过滤，例如 group / ban / image' },
    },
    timeoutMs: 15000,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const list = Array.isArray(value?.actions) ? value.actions : [];
        const text = list
          .map((a) => `[${a.name}] ${a.summary}（${a.category}/${a.risk}）\n  参数：${formatParams(a.params)}`)
          .join('\n');
        return asText(text || '（没有匹配的动作）', '提示：用 qq_action({action, params}) 调用；写/破坏性动作需要 managementEnabled=true。');
      },
    },
    execute: async (args) => {
      const filter = {};
      if (args.category) filter.category = args.category;
      let actions = listActions(filter);
      const keyword = typeof args.keyword === 'string' ? args.keyword.trim().toLowerCase() : '';
      if (keyword) {
        actions = actions.filter((a) => `${a.name} ${a.summary}`.toLowerCase().includes(keyword));
      }
      return { ok: true, count: actions.length, actions };
    },
  }));

  add(defineTool({
    name: 'qq_events',
    description: '查看 QQ 侧最近的事件（撤回、成员增减、管理员变动、禁言、好友申请、加群申请、精华、群文件、' +
      '心跳/登录生命周期、小号自己发出的消息等）。可以按 kind 过滤，也可以只看还没处理的申请（pending_only）。',
    parameters: {
      kind: { type: 'string', enum: ['notice', 'request', 'meta_event', 'message_sent'], description: '只看某一类事件' },
      limit: { type: 'integer', description: '最多返回几条，默认 20，上限 100' },
      since_seq: { type: 'integer', description: '只看 seq 大于它的新事件（增量拉取）' },
      pending_only: { type: 'boolean', description: 'true=只看还没处理的好友/加群申请' },
    },
    timeoutMs: 15000,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const events = Array.isArray(value?.events) ? value.events : [];
        const pending = Array.isArray(value?.pending_requests) ? value.pending_requests : [];
        const head = `共 ${value?.total ?? 0} 条事件（返回 ${events.length} 条），待处理申请 ${pending.length} 条`;
        return asText(`${head}\n${formatEvents(events)}`, '提示：处理好友/加群申请用 qq_action 的 set_friend_add_request / set_group_add_request（参数带 flag）。');
      },
    },
    execute: async (args) => {
      try {
        const data = await gateway.listEvents({
          kind: args.kind,
          sinceSeq: args.since_seq,
          limit: args.limit,
          pendingOnly: args.pending_only === true,
        });
        return { ok: true, ...data };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  }));

  add(defineTool({
    name: 'qq_status',
    description: 'QQ 网关状态：连接/登录（心跳、生命周期、账号）、事件计数、最近发出的消息、会话目标、配置摘要。' +
      '排查「QQ 没回消息」「小号掉线」「心跳停了」时先看它。',
    parameters: {},
    timeoutMs: 15000,
    output: { schema: { type: 'json' }, render: (_args, value) => asText(value) },
    execute: async () => {
      try {
        const status = gateway.status();
        // config 里的 token 本来就不回显；这里只去掉体积最大、对模型没用的字段
        const { lastPromptError, ...rest } = status;
        return { ok: true, status: rest, last_prompt_error: lastPromptError ?? null };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  }));

  add(defineTool({
    name: 'qq_mute',
    description: '禁回（禁止回复）：让网关在一段时间内不再处理指定 QQ 发来的消息——不投给会话、不自动回复，直接丢。主号永远不受影响。' +
      'action=mute：qq 省略或填 all=全局禁回（主号以外的所有人），qq=QQ号=只禁这个人；minutes 省略=默认 30 分钟，0=一直禁到解除。' +
      'action=unmute：qq 省略或 all=全部解除，qq=QQ号=只解这个人。action=list：看当前禁回。' +
      '立即生效并落盘（DSH 重启后仍有效）；主号在 QQ 里发 /mute、/unmute 效果完全一样。',
    parameters: {
      action: { type: 'string', description: 'mute / unmute / list；默认 list' },
      qq: { type: 'string', description: 'QQ 号；或 all / 全部 表示全局' },
      minutes: { type: 'json', description: '禁回分钟数；0=永久直到解除；省略=默认 30 分钟' },
      reason: { type: 'string', description: '备注，写进状态文件' },
    },
    timeoutMs: 10000,
    output: { schema: { type: 'json' }, render: (_args, value) => asText(value, '提示：禁回期间对方发的消息会被直接丢弃，不会进会话。') },
    execute: async (args) => {
      try {
        const mute = gateway.mute;
        if (!mute) return { ok: false, error: '禁回不可用（网关未启动）' };
        const action = String(args.action ?? 'list').trim().toLowerCase();
        const raw = String(args.qq ?? '').trim();
        const all = ['', 'all', '全部', '所有人'].includes(raw.toLowerCase());
        const minutes = args.minutes === undefined || args.minutes === null || args.minutes === ''
          ? null : Number(args.minutes);
        if (action === 'list' || action === 'status') {
          return { ok: true, active: mute.list(), text: mute.describe() };
        }
        if (action === 'unmute' || action === 'clear') {
          if (all) {
            const res = mute.clearAll();
            return { ok: true, cleared: res.cleared, text: res.cleared ? '已解除全部禁回' : '本来就没有禁回' };
          }
          if (!/^\d{5,15}$/.test(raw)) return { ok: false, error: 'QQ 号不合法（5-15 位数字）' };
          const res = mute.clearPeer(raw);
          return { ok: true, ...res };
        }
        if (action !== 'mute') return { ok: false, error: `未知 action：${action}（mute/unmute/list）` };
        if (minutes !== null && (!Number.isFinite(minutes) || minutes < 0)) {
          return { ok: false, error: 'minutes 必须是非负数字' };
        }
        if (all) {
          const res = mute.setGlobal({ minutes, reason: args.reason });
          return { ok: true, ...res, scope: 'global' };
        }
        if (!/^\d{5,15}$/.test(raw)) return { ok: false, error: 'QQ 号不合法（5-15 位数字）' };
        const res = mute.setPeer(raw, { minutes, reason: args.reason });
        return { ok: true, ...res };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
  }));

  return toolList;
}

/** 工具名列表（状态端点 / 自检用）。 */
export function qqToolNames() {
  return ['qq_send', 'qq_recall', 'qq_action', 'qq_actions', 'qq_events', 'qq_status', 'qq_notice', 'qq_invite', 'qq_mute'];
}
