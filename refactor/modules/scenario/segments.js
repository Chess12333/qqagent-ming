/**
 * M5 scenario · segments.js —— 消息段 → 事实（纯函数：无 IO / 无时钟 / 无随机 / 无网络）
 *
 * 阶段 A 只还原事实。本文件负责三件事：
 *   1. 把"协议端可能给的各种形态"（OneBot 段数组 / CQ 字符串 / 纯文本）统一成段数组；
 *   2. 把段数组渲染成**规范化正文**（非文本段只给占位符，绝不概括、绝不润色、绝不补字）；
 *   3. 从段数组里抽出三件事实：谁被点了名（mentions）/ 引用了哪条（refs）/ 有哪些媒体（media）。
 *
 * ★★ 本文件的两条硬规矩（都是验收条款的直接实现，改动前先读 README §6）：
 *
 *  ① **引用段永远不参与正文渲染。**
 *     被引用的原话只进 `refs.quoted`，正文里连「[引用…]」这种占位符都不放。
 *     理由：原话里的那个「我」如果被拼进正文，下游（B/C/D）就会把它当成
 *     **当前说话人**说的「我」—— 这正是验收第 9 条「引用里的『我』不被误认」的成因。
 *     旧实现（`src/app.js` → `onebot.segmentsToText`）恰恰把 `[引用 #318 A：原话]`
 *     拼进了正文；**这是本模块故意改掉的行为**。
 *
 *  ② **媒体只记「这张图存在 + 已知描述」，一个发送者字段都不带。**
 *     画面内容不属于发图人（验收第 6 条）。`media[]` 里没有 sender 字段 ⇒ 结构上
 *     不可能把图里的内容归因给发图人；测试也按这个形状断言。
 */

// 卡片渲染与入站那一路共用一套（纯函数、无 IO）：见 platform/cards.js 顶部的说明。
import { cardText, xmlText } from '../platform/cards.js';

/** 媒体类型白名单 —— 与 `contracts` 的 `media[].type` 枚举**逐字一致**，多一个都没有。 */
export const MEDIA_TYPES = ['image', 'sticker', 'video'];

/**
 * 分享卡片段 → 正文占位符。
 *
 * 2026-10-27：实现已挪到 `platform/cards.js`（纯函数，无 IO，仍满足本文件的「无网络/无时钟」约束），
 * 因为入站 chat-store 那一路（`platform/onebot.js:segmentsToText`）也得用同一套。
 * 老实现在这里只认 B 站链接，其余卡片一律 `[卡片消息]`——卡片上的标题/描述/来源全丢。
 */
export function shareCardText(segData) {
  return cardText(segData);
}

/** 非文本段的正文占位符。查不到的表项走 `[<段类型>]` 兜底（旧实现同款行为）。 */
const SEGMENT_PLACEHOLDER = {
  face: (d) => (d.id !== undefined && d.id !== null && String(d.id) !== '' ? `[表情${d.id}]` : '[表情]'),
  mface: () => '[表情]',
  image: () => '[图片]',
  record: () => '[语音]',
  video: () => '[视频]',
  file: (d) => (d.name ? `[文件${d.name}]` : '[文件]'),
  json: (d) => shareCardText(d),   // ★ 2026-10-27：标题/描述/来源/预览图都拿出来（cards.js）
  xml: (d) => xmlText(d),          // ★ 同上：老式 XML 卡（公众号文章/音乐/网页卡）
  forward: () => '[合并转发聊天记录]'
};
// ★ `reply` **刻意不在上表里**：它在下面的渲染循环里被显式 `continue` 掉（规矩①）。
//   这里以前留过一个 `reply: () => ''` —— 那是**死表项**（永远走不到），已删。
//   死表项的危害不是多一行，而是让"改这一行会红"的变异自检给出**假绿**（本次实测踩到）。

const CQ_CODE = /\[CQ:([A-Za-z_]+)((?:,[^\]]*)?)\]/g;

/** CQ 字符串里的转义还原（OneBot 规定：&#44; ,  &#91; [  &#93; ]  &amp; &）。 */
export function decodeCqValue(raw) {
  return String(raw ?? '')
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&');
}

/** CQ 字符串 → 段数组。CQ 码之间的裸文本原样变成 text 段（转义已还原）。 */
export function parseCqString(input) {
  const text = String(input ?? '');
  const out = [];
  let last = 0;
  CQ_CODE.lastIndex = 0;
  let m;
  while ((m = CQ_CODE.exec(text)) !== null) {
    if (m.index > last) {
      const plain = decodeCqValue(text.slice(last, m.index));
      if (plain) out.push({ type: 'text', data: { text: plain } });
    }
    const data = {};
    for (const kv of String(m[2] || '').split(',')) {
      if (!kv) continue;
      const eq = kv.indexOf('=');
      if (eq < 0) continue;
      data[kv.slice(0, eq)] = decodeCqValue(kv.slice(eq + 1));
    }
    out.push({ type: m[1], data });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    const plain = decodeCqValue(text.slice(last));
    if (plain) out.push({ type: 'text', data: { text: plain } });
  }
  return out;
}

/**
 * 任意入参形态 → 段数组。**宽容收口，不猜语义**：
 *   - 数组：按 `{type, data}` 过一遍（丢掉没有 type 的项，不去重、不排序）
 *   - 字符串：含 `[CQ:` 按 CQ 解析，否则当一条 text 段
 *   - 对象：依次找 `segments` / `message` / `text`
 *   - 其它：空数组
 */
export function toSegments(input) {
  if (input === null || input === undefined) return [];
  if (typeof input === 'string') {
    if (!input) return [];
    return input.includes('[CQ:') ? parseCqString(input) : [{ type: 'text', data: { text: input } }];
  }
  if (Array.isArray(input)) {
    const out = [];
    for (const seg of input) {
      if (!seg || typeof seg !== 'object' || Array.isArray(seg)) continue;
      const type = String(seg.type ?? '');
      if (!type) continue;
      const data = seg.data && typeof seg.data === 'object' && !Array.isArray(seg.data) ? seg.data : {};
      out.push({ type, data });
    }
    return out;
  }
  if (typeof input === 'object') {
    if (Array.isArray(input.segments)) return toSegments(input.segments);
    if (Array.isArray(input.message)) return toSegments(input.message);
    if (typeof input.message === 'string') return toSegments(input.message);
    if (typeof input.raw_message === 'string') return toSegments(input.raw_message);
    if (typeof input.text === 'string') return toSegments(input.text);
  }
  return [];
}

/** 平台 id 规范化：去首部 `-`（QQ 侧会给 `-123` 这种形态）、转字符串。 */
export function normalizeId(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim().replace(/^-/, '');
}

/**
 * ★ 2026-10-19（第六批）：**消息 id** 的规范化 —— 只 trim + 转字符串，**保留负号**。
 *   QQ/OneBot 的 message_id 可以是负数（`-997425862`），负号是 id 的一部分；
 *   用 `normalizeId`（按用户 id 去符号）会把 `-123` 变成 `123` ⇒ 存档 findByRef 与
 *   get_msg 回读全部查错/查不到（用户报"@机器人消息的引用原话看不到"的直接原因之一）。
 */
export function normalizeMessageId(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/** 这个 id 是不是机器人自己。空 id / `all` 一律**不算**（宁可不认，不误认）。 */
export function isSelfId(id, selfId) {
  const a = normalizeId(id);
  const b = normalizeId(selfId);
  return Boolean(a) && Boolean(b) && a === b && a !== 'all';
}

/**
 * `at` 段的展示名。解析不到就用号码 —— **绝不联网、绝不用时钟**。
 * 名字来源优先级：段里自带的 `name`（NapCat 会给）> 注入的同步 `resolveAtName` > 号码本身。
 */
function atFact(data, resolveAtName, onIssue) {
  const qq = normalizeId(data?.qq ?? data?.user_id);
  if (qq === 'all' || qq === 'everyone') return { id: 'all', name: '全体成员' };
  const explicit = typeof data?.name === 'string' ? data.name.trim() : '';
  if (explicit) return { id: qq, name: explicit };
  if (qq && typeof resolveAtName === 'function') {
    try {
      const r = resolveAtName(qq);
      if (r && typeof r.then === 'function') {
        // 同步契约：异步解析器一律忽略（此处无 await，拿 Promise 会变成 "[object Promise]"）
        onIssue?.({ code: 'async-name-resolver-ignored', at: qq });
      } else if (typeof r === 'string' && r.trim()) {
        return { id: qq, name: r.trim() };
      }
    } catch (e) {
      onIssue?.({ code: 'name-resolver-failed', at: qq, message: String(e?.message ?? e) });
    }
  }
  return { id: qq, name: qq };
}

/**
 * 规范化正文。**拼接 + trim，仅此而已**；不概括、不润色、不翻译、不删中间内容。
 * @returns {string}
 */
export function renderText(segments, { resolveAtName = null, onIssue = null } = {}) {
  const parts = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'text') {
      parts.push(String(d.text ?? ''));
      continue;
    }
    if (seg.type === 'at') {
      const fact = atFact(d, resolveAtName, onIssue);
      parts.push(fact.name ? `@${fact.name}` : '@');
      continue;
    }
    if (seg.type === 'reply') continue; // ★ 规矩①
    const fn = SEGMENT_PLACEHOLDER[seg.type];
    parts.push(typeof fn === 'function' ? fn(d) : `[${seg.type}]`);
  }
  return parts.join('').trim();
}

/**
 * `at` 段 → `mentions[]`（形状与 contracts 一致：`{id, name, isSelf}`）。
 * 同一个人被 @ 两次只留一条（首个出现的位置）。**只读本条消息的段**，
 * 被引用那条里的 @ 绝不混进来（否则「引用了别人 @ 某人」会变成「本条 @ 了某人」）。
 */
export function collectMentions(segments, { selfId = null, resolveAtName = null, onIssue = null } = {}) {
  const out = [];
  const seen = new Set();
  for (const seg of segments ?? []) {
    if (!seg || seg.type !== 'at') continue;
    const fact = atFact(seg.data ?? {}, resolveAtName, onIssue);
    const key = String(fact.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: fact.id, name: fact.name, isSelf: isSelfId(fact.id, selfId) });
  }
  return out;
}

/**
 * 媒体条:形状**只有** `{type, id, desc?, ocr?}` —— 刻意没有 sender 字段（规矩②）。
 *
 * ★ N42（用户实机报「识图看不了动图」）：**`desc` 只能来自真视觉识别**。
 *   协议端 image 段里的 `summary` 是**平台占位文字**，不是画面结论 —— 实测真实
 *   `data/messages` 里 63700 条图片媒体带 `[xx]` 形 summary（`[挠头]`/`[没钱了]`/`[思考]`，
 *   其中 1294 条 GIF 的 summary 100% 是同一条消息正文里已有的占位名）。
 *   老树同样不当描述用：`src/onebot.js:617` 只把 summary 存进媒体记录，
 *   `src/prompt.js` 的 `formatEntry` 从不注入它（老树靠"自动附图"让模型直接看图）。
 *   ⇒ 新树若把 summary 搬进 `desc`，提示词就会把平台占位文字渲染成
 *     "画面描述（来源：视觉识别…）" —— 那正是"看图失败却装得像看见了"的假证据。
 */
function mediaEntry(type, id, source) {
  const entry = { type, id: String(id ?? '') || type };
  if (source && typeof source === 'object') {
    const desc = typeof source.desc === 'string' ? source.desc.trim() : '';
    if (desc) entry.desc = desc;
    const ocr = typeof source.ocr === 'string' ? source.ocr.trim() : '';
    if (ocr) entry.ocr = ocr;
  }
  return entry;
}

function firstNonEmpty(list) {
  for (const v of list) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

/**
 * 本条消息带的媒体 → `media[]`。
 * 语音/文件/卡片/转发**没有** contracts 的枚举位 ⇒ 不进 media（正文里仍有 `[语音]` 等占位符，
 * 事实不丢），但会报一条 `media-type-unsupported` 到 diagnostics —— **不静默丢**。
 */
export function collectMedia(segments, { onIssue = null } = {}) {
  const out = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    switch (seg.type) {
      case 'image':
        out.push(mediaEntry('image', firstNonEmpty([d.url, d.file, d.file_id, d.id]), d));
        break;
      case 'video':
        out.push(mediaEntry('video', firstNonEmpty([d.file, d.url, d.file_id, d.id]), d));
        break;
      case 'face':
        out.push(mediaEntry('sticker', firstNonEmpty([d.id, d.face_id]), null));
        break;
      case 'mface':
        out.push(mediaEntry('sticker', firstNonEmpty([d.emoji_id, d.emoji_package_id, d.id]), null));
        break;
      case 'text':
      case 'at':
      case 'reply':
        break;
      default:
        onIssue?.({ code: 'media-type-unsupported', type: seg.type });
        break;
    }
  }
  return out;
}

/**
 * 把外部（协议端 / M3 platform / 上游预抽）给的媒体定位信息**归一**成 contracts 的形状。
 * 认得两种：M3 `extractMediaFromSegments` 的 `{kind,file,url,summary,faceId}`，以及已经合法的 `{type,id,desc,ocr}`。
 *
 * ★ N42：`{kind:…}` 这支只做**定位**（file/url → id）。它带的 `summary` 是平台占位文字
 *   （见 `mediaEntry` 上方的实测记录），**不搬进 `desc`** —— desc 只收真视觉识别。
 *   真要给模型看画面，走"自动看图"（老树 `src/orchestrator.js:3061-3121` 那一套）。
 */
export function normalizeMediaList(list, { onIssue = null } = {}) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (MEDIA_TYPES.includes(item.type)) {
      out.push(mediaEntry(item.type, item.id, { desc: item.desc, ocr: item.ocr }));
      continue;
    }
    if (item.kind === 'image') {
      out.push(mediaEntry('image', firstNonEmpty([item.url, item.file, item.id]), null));
      continue;
    }
    if (item.kind === 'face') {
      out.push(mediaEntry('sticker', firstNonEmpty([item.faceId, item.id]), null));
      continue;
    }
    onIssue?.({ code: 'media-item-unsupported', kind: String(item.kind ?? item.type ?? '') });
  }
  return out;
}

/** 取本条消息里第一个 `reply` 段（一条消息最多只认一个引用目标）。 */
export function findReplySegment(segments) {
  for (const seg of segments ?? []) {
    if (seg && seg.type === 'reply') return seg;
  }
  return null;
}

/** 上游给的引用信息（协议端解析过 / 上游预存）→ 统一内部形状。字段名做宽收口，语义只有一个。 */
export function normalizeQuoteInfo(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const id = x.id ?? x.mid ?? x.message_id ?? x.messageId ?? null;
  const sender = typeof x.sender === 'string' ? x.sender.trim()
    : (typeof x.senderName === 'string' ? x.senderName.trim() : '');
  const senderId = x.senderId ?? x.user_id ?? x.userId ?? null;
  const self = x.isSelf === true || x.self === true;
  const text = typeof x.text === 'string' ? x.text : '';
  return { id: id === null || id === undefined ? '' : String(id), sender, senderId, self, text };
}

/**
 * 引用事实。**要点**：`replyTo` 是"引用目标的消息 id"，只要有 `reply` 段就一定有值；
 * `quoted` 只在**真拿到了被引内容**时才给（解析不到就是 null，不编）。
 * 被引用者的身份只用于判定 `toSelf`（引用机器人 = 在跟机器人说话，平台字段最可靠）
 * 和拼 `quoted.sender` 标签，**绝不把被引内容并进 `text`**（规矩①）。
 */
export function collectRefs(segments, { selfId = null, resolveQuote = null, quoteHint = null, onIssue = null } = {}) {
  const seg = findReplySegment(segments);
  // ★ 2026-10-19（第六批）：引用目标是**消息 id**，保留负号（`-123` ≠ `123`）。
  const segId = seg ? normalizeMessageId(seg.data?.id) : '';
  const hint = normalizeQuoteInfo(quoteHint);
  const replyTo = segId || (hint?.id ? String(hint.id) : '');
  if (!replyTo) return { toSelf: false, quoted: null, replyTo: null };

  let info = null;
  if (hint && hintMatchesId(hint.id, replyTo)) info = hint;
  else if (typeof resolveQuote === 'function') info = callQuoteResolver(resolveQuote, replyTo, onIssue);

  const quotedSenderIsSelf = Boolean(info) && (info.self === true || isSelfId(info.senderId, selfId));
  const hasContent = Boolean(info) && (info.sender !== '' || info.text !== '');
  const sender = info && info.sender
    ? info.sender
    : (info && normalizeId(info.senderId) ? `QQ${normalizeId(info.senderId)}` : '');
  return {
    toSelf: quotedSenderIsSelf,
    // senderId/self 透传（2026-10-13 指挥裁定）：下游 author-label/compose 靠这两个字段出"原作者
    // 与是不是自己"，丢了只能降级成"未知作者"+ 走 store 回填（同一条数据两个来源）。self 用已算出的
    // quotedSenderIsSelf（info.self 或 senderId 对上 selfId 同源值），不另起第二份判定。
    quoted: hasContent
      ? { id: replyTo, sender, senderId: info.senderId ?? null, self: quotedSenderIsSelf, text: info.text }
      : null,
    replyTo
  };
}

/** hint 没有 id 时视为"就是这条"；有 id 时必须对上（对不上宁可去问 resolver，不硬套）。 */
function hintMatchesId(hintId, replyTo) {
  return hintId === '' || String(hintId) === String(replyTo);
}

function callQuoteResolver(resolveQuote, id, onIssue) {
  try {
    const r = resolveQuote(id);
    if (r && typeof r.then === 'function') {
      onIssue?.({ code: 'async-quote-resolver-ignored', id });
      return null;
    }
    return normalizeQuoteInfo(r);
  } catch (e) {
    onIssue?.({ code: 'quote-resolver-failed', id, message: String(e?.message ?? e) });
    return null;
  }
}
