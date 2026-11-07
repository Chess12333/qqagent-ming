// 结构化落盘字段的统一消毒器 —— M2 的"账本不含正文"不变量就压在这个文件里。
//
// ★ 唯一规则：**落盘/内存里的结构化字段只允许 ASCII 标量与显式受限的结构**。
//   聊天正文、提示词、completion、工具参数/结果全是自然语言（含中文/换行/emoji），
//   一律无法通过下面任何一个 coerce()。不是"记得别传"，是**传了也进不去**。
//   为什么不用 denylist（src/decision-ledger.js 的做法）：denylist 只能挡住已知键名，
//   对方换个键名（note / summary / snippet）就漏；这里是 allowlist + ASCII 双重闸。
//
// 为什么额外要求 ASCII（而不是"限长就行"）：限长的中文正文依然是正文。一句
// 「今天群里在吵 XX」只有 9 个字，限长拦不住，ASCII 能拦 —— 这是唯一能同时挡住
// 中文正文、换行伪造、emoji、控制字符的单一判据。
//
// 行内不许任意嵌套对象/数组（除显式 ids 与下方受限模型调用数组）：嵌套是走私正文的路
//（fields:{a:{b:'正文'}}）。模型调用数组逐字段读取固定白名单，只保留计数、用途、原因码和指纹。

/** ASCII 标识符：字母数字 + `_.:#@-`。覆盖 id / chatKey / 模型名 / 工具名 / 枚举值。 */
const ASCII_TOKEN = /^[0-9A-Za-z_.:#@-]+$/;
export const MAX_PER_CALL_USAGE_ROWS = 64;
export const MAX_MODEL_CALL_TRACE_ROWS = 64;
const USAGE_CALL_PURPOSES = new Set(['main_model', 'body_judge', 'other']);
// ★ 2026-10-17（缓存真实诊断 · 473d331f）：与 request-segments.js 的 SEGMENT_ORDER 同步。
// 这张 set 是 requestSegments 行的落盘闸：名单里没有的段名整行被 continue 吃掉，
// 不报错也没有 schemaDrops 之外的痕迹 —— 拆新桶（current_context_tail）时必须两处一起改。
const REQUEST_SEGMENT_NAMES = new Set([
  'system_role', 'system_identity_rules', 'system_safety_rules', 'system_speech_rules',
  'system_turn_rules', 'system_history_format', 'system_sticker', 'system_other_rules',
  'round_context', 'operation_manual', 'sticker_context', 'participation', 'session_identity',
  'relation_state', 'meme_cue', 'tool_availability',
  'history_total', 'history_format_text', 'history_count_line', 'history_message_lines',
  'history_quote_media_annotations', 'history_timestamps', 'history_relative_times',
  'recent_history', 'history_messages',
  'current_context_tail', 'short_term_state', 'focus', 'own_speech', 'memory_view',
  'wake_evidence', 'current_message',
  'current_user_other', 'tool_calls', 'tool_results', 'image_parts', 'tool_definitions',
  'request_body'
]);
const REQUEST_SEGMENT_SOURCES = new Set([
  'system', 'user_prompt', 'history', 'memory', 'state', 'emotion', 'current_input',
  'tool_call', 'tool_result', 'media', 'tools', 'request'
]);
const REQUEST_SEGMENT_CHANGES = new Set(['baseline', 'changed', 'unchanged', 'unavailable']);

/** 落盘字段名本身也要 ASCII（防止键名走私）。 */
export function safeKey(key) {
  const text = String(key ?? '');
  return ASCII_TOKEN.test(text) && text.length <= 48 ? text : null;
}

/**
 * 标识符类字段（id / chatKey / 模型名 / 工具名 / 枚举值）。
 * 非 ASCII 一律丢弃并回落 fallback —— 不是截断，是**整条不给**。
 */
export function safeId(value, max = 160, fallback = '') {
  if (value == null) return fallback;
  const text = typeof value === 'string' ? value : (typeof value === 'number' || typeof value === 'boolean' ? String(value) : '');
  if (!text) return fallback;
  if (!ASCII_TOKEN.test(text)) return fallback;          // 含正文/换行/emoji → 丢
  return text.length <= max ? text : text.slice(0, max);
}

/** 枚举字段：只认白名单里的值，其它一律 invalid。 */
export function safeEnum(value, allowed, fallback = 'other', field = '') {
  const text = String(value ?? '');
  if (allowed.has(text)) return text;
  noteEnumCoercion(field, value, fallback);
  return fallback;
}

/** 可选枚举：空 → null（键仍可落盘，语义是"这项没测"）；非法 → invalid。 */
export function safeOptionalEnum(value, allowed, invalid = 'other', field = '') {
  if (value == null || value === '') return null;
  const text = String(value);
  if (allowed.has(text)) return text;
  noteEnumCoercion(field, value, invalid);
  return invalid;
}

/* ───────────────────────────────────────────────────────────────────────────
 * ★ N45（2026-10-09 · qwen2）枚举改写记账 —— 把"静默改写"变成"数得出来"。
 *
 * 【为什么加】这仓最大的一类病是**枚举失真**：白名单漏了写入点真会产出的码，
 *   safeEnum 就把它悄悄换成 fallback（reasonCode→'other'、status→'error'、
 *   action→'skip'）。信息没了、**不报错、自测照样绿** ⇒ 同一个病复发过三次
 *   （2026-10-05 的 tier_restricted · 2026-10-09 00:3x 的 19 个码 · 当天 N36 又 5 个）。
 *   静态扫写入点治不了它：码在三元表达式里拼、跨模块被映射表收敛，grep 一定漏
 *   （N36 实测：子代理报 5 个，静态差集扫出 16 个候选，其中 11 个根本到不了台账）。
 *   ⇒ 唯一精确的收口位置就是**这里**：所有枚举值落盘前都必须过上面两个函数。
 *
 * 【记什么】只在**真信息被销毁**时记一笔：入参非空且不在白名单里。
 *   null/''/undefined 是"这项没测"，属正常状态，记了会瞬间刷爆 ⇒ 不记。
 *   非 ASCII 入参也不记：那是正文走私，已被 ASCII 闸挡住，不是"漏码"信号
 *   ——顺带保证这张表**不可能变成正文的第二条落盘通道**（本文件的头号不变量）。
 * 【上限】distinct 组合最多 64 条，超出只累加 dropped ⇒ 记账本身不许成为内存洞。
 * 【不改变落盘结果】本段只记账、不改任何返回值；buildRow 的输出与加这段之前
 *   逐字段相同（selftest 有一条断言专门钉这件事）。
 * ─────────────────────────────────────────────────────────────────────────── */
const COERCION_DISTINCT_LIMIT = 64;
const coercionRows = new Map();          // `${field} ${value}` → { field, value, to, n }
let coercionTotal = 0;
let coercionDropped = 0;

function noteEnumCoercion(field, value, to) {
  if (value == null || value === '') return;
  const text = typeof value === 'string' ? value : (typeof value === 'number' || typeof value === 'boolean' ? String(value) : '');
  if (!text) return;
  const clean = safeId(text, 80, '');          // 非 ASCII / 超长 → ''，不记
  if (!clean) return;
  coercionTotal += 1;
  const key = `${safeId(field, 48, '') || '(unknown-field)'} ${clean}`;
  const hit = coercionRows.get(key);
  if (hit) { hit.n += 1; return; }
  if (coercionRows.size >= COERCION_DISTINCT_LIMIT) { coercionDropped += 1; return; }
  coercionRows.set(key, { field: key.slice(0, key.indexOf(' ')), value: clean, to: to === null ? 'null' : String(to ?? ''), n: 1 });
}

/** 改写记账读数（只读副本）。`total` 是发生次数，`rows` 是去重后的明细。 */
export function enumCoercions() {
  return {
    total: coercionTotal,
    distinct: coercionRows.size,
    dropped: coercionDropped,
    limit: COERCION_DISTINCT_LIMIT,
    rows: [...coercionRows.values()].map((r) => ({ ...r })).sort((a, b) => b.n - a.n)
  };
}

export function resetEnumCoercions() {
  coercionRows.clear(); coercionTotal = 0; coercionDropped = 0;
}

/**
 * 白名单外 ⇒ **整条丢弃**（而不是换 fallback）的写入点用这个记账。
 * 丢弃同样是"信息没了还不报错"，必须一并数得出来，否则闸门就有盲区。
 */
export function noteEnumDrop(field, value) { noteEnumCoercion(field, value, '(dropped)'); }

/** 非负整数；越界收敛到 [0,max]；非数 → fallback（不猜）。 */
export function safeCount(value, max = 1_000_000, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(max, Math.round(n)));
}

/** 耗时（毫秒），上限 24h —— 超过就是脏数据，不是"跑了三天"。 */
export function safeMs(value, fallback = null) {
  return safeCount(value, 86_400_000, fallback);
}

/**
 * 可选毫秒（jev 诊断列 timeoutMs/timeoutRequestedMs/timeoutConfigRequestedMs 用）：
 * **真有值才给值** —— 缺省、空串、脏值一律 undefined（= 整个键不落盘）。
 * 与 `ms` 的区别：`ms` 缺省落 null（"测了但没数"），这里缺省**不落键**（"根本没这项"）。
 * 旧行本来就没有这些键，读取方按缺席处理；不许用 0/null 把"没这项"伪装成"测到 0"。
 */
export function safeOptionalMs(value) {
  if (value == null || value === '') return undefined;
  return Number.isFinite(Number(value)) ? safeMs(value, null) : undefined;
}

/**
 * 可选短码（jev 的 reason / finishReason 用）：缺省、空串 → undefined（不落键）。
 * 非法字符（中文/换行/emoji —— 正文走私）由 safeId 的 ASCII 闸**整条挡掉**，也 → undefined，
 * 不是截断：限长挡不住短正文，只有 ASCII 闸挡得住（见文件头不变量）。合法值超长则安全截到 max。
 */
export function safeOptionalId(value, max = 160) {
  if (value == null || value === '') return undefined;
  return safeId(value, max, '') || undefined;
}

/** 浮点（概率 / margin），可夹逼；非数 → null。 */
export function safeNum(value, { digits = 4, lo = null, hi = null } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const clamped = lo != null && n < lo ? lo : (hi != null && n > hi ? hi : n);
  return Number(clamped.toFixed(digits));
}

/** 布尔；非布尔 → null（"没测"和"false"不是一回事，不许混）。 */
export function safeBool(value) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/** id 数组（工具名等）：逐个过 ASCII 闸，丢掉不合法的，最多 max 个。 */
export function safeIdList(value, { max = 12, maxLen = 64 } = {}) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const item of value.slice(0, max * 3)) {
    const id = safeId(item, maxLen, '');
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= max) break;
  }
  return out.length ? out : undefined;
}

/**
 * Per-request token facts for the usage ledger. Missing provider cache counters
 * are stored as null (unavailable); a reported zero remains numeric zero.
 * Prompt text, completion text, messages, and arbitrary properties are never
 * read or copied.
 */
export function safePerCallUsage(value, { max = MAX_PER_CALL_USAGE_ROWS } = {}) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const call of value.slice(0, max)) {
    if (!call || typeof call !== 'object' || Array.isArray(call)) continue;
    const roundIndex = safeCount(call.roundIndex, 10_000, null);
    const purpose = safeOptionalEnum(call.purpose, USAGE_CALL_PURPOSES, 'other', 'usage.perCallUsage.purpose');
    const promptTokens = call.promptTokens == null || call.promptTokens === ''
      ? null : safeCount(call.promptTokens, 100_000_000, null);
    const completionTokens = call.completionTokens == null || call.completionTokens === ''
      ? null : safeCount(call.completionTokens, 100_000_000, null);
    // Missing either provider count is unknown, not zero; omit that detail row.
    if (roundIndex == null || purpose == null || promptTokens == null || completionTokens == null) continue;
    const prefixFingerprint = safeId(call.prefixFingerprint, 64, '');
    out.push({
      roundIndex, purpose, promptTokens, completionTokens,
      prefixFingerprint: prefixFingerprint || null,
      cachedTokens: optionalUsageCount(call.cachedTokens),
      cacheCreationTokens: optionalUsageCount(call.cacheCreationTokens)
    });
  }
  return out.length ? out : undefined;
}

function optionalUsageCount(value, max = 100_000_000) {
  if (value == null || value === '') return null;
  return safeCount(value, max, null);
}

/** Fixed, bounded projection of the model-call trace for usage ledger rows. */
export function safeModelCallTrace(value, { max = MAX_MODEL_CALL_TRACE_ROWS } = {}) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const [index, entry] of value.slice(0, max).entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const round = safeCount(entry.round ?? entry.roundIndex, 10_000, null) ?? (index + 1);
    const purpose = safeOptionalEnum(entry.purpose, USAGE_CALL_PURPOSES, 'other', 'usage.modelCallTrace.purpose');
    const trace = {
      round,
      purpose,
      promptTokens: optionalUsageCount(entry.promptTokens),
      completionTokens: optionalUsageCount(entry.completionTokens),
      durationMs: entry.durationMs == null || entry.durationMs === '' ? null : safeMs(entry.durationMs),
      prefixFingerprint: safeId(entry.prefixFingerprint, 64, '') || null,
      cachedTokens: optionalUsageCount(entry.cachedTokens),
      cacheCreationTokens: optionalUsageCount(entry.cacheCreationTokens)
    };
    const reason = safeId(entry.reason, 120, '');
    const continueReason = safeId(entry.continueReason, 120, '');
    const endReason = safeId(entry.endReason, 120, '');
    if (reason) trace.reason = reason;
    if (typeof entry.toolsOffered === 'boolean') trace.toolsOffered = entry.toolsOffered;
    const toolCallCount = optionalUsageCount(entry.toolCallCount, 10_000);
    const executedToolCalls = optionalUsageCount(entry.executedToolCalls, 10_000);
    if (toolCallCount !== null) trace.toolCallCount = toolCallCount;
    if (executedToolCalls !== null) trace.executedToolCalls = executedToolCalls;
    if (typeof entry.finishCalled === 'boolean') trace.finishCalled = entry.finishCalled;
    if (continueReason) trace.continueReason = continueReason;
    if (endReason) trace.endReason = endReason;
    out.push(trace);
  }
  return out.length ? out : undefined;
}

/** Bounded final-request segment metadata. This accepts fixed names and metrics only. */
export function safeRequestSegments(value, { max = 40 } = {}) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  const seen = new Set();
  for (const entry of value.slice(0, max)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const name = safeId(entry.name, 48, '');
    const source = safeId(entry.source, 32, '');
    const changed = safeId(entry.changed, 16, '');
    if (!REQUEST_SEGMENT_NAMES.has(name) || !REQUEST_SEGMENT_SOURCES.has(source)
      || !REQUEST_SEGMENT_CHANGES.has(changed) || seen.has(name)) continue;
    seen.add(name);
    const available = entry.available === true;
    let bytes = null;
    let items = null;
    let hash = null;
    if (available) {
      bytes = safeCount(entry.bytes, 2_000_000_000, null);
      if (bytes == null) continue;
      const candidateHash = typeof entry.hash === 'string' ? entry.hash : '';
      if (!/^[a-f0-9]{64}$/.test(candidateHash)) continue;
      hash = candidateHash;
      if (entry.items != null) items = safeCount(entry.items, 10_000_000, null);
    }
    out.push({ name, source, available, bytes, hash, items, changed });
  }
  return out.length ? out : undefined;
}

/**
 * 日志正文字段（log() 的 msg / 注意 logger 的 text）。
 * 这条是**唯一**的例外通道：调用方自己写的句子（含中文）会进日志文件。
 * 但仍然要：压掉换行（防伪造行/伪造级别）、限长（异常栈可能上 MB）。
 * 不做正则脱敏 —— 脱敏正则一定会漏，且会把"看起来像正文的排障信息"也抹掉；
 * 约定写死在文件头：**msg 里不许带聊天正文**，fields 里带了就地消毒。
 */
export function safeText(value, max = 500) {
  const text = typeof value === 'string' ? value
    : (value instanceof Error ? `${value.message}\n${value.stack || ''}`
      : (value == null ? '' : safeJson(value)));
  const flat = text.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…(truncated)`;
}

function safeJson(value) {
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

/** 日志附加字段：ASCII 闸 + 键名闸 + 条数/长度上限。 */
export function safeFields(fields, { maxKeys = 24, maxLen = 160 } = {}) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return undefined;
  const out = {};
  let n = 0;
  for (const [rawKey, rawValue] of Object.entries(fields)) {
    if (n >= maxKeys) break;
    const key = safeKey(rawKey);
    if (!key) continue;                                   // 键名含正文/中文 → 丢
    if (rawValue == null) continue;
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) { out[key] = rawValue; n += 1; continue; }
    if (typeof rawValue === 'boolean') { out[key] = rawValue; n += 1; continue; }
    const id = safeId(rawValue, maxLen, '');
    if (id) { out[key] = id; n += 1; }
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * 按 schema 造行：**只遍历 schema 的键**，输入里的其它键（含 text/content/prompt/
 * messages/quoted/…）根本不会被读到 —— 走私正文的路在结构上就不存在。
 * @param {object} schema  字段名 → 规格描述（见 ledgers.js）
 * @param {object} input   调用方给的原始行
 * @param {string} [label] 落点标签（账本名/流名），只用于下面的"丢字段记账"
 * @returns {object} 落盘行（键顺序固定，便于 diff/回放）
 */
export function buildRow(schema, input, label = '') {
  const row = {};
  for (const [field, spec] of Object.entries(schema)) {
    const value = coerce(spec, input?.[field], field);
    if (value !== undefined) row[field] = value;
  }
  noteSchemaDrops(schema, input, label);
  return row;
}

/* ───────────────────────────────────────────────────────────────────────────
 * ★★ N81（2026-10-10 · qwen2）「字段被白名单吃掉」的记账 —— 上面那套闸门有个盲区。
 *
 * 【为什么加】allowlist 是**防正文走私的地基**，不能动。但它有个副作用：
 *   调用方多传一个 schema 里没有的键 ⇒ **整键静默消失**，不报错、自测照样绿。
 *   今晚真撞上了：`orchestrator/index.js:2142` 发 `context:retrieved` 带 `itemCount`，
 *   名单里没有这个键 ⇒ 用户想看的"本轮调了什么工具/检索了几条"根本进不了账本
 *   （实测 `grep -c itemCount data/obs/events-2026-10-10.ndjson` = **0**）。
 *   这和 N45 那批"枚举静默改写"是**同一类病**：信息没了 + 没人报错。
 * 【记什么】**只记键名，绝不碰值** —— 值可能正是正文。键名还要过 `safeKey`：
 *   非 ASCII 的键（键名走私那条路）一律归到固定桶 `(non-ascii-key)` 只累加次数，
 *   ⇒ 这张表**不可能变成正文的第二条落盘通道**（与上面 N45 那段同一口径）。
 * 【上限】distinct 组合 64 条，超出只累加 `dropped` ⇒ 记账不许自己变成内存洞。
 * 【不改变落盘结果】只加计数，`row` 与改动前逐字段相同（selftest 有断言钉这条）。
 * ─────────────────────────────────────────────────────────────────────────── */
const DROP_DISTINCT_LIMIT = 64;
const dropRows = new Map();            // `${label} ${key}` → { label, key, n }
let dropTotal = 0;
let dropOverflow = 0;
let dropNonAscii = 0;

function noteSchemaDrops(schema, input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const where = safeId(label, 48, '') || '(unknown)';
  for (const rawKey of Object.keys(input)) {
    if (schema[rawKey] !== undefined) continue;          // 在名单里的键不算丢（哪怕值是空串）
    dropTotal += 1;
    const key = safeKey(rawKey);
    if (!key) {
      dropNonAscii += 1;                                  // 键名带正文/中文 ⇒ 只数一下，绝不留名
      continue;
    }
    const ck = `${where} ${key}`;
    const hit = dropRows.get(ck);
    if (hit) { hit.n += 1; continue; }
    if (dropRows.size >= DROP_DISTINCT_LIMIT) { dropOverflow += 1; continue; }
    dropRows.set(ck, { label: where, key, n: 1 });
  }
}

/** 丢字段读数（只读副本）。`total` 是被丢的键次数，`rows` 是去重明细（**只有键名，没有值**）。 */
export function schemaDrops() {
  return {
    total: dropTotal,
    distinct: dropRows.size,
    overflow: dropOverflow,
    nonAsciiKeys: dropNonAscii,
    limit: DROP_DISTINCT_LIMIT,
    rows: [...dropRows.values()].map((r) => ({ ...r })).sort((a, b) => b.n - a.n)
  };
}

export function resetSchemaDrops() {
  dropRows.clear(); dropTotal = 0; dropOverflow = 0; dropNonAscii = 0;
}

/** 单字段求值；返回 undefined = 这个键**不落盘**（而不是落一个 null 假装有值）。 */
export function coerce(spec, value, field = '') {
  switch (spec.t) {
    case 'stamp': return safeCount(value, 8_640_000_000_000_000, spec.fallback ?? Date.now());
    case 'id': return safeId(value, spec.max ?? 160, spec.fallback ?? '');
    case 'enum': return safeEnum(value, spec.allowed, spec.fallback ?? 'other', field);
    case 'enum?': return safeOptionalEnum(value, spec.allowed,
      spec.invalid === undefined ? 'other' : spec.invalid, field);
    case 'count': return safeCount(value, spec.max ?? 1_000_000, spec.fallback ?? null);
    // Optional counts preserve unknown as absent instead of converting null to Number(null) === 0.
    case 'countOpt': return value == null || value === '' ? undefined : safeCount(value, spec.max ?? 1_000_000, undefined);
    case 'ms': return safeMs(value, spec.fallback ?? null);
    // ★ 2026-10-15（jev 诊断字段落盘）· 两个"可选"规格，与上面的 countOpt/boolOpt 同一哲学：
    //   缺省 → **不落键**。为什么不用 id/ms 了事：id 缺省落 ''、ms 缺省落 null，
    //   解析方会把"旧行根本没有这个键"与"这一行没测到"当成两种状态（同一件事三副面孔）；
    //   这两列只该在**真有值**时出现。实现见上面的 safeOptionalMs / safeOptionalId。
    case 'msOpt': return safeOptionalMs(value);
    case 'idOpt': return safeOptionalId(value, spec.max ?? 160);
    case 'num': return safeNum(value, { digits: spec.digits ?? 4, lo: spec.lo ?? null, hi: spec.hi ?? null });
    case 'bool': return safeBool(value);
    case 'bool?': return value === undefined ? null : safeBool(value);
    case 'boolOpt': return value === undefined ? undefined : safeBool(value);
    case 'ids': return safeIdList(value, { max: spec.max ?? 12, maxLen: spec.maxLen ?? 64 });
    case 'usageCalls': return safePerCallUsage(value, { max: spec.max ?? MAX_PER_CALL_USAGE_ROWS });
    case 'modelCalls': return safeModelCallTrace(value, { max: spec.max ?? MAX_MODEL_CALL_TRACE_ROWS });
    case 'requestSegments': return safeRequestSegments(value, { max: spec.max ?? 40 });
    case 'text': return safeText(value, spec.max ?? 500);
    case 'fields': return safeFields(value, { maxKeys: spec.maxKeys ?? 24, maxLen: spec.maxLen ?? 160 });
    default: return undefined;
  }
}
