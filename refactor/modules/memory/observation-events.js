import path from 'node:path';

const listenersByDir = new Map();

function keyOf(dataDir) {
  return path.resolve(String(dataDir || ''));
}

/** Subscribe to committed observation changes for one explicit data directory. */
export function subscribeObservationChanges(dataDir, listener) {
  if (!dataDir || typeof listener !== 'function') return () => {};
  const key = keyOf(dataDir);
  let listeners = listenersByDir.get(key);
  if (!listeners) {
    listeners = new Set();
    listenersByDir.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByDir.delete(key);
  };
}

/** Notify same-process memory coordinators; listeners must only schedule work. */
export function notifyObservationChange(dataDir, change = {}) {
  if (!dataDir) return;
  const listeners = listenersByDir.get(keyOf(dataDir));
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try { listener({ ...change }); } catch { /* observer failures cannot fail a committed memory write */ }
  }
}
