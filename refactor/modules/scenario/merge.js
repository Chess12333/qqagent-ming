/**
 * M5 scenario · merge.js —— 多片连发合并（**默认关闭**，必须显式开启）
 *
 * 事实前提：同一个人在两三秒内连发三条，口语上常常是「一句话被打了三次」。
 * 合并只做一件事：把分片正文**原样拼接**（默认用 `\n` 分隔），不重排、不概括、不补字、不改标点。
 *
 * ★ 为什么默认关闭：
 *   `contracts` 的 `MessageEvidence` **没有**存"这是由哪几片合成的"的字段
 *   （`makeMessageEvidence` 会把额外字段全部丢掉）。也就是说**合并后的证据无法自证合并**
 *   —— 一旦默认开启，下游再也分不出"用户一次说了这么长"和"用户分三条说的"。
 *   读盘证据不可改写是本阶段的立身之本，所以这件事必须由调用方显式选择。
 *   合并痕迹记进 `diagnostics.merges`（含分片 id），需要时可回溯。
 *
 * 合并不跨人、不跨会话、不跨引用目标：引用目标不同（一个引用 A、另一个引用 B）
 * 就是两件事，硬拼会把"引用归谁"搞错（验收第 9 条）。
 *
 * 纯函数：无 IO / 无时钟 / 无随机。
 */

export const MERGE_DEFAULTS = Object.freeze({
  enabled: false,
  windowMs: 12000,
  joiner: '\n',
  maxParts: 6
});

/** `merge` 选项可以给布尔（只开/关）或对象（细调）——两种都归一成完整形状。 */
export function resolveMergeOptions(input) {
  if (input === true) return { ...MERGE_DEFAULTS, enabled: true };
  if (!input || typeof input !== 'object') return { ...MERGE_DEFAULTS };
  const windowMs = Number.isFinite(input.windowMs) && input.windowMs >= 0 ? input.windowMs : MERGE_DEFAULTS.windowMs;
  const maxParts = Number.isSafeInteger(input.maxParts) && input.maxParts >= 1 ? input.maxParts : MERGE_DEFAULTS.maxParts;
  const joiner = typeof input.joiner === 'string' ? input.joiner : MERGE_DEFAULTS.joiner;
  return { enabled: input.enabled !== false, windowMs, joiner, maxParts };
}

function quoteKey(record) {
  const t = record?.refs?.replyTo;
  return t === null || t === undefined ? '' : String(t);
}

function mergePair(head, tail, { joiner, maxParts, windowMs }) {
  if (head.parts.length >= maxParts) return null;
  if (tail.isSelf || head.isSelf) return null;
  if (!head.senderId || head.senderId !== tail.senderId) return null;
  if (tail.at < head.at || tail.at - head.lastAt > windowMs) return null;
  if (quoteKey(head) !== quoteKey(tail)) return null;

  const mentionSeen = new Set(head.mentions.map((m) => String(m.id)));
  const mentions = head.mentions.slice();
  for (const m of tail.mentions) {
    if (mentionSeen.has(String(m.id))) continue;
    mentionSeen.add(String(m.id));
    mentions.push(m);
  }

  const texts = [head.text, tail.text].filter((t) => t !== '');
  return {
    ...head,
    lastAt: tail.at,
    text: texts.join(joiner),
    mentions,
    media: head.media.concat(tail.media),
    // 截断痕迹跟着合并走（裁定 2：合并过的证据也不能把"曾经截断"这件事丢掉）
    truncations: (head.truncations ?? []).concat(tail.truncations ?? []),
    refs: {
      toSelf: Boolean(head.refs.toSelf || tail.refs.toSelf),
      quoted: head.refs.quoted ?? tail.refs.quoted,
      replyTo: head.refs.replyTo ?? tail.refs.replyTo
    },
    hasReplySegment: Boolean(head.hasReplySegment || tail.hasReplySegment),
    parts: head.parts.concat(tail.parts ?? [tail.id])
  };
}

/**
 * 按输入顺序扫一遍，把能并的分片并起来。**输入顺序就是事实顺序**，本函数不排序。
 * @returns {{ records: Array, merges: Array<{id:string, parts:string[], text:string}> }}
 */
export function mergeRecords(records, options, { onIssue = null } = {}) {
  const opts = resolveMergeOptions(options);
  const list = Array.isArray(records) ? records : [];
  if (!opts.enabled) return { records: list, merges: [] };

  const out = [];
  const merges = [];
  for (const rec of list) {
    const head = out.length ? out[out.length - 1] : null;
    const candidate = head ? mergePair(head, rec, opts) : null;
    if (!candidate) {
      out.push({ ...rec, lastAt: rec.at, parts: [rec.id] });
      continue;
    }
    out[out.length - 1] = candidate;
    if (candidate.parts.length === 2) {
      const merged = { id: candidate.id, parts: candidate.parts.slice(), text: candidate.text };
      merges.push(merged);
      onIssue?.({ code: 'fragments-merged', id: candidate.id, parts: merged.parts.slice() });
    } else {
      const last = merges[merges.length - 1];
      if (last && last.id === candidate.id) {
        last.parts = candidate.parts.slice();
        last.text = candidate.text;
      }
      onIssue?.({ code: 'fragments-merged', id: candidate.id, parts: candidate.parts.slice() });
    }
  }
  return { records: out, merges };
}
