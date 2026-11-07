/**
 * M6 memory · 一键清理的三个真实动作（**纯函数层**：候选规划 + 相似度；执行在 `index.js` 的
 * `cleanupAll` 里，因为只有那里握着 store / retract / commit）。
 *
 * 契约来源（逐条对照，不发明新语义）：
 *   · 老树（**优先权威**）：`src/memory.js:1396-1426 dedupeImpressions`（包含去重）、
 *     `:1432-1481 dedupeImpressionsSemantic`（bigram + impressionDupeGate）、
 *     `:1483-1505 refineImpressionTypes`（只动 typeGuess=true 的行）；
 *   · `.tmp-dispatch/2026-10-15/aaf16f9c/r-一键清理缺口.md` 与 `r-清理三动事务边界.md`
 *     （新树最小契约、三键范围、只走 retract/commit、部分失败逐项回报）。
 *
 * 纪律（三动作共用）：
 *   · **只动同 subjectId × scope × chatKey 的行**：不跨人、不跨群、不跨 scope；
 *   · 只处理 `status === 'active'` 且 `type === 'impression'` 的行（其它类型有自己的语义）；
 *   · 人工编辑锁窗口内的 subject **整组跳过**并如实回报（锁在 `manual-edit-lock.js`）；
 *   · 本文件**零 import、零 IO、零时钟**：候选能离线复核；「执行」一律由调用方走账本出口。
 */

/** 逐项预算（老树值 + 回执值；超出部分截断并在结果里如实记账，不静默）。 */
export const CLEANUP_LIMITS = Object.freeze({
  minContainmentChars: 8,        // 老树 `src/memory.js:1409-1410`：被包含的那一侧 ≥8 字才判重复
  maxPairsPerSubject: 500,       // 回执 A：每 subject 最多 500 对
  maxSubjects: 200,              // 每个动作最多扫多少人（超出截断并记账）
  maxApplyPerRun: 200,           // 单次 apply 最多落多少条撤回/升版（防一次扫全库）
  maxTypeCandidates: 500,        // 动作 C 的候选上限（升版比撤回贵，逐项预算）
  // ★ 2026-10-16：模型门的**调用纪律**（由 cleanupAll 强制执行；调用方可用
  //   `gateTimeoutMs` / `gateBudgetMs` 覆盖，0/非法 ⇒ 用这里的默认）。
  gatePerAskTimeoutMs: 8000,     // 单次问门上限（同时把 AbortSignal 递给门 ⇒ 真取消）
  gateTotalBudgetMs: 30000,      // 整次 apply 里问门的总时间预算（HTTP 请求不许无限挂）
  semanticMinSim: 0.22,          // 老树 :1458：`sim < 0.22` 直接跳过（含下界）
  semanticMaxSim: 0.8,           // 老树 :1458：`sim >= 0.8` 也跳过（**上界排他**）
  maxGateAsk: 120,               // 老树 :1432：`maxAsk = 120`
});

/**
 * 印象子类 provenance 枚举 —— 与 `store.js` 的 `IMPRESSION_TYPE_SOURCES` **同源**
 * （本模块零 import ⇒ 照抄字面量；改那边必须同步这里）。
 *   `'model'` = 写这条的模型明确给了子类；`'none'` = 明确没给（**C 的合法候选**）；
 *   `'gate'` = 后来由模型门补判；**没有这个键 = 历史行**（不可反推，C 一律不动）。
 */
export const IMPRESSION_TYPE_SOURCES = Object.freeze(['model', 'none', 'gate']);

/**
 * 去重判据的归一尺 —— **逐字对齐老树 `src/memory.js:1400-1401`**：
 * 小写 + 去掉**所有空白/标点/符号**（`[\s\p{P}\p{S}]+`）。
 *
 * ★ 为什么不写成 `impTextKey`（trim+压空白+小写）：那是 claimKey 的尺（判"说法变没变"），
 *   保留标点 ⇒ `喜欢猫。` 与 `喜欢猫` 会被当成两条。老树去重这里**刻意去标点**（同一句
 *   带不带句号/逗号是同一条），回执 §A 只写了 impTextKey 这个名字、没带正则 —— 以老树为准。
 */
export function cleanupNorm(text) {
  return String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 三键范围（回执的可合并边界）：同 subjectId × scope × chatKey 才算一组。 */
export function cleanupGroupKey(row) {
  return [String(row?.subjectId ?? ''), String(row?.scope ?? ''), String(row?.chatKey ?? '')].join('\u0000');
}

/** 三动作只碰"当前生效的印象行"。 */
export function isCleanupImpression(row) {
  if (!row || row.status !== 'active') return false;
  return String(row.type ?? 'impression') === 'impression';
}

/** 更早的那一行留下：先 createdAt、再 at、再 id 字典序（确定性，同输入必同输出）。 */
function ageRank(row) {
  return [Number(row?.createdAt) || Number(row?.at) || 0, String(row?.id ?? '')];
}
function isOlder(a, b) {
  const [atA, idA] = ageRank(a);
  const [atB, idB] = ageRank(b);
  if (atA !== atB) return atA < atB;
  return idA.localeCompare(idB) < 0;
}

/** 按三键分组（只收 impression 行）；超过 maxSubjects 就截断并记账。 */
function groupImpressions(rows, maxSubjects) {
  const groups = new Map();
  let overflow = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isCleanupImpression(row)) continue;
    const key = cleanupGroupKey(row);
    if (!groups.has(key)) {
      if (groups.size >= maxSubjects) { overflow += 1; continue; }
      groups.set(key, []);
    }
    groups.get(key).push(row);
  }
  return { groups, overflow };
}

/**
 * **动作 A · 模糊包含**（确定性，无需模型）——老树 `dedupeImpressions` 的判据逐字：
 *   `x === n`（归一后同句）**或** 互为包含（**两个方向都判**，被包含/包含的那一侧 ≥ `minChars`）。
 * 保留更早的一行（老树按数组顺序保留先出现的；新树的 active 顺序不保证时间序 ⇒ 显式按
 * `createdAt → at → id` 排序取最早），由调用方 `retract` 更晚的那一行。
 *
 * @param {Array} rows 全部 active 观察（本函数自己筛 impression）
 * @param {{isLocked?: (subjectId: string) => boolean, minChars?: number, maxPairsPerSubject?: number, maxSubjects?: number, excludeDropIds?: Set<string>}} [opts]
 * @returns {{groups:number, pairs:Array<{groupKey:string,keepId:string,dropId:string,reasonCode:string,keepAt:number,dropAt:number}>,
 *            skipped:Array<{subjectId:string,reason:string}>, truncated:{subjects:number,pairs:number}}}
 */
export function planContainmentPairs(rows, opts = {}) {
  const minChars = Math.max(1, Number(opts.minChars) || CLEANUP_LIMITS.minContainmentChars);
  const maxPairsPerSubject = Math.max(1, Number(opts.maxPairsPerSubject) || CLEANUP_LIMITS.maxPairsPerSubject);
  const maxSubjects = Math.max(1, Number(opts.maxSubjects) || CLEANUP_LIMITS.maxSubjects);
  const isLocked = typeof opts.isLocked === 'function' ? opts.isLocked : () => false;
  const excludeDropIds = opts.excludeDropIds instanceof Set ? opts.excludeDropIds : new Set();

  const { groups, overflow } = groupImpressions(rows, maxSubjects);
  const pairs = [];
  const skipped = [];
  let pairsTruncated = 0;
  for (const [groupKey, list] of groups) {
    const subjectId = String(list[0]?.subjectId ?? '');
    if (isLocked(subjectId)) { skipped.push({ subjectId, reason: 'manual-edit-lock' }); continue; }
    const ordered = [...list].sort((a, b) => (isOlder(a, b) ? -1 : 1));
    const dropped = new Set();
    let count = 0;
    for (let i = 0; i < ordered.length; i += 1) {
      const keep = ordered[i];
      const keepId = String(keep.id);
      if (dropped.has(keepId) || excludeDropIds.has(keepId)) continue;
      const a = cleanupNorm(keep.claim);
      if (!a) continue;
      for (let j = i + 1; j < ordered.length; j += 1) {
        const drop = ordered[j];
        const dropId = String(drop.id);
        if (dropped.has(dropId) || excludeDropIds.has(dropId)) continue;
        const b = cleanupNorm(drop.claim);
        if (!b) continue;
        // 老树 :1408-1410：同句，或"被包含/包含"任一方向（较短的一侧 ≥8 字）。
        const same = a === b;
        const contained = (b.length >= minChars && a.includes(b)) || (a.length >= minChars && b.includes(a));
        if (!same && !contained) continue;
        if (count >= maxPairsPerSubject) { pairsTruncated += 1; continue; }
        dropped.add(dropId);
        pairs.push({
          groupKey, keepId, dropId,
          reasonCode: same ? 'normalized-equal' : 'fuzzy-containment',
          keepAt: Number(keep.at) || 0, dropAt: Number(drop.at) || 0,
        });
        count += 1;
      }
    }
  }
  return { groups: groups.size, pairs, skipped, truncated: { subjects: overflow, pairs: pairsTruncated } };
}

/** 二字组集合 —— 老树 `:1437-1442` 同款（**同一把去标点归一尺**，再切 2-gram）。 */
export function bigramsOf(text) {
  const t = cleanupNorm(text);
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

/** bigram Jaccard（老树 :1457：`inter / (a.size + b.size - inter)`）。 */
export function bigramJaccard(a, b) {
  const ga = a instanceof Set ? a : bigramsOf(a);
  const gb = b instanceof Set ? b : bigramsOf(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  const union = ga.size + gb.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * **动作 B · 语义重复候选**（老树 `dedupeImpressionsSemantic` 的中间带）：
 * 同组、排除 A 已覆盖的行，bigram Jaccard 落在 `[0.22, 0.8)`（上界排他，老树 `:1458`）。
 * 只出**候选对**；判 YES/NO 必须由调用方注入模型门。
 * ⚠ 无门时**不许**猜 YES、也不许报"已合并"——老树自己就是 `if (!localJevHasRole('impressionDupeGate')) return 0`。
 * ★ 2026-10-15 实查：**现树没有这条门链** —— `modules/jev/roles.js` 目录只有 5 个角色
 *   （interjectWorth / topicShift / recallAsk / textOnlyJudge / unsentLinesJudge），**没有** `impressionDupeGate`；
 *   `localJev.roles` 白名单里虽有这个名字（`defaults.js:532-533`），但目录没有它 ⇒ `localJevHasRole` 恒 false。
 *   语义卡那边有先例：`semantic-cards.js:10` 明说旧树的 `cardGate + local JEV` **不搬**（JEV 已退役，用户裁定）
 *   ⇒ 本条腿在没有产品裁定前保持 blocked；接线点与两条候选链写在 `cleanupAll` 的
 *   `actions.dedupeSemantic.wiring`。
 */
export function planSemanticPairs(rows, opts = {}) {
  const minSim = Number.isFinite(Number(opts.minSim)) ? Number(opts.minSim) : CLEANUP_LIMITS.semanticMinSim;
  const maxSim = Number.isFinite(Number(opts.maxSim)) ? Number(opts.maxSim) : CLEANUP_LIMITS.semanticMaxSim;
  const maxPairsPerSubject = Math.max(1, Number(opts.maxPairsPerSubject) || CLEANUP_LIMITS.maxPairsPerSubject);
  const maxSubjects = Math.max(1, Number(opts.maxSubjects) || CLEANUP_LIMITS.maxSubjects);
  const isLocked = typeof opts.isLocked === 'function' ? opts.isLocked : () => false;
  const excludeDropIds = opts.excludeDropIds instanceof Set ? opts.excludeDropIds : new Set();

  const { groups, overflow } = groupImpressions(rows, maxSubjects);
  const pairs = [];
  const skipped = [];
  let pairsTruncated = 0;
  for (const [groupKey, list] of groups) {
    const subjectId = String(list[0]?.subjectId ?? '');
    if (isLocked(subjectId)) { skipped.push({ subjectId, reason: 'manual-edit-lock' }); continue; }
    const ordered = [...list].sort((a, b) => (isOlder(a, b) ? -1 : 1));
    const taken = new Set();
    let count = 0;
    for (let i = 0; i < ordered.length; i += 1) {
      const keep = ordered[i];
      const keepId = String(keep.id);
      if (taken.has(keepId) || excludeDropIds.has(keepId)) continue;
      const ga = bigramsOf(keep.claim);
      if (!ga.size) continue;
      for (let j = i + 1; j < ordered.length; j += 1) {
        const drop = ordered[j];
        const dropId = String(drop.id);
        if (taken.has(dropId) || excludeDropIds.has(dropId)) continue;
        const sim = bigramJaccard(ga, bigramsOf(drop.claim));
        if (sim < minSim || sim >= maxSim) continue;
        if (count >= maxPairsPerSubject) { pairsTruncated += 1; continue; }
        taken.add(dropId);
        pairs.push({ groupKey, keepId, dropId, sim: Math.round(sim * 1000) / 1000 });
        count += 1;
      }
    }
  }
  return { groups: groups.size, pairs, skipped, truncated: { subjects: overflow, pairs: pairsTruncated } };
}

/**
 * **动作 C 的候选：只对"新写入且明确没有子类"的行**（`impressionTypeSource === 'none'`）。
 *
 * 与老树的关系（`src/memory.js:1493-1495`：只动 `e.typeGuess === true` 的行）：
 *   新树没有 `typeGuess`，但 **2026-10-16 起写侧带 provenance** —— `act/executors/memory.js` 的
 *   memory_append 落 `impressionType`（模型给的原样子类）与 `impressionTypeSource`
 *   （`'model'` 给了 / `'none'` 没给）⇒ `'none'` 就是"没有子类"的**可靠标记**，等价于老树
 *   "是猜出来的"那一侧。**没有这个键的行 = 历史行：事后不可反推 ⇒ 一律不动**（回执裁定）。
 *
 * 只出候选（带正则 `guess` 供门参考）；判子类必须由调用方注入模型门（`cleanupAll` 的 `typeGate`），
 * 缺门一律 blocked —— 老树同形：`if (!localJevHasRole('impressionTypeGate')) return 0`。
 *
 * @param {Array} rows 全部 active 观察
 * @param {{guess?: Function, isLocked?: (subjectId:string)=>boolean, maxSubjects?: number, maxCandidates?: number}} [opts]
 * @returns {{scanned:number, candidates:Array<{id:string,groupKey:string,subjectId:string,scope:string,chatKey:string,claim:string,guess:string,at:number}>,
 *            skipped:Array<{subjectId:string,reason:string}>, historicalBlocked:number, alreadyTyped:number,
 *            truncated:{candidates:number,subjects:number}}}
 */
export function planTypeRefinements(rows, opts = {}) {
  const isLocked = typeof opts.isLocked === 'function' ? opts.isLocked : () => false;
  const maxSubjects = Math.max(1, Number(opts.maxSubjects) || CLEANUP_LIMITS.maxSubjects);
  const maxCandidates = Math.max(1, Number(opts.maxCandidates) || CLEANUP_LIMITS.maxTypeCandidates);
  const guess = typeof opts.guess === 'function' ? opts.guess : null;
  const { groups, overflow } = groupImpressions(rows, maxSubjects);
  const candidates = [];
  const skipped = [];
  let historicalBlocked = 0;
  let alreadyTyped = 0;
  let truncatedCandidates = 0;
  for (const [groupKey, list] of groups) {
    const subjectId = String(list[0]?.subjectId ?? '');
    if (isLocked(subjectId)) { skipped.push({ subjectId, reason: 'manual-edit-lock' }); continue; }
    for (const row of list) {
      const source = String(row.impressionTypeSource ?? '');
      if (source === 'none') {
        if (candidates.length >= maxCandidates) { truncatedCandidates += 1; continue; }
        candidates.push({
          id: String(row.id), groupKey, subjectId,
          scope: String(row.scope ?? ''), chatKey: String(row.chatKey ?? ''),
          claim: String(row.claim ?? ''), guess: guess ? String(guess(row.claim) ?? '') : '',
          at: Number(row.at) || 0,
        });
        continue;
      }
      if (source === 'model' || source === 'gate') { alreadyTyped += 1; continue; }
      historicalBlocked += 1;   // 没有该键（或值不在枚举里）= 历史行 ⇒ 一律不动
    }
  }
  return {
    scanned: candidates.length + alreadyTyped + historicalBlocked,
    candidates, skipped, historicalBlocked, alreadyTyped,
    truncated: { candidates: truncatedCandidates, subjects: overflow },
  };
}

/**
 * **动作 C 的只读勘测**（`guess` 分布 + 样本）—— 给接线/裁定看的预览，**不是候选、更不是已改**。
 *
 * 前提与执行口径（2026-10-16 实查后更新）：
 *   · 写侧**已有**映射表（`act/executors/memory.js:942-952`：identity/edge/event→fact、style→trait、
 *     preference→preference、attitude→impression）；映射是**有损**的，所以同日已把"模型原始子类 +
 *     provenance"作为新字段落库（`impressionType`/`impressionTypeSource`，见 `store.js`）——
 *     **新行**有可靠来源，**历史行不可反推**。
 *   · 升级只能 `commit + supersedes`；`store.js` 的写序已于同日换成"**先落新行、再标旧版**"
 *     （失败时至少保住旧版，旧版永不物理删除）⇒ 事务前提成立，但**没有 `typeGate` 时仍然 blocked**。
 *   ⇒ 本函数只回勘测（供门/接线判断）；候选在 `planTypeRefinements`，执行在 `cleanupAll`。
 *
 * @param {Array} rows 全部 active 观察
 * @param {{guess: Function, isLocked?: Function, maxSubjects?: number}} opts `guess` = `prompt-format.js:guessImpressionType`
 * @returns {{scanned:number, guessHistogram:Record<string,number>, rows:Array<{id:string,subjectId:string,scope:string,chatKey:string,guess:string}>}}
 */
export function surveyTypeRefinement(rows, opts = {}) {
  const guess = typeof opts.guess === 'function' ? opts.guess : null;
  const isLocked = typeof opts.isLocked === 'function' ? opts.isLocked : () => false;
  const maxSubjects = Math.max(1, Number(opts.maxSubjects) || CLEANUP_LIMITS.maxSubjects);
  const { groups } = groupImpressions(rows, maxSubjects);
  const guessHistogram = {};
  const out = [];
  for (const list of groups.values()) {
    const subjectId = String(list[0]?.subjectId ?? '');
    if (isLocked(subjectId)) continue;
    for (const row of list) {
      if (!guess) continue;
      const g = String(guess(row.claim) ?? '');
      if (!g) continue;
      guessHistogram[g] = (guessHistogram[g] || 0) + 1;
      out.push({ id: String(row.id), subjectId, scope: String(row.scope ?? ''), chatKey: String(row.chatKey ?? ''), guess: g });
    }
  }
  return { scanned: out.length, guessHistogram, rows: out };
}
