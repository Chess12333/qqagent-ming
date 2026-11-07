// M11 media —— 对外唯一出口（refactor/README.md §4：别的模块只能从 index.js 进）。
//
// 本模块是「搬 + 改边界」：
//   · 搬运件 9 个（逐字节搬，只改 import 路径，零行为改动 —— 见 selftest.mjs 的保真表）
//   · 边界层 1 个（boundaries.js，**新写**：本次唯一的行为级改动）
//
// ★ 下游只许用本文件导出的名字。**发送不是本模块的事**（B1）：
//   媒体层只提供「找 / 存 / 看」的能力（返回候选 + 元信息），发不发、发什么由
//   M8 plan 定意图、M10 act 执行并核验回执。谁在这里发消息，谁就破坏了 §3.1 的「决定权唯一」。
//
// ── 搬运台账（源 → 目标，改动 = 仅 import 路径）──
//   image-lib.js          ← src/image-lib.js          2 处（config-store / memory）
//   image-type.js         ← src/image-type.js         0 处（逐字节相同）
//   memes.js              ← src/memes.js              2 处（config-store / memory）
//   model-vision-docs.js  ← src/model-vision-docs.js  0 处（逐字节相同）
//   reverse-image.js      ← src/reverse-image.js      0 处（逐字节相同）
//   sticker-manager.js    ← src/sticker-manager.js    4 处（platform / config-store / internet / util）
//   stickers.js           ← src/stickers.js           1 处（config-store）
//   vision-image.js       ← src/vision-image.js       1 处（llm）
//   vision-scan.js        ← src/vision-scan.js        1 处（config-store）
//   memory-audit.js       **不归本模块** —— 归 M6 memory（README §3.5 归口裁定），
//                         本模块从 ../memory/index.js 取 logMemoryChange。
//
// ── 新树内依赖（按 §3.2/§3.5 冻结名 import，不自己实现替代品）──
//   ../../core/config-store/index.js  DATA_DIR / getConfig / updateConfig
//   ../../core/util/index.js          isLocalHostUrl
//   ../memory/index.js                logMemoryChange
//   ../platform/index.js              OneBotClient（**只用于下载/取图**，见 B1 白名单）
//   ../internet/index.js              safeFetchBinary
//   ../llm/index.js                   visionUnsupported
//   此刻部分邻居尚未齐备 —— 缺席不算本模块的失败，见 selftest.mjs 第③节的静态表。
//
// ── 边界（B1/B2/B3/B4，实现在 boundaries.js；下游必须走它，不许直接调搬运件裸函数）──
//   B1 不决定"发不发/发什么"：scanSendSurface / assertNoSendSurface / ONEBOT_READONLY_*
//   B2 不猜图中人        ：normalizeVisionResult / visionConclusion / assertNoSenderAttribution
//   B3 失败要说失败      ：fail / settle / fromLegacyResult / libResult / isMediaFailure / MEDIA_FAILURE
//   B4 第三方上传默认关   ：reverseImageSearchGuarded / resolveUploadPolicy
//                          / REVERSE_IMAGE_UPLOAD_POLICY（默认 false，见裁定①，L3 对外发送）
//   已知债登记           ：KNOWN_DEBTS（裁定②：readIndex 吞失败 —— 源码不改，第 3 批定夺）
//
// ★ boundaries.js 是 **media 私有**的边界守卫（裁定③）：不在 README §3.5 冻结面里，
//   别的模块**不许** import 它。需要"source 字段"这类合同语义请去 contracts/。
//   ★ 由 index.js 转发导出只是为了让 media 内部（含 selftest）走唯一出口，不代表它对外开放。

// ── 搬运件：逐个核过"出网/外发面"之后的导出方式 ──
//   纯本地（出网候选 0）：image-lib · image-type · memes · model-vision-docs · stickers · vision-image
//   有外发面 ⇒ 必须显式白名单，不许 `export *`（见下）
export * from './image-lib.js';
export * from './image-type.js';
export * from './memes.js';
export * from './model-vision-docs.js';
export * from './sticker-manager.js';
export * from './stickers.js';
export { createStickerPromptPlanner, STICKER_PREFIX_COUNT } from './sticker-prompt.js';
export * from './vision-image.js';

// ══ N42 自动看图（老树 src/orchestrator.js:3058-3121 的同款能力）══
//   零 import、纯逻辑 + 注入依赖：下载/视觉归一化都由装配层传进来，
//   所以它自己没有任何出网面（F19 的白名单外函数这里一个都没有）。
export {
  AUTO_VISION_LIMIT, AUTO_VISION_MAX_FRAMES, AUTO_VISION_MAX_BYTES, AUTO_VISION_MAX_TOTAL_CHARS,
  MODEL_REQUEST_IMAGE_LIMITS, effectiveVisionLimits, fitVisionDataUrls, formatMB,
  autoVisionRuns, autoVisionEnabled, triggerImageUrls, lastUserIndex,
  autoVisionNote, autoVisionMissNote, autoVisionNoUrlNote, autoVisionDepsNote, countImageEntries,
  attachTriggerImages, loadForeignDecoder
} from './auto-vision.js';

// ══ N85 图像缩放（零依赖：PNG 纯 JS 解码 + 最近邻缩放 + 复用 vision-image 的 encodePng）══
export { decodePng, scaleRgba, shrinkImageForVision } from './image-scale.js';

// ══ N50 接梗提示判据（老树 src/orchestrator.js:2762-2860 的前置半 + src/bot-state.js:922/958 词表）══
//   三个 media 死键（api.memeAutoCue / memeCueMinScore / memeCuePlayfulOnly）的语义在这半边落地；
//   检索/冷却/注入归编排层，JEV 复核用户已冻结 ⇒ 刻意不碰。
export {
  looksMemeCue, looksPlayfulCue, looksPlayfulOccasion,
  isUsableCue, memeCueMinScore, memeCueDecision, pickMemeCue, memeCueInject
} from './meme-cue.js';

// ══ N-TRANSCRIBE 语音转写（老树 src/onebot.js:523-537 同款，宿主层调用）══
//   零 import：能力查询走 opts.getProviders 注入或动态 import 扩展底座；
//   成功时在 record 段后插 text 段，renderText 拼出来与老树 `[语音]文字` 逐字一致。
export { TRANSCRIBE_TIMEOUT_MS, transcribeRecordSegment, transcribeRecordSegments } from './transcribe-record.js';

// ══ 收口 1：reverse-image.js —— **一律不从公开出口导出** ══
// reverseImageSearch 会把**用户图片** POST 到第三方图床 sm.ms / catbox 换公网 URL，
// 再把该 URL 交给百度识图 / IQDB。B4 的闸门只挂在 reverseImageSearchGuarded 上；
// 若裸函数也挂在公开出口上，`import { reverseImageSearch } from '../media/index.js'`
// 一行就能绕过闸门 ⇒ **"默认关"就名存实亡**（默认关的意义是"不可能不小心发出去"，
// 不是"只要记得走守卫就不会发"）。
//   · 出口上**没有** reverseImageSearch；要反向图搜只能用 reverseImageSearchGuarded（boundaries 唯一受控入口）。
//   · 本文件源码在 media 内部仍可直接 import（selftest F15 就这么用），那是 media 内部的事；
//     F19 断言专门盯着"它不许出现在公开出口上"。
//   · 逐个点名导出？—— reverse-image.js 只有这一个 export，且它正是出网的那个，所以没有可点名的干净出口。
export {} from './reverse-image.js';   // ← 刻意为空：不导出任何东西，只留一行说明在这

// ══ 收口 2：vision-scan.js —— **显式白名单** ══
//   出网候选：`fetch('<baseUrl>/chat/completions')`（detectModelVision L57 / scanModelsVision 走它），
//   会把探测图发给 provider —— 与 reverseImageSearch 同性质（同为"把数据发出去"）。
//   纯读（只读 config，不出网）：visionResults · modelVisionVerdict · modelImageVerdict
export { visionResults, modelVisionVerdict, modelImageVerdict } from './vision-scan.js';
//   ★ 不导出 detectModelVision / scanModelsVision。要用请走受控入口，或先向指挥位申请收口。
//     （本轮**不**给它们另造一个默认关开关 —— 那又是改产品默认行为，需要用户点头。）

export * from './boundaries.js';
