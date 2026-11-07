/**
 * M7 emotion · 离散情绪兜底（**词表/规则，无模型调用**）· 用户 2026-10-16 报"离散情绪长期不动、自评不足"
 *
 * 机制（逐条对齐用户口径）：
 *   · **轮次闸**：同一会话**至少每 3 轮**检查一次（`createFallbackTracker`）。用**轮次**而不是时间冷却
 *     —— 时间冷却会在快节奏会话里把兜底永远拦掉（用户点名的坑：本模块的 kind 冷却为 0，见 inbound-cue.js）。
 *   · **不重复加**：本轮若已有**有效**的离散情绪变化（自评 / 入站 cue / 环境事件真写进 `affect.*`），
 *     本次不加。判据由调用方按**情绪台账**算：`isAffectLedgerRow` —— 冷却/校验拒绝写的是
 *     `field:'cooldown'` 之类，`kind !== 'event'`（衰减走别的 kind），天然不算"有效变化"。
 *   · **小幅有界**：数值 = 与自评/入站**同一张老树表**（`selfEvalDeltas`）× `FALLBACK_SCALE`，
 *     **只留 `affect.*`**（mood/arousal/pools/stress 各有自己的通路，兜底不碰），逐键
 *     ±`FALLBACK_MAX_PER_KEY` 封顶、四舍五入（0 丢掉）⇒ 单键最多 ±3；键数随所用表
 *     （实测各档 3~6 个 affect 键，单次总幅度 |Σ| ≤ ~4）。事件不带 `senderId` ⇒ 不触发亲密放大
 *     （apply.js 的 closeness boost），幅度就是这里算出来的数。
 *   · **补现有词表的空档**：`inbound-cue.js` 只认 roast/tease/praise/gratitude（且带指向性闸）；
 *     这里补 chat / memeOk / curiosity / boredom / sadness / shame / help 的**弱线索** —— 也就是
 *     那张文件头里明写"本批不搬"的老树表。线索只取**一个** kind（固定优先级，负面档在前），可回放。
 *   · **事件形状沿用 `emotionEvidence`**（不新开事件类型，白名单/证据存在性闸/幂等键全部照用）：
 *     `kind: FALLBACK_CUE_KIND`（专属 kind ⇒ 冷却 0），`fallbackKind` 记实际线索档，便于台账回溯。
 *
 * 视角说明（有意为之，边界）：兜底看的是**这段对话的氛围**（用户的话 + 机器人自己实际说过的话），
 * 所以用户的情绪也会小幅带动机器人自身的离散情绪（共情）；这与入站 cue 的"冲它来的才记"不同，
 * 量级只有它的约 40%，且有 3 轮闸与"本轮已变化就不加"两道约束。
 *
 * 纯函数：不读时钟、不碰盘、无网络；文本由调用方给（**只给本轮**：本轮的 `{text}` 行 ——
 * 用户消息 + 机器人已确认外发的文本；历史轮不许传，见 `pickFallbackCue` 的文本源契约）。
 */
import { selfEvalDeltas } from './mood-tags.js';

/** 轮次闸：同一会话至少每 3 轮尝试一次（用户裁定）。 */
export const FALLBACK_EVERY_ROUNDS = 3;
/** 增量缩放：0.4 × 老树原表（"小幅"；单批最多 ±3）。 */
export const FALLBACK_SCALE = 0.4;
/** 单键幅度上限（兜底不许像真 cue 那样一次推 15）。 */
export const FALLBACK_MAX_PER_KEY = 3;
/** 兜底事件的专属 kind（冷却 0：它自带轮次闸，不能再叠时间冷却）。 */
export const FALLBACK_CUE_KIND = 'fallbackCue';
/** 兜底覆盖的线索档（都在 `MOOD_KIND_DELTAS` 里，数值同源；roast/tease/praise/gratitude 已由 cue 通路负责）。 */
export const FALLBACK_KINDS = Object.freeze(['sadness', 'shame', 'boredom', 'help', 'curiosity', 'memeOk', 'chat']);

/**
 * 弱线索词表（每档一条；固定顺序 = 优先级，负面档在前）。刻意只收**特征词**，不收泛化词，
 * 降低误报；真正的"误报"上限由 3 轮闸 + 半量 + "本轮已变化就不加"三道约束兜住。
 */
const CUE_TABLES = Object.freeze([
  { kind: 'sadness', re: /(难过|伤心|委屈|想哭|泪目|破防|心寒|失落|低落|丧气|emo了)/iu },
  { kind: 'shame', re: /(尴尬|好尬|太尬|社死|丢人|出丑|丢脸)/iu },
  { kind: 'boredom', re: /(无聊|没意思|没劲|太闲|闲得|没事干|好闲)/iu },
  { kind: 'help', re: /(帮帮我|求助|救命|卡住|不会弄|教教我|帮个忙)/iu },
  { kind: 'curiosity', re: /(好奇|为什么|为啥|咋回事|怎么回事|是谁|哪来的|想知道)/iu },
  { kind: 'memeOk', re: /(玩梗|接梗|什么梗|段子|乐子|整活|表情包)/iu },
  // 「chat」= 轻松闲聊氛围（表里是 cheer+joy、boredom/loneliness 下降）——不是"在说闲话"的判定。
  { kind: 'chat', re: /(哈哈|笑死|hhh|233|乐了|好笑|太好了|好耶|绝了)/iu }
]);

/**
 * 从**本轮**的若干条文本里挑**一个**弱线索档（固定优先级，先命中者胜）。
 *
 * ★ 文本源契约（2026-10-16 复核收口）：调用方**只许**传本轮内容 —— 本轮新入账的用户文本 +
 *   本轮机器人**已确认外发**的文本；**不许**传历史轮消息（旧轮的"难过"会每三轮反复驱动新轮、
 *   还可能压过新轮的轻松；不读历史 ⇒ 旧线索不可能重播）。
 * ★ 返回值**不带任何原文**（只回 kind 与命中条数）：调用方把它直接进日志也不会泄漏聊天片段。
 * @param {Array<string|{text?:string}>} texts 本轮文本
 * @returns {{kind:string, hitCount:number}} `kind=''` = 没有可用的线索（不产生事件、不改情绪）
 */
export function pickFallbackCue(texts = []) {
  const list = (Array.isArray(texts) ? texts : [])
    .map((item) => String(typeof item === 'string' ? item : item?.text ?? '').trim())
    .filter(Boolean);
  if (!list.length) return { kind: '', hitCount: 0 };
  for (const table of CUE_TABLES) {
    let hitCount = 0;
    for (const text of list) if (table.re.test(text)) hitCount += 1;
    if (hitCount) return { kind: table.kind, hitCount };
  }
  return { kind: '', hitCount: 0 };
}

/**
 * 线索档 → 有界增量（只留 `affect.*`；缩放、逐键封顶、四舍五入）。
 * @param {string} kind
 * @returns {Record<string, number>} `emotionEvidence.deltas` 形状；空对象 = 没有可施加的增量
 */
export function fallbackDeltas(kind) {
  const raw = selfEvalDeltas([String(kind ?? '')]);
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith('affect.')) continue;
    const scaled = Math.round(Number(value) * FALLBACK_SCALE);
    if (!Number.isFinite(scaled) || scaled === 0) continue;
    const capped = Math.max(-FALLBACK_MAX_PER_KEY, Math.min(FALLBACK_MAX_PER_KEY, scaled));
    if (capped !== 0) out[key] = capped;
  }
  return out;
}

/**
 * 台账行算不算"**有效的**离散情绪变化"（兜底"不重复加"的判据）。
 *   · 只认事件行（`kind === 'event'`；衰减走别的 kind，不算）；
 *   · 拒绝行（`rejected`：同 kind 冷却 / 校验不通过）不算；
 *   · 只认 `affect.*` 且 `delta` 有限非零（自评/入站 cue/环境事件真落地的那几行；缺 delta 不算）。
 * @param {object} row 情绪台账行（`state.ledger` 的元素）
 */
export function isAffectLedgerRow(row) {
  if (!row || typeof row !== 'object') return false;
  if (String(row.kind ?? '') !== 'event') return false;
  if (row.rejected) return false;
  const field = String(row.field ?? '');
  if (!field.startsWith('affect.')) return false;
  // ★ 2026-10-16（复核收口）：`Number(undefined) !== 0` 是 **true**（NaN 与任何数都不等）——
  //   缺 delta 的行不能算"有效变化"（否则会把"没写数"当成"变了"）。必须有限且非零。
  const delta = Number(row.delta);
  return Number.isFinite(delta) && delta !== 0;
}

/**
 * 每会话轮次闸：`noteRound` 每轮调一次；连续满 `everyRounds` 轮 ⇒ `due: true` 并**归零**
 * （尝试即归零 ⇒ 不会每轮跑词表；下一次尝试在 ≥everyRounds 轮之后）。
 *
 * @param {{everyRounds?:number}} [opts]
 */
export function createFallbackTracker(opts = {}) {
  const everyRounds = Number.isInteger(Number(opts.everyRounds)) && Number(opts.everyRounds) >= 1
    ? Number(opts.everyRounds) : FALLBACK_EVERY_ROUNDS;
  const rounds = new Map();
  return {
    /**
     * @param {{chatKey?:string, affectChanged?:boolean}} p `affectChanged` = 本轮台账里已有有效 affect 变化
     * @returns {{due:boolean, rounds:number, affectChanged:boolean, everyRounds:number}}
     */
    noteRound({ chatKey = '', affectChanged = false } = {}) {
      const key = String(chatKey ?? '');
      const changed = affectChanged === true;
      if (!key) return { due: false, rounds: 0, affectChanged: changed, everyRounds };
      const n = (Number(rounds.get(key)) || 0) + 1;
      if (n < everyRounds) {
        rounds.set(key, n);
        return { due: false, rounds: n, affectChanged: changed, everyRounds };
      }
      rounds.set(key, 0);
      return { due: true, rounds: n, affectChanged: changed, everyRounds };
    },
    state(chatKey = '') {
      const key = String(chatKey ?? '');
      return { rounds: Number(rounds.get(key)) || 0, everyRounds };
    },
    reset() { rounds.clear(); return { ok: true }; }
  };
}
