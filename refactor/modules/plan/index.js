import { makeActionPlan } from '../../contracts/index.js';
// ★ 2026-10-22：峰期 / 谷期独立回复概率（群聊），纯函数、无状态。
import { resolveGroupReplyPercent } from '../time-profile/index.js';

const HOUR_MS = 60 * 60 * 1000;
// ★ R10（2026-10-18）：机器人提问的"可当回答"时效上限 —— 超过它的问题不再吃裸短词启发式
//   （现场故障：一天前问 A 的问题，被 B 今天回答别人的「好」误判成 BOT_QUESTION_ANSWER）。
const BOT_QUESTION_ANSWER_WINDOW_MS = 30 * 60 * 1000;
const TOPIC_MIN_CONFIDENCE = 0.75;
// M9 margin is top-minus-runner probability gap; the old hard-NO threshold used log(top/runner).
const JEV_WORTH_MIN_CONFIDENCE = 0.75;
const JEV_HARD_NO_MIN_CONFIDENCE = 0.95;
const JEV_HARD_NO_MIN_MARGIN = 3.0;
const TOPIC_STOP_WORDS = new Set([
  '这个', '那个', '我们', '你们', '他们', '现在', '然后', '可以', '怎么', '什么', '一下', '一下子', '事情', '话题',
  '周末', '今天', '明天', '最近', '早上', '下午', '晚上', '计划', '一个', '那个', '你是', '还是', '哪个', '哪里',
  'this', 'that', 'with', 'from', 'have', 'what', 'when', 'where', 'which', 'about', 'your', 'there'
]);

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function reason(code, text) {
  return `${code}: ${text}`;
}

function effectiveValue(cfg, keyPath, options, fallback) {
  try {
    const result = cfg?.effective?.(keyPath, options);
    if (result !== undefined && result !== null) {
      if (typeof result === 'object' && Object.hasOwn(result, 'value')) return result.value;
      return result;
    }
  } catch { /* accessors are injected; missing values use the documented fallback */ }
  try {
    const result = cfg?.get?.(keyPath, fallback);
    if (result !== undefined && result !== null) return result;
  } catch { /* use fallback */ }
  return fallback;
}

function boundedNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function evidenceText(item) {
  return cleanText(item?.text);
}

export function explicitlyChangesTopic(text) {
  return /(?:换个话题|换个问题|换个题|说点别的|聊点别的|先不说这个|暂且不谈|不聊.{0,6}(?:了|吧)?|另外一件事|另一个话题|扯远了|转个话题|先说别的)/i.test(text);
}

function isExplicitQuestion(text) {
  if (/[?？]/.test(text)) return true;
  return /(?:吗|呢|谁|什么|哪里|哪儿|哪个|哪些|多少|几|怎么|如何|为何|为什么|是否|能不能|可不可以|会不会)[^。！!？?]*[。！!]?$/u.test(text);
}

function isPromise(text) {
  return /(?:我(?:会|将|来|去|帮你|给你|替你|记得|稍后|回头|明天)|答应你|我看看|我查一下|我处理一下|晚点(?:给你|告诉你|回复))/u.test(text);
}

function isFollowup(text) {
  return /(?:怎么样|怎么了|后来呢|有结果吗|好了吗|弄好了吗|做好了吗|查到了吗|记得吗|还记得吗|进展|问一下|问问|之前说的|你答应的|你说过)/u.test(text);
}

function isNegativeJevLabel(label) {
  // Keep M8 aligned with M9's role-table polarity labels: not/shift/drop are
  // negative decisions too. The shared polarity vocabulary belongs in contracts in batch 4.
  return /^(?:no|no_speak|quiet|skip|false|negative|not|shift|drop|不说|不回|跳过|否)$/i.test(cleanText(label));
}

function isPositiveJevLabel(label) {
  return /^(?:yes|worth|positive|true|interjectworth|是|值得|接话)$/i.test(cleanText(label));
}

function jevLogOddsMargin(signal, p) {
  const gap = Number(signal?.margin);
  if (!Number.isFinite(gap) || gap < 0 || gap > p || p <= 0) return null;
  const runnerUp = p - gap;
  // Legacy local JEV capped a missing runner-up at 6 rather than producing Infinity.
  if (runnerUp === 0) return 6;
  const value = Math.log(p / runnerUp);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * ★★ N39 · 硬否决的**分布一致性防线**（照老树 `src/local-jev.js:2581-2589` `isHardReplyChanceNo`）。
 *
 * 老树原注释（保留，它是这条规则的来由）：
 *   「小模型的 replyChanceGate 存在稳定的『把可接内容判成 NO』的倾向。
 *     120 条留出样本中，raw NO 有 40/50 实际为 YES；因此 NO 默认是**软否决**，
 *     只有**分布与标签一致**且 p、margin 都极高时才保留硬否决。」
 *
 * ★ 为什么这条不能省（实测复现，`.tmp-dispatch/n39-probe.mjs` 场景 A）：
 *   `label` 是模型**实际说出口的词**，`distTopLabel` 是**概率分布第一名** —— 两者允许不同源
 *   （老树 `src/local-jev.js:1398` 的设计：「答案听 raw、信心看分布」）。
 *   所以存在 `label:'NO'` 但分布其实押 `YES` 的样本 = **典型的误判**。
 *   老树对这种样本**明确不硬否决**，而是放回意愿抽样（用户把该群调到 100% 就照常能接）。
 *   改前的新树只看 label+p+margin ⇒ **把老树专门防的那类误判变成了硬否决**。
 *
 * ★ 语义：`distTopLabel` 缺失时**不拦**（当一致处理）。理由：M9 的 `asSignal()`
 *   （`modules/jev/core.js`）目前**不透传**这两个观测字段 ⇒ 生产上恒缺失。
 *   若按"缺失即不一致"处理，会让硬否决**永远失效**，比现在更糟。
 *   字段一旦透传，本函数自动开始生效 —— **不需要改 jev 模块**（本票 JEV 只读）。
 */
function distributionAgreesWithLabel(signal) {
  const differs = signal?.distDiffers;
  if (differs === true) return false;                       // 明确不一致 ⇒ 不是硬否决
  const top = cleanText(signal?.distTopLabel);
  if (!top) return true;                                     // 字段缺失：不拦（见上）
  return top.toUpperCase() === cleanText(signal?.label).toUpperCase();
}

function topicTokens(value) {
  const text = cleanText(value).toLowerCase();
  const pieces = text.match(/[a-z0-9]{2,}|[\u3400-\u9fff]{2,}/gu) || [];
  const tokens = new Set();
  for (const piece of pieces) {
    if (/^[\u3400-\u9fff]+$/u.test(piece)) {
      if (piece.length === 2 && !TOPIC_STOP_WORDS.has(piece)) tokens.add(piece);
      for (let i = 0; i < piece.length - 1; i += 1) {
        const gram = piece.slice(i, i + 2);
        if (!TOPIC_STOP_WORDS.has(gram)) tokens.add(gram);
      }
    } else {
      tokens.add(piece);
    }
  }
  return tokens;
}

function matchingTopic(evidence, context) {
  const current = topicTokens(evidenceText(evidence));
  if (!current.size) return null;

  const anchors = [];
  if (typeof context?.topic === 'string' && context.topic.trim()) anchors.push(context.topic.trim());
  for (const item of Array.isArray(context?.items) ? context.items : []) {
    const confidence = boundedNumber(item?.confidence, 0, 1, 0);
    if (confidence >= TOPIC_MIN_CONFIDENCE && typeof item?.claim === 'string') anchors.push(item.claim);
  }

  for (const anchor of anchors) {
    const anchorTokens = topicTokens(anchor);
    if ([...current].some((token) => anchorTokens.has(token))) return anchor;
  }
  return null;
}

/**
 * ★★ N39 · 命中关键词 —— **本模块刻意不实现**，理由见 `decide()` 里 `contextTier` 那段注释。
 *   老树第 2 层（`resolveContextTier` 的 `hitKeyword`）已经由
 *   `orchestrator/index.js:537` `matchesTierKeyword` 承担，且那份更严
 *   （单字 CJK 关键词要过边界断言，「玉」不该命中「玉米」）。
 *   这里保留一个同名函数只为把这条边界写进代码，避免下一个人又搬一遍。
 */
function hitsKeyword() {
  return false;
}

function answersBotQuestion(text, botMessage, { directlyReplied = false, allowBare = true, now = 0, senderName = '' } = {}) {
  const question = cleanText(botMessage?.text);
  if (!question || !isExplicitQuestion(question)) return false;
  if (directlyReplied) return true;
  // ★ R10（2026-10-18）：提问要"对得上号"才吃启发式 —— 先查时效（一天前的提问作废），
  //   再查提问对象（机器人明确 @ 了别人），最后才轮到裸短词/词面重合。
  //   时间不可信（缺失/未来/调用方未注入 now）时不拦，保持旧口径。
  const questionAt = Number(botMessage?.at);
  if (Number.isFinite(questionAt) && questionAt > 0 && Number.isFinite(now) && now > 0) {
    if (questionAt > now) return false;
    if (now - questionAt > BOT_QUESTION_ANSWER_WINDOW_MS) return false;
  }
  // 明确引用了别人（非机器人）的消息：不把机器人问题当它的回答对象（尊重显式引用）。
  if (!allowBare) return false;
  // 提问对象：问题里 @ 了别人（当前发言者名字不在其中）⇒ 这条短词不是答给它。
  const mentionNames = question.match(/@[^\s@,，。！!？?；;：:]{1,24}/g);
  if (mentionNames && senderName && !mentionNames.some((mention) => mention.includes(senderName))) return false;

  const answer = topicTokens(text);
  const questionTokens = topicTokens(question);
  if ([...answer].some((token) => questionTokens.has(token))) return true;
  return /^(?:是的?|不是|对|没错|嗯+|好|可以|不行|吃了|还没|没有|不知道|愿意|不愿意|好的?|会|不会|当然)(?:[，。,.!！?？\s]|$)/u.test(cleanText(text));
}

function allBotMessages(evidence) {
  const byId = new Map();
  for (const item of evidence) {
    for (const message of Array.isArray(item?.botSaidBefore) ? item.botSaidBefore : []) {
      if (!message || typeof message !== 'object') continue;
      const key = message.id == null ? String(message.at) : String(message.id);
      if (!byId.has(key)) byId.set(key, message);
    }
  }
  return [...byId.values()].sort((a, b) => Number(a.at) - Number(b.at));
}

// ── 「每次被 @ 额外 +5 条配额」（2026-10-29 她定的）──
// 记每个会话「被点名」的时间戳：只数入站里 toSelf（@ 我 / 引用我），按消息 id 去重
//（同一条消息会跨轮被再看到一次，不去重会越滚越多，最后等于没有上限）。
// 只活在本进程内存里：重启就清零 —— 宁可少给几次加成，也不要跨重启留一份说不清的账。
const MENTION_LOG = new Map(); // chatKey -> { seen:Set, ts:number[] }
function noteMention(chatKey, item, nowValue) {
  const key = String(chatKey || '');
  if (!key) return;
  const mentioned = item?.toSelf === true || item?.refs?.toSelf === true;
  if (!mentioned) return;
  let box = MENTION_LOG.get(key);
  if (!box) { box = { seen: new Set(), ts: [] }; MENTION_LOG.set(key, box); }
  const id = item?.id ?? item?.mid ?? item?.messageId;
  const dedupKey = id == null ? `at:${item?.at ?? nowValue}` : String(id);
  if (box.seen.has(dedupKey)) return;
  box.seen.add(dedupKey);
  box.ts.push(boundedNumber(item?.at ?? nowValue, 0, Number.MAX_SAFE_INTEGER, nowValue));
}
/** 窗口内被 @ 了几次（顺手把过期的剔掉）。 */
function countMentions(chatKey, nowValue, windowMs) {
  const box = MENTION_LOG.get(String(chatKey || ''));
  if (!box) return 0;
  const floor = nowValue - windowMs;
  box.ts = box.ts.filter((t) => t > floor);
  return box.ts.length;
}
/**
 * 在 decide 的**早返回之前**把被点名的消息记下来。
 * ★ 为什么不放在自由插话分支里：被 @ 的那一轮走 DIRECT_MENTION 直接 return，
 *   配额那一段根本到不了 —— 自测里"8 条 + 被 @ 一次"仍被挡，就是踩的这个。
 */
function rememberMentions(cfg, rows, nowValue) {
  const table = effectiveValue(cfg, 'localJev.replyChance.windowCap', { chatKey: '', kind: 'group' }, null);
  if (!table || typeof table !== 'object') return;
  for (const item of Array.isArray(rows) ? rows : []) {
    const key = cleanText(item?.chatKey);
    if (!key) continue;
    const cap = table[key];
    if (!cap || boundedNumber(cap.atBonus, 0, 1000, 0) <= 0) continue;
    noteMention(key, item, nowValue);
  }
}

function makePlan(action, code, message, evidence, context, overrides = {}) {
  const current = evidence[evidence.length - 1];
  const recipient = current?.sender?.id == null
    ? String(current?.chatKey || 'unknown')
    : String(current.sender.id);
  const refs = [];
  for (const item of Array.isArray(context?.items) ? context.items : []) {
    for (const id of Array.isArray(item?.evidenceIds) ? item.evidenceIds : []) {
      if (typeof id === 'string' && id && !refs.includes(id)) refs.push(id);
    }
  }
  const content = evidence.map(evidenceText).filter(Boolean).join(' ').trim();
  const topic = cleanText(overrides.topic) || cleanText(context?.topic) || content.slice(0, 80) || '当前消息';
  const responsePolicy = overrides.responsePolicy
    ?? (['skip', 'wait'].includes(action) ? 'none' : 'required');
  return makeActionPlan({
    action,
    reason: reason(code, message),
    recipient,
    topic: topic.slice(0, 120),
    purpose: overrides.purpose || (action === 'continue' ? '延续当前对话' : action === 'skip' ? '暂不主动插话' : '回应当前消息'),
    memoryRefs: refs.slice(0, 12),
    toolPlan: [],
    responsePolicy,
    requiredOutputs: overrides.requiredOutputs ?? (responsePolicy === 'required' ? ['text'] : []),
    urgency: overrides.urgency ?? (action === 'reply' ? 1 : action === 'continue' ? 0.7 : action === 'skip' ? 0 : 0.2),
    by: 'rule'
  });
}

/**
 * Stage C: make exactly one reply/continue/wait/skip decision.
 * Mandatory replies and confirmed topic follow-ups return before free-insertion
 * policy is consulted. Jev is only a probabilistic candidate signal here.
 */
export function decide({ evidence = [], context = {}, relation, cfg, jevSignal = null, now = 0, rand = 0.5, proactive = false, proactiveReason = '', chatKey: proactiveChatKey = '', kind: proactiveKind = '', judge = null, judgeMode = false, replyMode = 'jev', keywordCandidate = false, randomCandidate = false, randomMissed = false, fullCandidate = false, focus = null, topicState } = {}) {
  const rows = Array.isArray(evidence) ? evidence.filter((item) => item && typeof item === 'object') : [];
  const nowValue = boundedNumber(now, 0, Number.MAX_SAFE_INTEGER, 0);
  // 「每次被 @ 额外 +5 条」：**在早返回之前**记一笔（被 @ 的那轮会走 DIRECT_MENTION 直接返回）。
  try { rememberMentions(cfg, rows, nowValue); } catch { /* 记不上就不加，不加顶多少说一句 */ }
  if (!rows.length) {
    // T-G21 主动轮：**没有新消息是正常输入**，不是"没有证据所以跳过"。
    // 旧树对应 `src/orchestrator.js:2957-2969`（【本次唤醒】尾巴）—— 主动轮由模型自己决定开不开口；
    // 规则层若在这里回 NO_EVIDENCE，整条主动链就是**静默停摆**（正是 G21 票面 §0 的原始故障）。
    // 严格边界：这里只决定"该不该开口"，证据仍然为空（M15 的 wake 绝不合成假消息）。
    if (proactive === true) {
      const code = proactiveReason === 'schedule' ? 'PROACTIVE_SCHEDULE'
        : proactiveReason === 'random' ? 'PROACTIVE_RANDOM' : 'PROACTIVE_OPPORTUNITY';
      const target = cleanText(proactiveChatKey);
      return makePlan('reply', code, '主动轮：没有新消息，由模型决定是否开口', [{ chatKey: target, kind: proactiveKind === 'private' ? 'private' : 'group' }], context, {
        purpose: proactiveReason === 'schedule' ? '按约定时间主动联系' : '找机会自然开口',
        responsePolicy: 'optional', requiredOutputs: []
      });
    }
    return makePlan('skip', 'NO_EVIDENCE', '没有可处理的消息证据', [{}], context);
  }

  // relation belongs to M7. Keeping the value opaque prevents plan policy from
  // coupling to an emotion implementation while preserving the pass-through API.
  void relation;
  const current = rows[rows.length - 1];
  const text = evidenceText(current);
  const kind = current.kind === 'private' ? 'private' : 'group';
  const chatKey = cleanText(current.chatKey);
  const cfgScope = { chatKey, kind };
  const botMessages = allBotMessages(rows);
  const replyTo = current?.refs?.replyTo == null ? '' : String(current.refs.replyTo);
  const repliedBotMessage = replyTo ? botMessages.find((message) => String(message.id) === replyTo) : null;
  // ★ R10（2026-10-18）：明确引用了别人（引用的 id 不是机器人消息）⇒ 尊重这个引用，
  //   不再拿"机器人最近一个问题"做裸短词启发式（现场：B 引用 C 的话答"好"，被算成回答机器人）。
  const repliedOtherMessage = Boolean(replyTo) && !repliedBotMessage;
  const mostRecentBotMessage = botMessages[botMessages.length - 1];
  const directlyMentioned = rows.some((item) => item?.toSelf === true || item?.refs?.toSelf === true
    || (Array.isArray(item?.mentions) && item.mentions.some((mention) => mention?.isSelf === true)));
  const topicSwitch = explicitlyChangesTopic(text);
  const senderName = cleanText(current?.sender?.name);
  const botAsked = !topicSwitch && (repliedBotMessage
    ? answersBotQuestion(text, repliedBotMessage, { directlyReplied: true, now })
    : (repliedOtherMessage
      ? false
      : answersBotQuestion(text, mostRecentBotMessage, { now, senderName })));
  const promiseFollowup = !topicSwitch && botMessages.some((message) => isPromise(cleanText(message.text))) && isFollowup(text);

  // Required-response layer: these paths do not consult intent, Jev, cooldown,
  // quota, or randomness.
  if (kind === 'private') return makePlan('reply', 'PRIVATE_RULE', '私聊按直接响应规则处理', rows, context, { purpose: '回应私聊消息' });
  if (directlyMentioned) return makePlan('reply', 'DIRECT_MENTION', '消息明确点名机器人', rows, context, { purpose: '回应对机器人的点名' });
  if (promiseFollowup) return makePlan('continue', 'PROMISE_FOLLOWUP', '用户追问机器人尚未完成的承诺', rows, context, { purpose: '继续处理未完成承诺' });
  if (botAsked) return makePlan('continue', 'BOT_QUESTION_ANSWER', '用户正在回答机器人上一轮的问题', rows, context, { purpose: '继续上一轮问答' });

  // ══ 聚焦窗口（用户 2026-10-12 补充规格；状态机 plan/focus.js，窗口开关由接线层管）══
  // 规则要点：必回 = 不走抽样闸，但云端判定仍可终止（continue=no=这件事已过去 → 提前退出）；
  // mention 窗口只回 @ 它的那个人（反面对照：窗口内别人的消息不回）；
  // keyword 窗口 1 分钟、判严（join 才是"与角色相关吗"的闸）、话题转移（continue=no）立刻截止。
  // 本块在"必需响应层"之后、通用云判定块之前 —— 聚焦在场时优位于"无候选跳过"的通用规则。
  // focus 未传/未激活（focus.active=false）时本块不进入，通用路径原样。
  // ★ 2026-10-16（C10）：`kind='followup'`（发言后 20 秒接话聚焦）**不进本块** —— 它没有单一 target、
  //   参与者都可接，由下面那块处理（否则会先被这里判成 FOCUS_NOT_TARGET）。
  if (judgeMode && focus && focus.active && focus.kind !== 'followup') {
    const j = judge && typeof judge === 'object' ? judge : null;
    if (!j) return makePlan('skip', 'JUDGE_NOT_CALLED', '聚焦窗口：本批没有可用的云判定结果', rows, context);
    if (j.status !== 'accepted' && j.status !== 'low-confidence') {
      return makePlan('skip', 'JUDGE_UNAVAILABLE', `聚焦窗口：云判定未完成（${String(j.reason || j.status).slice(0, 60)}）`, rows, context);
    }
    // ★ 只回窗口发起人（裁定 2026-10-12）：mention = @ 它的那个人；keyword = 触发关键词的发起人。
    //   窗口内其他人的普通消息即便判定通过也不回（FOCUS_NOT_TARGET 是专门的反面对照）。
    //   注：**别人直接 @ 机器人**走的是必需响应层 `DIRECT_MENTION`（本函数上方），在本块之前放行，不受此闸影响。
    if (String(current.sender?.id ?? '') !== String(focus.target ?? '')) {
      return makePlan('skip', 'FOCUS_NOT_TARGET',
        focus.kind === 'keyword' ? '关键词聚焦：只回发起人' : '聚焦窗口：只回 @ 它的那个人', rows, context);
    }
    if (focus.kind === 'mention') {
      // 必回不走抽样：以 continue 判"这件事过去了没有"（yes/na=还在 → 回；unknown=未判成 → 不自动发言）。
      if (j.continue === 'no') return makePlan('skip', 'FOCUS_TOPIC_PASSED', '聚焦窗口：云判定这件事已过去，提前退出', rows, context);
      if (j.continue === 'unknown') return makePlan('skip', 'FOCUS_JUDGE_UNKNOWN', '聚焦窗口：判定未完成，不自动发言', rows, context);
      return makePlan('reply', 'FOCUS_MENTION_MUST_REPLY', '聚焦窗口：@ 触发必回，云判定未判定结束', rows, context, {
        purpose: '回应窗口内的 @', responsePolicy: 'required', requiredOutputs: ['text']
      });
    }
    // kind === 'keyword'：1 分钟窗口、判定更严
    if (j.continue === 'no') return makePlan('skip', 'FOCUS_MOVED', '关键词聚焦：话题已转移，窗口立刻截止', rows, context);
    if (j.join === 'yes') return makePlan('reply', 'FOCUS_KEYWORD_MUST_REPLY', '关键词聚焦：与角色相关且判定通过，必回不抽样', rows, context, {
      purpose: '回应关键词聚焦', responsePolicy: 'optional', requiredOutputs: []
    });
    if (j.join === 'no') return makePlan('skip', 'FOCUS_NOT_RELEVANT', '关键词聚焦：与角色无关，不回', rows, context);
    return makePlan('skip', 'FOCUS_JUDGE_UNKNOWN', '关键词聚焦：判定未完成，不自动发言', rows, context);
  }

  // ══ 接话聚焦（用户 2026-10-16 C10）：发言后 20 秒、按发言人分批判定 ══
  // 位置：在 mention/keyword 聚焦块**之后**、云 JEV 通用块**之前** —— 新语义"置于旧窗之上"：
  //   · **直接 @ 仍走最上面的必需响应层**（`:259` DIRECT_MENTION，required）—— 发言资格不受本块影响，
  //     也不需要云判定（免判的跳过点在 orchestrator：`addressed === true` 时不调 judgeOnce）；
  //   · followup 窗内**参与者都可接**（不像旧窗只回 `focus.target`）；
  //   · 判定命中（`join === 'yes'`）⇒ 接一次；未命中/未判定 ⇒ 不打搅（skip），由调用方按批次继续。
  // 接线约定（orchestrator，见回执）：`focus.kind === 'followup'`、`focus.participants = [本窗参与者…]`
  //   （至少含 `current.sender.id`），`judge` 用既有 judgeOnce 结果结构（status / join / continue）；
  //   窗口开关、批次、唤醒、串行都在 orchestrator —— 本模块只负责"谁有资格 + 判中接不接"。
  // ★ 2026-10-16（联调核对）：本块**不**加 `judgeMode` 门 —— `kind==='followup'` 是编排显式传进来的意图，
  //   必须由本块**确定性**接住：否则 judgeMode=off 时会落到下面的通用/旧路径，把 legacy 的 'reply'/'continue'
  //   记成 followup 的 YES（假判中）。这里拿不到 judge 时回 `JUDGE_NOT_CALLED`（⇒ 编排侧记 SKIP），语义自洽。
  // ★ 2026-10-18（R05）：窗口已关闭/过期（编排仍把批次送进来）⇒ 确定性收手，不许落到通用路径乱回。
  if (focus && focus.kind === 'followup' && focus.active !== true) {
    return makePlan('skip', 'FOLLOWUP_WINDOW_CLOSED', '接话聚焦：窗口已关闭/过期，本批不接', rows, context);
  }
  if (focus && focus.active && focus.kind === 'followup') {
    const j = judge && typeof judge === 'object' ? judge : null;
    const participants = Array.isArray(focus.participants)
      ? focus.participants.map((value) => String(value ?? '')).filter(Boolean) : [];
    const senderId = String(current.sender?.id ?? '');
    if (participants.length && !participants.includes(senderId)) {
      return makePlan('skip', 'FOCUS_NOT_PARTICIPANT', '接话聚焦：发送者不在本窗参与者内（按发言人隔离判定）', rows, context);
    }
    // ★ 2026-10-18（R01/R05）：裁判总闸关闭时，接话聚焦**不偷偷调云** —— 按窗口内、本窗参与者的
    //   本地资格接一句（对象 = 本窗参与者，时效 = 20 秒窗由状态机保证；关窗批次上面已收手）。
    if (judgeMode !== true) {
      return makePlan('reply', 'FOLLOWUP_LOCAL', '接话聚焦：裁判总闸关闭，按窗口本地资格接话', rows, context, {
        purpose: '接住窗口内的接话', responsePolicy: 'optional', requiredOutputs: []
      });
    }
    if (!j) return makePlan('skip', 'JUDGE_NOT_CALLED', '接话聚焦：本批没有可用的云判定结果', rows, context);
    if (j.status !== 'accepted' && j.status !== 'low-confidence') {
      return makePlan('skip', 'JUDGE_UNAVAILABLE', `接话聚焦：云判定未完成（${String(j.reason || j.status).slice(0, 60)}）`, rows, context);
    }
    if (j.join === 'yes') {
      return makePlan('reply', 'FOLLOWUP_JOIN', '接话聚焦：判中，接一句', rows, context, {
        purpose: '接话聚焦内接一句话', responsePolicy: 'optional', requiredOutputs: []
      });
    }
    if (j.join === 'no') return makePlan('skip', 'FOLLOWUP_NOT_WORTH', '接话聚焦：这条不值得接，继续等', rows, context);
    return makePlan('skip', 'FOLLOWUP_JUDGE_UNKNOWN', '接话聚焦：判定未完成，不自动发言', rows, context);
  }

  // ══ 云 JEV 新模式（指导 §8.1 的四条最终规则；本块是**唯一决定点**）══════════
  // 前置边界：上面"必需响应层"（私聊/点名/承诺追问/回答机器人提问）已按规则 1 先行返回；
  // 本块在场时，旧 TOPIC_FOLLOW 提前返回与宽泛 DIRECT_QUESTION、以及下方自由插话的概率抽样
  // （randomPercent / 意愿阈值 / 冷却 / 小时上限）**一律不执行** —— 规则 2/3 用结构化判定结果直接裁。
  // judgeMode=false（未启用新模式的群）时本块不进入，旧路径逐字保持原样。
  // 失败语义（§8.3）：技术未判定（timeout/error/unavailable/invalid）→ 不发言、不回落旧概率。
  // ★ 2026-10-17（用户裁定：逐群「云裁判 / 随机回复」）：`replyMode === 'random'` 时本块**不进入** ——
  //   自由接话改走下面旧路径（按 `store.randomPercent` 抽一次 + 冷却/每小时上限），且编排层已确认
  //   不会为本批请求云判定。显式 jev 仍走本块（裁判不可用 ⇒ JUDGE_UNAVAILABLE，绝不静默改成随机）。
  if (judgeMode && replyMode !== 'random') {
    const j = judge && typeof judge === 'object' ? judge : null;
    if (!j) {
      // ★ 2026-10-16（用户口径 · 第 3 档先随机再 JEV）：tier-3 批次**抽中才请求云判定**；
      //   未抽中不是"判定没发生"，而是明确的准入收手 —— 独立 reason，不与 JUDGE_NOT_CALLED 混。
      if (randomMissed === true) {
        return makePlan('skip', 'JUDGE_RANDOM_MISS', '第 3 档回复概率未抽中：本批不请求云判定', rows, context);
      }
      return makePlan('skip', 'JUDGE_NOT_CALLED', '新模式：本批没有可用的云判定结果', rows, context);
    }
    if (j.status !== 'accepted' && j.status !== 'low-confidence') {
      return makePlan('skip', 'JUDGE_UNAVAILABLE', `云判定未完成（${String(j.reason || j.status).slice(0, 60)}）`, rows, context);
    }
    const hasManagedTopicState = topicState && typeof topicState === 'object';
    const registeredTopicActive = hasManagedTopicState && topicState.active === true;
    // When the orchestrator supplies the registry state, it is authoritative. A stale
    // memory match must not resurrect a topic that expired, ended, or was never opened.
    const activeTopic = !topicSwitch && (registeredTopicActive
      || (!hasManagedTopicState && (Boolean(repliedBotMessage) || Boolean(matchingTopic(current, context)))));
    if (activeTopic) {
      // 规则 2：有活动话题只看 continue；本批即使 join=yes 也不绕过续聊否决。
      if (j.continue === 'yes') {
        return makePlan('continue', 'JUDGE_CONTINUE', '云判定：焦点延续已参与话题', rows, context, {
          purpose: '延续已参与的话题',
          topic: cleanText(repliedBotMessage?.text || matchingTopic(current, context) || '').slice(0, 80),
          responsePolicy: 'optional', requiredOutputs: []
        });
      }
      if (j.continue === 'no') return makePlan('skip', 'JUDGE_TOPIC_CHANGED', '云判定：话题已切换或不再延续', rows, context);
      if (j.continue === 'na') return makePlan('skip', 'JUDGE_TOPIC_NA', '云判定：无活动话题（与本地话题状态冲突，按不放行处理）', rows, context);
      return makePlan('skip', 'JUDGE_CONTINUE_UNKNOWN', '云判定：续聊不确定，不自动发言', rows, context);
    }
    // 规则 3：无活动话题 —— 关键词/兴趣候选**或第 3 档随机抽中**且 join=yes 才放行；其余跳过。
    // ★ 2026-10-16：随机抽中的批次此前落到 JUDGE_NO_CANDIDATE（"非关键词候选"）被误杀 ——
    //   抽中是准入层给出的候选资格（orchestrator 已按其抽中才请求云判定），这里同一口径接住。
    if (keywordCandidate || randomCandidate) {
      if (j.join === 'yes') {
        return makePlan('reply', 'JUDGE_JOIN', '云判定：关键词/兴趣候选可以接话', rows, context, {
          purpose: '加入当前话题', responsePolicy: 'optional', requiredOutputs: []
        });
      }
      if (j.join === 'no') return makePlan('skip', 'JUDGE_JOIN_NO', '云判定：关键词误触发，不接话', rows, context);
      return makePlan('skip', 'JUDGE_JOIN_UNKNOWN', '云判定：接话不确定，不自动发言', rows, context);
    }
    // 规则 3 后半：完全没有候选（非明确对话）—— 不进入主回复（调用方本应连判定都省略，这里是兜底）。
    return makePlan('skip', 'JUDGE_NO_CANDIDATE', '新模式：无关键词/话题候选，不进入主回复', rows, context);
  }

  if (!topicSwitch) {
    const topic = matchingTopic(current, context);
    const repliesToBot = Boolean(repliedBotMessage);
    if (repliesToBot || topic) {
      return makePlan('continue', 'TOPIC_FOLLOW', '场景证据显示消息延续已加入的话题', rows, context, {
        purpose: '延续已加入的话题',
        topic: topic || cleanText(repliedBotMessage?.text).slice(0, 80),
        responsePolicy: repliesToBot ? 'required' : 'optional',
        requiredOutputs: repliesToBot ? ['text'] : []
      });
    }
  }
  if (isExplicitQuestion(text)) return makePlan('reply', 'DIRECT_QUESTION', '消息包含明确提问', rows, context, {
    purpose: '回答明确问题', responsePolicy: 'required', requiredOutputs: ['text']
  });
  // ★ 2026-10-18（R03 · 统一合同「显式@/引用机器人/关键词不受普通插话概率误拦」）：
  //   关键词资格已由档位门给出（tier≥2 放行，编排侧转交 keywordCandidate）——这里不得再被
  //   自由插话的概率抽样/冷却/上限重复筛掉（关云裁判后这条几乎必被随机值判成 INTENT_ZERO 静默不回）。
  if (keywordCandidate === true) {
    return makePlan('reply', 'KEYWORD_WAKE', '关键词/兴趣触发：按触发资格直接回应，不再走普通插话概率', rows, context, {
      purpose: '回应关键词/兴趣触发', urgency: 0.2, responsePolicy: 'optional', requiredOutputs: []
    });
  }

  // ★★ 关于 `contextTier` 档位闸：**本模块故意不做**，老树 `resolveContextTier` 的那一层已经搬了，
  //   而且搬得更完整（`orchestrator/index.js:551` `contextTierGate`）：它在 plan **之前**跑，
  //   4 档逐档一致（1=叫到才应 / 2=+关键词 / 3=+抽样 / 4=全应），还多做了单字 CJK 关键词的
  //   边界处理（`matchesTierKeyword:543`，避免「玉」命中「玉米」）。
  //   ★ 我一度在这里重写了一遍，读到 orchestrator 那份后已撤掉 ——
  //     **两处都判同一个键会变成"双重闸"**，tier=2 的群可能被自己 veto 掉，且两份口径迟早漂移。
  //   本模块只保留与档位无关的判定（点名/私聊/承诺追问/问答延续/话题延续/明确提问）。

  // Free-interjection layer: hard negative Jev signals veto; a strong positive
  // can clear a zero-intent decision. All other cases use intent as the sampling rate.
  const intentRaw = effectiveValue(cfg, 'store.randomPercent', cfgScope,
    effectiveValue(cfg, 'randomPercent', cfgScope, 0));
  let intent = boundedNumber(intentRaw, 0, 100, 0);
  // ★ 2026-10-22（她要的「群内峰期谷期独立回复概率」）：群聊的意愿按时段覆写，
  //   `store.timeProfile.enabled !== true` 时返回 null ⇒ 沿用上面的滑条派生值。
  //   私聊（kind='private'）不经过这里，保持 privateOverride 那套。
  if (cfgScope?.kind !== 'private' && !String(cfgScope?.chatKey || '').startsWith('private:')) {
    try {
      const prof = resolveGroupReplyPercent(
        (path, fallback) => effectiveValue(cfg, path, cfgScope, fallback),
        cfgScope?.chatKey,
      );
      if (prof) intent = prof.percent;
    } catch { /* 读不到就按原值走 */ }
  }

  const jev = jevSignal?.from === 'jev' ? jevSignal : null;
  const jevConfidence = boundedNumber(jev?.p, 0, 1, 0);
  const jevMargin = jev ? jevLogOddsMargin(jev, jevConfidence) : null;
  // ★★ N39：硬否决必须**分布与标签一致**（照老树 `isHardReplyChanceNo` 的第二道闸）。
  //   改前只看 label+p+margin ⇒ 模型"说 NO 但分布押 YES"这类误判被当成硬否决，
  //   用户把该群意愿调到 100% 也接不上话。老树对这类样本明确走意愿抽样。
  const hardNegative = Boolean(jev && isNegativeJevLabel(jev.label)
    && jevConfidence >= JEV_HARD_NO_MIN_CONFIDENCE
    && jevMargin !== null && jevMargin >= JEV_HARD_NO_MIN_MARGIN
    && distributionAgreesWithLabel(jev));
  const strongPositive = Boolean(jev && isPositiveJevLabel(jev.label)
    && jevConfidence >= JEV_WORTH_MIN_CONFIDENCE);
  if (hardNegative) return makePlan('skip', 'JEV_CANDIDATE_LOW', '高置信 Jev 负向信号否决自由插话', rows, context);

  const positiveZeroIntentOverride = intent <= 0 && strongPositive;
  // ★ 2026-10-18（#10 决策链）：第 4 档（档位门给的 `fullCandidate`）就是**全量候选** ——
  //   “任何消息都响应”不该再被普通插话概率（randomPercent 抽样）二次筛掉。
  //   冷却 / 每小时上限仍保留（防刷屏），其余候选照旧走下面的概率抽样。
  const fullCandidateReply = fullCandidate === true;
  if (intent <= 0 && !positiveZeroIntentOverride && !fullCandidateReply) {
    return makePlan('skip', 'INTENT_ZERO', '当前会话的自由插话意愿为 0', rows, context);
  }

  const history = botMessages.filter((message) => Number.isFinite(Number(message.at)) && Number(message.at) <= nowValue);
  const latestAt = history.reduce((latest, message) => Math.max(latest, Number(message.at)), 0);

  // ★ 2026-10-29（她：200000001 改成「8 条/5 分钟、冷却 15 秒，每次被 @ 额外 +5 条」）：按会话的配额窗口。
  //   为什么另开一张表：`localJev.*` **没有会话级覆盖**（scope.js 只给 `store.*` 开这一层，
  //   注释里写着「不许凭空给别的键加一层」），perChat 写不进频率限制。
  //   形状：localJev.replyChance.windowCap = {
  //     "group:200000001": { minutes: 5, max: 8, atBonus: 5, cooldownMs: 15000 }
  //   }
  //   缺省（没这张表 / 没这个会话）时行为与改前逐字一致：60 分钟窗口 + maxPerHour + 全局冷却。
  const windowCapTable = effectiveValue(cfg, 'localJev.replyChance.windowCap', cfgScope, null);
  const windowCap = windowCapTable && typeof windowCapTable === 'object'
    ? windowCapTable[String(cfgScope?.chatKey || '')] : null;
  const maxPerHour = Math.max(0, Number(effectiveValue(cfg, 'localJev.replyChance.maxPerHour', cfgScope, 100)) || 0);
  // ★ 2026-10-29 20:5x（她：200000001「4 条/30 秒、冷却 10 秒」）：窗口下探到秒级。
  //   有 `seconds` 就用它（1 秒起），否则用 `minutes`（下限从 1 分钟放宽到 0.05 分钟 = 3 秒）。
  //   为什么不是只放宽 minutes：0.5 分钟写进配置谁都看得懂，但也容易被人当成「半小时」扫过去。
  const capSeconds = windowCap && windowCap.seconds !== undefined
    ? boundedNumber(windowCap.seconds, 1, 24 * 3600, null)
    : null;
  const capMinutes = boundedNumber(windowCap?.minutes, 0.05, 24 * 60, HOUR_MS / 60000);
  const capLimitBase = windowCap && windowCap.max !== undefined
    ? boundedNumber(windowCap.max, 0, 10000, maxPerHour)
    : maxPerHour;
  const capWindowMs = capSeconds !== null ? capSeconds * 1000 : capMinutes * 60 * 1000;
  const capWindowText = capSeconds !== null ? `${capSeconds} 秒` : `${capMinutes} 分钟`;

  const cooldownMs = Math.max(0, Number(effectiveValue(cfg, 'localJev.replyChance.cooldownMs', cfgScope, 5000)) || 0);
  const capCooldownMs = windowCap && windowCap.cooldownMs !== undefined
    ? boundedNumber(windowCap.cooldownMs, 0, 6 * 60 * 1000, cooldownMs)
    : cooldownMs;
  if (capCooldownMs > 0 && latestAt > 0 && nowValue - latestAt < capCooldownMs) {
    return makePlan('skip', 'HARD_COOLDOWN', '自由插话仍处于配置的冷却期', rows, context);
  }

  // 「每次被 @ 额外 +5 条」：窗口内每被点名一次，配额就加 atBonus（默认 0 = 关）。
  // 计数只数**入站**里 toSelf 的（@ 我 / 引用我），按消息 id 去重——同一条消息跨轮会被再次看到。
  const atBonus = windowCap ? boundedNumber(windowCap.atBonus, 0, 1000, 0) : 0;
  let capLimit = capLimitBase;
  if (atBonus > 0) {
    capLimit += atBonus * countMentions(cfgScope?.chatKey, nowValue, capWindowMs);
  }

  const recentSends = history.filter((message) => Number(message.at) > nowValue - capWindowMs).length;
  if (recentSends >= capLimit) {
    return makePlan('skip', 'HARD_HOURLY_CAP',
      `自由插话已达到配置的配额上限（${recentSends}/${capLimit} 条 / ${capWindowText}）`, rows, context);
  }

  if (!positiveZeroIntentOverride && !fullCandidateReply) {
    const candidateThreshold = intent / 100;
    const randomValue = boundedNumber(typeof rand === 'function' ? rand() : rand, 0, 1, 0.5);
    if (randomValue >= candidateThreshold) {
      return makePlan('skip', 'INTENT_MISS', '自由插话候选未达到当前意愿阈值', rows, context);
    }
  }
  return makePlan('reply', topicSwitch ? 'FREE_TOPIC_SWITCH' : 'FREE_INTERJECTION',
    positiveZeroIntentOverride
      ? '高置信 Jev 正向信号在意愿为 0 时放行'
      : topicSwitch ? '明确换题后按自由插话规则响应' : '自由插话意愿通过抽样', rows, context, {
      purpose: topicSwitch ? '回应新话题' : '加入当前群聊',
      urgency: 0.2,
      responsePolicy: 'optional', requiredOutputs: []
    });
}

// ── J3 活动话题状态机（指导 §8.2；状态由 orchestrator 持有，本模块提供实现）──
// 经 index 出口导出：依赖规则要求模块之间只 import 对方的 index.js。
export { createTopicRegistry, DEFAULT_TOPIC_IDLE_MS } from './topic.js';
// ── 聚焦窗口状态机（用户 2026-10-12 补充；mention 5min / keyword 1min，开闭时机归接线层）──
export { createFocusRegistry, MENTION_WINDOW_MS, KEYWORD_WINDOW_MS } from './focus.js';
// ★ 2026-10-16（C10）：接话聚焦（发言后 20 秒 / 按发言人短批次 / 连续 5 条实际 NO 关窗）的独立状态机。
export { createFollowupRegistry, FOLLOWUP_WINDOW_MS, FOLLOWUP_BATCH_MS, FOLLOWUP_NO_LIMIT, FOLLOWUP_MAX_MESSAGES_PER_BATCH } from './followup.js';
