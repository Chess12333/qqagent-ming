/**
 * M9 jev —— 阶段 D 的**受限校验方**（README §2 M9 / §1 D 行）· **公开唯一出口**
 *
 * 一句话：Jev 是「证据不足时的候选信号提供者」，**不是闸门**。
 * 决定「回/不回」的地方只有 M8 一处（§0.5 决定权唯一）。
 *
 * 冻结接口（派单）：
 *   ROLES / ask(roleId, input, {timeoutMs, traceId, model}) / asSignal(result) / fallback(roleId, reason) / stats({n})
 * 搬运层兼容面（README §3.5，**必须导出、不许改名**）：
 *   localJevHasRole / jevJudgeTextOnly / jevSaySkipLine   ← platform/salvage 在用
 *
 * ★ 结构上的三条不变量（selftest.mjs 逐条有牙）：
 *   ① 信号里没有 `allow`，也没有 `blockedBy` —— 单个 role 永远无法单独否决；
 *   ② 角色表每个 id 都有唯一调用点（静态扫 `refactor/modules/`，防旧版 3 个死角色复发）；
 *   ③ 账本每行的 `role` 必须是真实角色 id（防旧版把 emotionGate 记成 'choice'）。
 * ★ `asSignal(result)` 的三个出口（2026-10-04 裁定：**null 是值，不是错误标记**）：
 *   不认识的形状（null / 缺 role|status / status 不在词表 / accepted 却无标签）⇒ **抛 TypeError**；
 *   认识形状但这档不产信号（abstain/timeout/error/unavailable/invalid）⇒ **null**；
 *   判成了（accepted / low-confidence）⇒ 返回信号。两段式用法：`const r = await ask(...); asSignal(r)`。
 * ★ 只 import `contracts/index.js` + `node:`（派单白名单）；模型与账本都走注入，第 3 批由装配层接线。
 */

// ── 角色表 ───────────────────────────────────────────────────────────────
export { ROLES, ROLE_IDS, ABSTAIN_LABEL, LEGACY_RETIRED_IDS, hasRole, roleOf } from './roles.js';

// ── 内核：注入 / 判定 / 信号 / 账本 ──────────────────────────────────────
export {
  configure,
  ask,
  evaluateRoles,
  asSignal,
  fallback,
  signalsFor,
  stats,
  observationRows,
  resetObservations,
  isModelBound,
  isJudgeModelBound,
  isLedgerBound,
  TECHNICAL_STATUSES,
  SEMANTIC_STATUSES,
  isTechnical,
  isSemantic,
  MODEL_CONTRACT,
  STATUSES,
  judgeBudgetState,
  JUDGE_TOTAL_TOKEN_CAP,
  // ★ 2026-10-17（白屏修复）：这两个常量定义在 **core.js**（判定输出预算区间），
  //   上一版误放进下面 `'./judge.js'` 的再导出块 ⇒ ESM 实例化直接 SyntaxError
  //   （crash.log：「does not provide an export named 'JUDGE_OUTPUT_MIN'」）⇒ 整个服务起不来。
  JUDGE_OUTPUT_MIN,
  JUDGE_OUTPUT_MAX,
} from './core.js';

// ── 向量锚点（检索辅助） ───────────────────────────────────────────────
export {
  makeStore,
  makeFakeEmbedder,
  addCandidate,
  tallyVotes,
  promote,
  matchAnchors,
  asJevEvidence,
  createAnchorVectorIndex
} from './anchors.js';

// ── 判定细节（装配/排障用；不参与决定权）────────────────────────────────
export { buildPrompt, parseModelOutput, classify, clipInput } from './engine.js';

// ── 搬运层兼容面（§3.5 冻结，M3 platform/salvage 在用）───────────────────
export {
  localJevHasRole,
  jevJudgeTextOnly,
  jevSaySkipLine,
  draftFromLocal,
  looksLikeNarration,
} from './compat.js';

// ── J1 云三项结构化判断（2026-10-12 指导 §8；一次请求 join/continue/memory）──
export {
  judgeOnce,
  buildJudgeInput,
  renderJudgePrompt,
  parseJudgeOutput,
  judgePauseState,
  resetJudgePause,
  JUDGE_PROMPT,
  PROMPT_BUDGET_CHARS,
  JUDGE_ROLE,
  JUDGE_TIMEOUT_MS,
  JUDGE_PAUSE_AFTER,
  JUDGE_PAUSE_MS,
  // ★ 2026-10-16（计量口径）：软估计 / 硬上界 / 软目标 / 输出预算区间一起出口，诊断与 UI 用同一份定义。
  estimateTokens,
  upperBoundTokens,
  JUDGE_SOFT_TOTAL_TOKENS,
  JUDGE_SOFT_OUTPUT_TOKENS,
  MAX_JUDGE_TOKENS,
  TOKEN_COUNT_SOFT,
  TOKEN_COUNT_UPPER,
  JOIN_VALUES,
  CONTINUE_VALUES,
  MEMORY_MODES,
} from './judge.js';
