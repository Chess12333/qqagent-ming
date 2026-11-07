/**
 * M5 scenario · bot-said.js —— 「机器人自己以前说过什么」
 *
 * 铁律（派单第 4 条 / README §0.6「没回执不算发过」）：
 *   **只有带「发送成功」回执的机器人消息才算"说过"。** 没回执的、失败的、只知道 id
 *   但不知道平台有没有收下的，一律不进 `botSaidBefore` —— 否则下游会拿一句
 *   *根本没发出去*的话去续接（"我刚才说了…"说的是一句平台没收的话）。
 *
 * 本文件**只消费**回执，**不构造**回执：`SendReceipt` 的构造归 M10 act（README §3.5 归口裁定）。
 * 这里用 `contracts` 的 `validateSendReceipt` 当闸门，形状不合法的回执 = 没有回执。
 *
 * 纯函数：无 IO / 无时钟 / 无随机。
 */
import { validateSendReceipt } from '../../contracts/index.js';
import { renderText, toSegments } from './segments.js';

/** 默认保留最近几条。README 原文是「最近**几**轮」，5 条够用且不会把提示词顶爆。 */
export const DEFAULT_BOT_SAID_LIMIT = 5;

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * 单条候选 → `botSaidBefore` 的一条 `{id, text, at, self, persona2}`（contracts 形状），或 null。
 * 任何一处不合格都返回 null 并给出 issue —— **不猜、不补**。
 * ★ 双人格隔离（2026-10-14）：输出必须带 `self: true` 与 `persona2` 归属标，
 *   否则 `selfRowVisibleNow` 首行 `row?.self !== true` 直接放行，过滤形同虚设。
 *   `persona2` 从 candidate 透传（raw 消息 / 记忆行可能带）；旧数据无标 ⇒ `persona2: false`
 *   （= 第一人格行，与 `persona-hygiene.js` 存量约定一致：无标=第一人格，不丢不藏）。
 */
export function normalizeBotSaid(candidate, { onIssue = null } = {}) {
  const push = (code, extra = {}) => {
    onIssue?.({ code, ...extra });
    return null;
  };
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return push('bot-said-not-an-object');
  }

  const receipt = candidate.receipt;
  if (!receipt || typeof receipt !== 'object') return push('bot-said-without-receipt');
  const v = validateSendReceipt(receipt);
  if (!v.ok) return push('bot-said-receipt-invalid', { errors: v.errors.join('; ') });
  if (receipt.ok !== true) return push('bot-said-receipt-not-ok');

  const rawId = candidate.id ?? candidate.mid ?? candidate.message_id ?? receipt.platformId;
  const id = rawId === null || rawId === undefined ? '' : String(rawId).trim();
  if (!id) return push('bot-said-id-missing');

  if (typeof candidate.text !== 'string') return push('bot-said-text-not-string', { id });

  const at = isFiniteNumber(candidate.at) ? candidate.at
    : (isFiniteNumber(candidate.ts) ? candidate.ts
      : (isFiniteNumber(receipt.at) ? receipt.at : null));
  if (at === null) return push('bot-said-at-missing', { id });

  return { id, text: candidate.text, at, self: true, persona2: candidate.persona2 === true };
}

/**
 * 出 `botSaidBefore` 列表。
 *
 * @param {Array} pool 候选池（可混有 raw 自述消息，见 evidence.js 的合并）
 * @param {object} opts
 * @param {number|null} opts.at   只取"在这一刻**之前**说过的"（含同一毫秒）；null = 不设时间上界
 * @param {number} opts.limit     最多几条（取最近的）
 * @param {Function} opts.onIssue 诊断回调
 * @returns {Array<{id:string,text:string,at:number}>}
 */
export function selectBotSaidBefore(pool, { at = null, limit = DEFAULT_BOT_SAID_LIMIT, onIssue = null } = {}) {
  if (!Array.isArray(pool)) return [];
  const byId = new Map();
  for (const candidate of pool) {
    const entry = normalizeBotSaid(candidate, { onIssue });
    if (!entry) continue;
    if (at !== null && isFiniteNumber(at) && entry.at > at) continue;
    const prev = byId.get(entry.id);
    if (!prev || entry.at >= prev.at) byId.set(entry.id, entry); // 同 id 保最新
  }
  const list = [...byId.values()].sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_BOT_SAID_LIMIT;
  return list.slice(-n);
}

/**
 * 从一批入站原始项里挑出"机器人自己发的、且带成功回执"的项，转成候选池条目。
 * 没有回执的自述消息会被**明确报出来**（`self-message-without-receipt`）而不是悄悄丢。
 */
export function selfCandidatesFromRaw(rawList, { selfId = '', onIssue = null } = {}) {
  const out = [];
  const list = Array.isArray(rawList) ? rawList : [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (!item || typeof item !== 'object') continue;
    const senderId = item?.sender?.user_id ?? item?.sender?.id ?? item?.senderId ?? item?.user_id ?? item?.userId;
    const fromSelf = item?.post_type === 'message_sent' || isSameId(senderId, selfId);
    if (!fromSelf) continue;
    if (!item.receipt || typeof item.receipt !== 'object') {
      onIssue?.({ code: 'self-message-without-receipt', itemIndex: i, id: String(item.message_id ?? item.id ?? '') });
      continue;
    }
    out.push({
      id: item.message_id ?? item.id ?? item.mid,
      // 自述消息的正文：raw 里可能是段数组（协议端形态），也可能已经是 text —— 同 inbound 的收口顺序
      text: typeof item.text === 'string'
        ? item.text
        : renderText(toSegments(item.segments ?? item.message ?? item.raw_message), { onIssue }),
      at: item.at ?? item.ts ?? (isFiniteNumber(item.time) ? item.time * 1000 : undefined),
      receipt: item.receipt,
      // ★ 双人格归属标：raw 里可能带（chat-store 写入时打了 persona2:true）；无标 = 第一人格
      persona2: item.persona2 === true
    });
  }
  return out;
}

function isSameId(a, b) {
  const norm = (v) => (v === null || v === undefined ? '' : String(v).trim().replace(/^-/, ''));
  const x = norm(a);
  const y = norm(b);
  return Boolean(x) && Boolean(y) && x === y;
}
