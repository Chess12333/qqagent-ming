/**
 * M8b · 近 N 小时本地摘要（纯函数，零 IO）。
 *
 * 出处（老树 `src/conversation-memory/archive.js:20-74` `buildRecent24hDigest`，逐字搬逻辑）：
 *   扫原始存档 → 压成「话题词 + 短句样本」，不调模型。用于可选注入提示词。
 *
 * ★ 与老树的差异（只有入参形状）：
 *   老树吃 `messagesDir + chatKey` 自己读盘；本层吃**已加载好的消息数组**（调用方从
 *   chatStore facade 读），保持纯函数、不碰存储。过滤/截断逻辑与老树逐条对齐。
 * ★ 只做文本压缩与拼装；时间窗口过滤、排除本轮消息、读盘都归调用方（compose.js）。
 */

/** 参数钳制（老树 `src/orchestrator.js:487-490` 逐字）。 */
export function clampDigestParams(d = {}) {
  return {
    hours: Math.max(1, Number(d.hours) || 24),
    maxChars: Math.min(600, Math.max(80, Number(d.maxChars) || 240)),
    maxItems: Math.min(16, Math.max(2, Number(d.maxItems) || 8))
  };
}

/**
 * 近 N 小时本地摘要：把消息数组压成短话题线索。
 * @param {Array<{ts?:number, text?:string, self?:boolean, senderName?:string, senderId?:string, hype?:boolean, persona2?:boolean}>} messages
 *   调用方已按时间窗口过滤（ts >= cutoff）并剔除本轮 evidence；本函数只做内容过滤与压缩。
 * @param {{maxChars?:number, maxItems?:number}} params（hours 由调用方用于 cutoff，这里不重复用）
 * @returns {string} 空消息时返回 ''；超 maxChars 截尾加省略号。
 */
export function buildRecent24hDigest(messages, { maxChars = 240, maxItems = 8 } = {}) {
  const chars = Math.min(600, Math.max(80, Number(maxChars) || 240));
  const items = Math.min(16, Math.max(2, Number(maxItems) || 8));
  // 亢奋时段自己发的话不进摘要（避免正常态被骂人腔带偏）——老树 archive.js:27 逐字
  const HYPE_SELF_RE = /北极爷|鲸爷跟您|您算哪根|歇了吧您|红眼的在上班|眼睛红了可不怪我|滚回你的温带|浮冰/;
  const msgs = (Array.isArray(messages) ? messages : [])
    .filter((m) => {
      const t = String(m?.text || '').trim();
      if (!t) return false;
      if (/^\[(图片|表情|贴图|语音|视频)\]$/.test(t)) return false;
      if (m?.self && (m?.hype === true || HYPE_SELF_RE.test(t))) return false;
      // 第二人格时段自己发的话也不进摘要（老树 archive.js:35-37）
      if (m?.self && m?.persona2 === true) return false;
      return t.length >= 4;
    });
  if (!msgs.length) return '';

  const freq = new Map();
  for (const m of msgs) {
    const text = String(m.text || '').toLowerCase();
    for (const ch of text.match(/[\u4e00-\u9fff]{2,}|[a-z0-9_]{3,}/g) || []) {
      if (ch.length < 2) continue;
      if (/^(这个|那个|就是|还是|但是|因为|所以|什么|怎么|可以|没有|我们|你们|他们|自己|一下|不是|如果|现在|时候)$/.test(ch)) continue;
      freq.set(ch, (freq.get(ch) || 0) + 1);
    }
  }
  const topics = [...freq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([w, n]) => `${w}\u00d7${n}`);

  const samples = msgs
    .map((m) => {
      const t = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 48);
      const who = m.self ? '\u6211' : (m.senderName || m.senderId || '?');
      return { t, who, score: t.length + (/[?？]/.test(t) ? 2 : 0) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, items)
    .map((s) => `${s.who}: ${s.t}`);

  const parts = [];
  if (topics.length) parts.push(`\u8bdd\u9898\u8bcd: ${topics.join(' ')}`);
  if (samples.length) parts.push(samples.join(' | '));
  let out = parts.join('\n');
  if (out.length > chars) out = out.slice(0, chars - 1) + '\u2026';
  return out;
}

/**
 * 【近24h本地摘要】注入文案（老树 `src/orchestrator.js:2937` 逐字口径）。
 * @param {string} digest `buildRecent24hDigest` 的产物；空串时调用方不应调本函数。
 * @returns {string}
 */
export function buildRecentDigestInject(digest) {
  return `\u3010\u8fd124h\u672c\u5730\u6458\u8981\u3011\n${String(digest ?? '').trim()}\n\uff08\u788e\u7247\u7ebf\u7d22\uff0c\u7ec6\u8282\u7528 memory_search/archive\uff09`;
}
