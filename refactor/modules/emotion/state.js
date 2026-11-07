/**
 * M7 emotion · 状态形状（initState / 恢复目标 / 小工具）
 *
 * 两条边界（票面第 1 条，写进形状里）：
 *   - `state.self`  = 本体状态（四池/心情/唤醒/压力/情绪余温/近况），**跨群共享一份**，所有会话共同消耗；
 *   - `state.persons` = **按人**的关系（信任/边界/语气/好感/共同经历），彼此隔离；
 *     2026-10-16 用户裁定：**熟悉度 familiarity 已退役**（关系用好感表达）。
 * 两者不共用任何字段，所以「拿精力当好感」在形状上就写不出来。
 */
import { SCHEMA_VERSION } from '../../contracts/index.js';

export const POOLS = Object.freeze(['physical', 'cognitive', 'emotional', 'will']);

/**
 * ★★ 票 N30 · 照老树扩到 14 类（老树 `src/bot-state.js:37-53` 的 `EMO_KEYS`，逐位同序）。
 *
 * 改前只有 6 类（`joy/irritation/sadness/loneliness/excitement/anxiety`），带来两个**真缺陷**：
 *   ① **死代码**：`apply.js` 的 `POS_EMO` 早就写着 `cheer/pride/smug/gratitude`，
 *      而 `events.js` 的 `DELTA_FIELDS` 只放行 6 类 ⇒ 这四个键**永远写不进去**，
 *      「正向软增益分界」对它们是空转；老树这四个是主力正向情绪（夸一次 joy+cheer ~80）。
 *   ② **注入丢维度**：老树按 `out/in/neu` 三向聚合注入（「向内偏重：焦虑(心里没底)」），
 *      6 类里 `out` 只有 joy/irritation 两个、`in` 有三个 ⇒ 方向聚合几乎退化成单点判断。
 *
 * ★ **为什么额外保留 `irritation` 与 `excitement`**（老树没有这两个键）：
 *   - `irritation` 是新树自己的名字，语义 = 老树的 `irk`（烦躁）。生产 `data/emotion-state.json`
 *     已经按它落过盘，`apps/server/console-api.js:33-39` 与 `apps/ui/app.js:8354` 也按它显示
 *     ⇒ 直接改名会**丢生产数据 + 打断别人的域**。这里两条并存，渲染层按 `EMOTION_ALIASES` 归一。
 *   - `excitement`（兴奋）是老树 2026-09 自己删掉的维度（「Jev 不判且无稳定入口，已删」），
 *     但新树从第一天就有、UI 也在显示 ⇒ 同样保留，不做无谓的数据迁移。
 *   ⇒ 净效果：**老树 14 类全部可写**（能力对齐），且**新树既有 6 类一个都不丢**（不回归）。
 */
export const AFFECT = Object.freeze([
  'anger', 'irk', 'joy', 'cheer', 'pride', 'smug', 'gratitude',
  'anxiety', 'sadness', 'shame', 'loneliness', 'down', 'boredom', 'curiosity',
  // ↓ 新树自有、老树没有；保留是为了不丢已落盘数据与别人的显示口径（见上）
  'irritation', 'excitement'
]);

/**
 * 新树自有键 → 老树键的归一（**只用于渲染/聚合，不用于写盘**）。
 * `irritation`（新树）≡ `irk`（老树·烦躁）；`excitement` 老树已删 ⇒ 归到 `cheer`（开心）参与方向聚合。
 */
export const EMOTION_ALIASES = Object.freeze({ irritation: 'irk', excitement: 'cheer' });

/** 四池初值（docs §五：身体 65 / 认知 60 / 情绪 60 / 意志 55）。 */
export const DEFAULT_POOLS = Object.freeze({ physical: 65, cognitive: 60, emotional: 60, will: 55 });

export const MOOD_BASE = 50;
export const AROUSAL_BASE = 50;
export const MAX_LEDGER = 200;
export const MAX_KEYS = 500;
export const MAX_PENDING = 40;

/** 关系初值（50 = 中性；陌生人保持礼貌距离）。
 *  ★ 2026-10-16（用户裁定）：**熟悉度 familiarity 已退役** —— 关系用好感（favor）表达；
 *    旧 JSON 里若仍带 familiarity，归一化时不读、不写（见 normalizePerson）。 */
export const PERSON_DEFAULTS = Object.freeze({
  trust: 50,
  boundary: 60,
  favor: 50,
  tone: 'neutral'
});

// 按 UTC 小时取时段：换机器换时区也不会算出两个不同的目标（纯函数的代价说清楚）。
const HOUR_BANDS = [
  { below: 6, phase: 'night', physical: 40, cognitive: 45 },
  { below: 12, phase: 'morning', physical: 70, cognitive: 72 },
  { below: 18, phase: 'afternoon', physical: 66, cognitive: 64 },
  { below: 22, phase: 'evening', physical: 60, cognitive: 58 },
  { below: 24, phase: 'late', physical: 50, cognitive: 52 }
];

export function utcHour(at) {
  const d = new Date(Number(at));
  if (!Number.isFinite(d.getTime())) return 12;
  // ★ 2026-10-30 溟改：原来取的是 UTC 小时，可机器在北京（Etc/GMT-8）——
  //   北京时间 08:00–14:00 正好落在 UTC 的 00–06，被判成 'night' 档
  //   （physical 40 / cognitive 45），于是大白天精力目标也是夜里那份，池子常年 30–45，
  //   每轮都被 hint 要求「简短回答」。换成本地小时，档位才跟现实作息对得上。
  //   函数名保留 utcHour（外部只在本文件用），语义改成「本地小时」。
  return d.getHours();
}

export function phaseOf(at) {
  const h = utcHour(at);
  return (HOUR_BANDS.find((b) => h < b.below) || HOUR_BANDS[2]).phase;
}

/** 基础恢复目标（不含日历/近况偏移）；情绪与意志恒回 55。 */
export function targetsFor(at) {
  const h = utcHour(at);
  const band = HOUR_BANDS.find((b) => h < b.below) || HOUR_BANDS[2];
  return { physical: band.physical, cognitive: band.cognitive, emotional: 55, will: 55 };
}

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

export function round1(x) {
  return Math.round(Number(x) * 10) / 10;
}

/**
 * ★ 票 E-2 · 漂移 P7：**认知软地板**（规格 :146「认知很低时扣得更少，避免掉到零后锁死」）。
 *
 * 公式（三段线性、连续、无硬截断）：
 *     scale(v) = clamp( (v - KNEE) / (FULL - KNEE), MIN, 1 )
 *     KNEE=20、FULL=60、MIN=0.25
 *   · v ≥ 60  ⇒ 1        （与改前**逐位相同**：正常档位的人感觉不到这条规则）
 *   · v = 40  ⇒ 0.5     · v = 20 ⇒ 0.25（贴老树 `src/bot-state.js:624` 的 0.25 / 0.65 / 1 两档）
 *   · v < 20 ⇒ 0.25     （**不是 0**：留一点余量，池子不会被锁死在谷底）
 *
 * 为什么是「软」而不是「截断」：
 *   · 截断（低于某个数就一点也不扣）会在阈值处折断，曲线出现跳变；而且那是条**非物理**规则 ——
 *     模型从提示词侧只能看到「这会儿更适合简短回答」（hint.js），看不到池子数值，所以硬阈值会在
 *     用户看不见的地方制造行为突变。
 *   · 线性衰减让「越低越慢」在任何取值上都连续成立：步长再小也不会越过 0，单调、幂尺度友好。
 *   · 只作用于**认知**（规格只说认知）：身体/意志/情绪池的扣减一律不打折。
 *
 * 读不到数值时返回 MIN（宁少扣不乱扣）—— 与 `weightOf` 那套「拿不准就往安全侧倒」的口径一致。
 */
export const COGNITIVE_SOFT_KNEE = 20;
export const COGNITIVE_SOFT_FULL = 60;
export const COGNITIVE_SOFT_MIN = 0.25;

export function cognitiveDrainScale(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return COGNITIVE_SOFT_MIN;
  return clamp((v - COGNITIVE_SOFT_KNEE) / (COGNITIVE_SOFT_FULL - COGNITIVE_SOFT_KNEE), COGNITIVE_SOFT_MIN, 1);
}

export function clone(x) {
  return structuredClone(x);
}

export function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/**
 * 新建或载入状态。`input` 只认白名单字段，多余字段忽略（载入旧存档时不炸）。
 * 时间一律由调用方给（`at`）；本模块自己不读时钟。
 */
export function initState(input = {}) {
  if (!isPlainObject(input)) throw new Error('emotion.initState: 期望对象');
  const at = Number(input.at);
  const when = Number.isFinite(at) && at > 0 ? at : 0;
  const self = (isPlainObject(input.self) ? input.self : {}) || {};

  const pools = {};
  for (const k of POOLS) {
    const v = Number(self.pools?.[k]);
    pools[k] = round1(clamp(Number.isFinite(v) ? v : DEFAULT_POOLS[k], 0, 100));
  }
  const affect = {};
  for (const k of AFFECT) {
    const v = Number(self.affect?.[k]);
    affect[k] = round1(clamp(Number.isFinite(v) ? v : 0, 0, 100));
  }

  const state = {
    schemaVersion: SCHEMA_VERSION,
    selfId: String(input.selfId ?? ''),
    self: {
      pools,
      affect,
      mood: round1(clamp(num(self.mood, MOOD_BASE), 0, 100)),
      arousal: round1(clamp(num(self.arousal, AROUSAL_BASE), 0, 100)),
      acuteStress: round1(clamp(num(self.acuteStress, 0), 0, 100)),
      chronicStress: round1(clamp(num(self.chronicStress, 0), 0, 100)),
      targets: targetsFor(when),
      targetOffsets: isPlainObject(self.targetOffsets) ? self.targetOffsets : {},
      facts: isPlainObject(self.facts) ? self.facts : {},
      preferences: isPlainObject(self.preferences) ? self.preferences : {},
      lastSettledAt: Number.isFinite(num(self.lastSettledAt, when)) ? num(self.lastSettledAt, when) : 0,
      // ★ 2026-10-15：同 kind 冷却时间戳（老树 `s.lastEmoteAt` 的同名同义迁移；键是 kind，
      //   值是该 kind 上次落账时刻）。与状态一起落盘：允许的 kind 集合是封闭小集合，不设上限。
      lastEmoteAt: isPlainObject(self.lastEmoteAt) ? self.lastEmoteAt : {},
      // ★ 2026-10-15（情绪缺口第二组）：环境事件/轮成本的持久游标（老树 `ignoredStreak`/`ignoredStreakAt`/
      //   `chronicPush` 同名同义）：连续没人接的轮数与时间锚、慢压的小数进位器。
      ignoredStreak: Math.max(0, Math.floor(num(self.ignoredStreak, 0))),
      ignoredStreakAt: num(self.ignoredStreakAt, 0),
      chronicPush: num(self.chronicPush, 0),
      lastChange: isPlainObject(self.lastChange) ? self.lastChange : null
    },
    persons: {},
    pending: Array.isArray(input.pending) ? input.pending.slice(0, MAX_PENDING) : [],
    ledger: Array.isArray(input.ledger) ? input.ledger.slice(-MAX_LEDGER) : [],
    appliedKeys: isPlainObject(input.appliedKeys) ? input.appliedKeys : {},
    seq: Math.max(0, Math.floor(num(input.seq, 0)))
  };

  for (const [pid, raw] of Object.entries(isPlainObject(input.persons) ? input.persons : {})) {
    state.persons[pid] = normalizePerson(pid, raw, when);
  }
  return state;
}

function num(x, dflt) {
  const v = Number(x);
  return Number.isFinite(v) ? v : dflt;
}

export function normalizePerson(personId, raw = {}, when = 0) {
  const p = isPlainObject(raw) ? raw : {};
  // ★ 2026-10-16（用户裁定 · 熟悉度退役）：旧 JSON 里的 `familiarity` **一律忽略**（不读、不写、不报错），
  //   也不影响其它字段（favor/trust/boundary 照常读出）。形状里不再出现这个键。
  return {
    personId: String(personId),
    trust: round1(clamp(num(p.trust, PERSON_DEFAULTS.trust), 0, 100)),
    boundary: round1(clamp(num(p.boundary, PERSON_DEFAULTS.boundary), 0, 100)),
    favor: round1(clamp(num(p.favor, PERSON_DEFAULTS.favor), 0, 100)),
    tone: normalizeTone(p.tone),
    recentShared: Array.isArray(p.recentShared) ? p.recentShared.slice(0, 8) : [],
    preferences: isPlainObject(p.preferences) ? p.preferences : {},
    openEvents: Array.isArray(p.openEvents) ? p.openEvents.slice(0, 8) : [],
    lastScoredRound: p.lastScoredRound == null ? null : String(p.lastScoredRound),
    lastChange: isPlainObject(p.lastChange) ? p.lastChange : null,
    lastSeenAt: num(p.lastSeenAt, when)
  };
}

const TONES = ['neutral', 'warm', 'guarded', 'teasing', 'formal'];

export function normalizeTone(t) {
  const s = String(t || '');
  return TONES.includes(s) ? s : 'neutral';
}

export const TONE_VALUES = Object.freeze(TONES);

export const EMOTION_PROFILES = {
  t1: {
    id: 't1', number: 1,
    name: '完美型',
    en: 'The Reformer',
    mean: '想正确、守规矩、变更好。',
    fear: '怕犯错、怕被批评。',
    tip: '平时稳、有分寸；被挑错或觉得乱来时会闷一会儿，不会一直炸。',
    gain: 0.88, posGain: 1.18, negGain: 0.92,
    closenessSensitivity: 0.75, halfLifeMul: 1.08,
    moodPull: 0.17, arousalGain: 0.78,
    softCeil: { floors: [20, 38, 54, 72], coeffs: [1, 0.38, 0.16, 0.07, 0.025] },
    softCeilPos: { floors: [18, 40, 58, 82], coeffs: [1, 0.44, 0.30, 0.16, 0.06] }
  },
  t2: {
    id: 't2', number: 2,
    name: '助人型',
    en: 'The Helper',
    mean: '想被需要、被喜欢。',
    fear: '怕不被爱。',
    tip: '帮上忙、被谢谢时特别来劲；被晾着会更在意、更失落一点。',
    gain: 1.1, posGain: 1.42, negGain: 1.02,
    closenessSensitivity: 1.28, halfLifeMul: 1.12,
    moodPull: 0.26, arousalGain: 0.92,
    softCeil: { floors: [16, 34, 50, 70], coeffs: [1.05, 0.4, 0.18, 0.08, 0.03] },
    softCeilPos: { floors: [18, 40, 60, 86], coeffs: [1.05, 0.47, 0.34, 0.19, 0.07] }
  },
  t3: {
    id: 't3', number: 3,
    name: '成就型',
    en: 'The Achiever',
    mean: '想成功、被认可。',
    fear: '怕没价值。',
    tip: '被夸、接梗很来劲，容易得意；翻车或比下去会有点挂脸，但底色还是亮的。',
    gain: 1.15, posGain: 1.48, negGain: 0.98,
    closenessSensitivity: 0.9, halfLifeMul: 0.98,
    moodPull: 0.28, arousalGain: 1.18,
    softCeil: { floors: [16, 34, 50, 70], coeffs: [1.08, 0.38, 0.16, 0.07, 0.025] },
    softCeilPos: { floors: [18, 40, 62, 86], coeffs: [1.1, 0.50, 0.36, 0.20, 0.08] }
  },
  t4: {
    id: 't4', number: 4,
    name: '自我型',
    en: 'The Individualist',
    mean: '想独特、真实。',
    fear: '怕平庸、被抛弃。',
    tip: '开心和难过都更浓一点；低落、孤单会更缠人，整体仍偏正。',
    gain: 1.2, posGain: 1.32, negGain: 1.12,
    closenessSensitivity: 1.32, halfLifeMul: 1.35,
    moodPull: 0.24, arousalGain: 0.95,
    softCeil: { floors: [15, 32, 48, 68], coeffs: [1.08, 0.48, 0.22, 0.09, 0.035] },
    softCeilPos: { floors: [18, 40, 60, 80], coeffs: [1.1, 0.52, 0.36, 0.20, 0.08] }
  },
  t5: {
    id: 't5', number: 5,
    name: '理智型',
    en: 'The Investigator',
    mean: '想理解世界、保存精力。',
    fear: '怕无能、被消耗。',
    tip: '情绪偏淡、不容易大起大落；被掏空或搞砸时会闷一下，但正的还是多一点。',
    gain: 0.7, posGain: 1.0, negGain: 0.8,
    closenessSensitivity: 0.5, halfLifeMul: 0.9,
    moodPull: 0.14, arousalGain: 0.55,
    softCeil: { floors: [22, 40, 56, 74], coeffs: [0.9, 0.34, 0.14, 0.06, 0.02] },
    softCeilPos: { floors: [18, 40, 58, 84], coeffs: [0.9, 0.42, 0.30, 0.16, 0.05] }
  },
  t6: {
    id: 't6', number: 6,
    name: '忠诚型',
    en: 'The Loyalist',
    mean: '想安全、有依靠。',
    fear: '怕失控、被背叛。',
    tip: '开心来得稳；更容易先绷着、想最坏，不安会粘一会儿，但日常还是偏暖。',
    gain: 1.0, posGain: 1.2, negGain: 1.08,
    closenessSensitivity: 1.18, halfLifeMul: 1.22,
    moodPull: 0.2, arousalGain: 1.05,
    softCeil: { floors: [16, 34, 50, 70], coeffs: [1.02, 0.46, 0.22, 0.09, 0.035] },
    softCeilPos: { floors: [18, 40, 60, 84], coeffs: [1.02, 0.46, 0.32, 0.18, 0.07] }
  },
  t7: {
    id: 't7', number: 7,
    name: '活泼型',
    en: 'The Enthusiast',
    mean: '想快乐、体验新鲜。',
    fear: '怕痛苦、无聊。',
    tip: '开心放大、烦心事缩得快；冷场无聊会有，但不太往心里去。',
    gain: 1.2, posGain: 1.52, negGain: 0.78,
    closenessSensitivity: 0.58, halfLifeMul: 0.82,
    moodPull: 0.3, arousalGain: 1.25,
    softCeil: { floors: [18, 36, 52, 72], coeffs: [1.1, 0.38, 0.15, 0.06, 0.02] },
    softCeilPos: { floors: [18, 40, 62, 88], coeffs: [1.1, 0.50, 0.38, 0.22, 0.08] }
  },
  t8: {
    id: 't8', number: 8,
    name: '挑战型',
    en: 'The Challenger',
    mean: '想掌控、保护自己人。',
    fear: '怕被控制、软弱。',
    tip: '被认可很得意；被怼会硬刚、火气来得快，但不耽误平时还挺嗨。',
    gain: 1.2, posGain: 1.38, negGain: 1.1,
    closenessSensitivity: 0.88, halfLifeMul: 1.02,
    moodPull: 0.23, arousalGain: 1.42,
    softCeil: { floors: [20, 38, 54, 72], coeffs: [1.12, 0.4, 0.18, 0.08, 0.03] },
    softCeilPos: { floors: [18, 40, 61, 85], coeffs: [1.12, 0.50, 0.36, 0.20, 0.07] }
  },
  t9: {
    id: 't9', number: 9,
    name: '和平型',
    en: 'The Peacemaker',
    mean: '想和谐、避免冲突。',
    fear: '怕失去连接。',
    tip: '不太爱炸、整体偏稳偏暖；被冷落会轻轻失落，过一会儿就过去了。',
    gain: 0.78, posGain: 1.1, negGain: 0.75,
    closenessSensitivity: 0.68, halfLifeMul: 1.1,
    moodPull: 0.17, arousalGain: 0.58,
    softCeil: { floors: [20, 38, 54, 74], coeffs: [0.95, 0.36, 0.15, 0.06, 0.02] },
    // t9 与 t5 同档但保留差异（顶 82<84、低段 0.95>0.9，沿用原 softCeil 里 t9 略高于 t5 的关系）
    softCeilPos: { floors: [18, 40, 56, 82], coeffs: [0.95, 0.42, 0.30, 0.16, 0.05] }
  }
};
