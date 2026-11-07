/**
 * M7 emotion · styleHint（给提示词的**一句**可行动倾向）
 *
 * 票面第 7 条 + docs §五重构建议：不要把四个数字塞进上下文；只给「这会儿该怎么说话」的倾向。
 * ★ 这里没有任何「要不要开口」的话术：低精力只让回答更短，不产生沉默/消失的建议（验收第 12 条）。
 */
import { POOLS, isPlainObject } from './state.js';
import { effectiveTargets } from './apply.js';


export function styleHint(state, opts = {}) {
  if (!isPlainObject(state)) throw new Error('emotion.styleHint: 需要状态对象');
  const s = state.self || {};
  const at = Number(s.lastSettledAt) || 0;
  const goal = effectiveTargets(state, at);
  const avgPool = POOLS.reduce((a, k) => a + Number(s.pools?.[k] ?? 0), 0) / POOLS.length;

  const cognitive = Number(s.pools?.cognitive ?? 100);
  const will = Number(s.pools?.will ?? 100);
  const physical = Number(s.pools?.physical ?? 100);
  const emotional = Number(s.pools?.emotional ?? 100);

  if (cognitive <= goal.cognitive - 18 || cognitive <= 40 || will <= 40) {
    return '这会儿更适合简短回答，先把重点说清楚，复杂的地方先确认一句。';
  }
  if (avgPool <= 45) return '整体偏累，语气放平，少绕弯。';
  if (physical <= 40) return '身上发沉，长篇留给必要的部分。';
  if (emotional <= 40) return '情绪储备薄，用词朴素一点，先别开玩笑。';

  if (Number(s.acuteStress ?? 0) >= 60) return '刚被刺激过，先稳住再回，别急着顶回去。';
  if (Number(s.chronicStress ?? 0) >= 60) return '一直绷着，能一句说完的别铺三段。';

  const irritation = Number(s.affect?.irritation ?? 0);
  if (irritation >= 55) return '有点上火，说事实、别加刺。';
  if (Number(s.affect?.loneliness ?? 0) >= 55) return '有点冷清，可以主动多问一句。';

  if (Number(s.arousal ?? 50) >= 75) return '节奏偏快，收着点，一次别塞太多。';
  if (Number(s.mood ?? 50) >= 70) return '心情不错，可以轻松一点。';

  const pid = opts.personId == null ? '' : String(opts.personId);
  if (pid) {
    const p = state.persons?.[pid];
    if (p) {
      // ★ 2026-10-16（熟悉度退役）：原「familiarity ≥ 60 且 tone=warm ⇒ 和 TA 熟…」一条删除 ——
      //   它的前提字段已退役；语气侧信息由 renderRelationSummary 的 tone 子句承担。
      if (Number(p.boundary) >= 70) return '跟这位保持礼貌距离，别乱开玩笑。';
    }
  }
  return '';
}

/**
 * renderRelationSummary —— 把「关系」渲染成提示词用的一小段人话（§3.5 登记，消费者 M15 → M8b）。
 *
 * 为什么渲染归 M7（指挥位 2026-10-04 裁定）：`relation` 是 §3.6 里 **M7 拥有的不透明对象**，
 * 只有我知道 `favor/boundary/tone` 各档该怎么说；M8b 只该认字符串，不该认识字段。
 *
 * ★ 2026-10-16（用户裁定）：**熟悉度 familiarity 已退役** —— 关系状态以**好感（favor）的实际档位为主**；
 *   默认中性（40–60，含默认 50）也给一句自然中性文案，避免整段空白或与好感矛盾；
 *   不拿"熟"的说法表达好感（反之亦然）；trust/boundary/tone/共同经历各自独立照旧。
 *
 * 三条硬约束：
 *   1. **不念数值**（与 styleHint 同一口径：数字只给 snapshot/UI）；条目文字里带数字就整条丢掉。
 *   2. **长度有界**：≤ `RELATION_SUMMARY_MAX_CHARS`（120 字符），装不下就少说一档，不硬截半句。
 *   3. **不许抛**：空/异常/缺字段的入参返回空串 —— 提示词少一段不致命，主链断掉致命。
 */
export const RELATION_SUMMARY_MAX_CHARS = 120;

/** 只认真数字：`null`/`''` 会被 Number() 变成 0，那会让缺字段的人被当成「很生分」渲染出来。 */
function asNum(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : NaN;
}

export function renderRelationSummary(relation) {
  if (!isPlainObject(relation)) return '';
  const favor = asNum(relation.favor);
  const trust = asNum(relation.trust);
  const boundary = asNum(relation.boundary);

  const clauses = [];
  // 关系状态以好感档位为主（熟悉度已退役）。favor 缺失（NaN）时不出这句 —— 不拿"中性"冒充未知。
  if (Number.isFinite(favor)) {
    if (favor >= 78) clauses.push('对这个人好感很高');
    else if (favor >= 60) clauses.push('对这个人挺有好感');
    else if (favor <= 22) clauses.push('对这个人好感很低');
    else if (favor <= 40) clauses.push('对这个人好感偏低');
    else clauses.push('对这个人印象平常');
  }
  if (Number.isFinite(boundary) && boundary >= 70) clauses.push('保持距离，别乱开玩笑');
  else if (Number.isFinite(trust) && trust >= 70) clauses.push('可以少解释、多做');
  else if (Number.isFinite(trust) && trust <= 30) clauses.push('先把话说清，别急着承诺');

  const tone = String(relation.tone || '');
  if (tone === 'warm') clauses.push('语气可以轻松');
  else if (tone === 'guarded') clauses.push('收着点，别套近乎');
  else if (tone === 'teasing') clauses.push('可以接梗');
  else if (tone === 'formal') clauses.push('按正式来');

  const shared = Array.isArray(relation.recentShared)
    ? relation.recentShared.find((x) => x && typeof x.text === 'string' && x.text.trim() && !/\d/.test(x.text))
    : null;
  if (shared) clauses.push(`最近一起聊过「${shared.text.trim().slice(0, 24)}」`);
  if (Array.isArray(relation.openEvents) && relation.openEvents.some((x) => x && x.text)) clauses.push('还有件没聊完的事');

  let out = '';
  for (const c of clauses) {
    const next = out ? `${out}；${c}` : c;
    if (next.length > RELATION_SUMMARY_MAX_CHARS) break;
    out = next;
  }
  return out;
}
