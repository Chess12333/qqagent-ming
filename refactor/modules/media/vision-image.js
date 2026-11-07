// 识图输入归一化：把各种图片格式变成视觉接口更稳的 data URL（优先 png/jpeg）。
//
// 为什么需要：
//   1. 动图 GIF：不少视觉接口只吃首帧/静态图，或直接 400；整轮被拒后 llm.js 会剥掉
//      全部图片 → 用户看到的就是"看不了 gif"。这里在送模型前抽出若干帧转成 PNG。
//   2. webp/avif/bmp：本地 LM Studio 等接口收到会 400 打挂整轮（见 llm.visionUnsupported）。
//      有 ffmpeg 就转；没有则按原策略跳过/直发。
//   3. png/jpg：原样透传，不做无谓转码。
//
// GIF 解码是纯 JS（不依赖 ffmpeg / sharp），多帧按时间均匀抽最多 maxFrames 张，
// 并在调用方拼一段"这是动图抽出的 N 帧"说明，让模型知道在看连续画面。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { visionUnsupported } from '../llm/index.js';

// ── 魔数识别 ─────────────────────────────────────────────────────────────

export function detectImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const gifHead = buf.toString('ascii', 0, 6);
  if (gifHead === 'GIF87a' || gifHead === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  // AVIF/HEIC：ISOBMFF，bytes 4..8 = 'ftyp'
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (brand === 'avif' || brand === 'avis' || brand === 'mif1' || brand === 'msf1') return 'image/avif';
    return 'image/heic';
  }
  return null;
}

function dataUrl(mime, buf) {
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function isPassThrough(mime) {
  return /^image\/(png|jpe?g)$/i.test(String(mime || ''));
}

/**
 * 询问启用中的扩展：这个 MIME 是否被管理员明确禁止发送给模型。
 * 未安装/未启用提供者时返回 false，保持核心原有行为。
 */
async function extensionRejectsMime(mime) {
  if (!mime) return false;
  try {
    const { skillManager } = await import('../extensions/index.js');
    const providers = skillManager.getCapabilityProviders('image.mime-support', {});
    for (const provider of providers) {
      try {
        const result = await provider.fn({ mime });
        if (result?.unsupported === true || result?.supported === false) return true;
        if (result?.supported === true) return false;
      } catch { /* 扩展判断失败时不阻断图片主流程 */ }
    }
  } catch { /* 没有扩展底座时按核心原策略处理 */ }
  return false;
}

// ── PNG 编码（RGBA → PNG，Node zlib）────────────────────────────────────

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** RGBA（每像素 4 字节）→ PNG buffer。 */
export function encodePng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = y * stride;
    const dst = y * (stride + 1);
    raw[dst] = 0; // filter: None
    rgba.copy(raw, dst + 1, src, src + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ── GIF 解码（多帧，返回均匀抽出的 RGBA 帧）────────────────────────────

function lzwDecode(minCodeSize, data, out, outOffset, pixelCount) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  /** @type {(number[]|undefined)[]} */
  let dict = [];
  const resetDict = () => {
    dict = new Array(4096);
    for (let i = 0; i < clearCode; i++) dict[i] = [i];
    codeSize = minCodeSize + 1;
    nextCode = eoiCode + 1;
  };
  resetDict();

  let bitPos = 0;
  const bitLen = data.length * 8;
  const readCode = () => {
    if (bitPos + codeSize > bitLen) return eoiCode;
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const byte = data[(bitPos + i) >> 3];
      const bit = (byte >> ((bitPos + i) & 7)) & 1;
      code |= bit << i;
    }
    bitPos += codeSize;
    return code;
  };

  let prev = null;
  let written = 0;
  while (written < pixelCount) {
    const code = readCode();
    if (code === clearCode) { resetDict(); prev = null; continue; }
    if (code === eoiCode) break;
    let entry;
    if (code < nextCode && dict[code]) entry = dict[code];
    else if (prev) entry = prev.concat(prev[0]); // KwKwK
    else break;
    for (let i = 0; i < entry.length && written < pixelCount; i++) {
      out[outOffset + written++] = entry[i];
    }
    if (prev && nextCode < 4096) {
      dict[nextCode] = prev.concat(entry[0]);
      nextCode += 1;
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    prev = entry;
  }
  return written;
}

// ★ S06（第二批体验修复清单）：老实现是"先全解码、每帧复制一次整幅画布，再抽帧"——
//   实测 256×256、40 帧、940 字节的合成 GIF，只要 2 帧也要复制 40 次画布（10 MiB 副本），
//   内存峰值只跟"总帧数×画布"挂钩，与"要几帧"无关。现在拆成两遍：
//     第一遍 scan   —— 只算每帧 8×8 指纹（选帧用），**不复制画布**；
//     第二遍 select —— 选帧跑完后只对选中的帧号再解一次、只复制选中的帧。
//   资源上限（单帧像素 / 帧数 / 累计扫描像素）任一超出即在解析层停住并标 reason:'capped'，
//   由调用方如实降级（"超过本地上限，按原图发送"），不许用前 N 帧冒充"全解出来了"。

/** 单帧画布 RGBA 上限（2048×2048 ≈ 16 MiB/帧；GIF 表情/动图远超这个尺寸基本是异常输入）。 */
const GIF_MAX_CANVAS_PIXELS = 2048 * 2048;
/** 一次解码最多看多少帧（超了判"超出本地上限"，不用前 512 帧冒充全部）。 */
const GIF_MAX_FRAMES = 512;
/** 累计扫描像素上限（帧数 × 画布像素，两遍各记一遍），给重复解码的 CPU/内存划一条总账。 */
const GIF_MAX_SCAN_PIXELS = 96 * 1024 * 1024;

/**
 * 解析 GIF 帧（两遍式底座，见上方 S06 说明）。
 * 支持：全局/局部色表、透明色、interlace、disposal 0/1/2/3。失败不抛，返回 reason:'bad'。
 * @param {Buffer} buf
 * @param {object} [opts]
 * @param {'all'|'scan'|'select'} [opts.materialize='all'] all=每帧复制画布（老行为）；
 *   scan=只留 {delay, sig} 占位；select=只对 keep(index) 为真的帧复制画布，其余留 {delay} 占位。
 * @param {(index:number)=>boolean} [opts.keep]
 * @returns {{frames:object[], width:number, height:number, reason:''|'bad'|'capped'}}
 */
function parseGifRaw(buf, { materialize = 'all', keep = null } = {}) {
  try {
    if (!buf || buf.length < 13) return { frames: [], width: 0, height: 0, reason: 'bad' };
    const head = buf.toString('ascii', 0, 6);
    if (head !== 'GIF87a' && head !== 'GIF89a') return { frames: [], width: 0, height: 0, reason: 'bad' };

    let p = 6;
    const width = buf.readUInt16LE(p);
    const height = buf.readUInt16LE(p + 2);
    if (!width || !height) return { frames: [], width: 0, height: 0, reason: 'bad' };
    if (width * height > GIF_MAX_CANVAS_PIXELS) return { frames: [], width, height, reason: 'capped' };
    const packed = buf[p + 4];
    const hasGct = (packed & 0x80) !== 0;
    const gctSize = 2 << (packed & 0x07);
    p += 7;
    let gct = null;
    if (hasGct) {
      gct = buf.subarray(p, p + gctSize * 3);
      p += gctSize * 3;
    }

    const canvas = Buffer.alloc(width * height * 4);
    const prevCanvas = Buffer.alloc(width * height * 4);
    const frames = [];
    let scannedPixels = 0;
    let gce = { delay: 0, transparent: -1, disposal: 0 };

    const colorAt = (table, index, out, o) => {
      if (!table || index * 3 + 2 >= table.length) {
        out[o] = out[o + 1] = out[o + 2] = 0;
        out[o + 3] = 255;
        return;
      }
      out[o] = table[index * 3];
      out[o + 1] = table[index * 3 + 1];
      out[o + 2] = table[index * 3 + 2];
      out[o + 3] = 255;
    };

    while (p < buf.length) {
      const block = buf[p];
      if (block === 0x3b) break; // trailer
      if (block === 0x21) { // extension
        const label = buf[p + 1];
        p += 2;
        if (label === 0xf9) { // Graphic Control Extension
          const size = buf[p];
          const flags = buf[p + 1];
          gce = {
            delay: buf.readUInt16LE(p + 2),
            transparent: (flags & 0x01) ? buf[p + 4] : -1,
            disposal: (flags >> 2) & 0x07
          };
          p += 1 + size;
          // sub-blocks
          while (p < buf.length && buf[p] !== 0) p += 1 + buf[p];
          p += 1;
        } else if (label === 0xff) {
          const size = buf[p];
          p += 1 + size;
          while (p < buf.length && buf[p] !== 0) p += 1 + buf[p];
          p += 1;
        } else {
          while (p < buf.length && buf[p] !== 0) p += 1 + buf[p];
          p += 1;
        }
        continue;
      }
      if (block === 0x2c) { // image descriptor
        // S06 资源闸：进下一帧前先对帧数/累计像素结账，超了就停（reason:'capped'）
        if (frames.length >= GIF_MAX_FRAMES || scannedPixels + width * height > GIF_MAX_SCAN_PIXELS) {
          return { frames, width, height, reason: 'capped' };
        }
        const left = buf.readUInt16LE(p + 1);
        const top = buf.readUInt16LE(p + 3);
        const fw = buf.readUInt16LE(p + 5);
        const fh = buf.readUInt16LE(p + 7);
        const ipacked = buf[p + 9];
        p += 10;
        let lct = null;
        if (ipacked & 0x80) {
          const lctSize = 2 << (ipacked & 0x07);
          lct = buf.subarray(p, p + lctSize * 3);
          p += lctSize * 3;
        }
        const interlace = (ipacked & 0x40) !== 0;
        const minCode = buf[p];
        p += 1;
        // collect image data sub-blocks
        const chunks = [];
        let dataLen = 0;
        while (p < buf.length && buf[p] !== 0) {
          const n = buf[p];
          chunks.push(buf.subarray(p + 1, p + 1 + n));
          dataLen += n;
          p += 1 + n;
        }
        p += 1; // block terminator
        const imageData = Buffer.concat(chunks, dataLen);
        const indices = Buffer.alloc(fw * fh);
        lzwDecode(minCode, imageData, indices, 0, fw * fh);

        // disposal：disposal=3 需要先备份当前画布
        if (gce.disposal === 3) prevCanvas.set(canvas);

        const table = lct || gct;
        const rowsOrder = interlace
          ? (() => {
              const order = [];
              for (let y = 0; y < fh; y += 8) order.push(y);
              for (let y = 4; y < fh; y += 8) order.push(y);
              for (let y = 2; y < fh; y += 4) order.push(y);
              for (let y = 1; y < fh; y += 2) order.push(y);
              return order;
            })()
          : Array.from({ length: fh }, (_, i) => i);

        for (let row = 0; row < fh; row++) {
          const sy = rowsOrder[row];
          const dy = top + sy;
          if (dy < 0 || dy >= height) continue;
          for (let x = 0; x < fw; x++) {
            const dx = left + x;
            if (dx < 0 || dx >= width) continue;
            const idx = indices[row * fw + x];
            const o = (dy * width + dx) * 4;
            if (gce.transparent >= 0 && idx === gce.transparent) continue;
            colorAt(table, idx, canvas, o);
          }
        }

        const delay = Math.max(20, gce.delay * 10);
        const index = frames.length;
        if (materialize === 'scan') frames.push({ delay, sig: frameSignature(canvas, width, height) });
        else if (materialize === 'select' && keep && !keep(index)) frames.push({ delay });
        else frames.push({ rgba: Buffer.from(canvas), delay });
        scannedPixels += width * height;

        if (gce.disposal === 2) {
          for (let y = top; y < top + fh && y < height; y++) {
            for (let x = left; x < left + fw && x < width; x++) {
              const o = (y * width + x) * 4;
              canvas[o] = canvas[o + 1] = canvas[o + 2] = canvas[o + 3] = 0;
            }
          }
        } else if (gce.disposal === 3) {
          canvas.set(prevCanvas);
        }
        gce = { delay: 0, transparent: -1, disposal: 0 };
        continue;
      }
      // 未知块：跳过一字节，避免死循环
      p += 1;
    }

    if (!frames.length) return { frames: [], width, height, reason: 'bad' };
    if (materialize === 'all') return { frames: frames.map((f) => ({ ...f, width, height })), width, height, reason: '' };
    return { frames, width, height, reason: '' };
  } catch {
    return { frames: [], width: 0, height: 0, reason: 'bad' };
  }
}

/**
 * 解出 GIF 的**全部**帧（带每帧显示时长），不做任何挑选。给测试和选帧逻辑用。
 * 超过 S06 上限（帧数/单帧像素/累计扫描像素）时**返回 null**，不许用前 N 帧冒充"全部"。
 * @returns {{rgba:Buffer, delay:number, width:number, height:number}[]|null}
 */
export function decodeAllGifFrames(buffer, opts = {}) {
  const r = parseGifRaw(buffer, { materialize: 'all' });
  return r.reason ? null : r.frames;
}

/**
 * S06 两遍式解码 + 选帧（内部）：第一遍只算指纹（不复制画布），选帧后第二遍只物化选中的帧。
 * @returns {{frames:object[], reason:''|'bad'|'capped'}}
 */
function decodeGifFramesDetailed(buffer, { maxFrames = 6 } = {}) {
  const scanned = parseGifRaw(buffer, { materialize: 'scan' });
  if (!scanned.frames.length) return { frames: [], reason: scanned.reason || 'bad' };
  const want = Math.max(1, Math.min(scanned.frames.length, Number(maxFrames) || 1));
  const { picked, sceneCount } = selectGifFrames(scanned.frames, scanned.width, scanned.height, want);
  if (!picked.length) return { frames: [], reason: '' };
  const index = new Set(picked.map((s) => s.index));
  const full = parseGifRaw(buffer, { materialize: 'select', keep: (i) => index.has(i) });
  const frames = picked
    .map((s) => ({
      rgba: full.frames[s.index]?.rgba || null,
      width: scanned.width,
      height: scanned.height,
      delayMs: s.delay,
      sceneCount
    }))
    .filter((f) => f.rgba);
  if (!frames.length) return { frames: [], reason: full.reason || 'bad' };
  return { frames, reason: '' };
}

/** 解码 + 选帧（对外主入口）：返回抽好的帧，每项带 delayMs / sceneCount。 */
export function decodeGifFrames(buffer, opts = {}) {
  return decodeGifFramesDetailed(buffer, opts).frames;
}

// ── 抽帧策略：按"显示时长"加权 + 场景去重 ─────────────────────────────
// 老做法是按帧号均匀取 3 张：表情包动辄十几到几十帧、每帧时长差好几倍，
// 结果常见两种失败 —— 三张全是同一个画面（白抽），或者正好错过"抖机灵"的那一下。
// 这里改成：先把几乎不变化的相邻帧并成一个"场景"，再按每个场景**在屏幕上停了多久**来分配名额，
// 并且一定保留最后一个场景（表情包的落点/反转基本都在结尾）。

/**
 * 8x8 灰度指纹：每格取**不透明像素**的平均亮度；整格全透明记 -1。
 * ⚠️ 透明像素不能当 0 参与均值 —— 表情包大片是透明的，那样差异会被摊薄十倍
 *    （实测两个明显不同的画面只差 1.1），不同帧就被去重合掉了，等于把动图抽成一张。
 */
function frameSignature(rgba, width, height) {
  const sig = new Array(64).fill(-1);
  if (!rgba || !width || !height) return sig;
  const bw = Math.max(1, Math.floor(width / 8));
  const bh = Math.max(1, Math.floor(height / 8));
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      let sum = 0;
      let n = 0;
      const yMax = Math.min(height, (by + 1) * bh);
      const xMax = Math.min(width, (bx + 1) * bw);
      for (let y = by * bh; y < yMax; y++) {
        for (let x = bx * bw; x < xMax; x++) {
          const o = (y * width + x) * 4;
          if (rgba[o + 3] <= 8) continue;   // 全透明：不算进这一格
          sum += (rgba[o] * 299 + rgba[o + 1] * 587 + rgba[o + 2] * 114) / 1000;
          n += 1;
        }
      }
      if (n) sig[by * 8 + bx] = sum / n;
    }
  }
  return sig;
}

/**
 * 格子差异聚合：取**变化最大的 8 格**的平均值，而不是 64 格的平均值。
 * 表情包常常只动一小块（嘴、手、跳一下），按全图平均会被大片静止区域摊平 ——
 * 实测一处 11.5 的局部变化按均值只剩 1.08，就漏帧了。
 * 一帧有内容、一帧空 → 记满差异（内容出现/消失本身就是变化）。
 */
function sigDiff(a, b) {
  const cells = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x < 0 && y < 0) continue;
    cells.push(x < 0 || y < 0 ? 255 : Math.abs(x - y));
  }
  if (!cells.length) return 0;
  cells.sort((p, q) => q - p);
  const top = cells.slice(0, Math.min(8, cells.length));
  return top.reduce((s, v) => s + v, 0) / top.length;
}

/**
 * 场景合并：连续几帧几乎一样 → 当成一个场景，时长累加。
 * @returns {{index:number, delay:number, sig:number[]}[]} index 是该场景里最有代表性的一帧（首帧）
 */
function toScenes(frames, { diffMin = 6 } = {}) {
  const scenes = [];
  let prevSig = null;
  for (let i = 0; i < frames.length; i++) {
    // S06：第一遍以 {delay, sig} 形式传进来（不再逐帧复制画布）；没预算过 sig 的老输入仍现算。
    const sig = frames[i].sig || frameSignature(frames[i].rgba, frames[i].width || 0, frames[i].height || 0);
    if (prevSig && sigDiff(prevSig, sig) < diffMin) {
      scenes[scenes.length - 1].delay += frames[i].delay || 0;
      continue;
    }
    scenes.push({ index: i, delay: frames[i].delay || 0, sig });
    prevSig = sig;
  }
  return scenes;
}

/** 按时长累计均匀取 want 个点 → 落在哪个场景就取哪个场景；首末场景必留。 */
function pickScenes(scenes, want) {
  const n = scenes.length;
  if (n <= want) return scenes;
  if (want <= 1) return [scenes[0]];
  const total = scenes.reduce((a, s) => a + Math.max(s.delay, 1), 0);
  const acc = [];
  let run = 0;
  for (const s of scenes) { acc.push((run += Math.max(s.delay, 1))); }
  const chosen = new Set();
  for (let i = 0; i < want; i++) {
    const target = ((i + 0.5) * total) / want;
    let idx = acc.findIndex((v) => v >= target);
    if (idx < 0) idx = n - 1;
    chosen.add(idx);
  }
  chosen.add(0);
  chosen.add(n - 1);
  let list = [...chosen].sort((a, b) => a - b);
  while (list.length > want) {
    const mids = list.slice(1, -1);
    if (!mids.length) break;   // 只剩首末两个，丢谁都不行 → 就交这两个，别死循环
    // 名额不够就先丢中间那些"只占一瞬间"的场景，长场景留在名额里
    const mid = mids.sort((a, b) => scenes[a].delay - scenes[b].delay)[0];
    list = list.filter((v) => v !== mid);
  }
  return list.map((i) => scenes[i]);
}

/** frames（含 rgba，或 S06 第一遍预算好的 sig/delay）→ 选中的帧号/延迟 + 场景数；物化交给第二遍。 */
function selectGifFrames(frames, width, height, want) {
  const total = frames.length;
  const scenes = toScenes(frames.map((f) => ({ ...f, width, height })));
  let picked = pickScenes(scenes, Math.max(1, Math.min(scenes.length, want || 1)));
  // ★ N26（用户实机报「识图看不了动图」）：整段动图被并成一个"场景"时，
  //   场景去重会把动图抽成一张静止画面 —— 8×8 指纹判"几乎不变"，而小幅高频
  //   动作（抖一下/眨眼/跳一下）在指纹里可能低于阈值，于是模型只看到首帧。
  //   兜底：本来就 >1 帧却只选出 1 帧 ⇒ 改成按帧号等距取，让动作变化看得见。
  if (picked.length === 1 && total > 1) {
    const take = Math.max(2, Math.min(total, want || 1));
    const idx = new Set();
    for (let i = 0; i < take; i++) idx.add(Math.min(total - 1, Math.round((i * (total - 1)) / (take - 1))));
    picked = [...idx].sort((a, b) => a - b).map((i) => ({ index: i, delay: frames[i].delay || 0, sig: null }));
  }
  return { picked, sceneCount: scenes.length };
}

/**
 * 把多帧拼成一张图（时间顺序：从左到右、从上到下）。
 * 抽 6 帧不再是 6 张图 = 6 份视觉 token，而还是一张，这样"多抽"不额外花钱。
 */
export function tileFrames(frames, { cols = 0, maxSide = 1024 } = {}) {
  const list = Array.isArray(frames) ? frames : [];
  if (list.length < 2) return list[0] ? { rgba: list[0].rgba, width: list[0].width, height: list[0].height } : null;
  const w0 = Math.max(...list.map((f) => f.width || 0));
  const h0 = Math.max(...list.map((f) => f.height || 0));
  if (!w0 || !h0) return null;
  const n = list.length;
  const nc = Math.max(1, cols || Math.ceil(Math.sqrt(n)));
  const nr = Math.ceil(n / nc);
  // 整张拼图不超过 maxSide：等比缩小每一格（取整，避免半像素错位）
  let cw = w0;
  let ch = h0;
  const fit = Math.min(1, maxSide / (cw * nc), maxSide / (ch * nr));
  if (fit < 1) {
    cw = Math.max(24, Math.floor(w0 * fit));
    ch = Math.max(24, Math.floor(h0 * fit));
  }
  const ow = cw * nc;
  const oh = ch * nr;
  const out = Buffer.alloc(ow * oh * 4);
  // ★ 2026-10-27（溟）：先整张铺白底，再逐格贴；格与格之间画 2px 灰色分隔线。
  //   以前透明像素直接写 alpha=0（注释写的是"填黑底"，代码其实没填）—— 表情包大片是透明的，
  //   拼完就是一片黑/白糊在一起，哪格是哪帧根本看不出来。她的原话：「看 gif 是叠在一起的」。
  //   白底对视觉模型最稳（黑底会让它把整块当阴影），分隔线让"这是 N 格连续画面"一眼可见。
  for (let i = 0; i < out.length; i += 4) {
    out[i] = 255; out[i + 1] = 255; out[i + 2] = 255; out[i + 3] = 255;
  }
  for (let i = 0; i < n; i++) {
    const f = list[i];
    if (!f?.rgba || !f.width || !f.height) continue;
    const gx = (i % nc) * cw;
    const gy = Math.floor(i / nc) * ch;
    for (let y = 0; y < ch; y++) {
      const sy = Math.min(f.height - 1, Math.floor((y * f.height) / ch));
      for (let x = 0; x < cw; x++) {
        const sx = Math.min(f.width - 1, Math.floor((x * f.width) / cw));
        const so = (sy * f.width + sx) * 4;
        if (f.rgba[so + 3] <= 8) continue;   // 透明像素留白底（不再留成透明块）
        const o = ((gy + y) * ow + gx + x) * 4;
        out[o] = f.rgba[so];
        out[o + 1] = f.rgba[so + 1];
        out[o + 2] = f.rgba[so + 2];
        out[o + 3] = 255;
      }
    }
  }
  // 分隔线（画在格边界上，颜色取深灰、4px：2px 浅灰在缩放后基本看不见，
  // 六格连成一片 —— 她说的「叠在一起」有一半是这条线没画够）
  const GAP = 4;
  const line = [0x33, 0x33, 0x33, 255];
  const paint = (x, y) => {
    if (x < 0 || x >= ow || y < 0 || y >= oh) return;
    const o = (y * ow + x) * 4;
    out[o] = line[0]; out[o + 1] = line[1]; out[o + 2] = line[2]; out[o + 3] = line[3];
  };
  for (let c = 1; c < nc; c++) {
    for (let x = 0; x < GAP; x++) for (let y = 0; y < oh; y++) paint(c * cw + x, y);
  }
  for (let r = 1; r < nr; r++) {
    for (let y = 0; y < GAP; y++) for (let x = 0; x < ow; x++) paint(x, r * ch + y);
  }
  return { rgba: out, width: ow, height: oh, cols: nc, rows: nr };
}

// ── ffmpeg（可选，处理 webp/avif/bmp 等）────────────────────────────────
// ★ S07（第二批体验修复清单）：转码以前走 `spawnSync` —— 探测最长堵 4 秒、转码最长堵 15 秒，
//   整条消息处理链被同步卡死。现在改成**异步子进程 + 小并发闸 + 超时/取消清理**：
//   · resolveFfmpeg()：单飞（single-flight）异步探测，多路请求共享同一次探测；
//   · convertWithFfmpeg()：并发上限 FFMPEG_MAX_CONCURRENT=2，超出排队；
//   · 超时/中止都杀掉子进程，临时目录在 finally 里收干净（不留僵尸定时器、不留孤儿进程）。

const FFMPEG_PROBE_TIMEOUT_MS = 4000;
const FFMPEG_CONVERT_TIMEOUT_MS = 15000;
/** 同时最多跑几个 ffmpeg 转码（探测不计入：它是轻量 -version，且单飞）。 */
const FFMPEG_MAX_CONCURRENT = 2;

let ffmpegPathCache = null;      // null=未探测；''=确认没有；否则是可用路径
let ffmpegProbePromise = null;   // 单飞探测 Promise

function ffmpegCandidates() {
  // ★ 2026-10-17（安全审查）：候选顺序改成"**显式配置 → 随包 → PATH → 常规自装位置**"。
  //   改前第一项就是裸 `'ffmpeg'`，后面跟着几条**硬编码的本机绝对路径**，其中
  //   `D:\ffmpeg\bin\ffmpeg.exe` 是这台机器的私有布局（换台机器就没了），却跟着源码
  //   一起分发、还排在通用位置前面 —— 看着像"默认支持"，实际只对作者那台机器成立。
  //   现在：环境变量（显式覆盖）→ 随包目录 → PATH → 两个**通用**的 Windows 自装位置。
  //   前四项能覆盖绝大多数机器；最后两项保留是为了不砍掉"装在固定目录、没进 PATH"
  //   这类合法本地用法（删了就是砍功能，不是修问题）。
  const exeSuffix = process.platform === 'win32' ? '.exe' : '';
  const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'runtime', 'ffmpeg');
  return [
    String(process.env.FFMPEG_PATH || process.env.FFMPEG || '').trim(),
    path.join(bundled, 'bin', `ffmpeg${exeSuffix}`),
    path.join(bundled, `ffmpeg${exeSuffix}`),
    'ffmpeg',
    `C:\\ffmpeg\\bin\\ffmpeg${exeSuffix}`,
    `C:\\Program Files\\ffmpeg\\bin\\ffmpeg${exeSuffix}`
  ].filter(Boolean);
}

/** 异步探测一个候选能不能跑（`-version` exit 0），超时即杀。 */
function probeBinary(bin, timeoutMs = FFMPEG_PROBE_TIMEOUT_MS) {
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

/** 单飞异步探测：多个转码请求只跑一轮候选表；'' = 本机没有（与老缓存语义一致）。 */
function resolveFfmpeg() {
  if (ffmpegPathCache !== null) return Promise.resolve(ffmpegPathCache);
  if (!ffmpegProbePromise) {
    ffmpegProbePromise = (async () => {
      for (const bin of ffmpegCandidates()) {
        if (await probeBinary(bin)) { ffmpegPathCache = bin; return bin; }
      }
      ffmpegPathCache = '';
      return '';
    })().finally(() => { ffmpegProbePromise = null; });
  }
  return ffmpegProbePromise;
}

let ffmpegRunning = 0;
const ffmpegWaiters = [];
function acquireFfmpegSlot() {
  if (ffmpegRunning < FFMPEG_MAX_CONCURRENT) {
    ffmpegRunning += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => { ffmpegWaiters.push(resolve); });
}
function releaseFfmpegSlot() {
  const next = ffmpegWaiters.shift();
  if (next) next();
  else ffmpegRunning -= 1;
}

/** 跑一次 ffmpeg；超时/中止都会杀掉子进程。返回 exit===0。 */
function runFfmpeg(bin, args, { signal = null, timeoutMs = FFMPEG_CONVERT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let child = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { if (child && !child.killed) child.kill(); } catch { /* ignore */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onAbort = () => finish(false);
    if (signal) {
      if (signal.aborted) { finish(false); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: 'ignore' });
    } catch { finish(false); return; }
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

/** 用 ffmpeg 把 buffer 转成 jpeg（首帧）。失败/超时/中止返回 null（不抛）。 */
async function convertWithFfmpeg(buf, mime, { signal = null } = {}) {
  if (!buf?.length || signal?.aborted) return null;
  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg || signal?.aborted) return null;
  await acquireFfmpegSlot();
  let tmpDir = '';
  try {
    if (signal?.aborted) return null;
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'qq-vision-'));
    const ext = /png/i.test(mime) ? 'png'
      : /gif/i.test(mime) ? 'gif'
        : /webp/i.test(mime) ? 'webp'
          : /avif/i.test(mime) ? 'avif'
            : /bmp/i.test(mime) ? 'bmp'
              : 'img';
    const inFile = path.join(tmpDir, `in.${ext}`);
    const outFile = path.join(tmpDir, 'out.jpg');
    await fs.promises.writeFile(inFile, buf);
    const ok = await runFfmpeg(ffmpeg, [
      '-y', '-i', inFile,
      '-frames:v', '1',
      '-q:v', '3',
      outFile
    ], { signal });
    if (ok && !signal?.aborted) {
      const out = await fs.promises.readFile(outFile);
      if (out.length > 100) return out;
    }
  } catch { /* ignore */ }
  finally {
    releaseFfmpegSlot();
    if (tmpDir) {
      try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  return null;
}

// ── 对外：buffer → 视觉 dataURL 列表 ────────────────────────────────────

/**
 * 把一张图变成可喂给视觉模型的 data URL 列表。
 *
 * @param {Buffer} buffer 原始字节
 * @param {object} opts
 * @param {string} [opts.mime] 已知 mime（可省略，自动魔数识别）
 * @param {number} [opts.maxFrames] GIF 最多抽几帧（默认 6）
 * @param {boolean} [opts.tile] 多帧拼成一张图（默认 true：抽得多但不多花视觉 token）
 * @param {AbortSignal} [opts.signal] 调用方取消信号（S07：转码子进程会随之被杀）
 * @returns {Promise<{ dataUrls: string[], skipped: boolean, note: string, converted: boolean, frameCount: number }>}
 *
 * - png/jpeg：原样
 * - gif：按场景去重 + 时长加权抽帧转 PNG（失败/超本地上限则回退原 gif 直发并说明）
 * - 其它：有 ffmpeg 则转 jpeg；否则按 visionUnsupported 决定跳过或直发
 */
export async function toVisionDataUrls(buffer, { mime = null, maxFrames = 6, tile = true, signal = null } = {}) {
  const m = String(mime || detectImageMime(buffer) || '').split(';')[0].toLowerCase();
  const fallback = () => ({
    dataUrls: m && buffer?.length ? [dataUrl(m, buffer)] : [],
    skipped: false,
    note: '',
    converted: false,
    frameCount: buffer?.length ? 1 : 0
  });

  if (!buffer || !buffer.length) {
    return { dataUrls: [], skipped: true, note: '空图片', converted: false, frameCount: 0 };
  }

  const extensionRejects = await extensionRejectsMime(m);
  const rejectedNote = `（图片兼容设置判定 ${m || '未知格式'} 当前不支持，已跳过）`;

  if (isPassThrough(m) || !m) {
    if (extensionRejects) {
      return { dataUrls: [], skipped: true, note: rejectedNote, converted: false, frameCount: 0 };
    }
    // 未知 mime 仍尝试当 jpeg 发（有 visionUnsupported/isImageRejection 兜底）
    const useMime = m || 'image/jpeg';
    return {
      dataUrls: [dataUrl(useMime, buffer)],
      skipped: false,
      note: '',
      converted: false,
      frameCount: 1
    };
  }

  // GIF → 多帧 PNG（默认拼成一张，避免"多抽=多花钱"）
  if (m === 'image/gif') {
    const { frames, reason } = decodeGifFramesDetailed(buffer, { maxFrames: Math.max(1, Math.min(12, Number(maxFrames) || 6)) });
    if (frames.length) {
      if (frames.length > 1 && tile !== false) {
        const one = tileFrames(frames);
        if (one?.rgba) {
          return {
            dataUrls: [dataUrl('image/png', encodePng(one.rgba, one.width, one.height))],
            skipped: false,
            note: `（GIF 动图已按时间顺序把 ${frames.length} 个关键画面拼成一张：从左到右、从上到下。请据此判断动作的先后与笑点，别当成好几张不同的图）`,
            converted: true,
            frameCount: frames.length
          };
        }
      }
      const dataUrls = frames.map((f) => dataUrl('image/png', encodePng(f.rgba, f.width, f.height)));
      // ★ N-GIF6（用户实机报"没有引导说是一个动图，他看见的是六个图片"）：拼图路之外的
      //   兜底支（多帧直发）措辞必须同样硬——明说"这是同一张动图的连续画面，不是 N 张不同图"，
      //   否则模型/用户都会把抽出的帧数当成图片张数。
      const note = frames.length > 1
        ? `（GIF 动图已抽出 ${frames.length} 帧按时间顺序排列——这是**同一张动图**的连续画面，不是 ${frames.length} 张不同的图；请据此判断动作的先后与变化）`
        : '（GIF 已转为首帧 PNG）';
      return { dataUrls, skipped: false, note, converted: true, frameCount: frames.length };
    }
    // 解码失败/超本地上限：仍直发原 gif（部分接口能吃），但把"为什么没抽帧"如实说清
    if (extensionRejects) {
      return { dataUrls: [], skipped: true, note: rejectedNote, converted: false, frameCount: 0 };
    }
    return {
      ...fallback(),
      note: reason === 'capped' ? '（GIF 帧数/像素超过本地上限，按原图发送）' : '（GIF 解码失败，按原图发送）'
    };
  }

  // webp / avif / bmp / heic …
  if (visionUnsupported(m) || extensionRejects) {
    const jpeg = await convertWithFfmpeg(buffer, m, { signal });
    if (jpeg) {
      return {
        dataUrls: [dataUrl('image/jpeg', jpeg)],
        skipped: false,
        note: extensionRejects
          ? '（图片兼容设置禁止原格式，已转成 JPEG）'
          : '（原图格式当前接口不支持，已转成 JPEG）',
        converted: true,
        frameCount: 1
      };
    }
    return {
      dataUrls: [], skipped: true,
      note: extensionRejects ? rejectedNote : `${m} 当前接口不支持且无法转换，已跳过`,
      converted: false, frameCount: 0
    };
  }

  // 接口可能支持（如百炼收 webp）：优先 ffmpeg 转稳，失败则直发
  const jpeg = await convertWithFfmpeg(buffer, m, { signal });
  if (jpeg) {
    return {
      dataUrls: [dataUrl('image/jpeg', jpeg)],
      skipped: false,
      note: '（已转成 JPEG 以提高兼容性）',
      converted: true,
      frameCount: 1
    };
  }
  return { ...fallback(), note: `（${m} 直发）` };
}

/** 同步便捷版：只要一个 data URL（GIF 也至少给首帧/原图）。 */
export function toVisionDataUrlSync(buffer, { mime = null, maxFrames = 1, tile = true } = {}) {
  const m = String(mime || detectImageMime(buffer) || 'image/jpeg').split(';')[0].toLowerCase();
  if (m === 'image/gif') {
    const frames = decodeGifFrames(buffer, { maxFrames: Math.max(1, Math.min(12, Number(maxFrames) || 1)) });
    if (frames.length) {
      const one = (frames.length > 1 && tile !== false) ? (tileFrames(frames) || frames[0]) : frames[0];
      return dataUrl('image/png', encodePng(one.rgba, one.width, one.height));
    }
  }
  if (m === 'image/webp' || m === 'image/avif' || m === 'image/bmp') {
    // ★ S07：同步版不再 spawn 转码（会阻塞事件循环）—— 需要转码的格式若接口不支持就如实回 null，
    //   转码只在异步 toVisionDataUrls 侧做（带超时/取消）。调用方拿到 null 不会误以为能直发。
    if (visionUnsupported(m)) return null;
  }
  return dataUrl(m, buffer);
}
