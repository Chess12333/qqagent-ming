/** M15 runtime: batching, serialization, run lifecycle and the A→F call order. */
import { validateSendReceipt, validateMessageEvidence, TOOL_REJECT_REASONS } from '../../contracts/index.js';
import { allowGate } from '../../core/policy/allow-gate.js';
import { classifyTurnLane } from '../../core/observability/index.js';
import { looksLikeNarration, splitInnerVoice, isMeaningfulThoughtText } from '../act/inner-voice.js';
// N-QUOTE-FALLBACK：引用兜底（库里没有的被引消息走 get_msg 回读 + [引用消息] 占位）。
// 纯逻辑住在 M5（scenario/quote-fallback.js，零 import、IO 全注入）⇒ 可单测；
// 这里只做接线：注入库查询 / 协议端 get_msg / 日志。
import { prefetchQuoteFallback, quoteKey, QUOTE_FALLBACK_TIMEOUT_MS } from '../scenario/index.js';
import { composeReply } from './compose.js';
import { readMemory, normalizeRef } from '../memory/index.js';
// ★ 2026-10-15（用户裁定 · 情绪缺口第一组）：入站情绪 cue 的可解释识别 + 指向性过滤 + 同 kind 冷却。
//   纯函数从 M7 的公开出口引入（不带状态；applyEvent 仍走注入的 modules.emotion 门面）。
import { recognizeInboundCue, inboundCueDeltas, createFallbackTracker, pickFallbackCue, fallbackDeltas, isAffectLedgerRow, FALLBACK_CUE_KIND } from '../emotion/index.js';
// ★ 2026-10-22：峰期 / 谷期独立回复概率（群聊），纯函数、无状态，见 modules/time-profile。
import { resolveGroupReplyPercent } from '../time-profile/index.js';

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_HISTORY_LIMIT = 80;
// `src/prompt.js:34-38 BOT_ACCOUNT_NAMES`: former bot account name + another group's display name.
const LEGACY_BOT_ACCOUNT_NAMES = Object.freeze([
  '<你的机器人显示名-1>',
  '<你的机器人显示名-2>',
  '<你的机器人显示名-3>'
]);

function clockNow(clock) {
  if (typeof clock?.now === 'function') return Number(clock.now());
  if (Number.isFinite(clock?.now)) return Number(clock.now);
  throw new Error('clock.now is required; wall-clock access is forbidden');
}

function clockElapsedNow(clock) {
  const value = typeof clock?.elapsedNow === 'function'
    ? clock.elapsedNow()
    : Number.isFinite(clock?.elapsedNow)
      ? clock.elapsedNow
      : globalThis.performance?.now?.();
  const elapsed = Number(value);
  if (!Number.isFinite(elapsed)) {
    throw new Error('clock.elapsedNow or performance.now is required; wall-clock access is forbidden');
  }
  return elapsed;
}

function emit(bus, name, payload) {
  try { bus?.emit?.(name, payload); } catch { /* observability cannot break the message path */ }
}

function log(logSink, level, message, fields = {}) {
  try {
    if (typeof logSink === 'function') logSink(level, message, fields);
    else logSink?.[level]?.(message, fields);
  } catch { /* diagnostics cannot break the runtime */ }
}

// ── S-4：会话生命周期三帧（契约单一真相源 = apps/server/sse-bridge.js 的 SESSION_FRAME_CONTRACT）──
//
// 为什么要有这三帧（主人症状：「预输出的时候没有卡出现，只有发言完后才会出现会话卡片」）：
//   UI 三个 handler 一直在（apps/ui/app.js:4692/:4696/:4733），桥也已就绪，但**服务端一帧都不发**
//   ⇒ 卡片只能等回合结束、会话文件落盘后靠列表轮询出现。
//
// 三条硬纪律：
//   ① **id 必须是真 id**：`registry.peek()` 拿不到就**不发**（UI 在 session-end 里会
//      `pendingSessionDetail.delete(id)` 再拉详情 ⇒ 假 id 会清掉别人的详情）。
//   ② **深度闸**：`turnPlan`/`turnTrace`/`messages` 只在"过得了 SSE 脱敏"时才带；超深 ⇒ **整个键不发**。
//      依据：`apps/server/sse.js:36-52 redact()` 在 `depth > MAX_DEPTH(8)` 处把值换成**字符串**
//      `'[redacted]'`，而 UI 的 session-update 是**逐字段 merge**（app.js:4702-4716）⇒ 把字符串并进
//      对象字段 = 把好数据写坏。实测（`.tmp-dispatch/_s4-redact.txt`）：盘上真形状深度 3/1/2 完好，
//      合成 depth 34 会被截断并注入 9+18 个 `'[redacted]'` ⇒ 闸是必要的。**宁可少发两个键**
//      （UI 侧 `?? null` / `|| []` 会兜底），也不许往 UI 状态里写坏值。
//   ③ **不许刷屏**：`session:updated` 按会话节流（最小间隔 `SESSION_FRAME_UPDATE_MIN_GAP_MS`）；
//      start / ended 各一发，不节流。
const SESSION_FRAME_MAX_DEPTH = 6;      // MAX_DEPTH=8 之下留两格余量（键本身占第 1 层）
const SESSION_FRAME_UPDATE_MIN_GAP_MS = 1200;
/**
 * 重复被拦熔断阈值（两处判定共用：进入工具轮之前 :1010、act 回来之后 :1136）。
 * ★ 导出给 selftest 引用 —— 用例抄数字（旧写法 `repeatBlocks: 3`）就是今晚「陈旧断言」那个病：
 *   谁改了阈值，用例不会红，只会跟着一起错。
 */
export const REPEAT_BLOCK_CIRCUIT_LIMIT = 3;
/** 会话帧的"上次 updated"时刻（只节流 updated；ended 时清掉）。 */
const lastFrameEmitAt = new Map();

function frameDepth(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return depth;
  if (seen.has(value)) return depth;      // 环形引用不许把主链挂死
  seen.add(value);
  let max = depth;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const d = frameDepth(child, depth + 1, seen);
    if (d > max) max = d;
    if (max >= SESSION_FRAME_MAX_DEPTH + 1) break;   // 超闸就别再数了
  }
  return max;
}

/** 按契约拼一帧载荷；没有真会话 ⇒ null（调用方据此不发）。 */
function sessionFramePayload(run, { closing = false } = {}) {
  const registry = run?.sessionRegistry;
  const id = String(run?.sessionId ?? '');
  if (!registry || !id) return null;
  let s = null;
  try { s = registry.peek?.(id) ?? null; } catch { s = null; }
  // ★ 收尾帧要的是**写盘之后**的状态，而 `finish()` 会把会话从内存表里摘掉
  //   （modules/sessions/index.js:946 current.delete(sid)）⇒ peek 必然落空。
  //   这时退回 `get()`：**读刚写下去的那份文件**（多一次读，换来"帧里的状态 = 盘上的最终态"）。
  if (!s && closing) { try { s = registry.get?.(id) ?? null; } catch { s = null; } }
  if (!s) return null;
  const payload = {
    sessionId: id, chatKey: s.chatKey ?? '', status: s.status ?? '',
    waitUntil: s.waitUntil ?? null, activity: s.activity ?? '',
    webSearchCount: s.webSearchCount ?? 0, rounds: s.rounds ?? 0,
    usage: s.usage ?? null, triggerSummary: s.triggerSummary ?? '',
    startedAt: s.startedAt ?? 0, trigger: s.triggerSummary ?? ''
  };
  for (const key of ['turnPlan', 'turnTrace', 'messages']) {
    const value = s[key];
    if (value == null) continue;                       // 没有就不给（不许编）
    const d = frameDepth(value);
    if (d <= SESSION_FRAME_MAX_DEPTH) payload[key] = value;
    else log(run.log, 'warn', 'session-frame-depth-skipped', {
      chatKey: run.chatKey, roundId: run.roundId, key, depth: d, max: SESSION_FRAME_MAX_DEPTH
    });
  }
  for (const key of ['innerVoice', 'unsentThought']) {
    if (typeof s[key] === 'string' && s[key]) payload[key] = s[key];
  }
  // 收尾四键：**只在真有值时带上**（UI app.js:4719-4722 只认 patch；无脑写 null 会冲掉已有值）
  if (closing) {
    if (Array.isArray(s.sent)) payload.sent = s.sent;
    if (s.finishReason != null) payload.finishReason = s.finishReason;
    if (s.error != null) payload.error = s.error;
    if (s.endedAt != null) payload.endedAt = s.endedAt;
  }
  return payload;
}

function emitSessionFrame(run, name, { closing = false } = {}) {
  try {
    const payload = sessionFramePayload(run, { closing });
    if (!payload) return false;
    const now = clockNow(run.clock);
    if (name === 'session:updated') {
      const last = Number(lastFrameEmitAt.get(payload.sessionId)) || 0;
      if (last && now - last < SESSION_FRAME_UPDATE_MIN_GAP_MS) return false;
      lastFrameEmitAt.set(payload.sessionId, now);
    } else if (name === 'session:started') {
      lastFrameEmitAt.set(payload.sessionId, now);   // 紧接着的第一条 updated 被节流掉
    } else if (name === 'session:ended') {
      lastFrameEmitAt.delete(payload.sessionId);
    }
    if (!run?.bus) return false;   // bus 没挂上就不发（不许凭空造帧）
    emit(run.bus, name, payload);
    return true;
  } catch (error) {
    log(run.log, 'warn', 'session-frame-emit-failed', {
      chatKey: run?.chatKey, roundId: run?.roundId, name, error: String(error?.message ?? error)
    });
    return false;
  }
}

function evidenceChatKey(evidence, fallback = '') {
  return String(evidence?.chatKey ?? fallback ?? '');
}

function readConfig(cfg, keyPath, fallback) {
  try {
    const value = cfg?.get?.(keyPath, fallback);
    return value === undefined || value === null ? fallback : value;
  } catch { return fallback; }
}

function platformSelfId(modules) {
  try {
    return String(modules?.platform?.selfId ?? modules?.platform?.client?.selfId ?? '').replace(/\D/g, '');
  } catch { return ''; }
}

function topicStateRecord(check, transition) {
  const topic = check?.topic;
  return {
    active: check?.active === true,
    reason: String(check?.reason ?? 'unknown'),
    transition: String(transition ?? 'unchanged'),
    topic: topic && typeof topic === 'object' ? {
      topicId: String(topic.topicId ?? ''),
      chatKey: String(topic.chatKey ?? ''),
      accountId: String(topic.accountId ?? ''),
      startedBySource: String(topic.startedBySource ?? ''),
      lastConfirmedReplyId: String(topic.lastConfirmedReplyId ?? ''),
      lastConfirmedAt: Number.isFinite(Number(topic.lastConfirmedAt)) ? Number(topic.lastConfirmedAt) : null,
      expiresAt: Number.isFinite(Number(topic.expiresAt)) ? Number(topic.expiresAt) : null,
      participants: Array.isArray(topic.participants) ? topic.participants.map(String).slice(0, 64) : [],
      ended: topic.ended && typeof topic.ended === 'object'
        ? { reason: String(topic.ended.reason ?? ''), at: Number(topic.ended.at) || 0 } : null
    } : null
  };
}

const MEMORY_PICK_REASONS = new Set([
  '最近出现过', '把握较高', '和本轮话题相关', '全局印象', '说话人本人', '按综合得分排到前面', '语义相近'
]);
const MAX_MEMORY_INJECTION_ITEMS = 32;
const MEMORY_VIEW_INTRO = '【记忆视图】以下条目都是**过去有人说过、留了出处**的印象，不是本轮的新事实；引用它们时要记得它们只是印象：';

function promptSectionAfterHeading(prompt, heading, { allowMemoryViewIntro = false, allowImpressionIntro = false } = {}) {
  const lines = String(prompt ?? '').split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    // Prompt sections append the applicable round id to their heading. Match that
    // documented suffix while keeping the section anchor specific.
    if (lines[index] !== heading && !lines[index].startsWith(`${heading}（适用轮次：`)) continue;
    const block = [lines[index]];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      if (/^【[^】\r\n]{1,80}】/u.test(line)) {
        if ((allowMemoryViewIntro && line === MEMORY_VIEW_INTRO)
          || (allowImpressionIntro && line.startsWith('【印象】'))) {
          block.push(line);
          index = next;
          continue;
        }
        break;
      }
      block.push(line);
    }
    blocks.push(block.join('\n'));
  }
  return blocks;
}

function memoryViewClaims(blocks) {
  const claims = [];
  for (const block of blocks) {
    const lines = String(block).split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const match = /^[ \t]*-[ \t]*\[证据 [^\]]+\][ \t]+（scope=.*?；置信 [^）]*）(.*)$/u.exec(line);
      if (!match) continue;
      const parts = [match[1]];
      for (let next = index + 1; next < lines.length; next += 1) {
        if (/^[ \t]*-[ \t]*\[证据 [^\]]+\]/u.test(lines[next]) || /^【[^】\r\n]{1,80}】/u.test(lines[next])) break;
        parts.push(lines[next]);
      }
      claims.push(parts.join('\n').replace(/…（已截 \d+ 字）\s*$/u, '').replace(/\s+/g, ' ').trim());
    }
  }
  return claims;
}

function impressionClaimNeedle(row) {
  const claim = String(row?.claim ?? '').replace(/\s+/g, ' ').trim();
  if (!claim) return '';
  const limit = ['preference', 'identity'].includes(String(row?.type ?? '')) || row?.pin === true ? 140 : 90;
  return claim.slice(0, limit);
}

function memoryInjectionRecord(context, finalPrompt, memoryRecall = null) {
  if (!finalPrompt || typeof finalPrompt !== 'object'
    || typeof finalPrompt.systemPrompt !== 'string' || typeof finalPrompt.userPrompt !== 'string') {
    return { state: 'unknown', selectedCount: null, items: [], truncated: null };
  }
  const prompt = `${finalPrompt.systemPrompt}\n${finalPrompt.userPrompt}`;
  const memoryHeaders = [
    '【明确更正】有证据的更正优先采用；更正只适用其来源范围。',
    '【记忆视图】过去留有出处的事实；不是本轮新事实。'
  ];
  const memoryClaims = memoryViewClaims(memoryHeaders.flatMap((heading) =>
    promptSectionAfterHeading(prompt, heading, { allowMemoryViewIntro: true })));
  const impressionBlocksWithIntro = promptSectionAfterHeading(prompt, '【记忆】', { allowImpressionIntro: true });
  const impressionText = impressionBlocksWithIntro.filter((block) => block.startsWith('【记忆】\n【印象】')).join('\n');
  const judgeRecallIds = new Set(Array.isArray(memoryRecall?.observations?.ids)
    ? memoryRecall.observations.ids.map((value) => String(value ?? '').trim()).filter(Boolean) : []);
  const rows = Array.isArray(context?.items) ? context.items
    : Array.isArray(context?.recalled) ? context.recalled : [];
  const seen = new Set();
  const selected = [];
  const consumedMemoryClaims = new Set();
  const consumedImpressionNeedles = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const evidenceIds = Array.isArray(row.evidenceIds) ? row.evidenceIds
      : Array.isArray(row.sourceIds) ? row.sourceIds : [];
    const claim = String(row.claim ?? '').replace(/\s+/g, ' ').trim();
    const memoryClaimIndex = claim
      ? memoryClaims.findIndex((visibleClaim, index) => !consumedMemoryClaims.has(index)
        && visibleClaim.length > 0 && claim.startsWith(visibleClaim))
      : -1;
    const impressionNeedle = impressionClaimNeedle(row);
    const impressionOccurrenceLimit = impressionNeedle.length > 0
      ? impressionText.split(impressionNeedle).length - 1 : 0;
    const impressionUsed = consumedImpressionNeedles.get(impressionNeedle) ?? 0;
    const impressionVisible = impressionUsed < impressionOccurrenceLimit;
    if (memoryClaimIndex < 0 && !impressionVisible) continue;
    if (memoryClaimIndex >= 0) consumedMemoryClaims.add(memoryClaimIndex);
    if (impressionVisible) consumedImpressionNeedles.set(impressionNeedle, impressionUsed + 1);
    const id = String(row.memoryId ?? row.id ?? '').trim().slice(0, 160) || null;
    const identity = id || evidenceIds.map(String).sort().join(',') || `row:${selected.length}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const reason = String(row.reason ?? '').trim();
    const source = judgeRecallIds.has(String(row.memoryId ?? row.id ?? '')) ? 'judge-memory-recall'
      : row.__crossChat === true ? 'cross-chat-memory-recall'
        : row.source === 'semantic' ? 'semantic-memory-recall' : 'context-memory-recall';
    selected.push({
      id,
      source,
      reason: MEMORY_PICK_REASONS.has(reason) ? reason : null
    });
  }
  const selectedCount = selected.length;
  return {
    state: selectedCount ? 'available' : 'empty',
    selectedCount,
    items: selected.slice(0, MAX_MEMORY_INJECTION_ITEMS),
    truncated: selectedCount > MAX_MEMORY_INJECTION_ITEMS
  };
}

function sourceEventVersion(entry, fallback = 1) {
  const value = entry?.eventVersion ?? entry?.sourceVersion ?? entry?.version ?? fallback;
  if (Number.isSafeInteger(Number(value)) && Number(value) > 0) return String(Number(value));
  const text = String(value ?? '').trim();
  return text || String(fallback);
}

function timestampOf(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Date.parse(String(value));
}

/** Route source observations and idle consolidation through the one assembled M6 coordinator. */
function createMemoryObserver({ modules, cfg, clock, logSink }) {
  const memory = modules?.memory;
  const dataDir = String(modules?.configStore?.DATA_DIR ?? process.env.QQ_AGENT_DATA_DIR ?? '').trim();
  const getAccountId = () => platformSelfId(modules);
  // Current MessageEvidence has no edit revision; its immutable source event starts at v1.
  const fallbackVersion = 1;
  const fallbackSeen = new Set();
  const fallbackCursor = new Map();
  const pendingConsolidation = new Map();
  const consolidationThreshold = 8;
  const consolidationQuietMs = 30_000;
  let consolidationPumpRunning = false;
  let lastConsolidationStatus = { queues: 0, running: 0, unconsolidated: 0, failed: 0 };
  let todosService = memory?.todos ?? modules.todos ?? modules.todoStore ?? null;
  if (!todosService && typeof memory?.createTodos === 'function' && dataDir) {
    try { todosService = memory.createTodos({ dataDir, log: logSink }); }
    catch (error) { log(logSink, 'warn', 'memory-todos-unavailable', { reason: String(error?.message ?? error).slice(0, 120) }); }
  }
  // The assembly keeps this singleton out of modules.memory on purpose because attaching it
  // changes prepareContext's data path. Observe into it explicitly and let normal recall stay M6.
  async function getCoordinator() {
    const accountId = getAccountId();
    if (accountId) {
      try { modules?.__setMemoryCoordinatorAccountId?.(accountId); }
      catch (error) {
        log(logSink, 'warn', 'memory-coordinator-account-scope-failed', {
          reason: String(error?.message ?? error).slice(0, 160)
        });
      }
    }
    return [modules?.__memoryCoordinator, memory?.coordinator]
      .find((candidate) => typeof candidate?.observe === 'function') ?? null;
  }

  async function observeWithExistingLedger({ chatKey, kind, messageRefs, evidence }) {
    if (!messageRefs.length) return { ok: true, observed: 0, queued: 0, duplicates: 0, persisted: true };
    if (typeof memory?.recordEvidence !== 'function' || !dataDir) {
      return { ok: false, observed: 0, queued: 0, duplicates: 0, persisted: false,
        reason: typeof memory?.recordEvidence !== 'function' ? 'm6-recordEvidence-unavailable' : 'dataDir-unset' };
    }
    // The current M6 evidence schema is immutable by message id and has no source-version field.
    // Keep v1 fallback honest; versioned edits must go through the N13 coordinator.
    const unsupportedVersion = messageRefs.some((ref) => ref.eventVersion !== '1');
    if (unsupportedVersion) {
      return { ok: false, observed: 0, queued: 0, duplicates: 0, persisted: false, reason: 'm6-source-version-unsupported' };
    }
    const freshRefs = messageRefs.filter((ref) => !fallbackSeen.has(`${chatKey}\u0000${ref.messageId}\u0000${ref.eventVersion}`));
    if (!freshRefs.length) {
      return { ok: true, observed: 0, queued: 0, duplicates: messageRefs.length, persisted: true,
        cursorAdvanced: false, cursorMode: 'process-local; durable source is M6 evidence ledger' };
    }
    const freshIds = new Set(freshRefs.map((ref) => ref.messageId));
    const freshEvidence = evidence.filter((row) => freshIds.has(String(row?.id ?? '')));
    const result = await memory.recordEvidence(freshEvidence, { dataDir });
    const added = Array.isArray(result?.added) ? result.added : [];
    const duplicates = Array.isArray(result?.duplicate) ? result.duplicate : [];
    const invalidIds = new Set((Array.isArray(result?.invalid) ? result.invalid : []).map((row) => String(row?.id ?? '')));
    let observed = 0;
    for (const ref of messageRefs) {
      if (invalidIds.has(ref.messageId)) continue;
      const key = `${chatKey}\u0000${ref.messageId}\u0000${ref.eventVersion}`;
      fallbackSeen.add(key);
      fallbackCursor.set(chatKey, { messageId: ref.messageId, eventVersion: ref.eventVersion });
      observed += 1;
    }
    const cursor = fallbackCursor.get(chatKey) ?? null;
    return {
      ok: result?.ok !== false && invalidIds.size === 0,
      observed,
      queued: added.length,
      duplicates: duplicates.length,
      persisted: true,
      cursorAdvanced: observed > 0,
      cursor: cursor ? { ...cursor } : null,
      cursorMode: 'process-local; durable source is M6 evidence ledger',
      reason: invalidIds.size ? 'm6-evidence-rejected' : ''
    };
  }

  async function prepareContext(input = {}) {
    const chatKey = String(input.chatKey ?? '');
    const kind = input.kind === 'private' ? 'private' : 'group';
    const now = Number.isFinite(Number(input.now)) ? Number(input.now) : clockNow(clock);
    const accountId = getAccountId();
    const startedAt = clockElapsedNow(clock);
    // ★ 2026-10-26（溟）：recentMessages 40 → 80，跟 prompt 侧 maxRecentChatMessages 一起放大，
    //   否则记忆模块读的"最近消息"比提示词里给的还少，两边各看一段历史。
    const budget = { recentMessages: 80, recalledItems: 12, episodeSummaries: 4, todos: 4, ...(input.budget || {}) };
    const recentLimitValue = Number(budget.recentMessages);
    const recentLimit = Number.isFinite(recentLimitValue) && recentLimitValue >= 0
      ? Math.floor(recentLimitValue) : 40;
    const store = memory?.store ?? null;
    const service = await getCoordinator();
    let coordinatorFailure = '';
    if (typeof service?.prepareContext === 'function') {
      try {
        const prepared = await service.prepareContext({
          accountId, chatKey, kind, subjectIds: input.subjectIds ?? [], query: input.query ?? input.topic ?? '',
          now, budget, signal: input.signal,
          // ★ 2026-10-16（用户口径 · 一次全判 / 真省输入 token）：把两个**可选**字段原样转给记忆实现
          //   （ds2 侧负责语义）——不认它们的实现逐字不变：
          //   · `deferOptionalRecall:true`：只取轻上下文（保留近期原文/工作状态/必须更正），
          //     可选召回（印象/语义卡/相关情节等）延后到判定之后按 `memoryPolicy` 决定；
          //   · `memoryPolicy:{recall,mode,reason}`：判定后的最终策略（缺失 = recall:true/mixed）。
          ...(input.deferOptionalRecall === true ? { deferOptionalRecall: true } : {}),
          ...(input.memoryPolicy && typeof input.memoryPolicy === 'object' ? { memoryPolicy: input.memoryPolicy } : {})
        });
        if (prepared && typeof prepared === 'object') return normalizeContext(prepared, input);
        coordinatorFailure = 'memory-context-coordinator-returned-no-context';
      } catch (error) {
        const reason = String(error?.message ?? error).slice(0, 160);
        coordinatorFailure = `memory-context-coordinator-failed:${reason}`;
        log(logSink, 'warn', 'memory-context-coordinator-failed', {
          chatKey, roundId: String(input.roundId ?? ''), reason
        });
      }
    } else coordinatorFailure = 'memory-context-coordinator-unavailable';

    let rows = [];
    let total = null;
    let recentStatus = typeof store?.recent === 'function' ? 'empty' : 'unavailable';
    try {
      rows = recentLimit > 0 && typeof store?.recent === 'function'
        ? store.recent(chatKey, { limit: recentLimit, includeSelf: true }) : [];
      if (!Array.isArray(rows)) rows = [];
      if (typeof store?.recent === 'function') recentStatus = rows.length ? 'available' : 'empty';
      const rawTotal = Number(store?.getChatMeta?.(chatKey)?.total);
      if (Number.isFinite(rawTotal) && rawTotal >= 0) total = Math.floor(rawTotal);
    } catch (error) {
      log(logSink, 'warn', 'memory-recent-read-failed', {
        chatKey, roundId: String(input.roundId ?? ''), reason: String(error?.message ?? error).slice(0, 120)
      });
      rows = [];
      recentStatus = 'unavailable';
    }
    const currentIds = new Set((Array.isArray(input.evidence) ? input.evidence : [])
      .map((row) => String(row?.id ?? '').replace(/^#/, '')).filter(Boolean));
    let excludedCurrent = 0;
    const recentMessages = rows.filter((row) => {
      if (!row || typeof row !== 'object') return false;
      if (row.chatKey != null && String(row.chatKey) !== chatKey) return false;
      if (row.kind && row.kind !== kind) return false;
      if (row.visible === false || row.revoked === true || row.retracted === true || row.deleted === true
        || ['revoked', 'retracted', 'deleted', 'expired'].includes(String(row.status ?? '').toLowerCase())) return false;
      const expiry = timestampOf(row.validUntil ?? row.expiresAt);
      if (Number.isFinite(expiry) && expiry > 0 && expiry <= now) return false;
      const messageId = String(row.mid ?? row.messageId ?? '').replace(/^#/, '');
      if (messageId && currentIds.has(messageId)) { excludedCurrent += 1; return false; }
      return true;
    }).slice(recentLimit === 0 ? 0 : -recentLimit).map((row) => ({
      localId: row.localId ?? row.id ?? null,
      mid: row.mid ?? row.messageId ?? null,
      ts: row.ts ?? row.at ?? null,
      senderId: String(row.senderId ?? ''),
      senderName: String(row.senderName ?? ''),
      self: row.self === true,
      text: String(row.text ?? ''),
      ...(row.sourceVersion != null ? { sourceVersion: row.sourceVersion } : {})
    }));

    let retrieved = { items: [], dropped: [], scanned: 0 };
    if (typeof memory?.retrieve === 'function') {
      try {
        retrieved = await memory.retrieve({
          chatKey, kind, evidence: input.evidence, topic: input.topic,
          senderId: input.senderId, need: input.need, now, dataDir,
          limit: budget.recalledItems, signal: input.signal
        }) || retrieved;
      } catch (error) {
        log(logSink, 'warn', 'memory-retrieve-failed', {
          chatKey, roundId: String(input.roundId ?? ''), reason: String(error?.message ?? error).slice(0, 160)
        });
      }
    }
    let sourceVersionUnknown = 0;
    const sourceCurrent = (item) => {
      const scope = String(item?.scope ?? '');
      if (scope === 'private' && kind !== 'private') return false;
      if (scope === 'group' && kind !== 'group') return false;
      if (scope !== 'global' && scope !== 'private' && scope !== 'group') return false;
      if (item?.chatKey && scope !== 'global' && String(item.chatKey) !== chatKey) return false;
      if (item?.status && !['active', 'current'].includes(String(item.status).toLowerCase())) return false;
      const expiry = timestampOf(item?.validUntil ?? item?.expiresAt);
      if (Number.isFinite(expiry) && expiry > 0 && expiry <= now) return false;
      if (item?.revoked === true || item?.retracted === true || item?.deleted === true) return false;
      const refs = Array.isArray(item?.sourceRefs) ? item.sourceRefs : [];
      if (!refs.length) sourceVersionUnknown += 1;
      for (const ref of refs) {
        if (!ref || ref.revoked === true || ref.retracted === true || ref.deleted === true) return false;
        if (ref.chatKey && String(ref.chatKey) !== chatKey && scope !== 'global') return false;
        const refExpiry = timestampOf(ref.validUntil ?? ref.expiresAt);
        if (Number.isFinite(refExpiry) && refExpiry > 0 && refExpiry <= now) return false;
        if (ref.sourceVersion == null || ref.messageId == null || typeof store?.findByRef !== 'function') {
          sourceVersionUnknown += 1;
          continue;
        }
        let source = null;
        try { source = store.findByRef(String(ref.chatKey || chatKey), String(ref.messageId)); } catch { source = null; }
        if (!source || sourceEventVersion(source, 1) !== String(ref.sourceVersion)) return false;
      }
      return true;
    };
    const recalledRaw = Array.isArray(retrieved?.items) ? retrieved.items : [];
    const recalled = recalledRaw.filter(sourceCurrent);
    const staleCount = recalledRaw.length - recalled.length;
    const personIds = [...new Set((Array.isArray(input.evidence) ? input.evidence : []).flatMap((entry) => [
      entry?.sender?.id, ...(Array.isArray(entry?.mentions) ? entry.mentions.map((mention) => mention?.id) : [])
    ]).map((id) => String(id ?? '').trim()).filter(Boolean))];
    let todos = [];
    try {
      if (typeof todosService?.activeTodos === 'function') {
        const found = readMemory({ route: 'activeTodos', input: {
          todos: todosService, options: { chatKey, limit: budget.todos, personIds }
        } });
        todos = (Array.isArray(found?.items) ? found.items : []).filter((todo) => {
          if (!todo || typeof todo !== 'object' || !String(todo.text ?? '').trim()) return false;
          if (todo.chatKey && String(todo.chatKey) !== chatKey) return false;
          if (todo.status && String(todo.status) !== 'pending') return false;
          const expiry = timestampOf(todo.validUntil ?? todo.expiresAt);
          return !Number.isFinite(expiry) || expiry <= 0 || expiry > now;
        });
      }
    } catch (error) {
      log(logSink, 'warn', 'memory-todos-read-failed', { chatKey, reason: String(error?.message ?? error).slice(0, 120) });
    }
    const cursor = fallbackCursor.get(chatKey) ?? null;
    const dropped = [ ...(Array.isArray(retrieved?.dropped) ? retrieved.dropped : []),
      ...(staleCount ? [{ reason: 'source-version-or-visibility-stale', count: staleCount }] : []) ];
    return normalizeContext({
      schemaVersion: 1,
      namespace: { accountId, scope: kind, chatKey },
      coverage: {
        state: 'degraded',
        processedThrough: null,
        scope: { accountId, kind, chatKey }
      },
      revisions: { content: null, working: null, todo: null, permission: null, source: null, historyEpoch: null },
      checkpoint: {
        id: null, version: 0,
        sourceCursor: cursor ? { messageId: cursor.messageId, eventVersion: cursor.eventVersion } : null,
        backgroundItems: [], episodeSummaries: []
      },
      recent: { status: recentStatus, messages: recentMessages,
        total, excludedCurrent },
      working: { topic: String(input.topic ?? ''), need: String(typeof input.need === 'string' ? input.need : input.need?.text ?? '') },
      recalled, todos, dependencies: recalled.map((row) => ({
        kind: 'observation', id: String(row?.id ?? ''), version: row?.version ?? null,
        sourceRefs: Array.isArray(row?.sourceRefs) ? row.sourceRefs : []
      })),
      expiresAt: recalled.map((row) => timestampOf(row?.validUntil ?? row?.expiresAt)).filter((at) => Number.isFinite(at) && at > 0).sort((a, b) => a - b)[0] ?? null,
      diagnostics: {
        recallMode: 'keyword',
        droppedCounts: { stale: staleCount, memory: dropped.length },
        pendingJobs: 0, applicableRoundId: String(input.roundId ?? ''),
        sourceVersionUnknownCount: sourceVersionUnknown,
        coordinator: 'unavailable; M6 retrieve + ChatStore fallback',
        coordinatorFailure,
        readings: {
          chatRowsRead: rows.length,
          recentKept: recentMessages.length,
          recalledCount: recalled.length,
          elapsedMs: Math.round((clockElapsedNow(clock) - startedAt) * 100) / 100
        }
      },
      items: recalled, dropped, topic: String(input.topic ?? ''), need: input.need ?? null
    }, input);
  }

  function normalizeContext(value, input = {}) {
    const source = value?.context && typeof value.context === 'object' ? value.context : value;
    const recalled = Array.isArray(source.recalled) ? source.recalled
      : Array.isArray(source.items) ? source.items : [];
    const checkpoint = source.checkpoint && typeof source.checkpoint === 'object' ? source.checkpoint : {};
    const rawRecent = source.recent;
    const recentMessages = Array.isArray(rawRecent) ? rawRecent
      : Array.isArray(rawRecent?.messages) ? rawRecent.messages : [];
    const recentLimitValue = Number(input?.budget?.recentMessages);
    const recentLimit = Number.isFinite(recentLimitValue) && recentLimitValue >= 0
      ? Math.floor(recentLimitValue) : null;
    const limitedRecent = recentLimit === null ? recentMessages
      : recentLimit === 0 ? [] : recentMessages.slice(-recentLimit);
    const revisions = source.revisions && typeof source.revisions === 'object' ? source.revisions : {};
    const diagnostics = source.diagnostics && typeof source.diagnostics === 'object' ? source.diagnostics : {};
    // ★ 2026-10-16（用户口径）：`memoryPolicy` 同形输出 —— 记忆实现回一份就用它（归一化），
    //   没回就按本轮输入/默认（`recall:true/mixed`）；compose/提示词据此跳过**可选**段。
    const memoryPolicy = normalizeMemoryPolicy(
      source.memoryPolicy ?? input.memoryPolicy ?? null
    );
    return {
      ...source,
      schemaVersion: 1,
      memoryPolicy,
      namespace: source.namespace ?? { accountId: getAccountId(), scope: input.kind === 'private' ? 'private' : 'group', chatKey: String(input.chatKey ?? '') },
      revisions: { content: null, working: null, todo: null, permission: null, source: null, historyEpoch: null, ...revisions },
      checkpoint: { id: null, version: 0, sourceCursor: null, backgroundItems: [], episodeSummaries: [], ...checkpoint },
      recent: Array.isArray(rawRecent) ? { status: limitedRecent.length ? 'available' : 'empty', messages: limitedRecent }
        : { status: rawRecent?.status ?? (limitedRecent.length ? 'available' : 'empty'), ...rawRecent, messages: limitedRecent },
      working: source.working ?? {},
      recalled,
      todos: Array.isArray(source.todos) ? source.todos : [],
      dependencies: Array.isArray(source.dependencies) ? source.dependencies : [],
      expiresAt: source.expiresAt ?? null,
      diagnostics: { ...diagnostics, applicableRoundId: String(input.roundId ?? diagnostics.applicableRoundId ?? '') },
      items: recalled,
      dropped: Array.isArray(source.dropped) ? source.dropped : [],
      topic: source.topic ?? source.working?.topic ?? '',
      need: source.need ?? source.working?.need ?? null
    };
  }

  async function observe({ chatKey, kind, evidence, roundId }) {
    const valid = (Array.isArray(evidence) ? evidence : []).filter((entry) => validateMessageEvidence(entry).ok);
    const invalidCount = (Array.isArray(evidence) ? evidence.length : 0) - valid.length;
    const messageRefs = valid.map((entry) => ({
      messageId: String(entry.id),
      eventVersion: sourceEventVersion(entry, fallbackVersion),
      evidence: entry
    }));
    const service = await getCoordinator();
    let result;
    if (service) {
      result = await service.observe({
        chatKey, kind, roundId, now: clockNow(clock),
        messageRefs,
        events: messageRefs.map(({ messageId, eventVersion, evidence: row }) => ({ messageId, eventVersion, evidence: row })),
        evidence: valid
      });
      result = result && typeof result === 'object' ? result : { ok: false, reason: 'coordinator-returned-no-result' };
    } else {
      result = await observeWithExistingLedger({ chatKey, kind, messageRefs, evidence: valid });
    }
    const normalized = {
      ...result,
      observed: Math.max(0, Number(result.observed ?? result.observedCount ?? messageRefs.length - invalidCount) || 0),
      queued: Math.max(0, Number(result.queued ?? result.queuedCount ?? result.added?.length) || 0),
      duplicates: Math.max(0, Number(result.duplicates ?? result.duplicateCount ?? 0) || 0),
      invalid: invalidCount,
      ledgerEvidenceIds: result.ok !== false && result.persisted === true
        ? valid.map((entry) => String(entry?.id ?? '').trim()).filter(Boolean)
        : []
    };
    if (normalized.ok !== false && normalized.persisted === true && normalized.observed > 0) {
      const key = String(chatKey ?? '');
      const prior = pendingConsolidation.get(key);
      pendingConsolidation.set(key, {
        kind: kind === 'private' ? 'private' : 'group',
        count: Math.max(0, Number(prior?.count) || 0) + normalized.observed,
        firstAt: Number(prior?.firstAt) || clockNow(clock),
        lastAt: clockNow(clock)
      });
    }
    return normalized;
  }

  async function onTick(now, { busy = false } = {}) {
    if (busy || consolidationPumpRunning) return;
    consolidationPumpRunning = true;
    try {
      const coordinator = await getCoordinator();
      if (!coordinator || typeof coordinator.status !== 'function' || typeof coordinator.runNextJob !== 'function') return;
      const status = await coordinator.status();
      lastConsolidationStatus = {
        queues: Math.max(0, Number(status?.queues) || 0),
        running: Math.max(0, Number(status?.running) || 0),
        unconsolidated: Math.max(0, Number(status?.unconsolidated) || 0),
        failed: Math.max(0, Number(status?.failed) || 0)
      };
      // Never overlap consolidation with a reply or another consolidation job.
      if (lastConsolidationStatus.running > 0) return;
      if (lastConsolidationStatus.queues === 0 && typeof coordinator.requestConsolidation === 'function') {
        const nowMs = Number.isFinite(Number(now)) ? Number(now) : clockNow(clock);
        const due = [...pendingConsolidation.entries()]
          .filter(([, pending]) => pending.count >= consolidationThreshold
            || nowMs - pending.lastAt >= consolidationQuietMs)
          .sort((a, b) => a[1].firstAt - b[1].firstAt)[0];
        if (due) {
          const [chatKey, pending] = due;
          const requested = await coordinator.requestConsolidation({
            chatKey, kind: pending.kind,
            reason: `orchestrator-observed-${pending.count}-messages`
          });
          if (requested?.ok === true && requested?.queued === true) pendingConsolidation.delete(chatKey);
          else log(logSink, 'warn', 'memory-consolidation-request-failed', {
            chatKey, reason: String(requested?.error ?? 'request-rejected')
          });
        }
      }
      // Do not call runNextJob for an empty queue: the heartbeat must not spin or invoke extraction.
      const queued = await coordinator.status();
      lastConsolidationStatus = {
        queues: Math.max(0, Number(queued?.queues) || 0),
        running: Math.max(0, Number(queued?.running) || 0),
        unconsolidated: Math.max(0, Number(queued?.unconsolidated) || 0),
        failed: Math.max(0, Number(queued?.failed) || 0)
      };
      if (lastConsolidationStatus.running > 0 || lastConsolidationStatus.queues === 0) return;
      await coordinator.runNextJob();
      const finished = await coordinator.status();
      lastConsolidationStatus = {
        queues: Math.max(0, Number(finished?.queues) || 0),
        running: Math.max(0, Number(finished?.running) || 0),
        unconsolidated: Math.max(0, Number(finished?.unconsolidated) || 0),
        failed: Math.max(0, Number(finished?.failed) || 0)
      };
    } catch (error) {
      log(logSink, 'warn', 'memory-consolidation-heartbeat-failed', {
        reason: String(error?.message ?? error).slice(0, 160)
      });
    } finally {
      consolidationPumpRunning = false;
    }
  }
  onTick.status = () => ({
    pendingChats: pendingConsolidation.size,
    ...lastConsolidationStatus
  });
  async function recordOutcome({ chatKey, kind, turnId, toolResults = [], confirmedSendReceipts = [] } = {}) {
    const service = await getCoordinator();
    if (typeof service?.recordOutcome === 'function') {
      const result = await service.recordOutcome({
        turnId: String(turnId ?? ''), chatKey: String(chatKey ?? ''), kind,
        toolResults: Array.isArray(toolResults) ? toolResults : [],
        confirmedSendReceipts: Array.isArray(confirmedSendReceipts) ? confirmedSendReceipts : []
      });
      const recorded = Math.max(0, Number(result?.recorded ?? result?.count) || 0);
      return { ...result, recorded, persisted: result?.persisted === true };
    }

    // Until the coordinator lands, keep real outcomes in M6's existing evidence ledger.
    // Only confirmed outbound text and actual tool result fields are included; model body is never passed here.
    const events = [];
    for (const [index, row] of (Array.isArray(toolResults) ? toolResults : []).entries()) {
      const tool = String(row?.tool ?? '').trim();
      if (!tool) continue;
      const state = String(row.state ?? '');
      events.push({
        id: `outcome:${String(turnId ?? 'turn')}:tool:${index}:${tool}`,
        at: clockNow(clock), chatKey: String(chatKey ?? ''), kind,
        sourceType: 'tool_confirm', sender: { id: getAccountId() },
        text: `${tool}：${row.ok === true ? '完成' : '失败'}${state ? `（${state}）` : ''}`,
        toolReceipt: { tool, ok: row.ok === true, state, ...(row.resultText ? { resultText: String(row.resultText).slice(0, 4000) } : {}) },
        mentions: [], media: []
      });
    }
    for (const [index, sent] of (Array.isArray(confirmedSendReceipts) ? confirmedSendReceipts : []).entries()) {
      const receipt = sent?.receipt;
      if (!validateSendReceipt(receipt).ok || receipt?.ok !== true || !receipt.platformId) continue;
      events.push({
        id: `outcome:${String(turnId ?? 'turn')}:send:${String(receipt.platformId)}:${index}`,
        at: Number(receipt.at) || clockNow(clock), chatKey: String(chatKey ?? ''), kind,
        sourceType: 'bot_output', sender: { id: getAccountId() }, text: String(sent.text ?? ''),
        toolReceipt: { platformId: String(receipt.platformId), ok: true, tool: String(sent.tool ?? '') },
        mentions: [], media: []
      });
    }
    if (!events.length) return { ok: true, recorded: 0, persisted: true, reason: 'no-confirmed-outcomes' };
    if (typeof memory?.recordEvidence !== 'function' || !dataDir) {
      return { ok: false, recorded: 0, persisted: false, reason: 'm6-recordEvidence-unavailable' };
    }
    const result = await memory.recordEvidence(events, { dataDir });
    const invalidCount = Array.isArray(result?.invalid) ? result.invalid.length : 0;
    const addedCount = Array.isArray(result?.added) ? result.added.length : 0;
    const duplicateCount = Array.isArray(result?.duplicate) ? result.duplicate.length : 0;
    return {
      ok: result?.ok !== false && invalidCount === 0,
      recorded: addedCount + duplicateCount,
      persisted: result?.ok !== false && invalidCount === 0,
      duplicateCount, reason: invalidCount ? 'm6-outcome-evidence-rejected' : ''
    };
  }
  observe.prepareContext = prepareContext;
  observe.recordOutcome = recordOutcome;
  observe.onTick = onTick;
  observe.status = onTick.status;
  return observe;
}

function readScopedConfig(cfg, keyPath, scope, fallback) {
  try {
    const resolved = cfg?.effective?.(keyPath, scope);
    if (resolved && typeof resolved === 'object' && Object.hasOwn(resolved, 'value')) {
      return resolved.found === false ? fallback : resolved.value;
    }
    if (resolved !== undefined && resolved !== null) return resolved;
  } catch { /* fall back to the ordinary effective getter */ }
  try {
    const value = cfg?.get?.(keyPath, fallback);
    return value === undefined || value === null ? fallback : value;
  } catch { return fallback; }
}

function textSendBudget(cfg, chatKey, kind) {
  const configured = Number(readScopedConfig(cfg, 'send.maxPerRun', { chatKey, kind }, 4));
  return {
    // 0 = unlimited, matching the config comment; positive values are per-run text caps.
    limit: Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : 4,
    used: 0
  };
}

function boundedContextTier(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(4, Math.max(1, Math.round(parsed))) : 4;
}

function isCjkKeyword(value) {
  return /[㐀-䶿一-鿿豈-﫿]/u.test(value);
}

function matchesTierKeyword(text, keywords) {
  const content = String(text ?? '').toLowerCase();
  if (!content) return false;
  for (const raw of Array.isArray(keywords) ? keywords : []) {
    const keyword = String(raw ?? '').trim().toLowerCase();
    if (!keyword) continue;
    if ([...keyword].length === 1 && isCjkKeyword(keyword)) {
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?<![\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF])${escaped}`).test(content)) return true;
    } else if (content.includes(keyword)) return true;
  }
  return false;
}

function contextMessageCount(cfg, scope, key, fallback) {
  const value = Number(readScopedConfig(cfg, `store.${key}`, scope, fallback));
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

/**
 * ★ 2026-10-16（用户口径）：第 3 档「回复概率随机」的真值 —— 与 `contextTierGate` 同一派生源。
 * 配置写库时 `store.contextSliderPos` 由 config-store 派生成 `contextTier` + `randomPercent`
 * （`core/config-store/tier-slider.js`，档 3 段线性 0~100）；perChat / 私聊覆写优先，缺省回落
 * `store.randomPercent`。返回 0..1；读不到/非法 ⇒ 0（宁可不随机，也不凭空放大命中）。
 */
function scopedReplyProbability(cfg, chatKey, kind) {
  let store = {};
  try { store = readConfig(cfg, 'store', {}) ?? {}; } catch { store = {}; }
  const scoped = store?.perChat?.[chatKey]?.randomPercent
    ?? (kind === 'private' && store?.privateOverride === true ? store?.private?.randomPercent : undefined);
  let raw = scoped;
  if (raw === undefined || raw === null) {
    try { raw = readScopedConfig(cfg, 'store.randomPercent', { chatKey, kind }, undefined); } catch { raw = undefined; }
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  let percent = Math.max(0, Math.min(100, n));
  // ★ 2026-10-22（她要的「群内峰期谷期独立回复概率」）：群概率可按时间段独立设置 ——
  //   命中峰期窗口用 peakPercent，其余用 offPeakPercent，覆盖上面从滑条派生的值。
  //   `store.timeProfile.enabled !== true` 时 resolveGroupReplyPercent 返回 null，
  //   行为与改前逐字一致。私聊不经过这一层（privateOverride 优先级更高，也不该受时段影响）。
  if (kind !== 'private' && !String(chatKey || '').startsWith('private:')) {
    try {
      const prof = resolveGroupReplyPercent((path, fallback) => readConfig(cfg, path, fallback), chatKey);
      if (prof) percent = prof.percent;
    } catch { /* 读不到就按滑条派生值走：不放大也不缩小 */ }
  }
  return percent / 100;
}

// ★ 2026-10-17（用户裁定：回复方式可切换，且每个群可单独设置）——
//   **自由接话方式的唯一解析点**。真键 = `store.replyMode` ∈ {'jev','random'}，分层 =
//   perChat[chatKey] > private(仅 privateOverride) > global > default（走 config-store 的
//   `effective('store.replyMode', {chatKey,kind})`，**不在 localJev.* 里造假单群覆盖**）。
//   有界兼容（只在**新键未显式配置**时生效，新键显式值永远优先）：
//     · 旧 `localJev.replyChance.mode` 显式值 → 按它（'random' 才改变行为，'jev' 即默认）；
//     · 旧 `localJev.judgeMode.enabled` 显式值 → 沿用旧行为（开=云判 / 关=随机），
//       避免"显式关掉了旧开关"的老安装被静默改模式；
//     · 两者都没有（含旧开关仍是缺省值）→ 按**有效配置的缺省值**（★ 2026-10-18 收口：出厂默认
//       已改为 random，见 defaults.js `store.replyMode`）——不再硬编码 'jev'，UI 说的缺省模式
//       与后台真实执行一致；缺省值取不到时回落 'random'。
//   显式但非法的 `store.replyMode` → 按新出厂默认 'random' 执行并带 compat 标记（UI 按
//   source='fallback' 说明；不被旧键偷盖）。
const REPLY_MODE_VALUES = new Set(['jev', 'random']);
function normalizeReplyMode(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return REPLY_MODE_VALUES.has(v) ? v : '';
}
function readConfigLayer(cfg, keyPath, scope = {}) {
  try {
    const eff = typeof cfg?.effective === 'function' ? cfg.effective(keyPath, scope) : null;
    if (eff && typeof eff === 'object' && Object.hasOwn(eff, 'value')) {
      const source = String(eff.source ?? (eff.found === false ? 'missing' : 'global'));
      return {
        value: eff.value, source,
        explicit: eff.found !== false && source !== 'default' && source !== 'missing'
      };
    }
    if (eff !== undefined && eff !== null) return { value: eff, source: 'global', explicit: true };
  } catch { /* fall back to get() */ }
  try {
    // 旧装配/测试桩没有 effective（或它返回 undefined）：用 undefined 兜底探测"有没有显式写过"。
    const value = cfg?.get?.(keyPath, undefined);
    if (value === undefined || value === null) return { value: undefined, source: 'missing', explicit: false };
    return { value, source: 'unknown', explicit: true };
  } catch { return { value: undefined, source: 'missing', explicit: false }; }
}
export function resolveReplyMode(cfg, { chatKey = '', kind = 'group' } = {}) {
  const fresh = readConfigLayer(cfg, 'store.replyMode', { chatKey, kind });
  if (fresh.explicit) {
    const mode = normalizeReplyMode(fresh.value);
    if (mode) return { mode, source: fresh.source, compat: null };
    // 显式但未知的值：按新出厂默认 random 执行（与默认值对齐，不再硬编码 jev），
    // 如实带兼容标记 —— UI 按 source='fallback' + compat 说明"配置值非法，按默认执行"；不看旧键。
    return { mode: 'random', source: 'fallback', compat: 'invalid-store-reply-mode', raw: String(fresh.value ?? '') };
  }
  const legacyMode = readConfigLayer(cfg, 'localJev.replyChance.mode', {});
  const legacyValue = normalizeReplyMode(legacyMode.value);
  if (legacyMode.explicit && legacyValue) {
    return { mode: legacyValue, source: 'legacy', compat: 'localJev.replyChance.mode' };
  }
  const legacyJudge = readConfigLayer(cfg, 'localJev.judgeMode.enabled', {});
  if (legacyJudge.explicit) {
    return { mode: legacyJudge.value === true ? 'jev' : 'random', source: 'legacy', compat: 'localJev.judgeMode.enabled' };
  }
  // ★ 2026-10-18（收口）：缺省不再硬编码 —— 读**有效配置的缺省值**（ds2 的 defaults.js 已把
  //   出厂默认改成 random）。取不到/非法才回落 'random'，保证 UI 的缺省显示与后台执行一致
  //   （显式全局/逐群设置走上面的 explicit 分支，不受影响；总闸关闭的降级在 runRound 里）。
  const fallbackDefault = normalizeReplyMode(fresh.value) || 'random';
  return { mode: fallbackDefault, source: 'default', compat: null };
}

function contextTierGate(evidence, cfg) {
  const first = evidence[0] || {};
  const chatKey = evidenceChatKey(first);
  const kind = first.kind === 'private' ? 'private' : 'group';
  const scope = { chatKey, kind };
  // Config-store derives contextTier from the UI slider in its merged store view. Its scoped effective()
  // intentionally resolves per-chat values from raw config, where a slider-only override has no tier yet.
  // Prefer the already-derived scoped value when present, then keep effective() as the normal fallback.
  const store = readConfig(cfg, 'store', {});
  // ★ 2026-11-02（泠岚要的群宵禁）：perChat 可配 quietHours = { start:'HH:MM', end:'HH:MM' }（允许跨零点），
  //   窗口内该群**完全静默**——@/关键词/抽样全部不回（tier 判定前直接拦截）。私聊不受影响。
  //   读点与判定采用左闭右开（起点 ≤ now < 终点），与 time-profile 的跨零点口径一致。
  try {
    const quiet = store?.perChat?.[chatKey]?.quietHours;
    if (quiet && kind === 'group') {
      const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
      const qs = toMin(quiet.start), qe = toMin(quiet.end);
      if (qs !== null && qe !== null) {
        const now = new Date();
        const cur = now.getHours() * 60 + now.getMinutes();
        const inQuiet = qs <= qe ? (cur >= qs && cur < qe) : (cur >= qs || cur < qe);
        if (inQuiet) return { allow: false, tier: 0, kind, addressed: false, reason: 'quiet_hours' };
      }
    }
  } catch { /* 宵禁配置异常不拦截正常流程 */ }
  const scopedTier = store?.perChat?.[chatKey]?.contextTier
    ?? (kind === 'private' && store?.privateOverride === true ? store?.private?.contextTier : undefined);
  const tier = boundedContextTier(scopedTier ?? readScopedConfig(cfg, 'store.contextTier', scope, 4));
  const counts = {
    all: contextMessageCount(cfg, scope, 'allCount', 80),
    at: contextMessageCount(cfg, scope, 'atCount', 20),
    keyword: contextMessageCount(cfg, scope, 'keywordCount', 15),
    random: contextMessageCount(cfg, scope, 'randomCount', 8)
  };
  // M5 owns mention parsing. Keep the wake gate and M8's DIRECT_MENTION rule on
  // the exact same evidence fields; a second CQ/name parser could disagree.
  const addressed = evidence.some((entry) => entry?.toSelf === true || entry?.refs?.toSelf === true
    || (Array.isArray(entry?.mentions) && entry.mentions.some((mention) => mention?.isSelf === true)));
  const judgeMode = kind === 'group' && readConfig(cfg, 'localJev.judgeMode.enabled', false) === true;
  const repliedToKnownBotMessage = judgeMode && evidence.some((entry) => {
    const replyTo = entry?.refs?.replyTo && typeof entry.refs.replyTo === 'object'
      ? entry.refs.replyTo.id : entry?.refs?.replyTo;
    if (replyTo == null || String(replyTo) === '') return false;
    return (Array.isArray(entry?.botSaidBefore) ? entry.botSaidBefore : [])
      .some((message) => String(message?.id ?? '') === String(replyTo));
  });
  let rawEffective;
  try { rawEffective = cfg?.effective?.('store.contextTier', scope); }
  catch (error) { rawEffective = { threw: String(error?.message ?? error) }; }
  // ★ R02（2026-10-18）：第 4 档（全响应）在入口放行后必须带**等价的全量候选资格** ——
  //   改前只放行候选、不给资格 ⇒ 云裁判模式永远收不到请求、直接 JUDGE_NOT_CALLED 静默跳过
  //   （用户实测「越调高越不回」）。4 档不叠加第 3 档的概率抽样（它本身就是全量候选）。
  if (tier >= 4) return { allow: true, tier, kind, addressed, count: counts.all, countSource: 'allCount', fullCandidate: true };

  if (addressed) return { allow: true, tier, kind, addressed: true, count: counts.at, countSource: 'atCount' };

  // J 模式下，明确回复机器人历史消息属于活动话题候选；不能在判定前被低上下文档位挡掉。
  if (repliedToKnownBotMessage) return { allow: true, tier, kind, addressed: false, activeTopic: true, count: counts.keyword, countSource: 'keywordCount' };

  const keywords = readScopedConfig(cfg, 'store.keywords', scope, []);
  const keyword = matchesTierKeyword(evidence.map((entry) => String(entry?.text ?? '')).join('\n'), keywords);
  if (tier >= 2 && keyword) {
    return { allow: true, tier, kind, addressed: false, keyword: true, count: counts.keyword, countSource: 'keywordCount' };
  }
  if (tier >= 3) {
    // ★ 2026-10-16（用户口径）：第 3 档 = **回复概率随机**这一层。准入仍然放行（消息照档位进轮次），
    //   但打上 `randomCandidate: true` —— 是否真的成为候选、是否值得花云 JEV 请求，要在
    //   runRound 里用 `store.randomPercent`（回复概率滑条派生的真值）**抽一次**决定：
    //   抽中才调 judgeOnce；未抽中不花 JEV 请求；抽中也不代表直接发言（JEV 仍可判否）。
    //   不在本函数里抽：这里没有注入随机源，也不能每到达一条就抽一次（一批只抽一次，见 runRound）。
    return { allow: true, tier, kind, addressed: false, keyword: !!keyword, count: counts.random, countSource: 'randomCount', randomCandidate: true };
  }
  if (kind === 'private') {
    // Private turns keep their existing always-admitted behavior; scoped counts still apply.
    return { allow: true, tier, kind, addressed: false, count: counts.all, countSource: 'allCount' };
  }
  return { allow: false, tier, kind, addressed: false, reason: 'tier_restricted' };
}

/**
 * ★ 2026-10-19（N3 收口）：合批时**合并资格标记**，不是"最后一批覆盖"。
 *   先到的消息已经取得关键词/@/全量候选资格时，后到的普通消息（第 3 档随机候选）
 *   不能把该资格撤销；布尔资格一律 OR。tier/count 等展示与预算字段仍取最新一批。
 */
function mergeAdmittedGate(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  return {
    ...next,
    addressed: prev.addressed === true || next.addressed === true,
    keyword: prev.keyword === true || next.keyword === true,
    fullCandidate: prev.fullCandidate === true || next.fullCandidate === true,
    focusWindow: prev.focusWindow === true || next.focusWindow === true,
    followupWindow: prev.followupWindow === true || next.followupWindow === true,
    ...(prev.randomCandidate === true || next.randomCandidate === true ? { randomCandidate: true } : {})
  };
}

/**
 * 入站白名单门（W1）：语义逐字对齐老树 `src/app.js:106-113 allowed()`（判据本体在 core/policy/allow-gate.js）。
 * 老树在 `handleOneBotEvent`（:1169）于 ingestMessage **之前**拦截 ⇒ 白名单外的聊天完全不记录；
 * 这里同样拦在准入循环（contextTierGate 之前），被拒消息不进轮次、不发送，只留抑制证据。
 * ★ 不许拿 contextTierGate 当白名单，也不许顺手改它的默认值 —— 那是另一条门。
 */
function allowInboundGate(chatKey, cfg) {
  const sep = String(chatKey ?? '').indexOf(':');
  const kind = sep > 0 ? String(chatKey).slice(0, sep) : '';
  const id = sep > 0 ? String(chatKey).slice(sep + 1) : '';
  // 判不出 kind/id（不是 group:/private: 形状）⇒ 不误拦正常会话，交给下游档位门；留一行日志可查。
  if ((kind !== 'group' && kind !== 'private') || !id) return { allow: true, unparsed: true };
  const read = (keyPath) => readScopedConfig(cfg, keyPath, { chatKey, kind }, undefined);
  return { allow: allowGate(kind, id, read), kind, id };
}

/**
 * 出站白名单门：只接受完整 group:<id>/private:<id>，并在配置读失败时拒绝。
 * allowGate 仍是唯一的 allow/deny 判据；这里负责严格解析和确认读取可信。
 */
function allowOutboundGate(chatKey, cfg) {
  const match = /^(group|private):([^:\s]+)$/.exec(String(chatKey ?? ''));
  if (!match) return { allow: false, reason: 'invalid-chat-key', kind: '', id: '' };
  const [, kind, id] = match;
  const scope = { chatKey: String(chatKey), kind };
  const readFailures = new Set();
  const read = (keyPath) => {
    let effectiveThrew = false;
    try {
      const resolved = cfg?.effective?.(keyPath, scope);
      if (resolved && typeof resolved === 'object' && Object.hasOwn(resolved, 'value')) {
        if (resolved.found !== false) return resolved.value;
      } else if (resolved !== undefined && resolved !== null) return resolved;
    } catch { effectiveThrew = true; }
    try {
      const value = cfg?.get?.(keyPath, undefined);
      if (value !== undefined && value !== null) return value;
      if (!effectiveThrew) return undefined;
    } catch {
      if (effectiveThrew) readFailures.add(keyPath);
      return undefined;
    }
    if (effectiveThrew) readFailures.add(keyPath);
    return undefined;
  };
  const allowAllWhenEmpty = read('allowAllWhenEmpty');
  const allowed = allowGate(kind, id, read);
  if (readFailures.size || typeof allowAllWhenEmpty !== 'boolean') {
    return { allow: false, reason: 'allow-config-unreadable', kind, id };
  }
  return { allow: allowed, reason: allowed ? '' : 'not-allowlisted', kind, id };
}

function normalizeSent(row) {
  if (!row || row.ok === false) return null;
  const at = Number(row.at ?? row.receipt?.at ?? row.time);
  const id = row.id ?? row.platformId ?? row.receipt?.platformId;
  if (!Number.isFinite(at) || id == null || String(id) === '') return null;
  const receipt = row.receipt && typeof row.receipt === 'object' ? row.receipt : row;
  const validation = validateSendReceipt(receipt);
  if (!validation.ok || receipt.ok !== true || !receipt.platformId) return null;
  return {
    id: String(id), at, text: String(row.text ?? row.message ?? row.content ?? ''), chatKey: row.chatKey == null ? '' : String(row.chatKey), roundId: row.roundId == null ? '' : String(row.roundId),
    receipt
  };
}

function normalizeSentText(value) {
  const parts = (Array.isArray(value) ? value : [value])
    .map((item) => String(item ?? ''))
    .filter((item) => item.trim());
  return parts.join('\n');
}

function withToolCallArgs(modules, run) {
  const act = modules?.act;
  if (!act || typeof act.run !== 'function') return modules;
  const sendBudget = run?.sendBudget;
  const runtimeCfg = run?.cfg;
  return {
    ...modules,
    act: {
      ...act,
      async run(planLike, ...args) {
        const first = args[0];
        const forwardedArgs = first && typeof first === 'object'
          ? [{ ...first, cfg: first.cfg ?? runtimeCfg, sendBudget }, ...args.slice(1)]
          : args;
        const rows = await act.run.call(act, planLike, ...forwardedArgs);
        if (!Array.isArray(rows) || !Array.isArray(planLike?.toolPlan)) return rows;
        const argsByTool = new Map();
        for (const call of planLike.toolPlan) {
          const name = String(call?.name ?? '').trim();
          if (!name) continue;
          const queue = argsByTool.get(name) || [];
          queue.push(call?.args ?? {});
          argsByTool.set(name, queue);
        }
        return rows.map((row) => {
          const name = String(row?.tool ?? '').trim();
          const queue = argsByTool.get(name);
          const callArgs = queue?.shift();
          if (!name || row?.args || callArgs === undefined) return row;
          return { ...row, args: callArgs };
        });
      },
      ...(typeof act.send === 'function' ? {
        async send(receiptInput, platform) {
          return act.send.call(act, {
            ...(receiptInput || {}),
            cfg: receiptInput?.cfg ?? runtimeCfg,
            sendBudget
          }, platform);
        }
      } : {})
    }
  };
}

function withRunIdentity(modules, run) {
  if (!modules) return modules;
  const identity = () => ({ sessionId: String(run?.sessionId ?? ''), roundId: String(run?.roundId ?? '') });
  const out = { ...modules };
  const llm = modules.llm;
  if (llm && typeof llm.chatCompletionWithRetry === 'function') {
    out.llm = { ...llm, chatCompletionWithRetry: (args = {}) => llm.chatCompletionWithRetry({ ...args, ...identity() }) };
  }
  const prompt = modules.prompt;
  if (prompt && typeof prompt.buildMessages === 'function') {
    out.prompt = { ...prompt, buildMessages: (params = {}) => prompt.buildMessages({ ...params, ...identity() }) };
  }
  return out;
}

function persistedModelCallTrace(entries) {
  const safeCode = (value) => {
    const text = String(value ?? '');
    return /^[A-Za-z][A-Za-z0-9_:.,-]{0,119}$/.test(text) ? text : 'other';
  };
  const optionalCount = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  };
  const optionalMs = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.min(86_400_000, Math.round(number)) : null;
  };
  const purposes = new Set(['main_model', 'body_judge', 'other']);
  if (!Array.isArray(entries)) return [];
  return entries.slice(0, 64).map((entry, index) => ({
    round: Number.isInteger(Number(entry?.round)) && Number(entry.round) > 0 ? Number(entry.round) : index + 1,
    purpose: purposes.has(entry?.purpose) ? entry.purpose : 'other',
    reason: safeCode(entry?.reason),
    toolsOffered: entry?.toolsOffered === true,
    toolCallCount: Math.max(0, Math.floor(Number(entry?.toolCallCount) || 0)),
    executedToolCalls: Math.max(0, Math.floor(Number(entry?.executedToolCalls) || 0)),
    promptTokens: optionalCount(entry?.promptTokens),
    completionTokens: optionalCount(entry?.completionTokens),
    durationMs: optionalMs(entry?.durationMs),
    prefixFingerprint: typeof entry?.prefixFingerprint === 'string'
      && /^[A-Za-z0-9_.:-]{1,64}$/.test(entry.prefixFingerprint) ? entry.prefixFingerprint : null,
    cachedTokens: optionalCount(entry?.cachedTokens),
    cacheCreationTokens: optionalCount(entry?.cacheCreationTokens),
    ...(typeof entry?.finishCalled === 'boolean' ? { finishCalled: entry.finishCalled } : {}),
    ...(entry?.continueReason ? { continueReason: safeCode(entry.continueReason) } : {}),
    ...(entry?.endReason ? { endReason: safeCode(entry.endReason) } : {})
  }));
}

function sentMessagesFromToolResult(row) {
  if (Array.isArray(row?.receipt?.sentTextMessages)) return row.receipt.sentTextMessages.map(String).filter((text) => text.trim());
  const value = row?.args?.messages ?? row?.args?.text ?? row?.data?.text;
  const messages = (Array.isArray(value) ? value : [value])
    .map((item, index) => ({ text: String(item ?? ''), index }))
    .filter((item) => item.text.trim());
  const acceptedIndexes = row?.receipt?.hygiene?.acceptedIndexes;
  if (!Array.isArray(acceptedIndexes)) return messages.map((item) => item.text);
  const accepted = new Set(acceptedIndexes.map(Number));
  return messages.filter((item) => accepted.has(item.index + 1)).map((item) => item.text);
}

function confirmedSentMessageCount(receiptEntries) {
  const messageIds = new Set();
  for (const entry of Array.isArray(receiptEntries) ? receiptEntries : []) {
    const receipt = entry?.receipt;
    if (!receipt || typeof receipt !== 'object') continue;
    const coverage = receipt.coverage ?? entry?.coverage;
    const ids = Array.isArray(coverage?.receiptIds) ? coverage.receiptIds.map(String).filter(Boolean) : [];
    // 部分成功回执通常 ok=false，但已有 receiptIds 就是平台确认发出的消息，仍应计入实际条数。
    if (ids.length) {
      for (const id of ids) messageIds.add(id);
      continue;
    }
    if (receipt.state !== 'unknown' && receipt.platformId) messageIds.add(String(receipt.platformId));
  }
  return messageIds.size;
}

function receiptConfirmsAnyMessage(receipt) {
  if (!receipt || typeof receipt !== 'object') return false;
  const ids = receipt.coverage?.receiptIds;
  return (Array.isArray(ids) && ids.some((id) => String(id ?? '').trim()))
    || Boolean(receipt.platformId && String(receipt.platformId).trim());
}

function noteUnknownSendResults(run, rows) {
  if (!Array.isArray(rows)) return;
  for (const entry of rows) {
    const receipt = entry?.receipt;
    if (entry?.state !== 'unknown' && receipt?.state !== 'unknown') continue;
    run.sendOutcomeUnknown = true;
    if (String(entry?.tool ?? '') !== 'send_message') continue;
    // ★ 2026-10-17：兜底键不再用**行下标** —— actResults 的第 0 行与 composed.toolResults 的第 0 行
    //   会撞成同一把键，两条不同的未知发送被当成一条（`unknownSendMessageCount` 少算）。
    //   没有可识别键的行改用 run 内单调序号：宁可多算一条，也不把两条不同的未知当成同一条。
    const explicitKey = String(receipt?.idempotencyKey ?? entry?.idempotencyKey ?? entry?.toolCallId ?? '').trim();
    const key = explicitKey
      || `unknown-send:${String(entry?.tool ?? '?')}:${run.unknownSendSeq = (Number(run.unknownSendSeq) || 0) + 1}`;
    if (run.unknownSendKeys?.has(key)) continue;
    run.unknownSendKeys?.add(key);
    const coverage = receipt?.coverage ?? entry?.coverage;
    const requested = Number(coverage?.requestedCount ?? entry?.uncertainMessageCount ?? 0);
    const confirmed = Number(coverage?.receiptCount ?? coverage?.receiptIds?.length ?? 0);
    const uncertain = Number.isFinite(requested) && requested > 0
      ? Math.max(0, requested - confirmed)
      : Math.max(1, Number(entry?.uncertainMessageCount) || 0);
    run.unknownSendMessageCount = (Number(run.unknownSendMessageCount) || 0) + uncertain;
  }
}

function sentTextFromToolResult(row) {
  return normalizeSentText(sentMessagesFromToolResult(row));
}

// ── 回复后自动配表情（老树 src/orchestrator.js:2233-2403 的对齐件）────────────────────────
/** 老树 :2252「别人明确要表情」词表（逐字搬运）：命中即不看概率。 */
const AUTO_STICKER_ASK_RE = /(发|来|给|换|整个|甩|贴)[^。！？\n]{0,6}(表情|表情包|贴图)|表情包?(来|呢|吧)|要个?表情/;
/** 「本轮已有表情/图」的判定面（老树 :4449 只查 sticker；本件按验收把图也算上）。 */
const AUTO_STICKER_MEDIA_TOOLS = new Set(['send_sticker', 'send_image', 'image_lib_send']);

/** buildStickerContext 表格 → 候选 id 序列（老树 :2273 同款：只认每行 `id=` 后的原样 id）。 */
function autoStickerTableIds(table) {
  return [...String(table || '').matchAll(/id=(\S+)/g)].map((match) => match[1]);
}

/** 候选编号清单（老树 :2275-2276 同款：模型回**序号**，不背 90 字符的 QQ id）。 */
function autoStickerNumberedLines(ids, table) {
  const labels = [...String(table || '').matchAll(/^[-–•]?\s*(.+?)\s+id=(\S+)$/gm)].map((match) => match[1]);
  return (Array.isArray(ids) ? ids : [])
    .map((id, index) => `${index + 1}. ${labels[index] || String(id).slice(0, 24)}`)
    .join('\n');
}

function decisionComposeReasonCode(run, finish) {
  const outcome = String(finish.composeOutcome ?? '');
  const reason = String(finish.composeReason ?? '');
  if (!outcome) return run.planDecisionLedger?.reasonCode || 'unknown';
  if (finish.sendOutcomeUnknown === true || outcome === 'delivery_unknown') return 'unknown';
  if (finish.delivered === true && ['sent', 'partial'].includes(outcome)) {
    return run.planDecisionLedger?.reasonCode || 'unknown';
  }
  if (finish.status === 'error' && outcome === 'error') return 'llm_error';
  if (outcome === 'silent') return 'COMPOSE_SILENT';
  if (finish.composeGuard) return 'COMPOSE_GUARD';
  if (outcome === 'drafted') return 'COMPOSE_BODY_INTERNAL';
  if (outcome === 'partial' || reason.startsWith('required-outputs-missing')) return 'COMPOSE_OUTPUTS_MISSING';
  if (/^(?:identical-tool-failure|repeated-tool-call-closeout|repeated-query-tool-closeout|tool-loop-without-reply-slot)/.test(reason)) {
    return 'COMPOSE_TOOL_LOOP';
  }
  if (reason === 'aborted' || reason.startsWith('aborted:')) return 'COMPOSE_ABORTED';
  if (outcome === 'incomplete' || outcome === 'empty') return 'COMPOSE_EMPTY';
  return 'unknown';
}

function modelStageLedgerFields(run, finish) {
  const outcome = String(finish.composeOutcome ?? '');
  const modelRounds = Math.max(0, Number(finish.modelRounds ?? run.modelRounds) || 0);
  const modelToolCalls = Math.max(0, Number(finish.modelToolCalls ?? run.modelToolCalls) || 0);
  const trace = Array.isArray(finish.modelCallTrace) ? finish.modelCallTrace : run.modelCallTrace;
  const toolCalls = modelToolCalls > 0 || (Array.isArray(trace) && trace.some((row) => Number(row?.toolCallCount) > 0));
  const recovered = (Array.isArray(finish.bodyRecovery) ? finish.bodyRecovery : [])
    .some((row) => Number(row?.messages) > 0);
  let modelOutcome = null;
  if (outcome === 'error' || (finish.status === 'error' && run.stage === 'compose')) {
    modelOutcome = /ETIMEDOUT|timeout/i.test(String(finish.reason ?? '')) ? 'timeout' : 'error';
  } else if (modelRounds > 0) {
    modelOutcome = toolCalls ? 'tool_calls'
      : finish.bodySuppressed === true || Number(finish.replyChars) > 0 || recovered ? 'text_only' : 'empty';
  }

  const recoveryRows = Array.isArray(finish.bodyRecovery) ? finish.bodyRecovery : [];
  const judgeBlocked = recoveryRows.some((row) => row?.reason === 'body-judge-skip');
  const guarded = Boolean(finish.composeGuard && finish.composeGuard !== 'quiet-protocol' && finish.composeGuard !== 'empty');
  const toolFailed = (Array.isArray(finish.deliveryResults) && finish.deliveryResults.some((row) => row?.ok === false || row?.receipt?.ok === false))
    || (Array.isArray(finish.receipts) && finish.receipts.some((row) => row?.receipt?.ok === false));
  let policyOutcome = null;
  let blockReason = null;
  if (finish.sendOutcomeUnknown === true || outcome === 'delivery_unknown') {
    policyOutcome = 'error';
    blockReason = 'tool_error';
  } else if (finish.status === 'error' && outcome === 'error' || toolFailed) {
    policyOutcome = 'error';
    blockReason = toolFailed || toolCalls ? 'tool_error' : 'other';
  } else if (judgeBlocked || guarded) {
    policyOutcome = 'blocked';
    blockReason = judgeBlocked ? 'text_only_judge'
      : finish.composeGuard === 'internal-analysis' ? 'narration_guard' : 'other';
  }
  return { modelOutcome, policyOutcome, blockReason };
}

function recordDecisionLedger(run, finish) {
  const base = run.planDecisionLedger;
  if (!base || run.decisionLedgerWritten) return;
  run.decisionLedgerWritten = true;
  try {
    const reasonCode = decisionComposeReasonCode(run, finish);
    const row = run.obs?.ledger?.('decision', {
      ...base,
      ...modelStageLedgerFields(run, finish),
      reasonCode,
      durationMs: Math.max(0, clockNow(run.clock) - Number(run.startedAt || 0))
    });
    if (row?.reasonCode && row.reasonCode !== reasonCode) {
      log(run.log, 'warn', 'model-decision-reason-normalized', {
        chatKey: run.chatKey, roundId: run.roundId, reasonCode, persistedReasonCode: row.reasonCode
      });
    }
  } catch (error) {
    log(run.log, 'warn', 'model-decision-ledger-failed', {
      chatKey: run.chatKey, roundId: run.roundId, reasonCode: decisionComposeReasonCode(run, finish),
      error: String(error?.message ?? error)
    });
  }
}

function sessionStartMs(summary) {
  const raw = summary?.startedAt ?? summary?.endedAt ?? summary?.lastActiveAt;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(raw ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function sessionTraceWithToolCalls(trace, fallback, details) {
  const source = trace && typeof trace === 'object' ? trace : fallback;
  const actions = Array.isArray(source?.actions) ? source.actions : [];
  const pending = Array.isArray(details) ? [...details] : [];
  const enriched = actions.map((action) => {
    const tool = String(action?.tool ?? '');
    const round = action?.round == null ? null : Number(action.round);
    const index = pending.findIndex((detail) => String(detail?.tool ?? '') === tool
      && (round == null || detail?.round == null || Number(detail.round) === round));
    if (index < 0) return action;
    const [detail] = pending.splice(index, 1);
    return { ...action, toolCall: detail.toolCall };
  });
  enriched.push(...pending.map((detail) => ({ ...detail })));
  return { ...source, actions: enriched };
}

function toolResultText(row) {
  const raw = row?.resultText ?? row?.result ?? row?.output ?? row?.content;
  let text = '';
  if (typeof raw === 'string') text = raw;
  else if (raw !== undefined && raw !== null) {
    try { text = JSON.stringify(raw); } catch { text = ''; }
  }
  return text.slice(0, 4000);
}

/** Session-local action detail may include the executor's returned data; keep it out of shared memory/obs summaries. */
/**
 * ★ 2026-10-11（指挥位放行的第②层）：memory_favor 的"真失败"在会话记录里必须**显眼**。
 *   B10 撤门槛 + qwen1 的 `ed00d3ee` 之后，回执里的 `applied` **恒为 false**（工具不许演 settled）⇒
 *   "applied===false"不能再当失败判据（那会把每次成功调用都标成未落账）。判据改用执行器的
 *   **显式字段 `favorOutcome`**：只有 `not-settled:<原因>` 是当场就能断定不会落账的真失败
 *   （只查看 / delta=0 / 缺 reason）。`pending-round-end` 的轮末结果由 M15 的
 *   `emotion-relation-delta-skipped` reasonCode 留痕（日志/观测），本层不抢它的話。
 */
function favorUnsettledPrefix(row) {
  if (String(row?.tool ?? '') !== 'memory_favor') return '';
  const outcome = String(row?.data?.favorOutcome ?? '');
  return outcome.startsWith('not-settled') ? `【未落账】${outcome.replace(/^not-settled:/,'')}。` : '';
}

function sessionToolResultText(row) {
  const prefix = favorUnsettledPrefix(row);
  let text = toolResultText(row);
  if (!text) {
    const raw = row?.data ?? (row?.error ? { error: String(row.error) } : null);
    if (typeof raw === 'string') text = raw;
    else if (raw !== undefined && raw !== null) {
      try { text = JSON.stringify(raw); } catch { text = ''; }
    }
  }
  return `${prefix}${text.slice(0, 4000)}`;
}

const TOOL_REJECTION_REASON_CODES = new Set(Object.values(TOOL_REJECT_REASONS));
const TOOL_REASON_LABELS = Object.freeze({
  [TOOL_REJECT_REASONS.FINISH_DISABLED]: 'finish 未启用',
  [TOOL_REJECT_REASONS.NOT_ALLOWED_IN_CLOSEOUT]: '收口阶段不允许此工具',
  [TOOL_REJECT_REASONS.DUPLICATE_SUPPRESSED]: '相同工具与参数已处理或被抑制',
  [TOOL_REJECT_REASONS.TOOL_ROUND_LIMIT]: '已到工具轮数上限',
  [TOOL_REJECT_REASONS.EXTENSION_HOOK_BLOCKED]: '扩展守卫拒绝了调用',
  [TOOL_REJECT_REASONS.EXTENSION_HOOK_FAILED]: '扩展守卫未能确认调用',
  [TOOL_REJECT_REASONS.SCHEMA_INVALID]: '参数格式未通过校验',
  [TOOL_REJECT_REASONS.NOT_FOUND]: '工具或目标不存在',
  [TOOL_REJECT_REASONS.NO_IMAGE]: '目标消息没有可取图片',
  [TOOL_REJECT_REASONS.DISABLED_BY_CONFIG]: '工具已在配置中禁用',
  [TOOL_REJECT_REASONS.AUTHZ_DEPENDENCY_MISSING]: '授权校验依赖未装配',
  [TOOL_REJECT_REASONS.AUTHZ_EVAL_FAILED]: '授权校验失败',
  [TOOL_REJECT_REASONS.TOOL_UNAVAILABLE]: '工具当前不可用',
  [TOOL_REJECT_REASONS.INVALID_IDEMPOTENCY_KEY]: '调用幂等键无效',
  [TOOL_REJECT_REASONS.CALL_BUDGET_EXHAUSTED]: '工具调用次数预算已用完',
  [TOOL_REJECT_REASONS.TIME_BUDGET_EXHAUSTED]: '工具执行时间预算已用完',
  [TOOL_REJECT_REASONS.HYPE_COUNT_INSUFFICIENT]: '亢奋模式连击条数不足',
  [TOOL_REJECT_REASONS.EXECUTOR_MISSING]: '工具执行器未装配',
  [TOOL_REJECT_REASONS.EXECUTOR_FAILED]: '工具执行失败',
  [TOOL_REJECT_REASONS.TIMEOUT]: '工具执行超时',
  [TOOL_REJECT_REASONS.SEND_NOT_CONFIRMED]: '未取得平台回执'
});

function approvedToolReasonCode(value) {
  const code = String(value ?? '').trim().slice(0, 48);
  return TOOL_REJECTION_REASON_CODES.has(code) ? code : '';
}

function toolReasonLabel(reasonCode) {
  const code = approvedToolReasonCode(reasonCode);
  if (!TOOL_REJECTION_REASON_CODES.has(code)) return '';
  return `${TOOL_REASON_LABELS[code] || code}（${code}）`;
}

function toolRejectionSummary(reasonCode) {
  const label = toolReasonLabel(reasonCode);
  return label ? `工具调用未执行：${label}` : '工具调用未执行';
}

function toolFailureSummary(reasonCode) {
  const label = toolReasonLabel(reasonCode);
  return label ? `工具结果原因：${label}` : '工具执行失败';
}

const TOOL_TRUNCATION_REASONS = new Set([
  'tool-result-character-limit', 'image-tool-text-limit', 'tool-history-compression'
]);
function approvedToolTruncationReason(value) {
  const code = String(value ?? '');
  return TOOL_TRUNCATION_REASONS.has(code) ? code : '';
}

function cloneSessionToolArgs(args) {
  if (args == null) return null;
  try { return JSON.parse(JSON.stringify(args)); } catch { return null; }
}

function safeJevText(value, limit = 160) {
  if (value == null || value === '') return null;
  return String(value)
    .replace(/(api[_-]?key|authorization|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, limit);
}

function jevTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function summarizeJevAvailability(value) {
  if (!value || typeof value !== 'object') return null;
  const states = new Set([
    'ready', 'mode-disabled', 'budget-unconfigured', 'budget-unavailable',
    'budget-exhausted', 'model-not-configured', 'instance-share-not-configured',
    'single-request-adapter-unavailable', 'unavailable',
    // ★ 2026-10-16（独立云判定诊断接线）：绑定失败的原因码逐项透传 —— 归一成 'unavailable'
    //   会把"缺模型 / 没选提供商 / 提供商不在已保存列表 / 没地址 / 没密钥"的区别丢掉，
    //   用户只剩一句"运行状态取不到"，正是这次要消灭的那种含糊。
    'judge-model-not-configured', 'judge-provider-not-selected', 'judge-provider-not-found',
    'judge-provider-url-missing', 'judge-provider-key-missing',
    'account-id-unavailable', 'instance-id-unavailable'
  ]);
  const levels = new Set(['normal', 'soft-limit', 'hard-limit', 'unconfigured', 'unreliable', 'unavailable']);
  const budget = value.budget && typeof value.budget === 'object' ? value.budget : null;
  const pausedPurposes = Array.isArray(budget?.pausedPurposes)
    ? [...new Set(budget.pausedPurposes.map((item) => String(item)).filter((item) => /^[a-z0-9_-]{1,64}$/i.test(item)))].slice(0, 12)
    : null;
  return {
    modeEnabled: typeof value.modeEnabled === 'boolean' ? value.modeEnabled : null,
    modelBound: typeof value.modelBound === 'boolean' ? value.modelBound : null,
    state: states.has(value.state) ? value.state : 'unavailable',
    // ★ 2026-10-16（独立云判定）：判定**实际**用谁（模式/提供商/主机/模型）+ 思考三态 + 输出预算。
    //   只透传装配层给的短串与枚举，全部有界；缺了就 null，绝不猜。
    judge: (() => {
      const j = value.judge;
      if (!j || typeof j !== 'object') return null;
      return {
        source: j.source === 'independent' ? 'independent' : 'follow',
        providerId: safeJevText(j.providerId, 80),
        host: safeJevText(j.host, 120),
        model: safeJevText(j.model, 120),
        thinking: ['inherit', 'off', 'on'].includes(j.thinking) ? j.thinking : 'inherit',
        maxTokens: Number.isSafeInteger(j.maxTokens) ? j.maxTokens : null
      };
    })(),
    reason: safeJevText(value.reason, 120),
    budget: budget ? {
      level: levels.has(budget.level) ? budget.level : 'unavailable',
      reason: safeJevText(budget.reason, 120),
      pausedPurposes
    } : null
  };
}

function summarizeJevResult(judge, { callState, callReason, keywordCandidate, plan } = {}) {
  const row = judge && typeof judge === 'object' ? judge : null;
  const memory = row?.memory && typeof row.memory === 'object' && !Array.isArray(row.memory) ? row.memory : null;
  const knownNotCalled = callState === 'not-called';
  const rawUsage = row?.usage && typeof row.usage === 'object' ? row.usage : null;
  const usage = rawUsage ? {
    promptTokens: jevTokenCount(rawUsage.promptTokens),
    completionTokens: jevTokenCount(rawUsage.completionTokens),
    totalTokens: jevTokenCount(rawUsage.totalTokens)
  } : null;
  const attempts = Array.isArray(row?.attemptReasons)
    ? row.attemptReasons.slice(0, 6).map((attempt) => {
      if (typeof attempt === 'string') return { reason: safeJevText(attempt, 120) };
      if (!attempt || typeof attempt !== 'object') return null;
      return {
        reason: safeJevText(attempt.reason ?? attempt.code, 120),
        actualCalls: jevTokenCount(attempt.actualCalls)
      };
    }).filter(Boolean)
    : (knownNotCalled ? [] : null);
  const allowedDecision = (value, allowed) => allowed.includes(value) ? value : null;
  return {
    status: safeJevText(row?.status, 40) || (knownNotCalled ? 'not-run' : 'unavailable'),
    join: allowedDecision(row?.join, ['yes', 'no', 'unknown']),
    continue: allowedDecision(row?.continue, ['yes', 'no', 'unknown', 'na']),
    memoryMode: allowedDecision(row?.memoryMode ?? memory?.mode, ['none', 'recent', 'long_term', 'mixed']),
    memoryQuery: typeof memory?.query === 'string' ? safeJevText(memory.query, 80) : null,
    memoryCrossChat: typeof memory?.cross_chat === 'boolean' ? memory.cross_chat : null,
    decisionReason: safeJevText(plan?.reason, 160),
    reason: safeJevText(row?.reason ?? callReason, 160),
    memoryReason: safeJevText(row?.memoryReason, 120),
    keywordCandidate: keywordCandidate === true,
    requestState: callState === 'called' ? 'called' : 'not-called',
    requestId: safeJevText(row?.requestId, 220),
    actualCalls: jevTokenCount(row?.actualCalls) ?? (knownNotCalled ? 0 : null),
    usageState: safeJevText(row?.usageState, 40),
    usage: usage && Object.values(usage).some((value) => value !== null) ? usage : null,
    attemptReasons: attempts,
    // ★ 2026-10-16（"云判定未完成"诊断接线）：把这一次判定的**有限无正文**证据透传到轮次记录：
    //   失败分档（预算/限流/HTTP/超时/网络）、HTTP 状态、耗时与生效超时（含夹取）、正文/思考字数、
    //   供应商 finish_reason、实际端点风格/主机、思考控制是否真下发、输出预算。缺一个就不塞那一项。
    diag: (() => {
      const fields = {
        failureKind: safeJevText(row?.failureKind, 48),
        httpStatus: jevTokenCount(row?.httpStatus),
        durationMs: jevTokenCount(row?.durationMs),
        timeoutMs: jevTokenCount(row?.timeoutMs),
        timeoutClamped: row?.timeoutClamped === true ? true : null,
        outputChars: jevTokenCount(row?.outputChars),
        reasoningChars: jevTokenCount(row?.reasoningChars),
        finishReason: safeJevText(row?.finishReason, 32),
        endpointStyle: safeJevText(row?.endpointStyle, 24),
        providerHost: safeJevText(row?.providerHost, 120),
        thinkingApplied: ['inherit', 'off', 'on', 'unsupported-style'].includes(row?.thinkingApplied)
          ? row.thinkingApplied : null,
        maxTokens: jevTokenCount(row?.maxTokens),
        // ★ 2026-10-19（第七批）：超时配置被拒的诊断三字段（B 的 judge.js 已产出，此处透传到
        //   turnPlan.jevSummary.diag，C/UI 与 B 合同一致；不落正文/密钥）。
        timeoutConfigRejected: row?.timeoutConfigRejected === true ? true : null,
        timeoutConfigRejectReason: ['out-of-range', 'not-a-number'].includes(row?.timeoutConfigRejectReason)
          ? row.timeoutConfigRejectReason : null,
        timeoutConfigRequestedMs: jevTokenCount(row?.timeoutConfigRequestedMs)
      };
      return Object.values(fields).some((value) => value !== null) ? fields : null;
    })(),
    mainModelCall: { status: 'pending', calls: null, admittedByJudge: null, causedByJudge: null }
  };
}

const JEV_MEMORY_TYPES = Object.freeze({
  recent: Object.freeze(['recent', 'topic', 'promise', 'question']),
  long_term: Object.freeze(['impression', 'trait', 'preference', 'fact'])
});

function memoryRowIdentity(row) {
  const id = String(row?.memoryId ?? row?.id ?? '').trim();
  return id ? `id:${id}` : '';
}

function recentMessageIdentity(row) {
  const mid = row?.mid ?? row?.messageId;
  if (mid !== null && mid !== undefined && String(mid) !== '') return `mid:${String(mid)}`;
  const id = row?.localId ?? row?.id;
  if (id !== null && id !== undefined && String(id) !== '') return `local:${String(id)}`;
  return `fallback:${Number(row?.ts ?? row?.at) || 0}:${String(row?.senderId ?? '')}:${String(row?.text ?? '')}`;
}

/**
 * ★ 2026-10-17（编排侧人设短期分界 · 同一轮一把尺）：把 `modules.personaBoundary` 包成
 * `{active, changedAt, snapshot, filter(rows, atOf)}`。snapshot 由调用方**每轮冻结一次**
 * （runRound 开轮，见下方 `run.personaSnapshot`）；这里不读 live state —— JEV 判定输入、
 * JEV 记忆补取合流、主模型 compose、回复后自动表情共用同一份快照，跨 await 切卡不会跨代混用。
 * 长期来源（印象/事实/偏好/语义卡/情节/向量/授权/待办）不走这里。
 * 导出仅为行为夹具/自测直接调用（无运行时依赖）。
 */
export function makeShortTermFilter({ modules, snapshot = null } = {}) {
  const boundary = modules?.personaBoundary ?? null;
  const changedAt = Number(snapshot?.changedAt) > 0 ? Number(snapshot.changedAt) : 0;
  const active = Boolean(changedAt) && Boolean(boundary) && typeof boundary.filterShortTerm === 'function';
  const filter = (rows, atOf = null) => {
    const list = Array.isArray(rows) ? rows : [];
    if (!active) return { rows: list, filtered: 0, unknown: 0 };
    return boundary.filterShortTerm(list, {
      ...(typeof atOf === 'function' ? { atOf } : {}),
      snapshot
    });
  };
  return { active, changedAt, snapshot, filter };
}

export function mergeJevMemoryContext(baseContext, { observations = [], recentMessages = [], crossChatItems = [], shortTerm = null } = {}) {
  const base = baseContext && typeof baseContext === 'object' ? baseContext : {};
  const baseItems = Array.isArray(base.items) ? base.items : Array.isArray(base.recalled) ? base.recalled : [];
  const items = [...baseItems];
  const seenItems = new Set(baseItems.map(memoryRowIdentity).filter(Boolean));
  const crossClaims = new Set(baseItems.map((row) => `${String(row?.subjectId ?? '')}\u0000${String(row?.claim ?? '')}`));
  let crossChatAddedCount = 0;
  for (const item of [...observations, ...crossChatItems]) {
    if (!item || typeof item !== 'object') continue;
    const id = memoryRowIdentity(item);
    if (id && seenItems.has(id)) continue;
    // The cross-chat public view intentionally has no card id. De-duplicate that
    // projection only by its returned subject/content pair; no id is fabricated.
    const crossKey = item.__crossChat === true
      ? `${String(item.subjectId ?? '')}\u0000${String(item.claim ?? '')}` : '';
    if (crossKey && crossClaims.has(crossKey)) continue;
    if (id) seenItems.add(id);
    items.push(item);
    if (crossKey) { crossClaims.add(crossKey); crossChatAddedCount += 1; }
  }

  const baseRecent = Array.isArray(base.recent) ? base.recent
    : Array.isArray(base.recent?.messages) ? base.recent.messages : [];
  const mergedRecent = [...baseRecent];
  const seenMessages = new Set(baseRecent.map(recentMessageIdentity));
  for (const message of recentMessages) {
    const key = recentMessageIdentity(message);
    if (seenMessages.has(key)) continue;
    seenMessages.add(key);
    mergedRecent.push(message);
  }
  mergedRecent.sort((a, b) => (Number(a?.ts ?? a?.at) || 0) - (Number(b?.ts ?? b?.at) || 0));
  // ★ 2026-10-17（编排侧短期分界 · 原 1555/1757 合流口）：base 近期原文与 JEV 补取**合流之后**
  //   按同一轮冻结快照收窄 —— 分界前 / 时间不可信的行不再注入（契约同 persona-context.filterShortTerm）。
  //   items/crossChat 是长期来源，不筛。
  const visibleRecent = shortTerm && typeof shortTerm.filter === 'function'
    ? shortTerm.filter(mergedRecent, (row) => row?.at ?? row?.ts).rows
    : mergedRecent;
  const recent = Array.isArray(base.recent)
    ? { status: visibleRecent.length ? 'available' : 'empty', messages: visibleRecent }
    : { ...(base.recent && typeof base.recent === 'object' ? base.recent : {}),
      status: visibleRecent.length ? 'available' : (base.recent?.status ?? 'empty'), messages: visibleRecent };
  return { context: { ...base, items, recalled: items, recent }, crossChatAddedCount };
}

const MEMORY_POLICY_MODES = new Set(['none', 'recent', 'long_term', 'mixed']);

/**
 * ★ 2026-10-16（用户口径）：JEV 记忆策略的公共形状 ——
 * `{ recall:boolean, mode:'none'|'recent'|'long_term'|'mixed', reason:string }`。
 * 缺失/非法/形状不一致一律按 `recall:true, mode:'mixed'`（宁多勿漏）；`mode:'none'` 只在 `recall:false` 时成立。
 * 下游（compose/提示词/记忆实现）都只认这一个形状；不给"半关"状态。
 */
function normalizeMemoryPolicy(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const mode = raw && MEMORY_POLICY_MODES.has(String(raw.mode)) ? String(raw.mode) : null;
  const reason = String(raw?.reason ?? '').trim().slice(0, 120);
  if (raw?.recall === false && mode === 'none') {
    return { recall: false, mode: 'none', reason: reason || 'judge-none-no-local-need' };
  }
  if (raw?.recall === true) {
    return { recall: true, mode: mode && mode !== 'none' ? mode : 'mixed', reason: reason || 'judge-request' };
  }
  return { recall: true, mode: 'mixed', reason: reason || 'default-recall' };
}

/**
 * ★ 2026-10-16（用户口径「所有 JEV 需求同一次判」）：把**同一次** judgeOnce 的 `memory`
 * 结果 + 本地强需求裁成最终策略。不再为印象/语义卡/情节各开模型请求；也不在这里发起任何召回。
 *
 * 判据（逐条对应用户口径）：
 *   · 明确 @ 绕过 JEV / 本轮没调判定 ⇒ 不新增等待，默认召回（`judge-bypassed-addressed` / `judge-not-called`）；
 *   · JEV 超时/预算拒绝/格式坏/低置信/`memory` 缺失或非法 ⇒ 按召回（`judge-memory-missing-or-invalid`）；
 *   · 只有 `status==='accepted'` 且 `memory.mode` 是合法值时才算"有效明确"；
 *   · `mode==='none'` 且本地无强需求（旧事/追问/人物关系/更正/承诺）⇒ 才省略可选记忆（`recall:false`）；
 *   · `mode==='none'` 但本地有强需求 ⇒ 召回（`local-strong-need`），不因 none 丢硬依赖。
 */
function decideJevMemoryPolicy({ judge, judgeCalled = false, judgeBypassed = false, localStrongNeed = false } = {}) {
  if (judgeBypassed) return { recall: true, mode: 'mixed', reason: 'judge-bypassed-addressed' };
  if (judgeCalled !== true) return { recall: true, mode: 'mixed', reason: 'judge-not-called' };
  const accepted = judge?.status === 'accepted';
  const raw = accepted && judge?.memory && typeof judge.memory === 'object' && !Array.isArray(judge.memory)
    ? judge.memory : null;
  const mode = raw && MEMORY_POLICY_MODES.has(String(raw.mode)) ? String(raw.mode) : null;
  if (!raw || !mode) return { recall: true, mode: 'mixed', reason: 'judge-memory-missing-or-invalid' };
  if (mode === 'none') {
    return localStrongNeed
      ? { recall: true, mode: 'mixed', reason: 'local-strong-need' }
      : { recall: false, mode: 'none', reason: 'judge-none-no-local-need' };
  }
  return { recall: true, mode, reason: 'judge-request' };
}

async function retrieveJevMemoryForReply({
  context, judge, memoryAvailability, modules, cfg,
  chatKey, kind, evidence, senderId, personId, now, roundId, signal, logSink, shortTerm = null
} = {}) {
  const raw = judge?.status === 'accepted' && judge?.memory && typeof judge.memory === 'object' && !Array.isArray(judge.memory)
    ? judge.memory : null;
  const mode = raw && ['none', 'recent', 'long_term', 'mixed'].includes(String(raw.mode)) ? String(raw.mode) : null;
  const query = typeof raw?.query === 'string' ? raw.query.trim().slice(0, 80) : null;
  const crossChatRequested = raw?.cross_chat === true;
  const currentPersonId = String(personId ?? '').trim();
  const currentSenderIsEvidenceParticipant = currentPersonId !== ''
    && (Array.isArray(evidence) ? evidence : []).some((entry) => String(entry?.sender?.id ?? '').trim() === currentPersonId);
  // `cross_chat` is a query intent, not a grant. Only pass an explicit request
  // for the trusted current sender; memory.retrieve remains authoritative for
  // each impression-share grant and revocation.
  const crossChatReadRequested = crossChatRequested
    && memoryAvailability?.crossChat === true
    && currentSenderIsEvidenceParticipant;
  const baseSummary = {
    state: 'unavailable', mode, query,
    observations: { state: 'not-requested', count: 0, ids: [] },
    recentMessages: { state: 'not-requested', count: 0, ids: [] },
    crossChat: { state: crossChatRequested ? 'unavailable' : 'not-requested', count: 0, ids: null }
  };
  if (!raw || !mode || (mode !== 'none' && !query)) {
    return { context, summary: baseSummary };
  }
  if (mode === 'none') {
    return { context, summary: { ...baseSummary, state: 'not-requested', crossChat: { state: 'not-requested', count: 0, ids: [] } } };
  }

  const requestedTypes = mode === 'recent' ? [...JEV_MEMORY_TYPES.recent]
    : mode === 'long_term' ? [...JEV_MEMORY_TYPES.long_term]
      : [...JEV_MEMORY_TYPES.recent, ...JEV_MEMORY_TYPES.long_term];
  const summary = { ...baseSummary };
  const observations = [];
  const recentMessages = [];
  const crossChatItems = [];
  let successfulSources = 0;
  let failedSources = 0;
  const dataDir = String(modules?.configStore?.DATA_DIR ?? '').trim();

  if (crossChatRequested && !crossChatReadRequested) {
    failedSources += 1;
    const reason = memoryAvailability?.crossChat !== true
      ? 'memory-retrieve-unavailable'
      : currentPersonId ? 'current-sender-not-in-evidence' : 'current-person-id-unavailable';
    log(logSink, 'warn', 'jev-cross-chat-memory-retrieve-skipped', { chatKey, roundId, reason });
  }

  if (typeof modules?.memory?.retrieve === 'function' && dataDir) {
    try {
      const retrieved = await modules.memory.retrieve({
        chatKey, kind, evidence, topic: query, senderId, now, dataDir, signal,
        need: { types: requestedTypes, limit: 8 },
        ...(crossChatReadRequested ? { crossChat: { authorized: true, personId: currentPersonId } } : {})
      });
      if (!retrieved || !Array.isArray(retrieved.items)) throw new Error('memory-retrieve-invalid-result');
      const beforeIds = new Set((Array.isArray(context?.items) ? context.items : Array.isArray(context?.recalled) ? context.recalled : [])
        .map(memoryRowIdentity).filter(Boolean));
      for (const row of (Array.isArray(retrieved?.items) ? retrieved.items : []).slice(0, 8)) {
        if (!row || typeof row !== 'object') continue;
        if (String(row.scope ?? '') === 'global') {
          const subjectId = String(row.subjectId ?? '').trim();
          const claim = String(row.claim ?? '').trim();
          if (!crossChatReadRequested || row.type !== 'impression' || !subjectId
            || subjectId !== currentPersonId || !claim || crossChatItems.length >= 4) {
            log(logSink, 'warn', 'jev-cross-chat-memory-row-rejected', {
              chatKey, roundId,
              reason: !crossChatReadRequested ? 'cross-chat-request-not-authorized'
                : row.type !== 'impression' ? 'global-row-not-impression'
                  : subjectId !== currentPersonId ? 'global-row-subject-mismatch' : 'global-row-invalid'
            });
            continue;
          }
          crossChatItems.push({
            subjectId, claim, scope: 'global', type: 'impression',
            confidence: row.confidence, __crossChat: true
          });
          continue;
        }
        const key = memoryRowIdentity(row);
        if (!key || beforeIds.has(key)) continue;
        beforeIds.add(key);
        observations.push(row);
      }
      summary.observations = {
        state: 'available',
        count: observations.length,
        ids: observations.map((row) => String(row.memoryId ?? row.id ?? '')).filter(Boolean).slice(0, 8)
      };
      if (crossChatRequested && crossChatReadRequested) {
        summary.crossChat = {
          state: crossChatItems.length ? 'available' : 'empty',
          count: crossChatItems.length, ids: null
        };
      }
      if (summary.observations.state === 'available') successfulSources += 1;
      else failedSources += 1;
    } catch (error) {
      summary.observations = { state: 'unavailable', count: 0, ids: [] };
      failedSources += 1;
      log(logSink, 'warn', 'jev-memory-retrieve-failed', {
        chatKey, roundId, reason: String(error?.code ?? error?.name ?? 'memory-retrieve-failed').slice(0, 80)
      });
    }
  } else {
    summary.observations = { state: 'unavailable', count: 0, ids: [] };
    failedSources += 1;
  }

  if (['recent', 'mixed'].includes(mode)) {
    let personaTwo = null;
    try {
      const value = typeof modules?.emotion?.isPersonaTwo === 'function'
        ? modules.emotion.isPersonaTwo()
        : cfg?.get?.('persona2.enabled', null);
      if (typeof value === 'boolean') personaTwo = value;
    } catch { personaTwo = null; }
    let hygiene = null;
    try {
      const value = cfg?.get?.('persona2.memoryHygiene', null);
      if (value && typeof value === 'object' && !Array.isArray(value)) hygiene = value;
    } catch { hygiene = null; }
    if (typeof modules?.memory?.searchChatMessages !== 'function' || !dataDir || personaTwo === null || !hygiene) {
      summary.recentMessages = { state: 'unavailable', count: 0, ids: [] };
      failedSources += 1;
    } else {
      try {
        const result = await modules.memory.searchChatMessages(query, {
          chatKey, dataDir, limit: 5, maxScan: 1000, personaTwo, hygiene
        });
        if (result?.ok !== true) {
          summary.recentMessages = { state: 'unavailable', count: 0, ids: [] };
          failedSources += 1;
        } else {
          const existing = new Set([
            ...(Array.isArray(context?.recent?.messages) ? context.recent.messages : []),
            ...(Array.isArray(evidence) ? evidence : []).map((row) => ({ mid: row?.id }))
          ].map(recentMessageIdentity));
          // ★ 2026-10-17（编排侧短期分界）：JEV 补取的近期原文也是发给模型的短期输入 ——
          //   先按同一轮冻结快照过滤，再走原有的身份去重。本轮触发 evidence 不走这条腿。
          const candidateRows = (Array.isArray(result.items) ? result.items : [])
            .slice(0, 5)
            .filter((row) => row && typeof row === 'object' && String(row.text ?? '').trim());
          const visibleCandidates = shortTerm && typeof shortTerm.filter === 'function'
            ? shortTerm.filter(candidateRows, (row) => row?.at ?? row?.ts).rows
            : candidateRows;
          for (const row of visibleCandidates) {
            const normalized = {
              localId: row.id ?? null, mid: row.mid ?? null, ts: row.at ?? null,
              senderId: String(row.senderId ?? ''), senderName: String(row.senderName ?? ''),
              self: row.self === true, text: String(row.text)
            };
            const key = recentMessageIdentity(normalized);
            if (existing.has(key)) continue;
            existing.add(key);
            recentMessages.push(normalized);
          }
          summary.recentMessages = {
            state: 'available', count: recentMessages.length,
            ids: recentMessages.map((row) => String(row.mid ?? row.localId ?? '')).filter(Boolean).slice(0, 5)
          };
          successfulSources += 1;
        }
      } catch (error) {
        summary.recentMessages = { state: 'unavailable', count: 0, ids: [] };
        failedSources += 1;
        log(logSink, 'warn', 'jev-recent-memory-search-failed', {
          chatKey, roundId, reason: String(error?.code ?? error?.name ?? 'memory-search-failed').slice(0, 80)
        });
      }
    }
  }

  const merged = mergeJevMemoryContext(context, { observations, recentMessages, crossChatItems, shortTerm });
  if (crossChatRequested && ['available', 'empty'].includes(summary.crossChat.state)) {
    summary.crossChat = {
      state: merged.crossChatAddedCount ? 'available' : 'empty',
      count: merged.crossChatAddedCount,
      ids: null
    };
  }
  summary.state = successfulSources === 0 ? 'unavailable'
    : failedSources > 0 ? 'partial'
      : summary.observations.count + summary.recentMessages.count + summary.crossChat.count > 0 ? 'retrieved' : 'empty';
  return {
    context: merged.context,
    summary
  };
}

function finalizeJevMainModelCall(run, finish) {
  const summary = run.turnPlan?.jevSummary;
  if (!summary) return;
  const reasonCode = String(run.turnPlan?.reason ?? '').split(':', 1)[0].trim();
  const admittedByJudge = reasonCode === 'JUDGE_JOIN' || reasonCode === 'JUDGE_CONTINUE';
  let calls = jevTokenCount(run.modelRounds);
  if (calls === null && run.stage !== 'compose') calls = jevTokenCount(finish?.modelRounds) ?? 0;
  summary.mainModelCall = {
    status: calls === null ? 'unavailable' : calls > 0 ? 'called' : 'not-called',
    calls,
    admittedByJudge,
    causedByJudge: calls === null ? null : admittedByJudge && calls > 0
  };
}

async function writeFinish(run, result) {
  if (run.finish !== null) return run.finish;
  run.finishRequested = { ...result };
  if (typeof run.recordMemoryOutcome === 'function' && !run.memoryOutcomePromise) {
    run.memoryOutcomePromise = Promise.resolve().then(() => run.recordMemoryOutcome()).catch((error) => {
      log(run.log, 'warn', 'memory-outcome-record-failed', {
        chatKey: run.chatKey, roundId: run.roundId, reason: String(error?.message ?? error).slice(0, 160)
      });
      return { ok: false, recorded: 0, persisted: false, reason: 'recordOutcome-threw' };
    });
    run.memoryOutcome = await run.memoryOutcomePromise;
  }
  const sendOutcomeUnknown = result.sendOutcomeUnknown === true || run.sendOutcomeUnknown === true;
  const finishCandidate = {
    ...(sendOutcomeUnknown ? {
      ...result,
      delivered: false,
      sentMessageCountKnown: false,
      unknownSendMessageCount: result.unknownSendMessageCount ?? run.unknownSendMessageCount ?? 0,
      sendOutcomeUnknown: true,
      composeOutcome: result.composeOutcome ?? 'delivery_unknown'
    } : { ...result }),
    ...(run.memeCue ? { memeCue: { ...run.memeCue }, memeCued: 1 } : {}),
    ...(run.memeCueSkip ? { memeCueSkip: String(run.memeCueSkip) } : {})
  };
  finalizeJevMainModelCall(run, finishCandidate);
  run.finish = Object.freeze({ ...finishCandidate, ...modelStageLedgerFields(run, finishCandidate) });
  if (!run.personaTurnNoted && run.modules?.emotion?.isPersonaTwo?.() === true) {
    run.personaTurnNoted = true;
    try { run.modules.emotion.noteTurn?.(); } catch { /* turn accounting must not break round closure */ }
  }
  recordDecisionLedger(run, run.finish);
  // ★ D-2 B：收轮 —— 追踪的最后一段、终态码、发送回执计数都在这里落。
  //   `finishTurn` 只返回 trace 自身（观测口没给也不强求），真正的读点是下面赋给 session 的那份。
  closeStage(run, traceStatusFor(run.finish.status), reasonCode(run.finish.reason) || String(run.finish.status ?? ''));
  if (run.trace && !run.trace.stages?.length) {
    // 一轮可能在任何一段真正跑起来之前就退出（暂停/中止/并发让位）⇒ 面板必须知道"停在哪、为什么"，
    // 不许留一张空白阶段表 —— 那正是 2026-10-06 深夜看到的「暂无阶段记录」。
    try {
      const token = run.obs?.startTurnStage?.(run.trace, 'participation_gate', { round: null, attempt: run.attempt, startedAt: run.startedAt });
      run.obs?.finishTurnStage?.(run.trace, token, {
        status: traceStatusFor(run.finish.status), code: reasonCode(run.finish.reason) || String(run.finish.status ?? '')
      });
    } catch { /* 观测不许反噬主链 */ }
  }
  let finishedTrace = null;
  try { finishedTrace = run.obs?.finishTurn?.(run.chatKey, run.roundId, traceStatusFor(run.finish.status)) ?? null; }
  catch { finishedTrace = null; }
  const trace = finishedTrace ?? run.trace ?? null;
  const registry = run.sessionRegistry;
  if (registry && run.sessionId) {
    try {
      const session = registry.peek?.(run.sessionId);
      if (session) {
        session.finishReason = String(run.finish.reason ?? run.finish.status ?? '');
        session.finishSummary = run.finish.finishSummary ?? null;
        session.finishSummarySource = run.finish.finishSummarySource ?? 'none';
        session.receipts = Array.isArray(run.finish.receipts) ? run.finish.receipts : [];
        session.deliveryResults = Array.isArray(run.finish.deliveryResults) ? run.finish.deliveryResults : [];
        session.composeOutcome = run.finish.composeOutcome ?? null;
        session.composeReason = run.finish.composeReason ?? null;
        session.bodyRecovery = run.finish.bodyRecovery ?? [];
        session.extraModelCalls = session.bodyRecovery.filter((row) => row.requestSent === true).length;
        session.delivered = run.finish.delivered === true && !sendOutcomeUnknown;
        session.error = run.finish.status === 'error' ? String(run.finish.error ?? run.finish.reason ?? '') : null;
        // ★ D-2 C：轮数要说真话。原先是 `Math.max(1, …)` ⇒ 真跑 4 轮也恒显 1 轮，
        //   而这正是主人查"为什么烧了 46,728 tok"时看到的那个数。口径与旧树
        //   `src/orchestrator.js:3398/3427 session.rounds = round + 1` 一致 = 模型实际走掉的轮数。
        session.rounds = Math.max(0, Number(run.modelRounds) || 0);
        session.sentMessageCount = Math.max(0, Number(run.finish.sentMessageCount) || 0);
        session.sentMessageCountKnown = run.finish.sentMessageCountKnown !== false && !sendOutcomeUnknown;
        session.unknownSendMessageCount = Math.max(0, Number(run.finish.unknownSendMessageCount ?? run.unknownSendMessageCount) || 0);
        session.sendOutcomeUnknown = sendOutcomeUnknown;
        session.bodySuppressed = run.finish.bodySuppressed === true;
        // ★ 2026-10-17：自动配图的"未知"单独落到会话（>0 才有键），不与文字投递混账。
        if (Number(run.finish.unknownStickerCount) > 0) {
          session.unknownStickerCount = Math.max(0, Number(run.finish.unknownStickerCount) || 0);
        }
        if (run.finish.memeCue) session.memeCue = { ...run.finish.memeCue };
        if (run.finish.memeCued === 1) {
          session.memeCued = 1;
          const cueText = String(run.finish.memeCue?.text ?? '').trim();
          const probe = cueText.slice(0, Math.min(8, cueText.length));
          const said = (Array.isArray(session.sent) ? session.sent : [])
            .map((entry) => String(entry?.text ?? '')).join('\n');
          session.memeAdopted = probe && said.includes(probe) ? 1 : 0;
          if (session.memeAdopted === 1) {
            try { modules.media?.markMemeAdopted?.(cueText); }
            catch (error) {
              log(run.log, 'warn', 'meme-cue-adoption-record-failed', {
                chatKey: run.chatKey, reason: String(error?.message ?? error).slice(0, 160)
              });
            }
          }
        }
        if (run.finish.memeCueSkip) session.memeCueSkip = String(run.finish.memeCueSkip);
        session.modelCallTrace = persistedModelCallTrace(run.finish.modelCallTrace ?? run.modelCallTrace);
        if (run.usage && typeof run.usage === 'object') {
          const usage = run.usage;
          const promptTokens = Number(usage.promptTokens) || 0;
          const completionTokens = Number(usage.completionTokens) || 0;
          session.usage = {
            promptTokens, completionTokens, totalTokens: promptTokens + completionTokens,
            cachedTokens: Number(usage.cachedTokens) || 0,
            cacheCreationTokens: Number(usage.cacheCreationTokens) || 0,
            calls: Math.max(0, Number(run.modelRounds) || 0)
          };
          session.webSearchCount = Number(usage.webSearchCount) || 0;
          session.model = String(usage.model ?? '');
        }
        session.turnPlan = run.turnPlan ?? session.turnPlan;
        // ★ D-2 B：UI 的「决策与执行追踪」读 trace.stages/actions/receipt/contextTier/source
        //   （apps/ui/app.js:5628-5645，键名是契约，不许改）。观测口没接上时退回原来的 6 键桩，
        //   面板至少还能看到 stage/outcome —— 但那时"暂无阶段记录"是真没记录，不是没接线。
        session.turnTrace = sessionTraceWithToolCalls(trace, {
          roundId: run.roundId, stage: run.stage, outcome: run.finish.status,
          reason: String(run.finish.reason ?? ''), startedAt: run.startedAt,
          endedAt: clockNow(run.clock)
        }, run.sessionActionDetails);
        // update() 的 2 秒节流返回 throttled:true 仍是成功；finish() 随后会无节流落最终态。
        const updated = registry.update?.(run.sessionId);
        if (updated && updated.ok === false) log(run.log, 'warn', 'session-update-failed', { chatKey: run.chatKey, roundId: run.roundId, error: updated.error });
      }
      const finished = registry.finish?.(run.sessionId, run.finish.status);
      if (finished && finished.ok === false) log(run.log, 'warn', 'session-finish-failed', { chatKey: run.chatKey, roundId: run.roundId, error: finished.persisted?.error ?? finished.error });
      // ★ S-4：`finish()` **写盘之后**才发 `session:ended`（契约要求）。收尾四键只在这一帧带。
      //   `finish()` 失败时也发（带着 error/finishReason）—— 卡片该看到"结束了但没写成功"，而不是永远转圈。
      emitSessionFrame(run, 'session:ended', { closing: true });
    } catch (error) {
      log(run.log, 'warn', 'session-finish-failed', { chatKey: run.chatKey, roundId: run.roundId, error: String(error?.message ?? error) });
    }
  }
  // 实盘可观测性：轮次结果必须落日志。2026-10-04 实盘发现
  // 「连上 QQ 但一个字都发不出去」正是因为没有这行——错误被 writeFinish 静默吞掉。
  const level = run.finish.status === 'error' ? 'error' : (run.finish.status === 'aborted' || run.finish.status === 'stopped') ? 'warn' : 'info';
  log(run.log, level, 'round-finished', {
    chatKey: run.chatKey, roundId: run.roundId, status: run.finish.status,
    stage: run.stage, reason: run.finish.reason, action: run.finish.action,
    memoryObservedCount: run.memoryObservation?.observed ?? 0,
    memoryQueuedCount: run.memoryObservation?.queued ?? 0,
    memoryObservePersisted: run.memoryObservation?.persisted === true,
    memoryObserveCursorMode: run.memoryObservation?.cursorMode || null,
    memoryObserveReason: run.memoryObservation?.reason || null,
    memoryOutcomeRecorded: run.memoryOutcome?.recorded ?? 0,
    memoryOutcomePersisted: run.memoryOutcome?.persisted === true,
    memoryOutcomeReason: run.memoryOutcome?.reason || null,
    delivered: run.finish.delivered === true && !sendOutcomeUnknown,
    deliveryReasons: run.finish.deliveryReasons, error: run.finish.error,
    receipts: run.finish.receipts, deliveryResults: run.finish.deliveryResults,
    finishSummary: run.finish.finishSummary, finishSummarySource: run.finish.finishSummarySource,
    composeOutcome: run.finish.composeOutcome, composeReason: run.finish.composeReason,
    // T-CUTOVER-3 第 8 条：模型轮数/正文长度要能在日志里直接看到（区分"模型空答"与"发送故障"）
    modelRounds: run.finish.modelRounds ?? run.modelRounds ?? 0,
    modelCallCount: run.finish.modelRounds ?? run.modelRounds ?? 0,
    sentMessageCount: run.finish.sentMessageCount ?? 0,
    sentMessageCountKnown: run.finish.sentMessageCountKnown !== false && !sendOutcomeUnknown,
    unknownSendMessageCount: run.finish.unknownSendMessageCount ?? run.unknownSendMessageCount ?? 0,
    sendOutcomeUnknown,
    bodySuppressed: run.finish.bodySuppressed === true,
    modelOutcome: run.finish.modelOutcome ?? null,
    policyOutcome: run.finish.policyOutcome ?? null,
    blockReason: run.finish.blockReason ?? null,
    modelToolCalls: run.finish.modelToolCalls ?? run.modelToolCalls ?? 0,
    modelCallReasons: run.finish.modelCallReasons ?? run.modelCallReasons ?? [],
    modelCallTrace: run.finish.modelCallTrace ?? run.modelCallTrace ?? [],
    repeatBlocks: run.finish.repeatBlocks ?? run.repeatBlocks ?? 0,
    replyChars: run.finish.replyChars, composeGuard: run.finish.composeGuard,
    bodyOutputDrops: run.finish.bodyOutputDrops ?? [], attempt: run.finish.attempt,
    bodyRecovery: run.finish.bodyRecovery ?? [],
    bodyRecoveryUsed: Array.isArray(run.finish.bodyRecovery) && run.finish.bodyRecovery.some((row) => Number(row?.messages) > 0),
    // T-G21 第 4 条：主动轮必须能从日志里回答"它为什么突然说话"（lane/source 来自 M2 的 classifyTurnLane）。
    // 普通入站轮不加这几个键 ⇒ 既有日志形状逐字节不变。
    ...(run.proactive ? { proactive: true, proactiveReason: run.proactiveReason, lane: run.lane, source: run.source } : {})
  });
  return run.finish;
}

function planReason(code, message) { return `${code}: ${message}`; }

/** 轮次终态 → trace 的 outcome 枚举（core/observability/trace.js 的 STAGE_STATUSES，口径不动）。
 *  具体是哪一种终态（delivered/skipped/aborted/…）写在最后一段的 code 与 finishReason 里。 */
function traceStatusFor(status) {
  const value = String(status ?? '');
  if (value === 'error') return 'error';
  if (value === 'delivered' || value === 'completed') return 'ok';
  return 'skipped';
}

/** 从 reason 里取机器可读的前缀码（`COMPOSE_EMPTY: …` → `COMPOSE_EMPTY`），供 trace 的 stage.code 用。 */
function reasonCode(reason) {
  const text = String(reason ?? '');
  const code = text.split(':')[0].trim();
  return /^[A-Z][A-Z0-9_]{2,}$/.test(code) ? code : '';
}

/**
 * 「这一轮为什么没按预期发出去」要说得出区别（D-2 A + P0-2b B 件）。
 *
 * ★ B 件（2026-10-08）：**只接线，不改判定**。成不成功、算不算沉默，全在 compose.js 的
 *   转移表 `decideComposeTransition`（B.6）里判；这里只把 compose 已经给出的
 *   `outcome` / `reason` 逐值映射成外层会话的**原因码**（`reasonCode()` 取前缀进
 *   trace.stage.code 与面板）。**判不出来的值一律落 `COMPOSE_UNCLASSIFIED`（未知），
 *   不许硬塞成最接近的那个。**
 *
 * 四种病各自有码（此前全挤成"没发出去"）：
 *   规划跳过  → 不进这里：`plan.action` 是 skip/wait 时在上面 :932 就 `status:'skipped'` 返回了
 *   它不说话  → COMPOSE_SILENT（本轮不要求回复、模型也没给话）
 *   卫生链    → COMPOSE_GUARD（它写了话，守卫判定这句不该发）
 *   平台失败  → SEND_NOT_CONFIRMED / SEND_FAILED（话已交回发送，回执/核验没过）
 *   正文未发  → COMPOSE_BODY_INTERNAL（正文仅作内部上下文，必须用 send_message 才能发言）
 *   预算耗尽  → COMPOSE_EMPTY（口径与旧码一致，D-2 的既有牙不动）
 */
/** 「安静」允许的守卫值：空白正文与安静协议都是"没给可发的话"，不是"写了但不该发"。 */
const SILENCE_GUARDS = new Set(['empty', 'quiet-protocol']);
/** incomplete 里属于「机会用尽」的那一族 ⇒ 沿用 COMPOSE_EMPTY（轮数上限 / 唯一一次收口被用掉）。 */
const BUDGET_EXHAUSTED_REASONS = new Set(['model-call-limit', 'closeout-requested-tools',
  'required-output-missing', 'tool-budget-closeout', 'duplicate-completed-output-suppressed',
  // ★ 2026-10-09 00:5x 指挥位补：A26 之后"收口轮模型又要点工具"也是**预算耗尽**的同一病因
  //   （`compose.js:528-533` 直接终止）—— 原来它落到 `COMPOSE_UNCLASSIFIED`（"判不出来的未知"），
  //   把"预算被工具吃掉"误报成"无法归类"。**这正是那条牙一直在测的行为**。
  'closeout-requested-non-send-tool',
  // ★ 同上：工具轮把收口机会占满、没有发言位了 —— 同属"预算耗尽"，不是"无法归类"。
  'tool-loop-without-reply-slot']);
/**
 * ★ 2026-10-19（N1）：上述 reason 只是"本轮机会用尽"，**不等于每日付费硬额度耗尽** ——
 *   用户看到所有结束都被写成"预算耗尽"，分不清"模型轮次用完 / 工具与收口名额用完 /
 *   模型没给正文 / 每日硬额度不足 / 主动沉默"。这里按真实病因逐档给标签（码仍是 COMPOSE_EMPTY，
 *   会话终态词汇表不变；实际每日硬额度/提供商余额走 `budget:*` 错误与 COMPOSE 之外的错误路径）。
 */
const OPPORTUNITY_EXHAUSTED_LABELS = new Map([
  ['model-call-limit', '模型往返轮次用尽（api.maxRounds；不是每日额度）'],
  ['closeout-requested-tools', '收口轮里模型又请求了工具（收口名额被占用）'],
  ['closeout-requested-non-send-tool', '收口轮里模型调用了非发送工具（收口失败）'],
  ['tool-budget-closeout', '工具/收口轮次用尽（不是每日额度）'],
  ['tool-loop-without-reply-slot', '重复工具循环，没留出回复位'],
  ['required-output-missing', '模型未产出可发送正文（未调用发送工具）'],
  ['duplicate-completed-output-suppressed', '重复输出被抑制，未产生新正文']
]);
/** incomplete 的其它 reason 前缀 → 各自的码（不挤进 COMPOSE_EMPTY，病因不同修法也不同）。 */
const INCOMPLETE_REASON_CODES = new Map([
  ['identical-tool-failure', 'COMPOSE_TOOL_LOOP'],
  ['required-outputs-missing', 'COMPOSE_OUTPUTS_MISSING'],
  ['aborted', 'COMPOSE_ABORTED'],
  // ★ 2026-10-09 00:5x 指挥位补：工具轮把收口机会占满（`compose.js:725`，格式 `名字:重复工具名`）
  //   ⇒ 病因是"预算被工具吃掉"，与 `closeout-requested-tools` 同族 ⇒ 沿用 `COMPOSE_EMPTY`。
  //   放在这里而不是 BUDGET_EXHAUSTED_REASONS，是因为**它是带参数的 reason**（比对的是前缀）。
  ['tool-loop-without-reply-slot', 'COMPOSE_EMPTY']
]);

/**
 * ★ 导出理由（不是"为了测试而导出"）：这张 outcome→码 的表**就是会话终态词汇表的源头**，
 *   下一步的 UI 词汇表（`apps/ui/status-vocab.js`）与 replay 夹具要逐值对账，必须有一个可对账的入口。
 *   端到端只覆盖得到"生产 compose 真会给出的 outcome"；`COMPOSE_UNCLASSIFIED` / `COMPOSE_UNKNOWN`
 *   两档（判不出来 ⇒ 如实落未知）端到端构造不出来 ⇒ 只有直接逐值打这张表才有牙。
 */
export function undeliveredReason(composed, plan, sent = {}, limits = {}) {
  if (!composed) return plan.reason;                 // 没进 compose（规则工具/不要求发言）：口径逐字节不变
  const outcome = String(composed.outcome ?? '');
  const inner = String(composed.reason ?? '');
  const guard = composed.guard ? String(composed.guard) : '';
  // ★ 2026-10-19（N1）：把**实际生效的模型轮次上限**带进人话 —— 用户看到"两次就结束"时，
  //   能直接分辨是 api.maxRounds 配得小、还是工具/收口名额、还是每日额度（后者走 budget:* 错误）。
  const maxRoundsLimit = Number.isFinite(Number(limits.maxRounds)) && Number(limits.maxRounds) > 0
    ? Math.floor(Number(limits.maxRounds)) : 0;
  const roundsLimitText = maxRoundsLimit ? `（上限 api.maxRounds=${maxRoundsLimit}）` : '';
  const rounds = `轮数 ${Number(composed.modelRounds) || 0}${roundsLimitText}，工具 ${Number(composed.toolCalls) || 0} 次`;
  const why = Array.isArray(sent.reasons) && sent.reasons.length ? `；核验理由：${sent.reasons.join('；')}` : '';
  // ① 安静：compose 判的是"这一轮它可以不说"。空白/安静协议算不说，规划腔/截断半句不算（那是②）。
  if (outcome === 'silent' && (!guard || SILENCE_GUARDS.has(guard))) {
    const silence = inner === 'body-judge-skip' ? '正文裁判判为内部思考，不补发'
      : guard === 'quiet-protocol' ? '模型明确选择静默' : '模型没有输出正文';
    return planReason('COMPOSE_SILENT', `${silence}${guard ? `（${guard}）` : ''}，${rounds}`);
  }
  // ② 卫生链拦下（既有档，优先级保持在最前：既有牙钉的就是它）
  if (inner === 'empty-model-response') return planReason('COMPOSE_EMPTY', `模型返回空正文（${rounds}）`);
  if (guard) return planReason('COMPOSE_GUARD', `${guard}（正文被守卫拦下，未发送）`);
  // ③ 模型自己声明收尾却没留正文（既有档）
  if (composed.finished && !composed.text && !composed.receipt) {
    return planReason('COMPOSE_FINISHED_NO_TEXT', `模型调 finish 声明收尾但没给出正文（${rounds}）`);
  }
  switch (outcome) {
    case 'skipped':                                    // responsePolicy=none：本轮不要求回复（≠①，那是它选了沉默）
      return planReason('COMPOSE_POLICY_SKIPPED', `本轮不要求回复（responsePolicy=none，${rounds}）`);
    case 'delivery_unknown':                            // 发没发出去**不确定**：既不能说没发，也不能说发了
      return planReason('COMPOSE_DELIVERY_UNKNOWN', `工具回执状态未知（${inner}），无法确认是否送达（${rounds}）`);
    case 'partial':                                     // 只补齐了一部分任务输出
      return planReason('COMPOSE_PARTIAL', `只发出了一部分（compose 判 partial：${inner}，${rounds}）`);
    case 'incomplete': {
      const prefix = inner.split(':')[0];
      if (BUDGET_EXHAUSTED_REASONS.has(inner)) {
        // ★ 2026-10-19（N1）：不再把所有"机会用尽"伪称"预算耗尽" —— 按真实病因给标签，
        //   码仍是 COMPOSE_EMPTY（终态词汇表不变）。文案保留机器可读内码与旧牙认可的
        //   `compose 判 incomplete：` 前缀，格式固定为
        //   `…（机会用尽：<inner>=<人话>；轮数 N，工具 M 次）`，UI（status-vocab）按 `机会用尽：` 解析。
        const label = OPPORTUNITY_EXHAUSTED_LABELS.get(inner) ?? '';
        return planReason('COMPOSE_EMPTY', `compose 判 incomplete：模型没给出可发送正文（机会用尽：${inner}${label ? `=${label}` : ''}；${rounds}）`);
      }
      const code = INCOMPLETE_REASON_CODES.get(prefix);
      if (code) {
        // ★ 2026-10-19（N1）：带参数的 reason（如 `tool-loop-without-reply-slot:<工具名>`）也补人话标签。
        const extraLabel = OPPORTUNITY_EXHAUSTED_LABELS.get(prefix);
        return planReason(code, `compose 判 incomplete：${inner}${extraLabel ? `（${extraLabel}）` : ''}（${rounds}）`);
      }
      return planReason('COMPOSE_UNCLASSIFIED', `compose 判 incomplete 但 reason 不在枚举表里：${inner || '（空）'}（${rounds}）`);
    }
    case 'drafted':
      return planReason('COMPOSE_BODY_INTERNAL', `模型正文仅留在内部，没有调用 send_message；本轮未发送正文（${rounds}）`);
    case 'sent':
      return composed.receipt?.ok
        ? planReason('SEND_NOT_CONFIRMED', `发送回执已给出但核验未确认${why}`)
        : planReason('SEND_FAILED', `工具消息已交回发送，但 M10 没给成功回执${why}`);
    default:                                            // ★ 未知值如实落"未知"，不硬塞成最接近的那个
      return planReason('COMPOSE_UNKNOWN', `compose 没给出可判定的 outcome（实得 ${outcome || '（缺失）'}，reason=${inner || '（缺失）'}，${rounds}）`);
  }
}

/** `session.sent[].at` 与旧树同形（可读时刻串，UI 直接打印；时间只从注入的 clock 取）。 */
function sentStamp(at) {
  const ms = Number(at);
  if (!Number.isFinite(ms)) return '';
  try { return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false }); } catch { return String(ms); }
}

/** 发送条目的类型（UI 的 `trace.receipt.types` 与「已发送到 QQ」分类靠它；回执本身不带类型）。 */
function sentTypeOf(toolName) {
  const name = String(toolName ?? '');
  if (name.includes('sticker')) return 'sticker';
  if (name.includes('image') || name.includes('media') || name.includes('music')) return 'image';
  return 'text';
}

/**
 * ★ D-2 B：轮次追踪的阶段开合。阶段名用 UI 词表（apps/ui/app.js 的 stageLabels），
 * `run.stage` 保持原口径不动（日志字段与旧形状依赖它）。
 * 观测口缺了或抛了都不许打断消息路径 —— 追踪是诊断，不是主链。
 */
function runStage(run, name, options = {}) {
  closeStage(run, 'ok', '');
  const obs = run.obs;
  if (!obs || !run.trace) { run.stageToken = null; return; }
  try {
    run.stageToken = obs.startTurnStage?.(run.trace, name, {
      round: options.round ?? null, attempt: run.attempt, startedAt: clockNow(run.clock)
    }) ?? null;
  } catch { run.stageToken = null; }
}

function closeStage(run, status = 'ok', code = '') {
  const token = run?.stageToken;
  if (run) run.stageToken = null;
  if (!token || !run?.obs || !run.trace) return;
  try { run.obs.finishTurnStage?.(run.trace, token, { status, code }); } catch { /* 观测不反噬 */ }
}

/** 扩展钩子（M12 出口）永远不许打断消息路径；缺模块/抛错都当"没这个钩子"。 */
async function safeHook(modules, name, payload, logSink) {
  const fn = modules?.extensions?.[name];
  if (typeof fn !== 'function') return null;
  try {
    return await fn(payload);
  } catch (error) {
    log(logSink, 'debug', 'runtime-hook-failed', { hook: name, error: String(error?.message ?? error) });
    return null;
  }
}

function emotionEventKey(event) {
  const key = [
    event?.type, event?.evidenceIds ?? [], event?.source ?? '', event?.personId ?? '',
    event?.slot ?? '', event?.claim ?? '', event?.deltas ?? {}, event?.offsets ?? {},
    event?.tool ?? '', event?.ok ?? null, event?.type === 'clock' ? event?.at : null
  ];
  // ★ 2026-10-15 回修（复核 §4）：零证据轮（proactive/空入站）的 round 事件没有 evidenceIds 可区分，
  //   必须附加轮身份，否则内存去重（appliedEmotionEvents）会把后续每一轮都误吞成"已应用"。
  //   只对这类事件追加 —— 带证据的键与之前逐位相同（重试轮的既有去重语义不动）。
  if (event?.type === 'round' && !(Array.isArray(event.evidenceIds) && event.evidenceIds.length)) {
    key.push('round', String(event?.roundId ?? ''), Number(event?.at) || 0);
  }
  return JSON.stringify(key);
}

/**
 * 回复了机器人自己发过的消息吗（`refs.replyTo` 命中本轮 `botSaidBefore` 的 id）。
 * 与 contextTierGate:868-874 的 `repliedToKnownBotMessage` 同一判据 —— 只在 id 确实指向机器人
 * 自己的消息时成立（不是猜）；用来补"引用内容解析不到、但 QQ 回复目标就是机器人"的 engaged 轮。
 */
function repliesToKnownBotMessage(row) {
  const replyTo = row?.refs?.replyTo && typeof row.refs.replyTo === 'object'
    ? row.refs.replyTo.id : row?.refs?.replyTo;
  if (replyTo == null || String(replyTo) === '') return false;
  return (Array.isArray(row?.botSaidBefore) ? row.botSaidBefore : [])
    .some((message) => String(message?.id ?? '') === String(replyTo));
}

/**
 * 轮内自我称呼名单（ingest 与情绪 cue 共用一处；口径 = 老树 mentionsBot 的名字来源 + 本仓既有拼接）。
 */
function resolveEmotionSelfNames(cfg) {
  const configuredNames = readConfig(cfg, 'selfNames', []);
  return [...new Set([
    ...(Array.isArray(configuredNames) ? configuredNames : []),
    readConfig(cfg, 'persona.selfNickname', ''), readConfig(cfg, 'onebot.selfNickname', ''),
    readConfig(cfg, 'persona.botName', ''),
    ...LEGACY_BOT_ACCOUNT_NAMES
  ].filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim()))];
}

/**
 * 入站情绪 cue（2026-10-15 · 用户裁定「情绪缺口第一组」）。
 *
 * 改前：两条硬编码正则（谢意 ⇒ gratitude+joy 2/2；辱骂 ⇒ anger+irk 2/2），且**没有指向性判据**
 *   ⇒ 别人互骂会被记到机器人头上，同类消息每条都叠一次（独立复核 §2/§3 已证）。
 * 改后：走 M7 的 `recognizeInboundCue`（老树词表降级移植 + addressed/selfRef 过滤，逐表留痕），
 *   逐 kind 出一颗事件（`kind` 供 M7 的同 kind 冷却做时间窗）。证据门槛、自消息/忽略名单、
 *   `persistedIds` 判据全部保持原样；日志只记表名与原因，不落聊天原文。
 */
function explicitEmotionEvents({ at, evidence, persistedIds, selfId = '', ignoreSenderIds = [], selfNames = [], kind = 'group', logSink = null, chatKey = '', roundId = '' }) {
  const events = [];
  const cueKinds = [];
  // ★ 2026-10-15 回修（复核 §5-2）：私聊里每条消息都是对机器人说的 ⇒ 整轮按"被指向"处理
  //   （老树 src/orchestrator.js:4514 与 compose.js:1717 的 addressedToBot 都带 kind==='private'）；
  //   群聊继续只用三字段判据 —— 旁人互骂不记到机器人头上。
  const privateChat = String(kind) === 'private';
  const ignored = new Set((Array.isArray(ignoreSenderIds) ? ignoreSenderIds : []).map(String));
  for (const row of Array.isArray(evidence) ? evidence : []) {
    const id = String(row?.id ?? '').trim();
    const senderId = String(row?.sender?.id ?? row?.senderId ?? '').trim();
    const text = String(row?.text ?? '').trim();
    if (!id || !persistedIds.has(id) || !text || (selfId && senderId === selfId) || ignored.has(senderId)) continue;
    // 指向性：与 contextTierGate:865-866 / compose.js:1717 同一判据（这条消息是否冲着机器人），
    // ★ 回修（复核 §5-3 / §1）：补「回复了机器人自己发过的消息」这一结构化信号 —— 文本昵称 @
    //   与可解析的引用已由 M5 折进 refs.toSelf（scenario/inbound.js:228-235），这里只补
    //   "回复目标 id 确实在 botSaidBefore 里"的那一类；id 相等才成立，不猜。
    const rowAddressed = row?.toSelf === true || row?.refs?.toSelf === true
      || (Array.isArray(row?.mentions) && row.mentions.some((mention) => mention?.isSelf === true))
      || repliesToKnownBotMessage(row);
    const addressed = privateChat || rowAddressed;
    const cue = recognizeInboundCue({ text, addressed, selfNames });
    if (!cue.kinds.length) {
      if (cue.matched.length) {
        log(logSink, 'debug', 'emotion-cue-dropped', {
          chatKey, roundId, evidenceId: id, addressed, ...(privateChat ? { privateChat: true } : {}),
          matched: cue.matched.map(({ table, kind: droppedKind, dropped }) => ({ table, kind: droppedKind, dropped }))
        });
      }
      continue;
    }
    log(logSink, 'info', 'emotion-cue-recognized', {
      chatKey, roundId, evidenceId: id, addressed, selfRef: cue.selfRef === true,
      ...(privateChat ? { privateChat: true } : {}),
      kinds: cue.kinds,
      matched: cue.matched.map(({ table, kind: matchedKind, kept, dropped }) => ({ table, kind: matchedKind, kept, ...(dropped ? { dropped } : {}) }))
    });
    for (const cueKind of cue.kinds) {
      if (!cueKinds.includes(cueKind)) cueKinds.push(cueKind);
      const deltas = inboundCueDeltas([cueKind]);
      if (!Object.keys(deltas).length) continue;
      events.push({
        type: 'emotionEvidence', at, evidenceIds: [id], senderId, source: 'emotion-evidence', magnitude: 1,
        kind: cueKind, deltas
      });
    }
  }
  return { events, cueKinds };
}

function lifeFactEvents({ at, rows, evidence, persistedIds }) {
  const categoryByType = { preference: 'preference', fact: 'episode', trait: 'tone', impression: 'impression' };
  const events = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.tool !== 'memory_append' || row?.ok !== true || row?.data?.saved !== true
      || row?.data?.duplicate === true) continue;
    const observation = row.data.observation;
    const personId = String(observation?.subjectId ?? '').trim();
    const claim = String(observation?.claim ?? '').trim();
    const slot = String(observation?.type ?? '').trim();
    const category = categoryByType[String(observation?.type ?? '')];
    const evidenceIds = [...new Set((Array.isArray(evidence) ? evidence : [])
      .filter((entry) => String(entry?.sender?.id ?? entry?.senderId ?? '') === personId
        || (Array.isArray(entry?.mentions) && entry.mentions.some((mention) => String(mention?.id ?? '') === personId)))
      .map((entry) => String(entry?.id ?? '').trim())
      .filter((id) => id && persistedIds.has(id)))];
    if (!personId || !claim || claim.length > 120 || !slot || slot.length > 64
      || !category || !evidenceIds.length) continue;
    events.push({ type: 'lifeFact', at, evidenceIds, source: 'tool', slot, claim, category, personId });
  }
  return events;
}

function calendarEvents({ at, rows, evidence, persistedIds }) {
  const savedReminder = (Array.isArray(rows) ? rows : []).some((row) => row?.tool === 'memory_todo_save'
    && row?.ok === true && row?.data?.saved === true && row?.data?.deduped !== true);
  const evidenceIds = [...new Set((Array.isArray(evidence) ? evidence : [])
    .map((entry) => String(entry?.id ?? '').trim())
    .filter((id) => id && persistedIds.has(id)))];
  // A newly saved reminder is a concrete calendar commitment; the +1 offset is a small
  // recovery-target nudge and never edits the current cognitive pool.
  return savedReminder && evidenceIds.length
    ? [{ type: 'calendar', at, evidenceIds, source: 'calendar', offsets: { cognitive: 1 } }]
    : [];
}

/**
 * 情绪事件收口（T-CUTOVER-4 B3：**唯一 owner = M15**）。
 *
 * 为什么是 M15：一轮里同时握着证据、上下文、计划、发送回执、记忆落库的只有它；旧树唯一的常规
 * 写入点也在编排层（`src/orchestrator.js:4373`）。M7 保持纯状态模型（不读时钟、不碰盘）。
 *
 * 纪律：情绪**绝不影响主线** —— 事件被 M7 拒（形状不对/重复）只记日志；落盘失败也只记日志。
 * `relationDelta` 只从已完成的 `memory_favor` 写请求回执派生；仍需完整证据与 M7 原校验通过。
 *
 * 返回 `{ appliedEvents, flushed }`：调用方（轮末 finally）据此发 `emotion-relation-delta-applied`
 * 真落账信号 —— 工具回执那一刻不知道会不会落账（写发生在这里），所以信号只能由这一层发。
 * `flushed` 只在 flush 回执 `ok===true` 且没有 `skipped` 时为真（没写成盘就不许喊落账）。
 */
function absorbEmotion({ modules, logSink, events, chatKey, roundId, hasEvidence, appliedKeys }) {
  const emotion = modules?.emotion;
  if (typeof emotion?.applyEvent !== 'function' || !events.length) return { appliedEvents: [], flushed: false };
  const appliedEvents = [];
  for (const event of events) {
    const needsEvidence = ['emotionEvidence', 'toolResult', 'lifeFact', 'calendar', 'relationDelta'].includes(event?.type);
    const key = emotionEventKey(event);
    if (appliedKeys?.has(key)) continue;
    try {
      if (needsEvidence) {
        if (typeof hasEvidence !== 'function' || !Array.isArray(event.evidenceIds)
          || event.evidenceIds.some((id) => hasEvidence(id) !== true)) {
          log(logSink, 'warn', 'emotion-event-rejected', { chatKey, roundId, type: event?.type, reason: 'evidence-not-in-ledger' });
          continue;
        }
      }
      if (typeof emotion.validateEvent === 'function') {
        const validation = emotion.validateEvent(event, { hasEvidence });
        if (validation?.ok !== true) {
          log(logSink, 'warn', 'emotion-event-rejected', {
            chatKey, roundId, type: event?.type, reason: (validation?.errors ?? []).join('; ').slice(0, 200)
          });
          continue;
        }
      } else if (needsEvidence) {
        log(logSink, 'warn', 'emotion-event-rejected', { chatKey, roundId, type: event?.type, reason: 'event-validator-unavailable' });
        continue;
      }
      emotion.applyEvent(event);
      appliedEvents.push(event);
      if (appliedKeys) {
        appliedKeys.add(key);
        if (appliedKeys.size > 4096) appliedKeys.delete(appliedKeys.values().next().value);
      }
    } catch (error) {
      log(logSink, 'warn', 'emotion-event-rejected', { chatKey, roundId, type: event?.type, error: String(error?.message ?? error) });
    }
  }
  let flushed = false;
  if (appliedEvents.length && typeof emotion.flush === 'function') {
    try {
      const result = emotion.flush();
      flushed = result?.ok === true && !result?.skipped;
      if (result && result.ok === false) log(logSink, 'warn', 'emotion-flush-skipped', { chatKey, roundId, ...result });
    } catch (error) {
      log(logSink, 'error', 'emotion-flush-failed', { chatKey, roundId, error: String(error?.message ?? error) });
    }
  }
  return { appliedEvents, flushed };
}

/**
 * memory_favor 执行器只回报「已暂存、等待 M15 记账」；这里把它转成 M7 事件。
 *
 * ★★ 2026-10-11 晚（用户裁定 · B10 撤门槛 · 指挥位放行接线）：**理由原样透传，不再分类。**
 *   用户原话："好感就是 LLM 自己决定的，他有权决定自己对谁好对谁坏；吵架、争执、意见不同
 *   本身就是会掉好感的" ⇒ 对齐老树 `src/tools.js:2282`（自由文本理由 + setFavor 直接写）。
 *   · `reason` = 模型原话（≤60 字，照老树 `src/memory.js:1742` 的 slice(0,60) 口径）；
 *     **正负与幅度只听 `delta`** —— 本函数不改符号、不改幅度、不因文案拒写；
 *   · `favor-reason.js` 归类器已降级为兜底/标签（UI/日志解释分组用）⇒ **不再出现在这条链上**；
 *   · 跳过只剩**真失败**：工具回执不齐（没 personId / delta=0 / 没 reason / 本轮没有可用证据）
 *     ⇒ `incomplete-tool-evidence`；事件过不了 M7 契约 ⇒ `event-contract-invalid`。
 *     「归不进七类」「永不计分语」两种 reasonCode 已随 B10 废除，不再产出。
 */
function relationDeltaFromMemoryFavor(row, { at, chatKey, roundId, evidence, modules, logSink }) {
  if (String(row?.tool ?? '') !== 'memory_favor') return null;
  if (row?.ok !== true || row?.state !== 'completed') return null;

  const data = row?.data;
  if (data?.mode !== 'write' || data?.written !== false) return null;
  const personId = String(data.userId ?? '').trim();
  const rawDelta = data.requestedDelta;
  const delta = Number(rawDelta);
  const reasonText = String(data.reason ?? '').trim();
  const evidenceIds = [...new Set((Array.isArray(evidence) ? evidence : [])
    .filter((entry) => validateMessageEvidence(entry).ok)
    .map((entry) => String(entry?.id ?? '').trim())
    .filter(Boolean))];
  // 真失败门（B10 后只剩这些）：回执不齐 ⇒ 不产事件。**没有"归不进类别"这一条了**。
  if (!personId || rawDelta === null || rawDelta === undefined || String(rawDelta).trim() === ''
    || !Number.isFinite(delta) || delta === 0 || !reasonText || evidenceIds.length === 0) {
    log(logSink, 'info', 'emotion-relation-delta-skipped', {
      chatKey, roundId, via: 'memory_favor', reasonCode: 'incomplete-tool-evidence',
      hasPerson: !!personId, hasDelta: Number.isFinite(delta) && delta !== 0, hasReason: !!reasonText,
      evidenceCount: evidenceIds.length
    });
    return null;
  }

  const event = {
    type: 'relationDelta', at, personId, changes: { favor: delta }, reason: reasonText.slice(0, 60),
    evidenceIds, source: 'tool', roundId,
    idempotencyKey: `memory-favor:${roundId}:${String(row?.idempotencyKey ?? `${personId}:${evidenceIds[0]}`)}`
  };
  const validate = modules?.emotion?.validateEvent;
  if (typeof validate === 'function') {
    try {
      if (validate(event)?.ok !== true) {
        log(logSink, 'info', 'emotion-relation-delta-skipped', {
          chatKey, roundId, via: 'memory_favor', reasonCode: 'event-contract-invalid', reasonChars: reasonText.length
        });
        return null;
      }
    } catch {
      log(logSink, 'info', 'emotion-relation-delta-skipped', { chatKey, roundId, via: 'memory_favor', reasonCode: 'event-contract-check-failed' });
      return null;
    }
  }
  return event;
}

/**
 * 模型自评（`finish` 回执里的 mood / favorDelta）→ M7 情绪事件。
 *
 * ★ 2026-10-11（指挥位派单 · 用户第 2 条）：老树"独立自评轮 → mood/favorDelta"在新树整条丢失
 *   （glm 只读审计：ledger 200 行 source=emotion-evidence 仅 4、101/189 行 delta=0、无
 *   self.mood 行 ⇒ 用户说话推不动情绪）。老树算法（src/orchestrator.js:4543 applyRunToBotState
 *   + src/tools.js:3414-3492 finish.execute）：
 *     · `mood` 归一后查 `parseEmotionTags` → kind 列表 → `appraiseAndAct` 逐 kind 数值表；
 *     · `favorDelta` 两条腿：① 正负 ⇒ 心情 +4/-3（applyRunToBotState:1152-1155）；
 *       ② 写好感本身（finish.execute:3470-3488 setFavor，理由取 summary，±8 夹取）。
 *   新树落地：逐 kind 数值表与 mood 归一搬进 `emotion/mood-tags.js`（纯函数，本文件只做装配）；
 *   好感走 `relationDelta`（B10 撤门槛后理由 = summary 原话，不分类、归不进也计分）。
 *
 * ★ 不许伪造：模型没调 finish / 没给 mood / favorDelta 缺失 ⇒ 一个事件都不产，且日志说清为什么。
 */
function normalizedMemoryClaim(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function selfEvalMemoryCandidate(data, { at, chatKey, roundId, evidence, logSink }) {
  const base = { chatKey, roundId, source: 'finish-self-eval' };
  if (data?.writeMemory === false) {
    log(logSink, 'info', 'self-eval-memory-write', { ...base, outcome: 'skipped', reasonCode: 'not-requested' });
    return null;
  }
  if (data?.writeMemory !== true) {
    const missing = data?.writeMemory === undefined;
    log(logSink, missing ? 'info' : 'warn', 'self-eval-memory-write', {
      ...base, outcome: 'skipped', reasonCode: missing ? 'write-memory-flag-missing' : 'invalid-write-memory-flag'
    });
    return null;
  }

  const rawClaim = String(String(data.impression ?? '').trim() || data.summary || '').trim().replace(/\s+/g, ' ');
  if (!rawClaim) {
    log(logSink, 'warn', 'self-eval-memory-write', { ...base, outcome: 'skipped', reasonCode: 'self-eval-content-empty' });
    return null;
  }
  // 印象入口沿用记忆模块既有 160 字上限（editPersonImpressions / memory_append）；截断必须可见。
  const claim = rawClaim.slice(0, 160);
  if (claim.length !== rawClaim.length) {
    log(logSink, 'warn', 'self-eval-memory-write', {
      ...base, outcome: 'truncated', reasonCode: 'impression-char-limit', inputChars: rawClaim.length, storedChars: claim.length
    });
  }
  const validEvidence = (Array.isArray(evidence) ? evidence : []).filter((entry) => validateMessageEvidence(entry).ok);
  const primarySender = [...validEvidence].reverse()
    .map((entry) => String(entry?.sender?.id ?? entry?.senderId ?? '').trim())
    .find(Boolean) ?? '';
  if (!primarySender) {
    log(logSink, 'warn', 'self-eval-memory-write', { ...base, outcome: 'skipped', reasonCode: 'no-target-person' });
    return null;
  }
  const sourceRows = validEvidence.filter((entry) => String(entry?.sender?.id ?? entry?.senderId ?? '').trim() === primarySender);
  const evidenceIds = [...new Set(sourceRows.map((entry) => String(entry?.id ?? '').trim()).filter(Boolean))];
  if (!evidenceIds.length) {
    log(logSink, 'warn', 'self-eval-memory-write', { ...base, outcome: 'skipped', reasonCode: 'target-evidence-missing' });
    return null;
  }
  const kind = sourceRows.at(-1)?.kind === 'private' ? 'private' : 'group';
  const id = `finish-self-eval:${String(roundId ?? 'round')}:${primarySender}`;
  return {
    id,
    observation: {
      id, subjectId: primarySender, claim, evidenceIds,
      scope: kind, chatKey, kind, type: 'impression', confidence: 0.5,
      at: Number(at)
    },
    evidence: sourceRows,
    subjectId: primarySender,
    claim,
    scope: kind
  };
}

async function commitSelfEvalMemories(candidates, { modules, bus, memoryAppendRows, chatKey, roundId, logSink }) {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const sameToolWrite = (Array.isArray(memoryAppendRows) ? memoryAppendRows : []).find((row) => {
      const observation = row?.data?.observation;
      return observation && String(observation.subjectId ?? '') === candidate.subjectId
        && (!observation.scope || String(observation.scope) === candidate.scope)
        && normalizedMemoryClaim(observation.claim) === normalizedMemoryClaim(candidate.claim);
    });
    if (sameToolWrite) {
      log(logSink, 'info', 'self-eval-memory-write', {
        chatKey, roundId, source: 'finish-self-eval', outcome: 'skipped',
        reasonCode: 'memory-append-same-claim', duplicateTool: 'memory_append'
      });
      continue;
    }
    if (typeof modules?.memory?.commit !== 'function') {
      log(logSink, 'warn', 'self-eval-memory-write', {
        chatKey, roundId, source: 'finish-self-eval', outcome: 'skipped', reasonCode: 'memory-commit-unavailable'
      });
      continue;
    }
    try {
      const result = await modules.memory.commit(candidate.observation, {
        evidence: candidate.evidence,
        idempotencyKey: candidate.id
      });
      if (result?.ok !== true) {
        log(logSink, 'warn', 'self-eval-memory-write', {
          chatKey, roundId, source: 'finish-self-eval', outcome: 'failed',
          reasonCode: 'memory-commit-rejected', errorCount: Array.isArray(result?.errors) ? result.errors.length : 0
        });
        continue;
      }
      const duplicate = result.duplicate === true || result.replay === true;
      log(logSink, 'info', 'self-eval-memory-write', {
        chatKey, roundId, source: 'finish-self-eval', outcome: duplicate ? 'duplicate' : 'committed',
        observationId: String(result.id ?? candidate.id), duplicate
      });
      if (!duplicate) emit(bus, 'observation:committed', {
        chatKey, roundId, count: 1, source: 'finish-self-eval', observationId: String(result.id ?? candidate.id)
      });
    } catch (error) {
      log(logSink, 'warn', 'self-eval-memory-write', {
        chatKey, roundId, source: 'finish-self-eval', outcome: 'failed',
        reasonCode: 'memory-commit-threw', error: String(error?.message ?? error).slice(0, 160)
      });
    }
  }
}

function selfEvalEventsFromFinish(rows, { at, chatKey, roundId, evidence, modules, logSink, memoryWrites = [] }) {
  const events = [];
  const emo = modules?.emotion ?? null;
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return events;
  const ids = [...new Set((Array.isArray(evidence) ? evidence : [])
    .filter((entry) => validateMessageEvidence(entry).ok)
    .map((entry) => String(entry?.id ?? '').trim())
    .filter(Boolean))];
  // 本轮主说话人（照老树 finish.execute:3474-3477：最近一个非己方发言者）
  const primarySender = [...(Array.isArray(evidence) ? evidence : [])].reverse()
    .map((entry) => String(entry?.sender?.id ?? entry?.senderId ?? ''))
    .find((id) => id) ?? '';

  for (const row of list) {
    const data = row?.data ?? {};
    const memoryCandidate = selfEvalMemoryCandidate(data, { at, chatKey, roundId, evidence, logSink });
    if (memoryCandidate) memoryWrites.push(memoryCandidate);
    const rawFavor = Number(data.favorDelta);
    const hasFavor = Number.isFinite(rawFavor) && rawFavor !== 0;

    if (!ids.length) {
      log(logSink, 'info', 'emotion-relation-delta-skipped', { chatKey, roundId, via: 'finish', reasonCode: 'evidence-not-in-ledger' });
      continue;
    }

    // ── ① mood → 情绪/心情（逐 kind 老树数值表 + favorDelta 正负的心情腿）──
    if (typeof emo?.normalizeSelfEvalMood === 'function') {
      const norm = emo.normalizeSelfEvalMood({ mood: data.mood, summary: data.summary }) || { kinds: [] };
      // ★ 2026-10-11（pickOneAdd 接线 · 指挥位放行）：老树对被夸/玩闹还抽一维随机第三维
      //   （bot-state.js:633-648/664-668/678-682）。随机源走**装配层注入**（emotion 门面的
      //   `moodRandomSource`，装配层给 `() => Math.random`）——不在本文件写 Math.random：
      //   ① 本模块"不许自有时钟/随机源"的牙钉着（见 selftest）；② 无注入（老装配/测试替身）
      //   时不传 ⇒ `selfEvalDeltas` 不抽第三维 ⇒ 行为可回放、测试可确定。
      const randomSource = typeof emo?.moodRandomSource === 'function' ? emo.moodRandomSource : null;
      const sign = typeof emo.favorSignMoodDelta === 'function' ? emo.favorSignMoodDelta(data.favorDelta) : null;
      const moodLeg = Number.isFinite(Number(sign)) && Number(sign) !== 0 ? Number(sign) : null;
      // ★ 2026-10-15 回修（复核 §5-3）：自评原来合并成一颗、**不带 kind** ⇒ 绕过 120/180s 同 kind
      //   冷却。现在逐 kind 一颗事件（各自带 kind，apply.js 的 allowEmoteKind 按 kind 各扣各的窗）。
      //   数值不重复：`selfEvalDeltas([kind])` 逐颗相加 = 旧合并值（第三维抽样顺序与旧实现同为
      //   kinds 序）；幂等键（emotionEventKey 含 deltas）逐颗天然不同，不会被内存去重误吞。
      const kindEvents = [];
      for (const kind of Array.isArray(norm.kinds) ? norm.kinds : []) {
        const deltas = typeof emo.selfEvalDeltas === 'function'
          ? emo.selfEvalDeltas([kind], randomSource ? { random: randomSource } : undefined)
          : {};
        if (!Object.keys(deltas).length) continue;
        kindEvents.push({ kind, deltas });
      }
      const emittedBefore = events.length;
      if (!kindEvents.length && moodLeg === null) {
        // "无事发生"是模型**合法回答**（这轮没有可报的变化），不是失败 ⇒ 与"标了但映射不到"分开记账。
        const moodText = String(data.mood ?? '').trim();
        const nothingMood = !moodText || /^(无事发生|无事|没事|正常聊天)$/.test(moodText);
        log(logSink, 'info', 'self-eval-skipped', {
          chatKey, roundId, reasonCode: nothingMood ? 'self-eval-empty' : 'mood-unmapped',
          mood: moodText.slice(0, 20)
        });
      } else {
        // 心情腿（favorDelta 正负，老树 :1152-1155 无条件施加）：单 kind 时并进那颗事件（保持既有
        // 单事件形状）；多 kind / 无 kind 时单独一颗**不带 kind**的事件 —— 不被某一 kind 的冷却带走。
        const moodGoesSeparate = kindEvents.length !== 1;
        for (const item of kindEvents) {
          const deltas = { ...item.deltas };
          if (moodLeg !== null && !moodGoesSeparate) deltas.mood = (Number(deltas.mood) || 0) + moodLeg;
          for (const [k, v] of Object.entries(deltas)) {
            if (!Number.isFinite(Number(v)) || Number(v) === 0) delete deltas[k];
          }
          if (!Object.keys(deltas).length) continue;
          events.push({
            type: 'emotionEvidence', at, evidenceIds: ids, source: 'tool', deltas, magnitude: 1,
            kind: item.kind,
            ...(primarySender ? { senderId: primarySender } : {})
          });
        }
        if (moodLeg !== null && moodGoesSeparate) {
          events.push({
            type: 'emotionEvidence', at, evidenceIds: ids, source: 'tool', deltas: { mood: moodLeg }, magnitude: 1,
            ...(primarySender ? { senderId: primarySender } : {})
          });
        }
        log(logSink, 'info', 'self-eval-emitted', {
          chatKey, roundId,
          kinds: kindEvents.map((item) => item.kind),
          moodLeg,
          events: events.length - emittedBefore
        });
      }
    } else {
      log(logSink, 'warn', 'self-eval-skipped', { chatKey, roundId, reasonCode: 'emotion-mood-tags-unavailable' });
    }

    // ── ② favorDelta → 好感（relationDelta；理由 = 模型 summary 原话）──
    //   ★ 2026-10-11 晚（用户裁定 · B10 撤门槛）：不再过 classifyFavorReason —— 归不进也照常计分，
    //     正负听 delta（老树 finish.execute:3470-3488 语义：setFavor，理由取 summary）。
    if (hasFavor) {
      const delta = Math.max(-8, Math.min(8, Math.round(rawFavor)));
      const reasonText = String(data.summary ?? '').trim();
      if (!primarySender) {
        log(logSink, 'info', 'emotion-relation-delta-skipped', { chatKey, roundId, via: 'finish', reasonCode: 'no-target-person' });
      } else if (!reasonText) {
        // 老树这里的兜底理由字面量是 'finish'；新树显式记账不写空串（契约 reason 必填）
        log(logSink, 'info', 'emotion-relation-delta-skipped', { chatKey, roundId, via: 'finish', reasonCode: 'favor-reason-empty' });
      } else {
        events.push({
          type: 'relationDelta', at, personId: primarySender, changes: { favor: delta },
          reason: reasonText.slice(0, 60),
          evidenceIds: ids, source: 'tool', roundId,
          idempotencyKey: `finish-favor:${roundId}:${primarySender}`
        });
      }
    }
  }
  return events;
}

/**
 * 引用谁：只在「这条消息就是冲着机器人来的」时才引用（显式回复机器人 / @了机器人），
 * 否则不引用 —— 刷屏时乱引用比不引用更难查（旧树 76% 的引用 id 是模型现编的）。
 */
function replyTargetOf(primary) {
  const replyTo = primary?.refs?.replyTo;
  const explicit = replyTo && typeof replyTo === 'object' ? replyTo.id : replyTo;
  if (explicit !== undefined && explicit !== null && String(explicit) !== '') return explicit;
  return primary?.refs?.toSelf === true ? (primary?.id ?? null) : null;
}

/** 群里被 @ / 被回复时才带 @（私聊不带）。 */
function atTargetOf(primary, kind) {
  if (kind !== 'group') return null;
  const mentionSelf = Array.isArray(primary?.mentions) && primary.mentions.some((mention) => mention?.isSelf === true);
  return mentionSelf || primary?.refs?.toSelf === true ? (primary?.sender?.id ?? null) : null;
}

/**
 * ★ 2026-10-19（第六批）：引用协议回读的**归属校验** —— 返回的消息必须确属当前会话/本实例账号。
 * ★ 2026-10-19（第七批收紧）：不再接受"只有 message_type=group"当归属证明；必须核到可信群号/
 *   私聊对端，并核返回 message_id 与请求一致、self_id 无账号冲突。
 *   · 群聊：必须有 `group_id` 且等于当前群号（缺群号 ⇒ 无法证明是哪个群 ⇒ 不用）；
 *   · 私聊：必须显式 `message_type=private`；对端发来的消息要求 sender=当前对端；机器人自发
 *     消息没有 OneBot get_msg 标准收件字段，sender=self 本身不足以证明当前私聊归属；
 *   · 返回的 `message_id` 必须与请求 ID 一致；不把 `real_id` / `messageId` 猜作同义字段；
 *     `self_id` 与本实例账号冲突 ⇒ 拒绝；
 *   · 已有可信同聊天本地记录（storeHas 命中）时不走协议回读 —— 本地记录才是归属证明，
 *     **不可信的 reply 指针本身不能当证明**；无法核对 ⇒ 当作没取到（如实"原消息未取得"）。
 */
function quoteProtocolBelongsToChat(data, { chatKey = '', selfId = '', messageId = '' } = {}) {
  const msg = data && typeof data === 'object'
    ? (data.message_id != null || data.sender ? data : (data.data ?? null))
    : null;
  if (!msg || typeof msg !== 'object') return false;
  const sep = String(chatKey).indexOf(':');
  if (sep <= 0) return false;
  const kind = String(chatKey).slice(0, sep);
  const target = String(chatKey).slice(sep + 1);
  if (!target) return false;

  // ① 返回 ID 必须与请求一致（负号/大整数按原样字符串比较）。
  const requestedId = String(messageId ?? '').trim();
  const returnedId = String(msg.message_id ?? '').trim();
  if (!returnedId || !requestedId || returnedId !== requestedId) return false;

  // ② 账号冲突：协议端若带 self_id，必须与本实例账号一致（任一侧未知时不据此放行/拒绝）。
  const returnedSelf = String(msg.self_id ?? '').replace(/\D/g, '');
  const self = String(selfId ?? '').replace(/\D/g, '');
  if (returnedSelf && self && returnedSelf !== self) return false;

  const messageType = String(msg.message_type ?? '').toLowerCase();
  const groupId = msg.group_id == null ? '' : String(msg.group_id);
  if (kind === 'group') {
    if (messageType !== 'group') return false;
    // 必须同时有明确群类型和当前群号；缺类型/群号都不能证明会话归属。
    return groupId !== '' && groupId === target;
  }
  if (kind === 'private') {
    // 私聊类型缺失/未知时，单独 sender=peer 不足以排除错误会话响应。
    if (messageType !== 'private' || groupId) return false;
    const senderId = String(msg.sender?.user_id ?? '').replace(/^-/, '');
    if (!senderId) return false;
    if (senderId === target) return true;             // 对端发来的消息：发送者就是对端
    // ★ 2026-10-22（溟）：机器人自己发出去的消息也能引用了。
    //   原判据写的是「OneBot get_msg 没有标准收件人字段」，但本机 SnowLuma 实测是有的：
    //   get_msg 返回 `message_type:"private"`、`sender.user_id=<自己>`、`target_id=<对端>`。
    //   要求 target_id 与当前私聊对端一致才放行 —— 有明确收件人就不是猜。
    //   （复现：她引用我 12:38 那条「倒是你这声抱歉比关机重」，旧代码一律判 foreign 拒掉。）
    const recipient = String(msg.target_id ?? msg.peer_id ?? '').replace(/\D/g, '');
    const selfDigits = String(selfId ?? '').replace(/\D/g, '');
    if (selfDigits && senderId === selfDigits && recipient && recipient === target) return true;
    return false;
  }
  return false;
}

/**
 * clock contract: now() or numeric now; schedule(fn, delayMs) -> handle and
 * cancel(handle). The scheduler is injected so the host controls timer lifetime.
 */
export function createRuntime({ cfg, log: logSink, bus, modules = {}, clock } = {}) {
  if (!modules.scenario?.ingestBatch) throw new Error('modules.scenario.ingestBatch is required');
  if (typeof clock?.schedule !== 'function' || typeof clock?.cancel !== 'function') {
    throw new Error('injected clock.schedule/cancel are required');
  }

  const focusRegistry = typeof modules.plan?.createFocusRegistry === 'function'
    ? modules.plan.createFocusRegistry({ now: () => clockNow(clock) }) : null;
  // C10: post-speech 20-second follow-up focus window (per-speaker batching).
  const followupRegistry = typeof modules.plan?.createFollowupRegistry === 'function'
    ? modules.plan.createFollowupRegistry({ now: () => clockNow(clock) }) : null;
  // C10: message text cache for followup batches (dueBatch returns only IDs).
  const followupTextCache = new Map(); // messageId → { text, speakerId, at }
  // C10: delayed wakeup timers for followup batch scheduling (event-driven, not polling).
  const followupWakeTimers = new Map(); // chatKey → timer handle
  // ★ 2026-10-18（收口）：开过窗的 chatKey 集合 —— registry 没有"列出所有窗"的公开出口，
  //   这个集合只为 followupEnabled 热改关闭时**枚举收口**用；check 失活即剔除，不承担持久状态职责。
  const followupWindowChats = new Set();
  const followupActiveFor = (chatKey) => {
    if (!followupRegistry) return false;
    try {
      const state = followupRegistry.check({ chatKey, at: clockNow(clock) });
      return state?.active === true;
    } catch { return false; }
  };
  /**
   * ★ 2026-10-18（统一产品合同 #3）：`store.followupEnabled`（默认 false，effective 分层可逐群覆盖）
   *   是接话聚焦的**总开关** —— 开窗/收窗/调度/消费全看它，且与云裁判总闸彼此独立。
   */
  const followupEnabledFor = (chatKey) => {
    if (!followupRegistry || !chatKey) return false;
    if (kindOfChatKey(chatKey) !== 'group') return false;
    try { return readScopedConfig(cfg, 'store.followupEnabled', { chatKey, kind: 'group' }, false) === true; }
    catch { return false; }
  };
  /**
   * 总开关关闭时**及时收口**：关掉已开的窗、清掉唤醒定时器（热改/免重启生效）。
   * 返回当前是否处于"开启且有活动窗"——收集/抑制判定统一走它，不再直接裸查 registry。
   */
  const followupActiveEffective = (chatKey) => {
    if (followupEnabledFor(chatKey)) return followupActiveFor(chatKey);
    if (followupActiveFor(chatKey)) {
      try {
        followupRegistry?.close({ accountId: platformSelfId(modules), chatKey, at: clockNow(clock), reason: 'followup-disabled' });
        log(logSink, 'info', 'followup-window-closed-disabled', { chatKey });
      } catch { /* 收口失败不许冒到入站主链 */ }
    }
    clearFollowupWake(chatKey);
    return false;
  };
  const openFollowupWindow = (chatKey, reason = 'after-reply') => {
    if (!followupRegistry || !chatKey) return null;
    // ★ 2026-10-16（C10 私聊串线修复）：接话聚焦只属于群聊 —— 私聊走 PRIVATE_RULE 必回复，
    //   不进 20 秒窗/按人分批（否则私聊第二条消息会以 kind:'group' 的批次绕开私聊必回分支）。
    if (kindOfChatKey(chatKey) !== 'group') return null;
    // ★ 2026-10-18（followupEnabled 总开关）：关闭时不开窗、并清掉旧窗/定时器。
    if (!followupEnabledFor(chatKey)) {
      followupActiveEffective(chatKey);
      log(logSink, 'debug', 'followup-window-suppressed', { chatKey, reason: 'followup-disabled' });
      return null;
    }
    try {
      const result = followupRegistry.open({ chatKey, at: clockNow(clock), reason });
      followupWindowChats.add(chatKey);
      log(logSink, 'info', 'followup-window-opened', { chatKey, reason, refreshed: result?.refreshed === true });
      return result;
    } catch (error) {
      log(logSink, 'warn', 'followup-window-open-failed', { chatKey, error: String(error?.message ?? error).slice(0, 120) });
      return null;
    }
  };
  /**
   * ★ R04（2026-10-18）：聚焦批次也必须和普通轮/主动轮**共用同一种队列项**（带 resolve/promise 的
   *   延迟对象）—— 改前 `resolve:null` ⇒ `pump()` 的 `item.resolve(promise)` 直接 TypeError，
   *   批次跑不起来；`pause()` 结算队列时同样会炸（现场：暂停返回 500）。
   */
  const makeFollowupQueueItem = (chatKey, batch) => {
    const batchEvidence = batch.messageIds.map((mid) => {
      const cached = followupTextCache.get(String(mid));
      return {
        id: String(mid),
        text: cached?.text ?? '',
        at: cached?.at ?? batch.lastAt ?? 0,
        speakerId: batch.speakerId,
        sender: { id: batch.speakerId },
        kind: 'group'
      };
    });
    const item = {
      chatKey,
      followupBatch: true,
      followupSeq: batch.seq,
      fromId: batch.speakerId,
      messageIds: batch.messageIds,
      judgedCount: batch.judgedCount,
      evidence: batchEvidence,
      inboundUnreadIds: [],
      inboundReadClaims: [],
      since: clockNow(clock),
      firstAt: clockNow(clock),
      timer: null,
      resolve: null,
      promise: null,
      attempt: 0
    };
    item.promise = new Promise((resolve) => { item.resolve = resolve; });
    return item;
  };
  /**
   * ★ 2026-10-16（C10 收口 · cj2 断点 2）：取消某会话的接话唤醒。
   * 登记值是 `{timer, dueAt}`（不是裸 handle）—— 重排/暂停都要能**先取消再重排**。
   */
  const clearFollowupWake = (chatKey) => {
    const entry = followupWakeTimers.get(chatKey);
    if (!entry) return false;
    try { clock.cancel(entry.timer); } catch { /* 已触发/已取消都当清掉，登记必须删 */ }
    followupWakeTimers.delete(chatKey);
    return true;
  };
  /** 暂停/中止时统一清掉（`pause()` 调；`abortAll` 会走 `pause`）。 */
  const clearAllFollowupWakes = () => { for (const key of [...followupWakeTimers.keys()]) clearFollowupWake(key); };
  // C10: schedule a delayed wakeup for the next followup batch (event-driven, not polling).
  const scheduleFollowupWake = (chatKey, nextDueAt) => {
    if (!followupRegistry || !chatKey || !Number.isFinite(nextDueAt)) return;
    const existing = followupWakeTimers.get(chatKey);
    if (existing) {
      // ★ 只有**更早**的 dueAt 才取消重排。原来"已有定时器就直接 return" ⇒ 新消息带来的更早批次
      //   要等旧定时器到点才判（甚至错过 nextDueAt）——这是 cj2 断点 2，确凿。更晚/相同的请求直接
      //   忽略（旧定时器到点后自然会再算一次 nextDueAt）。
      if (!Number.isFinite(existing.dueAt) || nextDueAt >= existing.dueAt) return;
      clearFollowupWake(chatKey);
    }
    const dueAt = Number(nextDueAt);
    const delay = Math.max(50, dueAt - clockNow(clock));
    const timer = clock.schedule(() => {
      // ★ 只清"还是我这一把"的登记：被重排后旧定时器若迟到触发（clock 实现不保证取消生效时），
      //   不许它删掉新登记、更不许它冒充新定时器去重复判定。
      const entry = followupWakeTimers.get(chatKey);
      if (!entry || entry.timer !== timer) return;
      followupWakeTimers.delete(chatKey);
      // Process due batches for this chatKey.
      try {
        const dueResult = followupRegistry.dueBatch({ chatKey, at: clockNow(clock) });
        if (dueResult?.active && Array.isArray(dueResult.due) && dueResult.due.length) {
          for (const batch of dueResult.due) {
            if (!batch?.speakerId || !Array.isArray(batch.messageIds) || !batch.messageIds.length) continue;
            queue.push(makeFollowupQueueItem(chatKey, batch));
          }
        }
        // Schedule next wakeup if there are more batches pending.
        // ★ 窗已过期/已关（`active:false`）⇒ **不再重排**，也不留空转定时器（原来只看 nextDueAt，
        //   关窗后若还有旧 nextDueAt 会白醒一次）；没有新消息时这里 `due:[]`、不会产生任何云请求。
        if (dueResult?.active && Number.isFinite(dueResult.nextDueAt)) {
          scheduleFollowupWake(chatKey, dueResult.nextDueAt);
        } else if (!dueResult?.active) {
          log(logSink, 'debug', 'followup-wake-window-closed', { chatKey, reason: String(dueResult?.reason ?? 'inactive') });
        }
        void pump();
      } catch (error) {
        log(logSink, 'warn', 'followup-wake-failed', { chatKey, error: String(error?.message ?? error).slice(0, 120) });
      }
    }, delay);
    followupWakeTimers.set(chatKey, { timer, dueAt });
  };
  const topicRegistry = modules.topicRegistry && typeof modules.topicRegistry.check === 'function'
    ? modules.topicRegistry : null;
  const readFocusState = (chatKey, at = clockNow(clock)) => {
    if (!focusRegistry) return null;
    return focusRegistry.check({ accountId: platformSelfId(modules), chatKey, at });
  };
  const planFocusState = (state) => state?.active === true && state.window
    ? { ...state.window, ...state, active: true }
    : state;

  const cap = Math.max(1, Number(cfg?.get?.('maxConcurrentRuns', 2)) || 2);
  /**
   * ★ 2026-10-16（用户口径 · 防抖真聚批）：`wakeDelayMs` / `burstSettleMs` / `burstMaxWaitMs`
   *   从"装配时读一次"改成**每批现读** —— 开发者设置改完，下一批就用新值（不用重启）。
   *   这三个键是**真实读点**（旧 defaults/台账里的"死键"注释是历史误判，台账已订正）。
   *
   *   值非法/读失败 ⇒ 回退到与 `core/config-store/defaults.js` 一致的缺省并**记一次诊断**：
   *   · 不拿 0 冒充"配置坏了" —— settle=0 的语义是"关聚批（每条消息各自开轮）"，
   *     只有用户**真的**配 0 才允许；NaN/负数/读异常一律回退 15000（继续聚批）。
   *   · `wakeDelayMs` 的 0 保持既有语义（防抖下限，UI 写回也把 0 归 2000），不做改动。
   */
  const BURST_KNOB_DEFAULTS = { wakeDelayMs: 2000, burstSettleMs: 15000, burstMaxWaitMs: 30000 };
  const burstKnobWarned = new Set();
  function readBurstKnobs() {
    const read = (key, { allowZero = true } = {}) => {
      const fallback = BURST_KNOB_DEFAULTS[key];
      let raw;
      try { raw = cfg?.get?.(key, fallback); } catch (error) {
        if (!burstKnobWarned.has(`read-failed:${key}`)) {
          burstKnobWarned.add(`read-failed:${key}`);
          log(logSink, 'warn', 'burst-knob-read-failed', { key, fallback, error: String(error?.message ?? error).slice(0, 120) });
        }
        return fallback;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) {
        if (!burstKnobWarned.has(`invalid:${key}`)) {
          burstKnobWarned.add(`invalid:${key}`);
          log(logSink, 'warn', 'burst-knob-invalid', { key, value: String(raw ?? '').slice(0, 40), fallback });
        }
        return fallback;
      }
      return n;
    };
    return {
      wakeDelayMs: read('wakeDelayMs', { allowZero: false }),
      burstSettleMs: read('burstSettleMs'),
      burstMaxWaitMs: read('burstMaxWaitMs')
    };
  }
  const drainDelayRaw = Number(cfg?.get?.('drainDelayMs', 1200));
  const drainDelayMs = Math.max(200, Number.isFinite(drainDelayRaw) && drainDelayRaw ? drainDelayRaw : 1200);
  /**
   * 整轮重试上限（T-CUTOVER-3 第 6 条）：旧树 `src/orchestrator.js:1694-1733` 在**没发出任何消息**时
   * 最多做 3 次 session attempt，避免"模型抖一下就彻底没答"。
   * 只允许在"这一轮一条成功发送都没有"时重试；**一旦发出过就绝不再跑**（防重复发送）。
   */
  const maxAttempts = Math.max(1, Number(cfg?.get?.('maxSessionAttempts', 3)) || 3);
  const historyLimit = Math.max(1, Number(cfg?.get?.('recentBotMessages', DEFAULT_HISTORY_LIMIT)) || DEFAULT_HISTORY_LIMIT);
  const runningChats = new Map();
  const pending = new Map();
  const queue = [];
  const burstLastMessageAt = new Map();
  const burstStartedAt = new Map();
  const burstRateCache = new Map();
  const drainTimers = new Map();
  // 2026-10-21 溟加：轮级重试的定时器（延后 2~5 秒再排回队列，见 round-retry-queued 那段）。
  const retryTimers = new Set();
  const appliedEmotionEvents = new Set();
  /**
   * ★ 2026-10-18（收口 · 合同 #3）：`store.followupEnabled` **热改关闭的及时收口**。
   *   走现成配置订阅（`modules.configStore.subscribeConfigChange`，与装配层 refreshJudgeRuntime
   *   同一通道；含只改内存的 set/updateConfig），关闭后立即：
   *     ① 关掉已开的窗并清掉唤醒定时器；
   *     ② 结算并从队列移除**尚未开跑**的聚焦批（verdict 记 SKIP 释放顺序号；已在跑的轮由
   *        入轮收口守卫处理）。
   *   惰性收口（入站/入轮时 followupActiveEffective）仍保留作后备；这里不做别的配置处理。
   *   订阅生命周期与 runtime 同寿（本进程一次装配一个 runtime；无 teardown API，不另造）。
   */
  const sweepFollowupDisabled = () => {
    let chats = 0;
    let queued = 0;
    const candidates = new Set([...followupWindowChats, ...followupWakeTimers.keys()]);
    for (const key of candidates) {
      if (!followupActiveFor(key)) { followupWindowChats.delete(key); continue; }
      if (followupEnabledFor(key)) continue;
      followupActiveEffective(key);          // 关窗 + 清唤醒定时器
      followupWindowChats.delete(key);
      chats += 1;
    }
    for (const item of [...queue]) {
      if (item.followupBatch !== true || followupEnabledFor(item.chatKey)) continue;
      const index = queue.indexOf(item);
      if (index >= 0) queue.splice(index, 1);
      try {
        followupRegistry?.recordVerdict({ chatKey: item.chatKey, seq: Number(item.followupSeq), verdict: 'SKIP', at: clockNow(clock) });
      } catch { /* 收口清理不许冒泡 */ }
      item.resolve?.({ status: 'skipped', reason: 'followup-disabled' });
      queued += 1;
    }
    if (chats > 0 || queued > 0) log(logSink, 'info', 'followup-disabled-sweep', { chats, queued });
  };
  try {
    const subscribeConfigChange = modules?.configStore?.subscribeConfigChange;
    if (typeof subscribeConfigChange === 'function') {
      subscribeConfigChange(() => {
        try { sweepFollowupDisabled(); }
        catch (error) {
          log(logSink, 'warn', 'followup-disabled-sweep-failed', { error: String(error?.message ?? error).slice(0, 120) });
        }
      });
    }
  } catch (error) {
    log(logSink, 'warn', 'followup-config-subscribe-failed', { error: String(error?.message ?? error).slice(0, 120) });
  }
  /**
   * ★ 2026-10-16（离散情绪兜底 · 用户报"离散情绪长期不动/自评不足"）：每会话的**轮次闸** ——
   * 同一会话至少每 3 轮检查一次"最近的用户输入 + 机器人自己实际发言"里的弱情绪线索；
   * 用**轮次**计数而不是时间冷却（冷却会让兜底在快节奏会话里永不生效）。纯计数、无模型调用。
   */
  const emotionFallbackRounds = createFallbackTracker();
  const resumeReplayIds = new Map();
  // ★ 2026-10-19（第六批）：引用协议回读的**正缓存**（按 chatKey + messageId；5 分钟 / 100 条）。
  //   只缓存归属校验通过的原始消息；失败不缓存（下一批仍可重试）。避免同一句被反复引用时
  //   反复打协议端 —— 不无限重试、不拖慢正常收消息。
  // ★ 2026-10-19（第七批）：缓存键与在途请求都带**账号/实例/连接代际**；换号、实例切换、
  //   stop/start 后旧条目不再命中，旧请求晚到的响应直接丢弃（不污染新实例）。
  const quoteProtocolCache = new Map();
  const quoteProtocolInFlight = new Map();
  const QUOTE_PROTOCOL_CACHE_TTL_MS = 5 * 60 * 1000;
  const QUOTE_PROTOCOL_CACHE_MAX = 100;
  const QUOTE_PROTOCOL_INFLIGHT_MAX = 100;
  const quoteProtocolIdentity = () => {
    const platform = modules.platform;
    let accountId = '';
    try { accountId = String(platform?.selfId ?? '').trim(); } catch { accountId = ''; }
    let instanceId = '';
    try { instanceId = String(modules?.configStore?.describeInstance?.() ?? '').trim(); } catch { instanceId = ''; }
    let connected = null;
    try { connected = platform?.connected === undefined ? null : platform.connected === true; } catch { connected = null; }
    // Read generation last: live OneBot getters reconcile identity/connection changes and may advance it.
    let generation = null;
    try {
      const rawGeneration = platform?.connectionGeneration;
      generation = Number.isFinite(Number(rawGeneration)) ? Number(rawGeneration) : null;
    } catch { generation = null; }
    return { accountId, instanceId, generation, connected };
  };
  const sameQuoteProtocolIdentity = (a, b) => Boolean(a && b)
    && a.accountId === b.accountId
    && a.instanceId === b.instanceId
    && a.generation === b.generation;
  /** `sendScheduled` 不给调用方键时的"按调用唯一"序号（见该函数头注释：默认键不许认不出内容）。 */
  let scheduledCallSeq = 0;
  let incomingClaimSeq = 0;
  const sentLedger = [];
  const recoveredSentText = new Map();
  /**
   * 补过、确认补不回来的 sent id（`chatKey\0id`）。2026-11-04 加。
   * 起因：200000001 有 810 条 sent 记录没有 text，`loadSentHistory` 每次都觉得「可能还能补」，
   * 于是每条消息都跑一次 listSummaries({limit:Infinity}) + 逐会话 get + 遍历 sent，最后仍然补不到，
   * 白干一遍再报一行 warn（当天 10588 行）。接口因此间歇卡 20 秒。
   * 语义：见过一次、补不到，就记着别再试——历史记录不会自己长出文本来。
   */
  const unrecoverableSentIds = new Set();
  const repeatBlocksByChat = new Map();
  let paused = false;
  let abortReason = '';
  let roundSeq = 0;

  // 会话写侧是进程级单例：每轮只复用，不在每次消息上重新建登记表。
  // dataDir 必须来自装配的 config-store（其解析结果与服务的 QQ_AGENT_DATA_DIR 同源），不猜仓库 data/。
  let sessionRegistry = null;
  if (typeof modules.sessions?.createSessionRegistry === 'function') {
    const dataDir = String(modules.configStore?.DATA_DIR ?? process.env.QQ_AGENT_DATA_DIR ?? '').trim();
    if (!dataDir) {
      log(logSink, 'warn', 'session-registry-unavailable', { reason: 'dataDir-unset' });
    } else {
      try {
        sessionRegistry = modules.sessions.createSessionRegistry({
          dataDir,
          keepFiles: Math.max(0, Number(readConfig(cfg, 'store.keepSessionFiles', 0)) || 0),
          now: () => clockNow(clock),
          warn: (message) => log(logSink, 'warn', 'session-registry-warning', { message: String(message ?? '') })
        });
      } catch (error) {
        log(logSink, 'warn', 'session-registry-unavailable', { reason: String(error?.message ?? error) });
      }
    }
  }
  if (topicRegistry && typeof topicRegistry.restore === 'function'
    && typeof sessionRegistry?.listSummaries === 'function' && typeof sessionRegistry?.get === 'function') {
    try {
      const accountId = platformSelfId(modules);
      const summaries = accountId
        ? sessionRegistry.listSummaries({ limit: 1000, readOnly: true }) : [];
      const latestByChat = new Map();
      for (const summary of [...(Array.isArray(summaries) ? summaries : [])]
        .sort((a, b) => Number(a?.endedAt ?? a?.startedAt ?? 0) - Number(b?.endedAt ?? b?.startedAt ?? 0))) {
        const chatKey = String(summary?.chatKey ?? '');
        if (!chatKey.startsWith('group:')) continue;
        const session = sessionRegistry.get(summary.id);
        const saved = session?.turnPlan?.topicState;
        const topic = saved && typeof saved === 'object' && saved.active === true && saved.topic?.accountId === accountId
          && saved.topic?.chatKey === chatKey && saved.topic?.ended == null
          ? saved.topic : null;
        // The newest group turn is authoritative, including a turn without a topic
        // snapshot: uncertainty must not resurrect an older active topic.
        latestByChat.set(chatKey, topic);
      }
      const entries = [...latestByChat.values()].filter((topic) => topic && typeof topic.topicId === 'string');
      const restored = topicRegistry.restore({
        version: 1,
        idleMs: Number(topicRegistry.idleMs) || 5 * 60 * 1000,
        entries
      });
      if (restored !== true) log(logSink, 'warn', 'topic-registry-restore-rejected', { reason: 'invalid-session-snapshots' });
      else if (entries.length) log(logSink, 'info', 'topic-registry-restored', { count: entries.length });
    } catch (error) {
      log(logSink, 'warn', 'topic-registry-restore-failed', { reason: String(error?.message ?? error).slice(0, 120) });
    }
  }
  const observeMemoryInput = createMemoryObserver({ modules, cfg, clock, logSink });

  function appendSessionMessage(run, role, content, evidenceId = '', metadata = null) {
    if (!sessionRegistry || !run.sessionId || content == null || String(content) === '') return false;
    try {
      const entry = {
        role, content: String(content), at: clockNow(clock),
        ...(evidenceId ? { evidenceId: String(evidenceId) } : {})
      };
      if (metadata?.internalThought === true) {
        const source = String(metadata.source ?? 'model');
        Object.assign(entry, {
          kind: 'internal-thought', internalThought: true, outbound: false,
          roundId: String(run.roundId ?? ''),
          composeOutcome: String(metadata.composeOutcome ?? ''),
          composeReason: String(metadata.composeReason ?? ''),
          source,
          modelRound: Number(metadata.modelRound) || 0
        });
        if (source === 'model' || source === 'model-silence') {
          entry.memoryKind = 'thought';
          try {
            const personaTwo = typeof modules.emotion?.isPersonaTwo === 'function'
              ? modules.emotion.isPersonaTwo()
              : modules.emotion?.effectivePersona?.()?.personaTwo;
            if (typeof personaTwo === 'boolean') entry.persona2 = personaTwo;
          } catch { /* persona metadata must not prevent the thought from being saved */ }
        }
      } else if (metadata?.modelBody === true) Object.assign(entry, {
        kind: metadata.discardedTruncated === true ? 'discarded-truncated' : 'model-body',
        outbound: false, source: 'model', roundId: String(run.roundId ?? ''),
        modelRound: Number(metadata.modelRound) || 0,
        ...(metadata.discardedTruncated === true ? { discardedTruncated: true } : {})
      });
      const written = sessionRegistry.appendMessage(run.sessionId, entry);
      if (!written?.ok) log(logSink, 'warn', 'session-message-write-failed', {
        chatKey: run.chatKey, roundId: run.roundId, role, error: written?.error ?? 'appendMessage returned no success'
      });
      // ★ S-4：正文进会话 = 卡片该跟着长（这正是主人说的"预输出时没有卡"的反面：一有输出就有帧）。
      //   节流在 emitSessionFrame 里（updated 最小间隔 1.2s），start/ended 不节流。
      else emitSessionFrame(run, 'session:updated');
      return written?.ok === true;
    } catch (error) {
      log(logSink, 'warn', 'session-message-write-failed', { chatKey: run.chatKey, roundId: run.roundId, role, error: String(error?.message ?? error) });
      return false;
    }
  }

  async function loadSentHistory(chatKey) {
    let external = [];
    const recent = modules.observability?.recent;
    if (typeof recent === 'function') {
      try {
        const readLimit = Math.max(historyLimit, Number(cfg?.get?.('hourlyHistoryLimit', 5000)) || 5000);
        const rows = await recent({ name: 'send', n: readLimit });
        external = Array.isArray(rows) ? rows : Array.isArray(rows?.rows) ? rows.rows : [];
      } catch (error) {
        log(logSink, 'warn', 'send-history-read-failed', { error: String(error?.message ?? error) });
      }
    }
    const now = clockNow(clock);
    const requestedChatKey = String(chatKey);
    const textKey = (id) => `${requestedChatKey}\u0000${String(id)}`;
    for (const row of sentLedger) {
      if (row?.chatKey === requestedChatKey && String(row.text ?? '').trim()) {
        recoveredSentText.set(textKey(row.id ?? row.platformId), { text: String(row.text), at: Number(row.at) || 0 });
      }
    }
    const sourceRows = [...external, ...sentLedger];
    const needsPersistedText = sourceRows.some((row) => {
      const item = normalizeSent(row);
      return item?.chatKey === requestedChatKey && !item.text.trim()
        && !recoveredSentText.has(textKey(item.id))
        && !unrecoverableSentIds.has(textKey(item.id));
    });
    if (needsPersistedText && sessionRegistry && typeof sessionRegistry.listSummaries === 'function' && typeof sessionRegistry.get === 'function') {
      try {
        const summaries = sessionRegistry.listSummaries({ limit: Infinity, readOnly: true });
        const matching = (Array.isArray(summaries) ? summaries : [])
          .filter((summary) => summary?.chatKey === requestedChatKey && (summary.sentCount == null || Number(summary.sentCount) > 0))
          .sort((a, b) => sessionStartMs(a) - sessionStartMs(b));
        const selected = new Map();
        for (const summary of matching) {
          if (sessionStartMs(summary) >= now - HOUR_MS) selected.set(String(summary.id), summary);
        }
        for (const summary of matching.slice(-historyLimit)) selected.set(String(summary.id), summary);
        for (const summary of selected.values()) {
          const session = sessionRegistry.get(summary.id);
          for (const sent of Array.isArray(session?.sent) ? session.sent : []) {
            const id = sent?.platformId ?? sent?.id;
            const text = normalizeSentText(sent?.text);
            if (id == null || String(id) === '' || !text) continue;
            const at = Number(sent.at);
            const key = textKey(id);
            const previous = recoveredSentText.get(key);
            if (!previous || (Number.isFinite(at) && at >= previous.at)) {
              recoveredSentText.set(key, { text, at: Number.isFinite(at) ? at : 0 });
            }
          }
        }
        while (recoveredSentText.size > historyLimit * 10) recoveredSentText.delete(recoveredSentText.keys().next().value);
      } catch (error) {
        log(logSink, 'warn', 'session-sent-history-read-failed', { chatKey: requestedChatKey, error: String(error?.message ?? error) });
      }
    }
    let missingTextCount = 0;
    const normalized = [];
    for (const row of sourceRows) {
      const item = normalizeSent(row);
      if (!item || item.chatKey !== requestedChatKey) continue;
      if (!item.text.trim()) item.text = recoveredSentText.get(textKey(item.id))?.text ?? '';
      if (!item.text.trim()) {
        missingTextCount += 1;
        // 记下来，下次不再为它跑全量兜底（上面的 needsPersistedText 会跳过）
        unrecoverableSentIds.add(textKey(item.id));
        continue;
      }
      normalized.push(item);
    }
    if (unrecoverableSentIds.size > 20000) unrecoverableSentIds.clear();
    if (missingTextCount) log(logSink, 'warn', 'send-history-text-missing', { chatKey: requestedChatKey, count: missingTextCount });
    normalized.sort((a, b) => a.at - b.at);
    const unique = new Map();
    for (const item of normalized) unique.set(item.id, item);
    const all = [...unique.values()];
    const withinHour = all.filter((item) => item.at >= now - HOUR_MS);
    const roundKeys = [...new Set(all.map((item) => item.roundId || `send:${item.id}`))].slice(-historyLimit);
    const recentRounds = all.filter((item) => roundKeys.includes(item.roundId || `send:${item.id}`));
    const union = new Map([...withinHour, ...recentRounds].map((item) => [item.id, item]));
    if (!union.size) log(logSink, 'warn', 'bot-said-history-unavailable', { policy: 'explicit-empty-history', source: typeof recent === 'function' ? 'send-ledger-empty' : 'no-send-ledger' });
    return [...union.values()].sort((a, b) => a.at - b.at);
  }

  function priorSentFinishProfile(chatKey, primary) {
    const requestedChatKey = String(chatKey);
    const evidenceHistory = Array.isArray(primary?.botSaidBefore) ? primary.botSaidBefore : [];
    const textMessageCount = (row) => {
      if (!String(row?.text ?? '').trim()) return 0;
      const requestedCount = Number(row?.receipt?.coverage?.requestedCount);
      return Number.isFinite(requestedCount) && requestedCount > 0 ? Math.floor(requestedCount) : 1;
    };
    const priorSentTextCount = Math.max(
      evidenceHistory.reduce((count, row) => count + textMessageCount(row), 0),
      sentLedger.filter((row) => row?.chatKey === requestedChatKey && row?.type === 'text')
        .reduce((count, row) => count + textMessageCount(row), 0)
    );
    let priorSentHasMedia = sentLedger.some((row) => row?.chatKey === requestedChatKey
      && ['image', 'sticker'].includes(String(row?.type ?? '')));
    if (!priorSentHasMedia && sessionRegistry
      && typeof sessionRegistry.listSummaries === 'function' && typeof sessionRegistry.get === 'function') {
      try {
        const summaries = sessionRegistry.listSummaries({ limit: Infinity, readOnly: true });
        const matching = (Array.isArray(summaries) ? summaries : [])
          .filter((summary) => summary?.chatKey === requestedChatKey && (summary.sentCount == null || Number(summary.sentCount) > 0))
          .slice(-historyLimit);
        for (const summary of matching) {
          const session = sessionRegistry.get(summary.id);
          if ((Array.isArray(session?.sent) ? session.sent : []).some((sent) =>
            ['image', 'sticker'].includes(String(sent?.type ?? '')))) {
            priorSentHasMedia = true;
            break;
          }
        }
      } catch (error) {
        log(logSink, 'warn', 'auto-finish-history-read-failed', {
          chatKey: requestedChatKey, error: String(error?.message ?? error)
        });
      }
    }
    return { priorSentTextCount, priorSentHasMedia };
  }

  /**
   * D-2 C：核验「这条到底发出去了没」—— **fail-closed**。
   * 原写法是 `assertDelivered?.(…) || { delivered: true }`：`assertDelivered` 缺失就默认成功。
   * 可达性定性（票面要求）：生产装配把 M10 的**整个模块命名空间**交给 M15
   * （apps/server/assembly.js:32-35/54 的 `exports:[…,'assertDelivered']` 是"必须存在"的闸，
   *  缺了 `loadModules` 直接把该模块记成 missing ⇒ 装配抛错，运行时不会退化成 undefined）
   *  ⇒ **活实例这条路必然可达**；会落到缺省分支的只有注入面残缺（自测替身、手搓 modules）。
   * 而那种时候默认 true 正是假绿：面板写「已发送」、平台侧一条都没确认过。
   * ⇒ 缺省口径改为"只认平台回执"（§0 铁律 6），并留一行 warn 说清是谁没接上。
   */
  async function checkDelivered(results, fallback) {
    if (typeof modules.act?.assertDelivered !== 'function') {
      log(logSink, 'warn', 'assert-delivered-unavailable', { fallback: fallback ? 'receipt-only' : 'fail-closed' });
      return fallback ?? { delivered: false, reasons: ['act.assertDelivered 未注入，且没有可核验的平台回执'] };
    }
    const checked = await modules.act.assertDelivered(results);
    return checked ?? fallback ?? { delivered: false, reasons: ['act.assertDelivered 没给出判定'] };
  }

  function rememberReceipt(receipt, { chatKey, roundId, evidenceId, action, text, tool = '', run = null }) {
    const checked = validateSendReceipt(receipt);
    if (!checked.ok || receipt?.ok !== true || !receipt.platformId) return false;
    const receiptKey = String(receipt.platformId);
    if (run?.receiptKeys?.has(receiptKey)) return false;
    run?.receiptKeys?.add(receiptKey);
    if (run && Array.isArray(run.confirmedSendReceipts)) run.confirmedSendReceipts.push({
      receipt, text: String(text ?? ''), tool: String(tool ?? '')
    });
    sentLedger.push({
      id: String(receipt.platformId), platformId: String(receipt.platformId), chatKey, roundId,
      at: receipt.at, text: String(text ?? ''), type: sentTypeOf(tool), receipt
    });
    if (sentLedger.length > historyLimit * 4) sentLedger.splice(0, sentLedger.length - historyLimit * 4);
    // ★ D-2 C+B：一条真发送要同时说三处真话 —— ① 轮次账 sentLedger（原有，喂下一轮的 botSaid）
    //   ② `session.sent`：UI 的「已回复」「已发送到 QQ」徽标与详情指纹都读它（apps/ui/app.js:5689/5778），
    //      而全树此前**没有任何写入者** ⇒ 面板的「实际发送」恒 0 条。
    //   ③ `trace.sent`：core/observability 的 receiptCount 口径 ⇒ 追踪头部的「实际发送 N 条（类型）」。
    const sentEntry = { type: sentTypeOf(tool), text: String(text ?? ''), at: sentStamp(receipt.at), platformId: String(receipt.platformId) };
    try {
      const session = run?.sessionRegistry?.peek?.(run.sessionId);
      if (Array.isArray(session?.sent)) session.sent.push(sentEntry);
    } catch (error) {
      log(logSink, 'warn', 'session-sent-record-failed', { chatKey, roundId, error: String(error?.message ?? error) });
    }
    try {
      modules.observability?.recordSent?.(chatKey, roundId, { type: sentEntry.type, at: receipt.at });
    } catch (error) {
      log(logSink, 'warn', 'turn-trace-sent-record-failed', { chatKey, roundId, error: String(error?.message ?? error) });
    }
    try {
      modules.observability?.ledger?.('send', {
        chatKey, roundId, at: receipt.at, ok: true, platformId: String(receipt.platformId),
        idempotencyKey: receipt.idempotencyKey, action: 'send', planAction: action, evidenceId
      });
    } catch (error) {
      log(logSink, 'warn', 'send-receipt-ledger-write-failed', { error: String(error?.message ?? error) });
    }
    emit(bus, 'receipt:confirmed', { chatKey, roundId, ok: true, platformId: receipt.platformId });
    return true;
  }

  function senderBurstRate(chatKey, senderId, kind, settle, adaptive) {
    if (!senderId) return null;
    const key = `${chatKey}|${senderId}`;
    const now = clockNow(clock);
    const cached = burstRateCache.get(key);
    if (cached && now - cached.at < 120000) return cached.rate;
    let rate = null;
    try {
      const store = modules.memory?.store;
      const history = typeof store?.recent === 'function'
        ? store.recent(chatKey, { limit: 240, includeSelf: false }) : [];
      const mine = (Array.isArray(history) ? history : []).filter((row) => String(row?.senderId ?? '') === String(senderId));
      let pairs = 0;
      let continued = 0;
      for (let index = 0; index + 1 < mine.length; index += 1) {
        pairs += 1;
        if (Number(mine[index + 1]?.ts) - Number(mine[index]?.ts) <= settle) continued += 1;
      }
      const minimum = Math.max(1, Number(adaptive?.minSamples) || 6);
      if (pairs >= minimum) rate = continued / pairs;
    } catch { /* unavailable history falls back to the configured private/group prior */ }
    if (rate == null) rate = kind === 'private'
      ? Number(adaptive?.priorPrivate ?? 0.45) : Number(adaptive?.priorGroup ?? 0.28);
    rate = Math.max(0, Math.min(1, Number(rate) || 0));
    burstRateCache.set(key, { rate, at: now });
    return rate;
  }

  function burstDelayFor(item) {
    const chatKey = String(item?.chatKey ?? '');
    const now = clockNow(clock);
    // ★ 2026-10-16：旋钮**现读**（热更下一批生效），缺省/非法值回退见 readBurstKnobs。
    const { wakeDelayMs, burstSettleMs: burstMs, burstMaxWaitMs } = readBurstKnobs();
    const previousAt = Number(burstLastMessageAt.get(chatKey)) || 0;
    burstLastMessageAt.set(chatKey, now);
    if (modules.emotion?.isHypeMode?.() === true) return 100;
    const pointed = item?.gate?.addressed === true || item?.gate?.keyword === true;
    const maxWait = burstMaxWaitMs > 0 ? burstMaxWaitMs : Number.POSITIVE_INFINITY;
    const idle = Math.max(30000, burstMs * 2);
    const newBurst = !previousAt || now - previousAt > idle;
    // ★ R08（2026-10-18）：硬上限**从本串第一条起算**，点名/关键词批次同样受它约束 ——
    //   改前 pointed 分支直接 return wakeDelayMs，且每条新消息都会重设定时器 ⇒ 连续点名能把
    //   这一串无限顺延（现场：越催问越不回，停止发送后才处理）。这里先把串起点定下来，
    //   所有分支的返回值都不许晚于 `started + maxWait`。
    if (newBurst) burstStartedAt.set(chatKey, now);
    const started = Number(burstStartedAt.get(chatKey)) || previousAt || now;
    const remaining = Number.isFinite(maxWait) ? started + maxWait - now : Number.POSITIVE_INFINITY;
    if (pointed || burstMs === 0) {
      // 点名/关键词要尽快处理（wakeDelayMs），但不许越过硬上限：到点立即发车。
      if (remaining <= 0) return 0;
      return Math.max(0, Math.min(wakeDelayMs, remaining));
    }

    // ★ 2026-11-05（溟 · 她要的"两档等法"）：
    //   平时只等 burstSettleMs（配成 500ms，快问快答不卡壳）；
    //   她这一串话里带「听我说」这类记号 ⇒ 后面还有话，等 burstSlowWaitMs（默认 10 秒）再发车。
    //   判据取**整串**已攒下的文本，不是只看最后一条：记号打在开头、后半句跟在后面很常见。
    //   命中时不受 burstAdaptive 影响（自适应是"猜她还要说多少"，她明说了就按明说的来）。
    const slowRaw = Number(cfg?.get?.('burstSlowWaitMs', 10000));
    const slowWaitMs = Number.isFinite(slowRaw) && slowRaw > 0 ? slowRaw : 10000;
    const triggersRaw = cfg?.get?.('burstSlowTriggers', ['听我说', '你先听我说', '听我说完', '我说完你再']);
    const slowTriggers = (Array.isArray(triggersRaw) ? triggersRaw : [])
      .map((t) => String(t ?? '').trim()).filter(Boolean);
    if (slowTriggers.length) {
      const burstText = Array.isArray(item?.evidence)
        ? item.evidence.map((e) => String(e?.text ?? '')).join('\n') : '';
      if (burstText && slowTriggers.some((t) => burstText.includes(t))) {
        // 硬上限对她明说的"听我说"要放宽，否则 30 秒一刀切会把长句截在半路
        const capMs = Math.max(slowWaitMs, burstMaxWaitMs || 0);
        const left = Number.isFinite(remaining) ? Math.max(0, started + capMs - now) : slowWaitMs;
        return Math.max(0, Math.min(slowWaitMs, left));
      }
    }

    const adaptive = readConfig(cfg, 'burstAdaptive', {});
    let target = burstMs;
    if (adaptive?.enabled !== false) {
      const latest = Array.isArray(item?.evidence) ? item.evidence.at(-1) : null;
      const senderId = String(latest?.sender?.id ?? latest?.senderId ?? '');
      const rate = senderBurstRate(chatKey, senderId, latest?.kind ?? 'group', burstMs, adaptive);
      if (rate !== null && rate !== undefined) {
        const rawK = Number(adaptive?.k ?? 0.3);
        const k = Number.isFinite(rawK) ? Math.max(0.05, rawK) : 0.3;
        target = wakeDelayMs + (burstMs - wakeDelayMs) * Math.min(1, rate / k);
      }
      target = Math.max(wakeDelayMs, Math.min(burstMs, Math.round(target)));
    } else if (newBurst) {
      // ★ 2026-11-05（溟，她报「整句等待和没有一样」）：这里原本是 `target = wakeDelayMs`。
      //   配合下面 `if (newBurst) return Math.max(wakeDelayMs, target)`，效果是**新一串只等 1.5 秒**，
      //   burstSettleMs 在这条路上完全没被用到（burstAdaptive.enabled=false 时必走这条）。
      //   实测后果：她 00:26:33 发「先问你」、00:26:37 发「你昨天干什么了你知道吗」（间隔 4 秒），
      //   第一轮在 00:26:35 就起车、只带 1 条，回了一句「问吧」；第二句 00:26:55 才另起一轮。
      //   改成走 burstMs：新一串也要等满 settle 窗口，后面那半句才进得来。
      //   代价：单条消息的首字延迟从 1.5 秒变 5 秒；点名/关键词仍走上面的 pointed 分支（1.5 秒）。
      target = burstMs;
    }

    if (newBurst) return Math.max(wakeDelayMs, Math.round(target));
    if (remaining <= 0) {
      burstStartedAt.set(chatKey, now);
      return 0;
    }
    return Math.max(wakeDelayMs, Math.min(Math.round(target), remaining));
  }

  function scheduleFlush(chatKey, item) {
    // ★ 2026-10-16（用户口径 · 一批一次判定/发言）：已经在队列里等运行的 item **不再排第二次 flush**。
    //   旧行为：条目已排队时收到新消息 ⇒ cancel 空 timer、重新 arm ⇒ 超时后把**同一个 item**
    //   又 push 一次 ⇒ 同一批排两轮（run 中入站 / 因忙碌排队的窗口里必现）。排队期间新消息只并入
    //   `item.evidence`（onInbound），由队列里这一次 flush 一并交给**一轮**。
    if (item.queued === true) return;
    if (item.timer != null) clock.cancel(item.timer);
    // 空闲首条走 wakeDelayMs；后续按 burstAdaptive/settle 聚批；整串仍有硬上限。
    const delay = burstDelayFor(item);
    item.timer = clock.schedule(() => {
      item.timer = null;
      item.queued = true;
      // ★ 2026-10-16（deadline 归位）：这一串已经出车 —— 清掉串起点，让**下一串**从它自己的
      //   第一条重新计硬上限。清前的话，旧串耗掉的 maxWait 会把紧跟着的新串挤成"几乎立即发车"
      //   （`now - started >= maxWait` ⇒ delay 0），聚批就名存实亡。
      burstStartedAt.delete(chatKey);
      queue.push(item);
      void pump();
    }, delay);
  }

  async function ingest(rawBatch) {
    const chatKey = String(rawBatch?.chatKey ?? (Array.isArray(rawBatch) ? rawBatch[0]?.chatKey : '') ?? '');
    const history = await loadSentHistory(chatKey);
    const selfNames = resolveEmotionSelfNames(cfg);
    const options = {
      selfId: platformSelfId(modules),
      selfNames,
      maxTextChars: readConfig(cfg, 'maxTextChars', undefined),
      botSaidLimit: historyLimit
    };
    const source = Array.isArray(rawBatch)
      ? { messages: rawBatch, chatKey: rawBatch[0]?.chatKey, kind: rawBatch[0]?.kind, selfId: rawBatch[0]?.selfId }
      : { ...(rawBatch || {}) };
    if (source.selfId == null || String(source.selfId) === '') source.selfId = options.selfId;
    const normalizeLookupId = (value) => value === null || value === undefined
      ? '' : String(value).trim().replace(/^-/, '');
    const rawItems = Array.isArray(source.raw) ? source.raw
      : (Array.isArray(source.messages) ? source.messages : []);
    const batchNames = new Map();
    for (const raw of rawItems) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const sender = raw.sender && typeof raw.sender === 'object' && !Array.isArray(raw.sender)
        ? raw.sender : null;
      const id = normalizeLookupId(sender
        ? (sender.user_id ?? sender.id ?? sender.uin)
        : (raw.senderId ?? raw.user_id ?? raw.userId));
      if (!id) continue;
      const candidates = [
        [sender?.card, 0], [sender?.nickname, 1], [sender?.name, 2], [sender?.nick, 3],
        [raw.senderName, 4], [raw.nickname, 5]
      ];
      for (const [value, rank] of candidates) {
        const name = typeof value === 'string' ? value.trim() : '';
        if (!name) continue;
        const previous = batchNames.get(id);
        if (!previous || rank < previous.rank) batchNames.set(id, { name, rank });
        break;
      }
    }

    // ChatStore is the existing local member-name view. Keep this batch-local;
    // do not create a second persisted sender index.
    const chatStore = modules.memory?.store;
    let memberNames = null;
    let memberIndexStatus = 'not-queried';
    const readMemberNames = () => {
      if (memberNames) return memberNames;
      memberNames = new Map();
      if (typeof chatStore?.activeMembers !== 'function') {
        memberIndexStatus = 'missing';
        return memberNames;
      }
      try {
        const members = chatStore.activeMembers(chatKey, Number.MAX_SAFE_INTEGER);
        if (Array.isArray(members)) {
          for (const member of members) {
            const id = normalizeLookupId(member?.userId ?? member?.senderId);
            const name = typeof member?.name === 'string' ? member.name.trim() : '';
            if (id && name && !memberNames.has(id)) memberNames.set(id, name);
          }
          memberIndexStatus = 'available';
        } else {
          memberIndexStatus = 'invalid';
        }
      } catch {
        memberIndexStatus = 'failed';
      }
      return memberNames;
    };
    const unresolvedAtNames = new Set();
    options.resolveAtName = (value) => {
      const id = normalizeLookupId(value);
      const fromBatch = batchNames.get(id)?.name;
      if (fromBatch) return fromBatch;
      const fromStore = readMemberNames().get(id);
      if (fromStore) return fromStore;
      if (id && !unresolvedAtNames.has(id)) {
        unresolvedAtNames.add(id);
        log(logSink, 'warn', 'at-name-unresolved', { chatKey, at: id, memberIndex: memberIndexStatus });
      }
      return '';
    };
    const unresolvedQuotes = new Set();
    options.resolveQuote = (value) => {
      // ★ 2026-10-22（溟）：引用目标是**消息 id**，负号有意义（`-941650321` ≠ `941650321`）。
      //   原来这里复用了给「@人」用的 normalizeLookupId（会去掉首位 `-`），而预取表是按带符号 id
      //   存的 ⇒ 群里引用一条负 id 的消息永远查不到，日志只有 quoted-target-unresolved。
      //   改成只用 msg-ref 的口径（去 #、去空白、去 .0），不碰符号。
      const id = normalizeRef(value);
      if (!id) return null;
      let found = null;
      try {
        const lookup = chatStore?.findByRef ?? chatStore?.findByMid;
        if (typeof lookup === 'function') found = lookup.call(chatStore, chatKey, id) ?? null;
      } catch (error) {
        log(logSink, 'warn', 'quote-lookup-failed', {
          chatKey, reason: String(error?.message ?? error).slice(0, 120)
        });
      }
      if (!found) {
        // ★ N-QUOTE-FALLBACK：库里没有 ⇒ 查协议端预取缓存（老树 src/app.js:857 的主路径）
        const prefetched = quoteFallback.get(quoteKey(chatKey, id));
        if (prefetched) return prefetched;
        if (!unresolvedQuotes.has(id)) {
          unresolvedQuotes.add(id);
          log(logSink, 'warn', 'quoted-target-unresolved', { chatKey, replyTo: id });
        }
        return null;
      }
      return {
        id: String(found.mid ?? found.id ?? id),
        sender: String(found.senderName ?? ''),
        senderId: found.senderId ?? '',
        self: found.self === true,
        text: typeof found.text === 'string' ? found.text : ''
      };
    };

    // ── ★ N-QUOTE-FALLBACK（引用兜底，2026-10-11）──────────────────────────
    // 断点：resolveQuote 原本只有 ChatStore 一条路 ⇒ 被引消息不在库里时（bot 没开到那条、
    //   P0 落盘之前的历史、未落盘会话）quoted=null，模型只看到 replyToMessageId 编号，
    //   不知道被引的是什么。老树口径（src/app.js:855-891 resolveReply）：**主路径是
    //   onebot.getMsg(messageId) 回读原文**，本地库只用来补短编号/身份（:875-882）；
    //   取不到时 segmentsToText 落 `[引用消息]` 占位（src/onebot.js:585）——新树同样缺。
    // ★ 为什么预取在 ingestBatch 之前：M5 的解析器是**同步契约**（async 返回值会被
    //   segments.js 的 callQuoteResolver 忽略）⇒ 不能把 resolveQuote 改成 async。
    // 纯逻辑与牙齿都在 modules/scenario/quote-fallback.js；这里只注入三个依赖。
    const quotePrefetch = await prefetchQuoteFallback({
      items: Array.isArray(source.raw) ? source.raw : [],
      chatKey,
      selfId: String(options.selfId ?? ''),
      storeHas: (id) => {
        try {
          const lookup = chatStore?.findByRef ?? chatStore?.findByMid;
          return typeof lookup === 'function' ? Boolean(lookup.call(chatStore, chatKey, id)) : false;
        } catch { return false; }   // 库读失败当没有——协议端还能试一次
      },
      fetchViaProtocol: async (id, { signal = null, timeoutMs = QUOTE_FALLBACK_TIMEOUT_MS } = {}) => {
        const platform = modules.platform;
        const getMsg = platform?.getMsg;
        const call = platform?.call;
        if ((typeof getMsg !== 'function' && typeof call !== 'function') || signal?.aborted) return null;
        // ★ 第七批：账号/实例/连接代际隔离（两层缓存的这一层）。
        const identity = quoteProtocolIdentity();
        if (identity.connected === false) return null;   // 连接已断：不发起、也不复用旧缓存
        const cacheKey = `${identity.accountId}\u0000${identity.instanceId}\u0000${identity.generation ?? '-'}\u0000${chatKey}\u0000${String(id ?? '').trim()}`;
        const cached = quoteProtocolCache.get(cacheKey);
        if (cached && sameQuoteProtocolIdentity(cached.identity, identity)
          && Date.now() - cached.at < QUOTE_PROTOCOL_CACHE_TTL_MS) return cached.data;
        if (cached) quoteProtocolCache.delete(cacheKey);
        const pending = quoteProtocolInFlight.get(cacheKey);
        if (pending && sameQuoteProtocolIdentity(pending.identity, identity)) return pending.promise;
        if (quoteProtocolInFlight.size >= QUOTE_PROTOCOL_INFLIGHT_MAX) return null;
        const requestedTimeout = Number(timeoutMs);
        const boundedTimeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
          ? Math.max(1, Math.min(QUOTE_FALLBACK_TIMEOUT_MS, Math.floor(requestedTimeout)))
          : QUOTE_FALLBACK_TIMEOUT_MS;
        const operation = (async () => {
          try {
            const numeric = Number(id);
            const params = { message_id: Number.isSafeInteger(numeric) ? numeric : String(id) };
            const data = typeof getMsg === 'function'
              ? await getMsg.call(platform, id, {
                chatKey,
                signal,
                timeoutMs: boundedTimeout,
                validate: (candidate) => quoteProtocolBelongsToChat(candidate, {
                  chatKey, selfId: identity.accountId, messageId: id
                })
              })
              : await call.call(platform, 'get_msg', params, boundedTimeout, { signal, totalTimeoutMs: boundedTimeout });
            // ★ 第七批/第八批：取消、截止、账号/实例/代际变化后的响应不入两层正缓存。
            if (signal?.aborted) return null;
            const after = quoteProtocolIdentity();
            if (!sameQuoteProtocolIdentity(identity, after) || after.connected === false) {
              log(logSink, 'info', 'quote-fallback-dropped-stale-identity', { chatKey });
              return null;
            }
            // 归属校验：类型、群/对端绑定、返回 message_id 与请求一致；未取得完整证明就降级。
            if (!quoteProtocolBelongsToChat(data, {
              chatKey,
              selfId: after.accountId,
              messageId: id
            })) {
              log(logSink, 'warn', 'quote-fallback-rejected-foreign-message', {
                chatKey, replyTo: String(id ?? '').slice(0, 32)
              });
              return null;
            }
            if (signal?.aborted) return null;
            quoteProtocolCache.set(cacheKey, { at: Date.now(), data, identity: after });
            while (quoteProtocolCache.size > QUOTE_PROTOCOL_CACHE_MAX) {
              quoteProtocolCache.delete(quoteProtocolCache.keys().next().value);
            }
            return data;
          } catch (error) {
            log(logSink, 'warn', 'quote-fallback-failed', {
              chatKey, replyTo: String(id ?? '').slice(0, 32), reason: String(error?.message ?? error).slice(0, 120)
            });
            return null;
          }
        })();
        const request = { identity, promise: operation };
        quoteProtocolInFlight.set(cacheKey, request);
        const onRequestAbort = () => {
          if (quoteProtocolInFlight.get(cacheKey) === request) quoteProtocolInFlight.delete(cacheKey);
        };
        signal?.addEventListener?.('abort', onRequestAbort, { once: true });
        if (signal?.aborted) onRequestAbort();
        try {
          return await operation;
        } finally {
          signal?.removeEventListener?.('abort', onRequestAbort);
          if (quoteProtocolInFlight.get(cacheKey) === request) quoteProtocolInFlight.delete(cacheKey);
        }
      },
      timeoutMs: QUOTE_FALLBACK_TIMEOUT_MS,
      signal: options.signal ?? null,
      log: (name, fields) => log(logSink, 'warn', name, fields)
    });
    const quoteFallback = quotePrefetch.fallback;

    // Never trust caller-provided botSaid; only E receipts held in the send ledger enter A.
    source.botSaid = history.map(({ id, text, at, receipt }) => ({ id, text, at, receipt }));
    const evidence = await modules.scenario.ingestBatch(source, options);
    let rows = Array.isArray(evidence) ? evidence : evidence?.evidence || [];
    const replayFacts = Array.isArray(source.unreadReplayFacts) ? source.unreadReplayFacts : [];
    if (replayFacts.length) {
      const factsById = new Map(replayFacts.map((fact) => [String(fact?.id ?? ''), fact]));
      rows = rows.map((entry) => {
        const fact = factsById.get(String(entry?.id ?? ''));
        if (!fact || (fact.toSelf !== true && fact.replyToSelf !== true)) return entry;
        return { ...entry, refs: { ...(entry.refs || {}), toSelf: true } };
      });
    }
    for (const entry of rows) emit(bus, 'evidence:built', { evidenceId: entry?.id, chatKey: entry?.chatKey });
    return rows;
  }

  // ── 回复后自动配一张表情（老树 src/orchestrator.js:2233-2403）────────────────────────
  //   老树口径：文字先发出 → 按配置概率（"明确要表情"时拉满）再挑一张；候选走既有 sticker
  //   通道的旋转/冷却/备注过滤；挑不出来就什么都不发（宁可不发，也不发错）。
  //   新树接线：挑图仍是主模型一枪（预算内，复刻 compose 的 chatCompletionWithBudget 同形；
  //   那一枪只回序号，不碰 QQ）；发送**只走 M10**（act.run → send_sticker → act.send 回执），
  //   不碰平台、不重试、不把正文当载荷。成功/跳过/失败只记短码与用量。
  const autoStickerAtByChat = new Map();

  /** 老树 :2296-2322 的「挑哪张」这一枪（预算内；任何失败都只返回 null，不抛回主链）。 */
  async function pickAutoStickerIndex({ chatKey, kind, ids, table, sentRows, roundId, signal, personaShortTerm = null }) {
    const unavailable = (code) => {
      log(logSink, 'warn', 'auto-sticker-pick-unavailable', { chatKey, roundId, code });
      return null;
    };
    const llmMod = modules?.llm;
    if (typeof llmMod?.chatCompletionWithRetryBudgeted !== 'function') return unavailable('llm-unavailable');
    const budgetService = modules?.llmBudgetService;
    if (!budgetService || typeof budgetService.reserve !== 'function' || typeof budgetService.settle !== 'function') return unavailable('budget-service-unavailable');
    let requestId = '';
    try { requestId = String(budgetService.newRequestId?.() ?? '').trim(); } catch { requestId = ''; }
    const accountId = platformSelfId(modules);
    if (!requestId) return unavailable('request-id-unavailable');
    if (!accountId) return unavailable('budget-account-id-unavailable');
    // ★ 2026-10-26（溟）：maxTokens 64 → 256。64 是本机思考模型的下限陷阱 ——
    //   reasoning 一开口就把 64 吃光，tool_calls 永远空（当天 no-match 103 次、成功 0 次）。
    //   真正的修法在 llm.js:thinkingStyleFor（localhost 判成 deepseek 才会下发
    //   thinking:{type:'disabled'}）；这里只是双保险：端点不认那个字段时，256 仍留出
    //   把 tool_call 说完的余量。关掉思考后实测只需 38 token，多出来的余量不会被花掉。
    const overrides = { maxTokens: 256, disableThinking: true };
    let activeApi = null;
    try { activeApi = llmMod.apiWith?.(overrides) ?? null; } catch { /* 活跃 API 取不到时回落配置模型 */ }
    let effectiveModel = null;
    try { effectiveModel = cfg?.effective?.('api.model', { chatKey, kind }); } catch { /* 用下面的配置值 */ }
    const configuredModel = effectiveModel && typeof effectiveModel === 'object' ? effectiveModel.value : effectiveModel;
    const model = String(configuredModel || activeApi?.model || cfg?.get?.('api.model', '') || '').trim();
    if (!model) return unavailable('model-unavailable');
    let instanceId = '';
    try { instanceId = String(modules?.configStore?.describeInstance?.() ?? '').trim(); } catch { instanceId = ''; }
    const scopeValue = (value) => String(value ?? '').trim().slice(0, 120);
    const budgetRequest = {
      requestId, accountId, instanceId, purpose: 'sticker_autopick', model,
      chatKey: scopeValue(chatKey)
    };
    // 最近对话 + 本轮实际发出的回复（老树 :2279-2288 同料：让主模型按"自己刚说的话"挑配图）。
    const recent = (() => {
      try {
        const rows = modules?.memory?.store?.recent?.(chatKey, { limit: 6 }) || [];
        // ★ 2026-10-17（编排侧短期分界）：最近六条也是发给模型的短期输入 —— 用本轮冻结快照收窄
        //   （分界前/时间不可信的行不喂给挑图这一枪）；本轮已发出的回复在上方另取，不受影响。
        //   没带上游 filter（独立调用）⇒ 不筛，保持旧行为。
        const shortTerm = personaShortTerm && typeof personaShortTerm.filter === 'function'
          ? personaShortTerm
          : makeShortTermFilter({ modules, snapshot: null });
        return shortTerm.filter(rows, (message) => message?.at ?? message?.ts).rows
          .map((message) => `${message?.self ? '我' : String(message?.senderName ?? '') || '对方'}：${String(message?.text ?? '').slice(0, 80)}`).join('\n');
      } catch { return ''; }
    })();
    const sentText = (Array.isArray(sentRows) ? sentRows : [])
      .map(sentTextFromToolResult).filter(Boolean).slice(-3)
      .map((text) => `我：${String(text).slice(0, 160)}`).join('\n');
    const chatContext = [recent, sentText ? `【本轮已发出的回复】\n${sentText}` : ''].filter(Boolean).join('\n');
    const startedAt = clockNow(clock);
    let result;
    try {
      result = await llmMod.chatCompletionWithRetryBudgeted({
        messages: [
          {
            role: 'system',
            content: '你在给 QQ 群聊刚发出的回复配一张收藏表情。结合最近对话和本轮回复，从候选中挑最贴切的一张。'
              + '候选项只有备注文字，不能据此臆测图片里备注未提到的动作、文字或水印；备注含糊或没有合适项时填 0。'
              + '用 pick_sticker 工具回答，index 填候选序号；都不合适就填 0。不要输出别的。'
          },
          { role: 'user', content: `【候选表情】\n${autoStickerNumberedLines(ids, table)}\n\n【最近对话】\n${chatContext || '（无）'}` }
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'pick_sticker',
            description: '从候选表情里挑一张最贴切的',
            parameters: {
              type: 'object',
              properties: { index: { type: 'integer', description: '候选序号（1 开始）；都不合适填 0' } },
              required: ['index']
            }
          }
        }],
        toolChoice: 'auto',
        temperature: 0.3,
        affinityKey: chatKey,
        overrides,
        signal,
        roundId,
        // ★ 2026-10-16（收口 · 越界发现 #2 的修复）：这一枪是**真花额度**的模型调用 ——
        //   `budgetService` 与 `budgetRequest` 必须一起进首参，否则 `executeBudgetedRequest`
        //   第一步就回 `budget-service-unavailable`（挑图静默降级成"永远挑不到"）。
        //   形状与 compose 的 `chatCompletionWithBudget`（compose.js:601-603）一致：
        //   requestId/accountId(纯数字)/instanceId/purpose/model + chatKey 作用域；
        //   预留与结算都由 llmBudgetService 做（多次 fetch 时按 wrapper 语义结算为 unknown）。
        budgetService,
        budgetRequest
      }, 2, null);
    } catch (error) {
      log(logSink, 'warn', 'auto-sticker-pick-failed', { chatKey, roundId, code: String(error?.name || 'model-call-error').slice(0, 48) });
      return null;
    }
    if (result?.ok !== true || !result.result) {
      log(logSink, 'warn', 'auto-sticker-pick-unavailable', { chatKey, roundId, code: String(result?.reason || 'budget-request-rejected').slice(0, 48) });
      return null;
    }
    const response = result.result;
    // 用量入账（老树 D-3 同义）：这一枪在主循环之外，不能只花 token 不留痕。
    // ★ 2026-10-17（缓存真实诊断 · 473d331f）：purpose=auto_sticker；缓存读数改走
    //   readCacheUsageReport（request-budget.js:146）—— 它只认"供应商真报了的数"，
    //   缺失=null 且有 reported.* 布尔；readUsageNumbers 那个 num() "找不到就 0"的
    //   陷阱（看的人没法区分命中 0 和没报告）不再复制到这里。
    try {
      const rawUsage = response?.raw?.usage ?? response?.usage ?? null;
      const report = typeof llmMod.readCacheUsageReport === 'function'
        ? llmMod.readCacheUsageReport(rawUsage ?? {}) : null;
      const count = (value) => {
        if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
        const amount = Number(value);
        return Number.isFinite(amount) && amount >= 0 ? Math.floor(amount) : null;
      };
      const usageRow = {
        chatKey, roundId, at: clockNow(clock), callCount: 1,
        purpose: 'auto_sticker',
        usageIncomplete: !rawUsage,
        cacheUsageReported: report?.reported?.prompt_tokens === true
          && report?.reported?.prompt_cache_hit_tokens === true,
        durationMs: Math.max(0, clockNow(clock) - startedAt)
      };
      if (model) usageRow.model = model;
      const tokens = {
        promptTokens: report?.prompt_tokens ?? rawUsage?.promptTokens,
        completionTokens: rawUsage?.completionTokens ?? rawUsage?.completion_tokens ?? rawUsage?.output_tokens ?? rawUsage?.outputTokens,
        cachedTokens: report?.prompt_cache_hit_tokens,
        cacheCreationTokens: report?.cache_creation_tokens,
        webSearchCount: rawUsage?.webSearchCount ?? rawUsage?.web_search_count
      };
      for (const [key, value] of Object.entries(tokens)) {
        const amount = count(value);
        if (amount !== null) usageRow[key] = amount;
      }
      modules?.observability?.ledger?.('usage', usageRow);
    } catch (error) {
      log(logSink, 'warn', 'auto-sticker-usage-ledger-failed', { chatKey, roundId, code: String(error?.name || 'ledger-failed').slice(0, 48) });
    }
    const call = (response?.message?.tool_calls || [])[0];
    let index = NaN;
    try {
      const rawArgs = call?.function?.arguments;
      const parsed = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : (rawArgs || {});
      index = Number(parsed.index);
    } catch { /* 工具参数坏了按"没挑中"处理 */ }
    // 少数 OpenAI 兼容端点会忽略 tool_choice=auto 并回纯文本；仅接受严格的整数兜底（老树 :2345-2349）。
    if (!Number.isFinite(index)) {
      const plain = String(response?.message?.content ?? '').trim();
      if (/^(?:0|[1-9]\d*)$/.test(plain)) index = Number(plain);
    }
    if (!Number.isInteger(index) || index < 1 || index > ids.length) {
      // ★ 2026-10-26（溟）：no-match 原来只有一个短码，看不出是"模型觉得都不合适(0)"
      //   还是"根本没回 tool_call"。把当场证据记下来：候选条数、模型给的原始参数、
      //   正文前 60 字。排障时先看这条，再决定动哪。
      log(logSink, 'info', 'auto-sticker-no-match-detail', {
        chatKey, roundId, candidates: ids.length,
        rawArgs: String(call?.function?.arguments ?? '').slice(0, 120),
        content: String(response?.message?.content ?? '').trim().slice(0, 60),
        index: Number.isFinite(index) ? index : null
      });
      return null;
    }
    return index;
  }

  /**
   * 老树 :4443-4453 的调用条件 + :2242-2403 的完整链。返回后由调用点继续走 writeFinish。
   * 门（任一不过就不外发）：sticker 总开关 / autoPick.enabled 严格 true / 非亢奋 / 发送结果不未知 /
   * 本轮有确认投递成功的文字 / 本轮没发过表情或图 / 概率 / 冷却 / 有可用候选。
   */
  async function maybeSendAutoSticker({ run, chatKey, kind, roundId, evidence, primary, allToolResults, textDelivered, replyContext, jevSignal, idempotencyKey, uniqueReceiptEntries }) {
    const skip = (code) => log(logSink, 'info', 'auto-sticker-skip', { chatKey, roundId, code });
    if (readConfig(cfg, 'sticker.enabled', true) === false) return skip('master-off');
    if (readConfig(cfg, 'sticker.autoPick.enabled', false) !== true) return skip('autopick-off');
    if (modules.emotion?.isHypeMode?.() === true) return skip('hype');
    if (run.sendOutcomeUnknown) return skip('send-unknown');
    if (!textDelivered) return skip('no-text-delivered');
    const mediaAlreadySent = (Array.isArray(allToolResults) ? allToolResults : []).some((row) => {
      if (!AUTO_STICKER_MEDIA_TOOLS.has(String(row?.tool ?? ''))) return false;
      if (row?.state === 'unknown' || row?.receipt?.state === 'unknown') return true;      // 结果未知 ⇒ 不补发
      return row?.receipt?.ok === true && Boolean(row.receipt.platformId);                 // 已确认投递的图/表情
    });
    if (mediaAlreadySent) return skip('media-already-sent');
    // 老树 :2252：别人明确要表情时概率拉满（词表逐字；Jev stickerAskGate 新树没有）。
    const askText = (Array.isArray(evidence) ? evidence : [])
      .map((entry) => String(entry?.text ?? '')).filter(Boolean).join('\n').slice(-300);
    const asked = AUTO_STICKER_ASK_RE.test(askText);
    const probability = Math.max(0, Math.min(1, Number(readConfig(cfg, 'sticker.autoPick.probability', 0.35))));
    if (!asked && !(probability > 0)) return skip('probability-zero');
    if (!asked) {
      if (typeof clock.random !== 'function') {
        log(logSink, 'warn', 'auto-sticker-random-unavailable', { chatKey, roundId });
        return skip('random-unavailable');
      }
      const roll = Number(clock.random());
      if (!(roll >= 0 && roll < 1)) return skip('random-invalid');
      if (roll >= probability) return skip('probability-miss');
    }
    const nowMs = clockNow(clock);
    const cooldownMs = Math.max(0, Number(readConfig(cfg, 'sticker.autoPick.cooldownMs', 120000)));
    if (cooldownMs && nowMs - (autoStickerAtByChat.get(chatKey) || 0) < cooldownMs) return skip('cooldown');
    const media = modules?.media;
    if (typeof media?.loadStickerStore !== 'function' || typeof media?.buildStickerContext !== 'function') {
      log(logSink, 'warn', 'auto-sticker-media-unavailable', { chatKey, roundId });
      return skip('media-unavailable');
    }
    let entries = [];
    try { entries = media.loadStickerStore() || []; } catch { entries = []; }
    if (!entries.length) return skip('no-candidates');
    const shortlist = Math.max(3, Math.min(12, Number(readConfig(cfg, 'sticker.autoPick.shortlist', 8)) || 8));
    const table = media.buildStickerContext(entries, shortlist, {
      now: nowMs,
      rotatePeriodMs: Math.max(60000, Number(readConfig(cfg, 'sticker.rotatePeriodMin', 60)) || 60) * 60000,
      cooldownMs: Math.max(0, Number(readConfig(cfg, 'sticker.cooldownMin', 0)) || 0) * 60000,
      keepFamiliar: readConfig(cfg, 'sticker.keepFamiliar', undefined)
    });
    const ids = autoStickerTableIds(table);
    if (!ids.length) return skip('no-candidates');
    const picked = await pickAutoStickerIndex({
      chatKey, kind, ids, table, roundId, signal: run.signal,
      // ★ 2026-10-17：挑图这一枪的短期输入与 JEV/compose 共用**本轮冻结快照**（不重读 live）。
      personaShortTerm: makeShortTermFilter({ modules, snapshot: run?.personaSnapshot ?? null }),
      sentRows: (Array.isArray(allToolResults) ? allToolResults : []).filter((row) => row?.receipt?.ok === true && row.receipt.platformId)
    });
    if (picked === null) return skip('no-match');
    const stickerId = ids[picked - 1];
    const stickerPlan = Object.freeze({
      action: 'tool',
      reason: 'auto-sticker',
      toolPlan: [{ name: 'send_sticker', args: { stickerId }, sideEffect: 'write' }]
    });
    const actStartedAt = clockNow(clock);
    let rows = [];
    try {
      rows = await modules.act?.run?.(stickerPlan, {
        platform: modules.platform, cfg, sendBudget: run.sendBudget, skills: modules.skills, budget: modules.budget,
        evidence, context: replyContext, jevSignal, signal: run.signal,
        chatKey, kind, evidenceId: primary?.id, modules, plan: stickerPlan,
        // 幂等键按轮唯一 ⇒ 重入/重试不会重复发；act 对已成功的写入会命中备忘。
        idempotencyKey: `${idempotencyKey || `auto-sticker:${chatKey}:${roundId}`}:sticker`
      }) || [];
    } catch (error) {
      log(logSink, 'warn', 'auto-sticker-act-failed', { chatKey, roundId, code: String(error?.name || 'act-run-error').slice(0, 48) });
      rows = [];
    }
    const row = (Array.isArray(rows) ? rows : []).find((item) => String(item?.tool ?? '') === 'send_sticker') || null;
    // ★ 2026-10-17：投递态按 act 的四态合同读（`deliveryState` 是权威，见 act/index.js:1277-1310）：
    //   · delivered ⇒ 记回执（下方）；
    //   · unknown   ⇒ **不记投递**、单独上浮 + 计数（不混进"发送失败"，也不对整轮文字投递下结论）；
    //   · failed / not_deliverable ⇒ 按失败记短码。
    const stickerDelivery = String(row?.data?.deliveryState ?? '');
    const delivered = row?.ok === true && stickerDelivery === 'delivered';
    const stickerUnknown = row?.state === 'unknown' || String(row?.receipt?.state ?? '') === 'unknown'
      || stickerDelivery === 'unknown';
    // 老树 :2367/:2379/:2387/:2392：成功/失败/未知都记冷却（别在同一条坏表情上反复试）。
    autoStickerAtByChat.set(chatKey, clockNow(clock));
    if (delivered) {
      if (Array.isArray(uniqueReceiptEntries) && row?.receipt) {
        uniqueReceiptEntries.push({
          receipt: row.receipt, coverage: row.receipt.coverage ?? null, tool: 'send_sticker',
          idempotencyKey: String(row.receipt.idempotencyKey ?? row.idempotencyKey ?? ''),
          sessionId: run.sessionId, roundId
        });
      }
      log(logSink, 'info', 'auto-sticker-sent', {
        chatKey, roundId, stickerId, platformId: String(row?.receipt?.platformId ?? '')
      });
      return;
    }
    if (stickerUnknown) {
      // 「未知不重发」：冷却已在上面按老树口径记账（下一次自动配图会先被冷却挡掉）；
      //   这里只把"已发起、结果未知"如实上浮 —— 不冒充失败，也不把它算成已确认投递。
      run.unknownStickerCount = Math.max(0, Number(run.unknownStickerCount) || 0) + 1;
      log(logSink, 'warn', 'auto-sticker-send-unknown', {
        chatKey, roundId, stickerId, code: String(row?.reasonCode || row?.state || 'unknown').slice(0, 48)
      });
      return;
    }
    log(logSink, 'info', 'auto-sticker-send-failed', {
      chatKey, roundId, code: String(row?.reasonCode || row?.state || stickerDelivery || 'not-delivered').slice(0, 48),
      // ★ 2026-10-26（溟）：executor-failed 原来只有短码。执行器真实原因（找不到表情 / 字节取不到 /
      //   pendingSend 没被投递）必须落进日志，否则只能靠猜。
      detail: String(row?.error ?? row?.data?.error ?? row?.data?.note ?? row?.receipt?.error ?? '').slice(0, 200),
      stickerId: String(stickerId || '').slice(0, 60)
    });
  }

  async function runRound(item) {
    item.retryQueued = false;
    const chatKey = item.chatKey;
    const evidence = item.evidence;
    // C10: followup batch items are processed through the judgment/speech chain.
    const isFollowupBatch = item.followupBatch === true;
    let followupVerdictRecorded = false;
    if (!Array.isArray(item.inboundReadClaims)) item.inboundReadClaims = [];
    if (!item.inboundClaimsAttempted) {
      item.inboundClaimsAttempted = true;
      const claim = claimIncomingReadBatch(chatKey, item.inboundUnreadIds);
      if (claim) item.inboundReadClaims.push(claim);
    }
    const proactive = item.proactive === true;
    const proactiveReason = String(item.proactiveReason ?? '');
    const roundId = `m15-${++roundSeq}`;
    const controller = new AbortController();
    const runKind = evidence?.[0]?.kind === 'private' || (!evidence?.length && chatKey.startsWith('private:')) ? 'private' : 'group';
    const sharedSendBudget = item.sendBudget && typeof item.sendBudget === 'object'
      ? item.sendBudget : (item.sendBudget = textSendBudget(cfg, chatKey, runKind));
    const run = { bus, chatKey, roundId, cfg, modules, sendBudget: sharedSendBudget, stage: 'memory', finish: null, startedAt: clockNow(clock), clock, log: logSink, sessionRegistry, sessionId: '', sentAnything: false, sendOutcomeUnknown: false, unknownSendMessageCount: 0, unknownSendKeys: new Set(), confirmedSendReceipts: [], attempt: Number(item.attempt ?? 1), proactive, proactiveReason, lane: item.lane ?? '', source: item.source ?? '', abort: (reason) => controller.abort(reason), signal: controller.signal, obs: modules.observability ?? null, trace: null, stageToken: null, planDecisionLedger: null, decisionLedgerWritten: false, sessionActionDetails: [] };
    let failureReason = null;
    /** M15 是情绪事件的唯一发射点；这一轮跑成功与否都要把"收到了消息"记进去。 */
    let primary = {};
    const toolResultsByName = new Map();
    const memoryToolOutcomes = new Map();
    const toolResultSummaries = new WeakMap();
    const memoryFavorResults = [];
    const memorySelfEvalResults = [];
    const memoryFactResults = [];
    const calendarResults = [];
    const receiptKeys = new Set();
    run.receiptKeys = receiptKeys;
    const recordToolResults = (rows) => {
      for (const row of Array.isArray(rows) ? rows : []) {
        const tool = String(row?.tool ?? '').trim();
        if (!tool) continue;
        const ok = row?.ok === true || row?.receipt?.ok === true;
        const failed = row?.ok === false || row?.receipt?.ok === false;
        if (!ok && !failed) continue;
        // A same-tool retry resolves to one per-round event; any success wins.
        if (ok || !toolResultsByName.has(tool)) toolResultsByName.set(tool, ok);
        const resultText = toolResultText(row);
        if (row && typeof row === 'object') toolResultSummaries.set(row, resultText);
        const memoryOutcome = { tool, ok, state: String(row?.state ?? ''), resultText };
        if (ok || !memoryToolOutcomes.has(tool)) memoryToolOutcomes.set(tool, memoryOutcome);
        if (tool === 'memory_favor' && row?.ok === true && row?.state === 'completed') memoryFavorResults.push(row);
        // ★ 2026-10-11：模型自评（finish 的 mood/favorDelta）—— 只收"真完成了的 finish 回执"。
        if (tool === 'finish' && row?.ok === true && row?.state === 'completed' && row?.data?.finished === true) memorySelfEvalResults.push(row);
        if (tool === 'memory_append' && row?.ok === true && row?.data?.saved === true) memoryFactResults.push(row);
        if (tool === 'memory_todo_save' && row?.ok === true && row?.data?.saved === true) calendarResults.push(row);
      }
    };
    run.recordMemoryOutcome = () => observeMemoryInput.recordOutcome({
      chatKey, kind: primary?.kind === 'private' || runKind === 'private' ? 'private' : 'group',
      turnId: `${roundId}:${run.startedAt}:${primary?.id ?? 'proactive'}`,
      toolResults: [...memoryToolOutcomes.values()], confirmedSendReceipts: run.confirmedSendReceipts
    });
    /**
     * D-2 B：把"这一轮调了哪些工具、成没成"记进 `trace.actions`
     * （UI「工具与回执」那一栏读的就是它）。compose 会给它执行过的行
     * 就地盖上 `traceRound/traceStartedAt/traceEndedAt` ⇒ 面板能看到"第 N 轮"。
     */
    const noteActions = (rows, fallback = {}) => {
      const recordInSession = Boolean(run.sessionRegistry && run.sessionId);
      const recordInObservability = Boolean(run.obs?.recordAction && run.trace);
      if (!recordInSession && !recordInObservability) return;
      for (const row of Array.isArray(rows) ? rows : []) {
        const tool = String(row?.tool ?? '').trim();
        if (!tool) continue;
        const failed = row?.ok === false || row?.receipt?.ok === false;
        const reasonCode = approvedToolReasonCode(row?.reasonCode);
        const truncationReason = approvedToolTruncationReason(row?.truncationReason);
        const rejected = failed && Boolean(reasonCode);
        const action = {
          tool,
          ...(row?.toolCallId ? { callId: String(row.toolCallId).slice(0, 80) } : {}),
          round: row?.traceRound ?? fallback.round ?? null,
          startedAt: row?.traceStartedAt ?? fallback.startedAt ?? clockNow(clock),
          endedAt: row?.traceEndedAt ?? fallback.endedAt ?? clockNow(clock),
          outcome: failed ? 'error' : 'ok',
          ...(failed ? { errorType: reasonCode || String(row?.error || 'tool_failed').slice(0, 48) } : {})
        };
        if (recordInSession) {
          run.sessionActionDetails.push({ ...action, toolCall: {
            args: rejected
              ? { argumentFacts: Array.isArray(row?.argumentFacts) ? row.argumentFacts.slice(0, 16).map((fact) => String(fact).slice(0, 160)) : [] }
              : cloneSessionToolArgs(row?.args),
            result: rejected ? toolFailureSummary(reasonCode) : toolResultSummaries.get(row) || sessionToolResultText(row),
            isError: failed,
            ...(reasonCode ? { reasonCode } : {}),
            ...(truncationReason ? { truncationReason } : {})
          } });
        }
        if (!recordInObservability) continue;
        try {
          run.obs.recordAction(chatKey, roundId, action);
        } catch { /* 观测不许反噬主链 */ }
      }
    };
    const noteRejectedToolAttempts = (rows) => {
      const recordInSession = Boolean(run.sessionRegistry && run.sessionId);
      const recordInObservability = Boolean(run.obs?.recordAction && run.trace);
      for (const row of Array.isArray(rows) ? rows : []) {
        const tool = String(row?.tool ?? '').trim();
        const reasonCode = approvedToolReasonCode(row?.reasonCode);
        if (!tool || !reasonCode) continue;
        const action = {
          tool,
          ...(row?.callId ? { callId: String(row.callId).slice(0, 80) } : {}),
          round: Number.isFinite(Number(row?.traceRound)) ? Number(row.traceRound) : null,
          startedAt: Number.isFinite(Number(row?.traceStartedAt)) ? Number(row.traceStartedAt) : clockNow(clock),
          endedAt: Number.isFinite(Number(row?.traceEndedAt)) ? Number(row.traceEndedAt) : clockNow(clock),
          outcome: 'error',
          errorType: reasonCode
        };
        if (recordInSession) {
          const facts = Array.isArray(row?.argumentFacts)
            ? row.argumentFacts.slice(0, 16).map((fact) => String(fact).slice(0, 160)) : [];
          run.sessionActionDetails.push({ ...action, toolCall: {
            args: { argumentFacts: facts },
            result: toolRejectionSummary(reasonCode),
            isError: true,
            reasonCode
          } });
        }
        if (recordInObservability) {
          try { run.obs.recordAction(chatKey, roundId, action); } catch { /* 观测不许反噬主链 */ }
        }
      }
    };
    const recordToolExecutionEvents = (rows) => {
      for (const row of Array.isArray(rows) ? rows : []) {
        const name = String(row?.tool ?? '').trim();
        if (!name) continue;
        const ok = row?.ok === true;
        const reasonCode = approvedToolReasonCode(row?.reasonCode);
        const truncationReason = approvedToolTruncationReason(row?.truncationReason);
        const state = String(row?.state ?? '').trim().toLowerCase();
        const code = ['completed', 'delivered', 'failed', 'blocked', 'unknown', 'partial'].includes(state)
          ? state : ok ? 'completed' : 'failed';
        try {
          modules.observability?.event?.('tool:executed', {
            chatKey, roundId, stage: 'compose', name, ok, code,
            ...(row?.correlationId ? { correlationId: String(row.correlationId).slice(0, 36) } : {}),
            ...(reasonCode ? { reasonCode } : {}),
            ...(truncationReason ? { truncationReason } : {})
          }, { echo: false });
        } catch (error) {
          log(logSink, 'warn', 'tool-execution-observation-write-failed', {
            chatKey, roundId, name, error: String(error?.message ?? error)
          });
        }
      }
    };
    if (pending.get(chatKey) === item) pending.delete(chatKey);
    runningChats.set(chatKey, run);
    // ★ D-2 B：开轮 —— 面板「来源 · 档位 · 实际发送」那三行读的是 trace 的
    //   lane/source/contextTier，而 beginTurn 在 refactor/modules/** 里原本**零调用者**
    //   ⇒ 三行恒为「来源未知 · 档位 - ·（0 条）」。泳道/来源口径与旧树
    //   `src/orchestrator.js:1654 createTurnTrace` 一致（classifyTurnLane 同源搬过来）。
    try {
      const gate = item.gate ?? null;
      const route = typeof run.obs?.classifyTurnLane === 'function'
        ? run.obs.classifyTurnLane({ proactive, proactiveReason, tierInfo: gate, directAddress: gate?.addressed === true })
        : { lane: '', source: '' };
      const authority = proactive ? 'model_decides'
        : (gate?.kind === 'private' || gate?.addressed === true) ? 'must_reply'
          : gate?.keyword === true ? 'rule_continue'
            : gate ? 'model_decides' : 'unknown';
      run.trace = run.obs?.beginTurn?.({
        chatKey, roundId,
        lane: run.lane || route?.lane || '',
        source: run.source || route?.source || '',
        contextTier: gate?.tier ?? item.contextTier ?? null,
        batchId: roundId,
        authority
      }) ?? null;
    } catch (error) {
      log(logSink, 'warn', 'turn-trace-begin-failed', { chatKey, roundId, error: String(error?.message ?? error) });
      run.trace = null;
    }
    // ★ 2026-10-17：`composed` 必须声明在 try 之外 —— 外层 catch 的安全诊断（系统记录）
    //   要读 `composed?.diagnostics`。放 try 里时，任何 compose 阶段错误都会让 catch
    //   自己抛 `ReferenceError: composed is not defined`：整轮收尾中断、会话卡在 running、
    //   系统记录与 round-finished 都写不下（真实运行路径已复现，见本轮回执）。
    let composed = null;
    try {
      if (paused || abortReason) return writeFinish(run, { status: 'aborted', reason: abortReason || 'paused' });
      if (run.signal.aborted) return writeFinish(run, { status: 'aborted', reason: String(run.signal.reason || 'aborted') });
      if (isFollowupBatch && !followupEnabledFor(chatKey)) {
        // ★ 2026-10-18（followupEnabled 总开关，含热改关闭）：已排队的聚焦批直接收手 ——
        //   不调云、不建会话；verdict 记 SKIP（不清零、不计 NO、不刷窗），在途顺序号照常释放。
        try {
          followupRegistry?.recordVerdict({ chatKey, seq: Number(item.followupSeq), verdict: 'SKIP', at: clockNow(clock) });
        } catch { /* 收口清理不许冒泡 */ }
        followupVerdictRecorded = true;
        followupActiveEffective(chatKey);   // 顺带关掉旧窗、清掉唤醒定时器（关窗后迟到结果按 stale-seq 丢弃）
        return writeFinish(run, { status: 'skipped', reason: 'followup-disabled' });
      }
      // ★ R07（2026-10-18）：多人合批时**触发消息**（点名/@ 机器人的那条）必须当"主消息" ——
      //   改前主消息/接收人/个人记忆对象都取最后一条的发言者（A 点名后 B 插话 ⇒ 回错人、
      //   个人记忆也检索成 B）。evidence 数组本身保持时间顺序（compose 按它拼正文），只把
      //   **计划与判定视图**的最后一条换成触发消息；其余消息仍全部作为上下文与 botSaidBefore 来源。
      // ★ 2026-10-19（N3）：关键词触发 / 引用机器人同样算触发者 —— 触发在前、普通消息在后时，
      //   不能让后者当主消息（否则 plan 按普通消息抽样，整批被骰子失败吞掉）。
      //   优先级：最后一条 @/引用机器人（直接点名）> 最后一条"内容触发"（关键词命中或引用机器人历史消息）；
      //   都没有才用最后一条。
      const triggerKind = evidence[0]?.kind === 'private' ? 'private' : 'group';
      const triggerKeywords = readScopedConfig(cfg, 'store.keywords', { chatKey, kind: triggerKind }, []);
      const contentTriggerIndex = (() => {
        for (let index = evidence.length - 1; index >= 0; index -= 1) {
          const entry = evidence[index];
          const text = String(entry?.text ?? '');
          if (text) {
            const hit = (Array.isArray(triggerKeywords) ? triggerKeywords : []).some((value) => {
              const keyword = String(value ?? '').trim();
              return keyword && matchesTierKeyword(text, [keyword]);
            });
            if (hit) return index;
          }
          // 引用机器人历史消息（有效续聊）：refs.replyTo 命中该条的 botSaidBefore id。
          const replyToRaw = entry?.refs?.replyTo;
          const replyTo = replyToRaw && typeof replyToRaw === 'object' ? replyToRaw.id : replyToRaw;
          if (replyTo != null && String(replyTo).trim() !== '') {
            const botSaid = Array.isArray(entry?.botSaidBefore) ? entry.botSaidBefore : [];
            if (botSaid.some((message) => String(message?.id ?? '') === String(replyTo))) return index;
          }
        }
        return -1;
      })();
      const addressedTriggerIndex = (() => {
        for (let index = evidence.length - 1; index >= 0; index -= 1) {
          const entry = evidence[index];
          if (entry?.toSelf === true || entry?.refs?.toSelf === true
            || (Array.isArray(entry?.mentions) && entry.mentions.some((mention) => mention?.isSelf === true))) return index;
        }
        return -1;
      })();
      const triggerIndex = addressedTriggerIndex >= 0 ? addressedTriggerIndex : contentTriggerIndex;
      const planEvidence = triggerIndex >= 0 && triggerIndex !== evidence.length - 1
        ? [...evidence.slice(0, triggerIndex), ...evidence.slice(triggerIndex + 1), evidence[triggerIndex]]
        : evidence;
      primary = planEvidence[planEvidence.length - 1] || {};
      // 主动轮没有证据 ⇒ 会话种类从 chatKey 派生（`primary.kind` 优先，普通入站行为逐字节不变）。
      const kind = primary.kind || (proactive ? (item.kind || kindOfChatKey(chatKey)) : '') || 'group';
      const senderId = primary.sender?.id;
      const topic = item.contextHint?.topic;

      // Dual-persona lifecycle runs before this round's prompt is built. Exit requests
      // from switch_back are durable, but take effect only on the next round.
      try {
        const persona = modules.emotion;
        const pendingExit = await persona?.consumePendingExit?.(persona.stateOf?.());
        if (pendingExit?.consumed === true) {
          log(logSink, 'info', 'persona-two-exit-consumed', { chatKey, roundId, enabled: persona.isPersonaTwo?.() === true });
        } else if (persona?.isPersonaTwo?.() !== true && typeof persona?.maybeAutoEnter === 'function') {
          const decision = persona.maybeAutoEnter(persona.stateOf?.());
          if (decision?.enter === true) {
            const entered = await persona.setPersonaTwo?.(true, { reason: decision.reason });
            if (entered?.ok === true) log(logSink, 'info', 'persona-two-auto-entered', { chatKey, roundId, reason: decision.reason });
            else log(logSink, 'warn', 'persona-two-auto-entry-rejected', { chatKey, roundId, reason: entered?.error ?? 'state service unavailable' });
          }
        }
      } catch (error) {
        log(logSink, 'warn', 'persona-two-transition-failed', { chatKey, roundId, error: String(error?.message ?? error) });
      }

      // ★ 2026-10-17（编排侧人设短期分界 · 同一轮冻结一次）：真实切换后**发给模型的短期输入**
      //   要按分界收窄。本轮 JEV 判定输入（botSaidBefore/被引原话/activeTopic）、JEV 记忆补取合流、
      //   主模型 compose、回复后自动表情共用这一份 snapshot —— 不各阶段重读 live（跨 await 切卡
      //   不会跨代混用）。放在人格生命周期之后：本轮自动进入第二人格要影响本轮提示词
      //   （生命周期注释见上）。长期来源（印象/事实/偏好/语义卡/情节/向量/授权/待办）不走这里。
      const personaBoundary = modules?.personaBoundary ?? null;
      const personaSnapshot = personaBoundary && typeof personaBoundary.current === 'function'
        ? personaBoundary.current() : null;
      const personaShortTerm = makeShortTermFilter({ modules, snapshot: personaSnapshot });
      run.personaSnapshot = personaSnapshot;

      // Persist source evidence before plan can choose wait/skip. The fallback writes
      // only validated inbound evidence; it never promotes model body/thought to a fact.
      try {
        const observed = await observeMemoryInput({ chatKey, kind, evidence, roundId });
        run.memoryEvidenceIds = new Set(Array.isArray(observed.ledgerEvidenceIds) ? observed.ledgerEvidenceIds : []);
        run.memoryObservation = {
          observed: observed.observed, queued: observed.queued, duplicates: observed.duplicates,
          invalid: observed.invalid, persisted: observed.persisted === true,
          cursorAdvanced: observed.cursorAdvanced === true,
          cursorEventVersion: String(observed.cursor?.eventVersion ?? ''),
          cursorMode: String(observed.cursorMode ?? ''), reason: String(observed.reason ?? '')
        };
        log(logSink, observed.ok === false ? 'warn' : 'info', 'memory-input-observed', {
          chatKey, roundId, kind, messageCount: Array.isArray(evidence) ? evidence.length : 0,
          observedCount: observed.observed, queuedCount: observed.queued,
          duplicateCount: observed.duplicates, invalidCount: observed.invalid,
          persisted: observed.persisted === true, cursorAdvanced: observed.cursorAdvanced === true,
          cursorEventVersion: String(observed.cursor?.eventVersion ?? ''),
          cursorMode: String(observed.cursorMode ?? ''),
          reason: String(observed.reason ?? '')
        });
      } catch (error) {
        run.memoryObservation = { observed: 0, queued: 0, duplicates: 0, invalid: 0, persisted: false,
          cursorAdvanced: false, reason: String(error?.message ?? error).slice(0, 160) };
        log(logSink, 'warn', 'memory-input-observe-failed', {
          chatKey, roundId, kind, reason: String(error?.message ?? error).slice(0, 160)
        });
      }

      run.stage = 'memory';
      runStage(run, 'context_build');            // D-2 B：hookBeforeContext + 检索（会话卡片已按 R09 延后到"确定发言"之后）
      // ★ 扩展钩子（M12 出口，对应旧树 src/orchestrator.js:2396 的 hookBeforeContext）：
      //   启用的技能/插件要在检索之前拿到本轮触发内容（语义卡匹配/绑人待办等）。
      await safeHook(modules, 'hookBeforeContext', { triggerEntries: evidence, chatKey, kind, senderId, evidence }, logSink);
      // ★ 2026-10-16（用户口径 · 一次全判 / 真省主模型输入）：本轮会不会走云 JEV 判定，**在取上下文
      //   之前**就要知道 —— 判定会产出记忆策略（同一次 judgeOnce 的 memory 结果），策略允许
      //   "先取轻上下文、判定后按需取回完整上下文"。私聊/主动轮不走 judgeOnce（保持原样一次全量）。
      //   `judgeMode` 从这里唯一计算（下面各处引用同一个值）。
      const judgeMode = !proactive && kind === 'group'
        && readConfig(cfg, 'localJev.judgeMode.enabled', false) === true;
      // ★ 2026-10-18（R01 · 统一产品合同 #1/#2）：`localJev.judgeMode.enabled` 是**云裁判全局请求总闸**。
      //   关闭时（自由接话/聚焦/记忆补判在内）云裁判请求数必须为零 —— `judgeFlow` 只认这一个闸，
      //   显式 `store.replyMode='jev'` 不允许绕过它；自由接话按普通随机路线降级（effectiveReplyMode），
      //   真实生效值+降级原因随 turnPlan.replyMode 出模，UI 按它说明（不再拿配置值假装还在云裁判）。
      const replyModeInfo = resolveReplyMode(cfg, { chatKey, kind });
      const freeReplyMode = kind === 'group' ? replyModeInfo.mode : 'jev';
      const judgeFlow = judgeMode;
      const effectiveReplyMode = kind === 'group' && judgeMode !== true ? 'random' : freeReplyMode;
      const contextBudget = {
        recentMessages: Number.isFinite(Number(item.gate?.count))
          ? Math.max(0, Math.floor(Number(item.gate.count))) : 40,
        recalledItems: 12, episodeSummaries: 4, todos: 4
      };
      const fetchContext = (extra = {}) => observeMemoryInput.prepareContext({
        chatKey, kind, evidence, topic, query: topic, senderId,
        need: item.contextHint?.need, now: clockNow(clock), roundId,
        signal: run.signal,
        budget: contextBudget,
        ...extra
      });
      // `deferOptionalRecall` 只给"会走 JEV 判定"的轮次：轻上下文（记忆实现保留近期原文/工作状态/
      // 必须更正；可选召回延后），判定后按 memoryPolicy 需要时才取回完整相关上下文。
      // 不认这个字段的实现照旧（逐字不变）。
      // ★ 2026-10-18（R01）：判定轮 = **裁判总闸开且群聊非主动轮**（judgeFlow）—— 总闸关闭后
      //   不再有"显式 jev 也算判定轮"的例外，预取一次全量上下文即可。
      let context = await fetchContext(judgeFlow ? { deferOptionalRecall: true } : {});
      if (run.signal.aborted) return writeFinish(run, { status: 'aborted', reason: String(run.signal.reason || 'aborted') });
      const contextItemCount = Array.isArray(context?.items) ? context.items.length : 0;
      emit(bus, 'context:retrieved', { chatKey, roundId, count: contextItemCount, itemCount: contextItemCount });

      run.stage = 'plan';
      runStage(run, 'participation_gate');        // D-2 B：关系 + Jev + M8 判定 = 「这一轮要不要说话」
      // ★ 关系是**按人**的（M7 `relationOf(state, personId)`：personId 空即抛）。
      //   ① 主动轮（G21）没有新消息 ⇒ `senderId` 是 undefined；装配层的适配器
      //      `({chatKey,senderId}) => relationOf(state, senderId)` 会**当场抛** ⇒ 整轮 error
      //      ⇒ 主动轮一个字都发不出去（sb1 的真 M15 复验实测：`emotion.relationOf: personId 必须是关键系`）。
      //      私聊主动轮的人**就是会话对方**（`private:<qq>`）⇒ 取真值；群里没有"某个人" ⇒ 如实 null。
      //   ② 情绪层是**风格提示，永不否决**（裁定）⇒ 它抛错也不许把这一轮打死：记一行日志、relation 用 null。
      const personId = primary?.sender?.id != null && String(primary.sender.id) !== ''
        ? String(primary.sender.id)
        : (proactive && kind === 'private' ? String(chatKey).split(':')[1] || '' : '');
      let relation = null;
      if (personId) {
        try { relation = modules.emotion?.relationOf?.({ chatKey, senderId: personId }) ?? null; }
        catch (error) {
          log(logSink, 'warn', 'relation-unavailable', { chatKey, roundId, personId, error: String(error?.message ?? error) });
          relation = null;
        }
      } else if (typeof modules.emotion?.relationOf === 'function') {
        log(logSink, 'debug', 'relation-skipped-no-person', { chatKey, roundId, proactive: proactive === true });
      }
      const now = clockNow(clock);
      if (typeof clock.random !== 'function' && !Number.isFinite(clock.random)) throw new Error('injected clock.random is required; implicit randomness is forbidden');
      const rand = typeof clock.random === 'function' ? Number(clock.random()) : Number(clock.random);
      if (!(rand >= 0 && rand < 1)) throw new Error('injected clock.random must return a number in [0, 1)');
      // `judgeMode` 已在上下文准备之前计算（见上方 fetchContext 段）——这里不再重算，保证
      // "轻上下文 / 判定 / 记忆策略"三段看的是同一个模式判据。
      let topicStateCheck = topicRegistry && kind === 'group'
        ? topicRegistry.check({ accountId: platformSelfId(modules), chatKey, at: now }) : null;
      let topicTransition = topicStateCheck?.active === true ? 'active-not-renewed' : 'inactive';
      if (topicStateCheck?.reason === 'expired') {
        topicRegistry.end({ accountId: platformSelfId(modules), chatKey, reason: 'expired', at: now });
        topicStateCheck = topicRegistry.check({ accountId: platformSelfId(modules), chatKey, at: now });
        topicTransition = 'expired';
      } else if (!judgeMode && topicStateCheck?.active === true) {
        topicRegistry.end({ accountId: platformSelfId(modules), chatKey, reason: 'judge-mode-disabled', at: now });
        topicStateCheck = topicRegistry.check({ accountId: platformSelfId(modules), chatKey, at: now });
        topicTransition = 'judge-mode-disabled';
      }
      let jevAvailability = null;
      if (!proactive && kind === 'group' && typeof modules.getJudgeAvailability === 'function') {
        try {
          jevAvailability = summarizeJevAvailability(modules.getJudgeAvailability({ kind, proactive }));
        } catch (error) {
          jevAvailability = summarizeJevAvailability({
            modeEnabled: judgeMode, modelBound: null, state: 'unavailable',
            reason: `availability-read-failed:${error?.name || 'error'}`,
            budget: { level: 'unavailable', reason: 'budget-status-unavailable', pausedPurposes: null }
          });
        }
      }
      let judge = null;
      let keywordCandidate = false;
      let randomCandidate = false;    // ★ 2026-10-16：第 3 档"回复概率"抽中（抽中才请求云判定）
      let randomDraw = null;          // ★ 2026-10-16：准入证据 {probability, draw, hit}（只计数、无正文）
      let candidateQualified = false; // ★ R02（2026-10-18）：候选资格（第 3 档抽中 或 第 4 档全量候选）
      let memoryPolicy = { recall: true, mode: 'mixed', reason: 'default-recall' };
      let focusState = null;
      let jevSignal = null;
      let judgeCallState = 'not-called';
      let judgeCallReason = '';
      const memoryDataDir = String(modules?.configStore?.DATA_DIR ?? '').trim();
      const judgeMemoryAvailability = {
        // This is only an availability flag. The public memory service still enforces
        // per-impression management authorization and current-participant scope.
        crossChat: Boolean(memoryDataDir && typeof modules.memory?.retrieve === 'function')
      };
      // 只以本批焦点（最新待回应消息）判候选，较早的无关关键词不能放行整批。
      // ★ R03（2026-10-18）：这段**本地**判定移出 `judgeFlow` 门 —— 关闭云裁判后，档位门
      //   （tier≥2 关键词放行 / 第 4 档全量候选）给出的触发资格仍要传进计划层，
      //   不得再被普通插话概率（INTENT_ZERO）重复筛掉。
      const focus = String(primary?.text ?? '');
      const scope = { chatKey, kind };
      const configuredKeywords = readScopedConfig(cfg, 'store.keywords', scope, []);
      const keywordHits = (Array.isArray(configuredKeywords) ? configuredKeywords : [])
        .map((value) => String(value ?? '').trim())
        .filter((value) => value && matchesTierKeyword(focus, [value]));
      const interests = (Array.isArray(context?.items) ? context.items : [])
        .filter((entry) => ['preference', 'topic', 'trait'].includes(String(entry?.type ?? '')))
        .map((entry) => String(entry?.claim ?? '').trim())
        .filter(Boolean);
      const interestHits = interests.filter((value) => matchesTierKeyword(focus, [value]));
      keywordCandidate = keywordHits.length > 0 || interestHits.length > 0;
      // ★ 2026-11-03（溟）——**撤掉当天早些时候那版「关键词 90 秒内不唤醒」**。
      //   那版把关键词资格摁掉之后，这一批就落回普通聚批（burstSettleMs 15s）才发车，
      //   实测回复延迟 p50 从 8.9s 涨到 15.4s，她当场说「改了之后回复变得有点慢诶」。
      //   关键词该快还是要快；要治的是「一句话把话题带走」，那属于回复内容的问题，
      //   交给 compose 的提示（见 compose.js 的 keywordWakeHint），不靠压唤醒。
      //   时间口径回到：点名/关键词都按 wakeDelayMs 发车。
      const keywordCandidateForPlan = keywordCandidate || item?.gate?.keyword === true;
      if (judgeFlow) {
        const topicSwitchRequested = typeof modules.plan?.explicitlyChangesTopic === 'function'
          && modules.plan.explicitlyChangesTopic(focus) === true;

        if (focusRegistry) {
          const accountId = platformSelfId(modules);
          let checked = readFocusState(chatKey, now);
          // C10: suppress old mention/keyword windows while followup focus is active.
          const followupActive = followupActiveEffective(chatKey);
          const addressed = primary?.toSelf === true || primary?.refs?.toSelf === true
            || (Array.isArray(primary?.mentions) && primary.mentions.some((mention) => mention?.isSelf === true));
          const target = String(primary?.sender?.id ?? '').trim();
          if (addressed && target && !followupActive) {
            focusRegistry.openMention({ accountId, chatKey, target, at: now });
            checked = readFocusState(chatKey, now);
          } else if (!checked?.active && keywordCandidate && target && !followupActive) {
            focusRegistry.openKeyword({
              accountId, chatKey, target,
              trigger: keywordHits[0] || interestHits[0] || '', at: now
            });
            checked = readFocusState(chatKey, now);
          }
          focusState = planFocusState(checked);
        }

        const botMessages = [];
        const botMessageIds = new Set();
        for (const entry of evidence) {
          for (const message of Array.isArray(entry?.botSaidBefore) ? entry.botSaidBefore : []) {
            if (!message || typeof message !== 'object') continue;
            const id = String(message.id ?? '');
            const key = id || `${Number(message.at) || 0}:${String(message.text ?? '')}`;
            if (botMessageIds.has(key)) continue;
            botMessageIds.add(key);
            botMessages.push(message);
          }
        }
        // ★ 2026-10-17（编排侧短期分界）：发给 JEV 的**短期历史**（botSaidBefore / 被引原话 /
        //   回复的旧 bot 消息）按本轮冻结快照收窄；本轮触发 evidence 不走（focus/recent 里
        //   的证据行照旧）。长期材料（interests/matchedTopic=context.items）不筛。
        const visibleBotMessages = personaShortTerm.filter(botMessages, (message) => message?.at ?? message?.ts).rows;
        const rawReplyTo = primary?.refs?.replyTo;
        const replyToId = String(rawReplyTo && typeof rawReplyTo === 'object' ? rawReplyTo.id ?? '' : rawReplyTo ?? '');
        // 准入判据用**未过滤**行（只隔离发给模型的短期输入，不改"要不要判"的门）。
        const repliedBotMessage = replyToId
          ? botMessages.find((message) => String(message.id ?? '') === replyToId) || null
          : null;
        const repliedBotMessageScoped = replyToId
          ? visibleBotMessages.find((message) => String(message.id ?? '') === replyToId) || null
          : null;
        const explicitlyAddressed = primary?.refs?.toSelf === true
          || (Array.isArray(primary?.mentions) && primary.mentions.some((mention) => mention?.isSelf === true));
        const explicitConversation = explicitlyAddressed || Boolean(repliedBotMessage);
        const references = [];
        const referencesScoped = [];
        const quoted = primary?.refs?.quoted;
        if (quoted && typeof quoted === 'object' && String(quoted.text ?? '').trim()) {
          const line = `${String(quoted.sender ?? quoted.senderId ?? '')}: ${String(quoted.text)}`.trim();
          references.push(line);
          // 被引原话没有可信时刻（contracts：id/sender/text）⇒ 分界后按既有契约不注入（宁可少给）。
          if (personaShortTerm.filter([quoted], (row) => row?.at ?? row?.ts).rows.length > 0) referencesScoped.push(line);
        }
        const botName = String(readConfig(cfg, 'persona.botName', '') || '自己');
        if (repliedBotMessage && String(repliedBotMessage.text ?? '').trim()) {
          references.push(`${botName}: ${String(repliedBotMessage.text)}`);
        }
        if (repliedBotMessageScoped && String(repliedBotMessageScoped.text ?? '').trim()) {
          referencesScoped.push(`${botName}: ${String(repliedBotMessageScoped.text)}`);
        }
        const recentRows = [
          ...evidence.map((entry) => ({
            id: String(entry?.id ?? ''), at: Number(entry?.at) || 0,
            speaker: String(entry?.sender?.name || entry?.sender?.id || '用户'),
            text: String(entry?.text ?? ''),
            // ★ 2026-10-19（第七批）：裁判消费端（judge.js buildJudgeInput）已支持
            //   `item.refs.quoted` / `item.refs.replyTo`，但生产输入此前被这里剥掉 ⇒ 裁判看不到引用。
            //   原样透传 evidence 的 refs（去重/排序/slice 后仍在末尾 map 里保留）。
            ...(entry?.refs && typeof entry.refs === 'object' ? { refs: entry.refs } : {})
          })),
          ...visibleBotMessages.map((message) => ({
            id: String(message.id ?? ''), at: Number(message.at) || 0,
            speaker: botName, text: String(message.text ?? '')
          }))
        ].filter((entry) => entry.text.trim() || entry.refs);
        const recentById = new Map();
        for (const entry of recentRows) {
          const key = entry.id || `${entry.at}:${entry.speaker}:${entry.text}`;
          if (!recentById.has(key)) recentById.set(key, entry);
        }
        // ★ R06（2026-10-18）· 上游历史语义（与 ds2 的 jev 下游对齐，下游截取归 ds2）：
        //   `recent` 恒为**按时间正序（旧→新）、取最近 12 条**的数组 —— 下游只能从**尾部**
        //   保留最近 N 条（judge.js buildJudgeInput 的 slice(0,N) 取的是最旧 N 条，属 R06 下游修复点）；
        //   引用目标（repliedBotMessage）与机器人最近发言已在上面并入同一份时间序里，不单独丢。
        // ★ 第七批：末尾 map 保留 refs（不扩大窗口、不新增模型调用；裁判输入只多"这条在回复哪条"）。
        const recent = [...recentById.values()]
          .sort((a, b) => a.at - b.at)
          .slice(-12)
          .map(({ speaker, text, refs }) => ({ speaker, text, ...(refs ? { refs } : {}) }));
        const matchedTopic = (Array.isArray(context?.items) ? context.items : [])
          .find((entry) => String(entry?.type ?? '') === 'topic'
            && matchesTierKeyword(focus, [String(entry?.claim ?? '')]));
        const managedTopic = topicRegistry && topicStateCheck?.active === true ? topicStateCheck.topic : null;
        // ★ activeTopic 是由 bot 行派生的**短期文本**（会进 JEV 输入）——用分界内可见的行；
        //   不可见时退回长期材料（matchedTopic=context.items）或 null。
        const lastConfirmedBotMessage = managedTopic?.lastConfirmedReplyId
          ? visibleBotMessages.find((message) => String(message.id ?? '') === String(managedTopic.lastConfirmedReplyId)) || null
          : null;
        const activeTopic = topicSwitchRequested ? null : topicRegistry
          ? (managedTopic ? String(repliedBotMessageScoped?.text || lastConfirmedBotMessage?.text || matchedTopic?.claim || '').trim() || null : null)
          : String(repliedBotMessageScoped?.text ?? matchedTopic?.claim ?? '').trim() || null;
        const hasMemoryContext = references.length > 0
          || (Array.isArray(context?.items) && context.items.some((entry) => ['promise', 'question'].includes(String(entry?.type ?? ''))));
        const focusRemainingMs = Number(focusState?.remainingMs ?? (Number(focusState?.expiresAt) - now));
        const focusWindow = focusState?.active === true && ['mention', 'keyword'].includes(focusState.kind)
          ? { type: focusState.kind, minutes: Math.max(1, Math.ceil(focusRemainingMs / 60_000)) }
          : null;
        const currentSenderId = String(primary?.sender?.id ?? '').trim();
        const focusActive = focusState?.active === true;
        const focusTargetMatches = focusActive && Boolean(currentSenderId)
          && currentSenderId === String(focusState?.target ?? '').trim();
        const managedTopicActive = topicStateCheck?.active === true;
        const topicParticipants = new Set((Array.isArray(topicStateCheck?.topic?.participants)
          ? topicStateCheck.topic.participants : []).map((id) => String(id ?? '').trim()).filter(Boolean));
        const topicParticipantMatches = Boolean(currentSenderId) && topicParticipants.has(currentSenderId);
        const hasManagedContinuation = focusActive || managedTopicActive;
        const managedContinuationAllowed = (!focusActive || focusTargetMatches)
          && (!managedTopicActive || topicParticipantMatches || focusTargetMatches);
        const independentJudgeCandidate = keywordCandidate || Boolean(activeTopic)
          || (explicitConversation && hasMemoryContext);
        // Active focus/topic is a continuation-only trigger. Reject outsiders before cloud JEV;
        // direct @ keeps the plan's required-response path and retargets an available focus window above.
        // C10: direct @ of the bot skips judgeOnce — enter the speech chain directly.
        // Match plan.DIRECT_MENTION exactly: ANY row with refs.toSelf or mentions.isSelf
        // (not just primary) short-circuits cloud judgment.
        const explicitAddressHere = evidence.some((entry) =>
          entry?.toSelf === true
          || entry?.refs?.toSelf === true
          || (Array.isArray(entry?.mentions) && entry.mentions.some((m) => m?.isSelf === true)));
        // C10: followup batches always need judgment (per-speaker batch judgment).
        // Direct @ short-circuits ALL paths including hasManagedContinuation.
        // Expired followup window → skip cloud call (don't waste budget on stale batches).
        const followupWindowActive = isFollowupBatch ? followupActiveFor(chatKey) : true;
        // ★ 2026-10-16（用户口径 · 第 3 档「先随机，再 JEV」）：tier-3 走进来的批次
        //   （gate.randomCandidate，非 @/关键词/已知活动话题）在**云裁判模式**下先按回复概率抽一次 ——
        //   概率真值 = `store.randomPercent`（滑条派生的随机值，见 `scopedReplyProbability`）。
        //   · 抽中 ⇒ 这一批才算候选，才调 judgeOnce；抽中也不代表直接发言（plan 仍按 join/continue 裁）；
        //   · 未抽中 ⇒ **不花 JEV 请求**，本批按准入证据收手（judgeCallReason='random-candidate-missed'）。
        // ★ 2026-10-17（逐群模式）：`random` 模式**不在这里抽** —— 由 plan 的旧自由插话分支只抽一次
        //   （并同时应用冷却/每小时上限）；两边都抽会变成 p²，与"该群真实概率"不符。
        //   一批只抽一次（本轮 rand 来自注入的 clock.random，与旧自由插话同源）；接话聚焦批次不叠随机
        //   （它有 20 秒按人聚批的独立通路，避免与聚焦窗相互错误覆盖）。
        // ★ N3（2026-10-19）：批次已有直接触发资格（关键词命中 / 第 4 档全量候选）时，
        //   不再抽第 3 档的普通骰子 —— 骰子只能决定"无明确触发的普通批次"，不能撤销已有资格。
        const randomGate = !isFollowupBatch && effectiveReplyMode !== 'random'
          && item?.gate?.randomCandidate === true
          && item?.gate?.fullCandidate !== true
          && keywordCandidate !== true;
        if (randomGate) {
          const probability = scopedReplyProbability(cfg, chatKey, kind);
          const hit = probability > 0 && rand < probability;
          randomDraw = { probability, draw: rand, hit };
          randomCandidate = hit;
          log(logSink, 'info', hit ? 'jev-random-candidate-hit' : 'jev-random-candidate-miss', {
            chatKey, roundId, probability, draw: rand, tier: item?.gate?.tier ?? null
          });
        }
        // ★ R02（2026-10-18）：第 4 档（全响应）入口已给全量候选资格 —— 直接成为候选，
        //   不再叠加第 3 档的概率抽样（改前这里没有候选 ⇒ 永远不请求裁判 ⇒ 静默跳过）。
        const fullCandidate = !isFollowupBatch && item?.gate?.fullCandidate === true;
        if (fullCandidate) log(logSink, 'info', 'jev-full-candidate', {
          chatKey, roundId, tier: item?.gate?.tier ?? null
        });
        candidateQualified = randomCandidate || fullCandidate;
        const shouldJudge = explicitAddressHere
          ? false
          : isFollowupBatch
            ? followupWindowActive
            : hasManagedContinuation
              ? managedContinuationAllowed
              : effectiveReplyMode === 'random'
                ? false   // 随机模式：自由接话不再请求裁判（入场由 plan 的概率抽样决定）
                : (independentJudgeCandidate || candidateQualified);

        if (shouldJudge && typeof modules.jev?.judgeOnce === 'function') {
          judgeCallState = 'called';
          try {
            judge = await modules.jev.judgeOnce({
              focus, references: referencesScoped, recent, keywordHits, interests,
              activeTopic, memoryAvailability: judgeMemoryAvailability,
              ...(focusWindow ? { focusWindow } : {})
            }, {
              traceId: roundId,
              now,
              requestId: `cloud-judge-${run.startedAt}-${roundId}`.slice(0, 220),
              purpose: 'cloud_judge',
              chatKey,
              personId: personId || null,
              sourceId: primary?.id == null || String(primary.id) === '' ? null : String(primary.id),
              turnId: `${roundId}:${run.startedAt}:${primary?.id ?? 'none'}`
            });
          } catch (error) {
            const reason = String(error?.message ?? error).slice(0, 160);
            log(logSink, 'warn', 'jev-judge-once-failed', { chatKey, roundId, reason });
            judge = {
              status: 'error', reason,
              ...(typeof error?.requestId === 'string' ? { requestId: error.requestId } : {}),
              ...(Number.isSafeInteger(error?.actualCalls) ? { actualCalls: error.actualCalls } : {}),
              ...(typeof error?.usageState === 'string' ? { usageState: error.usageState } : {}),
              ...(error?.usage && typeof error.usage === 'object' ? { usage: error.usage } : {}),
              ...(Array.isArray(error?.attemptReasons) ? { attemptReasons: error.attemptReasons } : {})
            };
          }
        } else if (shouldJudge) {
          judgeCallReason = 'judge-once-unavailable';
          log(logSink, 'warn', 'jev-judge-once-unavailable', { chatKey, roundId });
        } else {
          if (effectiveReplyMode === 'random' && !isFollowupBatch && !hasManagedContinuation && !explicitAddressHere) {
            // 随机模式：本批由 plan 的自由插话概率抽样决定是否入场，**没有请求云判定**。
            // 明确记原因，不伪装成 random-miss / no-candidate。
            judgeCallReason = 'reply-mode-random';
            log(logSink, 'info', 'jev-judge-skipped-reply-mode', { chatKey, roundId, reason: judgeCallReason });
          } else if (randomGate && !randomCandidate) {
            // ★ 2026-10-16：第 3 档未抽中 —— 明确记"没请求云判定"，不伪装成其它跳过原因。
            judgeCallReason = 'random-candidate-missed';
            log(logSink, 'info', 'jev-judge-skipped-random-miss', {
              chatKey, roundId, reason: judgeCallReason,
              probability: randomDraw?.probability ?? 0, draw: randomDraw?.draw ?? null
            });
          } else if (focusActive && !focusTargetMatches) {
            judgeCallReason = 'focus-target-filtered';
            log(logSink, 'debug', 'jev-judge-skipped-outside-managed-context', {
              chatKey, roundId, reason: judgeCallReason, focusActive, topicActive: managedTopicActive
            });
          } else if (managedTopicActive && !topicParticipantMatches && !focusTargetMatches) {
            judgeCallReason = 'topic-participant-filtered';
            log(logSink, 'debug', 'jev-judge-skipped-outside-managed-context', {
              chatKey, roundId, reason: judgeCallReason, focusActive, topicActive: managedTopicActive
            });
          } else {
            judgeCallReason = explicitConversation ? 'no-eligible-candidate' : 'no-explicit-conversation';
            if (!explicitConversation) log(logSink, 'debug', 'jev-judge-skipped-no-candidate', { chatKey, roundId });
          }
        }
        // ★ 2026-10-16（用户口径 · 一次全判 → 策略落地）：把**同一次** judgeOnce 的 memory 结果 +
        //   本地强需求裁成最终 memoryPolicy，再按需取回完整相关上下文：
        //   · 只有"有效明确的 memory.none + 本地无强需求（旧事/追问/人物关系/更正/承诺）"才
        //     `recall:false`（省略可选记忆）；其余（超时/预算拒绝/格式坏/低置信/缺失/明确 @ 绕过）
        //     一律默认召回 —— 宁多勿漏。
        //   · 判定后**一次**取回完整上下文（仍是本地读：不新增模型请求、不新增等待、不重复写入/整理）。
        //   · 轻上下文这一轮是带 `deferOptionalRecall` 取的（见 fetchContext 段），只有判定轮如此。
        const strongTypes = new Set(['correction', 'promise', 'question']);
        // ★ 保守口径（宁多勿漏）：机器人最近说过话（botSaidBefore 在场）⇒ 旧事/追问可能在飞，
        //   不省可选记忆 —— 轻上下文下承诺/问答类条目可能已被延后，不能用"context 里没看到"当没有。
        const botThreadInPlay = (Array.isArray(evidence) ? evidence : [])
          .some((entry) => Array.isArray(entry?.botSaidBefore) && entry.botSaidBefore.length > 0);
        const localStrongNeed = Boolean(activeTopic)
          || hasMemoryContext
          || focusActive
          || isFollowupBatch
          || botThreadInPlay
          || (Array.isArray(context?.items) ? context.items : []).some((row) => strongTypes.has(String(row?.type ?? '')))
          || (currentSenderId !== '' && (Array.isArray(context?.items) ? context.items : [])
            .some((row) => String(row?.subjectId ?? row?.personId ?? '').trim() === currentSenderId));
        memoryPolicy = decideJevMemoryPolicy({
          judge, judgeCalled: judgeCallState === 'called', judgeBypassed: explicitAddressHere, localStrongNeed
        });
        if (memoryPolicy.recall === true) {
          context = await fetchContext({ memoryPolicy });
          if (run.signal.aborted) return writeFinish(run, { status: 'aborted', reason: String(run.signal.reason || 'aborted') });
          log(logSink, 'info', 'memory-policy-recall-applied', {
            chatKey, roundId, mode: memoryPolicy.mode, reason: memoryPolicy.reason,
            included: Array.isArray(context?.items) ? context.items.length : 0
          });
        } else {
          log(logSink, 'info', 'memory-policy-skip-optional', {
            chatKey, roundId, mode: memoryPolicy.mode, reason: memoryPolicy.reason,
            included: Array.isArray(context?.items) ? context.items.length : 0
          });
        }
      } else {
        // ★ R01（2026-10-18）：云裁判总闸关闭（或私聊/主动轮）⇒ **不发起任何云裁判请求**。
        //   旧本地 `jev.ask` 直连在生产装配里已无模型绑定（`configure({model})` 只有测试在用），
        //   这里不再尝试调用，也不用"缺 ask/asSignal 就抛错"把正常轮打死 —— 关闸后 jevSignal
        //   恒为 null，计划层按本地规则执行（关键词/续聊/概率路线各自有明确分支）。
        const inactiveFocus = readFocusState(chatKey, now);
        if (inactiveFocus?.active) {
          focusRegistry?.close({
            accountId: platformSelfId(modules), chatKey, reason: 'judge-mode-disabled', at: now
          });
        }
        jevSignal = null;
      }
      // C10: for followup batches, override focusState with the followup window state.
      // Moved outside `if (judgeMode)` so plan's followup block (which does NOT gate on judgeMode)
      // can catch it deterministically — otherwise judgeMode=off falls through to legacy paths.
      if (isFollowupBatch && followupRegistry) {
        const now = clockNow(clock);
        const followupCheck = followupRegistry.check({ chatKey, at: now });
        focusState = {
          kind: 'followup',
          active: followupCheck?.active === true,
          participants: [String(item.fromId ?? '')],
          ...(followupCheck?.window || {})
        };
      }
      // ★ 2026-10-16（用户口径 · 策略随上下文出模前落地）：把最终 memoryPolicy 同一个形状交给
      //   compose/提示词（`context.memoryPolicy`）——`recall:false` 时它们可跳过**可选**语义卡/
      //   相关情节/印象；硬性更正、当前关系/实时状态、跨轮心声与历史正文不受影响、照旧注入。
      if (context && typeof context === 'object') context.memoryPolicy = memoryPolicy;
      const plan = await modules.plan?.decide?.({ evidence: planEvidence, context: context || { items: [], dropped: [] }, relation, cfg, jevSignal, judge, judgeMode: judgeFlow, replyMode: effectiveReplyMode, keywordCandidate: keywordCandidateForPlan, focus: focusState, now, rand, proactive, proactiveReason, chatKey, kind,
        randomCandidate: candidateQualified, randomMissed: randomDraw !== null && randomCandidate !== true,
        // ★ 2026-10-18（#10 决策链）：第 4 档“任何消息都响应”的资格要传进计划层 —— 随机模式
        //   （judgeFlow=false）下不能再用 randomPercent 把 4 档批次二次抽样掉（UI 文案即“任何消息都回应”）。
        fullCandidate: item?.gate?.fullCandidate === true,
        ...(topicRegistry && kind === 'group' && judgeMode ? { topicState: topicStateCheck } : {}) });
      // C10: record verdict for followup batches. YES only on the follow-up block's own judged
      // acceptance (FOLLOWUP_JOIN); NO on FOLLOWUP_NOT_WORTH; SKIP/timeout/budget-reject/parse-fail
      // are NOT counted as NO (spec).
      // BUG 3 fix: when judgeMode is false, the plan didn't go through the followup branch,
      // so the result must not be mapped to YES/NO — always SKIP to resolve the inFlight seq.
      if (isFollowupBatch && followupRegistry) {
        let verdict = 'SKIP';
        if (judgeMode) {
          const planReason = String(plan?.reason ?? '').split(':', 1)[0].trim();
          // ★ 2026-10-16（C10 独立审查 · 修①）：只有 followup 块自己的**判中**（FOLLOWUP_JOIN）才算 YES。
          //   改前把任意 `plan.action === 'reply' || 'continue'` 都记 YES —— 但"必需响应层"的
          //   PROMISE_FOLLOWUP / BOT_QUESTION_ANSWER 等分支先于 followup 块返回 continue
          //   （plan/index.js:254-261，没有走云判定）；窗口已过期时这类批次会因此被"判中"，
          //   并把已关闭的窗口重新刷新 20 秒（违反"关窗后等下一次实际发言"）。
          //   非判中的回复本身不受影响：轮次照常走，实际投递后由 openFollowupWindow 续窗（:4454）。
          if (planReason === 'FOLLOWUP_JOIN') verdict = 'YES';
          else if (planReason === 'FOLLOWUP_NOT_WORTH') verdict = 'NO';
          // 其余（JUDGE_NOT_CALLED / JUDGE_UNAVAILABLE / FOCUS_NOT_PARTICIPANT / 必需响应层的
          // continue…）一律 SKIP：既不 +1、也不清零、更不刷新窗口。
        }
        try {
          const recorded = followupRegistry.recordVerdict({
            chatKey,
            seq: Number(item.followupSeq),
            verdict,
            at: clockNow(clock)
          });
          if (recorded?.closed) {
            log(logSink, 'info', 'followup-window-closed-by-verdict', {
              chatKey, noStreak: recorded.noStreak ?? 0, closeReason: recorded.closeReason ?? ''
            });
          }
          if (recorded?.yesRefreshed) {
            log(logSink, 'info', 'followup-window-yes-refreshed', { chatKey, seq: item.followupSeq });
          }
        } catch (error) {
          log(logSink, 'warn', 'followup-record-verdict-failed', { chatKey, error: String(error?.message ?? error).slice(0, 120) });
        }
        followupVerdictRecorded = true;
      }
      const focusReasonCode = String(plan?.reason ?? '').split(':', 1)[0].trim();
      if (focusState?.active && ['FOCUS_TOPIC_PASSED', 'FOCUS_MOVED'].includes(focusReasonCode)) {
        focusRegistry?.close({
          accountId: platformSelfId(modules), chatKey, reason: focusReasonCode, at: now
        });
      }
      const explicitTopicChange = judgeMode && typeof modules.plan?.explicitlyChangesTopic === 'function'
        && modules.plan.explicitlyChangesTopic(String(primary?.text ?? '')) === true;
      if (topicRegistry && topicStateCheck?.active === true
        && (explicitTopicChange || ['JUDGE_TOPIC_CHANGED', 'FOCUS_TOPIC_PASSED', 'FOCUS_MOVED'].includes(focusReasonCode))) {
        const endReason = explicitTopicChange ? 'topic-changed' : focusReasonCode.toLowerCase();
        topicRegistry.end({ accountId: platformSelfId(modules), chatKey, reason: endReason, at: now });
        topicStateCheck = topicRegistry.check({ accountId: platformSelfId(modules), chatKey, at: now });
        topicTransition = explicitTopicChange ? 'topic-changed' : 'judge-ended';
      }
      run.turnPlan = plan ? {
        action: String(plan.action ?? ''), reason: String(plan.reason ?? '').slice(0, 160), by: String(plan.by ?? ''),
        ...(jevAvailability ? { jevAvailability } : {}),
        // ★ 2026-10-17（逐群回复模式）：真实生效值 + 来源（chat/private/global/legacy/default/fallback）
        //   与兼容标记 —— UI 只显示这个，不要再用旧 judgeMode 布尔猜模式。
        // ★ 2026-10-18（R01）：`effective` 是**真实生效**的自由接话方式；裁判总闸关闭时显式 jev
        //   会降级成 random（`degraded: 'judge-gate-disabled'`），UI 必须按 effective 说明。
        ...(kind === 'group' ? { replyMode: {
          mode: freeReplyMode,
          effective: effectiveReplyMode,
          ...(effectiveReplyMode !== freeReplyMode ? { degraded: 'judge-gate-disabled' } : {}),
          source: String(replyModeInfo.source ?? 'unknown'),
          ...(replyModeInfo.compat ? { compat: String(replyModeInfo.compat) } : {})
        } } : {}),
        ...(judgeMode ? { judgeGate: { enabled: true } } : { judgeGate: {
          enabled: false, mode: 'off', reason: 'judge-gate-disabled'
        } }),
        ...(judgeFlow ? { jevSummary: {
          ...summarizeJevResult(judge, { callState: judgeCallState, callReason: judgeCallReason, keywordCandidate, plan }),
          // ★ 2026-10-16（准入证据）：第 3 档随机抽取的读数（概率/抽取值/是否抽中）随判定摘要出模，
          //   只计数无正文；`reason='random-candidate-missed'` 时这一轮**没有**云判定请求。
          ...(randomDraw ? { randomDraw } : {})
        } } : {}),
        memoryInjection: { state: 'not-injected', selectedCount: 0, items: [], truncated: false },
        ...(topicRegistry && kind === 'group' ? { topicState: topicStateRecord(topicStateCheck, topicTransition) } : {})
      } : null;
      if (run.signal.aborted) return writeFinish(run, { status: 'aborted', reason: String(run.signal.reason || 'aborted') });
      if (!plan) return writeFinish(run, { status: 'skipped', reason: planReason('PLAN_MISSING', 'plan module returned no ActionPlan') });
      // Keep the admitted plan conclusion until writeFinish so its single decision row
      // can also carry the model-stage result. Admission-gate rows stay on their original path.
      const action = String(plan.action ?? '');
      const decision = action === 'skip' ? 'skip'
        : (action === 'wait' || action === 'tool') ? 'defer' : 'speak';
      const reasonCode = String(run.turnPlan.reason || '').split(':', 1)[0].trim() || 'unknown';
      const trace = run.trace || {};
      const lane = run.lane || trace.lane || 'ambient';
      const source = run.source || (kind === 'private' ? 'private_policy' : trace.source || 'fallback');
      run.planDecisionLedger = {
        chatKey, roundId, lane, source, decision, reasonCode,
        authority: trace.authority ?? null,
        tier: trace.contextTier ?? null,
        messageCount: evidence.length
      };
      emit(bus, 'plan:decided', { chatKey, roundId, action: plan.action, reason: plan.reason });

      emit(bus, 'verdict:issued', { chatKey, roundId, signal: jevSignal?.label || null });

      if (plan.action === 'skip' || plan.action === 'wait') return writeFinish(run, { status: plan.action, reason: plan.reason });
      // ★ R09（2026-10-18）：主会话卡片**只在真正要进入主模型**的轮次才创建 —— 改前在准备上下文/
      //   抽样判定之前就建 session 再等判定，未抽中/被档位或裁判拒绝的批次也会先落一张卡
      //   （会话页刷屏、云调用计数被卡片误导）。触发消息仍在创建时一并写进会话。
      if (sessionRegistry) {
        try {
          // 正文只经 appendMessage 提交；create 的 trigger 故意不带消息正文，便于确认提交点真实生效。
          const created = sessionRegistry.create({ chatKey, trigger: proactive ? 'proactive' : 'message', triggerSummary: '', status: 'running' });
          run.sessionId = String(created?.session?.id ?? '');
          if (!created?.persisted?.ok) log(logSink, 'warn', 'session-create-failed', { chatKey, roundId, error: created?.persisted?.error ?? 'create returned no persisted success' });
          // ★ S-4：会话刚创建、**还没落盘**就先发 `session:started` ⇒ 卡片在"预输出"阶段就出现。
          //   契约要求 status='running'（create 就是这个值），id 必须是 create 返回的真 id。
          emitSessionFrame(run, 'session:started');
          for (const entry of Array.isArray(evidence) ? evidence : []) appendSessionMessage(run, 'user', entry?.text ?? '', entry?.id ?? '');
        } catch (error) {
          log(logSink, 'warn', 'session-create-failed', { chatKey, roundId, error: String(error?.message ?? error) });
        }
      }
      closeStage(run, 'ok', String(plan.action ?? ''));     // 判定段到此为止：后面的工具/生成长度不许记在它头上
      const planWantsSpeech = plan.action === 'reply' || plan.action === 'continue';
      let replyContext = context;
      if (planWantsSpeech && judgeFlow) {
        const recalled = await retrieveJevMemoryForReply({
          context, judge, memoryAvailability: judgeMemoryAvailability,
          modules, cfg, chatKey, kind, evidence, senderId, personId,
          now: clockNow(clock), roundId, signal: run.signal, logSink,
          shortTerm: personaShortTerm
        });
        replyContext = recalled.context ?? context;
        if (run.turnPlan?.jevSummary) {
          run.turnPlan = {
            ...run.turnPlan,
            jevSummary: { ...run.turnPlan.jevSummary, memoryRecall: recalled.summary }
          };
        }
        if (run.signal.aborted) return writeFinish(run, { status: 'aborted', reason: String(run.signal.reason || 'aborted') });
      }
      // ★ 幂等键：普通轮 = `chatKey:证据id:动作`（同一消息重跑不重复发）；主动轮**没有证据 id**，
      //   用 `proactive-<roundId>` 保证"每一轮主动轮各自唯一"——若照搬 evidenceId 会拼出 `:undefined:`，
      //   那样所有主动轮共用一把钥匙，M10 的幂等记忆会把第二轮主动发言当成"发过了"直接吞掉。
      //   空串 = "本轮的证据 id 不可用" ⇒ 不传钥匙，让 M10 按老规矩自己算。
      //
      //   ⚠ 口径更正（qwen2 的对抗复核 T-REVIEW-G21-B §① 实测）：
      //   我这处与改动前**只在"证据 id 存在且非空"时逐字节等价**（`ev-9` / 数字型 / 含冒号都实测相同）；
      //   证据 id 缺失或为空串时**行为变了**——改前 M15 会拼出 `chatKey:undefined:动作` / `chatKey::动作`
      //   （于是**所有缺 id 的轮共用一把别名键**，M10 照收不误），现在改为**不传钥匙**、由 M10 自己算并在
      //   算不出时 fail-closed。这是**修复**，不是等价；防复发断言见 selftest「缺证据 id 的轮不许共用别名键」。
      //
      // ★ 第三处加固（qwen2 r3 的 C10-B 实测）：**合成 id（M5 自己造的）标识的是"一条消息的形状"，不是
      //   "哪一条平台消息"** —— 同一秒 + 同一发送者 + 同一句正文 + 都缺 message_id 的两条消息，合成 id 必然
      //   相同（指纹就是拿这些当输入）。若照旧拿它当幂等键，**第二条的回复会被 M10 吞掉、而两轮都写 delivered**
      //   （qwen2 实测：平台只实收 #1，模型被调用 2 次）。
      //   ⇒ 口径：**只有真实平台 message_id 才允许"同 id = 同一条消息"**；合成 id 一律把 roundId 并进钥匙，
      //     于是"同 id 跨轮"不再互相冒充。重试安全仍由 `!run.sentAnything` 保证（与主动轮同一口径）。
      //   约定：合成 id 形如 `<chatKey>#<at>#i<index>#<指纹>`（**含 `#`**），平台 id 是纯数字串（可带负号）
      //   —— 这条约定由 selftest 的「合成 id 含 #、真实 id 不含」断言钉住。
      const evidenceRef = primary?.id == null ? '' : String(primary.id);
      const isSyntheticEvidenceId = evidenceRef.includes('#');
      const runKey = evidenceRef !== ''
        ? (isSyntheticEvidenceId ? `${evidenceRef}|r${roundId}` : evidenceRef)
        : (proactive ? `proactive-${roundId}` : '');
      const idempotencyKey = runKey ? `${chatKey}:${runKey}:${plan.action}` : '';
      const priorRepeatBlocks = repeatBlocksByChat.get(chatKey) || 0;
      if (priorRepeatBlocks >= REPEAT_BLOCK_CIRCUIT_LIMIT) {
        run.repeatBlocks = priorRepeatBlocks;
        return writeFinish(run, {
          status: 'stopped', reason: planReason('REPEAT_BLOCK_CIRCUIT', `repeatBlocks=${priorRepeatBlocks}`), repeatBlocks: priorRepeatBlocks,
          modelRounds: 0, modelToolCalls: 0, modelCallReasons: [], modelCallTrace: []
        });
      }
      run.stage = 'act';
      const actStartedAt = clockNow(clock);
      const platform = modules.platform;
      const actResults = await modules.act?.run?.(plan, {
        platform, cfg, sendBudget: run.sendBudget, skills: modules.skills, budget: modules.budget, evidence, context: replyContext, jevSignal,
        signal: run.signal, chatKey, kind, evidenceId: primary.id,
        // ★ 内建工具执行器要用模块能力（记忆/媒体/联网…）——契约见 modules/act/executors/index.js
        modules, plan,
        idempotencyKey
      });
      noteUnknownSendResults(run, actResults);
      recordToolResults(actResults);
      noteActions(actResults, { startedAt: actStartedAt, endedAt: clockNow(clock) });
      if (run.signal.aborted) return writeFinish(run, { status: 'aborted', reason: String(run.signal.reason || 'aborted') });
      let delivered = { delivered: false, reasons: ['no send attempted'] };
      let receipt = null;
      const modelResponses = [];
      let modelThoughtChanged = false;
      let modelInnerVoice = '';
      // 普通发言只能由模型调用 send_message；ActionPlan/act.run 的任意 send 字段不作为正文出口。
      const alreadySent = run.sendOutcomeUnknown || (Array.isArray(actResults) && actResults.some((row) => row?.receipt?.ok === true && row.receipt.platformId));
      // ★ E 阶段第一步「生成」：规则工具跑完还没发出东西，才调模型写这句话。
      //   （此前 A→F 里没人负责生成 —— 见 compose.js 头部；2026-10-04 实盘故障点）
      if (!alreadySent && planWantsSpeech && typeof modules.act?.send === 'function') {
        run.stage = 'compose';
        runStage(run, 'model_call');                      // D-2 B：主模型调用（含多轮工具）
        if (run.turnPlan) run.turnPlan = {
          ...run.turnPlan,
          memoryInjection: { state: 'unknown', selectedCount: null, items: [], truncated: null }
        };
        const priorSentProfile = priorSentFinishProfile(chatKey, primary);
        composed = await composeReply({
          modules: withRunIdentity(withToolCallArgs(modules, run), run), cfg, log: logSink, clock, plan, evidence, context: replyContext, relation, jevSignal,
          // ★ 2026-10-17：把本轮冻结的分界带上 —— compose 不再重读 live（独立调用者仍可少传，走其兜底）。
          personaSnapshot: run.personaSnapshot,
          chatKey, kind, evidenceId: primary.id,
          sessionId: run.sessionId, sessionRegistry, roundId,
          idempotencyKey: idempotencyKey || undefined,
          signal: run.signal, platform,
          // ★ T-G21-PROMPT 的最后一条跳（qwen3.8flash 复核点名）：主动轮必须把身份透到 M8b，
          //   否则提示词会渲染成"以下是你还没看过的最新消息…"这个**假前提**（实际一条消息都没有）。
          //   普通轮这两个值是 false/''，与不传时逐字节等价（prompt 侧默认值相同）。
          proactive, proactiveReason,
          contextLimit: Number.isFinite(Number(item.gate?.count)) ? Math.max(0, Math.floor(Number(item.gate.count))) : null,
          ...priorSentProfile,
          onAssistantResponse: ({ text, round, finishReason }) => {
            const rawText = String(text ?? '');
            if (!rawText) return;
            modelResponses.push({ text: rawText, round, finishReason });
            const { text: body, voices } = splitInnerVoice(rawText);
            const truncated = finishReason === 'length';
            let session = null;
            try { session = sessionRegistry?.peek?.(run.sessionId) ?? null; } catch { session = null; }
            if (!truncated && session) {
              if (voices.length) {
                modelInnerVoice = voices.join('；').replace(/\s+/g, ' ').trim();
                session.innerVoice = modelInnerVoice;
                modelThoughtChanged = true;
              }
              if (body && looksLikeNarration(body)) {
                session.unsentThought = body.replace(/\s+/g, ' ').trim();
                modelThoughtChanged = true;
              }
            }
          }
        });
        const toolInnerVoice = (Array.isArray(composed?.voices) ? composed.voices : [])
          .filter((voice) => typeof voice === 'string' && voice.trim())
          .map((voice) => voice.trim())
          .join('；')
          .replace(/\s+/g, ' ')
          .trim();
        if (toolInnerVoice) {
          let session = null;
          try { session = sessionRegistry?.peek?.(run.sessionId) ?? null; } catch { session = null; }
          if (session) {
            session.innerVoice = [modelInnerVoice, toolInnerVoice].filter(Boolean).join('；').replace(/\s+/g, ' ').trim();
            modelThoughtChanged = true;
          }
        }
        const finalPrompt = composed?.finalPrompt;
        if (run.turnPlan) {
          run.turnPlan = {
            ...run.turnPlan,
            memoryInjection: memoryInjectionRecord(replyContext, finalPrompt, run.turnPlan?.jevSummary?.memoryRecall)
          };
        }
        if (finalPrompt && typeof finalPrompt === 'object' && !Array.isArray(finalPrompt)) {
          let session = null;
          try { session = sessionRegistry?.peek?.(run.sessionId) ?? null; } catch { session = null; }
          let changed = false;
          if (session && typeof finalPrompt.systemPrompt === 'string') {
            session.systemPrompt = finalPrompt.systemPrompt;
            changed = true;
          }
          if (session && typeof finalPrompt.userPrompt === 'string') {
            session.userPrompt = finalPrompt.userPrompt;
            changed = true;
          }
          if (changed) {
            const persisted = sessionRegistry.update?.(run.sessionId);
            if (persisted?.ok) emitSessionFrame(run, 'session:updated');
            else log(logSink, 'warn', 'session-final-prompt-write-failed', {
              chatKey: run.chatKey, roundId: run.roundId, error: persisted?.error ?? 'update returned no success'
            });
          }
        }
        const finishObservation = composed?.finishObservation ?? {};
        const finishAttempted = Math.max(0, Number(finishObservation.attempted) || 0);
        try {
          modules.observability?.event?.('finish:observed', {
            chatKey, roundId, stage: 'compose', name: 'finish',
            status: finishObservation.completed === true ? 'ok' : finishAttempted > 0 ? 'error' : 'skipped',
            code: String(finishObservation.reason || 'unknown'),
            count: Math.max(0, Number(finishObservation.requested) || 0),
            attempt: finishAttempted
          }, { echo: false });
        } catch (error) {
          log(logSink, 'warn', 'finish-observation-write-failed', { error: String(error?.message ?? error) });
        }
        recordToolExecutionEvents(composed?.toolResults);
        noteRejectedToolAttempts(composed?.rejectedToolAttempts);
        noteUnknownSendResults(run, composed?.toolResults);
        noteUnknownSendResults(run, composed?.receipts);
        const responseReceipts = [
          ...(Array.isArray(composed?.receipts) ? composed.receipts : []),
          ...(composed?.receipt ? [{ receipt: composed.receipt }] : [])
        ];
        const responseWasSent = responseReceipts.some((entry) => {
          const receipt = entry?.receipt ?? entry;
          return receiptConfirmsAnyMessage(receipt);
        });
        const responseSendUnknown = run.sendOutcomeUnknown
          || composed?.outcome === 'delivery_unknown'
          || responseReceipts.some((entry) => entry?.state === 'unknown' || entry?.receipt?.state === 'unknown')
          || (Array.isArray(composed?.outputResults) && composed.outputResults.some((entry) => entry?.state === 'unknown'));
        let responseMessageWritten = false;
        // ★ 2026-10-17：同一轮里**逐字相同**的模型正文只记一次。required 策略下"正文没带 send_message"
        //   会补一枪 closeout（ask 它写沉默原因），模型把同一句话重述一遍 —— 两枪同文各写一条，
        //   会话里出现两条完全一样的心声、跨轮心声取回也会拿到重复句（A42 既有自测钉的就是"一轮一条思考"）。
        const writtenResponseTexts = new Set();
        const writeResponseRecord = (text, metadata) => {
          const key = String(text ?? '').replace(/\s+/g, ' ').trim();
          if (!key || writtenResponseTexts.has(key)) return false;
          writtenResponseTexts.add(key);
          return appendSessionMessage(run, 'assistant', text, primary?.id ?? '', metadata) === true;
        };
        for (const response of modelResponses) {
          if (!responseWasSent && !responseSendUnknown) {
            if (response.text && isMeaningfulThoughtText(response.text)) {
              responseMessageWritten = writeResponseRecord(response.text, {
                internalThought: true, source: 'model-silence', modelRound: response.round,
                composeOutcome: composed?.outcome, composeReason: composed?.reason
              }) || responseMessageWritten;
            }
            continue;
          }
          // ★ 2026-10-15（用户裁定）：即使同轮已有 tool 发送，模型正文仍按「上轮写在正文里的东西」
          //   记成心声（internalThought + source:'model' ⇒ appendSessionMessage 落 memoryKind:'thought'），
          //   由 retrieveCrossRoundThoughts 按 1 小时线性权重取回供下轮注入；外发的 tool 文本由
          //   outbound 记录承载，绝不冒充心声。截断正文仍按旧口径丢弃（半句话不当心声用）。
          if (response.finishReason === 'length') {
            if (response.text) responseMessageWritten = writeResponseRecord(response.text, {
              modelBody: true, discardedTruncated: true, modelRound: response.round
            }) || responseMessageWritten;
            continue;
          }
          const body = splitInnerVoice(response.text).text;
          // ★ 写入端过滤（2026-10-16）：空泛词/纯标点碎片不入库（同 isMeaningfulThoughtText 判据，
          //   正典在 act/inner-voice.js）。显式沉默/发言原因（[系统记录] 行）由上方分支单独写入，
          //   不走本过滤；合法短词/人名/有内容心声保留。
          if (body && isMeaningfulThoughtText(body)) responseMessageWritten = writeResponseRecord(body, {
            internalThought: true, source: 'model', modelRound: response.round
          }) || responseMessageWritten;
        }
        if (modelThoughtChanged && !responseMessageWritten && sessionRegistry && run.sessionId) {
          const persisted = sessionRegistry.update?.(run.sessionId);
          if (persisted?.ok) emitSessionFrame(run, 'session:updated');
          else if (persisted?.ok === false) log(logSink, 'warn', 'session-thought-write-failed', {
            chatKey: run.chatKey, roundId: run.roundId, error: persisted.error ?? 'update returned no success'
          });
        }
        recordToolResults(composed?.toolResults);
        noteActions(composed?.toolResults);                 // compose 给这些行盖过轮次/时间戳
        run.memeCue = composed?.memeCue && typeof composed.memeCue === 'object' ? composed.memeCue : null;
        run.memeCueSkip = String(composed?.memeCueSkip ?? '');
        run.usage = composed?.usage ?? null;
        run.modelRounds = Number(composed?.modelRounds) || 0;
        run.modelToolCalls = Number(composed?.toolCalls) || 0;
        run.modelCallReasons = Array.isArray(composed?.modelCallReasons) ? composed.modelCallReasons : [];
        run.modelCallTrace = Array.isArray(composed?.modelCallTrace) ? composed.modelCallTrace : [];
        if (run.signal.aborted) return writeFinish(run, { status: 'aborted', reason: String(run.signal.reason || 'aborted') });
        if (!composed?.receipts?.some((entry) => entry?.receipt?.ok === true && entry.receipt.platformId)
          && !composed?.receipt?.ok) appendSessionMessage(run, 'assistant',
          `[系统记录] 本轮未确认发送：${composed?.outcome ?? 'unknown'} / ${composed?.reason ?? 'unknown'}。模型未写出的沉默原因无法推断。`, primary?.id ?? '', {
            internalThought: true, source: 'system', composeOutcome: composed?.outcome, composeReason: composed?.reason
          });
        const composedReceipts = Array.isArray(composed?.receipts) ? composed.receipts : [];
        for (const entry of composedReceipts) {
          const actionReceipt = entry?.receipt;
          if (receiptConfirmsAnyMessage(actionReceipt)) run.sentAnything = true;
          if (actionReceipt?.ok !== true || !actionReceipt.platformId) continue;
          run.sentAnything = true;
          const row = (Array.isArray(composed?.toolResults) ? composed.toolResults : []).find((item) =>
            String(item?.receipt?.platformId ?? '') === String(actionReceipt.platformId));
          rememberReceipt(actionReceipt, { chatKey, roundId, evidenceId: primary.id, action: plan.action,
            text: sentTextFromToolResult(row), tool: entry.tool, run });
        }
        if (composed?.receipt?.ok) {
          // 模型自己调了 send_message：回执由 M10 造的，这里只认它
          receipt = composed.receipt;
          run.sentAnything = true;
          const sentToolResult = (Array.isArray(composed?.toolResults) ? composed.toolResults : []).find((row) =>
            row?.receipt?.ok === true && String(row.receipt.platformId ?? '') === String(receipt.platformId ?? '')
            && (!composed.receiptTool || row.tool === composed.receiptTool));
          rememberReceipt(receipt, { chatKey, roundId, evidenceId: primary.id, action: plan.action, text: sentTextFromToolResult(sentToolResult), tool: composed.receiptTool, run });
          delivered = await checkDelivered(composedReceipts.length ? composedReceipts : [{ receipt, coverage: receipt.coverage }],
            { delivered: receipt.ok === true && !!receipt.platformId, reasons: ['act.assertDelivered 未注入：只按平台回执判定'] });
          if (Array.isArray(composed?.outputResults) && composed.outputResults.some((item) => item?.state !== 'delivered')) {
            delivered = { ...delivered, delivered: false, reasons: [...(delivered.reasons ?? []),
              ...composed.outputResults.filter((item) => item?.state !== 'delivered').map((item) => `${item.output}:${item.state}`)] };
          }
        } else if (composed?.text) {
          // 正文只留作本轮内部上下文/回灌；外发必须通过 send_message。
          log(logSink, 'info', 'compose-body-suppressed', { chatKey, roundId, chars: String(composed.text).length, reason: 'send-message-required' });
        }
        // ★ tokens 只有完整累加结果才落，缺 usage 时绝不填 0；已观测到工具调用时仍记
        //   callCount/toolNames（不带 token 字段），避免“模型调了什么”随 usage 缺失一起消失。
        const toolNames = Array.isArray(composed?.toolNames) ? composed.toolNames : [];
        const perCallUsage = Array.isArray(composed?.perCallUsage)
          ? composed.perCallUsage : (Array.isArray(composed?.usage?.perCallUsage) ? composed.usage.perCallUsage : null);
        const modelCallTrace = Array.isArray(composed?.modelCallTrace) ? composed.modelCallTrace : null;
        const auxiliaryModelCalls = (Array.isArray(composed?.bodyRecovery) ? composed.bodyRecovery : [])
          .filter((row) => row?.requestSent === true).length;
        // ★ 2026-10-17（缓存真实诊断 · 473d331f）· purpose=main_model + 两个对账位：
        //   usageIncomplete —— 模型确实跑了（主轮/perCallUsage/轨迹任一有据，含工具痕迹）
        //   但 composed.usage 没凑齐 ⇒ 本轮"没攒成"。模型没跑的轮面本条目根本不写入，
        //   因此不会把"没调用"伪装成诊断信号。
        //   cacheUsageReported —— 主链按行对齐：期望主调用轮数（modelCallTrace 里
        //   purpose==='main_model' 的行数；轨迹缺失退化用 modelRounds）>0、perCallUsage
        //   里主链行数量对得上、且每行 promptTokens/cachedTokens 都是**真实数值**
        //   （显式 0 也算报告；null=供应商没报，不算）。ds2 侧 mainCacheHitRate /
        //   cacheUsageCoverage 只信 cacheUsageReported===true 的行，不再拿 null 当 0。
        const mainTraceRows = (modelCallTrace ?? []).filter((row) => String(row?.purpose ?? '') === 'main_model');
        const expectedMainCalls = mainTraceRows.length > 0
          ? mainTraceRows.length : (Number(composed?.modelRounds) || 0);
        const mainCallRows = (Array.isArray(perCallUsage) ? perCallUsage : [])
          .filter((row) => String(row?.purpose ?? '') === 'main_model');
        const cacheUsageReported = Boolean(composed?.usage) && expectedMainCalls > 0
          && mainCallRows.length === expectedMainCalls
          && mainCallRows.every((row) => row?.promptTokens != null && row?.cachedTokens != null);
        const usageIncomplete = !composed?.usage
          && ((Number(composed?.modelRounds) || 0) > 0 || (perCallUsage?.length || 0) > 0
            || (modelCallTrace?.length || 0) > 0 || toolNames.length > 0);
        if (composed?.usage || toolNames.length > 0 || perCallUsage?.length > 0 || modelCallTrace?.length > 0) {
          try {
            modules.observability?.ledger?.('usage', {
              chatKey, roundId, at: clockNow(clock),
              ...(composed?.usage ? { model: composed.usage.model } : {}),
              callCount: (Number(composed.modelRounds) || 0) + auxiliaryModelCalls || null,
              purpose: 'main_model',
              usageIncomplete,
              cacheUsageReported,
              ...(composed?.usage ? {
                promptTokens: composed.usage.promptTokens,
                completionTokens: composed.usage.completionTokens,
                cachedTokens: composed.usage.cachedTokens,
                cacheCreationTokens: composed.usage.cacheCreationTokens,
                webSearchCount: composed.usage.webSearchCount
              } : {}),
              ...(perCallUsage ? {
                perCallUsage,
                perCallUsageTruncated: composed?.perCallUsageTruncated
                  ?? composed?.usage?.perCallUsageTruncated ?? false
              } : {}),
              ...(modelCallTrace ? {
                modelCallTrace,
                modelCallTraceTruncated: modelCallTrace.length > 64
              } : {}),
              ...(toolNames.length > 0 ? { toolNames } : {}),
              durationMs: Math.max(0, clockNow(clock) - run.startedAt)
            });
          } catch (error) {
            log(logSink, 'warn', 'usage-ledger-write-failed', { error: String(error?.message ?? error) });
          }
        } else if (composed) {
          log(logSink, 'debug', 'usage-ledger-skipped', { reason: 'compose 没给出完整 usage（某一轮缺 usage 或缺 M4.readUsageNumbers）' });
        }
        // D-2 B：模型段的终局单独记一个码（`sent`/`drafted`/`guard:xxx`/`finished_no_text`/`empty`），
        //   终态 reason 归最后收口那一段 —— 两码分开放，面板才分得清"卡在哪"与"为什么没发"。
        closeStage(run, composed?.receipt || composed?.text ? 'ok' : 'skipped',
          composed?.receipt ? 'sent'
            : composed?.guard ? `guard:${composed.guard}`
              : composed?.finished ? 'finished_no_text'
                : composed?.text ? 'drafted' : 'empty');
      }
      if (!receipt) {
        // ★ 2026-10-17：已发回执的**记账**与"核验口是否注入"无关 —— `assertDelivered` 只负责
        //   `delivered` 判定；改前整段（含记账）都挂在它下面，装配没提供核验口时
        //   "act 阶段已发 + 后段抛错"会把整轮重试（重复外发）。sentAnything/rememberReceipt 现在一律执行。
        if (typeof modules.act?.assertDelivered === 'function') {
          delivered = await modules.act.assertDelivered(Array.isArray(actResults) ? actResults : []);
        }
        for (const result of Array.isArray(actResults) ? actResults : []) {
          const sentReceipt = result?.receipt;
          if (receiptConfirmsAnyMessage(sentReceipt)) run.sentAnything = true;
          if (sentReceipt?.ok === true && sentReceipt.platformId) {
            run.sentAnything = true;
            rememberReceipt(sentReceipt, { chatKey, roundId, evidenceId: primary.id, action: plan.action, text: sentTextFromToolResult(result), tool: result?.tool, run });
          }
        }
      }
      if (run.sendOutcomeUnknown) {
        delivered = { ...delivered, delivered: false, reasons: [...(delivered.reasons ?? []), '发送调用已发起但没有可核验回执，结果未知'] };
      }

      const confirmedToolReceipt = [...(Array.isArray(actResults) ? actResults : []), ...(Array.isArray(composed?.toolResults) ? composed.toolResults : [])]
        .some((row) => row?.receipt?.ok === true && row.receipt.platformId
          && row?.state !== 'unknown' && row?.receipt?.state !== 'unknown');
      if (delivered?.delivered || receipt?.ok === true || confirmedToolReceipt) {
        const outgoing = [];
        const projectedReceiptIds = new Set();
        for (const row of [...(Array.isArray(actResults) ? actResults : []), ...(Array.isArray(composed?.toolResults) ? composed.toolResults : [])]) {
          const id = String(row?.receipt?.platformId ?? '');
          if (row?.receipt?.ok !== true || row?.state === 'unknown' || row?.receipt?.state === 'unknown'
            || !id || projectedReceiptIds.has(id)) continue;
          projectedReceiptIds.add(id);
          for (const text of sentMessagesFromToolResult(row)) outgoing.push(text);
        }
        for (const text of outgoing) appendSessionMessage(run, 'assistant', text, primary?.id ?? '');
      }

      const actResultRows = Array.isArray(actResults) ? actResults : [];
      const composeResultRows = Array.isArray(composed?.toolResults) ? composed.toolResults : [];
      const allToolResults = [...actResultRows, ...composeResultRows];
      const isContentBlocked = (row) => row?.blockedBy === 'outbound-content'
        || String(row?.error ?? '').startsWith('outbound-content-blocked:')
        || String(row?.receipt?.error ?? '').startsWith('outbound-content-blocked:');
      const blockedRows = allToolResults.filter(isContentBlocked);
      const directReceiptBlocked = String(receipt?.error ?? '').startsWith('outbound-content-blocked:');
      const deliveredThisRound = delivered?.delivered === true || confirmedToolReceipt;
      // C10：实际发言确认投递后开 20 秒接话窗。
      //   ★ 2026-10-18（统一产品合同 #3）：门控改为**聚焦总开关** `store.followupEnabled`（默认关），
      //     与云裁判总闸解耦：
      //   · 总闸开 ⇒ 窗内批次走云判据（judgeOnce 挂在 judgeMode 块里）；
      //   · 总闸关 ⇒ 窗内批次按"本窗参与者 + 20 秒窗"的本地资格接话，**绝不偷偷调云**（见 plan FOLLOWUP_LOCAL）；
      //   · followupEnabled 关 ⇒ 根本不开窗（旧窗/定时器在总开关关闭时已收口）。
      //   · 只对**群聊**开（私聊走 plan `PRIVATE_RULE` 必回，不进这层）。
      if (deliveredThisRound && kindOfChatKey(chatKey) === 'group') {
        if (followupEnabledFor(chatKey)) openFollowupWindow(chatKey);
        else log(logSink, 'debug', 'followup-window-suppressed', { chatKey, roundId, reason: 'followup-disabled' });
      }
      const blockedCount = deliveredThisRound ? 0 : blockedRows.length
        + Number(directReceiptBlocked && blockedRows.length === 0)
        + Number(composed?.guard === 'internal-analysis' && blockedRows.length === 0 && !directReceiptBlocked);
      const repeatBlocks = blockedCount > 0 ? priorRepeatBlocks + blockedCount : 0;
      run.repeatBlocks = repeatBlocks;
      if (repeatBlocks > 0) repeatBlocksByChat.set(chatKey, repeatBlocks);
      else repeatBlocksByChat.delete(chatKey);

      run.stage = 'commit';
      runStage(run, 'state_update');                    // D-2 B：观察落库 + 会话收尾
      if (modules.memory?.commit) {
        const observationsByKey = new Map();
        for (const row of allToolResults) {
          const observation = row?.data?.observation;
          if (!observation || typeof observation !== 'object') continue;
          const key = observation.id != null ? `id:${String(observation.id)}`
            : row?.idempotencyKey ? `key:${String(row.idempotencyKey)}` : observation;
          if (!observationsByKey.has(key)) observationsByKey.set(key, observation);
        }
        const observations = [...observationsByKey.values()];
        let committedCount = 0;
        for (const observation of observations) {
          if (run.signal.aborted) return writeFinish(run, { status: 'aborted', reason: String(run.signal.reason || 'aborted') });
          const result = await modules.memory.commit(observation, { evidence, idempotencyKey: `${chatKey}:${observation.id || runKey}:${plan.action}` });
          if (result !== false && result?.ok !== false && result?.committed !== false) committedCount += 1;
        }
        if (committedCount) emit(bus, 'observation:committed', { chatKey, roundId, count: committedCount });
      }
      if (repeatBlocks >= REPEAT_BLOCK_CIRCUIT_LIMIT) {
        return writeFinish(run, {
          status: 'stopped', reason: planReason('REPEAT_BLOCK_CIRCUIT', `repeatBlocks=${repeatBlocks}`),
          delivered: !!delivered.delivered, repeatBlocks,
          modelRounds: composed?.modelRounds ?? 0, modelToolCalls: composed?.toolCalls ?? 0,
          modelCallReasons: composed?.modelCallReasons ?? [], modelCallTrace: composed?.modelCallTrace ?? []
        });
      }
      const modelFinishSummary = typeof composed?.finishSummary === 'string' && composed.finishSummary.trim()
        ? composed.finishSummary.trim().slice(0, 300) : null;
      const receiptEntries = [
        ...(Array.isArray(actResults) ? actResults : []).filter((row) => row?.receipt).map((row, index) => ({
          receipt: row.receipt, coverage: row.receipt.coverage ?? null, tool: row.tool ?? '',
          idempotencyKey: String(row.receipt.idempotencyKey ?? row.idempotencyKey ?? ''),
          ...(row.traceRound != null ? { modelRound: row.traceRound } : {}),
          ...(row.toolCallId ? { toolCallId: String(row.toolCallId), outputId: String(row.toolCallId) } : {}),
          sessionId: run.sessionId, roundId, resultIndex: index
        })),
        ...(Array.isArray(composed?.receipts) ? composed.receipts : []),
        ...(receipt ? [{ receipt, coverage: receipt.coverage ?? null, tool: composed?.receiptTool ?? 'send', sessionId: run.sessionId, roundId }] : [])
      ];
      const uniqueReceiptEntries = [...new Map(receiptEntries.map((entry, index) => {
        const item = entry.receipt;
        const key = item?.platformId
          ? `id:${item.platformId}:${(item.coverage?.receiptIds ?? []).map(String).join(',')}`
          : `action:${entry.tool}:${entry.idempotencyKey}:${entry.toolCallId ?? entry.resultIndex ?? index}`;
        return [key, entry];
      })).values()];
      const sentExcerptText = allToolResults
        .filter((row) => row?.receipt?.ok === true && row.receipt.platformId)
        .map(sentTextFromToolResult).filter(Boolean).at(-1)
        ?? '';
      const finishSummary = modelFinishSummary ?? (sentExcerptText ? String(sentExcerptText).slice(0, 300) : null);
      const finishSummarySource = modelFinishSummary ? 'model' : finishSummary ? 'sent_excerpt' : 'none';
      const sentMessageCount = confirmedSentMessageCount(uniqueReceiptEntries);
      const bodySuppressed = composed?.bodySuppressed === true || Boolean(composed?.text && !composed?.receipt);
      const deliveredConfirmed = delivered.delivered === true && !run.sendOutcomeUnknown;
      const confirmedTopicReceipt = [...uniqueReceiptEntries].reverse().find((entry) => {
        const row = entry?.receipt;
        const hasId = Boolean(row?.platformId)
          || (Array.isArray(row?.coverage?.receiptIds) && row.coverage.receiptIds.some((id) => String(id ?? '').trim()));
        return row?.ok === true && row?.state !== 'unknown' && entry?.state !== 'unknown' && hasId;
      });
      const confirmedReplyCoverageIds = Array.isArray(confirmedTopicReceipt?.receipt?.coverage?.receiptIds)
        ? confirmedTopicReceipt.receipt.coverage.receiptIds.map((id) => String(id ?? '').trim()).filter(Boolean) : [];
      const confirmedReplyId = confirmedReplyCoverageIds.at(-1)
        || String(confirmedTopicReceipt?.receipt?.platformId ?? '').trim();
      const confirmedTopicSend = !run.sendOutcomeUnknown
        && (deliveredConfirmed || confirmedToolReceipt || Boolean(confirmedTopicReceipt));
      if (topicRegistry && kind === 'group' && judgeMode && planWantsSpeech) {
        if (confirmedTopicSend) {
          const topicArgs = {
            accountId: platformSelfId(modules), chatKey,
            sourceId: String(primary?.id ?? ''),
            participant: String(primary?.sender?.id ?? ''),
            confirmedReplyId,
            at: clockNow(clock)
          };
          const wasActive = topicStateCheck?.active === true;
          const updatedTopic = wasActive ? topicRegistry.renew(topicArgs) : null;
          const establishedTopic = updatedTopic || topicRegistry.open(topicArgs);
          topicStateCheck = { active: true, reason: 'active', topic: establishedTopic };
          topicTransition = wasActive && updatedTopic ? 'renewed' : 'opened';
        } else {
          topicTransition = run.sendOutcomeUnknown ? 'send-unknown' : 'send-unconfirmed';
        }
      }
      if (run.turnPlan && topicRegistry && kind === 'group') {
        run.turnPlan = { ...run.turnPlan, topicState: topicStateRecord(topicStateCheck, topicTransition) };
      }
      // ── 回复后自动配一张表情（老树 src/orchestrator.js:4443-4453 的调用点对齐件）──
      //   位置与老树一致：**主链收尾之后**（topic/receipts/usage 都已定稿），只影响"额外一张"，
      //   不影响本轮 status/delivered 判据。前置条件先在这里算：主体（配置门/概率/冷却/候选/
      //   挑图/发送）在 maybeSendAutoSticker 与 pickAutoStickerIndex 里，失败只记短码。
      const textSendRows = [...(Array.isArray(actResults) ? actResults : []), ...(Array.isArray(composed?.toolResults) ? composed.toolResults : [])]
        .filter((row) => String(row?.tool ?? '') === 'send_message'
          && row?.state !== 'unknown' && row?.receipt?.ok === true
          && Boolean(row.receipt.platformId) && row.receipt.state !== 'unknown');
      const receiptToolName = String(composed?.receiptTool ?? '');
      const textDelivered = textSendRows.length > 0
        || ((receiptToolName === '' || receiptToolName === 'send_message')
          && composed?.receipt?.ok === true && Boolean(composed.receipt.platformId)
          && composed.receipt.state !== 'unknown');
      if (!run.signal.aborted && textDelivered) {
        await maybeSendAutoSticker({
          run, chatKey, kind, roundId, evidence, primary, allToolResults, textDelivered,
          replyContext, jevSignal, idempotencyKey, uniqueReceiptEntries
        });
      }
      return writeFinish(run, {
        status: deliveredConfirmed ? 'delivered' : 'completed',
        action: plan.action,
        reason: run.sendOutcomeUnknown
          ? planReason('COMPOSE_DELIVERY_UNKNOWN', '平台发送调用结果未知，本轮不重试')
          : deliveredConfirmed ? plan.reason
            : undeliveredReason(composed, plan, { receipt, reasons: delivered.reasons },
              // ★ 2026-10-19（N1）：把实际上限带进结束理由（只读，不改 compose 判定）。
              { maxRounds: Number(readConfig(cfg, 'api.maxRounds', 12)) || 12 }),
        delivered: deliveredConfirmed,
        deliveryReasons: delivered.reasons || [],
        modelRounds: composed?.modelRounds ?? 0,
        modelToolCalls: composed?.toolCalls ?? 0,
        modelCallReasons: composed?.modelCallReasons ?? [],
        modelCallTrace: composed?.modelCallTrace ?? [],
        bodyOutputDrops: composed?.outputDrops ?? [],
        bodyRecovery: composed?.bodyRecovery ?? [],
        repeatBlocks,
        // ★ P0-2b B 件：compose 的**原值**要带出去（上面的 reason 是映射后的码，码不能反推回原值 ——
        //   面板要能分清「它选择不说话」和「它答坏了」，只能读这两键）。只是把已有的判定暴露出去，不改判定。
        composeOutcome: composed?.outcome ?? (run.sendOutcomeUnknown ? 'delivery_unknown' : null),
        composeReason: composed?.reason ?? (run.sendOutcomeUnknown ? 'send-outcome-unknown' : null),
        replyChars: composed?.text ? composed.text.length : 0,
        composeGuard: composed?.guard ?? null,
        receipts: uniqueReceiptEntries,
        deliveryResults: composed?.outputResults ?? [],
        sentMessageCount,
        // ★ 2026-10-17：自动配图"已发起、结果未知"的条数（0 = 没有）。与文字投递分开记账 ——
        //   它既不算已确认、也不冒充失败（文字投递状态不受它影响）。
        unknownStickerCount: Math.max(0, Number(run.unknownStickerCount) || 0),
        sentMessageCountKnown: !run.sendOutcomeUnknown,
        unknownSendMessageCount: run.unknownSendMessageCount,
        sendOutcomeUnknown: run.sendOutcomeUnknown,
        bodySuppressed,
        finishSummary,
        finishSummarySource,
        attempt: run.attempt
      });
    } catch (error) {
      failureReason = String(error?.message ?? error);
      // 鉴权/请求被拒绝不会因同一份请求再跑三遍而恢复；保留失败原因，停止整轮重试。
      // ★ 2026-10-16：预算配置类错误（accountId/model/service 缺失）同样不会因重试恢复——
      //   旧判据只拦 HTTP 4xx，预算错误被反复重试、每轮都写系统记录。现在一并拦住。
      //   ⚠ selfId 为空只是**可能**的触发条件之一，未获运行证实；此处只拦"不可重试"的预算错误本身。
      const budgetConfigError = error?.code === 'BUDGET_REQUEST_REJECTED'
        && /budget-account-id-unavailable|budget-model-unavailable|budget-service-unavailable|budgeted-chat-call-unavailable|request-id-unavailable/.test(String(error?.budgetReason ?? ''));
      run.nonRetryableFailure = run.stage === 'compose' && (
        /HTTP\s+(?:400|401|403|404|422)\b/.test(failureReason) || budgetConfigError
      );
      const interruptedToolResults = Array.isArray(error?.toolResults) ? error.toolResults : [];
      // ★ 2026-10-17：中断前**已经发出**的结果必须在这里认账（与 compose 成功路径 4722-4745 同一组判据）：
      //   · unknown 行 ⇒ `sendOutcomeUnknown`（投递结果未知，不许整轮重跑）；
      //   · 确认行   ⇒ `sentAnything` + `rememberReceipt`（重试门 finally `!run.sentAnything` 停手；
      //                会话/发送台账如实记这条已发）。
      //   改前两样都不做：compose 里"先发出去、后一步抛错"会让整轮带**新 roundId/新幂等键**重跑
      //   ⇒ 同一句话重复外发（重复外发是本件要拦的 P0 面）。
      noteUnknownSendResults(run, interruptedToolResults);
      // 已确认发出的**消息条数**（按 coverage.receiptIds，与成功路径同一个计数器）：
      //   记录文案与 finish.sentMessageCount 都不许把"发出去过"写成 0/未确认。
      const interruptedConfirmedSends = confirmedSentMessageCount(
        interruptedToolResults.map((row) => ({ receipt: row?.receipt }))
      );
      for (const row of interruptedToolResults) {
        const interruptedReceipt = row?.receipt;
        if (!receiptConfirmsAnyMessage(interruptedReceipt)) continue;
        run.sentAnything = true;
        if (interruptedReceipt?.ok === true && interruptedReceipt.platformId) {
          rememberReceipt(interruptedReceipt, {
            chatKey, roundId, evidenceId: primary?.id ?? '', action: '',
            text: sentTextFromToolResult(row), tool: row?.tool ?? '', run
          });
        }
      }
      // ★ 2026-10-17：`diag` 声明在 if 之外 —— 下面 writeFinish 的 composeReason 也要读它
      //   （原先 const 只活在这个 if 块里，compose 阶段错误会在写收尾时再抛 `diag is not defined`）。
      let diag = null;
      if (run.stage === 'compose') {
        // 安全诊断：带 budgetReason/errorCode/systemMode/stage，不记录私聊内容/密钥
        const errCode = String(error?.code ?? error?.name ?? '').slice(0, 48) || 'unknown';
        const budgetReason = String(error?.budgetReason ?? '').slice(0, 80);
        const httpMatch = failureReason.match(/HTTP\s+\d{3}/)?.[0] ?? '';
        const sm = String(composed?.diagnostics?.systemMode?.mode ?? '').slice(0, 16);
        const smReq = String(composed?.diagnostics?.systemMode?.requested ?? '').slice(0, 16);
        const smPart = sm ? `mode=${sm}${smReq && smReq !== sm ? `/${smReq}` : ''}` : '';
        // ★ 阶段标记：区分模型生成失败 vs 工具执行失败（error 阶段在 modelCallTrace 可追，
        //   但 composeReason 直接带上 stage 便于面板一眼分清）。
        const stagePart = `stage=${String(run.stage ?? 'unknown').slice(0, 16)}`;
        diag = [errCode, budgetReason, httpMatch, smPart, stagePart].filter(Boolean).join('|');
        appendSessionMessage(run, 'assistant',
          `[系统记录] 模型生成或工具执行失败${httpMatch ? `（${httpMatch}）` : ''}${budgetReason ? `（${budgetReason}）` : ''}${smPart ? `（${smPart}）` : ''}；${interruptedConfirmedSends > 0 ? `已确认发出 ${interruptedConfirmedSends} 条，后续处理中断` : '未确认发送'}。此条是运行记录，不是模型心声。`,
          primary?.id ?? '', {
            internalThought: true, source: 'system', composeOutcome: 'error', composeReason: diag
          });
      }
      recordToolResults(interruptedToolResults);
      recordToolExecutionEvents(interruptedToolResults);
      noteActions(interruptedToolResults);
      noteRejectedToolAttempts(error?.rejectedToolAttempts);
      if (Array.isArray(error?.modelCallTrace)) run.modelCallTrace = error.modelCallTrace;
      if (Array.isArray(error?.modelCallReasons)) run.modelCallReasons = error.modelCallReasons;
      if (Number.isFinite(Number(error?.modelRounds))) run.modelRounds = Number(error.modelRounds);
      if (Number.isFinite(Number(error?.modelToolCalls))) run.modelToolCalls = Number(error.modelToolCalls);
      return writeFinish(run, {
        status: 'error', reason: run.sendOutcomeUnknown
          ? planReason('COMPOSE_DELIVERY_UNKNOWN', `平台调用结果未知；可能涉及 ${run.unknownSendMessageCount} 条文字；随后处理失败：${failureReason}`)
          : failureReason,
        delivered: false,
        sendOutcomeUnknown: run.sendOutcomeUnknown,
        sentMessageCountKnown: !run.sendOutcomeUnknown,
        unknownSendMessageCount: run.unknownSendMessageCount,
        sentMessageCount: interruptedConfirmedSends,
        composeOutcome: run.sendOutcomeUnknown ? 'delivery_unknown' : run.stage === 'compose' ? 'error' : null,
        composeReason: run.sendOutcomeUnknown ? 'send-outcome-unknown' : run.stage === 'compose' ? diag : null,
        replyChars: 0,
        attempt: run.attempt,
        modelRounds: run.modelRounds ?? 0, modelToolCalls: run.modelToolCalls ?? 0,
        modelCallReasons: run.modelCallReasons ?? [], modelCallTrace: run.modelCallTrace ?? []
      });
    } finally {
      runningChats.delete(chatKey);
      // ★ R11（2026-10-18）：整轮**结束**即视为本串结束 —— 清掉聚批水位。
      //   改前 `burstLastMessageAt` 会一直留到 30 秒 idle 才自然过期：上一轮结束后 30 秒内的
      //   新追问被当成"同轮连发"继续等 settle（私聊实测约 15 秒才判断）。从下一句起重新按
      //   新串的首条计 wakeDelayMs，硬上限也从它重新起算。
      burstLastMessageAt.delete(chatKey);
      burstStartedAt.delete(chatKey);
      // C10: if the round early-exited before recordVerdict (paused/aborted/exception),
      // resolve the inFlight seq with SKIP so subsequent verdicts don't get stuck in buffer.
      if (isFollowupBatch && followupRegistry && !followupVerdictRecorded) {
        try {
          followupRegistry.recordVerdict({
            chatKey,
            seq: Number(item.followupSeq),
            verdict: 'SKIP',
            at: clockNow(clock)
          });
        } catch { /* best-effort cleanup */ }
        followupVerdictRecorded = true;
      }
      // ★ 情绪事件收口：决策分支之后才发；涉及事实/变化的事件必须引用已入账证据。
      //   放 finally 里是为了"无论这一轮是 skip/wait/error 都记下消息已经发生"；
      //   重试轮重复发也安全 —— M7 用幂等键去重（appliedKeys）。
      try {
        const at = clockNow(clock);
        // ★ 2026-10-16（离散情绪兜底）：本轮的**台账水位** —— 吸收段跑完后用 `ledger.slice(水位)` 判
        //   "这一轮到底有没有有效的 affect.* 变化"（自评/入站 cue/环境事件真落地才算；衰减与冷却拒绝不算）。
        // ★ 2026-10-17（N89）：`emotion.enabled=false` 时连水位都不读 —— 下面用它的兜底块本身就在
        //   同一闸内，禁用情绪还去 `stateOf()` 是多余的 M7 触碰（既有自测钉的就是"禁用即零读取"）。
        const emotionLedgerFrom = readConfig(cfg, 'emotion.enabled', true) !== false
          ? Number(modules.emotion?.stateOf?.()?.ledger?.length) || 0
          : 0;
        const emotionEvents = [{ type: 'clock', at }];
        let validEvidenceCount = 0;
        for (const row of Array.isArray(evidence) ? evidence : []) {
          if (!validateMessageEvidence(row).ok) continue;
          validEvidenceCount += 1;
          emotionEvents.push({ type: 'message', at, evidence: row });
        }
        // ★ 2026-10-15（「情绪不变动」排查）：构建段与吸收段**分开兜错** —— 任一构建器
        //   （cue / 轮事实 / 自评 / 关系 / 落库）抛一次，只会跳过它之后的构建，前面已构建的
        //   事件仍走下面的吸收；改前整块一个 try，抛一次就只留一句 `emotion-absorb-failed`，
        //   本轮情绪完全不落、外面看不出为什么（这正是"数值真没动"最隐蔽的一条路）。
        //   事件表先挂在 `emotionEventsForAbsorb` 上，吸收段紧跟其后（各自独立兜错）。
        let emotionEventsForAbsorb = null;
        const persistedIds = run.memoryEvidenceIds instanceof Set ? run.memoryEvidenceIds : new Set();
        try {
          const selfId = platformSelfId(modules);
          const ignoredEmotionSenders = readConfig(cfg, 'emotion.ignoreSenderIds', []);
          const cue = explicitEmotionEvents({ at, evidence, persistedIds, selfId, kind: runKind,
            ignoreSenderIds: Array.isArray(ignoredEmotionSenders) ? ignoredEmotionSenders : [],
            selfNames: resolveEmotionSelfNames(cfg), logSink, chatKey, roundId });
          emotionEvents.push(...cue.events);
          // ★ 2026-10-15（情绪缺口第二组；回修复核 §4）：轮事实快照 —— 环境事件（被冷落/无聊/刷屏）、
          //   每轮成本（按发送条数一次算）、慢压都由 M7 的 `round` 事件消费。
          //   有证据就发；**零入站但确实发言的轮**（proactive 等）也发一次（sentCount>0）—— 事件不带
          //   伪造的聊天证据 id、只带 roundId（台账侧由 M7 记 `round@<roundId>` 重算键）；
          //   沉默且无入站的轮不发（不凭空扣成本）。
          const roundEvidenceIds = (Array.isArray(evidence) ? evidence : [])
            .filter((row) => validateMessageEvidence(row).ok && String(row?.id ?? '').trim())
            .map((row) => String(row.id).trim())
            .slice(0, 12);
          const roundFinish = run.finish || {};
          const sentCount = Number.isFinite(Number(roundFinish.sentMessageCount))
            ? Math.max(0, Math.floor(Number(roundFinish.sentMessageCount)))
            : (run.sentAnything ? 1 : 0);
          if (roundEvidenceIds.length || sentCount > 0) {
            // 指向性同 cue 判据：三字段 + 「回复了机器人自己发过的消息」（id 相等才算）。
            const roundAddressed = (Array.isArray(evidence) ? evidence : []).some((row) => row?.toSelf === true
              || row?.refs?.toSelf === true
              || (Array.isArray(row?.mentions) && row.mentions.some((mention) => mention?.isSelf === true))
              || repliesToKnownBotMessage(row));
            emotionEvents.push({
              type: 'round', at, evidenceIds: roundEvidenceIds, addressed: roundAddressed,
              kind: runKind, sentCount,
              roundId: String(roundId),
              triggerCount: Array.isArray(evidence) ? evidence.length : 0,
              status: String(roundFinish.status ?? (failureReason ? 'error' : 'done')),
              cueKinds: cue.cueKinds.slice(0, 12)
            });
          }
          emotionEvents.push(...lifeFactEvents({ at, rows: memoryFactResults, evidence, persistedIds }));
          emotionEvents.push(...calendarEvents({ at, rows: calendarResults, evidence, persistedIds }));
          const evidenceId = String(primary?.id ?? '');
          if (evidenceId) {
            for (const [tool, ok] of toolResultsByName) {
              emotionEvents.push({ type: 'toolResult', at, evidenceIds: [evidenceId], source: 'tool', ok, tool });
            }
          }
          const scoredPeople = new Set();
          for (const row of memoryFavorResults) {
            const event = relationDeltaFromMemoryFavor(row, { at, chatKey, roundId, evidence, modules, logSink });
            if (!event || scoredPeople.has(event.personId)) continue;
            scoredPeople.add(event.personId);
            emotionEvents.push(event);
          }
          // ★ 2026-10-11：模型自评（finish 的 mood/favorDelta）—— 老树"独立自评轮"通道的回归。
          const selfEvalMemoryWrites = [];
          for (const event of selfEvalEventsFromFinish(memorySelfEvalResults, {
            at, chatKey, roundId, evidence, modules, logSink, memoryWrites: selfEvalMemoryWrites
          })) {
            if (event.type === 'relationDelta') {
              if (scoredPeople.has(event.personId)) continue;   // 同一个人一轮只计一次分（照 memory_favor 口径）
              scoredPeople.add(event.personId);
            }
            emotionEvents.push(event);
          }
          await commitSelfEvalMemories(selfEvalMemoryWrites, {
            modules, bus, memoryAppendRows: memoryFactResults, chatKey, roundId, logSink
          });
          emotionEventsForAbsorb = emotionEvents;
        } catch (error) {
          log(logSink, 'warn', 'emotion-events-build-failed', {
            chatKey, roundId, built: emotionEvents.length, error: String(error?.message ?? error).slice(0, 160)
          });
          emotionEventsForAbsorb = emotionEvents;   // 已构建的那部分照常走吸收
        }
        try {
          if (emotionEventsForAbsorb && readConfig(cfg, 'emotion.enabled', true) !== false) {
            // ★ 2026-10-15（「情绪不变动」排查）：本轮 evidence 一条都没进 M6 账本时，带证据的
            //   情绪事件会被吸收段逐条拒（`evidence-not-in-ledger`）—— 这里留一行汇总，
            //   排查时一眼分清"被证据闸挡住"和"机器自己没动"。
            if (persistedIds.size === 0 && validEvidenceCount > 0) {
              log(logSink, 'warn', 'emotion-evidence-ledger-empty', { chatKey, roundId, evidenceCount: validEvidenceCount });
            }
            const absorbed = absorbEmotion({ modules, logSink, events: emotionEventsForAbsorb, chatKey, roundId,
              hasEvidence: (id) => persistedIds.has(String(id ?? '')),
              appliedKeys: appliedEmotionEvents });
            // ★ 2026-10-15：一轮一行"到底落没落"的汇总（把状态推进写进吸收段自己的名字下，
            //   与逐条 emotion-event-rejected 对照看 —— 哪一轮真动了情绪不再靠反推）。
            if (absorbed.appliedEvents.length) {
              log(logSink, 'info', 'emotion-applied', {
                chatKey, roundId, applied: absorbed.appliedEvents.length, flushed: absorbed.flushed
              });
            }
            // ★ 2026-10-11（派单 #4）：轮末"真落账"信号。工具回执那一刻不可能知道落没落账
            //   （apply + flush 都发生在这里）⇒ 只在 flush 真写成盘后逐条喊；不带理由原文
            //   （理由是模型给的自由文本，可能含私人口话，日志里不落它）。
            if (absorbed.flushed) {
              for (const ev of absorbed.appliedEvents) {
                if (ev?.type !== 'relationDelta' || ev?.source !== 'tool') continue;
                const delta = Number(ev?.changes?.favor);
                if (!Number.isFinite(delta)) continue;
                log(logSink, 'info', 'emotion-relation-delta-applied', {
                  chatKey, roundId, personId: ev.personId, delta, source: 'favor-tool'
                });
              }
            }
          }
        } catch (error) {
          log(logSink, 'warn', 'emotion-absorb-failed', { chatKey, roundId, error: String(error?.message ?? error) });
        }
        // ★ 2026-10-16（离散情绪兜底 · 用户报"离散情绪长期不动、自评不足"）：**无模型调用**的词表兜底。
        //   闸：同一会话**至少每 3 轮**检查一次（轮次计数，不用时间冷却）；只数"有入账证据的真实会话轮"
        //   （主动/空轮不消耗尝试次数）。**不重复加**：本轮台账里已有有效 affect 变化就跳过；否则施加
        //   一次**小幅有界**事件（只留 affect.*、逐键 ±3、专属 kind `fallbackCue` ⇒ 冷却 0）。
        //   ★ 文本源收口（2026-10-16 复核）：**只依据本轮**的内容 —— 本轮新入账的用户文本（evidence，
        //   排除机器人自己）+ 本轮**已确认外发**的机器人文本（`run.confirmedSendReceipts`，凭回执）。
        //   原来读 `store.recent(limit:12)` ⇒ 旧轮的"难过"会每三轮反复驱动新轮、还可能压过新轮的轻松；
        //   现在不读任何历史消息 ⇒ 旧线索不可能重播（这是"可证明不重播"的 bounded 方案）。
        try {
          if (readConfig(cfg, 'emotion.enabled', true) !== false && persistedIds.size > 0) {
            const ledger = modules.emotion?.stateOf?.()?.ledger;
            const affectChanged = Array.isArray(ledger)
              && ledger.slice(emotionLedgerFrom).some((row) => isAffectLedgerRow(row));
            const gate = emotionFallbackRounds.noteRound({ chatKey, affectChanged });
            if (gate.due && !affectChanged) {
              const selfIdForFallback = platformSelfId(modules);
              const inboundTexts = (Array.isArray(evidence) ? evidence : [])
                .filter((row) => String(row?.text ?? '').trim()
                  && String(row?.sender?.id ?? row?.senderId ?? '') !== selfIdForFallback)
                .map((row) => String(row.text).trim());
              const outboundTexts = (Array.isArray(run.confirmedSendReceipts) ? run.confirmedSendReceipts : [])
                .map((entry) => String(entry?.text ?? '').trim()).filter(Boolean);
              const texts = [...inboundTexts, ...outboundTexts];
              const cue = pickFallbackCue(texts);
              const deltas = cue?.kind ? fallbackDeltas(cue.kind) : {};
              const fallbackEvidenceId = [...persistedIds].slice(-1)[0];
              if (Object.keys(deltas).length && fallbackEvidenceId) {
                const fb = absorbEmotion({
                  modules, logSink, chatKey, roundId,
                  events: [{
                    type: 'emotionEvidence', at, source: 'emotion-evidence',
                    kind: FALLBACK_CUE_KIND, fallbackKind: cue.kind, magnitude: 1,
                    evidenceIds: [String(fallbackEvidenceId)], deltas,
                    idempotencyKey: `emotion-fallback:${chatKey}:${roundId}`
                  }],
                  hasEvidence: (id) => persistedIds.has(String(id ?? '')),
                  appliedKeys: appliedEmotionEvents
                });
                log(logSink, 'info', 'emotion-fallback', {
                  chatKey, roundId, cueKind: cue.kind, hitCount: cue.hitCount, texts: texts.length,
                  deltas, applied: fb.appliedEvents.length, flushed: fb.flushed
                });
              } else {
                log(logSink, 'debug', 'emotion-fallback-no-cue', { chatKey, roundId, texts: texts.length });
              }
            }
          }
        } catch (error) {
          log(logSink, 'warn', 'emotion-fallback-failed', { chatKey, roundId, error: String(error?.message ?? error) });
        }
      } catch (error) {
        // 收口最外层（时钟/证据枚举）也兜住 —— 任何漏网都不许从 finally 里冒出去。
        log(logSink, 'warn', 'emotion-absorb-failed', {
          chatKey, roundId, stage: 'prelude', error: String(error?.message ?? error)
        });
      }
      // ★ 有界重试（T-CUTOVER-3 第 6 条，对应旧树 src/orchestrator.js:1694-1733）：
      //   只在"整轮抛错"且"这一轮一条成功发送都没有"时重跑，最多 maxAttempts 次。
      //   ⚠ 口径更正（qwen2 T-REVIEW-G21-B §② 实测）：**主动轮不受 M10 的幂等键保护** ——
      //   主动轮每轮一个新 roundId ⇒ 每轮一把新钥匙 ⇒ 同一轮重试两次会拿两把不同的钥匙，
      //   真正让"重试不重复发"的是 **`!run.sentAnything`** 这个前置条件（:505）。
      //   别把这句话当成"最多重复一条日志"：若哪天把 `sentAnything` 的置真点挪到 await 之后，重试就会重复发言。
      //   重跑由 pump 在 promise settle 后自然驱动（这里不许 await）。
      if (failureReason && !run.nonRetryableFailure && run.attempt < maxAttempts && !run.sentAnything && !run.sendOutcomeUnknown && !paused && !abortReason) {
        item.attempt = run.attempt + 1;
        item.retryQueued = true;
        item.queued = true;              // ★ 2026-10-16：重试条目留在队列里，同样不许被再排一次 flush
        // ★ 2026-10-21 溟修：原来重试是**立刻**塞回队列，等于网络抖动的同一瞬间连撞五次。
        //   现在隔 2~4 秒再排回去，第一次 2s、之后每次多 1s（封顶 5s）——够躲开常见的几秒级断连，
        //   又不至于让一句回话拖半分钟。item.queued 已经置真，普通 flush 不会把它再排一次。
        const retryDelay = Math.min(5000, 2000 + (run.attempt || 1) * 1000);
        const retryItem = item;
        const retryTimer = clock.schedule(() => {
          retryTimers.delete(retryTimer);
          queue.push(retryItem);
          void pump();
        }, retryDelay);
        retryTimers.add(retryTimer);
        log(logSink, 'warn', 'round-retry-queued', {
          chatKey, roundId, attempt: item.attempt, maxAttempts, reason: failureReason, delayMs: retryDelay
        });
      }
      const unreadClaims = Array.isArray(item.inboundReadClaims) ? item.inboundReadClaims : [];
      if (unreadClaims.length && !item.retryQueued) {
        const finishStatus = run.finish?.status ?? run.finishRequested?.status;
        const terminal = !failureReason && finishStatus && !['error', 'aborted'].includes(String(finishStatus));
        settleIncomingReadClaims(unreadClaims, terminal, terminal
          ? `round:${String(finishStatus)}`
          : `round:${String(finishStatus || 'incomplete')}`);
        item.inboundReadClaims = [];
      }
    }
  }

  function scheduleDrainWake(chatKey) {
    const key = String(chatKey ?? '');
    if (!key || drainTimers.has(key)) return;
    const timer = clock.schedule(() => {
      drainTimers.delete(key);
      void pump();
    }, drainDelayMs);
    drainTimers.set(key, timer);
  }

  async function pump() {
    while (!paused && !abortReason && runningChats.size < cap && queue.length) {
      // ★ 2026-11-03（溟）：被点名的批次插队。
      //   现场：她在深水区 @「宝，过来」，前一轮的正文还没写完，这条就排在一串闲聊后面；
      //   她等了 66 秒才等到一句「在呢」，中间那句是回上一轮的话题 —— 在她眼里就是「at 不理我」。
      //   判据：队列里只要有「点名/回复我」的批次（gate.addressed），就先给它发车；
      //   被 drain 定时器或同会话在跑挡住的照旧往后让（下面两个分支原样保留）。
      const pointedIndex = queue.findIndex((entry) => entry?.gate?.addressed === true
        && !drainTimers.has(entry.chatKey) && !runningChats.has(entry.chatKey));
      const item = pointedIndex > 0 ? queue.splice(pointedIndex, 1)[0] : queue.shift();
      if (drainTimers.has(item.chatKey)) {
        item.queued = true;                      // ★ 2026-10-16：留在队列里 ⇒ 后续入站不再排第二次 flush
        queue.push(item);
        if (queue.every((entry) => drainTimers.has(entry.chatKey) || runningChats.has(entry.chatKey))) break;
        continue;
      }
      if (runningChats.has(item.chatKey)) {
        item.queued = true;                      // ★ 同上：忙碌等待期间新消息只并入 item.evidence
        queue.push(item);
        if (queue.every((entry) => runningChats.has(entry.chatKey))) break;
        continue;
      }
      item.queued = false;                       // 这一刻开始，这一批归本轮消费
      const promise = runRound(item);
      // ★ R04（2026-10-18）：结算一律走可选调用 —— 队列项按构造保证有 resolve（普通/主动/聚焦同一种
      //   延迟对象），但单项缺 resolve 也不许打断 pump 队列（完成/暂停/取消只结算一次）。
      item.resolve?.(promise);
      void promise.finally(() => {
        if (!paused && !item.retryQueued && queue.some((queued) => queued.chatKey === item.chatKey)) scheduleDrainWake(item.chatKey);
        void pump();
      });
    }
  }

  /**
   * 会话 key 的前缀就是唯一的"会话种类"真相（`group:123` / `private:456`）。
   * 主动轮没有消息证据，没法从证据里拿 kind ⇒ 从 chatKey 派生；派生不出来就**不是**一次合法唤醒。
   */
  function kindOfChatKey(chatKey) {
    const [kind] = String(chatKey || '').split(':');
    return kind === 'group' || kind === 'private' ? kind : '';
  }

  /**
   * 主动轮（T-G21）—— `modules/proactive.onTick` 调 `wake({chatKey, proactive:true, proactiveReason})`
   * 时走这里，而不是走 `onInbound`（后者要的是**原始消息批次**）。
   *
   * 旧树对应：`src/orchestrator.js:1253 #wakeOnce(chatKey, {proactive, proactiveReason})`，
   * 其中 `:1541 let triggerEntries = proactive ? [] : …` —— **主动轮的证据恒为空**。
   *
   * 四条票面纪律，逐条落在下面：
   *   ① **绝不合成假消息**：`evidence` 恒为 `[]`，`ingest()` 一次都不调（M5 不参与、什么都不落库）；
   *   ② 同一条 A→F 主链（plan → jev → compose → act.send），只是 lane/source 不同；
   *   ③ 尊重 `paused` / `abortAll` / 并发闸；**同会话已在跑、或已有待处理批次 ⇒ 跳过**（不插队抢轮）；
   *   ④ 可解释：接受/跳过都落日志，`round-finished` 带 lane / proactiveReason。
   * 跳过一律**显式返回 `{status:'skipped', reason}`**（票面：不许静默丢弃）。
   */
  function startProactiveRound(request) {
    const chatKey = String(request?.chatKey ?? '');
    const proactiveReason = String(request?.proactiveReason ?? '') || 'idle';
    const kind = kindOfChatKey(chatKey);
    const laneInfo = classifyTurnLane({ proactive: true, proactiveReason });
    const skip = (reason, extra = {}) => {
      log(logSink, 'info', 'proactive-wake-skipped', { chatKey, proactiveReason, reason, ...extra });
      return Promise.resolve({ status: 'skipped', reason, chatKey, proactiveReason, lane: laneInfo.lane, source: laneInfo.source, ...extra });
    };
    if (!kind) return skip('invalid-chat-key');
    const allow = allowOutboundGate(chatKey, cfg);
    if (!allow.allow) return skip(allow.reason, { gate: 'allow', kind: allow.kind, target: allow.id });
    // ★ abortAll 会同时把 paused 置真 ⇒ **先判 abort**，否则"已经不复活了"这件事会被 'paused' 盖掉
    //   （返回值要能让调用方分清"临时暂停、resume 能救"与"这次运行已经结束了"）。
    if (abortReason) return skip('aborted', { abortReason });
    if (paused) return skip('paused');
    if (runningChats.has(chatKey)) return skip('chat-busy');
    // 真实消息刚刚到达、还在静默期里 ⇒ 那一轮马上要跑，主动轮不许抢在它前面开口。
    if (pending.has(chatKey)) return skip('chat-pending');
    if (runningChats.size >= cap) return skip('concurrency-full', { running: runningChats.size, cap });
    const item = {
      chatKey, kind, evidence: [], proactive: true, proactiveReason,
      lane: laneInfo.lane, source: laneInfo.source,
      since: clockNow(clock), firstAt: clockNow(clock), timer: null, resolve: null, promise: null, attempt: 1
    };
    item.promise = new Promise((resolve) => { item.resolve = resolve; });
    queue.push(item);
    log(logSink, 'info', 'proactive-wake-accepted', { chatKey, proactiveReason, lane: laneInfo.lane, source: laneInfo.source });
    void pump();
    return item.promise;
  }

  /**
   * tick 载荷里的 `wake`：主动轮与普通入站共用一个出口，由载荷形状分流。
   * - `{chatKey, proactive:true, proactiveReason}` ⇒ 主动轮（无证据）；
   * - 其它（原始批次 / `{messages:[…]}`）⇒ 原样交给 `onInbound`，**行为逐字节不变**。
   */
  function wake(request) {
    if (request && typeof request === 'object' && !Array.isArray(request) && request.proactive === true) {
      return startProactiveRound(request);
    }
    return onInbound(request);
  }

  /**
   * ★ N-MEDIA-SHAPE：证据媒体条目 {type,id} → 存档/消费形状 {kind,file,url,summary}（老树
   *   `src/onebot.js:611-623` extractMediaFromSegments 的同款形状，消费侧照它过滤）。
   *   · image ⇒ {kind:'image', file:id, url:id 是 http(s) 时才给, summary:''}
   *   · sticker（QQ 小表情，段里只有 face 标识、没有直链）⇒ {kind:'face', faceId:id}
   *   · 其它（video 等）⇒ {kind:type, file:id, url: 同理}
   */
  function toStoreMediaShape(m) {
    const type = String(m?.type ?? '');
    const id = String(m?.id ?? '');
    if (!id) return null;
    if (type === 'sticker') return { kind: 'face', faceId: id };
    return { kind: type || 'image', file: id, url: /^https?:\/\//i.test(id) ? id : '', summary: '' };
  }

  /**
   * 表层近况捕获（入站持久化成功后的那一跳）—— 老树 `src/app.js:1061-1071` 的等价物：
   * 「每条**非 self** 入站即 captureSurface」，而不是只在 composeReply 里抓。
   *   · 为什么会漏（派单背景）：新树原来只在 composeReply:1691-1711 捕获 ⇒ bot 不回复、
   *     没走 compose 的轮（tier 跳过 / skip / wait / 错误轮）整条近况丢掉。
   *   · 范围：本会话 `chatKey` + 本条发言者 `sender.id`（QQ 号格式由 captureSurface 把关）；
   *     evidence 层已剔 self（scenario/evidence.js:163-165），这里再留一道同款显式门。
   *   · 与 compose 兜底不重复：两条路传**同一个证据时间戳** `entry.at` 与同一 chatKey/personId，
   *     `captureSurface` 对「同槽+同文本+同 now」幂等（surface.js 的守卫）⇒ 只写一次；
   *     入库失败的条目这里跳过、仍由 compose 的兜底路捕获（或同样拿不到证据而略过）。
   *   · 失败绝不影响入库主链（老树 :1060 同款）。
   */
  function captureIncomingSurface(chatKey, entry) {
    try {
      const captureSurfaceFn = modules?.memory?.captureSurface;
      if (typeof captureSurfaceFn !== 'function') return;
      if (entry?.self === true) return;
      const uid = String(entry?.sender?.id ?? '').trim();
      if (!uid) return;
      captureSurfaceFn({
        dataDir: modules?.configStore?.DATA_DIR ?? null,
        userId: uid,
        name: String(entry?.sender?.name ?? ''),
        text: String(entry?.text ?? ''),
        now: Number(entry?.at) || clockNow(clock),
        chatKey
      });
    } catch { /* 近况捕获失败不许冒到入库主链 */ }
  }

  function persistIncomingEvidence(chatKey, evidence, rawByEvidenceKey) {
    const chatStore = modules.memory?.store;
    if (typeof chatStore?.appendIncoming !== 'function') {
      log(logSink, 'warn', 'incoming-chat-store-unavailable', { chatKey, messageCount: evidence.length });
      return [];
    }
    const savedRows = [];
    for (const entry of evidence) {
      const id = String(entry?.id ?? '').trim();
      const raw = rawByEvidenceKey.get(`${chatKey}\u0000${id}`) ?? null;
      const rawSegments = Array.isArray(raw?.message) ? raw.message
        : Array.isArray(raw?.segments) ? raw.segments : [];
      const extractMedia = modules.platform?.extractMediaFromSegments;
      // ★ N-MEDIA-SHAPE（2026-10-11，回归-媒体联动.mjs 的 02 抓到的真缺口）：落盘的 media
      //   必须是**消费侧形状** {kind,file,url,summary}（act/executors/media.js:238/252 的
      //   get_message_images / collect_sticker、compose 的 resolveUrl、金句墙上传都按
      //   m.kind==='image' && m.url 过滤），**不能是证据形状** {type,id}。
      //   · 主路：platform 的纯函数抽取（apps/server 门面自 N-MEDIA-SHAPE 起并列暴露它）；
      //   · 兜底：抽不了（门面没暴露/老装配）时按证据条目映射 —— url **只在 id 真是 http(s)
      //     地址时给**（6289f114 起图段带 url 时证据 id 就是 url）；文件名绝不硬塞进 url，
      //     那会造成"看起来有 URL、下载必失败"的第二种假象。
      const media = typeof extractMedia === 'function'
        ? extractMedia(rawSegments)
        : (Array.isArray(entry?.media) ? entry.media.map(toStoreMediaShape).filter(Boolean) : []);
      const syntheticId = id.startsWith(`${chatKey}#`);
      const mid = syntheticId ? null : (raw?.message_id ?? raw?.id ?? raw?.mid ?? entry?.id ?? null);
      try {
        const saved = chatStore.appendIncoming(chatKey, {
          mid,
          ts: entry?.at,
          senderId: entry?.sender?.id,
          senderName: entry?.sender?.name,
          text: entry?.text,
          // ★ 2026-10-19（第六批）：引用原文没取到时也要**留住"回复了哪条"这个事实**（id 足够，
          //   文本留空如实表示未取得）。改前这里只存解析成功后的 quoted ⇒ 未解析的引用在存档里
          //   连引用 id 都没有，历史/UI 只能当没引用过。
          reply: entry?.refs?.quoted
            ?? (entry?.refs?.replyTo ? { id: String(entry.refs.replyTo), sender: '', senderId: null, self: false, text: '' } : null),
          media,
          toSelf: entry?.refs?.toSelf === true,
          replyToSelf: entry?.refs?.quoted?.self === true
        });
        if (Number.isSafeInteger(Number(saved?.id))) {
          savedRows.push({ evidenceId: id, localId: Number(saved.id) });
          // ★ 2026-11-01（溟）：把落库那份 media 回填进证据 —— 引用段带进来的图
          //   （snowluma 的 resolveQuotedImages → reply.data.images）只有走平台层
          //   `extractMediaFromSegments` 才看得见；证据的 media 却是 scenario 层
          //   `collectMedia(segments)` 抽的，它只认独立的 image 段，不展开 reply。
          //   于是同一条消息"存档有图、证据没图"：自动看图只附得上邻图（另一张），
          //   模型只能眼睁睁说"引用里那张只剩空壳"（2026-11-01 13:49 群 200000001 现场）。
          //   两处同源以后，附图 / get_message_images / 可见性提示才说同一件事。
          if (Array.isArray(media) && media.length) {
            try {
              if (!Array.isArray(entry.media)) entry.media = [];
              const have = new Set(entry.media.map((m) => `${m?.type ?? ''}|${m?.id ?? ''}`));
              for (const m of media) {
                if (m?.kind !== 'image' || !m.url) continue;
                const key = `image|${m.url}`;
                if (have.has(key)) continue;
                have.add(key);
                entry.media.push({ type: 'image', id: m.url });
              }
            } catch { /* 回填失败不影响入库主链 */ }
          }
          // ★ 2026-10-15（派单回修）：入库成功才捕获近况 —— 沉默轮也能记到（不再只靠 compose）。
          captureIncomingSurface(chatKey, entry);
        }
        if (saved?.dupSuspect) log(logSink, 'info', 'incoming-duplicate-suspected', {
          chatKey, mid: saved.mid, previousMid: saved.dupPrevMid, gapMs: saved.dupGapMs,
          mediaDiff: saved.dupMediaDiff === true
        });
        // ★ 2026-10-26（识图修复）：**入库当下就把图字节抓进本地缓存**。
        //   为什么必须有这一步：QQ 的图片 URL 是短命资源 —— 相册图带时效 rkey、商城表情的
        //   raw300.gif 一部分发出来时就已 404（实测同一条 URL 几秒后再取就没了）。而自动
        //   看图 / get_message_images 都发生在"图已入库几秒到几小时之后"，那时再下载，
        //   死链只能失败 —— 模型永远看不到这张图。收图瞬间 URL 还活着，此刻抓字节落盘，
        //   之后看图走缓存，就不再受 URL 寿命约束（与 sticker-manager #warmCache 同一思路，
        //   那边已实测根治了"有的表情能发有的不能"）。
        //   · 只对 image 段做；拿到的 buffer 落 data/sticker-images/cache/（与表情共用
        //     一个带魔数校验的缓存目录，key 用消息 mid + 序号，绝不与表情冲突）。
        //   · 后台跑，不 await：下载失败不影响入库与回话。
        prefetchImageBytesForIncoming(chatKey, saved?.mid ?? id, media);
      } catch (error) {
        log(logSink, 'warn', 'incoming-chat-store-write-failed', {
          chatKey, mid, reason: String(error?.message ?? error).slice(0, 160)
        });
      }
    }
    return savedRows;
  }

  /**
   * ★ 2026-10-26（识图修复）：把一条入库消息的图片字节抓进本地缓存（fire-and-forget）。
   * 下载走 modules.internet.safeFetchBinary（出网面与本树其它取图路径同源）；
   * 落盘复用 media 透出的表情缓存目录与魔数校验（stickerCacheDir / looksLikeImage，
   * 都在 media 公开出口上），文件名前缀 incoming_ 与表情条目天然不冲突。
   * 任何失败都只记一行日志：这是锦上添花的一步，绝不能影响收图主链。
   */
  function prefetchImageBytesForIncoming(chatKey, mid, mediaList) {
    try {
      const images = (Array.isArray(mediaList) ? mediaList : [])
        .filter((m) => m?.kind === 'image' && typeof m?.url === 'string' && /^https?:\/\//i.test(m.url));
      if (!images.length) return;
      const internet = modules?.internet;
      const mediaMod = modules?.media;
      if (typeof internet?.safeFetchBinary !== 'function'
        || typeof mediaMod?.stickerCacheDir !== 'function'
        || typeof mediaMod?.looksLikeImage !== 'function') return;
      const midKey = String(mid ?? '').replace(/[^\w.-]/g, '_').slice(0, 80) || 'mid';
      images.forEach((img, index) => {
        void Promise.resolve().then(async () => {
          const [{ buffer }, fs, path] = await Promise.all([
            internet.safeFetchBinary(img.url, 8 * 1024 * 1024, { browseLocked: true }),
            import('node:fs'),
            import('node:path')
          ]);
          if (!mediaMod.looksLikeImage(buffer)) return;
          const dir = mediaMod.stickerCacheDir();
          const base = path.join(dir, `incoming_${midKey}_${index}`);
          // 字节 + 元数据各落一份：看图侧（readIncomingImageCache）按 URL 精确配对靠这份 meta。
          try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(`${base}.img`, buffer);
            fs.writeFileSync(`${base}.json`, JSON.stringify({ url: img.url, mid: String(mid ?? ''), index, bytes: buffer.length, at: clockNow(clock) }));
          } catch { /* 缓存写失败不追责 */ }
          log(logSink, 'info', 'incoming-image-cached', { chatKey, mid: String(mid ?? ''), index, bytes: buffer.length });
        }).catch((error) => {
          log(logSink, 'info', 'incoming-image-cache-failed', {
            chatKey, mid: String(mid ?? ''), index, reason: String(error?.message ?? error).slice(0, 80)
          });
        });
      });
    } catch (error) {
      log(logSink, 'warn', 'incoming-image-cache-setup-failed', { chatKey, reason: String(error?.message ?? error).slice(0, 120) });
    }
  }

  function claimIncomingReadBatch(chatKey, localIds) {
    const store = modules.memory?.store;
    const ids = [...new Set((Array.isArray(localIds) ? localIds : []).map(Number).filter(Number.isSafeInteger))];
    if (!ids.length) return null;
    if (typeof store?.claimUnreadByIds !== 'function') {
      log(logSink, 'warn', 'incoming-read-claim-unavailable', { chatKey, messageCount: ids.length });
      return null;
    }
    const batchId = `inbound:${++incomingClaimSeq}:${clockNow(clock)}`;
    try {
      const claimed = store.claimUnreadByIds(chatKey, ids, batchId);
      const claimedIds = [...new Set((Array.isArray(claimed) ? claimed : []).map((row) => Number(row?.id)).filter(Number.isSafeInteger))];
      if (claimedIds.length !== ids.length) log(logSink, 'warn', 'incoming-read-claim-partial', {
        chatKey, requested: ids.length, claimed: claimedIds.length
      });
      return claimedIds.length ? { chatKey, batchId, ids: claimedIds } : null;
    } catch (error) {
      log(logSink, 'warn', 'incoming-read-claim-failed', { chatKey, messageCount: ids.length, reason: String(error?.message ?? error) });
      return null;
    }
  }

  function settleIncomingReadClaims(claims, markRead, reason) {
    const store = modules.memory?.store;
    for (const claim of Array.isArray(claims) ? claims : []) {
      if (!claim?.ids?.length) continue;
      try {
        let changed = 0;
        if (markRead) {
          // The claim-token commit is the race-safe markReadByIds equivalent: only this
          // exact processing attempt can advance the messages it claimed.
          changed = typeof store?.commitRouteClaim === 'function'
            ? store.commitRouteClaim(claim.chatKey, claim.ids, claim.batchId)
            : (typeof store?.markReadByIds === 'function' ? store.markReadByIds(claim.chatKey, claim.ids) : 0);
          log(logSink, changed === claim.ids.length ? 'info' : 'warn', 'incoming-read-advanced', {
            chatKey: claim.chatKey, requested: claim.ids.length, marked: changed, reason
          });
        } else {
          const released = typeof store?.releaseRouteClaim === 'function'
            ? store.releaseRouteClaim(claim.chatKey, claim.ids, claim.batchId) : 0;
          log(logSink, released === claim.ids.length ? 'info' : 'warn', 'incoming-read-claim-released', {
            chatKey: claim.chatKey, requested: claim.ids.length, released, reason
          });
        }
      } catch (error) {
        log(logSink, 'warn', markRead ? 'incoming-read-advance-failed' : 'incoming-read-release-failed', {
          chatKey: claim.chatKey, messageCount: claim.ids.length, reason: String(error?.message ?? error)
        });
      }
    }
  }

  function onInbound(rawBatch) {
    const replayingStoredUnread = Array.isArray(rawBatch?.unreadReplayFacts)
      && rawBatch.unreadReplayFacts.length > 0;
    const replayFacts = Array.isArray(rawBatch?.unreadReplayFacts) ? rawBatch.unreadReplayFacts : [];
    const rawItems = Array.isArray(rawBatch) ? rawBatch
      : Array.isArray(rawBatch?.raw) ? rawBatch.raw
        : (Array.isArray(rawBatch?.messages) ? rawBatch.messages : []);
    const batchChatKey = String(rawBatch?.chatKey ?? '');
    const rawByEvidenceKey = new Map();
    for (const raw of rawItems) {
      if (!raw || typeof raw !== 'object') continue;
      const rawChatKey = String(raw.chatKey ?? (raw.message_type === 'group' && raw.group_id != null
        ? `group:${raw.group_id}`
        : raw.message_type === 'private' && raw.user_id != null
          ? `private:${raw.user_id}` : batchChatKey));
      const rawId = raw.message_id ?? raw.id ?? raw.mid;
      if (rawChatKey && rawId !== null && rawId !== undefined && String(rawId).trim()) {
        rawByEvidenceKey.set(`${rawChatKey}\u0000${String(rawId).trim()}`, raw);
      }
    }
    return ingest(rawBatch).then((rows) => {
      if (paused || abortReason) return { status: 'aborted', reason: abortReason || 'paused' };
      const grouped = new Map();
      for (const row of rows) {
        const key = evidenceChatKey(row);
        if (!key) continue;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(row);
      }
      if (!grouped.size) return { status: 'empty', reason: 'no-evidence' };
      const promises = [];
      const admitted = new Map();
      const admittedGates = new Map();   // D-2 B：档位判定要跟着证据进轮次（trace 的 lane/source/contextTier 靠它）
      const admittedUnreadIds = new Map();
      const suppressed = [];
      for (const [chatKey, evidence] of grouped) {
        const allow = allowInboundGate(chatKey, cfg);
        if (!allow.allow) {
          const reasonCode = 'allow_not_listed';
          suppressed.push({ chatKey, kind: allow.kind, reason: reasonCode, reasonCode });
          emit(bus, 'wake:suppressed', { chatKey, subjectKind: allow.kind, reason: reasonCode, reasonCode });
          emit(bus, 'plan:decided', { chatKey, decision: 'skip', reason: reasonCode, reasonCode, subjectKind: allow.kind, messageCount: evidence.length });
          try {
            modules.observability?.ledger?.('decision', {
              chatKey, decision: 'skip', reasonCode, subjectKind: allow.kind, messageCount: evidence.length,
              lane: 'ambient', source: 'allow_list_policy'
            });
          } catch (error) {
            log(logSink, 'warn', 'allow-gate-ledger-failed', { chatKey, reasonCode, error: String(error?.message ?? error) });
          }
          log(logSink, 'info', 'allow-gate-suppressed', { chatKey, kind: allow.kind, reasonCode });
          continue;
        }
        if (allow.unparsed) log(logSink, 'warn', 'allow-gate-unparsed-chat-key', { chatKey });
        // ★ 2026-10-23（溟）她定的：「我接受你的文件你也会回复，这个就不用检测了」。
        //   起因：我往她 QQ 发 mp3 试听，文件到达/接收那一下被当成一条新消息 ⇒ QQ 侧就回一句，
        //   一次试听换一次没意义的搭话。判据很窄：这一批证据里**每一行**都只是附件占位符
        //   （[文件…]/[图片]/[语音]/[视频]/[表情]/[卡片消息]），没有一句她自己打的字 ⇒ 不开轮。
        //   带字的文件消息照旧走正常流程（有一行带字就不满足 every）。
        const ATTACH_ONLY_RE = /^\s*(?:\[(?:文件|图片|语音|视频|表情|卡片消息)[^\]]*\]\s*)+$/;
        const evidenceTexts = evidence.map((entry) => String(entry?.text ?? '')).filter((t) => t.trim());
        // ★ 2026-10-26（溟）：这条闸收窄到「**我自己发的**纯附件」。
        //   起因：她问「你的识图是不是有问题」——查下来她的图常常根本没进回合：
        //   她（或群里别人）发一张不带字的图 ⇒ 每一行都只是 [图片] 占位符 ⇒ 命中下面那条
        //   every ⇒ 直接不开轮。图既没挂给模型看，也没人回她，她那边看到的就是「识图坏了」。
        //   原意只有一条：我往她 QQ 发 mp3 试听，文件到达被当成新消息，我回一句没意义的搭话。
        //   那个场景里每一行都是 self === true，所以按 self 收窄既保住原意，也不再吞别人的图。
        //   别人的纯附件照旧开轮：群里有 @ 门控与档位判定决定回不回，不靠这条兜。
        const allSelf = evidence.length > 0 && evidence.every((entry) => entry?.self === true);
        //   成本口径（同一天定的）：群里维持旧行为 —— 群里不 @ 的纯附件图不开轮，否则
        //   200000003 那种一天 310 张图的群会每张烧一轮上下文。群里 @ 我的图本来就带
        //   "@名字" 前缀、不满足 ATTACH_ONLY_RE，照旧开轮并附图。私聊才真正放开。
        const isPrivateChat = !String(chatKey).startsWith('group:');
        const keepSuppressing = allSelf || !isPrivateChat;
        if (keepSuppressing && evidenceTexts.length && evidenceTexts.every((t) => ATTACH_ONLY_RE.test(t))) {
          const reasonCode = 'attachment_only';
          suppressed.push({ chatKey, kind: allow.kind, reason: reasonCode, reasonCode });
          emit(bus, 'wake:suppressed', { chatKey, subjectKind: allow.kind, reason: reasonCode, reasonCode });
          log(logSink, 'info', 'attachment-only-suppressed', { chatKey, count: evidenceTexts.length, allSelf, isPrivateChat });
          // ★ 2026-10-27（溟）：群里别人发的纯附件**照样入库**，只是照旧不开轮。
          //   起因：她问「识图怎么天天坏」。量出来今天主群 695 条图片/视频事件，只有 19 条
          //   进了消息库 —— 其余全在下面这个 continue 前面被吞。现场就是：群友先甩一张图，
          //   隔二十秒再发「@溟 我朋友的鱼这样了」，图那条没了，到我这儿只剩半句话。
          //   入库不烧上下文（appendIncoming + 后台预取图字节，取图那一刻 URL 还活着），
          //   开轮与回话的判定一点没放宽 —— 省 token 的原意保住，图不再凭空消失。
          if (!isPrivateChat && !allSelf && !replayingStoredUnread) {
            try {
              persistIncomingEvidence(chatKey, evidence, rawByEvidenceKey);
            } catch (error) {
              log(logSink, 'warn', 'attachment-only-persist-failed', {
                chatKey, reason: String(error?.message ?? error).slice(0, 120)
              });
            }
          }
          continue;
        }
        // 老树在 allowed() 后立即存档；context-tier 决定是否回复，不决定消息是否留档。
        const savedRows = replayingStoredUnread ? [] : persistIncomingEvidence(chatKey, evidence, rawByEvidenceKey);
        const evidenceIds = new Set(evidence.map((entry) => String(entry?.id ?? '')));
        const replayLocalIds = replayFacts
          .filter((fact) => evidenceIds.has(String(fact?.id ?? '')) && String(fact?.chatKey ?? chatKey) === chatKey)
          .map((fact) => fact?.localId);
        const localIds = [
          ...savedRows.map((row) => row.localId),
          ...replayLocalIds
        ];
        // ★ 2026-10-17（读回滚修复）：结读认领必须用**证据 id（mid）→ ChatStore 本地数字 id** 的映射。
        //   0cc07359 起，普通队列直接拿 `localIds`（数字）去比 `normalEvidence` 的 evidence id（字符串）
        //   ⇒ 恒不命中：普通轮次永远认领不到、结不了读（恢复重放同理无限重放）。两条既有自测
        //   （resume replays… / handled inbound advances…）钉的就是这条口径。
        const unreadLocalByEvidence = new Map();
        for (const row of savedRows) unreadLocalByEvidence.set(String(row?.evidenceId ?? ''), Number(row?.localId));
        for (const fact of replayFacts) {
          const factId = String(fact?.id ?? '');
          if (!factId || !evidenceIds.has(factId)) continue;
          unreadLocalByEvidence.set(factId, Number(fact?.localId));
        }
        const kind = evidence[0]?.kind === 'private' ? 'private' : 'group';
        const focusAt = clockNow(clock);
        // ★ 2026-10-18（R05/followupEnabled）：接话聚焦先取**生效态**（总开关 + 活动窗，
        //   关闭时顺带清窗/清定时器）——下面的"有效续聊"资格与收集都看它，不再裸查 registry。
        const followupWindowHere = kind === 'group' ? followupActiveEffective(chatKey) : false;
        const focusEnabled = kind === 'group'
          && readConfig(cfg, 'localJev.judgeMode.enabled', false) === true;
        if (focusRegistry && kind === 'group') {
          // C10: suppress old mention/keyword windows while followup focus is active.
          if (focusEnabled && !followupWindowHere) {
            for (const entry of evidence) {
              const addressed = entry?.toSelf === true || entry?.refs?.toSelf === true
                || (Array.isArray(entry?.mentions) && entry.mentions.some((mention) => mention?.isSelf === true));
              const target = String(entry?.sender?.id ?? '').trim();
              if (addressed && target) focusRegistry.openMention({
                accountId: platformSelfId(modules), chatKey, target, at: focusAt
              });
            }
          } else if (readFocusState(chatKey, focusAt)?.active) {
            focusRegistry.close({
              accountId: platformSelfId(modules), chatKey, reason: 'judge-mode-disabled', at: focusAt
            });
          }
        }
        let activeFocus = focusEnabled && readFocusState(chatKey, focusAt)?.active === true;
        let gate = contextTierGate(evidence, cfg);
        // C10: suppress old keyword window while followup focus is active.
        if (focusEnabled && focusRegistry && !activeFocus && gate.allow
          && !followupWindowHere
          && (gate.keyword === true || Number(gate.tier) >= 4)) {
          const keywords = readScopedConfig(cfg, 'store.keywords', { chatKey, kind }, []);
          for (const entry of evidence) {
            const text = String(entry?.text ?? '');
            const trigger = (Array.isArray(keywords) ? keywords : [])
              .map((value) => String(value ?? '').trim())
              .find((value) => value && matchesTierKeyword(text, [value]));
            const target = String(entry?.sender?.id ?? '').trim();
            if (!trigger || !target) continue;
            focusRegistry.openKeyword({
              accountId: platformSelfId(modules), chatKey, target, trigger, at: focusAt
            });
            break;
          }
          activeFocus = readFocusState(chatKey, focusAt)?.active === true;
        }
        // ★ R05（2026-10-18）：档位过滤**之前**先认"有效续聊"资格 —— 接话聚焦窗内的消息
        //   （对象=本窗参与者、时限=20 秒窗、总开关约束都在状态机里）不能被 1/2 档静态拒绝
        //   直接干掉（现场：刚回复完「那就这么说定了」也接不上）。与旧 mention/keyword 窗同一口径。
        if (!gate.allow && (activeFocus || followupWindowHere)) {
          gate = {
            ...gate,
            allow: true,
            count: contextMessageCount(cfg, { chatKey, kind }, 'allCount', 80),
            countSource: 'allCount',
            ...(activeFocus ? { focusWindow: true } : {}),
            ...(followupWindowHere ? { followupWindow: true } : {})
          };
        }
        if (!gate.allow) {
          const claim = claimIncomingReadBatch(chatKey, localIds);
          if (claim) settleIncomingReadClaims([claim], true, 'context-tier-gate');
          const reasonCode = 'tier_restricted';
          suppressed.push({ chatKey, tier: gate.tier, reason: reasonCode, reasonCode });
          emit(bus, 'wake:suppressed', { chatKey, tier: gate.tier, reason: reasonCode, reasonCode });
          // The assembled bus persists plan:decided; also submit to the decision ledger for its UI consumer.
          emit(bus, 'plan:decided', { chatKey, decision: 'skip', reason: reasonCode, reasonCode, tier: gate.tier, messageCount: evidence.length });
          try {
            modules.observability?.ledger?.('decision', {
              chatKey, decision: 'skip', reasonCode, tier: gate.tier, messageCount: evidence.length,
              lane: 'ambient', source: 'all_messages_policy'
            });
          } catch (error) {
            log(logSink, 'warn', 'context-tier-ledger-failed', { chatKey, reasonCode, error: String(error?.message ?? error) });
          }
          log(logSink, 'info', 'context-tier-suppressed', { chatKey, tier: gate.tier, reason: reasonCode, reasonCode });
          continue;
        }
        admitted.set(chatKey, evidence);
        admittedGates.set(chatKey, gate);
        // 本批「证据 id → 本地 id」映射：普通队列据此认领结读，聚焦收走的那部分改用同一张表（见下）。
        admittedUnreadIds.set(chatKey, unreadLocalByEvidence);
      }
      if (!admitted.size) {
        // 两道门共用这个出口，reason 必须说清是谁拦的：全被白名单门拦 ⇒ allow-gate，
        // 否则按档位门口径。写成一律 context-tier-gate 会让调用方（和测试）认错责任门。
        const allByAllow = suppressed.length > 0 && suppressed.every((row) => row.reasonCode === 'allow_not_listed');
        return { status: 'skipped', reason: allByAllow ? 'allow-gate' : 'context-tier-gate', suppressed };
      }
      for (const [chatKey, evidence] of admitted) {
        // C10: when followup focus is active, collect messages into the followup registry
        // (per-speaker batching) instead of the normal queue path. The followup window
        // has its own judgment logic — it does not go through the normal plan/judge flow.
        // Direct @ messages must enter the original speech chain (spec).
        // Non-collected messages (before-window, capacity, etc.) go to the normal queue.
        let normalEvidence = evidence;
        // ★ 2026-10-16（C10 私聊串线修复）：只有**群聊**进接话聚焦。私聊消息一律走普通队列
        //   （plan 的 PRIVATE_RULE 必回复）。修复前开出的私聊窗不会再收集新消息，≤20 秒自然到期；
        //   registry 是纯内存，进程重启后不存在任何遗留窗。
        // ★ 2026-10-18：改用 `followupActiveEffective`（总开关关 ⇒ 不收，并顺手清窗/清定时器）。
        if (kindOfChatKey(chatKey) === 'group' && followupActiveEffective(chatKey) && followupRegistry) {
          const notCollected = [];
          // ★ 2026-10-16（C10 独立审查 · 修②）：聚焦收走的消息在这里**结清已读**。
          //   它们不会再进普通队列（下面只把 notCollected 送进去，见 :5343 的过滤注释），若仍留未读，
          //   `wakeUnreadBacklog`（resume 时，:5460）会把它们再喂一次 onInbound：窗口已关 ⇒ 重走普通
          //   队列（重复处理、可能重复回复）；窗口未关 ⇒ 被 duplicate 静默丢弃，且这次重放同样不结读
          //   ⇒ 每次 resume 无限重放。收走 = 该消息由本窗消费（@ 另行直通普通链），与"普通消息由普通轮次结读"对称。
          const followupConsumedLocalIds = [];
          const localIdByEvidence = admittedUnreadIds.get(chatKey) || new Map();
          for (const entry of evidence) {
            // Direct @ → normal speech chain, not followup.
            const isDirectAddress = entry?.toSelf === true || entry?.refs?.toSelf === true
              || (Array.isArray(entry?.mentions) && entry.mentions.some((m) => m?.isSelf === true));
            if (isDirectAddress) {
              notCollected.push(entry);
              continue;
            }
            const msgId = String(entry?.id ?? '');
            const speakerId = String(entry?.sender?.id ?? '');
            try {
              const result = followupRegistry.collect({
                chatKey,
                speakerId,
                messageId: msgId,
                at: Number(entry?.at) || clockNow(clock)
              });
              if (result?.collected) {
                const localId = localIdByEvidence.get(msgId);
                if (Number.isSafeInteger(localId)) followupConsumedLocalIds.push(localId);
                // Cache text for later judgment (dueBatch returns only IDs).
                if (msgId) {
                  followupTextCache.set(msgId, {
                    text: String(entry?.text ?? ''),
                    speakerId,
                    at: Number(entry?.at) || clockNow(clock)
                  });
                  if (followupTextCache.size > 512) {
                    const oldest = followupTextCache.keys().next();
                    if (!oldest.done) followupTextCache.delete(oldest.value);
                  }
                }
              } else if (result?.reason === 'duplicate') {
                // Already processed — drop silently (existing dedup semantics).
              } else {
                // before-window / too-many-speakers / invalid-message / window-inactive
                // → route to normal queue (caller obligation per followup.js contract).
                notCollected.push(entry);
              }
            } catch (error) {
              log(logSink, 'warn', 'followup-collect-failed', { chatKey, error: String(error?.message ?? error).slice(0, 120) });
              notCollected.push(entry);
            }
          }
          if (followupConsumedLocalIds.length) {
            const followupClaim = claimIncomingReadBatch(chatKey, followupConsumedLocalIds);
            if (followupClaim) settleIncomingReadClaims([followupClaim], true, 'followup-collected');
          }
          // Check if any batches are due and enqueue them.
          try {
            const dueResult = followupRegistry.dueBatch({ chatKey, at: clockNow(clock) });
            if (dueResult?.active && Array.isArray(dueResult.due) && dueResult.due.length) {
              for (const batch of dueResult.due) {
                if (!batch?.speakerId || !Array.isArray(batch.messageIds) || !batch.messageIds.length) continue;
                queue.push(makeFollowupQueueItem(chatKey, batch));
              }
            }
            // Schedule delayed wakeup for next batch (event-driven, not polling).
            if (dueResult?.active && Number.isFinite(dueResult.nextDueAt)) {
              scheduleFollowupWake(chatKey, dueResult.nextDueAt);
            }
          } catch (error) {
            log(logSink, 'warn', 'followup-due-batch-failed', { chatKey, error: String(error?.message ?? error).slice(0, 120) });
          }
          // If all entries were collected or dropped, skip normal path.
          // Otherwise route non-collected entries to the normal queue.
          if (notCollected.length === 0) continue;
          normalEvidence = notCollected;
        }
        let item = pending.get(chatKey);
        if (!item) {
          item = { chatKey, evidence: [], inboundUnreadIds: [], inboundReadClaims: [], since: clockNow(clock), firstAt: clockNow(clock), timer: null, resolve: null, promise: null };
          item.promise = new Promise((resolve) => { item.resolve = resolve; });
          pending.set(chatKey, item);
        }
        // D-2 B：把这一批的档位判定随证据一起带进轮次 —— trace 的 lane/source/contextTier
        // 只能从这里来（runRound 里没有 cfg 视角）。
        // ★ 2026-10-19（N3）：合批时**合并资格标记**（关键词/@/全量候选 OR），后到的普通消息
        //   不能覆盖先到消息已取得的触发资格；tier/count 等展示字段仍取最新一批。
        item.gate = mergeAdmittedGate(item.gate ?? null, admittedGates.get(chatKey) ?? null);
        item.evidence.push(...normalEvidence);
        // Only claim unread IDs for entries that entered the normal queue (not followup-collected).
        // ★ 2026-10-17：用「证据 id → 本地 id」映射查回本地 id（原先拿数字 localId 比字符串
        //   evidence id，恒为空 ⇒ 结读永不发生）。
        const normalIds = new Set(normalEvidence.map((e) => String(e?.id ?? '')));
        const normalLocalByEvidence = admittedUnreadIds.get(chatKey) || new Map();
        item.inboundUnreadIds.push(...[...normalIds]
          .map((evidenceId) => normalLocalByEvidence.get(evidenceId))
          .filter((localId) => Number.isSafeInteger(localId)));
        scheduleFlush(chatKey, item);
        promises.push(item.promise);
      }
      // A burst's callers share one settled outcome, and pending remains visible until it starts.
      return Promise.all(promises);
    }).then((outcome) => Array.isArray(outcome) && outcome.length === 1 ? outcome[0] : outcome);
  }

  /**
   * 受控「定时 / 主动」发送出口（**不经模型**）。
   *
   * 为什么需要（缺口②）：提醒（`⏰ 提醒：…`）与定时广播的文本是**既定的**，
   * 不能让模型改写；但发送又必须走"回执权威"那一条路（铁律：没有平台回执不算已发送）。
   * ⇒ 这里复用 M10 的 `send` + `assertDelivered`，只是绕开 compose/LLM。
   *
   * 幂等：`idempotencyKey` 相同 = 同一条消息。**调用方给稳定 key**（如 `sched:reminder:<id>`）
   * 就能拿到"最多一次"语义 —— 结果不确定时重试不会重复发送（M10 内部按 key 记忆回执）。
   *
   * ★ 默认键的口径（2026-10-05 修，qwen2 T-REVIEW-G21-B-r5 §R5-6 实测 + 我的
   *   `probe-sched-key-collision.mjs` 复现）：旧默认键 `sched:<chatKey>:<now>:<段数>` **不认内容**
   *   ⇒ 同一个 tick、同一个会话、两次**不同正文**的 `sendScheduled`（都没给键）会撞成同一把钥匙，
   *   于是第二次命中第一次的成功回执：**平台只收到第一条，两次调用却都返回 delivered:true**（静默丢消息）。
   *   ⇒ 现在的口径：**不给键时，默认键按"调用序号"唯一**（`…:n<seq>`）——隐式去重彻底关掉，
   *     想拿"最多一次"就必须显式给键（提醒/广播都已经给了）。同时记一条 warn，让"没给键"这件事看得见。
   *     取舍说明：不给键的**重试**会重发（fail-open，看得见），换来的是**绝不静默吞掉一条不同的消息**。
   *
   * @param {string} chatKey
   * @param {string|string[]} messages
   * @param {{idempotencyKey?:string, action?:string, evidenceId?:string, replyToMessageId?:any, atUserId?:any}} [options]
   * @returns {Promise<{ok:boolean, delivered:boolean, reasons:string[], receipt:object|null}>}
   */
  async function sendScheduled(chatKey, messages, options = {}) {
    if (typeof modules.act?.send !== 'function') throw new Error('sendScheduled: modules.act.send 不存在（M10 未落地？）');
    const key = String(chatKey || '');
    const list = (Array.isArray(messages) ? messages : [messages]).map((m) => String(m ?? '')).filter((m) => m !== '');
    if (!key || !list.length) throw new Error('sendScheduled: 需要 chatKey 与非空 messages');
    // ★ 闸门（qwen2 T-REVIEW-G21-B §③ 实测：同一个 tick 载荷里 `wake` 有六道闸、`sendScheduled` **一道都没有**
    //   ⇒ 暂停/中止之后，提醒与定时广播照旧发得出去；那时两种改法都全绿 = 行为零观测）。
    //   口径：**paused / aborted 一律不发**，返回结构化"被拒"结果而不是抛 —— 调用方（提醒/广播）把它当一次失败记，
    //   心跳不会被炸掉。幂等键语义不变：调用方下次仍可用同一 key 重试。
    const refused = (why, extra = {}) => {
      log(logSink, 'warn', 'scheduled-send-refused', { chatKey: key, reason: why, segments: list.length, ...extra });
      return { ok: false, delivered: false, reasons: [`发送被拒：${why}`], receipt: null, refused: why };
    };
    const allow = allowOutboundGate(key, cfg);
    if (!allow.allow) return refused(allow.reason, { gate: 'allow', kind: allow.kind, target: allow.id });
    if (abortReason) return refused('aborted');
    if (paused) return refused('paused');
    const explicitKey = String(options.idempotencyKey || '');
    if (!explicitKey) {
      // 不给键 ⇒ 没有"最多一次"语义（见函数头注释）。记一条 warn：这是**调用方**该修的地方，不是静默降级。
      log(logSink, 'warn', 'scheduled-send-without-key', {
        chatKey: key, segments: list.length,
        hint: '调用方应给稳定 idempotencyKey（如 sched:reminder:<id>）；不给键时默认键按调用唯一 ⇒ 不会隐式去重'
      });
    }
    scheduledCallSeq += 1;
    const idempotencyKey = explicitKey || `sched:${key}:${clockNow(clock)}:${list.length}:n${scheduledCallSeq}`;
    const receipt = await modules.act.send({
      chatKey: key,
      messages: list,
      cfg,
      sendBudget: textSendBudget(cfg, key, options.kind || (key.startsWith('private:') ? 'private' : 'group')),
      idempotencyKey,
      action: options.action || 'scheduled-send',
      evidenceId: options.evidenceId || '',
      replyToMessageId: options.replyToMessageId,
      atUserId: options.atUserId
    }, modules.platform);
    // ★ 必须 await：assertDelivered 允许是 async（M15 自己那几处也是 await 的），
    //   不 await 会拿到一个 Promise，`checked.delivered` 就永远是 undefined —— 当场踩过。
    const checked = typeof modules.act.assertDelivered === 'function'
      ? await modules.act.assertDelivered([{ receipt, coverage: receipt?.coverage }])
      : { delivered: receipt?.ok === true, reasons: [] };
    log(logSink, checked.delivered ? 'info' : 'warn', 'scheduled-send', {
      chatKey: key, segments: list.length, idempotencyKey,
      delivered: checked.delivered, reasons: checked.reasons, platformId: receipt?.platformId ?? null
    });
    return { ok: receipt?.ok === true, delivered: checked.delivered, reasons: checked.reasons, receipt: receipt ?? null };
  }

  function onTick(now) {
    if (!Number.isFinite(Number(now))) throw new Error('onTick(now) requires finite injected time');
    // 喂给模块的载荷（缺口②）：`wake` 起一轮、`status` 看现状、`sendScheduled` 不经模型地发既定文本。
    // `clock` 也一并交下去：主动链**必须有可注入的随机源**（`clock.random`）——不然它只能"不抽样、不唤轮"，
    // 表现成"主动功能静默停摆"（sb1 的 proactive 明确要求：随机源缺失就记 fault，不偷偷用 Math.random）。
    const tickPayload = { wake: (request) => wake(request), status: status(), sendScheduled, clock };
    void observeMemoryInput.onTick?.(Number(now), {
      busy: runningChats.size > 0 || pending.size > 0 || queue.length > 0
    });
    const tickers = [modules.reminders?.onTick, modules.proactive?.onTick, modules.emotion?.onTick, modules.broadcast?.onTick];
    for (const tick of tickers) if (typeof tick === 'function') {
      try {
        const out = tick(Number(now), tickPayload);
        // onTick 允许是 async：返回 Promise 就接住它，别让异步失败变成 unhandledRejection。
        if (out && typeof out.then === 'function') {
          out.catch((error) => log(logSink, 'error', 'tick-handler-failed', { error: String(error?.message ?? error) }));
        }
      }
      catch (error) { log(logSink, 'error', 'tick-handler-failed', { error: String(error?.message ?? error) }); }
    }
  }

  function status() {
    return {
      running: [...runningChats.values()].map(({ chatKey, roundId, stage, lane, proactive, proactiveReason }) => ({
        chatKey, roundId, stage,
        // 主动轮额外标注 lane/source，方便 UI/主动模块自己看"现在跑的是不是主动轮"
        ...(proactive ? { proactive: true, lane, proactiveReason } : {})
      })),
      pending: [...pending.values()].map((item) => ({ chatKey: item.chatKey, since: item.since })),
      memoryConsolidation: observeMemoryInput.status?.() ?? null,
      paused
    };
  }

  /**
   * ★ R12（2026-10-18）：恢复积压**分批回放**，不再"读一条也整读全部未读"。
   *   · 每个会话一次只 peek 有界行数（本批上限 + 在途条数），不再按 unreadCount 全读（2000 条
   *     未读也被整份构造）；同步磁盘成本随批大小封顶。
   *   · 处理完一批后，**只有确实推进了未读**（本轮被认领结读、剩余数下降）才续下一批；
   *     出错释放认领（剩余未减）就停下 —— 不空转、不重复回放，未读也没有被静默丢弃
   *     （没处理到的仍留在未读里，下次 resume 继续）。
   *   · 取消/暂停/中止沿用原语义：暂停后不再续批，认领由各轮次按既有规则释放。
   */
  const RESUME_BACKLOG_BATCH_MAX = 120;
  const RESUME_BACKLOG_MAX_CHAIN = 50;

  function readUnreadCount(store, chatKey) {
    try {
      const count = typeof store.unreadCount === 'function'
        ? store.unreadCount(chatKey)
        : store.getChatMeta?.(chatKey)?.unread;
      return Math.max(0, Math.floor(Number(count) || 0));
    } catch (error) {
      log(logSink, 'warn', 'resume-backlog-chat-read-failed', { chatKey, reason: String(error?.code ?? error?.name ?? 'unread-count-failed') });
      return null;
    }
  }

  function queueUnreadBacklogBatch(store, chatKey, kind, stats, depth = 0) {
    const unreadCount = readUnreadCount(store, chatKey);
    if (unreadCount === null || !unreadCount) return false;
    let alreadyQueued = resumeReplayIds.get(chatKey);
    if (!alreadyQueued) { alreadyQueued = new Set(); resumeReplayIds.set(chatKey, alreadyQueued); }
    // 有界扫描：只读「本批上限 + 在途条数」行，够筛出本批即可。
    const scanLimit = Math.min(unreadCount, RESUME_BACKLOG_BATCH_MAX + alreadyQueued.size);
    let unread;
    try { unread = store.peekUnread(chatKey, scanLimit); }
    catch (error) {
      log(logSink, 'warn', 'resume-backlog-chat-read-failed', { chatKey, reason: String(error?.code ?? error?.name ?? 'peek-unread-failed') });
      return false;
    }
    if (!Array.isArray(unread) || !unread.length) return false;
    const selected = unread.filter((row) => {
      const localId = String(row?.id ?? '').trim();
      return localId && !alreadyQueued.has(localId);
    }).slice(0, RESUME_BACKLOG_BATCH_MAX);
    if (!selected.length) return false;
    const raw = selected.map((row) => ({
      id: row?.mid ?? row?.id,
      at: Number(row?.ts) || clockNow(clock),
      chatKey,
      kind,
      senderId: row?.senderId,
      senderName: row?.senderName,
      text: String(row?.text ?? ''),
      reply: row?.reply ?? null,
      media: Array.isArray(row?.media) ? row.media : []
    }));
    const unreadReplayFacts = selected.map((row, index) => ({
      id: String(raw[index]?.id ?? ''),
      localId: Number(row?.id),
      chatKey,
      toSelf: row?.toSelf === true,
      replyToSelf: row?.replyToSelf === true
    }));
    for (const row of selected) alreadyQueued.add(String(row.id));
    stats.chats.add(chatKey);
    stats.messages += selected.length;
    log(logSink, 'info', 'resume-backlog-wake-queued', {
      chatKey, messageCount: selected.length, unreadCount, batchDepth: depth
    });
    void onInbound({ chatKey, kind, raw, unreadReplayFacts })
      .then((result) => log(logSink, 'info', 'resume-backlog-wake-settled', {
        chatKey, messageCount: selected.length, status: String(result?.status ?? 'unknown'),
        reason: String(result?.reason ?? '')
      }))
      .catch((error) => log(logSink, 'warn', 'resume-backlog-wake-failed', {
        chatKey, messageCount: selected.length,
        reason: String(error?.code ?? error?.name ?? 'wake-failed')
      }))
      .finally(() => {
        for (const row of selected) alreadyQueued.delete(String(row.id));
        if (!alreadyQueued.size) resumeReplayIds.delete(chatKey);
        if (paused || abortReason) return;
        if (depth >= RESUME_BACKLOG_MAX_CHAIN) return;
        // 进度守卫：这批真的把未读推进了（剩余数 < 处理前）才续批；否则停手（不空转）。
        const remaining = readUnreadCount(store, chatKey);
        if (remaining === null || remaining <= 0 || remaining >= unreadCount) return;
        queueUnreadBacklogBatch(store, chatKey, kind, stats, depth + 1);
      });
    return true;
  }

  function wakeUnreadBacklog() {
    const store = modules.memory?.store;
    if (typeof store?.listChats !== 'function' || typeof store?.peekUnread !== 'function') {
      log(logSink, 'warn', 'resume-backlog-wake-unavailable', { reason: 'chat-store-list-or-peek-missing' });
      return { chats: 0, messages: 0 };
    }
    let chatKeys;
    try { chatKeys = store.listChats(); }
    catch (error) {
      log(logSink, 'warn', 'resume-backlog-wake-unavailable', { reason: String(error?.code ?? error?.name ?? 'chat-store-list-failed') });
      return { chats: 0, messages: 0 };
    }
    const stats = { chats: new Set(), messages: 0 };
    for (const rawKey of Array.isArray(chatKeys) ? chatKeys : []) {
      const chatKey = String(rawKey ?? '').trim();
      const kind = kindOfChatKey(chatKey);
      if (!chatKey || !kind) continue;
      queueUnreadBacklogBatch(store, chatKey, kind, stats, 0);
    }
    return { chats: stats.chats.size, messages: stats.messages };
  }

  function resume() {
    // 只解除 pause；abortAll 过的 runtime 不复活（T-CUTOVER-3 第 7 条：旧树 setPaused(false) 能原地恢复）
    const wasPaused = paused;
    paused = false;
    const resumed = wasPaused && !abortReason;
    const backlog = resumed ? wakeUnreadBacklog() : { chats: 0, messages: 0 };
    return {
      resumed, paused, abortReason,
      backlogChatsQueued: backlog.chats,
      backlogMessagesQueued: backlog.messages
    };
  }

  function pause(reason = 'paused') {
    paused = true;
    for (const timer of drainTimers.values()) clock.cancel(timer);
    drainTimers.clear();
    // ★ 2026-10-16（C10 收口）：接话唤醒也一并清掉（否则暂停/中止后还留着一把会醒的定时器）。
    clearAllFollowupWakes();
    for (const [chatKey, item] of pending) {
      if (item.timer != null) clock.cancel(item.timer);
      // ★ R04（2026-10-18）：结算可选、单项异常不许打断 —— 暂停/中止只结算一次（resolve 幂等）。
      item.resolve?.({ status: 'aborted', reason: String(reason) });
      pending.delete(chatKey);
    }
    for (const item of queue.splice(0)) item.resolve?.({ status: 'aborted', reason: String(reason) });
  }

  function abortAll(reason = 'aborted') {
    abortReason = String(reason);
    pause(abortReason);
    for (const run of runningChats.values()) run.abort?.(abortReason);
  }

  return Object.freeze({ onInbound, wake, onTick, status, pause, resume, abortAll, sendScheduled });
}
