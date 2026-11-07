export const FLOOR = 0.25;   // 低于这个权重不再注入（= 2 个半衰期）
export const DEAD = 0.06;    // 低于这个权重直接删（≈ 4 个半衰期）

const MIN = 60 * 1000;

/** 半衰权重 0~1。`at` 是最后一次"刷新"时间；hl 非法时按 60 分钟兜底。 */
export function weightOf(entry, now = Date.now(), fallbackHalfLifeMin = 60) {
  const hl = Math.max(1, Number(entry?.hl) || Number(fallbackHalfLifeMin) || 60);
  const at = Number(entry?.at) || 0;
  if (!at) return 0;
  const ageMin = Math.max(0, (now - at) / MIN);
  return Math.pow(0.5, ageMin / hl);
}

/**
 * 一条的完整衰减信息。
 * @returns {{ text:string, hl:number, at:number, ageMin:number, weight:number,
 *             alive:boolean, dead:boolean, minsLeft:number }}
 *   minsLeft = 还剩多少分钟掉到 FLOOR 以下（给控制台显示"这条还能站多久"）
 */
export function decayInfo(entry, now = Date.now(), fallbackHalfLifeMin = 60) {
  const hl = Math.max(1, Number(entry?.hl) || Number(fallbackHalfLifeMin) || 60);
  const at = Number(entry?.at) || 0;
  const ageMin = at ? Math.max(0, (now - at) / MIN) : Infinity;
  const weight = at ? Math.pow(0.5, ageMin / hl) : 0;
  return {
    text: String(entry?.text || ''),
    hl,
    at,
    ageMin,
    weight: Math.round(weight * 1000) / 1000,
    // 严格大于：权重正好落到 0.25（= 旧 TTL 的到期时刻）就算过期，和老行为逐秒对齐
    alive: weight > FLOOR,
    dead: weight < DEAD,
    minsLeft: Math.max(0, Math.round(hl * Math.log2(1 / FLOOR) - ageMin))
  };
}

/**
 * 记一条（同 key 覆盖 = 一致性底线：同一个槽位任何时刻只有一个说法）。
 *
 * ⚠️ 同一句话被反复"捕获"不该无限续命（世界账本实测过：她说"我更饿了" → 被正则抓成
 * 「还没吃」→ 注入 → 她又提饿 → 再抓一次把时间重新拨满，于是这条能挂一整天）。
 * 所以同文本续期有总寿命上限 capFactor×hl，并且**不重置 shown**。
 *
 * @param {object} map    存放槽位的对象（会被就地修改）
 * @param {string} key    槽位名
 * @param {string} text   说法
 * @param {{ halfLifeMin:number, now?:number, capFactor?:number, maxKeys?:number,
 *           onEvict?:(key:string, entry:object)=>void }} opts
 */
export function noteEntry(map, key, text, { halfLifeMin, now = Date.now(), capFactor = 1.5, maxKeys = 8, onEvict = null } = {}) {
  const k = String(key || 'misc').toLowerCase();
  const t = String(text || '').trim().slice(0, 60);
  if (!t) return null;
  const hl = Math.max(1, Math.min(1440, Number(halfLifeMin) || 60));
  if (!map || typeof map !== 'object') return null;
  const prev = map[k];
  if (prev && String(prev.text || '') === t) {
    const base = Number(prev.hl) || hl;
    const bornAt = Number(prev.bornAt) || Number(prev.at) || now;
    const cap = bornAt + base * capFactor * MIN;
    prev.at = Math.max(Number(prev.at) || 0, Math.min(now, cap));
    prev.renewed = (Number(prev.renewed) || 0) + 1;
    return prev;
  }
  if (prev && onEvict) { try { onEvict(k, prev); } catch { /* ignore */ } }
  map[k] = { text: t, at: now, bornAt: now, hl, shown: 0, renewed: 0 };
  // 槽位上限：超了就丢最旧、权重最低的那个（别让人物文件无限长）
  const keys = Object.keys(map);
  if (keys.length > Math.max(1, maxKeys)) {
    for (const old of keys
      .map((x) => ({ x, w: weightOf(map[x], now, hl) }))
      .sort((a, b) => a.w - b.w)
      .slice(0, keys.length - Math.max(1, maxKeys))) {
      delete map[old.x];
    }
  }
  return map[k];
}

/** 还活着的条目，按权重降序（新/浓的在前）。 */
export function liveEntries(map, now = Date.now(), { floor = FLOOR, fallbackHalfLifeMin = 60 } = {}) {
  const out = [];
  for (const [key, entry] of Object.entries(map || {})) {
    const info = decayInfo(entry, now, fallbackHalfLifeMin);
    if (!info.text || info.weight <= floor) continue;
    out.push({ key, ...info, shown: Number(entry?.shown) || 0, renewed: Number(entry?.renewed) || 0 });
  }
  return out.sort((a, b) => b.weight - a.weight);
}

/** 清掉已经烂掉的槽位（写文件前顺手调用）。返回删了几条。 */
export function pruneEntries(map, now = Date.now(), { fallbackHalfLifeMin = 60 } = {}) {
  let removed = 0;
  for (const [key, entry] of Object.entries(map || {})) {
    const hl = Math.max(1, Number(entry?.hl) || fallbackHalfLifeMin);
    const ageMin = Number(entry?.at) ? (now - Number(entry.at)) / MIN : Infinity;
    // 用权重判，不用固定分钟数：hl 越长的条目留得越久（一致）
    if (ageMin === Infinity || Math.pow(0.5, ageMin / hl) < DEAD) { delete map[key]; removed += 1; }
  }
  return removed;
}

/**
 * 人话年龄（给模型看的）：刚刚 / 5分钟前 / 半小时前 / 2小时前 / 昨天。
 * 刻意粗：精确到分钟会让模型算出"这是 47 分钟前说的"然后念出来。
 */
export function ageLabel(ageMin) {
  const m = Number(ageMin);
  if (!Number.isFinite(m) || m < 0) return '';
  if (m < 2) return '刚刚';
  if (m < 10) return `${Math.round(m)}分钟前`;
  if (m < 50) return '半小时左右';
  if (m < 90) return '1小时前';
  if (m < 60 * 20) return `${Math.round(m / 60)}小时前`;
  return '昨天';
}
