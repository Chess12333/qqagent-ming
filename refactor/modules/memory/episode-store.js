import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
// ★ 2026-10-17（向量生产接线）：情节摘要的向量记录派生走**唯一** scope 归一入口（semantic.js）；
//   点名遗忘判据只消费调用方传入的生效编号集合（本模块不自己开抑制表，写侧/读侧口径各归其位）。
import { normalizeScope } from './semantic.js';
import { namesSuppressedSource, ledgerHealthOf } from './suppressions.js';

/** Read episode rows with the coordinator's historical parsing rules. */
export function inspectEpisodeRows(dataDir) {
  const file = path.join(dataDir, 'memory', 'episodes.jsonl');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { rows: [], badLines: 0, exists: false, readable: true, error: null };
    return { rows: null, badLines: null, exists: true, readable: false, error: String(error?.message ?? error) };
  }
  const out = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    const s = String(line || '').trim();
    if (!s) continue;
    try {
      const row = JSON.parse(s);
      if (row && typeof row === 'object') out.push(row);
    } catch { badLines += 1; /* malformed lines are skipped, as before */ }
  }
  return { rows: out, badLines, exists: true, readable: true, error: null };
}

export function readEpisodeRows(dataDir) {
  return inspectEpisodeRows(dataDir).rows ?? [];
}

// ── 2026-10-17（向量生产接线）· stat 快照 + 记录派生 ─────────────────────────────

/** episodes.jsonl 的文件修订号（size:mtime；给快照缓存判"要不要重读"）。 */
function episodeFileRevision(dataDir) {
  const file = path.join(String(dataDir ?? ''), 'memory', 'episodes.jsonl');
  try {
    const st = fs.statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return '';
  }
}

const episodeSnapshotsByDataDir = new Map();

/**
 * episodes.jsonl 只读快照（stat 缓存：文件没动就复用上次解析；status/prepareContext 的热路径
 * 不再每次整读。行序保持文件顺序 —— prepareContext 的 `slice(-20)`「末尾最新」语义不变）。
 * @returns {{rows:Array|null, badLines:number|null, exists:boolean, readable:boolean, error:string|null, cached:boolean}}
 */
export function cachedEpisodeRows(dataDir) {
  const key = path.resolve(String(dataDir ?? ''));
  const revision = episodeFileRevision(key);
  const cached = episodeSnapshotsByDataDir.get(key);
  if (cached && cached.revision === revision) return { ...cached.snap, cached: true };
  const inspected = inspectEpisodeRows(key);
  const snap = inspected.readable
    ? { rows: inspected.rows, badLines: inspected.badLines, exists: inspected.exists, readable: true, error: null }
    : { rows: null, badLines: null, exists: inspected.exists, readable: false, error: inspected.error };
  episodeSnapshotsByDataDir.set(key, { revision, snap });
  return { ...snap, cached: false };
}

/** 情节行条数（只读轻计数；status 面板用，不返回任何摘要正文）。 */
export function episodeCount(dataDir) {
  return cachedEpisodeRows(dataDir).rows?.length ?? 0;
}

/**
 * 无真实 id 的旧行按**当时真实内容**做确定性派生 id（sha1 前缀 `ep-der-`）：
 *   `(chatKey, 规范化 summary, 真实 sourceRefs 指针, 真实内容时间)` —— 同一行跨重启、跨快照都是同一个 id；
 *   只要 summary/refs/时间其一不同就得到不同 id（换版本≠被覆盖，两条都真在账里）。
 * 前缀 `ep-` 与 `validateEpisodes` 生成的真实主键 `ep-<ts>-<i>` 同前缀但辨别域不同（`der-` 段），
 * 读侧只按 id 直查权威行映射，不解析前缀语义。
 */
export function deriveEpisodeRecordId(row) {
  const chatKey = String(row?.namespace?.chatKey ?? '');
  const normSummary = String(row?.summary ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const refIds = (Array.isArray(row?.sourceRefs) ? row.sourceRefs : [])
    .map((r) => String(r?.messageId ?? '').trim()).filter(Boolean).join('|');
  const contentAt = (Array.isArray(row?.sourceRefs) ? row.sourceRefs : [])
    .map((r) => Number(r?.at)).filter((v) => Number.isFinite(v) && v > 0)
    .reduce((min, v) => (min === 0 ? v : Math.min(min, v)), 0)
    || Number(row?.at) || 0;
  const hash = createHash('sha1').update(`${chatKey}\u0000${normSummary}\u0000${refIds}\u0000${contentAt}`).digest('hex').slice(0, 16);
  return `ep-der-${hash}`;
}

/** 行的记录主键：有真实 id 用真实 id；旧行（无 id）用上面的确定性派生 id。 */
export function episodeRecordId(row) {
  const id = String(row?.id ?? '').trim();
  return id || deriveEpisodeRecordId(row);
}

/** 同 id 重写（如归属标回写）→ **最后一行**当权威（文件顺序 = 写序）。 */
export function latestEpisodeRowsById(dataDir) {
  const rows = cachedEpisodeRows(dataDir).rows ?? [];
  const byId = new Map();
  for (const row of rows) {
    const id = episodeRecordId(row);
    if (id) byId.set(id, row);
  }
  return byId;
}

/**
 * 情节摘要行 → 向量记录。**只用真实主键/真实引用/真实时间，绝不编造**：
 *   · id = row.id（`validateEpisodes` 写入时的真实主键）或旧行的确定性派生 id（标 `ep-der-`）；
 *   · evidenceIds = sourceRefs 里的真实 messageId（`validateEpisodes` 保证当时逐条在证据账本里；
 *     更老的行未经该校验 —— 引用仍是**写行当时的真引用**，照实带走，不回填所谓"补证"）；
 *   · `at` = 来源引用里的真实内容时间（最早），退而取行被写下的真实时刻；两者都没有 ⇒ 隔离；
 *   · `validUntil` 过线 / 摘要为空 / 引用编号为空 / 命中点名遗忘 ⇒ 隔离（如实记账，不报错）。
 *
 * @returns {{accepted:true, record:object} | {accepted:false, isolated:true, reason:string}}
 */
export function episodeRowToRecord(row, { now = Date.now(), namedSuppressed = null } = {}) {
  if (namedSuppressed && !ledgerHealthOf(namedSuppressed).ok) return { accepted: false, isolated: true, reason: 'suppression-ledger-unreadable' };
  if (!row || typeof row !== 'object') return { accepted: false, isolated: true, reason: 'bad-episode-row' };
  const summary = String(row?.summary ?? '').trim();
  if (!summary) return { accepted: false, isolated: true, reason: 'empty-summary' };
  const nowTs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const validUntil = row?.validUntil == null ? null : Number(row.validUntil);
  if (validUntil != null && Number.isFinite(validUntil) && validUntil < nowTs) {
    return { accepted: false, isolated: true, reason: 'valid-until-passed' };
  }
  const chatKey = String(row?.namespace?.chatKey ?? '');
  if (!chatKey) return { accepted: false, isolated: true, reason: 'missing-chatKey' };
  const refs = Array.isArray(row?.sourceRefs) ? row.sourceRefs : [];
  const evidenceIds = [...new Set(refs
    .map((r) => String(r?.messageId ?? '').trim())
    .filter(Boolean))];
  if (!evidenceIds.length) return { accepted: false, isolated: true, reason: 'no-real-source-refs' };
  if (namedSuppressed instanceof Set && namesSuppressedSource(evidenceIds, namedSuppressed)) {
    return { accepted: false, isolated: true, reason: 'named-suppressed-sources' };
  }
  const refAtTimes = refs.map((r) => Number(r?.at)).filter((v) => Number.isFinite(v) && v > 0);
  const contentAt = (refAtTimes.length ? Math.min(...refAtTimes) : 0) || Number(row?.at) || 0;
  if (!(Number.isFinite(Number(contentAt)) && Number(contentAt) > 0)) {
    return { accepted: false, isolated: true, reason: 'no-real-time' };
  }
  const kind = String(row?.namespace?.scope ?? inferScopeKind(chatKey));
  const scopeNorm = normalizeScope(kind, chatKey);
  if (!scopeNorm.ok) return { accepted: false, isolated: true, reason: String(scopeNorm.reason || 'scope-invalid') };
  return {
    accepted: true,
    record: {
      id: episodeRecordId(row),
      sourceId: episodeRecordId(row),
      type: 'episode_summary',
      sourceType: 'episode_summary',
      evidenceIds,
      scope: scopeNorm.scope,
      text: summary,
      at: Number(contentAt),
    },
  };
}

/** 会话 kind 只由 chatKey 前缀判（与 chat-search.js:13 `scopeOf` 同口径）。 */
export function inferScopeKind(chatKey) {
  return String(chatKey ?? '').startsWith('private:') ? 'private' : 'group';
}
