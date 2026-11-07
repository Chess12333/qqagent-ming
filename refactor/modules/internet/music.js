// M14 internet · 音乐能力（网易云）—— 从旧树 `src/tools.js:296-612` 搬进来的私有函数。
//
// ★ 搬运口径（票面 G19）：**五个纯函数整段照搬**，两个出网函数**只换出口**，一个状态函数**只换目录来源**。
//   逐行对照表在 `music-selftest.mjs` 的「保真表」段落，跑一遍就能验。
//
// 与旧树的**四处有意偏离**（除这四处外内部逻辑一行不改）：
//   ① **状态文件目录改成注入**（旧 `src/tools.js:469` 是 `path.join(DATA_DIR, 'music-played.json')`，
//      而 `DATA_DIR` 是 config-store 的**导入期常量** ⇒ 谁 import 谁就在读生产 `data/`；
//      新树必须由装配层 `configureMusic({ dataDir })` 或调用时 `{ dataDir }` 给。没给 ⇒ **拒绝写 + 记故障**，
//      绝不回退到仓库 `data/`。文件名沿用 `music-played.json`。
//   ② **出网走 M14 既有的出网闸** `safeFetch`（`./safe-fetch.js`：域名锁可选、DNS/私网校验、逐跳重定向重校验、
//      响应体上限），不再用旧树的裸 `fetch`。默认 `browseLocked:false` —— 这是**照旧**（旧裸 fetch 本来不吃浏览锁），
//      想让它吃锁请装配层传 `browseLocked:true`；SSRF 那一半（私网/环回拒绝）无论如何都生效，这是纯加固。
//      超时沿用旧值（搜索 12000ms / 详情 8000ms）；`maxBytes` 给到 2MB —— 旧裸 fetch 无上限，
//      而 cloudsearch 一次 20 首的 JSON 会超 `safeFetch` 默认的 50000 字节，被截断就等价于"搜不到"。
//   ③ `Math.random()` 改成可选注入（`{ random }`，默认仍是 `Math.random`）—— 为了自测能钉住随机序列，
//      行为不变。旧 `:486` 的 `catch { /* ignore */ }` 静默失败也不照搬：改成**记故障 + 返回 false + log 点名**。
//   ④ **S10 取消通路**（2026-10-19）：`searchNeteaseSong` / `fetchNeteaseSongDetail` 增加可选 `{ signal }`
//      （出网传给 `safeFetch`，入口 `throwIfAborted`）。searchOnce 的端点降级、整词失败后的拆词重试、
//      内层 e2 兜底这三处 catch，在 signal 已中止时改抛 AbortError —— 不许把取消吞成"换端点/拆词重试"。
//      详情函数本来就不吞错（网络异常照旧上抛），只加入口检查与信号透传。**不传 signal 行为与旧树一致**。
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/util/index.js';
import { safeFetch, abortError, throwIfAborted } from './safe-fetch.js';

// ── 状态：最近发过的歌 id（防随机复读）；旧 src/tools.js:469-487 ──────────────
const PLAYED_FILE_NAME = 'music-played.json';   // 旧 :469 的文件名，一个字不改
const PLAYED_MAX = 80;                          // 旧 :485 的 slice(0, 80)

let runtime = null;         // { dataDir, log } —— 由 configureMusic() 注入
const faults = new Map();   // stateFile -> 故障原因（★ 按文件分键：装配层没注入时用的是哨兵键，
                            //   不能让"某个目录读坏了"去挡住另一个健康目录的写 —— 自测 2j3 就是抓这条的）
const NO_DIR_KEY = '<未注入 dataDir>';
let warnedNoDataDir = false;

/**
 * 装配层启动时调一次：注入状态目录与日志。
 * ★ 没注入也能用（搜索/挑歌照跑，只是"最近播过"名单为空且**绝不写盘**）——
 *   但那是降级态，`musicStatus().stateFault` 会一直点名，别让它长期停在这儿。
 */
export function configureMusic({ dataDir, log = console.log } = {}) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new Error('configureMusic: dataDir 必须显式注入（非空字符串）—— 不许回退到仓库 data/');
  }
  runtime = { dataDir: dataDir.trim(), log: typeof log === 'function' ? log : console.log };
  faults.delete(NO_DIR_KEY);
  warnedNoDataDir = false;
  return { dataDir: runtime.dataDir, stateFile: stateFileOf(runtime.dataDir) };
}

function stateFileOf(dir) {
  return path.join(dir, PLAYED_FILE_NAME);
}

/** 本次调用用哪个目录：显式 `{dataDir}` > configureMusic > 没有（返回 ''）。 */
function resolveDataDir(opts) {
  const fromOpts = typeof opts?.dataDir === 'string' ? opts.dataDir.trim() : '';
  if (fromOpts) return fromOpts;
  if (runtime?.dataDir) return runtime.dataDir;
  return '';
}

/** 记某个状态文件的故障（按文件分键 ⇒ 一个目录读坏不影响另一个目录能写）。 */
function noteFault(file, message, opts) {
  faults.set(file || NO_DIR_KEY, String(message));
  const log = typeof opts?.log === 'function' ? opts.log : runtime?.log;
  if (typeof log === 'function') log(`[music] ${message}`);
}

function clearFault(file) {
  faults.delete(file || NO_DIR_KEY);
}

function musicFilePath(opts) {
  const dir = resolveDataDir(opts);
  if (!dir) {
    if (!warnedNoDataDir) {
      warnedNoDataDir = true;
      noteFault(NO_DIR_KEY, '没注入 dataDir ⇒ 「最近播过」名单按空处理，且**拒绝写盘**（旧树这里是 import 期的生产 DATA_DIR）', opts);
    }
    return '';
  }
  return stateFileOf(dir);
}

/**
 * 读「最近播过」名单。旧 :470-479 是 `catch { return [] }`（任何错都当空）——
 * 新树按 `modules/media/memes.js:21-35` 的口径改：**只有 ENOENT 才算空**，其它读故障按文件记下来，
 * 用于让 `rememberMusicPlayed()` 拒绝覆盖（读坏了还硬写 = 把用户名单清零）。
 */
export function loadMusicPlayed(opts = {}) {
  const file = musicFilePath(opts);
  if (!file) return [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') { clearFault(file); return []; }   // 真·还没有名单
    noteFault(file, `music-played.json 读不动 ⇒ 本次按空名单处理，但**不会回写覆盖**：${String(error?.message ?? error)}`, opts);
    return [];
  }
  try {
    const j = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
    clearFault(file);
    return Array.isArray(j.ids) ? j.ids.map(String) : [];
  } catch (error) {
    noteFault(file, `music-played.json 坏了 ⇒ 本次按空名单处理，但**不会回写覆盖**（先备份/删掉这文件再重试）：${String(error?.message ?? error)}`, opts);
    return [];
  }
}

/**
 * 记一首「最近播过」（旧 :480-487）。语义照搬：去重后 unshift、只留 80 条。
 * 差别只在：写走 `writeJsonAtomic`（tmp+rename），且**这个文件**读不动就先拒绝写。
 * @returns {boolean} 是否真的落了盘（旧树静默失败，这里返回出来给执行器看得见）
 */
export function rememberMusicPlayed(songId, opts = {}) {
  const file = musicFilePath(opts);
  if (!file) return false;
  if (faults.has(file)) return false;   // 读都读不动 ⇒ 更不许写（一写就把用户名单覆盖没了）
  try {
    const list = loadMusicPlayed(opts).filter((id) => id !== String(songId));
    list.unshift(String(songId));
    writeJsonAtomic(file, { ids: list.slice(0, PLAYED_MAX) }, { indent: 1 });
    return true;
  } catch (error) {
    noteFault(file, `写 music-played.json 失败（本次不记名单，不改行为）：${String(error?.message ?? error)}`, opts);
    return false;
  }
}

/** 给 status/排查用（不含任何歌曲正文，只有聚合数字）。 */
export function musicStatus(opts = {}) {
  const file = musicFilePath(opts);
  return {
    stateFile: file || null,
    dataDirInjected: Boolean(resolveDataDir(opts)),
    stateFault: faults.get(file || NO_DIR_KEY) ?? null,
    anyFault: faults.size ? [...faults.entries()].map(([k, v]) => `${k}: ${v}`) : [],
    playedCount: file ? loadMusicPlayed(opts).length : 0
  };
}

// ── 纯函数：query 形状判断（旧 src/tools.js:295-311，逐字）──────────────────
/** 只出现类型/风格、没有具体歌名的 query（如「古典 提神」） */
export function isVagueMusicQuery(q) {
  const t = String(q || '').trim();
  if (!t) return true;
  if (/^(随机|随便|来点歌|来首歌|放点音乐|随便来|随机歌)$/i.test(t)) return false;
  const genreOnly = /^(古典|摇滚|ost|原声|交响|钢琴曲|金属|朋克|民谣|电子|说唱|爵士|轻音乐?)(音乐)?$/i;
  if (genreOnly.test(t)) return true;
  const genres = ['古典', '摇滚', 'OST', '原声', '交响', '金属', '民谣', '电子', '钢琴', '提神', '治愈', '燃'];
  let stripped = t;
  for (const g of genres) stripped = stripped.replace(new RegExp(g, 'ig'), ' ');
  stripped = stripped.replace(/\s+/g, ' ').trim();
  return stripped.length < 2;
}

export function isRandomMusicQuery(q) {
  return /^(随机|随便|来点歌|来首歌|放点音乐|随便来|随机歌|random)$/i.test(String(q || '').trim());
}

// ── 类型词 → 具体曲目池（旧 src/tools.js:339-378，逐字；随机源改成可注入 = 偏离③）──
/** 模糊类型词 → 可搜的具体关键词（每次随机挑几组，避免总推同一首） */
export const MUSIC_GENRE_POOL = {
  古典: [
    '贝多芬 致爱丽丝', '贝多芬 月光奏鸣曲', '德彪西 月光', '肖邦 夜曲',
    '黄河钢琴协奏曲', '梁祝 小提琴协奏曲', '四季 维瓦尔第', '卡农 帕赫贝尔',
    '柴可夫斯基 胡桃夹子', '德沃夏克 自新世界'
  ],
  摇滚: [
    '海阔天空 Beyond', '光辉岁月 Beyond', 'Hotel California Eagles',
    'Don\'t Stop Me Now Queen', '晴天 周杰伦', '告白气球 周杰伦',
    '平凡之路 朴树', '蓝莲花 许巍', '海浪 胡彦斌'
  ],
  OST: [
    '天空之城 久石让', 'Summer 久石让', 'Naruto 主题曲',
    '鬼灭之刃 红莲华', '你的名字 前前前世', '星际穿越 主题曲',
    '权游 主题曲', '进击的巨人 红莲弓矢'
  ],
  电子: ['Faded Alan Walker', 'Animals Martin Garrix', 'Unity TheFatRat', 'On My Way'],
  民谣: ['成都 赵雷', '南山南 马頔', '斑马斑马 宋冬野', '董小姐 宋冬野'],
  爵士: ['Fly Me to the Moon', 'Take Five', 'My Funny Valentine'],
  提神: ['We Will Rock You', '海阔天空 Beyond', 'My Heart Will Go On', 'Victory Two Steps From Hell'],
  治愈: ['晴天 周杰伦', '稻香 周杰伦', '夜空中最亮的星 逃跑计划', '遇见 孙燕姿'],
  燃: ['Victory Two Steps From Hell', 'Star Sky', '海阔天空 Beyond', 'In The End']
};

export function pickGenreQueries(raw, { random = Math.random } = {}) {
  const s = String(raw || '');
  const out = [];
  for (const [k, list] of Object.entries(MUSIC_GENRE_POOL)) {
    if (s.includes(k) || s.toLowerCase().includes(k.toLowerCase())) {
      out.push(...list);
    }
  }
  // 打乱后取 3 条，降低复读概率
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, 3);
}

// ── 标题质量（旧 src/tools.js:380-455，逐字）────────────────────────────────
/**
 * 歌名括号内容是否像「劣质版本标记」而不是官方副标题。
 * 官方副标题示例：晴天（Silence）、Something (feat. XXX) 里少数正常用法
 * 劣质标记：翻唱 / Live / 钢琴版 / 伴奏 / TV size / Demo / Cover xxx …
 */
const MUSIC_JUNK_PAREN_RE = new RegExp(
  [
    '翻唱', 'cover', '翻调', '钢琴', '吉他', '纯音乐', '伴奏', 'k歌', '卡拉ok', 'karaoke',
    'live', '现场', '演唱会', 'acoustic', 'instrumental', 'demo', 'remix', 'edit',
    'tv\\s*size', 'op\\b', 'ed\\b', '插入歌', '角色歌', '同人', '鬼畜', '调音', '翻唱版',
    '双人翻唱', '原神', '崩坏', '音mad', 'vocaloid翻调', 'cover\\s*by', '弹唱', 'unplugged',
    'remastered\\s*版', '加速', '降调', 'DJ版', '广场舞', '车载', '铃声', '片段', '15秒',
    '动态歌词', '歌词版', '音频版', '视频版', '竖屏', '高音质', '超清'
  ].join('|'),
  'i'
);

/** 整名里的明显劣质标记（不靠括号也要扣）。 */
const MUSIC_JUNK_NAME_RE = new RegExp(
  [
    '\\bcover\\b', '翻唱', '翻调', '钢琴独奏', '钢琴版', '吉他版', '纯音乐版',
    '\\blive\\b', '现场版', '演唱会版', '伴奏', 'k歌', '卡拉ok', 'karaoke',
    '\\bdemo\\b', '\\bremix\\b', '\\btv\\s*size\\b', '广场舞', '车载版', '铃声版'
  ].join('|'),
  'i'
);

/** 提取歌名里所有括号内容（中英文括号）。 */
export function extractParenChunks(name) {
  const t = String(name || '');
  const out = [];
  const re = /[（(【\[]([^）)】\]]{1,40})[）)】\]]/g;
  let m;
  while ((m = re.exec(t))) {
    const chunk = String(m[1] || '').trim();
    if (chunk) out.push(chunk);
  }
  return out;
}

/**
 * 标题质量：随机/类型推荐时用来滤垃圾。
 * @returns {{ junk: boolean, softParen: boolean, penalty: number }}
 *  - junk：硬滤（翻唱/现场/钢琴版…）
 *  - softParen：有括号但不像硬垃圾（可能是官方副标题 / feat）
 *  - penalty：扣分（越大越差）
 */
export function musicTitleQuality(name) {
  const n = String(name || '');
  if (MUSIC_JUNK_NAME_RE.test(n)) {
    return { junk: true, softParen: false, penalty: 8 };
  }
  const chunks = extractParenChunks(n);
  let junk = false;
  let softParen = false;
  let penalty = 0;
  for (const c of chunks) {
    if (MUSIC_JUNK_PAREN_RE.test(c) || MUSIC_JUNK_NAME_RE.test(c)) {
      junk = true;
      penalty += 8;
    } else if (/feat\.?|ft\.?/i.test(c)) {
      // 官方合作曲常见，不拦
      penalty += 0;
    } else {
      // 括号有内容但不是明显垃圾：可能是官方副标题，随机模式轻扣
      softParen = true;
      penalty += 0.4;
    }
  }
  // 全角括号空/极短（「歌名()」「歌名（）」）
  if (!chunks.length && /[（(]\s*[)）]/.test(n)) {
    junk = true;
    penalty += 4;
  }
  return { junk, softParen, penalty };
}

/**
 * 随机/类型模式下是否该丢掉这首。
 * - 硬垃圾直接丢
 * - 有括号（非 feat）在随机池里降权保留——官方副标题不该全灭，但不再优先
 */
export function shouldDropForCasualPlay(hit) {
  const q = musicTitleQuality(hit?.name);
  if (q.junk) return true;
  return false;
}

// ── 出网（旧 src/tools.js:313-337 / :489-575，只换出口 = 偏离②）──────────────
const NETEASE_HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; qq-agent/1.1; +netease)',
  referer: 'https://music.163.com/',
  cookie: 'appver=2.0.2;'
};
const NETEASE_DETAIL_HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; qq-agent/1.1)',
  referer: 'https://music.163.com/',
  cookie: 'appver=2.0.2;'
};
// 旧裸 fetch 没有响应体上限；这里给足（cloudsearch 20 首的 JSON 会超 safeFetch 默认 50KB，
// 被截断就等于"搜不到"），同时保住闸的存在。
const NETEASE_MAX_BYTES = 2 * 1024 * 1024;

/** 默认出网出口：M14 既有的 safeFetch（SSRF 校验 + 逐跳重定向重校验 + 上限）。 */
async function defaultFetchJson(url, { headers, timeoutMs, browseLocked = false, signal = null } = {}) {
  const res = await safeFetch(url, { headers, timeoutMs, maxBytes: NETEASE_MAX_BYTES, browseLocked, signal });
  if (res?.truncated) throw new Error(`响应超过大小上限（${NETEASE_MAX_BYTES} 字节）：${res.url}`);
  return { statusCode: res?.statusCode ?? 0, body: res?.body ?? '' };
}

/** 出口返回的形状：`{ statusCode, body }`（或已解析的 `{ statusCode, json }`）。 */
const is2xx = (res) => {
  const code = Number(res?.statusCode ?? 0);
  return code >= 200 && code < 300;
};
function parseJsonBody(res) {
  if (res && res.json !== undefined) return res.json;
  return JSON.parse(String(res?.body || 'null'));
}

/** 按 songId 拉网易云详情，补全歌名/歌手（给卡片回退用）。 */
export async function fetchNeteaseSongDetail(songId, { fetchJson = defaultFetchJson, browseLocked = false, signal = null } = {}) {
  throwIfAborted(signal);
  const id = String(songId || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const call = fetchJson === defaultFetchJson
    ? (url, o) => defaultFetchJson(url, { ...o, browseLocked, signal })
    : fetchJson;
  // 旧 :322 裸 fetch 没有 try/catch ⇒ 网络异常照旧往上抛（新树口径：抛错=失败，不许吞）
  const res = await call(
    `https://music.163.com/api/song/detail?ids=[${encodeURIComponent(id)}]`,
    { headers: NETEASE_DETAIL_HEADERS, timeoutMs: 8000 }
  );
  if (!is2xx(res)) return null;      // 旧 :326 `if (!res.ok) return null`
  const j = parseJsonBody(res);
  const s = j?.songs?.[0];
  if (!s) return null;
  const artist = (Array.isArray(s.artists) ? s.artists : s.ar || [])
    .map((a) => String(a?.name || '')).filter(Boolean).join('/');
  return {
    id: String(s.id ?? id),
    name: String(s.name || '').slice(0, 80),
    artist: artist.slice(0, 40)
  };
}

/**
 * 网易云搜索。支持 offset 分页（随机用），多关键词重试，按标题/歌手打分。
 * 旧 :492-575。**打分口径逐字**（name+5 / artist+4 / hay+2 / quality.penalty 扣 / 播过 -3 /
 * 有歌手 +0.3 / 干净主标题 +0.6，`id` 非纯数字丢弃，降序后取前 n）。
 */
export async function searchNeteaseSong(query, {
  limit = 8, offset = 0, fetchJson = defaultFetchJson, browseLocked = false,
  dataDir = null, log = null, random = Math.random, signal = null
} = {}) {
  throwIfAborted(signal);
  const q = String(query || '').trim().slice(0, 80);
  if (!q) return [];
  const n = Math.max(1, Math.min(20, Number(limit) || 8));
  const off = Math.max(0, Math.min(200, Number(offset) || 0));
  const headers = NETEASE_HEADERS;
  const call = fetchJson === defaultFetchJson
    ? (url, o) => defaultFetchJson(url, { ...o, browseLocked, signal })
    : fetchJson;
  async function tryFetch(url) {
    const res = await call(url, { headers, timeoutMs: 12000 });
    if (!is2xx(res)) throw new Error('HTTP ' + Number(res?.statusCode ?? 0));
    return parseJsonBody(res);
  }
  async function searchOnce(term, lim, offs) {
    try {
      const data = await tryFetch(
        'https://music.163.com/api/cloudsearch/pc?s=' + encodeURIComponent(term)
        + '&type=1&limit=' + lim + '&offset=' + offs + '&total=true'
      );
      const list = data?.result?.songs;
      if (Array.isArray(list) && list.length) return list;
    } catch (e) {
      if (signal?.aborted) throw abortError(e); /* fallthrough */
    }
    const data = await tryFetch(
      'https://music.163.com/api/search/get/web?s=' + encodeURIComponent(term)
      + '&type=1&limit=' + lim + '&offset=' + offs
    );
    return data?.result?.songs || [];
  }

  let songs = [];
  try {
    songs = await searchOnce(q, n, off);
  } catch (e) {
    // 取消不是"整词失败"——不许拿它去触发拆词重试
    if (signal?.aborted) throw abortError(e);
    // 整词失败：拆词重试一次
    const parts = q.split(/[\s,，、/]+/).filter(Boolean);
    if (parts.length > 1) {
      try {
        songs = await searchOnce(parts.slice(0, 2).join(' '), n, off);
      } catch (e2) {
        if (signal?.aborted) throw abortError(e2);
        throw new Error('网易云搜索失败：' + (e2?.message ?? e?.message ?? e));
      }
    } else {
      throw new Error('网易云搜索失败：' + (e?.message ?? e));
    }
  }

  const qt = q.toLowerCase().split(/[\s,，、/]+/).filter(Boolean);
  const played = new Set(loadMusicPlayed({ dataDir, log }));
  const scored = songs.map((s) => {
    const name = String(s.name ?? '').slice(0, 80);
    const artist = (Array.isArray(s.artists) ? s.artists : s.ar || [])
      .map((a) => String(a?.name || '')).filter(Boolean).join('/').slice(0, 40);
    const album = String(s.al?.name || s.album?.name || '');
    const hay = (name + ' ' + artist + ' ' + album).toLowerCase();
    let score = 0;
    for (const w of qt) {
      if (!w) continue;
      if (name.toLowerCase().includes(w)) score += 5;
      else if (artist.toLowerCase().includes(w)) score += 4;
      else if (hay.includes(w)) score += 2;
    }
    const quality = musicTitleQuality(name);
    score -= quality.penalty;
    if (played.has(String(s.id ?? ''))) score -= 3;
    // 偏好有歌手信息的结果
    if (artist) score += 0.3;
    // 干净主标题（无括号、无垃圾）小幅加成
    if (!quality.junk && !quality.softParen && extractParenChunks(name).length === 0) {
      score += 0.6;
    }
    return {
      id: String(s.id ?? ''),
      name,
      artist,
      album: album.slice(0, 40),
      score,
      junk: quality.junk
    };
  }).filter((x) => /^\d+$/.test(x.id));
  scored.sort((a, b) => b.score - a.score || random() - 0.5);   // 旧 :573 逐字（同分随机定序；比较器里摇随机数本就不稳定，旧树这行为照搬不"修"）
  return scored.slice(0, n);
}

/** 从候选里挑一首：随机/类型模式优先没播过的高分项，并滤掉翻唱/现场垃圾。 */
export function pickSongFromHits(hits, {
  random = false, exclude = null, randomFn = Math.random, dataDir = null, log = null
} = {}) {
  if (!hits?.length) return null;
  const played = new Set(loadMusicPlayed({ dataDir, log }));
  if (exclude) played.add(String(exclude));

  let list = hits;
  if (random) {
    // 随机/类型：硬垃圾直接扔；再优先干净标题 + 高分
    list = list.filter((h) => !h.junk && !shouldDropForCasualPlay(h));
    if (!list.length) {
      // 全被滤了：退回原列表（避免误伤特殊曲库），但不再随机
      list = hits.filter((h) => !h.junk);
      if (!list.length) list = hits;
    }
    const fresh = list.filter((h) => !played.has(h.id));
    if (fresh.length) list = fresh;
    // 只在高分带里随机：过低分直接排除
    const minScore = Math.min(...list.map((h) => h.score || 0));
    const top = list.filter((h) => (h.score || 0) >= Math.max(minScore, (list[0]?.score || 0) - 2.5));
    list = top.length ? top : list;
    // 权重：分数越高越容易中；带括号官方副标题仍可中但偏弱
    const weighted = [];
    for (const h of list.slice(0, Math.min(10, list.length))) {
      const paren = musicTitleQuality(h.name).softParen ? 0.55 : 1;
      const w = Math.max(1, Math.round(((h.score || 0) + 3) * paren));
      for (let i = 0; i < w; i++) weighted.push(h);
    }
    return weighted[Math.floor(randomFn() * weighted.length)] || list[0];
  }

  // 精确搜索：不硬滤括号（用户点名的歌可能就带副标题）
  const fresh = list.filter((h) => !played.has(h.id));
  if (fresh.length) list = fresh;
  return list.slice(0, Math.min(8, list.length))[0];
}
