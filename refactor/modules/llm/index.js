// M4 llm —— 云端模型 / 流式 / 重试 / 缓存标记 / 价格
//
// ★ 本模块的**唯一公开出口**：别的模块与应用只许 `import … from '../llm/index.js'`，
//   不许直接进 llm.js / providers.js / model-prices.js / cache-keepalive.js
//   （refactor/README.md §4「每个模块只暴露 index.js」）。
//
// ── 搬运台账（M4 = 搬：复制实现 + 只改 import 路径，内部逻辑一行未改）──
//   llm.js              ← src/llm.js              改了 3 处 import（5 行）
//   providers.js        ← src/providers.js        改了 1 处 import（1 行）
//   model-prices.js     ← src/model-prices.js     0 处改动（逐字节相同）
//   cache-keepalive.js  ← src/cache-keepalive.js  改了 1 处 import（1 行）
//   明细与校验见 selftest.mjs（跑 `node refactor/modules/llm/selftest.mjs`）。
//
// ── 新树内依赖（按 refactor/README.md §3 冻结接口 import，不自己实现）──
//   ../../core/config-store/index.js（M1，§3.2）
//        get(…)     ← 原 src/config.js 的 getConfig()（§3.2 冻结双形态：无参 = 活配置对象）
//        set(…)     ← 原 src/config.js 的 updateConfig()（§3.2 冻结双形态：set(patch) = 整块深合并）
//        DATA_DIR   ← 原 src/config.js 的 DATA_DIR（§3.2「兼容别名」+ §3.5 表均冻结该名；
//                     M1 已落地的 index.js 此刻**尚未导出它** ⇒ 唯一未闭合的接口缺口，
//                     见回执 §2；M14 的 api-news / price-feed 也在等同一个名字）
//   ../emotion/index.js（§3.5 归口裁定）  isHypeMode()  ← 原 src/hype-mode.js
//        （指挥位 2026-10-04 裁定：isHypeMode 的**唯一归属地**是 modules/emotion，
//          llm 与 platform 都从这里出 —— 原先写的 ../plan/index.js 已按裁定改掉）
//   ../extensions/index.js（§3.5 表 + §2 M12 明确搬 skill-bridge）
//        skillManager  ← 原 src/skill-bridge.js（动态 import ×3；已核 extensions/index.js 确有该导出）
//
// ── §3.5 搬运层兼容面（冻结，谁都不许改名）──
//   本模块必须导出：chatCompletion（← ./llm.js）· apiWith（← ./llm.js）· setRemotePrices（← ./model-prices.js）
//   消费者：modules/platform/salvage.js（前两个）· modules/internet/api-news.js（chatCompletion）
//           · modules/internet/price-feed.js（setRemotePrices）。自检 ③e 每次自动核这条。

// ── llm.js：调用主链（端点判定 / 缓存标记 / 重试 / 流式 / usage / 估价）──
export {
  resolveApiKey,
  apiWith,
  isRetryableError,
  chatCompletionWithRetry,
  isDashScopeEndpoint,
  hostOf,
  thinkingStyleFor,
  supportsCacheMarkers,
  isAutoCacheEndpoint,
  cacheAffinityField,
  stripToolsCacheControl,
  stripCacheMarkers,
  visionUnsupported,
  isImageRejection,
  stripImageParts,
  chatCompletion,
  chatCompletionOnce,
  getInFlightRequestCount,
  listModels,
  addUsage,
  emptyUsage,
  cacheHitRate,
  estimateCost
} from './llm.js';
export { chatCompletionWithRetryBudgeted } from './retry-budget.js';
export { createBudgetedJudgeModel } from './jev-adapter.js';

// ── providers.js：服务商配置 / DSH 导入 / 连通性测试 ──
export {
  readDshCredentials,
  parseDshSettings,
  importFromDsh,
  currentProviders,
  setProviderKey,
  fetchModelsFrom,
  testModelChat,
  testOneProvider,
  upsertProvider,
  addModelsToProvider,
  removeModelFromProvider,
  testProvider,
  testAllProviders
} from './providers.js';

// ── model-prices.js：价格表 / 峰谷（含 2026-10-17 起的官方法定节假日日历覆盖） / 图片计费 / 估价 ──
export {
  OFFICIAL_PRICES,
  resolveOfficialPrice,
  setRemotePrices,
  remoteOverrideCount,
  listOfficialPrices,
  PEAK_WINDOWS,
  toEpochMs,
  isPeakHour,
  priceAt,
  peakCalendarYears,
  peakCalendarSources,
  sumCostByTime,
  imageTokens,
  supportsImage,
  resolveModelPrice,
  matchPriceTable,
  UNKNOWN_VENDOR,
  vendorOfConfig,
  modelLabel,
  splitModelLabel
} from './model-prices.js';

// ── request-budget.js：上线前的整份请求计量 / 工具结果追加后复查 / 前缀稳定 ──
// ★ A55 ④ 的缓存用量读数（null=未报告 / 0=确认零）住在这里，而不是 cache-keepalive.js：
//   后者是 src 受管副本，加真实代码会被搬运保真闸门判硬失败（实测 47 条）。
// ⚠ 这几行注释必须写在 export 块**外面**：块内的 // 行会被 ③d 的「漏导出」检查按逗号切开，
//   把紧跟其后的名字粘进注释里，造成假报「漏导出」（A55 实测过一次）。
export {
  contentChars,
  measureRequestBody,
  recheckRequestBudget,
  prefixOf,
  prefixStable,
  readCacheUsageReport,
  formatCacheUsageLine,
  observeFinalRequest,
  toolSequenceFingerprint
} from './request-budget.js';

// ── keep-alive-runtime.js：把 api.cacheKeepAlive.* 接成真读点（N5）──
// ⚠ 注释必须写在 export 块**外面**：块内的 // 行会被 llm 自测 ③d 的「漏导出」检查按逗号切开，
//   把紧跟其后的名字粘进注释里，造成假报「漏导出」（A55 实测过一次）。
export {
  KEEP_ALIVE_KEYS,
  readKeepAliveOptions,
  endpointHasCache,
  KeepAliveChain
} from './keep-alive-runtime.js';

// ── cache-profile.js：provider 缓存能力的**唯一判据表**（CACHE-PROFILE-1）──────────
// ★ 显式标记 / 自动前缀 / 值不值得保温 三件事全在这张表 + 一个决策函数里；
//   llm.js 的 supportsCacheMarkers / isAutoCacheEndpoint 与 capability-matrix 都转发到这里。
//   一动这个文件，厂商表、决策、观测 facts 会一起变 —— 不会各说各话。
// ⚠ 注释必须写在 export 块**外面**（同 ③d 的「漏导出」检查口径）。
export {
  CACHE_PROFILE_VERSION,
  CACHE_VENDORS,
  vendorRowFor,
  cacheProfileFor,
  cacheDecisionFor
} from './cache-profile.js';

// ── cache-marker-memory.js：400 剥标记的**按身份隔离**记忆（2026-10-17 用户裁定）──────
// ★ 只在"剥掉 cache_control 后重试成功"时记一笔；贴标记点与保温决策都读它 ⇒ 不再"一边被剥离、
//   一边报已启用"。键 = endpoint(host)+账号指纹+模型+有效策略（不连坐别家）；只存指纹/种类/时间。
export { noteCacheMarkerStripped, cacheMarkerStrippedOn, cacheMarkerMemorySnapshot } from './cache-marker-memory.js';

// ── capability-matrix.js：provider/模型能力的一处统一出口（N70）──────────────────
// ★ 不新造判据：底层全部转调受管副本 llm.js 的同名函数；本文件只做"汇总 + 点名未知 + 交叉验算"。
//   文件头有一页说明（缓存三层 / TTL / 谁说话算数），不熟悉的人从那里读起。
// ⚠ 注释必须写在 export 块**外面**：块内的 // 行会被 llm 自测 ③d 的「漏导出」检查按逗号切开，
//   把紧跟其后的名字粘进注释里，造成假报「漏导出」（A55 实测过一次）。
export {
  VENDORS,
  vendorOfHost,
  capabilityOf,
  capabilityMatrix,
  formatCapabilityLine,
  cacheMarkingTrace,
  cacheMarkingPlan,
  CACHE_MARKERS_PER_REQUEST,
  PROVIDER_MAX_CACHE_MARKERS,
  DEFAULT_MIN_PREFIX_TOKENS,
  capabilityFactsFor
} from './capability-matrix.js';

// ── final-body.js：上线前"最终发送体"的纯观测缝（N49）+ api.costGuard.* 的纯判定 ──
// ★ 指挥位 2026-10-09 裁定走 (b) onFinalBody 回调缝，不走 (a) 改 chatCompletion 返回契约：
//   (a) 会改返回形状（爆炸半径 = 所有调用方），(b) 是纯观测、默认 no-op。
//   受管副本 llm.js 因此多了 3 行（1 import + 1 签名 + send 里 1 次调用），
//   逐行登记在 selftest.mjs 的 AUTHORIZED_DEVIATIONS，闸门照旧。
// ⚠ 注释必须写在 export 块**外面**：块内的 // 行会被 llm 自测 ③d 的「漏导出」检查按逗号切开，
//   把紧跟其后的名字粘进注释里，造成假报「漏导出」（A55 实测过一次）。
export {
  sanitizeFinalBody,
  cacheControlFacts,
  formatCacheControlLine,
  emitFinalBody,
  costGuardVerdict,
  shouldReduceOptionalInjects,
  costGuardStatsShape
} from './final-body.js';

// ── cache-keepalive.js：自适应缓存标记 + 保温链 + 保温台账 ──
export {
  DEFAULT_KEEP_ALIVE,
  isPrivateChatKey,
  shouldMarkPrefix,
  keepAliveOptionsFor,
  cacheKeyOf,
  readUsageNumbers,
  cacheKeeperTableStats,
  CacheKeeper,
  nextKeepAliveStep,
  keepAliveMessages,
  keepAliveLedgerPath,
  appendKeepAliveLedger,
  compactKeepAliveLedger,
  summarizeKeepAliveLedger
} from './cache-keepalive.js';
