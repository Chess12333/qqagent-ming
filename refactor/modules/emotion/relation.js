/**
 * M7 emotion · 关系读取（按人；跨群共享的是 self，不是这里）
 *
 * §八 的形状：一段关系最多给「好感 / 信任·边界 / 互动语气 / 最近共同经历」，
 * 每个都能回到证据；**不报数给模型**（数字只给 snapshot/UI 看）。
 * ★ 2026-10-16（用户裁定）：**熟悉度 familiarity 已退役** —— 关系用好感（favor）表达；
 *   旧 JSON 里若仍带 familiarity：这里不再读出、归一化时也被忽略（不报错）。
 */
import { PERSON_DEFAULTS, normalizePerson, clone, isPlainObject } from './state.js';
import { weightOf, FLOOR, ageLabel, minutesBetween } from './half-life.js';

export function relationOf(state, personId) {
  if (!isPlainObject(state)) throw new Error('emotion.relationOf: 需要状态对象');
  const pid = String(personId ?? '');
  if (!pid) throw new Error('emotion.relationOf: personId 必须是关键系（关系是按人的）');
  const at = Number(state.self?.lastSettledAt) || 0;
  const raw = state.persons?.[pid];
  const p = isPlainObject(raw) ? raw : normalizePerson(pid, {}, at);

  return {
    personId: pid,
    known: !!raw,
    trust: round(p.trust, PERSON_DEFAULTS.trust),
    boundary: round(p.boundary, PERSON_DEFAULTS.boundary),
    favor: round(p.favor, PERSON_DEFAULTS.favor),
    tone: p.tone || PERSON_DEFAULTS.tone,
    recentShared: liveList(p.recentShared, at),
    preferences: liveList(Object.values(p.preferences || {}), at),
    openEvents: liveList(p.openEvents, at),
    lastChange: p.lastChange ? clone(p.lastChange) : null
  };
}

function round(x, dflt) {
  const v = Number(x);
  return Number.isFinite(v) ? v : dflt;
}

/** 还活着的条目，新的在前；把「多久之前」说成人话。 */
function liveList(list, at) {
  if (!Array.isArray(list)) list = Object.values(list || {});
  return list
    .map((e) => {
      const w = weightOf(e?.at, Number(e?.hl) || 60, at);
      return { text: String(e?.text || ''), weight: Math.round(w * 1000) / 1000, age: ageLabel(minutesBetween(at, Number(e?.at) || 0)), source: e?.source || '', evidenceIds: Array.isArray(e?.evidenceIds) ? e.evidenceIds.slice() : [] };
    })
    .filter((x) => x.text && x.weight > FLOOR)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6);
}
