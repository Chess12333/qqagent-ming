// M2 observability —— refactor 的唯一公开出口（§4：别的模块只能 import 本文件）。
//
// 冻结出口（§3.3 / §3.4）：
//   span(name, fields) -> { end(extra) }   首字延迟分段，可嵌套
//   event(kind, fields)                   结构化事件
//   ledger(name, row)                     追加账本：decision|usage|jev|send
//   recent({ name, n })                   只读查看（异步，读盘）
//   recentWithMeta({ name, n })           同上，但带回 { rows, meta:{requested,limit,returned,bytesRead,
//                                         hasMore,byteLimitReached,oversizedLines,malformedRows,ioErrors,
//                                         truncated,reason,source} } —— 消费方要能说清"这份数据到底全不全"
//                                         （`hasMore`=达到行数上限，**不算** truncated；见函数注释）
//   dayTokenTotal({ at })                  自然日 token 汇总（不受 recent 2000 行上限影响；增量聚合，见 sink）
//   parseEpochMs(value)                    「绝对毫秒」判据（数字/纯数字串/Date/带时区 ISO；非法 ⇒ null）
//                                          —— 用量清零过滤、日统计窗口、分片归属、trace sent.at 共用同一份
//   ── 用量清零边界（2026-10-16 · 调试清零，见 usage-reset.js）──
//   usageResetStatus()                     读持久清零边界（ok/absent/invalid/unreadable/no-dir）
//   writeUsageResetBoundary({ at, note })  写持久清零边界（原子写 + 写后校验；失败不许报成功）
//   usageRowsSinceReset(rows)              按边界过滤 usage 行（只保留边界之后的行）
//   log(level, msg, fields)               日志
//   on(kind, fn) / emit(kind, payload)    bus：同步、失败隔离、不阻塞主链
//
// 配置：configure({ dataDir }) —— **调用方必须显式传 dataDir**，本模块不 import
// config-store（§3.2 还没落地），落盘位置是 `<dataDir>/obs/`。未 configure 时
// 走纯内存模式（照常可用，只是不落盘）。
//
// 四条不变量（README §3.3 + 本模块追加）：
//   1. 账本行不含聊天正文原文 —— 由 sanitize.js 的「ASCII 标量 + allowlist」双闸保证；
//   2. 每个 span 必带 chatKey/roundId（缺了就地告警一次，键仍然在行里）；
//   3. ledger() 追加幂等安全（不去重、不抛错；去重是调用方的活）；
//   4. 任何写失败都不许抛给主流程 —— 本文件里所有出口都不抛（configure 除外，
//      它是启动期编程错误，应当 fail fast 而不是静默写进真实 data/）。

import path from 'node:path';
import { createSink, RETENTION_DAYS, MAX_FILE_BYTES } from './sink.js';
import { createLogger } from './logs.js';
import {
  LEDGER_NAMES, STREAM_NAMES, TTFT_STAGES,
  buildLedgerRow, buildSpanRow, buildEventRow, isLedgerName, isStreamName
} from './ledgers.js';
import { safeId, enumCoercions, resetEnumCoercions, schemaDrops, resetSchemaDrops } from './sanitize.js';
import {
  recordPhase, timeSync, timeAsync, recordGcPause, phaseStats, gcPauseEvents,
  phaseSpikeEvents, phaseSpikeMinMs, phaseRingLimit, ttftStats, resetPhases
} from './phases.js';
import { on, once, off, emit, setBusWarn, listenerCount, busStats, resetBus } from './bus.js';
// ★ 2026-10-17（时间统一）：core 内**唯一**的"绝对毫秒"判据（数字/纯数字串/Date/带时区 ISO；
//   非法 ⇒ null）。用量清零过滤、日统计窗口、分片归属、trace 的 sent.at 都用它 —— 与上层
//   `modules/llm/model-prices.js:toEpochMs` 同口径，但**不反向依赖** modules。
import { parseEpochMs } from './time.js';
import {
  createTurnTrace, startTurnStage, finishTurnStage, recordTurnAction, finishTurnTrace,
  classifyTurnLane, summarizePromptStructure, buildOutcomeMatrix, receiptCount, traceSummary,
  TRACE_ENUMS
} from './trace.js';
// ★ 2026-10-16（调试清零）：用量统计的**持久清零边界**。上面那六个冻结出口一字未动，
//   本模块只在它们旁边多三个出口；边界只影响"统计从哪算起"，原始账本/预算一律不碰。
import {
  readUsageResetBoundary,
  writeUsageResetBoundary as writeUsageResetBoundaryFile,
  applyUsageResetBoundary
} from './usage-reset.js';

const MAX_TRACES = 200;
const MAX_SPAN_STACK = 64;
const MAX_SENT_PER_TRACE = 32;         // 一轮发不出这么多条；上限只防"调用方跑偏"

const cfg = { dataDir: null, obsDir: null, allowRealData: false, retentionDays: RETENTION_DAYS, maxFileBytes: MAX_FILE_BYTES };
let sink = createSink({ obsDir: null });
let sinkLogger = createLogger({ obsDir: null, mirrorConsole: true });
const traces = new Map();          // `${chatKey}|${roundId}` -> turnTrace
const spanStack = [];              // 当前打开的 span（嵌套即栈）
const warnedOnce = new Set();

function warnOnce(key, text) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  try { sinkLogger.warn('observability', text); } catch { /* 观测不许反噬 */ }
}

function traceKey(chatKey, roundId) { return `${chatKey || ''}|${roundId || ''}`; }

function currentTrace(chatKey, roundId) {
  const key = traceKey(chatKey, roundId);
  const hit = traces.get(key);
  if (hit) return hit;
  if (traces.size >= MAX_TRACES) {
    const oldest = traces.keys().next().value;
    if (oldest !== undefined) traces.delete(oldest);
  }
  const created = createTurnTrace({});
  created.chatKey = safeId(chatKey, 160, '');
  created.roundId = safeId(roundId, 160, '') || null;
  traces.set(key, created);
  return created;
}

/**
 * 配一次观测。**必须显式传 dataDir**（落盘到 `<dataDir>/obs/`）。
 * 传 `data` / `data-2` 这类真实数据目录名会被拒（除非 allowRealData:true）——
 * 这是"测试绝不碰真实 data/"的一道机械保险，不靠人记。
 */
export function configure({ dataDir = null, obsDir = null, allowRealData = false, mirrorConsole = true, level = 'info', retentionDays = RETENTION_DAYS, maxFileBytes = MAX_FILE_BYTES } = {}) {
  const resolved = obsDir
    ? path.resolve(obsDir)
    : (dataDir ? path.join(path.resolve(dataDir), 'obs') : null);
  if (resolved && !allowRealData) {
    // 路径里**任何一段**叫 data / data-2 … 一律拒：只查 basename 会漏掉
    // `dataDir=<repo>/data` → obsDir=<repo>/data/obs 这种最常见的真实盘面。
    const real = path.resolve(resolved).split(/[\\/]/).find((seg) => /^data(-\d+)?$/i.test(seg));
    if (real) {
      throw new Error(`[obs] refusing to write under real data dir ("${real}") — obs root: ${resolved} (pass allowRealData:true if that is really intended)`);
    }
  }
  cfg.dataDir = dataDir ? path.resolve(dataDir) : null;
  cfg.obsDir = resolved;
  cfg.allowRealData = !!allowRealData;
  // 保留期 / 单文件容量上限是**配置项**（默认值取常量，来自 src/decision-ledger.js 的 14 天 / 16MB），
  // 不是写死的数字 —— 复核指出「把 cutoff 改成 0（永不删旧文件）自测仍全绿」，
  // 根因就是它此前既不可配、也没有任何断言能看见。现在两条都在 selftest 里有牙。
  cfg.retentionDays = Number.isFinite(Number(retentionDays)) ? Math.max(0, Math.round(Number(retentionDays))) : RETENTION_DAYS;
  cfg.maxFileBytes = Number.isFinite(Number(maxFileBytes)) ? Math.max(4096, Math.round(Number(maxFileBytes))) : MAX_FILE_BYTES;
  sink = createSink({
    obsDir: resolved,
    retentionDays: cfg.retentionDays,
    maxFileBytes: cfg.maxFileBytes,
    onWarn: (line) => { try { sinkLogger.warn('observability.sink', line.slice(0, 200)); } catch { /* ignore */ } }
  });
  sinkLogger = createLogger({ obsDir: resolved, mirrorConsole, level });
  setBusWarn((line) => { try { sinkLogger.warn('observability.bus', line.slice(0, 200)); } catch { /* ignore */ } });
  traces.clear();
  spanStack.length = 0;
  return { dataDir: cfg.dataDir, obsDir: cfg.obsDir, retentionDays: cfg.retentionDays, maxFileBytes: cfg.maxFileBytes };
}

export function obsConfig() { return { ...cfg }; }

/* ───────────────────────── span（首字延迟分段，可嵌套） ───────────────────────── */

/**
 * 开一个分段。返回的 handle 只有一个 `end(extra)`。
 *   const a = span('queue', { chatKey, roundId });
 *   const b = span('memory', { chatKey, roundId });   // 嵌套
 *   b.end(); a.end({ status:'ok' });
 * 结束顺序乱了（先 end 外层）也不会崩：栈按 id 摘除，多余的 end 直接忽略。
 */
export function span(name, fields = {}) {
  const label = safeId(name, 48, '');
  if (!label) warnOnce(`span-name:${String(name)}`, `span name rejected (non-ASCII or empty): ${String(name).slice(0, 40)}`);
  const spanName = label || 'unknown';
  const chatKey = safeId(fields?.chatKey, 160, '');
  const roundId = safeId(fields?.roundId, 160, '');
  if (!chatKey || !roundId) warnOnce('span-context', 'span() called without chatKey/roundId; §3.3 requires both on every span');

  const id = sink.newRowId();
  const depth = spanStack.length;
  if (spanStack.length >= MAX_SPAN_STACK) spanStack.length = MAX_SPAN_STACK - 1;   // 栈深上限，防漏 end 打爆内存
  const token = startTurnStage(currentTrace(chatKey, roundId), spanName, {
    round: null, attempt: fields?.attempt ?? null, startedAt: Date.now()
  });
  const parentId = spanStack.length ? spanStack[spanStack.length - 1].id : '';
  const handle = { id, name: spanName, chatKey, roundId, startedAt: Date.now() };
  spanStack.push(handle);

  let ended = false;
  return {
    id,
    name: spanName,
    chatKey,
    roundId,
    /** 结束本段：算耗时 → 落 spans 流 → 记 phase 统计 → 通知 bus。永不抛。 */
    end(extra = {}) {
      if (ended) return null;
      ended = true;
      const at = spanStack.findIndex((item) => item.id === id);
      if (at >= 0) spanStack.splice(at, 1);
      const endedAt = Date.now();
      const durationMs = Math.max(0, endedAt - handle.startedAt);
      const stage = finishTurnStage(currentTrace(chatKey, roundId), token, {
        status: extra?.status ?? 'ok', code: extra?.code ?? '', meta: extra?.meta ?? null
      });
      const row = buildSpanRow({
        at: handle.startedAt,
        rowId: sink.newRowId(),
        correlationId: safeId(extra?.correlationId, 36, '') || null,
        chatKey,
        roundId,
        idempotencyKey: safeId(extra?.idempotencyKey, 200, '') || null,
        name: spanName,
        parentId,
        depth,
        endedAt,
        durationMs: extra?.durationMs ?? durationMs,
        status: stage?.status ?? 'ok',
        attempt: extra?.attempt ?? null,
        messageCount: extra?.messageCount ?? null,
        phaseIndex: extra?.phaseIndex ?? null
      }, { rowId: sink.newRowId() });
      recordPhase(spanName, row.durationMs ?? durationMs);          // TTFT 五段直接进 phaseStats
      sink.append('spans', row);
      emit('span', row);
      emit(`span.${spanName}`, row);
      return row;
    }
  };
}

/* ───────────────────────── event ───────────────────────── */

/**
 * 结构化事件（trace 行）。kind 走 ASCII 闸；未知键直接丢。永不抛。
 *
 * ★ T-BUS-LOOP 第三个参数 `{ echo }`：
 *   `echo` **只**控制"这一行要不要被回灌到 bus"（`emit(eventKind, row)` + `emit('event', row)`）。
 *   · **默认 `echo: true` = 旧行为一字不改** —— 别的调用方可能依赖"记一行就广播出去"，
 *     改默认等于另一场回归，所以这里只加可选开关、不动默认路径。
 *   · `echo: false` = **只落账本，不产生任何新 bus 事件**。
 *
 *   为什么需要它（2026-10-05 实测）：`apps/server/assembly.js:407-411` 为了把 9 个冻结事件名记进
 *   账本，订了 `obs.on(kind, payload => obs.event(kind, payload))`。而本函数第 209 行会把刚建好的行
 *   **再 emit 回同一条 bus**，于是命中 assembly 刚注册的那个订阅者 ⇒ 递归 ⇒
 *   **一次 `bus.emit` 扇出 1763 行账本 + 1763 层递归**（实测，见 `.tmp-dispatch/busloop-baseline.mjs`），
 *   递归爆栈还被 `bus.js:44-49` 的 per-subscriber `catch` **静默吞掉** ⇒ 不崩、不报、没人知道。
 *   装配层改用 `{ echo: false }` 之后，"记录"不再制造"新的业务总线事件"，账本也照样有行
 *   （票面明令：不许改成"装配层干脆不订阅"，那是用消失换安静）。
 *
 * @param {string} kind
 * @param {object} [fields]
 * @param {{ echo?: boolean }} [opts] - `echo:false` ⇒ 只记录不回灌
 * @returns {object|null}
 */
export function event(kind, fields = {}, { echo = true } = {}) {
  const eventKind = safeId(kind, 48, '');
  if (!eventKind) { warnOnce('event-kind', `event kind rejected: ${String(kind).slice(0, 40)}`); return null; }
  const row = buildEventRow({
    // ★★ N81（2026-10-10 · qwen2）：这里原来是**手挑 13 个键**逐个 safeId 过一遍，等于在
    //   `ledgers.js` 的 EVENT_SCHEMA 之外**又叠了一道白名单**，两道名单必须靠人肉同步。
    //   实测代价就是 luna1 报的那条：`orchestrator/index.js:2142` 发的 `itemCount` 在这里被丢掉
    //   （同批被吃的还有 ok/platformId/evidenceId/action/reason/signal/tier/decision/reasonCode，
    //    逐个 file:line 见 ledgers.js EVENT_FIELDS 的补注）。
    //   ⇒ 现在**只留 schema 一道名单**。§3.3 的防走私不变量**一字未动**：
    //     `buildRow` 仍旧**只遍历 schema 的键**，`text`/`content`/`prompt`/`messages`/`toolArgs`/`toolResult`
    //     这些不在 schema 里的键**连读都不会被读到**；进了名单的值仍旧逐个过 coerce 的 ASCII/枚举闸。
    //     （selftest 有一组断言专门钉这两件事：加了字段不等于正文能落盘。）
    //   ★ 原先那串 `safeId(...) || null` 里，id 类是**空忙**（coerce 对 null/undefined 本来就回落 `''`），
    //     但 `count`/`ms` 那四列是**真差异**：旧写法把缺席写成 `null` 传进去，`safeCount(Number(null)=0)`
    //     ⇒ 落盘成 **0**；现在不传 ⇒ 落 **null**。实测见 `.tmp-dispatch/_n81_equiv.mjs`（7 个用例，5 个有差异，
    //     差异**只有这四列的"缺席"表示**：`durationMs/attempt/count/messageCount` 旧 0 → 新 null；
    //     键集一个没少，正文一个没多）。**这是修对了**：`sanitize.js` 里 `bool` 那一栏写的就是同一口径
    //     ——"没测"和"0/false"不是一回事，不许混。selftest 有牙钉住这条（★N81-⑦）。
    //     ⚠ 消费侧已核：全仓读 events 流的只有 `apps/ui/app.js:47` 一个视图名标签，没有任何地方按
    //     `count === 0` 判定事件行（那几处 `count === 0` 读的是 send 回执/sessions，不是事件行）⇒ 无影响面。
    //   ★ `kind` 仍旧由 event 名强制覆盖（放最后）⇒ 调用方传 `kind` 不会顶掉事件名；
    //     但 `wake:suppressed`/`plan:decided` 传的 `kind: allow.kind`（group/private）**会被事件名吃掉**，
    //     那是**调用点撞名**，改法在记录侧（建议改名 `subjectKind`），本票已报指挥位转 luna1。
    ...fields,
    at: Date.now(),
    rowId: sink.newRowId(),
    kind: eventKind
  }, { rowId: sink.newRowId() });
  if (!row) return null;
  sink.append('events', row);
  // ★ 回灌点。echo=false 时**一个 bus 事件都不产生**（记录不再制造新流量）。
  //   默认 true 保持旧行为不变 —— 这两行只被这一个 if 包起来，语义与改动前完全一致。
  if (echo) {
    emit(eventKind, row);
    emit('event', row);
  }
  return row;
}

/* ───────────────────────── ledger ───────────────────────── */

/**
 * 追加一行账本。**幂等安全**：同一 idempotencyKey 写两次就是两行，不去重、不抛错
 * （去重是调用方按 idempotencyKey 做的）。返回落盘行（便于调用方/测试核对），
 * 未知账本名返回 null。
 */
export function ledger(name, row = {}) {
  const ledgerName = String(name ?? '');
  if (!isLedgerName(ledgerName)) {
    warnOnce(`ledger-name:${ledgerName.slice(0, 24)}`, `unknown ledger name rejected: ${ledgerName.slice(0, 40)} (allowed: ${LEDGER_NAMES.join('|')})`);
    return null;
  }
  const out = buildLedgerRow(ledgerName, row, { rowId: sink.newRowId() });
  if (!out) return null;
  sink.append(ledgerName, out);
  emit('ledger', { name: ledgerName, row: out });
  emit(`ledger.${ledgerName}`, out);
  return out;
}

/* ───────────────────────── recent（只读） ───────────────────────── */

/**
 * 只读查看最近 n 行。异步（读盘）；name ∈ LEDGER_NAMES | 'spans' | 'events' | 'log'。
 * 'log' 走内存环形缓冲（日志按天落的是 .log 文件，不进 ndjson 流）。
 */
export async function recent({ name, n = 50 } = {}) {
  const stream = String(name ?? '');
  if (stream === 'log') return sinkLogger.recent(n);
  if (!isStreamName(stream)) {
    warnOnce(`recent-name:${stream.slice(0, 24)}`, `recent() unknown stream: ${stream.slice(0, 40)} (allowed: ${STREAM_NAMES.join('|')})`);
    return [];
  }
  return sink.read(stream, n);
}

/**
 * ★ 2026-10-17（消费方要能说清"这份数据到底全不全"）：与 `recent` **同一次扫描**，额外带回边界元信息。
 *
 * 形状（与 `core/observability/sink.js` 的 `readWithMeta` 完全一致，消费方一套判断即可）：
 *   `{ rows, meta: { requested, limit, returned, bytesRead, hasMore, byteLimitReached,
 *                     oversizedLines, malformedRows, ioErrors, truncated, reason, source } }`
 * 语义要点（写在这里免得被误用）：
 *   · `hasMore` = 达到**行数上限**（流里可能还有更旧的行）——**不算** `truncated`，两者别混成一句"完整/不完整"；
 *   · `truncated` = 本次扫描真的不完整（字节预算、IO 失败、异常长行、内存环/日志环已满）；
 *   · meta 是**本次调用的返回值**（没有全局 lastRead）⇒ 并发两路各拿各的，不会互相顶掉；
 *   · `recent()` 一字未动（只回 rows），两条路共用同一次扫描，不扫两遍。
 */
export async function recentWithMeta({ name, n = 50 } = {}) {
  const stream = String(name ?? '');
  const requested = Number(n);
  if (stream === 'log') {
    const ringMax = typeof sinkLogger.ringMax === 'number' ? sinkLogger.ringMax : 500;
    const rows = sinkLogger.recent(n);
    const full = Array.isArray(rows) && rows.length >= ringMax;
    return { rows, meta: {
      requested, limit: ringMax, returned: Array.isArray(rows) ? rows.length : 0, bytesRead: 0,
      hasMore: full, byteLimitReached: false, oversizedLines: 0, malformedRows: 0, ioErrors: 0,
      truncated: full, reason: full ? 'log-ring' : '', source: 'memory-log-ring'
    } };
  }
  if (!isStreamName(stream)) {
    warnOnce(`recent-name:${stream.slice(0, 24)}`, `recent() unknown stream: ${stream.slice(0, 40)} (allowed: ${STREAM_NAMES.join('|')})`);
    return { rows: [], meta: {
      requested, limit: 2000, returned: 0, bytesRead: 0, hasMore: false, byteLimitReached: false,
      oversizedLines: 0, malformedRows: 0, ioErrors: 0, truncated: true, reason: 'unknown-stream', source: 'none'
    } };
  }
  return sink.readWithMeta(stream, n);
}

/** 当地自然日 usage token 总量；`truncated=true` 表示账本不完整，调用方不得将部分和当作真实总量。 */
export async function dayTokenTotal({ at = Date.now() } = {}) {
  return sink.dayTokenTotal({ at });
}

/** 等落盘队列排空（测试与"刚发生就想查到"的场景用；主链不该 await 它）。 */
export async function flush() { await sink.flush(); }

/* ───────────────────────── 用量清零边界（调试清零 · 2026-10-16） ───────────────────────── */

/**
 * 读**持久**清零边界（`<obsDir>/usage-reset.json`）。所有用法统计（用量页 / 顶栏 /
 * 分天 / 按会话 / 按模型 / breakdown）都以它为准 —— 清零后从边界重新累计，重启不复活。
 * 详见 `usage-reset.js` 文件头（三条纪律：持久 / 不假成功 / 读不到要如实说）。
 */
export async function usageResetStatus() {
  return readUsageResetBoundary({ obsDir: cfg.obsDir });
}

/**
 * 写清零边界（原子写 + 写后校验）。**失败必须让调用方如实报失败** ——
 * 没有落盘目录、写失败、校验不符都会返回 `{ok:false, error}`，绝不返回成功。
 */
export async function writeUsageResetBoundary({ at = Date.now(), note = '' } = {}) {
  return writeUsageResetBoundaryFile({ obsDir: cfg.obsDir, at, note, reason: 'debug-reset' });
}

/**
 * 按清零边界过滤 usage 行（调用方：`/api/usage/stats`、`/api/usage/breakdown`、`/api/status`）。
 * 返回 `{rows, boundary}`；`boundary.state !== 'ok'` 时行**原样返回**、状态带出去由上层显示
 * （`invalid`/`unreadable` 不许静默当成"没有边界"）。
 */
export async function usageRowsSinceReset(rows) {
  const boundary = await readUsageResetBoundary({ obsDir: cfg.obsDir });
  return applyUsageResetBoundary(rows, boundary);
}

/* ───────────────────────── log ───────────────────────── */

export function log(level, msg, fields) {
  const fn = { debug: sinkLogger.debug, info: sinkLogger.info, warn: sinkLogger.warn, error: sinkLogger.error }[level] || sinkLogger.info;
  const entry = fn('observability', msg, fields);
  emit('log', entry);
  return entry;
}

/* ───────────────────────── logger 兼容别名（§3.5 冻结；消费者 apps/desktop/main.js:9） ───────────────────────── */

/**
 * 旧 `src/logger.js` 的文本拼法，逐字照抄（`#writeInner` 里的那段）：
 * Error → message+stack；普通对象 → JSON.stringify；其余 → String；空格 join。
 * 之所以要抄：**旧签名是 `(module, ...args)` 变参**，而本模块 §3.3 的 `log(level,msg,fields)`
 * 是三参定形。若把 main.js 的 `logger.info('app', 真正的话)` 直接映射到新签名，
 * 真正的话会掉进 `fields` 位被 `safeFields` 丢掉 —— **静默丢日志**，最坏的一种坏。
 */
function compatText(args) {
  return args.map((a) => {
    if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
    if (typeof a === 'object' && a !== null) { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(' ');
}

/**
 * 兼容别名 `logger` —— 形状对齐旧 `src/logger.js` 的 `logger` 单例（只读对照见下）。
 * ★ 必须**转发**而不是直接持有实例：configure() 会重建底层 sinkLogger。
 *
 * 方法清单（与 src/logger.js 的 Logger 实例逐个对齐）：
 *   debug/info/warn/error(module, ...args)  ← 旧签名（变参），已按 compatText 拼文本
 *   setLevel(level) / getLevel() / onLog(fn) / recent(limit) / prune()
 *   mirrorConsole（可读写属性）← 旧 public 字段；apps/desktop/main.js:511 与 :1721 都在写它
 *   flush()  ← **旧版没有**，新增：排空日志写队列（主链不该 await）
 *
 * 差异与缺口（点名，不许调用点踩）：
 *   · `child()`：**旧版没有 child()，本版也没有 —— 谁都别调**（会拿到 undefined）。
 *   · `fileSinkStatus()`：旧版是**模块级函数**，本版以同名导出提供（读数形状不同：
 *     旧版返回 {ok,failCount,lastError,firstFailAt,lastFailAt,file,pruneRuns}；
 *     本版返回同样 7 个键，但 `file` 为空串时表示未落盘 —— 无 obsDir 的纯内存模式）。
 *   · `prune()`：旧版还做"单文件 >256MB 截断保留尾部"，**本版只删过期文件，不做大文件截断**
 *     （未实现，见回执「无牙/未核」）。调用点 `logger.prune?.()` 语义仍成立。
 *   · `setLevel()` 返回自身（旧版返回 undefined）；只影响链式写法，不影响调用点。
 */
export const logger = {
  debug: (module, ...args) => sinkLogger.debug(module, compatText(args)),
  info: (module, ...args) => sinkLogger.info(module, compatText(args)),
  warn: (module, ...args) => sinkLogger.warn(module, compatText(args)),
  error: (module, ...args) => sinkLogger.error(module, compatText(args)),
  setLevel(level) { sinkLogger.setLevel(level); return logger; },
  getLevel() { return sinkLogger.getLevel(); },
  onLog(fn) { return sinkLogger.onLog(fn); },
  recent(limit) { return sinkLogger.recent(limit); },
  prune() { return sinkLogger.prune(); },
  flush() { return sinkLogger.flush(); },
  get mirrorConsole() { return sinkLogger.mirrorConsole; },
  set mirrorConsole(value) { sinkLogger.mirrorConsole = value; }
};

/** 旧 `src/logger.js` 的模块级读数口同名导出（apps 侧排障用）。 */
export function fileSinkStatus() { return sinkLogger.sinkStatus(); }

/* ───────────────────────── 其它只读出口（搬 src/ 的读数口） ───────────────────────── */

export function beginTurn({ chatKey, roundId, lane, source, contextTier = null, batchId = null, authority = null } = {}) {
  const key = traceKey(safeId(chatKey, 160, ''), safeId(roundId, 160, ''));
  const created = createTurnTrace({ lane, source, contextTier, batchId, authority });
  created.chatKey = safeId(chatKey, 160, '');
  created.roundId = safeId(roundId, 160, '') || null;
  traces.set(key, created);
  if (traces.size > MAX_TRACES) {
    const oldest = traces.keys().next().value;
    if (oldest !== undefined && oldest !== key) traces.delete(oldest);
  }
  return created;
}

export function turnTrace(chatKey, roundId) { return traces.get(traceKey(chatKey, roundId)) || null; }

export function finishTurn(chatKey, roundId, outcome = 'ok') {
  const t = turnTrace(chatKey, roundId);
  if (!t) return null;
  const done = finishTurnTrace(t, outcome);
  done.sentCount = receiptCount(t.sent).sentCount;
  // ★ D-2 B：`receipt` 也是 UI 读的键（apps/ui/app.js 追踪头部「实际发送 N 条（类型）」）。
  //   原先这里只算 sentCount 就丢了 ⇒ trace.receipt 恒为 createTurnTrace 里的 null。
  done.receipt = receiptCount(t.sent);
  emit('turn.finish', traceSummary(done));
  return done;
}

/**
 * 记一条**真实发出**的东西（§0 铁律 6：以平台回执为准 ⇒ 只有拿到回执才记）。
 * 不复制正文，只留类型与时刻（`receiptCount` 据此算「发了几条、都是什么」）。
 * @param {string} chatKey @param {string} roundId
 * @param {{type?: string, at?: number}} item
 */
export function recordSent(chatKey, roundId, item = {}) {
  const t = turnTrace(chatKey, roundId);
  if (!t) return null;
  if (!Array.isArray(t.sent)) t.sent = [];
  t.sent.push({
    type: safeId(item?.type, 16, 'unknown') || 'unknown',
    // ★ 2026-10-17（时间统一）：与用量行/边界同一份解析（数字/纯数字串/Date/带时区 ISO ⇒ 绝对毫秒；
    //   null/空/非法 ⇒ null）——旧版 `Number(item.at)` 会把 ISO 记成 null。
    at: parseEpochMs(item?.at)
  });
  if (t.sent.length > MAX_SENT_PER_TRACE) t.sent.splice(0, t.sent.length - MAX_SENT_PER_TRACE);
  t.receipt = receiptCount(t.sent);      // 立刻可见：中途读 trace（面板轮询）也要拿到数
  return t.receipt;
}

export function recordAction(chatKey, roundId, fields = {}) {
  const t = turnTrace(chatKey, roundId);
  return recordTurnAction(t, fields);
}

export function stats() {
  return {
    config: obsConfig(),
    sink: sink.stats(),
    bus: busStats(),
    phases: phaseStats(),
    logs: sinkLogger.sinkStatus(),
    openSpans: spanStack.length,
    traces: traces.size,
    // ★ N45：白名单外被静默改写/丢弃的枚举值计数。`total > 0` 就是**有码被吃掉了**，
    //   查 `rows` 直接看到是哪个字段、什么值、被换成了什么 —— 不用再靠人扫写入点。
    enumCoercions: enumCoercions(),
    // ★★ N81：另一半边盲区 —— **整个键**不在 schema 名单里 ⇒ 连读都不读、静默消失。
    //   `total > 0` 就是"有人在发一个落不了盘的字段"（今晚的 `itemCount` 就是这么没的）。
    //   这张表**只有键名、没有值**（非 ASCII 的键名归到 `nonAsciiKeys` 只数次数），
    //   所以它不可能变成正文的第二条落盘通道 —— 与上面 N45 那段同一口径。
    schemaDrops: schemaDrops()
  };
}

export function onLog(fn) { return sinkLogger.onLog(fn); }
export function logRecent(limit) { return sinkLogger.recent(limit); }
export function pruneLogs() { return sinkLogger.prune(); }
export function resetForTest() {
  sink = createSink({
    obsDir: cfg.obsDir,
    retentionDays: cfg.retentionDays,
    maxFileBytes: cfg.maxFileBytes,
    onWarn: (line) => { try { sinkLogger.warn('observability.sink', line.slice(0, 200)); } catch { /* ignore */ } }
  });
  sinkLogger = createLogger({ obsDir: cfg.obsDir, mirrorConsole: false });
  setBusWarn((line) => { try { sinkLogger.warn('observability.bus', line.slice(0, 200)); } catch { /* ignore */ } });
  traces.clear(); spanStack.length = 0; warnedOnce.clear(); resetPhases(); resetBus();
  resetEnumCoercions();
  resetSchemaDrops();
}

export {
  on, once, off, emit, listenerCount, busStats,
  // ★ 2026-10-17（时间统一）：core 公开的"绝对毫秒"解析 —— 别的模块只能 import 本文件（§4），
  //   上层要判 `at` 是否可定位就用它，别再各自 `Number(at)`。
  parseEpochMs,
  recordPhase, timeSync, timeAsync, recordGcPause, phaseStats, gcPauseEvents,
  phaseSpikeEvents, phaseSpikeMinMs, phaseRingLimit, ttftStats,
  createTurnTrace, startTurnStage, finishTurnStage, recordTurnAction, finishTurnTrace,
  classifyTurnLane, summarizePromptStructure, buildOutcomeMatrix, receiptCount, traceSummary,
  TTFT_STAGES, LEDGER_NAMES, STREAM_NAMES, isLedgerName, isStreamName,
  enumCoercions, resetEnumCoercions, schemaDrops, resetSchemaDrops, TRACE_ENUMS
};
