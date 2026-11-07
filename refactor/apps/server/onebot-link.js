/**
 * refactor/apps/server/onebot-link.js — OneBot 入站/出站/生命周期接线
 *
 * 职责：按配置实例化 OneBotClient（M3），把入站事件转成 rawBatch 交给 M15，
 * 把活着的 platform 注入 M10 使发送走协议端。只做 IO/接线，不做决定。
 *
 * ★ 2026-10-18：新增 **SnowLuma 令牌自动认领链**。干净包的 `snowluma.accessToken` 为空，
 *   而本机 SnowLuma 会给每个账号写两个独立令牌 ⇒ 不认领就一直 401（WS 无限重连刷屏）。
 *   读取/匹配在 `modules/snowluma.readAccountCredentials`；本层做"只填空、不覆盖"的应用、
 *   持久化、活 client 更新、有限重试与 401/进程事件触发。**任何日志与对外状态都不含令牌原文。**
 */
import { resolveDataDir } from './paths.js';
import { wireStoreCaps } from './store-caps.js';

// ── ★ 2026-10-29（溟 · 戳一戳入站）────────────────────────────────────────────
// 协议端把「有人戳我」推成 `post_type:'notice'`（SnowLuma 实测形状：
//   {notice_type:'notify', sub_type:'poke', user_id:<戳的人>, target_id:<被戳的>, group_id?, action, suffix}），
// 而这里原先只收 `post_type:'message'`，于是**每一次戳都被整条丢掉** —— 她那头看到的是
// 「戳了溟，溟没反应」，我这头看到的是「今天没有戳」。同一件事，两边都不报错。
//
// 收法（只收冲我来的）：
//   ① `target_id` 必须是我自己（私聊里协议端偶尔不给 target_id，那就当是戳我）；
//   ② 戳的人不能是我自己（`user_id === self_id` 一律丢，那是自己戳的回显）；
//   ③ 同一个人 45 秒内连戳只算一次（实测一次 send_poke 会推两条只差 3 秒的事件，
//      不去重就是一轮变两轮；真连戳也不必一轮一轮醒）。
// 造出来的是**一条 message 形状的合成事件**（正文 `[戳一戳] …`），沿用既有的
// 准入门（能说话的群 / 接话意愿 / 宵禁）——本层不加新的发言门槛。
const POKE_DEDUPE_MS = 45000;
const pokeSeenAt = new Map();   // `${chatKey}|${pokerId}` -> ts

function pokeToRawBatch(event) {
  if (!event || typeof event !== 'object') return null;
  const isPoke = (event.notice_type === 'notify' && event.sub_type === 'poke') || event.notice_type === 'poke';
  if (!isPoke) return null;

  const selfId = String(event.self_id ?? '').trim();
  const gid = Number(event.group_id);
  const isGroup = Number.isFinite(gid) && gid > 0;
  const targetId = String(event.target_id ?? '').trim();
  if (targetId) {
    if (!selfId || targetId !== selfId) return null;      // 戳的不是我，不管
  } else if (isGroup) {
    return null;                                          // 群里没有 target 判不了，宁可不收
  }

  const pokerId = String(event.user_id ?? '').trim() || String(event.sender_id ?? '').trim();
  if (!pokerId || pokerId === selfId) return null;

  const chatKey = isGroup ? `group:${gid}` : `private:${pokerId}`;
  const now = Date.now();
  const dedupeKey = `${chatKey}|${pokerId}`;
  const last = pokeSeenAt.get(dedupeKey) || 0;
  if (now - last < POKE_DEDUPE_MS) return null;
  pokeSeenAt.set(dedupeKey, now);
  if (pokeSeenAt.size > 400) {
    for (const [key, ts] of pokeSeenAt) if (now - ts > POKE_DEDUPE_MS) pokeSeenAt.delete(key);
  }

  const action = String(event.action || '戳了戳').trim() || '戳了戳';
  const suffix = String(event.suffix || '').trim();
  const text = isGroup
    ? `[戳一戳] QQ${pokerId}${action}你${suffix}`
    : `[戳一戳] ${action}你${suffix}`;

  const synthetic = {
    post_type: 'message',
    message_type: isGroup ? 'group' : 'private',
    ...(isGroup ? { group_id: gid } : {}),
    self_id: event.self_id ?? selfId ?? 0,
    user_id: Number(pokerId),
    time: event.time ?? Math.floor(now / 1000),
    sender: { user_id: Number(pokerId) },
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    // 不是真消息，别让它被当成可引用的历史消息 id 用
    poke: { action, suffix, target_id: targetId || selfId }
  };

  return {
    chatKey,
    kind: isGroup ? 'group' : 'private',
    selfId: event.self_id ?? 0,
    raw: [synthetic],
    botSaid: [],
    now
  };
}

/**
 * 把 OneBot 事件转成 M5 ingestBatch 要的 rawBatch。
 * @param {object} event - OneBot v11 事件（post_type:'message' 等）
 * @returns {object|null} rawBatch 或 null（非消息事件跳过）
 */
export function eventToRawBatch(event) {
  if (!event || typeof event !== 'object') return null;
  // ★ 2026-10-29：戳一戳（notice/poke）先过一道，冲我来的转成一条合成消息；其余 notice 照旧丢。
  if (event.post_type === 'notice') return pokeToRawBatch(event);
  if (event.post_type !== 'message') return null;

  const isGroup = event.message_type === 'group';
  const isPrivate = event.message_type === 'private';
  if (!isGroup && !isPrivate) return null;

  // ★ 2026-10-27（溟）：协议端对「对方发来的语音/文件」会镜像一份 from=自己 的回执，
  //   回执如果被当成 post_type:'message' 丢进来，就会把我的话记成她说的话。
  //   自己 id 与发送者相同的一律不收（真·自己发的走 message_sent，本来就到这里之外）。
  const selfId = String(event.self_id ?? '').trim();
  const senderId = String(event.user_id ?? event.sender?.user_id ?? '').trim();
  if (selfId && senderId && selfId === senderId) return null;

  // 整条既没有段也没有 raw_message 的推送：什么内容都没有，收下只会凭空开一轮对话
  // （一轮约 25k token），还让她看到我在回「空的」。直接丢。
  const segments = Array.isArray(event.message) ? event.message : null;
  const rawText = typeof event.raw_message === 'string' ? event.raw_message.trim() : '';
  if (segments && segments.length === 0 && !rawText) return null;

  const chatKey = isGroup
    ? `group:${event.group_id}`
    : `private:${event.user_id}`;
  const kind = isGroup ? 'group' : 'private';

  return {
    chatKey,
    kind,
    selfId: event.self_id ?? 0,
    raw: [event],
    botSaid: [],
    now: Date.now()
  };
}

/**
 * 解析出 SendQueue 要用的 store。
 *
 * 优先级：
 *   ① 调用方显式传 `store`（测试 / 将来换成别的实现）；
 *   ② `modules.memory.createChatStore()`（M6 冻结出口）—— **生产路径**；
 *   ③ 都没有 ⇒ **退回显式空桩并打日志**（写清是空的，不静默）。
 *
 * 两条都不许"假装成功"：② 建不起来要打日志说明自述留档与引用查找都不可用。
 *
 * @param {object} p
 * @param {object} p.modules  模块命名空间（含 `memory`）
 * @param {object} [p.store]  调用方注入的 store
 * @param {() => boolean} [p.isPersonaTwo] 第二人格判定（注入；本层不判定）
 * @param {object} [p.cfg]    配置访问器（wireStoreCaps 用它读 `store.maxMessagesPerChat/hotMessagesPerChat`）
 * @param {Function} [p.log]
 */
function resolveStore({ modules, store, isPersonaTwo, log, cfg = null }) {
  if (store && typeof store.appendSelf === 'function' && typeof store.findByRef === 'function') {
    return store;
  }
  const factory = modules?.memory?.createChatStore;
  if (typeof factory !== 'function') {
    log?.('[onebot-link] modules.memory.createChatStore 不存在（M6 未落地？）'
      + ' —— 退回空 store：自述留档不可用、引用/短编号/翻旧账没有数据源（不静默）');
    return Object.freeze({
      appendSelf() { /* 空：M6 未落地 */ },
      findByRef() { return null; }
    });
  }
  try {
    const built = factory({ isPersonaTwo: typeof isPersonaTwo === 'function' ? isPersonaTwo : () => false });
    if (typeof built?.appendSelf !== 'function' || typeof built?.findByRef !== 'function') {
      throw new Error('createChatStore() 返回的对象上没有 appendSelf / findByRef');
    }
    // ★ 存储上限（老树 src/app.js:615/:2680-2681 同位）：兜底自建同样吃配置 —— 初值与热更新都经
    //   store-caps.js 的 wireStoreCaps（与装配层主分支共用；同一单例只订阅一次，主分支已接时这里是幂等的）。
    wireStoreCaps(built, cfg, log);
    log?.(`[onebot-link] 已接真 ChatStore（存档目录 ${built.getHealth?.().dirs?.messages ?? '(未知)'}）`);
    return built;
  } catch (error) {
    log?.(`[onebot-link] 建 ChatStore 失败（${error?.message ?? error}）`
      + ' —— 退回空 store：自述留档不可用、引用查找恒为 null（不静默）');
    return Object.freeze({
      appendSelf() { /* 空：建不起来 */ },
      findByRef() { return null; }
    });
  }
}

/**
 * 创建 OneBot 接线。
 * @param {object} opts
 * @param {object} opts.cfg - 配置访问器 { get(key, fallback) }（认领链还要求 updateConfigAndSave/updateConfig 之一）
 * @param {object} opts.runtime - M15 运行时 { onInbound, ... }
 * @param {object} opts.modules - 模块命名空间（含 platform、memory；认领链用 snowluma/observability）
 * @param {object} [opts.store] - 覆盖 SendQueue 用的 store（测试用；生产走 modules.memory.createChatStore）
 * @param {() => boolean} [opts.isPersonaTwo] - 第二人格判定（注入；不注入恒 false）
 * @param {function} [opts.log]
 * @returns {{ start, stop, platform, client, connected, syncTokens, refreshCredentials, getTokenSyncState }}
 */
export function createOneBotLink({ cfg, runtime, modules, log = console.log, store: storeOverride = null, isPersonaTwo = null, onSelfIdResolved = null } = {}) {
  const platformMod = modules?.platform;
  if (!platformMod?.OneBotClient) {
    throw new Error('[onebot-link] modules.platform.OneBotClient 不存在（M3 未落地？）');
  }
  // M10 的唯一发送出口是 platform.sendTextBatch，而 OneBotClient 本身**没有**这个方法
  // （§3.7：出口在 M3 的 SendQueue）。缺了它 act.send 每轮都抛错 —— 2026-10-04 实盘故障点。
  if (typeof platformMod?.SendQueue !== 'function') {
    throw new Error('[onebot-link] modules.platform.SendQueue 不存在（M3 未落地的发送出口？）');
  }

  // 连接配置（★ 2026-10-18：**不在创建期读死** —— 启动/认领/热重载时都重新读，见 readConnConfig
  //   与 refreshCredentials；这样"从 SnowLuma 账号文件认领到的新令牌"能真正进到已存在的 client）。
  //   键名与默认值照旧（老树 onebot 配置 + config.js 默认值）。
  function readConnConfig() {
    const wsUrl = cfg?.get?.('snowluma.wsUrl', 'ws://127.0.0.1:3001') || 'ws://127.0.0.1:3001';
    const httpUrl = cfg?.get?.('snowluma.httpUrl', 'http://127.0.0.1:3000') || 'http://127.0.0.1:3000';
    const accessToken = String(cfg?.get?.('snowluma.accessToken', '') || '');
    const httpAccessTokenRaw = String(cfg?.get?.('snowluma.httpAccessToken', '') || '');
    return { wsUrl, httpUrl, accessToken, httpToken: httpAccessTokenRaw || accessToken };
  }
  let conn = null;   // start() 取一次；syncTokens()/refreshCredentials() 之后更新（状态日志也读它）

  // M3 的 SendQueue 需要一个 ChatStore：appendSelf（自述留档）+ findByRef（短编号/QQ mid → 真消息）。
  // ⇒ 这里换成**真 store**（M6 memory 的 ChatStore，<dataDir>/messages 冷热分层）。
  //   dataDir 由 M6 的 data-dir.js fail-closed 解析（装配层 assemble() 已 setDataDir）；
  //   解析不出来时构造本身不抛（懒），但**第一次写盘会抛** —— 那是"没显式授权就不许碰盘"，不是静默。
  // isPersonaTwo：**注入**，本层不判定（判定归 M7 / 人格切换事务归 M15 §3.8）。
  //   没注入 ⇒ 恒 false ⇒ 只是摘要不做第二人格隔离，**不影响存档本身**（旧 safeIsPersonaTwo 的同一取舍）。
  // ★ 2026-10-05 事故修复（用户实测"启动失败"）：本函数是**解构参数**，没有 `opts` 这个变量，
  //   而这里原来写的是 `opts.store` / `opts.isPersonaTwo` ⇒ `ReferenceError: opts is not defined`
  //   ⇒ 新树**整棵起不来**（crash.log：createOneBotLink → index.js:82 → main.js:1797）。
  //   修法：把这两个选项加回解构签名（语义不变，仍是"可注入、缺省安全"）。
  const store = resolveStore({ modules, store: storeOverride, isPersonaTwo, log, cfg });

  let client = null;
  let sender = null;
  let platform = null;
  // ★ 2026-10-19（第七批）：连接代际 —— 每次 start/stop（含换号/重连）递增。
  //   引用回读缓存与在途响应按代际隔离：旧代际晚到的结果不写缓存、不回给调用方。
  let connectionGeneration = 0;
  let observedQuoteIdentity = null;
  let observedQuoteConnected = null;

  // ★ 2026-10-19（第六批 · QQ 引用原文）：活门面补一条**有界**的单条消息回读。
  //   背景：orchestrator 的引用兜底只在 `platform.call('get_msg')` 存在时才会向协议端补取，
  //   而活门面从未暴露该出口 ⇒ 库里没有的被引消息永远拿不到原文，模型/UI 只能看到 [引用消息]。
  //   纪律：只回读单条（不是通用 call）；3.5s 级超时；按 (chatKey, messageId) 正缓存 5 分钟/100 条；
  //   失败不缓存、不无限重试（客户端自身的连接重试除外）；**归属校验由调用方做**（本层不猜会话）。
  const QUOTE_GET_TIMEOUT_MS = 3500;
  const QUOTE_CACHE_TTL_MS = 5 * 60 * 1000;
  const QUOTE_CACHE_MAX = 100;
  const QUOTE_INFLIGHT_MAX = 100;
  const quoteMsgCache = new Map();     // account/instance/generation/chat/message scoped
  const quoteMsgInflight = new Map();  // same scope; never joins across identity changes
  const readQuoteIdentity = () => {
    let accountId = '';
    try { accountId = String(client?.selfId ?? '').trim(); } catch { accountId = ''; }
    let instanceId = '';
    try { instanceId = String(cfg?.describeInstance?.() ?? '').trim(); } catch { instanceId = ''; }
    const connected = client?.connected === true;
    const token = `${accountId}\u0000${instanceId}`;
    if (observedQuoteIdentity === null) {
      observedQuoteIdentity = token;
      observedQuoteConnected = connected;
    } else if (observedQuoteIdentity !== token || observedQuoteConnected !== connected) {
      // selfId 空→有、同连接换账号/实例、断开/重连均推进代际并隔离旧缓存/在途。
      connectionGeneration += 1;
      observedQuoteIdentity = token;
      observedQuoteConnected = connected;
      quoteMsgCache.clear();
      quoteMsgInflight.clear();
    }
    return { accountId, instanceId, connected, generation: connectionGeneration };
  };
  const sameQuoteIdentity = (a, b) => Boolean(a && b)
    && a.accountId === b.accountId
    && a.instanceId === b.instanceId
    && a.generation === b.generation;

  async function getMsgForQuote(messageId, {
    chatKey = '', signal = null, timeoutMs = QUOTE_GET_TIMEOUT_MS, validate = null
  } = {}) {
    if (!client || typeof client.call !== 'function') return null;
    const id = String(messageId ?? '').trim();
    if (!/^-?\d+$/.test(id) || signal?.aborted) return null;
    const identityAtRequest = readQuoteIdentity();
    if (!identityAtRequest.connected) return null;
    const key = `${identityAtRequest.accountId}\u0000${identityAtRequest.instanceId}\u0000${identityAtRequest.generation}\u0000${String(chatKey)}\u0000${id}`;
    const hit = quoteMsgCache.get(key);
    if (hit && sameQuoteIdentity(hit.identity, identityAtRequest) && Date.now() - hit.at < QUOTE_CACHE_TTL_MS) return hit.data;
    if (hit) quoteMsgCache.delete(key);
    const pending = quoteMsgInflight.get(key);
    if (pending) return pending.promise;
    if (quoteMsgInflight.size >= QUOTE_INFLIGHT_MAX) return null;
    // 消息 id 可能是负数/超出安全整数：负数按整数传；大整数保留字符串，避免 Number 精度丢失。
    const numeric = Number(id);
    const wireId = Number.isSafeInteger(numeric) ? numeric : id;
    const requestedTimeout = Number(timeoutMs);
    const boundedTimeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(QUOTE_GET_TIMEOUT_MS, Math.floor(requestedTimeout)) : QUOTE_GET_TIMEOUT_MS;
    const operation = (async () => {
      const data = await client.call('get_msg', { message_id: wireId }, boundedTimeout, {
        signal,
        totalTimeoutMs: boundedTimeout
      });
      const identityAfterRequest = readQuoteIdentity();
      if (signal?.aborted || !sameQuoteIdentity(identityAtRequest, identityAfterRequest) || !identityAfterRequest.connected) return null;
      if (data && typeof data === 'object') {
        // 只有调用方完成会话/账号/返回 ID 校验后才做底层正缓存；无效响应留给下一批重试。
        let accepted = false;
        try { accepted = typeof validate === 'function' && validate(data) === true; } catch { accepted = false; }
        if (accepted && !signal?.aborted) {
          quoteMsgCache.set(key, { at: Date.now(), identity: identityAfterRequest, data });
          while (quoteMsgCache.size > QUOTE_CACHE_MAX) quoteMsgCache.delete(quoteMsgCache.keys().next().value);
        }
        return data;
      }
      return null;
    })();
    const record = { identity: identityAtRequest, promise: operation };
    quoteMsgInflight.set(key, record);
    const onRequestAbort = () => {
      if (quoteMsgInflight.get(key) === record) quoteMsgInflight.delete(key);
    };
    signal?.addEventListener?.('abort', onRequestAbort, { once: true });
    if (signal?.aborted) onRequestAbort();
    try {
      return await operation;
    } catch (error) {
      log(`[onebot-link] 引用回读失败（${String(chatKey).slice(0, 40)} id=${id.slice(0, 32)}）：${String(error?.message ?? error).slice(0, 120)}`);
      return null;
    } finally {
      signal?.removeEventListener?.('abort', onRequestAbort);
      if (quoteMsgInflight.get(key) === record) quoteMsgInflight.delete(key);
    }
  }

  // ── SnowLuma 令牌自动认领（★ 2026-10-18：干净包首次安装/新账号的令牌同步链）──────────────
  //   读取/匹配规则全在 `modules/snowluma.readAccountCredentials`（只用本实例选定的目录、按各自
  //   host/port 匹配、不拿第一个文件、远端不套本地密钥、多账号歧义不猜）；这里只负责：
  //   **只填空、不覆盖**地把认领结果写进本实例配置（持久化）、更新活 client、失败给可行动原因、
  //   有限重试 + 401/进程事件触发。**日志与对外状态永不含令牌原文。**
  const SYNC_RETRY_DELAYS_MS = [3000, 8000, 20000, 45000, 90000, 180000]; // 有限重试（约 6 分钟封顶）
  const AUTH_RECOVERY_MIN_MS = 30000;   // 401 触发的认领最小间隔
  const AUTH_RECOVERY_MAX_MS = 120000;  // 连续无果时的退避上限
  let syncRetryIndex = 0;
  let syncRetryTimer = null;
  let offSnowlumaStatus = null;
  let lastRecoveryAt = 0;
  let authRecoveryDelayMs = AUTH_RECOVERY_MIN_MS;
  let lastSyncLogSig = '';
  let tokenSyncState = {
    state: 'idle', reason: '', at: 0, why: '',
    uin: null, dir: '', wsPort: 0, httpPort: 0,
    tokens: { ws: false, http: false }
  };

  /** 对外状态快照（**永不含令牌值**；给 GET /api/snowluma/token-status 与排障日志用）。 */
  function getTokenSyncState() {
    return { ...tokenSyncState, tokens: { ...(tokenSyncState.tokens || {}) } };
  }

  function setTokenSyncState(state, reason, extra = {}) {
    tokenSyncState = { state, reason: String(reason || ''), at: Date.now(), ...extra };
  }

  /** 按当前配置重新读连接参数并应用到活 client（WS 侧变了且已连接才重连；见 OneBotClient.applyConnectionConfig）。 */
  function refreshCredentials() {
    const next = readConnConfig();
    conn = next;
    if (!client) return { ok: false, changed: false, reconnected: false, reason: 'client-not-started' };
    if (typeof client.applyConnectionConfig === 'function') {
      const r = client.applyConnectionConfig({
        wsUrl: next.wsUrl, httpUrl: next.httpUrl, accessToken: next.accessToken, httpToken: next.httpToken
      }) || {};
      return { ok: true, changed: !!r.changed, reconnected: !!r.reconnected };
    }
    // 兼容测试桩/老形状的 client：直写字段；WS 侧变了、已连接、且它真的能重连时才重连。
    const wsChanged = client.wsUrl !== next.wsUrl || client.accessToken !== next.accessToken;
    const httpChanged = client.httpUrl !== next.httpUrl || client.httpToken !== next.httpToken;
    if (!wsChanged && !httpChanged) return { ok: true, changed: false, reconnected: false };
    client.wsUrl = next.wsUrl;
    client.httpUrl = next.httpUrl;
    client.accessToken = next.accessToken;
    client.httpToken = next.httpToken;
    let reconnected = false;
    if (wsChanged && client.connected && typeof client.reconnect === 'function') {
      try { client.reconnect(); reconnected = true; } catch { /* 连接循环自愈 */ }
    }
    return { ok: true, changed: true, reconnected };
  }

  /** 瞬态失败（账号文件还没生成 / 端口还没对上）才排有限重试；其余状态停表（由 401/事件/热重载兜底）。 */
  function scheduleSyncRetry(foundState, sides = []) {
    const transient = foundState === 'no-file' || foundState === 'no-match'
      || (foundState === 'partial' && sides.some((s) => s && s.state === 'no-match'));
    if (!transient) {
      if (syncRetryTimer) { clearTimeout(syncRetryTimer); syncRetryTimer = null; }
      syncRetryIndex = 0;
      return;
    }
    if (syncRetryTimer) return;        // 已有排程，不叠加
    const delay = SYNC_RETRY_DELAYS_MS[syncRetryIndex];
    if (delay === undefined) return;   // 次数用尽 ⇒ 停（不是无限轮询）
    syncRetryIndex += 1;
    syncRetryTimer = setTimeout(() => { syncRetryTimer = null; syncTokens('retry'); }, delay);
  }

  /** 状态签名变化才打一行日志（401 反复触发不许刷屏）；**永不含令牌原文**。 */
  function logSyncOnce(found = null, patch = null, state = tokenSyncState.state, reasonText = '') {
    const sig = `${state}|${found?.uin ?? tokenSyncState.uin ?? ''}|${found?.ws?.state ?? ''}|${found?.http?.state ?? ''}|${reasonText}`;
    if (sig === lastSyncLogSig) return;
    lastSyncLogSig = sig;
    let detail = reasonText;
    if (found && (state === 'synced' || state === 'partial-synced' || state === 'up-to-date' || state === 'partial')) {
      const bits = [];
      if (patch?.accessToken) bits.push('WS 令牌已补');
      if (patch?.httpAccessToken) bits.push('HTTP 令牌已补');
      detail = `账号 ${found.uin ?? '(未锁定)'}（ws=${found.ws?.port || 0} http=${found.http?.port || 0}）`
        + `${bits.length ? `：${bits.join('、')}` : '：无需变更'}${reasonText ? `；${reasonText}` : ''}`;
    }
    log(`[onebot] SnowLuma 令牌认领（${tokenSyncState.why || 'manual'}）：${detail || state}`);
  }

  /**
   * 认领/同步一次 SnowLuma 令牌：读账号配置 → 只填空处写入本实例配置 → 更新活 client。
   * @param {string} why 触发原因（只进日志/状态，不参与判定）
   * @returns {{ok:boolean, changed:boolean, state:string, reason:string}}
   */
  function syncTokens(why = 'manual') {
    const sno = modules?.snowluma;
    if (typeof sno?.readAccountCredentials !== 'function') {
      const reason = 'modules/snowluma.readAccountCredentials 不存在（模块未装配），跳过令牌认领';
      setTokenSyncState('module-missing', reason, { why });
      logSyncOnce();
      return { ok: false, changed: false, state: 'module-missing', reason };
    }
    let found;
    try {
      found = sno.readAccountCredentials({
        wsUrl: String(cfg?.get?.('snowluma.wsUrl', '') || ''),
        httpUrl: String(cfg?.get?.('snowluma.httpUrl', '') || '')
      }) || {};
    } catch (error) {
      const reason = `读取 SnowLuma 账号配置失败：${error?.message ?? error}`;
      setTokenSyncState('read-failed', reason, { why });
      logSyncOnce();
      return { ok: false, changed: false, state: 'read-failed', reason };
    }

    const currentWs = String(cfg?.get?.('snowluma.accessToken', '') || '');
    const currentHttpRaw = String(cfg?.get?.('snowluma.httpAccessToken', '') || '');
    const currentHttpEffective = currentHttpRaw || currentWs;   // 空 = 沿用 accessToken（与 readConnConfig 同口径）
    const notes = [];
    const patch = {};
    if (found.state === 'partial' && found.reason) notes.push(found.reason);
    let conflict = false;
    if (found.state === 'ok' || found.state === 'partial') {
      // ★ 两个令牌**各自独立**判定（WS 按 wsServers、HTTP 按 httpServers）；只填空、不覆盖、不清空。
      const sides = [
        ['WS', 'accessToken', found.ws, currentWs, 'snowluma.accessToken'],
        ['HTTP', 'httpAccessToken', found.http, currentHttpEffective, 'snowluma.httpAccessToken']
      ];
      for (const [label, key, side, current, configKey] of sides) {
        if (!side || (side.state !== 'token' && side.state !== 'empty-token')) continue;
        if (side.state === 'empty-token') { notes.push(`${label}：${side.reason}`); continue; }
        if (!current) { patch[key] = side.token; continue; }
        if (current === side.token) continue;
        conflict = true;
        notes.push(`${label}：本实例配置里已显式设置了**不匹配**的令牌（与 SnowLuma 端口 ${side.port} 的条目不一致）`
          + `——不覆盖。要自动认领请清空 ${configKey}，或把它改成与 SnowLuma 一致的值`);
      }
    }

    let changed = false;
    let state = found.state === 'ok'
      ? (conflict ? 'conflict' : (Object.keys(patch).length ? 'synced' : 'up-to-date'))
      : found.state === 'partial'
        ? (conflict ? 'conflict' : (Object.keys(patch).length ? 'partial-synced' : 'partial'))
        : found.state;

    if (Object.keys(patch).length) {
      try {
        if (typeof cfg?.updateConfigAndSave === 'function') {
          cfg.updateConfigAndSave({ snowluma: patch });
          changed = true;
        } else if (typeof cfg?.updateConfig === 'function') {
          cfg.updateConfig({ snowluma: patch });   // 没有落盘出口时至少本进程生效（如实记 note，不静默）
          changed = true;
          notes.push('本实例配置没有落盘出口（updateConfigAndSave 不在），本次只在内存生效');
        } else {
          state = 'apply-unavailable';
          notes.push('本实例配置不接受写入（updateConfigAndSave/updateConfig 都不在），令牌无法应用');
        }
      } catch (error) {
        state = 'apply-failed';
        notes.push(`写入本实例配置失败：${error?.message ?? error}`);
      }
    }

    const reasonText = [found.reason, ...notes].filter(Boolean).join('；');
    setTokenSyncState(state, reasonText, {
      why,
      uin: found.uin ?? null,
      dir: found.dir || '',
      wsPort: found.ws?.port || 0,
      httpPort: found.http?.port || 0,
      tokens: {
        ws: !!(patch.accessToken || currentWs),
        http: !!(patch.httpAccessToken || currentHttpRaw || currentWs)
      }
    });
    logSyncOnce(found, patch, state, reasonText);
    if (changed) refreshCredentials();   // 认领成功 ⇒ 立即更新活 client（它是自己重试/重连的节奏）
    scheduleSyncRetry(found.state, [found.ws, found.http]);
    return { ok: true, changed, state, reason: reasonText };
  }

  /** WS 401/未授权时的兜底：限频（带退避）认领一次；认领成功会顺带更新 client，下次重试即用新令牌。 */
  function recoverOnAuthFailure() {
    const now = Date.now();
    if (now - lastRecoveryAt < authRecoveryDelayMs) return;
    lastRecoveryAt = now;
    const before = tokenSyncState.state;
    const r = syncTokens('auth-401');
    // 连续无果（状态没变且没写配置）⇒ 退避拉长到上限；有进展 ⇒ 回到最小间隔。不是无限高频轮询。
    if (r.changed || r.state !== before) authRecoveryDelayMs = AUTH_RECOVERY_MIN_MS;
    else authRecoveryDelayMs = Math.min(AUTH_RECOVERY_MAX_MS, Math.max(AUTH_RECOVERY_MIN_MS, authRecoveryDelayMs * 2));
  }

  /** 把一批原始消息交给 M15。rejection 必须接住：否则一条坏批次会变成 unhandledRejection（Node ≥15 默认杀进程）。 */
  function deliver(batch) {
    try {
      const settled = runtime.onInbound(batch);
      if (settled && typeof settled.catch === 'function') {
        settled.catch((e) => log(`[onebot-link] onInbound 失败: ${e?.message ?? e}`));
      }
    } catch (e) {
      log(`[onebot-link] onInbound 出错: ${e?.message ?? e}`);
    }
  }

  return {
    /** 入站/出站的 platform 实例（传给 act.send）——带 sendTextBatch 的活门面 */
    get platform() { return platform; },
    get client() { return client; },
    get sender() { return sender; },
    get connected() { return client?.connected ?? false; },

    /** ★ 2026-10-18：认领/同步一次 SnowLuma 令牌（只填空、不覆盖；写本实例配置并更新活 client）。 */
    syncTokens,
    /** 按当前配置重新读连接参数并应用到活 client（热重载/认领恢复后；从不打印令牌）。 */
    refreshCredentials,
    /** 令牌认领状态快照（**永不含令牌值**；GET /api/snowluma/token-status 读它）。 */
    getTokenSyncState,

    /** 建连 */
    start() {
      if (client) throw new Error('[onebot-link] 已在运行，不许重复 start()');
      // ★ 第七批：新连接代际 + 清引用回读缓存（旧代际条目/在途结果不再有效）。
      connectionGeneration += 1;
      quoteMsgCache.clear();
      quoteMsgInflight.clear();

      // ★ 2026-10-18：建连前先认领一次 SnowLuma 令牌（干净包首次安装=空令牌 ⇒ 不认领会 401 刷屏）。
      //   账号文件还没生成（QQ 还没登录）时只记状态，随后由有限重试 / 401 / 进程事件继续认领。
      syncTokens('startup');
      conn = readConnConfig();

      client = new platformMod.OneBotClient({
        wsUrl: conn.wsUrl,
        httpUrl: conn.httpUrl,
        accessToken: conn.accessToken,
        httpToken: conn.httpToken,
        onEvent(event) {
          const rawBatch = eventToRawBatch(event);
          if (!rawBatch) return;
          // ★ N-TRANSCRIBE（用户报「语音类消息只剩 [语音]」，老树 src/app.js:928 同款）：
          //   宿主层（持有活客户端的那层）先把语音段转成文字，再进 M15。
          //   软依赖：modules.media.transcribeRecordSegments 不在（media 未装配）⇒ 原样进，
          //   行为与改造前逐字节一致；转写本身 25s 超时 + [语音] 兜底，坏了也不堵收消息。
          const transcribe = modules?.media?.transcribeRecordSegments;
          if (typeof transcribe !== 'function') {
            deliver(rawBatch);
            return;
          }
          void (async () => {
            try {
              const prepared = await transcribe(rawBatch, client, { log });
              deliver(prepared ?? rawBatch);
            } catch (e) {
              // 转写整批失败 => 按没转写处理（老树同款：绝不让转写错误影响收消息）
              log(`[onebot-link] 语音转写失败（按 [语音] 占位进链）: ${e?.message ?? e}`);
              deliver(rawBatch);
            }
          })();
        }
      });

      sender = new platformMod.SendQueue({
        onebot: client,
        store,
        onSent: (info) => log(`[onebot-link] 已发出 chatKey=${info?.chatKey} messageId=${info?.messageId ?? '(无)'}`)
      });

      platform = Object.freeze({
        get connected() { const connected = client?.connected ?? false; readQuoteIdentity(); return connected; },
        // ★ 第七批：连接代际（start/stop 递增）。引用回读缓存按它隔离；调用方可用它判断
        //   一次异步回读是否跨代（旧响应不得写进新代际缓存）。
        get connectionGeneration() { return readQuoteIdentity().generation; },
        // ★ 2026-10-11 sp4（指挥位窄授）：透出 OneBot client 的 selfId（onebot.js:209 的
        //   getter，读 selfInfo.user_id，取不到回 ''）—— 0.4 工具 ctx 的 ctx.selfId 与
        //   triggerUserIds 排自己都要它。只加 getter，不改任何发送路径。
        get selfId() { const selfId = client?.selfId ?? ''; readQuoteIdentity(); return selfId; },
        /** §3.7 唯一发送出口：M10 act.send 认的就是这个签名与返回形状 {sent,failed} */
        sendTextBatch: (chatKey, messages, options = {}) => sender.sendTextBatch(chatKey, messages, options),
        // ★ 2026-10-05（G16 第一步，指挥位加）：**媒体出口**。
        //   背景：M3 的 SendQueue 早就有 `sendImage`（sender.js:464）与 `sendSegments`（:495），
        //   但活门面只暴露了 `sendTextBatch` ⇒ 图片/表情/B站卡/音乐卡**没有任何一条路能到协议端**
        //   （工具侧只能返回 `pendingSend`，模型以为发了、群里什么都没有）。
        //   这里只做**转发**（不加逻辑、不改现有文本路径）；真正的放行与"同形状回执"在 M10 的 `send()` 媒体分支。
        //   返回形状照 M3 原样：`{ message_id, reply }` —— 没有 ok 字段，M10 侧由 message_id 是否存在判成败。
        sendImage: (chatKey, payload = {}, options = {}) => sender.sendImage(chatKey, payload, options),
        sendSegments: (chatKey, segments = [], options = {}) => sender.sendSegments(chatKey, segments, options),
        // ★ 2026-10-19（第六批）：引用原文的单条回读出口（有界 + 正缓存；不是通用协议 call）。
        //   调用方（orchestrator 引用兜底）必须校验返回消息的会话/账号归属后才可使用。
        getMsg: (messageId, options = {}) => getMsgForQuote(messageId, options)
      });

      // ★ 2026-10-16：selfId **从空到非空**时通知一次装配层（`onSelfIdResolved`）。
      //   为什么需要：发言链读的 `platform.selfId` 本身是**活**的（门面 getter ⇒ client.selfId，见
      //   index.js:226 与本节），所以 selfId 一恢复，compose 下一轮就正常；但**派生绑定**
      //   （`budgetService.configure({accountId,instanceId})`、JEV 判据模型、协调器账号）是"注入/刷新时算一次"，
      //   selfId 迟到时它们会停在空账号上（各自还有别的刷新时机，这里补上"恢复即刷新"这条最短路径）。
      //   只发一次（每个非空值一次），不记账号/令牌。
      let notifiedSelfId = '';
      const notifySelfIdResolved = (why) => {
        const current = String(client?.selfId ?? '').trim();
        if (!current || current === notifiedSelfId) return;
        notifiedSelfId = current;
        try {
          onSelfIdResolved?.(current, why);
          log(`[onebot-link] selfId 就绪（${why}）⇒ 已通知装配层刷新账号绑定`);
        } catch (error) {
          log(`[onebot-link] selfId 就绪通知失败：${error?.message ?? error}`);
        }
      };
      if (typeof onSelfIdResolved === 'function') {
        const watchDelays = [500, 1500, 3000, 6000, 12000];
        const watch = () => {
          if (!client) return;
          if (client.selfId) { notifySelfIdResolved('连接后自查'); return; }
          const next = watchDelays.shift();
          if (next !== undefined) setTimeout(watch, next);
        };
        watch();
      }

      client.onStatus?.((st) => {
        readQuoteIdentity();
        if (st?.connected) {
          log(`[onebot-link] 已连接 wsUrl=${conn?.wsUrl ?? ''}`);
          authRecoveryDelayMs = AUTH_RECOVERY_MIN_MS;   // 连上即回到最小退避（下次断了再快速兜底一次）
          // 连上后再自查一次（onebot.js 自己那次 get_login_info 成功时也能被这里第一时间看到）。
          setTimeout(() => notifySelfIdResolved('重连后自查'), 800);
        } else {
          // ★ 2026-10-18：401/未授权 = 十有八九是"本机 SnowLuma 生成了令牌但本实例还没认领"，
          //   限频触发一次认领（成功即更新 client，随后它自己的重连节奏会用上新令牌）。
          if (/401|unauthorized/i.test(String(st?.error || ''))) recoverOnAuthFailure();
          log(`[onebot-link] 连接断开 wsUrl=${conn?.wsUrl ?? ''} 错误=${st?.error || '(无)'}`);
        }
      });

      // ★ 2026-10-18：SnowLuma 进程被（内嵌/独立）拉起时再认领一次 —— 首次安装时账号文件往往
      //   还没生成；进程事件 / 有限重试 / 401 三条触发互相兜底，不用死等、也不用高频轮询。
      const busOn = modules?.observability?.on;
      if (typeof busOn === 'function') {
        try {
          offSnowlumaStatus = busOn('snowluma-status', (payload) => {
            if (payload && payload.running === false) return;
            syncTokens('snowluma-status');
          });
        } catch { offSnowlumaStatus = null; }
      }

      // ★ 2026-10-16（事故收口 · 安全诊断 + 有界自愈）：
      //   `selfId` 的唯一来源是 **HTTP** `get_login_info`（onebot.js:143-151：WS open 时调一次，
      //   失败只 console.error、selfInfo 留空、**不重试**）⇒ selfId 为空时**每一轮 compose 的预算化
      //   模型调用都会被拒**（compose.js:581-583 → `budget-account-id-unavailable`），症状是
      //   "能收到消息、但永远不发言，只留系统记录"。这与 `persona.systemMode` 无关（那条路径只读配置、
      //   没有抛错分支，见 compose.js:1761-1766 只校验第二人格）。
      //   这里补：WS 已连但 selfId 仍空 ⇒ 退避重试 get_login_info（最多 3 次 / 60s 窗口内），
      //   并把阶段与错误码写进日志（**不记令牌、不记内容**）；成功一次即停。
      const healDelays = [3000, 6000, 12000];
      const healDeadline = Date.now() + 60000;
      const healSelfId = () => {
        if (!client || client.selfId) return;
        if (Date.now() > healDeadline) return;
        /** 真发起一次探测；只有**真发起**才消耗一次尝试预算（断线等待不消耗）。 */
        const attempt = () => {
          if (!client || client.selfId || Date.now() > healDeadline) return;
          if (!client.connected) { setTimeout(attempt, 3000); return; }   // 等 WS 连上再看，不占次数
          void (async () => {
            try {
              client.selfInfo = await client.call('get_login_info');
              if (client.selfId) {
                log('[onebot-link] selfId 已补齐（get_login_info 重试成功）');
                notifySelfIdResolved('get_login_info 重试成功');
              }
            } catch (error) {
              const text = String(error?.message ?? error);
              const http = /HTTP\s*(\d{3})/.exec(text)?.[1];
              const retcode = /retcode=([^\s]+)/.exec(text)?.[1];
              const code = http ? `HTTP ${http}` : (retcode ? `retcode=${retcode}` : String(error?.name ?? 'error'));
              log(`[onebot-link] selfId 仍为空（get_login_info 失败：${code}）⇒ 预算化模型调用会被拒`
                + '（budget-account-id-unavailable）；请核对 snowluma.httpUrl / snowluma.httpAccessToken（HTTP API 端口与令牌，'
                + '与 WS 的 accessToken 是两套）');
            }
            const nextDelay = healDelays.shift();
            if (nextDelay !== undefined) setTimeout(attempt, nextDelay);
          })();
        };
        const firstDelay = healDelays.shift();
        if (firstDelay !== undefined) setTimeout(attempt, firstDelay);
      };
      healSelfId();

      try {
        client.connect();
        log(`[onebot-link] 正在连接 wsUrl=${conn?.wsUrl ?? ''} httpUrl=${conn?.httpUrl ?? ''}`);
      } catch (e) {
        log(`[onebot-link] 连接失败 wsUrl=${conn?.wsUrl ?? ''}：${e?.message ?? e}`);
        throw e;
      }
    },

    /** 断开 */
    stop() {
      // ★ 第七批：先推进连接代际并清引用回读缓存 —— 旧 client 的在途 get_msg 晚到不会污染新链路。
      connectionGeneration += 1;
      quoteMsgCache.clear();
      quoteMsgInflight.clear();
      // ★ 2026-10-18：令牌认领的重试排程与事件订阅属于链路生命周期，停止时一并清掉（不残留 timer）。
      if (syncRetryTimer) { clearTimeout(syncRetryTimer); syncRetryTimer = null; }
      if (typeof offSnowlumaStatus === 'function') { try { offSnowlumaStatus(); } catch { /* ignore */ } offSnowlumaStatus = null; }
      if (!client) return;
      try { client.close(); } catch { /* ignore */ }
      client = null;
      sender = null;
      platform = null;
      readQuoteIdentity();
      log('[onebot-link] 已断开');
    }
  };
}

/**
 * 创建桩 platform（用于自测：记录调用参数 + 伪造回执，不发真实消息）。
 * @returns {{ calls: [], call(action, params), connected: true }}
 */
export function createStubPlatform() {
  const calls = [];
  return {
    calls,
    connected: true,
    async call(action, params) {
      calls.push({ action, params });
      return { status: 'ok', retcode: 0, data: { message_id: `stub-${calls.length}` } };
    },
    async sendGroupMsg(groupId, message) {
      calls.push({ action: 'send_group_msg', params: { group_id: groupId, message } });
      return { status: 'ok', retcode: 0, data: { message_id: `stub-${calls.length}` } };
    },
    async sendPrivateMsg(userId, message) {
      calls.push({ action: 'send_private_msg', params: { user_id: userId, message } });
      return { status: 'ok', retcode: 0, data: { message_id: `stub-${calls.length}` } };
    },
    // act.send 的公开出口（README §3.7：platform.sendTextBatch）
    async sendTextBatch(chatKey, messages, options) {
      calls.push({ action: 'sendTextBatch', params: { chatKey, messages, options } });
      const ids = messages.map((_, i) => `stub-${calls.length}-${i}`);
      return { ok: true, ids, error: null };
    }
  };
}
