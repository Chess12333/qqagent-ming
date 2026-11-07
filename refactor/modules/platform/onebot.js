// OneBot v11 客户端：WebSocket 只收事件，HTTP API 负责发送与查询。
// （原版经 @snowluma/sdk 收事件；这里直接实现标准 OneBot v11，去掉 SDK 补丁依赖。）
import http from 'node:http';
import https from 'node:https';
import WebSocket from 'ws';
import { sanitizeUserText, escapeCqText } from '../../core/util/index.js';
// ★ 2026-10-27：卡片渲染从「只抠 B 站链接」换成 cards.js（标题/描述/来源/预览图都拿出来）。
import { cardText, cardFacts, xmlText, xmlFacts } from './cards.js';

/** 本机 OneBot 直连 POST：不走系统代理（fetch 会被 Clash/代理劫持 127.0.0.1 → fetch failed）。 */
function onebotPost(urlStr, bodyBuf, headers, timeoutMs, { signal = null, totalTimeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('OneBot 请求已取消'), { name: 'AbortError' }));
      return;
    }
    let u;
    try { u = new URL(urlStr); } catch { reject(new Error('OneBot 地址不合法')); return; }
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    let settled = false;
    let deadlineTimer = null;
    const cleanup = () => {
      if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(response);
    };
    const onAbort = () => {
      const reason = signal?.reason;
      req.destroy(reason instanceof Error ? reason : Object.assign(new Error('OneBot 请求已取消'), { name: 'AbortError' }));
    };
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: `${u.pathname}${u.search}`.replace(/\/+$/, '') || '/',
      method: 'POST',
      headers: {
        ...headers,
        'content-length': String(bodyBuf.length),
        // 明确不走代理
        host: u.host
      },
      // Node http 不会读 HTTP_PROXY 除非显式 agent；默认 agent 已绕过 env proxy
      timeout: timeoutMs,
      agent: false
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => finish(null, { statusCode: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (error) => finish(error));
    });
    req.on('timeout', () => { req.destroy(new Error('OneBot 请求超时')); });
    req.on('error', (err) => finish(err?.name === 'AbortError'
      ? err : new Error(`OneBot 网络错误: ${err?.message ?? err}`)));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    const totalMs = Number(totalTimeoutMs);
    if (Number.isFinite(totalMs) && totalMs > 0) {
      deadlineTimer = setTimeout(() => req.destroy(new Error('OneBot 请求总时限已到')), totalMs);
      deadlineTimer.unref?.();
    }
    req.write(bodyBuf);
    req.end();
  });
}

/**
 * 带一次重试的 POST。
 *
 * ⚠️ 2026-09-22：加了这层是因为用户实测「发表情包」时出现
 *   `错误: OneBot 网络错误：read ECONNRESET`，而且连着三张都是同一个错。
 *   这种"读响应时被对端 RST"多数是**一次性的**（协议端当时忙/正在重启/请求体让它难受），
 *   重试一次通常就过了；原来一次失败就直接把错误抛给模型，模型再对群友说"网断了"。
 *   只重试连接类错误（ECONNRESET / EPIPE / socket hang up / 连接被拒），
 *   业务错误（HTTP 4xx/5xx、retcode 非 0）**不重试**，避免重复发送。
 *
 * ★ 2026-10-17（安全审查）：**超时类错误从重试集合里删掉了**。
 *   超时是本层唯一一个"对端很可能已经收下并处理完、只是回执没在时限内回来"的情形，
 *   照原样重发就是同一份字节 POST 第二次 ⇒ 群里有概率收到两条一样的消息。
 *   这一层在 `act` 的投递口径（deliveryState=unknown ⇒「不要重发」）和
 *   `platform/send-recovery.js` 的契约（"A timeout/rejection may arrive after the
 *   remote side accepted the text. Never retry…"）之下，等于绕过了那两道保险。
 *   保留 ECONNRESET/EPIPE/socket hang up：这三类是"读响应时对端把连接掐了"，
 *   且实测场景（大 base64 图片把协议端顶爆、它读不完请求体就 RST）本来就多半没投递出去。
 *   ECONNREFUSED 则是连接都没建起来，对端不可能见过这个请求，重发最安全。
 *   —— 残余风险：读响应阶段的 RST 仍然无法区分"已投递"与"没投递"。要彻底消除需要
 *   协议端侧的幂等键，属于 OneBot 侧能力，不在本模块能单方面改的范围内。
 */
async function onebotPostWithRetry(urlStr, bodyBuf, headers, timeoutMs, options = {}) {
  const budget = Number(options?.totalTimeoutMs);
  const deadline = Number.isFinite(budget) && budget > 0 ? Date.now() + budget : null;
  try {
    return await onebotPost(urlStr, bodyBuf, headers, timeoutMs, options);
  } catch (error) {
    const msg = String(error?.message ?? error);
    const transient = /ECONNRESET|EPIPE|socket hang up|ECONNREFUSED/i.test(msg);
    if (!transient) throw error;
    let remaining = deadline === null ? Infinity : deadline - Date.now();
    if (options?.signal?.aborted || remaining <= 0) throw error;
    const waitMs = Math.min(300, remaining);
    await new Promise((resolve, reject) => {
      let retryTimer = null;
      const cleanup = () => {
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        options?.signal?.removeEventListener?.('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        const reason = options?.signal?.reason;
        reject(reason instanceof Error ? reason : Object.assign(new Error('OneBot 请求已取消'), { name: 'AbortError' }));
      };
      retryTimer = setTimeout(() => { cleanup(); resolve(); }, waitMs);
      retryTimer.unref?.();
      options?.signal?.addEventListener?.('abort', onAbort, { once: true });
      if (options?.signal?.aborted) onAbort();
    });
    remaining = deadline === null ? Infinity : deadline - Date.now();
    if (options?.signal?.aborted || remaining <= 0) throw error;
    const retryOptions = deadline === null ? options : { ...options, totalTimeoutMs: remaining };
    try {
      return await onebotPost(urlStr, bodyBuf, headers,
        deadline === null ? timeoutMs : Math.min(timeoutMs, remaining), retryOptions);
    } catch (second) {
      const sizeMb = (bodyBuf.length / 1048576).toFixed(2);
      const hint = /ECONNRESET/i.test(String(second?.message ?? second))
        ? `（重试后仍被重置；本次请求体 ${sizeMb} MB —— 图片越大越容易被协议端断开，详见下方说明）`
        : '';
      throw new Error(`${second?.message ?? second}${hint}`);
    }
  }
}

const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 30000;

/**
 * 错误串脱敏（2026-10-17 安全审查）。
 *
 * WS 地址按 OneBot v11 规范把 `access_token` 放在 **query** 里（下一行的 `Authorization`
 * 头也给，但有些协议端只认 query，所以 query 参数**必须保留**，不能为了脱敏把它删掉）。
 * 代价是这个 URL 一旦被写进日志/错误串，token 就跟着出去了 —— URL 出现在代理日志、
 * 服务端访问日志、还有 `new WebSocket(badUrl)` 抛的 `Invalid URL: …` 里。
 *
 * 所以：**认证方式一个字不动，只保证这个 URL 不落进任何可见文本**。
 * 覆盖 query 上的 token / key / password 参数、URL 里的 userinfo、以及 Bearer 头。
 */
function redactUrlSecrets(value) {
  let s = String(value ?? '');
  try {
    s = s.replace(/([?&](?:access_token|token|api[-_]?key|secret|password)=)[^&\s'"]+/gi, '$1***');
    s = s.replace(/(\/\/)[^/@\s]+:[^/@\s]+@/g, '$1***@');
    s = s.replace(/(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***');
  } catch { /* 脱敏失败原样返回：宁可少盖，也不能让错误处理本身抛 */ }
  return s;
}

export class OneBotClient {
  constructor({ wsUrl, httpUrl, accessToken, httpToken, onEvent }) {
    this.wsUrl = String(wsUrl || 'ws://127.0.0.1:3001');
    this.httpUrl = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.accessToken = String(accessToken || '');
    // SnowLuma 允许给 WS 与 HTTP 配不同令牌；httpToken 缺省沿用 accessToken
    this.httpToken = String(httpToken || accessToken || '');
    this.onEvent = onEvent || (() => {});
    this.socket = null;
    this.connected = false;
    this.everConnected = false;
    this.lastConnectError = '';
    this.selfInfo = null;      // { user_id, nickname }
    this.#closedByUs = false;
    this.statusListeners = new Set();
  }

  #closedByUs;
  #retryTimer = null;

  onStatus(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  #setStatus(connected) {
    this.connected = connected;
    if (connected) this.everConnected = true;
    for (const fn of this.statusListeners) {
      try { fn({ connected, everConnected: this.everConnected, error: this.lastConnectError }); } catch { /* ignore */ }
    }
  }

  async connect() {
    this.#closedByUs = false;
    this.#connectLoop();
  }

  /** 连接配置可能变了（比如从 SnowLuma 配置同步到了新令牌），重连一次。 */
  async reconnect() {
    // 关键：先作废旧 socket，再启新连接。否则旧 socket 的 close 事件稍后到达时
    // 会误以为需要再次重连，造成两个 WebSocket 同时连着 SnowLuma，所有事件收到两份。
    const old = this.socket;
    this.socket = null;
    this.#closedByUs = false;
    // ★ 2026-10-18：**还要清掉待触发的重连排程**。否则"断线等 3s"期间被显式 reconnect()
    //   时，旧排程稍后照样触发 ⇒ 两个 WebSocket 同时连着（与上一段同一类事故的另一半）。
    if (this.#retryTimer) { clearTimeout(this.#retryTimer); this.#retryTimer = null; }
    try { old?.close(); } catch { /* ignore */ }
    this.#connectLoop();
  }

  /**
   * 应用新的连接配置（★ 2026-10-18：SnowLuma 令牌认领链的"更新并重连"落点）。
   * 本类每次 #connectLoop 都**重新读实例字段**（令牌不在构造期 const 死存），所以更新字段
   * 就能让下一次(重)连用上新值；只有 WS 侧（地址/令牌）变了且**当前已连接**时才主动重连一次
   * （HTTP 令牌变化不影响 WS 连接，不重连、也不丢事件）。
   * @returns {{changed:boolean, reconnected:boolean, wsChanged:boolean, httpChanged:boolean}}
   */
  applyConnectionConfig({ wsUrl, httpUrl, accessToken, httpToken } = {}) {
    const nextWsUrl = wsUrl !== undefined ? String(wsUrl || this.wsUrl) : this.wsUrl;
    const nextHttpUrl = httpUrl !== undefined ? String(httpUrl || this.httpUrl).replace(/\/+$/, '') : this.httpUrl;
    const nextAccessToken = accessToken !== undefined ? String(accessToken ?? '') : this.accessToken;
    const nextHttpToken = httpToken !== undefined ? String(httpToken ?? '') : this.httpToken;
    const wsChanged = nextWsUrl !== this.wsUrl || nextAccessToken !== this.accessToken;
    const httpChanged = nextHttpUrl !== this.httpUrl || nextHttpToken !== this.httpToken;
    if (!wsChanged && !httpChanged) return { changed: false, reconnected: false, wsChanged: false, httpChanged: false };
    this.wsUrl = nextWsUrl;
    this.httpUrl = nextHttpUrl;
    this.accessToken = nextAccessToken;
    this.httpToken = nextHttpToken;
    let reconnected = false;
    if (wsChanged && this.connected) {
      try { this.reconnect(); reconnected = true; } catch { /* 重连失败由连接循环自愈 */ }
    }
    return { changed: true, reconnected, wsChanged, httpChanged };
  }

  #connectLoop() {
    if (this.#closedByUs) return;
    // 走到这里就是唯一一次"当前生效"的连接循环：把可能残留的排程清掉（同 reconnect 的防双连）。
    if (this.#retryTimer) { clearTimeout(this.#retryTimer); this.#retryTimer = null; }
    let url = this.wsUrl;
    if (this.accessToken) url += (url.includes('?') ? '&' : '?') + `access_token=${encodeURIComponent(this.accessToken)}`;
    let socket;
    try {
      socket = new WebSocket(url, {
        headers: this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}
      });
    } catch (error) {
      this.lastConnectError = redactUrlSecrets(error?.message ?? error);
      this.#setStatus(false);
      if (!this.#retryTimer) {
        this.#retryTimer = setTimeout(() => { this.#retryTimer = null; this.#connectLoop(); }, RECONNECT_MIN_MS);
      }
      return;
    }
    this.socket = socket;
    // 每个 socket 的事件处理器都先验证“我还是不是当前 socket”，
    // 旧连接被作废后其迟到事件直接忽略，避免重复重连/状态错乱。
    const isCurrent = (s) => this.socket === s;

    socket.on('open', async () => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = '';
      this.#setStatus(true);
      try {
        this.selfInfo = await this.call('get_login_info');
      } catch (error) {
        console.error('[onebot] 获取登录信息失败:', error?.message ?? error);
      }
    });
    socket.on('message', (data) => {
      if (!isCurrent(socket)) return;
      let event = null;
      try { event = JSON.parse(String(data)); } catch { return; }
      if (!event || typeof event !== 'object') return;
      try { this.onEvent(event); } catch (error) { console.error('[onebot] 事件处理出错:', error); }
    });
    socket.on('close', () => {
      if (!isCurrent(socket)) return; // 旧连接的迟到 close：新连接已在处理
      this.#setStatus(false);
      // ★ 2026-10-18：重连排程只保留**一个**（有排程就不再叠加，reconnect()/#connectLoop 会清）。
      if (!this.#closedByUs && !this.#retryTimer) {
        this.#retryTimer = setTimeout(() => { this.#retryTimer = null; this.#connectLoop(); }, RECONNECT_MIN_MS);
      }
    });
    socket.on('error', (error) => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = redactUrlSecrets(error?.message ?? error);
      if (!this.everConnected) {
        // 首连失败退避得久一点，避免刷屏
        this.#setStatus(false);
      }
    });
  }

  close() {
    this.#closedByUs = true;
    if (this.#retryTimer) { clearTimeout(this.#retryTimer); this.#retryTimer = null; }
    const old = this.socket;
    this.socket = null;
    try { old?.close(); } catch { /* ignore */ }
    this.#setStatus(false);
  }

  /** OneBot HTTP API（发送与查询都走这里）。直连，不经系统代理。 */
  async call(action, params = {}, timeoutMs = 15000, options = {}) {
    const url = `${this.httpUrl}/${action}`;
    const payload = Buffer.from(JSON.stringify(params), 'utf8');
    const headers = {
      'content-type': 'application/json',
      ...(this.httpToken ? { authorization: `Bearer ${this.httpToken}` } : {})
    };
    // 大图 base64 可能很大：给图片类调用更长超时
    const t = /image|send_.*msg/.test(action) ? Math.max(timeoutMs, 30000) : timeoutMs;
    // 连接类错误自动重试一次（见 onebotPostWithRetry 的说明）
    const res = await onebotPostWithRetry(url, payload, headers, t, options);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const hint = res.statusCode === 426
        ? '（HTTP 426：httpUrl 可能指向了 WebSocket 端口，请检查 snowluma.httpUrl 是否为 OneBot HTTP API 地址）'
        : '';
      throw new Error(`OneBot ${action} HTTP ${res.statusCode}${hint}`);
    }
    let body = {};
    try { body = JSON.parse(res.body || '{}'); } catch { body = {}; }
    if (body.status !== 'ok' && body.retcode !== 0) {
      throw new Error(`OneBot ${action} 失败: retcode=${body.retcode ?? body.status} ${body.wording ?? ''}`);
    }
    return body.data;
  }

  get selfId() {
    return this.selfInfo?.user_id != null ? String(this.selfInfo.user_id) : '';
  }

  get selfNickname() {
    return this.selfInfo?.nickname ? String(this.selfInfo.nickname) : '';
  }

  /** 发送消息段。返回 OneBot 响应 data（含 message_id）。 */
  async sendSegments(kind, id, segments) {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments };
    return this.call(action, params);
  }

  /**
   * 发送合并转发（把多条消息打成一条转发记录）。
   * @param {'group'|'private'} kind
   * @param {string|number} id 群号 / QQ 号
   * @param {Array<{name?:string,uin?:string|number,content:string}>} nodes
   * @param {{ replyToMessageId?: any }} opts
   */
  async sendForward(kind, id, nodes, { replyToMessageId = null } = {}) {
    const list = (Array.isArray(nodes) ? nodes : []).filter((n) => n && String(n.content ?? '').trim());
    if (!list.length) throw new Error('合并转发内容为空');
    if (list.length > 40) throw new Error('合并转发最多 40 条节点');
    const messages = list.map((n) => ({
      type: 'node',
      data: {
        name: String(n.name || n.senderName || '消息记录').slice(0, 20),
        uin: String(n.uin || n.senderId || this.selfId || '0'),
        content: String(n.content ?? '')
      }
    }));
    // 部分实现支持在 forward 消息前挂 reply；不支持时忽略
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      // 标准 send_*_forward_msg 通常不带 reply；留接口以后扩展
    }
    const action = kind === 'private' ? 'send_private_forward_msg' : 'send_group_forward_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), messages }
      : { group_id: Number(id), messages };
    return this.call(action, params, 20000);
  }

  async sendText(kind, id, text, { replyToMessageId = null, atUserId = null } = {}) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      // 私聊没有"@"这回事。模型还常把"消息 id"当 QQ 号塞进来（实测是把某条会话里的
      // #短编号原样填了进来），拼成 at 段只会让这条消息被 QQ 拒发 —— 私聊里直接忽略。
      if (kind === 'group') segments.push({ type: 'at', data: { qq: at } });
    }
    segments.push({ type: 'text', data: { text: escapeCqText(String(text ?? '')) } });
    return this.sendSegments(kind, id, segments);
  }

  /**
   * 发一条图片消息（表情包和普通网图都走这里）。
   * file 可以是 `base64://…`（推荐：字节由本进程下载并校验过）或 URL/本地路径。
   */
  async sendImage(kind, id, file, { replyToMessageId = null, atUserId = null } = {}) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      // 同 sendText：私聊不拼 at 段（模型常把消息 id 当成 QQ 号传进来，会导致整条发送失败）
      if (kind === 'group') segments.push({ type: 'at', data: { qq: at } });
    }
    segments.push({ type: 'image', data: { file: String(file) } });
    return this.sendSegments(kind, id, segments);
  }

  /** 兼容旧调用名：表情包也是图片消息。 */
  async sendSticker(kind, id, file, options = {}) {
    return this.sendImage(kind, id, file, options);
  }

  /**
   * 发网易云音乐。
   * 用 OneBot 标准 music 段：SnowLuma 负责调用签名服务转成可展示的 json 卡。
   * ⚠️ 不要事后改签名结果里的 ver/token —— 改了签名就废，QQ 会空白。
   * ⚠️ **不要和 reply（引用）同发**：引用 + 音乐/json 卡在部分 QQ/协议端会被整条吞掉。
   * 引用意图改用「文字说明」；本方法忽略 replyToMessageId。
   * 同时附带「歌名+链接」文字：卡片被吞时群里仍看得到。
   */
  async sendMusic(kind, id, music = {}) {
    const segments = [];
    // 刻意不拼 reply 段：引用会吞掉音乐卡
    if (kind === 'group' && music.atUserId != null && String(music.atUserId).trim()) {
      const at = String(music.atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号');
      segments.push({ type: 'at', data: { qq: at } });
    }

    const platform = String(music.platform || '163').toLowerCase();
    const songId = String(music.songId || music.id || '').trim().replace(/[^0-9]/g, '');
    const title = String(music.title || '').trim().slice(0, 80) || '音乐分享';
    const artist = String(music.artist || music.content || '').trim().slice(0, 40);
    let jumpUrl = String(music.url || '').trim();
    let audio = String(music.audio || '').trim();

    if (platform === '163' || (!music.url && songId)) {
      if (!songId && !jumpUrl) throw new Error('需要网易云 songId 或 url');
      if (!jumpUrl) jumpUrl = `https://music.163.com/#/song?id=${songId}`;
      if (!audio) audio = `https://music.163.com/song/media/outer/url?id=${songId || '0'}.mp3`;
    }

    // 文字链接：一定可见
    const textLine = artist ? `${title} - ${artist}` : title;
    segments.push({ type: 'text', data: { text: `🎵 ${textLine}\n${jumpUrl}` } });

    // 标准 music 段交给 SnowLuma 签名（不要再自拼/改签名 JSON）
    if (songId || (music.url && music.audio)) {
      const musicData = songId && platform !== 'custom'
        ? {
          type: platform === 'qq' ? 'qq' : '163',
          id: songId,
          // 以下字段 SnowLuma 签名路径主要用 id；title 留给失败回退
          title,
          content: artist
        }
        : {
          type: 'custom',
          url: jumpUrl,
          audio,
          title,
          content: artist,
          image: String(music.image || '')
        };
      segments.push({ type: 'music', data: musicData });
    }

    return this.sendSegments(kind, id, segments);
  }

  /**
   * 发 B 站视频分享卡片（json 段）。
   * 优先视频卡（com.tencent.video）；网页卡容易在部分 QQ 上显示「升级后使用」。
   */
  async sendBiliCard(kind, id, { url, title = '', desc = '', cover = '', replyToMessageId = null, style = 'video' } = {}) {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) throw new Error('B站卡片需要视频链接');
    const coverHttps = String(cover || '').trim().replace(/^http:/i, 'https:');
    const t = String(title || 'B站视频').slice(0, 80);
    const d = String(desc || '').slice(0, 80);
    const prompt = `[分享]${t}`;

    // 视频卡：duration 给个非 0 值；部分端 duration=0 会显示「消息已过期」
    const videoJson = {
      app: 'com.tencent.video',
      desc: '视频',
      view: 'video',
      ver: '1.0.0.1',
      prompt,
      meta: {
        video: {
          duration: 60,
          preview: coverHttps,
          title: t,
          url: u,
          jumpUrl: u,
          desc: d || 'bilibili.com',
          source: '哔哩哔哩',
          source_icon: 'https://www.bilibili.com/favicon.ico'
        }
      }
    };

    // 网页卡（备用）
    const pageJson = {
      app: 'com.tencent.webpage',
      desc: '网页',
      jumpUrl: u,
      meta: {
        title: t,
        desc: d || 'bilibili',
        preview: coverHttps,
        source_icon: 'https://www.bilibili.com/favicon.ico',
        sourceName: '哔哩哔哩'
      },
      prompt,
      ver: '0.0.0.1',
      view: 'modelv2'
    };

    const payload = style === 'page' ? pageJson : videoJson;

    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (/^-?[1-9]\d*$/.test(rid)) segments.push({ type: 'reply', data: { id: rid } });
    }
    segments.push({ type: 'json', data: { data: JSON.stringify(payload) } });
    return this.sendSegments(kind, id, segments);
  }

  async sendPoke(kind, id, targetUserId) {
    if (kind === 'private') {
      return this.call('friend_poke', { user_id: Number(id) }).catch(() =>
        this.call('send_poke', { user_id: Number(id) }));
    }
    return this.call('group_poke', { group_id: Number(id), user_id: Number(targetUserId || id) }).catch(() =>
      this.call('send_poke', { group_id: Number(id), user_id: Number(targetUserId || id) }));
  }

  async getMsg(messageId) {
    return this.call('get_msg', { message_id: Number(messageId) });
  }

  async getGroupList() {
    const r = await this.call('get_group_list');
    const list = Array.isArray(r) ? r : (Array.isArray(r?.data) ? r.data : []);
    return list.map((g) => ({
      id: String(g.group_id ?? g.id ?? ''),
      name: String(g.group_name ?? g.name ?? g.group_id ?? '')
    })).filter((g) => g.id);
  }

  async getGroupInfo(groupId) {
    return this.call('get_group_info', { group_id: Number(groupId) });
  }

  async getGroupMemberInfo(groupId, userId) {
    return this.call('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId) });
  }
}

// ── 入站事件 → 文本（移植自原版 segmentsToText） ─────────────────────────

export function forwardIdFromData(d) {
  const raw = d?.id ?? d?.res_id ?? d?.forward_id ?? d?.data_id;
  if (raw == null || String(raw).trim() === '') return null;
  return String(raw);
}

/**
 * 从 OneBot json 卡段里抠可打开的链接（优先 B 站）。
 * data 可能是字符串 JSON，也可能是对象。
 */
export function extractShareCardJson(segData) {
  let obj = null;
  const raw = segData?.data ?? segData?.json ?? segData ?? '';
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    // 有时是 HTML 转义或嵌套字符串
    try { obj = JSON.parse(String(raw).replace(/&quot;/g, '"').replace(/&amp;/g, '&')); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;

  const pickUrl = () => {
    const cands = [
      obj?.jumpUrl,
      obj?.meta?.detail_1?.url,
      obj?.meta?.detail_1?.qqdocurl,
      obj?.meta?.detail_1?.preview,
      obj?.meta?.web?.url,
      obj?.meta?.web?.jumpUrl,
      obj?.meta?.detail_2?.url,
      obj?.url,
      obj?.prompt
    ];
    for (const c of cands) {
      const u = String(c || '').trim();
      if (/^https?:\/\/(www\.)?bilibili\.com\//i.test(u) || /^https?:\/\/b23\.tv\//i.test(u)) return u.replace(/[),。，]+$/, '');
      if (/^https?:\/\/(www\.)?bilibili\.com\/video\//i.test(u) || /BV[0-9A-Za-z]{10}/.test(u)) return u;
    }
    // 再扫整份 JSON
    const m = String(JSON.stringify(obj)).match(/https?:\/\/(?:www\.)?bilibili\.com\/video\/[A-Za-z0-9]+/);
    if (m) return m[0];
    const bv = String(JSON.stringify(obj)).match(/BV[0-9A-Za-z]{10}/);
    if (bv) return `https://www.bilibili.com/video/${bv[0]}`;
    // 非 B 站但有网页链接
    for (const c of [obj?.jumpUrl, obj?.meta?.web?.url, obj?.meta?.detail_1?.url]) {
      const u = String(c || '').trim();
      if (/^https?:\/\//i.test(u)) return u;
    }
    return null;
  };

  const url = pickUrl();
  if (!url) return null;
  const title = String(
    obj?.meta?.detail_1?.title
    || obj?.meta?.web?.title
    || obj?.meta?.title
    || obj?.prompt
    || ''
  ).replace(/^\[分享\]\s*/, '').slice(0, 80);
  const kind = /bilibili\.com|b23\.tv|BV[0-9A-Za-z]{10}/i.test(url + title) ? 'bili' : 'web';
  return { url, title, kind };
}

/**
 * 语音段 → 文字。走 speech-to-text 插件的能力 `media.transcribe`。
 *
 * 为什么做成"软依赖"：转写需要 whisper-cli + 模型文件，多数人没装。
 * 没装（能力不存在）/ 没配 / 转写失败 / 超时，都退回 `[语音]` 占位 —— 行为与从前一致。
 * 超时上限 25 秒（转写本身是本地小模型，太长会把收消息链路堵住）。
 */
async function transcribeRecordSegment(data, onebotClient) {
  try {
    const { skillManager } = await import('../extensions/index.js');
    const provider = skillManager.getCapabilityProviders('media.transcribe', {})[0];
    if (!provider?.fn || !onebotClient?.call) return '[语音]';
    const record = { ...(data || {}) };
    const out = await Promise.race([
      Promise.resolve(provider.fn({ record, onebot: onebotClient })),
      new Promise((r) => { const t = setTimeout(() => r(null), 25000); t.unref?.(); })
    ]);
    const text = String(out?.text || '').trim();
    if (out?.ok !== false && text) return `[语音]${text}`;
  } catch { /* 转写失败不影响收消息 */ }
  return '[语音]';
}

/**
 * 把 OneBot 消息段数组转成 AI 可读的纯文本。
 * resolveReply: async (mid) => { sender, text } | null —— 解析引用原文。
 * resolveAtName: async (qq) => string | null —— 把 @ 的 QQ 号解析成群名片。
 */
export async function segmentsToText(segments, { resolveReply = null, resolveAtName = null, includeReply = true, onebot = null } = {}) {
  if (typeof segments === 'string') return sanitizeUserText(segments.trim());
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          const qq = String(d.qq ?? '').replace(/[^\d]/g, '');
          // 展示用名片 + 一律保留 CQ 号：触发/艾特判定靠 QQ，不靠会改的群名片
          out.push(name ? `@${name}` : (qq ? `@${qq}` : '@'));
          if (qq) out.push(`[CQ:at,qq=${qq}]`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      case 'image': out.push('[图片]'); break;
      // 语音：装了 speech-to-text 插件（提供 media.transcribe 能力）就把内容转成文字，
      // 模型才能真正"听懂"语音而不是只看到一个 [语音] 占位符。
      // 没装 / 没配 whisper / 识别失败 / 超时 → 原样退回 [语音]，绝不打断收消息。
      case 'record': out.push(await transcribeRecordSegment(d, onebot)); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            // 短编号放最前（`[引用 #318 A：原话]`）：模型要靠它引用**被引用的那条原话**，
            // 而不是带着这个引用块的那条消息（那正是"引用错"的一种来源）。
            const head = info?.ref ? `${info.ref} ` : '';
            const body = [info?.sender, info?.text].filter(Boolean).join('：');
            if (head || body) replyText = `[引用 ${head}${body}]`;
          } catch { /* 解析失败降级 */ }
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': {
        // 2026-10-27：卡片上的字（标题/描述/来源/链接）全给模型，不再只剩 `[卡片消息]`。
        // B 站卡仍输出 `[B站视频 标题](url)`，parse_video / send_bilibili 认这个形状。
        out.push(cardText(d));
        break;
      }
      case 'xml': {
        // svcId 不是 1 的老式 XML 卡（公众号文章 / 音乐 / 网页卡）同样把字拿出来。
        out.push(xmlText(d));
        break;
      }
      case 'forward': {
        // 不把协议转发 ID 写进可见文本；模型用 read_forward + 消息前的本地 #短编号，
        // 执行器再从当前会话存档取得原消息号，避免把资源号或外层引用消息号混作目标。
        out.push('[合并转发聊天记录]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return sanitizeUserText(out.join('').trim());
}

/** 从消息段提取媒体定位信息（不下载）。 */
export function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image') {
      media.push({ kind: 'image', file: String(d.file ?? ''), url: String(d.url ?? ''), summary: String(d.summary ?? '') });
    } else if (seg.type === 'face') {
      media.push({ kind: 'face', faceId: String(d.id ?? '') });
    } else if (seg.type === 'json' || seg.type === 'xml') {
      // ★ 2026-10-27：卡片自带的预览图也进 media —— 以前卡片图一张都进不了画面通道，
      //   模型只能读到占位符。这里只取卡片自报的那张封面图，不去 fetch 正文。
      const facts = seg.type === 'json' ? cardFacts(d) : xmlFacts(d);
      if (facts?.image) media.push({ kind: 'image', file: '', url: facts.image, summary: facts.title || '' });
    } else if (seg.type === 'reply') {
      // ★ 2026-10-26（引用图看不到的修法·下游那半）：引用段带上了被引用消息里的图片地址
      //   （snowluma 侧 resolveQuotedImages 注入，见 snowluma/index.mjs 的 reply.toSegment）。
      //   以前引用图只能靠 reply.id 回存档查原消息，而那个 id 常是哈希兜底值、查不到 ⇒
      //   模型只看到 `[image]` 占位。这里把地址直接收进 media，自动看图就能附上。
      const quoted = Array.isArray(d.images) ? d.images : [];
      for (const im of quoted.slice(0, 3)) {
        if (!im || typeof im !== 'object') continue;
        const url = String(im.url ?? '');
        if (!url) continue;
        media.push({ kind: 'image', file: String(im.file ?? ''), url, summary: String(im.summary ?? ''), from: 'quote' });
      }
    }
  }
  return media;
}

/**
 * 展开合并转发节点为可读文本（纯函数，便于测试）。
 *
 * 背景：OneBot/NapCat 的 get_forward_msg 返回转发节点数组（本函数处理的就是这个数组）。
 * read_forward 按本仓 NapCat 合同用同聊天存档的原消息号作为 message_id，不把 segment 资源 ID
 * 或本地 #短编号直接当请求参数。
 *
 * 规则：
 *   - 每个节点一行「昵称: 内容」，内容复用 segmentsToText（@/图片/表情等占位一致）
 *   - 嵌套转发不再展开（深度 1 封顶，套娃截断）
 *   - 封顶：maxNodes 条 / maxChars 字符，超出注明"还有 N 条未展开"
 *   - 节点里的图片段同时提取到 media（url 新鲜，可用于取图/金句）
 *
 * @param {Array} nodes get_forward_msg 返回的 messages 数组
 * @returns {{ text: string, media: Array } | null} 无可用节点返回 null
 */
export async function expandForwardNodes(nodes, { maxNodes = 30, maxChars = 3000 } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) return null;
  const lines = [];
  const media = [];
  let truncated = 0;

  for (let i = 0; i < nodes.length; i++) {
    if (lines.length >= maxNodes) { truncated = nodes.length - i; break; }
    const n = nodes[i] || {};
    const name = String(n.sender?.card || n.sender?.nickname || n.user_id || '?');
    const nm = n.message ?? n.content;
    let body = '';
    if (typeof nm === 'string') {
      // 字符串形态一般是 CQ 码原文，剥掉 [CQ:xxx] 段保留纯文本
      body = nm.replace(/\[CQ:[^\]]*\]/g, '').trim();
    } else if (Array.isArray(nm)) {
      // 嵌套 forward 段清空 data → segmentsToText 输出 [转发消息] 占位（深度 1 封顶）
      const segs = nm.map((s) => (s?.type === 'forward' ? { type: 'forward', data: {} } : s));
      body = await segmentsToText(segs, {});
      media.push(...extractMediaFromSegments(segs));
    }
    body = body.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!body) continue;
    lines.push(`${name}: ${body}`);
    if (lines.join('\n').length > maxChars) { truncated = nodes.length - i - 1; break; }
  }

  const head = `[合并转发 共${nodes.length}条]`;
  if (!lines.length) return { text: head, media };
  const tail = truncated > 0 ? `\n…（还有 ${truncated} 条未展开）` : '';
  return { text: `${head}\n${lines.join('\n')}${tail}`, media };
}
