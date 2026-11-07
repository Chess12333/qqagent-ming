// §3.4 core/bus（按 §4 放在 observability 目录内，M2 一并交付）。
//
// 契约：**同步、失败隔离、不许 await 阻塞主链**。
//   · 同步：emit 里绝不用 await / Promise —— 订阅者必须是同步函数（UI 刷新、
//     计数、指标这类纯通知）。要异步的活请自己 setImmediate。
//   · 失败隔离：某个订阅者抛错，其余订阅者仍要收到；错误只记一次内部告警。
//   · 不阻塞：emit 自己不做 I/O；订阅者耗时不设上限（调用方自己保证轻量），
//     但**重入是允许的**（emit 里再 emit）—— 用快照迭代而不是直接遍历 Set。

const handlers = new Map();      // kind → Set<fn>
const failures = new Map();      // kind → 累计失败次数（读数用）
const onWarn = { fn: null };
let emitted = 0;

/** 订阅。返回退订函数。fn 必须是同步函数，返回值一律忽略。 */
export function on(kind, fn) {
  const key = String(kind ?? '');
  if (!key || typeof fn !== 'function') return () => false;
  let set = handlers.get(key);
  if (!set) { set = new Set(); handlers.set(key, set); }
  set.add(fn);
  return () => { set.delete(fn); };
}

/** 一次性订阅。 */
export function once(kind, fn) {
  const off = on(kind, (payload) => { off(); fn(payload); });
  return off;
}

/** 触发。返回被调用的订阅者数量（不含抛错的）。**永不抛**。 */
export function emit(kind, payload) {
  const key = String(kind ?? '');
  emitted += 1;
  const set = handlers.get(key);
  if (!set || set.size === 0) return 0;
  let called = 0;
  // 快照：允许订阅者在回调里 on()/off()/emit()，不破坏本次迭代。
  for (const fn of [...set]) {
    if (!set.has(fn)) continue;                  // 本次迭代期间被退订 → 跳过
    try {
      fn(payload);
      called += 1;
    } catch (error) {
      failures.set(key, (failures.get(key) || 0) + 1);
      const text = `[bus] subscriber for "${key}" threw: ${error?.code || error?.message || 'unknown'}`;
      if (typeof onWarn.fn === 'function') { try { onWarn.fn(text); } catch { /* 观测不许反噬 */ } }
      else console.warn(text);
    }
  }
  return called;
}

export function off(kind, fn) {
  const set = handlers.get(String(kind ?? ''));
  if (!set) return false;
  const removed = set.delete(fn);
  if (set.size === 0) handlers.delete(String(kind));
  return removed;
}

export function listenerCount(kind) { return handlers.get(String(kind ?? ''))?.size ?? 0; }

/** 告警出口（由 observability 注入 logger，避免 bus→logs 的硬依赖）。 */
export function setBusWarn(fn) { onWarn.fn = typeof fn === 'function' ? fn : null; }

/** 只读读数：每个 kind 的订阅数 + 累计失败次数。 */
export function busStats() {
  return {
    emitted,
    kinds: [...handlers.keys()].sort(),
    listeners: Object.fromEntries([...handlers.entries()].map(([k, v]) => [k, v.size])),
    failures: Object.fromEntries(failures)
  };
}

/** 清空（测试用；生产不调）。 */
export function resetBus() {
  handlers.clear(); failures.clear(); emitted = 0;
}