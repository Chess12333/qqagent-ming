// 联网搜索（移植自原版 bingSearch）：Bing 中文搜索，无需 API key。
// 搜索请求本身用普通 fetch（搜索 URL 是管理端配置的可信地址，只需清洗查询词）；
// 对外抓取网页正文一律走 safe-fetch（web_fetch 工具）。
import { getConfig } from '../../core/config-store/index.js';
import { safeFetch, composeAbortSignal, abortError, throwIfAborted } from './safe-fetch.js';

/** 查询词清洗：去 CQ 码、控制字符、超长截断。 */
export function sanitizeQuery(query) {
  return String(query ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // 上限 200：浏览锁定会往查询词后面追加 `site:xxx`（多站点时是 `(site:a OR site:b)`），
    // 截得太短会把限定词切掉，反而搜出一堆站外结果。
    .slice(0, 200);
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bing 搜索（解析 b_algo 结果块）。searchUrl 可在配置中替换（测试/换引擎）。 */
export async function bingSearch(query, { signal = null } = {}) {
  throwIfAborted(signal);
  const cfg = getConfig().webSearch ?? {};
  const searchUrl = String(cfg.searchUrl || 'https://cn.bing.com/search');
  const maxResults = Math.max(1, Math.min(10, Number(cfg.maxResults) || 6));
  const url = new URL(searchUrl);
  url.searchParams.set('q', query);
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: composeAbortSignal(15000, signal)
  });
  if (!res.ok) throw new Error(`搜索服务 HTTP ${res.status}`);
  const html = await res.text();
  const results = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= maxResults) break;
  }
  return { query, results };
}

/**
 * 维基百科搜索（web_search 默认引擎）。
 * 走 MediaWiki list=search + extracts，无需 key。
 */
export async function wikipediaSearch(query, { signal = null } = {}) {
  // S10：wiki 内部网络未接 signal（非默认搜索通道，provider 'wikipedia' 现映射到 Bing），
  // 这里只做入口/出口取消检查；默认路径不受影响。
  throwIfAborted(signal);
  const { wikiLookup } = await import('./wiki.js');
  const cfg = getConfig().webSearch ?? {};
  const limit = Math.max(1, Math.min(8, Number(cfg.maxResults) || 6));
  const r = await wikiLookup(query, {
    limit,
    introChars: 360,
    source: cfg.wiki?.wikiSearchSource || cfg.wiki?.default || ''
  });
  throwIfAborted(signal);
  if (!r.ok) throw new Error(r.error || '维基搜索失败');
  const results = (r.results || []).map((x) => ({
    title: x.title,
    url: x.url,
    snippet: x.extract || x.snippet || ''
  }));
  return { query, results, provider: 'wikipedia', label: r.label };
}

/** 搜图：URL → 同一内容指纹（丢掉缓存参数/CDN 会话串，避免"看起来不同其实同一张"）。 */
function imageUrlFingerprint(rawUrl) {
  const s = String(rawUrl || '');
  try {
    const u = new URL(s);
    // 百度 /it/u=xxx 的 u 参数才是原图标识
    const uParam = u.searchParams.get('u');
    if (uParam) return `baidu:${uParam}`;
    // Bing /th?id=OIP.xxx：OIP id 唯一
    const th = u.searchParams.get('id') || u.searchParams.get('rkey') || '';
    if (/^oip\./i.test(th)) return `bing:${th.toLowerCase()}`;
    u.search = '';
    u.hash = '';
    return `${u.hostname}${u.pathname}`.toLowerCase();
  } catch {
    return s.split(/[?#]/)[0].toLowerCase().slice(0, 160);
  }
}

/** 从人话查询里抠出给相关度打分用的关键词（含中文二元组）。 */
function imageQueryKeywords(query) {
  const raw = String(query || '').trim();
  if (!raw) return [];
  const words = raw
    .replace(/(发张|发个|来一张|来张|来点|给我|帮我|一张|一张图|图片|的图|搜下|搜一下|找一下|看看|来个|张图)/g, ' ')
    .split(/[\s,，、|]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 1);
  const compact = raw.replace(/\s+/g, '');
  const grams = [];
  if (compact.length >= 2 && compact.length <= 16) {
    for (let i = 0; i < compact.length - 1; i++) grams.push(compact.slice(i, i + 2));
  }
  return [...new Set([...words, ...grams])].slice(0, 24);
}

/** 标题/来源相关度 + 垃圾过滤。 */
function scoreImageCandidate(img, keywords, { wantGif = false } = {}) {
  const title = String(img.title || '').toLowerCase();
  const src = String(img.source || '').toLowerCase();
  let score = 0;
  for (const w of keywords) {
    if (!w) continue;
    if (title.includes(w.toLowerCase())) score += 4 + Math.min(3, w.length);
    else if (src.includes(w.toLowerCase())) score += 1;
  }
  if (title.length >= 4 && title.length <= 48) score += 2;
  if (title.length > 90) score -= 1;
  if (/(下载|官网|首页|广告|推广|淘宝|京东|拼多多|优惠券|正品|厂家|批发|加盟)/.test(title)) score -= 6;
  if (/(占位|placeholder|1x1|pixel|spacer)/i.test(src + title)) score -= 8;
  const w = Number(img.width) || 0;
  const h = Number(img.height) || 0;
  if (w >= 1200 || h >= 1200) score += 2;
  else if (w >= 640 || h >= 640) score += 1;
  if (w > 0 && w < 200 && h > 0 && h < 200) score -= 4;
  if (wantGif && /gif/i.test(String(img.url || ''))) score += 2;
  return score;
}

/** 清洗人话式图片查询，去掉口语动作词。 */
export function cleanImageQuery(query) {
  return sanitizeQuery(query)
    .replace(/(发一张|发一张图|发张|发个|发点|来一张|来张|来点|来个|给我|帮我|看看|一下|一张图|图片|的图|搜下|搜一下|找一下|找找|看看有没有)/g, ' ')
    .replace(/[，。！？、,.!?；;：:~～]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    || String(query || '').slice(0, 80);
}

/**
 * 相关度排序 + 去重 + 按站点/标题穿插，避免"永远前几张、来回同一张"。
 * excludeUrls：本轮已预览/已发送的 URL（及指纹），直接剔除。
 */
export function rankImageCandidates(candidates, query, { limit = 8, excludeUrls = [] } = {}) {
  const max = Math.max(1, Math.min(20, Number(limit) || 8));
  const keywords = imageQueryKeywords(query);
  const wantGif = /gif|动图|表情包/i.test(String(query || ''));
  const exclude = new Set((excludeUrls || []).flatMap((u) => {
    const s = String(u || '');
    return s ? [s, imageUrlFingerprint(s)] : [];
  }));

  const scored = [];
  const seenUrl = new Set();
  const seenFp = new Set();
  const titleCount = new Map();
  for (const raw of candidates || []) {
    const url = String(raw?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const fp = imageUrlFingerprint(url);
    if (seenUrl.has(url) || seenFp.has(fp)) continue;
    if (exclude.has(url) || exclude.has(fp)) continue;
    // 同一标题最多留 2 张，砍掉“换 URL 不换内容”
    const tKey = String(raw?.title || fp).toLowerCase().replace(/[\s\p{P}]/gu, '').slice(0, 36) || fp;
    const tN = (titleCount.get(tKey) || 0) + 1;
    if (tN > 2) continue;
    titleCount.set(tKey, tN);
    seenUrl.add(url);
    seenFp.add(fp);
    scored.push({
      ...raw,
      url,
      title: String(raw.title || '').slice(0, 60),
      source: String(raw.source || ''),
      score: scoreImageCandidate(raw, keywords, { wantGif })
    });
  }
  scored.sort((a, b) => (b.score - a.score) || (String(b.title).length - String(a.title).length));

  // 同分带内轻微按来源穿插：别让同一个站的“第一屏”霸榜
  const top = scored.slice(0, Math.max(max * 3, max));
  const byHost = new Map();
  for (const im of top) {
    let host = '';
    try { host = new URL(im.url).hostname; } catch { host = im.source || 'unknown'; }
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(im);
  }
  const cols = [...byHost.values()];
  const picked = [];
  while (picked.length < max && cols.some((c) => c.length)) {
    for (const col of cols) {
      if (picked.length >= max) break;
      const next = col.shift();
      if (next) picked.push(next);
    }
  }
  return picked.map((im, i) => ({
    index: i + 1,
    score: im.score,
    url: im.url,
    thumb: String(im.thumb || ''),
    title: im.title,
    source: im.source,
    width: Number(im.width) || 0,
    height: Number(im.height) || 0
  }));
}

/**
 * Bing 图片搜索：拿"能直接发的图片直链"（给 send_image 用）。
 *
 * 为什么要单独一条：原来的路子是 web_search → 挑网页 → web_fetch → 从返回的
 * images 里挑直链，三步，小模型基本不会走；群里让它"发张图"，它只会说"我没图"。
 *
 * Bing 图片页把每条结果塞在 <a class="iusc" m="{...}"> 的 m 属性里（HTML 转义过的 JSON），
 * 里面有 murl（原图直链）、turl（缩略图）、t（标题）、purl（来源页）。
 */
export async function bingImageSearch(query, { limit = 8, signal = null } = {}) {
  throwIfAborted(signal);
  const cfg = getConfig().webSearch ?? {};
  const url = new URL(String(cfg.imageSearchUrl || 'https://cn.bing.com/images/search'));
  url.searchParams.set('q', query);
  url.searchParams.set('form', 'HDRSC2');
  url.searchParams.set('first', '1');
  url.searchParams.set('count', '35');
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: composeAbortSignal(15000, signal)
  });
  if (!res.ok) throw new Error(`图片搜索 HTTP ${res.status}`);
  const html = await res.text();
  const max = Math.max(1, Math.min(12, Number(limit) || 8));
  const candidates = [];
  const seen = new Set();
  const pushImage = (imageUrl, meta = {}) => {
    if (!/^https?:\/\//i.test(imageUrl) || seen.has(imageUrl)) return false;
    // 直链更有意义；Bing OIP/TH 缩略图有时也带扩展名
    if (!/\.(jpe?g|png|gif|webp|bmp|avif)(\?|$)/i.test(imageUrl) && !/[?&](format|s)=/i.test(imageUrl)) return false;
    seen.add(imageUrl);
    const host = meta.source || (() => { try { return new URL(imageUrl).hostname; } catch { return ''; } })();
    candidates.push({
      url: imageUrl,
      thumb: String(meta.thumb || ''),
      title: String(meta.title || '').slice(0, 60),
      source: host,
      width: Number(meta.width) || 0,
      height: Number(meta.height) || 0
    });
    return candidates.length >= 50;
  };

  // 主解析：结果都在 <a class="iusc" ... m="{...}"> 的锚点里。
  // ⚠️ 不能要求 class 后面紧跟 m= —— Bing 的锚点中间还有 h="ID=…" 等属性，
  //    早先写成 class="iusc"\s+m=" 时大部分结果都漏掉了，兜底又捞到页面里的杂物。
  for (const tag of html.matchAll(/<a\b[^>]*class="[^"]*\biusc\b[^"]*"[^>]*>/g)) {
    const attr = tag[0].match(/\bm="([^"]+)"/);
    if (!attr) continue;
    let meta;
    try {
      meta = JSON.parse(decodeHtml(attr[1]));
    } catch {
      continue;
    }
    pushImage(String(meta?.murl || '').trim(), {
      thumb: meta?.turl,
      title: meta?.t,
      width: meta?.mw,
      height: meta?.mh,
      source: (() => { try { return new URL(String(meta?.purl || '')).hostname; } catch { return ''; } })()
    });
    if (candidates.length >= 50) break;
  }
  // 兜底：结构变了/移动版页面时，从页内 JSON 里再捞一遍（只收图片直链，避免杂物）
  if (!candidates.length) {
    const raw = html.replace(/&quot;/g, '"').replace(/&#x3a;/gi, ':').replace(/&amp;/g, '&');
    for (const m of raw.matchAll(/"murl"\s*:\s*"(https?:\/\/[^"]+)"/g)) {
      const around = raw.slice(Math.max(0, m.index - 400), m.index + 400);
      const titleMatch = around.match(/"t"\s*:\s*"([^"]{2,60})"/);
      pushImage(m[1], { title: titleMatch ? titleMatch[1] : '' });
      if (candidates.length >= 50) break;
    }
  }
  // 内部多排一点，方便调用方在排除已发图后仍能补位
  const images = rankImageCandidates(candidates, query, { limit: Math.max(max, Math.min(40, max * 4)) });
  return { query, images };
}

/**
 * 百度图片搜索（返回 JSON，比解析 HTML 稳得多）。
 *
 * 为什么百度优先（实测 2026-09-10）：
 *   - Bing 图片是"看词给页"：樱羽艾玛 / 摸鱼表情包 这类词正常，但"博丽灵梦 插画"只给 5 个
 *     锚点且结果完全不相干（权限卡 / SCP 基金会），"千问 Q版 插画"给回沙滩图 —— 检索质量不稳。
 *   - 百度 acjson 是纯 JSON，字段固定（thumbURL / middleURL / fromPageTitleEnc / fromURLHost），
 *     中文与二次元词条相关度好，且图挂在 img*.baidu.com 自家 CDN 上，不怕防盗链。
 *   - 搜狗 napi 直接返回 {"status":1,"info":"forbid"}（无 cookie 被拒），不做兜底。
 */
export async function baiduImageSearch(query, { limit = 8, signal = null } = {}) {
  throwIfAborted(signal);
  const cfg = getConfig().webSearch ?? {};
  const url = new URL(String(cfg.imageSearchUrlBaidu || 'https://image.baidu.com/search/acjson'));
  url.searchParams.set('tn', 'resultjson_com');
  url.searchParams.set('ipn', 'rj');
  url.searchParams.set('word', query);
  url.searchParams.set('pn', '0');
  // 多要候选再本地打分：只吃前 N 条时重复图/广告占比很高
  url.searchParams.set('rn', String(Math.max(30, Math.min(60, (Number(limit) || 8) * 6))));
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      referer: 'https://image.baidu.com/',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: composeAbortSignal(15000, signal)
  });
  if (!res.ok) throw new Error(`百度图片 HTTP ${res.status}`);
  const data = await res.json().catch(() => null);
  const list = Array.isArray(data?.data) ? data.data.filter((x) => x && x !== null) : [];
  const max = Math.max(1, Math.min(12, Number(limit) || 8));
  const candidates = [];
  for (const it of list) {
    // 优先 hover / middle（比 thumb 清晰）；都挂 baidu CDN，防盗链友好
    const imageUrl = String(it?.hoverURL || it?.middleURL || it?.replaceURL || it?.thumbURL || '').trim();
    if (!/^https?:\/\//i.test(imageUrl)) continue;
    if (!/\.(jpe?g|png|gif|webp|bmp|avif)(\?|$)/i.test(imageUrl) && !/baidu\.com\/(it|pic)\//i.test(imageUrl)) continue;
    candidates.push({
      url: imageUrl,
      thumb: String(it?.thumbURL || ''),
      title: String(it?.fromPageTitleEnc || it?.hoverTitle || it?.fromPageTitle || '').slice(0, 60),
      source: String(it?.fromURLHost || '') || (() => { try { return new URL(imageUrl).hostname; } catch { return ''; } })(),
      width: Number(it?.width) || 0,
      height: Number(it?.height) || 0
    });
    if (candidates.length >= 50) break;
  }
  const images = rankImageCandidates(candidates, query, { limit: Math.max(max, Math.min(40, max * 4)) });
  return { query, images, provider: 'baidu' };
}

/** 搜图统一入口：百度优先，Bing 兜底（5 分钟缓存，避免模型换着词反复搜把源打爆）。 */
const imageSearchCache = new Map();
export async function searchImages(query, { limit = 8, excludeUrls = [], signal = null } = {}) {
  throwIfAborted(signal);
  const q = cleanImageQuery(query) || String(query || '').trim();
  const max = Math.max(1, Math.min(12, Number(limit) || 8));
  const key = `${q}|${max}`;
  const hit = imageSearchCache.get(key);
  const exclude = (excludeUrls || []).map(String).filter(Boolean);

  // 有排除集时不能吃最终列表缓存：同一词第二次要吐出没发过的图
  if (hit && !exclude.length && Date.now() - hit.at < 5 * 60 * 1000) {
    return { ...hit.result, cached: true };
  }

  // 源级缓存：原始候选 5 分钟内复用，再本地做 exclude + 终排
  const rawKey = `raw|${q}`;
  const rawHit = imageSearchCache.get(rawKey);
  let raw = null;
  if (rawHit && Date.now() - rawHit.at < 5 * 60 * 1000) {
    raw = rawHit.result;
  } else {
    try {
      const r = await baiduImageSearch(q, { limit: max, signal });
      if (r.images.length) raw = { ...r, cleanedQuery: q };
    } catch (error) {
      if (signal?.aborted) throw abortError(error);
      console.warn('[image-search] 百度搜图失败：' + (error?.message ?? error));
    }
    if (!raw?.images?.length) {
      try {
        const r = await bingImageSearch(q, { limit: max, signal });
        raw = { ...r, provider: 'bing', cleanedQuery: q };
      } catch (error) {
        if (signal?.aborted) throw abortError(error);
        console.warn('[image-search] Bing 搜图也失败：' + (error?.message ?? error));
      }
    }
    if (raw?.images?.length) {
      if (imageSearchCache.size > 400) imageSearchCache.clear();
      imageSearchCache.set(rawKey, { at: Date.now(), result: raw });
    }
  }

  if (!raw?.images?.length) {
    return { query, cleanedQuery: q, images: [], provider: '' };
  }
  const images = rankImageCandidates(raw.images, q, { limit: max, excludeUrls: exclude });
  const result = {
    query,
    cleanedQuery: q,
    images,
    provider: raw.provider || '',
    excluded: exclude.length ? Math.max(0, (raw.images || []).length - images.length) : 0
  };
  if (!exclude.length && images.length) {
    imageSearchCache.set(key, { at: Date.now(), result });
  }
  return result;
}

/**
 * 把"人话式查询"压成关键词。
 *
 * 弱模型容易把整句塞进查询，需要在提示/后处理里约束查询长度。
 *   `今天AI新闻 今日人工智能资讯 2026年9月11日`
 * Bing 看到"今天 + 具体日期"直接切成**日期意图**，返回的是日历网/今日黄历，
 * 模型只好如实回"没搜到"（它没撒谎，是真搜到一屏日历）。
 * 剥掉时间词、日期、搜索动词之后重搜一次，基本就能拿到真正的内容。
 */
export function simplifyQuery(query) {
  return String(query ?? '')
    .replace(/\d{4}\s*[年/-]\s*\d{1,2}\s*[月/-]\s*\d{1,2}\s*日?/g, ' ')   // 2026年9月11日 / 2026-09-11
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*日/g, ' ')                          // 9月11日
    .replace(/\d{4}\s*年(\s*\d{1,2}\s*月)?/g, ' ')                          // 2026年 / 2026年9月
    .replace(/(今天|今日|昨天|明天|当天|最新|最近|近期|现在|刚刚|目前|本次)/g, ' ')
    .replace(/(搜一下|搜搜|搜索|帮我搜|查一下|查查|找一下|看看|来条|来点)/g, ' ')
    .replace(/[，。！？、,.!?；;：:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 明显不是内容站的"日期/黄历/万年历"结果（只在查询还剩关键词时才用来过滤）。 */
const JUNK_RESULT_RE = /(rili\.com|huangli|tianqi|wannianli|calendar|黄历|万年历|日历网)/i;

/**
 * 从正文里挑"和查询相关"的片段（不是简单取前 N 字）。
 *
 * 背景：web_search 的说明让模型"对最相关的 1~2 个结果用 web_fetch 读正文"，
 * 但弱模型子集工具里可能**没有** web_fetch（只有少量工具），
 * 于是它永远只看摘要 —— 能用的知识被砍掉一半。现在改由搜索工具自己补读。
 */
function pickRelevantExcerpt(text, keywords, maxChars = 900) {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!body) return '';
  if (body.length <= maxChars) return body;
  const parts = body.split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter((s) => s.length >= 8);
  if (!parts.length) return body.slice(0, maxChars);
  const scored = parts.map((p, i) => {
    let score = 0;
    for (const w of keywords) if (w && p.includes(w)) score += Math.min(3, String(w).length);
    return { p, i, score };
  });
  const hits = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);
  const picked = [];
  let used = 0;
  for (const s of hits) {
    if (used + s.p.length > maxChars) continue;
    picked.push(s);
    used += s.p.length;
    if (picked.length >= 4) break;
  }
  if (!picked.length) return body.slice(0, maxChars);
  return picked.sort((a, b) => a.i - b.i).map((s) => s.p).join('');
}

/** 给前几条结果补读正文；单页失败/超时就保留摘要，绝不让搜索整体失败。 */
export async function attachPageContents(results, { max = 2, chars = 900, keywords = [], signal = null } = {}) {
  throwIfAborted(signal);
  const picks = (Array.isArray(results) ? results : []).slice(0, Math.max(0, max));
  if (!picks.length) return results;
  // 自建站点（局域网 wiki 等）需要 security.allowPrivateFetchHosts=true 才放行，和 web_fetch 一致
  const allowPrivate = getConfig().security?.allowPrivateFetchHosts === true;
  await Promise.all(picks.map(async (r) => {
    try {
      if (!r?.url || JUNK_RESULT_RE.test(String(r.url))) return;
      const { body } = await safeFetch(String(r.url), { browseLocked: true, allowPrivate, signal });
      if (!body) return;
      const digest = extractPageDigest(body, String(r.url), { maxChars: 12000 });
      const text = String(digest?.text || '').trim();
      if (!text || text.length < 40) return;
      const excerpt = pickRelevantExcerpt(text, keywords, chars);
      if (excerpt) r.content = excerpt;
    } catch (error) {
      // 单页失败就保留摘要——但取消不是"单页失败"，不许吞
      if (signal?.aborted) throw abortError(error);
    }
  }));
  return results;
}

/**
 * 新闻 RSS 通道。
 *
 * 为什么单独做一条：实测（09-11 13:26/13:34）"来条今日 AI 新闻""任天堂新游戏发售新闻"，
 * Bing **网页**搜索返回的是官网首页、百度百科、AI 工具导航 —— 压根不是新闻，
 * 模型只好如实回"没搜到"；而 Bing 新闻频道抓不到（返回备案页，需要 cookie）。
 * RSS 是唯一**免费、无需 key、稳定**的路子：实测 IT之家 60 条、少数派 10 条、人民网 100 条
 * 都能直接拿到真标题 + 链接 + 摘要。
 *
 * 只在"新闻类查询"上启用；命中关键词就排在网页结果前面（真头条 > 官网首页）。
 */
const DEFAULT_NEWS_FEEDS = [
  { name: 'IT之家', url: 'https://www.ithome.com/rss/' },
  { name: '少数派', url: 'https://sspai.com/feed' },
  { name: '人民网科技', url: 'http://www.people.com.cn/rss/scitech.xml' }
];

const NEWS_QUERY_RE = /(新闻|资讯|头条|时事|热点|动态|发生了什么|有什么新)/;

let newsCache = { at: 0, items: [], key: '' };

function stripTags(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 抓一组 RSS 头条（5 分钟缓存；任一条失败不影响其它条）。 */
export async function fetchNewsItems({ signal = null } = {}) {
  throwIfAborted(signal);
  const ttl = 5 * 60 * 1000;
  const feeds = Array.isArray(getConfig().webSearch?.newsFeeds) && getConfig().webSearch.newsFeeds.length
    ? getConfig().webSearch.newsFeeds
    : DEFAULT_NEWS_FEEDS;
  // 缓存按 feed 列表区分（换源/测试时不会拿错上一份）
  const key = feeds.map((f) => String(f.url)).join('|');
  if (newsCache.items.length && newsCache.key === key && Date.now() - newsCache.at < ttl) return newsCache.items;
  const out = [];
  await Promise.all(feeds.map(async (feed) => {
    try {
      const res = await fetch(String(feed.url), {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          accept: 'application/rss+xml,application/xml,text/xml,*/*'
        },
        signal: composeAbortSignal(12000, signal)
      });
      if (!res.ok) return;
      const xml = await res.text();
      for (const m of xml.matchAll(/<item[\s\S]*?<\/item>/g)) {
        const block = m[0];
        const pick = (tag) => {
          const mm = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
          return mm ? stripTags(mm[1]) : '';
        };
        const title = pick('title');
        const url = pick('link') || (block.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? '');
        if (!title || !url) continue;
        const when = Date.parse(pick('pubDate') || pick('published') || '') || 0;
        out.push({ title, url, snippet: pick('description').slice(0, 160), source: feed.name, ts: when });
      }
    } catch (error) {
      // 单条 feed 失败就跳过——但取消不是"单条失败"，不许吞
      if (signal?.aborted) throw abortError(error);
    }
  }));
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (out.length) newsCache = { at: Date.now(), items: out, key };
  return newsCache.items;
}

export function isNewsQuery(query) {
  return NEWS_QUERY_RE.test(String(query ?? ''));
}

/** 新闻查询里的"实词"：拉丁词原样，中文切成二元组（不做分词也能匹配"任天堂/发售"这类）。 */
const STOP_WORD_RE = /^(新闻|资讯|头条|时事|热点|动态|最新|今日|今天|昨天|最近|消息|一下|什么|有什么|有没有|来条|来点|的|了)$/;
export function queryKeywords(query) {
  const base = simplifyQuery(query);
  const latin = [...new Set([...base.matchAll(/[A-Za-z0-9][A-Za-z0-9.+#-]{1,}/g)].map((m) => m[0]))];
  const bigrams = new Set();
  for (const chunk of base.replace(/[A-Za-z0-9.+#-]+/g, ' ').split(/\s+/)) {
    const s = chunk.replace(/[^\u4e00-\u9fff]/g, '');
    if (!s || STOP_WORD_RE.test(s)) continue;
    if (s.length <= 2) { bigrams.add(s); continue; }
    for (let i = 0; i + 2 <= s.length; i += 1) {
      const g = s.slice(i, i + 2);
      if (!STOP_WORD_RE.test(g)) bigrams.add(g);
    }
  }
  return { latin, bigrams: [...bigrams] };
}

/**
 * 走当前聊天模型的「原生联网搜索」（Qwen/DashScope enable_search 等）。
 * 复用 api.baseUrl / apiKey，不另开 Key；失败时由调用方退回 Bing。
 */
export async function modelNativeSearch(query, { signal = null } = {}) {
  throwIfAborted(signal);
  const api = getConfig().api ?? {};
  const ws = getConfig().webSearch ?? {};
  const nat = ws.native ?? {};
  const baseUrl = String(api.baseUrl || '').replace(/\/+$/, '');
  const apiKey = String(api.apiKey || nat.apiKey || '').trim();
  if (!baseUrl || !apiKey) throw new Error('原生搜索需要主聊天模型的 baseUrl + apiKey');
  // 搜索专用：默认更轻的模型；留空跟聊天模型
  const model = String(nat.model || api.model || 'qwen-flash').trim();
  const timeout = Math.max(8000, Number(nat.timeoutMs) || 20000);
  const maxTokens = Math.max(120, Number(nat.maxTokens) || 400);

  const body = {
    model,
    messages: [{
      role: 'user',
      content: `联网搜索「${query}」。用中文只给 3~5 条关键事实（每条一行，不要过程/不要客套）。搜不到就回「没搜到」。`
    }],
    enable_search: true,
    search_options: {
      forced_search: true,
      // ⚠️ 百炼只认 standard/pro_ultra/pro/lite/pro_max/turbo/max；
      // 曾配成 'fast' 导致 HTTP 400（InternalError.Algo.InvalidParameter），原生搜索直接不可用。
      search_strategy: (() => {
        const allowed = ['standard', 'pro_ultra', 'pro', 'lite', 'pro_max', 'turbo', 'max'];
        const s = String(nat.strategy || 'standard').trim().toLowerCase();
        return allowed.includes(s) ? s : 'standard';
      })()
    },
    temperature: 0.2,
    max_tokens: maxTokens,
    // 搜索是工具调用，不要烧思考时间
    enable_thinking: false,
    disable_thinking: true
  };

  const t0 = Date.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal: composeAbortSignal(timeout, signal)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`原生搜索 HTTP ${res.status}：${text.slice(0, 240)}`);
  }
  const data = await res.json().catch(() => { throw new Error('原生搜索返回了无法解析的 JSON'); });
  const msg = data?.choices?.[0]?.message;
  const content = String(
    msg?.content
    ?? data?.output_text
    ?? ''
  ).trim();
  // 有的网关把引用塞在 message.annotations / web_search_results
  const refs = [];
  const ann = Array.isArray(msg?.annotations) ? msg.annotations : [];
  for (const a of ann) {
    const u = String(a?.url || a?.url_citation?.url || '').trim();
    const t = String(a?.title || a?.url_citation?.title || '').trim();
    if (u || t) refs.push({ title: t || u, url: u, snippet: '' });
  }
  if (!content && !refs.length) throw new Error('原生搜索没有返回内容（模型可能不支持 enable_search）');
  const ms = Date.now() - t0;
  const results = refs.length
    ? refs.slice(0, 4)
    : [{ title: '模型联网搜索', url: '', snippet: content.slice(0, 600) }];
  if (refs.length && content) {
    results[0].snippet = content.slice(0, 600);
  }
  console.log(`[web-search] native ${model} ${ms}ms hits=${results.length} "${query.slice(0, 40)}"`);
  return { query, results, provider: 'native', label: `原生·${model}`, tookMs: ms };
}

function runSearchProvider(clean, { signal = null } = {}) {
  const cfg = getConfig().webSearch ?? {};
  const provider = String(cfg.provider || 'native').toLowerCase();
  if (provider === 'native' || provider === 'model' || provider === 'enable_search') {
    return modelNativeSearch(clean, { signal });
  }
  if (provider === 'deepseek') return deepSeekSearch(clean, { signal });
  if (provider === 'zhipu') return zhipuSearch(clean, { signal });
  if (provider === 'bocha') return bochaSearch(clean, { signal });
  if (provider === 'baidu') return baiduSearch(clean, { signal });
  if (provider === 'metaso') return metasoSearch(clean, { signal });
  // wikipedia / wiki 已废弃：避免和旧配置打架，直接当 Bing
  if (provider === 'wikipedia' || provider === 'wiki') return bingSearch(clean, { signal });
  // 自定义：'custom'（旧单槽位）或 'custom:<id>'（设置页添加的多个之一）
  if (provider === 'custom' || provider.startsWith('custom:')) {
    return customSearch(clean, provider, { signal });
  }
  return bingSearch(clean, { signal });
}

/** 给工具用的统一入口：搜索 + 紧凑序列化。 */
export async function webSearch(query, { signal = null } = {}) {
  throwIfAborted(signal);
  const clean = sanitizeQuery(query);
  if (!clean) throw new Error('查询词为空');
  let first;
  try {
    first = await runSearchProvider(clean, { signal });
  } catch (e) {
    // 取消不是"原生搜索不支持"——不许被降级吞掉
    if (signal?.aborted) throw abortError(e);
    // 原生搜索失败（网关不支持 enable_search 等）→ 退回 Bing，别让聊天瞎掉
    const p = String(getConfig().webSearch?.provider || '').toLowerCase();
    if (p === 'native' || p === 'model' || p === 'enable_search') {
      console.warn(`[web-search] 原生搜索失败，退回 Bing: ${e?.message ?? e}`);
      first = await bingSearch(clean, { signal });
    } else {
      throw e;
    }
  }

  // ① 新闻类查询：先把 RSS 真头条垫在前面（网页搜索只会给官网/百科）
  let newsItems = [];
  if (isNewsQuery(clean)) {
    try {
      const items = await fetchNewsItems({ signal });
      const kws = queryKeywords(clean);
      const hasKw = kws.latin.length || kws.bigrams.length;
      let hits;
      if (!hasKw) {
        hits = items;                                     // 纯"今天有什么新闻" → 直接给头条
      } else {
        const need = kws.bigrams.length <= 2 ? 1 : 2;      // 短查询放宽到 1 个二元组
        hits = items.filter((it) => {
          const hay = `${it.title} ${it.snippet}`.toLowerCase();
          if (kws.latin.some((w) => hay.includes(w.toLowerCase()))) return true;
          return kws.bigrams.filter((b) => hay.includes(b)).length >= need;
        });
      }
      newsItems = hits.slice(0, 5).map((it) => ({
        title: it.title,
        url: it.url,
        snippet: `${it.snippet}（${it.source}）`
      }));
    } catch (error) {
      if (signal?.aborted) throw abortError(error); /* RSS 挂了就退回网页结果 */
    }
  }

  // ② 查询里塞了时间词/日期 → 补一次净化检索（Bing 类才做；原生一次就够，别二次烧模型）。
  const simple = simplifyQuery(clean);
  const keywordish = simple.replace(/\s+/g, '').length >= 2;
  let webResults = first.results || [];
  let retriedNote = '';
  const isNative = String(getConfig().webSearch?.provider || '').toLowerCase() === 'native';
  if (simple && simple !== clean && keywordish && !isNative) {
    try {
      const second = await runSearchProvider(simple, { signal });
      const seen = new Set();
      const merged = [...(second.results || []), ...(first.results || [])]
        .filter((r) => {
          const key = String(r?.url || r?.title || '');
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        // 查询里还有实际关键词时，把"日历/黄历"这类明显跑偏的结果踢掉
        .filter((r) => !JUNK_RESULT_RE.test(`${r?.url || ''} ${r?.title || ''}`));
      if (merged.length) {
        webResults = merged;
        retriedNote = `（原查询被搜索引擎当成日期查询，已用"${simple}"重搜）`;
      }
    } catch (error) {
      if (signal?.aborted) throw abortError(error); /* 补搜失败就退回第一次的结果 */
    }
  }

  // ③ 补读正文：给前 1~2 条结果抓回"和问题相关的片段"。
  //    子集工具没有 web_fetch 时，只给标题+摘要等于让模型瘸着腿回答。
  let results = webResults;
  if (newsItems.length) {
    const seen = new Set(newsItems.map((x) => x.url));
    results = [...newsItems, ...webResults.filter((r) => !seen.has(String(r?.url || '')))];
  }
  // ③ 补读正文：只给 Bing/自定义结果补读；原生已有正文则跳过（再抓会拖很久）
  const autoRead = Number(getConfig().webSearch?.autoReadPages ?? (isNative ? 0 : 1));
  if (autoRead > 0 && results.length && !isNative) {
    try {
      results = await attachPageContents(results, {
        max: Math.min(2, autoRead),
        chars: Math.max(200, Number(getConfig().webSearch?.autoReadChars) || 600),
        keywords: queryKeywords(clean).bigrams.concat(queryKeywords(clean).latin),
        signal
      });
    } catch (error) {
      if (signal?.aborted) throw abortError(error); /* 补读失败就用摘要 */
    }
  }
  return {
    ...first,
    query: clean,
    results,
    ...(newsItems.length ? { newsFromRss: newsItems.length } : {}),
    retriedNote
  };
}

/**
 * DeepSeek 服务端原生搜索（Responses API，web_search 工具）。
 * 文档：https://api-docs.deepseek.com/zh-cn/guides/responses_api
 * 说明：搜索在 DeepSeek 服务端完成并注入上下文，客户端能拿到的是模型基于
 * 搜索结果生成的最终回答；URL/标题/摘要为黑盒，拿不到结构化来源。适合
 * “只要能搜到并总结”的场景；需要引用列表时请用 Bing / 其他搜索 API。
 */
export async function deepSeekSearch(query, { signal = null } = {}) {
  throwIfAborted(signal);
  const cfg = getConfig().webSearch?.deepseek ?? {};
  const apiKey = String(cfg.apiKey || process.env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey) throw new Error('DeepSeek 搜索需要 API Key（设置里填，或环境变量 DEEPSEEK_API_KEY）');
  const baseUrl = String(cfg.baseUrl || 'https://api.deepseek.com/responses').replace(/\/+$/, '');
  const model = String(cfg.model || 'deepseek-v4-flash');

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: `请联网搜索并回答（用中文，简洁、只给结论和关键信息）：${query}`,
      tools: [{ type: 'web_search' }],
      stream: false
    }),
    signal: composeAbortSignal(Math.max(10000, Number(cfg.timeoutMs) || 60000), signal)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DeepSeek 搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => { throw new Error('DeepSeek 搜索返回了无法解析的 JSON'); });
  const outputText = String(data?.output_text ?? '').trim();
  if (!outputText) {
    // 兼容不同字段位置
    const alt = data?.output?.find?.((item) => item?.type === 'message' && item?.content?.length)
      ?.content?.map((c) => c?.text ?? '').join('') ?? '';
    if (!alt) throw new Error('DeepSeek 搜索没有返回文本（可能是模型不支持 web_search 工具）');
    return { query, results: [{ title: 'DeepSeek 搜索', url: '', snippet: alt }] };
  }
  return { query, results: [{ title: 'DeepSeek 搜索', url: '', snippet: outputText }] };
}

/** 站内搜索模板里认识的占位符写法（用户手滑写错也能兜住）。 */
const QUERY_PLACEHOLDERS = ['{query}', '{q}', '{keyword}', '{kw}', '{word}', '{search}', '{text}', '{关键词}', '{搜索词}', '%s'];

/**
 * 把"站内搜索地址模板 + 关键词"拼成真正要抓的 URL。
 *
 * 三种情况：
 *   1. 模板里有认识的占位符（{query} 等）→ 直接替换；
 *   2. 模板里没有占位符，但查询参数的值"看起来就是占位符"（例如手滑写成 ?s={quert}）
 *      → 把那个参数的值换成关键词（真实案例：用户把 {query} 打成 {quert}，
 *        结果搜索 URL 里带着字面量 {quert}，站点永远返回空结果，模型只好到处乱翻）；
 *   3. 模板就是个裸地址（没有查询串）→ 补一个 ?s=关键词。
 */
export function buildSiteSearchUrl(template, query) {
  const raw = String(template ?? '').trim();
  if (!raw) return '';
  const q = String(query ?? '');
  for (const p of QUERY_PLACEHOLDERS) {
    if (raw.includes(p)) return raw.split(p).join(encodeURIComponent(q));
  }
  try {
    const u = new URL(raw);
    let filled = false;
    for (const [k, v] of [...u.searchParams.entries()]) {
      if (!v || /^\{.*\}$/.test(v) || /^\$\{.*\}$/.test(v) || /^%[^%]+%$/.test(v)) {
        u.searchParams.set(k, q);
        filled = true;
      }
    }
    if (filled) return u.toString();
    if (!u.search) {
      u.searchParams.set('s', q);
      return u.toString();
    }
    return u.toString();
  } catch { /* 不是完整 URL，退回直接拼 */ }
  return raw + encodeURIComponent(q);
}

/**
 * 从 HTML 里抽出一份"给模型看的摘要"：正文文本 + 链接 + 图片直链。
 * 用于站内搜索（直接抓站点自己的搜索页）——比把整页 HTML 塞给模型省得多。
 */
export function extractPageDigest(html, baseUrl, { maxChars = 6000, maxLinks = 24 } = {}) {
  const raw = String(html ?? '');
  if (!raw) return { text: '', links: [], images: [] };
  // JSON 响应（站点的 API，比如 WordPress 的 /wp-json/wp/v2/posts?search=…）：
  // 直接返回格式化后的 JSON 当正文，并顺手把里头的图片直链挑出来。
  // 很多站点自己的搜索页是 JS 渲染的（HTML 里没有列表），但它的 API 反而干净好用。
  if (/^\s*[[{]/.test(raw)) {
    try {
      const parsed = JSON.parse(raw);
      const flat = JSON.stringify(parsed);
      const imgs = [...new Set((flat.match(/https?:\/\/[^"'\\\s]+\.(?:jpe?g|png|gif|webp)(?:\?[^"'\\\s]*)?/gi) || [])
        .map((u) => u.replace(/\\\//g, '/')))].slice(0, 12);
      return {
        text: JSON.stringify(parsed, null, 1).slice(0, Math.max(500, Number(maxChars) || 6000)),
        links: [],
        images: imgs.map((url) => ({ url, alt: '' }))
      };
    } catch { /* 不是合法 JSON，按 HTML 处理 */ }
  }
  const links = [];
  const seen = new Set();
  for (const m of raw.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const tag = m[0];
    const label = decodeHtml(m[1] || '');
    const href = attrOf(tag, 'href');
    if (!label || !href) continue;
    if (/^(javascript:|#|mailto:)/i.test(href)) continue;
    let abs;
    try { abs = new URL(href, baseUrl).toString(); } catch { continue; }
    if (!/^https?:\/\//i.test(abs)) continue;
    const key = abs.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ text: label.slice(0, 80), url: key });
    if (links.length >= maxLinks) break;
  }
  const images = extractImageUrls(raw, baseUrl, 12);
  // 正文：去掉脚本/样式/标签，压平空白。中文网页 1 字符 ≈ 1 token，所以这里必须限量。
  const text = decodeHtml(
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  ).slice(0, Math.max(500, Number(maxChars) || 6000));
  return { text, links, images };
}

/** 抓取网页正文（走 safe-fetch 的 SSRF 全防护；受浏览锁定限制）。 */
export async function webFetch(url, { signal = null } = {}) {
  throwIfAborted(signal);
  // 自建站点（局域网 wiki / 图床）需要 security.allowPrivateFetchHosts=true 才放行，默认关闭
  const allowPrivate = getConfig().security?.allowPrivateFetchHosts === true;
  const result = await safeFetch(url, { browseLocked: true, allowPrivate, signal });
  return result;
}

/** 取标签里的属性值（兼容双引号/单引号/无引号三种写法）。
 *  属性名前面加 (?<![\w-]) 是为了不让 src 误匹配到 data-src —— 两者含义不同。 */
function attrOf(tag, name) {
  const re = new RegExp(`(?<![\\w-])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return '';
  return String(m[1] ?? m[2] ?? m[3] ?? '').trim();
}

/** srcset 里取第一个候选（"a.jpg 1x, b.jpg 2x" → a.jpg）。 */
function firstFromSrcset(value) {
  const first = String(value || '').split(',')[0] || '';
  return first.trim().split(/\s+/)[0] || '';
}

/**
 * 从 HTML 里抽出图片直链 —— 供"从网页抓图再发送"用。
 *
 * 覆盖三类写法（网页里最常见）：
 *   1. `<meta property="og:image">` / `twitter:image`（社交分享图，通常是最合适的那张）
 *   2. `<img src>` 以及懒加载用的 `data-src` / `data-original` / `data-lazy-src`
 *   3. `<img srcset>` 的第一个候选
 *
 * 相对路径按页面 URL 补全；只保留 http(s)（丢掉 data:/blob:/javascript:）；按 URL 去重。
 * ⚠️ 只能拿到"写在 HTML 里的直链"：JS 动态渲染、CSS 背景图、需要 Referer 的防盗链都拿不到。
 */
export function extractImageUrls(html, baseUrl, max = 10) {
  const text = String(html ?? '');
  if (!text) return [];
  const limit = Math.max(1, Math.min(50, Number(max) || 10));
  const out = [];
  const seen = new Set();
  const push = (raw, alt = '') => {
    const value = String(raw || '').trim();
    if (!value || out.length >= limit) return;
    let abs;
    try { abs = new URL(value, baseUrl).toString(); } catch { return; }
    if (!/^https?:\/\//i.test(abs)) return;
    const key = abs.replace(/#.*$/, '');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url: key, alt: String(alt || '').slice(0, 60) });
  };

  // 1) og:image / twitter:image（content 属性可能在 property 前面，所以逐标签扫）
  for (const m of text.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (attrOf(tag, 'property') || attrOf(tag, 'name')).toLowerCase();
    if (key === 'og:image' || key === 'og:image:url' || key === 'twitter:image' || key === 'twitter:image:src') {
      push(attrOf(tag, 'content'));
    }
  }
  // 2) <img> 各种写法
  for (const m of text.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const alt = attrOf(tag, 'alt');
    const direct = attrOf(tag, 'src') || attrOf(tag, 'data-src') || attrOf(tag, 'data-original')
      || attrOf(tag, 'data-lazy-src') || attrOf(tag, 'data-echo');
    if (direct) push(direct, alt);
    const srcset = attrOf(tag, 'srcset') || attrOf(tag, 'data-srcset');
    if (srcset) push(firstFromSrcset(srcset), alt);
    if (out.length >= limit) break;
  }
  return out;
}

/** 智谱 Web Search API（结构化结果：标题/链接/摘要/网站名/日期）。 */
export async function zhipuSearch(query, { signal = null } = {}) {
  throwIfAborted(signal);
  const cfg = getConfig().webSearch?.zhipu ?? {};
  const apiKey = String(cfg.apiKey || process.env.ZHIPU_API_KEY || '').trim();
  if (!apiKey) throw new Error('智谱搜索需要 API Key（设置里填，或环境变量 ZHIPU_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://open.bigmodel.cn/api/paas/v4/web_search').replace(/\/+$/, '');
  const engine = String(cfg.engine || 'search_std');
  const count = Math.min(50, Math.max(1, Number(cfg.count) || 10));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ search_engine: engine, search_query: query, count }),
    signal: composeAbortSignal(Math.max(10000, Number(cfg.timeoutMs) || 20000), signal)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`智谱搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => { throw new Error('智谱搜索返回了无法解析的 JSON'); });
  const arr = Array.isArray(data?.search_result) ? data.search_result : [];
  const results = arr
    .filter((r) => r?.link || r?.url)
    .map((r) => ({
      title: String(r.title ?? r.name ?? '').trim() || '（无标题）',
      url: String(r.link ?? r.url ?? ''),
      snippet: String(r.content ?? r.summary ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('智谱搜索没有返回有效结果（检查 API Key 或搜索引擎编码）');
  return { query, results };
}

/** 博查 Web Search API（国内中文优化，网页结果在 data.webPages.value）。 */
export async function bochaSearch(query, { signal = null } = {}) {
  throwIfAborted(signal);
  const cfg = getConfig().webSearch?.bocha ?? {};
  const apiKey = String(cfg.apiKey || process.env.BOCHA_API_KEY || '').trim();
  if (!apiKey) throw new Error('博查搜索需要 API Key（设置里填，或环境变量 BOCHA_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://api.bochaai.com/v1/web-search').replace(/\/+$/, '');
  const count = Math.min(50, Math.max(1, Number(cfg.count) || 10));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ query, count, freshness: 'noLimit', summary: false }),
    signal: composeAbortSignal(Math.max(10000, Number(cfg.timeoutMs) || 20000), signal)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`博查搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => { throw new Error('博查搜索返回了无法解析的 JSON'); });
  if (data?.code && Number(data.code) !== 200) {
    throw new Error(`博查搜索 API 错误（code ${data.code}）：${data.message || data.msg || '未知'}`);
  }
  const arr = Array.isArray(data?.data?.webPages?.value) ? data.data.webPages.value : [];
  const results = arr
    .filter((r) => r?.url)
    .map((r) => ({
      title: String(r.name ?? r.title ?? '').trim() || '（无标题）',
      url: String(r.url ?? ''),
      snippet: String(r.snippet ?? r.summary ?? r.content ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('博查搜索没有返回网页结果');
  return { query, results };
}

/** 百度千帆 AI Search（web_search，返回 references）。 */
export async function baiduSearch(query, { signal = null } = {}) {
  throwIfAborted(signal);
  const cfg = getConfig().webSearch?.baidu ?? {};
  const apiKey = String(cfg.apiKey || process.env.BAIDU_SEARCH_API_KEY || '').trim();
  if (!apiKey) throw new Error('百度搜索需要 API Key（设置里填，或环境变量 BAIDU_SEARCH_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://qianfan.baidubce.com/v2/ai_search/web_search').replace(/\/+$/, '');
  const topK = Math.min(10, Math.max(1, Number(cfg.count) || 6));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: query }],
      search_source: 'baidu_search_v2',
      resource_type_filter: [{ type: 'web', top_k: topK }]
    }),
    signal: composeAbortSignal(Math.max(10000, Number(cfg.timeoutMs) || 20000), signal)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`百度搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => { throw new Error('百度搜索返回了无法解析的 JSON'); });
  if (data?.error_code && Number(data.error_code) !== 0) {
    throw new Error(`百度搜索 API 错误（code ${data.error_code}）：${data.error_msg || data.message || '未知'}`);
  }
  const arr = Array.isArray(data?.references) ? data.references : [];
  const results = arr
    .filter((r) => r?.url || r?.link)
    .map((r) => ({
      title: String(r.title ?? r.name ?? '').trim() || '（无标题）',
      url: String(r.url ?? r.link ?? ''),
      snippet: String(r.content ?? r.snippet ?? r.summary ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('百度搜索没有返回有效结果');
  return { query, results };
}

/** 秘塔 AI 搜索（metaso.cn，每天 100 次免费）。 */
export async function metasoSearch(query, { signal = null } = {}) {
  throwIfAborted(signal);
  const cfg = getConfig().webSearch?.metaso ?? {};
  const apiKey = String(cfg.apiKey || process.env.METASO_API_KEY || '').trim();
  const endpoint = String(cfg.baseUrl || 'https://metaso.cn/api/open/v1/search').replace(/\/+$/, '');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ query, top_k: Math.min(10, Math.max(1, Number(cfg.count) || 6)) }),
    signal: composeAbortSignal(Math.max(10000, Number(cfg.timeoutMs) || 20000), signal)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`秘塔搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => { throw new Error('秘塔搜索返回了无法解析的 JSON'); });
  const arr = Array.isArray(data?.results) ? data.results
    : Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.sources) ? data.sources
    : [];
  const results = arr
    .filter((r) => r?.url || r?.link)
    .map((r) => ({
      title: String(r.title ?? r.name ?? '').trim() || '（无标题）',
      url: String(r.url ?? r.link ?? ''),
      snippet: String(r.content ?? r.snippet ?? r.summary ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('秘塔搜索没有返回有效结果（可能已用完免费额度或接口地址需要更新）');
  return { query, results };
}

/**
 * 解析自定义搜索配置。
 * providerId 形如 'custom:abc123' 时从 webSearch.providers 数组里取对应项；
 * 否则退回旧的单槽位 webSearch.custom（兼容早期配置）。
 */
function resolveCustomConfig(providerId = null) {
  const ws = getConfig().webSearch ?? {};
  if (providerId && String(providerId).startsWith('custom:')) {
    const id = String(providerId).slice('custom:'.length);
    const found = (Array.isArray(ws.providers) ? ws.providers : []).find((p) => String(p?.id) === id);
    if (found) return found;
    // 列表里找不到 → 回退单槽位，避免配置丢失后完全搜不了
  }
  return ws.custom ?? {};
}

/**
 * 用户自定义的搜索服务（provider = 'custom' 或 'custom:<id>'）。
 *
 * 两种类型：
 *   - 'openai'：POST 一个 JSON 搜索接口。为兼容各家实现，会尝试多种常见请求体字段
 *     （query / q / messages）与响应结构（results / data / sources / references / webPages）。
 *     适合 SearXNG、Tavily、自建聚合搜索等。
 *   - 'bing'：GET 一个搜索页并用 b_algo 块解析（兼容 Bing 结果格式的引擎，如部分 SearXNG 实例）。
 */
export async function customSearch(query, providerId = null, { signal = null } = {}) {
  throwIfAborted(signal);
  const cfg = resolveCustomConfig(providerId);
  const type = String(cfg.type || 'openai').toLowerCase();

  if (type === 'bing') {
    return bingSearchWithUrl(query, String(cfg.baseUrl || ''), signal);
  }

  const endpoint = String(cfg.baseUrl || '').replace(/\/+$/, '');
  if (!endpoint) throw new Error('自定义搜索未配置接口地址（设置 → 模型 API → 搜索提供方 → 自定义）');
  const apiKey = String(cfg.apiKey || '').trim();
  const model = String(cfg.model || '').trim();
  const topK = Math.min(10, Math.max(1, Number(cfg.count) || 6));

  // 兼容多种请求体：优先 query / q，带 model 时额外附上 messages（Responses API 风格）
  const body = { query, q: query, top_k: topK, count: topK };
  if (model) {
    body.model = model;
    body.messages = [{ role: 'user', content: query }];
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify(body),
    signal: composeAbortSignal(Math.max(10000, Number(cfg.timeoutMs) || 20000), signal)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`自定义搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => { throw new Error('自定义搜索返回了无法解析的 JSON'); });

  // 兜住各家字段名
  const arr = Array.isArray(data?.results) ? data.results
    : Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.sources) ? data.sources
    : Array.isArray(data?.references) ? data.references
    : Array.isArray(data?.webPages?.value) ? data.webPages.value
    : Array.isArray(data) ? data
    : [];

  const results = arr
    .filter((r) => r && (r.url || r.link))
    .map((r) => ({
      title: String(r.title ?? r.name ?? r.headline ?? '').trim() || '（无标题）',
      url: String(r.url ?? r.link ?? ''),
      snippet: String(r.content ?? r.snippet ?? r.summary ?? r.body ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) {
    throw new Error('自定义搜索没有返回可识别的结果（请检查接口返回是否包含 results/data/sources 等数组，或改用 bing 类型抓页面）');
  }
  return { query, results };
}

/** 用指定 URL 跑一次 Bing 结果的 HTML 解析（供自定义 bing 类型复用）。 */
async function bingSearchWithUrl(query, searchUrl, signal = null) {
  throwIfAborted(signal);
  const cfg = getConfig().webSearch ?? {};
  const url = String(searchUrl || cfg.searchUrl || 'https://cn.bing.com/search');
  const maxResults = Math.max(1, Math.min(10, Number(cfg.maxResults) || 6));
  const target = new URL(url);
  target.searchParams.set('q', query);
  const res = await fetch(target, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: composeAbortSignal(15000, signal)
  });
  if (!res.ok) throw new Error(`自定义搜索（bing 类型）HTTP ${res.status}`);
  const html = await res.text();
  const results = [];
  for (const block of html.split('<li class="b_algo"').slice(1)) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= maxResults) break;
  }
  if (!results.length) throw new Error('自定义搜索（bing 类型）没有解析到结果，请确认该引擎返回 b_algo 结构');
  return { query, results };
}
