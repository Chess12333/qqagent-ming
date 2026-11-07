/**
 * M7 emotion · 环境事件与轮成本（老树 `applyRunToBotState` 的降级移植）
 *
 * 依据（独立复核 `.tmp-dispatch/2026-10-15/39ddbb0d/r-情绪缺口复核.md` §4）：
 *   新树入站通路原先「每条消息各掉一次池」，而老树是「整轮按**发送条数**算一次」；老树的环境段
 *   （被冷落/无聊/刷屏）整条在新树不存在 ⇒ boredom/loneliness 两个池只减不增。
 *
 * 本文件只放**值表与纯判定**（状态的写入在 apply.js 的 onRound）：
 *   · 环境表（envNeglect/envBoredom/busy/socialHeavy）逐条注明老树出处；
 *   · `planRoundEnv` = 老树 :1104-1142 的纯函数版（ignoredStreak 计数/30 分钟衰减/被点名清零/
 *     门槛 3 与 5/10 与 30 分钟冷却判据/busy≥8），**只看入参，不读时钟**。
 *
 * 与老树的**有意差异**（降级）：
 *   · `ignoreHits`（历史累计，老树 :1107/1124）不搬：无聊档老树自己也已不用它判（:1127 注释）；
 *   · 环境事件不吃 sparsityBoost（老树 :1102-1103 同款决定）；
 *   · 私聊轮不计「没人接」（私聊的每条消息都是对机器人说的，别把正常对话当冷落）。
 *
 * 纯函数：不读时钟、不碰盘。
 */

/** 老树 `ENV_COOLDOWN_MS` / `ENV_BOREDOM_COOLDOWN_MS`（bot-state.js:890-891，逐字）。 */
export const ENV_NEGLECT_COOLDOWN_MS = 10 * 60 * 1000;
export const ENV_BOREDOM_COOLDOWN_MS = 30 * 60 * 1000;
/** ignoredStreak 的 30 分钟时间衰减（老树 :1112-1116）。 */
export const ENV_STREAK_DECAY_MS = 30 * 60 * 1000;
/** 门槛：连续 3 轮没人接 ⇒ 被冷落；5 轮 ⇒ 无聊；一轮 ≥8 条涌入 ⇒ 刷屏（老树 :1121/:1132/:1139）。 */
export const NEGLECT_STREAK_THRESHOLD = 3;
export const BOREDOM_STREAK_THRESHOLD = 5;
export const BUSY_TRIGGER_THRESHOLD = 8;
export const MAX_IGNORED_STREAK = 12;

/** 每轮成本阈值（老树 :1161-1164：n≥3 认知 -2 / n 1~2 -1；n≥5 意志 -2；n≥6 身体 -1；出错加码）。 */
export const ROUND_COST = Object.freeze({
  cognitiveFull: 2, cognitiveLight: 1,
  willHeavy: 2, physicalHeavy: 1,
  errorWill: 3, errorPhysical: 2, errorAcute: 6,
  willHeavySent: 5, physicalHeavySent: 6
});
/** socialHeavy：一轮 ≥4 条且非纯正向（老树 :789-799）。 */
export const SOCIAL_HEAVY_SENT_THRESHOLD = 4;
/** 纯正向 kind（老树 :790-793，逐字）：全在这张表里就不按 socialHeavy 倒扣。 */
export const PURE_POSITIVE_KINDS = Object.freeze([
  'praise', 'gratitude', 'chat', 'memeOk', 'tease', 'help', 'mention', 'curiosity'
]);
/** 慢压（老树 :1171-1201，逐字）：说过话 +0.4；急压 >50 再加 (acute-50)*0.04；积 1 进 chronicStress；
 *  chronicStress ≥45 ⇒ 每轮推 anxiety +min(4,(cs-45)*0.10)、down + push*0.6（120s 冷却走 allowEmote('anxiety')）。 */
export const SLOW_PRESSURE = Object.freeze({
  chatGain: 0.4, acuteScale: 0.04, threshold: 45,
  pushScale: 0.10, pushCap: 4, minPush: 0.5, downRatio: 0.6
});

/**
 * 环境表（按键名 → deltas；`emotionEvidence` 同形状，apply.js 走同一软增益口径）。
 * 出处：envNeglect=老树 ignore（:719-725）、envBoredom=老树 boredom（:760-765）、
 * busy（:708-718）、socialHeavy（:795-797，boredom+3 那半单独一道冷却，见 apply.js）。
 */
export const ENV_KIND_DELTAS = Object.freeze({
  envNeglect: {
    'affect.loneliness': 8, 'affect.down': 5, 'affect.boredom': 3,
    'affect.cheer': -3, 'affect.smug': -2, mood: -2, arousal: -4
  },
  envBoredom: {
    'affect.boredom': 10, 'affect.down': 2, 'affect.loneliness': 2,
    'affect.curiosity': -2, 'affect.cheer': -2, arousal: -4
  },
  // ★ 2026-10-30（她定的：情绪池一直是负面居多；同日在 inbound-cue.js 给 busy 加了 30 分钟冷却）：
  //   老树这一档伤害重、且没有冷却——群里一轮 ≥8 条就扣一次，热闹几轮全压在负数上；
  //   喜悦/开心被压到 0 之后再扣也只是 0，账本上就只剩往下走的那一条。
  //   现在：伤害砍半；不再夺走好心情（去掉了 joy -4 / cheer -3）；补一点「人在热闹里」的正向
  //   （不孤独、不低落）。差值全记在这里，别当没改过。
  busy: {
    'affect.boredom': 1, 'affect.irk': 7, 'affect.anxiety': 1,
    'affect.curiosity': -3, 'affect.cheer': 1,
    'affect.loneliness': -3, 'affect.down': -1,
    'pools.emotional': -4, acuteStress: 4, arousal: 2
  },
  socialHeavy: { 'pools.emotional': -6, 'affect.irk': 2 }
});
/** socialHeavy 的无聊腿（老树 :796：单独过 envBoredom 冷却，只 +3）。 */
export const SOCIAL_HEAVY_BOREDOM_DELTA = Object.freeze({ 'affect.boredom': 3 });

/**
 * 老树 :1104-1142 的纯判定版：本轮该不该动 ignoredStreak、该发哪些环境事件。
 *
 * ★ 与老树的一处**有意修正**：老树「无聊」的互相排斥判据（:1128-1132：10 分钟内有被冷落就不补无聊）
 *   与「被冷落每 10 分钟可重发」叠在一起，实际让 envBoredom 永远不可达（刚过 10 分钟被冷落先重发、
 *   没过 10 分钟 `neglectRecent` 又为真）。本实现改成：**本轮被冷落真的会触发时**才压住无聊
 *   （`neglectWillFire` 用同一份冷却判据预判），无聊另有自己的 30 分钟冷却（apply.js 裁决）——
 *   同一情形不再成对刷两笔，且"连着没人接"久了也能记到无聊。
 *
 * @param {{addressed?:boolean, kind?:string, sentCount?:number, triggerCount?:number,
 *          streak?:number, streakAt?:number, at?:number, lastEmoteAt?:object}} input
 * @returns {{streak:number, streakAt:number, events:Array<{kind:string, reason:string, streak?:number, triggerCount?:number}>}}
 *   `events` 是要发的**候选**（envNeglect/envBoredom/busy）—— 真正的冷却裁决仍由 apply.js 的
 *   `allowEmoteKind` 做（同一份判据，结论一致）。
 */
export function planRoundEnv({
  addressed = false, kind = 'group', sentCount = 0, triggerCount = 0,
  streak = 0, streakAt = 0, at = 0, lastEmoteAt = {}
} = {}) {
  const out = { streak: Math.max(0, Math.floor(Number(streak) || 0)), streakAt: Number(streakAt) || 0, events: [] };
  const now = Number(at) || 0;

  if (addressed) {
    // 被点名：清空「没人接」计数（老树 :1104-1108）。
    out.streak = 0;
    out.streakAt = 0;
  } else if (kind !== 'private' && (Number(sentCount) || 0) > 0) {
    // 机器人这轮说话了、却没人点它 ⇒ 记一次「没人接话」（老树 :1109-1118）。
    const aged = out.streakAt > 0 && now > 0 && now - out.streakAt > ENV_STREAK_DECAY_MS;
    const base = aged ? 0 : out.streak;
    out.streak = Math.min(MAX_IGNORED_STREAK, base + 1);
    out.streakAt = now;

    // 被冷落：≥3 且自己的 10 分钟窗已过（与 apply.js 的 allowEmoteKind 同一份判据，这里预判）。
    const neglectAt = Number(lastEmoteAt?.envNeglect) || 0;
    const neglectWillFire = out.streak >= NEGLECT_STREAK_THRESHOLD
      && !(neglectAt > 0 && now > 0 && now - neglectAt < ENV_NEGLECT_COOLDOWN_MS);
    if (neglectWillFire) {
      out.events.push({ kind: 'envNeglect', reason: 'ignored-streak', streak: out.streak });
    } else if (out.streak >= BOREDOM_STREAK_THRESHOLD) {
      // 无聊：当前这一段 ≥5，且被冷落本轮不触发。**不算在这里清零** —— 老树是在真触发时清零
      // （allowEmote 过后，:1135）；被 30 分钟冷却拦下的轮不该把 streak 吞掉，由 apply.js 触发后清。
      out.events.push({ kind: 'envBoredom', reason: 'ignored-streak', streak: out.streak, resetStreak: true });
    }
  }

  // 刷屏（老树 :1139-1142）：一轮涌入 ≥8 条且没被点名。
  if (!addressed && (Number(triggerCount) || 0) >= BUSY_TRIGGER_THRESHOLD) {
    out.events.push({ kind: 'busy', reason: 'burst', triggerCount: Number(triggerCount) });
  }
  return out;
}
