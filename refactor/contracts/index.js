/**
 * refactor/contracts/index.js — M0 冻结数据合同（零依赖）
 *
 * README §3.1 的全部结构 + 校验 + 构造器。
 * 禁止 import 任何东西（除 node: 内置）—— 这是地基，不能有循环依赖。
 */
// ★ 注意：本文件刻意不 import 任何模块（包括 node:），全部用纯 JS 实现。

export const SCHEMA_VERSION = 1;

// ── 工具 ─────────────────────────────────────────────────────────────────

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function isString(x) {
  return typeof x === 'string';
}

function isNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function isBoolean(x) {
  return typeof x === 'boolean';
}

/** 校验结果收集器 */
class ErrorBag {
  constructor() {
    this.errors = [];
  }
  add(field, msg) {
    this.errors.push(`${field}: ${msg}`);
  }
  get ok() {
    return this.errors.length === 0;
  }
  result() {
    return { ok: this.errors.length === 0, errors: this.errors.slice() };
  }
}

// ═════════════════════════════════════════════════════════════════════════
// MessageEvidence（A 阶段产出：一条不可改写的消息证据）
// ═════════════════════════════════════════════════════════════════════════
//
// = {
//   id, at, chatKey, kind: 'group'|'private', selfId,
//   sender: { id, name },
//   text,
//   mentions: [{ id, name, isSelf }],
//   refs: { toSelf, quoted: null|{ id, sender, senderId?, self?, text }, replyTo },
//   media: [{ type: 'image'|'sticker'|'video', id, desc?, ocr? }],
//   botSaidBefore: [{ id, text, at }]
// }

export function validateMessageEvidence(x) {
  const bag = new ErrorBag();
  if (!isPlainObject(x)) {
    bag.add('$', `期望对象，得到 ${typeof x}`);
    return bag.result();
  }

  if (!isString(x.id) || !x.id) bag.add('id', '必须是非空字符串');
  if (!isNumber(x.at)) bag.add('at', '必须是有限数字（时间戳）');
  if (!isString(x.chatKey) || !x.chatKey) bag.add('chatKey', '必须是非空字符串');
  if (x.kind !== 'group' && x.kind !== 'private') bag.add('kind', "必须是 'group' 或 'private'");
  if (x.selfId === undefined || x.selfId === null) bag.add('selfId', '必填');
  else if (!isString(x.selfId) && !isNumber(x.selfId)) bag.add('selfId', '必须是字符串或数字');

  // sender: { id, name }
  if (!isPlainObject(x.sender)) {
    bag.add('sender', '必须是对象');
  } else {
    if (x.sender.id === undefined || x.sender.id === null) bag.add('sender.id', '必填');
    else if (!isString(x.sender.id) && !isNumber(x.sender.id)) bag.add('sender.id', '必须是字符串或数字');
    if (!isString(x.sender.name)) bag.add('sender.name', '必须是字符串');
  }

  if (!isString(x.text)) bag.add('text', '必须是字符串（可为空串）');

  // mentions: [{ id, name, isSelf }]
  if (!Array.isArray(x.mentions)) {
    bag.add('mentions', '必须是数组');
  } else {
    x.mentions.forEach((m, i) => {
      if (!isPlainObject(m)) { bag.add(`mentions[${i}]`, '必须是对象'); return; }
      if (m.id === undefined || m.id === null) bag.add(`mentions[${i}].id`, '必填');
      else if (!isString(m.id) && !isNumber(m.id)) bag.add(`mentions[${i}].id`, '必须是字符串或数字');
      if (!isString(m.name)) bag.add(`mentions[${i}].name`, '必须是字符串');
      if (!isBoolean(m.isSelf)) bag.add(`mentions[${i}].isSelf`, '必须是布尔值');
    });
  }

  // refs: { toSelf, quoted: null|{ id, sender, senderId?, self?, text }, replyTo }
  // senderId/self 为可选透传键（2026-10-13 指挥裁定：源头出、构造器不许剥）；校验不强制它们在场
  // （上游确实没给时允许缺席），只在给的时候不许拦。
  if (!isPlainObject(x.refs)) {
    bag.add('refs', '必须是对象');
  } else {
    if (!isBoolean(x.refs.toSelf)) bag.add('refs.toSelf', '必须是布尔值');
    if (x.refs.quoted !== null) {
      if (!isPlainObject(x.refs.quoted)) {
        bag.add('refs.quoted', '必须是 null 或对象');
      } else {
        if (x.refs.quoted.id === undefined || x.refs.quoted.id === null) bag.add('refs.quoted.id', '必填');
        else if (!isString(x.refs.quoted.id) && !isNumber(x.refs.quoted.id)) bag.add('refs.quoted.id', '必须是字符串或数字');
        if (!isString(x.refs.quoted.sender)) bag.add('refs.quoted.sender', '必须是字符串');
        if (!isString(x.refs.quoted.text)) bag.add('refs.quoted.text', '必须是字符串');
      }
    }
    // replyTo: 允许 null / undefined / string
    if (x.refs.replyTo !== null && x.refs.replyTo !== undefined && !isString(x.refs.replyTo)) {
      bag.add('refs.replyTo', '必须是 null 或字符串');
    }
  }

  // media: [{ type: 'image'|'sticker'|'video', id, desc?, ocr? }]
  if (!Array.isArray(x.media)) {
    bag.add('media', '必须是数组');
  } else {
    x.media.forEach((m, i) => {
      if (!isPlainObject(m)) { bag.add(`media[${i}]`, '必须是对象'); return; }
      if (m.type !== 'image' && m.type !== 'sticker' && m.type !== 'video') {
        bag.add(`media[${i}].type`, "必须是 'image'/'sticker'/'video'");
      }
      if (m.id === undefined || m.id === null) bag.add(`media[${i}].id`, '必填');
      else if (!isString(m.id) && !isNumber(m.id)) bag.add(`media[${i}].id`, '必须是字符串或数字');
      if (m.desc !== undefined && !isString(m.desc)) bag.add(`media[${i}].desc`, '必须是字符串');
      if (m.ocr !== undefined && !isString(m.ocr)) bag.add(`media[${i}].ocr`, '必须是字符串');
    });
  }

  // botSaidBefore: [{ id, text, at }]
  if (!Array.isArray(x.botSaidBefore)) {
    bag.add('botSaidBefore', '必须是数组');
  } else {
    x.botSaidBefore.forEach((b, i) => {
      if (!isPlainObject(b)) { bag.add(`botSaidBefore[${i}]`, '必须是对象'); return; }
      if (!isString(b.id) || !b.id) bag.add(`botSaidBefore[${i}].id`, '必须是非空字符串');
      if (!isString(b.text)) bag.add(`botSaidBefore[${i}].text`, '必须是字符串');
      if (!isNumber(b.at)) bag.add(`botSaidBefore[${i}].at`, '必须是有限数字');
    });
  }

  return bag.result();
}

export function makeMessageEvidence(partial) {
  const v = validateMessageEvidence(partial);
  if (!v.ok) throw new Error(`makeMessageEvidence 校验失败: ${v.errors.join('; ')}`);
  return {
    id: partial.id,
    at: partial.at,
    chatKey: partial.chatKey,
    kind: partial.kind,
    selfId: partial.selfId,
    sender: { id: partial.sender.id, name: partial.sender.name },
    text: partial.text,
    mentions: partial.mentions.map((m) => ({ id: m.id, name: m.name, isSelf: m.isSelf })),
    refs: {
      toSelf: partial.refs.toSelf,
      // senderId/self 与源头（scenario collectRefs）同键透传；上游没给时归一为 null/false。
      quoted: partial.refs.quoted === null ? null : {
        id: partial.refs.quoted.id,
        sender: partial.refs.quoted.sender,
        senderId: partial.refs.quoted.senderId ?? null,
        self: partial.refs.quoted.self === true,
        text: partial.refs.quoted.text
      },
      replyTo: partial.refs.replyTo ?? null
    },
    media: partial.media.map((m) => ({
      type: m.type, id: m.id,
      ...(m.desc !== undefined ? { desc: m.desc } : {}),
      ...(m.ocr !== undefined ? { ocr: m.ocr } : {})
    })),
    botSaidBefore: partial.botSaidBefore.map((b) => ({ id: b.id, text: b.text, at: b.at }))
  };
}

// ═════════════════════════════════════════════════════════════════════════
// ActionPlan（C 阶段产出：唯一决定点的结构化意图）
// ═════════════════════════════════════════════════════════════════════════
//
// = {
//   action: 'reply'|'continue'|'wait'|'skip'|'ask'|'tool',
//   reason: string,
//   recipient, topic, purpose,
//   memoryRefs: [evidenceId],
//   toolPlan: [{ name, args, sideEffect: 'read'|'write' }],
//   urgency, by: 'rule'|'llm'|'jev'
// }

const PLAN_ACTIONS = ['reply', 'continue', 'wait', 'skip', 'ask', 'tool'];
const PLAN_BY = ['rule', 'llm', 'jev'];
const TOOL_SIDE_EFFECTS = ['read', 'write'];
const RESPONSE_POLICIES = ['required', 'optional', 'none'];

export function validateActionPlan(x) {
  const bag = new ErrorBag();
  if (!isPlainObject(x)) {
    bag.add('$', `期望对象，得到 ${typeof x}`);
    return bag.result();
  }

  if (!PLAN_ACTIONS.includes(x.action)) bag.add('action', `必须是 ${PLAN_ACTIONS.join('|')}`);
  if (!isString(x.reason) || !x.reason) bag.add('reason', '必须是非空字符串');
  if (!isString(x.recipient)) bag.add('recipient', '必须是字符串（chatKey 或 userId；未定用空串）');
  if (!isString(x.topic)) bag.add('topic', '必须是字符串（可为空串）');
  if (!isString(x.purpose)) bag.add('purpose', '必须是字符串（可为空串）');

  // Missing fields remain accepted at this validation boundary for legacy callers;
  // makeActionPlan always materializes both fields in its returned ActionPlan.
  if (x.responsePolicy !== undefined && !RESPONSE_POLICIES.includes(x.responsePolicy)) {
    bag.add('responsePolicy', `必须是 ${RESPONSE_POLICIES.join('|')}`);
  }
  if (x.requiredOutputs !== undefined) {
    if (!Array.isArray(x.requiredOutputs)) bag.add('requiredOutputs', '必须是字符串数组');
    else x.requiredOutputs.forEach((output, i) => {
      if (!isString(output) || !output.trim()) bag.add(`requiredOutputs[${i}]`, '必须是非空字符串');
    });
  }

  if (!Array.isArray(x.memoryRefs)) {
    bag.add('memoryRefs', '必须是数组');
  } else {
    x.memoryRefs.forEach((r, i) => {
      if (!isString(r) || !r) bag.add(`memoryRefs[${i}]`, '必须是非空字符串（evidenceId）');
    });
  }

  if (!Array.isArray(x.toolPlan)) {
    bag.add('toolPlan', '必须是数组');
  } else {
    x.toolPlan.forEach((t, i) => {
      if (!isPlainObject(t)) { bag.add(`toolPlan[${i}]`, '必须是对象'); return; }
      if (!isString(t.name) || !t.name) bag.add(`toolPlan[${i}].name`, '必须是非空字符串');
      if (t.args === undefined) bag.add(`toolPlan[${i}].args`, '必填（可为 null/空对象）');
      if (!TOOL_SIDE_EFFECTS.includes(t.sideEffect)) {
        bag.add(`toolPlan[${i}].sideEffect`, `必须是 ${TOOL_SIDE_EFFECTS.join('|')}`);
      }
    });
  }

  if (!isNumber(x.urgency)) bag.add('urgency', '必须是有限数字');
  else if (x.urgency < 0 || x.urgency > 1) bag.add('urgency', '必须在 [0, 1] 范围内');

  if (!PLAN_BY.includes(x.by)) bag.add('by', `必须是 ${PLAN_BY.join('|')}`);

  return bag.result();
}

export function makeActionPlan(partial) {
  const v = validateActionPlan(partial);
  if (!v.ok) throw new Error(`makeActionPlan 校验失败: ${v.errors.join('; ')}`);
  const responsePolicy = partial.responsePolicy
    ?? (['skip', 'wait'].includes(partial.action) ? 'none' : 'required');
  const requiredOutputs = partial.requiredOutputs
    ?? (responsePolicy === 'required' ? ['text'] : []);
  return {
    action: partial.action,
    reason: partial.reason,
    recipient: partial.recipient,
    topic: partial.topic,
    purpose: partial.purpose,
    memoryRefs: [...partial.memoryRefs],
    toolPlan: partial.toolPlan.map((t) => ({ name: t.name, args: t.args, sideEffect: t.sideEffect })),
    responsePolicy,
    requiredOutputs: [...requiredOutputs],
    urgency: partial.urgency,
    by: partial.by
  };
}

// ═════════════════════════════════════════════════════════════════════════
// Verdict（D 阶段：校验结论，可解释、可追溯）
// ═════════════════════════════════════════════════════════════════════════
//
// = { allow: boolean, blockedBy: null|string, signals: [{ from:'jev'|'rule', role?, label?, p?, margin? }] }

const SIGNAL_FROM = ['jev', 'rule'];

export function validateVerdict(x) {
  const bag = new ErrorBag();
  if (!isPlainObject(x)) {
    bag.add('$', `期望对象，得到 ${typeof x}`);
    return bag.result();
  }

  if (!isBoolean(x.allow)) bag.add('allow', '必须是布尔值');
  if (x.blockedBy !== null && x.blockedBy !== undefined && !isString(x.blockedBy)) {
    bag.add('blockedBy', '必须是 null 或字符串');
  }
  if (!Array.isArray(x.signals)) {
    bag.add('signals', '必须是数组');
  } else {
    x.signals.forEach((s, i) => {
      if (!isPlainObject(s)) { bag.add(`signals[${i}]`, '必须是对象'); return; }
      if (!SIGNAL_FROM.includes(s.from)) bag.add(`signals[${i}].from`, `必须是 ${SIGNAL_FROM.join('|')}`);
      if (s.role !== undefined && !isString(s.role)) bag.add(`signals[${i}].role`, '必须是字符串');
      if (s.label !== undefined && !isString(s.label)) bag.add(`signals[${i}].label`, '必须是字符串');
      if (s.p !== undefined && !isNumber(s.p)) bag.add(`signals[${i}].p`, '必须是数字');
      if (s.margin !== undefined && !isNumber(s.margin)) bag.add(`signals[${i}].margin`, '必须是数字');
    });
  }

  return bag.result();
}

export function makeVerdict(partial) {
  const v = validateVerdict(partial);
  if (!v.ok) throw new Error(`makeVerdict 校验失败: ${v.errors.join('; ')}`);
  return {
    allow: partial.allow,
    blockedBy: partial.blockedBy ?? null,
    signals: partial.signals.map((s) => ({
      from: s.from,
      ...(s.role !== undefined ? { role: s.role } : {}),
      ...(s.label !== undefined ? { label: s.label } : {}),
      ...(s.p !== undefined ? { p: s.p } : {}),
      ...(s.margin !== undefined ? { margin: s.margin } : {})
    }))
  };
}

// ═════════════════════════════════════════════════════════════════════════
// SendReceipt（E 阶段：发送回执，以回执为准）
// ═════════════════════════════════════════════════════════════════════════
//
// = { ok: boolean, platformId?, at, error?, idempotencyKey }

export function validateSendReceipt(x) {
  const bag = new ErrorBag();
  if (!isPlainObject(x)) {
    bag.add('$', `期望对象，得到 ${typeof x}`);
    return bag.result();
  }

  if (!isBoolean(x.ok)) bag.add('ok', '必须是布尔值');
  if (x.platformId !== undefined && x.platformId !== null && !isString(x.platformId)) {
    bag.add('platformId', '必须是字符串');
  }
  if (!isNumber(x.at)) bag.add('at', '必须是有限数字（时间戳）');
  if (x.error !== undefined && x.error !== null && !isString(x.error)) {
    bag.add('error', '必须是字符串');
  }
  if (!isString(x.idempotencyKey) || !x.idempotencyKey) bag.add('idempotencyKey', '必须是非空字符串');

  return bag.result();
}

export function makeSendReceipt(partial) {
  const v = validateSendReceipt(partial);
  if (!v.ok) throw new Error(`makeSendReceipt 校验失败: ${v.errors.join('; ')}`);
  return {
    ok: partial.ok,
    ...(partial.platformId !== undefined ? { platformId: partial.platformId } : {}),
    at: partial.at,
    ...(partial.error !== undefined ? { error: partial.error } : {}),
    idempotencyKey: partial.idempotencyKey
  };
}

// ═════════════════════════════════════════════════════════════════════════
// IdempotencyKey（重试/重复回调必须幂等）
// ═════════════════════════════════════════════════════════════════════════
//
// = `${chatKey}:${evidenceId}:${action}`

export function makeIdempotencyKey(chatKey, evidenceId, action) {
  if (!isString(chatKey) || !chatKey) throw new Error('makeIdempotencyKey: chatKey 必须是非空字符串');
  if (!isString(evidenceId) || !evidenceId) throw new Error('makeIdempotencyKey: evidenceId 必须是非空字符串');
  if (!isString(action) || !action) throw new Error('makeIdempotencyKey: action 必须是非空字符串');
  return `${chatKey}:${evidenceId}:${action}`;
}

export function validateIdempotencyKey(x) {
  const bag = new ErrorBag();
  if (!isString(x)) {
    bag.add('$', `期望字符串，得到 ${typeof x}`);
    return bag.result();
  }
  // 格式: `${chatKey}:${evidenceId}:${action}`
  // chatKey 可含冒号（如 group:123）⇒ 从右往左拆：最后两段是 action 和 evidenceId，剩余是 chatKey
  const lastColon = x.lastIndexOf(':');
  if (lastColon < 0) {
    bag.add('$', '缺少分隔符 :（格式必须是 chatKey:evidenceId:action）');
    return bag.result();
  }
  const action = x.slice(lastColon + 1);
  const rest = x.slice(0, lastColon);
  const secondColon = rest.lastIndexOf(':');
  if (secondColon < 0) {
    bag.add('$', '缺少分隔符 :（格式必须是 chatKey:evidenceId:action）');
    return bag.result();
  }
  const evidenceId = rest.slice(secondColon + 1);
  const chatKey = rest.slice(0, secondColon);
  if (!chatKey) bag.add('$', 'chatKey 段不能为空');
  if (!evidenceId) bag.add('$', 'evidenceId 段不能为空');
  if (!action) bag.add('$', 'action 段不能为空');
  return bag.result();
}

// ═════════════════════════════════════════════════════════════════════════
// MemoryObservation（F 阶段：状态与记忆更新）
// ═════════════════════════════════════════════════════════════════════════
//
// = { id, subjectId, claim, evidenceIds:[...], scope:'group'|'private'|'global', confidence, at, supersedes? }

const OBS_SCOPES = ['group', 'private', 'global'];

export function validateMemoryObservation(x) {
  const bag = new ErrorBag();
  if (!isPlainObject(x)) {
    bag.add('$', `期望对象，得到 ${typeof x}`);
    return bag.result();
  }

  if (!isString(x.id) || !x.id) bag.add('id', '必须是非空字符串');
  if (!isString(x.subjectId) || !x.subjectId) bag.add('subjectId', '必须是非空字符串');
  if (!isString(x.claim) || !x.claim) bag.add('claim', '必须是非空字符串');

  if (!Array.isArray(x.evidenceIds)) {
    bag.add('evidenceIds', '必须是数组');
  } else if (x.evidenceIds.length === 0) {
    bag.add('evidenceIds', '不能为空数组');
  } else {
    x.evidenceIds.forEach((e, i) => {
      if (!isString(e) || !e) bag.add(`evidenceIds[${i}]`, '必须是非空字符串');
    });
  }

  if (!OBS_SCOPES.includes(x.scope)) bag.add('scope', `必须是 ${OBS_SCOPES.join('|')}`);
  if (!isNumber(x.confidence)) bag.add('confidence', '必须是有限数字');
  else if (x.confidence < 0 || x.confidence > 1) bag.add('confidence', '必须在 [0, 1] 范围内');
  if (!isNumber(x.at)) bag.add('at', '必须是有限数字（时间戳）');
  if (x.supersedes !== undefined && x.supersedes !== null && !isString(x.supersedes)) {
    bag.add('supersedes', '必须是字符串');
  }
  if (x.chatKey !== undefined && x.chatKey !== null && !isString(x.chatKey)) bag.add('chatKey', '必须是字符串');
  if (x.type !== undefined && x.type !== null && !isString(x.type)) bag.add('type', '必须是字符串');
  if (x.validUntil !== undefined && x.validUntil !== null && !isNumber(x.validUntil)) bag.add('validUntil', '必须是时间戳数字');
  
  if (x.schemaVersion !== undefined && x.schemaVersion !== null && !isNumber(x.schemaVersion)) bag.add('schemaVersion', '必须是数字');
  if (x.namespace !== undefined && x.namespace !== null && !isPlainObject(x.namespace)) bag.add('namespace', '必须是对象');
  if (x.memoryClass !== undefined && x.memoryClass !== null && !['working', 'long_term'].includes(x.memoryClass)) bag.add('memoryClass', '必须是 working 或 long_term');
  if (x.factSlot !== undefined && x.factSlot !== null && !isString(x.factSlot)) bag.add('factSlot', '必须是字符串');
  if (x.origin !== undefined && x.origin !== null && !['direct', 'extracted', 'legacy_import'].includes(x.origin)) bag.add('origin', '必须是 direct, extracted 或 legacy_import');
  if (x.sourceRefs !== undefined && x.sourceRefs !== null && !Array.isArray(x.sourceRefs)) bag.add('sourceRefs', '必须是数组');
  if (x.todoId !== undefined && x.todoId !== null && !isString(x.todoId)) bag.add('todoId', '必须是字符串');
  // 双人格归属标（2026-10-13 接线）：只接受 boolean；不给 = 由 memory.commit 按在位状态自动打。
  if (x.persona2 !== undefined && x.persona2 !== null && typeof x.persona2 !== 'boolean') {
    bag.add('persona2', '必须是 boolean（true = 第二人格在位时写下；读侧按它做记忆隔离）');
  }

  return bag.result();
}

export function makeMemoryObservation(partial) {
  const v = validateMemoryObservation(partial);
  if (!v.ok) throw new Error(`makeMemoryObservation 校验失败: ${v.errors.join('; ')}`);
  return {
    id: partial.id,
    subjectId: partial.subjectId,
    claim: partial.claim,
    evidenceIds: [...partial.evidenceIds],
    scope: partial.scope,
    confidence: partial.confidence,
    at: partial.at,
    ...(partial.supersedes !== undefined ? { supersedes: partial.supersedes } : {}),
    ...(partial.chatKey !== undefined ? { chatKey: partial.chatKey } : {}),
    ...(partial.type !== undefined ? { type: partial.type } : {}),
    ...(partial.validUntil !== undefined ? { validUntil: partial.validUntil } : {}),
    ...(partial.schemaVersion !== undefined ? { schemaVersion: partial.schemaVersion } : {}),
    ...(partial.namespace !== undefined ? { namespace: partial.namespace } : {}),
    ...(partial.memoryClass !== undefined ? { memoryClass: partial.memoryClass } : {}),
    ...(partial.factSlot !== undefined ? { factSlot: partial.factSlot } : {}),
    ...(partial.origin !== undefined ? { origin: partial.origin } : {}),
    ...(partial.sourceRefs !== undefined ? { sourceRefs: partial.sourceRefs } : {}),
    ...(partial.todoId !== undefined ? { todoId: partial.todoId } : {})
  };
}

// ── 工具调用被拒的原因码 ─────────────────────────────────────────────────
/**
 * ★ 指挥 2026-10-13 裁定的闭集（短横线小写，**共 21 个**：act 十五 + 编排六）。放在合同层，是因为 **act 与 compose 两边都要用同一份**：
 *   同一件事在两处各起一个名字，"工具名 × 原因"的分布表就永远对不上。
 *   ★ 只准从这里取值，**不许就地造新字符串**；要加新码走裁定，裁定完再往这张表里追加。
 *   ★ 它与状态的六值（`code`：completed/delivered/failed/blocked/unknown/partial）是**两个维度**，
 *     `code` 回答"成没成"，`reasonCode` 回答"卡在哪一步"，两个字段并存、都不改名。
 *   ★ 一条路径只贴一个码；**状态里已经写清楚的事不在这里重复编码** ——
 *     例："平台没确认这条发出去"是一个码（`send-not-confirmed`），到底是"确定没发出"还是"结果未知"
 *     由 `state`（failed / unknown）回答，不另开两个码。
 */
export const TOOL_REJECT_REASONS = Object.freeze({
  // —— act 执行侧（`modules/act/index.js` 产出，一共 16 个，覆盖 act 每一条拒绝路径）——
  SCHEMA_INVALID: 'schema-invalid',                       // 参数不合格：缺必需项、类型不对、正文归一失败
  NOT_FOUND: 'not-found',                                // 注册表里没有这个名字；或要用的那条消息查不到
  NO_IMAGE: 'no-image',                                  // 消息查得到，但它没有可下载的图片
  // ★ 下面三个是指挥裁定拆开的："**有人把它关了**"是配置决定，"**授权查失败**"是故障，排障时必须分开看。
  DISABLED_BY_CONFIG: 'disabled-by-config',              // 工具在，但配置不让用（单工具关、总开关关、分类关、不在白名单）
  AUTHZ_DEPENDENCY_MISSING: 'authz-dependency-missing',  // 授权依赖没注入 ⇒ fail-closed（装配问题）
  AUTHZ_EVAL_FAILED: 'authz-eval-failed',                // 授权求值抛错 ⇒ fail-closed（故障）
  TOOL_UNAVAILABLE: 'tool-unavailable',                  // 工具在、配置也允许，但当前条件不满足（技能未激活、缺能力、无视觉/无搜索…）
  INVALID_IDEMPOTENCY_KEY: 'invalid-idempotency-key',    // 本轮幂等基键无效 ⇒ 整批 fail-closed，一次都没执行
  CALL_BUDGET_EXHAUSTED: 'call-budget-exhausted',        // 超本轮工具调用次数预算
  TIME_BUDGET_EXHAUSTED: 'time-budget-exhausted',        // 超本轮工具总时长预算（状态仍是 unknown）
  HYPE_COUNT_INSUFFICIENT: 'hype-count-insufficient',    // 亢奋模式连击条数不够
  EXECUTOR_MISSING: 'executor-missing',                  // 工具注册了但没注入执行器（装配缺失，不是模型的问题）
  EXECUTOR_FAILED: 'executor-failed',                    // 执行器自己报失败或抛异常
  TIMEOUT: 'timeout',                                    // 单个工具（含媒体投递）超时
  SEND_NOT_CONFIRMED: 'send-not-confirmed',              // 文本/媒体/转发没拿到平台回执（成没成看 state）
  // ★ 2026-10-13：措辞拦不住"把心声当消息发"时的那条确定性兜底，单独一个码 ⇒ 分布表数得出被拦了几次。
  INNER_VOICE_BLOCKED: 'inner-voice-blocked',            // 出站正文被判成写给自己的话，未发送、原因已回给模型
  // —— 编排 / compose 侧（`modules/orchestrator/**` 产出，进 act 之前就被拦）——
  FINISH_DISABLED: 'finish-disabled',
  NOT_ALLOWED_IN_CLOSEOUT: 'not-allowed-in-closeout',
  DUPLICATE_SUPPRESSED: 'duplicate-suppressed',
  TOOL_ROUND_LIMIT: 'tool-round-limit',
  EXTENSION_HOOK_BLOCKED: 'extension-hook-blocked',
  EXTENSION_HOOK_FAILED: 'extension-hook-failed'
});
