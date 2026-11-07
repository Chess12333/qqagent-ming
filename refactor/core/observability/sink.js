// Append-only observability sink with bounded daily shards. The legacy
// stream-YYYY-MM-DD.ndjson format remains readable.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeId } from './sanitize.js';
import { parseEpochMs } from './time.js';

export const RETENTION_DAYS = 14;
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MEMORY_RING = 200;
/** `read()` 的**有界尾读**：单次块 256KB、单次调用总字节预算 8MB（凑够行数就提前停）。
 *  `READ_MAX_LINE_BYTES`：单行字节上限 —— 超了记 `oversizedLines` 并跳过该行，不让一行把内存吃掉。 */
export const READ_CHUNK_BYTES = 256 * 1024;
export const READ_BUDGET_BYTES = 8 * 1024 * 1024;
export const READ_MAX_LINE_BYTES = 1024 * 1024;
const CAPACITY_WARNING_INTERVAL_MS = 60_000;
const SUCCESS_HEALTH_PERSIST_INTERVAL_MS = 60_000;
const MAX_EBUSY_RETRIES = 3;
const DEFAULT_APPEND_RETRY_DELAY_MS = 25;
const SHARD_RE = /^([a-z0-9_-]{1,24})-(\d{4}-\d{2}-\d{2})-(\d{6})\.ndjson$/;
const LEGACY_RE = /^([a-z0-9_-]{1,24})-(\d{4}-\d{2}-\d{2})\.ndjson$/;
const GAP_RE = /^tail-gap-([a-z0-9_-]{1,24})-(\d{4}-\d{2}-\d{2})-\d{6}-.+\.bin$/;

function dayOf(at) {
  // ★ 2026-10-17（时间统一）：分片归属也走同一份解析 —— 带时区 ISO 的行归到**它自己那一天**，
  //   不再 `Number('2026-…')=NaN → || Date.now()` 折成今天（那会让该行在本日窗口里又被行级过滤掉 ⇒ 两头都统计不到）。
  //   定位不到的行仍回落今天（**写盘总得落一个分片**）：这类行在统计侧记 `unknownAtRows` 并置 truncated，
  //   绝不把它们当"今天用了这些 token"。
  const ms = parseEpochMs(at);
  return new Date(ms ?? Date.now()).toISOString().slice(0, 10);
}
function localDayOf(at = Date.now()) {
  const date = new Date(Number(at));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function safeStream(name) { return safeId(name, 24, '') || ''; }
function errorCode(error) { return String(error?.code || error?.name || 'error'); }
function errorMessage(error) { return String(error?.message ?? error ?? 'error'); }
function normalizeDiagnostic(value, { retry = false } = {}) {
  if (!value || typeof value !== 'object') return null;
  const retries = Number(value.retries);
  const attempts = Number(value.attempts);
  const result = {
    at: typeof value.at === 'string' ? value.at : null,
    stream: safeStream(value.stream) || null,
    file: typeof value.file === 'string' ? path.basename(value.file) : '',
    operation: typeof value.operation === 'string' ? value.operation : 'unknown',
    code: typeof value.code === 'string' ? value.code : '',
    message: typeof value.message === 'string' ? value.message : '',
    retries: Number.isFinite(retries) ? Math.max(0, retries) : 0,
    attempts: Number.isFinite(attempts) ? Math.max(0, attempts) : 0
  };
  if (retry) result.status = ['retrying', 'recovered', 'failed'].includes(value.status) ? value.status : 'failed';
  return result;
}

const EMPTY_BUF = Buffer.alloc(0);
const LF_BYTE = 0x0a;
const CR_BYTE = 0x0d;

/** 尾读一次调用的**独立**状态（每次 read/readWithMeta 各一份，绝不全局共享 ⇒ 并发不串）。 */
function newScanState(count) {
  return {
    count,
    rows: [],
    budget: READ_BUDGET_BYTES,
    bytesRead: 0,
    oversizedLines: 0,
    malformedRows: 0,
    ioErrors: 0
  };
}

/** 按字节 0x0A 切段（不做解码 —— 多字节字符可能跨块，解码必须等整行凑齐）。返回 Buffer 视图数组。 */
function splitOnNewline(buf) {
  const out = [];
  let from = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === LF_BYTE) { out.push(buf.subarray(from, i)); from = i + 1; }
  }
  out.push(buf.subarray(from));
  return out;
}

/**
 * 解析一行**完整**的账本行字节：先摘掉结尾的 CR（CRLF 与空行口径与旧 `split(/\r?\n/).filter(Boolean)` 一致），
 * 再统一 `toString('utf8')` + JSON.parse。空行不算坏行；坏行计入 `malformedRows`（由调用方决定是否视为不完整）。
 */
function parseLedgerLine(bytes, st) {
  if (!bytes.length) return false;
  const line = bytes[bytes.length - 1] === CR_BYTE ? bytes.subarray(0, bytes.length - 1) : bytes;
  if (!line.length) return false;
  let row;
  try { row = JSON.parse(line.toString('utf8')); } catch { st.malformedRows += 1; return false; }
  if (!row || typeof row !== 'object') { st.malformedRows += 1; return false; }
  st.rows.push(row);
  return true;
}

export function createSink({
  obsDir, retentionDays = RETENTION_DAYS, maxFileBytes = MAX_FILE_BYTES, onWarn = null,
  appendFileImpl = fs.appendFile, appendRetryDelayMs = DEFAULT_APPEND_RETRY_DELAY_MS
} = {}) {
  const dir = obsDir ? path.resolve(obsDir) : null;
  const limit = Math.max(1, Number(maxFileBytes) || MAX_FILE_BYTES);
  const appendDelay = Number.isFinite(Number(appendRetryDelayMs)) ? Math.max(0, Number(appendRetryDelayMs)) : DEFAULT_APPEND_RETRY_DELAY_MS;
  let queue = Promise.resolve();
  let lastPrunedDay = '';
  const memory = new Map();
  const stats = {
    appends: 0, writeFailures: 0, writeRetries: 0, capacitySkips: 0, capacityDroppedBytes: 0, rowsDropped: 0,
    integrityGaps: 0, quarantinedBytes: 0, quarantinedFiles: 0,
    integrityStatus: 'ok', recentError: '', lastErrorAt: null, lastSuccessAt: null,
    lastFailure: null, lastRetry: null, activeFile: '', files: 0,
    // ★ 2026-10-17：`read()` 的尾读计数/实际读入字节（进程内计数，不持久化）——排障时能直接看见
    //   "这次读到底碰了多少字节"，而不是靠猜。
    readCalls: 0, readBytes: 0
  };
  const incompleteUsageDays = new Set();
  const unusableActiveFiles = new Set();
  const warnedAt = new Map();
  let healthQueue = Promise.resolve();
  let lastSuccessHealthPersistAt = 0;

  function persistHealth() {
    if (!dir) return;
    const snapshot = { ...stats, incompleteUsageDays: [...incompleteUsageDays] };
    healthQueue = healthQueue.then(async () => {
      const target = path.join(dir, 'obs-health.json');
      const temp = `${target}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temp, JSON.stringify(snapshot), { flag: 'wx' }); await fs.rename(temp, target); }
      catch { await fs.unlink(temp).catch(() => {}); }
    }).catch(() => {});
  }

  function recordSuccessfulAppend() {
    const previousSuccessAt = Date.parse(stats.lastSuccessAt || '');
    const errorAt = Date.parse(stats.lastErrorAt || '');
    const now = Date.now();
    stats.lastSuccessAt = new Date(now).toISOString();

    // Avoid rewriting the health snapshot for every event. Persist the first
    // success, recovery after a recorded error, and a periodic checkpoint.
    const wasRecovered = Number.isFinite(previousSuccessAt) && Number.isFinite(errorAt) && previousSuccessAt > errorAt;
    const isRecovered = Number.isFinite(errorAt) && now > errorAt;
    if (!Number.isFinite(previousSuccessAt) || (isRecovered && !wasRecovered)
      || now - lastSuccessHealthPersistAt >= SUCCESS_HEALTH_PERSIST_INTERVAL_MS) {
      lastSuccessHealthPersistAt = now;
      persistHealth();
    }
  }

  function notify(key, text, { failure = false, failureDetails = null } = {}) {
    if (failure) {
      stats.writeFailures += 1;
      stats.integrityStatus = 'degraded';
      stats.recentError = String(text).slice(0, 240);
      stats.lastErrorAt = new Date().toISOString();
      stats.lastFailure = normalizeDiagnostic({
        at: stats.lastErrorAt,
        stream: failureDetails?.stream,
        file: failureDetails?.file,
        operation: failureDetails?.operation || 'unknown',
        code: failureDetails?.code || '',
        message: failureDetails?.message ?? String(text),
        retries: failureDetails?.retries,
        attempts: failureDetails?.attempts
      });
      persistHealth();
    }
    const now = Date.now();
    const previous = warnedAt.get(key) || 0;
    if (now - previous < CAPACITY_WARNING_INTERVAL_MS) return;
    warnedAt.set(key, now);
    const line = `[obs] ${text}`;
    if (typeof onWarn === 'function') { try { onWarn(line); } catch { /* keep diagnostics out of the failed sink */ } }
    else console.warn(line);
  }

  async function names() { return dir ? fs.readdir(dir).catch(() => []) : []; }
  function matchingFiles(list, stream, day) {
    return list.flatMap((name) => {
      const shard = SHARD_RE.exec(name);
      if (shard && shard[1] === stream && shard[2] === day) return [{ name, shard: Number(shard[3]) }];
      const legacy = LEGACY_RE.exec(name);
      if (legacy && legacy[1] === stream && legacy[2] === day) return [{ name, shard: 0, legacy: true }];
      return [];
    }).sort((a, b) => a.shard - b.shard || a.name.localeCompare(b.name));
  }

  async function quarantineTail(filePath, stream, day, shard) {
    const handle = await fs.open(filePath, 'r+');
    try {
      const stat = await handle.stat();
      if (!stat.size) return true;
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, stat.size - 1);
      if (last[0] === 0x0a) return true;

      // Inspect only the active file's tail. Find the last complete line boundary.
      const chunkSize = 64 * 1024;
      let cursor = stat.size;
      let boundary = -1;
      while (cursor > 0 && boundary < 0) {
        const start = Math.max(0, cursor - chunkSize);
        const chunk = Buffer.alloc(cursor - start);
        await handle.read(chunk, 0, chunk.length, start);
        const pos = chunk.lastIndexOf(0x0a);
        if (pos >= 0) boundary = start + pos + 1;
        cursor = start;
      }
      const suffixStart = boundary < 0 ? 0 : boundary;
      const suffix = Buffer.alloc(stat.size - suffixStart);
      await handle.read(suffix, 0, suffix.length, suffixStart);
      const gapName = `tail-gap-${stream}-${day}-${String(shard).padStart(6, '0')}-${Date.now()}-${randomUUID()}.bin`;
      await fs.writeFile(path.join(dir, gapName), suffix, { flag: 'wx' });
      // Preserve a file containing no complete line. The writer will continue
      // in a fresh shard, while the entire damaged file stays available for recovery.
      if (boundary < 0) {
        stats.integrityGaps += 1;
        stats.quarantinedBytes += suffix.length;
        stats.quarantinedFiles += 1;
        stats.integrityStatus = 'degraded';
        stats.recentError = `active shard contains no complete line (${suffix.length} bytes)`;
        stats.lastErrorAt = new Date().toISOString();
        if (stream === 'usage') incompleteUsageDays.add(day);
        unusableActiveFiles.add(path.basename(filePath));
        persistHealth();
        notify(`tail:${stream}:${day}`, `active shard has no complete line; preserved and rotated stream=${stream} day=${day} bytes=${suffix.length}`);
        return false;
      }
      await handle.truncate(suffixStart);
      stats.integrityGaps += 1;
      stats.quarantinedBytes += suffix.length;
      stats.quarantinedFiles += 1;
      stats.integrityStatus = 'degraded';
      stats.recentError = `incomplete tail quarantined (${suffix.length} bytes)`;
      stats.lastErrorAt = new Date().toISOString();
      if (stream === 'usage') incompleteUsageDays.add(day);
      persistHealth();
      notify(`tail:${stream}:${day}`, `incomplete tail quarantined stream=${stream} day=${day} bytes=${suffix.length}`);
      return true;
    } finally { await handle.close(); }
  }

  async function prune(day) {
    if (!dir || lastPrunedDay === day) return;
    lastPrunedDay = day;
    const cutoff = Date.now() - Math.max(0, Number(retentionDays) || 0) * 86_400_000;
    const list = await names();
    const stale = list.filter((name) => {
      const match = SHARD_RE.exec(name) || LEGACY_RE.exec(name) || GAP_RE.exec(name);
      return match && Number.isFinite(Date.parse(`${match[2]}T00:00:00.000Z`))
        && Date.parse(`${match[2]}T00:00:00.000Z`) < cutoff;
    });
    await Promise.all(stale.map((name) => fs.unlink(path.join(dir, name)).catch(() => {})));
  }

  async function appendWithRetry(activePath, line, stream) {
    const file = path.basename(activePath);
    let retries = 0;
    while (true) {
      try {
        await appendFileImpl(activePath, line, 'utf8');
        if (retries > 0) {
          stats.lastRetry = normalizeDiagnostic({
            ...stats.lastRetry, at: new Date().toISOString(), stream, file,
            operation: 'append', retries, attempts: retries + 1, status: 'recovered'
          }, { retry: true });
          persistHealth();
        }
        return retries;
      } catch (error) {
        const code = errorCode(error);
        const message = errorMessage(error);
        if (code !== 'EBUSY' || retries >= MAX_EBUSY_RETRIES) {
          if (retries > 0) {
            stats.lastRetry = normalizeDiagnostic({
              ...stats.lastRetry, at: new Date().toISOString(), stream, file,
              operation: 'append', retries, attempts: retries + 1, status: 'failed', code, message
            }, { retry: true });
          }
          const failure = new Error(message, { cause: error });
          failure.code = code;
          failure.observabilityFailure = { stream, file, operation: 'append', code, message, retries, attempts: retries + 1 };
          throw failure;
        }
        retries += 1;
        stats.writeRetries += 1;
        stats.lastRetry = normalizeDiagnostic({
          at: new Date().toISOString(), stream, file, operation: 'append',
          retries, attempts: retries + 1, status: 'retrying', code, message
        }, { retry: true });
        persistHealth();
        await new Promise((resolve) => setTimeout(resolve, appendDelay * retries));
      }
    }
  }

  async function writeLine(stream, row) {
    let file = '';
    let operation = 'prepare';
    try {
      const day = dayOf(row.at);
      const line = `${JSON.stringify(row)}\n`;
      const bytes = Buffer.byteLength(line, 'utf8');
      await fs.mkdir(dir, { recursive: true });
      await prune(day);
      const list = await names();
      const matches = matchingFiles(list, stream, day);
      let active = matches.at(-1) || { name: `${stream}-${day}-000001.ndjson`, shard: 1 };
      if (active.legacy) active = { name: `${stream}-${day}-000001.ndjson`, shard: 1 };
      let activePath = path.join(dir, active.name);
      file = active.name;
      let tailSafe = unusableActiveFiles.has(active.name) ? false : await quarantineTail(activePath, stream, day, active.shard).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
        return true;
      });
      if (tailSafe === false) {
        const nextShard = Math.max(0, ...matches.map((x) => x.shard)) + 1;
        active = { name: `${stream}-${day}-${String(nextShard).padStart(6, '0')}.ndjson`, shard: nextShard };
        activePath = path.join(dir, active.name);
        file = active.name;
      }
      let currentBytes = await fs.stat(activePath).then((x) => x.size).catch(() => 0);
      if (currentBytes + bytes > limit) {
        const nextShard = Math.max(0, ...matches.map((x) => x.shard)) + 1;
        active = { name: `${stream}-${day}-${String(nextShard).padStart(6, '0')}.ndjson`, shard: nextShard };
        activePath = path.join(dir, active.name);
        file = active.name;
        currentBytes = await fs.stat(activePath).then((x) => x.size).catch(() => 0);
        tailSafe = await quarantineTail(activePath, stream, day, active.shard).catch((error) => { if (error?.code !== 'ENOENT') throw error; return true; });
        if (tailSafe === false) {
          const nextShard = active.shard + 1;
          active = { name: `${stream}-${day}-${String(nextShard).padStart(6, '0')}.ndjson`, shard: nextShard };
          activePath = path.join(dir, active.name);
          file = active.name;
          currentBytes = 0;
        }
      }
      if (bytes > limit || currentBytes + bytes > limit) {
        stats.capacitySkips += 1;
        stats.capacityDroppedBytes += bytes;
        stats.rowsDropped += 1;
        if (stream === 'usage') incompleteUsageDays.add(day);
        const message = `shard capacity reached stream=${stream} file=${path.basename(activePath)} droppedRows=${stats.capacitySkips} limitBytes=${limit}`;
        notify(`capacity:${stream}:${day}`, message, {
          failure: true,
          failureDetails: { stream, file: active.name, operation: 'capacity', code: 'CAPACITY', message, retries: 0, attempts: 0 }
        });
        return false;
      }
      operation = 'append';
      await appendWithRetry(activePath, line, stream);
      stats.activeFile = active.name;
      stats.files = Math.max(stats.files, list.filter((name) => SHARD_RE.test(name) || LEGACY_RE.test(name)).length + (list.includes(active.name) ? 0 : 1));
      return true;
    } catch (error) {
      if (error?.observabilityFailure) throw error;
      const code = errorCode(error);
      const message = errorMessage(error);
      const failure = new Error(message, { cause: error });
      failure.code = code;
      failure.observabilityFailure = { stream, file: file ? path.basename(file) : '', operation, code, message, retries: 0, attempts: 1 };
      throw failure;
    }
  }

  function localDayRange(day) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ''));
    if (!match) throw new TypeError('day must be YYYY-MM-DD');
    const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (!Number.isFinite(start.getTime()) || start.getFullYear() !== Number(match[1]) || start.getMonth() !== Number(match[2]) - 1 || start.getDate() !== Number(match[3])) throw new TypeError('day must be a valid local calendar date');
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    return { startAt: start.getTime(), endAt: end.getTime() };
  }
  /**
   * 一行 usage 行的三档归属（与清零过滤、分片归属**同一份**时间解析）：
   *   · `'in'`      有绝对时刻且落在 [startAt, endAt)；
   *   · `'out'`     有绝对时刻但在窗口外（正常丢弃，不算不完整）；
   *   · `'unknown'` **定位不到**（null/空/非法/NaN/Infinity/负数）—— 调用方要**计数**并置不完整，
   *                 既不许塞进今天，也不许当成"0 调用、数据完整"。
   */
  function classifyUsageRow(row, startAt, endAt) {
    const at = parseEpochMs(row?.at);
    if (at === null) return 'unknown';
    return at >= startAt && at < endAt ? 'in' : 'out';
  }
  function addUsageRow(totals, row) {
    const cls = classifyUsageRow(row, totals.startAt, totals.endAt);
    if (cls === 'unknown') { totals.unknownAtRows += 1; return; }
    if (cls === 'out') return;
    totals.rows += 1;
    const prompt = Number(row?.promptTokens); const completion = Number(row?.completionTokens);
    if (row?.promptTokens == null || row?.completionTokens == null || !Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) {
      totals.rowsMissingTokens += 1; return;
    }
    totals.promptTokens += prompt; totals.completionTokens += completion; totals.totalTokens += prompt + completion;
  }

  /**
   * ★ 2026-10-17（日聚合增量）：只按"文件 size/mtime + 已消费偏移"读**新增字节**。
   *
   * 为什么不是"缓存一份就不再看盘"：日期窗是活的（跨日、跨时区边界）、追加是常态 ⇒ 只认
   *  (size, mtimeMs) 与自记的 `offset`/`carry`；文件变小、同 size 改写、首次见到 ⇒ **从头重扫**。
   * 每次都是"旧记录 + 已读字节"推出本次读数，绝不出现"统计停在昨天不动"或"漏掉刚写的那几行"。
   * 失败路径：读不动/没扫到 size 边界 ⇒ 本轮读数标 `incomplete`（调用方置 truncated），
   * 且**不推进** `offset` 到没读过的地方（下次从旧偏移重来，宁可重读也不漏计/重复计）。
   */
  async function aggUsageFile(filePath, rec, startAt, endAt) {
    let handle;
    try { handle = await fs.open(filePath, 'r'); } catch (error) {
      if (error?.code === 'ENOENT') return { rec: null, incomplete: false };   // 读列表后被删：不算不完整
      return { rec: rec ?? null, incomplete: true };
    }
    try {
      const st = await handle.stat().catch(() => null);
      if (!st) return { rec: rec ?? null, incomplete: true };
      const size = Number(st.size) || 0;
      const mtimeMs = Number(st.mtimeMs) || 0;
      const unchanged = rec && rec.size === size && rec.mtimeMs === mtimeMs;
      let base;
      if (unchanged) base = rec;
      else if (rec && rec.offset > 0 && rec.offset < size && rec.size <= size) base = rec;   // 追加：续扫
      else base = null;                                                                      // 重扫
      if (base && base.offset === size) {
        // 零 IO 快路径。注意**未终止尾行**（carry 非空）要一直算"不完整" —— 不能因为这次没读到新字节
        // 就改口说完整（数量可能仍然少那一行）。
        return { rec: base, incomplete: !!(base.carry && base.carry.length > 0) };
      }
      let pos = base ? base.offset : 0;
      let carry = base ? base.carry : EMPTY_BUF;
      const sums = base
        ? { rows: base.rows, malformedRows: base.malformedRows, rowsMissingTokens: base.rowsMissingTokens, unknownAtRows: base.unknownAtRows ?? 0, promptTokens: base.promptTokens, completionTokens: base.completionTokens, totalTokens: base.totalTokens }
        : { rows: 0, malformedRows: 0, rowsMissingTokens: 0, unknownAtRows: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let incomplete = false;
      while (pos < size) {
        const want = Math.min(READ_CHUNK_BYTES, size - pos);
        const buf = Buffer.allocUnsafe(want);
        let got = 0;
        while (got < want) {
          const r = await handle.read(buf, got, want - got, pos + got).catch(() => null);
          if (!r?.bytesRead) break;
          got += r.bytesRead;
        }
        if (got <= 0) { incomplete = true; break; }
        const segs = splitOnNewline(Buffer.concat([carry, buf.subarray(0, got)]));
        carry = segs.pop() ?? EMPTY_BUF;
        pos += got;
        if (carry.length > READ_MAX_LINE_BYTES) { sums.malformedRows += 1; carry = EMPTY_BUF; incomplete = true; }
        for (const seg of segs) {
          const line = seg.length && seg[seg.length - 1] === CR_BYTE ? seg.subarray(0, seg.length - 1) : seg;
          if (!line.length) continue;
          let row;
          try { row = JSON.parse(line.toString('utf8')); } catch { sums.malformedRows += 1; continue; }
          if (!row || typeof row !== 'object') { sums.malformedRows += 1; continue; }
          // 边界分片按行过滤（整段在窗内的分片这步只有 'in'）；**定位不到的**按 unknown 计数，
          // 不当今天、也不当"0 调用完整"。判据与清零过滤/分片归属同一份（parseEpochMs）。
          const cls = classifyUsageRow(row, startAt, endAt);
          if (cls === 'unknown') { sums.unknownAtRows += 1; continue; }
          if (cls !== 'in') continue;
          addUsageRowToSums(sums, row);
        }
      }
      if (pos < size) incomplete = true;
      if (carry.length) incomplete = true;                     // 尾行没有 LF ⇒ 可能还没写完，先不计（如实标不完整）
      return { rec: { size, mtimeMs, offset: pos, carry, ...sums }, incomplete };
    } finally { await handle.close().catch(() => {}); }
  }

  async function dayTokenTotal({ at = Date.now() } = {}) {
    // ★ 2026-10-17（时间统一）：`at` 参数也走同一份解析（数字/纯数字串/Date/带时区 ISO）——
    //   旧版 ISO 参数会 NaN 抛 TypeError，与"行的时间"两套口径。非法仍**抛**（类型错就是类型错）。
    const timestamp = parseEpochMs(at);
    if (timestamp === null) throw new TypeError('at must be a valid timestamp');
    const date = localDayOf(timestamp); const { startAt, endAt } = localDayRange(date);
    // ★ 2026-10-17（日聚合增量）：整段"扫描 + 更新缓存"走一条**串行链** —— 两路并发不许各自从同一偏移
    //   读、把同一段重复计入，也不许后到的那次把 offset 写回更小的值。
    return runAggLocked(async () => {
      await queue.catch(() => {});
      const totals = { date, startAt, endAt, promptTokens: 0, completionTokens: 0, totalTokens: 0, rows: 0, rowsMissingTokens: 0, malformedRows: 0, unknownAtRows: 0, truncated: false };
      const resultOf = () => ({
        date: totals.date, totalTokens: totals.totalTokens, promptTokens: totals.promptTokens,
        completionTokens: totals.completionTokens, rows: totals.rows,
        // 追加键（相容）：定位不到时间的行数 —— 这些行**没有**计入任何一天，调用方要能说出来。
        unknownAtRows: totals.unknownAtRows,
        truncated: totals.truncated
      });
      if (!dir) {
        const ring = memory.get('usage') ?? [];
        if (ring.length >= MEMORY_RING) totals.truncated = true;
        for (const row of ring) addUsageRow(totals, row);
        if (totals.unknownAtRows > 0) totals.truncated = true;
        return resultOf();
      }
      const list = await names();
      const days = [...new Set([dayOf(startAt), dayOf(endAt - 1)])];
      if (days.some((day) => incompleteUsageDays.has(day))) totals.truncated = true;
      const files = days.flatMap((day) => matchingFiles(list, 'usage', day));
      const cacheKey = `${dir}|${date}`;
      let entry = dayAggCache.get(cacheKey);
      if (!entry) {
        entry = { files: new Map() };
        dayAggCache.set(cacheKey, entry);
        while (dayAggCache.size > DAY_AGG_CACHE_MAX) {          // 只留最近几个"日"的记录 ⇒ 内存有界
          const oldest = dayAggCache.keys().next().value;
          if (oldest === undefined) break;
          dayAggCache.delete(oldest);
        }
      }
      const live = new Set(files.map((f) => f.name));
      for (const name of [...entry.files.keys()]) if (!live.has(name)) entry.files.delete(name);
      for (const item of files) {
        const full = path.join(dir, item.name);
        const { rec, incomplete } = await aggUsageFile(full, entry.files.get(item.name) ?? null, startAt, endAt);
        if (rec) {
          entry.files.set(item.name, rec);
          totals.rows += rec.rows;
          totals.rowsMissingTokens += rec.rowsMissingTokens;
          totals.malformedRows += rec.malformedRows;
          totals.unknownAtRows += rec.unknownAtRows ?? 0;
          totals.promptTokens += rec.promptTokens;
          totals.completionTokens += rec.completionTokens;
          totals.totalTokens += rec.totalTokens;
        }
        if (incomplete) totals.truncated = true;
      }
      if (totals.rowsMissingTokens || totals.malformedRows || totals.unknownAtRows) totals.truncated = true;
      return resultOf();
    });
  }
  /** ★ 2026-10-17（日聚合增量）：按"日"存每文件已消费偏移与累计；上限 4 天，内存有界。 */
  const dayAggCache = new Map();
  const DAY_AGG_CACHE_MAX = 4;
  let aggLock = Promise.resolve();
  /** 串行化"扫描 + 更新缓存"（并发调用不许各自从同一偏移读同一段 ⇒ 重复计入）。 */
  function runAggLocked(task) {
    const next = aggLock.then(task, task);
    aggLock = next.catch(() => {});
    return next;
  }

  /** 与 `addUsageRow` 同口径的计数（缺/坏 token 行只记 rowsMissingTokens，不进 token 总量）。 */
  function addUsageRowToSums(sums, row) {
    sums.rows += 1;
    const prompt = Number(row?.promptTokens); const completion = Number(row?.completionTokens);
    if (row?.promptTokens == null || row?.completionTokens == null || !Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) {
      sums.rowsMissingTokens += 1; return;
    }
    sums.promptTokens += prompt; sums.completionTokens += completion; sums.totalTokens += prompt + completion;
  }

  function remember(name, row) { let ring = memory.get(name); if (!ring) { ring = []; memory.set(name, ring); } ring.push(row); if (ring.length > MEMORY_RING) ring.splice(0, ring.length - MEMORY_RING); }

  /**
   * ★ 2026-10-17（尾读收口）：把一个文件的**尾部**行按"新→旧"追进 `st.rows`。
   *
   * 四条静态纪律（上一版逐条踩过，这里写清怎么修的）：
   *  1. **文件第一行不能漏**：扫到文件起点（绝对偏移 0）时，手里的 `head` 就是**完整的首行**
   *     ⇒ 必须解析（旧版扫到 0 就把 pending 扔了 ⇒ 每个分片的第一行都丢、只有一行的分片读成空）。
   *  2. **按字节切行、只解码完整行**：块边界可能劈开多字节字符（中文/emoji）——旧版对每块直接
   *     `toString('utf8')` 再把字符串拼回去，已经损坏。现在行边界只按字节 0x0A 找，`head` 保留
   *     **未解码的字节**，凑成完整行后才 `toString('utf8')` ⇒ 不会产生 U+FFFD 污染。
   *  3. **按绝对字节区间推进**：区间是 [start, start+got)；短读时 `end = start`（不是 `end -= got` 的
   *     等价物在有短读时会错位），下一轮从 `start` 继续；读不动/被替换/被截断 ⇒ `ioErrors` 如实降级。
   *  4. **异常长行只跳它自己**：`head` 超 `READ_MAX_LINE_BYTES` ⇒ 记 `oversizedLines`、丢这段 head
   *     继续往前扫（不因此卡死、也不吞掉更早分片里可读的行）；总预算 8MB / 单块 256KB 仍是硬边界。
   */
  async function scanTailRows(filePath, st) {
    let handle;
    try { handle = await fs.open(filePath, 'r'); } catch (error) {
      // 读列表之后被删（清理/换分片）不算"读不动"，不许因此把结果标成不完整。
      if (error?.code !== 'ENOENT') st.ioErrors += 1;
      return;
    }
    try {
      const stat = await handle.stat().catch(() => null);
      if (!stat) { st.ioErrors += 1; return; }
      let end = Number(stat.size) || 0;
      let head = EMPTY_BUF;                       // 窗口最前面那半行的**字节**（未解码、未解析）
      while (end > 0 && st.rows.length < st.count && st.budget > 0) {
        const want = Math.min(READ_CHUNK_BYTES, end, st.budget);
        const start = end - want;                 // 绝对区间 [start, start+got)
        const buf = Buffer.allocUnsafe(want);
        let got = 0;
        while (got < want) {                      // 短读逐段补齐
          const r = await handle.read(buf, got, want - got, start + got).catch(() => null);
          if (!r?.bytesRead) break;
          got += r.bytesRead;
        }
        if (got <= 0) { st.ioErrors += 1; break; }   // 读不动 / 文件被替换截断：如实降级，停这个文件
        st.bytesRead += got;
        st.budget -= got;
        end = start;                              // 已消费 [start, start+got)（短读也不越界）
        const segs = splitOnNewline(Buffer.concat([buf.subarray(0, got), head]));
        head = segs[0];                           // 最早那段可能还缺前半 ⇒ 留给下一块
        for (let i = segs.length - 1; i >= 1 && st.rows.length < st.count; i -= 1) {
          parseLedgerLine(segs[i], st);
        }
        if (head.length > READ_MAX_LINE_BYTES) { st.oversizedLines += 1; head = EMPTY_BUF; }
      }
      // ① 核心修复：end === 0 ⇒ head 是**完整首行**（不是半行），必须解析。
      //    用已读字节判定，不再受预算/行数之外的额外条件影响；行数已够时它比已取的行更旧，跳过。
      if (end === 0 && head.length && st.rows.length < st.count) parseLedgerLine(head, st);
    } finally { await handle.close().catch(() => {}); }
  }

  async function inspectStartup() {
    if (!dir) return;
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    const healthPath = path.join(dir, 'obs-health.json');
    try {
      const saved = JSON.parse(await fs.readFile(healthPath, 'utf8'));
      for (const key of ['writeFailures', 'writeRetries', 'capacitySkips', 'capacityDroppedBytes', 'rowsDropped', 'integrityGaps', 'quarantinedBytes', 'quarantinedFiles']) {
        if (Number.isFinite(Number(saved[key]))) stats[key] = Number(saved[key]);
      }
      stats.integrityStatus = saved.integrityStatus === 'degraded' ? 'degraded' : stats.integrityStatus;
      stats.recentError = typeof saved.recentError === 'string' ? saved.recentError.slice(0, 240) : '';
      stats.lastErrorAt = saved.lastErrorAt || null;
      stats.lastSuccessAt = typeof saved.lastSuccessAt === 'string' ? saved.lastSuccessAt : null;
      stats.lastFailure = normalizeDiagnostic(saved.lastFailure);
      stats.lastRetry = normalizeDiagnostic(saved.lastRetry, { retry: true });
      if (Array.isArray(saved.incompleteUsageDays)) for (const day of saved.incompleteUsageDays) if (/^\d{4}-\d{2}-\d{2}$/.test(day)) incompleteUsageDays.add(day);
    } catch { /* no prior health snapshot */ }
    const list = await names();
    const gaps = list.map((name) => GAP_RE.exec(name)).filter(Boolean);
    if (gaps.length) {
      stats.integrityStatus = 'degraded';
      stats.integrityGaps = Math.max(stats.integrityGaps, gaps.length);
      stats.quarantinedFiles = Math.max(stats.quarantinedFiles, gaps.length);
      for (const gap of gaps) if (gap[1] === 'usage') incompleteUsageDays.add(gap[2]);
    }
    const activeByStream = new Map();
    for (const name of list) {
      const shard = SHARD_RE.exec(name); const legacy = LEGACY_RE.exec(name);
      const match = shard || legacy;
      if (!match) continue;
      const stream = match[1]; const day = match[2]; const seq = shard ? Number(shard[3]) : 0;
      const previous = activeByStream.get(stream);
      if (!previous || `${day}-${String(seq).padStart(6, '0')}` > previous.order) activeByStream.set(stream, { name, stream, day, seq, order: `${day}-${String(seq).padStart(6, '0')}` });
    }
    stats.files = list.filter((name) => SHARD_RE.test(name) || LEGACY_RE.test(name)).length;
    const activeFiles = [...activeByStream.values()].sort((a, b) => a.order.localeCompare(b.order));
    if (activeFiles.length) stats.activeFile = activeFiles.at(-1).name;
    for (const active of activeFiles) {
      try { await quarantineTail(path.join(dir, active.name), active.stream, active.day, active.seq); }
      catch (error) {
        if (error?.code !== 'ENOENT') {
          const code = errorCode(error); const message = errorMessage(error);
          notify(`startup:${active.stream}`, `active tail check failed stream=${active.stream} file=${active.name} code=${code}`, {
            failure: true,
            failureDetails: { stream: active.stream, file: active.name, operation: 'tail-check', code, message, retries: 0, attempts: 1 }
          });
        }
      }
    }
    await healthQueue;
  }
  if (dir) queue = queue.then(inspectStartup).catch(() => {});

  const sinkApi = {
    get dir() { return dir; },
    append(name, row) {
      const stream = safeStream(name);
      if (!stream || !row || typeof row !== 'object') { stats.rowsDropped += 1; return null; }
      remember(stream, row);
      if (!dir) { stats.appends += 1; return row; }
      queue = queue.then(async () => {
        try {
          const written = await writeLine(stream, row);
          stats.appends += 1;
          if (written) recordSuccessfulAppend();
        }
        catch (error) {
          stats.rowsDropped += 1;
          if (stream === 'usage') incompleteUsageDays.add(dayOf(row.at));
          const details = error?.observabilityFailure || {
            stream, file: '', operation: 'write', code: errorCode(error), message: errorMessage(error), retries: 0, attempts: 1
          };
          notify(`write:${stream}`, `append failed stream=${stream} file=${details.file || '(unknown)'} code=${details.code}`, { failure: true, failureDetails: details });
        }
      }).catch(() => {});
      return row;
    },
    async flush() { await queue.catch(() => {}); await healthQueue.catch(() => {}); },
    peek(name, n = 50) { const ring = memory.get(safeStream(name)); if (!ring) return []; const count = Math.max(1, Math.min(MEMORY_RING, Number(n) || 50)); return ring.slice(-count); },
    /**
     * ★ 2026-10-17（尾读收口）：`readWithMeta` 一次扫描返回 `{rows, meta}`；`read` 是它的薄壳（只回 rows，
     * **共用同一次扫描**，不扫两遍）。
     *
     * 语义（消费方要按这几个字段区分"数据边界"和"我这次读的边界"，别把两者混成一句"全流完整"）：
     *   · `rows` —— 新→旧；`limit` = 行数硬上限（2000；内存环回退时 = 200），`requested` = 调用方要的 n；
     *   · `hasMore` —— **达到行数上限**（流里很可能还有更旧的行）；这一条**不算** `truncated`；
     *   · `truncated` —— 本次扫描**真的不完整**：字节预算耗尽（`byteLimitReached`）、IO 失败（`ioErrors`）、
     *     异常长行被跳过（`oversizedLines`）；`malformedRows` 也一并回报（坏行不计入统计）；
     *   · `reason` —— 上述原因的短标记（`byte-budget` / `io-errors` / `oversized-lines` / `rows-limit` 用 `+` 连接）；
     *   · `bytesRead` —— 本次真的从盘上读了多少字节（配合 `stats.readBytes` 对账）。
     * meta 是**每次调用自己的返回值**（`newScanState`），没有全局 lastRead ⇒ 并发两路不会互相顶掉。
     */
    async readWithMeta(name, n = 50) {
      const stream = safeStream(name);
      const requested = Number(n);
      const count = Math.max(1, Math.min(2000, Math.round(Number(n) || 50)));
      if (!stream) {
        return { rows: [], meta: {
          requested, limit: 2000, returned: 0, bytesRead: 0, hasMore: false, byteLimitReached: false,
          oversizedLines: 0, malformedRows: 0, ioErrors: 0, truncated: true, reason: 'bad-stream-name', source: 'none'
        } };
      }
      if (!dir) {
        // 无落盘目录（纯内存模式）：只可能从内存环回退 —— 也如实报边界（环满 = 这份视图不是全流）。
        const ring = memory.get(stream) ?? [];
        const rows = ring.slice(-count);
        const full = ring.length >= MEMORY_RING;
        return { rows, meta: {
          requested, limit: MEMORY_RING, returned: rows.length, bytesRead: 0,
          hasMore: full, byteLimitReached: false, oversizedLines: 0, malformedRows: 0, ioErrors: 0,
          truncated: full, reason: full ? 'memory-ring' : '', source: 'memory-ring'
        } };
      }
      await queue.catch(() => {});
      const list = await names();
      const files = list.filter((f) => { const s = SHARD_RE.exec(f); const l = LEGACY_RE.exec(f); return (s?.[1] || l?.[1]) === stream; })
        .sort((a, b) => {
          const sa = SHARD_RE.exec(a); const la = LEGACY_RE.exec(a);
          const sb = SHARD_RE.exec(b); const lb = LEGACY_RE.exec(b);
          const dateA = sa?.[2] || la?.[2] || ''; const dateB = sb?.[2] || lb?.[2] || '';
          const seqA = Number(sa?.[3] || 0); const seqB = Number(sb?.[3] || 0);
          return dateB.localeCompare(dateA) || seqB - seqA;
        });
      const st = newScanState(count);
      const before = st.budget;
      stats.readCalls += 1;
      for (const file of files) {
        if (st.rows.length >= st.count || st.budget <= 0) break;
        await scanTailRows(path.join(dir, file), st);
      }
      stats.readBytes += before - Math.max(0, st.budget);
      const hasMore = st.rows.length >= st.count;
      const byteLimitReached = st.budget <= 0;
      const truncated = byteLimitReached || st.ioErrors > 0 || st.oversizedLines > 0;
      const reason = [
        byteLimitReached ? 'byte-budget' : '', st.ioErrors > 0 ? 'io-errors' : '',
        st.oversizedLines > 0 ? 'oversized-lines' : '', hasMore ? 'rows-limit' : ''
      ].filter(Boolean).join('+');
      return { rows: st.rows, meta: {
        requested, limit: 2000, returned: st.rows.length, bytesRead: st.bytesRead,
        hasMore, byteLimitReached, oversizedLines: st.oversizedLines, malformedRows: st.malformedRows,
        ioErrors: st.ioErrors, truncated, reason, source: 'ndjson'
      } };
    },
    // 薄壳：与 readWithMeta **共用同一次扫描**（经 `sinkApi` 引用，不用 `this` ⇒ 解构出去也不会坏）。
    async read(name, n = 50) { return (await sinkApi.readWithMeta(name, n)).rows; },
    dayTokenTotal,
    stats() {
      return { dir, ...stats, maxFileBytes: limit, streams: [...memory.keys()].sort(), memoryRows: memory.size, incompleteUsageDays: [...incompleteUsageDays].sort() };
    },
    newRowId() { return randomUUID(); }
  };
  return sinkApi;
}
