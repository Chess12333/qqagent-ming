/**
 * M5 scenario —— 阶段 A：还原事实场景（唯一公开出口，README §4）
 *
 * 输入：一批原始入站消息
 *   { chatKey, kind: 'group'|'private', selfId, raw: [...], botSaid?: [...], now? }
 * 输出：一串 `MessageEvidence`（形状**逐字**来自 `refactor/contracts/index.js`，README §3.1）
 *
 * ```
 * import { ingestBatch } from '../scenario/index.js';
 * const evidence = ingestBatch(batch, { selfNames: ['鲸鲸'] });
 * ```
 *
 * ★ 阶段 A 的边界（越界就是返工）：
 *   - **只还原事实**：谁对谁、引用谁、图里是谁（已知描述）、机器人说过什么（有回执的）
 *   - 不猜动机 / 不判人格 / 不判真伪 / **不做情绪分类**（那是 M7）
 *   - 不决定回不回（那是 C 阶段，README §0.5）
 *   - **不读配置**（M5 不 import M1）：机器人自己的名字由调用方用 `options.selfNames` 注入
 *   - 不联网：@名字 / 被引内容都靠**同步注入**的 resolver；解析不到就如实缺着（不编）
 *
 * ★ 依赖面（selftest 静态核过）：
 *   - 只 import `../../contracts/index.js`（M0）与 `node:` 内置（本模块实际一个 node: 都没用）
 *   - **不 import 任何别的模块**（M3/M6/M8… 一个都不碰）。协议端的段形状由入参宽收口适配，
 *     不靠 import 别人的实现 —— 这也让本模块在邻居没落地时照样能跑。
 *
 * ★ 确定性：无 `Math.random` / 无 `Date.now` / 无 `new Date`（selftest 逐文件静态扫）。
 *   时间一律从入参取：`raw[].at | .ts | .time*1000`，兜底是 `batch.now`（也是注入的）。
 */
import { runBatch, ingestBatch, inspectBatch, evidenceFromRecord, SCENARIO_VERSION } from './evidence.js';

export { runBatch, ingestBatch, inspectBatch, evidenceFromRecord, SCENARIO_VERSION };

// —— 事实还原的零件（供排障/回放/单元测试；正常装配只需 ingestBatch）——
export {
  toSegments, parseCqString, decodeCqValue, renderText, collectMentions, collectMedia,
  collectRefs, normalizeMediaList, normalizeQuoteInfo, findReplySegment, isSelfId, normalizeId,
  shareCardText, MEDIA_TYPES
} from './segments.js';

// —— N-QUOTE-FALLBACK：引用兜底（零 import、IO 全注入；orchestrator 的 ingest 在
//    ingestBatch 之前调 prefetchQuoteFallback，resolveQuote 库 miss 时查它的 fallback 表）——
export {
  QUOTE_FALLBACK_TIMEOUT_MS, QUOTE_PLACEHOLDER, quoteKey, quoteInfoFromProtocol, replyIdsOf, resolvedQuoteIds,
  markUnresolvedReply, markUnresolvedReplyInString, prefetchQuoteFallback
} from './quote-fallback.js';

export { normalizeRaw, calledByName, calledBySelfId, stripQuotedBlocks, MAX_TEXT_CHARS, resolveTextLimit } from './inbound.js';
export { mergeRecords, resolveMergeOptions, MERGE_DEFAULTS } from './merge.js';
export { selectBotSaidBefore, normalizeBotSaid, selfCandidatesFromRaw, DEFAULT_BOT_SAID_LIMIT } from './bot-said.js';
export { ScenarioError, SCENARIO_ERROR_CODES } from './errors.js';

/** 模块自述（给第 3 批装配与 UI 排障看：这个模块到底承诺了什么）。 */
export const SCENARIO_INFO = Object.freeze({
  module: 'scenario',
  stage: 'A',
  version: SCENARIO_VERSION,
  entry: 'ingestBatch',
  produces: 'MessageEvidence[]',
  hardRules: Object.freeze([
    '只还原事实，不做推断',
    '引用内容不进 text（引用里的「我」不算当前说话人）',
    '图片内容不归因给发图人（media[] 无发送者字段）',
    'botSaidBefore 只收带 ok 回执的机器人消息',
    '规范化但不改写原文（只 trim / 拼接 / 非文本段占位符）',
    '同一输入 → 同一输出（无时钟、无随机）'
  ])
});

export default { ingestBatch, inspectBatch, evidenceFromRecord, SCENARIO_VERSION, SCENARIO_INFO };
