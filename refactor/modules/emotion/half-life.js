/**
 * M7 emotion · 半衰期类别表 + 衰减算术（纯函数，不碰文件、不认识业务）
 *
 * 依据：docs §五（四池跟随目标）、§八（关系是慢变量）；验收第 12/13 条。
 * 口径与 refactor/modules/emotion/state.js 里的注释一致。
 */

export const FLOOR = 0.25;
export const DEAD = 0.06;

const MIN_MS = 60 * 1000;

/**
 * 类别 → 半衰期（分钟）。
 * 临时情绪以「分钟」计；偏好以「月」计；关系以「季度」计 —— 不许把慢变量喂给短半衰期。
 */
export const HALF_LIFE_MIN = Object.freeze({
  impulse: 6,
  mood: 16,
  energy: 15,
  // ★ 2026-10-07（票 E-2 · 漂移 P5/P6）：四池**不再共用** `energy` 一个半衰期。
  //   规格：情绪精力「向 55 回落，半衰约 4 分钟」／意志「较慢地向 55 回落」。
  //   老树口径：src/bot-state.js:299 情绪池 `ke` 半衰 4 分钟；:301 意志 = `kf * 0.6`
  //   ⇒ 15 × 0.6 = 25 分钟。身体/认知仍用 `energy`（15），一字未动。
  //   ⚠ 既有键**一律不改名**（`impulse/mood/energy/…` 被别的模块按名读，改名会炸），
  //   这两个是**新增**具名类别；未知类别照旧 throw（见 halfLifeOf）。
  emotionPool: 4,
  willPool: 25,
  acuteStress: 8,
  calendar: 720,
  chronicStress: 4320,
  episode: 240,
  impression: 4320,
  tone: 20160,
  preference: 43200,
  relation: 129600
});

export const HALF_LIFE_CATEGORIES = Object.freeze(Object.keys(HALF_LIFE_MIN));

/**
 * 精力池 → 半衰期类别（票 E-2 · P5/P6）。
 * 改前 `settle` 对四池一律 `halfLifeOf('energy')`，等于让情绪池背了「身体/认知」的慢半衰
 * （慢 3.75×）、让意志池被按 15 分钟回血（快 1.67×）—— 两条都与规格相反。
 */
export const POOL_HALF_LIFE_CATEGORY = Object.freeze({
  physical: 'energy',
  cognitive: 'energy',
  emotional: 'emotionPool',
  will: 'willPool'
});

/** 池 → 半衰期（分钟）。未知池名照旧抛错，不静默兜底成 `energy`。 */
export function poolHalfLifeOf(pool) {
  const key = String(pool || '');
  if (!Object.prototype.hasOwnProperty.call(POOL_HALF_LIFE_CATEGORY, key)) {
    throw new Error(`emotion: 未知精力池 "${key}"（允许：${Object.keys(POOL_HALF_LIFE_CATEGORY).join('|')}）`);
  }
  return halfLifeOf(POOL_HALF_LIFE_CATEGORY[key]);
}

export function halfLifeOf(category, config = {}) {
  const key = String(category || '');
  if (!Object.prototype.hasOwnProperty.call(HALF_LIFE_MIN, key)) {
    throw new Error(`emotion: 未知半衰期类别 "${key}"（允许：${HALF_LIFE_CATEGORIES.join('|')}）`);
  }
  let base = HALF_LIFE_MIN[key];
  if ((key === 'impulse' || key === 'mood') && config.halfLifeMul) {
    base *= Number(config.halfLifeMul);
  }
  return base;
}

export function minutesBetween(at, since) {
  const a = Number(at);
  const b = Number(since);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, (a - b) / MIN_MS);
}

/** 一条记录此刻的权重（1 = 和刚写下时一样）。 */
export function weightOf(at, halfLifeMin, now) {
  const hl = Math.max(1, Number(halfLifeMin) || 1);
  const born = Number(at);
  if (!Number.isFinite(born) || born <= 0) return 0;
  return Math.pow(0.5, minutesBetween(now, born) / hl);
}

/** 指数趋向目标：dt 越大越贴目标，永远不会越过目标。 */
export function decayToward(value, target, halfLifeMin, dtMin) {
  const v = Number(value);
  const t = Number(target);
  if (!Number.isFinite(v)) return t;
  if (!Number.isFinite(dtMin) || dtMin <= 0) return v;
  const hl = Math.max(1, Number(halfLifeMin) || 1);
  return t + (v - t) * Math.pow(0.5, dtMin / hl);
}

/** 给模型看的人话年龄（刻意粗，精确到分钟模型会去算）。 */
export function ageLabel(ageMin) {
  const m = Number(ageMin);
  if (!Number.isFinite(m) || m < 0) return '';
  if (m < 2) return '刚刚';
  if (m < 10) return '几分钟前';
  if (m < 50) return '半小时左右';
  if (m < 90) return '1小时前';
  if (m < 60 * 20) return '几个小时前';
  if (m < 60 * 48) return '昨天';
  if (m < 60 * 24 * 8) return '几天前';
  if (m < 60 * 24 * 45) return '几周前';
  return '很久以前';
}
