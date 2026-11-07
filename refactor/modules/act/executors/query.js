/**
 * M10 · 执行器切片 `query`（查聊天记录 / 查人 / 查网）—— 契约见 ./index.js
 *
 * 归属 6 个工具（旧实现 `src/tools.js`）：
 *   get_recent_messages L1864-1897 · get_message_detail L1951-1979 · get_active_members L1932-1950
 *   web_search L2592-2650 · web_fetch L2854-2909 · external_lookup L2408-2452
 *
 * 依赖（只走公开出口）：
 *   · 聊天记录：`ctx.modules.memory.store`（类已落地 `modules/memory/chat-store.js`：
 *     `recent(chatKey,{limit,offset})` / `findByRef(chatKey,ref)` / `activeMembers(chatKey,n)`；
 *     **实例还没挂上命名空间** ⇒ 现阶段这 3 个工具按契约显式返回「依赖未就绪」）
 *     —— 方法取不到时显式返回「依赖未就绪」，**不许**用 evidence/context 凑一份假历史。
 *   · 短编号：`ctx.modules.memory.msgRef`（已落地：`modules/memory/msg-ref.js`，出口 `memory/index.js:33`）。
 *   · 引用作者标签：`ctx.modules.memory.quoteAuthorLabel`（出口 `memory/index.js:42`）。
 *   · 联网：`ctx.modules.internet`（M14：webSearch / webFetch / wikiLookup / buildSiteSearchUrl /
 *     extractPageDigest / extractImageUrls / browseLockState / hostAllowed）。
 */

/** 依赖没就绪：说清缺什么（契约 §1.6 —— 不许返回假的成功）。 */
function notReady(what) {
  return { ok: false, error: `依赖未就绪：${what}` };
}

function modulesOf(ctx) {
  return ctx?.modules || {};
}

/**
 * store 的调用形状照 `src/store.js`（那片正在被逐字节搬运）：
 *   recent(chatKey, {limit, offset}) · activeMembers(chatKey, n) · findByRef(chatKey, ref)
 * 不做「两种参数形状都试一遍」的兜底 —— 真撞车时要它响出来，不要静默换一种调用。
 */
function needsStore(ctx, ...names) {
  const store = modulesOf(ctx).memory?.store || null;
  const missing = names.filter((name) => typeof store?.[name] !== 'function');
  return missing.length
    ? notReady(`聊天记录存档（ChatStore）尚未落地：memory.store.${missing.join('/')}`)
    : { ok: true, store };
}

function needsInternet(ctx, ...names) {
  const internet = modulesOf(ctx).internet || {};
  const missing = names.filter((name) => typeof internet[name] !== 'function');
  return missing.length
    ? notReady(`联网检索（M14.internet.${missing.join('/')}）尚未提供`)
    : { ok: true, internet };
}

function readCfg(ctx, keyPath, fallback) {
  const cfg = ctx?.cfg;
  if (typeof cfg?.get !== 'function') return fallback;
  try {
    const value = cfg.get(keyPath, fallback);
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

/** 给模型看的时间：与旧实现同口径（zh-CN、24 小时、月日时分）。 */
function timeLabel(ts) {
  const at = Number(ts);
  if (!Number.isFinite(at)) return '';
  try {
    return new Date(at).toLocaleString('zh-CN', {
      hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  } catch {
    return new Date(at).toISOString();
  }
}

function boundedInt(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 一条存档消息 → 模型可读的短条目（`messageId` 就是聊天里那条前面的 `#318`）。 */
function briefMessage(entry, msgRef) {
  const ref = typeof msgRef === 'function' ? msgRef(entry) : '';
  return {
    ...(ref ? { messageId: ref } : {}),
    time: timeLabel(entry?.ts),
    sender: entry?.self ? '我' : String(entry?.senderName ?? entry?.sender ?? ''),
    text: String(entry?.text ?? '')
  };
}

/**
 * 引用行的作者标签（旧 `src/tools.js:1968` 用 `quoteAuthorLabel(rawReply, getConfig().memberNotes)`）。
 * 走 memory 的公开出口；出口没挂上就退回存档里的原始名字（这不影响工具成败，够不着标签≠消息查不到）。
 */
function quoteLabel(ctx, rawReply) {
  const label = modulesOf(ctx).memory?.quoteAuthorLabel;
  if (typeof label !== 'function') return rawReply?.sender ?? null;
  return label(rawReply, readCfg(ctx, 'memberNotes', {}));
}

/**
 * 「本次处理已抓过的页面」——旧实现挂在 `ctx.session.fetchedPages`，新契约的 ctx 白名单里没有 session。
 * 正文 token 很贵（中文 1 字 ≈ 1 token），同一轮重复抓同一页纯属白烧 ⇒ 按 `evidenceId`（一轮一个）
 * 在本模块内存一张有上限的表；图片直链仍照给，因为模型常常是回来「再看一眼有哪些图」。
 */
const FETCH_CACHE_MAX = 64;
const fetchedPages = new Map();

function fetchCacheGet(evidenceId, url) {
  for (const [key, value] of fetchedPages) {
    if (key !== `${evidenceId}\u0000${url}`) continue;
    fetchedPages.delete(key);
    fetchedPages.set(key, value);
    return value;
  }
  return null;
}

function fetchCacheSet(evidenceId, url, images) {
  const key = `${evidenceId}\u0000${url}`;
  fetchedPages.delete(key);
  fetchedPages.set(key, images);
  while (fetchedPages.size > FETCH_CACHE_MAX) {
    fetchedPages.delete(fetchedPages.keys().next().value);
  }
}

/** 页面里可读正文有多长（判「多半是 JS 渲染」用，口径同旧实现）。 */
function plainLength(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

const SITE_SEARCH_EMPTY_HINT = '站内搜索页没解析出结果（多半是 JS 动态渲染，HTML 里没有列表）。'
  + '可以改抓这些常见入口：站点的 RSS（如 /feed、/search/关键词/feed/rss2/）、'
  + '站点的 API（WordPress 站可试 /wp-json/wp/v2/posts?search=关键词），或直接给具体的文章页 URL。';

const FETCH_EMPTY_HINT = '这页 HTML 里几乎没有可读内容（可能靠 JS 渲染）。'
  + '可以试站点的 RSS（/feed、/search/关键词/feed/rss2/）、'
  + '站点的 API（WordPress 站可试 /wp-json/wp/v2/posts?search=关键词），或直接给具体的文章页 URL。';

export const executors = {
  /** 往前翻当前会话的更早历史（提示词里只带了最近一段）。 */
  get_recent_messages: async (ctx, args) => {
    const gate = needsStore(ctx, 'recent');
    if (!gate.ok) return gate;
    const limit = boundedInt(args?.limit, { min: 1, max: 100, fallback: 30 });
    // 旧实现还加了一个 `ctx.session.pastStateCount` 偏移（跳过提示词里已给的那段）；
    // `ctx.session` 不在 M15 的 ctx 白名单里 ⇒ 只能按模型自己给的 offset 翻。
    const offset = boundedInt(args?.offset, { min: 0, max: 5000, fallback: 0 });
    try {
      const messages = gate.store.recent(ctx.chatKey, { limit, offset }) || [];
      const msgRef = modulesOf(ctx).memory?.msgRef;
      return {
        ok: true,
        data: {
          count: messages.length,
          ...(offset ? { offset } : {}),
          messages: messages.map((entry) => briefMessage(entry, msgRef))
        }
      };
    } catch (error) {
      return { ok: false, error: `翻历史失败：${error?.message ?? error}` };
    }
  },

  /** 按 `#318` 短编号看单条消息详情。 */
  get_message_detail: async (ctx, args) => {
    const gate = needsStore(ctx, 'findByRef');
    if (!gate.ok) return gate;
    const wanted = String(args?.messageId ?? '').trim();
    if (!wanted) return { ok: false, error: '缺少 messageId（要传聊天记录里每条前面的 #短编号）' };
    try {
      const entry = gate.store.findByRef(ctx.chatKey, wanted);
      if (!entry) {
        return { ok: false, error: `当前会话找不到消息 ${wanted}。${await recentRefHint(ctx, gate.store)}` };
      }
      const msgRef = modulesOf(ctx).memory?.msgRef;
      const rawReply = entry.reply || null;
      const replyText = String(rawReply?.text ?? '').trim();
      const hasBody = !!(rawReply && (String(rawReply.sender ?? '').trim() || replyText));
      return {
        ok: true,
        data: {
          messageId: (typeof msgRef === 'function' ? msgRef(entry) : '') || undefined,
          time: timeLabel(entry.ts),
          sender: entry.self ? '我' : String(entry.senderName ?? entry.sender ?? ''),
          senderId: entry.senderId ?? null,
          text: String(entry.text ?? ''),
          reply: hasBody ? { ref: rawReply.ref || undefined, sender: quoteLabel(ctx, rawReply), text: replyText } : null
        }
      };
    } catch (error) {
      return { ok: false, error: `查消息详情失败：${error?.message ?? error}` };
    }
  },

  /** 当前会话最近活跃的成员（找人 @ 或拍一拍）。 */
  get_active_members: async (ctx, args) => {
    const gate = needsStore(ctx, 'activeMembers');
    if (!gate.ok) return gate;
    const limit = boundedInt(args?.limit, { min: 1, max: 20, fallback: 10 });
    try {
      const members = gate.store.activeMembers(ctx.chatKey, limit) || [];
      return {
        ok: true,
        data: {
          members: members.map((m) => ({
            userId: m?.userId ?? null,
            name: String(m?.name ?? ''),
            lastSeen: timeLabel(m?.lastTs),
            recentCount: Number(m?.count) || 0
          }))
        }
      };
    } catch (error) {
      return { ok: false, error: `查活跃成员失败：${error?.message ?? error}` };
    }
  },

  /** 联网搜索：锁定站点时优先走站内搜索页，否则全网搜完再滤掉站外。 */
  web_search: async (ctx, args) => {
    const gate = needsInternet(ctx, 'webSearch', 'webFetch', 'buildSiteSearchUrl', 'extractPageDigest', 'browseLockState', 'hostAllowed');
    if (!gate.ok) return gate;
    const { webSearch, webFetch, buildSiteSearchUrl, extractPageDigest, browseLockState, hostAllowed } = gate.internet;
    const query = String(args?.query ?? '').trim();
    if (!query) return { ok: false, error: '搜索失败：query 为空' };
    try {
      const maxChars = Math.max(1000, Number(readCfg(ctx, 'webSearch.fetchMaxChars', 8000)) || 8000);
      const lock = browseLockState();
      // ① 配了站内搜索模板：直接抓站点自己的搜索页，比"全网搜完再过滤"准得多
      const template = String(readCfg(ctx, 'security.browseLock.searchUrl', '')).trim();
      if (lock.enabled && template) {
        const searchUrl = buildSiteSearchUrl(template, query);
        const page = await webFetch(searchUrl);
        const digest = extractPageDigest(page.body, page.url, { maxChars });
        const empty = !digest.links.length && !digest.images.length;
        return {
          ok: true,
          data: {
            siteSearch: page.url,
            note: `已在锁定站点内搜索（${lock.domains.join('、')}）：links 是站内结果，images 是这页的图片直链。`
              + (empty ? SITE_SEARCH_EMPTY_HINT : ''),
            links: digest.links,
            images: digest.images,
            content: digest.text
          }
        };
      }
      // ② 锁定站点但没模板：给关键词加 site: 限定，避免搜出一堆站外结果再被滤光
      const siteLimited = lock.enabled && String(readCfg(ctx, 'webSearch.provider', 'bing')).toLowerCase() === 'bing';
      const effectiveQuery = siteLimited
        ? `${query} ${lock.domains.length > 1 ? `(${lock.domains.map((d) => `site:${d}`).join(' OR ')})` : `site:${lock.domains[0]}`}`
        : query;
      const result = await webSearch(effectiveQuery);
      const results = Array.isArray(result?.results) ? result.results : [];
      if (!results.length) {
        return { ok: true, data: { query, results: [], note: '没有搜到结果，试试换关键词或更具体的说法。' } };
      }
      if (!lock.enabled) return { ok: true, data: { ...result, query } };
      // ③ 兜底：无论哪个搜索服务，站外结果一律滤掉（抓不了，留着只会让模型白试）
      const kept = results.filter((item) => {
        try { return hostAllowed(new URL(String(item?.url || '')).hostname, lock); } catch { return false; }
      });
      const dropped = results.length - kept.length;
      return {
        ok: true,
        data: {
          query,
          results: kept,
          ...(dropped ? { note: `已按浏览锁定（只允许 ${lock.domains.join('、')}）过滤掉 ${dropped} 条站外结果。` } : {})
        }
      };
    } catch (error) {
      return { ok: false, error: `搜索失败：${error?.message ?? error}` };
    }
  },

  /** 只读抓取网页正文 + 抽图片直链（内网/锁定站点由 M14 的 safeFetch 把关）。 */
  web_fetch: async (ctx, args) => {
    const gate = needsInternet(ctx, 'webFetch', 'extractImageUrls');
    if (!gate.ok) return gate;
    const url = String(args?.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '抓取失败：url 必须是 http(s) 地址' };
    try {
      const maxChars = Math.max(1000, Number(readCfg(ctx, 'webSearch.fetchMaxChars', 8000)) || 8000);
      const evidenceId = String(ctx?.evidenceId ?? '');
      const seen = fetchCacheGet(evidenceId, url.toLowerCase());
      if (seen) {
        return {
          ok: true,
          data: {
            url,
            images: seen,
            note: '这个页面本次处理已经抓过了，正文见上一次 web_fetch 的结果（不重复返回，省 token）。'
          }
        };
      }
      const result = await gate.internet.webFetch(url);
      const body = String(result?.body ?? '');
      let images = (typeof gate.internet.extractImageUrls === 'function'
        ? gate.internet.extractImageUrls(body, result?.url, 10) : []) || [];
      // JSON 接口（站点 API）里也挑出图片直链，方便模型直接发图
      if (!images.length) {
        const fromJson = (body.match(/https?:\/\/[^"'\\\s]+\.(?:jpe?g|png|gif|webp)(?:\?[^"'\\\s]*)?/gi) || [])
          .map((item) => item.replace(/\\\//g, '/'));
        images = [...new Set(fromJson)].slice(0, 10).map((item) => ({ url: item, alt: '' }));
      }
      fetchCacheSet(evidenceId, url.toLowerCase(), images);
      const emptyHint = (plainLength(body) < 400 && !images.length) ? FETCH_EMPTY_HINT : '';
      return {
        ok: true,
        data: {
          url: result?.url ?? url,
          statusCode: result?.statusCode ?? null,
          truncated: result?.truncated === true || body.length > maxChars,
          images,
          ...(emptyHint ? { hint: emptyHint } : {}),
          content: body.slice(0, maxChars)
        }
      };
    } catch (error) {
      return { ok: false, error: `抓取失败：${error?.message ?? error}` };
    }
  },

  /** 查管理员配置的 wiki 源；没命中就退回联网搜索（并说清那不是百科原文）。 */
  external_lookup: async (ctx, args) => {
    const gate = needsInternet(ctx, 'wikiLookup', 'webSearch');
    if (!gate.ok) return gate;
    const query = String(args?.query ?? '').trim();
    if (!query) return { ok: false, error: '缺少 query（页面名或关键词）' };
    try {
      const limit = boundedInt(args?.limit, { min: 1, max: 5, fallback: 2 });
      const r = await gate.internet.wikiLookup(query, {
        limit,
        source: String(args?.source ?? '').trim()
      });
      if (r?.ok && Array.isArray(r.results) && r.results.length) {
        return { ok: true, data: { label: r.label, query: r.query, results: r.results } };
      }
      try {
        const ws = await gate.internet.webSearch(`${query} wiki 设定`);
        const results = (Array.isArray(ws?.results) ? ws.results : []).slice(0, 5).map((x) => ({
          title: x?.title,
          url: x?.url,
          snippet: String(x?.snippet || x?.content || '').slice(0, 300)
        }));
        if (results.length) {
          return {
            ok: true,
            data: {
              query,
              label: `联网搜索（百科源无命中：${r?.error || '没这个条目'}）`,
              results,
              note: '这些是网页搜索结果，不是百科原文；引用时说清来源链接。'
            }
          };
        }
      } catch { /* 搜索也失败就按无命中处理 */ }
      return { ok: true, data: { query, results: [], note: `外部库无命中：${query}。可说不知道，或换关键词。` } };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }
};

/** 「不要自己编编号」的提示：把最近可见的短编号列给模型（旧 `midHint` 口径）。 */
async function recentRefHint(ctx, store) {
  try {
    const msgRef = modulesOf(ctx).memory?.msgRef;
    if (typeof msgRef !== 'function' || typeof store?.recent !== 'function') {
      return '只能填聊天记录里每条消息前的 #短编号，照抄，不要自己编数字';
    }
    const refs = [...new Set((store.recent(ctx.chatKey, { limit: 60 }) || [])
      .map((entry) => msgRef(entry))
      .filter(Boolean))].slice(-8);
    return refs.length
      ? `引用只能填聊天记录里每条消息前的 #短编号（最近可见：${refs.join(' ')}），照抄，不要自己编数字`
      : '聊天记录里还没有带 #编号 的消息';
  } catch {
    return '引用只能填聊天记录里每条消息前的 #短编号';
  }
}
