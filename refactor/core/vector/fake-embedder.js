import { createHash } from 'node:crypto';
import { makeProfile, profileFingerprint, embeddingCacheKey } from './profile.js';

/**
 * V1a 假嵌入器（票 §二.2）：确定性（同文本同向量）、dims 取自 profile、无 IO、无时钟、无随机源。
 * 供 J/M/E 三条线今天就能动 + 自检用。真机对照（768 维/CLS/归一化/截断/延迟）是 V1b 的事，这里只保证形状。
 *
 * ★ 向量只由模板化文本派生，purpose 不掺入向量：真机同模板同输入必出同向量，
 *   掺 purpose 会造出"真机复现不了"的假行为。query/document 隔离只体现在 cacheKey（含 purpose）。
 */

function seedFromText(templatedText) {
  const h = createHash('sha256').update(templatedText, 'utf8').digest();
  return (h.readUInt32BE(0) ^ h.readUInt32BE(4) ^ h.readUInt32BE(8) ^ h.readUInt32BE(12)) >>> 0;
}

function mulberry32(a) {
  let s = a >>> 0;
  return function next() {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 确定性伪向量：sha256(文本)→种子→均匀分布→L2 归一。跨文本余弦 ~N(0, 1/dims)。 */
export function fakeVectorForText(templatedText, dims) {
  const rand = mulberry32(seedFromText(String(templatedText)));
  const vec = new Float32Array(dims);
  let norm = 0;
  for (let i = 0; i < dims; i += 1) {
    const x = rand() * 2 - 1;
    vec[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm);
  if (!(norm > 0)) throw new Error('fake embedder produced a zero vector (impossible without a broken PRNG)');
  for (let i = 0; i < dims; i += 1) vec[i] /= norm;
  return vec;
}

/** 余弦相似度（等长数值数组；长度不等当场 throw，不静默回 0）。 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) throw new TypeError('cosineSimilarity needs two equal-length vectors');
  if (a.length === 0) return 0;
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]; const y = b[i];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new TypeError(`cosineSimilarity needs finite numbers (index ${i})`);
    }
    dot += x * y; aa += x * x; bb += y * y;
  }
  if (!(aa > 0) || !(bb > 0)) return 0; // 零向量按 0 分，不产 NaN（调测用；入库向量由 validateDimensions 把关）
  return dot / Math.sqrt(aa * bb);
}

function applyTemplate(template, text) {
  return String(template).split('{text}').join(String(text));
}

export function makeFakeEmbedder(profile) {
  const frozen = makeProfile(profile); // 非法 profile 当场 throw（显式失败，不带病干活）
  const dims = frozen.dims;
  const fingerprint = profileFingerprint(frozen);
  async function embed(text, opts = {}) {
    const purpose = opts ? opts.purpose : undefined;
    if (purpose !== 'query' && purpose !== 'document') {
      return { ok: false, status: 'error', reason: 'purpose must be query or document' };
    }
    if (typeof text !== 'string') {
      return { ok: false, status: 'error', reason: 'text must be a string' };
    }
    const template = purpose === 'document' ? frozen.docTemplate : frozen.queryTemplate;
    const templated = applyTemplate(template, text);
    const vec = fakeVectorForText(templated, dims);
    return {
      ok: true,
      vec,
      dims,
      cacheKey: embeddingCacheKey(frozen, purpose, templated),
      fingerprint,
    };
  }
  return Object.freeze({ profile: frozen, fingerprint: () => fingerprint, embed });
}
