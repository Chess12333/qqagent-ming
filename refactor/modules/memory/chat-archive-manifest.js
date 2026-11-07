/**
 * M6 memory · 冷分片清单（cold manifest）—— chat-store 的**存档专用辅助**（纯格式、零 IO、零依赖）
 *
 * 为什么需要它（2026-10-19 S09 读放大修复，ds4 `8fa3addc`）：
 *   chat-store 的冷分片正文（`<dataDir>/messages-cold/<safe>.NNNNN.json`）此前在会话**首次**
 *   装入内存时被整份读一遍（`loadChat` 全量扫冷片）。老群恢复/查询只取几条热消息，也要付
 *   几 MB 的同步 IO（S09 实测：4 片 2.87MB；同实例第二次不重读）。本模块定义一份**可校验的
 *   分片元数据**，让读取方先只看清单（几 KB），正文**按需**再读；清单对不上就退回读正文
 *   （自愈）。**清单永远只是缓存**：坏清单 / 对不上的清单 / 缺片，一律由调用方退回读正文，
 *   绝不据此删改任何数据（"缺片不当已删除"由 chat-store 的并集逻辑保证，本模块只描述格式）。
 *
 * 放置：`<dataDir>/messages-cold-meta/<safe>.json`（与 `messages-revisions/` 同级的旁挂目录）。
 *   **绝不放进 `messages/` 或 `messages-cold/`**：那两个目录按消息布局被全体读取方扫
 *   （archive-view 的快照、store.selftest 的命名断言），混进非消息文件会被当消息或坏冷分片
 *   —— 同 history-cut.js 的放置理由。
 *
 * 形状（version 1）：
 *   { version, chatKey, chunks: [entry...] }；entry 字段见 `buildColdManifestEntry`。
 *   每个 entry 带文件戳（size/mtimeMs/ctimeMs）：三项全等才允许信任其余元数据；
 *   任一项取不到/对不上 ⇒ 该片退回读正文重建（且不算"文件被删"）。
 *
 * 纪律：本模块**只做格式**——读/写/重试/留痕全在 chat-store.js（那里有 health 与原子写）。
 */
export const COLD_MANIFEST_VERSION = 1;

function isRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** 有限数收纳：NaN/Infinity/非数字 → null（JSON 不能表示 NaN，且读取侧按"没有"处理）。 */
function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Uint8Array → base64。不是 Uint8Array / 空数组 → null（null 在读取侧 = "没有布隆过滤，别跳过这片"）。 */
export function encodeColdBloom(bloom) {
  if (!(bloom instanceof Uint8Array) || !bloom.length) return null;
  return Buffer.from(bloom.buffer, bloom.byteOffset, bloom.byteLength).toString('base64');
}

/** base64 → Uint8Array；非字符串 / 解码长度不是 expectedBytes → null（保守：宁可让读取方读正文）。 */
export function decodeColdBloom(value, expectedBytes) {
  if (typeof value !== 'string' || !value) return null;
  let buf;
  try { buf = Buffer.from(value, 'base64'); } catch { return null; }
  if (!buf || buf.length !== expectedBytes) return null;
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * 清单 entry 的文件戳是否与此刻的 stat 一致：size + mtimeMs + ctimeMs 三项全等才可信。
 * ctimeMs 是写入即变的"变更时间"：同尺寸、同 mtime 的重写也躲不过它（比只对 size+mtime 硬）。
 * 任一为 null（取不到戳 / 清单缺戳）⇒ 一律不可信（走读正文的重建路径）。
 */
export function coldStampMatches(entry, stat) {
  if (!entry || !stat) return false;
  return Number.isFinite(entry.size) && entry.size === stat.size
    && Number.isFinite(entry.mtimeMs) && entry.mtimeMs === Number(stat.mtimeMs)
    && Number.isFinite(entry.ctimeMs) && entry.ctimeMs === Number(stat.ctimeMs);
}

/**
 * 从 chat-store 的分片记录字段构建规范 entry（只做 JSON 收纳，不做语义校验 —— 写入方内部可信）。
 * `sourceRevision*` 指分片 payload 顶层（数据文件自己内嵌的那份版本），含义与加载端口径一一对应：
 *   present=false ⇒ 老文件没带，不影响可靠性；present=true 且 valid=false ⇒ 读取侧要标 revision 不可靠。
 */
export function buildColdManifestEntry(fields = {}) {
  const present = fields.sourceRevisionPresent === true;
  return {
    seq: Number.isSafeInteger(fields.seq) && fields.seq >= 0 ? fields.seq : null,
    len: Number.isSafeInteger(fields.len) && fields.len >= 0 ? fields.len : null,
    firstId: finiteOrNull(fields.firstId),
    lastId: finiteOrNull(fields.lastId),
    idsIncreasing: fields.idsIncreasing === true,
    lastTs: finiteOrNull(fields.lastTs),
    lastText: typeof fields.lastText === 'string' ? fields.lastText : null,
    maxSourceRevision: isRevision(fields.maxSourceRevision) ? fields.maxSourceRevision : 0,
    sourceRevision: isRevision(fields.sourceRevisionValue) ? fields.sourceRevisionValue : null,
    sourceRevisionPresent: present,
    sourceRevisionValid: present ? fields.sourceRevisionValid === true : true,
    sourceRevisionsPresent: fields.sourceRevisionsPresent === true,
    sourceRevisionsValid: fields.sourceRevisionsPresent === true ? fields.sourceRevisionsValid === true : true,
    bloom: typeof fields.bloom === 'string' && fields.bloom ? fields.bloom : null,
    size: finiteOrNull(fields.stamp?.size),
    mtimeMs: finiteOrNull(fields.stamp?.mtimeMs),
    ctimeMs: finiteOrNull(fields.stamp?.ctimeMs),
  };
}

/**
 * 解析并校验清单文件（已 JSON.parse 的 value）。结构层面不成立 → null（调用方退回全量正文路径）。
 * 单条 entry 坏 → 丢这一条（其余仍可用；这片下次加载会走读正文重建）。
 * @returns {Map<number, object>|null} seq → 规范 entry
 */
export function parseColdManifest(value, chatKey) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.version !== COLD_MANIFEST_VERSION || value.chatKey !== chatKey || !Array.isArray(value.chunks)) return null;
  const out = new Map();
  for (const raw of value.chunks) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const seq = raw.seq;
    const len = raw.len;
    if (!Number.isSafeInteger(seq) || seq < 0 || !Number.isSafeInteger(len) || len < 0) continue;
    if (out.has(seq)) continue;
    const present = raw.sourceRevisionPresent === true;
    out.set(seq, {
      seq,
      len,
      firstId: finiteOrNull(raw.firstId),
      lastId: finiteOrNull(raw.lastId),
      idsIncreasing: raw.idsIncreasing === true,
      lastTs: finiteOrNull(raw.lastTs),
      lastText: typeof raw.lastText === 'string' ? raw.lastText : null,
      maxSourceRevision: isRevision(raw.maxSourceRevision) ? raw.maxSourceRevision : 0,
      sourceRevision: isRevision(raw.sourceRevision) ? raw.sourceRevision : null,
      sourceRevisionPresent: present,
      sourceRevisionValid: present ? raw.sourceRevisionValid === true : true,
      sourceRevisionsPresent: raw.sourceRevisionsPresent === true,
      sourceRevisionsValid: raw.sourceRevisionsPresent === true ? raw.sourceRevisionsValid === true : true,
      bloom: typeof raw.bloom === 'string' && raw.bloom ? raw.bloom : null,
      size: finiteOrNull(raw.size),
      mtimeMs: finiteOrNull(raw.mtimeMs),
      ctimeMs: finiteOrNull(raw.ctimeMs),
    });
  }
  return out;
}

/** 序列化：丢掉构建失败（seq 非法）的 entry，按 seq 升序。 */
export function serializeColdManifest(chatKey, entries) {
  const chunks = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && Number.isSafeInteger(entry.seq) && entry.seq >= 0)
    .sort((a, b) => a.seq - b.seq);
  return { version: COLD_MANIFEST_VERSION, chatKey, chunks };
}
