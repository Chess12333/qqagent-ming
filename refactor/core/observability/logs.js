// 分级日志：内存环形缓冲 + 按天落盘 + 订阅推送。搬 `src/logger.js` 的设计
// （分级 / 环形 / 订阅 / 落盘健康可见 / 重入防护 / 旧文件清理），三处适配：
//   1. DATA_DIR → obsDir 参数（不 import config-store）；
//   2. **落盘改成走 sink 的异步队列** —— src 每条一次 mkdirSync+appendFileSync，
//      那正是 memory-guard 抓到的 1.4–2.0s 事件循环缺口来源；refactor 里观测一律
//      不许阻塞主链（README 不变量"写入失败不许抛给主流程"的同源要求）；
//   3. msg 里的聊天正文由调用方负责不传（与 src 同约定），fields 走 ASCII 消毒。
//
// 重入防护保留：src 曾因 onLog 监听器里再调 logger.* 形成无限递归，单日写崩到 15GB。

import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { recordPhase } from './phases.js';
import { safeId, safeText, safeFields, noteEnumDrop } from './sanitize.js';

export const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const MAX_MEMORY = 500;
const KEEP_DAYS = 7;

/**
 * 级别白名单外的值一律回落 info —— 但**要记账**（★ N45）。
 * 回落本身是老树口径，不动；加的只是"数得出来"：`configure({level:'verbose'})` 这种
 * 拼错的级别以前是**静默变成 info**，现在会在 `stats().enumCoercions` 里留一条。
 */
function pickLevel(level) {
  if (LEVELS[level] != null) return LEVELS[level];
  noteEnumDrop('log.level', level);
  return LEVELS.info;
}

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function createLogger({ obsDir, mirrorConsole = true, level = 'info', append = null, ringMax = MAX_MEMORY } = {}) {
  const dir = obsDir ? path.join(obsDir, 'logs') : null;
  const listeners = new Set();
  const memory = [];
  const state = {
    level: pickLevel(level),
    mirrorConsole,
    writing: false,
    pruneRuns: 0,
    sink: { ok: true, failCount: 0, lastError: '', firstFailAt: 0, lastFailAt: 0, file: '' }
  };

  function file() { return dir ? path.join(dir, `qq-agent-${todayStamp()}.log`) : ''; }

  function line(level, module, text) {
    const time = new Date().toISOString().slice(11, 19);
    return `${time} [${level.toUpperCase().padEnd(5)}] [${module}] ${text}\n`;
  }

  function push(entry) {
    memory.push(entry);
    if (memory.length > ringMax) memory.splice(0, memory.length - ringMax);
    for (const fn of [...listeners]) { try { fn(entry); } catch { /* 隔离 */ } }
  }

  function recordFailure(err) {
    const s = state.sink;
    state.sink.ok = false;
    s.failCount += 1;
    s.lastError = `${err?.code || ''} ${err?.message || err}`.trim().slice(0, 200) || String(err);
    s.lastFailAt = Date.now();
    if (!s.firstFailAt) s.firstFailAt = s.lastFailAt;
    s.file = file();
  }

  async function writeFile(text) {
    if (!dir) return;
    const t0 = performance.now();
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.appendFile(file(), text, 'utf8');
      if (!state.sink.ok) { state.sink.ok = true; state.sink.lastError = ''; }
      state.sink.file = file();
    } catch (err) {
      recordFailure(err);                            // 可见但不抛（不变量 4）
      if (typeof append === 'function') return;      // 无目录的纯内存模式
    } finally {
      // 与 src 同口径：日志自身的落盘段也要计时（src: logger.appendFile）。
      recordPhase('logger.appendFile', performance.now() - t0);
    }
  }

  function write(level, module, text, fields) {
    if (state.writing) return null;                  // 重入丢弃（src 的 15GB 事故）
    state.writing = true;
    try {
      const lv = pickLevel(level);
      const mod = safeId(module, 48, 'app') || 'app';
      const body = safeText(text, 4000);
      const entry = { ts: Date.now(), level, module: mod, text: body };
      const extra = safeFields(fields, { maxKeys: 16, maxLen: 120 });
      if (extra) entry.fields = extra;
      push(entry);
      if (state.mirrorConsole) {
        const out = `[${mod}] ${body}`;
        if (level === 'error') console.error(out);
        else if (level === 'warn') console.warn(out);
        else console.log(out);
      }
      if (lv >= state.level) {
        const capped = body.length > 60_000 ? `${body.slice(0, 60_000)}…(truncated)` : body;
        const text2 = line(level, mod, extra ? `${capped} ${JSON.stringify(extra)}` : capped);
        void writeFile(text2);
      }
      return entry;
    } finally {
      state.writing = false;
    }
  }

  return {
    debug: (module, text, fields) => write('debug', module, text, fields),
    info: (module, text, fields) => write('info', module, text, fields),
    warn: (module, text, fields) => write('warn', module, text, fields),
    error: (module, text, fields) => write('error', module, text, fields),
    // mirrorConsole 必须是**可读写的属性**（旧 src/logger.js 里它就是 public 字段，
    // apps/desktop/main.js:511 与 :1721 都在写 `logger.mirrorConsole = true`）。
    // 闭包里的 state.mirrorConsole 若不暴露出去，赋值会静默失败（写在临时对象上）。
    get mirrorConsole() { return state.mirrorConsole; },
    set mirrorConsole(value) { state.mirrorConsole = !!value; },
    setLevel(next) { if (LEVELS[next] != null) state.level = LEVELS[next]; else noteEnumDrop('log.level', next); return this; },
    getLevel() { return Object.keys(LEVELS).find((k) => LEVELS[k] === state.level) || 'info'; },
    onLog(fn) { if (typeof fn !== 'function') return () => false; listeners.add(fn); return () => { listeners.delete(fn); }; },
    /** 内存最近若干条（UI 首次加载用，不碰磁盘）。 */
    recent(limit = 200) { return memory.slice(-Math.max(1, Number(limit) || 200)); },
    /** ★ 2026-10-17：环形缓冲容量（只读）——`recentWithMeta` 要用真实容量判断"这份视图是不是全的"。 */
    get ringMax() { return ringMax; },
    /** 落盘健康读数（只读快照）。 */
    sinkStatus() { return { ...state.sink, pruneRuns: state.pruneRuns }; },
    /** 清理超过 KEEP_DAYS 的旧日志（成功与否都计一次执行）。 */
    async prune() {
      state.pruneRuns += 1;
      if (!dir) return 0;
      let removed = 0;
      const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
      const names = await fs.readdir(dir).catch(() => []);
      for (const name of names) {
        if (!name.endsWith('.log')) continue;
        const full = path.join(dir, name);
        const st = await fs.stat(full).catch(() => null);
        if (!st) continue;
        if (st.mtimeMs < cutoff) { if (await fs.unlink(full).then(() => true).catch(() => false)) removed += 1; }
      }
      return removed;
    },
    flush: () => Promise.resolve()
  };
}