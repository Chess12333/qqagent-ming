// 发送队列：所有对 QQ 的出站消息都经过这里。
// - 每会话串行（sendChain），真人化间隔（随机区间 + 按字数附加）
// - 分钟/小时限频（超限直接拒绝，工具会把错误告诉模型）
// - Markdown → 纯文本、QQ 硬长度切分、CQ 转义
// - 发出的每一条记进 ChatStore（self=true，供下一次运行当"自己的发言"）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { getConfig, DEFAULT_CONFIG, DATA_DIR } from '../../core/config-store/index.js';
import { sleep, randInt, createSendChain, escapeCqText, formatClockTime, isLocalHostUrl } from '../../core/util/index.js';
import { mdToPlain, splitForQQ } from '../../core/util/index.js';
import { isHypeMode } from '../emotion/index.js';
import { msgRef, normalizeRef } from '../memory/index.js';
import { skillManager } from '../extensions/index.js';

// 限频回退值统一取自 DEFAULT_CONFIG，杜绝"代码默认 80 / 回退值 8 / UI 回退 8"三处打架。
const DEFAULT_MAX_PER_MINUTE = DEFAULT_CONFIG.send.maxPerMinute;
const DEFAULT_MAX_PER_HOUR = DEFAULT_CONFIG.send.maxPerHour;

/**
 * base64 载荷超过这个字节数就别再塞 HTTP body 了。
 *
 * 2026-09-22 实测（协议端 SnowLuma :3010）：
 *   请求体 3.17MB → 连接被直接 RESET（应用侧看到 `read ECONNRESET`）
 *   请求体 1.6MB → 正常受理
 *   同一张 2.3MB 的图改成本地路径 → 请求体几百字节 → 正常受理
 * 所以这里卡在 2MB（base64 字符数 ≈ 字节数 × 4/3，2MB 字符 ≈ 1.5MB 原始字节），
 * 留足余量又不至于把正常的网图都落盘。
 */
const INLINE_BASE64_LIMIT = 2 * 1024 * 1024;
/** 不落盘时能安全塞进请求体的上限（超过它 base64 会顶爆协议端，见下面 spillIfTooLarge 的实测）。 */
const INLINE_BASE64_HARD_LIMIT = 8 * 1024 * 1024;

/** 老树 send.splitLongAt：按中文句读符号做软拆分，最多保留 4 段。 */
function splitLongMessages(messages, limit) {
  const split = [];
  for (const value of messages) {
    const text = String(value ?? '');
    if (text.length <= limit) { split.push(text); continue; }
    const parts = text.split(/(?<=[。！？；!?;])/).map((item) => item.trim()).filter(Boolean);
    let buffer = '';
    for (const part of parts) {
      if (buffer && (buffer + part).length > limit) { split.push(buffer); buffer = ''; }
      buffer = buffer ? buffer + part : part;
      while (buffer.length > limit) {
        split.push(buffer.slice(0, limit));
        buffer = buffer.slice(limit);
      }
    }
    if (buffer) split.push(buffer);
  }
  return split.slice(0, 4);
}

/** 从字节魔数猜扩展名（OneBot/QQ 按内容识别，扩展名只是兜底）。 */
function guessExt(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.length > 3 && buf[0] === 0x47 && buf[1] === 0x49) return '.gif';
  if (buf.length > 12 && buf[8] === 0x57 && buf[9] === 0x45) return '.webp';
  return '.img';
}

/**
 * 协议端与我们**共用同一套文件系统**吗？
 *
 * 2026-11-09：原来用 isLocalHostUrl(onebotUrl) 推断「同机」，然后落盘传路径。
 * 但 OneBot 常常跑在容器里：URL 是 127.0.0.1，文件系统却是另一套——
 * 路径发过去对面读不到，用户看到的是「文件路径对不上」。
 * 所以改成显式开关，默认**不共享**（宁可内联 base64，也不发一个对面读不到的路径）。
 */
function onebotSharesFs() {
  const value = String(process.env.MING_ONEBOT_SHARED_FS || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/** 协议端是不是同机**且**共用文件系统（只有这时才敢传本地路径）。 */
function isLocalOnebot(onebotUrl) {
  return onebotSharesFs() && isLocalHostUrl(onebotUrl);
}

/**
 * 把过大的 base64 载荷落到临时文件，换成路径再发。
 *
 * 为什么必须这么做：base64 是把整个图片字节塞进 HTTP 请求体，图一大就顶到协议端的处理上限
 * 并被直接 RESET —— 用户看到的是「发送失败：OneBot 网络错误: read ECONNRESET」，
 * 完全看不出是"图太大"。同机协议端读得到路径，塞字节反而是最脆的方式。
 * 跨机（协议端不在本机）时给不了路径，只能原样返回，让调用方拿到协议端的原始报错。
 *
 * @param {string} payload
 * @param {string} onebotUrl
 * @param {{force?: boolean}} [opts] force=true 时不看大小一律落盘（表情包走这条：
 *   表情动不动 2~8MB，内联 base64 必然顶爆）
 *
 * ⚠️ 落盘文件是**一次性**的：协议端在这一轮里读完就当垃圾，但没有任何一方会回收它们，
 *   所以这里每次落盘前先 pruneSpillDir 删掉过期文件（见该函数注释）。原注释里
 *   "落盘后的文件还能被下一次复用"与实现不符（全仓再无第二处读这个目录），已删。
 */
function spillIfTooLarge(payload, onebotUrl, { force = false } = {}) {
  const text = String(payload || '');
  if (!/^base64:\/\//i.test(text)) return text;
  const b64 = text.slice('base64://'.length);
  if (!force && b64.length <= INLINE_BASE64_LIMIT) return text;
  // 不同机 / 不共享文件系统：只能内联；太大就明确报错，别让它撞成 ECONNRESET。
  if (!isLocalOnebot(onebotUrl)) {
    if (b64.length > INLINE_BASE64_HARD_LIMIT) {
      throw new Error(
        `文件太大（${(b64.length / 1024 / 1024).toFixed(1)}MB），而且协议端不共用文件系统：` +
        '没法落盘传路径。要么把 MING_ONEBOT_SHARED_FS=1 且挂同一个目录，要么先压缩。'
      );
    }
    return text;
  }
  try {
    const buf = Buffer.from(b64, 'base64');
    const dir = path.join(os.tmpdir(), 'qq-agent-outgoing');
    fs.mkdirSync(dir, { recursive: true });
    pruneSpillDir(dir);
    const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${guessExt(buf)}`);
    fs.writeFileSync(file, buf, { mode: 0o600 });
    return file;
  } catch {
    return text;   // 落盘失败就照旧，至少不比以前更差
  }
}

/**
 * 落盘目录是共用临时目录：协议端读完就把文件当垃圾，但**没人真的去删**（全仓再无第二处
 * 引用这个目录）。原来每次落一个 `Date.now()-Math.random()` 的文件且永不回收 ⇒
 * ① 目录随运行时间无界增长；② 用户发出去的每一张表情/图片都留一份永久副本在
 * 共享的 %TEMP% 里（同机其它账号/其它人若能读该目录就是泄露面）。
 *
 * 所以每次落盘前顺手扫一遍：删掉超过 SPILL_TTL_MS 的旧文件。协议端的读取发生在
 * 同一轮 sendSegments 内（毫秒级），两小时的窗口远大于任何一次读取耗时。
 */
const SPILL_TTL_MS = 2 * 60 * 60 * 1000;
function pruneSpillDir(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    const target = path.join(dir, name);
    try {
      if (now - fs.statSync(target).mtimeMs > SPILL_TTL_MS) fs.rmSync(target, { force: true });
    } catch { /* 单个文件删不掉不影响发送 */ }
  }
}

/** 载荷是不是"本机路径"（OneBot 只在同机时才读得到）。 */
function isLocalPathPayload(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^file:\/\/\//i.test(t)) return true;
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;      // C:\…
  if (/^\\\\[^\\]/.test(t)) return true;           // \\server\share
  return false;
}

/** `file:///C:/a/b.png` → `C:\a\b.png`（仅 Windows 盘符形式需要去掉开头多出来的斜杠）。 */
function fileUrlToPath(text) {
  const t = String(text || '').trim();
  if (!/^file:\/\/\//i.test(t)) return t;
  let pathname;
  try { pathname = decodeURIComponent(new URL(t).pathname); } catch { return t; }
  if (/^\/[A-Za-z]:[\\/]/.test(pathname)) pathname = pathname.slice(1);
  return pathname;
}

/**
 * 统一整理"要发给协议端的图片载荷"——所有出图/出表情的地方都过这里。
 *
 * 2026-09-22 用户实测「有的表情能发出来、有的发不出来」，根因就是**载荷形态跟大小**：
 *   · 小图内联 base64 → 请求体几百 KB → 协议端正常受理
 *   · 大图内联 base64 → 请求体 3MB+ → 协议端直接 RESET（read ECONNRESET），
 *     表现出来就是"同一批表情里有的行、有的不行"，且完全看不出跟大小有关
 * 规则：
 *   ① 同机协议端 → 一律走本地文件路径（表情 force=true 强制落盘，请求体几百字节）
 *   ② 跨机协议端 → 只能 base64；给的是本地路径时读成 base64（否则对端读不到）
 * 任何一步失败都退回原载荷，绝不因为"优化"把本来能发的消息弄丢。
 */
// ══════════════════════════════════════════════════════════════════════
// 表情缩图（2026-10-26 她：「发表情包记得缩小到 1/4，不然就是大图，看起来很难受的」）
//
// 为什么在这儿：表情发出去走的是 OneBot 的 image 段（不是 sub_type=1 的表情段），
// 所以 QQ 客户端按**图片的原始尺寸**渲染 —— 库里那些 656×568、1280 宽的图就成了大图。
// 缩放在投递前做，缩完落盘成路径（请求体只剩几百字节），并按原图 sha1 缓存，同一张只缩一次。
//
// 口径：
//   · 最大边不到 STICKER_SHRINK_MIN_SIDE 的不缩 —— 本来就小，缩了更糊；
//   · 缩到 1/4 之后短边不足 STICKER_SHRINK_FLOOR 的也不缩；
//   · GIF 走 palettegen/paletteuse 保动画（直接 scale 会掉帧或变糊）；
//   · 任何一步失败 ⇒ 返回原 src，绝不因为"优化"把表情弄成发不出去。
// ══════════════════════════════════════════════════════════════════════
const STICKER_SHRINK_MIN_SIDE = 400;
const STICKER_SHRINK_FLOOR = 96;

/** 读 PNG/JPEG/GIF 的宽高（读不出返回 0，调用方据此跳过缩放）。 */
function stickerDims(buf) {
  if (!buf || buf.length < 24) return { fmt: '', w: 0, h: 0 };
  if (buf[0] === 0x89 && buf[1] === 0x50) return { fmt: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.toString('ascii', 0, 3) === 'GIF') return { fmt: 'gif', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { fmt: 'jpg', h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return { fmt: 'jpg', w: 0, h: 0 };
  }
  return { fmt: '', w: 0, h: 0 };
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 20000, windowsHide: true }, (error) => {
      if (error) reject(error); else resolve();
    });
  });
}

/** base64:// 的表情载荷 → 缩到 1/4 的本地文件路径；不该缩 / 缩不动就原样返回。 */
export async function shrinkStickerSource(src) {
  const raw = String(src || '').trim();
  if (!raw.toLowerCase().startsWith('base64://')) return raw;
  try {
    const buf = Buffer.from(raw.slice('base64://'.length), 'base64');
    if (!buf.length) return raw;
    const dims = stickerDims(buf);
    const longest = Math.max(dims.w || 0, dims.h || 0);
    if (!dims.fmt || !longest || longest < STICKER_SHRINK_MIN_SIDE) return raw;
    if (Math.round(longest / 4) < STICKER_SHRINK_FLOOR) return raw;
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
    const dir = path.join(DATA_DIR, 'sticker-images', '.shrink');
    fs.mkdirSync(dir, { recursive: true });
    const ext = dims.fmt === 'png' ? '.png' : dims.fmt === 'gif' ? '.gif' : '.jpg';
    const out = path.join(dir, `${hash}-q4${ext}`);
    try { if (fs.statSync(out).size > 0) return out; } catch { /* 没缓存，接着缩 */ }
    const tmpIn = path.join(dir, `${hash}-src${ext}`);
    fs.writeFileSync(tmpIn, buf);
    const vf = ext === '.gif'
      ? 'scale=iw/4:ih/4:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer'
      : 'scale=iw/4:ih/4:flags=lanczos';
    const args = ext === '.gif' ? ['-y', '-i', tmpIn, '-vf', vf, '-loop', '0', out] : ['-y', '-i', tmpIn, '-vf', vf, out];
    await runFfmpeg(args);
    try { fs.unlinkSync(tmpIn); } catch { /* 临时文件删不掉不影响结果 */ }
    if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  } catch (error) {
    console.warn(`[sender] 表情缩图失败，用原图：${String(error?.message ?? error).slice(0, 160)}`);
  }
  return raw;
}

export function prepareImagePayload(payload, onebotUrl, { force = false } = {}) {
  const text = String(payload || '').trim();
  if (!text) return text;
  const local = isLocalOnebot(onebotUrl);
  if (isLocalPathPayload(text)) {
    if (local) return text;
    // 跨机：本地路径对协议端没有意义，转成字节再发
    try {
      const p = fileUrlToPath(text);
      const stat = fs.statSync(p);
      if (stat.size > 32 * 1024 * 1024) return text;   // 太大就别读进内存了，如实报错给调用方
      return `base64://${fs.readFileSync(p).toString('base64')}`;
    } catch {
      return text;
    }
  }
  return spillIfTooLarge(text, onebotUrl, { force });
}

export class SendQueue {
  constructor({ onebot, store, onSent = null }) {
    this.onebot = onebot;
    this.store = store;
    this.onSent = onSent;
    this.chains = new Map();      // chatKey -> enqueue fn
    this.minuteTimes = new Map(); // chatKey -> [ts]
    this.hourTimes = new Map();   // chatKey -> [ts]
    this.lastPokeAt = new Map();  // chatKey -> ts（用于忽略自己拍的回显）
    this.mediaDedupe = new Map(); // chatKey + media key -> successful send time
    // 2026-11-05（她）：每条气泡之间至少 0.3 秒，第一条不等。
    // 起因：模型分多次调 send_message 时每批只有一条，`#gap` 的 isLast 恒为 true ⇒ 间隔恒 0，
    // 几条会同一秒弹出来（01:54:28、01:56:24 各有一对是这样）。批内 gap 照旧，这里只兜跨批。
    this.lastTextAt = new Map(); // chatKey -> 上一条文本气泡的发出时刻
  }

  #chain(chatKey) {
    if (!this.chains.has(chatKey)) this.chains.set(chatKey, createSendChain());
    return this.chains.get(chatKey);
  }

  async #runSendHook(name, payload) {
    try {
      const results = await skillManager.runHook(name, payload);
      return Array.isArray(results) ? results : [];
    } catch {
      // 扩展故障必须放行原消息；发送主流程不依赖 hook 管理器正常返回。
      return [];
    }
  }

  /**
   * 解析"引用谁" —— 所有发送方法唯一的引用入口。
   *
   * ── 为什么必须有这一步（2026-09-22 管理员反馈"刷屏快的时候引用错"）──
   * 以前 args.replyToMessageId 是**原样**透传给 OneBot 的，中间没有任何校验。
   * 而模型手里那个数字是 QQ message_id（9~10 位、常带负号），刷屏时一屏十几个，
   * 模型根本抄不动 —— 对 7763 份会话存档对账：模型带过 replyToMessageId 的调用 2756 次，
   * **2089 次（76%）的 id 在本会话消息库里不存在**（冷分片也查了），且 1951 个各不相同，
   * 说明它是**现编**了一个"长得像"的数字。编出来的 id 发出去，QQ 侧要么引用失效、
   * 要么落到一条完全无关的消息上 —— 就是"引用错"。
   *
   * 现在模型看到的是本地短编号（#318，见 store.msgRef），这里：① 短编号 → 真正的 message_id；
   * ② 原始 id 照旧放行（旧会话上下文/记忆文件里存的是它）；③ **解析不出来的短编号一律不引用** ——
   * 宁可这条消息没有引用，也绝不把一个瞎编的 id 发出去。
   * 每次引用都打一行日志（引用到了哪条、内容是什么），下次再出问题可以直接对账。
   *
   * @returns {{mid: string|null, target: object|null, dropped?: string, unverified?: string}}
   */
  #resolveReply(chatKey, ref) {
    const raw = normalizeRef(ref);
    if (!raw || raw === 'null' || raw === 'undefined') return { mid: null, target: null };
    let known = null;
    try { known = this.store?.findByRef?.(chatKey, raw) || null; } catch { known = null; }
    const mid = known?.mid ?? null;
    const hasMid = mid !== null && mid !== undefined && String(mid) !== '';
    if (known && !hasMid) {
      // 本地有这条记录（模型没编），但它没有 QQ message_id（发送回执丢了）→ 引用不了，如实说
      console.warn(`[sender] ${chatKey} 引用 ${raw}：本地记录 ${msgRef(known)} 没有 QQ message_id，无法引用`);
      return { mid: null, target: null, dropped: raw, reason: 'no-mid' };
    }
    if (known && hasMid) {
      const target = {
        ref: msgRef(known) || `#${mid}`,
        mid: String(mid),
        sender: known.self ? '我' : String(known.senderName || ''),
        // 身份字段：sender 保持原值（'我'/名片，日志与对账按它），号和 self 另给 ——
        // prompt 渲染引用块时走 store.quoteAuthorLabel，能写出 `我（机器人）` / `名(QQ号)`。
        // 老存档里的 reply 没有这两个字段 → 照旧只显示名字，不编造。
        senderId: String(known.senderId ?? '').replace(/\D/g, ''),
        self: !!known.self,
        text: String(known.text || '').slice(0, 60)
      };
      console.log(`[sender] ${chatKey} 引用 ${raw} → ${target.ref}（${target.sender}：${target.text.slice(0, 24)}）`);
      return { mid: String(mid), target };
    }
    // 拿不到本地记录，但形状像原始 QQ id（9 位以上、可带负号）：放行 —— 可能是滚出窗口的老消息
    if (/^-?\d{8,}$/.test(raw)) {
      console.warn(`[sender] ${chatKey} 引用 ${raw}：本地消息库里没有，按原始 message_id 直接引用（无法校验）`);
      return { mid: raw, target: { ref: `#${raw}`, mid: raw, sender: '', text: '', unverified: true }, unverified: raw };
    }
    // 没有可查的 store（脚本/测试里手工构造的 SendQueue）→ 没有办法校验，保持旧行为原样透传，
    // 不要因为"校验不了"就把引用丢掉。
    if (typeof this.store?.findByRef !== 'function') {
      return { mid: raw, target: { ref: `#${raw}`, mid: raw, sender: '', text: '', unverified: true }, unverified: raw };
    }
    console.warn(`[sender] ${chatKey} 引用 ${raw}：这个编号在本会话找不到（模型多半是编的）→ 这次不引用`);
    return { mid: null, target: null, dropped: raw };
  }

  /**
   * 限频检查。
   *
   * ⚠️ 2026-09-21 改：以前超限**直接抛错**，工具把错误回给模型，模型往往就此放弃 ——
   * 群里/私聊的表现就是"叫他他不理"。实测同一天三处：
   *   17:26 私聊 9 轮里 6 次 send_message 全被拒，写好的「巧了 我刚想喊你」一句没出去；
   *   21:50 / 22:20 群聊同样，「？突然集体夸我 我害怕」被整条丢掉。
   * 现在：满了先**短暂等待**窗口滑动（最多 10 秒，避免整轮卡住 / 占着并发位），
   * 等到就发、绝不丢；等不到才报错（配合 maxPerMinute 抬高，实际极少触发）。
   * 每小时上限属于病态保护，仍然硬报错。
   */
  async #checkRate(chatKey) {
    const cfg = getConfig().send;
    // 亢奋：关掉限频（速度优先）；普通：保留
    if (isHypeMode()) return;
    const capMin = Math.max(1, Number(cfg.maxPerMinute) || DEFAULT_MAX_PER_MINUTE);
    const capHour = Math.max(1, Number(cfg.maxPerHour) || DEFAULT_MAX_PER_HOUR);
    const deadline = Date.now() + 8000;
    for (;;) {
      const list = (this.minuteTimes.get(chatKey) || []).filter((t) => Date.now() - t < 60000);
      if (list.length < capMin) break;
      const needMs = 60000 - (Date.now() - Math.min(...list)) + 150;
      // 只在"等一小会就能发"时等（≤6 秒）：等太久就别卡着整轮 —— 直接报错让模型下轮再说。
      if (needMs > 6000 || needMs > deadline - Date.now()) {
        throw new Error(`发送频率超限（每分钟最多 ${capMin} 条），请等一会再发`);
      }
      console.log(`[sender] ${chatKey} 每分钟上限 ${capMin} 条已满 → 等 ${(needMs / 1000).toFixed(1)}s（不丢消息）`);
      await sleep(needMs);
    }
    const now = Date.now();
    const minute = (this.minuteTimes.get(chatKey) || []).filter((t) => now - t < 60000);
    const hour = (this.hourTimes.get(chatKey) || []).filter((t) => now - t < 3600000);
    if (minute.length >= capMin) {
      throw new Error(`发送频率超限（每分钟最多 ${capMin} 条），等了一会仍然满，稍后再发`);
    }
    if (hour.length >= capHour) {
      throw new Error(`发送频率超限（每小时最多 ${capHour} 条）`);
    }
    minute.push(now);
    hour.push(now);
    this.minuteTimes.set(chatKey, minute);
    this.hourTimes.set(chatKey, hour);
  }

  #gap(text, isLast) {
    // 亢奋：极短间隔；普通：真人打字间隔（读配置，关亢奋后立刻回到慢速）
    if (isHypeMode()) {
      if (isLast) return 0;
      return randInt(20, 60);
    }
    const cfg = getConfig().send;
    const min = Math.max(200, Number(cfg.minGapMs) || 1800);
    const max = Math.max(min, Number(cfg.maxGapMs) || 4500);
    if (isLast) return 0;
    const byLen = Number(cfg.byLengthMs);
    const byLengthMs = Number.isFinite(byLen) && byLen > 0 ? byLen : 40;
    const byLength = Math.min(8000, String(text || '').length * byLengthMs);
    return Math.min(15000, Math.max(min, randInt(min, max) * 0.55 + byLength * 0.65));
  }

  /**
   * 发送一批文本消息（一条或多条）。
   * options: { replyToMessageId, atUserId }
   * 返回 { sent: [{text, messageId}], failed: [{index,text,error}], blocked: [{index,...}], reply }。
   * ★ 2026-10-18（#13 收口）：**全败也返回结构化结果，不再 throw** —— 改前 `sent.length===0`
   *   时抛错，上层（act.send）无法区分"平台逐条交代的已知全败"与"传输中断的真未知"，
   *   一律按 unknown 记（提示模型"不要重发"），一次限频/临时错误被伪装成"结果未知"。
   *   现在与部分成功同形状返回，调用方据 `failed` 判"已知未发出"（可安全重试）；
   *   真正的传输异常仍照常抛出（上层按 unknown 处理）。
   */
  async sendTextBatch(chatKey, messages, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group' && kind !== 'private') throw new Error(`非法会话 key：${chatKey}`);
    const list = Array.isArray(messages) ? messages : [messages];
    if (!list.length) throw new Error('消息列表为空');
    const sendConfig = getConfig().send || {};
    const splitAt = Math.max(0, Number(sendConfig.splitLongAt) || 0);
    const softParts = splitAt > 0 ? splitLongMessages(list, splitAt) : list;
    const hardSplitAt = Number(sendConfig.hardSplitAt) || 0;
    const parts = [];
    for (const m of softParts) {
      const plain = mdToPlain(String(m ?? ''));
      if (!plain) continue;
      if (hardSplitAt > 0 && plain.length > hardSplitAt) parts.push(...splitForQQ(plain, hardSplitAt));
      else parts.push(plain);
    }
    if (!parts.length) throw new Error('消息内容为空');

    const chain = this.#chain(chatKey);
    const reply = this.#resolveReply(chatKey, options.replyToMessageId);
    const promises = [];
    const deliveryStates = parts.map(() => 'not_sent');
    const checkCancelled = () => {
      if (options.signal?.aborted || (Number.isFinite(options.deadline) && Date.now() >= options.deadline)) {
        throw Object.assign(new Error('发送已取消或超过期限'), { deliveryState: 'not_sent' });
      }
    };
    // Additive API-v1 contract: before-send runs once per split text; unknown
    // returns are ignored, failures keep the original text, and after-send
    // returns are ignored. Extensions that do not register these hooks preserve
    // the old send path. Do not repurpose block for rate limiting: hype mode
    // disables rate limits below, but these hooks still run.
    for (let i = 0; i < parts.length; i++) {
      const originalText = parts[i];
      const isLast = i === parts.length - 1;
      promises.push(chain(async () => {
        checkCancelled();
        let text = originalText;
        const hookPayload = {
          chatKey, kind, id, text, index: i, total: parts.length,
          reply: reply.target ? { ...reply.target } : null,
          atUserId: i === 0 ? (options.atUserId ?? null) : null,
          options: { ...options }
        };
        // 亢奋模式会关闭限频，但 before-send 仍照常调用；block 是单条中间件决策，不能拿它实现亢奋连击限流。
        const beforeResults = await this.#runSendHook('before-send', hookPayload);
        for (const result of beforeResults) {
          const value = result?.value;
          if (!value || typeof value !== 'object') continue;
          if (typeof value.text === 'string') text = value.text;
          if (value.block === true) {
            break;
          }
        }
        const blockResult = beforeResults.find((result) => result?.value?.block === true);
        if (blockResult) {
          return {
            blocked: true,
            reason: blockResult.value.reason,
            text,
            atUserId: hookPayload.atUserId
          };
        }
        await this.#checkRate(chatKey);
        const gap = this.#gap(text, isLast);
        if (gap > 0) await sleep(gap);
        // 2026-11-05（她）：跨批次也按字数补间隔；第一条没有上一条，自然不等。
        // 0.3 秒落在同一秒里，肉眼看不出来（她 01:58:31 那对就是这么废的）。
        // 改成：9 字以内保底 0.9 秒，每多一个字 +90ms，封顶 3 秒。
        const minGap = Math.min(3000, Math.max(900, String(text || '').length * 90));
        const sinceLast = Date.now() - (this.lastTextAt.get(chatKey) || 0);
        if (sinceLast < minGap) await sleep(minGap - sinceLast);
        checkCancelled();
        let data;
        deliveryStates[i] = 'unknown';
        try {
          data = await this.onebot.sendText(kind, id, text, {
            replyToMessageId: i === 0 ? reply.mid : null, // 引用挂在第一条上：回的就是那条
            atUserId: i === 0 ? options.atUserId : null
          });
        } catch (error) {
          await this.#runSendHook('after-send', {
            ...hookPayload, text, messageId: null, error
          });
          throw error;
        }
        const messageId = data?.message_id ?? null;
        if (messageId === null || !String(messageId).trim()) throw new Error('发送回执缺少 message_id');
        deliveryStates[i] = 'sent';
        const ts = Date.now();
        this.lastTextAt.set(chatKey, ts);
        // Local bookkeeping cannot undo a confirmed remote delivery.
        const postSendErrors = [];
        for (const finish of [
          () => this.#runSendHook('after-send', { ...hookPayload, text, messageId, error: null }),
          () => this.store.appendSelf(chatKey, { text, ts, mid: messageId, hype: isHypeMode(), reply: i === 0 ? reply.target : null }),
          () => this.onSent?.({ chatKey, text, messageId })
        ]) {
          try { await finish(); } catch (error) { postSendErrors.push(String(error?.message ?? error)); }
        }
        return { text, messageId, at: formatClockTime(ts), deliveryState: 'sent', ...(postSendErrors.length ? { postSendErrors } : {}) };
      }));
    }

    const settled = await Promise.allSettled(promises);
    const sent = [];
    const failed = [];
    const unknown = [];
    const blocked = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === 'fulfilled' && r.value?.blocked === true) {
        blocked.push({
          index: i,
          text: r.value.text,
          reason: r.value.reason,
          atUserId: r.value.atUserId ?? null
        });
      } else if (r.status === 'fulfilled') sent.push(r.value);
      // 带上 index 和原文：调用方需要知道"哪一条"失败了（才能重发或告知模型）。
      // 原先 failed 里只有 error，没有任何定位信息。
      else {
        const deliveryState = deliveryStates[i];
        (deliveryState === 'not_sent' ? failed : unknown).push({ index: i, text: parts[i], error: String(r.reason?.message ?? r.reason), deliveryState });
      }
    }
    // 部分成功也要让调用方知道：原先只在"全败"时抛错，部分成功会静默丢消息。
    // ★ 2026-10-18（#13）：全败改为同形状返回（failed 带每条 index/原因），不再 throw ——
    //   上层据此记"已知未发出（state=failed，可安全重试）"，与真正的传输未知分开。
    if (failed.length > 0) {
      const detail = failed.map((f) => `第${f.index + 1}条「${String(f.text).slice(0, 20)}」：${f.error}`).join('；');
      console.warn(`[sender] ${sent.length === 0 ? '全部' : '部分'}发送失败（${failed.length}/${parts.length}）：${detail}`);
    }
    return { sent, failed, unknown, reply, blocked };
  }

  /**
   * 发送一个收藏表情（独立气泡）。
   * source 可选：传入 base64://… 或本地路径/URL 时用它直传（发送前已在别处
   * 下载并校验过字节，OneBot 无需再自行外网下载）；不传则退回 sticker.url
   * （直接 URL 让 OneBot 下载的方式对 QQ 内部图源不可靠，生产走 tool 时会传 source）。
   */
  /**
   * 发送合并转发打包消息。
   * @param {Array<{name?:string,uin?:string,content:string}>} nodes
   */
  sendForward(chatKey, nodes, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const list = Array.isArray(nodes) ? nodes : [];
    if (!list.length) throw new Error('合并转发节点为空');
    const chain = this.#chain(chatKey);
    const reply = this.#resolveReply(chatKey, options.replyToMessageId);
    return chain(async () => {
      await this.#checkRate(chatKey);
      await sleep(randInt(800, 1800));
      const data = await this.onebot.sendForward(kind, id, list, { ...options, replyToMessageId: reply.mid });
      const preview = list.map((n) => String(n.content || '').slice(0, 40)).join(' | ');
      const text = `[合并转发 共${list.length}条] ${preview}`.slice(0, 200);
      this.store.appendSelf(chatKey, { text, ts: Date.now(), mid: data?.message_id ?? null, reply: reply.target });
      this.onSent?.({ chatKey, text, messageId: data?.message_id ?? null });
      return { messageId: data?.message_id ?? null, count: list.length, reply };
    });
  }

  sendSticker(chatKey, sticker, options = {}, source = '') {
    const [kind, id] = String(chatKey).split(':');
    // ⚠️ 2026-09-22：这里以前直接把 base64:// 交给协议端 —— 而 sendImage 早就有
    //   spillIfTooLarge（本文件开头 20-29 行的实测：请求体 3.17MB → ECONNRESET）。
    //   表情库单图上限 20MB（sticker-manager.js），内联成 base64 就是 27MB 的请求体，
    //   必然被协议端 RESET —— 表现就是"表情发不出去，还没有任何报错"。
    //   现在表情一律 force（同机一律落盘成路径）：用户实测「有的能发出来有的发不出来」，
    //   差别就在图的大小上，落盘后请求体只剩几百字节，多大都能发。
    const rawSource = (source && String(source).trim()) || sticker.url;
    const chain = this.#chain(chatKey);
    const reply = this.#resolveReply(chatKey, options.replyToMessageId);
    return chain(async () => {
      // ★ 2026-10-26（她）：「发表情包记得缩小到 1/4，不然就是大图，看起来很难受的」。
      //   缩放在这里做（投递前、落盘前），返回的永远是本地路径或原样 src；缩不动就用原图，绝不因此不发。
      const shrunk = await shrinkStickerSource(rawSource);
      const src = prepareImagePayload(shrunk, this.onebot?.httpUrl, { force: true });
      await this.#checkRate(chatKey);
      await sleep(randInt(600, 1500)); // 发表情前真人式的短暂停顿
      const data = await this.onebot.sendSticker(kind, id, src, {
        replyToMessageId: reply.mid,
        atUserId: options.atUserId ?? null
      });
      const ts = Date.now();
      this.store.appendSelf(chatKey, {
        text: `[表情包:${sticker.localNote || sticker.desc || sticker.id}]`, ts,
        mid: data?.message_id ?? null, reply: reply.target
      });
      this.onSent?.({ chatKey, text: `[表情包]`, messageId: data?.message_id ?? null, sticker: sticker.id });
      return { message_id: data?.message_id ?? null, reply };
    });
  }

  /**
   * 发送一张普通图片（网页下载来的网图，或文生图生成的图）。
   * 与表情包共用同一条发送链：同样受最小间隔 / 每分钟上限保护，同样写入存档，
   * 保证下一次运行知道自己发过。
   *
   * ⚠️ 2026-09-22 修：**优先用本地文件路径，别再优先 base64**。
   *    实测（协议端 SnowLuma :3010）：
   *      · 3.17MB 的 base64 请求体 → 连接被直接 RESET（客户端看到 read ECONNRESET）
   *      · 1.6MB 及以下 → 正常受理
   *      · 同一张 2.3MB 的图改成本地路径传 → 请求体只有几百字节，正常受理
   *    教训：base64 是把字节塞进 HTTP body，图一大就顶到协议端的处理上限；
   *    进程与协议端同机时，传路径让它自己读文件才是对的做法。
   *    调用方（文生图技能）本来就同时给了 file 和 dataUrl，但这里只解构了 dataUrl ——
   *    于是"图明明画出来了却发不出去"。现在 file 优先，dataUrl 作为跨机回退。
   */
  sendImage(chatKey, { file = '', dataUrl = '', note = '' } = {}, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const payload = prepareImagePayload(
      String(file || '').trim() || String(dataUrl || '').trim(),
      this.onebot?.httpUrl
    );
    const chain = this.#chain(chatKey);
    const reply = this.#resolveReply(chatKey, options.replyToMessageId);
    return chain(async () => {
      await this.#checkRate(chatKey);
      await sleep(randInt(400, 1200));
      const data = await this.onebot.sendImage(kind, id, payload, {
        replyToMessageId: reply.mid,
        atUserId: options.atUserId ?? null
      });
      const ts = Date.now();
      const label = `[图片${note ? `:${String(note).slice(0, 40)}` : ''}]`;
      this.store.appendSelf(chatKey, { text: label, ts, mid: data?.message_id ?? null, reply: reply.target });
      this.onSent?.({ chatKey, text: label, messageId: data?.message_id ?? null, image: true });
      return { message_id: data?.message_id ?? null, reply };
    });
  }

  /**
   * Send OneBot segments atomically through the shared queue, rate limiter,
   * before-send/after-send hooks, and self archive. A before-send block rejects
   * the whole packet so callers cannot mistake a partial segment set for success.
   * @param {string} chatKey
   * @param {Array<{type:string,data?:object}>} segments
   * @param {{label?:string,replyToMessageId?:string,atUserId?:string}} options
   */
  sendSegments(chatKey, segments, options = {}) {
    return this.#sendSegmentBatch(chatKey, segments, options);
  }

  /**
   * Media convenience wrapper. A dedupeKey is scoped to this chat and
   * suppresses successful duplicates for 60 seconds.
   * @param {string} chatKey
   * @param {Array<{type:string,data?:object}>} segments
   * @param {{label?:string,dedupeKey?:string,replyToMessageId?:string}} options
   */
  sendMedia(chatKey, segments, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group' && kind !== 'private') return Promise.reject(new Error(`非法会话 key：${chatKey}`));
    const mediaSegments = Array.isArray(segments) ? segments : [];
    if (!mediaSegments.length) return Promise.reject(new Error('媒体段为空'));

    const label = String(options.label || (mediaSegments.some((segment) => segment?.type === 'record') ? '[语音]' : '[媒体]'));
    const contentKey = String(options.dedupeKey
      || mediaSegments.map((segment) => segment?.data?.file).filter(Boolean).join('|')
      || label);
    const dedupeKey = `${chatKey}\0${contentKey}`;
    return this.#sendSegmentBatch(chatKey, mediaSegments, { ...options, label }, { dedupeKey });
  }

  #sendSegmentBatch(chatKey, segments, options = {}, { dedupeKey = '' } = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group' && kind !== 'private') return Promise.reject(new Error(`非法会话 key：${chatKey}`));
    const segmentList = Array.isArray(segments) ? segments : [];
    if (!segmentList.length || segmentList.some((segment) => !segment || typeof segment.type !== 'string')) {
      return Promise.reject(new Error('消息段为空或格式无效'));
    }
    const outgoingSegments = segmentList.map((segment) => ({
      ...segment,
      ...(segment.data && typeof segment.data === 'object' ? { data: { ...segment.data } } : {})
    }));
    const summarize = () => outgoingSegments.map((segment) => {
      if (segment.type === 'text') return String(segment.data?.text || '');
      if (segment.type === 'reply' || segment.type === 'at') return '';
      return ({ image: '[图片]', record: '[语音]', video: '[视频]', file: '[文件]', face: '[表情]' })[segment.type]
        || `[${segment.type}]`;
    }).join('').slice(0, 200) || '[消息段]';
    const label = String(options.label || summarize());
    const chain = this.#chain(chatKey);
    const reply = this.#resolveReply(chatKey, options.replyToMessageId);
    return chain(async () => {
      const now = Date.now();
      if (dedupeKey) {
        for (const [key, sentAt] of this.mediaDedupe) {
          if (now - sentAt >= 60000) this.mediaDedupe.delete(key);
        }
        const priorSentAt = this.mediaDedupe.get(dedupeKey);
        if (priorSentAt != null && now - priorSentAt < 60000) {
          throw new Error('这份媒体刚刚发过，已跳过（避免重复刷屏）');
        }
      }

      const textIndexes = outgoingSegments
        .map((segment, index) => segment.type === 'text' && typeof segment.data?.text === 'string' ? index : -1)
        .filter((index) => index >= 0);
      // Media-only packets still pass the veto hook once using their safe archive label.
      // Text rewrites only apply to actual text segments; a label is not inserted into media.
      const hookIndexes = textIndexes.length ? textIndexes : [-1];
      for (const index of hookIndexes) {
        const text = index >= 0 ? outgoingSegments[index].data.text : label;
        const hookPayload = {
          chatKey, kind, id, text, index: index >= 0 ? index : 0,
          total: index >= 0 ? outgoingSegments.length : 1,
          reply: reply.target ? { ...reply.target } : null,
          atUserId: options.atUserId ?? null,
          options: { ...options }
        };
        const beforeResults = await this.#runSendHook('before-send', hookPayload);
        let transformedText = text;
        let blocked = null;
        for (const result of beforeResults) {
          const value = result?.value;
          if (!value || typeof value !== 'object') continue;
          if (typeof value.text === 'string') transformedText = value.text;
          if (value.block === true) { blocked = value; break; }
        }
        if (blocked) {
          const error = new Error(`before-send 拦截了段级消息：${String(blocked.reason || '扩展策略')}`);
          error.code = 'SEND_BLOCKED';
          error.blocked = { index: hookPayload.index, reason: blocked.reason || null };
          throw error;
        }
        if (index >= 0) outgoingSegments[index].data.text = transformedText;
      }
      const archiveText = options.label ? label : summarize();

      await this.#checkRate(chatKey);
      await sleep(randInt(800, 1800));
      const packet = reply.mid
        ? [{ type: 'reply', data: { id: reply.mid } }, ...outgoingSegments]
        : outgoingSegments;
      let data;
      try {
        data = await this.onebot.sendSegments(kind, id, packet);
      } catch (error) {
        await this.#runSendHook('after-send', {
          chatKey, kind, id, text: archiveText, index: 0, total: 1,
          reply: reply.target ? { ...reply.target } : null,
          atUserId: options.atUserId ?? null, options: { ...options },
          messageId: null, error
        });
        throw error;
      }
      await this.#runSendHook('after-send', {
        chatKey, kind, id, text: archiveText, index: 0, total: 1,
        reply: reply.target ? { ...reply.target } : null,
        atUserId: options.atUserId ?? null, options: { ...options },
        messageId: data?.message_id ?? null, error: null
      });
      // Mark only after the remote send succeeds; archive errors must not cause a duplicate send.
      if (dedupeKey) this.mediaDedupe.set(dedupeKey, Date.now());
      const ts = Date.now();
      this.store.appendSelf(chatKey, {
        text: archiveText, ts, mid: data?.message_id ?? null, reply: reply.target
      });
      this.onSent?.({ chatKey, text: archiveText, messageId: data?.message_id ?? null, kind: 'segments' });
      return { message_id: data?.message_id ?? null, reply };
    });
  }

  /**
   * 发送音乐卡片（网易云等）。与文字/表情同一条发送链。
   * @param {string} chatKey
   * @param {{ platform?: string, songId?: string, url?: string, audio?: string, title?: string, artist?: string, image?: string }} music
   */
  sendMusic(chatKey, music = {}, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    // 音乐卡刻意不带引用（带引用会被 QQ 吞掉整张卡，见 onebot.sendMusic），
    // 但"模型想引用谁"仍要解析出来：调用方会把引用单独发一条文字，日志也好对账。
    const reply = this.#resolveReply(chatKey, options.replyToMessageId);
    return chain(async () => {
      await this.#checkRate(chatKey);
      await sleep(randInt(500, 1400));
      const data = await this.onebot.sendMusic(kind, id, {
        ...music,
        replyToMessageId: reply.mid,
        atUserId: options.atUserId ?? null
      });
      const ts = Date.now();
      const title = String(music.title || music.songId || '音乐').slice(0, 40);
      const label = `[音乐:${title}]`;
      this.store.appendSelf(chatKey, { text: label, ts, mid: data?.message_id ?? null, reply: reply.target });
      this.onSent?.({ chatKey, text: label, messageId: data?.message_id ?? null, music: true });
      return { message_id: data?.message_id ?? null, reply };
    });
  }

  /** 拍一拍。发送成功后留档（self 记录），否则下一次运行不知道自己拍过。 */
  poke(chatKey, targetUserId) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      await sleep(randInt(300, 900));
      const data = await this.onebot.sendPoke(kind, id, targetUserId);
      const ts = Date.now();
      this.lastPokeAt.set(chatKey, ts);
      const target = kind === 'group' && targetUserId != null ? `群友${targetUserId}` : '你';
      this.store.appendSelf(chatKey, { text: `[拍一拍] 你拍了拍${target}`, ts, mid: data?.message_id ?? null });
      this.onSent?.({ chatKey, text: `[拍一拍]${target}`, messageId: null });
      return data;
    });
  }

  /**
   * 发 B 站视频：封面图 + 链接（一定看得见），再补一张 json 分享卡（有则更像卡片）。
   * 单靠 json 在 NapCat/QQ 上经常不显图/空白，所以不做「只发卡」。
   */
  sendBilibiliCard(chatKey, video = {}, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    const reply = this.#resolveReply(chatKey, options.replyToMessageId);
    return chain(async () => {
      await this.#checkRate(chatKey);
      await sleep(randInt(400, 1100));
      const url = String(video.url || '').trim();
      const title = String(video.title || 'B站视频').slice(0, 80);
      const desc = String(video.desc || '').slice(0, 60);
      const cover = String(video.cover || '').trim().replace(/^http:/i, 'https:');
      let mode = 'image+link';

      // 1) 封面（失败不阻断后面的链接）
      let coverOk = false;
      if (cover) {
        try {
          await this.onebot.sendImage(kind, id, cover, { replyToMessageId: reply.mid });
          coverOk = true;
          await sleep(randInt(500, 1400));
        } catch (e) {
          console.warn('[sender] B站封面发送失败（继续发链接）:', e?.message ?? e);
        }
      }

      // 2) 标题 + 链接（可点、可 parse_video）
      await this.onebot.sendText(kind, id, `${title}\n${url}`, {
        replyToMessageId: coverOk ? null : reply.mid
      });

      // 3) 可选 json 分享卡（默认关）：部分 QQ 会显示「升级后使用」或「消息已过期」
      const wantJson = getConfig().send?.biliJsonCard === true;
      if (wantJson) {
        try {
          await this.onebot.sendBiliCard(kind, id, { url, title, desc, cover });
          mode = coverOk ? 'image+link+json' : 'link+json';
        } catch (e) {
          console.warn('[sender] B站 json 卡失败（封面+链接已发出）:', e?.message ?? e);
        }
      }

      const ts = Date.now();
      const label = `[B站:${title}]`;
      this.store.appendSelf(chatKey, { text: label, ts, mid: null, reply: reply.target });
      this.onSent?.({ chatKey, text: label, messageId: null, bili: true, mode });
      return { message_id: null, mode, title, url, reply };
    });
  }

  /** 刚才是不是我们主动拍了这个会话（用于忽略 OneBot 回显）。 */
  recentlyPoked(chatKey, windowMs = 8000) {
    const t = this.lastPokeAt.get(chatKey);
    return !!t && Date.now() - t < windowMs;
  }
}
