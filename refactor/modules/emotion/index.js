/**
 * refactor/modules/emotion/index.js — M7 情绪·精力·好感·关系（**纯状态模型**）
 *
 * 六个公开出口（票面建议形状 + 指挥位 2026-10-04 追加的渲染出口）：
 *   initState / applyEvent / styleHint / renderRelationSummary / relationOf / snapshot
 * 外加 §3.5 冻结的兼容名 `isHypeMode`，以及给装配层/测试用的只读常量与事件校验器。
 *
 * ★ 这个模块**没有**「回不回话」的出口：
 *   - `applyEvent` 只往 self/persons 上写「现在是什么状态」，可写字段被 events.js 的
 *     `DELTA_FIELDS` 白名单钉死；白名单外（例如 `shouldReply`）直接判非法事件 → 抛错。
 *   - 对外只有两个**字符串**出口：`styleHint`（此刻该怎么说话）与 `renderRelationSummary`（和这个人关系如何）。
 *     都不返回布尔、不返回动作 —— 而 `snapshot` 只给 UI/trace，提示词层拿不到数值。
 *   - 本模块不 import 也不构造 `Verdict`/`ActionPlan`（否决与决定长在 contracts 的那两个结构里）。
 */
export { initState, POOLS, AFFECT, EMOTION_ALIASES, DEFAULT_POOLS, PERSON_DEFAULTS, targetsFor, cognitiveDrainScale, COGNITIVE_SOFT_KNEE, COGNITIVE_SOFT_FULL, COGNITIVE_SOFT_MIN, EMOTION_PROFILES } from './state.js';
export { applyEvent, effectiveTargets, project, normalizeEmoKeys, ACTIVITY_LEVELS, resolveActivityConfig } from './apply.js';
export { styleHint, renderRelationSummary, RELATION_SUMMARY_MAX_CHARS } from './hint.js';
export { relationOf } from './relation.js';
export { snapshot } from './view.js';
// ★ 票 N30：照老树补的注入出口。`botStatePromptLine` 是老树 `botStatePromptLine()` 的同名同格式版，
//   `computeIntent` 是老树那个"intent 出口"。两者**都没删** styleHint —— 三者并存，由 prompt 层选。
export {
  botStatePromptLine, computeIntent, normalizeForPrompt, isNotableState,
  energyLabel, moodLabel, socialLabel
} from './prompt-line.js';
// ★ 票 N30：老树 14 类情绪目录 + 标签/人话/方向/半衰，以及后台目录页出口。
export {
  EMOTIONS, EMO_KEYS, EMO_PLAIN, POS_EMO, NEG_EMO, HOT_NEG, CAT_LABEL, SIGN_LABEL,
  metaOf, plainOf, topEmotionEntries, topEmotionPhrases, listEmotionCatalog
} from './catalog.js';
// ★ 票 N30：老树 hype-mode 的 5 个缺失出口（硬保护 QQ / 工具表 / 状态快照 / 到点自动退）。
export {
  isHypeMode, getHypeProtectedQQ, HYPE_PROTECTED_QQ, HYPE_TOOLS,
  isHypeProtectedTarget, sanitizeHypeProtectedArgs, hypeStatus, hypeAutoExitDue
} from './hype-mode.js';
export {
  validateEvent, EMOTION_EVENT_TYPES, EVIDENCE_SOURCES, DELTA_FIELDS,
  RELATION_FIELDS, TONE_VALUES, FAVOR_REASONS, NEVER_SCORE_REASONS
} from './events.js';
// ★ 2026-10-11（glm1 · 功能表 4+5）：自然语言理由 → FAVOR_REASONS 类别归类器。
//   memory_favor 教模型写自由文本，M7 契约要类别 ⇒ 中间这层映射补上（映射不到 ⇒ null ⇒ 不落账）。
//   搬运层兼容面不许改名；这是新增出口，`...emotionMod` 门面会自动带上。
export { classifyFavorReason, FAVOR_REASON_CATEGORIES, neverScoreHit, classifyFavorReasonDetailed, FAVOR_REASON_GUIDE } from './favor-reason.js';
export { createPersonaTwoController } from './persona-two.js';
// ★ 2026-10-11（指挥位派单 · 用户第 2 条）：模型自评（finish 的 mood/favorDelta）消费方。
//   老树"独立自评轮 → mood/favorDelta"在新树整条丢失（用户说话推不动情绪）⇒ 照老树语义接回：
//   mood 归一 + 逐 kind 数值表 + favorDelta 正负调心情。M15 是情绪事件唯一 owner，本模块只出纯函数。
export {
  parseMoodKinds, normalizeSelfEvalMood, selfEvalDeltas, favorSignMoodDelta,
  MOOD_KIND_DELTAS, SELF_EVAL_EXCLUDED_KINDS
} from './mood-tags.js';
// ★ 2026-10-15（用户裁定 · 情绪缺口第一组）：入站情绪 cue 的可解释识别 + 指向性过滤 + 同 kind 冷却值表。
//   老树「词表 + addressed 过滤」层的降级移植（不搬 emotionGate/0.8B）；纯函数，供 M15 生产调用。
export {
  recognizeInboundCue, mentionsSelfName, inboundCueDeltas, cooldownMsForKind,
  CUE_COOLDOWN_MS, CUE_HIGH_FREQ_COOLDOWN_MS, CUE_HIGH_FREQ_KINDS, AIMED_NEG
} from './inbound-cue.js';

// ★ 2026-10-16（离散情绪兜底 · 用户报"离散情绪长期不动/自评不足"）：词表/规则三层（无模型调用）——
//   弱线索挑选 `pickFallbackCue` + 有界增量 `fallbackDeltas` + 轮次闸 `createFallbackTracker`
//   + "本轮已有有效变化"判据 `isAffectLedgerRow`；接线在 orchestrator 的轮末情绪块。
export {
  FALLBACK_EVERY_ROUNDS, FALLBACK_SCALE, FALLBACK_MAX_PER_KEY, FALLBACK_CUE_KIND, FALLBACK_KINDS,
  pickFallbackCue, fallbackDeltas, isAffectLedgerRow, createFallbackTracker
} from './fallback.js';
// ★ 2026-10-15（情绪缺口第二组）：环境事件与轮成本 —— 值表 + 纯判定（状态写入在 apply.js 的 onRound）。
//   `planRoundEnv`/`ENV_KIND_DELTAS` 是"为什么被冷落/无聊/刷屏"的可解释来源；冷却值仍在 cooldownMsForKind。
export {
  ENV_KIND_DELTAS, planRoundEnv, ROUND_COST, SLOW_PRESSURE, PURE_POSITIVE_KINDS,
  ENV_NEGLECT_COOLDOWN_MS, ENV_BOREDOM_COOLDOWN_MS, ENV_STREAK_DECAY_MS,
  NEGLECT_STREAK_THRESHOLD, BOREDOM_STREAK_THRESHOLD, BUSY_TRIGGER_THRESHOLD
} from './env-events.js';
export { HALF_LIFE_MIN, HALF_LIFE_CATEGORIES, FLOOR, DEAD, POOL_HALF_LIFE_CATEGORY, poolHalfLifeOf } from './half-life.js';
// ★ E1（2026-10-12 · 唯一指导 §7.1）：状态所有者入模块 —— 加载/读取/管理修改/保存四件事的唯一出口。
//   `normalizeId` 一并导出后，装配层 currentEmotionConfig（assembly.js:629）会自动优先用本模块的
//   归一（它注释里预留的出口）；`manageEdit` 是纯函数，面板改状态与台账行都从这里走。
export { createStateOwner, manageEdit, resolveConfig, normalizeId } from './state-owner.js';
// ★ 记忆隔离（2026-10-13 定分工：mimo1 函数 · qwen1 断言+消费点 · luna2 compose 同 import）：
//   双人格读侧可见性的**唯一实现**，语义=老树 selfRowVisibleNow（一律隔离、无标=第一人格、UI 不滤）。
export { selfRowVisibleNow } from './persona-hygiene.js';
