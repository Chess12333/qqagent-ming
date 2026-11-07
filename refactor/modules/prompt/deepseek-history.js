/**
 * modules/prompt/deepseek-history.js — 洛版 0.4.8「历史窗口锚定」纯算法移植
 * （**只有 deepseek 缓存策略走这条分支**；其它厂商保持既有行为。）
 *
 * ── 它解决什么 ─────────────────────────────────────────────────────────────
 * 历史块按"最近 N 条"取时，每来一条新消息窗口起点就前移一条 ⇒ 渲染出来的历史块**第一行就变**
 * ⇒ 这一段永远命中不了前缀缓存。洛版把窗口**起点**对齐到本地消息 id 的 chunk 整数倍上：
 * 块内新消息只是尾部追加，历史块的公共前缀 = 上一轮的整块历史
 * （发行包 `src/prompt.js:647-813`，本次已逐行核对）。
 *
 * ── 核心公式（相对**最新一条**算，不相对取回段头算）──────────────────────────
 *   anchor = floor((newestLocalId − limit) / chunk) * chunk
 *   window = (anchor, newestLocalId]，长度落在 [limit, limit + chunk − 1]
 * 下界 = 原有可见历史条数（**不减少**）；上界 = 最多多看 limit+chunk−1 条（由调用方既有权限/预算约束）。
 * 锚点相对最新一条 ⇒ 只在 (newest − limit) 跨过 chunk 整数倍时**周期性**前移，块内完全不动。
 *
 * ── 本模块的边界（重要）────────────────────────────────────────────────────
 *   · **纯函数、无 IO**：不访问 store/data/网络，不 import 其它模块；**不修改传入对象**（只新建数组）。
 *   · **输入必须是已完成过滤、按时间升序的消息**（权限/撤回/点名遗忘/persona/屏蔽都由调用方在之前做完）。
 *     本模块**不复活**任何被过滤的消息，也不知道它们的存在。
 *   · `limit` = 原本要给**用户看的可见历史容量**。锚定段短于 limit 时，本模块退回**原滑窗**
 *     （正好 limit 条）并显式 `degraded + reason`，把"少看几条"的取舍交回调用方；
 *     多出来的历史行由调用方按既有权限与预算处理。
 *   · **不重编号、不改真实消息 id**。没有本地 id / id 空洞过大 / 非法 limit / 空输入
 *     一律 `anchored:false`（`degraded` + `reason` 说清），绝不假报锚定成功。
 *   · 自身有界：最多多看 `chunk − 1 ≤ maxChunk − 1` 行，不会无限扩张。
 *
 * ── 默认 id 口径 ───────────────────────────────────────────────────────────
 * 新树 ChatStore 行用**本地自增 id**（compose 既有锚定就是 `Number(row.id)`，`publicHistoryRow` 原样保留它）；
 * 若某行只带 `localId`，默认口径优先用它。**绝不**拿平台消息 id（`mid` / `messageId`）猜本地序号。
 * 调用方也可以传 `idOf(row)` 给出自己的真实本地 id 口径（例如已做投影的行）。
 *
 * ── 与洛版的差异（改了哪一条、为什么）──────────────────────────────────────
 * 洛版在 `kept.length < limit` 但非空时**直接保留少量**（宁可少看几条也不断缓存，`prompt.js:770-776`）。
 * 本仓要求"已有足够合格输入时不能为了缓存少给历史" ⇒ 这里改为**退回原滑窗数量** + `degraded`
 * （`reason:'anchored-window-shorter-than-limit'`），把取舍显式交还调用方。
 *
 * ── 与新树既有链路的接入（由 ds2/ds3 在各自文件里做；本模块不碰接入文件）─────
 *   · ds3（compose 预取 / 策略桥）：`deepseekHistoryFetchLimit(limit, { excludeCount })` 决定多读多少行；
 *     读到的行必须**先做完所有过滤**再交给 `selectDeepseekAnchoredHistory`；`excludeCount` 传被排除的条数
 *     （触发批/本轮证据等，它们的 headroom 已经算在 fetch 里）。
 *   · ds2（prompt 渲染）：仅在**有效策略 id === 'deepseek'** 时走本模块；`buildMessages` 的
 *     `cacheStrategy` / `stablePrefixSections`（`[{name,text}]`）约定不变。
 *   · **不要截两次、也不要把 headroom 吃掉**：新树既有的"最多多读 12 行"头对齐
 *     （`compose.js` 的 `anchorHistoryWindow` + `PAST_CHAT_ANCHOR_MAX_EXTRA`）与本模块是**同一位置的
 *     两种方案** —— 同一轮只能有一条生效（否则窗口头被两套对齐规则来回搬，反而更不稳）；
 *     本模块给到调用方的 `messages` 已经是最终窗口，**不要再按 12 行口径二次裁剪**。
 *   · 冷暖检查点链（`splitHistoryColdForPrompt` / history-cut）只负责"冷段/热段分界"，不参与起点对齐；
 *     本模块的输出可以直接作为它的输入（条数变多时冷段自然变长，走它既有的预算与失效规则）。
 */

/** 移植默认值：系数 2.4、chunk 4..192（发行包 `src/prompt.js:700-712`）。 */
export const DS_ANCHOR_DEFAULTS = Object.freeze({ ratio: 2.4, minChunk: 4, maxChunk: 192 });

/** DS 第一批缓存调整：预取和渲染必须使用同一份会话级块参数。其它策略保持原值。 */
export function deepseekHistoryOptionsFor({ strategy = '', cfg = null, chatKey = '', kind = 'group' } = {}) {
  if (strategy !== 'deepseek') return {};
  let value;
  try {
    const effective = cfg?.effective?.('store.deepseekAnchorMinChunk', { chatKey, kind });
    value = effective && typeof effective === 'object' ? effective.value : effective;
    if (value === undefined) {
      const store = cfg?.get?.('store', {}) || {};
      value = store.perChat?.[chatKey]?.deepseekAnchorMinChunk
        ?? (kind === 'private' && store.privateOverride ? store.private?.deepseekAnchorMinChunk : undefined)
        ?? store.deepseekAnchorMinChunk;
    }
  } catch { /* 配置访问失败时采用有界默认值。 */ }
  const n = Number(value);
  return { minChunk: Number.isInteger(n) && n >= 4 && n <= 192 ? n : 77 };
}

function finitePositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function pickBounds({ ratio = DS_ANCHOR_DEFAULTS.ratio, minChunk = DS_ANCHOR_DEFAULTS.minChunk, maxChunk = DS_ANCHOR_DEFAULTS.maxChunk } = {}) {
  const r = Number(ratio) > 0 ? Number(ratio) : DS_ANCHOR_DEFAULTS.ratio;
  const lo = finitePositiveInt(minChunk) ?? DS_ANCHOR_DEFAULTS.minChunk;
  const hiRaw = finitePositiveInt(maxChunk) ?? DS_ANCHOR_DEFAULTS.maxChunk;
  return { ratio: r, minChunk: lo, maxChunk: Math.max(lo, hiRaw) };
}

/**
 * 窗口锚定的 chunk（块大小）。`limit` 非法/≤0 时按 1 处理（与本仓既有的"最小 1 条"口径一致）。
 * 例：limit=80 ⇒ round(80×2.4)=192（触上限）；15 ⇒ 36；8 ⇒ 19。
 */
export function deepseekAnchorChunkFor(limit, opts = {}) {
  const { ratio, minChunk, maxChunk } = pickBounds(opts);
  const n = finitePositiveInt(limit) ?? 1;
  return Math.min(maxChunk, Math.max(minChunk, Math.round(n * ratio)));
}

/**
 * 为了"锚定后仍不短于 limit"，存储层应该**最多**取回多少行。
 *   = limit + chunk + excludeCount（洛版原文：`store.recent(limit = maxLimit + chunk + exclude.size)`）
 *   · 多取一个 chunk：锚点落在取回段内时，仍保证 (anchor, newest] ≥ limit 行；
 *   · `excludeCount`：调用方额外排除的条数（触发批/证据等），保证剔除后仍够；
 *   · 有界：额外部分 ≤ maxChunk（默认 192）+ excludeCount；`limit` 非法/≤0 ⇒ 返回 0（调用方据此跳过本策略）。
 */
export function deepseekHistoryFetchLimit(limit, { excludeCount = 0, ...opts } = {}) {
  const safeLimit = finitePositiveInt(limit);
  if (safeLimit === null) return 0;
  const chunk = deepseekAnchorChunkFor(safeLimit, opts);
  const extra = finitePositiveInt(excludeCount) ?? 0;
  return safeLimit + chunk + extra;
}

function defaultIdOf(row) {
  // 本地口径：优先 localId（若存在），否则 id；**绝不**读 mid/messageId。
  const local = row?.localId;
  if (local !== null && local !== undefined && local !== '') return Number(local);
  return Number(row?.id);
}

/**
 * 在**已过滤、升序**的消息里选出锚定窗口。
 *
 * @param {Array} messages 已按时间升序、已完成全部过滤的历史行（本函数不修改它们，也不复活任何行）
 * @param {{limit:number, chunk?:number|null, idOf?:Function|null}} opts
 *   · `limit`  原本要给用户看的可见历史容量（必填；非法 ⇒ 不锚定、message 原样返回）
 *   · `chunk`  显式块大小（不给则按 limit 缩放：`deepseekAnchorChunkFor`）
 *   · `idOf`   调用方自己的本地 id 口径（不给则 `localId ?? id`）
 * @returns {{messages:Array, chunk:number|null, anchor:number|null, anchored:boolean, degraded:boolean,
 *   reason:string, inputCount:number, visibleCount:number, keptCount:number, droppedCount:number,
 *   newestLocalId:number|null}}
 *   · `anchored:true` 只在"窗口已被锚点裁过、且可见条数 ≥ limit"时给出；
 *   · 其它情况 `degraded:true` + `reason`（`empty-input` / `invalid-limit` / `no-local-id` /
 *     `anchored-window-shorter-than-limit` / `no-rows-above-anchor` / `all-rows-above-anchor`）；
 *   · 所有计数都是纯数字（无正文、无平台 id、无 QQ 号）。
 */
export function selectDeepseekAnchoredHistory(messages, { limit, chunk = null, idOf = null } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const chunkInt = finitePositiveInt(chunk) ?? deepseekAnchorChunkFor(limit);
  const base = {
    messages: list.slice(),
    chunk: chunkInt,
    anchor: null,
    anchored: false,
    degraded: false,
    reason: '',
    inputCount: list.length,
    visibleCount: list.length,
    keptCount: 0,
    droppedCount: 0,
    newestLocalId: null
  };
  if (!list.length) return { ...base, degraded: true, reason: 'empty-input' };
  const limitInt = finitePositiveInt(limit);
  if (limitInt === null) return { ...base, degraded: true, reason: 'invalid-limit' };

  const idOfFn = typeof idOf === 'function' ? idOf : defaultIdOf;
  let ids;
  try { ids = list.map((row) => idOfFn(row)); }
  catch { return { ...base, degraded: true, reason: 'id-of-threw' }; }
  const newestId = Number(ids[ids.length - 1]);
  if (!Number.isFinite(newestId) || newestId <= 0) {
    return { ...base, degraded: true, reason: 'no-local-id' };
  }

  const anchor = Math.floor((newestId - limitInt) / chunkInt) * chunkInt;
  const kept = list.filter((_, index) => Number(ids[index]) > anchor);
  const counts = {
    inputCount: list.length,
    keptCount: kept.length,
    droppedCount: list.length - kept.length,
    newestLocalId: newestId
  };

  // 正常锚定：裁过、且可见条数不少于 limit（多出来的 headroom 交给调用方按预算处理）。
  if (kept.length >= limitInt && kept.length < list.length) {
    return { ...base, ...counts, messages: kept, anchor, anchored: true, visibleCount: kept.length };
  }
  // 锚定段比 limit 短 ⇒ 按本仓纪律"不少给"：退回原滑窗（正好 limit 条），显式降级说明。
  if (kept.length < limitInt) {
    const window = list.slice(-limitInt);
    return {
      ...base, ...counts,
      messages: window,
      anchor,
      anchored: false,
      degraded: true,
      reason: kept.length > 0 ? 'anchored-window-shorter-than-limit' : 'no-rows-above-anchor',
      visibleCount: window.length
    };
  }
  // kept === list（取回段整体都在锚点之上）：取回没够到锚点 ⇒ 头仍会滑，不能假报锚定成功。
  return { ...base, ...counts, anchor, anchored: false, degraded: true, reason: 'all-rows-above-anchor' };
}
