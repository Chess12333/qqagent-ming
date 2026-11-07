/**
 * M5 scenario · quote-fallback.js —— 引用兜底（N-QUOTE-FALLBACK，零 import，IO 全注入）
 *
 * 断点（2026-10-11 回归-媒体联动/引用核验定位）：新树 `orchestrator/index.js` 的
 *   resolveQuote 原本**只有 ChatStore 一条路** ⇒ 被引消息不在库里时（bot 没开到那条、
 *   P0 落盘之前的历史、未落盘会话）`quoted=null`，模型只看到 replyToMessageId 编号，
 *   不知道被引的是什么。老树口径（src/app.js:855-891 resolveReply）：**主路径是
 *   onebot.getMsg(messageId) 回读原文**，本地库只用来补短编号/身份；取不到时
 *   segmentsToText 落 `[引用消息]` 占位（src/onebot.js:585）——新树同样缺。
 *
 * ★ 为什么预取必须发生在 ingestBatch **之前**：M5 的引用解析器是**同步契约**——
 *   `segments.js` 的 callQuoteResolver 会把 Promise 返回值直接忽略
 *   （async-quote-resolver-ignored）⇒ 不能把 resolveQuote 改成 async，只能在它之前
 *   把结果备好（本模块的 `fallback` Map），resolver 库 miss 时查这张表。
 *
 * 本文件只放**可测的纯逻辑 + 依赖注入**（照 modules/media/auto-vision.js 的套路）：
 *   · `quoteInfoFromProtocol`：协议端一条 get_msg 返回 → 引用信息（老树 app.js:861-870 的抽取口径）；
 *   · `markUnresolvedReply` / `markUnresolvedReplyInString`：仍拿不到时补 `[引用消息]` 占位
 *     （数组段形态 / CQ 串形态，照老树进正文的位置与字样）；
 *   · `prefetchQuoteFallback`：两趟扫描（先预取、后补占位），返回 fallback 表。
 *   协议调用、库查询、日志全部由调用方注入 ⇒ 自测零 IO、零网络。
 */

/** 协议端回读的超时上限（老树没有显式上限，用客户端默认；这里显式封顶，防挂死收消息链）。 */
export const QUOTE_FALLBACK_TIMEOUT_MS = 8000;
/** 每批最多向协议端查询的不同引用数；其余引用如实留在未取得状态。 */
export const QUOTE_FALLBACK_MAX_UNIQUE = 16;
/** 每批并行读请求上限。 */
export const QUOTE_FALLBACK_CONCURRENCY = 3;
/** 占位字样（老树 src/onebot.js:585 逐字同款）。 */
export const QUOTE_PLACEHOLDER = '[引用消息]';

/**
 * 消息 id 规范化：只 trim + 转字符串，**保留负号**。
 * ★ 2026-10-19（第六批）：message_id 可为负数（`-123` 与 `123` 是两条不同消息）；
 *   旧实现照用户 id 去掉了首位 `-` ⇒ 存档/协议端都查不到 → 引用只能落 [引用消息]。
 */
function normId(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/** fallback 表的键（chatKey + mid）。 */
export function quoteKey(chatKey, mid) {
  return `${chatKey}\u0000${normId(mid)}`;
}

/**
 * 引用正文带进提示词的上限（字）。
 * ★ 2026-10-28（她：「看不到引用的引用」）：原来封在 120 字，被引的那条稍长就被腰斩，
 *   嵌套引用的原文更是根本进不来。240 够看清"这句是回谁的"，又不至于把上下文撑爆。
 */
export const QUOTE_TEXT_MAX = 240;
/** 二阶引用（引用的引用）最多再补几条：只补一层，够用就停。 */
export const QUOTE_NESTED_MAX = 8;

/**
 * 段类型 → 中文占位（跟 platform/onebot.js 的 segmentsToText 同一套字样，模型不用现学）。
 * ★ 2026-10-28：以前这里是 `[${s.type}]`，嵌套引用落成 `[reply]`、合并转发落成 `[forward]`——
 *   模型看到的是英文单词，只能猜。现在至少和正文里的占位符一致。
 */
const QUOTE_SEG_LABELS = Object.freeze({
  image: '[图片]', face: '[表情]', mface: '[表情]', record: '[语音]', video: '[视频]',
  file: '[文件]', forward: '[合并转发]', json: '[卡片]', xml: '[卡片]',
});

/**
 * 协议端一条消息的段数组 → 可读文本。
 * reply 段：nested 表里有原文就用原文（`[引用 X：…]`），没有就落 `[引用消息]` 占位。
 * @param {Array} segments
 * @param {{nested?:Map<string,string>|null, max?:number}} [opts]
 */
export function segmentsToQuoteText(segments, { nested = null, max = QUOTE_TEXT_MAX } = {}) {
  const parts = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    const d = seg?.data ?? {};
    const type = String(seg?.type ?? '');
    if (type === 'text') { parts.push(String(d.text ?? '')); continue; }
    if (type === 'at') { parts.push('@' + String(d.qq ?? d.name ?? '')); continue; }
    if (type === 'reply') {
      const inner = nested instanceof Map ? String(nested.get(normId(d.id)) ?? '') : '';
      parts.push(inner ? `[引用 ${inner}]` : QUOTE_PLACEHOLDER);
      continue;
    }
    parts.push(QUOTE_SEG_LABELS[type] ?? `[${type || '?'}]`);
  }
  return parts.join('').trim().slice(0, max);
}

/**
 * get_msg 的一条返回 → 引用信息（发送者/身份/原文；形态照老树 app.js:861-870 抽取）。
 * 认三种外层形态：`{message_id,sender,message}` / `{data:{…}}` / 其它 ⇒ null。
 * @param {any} data
 * @param {string|number} id
 * @param {{selfId?:string, nested?:Map<string,string>|null, max?:number}} [opts]
 *   nested：二阶引用原文（引用的引用）；有就内联进正文，没有就落 `[引用消息]`。
 * @returns {{id:string, sender:string, senderId:string, self:boolean, text:string, nestedIds:string[]}|null}
 *   nestedIds：这条被引消息**自己**又引了哪几条（调用方据此再补一层）。
 */
export function quoteInfoFromProtocol(data, id, { selfId = '', nested = null, max = QUOTE_TEXT_MAX } = {}) {
  const msg = data && typeof data === 'object'
    ? (data.message_id != null || data.sender ? data : (data.data ?? null))
    : null;
  if (!msg || typeof msg !== 'object') return null;
  const senderId = String(msg.sender?.user_id ?? msg.user_id ?? '').replace(/^-/, '');
  const senderName = String(msg.sender?.card || msg.sender?.nickname || '');
  const selfDigits = String(selfId ?? '').replace(/^-/, '');
  const self = Boolean(senderId && selfDigits && senderId === selfDigits);
  const nestedIds = [];
  const pushNested = (raw) => {
    const nid = normId(raw);
    if (nid && !nestedIds.includes(nid)) nestedIds.push(nid);
  };
  let text = '';
  if (Array.isArray(msg.message)) {
    for (const seg of msg.message) if (seg?.type === 'reply') pushNested(seg.data?.id);
    text = segmentsToQuoteText(msg.message, { nested, max });
  } else if (typeof msg.message === 'string') {
    for (const m of msg.message.matchAll(/\[CQ:reply[^\]]*\]/g)) {
      pushNested(/(?:^|,)id=(-?\d+)/.exec(m[0])?.[1] ?? '');
    }
    text = msg.message.replace(/\[CQ:reply[^\]]*\]/g, QUOTE_PLACEHOLDER).trim().slice(0, max);
  }
  return { id: normId(id), sender: senderName, senderId, self, text, nestedIds };
}

/** 本条消息里的 reply 段 id 列表（数组段或 CQ 串两种形态；去重、保序）。 */
export function replyIdsOf(item) {
  const ids = [];
  const push = (raw) => { const id = normId(raw); if (id && !ids.includes(id)) ids.push(id); };
  if (typeof item?.message === 'string') {
    for (const m of item.message.matchAll(/\[CQ:reply[^\]]*\]/g)) {
      push(/(?:^|,)id=(-?\d+)/.exec(m[0])?.[1] ?? '');
    }
    return ids;
  }
  const segments = Array.isArray(item?.message) ? item.message
    : Array.isArray(item?.segments) ? item.segments : [];
  for (const seg of segments) {
    if (seg?.type === 'reply') push(seg.data?.id);
  }
  return ids;
}

/**
 * 本条消息的 reply 段 id 里，哪些"已经算解析成功"（库里命中或协议端回读命中）。
 * ★ 为什么库里命中也要算：只按 fallback 表判会把"库里有、resolveQuote 走库"的引用也补上
 *   `[引用消息]` 占位 ⇒ 模型同时看到"引用：X 说：「原话」"和"取不到"——自相矛盾
 *   （2026-10-11 补牙时抓到的真 bug：场景 selftest 用例 25 的"库里有 ⇒ 不补占位"）。
 * @returns {Set<string>} 规范化后的 mid 集合
 */
export function resolvedQuoteIds(item, { chatKey = '', fallback = null, storeHas = null } = {}) {
  const out = new Set();
  for (const id of replyIdsOf(item)) {
    if (fallback instanceof Map && fallback.has(quoteKey(chatKey, id))) { out.add(id); continue; }
    if (typeof storeHas === 'function' && storeHas(id)) out.add(id);
  }
  return out;
}

/**
 * 数组段形态：在**解析失败**的 reply 段后面插占位 text 段（record 段本身保留）。
 * 解析成功的（fallback 命中 / 库里命中）不插；没有 reply 段 / 没插成功 ⇒ 不动入参、返回 false。
 */
export function markUnresolvedReply(item, { chatKey = '', fallback = null, storeHas = null } = {}) {
  const segments = Array.isArray(item?.message) ? item.message
    : Array.isArray(item?.segments) ? item.segments : null;
  if (!segments) return false;
  const resolved = resolvedQuoteIds(item, { chatKey, fallback, storeHas });
  let inserted = false;
  const next = [];
  for (const seg of segments) {
    next.push(seg);
    if (seg?.type !== 'reply') continue;
    const id = normId(seg.data?.id);
    if (!id || resolved.has(id)) continue;
    next.push({ type: 'text', data: { text: QUOTE_PLACEHOLDER } });
    inserted = true;
  }
  if (!inserted) return false;
  const key = Array.isArray(item.message) ? 'message' : 'segments';
  item[key] = next;
  return true;
}

/**
 * CQ 串形态：在 `[CQ:reply,…]` 之后插占位文字（parseCqString 会把它当普通文本）。
 * 解析成功（fallback / 库里命中）的不插；没有 reply 码 / 没插成功 ⇒ 不动入参、返回 false。
 */
export function markUnresolvedReplyInString(item, { chatKey = '', fallback = null, storeHas = null } = {}) {
  const raw = typeof item?.message === 'string' ? item.message : null;
  if (!raw || !/\[CQ:reply[,\]]/.test(raw)) return false;
  const resolved = resolvedQuoteIds(item, { chatKey, fallback, storeHas });
  const replaced = raw.replace(/\[CQ:reply[^\]]*\]/g, (m) => {
    const id = normId(/(?:^|,)id=(-?\d+)/.exec(m)?.[1] ?? '');
    return id && !resolved.has(id) ? `${m}${QUOTE_PLACEHOLDER}` : m;
  });
  if (replaced === raw) return false;
  item.message = replaced;
  return true;
}

/**
 * 主编排：两趟扫描本批 raw 项 —— 先预取库里没有的被引消息，再给仍拿不到的补占位。
 *
 * @param {object} p
 * @param {Array}  p.items            原始入站项（OneBot 事件形状：message 段数组或 CQ 串）
 * @param {string} p.chatKey
 * @param {string} [p.selfId]         机器人自己的 id（判"被引的是不是机器人自己"）
 * @param {(mid:string)=>boolean} [p.storeHas]   库里有没有这条（读失败应当 false）
 * @param {(mid:string)=>Promise<any>} [p.fetchViaProtocol] 协议端回读（返回原始数据；可抛可挂）
 * @param {number} [p.timeoutMs]      协议端回读超时（默认 8s；到点算没取到）
 * @param {(name:string, fields:object)=>void} [p.log]
 * @returns {Promise<{fallback:Map, marked:number, fetched:string[], misses:string[]}>}
 */
export async function prefetchQuoteFallback({
  items = [], chatKey = '', selfId = '', storeHas = null, fetchViaProtocol = null,
  timeoutMs = QUOTE_FALLBACK_TIMEOUT_MS, signal: parentSignal = null, log = null
} = {}) {
  const fallback = new Map();          // quoteKey → normalizeQuoteInfo 形状
  const fetched = [];
  const misses = [];
  const list = Array.isArray(items) ? items : [];
  const requestedBudget = Number(timeoutMs);
  const batchBudgetMs = Number.isFinite(requestedBudget) && requestedBudget > 0
    ? Math.min(QUOTE_FALLBACK_TIMEOUT_MS, Math.floor(requestedBudget)) : QUOTE_FALLBACK_TIMEOUT_MS;
  const deadline = Date.now() + batchBudgetMs;
  const batchController = new AbortController();
  const batchSignal = batchController.signal;
  let abortWake = null;
  const abortPromise = new Promise((resolve) => { abortWake = resolve; });
  const onBatchAbort = () => abortWake?.();
  batchSignal.addEventListener('abort', onBatchAbort, { once: true });
  const onParentAbort = () => batchController.abort(parentSignal?.reason ?? new Error('引用补取已取消'));
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener?.('abort', onParentAbort, { once: true });
  const deadlineTimer = setTimeout(() => batchController.abort(new Error('引用补取整批截止')), batchBudgetMs);
  deadlineTimer.unref?.();

  try {
    const uniqueIds = [];
    const seenIds = new Set();
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      for (const id of replyIdsOf(item)) {
        if (seenIds.has(id)) continue;
        seenIds.add(id); // 先登记；同批失败也不重复打协议端
        let archived = false;
        try { archived = typeof storeHas === 'function' && Boolean(storeHas(id)); } catch { /* 读失败当作未存档 */ }
        if (archived) continue;
        if (typeof fetchViaProtocol !== 'function' || uniqueIds.length >= QUOTE_FALLBACK_MAX_UNIQUE) {
          misses.push(id);
          continue;
        }
        uniqueIds.push(id);
      }
    }

    // 抓回来的原始数据留着：二阶引用（引用的引用）要拿它重渲染正文。
    const raw = new Map();               // mid → 协议端原始数据

    const runBatch = async (ids) => {
      let cursor = 0;
      const fetchOne = async (id) => {
        if (batchSignal.aborted) return;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) { batchController.abort(new Error('引用补取整批截止')); return; }
        try {
          const data = await fetchViaProtocol(id, { signal: batchSignal, timeoutMs: remainingMs });
          // 不处理截止/取消后晚到的响应，避免 fallback 与上层缓存写入过期结果。
          if (batchSignal.aborted || Date.now() >= deadline) return;
          const info = data === null ? null : quoteInfoFromProtocol(data, id, { selfId });
          if (info) { raw.set(id, data); fetched.push(id); }
          else {
            misses.push(id);
            log?.('quote-fallback-empty', { chatKey, replyTo: id });
          }
        } catch (error) {
          if (batchSignal.aborted || Date.now() >= deadline) return;
          misses.push(id);
          log?.('quote-fallback-failed', { chatKey, replyTo: id, reason: String(error?.message ?? error).slice(0, 120) });
        }
        // 失败不写负面缓存：同批去重，下一批仍可重试。
      };
      const worker = async () => {
        while (!batchSignal.aborted) {
          const index = cursor++;
          if (index >= ids.length) return;
          await fetchOne(ids[index]);
        }
      };
      const workers = Array.from(
        { length: Math.min(QUOTE_FALLBACK_CONCURRENCY, ids.length) },
        () => worker()
      );
      await Promise.race([Promise.all(workers), abortPromise]);
    };

    await runBatch(uniqueIds);
    // 没启动或已被整批截止的目标仍需显示为未取得；每个 ID 至多出现一次。
    const accounted = new Set([...fetched, ...misses]);
    for (const id of uniqueIds) if (!accounted.has(id)) misses.push(id);

    // ── ★ 2026-10-28（她：「看不到引用的引用」）────────────────────────────
    //   被引的那条本身又是一条引用时，协议端只回 reply 段的 id ⇒ 正文里只剩一个占位符，
    //   "引用里的引用"永远读不到（旧实现连占位都没有，直接落成英文的 `[reply]`）。
    //   这里再补一层：深度 1、封顶 QUOTE_NESTED_MAX 条，和第一趟共用同一个截止时间。
    const nestedIds = [];
    if (raw.size && !batchSignal.aborted) {
      for (const [mid, data] of raw) {
        if (nestedIds.length >= QUOTE_NESTED_MAX) break;
        const info = quoteInfoFromProtocol(data, mid, { selfId });
        for (const nid of info?.nestedIds ?? []) {
          if (nestedIds.length >= QUOTE_NESTED_MAX) break;
          if (raw.has(nid) || nestedIds.includes(nid)) continue;
          nestedIds.push(nid);
        }
      }
      if (nestedIds.length) await runBatch(nestedIds);
    }

    // 统一重渲染：二阶原文内联进一阶的正文；二阶自己也拿不到就落占位（不假装读到）。
    const nestedText = new Map();
    for (const [mid, data] of raw) {
      const plain = quoteInfoFromProtocol(data, mid, { selfId });
      if (!plain) continue;
      nestedText.set(mid, `${plain.sender ? plain.sender + '：' : ''}${plain.text}`);
    }
    for (const [mid, data] of raw) {
      const info = quoteInfoFromProtocol(data, mid, { selfId, nested: nestedText });
      if (info) fallback.set(quoteKey(chatKey, mid), info);
    }
  } finally {
    clearTimeout(deadlineTimer);
    batchSignal.removeEventListener('abort', onBatchAbort);
    parentSignal?.removeEventListener?.('abort', onParentAbort);
  }

  let marked = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.message) || Array.isArray(item.segments)) {
      if (markUnresolvedReply(item, { chatKey, fallback, storeHas })) marked += 1;
    } else if (typeof item.message === 'string') {
      if (markUnresolvedReplyInString(item, { chatKey, fallback, storeHas })) marked += 1;
    }
  }
  return { fallback, marked, fetched, misses };
}
