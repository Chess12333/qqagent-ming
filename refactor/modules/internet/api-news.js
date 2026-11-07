// 免费 API 情报：抓「免费额度 / 限时免费 / 即将开放 / 长期免费」类信息，压成人话 + 附链接。
//
// 与普通新闻的区别（按需求定死）：
//   1. 不追求"最新"：进行中的活动、这几天要开放的都算，跨天保留（默认留 45 天）
//   2. 只关心能用上的东西：免费额度多少、怎么领、什么时候截止
//   3. 每天凌晨 4 点自动刷新一次（服务器内定时，不依赖任何外部调度）
//
// 存 data/api-news.json。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../../core/config-store/index.js';
import { writeJsonAtomic } from '../../core/util/index.js';
import { chatCompletion } from '../llm/index.js';

const FILE = path.join(DATA_DIR, 'api-news.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const KEEP_DAYS = 45;          // 条目最多保留这么久，避免无限堆积
const REFRESH_HOUR = 4;        // 每天凌晨 4 点自动刷新

/**
 * 默认源。专指「AI 羊毛 / 免费额度」类站点（按管理员指定），RSS 只作补充。
 * 每个源失败都只跳过自己，不影响其它源。
 */
export const DEFAULT_API_SOURCES = [
  // ① yangmao.ai 羊毛追踪器：JSON Feed，字段最全（额度/截止/领取入口）
  { id: 'yangmao', name: 'yangmao.ai', type: 'yangmao', url: 'https://yangmao.ai/zh/deals/feed.json' },
  // ② AI Pulse（xphub）：社区情报流，常有新模型免费额度活动
  { id: 'xphub', name: 'AI Pulse', type: 'xphub', url: 'https://ai.xphub.dev/' },
  // ③ linux.do：社区线索（Discourse JSON）
  { id: 'linuxdo', name: 'linux.do', type: 'discourse', url: 'https://linux.do/latest.json' }
];

/**
 * 备用 RSS。**默认关闭**：这些综合资讯源会带进大量「开源项目发布」，
 * 把清单冲成开源推荐（用户明确不要）。想开就在配置里写 feeds。
 */
export const DEFAULT_API_FEEDS = [];
/** 想手动开 RSS 时可以从这里挑。 */
export const OPTIONAL_API_FEEDS = [
  { name: 'IT之家', url: 'https://www.ithome.com/rss/' },
  { name: '量子位', url: 'https://www.qbitai.com/feed' },
  { name: '开源中国', url: 'https://www.oschina.net/news/rss' }
];

/**
 * 厂商别名 → 规范键。中英文写法必须归一到同一个键，
 * 否则「百川智能」和「baichuan」会被当成两家，清单里就会重复。
 */
const BRAND_ALIASES = [
  ['nvidia', ['nvidia nim', 'nvidia', '英伟达']],
  ['openrouter', ['openrouter']],
  ['cerebras', ['cerebras']],
  ['groq', ['groq']],
  ['together', ['together ai', 'together']],
  ['cohere', ['cohere']],
  ['lepton', ['lepton']],
  ['anyscale', ['anyscale']],
  ['deepseek', ['deepseek', '深度求索']],
  ['kimi', ['kimi', 'moonshot', '月之暗面']],
  ['qwen', ['qwen', '通义千问', '通义', '阿里云', 'aliyun', '百炼']],
  ['zhipu', ['zhipu', '智谱', 'glm-', 'glm ']],
  ['minimax', ['minimax']],
  ['doubao', ['doubao', '豆包', 'volcengine', '火山引擎']],
  ['baichuan', ['baichuan', '百川']],
  ['ernie', ['ernie', '文心', '百度千帆', 'baidu', '百度']],
  ['siliconflow', ['siliconflow', '硅基流动']],
  ['openai', ['openai', 'chatgpt', 'gpt-4', 'gpt-5', 'gpt4o', 'gpt-4o']],
  ['anthropic', ['anthropic', 'claude']],
  ['google', ['gemini', 'google ai', 'gemma', 'google']],
  ['xai', ['grok', 'x.ai', 'xai']],
  ['qoder', ['qoder']],
  ['cursor', ['cursor']],
  ['cline', ['cline']],
  ['windsurf', ['windsurf']],
  ['bolt', ['bolt.new', 'bolt']],
  ['replit', ['replit']],
  ['copilot', ['github copilot', 'copilot']],
  ['mistral', ['mistral']],
  ['meta', ['llama', 'meta ai']],
  ['huggingface', ['hugging face', 'huggingface']],
  ['modelscope', ['modelscope', '魔搭']],
  ['tencent', ['hunyuan', '腾讯混元', 'tencent', '腾讯']],
  ['stepfun', ['stepfun', '阶跃']],
  ['sensetime', ['sensetime', '商汤']],
  ['xiaomi', ['xiaomi', '小米']],
  ['kuaishou', ['kuaishou', '快手']],
  ['bytedance', ['bytedance', '字节', '豆包']],
  ['cloudflare', ['cloudflare']],
  ['modal', ['modal']],
  ['runpod', ['runpod']],
  ['vastai', ['vast.ai', 'vastai']],
  ['autodl', ['autodl']],
  ['paperspace', ['paperspace']],
  ['lambda', ['lambda cloud', 'lambda']],
  ['friendli', ['friendli']],
  ['requesty', ['requesty']],
  ['perplexity', ['perplexity']],
  ['poe', ['poe']]
];

/** 从标题/正文里认出厂商，返回规范键（用于「同一家只留一条」）。 */
function brandKey(text) {
  const t = String(text || '').toLowerCase();
  for (const [key, aliases] of BRAND_ALIASES) {
    for (const a of aliases) {
      if (t.includes(a)) return key;
    }
  }
  return '';
}

/** 强 AI/API 语境（中英）。 */
const AI_STRONG_RE = /(大模型|语言模型|多模态|API|接口|token|算力|推理|智能体|Agent|DeepSeek|GPT|Claude|Gemini|Qwen|通义|豆包|Kimi|智谱|GLM|文心|Llama|Mistral|MiniMax|Grok|Copilot|生成式|OpenAI|Anthropic|开源模型|模型权重|向量|嵌入|语音合成|图像生成|\bLLM\b|\bAI\b|inference|model)/i;
/**
 * 免费/开放关键词（重点判定）。
 * ⚠️ 不含裸「开源 / 权重 / 降价」——否则一堆「开源版 vX 发布」会把清单塞满，
 * 那不是用户要的「免费 API 活动」。降价/优惠单独给一小档。
 */
const FREE_RE = /(免费|限免|白嫖|0元|赠送|额度|领取|申请|试用|公测|内测|限时|免费层|开放|体验|优惠|折扣|降价|下调|\bfree\b|\bcredits?\b|\btrial\b|\bpromo\b|\bgiveaway\b|\boffer\b|\bdiscount\b|\bvoucher\b|\bcoupon\b)/i;
/** 纯开源发布（无免费/额度信号）→ 不算活动。 */
const OPENSOURCE_ONLY_RE = /(开源版|开源发布|开源了|发布.*开源|v\d+\.\d+(\.\d+)?\s*发布|版本发布)/i;
/** 「即将开放」信号，单独加权（用户明确要"过两天会开放"的也算）。 */
const UPCOMING_RE = /(即将|将于|将开放|即将开放|即将上线|即将发布|计划开放|下(周|月)|月底|明日|明天|后天|\d{1,2}\s*月\s*\d{1,2}\s*日|\bsoon\b|starts?\s|from\s+\w+\s+\d{1,2})/i;
/** 3C/消费电子与杂项：一律剔除。 */
const HARDWARE_RE = /(笔记本|手机|手表|耳机|显卡|显示器|平板|路由|主机|相机|键盘|鼠标|音箱|电视|国补|预售|开售|上市|元起|京东|天猫|淘宝|拼多多)/i;
/** 不是 API 额度：课程/教程/工具介绍一律剔除（用户要的是能用上的接口）。 */
const NOT_API_RE = /(免费课程|课程|教程|入门|学习资源|备考|指南$|从零到|零基础|攻略|培训|视频课|讲座|大会|峰会|论坛)/i;
const JUNK_RE = /(星座|黄历|彩票|股(市|票)|基金|房价|招聘|失物|天气|手办|球赛|家电|影视|综艺)/;

function stripTags(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchFeed(feed) {
  const res = await fetch(String(feed.url), {
    headers: { 'user-agent': UA, accept: 'application/rss+xml,application/xml,text/xml,*/*' },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const items = [];
  for (const m of xml.matchAll(/<item[\s\S]*?<\/item>/g)) {
    const block = m[0];
    const pick = (tag) => {
      const mm = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return mm ? stripTags(mm[1]) : '';
    };
    const title = pick('title');
    const url = pick('link') || (block.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? '');
    if (!title || !url) continue;
    items.push({
      title,
      url,
      snippet: pick('description').slice(0, 300),
      source: feed.name,
      ts: Date.parse(pick('pubDate') || pick('published') || '') || 0
    });
  }
  return items;
}

/** ① yangmao.ai JSON Feed：字段最全（额度/截止/领取入口）。 */
async function fetchYangmao(src) {
  const res = await fetch(src.url, {
    headers: { 'user-agent': UA, accept: 'application/feed+json,application/json,*/*' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const items = Array.isArray(j?.items) ? j.items : [];
  return items.map((it) => {
    const ym = it?._yangmao || {};
    return {
      title: stripTags(it.title).slice(0, 120),
      url: String(ym.signup_url || it.url || '').trim(),
      detailUrl: String(it.url || '').trim(),
      snippet: stripTags(it.content_text).slice(0, 400),
      amount: String(ym.value_amount || '').trim(),
      endsAt: ym.ends_at ? String(ym.ends_at).slice(0, 20) : '',
      verifiedAt: String(ym.verified_at || '').slice(0, 20),
      tags: Array.isArray(it.tags) ? it.tags.map(String) : [],
      source: src.name,
      ts: Date.parse(it.date_modified || it.date_published || '') || 0
    };
  }).filter((x) => x.title && x.url);
}

/** ② AI Pulse（xphub）：首页 + 前几页 HTML，抽 /post/<id> 标题。 */
async function fetchXphub(src) {
  const base = src.url.replace(/\/+$/, '');
  const pages = ['', '/p/2', '/p/3'];
  const out = [];
  const seen = new Set();
  await Promise.all(pages.map(async (p) => {
    try {
      const res = await fetch(`${base}${p}`, {
        headers: { 'user-agent': UA, accept: 'text/html' },
        signal: AbortSignal.timeout(12000)
      });
      if (!res.ok) return;
      const html = await res.text();
      for (const m of html.matchAll(/href="(\/post\/\d+)"[^>]*>([\s\S]{0,300}?)<\/a>/g)) {
        const url = `${base}${m[1]}`;
        if (seen.has(url)) continue;
        const title = stripTags(m[2]);
        if (!title || title.length < 6) continue;
        seen.add(url);
        out.push({ title: title.slice(0, 160), url, snippet: '', source: src.name, ts: 0 });
      }
    } catch { /* 单页失败跳过 */ }
  }));
  return out;
}

/** ③ Discourse（linux.do）：latest.json。 */
async function fetchDiscourse(src) {
  const res = await fetch(src.url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const list = Array.isArray(j?.topic_list?.topics) ? j.topic_list.topics : [];
  return list.map((t) => ({
    title: stripTags(t.title).slice(0, 140),
    url: `${new URL(src.url).origin}/t/${t.slug || 'topic'}/${t.id}`,
    snippet: '',
    source: src.name,
    ts: Date.parse(t.last_posted_at || t.created_at || '') || 0
  })).filter((x) => x.title && x.url);
}

/** 按类型分发；未知类型按 RSS 处理。 */
async function fetchSource(src) {
  if (src.type === 'yangmao') return fetchYangmao(src);
  if (src.type === 'xphub') return fetchXphub(src);
  if (src.type === 'discourse') return fetchDiscourse(src);
  return fetchFeed(src);
}

/** 定向搜索词：专找「免费额度 / 领取 / 开放申请」类活动。 */
const SEED_QUERIES = [
  '大模型 免费 API 额度 活动',
  '免费 API key 领取 大模型',
  'AI 接口 限时免费 开放申请',
  '免费 token 额度 赠送 模型',
  '开源大模型 免费调用 平台'
];

/** 用联网搜索补一批「免费额度活动」候选（失败就算了，不影响 RSS）。 */
async function collectSearchSeeds({ perQuery = 6 } = {}) {
  let webSearch = null;
  try {
    ({ webSearch } = await import('./web-search.js'));
  } catch { return []; }
  const out = [];
  await Promise.all(SEED_QUERIES.map(async (q) => {
    try {
      const r = await webSearch(q, { limit: perQuery });
      for (const x of (r?.results || [])) {
        const url = String(x?.url || '').trim();
        const title = String(x?.title || '').trim();
        if (!url || !title) continue;
        out.push({
          title,
          url,
          snippet: String(x?.snippet || x?.content || '').slice(0, 240),
          source: '搜索',
          ts: Date.now()
        });
      }
    } catch { /* 单条失败跳过 */ }
  }));
  return out;
}

/**
 * 抓候选：指定羊毛站（yangmao / AI Pulse / linux.do）+ 备用 RSS + 定向搜索。
 * 判定：AI/API 语境 + 免费额度信号；**同一厂商只留信息量最大的一条**。
 */
export async function collectFreeApiCandidates({ max = 80 } = {}) {
  // ★ T71 修：这处原来读的是**顶层** `getConfig().apiNews`，而 `apiNews` 全仓**只**定义在
  //   `webSearch.apiNews`（config.js 的 DEFAULT_CONFIG 里）⇒ 该键永远不存在 ⇒ `cfg` 恒为 `{}`
  //   ⇒ 用户/默认值里写的 `sources` / `feeds` **从来没生效过**，且**没有任何报错**（静默回退默认源）。
  //   ★ 不改 `config.js`、不挪键位置、不改默认值与形状 —— 只把读取路径指到键真正所在的地方。
  //   与同文件 `startApiNewsScheduler` 里那处 `getConfig().webSearch?.apiNews?.enabled` 口径一致。
  const cfg = getConfig().webSearch?.apiNews || {};
  const sources = Array.isArray(cfg.sources) && cfg.sources.length ? cfg.sources : DEFAULT_API_SOURCES;
  // feeds 默认空 = 只用指定羊毛站（避免综合资讯把清单冲成开源推荐）
  const feeds = Array.isArray(cfg.feeds) ? cfg.feeds : DEFAULT_API_FEEDS;

  const all = [];
  await Promise.all([
    ...sources.map(async (s) => {
      try {
        const rows = await fetchSource(s);
        all.push(...rows);
      } catch { /* 单源失败跳过 */ }
    }),
    ...feeds.map(async (f) => {
      try {
        const rows = await fetchFeed(f);
        all.push(...rows);
      } catch { /* 单源失败跳过 */ }
    })
  ]);
  // 定向搜索补充（可选，失败不影响）
  try {
    const seeds = await collectSearchSeeds();
    if (seeds.length) all.push(...seeds);
  } catch { /* ignore */ }

  const seen = new Set();
  const scored = [];
  for (const it of all) {
    if (!it.url || seen.has(it.url)) continue;
    const hay = `${it.title} ${it.snippet}`;
    if (JUNK_RE.test(hay) || HARDWARE_RE.test(hay) || NOT_API_RE.test(it.title)) continue;
    const strong = AI_STRONG_RE.test(hay);
    const free = FREE_RE.test(hay);
    if (!strong || !free) continue;
    // 纯开源/版本发布、且没有任何额度/领取信号 → 跳过
    if (OPENSOURCE_ONLY_RE.test(it.title) && !/(免费|额度|领取|申请|试用|赠送|限时|公测|开放)/.test(it.title)) continue;
    seen.add(it.url);

    const titleFree = FREE_RE.test(it.title) ? 2 : 0;
    const titleAI = AI_STRONG_RE.test(it.title) ? 1 : 0;
    const upcoming = UPCOMING_RE.test(hay) ? 1 : 0;
    // yangmao 带结构化额度/领取入口，权重最高
    const structured = (it.amount ? 2 : 0) + (it.endsAt ? 1 : 0);
    scored.push({
      ...it,
      brand: brandKey(`${it.title} ${it.snippet}`),
      upcoming,
      score: titleFree + titleAI + upcoming + structured
    });
  }
  scored.sort((a, b) => (b.score - a.score) || ((b.ts || 0) - (a.ts || 0)));

  // 同厂商去重：每家只留分数最高（信息最全）的一条；无厂商名的条目单独保留
  const byBrand = new Map();
  const noBrand = [];
  for (const it of scored) {
    if (!it.brand) { noBrand.push(it); continue; }
    if (!byBrand.has(it.brand)) byBrand.set(it.brand, it);
  }
  const out = [...byBrand.values(), ...noBrand]
    .sort((a, b) => (b.score - a.score) || ((b.ts || 0) - (a.ts || 0)));
  return out.slice(0, Math.max(1, Math.min(120, max)));
}

function parseJsonLoose(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : t;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

function fmtList(items, limit = 60) {
  return items.slice(0, limit).map((it, i) => [
    `${i + 1}. ${it.title}`,
    it.amount ? `   额度：${it.amount}` : '',
    it.endsAt ? `   截止：${it.endsAt}` : '',
    it.snippet ? `   摘要：${it.snippet.slice(0, 200)}` : '',
    `   来源：${it.source}`,
    `   链接：${it.url}`
  ].filter(Boolean).join('\n')).join('\n');
}

function normLinks(arr) {
  return (Array.isArray(arr) ? arr : [])
    .map((l) => ({ label: String(l?.label || '').slice(0, 30) || '链接', url: String(l?.url || '').trim() }))
    .filter((l) => /^https?:\/\//i.test(l.url))
    .slice(0, 4);
}

/** 三分类：新用户注册 / 限时活动 / 长期免费。 */
export const API_CATEGORIES = ['新用户注册', '限时活动', '长期免费'];

/** 本地兜底分类（模型没给 category 时用），也用于给旧缓存补字段。 */
export function classifyByText(title = '', summary = '', deadline = '') {
  const t = `${title} ${summary}`;
  if (/(新用户|新注册|注册即送|注册送|新账号|首次注册|注册就送|注册领取|新人|new users?|sign[\s-]?up)/i.test(t)) return '新用户注册';
  if (/(限时|即将|截止|促销|活动期间|抢|本周|本月|限免|结束|还剩|有效期|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}[-–]\d{1,2}|daily|limited|ends?\b|until\b|expires?\b|sep\s*\d|oct\s*\d|nov\s*\d)/i.test(t)
    || (deadline && deadline !== '未知')) return '限时活动';
  return '长期免费';
}

/**
 * 用模型整理成「免费活动」条目。
 * previous：上次已有的条目，一并交给模型去重合并（这样进行中的活动不会因为今天没新闻就消失）。
 */
async function summarizeFreeApis(candidates, previous = []) {
  const prevText = previous.length
    ? previous.map((p, i) => `${i + 1}. ${p.title}｜${p.summary || ''}｜分类:${p.category || ''}｜截止:${p.deadline || '无'}`).join('\n')
    : '（无）';
  const prompt = [
    '下面是抓到的 AI 免费额度情报（含额度/截止/领取入口），以及我上次已经收录的条目。',
    '请整理成一份「免费 API 可用清单」，给开发者看。',
    '',
    '重点：**免费额度、限时免费、免费开放、即将开放、长期免费**。不要求是今天的新消息 ——',
    '只要活动还在进行、或过几天要开放、或是长期免费的，都要留下。',
    '**只要"有明确免费额度/credits/试用/免费层"的**；纯开源项目发布、纯工具介绍、纯涨价、',
    '融资、课程、论文，一律不要。判断标准：读者看完能不能"去注册领额度用起来"。',
    '',
    '每条必须归入下面**三类之一**（category）：',
    '1. **新用户注册**：只对"新注册/新用户"发放的额度（注册即送、新人礼包、试用金）。',
    '2. **限时活动**：有截止时间 / 限时免费 / 即将开放 / 需要抢或申请的活动。',
    '   ⚠️ 只有这一类才允许写具体截止时间；没有明确结束时间的**不要**放进这一类。',
    '3. **长期免费**：长期有效的免费层 / 永久免费额度 / 持续可领的免费配额。',
    '',
    '每条输出：',
    '- title：活动/产品名（简短，能认出来）',
    '- summary：一到两句人话。说清**免费什么（额度/时长/模型）、怎么领、有没有门槛**',
    '- category：新用户注册 / 限时活动 / 长期免费（三选一）',
    '- deadline：仅"限时活动"填；其余填"未知"',
    '- links：来源链接（优先官方申请页）',
    '',
    '规则：',
    '1. **同一个厂商最多留 1 条**（如 Gemini/Groq/Kimi/DeepSeek/Qoder/NVIDIA 等各只能出现一次），',
    '   留信息量最大、额度最明确的那条；同一家的其它消息合并进它。',
    '2. 上次清单里有更新就覆盖；拿不准类别时选"长期免费"。',
    '3. 不要编造额度、日期、链接；不确定就写"未知"。',
    '4. 最多 25 条。',
    '',
    '只输出 JSON：',
    '{"items":[{"title":"…","summary":"…","category":"新用户注册","deadline":"未知","links":[{"label":"来源","url":"https://…"}]}]}',
    '',
    '【本次抓到的资讯】',
    fmtList(candidates, 60),
    '',
    '【上次已收录】',
    prevText
  ].join('\n');

  const res = await chatCompletion({
    messages: [{ role: 'user', content: prompt }],
    tools: null,
    temperature: 0.3,
    overrides: { disableThinking: true, timeoutMs: 180000 }
  });
  const j = parseJsonLoose(res?.message?.content);
  const rows = Array.isArray(j?.items) ? j.items : [];
  const now = Date.now();
  return rows.slice(0, 25).map((x) => {
    const title = String(x?.title || '').slice(0, 120);
    const summary = String(x?.summary || '').slice(0, 500);
    let deadline = String(x?.deadline || '未知').slice(0, 40);
    let category = String(x?.category || '').trim();
    if (!API_CATEGORIES.includes(category)) {
      // 模型没给/给错 → 本地兜底
      category = classifyByText(title, summary, deadline);
    }
    // 只有「限时活动」保留截止时间，其它一律未知（避免长期免费被误标成限时）
    if (category !== '限时活动') deadline = '未知';
    return { title, summary, category, deadline, links: normLinks(x?.links), lastSeen: now };
  }).filter((x) => x.title);
}

function readCache() {
  try {
    let t = fs.readFileSync(FILE, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    return JSON.parse(t);
  } catch { return null; }
}

function writeCache(data) {
  try {
    writeJsonAtomic(FILE, data, { indent: 1 });
  } catch { /* ignore */ }
}

function dayKeyOf(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function pruneItems(items) {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  return (Array.isArray(items) ? items : []).filter((it) => {
    const seen = Number(it?.lastSeen) || Number(it?.firstSeen) || 0;
    return !seen || seen >= cutoff;
  });
}

let refreshing = false;

/** 抓取 + 整理（会调模型），并与上次清单合并。 */
export async function refreshApiNews() {
  if (refreshing) return { ok: false, error: '已有一次刷新在进行' };
  refreshing = true;
  try {
    const prev = readCache();
    const previousItems = Array.isArray(prev?.items) ? prev.items : [];
    const candidates = await collectFreeApiCandidates({ max: 80 });

    if (!candidates.length && !previousItems.length) {
      const data = { ok: true, dayKey: dayKeyOf(), updatedAt: Date.now(), items: [], note: '今天没抓到免费 API 相关条目（可能源被墙）。' };
      writeCache(data);
      return data;
    }

    // 旧缓存没有 category：读进来先补一遍，免得旧条目掉类
    const normalizedPrev = pruneItems(previousItems).map((it) => {
      const category = API_CATEGORIES.includes(it?.category)
        ? it.category
        : classifyByText(it?.title || '', it?.summary || '', it?.deadline || '');
      return { ...it, category, deadline: category === '限时活动' ? (it?.deadline || '未知') : '未知' };
    });

    let items = [];
    try {
      items = await summarizeFreeApis(candidates, normalizedPrev);
    } catch {
      items = normalizedPrev;
    }
    // 合并：上次有、这次模型漏掉的（仍在保留期内）也留着
    const byTitle = new Map();
    for (const it of normalizedPrev) byTitle.set(String(it.title).trim(), it);
    for (const it of items) {
      const k = String(it.title).trim();
      const old = byTitle.get(k);
      byTitle.set(k, old ? { ...old, ...it, firstSeen: old.firstSeen || old.lastSeen || Date.now() } : { ...it, firstSeen: Date.now() });
    }
    const merged = [...byTitle.values()]
      .sort((a, b) => {
        const rank = (x) => API_CATEGORIES.indexOf(x.category);
        return rank(a) - rank(b) || (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0);
      })
      .slice(0, 60);

    const data = {
      ok: true,
      dayKey: dayKeyOf(),
      updatedAt: Date.now(),
      scanned: candidates.length,
      items: merged,
      note: merged.length ? '' : '抓到候选但没整理出可用条目。'
    };
    writeCache(data);
    return data;
  } catch (error) {
    const c = readCache();
    return { ok: false, error: String(error?.message ?? error), items: c?.items || [] };
  } finally {
    refreshing = false;
  }
}

/**
 * 旧缓存兼容：没有 category 的条目就地补一个，免得前端分类是空的。
 * （老版本只存 status，字段名不同，直接读会让标签和筛选都失效。）
 */
function normalizeCachedItems(items) {
  return (Array.isArray(items) ? items : []).map((it) => {
    if (API_CATEGORIES.includes(it?.category)) return it;
    const category = classifyByText(it?.title || '', it?.summary || '', it?.deadline || '');
    return { ...it, category, deadline: category === '限时活动' ? (it?.deadline || '未知') : '未知' };
  });
}

/** 读缓存；没有或跨天则刷新一次。 */
export async function getApiNews({ force = false } = {}) {
  if (force) return refreshApiNews();
  const cache = readCache();
  const items = cache ? normalizeCachedItems(cache.items) : null;
  if (cache && Array.isArray(cache.items) && cache.dayKey === dayKeyOf()) {
    return { ...cache, items, cached: true };
  }
  if (cache && Array.isArray(cache.items) && cache.items.length) {
    // 有旧数据：先给旧的，后台慢慢刷
    refreshApiNews().catch(() => {});
    return { ...cache, items, cached: true, stale: true };
  }
  return refreshApiNews();
}

export function apiNewsStatus() {
  const cache = readCache();
  return {
    refreshing,
    updatedAt: Number(cache?.updatedAt) || 0,
    dayKey: cache?.dayKey || '',
    count: Array.isArray(cache?.items) ? cache.items.length : 0
  };
}

// ── 每天凌晨 4 点自动刷新（服务器内定时，不依赖外部调度） ──
let schedulerTimer = null;
let lastRunDay = '';

export function startApiNewsScheduler() {
  if (schedulerTimer) return;
  const tick = () => {
    try {
      if (getConfig().webSearch?.apiNews?.enabled === false) return;
      const now = new Date();
      if (now.getHours() !== REFRESH_HOUR) return;
      const today = dayKeyOf(now);
      if (lastRunDay === today) return;
      lastRunDay = today;
      console.log(`[api-news] 凌晨 ${REFRESH_HOUR} 点自动刷新…`);
      refreshApiNews()
        .then((r) => console.log(`[api-news] 完成：${(r.items || []).length} 条${r.error ? ` (${r.error})` : ''}`))
        .catch((e) => console.error('[api-news] 自动刷新失败:', e?.message ?? e));
    } catch { /* 定时器里绝不抛 */ }
  };
  // 启动时若已过 4 点且今天没刷过，交给 getApiNews 的首次调用处理；这里只管往后每天
  schedulerTimer = setInterval(tick, 10 * 60 * 1000);
  if (schedulerTimer.unref) schedulerTimer.unref();
}

export function stopApiNewsScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
}
