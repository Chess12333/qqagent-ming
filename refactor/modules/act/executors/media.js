/**
 * M10 · 执行器切片 `media`（图/表情/素材库/看图）—— 契约见 ./index.js
 *
 * 归属工具（12 个，来自旧 `src/tools.js`）：
 *   send_image · send_sticker · collect_sticker · list_stickers · get_sticker_image · sticker_note
 *   · image_lib_search · image_lib_send · search_images · identify_image · get_message_images · parse_video
 *
 * ── 三条硬纪律（写在最前面，改代码前先读）─────────────────────────────
 * 1. **本文件零 import**。能力一律从 `ctx.modules.<模块>.<公开出口>` 取；
 *    旧代码里的 `import { … } from './stickers.js'` 之类**一条都不许在这里重演**。
 *    （`act/selftest.mjs` 会扫本文件的每个说明符，只放行 `node:` / `./` / `contracts/` / `core/`。）
 * 2. **不许自己发消息**。`send_image` / `send_sticker` / `image_lib_send` 三个"发"类工具
 *    只把 `{ pendingSend:{ type, file, replyTo, at, note } }` 放进 `data` —— **这是"已准备"，不是"已投递"**。
 *    ★★ 2026-10-08（P0-4）消费方**已经存在**：活门面自 G16 起暴露了 `sendSegments`
 *      （`apps/server/onebot-link.js:175`，能力本体在 M3 `platform/sender.js`），
 *      M10 的 `send()` 也早有媒体分支并产出**与文本同形状**的回执。
 *      ⇒ **旧注释"新树 send_message 只会发文本"是错的**：`send_message` 的 schema（`act/index.js:121`
 *      的 `media` 字段）与 `send()` 都已支持 media。
 *      ⇒ 这三个工具**仍然只整理载荷、一次都不碰平台**；投递由 act 统一消费 `pendingSend`
 *        并复用 `send()` 完成（见 `act/index.js` 的 `deliverPreparedMedia()`），
 *        成败只看**平台回执**（`deliveryState`：delivered / unknown / not_deliverable / failed）。
 *        本文件的 `pendingSend` 形状不变 —— 出口一通就自动生效，**不需要改这里**。
 * 3. **依赖没就绪就明说**。返回 `{ ok:false, error:'依赖未就绪：…' }`，
 *    **绝不**返回假的成功、也绝不吞错（抛错 = 工具失败，M10 会把错误回给模型）。
 *
 * ── 已知偏差（都登记在回执 .tmp-dispatch/r-tools-media.md）──────────────
 * D1 旧实现把"本次处理"的计数放在 `ctx.session.*`（imagePreviewed / imageUrlsSeen / imageSearchCount /
 *    sent）。**新 ctx 白名单里没有 `session` 也没有 `emit`**，所以本文件用模块内的
 *    `RUN_STATE`（按 `chatKey` 分桶）承接这些计数。语义等价（同一会话同一轮内累计），
 *    但**跨轮不会自动清零** —— 第 3 批若给 ctx 加 session，应改回 ctx.session。
 * D2 旧实现调 `ctx.sender.sendImage(...)` 拿回执；新树执行器**一次都不碰平台**：投递由 act 统一走
 *    `send()`（见纪律 2），回执只由 M10 造。
 * D3 旧 `identify_image` 直接调裸 `reverseImageSearch`；**M11 已把裸函数从公开出口收口**
 *    （`index.js` 里是 `export {} from './reverse-image.js'`），受控入口 `reverseImageSearchGuarded`
 *    又需要外部注入裸函数。⇒ act 侧拿不到、也不该拿 ⇒ 见「缺出口」清单第 1 条。
 */

// ══════════════════════════════════════════════════════════════════════
// 小工具（全部本文件私有）
// ══════════════════════════════════════════════════════════════════════

const ok = (data) => ({ ok: true, data });
const err = (error) => ({ ok: false, error: String(error) });

/**
 * S10（2026-10-19）：取消类错误判定 —— 与 `act/index.js:1725` 同口径
 * （`AbortError` / `ABORT_ERR` / 本工具信号已中止）。
 * 本文件零 import：不引 internet 的 isAbortError，按同一组标记本地判定。
 * 取消**不是**工具失败：guard 与各处降级 catch 一律原样上抛，由 act 记 unknown。
 */
function isAbortLike(ctx, error) {
  return ctx?.signal?.aborted === true
    || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR';
}

/**
 * 亢奋模式硬锁：受保护 QQ 的 `@` 一律剥掉（照老树 `src/tools.js:932`（send_image）与 `:1307`（send_sticker））。
 * ★ 2026-10-09 N35 补：新树这两处原先把 `args.atUserId` 直接塞进 pendingSend，
 *   亢奋模式下能 @ 到那个被硬保护的号 —— 正是老树 `sanitizeHypeProtectedArgs` 要拦的。
 *   出口来自 M7（`emotion/hype-mode.js:73`，N30 补齐的只读出口）；本域只调不改，
 *   M7 没挂上就原样透传（亢奋是可选功能，缺出口不该把发图也一起弄死）。
 */
function hypeSafeAt(ctx, args) {
  const raw = args?.atUserId ?? null;
  const sanitize = ctx?.modules?.emotion?.sanitizeHypeProtectedArgs;
  if (typeof sanitize !== 'function') return raw;
  try {
    const sanitized = sanitize({ atUserId: raw });
    return sanitized?.strippedAt ? null : (sanitized?.args?.atUserId ?? raw);
  } catch { return raw; }
}

/** 「依赖未就绪」是本片最高频的返回，必须说清缺什么。 */
const notReady = (what) => ({ ok: false, error: `依赖未就绪：${what}` });

/** 取模块；缺了或没有某个具名出口 ⇒ 说清缺什么，不自己造。 */
function mod(ctx, name) {
  const m = ctx?.modules?.[name];
  if (!m || typeof m !== 'object') throw new Error(`依赖未就绪：ctx.modules.${name}（该模块未注入）`);
  return m;
}
function need(m, name, modName, hint = '') {
  if (typeof m[name] !== 'function') {
    throw new Error(`依赖未就绪：ctx.modules.${modName}.${name}（该出口不存在）${hint ? ` —— ${hint}` : ''}`);
  }
  return m[name].bind(m);
}
/** 取 cfg 值；没有 cfg 访问器就返回 fallback（不猜配置）。 */
function cfgGet(ctx, key, fallback = undefined) {
  try {
    if (typeof ctx?.cfg?.get === 'function') return ctx.cfg.get(key, fallback);
    if (typeof ctx?.cfg?.effective === 'function') {
      // ★ N61：effective() 给的是 `{ value, source, found }` 描述对象，原样返回会让 `=== false`
      //   这类判据永远不成立 ⇒ 必须先剥值（与 act/index.js 的 cfg() 同口径）。
      const resolved = ctx.cfg.effective(key, { chatKey: ctx.chatKey, kind: ctx.kind });
      if (resolved && typeof resolved === 'object' && Object.hasOwn(resolved, 'value')) {
        return resolved.found === false ? fallback : resolved.value;
      }
      return resolved ?? fallback;
    }
  } catch { /* 配置读不到就当没有，不猜 */ }
  return fallback;
}
const visionEnabled = (ctx) => cfgGet(ctx, 'api.vision', undefined) !== false;

// N84：三处「找不到消息」（collect_sticker / get_message_images / identify_image）原来只丢一句
// "找不到消息 X。"，模型拿不到本会话真可见的 #编号就只能编数字 ⇒ 补 old `src/tools.js:838-849` 的 midHint。
/**
 * ⚠️ 只给 #短编号、不给原始 QQ message_id：老树那行注释是实测换来的
 * （列原始 id 反而成了编造模板，2026-09-22 统计 76% 的引用目标是编的）。
 */
function refHint(ctx, store) {
  try {
    const msgRef = ctx?.modules?.memory?.msgRef;
    if (typeof msgRef !== 'function' || typeof store?.recent !== 'function') {
      return '只能填聊天记录里每条消息前的 #短编号，照抄，不要自己编数字';
    }
    const refs = [...new Set((store.recent(ctx.chatKey, { limit: 60 }) || [])
      .map((entry) => msgRef(entry))
      .filter(Boolean))].slice(-8);
    return refs.length
      ? `引用/看图只能填聊天记录里每条消息前的 #短编号（最近可见：${refs.join(' ')}），照抄，不要自己编数字`
      : '聊天记录里还没有带 #编号 的消息';
  } catch {
    return '引用只能填聊天记录里每条消息前的 #短编号';
  }
}

/** 组装给模型的多模态 content（文本 + 图片帧）。 */
function imageParts(text, dataUrls) {
  return [{ type: 'text', text }, ...dataUrls.map((url) => ({ type: 'image_url', image_url: { url } }))];
}

/**
 * D1：本次处理的计数（旧 `ctx.session.*`）。按 chatKey 分桶。
 * 只放"限流/去重"这类计数，不放业务数据。
 */
const RUN_STATE = new Map();
function runState(ctx) {
  const key = String(ctx?.chatKey ?? 'unknown');
  if (!RUN_STATE.has(key)) {
    RUN_STATE.set(key, { imagePreviewed: [], imageUrlsSeen: [], imageSearchCount: 0, sentImages: 0, sent: [], seen: {} });
  }
  return RUN_STATE.get(key);
}

/** StickerManager 实例按 chatKey 缓存（M11 的类；构造只吃 onebot=ctx.platform）。 */
const STICKER_MANAGERS = new Map();
function stickerManager(ctx) {
  const media = mod(ctx, 'media');
  const Manager = media.StickerManager;
  if (typeof Manager !== 'function') {
    throw new Error('依赖未就绪：ctx.modules.media.StickerManager（M11 出口不存在）');
  }
  const platform = ctx?.platform;
  if (!platform || typeof platform.call !== 'function') {
    throw new Error('依赖未就绪：ctx.platform（StickerManager 需要一个只读协议端实例才能取表情）');
  }
  const key = String(ctx?.chatKey ?? 'unknown');
  if (!STICKER_MANAGERS.has(key)) STICKER_MANAGERS.set(key, new Manager(platform));
  return STICKER_MANAGERS.get(key);
}

/**
 * memory.store：聊天记录（旧 `ctx.store.findByMid`）。
 * 装配层挂的是 `ctx.modules.memory.store`（createChatStore 的门面）；
 * 若只给了 `createChatStore` 工厂 + dataDir，本层自己建一个并缓存 —— 两条都支持。
 */
const CHAT_STORES = new Map();
function memoryStore(ctx) {
  const memory = mod(ctx, 'memory');
  if (memory.store && typeof memory.store.findByMid === 'function') return memory.store;
  if (typeof memory.createChatStore === 'function') {
    const dataDir = ctx?.dataDir;
    if (!dataDir) {
      throw new Error('依赖未就绪：ctx.modules.memory.store（未挂上面包，且没有 ctx.dataDir 可建 ChatStore）');
    }
    const key = String(dataDir);
    if (!CHAT_STORES.has(key)) CHAT_STORES.set(key, memory.createChatStore({ dataDir, log: () => {} }));
    const made = CHAT_STORES.get(key);
    if (made && typeof made.findByMid === 'function') return made;
  }
  throw new Error('依赖未就绪：ctx.modules.memory.store.findByMid（记忆模块未挂 store 门面）');
}

/** 统一的"下载 + 视觉归一化"：出错时不吞，交给上层转成模型看得懂的话。 */
async function toVision(ctx, buffer, mime, maxFrames = 6) {
  const media = mod(ctx, 'media');
  const toVisionDataUrls = need(media, 'toVisionDataUrls', 'media');
  // ★ S10 收口（2026-10-19）：媒体模块的归一化支持可选 AbortSignal（GIF 解码/转码可被杀），透传本次调用信号
  return toVisionDataUrls(buffer, { mime, maxFrames, signal: ctx.signal ?? null });
}

// ══════════════════════════════════════════════════════════════════════
// ★ #14（2026-10-18，用户实机报「模型看到有图但是没收到」）
//
// 每个模型请求前还有一道出站闸（编排层 `boundModelImages`：最多 3 张 image_url、
// data: URL 合计 2 MiB 字符）。这边图片工具（get_message_images / get_sticker_image /
// send_image(preview) / identify_image）原先对"附件"没有任何请求侧预算约束：
// 下载 8MB 的图归一化后直接塞进工具结果，出站闸再按自己的数字中途丢掉 ⇒
// 模型先看到"图片工具已返回"，随后又看到"本轮有图片未附"，两头对不上。
//
// 口径：预算数字只认媒体模块透出的 `MODEL_REQUEST_IMAGE_LIMITS`（与自动看图、出站闸同源）。
// 超预算先试缩（PNG 纯 JS；JPEG/WEBP 用媒体模块的可选解码器），缩不动就**不附 + 明说**。
// ══════════════════════════════════════════════════════════════════════

/** 模型单次请求附图预算（缺出口就按合同常量兜底，绝不各自发明数字）。 */
function visionBudget(ctx) {
  const limits = ctx?.modules?.media?.MODEL_REQUEST_IMAGE_LIMITS;
  return {
    maxCount: Math.max(1, Number(limits?.maxCount) || 3),
    maxDataChars: (Number.isFinite(limits?.maxDataChars) && limits.maxDataChars > 0) ? limits.maxDataChars : 2 * 1024 * 1024
  };
}

/** 按预算裁剪 data URL（优先走媒体模块的同一实现；拿不到就按同一口径本地兜底）。 */
function fitVision(ctx, dataUrls) {
  const media = ctx?.modules?.media;
  const budget = visionBudget(ctx);
  if (typeof media?.fitVisionDataUrls === 'function') return media.fitVisionDataUrls(dataUrls, budget);
  const kept = []; const dropped = []; let chars = 0;
  for (const url of Array.isArray(dataUrls) ? dataUrls : []) {
    const len = String(url ?? '').length;
    if (!len || kept.length >= budget.maxCount || chars + len > budget.maxDataChars) { dropped.push(url); continue; }
    kept.push(url); chars += len;
  }
  return { dataUrls: kept, dropped, chars, maxCount: budget.maxCount, maxDataChars: budget.maxDataChars };
}

function budgetMissNote(fit, droppedCount = fit?.dropped?.length ?? 0) {
  return `（本轮附图预算：最多 ${fit.maxCount} 张、base64 合计 ${Math.round(fit.maxDataChars / 1024 / 1024)}MB；另有 ${droppedCount} 张超过预算没附）`;
}

/**
 * 归一化后先过请求预算：不超 → 原样；超了 → 先试缩一次，缩完还超 → 不附（note 里写明原因）。
 * GIF 拼图（tileFrames 拼成一张）一般只产 1 张 data URL，天然按字节走同一预算。
 */
async function prepareVisionContent(ctx, buffer, mime, maxFrames = 6) {
  const media = mod(ctx, 'media');
  const prepared = await toVision(ctx, buffer, mime, maxFrames);
  if (prepared?.skipped || !prepared?.dataUrls?.length) return prepared;
  const first = fitVision(ctx, prepared.dataUrls);
  if (!first.dropped.length) return { ...prepared, fit: first };
  try {
    const shrink = typeof media.shrinkImageForVision === 'function' ? media.shrinkImageForVision : null;
    if (shrink) {
      const decodeForeign = typeof media.loadForeignDecoder === 'function'
        ? await media.loadForeignDecoder({ scaleRgba: media.scaleRgba, encodePng: media.encodePng })
        : null;
      const shrunk = await shrink(buffer, mime, { encodePng: media.encodePng, decodeForeign, maxSide: 1024 });
      if (shrunk?.ok) {
        const again = await media.toVisionDataUrls(shrunk.buffer, { mime: shrunk.mime, maxFrames, signal: ctx.signal ?? null });
        if (again?.dataUrls?.length) {
          const second = fitVision(ctx, again.dataUrls);
          if (!second.dropped.length) {
            return { ...again, fit: second, note: [shrunk.note, again.note].filter(Boolean).join(' ') };
          }
        }
      }
    }
  } catch { /* 缩失败就走"不附 + 明说" */ }
  const note = budgetMissNote(first);
  return { ...prepared, dataUrls: first.dataUrls, fit: first, note: [prepared.note, note].filter(Boolean).join(' ') };
}

// ══════════════════════════════════════════════════════════════════════
// 1) list_stickers —— 旧 src/tools.js L1613–1631
// ══════════════════════════════════════════════════════════════════════
async function listStickers(ctx, args) {
  const mgr = stickerManager(ctx);
  const limit = Math.min(100, Math.max(1, Number(args.limit) || 24));
  return ok(await mgr.list(String(args.query ?? ''), limit));
}

// ══════════════════════════════════════════════════════════════════════
// 2) get_sticker_image —— 旧 L1632–1663
// ══════════════════════════════════════════════════════════════════════
async function getStickerImage(ctx, args) {
  const mgr = stickerManager(ctx);
  const sticker = await mgr.find(args.stickerId);
  if (!sticker) return err(`找不到表情「${args.stickerId}」。先 list_stickers 查真实 id（照抄，别编）。`);
  if (!sticker.url && !sticker.base64) return err('该表情没有图片地址');
  const media = mod(ctx, 'media');
  const detectMime = need(media, 'detectMime', 'media');
  const buffer = await mgr.resolveStickerBytes(sticker);
  const rawMime = detectMime(buffer) || 'image/jpeg';
  const prepared = await prepareVisionContent(ctx, buffer, rawMime, 6);
  const localNote = sticker.localNote || sticker.desc || '（无）';
  if (prepared.skipped || !prepared.dataUrls.length) {
    return ok(`表情 ${sticker.id}（${rawMime}）${prepared.note || '当前视觉接口看不了内容'}（QQ 里能正常显示）。本地备注：${localNote}。`);
  }
  const frameNote = prepared.note ? `${prepared.note} ` : '';
  return ok({
    content: imageParts(
      `表情 ${sticker.id}（已有备注：${localNote}）——${frameNote}请以图像为准：先辨认主体、手上动作和表情，再分辨梗字与边角水印；不确定就别猜。`
      + '这是群友发的表情——也就是他此刻的情绪或梗。顺着气氛接一句，或回一张贴切的；别点评画风。',
      prepared.dataUrls
    )
  });
}

// ══════════════════════════════════════════════════════════════════════
// 3) sticker_note —— 旧 L1664–1688
// ══════════════════════════════════════════════════════════════════════
async function stickerNote(ctx, args) {
  const note = String(args.note ?? '').trim();
  if (!note) return err('备注内容不能为空；请写一句表情含义或使用场景。');
  const entry = stickerManager(ctx).note(String(args.stickerId), { note, tags: args.tags, usage: args.usage, noteSource: 'manual' });
  if (!entry) return err(`找不到表情 ${args.stickerId}`);
  return ok({ updated: true, id: entry.id, localNote: entry.localNote, tags: entry.tags });
}

// ══════════════════════════════════════════════════════════════════════
// 4) collect_sticker —— 旧 L1689–1714（依赖聊天记录）
// ══════════════════════════════════════════════════════════════════════
async function collectSticker(ctx, args) {
  const note = String(args.note ?? '').trim();
  if (!note) return err('收藏时必须写一句备注，说明这张图是什么或适合什么场景。');
  const store = memoryStore(ctx);                      // ← 未落地时抛"依赖未就绪"
  const entry = store.findByMid(ctx.chatKey, args.messageId);
  if (!entry) return err(`在当前会话找不到消息 ${args.messageId}。${refHint(ctx, store)}`);
  const imageMedia = (entry.media || []).find((m) => m.kind === 'image' && m.url);
  if (!imageMedia) return err('该消息没有可收藏的图。');
  const saved = stickerManager(ctx).collect(args.messageId, { url: imageMedia.url, note });
  return ok({ collected: true, id: saved.id, note: saved.localNote });
}

// ══════════════════════════════════════════════════════════════════════
// 5) get_message_images —— 旧 L1980–2027（依赖聊天记录）
// ══════════════════════════════════════════════════════════════════════
async function getMessageImages(ctx, args) {
  const store = memoryStore(ctx);                      // ← 未落地时抛"依赖未就绪"
  const entry = store.findByMid(ctx.chatKey, args.messageId);
  if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${refHint(ctx, store)}`);
  const mediaList = Array.isArray(entry.media) ? entry.media : [];
  const urls = mediaList.filter((m) => m.kind === 'image' && m.url).map((m) => m.url);
  if (!urls.length) {
    // ★ N26（用户实机报「识图看不了动图」+「只剩一个符号」）：这里**不许**只回一句
    //   "没有可查看的图片"就走人。QQ 表情/动态表情没有图片直链、走不了视觉归一化，
    //   模型拿不到画面就会照着占位文字编。明说"为什么看不到"，比让它猜强。
    const faces = mediaList.filter((m) => m.kind === 'face' || m.kind === 'mface');
    const why = faces.length
      ? '这条只有 QQ 表情（没有图片直链），本工具看不到它的画面；聊天记录里的占位文字不是画面内容'
      : mediaList.length
        ? `这条带的媒体没有可下载的图片地址（kind=${mediaList.map((m) => String(m?.kind ?? '?')).join('/')}）`
        : '这条消息本身不带图片';
    return ok(`消息 ${args.messageId} 没有可查看的图片：${why}。别描述、别猜；`
      + '要看已收藏的表情用 get_sticker_image。');
  }
  const internet = mod(ctx, 'internet');
  const safeFetchBinary = need(internet, 'safeFetchBinary', 'internet');
  const media = mod(ctx, 'media');
  const detectMime = need(media, 'detectMime', 'media');
  // ★ 2026-10-26（识图修复）：收图字节缓存的读出口 —— 死链时的唯一原图来源。
  const readIncomingImageCache = typeof media.readIncomingImageCache === 'function' ? media.readIncomingImageCache : null;
  const dataUrls = []; const failed = []; let skipped = 0; const notes = [];
  let budgetDropped = 0;
  for (const url of urls) {
    try {
      let buffer = null;
      // 先试收图瞬间的本地字节缓存（按消息 mid + URL 精确配对），没命中再下载。
      if (readIncomingImageCache) {
        const hit = readIncomingImageCache(args.messageId, url);
        if (hit?.buf?.length) buffer = hit.buf;
      }
      if (!buffer?.length) {
        ({ buffer } = await safeFetchBinary(url, 8 * 1024 * 1024, { browseLocked: true, signal: ctx.signal ?? null }));
      }
      if (!buffer?.length) { failed.push(`${url}：内容为空`); continue; }
      const mime = detectMime(buffer);
      if (!mime) { failed.push(`${url}：不是可识别的图片`); continue; }
      const prepared = await prepareVisionContent(ctx, buffer, mime, 6);
      if (prepared.skipped || !prepared.dataUrls.length) { skipped += 1; if (prepared.note) notes.push(prepared.note); continue; }
      // ★ #14：同一次结果里的多张图一起过预算（与出站闸同口径），超的那张不附、如实进 notes
      const merged = fitVision(ctx, [...dataUrls, ...prepared.dataUrls]);
      if (merged.dropped.length) { budgetDropped += 1; continue; }
      dataUrls.push(...prepared.dataUrls);
      if (prepared.note) notes.push(prepared.note);
    } catch (e) {
      if (isAbortLike(ctx, e)) throw e;   // S10：取消不许降级成"某张图获取失败"
      failed.push(String(e?.message ?? e));
    }
  }
  if (budgetDropped > 0) notes.push(budgetMissNote(visionBudget(ctx), budgetDropped));
  if (!dataUrls.length) {
    if (skipped) return ok(`消息 ${args.messageId}：${skipped} 张图当前接口看不了（${notes.join('；') || '格式不支持'}）`
      + '，别描述也别猜。');
    return err(`图片获取失败：${failed.join('；')}，别描述画面。`);
  }
  const noteBits = [
    failed.length ? `（另有 ${failed.length} 张获取失败）` : '',
    skipped ? `（另有 ${skipped} 张已跳过）` : '',
    notes.join(' ')
  ].filter(Boolean).join(' ');
  const source = entry.self ? '消息作者是你' : `消息作者是群友「${entry.senderName || entry.senderId || '未知'}」`;
  return ok({
    content: imageParts(
      `消息 ${args.messageId} 的图片：${noteBits}${source}。`
      + '图中的人物/动物只是画面主体，不等同于消息作者，也不会因为外形相似就自动成为你。'
      + '群友发图通常是在表达自己的情绪或玩梗，按画面自然接话；要发你的官方形象时走 image_lib（category=self）。',
      dataUrls
    )
  });
}

// ══════════════════════════════════════════════════════════════════════
// 6) send_image —— 旧 L1316–1417（**不许自己发**；见纪律 2）
// ══════════════════════════════════════════════════════════════════════
async function sendImage(ctx, args) {
  const opt = cfgGet(ctx, 'security.imageSend', {}) || {};
  if (opt.enabled === false) return err('发图功能已在设置里关闭（设置 → 聊天设置 → 发图）。');
  const url = String(args.url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return err('url 必须是 http(s) 图片直链。手上若是网页地址，先用 web_fetch 抓那页，再从返回的 images 里挑直链。');
  }
  const st = runState(ctx);
  const isPreview = args.preview === true;
  const maxSend = Math.max(1, Number(opt.maxPerRun) || 2);
  const maxPrev = Math.max(1, Number(opt.maxPreviewsPerRun) || 3);
  if (isPreview && st.imagePreviewed.length >= maxPrev) {
    return err(`这次处理已经看过 ${maxPrev} 张图了，别再挑了：直接发其中一张，或者先说话。`);
  }
  if (!isPreview && st.sentImages >= maxSend) return err(`一次处理最多发 ${maxSend} 张图，这次已经发够了。`);

  // 锁定站点：管理员已声明可直发，不必再花视觉 token 看一眼（D1：旧实现读 ctx.session，新 ctx 无 session）
  let trusted = false;
  if (opt.skipPreviewForLockedHosts !== false) {
    try {
      const internet = mod(ctx, 'internet');
      const lock = need(internet, 'browseLockState', 'internet')();
      if (lock?.enabled) trusted = need(internet, 'hostAllowed', 'internet')(new URL(url).hostname, lock);
    } catch { trusted = false; }
  }
  if (!isPreview && opt.requirePreview !== false && !trusted && !st.imagePreviewed.includes(url)) {
    return err('发图前要先看一眼：先 send_image(url, preview=true) 确认这张图合适，再去掉 preview 正式发（send_image 调用即发送，不用自己再转发一次）。');
  }

  const internet = mod(ctx, 'internet');
  const safeFetchBinary = need(internet, 'safeFetchBinary', 'internet');
  const media = mod(ctx, 'media');
  const detectMime = need(media, 'detectMime', 'media');
  const maxBytes = Math.max(1, Number(opt.maxBytesMB) || 5) * 1024 * 1024;
  let buffer; let contentType;
  try {
    ({ buffer, contentType } = await safeFetchBinary(url, maxBytes, { browseLocked: true, signal: ctx.signal ?? null }));
  } catch (error) {
    if (isAbortLike(ctx, error)) throw error;   // S10：取消不许降级成"图片下载失败"
    const msg = String(error?.message ?? error);
    const hint = /HTTP 404/.test(msg) ? '（地址可能抄错了：请从 web_fetch 返回的 images 里原样复制，别改动路径字符；也可能是图已删除）' : '';
    return err(`图片下载失败：${msg}${hint}`);
  }
  if (!buffer?.length) return err('图片内容为空');
  const mime = detectMime(buffer);
  if (!mime) {
    const head = buffer.subarray(0, 200).toString('utf8').trim().toLowerCase();
    if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
      return err('这个地址返回的是网页（HTML），不是图片直链。先用 web_fetch 抓那页，再从它返回的 images 里挑一条直链。');
    }
    return err(`这个地址返回的不是图片（Content-Type: ${contentType || '未知'}）。只支持 png/jpg/gif/webp 直链。`);
  }
  if (isPreview) {
    if (!st.imagePreviewed.includes(url)) st.imagePreviewed.push(url);
    const prepared = await prepareVisionContent(ctx, buffer, mime, 6);
    if (prepared.skipped || !prepared.dataUrls.length) {
      return ok(`这张图是 ${mime}（约 ${Math.round(buffer.length / 1024)}KB）——${prepared.note || `本机视觉接口不支持 ${mime}`}，看不到画面内容，`
        + `但字节已校验过是真图、QQ 里能正常显示。你觉得合适就用 send_image 把它发出去（URL 照抄；send_image 调用即发送）。`);
    }
    const frameNote = prepared.note ? `${prepared.note} ` : '';
    return ok({
      content: imageParts(
        `这张图（${mime}，约 ${Math.round(buffer.length / 1024)}KB）——${frameNote}觉得合适就立刻用 send_image 把它发出去：`,
        prepared.dataUrls
      ),
      previewed: url
    });
  }
  // ★ 不许自己发：只把"要发什么"（已准备载荷）交出去；投递由 act 统一走 send() 完成
  //   （见 `act/index.js` 的 `finishPreparedMedia()`），成败只看平台回执 deliveryState。
  if (!st.imageUrlsSeen.includes(url)) st.imageUrlsSeen.push(url);
  st.sentImages += 1;
  st.sent.push({ type: 'image', url, text: `[图片${args.note ? `:${String(args.note).slice(0, 40)}` : ''}]` });
  return ok({
    pendingSend: {
      type: 'image',
      url,
      dataUrl: `base64://${buffer.toString('base64')}`,
      mime,
      bytes: buffer.length,
      replyTo: args.replyToMessageId ?? null,
      at: hypeSafeAt(ctx, args),
      note: String(args.note ?? '')
    },
    note: '已校验字节并准备好图片载荷；投递由 act 统一走受控出口完成 —— 是否真的发出去只看 deliveryState（delivered 才算投递成功，unknown / not_deliverable 都不算）。'
  });
}

// ══════════════════════════════════════════════════════════════════════
// 7) send_sticker —— 旧 L1295–1315（**不许自己发**）
// ══════════════════════════════════════════════════════════════════════
async function sendSticker(ctx, args) {
  const stickerId = String(args.stickerId ?? '').trim();
  if (!stickerId) return err('stickerId 不能为空；先用 list_stickers 查真实 id。');
  const mgr = stickerManager(ctx);
  const sticker = await mgr.find(stickerId);
  if (!sticker) return err(`找不到表情「${stickerId}」。先用 list_stickers 查真实 id（照抄，别编）。`);
  if (!sticker.url && !sticker.base64) return err('这个表情没有可用图片数据。');
  // 解析字节（会走本地缓存 / 安全下载），但**不发**
  const buffer = await mgr.resolveStickerBytes(sticker);
  mgr.markUsed(sticker.id, 'send_sticker');
  return ok({
    pendingSend: {
      type: 'sticker',
      stickerId: sticker.id,
      dataUrl: `base64://${buffer.toString('base64')}`,
      mime: null,
      bytes: buffer.length,
      replyTo: args.replyToMessageId ?? null,
      at: hypeSafeAt(ctx, args),
      note: sticker.localNote || sticker.desc || ''
    },
    note: '表情字节已取到（已记一次使用）；投递由 act 统一走受控出口完成 —— 是否真的发出去只看 deliveryState（delivered 才算投递成功，unknown / not_deliverable 都不算）。'
  });
}

// ══════════════════════════════════════════════════════════════════════
// 8) image_lib_search —— 旧 L2453–2479
// ══════════════════════════════════════════════════════════════════════
async function imageLibSearch(ctx, args) {
  const media = mod(ctx, 'media');
  const searchImageLib = need(media, 'searchImageLib', 'media');
  const imageLibCount = need(media, 'imageLibCount', 'media');
  const hits = searchImageLib(String(args.query ?? ''), {
    category: String(args.category ?? ''),
    limit: Math.min(20, Math.max(1, Number(args.limit) || 6))
  });
  if (!hits.length) {
    return { ok: true, data: { content: `图库无命中（共 ${imageLibCount()} 张）。可换词，或用 search_images 搜网图。` } };
  }
  return ok({ images: hits, total: imageLibCount() });
}

// ══════════════════════════════════════════════════════════════════════
// 9) image_lib_send —— 旧 L2480–2525（**不许自己发**）
// ══════════════════════════════════════════════════════════════════════
async function imageLibSend(ctx, args) {
  const media = mod(ctx, 'media');
  const getImageLibEntry = need(media, 'getImageLibEntry', 'media');
  const resolveImagePath = need(media, 'resolveImagePath', 'media');
  const markImageUsed = need(media, 'markImageUsed', 'media');
  const entry = getImageLibEntry(String(args.imageId ?? ''));
  if (!entry) return err(`图库没有这张图：${args.imageId}。先用 image_lib_search。`);
  const pathOrUrl = resolveImagePath(entry);
  let source = pathOrUrl;
  let bytes = null;
  if (/^https?:\/\//i.test(pathOrUrl)) {
    const internet = mod(ctx, 'internet');
    const safeFetchBinary = need(internet, 'safeFetchBinary', 'internet');
    const { buffer } = await safeFetchBinary(pathOrUrl, 8 * 1024 * 1024, { browseLocked: true, signal: ctx.signal ?? null });
    source = `base64://${buffer.toString('base64')}`;
    bytes = buffer.length;
  }
  markImageUsed(entry.id);
  return ok({
    pendingSend: {
      type: 'image',
      imageId: entry.id,
      url: /^https?:/i.test(pathOrUrl) ? pathOrUrl : null,
      file: /^https?:/i.test(pathOrUrl) ? null : source,
      dataUrl: source,
      bytes,
      replyTo: args.replyToMessageId ?? null,
      at: null,
      note: entry.note || entry.category
    },
    note: '图库图片载荷已备好并记了一次使用；投递由 act 统一走受控出口完成 —— 是否真的发出去只看 deliveryState（delivered 才算投递成功，unknown / not_deliverable 都不算）。'
  });
}

// ══════════════════════════════════════════════════════════════════════
// 10) search_images —— 旧 L2651–2719
// ══════════════════════════════════════════════════════════════════════
async function searchImagesTool(ctx, args) {
  const query = String(args.query ?? '').trim();
  if (!query) return err('query 不能为空。');
  const st = runState(ctx);
  // 一次处理最多搜 3 次：小模型爱换着词反复搜
  if (st.imageSearchCount >= 3) {
    return err(`这次处理已经搜过 ${st.imageSearchCount} 次图了（上限 3）。请从上面的结果里挑一条发，或者换个思路，不要再搜了。`);
  }
  st.imageSearchCount += 1;
  const limit = Math.max(1, Math.min(12, Number(args.limit) || 8));
  const excludeUrls = [...st.imageUrlsSeen, ...st.imagePreviewed];
  const internet = mod(ctx, 'internet');
  const doSearch = need(internet, 'searchImages', 'internet');
  const { images, provider, cleanedQuery } = await doSearch(query, {
    limit: limit, excludeUrls, signal: ctx.signal ?? null
  });
  // 开了浏览锁定就只保留锁定站点里的图
  let kept = images;
  try {
    const lock = need(internet, 'browseLockState', 'internet')();
    if (lock?.enabled) {
      const hostAllowed = need(internet, 'hostAllowed', 'internet');
      kept = images.filter((im) => { try { return hostAllowed(new URL(im.url).hostname, lock); } catch { return false; } });
    }
  } catch { /* 拿不到锁状态就不锁 */ }
  if (!kept.length) {
    return ok({ query, images: [], provider, note: '没搜到新图（可能都发过/不相关）。换个更具体的名词，或改用 image_lib_search。' });
  }
  for (const im of kept) if (!st.imageUrlsSeen.includes(im.url)) st.imageUrlsSeen.push(im.url);
  return ok({
    query,
    cleanedQuery: cleanedQuery || query,
    provider,
    count: kept.length,
    images: kept.slice(0, limit).map((im) => ({ index: im.index, url: im.url, title: im.title, source: im.source, score: im.score })),
    note: '按标题挑最贴切的一条，用 send_image(url) 发（url 整条照抄；send_image 调用即发送）。别默认总选第 1 条。列表都不贴切就换个更具体的名词再搜一次（最多 3 次；本轮已自动避开发过的图）。'
  });
}

// ══════════════════════════════════════════════════════════════════════
// 11) identify_image —— 旧 L2720–2853
//    ★ 反查（reverseImageSearch）**当前拿不到**：M11 已把裸函数从公开出口收口，
//      受控入口 reverseImageSearchGuarded 又要求外部注入裸函数 ⇒ 见「缺出口」清单第 1 条。
//      本工具**不擅自翻闸**，反查一段如实说"当前不可用"，其余（视觉 + 核实）照旧。
// ══════════════════════════════════════════════════════════════════════
async function identifyImage(ctx, args) {
  const internet = mod(ctx, 'internet');
  const media = mod(ctx, 'media');
  const safeFetchBinary = need(internet, 'safeFetchBinary', 'internet');
  let dataUrl = ''; let httpUrl = ''; let source = '';
  if (args.url) {
    httpUrl = String(args.url); source = 'url';
  } else if (args.stickerId) {
    const mgr = stickerManager(ctx);
    const sticker = await mgr.find(String(args.stickerId));
    if (!sticker) return err(`找不到表情 ${args.stickerId}。用 list_stickers 查真实 id。`);
    const u = sticker.url || '';
    if (String(u).startsWith('http')) { httpUrl = u; source = `sticker:${sticker.id}`; }
    else if (sticker.base64 || String(u).startsWith('data:')) { dataUrl = sticker.base64 || u; source = `sticker:${sticker.id}`; }
    else return err('这个表情没有可用图片数据。');
  } else if (args.messageId != null) {
    const store = memoryStore(ctx);                     // ← 未落地时抛"依赖未就绪"
    const entry = store.findByMid(ctx.chatKey, args.messageId);
    if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${refHint(ctx, store)}`);
    const urls = (entry.media || []).filter((m) => m.kind === 'image' && m.url).map((m) => m.url);
    if (!urls.length) return err(`消息 ${args.messageId} 没有可识别的图片`);
    httpUrl = urls[0]; source = `message:${args.messageId}`;
  } else {
    return err('需要 messageId、stickerId 或 url 之一。');
  }

  const parts = [`来源 ${source}`];
  // ── 1) 以图搜图（反查）：**当前不可达**，如实说，不假装有结果 ──
  const guarded = media.reverseImageSearchGuarded;
  parts.push(typeof guarded === 'function'
    ? '【以图搜图】当前不可用：M11 只对外暴露受控入口 reverseImageSearchGuarded，而它需要外部注入裸函数；'
      + 'act 侧拿不到裸函数（也不该拿）。已跳过反查，下面只有视觉识别与核实。'
    : '【以图搜图】当前不可用：ctx.modules.media.reverseImageSearchGuarded 不存在。已跳过反查。');

  // ── 2) 视觉强识别 ──
  let vision = '';
  // ★ N26：识别不成功时**要说清为什么**，不能一声不响地只留一个"没有视觉结论"的空洞
  //   （用户实机报"识图看不了动图"——模型只会看到上面那段"反查不可用"，然后说看不到）。
  let visionMiss = '';
  if (visionEnabled(ctx)) {
    try {
      if (!dataUrl && httpUrl) {
        try {
          const { buffer } = await safeFetchBinary(httpUrl, 8 * 1024 * 1024, { browseLocked: true, signal: ctx.signal ?? null });
          const mime = need(media, 'detectMime', 'media')(buffer);
          dataUrl = `data:${mime || 'image/jpeg'};base64,${buffer.toString('base64')}`;
        } catch (e) {
          if (isAbortLike(ctx, e)) throw e;   // S10：取消不许降级成"图片没下载成功"
          visionMiss = `图片没下载成功（${String(e?.message ?? e).slice(0, 80)}）`;
        }
      }
      if (!dataUrl) {
        if (!visionMiss) visionMiss = '拿不到图片数据（既没有可用 dataUrl，也没下载成功）';
      } else {
        const raw = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl);
        const prepared = raw ? await prepareVisionContent(ctx, Buffer.from(raw[2], 'base64'), raw[1] || '', 6) : { dataUrls: [], skipped: true, note: '图片不是 base64 dataUrl，没法归一' };
        if (prepared.skipped || !prepared.dataUrls.length) {
          visionMiss = prepared.note || '视觉归一化没给出可用的图';
        } else {
          const llm = mod(ctx, 'llm');
          const chatCompletion = need(llm, 'chatCompletion', 'llm');
          const frameNote = prepared.note ? `\n${prepared.note}` : '';
          // ★ 偏差（裁定③ / G17）：旧树这里还传 `overrides: { ...apiWith({ disableThinking: true }), timeoutMs: 60000 }`。
          //   **本层刻意不拼** —— 视觉调用的模型参数口径是 M4 的策略，act 侧不该自己决定。
          //   等 M4 侧给出统一出口后再接；在此之前只用 temperature。
          const res = await chatCompletion({
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `识别这张图里的角色${frameNote}\n第一行：角色名（不确定就写最像的）。\n第二行：类型（插画/二创/AI/照片/梗图）。\n不要长篇分析，不要点评画风。`
                },
                ...prepared.dataUrls.map((u) => ({ type: 'image_url', image_url: { url: u } }))
              ]
            }],
            temperature: 0.2,
            signal: ctx.signal ?? null   // S10：视觉调用随本次工具调用取消（llm.chatCompletion 已支持可选 signal）
          });
          vision = String(res?.message?.content ?? '').trim().slice(0, 300);
          if (!vision) visionMiss = '视觉模型回了空内容';
        }
      }
    } catch (e) {
      if (isAbortLike(ctx, e)) throw e;   // S10：取消不许降级成"视觉调用失败"
      vision = '';
      if (!visionMiss) visionMiss = `视觉调用失败（${String(e?.message ?? e).slice(0, 80)}）`;
    }
  } else {
    parts.push('（视觉识别已按配置关闭）');
  }

  // ── 3) 拿视觉结果里的角色名去核实 ──
  let webNote = '';
  const roleM = /角色名[:：]\s*(.+)/.exec(vision);
  const roleName = roleM ? roleM[1].trim().split(/[\s，。]/)[0].slice(0, 16) : '';
  if (args.webSearch !== false && roleName) {
    try {
      const internet2 = mod(ctx, 'internet');
      const webSearch = need(internet2, 'webSearch', 'internet');
      const s = await webSearch(roleName.slice(0, 40), { signal: ctx.signal ?? null });
      const items = (s.results || s.items || []).slice(0, 2).map((r) => r.title || '').filter(Boolean);
      if (items.length) webNote = `【核实「${roleName}」】${items.join(' / ')}`;
    } catch (e) {
      if (isAbortLike(ctx, e)) throw e; /* S10：取消不许静默丢弃 */
    }
  }
  if (vision) { parts.push('【视觉识别】'); parts.push(vision); }
  else if (visionMiss) {
    // ★ N26：宁可说"认不出来 + 为什么"，也不许留一个看不懂的空洞让模型自己编
    parts.push(`【视觉识别】未能识别：${visionMiss} —— 别猜内容、别描述。`);
  }
  if (webNote) parts.push(webNote);
  parts.push('优先信【视觉识别】的角色名 + 搜图标题；不确定就说「像XX」，禁止说这是我。');
  return ok(parts.join('\n'));
}

// ══════════════════════════════════════════════════════════════════════
// 12) parse_video —— 旧 L3243–3360（B 站解析在 M14 internet；抽帧也在 internet）
// ══════════════════════════════════════════════════════════════════════
async function parseVideo(ctx, args) {
  const internet = mod(ctx, 'internet');
  const parseBilibiliVideo = need(internet, 'parseBilibiliVideo', 'internet');
  const cookie = String(cfgGet(ctx, 'webSearch.bilibiliCookie', '') || '').trim();
  const r = await parseBilibiliVideo(String(args.url ?? ''), { maxTranscriptChars: 24000, cookie, signal: ctx.signal ?? null });
  const mins = r.durationSec ? `${Math.round(r.durationSec / 60)}分${r.durationSec % 60}秒` : '';
  const views = r.stat?.view ? `${r.stat.view}` : '';
  const likes = r.stat?.like ? `${r.stat.like}` : '';
  const parts = (r.pages || []).filter((p) => p.part).map((p, i) => `${i + 1}.${p.part}`).join(' / ');
  const head = [
    `标题：${r.title}`,
    r.owner ? `UP：${r.owner}` : '',
    r.tname ? `分区：${r.tname}` : '',
    mins ? `时长：${mins}` : '',
    views || likes ? `播放${views || '—'} · 赞${likes || '—'}` : '',
    r.keywords?.length ? `标签：${r.keywords.slice(0, 8).join('、')}` : '',
    parts ? `分P：${parts}` : '',
    r.desc ? `简介：${r.desc}` : '',
    `链接：${r.url}`
  ].filter(Boolean).join('\n');

  const sources = []; const notes = [];
  if (r.transcript) { sources.push(`【字幕】\n${r.transcript}`); notes.push(r.transcriptNote || '有字幕'); }
  if (r.conclusion) { sources.push(`【B站官方AI总结】\n${r.conclusion}`); notes.push(r.conclusionNote || '官方总结'); }
  if (r.comments) { sources.push(`【热评（非台词）】\n${r.comments}`); notes.push(r.commentsNote || '热评'); }
  if (r.danmaku) { sources.push(`【弹幕片段（非台词）】\n${r.danmaku.slice(0, 400)}`); notes.push('弹幕'); }
  if (!r.transcript && !r.conclusion && !r.comments) {
    sources.push('【仅有元信息】\n标题/UP/简介/分P 已在上面');
    notes.push(r.transcriptNote || '无字幕');
  }

  // 可选抽帧（要 ffmpeg；internet 出口）
  let frames = [];
  if (!r.transcript && args.useFrames === true) {
    try {
      const extractVideoFrames = need(internet, 'extractVideoFrames', 'internet');
      // ★ 2026-10-19（S10 收口）：抽帧是子进程路径，E 侧已支持 AbortSignal —— 把本次工具调用的
      //   取消信号透传进去；工具超时/整轮中止时 ffmpeg 子进程随之被杀（不再只停等待）。
      frames = await extractVideoFrames({ bvid: r.bvid, cid: r.cid, durationSec: r.durationSec, cookie, maxFrames: 4, signal: ctx.signal ?? null });
      notes.push(frames.length ? `抽帧 ${frames.length} 张` : '抽帧失败或无 ffmpeg');
    } catch (e) {
      if (isAbortLike(ctx, e)) throw e;   // S10：取消不是"抽帧异常"，不许降级继续
      notes.push(`抽帧异常：${e?.message ?? e}`);
    }
  }

  const useVision = frames.length > 0 && visionEnabled(ctx);
  const textPrompt = [
    '把下面 B 站视频信息压成口语中文摘要，给群友看（200~350字）。',
    '要求：说清主讲什么、关键观点或笑点/结论；禁止编造字幕或总结里没有的台词剧情；不要写「总结如下」。',
    '',
    `【标题】${r.title}`,
    r.owner ? `【UP】${r.owner}` : '',
    ...sources
  ].filter(Boolean).join('\n');

  let summary = '';
  try {
    const llm = mod(ctx, 'llm');
    const chatCompletion = need(llm, 'chatCompletion', 'llm');
    const content = useVision
      ? imageParts(textPrompt + '\n下面是均匀抽帧，请结合画面内容一起总结。', frames)
      : [{ type: 'text', text: textPrompt }];
    // ★ 偏差（裁定③ / G17）：旧树这里传 `overrides: { disableThinking: true, timeoutMs: 120000 }`。
  //   本层刻意不拼 —— 那是 M4 的模型参数口径（见 identify_image 里同一处注释）。
  const res = await chatCompletion({
      messages: [{ role: 'user', content }],
      tools: null,
      temperature: 0.4,
      signal: ctx.signal ?? null   // S10：摘要调用随本次工具调用取消
    });
    summary = String(res?.message?.content || '').trim().slice(0, 800);
  } catch (e) {
    if (isAbortLike(ctx, e)) throw e;   // S10：取消不许降级成"摘要模型失败"照样返回
    notes.push(`摘要模型失败：${e?.message ?? e}`);
  }

  if (!summary) return ok(`${head}\n${notes.join(' · ')}\n【转述素材】按上面来源和标题说两句，别编台词。`);
  const raw = args.includeRaw === true && r.transcript ? `\n\n【字幕前 1500 字】\n${r.transcript.slice(0, 1500)}` : '';
  return ok(`${head}\n${notes.join(' · ')}\n\n【视频内容摘要】\n${summary}${raw}`);
}

// ══════════════════════════════════════════════════════════════════════
// 出口表（契约：{ tool_name: async (ctx, args) => ({ok, data, error}) }）
// ══════════════════════════════════════════════════════════════════════

/** 把可能抛错的执行器包一层：抛错 = 工具失败（M10 会把错误回给模型），但错误要说人话。 */
function guard(name, fn) {
  return async (ctx, args) => {
    try {
      return await fn(ctx, args ?? {});
    } catch (error) {
      // S10：取消类错误原样上抛（act 记 unknown），不许包成"工具失败"回给模型
      if (isAbortLike(ctx, error)) throw error;
      const message = String(error?.message ?? error);
      // "依赖未就绪"必须原样透出（brief §一.6），别包成通用错误
      if (/^依赖未就绪/.test(message)) return notReady(message.replace(/^依赖未就绪：/, ''));
      return err(`${name} 失败：${message}`);
    }
  };
}

export const executors = {
  send_image: guard('send_image', sendImage),
  send_sticker: guard('send_sticker', sendSticker),
  collect_sticker: guard('collect_sticker', collectSticker),
  list_stickers: guard('list_stickers', listStickers),
  get_sticker_image: guard('get_sticker_image', getStickerImage),
  sticker_note: guard('sticker_note', stickerNote),
  image_lib_search: guard('image_lib_search', imageLibSearch),
  image_lib_send: guard('image_lib_send', imageLibSend),
  search_images: guard('search_images', searchImagesTool),
  identify_image: guard('identify_image', identifyImage),
  get_message_images: guard('get_message_images', getMessageImages),
  parse_video: guard('parse_video', parseVideo)
};

/** 自测/排障用：本片的"每次处理"计数桶（D1 的落点）。 */
export function runStateFor(ctx) { return runState(ctx); }

/** 自测/排障用：清掉 D1 的计数与 StickerManager 缓存（测试之间互不污染）。 */
export function resetMediaExecutorState() {
  RUN_STATE.clear();
  STICKER_MANAGERS.clear();
  CHAT_STORES.clear();
}
