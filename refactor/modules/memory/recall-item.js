/**
 * M6 memory · 召回条目的**统一形状**（关键词腿 / 语义腿共用这一份）
 *
 * 2026-10-16（用户：删掉的印象还能查到 + 印象要能真的注入）之后的两条事实：
 *   · 语义腿（`coordinator.js` keep.push）原先只带 `personId`，既没有 `subjectId` 也没有 `type`
 *     ⇒ 按人聚合的印象注入（compose/prompt）看不见它，且"按主体过滤"的读侧判据拿不到主体；
 *   · 两条腿各拼一次形状，字段迟早漂开（`memory/index.js` 关键词腿 vs `coordinator.js` 语义腿）。
 *
 * 口径（**不许瞎补**）：
 *   · 只有 `row`（刚重读的权威观察行）里**真的有**的值才带上 —— `type`/`confidence`/`at`/`version`/
 *     `counterEvidenceIds` 等，行上没有这个键就**不出现**这个键（与 `history()` 的纪律一致）；
 *   · `subjectId` 与 `personId` 互为回退（契约里两者同义：`coordinator.js:700` 写明
 *     `personId = it.personId ?? it.subjectId`；关键词腿两个都带）；
 *   · `claim` 取权威行的说法；`evidenceIds`/`sourceIds` 取行的证据编号；
 *   · 本函数是**纯函数**，零 IO、不改入参。
 */

/** 数字字段：只认真数字（不把 null/'' 变 0）。 */
function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 把一条召回候选归一成两腿同形。
 *
 * @param {object} p
 *   · `item` 召回原始项（关键词腿的 retrieve 项 / 语义腿的向量命中）
 *   · `row`  **权威观察行**（`activeObservations()` 里刚重读到的那一行；可空）
 *   · `reason` 这一条为什么进来（人话，给模型/诊断看）
 *   · `source` 'keyword' | 'semantic'（可选，仅标注）
 * @returns {object} 归一后的条目
 */
export function recallItemShape({ item = null, row = null, reason = '', source = '' } = {}) {
  const it = item && typeof item === 'object' ? item : {};
  const r = row && typeof row === 'object' ? row : {};

  const id = String(r.id ?? it.id ?? it.sourceId ?? '');
  const subjectId = String(r.subjectId ?? it.subjectId ?? it.personId ?? '');
  const personId = String(it.personId ?? r.subjectId ?? it.subjectId ?? '');
  const claim = String(r.claim ?? it.claim ?? '');
  const scope = String(r.scope ?? it.scope ?? '');
  const evidenceIds = Array.isArray(r.evidenceIds) ? r.evidenceIds.map(String)
    : (Array.isArray(it.evidenceIds) ? it.evidenceIds.map(String) : []);

  const out = {
    ...it,
    id,
    memoryId: String(it.memoryId ?? id),
    subjectId,
    personId,
    claim,
    scope,
    evidenceIds,
    sourceIds: Array.isArray(it.sourceIds) && it.sourceIds.length ? it.sourceIds.map(String) : evidenceIds,
    reason: String(reason || it.reason || ''),
  };
  if (source) out.source = source;
  // 以下键**只在权威行/原项真的有**时才出现（少一个键 ≠ 补一个 null/默认值）。
  const type = r.type ?? it.type;
  if (type !== undefined && type !== null && String(type)) out.type = String(type);
  const confidence = numOrNull(r.confidence ?? it.confidence);
  if (confidence !== null) out.confidence = confidence;
  const at = numOrNull(r.at ?? it.at);
  if (at !== null) out.at = at;
  if (r.version !== undefined) out.version = r.version;
  else if (it.version !== undefined) out.version = it.version;
  // `counterEvidenceIds`：行上有这个键就带上（**空数组也带**——与关键词腿旧行为一致，别少一个键）。
  if (Array.isArray(r.counterEvidenceIds)) out.counterEvidenceIds = r.counterEvidenceIds.map(String);
  else if (Array.isArray(it.counterEvidenceIds)) out.counterEvidenceIds = it.counterEvidenceIds.map(String);
  if (r.correction !== undefined) out.correction = r.correction;
  if (r.supersedes !== undefined && r.supersedes !== null && out.supersedes === undefined) out.supersedes = r.supersedes;
  if (typeof it.score === 'number') out.score = it.score;
  return out;
}
