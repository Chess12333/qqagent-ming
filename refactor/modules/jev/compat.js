/**
 * M9 jev · 搬运层兼容面（README §3.5 冻结：`localJevHasRole` `jevJudgeTextOnly` `jevSaySkipLine`）
 *
 * 消费者只有一个：M3 `platform/salvage.js`（协议失败恢复旁路）。
 * ★ 这三个名字的形状必须与旧 `src/local-jev.js` 一致，否则搬运层的调用点要改（那是禁区）。
 * ★ 语义边界：这条旁路**不是** §1 流水线里「回不回」的决定点 —— 那一轮在 C 已经决定要说话了，
 *   这里只决定「误写进正文的这段要不要原样送出去」。§0.5 的「唯一决定点」不被它破坏。
 */
import { ask, isModelBound } from './core.js';
import { hasRole, roleOf } from './roles.js';

/**
 * 这个角色现在能不能判。
 * 旧实现查「本地开关 + 角色表 + 云端接管」；新实现只看两件事：**角色在表里** 且 **模型已注入**。
 * ⇒ 结构上不可能出现「配置里开着、但全仓没有调用点」（旧版 3 个死角色）与
 *   「enabled:true 但调用点被删了，开关成摆设」（旧版 favorJudge，10-02 起恒 null）。
 */
export function localJevHasRole(roleId) {
  return hasRole(roleId) && isModelBound();
}

/** 与旧 `draftFromLocal` 同口径的正文切行（最多 3 行；去掉行首 @ 与 #编号）。 */
export function draftFromLocal(body) {
  return String(body)
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^(?:回复\s*)?@\S+\s*/u, '').replace(/^#\d{4,}\s*/u, '').trim())
    .filter(Boolean)
    .slice(0, 3);
}

/**
 * 保守旁白否决 —— **这是旧版 `localLooksLikeNarration`（src/local-jev.js）口径的复制件，收口见债**。
 * ⚠️ 债（裁定 4，登记给第 3 批）：这团正则的正主是 M5 scenario / `orchestrator`；
 *   这里为保住 salvage 的安全侧临时自带一份，第 3 批收口方式二选一：
 *   **由调用方传入** 或 **收进 `core/util`**。行为不改、不动它。
 */
export function looksLikeNarration(text) {
  const s = String(text || '');
  if (!s) return true;
  if (/安静结束|处理结束|不用我说话|这轮不用|我先去|我该不该|要不要回|话题翻篇|根据设定|复述历史|内心戏|不回算了|得回一下/.test(s)) return true;
  if (/^[（(【\[]/.test(s) && /表情|装死|潜水|思考|计划/.test(s)) return true;
  if (/^他(?:这句|在说|在管|有点)/.test(s) && s.length < 80) return true;
  return false;
}

function rawTag(result) {
  return `${result.label ?? '-'}|${result.status}|p=${result.p ?? '-'}|m=${result.margin ?? '-'}`;
}

/** 正文裁判：say / skip。返回与 `salvage.judgeTextOnly` 兼容的形状。 */
export async function jevJudgeTextOnly({ text, trigger = '', traceId } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return { say: false, messages: [], raw: '', error: 'empty' };

  const roleId = 'textOnlyJudge';
  if (!localJevHasRole(roleId)) {
    return { say: false, messages: [], raw: '', error: 'unavailable：模型未注入或角色不在表里', source: 'jev' };
  }
  const probe = trigger ? `对方刚说：${String(trigger).slice(0, 120)}\n正文：${body}` : body;
  const r = await ask(roleId, probe, { traceId });

  if (r.status === 'unavailable') return { say: false, messages: [], raw: rawTag(r), error: 'unavailable', source: 'jev' };
  if (r.status === 'timeout') return { say: false, messages: [], raw: rawTag(r), error: 'timeout：不判为 skip，交回上层回退云端裁判', source: 'jev' };
  if (r.status === 'error') return { say: false, messages: [], raw: rawTag(r), error: r.reason || 'error', source: 'jev' };
  if (r.status === 'abstain') return { say: false, messages: [], raw: rawTag(r), error: '弃权：交回上层回退云端裁判', source: 'jev' };
  // ★ 故意改动（相对旧实现）：旧版低置信直接 silently skip；新版带回 error → 上层回退云端（云端实测同批 0 错）。
  if (r.status === 'low-confidence') {
    return { say: false, messages: [], raw: rawTag(r), margin: r.margin, p: r.p, error: `低置信：概率 ${r.p ?? '-'} / 间隔 ${r.margin ?? '-'} 未达阈值`, source: 'jev' };
  }
  if (r.label !== roleOf(roleId).positive) return { say: false, messages: [], raw: rawTag(r), margin: r.margin, p: r.p, source: 'jev' };

  // 裁判说 say 之后仍过一道旁白否决：小模型误判率高，安全侧优先（旧行为保留）。
  if (looksLikeNarration(body)) {
    return { say: false, messages: [], raw: `${rawTag(r)}|veto:narration`, source: 'jev', p: r.p };
  }
  const messages = draftFromLocal(body);
  if (!messages.length) {
    return { say: false, messages: [], raw: rawTag(r), error: 'empty-messages', source: 'jev' };
  }
  return { say: true, messages, raw: rawTag(r), margin: r.margin, p: r.p, source: 'jev' };
}

/**
 * 单行「该不该发」：say / skip。`mode: 'textOnly'` 复用正文裁判角色，否则用逐行角色。
 */
export async function jevSaySkipLine({ line, trigger = '', mode = 'unsentLine', alreadySent = [], traceId } = {}) {
  const body = String(line ?? '').trim();
  if (!body) return { say: false, raw: '', error: 'empty' };
  const roleId = mode === 'textOnly' ? 'textOnlyJudge' : 'unsentLinesJudge';
  if (!localJevHasRole(roleId)) {
    return { say: false, raw: '', error: 'unavailable：模型未注入或角色不在表里', source: 'jev' };
  }
  const sentBlob = (alreadySent || []).slice(-8)
    .map((s) => String(s?.text || '').slice(0, 40)).filter(Boolean).join(' | ');
  const probe = sentBlob
    ? `${body.slice(0, 200)}\n（已发过：${sentBlob.slice(0, 120)}）`
    : body.slice(0, 200);
  const r = await ask(roleId, trigger ? `对方刚说：${String(trigger).slice(0, 80)}\n草稿：${probe}` : `草稿：${probe}`, { traceId });

  if (r.status === 'timeout') return { say: false, raw: rawTag(r), error: 'timeout：不判为 skip', source: 'jev' };
  if (r.status === 'abstain') return { say: false, raw: rawTag(r), error: '弃权：不判为 skip', source: 'jev' };
  if (r.status === 'unavailable') return { say: false, raw: rawTag(r), error: 'unavailable：不判为 skip', source: 'jev' };
  if (r.status === 'error') return { say: false, raw: rawTag(r), error: `${r.reason || 'error'}：不判为 skip`, source: 'jev' };
  if (r.status === 'invalid') return { say: false, raw: rawTag(r), error: 'invalid-role：不判为 skip', source: 'jev' };
  // ★ 与旧实现的差别（故意）：旧版低置信 silently skip；新版带回 error → 上层回退云端裁判。
  if (r.status === 'low-confidence') {
    return { say: false, raw: rawTag(r), margin: r.margin, p: r.p, error: `低置信：概率 ${r.p ?? '-'} / 间隔 ${r.margin ?? '-'} 未达阈值，不判为 skip`, source: 'jev' };
  }
  if (r.label !== roleOf(roleId).positive) return { say: false, raw: rawTag(r), margin: r.margin, p: r.p, source: 'jev' };
  if (mode === 'textOnly' && looksLikeNarration(body)) {
    return { say: false, raw: `${rawTag(r)}|veto:narration`, source: 'jev' };
  }
  return { say: true, raw: rawTag(r), margin: r.margin, p: r.p, source: 'jev' };
}
