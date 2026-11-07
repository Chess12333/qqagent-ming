/**
 * M7 emotion · relationDelta 的「自然语言理由 → FAVOR_REASONS 类别」归类器
 *
 * ★★ 2026-10-11 晚（用户裁定 · B10 撤门槛）：**本归类器已不是门槛。**
 *   用户原话："好感就是 LLM 自己决定的，他有权决定自己对谁好对谁坏；吵架、争执、意见不同
 *   本身就是会掉好感的" ⇒ `events.js` 已撤掉"favor 的 reason 必须 ∈ FAVOR_REASONS"与
 *   "永不计分黑名单"——**任何理由都能计分，正负听模型 delta**（对齐老树 `src/tools.js:2282`
 *   自由文本理由 + `setFavor` 直接写库）。本文件降级为**兜底 + 标签**：
 *     ① UI/日志/回执里"这一类的理由"的解释与分组；
 *     ② 模型不按新工具说明发、仍写老形状时的兜底打标；
 *     ③ 诊断依据（24 样本边界快照见 selftest 第 19 段）。
 *   ★ 别再往词表加词去"提高覆盖率"——用户已认定词表这条路不走（会给"随便说句好话"开门）。
 *
 * 历史（撤门槛前的定位，留档）：新树把好感收进 M7 后，契约曾要求 `relationDelta.reason
 * ∈ FAVOR_REASONS` ⇒ 自由文本一律被拒、好感永远不变（用户第 3 条"说扣了没扣"）⇒ 本归类器
 * 当时是"自由文本 ⇄ 七类契约"之间的桥，配 `orchestrator/index.js` 的 relationDeltaFromMemoryFavor。
 *
 * 归类规则（纯函数，不读时钟、不碰盘、零 import）：
 *   · 输入**先原样比对** 7 个类别英文词（已经是类别的一律放行）；
 *   · 再按关键词表逐条匹配，**先判永不计分语、再判负面、最后正面**（顺序即优先级）；
 *   · **匹配不到 ⇒ 返回 null**——撤门槛后 null 只是"没有可归的类"（打标/null），**不再代表拒写**。
 */

/** 7 个可计分类别（与 `events.js` 的 FAVOR_REASONS 同集；这里镜像一份避免循环 import）。 */
const CATEGORIES = Object.freeze([
  'companionship', 'help', 'shared-experience', 'apology-repair',
  'boundary-respected', 'reliability', 'hurt'
]);

/**
 * 永不计分语（README §八：好感不是服从度）—— 命中直接 null。
 * 与 `events.js` 的 NEVER_SCORE_REASONS 对应：那些是**类别级**永久拒绝，
 * 这里是**文本级**识别，两边都不放行。
 */
const NEVER_SCORE_WORDS = Object.freeze([
  '反对', '不认同', '拒绝', '驳回', '顶嘴', '纠正', '吵了一架', '争执', '意见不同'
]);

/** 负面计分：受伤/被凶/被冷落/失约。 */
const HURT_WORDS = Object.freeze([
  '怼', '骂', '凶', '伤人', '扎心', '过分', '欺负', '冷落', '鸽子', '失约', '爽约', '难听', '吼'
]);

/** 道歉修复。 */
const APOLOGY_WORDS = Object.freeze([
  '道歉', '对不起', '抱歉', '原谅', '和解', '赔罪', '是我不好'
]);

/** 可信帮助。 */
const HELP_WORDS = Object.freeze([
  '帮', '助', '忙', '支援', '指导', '救', '解决', '解答', '告诉我', '教', '协助', '救场'
]);

/** 可靠/守约。 */
const RELIABILITY_WORDS = Object.freeze([
  '靠谱', '守约', '守信', '按时', '准时', '说到做到', '兑现', '可靠', '及时', '没放我鸽子'
]);

/** 边界被尊重。 */
const BOUNDARY_WORDS = Object.freeze([
  '尊重', '边界', '分寸', '客气', '没越界', '不越界', '顾及', '体谅'
]);

/** 共同经历。 */
const SHARED_WORDS = Object.freeze([
  '一起', '共同', '组队', '联机', '双排', '玩了', '吃过', '吃了', '逛', '看了', '经历', '同路', '结对'
]);

/** 陪伴/常来往。 */
const COMPANIONSHIP_WORDS = Object.freeze([
  '陪', '常聊', '聊了', '聊天', '找我', '主动找', '问候', '打招呼', '在吗', '想到我', '陪我', '分享'
]);

/** 顺序即优先级：越靠前越先判（负面/拒绝语必须先于正面词）。 */
const RULES = Object.freeze([
  { reason: null, words: NEVER_SCORE_WORDS },
  { reason: 'hurt', words: HURT_WORDS },
  { reason: 'apology-repair', words: APOLOGY_WORDS },
  { reason: 'help', words: HELP_WORDS },
  { reason: 'reliability', words: RELIABILITY_WORDS },
  { reason: 'boundary-respected', words: BOUNDARY_WORDS },
  { reason: 'shared-experience', words: SHARED_WORDS },
  { reason: 'companionship', words: COMPANIONSHIP_WORDS }
]);

/**
 * 把自由文本理由归类成 FAVOR_REASONS 之一。
 *
 * @param {string} text 模型写的简短原因（≤30 字）或已经是类别词
 * @returns {string|null} 类别词；**识别不了返回 null**（调用方必须如实跳过，不许默认计分）
 */
export function classifyFavorReason(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  // 已经是类别词（大小写不敏感）⇒ 原样放行
  for (const category of CATEGORIES) {
    if (lower === category) return category;
  }
  for (const rule of RULES) {
    for (const word of rule.words) {
      if (t.includes(word)) return rule.reason;
    }
  }
  return null;
}

/**
 * 这段文本是不是「永不计分语」（README §八：好感不是服从度）。
 *
 * 与 `classifyFavorReason` 的分工：归类器对这类文本返回 null，但 null 也 cover「压根
 * 归类不了」—— 调用方（M15 的 relationDeltaFromMemoryFavor）要把**两种拒绝分开记账**：
 * 一种是"这句话分明属于不计分类"（模型看得懂、能改），另一种是"这句归不到任何一类"
 * （模型可能只是没写清楚）。日志/回执的 reasonCode 不同，排障时才知道该改谁。
 *
 * @param {string} text 模型写的简短原因
 * @returns {boolean} 命中永不计分词表 ⇒ true
 */
export function neverScoreHit(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  for (const word of NEVER_SCORE_WORDS) {
    if (t.includes(word)) return true;
  }
  return false;
}

/** 七类判据的一句话指南（单一真相源：提示词/工具描述/回执都该引它，别再各抄一份）。 */
export const FAVOR_REASON_GUIDE = Object.freeze(
  '陪伴相处 / 实际帮忙 / 共同经历 / 道歉修复 / 边界被尊重 / 可靠守信 / 受伤被凶'
  + '（顶嘴、反对、拒绝、被纠正不计分——好感不是服从度）'
);

/**
 * `classifyFavorReason` 的详细版：除了类别，还给**为什么**（命中词 / 拒绝原因）。
 *
 * ★ 为什么需要（2026-10-11 用户真机报"好感调了但没动"）：归类失败时调用方只能看到一个
 *   null，写进日志/回执全都是"未命中"三个字——用户与排障的人都不知道差在哪。详细版把
 *   "命中哪个词 / 为什么拒 / 属于哪类拒绝"一并给出，让执行器能回一句可行动的话
 *   （"理由归不到七类 ⇒ 本次不计分"），日志也能记 `why`。
 * ★ 与 `classifyFavorReason` / `neverScoreHit` **必须逐样本一致**（自测有对拍牙）——
 *   它只是同一判据的"带解释"投影，不是第二套判据。
 *
 * @param {string} text
 * @returns {{category: string|null, neverScore: boolean, matched: string|null, why: string}}
 */
export function classifyFavorReasonDetailed(text) {
  const t = String(text ?? '').trim();
  if (!t) return { category: null, neverScore: false, matched: null, why: '理由为空' };
  const lower = t.toLowerCase();
  for (const category of CATEGORIES) {
    if (lower === category) {
      return { category, neverScore: false, matched: category, why: `类别词直通（${category}）` };
    }
  }
  for (const rule of RULES) {
    for (const word of rule.words) {
      if (!t.includes(word)) continue;
      if (rule.reason === null) {
        return { category: null, neverScore: true, matched: word, why: `命中永不计分判据「${word}」——好感不是服从度` };
      }
      return { category: rule.reason, neverScore: false, matched: word, why: `命中 ${rule.reason} 类判据「${word}」` };
    }
  }
  return {
    category: null, neverScore: false, matched: null,
    why: '未命中七类任一判据 ⇒ 按设计不落账（没有依据不许推动好感）'
  };
}

export const FAVOR_REASON_CATEGORIES = CATEGORIES;
