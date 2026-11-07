// 运行期表情库管理：同步 QQ 收藏表情 + 本地认知层（备注/笔记/使用计数）。
// 纯函数在 stickers.js；这里管缓存、TTL 和 OneBot 交互。
import { OneBotClient } from '../platform/index.js';
import { getConfig, DATA_DIR } from '../../core/config-store/index.js';
import { safeFetchBinary } from '../internet/index.js';
import { isLocalHostUrl } from '../../core/util/index.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadStickerStore, saveStickerStore, mergeStickerLibrary,
  findSticker, formatStickerList, applyStickerNote, markStickerUsed,
  normalizeStickerEntry, nowIso
} from './stickers.js';

const MAX_STICKER_BYTES = 20 * 1024 * 1024; // 单个表情源上限（base64 后本地直传，远小于 QQ 上限）
/** 表情字节磁盘缓存上限（超过就按最久没用删掉）。 */
const STICKER_CACHE_MAX = 500;
/** 缓存文件名可能带的扩展名（落盘时按字节魔数选，找回来时按这个顺序试）。 */
const CACHE_EXTS = ['.gif', '.png', '.jpg', '.webp', '.img'];

/** 字节魔数 → 扩展名（协议端大多按内容识别，扩展名只是让它更省心）。 */
function stickerExt(buf) {
  if (!buf || buf.length < 12) return '.img';
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.toString('ascii', 0, 3) === 'GIF') return '.gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return '.img';
}

/** 表情 id → 安全文件名（id 本身是 `collected_123` / `352…_0_0` 这类，sanitize 只是兜底）。 */
function cacheSafeId(id) {
  return String(id || '').replace(/[^\w.-]/g, '_').slice(0, 80) || 'sticker';
}

/**
 * 校验下载内容确实是常见图片格式（防 QQ 返回"过期占位图/HTML 错误页"也被当成图发出去）。
 * ★ 2026-10-26 export：收图入字节缓存（orchestrator 的 prefetchImageBytesForIncoming）
 *   与表情发送走同一个魔数校验 —— "缓存里只许有真图"这条规矩两边共用一份实现。
 */
export function looksLikeImage(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return true; // GIF
  // ⚠️ WEBP 的判定必须取 8..12（4 个字符）再和 'WEBP' 比。
  //    曾经写成 toString('ascii', 8, 4) —— end 比 start 还小，Node 直接返回空字符串，
  //    于是所有 webp 表情都被当成"不是图片"拒发（QQ 收藏表情里 webp 占相当一部分）。
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return true; // WEBP
  return false;
}

function errText(err) {
  return String(err?.message ?? err).slice(0, 160);
}

/**
 * 本地表情图片目录：只允许这里的 file:// 地址被读成文件。
 * （2026-09-22：为了跑 0.4 的 reverse-image 技能 —— 它要拿本地文件转 dataURL 去反查图片。）
 */
export function stickerImagesDir() {
  return path.join(DATA_DIR, 'sticker-images');
}

/**
 * ★ 2026-10-26（识图修复）：读收图字节缓存。
 * 收图瞬间（orchestrator.prefetchImageBytesForIncoming）抓下的原图字节落在这里，
 * 文件是 `incoming_<mid>_<序号>.json`（元数据：url 等）+ `incoming_<mid>_<序号>.img`（字节）。
 * QQ 的图 URL 是短命资源（rkey 过期 / 商城表情发出时即 404），等模型想看时再下载
 * 经常已经死链 —— 读缓存就不再受 URL 寿命约束。
 * @param {string} mid 消息 id（证据条目的 id，与收图侧同一取值）
 * @param {string} [url] 可选：按 URL 精确匹配；不传返回第 0 张
 * @returns {{ buf, file } | null} 没命中返回 null
 */
export function readIncomingImageCache(mid, url = '') {
  const dir = stickerCacheDir();
  const safeMid = cacheSafeId(mid);
  if (!safeMid || safeMid === 'sticker') return null;
  const wantUrl = String(url ?? '').trim();
  try {
    if (wantUrl) {
      // 精确匹配：先读 meta 拿 URL，命中才给字节。
      for (let idx = 0; idx < 24; idx += 1) {
        const imgFile = path.join(dir, `incoming_${safeMid}_${idx}.img`);
        if (!fs.existsSync(imgFile)) break;                 // 序号连续落盘，断档即到头
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(dir, `incoming_${safeMid}_${idx}.json`), 'utf8'));
          if (String(meta?.url ?? '') === wantUrl && looksLikeImage(fs.readFileSync(imgFile))) {
            return { buf: fs.readFileSync(imgFile), file: imgFile };
          }
        } catch { /* 这张坏了看下一张 */ }
      }
      return null;
    }
    const first = path.join(dir, `incoming_${safeMid}_0.img`);
    if (!fs.existsSync(first)) return null;
    const buf = fs.readFileSync(first);
    if (!looksLikeImage(buf)) return null;
    return { buf, file: first };
  } catch { return null; }
}

/**
 * 表情**字节**缓存目录（和表情图源目录分开，不会被 localStickerPath 当成"用户图"）。
 *
 * 为什么要缓存字节（2026-09-22 用户反馈「有的表情能发出来，有的发不出来」）：
 *   · QQ 收藏表情给的是一小时就过期的 rkey 链接 —— 同一批表情里，
 *     刚同步过的能发，前几天同步下来的就发不出（403/占位图），表现就是"有的行有的不行"；
 *   · 每次发送都要重新下载几 MB，网络一抖这张就失败；
 *   · 同机协议端可以直接读文件当载荷，请求体几百字节，多大都不会被 RESET。
 * 存过一次之后，① 链接过期也照发；② 发出去的是同一份字节，群里看到的就是库里的那张。
 */
export function stickerCacheDir() {
  return path.join(stickerImagesDir(), 'cache');
}

/**
 * `file:///…` → 绝对路径，**只允许**落在 stickerImagesDir 内的真实文件，其余一律 null。
 *
 * 为什么必须校验目录：这个函数会被技能拿到的"用户可控字符串"调用（收藏表情的 url 字段
 * 理论上可以被配置/存档改写），不校验就等于给了一个"任意本地文件读取 → 转成 dataURL 发到
 * 第三方反查站"的通道。规则与 0.4 版一致：不在目录内、不是文件、解析失败都返回 null。
 */
export function localStickerPath(raw) {
  const value = String(raw ?? '').trim();
  if (!value.toLowerCase().startsWith('file:///')) return null;
  let pathname;
  try { pathname = decodeURIComponent(new URL(value).pathname); } catch { return null; }
  // file:///C:/... 在 Windows 上 pathname 前面会多一个斜杠
  if (/^\/[A-Za-z]:[\\/]/.test(pathname)) pathname = pathname.slice(1);
  const root = path.resolve(stickerImagesDir()) + path.sep;
  const full = path.resolve(pathname);
  if (!full.toLowerCase().startsWith(root.toLowerCase())) return null;
  try {
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  } catch { return null; }
  return full;
}

export class StickerManager {
  constructor(onebot) {
    this.onebot = onebot;
    this.entries = loadStickerStore();
    this.syncedAt = 0;
    this.syncing = null;
    this.collectTimes = [];
    this.cachePrunedAt = 0;
  }

  // ── 表情字节磁盘缓存（见 stickerCacheDir 的说明）──────────────────────

  /** 命中缓存则返回 {file, buf}；没有/读坏了返回 null。 */
  #cacheHit(entry) {
    if (!entry?.id) return null;
    const base = path.join(stickerCacheDir(), cacheSafeId(entry.id));
    for (const ext of CACHE_EXTS) {
      const file = `${base}${ext}`;
      try {
        if (!fs.existsSync(file)) continue;
        const buf = fs.readFileSync(file);
        if (looksLikeImage(buf)) return { file, buf };
      } catch { /* 读不了就当下没有 */ }
    }
    return null;
  }

  /** 把字节写进缓存，返回文件绝对路径（失败返回 null，调用方退回 base64）。 */
  #cachePut(entry, buf) {
    if (!entry?.id || !buf?.length || !looksLikeImage(buf)) return null;
    try {
      const dir = stickerCacheDir();
      const file = path.join(dir, cacheSafeId(entry.id) + stickerExt(buf));
      // 已经在缓存里（且大小一致）就别重写：这是发送热路径，一张动图好几 MB，
      // 每次都覆写等于白烧磁盘 IO。
      try {
        if (fs.statSync(file).size === buf.length) return file;
      } catch { /* 不存在 → 下面写 */ }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, buf);
      this.#pruneCache();
      return file;
    } catch {
      return null;
    }
  }

  /** 缓存超过上限时按"最久没动过"删除（每小时最多算一次，别在发送路径上反复扫目录）。 */
  #pruneCache() {
    const now = Date.now();
    if (this.cachePrunedAt && now - this.cachePrunedAt < 3600000) return;
    this.cachePrunedAt = now;
    try {
      const dir = stickerCacheDir();
      const files = [];
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        try { files.push({ full, mtime: fs.statSync(full).mtimeMs }); } catch { /* ignore */ }
      }
      if (files.length <= STICKER_CACHE_MAX) return;
      files.sort((a, b) => b.mtime - a.mtime);
      for (const f of files.slice(STICKER_CACHE_MAX)) {
        try { fs.unlinkSync(f.full); } catch { /* ignore */ }
      }
    } catch { /* 清理失败不影响发送 */ }
  }

  get enabled() {
    return getConfig().sticker?.enabled !== false;
  }

  /** 同步 QQ 收藏表情（带 TTL 缓存；force 立即刷新）。失败时退回本地缓存。 */
  async sync(force = false) {
    if (!this.enabled) return { entries: this.entries, fromCache: true, disabled: true };
    const ttl = 60000;
    const now = Date.now();
    if (!force && this.syncedAt && now - this.syncedAt < ttl) {
      return { entries: this.entries, fromCache: true };
    }
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        const count = Math.min(500, Math.max(1, Number(getConfig().sticker?.promptMaxStickers) * 10 || 100));
        const data = await this.onebot.call('fetch_custom_face_detail', { count });
        const fetched = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
        if (!fetched) throw new Error('fetch_custom_face_detail 返回 data 不是数组');
        // 只有拿到合法数组才合并，避免异常响应清空本地库
        this.entries = mergeStickerLibrary(this.entries, fetched);
        this.syncedAt = Date.now();
        saveStickerStore(this.entries);
        return { entries: this.entries, fromCache: false };
      } catch (error) {
        // 同步失败不致命：本地缓存继续用
        return { entries: this.entries, fromCache: true, error: String(error?.message ?? error) };
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  async list(query = '', limit = 48, force = false) {
    const synced = await this.sync(force);
    return formatStickerList(synced.entries, query, limit, { includeBroken: false });
  }

  async find(ref) {
    const synced = await this.sync(false);
    return findSticker(synced.entries, ref);
  }

  note(id, patch) {
    const result = applyStickerNote(this.entries, id, patch);
    this.entries = result.entries;
    if (result.entry) saveStickerStore(this.entries);
    return result.entry;
  }

  markUsed(id, context = '') {
    const result = markStickerUsed(this.entries, id, context);
    this.entries = result.entries;
    if (result.entry) saveStickerStore(this.entries);
    return result.entry;
  }

  /**
   * 图源失效（404/过期/发送失败）：直接从库里删除。
   * 返回被删条目，找不到则 null。
   */
  markBroken(id, reason = '') {
    const idx = this.entries.findIndex((e) => e && e.id === id);
    if (idx < 0) return null;
    const cur = this.entries[idx];
    // ⚠️ 2026-09-27：原来是 `entries.splice(idx,1)` —— 链接过期 + 有人试过一次 = 整条收藏被删，
    //   而且不报告。实测今晚（约 5 分钟内）库就从 95 掉到 92，管理员看到的现象是
    //   "我自己收藏的表情包基本全过期了"。QQ 的 rkey 本来就会过期，字节抓下来之前
    //   删掉等于把收藏扔了。现在改成**标记失效**：清单不再下发它（buildStickerContext
    //   默认过滤 broken），但条目和备注留着，刷新到新地址时 markAlive 会把它救回来。
    const entry = normalizeStickerEntry({
      ...cur,
      broken: true,
      brokenAt: Date.now(),
      brokenReason: String(reason || 'expired').slice(0, 80)
    });
    this.entries[idx] = entry;
    saveStickerStore(this.entries);
    try {
      console.log(`[sticker] 已标记表情失效 ${id}（${String(reason || 'expired').slice(0, 60)}）— 条目保留，可随新图源恢复`);
    } catch { /* ignore */ }
    return entry;
  }

  /** 刷新到新图源后清除失效标记。 */
  markAlive(id) {
    const idx = this.entries.findIndex((e) => e && e.id === id);
    if (idx < 0) return null;
    const cur = this.entries[idx];
    if (!cur.broken && !cur.brokenAt && !cur.brokenReason) return cur;
    const entry = normalizeStickerEntry({
      ...cur,
      broken: false,
      brokenAt: 0,
      brokenReason: '',
      updatedAt: nowIso()
    });
    this.entries[idx] = entry;
    saveStickerStore(this.entries);
    return entry;
  }

  /** 没有备注/描述的表情（这些在提示词里没法被判断，等于永远用不上）。 */
  unlabeled() {
    return this.entries.filter((e) => e && !String(e.localNote || '').trim() && !String(e.desc || '').trim());
  }

  /** 发送失败时挑一张还活着的备胎：优先有备注、近期少用。 */
  pickFallback(excludeId = '') {
    const live = this.entries.filter((e) => e && !e.broken && e.url && e.id !== excludeId);
    if (!live.length) return null;
    const labeled = live.filter((e) => e.desc || e.localNote || (e.tags || []).length);
    const pool = labeled.length ? labeled : live;
    pool.sort((a, b) => (Number(a.lastUsedAt) || 0) - (Number(b.lastUsedAt) || 0)
      || (Number(a.useCount) || 0) - (Number(b.useCount) || 0));
    // 在最久未用的前 12 张里随机一张
    const top = pool.slice(0, Math.min(12, pool.length));
    return top[Math.floor(Math.random() * top.length)] || pool[0];
  }

  /**
   * 给"没备注"的表情批量补一句描述（用当前聊天模型看图写）。
   *
   * 为什么要批量做：表情库里实测有 56/125 张既没有 QQ 描述也没有本地笔记，
   * 提示词里它们连一行都占不到（无从判断该不该发），于是永远是那几张熟脸在轮。
   * 交给模型在聊天里顺手补是不现实的（它很少主动调 sticker_note），
   * 所以给管理员一个按钮，一次性补齐（一张图约 ¥0.001，几十张也就几分钱）。
   */
  async annotateMissing({ limit = 60, onlyMissing = true, emit = () => {}, onProgress = null } = {}) {
    const { chatCompletion } = await import('../llm/index.js');
    // 设置页可能比首次表情库同步先打开；不能只看构造时的本地快照。
    await this.sync(false);
    // 备注会长期影响表情检索；不再让容易误读动作/水印的 Jev 小视觉模型写入持久备注。
    // 只用当前主视觉模型。该任务在后台跑，不增加聊天首字延迟。
    const targets = (onlyMissing
      ? this.unlabeled().filter((entry) => entry?.source !== 'manual' && entry?.noteSource !== 'manual')
      : this.entries.filter((entry) => entry?.source !== 'manual' && entry?.noteSource !== 'manual'))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 60)));
    emit('sticker-annotate', { phase: 'start', total: targets.length, engine: 'primary-vision' });
    const done = [];
    const failed = [];
    for (const entry of targets) {
        try {
          const buffer = await this.resolveStickerBytes(entry);
          const { toVisionDataUrls, detectImageMime } = await import('./vision-image.js');
          const mime = detectImageMime(buffer)
            || (buffer[0] === 0x89 ? 'image/png'
              : (buffer[0] === 0xff ? 'image/jpeg'
                : (buffer.toString('ascii', 0, 3) === 'GIF' ? 'image/gif' : 'image/webp')));
          // 归一成接口能吃的格式（GIF 抽帧转 PNG、webp 尽量转 JPEG）。
          // 转不动就跳过：硬发会触发降级剥图，模型凭空"描述"没看到的图更糟。
          const prepared = await toVisionDataUrls(buffer, { mime, maxFrames: 4 });
          if (prepared.skipped || !prepared.dataUrls.length) {
            const error = `${mime} 当前模型看不了，已跳过`;
            failed.push({ id: entry.id, error });
            emit('sticker-annotate', { phase: 'progress', done: done.length, failed: failed.length, total: targets.length, id: entry.id, error });
            if (typeof onProgress === 'function') onProgress(done.length + failed.length, targets.length);
            continue;
          }
          const askVision = { messages: [
            {
              role: 'system',
              content: [
                '你负责给 QQ 表情包写准确、可检索的本地备注。只输出一行，格式：画面/动作：…；图中文字：…；用途：…。',
                '先描述真正看见的主体、姿势/手势和表情，再摘录清晰可读的梗字；不要只抄字而漏掉画面。',
                '动作必须按手和身体的可见姿势判断，辨清伸出的是哪根手指。竖中指是中指伸出，不能因手靠近脸就说成捂嘴；看不清就写“动作不确定”，不要猜。',
                '气泡字、标语等图中文字与水印、logo、账号名分开处理。水印只当作水印，不能据此推断人物、作品、作者、动作或剧情；不清楚的字写“看不清”。',
                '备注要短而具体，最多 70 个汉字；不要画风评价、客套话、出处猜测或额外解释。'
              ].join('\n')
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: '请看完整画面。若是动图，结合这些抽取帧判断动作；不要把水印当成情节：' },
                ...prepared.dataUrls.map((url) => ({ type: 'image_url', image_url: { url } }))
              ]
            }
          ], temperature: 0.1 };
          const res = await chatCompletion({
            ...askVision,
            overrides: { maxTokens: 150, disableThinking: true, timeoutMs: 30000 }
          });
          const note = String(res?.message?.content ?? '')
            .replace(/[\r\n]+/g, ' ')
            .replace(/^["'「『]+|["'」』]+$/g, '')
            .trim()
            .slice(0, 100);
          if (!note) throw new Error('模型没写出描述');
          const updated = this.note(entry.id, { note, noteSource: 'ai' });
          if (!updated) throw new Error('表情已不在本地库中，备注没有保存');
          done.push({ id: entry.id, note: updated.localNote });
          emit('sticker-annotate', { phase: 'progress', done: done.length, total: targets.length, id: entry.id, note: updated.localNote });
        } catch (error) {
          failed.push({ id: entry.id, error: errText(error) });
          emit('sticker-annotate', { phase: 'progress', done: done.length, failed: failed.length, total: targets.length, id: entry.id, error: errText(error) });
        }
        if (typeof onProgress === 'function') onProgress(done.length + failed.length, targets.length);
      }
    return { total: targets.length, done, failed, engine: done.length ? 'primary-vision' : 'none' };
  }

  /** 收藏一条消息里的图片（本地新增条目，不入 QQ 收藏）。 */
  collect(messageId, { url, note = '' } = {}) {
    if (!getConfig().sticker?.collectEnabled) throw new Error('收藏表情功能未开启');
    note = String(note || '').trim();
    if (!note) throw new Error('收藏表情时必须写一句备注');
    // 限频
    const now = Date.now();
    this.collectTimes = this.collectTimes.filter((t) => now - t < 3600000);
    if (this.collectTimes.length >= Math.max(1, Number(getConfig().sticker?.maxCollectPerHour) || 10)) {
      throw new Error('收藏太频繁了，一小时后再试');
    }
    url = String(url || '');
    if (!url) throw new Error('该消息没有可收藏的图片地址');
    const id = `collected_${messageId}`;
    const existing = this.entries.find((e) => e.id === id);
    if (existing) {
      return this.note(id, { note: String(note || '') });
    }
    const entry = {
      id,
      resId: id,
      url,
      md5: '',
      desc: String(note || '').slice(0, 20),
      localNote: String(note || ''),
      noteSource: 'ai',
      tags: [],
      usage: '',
      source: 'ai',
      useCount: 0,
      lastUsedAt: 0,
      lastContext: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.entries.push(entry);
    this.collectTimes.push(now);
    saveStickerStore(this.entries);
    // ⚠️ 2026-09-26：这里以前只存 QQ 的 rkey 链接，而 rkey 几小时到几天就过期。
    //   本地字节缓存原本是"发送/看图成功之后"才补写的，于是**收藏完一次都没用过**的表情
    //   永远等不到落盘，链接一过期就死；而 markBroken 是**直接删条目**，库就这么悄悄缩水。
    //   实测：38 张自收藏里 33 张链接已 400，其中 9 张连字节都没有（8 张 useCount=0），
    //   库从 125 张掉到 95 张。所以收藏的当下就抓一次字节落盘。
    this.#warmCache(entry);
    return entry;
  }

  /**
   * 收藏后立刻把字节抓到本地缓存（后台，不阻塞收藏结果）。
   * 抓不到就算了：首次发送/看图成功时 resolveStickerBytes 还会补写一次。
   */
  #warmCache(entry) {
    const url = String(entry?.url || '');
    if (!url || !entry?.id) return;
    if (this.#cacheHit(entry)) return;
    this.fetchImageBytes(url)
      .then((buf) => { this.#cachePut(entry, buf); })
      .catch(() => { /* 链接已经死了或网络抖动：不影响收藏本身 */ });
  }

  // ── 表情图片字节：下载 → 校验 →（链接失效时）刷新 → 重试 ──────────────
  //
  // 背景：直接让 OneBot 端按 image URL 下载再上传不可靠 —— QQ 给的表情/图片
  // 链接（multimedia.nt.qq.com.cn 的 rkey 链接、p.qpic.cn 表情图）对匿名
  // HTTP 请求经常 400/过期/返回占位图，OneBot 端取不到就报 "HTTP download
  // failed: 400"，取到占位图就发成"白图"。改成由本进程先下载并校验字节，
  // 再以 base64:// 直传给 OneBot 本地上传：字节是真的，就一定能正常显示。

  /** 下载一张图并校验是有效图片；失败抛中文错误。 */
  async fetchImageBytes(url, maxBytes = MAX_STICKER_BYTES) {
    const u = String(url || '').trim();
    if (!u) throw new Error('该表情没有图片地址');
    // ★ 2026-10-26（溟）：`file:///` 是本机已有的表情字节，不该走网络。
    //   原来这里一律交给 safeFetchBinary（只收 http/https），于是本地表情一律抛
    //   「图源不可用（原始错误：仅允许 http/https）」——库里明明有图，表现却是"发不出去"。
    //   路线：localStickerPath 已经做完了全部校验（只允许 stickerImagesDir 内的真实文件），
    //   这里只负责读出字节并复用同一套 looksLikeImage 校验。
    if (u.toLowerCase().startsWith('file:///')) {
      const local = localStickerPath(u);
      if (!local) throw new Error('本地表情不在允许目录内或文件不存在');
      const buf = fs.readFileSync(local);
      if (!buf || !buf.length) throw new Error('本地表情文件为空');
      if (!looksLikeImage(buf)) throw new Error('本地表情不是有效图片');
      if (maxBytes && buf.length > maxBytes) throw new Error('本地表情超过大小上限');
      return buf;
    }
    let lastErr = null;
    // 网络抖动重试 2 次
    for (let i = 0; i < 3; i++) {
      try {
        const { buffer } = await safeFetchBinary(u, maxBytes);
        if (!buffer || !buffer.length) throw new Error('图片内容为空');
        if (!looksLikeImage(buffer)) throw new Error('下载内容不是有效图片（可能是过期/占位图）');
        return buffer;
      } catch (error) {
        lastErr = error;
        if (i < 2) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
    throw lastErr || new Error('图片下载失败');
  }

  /** collected_xxx 的 id 里藏着来源消息 id（QQ 消息 id，可能是负数）。 */
  srcMessageId(entry) {
    const m = /^collected_(-?\d+)$/.exec(String(entry?.id || ''));
    return m ? Number(m[1]) : null;
  }

  #replaceEntry(entry) {
    const idx = this.entries.findIndex((e) => e && e.id === entry?.id);
    if (idx < 0) return entry;
    this.entries[idx] = entry;
    saveStickerStore(this.entries);
    return entry;
  }

  /**
   * 链接失效时尝试换一张"新鲜"的图源地址并落库：
   *   1. collected_*（收藏自聊天里的图）：QQ 媒体 rkey 链接会过期，但 OneBot
   *      端 get_msg 能基于本地媒体库把该消息重新解析出带新 rkey 的可用链接。
   *      （SnowLuma 偶发返回旧链接，隔一小段时间重试一次能拿到新链接。）
   *   2. qq 收藏表情：强制重新拉取收藏列表，用服务端返回的最新 url 覆盖。
   * 返回可能更新过的 entry（拿不到新地址则原样返回）。
   */
  async refreshEntryImage(entry) {
    if (!entry || !entry.id) return entry;
    const apply = (url) => {
      const u = String(url || '').trim();
      if (!u || u === entry.url) return entry;
      return this.#replaceEntry(normalizeStickerEntry({ ...entry, url: u, updatedAt: nowIso() }));
    };
    // 1) 收藏图：用来源消息 id 重新解析（消息 id 找不到/无图则跳过）
    const mid = this.srcMessageId(entry);
    if (mid !== null) {
      for (let attempt = 0; attempt < 3; attempt++) {
        let applied = null;
        try {
          const msg = await this.onebot.getMsg(mid);
          const segs = Array.isArray(msg?.message) ? msg.message : [];
          const img = segs.find((s) => s?.type === 'image');
          const fresh = String(img?.data?.url || img?.data?.file || '').trim();
          if (fresh && fresh !== entry.url) applied = apply(fresh);
        } catch { /* 消息不存在/已过期 → 继续尝试 */ }
        if (applied && applied.url !== entry.url) return applied;
        // SnowLuma 偶发仍返回旧链接：稍等再试一次，往往能拿到新 rkey 的链接
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    // 2) 收藏表情/兜底：强制同步一次收藏列表，用服务端新地址覆盖
    try {
      const synced = await this.sync(true);
      const freshEntry = findSticker(synced.entries, entry.id, { fuzzy: false });
      if (freshEntry?.url && freshEntry.url !== entry.url) return apply(freshEntry.url);
    } catch { /* 同步失败不致命 */ }
    return entry;
  }

  /**
   * 拿到一个表情的真实图片字节（发送/看图前调用）。
   * 优先用本地存的 url；失败（过期/400/占位图）就 refreshEntryImage 换新地址重试一次。
   */
  async resolveStickerBytes(sticker) {
    const entry = sticker?.id ? this.entries.find((e) => e && e.id === sticker.id) || sticker : sticker;
    // ① 先看字节缓存：存过一次的表情，链接过期 / 图源被删都照样能发（也是"有的能发有的不能"的根治）
    const cached = this.#cacheHit(entry);
    if (cached) return cached.buf;
    let lastErr = null;
    // 图源"确实没了"的判据：QQ 的临时链接过期后会回 400/401/403/404，或者干脆给一张占位图。
    // ⚠️ 2026-09-22：原来只认 404/400 —— 过期 rkey 常回 403，于是它既不被标失效、
    //   也不会被当成"图源过期"，用户看到的就是"反复发不出去"。
    const isGone = (err) => /40[0134]|403|forbidden|expired|rkey|not\s*found|过期|占位|不是有效图片/i.test(String(err?.message ?? err ?? ''));
    if (entry?.url) {
      try {
        const buf = await this.fetchImageBytes(entry.url);
        if (entry?.id) {
          this.markAlive(entry.id);
          this.#cachePut(entry, buf);   // 存下来：下次链接过期也不影响发送
        }
        return buf;
      } catch (error) {
        lastErr = error;
      }
    }
    try {
      const refreshed = await this.refreshEntryImage(entry);
      if (refreshed?.url && refreshed.url !== entry?.url) {
        const buf = await this.fetchImageBytes(refreshed.url);
        if (refreshed?.id) {
          this.markAlive(refreshed.id);
          this.#cachePut(refreshed, buf);
        }
        return buf;
      }
      lastErr = lastErr || new Error('刷新后仍无新图源');
    } catch (error) {
      lastErr = error;
    }
    // 网络抖动不标记；明确 401/403/404/过期/非图片 → 记失效，避免反复推荐
    const gone = isGone(lastErr) || !entry?.url;
    if (entry?.id && gone) {
      this.markBroken(entry.id, errText(lastErr) || 'no url');
    }
    // ⚠️ 2026-09-22：错误文案要**说清是哪一类问题**，并且**不能把锅甩给"网络"**。
    //   上一版写的是"多半是网络/代理抓 QQ 图源失败" —— 模型照着念，群里就变成
    //   "她说网断了发不出来"，用户以为是自己家网络坏了（实测反馈正是这句）。
    //   现在按具体原因分类，并明确告诉模型：这是图源问题，不是网络问题，别这么对外解释。
    const label = String(entry?.localNote || entry?.desc || entry?.id || '该表情').slice(0, 24);
    const whyRaw = errText(lastErr) || '无可用图片地址';
    let kind = '图源不可用';
    if (!entry?.url) kind = '这张表情没有图片地址（记录里是空的）';
    else if (/40[13]|forbidden|expired|rkey|过期/i.test(whyRaw)) kind = 'QQ 的临时图片链接已过期（rkey 约 1 小时有效）';
    else if (/404|not\s*found/i.test(whyRaw)) kind = '图源已被删除或链接失效';
    else if (/不是有效图片|占位/i.test(whyRaw)) kind = '图源返回的不是图片（多半是过期占位图）';
    else if (/timeout|超时|abort/i.test(whyRaw)) kind = '取图超时（图片服务器没在 25 秒内返回）';
    else if (/ECONN|fetch failed|ENOTFOUND|socket/i.test(whyRaw)) kind = '连接图片服务器失败';
    const marked = entry?.id && gone ? '已自动标为失效，不会再被推荐。' : '这次没标记失效（可能只是临时故障），下次还会重试。';
    throw new Error(
      `表情「${label}」发不出去：${kind}（原始错误：${whyRaw}）。${marked}`
      + ' 换一张：list_stickers 换个词搜，或让群友重发这张图后再收藏。'
      + '【给模型的提醒】这是**表情图源**的问题，不是网络/程序故障；不要跟群友说"网断了"。'
    );
  }

  /**
   * 表情字节 → 发给协议端的载荷。
   *
   * 同机协议端（httpUrl 是 127.0.0.1/localhost）：返回**本地文件路径** ——
   *   协议端自己读文件，HTTP 请求体只有几百字节，图多大都不会被 RESET，
   *   而且用的就是缓存里那份字节（跟群里看到的完全一致）。
   * 跨机协议端：只能内联 base64（路径对端读不到），由 sender 那边按大小兜底。
   *
   * @param {object} sticker 表情条目
   * @param {{form?: 'auto'|'file'|'base64'}} [opts] form 用于"换个形态再试一次"
   */
  async stickerPayload(sticker, { form = 'auto' } = {}) {
    const buffer = await this.resolveStickerBytes(sticker);
    const entry = sticker?.id ? this.entries.find((e) => e && e.id === sticker.id) || sticker : sticker;
    if (form !== 'base64' && isLocalHostUrl(this.onebot?.httpUrl)) {
      const file = this.#cachePut(entry, buffer) || this.#cacheHit(entry)?.file;
      if (file) return file;
    }
    return `base64://${buffer.toString('base64')}`;
  }
}
