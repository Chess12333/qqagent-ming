/**
 * M6 memory —— 阶段 B（取回状态）/ 阶段 F（更新记忆）· **公开唯一出口**
 *
 * README §2 M6：**一个可追溯的证据账本 + 几个用途不同的视图**（不是互相争抢的"记忆类型"）。
 * 五层结构（09-27 方案第七节）：
 *   A 原始事件 → `store.js` 的 evidence.jsonl（只追加，能回原始证据）
 *   B 证据记录 → 同表（`sourceType`：自述/转述/引用/模型推测/机器人输出/工具确认）
 *   C 当前观察 → `observations.jsonl` 多版本（`supersedes` 链、反例、置信、有效期）
 *   D 对话状态 → 同表 `type:'topic'|'promise'|'question'|'recent'`（**短期状态不许混成稳定印象**）
 *   E 快速档案 → `brief()` / `cards()`（**只是视图，不是新事实源**；写入次数 ≠ 命中次数）
 *
 * 冻结接口（派单）：
 *   retrieve(ctx) / commit(observation, {idempotencyKey}) / forget(subjectId, {evidenceIds, scope}) / audit({chatKey, n})
 * 搬运层兼容面（README §3.5，**必须导出，不许改名**）：
 *   msgRef normalizeRef logMemoryChange readAuditLog
 *   ↑ platform/sender、media(image-lib/memes)、act(tools) 在用。
 *
 * ★ 不变量：每条写入必须带 `evidenceIds`；**没有证据不许写**；删来源要撤回依赖它的观察（留旧版）；
 *   duplicate/重试**不许**产生多份"独立支持"；范围规则**过滤在检索前**（见 scope.js）。
 * ★ 只 import `contracts/` + `node:`（M6 现在**零跨模块依赖**：dataDir 一律由调用方显式注入，
 *   不再问 `core/config-store` —— 它的懒加载会把生产 `data/` 喂回来，见 data-dir.js 顶部复盘）。
 *   ★ **唯一例外**（2026-10-13 双人格记忆隔离）：`emotion/persona-hygiene.js` 的可见性判据 ——
 *   零依赖纯函数，且指挥位定的硬约束是"全树只许这一份实现"（compose / prompt / memory 三侧
 *   import 同一个符号），各模块自取状态或自写判据都算违规。除它之外仍然不碰别的模块。
 */
import { validateMemoryObservation, SCHEMA_VERSION } from '../../contracts/index.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { selfRowVisibleNow } from '../emotion/persona-hygiene.js';
import { setDataDir, getDataDir, memoryDir } from './data-dir.js';
import {
  openStore, closeStore, ingestEvidence, normalizeEvidence, hasEvidence, getEvidence,
  writeObservation, retract, activeObservations, versionsOf, claimKeyOf,
  bumpHit, cardRows, changeRows, orphanHitCount, OBS_TYPES, SELF_SOURCE_TYPES,
  getSubjectName, setSubjectName, readSubjects, removeSubjectName,
} from './store.js';
import { partitionByScope, requestedScope, visibleIn, chatScope, SCOPES } from './scope.js';
// ①（2026-10-14 派单·状态话题时效）：短期状态条目的年龄口径。判据与配置键的语义对齐都写在那份文件头。
import { resolveWorking, setWorking, shortTermAgeVerdict, halfLifeFor, topicOverlap, isShortTermType, saveCrossTurn, renderCrossTurn } from './working-window.js';
import { notifyObservationChange } from './observation-events.js';
// P0-3（功能表 5 · 2026-10-11）：forget 撤回成功后写来源抑制 —— 下面那块 `export … from`
// 只是**再导出**（不产生本地绑定），这里要调 `addSuppression()`，所以必须单独 import。
// M6 读点②（2026-10-14）：`retrieve()` 也要按抑制账本收口，所以一并 import 判据。
import { addSuppression, namedSuppressedEvidenceIds, namesSuppressedSource, suppressionTable, ledgerHealthOf } from './suppressions.js';
// 2026-10-11（A5 方案 a）：跨会话共享的授权记录表（`impression-share.jsonl`）。
//   下面的读取接口会合并它；授权与回收只能通过 `setImpressionShare()`，由管理侧操作，模型无法调用。
import { shareLedger, resolveShare, cardIdOf } from './impression-share.js';
// ★ 2026-10-16（用户：删掉的印象还能查到）：召回条目形状归一 —— 关键词腿与语义腿共用这一份
//   （语义腿原先只有 personId、没有 subjectId/type ⇒ 按人注入与按主体过滤都拿不到主体）。
import { recallItemShape } from './recall-item.js';
// ★ 手工编辑保护锁（老树 src/memory.js:1785-1851 的搬运）：内容/态度真变更才打锁。
import { writeManualEditLock, isManuallyEdited, filterLockedSubjects, getLockWindowMs } from './manual-edit-lock.js';
export { writeManualEditLock, isManuallyEdited, filterLockedSubjects, getLockWindowMs };
// M2（2026-10-14 · §6.3 第 5 条）：读出口一律带 coverage，形状只在 `coverage.js` 写一份。
import { buildCoverage } from './coverage.js';
import { searchChatMessages as searchChatMessagesImpl } from './chat-search.js';
import { inspectEpisodeRows, cachedEpisodeRows } from './episode-store.js';
// ★ 2026-10-15（一键清理三动作）：候选规划做成**纯函数**放这里，执行仍在下方 `cleanupAll`（只有这里握 store）。
//   契约来源见模块头：aaf16f9c 两份回执（缺口 + 事务边界）；只走 retract/commit，不直删文件。
import { CLEANUP_LIMITS, planContainmentPairs, planSemanticPairs, planTypeRefinements, surveyTypeRefinement, isCleanupImpression } from './cleanup-actions.js';
// 类型升级的勘测用老树逐字正则（`prompt-format.js:47`）、门的答案按老树 6 类白名单校验（IMP_TYPES）；
// 上面那行 `export {…} from` 是**再导出**，不产生本地绑定 ⇒ 本文件要用必须单独 import。
import { guessImpressionType, IMP_TYPES } from './prompt-format.js';

// ── 搬运层兼容面（§3.5 冻结） ─────────────────────────────────────────────
export { msgRef, normalizeRef } from './msg-ref.js';
export { logMemoryChange, readAuditLog } from './memory-audit.js';
export { setDataDir, getDataDir, memoryDir } from './data-dir.js';
export { SCOPES, OBS_TYPES, SCHEMA_VERSION };

// ── 聊天存档（旧 src/store.js 的 ChatStore） ────────────────────────────────
// ⚠ 与上面的 './store.js' **不是同一个东西**：那是证据账本（evidence/observations），
//   这份是原始聊天存档（<dataDir>/messages + messages-cold 的冷热分层）。
export {
  ChatStore, createChatStore, readAllMessages, quoteAuthorLabel,
  messagesDir, coldDir, COLD_CHUNK, DEFAULT_HOT_PER_CHAT
} from './chat-store.js';
// 提示词冷/热切点的会话内粘滞值（存取归本模块，判据归装配层 `compose.js`）：装配层只调这两个函数，不自己开文件。
export { readHistoryCut, writeHistoryCut, historyCutDir, historyCutFile, HISTORY_CUT_SCHEMA_VERSION } from './history-cut.js';
// coverage 的形状与校验（§6.2 七键）：面板/自测拿键名与合法取值，不各自抄一份。
export { buildCoverage, COVERAGE_KEYS, COVERAGE_STATES, COVERAGE_GENERATION_STATES } from './coverage.js';
export {
  listArchiveChatKeys, listArchiveDays, listArchiveHours, loadArchive,
  loadArchiveDay, loadArchiveContextAround, countArchiveMatches,
} from './archive-view.js';

// ★ 2026-10-05 补（sb2 端到端点名 + 指挥位复核）：`modules/memory/todos.js` 早就在，但**一直没从本文件导出**
//   ⇒ 装配层那句 `typeof memoryMod.createTodos === 'function'` 恒 false ⇒ `ctx.modules.memory.todos` 挂不上
//   ⇒ `memory_todo_save` / `memory_todo_done` 两个工具卡在"依赖未就绪"。这一行就是那唯一的缺口。
export { createTodos } from './todos.js';

// ★ M-1 / MS1 记忆语义召回出口
export {
  observationToRecords, scopeFilter, indexRecords, normalizeScope,
  semanticRetrieve, mergeWithKeyword, createSemanticIndex,
  ingestObservations, removeSemanticRecords, rebuildSemanticIndex,
  createMemorySemanticRecall
} from './semantic.js';
export { createMemoryCoordinator } from './coordinator.js';
// ★ 2026-10-16（JEV 同一次判 · 按需消费可选记忆）：`memoryPolicy` 的归一与词表从公开出口出，
//   判据侧（ds3）与执行侧共用同一份；`recallItemShape` 也透出，便于桥接/自测对齐两腿形状。
export { normalizeMemoryPolicy, MEMORY_POLICY_MODES } from './coordinator.js';
export { recallItemShape } from './recall-item.js';
export { createMemoryExtractor } from './extractor.js';

// ★★ N34 方案 §4.3/§5.4：遗忘抑制账本（`memory/suppressions.jsonl`）。
//   没有它，遗忘是**假的** —— 后台整理扫旧消息会把用户忘掉的事实复活。
export {
  addSuppression, isSuppressed, makeSuppressionFilter,
  namedSuppressedEvidenceIds, namesSuppressedSource,
  suppressionTable, suppressionStats, listSuppressions, reinstate,
  // ★ 2026-10-17：读腿要能问"这道抑制过滤**能不能信**"，而不是靠"集合空不空"去猜。
  ledgerHealthOf, suppressionLedgerHealth,
} from './suppressions.js';

// ★ 2026-10-16（遗忘边界 · 历史读侧）：存档行口径的"被点名遗忘"过滤器（每轮现取，别缓存）。
//   与 `chat-search.js` 的检索出口共用同一份映射/判定；orchestrator 的历史读侧
//   （`compose.js readPastChatHistory`）用它在**出模前**收掉 `forget()` 点名的来源 ——
//   存档行不随遗忘消失，这一条腿此前没有任何读侧判据。
export { namedSourceSuppressionFilter } from './chat-search.js';

// A5 方案 a：跨会话共享的授权记录表（管理侧逐条批准，读取侧合并，回收也写这里）。
//   · `listShareableImpressions()` = 待授权清单（不返回证据编号、不返回来源会话），给管理端点读
//   · `setImpressionShare()` = 授权 / 回收；不合格或不存在的记录一律返回明确失败原因，且不写入账本
//   这两个出口只给管理端点（mimo2）用；`modules/act/**` 的任何工具都不引用本模块。
export {
  shareLedger, resolveShare, setImpressionShare, listShareableImpressions,
} from './impression-share.js';

// ★★ 票 N30：老树 `formatForPrompt` 的【印象】注入格式（照搬）。
//   用户 2026-10-09 原话：「干脆就严格按照老树的格式注入来得了」。
//   本模块**不自己读数据文件**：吃调用方聚合好的 `people`，产 `【印象】…` + `（态度）…` 两段。
//   ★ 接线在 `modules/prompt/**`（别人域）：`renderMemoryView` 仍保留，两个都在。
export {
  formatForPrompt, createFavorSuggestionQueue,
  favorTierInfo, favorFavTag, favorToneHint, favorWhyLine, favorSuggestionLine,
  impressionRecency, impressionRankTime, rankImpressions, ageLabel,
  guessImpressionType, IMP_TYPES, IMP_TYPE_LABEL, FAVOR_REASON_TTL_MS
} from './prompt-format.js';

// ★ 表层近况 surface（老树 src/memory.js captureSurface + half-life 的搬运）：
//   正则捕获 + 半衰衰减 + 按 (person, chat, kind) 槽位；`clearSurface` 一并清它。
export {
  captureSurface, liveSurface, liveSurfaceByChat, markSurfaceShown,
  pruneSurface, clearSurfaceFor
} from './surface.js';

// ★ 语义卡（老树 src/conversation-memory/semantic-cards.js 的搬运）：
//   启发式生产 + 持久化 + 关键词匹配 + prompt 注入。JEV 路径不搬（已退役）。
export { SemanticCardStore, cardWorthy, filterFreshCards, renderSemanticCardsInject } from './semantic-cards.js';

let personaTwoDetector = null;
let memoryHygiene = {};

/**
 * 显式指定数据目录（装配层/测试用；不调用则自动解析，见 data-dir.js）。
 *
 * ★ 双人格记忆隔离（2026-10-13 接线）：这里同时接收**在位人格的探针**与两个可见性开关。
 *   判据本身不在本模块 —— 全树只有 `modules/emotion/persona-hygiene.js` 那一份实现。
 *   不给探针 ⇒ 按第一人格在位（隐去带 `persona2` 标的行），存量无标行一条不少。
 *   接线位置：`apps/server/assembly.js`（luna2 域）已经握着 `isPersonaTwo`，
 *   只需在 `memory.configure({ dataDir })` 那行加 `isPersonaTwo`（见 2026-10-13 回执的接线请求）。
 */
export function configure({ dataDir, isPersonaTwo, memoryHygiene: hygiene, working } = {}) {
  if (isPersonaTwo !== undefined) personaTwoDetector = typeof isPersonaTwo === 'function' ? isPersonaTwo : null;
  if (hygiene !== undefined) memoryHygiene = hygiene && typeof hygiene === 'object' && !Array.isArray(hygiene) ? hygiene : {};
  // ① 年龄闸的配置入口（本模块不 import config-store，见 `working-window.js` 头）。
  //   接受配置对象或返回它的零参函数；传 null = 清掉注入、回到缺省。
  if (working !== undefined) setWorking(working);
  return { dataDir: setDataDir(dataDir ?? null) };
}

/** 单独注入年龄口径（没走 configure 时用；传 null 撤销）。语义与形状见 `working-window.js`。 */
export function setWorkingWindow(working) {
  return setWorking(working ?? null);
}

// ★ 跨轮工作记忆（老树 src/conversation-memory/cross-turn.js 的搬运）：
//   生成（saveCrossTurn）在 compose 运行结束后调；消费（renderCrossTurn）在 prompt 组装前调。
//   配置 `api.architecture.crossTurnWorking` 总开关 + ttl/decay/maxChars 从 `working` 取。
export { saveCrossTurn, renderCrossTurn };

/** 单独注入在位人格探针（装配层没走 configure 时用；传非函数即撤销注入）。 */
export function setPersonaTwoDetector(fn) {
  personaTwoDetector = typeof fn === 'function' ? fn : null;
}

/** 此刻谁在位：探针缺失或抛错 ⇒ 按第一人格（不放宽隔离）。 */
function personaTwoNow() {
  if (typeof personaTwoDetector !== 'function') return false;
  try { return personaTwoDetector() === true; } catch { return false; }
}

/** 装配层注入的在位人格与可见性开关（同模块的 coordinator 也从这里取，避免两处各读一份配置）。 */
export function personaContext() {
  return { personaTwo: personaTwoNow(), hygiene: memoryHygiene };
}

/**
 * 这条**记忆记录**当前在位人格该不该看见。
 * 观察行没有 `self` 字段（它本来就是"我记下的东西"）⇒ 按"自己的行"交给同一个判据；
 * 无 `persona2` 标 = 第一人格写的 ⇒ 第一人格在位时与改动前逐字节一致（存量零迁移）；
 *   红在位时这类行是否隐去，由 `hideFirstPersonaHistory` 决定（defaults 为 true ⇒ 两个方向都隔离）。
 * ★ 判据不在此处：只有 `selfRowVisibleNow` 那一份，别在这里加任何分支。
 */
export function observationVisibleToPersona(row, personaTwo = personaTwoNow(), hygiene = memoryHygiene) {
  return selfRowVisibleNow({ self: true, persona2: row?.persona2 === true }, { personaTwo, hygiene });
}

/**
 * 这条**证据账本行**当前在位人格该不该看见（后台整理的输入走这里，见 `coordinator.collectSources`）。
 * 机器人自己说的话在入账时就带了 `self: true`（`store.js` 的 `SELF_SOURCE_TYPES`），
 * 群友的行没有这个键 ⇒ 恒可见；存量行也没有 ⇒ 一条不少（零迁移）。
 * ★ 本函数只做"证据行的字段 → 判据入参"的形状映射，判据仍然只有 `selfRowVisibleNow` 那一份。
 */
export function evidenceVisibleToPersona(row, personaTwo = personaTwoNow(), hygiene = memoryHygiene) {
  return selfRowVisibleNow({ self: row?.self === true, persona2: row?.persona2 === true }, { personaTwo, hygiene });
}

/** 解析本次调用要用的数据目录（display 用途：让调用方/测试能断言没在碰真实 data/）。 */
function dirOf(v) {
  return typeof v === 'string' && v ? v : getDataDir();
}

let seq = 0;
function autoId(prefix) {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/** 短哈希（证据编号用：正文可以带空格/冒号/中文，不能直接拼进 id）。 */
function hashOf(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 12);
}

// ═════════════════════════════════════════════════════════════════════════
// A/B：证据入账
// ═════════════════════════════════════════════════════════════════════════

/**
 * 把原始事件（MessageEvidence 形状 / 工具回执）追加进证据账本。
 * 重复 id 不重复写；非法证据**拒收并回错误**（不许静默放过）。
 * ★ 机器人自己的行按**写入时刻在位的人格**自动打归属标（打标不拦，见 `store.js`）。
 */
export async function recordEvidence(evidence, { dataDir } = {}) {
  const st = openStore(dirOf(dataDir));
  const one = Array.isArray(evidence) ? evidence : [evidence];
  const res = ingestEvidence(st, one, { persona2: personaTwoNow() });
  return {
    ok: res.invalid.length === 0,
    added: res.added,
    duplicate: res.duplicate,
    invalid: res.invalid,
    dataDir: st.dataDir,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// F：写一条观察
// ═════════════════════════════════════════════════════════════════════════

/**
 * 写入（幂等；**必须带 evidenceIds**）。
 *
 * @param {object} observation  MemoryObservation（contracts §3.1）
 *   { id?, subjectId, claim, evidenceIds:[...], scope:'group'|'private'|'global', confidence, at?,
 *     supersedes?, type?, chatKey?, kind?, counterEvidenceIds?, validUntil?, crossChatShareable? }
 *   `id` / `at` 缺省时**自动补**（身份与时间戳，不算放宽校验）；其余字段一律严格校验。
 *   `crossChatShareable:true` 只可用于脱离原文的 global 人物印象；默认关闭。
 * @param {object} opts
 *   · `idempotencyKey`：重试/重复回调必须幂等 —— 同一个 key 第二次调用**不再写数据文件**，回第一次的结果（`replay:true`）
 *   · `dataDir`：显式数据目录（测试只许传 `.tmp-refactor/` 下的目录）
 *   · `evidence`：可选的原始事件数组 —— **F 阶段"证据 + 观察一起提交"**（入账归 commit；
 *     `retrieve` 只允许写命中统计，不许写证据/观察/修订 —— 指挥位 2026-10-04 的第 3 条决定）
 *   · `allowUnregisteredEvidence`：默认 false。true 时允许引用"还没入账"的证据 ID，但会记进
 *     `unregisteredEvidence` 并写进变更审计（默认**拒**，因为"没有证据不许写"）
 *   · `persona2`：双人格归属标（默认不给 = 按写入时刻在位的人格自动打；显式 true/false 以显式值为准）。
 *     **只打标、不拦写**（2026-10-13 裁定）：读侧据此对另一人格隐去这条经历。
 * @returns {{ok:boolean, errors?:string[], id?:string, duplicate?:boolean, version?:number,
 *            supportCount?:number, writes?:number, replay?:boolean, dataDir?:string}}
 */
export async function commit(observation, opts = {}) {
  const {
    idempotencyKey = '', dataDir, counterEvidenceIds = [], type, chatKey, kind,
    validUntil, allowUnregisteredEvidence = false, evidence = null, persona2 = null,
  } = opts;
  const st = openStore(dirOf(dataDir));
  // ★ 归属标先算一次，**证据行与观察行用同一个标**（显式 true/false 以显式值为准，不给就按写入时刻在位的人自动打）。
  //   标不合法（非 boolean）时证据仍按在位状态打标：打标不拦，这条经历不许丢。
  const personaTag = typeof persona2 === 'boolean' ? persona2 : personaTwoNow();
  const ingestedEvidence = ingestEvidence(st, evidence || [], { persona2: personaTag });

  const input = { ...(observation || {}) };
  if (!input.id) input.id = autoId('obs');
  if (!Number.isFinite(Number(input.at))) input.at = Date.now();
  input.at = Number(input.at);
  if (type && input.type === undefined) input.type = type;
  if (validUntil !== undefined && input.validUntil === undefined) input.validUntil = validUntil;
  if (chatKey !== undefined && input.chatKey === undefined) input.chatKey = chatKey;
  if (kind !== undefined && input.kind === undefined) input.kind = kind;
  if (counterEvidenceIds.length && input.counterEvidenceIds === undefined) input.counterEvidenceIds = counterEvidenceIds;
  // ★ 写侧打标（2026-10-13 裁定：**打标不拦**；用户同日拍板：一律隔离）——
  //   红人格期间写下的观察**照写**（拦=丢经历），但记下"这是谁的经历"，读侧据此过滤。
  //   口径与 `chat-store.appendSelf` 一致：不显式给就按写入时刻在位的人自动打；显式 true/false 以显式值为准。
  //   只有 true 才落键（无标 = 第一人格），存量数据因此一个字节都不变。
  if (persona2 !== null && typeof persona2 !== 'boolean') {
    return {
      ok: false,
      errors: ['persona2: 只接受 true / false / 不给（不给=按写入时刻在位状态自动打标）'],
      id: input.id,
      dataDir: st.dataDir
    };
  }
  if (personaTag === true) input.persona2 = true;

  // scope ↔ chatKey / kind 的一致性（范围规则的落地前提）
  const errors = [...validateMemoryObservation(input).errors];
  if (SCOPES.includes(input.scope)) {
    if (input.scope !== 'global' && !String(input.chatKey ?? '')) {
      errors.push('chatKey: 非 global 的观察必须带 chatKey（否则范围规则无从落地）');
    }
    if (input.kind === undefined || input.kind === null) {
      input.kind = input.scope === 'private' ? 'private' : 'group';
    } else if (input.scope === 'private' && input.kind !== 'private') {
      errors.push("kind: scope='private' 的观察 kind 必须是 'private'");
    } else if (input.scope === 'group' && input.kind !== 'group') {
      errors.push("kind: scope='group' 的观察 kind 必须是 'group'");
    }
  }
  if (input.crossChatShareable !== undefined && typeof input.crossChatShareable !== 'boolean') {
    errors.push('crossChatShareable: 必须是 boolean');
  }
  if (input.crossChatShareable === true && (input.scope !== 'global' || input.type !== 'impression')) {
    errors.push("crossChatShareable: 仅允许显式 type='impression' 且 scope='global' 的观察");
  }
  // 证据必须在账本里（可显式放开，但会留痕）
  const unregistered = [];
  if (Array.isArray(input.evidenceIds)) {
    for (const id of input.evidenceIds) {
      if (typeof id === 'string' && id && !hasEvidence(st, id)) unregistered.push(id);
    }
    if (unregistered.length && !allowUnregisteredEvidence) {
      errors.push(`evidenceIds: 证据不在账本里（先用 recordEvidence 入账，或显式 allowUnregisteredEvidence）：${unregistered.join(',')}`);
    }
  }
  if (errors.length) return { ok: false, errors, id: input.id, dataDir: st.dataDir, ingestedEvidence };

  const result = await writeObservation(st, {
    ...input,
    counterEvidenceIds: input.counterEvidenceIds ?? [],
    unregisteredEvidence: unregistered,
  }, { idempotencyKey: String(idempotencyKey || '') });

  if (result?.ok === true && result.duplicate !== true && result.replay !== true) {
    notifyObservationChange(st.dataDir, { action: 'commit', id: String(result.id ?? input.id) });
  }

  return { ...result, unregisteredEvidence: unregistered, ingestedEvidence, dataDir: st.dataDir };
}

// ═════════════════════════════════════════════════════════════════════════
// B：取回（过滤发生在**检索前**）
// ═════════════════════════════════════════════════════════════════════════

const DAY = 24 * 60 * 60 * 1000;
const HALF_LIFE = 7 * DAY;

// `topicOverlap` 已挪到 `working-window.js`（2026-10-14 ①）：年龄闸判要它，打分也要它，
// 两处各留一份就会漂出两种"命中"。下面 retrieve 的打分用的是 import 进来的那一份。

function readMeta({ complete = null, truncatedCount = null, scannedCount = null,
  limitNum = null, limitSource = null, personaTwo } = {}) {
  return {
    complete,
    truncatedCount,
    scannedCount,
    limitNum,
    limitSource,
    ...(typeof personaTwo === 'boolean' ? { personaTwo } : {}),
  };
}

function searchResultWithMeta(result, args) {
  const options = args?.options && typeof args.options === 'object' && !Array.isArray(args.options)
    ? args.options : {};
  const limitNum = Math.max(1, Math.min(8, Math.floor(Number(options.limit) || 8)));
  const limitSource = options.limit === undefined ? 'default' : 'options.limit';
  const items = Array.isArray(result?.items) ? result.items : null;
  const total = typeof result?.total === 'number' && Number.isFinite(result.total) ? result.total : null;
  const state = result?.coverage?.state;
  const meta = readMeta({
    complete: state === 'complete' ? true : state === 'partial' ? false : null,
    truncatedCount: items && total !== null ? Math.max(0, total - items.length) : null,
    scannedCount: typeof result?.scanned === 'number' && Number.isFinite(result.scanned) ? result.scanned : null,
    limitNum,
    limitSource,
    personaTwo: options.personaTwo === true,
  });
  const chatKey = String(options.chatKey ?? '').trim();
  const validChatKey = /^(?:group|private):[A-Za-z0-9_-]{1,64}$/.test(chatKey);
  const denied = result?.status === 400 && !validChatKey;
  return {
    ...result,
    ...(denied ? {
      dropped: [{ reason: 'permission:explicit-chat-scope-required' }],
      ignored: ['chatKey 必须是一个明确的 group:<id> 或 private:<id> 范围'],
    } : {}),
    _meta: meta,
  };
}

function additiveReadResult(result, { limitNum = null, limitSource = null, scannedCount = null,
  complete = null, truncatedCount = null } = {}) {
  const value = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  const items = Array.isArray(value.items) ? value.items : [];
  const scanned = scannedCount === null || scannedCount === undefined ? null : Number(scannedCount);
  return {
    ...value,
    items,
    dropped: Array.isArray(value.dropped) ? value.dropped : [],
    ignored: Array.isArray(value.ignored) ? value.ignored : [],
    _meta: readMeta({
      complete,
      truncatedCount,
      scannedCount: Number.isFinite(scanned) ? scanned : null,
      limitNum,
      limitSource,
    }),
  };
}

/**
 * One read entrance for memory retrieval paths. Existing route fields retain
 * their original values and failure behavior; `_meta` and denial diagnostics
 * are additive. The public legacy functions remain compatibility adapters.
 *
 * @param {{route:string,input?:object}} request
 *   Search routes retain their legacy inputs; model-path routes receive their
 *   prior provider and options without changing the provider's query behavior.
 */
export function readMemory({ route, input } = {}) {
  switch (route) {
    case 'retrieve':
      return retrieveObservations(input);
    case 'searchChatMessages': {
      const args = input ?? {};
      return searchResultWithMeta(searchChatMessagesImpl(args.query, args.options), args);
    }
    case 'retrieveCrossChatImpressions':
      return retrieveCrossChatImpressionsImpl(input);
    case 'activeTodos': {
      const args = input ?? {};
      const items = args.todos.activeTodos(args.options);
      return additiveReadResult({ items }, {
        complete: null,
        limitNum: args.options?.limit ?? null,
        limitSource: args.options?.limit === undefined ? null : 'input.options.limit',
      });
    }
    case 'episodes': {
      // ★ 2026-10-17：stat 快照读（文件没动就复用上次解析）—— prepareContext/status 每轮走这里，
      //   不再每次整体重读 episodes.jsonl；行序与坏行口径与 `inspectEpisodeRows` 完全一致。
      const items = cachedEpisodeRows(input?.dataDir).rows ?? [];
      return additiveReadResult({ items }, { scannedCount: items.length });
    }
    case 'semanticCandidates': {
      const args = input ?? {};
      const options = args.options ?? {};
      const result = args.semantic.retrieve(options);
      const addMeta = (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const meta = readMeta({
          // Semantic status reports index health, not whether the topK window covered every candidate.
          complete: null,
          truncatedCount: null,
          scannedCount: value.scanned === null || value.scanned === undefined || !Number.isFinite(Number(value.scanned))
            ? null : Number(value.scanned),
          limitNum: options.topK ?? null,
          limitSource: options.topK === undefined ? null : 'input.options.topK',
        });
        const hasMeta = Object.prototype.hasOwnProperty.call(value, '_meta');
        return {
          ...value,
          ...(!Object.prototype.hasOwnProperty.call(value, 'dropped') ? { dropped: [] } : {}),
          ...(!Object.prototype.hasOwnProperty.call(value, 'ignored') ? { ignored: [] } : {}),
          ...(!hasMeta ? { _meta: meta } : {}),
        };
      };
      return result && typeof result.then === 'function' ? result.then(addMeta) : addMeta(result);
    }
    case 'history': {
      const result = history(input ?? {});
      const versions = Array.isArray(result?.versions) ? result.versions : [];
      return {
        ...result,
        items: versions,
        dropped: [],
        ignored: [],
        _meta: readMeta({ complete: true, truncatedCount: 0, scannedCount: versions.length }),
      };
    }
    case 'sendForwardArchive': {
      const args = input ?? {};
      const raw = args.store.recent(args.sourceChatKey, { limit: Math.min(200, args.limit * 8) });
      const makeResult = (recentRows) => {
        const recent = recentRows || [];
        const items = recent.filter((message) => {
          const text = String(message.text || '').trim();
          if (!text || /^\[合并转发聊天记录\]$/.test(text)) return false;
          return !args.query || text.toLowerCase().includes(args.query);
        }).slice(-args.limit);
        return additiveReadResult({ items }, {
          scannedCount: Array.isArray(recent) ? recent.length : null,
          limitNum: args.limit,
          limitSource: 'input.limit',
        });
      };
      return raw && typeof raw.then === 'function' ? raw.then(makeResult) : makeResult(raw);
    }
    default:
      throw new TypeError(`memory-read-route-not-supported:${String(route ?? '')}`);
  }
}

/** Compatibility adapter; preserves the original Promise and result shape. */
export function retrieve(ctx = {}) {
  return readMemory({ route: 'retrieve', input: ctx });
}

/** Compatibility adapter; remains synchronous and preserves the original result shape. */
export function searchChatMessages(query, options = {}) {
  return readMemory({ route: 'searchChatMessages', input: { query, options } });
}

/** Compatibility adapter; preserves the original Promise and result shape. */
export function retrieveCrossChatImpressions(ctx = {}) {
  return readMemory({ route: 'retrieveCrossChatImpressions', input: ctx });
}

/**
 * 取回状态（阶段 B）。
 *
 * @param {object} ctx
 *   `{chatKey, kind:'group'|'private', evidence:[MessageEvidence], topic, senderId, need}
 *    need = { subjectIds?, types?, scope?, minConfidence?, limit? }`
 *   · `ctx.working` 年龄口径由 `working-window.js` 统一解析，调用上下文可优先覆盖。
 *   · `ctx.evidence` 只作线索，不写证据/观察/修订；
 *   · `need.scope` / `need.chatKey` 只能收窄范围，越界请求记入 `ignored[]`；
 *   · 范围过滤在打分前执行，被排除项进入 `dropped` 且不带 claim 正文。
 * @returns {{items:Array, dropped:Array, provided:object, ignored:string[], scanned:number, dataDir:string}}
 *   item 保留旧键，并含兼容的记忆 ID、主体 ID、来源、原因与得分字段。
 */
async function retrieveObservations(ctx = {}) {
  const st = openStore(dirOf(ctx.dataDir));
  const now = Number.isFinite(Number(ctx.now)) ? Number(ctx.now) : Date.now();
  const need = ctx.need && typeof ctx.need === 'object' ? ctx.need : {};
  const requestedLimit = need.limit ?? ctx.limit ?? 8;
  const limitSource = need.limit != null ? 'need.limit' : ctx.limit != null ? 'ctx.limit' : 'default';

  // ① 本轮证据**只看不写**（纯归一化，用来告诉调用方"哪些还没入账"；写入走 recordEvidence/commit）
  const provided = { valid: [], invalid: [], unknown: [], persisted: false };
  for (const item of ctx.evidence || []) {
    const norm = normalizeEvidence(item, { chatKey: ctx.chatKey, kind: ctx.kind });
    if (!norm.ok) { provided.invalid.push({ id: String(item?.id ?? ''), error: norm.error }); continue; }
    provided.valid.push(norm.row.id);
    if (!hasEvidence(st, norm.row.id)) provided.unknown.push(norm.row.id);
  }

  // ② 候选 = 当前有效观察（C 稳定认识 + D 短期状态）
  //   ★ 双人格隔离：另一人格写下的观察**不进候选**（在位状态由调用方 ctx.personaTwo 覆盖，
  //     没给就用装配层注入的探针；判据仍是 emotion/persona-hygiene.js 那一份）。
  const personaTwo = typeof ctx.personaTwo === 'boolean' ? ctx.personaTwo : personaTwoNow();
  const hygiene = ctx.memoryHygiene && typeof ctx.memoryHygiene === 'object' && !Array.isArray(ctx.memoryHygiene)
    ? ctx.memoryHygiene : memoryHygiene;
  const live = activeObservations(st).filter(r => r.validUntil === null || r.validUntil === undefined || Number(r.validUntil) >= now);
  const personaVisible = live.filter((row) => observationVisibleToPersona(row, personaTwo, hygiene));
  const personaHiddenRows = live.length - personaVisible.length;
  const all = personaVisible;

  // ③ need.scope 收窄（合法；放宽的请求已被 requestedScope 拦掉）
  const { scope: reqScope, ignored } = requestedScope(ctx);
  const narrowed = reqScope ? all.filter((r) => r.scope === reqScope) : all;

  // ④ **范围过滤在检索前**（打分只看得见的候选）
  const { visible, dropped } = partitionByScope(narrowed, ctx);

  // ④a ★ M3：scope=global 只是数据范围标签，不代表当前调用已获跨群授权。
  //   `partitionByScope` 先要求显式 crossChat/personId；这里再核验每张印象卡的最新共享账本。
  //   shared:false 优先覆盖旧行标，避免撤权后通用 retrieve 仍把同一条全局印象送进上下文。
  let crossChatShareTable = null;
  const authorizedVisible = visible.filter((row) => {
    if (row.scope !== 'global') return true;
    if (row.type !== 'impression') {
      dropped.push({ id: row.id, subjectId: row.subjectId, scope: row.scope,
        reason: 'scope:cross-chat-type-not-shareable' });
      return false;
    }
    if (!crossChatShareTable) crossChatShareTable = shareLedger({ dataDir: st.dataDir }).table;
    if (!resolveShare(row, crossChatShareTable, cardIdOf(row))) {
      dropped.push({ id: row.id, subjectId: row.subjectId, scope: row.scope,
        reason: 'scope:cross-chat-share-not-granted' });
      return false;
    }
    return true;
  });

  // ④b ★ M6 读点②（2026-10-14）：**来源被点名字忘掉的观察不进候选**。
  //   `forget()` 只撤回"当时点名那条证据撑起来的行"；同一来源被别的入口（面板 / 管理端 /
  //   重新整理）再写成一行、或它本身没被撤回，改前照常回到提示词 ⇒ "说忘掉的又说回来"。
  //   判据不在此处重写：与语义那条腿（`coordinator.js recallWithSemantic`）、关键词检索
  //   （`chat-search.js`）共用 `suppressions.js namedSuppressedEvidenceIds`。
  //   ★ **只比编号**，不用 `isSuppressed` 的 [from, ∞) 窗口 —— 窗口按 (会话, 发言人) 封人，
  //     读侧照抄会连坐没被忘的旧内容（`coordinator.selftest.mjs:172` 钉这条边界）。
  //   编号在账本里查不到证据行也放行：判不了 ≠ 已抑制。
  const namedSuppressed = namedSuppressedEvidenceIds({ dataDir: st.dataDir });
  // ★ 2026-10-17（安全审查 · 读侧 fail-closed）：账本读不全时，空集合在上游语义上等于
  //   "谁都没被遗忘" —— 那正是本条判据要防的事本身。故读不全 ⇒ 这批观察**一条都不进候选**，
  //   并按 `suppression:ledger-unreadable:<原因>` 如实记账（dropped 只带元信息，不含正文）。
  //   正常可读时逐字保持原口径（含 `size===0` 直接放行的短路）。
  const suppressionHealth = ledgerHealthOf(namedSuppressed);
  const ledgerSick = suppressionHealth.ok === false;
  let suppressionDropped = 0;
  const unsuppressed = authorizedVisible.filter((row) => {
    if (ledgerSick) {
      suppressionDropped += 1;
      dropped.push({
        id: row.id, subjectId: row.subjectId, scope: row.scope,
        reason: `suppression:ledger-unreadable:${suppressionHealth.reason || 'unknown'}`
      });
      return false;
    }
    if (namedSuppressed.size === 0) return true;
    if (!namesSuppressedSource(row.evidenceIds, namedSuppressed)) return true;
    suppressionDropped += 1;
    dropped.push({ id: row.id, subjectId: row.subjectId, scope: row.scope, reason: 'suppression:named-source' });
    return false;
  });

  // ⑤ need 过滤（收窄；不匹配的进 dropped，只带元信息）
  const subjectIds = Array.isArray(need.subjectIds) ? need.subjectIds.map(String) : null;
  const types = Array.isArray(need.types) ? need.types.map(String) : null;
  const minConfidence = Number.isFinite(Number(need.minConfidence)) ? Number(need.minConfidence) : null;

  const candidates = [];
  for (const row of unsuppressed) {
    if (subjectIds && subjectIds.length && !subjectIds.includes(String(row.subjectId))) {
      dropped.push({ id: row.id, subjectId: row.subjectId, scope: row.scope, reason: 'need:subject-mismatch' });
      continue;
    }
    if (types && types.length && !types.includes(String(row.type))) {
      dropped.push({ id: row.id, subjectId: row.subjectId, scope: row.scope, reason: 'need:type-mismatch' });
      continue;
    }
    if (minConfidence !== null && Number(row.confidence) < minConfidence) {
      dropped.push({ id: row.id, subjectId: row.subjectId, scope: row.scope, reason: 'need:below-minConfidence' });
      continue;
    }
    candidates.push(row);
  }

  // ⑤b ★ 年龄闸（2026-10-14 派单 · 形状①「状态话题超期」）。
  //   只管 D 层短期状态（`topic/promise/question/recent`）：超过 `api.architecture.workingTtlMin` 的条目，
  //   本轮话题没命中就不进上下文 —— 这正是"把 40 分钟前已经翻篇的话当成还在等回应"那条形状在取回端的来源。
  //   C 层稳定认识不吃这个期限（为什么不把 90 分钟套到长期印象上，见 `working-window.js` 文件头）。
  //   拦下的行只进 `dropped`（编号 + 原因，**不带正文**），账本一个字不动：下一轮话题命中照样取回。
  //   ★ 这里不统计"这条递给过模型几次"：那套计数归 mimo1 在身体状态那条路上做，两处各做一套就会互相不知情。
  const working = resolveWorking(ctx.working);
  const pool = [];
  let workingExpired = 0;
  let workingRescued = 0;
  for (const row of candidates) {
    const verdict = shortTermAgeVerdict({ row, now, working, topic: ctx.topic });
    if (verdict.blocked) {
      workingExpired += 1;
      dropped.push({ id: row.id, subjectId: row.subjectId, scope: row.scope, reason: verdict.reason });
      continue;
    }
    if (verdict.reason) workingRescued += 1;      // 超期但话题命中 ⇒ 放行（计数给排障看，不静默）
    pool.push({ row, topic: verdict.topicScore });
  }

  // ⑥ 打分：近况 + 置信 + 话题命中 + 当前说话人加成（同分按时间/ID 稳定排序）
  //   ★ recency 的半衰期分两层（① 的后一半，对应 `workingDecayMin`）：短期状态按配置的衰减周期，
  //     C 层仍是 7 天。**权重系数一个都没动**，变的只有短期那条曲线的周期。
  const scored = pool.map(({ row, topic }) => {
    const age = Math.max(0, now - (Number(row.at) || now));
    const recency = 1 / (1 + age / halfLifeFor(row.type, working));
    const conf = Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0.5;
    const senderBoost = ctx.senderId && String(row.subjectId) === String(ctx.senderId) ? 0.15 : 0;
    const parts = [
      ['最近出现过', 0.45 * recency],
      ['把握较高', 0.25 * conf],
      ['和本轮话题相关', 0.2 * topic],
      ['全局印象', 0.1 * (row.scope === 'global' ? 1 : 0.6)],
      ['说话人本人', senderBoost],
    ];
    // 这里只是把已经算出来的分量挑一个最大的说明白。
    const top = parts.reduce((a, b) => (b[1] > a[1] ? b : a));
    return {
      row,
      reason: top[1] > 0 ? top[0] : '按综合得分排到前面',
      score: 0.45 * recency + 0.25 * conf + 0.2 * topic + 0.1 * (row.scope === 'global' ? 1 : 0.6) + senderBoost,
    };
  });
  scored.sort((a, b) => b.score - a.score
    || (Number(b.row.at) || 0) - (Number(a.row.at) || 0)
    || String(a.row.id).localeCompare(String(b.row.id)));

  const cap = Math.max(1, Math.min(50, Math.floor(Number(requestedLimit) || 8)));
  const picked = scored.slice(0, cap);
  // ★ 2026-10-16：形状归一到 `recall-item.js`（语义腿共用同一份）—— 两条腿的字段不再各拼一套。
  const items = picked.map(({ row, reason, score }) => recallItemShape({
    row,
    reason,
    source: 'keyword',
    item: {
      // 小契约的新键（值全部来自上面那行同一份数据）。
      memoryId: row.id,
      cardId: row.claimKey ?? claimKeyOf(row.subjectId, row.scope, row.claim),
      reason,
      score: Math.round(score * 1000) / 1000,
      // ★ P0-2 读端（功能表 5 · 2026-10-11）：`correction` 只有 store 行上有（store.js:写观察），
      //   这里是**关键词召回**这条腿；语义那条腿在 coordinator.recallWithSemantic 的 keep.push
      //   补同名字段（同一份 `recallItemShape`）。两条腿都补上，prompt 侧的更正判据才不会永远为假。
      supportCount: (row.evidenceIds || []).length,
      // 老行沿用既有默认（`type` 缺省按 impression、`version` 缺省 1）—— 保持这条腿的历史行为，
      // 语义腿没有这个默认，缺就缺（`recallItemShape` 的"没有这个键就不出现"纪律）。
      type: row.type ?? 'impression',
      version: row.version ?? 1,
      ...(row.schemaVersion !== undefined ? { schemaVersion: row.schemaVersion } : {}),
      ...(row.namespace !== undefined ? { namespace: row.namespace } : {}),
      ...(row.memoryClass !== undefined ? { memoryClass: row.memoryClass } : {}),
      ...(row.factSlot !== undefined ? { factSlot: row.factSlot } : {}),
      ...(row.origin !== undefined ? { origin: row.origin } : {}),
      ...(row.sourceRefs !== undefined ? { sourceRefs: row.sourceRefs } : {}),
      ...(row.todoId !== undefined ? { todoId: row.todoId } : {}),
    },
  }));

  // ⑦ 命中计数：**只对真正进了上下文的卡 +1**（写了没人用 = writes>0 且 hits=0）。
  //    只追加一行到 cards-hits.jsonl（不整文件覆盖 ⇒ 并发/多实例不会互相抹计数）。
  //    ★ 2026-10-16（JEV 前轻上下文）：`ctx.noHit === true` 时不记命中 —— 轻上下文与最终上下文
  //      会对同一批卡各读一次，两次都记 = 命中翻倍（"轻上下文两次 prepare 不许重复记账"）。
  if (ctx.noHit !== true) {
    for (const item of items) bumpHit(st, item.cardId, now, { chatKey: ctx.chatKey, scope: item.scope });
  }

  const scopeReasons = [...new Set(dropped.filter((d) => String(d.reason).startsWith('scope:')).map((d) => d.reason))];
  const truncatedCount = Math.max(0, scored.length - picked.length);

  return {
    items,
    dropped: dropped.map((d) => ({ id: d.id ?? null, subjectId: d.subjectId ?? null, scope: d.scope ?? null, reason: d.reason })),
    provided,
    ignored: [...ignored, ...scopeReasons.map((r) => `范围过滤：${r}`)],
    scanned: all.length,
    // 双人格隔离隐去的观察条数（只给排障与自测计数，不含正文）。
    personaHiddenRows,
    // 因"来源被用户忘掉"而没进候选的条数（同上：只给计数与 dropped 里的原因，不含正文）。
    suppressionDropped,
    // ① 年龄闸本轮的读数（给排障与面板，不含正文）：生效口径、口径来自哪一层、两个计数。
    workingGate: {
      enabled: working.enabled,
      ttlMin: working.ttlMin,
      decayMin: working.decayMin,
      source: working.source,
      expiredDropped: workingExpired,
      topicRescued: workingRescued,
    },
    candidateCount: candidates.length,
    // 超上限的是"没被选中"，不是"被删除"：账本里还在，下一次还能取回。计数给排障看，**不静默**。
    truncated: truncatedCount,
    dataDir: st.dataDir,
    // ★ coverage（§6.3 第 5 条 · M2 2026-10-14）：本出口只按条件取"当前有效观察"，
    //   **不碰整理队列**，所以水位与队列四项给不出真值 ⇒ 如实写 `null` 并落在 `unmeasured` 里，
    //   让调用方分得清"这次没测"和"测出来是 0"（形状只在 `coverage.js` 写一份）。
    //   代次这一键同理：本出口只走关键词与权威记录，**语义那条腿没接在这儿** ⇒ `generation:null`
    //   + `generationState:'not-wired'`（2026-10-14 裁定：不许写 `'none'`，"没接"和"确实没有代次"是两件事）。
    coverage: buildCoverage({
      state: truncatedCount > 0 ? 'partial' : 'complete',
      scope: {
        accountId: ctx.accountId ?? 'default',
        kind: ctx.kind ?? '',
        chatKey: ctx.chatKey ?? '',
      },
      generationState: 'not-wired',
      stateReason: truncatedCount > 0 ? 'candidates-truncated' : '',
      reasons: ['本出口只读当前有效观察，不声明整理进度（水位与队列见 unmeasured）'],
    }),
    _meta: readMeta({
      complete: truncatedCount === 0,
      truncatedCount,
      scannedCount: all.length,
      limitNum: cap,
      limitSource,
      personaTwo,
    }),
  };
}

/**
 * Cross-chat privacy boundary for shared people impressions.
 *
 * The caller must supply only people who participate in the current session.
 * This adapter intentionally exposes no message text, evidence IDs, source refs,
 * originating chat keys, or non-participant subjects. Missing context and read
 * failures return no items so callers can safely skip cross-chat injection.
 *
 * 是否允许共享由 `impression-share.jsonl` 里管理侧逐条写入的记录决定（`setImpressionShare()`）；
 *   账本没有记录时，才使用观察记录自带的 `crossChatShareable`。授权与回收都在模型之外。
 */
async function retrieveCrossChatImpressionsImpl(ctx = {}) {
  const limitSource = ctx.limit === undefined ? 'default' : 'ctx.limit';
  const limitForMeta = () => {
    try {
      const value = Number(ctx.limit);
      return Number.isFinite(value) ? Math.max(1, Math.min(8, Math.floor(value))) : 4;
    } catch { return null; }
  };
  const empty = (reason, ok = false, { denied = false, scannedCount = 0 } = {}) => ({
    ok,
    items: [],
    reason,
    ...(denied ? {
      dropped: [{ reason: `permission:${reason}` }],
      ignored: [`cross-chat read denied: ${reason}`],
    } : {}),
    _meta: readMeta({
      complete: null,
      truncatedCount: null,
      scannedCount,
      limitNum: limitForMeta(),
      limitSource,
    }),
  });
  const chatKey = typeof ctx.chatKey === 'string' ? ctx.chatKey.trim() : '';
  if (!chatKey || chatKey.length > 256 || !['group', 'private'].includes(ctx.kind)) {
    return empty('invalid-current-session', false, { denied: true });
  }

  if (!Array.isArray(ctx.participantIds) || ctx.participantIds.length === 0) {
    return empty('no-current-participants', true, { denied: true });
  }
  if (ctx.participantIds.length > 64) return empty('invalid-participants', false, { denied: true });
  const participants = [];
  for (const value of ctx.participantIds) {
    if ((typeof value !== 'string' && typeof value !== 'number')
      || (typeof value === 'number' && !Number.isFinite(value))
      || !String(value).trim() || String(value).length > 128) {
      return empty('invalid-participants', false, { denied: true });
    }
    const id = String(value).trim();
    if (!participants.includes(id)) participants.push(id);
  }
  if (!participants.length) return empty('no-current-participants', true, { denied: true });
  const requestedLimit = Number(ctx.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(8, Math.floor(requestedLimit)))
    : 4;
  try {
    const baseDir = dirOf(ctx.dataDir);
    const st = openStore(baseDir);
    const now = Number.isFinite(Number(ctx.now)) ? Number(ctx.now) : Date.now();
    // 共享许可来自授权记录表（`impression-share.jsonl`，管理侧逐条写入），表中没有该记录时才
    //   回落到数据行自带的 `crossChatShareable`。为什么需要这张表：模型写记忆的通道（`memory_append`）
    //   的作用域由当前会话推导，只会是 private 或 group（刻意如此，不让模型放宽跨会话可见范围），
    //   所以生产里没有任何代码会把 `crossChatShareable` 设为 true —— 只认行标记的读接口接上去也永远
    //   没有数据。`shared:false` 的回收同样能盖掉数据行自带的 true。
    const ledger = shareLedger({ dataDir: baseDir }).table;
    const participantSet = new Set(participants);
    // ★ 2026-10-17（qwen3 审查修）：跨会话这条腿原先**只**过共享许可，缺 `retrieve()` 已有的两道过滤：
    //   ① 人格可见性 —— 另一人格写下的印象会经跨群共享通道串进当前人格的上下文；
    //   ② 点名遗忘 —— 来源被用户点名字忘掉、但行还活着（面板/管理端/重新整理另写的行）时，
    //      `retrieve()` 在 ④b 拦得住，这条腿拦不住 ⇒「说忘掉的事」从跨会话这条腿回来。
    //   判据一律复用既有那一份，不在这里另写：`observationVisibleToPersona` +
    //   `namedSuppressedEvidenceIds`/`namesSuppressedSource`（只比编号，不套窗口口径、不连坐）。
    const personaTwo = typeof ctx.personaTwo === 'boolean' ? ctx.personaTwo : personaTwoNow();
    const hygiene = ctx.memoryHygiene && typeof ctx.memoryHygiene === 'object' && !Array.isArray(ctx.memoryHygiene)
      ? ctx.memoryHygiene : memoryHygiene;
    const namedSuppressed = namedSuppressedEvidenceIds({ dataDir: baseDir });
    // ★ 2026-10-17（安全审查 · 读侧 fail-closed）：抑制账本读不全时不能当"没被忘过"。
    //   跨会话这条腿是最不能放水的一条 —— 它本来就是把别处的印象搬进当前会话的通道。
    const suppressionHealth = ledgerHealthOf(namedSuppressed);
    if (suppressionHealth.ok === false) {
      return empty(`suppression-ledger-unreadable:${suppressionHealth.reason || 'unknown'}`, false,
        { denied: true, scannedCount: 0 });
    }
    const active = activeObservations(st)
      .filter((row) => observationVisibleToPersona(row, personaTwo, hygiene))
      .filter((row) => !namesSuppressedSource(row.evidenceIds, namedSuppressed));
    const eligible = active
      .filter((row) => {
        const validUntil = row.validUntil;
        return row.scope === 'global' && row.type === 'impression'
          && resolveShare(row, ledger, cardIdOf(row))
          && participantSet.has(String(row.subjectId ?? ''))
          && (validUntil === null || validUntil === undefined || Number(validUntil) >= now)
          && typeof row.claim === 'string' && row.claim.trim().length > 0 && row.claim.length <= 240
          && Number.isFinite(Number(row.confidence)) && Number(row.confidence) >= 0 && Number(row.confidence) <= 1;
      })
      .map((row) => {
        const age = Math.max(0, now - (Number(row.at) || now));
        const recency = 1 / (1 + age / HALF_LIFE);
        const confidence = Number(row.confidence);
        return { row, score: 0.45 * recency + 0.25 * confidence + 0.1 };
      })
      .sort((a, b) => b.score - a.score
        || (Number(b.row.at) || 0) - (Number(a.row.at) || 0)
        || String(a.row.id).localeCompare(String(b.row.id)));
    const picked = eligible.slice(0, limit);
    const items = picked.map(({ row }) => ({
      subjectId: String(row.subjectId),
      impression: row.claim.replace(/\s+/g, ' ').trim(),
      confidence: Number(row.confidence),
    }));
    for (const { row } of picked) bumpHit(st, cardIdOf(row), now, { chatKey, scope: 'global' });
    return {
      ok: true,
      items,
      reason: items.length ? null : 'no-approved-shareable-impressions',
      _meta: readMeta({
        complete: eligible.length <= picked.length,
        truncatedCount: Math.max(0, eligible.length - picked.length),
        scannedCount: active.length,
        limitNum: limit,
        limitSource,
      }),
    };
  } catch {
    return empty('memory-read-failed', false, { scannedCount: null });
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 撤回 / 修订（保留历史，不做物理删除）
// ═════════════════════════════════════════════════════════════════════════

/**
 * P0-3 写端（功能表 5 · 2026-10-11）：把"被忘掉的说法"的**来源**记进抑制账本。
 *
 * 为什么必须写（改前这里一行都不写 ⇒ `addSuppression()` 全树零调用、读端的抑制过滤从未真正生效）：
 *   被忘掉的事有两条复活路径 —— ① 旧消息还没被后台整理过，之后被抽成 episode；
 *   ② episodes.jsonl 里**已经存在**的旧 episode 还会继续被送进提示词。抑制账本两头都靠它。
 *
 * `from`（`at`）怎么算 —— 取这批行（**含被取代的旧版本**，走 supersedes 链）里最早那条证据的时刻：
 *   用户改口之前的那条旧消息往往正是更正的**来源**，取晚一毫秒就拦不住，复活照旧。
 *
 * 两条需要说明的当前行为（是设计选择，不是问题）：
 *   · 抑制记录的键是 (chatKey, speakerId)、作用域是 **[at, ∞)** —— 这个人在这个会话里，
 *     从那条消息往后的新消息**也会**暂不被后台整理，恢复要靠 `reinstate()`。
 *   · `bot_output` / `tool_confirm`（发信人是机器人自己）不计：算进去会把机器人之后
 *     所有发言的整理一并压掉，等于把整个会话的记忆切断。
 */
function suppressionRowsOf(st, targets) {
  const rows = new Map();
  const stack = [...(targets || [])];
  while (stack.length) {
    const row = stack.pop();
    if (!row || row.t === 'status-only') continue;
    const id = String(row.id ?? '');
    if (!id || rows.has(id)) continue;
    rows.set(id, row);
    const prevId = row.supersedes ? String(row.supersedes) : '';
    if (prevId) {
      const prev = st.obs.get(prevId);
      if (prev && prev.t !== 'status-only') stack.push(prev);
    }
  }
  return [...rows.values()];
}

function writeForgetSuppressions(st, targets, { reason = 'forget' } = {}) {
  const pairs = new Map();
  let noChatKey = 0;
  let noEvidence = 0;
  for (const row of suppressionRowsOf(st, targets)) {
    const ids = row.evidenceIds || [];
    if (!ids.length) noEvidence += 1;
    // ★ 2026-10-16 修：`scope='global'` 的观察行没有 chatKey（跨会话的印象不属于任何会话），
    //   而抑制账本的键是 `(会话, 发言人)` ⇒ 旧实现整行 `continue`（`skippedNoChatKey`），
    //   "删掉一条全局印象"等于**没写任何来源抑制**，后台整理还能从原消息把它捞回来。
    //   会话从**证据行**取（证据行就是那条原始消息，自带 chatKey）。
    for (const eid of ids) {
      const ev = getEvidence(st, eid);
      if (!ev) continue;
      const sourceType = String(ev.sourceType ?? '');
      if (SELF_SOURCE_TYPES.includes(sourceType)) continue;
      const chatKey = String(row.chatKey ?? '') || String(ev.chatKey ?? '');
      if (!chatKey) { noChatKey += 1; continue; }
      const speakerId = String(ev.speakerId ?? '');
      const at = Number(ev.at) || 0;
      if (!speakerId || !at) continue;
      const key = chatKey + ' ' + speakerId;
      const cur = pairs.get(key);
      if (!cur) {
        pairs.set(key, { chatKey, speakerId, at, evidenceIds: [String(eid)] });
      } else {
        if (at < cur.at) cur.at = at;
        if (!cur.evidenceIds.includes(String(eid))) cur.evidenceIds.push(String(eid));
      }
    }
  }
  const written = [];
  for (const pair of pairs.values()) {
    const res = addSuppression({ ...pair, reason, dataDir: st.dataDir });
    written.push({
      chatKey: pair.chatKey, speakerId: pair.speakerId, at: pair.at,
      ok: res?.ok === true,
      ...(res?.error ? { error: res.error } : {}),
    });
  }
  return {
    ok: written.length > 0 && written.every((row) => row.ok === true),
    pairs: written.length,
    written,
    ...(noChatKey ? { skippedNoChatKey: noChatKey } : {}),
    ...(noEvidence ? { skippedNoEvidence: noEvidence } : {}),
    ...(written.length === 0 ? { reason: pairs.size === 0 ? 'no-suppressible-source' : 'no-pair-written' } : {}),
  };
}

/**
 * 撤回（forget）：把依赖这些证据（或属于该 subject、或属于该范围）的**当前**观察标 `retracted`。
 * **不做物理删除** —— 旧行还在数据文件里，`history()` / `audit()` 都能翻到（验收第 7 条）。
 *
 * ★ 2026-10-11（P0-3）：撤回成功后**顺手写来源抑制**（见 `writeForgetSuppressions`），
 *   否则忘掉的事会被后台整理/旧 episode 原样送回提示词（= 假忘）。
 *
 * @param {string} subjectId 主体（可为空：只按证据撤回）
 * @param {object} opts `{evidenceIds, scope, chatKey, reason, dataDir}`
 */
export async function forget(subjectId, opts = {}) {
  const { evidenceIds, scope, chatKey, reason = 'forget', dataDir } = opts;
  const st = openStore(dirOf(dataDir));
  const wanted = new Set((evidenceIds || []).map(String));
  const subj = subjectId === undefined || subjectId === null ? '' : String(subjectId);

  const targets = activeObservations(st).filter((row) => {
    if (subj && String(row.subjectId) !== subj) return false;
    if (scope && row.scope !== scope) return false;
    if (chatKey && String(row.chatKey ?? '') !== String(chatKey)) return false;
    if (wanted.size) {
      const has = (row.evidenceIds || []).some((id) => wanted.has(String(id)));
      if (!has) return false;
    }
    return true;
  });

  if (!targets.length) {
    return { ok: true, retracted: [], matched: 0, keptHistory: true, dataDir: st.dataDir, note: '没有匹配的当前观察' };
  }
  const res = await retract(st, targets.map((t) => t.id), {
    evidenceIds: [...wanted], reason, at: Date.now(), scope, subjectId: subj,
  });
  let suppression = null;
  if (res?.ok === true && Array.isArray(res.retracted) && res.retracted.length > 0) {
    notifyObservationChange(st.dataDir, { action: 'retract', ids: res.retracted.slice() });
    suppression = writeForgetSuppressions(st, targets, { reason: 'forget' });
  }
  return { ...res, matched: targets.length, suppression, dataDir: st.dataDir, note: '保留历史，不做物理删除' };
}

// ═════════════════════════════════════════════════════════════════════════
// 人工改人物印象（旧树 `PUT /api/memory-people/:qq` → `editMemberImpression` 的 M6 对应物）
// 契约见同目录《契约-改人物印象.md》—— 函数名 / 入参 / 返回形状 / 错误码以那份为准。
// ═════════════════════════════════════════════════════════════════════════

const IMP_TEXT_MAX = 160;      // 单条印象正文（与老树 editMemberImpression 的 slice(0,160) 同）
const IMP_NAME_MAX = 60;       // 显示名（老树同值）
const IMP_OPERATOR_MAX = 40;   // 操作者标识（进证据行的 speakerId）
const IMP_MAX_COUNT = 60;      // 每人条数上限（老树 MAX_IMPRESSIONS）
const IMP_INPUT_KEYS = new Set([
  // ★ 2026-10-17：`removedIds` = 精确删除（观察 id 数组；界面不必用文本反推 id）。
  'subjectId', 'impressions', 'removedIds', 'name', 'operator', 'scope', 'chatKey', 'dataDir', 'idempotencyPrefix',
]);

/** 「同一条印象」的尺：与 `store.js` 的 claimKeyOf 同一套归一（trim + 压空白 + 小写）。 */
function impTextKey(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * "这条观察是不是**明确更正**" —— 记忆层的公开判据（执行侧一份，供 coordinator 轻上下文等复用）。
 *
 * 三判据与 `modules/prompt/index.js` 的 `isCorrection`（【明确更正】段的入口判据）**逐条一致**：
 *   `row.correction === true`（生产唯一来源：`store.js` 写观察——**说法确实变了**才落 true）
 *   ‖ `row.memoryClass === 'correction'` ‖ `row.type === 'correction'`（后两条是 legacy 兜底，
 *   OBS_TYPES 里没有 correction ⇒ 生产恒假，只为兼容老数据/外部注入形状）。
 * ⚠ prompt 侧那份暂时各持一份；若将来合并，以**同一份实现**为准，别改出第二个口径。
 */
export function isCorrectionObservation(row) {
  return row?.correction === true || row?.memoryClass === 'correction'
    || String(row?.type ?? '').toLowerCase() === 'correction';
}

/**
 * 本接口**管理/删除**的那批行（= 记忆页对一个人列出来、用户能删的那批）。
 *
 * ★ 2026-10-16 修（用户："用户删掉的印象，memory_query 还能查到"）：
 *   旧实现只认 `type === 'impression'`，而记忆页列表来自 `history()`（**全类型**），
 *   模型写的成员印象经 `memory_append` 落成 `fact` / `preference` / `trait`（`act/executors/memory.js`
 *   的 typeMap）⇒ 用户删掉这类行时，本接口既不保留也不撤回（它根本看不见这些行），
 *   行继续 active ⇒ `memory_query`（走 `retrieve`，全类型）照样查得到。
 *   现在管理集合 = 该人当前生效、**带 scope** 的稳定观察（OBS_TYPES 减去 `working-window.js`
 *   的短期状态四类 topic/promise/question/recent —— 那四类归短期状态，按半衰过期，
 *   另有"清表层记忆"出口，不在这里精删）。
 */
const SHORT_TERM_OBS_TYPES = new Set(['topic', 'promise', 'question', 'recent']);
function isManagedPersonRow(row) {
  return Boolean(row) && Boolean(row.scope) && !SHORT_TERM_OBS_TYPES.has(String(row.type ?? 'impression'));
}

/**
 * 用操作者给的这一份条集合，替换某个人**当前生效的印象**（`type='impression'` 的观察）。
 *
 * 全部走既有出口，不直接写数据文件：新增 = `commit()`（每条配一条 `relay` 证据，满足
 * 「没有证据不许写」）；更正 = `commit({supersedes})`（行上落 `correction:true`，提示词的更正判据读得到）；
 * 删除 = `retract` + 来源抑制（和 `forget` 同一套，否则后台整理会拿旧消息把删掉的印象捞回来）。
 * `commit`/`retract` 都发 `notifyObservationChange` ⇒ 语义索引随之重建（唯一指导 §6.3）。
 *
 * ★ 文字没变的条目**一个字节都不重写**（不动版本、不写抑制）—— 老树那次"任意编辑都锁 24 小时"
 *   就是被无条件重写放大的，这里从写入侧就不复现它。
 *
 * @param {object} input 见契约第二节。`{subjectId, impressions[], removedIds?, name?, operator?, scope?, chatKey?, dataDir, idempotencyPrefix?}`
 *   `impressions` 元素可以是字符串，也可以是 `{text, scope?, chatKey?, replacesId?}`；
 *   只有元素自己带了 `scope`/`chatKey` 才按那个范围比对（不给就默认 `global`，且不硬凑范围）。
 *   ★ 2026-10-17：`removedIds` = 要**精确删除**的观察 id 数组（≤200；界面从 GET /api/memory-people
 *   的 `observationIds` 取，不必用文本反推）；只认"该人当前生效的管理集合"里的行，其余进 warnings 不猜删。
 * @returns {Promise<object>} 成功 `{ok:true, person, applied, suppressions, notApplied, warnings, personExisted}`；
 *   失败 `{ok:false, reason:'invalid-arguments'|'write-failed', errors[]}`（后者带 `partial`）。
 */
export async function editPersonImpressions(input = {}) {
  const errors = [];
  const warnings = [];

  // ── 1. 入参校验（不合格一律 invalid-arguments，接口层转 400；一个字节都不写）──
  const subj = String(input.subjectId ?? '').trim();
  if (!subj) errors.push('subjectId: 必须是非空字符串');
  else if (subj.length > 64) errors.push(`subjectId: 最长 64 字符（收到 ${subj.length}）`);

  if (!Array.isArray(input.impressions)) {
    errors.push('impressions: 必须是数组（一行一条；空数组 = 删光这个人当前生效的印象）');
  } else if (input.impressions.length > IMP_MAX_COUNT) {
    errors.push(`impressions: 最多 ${IMP_MAX_COUNT} 条（收到 ${input.impressions.length}）—— 超上限整批拒写，不静默截断`);
  }

  const baseScope = input.scope === undefined || input.scope === null || input.scope === ''
    ? 'global' : String(input.scope);
  if (!SCOPES.includes(baseScope)) {
    errors.push(`scope: 只支持 ${SCOPES.join('|')}（收到 ${String(input.scope)}）`);
  }
  const baseChatKey = String(input.chatKey ?? '').trim();
  if (SCOPES.includes(baseScope) && baseScope !== 'global' && !baseChatKey) {
    errors.push(`chatKey: scope='${baseScope}' 必须带 chatKey（否则范围规则无从落地）`);
  }

  const op = String(input.operator ?? '').trim() || 'operator';
  if (op.length > IMP_OPERATOR_MAX) errors.push(`operator: 最长 ${IMP_OPERATOR_MAX} 字符（收到 ${op.length}）`);

  const rawName = input.name === undefined || input.name === null ? null : String(input.name).trim();
  if (rawName !== null) {
    if (!rawName) errors.push('name: 给了就不能是空串（要保留原名就别传这个字段）');
    else if (rawName.length > IMP_NAME_MAX) errors.push(`name: 最长 ${IMP_NAME_MAX} 字符（收到 ${rawName.length}）`);
  }

  const idemPrefix = input.idempotencyPrefix === undefined || input.idempotencyPrefix === null
    ? '' : String(input.idempotencyPrefix);
  if (idemPrefix && !/^[\w.:-]{1,80}$/.test(idemPrefix)) {
    errors.push('idempotencyPrefix: 只允许字母、数字与 . _ : -，长度 ≤80');
  }

  const entries = [];
  const seenText = new Set();
  for (const [i, raw] of Array.isArray(input.impressions) ? input.impressions.entries() : []) {
    const isObj = !!raw && typeof raw === 'object';
    let text = String(isObj ? raw.text ?? '' : raw ?? '').trim().replace(/\s+/g, ' ');
    if (!text) { errors.push(`impressions[${i}]: 空条目（要么写内容，要么把这一行删掉）`); continue; }
    if (text.length > IMP_TEXT_MAX) {
      warnings.push(`impressions[${i}]：${text.length} 字 > ${IMP_TEXT_MAX}，已截断保存`);
      text = text.slice(0, IMP_TEXT_MAX);
    }
    const key = impTextKey(text);
    if (seenText.has(key)) {
      warnings.push(`重复条目「${text.slice(0, 20)}${text.length > 20 ? '…' : ''}」只保留第一次`);
      continue;
    }
    seenText.add(key);
    // 元素自己带了范围 ⇒ 严格比对那个范围；没带 ⇒ 只按文字比对（不给群内细节硬造一份 global）。
    const strictScope = isObj && (raw.scope !== undefined || raw.chatKey !== undefined);
    const entryScope = isObj && raw.scope ? String(raw.scope) : baseScope;
    if (!SCOPES.includes(entryScope)) {
      errors.push(`impressions[${i}].scope: 只支持 ${SCOPES.join('|')}（收到 ${String(raw.scope)}）`);
      continue;
    }
    const entryChatKey = (isObj && raw.chatKey !== undefined ? String(raw.chatKey).trim() : '') || baseChatKey;
    if (entryScope !== 'global' && !entryChatKey) {
      errors.push(`impressions[${i}]: scope='${entryScope}' 必须带 chatKey`);
      continue;
    }
    entries.push({
      index: i, text, key, scope: entryScope, chatKey: entryChatKey, strictScope,
      replacesId: isObj && raw.replacesId ? String(raw.replacesId) : null,
    });
  }

  const unknownFields = Object.keys(input).filter((k) => !IMP_INPUT_KEYS.has(k));
  if (errors.length) {
    return { ok: false, reason: 'invalid-arguments', errors, notApplied: unknownFields.map((field) => ({ field, reason: 'not-memory-owned' })) };
  }

  const st = openStore(dirOf(input.dataDir));

  // ── 2. 当前生效集合（改动前）──
  const allActive = activeObservations(st).filter((row) => String(row.subjectId) === subj);
  const personExisted = allActive.length > 0;
  // 管理集合见 `isManagedPersonRow` 的说明（旧实现只认 type==='impression' ⇒ 删不掉 fact/preference/trait）。
  const currentImpressions = allActive.filter(isManagedPersonRow);

  // 更正目标必须真是这个人的生效观察（拿不到就拒，不猜"他大概想改那条"）
  for (const e of entries) {
    if (!e.replacesId) continue;
    const target = st.obs.get(e.replacesId);
    if (!target || target.t === 'status-only' || target.status !== 'active'
      || String(target.subjectId) !== subj || !isManagedPersonRow(target)) {
      errors.push(`impressions[${e.index}].replacesId: 「${target?.claim ? String(target.claim).slice(0, 20) : e.replacesId}」不是这个人当前生效的印象，无法作为更正目标`);
      continue;
    }
    e.replacesRow = target;
    // ★ 更正**沿用被更正那条的范围**：`supersedes` 在账本层就要求 subjectId/scope 一致
    //   （`store.js:384`），而且把群内细节"顺手改成 global"本身就是一次扩范围。
    //   调用方显式给了别的范围 ⇒ 拒，不静默改它给的 scope。
    const targetScope = String(target.scope);
    const targetChatKey = String(target.chatKey ?? '');
    if (!e.strictScope) {
      e.scope = targetScope;
      e.chatKey = targetChatKey;
    } else if (e.scope !== targetScope || e.chatKey !== targetChatKey) {
      errors.push(`impressions[${e.index}]: 更正的范围（${e.scope}:${e.chatKey}）与被更正那条（${targetScope}:${targetChatKey}）不一致 —— 改印象不许换范围`);
    }
  }
  if (errors.length) {
    return { ok: false, reason: 'invalid-arguments', errors, dataDir: st.dataDir, notApplied: unknownFields.map((field) => ({ field, reason: 'not-memory-owned' })) };
  }

  // ── 3. 比对：保留 / 新增 / 更正 / 删除 ──
  const keptRows = [];
  const keptIds = new Set();
  const toWrite = [];
  for (const e of entries) {
    const match = currentImpressions.find((row) => impTextKey(row.claim) === e.key
      && (!e.strictScope || (row.scope === e.scope && String(row.chatKey ?? '') === e.chatKey)));
    if (match && !e.replacesId) {
      keptRows.push(match);
      keptIds.add(String(match.id));
    } else {
      toWrite.push(e);
    }
  }
  // ★ 2026-10-17（glm1：界面不该用文本反推 id）：`removedIds` 精确删除 ——
  //   只认"这个人的、当前生效的、管理集合里的"观察 id；找不到/不属于本人：如实进 warnings，不猜不删。
  //   显式点名要删的行**同时从保留集合里剔除**（用户点名 > 文本列表里还留着的那一行）。
  const explicitRemoveIds = Array.isArray(input.removedIds)
    ? [...new Set(input.removedIds.map((x) => String(x ?? '').trim()).filter(Boolean))]
    : [];
  if (input.removedIds !== undefined && !Array.isArray(input.removedIds)) {
    errors.push('removedIds: 必须是数组（要精确删除的观察 id）');
  } else if (explicitRemoveIds.length > 200) {
    errors.push(`removedIds: 最多 200 个（收到 ${explicitRemoveIds.length}）`);
  }
  if (errors.length) {
    return { ok: false, reason: 'invalid-arguments', errors, dataDir: st.dataDir, notApplied: unknownFields.map((field) => ({ field, reason: 'not-memory-owned' })) };
  }
  const explicitRemoveSet = new Set(explicitRemoveIds);
  const explicitRows = currentImpressions.filter((row) => explicitRemoveSet.has(String(row.id)));
  const missingExplicit = explicitRemoveIds.filter((id) => !explicitRows.some((row) => String(row.id) === id));
  if (missingExplicit.length) {
    warnings.push(`removedIds 里有 ${missingExplicit.length} 个 id 不在「${subj} 当前生效的印象」里，未删除：${missingExplicit.slice(0, 5).join('、')}${missingExplicit.length > 5 ? '…' : ''}`);
  }
  const keptFinal = keptRows.filter((row) => !explicitRemoveSet.has(String(row.id)));
  const implicitRemoved = currentImpressions.filter((row) => !keptIds.has(String(row.id))
    && !toWrite.some((e) => e.replacesRow && String(e.replacesRow.id) === String(row.id)));
  const implicitRemovedIds = new Set(implicitRemoved.map((row) => String(row.id)));
  const removedRows = [...implicitRemoved, ...explicitRows.filter((row) => !implicitRemovedIds.has(String(row.id)))];

  const applied = { kept: [], added: [], revised: [], removed: [], name: null };
  for (const row of keptFinal) {
    // ★ 带 `type`：接口/界面要能说清"这一条实际是什么类型、在哪个范围"（用户删一行=删哪些来源必须可核）。
    applied.kept.push({
      id: row.id, text: row.claim, scope: row.scope, chatKey: row.chatKey ?? '',
      type: String(row.type ?? 'impression'),
    });
  }

  // ── 4. 删除：撤回 + 来源抑制（留历史，不物理删）──
  if (removedRows.length) {
    const nowMs = Date.now();
    const res = await retract(st, removedRows.map((row) => String(row.id)), {
      evidenceIds: [...new Set(removedRows.flatMap((row) => (row.evidenceIds || []).map(String)))],
      reason: `人工改印象（${op}）`,
      at: nowMs,
    });
    notifyObservationChange(st.dataDir, { action: 'retract', ids: (res?.retracted ?? []).slice() });
    for (const row of removedRows) {
      applied.removed.push({
        id: row.id, text: row.claim, scope: row.scope, chatKey: row.chatKey ?? '',
        type: String(row.type ?? 'impression'),
        retracted: (res?.retracted ?? []).includes(String(row.id)),
      });
    }
    const okRetracted = new Set(res?.retracted ?? []);
    const notRetracted = removedRows.filter((row) => !okRetracted.has(String(row.id)));
    if (notRetracted.length) {
      return {
        ok: false, reason: 'write-failed', dataDir: st.dataDir,
        errors: [`撤回失败（这 ${notRetracted.length} 条仍是生效状态）：${notRetracted.map((r) => r.id).join(',')}`],
        partial: { kept: applied.kept.length, removed: okRetracted.size, added: 0 },
        notApplied: unknownFields.map((field) => ({ field, reason: 'not-memory-owned' })),
      };
    }
  }

  // ── 5. 新增 / 更正：逐条 commit（追加写，中途失败不回滚，如实报 partial）──
  let suppressionRes = null;
  if (removedRows.length) {
    suppressionRes = writeForgetSuppressions(st, removedRows, { reason: 'manual-impression-edit' });
  }
  const idemOf = (entry, evidenceId) => {
    const chat = entry.scope === 'global' ? 'global' : entry.chatKey;
    return `${idemPrefix ? `${idemPrefix}:` : ''}${chat}:${evidenceId}:manual-impression`;
  };
  for (const e of toWrite) {
    const at = Date.now();
    // 证据编号按「这个人 + 这句话」定死（不带时间）：同一句话重复提交时 `ingestEvidence` 按 id 去重、
    // `writeObservation` 的重复窗口也认"没有新证据"⇒ 不会攒出两份"独立支持"（M6 不变量②）。
    const evidenceId = `ev-manual-${subj}-${impTextKey(e.text).slice(0, 24)}-${hashOf(e.text)}`;
    const evidenceRow = {
      id: evidenceId,
      at,
      chatKey: e.scope === 'global' ? (e.chatKey || 'global') : e.chatKey,
      kind: e.scope === 'private' ? 'private' : 'group',
      sourceType: 'relay',
      // ★ 2026-10-14 luna2 查出、指挥位派单：证据行**输入**的字段名是 `senderId`/`senderName`
      //   （`store.js:275-276` 只认 `sender.id`/`senderId` 与 `sender.name`/`senderName`），
      //   账本**落盘**后才叫 `speakerId`/`speakerName`。这里原先直接写落盘名 ⇒ 两个键没人读，
      //   盘上 speakerId 恒为空 ⇒ 删人工条目时 `writeForgetSuppressions` 的
      //   `if (!speakerId || !at) continue` 一条都攒不出，抑制写不进去（回执 no-suppressible-source）。
      senderId: op,
      senderName: op,
      subjectIds: [subj],
      text: `人工订正：${e.text}`,
    };
    let res;
    try {
      res = await commit({
        subjectId: subj,
        claim: e.text,
        evidenceIds: [evidenceId],
        scope: e.scope,
        chatKey: e.scope === 'global' ? '' : e.chatKey,
        type: 'impression',
        confidence: 1,
        at,
        ...(e.replacesId ? { supersedes: e.replacesId } : {}),
      }, {
        dataDir: st.dataDir,
        evidence: [evidenceRow],
        // 人工订正 = 操作者替某人陈述，不是"某个人格经历的事" ⇒ 显式不带归属标（两个人格都看得见）。
        // 不给就会被按写入时刻在位的人格自动打标，见契约第三节那段。
        persona2: false,
        // 只在调用方给了 idempotencyPrefix 时才用幂等键：不给就靠"证据编号按正文定死 + 重复窗口"防重复支持，
        // 否则"删掉后又想加回来"会被第一次的回执顶掉（幂等表是持久化的，它不知道该条已被撤回）。
        idempotencyKey: idemPrefix ? idemOf(e, evidenceId) : '',
      });
    } catch (error) {
      res = { ok: false, errors: [String(error?.message ?? error)] };
    }
    if (res?.ok !== true) {
      return {
        ok: false, reason: 'write-failed', dataDir: st.dataDir,
        errors: [`第 ${e.index} 条「${e.text.slice(0, 20)}」写入失败：${(res?.errors ?? [JSON.stringify(res)]).join('；')}`],
        partial: {
          kept: applied.kept.length,
          removed: applied.removed.filter((r) => r.retracted).length,
          added: applied.added.map((a) => a.text),
        },
        suppressions: suppressionRes,
        notApplied: unknownFields.map((field) => ({ field, reason: 'not-memory-owned' })),
      };
    }
    const written = {
      id: res.id, text: e.text, scope: e.scope, chatKey: e.chatKey,
      type: 'impression',                       // 本接口新增的行固定落成 impression（见上面的 commit）
      evidenceId, duplicate: res.duplicate === true,
    };
    if (e.replacesId) {
      applied.revised.push({
        id: res.id, text: e.text, supersedesId: e.replacesId,
        version: res.version,
        // 更正判据自己算：`commit` 的回执不带 correction，而行上是按"说法变没变"落的（store.js:388）。
        correction: impTextKey(e.text) !== impTextKey(e.replacesRow.claim),
        duplicate: res.duplicate === true,
      });
    } else {
      applied.added.push(written);
    }
  }

  // ── 6. 显示名 ──
  if (rawName !== null) {
    const before = getSubjectName(subj, { dataDir: st.dataDir });
    const res = setSubjectName(subj, rawName, { dataDir: st.dataDir });
    if (!res.ok) {
      return {
        ok: false, reason: 'write-failed', dataDir: st.dataDir,
        errors: [`改名失败：${res.error}`],
        partial: { kept: applied.kept.length, removed: applied.removed.length, added: applied.added.length },
        suppressions: suppressionRes,
        notApplied: unknownFields.map((field) => ({ field, reason: 'not-memory-owned' })),
      };
    }
    if (res.from !== rawName) applied.name = { from: res.from ?? (before === '未知' ? null : before), to: rawName };
  }

  // ── 7. 回读改完之后的当前生效集合（形状与 GET /api/memory-people 的每人条目同源）──
  //   ★ 过滤口径与"管理集合"一致（`isManagedPersonRow`）：只认 type==='impression' 会让
  //     `fact/preference/trait` 行在这次回读里消失 —— 界面看到的行与刚改过的行对不上。
  const personRows = activeObservations(st)
    .filter((row) => String(row.subjectId) === subj && isManagedPersonRow(row))
    .map((row) => ({
      id: row.id,
      // ★ 2026-10-17：与 GET /api/memory-people 同形（真实观察 id；此处每条就是一个观察，故长度为 1）。
      observationIds: [String(row.id)],
      text: String(row.claim ?? ''),
      scope: row.scope,
      chatKey: row.chatKey ?? '',
      type: String(row.type ?? 'impression'),
      at: row.at ?? null,
      version: row.version ?? 1,
      ...(row.correction !== undefined ? { correction: row.correction } : {}),
    }))
    .sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0) || String(a.id).localeCompare(String(b.id)));

  // ★ 手工编辑保护锁（老树 src/memory.js:1823-1851）：**内容侧真变更**才打锁。
  //   条集合增/删/改（含清空印象）⇒ contentTouched；只改名/无变更 ⇒ 不锁。
  //   新树 editPersonImpressions 不含 favor/attitude 字段（那些归 memory_favor / emotion），
  //   所以 contentTouched = applied.added/revised/removed 任一非空。
  const contentTouched = applied.added.length > 0 || applied.revised.length > 0 || applied.removed.length > 0;
  if (contentTouched) {
    try { writeManualEditLock(subj, Date.now(), st.dataDir); } catch { /* 锁写失败不阻断编辑结果 */ }
  }

  return {
    ok: true,
    subjectId: subj,
    dataDir: st.dataDir,
    personExisted,
    person: {
      userId: subj,
      name: getSubjectName(subj, { dataDir: st.dataDir }),
      impressions: personRows,
    },
    applied,
    manualEditLocked: contentTouched,
    suppressions: suppressionRes
      ? { written: suppressionRes.pairs ?? 0, ok: suppressionRes.ok === true, ...(suppressionRes.reason ? { note: suppressionRes.reason } : {}) }
      : null,
    notApplied: unknownFields.map((field) => ({ field, reason: 'not-memory-owned' })),
    warnings,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// 成员印象库的四个删除 / 清理出口
//   （旧树 `src/memory.js`：`removeMember` :2048 · `removeNameOnlyMember` :2091 ·
//    `clearSurface` :1029 · `cleanupAll` :1567 的 M6 对应物）
//   契约：同目录《契约-删成员.md》《契约-删无号壳.md》《契约-清表层记忆.md》《契约-一键清理.md》
//   ★ 返回**字段名**逐字对齐旧树：HTTP 侧判据 `removalSucceeded`（`src/app.js:1231`）读的是
//     `ok===true && (deleted===true || removed===true) && !reason && !error` ——
//     少给一个 `deleted:true` 界面就把成功报成失败，多带一个 `reason` 同理。
//   ★ 旧树成功只有 `{ok:true, deleted:true}`；新加的计数字段一律**追加在后面**
//     （照旧树 `cleanupAll` 的 N7 先例："加字段、不改旧字段含义"）。
//   ★ 四个出口都不写 `audit.jsonl`（`logMemoryChange` 的目录是**全局解析**的，per-call 注入
//     dataDir 会写到别的目录去 —— 就是 `suppressions.js` 前阵子修过的那个坑）。
//     变更账走账本自己的 `changes.jsonl`（`retract` → `recordChange`），读侧是 `audit()`。
// ═════════════════════════════════════════════════════════════════════════

const REMOVAL_SUBJECT_MAX = 64;   // 与《契约-改人物印象.md》§2 的 subjectId 同一把尺

/** 失败返回（旧树同形 `{ok:false, deleted:false, reason}`；HTTP 按 reason 分 400/404/500）。 */
function removalFailure(reason, extra = {}) {
  return { ok: false, deleted: false, reason, ...extra };
}

/**
 * 删掉一个成员的全部当前记忆：撤回每一条生效观察 + 写来源抑制 + 清显示名，留历史不物理删。
 *
 * 旧树那条"确认删掉了才敢报已删"的门照搬：旧树是**先 unlink 再动 cache**（unlink 失败就
 * `unlink-failed`，`src/memory.js:2071`）；新树对应"retract 有没落地的 ⇒ `unlink-failed`"。
 *
 * 旧树 reason 表五条，新树可达三条（`bad-uid` / `not-found` / `unlink-failed`）：
 *   · `bad-uid`：`subjectId` 为空或超 64 字。**旧树那条 `^\d{5,15}$` 没搬** —— 新树的 subjectId
 *     不只是 QQ 号（可以是 senderId），照搬会把非数字 id 全判成非法。QQ 号格式校验留在
 *     HTTP 路由的 `(\d+)`（接口侧，luna2）。
 *   · `not-found`：这个人没有任何生效观察 ⇒ 404（旧树文案"未找到该成员，未删除"）。
 *   · `archive-failed` / `unreadable` 在新树**不可达**，不是漏实现：账本不做物理删除
 *     （撤回即留档，`store.js` 不变量④）⇒ 没有"归档失败"这一步；而坏行只给**总数**
 *     `st.badLines`（`store.js:76-95`），定位不到"某个人的行读不出"，硬造判据等于编。
 *     这两条在 `src/app.js:1260` 的失败表里继续留着，HTTP 侧不用改表。
 *
 * @param {{subjectId:string, dataDir:string, operator?:string}} input
 *   ★ 旧树第一参数 `chatKey` 在它自己函数体里从没被读过（`src/memory.js:2048-2077` 只用 userId），
 *     新签名不收；HTTP 侧那句 `removeMember('', userId)` 的 `''` 直接不传即可。
 * @returns {Promise<object>} 成功 `{ok:true, deleted:true, retracted, suppressions, nameRemoved, dataDir, note}`
 */
export async function removeMember(input = {}) {
  const st = openStore(dirOf(input.dataDir));
  const subj = String(input.subjectId ?? '').trim();
  if (!subj || subj.length > REMOVAL_SUBJECT_MAX) return removalFailure('bad-uid', { dataDir: st.dataDir });
  const op = String(input.operator ?? 'operator').trim().slice(0, IMP_OPERATOR_MAX) || 'operator';
  const targets = activeObservations(st).filter((row) => String(row.subjectId) === subj);
  if (!targets.length) return removalFailure('not-found', { dataDir: st.dataDir });
  const res = await retract(st, targets.map((row) => String(row.id)), {
    evidenceIds: [...new Set(targets.flatMap((row) => (row.evidenceIds || []).map(String)))],
    reason: `人工删成员（${op}）`,
    at: Date.now(),
    subjectId: subj,
  });
  const okRetracted = new Set(res?.retracted ?? []);
  const missed = targets.filter((row) => !okRetracted.has(String(row.id)));
  if (missed.length) {
    return removalFailure('unlink-failed', {
      dataDir: st.dataDir,
      partial: { retracted: okRetracted.size, total: targets.length, ids: missed.map((row) => String(row.id)) },
    });
  }
  notifyObservationChange(st.dataDir, { action: 'retract', ids: targets.map((row) => String(row.id)) });
  const suppressionRes = writeForgetSuppressions(st, targets, { reason: 'manual-member-removal' });
  const nameRes = removeSubjectName(subj, { dataDir: st.dataDir });
  return {
    ok: true,
    deleted: true,
    retracted: targets.length,
    suppressions: {
      written: suppressionRes.pairs ?? 0, ok: suppressionRes.ok === true,
      ...(suppressionRes.reason ? { note: suppressionRes.reason } : {}),
    },
    nameRemoved: nameRes.ok === true && nameRes.removed === true,
    ...(nameRes.ok === false ? { nameNote: nameRes.error } : {}),
    dataDir: st.dataDir,
    note: '账本留历史，不做物理删除',
  };
}

/**
 * 删「只有名字、账本里一条观察都没有」的孤键 —— 旧树 `removeNameOnlyMember` 的新树对应物。
 *
 * 旧树要有这条路由，是因为一个人一份 `people/_n_<名字>.json`：没 QQ 号的壳用数字路由删不掉。
 * 新树按 `subjectId` 记观察，**不存在"没有 id 的人"**（`契约-改人物印象.md` §2 起就要求非空），
 * 所以这里能出现的同一种形状只剩一种：`subjects.json` 里有这个名字，但账本里这个
 * `subjectId` **连历史行都没有**（有历史的人不归这里 —— 那是 `removeMember`，撤生效观察、留版本链）。
 *
 * 失败 reason 可达四条（比 removeMember 多一条真的 `unreadable`）：
 *   · `not-found`：没给 name（旧树逐字：这里报 not-found 不报 bad-uid —— 这条路由根本没有 uid）/ 没有匹配的孤键
 *   · `unreadable`：`subjects.json` 在盘上但读不出来 ⇒ **一个键都没删**（旧树 N8-b2 的同一条区分）
 *   · `unlink-failed`：写回失败 ⇒ 已删的键如实进 `partial`
 *
 * @param {{name:string, dataDir:string}} input
 * @returns {Promise<object>} 成功 `{ok:true, deleted:true, removedKeys, dataDir}`
 */
export async function removeNameOnlyMember(input = {}) {
  const target = String(input.name ?? '').trim();
  const st = openStore(dirOf(input.dataDir));
  if (!target) return removalFailure('not-found', { dataDir: st.dataDir });
  const read = readSubjects({ dataDir: st.dataDir });
  if (!read.ok) return removalFailure('unreadable', { dataDir: st.dataDir, note: read.error });
  const withRows = new Set();
  for (const row of st.obs.values()) {
    if (row && row.t !== 'status-only') withRows.add(String(row.subjectId));
  }
  const matched = Object.keys(read.subjects).filter((key) => String(read.subjects[key]?.name ?? '').trim() === target);
  const shells = matched.filter((key) => !withRows.has(key));
  if (!shells.length) {
    return removalFailure('not-found', { dataDir: st.dataDir, matchedNameKeys: matched.length });
  }
  const removedKeys = [];
  for (const key of shells) {
    const res = removeSubjectName(key, { dataDir: st.dataDir });
    if (!res.ok) {
      return removalFailure('unlink-failed', {
        dataDir: st.dataDir, partial: { removed: removedKeys.length, of: shells.length, note: res.error },
      });
    }
    removedKeys.push(key);
  }
  return { ok: true, deleted: true, removedKeys: removedKeys.length, keys: removedKeys, dataDir: st.dataDir };
}

/**
 * 清掉某人当前的短期状态（旧树的 surface / 近况）。**返回 0/1 数字**，与旧树逐字同形
 * （HTTP 侧直接 `{ok:true, removed}` 透传，`src/app.js:3362`）。
 *
 * 两处与旧树不同，都是结构造成的，不是自由发挥：
 *   ① 旧树的 `kind`（body|mood|doing|wait|plan，`surfaceKindOf` `src/memory.js:470`）在新树
 *      **没有对应维度**：新树行上只有 `type`（topic|promise|question|recent）、`scope`、`chatKey`。
 *      所以本出口**不收 kind** —— 收一个只能假装有用的参数，比不收更坏。
 *      ⚠ 接口层那条 `?kind=` 查询串怎么办，归 luna2 裁（明确回 400 或忽略，都比静默半effect好）。
 *   ② 旧树同步改文件；新树撤回必须走 `retract`（带锁、发变更通知）⇒ **本出口是 async**。
 *   ③ 数字返回装不下失败明细 ⇒ 想细看的调用方传一个 `diagnostics` 对象，本函数往里写
 *      `{matched, retracted, missed, reason}`（`prompt` 侧 buildMessages 同一种用法）。
 *
 * 与旧树同的一点：**只清 D 层短期状态，不碰 C 层的稳定认识**（印象 / 事实 / 偏好）——
 * "清一下近况"不该把一个人长期的东西一起抹了（`store.js` 头 D 层与 C 层刻意分开）。
 *
 * @param {{subjectId:string, chatKey?:string|null, dataDir:string, operator?:string, diagnostics?:object}} input
 * @returns {Promise<number>} 1 = 这次确实清掉了东西；0 = 没有可清的（或撤回没落地，看 diagnostics）
 */
export async function clearSurface(input = {}) {
  const st = openStore(dirOf(input.dataDir));
  const diag = input.diagnostics && typeof input.diagnostics === 'object' ? input.diagnostics : null;
  const subj = String(input.subjectId ?? '').trim();
  const chatKey = input.chatKey == null ? null : String(input.chatKey);
  const targets = activeObservations(st).filter((row) => {
    if (String(row.subjectId) !== subj) return false;
    if (!isShortTermType(row.type)) return false;
    if (chatKey !== null && String(row.chatKey ?? '') !== chatKey) return false;
    return true;
  });
  if (diag) diag.matched = targets.length;
  if (!targets.length) {
    if (diag) diag.reason = 'no-active-surface';
    return 0;
  }
  const op = String(input.operator ?? 'operator').trim().slice(0, IMP_OPERATOR_MAX) || 'operator';
  const res = await retract(st, targets.map((row) => String(row.id)), {
    evidenceIds: [...new Set(targets.flatMap((row) => (row.evidenceIds || []).map(String)))],
    reason: `人工清近况（${op}）`,
    at: Date.now(),
    subjectId: subj,
  });
  const done = (res?.retracted ?? []).length;
  if (diag) {
    diag.retracted = done;
    diag.missed = targets.length - done;
    if (done < targets.length) diag.reason = 'retract-incomplete';
  }
  if (done > 0) {
    notifyObservationChange(st.dataDir, { action: 'retract', ids: (res.retracted || []).slice() });
    // 近况也是从证据推出来的：不写抑制，后台整理会拿同一批旧消息把它再写回来（与 forget 同理）。
    writeForgetSuppressions(st, targets, { reason: 'manual-surface-clear' });
  }
  // ★ 表层近况 store（surface.js）也一并清：老树 clearSurface 同时清 people/<uid>.json 的 surface 槽位。
  try {
    const surfaceMod = await import('./surface.js');
    surfaceMod.clearSurfaceFor({ dataDir: st.dataDir, userId: subj, chatKey });
  } catch { /* surface store 没建过就跳过 */ }
  return done > 0 ? 1 : 0;
}

/**
 * 模型门的**单次调用纪律**（2026-10-16）：把 `AbortSignal.timeout` 递给门（真取消），外加
 * `Promise.race` 一道硬墙 —— 门忘了尊重 signal 也不会把 HTTP 请求/清理任务挂死。
 * 超时返回 `{__gateTimeout:true}`，调用方按"没答"处理（不写、逐项回报），**绝不猜 YES/子类**。
 */
function askGateOnce(gate, args, timeoutMs) {
  const ms = Math.max(50, Number(timeoutMs) || CLEANUP_LIMITS.gatePerAskTimeoutMs);
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __gateTimeout: true }), ms);
  });
  let signal = null;
  try { signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(ms) : null; } catch { signal = null; }
  return Promise.race([
    Promise.resolve().then(() => gate(signal ? { ...args, signal } : args)),
    timeout,
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/** 门调用出错原因归类：abort/timeout ⇒ 'gate-timeout'，其余 ⇒ 'gate-threw'。 */
function gateErrorCode(error) {
  const name = String(error?.name ?? '');
  return (name === 'TimeoutError' || name === 'AbortError') ? 'gate-timeout' : 'gate-threw';
}

/**
 * ★ 2026-10-16（分项执行契约）：`cleanupAll({ actions })` 的**合法动作名**。
 * 与 HTTP/UI 共用，**不许改字段名**：`dedupeFuzzy`（A）/ `dedupeSemantic`（B）/ `refineTypes`（C）。
 */
export const CLEANUP_ACTION_NAMES = Object.freeze(['dedupeFuzzy', 'dedupeSemantic', 'refineTypes']);

/**
 * ★ 2026-10-16（分项执行契约）解析 `actions` 选择器：
 *   · **不传 `actions`** ⇒ 旧档：`apply:true` 只执行 A；B/C 一律不执行（**即使传了门**）；
 *   · 传数组 ⇒ **只有列出的动作**可能执行；没列出的**不写、不问门、不调模型**；
 *   · 非数组 / 出现非法项 ⇒ `invalid-actions`；空数组 ⇒ `empty-actions` —— 两者都 **fail-closed**
 *     （一个动作都不执行、零写入、零模型调用），由调用方如实回报。
 * @returns {{provided:boolean, selected:string[], invalid:string[], reasonCode:string}}
 */
export function parseCleanupActions(raw) {
  if (raw === undefined) return { provided: false, selected: ['dedupeFuzzy'], invalid: [], reasonCode: '' };
  if (!Array.isArray(raw)) return { provided: true, selected: [], invalid: [String(raw ?? '(null)')], reasonCode: 'invalid-actions' };
  const selected = [];
  const invalid = [];
  for (const item of raw) {
    const name = String(item ?? '').trim();
    if (CLEANUP_ACTION_NAMES.includes(name)) { if (!selected.includes(name)) selected.push(name); }
    else invalid.push(name || '(empty)');
  }
  if (invalid.length) return { provided: true, selected: [], invalid, reasonCode: 'invalid-actions' };
  if (!selected.length) return { provided: true, selected: [], invalid: [], reasonCode: 'empty-actions' };
  return { provided: true, selected, invalid: [], reasonCode: '' };
}

/**
 * 一键清理（旧树 `POST /api/memory-people/cleanup` → `cleanupAll`）。
 *
 * 三条口径（2026-10-16 分项执行契约）：
 *   · **默认只读盘点**：不传 `apply` 时一个字节都不写，只报"十步各自状态 + 三动作候选读数"
 *     （候选 ≠ 已改）；
 *   · **旧档 `{apply:true}`（不传 `actions`）**：只执行 A（模糊包含）；B/C 必须显式在 `actions` 里点名；
 *   · **分项执行 `{apply:true, actions:[…]}`**：合法项只有 `dedupeFuzzy`/`dedupeSemantic`/`refineTypes`，
 *     **只有列出的动作可能执行**（未列出的不写、不问门、不调模型）；B 还要 `semanticGate`、C 还要
 *     `typeGate`，缺门 ⇒ 该项 blocked、0 改动、不猜 YES/子类；`actions` 非法/为空 ⇒ **整体 fail-closed**
 *     （`ok:false` + `reasonCode`，一个动作都不执行）。
 *
 * 旧树十步里四步在新树结构上不可能发生（`notApplicable`）；三步真缺的现状写在 `notImplemented`
 * + `actions` 里 —— 不再用 0 计数冒充"清过了"。三动作的契约/预算/安全边界逐条抄自
 * `.tmp-dispatch/2026-10-15/aaf16f9c/` 的两份回执（一键清理缺口 + 清理三动事务边界）。
 * 只走 `retract`（标 retracted，永不物理删除）与未来的 `commit(supersedes)`；范围固定
 * subjectId × scope × chatKey；手工编辑锁内的 subject 整组跳过并如实回报。
 * @returns {Promise<object>} 十个旧字段一个不少、含义不变；`notApplicable` / `notImplemented` / `actions` / `apply` 是追加字段。
 */
export async function cleanupAll(input = {}) {
  // ★ 2026-10-16（分项执行契约）：先解析 `actions` —— 非法/为空**在这一步就 fail-closed**：不打开 store、
  //   不写、不调模型，只由一个忠实的返回说明"什么都没做、拦在哪"。
  const actionSelection = parseCleanupActions(input.actions);
  if (actionSelection.reasonCode) {
    return {
      ok: false, reasonCode: actionSelection.reasonCode,
      invalidActions: actionSelection.invalid.slice(0, 8),
      allowedActions: CLEANUP_ACTION_NAMES.slice(),
      apply: { requested: input.apply === true, changed: 0, selected: [] },
      note: 'actions 非法或为空 ⇒ fail-closed：一个动作都没执行、没有任何写入、没有调用模型',
      dataDir: dirOf(input.dataDir),
    };
  }
  const st = openStore(dirOf(input.dataDir));
  const actives = activeObservations(st);
  const subjects = readSubjects({ dataDir: st.dataDir });
  const apply = input.apply === true;
  const atNow = Date.now();
  const selectedActions = actionSelection.selected;
  /** 某动作是否**被选中且要执行**：未选中 ⇒ 不写、不问门、不调模型。 */
  const wants = (name) => apply && selectedActions.includes(name);
  /** 动作条目上的 `selected` 标：只反映选择器，不掺 `apply`。 */
  const isSelected = (name) => selectedActions.includes(name);
  // ★ 2026-10-16：模型门的调用纪律（**串行 + 单次超时 + 整次总预算**；调用方可用同名参数覆盖，
  //   0/非法 ⇒ 用 CLEANUP_LIMITS 的默认）。总预算在**每次问门之前**检查 ⇒ HTTP 请求不会无限挂在模型上。
  const gateTimeoutMs = Math.max(50, Number(input.gateTimeoutMs) || CLEANUP_LIMITS.gatePerAskTimeoutMs);
  // 总预算：**显式传 0 = 不给任何问门时间**（一次都不问，逐项记账）；省略/null/垃圾值 ⇒ 默认 30s（fail-closed）。
  const rawGateBudget = input.gateBudgetMs;
  const gateBudgetMs = (rawGateBudget === undefined || rawGateBudget === null || rawGateBudget === '')
    ? CLEANUP_LIMITS.gateTotalBudgetMs
    : Math.max(0, Number(rawGateBudget) || 0);
  const gateStartedAt = Date.now();
  const gateDiscipline = {
    serial: true,
    perAskTimeoutMs: gateTimeoutMs,
    totalBudgetMs: gateBudgetMs,
    maxAsk: CLEANUP_LIMITS.maxGateAsk,
  };

  // 手工编辑锁：与自动整理同一把锁、同一窗口（默认 4h，夹 [5min,24h]）—— 锁内 subject 整组跳过。
  // ★ 2026-10-16（独立审查 §4）：`manualEditLockMs` **只给产品确要换窗口的场景**；不传 ⇒ 用
  //   `manual-edit-lock.js` 的 `DEFAULT_LOCK_MS`（与 persona/自动整理同源）。**推荐调用方默认不传**——
  //   传了会和其它写入路径的锁窗口分叉（同一个人在这里解了锁、那边还锁着）。
  const impressions = actives.filter((row) => isCleanupImpression(row));
  const subjectIds = [...new Set(impressions.map((row) => String(row.subjectId ?? '')))].slice(0, CLEANUP_LIMITS.maxSubjects);
  const lockWindowMs = Number.isFinite(Number(input.manualEditLockMs)) && Number(input.manualEditLockMs) > 0
    ? Number(input.manualEditLockMs) : null;
  const lockedSubjects = filterLockedSubjects(subjectIds, st.dataDir, lockWindowMs);
  const isLocked = (subjectId) => lockedSubjects.has(String(subjectId ?? ''));

  // ── 候选规划（只读路径也出读数：下一次 apply 会做什么，先能预览、能核对）──
  const fuzzyPlan = planContainmentPairs(actives, { isLocked });
  const semanticPlan = planSemanticPairs(actives, {
    isLocked, excludeDropIds: new Set(fuzzyPlan.pairs.map((pair) => pair.dropId)),
  });
  const typeSurvey = surveyTypeRefinement(actives, { guess: guessImpressionType, isLocked });
  // 动作 C 的**候选**只来自"新写入且明确没有子类"的行（impressionTypeSource==='none'）——
  // 历史行没有这个键、事后不可反推 ⇒ 一律不进候选（见 cleanup-actions.js 的 planTypeRefinements）。
  const typePlan = planTypeRefinements(actives, { guess: guessImpressionType, isLocked });

  const claimsById = new Map(actives.map((row) => [String(row.id), String(row.claim ?? '')]));
const candidatePreviewLimit = 20;
const dedupeFuzzyPreviewRows = fuzzyPlan.pairs.slice(0, candidatePreviewLimit).map((pair) => ({
  groupKey: pair.groupKey,
  keepId: pair.keepId,
  dropId: pair.dropId,
  keepClaim: claimsById.get(pair.keepId) || '',
  dropClaim: claimsById.get(pair.dropId) || '',
  reasonCode: pair.reasonCode,
}));
const semanticPreviewRows = semanticPlan.pairs.slice(0, candidatePreviewLimit).map((pair) => ({
  groupKey: pair.groupKey,
  keepId: pair.keepId,
  dropId: pair.dropId,
  keepClaim: claimsById.get(pair.keepId) || '',
  dropClaim: claimsById.get(pair.dropId) || '',
  sim: pair.sim,
}));
const typePreviewRows = typePlan.candidates.slice(0, candidatePreviewLimit).map((candidate) => ({
  id: candidate.id,
  groupKey: candidate.groupKey,
  subjectId: candidate.subjectId,
  scope: candidate.scope,
  chatKey: candidate.chatKey,
  claim: candidate.claim,
  guess: candidate.guess,
}));
const actions = {
    dedupeFuzzy: {
      selected: isSelected('dedupeFuzzy'), available: true, executed: false,
      reasonCode: isSelected('dedupeFuzzy') ? (apply ? '' : 'read-only') : 'not-selected',
      scanned: impressions.length, candidates: fuzzyPlan.pairs.length,
      applied: [], skipped: fuzzyPlan.skipped, failed: [],
       truncated: fuzzyPlan.truncated,
       candidatePreview: { total: fuzzyPlan.pairs.length, shown: Math.min(fuzzyPlan.pairs.length, candidatePreviewLimit), truncated: fuzzyPlan.pairs.length > candidatePreviewLimit, rows: dedupeFuzzyPreviewRows },
       limits: { maxPairsPerSubject: CLEANUP_LIMITS.maxPairsPerSubject, maxApplyPerRun: CLEANUP_LIMITS.maxApplyPerRun },
    },
    dedupeSemantic: {
      selected: isSelected('dedupeSemantic'),
      available: typeof input.semanticGate === 'function', executed: false,
      reasonCode: isSelected('dedupeSemantic') ? 'no-semantic-gate' : 'not-selected',
      scanned: impressions.length, candidates: semanticPlan.pairs.length,
       applied: [], skipped: semanticPlan.skipped, failed: [], asked: 0,
       window: [CLEANUP_LIMITS.semanticMinSim, CLEANUP_LIMITS.semanticMaxSim],
       candidatePreview: { total: semanticPlan.pairs.length, shown: Math.min(semanticPlan.pairs.length, candidatePreviewLimit), truncated: semanticPlan.pairs.length > candidatePreviewLimit, rows: semanticPreviewRows },
       gate: gateDiscipline,
      wiring: 'cleanupAll({ apply:true, semanticGate })—— **调用纪律已就位**（本函数强制执行：串行 + 单次'
        + ' gateTimeoutMs 超时[signal 真取消 + Promise.race 硬墙] + 整次 gateBudgetMs 总预算 + maxGateAsk 上限；'
        + '超时/预算耗尽逐项记账，绝不猜 YES）。**provider 已接通**（2026-10-16）：装配层备好 '
        + '`modulesObj.memoryCleanupGates`（llm 的 budgeted 调用 + llmBudgetService 真预留/结算 + 记忆域模型解析，'
        + 'purpose=`memory_cleanup_gate`），HTTP 端点在 `{apply:true, gate:"semantic"|"both"}` 时注入；'
        + '旧本地 Jev / roles 两条候选链**未采用**（不需要）。契约：async (pair) => ({ label:"YES"|"NO", '
        + 'abstain?, error? }) | "YES"|"NO"',
    },
    refineTypes: {
      selected: isSelected('refineTypes'),
      available: typeof input.typeGate === 'function', executed: false,
      reasonCode: isSelected('refineTypes') ? 'no-type-gate' : 'not-selected',
      scanned: typePlan.scanned, candidates: typePlan.candidates.length,
      applied: [], skipped: typePlan.skipped, failed: [], asked: 0,
      alreadyTyped: typePlan.alreadyTyped,            // 模型/门给过子类 ⇒ 不在候选里（"给过的不动"）
      historicalBlocked: typePlan.historicalBlocked,  // 没有 provenance 的旧行：不可反推 ⇒ 一律不动（裁定）
      truncated: typePlan.truncated,
      gate: gateDiscipline,
       survey: { guessHistogram: typeSurvey.guessHistogram, rows: typeSurvey.rows.slice(0, 50) },
       candidatePreview: { total: typePlan.candidates.length, shown: Math.min(typePlan.candidates.length, candidatePreviewLimit), truncated: typePlan.candidates.length > candidatePreviewLimit, rows: typePreviewRows },
       blockers: [
        "缺 typeGate（模型门）：没有它一律 0 改动、不猜子类（老树同形：!localJevHasRole('impressionTypeGate') ⇒ return 0）",
        '历史行（没有 impressionTypeSource 键）事后不可反推 ⇒ 一律不进候选（回执裁定；只动新写入且明确没子类的行）',
      ],
      wiring: 'cleanupAll({ apply:true, typeGate })—— 调用纪律同 B（串行 / 单次 gateTimeoutMs / 总预算 '
        + 'gateBudgetMs / maxGateAsk；超时按"没答"处理、不猜子类）。**provider 已接通**（2026-10-16）：'
        + '装配层备好 `modulesObj.memoryCleanupGates`（记忆域模型解析 + llm budgeted 调用 + llmBudgetService '
        + '真预留/结算，purpose=`memory_cleanup_gate`），HTTP 端点在 `{apply:true, gate:"type"|"both"}` 时注入。'
        + '契约：async (row) => ({ label:"identity"|"preference"|"edge"|"style"|"event"|"attitude"|null, '
        + 'abstain?, error? }) | "<子类>"；只对带 impressionTypeSource:"none" 的新行生效，历史行保持 blocked',
    },
  };

  /** 逐条撤回（一条一调：部分失败才说得清"哪条真改了、哪条没改"）。 */
  const retractOne = async (dropId, reasonCode) => {
    const row = st.obs.get(String(dropId));
    if (!row || row.status !== 'active') return { ok: false, reasonCode: 'not-active' };
    const res = await retract(st, [String(dropId)], {
      evidenceIds: (row.evidenceIds || []).map(String),
      reason: `一键清理 · ${reasonCode}`,
      at: atNow,
      subjectId: row.subjectId,
    });
    const done = (res?.retracted ?? []).some((id) => String(id) === String(dropId));
    return { ok: done, reasonCode: done ? '' : 'retract-noop' };
  };

  if (apply) {
    // A：确定性包含判据，逐条撤回更晚的一行（保留更早的；不写来源抑制 —— 抑制是 speaker 级的，
    //    会把保留下来的那条的后续证据一起压掉，见 writeForgetSuppressions 的粒度）。
    // ★ 2026-10-16（分项执行契约）：**只有被选中的动作才执行**；未选中 ⇒ 一个字节都不改。
    if (wants('dedupeFuzzy')) {
      actions.dedupeFuzzy.executed = true;
      const fuzzyBudget = fuzzyPlan.pairs.slice(0, CLEANUP_LIMITS.maxApplyPerRun);
      for (const pair of fuzzyBudget) {
        try {
          const res = await retractOne(pair.dropId, '模糊包含去重（apply）');
          if (res.ok) actions.dedupeFuzzy.applied.push({ dropId: pair.dropId, keepId: pair.keepId, reasonCode: 'fuzzy-containment' });
          else actions.dedupeFuzzy.failed.push({ id: pair.dropId, reasonCode: res.reasonCode });
        } catch (error) {
          actions.dedupeFuzzy.failed.push({ id: pair.dropId, reasonCode: 'retract-threw', error: String(error?.message ?? error).slice(0, 160) });
        }
      }
      if (fuzzyPlan.pairs.length > fuzzyBudget.length) {
        actions.dedupeFuzzy.failed.push({ id: '', reasonCode: 'apply-budget-exhausted', remaining: fuzzyPlan.pairs.length - fuzzyBudget.length });
      }
      if (actions.dedupeFuzzy.applied.length) {
        notifyObservationChange(st.dataDir, { action: 'retract', ids: actions.dedupeFuzzy.applied.map((row) => row.dropId) });
      }
    }

    // B：只认门的 YES；NO 记 skipped、门不可用/弃权/抛错记 failed —— 一个字节都不改（回执 B + 老树 :1463）。
    //    ★ 2026-10-16：**未选中就不问门、不调模型**（`wants` 同时要求 apply 与选中）。
    if (wants('dedupeSemantic') && actions.dedupeSemantic.available) {
      actions.dedupeSemantic.executed = true;
      actions.dedupeSemantic.reasonCode = '';
      const gateBudget = semanticPlan.pairs.slice(0, Math.min(CLEANUP_LIMITS.maxGateAsk, CLEANUP_LIMITS.maxApplyPerRun));
      for (const pair of gateBudget) {
        // ★ 总预算在每次问门**之前**检查（串行 + 单次超时见 askGateOnce）：预算耗尽就停手，剩下的如实记账。
        if (Date.now() - gateStartedAt >= gateBudgetMs) {
          actions.dedupeSemantic.failed.push({ id: '', reasonCode: 'gate-time-budget-exhausted', remaining: gateBudget.length - actions.dedupeSemantic.asked });
          break;
        }
        // ★ 2026-10-16（provider 接线）：门要**原文**才判得出来 ⇒ 从账本取两条的 claim；
        //   行没了/已被撤回/claim 为空 ⇒ 不进模型（也不计 ask），逐项如实记 `claim-unavailable`。
        const keepRow = st.obs.get(String(pair.keepId));
        const dropRow = st.obs.get(String(pair.dropId));
        if (!keepRow || !dropRow || !String(keepRow.claim ?? '') || !String(dropRow.claim ?? '')) {
          actions.dedupeSemantic.failed.push({ id: pair.dropId, reasonCode: 'claim-unavailable' });
          continue;
        }
        actions.dedupeSemantic.asked += 1;
        let verdict = 'UNAVAILABLE';
        try {
          const raw = await askGateOnce(input.semanticGate, {
            keepId: pair.keepId, dropId: pair.dropId, sim: pair.sim, groupKey: pair.groupKey,
            keepClaim: String(keepRow.claim), dropClaim: String(dropRow.claim)
          }, gateTimeoutMs);
          // 门的形状与老树 `jevGate` 对齐：`{ label:'YES'|'NO', abstain?, error? }`；也接受裸字符串。
          if (raw?.__gateTimeout === true) verdict = 'TIMEOUT';
          else if (typeof raw === 'string') verdict = raw.trim().toUpperCase();
          else if (raw && typeof raw === 'object') {
            verdict = (raw.error || raw.abstain === true) ? 'UNAVAILABLE' : String(raw.label ?? '').trim().toUpperCase();
          }
        } catch (error) {
          actions.dedupeSemantic.failed.push({ id: pair.dropId, reasonCode: gateErrorCode(error), error: String(error?.message ?? error).slice(0, 160) });
          continue;
        }
        if (verdict === 'TIMEOUT') {
          actions.dedupeSemantic.failed.push({ id: pair.dropId, reasonCode: 'gate-timeout', timeoutMs: gateTimeoutMs });
          continue;
        }
        if (verdict === 'YES') {
          try {
            const res = await retractOne(pair.dropId, '语义重复（apply）');
            if (res.ok) actions.dedupeSemantic.applied.push({ dropId: pair.dropId, keepId: pair.keepId, sim: pair.sim });
            else actions.dedupeSemantic.failed.push({ id: pair.dropId, reasonCode: res.reasonCode });
          } catch (error) {
            actions.dedupeSemantic.failed.push({ id: pair.dropId, reasonCode: 'retract-threw', error: String(error?.message ?? error).slice(0, 160) });
          }
        } else if (verdict === 'NO') {
          actions.dedupeSemantic.skipped = [...actions.dedupeSemantic.skipped, { id: pair.dropId, reason: 'gate-no' }];
        } else {
          actions.dedupeSemantic.failed.push({ id: pair.dropId, reasonCode: 'gate-unavailable' });
        }
      }
      if (semanticPlan.pairs.length > gateBudget.length) {
        actions.dedupeSemantic.failed.push({ id: '', reasonCode: 'gate-ask-cap-exhausted', remaining: semanticPlan.pairs.length - gateBudget.length });
      }
      if (actions.dedupeSemantic.applied.length) {
        notifyObservationChange(st.dataDir, { action: 'retract', ids: actions.dedupeSemantic.applied.map((row) => row.dropId) });
      }
    }
    // C：只认门的**子类判定**（老树 6 类之一）；NO/弃权/不可用/抛错一律不动、逐项回报
    //    （老树 :1497-1499 同口径）。写入走 `commit + supersedes`：新版本带 impressionType 与
    //    source 'gate'，旧版留档；store.js 的写序已是"先落新行、再标旧版"（失败至少保住旧版）。
    if (wants('refineTypes') && actions.refineTypes.available) {
      actions.refineTypes.executed = true;
      actions.refineTypes.reasonCode = '';
      const typeBudget = typePlan.candidates.slice(0, Math.min(CLEANUP_LIMITS.maxGateAsk, CLEANUP_LIMITS.maxApplyPerRun));
      for (const candidate of typeBudget) {
        // ★ 与 B 同一套纪律：总预算先查、单次超时走 askGateOnce（串行；超时按"没答"处理，不猜子类）。
        if (Date.now() - gateStartedAt >= gateBudgetMs) {
          actions.refineTypes.failed.push({ id: '', reasonCode: 'gate-time-budget-exhausted', remaining: typeBudget.length - actions.refineTypes.asked });
          break;
        }
        actions.refineTypes.asked += 1;
        let label = '';
        let timedOut = false;
        try {
          const raw = await askGateOnce(input.typeGate, {
            id: candidate.id, subjectId: candidate.subjectId, claim: candidate.claim,
            guess: candidate.guess, groupKey: candidate.groupKey,
          }, gateTimeoutMs);
          // 门形状与老树 jevGate 对齐：`{ label, abstain?, error? }`；也接受裸字符串。
          if (raw?.__gateTimeout === true) timedOut = true;
          else if (typeof raw === 'string') label = raw.trim();
          else if (raw && typeof raw === 'object') label = (raw.error || raw.abstain === true) ? '' : String(raw.label ?? '').trim();
        } catch (error) {
          actions.refineTypes.failed.push({ id: candidate.id, reasonCode: gateErrorCode(error), error: String(error?.message ?? error).slice(0, 160) });
          continue;
        }
        if (timedOut) {
          actions.refineTypes.failed.push({ id: candidate.id, reasonCode: 'gate-timeout', timeoutMs: gateTimeoutMs });
          continue;
        }
        if (!IMP_TYPES.includes(label)) {
          actions.refineTypes.skipped.push({ id: candidate.id, reason: label ? 'gate-label-not-a-subtype' : 'gate-no-answer' });
          continue;
        }
        const row = st.obs.get(String(candidate.id));
        if (!row || row.status !== 'active') { actions.refineTypes.failed.push({ id: candidate.id, reasonCode: 'not-active' }); continue; }
        try {
          const res = await commit({
            subjectId: row.subjectId, claim: row.claim, type: row.type,
            scope: row.scope, kind: row.kind, chatKey: row.chatKey,
            confidence: Number(row.confidence),
            at: Number(row.at) || atNow,          // ★ 保留原时间：升级只补子类，不改这条印象的"新旧"
            evidenceIds: (row.evidenceIds || []).map(String),
            counterEvidenceIds: (row.counterEvidenceIds || []).map(String),
            impressionType: label,
            impressionTypeSource: 'gate',
            supersedes: String(row.id),
            ...(row.validUntil !== undefined && row.validUntil !== null ? { validUntil: row.validUntil } : {}),
            ...(row.crossChatShareable === true ? { crossChatShareable: true } : {}),
            ...(row.schemaVersion !== undefined ? { schemaVersion: row.schemaVersion } : {}),
            ...(row.namespace !== undefined ? { namespace: row.namespace } : {}),
            ...(row.memoryClass !== undefined ? { memoryClass: row.memoryClass } : {}),
            ...(row.factSlot !== undefined ? { factSlot: row.factSlot } : {}),
            ...(row.origin !== undefined ? { origin: row.origin } : {}),
            ...(row.sourceRefs !== undefined ? { sourceRefs: row.sourceRefs } : {}),
            ...(row.todoId !== undefined ? { todoId: row.todoId } : {}),
          }, {
            dataDir: st.dataDir,
            persona2: row.persona2 === true,      // 归属标原样继承（只打标、不拦写）
            idempotencyKey: `cleanup-refine:${row.id}:${label}`,
          });
          if (res?.ok === true && res.duplicate !== true && res.replay !== true) {
            // ★ 2026-10-16：部分成功（新版本已落、旧版 status 行/审计行缺）如实带出来，不吞。
            actions.refineTypes.applied.push({
              id: candidate.id, version: res.version ?? null, impressionType: label, guess: candidate.guess || null,
              ...(res.partial === true ? { partial: true, warnings: (res.warnings || []).slice(0, 4) } : {}),
            });
          } else if (res?.ok === true) {
            actions.refineTypes.skipped.push({ id: candidate.id, reason: 'replay' });   // 幂等重放：不重复升版
          } else {
            actions.refineTypes.failed.push({ id: candidate.id, reasonCode: 'commit-rejected', errors: (res?.errors || []).slice(0, 3) });
          }
        } catch (error) {
          actions.refineTypes.failed.push({ id: candidate.id, reasonCode: 'commit-threw', error: String(error?.message ?? error).slice(0, 160) });
        }
      }
      if (typePlan.candidates.length > typeBudget.length) {
        actions.refineTypes.failed.push({ id: '', reasonCode: 'gate-ask-cap-exhausted', remaining: typePlan.candidates.length - typeBudget.length });
      }
      // commit() 内部已 `notifyObservationChange({action:'commit'})` ⇒ 这里不重复喊。
    }
  }

  const deduped = actions.dedupeFuzzy.applied.length;
  const semanticMerged = actions.dedupeSemantic.applied.length;
  const typesRefined = actions.refineTypes.applied.length;
  return {
    ok: true,
    merged: 0, mergedQq: 0, purged: 0, deduped, semanticMerged, typesRefined,
    droppedDuplicates: 0, mergeFailures: [], surfacePruned: 0, surfaceFiles: 0,
    scanned: {
      activeObservations: actives.length,
      impressions: impressions.length,
      ledgerRows: st.obs.size,
      namedSubjects: subjects.ok ? Object.keys(subjects.subjects).length : null,
      lockedSubjects: lockedSubjects.size,
      badLedgerLines: st.badLines ?? 0,
      // ★ 2026-10-16：装载对账派生出来的 superseded 条数（磁盘缺 status 行的那些；只在内存里派生，文件不动）
      ...(st.derivedSupersedes ? { derivedSupersedes: st.derivedSupersedes } : {}),
      ...(subjects.ok ? {} : { subjectsUnreadable: subjects.error }),
    },
    apply: { requested: apply, changed: deduped + semanticMerged + typesRefined, selected: selectedActions.slice() },
    actions,
    notApplicable: [
      { step: 'mergeSameUserIds / mergeNameOnlyIntoUserIds', why: '新树按 subjectId 记观察，一个人不会散成多份文件，也没有"无号的人"' },
      { step: 'purgeBadPeople', why: '名字只有一个写者（setSubjectName，人工改印象时才写），不会出现句子状的自动垃圾名' },
      { step: 'dedupeImpressions（同一条判据那半）', why: 'store.js:352 写入侧同 claimKey 只留一条生效，重复在写的时候就判掉了' },
      { step: 'pruneSurface', why: '短期状态走读时年龄闸（working-window.js），账本一个字不删 —— 这是设计，不是漏实现' },
    ],
    notImplemented: [
      { step: 'dedupeImpressions（"互相包含就算重复"那半模糊判据）', why: '判据与撤回已实现（cleanup-actions.js + cleanupAll({apply:true, actions:["dedupeFuzzy"]})；旧档 {apply:true} 等价）；**HTTP 默认仍只读、面板按钮下一轮再接** —— 见 actions.dedupeFuzzy' },
      { step: 'dedupeImpressionsSemantic', why: '候选可算（bigram Jaccard 0.22–0.8，见 actions.dedupeSemantic.candidates）；YES/NO 由模型门裁决（provider 已接通，purpose=memory_cleanup_gate）；HTTP 要 `{apply:true, actions:["dedupeSemantic"], gate:"semantic"}` 才执行 —— 见 actions.dedupeSemantic' },
      { step: 'refineImpressionTypes', why: '执行路径已就绪（`{apply:true, actions:["refineTypes"], gate:"type"}`，只动带 impressionTypeSource:"none" 的新行）；未选中或缺门一律 0 改动，历史行不可反推 ⇒ 保持 blocked —— 见 actions.refineTypes' },
    ],
    dataDir: st.dataDir,
    note: '本出口不删任何东西（撤回 = 账本标 retracted、升版 = 新版本 + 旧版留档）；默认只读；'
      + '`{apply:true}` 只执行 A，B/C 必须在 `actions:[…]` 里显式点名（还要注入各自的门）；'
      + '未选中或缺门 ⇒ 0 改动、不调模型；`actions` 非法/为空 ⇒ 整体 fail-closed',
  };
}

// ═════════════════════════════════════════════════════════════════════════
// 只读：变更与来源
// ═════════════════════════════════════════════════════════════════════════

/**
 * 只读审计（给 UI/排障）：变更了什么、依据哪条证据。
 * 与 `readAuditLog`（旧 memory-audit，好感/印象账）不同 —— 这里是记忆域的**观察变更**账。
 * 范围规则同样适用：别群的群内细节**不出现在本会话的审计里**（global 印象照常可见）。
 */
export function audit({ chatKey, kind = 'group', n = 20, subjectId, dataDir } = {}) {
  const st = openStore(dirOf(dataDir));
  const cap = Math.max(1, Math.min(200, Math.floor(Number(n) || 20)));
  const ctx = { chatKey, kind };
  const rows = [];
  for (let i = st.changes.length - 1; i >= 0 && rows.length < cap; i -= 1) {
    const row = changeRows(st)[i];
    if (!row) continue;
    if (subjectId && String(row.subjectId ?? '') !== String(subjectId)) continue;
    if (chatKey !== undefined && !visibleIn({ scope: row.scope, chatKey: row.chatKey }, ctx).ok) continue;
    const sources = (row.evidenceIds || []).map((id) => {
      const ev = getEvidence(st, id);
      return {
        evidenceId: id,
        known: !!ev,
        sourceType: ev?.sourceType ?? null,
        speakerId: ev?.speakerId ?? null,
        at: ev?.at ?? null,
        chatKey: ev?.chatKey ?? null,
      };
    });
    rows.push({
      at: row.at, ts: row.ts, action: row.action, id: row.id ?? null, subjectId: row.subjectId ?? null,
      claim: row.claim ?? null, scope: row.scope ?? null, chatKey: row.chatKey ?? null,
      version: row.version ?? null, supersedes: row.supersedes ?? null, reason: row.reason ?? null,
      evidenceIds: (row.evidenceIds || []).slice(), sources,
    });
  }
  return { ok: true, n: rows.length, rows, total: st.changes.length, dataDir: st.dataDir };
}

/** 某个 claim / subject 的**全部版本**（含被 supersede / retracted 的旧版 —— 历史不丢）。 */
export function history({ subjectId, claim, scope, dataDir } = {}) {
  const st = openStore(dirOf(dataDir));
  const rows = versionsOf(st, { subjectId, claim, scope }).map((row) => ({
    id: row.id, subjectId: row.subjectId, claim: row.claim, scope: row.scope, chatKey: row.chatKey ?? '',
    version: row.version ?? 1, status: row.status, at: row.at, confidence: row.confidence,
    evidenceIds: (row.evidenceIds || []).slice(), counterEvidenceIds: (row.counterEvidenceIds || []).slice(),
    supersedes: row.supersedes ?? null, supersededBy: row.supersededBy ?? null, retractedBy: row.retractedBy ?? null,
    current: row.status === 'active',
    // ★ 2026-10-11（指挥位转 sp3 实测 · 与 `correction` 同族的两处漏项）：`history()` 按白名单挑字段输出，
    //   原先不带 `correction` / `type` ⇒ ① `prompt/index.js:607` 那侧的更正判据在"走历史"这条路上永远为假；
    //   ② 面板语义卡每张的 `type` 一直是 null（`api/memory.js:562` 的 `obs?.type ?? null` 取不到值）。
    //   ★★ 统一做法："数据文件里没有这个键 ⇒ 返回里也不出现这个键"：**不许**写 `type: row.type ?? 'impression'`
    //     或 `correction: row.correction ?? false` —— 那会把老数据伪造成"有值"，正是本项目反复在排查的那类问题。
    //   （现在的新观察两条都有：`store.js:382` 落 `type`、`store.js:393/418` 只在真更正时落 `correction`。）
    ...(row.type !== undefined ? { type: row.type } : {}),
    ...(row.correction !== undefined ? { correction: row.correction } : {}),
    // ★ 2026-10-16（一键清理 C 的安全前提）：印象子类与 provenance 也进历史（"没有这个键 ⇒ 返回里也不出现"——
    //   历史行照旧不带，与上一行 correction/type 同一条纪律）。
    ...(row.impressionType !== undefined ? { impressionType: row.impressionType } : {}),
    ...(row.impressionTypeSource !== undefined ? { impressionTypeSource: row.impressionTypeSource } : {}),
    ...(row.schemaVersion !== undefined ? { schemaVersion: row.schemaVersion } : {}),
    ...(row.namespace !== undefined ? { namespace: row.namespace } : {}),
    ...(row.memoryClass !== undefined ? { memoryClass: row.memoryClass } : {}),
    ...(row.factSlot !== undefined ? { factSlot: row.factSlot } : {}),
    ...(row.origin !== undefined ? { origin: row.origin } : {}),
    ...(row.sourceRefs !== undefined ? { sourceRefs: row.sourceRefs } : {}),
    ...(row.todoId !== undefined ? { todoId: row.todoId } : {})
  }));
  return { ok: true, versions: rows, dataDir: st.dataDir };
}

/** 卡片视图：`writes`（写入次数）与 `hits`（命中次数）分开记 —— 验收第 10 条。 */
export function cards({ dataDir } = {}) {
  const st = openStore(dirOf(dataDir));
  return { ok: true, cards: cardRows(st), orphanHits: orphanHitCount(st), dataDir: st.dataDir };
}

/**
 * E 快速档案：给提示词用的**极短可重建摘要**（只是视图，不是新事实源）。
 * 由 retrieve 现算，不新写文件（除了命中计数）。
 */
export async function brief(ctx = {}) {
  const res = await retrieve({ ...ctx, need: { ...(ctx.need || {}), limit: ctx.need?.limit ?? 5 } });
  const lines = res.items.map((it) => {
    const claim = String(it.claim).replace(/\s+/g, ' ').trim();
    return `[${it.scope}] ${claim}${it.evidenceIds.length ? ` (证据 ${it.evidenceIds.join(',')})` : ''}`;
  });
  return { lines, evidenceIds: res.items.flatMap((it) => it.evidenceIds), items: res.items, dataDir: res.dataDir };
}

/** 只读计数（排障/自测用）：账本里各有多少条。 */
export function stats({ dataDir } = {}) {
  const st = openStore(dirOf(dataDir));
  return {
    ok: true, dataDir: st.dataDir,
    evidence: st.evidence.size,
    observations: [...st.obs.values()].filter((r) => r.t !== 'status-only').length,
    active: activeObservations(st).length,
    cards: st.claims.size,
    changes: st.changes.length,
    badLines: st.badLines,
  };
}

/**
 * ★ 按人物印象条数的**真实只读计数**（老树 `src/memory.js:2352 consolidationState` 的数据源对应物）。
 *
 * 只数 `activeObservations` 里 `type === 'impression'` 的行，按 subjectId 分组。
 * **不拿消息观察数冒充印象数**（`stats().observations` 是全部类型，不是印象）。
 *
 * @param {{dataDir?:string|null, chatKey?:string}} [input]
 *   chatKey 给了就只数该会话相关的印象（`chatKey` 匹配或 `scope==='global'`）；不给数全部。
 * @returns {{counts:{memberImpression:number}, members:Array<{subjectId:string, count:number}>}}
 *   形状对齐老树 `consolidationState` 的 `{counts:{memberImpression}, members:[{userId,count}]}`。
 */
export function activeImpressionCountsBySubject({ dataDir = null, chatKey = '' } = {}) {
  const st = openStore(dirOf(dataDir));
  const bySubject = new Map();
  let total = 0;
  for (const row of activeObservations(st)) {
    if (row.type !== 'impression') continue;
    if (chatKey && String(row.chatKey ?? '') !== String(chatKey) && row.scope !== 'global') continue;
    const sid = String(row.subjectId ?? '').trim();
    if (!sid) continue;
    bySubject.set(sid, (bySubject.get(sid) || 0) + 1);
    total += 1;
  }
  return {
    counts: { memberImpression: total },
    members: [...bySubject.entries()].map(([subjectId, count]) => ({ subjectId, count })),
  };
}

function inspectStatusFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { exists: true, readable: false, modifiedAt: null, error: 'not-a-file' };
    fs.accessSync(file, fs.constants.R_OK);
    return {
      exists: true,
      readable: true,
      modifiedAt: Number.isFinite(stat.mtimeMs) ? new Date(stat.mtimeMs).toISOString() : null,
      modifiedAtMs: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null,
      error: null,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, readable: true, modifiedAt: null, modifiedAtMs: null, error: null };
    return { exists: true, readable: false, modifiedAt: null, modifiedAtMs: null, error: error?.code ?? 'io-error' };
  }
}

function countMalformedJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { return error?.code === 'ENOENT' ? 0 : null; }
  let badLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { JSON.parse(line); } catch { badLines += 1; }
  }
  return badLines;
}

function inspectTodosFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return { total: 0, byStatus: {}, valid: true, error: null };
    return { total: null, byStatus: null, valid: false, error: error?.code ?? 'io-error' };
  }
  try {
    const parsed = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
    if (!Array.isArray(parsed?.todos)) return { total: null, byStatus: null, valid: false, error: 'missing-todos-array' };
    const byStatus = {};
    for (const todo of parsed.todos) {
      const state = String(todo?.status ?? 'unknown');
      byStatus[state] = (byStatus[state] || 0) + 1;
    }
    return { total: parsed.todos.length, byStatus, valid: true, error: null };
  } catch {
    return { total: null, byStatus: null, valid: false, error: 'invalid-json' };
  }
}

/**
 * Runtime memory health snapshot for the server's `/api/memory-guard` adapter.
 * Counts come from the active in-process ledger plus the episode/share ledgers on disk;
 * no defaults are substituted when a source cannot be read.
 */
export async function runtimeStatus({ dataDir, coordinator = null } = {}) {
  const checkedAt = new Date().toISOString();
  let resolvedDataDir;
  try {
    resolvedDataDir = path.resolve(dirOf(dataDir));
  } catch {
    return {
      ok: false,
      checkedAt,
      counts: null,
      files: null,
      lastWriteAt: null,
      coordinator: null,
      semanticIndex: null,
      health: { state: 'degraded', reasons: ['data-dir-unavailable'], inputs: { storeLoaded: null, badLines: null } },
      error: 'data-dir-unavailable',
    };
  }

  const st = openStore(resolvedDataDir);
  const storeFiles = { ...st.files };
  const memoryPath = (name) => path.join(resolvedDataDir, 'memory', name);
  const filePaths = {
    ...storeFiles,
    episodes: memoryPath('episodes.jsonl'),
    consolidationState: memoryPath('consolidation-state.json'),
    suppressions: memoryPath('suppressions.jsonl'),
    impressionShares: memoryPath('impression-share.jsonl'),
    todos: path.join(resolvedDataDir, 'pending-todos.json'),
  };
  const files = Object.fromEntries(Object.entries(filePaths).map(([key, file]) => [key, inspectStatusFile(file)]));
  const episodeInspection = inspectEpisodeRows(resolvedDataDir);
  const todoInspection = inspectTodosFile(filePaths.todos);
  const suppressionLedger = suppressionTable({ dataDir: resolvedDataDir });
  const shareLedgerState = shareLedger({ dataDir: resolvedDataDir });
  const observationRows = [...st.obs.values()].filter((row) => row?.t !== 'status-only');
  const activeRows = activeObservations(st);
  const observationCounts = Object.fromEntries(OBS_TYPES.map((type) => [type, {
    total: observationRows.filter((row) => row.type === type).length,
    active: activeRows.filter((row) => row.type === type).length,
  }]));
  const unknownTypeRows = observationRows.filter((row) => !OBS_TYPES.includes(row.type));
  observationCounts.unknown = {
    total: unknownTypeRows.length,
    active: activeRows.filter((row) => !OBS_TYPES.includes(row.type)).length,
  };

  const unreadableFiles = Object.entries(files).filter(([, info]) => !info.readable).map(([name]) => name);
  const ledgerKeys = ['evidence', 'observations', 'changes', 'idempotency', 'hits'];
  const ledgerReadable = ledgerKeys.every((key) => files[key]?.readable === true);
  const observationsReadable = files.observations?.readable === true;
  const evidenceReadable = files.evidence?.readable === true;
  const changesReadable = files.changes?.readable === true;
  const suppressionReadable = files.suppressions?.readable === true;
  const sharesReadable = files.impressionShares?.readable === true;
  const episodesReadable = episodeInspection.readable === true && files.episodes?.readable === true;
  const suppressionActive = [...suppressionLedger.values()].filter((row) => row.suppressed === true).length;
  const sharedImpressions = [...shareLedgerState.table.values()].filter((row) => row.shared === true).length;
  const suppressionBadLines = countMalformedJsonl(filePaths.suppressions);
  const latestFile = Object.values(files)
    .filter((file) => file.exists && file.readable && Number.isFinite(file.modifiedAtMs))
    .reduce((latest, file) => Math.max(latest, file.modifiedAtMs), 0);

  let coordinatorStatus = null;
  let coordinatorError = null;
  if (coordinator && typeof coordinator.status === 'function') {
    try {
      coordinatorStatus = await coordinator.status();
    } catch (error) {
      coordinatorError = String(error?.message ?? error);
    }
  }
  const semanticIndex = coordinatorStatus?.semanticIndex ?? null;
  const semanticState = semanticIndex?.state ?? null;
  const badLineTotal = ledgerReadable && episodesReadable && suppressionReadable && sharesReadable && suppressionBadLines !== null
    ? st.badLines + (episodeInspection.badLines ?? 0) + suppressionBadLines + (shareLedgerState.badLines ?? 0)
    : null;
  const reasons = [];
  if (unreadableFiles.length) reasons.push(`unreadable-files:${unreadableFiles.join(',')}`);
  if (!todoInspection.valid) reasons.push(`todos-unavailable:${todoInspection.error}`);
  if (badLineTotal === null) reasons.push('bad-line-count-incomplete');
  if (badLineTotal > 0) reasons.push(`malformed-rows:${badLineTotal}`);
  if (coordinatorError) reasons.push('coordinator-status-unavailable');
  if (!coordinatorStatus) reasons.push('coordinator-not-attached');
  if (!semanticIndex) reasons.push('semantic-index-status-unavailable');
  if (['stale', 'version-incompatible', 'closed', 'error'].includes(semanticState)) reasons.push(`semantic-index-${semanticState}`);
  if (semanticIndex?.vectorStore?.readable === false) reasons.push('vector-store-unreadable');
  const failed = unreadableFiles.length > 0 || badLineTotal > 0
    || !todoInspection.valid
    || !!coordinatorError || ['stale', 'version-incompatible', 'closed', 'error'].includes(semanticState)
    || semanticIndex?.vectorStore?.readable === false;
  const healthState = failed ? 'degraded'
    : semanticState === 'ready' && coordinatorStatus && badLineTotal !== null ? 'healthy' : 'unknown';

  const lastRun = Number(coordinatorStatus?.semanticMaintenance?.lastRunAt);
  return {
    ok: true,
    checkedAt,
    counts: {
      evidence: evidenceReadable ? st.evidence.size : null,
      episodes: episodesReadable && Array.isArray(episodeInspection.rows) ? episodeInspection.rows.length : null,
      observations: observationsReadable ? {
        total: observationRows.length,
        active: activeRows.length,
        byType: observationCounts,
      } : null,
      impressions: observationsReadable ? observationCounts.impression : null,
      cards: observationsReadable ? st.claims.size : null,
      changes: changesReadable ? st.changes.length : null,
      idempotencyKeys: files.idempotency?.readable ? st.idem.size : null,
      cardHits: files.hits?.readable ? [...st.claims.values()].reduce((sum, card) => sum + card.hits, 0) : null,
      orphanHits: files.hits?.readable ? orphanHitCount(st) : null,
      suppressions: suppressionReadable ? { keys: suppressionLedger.size, active: suppressionActive } : null,
      crossChatImpressionShares: sharesReadable ? { records: shareLedgerState.table.size, active: sharedImpressions } : null,
      todos: todoInspection.valid ? { total: todoInspection.total, byStatus: todoInspection.byStatus } : null,
    },
    badLines: {
      ledger: ledgerReadable ? st.badLines : null,
      episodes: episodesReadable ? episodeInspection.badLines : null,
      suppressions: suppressionReadable ? suppressionBadLines : null,
      impressionShares: sharesReadable ? shareLedgerState.badLines : null,
      total: badLineTotal,
    },
    files: Object.fromEntries(Object.entries(files).map(([key, info]) => [key, {
      exists: info.exists, readable: info.readable, modifiedAt: info.modifiedAt, error: info.error,
    }])),
    lastWriteAt: latestFile > 0 ? new Date(latestFile).toISOString() : null,
    coordinator: coordinatorStatus ? {
      queues: coordinatorStatus.queues ?? null,
      running: coordinatorStatus.running ?? null,
      failed: coordinatorStatus.failed ?? null,
      unconsolidated: coordinatorStatus.unconsolidated ?? null,
      hasExtractor: coordinatorStatus.hasExtractor ?? null,
      hasSemantic: coordinatorStatus.hasSemantic ?? null,
      semanticMaintenance: {
        enabled: coordinatorStatus.semanticMaintenance?.enabled ?? null,
        pendingChanges: coordinatorStatus.semanticMaintenance?.pendingChanges ?? null,
        running: coordinatorStatus.semanticMaintenance?.running ?? null,
        lastRunAt: Number.isFinite(lastRun) && lastRun > 0 ? lastRun : null,
      },
    } : null,
    semanticIndex,
    health: {
      state: healthState,
      reasons,
      inputs: {
        storeLoaded: st.loaded === true,
        ledgerReadable,
        badLines: badLineTotal,
        lastWriteAt: latestFile > 0 ? new Date(latestFile).toISOString() : null,
        semanticState,
        vectorStoreReadable: semanticIndex?.vectorStore?.readable ?? null,
        coordinatorStatusAvailable: !!coordinatorStatus,
      },
    },
    source: {
      ledgerCounts: 'loaded runtime store maps',
      episodes: '<dataDir>/memory/episodes.jsonl parsed JSONL rows',
      timestamps: 'mtime of existing known memory ledgers and pending-todos.json',
      vectorStore: 'in-process semantic vector store; not persisted',
    },
    ...(coordinatorError ? { coordinatorError } : {}),
  };
}

/** 测试/装配用：丢弃内存态（不影响数据文件）。 */
export function resetMemory(dataDir) {
  closeStore(dataDir);
}

/** 重新从数据文件读回内存（模拟重启；验证"写进文件的内容真的能读回来"）。 */
export function reload(dataDir) {
  const st = openStore(dirOf(dataDir));
  closeStore(st.dataDir);
  return openStore(st.dataDir).dataDir;
}

export { memoryDir as dir };
export { getSubjectName } from './store.js';
