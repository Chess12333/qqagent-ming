// 阶段耗时观测。搬 `src/phase-timer.js`，行为不改：
//   · 每阶段一个环形缓冲（上限 RING=64）只存耗时数值，防无界增长；
//   · 统计现算 p50/p95/max；lastAt 供与停顿探测器的 stall.at 逐条对表；
//   · GC 单次 pause 额外留一条带时间戳的事件（聚合值判不了"同一毫秒"）；
//   · ≥SPIKE_MIN_MS 的阶段额外留一条尖峰事件（同样的对表需求）。
//
// 与 src 的差异只有一处：阶段名过 ASCII 闸（落盘字段不许带自然语言）。
// 非法耗时静默丢弃 —— 观测绝不能反过来影响被测代码。
import { performance } from 'node:perf_hooks';
import { safeId } from './sanitize.js';

const RING = 64;
const SPIKE_MIN_MS = 200;

const rings = new Map();     // name → number[]
const lastAt = new Map();    // name → 最后一次 Date.now()
const gcPauses = [];         // [{ at, ms, kind }]
const spikes = [];           // [{ name, at, ms }]

function round2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** 记一次阶段耗时（ms）。name 必须过 ASCII 闸。 */
export function recordPhase(name, ms) {
  const key = safeId(name, 48, '');
  const v = Number(ms);
  if (!key || !Number.isFinite(v) || v < 0) return false;
  let arr = rings.get(key);
  if (!arr) { arr = []; rings.set(key, arr); }
  arr.push(v);
  if (arr.length > RING) arr.splice(0, arr.length - RING);
  lastAt.set(key, Date.now());
  if (v >= SPIKE_MIN_MS) {
    spikes.push({ name: key, at: Date.now(), ms: round2(v) });
    if (spikes.length > RING) spikes.splice(0, spikes.length - RING);
  }
  return true;
}

/** 同步段计时包装：fn 抛错也照记（finally），不吞异常、不改返回值。 */
export function timeSync(name, fn) {
  const t0 = performance.now();
  try { return fn(); } finally { recordPhase(name, performance.now() - t0); }
}

/** 异步段计时包装（含 fn 内部的 await 等待）。 */
export async function timeAsync(name, fn) {
  const t0 = performance.now();
  try { return await fn(); } finally { recordPhase(name, performance.now() - t0); }
}

/** 记一次 GC 暂停（由 memory-guard 既有的 PerformanceObserver 回调喂进来）。 */
export function recordGcPause(ms, kind = null) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return false;
  recordPhase('gc.pause', v);
  gcPauses.push({ at: Date.now(), ms: round2(v), kind: safeId(kind, 32, '') || null });
  if (gcPauses.length > RING) gcPauses.splice(0, gcPauses.length - RING);
  return true;
}

function percentile(sorted, p) {
  const n = sorted.length;
  if (!n) return null;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
  return round2(sorted[idx]);
}

/** [{ name, n, p50, p95, max, lastMs, lastAt }]，按名排序。 */
export function phaseStats() {
  const out = [];
  for (const [name, arr] of rings) {
    if (!arr.length) continue;
    const sorted = [...arr].sort((a, b) => a - b);
    out.push({
      name,
      n: arr.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: round2(sorted[sorted.length - 1]),
      lastMs: round2(arr[arr.length - 1]),
      lastAt: lastAt.get(name) || null
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function gcPauseEvents() { return gcPauses.slice(); }
export function phaseSpikeEvents() { return spikes.slice(); }
export function phaseSpikeMinMs() { return SPIKE_MIN_MS; }
export function phaseRingLimit() { return RING; }

/** 只挑给定阶段的读数；不传 stages（或传空）= 全部阶段。 */
export function ttftStats(stages) {
  const list = Array.isArray(stages) ? stages.map((s) => safeId(s, 48, '')).filter(Boolean) : [];
  const wanted = list.length ? new Set(list) : null;
  return phaseStats().filter((item) => !wanted || wanted.has(item.name));
}

/** 只读读数清空（测试用；生产不调）。 */
export function resetPhases() {
  rings.clear(); lastAt.clear(); gcPauses.length = 0; spikes.length = 0;
}