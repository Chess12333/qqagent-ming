/**
 * M6 memory · 消息短编号（`msgRef` / `normalizeRef`）
 *
 * ★ 这两个名字是 **README §3.5 冻结的搬运层兼容面**：`modules/platform/sender.js` 要从
 *   `modules/memory/index.js` 取它们。语义**逐字搬自** `src/store.js:154-174`（旧实现里
 *   作者写着"只能有这一处实现"）—— 这里就是新树里的那一处，别再抄第二份。
 *
 * 为什么归 memory：编号是"给模型看的消息引用"，模型拿它回指消息（引用/工具入参），
 * 记忆侧与平台侧都必须用同一套解析，否则 `#318` 会有两种解释。
 */

/**
 * 把模型给的编号归一化：去井号（`#` / 全角 `＃`）、去空白、去掉多余的 `.0`
 * （模型偶尔把整数写成 `318.0`）。**只能有这一处实现** —— 解析规则散落两处必然改漏一处。
 */
export function normalizeRef(ref) {
  return String(ref ?? '').trim().replace(/^[#＃]+/, '').replace(/\.0+$/, '').trim();
}

/**
 * 一条消息"给模型看的短编号"（写作 `#318`）。
 * 一律用本地的递增序号 `id`；只有拿不到 id 的历史条目才退回 QQ mid（保证老存档也能显示个东西）。
 */
export function msgRef(m) {
  const n = Number(m?.id);
  if (Number.isFinite(n) && n > 0) return `#${n}`;
  const mid = m?.mid;
  if (mid === null || mid === undefined || String(mid) === '') return '';
  return `#${mid}`;
}
