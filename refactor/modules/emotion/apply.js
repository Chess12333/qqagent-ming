/**
 * M7 emotion · applyEvent（纯函数：不读时钟、不写盘、不改入参）
 *
 * 时间只从 `event.at` 拿；持久化由调用方负责（README §0 铁律 2）。
 * 每一次落笔都往 `state.ledger` 记一行 `{at, target, field, delta, magnitude, source, evidenceIds}`
 * —— 「变化必须有来源」（验收第 13 条）。
 */
import { makeIdempotencyKey } from '../../contracts/index.js';
import { validateEvent, RELATION_FIELDS } from './events.js';
import {
  POOLS, AFFECT, MOOD_BASE, AROUSAL_BASE, MAX_LEDGER, MAX_KEYS, MAX_PENDING,
  clamp, round1, clone, isPlainObject, normalizePerson, targetsFor, cognitiveDrainScale,
  EMOTION_ALIASES
} from './state.js';
import { POS_EMO, NEG_EMO, metaOf } from './catalog.js';
import { halfLifeOf, poolHalfLifeOf, decayToward, minutesBetween, weightOf, FLOOR, DEAD } from './half-life.js';
// ★ 2026-10-15：同 kind 冷却时长表（唯一来源 = 老树 allowEmote 的 120/180s，见 inbound-cue.js）。
import { cooldownMsForKind } from './inbound-cue.js';
// ★ 2026-10-15（情绪缺口第二组）：环境事件/轮成本/慢压的值表与纯判定（老树 applyRunToBotState）。
import {
  ENV_KIND_DELTAS, planRoundEnv, ROUND_COST,
  SOCIAL_HEAVY_SENT_THRESHOLD, SOCIAL_HEAVY_BOREDOM_DELTA, PURE_POSITIVE_KINDS, SLOW_PRESSURE
} from './env-events.js';

const SELF_FIELD_CAP = 25;
const RELATION_CAP = 15;
const FAVOR_CAP = 10;
const RENEW_CAP_FACTOR = 1.5;

/**
 * 情绪活性两旋钮（用户 2026-10-14 裁定："更敏感 + 时间回落"）。
 *
 * 旋钮 A「一次影响多大」→ 决定 `ramp`（负情绪软增益倍率）与 `posRamp`（正情绪软增益倍率）。
 * 旋钮 B「多快回落」→ 决定 `halfLifeMul`（全局半衰期系数，越小回落越快）。
 *
 * 三档各有默认数值；配置键 `emotion.amplitudeLevel` / `emotion.decayLevel` 可改。
 * 默认中档——比现状更敏感、回落更快，但单次幅度仍有上限（不许乱跳）。
 */
export const ACTIVITY_LEVELS = Object.freeze({
  amplitude: Object.freeze({
    conservative: Object.freeze({ ramp: 1.0, posRamp: 1.0 }),   // 现状
    medium: Object.freeze({ ramp: 1.8, posRamp: 1.3 }),          // 默认：更敏感
    aggressive: Object.freeze({ ramp: 2.5, posRamp: 1.5 })       // 上限（clamp 边界）
  }),
  decay: Object.freeze({
    conservative: Object.freeze({ halfLifeMul: 1.5 }),           // 回落更慢
    medium: Object.freeze({ halfLifeMul: 0.8 }),                 // 默认：比回落更快
    aggressive: Object.freeze({ halfLifeMul: 0.4 })              // 上限（clamp 边界）
  })
});

/** 把档位名解析成具体参数；非法档位回落中档。显式给 ramp/posRamp/halfLifeMul 时优先于档位。 */
export function resolveActivityConfig(config = {}) {
  const ampLevel = String(config.amplitudeLevel || 'medium');
  const decayLevel = String(config.decayLevel || 'medium');
  const amp = ACTIVITY_LEVELS.amplitude[ampLevel] || ACTIVITY_LEVELS.amplitude.medium;
  const decay = ACTIVITY_LEVELS.decay[decayLevel] || ACTIVITY_LEVELS.decay.medium;
  // 向后兼容：显式给 emotion.ramp / emotion.posRamp / emotion.halfLifeMul 时优先
  return {
    ramp: config.ramp !== undefined ? Number(config.ramp) : amp.ramp,
    posRamp: config.posRamp !== undefined ? Number(config.posRamp) : amp.posRamp,
    halfLifeMul: config.halfLifeMul !== undefined ? Number(config.halfLifeMul) : decay.halfLifeMul
  };
}

/**
 * 时间投影（只读）：给一个**别的时刻**，算出那一刻的临时状态。
 *
 * ★ 为什么必须有它（指挥位 2026-10-06，采纳外部评审 §3.3）：
 *   `styleHint` 原本拿 `lastSettledAt` 当"现在"（hint.js:14）⇒ 两轮之间没有事件时，
 *   提示词看到的是**上次结算时**的状态，而不是此刻的。投影把"按时间恢复"这件事
 *   在读侧补上，且**复用同一个 `settle`** —— 与正式推进到同一时刻的结果一致。
 *
 * ★ 与 `applyEvent` 的三条硬区别（评审 §3.3 逐条要求）：
 *   ① **不改正式状态**（先 clone，写全落在副本上）；
 *   ② **不记台账、不占幂等键**（`ledger`/`appliedKeys` 在副本里被改也无所谓，反正丢弃）；
 *   ③ 调用方**不许**把返回值当"真实情绪"对外宣称 —— 它是系统按算法算出的**计算态**。
 *
 * @param {object} state 当前状态（**只读**，本函数不会动它）
 * @param {number} at 要投影到的时刻（毫秒；必须有限且为正）
 * @returns {object} 投影后的状态副本
 */
export function project(state, at, config = {}) {
  if (!isPlainObject(state)) throw new Error('emotion.project: 需要状态对象（先 initState）');
  const ts = Number(at);
  if (!Number.isFinite(ts) || ts <= 0) throw new Error('emotion.project: at 必须是正数毫秒时间戳');
  const s = clone(state);
  settle(s, ts, config);
  return s;
}

export function applyEvent(state, event, config = {}) {
  if (!isPlainObject(state)) throw new Error('emotion.applyEvent: 需要状态对象（先 initState）');
  // ★ N37：`config.hasEvidence` 是**可选注入**的证据存在性闸（装配层传 M6 的 `hasEvidence`）。
  //   传了就多查一道"这个证据 id 真的在账本里"，不传就维持旧行为（只查非空）——**不假装查过**。
  const v = validateEvent(event, { hasEvidence: config.hasEvidence });
  if (!v.ok) throw new Error(`emotion.applyEvent: 非法事件 —— ${v.errors.join('; ')}`);

  // 总开关关闭时冻结 M7 的正式状态：不结算时间、不记账、不推进 lastSettledAt。
  if (config.enabled === false) return clone(state);

  // 忽略名单只拦能明确归属到发言人的事件；不能从 evidenceIds 猜来源。
  if (isIgnoredSenderEvent(event, config.ignoreSenderIds)) return clone(state);

  const s = clone(state);
  const at = Number(event.at);
  const ids = Array.isArray(event.evidenceIds) ? event.evidenceIds.slice() : [];

  settle(s, at, config);

  switch (event.type) {
    case 'clock':
      break;
    case 'message':
      onMessage(s, event, at);
      break;
    case 'round':
      onRound(s, event, at, ids, config);
      break;
    case 'emotionEvidence':
      onEvidence(s, event, at, ids, config);
      break;
    case 'toolResult':
      onTool(s, event, at, ids);
      break;
    case 'lifeFact':
      onFact(s, event, at, ids);
      break;
    case 'calendar':
      onCalendar(s, event, at, ids);
      break;
    case 'relationDelta':
      onRelation(s, event, at, ids);
      break;
    case 'roleStatement':
      onStatement(s, event, at);
      break;
    default:
      break;
  }

  s.self.lastSettledAt = Math.max(Number(s.self.lastSettledAt) || 0, at);
  prune(s, at);
  trim(s);
  return s;
}

function isIgnoredSenderEvent(event, ignoreSenderIds) {
  if (!Array.isArray(ignoreSenderIds) || !ignoreSenderIds.length) return false;
  // 老树只从情绪判定/关系事件排除这些人；普通消息的时间与精力成本仍照常结算。
  if (!['emotionEvidence', 'lifeFact', 'relationDelta'].includes(event?.type)) return false;
  const ignored = new Set(ignoreSenderIds.map((id) => String(id ?? '').trim()).filter(Boolean));
  if (!ignored.size) return false;
  const senderId = String(event?.senderId ?? event?.evidence?.sender?.id
    ?? event?.evidence?.senderId ?? '').trim();
  if (senderId && ignored.has(senderId)) return true;
  // 事实/关系事件的 personId 就是被描述或被更新关系的人。
  if (event?.type === 'lifeFact' || event?.type === 'relationDelta') {
    const personId = String(event?.personId ?? '').trim();
    if (personId && ignored.has(personId)) return true;
  }
  return false;
}

// ── 时间流逝：一切向恢复目标/基线回落 ────────────────────────────────────────

function settle(s, at, config = {}) {
  const prev = Number(s.self.lastSettledAt) || 0;
  s.self.targets = targetsFor(at);
  const dt = minutesBetween(at, prev);
  if (dt <= 0) return;
  const goal = effectiveTargets(s, at);
  const before = { ...s.self.pools, mood: s.self.mood, arousal: s.self.arousal, acuteStress: s.self.acuteStress, chronicStress: s.self.chronicStress };

  // ★ 票 E-2 · P5/P6：四池**各用自己的半衰**（改前一律 `energy`，等于情绪池慢 3.75×、意志快 1.67×）。
  //   身体/认知仍是 `energy`（15），**逐位未变**；情绪池 4、意志 25 —— 类别表见 half-life.js。
  for (const k of POOLS) {
    const before0 = s.self.pools[k];
    let next = decayToward(before0, goal[k], poolHalfLifeOf(k), dt);
    // ★ 票 E-2 · P7：认知软地板在**结算步长**里同样成立 —— 只在「向下走」时按当前值缩一缩，
    //   向上（回血）不打折。指数趋向的形状不变，只是下降那一段被软化，越低越慢。
    if (k === 'cognitive' && next < before0) {
      next = before0 + (next - before0) * cognitiveDrainScale(before0);
    }
    s.self.pools[k] = round1(next);
  }
  
  let moodBase = MOOD_BASE;
  if (config && config.moodPull) {
    let sumPos = 0;
    let sumNeg = 0;
    // ★ 票 N30：用 `catalog.js` 的共享集合，并**按别名归一**（`irritation`≡`irk`）。
    //   老树 `src/bot-state.js:312-318` 原注：「心情池必须用完整的 POS_EMO / NEG_EMO，
    //   原先只手写了 4 正 5 负，把 shame/boredom/loneliness 和 hope/hype 全漏了。
    //   实测漏掉的负性 28 点、正性 20 点，算出来的心情跟真实状态对不上。」
    const emo = normalizeEmoKeys(s.self.affect || {});
    for (const k of POS_EMO) sumPos += Number(emo[k]) || 0;
    for (const k of NEG_EMO) sumNeg += Number(emo[k]) || 0;
    moodBase = clamp(50 + (sumPos - sumNeg) * Number(config.moodPull), 15, 80);
  }

  s.self.mood = round1(decayToward(s.self.mood, moodBase, halfLifeOf('mood', config), dt));
  s.self.arousal = round1(decayToward(s.self.arousal, AROUSAL_BASE, halfLifeOf('mood', config), dt));
  s.self.acuteStress = round1(decayToward(s.self.acuteStress, 0, halfLifeOf('acuteStress', config), dt));
  s.self.chronicStress = round1(decayToward(s.self.chronicStress, 0, halfLifeOf('chronicStress', config), dt));
  // ★ 票 N30：**逐情绪自己的半衰**（老树 `src/bot-state.js:238-242`）。
  //   改前一律 `impulse`(6 分钟) ⇒ 同一档衰减，`cheer`(15) / `boredom`(15) / `loneliness`(25)
  //   这些老树刻意做慢的「底色」全部 3.75 倍速衰减掉；而 `anger`(6)/`irk`(5) 尖峰也偏慢。
  //   现在按 catalog 的 `halfLifeMin × halfLifeMul` 走 —— 尖峰 5~6、底色 15~25，两头都对。
  //   `halfLifeMul` 仍是全局性格系数（老树 `getEmotionProfile().halfLifeMul`，clamp 0.4~2.0）。
  // ★ 活性旋钮 B（2026-10-14）：`decayLevel` 档位决定 halfLifeMul，中档默认 0.8（比回落更快）。
  const activity = resolveActivityConfig(config);
  const halfMul = clamp(Number(activity.halfLifeMul) || 1, 0.4, 2.0);
  for (const k of AFFECT) {
    const meta = metaOf(k);
    // 目录外的键（新树自有的 irritation/excitement）沿用 impulse 档，不静默变成 0。
    const hl = (meta ? meta.halfLifeMin : halfLifeOf('impulse')) * halfMul;
    s.self.affect[k] = round1(decayToward(s.self.affect[k], 0, hl, dt));
  }

  let moved = 0;
  for (const key of Object.keys(before)) {
    const after = key === 'mood' || key === 'arousal' || key === 'acuteStress' || key === 'chronicStress'
      ? s.self[key] : s.self.pools[key];
    moved += Math.abs(after - before[key]);
  }
  if (moved >= 0.5) {
    // ★ 票 E-2 · 裁定①（指挥位 2026-10-07）：这一行必须**自报家门**，不许混进"聊天引起的"那堆里。
    //   为什么会有这行：它是**纯时间驱动的结算步**（时间在走，不是因为发生了什么）。
    //   ★ 量过的现状（`.tmp-dispatch/_e2-decay-rate2.mjs`，下午档，60 分钟窗口）：
    //     静置每分钟一步 改前 9 行 → 改后 7 行；聊天每分钟一条 改前 40 → 改后 40；
    //     唯一变多的是"偏差刚出现后的头几分钟"（P3 同款 0 → 5 行）。
    //     ⇒ 本票的三条修复**没有**让台账更吵（意志变慢抵掉了情绪变快）；这行的噪声是既有现象。
    //   三个可枚举标记，缺一不可：
    //     · `kind: 'decay'`        —— 台账新的一根轴：`event`（外部证据引起）／`decay`（时间引起）。
    //                                 一眼分开就靠它（`ledger.filter(r => r.kind === 'decay')`）。
    //     · `deterministic: true` —— 只由 (池值, 恢复目标, dt) 决定，**不依赖任何外部证据**，
    //                                 同样输入必然同样输出 ⇒ 随时可重算核对，不是"发生了什么"的记录。
    //     · `evidenceIds: ['decay@<at>']` —— **这不是证据**（证据槽不允许空，见 events.js:59-64），
    //                                 `decay@` 前缀就是"这是重算键、不是聊天证据"的明示；它指向"哪一次结算步长"。
    //   ⚠ `source` 仍是 `time`（events.js:12 里已是一等来源），**不新增来源枚举值** ——
    //     `source` 是"证据出处"那根轴、且被 `validateEvent` 校验；"是什么引起的变化"属于 `kind`。
    //     若指挥位要 `source:'time-settle'`，那是 events.js 的来源枚举要开口子，另议。
    //   ⚠ 别为了"少写一行"把阈值 0.5 调大或删掉这行 —— 那是拿观测换测试绿。
    //   📌 设计债（指挥位 2026-10-07 登记）：`decay` 行是否该独立成一张台账（现在混在同一本里靠 kind 分流），
    //     不在本票拍板 ⇒ 等情绪接线那批一起看。
    push(s, {
      target: 'self', field: 'relax', delta: round1(moved), magnitude: round1(moved),
      source: 'time', kind: 'decay', deterministic: true, evidenceIds: [`decay@${at}`]
    });
  }
}

/** 有效恢复目标 = 小时曲线 + 还活着的日历/近况偏移（按权重淡出）。 */
export function effectiveTargets(s, at) {
  const base = s.self.targets || targetsFor(at);
  const out = { ...base };
  for (const entry of Object.values(s.self.targetOffsets || {})) {
    const w = weightOf(entry.at, entry.hl, at);
    if (w <= FLOOR) continue;
    for (const [k, v] of Object.entries(entry.value || {})) {
      if (out[k] === undefined) continue;
      out[k] = out[k] + Number(v) * w;
    }
  }
  for (const k of POOLS) out[k] = clamp(round1(out[k] ?? 55), 0, 100);
  return out;
}

// ── 各类事件 ────────────────────────────────────────────────────────────────

/**
 * 把状态里的 affect 按 `EMOTION_ALIASES` 归一到**老树键名**（`irritation`→`irk`、`excitement`→`cheer`）。
 *
 * ★ 为什么要这一步（票 N30）：渲染/聚合要按老树的三向（out/in/neu）与正负集合走，
 *   而盘上可能同时存在两套名字（生产 `emotion-state.json` 落的是新树 6 键，老树迁的是 14 键）。
 *   归一后 `POS_EMO`/`NEG_EMO`/方向聚合只需认老树一套键，不必到处写 `||`。
 *   **只读不改**：返回值是新对象，`state` 里的键名一个都不动（写盘仍按各自原名）。
 */
function normalizeEmoKeys(affect) {
  const out = {};
  for (const [k, v] of Object.entries(affect || {})) {
    const key = EMOTION_ALIASES[k] || k;
    const n = Number(v) || 0;
    out[key] = key === k ? n : (out[key] || 0) + n;   // 别名与原键同时存在时相加，不静默覆盖
  }
  return out;
}

/** 导给渲染层用（hint.js / catalog 聚合都按老树键名读）。 */
export { normalizeEmoKeys };

function onMessage(s, event, at) {
  const e = event.evidence;
  const key = String(event.idempotencyKey || '') || makeIdempotencyKey(e.chatKey, String(e.id), 'emotion:absorb');
  if (!remember(s, key, at)) return;

  // ★ 2026-10-15（用户裁定 · 情绪缺口第二组）：消息**不再逐条扣四池** —— 池成本改由本轮 `round`
  //   事件按发送条数一次算（老树 applyRunToBotState:1157-1164；改前一轮 8 条短消息认知 ≈ -9.6，
  //   老树同情形 -2）。这里只保留「被点名声」的唤醒增量与"见过 TA"时间戳 —— 两者本来就是消息级事实。
  if (e.refs && e.refs.toSelf) {
    applySelf(s, { arousal: 6 }, { source: 'emotion-evidence', evidenceIds: [String(e.id)], at, label: 'absorb' });
  }

  // 只记「什么时候见过 TA」，不当成打分：关系变化（好感/信任/边界/语气）要由 relationDelta 带原因来。
  // （2026-10-16：熟悉度已退役，本条原话里的"熟悉度"不再适用。）
  const pid = String(e.sender?.id ?? '');
  if (pid) {
    const p = person(s, pid, at);
    p.lastSeenAt = at;
  }
}

/**
 * emotionEvidence / 环境表的公共落盘口：逐键按池值软增益（ramp/posRamp）后写 self。
 * 软增益分界（旧表 floors[2]=55, posFloors[1]=40）按别名归一，让 `irritation`/`excitement`
 * 与老树 `irk`/`cheer` 走同一道分界；只放大「涨」的那一半，扣减不打折。
 */
function applyEvidenceDeltas(s, rawDeltas, { source, evidenceIds, at, label, config = {}, amp = 1 } = {}) {
  const magnitude = clamp(Number(amp), 0, 1);
  const activity = resolveActivityConfig(config);
  const ramp = clamp(Number(activity.ramp) || 1, 0.5, 2.5);
  const posRamp = clamp(Number(activity.posRamp) || 1, 0.5, 1.5);
  const deltas = {};
  for (const [k, v] of Object.entries(rawDeltas || {})) {
    let d = Number(v) * magnitude;
    if (d > 0 && k.startsWith('affect.')) {
      const affectKey = k.slice(7);
      const cur = Number(s.self.affect[affectKey]) || Number(s.self.affect[EMOTION_ALIASES[affectKey]] || 0) || 0;
      if (POS_EMO.has(EMOTION_ALIASES[affectKey] || affectKey)) {
        if (cur < 40) d *= posRamp;
      } else {
        if (cur < 55) d *= ramp;
      }
    }
    deltas[k] = d;
  }
  if (!Object.keys(deltas).length) return;
  applySelf(s, deltas, { source, evidenceIds, at, label });
}

function onEvidence(s, event, at, ids, config = {}) {
  // ★ 2026-10-15（用户裁定 · 情绪缺口第一组）：同 kind 冷却 —— 词表 cue 与 finish 自评两个来源
  //   共用（老树 `allowEmote` bot-state.js:898-912 的语义）。只有**带 kind 的事件**受冷却；
  //   不带 kind 的旧形状事件维持原行为（不猜、不乱冷却）。窗内不写情绪，只落一行可查的跳过账。
  const cueKind = String(event?.kind ?? '').trim();
  if (cueKind && !allowEmoteKind(s, cueKind, at, event, ids)) return;
  // 老树亲密度口径：favor 50 以下不放大；只放大负向情绪的增长，消退和正向情绪照旧。
  // 只有事件明确给出 senderId 才能查关系；不从证据列表猜一个人。
  const senderId = String(event?.senderId ?? '').trim();
  const favor = senderId ? Number(s.persons?.[senderId]?.favor) : NaN;
  const closeness = Number.isFinite(favor) ? clamp((favor - 50) / 50, 0, 1) : 0;
  const sensitivity = Number(config.closenessSensitivity) || 1;
  const boost = 1 + closeness * 0.8 * sensitivity;
  const deltas = boost === 1 ? event.deltas : Object.fromEntries(
    Object.entries(event.deltas || {}).map(([key, value]) => {
      const affectKey = key.startsWith('affect.') ? key.slice(7) : '';
      const normalized = EMOTION_ALIASES[affectKey] || affectKey;
      const amount = Number(value);
      return [key, affectKey && NEG_EMO.has(normalized) && amount > 0 ? amount * boost : value];
    })
  );
  applyEvidenceDeltas(s, deltas, {
    source: event.source, evidenceIds: ids, at, label: 'evidence', config, amp: event.magnitude ?? 1
  });
}

/**
 * 整轮事实（2026-10-15 · 情绪缺口第二组）：环境事件 + 每轮成本 + 慢压。
 * 老树逐条对应 `applyRunToBotState`（bot-state.js:1097-1201）；新树把「本轮发生了什么」压成一颗
 * `round` 事件（由 M15 在轮末发一次），状态写入仍全部走本函数的 applySelf/台账。
 *
 * 纪律：
 *   · 池成本只在**机器人说过话**时收（n = 本轮确认发送条数），消息本身不再逐条扣（见 onMessage）；
 *   · 「没人接」只认 group 轮且机器人说过话 —— 旁人群聊本身不是对机器人的冷落（sentCount 门槛）；
 *   · 环境档冷却（envNeglect 10min / envBoredom 30min / anxiety 120s）走 allowEmoteKind，与 cue/自评同一道闸。
 */
function onRound(s, event, at, ids, config = {}) {
  const addressed = event.addressed === true;
  const kind = String(event.kind || 'group');
  const sentCount = Math.max(0, Math.floor(Number(event.sentCount) || 0));
  const triggerCount = Math.max(0, Math.floor(Number(event.triggerCount) || 0));
  const status = String(event.status || 'done');
  const cueKinds = Array.isArray(event.cueKinds) ? event.cueKinds.map((k) => String(k)) : [];
  const src = 'recent-situation';
  // ★ 2026-10-15 回修（复核 §4）：零入站轮（proactive/空入站但确实发言）没有聊天证据 id，也不许
  //   伪造 —— 台账证据槽用 `round@<roundId>` 重算键顶上（与 `decay@<at>` 同一约定：这是"哪一轮"的
  //   重算键，不是聊天证据）；事件本身的 evidenceIds 维持空数组（校验见 events.js 的 round 档）。
  const ledgerIds = ids.length ? ids : [`round@${String(event.roundId ?? '').trim() || at}`];

  // ── ① 每轮消耗（老树 :1157-1164）：认知按发送条数一次算；长批量/出错才动意志、身体。──
  const deltas = {};
  if (sentCount > 0) {
    deltas['pools.cognitive'] = -(sentCount >= 3 ? ROUND_COST.cognitiveFull : ROUND_COST.cognitiveLight);
  }
  if (status === 'error') deltas['pools.will'] = -ROUND_COST.errorWill;
  else if (sentCount >= ROUND_COST.willHeavySent) deltas['pools.will'] = -ROUND_COST.willHeavy;
  if (status === 'error') deltas['pools.physical'] = -ROUND_COST.errorPhysical;
  else if (sentCount >= ROUND_COST.physicalHeavySent) deltas['pools.physical'] = -ROUND_COST.physicalHeavy;

  // ── ② socialHeavy（老树 :789-799）：一轮发得多且不是纯正向 ⇒ 情绪池 -6、烦躁 +2；
  //    无聊 +3 单独过 envBoredom 冷却（老树同一道闸，与"连着没人接"的无聊互斥）。──
  const purePositive = cueKinds.length > 0 && cueKinds.every((k) => PURE_POSITIVE_KINDS.includes(k));
  const socialHeavy = sentCount >= SOCIAL_HEAVY_SENT_THRESHOLD && !purePositive;
  if (socialHeavy) {
    deltas['pools.emotional'] = Number(deltas['pools.emotional'] || 0) + Number(ENV_KIND_DELTAS.socialHeavy['pools.emotional']);
    deltas['affect.irk'] = Number(deltas['affect.irk'] || 0) + Number(ENV_KIND_DELTAS.socialHeavy['affect.irk']);
  }
  if (Object.keys(deltas).length) {
    applySelf(s, deltas, { source: src, evidenceIds: ledgerIds, at, label: 'round-cost' });
  }
  if (socialHeavy && allowEmoteKind(s, 'envBoredom', at, { source: src }, ledgerIds)) {
    applyEvidenceDeltas(s, SOCIAL_HEAVY_BOREDOM_DELTA, { source: src, evidenceIds: ledgerIds, at, label: 'social-heavy', config });
  }

  // ── ③ 环境事件（老树 :1097-1142）：被冷落 / 无聊 / 刷屏 —— 判定与计数在 env-events.planRoundEnv。──
  const plan = planRoundEnv({
    addressed, kind, sentCount, triggerCount,
    streak: s.self.ignoredStreak, streakAt: s.self.ignoredStreakAt, at,
    lastEmoteAt: isPlainObject(s.self.lastEmoteAt) ? s.self.lastEmoteAt : {}
  });
  s.self.ignoredStreak = plan.streak;
  s.self.ignoredStreakAt = plan.streakAt;
  for (const planned of plan.events) {
    if (!allowEmoteKind(s, planned.kind, at, { source: src }, ledgerIds)) continue;
    applyEvidenceDeltas(s, ENV_KIND_DELTAS[planned.kind], {
      source: src, evidenceIds: ledgerIds, at, label: planned.kind, config
    });
    // 无聊真触发后才把这一段清零（老树 :1135 在同位；被冷却拦下的轮不许吞 streak）。
    if (planned.resetStreak === true) {
      s.self.ignoredStreak = 0;
      s.self.ignoredStreakAt = 0;
    }
  }

  // ── ④ 运行出错加急压（老树 :1166-1168）：必须在慢压读 acuteStress **之前**施加
  //    （老树顺序：消耗 → 出错 +6 → 慢压），否则 (acute-50)*0.04 那一腿会少算这 6 点。
  //    错误 kind 的情绪腿不搬（新树 toolResult 另有通路）。──
  if (status === 'error') {
    applySelf(s, { acuteStress: ROUND_COST.errorAcute }, { source: src, evidenceIds: ledgerIds, at, label: 'round-error' });
  }

  // ── ⑤ 慢压（老树 :1171-1201）：说过话 +0.4、急压 >50 再加一点；积满 1 进 chronicStress；
  //    ≥45 起每轮带出焦虑/低落（120s 冷却 = 老树 allowEmote('anxiety')）。──
  const acute = Number(s.self.acuteStress) || 0;
  s.self.chronicPush = (Number(s.self.chronicPush) || 0)
    + (sentCount > 0 ? SLOW_PRESSURE.chatGain : 0)
    + (acute > 50 ? (acute - 50) * SLOW_PRESSURE.acuteScale : 0);
  if (s.self.chronicPush >= 1) {
    const step = Math.floor(s.self.chronicPush);
    s.self.chronicPush = round1(s.self.chronicPush - step);
    applySelf(s, { chronicStress: step }, { source: src, evidenceIds: ledgerIds, at, label: 'slow-pressure' });
  }
  const cs = Number(s.self.chronicStress) || 0;
  if (cs >= SLOW_PRESSURE.threshold) {
    const push = Math.min(SLOW_PRESSURE.pushCap, (cs - SLOW_PRESSURE.threshold) * SLOW_PRESSURE.pushScale);
    if (push >= SLOW_PRESSURE.minPush && allowEmoteKind(s, 'anxiety', at, { source: src }, ledgerIds)) {
      const d = {};
      const anx = Math.round(push);
      const down = Math.round(push * SLOW_PRESSURE.downRatio);
      if (anx) d['affect.anxiety'] = anx;
      if (down) d['affect.down'] = down;
      if (Object.keys(d).length) applySelf(s, d, { source: src, evidenceIds: ledgerIds, at, label: 'slow-pressure' });
    }
  }
}

function onTool(s, event, at, ids) {
  const deltas = event.ok
    ? { 'pools.cognitive': -0.5, chronicStress: -2, 'affect.anxiety': -4 }
    : { 'pools.cognitive': -2, acuteStress: 8, chronicStress: 2, 'affect.anxiety': 8 };
  applySelf(s, deltas, { source: 'tool', evidenceIds: ids, at, label: event.ok ? 'tool-ok' : 'tool-fail' });
}

function onFact(s, event, at, ids) {
  const hl = halfLifeOf(event.category);
  const rec = {
    text: String(event.claim).trim().slice(0, 60),
    at, bornAt: at, hl,
    category: String(event.category),
    source: String(event.source),
    evidenceIds: ids.slice(),
    renewed: 0, shown: 0
  };
  const pid = event.personId == null ? '' : String(event.personId);
  if (pid) {
    const p = person(s, pid, at);
    const map = event.category === 'preference' ? p.preferences : p.recentShared;
    noteInto(map, event.slot, rec, at);
    push(s, { target: `person:${pid}`, field: `note:${String(event.slot)}`, delta: 0, magnitude: 1, source: event.source, evidenceIds: ids });
  } else {
    const map = event.category === 'preference' ? s.self.preferences : s.self.facts;
    noteInto(map, event.slot, rec, at);
    push(s, { target: 'self', field: `note:${String(event.slot)}`, delta: 0, magnitude: 1, source: event.source, evidenceIds: ids });
  }
}

/** 日历只碰「恢复目标」，绝不直接改精力数值（docs §五：只是偏移，之后仍按时间曲线走）。 */
function onCalendar(s, event, at, ids) {
  const hl = halfLifeOf('calendar');
  const value = {};
  for (const [k, v] of Object.entries(event.offsets || {})) value[k] = clamp(Number(v), -12, 12);
  s.self.targetOffsets[`cal:${at}`] = { value, at, hl, source: event.source, evidenceIds: ids.slice() };
  push(s, { target: 'self', field: 'restore-target', delta: round1(Object.values(value).reduce((a, b) => a + b, 0)), magnitude: 1, source: event.source, evidenceIds: ids });
}

function onRelation(s, event, at, ids) {
  const pid = String(event.personId);
  const key = String(event.idempotencyKey);
  const changes = event.changes || {};
  // ★ 2026-10-16（熟悉度退役）：`familiarity` 接受但忽略。只带 legacy 字段且没有 shared 的事件
  //   = 无操作 ⇒ **整条忽略**（不占"每轮一次"槽、不记幂等键），保证旧事件回放既不写状态，
  //   也不会把同轮随后的真实 relationDelta 顶掉。
  const applicable = Object.entries(changes)
    .filter(([field]) => field === 'tone' || RELATION_FIELDS.includes(field));
  const hasShared = typeof event.shared === 'string' && event.shared.trim() !== '';
  if (!applicable.length && !hasShared) return;
  const p = person(s, pid, at);
  const roundId = String(event.roundId || ids[0] || key);

  if (p.lastScoredRound === roundId) {
    // ★ 2026-10-11 裁定 A（写侧）：台账行必须带 `at` —— 没有时间的记录不算记录
    //   （view.js recentChanges 一直投影 `r.at`，行上没有就投影成 undefined ⇒ 读侧做不了）。
    push(s, { at, target: `person:${pid}`, field: 'relation-skipped', delta: 0, magnitude: 0, source: event.source, evidenceIds: ids, rejected: 'scored-once-per-round' });
    return;
  }
  if (!remember(s, key, at)) return;

  const touched = [];
  for (const [field, raw] of applicable) {
    if (field === 'tone') { p.tone = String(raw); touched.push('tone'); continue; }
    const cap = field === 'favor' ? FAVOR_CAP : RELATION_CAP;
    const delta = clamp(Number(raw), -cap, cap);
    const before = p[field];
    p[field] = round1(clamp(before + delta, 0, 100));
    touched.push(field);
    // ★ 裁定 A：favor 等关系字段的台账行带 `at`（= event.at，轮末真实时刻）+ 数值变化
    //   （before/after/delta 本来就有）—— 好感页签的读侧（B，投影 M7）在等这一行。
    push(s, { at, target: `person:${pid}`, field, before, after: p[field], delta: round1(p[field] - before), magnitude: Math.abs(round1(p[field] - before)) / cap, source: event.source, evidenceIds: ids, reason: String(event.reason) });
  }
  if (typeof event.shared === 'string' && event.shared.trim()) {
    noteInto(p.recentShared, `shared:${at}`, {
      text: event.shared.trim().slice(0, 60), at, bornAt: at, hl: halfLifeOf('impression'),
      category: 'impression', source: event.source, evidenceIds: ids.slice(), renewed: 0, shown: 0
    }, at);
  }
  p.lastScoredRound = roundId;
  // ★ 2026-10-11（glm1 · 功能表 4+5）：`reasonText` 保留**模型原话**（≤60 字，照老树
  //   `src/memory.js:1742` 的 slice(0,60) 口径）—— `reason` 是归类后的类别词，
  //   而老树提示词里「·因+5：他今天主动帮忙了」念的是原话（memory/prompt-format.js 的
  //   favorWhyLine）。没有它，注入会退化成英文类别词。原话缺失时不写这个键（不写空串）。
  p.lastChange = { at, source: event.source, reason: String(event.reason), evidenceIds: ids.slice(), fields: touched,
    ...(typeof event.reasonText === 'string' && event.reasonText.trim() ? { reasonText: event.reasonText.trim().slice(0, 60) } : {}) };
}

/** 模型自己说出来的话：只进 pending，等外部证据来确认；**不碰任何数值**。 */
function onStatement(s, event, at) {
  s.pending.push({
    kind: 'role-statement',
    claim: String(event.claim).trim().slice(0, 80),
    personId: event.personId == null ? '' : String(event.personId),
    at,
    status: 'unconfirmed'
  });
  push(s, { target: event.personId ? `person:${event.personId}` : 'self', field: 'statement', delta: 0, magnitude: 0, source: 'role-statement', evidenceIds: [] });
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

function applySelf(s, deltas, { source, evidenceIds, at, label }) {
  for (const [field, raw] of Object.entries(deltas || {})) {
    if (raw === 0 || !Number.isFinite(Number(raw))) continue;
    const delta = clamp(Number(raw), -SELF_FIELD_CAP, SELF_FIELD_CAP);
    let before;
    let after;
    if (field.startsWith('pools.')) {
      const k = field.slice(6);
      before = s.self.pools[k];
      // ★ 票 E-2 · P7：**认知**的扣减越低越轻（老树 `src/bot-state.js:621-626` / `:1158-1162` 的软底）。
      //   只打折减法：`涨认知`（回血）不打折，所以恢复速度与改前逐位相同。
      //   身体/意志/情绪池的扣减**一律不打折**（规格只说了认知）。
      const eff = (k === 'cognitive' && delta < 0) ? delta * cognitiveDrainScale(before) : delta;
      after = round1(clamp(before + eff, 0, 100));
      s.self.pools[k] = after;
    } else if (field.startsWith('affect.')) {
      const k = field.slice(7);
      before = s.self.affect[k];
      after = round1(clamp(before + delta, 0, 100));
      s.self.affect[k] = after;
    } else {
      before = s.self[field];
      after = round1(clamp(before + delta, 0, 100));
      s.self[field] = after;
    }
    const applied = round1(after - before);
    s.self.lastChange = { at, field, delta: applied, magnitude: Math.abs(applied) / SELF_FIELD_CAP, source, evidenceIds: evidenceIds.slice(), label };
    push(s, { target: 'self', field, before, after, delta: applied, magnitude: Math.abs(applied) / SELF_FIELD_CAP, source, evidenceIds });
  }
}

function person(s, pid, at) {
  if (!s.persons[pid]) s.persons[pid] = normalizePerson(pid, {}, at);
  return s.persons[pid];
}

/** 同槽位覆盖 + 同说法续期有上限（反复念同一句不该无限续命）。 */
function noteInto(map, slot, rec, at) {
  const k = String(slot || 'misc').toLowerCase();
  if (map[k] && String(map[k].text) === rec.text) {
    const prev = map[k];
    const bornAt = Number(prev.bornAt) || Number(prev.at) || at;
    const cap = bornAt + prev.hl * RENEW_CAP_FACTOR * 60 * 1000;
    prev.at = Math.max(Number(prev.at) || 0, Math.min(at, cap));
    prev.renewed = (Number(prev.renewed) || 0) + 1;
    prev.evidenceIds = [...new Set([...(prev.evidenceIds || []), ...rec.evidenceIds])].slice(-8);
    return;
  }
  map[k] = rec;
}

/**
 * 写一行台账。**两根轴都在这里定默认值**，所以"这行是被什么引起的"永远查得到：
 *   · `kind`          —— `'event'`（外部证据引起，events.js 进来的）/ `'decay'`（时间结算引起）。
 *   · `deterministic` —— 默认 false（依赖外部证据）；纯时间结算行显式传 true（可重算、不依赖证据）。
 * 两根都是**可枚举**的小集合，不新增自由文本字段。
 */
function push(s, row) {
  s.seq = (Number(s.seq) || 0) + 1;
  s.ledger.push({ seq: s.seq, kind: 'event', deterministic: false, ...row });
}

function remember(s, key, at) {
  if (s.appliedKeys[key]) return false;
  s.appliedKeys[key] = { at };
  return true;
}

/**
 * 老树 `allowEmote`（bot-state.js:898-912）在新树的等价物：同 kind 时间窗。
 *   · 120s 普通 / 180s 高频闲聊类（值表唯一来源 = inbound-cue.js 的 `cooldownMsForKind`）；
 *   · 时间戳放 `self.lastEmoteAt[kind]` —— 与状态**同生共死**（state-owner.flush 落盘；
 *     无 dataDir / unmigrated 时与全状态一样不落盘）。**不放 `appliedKeys`**：那张表按
 *     MAX_KEYS 修剪，会被逐条消息的幂等键日积月累挤掉，冷却会被静默忘掉；
 *   · 窗内拦截落一行 `field:'cooldown'` 的跳过账（带 source/evidenceIds 可回溯），
 *     台账/面板能回答"为什么这次没动"。
 * 返回 true = 允许本次写入（并盖下新时间戳）。
 */
function allowEmoteKind(s, kind, at, event, ids) {
  const cd = cooldownMsForKind(kind);
  if (!cd) return true;
  const lastEmoteAt = isPlainObject(s.self?.lastEmoteAt) ? s.self.lastEmoteAt : {};
  const stamp = Number(lastEmoteAt[kind]) || 0;
  if (stamp && at - stamp < cd) {
    // 台账行只加 `cueKind`，**不动 `kind`** —— `kind` 是台账自己的封闭轴（'event'/'decay'）。
    push(s, {
      at, target: 'self', field: 'cooldown', delta: 0, magnitude: 0,
      source: event?.source, evidenceIds: ids, rejected: 'same-kind-cooldown', cueKind: kind
    });
    return false;
  }
  if (!isPlainObject(s.self.lastEmoteAt)) s.self.lastEmoteAt = {};
  s.self.lastEmoteAt[kind] = at;
  return true;
}

function prune(s, at) {
  dropDead(s.self.facts, at);
  dropDead(s.self.preferences, at);
  dropDead(s.self.targetOffsets, at);
  for (const p of Object.values(s.persons)) {
    dropDead(p.preferences, at);
    p.recentShared = liveOnly(p.recentShared, at);
    p.openEvents = liveOnly(p.openEvents, at);
  }
}

function dropDead(map, at) {
  for (const [k, e] of Object.entries(map || {})) {
    const w = weightOf(e?.at, Number(e?.hl) || 60, at);
    if (w < DEAD) delete map[k];
  }
}

function liveOnly(list, at) {
  if (!Array.isArray(list)) return [];
  return list.filter((e) => weightOf(e?.at, Number(e?.hl) || 60, at) > FLOOR);
}

function trim(s) {
  if (s.ledger.length > MAX_LEDGER) s.ledger = s.ledger.slice(-MAX_LEDGER);
  if (s.pending.length > MAX_PENDING) s.pending = s.pending.slice(-MAX_PENDING);
  const keys = Object.keys(s.appliedKeys);
  if (keys.length > MAX_KEYS) for (const k of keys.slice(0, keys.length - MAX_KEYS)) delete s.appliedKeys[k];
}
