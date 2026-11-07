// B 站视频解析：元信息 + 字幕/弹幕/官方AI总结/热评/可选抽帧。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { safeFetchBinary, validateFetchUrl, composeAbortSignal, abortError, throwIfAborted } from './safe-fetch.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
/** 单帧抽取的字节上限（-frames:v 1 正常只有几百 KB；超了说明 -i 指到了异常源，直接放弃）。 */
const FRAME_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;

async function bilibiliGet(url, { cookie = '', timeoutMs = 15000, signal = null } = {}) {
  throwIfAborted(signal);
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        origin: 'https://www.bilibili.com',
        referer: 'https://www.bilibili.com/',
        ...(cookie ? { cookie } : {})
      },
      signal: composeAbortSignal(timeoutMs, signal)
    });
    if (!res.ok) throw new Error(`B站 HTTP ${res.status}`);
    return await res.json();
  } catch (error) {
    // S10：调用方取消 → 统一成 AbortError 上抛（act 侧记 unknown，不冒成功）
    if (signal?.aborted) throw abortError(error);
    throw error;
  }
}

/** 从各种 B 站链接里抠 BV / avid（容忍全角、空格、QQ 贴链污染） */
export function parseBilibiliIds(rawUrl) {
  let u = String(rawUrl || '')
    .replace(/[　 ]/g, ' ')
    .replace(/[（）]/g, () => '')
    .trim();
  // 全角斜杠/字母常见于粘贴
  u = u.replace(/／/g, '/').replace(/[\uFF21-\uFF3A\uFF41-\uFF5A]/g, (ch) => {
    const c = ch.charCodeAt(0);
    const base = c <= 0xFF3A ? c - 0xFEE0 : c - 0xFEE0;
    return String.fromCharCode(base);
  });
  if (!u) return null;
  const bv = /(BV[0-9A-Za-z]{10})/i.exec(u);
  const av = /(?:av|AV)(\d+)/.exec(u);
  return {
    bvid: bv ? bv[1] : '',
    aid: av ? av[1] : ''
  };
}

async function resolveShortUrl(url, signal = null) {
  // ⚠️ 2026-10-17（安全审查）：原来判的是 `/b23\.tv/i.test(url)` —— 整串**子串**匹配，
  //   所以聊天里贴 `https://evil.example/x?b23.tv` 也会进来，再 `redirect: 'follow'`
  //   一路跟到任意主机（本进程的请求没有内网拦截）。改成只认真正的短链主机名。
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return url; }
  if (host !== 'b23.tv' && !host.endsWith('.b23.tv')) return url;
  throwIfAborted(signal);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': UA },
      signal: composeAbortSignal(8000, signal)
    });
    return res.url || url;
  } catch (error) {
    // 取消不许被当成"短链解析失败"吞掉（原来这里任何错都 return url）
    if (signal?.aborted) throw abortError(error);
    return url;
  }
}

function absSubUrl(subUrl) {
  let u = String(subUrl || '').trim();
  if (!u) return '';
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('/')) return `https:${u}`;
  if (!/^https?:/i.test(u)) return `https://${u.replace(/^\/+/, '')}`;
  return u;
}

async function fetchSubtitleBody(subUrl, cookie = '', signal = null) {
  const url = absSubUrl(subUrl);
  if (!url) return [];
  throwIfAborted(signal);
  try {
    const subRes = await fetch(url, {
      headers: {
        'user-agent': UA,
        referer: 'https://www.bilibili.com/',
        ...(cookie ? { cookie } : {})
      },
      signal: composeAbortSignal(12000, signal)
    });
    if (!subRes.ok) throw new Error(`字幕下载 HTTP ${subRes.status}`);
    const subJson = await subRes.json();
    return Array.isArray(subJson?.body) ? subJson.body : [];
  } catch (error) {
    if (signal?.aborted) throw abortError(error);
    throw error;
  }
}

function bodyToTranscript(body, maxChars) {
  return body
    .map((line) => String(line?.content || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, Math.max(500, Number(maxChars) || 4000));
}

/** 多路拉字幕列表：v2 / wbi/v2。 */
async function loadSubtitles({ bvid, aid, cid, cookie, signal = null }) {
  const idQs = bvid ? `bvid=${encodeURIComponent(bvid)}` : `aid=${encodeURIComponent(aid)}`;
  const endpoints = [
    `https://api.bilibili.com/x/player/wbi/v2?${idQs}&cid=${cid}`,
    `https://api.bilibili.com/x/player/v2?${idQs}&cid=${cid}`,
    `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&aid=${aid}&cid=${cid}`
  ];
  let lastErr = null;
  let lastPlayer = null;
  for (const ep of endpoints) {
    try {
      const player = await bilibiliGet(ep, { cookie, signal });
      lastPlayer = player;
      const subs = player?.data?.subtitle?.subtitles || [];
      if (subs.length) return { subs, player };
    } catch (e) {
      if (signal?.aborted) throw abortError(e);
      lastErr = e;
    }
  }
  if (lastPlayer) return { subs: [], player: lastPlayer };
  if (lastErr) throw lastErr;
  return { subs: [], player: null };
}

/** 弹幕列表（list.so）：无字幕时的补充信号。protobuf/xml 混出，只抽可读中文片段。 */
async function fetchDanmakuSnippets({ cid, cookie, maxChars = 1200, signal = null }) {
  const url = `https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}&type=1`;
  throwIfAborted(signal);
  let buf;
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        referer: `https://www.bilibili.com/`,
        ...(cookie ? { cookie } : {})
      },
      signal: composeAbortSignal(10000, signal)
    });
    if (!res.ok) throw new Error(`弹幕 HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    if (signal?.aborted) throw abortError(error);
    throw error;
  }
  const text = buf.toString('utf8');
  // XML 弹幕
  if (text.includes('<d ')) {
    const lines = [...text.matchAll(/<d[^>]*>([\s\S]*?)<\/d>/g)]
      .map((m) => String(m[1] || '').replace(/<[^>]+>/g, '').trim())
      .filter((s) => s && /[一-鿿]/.test(s))
      .slice(0, 80);
    if (lines.length) return lines.join(' ').replace(/\s+/g, ' ').slice(0, maxChars);
  }
  // protobuf 二进制：抠出连续可读中文串
  const cn = buf.toString('binary').match(/(?:[\x20-\x7e][\u4e00-\u9fff]?){4,}/g) || [];
  const parts = cn
    .map((s) => s.replace(/[^\u4e00-\u9fffA-Za-z0-9，。！？…~～\s]/g, '').trim())
    .filter((s) => /[一-鿿]/.test(s) && s.length >= 2)
    .slice(0, 60);
  if (parts.length) return parts.join(' ').replace(/\s+/g, ' ').slice(0, maxChars);
  return '';
}

/** 官方 AI 总结（多数要登录 cookie）。返回 { text, note } */
async function fetchVideoConclusion({ bvid, aid, cid, mid, cookie, signal = null }) {
  if (!cid) return { text: '', note: '无 cid，跳过官方总结' };
  const endpoints = [
    `https://api.bilibili.com/x/web-interface/view/conclusion/get?bvid=${encodeURIComponent(bvid)}&cid=${cid}&up_mid=${mid || ''}`,
    `https://api.bilibili.com/x/web-interface/view/conclusion/get?bvid=${encodeURIComponent(bvid)}&cid=${cid}`,
    `https://api.bilibili.com/x/web-interface/view/conclusion/get?aid=${aid}&cid=${cid}`
  ];
  let lastNote = '未取到官方总结';
  for (const ep of endpoints) {
    try {
      const j = await bilibiliGet(ep, { cookie, signal });
      if (j.code !== 0) {
        lastNote = `官方总结 code=${j.code} ${j.message || ''}`;
        continue;
      }
      const model = j.data?.model_result || j.data?.conclusion || j.data || {};
      const parts = [
        model.summary || model.title || '',
        Array.isArray(model.topic_summary)
          ? model.topic_summary.map((t) => t.topic_name || t.topic || '').filter(Boolean).join('；')
          : '',
        Array.isArray(model.outline)
          ? model.outline.map((o) => o.outline || o.title || '').filter(Boolean).join('；')
          : '',
        Array.isArray(model.revision)
          ? model.revision.map((x) => x.outline || x.title || '').filter(Boolean).join('；')
          : ''
      ].filter(Boolean).join('\n');
      if (parts.trim()) return { text: parts.trim().slice(0, 2500), note: '已取 B 站官方 AI 总结' };
    } catch (e) {
      if (signal?.aborted) throw abortError(e);
      lastNote = `官方总结失败：${e?.message ?? e}`;
    }
  }
  return { text: '', note: lastNote };
}

/** 热评：无字幕时的内容信号（不是台词，但能看出主题/反应）。 */
async function fetchHotComments({ aid, cookie, limit = 12, signal = null }) {
  if (!aid) return { text: '', note: '' };
  const tries = [
    `https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&pn=1&ps=20&sort=1`,
    `https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&pn=1&ps=20&sort=2`
  ];
  let last = '热评为空';
  for (const ep of tries) {
    try {
      const j = await bilibiliGet(ep, { cookie, signal });
      const list = Array.isArray(j?.data?.replies) ? j.data.replies : [];
      const lines = list
        .map((x) => String(x?.content?.message || '').replace(/\s+/g, ' ').trim())
        .filter((s) => s && s.length >= 3)
        .slice(0, limit);
      if (lines.length) return { text: lines.join(' / ').slice(0, 1200), note: `热评 ${lines.length} 条` };
      last = `热评空（code=${j.code} n=${list.length}）`;
    } catch (e) {
      if (signal?.aborted) throw abortError(e);
      last = `热评失败：${e?.message ?? e}`;
    }
  }
  return { text: '', note: last };
}

/** 封面 → dataURL（有视觉模型时当辅助画面）。 */
async function downloadCoverDataUrl(coverUrl, cookie = '', signal = null) {
  const u0 = String(coverUrl || '').trim();
  if (!u0) return '';
  const u = u0.startsWith('//') ? `https:${u0}` : u0.replace(/^http:/, 'https:');
  throwIfAborted(signal);
  try {
    // ★ 2026-10-17（安全审查）：走 safe-fetch 而不是裸 fetch。
    //   两个原因，都是原来那行 `arrayBuffer()` + 事后比大小的写法给的：
    //   ① `d.pic` 是**远端 JSON 里的字段**，host 由它说了算 —— 裸 fetch 没有内网拦截，
    //      而且还会把 B 站 cookie（SESSDATA）一起发给那个 host；
    //   ② 原来先把整个响应读进内存**再**比 4MB 上限，等于没有上限。
    //   safeFetchBinary 自带 SSRF 校验、逐跳重定向重校验和流式限量。
    const { buffer, contentType } = await safeFetchBinary(u, 4 * 1024 * 1024, {
      timeoutMs: 10000,
      signal,
      headers: {
        referer: 'https://www.bilibili.com/',
        origin: 'https://www.bilibili.com',
        ...(cookie ? { cookie } : {})
      }
    });
    if (!buffer || buffer.length < 100) return '';
    const mime = String(contentType || 'image/jpeg').split(';')[0];
    return `data:${mime.startsWith('image/') ? mime : 'image/jpeg'};base64,${buffer.toString('base64')}`;
  } catch (error) {
    // 取消不许被当成"封面没下到"吞掉（原来任何错都 return ''）
    if (signal?.aborted) throw abortError(error);
    return '';
  }
}

// ── ffmpeg 定位（S07：同步壳不 spawn、异步单飞探测）─────────────────────

let findFfmpegCache = null;

/** PATH 里找 ffmpeg（existsSync 逐目录扫，不启动子进程）。 */
function locateFfmpegOnPath() {
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `ffmpeg${ext}`);
      try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
    }
  }
  return '';
}

/**
 * 找 ffmpeg；没有则返回 ''。顺序与 `media/vision-image.js` 同源：
 * 显式环境变量 → 随包 → 通用自装位置 → PATH。
 * ★ S07：这是**同步兼容壳** —— 不再 spawnSync 探测（探测最长堵 4 秒），PATH 段改为
 *   existsSync 逐目录扫；抽帧前的完整定位走内部 `resolveFfmpeg()`（单飞异步，能验证 PATH 包装脚本）。
 */
export function findFfmpeg() {
  // ★ 2026-10-17（安全审查）：与 `media/vision-image.js` 的同名函数**同一套顺序**
  //   （显式环境变量 → 随包 → PATH → 通用自装位置）。改前这里是另一套：先硬编码绝对路径、
  //   **最后**才找 PATH，而且里面有 `D:\ffmpeg\bin\ffmpeg.exe` —— 那是这台机器的私有布局，
  //   跟着源码分发、却对换台机器的人不成立。同名不同义会让两处行为互相打架，统一到这里。
  //   保留两个通用 Windows 位置是为了不砍"装在固定目录、没进 PATH"的合法本地用法。
  if (findFfmpegCache !== null) return findFfmpegCache;
  const env = String(process.env.FFMPEG_PATH || process.env.FFMPEG || '').trim();
  if (env && fs.existsSync(env)) { findFfmpegCache = env; return env; }
  const exeSuffix = process.platform === 'win32' ? '.exe' : '';
  const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'runtime', 'ffmpeg');
  const candidates = [
    path.join(bundled, 'bin', `ffmpeg${exeSuffix}`),
    path.join(bundled, `ffmpeg${exeSuffix}`),
    `C:\\ffmpeg\\bin\\ffmpeg${exeSuffix}`,
    `C:\\Program Files\\ffmpeg\\bin\\ffmpeg${exeSuffix}`,
    locateFfmpegOnPath()
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) { findFfmpegCache = c; return c; }
    } catch { /* ignore */ }
  }
  findFfmpegCache = '';
  return '';
}

/** 异步探测一个候选能不能跑（`-version` exit 0），超时即杀。 */
function probeBinary(bin, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false;
    let child = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (child && !child.killed) child.kill(); } catch { /* ignore */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      child = spawn(bin, ['-version'], { windowsHide: true, stdio: 'ignore' });
    } catch { finish(false); return; }
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

let resolveFfmpegPromise = null;
let ffmpegResolved = null;

/** 单飞异步探测：同步壳没找到时再对裸名做一次 `-version` 校验（PATH 上有 .cmd 包装等边角情况）。 */
function resolveFfmpeg() {
  if (ffmpegResolved !== null) return Promise.resolve(ffmpegResolved);
  if (!resolveFfmpegPromise) {
    resolveFfmpegPromise = (async () => {
      const sync = findFfmpeg();
      if (sync) { ffmpegResolved = sync; return sync; }
      if (await probeBinary('ffmpeg')) { ffmpegResolved = 'ffmpeg'; return 'ffmpeg'; }
      ffmpegResolved = '';
      return '';
    })().finally(() => { resolveFfmpegPromise = null; });
  }
  return resolveFfmpegPromise;
}

/** 单帧抽取超时（老代码的 25 秒 setTimeout 从不清，会随进程堆着）。 */
const FRAME_CAPTURE_TIMEOUT_MS = 25000;
/** 同时最多跑几个抽帧进程（S07：小并发闸；原来逐帧串行，长视频一眼望不到头）。 */
const FRAME_CAPTURE_MAX_CONCURRENT = 2;

/** 抽一帧：ffmpeg -ss … -frames:v 1 → JPEG bytes；超时/中止/超字节上限都返回 null。 */
function captureFrame(ffmpeg, durl, ss, { signal = null } = {}) {
  return new Promise((resolve) => {
    let chunks = [];
    let size = 0;
    let settled = false;
    let child = null;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const kill = () => { try { if (child && !child.killed) child.kill(); } catch { /* ignore */ } };
    const onAbort = () => { kill(); done(null); };
    const timer = setTimeout(() => { kill(); done(null); }, FRAME_CAPTURE_TIMEOUT_MS);
    if (signal) {
      if (signal.aborted) { done(null); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      child = spawn(ffmpeg, [
        '-ss', String(ss),
        '-i', durl,
        '-frames:v', '1',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-q:v', '5',
        '-'
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { done(null); return; }
    child.stdout.on('data', (c) => {
      // 一帧 JPEG 正常只有几百 KB；`-i` 指到异常源时不设上限就能在 25 秒里灌满内存。
      size += c.length;
      if (size > FRAME_CAPTURE_MAX_BYTES) {
        kill();
        done(null);
        return;
      }
      chunks.push(c);
    });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 && chunks.length ? Buffer.concat(chunks) : null));
  });
}

/**
 * 抽帧：优先 ffmpeg；最多 N 张均匀时刻的 JPEG dataURL。无 ffmpeg / 失败返回 []。
 * @param {AbortSignal} [opts.signal] 调用方取消信号（S07：抽帧子进程会随之被杀）
 */
export async function extractVideoFrames({ bvid, cid, durationSec, cookie = '', maxFrames = 4, signal = null }) {
  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg || !cid || signal?.aborted) return [];
  const qn = Number(process.env.BILI_PLAY_QN) || 16;
  const play = await bilibiliGet(
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=${qn}&fnval=1&platform=html5&high_quality=1`,
    { cookie, signal }
  );
  const durl = play?.data?.durl?.[0]?.url || play?.data?.durl?.[0]?.backup_url?.[0] || '';
  if (!durl) return [];
  // ★ 2026-10-17（安全审查）：durl 是**远端 JSON 里的字段**，而它接下来要当 ffmpeg 的
  //   `-i` 入参 —— ffmpeg 用的是自己那套协议处理器（file: / concat: / subfile: / http:
  //   都认）和自己的网络栈，**完全不经过本进程的 SSRF 校验**。durl 若是
  //   `file:///C:/Users/<u>/.ssh/id_rsa` 或 `http://127.0.0.1:…`，抽帧就等于用本机
  //   权限替远端读了个文件（再把首帧当图片返回）。所以交给 safe-fetch 解析校验一遍：
  //   非 http(s)、或解析到环回/内网/链路本地/云元数据地址，一律不抽。
  //   校验不过只是少抽几帧（本来就是可选增强），不会影响解析主流程。
  try {
    await validateFetchUrl(durl);
  } catch {
    return [];
  }
  const dur = Math.max(5, Number(durationSec) || 60);
  const n = Math.max(1, Math.min(6, Number(maxFrames) || 4));
  // S07：小并发闸（最多 FRAME_CAPTURE_MAX_CONCURRENT 个子进程同时抽），结果按帧序号回位。
  const out = new Array(n).fill('');
  let next = 0;
  const worker = async () => {
    while (!signal?.aborted) {
      const i = next++;
      if (i >= n) return;
      const ss = Math.max(1, Math.round((dur * (i + 0.5)) / n));
      const buf = await captureFrame(ffmpeg, durl, ss, { signal });
      if (buf && buf.length > 500) out[i] = `data:image/jpeg;base64,${buf.toString('base64')}`;
    }
  };
  await Promise.all(Array.from({ length: Math.min(FRAME_CAPTURE_MAX_CONCURRENT, n) }, worker));
  return out.filter(Boolean);
}

/** 从视频页 HTML 里抠 title/desc/tag（API 缺字段时的底层兜底）。 */
async function scrapeVideoPage(bvid, cookie = '', signal = null) {
  const url = `https://www.bilibili.com/video/${bvid}/`;
  throwIfAborted(signal);
  let html;
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        referer: 'https://www.bilibili.com/',
        ...(cookie ? { cookie } : {})
      },
      signal: composeAbortSignal(12000, signal)
    });
    if (!res.ok) throw new Error(`页面 HTTP ${res.status}`);
    html = await res.text();
  } catch (error) {
    if (signal?.aborted) throw abortError(error);
    throw error;
  }
  const out = { title: '', desc: '', tags: [] };
  const t1 = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const t2 = html.match(/"title"\s*:\s*"([^"]{4,160})"/);
  out.title = String(t1?.[1] || t2?.[1] || '').replace(/_哔哩哔哩.*$/, '').trim();
  const d1 = html.match(/"desc"\s*:\s*"([^"]{0,800})"/);
  out.desc = String(d1?.[1] || '').replace(/\\n/g, ' ').replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).trim();
  const tagBlock = html.match(/"tags"\s*:\s*\[([^\]]{0,2000})\]/);
  if (tagBlock) {
    out.tags = [...tagBlock[1].matchAll(/"tag_name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]).filter(Boolean).slice(0, 10);
  }
  if (!out.tags.length) {
    out.tags = [...html.matchAll(/"keyword"\s*:\s*"([^"]{1,20})"/g)].map((m) => m[1]).filter(Boolean).slice(0, 10);
  }
  return out;
}

/**
 * 解析 B 站视频：元信息 + 字幕/弹幕（截断）。
 * @param {object} [opts]
 * @param {number} [opts.maxTranscriptChars=4000]
 * @param {string} [opts.cookie]
 * @param {boolean} [opts.wantCoverDataUrl=false] 显式要一张封面 data URL（转发用 `send_bilibili`；
 *   缺省只在"没字幕"支下载，parse_video 的既有口径不变）。下载失败给空串，由调用方如实降级。
 */
export async function parseBilibiliVideo(inputUrl, { maxTranscriptChars = 4000, cookie = '', wantCoverDataUrl = false, signal = null } = {}) {
  throwIfAborted(signal);
  let url = String(inputUrl || '').trim();
  if (!url) throw new Error('需要 B 站链接');
  // QQ 粘贴常带中文引号/尖括号/尾部句号
  url = url.replace(/^["'“”]+|["'“”。，、）)]+$/g, '').trim();
  if (!/^https?:\/\//i.test(url)) {
    if (/^BV[0-9A-Za-z]{10}$/i.test(url)) url = `https://www.bilibili.com/video/${url}`;
    else if (/^av\d+$/i.test(url)) url = `https://www.bilibili.com/video/${url}`;
    else throw new Error('需要完整 B 站链接或 BV/av 号');
  }
  url = await resolveShortUrl(url, signal);
  const ids = parseBilibiliIds(url);
  if (!ids || (!ids.bvid && !ids.aid)) throw new Error(`无法从链接识别 BV/av：${url}`);

  const qs = ids.bvid
    ? `bvid=${encodeURIComponent(ids.bvid)}`
    : `aid=${encodeURIComponent(ids.aid)}`;
  const view = await bilibiliGet(`https://api.bilibili.com/x/web-interface/view?${qs}`, { cookie, signal });
  if (view.code !== 0) throw new Error(`视频信息失败：${view.code} ${view.message || ''}`);
  const d = view.data || {};
  let title = String(d.title || '').slice(0, 160);
  let owner = String(d.owner?.name || '');
  let desc = String(d.desc || '').replace(/\s+/g, ' ').slice(0, 800);
  let cid = Number(d.cid) || 0;
  const aid = Number(d.aid) || 0;
  const bvid = String(d.bvid || ids.bvid || '');
  let tname = String(d.tname || d.pubarea || '');
  let keywords = (Array.isArray(d.keyword) ? d.keyword : String(d.tag || '').split(/[,，\s]+/))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
  const stat = {
    view: Number(d.stat?.view) || 0,
    like: Number(d.stat?.like) || 0,
    coin: Number(d.stat?.coin) || 0,
    danmaku: Number(d.stat?.danmaku) || 0
  };
  let pages = (Array.isArray(d.pages) ? d.pages : []).slice(0, 12).map((p) => ({
    part: String(p.part || '').slice(0, 80),
    duration: Number(p.duration) || 0
  }));

  // cid 缺失时走 pagelist
  if (!cid) {
    try {
      const pl = await bilibiliGet(`https://api.bilibili.com/x/player/pagelist?${qs}`, { cookie, signal });
      cid = Number(pl?.data?.[0]?.cid) || 0;
    } catch (error) {
      if (signal?.aborted) throw abortError(error); /* ignore other */
    }
  }

  // API 字段空 → 抠页面
  if (!title || !desc || !tname || !keywords.length) {
    try {
      const scraped = await scrapeVideoPage(bvid, cookie, signal);
      if (!title && scraped.title) title = scraped.title.slice(0, 160);
      if (!desc && scraped.desc) desc = scraped.desc.slice(0, 800);
      if (!keywords.length && scraped.tags.length) keywords = scraped.tags;
    } catch (error) {
      if (signal?.aborted) throw abortError(error); /* ignore other */
    }
  }

  let transcript = '';
  let transcriptNote = '';
  let pickedLan = '';
  let danmaku = '';
  try {
    if (cid) {
      const { subs } = await loadSubtitles({ bvid, aid, cid, cookie, signal });
      if (!subs.length) {
        transcriptNote = '没有字幕（可能未开 AI 字幕，或需 B站 cookie）';
      } else {
        const pick = subs.find((s) => /zh|中/i.test(String(s.lan || s.lan_doc || ''))) || subs[0];
        pickedLan = String(pick.lan_doc || pick.lan || '字幕');
        const body = await fetchSubtitleBody(pick.subtitle_url || pick.subUrl || '', cookie, signal);
        transcript = bodyToTranscript(body, maxTranscriptChars);
        if (!transcript) {
          transcriptNote = '字幕存在但内容为空';
        } else {
          // ★ 2026-10-23（溟）：字幕串号守卫。B站 会把整场直播回放的字幕挂到短视频上
          //   （实例 BV1btnA6VE6w：18 秒的片子取到 2712 字 A股复盘，模型照着念错的）。
          //   按"每秒字数"兜底 —— 中文播报一般 4~6 字/秒，超过 9 就明显不是这条片子的台词，丢掉。
          const sec = Number(d.duration) || 0;
          const cps = sec > 0 ? transcript.length / sec : 0;
          if (sec > 0 && cps > 9) {
            transcriptNote = `字幕与时长对不上（${sec} 秒取到 ${transcript.length} 字，约 ${cps.toFixed(1)} 字/秒），已丢弃`;
            transcript = '';
          } else {
            transcriptNote = `已取 ${pickedLan} 约 ${transcript.length} 字`;
          }
        }
      }
    } else {
      transcriptNote = '拿不到 cid，无法取字幕';
    }
  } catch (e) {
    if (signal?.aborted) throw abortError(e);
    transcriptNote = `字幕获取失败：${e?.message ?? e}`;
  }

  // 没字幕时试弹幕
  if (!transcript && cid) {
    try {
      danmaku = await fetchDanmakuSnippets({ cid, cookie, maxChars: 1200, signal });
      if (danmaku) transcriptNote = `${transcriptNote}；另取弹幕约 ${danmaku.length} 字（非台词）`;
    } catch (e) {
      if (signal?.aborted) throw abortError(e);
      transcriptNote = `${transcriptNote}；弹幕也失败：${e?.message ?? e}`;
    }
  }

  // 官方 AI 总结（多要 cookie）+ 热评
  let conclusion = '';
  let conclusionNote = '';
  let comments = '';
  let commentsNote = '';
  let cover = '';
  if (!transcript) {
    const mid = Number(d.owner?.mid) || 0;
    // 先热评（免登录），再官方总结（多要 cookie）
    const c2 = await fetchHotComments({ aid, cookie, limit: 12, signal });
    comments = c2.text;
    commentsNote = c2.note;
    const c1 = await fetchVideoConclusion({ bvid, aid, cid, mid, cookie, signal });
    conclusion = c1.text;
    conclusionNote = c1.note;
    cover = await downloadCoverDataUrl(d.pic || d.cover || '', cookie, signal);
  }
  // ★ #8（E 域 2026-10-18）：转发工具（send_bilibili）要"封面缩略图 + 标题链接"，
  //   但那条支只要 100 字字幕、常有字幕 ⇒ 永远不会进上面的"没字幕"分支拿到封面。
  //   显式要封面时补一张（同样是 safe-fetch 安全下载，4MB 上限）；失败给空串如实降级。
  if (!cover && wantCoverDataUrl) {
    cover = await downloadCoverDataUrl(d.pic || d.cover || '', cookie, signal);
  }

  return {
    ok: true,
    bvid,
    cid,
    aid,
    title,
    owner,
    desc,
    durationSec: Number(d.duration) || 0,
    tname,
    keywords,
    stat,
    pages,
    coverUrl: String(d.pic || d.cover || '').replace(/^http:/, 'https:'),
    cover,
    url: `https://www.bilibili.com/video/${bvid || ''}`,
    transcript,
    danmaku,
    conclusion,
    conclusionNote,
    comments,
    commentsNote,
    transcriptNote,
    pickedLan
  };
}

export function looksLikeBilibili(url) {
  const u = String(url || '');
  return /bilibili\.com\/video|b23\.tv|^BV[0-9A-Za-z]{10}$|^av\d+$/i.test(u);
}

function stripHtml(s) {
  return String(s || '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * B 站视频搜索（search/all/v2 → video 模块）。
 * 无 cookie 也能搜；有 cookie 更稳。
 * @returns {{ query, videos: [{bvid,url,title,author,play,duration,pic,desc}] }}
 */
export async function searchBilibiliVideos(query, { limit = 8, cookie = '', signal = null } = {}) {
  const q = String(query || '').trim();
  if (!q) return { query: '', videos: [] };
  const max = Math.max(1, Math.min(20, Number(limit) || 8));
  const url = `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(q)}&page=1`;
  const j = await bilibiliGet(url, { cookie, signal });
  if (j.code !== 0) throw new Error(`B站搜索失败：${j.code} ${j.message || ''}`);
  const modules = Array.isArray(j?.data?.result) ? j.data.result : [];
  const videoMod = modules.find((m) => m?.result_type === 'video' && Array.isArray(m.data));
  const list = videoMod?.data || [];
  const videos = [];
  for (const it of list) {
    const bvid = String(it.bvid || '').trim();
    if (!bvid) continue;
    videos.push({
      bvid,
      url: `https://www.bilibili.com/video/${bvid}`,
      title: stripHtml(it.title).slice(0, 100),
      author: stripHtml(it.author).slice(0, 40),
      play: Number(it.play) || 0,
      favorites: Number(it.favorites) || 0,
      duration: String(it.duration || '').trim(),
      pic: String(it.pic || '').replace(/^http:/, 'https:'),
      desc: stripHtml(it.description).slice(0, 80),
      tag: stripHtml(it.tag).slice(0, 40)
    });
    if (videos.length >= max) break;
  }
  return { query: q, videos };
}

/** 从 cookie 里抠登录 mid（DedeUserID）。 */
export function midFromCookie(cookie) {
  const m = /(?:^|;\s*)DedeUserID=(\d+)/i.exec(String(cookie || ''));
  return m ? m[1] : '';
}

/**
 * 列出当前登录用户的收藏夹。
 * 需要 cookie（登录后 SESSDATA + DedeUserID）。
 */
export async function listBiliFavFolders({ cookie, signal = null } = {}) {
  const mid = midFromCookie(cookie);
  if (!mid) return { ok: false, error: '需要登录 Cookie（DedeUserID）才能列收藏夹。点设置里「一键登录 B 站」。', folders: [] };
  const j = await bilibiliGet(
    `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}`,
    { cookie, signal }
  );
  if (j.code !== 0) return { ok: false, error: `收藏夹失败：${j.code} ${j.message || ''}`, folders: [] };
  const list = j?.data?.list || [];
  return {
    ok: true,
    mid,
    folders: list.map((f) => ({
      mediaId: String(f.id),
      title: String(f.title || '').slice(0, 40),
      favCount: Number(f.media_count) || 0,
      updated: Number(f.ftime || f.updated_time) || 0
    }))
  };
}

/**
 * 解析「AI 专用收藏夹」：按配置的 mediaId，或按文件夹名（默认「小鲸鱼专用」）。
 * 找不到则返回 null。
 */
export async function resolveBiliFavFolder({ cookie = '', folderName = '', mediaId = '', signal = null } = {}) {
  const name = String(folderName || '').trim();
  const fixedId = String(mediaId || '').trim();
  if (fixedId && /^\d+$/.test(fixedId)) {
    return { ok: true, mediaId: fixedId, title: name || fixedId, from: 'config-id' };
  }
  if (!name) return { ok: false, error: '未配置 B 站收藏夹名/ID', folders: [] };
  const folders = await listBiliFavFolders({ cookie, signal });
  if (!folders.ok) return { ok: false, error: folders.error, folders: [] };
  const hit = folders.folders.find((f) => f.title === name)
    || folders.folders.find((f) => f.title.includes(name))
    || folders.folders.find((f) => name.includes(f.title) && f.title.length >= 2);
  if (!hit) {
    return {
      ok: false,
      error: `没找到收藏夹「${name}」。请在 B 站建好该夹，或在设置里改名字/填 mediaId。可用：${folders.folders.map((f) => f.title).join('、') || '（空）'}`,
      folders: folders.folders
    };
  }
  return { ok: true, mediaId: hit.mediaId, title: hit.title, favCount: hit.favCount, from: 'name' };
}

/**
 * 列出某个收藏夹里的视频。
 * @param {{ mediaId: string, cookie: string, page?: number, pageSize?: number }} opts
 */
export async function listBiliFavVideos({ mediaId, cookie = '', page = 1, pageSize = 12, signal = null } = {}) {
  const id = String(mediaId || '').trim();
  if (!/^\d+$/.test(id)) return { ok: false, error: '需要收藏夹 mediaId（数字）', videos: [] };
  const ps = Math.max(1, Math.min(20, Number(pageSize) || 12));
  const pn = Math.max(1, Number(page) || 1);
  const j = await bilibiliGet(
    `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${id}&pn=${pn}&ps=${ps}&platform=web`,
    { cookie, signal }
  );
  if (j.code !== 0) {
    const needLogin = j.code === -101 || j.code === -403;
    return {
      ok: false,
      error: needLogin
        ? `收藏夹需要登录 Cookie（code=${j.code}）。设置里一键登录 B 站后再试。`
        : `收藏夹失败：${j.code} ${j.message || ''}`,
      videos: []
    };
  }
  const medias = j?.data?.medias || [];
  const videos = [];
  for (const m of medias) {
    // type 2 = 视频
    if (m.type !== 2 && m.type != null) continue;
    const bvid = String(m.bvid || '').trim();
    if (!bvid) continue;
    videos.push({
      bvid,
      url: `https://www.bilibili.com/video/${bvid}`,
      title: String(m.title || '').slice(0, 100),
      author: String(m.upper?.name || '').slice(0, 40),
      cover: String(m.cover || '').replace(/^http:/, 'https:'),
      duration: Number(m.duration) || 0,
      intro: String(m.intro || '').slice(0, 80)
    });
  }
  return {
    ok: true,
    page: pn,
    pageSize: ps,
    total: Number(j?.data?.info?.media_count) || videos.length,
    videos
  };
}
