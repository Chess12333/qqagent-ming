// 单轮决策与执行追踪。搬 `src/turn-trace.js`（行为不改），两处适配：
//   1. 不再绑 session 对象 —— trace 自己是一个独立对象，由调用方持有；
//   2. 所有落盘字段过 ASCII 闸（原来的 boundedText 允许中文，因为 trace 挂在
//      session 上不落盘；refactor 里 trace 会进 spans 流，必须硬约束）。
//
// 原口径保留：只保存路径、耗时、结果类别与发送回执计数；**不复制聊天正文、
// 提示词、工具参数或工具结果**。

import { safeId, safeCount, safeEnum, safeBool, noteEnumDrop } from './sanitize.js';

const MAX_STAGES = 80;
const MAX_ACTIONS = 100;
const MAX_META_FETCHES = 4;
const MAX_META_FALLBACKS = 4;

const LANES = new Set(['addressed', 'topic_follow', 'free_interjection', 'proactive', 'scheduled', 'ambient']);
const STAGE_STATUSES = new Set(['ok', 'error', 'skipped', 'timeout', 'unknown']);
const MODEL_META_REASONS = new Set(['image_rejected', 'http400_param_strip', 'plugin_advisor']);
const MODEL_META_STRIPPED = new Set(['thinking', 'cache_control']);

/**
 * ★ N45（qwen2）导出理由：这 4 张表原来是文件私有的 ⇒ `enum-gate.mjs` 的覆盖表
 *   拿不到它们，"每个白名单都必须被闸门覆盖"这条断言就有 4 个盲区。
 * 导出的是同一批 Set 引用（不是副本），闸门读到的与运行时用的**不可能漂移**。
 */
export const TRACE_ENUMS = Object.freeze({
  'trace.lane': { allowed: LANES, fallback: 'ambient' },
  'trace.status': { allowed: STAGE_STATUSES, fallback: 'unknown' },
  'trace.modelMetaReason': { allowed: MODEL_META_REASONS, fallback: null },
  'trace.modelMetaStripped': { allowed: MODEL_META_STRIPPED, fallback: null }
});

function finiteInt(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function optionalInt(value, fallback = null) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return fallback;
  return finiteInt(value, fallback);
}

/** H1 aggregate evidence only: never retain prompt text, source IDs or authors. */
export function summarizePromptStructure(messages, history = {}) {
  const out = {
    systemEntries: 0, userEntries: 0, assistantEntries: 0,
    viewSystem: 0, viewUser: 0, viewTotal: 0, promptChars: 0
  };
  for (const message of messages || []) {
    const text = typeof message?.content === 'string' ? message.content
      : (Array.isArray(message?.content) ? message.content : [])
        .filter((part) => part?.type === 'text').map((part) => String(part.text || '')).join('');
    const views = text.split('\n').filter((line) => line.startsWith('【对话视角】')).length;
    out.promptChars += text.length;                     // 只留长度，不留内容
    out.viewTotal += views;
    if (message?.role === 'system') { out.systemEntries += 1; out.viewSystem += views; }
    if (message?.role === 'user') { out.userEntries += 1; out.viewUser += views; }
    if (message?.role === 'assistant') out.assistantEntries += 1;
  }
  for (const key of ['pastCount', 'coldCount', 'warmCount', 'droppedCount', 'mediaDroppedCount',
    'emptyStyleDroppedCount', 'selfHistoryCount', 'peerHistoryCount', 'selfHistoryUserCount',
    'triggerSelfCount', 'renderVersion']) {
    out[key] = Math.max(0, optionalInt(history[key], 0));
  }
  out.legacyCacheRejected = history.legacyCacheRejected === true;
  out.cachedTextReused = history.cachedTextReused === true;
  return out;
}

/** 轮次泳道判定（原样搬：泳道只表达"这轮凭什么开口"，与是否真说无关）。 */
export function classifyTurnLane({ proactive = false, proactiveReason = '', tierInfo = null, directAddress = false } = {}) {
  if (proactive) {
    return proactiveReason === 'schedule'
      ? { lane: 'scheduled', source: 'schedule' }
      : { lane: 'proactive', source: 'proactive_opportunity' };
  }
  if (tierInfo?.routeLane && tierInfo?.routeSource) return { lane: tierInfo.routeLane, source: tierInfo.routeSource };
  if (tierInfo?.topicFollow === true) return { lane: 'topic_follow', source: 'topic_continuity' };
  if (tierInfo?.replyMode === 'interject' || tierInfo?.jevInterject === true || Number(tierInfo?.tier) === 3) {
    return { lane: 'free_interjection', source: tierInfo?.jevInterject === true ? 'jev_gate' : 'probability_gate' };
  }
  if (Number(tierInfo?.tier) === 1) return { lane: 'addressed', source: 'direct_address' };
  if (Number(tierInfo?.tier) === 2) return { lane: 'addressed', source: 'keyword' };
  if (directAddress) return { lane: 'addressed', source: 'direct_address' };
  if (Number(tierInfo?.tier) === 4) return { lane: 'ambient', source: 'all_messages_policy' };
  return { lane: 'ambient', source: 'fallback' };
}

export function createTurnTrace({ lane = 'ambient', source = 'fallback', contextTier = null, batchId = null, authority = null, startedAt = Date.now() } = {}) {
  const start = finiteInt(startedAt, Date.now());
  return {
    version: 2,
    lane: safeEnum(lane, LANES, 'ambient', 'trace.lane'),
    source: safeId(source, 48, 'fallback'),
    contextTier: finiteInt(contextTier),
    batchId: batchId == null ? null : safeId(batchId, 160, ''),
    authority: authority == null ? null : safeId(authority, 24, ''),
    startedAt: start,
    endedAt: null,
    durationMs: null,
    outcome: null,
    stages: [],
    actions: [],
    receipt: null
  };
}

export function startTurnStage(trace, name, { round = null, attempt = null, startedAt = Date.now() } = {}) {
  if (!trace) return null;
  return {
    name: safeId(name, 32, ''),
    startedAt: finiteInt(startedAt, Date.now()),
    round: finiteInt(round),
    attempt: optionalInt(attempt)
  };
}

/** 把 llm.js 传来的观测元数据收敛成固定形状（只留毫秒/状态码/枚举，防脏数据与膨胀）。 */
function sanitizeModelMeta(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const out = {};
  // 耗时是可选值：没收到响应头时上游传 null，必须保留"无数据"语义，
  // 不能被落成假的 0ms —— 无真实值就不写字段。
  const headersMs = optionalInt(meta.responseHeadersMs);
  if (headersMs != null) out.responseHeadersMs = headersMs;
  if (Array.isArray(meta.fetches)) {
    const fetches = meta.fetches.slice(0, MAX_META_FETCHES).map((f) => {
      const ms = optionalInt(f?.responseHeadersMs ?? f?.headersMs);
      if (ms == null) return null;                     // 没有真实耗时的条目直接丢弃
      return { responseHeadersMs: ms, status: finiteInt(f?.status) ?? 0 };
    }).filter(Boolean);
    if (fetches.length) out.fetches = fetches;
  }
  if (Array.isArray(meta.fallbacks)) {
    const fallbacks = meta.fallbacks.slice(0, MAX_META_FALLBACKS).map((f) => {
      const reason = safeId(f?.reason, 32, '');
      if (!MODEL_META_REASONS.has(reason)) { noteEnumDrop('trace.modelMetaReason', reason); return null; } // 非枚举 reason：整条丢弃（丢弃也记账，见 sanitize.js N45 段）
      const entry = { reason, status: finiteInt(f?.status) ?? 0 };
      if (Array.isArray(f?.stripped)) {
        const stripped = f.stripped.filter((s) => {
          if (MODEL_META_STRIPPED.has(s)) return true;
          noteEnumDrop('trace.modelMetaStripped', s);
          return false;
        }).slice(0, 4).map((s) => safeId(s, 24, ''));
        if (stripped.length) entry.stripped = stripped;
      }
      return entry;
    }).filter(Boolean);
    if (fallbacks.length) out.fallbacks = fallbacks;
  }
  return Object.keys(out).length ? out : null;
}

export function finishTurnStage(trace, token, { status = 'ok', code = '', meta = null } = {}) {
  if (!trace || !token) return null;
  const endedAt = Date.now();
  const extra = sanitizeModelMeta(meta);
  trace.stages.push({
    name: token.name,
    startedAt: token.startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - token.startedAt),
    status: safeEnum(status, STAGE_STATUSES, 'unknown', 'trace.stageStatus'),
    code: safeId(code, 48, ''),
    ...(token.round == null ? {} : { round: token.round }),
    ...(token.attempt == null ? {} : { attempt: token.attempt }),
    ...(extra || {})
  });
  if (trace.stages.length > MAX_STAGES) trace.stages.splice(0, trace.stages.length - MAX_STAGES);
  return trace.stages[trace.stages.length - 1];
}

export function recordTurnAction(trace, { tool = '', callId = '', round = null, startedAt = Date.now(), endedAt = Date.now(), outcome = 'ok', errorType = '' } = {}) {
  if (!trace) return null;
  const start = finiteInt(startedAt, Date.now());
  const end = Math.max(start, finiteInt(endedAt, Date.now()));
  trace.actions.push({
    tool: safeId(tool, 64, ''),
    callId: safeId(callId, 80, ''),
    round: finiteInt(round),
    startedAt: start,
    endedAt: end,
    durationMs: end - start,
    outcome: safeEnum(outcome, STAGE_STATUSES, 'unknown', 'trace.actionOutcome'),
    ...(errorType ? { errorType: safeId(errorType, 48, '') } : {})
  });
  if (trace.actions.length > MAX_ACTIONS) trace.actions.splice(0, trace.actions.length - MAX_ACTIONS);
  return trace.actions[trace.actions.length - 1];
}

export function finishTurnTrace(trace, outcome) {
  if (!trace || trace.endedAt) return trace || null;
  const endedAt = Date.now();
  trace.endedAt = endedAt;
  trace.durationMs = Math.max(0, endedAt - Number(trace.startedAt || endedAt));
  trace.outcome = safeEnum(outcome, STAGE_STATUSES, 'unknown', 'trace.outcome');
  return trace;
}

/**
 * 只读复盘：Jev 观测行按 traceId（= trace.batchId）与 trace 对齐，得出
 * 「各判定状态下这一批到底发没发」的矩阵。
 * ⚠️ **口径是批次级**，不是轮次级 —— `scope` 字段把这个口径写死在返回值里。
 * 纯函数：不碰文件系统。
 */
export function buildOutcomeMatrix({ rows = [], traces = [] } = {}) {
  const byBatch = new Map();
  for (const trace of traces) {
    const batchId = trace?.batchId == null ? null : String(trace.batchId);
    if (!batchId) continue;
    const sent = Math.max(0, Math.round(Number(trace?.sentCount) || 0));
    const hit = byBatch.get(batchId);
    if (!hit) byBatch.set(batchId, { sessions: 1, maxSent: sent });
    else { hit.sessions += 1; if (sent > hit.maxSent) hit.maxSent = sent; }
  }
  const coverage = {
    rowsTotal: 0, rowsWithTraceId: 0, rowsWithoutTraceId: 0, rowsTraceIdAtLimit: 0,
    joined: 0, unmatched: 0, duplicateBatchIds: 0, tracesWithoutBatchId: 0
  };
  for (const trace of traces) if (trace?.batchId == null) coverage.tracesWithoutBatchId += 1;
  for (const hit of byBatch.values()) if (hit.sessions > 1) coverage.duplicateBatchIds += 1;

  const matrix = {};
  for (const row of rows) {
    coverage.rowsTotal += 1;
    const traceId = Object.hasOwn(row || {}, 'traceId') ? String(row.traceId ?? '') : '';
    if (!traceId) { coverage.rowsWithoutTraceId += 1; continue; }
    coverage.rowsWithTraceId += 1;
    if (traceId.length >= 160) coverage.rowsTraceIdAtLimit += 1;
    const status = String(row?.status || 'unknown');
    const bucket = matrix[status] || (matrix[status] = { rows: 0, joined: 0, spokeYes: 0, spokeNo: 0, unmatched: 0 });
    bucket.rows += 1;
    const hit = byBatch.get(traceId);
    if (!hit) { bucket.unmatched += 1; coverage.unmatched += 1; continue; }
    bucket.joined += 1;
    coverage.joined += 1;
    if (hit.maxSent > 0) bucket.spokeYes += 1; else bucket.spokeNo += 1;
  }
  return { scope: 'batch-level', matrix, coverage };
}

/** 发送回执计数（§0 铁律 6：判定以平台回执为准，所以回执数必须能被查到）。 */
export function receiptCount(sent) {
  const list = Array.isArray(sent) ? sent : [];
  return {
    sentCount: list.length,
    types: [...new Set(list.map((item) => safeId(item?.type, 16, 'unknown') || 'unknown'))].sort()
  };
}

/** trace 自身的可落盘投影（同样过 ASCII 闸）。 */
export function traceSummary(trace) {
  if (!trace) return null;
  return {
    lane: safeEnum(trace.lane, LANES, 'ambient', 'trace.lane'),
    source: safeId(trace.source, 48, 'fallback'),
    batchId: safeId(trace.batchId, 160, '') || null,
    durationMs: safeCount(trace.durationMs, 86_400_000, 0),
    stageCount: trace.stages?.length ?? 0,
    actionCount: trace.actions?.length ?? 0,
    outcome: safeEnum(trace.outcome, STAGE_STATUSES, 'unknown', 'trace.outcome'),
    ok: safeBool(trace.outcome === 'ok')
  };
}