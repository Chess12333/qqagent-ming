// 图库：与表情包库分开的「可发送图片」索引。
// 存 data/images-lib/index.json；图片可本地图路径或公网 URL。
// 用途：自我形象、指定梗图、要图时检索后 send_image。
import fs from 'node:fs';
import { writeJsonAtomic } from '../../core/util/index.js';
import path from 'node:path';
import { DATA_DIR } from '../../core/config-store/index.js';
import { logMemoryChange } from '../memory/index.js';

const DIR = path.join(DATA_DIR, 'images-lib');
const FILE = path.join(DIR, 'index.json');
const MAX = 200;

function ensure() {
  fs.mkdirSync(DIR, { recursive: true });
}

function readIndex() {
  try {
    ensure();
    let t = fs.readFileSync(FILE, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    const j = JSON.parse(t);
    return Array.isArray(j.images) ? j.images : [];
  } catch {
    return [];
  }
}

function writeIndex(list) {
  ensure();
  // ★ N62：统一走 core/util 的原子落盘（同上）。indent:1 = 与老写法逐字节一致。
  writeJsonAtomic(FILE, { version: 1, images: list.slice(-MAX) }, { indent: 1 });
}

function normalizeEntry(raw) {
  const id = String(raw?.id || '').trim();
  const src = String(raw?.url || raw?.localFile || raw?.src || '').trim();
  if (!id || !src) return null;
  return {
    id,
    url: src, // 公网 http(s) 或 file:// / 相对 data 的路径
    localFile: String(raw?.localFile || '').trim(),
    tags: (Array.isArray(raw?.tags) ? raw.tags : []).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 12),
    note: String(raw?.note || raw?.desc || '').slice(0, 160),
    category: ['self', 'meme', 'art', 'other'].includes(raw?.category) ? raw.category : 'other',
    uses: Math.max(0, Number(raw?.uses) || 0),
    lastUsedAt: Number(raw?.lastUsedAt) || 0,
    createdAt: Number(raw?.createdAt) || Date.now()
  };
}

/** 本地图路径 → 可给 send_image 的 file:// 或绝对路径 */
export function resolveImagePath(entry) {
  if (!entry) return '';
  const src = String(entry.url || entry.localFile || '');
  if (!src) return '';
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('file://')) return src;
  // 相对 data 目录
  if (!path.isAbsolute(src)) {
    const abs = path.join(DATA_DIR, src);
    if (fs.existsSync(abs)) return abs;
  }
  if (fs.existsSync(src)) return src;
  return src;
}

/**
 * 检索图库。
 * query 匹配 tags/note/category/id；category=self 时优先。
 */
export function searchImageLib(query, { category = '', limit = 8 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const cat = String(category || '').trim().toLowerCase();
  const list = readIndex();
  const scored = [];
  for (const img of list) {
    if (cat && img.category !== cat) continue;
    const hay = `${img.tags.join(' ')} ${img.note} ${img.category} ${img.id}`.toLowerCase();
    let score = 0;
    if (q) {
      if (hay.includes(q)) score += 5;
      for (const w of q.split(/\s+/)) {
        if (w.length >= 2 && hay.includes(w)) score += 2;
      }
    } else if (cat) {
      score = 1;
    }
    // self 类默认权重更高（发自己形象）
    if (img.category === 'self') score += 0.8;
    if (score > 0) scored.push({ score, img });
  }
  // 相关性优先；同分时用得少的排前面，最后才随机。
  // 原先只按 score 稳定排序，同一个查询每次返回顺序完全一致，模型总是拿第一张 ——
  // 实测 15 张 self 图里 11 张从未发过、1 张发了 5 次。
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ua = Number(a.img.uses) || 0;
    const ub = Number(b.img.uses) || 0;
    if (ua !== ub) return ua - ub;
    const ta = Number(a.img.lastUsedAt) || 0;
    const tb = Number(b.img.lastUsedAt) || 0;
    if (ta !== tb) return ta - tb;
    return Math.random() - 0.5;
  });
  return scored.slice(0, Math.max(1, Math.min(30, limit))).map(({ img }) => ({
    id: img.id,
    category: img.category,
    note: img.note,
    tags: img.tags,
    url: img.url,
    uses: img.uses
  }));
}

export function getImageLibEntry(id) {
  const list = readIndex();
  return list.find((x) => x.id === String(id)) || null;
}

export function markImageUsed(id) {
  const list = readIndex();
  const e = list.find((x) => x.id === String(id));
  if (!e) return null;
  e.uses = (e.uses || 0) + 1;
  e.lastUsedAt = Date.now();
  writeIndex(list);
  return e;
}

/** 添加/更新图库条目 */
export function addImageLib({ url, localFile = '', tags = [], note = '', category = 'other', id = '' }) {
  const list = readIndex();
  const nid = String(id || `img${Date.now().toString(36)}`).trim();
  const entry = normalizeEntry({ id: nid, url, localFile, tags, note, category });
  if (!entry) return { ok: false, error: '需要 url 或本地路径' };
  const idx = list.findIndex((x) => x.id === entry.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...entry, uses: list[idx].uses, lastUsedAt: list[idx].lastUsedAt };
  else list.push(entry);
  writeIndex(list);
  logMemoryChange({ type: 'image_lib_save', source: 'manual', text: `${entry.category}:${entry.note || entry.id}` });
  return { ok: true, image: entry };
}

export function removeImageLib(id) {
  const list = readIndex();
  const next = list.filter((x) => x.id !== String(id));
  if (next.length === list.length) return false;
  writeIndex(next);
  return true;
}

export function listImageLib({ category = '', limit = 50 } = {}) {
  const cat = String(category || '').trim().toLowerCase();
  return readIndex()
    .filter((x) => !cat || x.category === cat)
    .slice()
    .reverse()
    .slice(0, Math.max(1, Math.min(200, limit)))
    .map((img) => ({
      id: img.id,
      category: img.category,
      note: img.note,
      tags: img.tags,
      url: img.url,
      uses: img.uses
    }));
}

export function imageLibCount() {
  return readIndex().length;
}

export function imageLibDir() {
  ensure();
  return DIR;
}

/** 按魔数识别图片扩展名；认不出返回 ''。 */
function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'jpg'; // heic/heif → jpg 容器，多数看图软件可开
  return '';
}

/** dataURL/base64 落盘到 images-lib/files/，返回相对 DATA_DIR 的路径 */
export function saveImageFromDataUrl(dataUrl) {
  const raw = String(dataUrl || '');
  if (!raw) return { ok: false, error: '空的图片数据' };
  let b64 = '';
  let mime = '';
  const m = /^data:([^;,]+)?(?:;[^,]*)?;base64,([\s\S]+)$/i.exec(raw);
  if (m) {
    mime = String(m[1] || '').toLowerCase();
    b64 = m[2];
  } else if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.replace(/\s+/g, '').length > 64) {
    b64 = raw; // 裸 base64 也收
  } else {
    return { ok: false, error: '不是有效的 dataURL/base64 图片' };
  }
  let buf;
  try {
    buf = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  } catch {
    return { ok: false, error: 'base64 解码失败' };
  }
  if (buf.length < 32) return { ok: false, error: '图片太小或已损坏' };
  if (buf.length > 10 * 1024 * 1024) return { ok: false, error: '单张超过 10MB' };
  const sniffed = sniffImageExt(buf);
  if (!sniffed) {
    // 兜底：允许 dataURL 自带的 image/* 但文件头不像图 → 拒绝，避免把 HTML 当图
    if (!/^image\//i.test(mime)) return { ok: false, error: `无法识别的图片（${mime || '未知'}）。支持 png/jpg/gif/webp/bmp` };
    // mime 说像图但魔数不对：仍拒绝（QQ 发出去会裂图）
    return { ok: false, error: '文件内容不是可识别的图片（png/jpg/gif/webp/bmp）' };
  }
  const ext = sniffed;
  ensure();
  const filesDir = path.join(DIR, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  const name = `import-${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const abs = path.join(filesDir, name);
  fs.writeFileSync(abs, buf);
  const rel = path.relative(DATA_DIR, abs).split(path.sep).join('/');
  return { ok: true, localFile: rel, bytes: buf.length, ext, mime: mime || `image/${ext === 'jpg' ? 'jpeg' : ext}` };
}

/** 预览用：解析本地绝对路径（仅 http/file 交给前端直连） */
export function resolveLocalPreview(id) {
  const entry = getImageLibEntry(id);
  if (!entry) return null;
  const src = resolveImagePath(entry);
  if (/^https?:\/\//i.test(src) || src.startsWith('file://')) return null;
  if (path.isAbsolute(src) && fs.existsSync(src)) return src;
  const abs = path.join(DATA_DIR, src);
  if (fs.existsSync(abs)) return abs;
  return null;
}

/** 自我形象相关触发词 → 提示模型去图库 self */
export function shouldCueImageLib(text) {
  const t = String(text || '');
  return /你长什么样|长啥样|自拍|发张你的图|你的图|本鲸照片|形象照|人设图|看看你/.test(t);
}
