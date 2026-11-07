/**
 * M10 act · 内建工具执行器注册表（**契约冻结点**，2026-10-05 指挥位）
 *
 * 背景：2026-10-04 的复核（T-CUTOVER-2 第 1 条）实测发现——新树登记了 8 个内建工具，
 * 但**除 `send_message` 外一个都不能执行**（`act.run` 每次都返回「未注入 X 执行器」）。
 * 旧树有 41 个工具实现（`src/tools.js`，3674 行）。本目录就是那 41 个的落点。
 *
 * ── 执行器契约（**别改**；要改先找指挥位）────────────────────────────────
 * 1. 签名：`async (ctx, args) => result`
 * 2. `ctx` 白名单（M15 注入，见 README §3.9）：
 *      `modules`   —— 模块命名空间（`ctx.modules.memory` / `.media` / `.internet` / `.llm` / `.platform` …）
 *      `platform`  —— 活平台实例（**只许读，不许直接发消息**，见第 5 条）
 *      `cfg`       —— 配置访问器 `{ get(key, fallback), effective(key, {chatKey,kind}) }`
 *      `chatKey` / `kind` / `evidenceId` / `evidence` / `context` / `jevSignal` / `plan`
 *      `signal`（AbortSignal）/ `idempotencyKey`
 * 3. 返回值：`{ ok?: boolean, data?: any, error?: string }`；返回裸值时 M10 当 `data`。
 *      `ok:false` / 抛错都算工具失败，M10 会把错误回给模型（**不许吞错**）。
 * 4. 每个执行器**自己**把结果整理成"模型看得懂的一句话/小对象"——错误也要说人话。
 * 5. ★ **不许自己发消息**：执行器**一次都不碰平台**；回执只在 M10 造（README §3.5）。
 *    "发图/发卡"类工具只把**已准备**的载荷放进 `data`（`pendingSend` / 卡片 + `prepared:true`），
 *    由 act 统一消费并复用 `send()` 一次完成投递（`act/index.js` 的 `deliverPreparedMedia()`）。
 *    ★ P0-4（2026-10-08）：**已准备 ≠ 已投递** —— 只有平台回执才算投递成功
 *    （`deliveryState`：delivered / unknown / not_deliverable / failed），执行器不许带 sent/delivered 语义。
 * 6. ★ 不许 import 别的模块的**内部文件**；要能力就 `ctx.modules.<模块>.<公开出口>`（§0.4）。
 * 7. 执行器文件按域切片，**一个文件一个写入者**（并行搬运用）：
 *      `messaging.js` · `media.js` · `memory.js` · `query.js` · `music-bili.js`
 *
 * ── 旧树对照 ──────────────────────────────────────────────────────────
 * 实现照搬 `src/tools.js` 的 `execute(ctx, args)` 主体，但**依赖要换成新树出口**
 * （旧 `getConfig()` → `ctx.cfg.get()`；旧 `onebot` → `ctx.platform`；
 *   旧 `store` → `ctx.modules.memory.store`；旧 `src/xxx.js` → 对应新模块）。
 */

import { executors as messaging } from './messaging.js';
import { executors as media } from './media.js';
import { executors as memory } from './memory.js';
import { executors as query } from './query.js';
import { executors as musicBili } from './music-bili.js';

/** 切片名 → 执行器表（自测与排障要看"哪一片装了哪些工具"）。 */
export const EXECUTOR_SLICES = Object.freeze({
  messaging,
  media,
  memory,
  query,
  'music-bili': musicBili
});

/** 把 5 片合成一张 `{ toolName: executor }`。重名即抛（不许默默覆盖）。 */
export function builtinExecutors() {
  const out = {};
  const owner = {};
  for (const [slice, table] of Object.entries(EXECUTOR_SLICES)) {
    for (const [name, fn] of Object.entries(table || {})) {
      if (typeof fn !== 'function') throw new Error(`执行器 ${name}（${slice}）不是函数`);
      if (out[name]) throw new Error(`执行器 ${name} 重复：${owner[name]} 与 ${slice}`);
      out[name] = fn;
      owner[name] = slice;
    }
  }
  return out;
}

/** 哪个工具由哪一片提供（排障用）。 */
export function executorOwners() {
  const out = {};
  for (const [slice, table] of Object.entries(EXECUTOR_SLICES)) {
    for (const name of Object.keys(table || {})) out[name] = slice;
  }
  return out;
}
