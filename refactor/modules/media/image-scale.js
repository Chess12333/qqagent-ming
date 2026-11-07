// N85：纯 JS 图像缩放（零依赖）—— PNG 解码 + 最近邻缩放 + 复用 vision-image 的 encodePng。
// 只做"确定能用的那部分"：PNG（纯 JS 可解）。GIF **不在本文件缩** —— 动图由
// auto-vision 放过原图字节闸、直接走 vision-image 的抽帧拼图（tileFrames 已会缩到
// ≤1024²），比在本文件重新实现一份 GIF 解码可靠。JPEG/WEBP 等需要真解码器 ⇒ 走调用方
// 注入的 `decodeForeign`（例如 sharp 的动态 import），没有就明说。
import zlib from 'node:zlib';

/** PNG 解码（只支撑本项目会用到的形态：8bit RGB/RGBA、非隔行）。失败返回 null，不抛。 */
export function decodePng(buf) {
  try {
    if (!buf || buf.length < 33) return null;
    if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) return null;
    let p = 8;
    let width = 0; let height = 0; let bitDepth = 0; let colorType = 0; let interlace = 0;
    const idat = [];
    let palette = null;
    while (p + 8 <= buf.length) {
      const len = buf.readUInt32BE(p);
      const type = buf.toString('ascii', p + 4, p + 8);
      const data = buf.subarray(p + 8, p + 8 + len);
      if (type === 'IHDR') {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8];
        colorType = data[9];
        interlace = data[12];
      } else if (type === 'PLTE') palette = data;
      else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') break;
      p += 12 + len;
    }
    if (!width || !height || interlace !== 0) return null;
    if (bitDepth !== 8) return null;                       // 只认 8bit
    const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 3 ? 1 : 0;
    if (!channels) return null;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const bpp = channels;
    const stride = width * bpp;
    const out = Buffer.alloc(width * height * 4);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
      const ft = raw[y * (stride + 1)];
      const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
      const cur = Buffer.from(line);
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        if (ft === 1) cur[i] = (cur[i] + a) & 0xff;
        else if (ft === 2) cur[i] = (cur[i] + b) & 0xff;
        else if (ft === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff;
        else if (ft === 4) {
          const pp = a + b - c;
          const pa = Math.abs(pp - a); const pb = Math.abs(pp - b); const pc = Math.abs(pp - c);
          cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
        }
      }
      for (let x = 0; x < width; x++) {
        const s = x * bpp;
        const o = (y * width + x) * 4;
        if (colorType === 3) {
          const idx = cur[s];
          out[o] = palette ? palette[idx * 3] : 0;
          out[o + 1] = palette ? palette[idx * 3 + 1] : 0;
          out[o + 2] = palette ? palette[idx * 3 + 2] : 0;
          out[o + 3] = 255;
        } else if (bpp === 3) {
          out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = 255;
        } else {
          out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = cur[s + 3];
        }
      }
      prev = cur;
    }
    return { rgba: out, width, height };
  } catch {
    return null;
  }
}

/** 最近邻缩放到"最长边 ≤ maxSide"（不动小图）。 */
export function scaleRgba(img, maxSide = 1024) {
  if (!img?.rgba || !img.width || !img.height) return null;
  const { width: w, height: h, rgba } = img;
  const longest = Math.max(w, h);
  if (longest <= maxSide) return img;
  const k = maxSide / longest;
  const nw = Math.max(1, Math.round(w * k));
  const nh = Math.max(1, Math.round(h * k));
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / nh));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / nw));
      const so = (sy * w + sx) * 4;
      const o = (y * nw + x) * 4;
      out[o] = rgba[so]; out[o + 1] = rgba[so + 1]; out[o + 2] = rgba[so + 2]; out[o + 3] = rgba[so + 3];
    }
  }
  return { rgba: out, width: nw, height: nh };
}

/**
 * 把一张超限的图缩到能附的大小。
 * @returns {{ok:true, buffer:Buffer, mime:string, note:string, scaled:boolean}|
 *          {ok:false, reason:string}}
 * 顺序：PNG 纯 JS 解 → 缩 → 重新编码 PNG；其余格式交给调用方注入的 `decodeForeign`
 * （sharp 之类）；都没有 ⇒ {ok:false}（调用方据此退回"超限不附 + 明说"）。
 */
export async function shrinkImageForVision(buffer, mime, { encodePng, decodeForeign = null, maxSide = 1024 } = {}) {
  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (mime === 'image/png') {
    const img = decodePng(buffer);
    if (!img) return { ok: false, reason: 'PNG 解不开（形态不支持：非 8bit / 隔行 / 损坏）' };
    const small = scaleRgba(img, maxSide);
    if (!small || !encodePng) return { ok: false, reason: '缩放或编码器不可用' };
    if (small === img) return { ok: false, reason: `PNG 最长边 ${Math.max(img.width, img.height)} 已不超 ${maxSide}` };
    const out = encodePng(small.rgba, small.width, small.height);
    if (!out?.length) return { ok: false, reason: 'PNG 重新编码失败' };
    const note = `（原图 ${mb(buffer.length)}／${img.width}×${img.height} 太大，已缩到 ${small.width}×${small.height} 再送模型：`
      + '看得清主体和动作就行，细节以缩图为准，别把压缩噪点当画面内容）';
    return { ok: true, buffer: out, mime: 'image/png', note, scaled: true, width: small.width, height: small.height };
  }
  if (typeof decodeForeign === 'function') {
    try {
      const r = await decodeForeign(buffer, mime, { maxSide });
      if (r?.ok && r.buffer?.length) return r;
      if (r?.reason) return { ok: false, reason: r.reason };
    } catch (error) {
      return { ok: false, reason: `外部解码器失败（${String(error?.message ?? error).slice(0, 60)}）` };
    }
  }
  return { ok: false, reason: `${mime || '该格式'} 没有可用解码器（纯 JS 只支持 PNG；GIF 请走抽帧 toVisionDataUrls，JPEG/WEBP 需 sharp 或 ffmpeg）` };
}
