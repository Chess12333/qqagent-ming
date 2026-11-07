/**
 * ★ 2026-10-17（用量清零 / 日统计时间统一）：把 usage 行（或时间参数）的 `at` 归一成**绝对毫秒**。
 *
 * 为什么要一份共用判据：同一批账本行被三条路读 ——
 *   ① `usage-reset.js:applyUsageResetBoundary` 的清零过滤；② `sink.js` 的自然日窗口（`addUsageRow`/`rowInWindow`）；
 *   ③ `sink.js:dayOf` 的**分片归属**（写盘时按行自己的 `at` 决定进哪一天的 ndjson）。
 * 三条路各自 `Number(row.at)` 时会分裂：带时区 ISO 的行被 ① 当"时间不可信"丢掉，
 * 却在 ③ 里 `Number('2026-…')=NaN → || Date.now()` 折成**今天** —— 同一时刻的"数字行"与"ISO 行"
 * 保留/丢弃结果不一致，且 ISO 行可能两头都统计不到。
 *
 * 语义（与上层参照 `modules/llm/model-prices.js:toEpochMs` **同口径**；本文件不 import 它，
 * 避免 core → modules 反向依赖）：
 *   · `Date`                ⇒ `getTime()`（有限且 > 0 才算）；
 *   · `number`              ⇒ 有限且 > 0 才算；**不做秒/毫秒推断**（这里一律按毫秒解释，小的数就是小的毫秒）；
 *   · 纯数字串（可带负号/小数）⇒ 同上（`''`/空白串 ⇒ unknown）；
 *   · 其它字符串            ⇒ `Date.parse()`：`2026-10-17T09:30:00+08:00` / `…Z` 按字符串自己的偏移
 *                             定位到**同一绝对时刻**（不做本地时区假设）；解析不出/NaN/<= 0 ⇒ unknown；
 *   · `null` / `undefined` / `false` / 数组 / 对象 / NaN / Infinity / 负数 ⇒ **unknown（`null`）** ——
 *     绝不 `Number(null)=0` 冒充"定位得到"，也不按当前时间猜。
 *
 * unknown 的用法（调用方纪律）：按"定位不到"处理 —— 丢弃并**计数**（如 `droppedUnknownAt`/`unknownAtRows`），
 * 把结果标成不完整；**不许**塞进今天，也不许把"解析不到的调用"说成 0 调用完整。
 */
export function parseEpochMs(value) {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) && t > 0 ? t : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
