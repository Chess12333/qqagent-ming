/**
 * M7 emotion · 模型自评（finish 的 mood / favorDelta）→ 状态变化
 *
 * ★ 为什么有这份（2026-10-11 · 指挥位派单 · glm 只读审计第 2 条）：
 *   老树有一条「独立自评轮 → mood/favorDelta」通道：`finish` 工具收尾时模型可标 mood
 *   （29 选 1~2）与 favorDelta（±8），`orchestrator.js:4543` 的 `applyRunToBotState` 把它们
 *   折算成情绪/心情/好感变化（`src/bot-state.js:650-775` 的逐 kind 数值表 + `:1152-1155`
 *   的"favorDelta 正负 ⇒ mood+4/-3"）。新树把这条**整条丢了**（act/executors/messaging.js
 *   的 finish 自述"mood/favorDelta 无消费方"）⇒ glm 审计读数：ledger 200 行里
 *   source=emotion-evidence 仅 4 行、189 行 event 里 101 行 delta=0、无 self.mood 行
 *   ⇒ **用户说的话几乎推不动情绪**。本文件 + M15 的消费方把这条通道照老树语义接回来。
 *
 * ★ 口径（逐条对照老树，不发明）：
 *   · `parseMoodKinds` = 老树 `parseEmotionTags`（src/bot-state.js:817-845，14 个精确标签，
 *     上限 3；"无事发生/无事/没事/平静/正常聊天" → 空）。finish 枚举里其余标签
 *     （真生气/分享/吐槽/刷屏/…）老树也映射不到 kind —— **同样不映射**。
 *   · `normalizeSelfEvalMood` = 老树 `finish.execute`（src/tools.js:3421-3466）的归一：
 *     summary 极明确被夸/被怼补档 → 空转档时按 summary 关键词抠具体档 → 被怼/被夸 优先 →
 *     上限 2 项 → "闲聊"轮去掉接梗。
 *   · `MOOD_KIND_DELTAS` = 老树 `appraiseAndAct` 逐 kind 表（src/bot-state.js:650-775）
 *     **原始档位量**，桶名用新树 AFFECT 的老树 14 键（新树 16 键含全部老树键，见
 *     state.js:31-36）⇒ 无需合并桶。三处**有意不搬**（都在注释里标明）：
 *       ① `pickOneAdd` 的随机第三维（Math.random 抽样，新树纯函数不许随机）；
 *       ② `toolFail`/`error` 两档（新树有自己的 `toolResult` 事件通路，act/apply.js:295）；
 *       ③ 老树的人格档缩放（gain/softCeil/ramp/closenessBoost/POS soften）—— 数值量照搬，
 *          缩放交给新 M7 自己的 ramp/half-life 归一（apply.js:270-293）。
 *   · `favorSignMoodDelta` = 老树 `applyRunToBotState:1152-1155`：favorDelta 非零时
 *     **只看正负**：>0 ⇒ mood+4，<0 ⇒ mood-3；0/缺失 ⇒ 不动。
 *
 * ★ 2026-10-11 补（指挥位派单 · pickOneAdd 随机第三维）：老树 `appraiseAndAct` 对被夸/玩闹
 *   还会 `pickOneAdd` 一维（`src/bot-state.js:633-648`，按权重抽 pride/gratitude/smug 或
 *   cheer/joy/curiosity）。搬的时候**有意没搬**（Math.random 抽样与纯函数冲突）。现在照老树
 *   数值接回，但**随机源从外部注入**：`selfEvalDeltas(kinds, { random })`；
 *   - `random` 是函数 ⇒ 按老树权重表抽样（第三维启用）；
 *   - `random` 没注入 ⇒ **不启用第三维**（只走确定性主维度）—— 有意为之：没接线时不静默
 *     改变生产行为；要真随机由调用方（装配/编排层）注入，测试注入固定序列即可复现。
 *     （函数本身保持纯：同 kinds + 同 random 输出必相同。）
 *
 * ★ 纯函数：不读时钟、不碰盘、无 import（连 contracts 都不需要）。
 */

/** 老树 parseEmotionTags 的 14 个精确标签（src/bot-state.js:822-837，逐字）。 */
const EXACT_TAGS = Object.freeze([
  ['无事发生', null],
  ['闲聊', 'chat'],
  ['聊天', 'chat'],
  ['被点名', 'mention'],
  ['被夸', 'praise'],
  ['被怼', 'roast'],
  ['玩闹', 'tease'],
  ['调侃', 'tease'],
  ['接梗', 'memeOk'],
  ['求助', 'help'],
  ['好奇', 'curiosity'],
  ['悲伤', 'sadness'],
  ['出丑', 'shame'],
  ['感激', 'gratitude']
]);

/** 老树 finish.execute 的"空转档"集合（src/tools.js:3432）。 */
const FILLER_MOOD = /^(闲聊|无事发生|无事|没事|正常聊天|被点名|玩闹|接梗|分享|求助|好奇)$/;

/** 老树 finish.execute 的 summary 补档正则（src/tools.js:3427-3428，逐字）。 */
const WANT_NEG = /我被怼|我被骂|我被喷|被人怼|被人骂|有人骂我|有人怼我|骂我了|怼我了|喷我了|真被骂|真被怼|人身攻击/;
const WANT_POS = /我被夸|被夸了|夸我|被表扬|被人夸/;
const WANT_POS_NEGATE = /没被夸|不是夸/;

/** 老树 finish.execute 的"空转档按 summary 抠具体档"表（src/tools.js:3436-3452，逐字）。 */
const SUMMARY_MOOD_MINING = Object.freeze([
  [/害怕|吓到|恐惧|后怕|好怕|瑟瑟发抖/, '恐惧'],
  [/难过|伤心|委屈|心寒|想哭|emo|破防|泪目/, '悲伤'],
  [/紧张|慌了|没底|压力大|心慌|焦虑/, '紧张'],
  [/惊讶|没想到|太意外|不会吧|真的假的|离谱/, '惊讶'],
  [/无聊|没劲|太闲|闲死|没事干/, '无聊'],
  [/羡慕|嫉妒|凭什么|别人家|你看看你/, '比较'],
  [/没人陪|就我一个|没人理|孤单|寂寞|一个人/, '独处'],
  [/怪我|背锅|我的错|害你|我搞砸|拖累/, '内疚'],
  [/期待|想看|等着看|等不及/, '期待'],
  [/谢谢|感谢|辛苦|麻烦你|多亏|爱了/, '感激'],
  [/社死|丢人|好尬|出丑/, '出丑'],
  [/反胃|恶心|辣眼睛/, '恶心'],
  [/刷屏|刷了一堆|别插嘴/, '刷屏'],
  [/冷落|没人理我|又没人/, '被冷落'],
  [/吐槽|烦死了|受不了了/, '吐槽']
]);

/** 老树 finish.execute 的优先级（被怼/被夸 优先保留，src/tools.js:3458）。 */
const MOOD_PRIORITY = ['被怼', '被夸'];

/**
 * 老树逐 kind 数值表（appraiseAndAct switch，原始档位量）。
 * 键 = kind；值 = 直接喂 M7 `emotionEvidence.deltas` 的字段 → 数值。
 * `affect.<x>` 用新树 AFFECT 里的老树键名；`pools.emotional` / `mood` / `arousal` /
 * `acuteStress` / `chronicStress` 同名。
 */
export const MOOD_KIND_DELTAS = Object.freeze({
  chat: { 'affect.cheer': 4, 'affect.joy': 2, 'affect.boredom': -4, 'affect.loneliness': -2 },
  mention: { 'affect.curiosity': 4, 'affect.cheer': 3, 'affect.boredom': -3, arousal: 2 },
  praise: {
    'affect.joy': 15, 'affect.cheer': 9,
    'affect.irk': -8, 'affect.down': -5, 'affect.anxiety': -5, 'affect.shame': -3, 'affect.boredom': -4,
    mood: 6, acuteStress: -8, arousal: 3, 'pools.emotional': 2
  },
  roast: {
    'affect.irk': 13, 'affect.anger': 9, 'affect.down': 2,
    'affect.joy': -4, 'affect.cheer': -4, 'affect.smug': -3,
    mood: -4, acuteStress: 10, chronicStress: 1, arousal: 9
  },
  tease: {
    'affect.smug': 5, 'affect.boredom': -4, 'affect.down': -2,
    mood: 2, acuteStress: 1, arousal: 1
  },
  memeOk: { 'affect.smug': 3, 'affect.cheer': 3, 'affect.joy': 2, 'affect.down': -2, 'affect.boredom': -2 },
  help: { 'affect.curiosity': 10, 'affect.pride': 4, 'affect.gratitude': 2, 'affect.boredom': -3 },
  curiosity: { 'affect.curiosity': 10, 'affect.boredom': -5, 'affect.down': -2, arousal: 2 },
  shame: {
    'affect.shame': 10, 'affect.anxiety': 4, 'affect.down': 3,
    'affect.smug': -7, 'affect.pride': -5, 'affect.joy': -3,
    mood: -4, acuteStress: 7, arousal: -3
  },
  sadness: {
    'affect.sadness': 10, 'affect.down': 8, 'affect.loneliness': 3,
    'affect.joy': -5, 'affect.cheer': -2,
    mood: -5, arousal: -4
  },
  boredom: { 'affect.boredom': 10, 'affect.down': 2, 'affect.loneliness': 2, 'affect.curiosity': -2, 'affect.cheer': -2, arousal: -4 },
  gratitude: {
    'affect.gratitude': 9, 'affect.joy': 4, 'affect.cheer': 2,
    'affect.irk': -5, 'affect.down': -2, 'affect.anger': -2,
    mood: 3, 'pools.emotional': 2
  },
  // 环境类 busy/ignore 与 toolFail/error：老树由 applyRunToBotState 的环境段/错误段走，
  // 不走模型自评（finish 的 mood 枚举里也没有它们）⇒ 本表不收。
});

/** 模型自评**不**覆盖的环境/失败档（新树各有自己的事件通路）。 */
export const SELF_EVAL_EXCLUDED_KINDS = Object.freeze(['toolFail', 'error', 'busy', 'ignore']);

/**
 * 老树 `pickOneAdd` 的候选表（`src/bot-state.js:664-668` / `:678-682`，逐字）：
 * `[桶名, 权重, 增量]`。只对被夸/玩闹两档抽一维；其余 kind 没有这个第三维。
 */
const THIRD_DIM_PICKS = Object.freeze({
  praise: Object.freeze([['pride', 1.1, 12], ['gratitude', 1.0, 10], ['smug', 0.9, 10]]),
  tease: Object.freeze([['cheer', 1.0, 5], ['joy', 0.9, 3], ['curiosity', 0.7, 3]])
});

/**
 * 老树 `pickOneAdd`（src/bot-state.js:633-648）的等价实现 —— **纯函数版**。
 *
 * 与老树的三点关系：① 候选表逐字照搬；② 走表方式逐字照搬（总权重、依次减、`r<=0` 命中，
 *   都命中不了就取最后一个）；③ 随机值由**调用方注入**（老树直接 `Math.random()`）。
 * 不夹取返回值域：`random()` 给到 [0,1) 之外时按老树同款行为落到极值档（>1 ⇒ 最后一维，
 * <0 ⇒ 第一维），不静默改判。
 *
 * @param {Array<[string, number, number]>} cands 候选表
 * @param {() => number} random 注入的随机源，返回值当 [0,1) 用
 * @returns {{key: string, amount: number}|null}
 */
function pickOneAdd(cands, random) {
  const bag = (cands || []).filter((c) => Array.isArray(c) && Number.isFinite(Number(c[2])));
  if (!bag.length) return null;
  const total = bag.reduce((s, c) => s + Math.max(0.01, Number(c[1]) || 0), 0);
  let r = Number(random()) * total;
  let chosen = bag[bag.length - 1];
  for (const c of bag) {
    r -= Math.max(0.01, Number(c[1]) || 0);
    if (r <= 0) { chosen = c; break; }
  }
  return { key: String(chosen[0]), amount: Number(chosen[2]) || 0 };
}

/**
 * 老树 parseEmotionTags：文本 → kind 列表（精确标签，上限 3）。
 * @param {string} raw mood 串（可带 、/，/+ 分隔的多档）
 * @returns {string[]} kind 列表（无事发生/空串 ⇒ []）
 */
export function parseMoodKinds(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (/^(无事发生|无事|没事|平静|正常聊天|none|calm|nothing)$/i.test(text)) return [];
  const parts = text.split(/[/、,，+]+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const hit = EXACT_TAGS.find(([label]) => p === label || p.toLowerCase() === label.toLowerCase());
    if (hit && hit[1] && !out.includes(hit[1])) out.push(hit[1]);
  }
  return out.slice(0, 3);
}

/**
 * 老树 finish.execute 的 mood 归一（summary 补档 → 空转档挖关键词 → 优先级 → 上限 2 → 闲聊去接梗）。
 * @param {{mood?: string, summary?: string}} input 模型给的自评参数
 * @returns {{mood: string, kinds: string[]}} 归一后的 mood 串与 kind 列表
 */
export function normalizeSelfEvalMood({ mood, summary } = {}) {
  const parts = String(mood || '').split(/[、,，/]+/).map((s) => s.trim()).filter(Boolean);
  const sum = String(summary || '');

  // ① summary 里极明确的被夸/被怼，任何 mood 下都补上（照老树 :3423-3430）
  if (WANT_NEG.test(sum) && !parts.includes('被怼')) parts.push('被怼');
  if (WANT_POS.test(sum) && !WANT_POS_NEGATE.test(sum) && !parts.includes('被夸')) parts.push('被夸');

  // ② 只标了空转档时，按 summary 抠一档具体情绪（照老树 :3431-3456）
  const fillerOnly = parts.length > 0 && parts.every((p) => FILLER_MOOD.test(p))
    && !parts.some((p) => p === '被怼' || p === '被夸');
  if (fillerOnly) {
    for (const [re, label] of SUMMARY_MOOD_MINING) {
      if (re.test(sum) && !parts.includes(label)) { parts.push(label); break; }
    }
  }

  // ③ 上限 2 项；被怼/被夸优先（照老树 :3457-3462）
  let normalized = parts
    .sort((a, b) => (MOOD_PRIORITY.indexOf(a) < 0 ? 9 : MOOD_PRIORITY.indexOf(a))
      - (MOOD_PRIORITY.indexOf(b) < 0 ? 9 : MOOD_PRIORITY.indexOf(b)))
    .slice(0, 2)
    .join('、');

  // ④ 闲聊/无事不得变成接梗（照老树 :3463-3466）
  if (/^(闲聊|无事发生|无事|没事|正常聊天)$/.test(normalized) || /^闲聊、/.test(normalized)) {
    normalized = normalized.replace(/接梗/g, '').replace(/、+$/, '');
  }

  return { mood: normalized, kinds: parseMoodKinds(normalized) };
}

/**
 * kind 列表 → 合并后的 deltas（多档相加；0 值丢掉——"一个都不改"没有意义）。
 *
 * ★ 第三维（老树 pickOneAdd）：`opts.random` 注入随机源时，对被夸/玩闹按老树权重表抽一维
 *   （pride 12 / gratitude 10 / smug 10；cheer 5 / joy 3 / curiosity 3）。**没注入就不抽**
 *   —— 生产行为不因"本文件被加载"而静默改变；要真随机由调用方传 `Math.random`。
 *
 * @param {string[]} kinds
 * @param {{random?: () => number}} [opts] 注入的随机源（测试传固定序列）
 * @returns {Record<string, number>} `emotionEvidence.deltas` 形状
 */
export function selfEvalDeltas(kinds, opts = {}) {
  const random = typeof opts?.random === 'function' ? opts.random : null;
  const out = {};
  for (const kind of Array.isArray(kinds) ? kinds : []) {
    const table = MOOD_KIND_DELTAS[kind];
    if (!table) continue;
    for (const [k, v] of Object.entries(table)) {
      out[k] = (Number(out[k]) || 0) + Number(v);
    }
    // 第三维（仅注入随机源时；老树 pickOneAdd）
    if (random) {
      const picked = pickOneAdd(THIRD_DIM_PICKS[kind] || [], random);
      if (picked) out[`affect.${picked.key}`] = (Number(out[`affect.${picked.key}`]) || 0) + picked.amount;
    }
  }
  for (const [k, v] of Object.entries(out)) {
    if (!Number.isFinite(Number(v)) || Number(v) === 0) delete out[k];
  }
  return out;
}

/**
 * 老树 applyRunToBotState:1152-1155：favorDelta 对**心情**的作用只看正负。
 * @param {number|null|undefined} delta finish 的 favorDelta
 * @returns {number|null} +4 / -3 / null（0 或缺失 ⇒ 不动）
 */
export function favorSignMoodDelta(delta) {
  const n = Number(delta);
  if (!Number.isFinite(n) || n === 0) return null;
  return n > 0 ? 4 : -3;
}
