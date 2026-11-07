// M1 层通用工具（裁定 · 2026-10-04）：`util.js` + `md-to-plain.js` 归 `refactor/core/util/`。
// 对外唯一出口；两个原件都是零内部依赖（util.js 只 import node:fs / node:path），故为**逐字节搬运**。
export * from './util.js';
export * from './md-to-plain.js';
