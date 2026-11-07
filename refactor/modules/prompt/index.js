/**
 * M8b `modules/prompt/index.js` —— **唯一公开出口**
 *
 * 职责：把「事实 + 记忆视图 + 人设 + 配置」组装成**给主模型的消息数组**。
 * **不决定回不回**（那是 M8 `modules/plan/decide()`），**不调用模型**（那是 M4 `modules/llm`）。
 *
 * 依赖纪律（派单硬边界 6）：
 *   只 import `../../contracts/index.js` + `node:`；**不 import 任何兄弟模块**。
 *   人设卡 / 记忆视图 / 关系 / 配置 / 开关 **全部注入**。
 *
 * 纯函数（派单硬边界 4）：
 *   时间与随机**从入参给**（`now` / `rand`）；**不许 `Date.now()` / `Math.random()`**；
 *   **不许读盘**。
 */

import { validateMessageEvidence } from '../../contracts/index.js';
import { PERSONA_CARDS, DEFAULT_PERSONA_ID, getPersonaCard, listPersonaIds } from './persona-cards.js';
import { systemRules, stripUnavailableToolRules, unavailableToolNote, KNOWN_TOOL_NAMES, STYLE_HINT_SECTION } from './system-rules.js';
import { guideTierForMode, guideRules } from './guide.js';
import { renderEvidence, renderMemoryView, renderEpisodeSummary, renderRecentSends, renderRecentChat, renderRecentChatSplit, formatAt, sinceLabel } from './blocks.js';
import { sameHistoryMessage, ROW_FIELD, historyHeaderText } from './history-format.js';
import { counterpartIds, projectMemoryItems, fitCountByChars } from './memory-filter.js';
import { applyBudget, mergeBudget, DEFAULT_BUDGET, PRIORITY, presentationOrder, sectionLayoutOf, hasExplicitLayoutOrder } from './budget.js';
import { applyRequestBudget, measureRequest, recheckAfterToolResults, toolSchemaChars, prefixFingerprint } from './budget.js';
// ★ 2026-10-17（洛版 DS 布局接入）：历史窗口锚定的**唯一实现**在 ds1 的纯算法模块里（本层只接入，不改它）。
//   只有有效策略 id === 'deepseek' 时走这条分支；其它厂商保持原布局/预算/条数（见下方 DS 分支说明）。
import { deepseekAnchorChunkFor, deepseekHistoryFetchLimit, selectDeepseekAnchoredHistory, deepseekHistoryOptionsFor } from './deepseek-history.js';
import { resolveSystemMode } from './tiers.js';

/**
 * ★ 2026-10-16（缓存前缀收口）：历史取尾窗口的**段头对齐块**（条）。
 * 与编排层历史窗口头同一手法（`compose.js` 的锚定块上限 12）：段头只在跨块时前移一次，
 * 而不是每来一条新消息滑一格 —— 前缀缓存（DeepSeek 自动前缀检测）才能把追加式历史整段复用。
 * 只增不减：最多比 rowBudget 多 11 条，绝不缩减历史。预算真的不够时由下面的收缩路径
 * （`shrinkCurrentHistory`，不带对齐）压回去，不会打架。
 */
const HISTORY_HEAD_CHUNK = 12;

export { PERSONA_CARDS, DEFAULT_PERSONA_ID, getPersonaCard, listPersonaIds };
export { systemRules, stripUnavailableToolRules, unavailableToolNote, KNOWN_TOOL_NAMES };
export { STICKER_GUIDES, stickerGuide, guideTierForMode, guideRules } from './guide.js';
export { KNOWN_SYSTEM_MODES, resolveSystemMode, leanTier, softTier, softTwoTier, compactTier, identityAnchorText, packageReportBanText } from './tiers.js';
export { renderEvidence, renderMemoryView, renderRecentSends, renderRecentChat, renderRecentChatSplit, formatAt, sinceLabel, participationText };
// ── 历史行格式契约（`history-format.js`）的公开出口 ──
// ★ prompt 之外的消费方（如 `orchestrator/compose.js`）从这里取，不直接 import 模块内部文件；
//   契约里每个符号都是给消费方的，所以显式列名而不是 `export *` —— 以后加符号时这里先漏一行，
//   `selftest.mjs` 的"公共出口必须重导出契约"那条会红，比外部拿到 undefined 更早发现。
export { ID_FIELD, ROW_FIELD, MEDIA_KIND_NAMES, TIME_UNKNOWN_TEXT,
  historyIdentity, sameHistoryMessage, historyShortRef, historyBareRef, buildPlatformRefMap,
  historyAuthorLabel, historyQuoteLabel, historyMediaMarks,
  truncatedMarker, omittedMarker, historyHeaderText, historyColdHeader, historyWarmHeader, coarseAgeLabel } from './history-format.js';
export { counterpartIds, projectMemoryItems, fitCountByChars, visibleInChat } from './memory-filter.js';
export { wantsMemoryRecall, memoryRecallQuery, buildMemoryRecallReminder, buildMemoryPrefetchInject } from './memory-recall.js';
export { clampDigestParams, buildRecent24hDigest, buildRecentDigestInject } from './recent-digest.js';
export { applyBudget, mergeBudget, DEFAULT_BUDGET, PRIORITY };
// ── P2「完整请求预算」（2026-10-08）：组包期的整份请求计量 / 工具结果追加后复查 / 前缀指纹 ──
export { applyRequestBudget, measureRequest, recheckAfterToolResults, toolSchemaChars, prefixFingerprint };

/** 输入非法时抛（§3.1：非法即抛/返回错误，不许静默放过）。 */
export class PromptInputError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'PromptInputError';
    this.errors = errors;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
 * cfg 读取（M1 注入的**只读访问器**）
 * §3.6：`cfg = { get(keyPath, fallback), sourceOf(keyPath), effective(keyPath,{chatKey,kind}) }`
 * 本模块**只读**、**绝不 deepMerge**（README §3.2 不变量）。
 * ═══════════════════════════════════════════════════════════════════════ */

function readCfg(cfg, keyPath, fallback) {
  if (!cfg || typeof cfg.get !== 'function') return fallback;
  try {
    const v = cfg.get(keyPath, fallback);
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function cfgSource(cfg, keyPath) {
  if (!cfg || typeof cfg.sourceOf !== 'function') return 'unknown';
  try { return String(cfg.sourceOf(keyPath)); } catch { return 'unknown'; }
}

/* ═══════════════════════════════════════════════════════════════════════
 * 1) 人设卡选择
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * 选人设卡。**只取卡 + 开关，绝不在这里判定"该不该进这张卡"**。
 *
 * 优先级（确定性，无随机）：
 *   1. `flags.personaTwo === true` → 第二人格卡（开关来自外部，人格切换事务归 M15）
 *   2. `cfg.get('persona.cardIdPrivate')`（仅 `kind === 'private'`）
 *   3. `cfg.get('persona.cardId')`
 *   4. `DEFAULT_PERSONA_ID`
 *
 * @param {object} p
 * @param {object} p.cfg    M1 只读访问器（可选；缺省时全走默认）
 * @param {string} p.chatKey
 * @param {'group'|'private'} p.kind
 * @param {object} p.relation **不透明对象**：本函数**只记它存不存在，不读任何字段**（§3.6）
 * @param {{personaTwo?:boolean, hype?:boolean}} p.flags **外部注入**的开关
 * @returns {{id:string, name:string, card:object, reason:string, relationPresent:boolean, hype:boolean, personaTwo:boolean}}
 */
export function selectPersona(p = {}) {
  const { cfg, kind = 'group', relation = null, flags = {} } = p;
  const personaTwo = flags.personaTwo === true;
  const hype = flags.hype === true;
  const relationPresent = relation !== null && relation !== undefined;

  let id = null;
  let reason = '';
  if (personaTwo) {
    id = 'personaTwo';
    reason = 'flags.personaTwo=true（外部注入的开关；本模块不判定进入条件）';
  } else if (kind === 'private') {
    const priv = readCfg(cfg, 'persona.cardIdPrivate', null);
    if (priv && String(priv).trim()) { id = String(priv).trim(); reason = "cfg.get('persona.cardIdPrivate')（私聊专用卡）"; }
  }
  if (!id) {
    const g = readCfg(cfg, 'persona.cardId', null);
    if (g && String(g).trim()) { id = String(g).trim(); reason = reason || "cfg.get('persona.cardId')"; }
  }
  if (!id) {
    id = DEFAULT_PERSONA_ID;
    reason = reason || `配置未指定，回落到默认卡 ${DEFAULT_PERSONA_ID}`;
  }
  const known = Object.prototype.hasOwnProperty.call(PERSONA_CARDS, id);
  if (!known) reason += `；⚠ 配置里的卡 id "${id}" 不存在，已回落到 ${DEFAULT_PERSONA_ID}`;
  const card = getPersonaCard(id);
  return {
    id: card.id,
    name: card.name,
    card,
    reason,
    configSource: cfgSource(cfg, 'persona.cardId'),
    relationPresent,
    hype,
    personaTwo
  };
}

/* ═══════════════════════════════════════════════════════════════════════
 * 2) 组装消息数组
 * ═══════════════════════════════════════════════════════════════════════ */

/** 普通轮的【本次唤醒】表头（主动轮**不许**用它：没有新消息却说"以下是你还没看过的最新消息"= 给模型假前提）。 */
const TRIGGER_HEADER = '本轮新消息原文（已按证据冻结，#编号照抄即可）：';

/**
 * 主动轮的【本次唤醒】口径 —— 旧 `src/orchestrator.js:2957-2969` 三种措辞逐字搬。
 * 本层只负责**把语境说清楚**，不判定"该不该开口"（那是 M8/M6）。
 * @param {string} reason `schedule` / `random` / 其它（含 `idle`，即"主动机会"）
 * @param {string} kind   `private` 走私聊措辞，其余走群措辞
 */
function proactiveWakeupText(reason, kind) {
  if (reason === 'schedule') {
    return '（定时主动）到了约定的联系时间。结合最近的对话和此刻状态决定要不要开口；若开口，找个自然的话头即可。';
  }
  if (reason === 'random') {
    // 卡里写死了"不要让第一人格意识到你的存在、不留痕迹"⇒ 别解释自己为什么出现、别提顶班/换人。
    return '（随机）没人叫你，你就是突然上来了。想说什么就说什么，不想说就什么都不调。别解释自己为什么出现，别用"顶班/换人"这类说法。';
  }
  return kind === 'private'
    ? '（主动机会）私聊安静了一会儿。结合你们最近聊过的事和此刻的状态，判断要不要自然地开个话头；少用模板式的状态询问。'
    : '（主动机会）群里安静了一会儿。结合近期话题和此刻状态判断要不要开口；若有想说的，像群友一样自然起个话头。';
}

/* ═══════════════════════════════════════════════════════════════════════
 * 参与度参考（老树 `src/prompt.js:808-817` `participationText(level)` 逐字搬）
 *
 * 老树在两处 push 同一句（`:1555` 静态区 / `:1886` 动态区 `if (!hoistStatic)`）；
 * 新树只有一处（user 段），措辞一字未改。
 * ⚠ 三档之外的一切值都落 `default`（= 普通群友）—— 与老树 `String(level || 'medium')`
 *   的 switch-default 行为一致：**不许**把未知值静默映射成 low/high。
 * ═══════════════════════════════════════════════════════════════════════ */
function participationText(level) {
  switch (String(level || 'medium')) {
    case 'low':
      return '你的参与度风格：安静型。大部分时候潜水看戏，只在被 @/点名/直接提问、或确实有特别想说的时才开口；开口也简短。';
    case 'high':
      return '你的参与度风格：活跃型。热闹的群聊里可以比较活跃，能接的话题尽量接，偶尔主动开话题；但依然选择性接话，不要每条都回、不要刷屏。';
    default:
      return '你的参与度风格：普通群友。能接的话题就接，插不上就安静看；不抢话也不故意隐身。';
  }
}

/**
 * 【印象】段的**整段降级**（预算 shrink 用）：每次只去掉一个**完整**片段，绝不切半句。
 *
 * 文本形状（`modules/memory/prompt-format.js` `formatForPrompt` 的第 339-362 行）：
 *   `【印象】人甲…; 人乙…`（人条目之间用 `; ` 分隔）
 *   + 可选 `\n（态度）…`（按好感档/管理员备注的一句话）
 *   + 可选 `\nJev建议：…`（consume-once 建议，单独一行）
 *
 * 丢弃顺序（最可牺牲的在前）：建议行 → 态度行 → 末尾人条目（**至少留 1 个**）。
 * ⚠ 已知边界：人条目里的 claim 若自身含 `; `，文本层无法区分"条目分隔"与"正文分号" ⇒
 *   末段切分按最后一个 `; ` 执行（宁可少留半条，也不整段裁没）。返回 '' = 无可再缩。
 */
export function shrinkImpressionBody(text) {
  const raw = String(text ?? '');
  if (!raw) return '';
  // ① 末尾的建议行（锚定行尾，避免把人条目正文里同名字样当标题切）
  const noSug = raw.replace(/\nJev建议：[^\n]*$/, '');
  if (noSug !== raw && noSug.trim()) return noSug;
  // ② 末尾的态度行
  const noHint = raw.replace(/\n（态度）[^\n]*$/, '');
  if (noHint !== raw && noHint.trim()) return noHint;
  // ③ 末尾的人条目（按最后一个 `; ` 切，保留前缀）
  const cut = raw.lastIndexOf('; ');
  if (cut > 0) {
    const next = raw.slice(0, cut);
    if (next.trim()) return next;
  }
  return '';
}

/**
 * 组装给主模型的消息数组。
 *
 * @param {object} p
 * @param {MessageEvidence[]} p.evidence   §3.1，会被 `validateMessageEvidence` 校验
 * @param {object} [p.context]   M6 `retrieve()` 输出：`{ items:[{claim,scope,evidenceIds[],confidence,at}], dropped:[], topic?, need? }`
 * @param {object} [p.relation]  **不透明**：只记存在性，**不读字段**
 * @param {string} [p.relationText] 调用方**自己**从 relation 渲染好的摘要字符串（本层不认识它的字段名）
 * @param {string} [p.botStateLine] 调用方**自己**渲染好的老树本体状态行
 *   （`modules/emotion/prompt-line.js` 的 `botStatePromptLine(state)` 的返回值：`（此刻）精力…心情…。情绪：…。倾向（内部提示，别照着念）：…` 五段）。
 *   ★ 与 `styleHint` 是**两件不同的东西**：`styleHint` 是"按人给的关系化倾向"（进本轮 user 状态段），
 *     本段是老树口径的"我自己此刻的状态 + 情绪 + 意图 + 行为约束"（进 user，volatile）。
 * @param {string} [p.impressionText] 调用方**自己**渲染好的老树【印象】段
 *   （`modules/memory/prompt-format.js` 的 `formatForPrompt({people,…})` 的返回值，形如
 *   `【印象】京玉(QQ123)[好感75/100·亲近·因+5：…]: ★[喜好]… 近况：…` + `（态度）…` + `Jev建议：…`）。
 *   ★ 与 `renderMemoryView` 产出的 `【记忆视图】` **并存不删**：前者强调"可用"（按人/好感/态度），
 *     后者强调"可追溯"（观察 + 证据 ID）。老树两者都有。
 * @param {{enabled:boolean,warmCount:number,coldMessages:Array,warmMessages:Array}} [p.historyCold]
 *   调用方从同一份 `store.recent()` 结果切出的结构化分片；本层复用历史 renderer。
 * @param {string} [p.cacheStrategy] **有效缓存策略 id**（compose 解析 provider 配置后的结果）：
 *   `'deepseek'` 与 `'dashscope'` 启用**锚定历史布局** —— ① 历史窗口按本地 id 锚定
 *   （`deepseek-history.js`，窗口长度会随 `limit` 伸缩到 `[limit, limit+chunk−1]`）；
 *   ② `stablePrefixSections` 放在**历史之前**。诊断按真实 id 标注：DS 进 `diagnostics.deepseek`
 *   （保留既有消费者），其它锚定策略进 `diagnostics.anchoredLayout`（同形状，不冒名 DS）。
 *   其它值/缺省 ⇒ 原布局、原预算、原条数（手选厂商只影响这两条，不改记忆/心声/人格任何语义）。
 * @param {Array<{name:string,text:string,required?:boolean}>} [p.stablePrefixSections]
 *   **经稳定渲染**的素材段（表情库等；调用方负责"同会话内字节稳定"）。仅锚定策略下生效：
 *   放在历史之前（负数顺序，见 `budget.js` `presentationOrder` 的 `layoutOrder` 覆盖）。
 *   与 `SECTION_LAYOUT` 同名的段、空文本、重复名会被**拒绝**并记进 `diagnostics.stablePrefix.rejected`
 *   （只注入一次；不覆盖官方段的生产者）。
 * @param {number|null} [p.historyBaseLimit]
 *   **原本可见基准**（锚定窗口的下界）＝ compose 按"原路径本轮会读进候选的上限"一次性确定的值，
 *   **不随预取多取的行数反推**（防 limit→fetch→更大 limit 自我膨胀）；不传才按现路径推导。
 * @param {object} [p.persona]   `selectPersona()` 的返回；不给就在内部选一次
 * @param {object} [p.cfg]       M1 只读访问器
 * @param {boolean} [p.hype]     **外部注入**的亢奋开关（本模块不判定）
 * @param {boolean} [p.personaTwo] **外部注入**的第二人格开关
 * @param {{names:string[]}} [p.tools] 实际注册的工具名：① 擦**注入文本**里写死的缺失工具名；
 *   ② 决定 user 侧要不要写"本轮没有这些工具"那一行（system 协议句常驻，不随它增删）
 * @param {Array} [p.toolPlan]   ActionPlan.toolPlan（只作为**只读清单**出现在 user 段）
 * @param {string} [p.roleText]  管理员自定义人设正文
 * @param {string[]} [p.extensionSections]
 * @param {string} [p.styleHint] M7 渲染出的此刻说话倾向；空值不改变旧提示词
 * @param {number} [p.now]       **必填**：时间戳（不许自取）
 * @param {object} [p.budget]    覆盖 DEFAULT_BUDGET
 * @param {boolean} [p.tolerateInvalid] true 时非法证据只记进 diagnostics 不抛
 * @param {boolean} [p.proactive]        **主动轮**（M15 的 `wake({proactive:true})`）：本轮没有新消息
 * @param {string} [p.proactiveReason]   `schedule` / `random` / 其它（`idle`＝主动机会）；本层**只照它选措辞**，不判定开口
 * @param {object} [p.emotionState]      **M7 情绪状态**（`modules.emotion` 的 `stateOf()`/`project(now)` 产物）。
 *   ★ 这是**真源凭证**，不是第二数据源：本层**不读它的字段、不渲染任何情绪/好感文本**
 *     （那些全由调用方渲染成 `botStateLine` / `styleHint` / `relationText` / `impressionText` 传进来）。
 *     本层只做三件事：① 记它在不在（diagnostics.emotionState）；② 校验"渲染好的字符串"与
 *     "M7 状态在不在"**不互相矛盾**（例如 M7 缺失却给了 botStateLine ⇒ 那是别人造的第二源，
 *     如实告警）；③ 人数规模如实记账，供排障时判断"这轮到底拿没拿到 M7"。
 * @returns {{messages: Array<{role:'system'|'user'|'assistant', content:string}>, diagnostics: object}}
 */
export function buildMessages(p = {}) {
  const {
    evidence = [], context = null, relation = null, relationText = '',
    botStateLine = '', impressionText = '', historyCold = null,
    memeCue = '',                      // ★ N58 闪梗注入文字（media 产，逐字照老树）
    pendingTodosText = '',             // ★ N59 待办文本（M15/orchestrator 渲染好传进来）
    turnCandidateText = '',            // ★ 钱包主线第 1 件：本轮可看/可引用编号那一行（act.turnCandidateNote 产）
    memoryRecallText = '',             // ★ 问旧事·硬要求（compose 产，memory-recall.js 拼文案）
    memoryPrefetchText = '',           // ★ 预检索线索（compose 产，memory-recall.js 拼文案）
    recentDigestText = '',             // ★ 近24h本地摘要（compose 产，recent-digest.js 拼文案）
    crossTurnText = '',                // ★ 跨轮工作记忆（compose 产，working-window.js renderCrossTurn）
    semanticCardsText = '',            // ★ 语义卡（compose 产，semantic-cards.js renderSemanticCardsInject）
    cfg = null, tools = null, toolPlan = null, roleText = '', extensionSections = [], styleHint = '',
    now = null, budget: budgetIn = null, tolerateInvalid = false, selfId = '',
    pastChatHistory = null, crossRoundMemory = [],
    // ★ 2026-10-17（洛版 DS 布局接入）：这两个是**跨端固定接线**（ds3/compose 传入）。
    cacheStrategy = '', stablePrefixSections = null, historyBaseLimit = null,
    hype: hypeIn, personaTwo: personaTwoIn,
    emotionState: emotionStateIn = null
  } = p;
  const proactive = p.proactive === true;
  const proactiveReason = String(p.proactiveReason ?? '');
  // 有效策略 id：**启用"锚定历史布局"的策略**共用同一套（锚定 helper + 稳定素材前置位）——
  //   deepseek 与 dashscope（显式/隐式模式都能吃到锚定带来的前缀收益）；其它厂商/缺省一律原路
  //   （不改布局/预算/条数）。诊断按**真实策略 id** 标注，不把百炼说成 DS。
  const cacheStrategyId = String(cacheStrategy ?? '').trim().toLowerCase();
  const ANCHORED_LAYOUT_IDS = new Set(['deepseek', 'dashscope']);
  const anchoredLayoutMode = ANCHORED_LAYOUT_IDS.has(cacheStrategyId);
  // 仅用于保留 DS 原有的诊断键/文案（消费者不因本轮改动断供）。
  const deepseekMode = cacheStrategyId === 'deepseek';

  // ── N61：`store.sanitizeSelfStyle` 自己历史清洗门（老树 `src/prompt.js:1386` `!== false` 口径，默认开）。
  //   新树此前 0 处读点 ⇒ 门从来没生效过。读原始值即可（`readCfg` 走 `cfg.get`，
  //   本层**不自己实现** effective/scope 语义；act 侧 N61 已按注入执行落过一模一样的一刀）。
  const sanitizeSelfStyle = readCfg(cfg, 'store.sanitizeSelfStyle', undefined) !== false;

  // ── emotionState（M7 真源凭证）。
  //   ★ 不读字段、不渲染 —— 只记存在性与规模，并校验"调用方给的渲染文本"和"M7 在不在"不互相矛盾。
  const emotionState = (emotionStateIn && typeof emotionStateIn === 'object' && !Array.isArray(emotionStateIn))
    ? emotionStateIn : null;
  const emotionPersons = emotionState && emotionState.persons && typeof emotionState.persons === 'object'
    ? Object.keys(emotionState.persons).length : 0;

  // ★ N58 接梗提示（老树 src/orchestrator.js:2849-2850：promptParts.all/volatile += inject）。
  //   只放字符串、一个字都不重写；文案由 media.memeCueInject(pick) 产。预算紧时先丢（见下方 priority）。
  //   注：diagnostics 此刻还没初始化 ⇒ memeCue 的记账放在下面 section 旁边（与 botStateLine 同款）。
  const memeCueText = String(memeCue ?? '').trim();

  const diagnostics = { warnings: [], invalidEvidence: [], trimmed: [], relationPresent: relation !== null && relation !== undefined };

  // now 必须**显式**给一个有限数字；null/undefined 会被 Number() 静默变成 0，先挡掉
  if (now === null || now === undefined || now === '' || !Number.isFinite(Number(now))) {
    throw new PromptInputError('buildMessages 需要显式的 now（有限数字时间戳）；本模块是纯函数，不许自取当前时间', ['now']);
  }
  const nowMs = Number(now);

  // flags：外部注入优先；没给才从 flags 里读
  const hype = hypeIn === true;
  const personaTwo = personaTwoIn === true;
  // ★ 双人格记忆隔离（用户 2026-10-13 拍板：一律隔离）。判据**不在本层**——全树只有
  //   `modules/emotion/persona-hygiene.js` 那一份，compose 侧 import 同一个符号；
  //   本层只把「谁在位 + 两个开关」交给喂模型的那几个 renderer（UI 展示一律不滤）。
  //   开关读 `persona2.memoryHygiene`（defaults 已有三键）；读不到就按默认走（= 隐）。
  const hygieneRaw = readCfg(cfg, 'persona2.memoryHygiene', null);
  const personaHygiene = hygieneRaw && typeof hygieneRaw === 'object' && !Array.isArray(hygieneRaw) ? hygieneRaw : {};
  const persona = p.persona || selectPersona({ cfg, chatKey: p.chatKey, kind: p.kind, relation, flags: { hype, personaTwo } });

  // ── 校验证据（§3.1：非法即抛，不许静默放过）
  const list = Array.isArray(evidence) ? evidence : [];
  if (!Array.isArray(evidence) && evidence !== null && evidence !== undefined) {
    throw new PromptInputError('evidence 必须是数组', [`evidence: 得到 ${typeof evidence}`]);
  }
  const valid = [];
  for (const e of list) {
    const v = validateMessageEvidence(e);
    if (v.ok) valid.push(e);
    else diagnostics.invalidEvidence.push({ id: e?.id ?? null, errors: v.errors });
  }
  if (diagnostics.invalidEvidence.length && !tolerateInvalid) {
    throw new PromptInputError(
      `evidence 有 ${diagnostics.invalidEvidence.length} 条不符合 §3.1 MessageEvidence：`
      + diagnostics.invalidEvidence.map((x) => `#${x.id} ${x.errors.join('; ')}`).join(' | '),
      diagnostics.invalidEvidence.flatMap((x) => x.errors)
    );
  }
  if (diagnostics.invalidEvidence.length) {
    diagnostics.warnings.push(`${diagnostics.invalidEvidence.length} 条非法证据已被跳过（tolerateInvalid=true）`);
  }

  // ①（2026-10-14 派单·状态话题时效）：`api.architecture.workingMaxChars` —— 单条状态/印象注入的长度上限。
  //   ★ 这条落在**渲染层**而不是记忆层：M6 交回的是账本条目，截断只该发生在给模型排版的那一步
  //   （同一件事新树已有出口 `budget.maxMemoryClaimChars`，默认 160 与该键默认同数）。
  //   优先级：调用方显式传的 `budgetIn.maxMemoryClaimChars` > 配置里的 `workingMaxChars` > `DEFAULT_BUDGET`。
  //   取值钳到 20~600：界面填 0 或填错会一个字都不剩，那不是"用户要的效果"。
  const workingMaxCharsRaw = Number(readCfg(cfg, 'api.architecture.workingMaxChars', null));
  const budget = mergeBudget(
    Number.isFinite(workingMaxCharsRaw) && workingMaxCharsRaw > 0
      && budgetIn?.maxMemoryClaimChars === undefined
      ? { ...budgetIn, maxMemoryClaimChars: Math.min(600, Math.max(20, Math.floor(workingMaxCharsRaw))) }
      : budgetIn
  );
  const selfName = String(readCfg(cfg, 'persona.botName', '') || '');
  // 管理员备注名：历史行的发言人标签要用（`名字(QQ号)` 里没有备注时退回昵称）。
  const memberNotesRaw = readCfg(cfg, 'memberNotes', {});
  const memberNotes = memberNotesRaw && typeof memberNotesRaw === 'object' && !Array.isArray(memberNotesRaw) ? memberNotesRaw : {};
  const chatKey = String(p.chatKey ?? '');
  const kind = p.kind || (valid[0]?.kind ?? 'group');
  const preparedRecent = context?.recent && typeof context.recent === 'object' ? context.recent : null;
  const preparedMessages = Array.isArray(preparedRecent?.messages) ? preparedRecent.messages : [];
  const composeHistoryMessages = Array.isArray(pastChatHistory?.messages) ? pastChatHistory.messages : [];
  // `let`：DS 分支会把历史窗口替换成锚定后的窗口（见下方 DS 布局块），其余分支逐字不变。
  let historyForPrompt = preparedRecent?.status === 'available'
    || (preparedRecent?.status === 'empty' && composeHistoryMessages.length === 0)
    ? { ...preparedRecent, messages: preparedMessages }
    : pastChatHistory;
  const coldMessages = Array.isArray(historyCold?.coldMessages) ? historyCold.coldMessages : [];
  const warmMessages = Array.isArray(historyCold?.warmMessages) ? historyCold.warmMessages : [];
  const pastHistoryMessages = Array.isArray(pastChatHistory?.messages) ? pastChatHistory.messages : [];
  const historyColdEnabled = historyCold?.enabled !== false;
  const hasHistoryColdRows = coldMessages.length + warmMessages.length > 0;
  let useHistoryCold = Boolean(pastChatHistory && pastChatHistory.status !== 'unavailable'
    && historyColdEnabled && hasHistoryColdRows);
  // ★ 分片自检（方案四行之④后半）：**诊断一旦触发就退回单时间线**，不是只记一条 warning。
  //   原来这两条只推警告、`useHistoryCold` 不受影响 ⇒ 冷热两段照样渲染，而分片与单窗既然对不上，
  //   送进提示词的段名（"较早/最近"）与行的先后就可能是错的 —— 模型照着错的段落关系理解群聊。
  //   退回后走下面 `else` 那一支（与"没传 historyCold"逐字同一条时间线），内容一条不少，只是不再分两段贴标签。
  if (historyCold && typeof historyCold === 'object' && pastChatHistory?.status !== 'unavailable'
    && historyColdEnabled && hasHistoryColdRows) {
    const rowKey = (row) => {
      const id = row?.localId ?? row?.id;
      return id !== null && id !== undefined
        ? `id:${String(id)}`
        : JSON.stringify([row?.ts ?? row?.at ?? null, row?.self === true, row?.senderName ?? '', row?.text ?? '']);
    };
    const partition = [...coldMessages, ...warmMessages];
    const expectedKeys = pastHistoryMessages.map(rowKey);
    const actualKeys = partition.map(rowKey);
    const misaligned = expectedKeys.length !== actualKeys.length
      || expectedKeys.some((key, index) => key !== actualKeys[index]);
    if (misaligned) {
      diagnostics.warnings.push('historyCold 分片与 pastChatHistory.messages 覆盖或顺序不一致 ⇒ 本段退回单时间线（不渲染可能错位的冷热两段）');
    }
    const coldKeys = coldMessages.map(rowKey);
    const warmKeySet = new Set(warmMessages.map(rowKey));
    const overlapped = coldKeys.some((key) => warmKeySet.has(key));
    if (overlapped) {
      diagnostics.warnings.push('historyCold.coldMessages 与 warmMessages 有重叠行 ⇒ 本段退回单时间线（同一条不许出现在两段）');
    }
    if (misaligned || overlapped) useHistoryCold = false;
  }

  // ── system：只拼稳定规则（动态事实一律不进）
  // T-1 档位：显式 p.systemMode 优先，否则读 cfg persona.systemMode（缺省 'full'，与老树同默认值）。
  // 老树配了 lean/soft 新树静默忽略的坑在此终结：resolveSystemMode 未知档必告警（进 diagnostics）。
  const systemModeRaw = p.systemMode !== undefined && p.systemMode !== null && String(p.systemMode).trim() !== ''
    ? p.systemMode : readCfg(cfg, 'persona.systemMode', 'full');
  // compact 三态（2026-10-13 方向 A）：显式 true 照办、显式 false 压掉配置、未设置才读配置。
  // 未设置那一支还要给在位的第二人格让路：tiers.js:102 的 compact 判定排在 :103 的 personaTwo 之前，
  // 而进入第二人格**不再改配置**（方向 A）⇒ 让路的配了压缩才到得了 soft2。
  // 显式 false 这一支是 `emotion/persona-two.js:131 effectivePersona()` 的契约：组装层照那个出口喂。
  const compact = typeof p.compact === 'boolean'
    ? p.compact
    : readCfg(cfg, 'persona.compactSystemPrompt', false) === true && personaTwo !== true;
  const toolNames = Array.isArray(tools?.names) ? tools.names : null;
  const adminQQFromCfg = (() => {
    const a = readCfg(cfg, 'persona2.adminQQ', '');
    if (/^\d{5,15}$/.test(String(a ?? '').trim())) return String(a).trim();
    const h = readCfg(cfg, 'hypeMode.protectedQQ', '');
    if (/^\d{5,15}$/.test(String(h ?? '').trim())) return String(h).trim();
    const text = String(roleText ?? '');
    const m = text.match(/(?:QQ\s*号|qq\s*号)\s*[:：]?\s*(\d{5,15})/i) || text.match(/管理员[^\d]{0,24}(\d{5,15})/);
    return m ? m[1] : '';
  })();
  // 旧 identity / relation 等分散状态段不再进入最终 user 段；botStateLine 在下方单独保留为本轮状态。
  // systemRules 仍保留独立调用时的 styleHint 参数，这条生产组包路径固定传空。
  const currentStyleHint = String(styleHint ?? '').trim();
  const resolvedSystemMode = resolveSystemMode({ systemMode: systemModeRaw, compact, hype, personaTwo }).mode;
  const guideTier = guideTierForMode(resolvedSystemMode);
  const memoryEnabled = readCfg(cfg, 'api.conversationMemory.enabled', true) !== false;
  const rawEncourage = readCfg(cfg, 'sticker.encourage', 0);
  const stickerLevel = (rawEncourage === null || rawEncourage === undefined || rawEncourage === '')
    ? 0 : Math.min(3, Math.max(0, Math.floor(Number(rawEncourage) || 0)));
  const tidyBrackets = readCfg(cfg, 'send.tidyBrackets', false) === true;
  // ★ selfAccount 在共同外层定义一次（IIFE 与 counterpartIds 两处共用）。
  //   2026-10-16 修 ReferenceError：原定义在 systemPromptTail 的 IIFE 局部作用域（:404），
  //   :835 的 counterpartIds 引用它时 context 有值就抛，导致本轮发言无法完成。
  // ★ 2026-10-16（缓存实施第二步 · A）：身份值统一取**编排给的权威 selfId**（compose 的 `checkpointAccountId`，
  //   与上下文检查点同源、与触发批次无关）。原来只从 evidence 取 ⇒ **主动轮 evidence=[]** 时那行翻成"未知（不猜账号）"，
  //   而它在**被标记的 system 块**里 ⇒ 普通/主动交替每次都整块重写。这里只是取值来源的兜底顺序：
  //   权威值 → 证据行 selfId → 空（渲染成"未知"，不猜、不跨账号）。
  const selfAccount = String(selfId ?? '').trim() || String(valid[0]?.selfId ?? '').trim();
  const systemPromptTail = [
    guideRules({ tier: guideTier, memoryEnabled, tidyBrackets, botName: selfName, stickerLevel }),
    historyHeaderText(),
    // ★ 2026-15-15：身份·稳定半（f99dc5e4 裁定「identity 移至 system 底部」）。
    //   原要求「引导/身份/过去状态放 system 底部」；引导已在 guideRules、过去状态在 historyHeaderText。
    //   稳定身份（chatKey/selfId/常驻句）随 system 尾部进缓存前缀——同会话内不变，不破缓存。
    //   易变状态（本轮时间/styleHint）仍留 user 段（见下方 identity section），避免每轮改 systemHash。
    (() => {
      const parts = [`【会话】${chatKey || '(未给 chatKey)'}；${kind === 'private' ? '私聊' : '群聊'}`];
      parts.push(`你自己的 QQ 号：${/^\d{5,15}$/.test(selfAccount) ? selfAccount : '未知（不猜账号）'}；不是群友账号，atUserId 不能填这个账号。`);
      // ★ 2026-10-18（#10 资格误导收口）：原句无条件"可以不接"，被点名时也照样成立、与
      //   【说不说话】的"必回"打架；现在把许可限定在没人点名的场景（内容其余不变，仍只进 system）。
      parts.push('- 你就是群里的一个普通群友，不是在服务谁；没人点名时，可以不接、可以晚回、可以只回一个字。');
      if (kind === 'private') {
        parts.push('- 你的累、困、饿和对方一样真，说出来比关心他更像人；但那得是真发生的，说过一轮就翻篇，别当常驻状态每轮播。');
      }
      return parts.join('\n');
    })()
  ].filter(Boolean).join('\n\n');
  const sys = systemRules({
    persona,
    tools,
    hype,
    personaTwo,
    roleText,
    extensionSections,
    styleHint: '',
    selfName,
    diagnostics,
    systemMode: systemModeRaw,
    compact,
    tierCtx: {
      vision: readCfg(cfg, 'api.vision', true) !== false,
      search: readCfg(cfg, 'webSearch.enabled', true) !== false,
      conversationMemory: readCfg(cfg, 'api.conversationMemory.enabled', true) !== false,
      stickerEnabled: readCfg(cfg, 'sticker.enabled', true) !== false,
      stickerCollectEnabled: readCfg(cfg, 'sticker.collectEnabled', true) !== false,
      adminQQ: adminQQFromCfg
    },
    customRules: readCfg(cfg, 'persona.customRules', ''),
    promptTail: systemPromptTail
  });

  // ── user 段承载本轮动态上下文、状态、记忆、心声与情节；逐轮记忆属于模型视图，不放进 system 规则前缀。
  //   旧 identity / relation / 工具等 sections 仍用于既有 diagnostics；各块是否注入由下面的明确清单决定。
  const sections = [];
  // ★ 2026-10-13 复核缺口④：把管理员备注一并交给证据渲染，证据里的发信人/原作者标签
  //   与历史段用同一份备注（否则同一个人两处显示成两个名字）。
  // ★ 2026-10-19（第六批 · 引用链）：把本轮可见消息的 id 集合交给引用渲染 —— 被引目标就在
  //   本轮里时给出可照抄的 #编号（执行侧 findByRef 认它）；不在本轮/窗口时不给编号，但原文照给。
  const evidenceIdSet = new Set(valid.map((e) => String(e?.id ?? '')).filter(Boolean));
  const rendered = valid.map((e) => renderEvidence(e, {
    now: nowMs, maxMediaDescChars: budget.maxMediaDescChars, selfName, notes: memberNotes,
    batchRefs: evidenceIdSet
  }));
  const wakeParts = [];
  if (proactive) wakeParts.push(proactiveWakeupText(proactiveReason, kind));
  if (rendered.length) wakeParts.push(TRIGGER_HEADER, ...rendered.map((r) => r.text));
  const currentWakeText = wakeParts.join('\n');
  const turnCandidateBody = String(turnCandidateText ?? '').trim();
  const candidateContextText = turnCandidateBody.replace(/^【本轮可看的图】/u, '本轮可看的图');
  const contextWorking = context?.working && typeof context.working === 'object' ? context.working : {};
  const contextTopic = String(contextWorking.topic ?? context?.topic ?? '').trim();
  const contextNeed = String(typeof contextWorking.need === 'string'
    ? contextWorking.need : contextWorking.need?.text ?? context?.need?.text ?? context?.need ?? '').trim();
  let currentHistoryText = '';
  let shrinkCurrentHistory = null;
  /**
   * ★ 2026-10-16（缓存前缀 · 布局最小改动）：历史正文**紧跟标题**，实时三行（话题/需要/本轮时间）移到历史之后。
   *
   *   依据：那三行每轮（或话题一变）就变，原来压在历史正文**之前** ⇒ 可复用前缀在历史之前就断
   *   （同源教训：`history-format.js:244-249` 已把"展示 N/M 条"这类每轮变的数从历史**之前**拿掉；
   *   `prompt/index.js:653-657` 的冷段切点注释也是同一个道理）。历史正文本来没有标题
   *   （两个渲染器都 `includeContextHeadings:false`）⇒ 这里补一条**短**稳定标签，避免历史行被读成
   *   "本轮消息"；system 尾部已有 `historyHeaderText()` 的长说明，这里**不复制**。
   *   顺序：`【本轮上下文】` →（有历史时）`【过去状态】`+历史 → 话题 → 需要 → 本轮时间 → 本次唤醒 → 图片/引用候选。
   *   只动布局：历史来源/条数/单行字数上限/冷锚/预算/记忆触发/人格隔离全部不变；不冻时间、不删内容。
   *   （冷/热 与 未切分/无历史/主动轮 都走这一个 builder；`shrink()` 也复用同一函数 ⇒ 排序恒一致。）
   */
  const buildCurrentContextText = () => deepseekMode
    ? ['【历史上下文】', currentHistoryText].filter(Boolean).join('\n')
    : [
    // ★ 历史正文本来没有自带标题（两个渲染器都 `includeContextHeadings:false`，连"以本轮时间判断新旧"
    //   那类时效句也只进 `statusText`/diagnostics、不进模型）⇒ 有历史时在**标题同一行**补一条短标签，
    //   避免历史行被读成"本轮新话"；不新增行首块标题（诊断的 blockHeadings 口径不变），也不复制
    //   system 尾部 `historyHeaderText()` 的长说明。
    String(currentHistoryText ?? '').trim()
      ? '【本轮上下文】（下方【过去状态】是旧消息，本轮新话在末尾）'
      : '【本轮上下文】',
    currentHistoryText,
    contextTopic ? `当前话题：${contextTopic}` : '',
    contextNeed ? `当前需要：${contextNeed}` : '',
    `本轮时间：${formatAt(nowMs, nowMs)}`,
    currentWakeText,
    candidateContextText
  ].filter(Boolean).join('\n');
  const currentContextSection = {
    name: deepseekMode ? 'history-context' : 'current-context', priority: PRIORITY.TRIGGER, droppable: false,
    shrinkAfterDrop: deepseekMode,
    text: buildCurrentContextText(),
    shrink: () => {
      if (typeof shrinkCurrentHistory !== 'function') return null;
      const before = currentHistoryText.length;
      const next = shrinkCurrentHistory();
      if (typeof next !== 'string' || next.length >= before) return null;
      currentHistoryText = next;
      return buildCurrentContextText();
    }
  };
  sections.push(currentContextSection);
  if (deepseekMode) {
    sections.push({
      name: 'current-turn', priority: PRIORITY.TRIGGER, droppable: false,
      text: ['【本轮上下文】', contextTopic ? `当前话题：${contextTopic}` : '',
        contextNeed ? `当前需要：${contextNeed}` : '', `本轮时间：${formatAt(nowMs, nowMs)}`,
        ...(currentStyleHint ? [STYLE_HINT_SECTION(currentStyleHint)] : []),
        currentWakeText, candidateContextText].filter(Boolean).join('\n')
    });
  }

  // ── 钱包主线第 3 件（2026-10-14 指挥位裁定）：本轮没有的工具，在 **user 侧**说明。
  //   原先是"清单里没有 ⇒ 从 system 删掉提到它的那句"—— 清单抖一下，被标记的 system 整块重写
  //   （真实账本：17 轮里 16 个不同 systemHash）。现在协议句常驻，缺谁在这儿如实说一句；
  //   判据是 `tools.names`（第 2 件之后它只随配置/授权变），一次会话内不变 ⇒ 这一行也不变。
  const missingToolNote = unavailableToolNote(toolNames);
  if (missingToolNote) {
    sections.push({ name: 'missing-tools', priority: PRIORITY.TRIGGER, droppable: false, text: missingToolNote });
  }
  diagnostics.unavailableTools = { present: Boolean(missingToolNote), chars: missingToolNote.length };

  // ── 钱包主线第 1 件（2026-10-14 指挥位裁定）：本轮可见图/可引用编号放在 **user 段末尾**，与老树同位
  //   （`src/prompt.js:1956-1964` 表情清单、`:2042` 条件硬要求）。这段文字原先在 `get_message_images`
  //   的参数候选值与描述里 ⇒ 本轮只要有图，被标记的 `system + tools` 前缀就整块作废重写。
  //   ★ 本层**只放字符串**：清单由 `modules/act` 的 `turnCandidateNote` 从装配层那份快照产（一处判据、
  //     与执行侧比对用的是同一份），这里一个字都不重写；没喂或本轮没有 ⇒ 一个字节都不加。
  if (turnCandidateBody) {
    sections.push({ name: 'turn-candidates', priority: PRIORITY.TRIGGER, droppable: false, text: turnCandidateBody });
  }
  diagnostics.turnCandidates = { present: Boolean(turnCandidateBody), chars: turnCandidateBody.length };

  // ── G-1【引导说明】：老树 user 侧开局操作手册（system 档位由 tiers.js 定，手册只分 full/compact/hype 三档）。
  //   开关全从 cfg 读（compose.js 不用加线）：memoryEnabled←api.conversationMemory.enabled；
  //   stickerLevel←sticker.encourage（0~3，★G-1b 订正：**这里就是钳制点** ——
  //   非法值被 `Math.floor`+`Math.min/max` **静默钳成 0~3 整数**、不报错、不留痕迹；
  //   因此下游 `guide.js` 的 `stickerGuide` 那个 `throw` **在本生产路径上不可达**，
  //   只有 `selftest.mjs` 里 `M.stickerGuide(bad)` 那种直接调用才触发它。详见 guide.js stickerGuide 的 JSDoc。
  //   ⚠ 本行是**只读不改**的事实陈述：钳法不动、那个 throw 也不删）；
  //   tidyBrackets←send.tidyBrackets。
  //   compact 协议已在 system 时用户侧只留极简引导（老 :1948 注释照抄）。
  diagnostics.guide = { tier: guideTier, stickerLevel, memoryEnabled, tidyBrackets };

  // ── 会话身份·易变半（volatile）──
  //   ★ 稳定半（chatKey/selfId/常驻句）已移至 system 底部（systemPromptTail，见上）。
  //   本段只留每轮都变的内容：本轮时间 + styleHint。
  //   ★ 不再重复 system 里的稳定身份行，避免同一事实两处出现。
  const identityVolatile = deepseekMode ? '' : [
    `【本轮时间】${formatAt(nowMs, nowMs)}`,
    ...(currentStyleHint ? [STYLE_HINT_SECTION(currentStyleHint)] : [])
  ].filter(Boolean).join('\n');
  if (identityVolatile) {
    sections.push({
      name: 'identity',
      priority: PRIORITY.TRIGGER,
      droppable: false,
      text: identityVolatile
    });
  }

  // ── 关系摘要（调用方渲染好的字符串；本层不认识 relation 的字段）
  //   ★ 2026-10-14 用户截图指出的漏字：段头原来写「由 M7 提供（已渲染）：」—— M7 是我们的内部编号，
  //     模型不该看到它，它也不是这行的信息。段头只留「【关系状态】」。
  //   ★ 同处的 else 分支原先把"M7 给了对象但调用方没传文本 ⇒ §3.6 不透明对象"整句发给模型：
  //     那是一句**故障说明**，对说话没有任何用处；不渲染就什么也不发，账由 diagnostics.relationPresent 记。
  if (relationText && String(relationText).trim()) {
    sections.push({ name: 'relation', priority: PRIORITY.RELATION, droppable: true, text: ['【关系状态】', String(relationText).trim()].join('\n') });
  } else if (diagnostics.relationPresent) {
    diagnostics.warnings.push('relation 对象已传入但没有渲染好的 relationText ⇒ 本层不解释它（§3.6：不透明对象），该段本轮不下发');
  }

  // ── N32：老树口径的「本体状态」五段（`modules/emotion/prompt-line.js` 的 botStatePromptLine）。
  //   老树位置：`src/orchestrator.js:2703-2710` —— 挂在 **user 段最末**（在【本次回复方式】之后），
  //   原注释「全局本体状态：精力/心情/社交电池（跨群一份）」。
  //   新树位置：排在【跨轮心声】之后、【关系状态】之前（`budget.js` `SECTION_LAYOUT`：
  //   self 20 < bot-state 25 < identity 40 < relation 42），减少状态变化对心声正文前缀的影响。
  //   预算保护来自 `priority`（RELATION=20，丢段顺序按 priority 数字大的先丢），**与可见顺序无关** ——
  //   这句是"该怎么说话"的前提、不是可牺牲的背景，所以给较高的保留级别，但不靠"排在前面"来保。
  //   ★ 本层**只放字符串**：格式由 emotion 模块产（老树同款五段），这里一个字都不重写。
  const botStateText = String(botStateLine ?? '').trim();
  if (botStateText) {
    sections.push({ name: 'bot-state', priority: PRIORITY.RELATION, droppable: true, text: ['【本体状态】', botStateText].join('\n') });
  }
  diagnostics.botStateLine = { present: Boolean(botStateText), chars: botStateText.length };

  // ── N58 接梗提示（【脑内闪过】）────────────────────────────────────────────
  //   编排层（orchestrator/compose.js）算好"这轮该不该闪、闪哪条"；本层按老树口径挂进 user 段。
  //   ★ priority 用 PRIORITY.EXTRA 而不是补丁原文的 PRIORITY.TRIGGER：applyBudget 的丢段顺序是
  //     **priority 数字大的先丢**（budget.js:`.sort((a,b)=>b.priority-a.priority)`），TRIGGER=10
  //     会被当成"和【本次唤醒】一样不能丢"，与"梗是锦上添花、预算紧先丢它"的既定意图相反。
  //     ⇒ 按意图取 EXTRA(60)，常量仍是本文件已导入的 PRIORITY.*，没有造新常量。
  if (memeCueText) {
    sections.push({
      name: 'meme-cue',
      priority: PRIORITY.EXTRA,
      droppable: true,
      text: memeCueText
    });
  }
  diagnostics.memeCue = { present: memeCueText.length > 0, chars: memeCueText.length };

  // ── 参与度参考（老树 src/prompt.js:808-817 逐字；push 位置老树是 :1886，在【本次唤醒】之后）
  //   `persona.participation` 在 defaults 里有默认值 'medium'、在 key-ledger 里是个真旋钮，
  //   但**新树此前一个读点都没有** ⇒ 用户滑了这个滑条，模型看不到任何变化（N45 派单项 1）。
  //   ⚠ 2026-10-17 复核（布局登记时发现）：本段登记为 `user:false` —— user 过滤会丢掉它，
  //   而全树没有第二处注入路径（compose 无 append、仅本文件调用 participationText）
  //   ⇒ **这一段现在仍然到不了模型**（滑条依旧不生效）；详见回执"潜在缺口"，恢复与否是产品/权限决定。
  const participation = readCfg(cfg, 'persona.participation', 'medium');
  const participationBody = participationText(participation);
  sections.push({ name: 'participation', priority: PRIORITY.TRIGGER, droppable: true, text: participationBody });
  diagnostics.participation = {
    level: String(participation ?? ''), chars: participationBody.length,
    // 从登记表派生（别写死）：翻成 user:true 后这里自动变 true。
    injected: sectionLayoutOf('participation').user === true,
  };

  // ── N32：老树口径的【印象】段（`modules/memory/prompt-format.js` 的 formatForPrompt）。
  //   老树位置：`src/prompt.js:1904` —— `parts.push('【记忆】\n${memText}')`，夹在【参与度参考】与
  //   【成员备注】之间（即"本次唤醒之后、操作手册之前"）。
  //   新树位置由 `budget.js` SECTION_LAYOUT 决定：默认在关系状态之后、按需召回提示之前；
  //   DS 专属顺序在跨轮心声/记忆事实之后、本体状态之前，避免印象变化截断前面的心声。
  //   ★ 与【记忆视图】并存，不删任何一个（老树两者都有：印象段按人，prefetch 按观察）。
  const impressionBody = String(impressionText ?? '').trim();
  // ★ 2026-10-16（用户：「这个印象能注入吗，别光记不能注入」）：
  //   改前这一段 `droppable:true` 且**没有 shrink** ⇒ 只要用户段超预算（长历史挤占），
  //   排在最前面的它会被**整段裁掉**，界面上却仍显示"已渲染"（diagnostics.impressionText 是预算前读数）。
  //   现在两步收口：
  //   ① 段自己先降级（整片片段地减：建议行 → 态度行 → 末尾人条目，至少留 1 条），只有降到很小
  //      仍装不下才会被整段丢/截尾 —— 与"记忆视图少给几条比整段丢掉好"同一条既定规矩；
  //   ② 预算后写终态账 `diagnostics.impressionFinal`（是否真进 user 段、多少字、被哪一刀裁），
  //      被裁没时并进 `diagnostics.warnings`（compose 落 `compose-prompt-warnings` 日志）。
  //   ⚠ 不反过来牺牲历史条数来给它腾位（用户口径）；也不突破模型上下文上限。
  let impressionPeopleText = '';
  if (impressionBody) {
    impressionPeopleText = ['【记忆】', impressionBody].join('\n');
    sections.push({
      name: 'impressions',
      priority: PRIORITY.MEMORY,
      droppable: true,
      text: impressionPeopleText,
      shrink: () => {
        const next = shrinkImpressionBody(impressionPeopleText);
        if (!next || next.length >= impressionPeopleText.length) return null;
        impressionPeopleText = next;
        return next;
      }
    });
  }
  diagnostics.impressionText = {
    present: Boolean(impressionBody),
    chars: impressionBody.length,
    // 渲染侧可核对计数（按人条目文本切分；claims 自带分号时该数是上界，见 shrinkImpressionBody 注）
    people: impressionBody ? impressionBody.split('; ').length : 0,
    hasHint: impressionBody.includes('\n（态度）'),
    hasSuggestion: /\nJev建议：/.test(impressionBody)
  };

  // ── N59：M15 传来的待办文本（老树 src/conversation-memory/arch.js:88 renderTodosForPrompt；
  //   新树实现 modules/memory/todos.js:232）。与下面既有【未完待办】段（吃 M6 retrieve 的
  //   context.todos）是两路来源，段名刻意不同 ⇒ 不互相顶替。
  const pendingTodosBody = String(pendingTodosText ?? '').trim();
  if (pendingTodosBody) {
    sections.push({ name: 'pending-todos', priority: PRIORITY.MEMORY, droppable: true,
      text: ['【待办】', pendingTodosBody].join('\n') });
  }
  diagnostics.pendingTodos = { present: Boolean(pendingTodosBody), chars: pendingTodosBody.length };

  // ── 问旧事·硬要求 + 预检索线索（老树 src/prompt.js:2045-2055 + src/orchestrator.js:2712-2752）。
  //   compose.js 在问旧事时产出这两段文案（memory-recall.js 拼装），本层只挂进 user 段。
  //   ★ 两段都是**触发条件型**（只在问旧事那一轮出现），不进 system 稳定前缀 ⇒ 不污染缓存。
  //   priority 用 PRIORITY.MEMORY：与记忆视图同档，预算紧张时可丢（硬要求丢了模型仍能靠工具描述搜）。
  const memoryRecallBody = String(memoryRecallText ?? '').trim();
  if (memoryRecallBody) {
    sections.push({ name: 'memory-recall-reminder', priority: PRIORITY.MEMORY, droppable: true, text: memoryRecallBody });
  }
  diagnostics.memoryRecallReminder = { present: Boolean(memoryRecallBody), chars: memoryRecallBody.length };
  const memoryPrefetchBody = String(memoryPrefetchText ?? '').trim();
  if (memoryPrefetchBody) {
    sections.push({ name: 'memory-prefetch', priority: PRIORITY.EXTRA, droppable: true, text: memoryPrefetchBody });
  }
  diagnostics.memoryPrefetch = { present: Boolean(memoryPrefetchBody), chars: memoryPrefetchBody.length };

  // ── 近24h本地摘要（老树 src/orchestrator.js:2936-2939）。
  //   compose.js 按开关+小时桶缓存产出（recent-digest.js 拼装），本层只挂进 user 段。
  //   ★ 会话动态信息，**绝不进 system 稳定前缀**（老树 :2529 注释原话）；priority=EXTRA 预算紧先丢。
  const recentDigestBody = String(recentDigestText ?? '').trim();
  if (recentDigestBody) {
    sections.push({ name: 'recent-digest', priority: PRIORITY.EXTRA, droppable: true, text: recentDigestBody });
  }
  diagnostics.recentDigest = { present: Boolean(recentDigestBody), chars: recentDigestBody.length };

  // ── 跨轮工作记忆 ──
  //   ★ 2026-10-16 用户令：取消【跨轮记忆】注入（与【跨轮心声】重复）。保留跨轮心声注入。
  //   保留 crossTurnText 参数与调用兼容（compose.js 仍传值），但本层不再生成 cross-turn section。
  //   写入/存储（working-window.js saveCrossTurn）、年龄闸、semanticCards.ingestFromCrossTurn 均保留。
  diagnostics.crossTurn = { present: false, chars: 0, disabled: 'user-cancelled-injection' };

  // ── 语义卡（老树 src/conversation-memory/arch.js:101-115 的【语义卡】段）。
  //   compose.js 按触发文本匹配（semantic-cards.js match + filterFreshCards），本层只挂进 user 段。
  //   ★ `api.architecture.semanticCards` 开关的**真实消费点**（不开启不出）。
  //   ★ 会话范围（chatKey 匹配），不跨群泄漏；plan 类 30 天过期；semanticTopN 限条数。
  const semanticCardsBody = String(semanticCardsText ?? '').trim();
  if (semanticCardsBody) {
    sections.push({ name: 'semantic-cards', priority: PRIORITY.EXTRA, droppable: true, text: semanticCardsBody });
  }
  diagnostics.semanticCards = { present: Boolean(semanticCardsBody), chars: semanticCardsBody.length };

  // 调用方传结构化冷热分片；本层通过同一历史 renderer 渲染。
  // ★ 预算不足时的收缩顺序（2026-10-14 裁定，③ 输入瘦身第一件）：**先压逐条字数 → 再压热段条数 → 冷段不动**；
  //   两级压到底仍超预算 ⇒ 历史按切点原样注入，并把「本轮超预算」写进 diagnostics（见下面 stress 那一段）。
  diagnostics.historyCold = { enabled: historyCold?.enabled ?? null, coldCount: 0, warmCount: 0, source: 'pastChatHistory' };

  // ─────────────────────────────────────────────────────────────────────────
  // ★ 2026-10-17（用户 · 洛版 0.4.8 DS 布局接入）：有效策略 = deepseek 时启用两件**只属于 DS** 的事：
  //   ① 历史窗口**按本地 id 锚定**（`deepseek-history.js` 纯算法；anchor = floor((newest−limit)/chunk)×chunk，
  //      窗口 (anchor, newest] 长度落在 [limit, limit+chunk−1]，chunk = clamp(round(limit×2.4), 4, 192)）——
  //      等价于把"固定 12 行头对齐"换成随 limit 伸缩的锚定，且**不减少**已有可见历史条数；
  //   ② `stablePrefixSections`（调用方稳定渲染好的素材段，如 DS 表情库）放在**历史之前**。
  //
  //   纪律（与参考稿的差异逐条对齐）：
  //   · 锚定的**唯一实现**在 ds1 模块里，本层只接入，不复制第二份公式；
  //   · 输入 = 上游**已过滤、升序**的真消息（撤回/点名遗忘/人格隔离/屏蔽都在之前完成）；
  //     本层不复活任何行、不重编号、不改 id（`deepseek-history.js` 只新建数组）；
  //   · 只有**真正稳定**的素材才配放历史之前：调用方给了什么就放什么，本层不去搬记忆/心声/印象
  //     （那些段仍在历史之后，顺序由 `SECTION_LAYOUT` 决定）；
  //   · 取回不够/无本地 id/id 空洞 ⇒ 算法自己 `degraded + reason`，本层**不假报锚定成功**，
  //     也不为了缓存少给历史（算法退回原滑窗 = 正好 limit 条）；
  //   · 锚定多给的历史行仍受既有总预算/收缩阶梯约束（下面单时间线那一路的原逻辑），
  //     预算真压过头就按既有刀法收缩并留痕，**不删消息、不冻记忆**。
  const dsStablePrefixProvided = Array.isArray(stablePrefixSections)
    ? stablePrefixSections.filter((s) => s && typeof s === 'object').map((s) => ({
      name: String(s.name ?? '').trim(), text: String(s.text ?? ''), required: s.required === true
    })).filter((s) => s.name)
    : [];
  const dsStablePrefixAccepted = [];
  const dsStablePrefixRejected = [];
  let deepseekPlan = null;
  if (anchoredLayoutMode) {
    // 稳定前置段：只接受**没被官方段占用**的名字（不覆盖其他生产者），空文本/重复名拒绝；只注入一次。
    const seenNames = new Set();
    for (const [index, spec] of dsStablePrefixProvided.entries()) {
      const layout = sectionLayoutOf(spec.name);
      if (layout.unregistered !== true) {
        dsStablePrefixRejected.push({ name: spec.name, reason: 'name-owned-by-official-section' });
        continue;
      }
      if (seenNames.has(spec.name)) { dsStablePrefixRejected.push({ name: spec.name, reason: 'duplicate' }); continue; }
      if (!spec.text.trim()) { dsStablePrefixRejected.push({ name: spec.name, reason: 'empty-text' }); continue; }
      seenNames.add(spec.name);
      dsStablePrefixAccepted.push({ name: spec.name, text: spec.text, index });
      sections.push({
        // 负数顺序 = 排在 `current-context`（内含历史）**之前** —— 这是 DS 布局里唯一的前置位。
        name: spec.name, layoutOrder: -1000 + index,
        // DS 十张固定清单保持前缀；调用方明确标记 required，其余素材沿用可丢策略。
        priority: spec.required ? PRIORITY.TRIGGER : PRIORITY.MEDIA,
        droppable: !spec.required, text: spec.text
      });
    }
    // 历史窗口：与既有两条路**同源同优先**（冷热分片走 pastChatHistory；未切分走 historyForPrompt）。
    const dsHadSplitPlan = useHistoryCold;
    // ★ 2026-10-17（ds3 整合）：DS 锚定的行集合**优先用 `pastChatHistory`** —— compose 的 DS 预取
    //   （deepseekHistoryFetchLimit）读到的行就落在这里；`historyForPrompt` 可能是记忆协调器的
    //   `context.recent`（另一套行集合），拿它锚定会锚错对象。没给 pastChatHistory 时才退回原优先级。
    const pastChatHasRows = pastChatHistory && typeof pastChatHistory === 'object'
      && Array.isArray(pastChatHistory.messages) && pastChatHistory.messages.length > 0;
    const dsSource = pastChatHasRows
      ? pastChatHistory
      : (useHistoryCold
        ? (pastChatHistory && typeof pastChatHistory === 'object' ? pastChatHistory : null)
        : (historyForPrompt && typeof historyForPrompt === 'object' ? historyForPrompt : null));
    const dsRows = dsSource && Array.isArray(dsSource.messages) ? dsSource.messages : [];
    const dsRowBudget = Math.max(0, Math.floor(Number(budget.maxRecentChatMessages) || 0));
    // `limit` = **原本可见基准**（锚定只会 ≥ 它）。优先级：
    //   ① 调用方显式传的 `historyBaseLimit`（compose 按"原路径本轮会读进候选的上限"一次性确定，
    //      **不随 DS 预取多取的行数反推** —— 否则 limit→fetch→更大 limit 会自我膨胀）；
    //   ② 没传时才按现路径推导（冷热分片 = 冷段全部 + 热段档位封顶；未切分 = 档位封顶）。
    const dsExplicitBase = Number.isFinite(Number(historyBaseLimit)) && Number(historyBaseLimit) > 0
      ? Math.floor(Number(historyBaseLimit)) : null;
    const dsIntended = dsExplicitBase !== null
      ? dsExplicitBase
      : (useHistoryCold
        ? (coldMessages.length + Math.min(warmMessages.length, dsRowBudget))
        : Math.min(dsRows.length, dsRowBudget));
    if (dsSource && dsRows.length > 0 && dsIntended > 0) {
      const anchorOptions = deepseekHistoryOptionsFor({ strategy: cacheStrategyId, cfg, chatKey, kind });
      const chunk = deepseekAnchorChunkFor(dsIntended, anchorOptions);
      // 取回上限只作**诊断真值**（取回是 compose 的事）：本轮实际拿到多少、算法需要多少，两者对不上要说出来。
      const fetchLimit = deepseekHistoryFetchLimit(dsIntended, { excludeCount: 0, ...anchorOptions });
      const sel = selectDeepseekAnchoredHistory(dsRows, { limit: dsIntended, chunk });
      deepseekPlan = {
        applied: true,
        source: useHistoryCold ? 'pastChatHistory(split-rowset)'
          : (preparedRecent?.status === 'available' ? 'context.recent' : 'pastChatHistory'),
        limit: dsIntended, chunk, fetchLimit, received: dsRows.length,
        prefetchShort: dsRows.length < fetchLimit,
        // 本来会走冷/热两段的那一轮，这里被"整体锚定时间线"取代（行集合不变，只是不再分两段贴标签）。
        bypassedSplit: dsHadSplitPlan === true,
        // 算法原样字段（不含正文）：messages/chunk/anchor/anchored/degraded/reason/计数字段
        selected: sel,
      };
      // 锚定窗口**就是**本轮历史：不再走冷/热两段，也不再叠 12 行头对齐（同一位置只能有一条规则生效）。
      historyForPrompt = { ...dsSource, messages: sel.messages };
      // 只切掉"分片渲染"这一条路（历史行集合本身没变，是冷热两段的并集）；单时间线路继续用。
      useHistoryCold = false;
    } else {
      deepseekPlan = {
        applied: false,
        source: dsSource ? (useHistoryCold ? 'pastChatHistory(split-rowset)' : 'historyForPrompt') : 'none',
        limit: dsIntended, chunk: null, fetchLimit: null, received: dsRows.length,
        prefetchShort: false,
        // 没历史 / 档位=0（本轮本来就不给历史）⇒ 不锚定，也不凭空塞历史。
        selected: { messages: [], anchored: false, degraded: true,
          reason: dsRows.length ? 'zero-limit' : 'no-history-rows', inputCount: dsRows.length, visibleCount: 0 },
      };
    }
  }

  // ── 双方实际聊天共用时间线；另一段只承接跨轮心声与时间线外的自身记忆。
  let visibleTimeline = [];
  let hiddenHistoryRows = 0;          // 双人格隔离：本轮从时间线里隐去的自发言行数（只记账，不落正文）
  // 冷热那一路的收缩账（只有走了这一路才非 null），末尾的超限留痕从这里取数。
  let historySplitStress = null;
  if (useHistoryCold) {
    const CHARS_FLOOR = 32;           // 逐条字数最低档（与改前同一格，口径不动）
    const rowBudget = Math.max(0, Math.floor(Number(budget.maxRecentChatMessages) || 0));
    // ★ 冷段边界只由**切点**决定：条数预算不再落在冷段上。
    //   改前这一格是 `行预算 − 热段条数`，于是"预算不足先砍冷段"，看得见的较早段起点跟着
    //   `maxRecentChatMessages`（或调用方传的 contextLimit）每轮漂；而老树那条省写规则
    //   （"一条消息一行"要看前文的 `prevTs`/`seen`，实现见 `blocks.js` 的 historyLine）
    //   读到什么前文，正是由这个起点决定 ⇒ 起点一漂，相邻两轮的前文不同，写法错位、缓存前缀也白写。
    //   现在条数这一格只剩热段一个落点（`maxRecentChatMessages` 的语义随之变成"热段条数上限"，
    //   已同步写进 `budget.js` 那一行的说明）。
    let maxColdMessages = coldMessages.length;
    let maxWarmMessages = Math.min(warmMessages.length, rowBudget);
    let maxMessageChars = budget.maxRecentChatCharsPerMessage;
    // ★ 2026-10-17（历史预算稳定化）：冷/热分开的逐行上限。**首帧两段相同**（字节 = 现状）；
    //   预算压力下先只压热段（冷段一个字节不动 ⇒ 前缀最前端保住），再轮到旧行为的全局刀，
    //   条数刀排最后（详见 advanceShrink 的顺序说明）。上限基数来自稳定输入：
    //   配置（maxRecentChatCharsPerMessage）+ 档位行数（rowBudget）+ 检查点窗口，不随本轮动态
    //   记忆长度直接跳档。
    let warmMaxMessageChars = maxMessageChars;
    const draw = () => renderRecentChatSplit(pastChatHistory, historyCold, {
      now: nowMs, maxColdMessages, maxWarmMessages, maxMessageChars, warmMaxMessageChars, kind, sanitizeSelfStyle,
      personaTwo, hygiene: personaHygiene, notes: memberNotes, includeContextHeadings: false,
      // ★ 2026-10-16（缓存前缀收口）：段头对齐块 —— 低档位（rowBudget 小于热段窗口）时旧行为
      //   每来一条新消息就把热段头滑一格，前缀缓存从那里整段失效。只增不减，上限 +11 条。
      headChunk: HISTORY_HEAD_CHUNK
    });
    let r = draw();
    currentHistoryText = r.text;
    visibleTimeline = r.picked;
    hiddenHistoryRows = r.personaHidden || 0;
    historySplitStress = {
      coldRows: coldMessages.length,
      warmRows: warmMessages.length,
      shownCold: r.coldPicked.length,
      shownWarm: r.warmPicked.length,
      // ★ 这条必须恒为 0：冷段少一条就算被预算动过（双人格隐去的行不算，那是隔离，走 personaHidden）
      coldOmittedByBudget: r.coldOmitted,
      warmOmittedByBudget: r.warmOmitted,
      charsFloor: CHARS_FLOOR,
      maxMessageChars,
      warmMaxMessageChars,
      // ★ 2026-10-17：格式依据与兜底留痕（脱敏计数）——后续只看这些字段就知道本轮有没有重画：
      capBasis: 'config-cap; warm-first-ladder',
      coldRedraw: false,          // 全局刀(②)是否动过冷段（= 冷前缀会逐轮重画的条件）
      rowCutUsed: false,          // 条数刀(③)是否用过（旧行为第二刀，只可能更少用）
      leversUsed: [],             // 实际推进过的收缩格（'chars-warm' / 'chars-cold' / 'warm-rows'）
      exhausted: false            // 三个刀都到底、这一段再缩不出字
    };
    const syncStress = () => {
      historySplitStress.shownCold = r.coldPicked.length;
      historySplitStress.shownWarm = r.warmPicked.length;
      historySplitStress.coldOmittedByBudget = r.coldOmitted;
      historySplitStress.warmOmittedByBudget = r.warmOmitted;
      historySplitStress.maxMessageChars = maxMessageChars;
      historySplitStress.warmMaxMessageChars = warmMaxMessageChars;
      historySplitStress.maxWarmMessages = maxWarmMessages;
    };
    // 推进一格 —— 顺序 = 对"跨轮可复用前缀"的破坏程度，从轻到重：
    //   ① 'chars-warm'：只压热段行上限。冷段（历史最前端、前缀最值钱的一段）零字节变化；
    //      热段紧邻逐轮变化的尾部，本来就在稳定区末端。
    //   ② 'chars-cold'：压全局行上限 —— **旧行为的同一把刀**，冷段会随之重画；如实记 `coldRedraw`。
    //   ③ 'warm-rows'：热段条数减半 —— **旧行为的第二把刀**，排在两把字刀之后 ⇒ 条数只会比旧行为
    //      少砍、决不多砍（旧行为字刀到底就砍条数；这里两把字刀全到底才轮到它）。
    //   ⚠ 冷段行数（maxColdMessages）任何一刀都不动：不默认砍历史条数，冷段起点只由检查点切点决定。
    const advanceShrink = () => {
      if (Number(warmMaxMessageChars) > CHARS_FLOOR) {
        warmMaxMessageChars = Math.max(CHARS_FLOOR,
          Math.min(Number(maxMessageChars), Math.floor(Number(warmMaxMessageChars) / 2)));
        return 'chars-warm';
      }
      if (Number(maxMessageChars) > CHARS_FLOOR) {
        maxMessageChars = Math.max(CHARS_FLOOR, Math.floor(Number(maxMessageChars) / 2));
        warmMaxMessageChars = Math.min(Number(warmMaxMessageChars), Number(maxMessageChars));
        historySplitStress.coldRedraw = true;
        return 'chars-cold';
      }
      // 热段最少留 1 条：一条都不留就变成"只有背景、最近谁说了什么全没了"，那比超限更坏。
      // 压到这里还不够 ⇒ 不再缩，交给下面的按数注入。
      if (maxWarmMessages > 1) {
        maxWarmMessages = Math.max(1, Math.floor(maxWarmMessages / 2));
        historySplitStress.rowCutUsed = true;
        return 'warm-rows';
      }
      return null;
    };
    diagnostics.historyCold = {
      enabled: true, coldCount: coldMessages.length, warmCount: warmMessages.length, source: 'historyCold',
      shownColdCount: r.coldPicked.length, shownWarmCount: r.warmPicked.length
    };
    // 历史头只有正文那一份；这段时效文字改为只供诊断，不再重复注入给模型。
    diagnostics.historyStatus = r.statusText;
    shrinkCurrentHistory = () => {
      const before = r.text;
      // 一级压下去省不出字（例如所有行本来短于字数上限）⇒ 接着推下一级，直到有收获或到底。
      // 上限 24 步：三条梯子各 ≤6 级（chars-warm / chars-cold / warm-rows），旧行为两条梯子 ≤12 步。
      for (let guard = 0; guard < 24; guard += 1) {
        const lever = advanceShrink();
        if (!lever) break;
        const next = draw();
        if (next.text.length < before.length) {
          r = next;
          visibleTimeline = r.picked;
          hiddenHistoryRows = r.personaHidden || 0;
          diagnostics.historyStatus = r.statusText;
          diagnostics.historyCold.shownColdCount = r.coldPicked.length;
          diagnostics.historyCold.shownWarmCount = r.warmPicked.length;
          historySplitStress.leversUsed.push(lever);
          syncStress();
          return r.text;
        }
      }
      // 到底 ⇒ 历史不再收缩；预算层会如实记下整份输入的超限。
      historySplitStress.exhausted = true;
      syncStress();
      return null;
    };
  } else if (historyForPrompt && typeof historyForPrompt === 'object') {
    // ★ 2026-10-17（DS 布局）：锚定窗口 = 本轮历史的**最终条数** —— 不叠 12 行头对齐、不再被档位二次切片，
    //   否则"随 limit 伸缩的锚定"会形同虚设（窗口头被第二套规则又搬一次）。
    const dsWindow = deepseekPlan?.applied ? deepseekPlan.selected : null;
    let maxMessages = dsWindow ? dsWindow.messages.length : budget.maxRecentChatMessages;
    let maxMessageChars = budget.maxRecentChatCharsPerMessage;
    let r = renderRecentChat(historyForPrompt, { now: nowMs, maxMessages, maxMessageChars, kind, sanitizeSelfStyle, personaTwo, hygiene: personaHygiene, notes: memberNotes, includeContextHeadings: false, headChunk: dsWindow ? 0 : HISTORY_HEAD_CHUNK });
    const historyMessages = Array.isArray(historyForPrompt.messages) ? historyForPrompt.messages : [];
    currentHistoryText = r.text;
    visibleTimeline = r.picked;
    hiddenHistoryRows = r.personaHidden || 0;
    diagnostics.historyCold = {
      enabled: historyCold?.enabled === false ? false : null,
      coldCount: 0, warmCount: historyMessages.length,
      source: dsWindow
        ? (cacheStrategyId === 'deepseek' ? 'deepseek-anchored' : 'anchored-history')
        : 'pastChatHistory',
      // ★ 2026-10-17（历史预算稳定化）：单时间线这一路**未改行为** —— 它本来就是一整段，
      //   顺序是"先减条数、字刀最后"（旧口径）。这里只补脱敏依据/留痕，供诊断统一读取。
      //   DS 分支：窗口由锚定算法给（条数已含 headroom），收缩阶梯不变。
      capBasis: dsWindow
        ? (cacheStrategyId === 'deepseek' ? 'ds-anchor-window; deferred; anchor-extra-first; chars-fallback; base-floor' : 'anchored-window; row-first; chars-fallback')
        : 'config-cap; row-first; chars-fallback',
      ...(dsWindow && deepseekPlan.bypassedSplit ? { bypassedSplit: true } : {}),
      coldCharsRedrawn: false,
      rowCutUsed: false,
      // ★ 2026-10-17（ds3 整合）：DS 分支收回"锚定增量"（窗口→基准 limit）时置真——它只回收为缓存
      //   多要的行，**不动原本应有历史**；rowCutUsed=true 才表示连基准都被预算动了（旧安全兜底）。
      ...(dsWindow ? { anchorTrimmed: false, baseLimit: dsWindow ? deepseekPlan?.limit ?? null : null } : {}),
      ...(deepseekMode ? { maxMessageChars } : {})
    };
    diagnostics.historyStatus = r.statusText;
    // ★ 2026-10-17（ds3 整合 · DS 基准 floor）：DS 锚定窗口的下界 = 原本可见基准 ——
    //   预算收缩**不许把原本应有的历史（含基准条数）砍掉**：① 先压可压文字（逐条字数，行字节变、条数不变）；
    //   ② 再收"锚定增量"（窗口 → 基准 limit，只回收为缓存多要的那些行）；③ 仍不够才走旧安全兜底
    //   （条数减半，如实记 `rowCutUsed`）；全装不下就交给既有 over-budget 报告，不伪装成功。
    const dsBaseLimit = dsWindow
      ? Math.max(1, Math.min(Number.isFinite(Number(historyBaseLimit)) && Number(historyBaseLimit) > 0
        ? Math.floor(Number(historyBaseLimit)) : (Number(deepseekPlan?.limit) || 1), historyMessages.length))
      : 0;
    shrinkCurrentHistory = () => {
      const before = r.text;
      if (deepseekMode && dsWindow) {
        // 先处理可丢动态段，再收回锚定增量；最后才重画旧行，不低于基准条数。
        for (let guard = 0; guard < 16; guard += 1) {
          const shown = Math.min(maxMessages, historyMessages.length);
          let lever;
          if (shown > dsBaseLimit) {
            maxMessages = Math.max(dsBaseLimit, Math.floor(shown / 2));
            lever = 'extra';
          } else if (maxMessageChars > 32) {
            maxMessageChars = Math.max(32, Math.floor(maxMessageChars / 2));
            lever = 'chars';
          } else return null;
          const next = renderRecentChat(historyForPrompt, { now: nowMs, maxMessages, maxMessageChars,
            kind, sanitizeSelfStyle, personaTwo, hygiene: personaHygiene, notes: memberNotes,
            includeContextHeadings: false, headChunk: 0 });
          if (next.text.length >= before.length) continue;
          r = next;
          if (lever === 'extra') diagnostics.historyCold.anchorTrimmed = true;
          else diagnostics.historyCold.coldCharsRedrawn = true;
          diagnostics.historyCold.maxMessageChars = maxMessageChars;
          diagnostics.historyStatus = r.statusText;
          hiddenHistoryRows = r.personaHidden || 0;
          visibleTimeline = r.picked;
          return r.text;
        }
        return null;
      }
      const shown = Math.min(maxMessages, historyMessages.length);
      if (dsWindow) {
        if (maxMessageChars > 32) { maxMessageChars = Math.max(32, Math.floor(maxMessageChars / 2)); diagnostics.historyCold.coldCharsRedrawn = true; }
        else if (shown > dsBaseLimit) { maxMessages = Math.max(dsBaseLimit, Math.floor(shown / 2)); diagnostics.historyCold.anchorTrimmed = true; }
        else if (shown > 1) { maxMessages = Math.floor(shown / 2); diagnostics.historyCold.rowCutUsed = true; diagnostics.historyCold.coldCharsRedrawn = true; }
        else if (shown === 1) { maxMessages = 0; diagnostics.historyCold.rowCutUsed = true; }
        else return null;
      } else if (shown > 1) { maxMessages = Math.floor(shown / 2); diagnostics.historyCold.rowCutUsed = true; diagnostics.historyCold.coldCharsRedrawn = true; }
      else if (shown === 1 && maxMessageChars > 32) { maxMessageChars = Math.max(32, Math.floor(maxMessageChars / 2)); diagnostics.historyCold.coldCharsRedrawn = true; }
      else if (shown === 1) { maxMessages = 0; diagnostics.historyCold.rowCutUsed = true; }
      else return null;
      r = renderRecentChat(historyForPrompt, { now: nowMs, maxMessages, maxMessageChars, kind, sanitizeSelfStyle, personaTwo, hygiene: personaHygiene, notes: memberNotes, includeContextHeadings: false });
      // A shorter per-message cap may not change a short message. If so, remove that row
      // and keep any surviving rows without adding a second block heading.
      // ★ 2026-10-17（DS 基准 floor）：DS 分支**不清零历史**（那会低于原本可见基准）——
      //   压不出字就到此为止，交给既有 over-budget 报告如实说明。
      if (r.text.length >= before.length && shown > 0) {
        if (dsWindow) return null;
        maxMessages = 0;
        r = renderRecentChat(historyForPrompt, { now: nowMs, maxMessages, maxMessageChars, kind, sanitizeSelfStyle, personaTwo, hygiene: personaHygiene, notes: memberNotes, includeContextHeadings: false });
      }
      if (r.text.length >= before.length) return null;
      diagnostics.historyStatus = r.statusText;
      hiddenHistoryRows = r.personaHidden || 0;
      return r.text;
    };
  }
  currentContextSection.text = buildCurrentContextText();

  // ── 跨轮只注入模型心声；已发出的聊天内容由本轮上下文或情节摘要承载。
  const botSaid = [];
  // 是不是同一条消息，只看 `history-format.js` 那一处判据：**先比消息身份**（本地序号或 QQ 消息号），
  // 两个身份都没有才退回"同一时刻 + 同一发言人 + 同一段正文"。
  // ★ 不再单凭正文相同就认为是同一条 —— 不同人在不同时刻说"收到"是常事，按文本去重会误删一条真话。
  const inTimeline = (row) => visibleTimeline.some((seen) => sameHistoryMessage(seen, row));
  const addSelf = (row) => {
    if (row?.memoryKind !== 'thought') return;
    if (Number.isFinite(Number(row.weight)) && Number(row.weight) <= 0) return;
    const text = String(row?.text ?? '').trim();
    if (!text || inTimeline(row)) return;
    const index = botSaid.findIndex((old) => sameHistoryMessage(old, row));
    if (index >= 0) {
      if ((row.memoryKind === 'thought') !== (botSaid[index].memoryKind === 'thought')) {
        if (row.memoryKind === 'thought') botSaid[index] = row;
        return;
      }
      const time = (entry) => Number(entry.at) || Date.parse(String(entry.at)) || 0;
      if (time(row) > time(botSaid[index])) botSaid[index] = row;
      return;
    }
    botSaid.push(row);
  };
  for (const row of Array.isArray(crossRoundMemory) ? crossRoundMemory : []) addSelf(row);
  {
    const max = budget.maxRecentSends;
    const r = renderRecentSends(botSaid, {
      now: nowMs, max, selfName, maxMessageChars: budget.maxRecentChatCharsPerMessage, sanitizeSelfStyle,
      personaTwo, hygiene: personaHygiene, notes: memberNotes
    });
    if (r.text) sections.push({ name: 'self', priority: PRIORITY.SELF, droppable: true, text: r.text, meta: { picked: r.picked.length, dropped: r.dropped } });
    // ★ 时效那一段（精确时间范围 + 展示/未复投计数）改**只进 diagnostics**（2026-10-14 用户令删独立块 · 裁定甲）：
    //   以前它作为 `self-status` 一节挤在正文里，每轮都变、且那些数模型用不上（【过去状态·最近】的标题已给了粗年龄）。
    diagnostics.selfStatus = r.statusText || '';
    diagnostics.personaIsolation = {
      personaTwo,
      hiddenHistoryRows,
      hiddenSelfRows: r.personaHidden || 0
    };
  }

  // ── MemoryContextV1：各视图独立预算，当前唤醒 / 更正 / 待办优先于一般记忆。
  if (context && typeof context === 'object') {
    // applicableRoundId 留在 context.diagnostics；运行编号不写进每个记忆段的头部。
    const recalled = Array.isArray(context.recalled) ? context.recalled
      : Array.isArray(context.items) ? context.items : [];
    // ★ P0-2 读端口径（功能表 5 · 2026-10-11）：三判据里**只有第一条在生产是活的** ——
    //   `row.correction === true`。生产者唯一一处是 `memory/store.js` 写观察时（只有"取代了旧卡
    //   且说法确实变了"才置 true），读端经 `memory/index.js retrieve` 白名单与
    //   `coordinator.recallWithSemantic` 的 keep.push 两条腿带出来。
    //   另两条判据（memoryClass/type='correction'）是 legacy 兜底：`memoryClass` 词表只准
    //   working|long_term（contracts:445）、OBS_TYPES 里没有 correction ⇒ 恒假，**故意留着**
    //   只为兼容老数据/外部注入的形状；改判据请连 store.js 的生产者一起改，别只改这一处。
    const isCorrection = (row) => row?.correction === true || row?.memoryClass === 'correction'
      || String(row?.type ?? '').toLowerCase() === 'correction';

    // ── N28：进提示词之前先把条目投影干净（**过滤侧**，不碰 blocks.js 的渲染）
    //   ① 私聊只放"本轮对话人 / 机器人自己 / 调用方点名要的"的印象；别人的 global 印象一律不进
    //      （用户裁定优先于 scope.js"global 跨群可用"的原设计；群聊口径**不变**）
    //   ② 内部证据 id（mig-ev:…）换成"N 处出处"——模型查不到内部 id，也不需要
    //   ③ 单条 claim 截断 + 整段字符硬上限（改前只有条数闸，每条原文照灌）
    const peerIds = counterpartIds({ kind, chatKey, evidence: valid, peerId: p.peerId, selfId: selfAccount });
    // 「与本轮话题直接相关」只认**显式点名**（`need.subjectIds` 是 retrieve 契约里的真键），
    // 不做按词的模糊匹配 —— 中文共用词太多，模糊匹配等于把别人的印象换个入口漏进私聊。
    const requestedSubjects = new Set([
      ...(Array.isArray(context?.need?.subjectIds) ? context.need.subjectIds : []),
      ...(Array.isArray(p.requestedSubjectIds) ? p.requestedSubjectIds : [])
    ].map((v) => String(v).trim()).filter(Boolean));
    const project = (rows) => projectMemoryItems(rows, {
      kind, chatKey, maxClaimChars: budget.maxMemoryClaimChars,
      allowedSubjects: new Set([...peerIds.ids, ...requestedSubjects])
    });
    const projectedCorrections = project(recalled.filter(isCorrection));
    const projectedFacts = project(recalled.filter((row) => !isCorrection(row)));
    const corrections = projectedCorrections.items;
    const facts = projectedFacts.items;
    diagnostics.memoryRecalled = {
      kind, input: recalled.length,
      counterpartSources: peerIds.sources,
      counterpartCount: peerIds.ids.size,
      corrections: projectedCorrections.report,
      facts: projectedFacts.report,
      charBudget: budget.maxMemoryChars
    };

    const memorySection = (name, title, items, limit, priority) => {
      if (!items.length) return;
      const wanted = Math.max(0, Math.min(items.length, Math.floor(Number(limit) || 0)));
      const render = (n) => renderMemoryView({ ...context, items }, {
        now: nowMs, maxItems: n, selfName,
        ...(deepseekMode ? {
          stableOrder: true,
          heading: name === 'memory-facts'
            ? '【记忆视图】以下是过去留有出处的印象，不是本轮新事实；引用时保留来源范围。'
            : title
        } : {})
      });
      // ★ 条数与**字符**双闸：先按真渲染长度回退到装得下的条数（至少 1 条）
      const fitted = fitCountByChars(render, Math.max(1, wanted), budget.maxMemoryChars);
      let count = fitted.count;
      let view = render(count);
      const makeText = () => deepseekMode ? view.text : `${title}\n${view.text}`;
      sections.push({
        name, priority, droppable: true, text: makeText(),
        shrink: () => {
          const next = Math.floor(count / 2);
          if (next < 1 || next >= count) return null;
          count = next;
          view = render(count);
          return makeText();
        },
        meta: { available: items.length, included: view.used.length, chars: view.text.length }
      });
    };
    memorySection('corrections', '【明确更正】有证据的更正优先采用；更正只适用其来源范围。',
      corrections, budget.maxMemoryCorrections, PRIORITY.CORRECTION);
    memorySection('memory-facts', '【记忆视图】过去留有出处的事实；不是本轮新事实。',
      facts, budget.maxMemoryItems, PRIORITY.MEMORY);

    const working = context.working && typeof context.working === 'object' ? context.working : {};
    const topic = String(working.topic ?? context.topic ?? '').trim();
    const need = String(typeof working.need === 'string' ? working.need : working.need?.text ?? context.need?.text ?? context.need ?? '').trim();
    if (topic || need) {
      sections.push({ name: 'working', priority: PRIORITY.WORKING, droppable: true,
        text: ['【短期状态】', topic ? `- 当前话题：${topic}` : '', need ? `- 当前需要：${need}` : ''].filter(Boolean).join('\n') });
    }

    const todos = Array.isArray(context.todos) ? context.todos : [];
    if (todos.length) {
      let count = Math.min(todos.length, budget.maxTodos);
      const renderTodos = () => ['【未完待办】以下仅列未完成且未过期项目；完成状态以待办服务为准。',
        ...todos.slice(0, count).map((todo) => {
          const text = String(todo?.text ?? '').trim();
          const note = String(todo?.note ?? '').trim();
          const left = Number(todo?.leftMin);
          return `- ${text}${note ? `（${note}）` : ''}${Number.isFinite(left) ? `（约${Math.max(0, Math.round(left))}分后过期）` : ''}`;
        })].join('\n');
      sections.push({ name: 'todos', priority: PRIORITY.TODO, droppable: true, text: renderTodos(),
        shrink: () => { const next = Math.floor(count / 2); if (next < 1 || next >= count) return null; count = next; return renderTodos(); },
        meta: { available: todos.length, included: count } });
    }

    const episodes = Array.isArray(context.checkpoint?.episodeSummaries) ? context.checkpoint.episodeSummaries
      : Array.isArray(context.episodeSummaries) ? context.episodeSummaries : [];
    // ★ 情节摘要与历史原文去重（2026-10-14 照搬规格 · 派单第 1 件的一项）。
    //   一条摘要是对**某几条消息**的复述；它覆盖的消息若整段都还在下面【过去状态】里逐行摆着，
    //   模型就读到了同一件事的两份（老树不写这句重复，新树此前每次都整段给）。
    //   判据只用 `firstSourceAt`（该摘要最早的**来源消息**时间，来自 `memory/coordinator.js` 的
    //   episodeSummaries）：它 ≥ 可见历史最早一条 ⇒ 整段都在窗口内 ⇒ 这一条不进正文。
    //   · 时间不明（老数据、模型没回 `at`）⇒ **保留**：证明不了冗余不等于冗余。
    //   · 只删这一条摘要，不动历史行（历史行是原文，摘要不是事实来源）。
    //   · 被删的条数进 diagnostics.episodes.redundant，明细不落正文。
    //   · 段条数上限另算：进正文的计 diagnostics.episodes.injected，超上限的计 overCap。
    const visibleRowTimes = visibleTimeline
      .map((row) => Number(row?.[ROW_FIELD.time] ?? row?.[ROW_FIELD.timeAlt]) || 0)
      .filter((v) => v > 0);
    const earliestVisibleAt = visibleRowTimes.length ? Math.min(...visibleRowTimes) : 0;
    const redundantEpisode = (entry) => earliestVisibleAt > 0
      && Number.isFinite(Number(entry?.firstSourceAt)) && Number(entry.firstSourceAt) >= earliestVisibleAt;
    const episodeRows = episodes.filter((entry) => !redundantEpisode(entry));
    let episodeInjected = 0;
    if (episodeRows.length && budget.maxEpisodeSummaries >= 1) {
      // 用户要求【相关情节摘要】最多五条；调用方自定义预算也不能抬高硬上限。
      let count = Math.min(episodeRows.length, Math.floor(budget.maxEpisodeSummaries), 5);
      const renderEpisodes = () => {
        // 每次真正渲染这一段的条数，跟着 shrink 一起降 —— 报出去必须等于模型看到的。
        episodeInjected = count;
        return ['【相关情节摘要】仅作背景，按摘要中的来源与时间判断是否适用。',
          ...episodeRows.slice(0, count).map((entry) => renderEpisodeSummary(entry, { compact: deepseekMode }))
            .filter(Boolean)].join('\n');
      };
      sections.push({ name: 'episodes', priority: PRIORITY.EPISODE, droppable: true, text: renderEpisodes(),
        shrink: () => { const next = Math.floor(count / 2); if (next < 1 || next >= count) return null; count = next; return renderEpisodes(); },
        meta: { available: episodeRows.length, included: count } });
    }
    diagnostics.episodes = {
      present: episodeInjected > 0, available: episodes.length, injected: episodeInjected,
      overCap: Math.max(0, episodeRows.length - episodeInjected),
      redundant: episodes.length - episodeRows.length, windowStartAt: earliestVisibleAt || null
    };

    // ── 未采用记忆：**只报计数 + 一句人话**，绝不逐条列举（N24）。
    //   上游 `retrieve()` 的 dropped 行只带内部元信息（id / subjectId / scope / reason）、
    //   **没有 claim 正文**；逐条渲染必然退化成打印内部 ID（`mig-ob:chat:group_…`）与
    //   内部 scope 键（`scope:group-not-in-private`）——既泄露内部标识，内容又每轮都在变、
    //   白烧 token 且破坏前缀稳定性。明细归 diagnostics（日志/面板），不进提示词。
    const droppedRows = Array.isArray(context.dropped)
      ? context.dropped.filter((row) => row && typeof row === 'object') : [];
    if (droppedRows.length) {
      const reasonCounts = {};
      for (const row of droppedRows) {
        const key = String(row?.reason ?? 'unknown');
        reasonCounts[key] = (reasonCounts[key] || 0) + 1;
      }
      diagnostics.memoryDropped = { total: droppedRows.length, reasons: reasonCounts };
      sections.push({ name: 'memory-dropped', priority: PRIORITY.MEMORY, droppable: true,
        text: `【记忆范围】另有 ${droppedRows.length} 条记忆在当前会话不可见或与本轮话题不相关，本轮未采用。`,
        meta: { available: droppedRows.length } });
    }
  }

  // ── 工具计划（只读清单；工具能不能调是 M10 的事，这里不许说"已经调了"）
  if (Array.isArray(toolPlan) && toolPlan.length) {
    sections.push({
      name: 'toolplan', priority: PRIORITY.EXTRA, droppable: true,
      text: ['【本轮可用工具清单（还没调用）】', ...toolPlan.map((t) => `- ${t?.name}${t?.sideEffect === 'write' ? '（会写/有副作用）' : ''}`),
        '说明：这些是**还没调用**的工具；调用结果必须以工具返回为准，不许在正文里假装已经调用过。'].join('\n')
    });
  }

  // P2：用户段照旧按 `maxChars` 裁（行为不变），再用**整份请求**口径复核一遍。
  //   ⚠ 本层只拿到 `tools.names`（真 JSON schema 由 M10 拼、在 llm 侧上线）⇒ 这段的
  //   `toolSchemaChars` 是**按名字清单估的**，真账在 `modules/llm/request-budget.js`。
  //   这一点在 diagnostics 里明写，别让人把估的值当真值。
  // ★ 2026-10-17（用户：布局显式化、别让清单无声漂移）：user 段准入**从登记表派生**
  //   （`budget.js` 的 `SECTION_LAYOUT`），本文件不再维护第二份手写名单 —— 旧的 14 项名单里
  //   `cross-turn` 是幽灵（本层早已不生成该段），同时缺 9 个实际段名，三份清单各说各话。
  //   规则：
  //     · `user:true`  ⇒ 进 user 文本（顺序由登记的 `order` 定，与 priority/droppable 无关）；
  //     · `user:false` ⇒ 只推到 `sections` 供诊断、或由 compose 后追加（显式黑名单，每条带 why）；
  //     · **未登记**名 ⇒ 仍进 user（不静默丢内容）、order 落安全尾部，并进 `diagnostics.sectionLayout` 告警；
  //     · `sectionLayoutOf()` 总返回值 ⇒ 过滤不可能抛错，新加段忘了登记也不会让整轮发言挂掉。
  //   relation / identity（易变半）等历史裁定见 `SECTION_LAYOUT` 的 `why`，不再散落在这里。
  const layoutOf = (section) => sectionLayoutOf(section?.name);
  if (deepseekMode) {
    // 心声先于随召回/涉及人物变化的来源段；来源段仍在历史之后、本体/关系之前。
    // 只调整呈现顺序，不改心声时效/权重、记忆召回和裁剪优先级。
    for (const section of sections) {
      const order = layoutOf(section).deepseekOrder;
      if (Number.isFinite(order)) section.layoutOrder = order;
    }
  }
  diagnostics.sectionLayout = {
    // `layoutOrder` 显式声明过的（如 DS 稳定前置段）不算"漏登记"——它们本来就不该进静态登记表。
    unregistered: sections.filter((s) => layoutOf(s).unregistered === true && !hasExplicitLayoutOrder(s)).map((s) => s.name),
    excluded: sections.filter((s) => layoutOf(s).user === false).map((s) => s.name),
    declared: sections.filter((s) => hasExplicitLayoutOrder(s)).map((s) => s.name),
    note: '准入/顺序见 budget.js SECTION_LAYOUT（order 只管可见顺序，与 priority/droppable 无关）',
  };
  const userSections = sections.filter((section) => layoutOf(section).user !== false);
  const { sections: kept } = applyRequestBudget({ sections: userSections, system: sys, tools: toolNames ? { names: toolNames } : null, budget, diagnostics });
  // ★ 2026-10-16：印象段的**终态账** —— pre-budget 的 `impressionText.present` 不是出站证据。
  //   这里记下它最终是否真在 user 段里、剩多少字/多少人条目、被哪几刀裁过；整段被裁没时
  //   进 `diagnostics.warnings`（compose 会落成 `compose-prompt-warnings`，面板/日志查得到原因）。
  try {
    const keptImpression = kept.find((section) => section?.name === 'impressions');
    const keptText = keptImpression ? String(keptImpression.text ?? '') : '';
    const keptBody = keptText ? keptText.split('\n').slice(1).join('\n') : '';
    const cuts = (diagnostics.trimmed || []).filter((t) => t?.section === 'impressions');
    const pre = diagnostics.impressionText || { present: false, chars: 0 };
    diagnostics.impressionFinal = {
      present: Boolean(keptBody.trim()),
      chars: keptBody.length,
      people: keptBody ? keptBody.split('; ').length : 0,
      hasHint: keptBody.includes('\n（态度）'),
      hasSuggestion: /\nJev建议：/.test(keptBody),
      preBudgetPresent: pre.present === true,
      cuts: cuts.map((t) => ({ action: t.action, savedChars: t.savedChars }))
    };
    if (pre.present === true && diagnostics.impressionFinal.present !== true) {
      const last = cuts[cuts.length - 1];
      diagnostics.impressionFinal.reason = last ? `${last.action}:${last.reason}` : 'not-in-user-whitelist';
      diagnostics.warnings.push(`【印象】本轮渲染了但最终未进提示词：${diagnostics.impressionFinal.reason}`);
    } else if (cuts.some((t) => t.action === 'drop' || t.action === 'truncate')) {
      diagnostics.impressionFinal.reason = '部分被裁（见 cuts）';
    }
  } catch { /* 终态记账失败不许影响组包 */ }
  // ③ 的超限留痕（2026-10-14 裁定第 2 条）：冷热两段的逐条字数与热段条数都压到底、还是超 ⇒
  //   历史**按切点原样注入**（不减条数、不静默截断），但"本轮超预算"必须被看见：
  //   `applyBudget` 第 ④ 刀已经往 `diagnostics.trimmed` 写了 over-budget 条目，可那条**生产里没人消费**
  //   （目前只有 `p2-request-budget.selftest.mjs` 读）⇒ 这里再并进 `diagnostics.warnings` 一行，
  //   compose 侧会把 warnings 落成 `compose-prompt-warnings` 日志（读 built.diagnostics.warnings 那一处）
  //   ⇒ 账本/面板上能看到"这一轮超了多少、历史给了多少条、压到哪一格"，而不是静默变短。
  if (historySplitStress?.exhausted
    && (diagnostics.trimmed || []).some((t) => t?.action === 'over-budget' || t?.action === 'request-over-budget')) {
    const stress = historySplitStress;
    diagnostics.historyCold.overBudget = {
      userChars: Number(diagnostics.chars) || 0,
      userCharsLimit: Number(budget.maxChars) || 0,
      userOverChars: Math.max(0, (Number(diagnostics.chars) || 0) - (Number(budget.maxChars) || 0)),
      requestOverChars: Number(diagnostics.request?.overflowChars) || 0,
      coldRowsFromCut: stress.coldRows,
      coldRowsInjected: stress.shownCold,
      // ★ 恒为 0：这条就是"冷段没被预算动过"的凭证，读数不为 0 说明顺序又被改回去了
      coldRowsDroppedByBudget: stress.coldOmittedByBudget,
      warmRowsAvailable: stress.warmRows,
      warmRowsInjected: stress.shownWarm,
      lastMessageCharsCap: stress.maxMessageChars,
      lastWarmCharsCap: Number.isFinite(Number(stress.warmMaxMessageChars))
        ? Number(stress.warmMaxMessageChars) : Number(stress.maxMessageChars),
      lastWarmCountCap: stress.maxWarmMessages,
      // ★ 2026-10-17（历史预算稳定化）：格式依据 + 兜底留痕（只看这几个字段就知道有没有重画）：
      //   · coldRedraw=true ⇒ 全局刀动过冷段（冷前缀这一轮被重画；原因=热段字刀与全局字刀都压到底仍超预算）；
      //   · rowCutUsed=true ⇒ 热段条数刀用过（旧行为第二刀，只可能比旧行为更少用）；
      //   · capBasis 固定为 'config-cap; warm-first-ladder'（上限基数 = 配置，不随动态记忆长度直接跳档）。
      capBasis: String(stress.capBasis || ''),
      coldCharsRedrawn: stress.coldRedraw === true,
      rowCutUsed: stress.rowCutUsed === true,
      shrinkLevers: stress.leversUsed.join('→')
    };
    const ob = diagnostics.historyCold.overBudget;
    diagnostics.warnings.push(
      `本轮提示词超预算：用户段 ${ob.userChars} 字（上限 ${ob.userCharsLimit} 字，超 ${ob.userOverChars} 字`
      + `${ob.requestOverChars ? `；整份请求口径超 ${ob.requestOverChars} 字` : ''}）。`
      + `历史段已压到最低格还是不够：热段逐条 ${ob.lastWarmCharsCap} 字/条、全局 ${ob.lastMessageCharsCap} 字/条`
      + `、热段压到 ${ob.warmRowsInjected} 条（可用 ${ob.warmRowsAvailable} 条），`
      + `冷段 ${ob.coldRowsInjected} 条按切点全量注入（预算一条没砍）`
      + `${ob.coldCharsRedrawn ? '；本轮冷段被全局字刀重画过（热段字刀不够用）' : '；本轮冷段未被预算重画'}。`
      + `这一段不再自行收缩 —— 要收回去得放宽 maxChars，或减少带进提示词的历史条数（后者属另行裁定）。`);
  }
  kept.sort((a, b) => presentationOrder(a) - presentationOrder(b));
  const userText = kept.map((s) => s.text).join('\n\n');

  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: userText }
  ];
  // 前缀指纹（验收 4）：system + 工具名清单。只报告不修 —— 不稳定源归组装层自己定。
  diagnostics.prefix = { ...prefixFingerprint({ system: sys, tools: toolNames ? { names: toolNames } : null }), toolSchemaSource: 'names-only' };

  diagnostics.persona = { id: persona.id, name: persona.name, reason: persona.reason, hype, personaTwo, configSource: persona.configSource };
  diagnostics.evidence = { total: list.length, valid: valid.length, invalid: diagnostics.invalidEvidence.length };
  diagnostics.sections = kept.map((s) => ({
    name: s.name, priority: s.priority, order: presentationOrder(s), chars: s.text.length,
    droppable: s.droppable === true,
    // ★ 2026-10-17：未登记段会被排在安全尾部并原样出站 —— 在终态账里也标出来（可搜可核）。
    //   显式声明过 `layoutOrder` 的（DS 稳定前置段）不算未登记。
    ...(sectionLayoutOf(s.name).unregistered === true && !hasExplicitLayoutOrder(s) ? { unregistered: true } : {}),
  }));
  const keptNames = new Set(kept.map((section) => section.name));
  diagnostics.droppedSections = sections.filter((section) => !keptNames.has(section.name)).map((section) => section.name);

  // ── ★ 2026-10-17（洛版 DS 布局接入 / 百炼复用）：终态账 —— 策略、窗口参数、取回/过滤/注入的
  //   真实条数、降级与预算重画原因。**不写"已启用"就完事**：任何一项看不到就不算接好。
  //   ⚠ 只有调用方**真的传了策略 id** 才加这些键 ⇒ 没传策略的老调用方 diagnostics 形状逐字节不变。
  if (cacheStrategyId) {
    diagnostics.cacheStrategy = {
      id: cacheStrategyId,
      // 策略决定历史锚定与稳定前置段；DS 另拆动态尾并延后旧历史预算压缩。
      //   `anchoredLayoutApplied` = 锚定布局（deepseek/dashscope）本轮是否真的生效；
      //   `dsLayoutApplied` 保留给 DS 的既有消费者（非 DS 的锚定布局不冒用这个键）。
      anchoredLayoutApplied: deepseekPlan?.applied === true,
      ...(deepseekMode ? { dsLayoutApplied: deepseekPlan?.applied === true } : {}),
      reason: anchoredLayoutMode
        ? (deepseekPlan?.applied
          ? (deepseekMode ? 'ds-layout' : 'anchored-layout')
          : `${deepseekMode ? 'ds-layout' : 'anchored-layout'}-skipped:${deepseekPlan?.selected?.reason ?? 'unknown'}`)
        : 'strategy-not-anchored-layout',
    };
    if (deepseekPlan) {
      // 同一个窗口对象：DS 挂 `diagnostics.deepseek`（保留既有消费者），其它锚定策略挂
      // `diagnostics.anchoredLayout`（**不冒名说成 DS**，字段形状一致、strategy 是真实 id）。
      const anchoredWindowDiagnostics = {
        strategy: cacheStrategyId,
        applied: deepseekPlan.applied === true,
        historySource: deepseekPlan.source,
        window: {
          limit: deepseekPlan.limit, chunk: deepseekPlan.chunk, anchor: deepseekPlan.selected?.anchor ?? null,
          anchored: deepseekPlan.selected?.anchored === true,
        },
        // 取回（compose 决定）/ 过滤（上游做，本层看不到被剔掉的行）/ 注入（渲染后真实行数）
        counts: {
          fetchLimit: deepseekPlan.fetchLimit,
          received: deepseekPlan.received,
          prefetchShort: deepseekPlan.prefetchShort === true,
          kept: deepseekPlan.selected?.keptCount ?? 0,
          droppedByAnchor: deepseekPlan.selected?.droppedCount ?? 0,
          visible: deepseekPlan.selected?.visibleCount ?? 0,
          injectedRows: visibleTimeline.length,
          personaHiddenRows: hiddenHistoryRows,
        },
        degraded: deepseekPlan.selected?.degraded === true,
        reason: deepseekPlan.selected?.reason || '',
        newestLocalId: deepseekPlan.selected?.newestLocalId ?? null,
        bypassedSplit: deepseekPlan.bypassedSplit === true,
        // 预算真压过头时哪把刀动过（会移动窗口头 ⇒ 那一刻前缀断；不承诺命中率）
        budgetRedraw: {
          rowCutUsed: diagnostics.historyCold?.rowCutUsed === true,
          charsRedrawn: diagnostics.historyCold?.coldCharsRedrawn === true,
          capBasis: String(diagnostics.historyCold?.capBasis ?? ''),
        },
        note: '输入=上游已过滤升序真消息（本层不复活/不重编号）；锚定算法见 modules/prompt/deepseek-history.js',
      };
      if (deepseekMode) diagnostics.deepseek = anchoredWindowDiagnostics;
      else diagnostics.anchoredLayout = anchoredWindowDiagnostics;
    }
    diagnostics.stablePrefix = anchoredLayoutMode
      ? {
        strategy: cacheStrategyId, placement: 'before-history',
        provided: dsStablePrefixProvided.map((s) => s.name),
        injected: dsStablePrefixAccepted.filter((s) => keptNames.has(s.name)).map((s) => s.name),
        droppedByBudget: dsStablePrefixAccepted.filter((s) => !keptNames.has(s.name)).map((s) => s.name),
        rejected: dsStablePrefixRejected,
        chars: dsStablePrefixAccepted.filter((s) => keptNames.has(s.name))
          .reduce((n, s) => n + s.text.length, 0),
      }
      : {
        strategy: cacheStrategyId, placement: 'none',
        provided: dsStablePrefixProvided.map((s) => s.name),
        injected: [], droppedByBudget: [], rejected: [],
        reason: 'strategy-not-anchored-layout',
      };
    // 给了稳定素材但全没进 user ⇒ 显式告警（"已渲染"不许冒充真注入；compose 侧还有正文标记兜底）。
    if (anchoredLayoutMode && dsStablePrefixProvided.length && diagnostics.stablePrefix.injected.length === 0) {
      diagnostics.warnings.push(`stablePrefixSections 提供后全部未进 user（被预算丢弃或全部被拒）—— 本轮 ${cacheStrategyId} 稳定前缀为空，详见 diagnostics.stablePrefix`);
    }
  }
  diagnostics.messages = messages.length;
  diagnostics.now = nowMs;
  diagnostics.selfId = valid[0]?.selfId ?? null;
  // N61：清洗门 + emotionState 真源凭证，都只在 diagnostics 里记账（不进提示词）
  diagnostics.sanitizeSelfStyle = { enabled: sanitizeSelfStyle !== false };
  diagnostics.emotionState = { present: Boolean(emotionState), persons: emotionPersons };
  // "渲染好的情绪文本"与"M7 状态在不在"不许互相矛盾 —— 矛盾就说明有人造了第二个源
  if (!emotionState) {
    const orphans = [botStateLine ? 'botStateLine' : '', styleHint ? 'styleHint' : '', relationText ? 'relationText' : '']
      .filter(Boolean);
    if (orphans.length) {
      diagnostics.warnings.push(`情绪/关系文本已注入但未收到 M7 emotionState（${orphans.join('、')}）—— 那不是 M7 真源，请查调用方`);
    }
  }
  // 主动轮才加这个键 ⇒ 普通轮的 diagnostics 形状逐字节不变
  if (proactive) diagnostics.proactive = { reason: proactiveReason };

  return { messages, diagnostics };
}

/**
 * 组装并只返回消息数组（便捷出口；要看留痕请用 `buildMessages`）。
 * ⚠ 便捷出口**不豁免**裁剪留痕 —— 留痕在 diagnostics 里，用 buildMessages 取。
 */
export function buildMessagesOnly(p = {}) {
  return buildMessages(p).messages;
}
