/**
 * M4 · `llm/request-budget.js` —— **上线前**的整份请求计量
 *
 * 为什么要有这个文件（2026-10-08 读码确认的起点事实，不是推测）：
 *   · `prompt/budget.js` 只能看见 **组包期**的东西（system 段 + 裁后的用户段）；
 *     它拿到的 `tools` 只是**工具名清单**，真 JSON schema 由 M10（act）拼好，
 *     在 `chatCompletion({ messages, tools })` 这里才第一次变成**真要上线的字节**。
 *   · 所以"这次请求真实带过去的全部内容"这件事，**只有本层能给出权威数字**。
 *
 * 它做什么（纯函数、零副作用、零 IO）：
 *   1. `measureRequestBody(body)` —— 真 body 的字符账：messages / tools / 其余字段分账，
 *      并给出 `wireChars`（= `JSON.stringify(body).length`，即**实际序列化上去的那一坨**）。
 *   2. `recheckRequestBudget(body, budget)` —— 工具结果追加之后再核一次（验收 3 的落点）。
 *   3. `prefixOf(body)` / `prefixStable(a, b)` —— 可缓存前缀 = system 段 + tools（验收 4）。
 *
 * 依赖纪律：本文件**只 import node: 都不需要**，不许 import 任何兄弟模块（README §4 的分层）。
 */

/** 单条消息的 content 字符数：字符串按长度；数组（多模态 parts）按其 JSON 长度算。 */
export function contentChars(content) {
  if (typeof content === 'string') return content.length;
  if (content === null || content === undefined) return 0;
  if (Array.isArray(content)) {
    let n = 0;
    for (const part of content) {
      if (typeof part === 'string') { n += part.length; continue; }
      if (part && typeof part === 'object' && typeof part.text === 'string') n += part.text.length;
      else n += safeJson(part).length;
    }
    return n;
  }
  return safeJson(content).length;
}

function safeJson(v) {
  try { const t = JSON.stringify(v); return typeof t === 'string' ? t : ''; } catch { return ''; }
}

/**
 * 真 body 的字符账。
 *
 * @param {object} body `chatCompletion` 里最终要 `JSON.stringify` 出去的那个对象
 * @returns {{wireChars:number, messageChars:number, toolSchemaChars:number, otherChars:number,
 *            systemChars:number, nonSystemChars:number, messageCount:number, hasTools:boolean,
 *            parts:Array<{part:string,chars:number}>}}
 */
export function measureRequestBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const messages = Array.isArray(b.messages) ? b.messages : [];
  let systemChars = 0;
  let nonSystemChars = 0;
  for (const m of messages) {
    const n = contentChars(m?.content);
    if (m?.role === 'system') systemChars += n;
    else nonSystemChars += n;
  }
  const toolSchemaChars = b.tools == null ? 0 : safeJson(b.tools).length;
  const wireChars = safeJson(b).length;
  const messageChars = systemChars + nonSystemChars;
  const otherChars = Math.max(0, wireChars - messageChars - toolSchemaChars);
  return {
    wireChars,
    messageChars,
    toolSchemaChars,
    otherChars,
    systemChars,
    nonSystemChars,
    messageCount: messages.length,
    hasTools: Array.isArray(b.tools) ? b.tools.length > 0 : b.tools != null,
    parts: [
      { part: 'system', chars: systemChars },
      { part: 'messages(non-system)', chars: nonSystemChars },
      { part: 'tools', chars: toolSchemaChars },
      { part: 'other-fields', chars: otherChars }
    ]
  };
}

/**
 * 整份请求预算：真 body 对 `maxTotalChars` 的判定。
 *
 * ★ 与 prompt 侧那道闸**不是同一个数**：这里数的是 `wireChars`（连 `model`/`temperature`
 *   这些字段的键名都算进去），prompt 侧数的是内容字符。两者都对，但**不要互相替代**。
 *
 * @param {object} body
 * @param {{maxTotalChars?:number}} [budget]
 * @returns {{over:boolean, limit:number|null, wireChars:number, overflowChars:number, measurement:object}}
 */
export function recheckRequestBudget(body, budget = {}) {
  const limit = Number(budget?.maxTotalChars) > 0 ? Number(budget.maxTotalChars) : null;
  const measurement = measureRequestBody(body);
  const overflowChars = limit === null ? 0 : Math.max(0, measurement.wireChars - limit);
  return { over: overflowChars > 0, limit, wireChars: measurement.wireChars, overflowChars, measurement };
}

/**
 * 可缓存前缀 = **system 段 + tools**（验收 4：前缀字节稳定）。
 *
 * 指纹相同仅说明system与tools字节一致；实际缓存是否命中以供应商usage为准。
 * ⚠ 只报告不修：把 volatile 内容挪出 system 是组装层（M8b `prompt/index.js`）的构图决定，
 *   本层不越权改；本层只负责"能不能命中"这件事有个可测的判据。
 *
 * @returns {{fingerprint:string, prefixChars:number, systemChars:number, toolSchemaChars:number}}
 */
export function prefixOf(body) {
  const b = body && typeof body === 'object' ? body : {};
  const messages = Array.isArray(b.messages) ? b.messages : [];
  const systemChars = messages.filter((m) => m?.role === 'system').reduce((n, m) => n + contentChars(m?.content), 0);
  const toolSchemaChars = b.tools == null ? 0 : safeJson(b.tools).length;
  const head = `${messages.filter((m) => m?.role === 'system').map((m) => (typeof m?.content === 'string' ? m.content : safeJson(m?.content))).join('\n')}\u0000${safeJson(b.tools ?? null)}`;
  return { fingerprint: hash32(head), prefixChars: head.length, systemChars, toolSchemaChars };
}

/** 两次请求的前缀是否逐字节相同。 */
export function prefixStable(bodyA, bodyB) {
  const a = prefixOf(bodyA);
  const b = prefixOf(bodyB);
  return { stable: a.fingerprint === b.fingerprint, a, b };
}

/**
 * ★ A55 ④：**缓存用量读数，区分「供应商未报告」与「确认是 0」**。
 *
 * ## 为什么不复用 `cache-keepalive.js` 的 `readUsageNumbers`
 * 那个函数的 `num()` 有两个特点：找不到就返回 **0**，而且只在 `n > 0` 时才认。
 * ⇒ 「供应商明确报告命中 0」与「压根没这个字段」**都变成 0**。
 * 这正是本票 ★★ 点名的问题：**把未知写成 0**，看的人没法判断该不该继续优化。
 *
 * ## 本函数的契约
 *   · 数字字段一律是 `number`（供应商真的报了）或 **`null`（没报）**；
 *   · **绝不**用 0 代替"没报"，也**绝不**拿别的字段推算缺失的 miss；
 *   · `reported.*` 逐字段给出布尔判定，调用方不必自己再猜。
 *
 * ## 为什么不放在 `cache-keepalive.js` 里
 * `llm.js` / `cache-keepalive.js` / `providers.js` / `model-prices.js` 是**从 `src/` 搬来的受管副本**，
 * `modules/llm/selftest.mjs` 有一条机器闸门要求它们与 `src/<同名>` 的行差异**只许**落在
 * 「静态 import / 动态 import 说明符 / 注释」三类白名单里，加真实代码 = 硬失败（实测 47 条硬失败）。
 * `request-budget.js` 是**新树新增**文件（`src/` 无对应物）⇒ 改它不触发那条闸门。
 *
 * @param {object} [usage] `chatCompletion` 返回的 `result.usage`（**接口原始结构**，见 llm.js `usage: data.usage ?? null`）
 * @returns {{prompt_tokens:number|null, prompt_cache_hit_tokens:number|null,
 *            prompt_cache_miss_tokens:number|null, cache_creation_tokens:number|null,
 *            reported:{prompt_tokens:boolean, prompt_cache_hit_tokens:boolean,
 *            prompt_cache_miss_tokens:boolean, cache_creation_tokens:boolean}}}
 */
export function readCacheUsageReport(usage = {}) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const details = u.prompt_tokens_details || u.promptTokensDetails || u.input_tokens_details || {};
  // 只接受"供应商真给了的数"：null/undefined/空串/布尔一律当作**没报**
  const reported = (...values) => {
    for (const value of values) {
      if (value === null || value === undefined || value === '' || typeof value === 'boolean') continue;
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) return n;      // ★ >= 0：0 是合法读数，必须留住
    }
    return null;
  };
  const fields = {
    prompt_tokens: reported(u.prompt_tokens, u.promptTokens, u.input_tokens, u.inputTokens),
    // DeepSeek 官方（自动前缀缓存）；Anthropic 兼容 / Responses 风格
    prompt_cache_hit_tokens: reported(u.prompt_cache_hit_tokens, u.cachedTokens, u.cached_tokens,
      details.cached_tokens, details.cachedTokens, u.cache_read_input_tokens, u.cache_read_tokens),
    prompt_cache_miss_tokens: reported(u.prompt_cache_miss_tokens, u.cacheMissTokens),
    cache_creation_tokens: reported(u.cacheCreationTokens, u.cache_creation_input_tokens,
      details.cache_creation_input_tokens, details.cacheCreationInputTokens,
      u.cache_write_tokens, details.cache_write_tokens)
  };
  const flags = {};
  for (const [key, value] of Object.entries(fields)) flags[key] = value !== null;
  return { ...fields, reported: flags };
}

/**
 * ★ A55 ④：把读数渲染成**一行**日志，明确写出每个字段是「未报告」还是具体数字。
 * `0` 会显式写成 `0`（确认零），`null` 写成 `未报告` —— 两者在日志里绝不混淆。
 *
 * @param {ReturnType<typeof readCacheUsageReport>} report
 * @returns {string}
 */
export function formatCacheUsageLine(report = {}) {
  const show = (key, label) => {
    const value = report?.[key];
    return `${label}=${value === null || value === undefined ? '未报告' : value}`;
  };
  return `缓存用量 ${show('prompt_cache_hit_tokens', 'hit')} ${show('prompt_cache_miss_tokens', 'miss')} `
    + `${show('cache_creation_tokens', 'write')} ${show('prompt_tokens', 'prompt')}`;
}

/**
 * ★ A55 ③④：**最终请求**的一次性观测（请求侧指纹 + 响应侧缓存用量）。
 *
 * 这是给「最终发送处」准备好的**纯函数**：调用方拿到 payload 与 usage 各调一次即可，
 * 不必自己拼「哪一段变了 + 缓存有没有命中」。
 * ⚠ 只观测：不改 payload、不推算缺失字段、不因为观测失败影响投递。
 *
 * @param {object} body 最终要 `JSON.stringify` 出去的那个对象
 * @param {object} [usage] 该次调用的 `result.usage`
 * @returns {{prefixFingerprint:string, systemChars:number, toolSchemaChars:number, wireChars:number,
 *            messageCount:number, hasTools:boolean, cache:object, cacheLine:string}}
 */
export function observeFinalRequest(body, usage) {
  const prefix = prefixOf(body);
  const measured = measureRequestBody(body);
  const cache = readCacheUsageReport(usage);
  return {
    prefixFingerprint: prefix.fingerprint,
    systemChars: prefix.systemChars,
    toolSchemaChars: prefix.toolSchemaChars,
    wireChars: measured.wireChars,
    messageCount: measured.messageCount,
    hasTools: measured.hasTools,
    cache,
    cacheLine: formatCacheUsageLine(cache)
  };
}

/**
 * ★ A55 ③ 的读侧配套：工具序列指纹。
 *
 * `prefixOf` 的指纹把 `system + tools` 一起哈希，其中 **tools 数组的顺序参与哈希** ——
 * 所以「工具序列是否逐字节一致」这件事，可以直接用同一个判据回答，
 * 不必另设一套口径。同一权限集合下顺序固定 ⇒ 该指纹稳定；权限变了 ⇒ 允许它变。
 *
 * @param {Array<object>} tools `act.registry()` 给出的工具定义数组
 * @returns {{fingerprint:string, names:string[], count:number}}
 */
export function toolSequenceFingerprint(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const names = list.map((t) => String(t?.name ?? ''));
  return { fingerprint: hash32(safeJson(list)), names, count: list.length };
}

/** 32 位 FNV-1a：只为「一样/不一样」，不用于安全。 */
function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
