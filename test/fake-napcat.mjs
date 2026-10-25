// 假 NapCat：一个会按脚本发帧的 OneBot 11 反向 WS 客户端。不碰真 QQ。
import { connectWs } from '../lib/gateway/ws.js';
import { setTimeout as delay } from 'node:timers/promises';

export class FakeNapCat {
  constructor(peer, { botQQ, mainQQ }) {
    this.peer = peer;
    this.botQQ = Number(botQQ);
    this.mainQQ = Number(mainQQ);
    this.frames = [];
    this.actions = [];
    this.closed = false;
    // M6：自动应答（工具/发图测试要等 action 响应，手动 respond 太啰嗦）
    this.autoTimer = null;
    this.autoResponded = new Set();
    this.messageIdSeq = 4000;
    peer.on('text', (text) => {
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { __unparsed: text };
      }
      this.frames.push(parsed);
      if (parsed && typeof parsed === 'object' && typeof parsed.action === 'string') this.actions.push(parsed);
    });
    peer.on('close', () => {
      this.closed = true;
    });
  }

  sendRaw(text) {
    this.peer.send(text);
    return this;
  }

  sendFrame(obj) {
    this.peer.send(JSON.stringify(obj));
    return this;
  }

  /** 任意人发给小号的私聊帧（M5 起可指定发送者/昵称） */
  sendPrivate({ text, messageId, userId = this.mainQQ, selfId = this.botQQ, nickname = 'ShawwiMA' } = {}) {
    return this.sendFrame({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: messageId,
      user_id: userId,
      self_id: selfId,
      time: Math.floor(Date.now() / 1000),
      raw_message: text,
      font: 0,
      sender: { user_id: userId, nickname, sex: 'unknown', age: 0 },
      message: [{ type: 'text', data: { text } }],
      post_format: 'array',
    });
  }

  /**
   * 群消息；mention=true 时带 @小号 段（M5：只接 @ 的）。
   * 群名片走 sender.card，昵称走 sender.nickname。
   */
  sendGroup({ text, messageId = 9001, groupId = 123456, userId = this.mainQQ, selfId = this.botQQ, nickname = '群友', card = '', mention = false } = {}) {
    const message = mention ? [{ type: 'at', data: { qq: String(this.botQQ) } }] : [];
    if (text) message.push({ type: 'text', data: { text } });
    return this.sendFrame({
      post_type: 'message',
      message_type: 'group',
      group_id: groupId,
      message_id: messageId,
      user_id: userId,
      self_id: selfId,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: userId, nickname, card },
      message,
      post_format: 'array',
    });
  }

  /** 任意消息段（M2 用它造图片/语音/图文混合/空白文本） */
  sendSegments({ segments, messageId = 9002 } = {}) {
    return this.sendFrame({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: messageId,
      user_id: this.mainQQ,
      self_id: this.botQQ,
      time: Math.floor(Date.now() / 1000),
      message: segments,
      post_format: 'array',
    });
  }

  /** 图片，没有文本段：M4.1 起会真正投给宿主（下载字节 → image 内容块） */
  sendImageOnly({ messageId = 9002, file = 'fake.png', url = '' } = {}) {
    return this.sendSegments({
      segments: [{ type: 'image', data: { file, url } }],
      messageId,
    });
  }

  /** 语音（真不支持的媒体），只有非文本段 */
  sendVoiceOnly({ messageId = 9003 } = {}) {
    return this.sendSegments({ segments: [{ type: 'record', data: { file: 'fake.amr' } }], messageId });
  }

  /** 空白文本段：没有媒体段、也没有正文 → 不回执（避免噪音） */
  sendBlankText({ messageId = 9004 } = {}) {
    return this.sendSegments({ segments: [{ type: 'text', data: { text: '   ' } }], messageId });
  }

  /** 文本 + 图片混合：正文正常投递，图片作为 image 内容块一起投给宿主 */
  sendMixed({ text = '看图', messageId = 9005, file = 'fake.png', url = '' } = {}) {
    return this.sendSegments({
      segments: [{ type: 'text', data: { text } }, { type: 'image', data: { file, url } }],
      messageId,
    });
  }

  /** 对某个 action 回一条响应帧（get_image 这类需要等响应的动作用） */
  respondToAction({ echo, data = {}, status = 'ok', retcode = 0 } = {}) {
    return this.sendFrame({ status, retcode, data, echo });
  }

  /** action 响应帧（带 echo）：永远不该入队 */
  sendEchoResponse({ echo = 'qqgw-1' } = {}) {
    return this.sendFrame({ status: 'ok', retcode: 0, data: { message_id: 4242 }, echo });
  }

  sendNotice() {
    return this.sendFrame({ post_type: 'notice', notice_type: 'friend_recall', user_id: this.mainQQ, self_id: this.botQQ });
  }

  /** ===== M6：事件帧（notice / request / meta_event / message_sent）===== */
  sendNotice({
    noticeType = 'group_recall',
    subType = undefined,
    groupId = undefined,
    userId = this.mainQQ,
    operatorId = undefined,
    targetId = undefined,
    messageId = undefined,
    duration = undefined,
    file = undefined,
    cardNew = undefined,
    cardOld = undefined,
  } = {}) {
    const frame = {
      post_type: 'notice',
      notice_type: noticeType,
      user_id: userId,
      self_id: this.botQQ,
      time: Math.floor(Date.now() / 1000),
    };
    if (subType !== undefined) frame.sub_type = subType;
    if (groupId !== undefined) frame.group_id = groupId;
    if (operatorId !== undefined) frame.operator_id = operatorId;
    if (targetId !== undefined) frame.target_id = targetId;
    if (messageId !== undefined) frame.message_id = messageId;
    if (duration !== undefined) frame.duration = duration;
    if (file !== undefined) frame.file = file;
    if (cardNew !== undefined) frame.card_new = cardNew;
    if (cardOld !== undefined) frame.card_old = cardOld;
    return this.sendFrame(frame);
  }

  sendRequest({ requestType = 'friend', userId = this.mainQQ, groupId = undefined, comment = '', flag = 'flag-1', subType = undefined } = {}) {
    const frame = {
      post_type: 'request',
      request_type: requestType,
      user_id: userId,
      comment,
      flag,
      self_id: this.botQQ,
      time: Math.floor(Date.now() / 1000),
    };
    if (groupId !== undefined) frame.group_id = groupId;
    if (subType !== undefined) frame.sub_type = subType;
    return this.sendFrame(frame);
  }

  sendHeartbeat({ status = { online: true, good: true }, interval = 30000 } = {}) {
    return this.sendFrame({
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      status,
      interval,
      self_id: this.botQQ,
      time: Math.floor(Date.now() / 1000),
    });
  }

  sendLifecycle({ subType = 'enable' } = {}) {
    return this.sendFrame({
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: subType,
      self_id: this.botQQ,
      time: Math.floor(Date.now() / 1000),
    });
  }

  sendMessageSent({ messageType = 'private', userId = this.mainQQ, groupId = undefined, messageId = 5001, text = '自己发的' } = {}) {
    const frame = {
      post_type: 'message_sent',
      message_type: messageType,
      sub_type: messageType === 'private' ? 'friend' : 'normal',
      message_id: messageId,
      user_id: this.botQQ,
      self_id: this.botQQ,
      time: Math.floor(Date.now() / 1000),
      message: [{ type: 'text', data: { text } }],
    };
    if (messageType === 'group') {
      frame.group_id = groupId;
      frame.target_id = groupId;
    }
    return this.sendFrame(frame);
  }

  /**
   * 自动应答：每 5ms 扫一遍收到的 action，没回过的就回一条成功响应。
   * 默认 data 对 send_* 给自增 message_id，其他给 {}；可传 responder 自定义。
   */
  startAutoRespond(responder = null) {
    if (this.autoTimer) return this;
    this.autoTimer = setInterval(() => {
      for (const action of this.actions) {
        if (!action || typeof action.echo !== 'string' || this.autoResponded.has(action.echo)) continue;
        const custom = typeof responder === 'function' ? responder(action) : undefined;
        if (custom === false) continue;
        let data;
        if (custom !== undefined) {
          data = custom;
        } else if (/^send_/.test(action.action)) {
          this.messageIdSeq += 1;
          data = { message_id: this.messageIdSeq };
        } else {
          data = {};
        }
        this.autoResponded.add(action.echo);
        this.respondToAction({ echo: action.echo, data });
      }
    }, 5);
    this.autoTimer.unref?.();
    return this;
  }

  stopAutoRespond() {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = null;
    return this;
  }

  replies() {
    return this.actions.filter((a) => a.action === 'send_private_msg');
  }

  /** 群回复动作（M5：群聊回原群，不是私聊） */
  groupReplies() {
    return this.actions.filter((a) => a.action === 'send_group_msg');
  }

  waitForAction(predicate, { timeoutMs = 5000, label = 'action' } = {}) {
    return new Promise((resolve, reject) => {
      const existing = this.actions.find(predicate);
      if (existing) {
        resolve(existing);
        return;
      }
      const timer = setInterval(() => {
        const hit = this.actions.find(predicate);
        if (hit) {
          clearInterval(timer);
          clearTimeout(bail);
          resolve(hit);
        }
      }, 5);
      const bail = setTimeout(() => {
        clearInterval(timer);
        reject(new Error(`FakeNapCat: timed out waiting for ${label}`));
      }, timeoutMs);
    });
  }

  async close() {
    this.stopAutoRespond();
    this.peer.close(1000);
    await delay(20);
  }
}

export async function connectFakeNapCat({ url, token, botQQ, mainQQ }) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const peer = await connectWs(url, { headers });
  return new FakeNapCat(peer, { botQQ, mainQQ });
}

/** 期望被拒：返回 handshake 错误信息（含 HTTP 状态码） */
export async function expectReject({ url, token }) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  try {
    const peer = await connectWs(url, { headers });
    peer.close(1000);
    return { rejected: false, reason: 'connected anyway' };
  } catch (err) {
    return { rejected: true, reason: err.message };
  }
}
