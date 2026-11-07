// 三类账本（+ 发送回执）+ span/event 的**字段白名单**。
//
// 全部搬自 src/ 的枚举口径（decision-ledger.js / usage-ledger.js / jev-observer.js），
// 目的不是"字段更少"，而是让"哪些字段能落盘"变成**一件事**：
// 调用方传再多键，落盘的行只会有 schema 里这些键，且每个键都要过 ASCII 闸。
//
// 允许落盘的四类内容（README §3.3 不变量的具体化）：
//   结构字段（枚举/标识符）· 计数 · 耗时 · 标签 · 证据 ID
// 明确**不允许原文**：text / content / prompt / completion / messages / quoted /
// toolArgs / toolResult / summary —— 这些键不在任何 schema 里，连读都不会被读到。
// 模型工具观测仅开放 argumentFacts/resultBytes/resultHash 等派生摘要；参数值和结果正文
// 一律不落盘。usage.perCallUsage 与 usage.modelCallTrace 是有条数上限的明细结构，
// 只开放计数、用途、短原因码与前缀指纹；缓存计数缺失时落 null，不能补零或估算。
// 即使是隔离测试，也使用相同规则，避免生产实例因调用场景不同而泄露正文。

import { buildRow, MAX_MODEL_CALL_TRACE_ROWS, MAX_PER_CALL_USAGE_ROWS } from './sanitize.js';

const LANES = new Set(['addressed', 'topic_follow', 'free_interjection', 'proactive', 'scheduled', 'ambient']);
const SOURCES = new Set([
  'fallback', 'preflight', 'schedule', 'proactive_opportunity', 'topic_continuity',
  'topic_continuity_rule', 'jev_gate', 'probability_gate', 'direct_address', 'keyword',
  'direct_request', 'private_keyword', 'private_request', 'private_reply',
  'private_recent_followup', 'private_media', 'private_addressed', 'private_policy',
  'private_empty_or_reaction', 'private_non_request', 'all_messages_policy',
  // ★ 2026-10-06 W1 白名单入站门：不在表里的值会被 buildRow 静默改写成 'other'
  'allow_list_policy'
]);
const DECISIONS = new Set([
  'speak', 'defer', 'skip', 'gate_open', 'candidate_delivered', 'actually_spoke',
  'llm_silent', 'llm_error'
]);
const REASONS = new Set([
  'unknown', 'paused', 'chat_busy', 'model_missing', 'self_muted', 'global_concurrency',
  'incoming_preempted_proactive', 'batch_already_consumed', 'late_gate_result',
  'jev_unevaluated_retry', 'unevaluated_dropped', 'jev_yes', 'jev_no_hard', 'intent_miss',
  'jev_no_soft', 'prefilter_shortcut', 'jev_abstain', 'quota_chat', 'jev_rejected',
  'probability_miss', 'session_setup_retry', 'session_setup_dropped', 'candidate_delivered',
  'receipt_sent', 'llm_unevaluated_retry', 'llm_unevaluated_dropped', 'llm_silent_no_tool',
  'late_session_error', 'llm_error', 'topic_continue_rule', 'topic_continuity_rule',
  'direct_request', 'direct_address', 'keyword', 'private_keyword', 'private_request',
  'private_reply', 'private_recent_followup', 'private_media', 'private_addressed',
  'private_non_request', 'private_policy', 'private_empty_or_reaction', 'all_messages_policy',
  // ★ 2026-10-05 指挥位补（口径：旧树 UI 自己的 reasonNames/routeLane/routeReasonCode 就是契约）：
  //   上面的词表漏了旧树**真实会发**的这几个码，而 `buildRow` 对不在表里的值会静默 fallback 成
  //   `'other'`（ledgers.js:76）⇒ 当事人看到的是"其它"，排查时查不到真原因。
  //   最先撞上的是 `tier_restricted`：主人报"开了仅@的群还一直说"，luna1 的档位门落了这个码，
  //   结果被这张表改写掉 —— 一个**静默改写**的枚举表比报错更危险（信息没了还不报错）。
  //   出处逐个可查：`tier_restricted`/`free_interjection` 旧 `src/orchestrator.js:816`，
  //   其余在旧 UI 的 `reasonNames`（新树同款 `refactor/apps/ui/app.js:11156`）。
  'tier_restricted', 'free_interjection', 'topic_pause', 'quota', 'probability_hit',
  'jev_speak', 'jev_error', 'jev_unavailable', 'jev_no', 'llm_silent', 'topic_continue',
  // ★ 2026-10-06 W1：白名单入站门的拒绝码（同上口径——不在表里会被静默写成 'other'，
  //   主人就分不清是档位门拦的还是白名单拦的）。
  'allow_not_listed',
  // ★ 2026-10-09 00:3x 指挥位补（来源：A32 的枚举体检，gemini pro 逐个比对写入点得出 19 个）：
  //   这些是 `plan/index.js` 与 `compose.js` **真实会产出**的 reasonCode，本表原来一个都没有
  //   ⇒ 一律被 `buildRow` 静默改写成 `'other'`。**这就是"私聊为什么不回"根本查不出来的原因**
  //   （A33 只看到"skip 行没有原因字段"，其实是原因被这张表吃掉了），也是 A30 量不出漏率的一半。
  //   出处：`refactor/modules/plan/index.js`。
  'NO_EVIDENCE', 'PRIVATE_RULE', 'DIRECT_MENTION', 'PROMISE_FOLLOWUP', 'BOT_QUESTION_ANSWER',
  'TOPIC_FOLLOW', 'DIRECT_QUESTION', 'JEV_CANDIDATE_LOW', 'INTENT_ZERO', 'HARD_COOLDOWN',
  'HARD_HOURLY_CAP', 'FREE_TOPIC_SWITCH',
  //   出处：`refactor/modules/orchestrator/compose.js`。
  'COMPOSE_TOOL_LOOP', 'COMPOSE_OUTPUTS_MISSING', 'COMPOSE_ABORTED', 'COMPOSE_SILENT',
  'COMPOSE_GUARD', 'COMPOSE_BODY_INTERNAL', 'COMPOSE_EMPTY',
  // ★ 2026-10-09 N36（qwen2）枚举回对补：**同一类病第二次复发** —— 上面 00:3x 那批补了 19 个码，
  //   但 `plan/index.js` 还有 5 个**真实会产出**的码没进表 ⇒ 仍被静默改写成 'other'。
  //   逐个实查（不是猜的）：
  //     'PROACTIVE_SCHEDULE' / 'PROACTIVE_RANDOM' / 'PROACTIVE_OPPORTUNITY' ← plan/index.js:226-227
  //       （三元表达式按 proactiveReason 产出，**不在任何 makePlan('…','CODE') 字面里** ⇒
  //        只 grep makePlan 的写法一定漏掉这三个，00:3x 那批大概就是这么漏的）
  //     'INTENT_MISS'      ← plan/index.js:330（自由插话候选未达意愿阈值）
  //     'FREE_INTERJECTION'← plan/index.js:333（**同一行**的另一个分支 'FREE_TOPIC_SWITCH' 在表里，
  //                            这一个不在 ⇒ 一行代码两个分支，一个能查一个被吃掉）
  //   流向已核：plan.reason → orchestrator/index.js:1910 `reasonCode = String(run.turnPlan.reason).split(':')[0]`
  //     → :1914 run.planDecisionLedger → :814 recordDecisionLedger → decisionComposeReasonCode(:756-775)
  //     在 outcome 为空/已投递时**原样返回** run.planDecisionLedger.reasonCode ⇒ 确实到得了台账。
  //   ⚠ 大小写敏感：表里已有的小写 'intent_miss' / 'free_interjection' 是**老树的码**，
  //     与这两个大写码不是同一个值，Set 不会替你合并 ⇒ 两种都得留着。
  //   ★ 这个 bug 在日志里是**看得见**的：orchestrator/index.js:826-830 会打
  //     `model-decision-reason-normalized`（带 reasonCode 与 persistedReasonCode）⇒
  //     补表之前，用户的 obs 日志里应该能 grep 到这 5 个码被改写成 'other' 的记录，可用来复核本票。
  'PROACTIVE_SCHEDULE', 'PROACTIVE_RANDOM', 'PROACTIVE_OPPORTUNITY', 'INTENT_MISS', 'FREE_INTERJECTION',
  // ★ 2026-10-13 N45-② 补（mimo3）：由 J/F 判定块引入，见 `plan/index.js:271-336` —— 17 个唯一码 / 20 处调用点，
  //   仍在用、无废弃。N45-② 检查未改。
  'JUDGE_NOT_CALLED', 'JUDGE_UNAVAILABLE', 'JUDGE_CONTINUE', 'JUDGE_JOIN', 'JUDGE_JOIN_NO',
  'JUDGE_JOIN_UNKNOWN', 'JUDGE_NO_CANDIDATE', 'JUDGE_TOPIC_CHANGED', 'JUDGE_TOPIC_NA',
  'JUDGE_CONTINUE_UNKNOWN', 'FOCUS_NOT_TARGET', 'FOCUS_NOT_RELEVANT', 'FOCUS_TOPIC_PASSED',
  'FOCUS_JUDGE_UNKNOWN', 'FOCUS_MENTION_MUST_REPLY', 'FOCUS_KEYWORD_MUST_REPLY', 'FOCUS_MOVED'
]);
const AUTHORITIES = new Set(['probabilistic', 'quiet', 'must_reply', 'model_decides', 'rule_continue', 'unknown', 'other']);
const MODEL_OUTCOMES = new Set(['empty', 'text_only', 'tool_calls', 'error', 'timeout']);
const POLICY_OUTCOMES = new Set(['blocked', 'error', 'other']);
const BLOCK_REASONS = new Set(['tool_hook', 'text_only_judge', 'narration_guard', 'tool_error', 'other']);
// usage 顶层 purpose（★ 2026-10-17 · 473d331f）。注意别和 sanitize.js USAGE_CALL_PURPOSES
// （perCallUsage 行级用途）混了：这里只描述"整条 usage 事件来自哪次写盘"。
const USAGE_PURPOSES = new Set(['main_model', 'auto_sticker']);

const JEV_STATUSES = new Set([
  'accepted', 'low-confidence', 'abstain', 'invalid', 'busy', 'timeout', 'error', 'unavailable', 'filtered'
]);
const JEV_DECISIONS = new Set(['accepted', 'positive', 'negative', 'abstain', 'invalid', 'busy', 'timeout', 'error', 'unavailable', 'filtered']);
const JEV_CHANNELS = new Set(['local', 'none', 'cloud', 'hybrid']);
// ★ 2026-10-19（第八批 · 诊断持久化）：超时配置被拒的**原因短码**。
//   唯一生产者 = modules/jev/core.js 的 configure()（rejected.reason：'out-of-range' | 'not-a-number'，
//   经 judge.js 行构造写入）。这里刻意用 `enum?` 白名单，**不是**宽松 strOpt：
//   未知值落 null 并计入 enumCoercions 读数，任何正文/身份/凭据都不可能借这一列进 ndjson。
//   新增拒绝码时两处一起改（core.js reason 与这张表），否则会被静默改写成 null。
const JEV_TIMEOUT_CONFIG_REJECT_REASONS = new Set(['out-of-range', 'not-a-number']);
const ERROR_CODES = new Set([
  'timeout', 'busy', 'rate_limited', 'unavailable', 'invalid', 'conn_refused', 'not_ready',
  'not_enabled', 'circuit_open', 'missing_files', 'conn_error', 'http_error', 'error'
]);
const ACTIONS = new Set(['reply', 'continue', 'wait', 'skip', 'ask', 'tool', 'send']);
const PLAN_ACTIONS = new Set([...ACTIONS]);
const STAGE_STATUSES = new Set(['ok', 'error', 'skipped', 'timeout', 'unknown']);

/** 每行都带的公共列。`idempotencyKey` 是调用方的去重凭据，落盘层不去重。 */
const COMMON = {
  at: { t: 'stamp' },
  rowId: { t: 'id', max: 36 },
  correlationId: { t: 'id', max: 36 },
  chatKey: { t: 'id', max: 160 },
  roundId: { t: 'id', max: 160 },
  idempotencyKey: { t: 'id', max: 200 }
};

export const LEDGER_NAMES = ['decision', 'usage', 'jev', 'send'];
export const STREAM_NAMES = [...LEDGER_NAMES, 'spans', 'events', 'log'];

export const LEDGER_SCHEMAS = {
  // 抄 src/decision-ledger.js 的 sanitizeDecisionLedgerRow 口径
  decision: {
    ...COMMON,
    subjectKind: { t: 'id', max: 48 },
    lane: { t: 'enum', allowed: LANES, fallback: 'ambient' },
    source: { t: 'enum', allowed: SOURCES, fallback: 'other' },
    decision: { t: 'enum', allowed: DECISIONS, fallback: 'skip' },
    reasonCode: { t: 'enum', allowed: REASONS, fallback: 'other' },
    authority: { t: 'enum?', allowed: AUTHORITIES, invalid: 'other' },
    tier: { t: 'count', max: 10 },
    messageCount: { t: 'count' },
    durationMs: { t: 'ms' },
    modelOutcome: { t: 'enum?', allowed: MODEL_OUTCOMES, invalid: null },
    policyOutcome: { t: 'enum?', allowed: POLICY_OUTCOMES, invalid: 'other' },
    blockReason: { t: 'enum?', allowed: BLOCK_REASONS, invalid: 'other' }
  },
  // 搬 src/usage-ledger.js 的 extractUsageFromSession（只留计数与模型标识）
  usage: {
    ...COMMON,
    sessionId: { t: 'id', max: 160 },
    model: { t: 'id', max: 64 },
    vendor: { t: 'id', max: 32 },
    callCount: { t: 'count', max: 10_000 },
    // ★ 2026-10-17（缓存真实诊断 · 473d331f）：
    //   purpose 区分这条 usage 是主链组包（main_model）还是自动出表情（auto_sticker）——
    //   WriteUsageelog 前由 orchestrator/index.js 给顶层 row 注入；缺省时 `enum?` 落 null
    //   （旧行无此键，不会被伪推断成某个用途）。
    //   usageIncomplete：本轮调用过模型但用量没凑齐（composed.usage 为空），表示"没攒成"而非"没调用"。
    //   cacheUsageReported：主链按行对齐后 —— 期望主调用轮数>0、usageCallRows 数量对得上、
    //   且每一行 promptTokens/cachedTokens 都拿到了真实数值（显式 0 也算真报告；缺失=null 不算）。
    //   两者都是 boolOpt：键缺席 = 场景不适用，不落 false 冒充"已查过且为否"。
    purpose: { t: 'enum?', allowed: USAGE_PURPOSES, invalid: null },
    usageIncomplete: { t: 'boolOpt' },
    cacheUsageReported: { t: 'boolOpt' },
    promptTokens: { t: 'count', max: 100_000_000 },
    completionTokens: { t: 'count', max: 100_000_000 },
    cachedTokens: { t: 'count', max: 100_000_000 },
    cacheCreationTokens: { t: 'count', max: 100_000_000 },
    webSearchCount: { t: 'count', max: 100_000 },
    toolNames: { t: 'ids', max: 12, maxLen: 64 },
    perCallUsage: { t: 'usageCalls', max: MAX_PER_CALL_USAGE_ROWS },
    perCallUsageTruncated: { t: 'boolOpt' },
    modelCallTrace: { t: 'modelCalls', max: MAX_MODEL_CALL_TRACE_ROWS },
    modelCallTraceTruncated: { t: 'boolOpt' },
    durationMs: { t: 'ms' }
  },
  // 搬 src/jev-observer.js 的 observationRow（label 走 ASCII 闸，非 ASCII 整条丢掉）
  jev: {
    ...COMMON,
    role: { t: 'id', max: 48 },
    profile: { t: 'id', max: 16 },
    status: { t: 'enum?', allowed: JEV_STATUSES, invalid: null },
    decision: { t: 'enum?', allowed: JEV_DECISIONS, invalid: null },
    label: { t: 'id', max: 48 },
    positive: { t: 'bool?' },
    requestedChannel: { t: 'enum?', allowed: JEV_CHANNELS, invalid: null },
    channel: { t: 'enum?', allowed: JEV_CHANNELS, invalid: null },
    durationMs: { t: 'ms' },
    queueMs: { t: 'ms' },
    p: { t: 'num', digits: 4, lo: 0, hi: 1 },
    margin: { t: 'num', digits: 4 },
    threshold: { t: 'num', digits: 4 },
    inputChars: { t: 'count', max: 10_000_000 },
    inputTruncated: { t: 'bool?' },
    errorCode: { t: 'enum?', allowed: ERROR_CODES, invalid: 'other' },
    traceId: { t: 'id', max: 160 },
    // ★ 2026-10-15（J4 落盘）：判据记忆判断结果落元数据，让自检脚本能验证"判据开没开口"。
    //   memoryMode: enum?，判据选出的记忆模式；来自 modules/jev/judge.js:262 的 parsed.memory.mode。
    //   memoryReason: id，记忆字段校验原因码；来自 modules/jev/judge.js:277 的 parsed.memoryReason。
    //   memoryCrossChat: bool?，判据是否要求跨群记忆；来自 modules/jev/judge.js:263 的 parsed.memory.cross_chat。
    //   只落枚举/短字段，不落正文（query 是模型写的检索词，≤80 字，属短字段）。
    memoryMode: { t: 'enum?', allowed: new Set(['none', 'recent', 'long_term', 'mixed']), invalid: null },
    memoryReason: { t: 'id', max: 48 },
    memoryCrossChat: { t: 'bool?' },
    // ★★ 2026-10-15（云判据链核查 · ds3）· 判据"无效原因 / 超时诊断"落盘列。
    //   缺口：`modules/jev/judge.js` 的 `judgeOnce()` 早就在判据行里写这些键，但本 schema 是
    //   allowlist（`sanitize.js` 的 `buildRow()` 只遍历 schema 的键）⇒ 整键静默消失，
    //   用户看到的只有 "invalid" 一个词，答不了"空正文还是解析失败"。
    //   逐键取证（写入点 = judge.js 行构造；**行号 = 2026-10-15 HEAD，会漂移，以键名为准**）：
    //     reason                        ← judge.js:327（短原因码；`ask()` 行也写同一语义）
    //     outputChars / reasoningChars  ← judge.js:313-314（仅 status==='invalid'；只数长度）
    //     finishReason                  ← judge.js:315（仅 invalid；供应商枚举 stop/length/…）
    //     timeoutMs                     ← judge.js:306（生效截止点，来自 engine.callWithTimeout）
    //     timeoutClamped/timeoutRequestedMs             ← judge.js:307（**调用级**真实夹取事实；
    //       2026-10-19 第五批起上限已抬到 120000ms，只有真的夹了才带这两键）
    //     timeoutConfigClamped/timeoutConfigRequestedMs ← 历史兼容列：配置入口的 15s 硬顶夹取
    //       已于 2026-10-19 第五批取消（不再有生产者，保留只为读旧 ndjson；旧行按缺席处理）
    //     timeoutConfigRejected/timeoutConfigRejectReason ← judge.js（timeoutState().rejected 分支；
    //       2026-10-19 第八批）：面板值非法被拒时落 boolOpt + 受限短码（out-of-range / not-a-number），
    //       原值为有限数时配合 timeoutConfigRequestedMs 回答"填了 X、为什么没生效、实际按 5000 用"
    //   口径（**只落短码/长度/布尔/毫秒；正文、思考内容、聊天身份一律不落**）：
    //     · idOpt（reason / finishReason）：ASCII 短码 `[0-9A-Za-z_.:#@-]`，超长截到 max；
    //       含中文/换行/emoji 的**整条丢**（不是截断 —— 限长挡不住短正文，ASCII 才挡得住）。
    //       max 与现有两列对齐（events.reason:48、jev.memoryReason:48）：reason 写入点最长 160
    //       （错误消息头），落盘截到 48 —— 够放 `budget:hard-daily-limit-exceeded`(31) /
    //       `empty-content-with-reasoning`(29) / `paused-consecutive-failures`(28) 这类码。
    //     · countOpt：缺省**不落键**（"没测" ≠ 0）；reasoningChars 只由适配器数长度，思考内容从不读取。
    //     · msOpt：缺省不落键（缺省 ≠ 0ms）。
    //     · boolOpt：缺省不落键（缺省 ≠ false；false 才是"明确没被夹"）。
    //   向后兼容：这些键在 376b83a 之后才会被写；旧行没有键 = "当时没这项"，读取方按缺席处理，
    //   不许补 0/null/''（故一律用 *Opt 规格，而不是 id/ms/bool?）。
    reason: { t: 'idOpt', max: 48 },
    outputChars: { t: 'countOpt', max: 10_000_000 },
    reasoningChars: { t: 'countOpt', max: 10_000_000 },
    finishReason: { t: 'idOpt', max: 24 },
    timeoutMs: { t: 'msOpt' },
    timeoutClamped: { t: 'boolOpt' },
    timeoutRequestedMs: { t: 'msOpt' },
    timeoutConfigClamped: { t: 'boolOpt' },
    timeoutConfigRequestedMs: { t: 'msOpt' },
    // ★ 2026-10-19（第八批 · 诊断持久化缺口）：`modules/jev/judge.js` 的行里早就写了这两键，
    //   但 jev schema 是 allowlist ⇒ 整键静默消失（进程内环形账有、ndjson 没有）。
    //   rejected 用 boolOpt（缺省不落键；false 才是"明确没被拒"）；
    //   reason 用**受限枚举**（只认 core.js 现有的 out-of-range/not-a-number），不放宽成自由字符串；
    //   未知码 → null，并进 sanitize 的 enumCoercions 读数（可查，不静默）。
    timeoutConfigRejected: { t: 'boolOpt' },
    timeoutConfigRejectReason: { t: 'enum?', allowed: JEV_TIMEOUT_CONFIG_REJECT_REASONS, invalid: null }
  },
  // 新形状：阶段 E 的发送回执（§3.1 SendReceipt 的可观测投影）
  send: {
    ...COMMON,
    action: { t: 'enum', allowed: ACTIONS, fallback: 'skip' },
    planAction: { t: 'enum', allowed: PLAN_ACTIONS, fallback: 'skip' },
    ok: { t: 'bool' },
    platformId: { t: 'id', max: 120 },
    evidenceId: { t: 'id', max: 160 },
    errorCode: { t: 'enum?', allowed: ERROR_CODES, invalid: 'other' },
    durationMs: { t: 'ms' },
    attempt: { t: 'count', max: 32 }
  }
};

/** span 行的额外可观测字段（chatKey/roundId 已在 COMMON 里，且是必填语义）。 */
const SPAN_FIELDS = {
  name: { t: 'id', max: 48 },
  parentId: { t: 'id', max: 36 },
  depth: { t: 'count', max: 64 },
  endedAt: { t: 'stamp' },
  durationMs: { t: 'ms' },
  status: { t: 'enum', allowed: STAGE_STATUSES, fallback: 'unknown' },
  attempt: { t: 'count', max: 32 },
  messageCount: { t: 'count' },
  phaseIndex: { t: 'count', max: 64 }
};

const EVENT_FIELDS = {
  kind: { t: 'id', max: 48 },
  stage: { t: 'id', max: 48 },
  name: { t: 'id', max: 48 },
  status: { t: 'enum', allowed: STAGE_STATUSES, fallback: 'unknown' },
  code: { t: 'id', max: 48 },
  durationMs: { t: 'ms' },
  attempt: { t: 'count', max: 32 },
  count: { t: 'count' },
  messageCount: { t: 'count' },
  blockedBy: { t: 'id', max: 48 },
  // ★★ N81（2026-10-10 · qwen2）· 补齐**生产侧早就在发、却被 schema 静默丢掉**的键。
  //   需求是用户那句「直观看见这个 LLM 本轮调用了什么工具」⇒ 数据得先存在。
  //   下面每一个键都是**实测**来的（不是设想的），出处给到 file:line：
  //     itemCount     ← orchestrator/index.js:2142 `context:retrieved`（luna1 报的那条，被丢得最彻底）
  //     ok / platformId ← orchestrator/index.js:1761 `receipt:confirmed`
  //     evidenceId    ← orchestrator/index.js:1973 `evidence:built`
  //     action / reason ← orchestrator/index.js:2200 `plan:decided`
  //     signal        ← orchestrator/index.js:2202 `verdict:issued`（⚠ JEV 的 label 若是中文会被 ASCII 闸落成 ''，
  //                     那是 §3.3 的不变量在起作用，不是这里的缺陷；见 selftest 那条"字段在、值空"）
  //     tier / decision / reasonCode ← orchestrator/index.js:2698-2718 `wake:suppressed` / `plan:decided`
  //   ★ 为什么用 `t:'id'`/`'count'`/`'bool'` 而**不用 `enum`**：这张表历史上吃过三次"白名单漏码 ⇒
  //     静默改写成 'other'"（见 REASONS 上面那三段 2026-10-05 / 00:3x / N36 的补记）。事件侧这些值来自
  //     plan/compose 的码，写入点比台账更散 ⇒ 这里**只过 ASCII 闸、不设第二道取值白名单**，
  //     宁可落一个没人认识的码，也不要落一个"其它"。
  //   ★ `toolNames`：usage 账**早有这个字段**（本文件 :140，抄老树 `src/usage-ledger.js:35-38,65` 的记法），
  //     事件侧原来没有 ⇒ 补上，这样"本轮调了哪些工具"在单轮时间线上也看得见。
  //     ⚠ 生产侧目前**没有任何地方给它赋值**（orchestrator/index.js:2334 那条 usage 落账也没传 toolNames）
  //     ⇒ 字段通了，数据还得由记录侧（orchestrator 域）灌进来，本票已把落点报指挥位。
  itemCount: { t: 'count' },
  ok: { t: 'bool' },
  platformId: { t: 'id', max: 120 },
  evidenceId: { t: 'id', max: 160 },
  action: { t: 'id', max: 48 },
  reason: { t: 'id', max: 48 },
  reasonCode: { t: 'id', max: 48 },
  decision: { t: 'id', max: 32 },
  tier: { t: 'count', max: 10 },
  signal: { t: 'id', max: 48 },
  toolNames: { t: 'ids', max: 12, maxLen: 64 },
  // ★★ N81 追加（2026-10-10 · qwen2，luna1 提的）：**被拦的是群还是私聊**。
  //   需求出处：`orchestrator/index.js:2732-2733` 的 `wake:suppressed` / `plan:decided` 都传了
  //   `kind: allow.kind`，而 `kind` 这个键名**天生是事件名**（N81-② 那颗牙钉的就是"调用方传的
  //   kind 不许顶掉事件名"）⇒ 那一路 `group`/`private` 必然被丢。luna1 的处置是把载荷**改名**
  //   `subjectKind`（改名由他在 orchestrator 域做），但只改名不够 ⇒ schema 里没有这一列，
  //   `schemaDrops` 照样吃。所以这里补列，两边才对得上。
  //   值域实测：`core/policy/allow-gate.js:44` `kind === 'private' ? 'private' : 'group'`
  //   ⇒ 只可能是这两个。**仍用 `t:'id'` 不用 enum**：与本表上面那段"宁可落一个没人认识的码，
  //   也不要落一个'其它'"同一口径（事件侧写入点比台账更散，不再叠第二道取值白名单）。
  //   ⚠ 别和 `lane` 混：lane 是"这条走哪条响应通道"（addressed/topic_follow/…），
  //     `subjectKind` 只说"这是群还是私聊"。
  subjectKind: { t: 'id', max: 48 },
  // One entry per top-level argument: `name:type:utf8-bytes:sha256(value-json)`.
  // Only fixed-size metadata reaches disk; never pass toolArgs/toolResult raw values here.
  toolSchemaHash: { t: 'id', max: 64 },
  prefixFingerprint: { t: 'id', max: 64 },
  systemHash: { t: 'id', max: 64 },
  toolNameHash: { t: 'id', max: 64 },
  staticToolSchemaHash: { t: 'id', max: 64 },
  candidateBytes: { t: 'count', max: 10_000_000 },
  toolCount: { t: 'count', max: 10_000 },
  toolSchemaBytes: { t: 'count', max: 10_000_000 },
  // Final outbound request: fixed segment labels + byte counts + SHA-256; never prompt/tool contents.
  requestSegments: { t: 'requestSegments', max: 40 },
  bodyBytes: { t: 'count', max: 2_000_000_000 },
  bodyHash: { t: 'id', max: 64 },
  changedSegmentCount: { t: 'count', max: 32 },
  firstChangedSegment: { t: 'id', max: 48 },
  comparisonBaselineAvailable: { t: 'bool' },
  // DS 最终消息投影的字符前缀定位；正文只在有界内存里比较，以下仅落标量。
  prefixDiagnosticsAvailable: { t: 'boolOpt' },
  prefixBaselineAvailable: { t: 'boolOpt' },
  prefixCommonChars: { t: 'countOpt', max: 128_000 },
  prefixComparedChars: { t: 'countOpt', max: 128_000 },
  prefixChangedSection: { t: 'enum?', allowed: new Set(['baseline', 'none', 'prefix-limit', 'system', 'history',
    'thoughts', 'state', 'current-turn', 'memory', 'stable-assets', 'other', 'message-meta',
    'image-or-part', 'tool-calls', 'message-end']) },
  prefixLimitReached: { t: 'boolOpt' },
  prefixToolsChanged: { t: 'boolOpt' },
  prefixHistoryHeadChanged: { t: 'boolOpt' },
  prefixHistoryRows: { t: 'countOpt', max: 2048 },
  prefixHistoryRowsLimited: { t: 'boolOpt' },
  prefixHistoryAppendOnly: { t: 'boolOpt' },
  prefixHistoryChunk: { t: 'countOpt', max: 192 },
  prefixHistoryBaseLimit: { t: 'countOpt', max: 100_000 },
  prefixHistoryCharsRedrawn: { t: 'boolOpt' },
  prefixHistoryExtrasTrimmed: { t: 'boolOpt' },
  prefixHistoryBaseRowsCut: { t: 'boolOpt' },
  prefixHistoryMessageChars: { t: 'countOpt', max: 1_000_000 },
  prefixBuildOverBudget: { t: 'boolOpt' },
  argumentFacts: { t: 'ids', max: 16, maxLen: 160 },
  resultBytes: { t: 'count' },
  resultHash: { t: 'id', max: 64 },
  truncationReason: { t: 'id', max: 48 },
  cacheMarkerCount: { t: 'count', max: 1024 },
  cacheMarkerPositions: { t: 'ids', max: 64, maxLen: 64 },
  cacheMarkerPositionsTruncated: { t: 'boolOpt' },
  // ★ 2026-10-17（每厂商缓存策略 · 473d331f 第三轮）· model:request 出站诊断补记录侧：
  //   compose.js 的 `recordModelEvent(modules,'model:request',…)` 从 f0e47d69 起就在写这三个
  //   键（行号会漂移，以键名为准），但本 allowlist 没有列 ⇒ `buildRow` 整键静默丢，
  //   `schemaDrops` 记账可见。落的是**策略归一化读数**（llm.js applyCacheStrategy 随 api
  //   流来的有效值），不含 URL/密钥/正文：
  //     cacheStrategy       ← api.cacheStrategy：providers.js normalizeCacheStrategy 归一化后的
  //                           有效值，∈ CACHE_STRATEGY_IDS（'auto'|'deepseek'|'dashscope'|
  //                           'zhipu'|'mimo'|'compatible'，≤10 字）⇒ ASCII idOpt。
  //     cacheStrategySource ← api.cacheStrategySource：normalizeCacheStrategy 单点产出的
  //                           'auto'|'manual'|'fallback'（≤8 字）⇒ ASCII idOpt。
  //                           仍不用 enum?：与本表 N81 段口径一致 —— "宁可落一个没人认识的码，
  //                           也不要落一个'其它'"；归一化函数产新来源码时不会静默变 null。
  //     cacheStrategyReason ← api.cacheStrategyReason：providers.js 的**固定中文短诊断短语**
  //                           （如「providers 里找不到 'x' ⇒ 回 auto」），ASCII 闸会整条吃掉
  //                           ⇒ 必须用 text（本表唯一放非 ASCII 的通道，与 log msg 同一信任级：
  //                           这是代码常量，不是模型输出/聊天正文）。写入点已 slice(0,120)，
  //                           这里 max 160 是防御截断的兜底。compose 只在非空时写该键；
  //                           解析顺利时源值本就是 '' ⇒ 落 '' 与"无附加原因"等价语义，
  //                           不算"没测"伪造。
  //   *Opt 首用：调用方缺席 ⇒ 键不落盘（旧行没有这些键 = "当时没这项"，读取方按缺席处理，
  //   不许补 ''/null/0）。与 firstChangedSegment/usage 顶层的 purpose 等既有字段无键位冲突。
  cacheStrategy: { t: 'idOpt', max: 32 },
  cacheStrategySource: { t: 'idOpt', max: 32 },
  cacheStrategyReason: { t: 'text', max: 160 },
  finishOffered: { t: 'bool' },
  finishCalled: { t: 'bool' },
  endReason: { t: 'id', max: 80 },
  // Runtime resource samples contain numeric diagnostics only; unknown values stay absent, never become zero.
  rssBytes: { t: 'countOpt', max: 1_000_000_000_000 },
  heapUsedBytes: { t: 'countOpt', max: 1_000_000_000_000 },
  heapTotalBytes: { t: 'countOpt', max: 1_000_000_000_000 },
  activeSessionCount: { t: 'countOpt' },
  inFlightModelRequestCount: { t: 'countOpt' },
  gpuProcessCount: { t: 'countOpt' },
  gpuWorkingSetKiB: { t: 'countOpt', max: 1_000_000_000 },
  gpuPeakWorkingSetKiB: { t: 'countOpt', max: 1_000_000_000 },
  rendererProcessCount: { t: 'countOpt' },
  rendererWorkingSetKiB: { t: 'countOpt', max: 1_000_000_000 },
  rendererPeakWorkingSetKiB: { t: 'countOpt', max: 1_000_000_000 }
};

export const SPAN_SCHEMA = { ...COMMON, ...SPAN_FIELDS };
export const EVENT_SCHEMA = { ...COMMON, ...EVENT_FIELDS };

/** 账本名白名单；不认识的名字直接拒（不静默开新文件）。 */
export function isLedgerName(name) { return LEDGER_NAMES.includes(String(name)); }
export function isStreamName(name) { return STREAM_NAMES.includes(String(name)); }

/** 按账本名造行。未知账本名 → null（调用方拿到 null，不抛）。 */
export function buildLedgerRow(name, row, { rowId = null } = {}) {
  const schema = LEDGER_SCHEMAS[String(name)];
  if (!schema) return null;
  // ★ N81：第三个参数是**落点标签**，只喂给 sanitize.js 的"丢字段记账"（记键名，绝不碰值）。
  const out = buildRow(schema, row, `ledger.${name}`);
  if (String(name) === 'usage' && Array.isArray(row?.perCallUsage)) {
    // 明细截断不影响顶层总量；必须显式标出，不能让部分列表看起来完整。
    const exceeded = row.perCallUsage.length > MAX_PER_CALL_USAGE_ROWS;
    if (exceeded || row.perCallUsageTruncated === undefined) out.perCallUsageTruncated = exceeded;
  }
  if (String(name) === 'usage' && Array.isArray(row?.modelCallTrace)) {
    const exceeded = row.modelCallTrace.length > MAX_MODEL_CALL_TRACE_ROWS;
    if (exceeded || row.modelCallTraceTruncated === undefined) out.modelCallTraceTruncated = exceeded;
  }
  if (!out.rowId) out.rowId = rowId || null;
  return out;
}

export function buildSpanRow(row, { rowId = null } = {}) {
  const out = buildRow(SPAN_SCHEMA, row, 'span');
  if (!out.rowId) out.rowId = rowId || null;
  return out;
}

export function buildEventRow(row, { rowId = null } = {}) {
  const out = buildRow(EVENT_SCHEMA, row, 'event');
  if (!out.rowId) out.rowId = rowId || null;
  return out;
}

/**
 * 首字延迟的固定分段（不变量 2）：span() 必须能表达这五段，且可嵌套。
 * 一律用 ASCII 键 —— 中文段名进不了落盘行。
 */
export const TTFT_STAGES = Object.freeze(['queue', 'jev', 'memory', 'firstToken', 'firstSend']);
