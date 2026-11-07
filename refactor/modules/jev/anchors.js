/**
 * refactor/modules/jev/anchors.js — 向量锚点库（阶段 D · JEV 受限校验方）
 * 票 JS1 · L1
 *
 * 核心不变量与纪律（来源：票-JS1-锚点库.md、向量合同-v0.md、整合-JEV向量与三块计划-20261007.md）：
 *   ① 防自举：candidate 与 approved 两级分离；判定只认 approved，candidate 仅供实验
 *   ② 票≠概率：voteShare / similarity / modelScore / calibratedConfidence 禁止互相赋值，相似度严禁写进 p
 *   ③ 去相关计数：同家族模型不算独立票，输出 rawVotes 与 decorrelatedVotes 双层并记录 families
 *   ④ 溯源与连带撤回：每条锚点留 sourceId 与非空 evidenceIds；删除来源连带使依赖它的锚点失效
 *   ⑤ 评测切分防泄漏：anchor-seed / development / frozen-holdout 互斥，禁止跨集泄漏与 holdout 逆流
 *   ⑥ 缺失值严禁转 0：显式判定 null/undefined/''，去向必须是 unknown，绝不盲目 Number() 成 0
 *   ⑦ 八态契约：not-ready 与 empty 严格分离，不可就绪不许冒充空结果
 *   ⑧ 假嵌入器确定性：同文本向量逐元素一致，异文本余弦显著可区分
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ── 1. 常量与词表 ─────────────────────────────────────────────────────────────

export const SPLITS = Object.freeze(['anchor-seed', 'development', 'frozen-holdout']);

export const ANCHOR_STATUSES = Object.freeze(['candidate', 'approved', 'rejected', 'revoked']);

export const MATCH_STATUSES = Object.freeze([
  'success',
  'empty',
  'not-ready',
  'timeout',
  'cancelled',
  'version-incompatible',
  'stale',
  'partial-coverage',
  'error'
]);

// 已知模型家族映射（前缀/子串归一化）
const KNOWN_FAMILIES = [
  { match: /(^qwen|qwen2|tongyi)/i, family: 'qwen' },
  { match: /(^deepseek|deepseek-chat|deepseek-coder)/i, family: 'deepseek' },
  { match: /(^glm|chatglm|zhipu)/i, family: 'glm' },
  { match: /(^claude|anthropic)/i, family: 'claude' },
  { match: /(^gpt|openai|o1|o3)/i, family: 'gpt' },
  { match: /(^llama|meta)/i, family: 'llama' },
  { match: /(^mistral|mixtral)/i, family: 'mistral' },
  { match: /(^internlm|shanghai)/i, family: 'internlm' },
  { match: /(^baichuan)/i, family: 'baichuan' },
  { match: /(^minimax|abab)/i, family: 'minimax' }
];

/**
 * 模型家族识别（同家族归一）
 * @param {string} modelName
 * @returns {string} 家族标识
 */
export function resolveModelFamily(modelName) {
  const m = String(modelName ?? '').trim();
  if (!m) return 'unknown';
  for (const { match, family } of KNOWN_FAMILIES) {
    if (match.test(m)) return family;
  }
  const prefix = m.split(/[-_/]/)[0];
  return prefix ? prefix.toLowerCase() : 'unknown';
}

/**
 * 安全解析数值（硬规则 6：缺失值绝对不隐式变 0）
 * @param {*} val
 * @returns {number|null}
 */
export function safeNumber(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

// ── 2. 向量地基接口集成（JS1 §二：从 core/vector 导入，杜绝双份实现漂移）──────────

import {
  makeProfile,
  makeFakeEmbedder as vectorMakeFakeEmbedder,
  createIndex,
  isProfileVerified,
  profileFingerprint,
  cosineSimilarity,
  validateDimensions
} from '../../core/vector/index.js';

export const DEFAULT_ANCHOR_PROFILE = Object.freeze({
  profileVersion: 'v0',
  modelId: 'bge-base-zh-v1.5-q8_0',
  modelSha256: null,
  runtime: 'llama',
  build: 'fake-0.1',
  pooling: 'cls'
});

/**
 * 创建确定性假嵌入器（对齐 core/vector 权威实现）
 * @param {object} [profile]
 * @returns {object} Embedder 实例
 */
export function makeFakeEmbedder(profile = null) {
  const prof = profile && typeof profile === 'object' && 'profileVersion' in profile
    ? makeProfile(profile)
    : makeProfile({
      ...DEFAULT_ANCHOR_PROFILE,
      ...(profile && typeof profile === 'object' ? profile : {})
    });
  return vectorMakeFakeEmbedder(prof);
}

export { cosineSimilarity };

// ── 3. 存储层：makeStore ─────────────────────────────────────────────────────

/**
 * 创建锚点存储层（落盘于 <dataDir>/jev-anchors/）
 * @param {{ dataDir: string }} options
 */
export function makeStore({ dataDir } = {}) {
  if (!dataDir || typeof dataDir !== 'string') {
    throw new Error('makeStore: dataDir 必须是有效字符串路径');
  }

  const baseDir = path.join(path.resolve(dataDir), 'jev-anchors');
  fs.mkdirSync(baseDir, { recursive: true });

  const candidatesFile = path.join(baseDir, 'candidates.ndjson');
  const approvedFile = path.join(baseDir, 'approved.ndjson');
  const splitsFile = path.join(baseDir, 'splits.ndjson');

  // 内存快速索引
  const memoryCandidates = new Map();
  const memoryApproved = new Map();
  const sourceToAnchorIds = new Map(); // sourceId -> Set<anchorId>
  const splitRegistry = new Map();     // key (eventId|sourceId|textHash) -> split

  function appendNdjson(filePath, record) {
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  function rewriteNdjson(filePath, map) {
    const tmp = `${filePath}.tmp.${Date.now()}`;
    const lines = Array.from(map.values()).map((r) => JSON.stringify(r));
    fs.writeFileSync(tmp, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
    fs.renameSync(tmp, filePath);
  }

  // 启动加载存量
  function loadInitial() {
    if (fs.existsSync(candidatesFile)) {
      const lines = fs.readFileSync(candidatesFile, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (item?.id) {
            memoryCandidates.set(item.id, item);
            if (item.sourceId) {
              if (!sourceToAnchorIds.has(item.sourceId)) sourceToAnchorIds.set(item.sourceId, new Set());
              sourceToAnchorIds.get(item.sourceId).add(item.id);
            }
          }
        } catch {}
      }
    }
    if (fs.existsSync(approvedFile)) {
      const lines = fs.readFileSync(approvedFile, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (item?.id) {
            memoryApproved.set(item.id, item);
            if (item.sourceId) {
              if (!sourceToAnchorIds.has(item.sourceId)) sourceToAnchorIds.set(item.sourceId, new Set());
              sourceToAnchorIds.get(item.sourceId).add(item.id);
            }
          }
        } catch {}
      }
    }
    if (fs.existsSync(splitsFile)) {
      const lines = fs.readFileSync(splitsFile, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (item?.key && item?.split) splitRegistry.set(item.key, item.split);
        } catch {}
      }
    }
  }

  loadInitial();

  return {
    baseDir,
    candidatesFile,
    approvedFile,
    splitsFile,

    // ── 切分校验 ──
    checkSplit(key, targetSplit) {
      if (!SPLITS.includes(targetSplit)) {
        return { ok: false, reason: `未知评测切分集: ${targetSplit}` };
      }
      if (splitRegistry.has(key)) {
        const existing = splitRegistry.get(key);
        if (existing !== targetSplit) {
          return {
            ok: false,
            reason: `切分集冲突: 标识 "${key}" 已存在于切分集 "${existing}"，禁止跨集泄漏到 "${targetSplit}"`
          };
        }
      }
      return { ok: true };
    },

    registerSplit(key, targetSplit) {
      const chk = this.checkSplit(key, targetSplit);
      if (!chk.ok) return chk;
      splitRegistry.set(key, targetSplit);
      appendNdjson(splitsFile, { key, split: targetSplit, at: Date.now() });
      return { ok: true };
    },

    // ── 写入候选 ──
    saveCandidate(anchor) {
      anchor.status = 'candidate';
      anchor.savedAt = Date.now();
      memoryCandidates.set(anchor.id, anchor);
      if (anchor.sourceId) {
        if (!sourceToAnchorIds.has(anchor.sourceId)) sourceToAnchorIds.set(anchor.sourceId, new Set());
        sourceToAnchorIds.get(anchor.sourceId).add(anchor.id);
      }
      appendNdjson(candidatesFile, anchor);
      return { ok: true, id: anchor.id };
    },

    // ── 晋升为 approved ──
    saveApproved(anchor) {
      anchor.status = 'approved';
      anchor.promotedAt = Date.now();
      // 从 candidate 移除
      memoryCandidates.delete(anchor.id);
      rewriteNdjson(candidatesFile, memoryCandidates);
      // 写入 approved
      memoryApproved.set(anchor.id, anchor);
      appendNdjson(approvedFile, anchor);
      return { ok: true, id: anchor.id };
    },

    getCandidate(id) {
      return memoryCandidates.get(id) || null;
    },

    getApproved(id) {
      return memoryApproved.get(id) || null;
    },

    getAnchor(id) {
      return memoryApproved.get(id) || memoryCandidates.get(id) || null;
    },

    listApproved(scope = null) {
      const list = Array.from(memoryApproved.values());
      return scope ? list.filter((a) => a.scope === scope) : list;
    },

    listCandidates(scope = null) {
      const list = Array.from(memoryCandidates.values());
      return scope ? list.filter((a) => a.scope === scope) : list;
    },

    // ── 溯源连环撤回（硬规则 4） ──
    removeBySourceId(sourceId) {
      if (!sourceId) return { ok: false, reason: '缺少 sourceId' };
      const ids = sourceToAnchorIds.get(sourceId);
      if (!ids || ids.size === 0) {
        return { ok: false, reason: `未找到依赖 sourceId="${sourceId}" 的锚点记录`, cascaded: [] };
      }

      const cascaded = Array.from(ids);
      for (const id of cascaded) {
        memoryCandidates.delete(id);
        memoryApproved.delete(id);
      }
      sourceToAnchorIds.delete(sourceId);

      rewriteNdjson(candidatesFile, memoryCandidates);
      rewriteNdjson(approvedFile, memoryApproved);

      return {
        ok: true,
        sourceId,
        cascadedCount: cascaded.length,
        cascaded
      };
    }
  };
}

// ── 4. 准入与生命周期：addCandidate, tallyVotes, promote ─────────────────────

/**
 * 录入候选锚点
 * 硬规则 1：状态恒为 candidate
 * 硬规则 4：必须有 sourceId 与非空 evidenceIds
 * 硬规则 5：frozen-holdout 严禁作为 candidate 输入；同源样本禁止跨集
 * @param {object} store - makeStore 返回的实例
 * @param {object} anchorInput
 */
export function addCandidate(store, anchorInput) {
  if (!store || typeof store.saveCandidate !== 'function') {
    throw new Error('addCandidate: 必须提供有效的 store 实例');
  }

  const {
    id = `anc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    text,
    scope = 'global',
    labelSchemaVersion = 'v0',
    evidenceIds,
    sourceId,
    split = 'development',
    label = null,
    votes = []
  } = anchorInput || {};

  // 1. 文本校验
  const cleanText = String(text ?? '').trim();
  if (!cleanText) {
    return { ok: false, reason: '锚点文本不能为空' };
  }

  // 2. 溯源校验（硬规则 4 / 牙 4）
  if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) {
    return {
      ok: false,
      reason: '缺少有效 evidenceIds: 锚点必须具备非空证据列表以支持追溯（硬规则 4）'
    };
  }

  const cleanSourceId = String(sourceId ?? '').trim();
  if (!cleanSourceId) {
    return {
      ok: false,
      reason: '缺少有效 sourceId: 锚点必须具备来源标识以支持连带撤销'
    };
  }

  // 3. 切分防护（硬规则 5 / 牙 5）
  if (split === 'frozen-holdout') {
    return {
      ok: false,
      reason: '切分集违规: frozen-holdout 保留集严禁作为候选锚点输入（防评测污染，硬规则 5）'
    };
  }

  const splitKey = cleanSourceId;
  const splitCheck = store.registerSplit(splitKey, split);
  if (!splitCheck.ok) {
    return splitCheck;
  }

  // 4. 组装并保存 Candidate
  const record = {
    id,
    text: cleanText,
    scope: String(scope),
    labelSchemaVersion: String(labelSchemaVersion),
    sourceId: cleanSourceId,
    evidenceIds: evidenceIds.map(String),
    split,
    label: label ? String(label) : null,
    votes: Array.isArray(votes) ? votes : [],
    status: 'candidate'
  };

  store.saveCandidate(record);
  return { ok: true, id, status: 'candidate', record };
}

/**
 * 汇总投票（硬规则 3：去相关计数；硬规则 6：缺失值转 unknown，禁止隐式变 0）
 * @param {object} anchor
 * @param {Array<object>} votes
 * @param {{ minVoters?: number, minAgreement?: number }} [options]
 */
export function tallyVotes(anchor, votes, { minVoters = 3, minAgreement = 0.6 } = {}) {
  const voteList = Array.isArray(votes) ? votes : (Array.isArray(anchor?.votes) ? anchor.votes : []);
  const minV = safeNumber(minVoters) ?? 3;
  const minAg = safeNumber(minAgreement) ?? 0.6;

  const rawVotes = voteList.length;
  const reasons = [];

  // 硬规则 6：缺失值判定，不许当成 0 票
  if (rawVotes === 0) {
    return {
      rawVotes: 0,
      decorrelatedVotes: 0,
      agreement: null,
      verdict: 'rejected',
      families: [],
      reasons: ['投票列表为空，去向判定为 rejected / unknown（未收到有效投票，绝非 0 票赞成）']
    };
  }

  // 校验并清洗投票
  const familyBuckets = new Map(); // family -> Array<vote>
  let unknownVotesCount = 0;

  for (const v of voteList) {
    if (!v || typeof v !== 'object') {
      unknownVotesCount += 1;
      continue;
    }
    const label = v.label !== null && v.label !== undefined && v.label !== '' ? String(v.label).trim() : null;
    const model = String(v.model ?? v.voter ?? '').trim();
    const family = v.family ? String(v.family).trim() : resolveModelFamily(model);

    // 缺少判定标签，记录为 unknown
    if (!label) {
      unknownVotesCount += 1;
      continue;
    }

    if (!familyBuckets.has(family)) {
      familyBuckets.set(family, []);
    }
    familyBuckets.get(family).push({
      label,
      model,
      family,
      confidence: safeNumber(v.confidence) // 保持独立，不与 p 混淆
    });
  }

  const families = Array.from(familyBuckets.keys());
  const decorrelatedVotes = families.length;

  // 统计去相关投票（家族内多数票共识，每家族最多出 1 票）
  const decorrelatedLabelCounts = new Map();
  for (const [fam, fVotes] of familyBuckets.entries()) {
    const labelCounts = new Map();
    for (const item of fVotes) {
      labelCounts.set(item.label, (labelCounts.get(item.label) || 0) + 1);
    }
    // 家族内胜出标签
    let topLabel = null;
    let maxC = 0;
    for (const [lbl, cnt] of labelCounts.entries()) {
      if (cnt > maxC) {
        maxC = cnt;
        topLabel = lbl;
      }
    }
    if (topLabel) {
      decorrelatedLabelCounts.set(topLabel, (decorrelatedLabelCounts.get(topLabel) || 0) + 1);
    }
  }

  // 计算共识度（按去相关票计算）
  let topConsensusLabel = null;
  let topConsensusCount = 0;
  for (const [lbl, cnt] of decorrelatedLabelCounts.entries()) {
    if (cnt > topConsensusCount) {
      topConsensusCount = cnt;
      topConsensusLabel = lbl;
    }
  }

  const agreement = decorrelatedVotes > 0 ? (topConsensusCount / decorrelatedVotes) : 0;

  if (unknownVotesCount > 0) {
    reasons.push(`存在 ${unknownVotesCount} 条缺失标签/判定无效的投票，已标记为 unknown 未知票`);
  }

  // 判定 verdict：
  // 达到独立人数要求且共识度达标 -> candidate 准入晋升候选（注意：仍需人工复审才能成 approved）
  let verdict = 'candidate';
  if (decorrelatedVotes < minV) {
    verdict = 'candidate';
    reasons.push(`去相关独立选民家族数不足（实际 ${decorrelatedVotes}，要求 ${minV}），保持 candidate`);
  } else if (agreement < minAg) {
    verdict = 'rejected';
    reasons.push(`共识度未达标（实际 ${agreement.toFixed(2)}，要求 ${minAg}），判定 rejected`);
  } else {
    // 达成多数共识
    verdict = 'candidate'; // 机器多数投票胜出后成为合格 candidate，等主人 promote
    reasons.push(`达成去相关共识（${topConsensusLabel}，共识度 ${agreement.toFixed(2)}），进入合格 candidate 待人工复审`);
  }

  return {
    rawVotes,
    decorrelatedVotes,
    agreement: Number(agreement.toFixed(4)),
    topLabel: topConsensusLabel,
    verdict,
    families,
    unknownVotes: unknownVotesCount,
    reasons
  };
}

/**
 * 晋升锚点（硬规则 1 & 三条纪律 ③：人工复审是唯一晋升闸门）
 * @param {object} store - makeStore 返回的实例
 * @param {string} anchorId - 锚点 ID
 * @param {object} humanApproval - 人工复审凭证 { reviewer, at, decision: 'approved', note }
 */
export function promote(store, anchorId, humanApproval) {
  if (!store || typeof store.getAnchor !== 'function') {
    throw new Error('promote: 必须提供有效的 store 实例');
  }

  const anchor = store.getAnchor(anchorId);
  if (!anchor) {
    return { ok: false, reason: `未找到锚点 ID="${anchorId}"` };
  }

  // 严审人工复审记录
  if (!humanApproval || typeof humanApproval !== 'object') {
    return {
      ok: false,
      reason: '禁止晋升: 缺少人工复审凭证（硬规则 1 / 纪律 ③：没有人工复审记录不许进 approved）'
    };
  }

  const { reviewer, decision, note } = humanApproval;
  const reviewerStr = String(reviewer ?? '').trim();
  const decisionStr = String(decision ?? '').trim();

  if (!reviewerStr || decisionStr !== 'approved') {
    return {
      ok: false,
      reason: `人工复审未批准: reviewer="${reviewerStr}", decision="${decisionStr}"（必须为明确 approved）`
    };
  }

  const reviewRecord = {
    reviewer: reviewerStr,
    decision: 'approved',
    at: safeNumber(humanApproval.at) ?? Date.now(),
    note: String(note ?? '')
  };

  anchor.humanReview = reviewRecord;
  store.saveApproved(anchor);

  return {
    ok: true,
    id: anchor.id,
    status: 'approved',
    humanReview: reviewRecord
  };
}

// ── 5. 检索匹配与证据生成：matchAnchors, asJevEvidence ─────────────────────────

/**
 * 匹配锚点（V0 §4 八态契约 + 硬规则 1 防自举 + 硬规则 2 票≠概率 + JS1 §二 向量地基接线）
 * @param {{
 *   embedder?: object,
 *   store?: object,
 *   index?: object,
 *   text: string,
 *   scope?: string|object,
 *   at?: number,
 *   topK?: number,
 *   threshold?: number|null,
 *   mode?: 'decision'|'experiment'
 * }} options
 */
export async function matchAnchors({
  embedder,
  store,
  index = null,
  text,
  scope = 'global',
  at = null,
  topK = 5,
  threshold = null,
  mode = 'decision'
} = {}) {
  const cleanText = String(text ?? '').trim();
  if (!cleanText) {
    return {
      ok: true,
      status: 'empty',
      items: [],
      reasons: ['输入文本为空，返回空命中（V0 empty 态）']
    };
  }

  // 1. 若显式注入了 core/vector 的 Index 实例（JS1 §二 接线）
  if (index && typeof index.query === 'function') {
    const idxStatus = typeof index.status === 'function' ? index.status() : 'ready';
    if (idxStatus === 'not-ready') {
      return { ok: false, status: 'not-ready', items: [], reasons: ['向量索引未就绪（core/vector not-ready）'] };
    }
    if (idxStatus === 'version-incompatible') {
      return { ok: false, status: 'version-incompatible', items: [], reasons: ['向量索引版本不兼容（core/vector version-incompatible）'] };
    }
    if (idxStatus === 'stale') {
      return { ok: false, status: 'stale', items: [], reasons: ['向量索引已过期（core/vector stale）'] };
    }
    if (idxStatus === 'closed') {
      return { ok: false, status: 'cancelled', items: [], reasons: ['向量索引已关闭（core/vector closed）'] };
    }

    const normScope = typeof scope === 'object' && scope !== null && !Array.isArray(scope)
      ? scope
      : { scope: String(scope) };

    const qOpts = {
      scope: normScope,
      topK: safeNumber(topK) ?? 5,
      threshold,
      mode,
      ...(at !== null && at !== undefined ? { at } : {})
    };

    let res;
    try {
      res = await index.query(cleanText, qOpts);
    } catch (err) {
      return {
        ok: false,
        status: 'error',
        items: [],
        reasons: [`index.query 抛错: ${err?.message || err}`]
      };
    }

    let items = (res?.items || []).map((it) => {
      const full = store && typeof store.getAnchor === 'function' ? store.getAnchor(it.id) : null;
      return {
        id: it.id,
        sourceId: it.sourceId,
        scope: it.scope,
        score: it.score,
        label: full?.label ?? it.label,
        labelSchemaVersion: full?.labelSchemaVersion ?? it.labelSchemaVersion,
        status: full?.status ?? it.status ?? 'approved'
      };
    });

    if (mode === 'decision') {
      items = items.filter(it => it.status === 'approved');
    }

    let finalStatus = res?.status;
    if (finalStatus === 'success' && items.length === 0) {
      finalStatus = 'empty';
    }

    return {
      ok: res?.ok === true,
      status: finalStatus ?? (items.length > 0 ? 'success' : 'empty'),
      items,
      reasons: res?.reasons || []
    };
  }

  // 纯 store + embedder 路径已被废弃（硬要求 1：必须走注入的 index，未注入则明确降级）
  return {
    ok: false,
    status: 'not-ready',
    items: [],
    reasons: ['未注入向量索引 (index缺失)（V0 not-ready 态）']
  };
}

/**
 * 转换成 JEV 检索证据（硬规则 1 / 来源计划 §4：只许产出检索证据，严禁直接产出 p/allow/blockedBy）
 * @param {object} matchesResult
 * @returns {object} JevEvidence 形状
 */
export function asJevEvidence(matchesResult) {
  if (!matchesResult || typeof matchesResult !== 'object') {
    return {
      type: 'anchor_evidence',
      ok: false,
      count: 0,
      evidenceItems: []
    };
  }

  const items = Array.isArray(matchesResult.items) ? matchesResult.items : [];

  // 脱敏与合规提纯：严禁携带 p / allow / blockedBy
  const evidenceItems = items.map((it) => ({
    anchorId: it.id,
    sourceId: it.sourceId,
    similarityScore: it.score,
    label: it.label,
    scope: it.scope
  }));

  const evidence = {
    type: 'anchor_evidence',
    ok: matchesResult.ok === true,
    status: matchesResult.status,
    count: evidenceItems.length,
    evidenceItems,
    matchedAt: Date.now()
  };

  // 防御性校验：断言不含判定性决定字段
  if ('p' in evidence || 'allow' in evidence || 'blockedBy' in evidence) {
    delete evidence.p;
    delete evidence.allow;
    delete evidence.blockedBy;
  }

  return evidence;
}

// ── 6. §二 向量地基集成辅助出口 ───────────────────────────────────────────────

/**
 * 创建基于 core/vector 的锚点向量索引（JS1 §二 接线）
 * 门禁说明：
 *   - modelSha256 允许为 null（V1b 真机前使用假嵌入器）
 *   - 自动调用 isProfileVerified(profile) 判定真假嵌入器
 */
export function createAnchorVectorIndex({
  profile = null,
  embedder = null,
  store = null,
  generation = 'gen-1',
  labelSchemaVersion = 'v0'
} = {}) {
  const prof = profile ? makeProfile(profile) : makeProfile(DEFAULT_ANCHOR_PROFILE);
  let activeEmbedder = embedder;
  if (!activeEmbedder) {
    activeEmbedder = makeFakeEmbedder(prof);
  }

  const idx = createIndex({
    profile: prof,
    embedder: activeEmbedder,
    store,
    generation,
    labelSchemaVersion
  });

  return {
    profile: prof,
    embedder: activeEmbedder,
    index: idx
  };
}
