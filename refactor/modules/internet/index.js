// M14 internet · 对外唯一出口（refactor/README.md §4：每个模块只暴露 index.js）。
//
// 本文件**不含任何逻辑**：只把搬运过来的文件再导出（re-export）。
// 要改行为，请改被搬运的那些文件本身，并在回执里说明改了什么。
//
// 搬运来源（`refactor/README.md` §2 M14）：src/{web-search,wiki,bilibili,api-news,price-feed,safe-fetch}.js
// 搬运口径：**只改 import 路径，内部逻辑一行不改**（逐行差异见 selftest.mjs 的保真表）。
//
// ⚠️ safe-fetch.js 是**安全边界**（内网/环回/CGNAT 拒绝、逐跳重定向重校验、响应体大小上限），
//    搬运时除第 17 行的 import 路径外**逐字节未改**。
export * from './web-search.js';
export * from './wiki.js';
export * from './bilibili.js';
export * from './api-news.js';
export * from './price-feed.js';
export * from './safe-fetch.js';
export * from './music.js';

// ★ N41：自定义搜索服务（provider）的增删查 —— 照老树 `src/app.js:2399-2498` 的形状。
//   老树这段逻辑直接写在 HTTP 层；新树把它放这里，因为**数组的消费者是本模块**
//   （`web-search.js:1151 resolveCustomConfig` 按 id 取那一项），形状定义该和消费者住一起。
//   全部是**纯函数**（不吃 config、不写盘）⇒ 落盘由 apps/server 的 config-store 做。
export {
  listProviders, sanitizeProvider, upsertProvider, removeProvider,
  testProviderConnectivity, PROVIDER_LIMITS, MASK
} from './search-providers.js';
