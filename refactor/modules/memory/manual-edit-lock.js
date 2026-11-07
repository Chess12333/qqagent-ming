/**
 * M6 memory · 手工编辑保护锁（老树 `src/memory.js:1785-1799` 的搬运）。
 *
 * 手工内容/态度修改后按 subjectId 持久记录时间，自动整理在锁窗口内跳过该 subject。
 * ★ 只有**内容侧真变更**（印象条集合增/删/改）才打锁；只改 favor/note/名字不锁。
 * ★ 清空印象也算内容变更 ⇒ 打锁（老树 :1831 `oldContents !== newContents` 涵盖空集）。
 *
 * ★ 持久化：`<dataDir>/memory/manual-edit-locks.json` = `{ [subjectId]: { manuallyEditedAt: number } }`。
 *   **不用进程内 Map**——锁必须跨重启存活，否则"刚改完就被整理覆盖"的竞态窗口重新打开。
 *
 * ★ 锁窗口 `memory.manualEditLockMs`：非法/<=0 → 默认 4h；有效值夹 [5min, 24h]（老树 :1788-1789）。
 *
 * ★ 自动 vs 手动：本模块只存/查锁；"哪些请求受锁"由 coordinator 判
 *   （约定 `reason === 'auto-maintenance'` 受锁，其余绕过）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { memoryDir } from './data-dir.js';

const LOCK_FILE = 'manual-edit-locks.json';
const HOUR = 60 * 60 * 1000;
const DEFAULT_LOCK_MS = 4 * HOUR;
const MIN_LOCK_MS = 5 * 60 * 1000;
const MAX_LOCK_MS = 24 * HOUR;

/**
 * 读锁窗口配置（老树 `src/memory.js:1785-1790` 逐字语义）。
 * @param {{get?:Function}|null} cfg M1 只读访问器；不传/读不到用默认 4h。
 * @returns {number} 毫秒，夹在 [5min, 24h]
 */
export function getLockWindowMs(cfg = null) {
  let raw = NaN;
  try { raw = Number(cfg?.get?.('memory.manualEditLockMs')); } catch { /* 读不到用默认 */ }
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LOCK_MS;
  return Math.min(MAX_LOCK_MS, Math.max(MIN_LOCK_MS, Math.round(raw)));
}

function lockFile(dataDir) {
  return path.join(memoryDir(dataDir), LOCK_FILE);
}

function loadLocks(dataDir) {
  try {
    const raw = fs.readFileSync(lockFile(dataDir), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch { return {}; }
}

function saveLocks(store, dataDir) {
  try {
    const file = lockFile(dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

/**
 * 打锁（手工编辑内容/态度真变更后调用）。
 * @param {string} subjectId
 * @param {number} at 编辑时刻（毫秒）
 * @param {string|null} dataDir
 * @returns {boolean} 是否持久化成功
 */
export function writeManualEditLock(subjectId, at, dataDir = null) {
  const sid = String(subjectId ?? '').trim();
  if (!sid) return false;
  const ts = Number(at) || Date.now();
  const store = loadLocks(dataDir);
  store[sid] = { manuallyEditedAt: ts };
  return saveLocks(store, dataDir);
}

/**
 * 该 subject 是否在锁窗口内（老树 `isManuallyEdited` 逐字语义）。
 * @param {string} subjectId
 * @param {string|null} dataDir
 * @param {number|null} windowMs 不传则用默认 4h（调用方应从 cfg 读 `getLockWindowMs`）
 * @returns {boolean}
 */
export function isManuallyEdited(subjectId, dataDir = null, windowMs = null) {
  const sid = String(subjectId ?? '').trim();
  if (!sid) return false;
  const store = loadLocks(dataDir);
  const t = Number(store[sid]?.manuallyEditedAt || 0);
  const win = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0 ? Number(windowMs) : DEFAULT_LOCK_MS;
  return t > 0 && Date.now() - t < win;
}

/**
 * 过滤出受锁的 subjectId 集合。
 * @param {string[]|null} subjectIds null = 全部（调用方需自行枚举全量，本函数只判给定的）
 * @param {string|null} dataDir
 * @param {number|null} windowMs
 * @returns {Set<string>} 受锁的那些 id
 */
export function filterLockedSubjects(subjectIds, dataDir = null, windowMs = null) {
  const locked = new Set();
  const list = Array.isArray(subjectIds) ? subjectIds : [];
  const win = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0 ? Number(windowMs) : DEFAULT_LOCK_MS;
  const store = loadLocks(dataDir);
  const now = Date.now();
  for (const raw of list) {
    const sid = String(raw ?? '').trim();
    if (!sid) continue;
    const t = Number(store[sid]?.manuallyEditedAt || 0);
    if (t > 0 && now - t < win) locked.add(sid);
  }
  return locked;
}
