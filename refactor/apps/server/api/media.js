/**
 * 控制台 API · 分片 S2「媒体与素材库」—— 契约见 .tmp-dispatch/ui-api-slices-brief.md §一
 *
 * 归属路径（旧树 `src/app.js` 的 `handleHttp` 逐条对应）：
 *   /api/images-lib            L3045 GET / L3056 POST / L3086 DELETE
 *   /api/images-lib/preview    L3093 GET          ← ⚠ 见下方「超出清单的一条」
 *   /api/memes                 L3167 GET / L3172 POST / L3183 DELETE
 *   /api/memes/pin             L3189 POST
 *   /api/memes/export          L3203 POST
 *   /api/stickers/annotate     L2337 GET / L2343 POST
 *   /api/media-data            L3489 POST
 *   /api/knowledge             L3023 GET
 *   /api/knowledge-import/read L3225 POST
 *   /api/pet-skins             L1600 GET          → T-PETSKINS-ROOTS 已搬（显式双根 + 单例 registry）
 *   /api/plugin/:id/panel(/f)  L1821 GET          （说明书写作 /api/plugin/:id）
 *   /plugin-assets/*           L1431 GET          ← ⚠ 旧树**没有 /api 前缀**
 *   /pet-skin-assets/<id>/<p>  L1472-1558 GET/HEAD ← ⚠ T-MI1-PET-ASSETS 补（同样无 /api 前缀）
 *   /pet-legacy-assets/<file>  L1562-1579 GET/HEAD ← ⚠ 同上
 *
 * ── 铁律（照说明书 §二）──────────────────────────────────────────────
 * 1. 只走公开出口：`ctx.modules.<模块>.<出口>` / `ctx.configStore`；本文件**不 import `src/**`**，
 *    也不 import 兄弟模块的内部文件（只 import 本 apps/server 自己的 `../paths.js`，与 console-api.js 同做法）。
 * 2. 能力没就绪 ⇒ 501 + `{ok:false, error:'not-ported: <缺什么>'}`。**绝不**返回空数组假装"没有数据"。
 * 3. 错误不许吞成 200：抛了 ⇒ 500 + 错误原文。
 *    ★ `/api/media-data` 的**逐张**失败不算错误：协议端没缓存、URL 过期都按旧树语义回 `null` 占位
 *      （前端保留原 URL，见下方 :423/:429 两处注释）；整条端点级失败（缺 ctx.platform 等）才走 501/500。
 * 4. 不抢实例锁、不碰生产数据目录：dataDir 由 `ctx.dataDir` 显式注入，经 `resolveDataDir` 校验。
 *
 * ── 两处与说明书的出入（如实登记，等指挥位裁定）──────────────────────
 * A. **`/plugin-assets/*` 旧树没有 `/api` 前缀**。旧 L1431 是 `/^\/plugin-assets\/…/`，UI 调的也是
 *    `/plugin-assets/…`（`refactor/apps/ui/app.js:3281` 与 `:10333`）。说明书写的是 `/api/plugin-assets/*`。
 *    ⇒ 本分片**两个都认**（`/api/plugin-assets/*` 作为别名），以旧树那个为主。
 * B. **`/api/images-lib/preview` 超出说明书清单**，但我实现了：`GET /api/images-lib` 返回的每条
 *    `preview` 字段在"本地图"情况下就是 `/api/images-lib/preview?id=…`（旧 L3042）。
 *    不实现它 ⇒ 图库里所有本地图在 UI 里全挂。它算 `/api/images-lib` 的子路径，故留在本片；
 *    **若指挥位认为超清单，请说一声我摘掉**。
 *
 * ── 给分发器的约定（mimo 的 http.js 归他）─────────────────────────
 * · JSON 路径：返回 `{status, headers:{'content-type':'application/json; charset=utf-8'}, body: '<json>'}`。
 * · **静态资源路径**（plugin-assets / images-lib preview）：返回
 *   `{status, headers:{'content-type': <mime>, ...}, body: <Buffer>, binary: true}`。
 *   `binary:true` + Buffer 是本分片引入的新形状 —— 分发器需要能把它直接写出去；
 *   若分发器只认字符串 body，请找我改成别的约定（别自己猜着改）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir, REPO_ROOT, PET_SKINS_ROOT, PET_SKINS_USER_ROOT } from '../paths.js';

// ── 小工具（与 console-api.js 同风格）──────────────────────────────────

function json(status, obj) {
  const body = JSON.stringify(obj, null, 2);
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(body)) },
    body
  };
}

function notPorted(what) {
  return json(501, { ok: false, error: `not-ported: ${what}` });
}

function errorResponse(e) {
  return json(500, { ok: false, error: String(e?.message ?? e) });
}

function binary(status, mime, buf, extra = {}) {
  return {
    status,
    headers: { 'content-type': mime, 'content-length': String(buf.length), ...extra },
    body: buf,
    binary: true
  };
}

/** ctx.modules 取模块（兼容 Map 与对象两种形态，与 console-api.js 一致）。 */
function getMod(ctx, name) {
  const mods = ctx?.modules;
  if (!mods) return null;
  if (typeof mods.get === 'function') return mods.get('modules/' + name) ?? mods.get(name) ?? null;
  return mods[name] ?? null;
}

/** 取 M11 出口；缺了 ⇒ 抛一条能让 501 说清缺什么的错误。 */
function media(ctx) {
  const m = getMod(ctx, 'media');
  if (!m) throw Object.assign(new Error('not-ported: ctx.modules.media（M11 未注入）'), { notPorted: true });
  return m;
}
function need(m, name, modName) {
  if (typeof m[name] !== 'function') {
    throw Object.assign(new Error(`not-ported: ctx.modules.${modName}.${name}（该出口不存在）`), { notPorted: true });
  }
  return m[name].bind(m);
}

/** dataDir：必须显式注入，且过生产目录硬闸（铁律 4）。 */
function dataDirOf(ctx) {
  try {
    return resolveDataDir(ctx?.dataDir, { allowProductionData: ctx?.allowProductionData === true });
  } catch (e) {
    throw Object.assign(new Error(`not-ported: ${e.message}`), { notPorted: true });
  }
}

/** StickerManager 实例按 dataDir 缓存（M11 导出的是类，旧树给的是一个已建好的实例）。 */
const STICKER_MANAGERS = new Map();
function stickerManager(ctx) {
  const m = media(ctx);
  const Manager = m.StickerManager;
  if (typeof Manager !== 'function') {
    throw Object.assign(new Error('not-ported: ctx.modules.media.StickerManager（M11 未导出该类）'), { notPorted: true });
  }
  const platform = ctx?.platform ?? ctx?.onebot;
  if (!platform || typeof platform.call !== 'function') {
    throw Object.assign(new Error('not-ported: ctx.platform（StickerManager 需要一个只读协议端实例）'), { notPorted: true });
  }
  const key = String(ctx?.dataDir ?? 'default');
  if (!STICKER_MANAGERS.has(key)) STICKER_MANAGERS.set(key, new Manager(platform));
  return STICKER_MANAGERS.get(key);
}

/** 补备注任务的进度状态（旧树 src/app.js 里那个 `stickerAnnotate` 模块级对象）。 */
const annotateState = { running: false, done: 0, failed: 0, total: 0 };

function mimeOfImage(p) {
  const e = path.extname(String(p)).toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.gif') return 'image/gif';
  if (e === '.webp') return 'image/webp';
  return 'image/jpeg';
}

/** 静态资源的 content-type（旧 L1448 的口径，一字不差）。 */
function mimeOfAsset(p) {
  const ext = path.extname(String(p)).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

/**
 * 目录穿越闸（照旧树 L1437-1446 的口径，一字不差）：
 * ① rel 按 `[\\/]` 拆段，任一段为空 / `.` / `..` / 含 `:` ⇒ 400；
 * ② realpath(root) 与 realpath(full) 双重校验，必须仍在 root 之下；
 * ③ 必须是 isFile()。
 * `decoded:true` = 调用点已自己 decodeURIComponent 过（桌宠皮肤那条：旧树对解码失败回 400、
 * 对"解出来不合法"回 404，两种状态码要分开 ⇒ 解码必须在调用点做，这里就不再解一次）。
 */
function resolveInside(rootDir, rel, { decoded = false } = {}) {
  let target = rel;
  if (!decoded) {
    try { target = decodeURIComponent(rel); } catch { return { error: { status: 400, error: '资源路径编码无效' } }; }
  }
  const parts = target.split(/[\\/]/);
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) {
    return { error: { status: 400, error: '资源路径不合法' } };
  }
  let root; let full;
  try {
    root = fs.realpathSync(rootDir);
    full = fs.realpathSync(path.resolve(root, ...parts));
  } catch {
    return { error: { status: 404, error: '资源不存在' } };
  }
  if (!full.startsWith(root + path.sep) || !fs.statSync(full).isFile()) {
    return { error: { status: 404, error: '资源不存在' } };
  }
  return { full };
}

// ══════════════════════════════════════════════════════════════════════
// 图库 /api/images-lib（旧 L3032-3115）
// ══════════════════════════════════════════════════════════════════════
async function imagesLib(ctx, method, query, body) {
  const m = media(ctx);
  const listImageLib = need(m, 'listImageLib', 'media');
  const imageLibCount = need(m, 'imageLibCount', 'media');
  const resolveImagePath = need(m, 'resolveImagePath', 'media');
  const imagePreviewUrl = (img) => {
    const src = String(img?.url || img?.localFile || '');
    if (/^https?:\/\//i.test(src)) return src;
    if (/^https?:\/\//i.test(resolveImagePath(img) || '')) return resolveImagePath(img);
    return `/api/images-lib/preview?id=${encodeURIComponent(img.id)}`;
  };

  if (method === 'GET') {
    const category = query.get('category') || '';
    const limit = Number(query.get('limit')) || 80;
    const images = listImageLib({ category, limit }).map((img) => ({
      ...img,
      preview: imagePreviewUrl(img),
      local: !/^https?:\/\//i.test(String(img.url || ''))
    }));
    return json(200, { images, total: imageLibCount() });
  }

  if (method === 'POST') {
    const addImageLib = need(m, 'addImageLib', 'media');
    const saveImageFromDataUrl = need(m, 'saveImageFromDataUrl', 'media');
    const tags = (Array.isArray(body?.tags) ? body.tags : String(body?.tags || '').split(/[,，]/))
      .map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
    const note = String(body?.note || '').slice(0, 160);
    const category = String(body?.category || 'other');
    let urlOrPath = String(body?.url || body?.localPath || body?.localFile || '').trim();
    if (!urlOrPath && body?.dataUrl) {
      const saved = saveImageFromDataUrl(String(body.dataUrl));
      if (!saved.ok) return json(400, { ok: false, error: saved.error });
      urlOrPath = saved.localFile;
    }
    if (!urlOrPath) return json(400, { ok: false, error: '需要：图片文件 / 公网 URL / 本地路径' });
    // ★ 2026-10-17（ds1）：本地路径只收 dataDir 之内的（见文件尾部 pathInsideDataDir 的说明）。
    // ★ 2026-10-18（#7 体验）：**闸不放行**，但把"怎么才能导入外部图片"说清楚 ——
    //   面板的「选择文件/拖入」会把文件读成 dataURL 上传，服务端复制进 <dataDir>/images-lib/files/；
    //   这是用户主动选择的授权通路，不属于"任意本机路径读取"。
    if (!/^https?:\/\//i.test(urlOrPath) && !pathInsideDataDir(ctx, urlOrPath)) {
      return json(400, {
        ok: false,
        error: '本机路径不能直接导入（图库只读当前实例数据目录，防任意文件读取）：'
          + '请在「图库」里用「选择文件」或把图片拖进去（会自动复制到 data/images-lib/files/），或填写公网 http(s) 图片 URL'
      });
    }
    const r = addImageLib({
      id: body?.id || '',
      url: urlOrPath,
      localFile: body?.dataUrl || !/^https?:\/\//i.test(urlOrPath) ? urlOrPath : String(body?.localFile || ''),
      tags, note, category
    });
    if (!r.ok) return json(400, { ok: false, error: r.error || '导入失败' });
    return json(200, { ok: true, image: { ...r.image, preview: imagePreviewUrl(r.image) } });
  }

  if (method === 'DELETE') {
    const removeImageLib = need(m, 'removeImageLib', 'media');
    const id = String(body?.id || query.get('id') || '');
    const ok = removeImageLib(id);
    return json(ok ? 200 : 404, { ok });
  }
  return null;
}

/** GET /api/images-lib/preview（旧 L3093）—— 返回图片本体，不返回 JSON。 */
async function imagesLibPreview(ctx, method, query) {
  if (method !== 'GET') return null;
  const m = media(ctx);
  const resolveLocalPreview = need(m, 'resolveLocalPreview', 'media');
  const fp = resolveLocalPreview(query.get('id') || '');
  // ★ 2026-10-17（ds1）：dataDir 之外的路径一律当"没有这张图"（纵深防御，见文件尾部 pathInsideDataDir）。
  if (!fp || !pathInsideDataDir(ctx, fp)) return json(404, { ok: false, error: '本地图不存在' });
  return binary(200, mimeOfImage(fp), fs.readFileSync(fp), {
    'cache-control': 'private, max-age=300',
    'x-content-type-options': 'nosniff'   // 正文可能不是扩展名说的那种图（无法识别时按 jpeg 回）⇒ 不许嗅探
  });
}

// ══════════════════════════════════════════════════════════════════════
// 梗图 / 知识库（旧 L3167-3242）
// ══════════════════════════════════════════════════════════════════════
async function memes(ctx, method, query, body) {
  const m = media(ctx);
  if (method === 'GET') {
    const listAllMemes = need(m, 'listAllMemes', 'media');
    const memeCount = need(m, 'memeCount', 'media');
    return json(200, { memes: listAllMemes({ q: query.get('q') || '', limit: 120 }), total: memeCount() });
  }
  if (method === 'POST') {
    const saveMeme = need(m, 'saveMeme', 'media');
    const r = saveMeme({ text: body?.text, tags: body?.tags, note: body?.note, kind: body?.kind });
    if (!r.ok) return json(400, { ok: false, error: r.error || '保存失败' });
    return json(200, { ok: true, meme: r.meme });
  }
  if (method === 'DELETE') {
    const removeMeme = need(m, 'removeMeme', 'media');
    const ok = removeMeme(String(body?.text ?? ''));
    return json(ok ? 200 : 404, { ok });
  }
  return null;
}

/** POST /api/memes/pin（旧 L3189）—— 写类：显式回执，不假装成功。 */
async function memesPin(ctx, method, body) {
  if (method !== 'POST') return null;
  const m = media(ctx);
  const setMemePinned = need(m, 'setMemePinned', 'media');
  const r = setMemePinned(String(body?.text ?? ''), body?.pinned !== false);
  if (!r.ok) return json(400, { ok: false, error: r.error || '失败' });
  return json(200, r);
}

/** POST /api/memes/export（旧 L3203）—— 真写文件到 <dataDir>/knowledge-import/ 并回路径。 */
async function memesExport(ctx, method) {
  if (method !== 'POST') return null;
  const m = media(ctx);
  const listAllMemes = need(m, 'listAllMemes', 'media');
  const dir = path.join(dataDirOf(ctx), 'knowledge-import');
  fs.mkdirSync(dir, { recursive: true });
  const rows = listAllMemes({ q: '', limit: 5000 }) || [];
  const stamp = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `知识库导出_${stamp}.json`);
  const payload = rows.map((r) => ({
    text: r.text, kind: r.kind || 'meme', tags: r.tags || [], note: r.note || '',
    ...(r.pinned ? { pinned: true } : {})
  }));
  const text = JSON.stringify(payload, null, 1);
  fs.writeFileSync(file, text, 'utf8');
  // ★ 2026-10-18（第二批 #9）：除了服务端落盘（可放回 knowledge-import 再导入），把**导出内容本身**
  //   一并回给调用方 —— 前端据此触发真正的浏览器/Electron 下载。只回路径时用户拿不到文件，
  //   "导出"等于不可用。内容就是知识库条目本身，不含凭据。
  return json(200, { ok: true, file, filename: path.basename(file), count: payload.length, json: text });
}

/** GET /api/knowledge（旧 L3023）—— 旧树直接返回数组（不是 {ok:...}），形状照旧。 */
async function knowledge(ctx, method, query) {
  if (method !== 'GET') return null;
  const m = media(ctx);
  const expireStaleKnowledge = need(m, 'expireStaleKnowledge', 'media');
  const listKnowledge = need(m, 'listKnowledge', 'media');
  expireStaleKnowledge();
  return json(200, listKnowledge({
    q: query.get('q') || '',
    category: query.get('category') || '',
    limit: 200
  }));
}

/** POST /api/knowledge-import/read（旧 L3225）—— 读 <dataDir>/knowledge-import/ 下所有 txt/json/md 拼成一段。 */
async function knowledgeImportRead(ctx, method) {
  if (method !== 'POST') return null;
  const dir = path.join(dataDirOf(ctx), 'knowledge-import');
  fs.mkdirSync(dir, { recursive: true });
  const files = fs.readdirSync(dir).filter((f) => /\.(txt|json|md)$/i.test(f)).sort();
  const parts = [];
  for (const f of files) {
    try {
      let text = fs.readFileSync(path.join(dir, f), 'utf8');
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // 记事本写的 BOM
      if (text.trim()) parts.push(text.trim());
    } catch { /* 单个文件读不了就跳过（旧树同） */ }
  }
  return json(200, { ok: true, dir, files, text: parts.join('\n') });
}

// ══════════════════════════════════════════════════════════════════════
// 表情补备注 /api/stickers/annotate（旧 L2337-2377）
// ══════════════════════════════════════════════════════════════════════
const annotatable = (entry) => entry?.source !== 'manual' && entry?.noteSource !== 'manual';

async function stickersAnnotate(ctx, method, body) {
  const stickers = stickerManager(ctx);
  if (method === 'GET') {
    await stickers.sync(false);
    const missing = stickers.unlabeled().filter(annotatable).length;
    return json(200, { ...annotateState, missing, total: stickers.entries.length });
  }
  if (method !== 'POST') return null;

  if (annotateState.running) return json(409, { ok: false, error: '已有一次补备注正在进行' });
  const limit = Math.max(1, Math.min(200, Number(body?.limit) || 60));
  const onlyMissing = body?.onlyMissing !== false;
  await stickers.sync(false);
  const missing = stickers.unlabeled().filter(annotatable).length;
  const available = onlyMissing ? missing : stickers.entries.filter(annotatable).length;
  if (!available) {
    return json(200, {
      ok: true, started: false,
      note: onlyMissing ? '所有表情都有备注了，不用补了。' : '没有可重新标注的表情（手工条目会保留）。'
    });
  }
  annotateState.running = true;
  annotateState.done = 0;
  annotateState.failed = 0;
  annotateState.total = Math.min(limit, available);
  // ★ A3（2026-10-11 mimo3）：emit 缺失**不许静默**（原先 () => {} 吞掉一切 ⇒ UI 进度永远空还不报错）。
  //   装配层已补 ctx.emit（assembly.js ctx 返回块）；这里兜底：真缺时留一行可见日志再降级 no-op。
  const emit = typeof ctx?.emit === 'function' ? ctx.emit : () => {};
  if (typeof ctx?.emit !== 'function') {
    console.warn('[api/media] ⚠ ctx 缺 emit ⇒ sticker-annotate 进度帧发不出去（UI 补备注进度会静默）——装配层应给 ctx.emit');
  }
  stickers.annotateMissing({ limit, onlyMissing, emit, onProgress: (n) => { annotateState.done = n; } })
    .then(({ done = [], failed = [] }) => {
      annotateState.done = done.length;
      annotateState.failed = failed.length;
      emit('sticker-annotate', { phase: 'done', done: done.length, failed: failed.length });
      emit('chat-update', '');
    })
    .catch((error) => emit('sticker-annotate', { phase: 'error', error: String(error?.message ?? error) }))
    .finally(() => { annotateState.running = false; });
  return json(202, { ok: true, started: true, total: annotateState.total });
}

// ══════════════════════════════════════════════════════════════════════
// POST /api/media-data（旧 L3489-3535）
// ══════════════════════════════════════════════════════════════════════
async function mediaData(ctx, method, body) {
  if (method !== 'POST') return null;
  const items = Array.isArray(body?.items) ? body.items.slice(0, 20) : [];
  const platform = ctx?.platform ?? ctx?.onebot;
  if (!platform || typeof platform.call !== 'function') {
    return notPorted('ctx.platform（media-data 需要协议端 get_image 拿本地缓存文件）');
  }
  const MAX_BYTES = 15 * 1024 * 1024;
  const fileToDataUrl = (fp) => {
    const st = fs.statSync(fp);              // 不存在直接抛（调用点已 try）
    if (st.size > MAX_BYTES) return null;
    return `data:${mimeOfImage(fp)};base64,${fs.readFileSync(fp).toString('base64')}`;
  };
  // ★ 2026-10-17（ds1 · SSRF 收口）：出网抓图**一律走 M14 既有的 `safeFetchBinary`** —— 它自带
  //   私网/回环地址拒绝（`security.allowPrivateImageHosts` 是用户显式开的另一档）、**逐跳重定向重校验**
  //   （先解析 IP 再连、保留 Host/SNI，从根上消除 DNS rebinding）、大小上限与 UA/Accept。
  //   以前这里是裸 `fetch()`：谁都能拿它当内网探测/读取器（响应虽只回 dataURL，跨站是盲 SSRF、
  //   rebinding 下可读）。正常 QQ 图链是公网 CDN ⇒ 走这条路一字不变；`it.url` 来自请求体，必须过闸。
  const internetMod = getMod(ctx, 'internet');
  const safeFetchBinary = typeof internetMod?.safeFetchBinary === 'function' ? internetMod.safeFetchBinary : null;
  /** 协议端自己的 HTTP 源（`snowluma.httpUrl`）——只有它能走"直连"，因为它就在本机、是已配置的信任端。 */
  const protocolOrigin = (() => {
    try {
      const raw = String(ctx?.configStore?.get?.('snowluma.httpUrl', '') || '').trim();
      return raw ? new URL(raw).origin : '';
    } catch { return ''; }
  })();
  let strictFetchWarned = false;
  const fetchBinaryStrict = async (url) => {
    if (!safeFetchBinary) throw new Error('not-ported: modules.internet.safeFetchBinary（没有出网闸就不抓外链图）');
    const { buffer, contentType } = await safeFetchBinary(String(url), MAX_BYTES);
    const buf = Buffer.isBuffer(buffer) ? buffer : (buffer ? Buffer.from(buffer) : null);
    if (!buf || !buf.length || buf.length > MAX_BYTES) return null;
    return { buf, mime: String(contentType || 'image/jpeg') };
  };
  /**
   * 协议端自查缓存（NapCat 那类本地 HTTP 缓存）与本机协议端**同源** ⇒ 直连（保留原行为）；
   * 其余一律走安全抓取 —— 于是"配置好的协议端能取到自己的图"，但拿不到别的内网地址。
   */
  const fetchBinary = async (url) => {
    let sameAsProtocol = false;
    try { sameAsProtocol = Boolean(protocolOrigin) && new URL(String(url)).origin === protocolOrigin; } catch { sameAsProtocol = false; }
    if (!sameAsProtocol) {
      try {
        return await fetchBinaryStrict(url);
      } catch (error) {
        if (!strictFetchWarned) {
          strictFetchWarned = true;   // 每次调用最多喊一行（20 张图的循环不许刷屏），且不回显 URL
          console.warn(`[api/media] 出网抓图未通过安全抓取，已放弃该图：${String(error?.message ?? error).slice(0, 120)}`);
        }
        return null;
      }
    }
    const r = await fetch(String(url), { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    return { buf, mime: r.headers.get('content-type') || 'image/jpeg' };
  };
  const results = [];
  for (const it of items) {
    let dataUrl = null;
    // 路径 1：协议端 get_image（NapCat 本地缓存文件）
    try {
      const ret = await platform.call('get_image', { file: String(it?.file || '') });
      if (ret?.file && fs.existsSync(String(ret.file))) dataUrl = fileToDataUrl(String(ret.file));
      if (!dataUrl && ret?.url) {
        const got = await fetchBinary(ret.url);
        if (got) dataUrl = `data:${got.mime};base64,${got.buf.toString('base64')}`;
      }
    } catch { /* 缓存没有就走下一条 */ }
    // 路径 2：直接拉存档里的 URL（新消息 URL 还没过期时有效）
    if (!dataUrl && it?.url) {
      try {
        const got = await fetchBinary(it.url);
        if (got && String(got.mime).startsWith('image/')) dataUrl = `data:${got.mime};base64,${got.buf.toString('base64')}`;
      } catch { /* 过期就放弃，返回 null 让前端保留原 URL */ }
    }
    results.push(dataUrl ? { dataUrl } : null);
  }
  return json(200, { ok: true, results });
}

// ══════════════════════════════════════════════════════════════════════
// 静态资源：/api/plugin/:id/panel(/<file>) 与 /plugin-assets/*
// ══════════════════════════════════════════════════════════════════════

/** 扩展目录：只认已注册且加载成功的扩展（旧 L1433-1434 的口径）。 */
function extensionDir(ctx, extId) {
  const ext = getMod(ctx, 'extensions');
  const skillManager = ext?.skillManager;
  if (!skillManager || !skillManager.registry || typeof skillManager.registry.get !== 'function') {
    throw Object.assign(new Error('not-ported: ctx.modules.extensions.skillManager.registry'), { notPorted: true });
  }
  const rec = skillManager.registry.get(extId);
  if (!rec?.dir || rec.loadError) return { error: { status: 404, error: '插件不存在或未加载' } };
  return { dir: rec.dir };
}

/** GET /plugin-assets/<extId>/<file>（旧 L1431）—— 返回文件本体 + content-type。 */
async function pluginAssets(ctx, method, pathname) {
  if (method !== 'GET' && method !== 'HEAD') return null;
  const m = /^\/(?:api\/)?plugin-assets\/([a-z0-9._-]+)\/(.+)$/i.exec(pathname);
  if (!m) return null;
  const found = extensionDir(ctx, m[1]);
  if (found.error) return json(found.error.status, { error: found.error.error });
  const resolved = resolveInside(found.dir, m[2]);
  if (resolved.error) return json(resolved.error.status, { error: resolved.error.error });
  const buf = fs.readFileSync(resolved.full);
  if (method === 'HEAD') return { status: 200, headers: { 'content-type': mimeOfAsset(resolved.full), 'content-length': String(buf.length) }, body: '', binary: true };
  return binary(200, mimeOfAsset(resolved.full), buf, { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
}

/**
 * GET /api/plugin/<id>/panel[/<file>]（旧 L1821）—— 插件自带面板。
 * 与 plugin-assets 的差别：文件名**只允许单段**（旧 L1827 的 `^[A-Za-z0-9._-]+$` 且不以 `.` 开头）；
 * 目录穿越闸与 plugin-assets 共用 `resolveInside`（含 realpath 双重 containment）——
 * ★ 2026-10-17（ds1）：原实现只 `path.resolve` 后比前缀、**不 realpath 目标**，插件目录里一个软链
 *   就能把面板指到目录外（兄弟路由 plugin-assets 一直有这道闸，这里补上）。目录不存在回 404，不抛 500。
 */
async function pluginPanel(ctx, method, pathname) {
  if (method !== 'GET') return null;
  const m = /^\/api\/plugin\/([a-z0-9._-]+)\/panel(?:\/([^/]*))?$/i.exec(pathname);
  if (!m) return null;
  const found = extensionDir(ctx, m[1]);
  if (found.error) return json(found.error.status, { ok: false, error: `没有这个扩展：${m[1]}` });
  const rel = m[2] ? decodeURIComponent(m[2]) : 'panel.html';
  if (!/^[A-Za-z0-9._-]+$/.test(rel) || rel.startsWith('.')) {
    return json(400, { ok: false, error: '文件名不合法' });
  }
  let root;
  try { root = fs.realpathSync(found.dir); } catch { return json(404, { ok: false, error: '这个插件目录不存在' }); }
  const resolved = resolveInside(root, rel, { decoded: true });
  if (resolved.error) {
    if (resolved.error.status === 400) return json(400, { ok: false, error: '文件名不合法' });
    return json(404, { ok: false, error: rel === 'panel.html' ? '这个插件没有自带面板（panel.html）' : `找不到 ${rel}` });
  }
  return binary(200, mimeOfAsset(resolved.full), fs.readFileSync(resolved.full), { 'cache-control': 'no-store' });
}

/**
 * 桌宠皮肤 roots（T-PETSKINS-ROOTS 切换后契约，与桌宠渲染侧同源）：
 *   builtin = refactor/apps/desktop/pet-skins/（paths.js PET_SKINS_ROOT，已搬到位）
 *   user    = <仓库根>/pet-skins/（paths.js PET_SKINS_USER_ROOT，不搬、用户手放目录）
 * ★ 不读 ctx.repoRoot：它在 apps/server 全树不存在（唯一出现处曾是这里的读取点），
 *   读它恒为 undefined ⇒ createSkinRegistry 退回 process.cwd() ⇒ cwd 不是仓库根就扫空（200 空表假绿）。
 */
export function petSkinRoots() {
  return [
    { label: 'builtin', dir: PET_SKINS_ROOT },
    { label: 'user', dir: PET_SKINS_USER_ROOT }
  ];
}

/**
 * 桌宠 registry 单例（旧树 src/app.js:205 单例：一处构造，列表与图片路由共用）。
 * 每请求新建 ⇒ ttlMs=3000 形同虚设 + 每次全量扫盘；keyed on roots 字符串，根变则重建。
 */
let petRegistry = null;
let petRegistryKey = '';
function petSkinRegistryCached(skinsMod) {
  const roots = petSkinRoots();
  const key = JSON.stringify(roots.map((r) => r.dir));
  if (!petRegistry || petRegistryKey !== key) {
    petRegistry = new skinsMod.SkinRegistry({ roots });
    petRegistryKey = key;
  }
  return petRegistry;
}

/** GET /api/pet-skins（旧 src/app.js:1600-1607：200 {skins, problems}，problems 取自 registry）。 */
async function petSkins(ctx, method) {
  if (method !== 'GET') return null;
  // ★ T-PETSKINS-PORT：用 modules/pet-skins（旧树 src/pet-skins/registry.js 搬运；加载表由指挥位补行）。
  const skinsMod = ctx?.modules?.get?.('modules/pet-skins') ?? ctx?.modules?.['pet-skins'];
  if (!skinsMod?.petSkinsView) return notPorted('pet-skins: modules/pet-skins 未加载（SkinRegistry 缺失）');
  if (typeof skinsMod?.SkinRegistry !== 'function') {
    return notPorted('pet-skins: SkinRegistry 类缺失（显式 roots 构造需要该类）');
  }
  try {
    const registry = petSkinRegistryCached(skinsMod);
    const view = skinsMod.petSkinsView(registry);
    // 旧树形状 {skins, problems}（无 ok/source）—— 逐键对齐；此前 handler 多带的
    // ok:true + source:'pet-skins.SkinRegistry' 已按指挥位"或删掉"项摘除（见回执）。
    return json(200, { skins: view.skins, problems: view.problems });
  } catch (e) {
    return errorResponse(e);
  }
}

// ══════════════════════════════════════════════════════════════════════
// 桌宠资源：/pet-skin-assets/<皮肤id>/<包内相对路径> · /pet-legacy-assets/<文件名>
// （旧树 src/app.js:1461-1579；两条都**没有 /api 前缀**，与 /plugin-assets 同族。
//   http.js 的分片循环对**每个** pathname 都问一遍 api/*.js，且排在静态之前 ⇒ 挂在本分片即可。
//   ★ 三个客户端在用：refactor/apps/desktop/main.js:688（assetRoot）、:271/:272（legacy），
//     electron/main.js:246/:247（旧树同款）。不搬 ⇒ 桌宠皮肤图全 404。
// ══════════════════════════════════════════════════════════════════════

/** 旧树 L1467：皮肤资源只认这三种图像（.html/.js 不给 ⇒ 不留内联脚本的面）。 */
const PET_SKIN_IMAGE_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };

/** 旧树 L1469：SVG 内联时掐掉脚本/网络（逐字照搬）。 */
const SVG_HARDENING_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'";

/** 旧树 src/pet-skins/manifest.js:60 `LIMITS.resourceMaxBytes`（单资源 8 MiB，resolve 时核）。 */
const PET_SKIN_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 旧树 L1564-1567 的固定字典（文件名 → 仓库根 assets/ 下的绝对路径）。
 * 旧树 ROOT = 仓库根（src/config.js:10），本树同值 = paths.js 的 REPO_ROOT。
 * ★ 白名单写死 ⇒ 文件名单段 + 不以 `.` 开头天然成立（别的名字一律查不到）。
 */
const LEGACY_PET_ASSETS = {
  'desktop-pet-idle-24.png': path.join(REPO_ROOT, 'assets', 'desktop-pet-idle-24.png'),
  'desktop-pet-spritesheet.png': path.join(REPO_ROOT, 'assets', 'desktop-pet-spritesheet.png')
};

/**
 * 找皮肤包目录：只在**两个皮肤根**（paths.js 的 PET_SKINS_ROOT / PET_SKINS_USER_ROOT）下找
 * `<root>/<skinId>`。三道闸与旧树一致：① 皮肤包要有 skin.json（旧树只服务 registry 收录的皮肤，
 * 而 registry 的收录条件就是 skin.json 存在 —— src/pet-skins/registry.js:239-247）；
 * ② realpath 后必须仍在根之下（皮肤目录是软链/junction 指到根外 ⇒ 当没有）；③ 必须是目录。
 * 找不到 ⇒ null ⇒ 调用点 404。
 */
function petSkinPackageDir(skinId) {
  for (const { dir: rootDir } of petSkinRoots()) {
    let rootReal; let pkgReal;
    try {
      rootReal = fs.realpathSync(rootDir);
      pkgReal = fs.realpathSync(path.resolve(rootReal, skinId));
    } catch { continue; }                                   // 根或皮肤包不存在 ⇒ 换下一个根
    if (!pkgReal.startsWith(rootReal + path.sep)) continue;  // 软链逃出根 ⇒ 拒
    try {
      if (!fs.statSync(pkgReal).isDirectory()) continue;
      if (!fs.existsSync(path.join(pkgReal, 'skin.json'))) continue;
    } catch { continue; }
    return pkgReal;
  }
  return null;
}

/**
 * GET /pet-skin-assets/<皮肤id>/<包内相对路径>（旧 L1472-1558）。
 * 状态码口径照旧树：**解码失败 400**（L1476），**其余一切不命中都是 404**（L1479/1496/1510）——
 * 目录穿越、绝对路径、盘符、未知皮肤、类型不在白名单、读失败，全走 404，绝不 500。
 */
async function petSkinAssets(ctx, method, pathname, req) {
  if (method !== 'GET' && method !== 'HEAD') return null;
  const m = /^\/pet-skin-assets\/([a-z0-9][a-z0-9_-]{0,63})\/(.+)$/.exec(pathname);
  if (!m) return null;
  const skinId = m[1];                                       // 皮肤 id 正则即旧树 L1472（小写 slug，64 内）
  let rel;
  try { rel = decodeURIComponent(m[2]); } catch { return json(400, { error: '资源路径编码无效' }); }

  const pkgDir = petSkinPackageDir(skinId);
  if (!pkgDir) return json(404, { error: '皮肤不存在' });

  // 目录穿越闸（resolveInside：空段 / . / .. / 含 : 一律拒；realpath 双重 containment；必须 isFile）
  const resolved = resolveInside(pkgDir, rel, { decoded: true });
  if (resolved.error) return json(404, { error: '资源不存在' });

  const ext = path.extname(resolved.full).toLowerCase();
  const type = PET_SKIN_IMAGE_TYPES[ext];
  if (!type) return json(404, { error: '资源类型不支持' });    // 旧 L1510

  let st;
  try { st = fs.statSync(resolved.full); } catch { return json(404, { error: '资源不存在' }); }
  // 旧 resolveResourcePath 的三道内容核：isFile（resolveInside 已核）/ 大小上限 / 硬链接数
  if (!st.isFile() || st.size > PET_SKIN_MAX_BYTES || st.nlink > 1) {
    return json(404, { error: '资源不存在' });
  }

  const etag = `W/"${st.size}-${Math.round(st.mtimeMs * 1000)}-${Math.round(st.ctimeMs * 1000)}-${st.ino}"`;
  const headers = {
    'content-type': type,
    etag,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-cache'
  };
  if (ext === '.svg') headers['content-security-policy'] = SVG_HARDENING_CSP;

  const ifNoneMatch = req?.headers?.['if-none-match'];
  const validators = typeof ifNoneMatch === 'string' ? ifNoneMatch.split(',').map((tag) => tag.trim()) : [];
  if (validators.includes('*') || validators.includes(etag)) {
    return { status: 304, headers, body: '', binary: true };   // 旧 L1522-1527（带 etag 头、不带 content-length）
  }

  headers['content-length'] = String(st.size);                 // 与 stat 校验过的同一个 size
  if (method === 'HEAD') return { status: 200, headers, body: '', binary: true };   // 旧 L1531-1535：只回头

  let buf;
  try {
    buf = fs.readFileSync(resolved.full);
  } catch (err) {
    // 旧树在 createReadStream 抛（L1544）与 stream 'error'（L1551）两处打的都是这个前缀；
    // 本分片契约要求 body 是 Buffer ⇒ 读失败在这一步暴露，日志前缀逐字沿用，然后按旧树语义给 404。
    console.error('[pet-skin-assets] 创建读取流失败:', err?.code || err?.message || err);
    return json(404, { error: '资源不存在' });
  }
  if (buf.length !== st.size) {
    // 读的过程中文件被替换/截断（旧树靠"同一 fd 的 fstat"挡这条）⇒ 当读取失败
    console.error('[pet-skin-assets] 读取流失败:', `size ${st.size} -> ${buf.length}`);
    return json(404, { error: '资源不存在' });
  }
  return { status: 200, headers, body: buf, binary: true };
}

/**
 * GET /pet-legacy-assets/<文件名>（旧 L1562-1579）—— 桌宠内置兜底图（fixed 字典的两张 PNG）。
 * 安全口径：① 文件名**只允许单段**（正则里没有 `/`）；② 不以 `.` 开头；③ **只认白名单字典**，
 * 其余一律 404（查不到 key 就没有路径可读，天然读不到字典外的任何文件）。
 */
async function petLegacyAssets(ctx, method, pathname) {
  if (method !== 'GET' && method !== 'HEAD') return null;
  const m = /^\/pet-legacy-assets\/([a-z0-9._-]+)$/i.exec(pathname);
  if (!m) return null;
  const name = m[1];
  if (name.startsWith('.')) return json(404, { error: '资源不存在' });
  const full = LEGACY_PET_ASSETS[name.toLowerCase()];
  let st = null;
  try { st = full ? fs.statSync(full) : null; } catch { st = null; }
  if (!st || !st.isFile()) return json(404, { error: '资源不存在' });   // 旧 L1569-1571：读不到就是 404

  const headers = {
    'content-type': 'image/png',                            // 旧 L1573（字典里只有 PNG）
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'content-length': String(st.size)
  };
  if (method === 'HEAD') return { status: 200, headers, body: '', binary: true };

  let buf;
  try {
    buf = fs.readFileSync(full);
  } catch (err) {
    console.error('[pet-legacy-assets] 读取失败:', err?.code || err?.message || err);
    return json(404, { error: '资源不存在' });
  }
  return { status: 200, headers, body: buf, binary: true };
}

// ══════════════════════════════════════════════════════════════════════
// 唯一出口
// ══════════════════════════════════════════════════════════════════════

export async function handle({ method, pathname, query, body, ctx, req } = {}) {
  const q = query ?? new URLSearchParams();
  const b = body ?? {};
  /** 统一的异常映射：notPorted ⇒ 501，其余 ⇒ 500 + 原文（铁律 2/3）。 */
  const map = (e) => (e?.notPorted
    ? notPorted(String(e.message).replace(/^not-ported:\s*/, ''))
    : errorResponse(e));
  // 先判静态资源（它们不是 /api/* 开头，顺序不能和后面的表混在一起）
  // ★ 这两条**必须**也走 map()：plugin-assets / panel 缺 extensions 能力时抛的是 notPorted，
  //   不包起来就会变成 500（违反铁律 2）。这是探针抓出来的真 bug。
  try {
    const assets = await pluginAssets(ctx, method, pathname);
    if (assets) return assets;
  } catch (e) {
    if (/^\/plugin-assets\//i.test(String(pathname || ''))) return map(e);
    throw e;
  }

  // 桌宠资源两条（同样**不带 /api 前缀**）：http.js 对每个 pathname 都会问到本分片，
  // 且分片排在 tryServeStatic 之前 ⇒ 这里返回即接管，不需要动 http.js。
  // ★ 两条都**不依赖任何 ctx 能力**（纯 fs），所以不需要 map()：handler 内部已把读失败兜成 404。
  const petSkin = await petSkinAssets(ctx, method, pathname, req);
  if (petSkin) return petSkin;
  const petLegacy = await petLegacyAssets(ctx, method, pathname);
  if (petLegacy) return petLegacy;

  const routes = [
    ['/api/images-lib', (m) => imagesLib(ctx, m, q, b)],
    ['/api/images-lib/preview', (m) => imagesLibPreview(ctx, m, q)],
    ['/api/memes', (m) => memes(ctx, m, q, b)],
    ['/api/memes/pin', (m) => memesPin(ctx, m, b)],
    ['/api/memes/export', (m) => memesExport(ctx, m)],
    ['/api/stickers/annotate', (m) => stickersAnnotate(ctx, m, b)],
    ['/api/media-data', (m) => mediaData(ctx, m, b)],
    ['/api/knowledge', (m) => knowledge(ctx, m, q)],
    ['/api/knowledge-import/read', (m) => knowledgeImportRead(ctx, m)],
    ['/api/pet-skins', (m) => petSkins(ctx, m)]
  ];
  for (const [route, run] of routes) {
    if (pathname !== route) continue;
    try {
      const out = await run(method);
      if (out) return out;
    } catch (e) {
      return map(e);
    }
  }
  try {
    const panel = await pluginPanel(ctx, method, pathname);
    if (panel) return panel;
  } catch (e) {
    if (/^\/api\/plugin\//i.test(String(pathname || ''))) return map(e);
    throw e;
  }
  return null;
}

/**
 * ★ 2026-10-17（ds1 安全审查 · 任意文件读取收口）：图库的"本地图片"只允许落在**本次 dataDir 之内**。
 *
 * 为什么必须有这道闸：图库条目里的 `url/localFile` 会被 M11 的 `resolveLocalPreview()` 原样交给
 * `fs.readFileSync`（`modules/media/image-lib.js:235-244`：`path.isAbsolute(src) && existsSync(src)` 即读），
 * 而 `GET /api/images-lib/preview?id=…` 把读到的字节直接回给请求方 ⇒ 只要能在图库里塞进一条
 * `localPath: "C:\\…\\id_rsa"`（或 `..\\..` 相对路径）条目，本端点就是"读本机任意文件"。
 * 写入侧（POST /api/images-lib）与读取侧（preview）各判一次：写入侧挡新条目，读取侧挡旧数据。
 *
 * 为什么不会打断既有用法：面板导入走 `dataUrl`（落盘在 `<dataDir>/images-lib/files/`，存的是**相对路径**）
 * 或公网 URL（`apps/ui/app.js:11866 / 11907`），两条都天然在闸内；相对路径按 dataDir 解析。
 * 绝对路径 / 越界路径（含 `..`、软链指向外部）一律拒 —— 那些不是图库自己的文件。
 * ⚠ 本闸只管本文件的两条 HTTP 路由；M11 `resolveImagePath()`（给 send_image 用）语义未动。
 */
function dataDirRealPath(ctx) {
  try { return fs.realpathSync(dataDirOf(ctx)); } catch { return ''; }
}

function pathInsideDataDir(ctx, rawPath) {
  const root = dataDirRealPath(ctx);
  if (!root) return false;
  const p = String(rawPath ?? '').trim();
  if (!p) return false;
  const abs = path.resolve(path.isAbsolute(p) ? p : path.join(root, p));
  let real = abs;
  try { real = fs.realpathSync(abs); } catch { /* 文件还不存在：按解析后的字面路径比 */ }
  return real === root || real.startsWith(root + path.sep);
}

/** 自测/排障用：清掉按 dataDir 缓存的 StickerManager 与补备注进度，以及桌宠 registry 单例。 */
export function resetMediaApiState() {
  STICKER_MANAGERS.clear();
  Object.assign(annotateState, { running: false, done: 0, failed: 0, total: 0 });
  petRegistry = null;
  petRegistryKey = '';
}

export { petSkins };