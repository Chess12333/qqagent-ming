// Validation around the model judge: it may select source text, not invent a reply.
export function comparableReply(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function isQuietProtocolText(text) {
  return /^(?:finish|skip|\(?不回复\)?|\(?安静结束\)?)\s*[。.!！]?$/i.test(String(text || '').normalize('NFKC').trim());
}

// A quoted alternative can sound like a finished reply when read in isolation.
// Reject the entire editing draft, even if the judge selects its nicest line.
export function isReplyPlanningText(text) {
  return /(?:^|\n)\s*(?:或者|或是|选一个最自然的[。！!]?|回一句[^\n]*|用数组[^\n]*(?:发|回复)[：:]?)\s*(?:\n|$)|(?:->|→)\s*(?:太长|太短|有点|还行|不错|不行|更好)|(?:备选回复|候选回复|结合角色性格|最终回复[：:])/u.test(String(text || ''));
}

export function rememberReplyDraft(drafts, text) {
  const t = String(text || '').trim();
  if (!t || isQuietProtocolText(t) || isReplyPlanningText(t)) return;
  // Never send a chopped draft: oversized outputs are left to the normal tool path.
  if (t.length > 2400) return;
  const key = comparableReply(t) || t;
  if (!drafts.some(d => (comparableReply(d) || d) === key)) drafts.push(t);
  while (drafts.length > 4 || drafts.join('\n\n').length > 4800) drafts.shift();
}

export function draftReplyLines(text) {
  if (isReplyPlanningText(text)) return [];
  return String(text || '').split(/\n+/).map(line => line.trim()
    .replace(/^\[引用[^\]]*\]\s*/, '')
    .replace(/^(?:回复\s*)?#-?\d{4,}\s*/, '')
    .replace(/^我[：:]\s*/, '').trim())
    .filter(line => line && line.length <= 1200 && !isQuietProtocolText(line));
}

export function selectGroundedReplies(proposed, drafts, sent = []) {
  drafts = drafts.filter(d => !isReplyPlanningText(d));
  const sources = drafts.map(comparableReply);
  const sentKeys = sent.filter(s => s.type === 'text').map(s => comparableReply(s.text));
  const kept = [];
  for (const value of proposed || []) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (!text || text.length > 1200 || isQuietProtocolText(text)) continue;
    if (/【(?:本次唤醒|过去状态|角色设定|引导说明)】|<\/?(?:think|tool_call)>|#-?\d{4,}/i.test(text)) continue;
    if (/(?:算式是|原因是|分别是|如下|接下来|[:：])[\s…。.]*$/.test(text)) continue;
    // 思考/计划腔：裁判或模型误选分析行时在这里拦一刀
    // ⚠️ 2026-09-21 补口吻规则：实测群发出去的
    //   「有点得意的情绪，可以顺着"我神出鬼没"接梗。不用查记忆，这是玩笑话不是旧事细节。」
    // 是把提示词里的情绪提示（"倾向：可以接梗，别过火"）学舌了回来，老规则一条都没命中。
    if (/(?:根据|按照)(?:角色卡|人设|设定|规则|铁律|提示)|(?:我应该|我得|打算|准备先|这轮(?:该|要)|该不该(?:回|接|损)|得回一下|得回应|他这句|她这句)|(?:倾向[:：]|可以接梗|顺着.{0,8}接梗|别过火|沾一点|用得上就|用不上就|当没看见|别硬套|正来劲|闹开|抢话头|战果|往前拱一步)|(?:不用查记忆|不是旧事|这是玩笑话|别念时间戳|当常识)/.test(text)) continue;
    const key = comparableReply(text);
    // A one-character punctuation reply is valid only if it was itself a draft.
    if (!key ? !drafts.some(d => d.trim() === text) : !sources.some(s => s.includes(key))) continue;
    // Also reject a whole reply that embeds an earlier delivered phrase, instead
    // of resending that phrase plus a new suffix. The judge is asked to split it.
    if (sentKeys.some(k => k && key && (k === key || k.includes(key) || (k.length >= 4 && key.includes(k))))) continue;
    if (sent.some(s => s.type === 'text' && String(s.text).trim() === text)) continue;
    if (kept.some(k => (comparableReply(k) || k) === (key || text))) continue;
    kept.push(text);
  }
  return kept;
}

// Fit the remaining bubble budget without throwing away the end of a reply.
export function fitReplyBubbles(messages, slots) {
  const limit = Math.max(0, Math.floor(Number(slots) || 0));
  if (!limit) return [];
  if (messages.length <= limit) return messages;
  const result = [];
  for (let i = 0; i < messages.length;) {
    const size = Math.ceil((messages.length - i) / (limit - result.length));
    result.push(messages.slice(i, i + size).join('\n'));
    i += size;
  }
  return result;
}
