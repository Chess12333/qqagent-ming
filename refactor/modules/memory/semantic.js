/**
 * refactor/modules/memory/semantic.js — 记忆语义召回（阶段 M · 向量进记忆系统）
 * 票 M-1 / MS1 · L1
 *
 * 核心不变量与纪律（来源：票-MS1-记忆语义召回.md、向量合同-v0.md、整合-JEV向量与三块计划-20261007.md）：
 *   ① scope 在打分之前过滤；同文本不同 scope 不许互相命中
 *   ② 过去时刻查询（at 给定时）输入只能含 at <= eventAt 的证据
 *   ③ 相似度不许冒充概率：score 当 score，永远不许写进 JEV 的 p，也不许当 confidence 往上抛
 *   ④ 语义不可用时必须显式降级：退回关键词召回 + 标注"语义召回不可用"；不许伪装成向量成功；不许静默返回空
 *   ⑤ threshold 由调用方给；库里不许自拍阈值。未校准时一律 low-confidence + pSource:'unknown'
 *   ⑥ 观察账本真路径：<dataDir>/memory/observations.jsonl（严禁碰老树 memory-v2/）
 *   ⑦ 多版本观察：只取当前版本，旧版本不许进索引（防"上一版语义复活"）
 *   ⑧ 溯源与拒绝：缺 evidenceIds 或 scope 拒收，且不写进索引
 *   ⑨ 向量准入（唯一指导 §6.4，2026-10-15 luna2 收口）：只对**稳定长期类型**建索引
 *      （impression / trait / preference / fact）；仍是逐条变化的工作窗口
 *      （topic / promise / question / recent）**不进向量索引** —— 它们的读取照旧走
 *      关键词/近况路径（working-window.js），本改动不碰读侧。隔离走 `isolated` /
 *      `isolationReasons`（不是 rejected：coordinator 见 rejected>0 会整次重建报错）。
 *   ⑩ 2026-10-17（向量底座收口）：派生记录的**来源类型/类型/stable 元数据**随索引保存并在
 *      检索结果里透出（真索引分支也走同一套时间/类型权重与类型配额；score 仍只是余弦，
 *      加权值只以 weight/weightedScore 并列输出）。`createMemorySemanticRecall().sync(records,
 *      {complete,batchSize,signal})` 是**同代常规增量路径**：按 id+内容签名复用向量、只对改过的
 *      文本重新嵌入；`complete:true` 且无拒收才按缺席删除，失败/取消/空集合都不清索引。
 */

import {
  makeProfile,
  createIndex,
  createMemoryStore,
  EMBEDDING_DIMENSIONS,
  isProfileVerified,
  profileFingerprint,
  cosineSimilarity,
  validateDimensions
} from '../../core/vector/index.js';
import { OBS_TYPES } from './store.js';
import { SHORT_TERM_TYPES } from './working-window.js';
import { crossScopeSubjects } from './scope.js';

const READ_FAILURE_STATUSES = new Set([
  'not-ready', 'timeout', 'cancelled', 'version-incompatible', 'stale', 'partial-coverage', 'error'
]);
const READ_STATUSES = new Set(['success', 'empty', ...READ_FAILURE_STATUSES]);

function failureStatus(result) {
  return READ_FAILURE_STATUSES.has(result?.status) ? result.status : 'error';
}

function thrownStatus(error) {
  if (error?.name === 'AbortError') return 'cancelled';
  if (/timeout/i.test(String(error?.message || error))) return 'timeout';
  return 'error';
}

function embedFailureReason(stage, result, error = null) {
  const detail = error?.message || error || result?.reason || `embed ${stage} failed`;
  return `embed ${stage} failed (${failureStatus(result)}): ${String(detail)}`;
}

// ── 1. 观察转向量化记录（多版本过滤 + 校验拒收 + §6.4 向量准入）──────────────

/**
 * §6.4 首版向量准入（唯一指导-20261012 §6.4：「类型为事实/偏好/封存经历、不是仍逐条变化的
 * 工作窗口」）。实现 = `OBS_TYPES` **减去** `SHORT_TERM_TYPES` —— 两个集合都取各自真源
 * （store.js:36 / working-window.js:40），这里不写第二份类型名单：
 *   · 收：impression / trait / preference / fact（长期稳定条目）
 *   · 不收：topic / promise / question / recent（对话状态/承诺/待答问题/刚发生的事 —— 逐条变化）
 * ⚠ 为什么不收工作窗口：它们的正确读取路径是关键词/近况（working-window.js 的年龄闸），
 *   进向量索引只会让"上一版近况"以语义相似复活（与文件头⑦同因），并白付嵌入与索引成本。
 * ⚠ 为什么用 isolated 而不是 rejected：`coordinator.rebuildSemanticIndex` 见
 *   `rejected.length > 0` 会**整次重建报错**（coordinator.js:157-166）—— 工作窗口是正常数据，
 *   不许把重建打成失败；隔离计数与原因走既有 `isolated` / `isolationReasons`（与 superseded/retracted 同账）。
 */
export const VECTOR_ADMITTED_TYPES = Object.freeze(
  OBS_TYPES.filter((t) => !SHORT_TERM_TYPES.includes(t))
);

/**
 * 观察（多版本） -> 派生的可向量化记录
 * 规则：
 *   - 缺 evidenceIds 或 scope => 拒收（返回 rejected + reason），不许静默丢
 *   - 多版本观察：只取当前版本（旧版本不许进索引，防"上一版语义复活"）
 *   - §6.4 向量准入：类型不在 `VECTOR_ADMITTED_TYPES`（工作窗口/未知类型）=> 隔离
 *     （isolated + isolationReasons），不进索引、不参与 rejected（见常量注释）
 *
 * @param {Array<object>} observations - 观察列表
 * @param {object} [options]
 * @param {string} [options.generation='gen-1']
 * @param {string} [options.profileVersion='v1']
 * @param {string} [options.labelSchemaVersion='labels-v1']
 * @returns {{ ok: boolean, records: Array<object>, rejected: Array<object>, reasons: Array<string>, isolated: number, isolationReasons: Array<string> } & Iterable<object>}
 */
export function observationToRecords(observations, {
  generation = null,
  profileVersion = null,
  labelSchemaVersion = null
} = {}) {
  const obsList = Array.isArray(observations) ? observations : [];
  const records = [];
  const rejected = [];
  const isolatedCounts = new Map();

  // 1. 第一遍扫描：收集版本取代关系与被废弃的 ID
  const supersededIds = new Set();
  const retractedIds = new Set();
  const claimKeyMap = new Map(); // claimKey -> latest active obs

  for (const obs of obsList) {
    if (!obs || typeof obs !== 'object') continue;
    const id = String(obs.id ?? '');
    if (!id) continue;

    if (obs.status === 'superseded') {
      supersededIds.add(id);
    }
    if (obs.status === 'retracted') {
      retractedIds.add(id);
    }
    if (obs.supersedes) {
      supersededIds.add(String(obs.supersedes));
    }
    if (obs.supersededBy) {
      supersededIds.add(id);
    }
  }

  // 2. 第二遍扫描：过滤旧版本，严格校验必要字段
  for (const obs of obsList) {
    if (!obs || typeof obs !== 'object') {
      rejected.push({ observation: obs, reason: 'observation must be an object' });
      continue;
    }

    const id = String(obs.id ?? '');
    if (!id) {
      rejected.push({ observation: obs, reason: 'observation missing id' });
      continue;
    }

    // 多版本隔离：已废弃或撤销的版本绝不进入向量索引
    if (supersededIds.has(id)) {
      isolatedCounts.set('superseded', (isolatedCounts.get('superseded') || 0) + 1);
      continue;
    }
    if (retractedIds.has(id)) {
      isolatedCounts.set('retracted', (isolatedCounts.get('retracted') || 0) + 1);
      continue;
    }

    // 校验 ①：evidenceIds 非空数组断言（硬规则 / 检查 3）
    if (!Array.isArray(obs.evidenceIds) || obs.evidenceIds.length === 0
      || obs.evidenceIds.some((e) => !e || typeof e !== 'string')) {
      rejected.push({
        id,
        observation: obs,
        reason: `observation ${id}: missing or empty evidenceIds (traceability required)`
      });
      continue;
    }

    // 校验 ②：scope 必须存在（硬规则 / 检查 3）
    if (!obs.scope) {
      rejected.push({
        id,
        observation: obs,
        reason: `observation ${id}: missing scope (scope pre-filter required)`
      });
      continue;
    }

    // 规范化 scope（支持字符串如 'group' / 'private' / 'global' 或具体对象）
    // ⚠ 保留原有"空对象 scope"的拒收与 reason（判定规则不变，只在其**之后**加新的一道）
    if (typeof obs.scope === 'object' && obs.scope !== null && !Array.isArray(obs.scope)
        && Object.keys(obs.scope).length === 0) {
      rejected.push({
        id,
        observation: obs,
        reason: `observation ${id}: scope object must not be empty`
      });
      continue;
    }
    // ★★ MS1b-r6（第④条决定，2026-10-07）**写侧也走同一个归一函数** `normalizeScope`。
    //   背景：读侧 r5 已把"对象 scope 缺 chatKey"定为**一律拒绝**（不许放宽成跨会话读取，硬规则①），
    //   而写侧此前对对象 scope 是**照收不拒** ⇒ 两边不对称 ⇒ 会落下**永远查不到**的记录。
    //   而"悄悄丢数据 / 悄悄放进一个查不到的地方"**恰恰是这条线要消灭的失败模式**
    //   （MS1b 第②条决定堵的第 ③ 条就是"静默丢弃"）⇒ 必须**显式拒收 + reason**，
    //   **不许悄悄放行、也不许悄悄丢**：走 `rejected` / `reasons[]` 汇总，由检查 C 那条守。
    //   为什么能复用 `normalizeScope`：它本来就是唯一的归一入口，读侧 `:302` 已经用它；
    //   现在写侧也用它 ⇒ **同一套规则两个方向**，不会再各写一份、也不会再漂移。
    //   ⚠ 字符串 scope 维持原样（**不**因本条被拒）—— 已知不对称：读侧对字符串 scope 仍会
    //     放宽+如实留痕，写侧也照收；那一条按第③条决定记档，不在本条范围。
    const scopeNormWrite = normalizeScope(obs.scope, obs.chatKey);
    if (!scopeNormWrite.ok) {
      rejected.push({
        id,
        observation: obs,
        reason: `observation ${id}: ${scopeNormWrite.reason}`
      });
      continue;
    }
    const normScope = scopeNormWrite.scope;

    // 校验 ③：文本文本提取
    const text = String(obs.claim ?? obs.text ?? '').trim();
    if (!text) {
      rejected.push({
        id,
        observation: obs,
        reason: `observation ${id}: missing claim or text`
      });
      continue;
    }

    // 校验 ④（§6.4 向量准入）：类型必须是稳定长期条目。放在其他校验**之后** —— 坏数据先按原规则
    // 拒收，好数据里的工作窗口才走隔离，两个账本不混。
    // 缺省口径与 store.js:401 的落盘一致（没有 type 的旧行按 'impression' 处理）；
    // 显式给了白名单外的类型（含未知/历史脏值）则如实隔离，不静默当 impression。
    const obsType = String(obs.type ?? 'impression');
    if (!VECTOR_ADMITTED_TYPES.includes(obsType)) {
      const reason = SHORT_TERM_TYPES.includes(obsType)
        ? `short-term-working-window:${obsType}`
        : `type-not-admitted:${obsType}`;
      isolatedCounts.set(reason, (isolatedCounts.get(reason) || 0) + 1);
      continue;
    }

    const at = typeof obs.at === 'number' && Number.isFinite(obs.at) ? obs.at : Date.now();
    const sourceId = String(obs.sourceId ?? id);

    const rec = {
      id,
      sourceId,
      // 2026-11-05：带上主体，跨房白名单（scope.js）才认得出「这条是她的」。
      subjectId: String(obs.subjectId ?? ''),
      // ★ 2026-10-17（混合召回加权）：把**真实类型**随记录带下去（读侧要按类型校准/配额；
      //   此前只带文本与分数，读侧无从知道条目是印象/事实还是（将来接入的）语义卡/情节）。
      type: obsType,
      sourceType: 'observation',
      evidenceIds: obs.evidenceIds.map(String),
      scope: normScope,
      text,
      at
    };
    // 受保护/稳定条目：读侧类型因子有保底提升（只认显式 true，不做字符串猜测）。
    if (obs.stable === true) rec.stable = true;
    if (obs.generation || generation) rec.generation = String(obs.generation ?? generation);
    if (obs.profileVersion || profileVersion) rec.profileVersion = String(obs.profileVersion ?? profileVersion);
    if (obs.labelSchemaVersion || labelSchemaVersion) rec.labelSchemaVersion = String(obs.labelSchemaVersion ?? labelSchemaVersion);

    records.push(rec);
  }

  const result = {
    ok: rejected.length === 0,
    records,
    rejected,
    reasons: rejected.map((r) => r.reason),
    isolated: [...isolatedCounts.values()].reduce((sum, count) => sum + count, 0),
    isolationReasons: [...isolatedCounts].map(([reason, count]) => `${reason}: ${count}`),
    [Symbol.iterator]() {
      return records[Symbol.iterator]();
    },
    get length() {
      return records.length;
    }
  };

  return result;
}

// ── 2. scope 前置过滤（必须在任何相似度打分之前执行）───────────────────────────

/**
 * 范围过滤函数（必须在任何相似度计算之前调用）
 * 硬规则 1：同文本不同 scope 不许互相命中
 *
 * @param {Array<object>} records - 记录列表
 * @param {object|string} scope - 目标 scope
 * @param {Set<string>|null} allowSubjects - 跨房主体白名单（2026-11-05）：命中的记录不受 scope 限制
 * @returns {Array<object>} 过滤后符合范围的记录
 */
export function scopeFilter(records, scope, allowSubjects = null) {
  if (!records || !Array.isArray(records)) return [];
  if (!scope) return [];

  return records.filter((rec) => {
    if (!rec || !rec.scope) return false;
    // 白名单主体：不管这条落在哪间，都算可见（别人的记录不走这条）。
    if (allowSubjects && allowSubjects.size > 0 && allowSubjects.has(String(rec.subjectId ?? '').trim())) {
      return true;
    }

    // 目标 scope 是对象形式
    if (typeof scope === 'object' && !Array.isArray(scope)) {
      return Object.entries(scope).every(([k, v]) => {
        if (v === undefined || v === null) return true;
        // 如果记录的 scope 是对象
        if (typeof rec.scope === 'object' && !Array.isArray(rec.scope)) {
          return rec.scope[k] === v;
        }
        // 如果记录的 scope 是纯字符串，且当前键是 scope
        if (k === 'scope' || k === 'kind') {
          return String(rec.scope) === String(v);
        }
        return false;
      });
    }

    // 目标 scope 是纯字符串形式
    const targetStr = String(scope);
    if (typeof rec.scope === 'string') {
      return rec.scope === targetStr;
    }
    if (typeof rec.scope === 'object') {
      return rec.scope.scope === targetStr || rec.scope.kind === targetStr;
    }
    return false;
  });
}

// ── 3. 记录向量化索引（注入式）───────────────────────────────────────────────

/**
 * 注入式索引记录物化
 * @param {Array<object>} records
 * @param {{ embed: (text: string, options: {purpose: 'document'}) => Promise<{ok: boolean, vec?: ArrayLike<number>, status?: string, reason?: string}> }} options
 */
export async function indexRecords(records, { embed } = {}) {
  if (!Array.isArray(records)) {
    throw new TypeError('records must be an array');
  }
  if (typeof embed !== 'function') {
    const error = new TypeError('embed(text, {purpose}) must be injected');
    error.status = 'not-ready';
    throw error;
  }

  const materialized = [];
  for (const rec of records) {
    if (rec.vec && (Array.isArray(rec.vec) || ArrayBuffer.isView(rec.vec))) {
      materialized.push({ ...rec });
      continue;
    }
    let res;
    try {
      res = await embed(rec.text, { purpose: 'document' });
    } catch (error) {
      return {
        ok: false,
        status: thrownStatus(error),
        count: 0,
        records: [],
        reasons: [`record ${String(rec?.id ?? '?')}: ${embedFailureReason('document', null, error)}`]
      };
    }
    const vec = res?.vec;
    if (res?.ok !== true || (!Array.isArray(vec) && !ArrayBuffer.isView(vec)) || vec.length === 0) {
      return {
        ok: false,
        status: failureStatus(res),
        count: 0,
        records: [],
        reasons: [`record ${String(rec?.id ?? '?')}: ${embedFailureReason('document', res)}`]
      };
    }
    materialized.push({
      ...rec,
      vec: Array.from(vec)
    });
  }

  return {
    ok: true,
    count: materialized.length,
    records: materialized
  };
}

// ── 4. 语义检索入口（对齐 V0 §4 八态契约）──────────────────────────────────────

/**
 * ★ 2026-10-17（用户令：向量记忆要"加权、近 1~3 天高、之后逐渐遗忘"）——**可解释的打分因素**。
 *
 * 分数 = 余弦相似度 × 时间因素 × 类型因素（再按阈值/配额/去重收口）。
 *   · **时间因素**（单调、有界 0.72~1.18，**不归零**，强相关的旧事不会被永久压没）：
 *       0~3 天        ⇒ 1.18（温和提升；用户原话"1~3 天权重高点"）
 *       3~14 天       ⇒ 1.18 → 1.0 线性（每天约 −1.6%）
 *       >14 天        ⇒ 1.0 → 0.72 平滑衰减（180 天到 0.72 后保持，**只降召回优先级，不删数据**）
 *     时间必须取**真实事件/内容发生或修订时刻**（记录的 `at`），不取重建/写索引时间；
 *     未知/非法时间 ⇒ 1.0（中性，不冒充"刚发生"）。
 *   · **类型因素**：stable 长期事实/手工保护 = 1.08 且有 0.72 保底；impression/fact/preference = 1.0；
 *     semantic_card = 0.98、episode_summary = 0.96（情节比卡片稍弱，避免"越会讲故事越挤掉事实"）；
 *     未知类型 = 1.0。类型只做**校准**，不做硬过滤（强相关仍可上前）。
 *   · 相似度仍是分数：本函数**绝不**把加权后的值写成 p/confidence（规则③不变）。
 */
export const RECALL_TIME_WEIGHTS = Object.freeze({
  boostUntilMs: 3 * 24 * 3600 * 1000,   // 0~3 天：提升段
  fadeUntilMs: 14 * 24 * 3600 * 1000,   // 3~14 天：平滑回落到 1.0
  floorUntilMs: 180 * 24 * 3600 * 1000, // 14~180 天：衰减到 floor
  boost: 1.18,
  floor: 0.72
});
export const RECALL_TYPE_WEIGHTS = Object.freeze({
  stable: 1.08,          // 稳定事实 / 手工保护（读取方在 record 上标 stable:true）
  impression: 1.0,
  trait: 1.0,
  preference: 1.0,
  fact: 1.0,
  semantic_card: 0.98,
  episode_summary: 0.96
});

/** 时间因素（纯函数；`at` 与参考时刻都必须是毫秒时间戳，非法 ⇒ 中性 1.0）。 */
export function recallTimeFactor(at, now = Date.now()) {
  const t = Number(at);
  const n = Number(now);
  if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(n) || n <= 0) return 1;
  const age = Math.max(0, n - t);
  const { boostUntilMs, fadeUntilMs, floorUntilMs, boost, floor } = RECALL_TIME_WEIGHTS;
  if (age <= boostUntilMs) return boost;
  if (age <= fadeUntilMs) {
    const k = (age - boostUntilMs) / (fadeUntilMs - boostUntilMs);
    return boost + (1 - boost) * k;
  }
  if (age <= floorUntilMs) {
    const k = (age - fadeUntilMs) / (floorUntilMs - fadeUntilMs);
    return 1 + (floor - 1) * k;
  }
  return floor;
}

/** 类型因素（未知类型中性；`stable:true` 的受保护条目有保底提升）。 */
export function recallTypeFactor(record) {
  const protectedStable = record?.stable === true;
  // ★ 2026-10-17：**来源类型优先**（semantic_card=0.98 / episode_summary=0.96 是"来源种类"的校准，
  //   避免"卡片/情节没写 type 就按中性 1.0"或"卡片写了 type:fact 就绕过 0.98"）；
  //   sourceType 不在权重表里时（observation）再按真实 type（impression/fact/…）校准。
  const type = String(record?.type ?? record?.kind ?? '').trim();
  const sourceType = String(record?.sourceType ?? '').trim();
  const sourceKey = sourceType && Number.isFinite(Number(RECALL_TYPE_WEIGHTS[sourceType])) ? sourceType : '';
  const typeKey = type && Number.isFinite(Number(RECALL_TYPE_WEIGHTS[type])) ? type : '';
  const base = Number(RECALL_TYPE_WEIGHTS[sourceKey || typeKey] ?? 1) || 1;
  return protectedStable ? Math.max(base, RECALL_TYPE_WEIGHTS.stable) : base;
}

/** 单个候选的最终权重（供检索与排障共用同一公式；不写进 score 之外的概率字段）。 */
export function recallWeightOf(record, { now = Date.now() } = {}) {
  const time = recallTimeFactor(record?.at, now);
  const type = recallTypeFactor(record);
  return {
    time,
    type,
    weight: Number((time * type).toFixed(6))
  };
}

/**
 * ★ 2026-10-17：**适度类型配额/多样性**（"相关性为主，类型只校准"）。
 *   已按加权分排好序的候选里，有类型的条目每种最多占 `max(2, ceil(topK/2))`；无类型条目不计配额。
 *   一轮没填满就按剩余加权分补足 —— 只调召回顺序，不硬过滤、不改变分数含义。
 */
export function selectWithTypeQuota(sortedItems, topK) {
  const list = Array.isArray(sortedItems) ? sortedItems : [];
  const limit = Math.max(1, Number(topK) || 8);
  const perTypeCap = Math.max(2, Math.ceil(limit / 2));
  const picked = [];
  const deferred = [];
  const counts = new Map();
  for (const item of list) {
    if (picked.length >= limit) break;
    // ★ 2026-10-17：没有 type 时按 sourceType 分桶（卡片/情节也要受同一条配额约束）。
    const type = item?.type ?? item?.kind ?? item?.sourceType ?? null;
    if (!type) { picked.push(item); continue; }
    const used = counts.get(type) || 0;
    if (used < perTypeCap) {
      picked.push(item);
      counts.set(type, used + 1);
    } else {
      deferred.push(item);
    }
  }
  for (const item of deferred) {
    if (picked.length >= limit) break;
    picked.push(item);
  }
  return picked;
}


/**
 * 语义召回检索
 *
 * 硬规则：
 *   1. scope 在打分之前过滤；同文本不同 scope 不许互相命中
 *   2. 过去时刻查询（at 给定时）输入只能含 at <= eventAt 的证据
 *   3. 相似度不许冒充概率：score 当 score，永远不许写进 JEV 的 p，也不许当 confidence 往上抛
 *   5. threshold 由调用方给；库里不许自拍阈值
 *
 * @param {{
 *   embedder?: object,
 *   index?: object,
 *   records?: Array<object>,
 *   sourceIds?: Array<string>,
 *   query: string,
 *   scope: object|string,
 *   at?: number|null,
 *   topK?: number,
 *   threshold?: number|null
 * }} options
 */
export async function semanticRetrieve({
  embedder,
  index,
  records = null,
  sourceIds = null,
  expectedVersions = null,
  query,
  scope,
  scopeChatKey = null,
  at = null,
  topK = 8,
  threshold = null
} = {}) {
  const cleanQuery = String(query ?? '').trim();
  // ★ MS1b：scope 归一走**唯一入口** `normalizeScope`（与 `observationToRecords` 入库侧同源）。
  //   改前这里对字符串 scope 只补 `{scope}` 不补 chatKey ⇒ 同一个字符串 scope 会跨会话放宽命中。
  const scopeNorm = normalizeScope(scope, scopeChatKey);
  let allowedSourceIds = null;
  if (sourceIds !== null && sourceIds !== undefined) {
    if (!Array.isArray(sourceIds) || sourceIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      return { ok: false, status: 'error', items: [], reasons: ['sourceIds must be an array of non-empty strings'] };
    }
    allowedSourceIds = new Set(sourceIds);
  }
  // ★★ 一律拒绝：对象 scope 缺 chatKey 会让匹配面跨会话
  //   ⇒ 这里**显式失败**返回，**绝不带着一个没被隔离的 scope 去查**（哪怕索引里只有一条记录、结果"看起来一样"）。
  //   `status:'error'` 是 V0 §4 八态里真实存在的值（这里确实是"读取失败"，不是 r3 那种词表污染）。
  if (!scopeNorm.ok) {
    return {
      ok: false,
      status: 'error',
      items: [],
      reasons: [scopeNorm.reason || 'scope requires chatKey unless scope is global: refusing cross-chat retrieval'],
      scopeWidened: scopeNorm.widened
    };
  }

  // 1. 若提供了基于 core/vector 的 Index 实例，先保留其读状态。
  //    有 sourceIds 时转到下面的候选路径，在 scope/source 两种过滤完成后才计算相似度。
  if (index && typeof index.query === 'function') {
    const idxStatus = typeof index.status === 'function' ? index.status() : 'ready';
    if (idxStatus === 'not-ready') {
      return { ok: false, status: 'not-ready', items: [], reasons: ['index not ready'] };
    }
    if (idxStatus === 'version-incompatible') {
      return { ok: false, status: 'version-incompatible', items: [], reasons: ['index version incompatible'] };
    }
    if (idxStatus === 'stale') {
      return { ok: false, status: 'stale', items: [], reasons: ['index stale: store changed externally'] };
    }
    if (idxStatus === 'closed') {
      return { ok: false, status: 'cancelled', items: [], reasons: ['index closed'] };
    }
    if (!cleanQuery) {
      return { ok: true, status: 'empty', items: [], reasons: ['query text is empty'] };
    }

    // ★ 2026-10-17（向量增量底座）：有 sourceIds 时**不再**先 store.list 整份 map 再走内存腿 ——
    //   改为把权限前置交给 index.query（低层在打分前按 sourceId 收窄），这里再按 allowedSourceIds
    //   做一次防御性过滤（旧/桩索引忽略该选项时也不泄漏）。
    {
      // scope 归一（唯一入口；上面已算好 scopeNorm）
      const normScope = scopeNorm.scope;
      const widenedNote = scopeNorm.widened && normScope.scope
        ? [`scope-widened: no chatKey given, matching every chat under scope=${normScope.scope}`]
        : [];
      const topKnum = Math.max(1, Number(topK) || 8);
      // 有界过采样：加权与类型配额需要比最终 topK 更多的候选（最多 4×topK，且不超过 64）。
      // 低层另有 QUERY_TOP_K_MAX=256 的硬上限；这里不复制整库、只请求有限候选。
      const overTopK = Math.min(64, Math.max(topKnum, topKnum * 4));
      const queryOpts = {
        scope: normScope,
        topK: overTopK,
        threshold,
        ...(allowedSourceIds !== null ? { sourceIds: [...allowedSourceIds] } : {}),
        ...(at !== null && at !== undefined ? { at } : {})
      };

      let result;
      try {
        result = await index.query(cleanQuery, queryOpts);
      } catch (err) {
        return {
          ok: false,
          status: thrownStatus(err),
          items: [],
          reasons: [`index query error: ${err?.message || err}`]
        };
      }

      // 保护性提纯：断言并清洗 score 绝不泄漏为 p 或 confidence。
      const nowRef = (at !== null && at !== undefined && Number.isFinite(Number(at))) ? Number(at) : Date.now();
      const rawItems = (Array.isArray(result?.items) ? result.items : [])
        .filter((it) => allowedSourceIds === null || allowedSourceIds.has(String(it?.sourceId ?? '')));
      const safeItems = rawItems.map((it) => {
        const type = it?.type ?? it?.kind ?? null;
        const sourceType = it?.sourceType ?? null;
        const stable = it?.stable === true;
        const w = recallWeightOf({ at: it?.at, type, sourceType, stable }, { now: nowRef });
        return {
          id: it.id,
          sourceId: it.sourceId,
          scope: it.scope,
          score: it.score,
          at: it.at,
          ...(type ? { type } : {}),
          ...(sourceType ? { sourceType } : {}),
          ...(stable ? { stable: true } : {}),
          weight: w.weight,
          weightedScore: Number(((Number(it?.score) || 0) * w.weight).toFixed(6))
        };
      });
      // ★ 排序用**加权分**（相关性为主 + 时间/类型校准），score 本身仍是相似度（阈值语义不变）。
      safeItems.sort((a, b) => (b.weightedScore - a.weightedScore) || (b.score - a.score));
      // ★ 真索引分支也套**同一套**类型配额/回填（此前只在无索引内存腿生效）。
      const items = selectWithTypeQuota(safeItems, topKnum);
      let status = result?.status;
      if (!READ_STATUSES.has(status)) status = result?.ok === true
        ? (items.length > 0 ? 'success' : 'empty')
        : 'error';
      // V0 中 success/empty 必须是 ok；不接受失败被伪装成空结果。
      const ok = result?.ok === true && (status === 'success' || status === 'empty');
      if (result?.ok !== true && (status === 'success' || status === 'empty')) status = 'error';

      return {
        ok,
        status,
        items,
        reasons: [...(Array.isArray(result?.reasons) ? result.reasons : []), ...widenedNote],
        scopeWidened: scopeNorm.widened
      };
    }
  }

  // 2. 独立纯内存 / 注入式路径（无外部 index 时的自包含实现）
  if (!embedder || typeof embedder.embed !== 'function') {
    return {
      ok: false,
      status: 'not-ready',
      items: [],
      reasons: ['embedder not ready (injected embed function required)']
    };
  }

  if (!cleanQuery) {
    return { ok: true, status: 'empty', items: [], reasons: ['query text is empty'] };
  }

  if (!records || !Array.isArray(records)) {
    return {
      ok: true,
      status: 'empty',
      items: [],
      reasons: ['no records provided']
    };
  }

  // ★ 硬规则 1（检查 1）：scope 必须在任何打分/向量计算之前过滤！（scopeNorm 与 index 分支同源）
  // 2026-11-05：跨房主体（默认只有她本人）不走这条闸——她的事在哪个房间都取得到。
  // 别人的记录仍按 scope 严格切开，群 A 的判断不会飘到群 B。
  let visible = scopeFilter(records, scopeNorm.scope, crossScopeSubjects());
  if (allowedSourceIds !== null) {
    visible = visible.filter((record) => allowedSourceIds.has(String(record?.sourceId ?? '')));
  }
  if (visible.length === 0) {
    return {
      ok: true,
      status: 'empty',
      items: [],
      reasons: ['no records in scope']
    };
  }

  if (expectedVersions && typeof expectedVersions === 'object') {
    const incompatible = visible.find((record) => record.generation !== expectedVersions.generation
      || record.profileVersion !== expectedVersions.profileVersion
      || record.labelSchemaVersion !== expectedVersions.labelSchemaVersion);
    if (incompatible) {
      return {
        ok: false,
        status: 'version-incompatible',
        items: [],
        reasons: [`record ${String(incompatible.id ?? incompatible.sourceId ?? '?')} has incompatible generation/profile/label schema`]
      };
    }
  }

  // ★ 硬规则 2（检查 2）：时间边界约束，仅保留 at <= eventAt 的记录
  let inRange = visible;
  let excludedCount = 0;
  if (at !== null && at !== undefined) {
    inRange = [];
    for (const r of visible) {
      if (typeof r.at === 'number' && r.at > at) {
        excludedCount++;
      } else {
        inRange.push(r);
      }
    }
  }

  if (inRange.length === 0) {
    return {
      ok: true,
      status: 'empty',
      items: [],
      reasons: excludedCount > 0 ? [`time-excluded: ${excludedCount}`] : []
    };
  }

  // 生成 Query 向量
  let queryEmbed;
  try {
    queryEmbed = await embedder.embed(cleanQuery, { purpose: 'query' });
  } catch (err) {
    return {
      ok: false,
      status: thrownStatus(err),
      items: [],
      reasons: [`embedder error: ${err?.message || err}`]
    };
  }

  if (!queryEmbed || queryEmbed.ok !== true || !queryEmbed.vec) {
    return {
      ok: false,
      status: failureStatus(queryEmbed),
      items: [],
      reasons: [embedFailureReason('query', queryEmbed)]
    };
  }

  const queryVec = queryEmbed.vec;
  const queryVectorCheck = validateDimensions({ dims: EMBEDDING_DIMENSIONS }, queryVec);
  if (!queryVectorCheck.ok) {
    return {
      ok: false,
      status: 'error',
      items: [],
      reasons: [`query embedding has an invalid vector: ${queryVectorCheck.reason}`]
    };
  }
  const scored = [];
  const documentFailures = [];
  // ★ 权重的时间基准：有 `at` 的历史时刻查询就**按那一刻算**（不是跑查询的墙钟），
  //   与硬规则②同源，回放/补算才一致。
  const nowRef = (at !== null && at !== undefined && Number.isFinite(Number(at))) ? Number(at) : Date.now();

  for (const rec of inRange) {
    let recVec = rec.vec;
    if (!recVec) {
      let docEmbed;
      try {
        docEmbed = await embedder.embed(rec.text, { purpose: 'document' });
      } catch (err) {
        documentFailures.push({ status: thrownStatus(err), reason: `embed document failed (${thrownStatus(err)}): ${err?.message || err}` });
        continue;
      }
      if (!docEmbed || docEmbed.ok !== true || !docEmbed.vec) {
        documentFailures.push({ status: failureStatus(docEmbed), reason: embedFailureReason('document', docEmbed) });
        continue;
      }
      recVec = docEmbed.vec;
    }

    const recordVectorCheck = validateDimensions({ dims: EMBEDDING_DIMENSIONS }, recVec);
    if (!recordVectorCheck.ok) {
      return {
        ok: false,
        status: 'error',
        items: [],
        reasons: [`record ${String(rec.id ?? '?')} has an invalid vector: ${recordVectorCheck.reason}`]
      };
    }

    const score = Number(cosineSimilarity(queryVec, recVec).toFixed(6));
    if (threshold !== null && score < threshold) continue;   // 阈值仍按相似度（语义不变）

    // ★ 硬规则 3（检查 5）：score 仍是相似度；加权只以 weight/weightedScore **并列**出，
    //   绝不伪装/赋值给 p 或 confidence。
    const w = recallWeightOf(rec, { now: nowRef });
    scored.push({
      id: rec.id,
      sourceId: rec.sourceId,
      scope: rec.scope,
      score,
      at: rec.at,
      ...(rec.type ? { type: rec.type } : {}),
      ...(rec.sourceType ? { sourceType: rec.sourceType } : {}),
      weight: w.weight,
      weightedScore: Number((score * w.weight).toFixed(6))
    });
  }

  // 排序与取用的主键是**加权分**（相关性为主 + 时间/类型校准），同分再按相似度。
  scored.sort((a, b) => (b.weightedScore - a.weightedScore) || (b.score - a.score));
  const items = selectWithTypeQuota(scored, topK);

  const reasons = [];
  if (excludedCount > 0) reasons.push(`time-excluded:${excludedCount}`);
  if (documentFailures.length > 0) {
    reasons.push(...documentFailures.map((failure) => failure.reason));
    if (items.length > 0) return { ok: false, status: 'partial-coverage', items, reasons };
    const failureStatuses = new Set(documentFailures.map((failure) => failure.status));
    return {
      ok: false,
      status: failureStatuses.size === 1 ? documentFailures[0].status : 'error',
      items: [],
      reasons
    };
  }

  if (excludedCount > 0 && items.length > 0) {
    return { ok: false, status: 'partial-coverage', items, reasons };
  }

  return {
    ok: true,
    status: items.length > 0 ? 'success' : 'empty',
    items,
    reasons
  };
}

// ── 5. 关键词与语义降级合并（硬规则 4 / 检查 4）──────────────────────────────────

/**
 * 语义不可用时的降级合并
 * 硬规则 4：
 *   - 语义不可用时必须显式降级：退回关键词召回 + 标注"语义召回不可用"
 *   - 不许伪装成向量成功；不许静默返回空
 *
 * ★★ MS1b-r3（2026-10-07）**返回值里不再有 `status` 字段**，这是刻意的：
 *   ① 本函数返回的是**融合结果**，不是"索引读取状态"。V0 §4 那八态
 *      （`success/empty/not-ready/timeout/cancelled/version-incompatible/stale/partial-coverage/error`）
 *      描述的是**读索引**的结果；把融合结果塞进同一个 `status` 属于**词表污染** ——
 *      下游按八态穷举时会漏（本函数原来塞的 `degraded` 就不在八态里；`ingestObservations` 的 `partial` 同病，
 *      已在第②条决定里清掉）。
 *   ② 也不许反过来硬塞一个八态值：这里写 `success` 会**骗人** ——
 *      "融合成功"不等于"索引读取成功"，`partial-coverage`（被时间边界切薄）在这里更不是"读成功了"。
 *   ③ 要表达的信息已经全部在既有字段里，缺什么请自己加**有名字**的字段，不要借用 `status`：
 *      · `degraded: true|false` —— 是否降级（降级时另有 `reason` 说明为什么）
 *      · `partial: true|false` + `note` —— 是否被时间边界切薄（V1a 的 partial-coverage，**不是**降级）
 *      · `mode: 'hybrid'|'semantic-only'|'keyword-only'|'empty'` —— 融合形态
 *      · `items` —— 融合后的条目
 *   ④ ★ **将来若有人给本函数加回 `status`、哪怕填的是一个"合法"的八态值，检查 H 也会红 —— 那是设计，不是 bug。**
 *      检查 H 断的是 `!('status' in x)`（**字段不存在**，比"值不在词表里"更严），因为本函数
 *      在语义上**根本没有"读取状态"可报**。看到这条红，请改这条检查或改设计，别去放宽断言。
 *      （这条是 2026-10-07 指挥位验收时要求的：让将来的人看到红的时候知道"这不是 bug，是设计"。）
 *
 * @param {Array<object>} keywordItems - 关键词搜索结果
 * @param {object|Array<object>} semanticResult - 语义搜索结果（结果对象或列表）
 * @param {object} [options]
 * @param {number} [options.limit=8]
 */
export function mergeWithKeyword(keywordItems, semanticResult, { limit = 8 } = {}) {
  const kwList = Array.isArray(keywordItems) ? keywordItems : [];
  const maxLimit = Math.max(1, Number(limit) || 8);

  // 1. 判断语义结果是否不可用（显式降级）
  let isDegraded = false;
  let degradeReason = '';
  let semList = [];
  // ★ MS1b：`partial-coverage` 的诊断（被时间切薄）要**透出**，不许吞。
  let partialNote = '';

  if (!semanticResult) {
    isDegraded = true;
    degradeReason = '语义检索未返回结果或未就绪';
  } else if (Array.isArray(semanticResult)) {
    semList = semanticResult;
  } else if (typeof semanticResult === 'object') {
    // ★ MS1b 修正：`partial-coverage` **不是**"语义召回不可用"。
    //   V1a 的契约是 `ok:false` 但**附 items+reasons**，且它自己的注释写明
    //   "数据可信、只是被时间切薄"（core/vector/vector-index.js:12 与 :383-385）。
    //   改前这里按 `ok!==true` 一刀切 ⇒ 这些 items 被**静默丢弃**、只剩关键词结果，
    //   而调用方一个错都看不出来 —— 那正是硬规则④禁止的"静默"。
    //   ⇒ 把它单列：**items 照常参与融合**，另外挂一条 note 说明被时间切薄。
    if (semanticResult.status === 'partial-coverage') {
      semList = Array.isArray(semanticResult.items) ? semanticResult.items : [];
      partialNote = semanticResult.reasons?.join('; ') || 'time-excluded';
    } else if (semanticResult.ok !== true || semanticResult.status === 'not-ready' || semanticResult.status === 'error' || semanticResult.status === 'version-incompatible' || semanticResult.status === 'timeout' || semanticResult.status === 'cancelled') {
      isDegraded = true;
      degradeReason = `语义召回不可用 (${semanticResult.status || 'unknown'}: ${semanticResult.reasons?.join('; ') || semanticResult.error || 'error'})`;
    } else {
      semList = Array.isArray(semanticResult.items) ? semanticResult.items : [];
    }
  }

  // 显式降级分支
  if (isDegraded) {
    return {
      ok: true,
      degraded: true,
      mode: 'keyword-only',
      // ★ MS1b-r3：`status: 'degraded'` **已删** —— 'degraded' 不在 V0 §4 八态里（词表污染），
      //   而降级已经由上面的 `degraded: true` + `mode: 'keyword-only'` + `reason` 说清楚了。
      //   理由与"为什么不反过来塞 `success`"见本函数 JSDoc 顶部那三条。
      reason: degradeReason,
      items: kwList.slice(0, maxLimit)
    };
  }

  // 2. 正常融合分支（双路去重合并）
  const seenIds = new Set();
  const merged = [];

  // 优先放入语义召回项
  for (const item of semList) {
    const key = String(item.id ?? item.sourceId ?? '');
    if (key) seenIds.add(key);
    merged.push({ ...item, source: 'semantic' });
  }

  // 补充关键词召回项（避免重复）
  for (const item of kwList) {
    const key = String(item.id ?? item.sourceId ?? '');
    if (key && seenIds.has(key)) continue;
    if (key) seenIds.add(key);
    merged.push({ ...item, source: 'keyword' });
  }

  return {
    ok: true,
    degraded: false,
    // ★ MS1b：`partial` = 语义结果可信但被时间边界切薄（V1a 的 partial-coverage）。
    //   它**不是**降级：items 照常融合，另用 `partial`/`note` 显式说明切了多少。
    partial: partialNote !== '',
    note: partialNote,
    mode: semList.length > 0 && kwList.length > 0 ? 'hybrid' : (semList.length > 0 ? 'semantic-only' : 'empty'),
    // ★ MS1b-r3：这里原来写 `status: partialNote !== '' ? 'partial-coverage' : 'success'`，
    //   **也已删** —— 融合结果不是索引读取状态（理由见 JSDoc 顶部第②条：这里写 `success` 会骗人）。
    //   "是否被时间切薄"改由 `partial` + `note` 表达，"形态"由 `mode` 表达。
    items: merged.slice(0, maxLimit)
  };
}

// ── 6. §二 向量地基集成辅助函数 ───────────────────────────────────────────────

export const DEFAULT_SEMANTIC_PROFILE = Object.freeze({
  profileVersion: 'v0',
  modelId: 'bge-base-zh-v1.5-q8_0',
  modelSha256: null,
  runtime: 'llama',
  build: 'fake-0.1',
  pooling: 'cls'
});

/**
 * scope 归一（**唯一入口**，index 分支与纯内存分支都必须走它）。
 *
 * ⚠ 为什么必须唯一（MS1b 实测出来的坑）：`observationToRecords` 入库时对字符串 scope 会补
 *   `chatKey`（`:123-126`），而查询侧若只补 `{scope:'group'}` 不补 chatKey ⇒
 *   `inScope` 只按"给出的键"匹配 ⇒ **同一个字符串 scope 会跨会话放宽命中**（硬规则①的反面）。
 *   实测：`scope:'group'` 能同时命中 chatKey=g1 与 g2 的记录。
 *
 * ★★ **group/private 缺 `chatKey` 一律拒绝查询**
 *   —— 硬规则①是主人方案的地基："scope 必须在任何相似度计算之前过滤；相同文本落在不同 scope
 *   不能互相命中。" 所以**当查询需要按会话隔离、而调用方又拿不出会话键时，"放宽命中"本身就是违规** ——
 *   它不是"可以接受但要留痕"，它是**越权读别人的会话**。
 *   ⇒ group/private 对这种情况**只给两种结果，都不许悄悄放宽**：
 *     ① **收窄**（收窄到调用方能证明的范围）：调用方显式给了 `chatKey` ⇒ 并进去，`widened=false`。
 *        这是"证明得了就照证明的范围查"，不是放宽。
 *     ② **拒绝**：拿不出会话键 ⇒ 返回 `ok:false` + `reason`，由 `semanticRetrieve` **显式失败**返回，
 *        **不进入查询**。
 *   ⇒ ★ **故意不提供"放宽开关"**：加一个 `requireSessionScope:false` 之类的出口，等于再造一个
 *     "下次赶时间就顺手关掉"的坑 —— 那正是本条要消灭的失败模式。宁可红、宁可失败。
 *
 * ★★ 同时修掉一个**把失败说成成功**的 bug（这条与拒绝查询那条独立，但方向一致）：
 *   改前对象 scope 那条分支写的是 `return { scope: {...scope}, widened: false }` ——
 *   **无条件**报 `widened:false`。可对象 scope 缺 `chatKey` 时它**就是**被放大了，
 *   报 `false` 是**对下游说谎**（下游会以为"没放宽"而放松隔离）。
 *   ⇒ 现在按事实报：对象 scope 拿不出会话键 ⇒ `widened:true`。
 *
 * @param {object|string} scope
 * @param {string|null} [chatKey] 调用方给的会话键。字符串 scope 时用来补 `chatKey`；
 *   **对象 scope 缺 `chatKey` 时也生效**（用来"收窄"，见 ①）
 * @returns {{scope: object, widened: boolean, ok: boolean, reason?: string}}
 *   `widened=true` 表示缺少会话键、非 global 查询被放大；global 按设计允许跨会话；
 *   `ok=false` 表示**拒绝查询**（出错时一律不放行），`reason` 说明缺什么。
 */
export function normalizeScope(scope, chatKey = null) {
  // 调用方给的会话键（对象 scope 也认它 —— 这是"收窄"的唯一入口）
  const givenKey = (chatKey !== null && chatKey !== undefined) ? String(chatKey).trim() : '';
  if (typeof scope === 'object' && scope !== null && !Array.isArray(scope)) {
    const out = { ...scope };
    const ownKey = Object.prototype.hasOwnProperty.call(out, 'chatKey') ? String(out.chatKey ?? '').trim() : '';
    if (ownKey !== '') {
      return { scope: out, widened: false, ok: true };
    }
    const ownScope = String(out.scope ?? out.kind ?? '').trim();
    if (ownScope === 'global') {
      return { scope: out, widened: false, ok: true };
    }
    // ① 收窄：调用方给了会话键 ⇒ 并进去（这是"证明得了的范围"，不是放宽）
    if (givenKey !== '') {
      return { scope: { ...out, chatKey: givenKey }, widened: false, ok: true };
    }
    // ② 拒绝：拿不出会话键 ⇒ 不许悄悄放宽。widened 如实报 true（它确实会被放大）。
    return {
      scope: out,
      widened: true,
      ok: false,
      reason: 'object scope requires chatKey: refusing to widen the query across chats (hard rule 1 — scope must filter before any similarity computation)'
    };
  }
  const text = String(scope ?? '').trim();
  const out = { scope: text };
  if (givenKey !== '') {
    out.chatKey = givenKey;
  }
  // 没有 chatKey 时，scope 只有 {scope:'group'} 这种粗粒度键 ⇒ 命中面比入库时宽。
  // global 按设计跨会话可见；group/private 缺 chatKey 由检索侧拒绝查询。
  return { scope: out, widened: text !== 'global' && !('chatKey' in out), ok: true };
}

/**
 * 创建语义索引（集成 refactor/core/vector）
 *
 * V0 要求调用方注入 embed(text, {purpose})，且普通 embedder 必须声明 64 位 modelSha256。
 * 该格式检查不证明模型文件真实；只有 embedder 提供 verifyModel()+status().modelSha256 且回报匹配时，
 * `profileVerified` 才为 true。未注入时显式抛出 not-ready，不会自动创建 fake embedder。

 * @returns {{profile, embedder, store, index, embedding: 'fake'|'injected-verified'|'injected-unverified', profileVerified: boolean, profileSha256FormatValid: boolean}}
 */
export function createSemanticIndex({
  profile = null,
  embedder = null,
  store = null,
  generation = 'gen-1',
  labelSchemaVersion = 'labels-v1'
} = {}) {
  const prof = profile ? makeProfile(profile) : makeProfile(DEFAULT_SEMANTIC_PROFILE);
  const profileSha256FormatValid = isProfileVerified(prof);
  if (!embedder || typeof embedder.embed !== 'function') {
    const error = new TypeError(
      'createSemanticIndex: embedder is not ready; inject embed(text, {purpose}) explicitly '
      + 'or pass an explicit fake embedder for tests (never substituted automatically)');
    error.status = 'not-ready';
    throw error;
  }
  const activeEmbedder = embedder;
  const explicitlyFake = Boolean(embedder.embedding === 'fake'
    || embedder.kind === 'fake'
    || embedder.profile?.build === 'fake-0.1');
  function artifactVerified() {
    if (explicitlyFake || !profileSha256FormatValid
      || typeof activeEmbedder.verifyModel !== 'function'
      || typeof activeEmbedder.status !== 'function') return false;
    try {
      const actual = activeEmbedder.status()?.modelSha256;
      return typeof actual === 'string' && actual.toLowerCase() === prof.modelSha256.toLowerCase();
    } catch {
      return false;
    }
  }
  function embeddingKind() {
    if (explicitlyFake) return 'fake';
    return artifactVerified() ? 'injected-verified' : 'injected-unverified';
  }
  if (!profileSha256FormatValid && !explicitlyFake) {
    const error = new TypeError(
      'createSemanticIndex: embedding profile needs a 64-hex modelSha256 declaration; '
      + 'that format alone does not verify the model artifact');
    error.status = 'not-ready';
    throw error;
  }

  const activeStore = store || createMemoryStore();

  const idx = createIndex({
    profile: prof,
    embedder: activeEmbedder,
    store: activeStore,
    generation,
    labelSchemaVersion
  });

  return {
    profile: prof,
    embedder: activeEmbedder,
    store: activeStore,
    index: idx,
    /** 自报 verifyModel + 匹配的 status 哈希才算已验证；哈希格式本身单独暴露。 */
    get embedding() { return embeddingKind(); },
    get profileVerified() { return artifactVerified(); },
    profileSha256FormatValid,
    generation,
    labelSchemaVersion
  };
}

// ── 7. §二 接线桥（观察 → 真 V1a 索引 → 语义召回 → 降级融合）────────────────────

/**
 * 把观察灌进真 V1a 索引：`observationToRecords` → `index.upsert`。
 *
 * 为什么要这个桥（MS1b 读码结论）：`semanticRetrieve` 的 index 分支早就写好了，
 * `createSemanticIndex` 也产出可用索引，但**没有任何一条代码把观察送进那个索引** ——
 * 也就是说真向量那条路在工程上是**不可达**的。本函数是那条缺失的接线。
 *
 * 拒收规则（硬规则⑧ / 检查 3）：两段拒收**都要出现在 reasons 里**，且都不许进索引 ——
 * `observationToRecords` 拒的（缺 evidenceIds / scope / 文案）与 V1a `upsert` 拒的（版本不符 / 维度不符…），
 * 形状不同，本函数统一成一个 `reasons[]` 交给调用方，不许只回一段而把另一段吞掉。
 *
 * ★ 第②条决定（2026-10-07 指挥位）**不许自造 `status` 值**：
 *   V0 §4 那八态（`success/empty/not-ready/timeout/cancelled/version-incompatible/stale/partial-coverage/error`）
 *   是**读取状态**的词表；把"部分入库"塞进 `status` 会污染它，下游按词表穷举就会漏 ——
 *   而"词表外的值不许静默"正是这条线在治的病。
 *   ⇒ `status` **只回词表内的值**，且只描述**索引层结果**：`success` / `empty` / `error`。
 *   ⇒ "有没有东西没进去"由**既有字段**表达，调用方看这三个即可，不必认新枚举：
 *       · `ok === false && inserted > 0` ⇒ **部分入库**（有的进了、有的没进）
 *       · `rejected > 0` ⇒ 有东西被拒
 *       · `reasons[]` ⇒ 为什么（**硬要求：`rejected > 0` 时必非空**，见下方 `assertReasonsForRejections`）
 *   ⇒ 这与 V1a `upsert` 自己的形状一致（`vector-index.js:233` 只回 `{ok,inserted,rejected,reasons}`，**根本没有 status**）。
 *
 * @param {{index: object}} bundle createSemanticIndex() 的产物（或任何带 index 的对象）
 * @param {Array<object>} observations
 * @param {{generation?: string, labelSchemaVersion?: string, profileVersion?: string}} [options]
 * @returns {Promise<{ok, status, inserted, rejected, isolated, isolationReasons, records, reasons, indexStatus}>}
 */
export async function ingestObservations(bundle, observations, options = {}) {
  if (!bundle || typeof bundle !== 'object' || typeof bundle.index?.upsert !== 'function') {
    throw new TypeError('ingestObservations: needs a bundle with an index that has upsert()');
  }
  const idx = bundle.index;
  const generation = options.generation ?? bundle.generation ?? 'gen-1';
  const labelSchemaVersion = options.labelSchemaVersion ?? bundle.labelSchemaVersion ?? 'labels-v1';

  // profileVersion **故意不传**：V1a 的 `checkRecord` 用索引自己的指纹补齐
  // （`vector-index.js:152 rec.profileVersion ?? versions.profileVersion`），
  // 而记录里带一个**调用方随手写的** profileVersion 反而会撞成 version-incompatible。
  const derived = observationToRecords(observations, { generation, labelSchemaVersion });

  const rejectedFromDerive = derived.rejected.map((r) => r.reason);
  const isolationReasons = Array.isArray(derived.isolationReasons) ? derived.isolationReasons : [];
  const isolationSummary = { isolated: Number(derived.isolated) || 0, isolationReasons };
  if (derived.records.length === 0) {
    return {
      ok: rejectedFromDerive.length === 0,
      status: derived.rejected.length > 0 || isolationSummary.isolated > 0 ? 'empty' : 'success',
      inserted: 0,
      rejected: rejectedFromDerive.length,
      ...isolationSummary,
      records: [],
      reasons: [...rejectedFromDerive, ...isolationReasons],
      indexStatus: idx.status()
    };
  }

  const up = await idx.upsert(derived.records, { generation, labelSchemaVersion });
  // V1a upsert 的 reasons 与 observationToRecords 的 rejected 形状不同，合并成一份。
  const reasons = [...rejectedFromDerive, ...isolationReasons, ...(Array.isArray(up?.reasons) ? up.reasons : [])];
  const inserted = Number(up?.inserted) || 0;
  const rejected = rejectedFromDerive.length + (Number(up?.rejected) || 0);
  assertReasonsForRejections(rejected, reasons);
  return {
    // ★ `ok` 的含义是"**全部**入库了吗"，与 V1a `upsert` 自己的 `ok: rejected === 0` 含义一致
    //   （`core/vector/vector-index.js:233`）。⚠ 试过一版写成 `up?.ok !== false`（"调用没抛"就算好）——
    //   那会让"派生阶段拒收、upsert 自己全成功"这种情况 `ok` 仍是 true，调用方先看 ok 就漏了。
    //   ⇒ 判据统一成 `rejected === 0`。
    ok: rejected === 0,
    // ★ 第②条决定：status 只回词表内的值，且只描述索引层结果。
    //   "部分入库"由 `ok===false && inserted>0` + `rejected>0` + `reasons` 表达，**不占 status**。
    status: 'success',
    inserted,
    rejected,
    ...isolationSummary,
    records: derived.records,
    reasons,
    indexStatus: idx.status()
  };
}

/**
 * 硬要求（第②条决定）：`rejected > 0` ⇒ `reasons` 必须非空。
 * 少了这一条，调用方看到"有东西没进去"却拿不到原因 ⇒ 还是会静默漏掉。
 * ⇒ 这不是提示，是**当场抛**：宁可调用方立刻炸，也不要"看起来成功、其实悄悄丢了东西"。
 * （V1a 的 `upsert` 与 `observationToRecords` 各自都保证拒收时带 reason；
 *   本函数是最后一道关口，防止将来任一侧改了取值规则而这里还照样放行。）
 */
function assertReasonsForRejections(rejected, reasons) {
  if (rejected > 0 && (!Array.isArray(reasons) || reasons.length === 0)) {
    throw new Error(
      `ingestObservations: ${rejected} record(s) were rejected but reasons[] is empty — `
      + 'refusing to report a silent partial ingest');
  }
}

/**
 * 撤回一个来源的全部派生记录：按 record.sourceId 或 evidenceIds 反查其派生记录（V1a `remove` 的薄封装）。
 * ⚠ V1a 的 `remove`/`rebuild` 返回值比票面**多一个 `reasons:[]`**（诊断用），
 *   本封装原样透出，不许吞。
 */
export async function removeSemanticRecords(bundle, sourceId) {
  if (!bundle || typeof bundle.index?.remove !== 'function') {
    throw new TypeError('removeSemanticRecords: needs a bundle with an index that has remove()');
  }
  const sourceIds = new Set();
  if (typeof sourceId === 'string' && sourceId && typeof bundle.store?.list === 'function') {
    let stored;
    try {
      stored = await bundle.store.list();
    } catch (error) {
      return {
        ok: false, removed: 0, cascaded: 0,
        reasons: [`source candidate read failed: ${String(error?.message || error)}`],
        indexStatus: bundle.index.status()
      };
    }
    if (!Array.isArray(stored)) {
      return {
        ok: false, removed: 0, cascaded: 0,
        reasons: ['source candidate store.list() must return an array'],
        indexStatus: bundle.index.status()
      };
    }
    for (const record of stored) {
      const sourceMatches = record?.sourceId === sourceId
        || (Array.isArray(record?.evidenceIds) && record.evidenceIds.some((id) => String(id) === sourceId));
      if (sourceMatches && typeof record.sourceId === 'string' && record.sourceId) {
        sourceIds.add(record.sourceId);
      }
    }
  }
  if (sourceIds.size === 0) sourceIds.add(sourceId);
  let res;
  try {
    const removeArg = sourceIds.size === 1 ? [...sourceIds][0] : [...sourceIds];
    res = await bundle.index.remove(removeArg);
  } catch (error) {
    return {
      ok: false, removed: 0, cascaded: 0,
      reasons: [`source removal failed: ${String(error?.message || error)}`],
      indexStatus: bundle.index.status()
    };
  }
  return { ...res, reasons: Array.isArray(res?.reasons) ? res.reasons : [], indexStatus: bundle.index.status() };
}

/**
 * 换代重建（V1a `rebuild` 的薄封装，reasons 原样透出）。
 *
 * ⚠ 入参 `sourceRecords` 必须是 **observationToRecords 的派生记录**（带 `text` 或 `vec`），
 *   **不是**原始观察。踩过一次：直接传原始观察（文案在 `claim` 而不是 `text`）
 *   ⇒ V1a `checkRecord` 判 "text or vec is required" ⇒ `upsert` 全拒
 *   ⇒ `rebuild` 依约把索引打成 `version-incompatible`（`core/vector/vector-index.js:435-441`）。
 *   那个行为是对的，错的是传错了形状；本注释留着免得再踩。
 */
export async function rebuildSemanticIndex(bundle, sourceRecords, options = {}) {
  if (!bundle || typeof bundle.index?.rebuild !== 'function') {
    throw new TypeError('rebuildSemanticIndex: needs a bundle with an index that has rebuild()');
  }
  const res = await bundle.index.rebuild(sourceRecords, {
    ...(options.generation ? { generation: options.generation } : {}),
    ...(options.labelSchemaVersion ? { labelSchemaVersion: options.labelSchemaVersion } : {})
  });
  return { ...res, reasons: Array.isArray(res?.reasons) ? res.reasons : [], indexStatus: bundle.index.status() };
}

/**
 * Integration entry point. All vector work is supplied by the injected embedder.
 * `sourceIds` retrieval loads candidates and applies scope/source filters before scoring.
 */
export function createMemorySemanticRecall(options = {}) {
  const bundle = createSemanticIndex(options);

  async function retrieve(retrieveOptions = {}) {
    // ★ 2026-10-17：不再为了 sourceIds 先 `store.list()` 整份 map —— 权限收窄已下沉到
    //   `index.query({sourceIds})`（打分前过滤）；索引分支对结果再做一次防御性过滤。
    return semanticRetrieve({
      ...retrieveOptions,
      index: bundle.index,
      embedder: bundle.embedder,
      records: retrieveOptions.records ?? null,
      expectedVersions: {
        generation: bundle.generation,
        profileVersion: profileFingerprint(bundle.profile),
        labelSchemaVersion: bundle.labelSchemaVersion
      }
    });
  }

  let syncing = false;
  let closed = false;
  let lastSync = null;   // 最近一次 sync 的结果（ok/status/计数/短原因）；不让旧 ready 掩盖失败
  const innerAbort = typeof AbortController === 'function' ? new AbortController() : null;
  const isAborted = (signal) => Boolean(closed || (signal && signal.aborted === true) || (innerAbort && innerAbort.signal.aborted === true));
  const yieldNow = () => new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });

  /**
   * ★ 2026-10-17（与 ds1 约定的固定接口）：增量同步“当前有效且已授权的派生记录集合”。
   *
   * 契约要点（实现按此，不另加第二套语义）：
   *   · records 可迭代（数组/生成器）；每批 `batchSize`（1..128）后让出事件循环；
   *   · 稳定 id + 内容签名比较：text 与 embedding profile 未变 ⇒ 复用已有向量（低层实现），
   *     只有 text 变才重新嵌入；scope/at/type/stable/sourceId 等元数据变只更新元数据；
   *   · `complete:true` 只有在**整份集合处理完成且没有拒收**时才删除缺失旧记录；
   *     `complete:false` 只更新已确认项，**绝不**按缺席删除；
   *   · `complete:true` 但 0 条记录时默认拒绝清空（`allowEmpty:true` 才允许）——
   *     防止"来源读取失败被当成空全量"把索引清空；
   *   · 单飞：已有 sync 在跑时直接返回 `status:'busy'`（不排队）；`signal` 或 `close()` 可取消，
   *     取消/失败都不会执行删除。
   * @returns {Promise<{ok:boolean,status:string,inserted:number,updated:number,unchanged:number,
   *   removed:number,records:number,typeCounts:object|null,reasons:string[],partial?:boolean}>}
   */
  async function runSync(input, { complete = true, batchSize = 32, signal = null, allowEmpty = false } = {}) {
    const empty = { inserted: 0, updated: 0, unchanged: 0, removed: 0, records: 0, typeCounts: null };
    if (closed) return { ok: false, status: 'cancelled', ...empty, reasons: ['index-closed'] };
    if (syncing) return { ok: false, status: 'busy', ...empty, reasons: ['sync-in-flight'] };
    syncing = true;
    const size = Math.max(1, Math.min(128, Math.floor(Number(batchSize) || 32)));
    const reasons = [];
    let inserted = 0; let updated = 0; let unchanged = 0; let rejected = 0; let removed = 0; let seen = 0;
    const seenIds = new Set();
    const cancelled = () => ({ ok: false, status: 'cancelled', inserted, updated, unchanged, removed: 0, records: seen, typeCounts: null, partial: true, reasons: [...reasons, 'sync-cancelled'] });
    const flush = async (batch) => {
      if (!batch.length) return;
      const res = await bundle.index.upsert(batch, {
        generation: bundle.generation,
        labelSchemaVersion: bundle.labelSchemaVersion
      });
      inserted += Number(res?.inserted) || 0;
      updated += Number(res?.updated) || 0;
      unchanged += Number(res?.unchanged) || 0;
      rejected += Number(res?.rejected) || 0;
      for (const reason of (Array.isArray(res?.reasons) ? res.reasons : [])) reasons.push(reason);
      await yieldNow();
    };
    try {
      if (!input || typeof input[Symbol.iterator] !== 'function') {
        return { ok: false, status: 'error', ...empty, reasons: ['records must be an array or iterable'] };
      }
      let batch = [];
      for (const rec of input) {
        if (isAborted(signal)) return cancelled();
        const id = String(rec?.id ?? '');
        if (id) {
          if (seenIds.has(id)) { reasons.push(`duplicate-id-ignored: ${id}`); continue; }
          seenIds.add(id);
        }
        batch.push(rec);
        seen += 1;
        if (batch.length >= size) { await flush(batch); batch = []; }
      }
      await flush(batch);
      if (isAborted(signal)) return cancelled();
      const stateNow = bundle.index.status();
      if (stateNow === 'version-incompatible') {
        return {
          ok: false, status: 'version-incompatible',
          inserted, updated, unchanged, removed: 0, records: seen, typeCounts: null,
          reasons: [...reasons, 'index-version-incompatible: rebuild-required']
        };
      }
      if (stateNow === 'closed') return cancelled();
      if (complete) {
        if (rejected > 0) {
          // 有记录被拒 ⇒ 这份集合不是"完整可信的全量"：不按缺席删除（失败不许清索引）。
          reasons.push('removals-skipped:rejected-records');
        } else if (seen === 0 && allowEmpty !== true) {
          const existing = await bundle.index.ids();
          if (existing.length > 0) {
            return {
              ok: false, status: 'empty-guard',
              inserted, updated, unchanged, removed: 0, records: 0, typeCounts: null,
              reasons: [...reasons, `complete=true with 0 records but index has ${existing.length}: refusing to clear (pass allowEmpty:true if the authoritative set is truly empty)`]
            };
          }
        } else {
          const existing = await bundle.index.ids();
          const stale = existing.filter((id) => !seenIds.has(id));
          if (stale.length > 0) {
            const res = await bundle.index.removeRecords(stale);
            removed = Number(res?.removed) || 0;
            for (const reason of (Array.isArray(res?.reasons) ? res.reasons : [])) reasons.push(reason);
            await yieldNow();
          }
        }
      }
      let typeCounts = null;
      try { typeCounts = await bundle.index.counts(); } catch (error) {
        reasons.push(`counts-unavailable: ${String(error?.message || error)}`);
      }
      return {
        ok: rejected === 0,
        status: rejected === 0 ? 'success' : (inserted + updated > 0 ? 'partial' : 'error'),
        inserted, updated, unchanged, removed, records: seen, typeCounts,
        reasons
      };
    } catch (error) {
      return {
        ok: false, status: thrownStatus(error),
        inserted, updated, unchanged, removed: 0, records: seen, typeCounts: null,
        partial: true, reasons: [...reasons, String(error?.message || error)]
      };
    } finally {
      syncing = false;
    }
  }

  /**
   * 对外 sync：在 runSync 之上记一份**最近一次同步结果**（runtimeStatus 用）。
   * `ok/status` 描述的是"这一轮增量同步"；索引本身的 `status()` 仍只描述索引可用性，
   * 二者分开 —— 不允许用旧的 `ready` 掩盖"上一次同步失败"。
   */
  async function sync(input, opts = {}) {
    const result = await runSync(input, opts);
    lastSync = {
      at: Date.now(),
      ok: result?.ok === true,
      status: String(result?.status ?? 'error'),
      inserted: Number(result?.inserted) || 0,
      updated: Number(result?.updated) || 0,
      unchanged: Number(result?.unchanged) || 0,
      removed: Number(result?.removed) || 0,
      records: Number(result?.records) || 0,
      partial: result?.partial === true,
      reasons: Array.isArray(result?.reasons) ? result.reasons.slice(0, 8) : []
    };
    return result;
  }

  return Object.freeze({
    get embedding() { return bundle.embedding; },
    get profileVerified() { return bundle.profileVerified; },
    profileSha256FormatValid: bundle.profileSha256FormatValid,
    // ★ coverage.generation 的来源（§6.5「换模型时建立新 generation」· M2 2026-10-14）：
    //   协调器要能如实报出"本轮数字属于哪一代向量索引"，代次只在这儿给一次，不在读侧另算。
    generation: () => String(bundle.generation ?? ''),
    status: () => bundle.index.status(),
    runtimeStatus: async () => {
      let vectorRecords = null;
      let typeCounts = null;
      let vectorReadError = null;
      try {
        // ★ 2026-10-17：轻量计数（索引镜像），不再 `store.list()` 全量拷贝。
        if (typeof bundle.index.counts === 'function') {
          const counts = await bundle.index.counts();
          vectorRecords = Number(counts?.total) || 0;
          typeCounts = { byType: counts?.byType ?? {}, bySourceType: counts?.bySourceType ?? {} };
        } else if (typeof bundle.store?.count === 'function') {
          vectorRecords = Number(await bundle.store.count()) || 0;
        } else {
          const records = await bundle.store.list();
          if (!Array.isArray(records)) throw new TypeError('vector store.list() did not return an array');
          vectorRecords = records.length;
        }
      } catch (error) {
        vectorReadError = String(error?.message ?? error);
      }
      const details = typeof bundle.index.statusDetails === 'function'
        ? bundle.index.statusDetails()
        : { state: bundle.index.status() };
      return {
        state: details?.state ?? null,
        generation: bundle.generation ?? null,
        profileVersion: details?.versions?.profileVersion ?? details?.profileFingerprint ?? null,
        labelSchemaVersion: details?.versions?.labelSchemaVersion ?? bundle.labelSchemaVersion ?? null,
        embedding: bundle.embedding ?? null,
        profileVerified: typeof bundle.profileVerified === 'boolean' ? bundle.profileVerified : null,
        profileSha256FormatValid: typeof bundle.profileSha256FormatValid === 'boolean'
          ? bundle.profileSha256FormatValid : null,
        // ★ 2026-10-17：最近一次增量同步的结论（null = 本进程还没跑过 sync）。
        //   索引 state 只描述索引可用性；同步失败/进行中要在这里如实显示。
        lastSync,
        syncing,
        vectorStore: {
          records: vectorRecords,
          typeCounts,
          revision: Number.isFinite(bundle.store?.revision) ? bundle.store.revision : null,
          persisted: false,
          readable: vectorReadError === null,
          error: vectorReadError,
        },
      };
    },
    ingest: (observations) => ingestObservations(bundle, observations),
    sync,
    retrieve,
    removeSource: (sourceId) => removeSemanticRecords(bundle, sourceId),
    rebuild: (records, rebuildOptions) => rebuildSemanticIndex(bundle, records, rebuildOptions),
    close: async () => {
      closed = true;
      try { innerAbort?.abort?.(); } catch { /* ignore */ }
      return bundle.index.close();
    }
  });
}
