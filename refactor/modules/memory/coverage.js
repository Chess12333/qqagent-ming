/**
 * M6 memory · coverage 的唯一形状（唯一指导 §6.2 / §6.3，2026-10-14 M2）
 *
 * coverage 只回答一个问题：**这一轮读到的东西全不全**。
 * 七键由本文件一处定义（§6.2 逐字：state、sourceHighWater、processedThrough、pendingCount、
 * failedCount、scope、generation），三个读出口 —— `coordinator.prepareContext()`、
 * `index.retrieve()`、`chat-search.searchChatMessages()` —— 都调 `buildCoverage()`，
 * 不在各自文件里再写一份形状（§6.3「不同用途选择字段和范围，不复制检索算法」）。
 *
 * ★ **填不出来的键写 `null`，并把名字落进 `unmeasured`**。
 *   写 0 会被读成"测出来确实是 0"（§6.2 明令不许把跳过说成整理成功，反向也一样：
 *   没测的数不能报成像测出来的 0）。
 * ★ **水位用来源追加时刻**（证据行的 `at` / 存档行的 `ts`，单位一致才相减得出差多少）；
 *   时间只供展示，§6.2 不许拿"到昨天了"当内容完整性的证明。
 *
 * 纯函数：不读盘、不调 `Date.now()`。
 */

export const COVERAGE_KEYS = Object.freeze([
  'state', 'sourceHighWater', 'processedThrough', 'pendingCount', 'failedCount', 'scope', 'generation',
]);

/** `state` 只有这三档，判据由各读出口给出，本文件只校验取值合法。 */
export const COVERAGE_STATES = Object.freeze(['complete', 'partial', 'degraded']);

/**
 * `generation` 读不出来时，**为什么**读不出来（2026-10-14 裁定）。
 *
 * ★ `'none'` 这种值不许出现：它会被读成"确实没有代次"，而事实往往是"**这条腿还没接**" ——
 *   两件事不能共用一个值，所以代次只放代次（`generation`），成因放这里（`generationState`）。
 *   · `measured`   —— `generation` 有真代次字符串
 *   · `not-wired`  —— 这个出口根本没接语义（向量）这条腿，或装配层没注入它
 *   · `unreported` —— 接了，但它没报出代次（旧的注入形状）
 */
export const COVERAGE_GENERATION_STATES = Object.freeze(['measured', 'not-wired', 'unreported']);

/**
 * 占位串不当代次用（2026-10-14 裁定）：`'none'` / `'unknown'` 这类词一旦被写成代次，
 * 读的人就分不出"确实没有代次"和"这条腿还没接"。传进来也不认，照样按空处理。
 */
const GENERATION_PLACEHOLDERS = Object.freeze(['none', 'null', 'undefined', 'unknown', 'n/a']);

/**
 * 数值：测得出来就照给，测不出来给 `null`（不默认成 0）。
 * ★ `Number(null)` 是 0、`Number('')` 也是 0 —— 不在这里挡住，"没测"就会被读成"测出来是 0"。
 */
function measure(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 代次：只认真代次字符串；空值和占位串都算"没测出来"（成因另走 `generationState`）。 */
function generationOf(value) {
  if (typeof value !== 'string') return null;
  const g = value.trim();
  if (!g || GENERATION_PLACEHOLDERS.includes(g.toLowerCase())) return null;
  return g;
}

function scopeOf(scope = {}) {
  return {
    accountId: String(scope?.accountId ?? ''),
    kind: String(scope?.kind ?? ''),
    chatKey: String(scope?.chatKey ?? ''),
  };
}

/**
 * @param {object} input
 * @param {string} input.state             complete / partial / degraded（非法取值一律按 degraded 报）
 * @param {number|string} [input.sourceHighWater]  本范围可用的来源前沿（来源追加时刻）
 * @param {number|string} [input.processedThrough] 已获得明确处理结果的来源前沿
 * @param {number} [input.pendingCount]    还排着没出结果的条数
 * @param {number} [input.failedCount]     隔离出来的失败条数
 * @param {object} input.scope             { accountId, kind, chatKey }
 * @param {string} [input.generation]      本次数字所属的向量索引代次（§6.5「换模型时建立新 generation」）；
 *                                         **拿不到就给空**，别给 `'none'` 之类的占位串
 * @param {string} [input.generationState] `generation` 为空时的成因：`not-wired` / `unreported`（默认 `unreported`）
 * @param {number|string} [input.lastSuccessfulThrough] 最后一次**真出过结果**的批次到的位置
 * @param {string} [input.stateReason]     为什么不是 complete（给面板/排障一句话）
 * @param {string[]} [input.reasons]       其它如实附注
 * @returns {object} 七键齐全的对象；没测的键值为 `null` 且名字在 `unmeasured` 里
 */
export function buildCoverage(input = {}) {
  const state = COVERAGE_STATES.includes(input.state) ? input.state : 'degraded';
  const values = {
    sourceHighWater: measure(input.sourceHighWater),
    processedThrough: measure(input.processedThrough),
    pendingCount: measure(input.pendingCount),
    failedCount: measure(input.failedCount),
  };
  const unmeasured = Object.entries(values).filter(([, v]) => v === null).map(([k]) => k);
  const generation = generationOf(input.generation);
  if (generation === null) unmeasured.push('generation');
  // 代次为空时把"为什么空"单独说清；调用方写 `measured` 但没给代次不算数，按 `unreported` 报。
  const generationState = generation !== null
    ? 'measured'
    : (COVERAGE_GENERATION_STATES.includes(input.generationState) && input.generationState !== 'measured'
      ? input.generationState
      : 'unreported');
  return {
    state,
    sourceHighWater: values.sourceHighWater,
    processedThrough: values.processedThrough,
    pendingCount: values.pendingCount,
    failedCount: values.failedCount,
    scope: scopeOf(input.scope),
    generation,
    generationState,
    // §6.2 那条附注要求的第三个水位：只有"确实出过结果"的批次才推到这儿，
    // 被拒收而跳过的那一批**不**推进它 ⇒ 与 processedThrough 一比就能看出"整理成功"和"跳过"的差。
    lastSuccessfulThrough: measure(input.lastSuccessfulThrough),
    stateReason: String(input.stateReason ?? ''),
    // 本次没测的项点名报出来，读的人不会把 null 当成"数为 0"。
    unmeasured,
    reasons: Array.isArray(input.reasons) ? input.reasons.map(String) : [],
  };
}
