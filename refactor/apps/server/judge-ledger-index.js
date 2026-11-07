/**
 * refactor/apps/server/judge-ledger-index.js — JSONL 账本的增量尾部索引（零 import，IO 注入）。
 *
 * 目的（第四批 P2 S13）：`/api/judge-usage` 原先每次请求把整个 `budget/requests.jsonl`
 * 全量 `readFileSync` 再逐行重解。本模块按 (ino, size, mtimeMs) 版本做增量读：
 * 已消费字节不重读，只解析新增尾部；文件未变化的轮询只 `statSync` 一次。
 *
 * 语义对齐 console-api.js 旧 `readJudgeBudgetRows`（逐条核对过）：
 *   · 元素 = 按 `\n` 切分；换行前的 `\r` 剥掉（等价旧 `/\r?\n/`）。
 *   · 元素序号 = 其前的 `\n` 个数 + 1（空行也占号；末尾未换行元素同样占号），
 *     作 sequence 缺失/非安全整数时的回退值。
 *   · requestId trim 后为空 ⇒ malformed；JSON 解析失败 ⇒ malformed。
 *   · 同一 requestId 取 sequence 大者（相等取后写）；行按首见顺序（Map 插入序）。
 *   · 合法 JSON 但缺 requestId 的尾部会按"出错行"提交；坏 JSON 尾部只计本次响应，不推进。
 *   · 已换行的出错行留在索引里每次计入 malformedRows（旧实现每次重扫同样是每次计入）。
 *   · 跨日 requestId（病态账本）按最新行改挂到其日期桶；旧实现是全局 latest 后再过滤，
 *     输出行集合一致，仅桶内顺序在"换日"时与旧全局首见序可能不同（正常账本不变）。
 *
 * 已知偏差（仅病态写入）：一个**完整 JSON 但缺末尾换行**的尾部会立即提交并推进；
 * 若之后有字节续写在同一行上，旧实现会把整行重新解析（可能报 malformed），本实现不回头。
 * 正常持久化一次写 `JSON.stringify(row)+'\n'`，不会触发。
 *
 * IO 注入（任一抛错 ⇒ 本次 `{available:false, error}` 且丢弃缓存，下次重建；绝不回旧值）：
 *   · statFile(file) → { ino, size, mtimeMs }（Node fs.Stats 形状）
 *   · readRange(file, start, end) → Uint8Array（[start, end)；短读必须抛错）
 */

const LF = 0x0A;
const CR = 0x0D;

export function createJudgeLedgerIndex({ statFile, readRange, maxFiles = 16 } = {}) {
  const files = new Map();
  const decoder = new TextDecoder();
  const hasIo = typeof statFile === 'function' && typeof readRange === 'function';

  function touch(file, state) {
    files.delete(file);
    files.set(file, state);
    while (files.size > maxFiles) files.delete(files.keys().next().value);
  }

  function parseElement(bytes, terminated) {
    const text = decoder.decode(terminated && bytes.length > 0 && bytes[bytes.length - 1] === CR
      ? bytes.subarray(0, bytes.length - 1) : bytes);
    if (!text.trim()) return null;
    try { return { ok: true, row: JSON.parse(text) }; }
    catch { return { ok: false }; }
  }

  function recordRow(state, row, ordinal) {
    const requestId = String(row?.requestId ?? '').trim();
    if (!requestId) { state.malformed += 1; return; }
    const sequence = Number.isSafeInteger(Number(row?.sequence)) ? Number(row.sequence) : ordinal;
    const day = typeof row?.date === 'string' ? row.date : null;
    const previousDay = state.requestDay.get(requestId);
    const previous = previousDay === undefined ? undefined : state.byDay.get(previousDay)?.get(requestId);
    if (previous && sequence < previous.sequence) return;
    if (previous && previousDay !== day) {
      const oldMap = state.byDay.get(previousDay);
      if (oldMap) {
        oldMap.delete(requestId);
        if (oldMap.size === 0) state.byDay.delete(previousDay);
      }
    }
    let map = state.byDay.get(day);
    if (!map) {
      map = new Map();
      state.byDay.set(day, map);
    }
    map.set(requestId, { row, sequence });
    state.requestDay.set(requestId, day);
  }

  /** 处理新增字节 [state.size, state.size+chunk.length)；返回只属于本次响应的临时 malformed 数。 */
  function consumeChunk(state, chunk) {
    let consumed = 0;
    let transient = 0;
    let lineStart = 0;
    for (let i = 0; i < chunk.length; i += 1) {
      if (chunk[i] !== LF) continue;
      const ordinal = state.lineCount + 1;
      state.lineCount += 1;
      const element = parseElement(chunk.subarray(lineStart, i), true);
      if (element === null) { /* 空行：占号不记行 */ }
      else if (element.ok) recordRow(state, element.row, ordinal);
      else state.malformed += 1;
      lineStart = i + 1;
      consumed = i + 1;
    }
    if (lineStart < chunk.length) {
      const element = parseElement(chunk.subarray(lineStart), false);
      if (element === null) consumed = chunk.length;                    // 空白尾：消费（与旧整行 parse 等值）
      else if (element.ok) {
        recordRow(state, element.row, state.lineCount + 1);
        consumed = chunk.length;
      } else transient += 1;                                            // 坏尾：不推进，下轮重试
    }
    state.size += consumed;
    return transient;
  }

  function build(file, stat) {
    const bytes = readRange(file, 0, stat.size);
    const state = {
      ino: stat.ino ?? null, mtimeMs: stat.mtimeMs ?? null,
      size: 0, lineCount: 0, malformed: 0, transient: 0,
      byDay: new Map(), requestDay: new Map()
    };
    state.transient = consumeChunk(state, bytes);
    touch(file, state);
    return state;
  }

  function read(file, day) {
    if (!hasIo) return { available: false, error: 'missing-index-io' };
    try {
      const stat = statFile(file);
      let state = files.get(file);
      if (state) {
        const changed = (stat.ino ?? null) !== state.ino
          || stat.size < state.size
          || (stat.size === state.size && (stat.mtimeMs ?? null) !== state.mtimeMs);
        if (changed) { files.delete(file); state = undefined; }
      }
      if (!state) state = build(file, stat);
      else if (stat.size > state.size) {
        state.transient = consumeChunk(state, readRange(file, state.size, stat.size));
        state.mtimeMs = stat.mtimeMs ?? null;
        touch(file, state);
      } else touch(file, state);
      const bucket = typeof day === 'string' ? state.byDay.get(day) : undefined;
      const rows = bucket ? [...bucket.values()].map((entry) => entry.row) : [];
      return { available: true, rows, malformedRows: state.malformed + state.transient };
    } catch (error) {
      files.delete(file);
      return { available: false, error: String(error?.code ?? error?.name ?? 'read-failed') };
    }
  }

  return { read };
}
