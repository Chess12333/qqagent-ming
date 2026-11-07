/**
 * M-card · cards.js —— 分享卡片（OneBot `json` / `xml` 段）→ 可读事实。纯函数，无 IO。
 *
 * 为什么有这个文件（2026-10-27）：
 *   原先两处渲染（`platform/onebot.js:segmentsToText` 与 `scenario/segments.js:shareCardText`）
 *   只做一件事——从卡片里抠 B 站链接。抠不到就输出 `[卡片消息]`，卡片上写的字
 *   （标题、描述、小程序名、标签、预览图）全部丢掉。结果就是「溟看不懂 QQ 卡片」：
 *   群里分享的知乎/公众号/小红书/漫画/小程序卡，到模型眼里全是三个字的占位符。
 *
 * 本文件只做「把卡片上的字拿出来」，不判断要不要点、不猜内容：
 *   - `cardFacts(segData)`  → { app, tag, title, desc, url, image, kind } | null
 *   - `cardText(segData)`   → 一行可读文本（拿不到就 '[卡片消息]'）
 *   - `xmlFacts(segData)` / `xmlText(segData)` 同理，给 svcId 不是 1 的 XML 卡
 *
 * ★ 输出契约：B 站卡保持老的 `[B站视频 标题](url)` 形状（下游 parse_video 认得），
 *   其余卡用 `[卡片·<来源>：<标题>｜<描述>](url)`，永远把 url 放在行尾括号里。
 */

/** 常见 app 包名 → 人话（拿不到 tag 时兜底，别把 com.tencent.xxx 直接甩给模型）。 */
const APP_LABEL = {
  'com.tencent.structmsg': '分享',
  'com.tencent.miniapp_01': '小程序',
  'com.tencent.miniapp': '小程序',
  'com.tencent.music.lua': '音乐',
  'com.tencent.troopshare': '群分享',
  'com.tencent.contact.lua': '名片',
  'com.tencent.qzone': '空间',
  'com.tencent.reading': '阅读',
  'com.tencent.gamecenter': '游戏',
  'com.tencent.qqsports': '体育',
  'com.tencent.tuwen.lua': '图文'
};

const TEXT_LIMIT = 80;
const DESC_LIMIT = 120;
/** 只说明「这是什么应用」、不说明「这张卡在讲什么」的标题（B 站/QQ/微信这类）。 */
const GENERIC_TITLE = /^(哔哩哔哩|哔哩哔哩弹幕网|bilibili|b站|qq|微信|小程序|公众号|腾讯文档|分享|网页分享)$/i;

function str(v) {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

function clip(s, n) {
  const t = str(s).replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function isHttp(u) {
  return /^https?:\/\//i.test(str(u));
}

/** QQ 卡里的转义有时是 HTML 实体，有时是嵌套字符串；逐层试，试到对象为止。 */
export function parseCardPayload(segData) {
  if (!segData || typeof segData !== 'object') return null;
  let raw = segData.data ?? segData.json ?? segData;
  // 宽容一层包装：传进来的可能是整段 `{type:'json', data:{data:'<json>'}}`，
  // 也可能是段的 data `{data:'<json>'}`。剥到「装有卡片 JSON 的那一层」为止。
  for (let i = 0; i < 3 && raw && typeof raw === 'object' && !Array.isArray(raw)
    && raw.meta === undefined && raw.app === undefined && raw.data !== undefined; i += 1) {
    raw = raw.data;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const candidates = [
    raw,
    raw.replace(/&quot;/g, '"').replace(/&#44;/g, ',').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&')
  ];
  for (const text of candidates) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* 换下一个候选 */ }
  }
  return null;
}

/** 「当前QQ版本不支持此应用，请升级」这类服务端兜底字，别当标题用。 */
function isFallbackPrompt(text) {
  return /当前\s*QQ\s*版本|请升级|不支持此应用/i.test(text);
}

/**
 * 卡片 JSON → 事实对象。拿不到任何字段返回 null（调用方退回 `[卡片消息]`）。
 *
 * meta 的结构按卡片类型各不相同（detail_1 / news / music / video / mannounce / …），
 * 所以不枚举到底，先按常见顺序试，再退到「第一个带 title/desc/preview 的键」。
 */
export function cardFacts(segData) {
  const obj = parseCardPayload(segData);
  if (!obj) return null;

  const meta = obj.meta && typeof obj.meta === 'object' && !Array.isArray(obj.meta) ? obj.meta : {};
  const preferred = ['detail_1', 'detail', 'news', 'music', 'video', 'mannounce', 'detail_2', 'image', 'bigimage'];
  const keys = [...preferred, ...Object.keys(meta).filter((k) => !preferred.includes(k))];

  let node = null;
  for (const key of keys) {
    const v = meta[key];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (str(v.title) || str(v.desc) || str(v.preview) || str(v.jumpUrl) || str(v.qqdocurl)) { node = v; break; }
  }

  const app = str(obj.app);
  const prompt = str(obj.prompt);
  const rawTitle = clip(node?.title ?? '', TEXT_LIMIT) || (!isFallbackPrompt(prompt) ? clip(prompt, TEXT_LIMIT) : '');
  const rawDesc = clip(node?.desc || obj.desc || node?.source || '', DESC_LIMIT);

  const tag = str(node?.tag)
    || str(obj.extra?.name)
    || str(meta.tag)
    || APP_LABEL[app]
    || '';

  // 标题里已经带来源前缀（「群分享：养鱼基地」「[分享]哔哩哔哩」）就把那一截剥掉，
  // 免得渲染成「卡片·群分享：群分享：养鱼基地」。
  let title = tag && rawTitle.startsWith(`${tag}：`) ? rawTitle.slice(tag.length + 1).trim() : rawTitle;
  let desc = rawDesc;

  // ★ 2026-10-27 实测（真实群数据）：B 站小程序卡的 `title` 是应用名「哔哩哔哩」，
  //   真标题写在 `desc` 里（「双人抬棺」「夏目安安打字桌宠分享」）。只认 title 的话
  //   渲染出来永远叫「哔哩哔哩」。所以：title 是通用应用名（或与来源同名）且 desc 有字 ⇒ 换过来。
  if (desc && (!title || GENERIC_TITLE.test(title) || title === tag)) {
    title = desc;
    desc = '';
  }

  const urlCandidates = [
    obj.jumpUrl, obj.url, obj.jumpurl,
    node?.jumpUrl, node?.jumpurl, node?.url, node?.qqdocurl, node?.jump_url,
    obj.extra?.jumpUrl
  ];
  let url = '';
  for (const c of urlCandidates) {
    if (isHttp(c)) { url = str(c).replace(/[),。，]+$/, ''); break; }
  }
  if (!url) {
    const blob = JSON.stringify(obj);
    const m = blob.match(/https?:\/\/(?:www\.)?bilibili\.com\/video\/[A-Za-z0-9]+/)
      || blob.match(/https?:\/\/[^\s"'\\]+/);
    if (m) url = m[0];
  }

  const image = [node?.preview, node?.bigImage, node?.imageUrl, obj?.preview]
    .map((v) => str(v))
    .find((v) => isHttp(v)) || '';

  if (!title && !desc && !url && !image) return null;

  const kind = /bilibili\.com|b23\.tv|BV[0-9A-Za-z]{10}/i.test(`${url} ${title} ${tag}`) ? 'bili' : 'card';
  return { app, tag, title, desc, url, image, kind };
}

/** 事实 → 一行文本。B 站保留老形状，其余按「来源·标题｜描述(链接)」。 */
export function cardText(segData) {
  const f = cardFacts(segData);
  // 「当前QQ版本不支持此应用」这种卡是**服务端没把内容给协议端**，不是坏消息：
  // 明说「未展开」，模型才知道该请对方贴文字/链接，而不是假装看见了。
  if (!f) return hasServerFallback(segData) ? '[卡片消息·内容未展开]' : '[卡片消息]';
  if (f.kind === 'bili') return `[B站视频 ${f.title || '分享'}](${f.url})`;
  const head = [f.tag ? `卡片·${f.tag}` : '卡片', f.title || '分享'].join('：');
  const body = f.desc ? `${head}｜${f.desc}` : head;
  return f.url ? `[${body}](${f.url})` : `[${body}]`;
}

/** 卡里只有 QQ 的兜底提示（拿不到真实内容）时为 true。 */
function hasServerFallback(segData) {
  const obj = parseCardPayload(segData);
  const prompt = str(obj?.prompt);
  return Boolean(prompt && isFallbackPrompt(prompt));
}

/** XML 卡（svcId 不是 1 的那些：公众号文章、音乐、老式网页卡）里的字段。 */
export function xmlFacts(segData) {
  let raw = segData?.data ?? segData?.xml ?? segData ?? '';
  for (let i = 0; i < 3 && raw && typeof raw === 'object' && !Array.isArray(raw) && raw.data !== undefined; i += 1) raw = raw.data;
  const text = typeof raw === 'string' ? raw : '';
  if (!text || !text.includes('<')) return null;
  const pick = (tag) => {
    const m = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i').exec(text);
    return m ? m[1].trim() : '';
  };
  const title = clip(pick('title') || pick('brief'), TEXT_LIMIT);
  const desc = clip(pick('summary') || pick('abstract'), DESC_LIMIT);
  const url = [pick('url'), pick('jumpurl')].find((u) => isHttp(u)) || '';
  const image = [pick('thumburl'), pick('preview')].find((u) => isHttp(u)) || '';
  const source = clip(pick('sourcedisplayname') || pick('sourcename'), 20);
  if (!title && !desc && !url) return null;
  return { app: 'xml', tag: source, title, desc, url, image, kind: /bilibili\.com|b23\.tv/i.test(url) ? 'bili' : 'card' };
}

export function xmlText(segData) {
  const f = xmlFacts(segData);
  if (!f) return '[XML消息]';
  if (f.kind === 'bili') return `[B站视频 ${f.title || '分享'}](${f.url})`;
  const head = [f.tag ? `卡片·${f.tag}` : '卡片', f.title || '分享'].join('：');
  const body = f.desc ? `${head}｜${f.desc}` : head;
  return f.url ? `[${body}](${f.url})` : `[${body}]`;
}
