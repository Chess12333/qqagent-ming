/**
 * M5 scenario · evidence.js —— 事实记录 → `MessageEvidence`（阶段 A 的最终产出）
 *
 * 形状与字段**逐字**来自 `refactor/contracts/index.js`（README §3.1，已冻结）。
 * 本文件不新增字段、不改字段名、不做任何推断；唯一职责是把 inbound.js 还原出的事实
 * 组装成契约要求的形状，并交给 `makeMessageEvidence` 做最后一道校验（不合格就抛，不静默放过）。
 *
 * 产出保证（selftest 逐条断言）：
 *   - `text` 里**没有**被引用那条的原话（引用里的"我"不会被算成当前说话人说的）
 *   - `mentions` 里**没有**被引用那条里的 @
 *   - `media[]` 里**没有**发送者字段（图不是发图人画的）
 *   - `botSaidBefore` 里每一条都有 `ok === true` 的发送回执
 *   - 同一输入 → 逐字节相同的输出（无时钟、无随机）
 *
 * 纯函数：无 IO / 无时钟 / 无随机。
 */
import { makeMessageEvidence, validateMessageEvidence } from '../../contracts/index.js';
import { normalizeRaw, resolveTextLimit } from './inbound.js';
import { mergeRecords } from './merge.js';
import { selectBotSaidBefore, selfCandidatesFromRaw, DEFAULT_BOT_SAID_LIMIT } from './bot-said.js';
import { ScenarioError, SCENARIO_ERROR_CODES } from './errors.js';

export const SCENARIO_VERSION = 1;

function deriveKind(batch, raw) {
  if (batch?.kind === 'private' || batch?.kind === 'group') return batch.kind;
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'private' || item.kind === 'group') return item.kind;
    if (item.message_type === 'private' || item.message_type === 'group') return item.message_type;
    if (item.post_type === 'message_sent') continue;
  }
  return 'group';
}

/**
 * 稳定的小指纹（FNV-1a，8 位 16 进制）—— 只用来区分"内容不同的两条消息"，不做安全用途。
 * 要求**确定性**：同一批重放必须得到同一个值（scenario 自测有"同输入两次逐字节一致"的断言）。
 */
function contentFingerprint(record, index) {
  const segs = Array.isArray(record?.segments)
    ? record.segments.map((s) => `${s?.type ?? ''}:${s?.data?.id ?? s?.data?.file ?? ''}`).join(',')
    : '';
  const s = `${record?.senderId ?? ''}\u0000${String(record?.text ?? '')}\u0000${segs}\u0000${Number(record?.at) || 0}\u0000${index}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 没有真实 message_id 时给证据合成 id。
 *
 * ★ 2026-10-05 修（qwen2 对抗复核 `T-REVIEW-G21-B` §C5/C3 实测）：旧形状 ``${chatKey}#i${index}``
 *   **只在单批内唯一** —— 两轮各来一条消息，两条都叫 `group:88#i0`；而 M15 的幂等键是
 *   `chatKey:证据id:动作` ⇒ 两轮**逐字相同** ⇒ M10 的 `sendIdempotency` 把第二轮当成"发过了"，
 *   直接复用第一条的 platformId 当回执 ⇒ **第二条消息永远发不出去，日志里还写着 delivered**。
 *   现在把该记录的时间戳纳入：**同一批重放稳定**（`at`/`index` 不变 ⇒ 同 id），**不同轮互不相同**。
 *
 * ★ 第二次加固（qwen2 预读发现、我复核后采纳）：OneBot 的 `time` 是**秒级** ⇒ 同一自然秒内的两条
 *   无 id 消息，`at` 与 `index` 仍会相同 ⇒ id 再次相撞。所以再并入**内容指纹**
 *   （发送者 + 正文 + 段签名 + 时间 + 批内序号）。
 *   残余风险（如实登记）：**发送者、正文、段、秒级时间、批内序号全都相同**的两条消息 ——
 *   那种情况它们与"同一条消息被重复投递"在数据上无法区分，按同一 id 处理是可接受的。
 */
function synthId(chatKey, index, at, record) {
  return `${chatKey}#${Number(at) || 0}#i${index}#${contentFingerprint(record, index)}`;
}

/**
 * 事实记录 → 一条不可改写的 `MessageEvidence`。
 * `onTruncated` = 截断留痕的出口（裁定 2）：一行一条 `{evidenceId, originalChars, keptChars}`。
 * ★ 留痕**不进 evidence 对象**（会被 M0 契约拒），只走诊断通道。
 */
export function evidenceFromRecord(record, { chatKey, kind, selfId, pool = [], botSaidLimit = DEFAULT_BOT_SAID_LIMIT, onIssue = null, onTruncated = null } = {}) {
  let id = record.id;
  if (!id) {
    id = synthId(chatKey, record.index, record.at, record);
    onIssue?.({ code: 'id-synthesized', index: record.index, id });
  }
  if (!record.senderId) {
    onIssue?.({ code: 'sender-id-missing', index: record.index, id });
  }
  if (record.hasReplySegment && record.refs.quoted === null) {
    // 有回复段但拿不到被引内容 —— 事实（replyTo）在，内容缺，如实报出来
    onIssue?.({ code: 'quoted-target-unresolved', index: record.index, id, replyTo: record.refs.replyTo });
  }

  const partial = {
    id,
    at: record.at,
    chatKey,
    kind,
    selfId,
    sender: { id: record.senderId, name: record.senderName },
    text: record.text,
    mentions: record.mentions,
    refs: { toSelf: record.refs.toSelf, quoted: record.refs.quoted, replyTo: record.refs.replyTo },
    media: record.media,
    botSaidBefore: selectBotSaidBefore(pool, { at: record.at, limit: botSaidLimit, onIssue })
  };

  const check = validateMessageEvidence(partial);
  if (!check.ok) {
    throw new ScenarioError(SCENARIO_ERROR_CODES.CONTRACT_INVALID, `MessageEvidence 不符合契约: ${check.errors.join('; ')}`, {
      index: record.index,
      id
    });
  }
  // 留痕只在**证据确实产出**之后报（被契约拒的那条不算产出，别报两条账）
  for (const t of Array.isArray(record.truncations) ? record.truncations : []) {
    onTruncated?.({ evidenceId: id, originalChars: t.originalChars, keptChars: t.keptChars });
  }
  return makeMessageEvidence(partial);
}

/**
 * 跑一整批。**不抛**（除非 strict）：一条坏消息不该带倒整批。
 * @returns {{ evidence: Array, diagnostics: object }}
 */
export function runBatch(batch, options = {}) {
  const issues = [];
  const onIssue = (issue) => issues.push(issue);
  // ★ 裁定 2：截断必须在诊断通道里可见，一行一条 {evidenceId, originalChars, keptChars}
  const truncated = [];
  const onTruncated = (row) => truncated.push(row);

  const chatKey = batch?.chatKey === null || batch?.chatKey === undefined ? '' : String(batch.chatKey).trim();
  if (!chatKey) throw new ScenarioError('E_NO_CHATKEY', 'batch.chatKey 必填（MessageEvidence 的 chatKey 不能为空）');

  const raw = Array.isArray(batch?.raw) ? batch.raw
    : (Array.isArray(batch?.messages) ? batch.messages : []);
  const kind = deriveKind(batch, raw);
  const selfId = batch?.selfId ?? '';
  const strict = options.strict === true;
  const context = {
    chatKey,
    kind,
    selfId,
    now: Number.isFinite(batch?.now) ? batch.now : null,
    selfNames: Array.isArray(options.selfNames) ? options.selfNames : [],
    resolveAtName: typeof options.resolveAtName === 'function' ? options.resolveAtName : null,
    resolveQuote: typeof options.resolveQuote === 'function' ? options.resolveQuote : null,
    maxTextChars: resolveTextLimit(options.maxTextChars),   // 裁定 2：阈值可配（默认 8000）
    onIssue
  };

  const records = [];
  let selfSkipped = 0;
  let invalid = 0;
  for (let index = 0; index < raw.length; index += 1) {
    let record;
    try {
      record = normalizeRaw(raw[index], { ...context, index });
    } catch (e) {
      if (strict) throw e;
      invalid += 1;
      onIssue({ code: e?.code ?? 'E_UNKNOWN', index, message: String(e?.message ?? e) });
      continue;
    }
    if (record.isSelf) {
      selfSkipped += 1;
      onIssue({ code: 'self-message-not-evidence', index, id: record.id });
      continue;
    }
    records.push(record);
  }

  const { records: merged, merges } = mergeRecords(records, options.merge, { onIssue });

  // 「机器人说过什么」的候选池 = 调用方显式给的（带回执）+ raw 里自述且带成功回执的。
  const pool = [
    ...(Array.isArray(batch?.botSaid) ? batch.botSaid : []),
    ...selfCandidatesFromRaw(raw, { selfId, onIssue })
  ];
  const botSaidLimit = Number.isSafeInteger(options.botSaidLimit) && options.botSaidLimit > 0
    ? options.botSaidLimit
    : DEFAULT_BOT_SAID_LIMIT;

  const evidence = [];
  for (const record of merged) {
    try {
      evidence.push(evidenceFromRecord(record, { chatKey, kind, selfId, pool, botSaidLimit, onIssue, onTruncated }));
    } catch (e) {
      if (strict) throw e;
      invalid += 1;
      onIssue({ code: e?.code ?? 'E_UNKNOWN', index: record.index, id: record.id, message: String(e?.message ?? e) });
    }
  }

  return {
    evidence,
    diagnostics: {
      version: SCENARIO_VERSION,
      chatKey,
      kind,
      selfId: String(selfId),
      counts: {
        raw: raw.length,
        evidence: evidence.length,
        selfSkipped,
        invalid,
        merged: merges.length
      },
      issues,
      merges,
      truncated,
      textLimit: context.maxTextChars,
      botSaid: {
        pool: pool.length,
        usable: evidence.length ? evidence[evidence.length - 1].botSaidBefore.length : 0
      }
    }
  };
}

/** 阶段 A 的主入口：一批原始入站消息 → 一串 `MessageEvidence`。 */
export function ingestBatch(batch, options = {}) {
  return runBatch(batch, options).evidence;
}

/** 与 `ingestBatch` 同源，额外把 diagnostics 交出来（排障/回放用）。 */
export function inspectBatch(batch, options = {}) {
  return runBatch(batch, options);
}
