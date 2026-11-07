/**
 * M6 memory · 长期源变更事件（语义卡 store / 情节摘要行）。
 *
 * 与 `observation-events.js` 同一份形状：进程内监听表按 resolved root 分桶，通知只做
 * "安排活"（coordinator 侧合并单飞 sync），监听器抛错不许打断已落盘的写入。
 *
 * ★ 为什么复用同一形状：索引同步的入口只有一个（`rebuildSemanticIndex` → `semantic.sync`），
 *   观察账本以外再多两类记录源，也不该多出第二套同步模型 —— 只多两个根键的订阅点。
 */
import path from 'node:path';

const listenersByRoot = new Map();

function keyOf(root) {
  return path.resolve(String(root || ''));
}

/** Subscribe to committed long-term source changes (semantic cards / episode rows). */
export function subscribeLongtermChanges(root, listener) {
  if (!root || typeof listener !== 'function') return () => {};
  const key = keyOf(root);
  let listeners = listenersByRoot.get(key);
  if (!listeners) {
    listeners = new Set();
    listenersByRoot.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByRoot.delete(key);
  };
}

/** Notify same-process memory coordinators; listeners must only schedule work. */
export function notifyLongtermChange(root, change = {}) {
  if (!root) return;
  const listeners = listenersByRoot.get(keyOf(root));
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try { listener({ ...change }); } catch { /* observer failures cannot fail a committed memory write */ }
  }
}
