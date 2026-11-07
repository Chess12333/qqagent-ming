/**
 * M2 observability · 用量统计的**持久清零边界**（2026-10-16 · 用户明确要修「调试清零」）
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────
 * 老树 `src/app.js:1944-1966` 的调试清零是**物理清零**：清台账 + 覆写 usage-today.json +
 * **删 history-cold 目录** + clearDailyUsage。新树没有那份台账，用量统计的唯一数据源是
 * M2 的 usage ndjson（`sink.read('usage')` / `dayTokenTotal()`），物理删账会连"付费事实"
 * 一起删掉，也与"原始观测账保留"的现行裁定冲突。
 * ⇒ 这里提供**边界（epoch）**语义：清零点只往后挪一次统计口径，`at > 边界` 的行才算数；
 *    原始账本一个字节不动（排障/对账仍可查），预算与日硬额度完全不经本模块。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────────────
 *   1. **持久**：边界写进 `<obsDir>/usage-reset.json`，重启后读同一份 ⇒ 统计不会"复活"。
 *   2. **不假成功**：没有落盘目录 / 写失败 / 写后校验不符 ⇒ `ok:false`，调用方必须如实报失败。
 *   3. **读不到要如实说**：`state` 只有 `absent`（从没清零过）才是"没有边界"；
 *      `invalid` / `unreadable` / `no-dir` 都要被上层显示出来，绝不当成"没有边界"静默放行
 *      （否则用户看到的就是"清零后又恢复旧值"）。
 *
 * 边界取 `at`（毫秒）且过滤用**严格大于**：清零那一毫秒里写入的行归"清零前"。
 * 正在进行的请求在清零后完成时，其 usage 行的 `at` 晚于边界 ⇒ 计入新统计（付费发生在边界之后）。
 *
 * ── 并发与单调（2026-10-16 收口；不声称文件锁）─────────────────────────────
 *   1. **进程内串行**：同一**规范化 obsDir**（`path.resolve`；win32 再折叠大小写）共用一条 promise 链，
 *      写边界（读旧值 → 写临时件 → rename → 写后校验）整段互斥 ⇒ 同一进程的并发/重复清零严格有序。
 *   2. **单调不回退**：写入前先读现有边界，**已有更晚（或同刻）边界时不写低**（返回既有边界 +
 *      `monotonic:'kept-existing'`）⇒ 清零前的统计不会被"较晚才落盘的较早边界"复活。
 *   3. **跨进程局限（明说）**：两个进程同时对同一 obsDir 清零时，"读旧值-写新值"之间仍有 TOCTOU
 *      窗口，此时可能互相覆盖 ⇒ 靠 write→read-back 校验把不一致如实报成 `verify-failed`
 *      （带 `maybeApplied`），**未实现文件锁/跨进程互斥**，也不假装有。
 *   4. **临时文件名唯一**：pid + 毫秒 + 进程内自增 + 随机后缀 ⇒ 同进程同毫秒两次写不会撞同一临时路径。
 *
 * 本文件只依赖 `node:` 与同目录的 `time.js`（`parseEpochMs`，纯函数、无外部依赖）；
 * obsDir 由调用方（`core/observability/index.js`）注入，不 import 本模块外的其它东西。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseEpochMs } from './time.js';

export const USAGE_RESET_VERSION = 1;
export const USAGE_RESET_FILE = 'usage-reset.json';

/** JS Date 能表示的最大毫秒（`toISOString()` 的上限）：超出后 `new Date(...)` 抛 RangeError。 */
const MAX_DATE_MS = 8.64e15;

/**
 * 只把**能定位到绝对时刻**的值认作时间戳（`false` / `[]` / `{}` / 空白串一律不算 ——
 * 与 `7d242c2` 的 `numberOrFallback` 同纪律）。`Number(true)=1`、`Number([])=0` 这类折叠不许当边界。
 *
 * ★ 2026-10-17（时间统一）：改用与行过滤/日统计**同一份**解析（`core/observability/time.js:parseEpochMs`）——
 *   有限正数毫秒 / 纯数字串 / `Date` / 带时区 ISO 都能定位到同一绝对时刻；非法一律 NaN（调用方按 invalid 报）。
 *   以前只认 number/纯数字串 ⇒ 传 `Date` 或 ISO 的边界会被判 `invalid-at`，与"行的时间"两套口径。
 */
function boundaryAtValue(raw) {
  const ms = parseEpochMs(raw);
  return ms === null ? NaN : ms;
}

/** 生成 ISO；越界/非法返回 null（绝不抛）——读、写、过滤三处共用，`toISOString()` 不再是抛点。 */
function isoOrNull(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0 || value > MAX_DATE_MS) return null;
  try { return new Date(value).toISOString(); } catch { return null; }
}

/** 规范化目录键：同一路径不因相对写法/大小写拿到两把锁（真路径仍用调用方给的 dir）。 */
function normalizeDirKey(dir) {
  let key = path.resolve(String(dir));
  if (process.platform === 'win32') key = key.toLowerCase();
  return key;
}

const dirLocks = new Map();   // 规范化 obsDir → 该目录串行链尾（进程内互斥；跨进程见文件头）

function withDirLock(key, fn) {
  const prev = dirLocks.get(key) || Promise.resolve();
  const run = prev.then(() => fn(), () => fn());   // 前一把失败不阻塞后一把
  const tail = run.then(() => {}, () => {});       // 链本身永不带拒绝，避免污染后续
  dirLocks.set(key, tail);
  void tail.then(() => { if (dirLocks.get(key) === tail) dirLocks.delete(key); });
  return run;
}

let tmpSeq = 0;
function tempNameFor(file) {
  tmpSeq = (tmpSeq + 1) >>> 0;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${file}.${process.pid}-${Date.now()}-${tmpSeq}-${rand}.tmp`;
}

/** 边界文件路径；没有 obsDir 时返回 ''（纯内存模式）。 */
export function usageResetFilePath(obsDir) {
  const dir = String(obsDir ?? '').trim();
  return dir ? path.join(dir, USAGE_RESET_FILE) : '';
}

function stateBase(state, { file = '', reason = '', at = null, atIso = null, note = '' } = {}) {
  return { version: USAGE_RESET_VERSION, state, file, reason, at, atIso, note };
}

/**
 * 读清零边界。**任何情况都不抛**（供 HTTP 读口每次请求调用）。
 *
 * @returns {Promise<{version:number, state:'ok'|'absent'|'invalid'|'unreadable'|'no-dir',
 *   at:number|null, atIso:string|null, file:string, reason:string, note:string}>}
 *   · `ok`        边界有效（`at` 为正数毫秒时间戳，且落在 JS Date 可表示范围内）
 *   · `absent`    从没清零过（不是错误）
 *   · `invalid`   文件在、但内容不是合法边界（类型不对 / 越界 / 版本认不出；不许静默当没有）
 *   · `unreadable` 文件在、读不动（权限/IO）
 *   · `no-dir`    observability 未配置落盘目录（纯内存模式）
 */
export async function readUsageResetBoundary({ obsDir = null } = {}) {
  const file = usageResetFilePath(obsDir);
  if (!file) return stateBase('no-dir', { reason: 'observability 未配置落盘目录（obsDir）' });
  let text = '';
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return stateBase('absent', { file });
    return stateBase('unreadable', { file, reason: String(error?.code || error?.name || 'read-failed') });
  }
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { return stateBase('invalid', { file, reason: 'unparsable' }); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return stateBase('invalid', { file, reason: 'not-an-object' });
  }
  // 版本漂移：语义认不出的边界不许当边界用（宁可 invalid 让上层显示，也不猜着放行/拦行）。
  if (parsed.version !== undefined && Number(parsed.version) !== USAGE_RESET_VERSION) {
    return stateBase('invalid', { file, reason: `version-mismatch(${String(parsed.version).slice(0, 20)})` });
  }
  const at = boundaryAtValue(parsed.at);
  if (!Number.isFinite(at) || at <= 0) return stateBase('invalid', { file, reason: 'at-invalid' });
  const atFloor = Math.floor(at);
  // ★ 2026-10-16 收口：越界（超出 Date 范围）此前会在 toISOString() 抛穿"绝不抛"的承诺 ⇒ 按 invalid 如实报。
  const atIso = isoOrNull(atFloor);
  if (!atIso) return stateBase('invalid', { file, reason: 'at-out-of-range' });
  return stateBase('ok', {
    file,
    at: atFloor,
    atIso,
    note: String(parsed?.note ?? '').slice(0, 200)
  });
}

/**
 * 写清零边界：临时文件 + rename（同目录原子），**写完读回校验**。
 * 失败一律 `ok:false`（没有落盘目录 / 写失败 / 校验不符），绝不返回成功让上层报"已清零"。
 *
 * ★ 2026-10-16 收口（并发/单调，详见文件头）：
 *   · 同一**规范化 obsDir** 内整段串行（`withDirLock`）⇒ 进程内并发/重复清零严格有序；
 *   · 写完读旧值，**已有更晚（或同刻）边界就不写低** ⇒ 返回 `{ok:true, monotonic:'kept-existing'}`；
 *   · 临时名 pid+毫秒+自增+随机 ⇒ 同进程同毫秒不撞路径；
 *   · rename 之后校验失败 ⇒ `ok:false` + `maybeApplied:true`（如实说"可能已生效"，不掩盖也不假成功）；
 *   · 跨进程无文件锁：两进程同时清零仍有 TOCTOU 窗口，此时靠写后校验报 `verify-failed`。
 *
 * @param {{obsDir?: string|null, at?: number, note?: string, reason?: string}} p
 * @returns {Promise<{ok:boolean, at?:number, atIso?:string, file?:string, verified?:boolean,
 *   monotonic?:string, previousAt?:number|null, maybeApplied?:boolean, state?:string, error?:string}>}
 */
export async function writeUsageResetBoundary({ obsDir = null, at = Date.now(), note = '', reason = 'debug-reset' } = {}) {
  const dir = String(obsDir ?? '').trim();
  if (!dir) {
    return {
      ok: false, state: 'no-dir',
      error: 'observability 没有落盘目录（obsDir）—— 清零边界无法持久化；重启后会恢复旧值的那种"假清零"不做'
    };
  }
  const value = boundaryAtValue(at);
  const atFloor = Number.isFinite(value) && value > 0 ? Math.floor(value) : NaN;
  // ★ 越界先挡：写函数此前在 try 外生成 ISO，越界会直接抛穿（不是返回 ok:false）。
  const atIso = Number.isFinite(atFloor) ? isoOrNull(atFloor) : null;
  if (!Number.isFinite(atFloor) || atFloor <= 0 || !atIso) {
    return { ok: false, state: 'invalid-at', error: 'at 必须是 JS Date 范围内的正数毫秒时间戳' };
  }
  const file = usageResetFilePath(dir);

  return withDirLock(normalizeDirKey(dir), async () => {
    // 单调：有更晚（或同刻）边界就不写低 —— 并发/重复清零不能把边界退回（否则清零前的统计会"复活"）。
    const current = await readUsageResetBoundary({ obsDir: dir });
    if (current.state === 'ok' && Number(current.at) >= atFloor) {
      return {
        ok: true, at: current.at, atIso: current.atIso, file, verified: true,
        monotonic: 'kept-existing', previousAt: current.at
      };
    }

    const payload = {
      version: USAGE_RESET_VERSION,
      at: atFloor,
      atIso,
      // 写进去的"前一条边界"：排障时可看出这条是覆盖在谁之上的（含手动改档后的情况）。
      prevAt: current.state === 'ok' ? current.at : null,
      reason: String(reason || '').slice(0, 40),
      note: String(note || '').slice(0, 200),
      writtenAt: Date.now()
    };
    const tmp = tempNameFor(file);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
      await fs.rename(tmp, file);
    } catch (error) {
      await fs.unlink(tmp).catch(() => { /* 临时件清理失败不影响结论 */ });
      return { ok: false, state: 'write-failed', file, error: `清零边界写盘失败：${String(error?.code || error?.message || error)}` };
    }
    const readBack = await readUsageResetBoundary({ obsDir: dir });
    // 并发清零时可能被别的一枪写了更晚的边界：更晚的边界同样（甚至更彻底地）满足"从清零点重新累计"。
    if (readBack.state !== 'ok' || Number(readBack.at) < atFloor) {
      return {
        ok: false, state: 'verify-failed', file,
        // rename 已经成功 ⇒ 文件可能已被替换：如实说明"可能已生效"，但**不报成功**（上层照失败处理/重试）。
        maybeApplied: true,
        error: `清零边界写后校验不通过（state=${readBack.state}${Number.isFinite(Number(readBack.at)) ? `，读回 at=${readBack.at}` : ''}；写入可能已生效，请重试或查看 ${USAGE_RESET_FILE}）`
      };
    }
    return {
      ok: true, at: readBack.at, atIso: readBack.atIso, file, verified: true,
      previousAt: payload.prevAt,
      ...(Number(readBack.at) > atFloor ? { monotonic: 'kept-newer-concurrent' } : {})
    };
  });
}

/**
 * 把 usage 行按边界过滤：`ok` 时只保留 `at > 边界` 的行；其余状态**原样返回行**并把状态带出去
 * （上层负责把 `invalid`/`unreadable` 显示出来 —— 见文件头纪律 3）。
 *
 * @returns {{rows:Array, boundary:{state:string, at:number|null, atIso:string|null, reason:string,
 *   dropped:number, droppedUnknownAt:number}, dropped:number, droppedUnknownAt:number}}
 */
export function applyUsageResetBoundary(rows, boundary = null) {
  const list = Array.isArray(rows) ? rows : [];
  const stateRaw = String(boundary?.state ?? 'absent');
  // 防御：调用方手造了 `state:'ok'` 但 `at` 不是正数/越界/类型不对 ⇒ 视为 invalid（不许按"没边界"放行，
  // 也不许把坏边界当有效边界去筛行；上层会把这个状态显示出来）。
  const atValue = stateRaw === 'ok' ? boundaryAtValue(boundary?.at) : NaN;
  const atFloor = Number.isFinite(atValue) && atValue > 0 ? Math.floor(atValue) : null;
  const atIso = atFloor === null ? null : isoOrNull(atFloor);
  const valid = stateRaw === 'ok' && atFloor !== null && atIso !== null;
  const state = valid ? 'ok' : (stateRaw === 'ok' ? 'invalid' : stateRaw);
  const base = {
    state,
    at: valid ? atFloor : null,
    atIso: valid ? atIso : null,
    reason: String(boundary?.reason ?? '') || (stateRaw === 'ok' && !valid
      ? (Number.isFinite(atValue) && atValue > 0 ? 'at-out-of-range' : 'at-invalid') : '')
  };
  if (state !== 'ok' || base.at === null) return { rows: list.slice(), boundary: { ...base, dropped: 0, droppedUnknownAt: 0 }, dropped: 0, droppedUnknownAt: 0 };
  const out = [];
  let dropped = 0;
  let droppedUnknownAt = 0;
  for (const row of list) {
    // ★ 2026-10-17（时间统一）：与日统计/分片归属同一份解析 —— 带时区 ISO 的行走同一绝对时刻判据；
    //   数字行与"同一时刻的 ISO 行"现在有**相同**的保留/丢弃结果（旧版 `Number(row.at)` 会把 ISO 行
    //   当 unknown 丢掉 ⇒ 清零边界 ok 之后这批调用既不计费可见、又虚增 droppedUnknownAt）。
    const rowAt = parseEpochMs(row?.at);
    if (rowAt === null) { droppedUnknownAt += 1; continue; }   // 定位不了的行走不到任何窗口（与 collectUsageRows 的既有口径一致）
    if (rowAt > base.at) out.push(row); else dropped += 1;
  }
  return { rows: out, boundary: { ...base, dropped, droppedUnknownAt }, dropped, droppedUnknownAt };
}
