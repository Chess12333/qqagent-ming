/**
 * M7 emotion · 事件合同（applyEvent 的唯一入口形状）
 *
 * ★ 结构性约束（票面第 2/3 条靠它成立）：
 *   - 能改变状态的字段只有 `DELTA_FIELDS` 这一张白名单；白名单外的字段（例如有人塞 `shouldReply`）
 *     一律 `validateEvent` 判非法 → `applyEvent` 抛错。**否决表达不进这个状态模型。**
 *   - 变化必须有来源（`EVIDENCE_SOURCES`）+ 证据（`evidenceIds` 非空）。
 *   - `role-statement`（模型自己说出来的话）**不在**可施力来源里：它只能进 `pending` 当「待确认」。
 */
import { validateMessageEvidence } from '../../contracts/index.js';
import { AFFECT } from './state.js';
import { HALF_LIFE_CATEGORIES } from './half-life.js';

export const EVIDENCE_SOURCES = Object.freeze(['time', 'calendar', 'recent-situation', 'tool', 'emotion-evidence']);
/** 单独列出：不是可施力来源，只配被记成待确认。 */
export const STATEMENT_SOURCE = 'role-statement';

export const EMOTION_EVENT_TYPES = Object.freeze([
  'clock',
  'message',
  'round',
  'emotionEvidence',
  'toolResult',
  'lifeFact',
  'calendar',
  'relationDelta',
  'roleStatement'
]);

/**
 * 唯一能写入 self 的量化字段（白名单 = 没有别的口子）。
 *
 * ★ 票 N30：affect 维度**从 `state.js` 的 `AFFECT` 派生**，不再在这里手写一份 6 键列表。
 *   改前两处各有一份，改一处忘另一处就会出现「状态里有、却写不进去」的键
 *   （`cheer/pride/smug/gratitude` 就是这么空转的）。
 */
export const DELTA_FIELDS = Object.freeze([
  'pools.physical', 'pools.cognitive', 'pools.emotional', 'pools.will',
  'mood', 'arousal', 'acuteStress', 'chronicStress',
  ...AFFECT.map((k) => `affect.${k}`)
]);

/** 关系侧能量化的字段（★ 2026-10-16 用户裁定：`familiarity` 已退役，关系用好感 favor 表达）。 */
export const RELATION_FIELDS = Object.freeze(['trust', 'boundary', 'favor']);

/**
 * ★ 2026-10-16（熟悉度退役 · 兼容面）：旧事件 / 历史 JSON 里可能仍带 `familiarity`。
 *   **接受但忽略**：`validateEvent` 不判它非法（避免旧事件、回放被白名单变化拒绝），
 *   `apply.js` 的 onRelation 也**不会**把它写进状态 —— 只保证安全读取，不恢复业务含义。
 */
export const RELATION_LEGACY_FIELDS = Object.freeze(['familiarity']);

export const TONE_VALUES = Object.freeze(['neutral', 'warm', 'guarded', 'teasing', 'formal']);

/** 好感只由这些原因变动（§八：持续相处/可信帮助/共同经历/道歉修复/边界被尊重/失约伤人）。 */
export const FAVOR_REASONS = Object.freeze([
  'companionship', 'help', 'shared-experience', 'apology-repair', 'boundary-respected', 'reliability', 'hurt'
]);

/**
 * 这些原因**永不**计分：不同意见、被拒绝、角色说了「不」。
 * 好感不是服从度 —— 顶回去不该扣分。
 */
export const NEVER_SCORE_REASONS = Object.freeze(['disagreement', 'refusal', 'said-no', 'corrected-me']);

export function validateEvent(event, opts = {}) {
  const errors = [];
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, errors: ['$: 事件必须是对象'] };
  }
  const t = String(event.type || '');
  if (!EMOTION_EVENT_TYPES.includes(t)) errors.push(`type: 未知事件类型 "${t}"`);
  if (!Number.isFinite(Number(event.at)) || Number(event.at) <= 0) errors.push('at: 必须是正数时间戳（时间从事件拿，模块不读时钟）');

  const needEvidence = ['emotionEvidence', 'toolResult', 'lifeFact', 'calendar', 'relationDelta'].includes(t);
  if (needEvidence) {
    const ids = event.evidenceIds;
    if (!Array.isArray(ids) || ids.length === 0) errors.push('evidenceIds: 必须是非空数组（变化必须可回溯到证据）');
    else {
      ids.forEach((e, i) => { if (typeof e !== 'string' || !e) errors.push(`evidenceIds[${i}]: 必须是非空字符串`); });
      // ★★ N37：**「非空」不等于「存在」**。
      //   本仓反复抓过"无源写库"——只要 `evidenceIds` 塞几个不存在的字符串，
      //   情绪就能被凭空推动，而事后没人查得出来（台账里的 evidenceIds 指向空气）。
      //   M7 是**零依赖纯函数**（不能 import M6 的 store 去查账本），所以这条做成
      //   **可注入的 `hasEvidence`**：调用方（装配层 / 生产者）把 M6 的 `hasEvidence` 传进来，
      //   本模块就多查一道真实存在性；**不传就退回报现状（只查非空），不假装查过**。
      //   判据用同步函数即可（M6 `hasEvidence` 正是同步的）。
      const has = opts.hasEvidence;
      if (typeof has === 'function') {
        for (const e of ids) {
          if (typeof e !== 'string' || !e) continue;
          let known;
          try { known = has(e) === true; } catch { known = false; }
          if (!known) errors.push(`evidenceIds: "${e}" 不在证据账本里（没有证据不许写状态）`);
        }
      }
    }
    if (!EVIDENCE_SOURCES.includes(String(event.source))) errors.push(`source: 必须是 ${EVIDENCE_SOURCES.join('|')}`);
  }

  switch (t) {
    case 'message': {
      const v = validateMessageEvidence(event.evidence);
      if (!v.ok) errors.push(...v.errors.map((e) => `evidence.${e}`));
      break;
    }
    case 'round': {
      // ★ 2026-10-15（用户裁定 · 情绪缺口第二组；回修复核 §4）：整轮事实快照。
      //   形状纪律与 message 同级：计数必须是非负数字。`evidenceIds` **可选** —— 零入站轮
      //   （proactive/空入站但确实发言）没有聊天证据 id，不许伪造；这类轮靠 `roundId` 标识，
      //   台账侧由 M7 记 `round@<roundId>` 重算键（见 apply.js onRound）；带证据时仍是"本轮收到的消息"。
      const sent = event.sentCount === undefined ? 0 : Number(event.sentCount);
      const trig = event.triggerCount === undefined ? 0 : Number(event.triggerCount);
      if (!Number.isFinite(sent) || sent < 0) errors.push('sentCount: 必须是非负数字');
      if (!Number.isFinite(trig) || trig < 0) errors.push('triggerCount: 必须是非负数字');
      if (event.addressed !== undefined && typeof event.addressed !== 'boolean') errors.push('addressed: 必须是布尔');
      if (event.kind !== undefined && !['group', 'private'].includes(String(event.kind))) errors.push('kind: 只认 group|private');
      if (event.status !== undefined && typeof event.status !== 'string') errors.push('status: 必须是字符串');
      if (event.roundId !== undefined
        && (typeof event.roundId !== 'string' || !event.roundId || event.roundId.length > 120)) {
        errors.push('roundId: 必须是非空字符串（≤120 字符）');
      }
      if (event.evidenceIds !== undefined) {
        const rids = event.evidenceIds;
        if (!Array.isArray(rids)) errors.push('evidenceIds: 必须是数组');
        else rids.forEach((e, i) => { if (typeof e !== 'string' || !e) errors.push(`evidenceIds[${i}]: 必须是非空字符串`); });
      }
      if (event.cueKinds !== undefined) {
        if (!Array.isArray(event.cueKinds)) errors.push('cueKinds: 必须是数组');
        else if (event.cueKinds.length > 12) errors.push('cueKinds: 超过 12 项');
        else event.cueKinds.forEach((k, i) => {
          if (typeof k !== 'string' || !k || k.length > 32) errors.push(`cueKinds[${i}]: 必须是非空短字符串`);
        });
      }
      break;
    }
    case 'emotionEvidence': {
      const d = event.deltas;
      if (d === null || typeof d !== 'object' || Array.isArray(d)) errors.push('deltas: 必须是对象');
      else {
        for (const [k, val] of Object.entries(d)) {
          if (!DELTA_FIELDS.includes(k)) errors.push(`deltas.${k}: 不在可变化字段白名单里（本模块没有这类出口）`);
          else if (!Number.isFinite(Number(val))) errors.push(`deltas.${k}: 幅度必须是有限数字`);
        }
        // ★ N37：空 `deltas` 以前判**合法**，于是 `applyEvent` 收下一个"什么都不改"的事件 ——
        //   白跑一次 settle + 静默返回，生产侧看不出任何差别。判非法，让调用方知道自己没发出东西。
        if (Object.keys(d).length === 0) errors.push('deltas: 不能为空（一个都不改的事件没有意义）');
      }
      if (!Object.values(DELTA_FIELDS).length) errors.push('deltas: 白名单为空');
      break;
    }
    case 'toolResult': {
      if (typeof event.ok !== 'boolean') errors.push('ok: 必须是布尔（以回执为准）');
      break;
    }
    case 'lifeFact': {
      if (!String(event.slot || '')) errors.push('slot: 必须是非空字符串');
      if (!String(event.claim || '')) errors.push('claim: 必须是非空字符串');
      // ★ N37：以前只查「非空」，不查「是不是合法类别」⇒ `validateEvent` 判 ok，
      //   `applyEvent` 走到 `halfLifeOf()` 才抛 `未知半衰期类别`。
      //   那是**校验器与执行器不一致**：装配层/生产者照 validateEvent 的结论放行，到 apply 才炸，
      //   报错还来自一个完全不相干的地方（half-life.js）。这里把同一张类别表接上。
      const cat = String(event.category || '');
      if (!cat) errors.push('category: 必须是半衰期类别');
      else if (!HALF_LIFE_CATEGORIES.includes(cat)) {
        errors.push(`category: 未知半衰期类别 "${cat}"（允许：${HALF_LIFE_CATEGORIES.join('|')}）`);
      }
      // 槽位与正文长度：这两条是**落进 state 给人看**的文本，无界会把提示词撑爆。
      if (String(event.slot || '').length > 64) errors.push('slot: 超过 64 字符（会直接进 state 与提示词）');
      if (String(event.claim || '').length > 120) errors.push('claim: 超过 120 字符（会直接进 state 与提示词）');
      break;
    }
    case 'calendar': {
      const o = event.offsets;
      if (o === null || typeof o !== 'object' || Array.isArray(o)) errors.push('offsets: 必须是对象');
      else for (const [k, val] of Object.entries(o)) {
        if (!['physical', 'cognitive'].includes(k)) errors.push(`offsets.${k}: 日历只许轻微加减身体/认知目标`);
        else if (!Number.isFinite(Number(val))) errors.push(`offsets.${k}: 必须是有限数字`);
      }
      break;
    }
    case 'relationDelta': {
      if (!String(event.personId || '')) errors.push('personId: 必须是关键系（关系是按人的）');
      if (!String(event.idempotencyKey || '')) errors.push('idempotencyKey: 必填（同键重复应用必须等价于一次）');
      if (!String(event.reason || '')) errors.push('reason: 必填（不许无因涨跌）');
      const d = event.changes;
      if (d === null || typeof d !== 'object' || Array.isArray(d)) errors.push('changes: 必须是对象');
      else {
        for (const [k, val] of Object.entries(d)) {
          // ★ 熟悉度退役（2026-10-16）：旧事件里的 familiarity 接受但忽略 —— 不进白名单，也不判非法。
          if (RELATION_LEGACY_FIELDS.includes(k)) continue;
          if (!RELATION_FIELDS.includes(k) && k !== 'tone') errors.push(`changes.${k}: 不在关系字段白名单里`);
          else if (k === 'tone' && !TONE_VALUES.includes(String(val))) errors.push(`changes.tone: 必须是 ${TONE_VALUES.join('|')}`);
          else if (k !== 'tone' && !Number.isFinite(Number(val))) errors.push(`changes.${k}: 必须是有限数字`);
        }
        // ★ 2026-10-11（用户裁定 · B10 撤门槛）：favor 的 reason **不再限定七类、永不计分黑名单也撤掉**。
        //   用户原话："好感就是 LLM 自己决定的，他有权决定自己对谁好对谁坏；吵架、争执、意见不同
        //   本身就是会掉好感的" ⇒ 对齐老树 `src/tools.js:2282`（自由文本理由 + setFavor 直接写）。
        //   `FAVOR_REASONS` / `NEVER_SCORE_REASONS` 两个常量**保留导出**（UI 标签、归类器兜底用），
        //   但**不再拦事件**；favor 侧只剩上面 147 行的"reason 必填"——不许无因涨跌。
      }
      if (Object.keys(d || {}).length === 0) errors.push('changes: 不能为空');
      break;
    }
    case 'roleStatement': {
      if (!String(event.claim || '')) errors.push('claim: 必须是非空字符串');
      break;
    }
    default:
      break;
  }
  return { ok: errors.length === 0, errors };
}
