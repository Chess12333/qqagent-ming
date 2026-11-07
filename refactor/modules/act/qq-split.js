/**
 * 群里长句拆条（2026-10-29 她点的）。
 *
 * 起因：她在群里截了一句我发的「高松灯那声音轻得像怕吵到人，我这嗓子学不来」——
 * 21 字、两个动作（先描写再收结论），说「怎么又开始大长段了」。
 * 同一天量过真人语料：458 条短句，中位 5 字、41% 不超过 4 字、一个句号都没有；
 * 而我 647 条里中位 11 字、≤4 字只占 9%。**群里一条只该干一件事。**
 *
 * 这张卡上写了「一句 8–15 字」，照样发长句——写在卡上的规矩不拦人，得在出口拦。
 * 做法：只在群里、只在这一批只有一条正文时，把超过 18 字的那条在最后一个逗号处拆成两条；
 * 句末的句号直接去掉（语料里 458 条没有一个句号）。私聊不动，技术长文不动（那种改成两条也不好读）。
 *
 * 回滚：把 index.js 里对 splitLongGroupBubbles 的调用删掉即可，本文件留着不生效。
 */

const MAX_LEN = 18;
const MIN_PART = 3;

function stripTrailingPeriod(text) {
  return String(text ?? '').replace(/[。.]+\s*$/, '');
}

/** 在最后一个能让两边都站得住的逗号处切开；切不动就原样返回。 */
function splitOnce(text) {
  const marks = ['，', ',', '；', ';'];
  for (let i = text.length - 1; i > 0; i -= 1) {
    if (!marks.includes(text[i])) continue;
    const head = text.slice(0, i).trim();
    const tail = text.slice(i + 1).trim();
    if (head.length >= MIN_PART && tail.length >= MIN_PART) return [head, tail];
  }
  return null;
}

/**
 * @param {string[]} messages 待发的正文（`send_message` 的 messages）
 * @param {string} chatKey 会话键（群才处理）
 * @param {{cap?: number}} options cap = 本轮还能发几条文字
 * @returns {string[]}
 */
export function splitLongGroupBubbles(messages, chatKey, options = {}) {
  const raw = Array.isArray(messages) ? messages.map((m) => String(m ?? '')) : [];
  const isGroup = /group/i.test(String(chatKey ?? ''));
  if (!isGroup) return raw;
  const list = raw.map(stripTrailingPeriod);
  // 只处理「这一批就一条」的情形：多条本来就已经分好条，再拆会挤掉别人的配额。
  if (list.length !== 1) return list;
  const cap = Number.isFinite(options.cap) ? options.cap : Number.POSITIVE_INFINITY;
  if (cap < 2) return list;
  const only = String(list[0] ?? '').trim();
  if (!only || only.length <= MAX_LEN) return list;
  const parts = splitOnce(only);
  if (!parts) return [only];
  return parts;
}

export default splitLongGroupBubbles;
