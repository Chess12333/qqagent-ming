// 多源 MediaWiki / 百科查询：设定查外部，不进本地知识库。
// 支持配置多个 wiki；默认/指定源。部分站匿名 API 被禁时退回 HTML 搜索页。
import { getConfig } from '../../core/config-store/index.js';
import { sanitizeQuery } from './web-search.js';

function wikiCfg() {
  return getConfig().webSearch?.wiki ?? {};
}

/** 规范化 sources 数组。 */
export function listWikiSources() {
  const w = wikiCfg();
  if (w.enabled === false) return [];
  const raw = Array.isArray(w.sources) && w.sources.length
    ? w.sources
    : [
      // 兼容旧单站配置
      ...(w.baseUrl ? [{ id: 'main', label: w.label || '百科', baseUrl: w.baseUrl, triggerWords: [] }] : [])
    ];
  const out = [];
  for (const s of raw) {
    if (!s || s.enabled === false) continue;
    const baseUrl = String(s.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) continue;
    out.push({
      id: String(s.id || baseUrl),
      label: String(s.label || baseUrl),
      baseUrl,
      triggerWords: Array.isArray(s.triggerWords) ? s.triggerWords : []
    });
  }
  return out;
}

export function defaultWikiSource() {
  const sources = listWikiSources();
  if (!sources.length) return null;
  const key = String(wikiCfg().default || wikiCfg().baseUrl || '').replace(/\/+$/, '');
  if (key) {
    const hit = sources.find((s) => s.id === key || s.baseUrl === key || s.label === key);
    if (hit) return hit;
  }
  // 默认优先维基
  return sources.find((s) => /wiki/i.test(s.id) || /维基/.test(s.label)) || sources[0];
}

export function wikiSourceById(id) {
  const sources = listWikiSources();
  if (!id) return defaultWikiSource();
  const k = String(id);
  return sources.find((s) => s.id === k || s.baseUrl === k || s.label === k) || null;
}

function decode(s) {
  return String(s ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
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

function absUrl(base, href) {
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  // 维基 base 可能是 https://zh.wikipedia.org 或 …/w
  if (base.endsWith('/w')) return `${base.replace(/\/w$/, '')}${href.startsWith('/') ? '' : '/'}${href}`;
  return `${base}${href.startsWith('/') ? '' : '/'}${href}`;
}

function wikiRoot(base) {
  return base.endsWith('/w') ? base.replace(/\/w$/, '') : base;
}

/** 两个 URL 是否同主机（只看 host，不看 scheme/端口大小写以外的差异）。 */
function sameHost(a, b) {
  try { return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase(); } catch { return false; }
}

async function apiSearch(src, q, n) {
  const searchUrl = new URL(`${src.baseUrl}/api.php`);
  searchUrl.searchParams.set('action', 'query');
  searchUrl.searchParams.set('list', 'search');
  searchUrl.searchParams.set('srsearch', q);
  searchUrl.searchParams.set('srlimit', String(n));
  searchUrl.searchParams.set('srprop', 'snippet');
  searchUrl.searchParams.set('format', 'json');
  searchUrl.searchParams.set('utf8', '1');
  const res = await fetch(searchUrl, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; qq-agent/1.0; +wiki_lookup)',
      accept: 'application/json'
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(`${src.label} API HTTP ${res.status}`);
  const data = await res.json();
  if (data?.error) throw new Error(String(data.error.info || data.error.code || 'wiki API error'));
  return data?.query?.search || [];
}

async function apiExtracts(src, titles, introChars) {
  if (!titles.length) return new Map();
  const extractUrl = new URL(`${src.baseUrl}/api.php`);
  extractUrl.searchParams.set('action', 'query');
  extractUrl.searchParams.set('prop', 'extracts|info');
  extractUrl.searchParams.set('inprop', 'url');
  extractUrl.searchParams.set('exintro', '1');
  extractUrl.searchParams.set('explaintext', '1');
  extractUrl.searchParams.set('exlimit', 'max');
  extractUrl.searchParams.set('titles', titles.join('|'));
  extractUrl.searchParams.set('format', 'json');
  extractUrl.searchParams.set('utf8', '1');
  const er = await fetch(extractUrl, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; qq-agent/1.0; +wiki_lookup)',
      accept: 'application/json'
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!er.ok) return new Map();
  const ej = await er.json();
  const pages = ej?.query?.pages || {};
  const map = new Map();
  for (const p of Object.values(pages)) {
    if (!p?.title) continue;
    map.set(String(p.title), {
      extract: decode(p.extract || '').slice(0, introChars),
      url: p.fullurl || ''
    });
  }
  return map;
}

async function htmlSearch(src, q, n) {
  const root = wikiRoot(src.baseUrl);
  const url = new URL(`${root}/index.php`);
  url.searchParams.set('search', q);
  url.searchParams.set('fulltext', '1');
  url.searchParams.set('limit', String(Math.max(n, 5)));
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; qq-agent/1.0; +wiki_lookup)',
      accept: 'text/html',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(`${src.label} HTML HTTP ${res.status}`);
  const html = await res.text();
  const results = [];
  const seen = new Set();
  const re = /<a[^>]+href="(\/[^"?#]+|https?:\/\/[^"?#]+)"[^>]*title="([^"]+)"[^>]*>([^<]{1,80})<\/a>/g;
  for (const m of html.matchAll(re)) {
    const href = m[1];
    const title = decode(m[2]);
    if (!title || title.includes(':') || /搜索|特殊|讨论|用户|分类|模板|帮助|文件|MediaWiki/.test(title)) continue;
    if (seen.has(title)) continue;
    const near = title.includes(q) || q.includes(title);
    if (!near && results.length > 0) continue;
    seen.add(title);
    results.push({ title, snippet: '', extract: '', url: absUrl(src.baseUrl, href) });
    if (results.length >= n) break;
  }
  // ★ 2026-10-17（安全审查）：下面的补抓是**对远端页面里抠出来的 href** 再发一次请求。
  //   `absUrl` 对绝对 href 原样返回，所以 wiki 返回 `href="http://127.0.0.1:5700/…"` 时
  //   这条 fetch 会照着去访问 —— 它既不走 safe-fetch 的 SSRF 校验，也没有主机限制，
  //   等于把配置里的任意 wiki 变成一个指向本机（OneBot / 桌面服务）的请求跳板。
  //   补抓的本意只是"把刚搜到的那一篇的正文读回来"，那就只读同主机的那一篇。
  if (results[0]?.url && sameHost(results[0].url, src.baseUrl)) {
    try {
      const pr = await fetch(results[0].url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; qq-agent/1.0; +wiki_lookup)',
          accept: 'text/html',
          'accept-language': 'zh-CN,zh;q=0.9'
        },
        signal: AbortSignal.timeout(12000)
      });
      if (pr.ok) {
        const page = await pr.text();
        const body = page.match(/<div[^>]+id="mw-content-text"[\s\S]*?<\/div>\s*<\/div>/i)?.[0]
          || page.match(/<p>[\s\S]{40,}<\/p>/i)?.[0]
          || '';
        const extract = decode(body).slice(0, 480);
        if (extract) results[0].extract = extract;
      }
    } catch { /* ignore */ }
  }
  return results;
}

async function lookupOne(src, q, n, introChars) {
  try {
    const hits = await apiSearch(src, q, n);
    if (hits.length) {
      const titles = hits.map((h) => h.title).filter(Boolean);
      const extracts = await apiExtracts(src, titles, introChars);
      return hits.slice(0, n).map((h) => {
        const ex = extracts.get(h.title) || {};
        return {
          source: src.id,
          label: src.label,
          title: h.title,
          snippet: decode(h.snippet || ''),
          extract: ex.extract || '',
          url: ex.url || `${wikiRoot(src.baseUrl)}/wiki/${encodeURIComponent(String(h.title).replace(/ /g, '_'))}`
        };
      });
    }
  } catch {
    // fall through to HTML
  }
  const rows = await htmlSearch(src, q, n);
  return rows.map((r) => ({ ...r, source: src.id, label: src.label }));
}

/**
 * 查百科。source 可选：源 id / label / baseUrl；缺省用 default 源。
 * source='all' 时对所有启用源各查一次（合并，每源 limit 条）。
 */
export async function wikiLookup(query, { limit = 3, introChars = 480, source = '' } = {}) {
  const sources = listWikiSources();
  const q = sanitizeQuery(query);
  if (!sources.length) {
    return { ok: false, label: '', query: q, results: [], error: 'wiki 未配置（webSearch.wiki.sources）' };
  }
  if (!q) return { ok: false, label: '', query: q, results: [], error: '查询词为空' };

  const n = Math.max(1, Math.min(5, Number(limit) || 3));
  const mode = String(source || '').trim();
  const errors = [];

  if (mode === 'all') {
    const results = [];
    for (const src of sources) {
      try {
        const rows = await lookupOne(src, q, n, introChars);
        results.push(...rows);
      } catch (e) {
        errors.push(`${src.label}: ${e?.message ?? e}`);
      }
    }
    if (!results.length && errors.length) {
      return { ok: false, label: sources.map((s) => s.label).join('/'), query: q, results: [], error: errors.join('; ') };
    }
    return {
      ok: true,
      label: sources.map((s) => s.label).join(' + '),
      query: q,
      results: results.slice(0, n * sources.length),
      errors: errors.length ? errors : undefined
    };
  }

  const src = mode ? wikiSourceById(mode) : defaultWikiSource();
  if (!src) {
    return {
      ok: false,
      label: '',
      query: q,
      results: [],
      error: `wiki 源不存在：${mode}；可用：${sources.map((s) => s.id).join(', ')}`
    };
  }

  try {
    const results = await lookupOne(src, q, n, introChars);
    return { ok: true, label: src.label, source: src.id, query: q, results };
  } catch (error) {
    return { ok: false, label: src.label, source: src.id, query: q, results: [], error: String(error?.message ?? error) };
  }
}
