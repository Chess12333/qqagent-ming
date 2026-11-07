/**
 * M7 emotion · snapshot（只读快照，给 UI/trace）
 *
 * docs §五：UI 要显示「四池当前值 + 最后一次变化来源 + 恢复目标 + 对应的发言」，
 * 不只画一个总平均数。数字只出现在这里，不出现在 styleHint 里。
 */
import { POOLS, clone, isPlainObject } from './state.js';
import { effectiveTargets } from './apply.js';
import { weightOf, FLOOR, ageLabel, minutesBetween } from './half-life.js';

export function snapshot(state) {
  if (!isPlainObject(state)) throw new Error('emotion.snapshot: 需要状态对象');
  const s = state.self || {};
  const at = Number(s.lastSettledAt) || 0;
  const goal = effectiveTargets(state, at);

  const pools = {};
  for (const k of POOLS) {
    pools[k] = { value: Number(s.pools?.[k] ?? 0), restoreTarget: goal[k] };
  }

  const persons = {};
  for (const [pid, p] of Object.entries(state.persons || {})) {
    // ★ 2026-10-16（熟悉度退役）：投影里不再给 familiarity（旧 JSON 该键由 normalizePerson 忽略）。
    persons[pid] = {
      trust: p.trust, boundary: p.boundary, favor: p.favor, tone: p.tone,
      recentShared: briefList(p.recentShared, at),
      preferences: briefList(Object.values(p.preferences || {}), at),
      lastChange: p.lastChange ? clone(p.lastChange) : null
    };
  }

  return {
    schemaVersion: state.schemaVersion,
    at,
    self: {
      pools,
      mood: s.mood,
      arousal: s.arousal,
      acuteStress: s.acuteStress,
      chronicStress: s.chronicStress,
      affect: clone(s.affect || {}),
      restoreTargets: goal,
      facts: briefList(Object.values(s.facts || {}), at),
      preferences: briefList(Object.values(s.preferences || {}), at),
      lastChange: s.lastChange ? clone(s.lastChange) : null
    },
    persons,
    pending: (state.pending || []).map((x) => ({ ...clone(x) })),
    recentChanges: (state.ledger || []).slice(-20).map((r) => ({
      seq: r.seq, at: r.at, target: r.target, field: r.field, delta: r.delta,
      magnitude: r.magnitude, source: r.source, evidenceIds: (r.evidenceIds || []).slice(),
      // ★ 票 E-2 · 裁定①：台账必须能一眼把"聊天引起的"和"时间引起的"分开 ⇒ 把 `kind`/`deterministic` 投影出去。
      //   `kind` 是可枚举小集合：`event`（外部证据）／`decay`（时间结算步）；`deterministic` 只表示
      //   "只由 (池值, 目标, dt) 决定、可重算"，不表示"这条不重要"。
      kind: r.kind ?? 'event', deterministic: r.deterministic === true,
      reason: r.reason, rejected: r.rejected
    }))
  };
}

function briefList(list, at) {
  if (!Array.isArray(list)) list = Object.values(list || {});
  return list
    .map((e) => ({
      text: String(e?.text || ''),
      weight: Math.round(weightOf(e?.at, Number(e?.hl) || 60, at) * 1000) / 1000,
      age: ageLabel(minutesBetween(at, Number(e?.at) || 0)),
      source: e?.source || '',
      evidenceIds: Array.isArray(e?.evidenceIds) ? e.evidenceIds.slice() : []
    }))
    .filter((x) => x.text && x.weight > FLOOR)
    .sort((a, b) => b.weight - a.weight);
}
