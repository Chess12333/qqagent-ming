/**
 * M4 · `llm/final-body.js` —— **上线前**的"最终请求"观测缝（N49）
 *
 * ★ 为什么需要这个文件（2026-10-09 指挥位裁定，走 (b) 回调缝，不走 (a) 改返回契约）：
 *   `chatCompletion()` 真正 `fetch` 出去的那个 body，是**组装 + 重试 + 剥离**之后的产物：
 *     `llm.js:604` `send(body)` → 可能被 retry 变换改写（`:615`）→ 可能被 strip 图片（`:625`）
 *     → 可能被剥 thinking / cache_control（`:648` 附近）
 *   而它**只回 `{message, finishReason, usage, model, raw}`**，调用方拿到的 `{messages, tools}`
 *   与实际发送体不是同一个东西。⇒ "缓存标记到底有没有真发出去"这件事，**只有这里能给出权威答案**
 *   （用户早先问过"命中率为什么低、是不是没打标记"）。
 *
 * ★ 三条铁律（指挥位 §2，逐条对应）：
 *   1) **纯观测、默认 no-op**：`emitFinalBody` 在没传回调时什么都不做；传了也只"多一次调用"，
 *      **绝不影响组装 / 重试 / 剥离 / 投递**（内部 try/catch 吞掉一切，观测坏了不许拖垮请求）。
 *   2) **交给回调前必须脱敏**：`sanitizeFinalBody()` 递归剔除密钥形状字段、把超长字符串截断，
 *      并且**只给副本**（回调拿到的东西被改坏也不影响真实 body）。
 *   3) **不给受管副本加逻辑以外的任何东西**：本文件是 EXTRA（`src/` 无对应物），
 *      受管副本 `llm.js` 只多一行 `emitFinalBody(payload, onFinalBody);`（登记在 selftest 的
 *      `AUTHORIZED_DEVIATIONS` 里，闸门照旧）。
 *
 * 依赖纪律：本文件**只 import node: 都不需要**，零副作用、零 IO。
 */

/** 密钥形状的键名（大小写不敏感命中即整支剔除，连同它的值）。 */
const SECRET_KEYS = new Set([
  'apikey', 'api_key', 'key', 'authorization', 'auth', 'token', 'accesstoken', 'access_token',
  'refreshtoken', 'refresh_token', 'secret', 'password', 'bearer', 'cookie', 'sessiontoken',
  'x-api-key', 'x-goog-api-key'
]);

/** 单个字符串字段的最大长度（超出截断并标注原长；`cache_control` 这类小对象不受影响）。 */
const MAX_STRING_CHARS = 400;

function isSecretKey(k) {
  return SECRET_KEYS.has(String(k ?? '').toLowerCase());
}

function clipString(s, maxChars = MAX_STRING_CHARS) {
  const t = String(s ?? '');
  if (!Number.isFinite(maxChars) || maxChars < 0 || t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}…（共 ${t.length} 字符，已截）`;
}

/**
 * 脱敏副本：深拷贝 + 剔密钥 + 截长串。
 * @param {*} value 任意 JSON 形态
 * @param {number} [depth] 递归深度护栏（防自引用/异常形状把观测本身搞垮）
 * @param {{maxStringChars?:number,inTools?:boolean,inSchemaProperties?:boolean}} [options]
 */
export function sanitizeFinalBody(value, depth = 0, options = {}) {
  if (depth > 12) return '…（结构过深，未展开）';
  if (value === null || value === undefined) return value;
  const maxStringChars = options.maxStringChars ?? MAX_STRING_CHARS;
  if (typeof value === 'string') return clipString(value, maxStringChars);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeFinalBody(v, depth + 1, options));
  if (typeof value !== 'object') return String(value);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    // JSON Schema property names such as "token" are part of the tool contract,
    // not secret values. Preserve the schema while still redacting secret-shaped
    // fields everywhere else in the request.
    if (isSecretKey(k) && !options.inSchemaProperties) { out[k] = '«已脱敏»'; continue; }
    const childOptions = {
      ...options,
      inTools: options.inTools === true || (depth === 0 && k === 'tools'),
      inSchemaProperties: options.inSchemaProperties === true
        || (options.inTools === true && k === 'properties')
    };
    out[k] = sanitizeFinalBody(v, depth + 1, childOptions);
  }
  return out;
}

/**
 * `cache_control` 到底在哪：逐块点名（system / 第几条 user / 哪个工具）。
 *
 * 这是本文件最要紧的出口 —— 它回答的是"标记有没有真发出去、发在哪个块上"，
 * 而不是"配置里开着没有"（配置开着 ≠ 真发；端点不支持 / 被 fallback 剥掉都不会有）。
 *
 * @param {object} body 最终要发送的那个对象
 * @returns {{present:boolean, system:boolean, messageHits:Array<{index:number,role:string}>,
 *            toolHits:Array<{index:number,name:string}>, blocks:number, markerCount:number,
 *            positions:Array<object>, raw:string[]}}
 */
export function cacheControlFacts(body) {
  const b = body && typeof body === 'object' ? body : {};
  const messages = Array.isArray(b.messages) ? b.messages : [];
  const tools = Array.isArray(b.tools) ? b.tools : [];
  const messageHits = [];
  let system = false;
  const positions = [];
  messages.forEach((m, index) => {
    const role = String(m?.role ?? '?');
    if (hasMarker(m)) {
      messageHits.push({ index, role });
      if (role === 'system') system = true;
    }
    if (m && typeof m === 'object' && m.cache_control != null) {
      positions.push({ kind: 'message', messageIndex: index });
    }
    if (Array.isArray(m?.content)) {
      m.content.forEach((part, partIndex) => {
        if (part && typeof part === 'object' && part.cache_control != null) {
          positions.push({ kind: 'message_part', messageIndex: index, partIndex });
        }
      });
    }
  });
  const toolHits = [];
  tools.forEach((t, index) => {
    if (hasMarker(t)) toolHits.push({ index, name: String(t?.function?.name ?? t?.name ?? '?') });
    if (t && typeof t === 'object' && t.cache_control != null) {
      positions.push({ kind: 'tool', toolIndex: index });
    }
    if (t?.function && typeof t.function === 'object' && t.function.cache_control != null) {
      positions.push({ kind: 'tool_function', toolIndex: index });
    }
  });
  const raw = [];
  if (messageHits.length) raw.push(`messages:${messageHits.map((h) => `#${h.index}(${h.role})`).join(',')}`);
  if (toolHits.length) raw.push(`tools:${toolHits.map((h) => `#${h.index}(${h.name})`).join(',')}`);
  return {
    present: messageHits.length + toolHits.length > 0,
    system,
    messageHits,
    toolHits,
    blocks: messageHits.length + toolHits.length,
    markerCount: positions.length,
    positions,
    raw
  };
}

/**
 * 一个块（message / tool / part）上有没有 `cache_control` 标记。
 * 三个位置都算（与 `llm.js` 的 `stripCacheMarkers` / `stripToolsCacheControl` 剥的三个位置对齐：
 * 整块上、`content[]` 的 part 上、`function` 里）—— 少认一个位置就会把"其实发了"报成"没发"。
 */
function hasMarker(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.cache_control != null) return true;
  if (Array.isArray(node.content)) {
    if (node.content.some((p) => p && typeof p === 'object' && p.cache_control != null)) return true;
  }
  const fn = node.function;
  if (fn && typeof fn === 'object' && fn.cache_control != null) return true;
  return false;
}

/** 一行可核的话：标记在不在、在哪。 */
export function formatCacheControlLine(facts) {
  const f = facts && typeof facts === 'object' ? facts : cacheControlFacts(null);
  if (!f.present) return 'cache_control：一个都没有（这个请求没打任何缓存标记）';
  const where = f.raw.join(' + ');
  return `cache_control：有 ${f.blocks} 处（${where}）`;
}

/**
 * 观测一次最终发送体。**纯观测**：不返回值、不改任何东西、不抛任何东西。
 *
 * @param {object} body 最终要 `JSON.stringify` 出去的那个对象
 * @param {Function|null} [onFinalBody] 调用方给的回调；不是函数就整个跳过
 *   `onFinalBody.fullTextSnapshot === true` 时，对回调给完整字符串副本（仍递归脱敏）；默认仍截为 400 字符。
 * @param {object} [opts] 可选观测载荷；没有就一个字段都不加（保持向后兼容）
 * @param {object} [opts.capability] 这个端点的能力裁决（`capabilityFactsFor()` 的返回值，已序列化安全）
 *   **只观测**：没有回调就不算、不塞；就算塞了，异常也全程兜住。
 * @returns {{seen:boolean}} 只用来给自测/探针断言"这一刀有没有被看到"
 */
export function emitFinalBody(body, onFinalBody, opts = {}) {
  if (typeof onFinalBody !== 'function') return { seen: false };
  try {
    const safe = sanitizeFinalBody(body, 0, {
      maxStringChars: onFinalBody.fullTextSnapshot === true ? Number.POSITIVE_INFINITY : MAX_STRING_CHARS
    });
    const facts = {
      cacheControl: cacheControlFacts(body),
      cacheLine: formatCacheControlLine(cacheControlFacts(body)),
      wireChars: safeJson(body).length
    };
    if (opts && opts.capability && typeof opts.capability === 'object') facts.capability = opts.capability;
    onFinalBody(safe, facts);
    return { seen: true };
  } catch {
    // 观测绝不许影响一次模型请求（老树 reportTraceEvent 的同一条纪律）
    return { seen: false };
  }
}

function safeJson(v) {
  try { const t = JSON.stringify(v); return typeof t === 'string' ? t : ''; } catch { return ''; }
}

/* ══════════════════════════════════════════════════════════════════════════════
 * `api.costGuard` 的纯判定。
 * 调用方传入观测账本聚合出的自然日 prompt+completion token 数与配置；这里不读盘，
 * 只有严格超过单一日上限时才要求裁减可选注入。
 * ══════════════════════════════════════════════════════════════════════════════ */

const DAY_DEFAULT = 30_000_000;

/**
 * 日 token 护栏的纯判定。只在当日 prompt+completion token 严格超过配置值时触发。
 *
 * @param {{dayTokens:number}} totals 已累加好的当日 token 总量
 * @param {object} [guard] `api.costGuard` 配置段
 * @returns {{reduced:boolean, reason:string, dayTokens:number,
 *            limits:{enabled:boolean, dayTokenMax:number}}}
 */
export function costGuardVerdict(totals = {}, guard = {}) {
  const g = guard && typeof guard === 'object' ? guard : {};
  if (g.enabled === false) {
    return { reduced: false, reason: 'off', dayTokens: 0, limits: { enabled: false, dayTokenMax: 0 } };
  }
  // dayPromptMax remains a read-only compatibility fallback for existing user config.
  // Its value has always been a token count; the active contract now counts all daily tokens.
  const configuredMax = g.dayTokenMax ?? g.dayPromptMax ?? DAY_DEFAULT;
  const parsedMax = Number(configuredMax);
  const dayMax = Number.isFinite(parsedMax) && parsedMax >= 0 ? parsedMax : DAY_DEFAULT;
  const dayTokens = Math.max(0, Number(totals?.dayTokens) || 0);
  const reduced = dayMax > 0 && dayTokens > dayMax;
  return {
    reduced,
    reason: reduced ? `day-token-limit-exceeded:${dayMax}` : '',
    dayTokens,
    limits: { enabled: true, dayTokenMax: dayMax }
  };
}

/** 可选注入只在日 token 已严格超限后削减；到达或接近上限都不干预。 */
export function shouldReduceOptionalInjects(totals = {}, guard = {}) {
  const g = guard && typeof guard === 'object' ? guard : {};
  if (g.enabled === false) return { reduce: false, reason: 'off' };
  const verdict = costGuardVerdict(totals, guard);
  return { reduce: verdict.reduced, reason: verdict.reason };
}

/** 每日护栏状态的纯形状，token 总量不混用请求数/字符数。 */
export function costGuardStatsShape({ day = '', totalTokens = 0, chats = 0 } = {}) {
  return { day: String(day ?? ''), totalTokens: Math.max(0, Number(totalTokens) || 0), chats: Math.max(0, Number(chats) || 0) };
}
