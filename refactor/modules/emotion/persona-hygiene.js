/**
 * 双人格读侧可见性 · **唯一实现**（qwen2 建议、指挥位 2026-10-13 定分工：mimo1 函数 ·
 * qwen1 断言+消费点 · luna2 compose 接同一 import —— 三侧只许 import 这一个符号，
 * 源码级断言由 qwen1 钉，防"同名不同义"）。
 *
 * 语义逐条对齐老树 `src/prompt.js:1768-1776 selfRowVisibleNow`（用户拍板：**一律隔离**，
 * 经历与口吻都对第一人格不可见；不做"经历共享"细分）：
 *   · 只对 `self === true` 的行按 `row.persona2` 归属过滤；**非己行恒可见**（群友行不受影响）；
 *   · **无标（`row.persona2 !== true`）= 第一人格行** ⇒ 任何在位状态都可见 ——
 *     存量数据行为逐字节不变、零迁移（这就是"反向对照：第一人格期间看到的行一条不少"的依据）；
 *   · 两个开关默认隐（`=== false` 才放行），读 `persona2.memoryHygiene`（defaults 已有三键）；
 *   · `personaTwo` 由调用方注入（判定归 M7/M15，本函数**不自取状态** ⇒ 纯、可测）。
 *
 * ★ 只用于"喂给模型的"读取点；**UI 一律不滤**（老树取舍：用户自己看得到，模型看不到）。
 * ★ 后路记档（用户 2026-10-13 拍板"一律隔离"时留）：若日后改"经历共享"，只在本函数按
 *   记录类别分叉一处（放开经验类、保留口吻类）——数据与写侧不动、无需回滚。
 */
export function selfRowVisibleNow(row, { personaTwo = false, hygiene = {} } = {}) {
  if (row?.self !== true) return true;
  const hers = row?.persona2 === true;
  if (personaTwo === true) {
    if (hers) return true;                            // 红在位：她自己说过的留着
    return hygiene.hideFirstPersonaHistory === false; // 默认 true ⇒ 隐去第一人格的行
  }
  if (!hers) return true;                             // 蓝在位：自己说过的留着
  return hygiene.hideSecondPersonaHistory === false;  // 默认 true ⇒ 隐去红说过的（"她不知道你的存在"）
}
