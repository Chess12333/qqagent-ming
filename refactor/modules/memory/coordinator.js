/**
 * M6 memory · 记忆协调服务（方案 §4.2「新增一个记忆协调服务」）
 *
 * 工厂：`createMemoryCoordinator({ dataDir, accountId, chatStore, todos, extract, chatModel, provider, model, semantic, clock, options })`
 * —— `extract` 可由装配层直接注入；也可注入 `chatModel/provider/model` 由 M6 构造抽取器。
 *    两种方式都不让 M6 直接依赖 llm 模块；`semantic` 可为空（方案 §4.2）。
 *
 * ★ 本轮（N34）按方案 §4.3 / §5.2 / §5.3 / §5.4 补的四件事，以及为什么原来不算数：
 *   ① **真队列**：改前 `requestConsolidation` 直接 `await extract(...)` 把活干在调用方线程上，
 *      而且**每次都新建 jobId**（同一个会话连点 10 次 = 10 个 job、10 次模型调用）。
 *      方案 §4.2 明写：「合并重复请求，返回 queued/jobId；**不在 HTTP 请求里扫描全部旧聊天**」。
 *      现在：合并成 1 个 job（返回既有 jobId + `merged:true`），真正干活在 `runNextJob()`（串行，可重入保护）。
 *   ② **游标「提交成功才推进」**：方案 §4.3：「整理队列采用『可重复执行 + 幂等提交』，
 *      **提交完成后才推进游标**；崩溃后可以重做未确认批次，不宣称天然恰好一次」。
 *      改前游标在 `observe()` 里就 +1（见到消息就推进）⇒ 崩溃/失败后那段消息**永远不会被再整理**。
 *      现在游标只在 `commitEpisodes()` 成功后推进；失败原样留在原地等重试。
 *   ③ **episodes 真生成**：改前只是把 `extract` 的返回原样 `appendFileSync`，**零校验** ——
 *      模型说啥写啥（空 summary 也写、引用不存在的事证据也写）。
 *      方案 §5.3 要求校验代码至少负责：引用 ID 存在、范围不扩大、**未引用 bot 心声为人物证据**、
 *      没有拿模型自报置信度代替证据。现在逐条校验，不合格的**拒收并如实记账**。
 *   ④ **抑制收口**：改前 `forget()` 之后，后台整理扫旧消息会把用户忘掉的事实**复活**。
 *      现在写任何 episode 前必过 `suppressions.js`。2026-10-11 补上另一半（P0-3 读端）：
 *      `prepareContext()` 取 episodes 时**再过一道**——只在写端拦没用，账本里**已经存在**的
 *      旧 episode 照样能把人忘掉的事原样送回提示词；同时 `forget()` 现在会真的写抑制记录
 *      （改前 `addSuppression()` 全树零调用，读端那道过滤永远拿到空表，拦不住任何东西）。
 *
 * ★ 没有 `extract` / 没有模型时的处理规则（方案 §5.3 + 硬规则「不许编造」）：
 *   job 状态是 `unconsolidated`（**未整理**），`episodes` 一条不写，
 *   `status()` 如实报 `reason:'no-extractor'`。**绝不生成占位摘要。**
 *
 * ── 不变量 ────────────────────────────────────────────────────────────────
 *   · 本模块**不 import llm**（extract/semantic 都是注入的函数或对象）。
 *   · 同一 dataDir 只由一个实例写；进程内锁**不当作跨进程事务锁**（方案 §4.3 原话）。
 *   · `consolidation-state.json` 用**临时文件 + rename 原子替换**，不半写。
 *   · `status()` 默认**不返回任何聊天正文**（方案 §4.2 表最后一行）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/util/index.js';
import { recordEvidence, retrieve, readMemory, commit, personaContext, evidenceVisibleToPersona, observationVisibleToPersona, isCorrectionObservation } from './index.js';
// ①（2026-10-14 派单·状态话题时效）：年龄闸判据只在 `working-window.js` 写一份；
//   关键词腿走 `retrieve()` 内部那道，语义腿必须在这里补同一条 —— 不然超期的状态条目会从语义这条腿绕进上下文。
import { resolveWorking, shortTermAgeVerdict } from './working-window.js';
import { selfRowVisibleNow } from '../emotion/persona-hygiene.js';
import { openStore, activeObservations, getEvidence, claimKeyOf } from './store.js';
// ★ 2026-10-16：召回条目形状归一两腿共用（语义腿原先只有 personId、没有 subjectId/type）。
import { recallItemShape } from './recall-item.js';
import { crossScopeSubjects } from './scope.js';
import { mergeWithKeyword, observationToRecords } from './semantic.js';
import { makeSuppressionFilter, namedSuppressedEvidenceIds, namesSuppressedSource, suppressionStats, addSuppression, ledgerHealthOf } from './suppressions.js';
import { buildCoverage } from './coverage.js';
import { subscribeObservationChanges } from './observation-events.js';
// ★ 2026-10-17（向量生产接线 · 派单②场）：语义卡/情节两类记录源并进同一个 sync 入流 ——
//   记录派生只在各自 store 写封（本文件不改 semantic.js 向核心向量模块的东西）。
import { semanticCardToRecord, cachedCardRows, cardCountOf } from './semantic-cards.js';
import {
  cachedEpisodeRows, episodeCount, latestEpisodeRowsById, episodeRowToRecord,
} from './episode-store.js';
import { subscribeLongtermChanges, notifyLongtermChange } from './longterm-events.js';
import { createMemoryExtractor } from './extractor.js';
import { filterLockedSubjects, getLockWindowMs } from './manual-edit-lock.js';

/** `memoryPolicy.mode` 的合法取值（判据侧 `orchestrator/index.js` 另有一份同值 Set，口径一致）。 */
export const MEMORY_POLICY_MODES = Object.freeze(['none', 'recent', 'long_term', 'mixed']);

/**
 * 归一 `memoryPolicy`（**ds3 侧决定、本模块只执行**）。
 *
 * ★ 与判据侧 `orchestrator/index.js` 的 `normalizeMemoryPolicy()`（JEV 那半）**同口径**：
 *   · 缺失 / 非对象 / 既没 recall 也没合法 mode ⇒ **保守召回** `{recall:true, mode:'mixed'}`（宁多勿漏）；
 *   · `mode:'none'` **只在 `recall:false` 时成立**；`recall:true` 时 none/非法 mode 一律按 `mixed`
 *     —— 不允许出现 `recall:true + mode:'none'`（会被下游当"跳过"读，误省）；`recall:false`
 *     也绝不回 `mixed/long_term`（矛盾形状）；
 *   · `recall:false` **只表示**"本轮跳过可选记忆读取/注入"——不删存储、不停写入/整理、不清索引；
 *     必须更正、当前关系/实时状态、跨轮心声、历史消息都不受影响（它们不在这一步里）。
 *
 * @param {object|null|undefined} policy
 * @returns {{recall:boolean, mode:'none'|'recent'|'long_term'|'mixed', reason:string}}
 */
export function normalizeMemoryPolicy(policy) {
  const p = policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : null;
  const rawMode = String(p?.mode ?? '').trim();
  const givenMode = MEMORY_POLICY_MODES.includes(rawMode) ? rawMode : null;
  const reason = String(p?.reason ?? '').trim().slice(0, 200);
  // `recall:true` 优先判：显式召回时，mode 'none'/非法一律抬成 'mixed'（不出现"召回但又 none"的误省形状）。
  if (p?.recall === true) {
    return { recall: true, mode: givenMode && givenMode !== 'none' ? givenMode : 'mixed', reason: reason || 'given' };
  }
  // 显式跳过可选：唯一配套 mode 就是 'none'（ds3 判据侧同一个不变量；compose 也只认这一对
  // 才会跳可选段）——给了别的 mode 也不许回矛盾形状，如实落在 'none'。
  if (p?.recall === false) {
    return { recall: false, mode: 'none', reason: reason || 'policy-recall-false' };
  }
  return { recall: true, mode: 'mixed', reason: reason || 'missing-default' };
}

const STATE_VERSION = 2;
const EPISODES_FILE = 'episodes.jsonl';
const STATE_FILE = 'consolidation-state.json';
/** 方案 §5.3：「每批最多重试 2 次，连续失败后退避」。 */
const MAX_ATTEMPTS = 3;          // 首次 + 2 次重试
const BACKOFF_BASE_MS = 30_000;

/**
 * ★ 2026-10-19（第五批 N4）：抽取出的印象子类（旧树 IMP_TYPES 六类）→ M6 观察 `type`。
 * 与 `act/executors/memory.js:945-952` 的 typeMap **同表**（那份是模型工具 memory_append 的映射）；
 * 本模块零 act import，只能留一份 —— 改一处要同步另一处（见 `.tmp-dispatch/2026-10-19/8fa3addc/接口交接-第五批.md`）。
 * 给了合法子类 ⇒ 行上落 `impressionType:'<子类>' + impressionTypeSource:'model'`（与模型工具同口径：
 * "模型给过的子类，一键清理 C 不动"）；没给 ⇒ 只落 `impressionTypeSource:'none'`。
 */
const IMPRESSION_KIND_TO_TYPE = Object.freeze({
  identity: 'fact',
  preference: 'preference',
  edge: 'fact',
  style: 'trait',
  event: 'fact',
  attitude: 'impression',
});

function nowOf(clock) {
  return (clock && typeof clock.now === 'function') ? Number(clock.now()) : Date.now();
}

function num(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export function createMemoryCoordinator(ctx = {}) {
  const {
    dataDir, accountId, chatStore, todos,
    extract: suppliedExtract, chatModel, provider, model,
    semantic, clock, options,
  } = ctx;
  if (!dataDir) throw new Error('createMemoryCoordinator: missing dataDir');
  const extract = typeof suppliedExtract === 'function'
    ? suppliedExtract
    : createMemoryExtractor({
      chatModel,
      provider,
      model,
      maxCharsPerSource: options?.episodeMaxChars,
      // ★ 2026-10-28：取料上限与送料上限必须是同一个数，否则多收集的那截会被游标
      //   "顺带"跨过去 —— 既没进摘要，也不留在队列里（静默丢内容，见 opt.maxSourcesPerExtract）。
      maxSources: options?.maxSourcesPerExtract,
      log: ctx.log,
    });

  const baseDir = path.join(dataDir, 'memory');
  fs.mkdirSync(baseDir, { recursive: true });
  const stateFile = path.join(baseDir, STATE_FILE);
  const episodesFile = path.join(baseDir, EPISODES_FILE);

  /** 串行执行锁：方案 §5.3「一个进程内的串行队列即可，不需要常驻多个 LLM agent」。 */
  let running = false;
  const optionDefaults = {
    episodeMaxChars: 400,
    maxEpisodeSourceRefs: 32,
    consolidateLimit: 200,      // 单批最多整理多少条来源（超出留给下一批）
    // ★ 2026-10-28（她：「群里记不住人」）：送给抽取模型的上限。以前抽取端硬切 40，
    //   而收集端按 consolidateLimit=200 收，多的 160 条被游标跨过去 —— 没摘要、也没留在队列。
    //   现在收集端与送料端取同一个数（min(consolidateLimit, maxSourcesPerExtract)），不再静默丢。
    maxSourcesPerExtract: 80,
    recallLimit: 10,
    semanticRebuildMinChanges: 32,
    semanticRebuildQuietMs: 60_000,
    // ★ 2026-10-19（第五批 N4）：自动产人物印象的硬上限（防"一次整理刷一屏印象"）。
    //   0 = 本轮不接收印象候选（只整情节摘要，行为回到改动前）。
    //   2026-10-28 调：3 → 6 条／轮、同一人 1 → 2 条（一天一次、一次三条，一百多人的群攒不起来）。
    maxImpressionsPerRun: 6,     // 单批最多写几条
    maxImpressionsPerSubject: 2, // 单批对同一个人最多写几条
    impressionMaxChars: 160,     // 单条 claim 上限（超出截断并计数，不静默丢）
  };
  const opt = { ...optionDefaults, ...(options || {}) };
  const semanticMinChanges = Math.max(1, Math.floor(num(opt.semanticRebuildMinChanges, 32)));
  const semanticQuietMs = Math.max(1, num(opt.semanticRebuildQuietMs, 60_000));
  const impressionRunCap = Math.max(0, Math.floor(num(opt.maxImpressionsPerRun, 6)));
  const impressionSubjectCap = Math.max(0, Math.floor(num(opt.maxImpressionsPerSubject, 2)));
  const impressionMaxChars = Math.max(8, Math.floor(num(opt.impressionMaxChars, 160)));
  let semanticChanges = 0;
  let semanticRebuildTimer = null;
  let semanticRebuildRunning = null;
  let semanticRebuildClosed = false;
  let semanticLastResult = null;
  let semanticLastReason = '';
  let semanticLastRunAt = 0;

  function semanticReady() {
    return !!semantic && typeof semantic.rebuild === 'function';
  }

  function scheduleSemanticRebuild(reason, delayMs = semanticQuietMs) {
    if (!semanticReady() || semanticRebuildClosed) return;
    semanticLastReason = String(reason || 'observation-change');
    if (semanticRebuildTimer) clearTimeout(semanticRebuildTimer);
    semanticRebuildTimer = setTimeout(() => {
      semanticRebuildTimer = null;
      void rebuildSemanticIndex({ reason: semanticLastReason }).catch(() => {});
    }, Math.max(0, delayMs));
    semanticRebuildTimer.unref?.();
  }

  async function rebuildSemanticIndex({ reason = 'manual' } = {}) {
    if (!semanticReady()) {
      const result = { ok: false, status: 'not-ready', reason: 'no-semantic-rebuild-entry', indexStatus: semantic?.status?.() ?? 'not-ready' };
      semanticLastResult = result;
      return result;
    }
    if (semanticRebuildTimer) clearTimeout(semanticRebuildTimer);
    semanticRebuildTimer = null;
    if (semanticRebuildRunning) {
      semanticChanges = Math.max(1, semanticChanges);
      semanticLastReason = String(reason || 'manual');
      return { ok: true, queued: true, status: 'running', reason: 'rebuild-already-running', indexStatus: semantic.status?.() ?? 'unknown' };
    }

    const pendingChanges = semanticChanges;
    semanticChanges = 0;
    semanticLastRunAt = nowOf(clock);
    semanticLastReason = String(reason || 'manual');
    semanticRebuildRunning = (async () => {
      let rows;
      try {
        const store = openStore(dataDir);
        const nowTs = nowOf(clock);
        rows = activeObservations(store).filter((row) => row.validUntil == null || num(row.validUntil) >= nowTs);
      } catch (error) {
        return { ok: false, status: 'error', reason: `observation-read-failed:${String(error?.message ?? error).slice(0, 120)}`, indexStatus: semantic.status?.() ?? 'unknown' };
      }

      const derived = observationToRecords(rows);
      if (derived.rejected.length > 0) {
        return {
          ok: false,
          status: 'error',
          reason: 'observation-derive-rejected',
          rejected: derived.rejected.length,
          reasons: derived.reasons,
          indexStatus: semantic.status?.() ?? 'unknown',
        };
      }

      // ★ 2026-10-17（派单②三类记录合流）：语义卡 + 情节摘要一并派生。三类源共用一个 sync 入流：
      //   卡与情节按各自 store 的**真实主键**做记录（`card:<key>` / 行 id），证据只取当时就在行的
      //   真实指针；隔离（过期/无证据/被点名遗忘/坏行）一律如实记账，不许静默丢也不许报错中断。
      //   ★ 任一长期源读取失败 ⇒ complete:false —— 只 upsert 已有记录、**绝不 prune**（缺席≠被删）；
      //     这是把"读得全不"如实留给下一次，不把"没读到"伪装成"没有"。
      const namedSuppressed = namedSuppressedEvidenceIds({ dataDir });
      const longtermNow = nowOf(clock);
      const cardRecords = [];
      const cardIsolated = new Map();
      let cardsSource = 'ok';
      try {
        const cardsSnap = cachedCardRows(path.join(dataDir, 'semantic-cards'));
        if (cardsSnap.readable === false) {
          cardsSource = `cards-read-failed:${String(cardsSnap.error ?? '').slice(0, 80)}`;
        } else {
          for (const card of cardsSnap.rows ?? []) {
            const m = semanticCardToRecord(card, { now: longtermNow, namedSuppressed });
            if (m.accepted) cardRecords.push(m.record);
            else cardIsolated.set(m.reason, (cardIsolated.get(m.reason) || 0) + 1);
          }
        }
      } catch (error) {
        cardsSource = `cards-read-threw:${String(error?.message ?? error).slice(0, 80)}`;
      }

      const episodeRecords = [];
      const episodeIsolated = new Map();
      let episodesSource = 'ok';
      try {
        const epsSnap = cachedEpisodeRows(dataDir);
        if (epsSnap.readable === false) {
          episodesSource = `episodes-read-failed:${String(epsSnap.error ?? '').slice(0, 80)}`;
        } else {
          // 同 id 重写（归属标回写等）⇒ 最后一行是权威（文件顺序 = 写序）。
          for (const row of latestEpisodeRowsById(dataDir).values()) {
            const m = episodeRowToRecord(row, { now: longtermNow, namedSuppressed });
            if (m.accepted) episodeRecords.push(m.record);
            else episodeIsolated.set(m.reason, (episodeIsolated.get(m.reason) || 0) + 1);
          }
        }
      } catch (error) {
        episodesSource = `episodes-read-threw:${String(error?.message ?? error).slice(0, 80)}`;
      }

      const allRecords = [...derived.records, ...cardRecords, ...episodeRecords];
      // ★ 2026-10-17（安全审查 · 写侧 fail-closed）：抑制账本读不全时，**不把新记录写进索引**。
      //   `longtermComplete:false` 只表示"这次只进部分、不 prune"，记录照样会 upsert；
      //   而账本读不到 = 无法判断这些记录是不是从"用户已点名忘掉"的来源派生出来的 ——
      //   写进去就等于把忘掉的内容重新做成向量。宁可不写，账本一好下轮自动补上。
      const suppressionHealth = ledgerHealthOf(namedSuppressed);
      const suppressionSick = suppressionHealth.ok === false;
      const longtermComplete = !suppressionSick && cardsSource === 'ok' && episodesSource === 'ok';
      const countIsolated = (map) => [...map.values()].reduce((a, b) => a + b, 0);
      const isolatedTotal = derived.isolated + countIsolated(cardIsolated) + countIsolated(episodeIsolated);
      const isolationReasonsAll = [
        ...derived.isolationReasons,
        ...[...cardIsolated].map(([k, v]) => `${k}: ${v}`),
        ...[...episodeIsolated].map(([k, v]) => `${k}: ${v}`),
      ];

      try {
        // ★ 2026-10-17（增量底座 · 与 ds2 已约定的最小接口）：常规路径走 `sync()` ——
        //   按 id/内容签名增量 upsert（未变复用 vec、有界分批），complete:true 才 prune 缺席旧记录；
        //   `rebuild` 只留给换 profile 等真换代（semantic.js 由 ds2 实现，这里只按约定调用）。
        //   三源型在同一记录集里：observation 派生记录（含真实 type）+ `semantic_card` + `episode_summary`。
        //   ★ 长期源读取失败时 complete:false 只进**部分**记录 —— 不许拿一次不全的集合把别的源的
        //     向量清掉（absent ≠ deleted）。
        const recordsToWrite = suppressionSick ? [] : allRecords;
        // ★ 2026-10-18（向量召回体验修复 · 粘滞态恢复通路）：索引自报 `stale`（store 被绕开改动）
        //   或 `version-incompatible`（代次/画像不符）时，契约里**只有 rebuild 能恢复**
        //   （vector-index.js 状态机注释：两者都"粘滞，rebuild 恢复"；upsert/sync 自身不清）。
        //   常规维护照旧走 `sync()` 增量；只有遇到粘滞态、且**这次三源读全、抑制账本健康、集合非空**
        //   （可信可当权威全量）才用 rebuild 恢复 —— 集合不完整/空绝不清盘重建（absent ≠ deleted），
        //   此时照旧 sync 只进部分，等下轮长全了再治。
        const indexStateBefore = typeof semantic.status === 'function' ? semantic.status() : 'unknown';
        const stickyState = indexStateBefore === 'stale' || indexStateBefore === 'version-incompatible';
        const rebuildToRecover = stickyState && !suppressionSick && longtermComplete && recordsToWrite.length > 0;
        const rebuilt = rebuildToRecover
          ? await semantic.rebuild(recordsToWrite)
          : (typeof semantic.sync === 'function'
            ? await semantic.sync(recordsToWrite, { complete: longtermComplete, batchSize: 32, allowEmpty: longtermComplete })
            : await semantic.rebuild(recordsToWrite));
        return {
          ...rebuilt,
          ok: rebuilt?.ok === true && !suppressionSick,
          status: rebuilt?.status ?? (rebuilt?.ok === true ? 'success' : 'error'),
          reason: suppressionSick
            ? `suppression-ledger-unreadable:${String(suppressionHealth.reason || '').slice(0, 60)}`
            : String(reason || 'manual'),
          // ★ 2026-10-18：这轮是不是走 rebuild 恢复的、从哪个粘滞态恢复、成没成（排障要在面板上看得见）。
          recovery: rebuildToRecover
            ? { action: 'rebuild', from: indexStateBefore, ok: rebuilt?.ok === true }
            : null,
          records: allRecords.length,
          isolated: isolatedTotal,
          isolationReasons: isolationReasonsAll,
          observedChanges: pendingChanges,
          longtermComplete,
          suppressionLedger: {
            ok: !suppressionSick,
            absent: suppressionHealth.absent === true,
            badLines: suppressionHealth.badLines || 0
          },
          longtermSourceStates: {
            observations: { records: derived.records.length, isolated: derived.isolated },
            semanticCards: { state: cardsSource, records: cardRecords.length, isolated: countIsolated(cardIsolated) },
            episodes: { state: episodesSource, records: episodeRecords.length, isolated: countIsolated(episodeIsolated) },
          },
        };
      } catch (error) {
        return { ok: false, status: 'error', reason: `rebuild-threw:${String(error?.message ?? error).slice(0, 120)}`, indexStatus: semantic.status?.() ?? 'unknown' };
      }
    })();

    try {
      semanticLastResult = await semanticRebuildRunning;
      return semanticLastResult;
    } finally {
      semanticRebuildRunning = null;
      if (semanticChanges > 0 && !semanticRebuildClosed) {
        scheduleSemanticRebuild(semanticLastReason, semanticChanges >= semanticMinChanges ? 0 : semanticQuietMs);
      }
    }
  }

  // ★ 2026-10-17（派单③三类源同一个 sync 入口）：观察走 observation-events；语义卡与情节走
  //   longterm-events（两个根键：`<dataDir>/semantic-cards` 卡表、`<dataDir>/memory` 情节行）。
  //   通知只做计数 + 排一次（合并单飞）：小于阈值进 60s 静默窗、过阈值立即跑 —— 与观察一个节律。
  const onLongtermChange = semanticReady()
    ? (change) => {
      semanticChanges += Math.max(1, Array.isArray(change?.ids) ? change.ids.length : (change?.count || 1));
      const tag = `${change?.source || 'longterm'}:${change?.action || 'change'}`;
      if (semanticChanges >= semanticMinChanges) scheduleSemanticRebuild(tag, 0);
      else scheduleSemanticRebuild(tag, semanticQuietMs);
    }
    : () => {};
  const unsubscribeLongtermChanges = semanticReady()
    ? [
      subscribeLongtermChanges(path.join(dataDir, 'semantic-cards'), onLongtermChange),
      subscribeLongtermChanges(baseDir, onLongtermChange),
    ]
    : [];
  const unsubscribeObservationChanges = semanticReady()
    ? subscribeObservationChanges(dataDir, (change) => {
      semanticChanges += Math.max(1, Array.isArray(change?.ids) ? change.ids.length : 1);
      if (semanticChanges >= semanticMinChanges) scheduleSemanticRebuild(change?.action || 'observation-change', 0);
      else scheduleSemanticRebuild(change?.action || 'observation-change', semanticQuietMs);
    })
    : () => {};

  // Each process starts with an in-memory vector store. Rebuild once from the durable
  // M6 observation ledger; later writes are coalesced by the threshold/debounce above.
  if (semanticReady()) queueMicrotask(() => {
    if (!semanticRebuildClosed) void rebuildSemanticIndex({ reason: 'startup' }).catch(() => {});
  });

  // ── 状态持久化（原子替换） ────────────────────────────────────────────────

  function emptyState() {
    return { version: STATE_VERSION, cursors: {}, jobs: {}, updatedAt: 0 };
  }

  function loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return emptyState();
      return {
        ...emptyState(),
        ...parsed,
        cursors: parsed.cursors && typeof parsed.cursors === 'object' ? parsed.cursors : {},
        jobs: parsed.jobs && typeof parsed.jobs === 'object' ? parsed.jobs : {},
      };
    } catch {
      // 坏文件/不存在 = 空状态。**不抛**：协调服务启动失败不该让整个 app 起不来。
      return emptyState();
    }
  }

  /**
   * 原子替换（方案 §4.3 明写「原子替换」）。
   * 写临时文件 → rename。同目录内 rename 在多数文件系统上是原子的。
   */
  function saveState(st) {
    st.updatedAt = nowOf(clock);
    writeJsonAtomic(stateFile, st, { indent: 2 });
  }

  /**
   * ★ 冷启动僵尸恢复（2026-10-11 派单③ · 只在**工厂创建时**跑一次）：
   *   进程在整理途中死掉/被杀 ⇒ 数据文件里残留 `status:'running'` 的 job ⇒
   *   orchestrator 见 `status().running > 0` 就早退（`orchestrator/index.js:490`）⇒ **整理泵永久卡死**。
   *
   * ★ 判据（为什么"创建工厂时数据文件里的 running 一定是上次中断留下的"是安全的）：
   *   · 本工厂是**进程内唯一**协调器实例；`runNextJob` 有 `running` 布尔锁，同一时刻最多一个 job 在跑。
   *   · 创建工厂时**还没有任何 job 在本进程跑**（`running=false`，见上方 `let running = false`），
   *     所以此刻从数据文件读到的任何 `running` 都只可能来自**上一个进程**中断留下的残骸。
   *   · ★ 故意**不在 `loadState()` 里做恢复**：`runJob` 中途会多次 `loadState()`，
   *     那时 status='running' 是**正在跑的合法状态**，在 load 里恢复会把活 job 误伤成 queued。
   *
   * 处置：`attempts >= MAX_ATTEMPTS` ⇒ `failed`（不再无限重试反复崩溃的 job）；
   *       否则退回 `queued`，让 `runNextJob` 重跑（游标"提交成功才推进"⇒ 重做未确认批次是安全的）。
   */
  function recoverZombieRunningJobs() {
    const st = loadState();
    const recovered = [];
    for (const [id, job] of Object.entries(st.jobs)) {
      if (!job || job.status !== 'running') continue;
      const attempts = num(job.attempts);
      const row = {
        jobId: id,
        chatKey: String(job.chatKey || ''),
        attempts,
        previous: 'running',
        startedAt: job.startedAt ?? null,
      };
      if (attempts >= MAX_ATTEMPTS) {
        job.status = 'failed';
        job.reason = 'recovered-zombie:max-attempts';
        job.finishedAt = nowOf(clock);
        row.next = 'failed';
      } else {
        // 保留 attempts（已含本次崩溃那次 increment）；不设 backoffUntil ——
        // runNextJob 目前不读它，设了等于假保护。
        job.status = 'queued';
        row.next = 'queued';
      }
      job.recoveredFrom = 'running';
      job.recoveredAt = nowOf(clock);
      recovered.push(row);
    }
    if (recovered.length) {
      try { saveState(st); } catch { /* 创建期写失败不阻断工厂启动 */ }
    }
    return { recovered: recovered.length, jobs: recovered };
  }
  const startupRecovery = recoverZombieRunningJobs();

  /**
   * 游标读取。★ N39 追加：**按人（speakerId）分桶**。
   *
   * 改前只有一个会话级标量 `sourceCursor`，收窄整理（只整理某人）时它照样推进 ——
   * ⇒ **没被选中的人的消息被游标跨过去了，再也不会被整理**（Minimax N38 的 caveat，成立）。
   *
   * 现在多一个 `subjects` 桶：`subjects[speakerId] = 该人已整理到哪`。
   * · **不收窄**的 job 照旧只动会话级游标（一次扫完所有人）。
   * · **收窄**的 job 只动被选中那个人的桶 ⇒ 没选中的人原地不动，下次还在。
   * 旧存档没有 `subjects` 字段 ⇒ 读成 `{}`，**不需要迁移**。
   */
  function cursorOf(st, chatKey) {
    const c = st.cursors[chatKey];
    const base = c && typeof c === 'object'
      ? { sourceCursor: num(c.sourceCursor), lastJobId: String(c.lastJobId || ''), lastAt: num(c.lastAt) }
      : { sourceCursor: 0, lastJobId: '', lastAt: 0 };
    base.subjects = (c && typeof c === 'object' && c.subjects && typeof c.subjects === 'object') ? c.subjects : {};
    // ★ 机器人自己那部分来源的**按人格分桶**游标（2026-10-13 证据归属标）。
    base.selfCursors = (c && typeof c === 'object' && c.selfCursors && typeof c.selfCursors === 'object') ? c.selfCursors : {};
    // ★ coverage.lastSuccessfulThrough 的落点（M2，2026-10-14）：**最后一次真出过结果的批次**到哪。
    //   与 sourceCursor 分开记：一批来源被"跳过"（模型给的摘要全被判不合格）时游标会推进，
    //   这一项**不**推进 ⇒ 面板一比就知道"整理到哪"和"整理成功到哪"不是一回事（§6.2 明令）。
    //   老存档没这个字段 ⇒ null（没记过，不报成 0）。★ `Number(null)` 是 0 ⇒ 必须先挡住 null/undefined 再转数。
    base.successThrough = c?.successThrough === null || c?.successThrough === undefined || c?.successThrough === ''
      ? null
      : (Number.isFinite(Number(c.successThrough)) ? Number(c.successThrough) : null);
    return base;
  }

  /** 某个人已整理到哪（没有分桶记录时回落到会话级游标）。 */
  function subjectCursorOf(cur, speakerId) {
    const sid = String(speakerId ?? '');
    if (!sid) return num(cur.sourceCursor);
    const v = cur.subjects?.[sid];
    return v ? num(v) : num(cur.sourceCursor);
  }

  /**
   * 机器人自己的来源，某个人格已整理到哪。
   * ★ 这里**不回落会话级游标**（与 `subjectCursorOf` 故意不同）：会话游标会被另一人格的批次推进，
   *   一回落就等于把"她还没整理的那半"跨过去 —— 那正是本条要堵的漏。
   *   没记录 ⇒ 0：存量行都没有 `self` 键（走会话游标），带键的行只可能是改动之后写的，
   *   从 0 起收不会重复整理老数据。
   */
  function selfCursorOf(cur, personaTwo) {
    return num(cur.selfCursors?.[personaTwo === true ? 'second' : 'first']);
  }

  /**
   * coverage 的水位之一：**本会话可用的来源前沿**（M2，2026-10-14 · §6.2）。
   *
   * 取证据账本里这一会话最晚一条的**追加时刻**（`at`）—— 与 `processedThrough`（会话游标）
   * 同一把尺（游标推进用的就是这批来源的 `max(at)`，见 `advanceCursor()`），两者相减才看得出差多少。
   *
   * ★ 为什么不用"消息条数"当水位：§6.2 要求水位用"来源追加序号/偏移及可读时间"，
   *   而本协调器的游标本来就是按时刻记的 ⇒ 换成条数等于再造一把尺，两处迟早对不上。
   * ★ 只在**已装载**的证据表上过一遍（`store.js openStore()` 按 dataDir 缓存，不重读数据文件）；
   *   读不动 ⇒ `null`（没测出来，不报成 0）。
   * ★ 这里**不**按在位人格筛：另一人格欠着的来源是真欠着（`subjectCursors` 那条口径），
   *   隐去她看得见的部分不等于那些来源不存在。
   */
  function evidenceHighWater(chatKey) {
    try {
      const store = openStore(dataDir);
      let high = null;
      for (const ev of store.evidence.values()) {
        if (String(ev?.chatKey ?? '') !== String(chatKey ?? '')) continue;
        const at = Number(ev?.at);
        if (Number.isFinite(at) && (high === null || at > high)) high = at;
      }
      return high;
    } catch {
      return null;
    }
  }

  /**
   * coverage 的 `generation`：本轮数字所属的**向量索引代次**（§6.5「换模型时建立新 generation，
   * 补增量后切换，不混用不同向量代次」）。三种如实情形（2026-10-14 裁定：**不写 `'none'`**，
   * "确实没有代次"和"这条腿还没接"不能共用一个值，成因走 `generationState`）：
   *   · 没注入语义这条腿 ⇒ `generation:null` + `generationState:'not-wired'`；
   *   · 注入了且它报得出代次 ⇒ 照实那个字符串 + `'measured'`（装配层用 `createMemorySemanticRecall()` 就是这种）；
   *   · 注入了但没提供代次（旧的注入形状）⇒ `generation:null` + `'unreported'`。
   */
  function coverageGeneration() {
    if (!semanticReady()) return { generation: null, generationState: 'not-wired' };
    const g = typeof semantic?.generation === 'function' ? semantic.generation() : null;
    return typeof g === 'string' && g.trim()
      ? { generation: g.trim(), generationState: 'measured' }
      : { generation: null, generationState: 'unreported' };
  }

  // ── episodes 读写 ────────────────────────────────────────────────────────

  function appendEpisodes(rows) {
    if (!rows.length) return 0;
    fs.appendFileSync(episodesFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    // ★ 2026-10-17（派单③）：真写完就发有界变更通知（监听器只安排 sync，见 longterm-events.js）。
    //   写失败走上面的 appendFileSync throw，不存在"没写却通知"；notify 内部自吞监听器异常。
    notifyLongtermChange(baseDir, {
      source: 'episode-rows',
      action: 'append',
      ids: rows.map((r) => String(r?.id ?? '')).filter(Boolean).slice(0, 32),
      count: rows.length,
    });
    return rows.length;
  }

  function readEpisodes() {
    return cachedEpisodeRows(dataDir).rows ?? [];
  }

  /**
   * episode 校验（方案 §5.3）。
   *
   * 逐条拒收并**如实记账**（`rejected` 带 reason），不做静默丢弃、不修字段：
   *   · `summary` 必须是非空人话 ⇒ **杜绝"没有 extract 就编一段摘要"**
   *   · `sourceRefs` 必须非空且**每个 messageId 在证据账本里真实存在**
   *     ⇒ 杜绝"引用不存在的事证据"（也顺带杜绝拿 bot 心声当人物证据：心声不是 message 证据）
   *   · `chatKey` 不许与请求的会话不一致 ⇒ 范围不扩大（一律拒绝，不静默改写）
   */
  function validateEpisodes(list, { chatKey, kind, store }) {
    const accepted = [];
    const rejected = [];
    for (const ep of Array.isArray(list) ? list : []) {
      const summary = String(ep?.summary ?? '').trim();
      if (!summary) {
        rejected.push({ reason: 'empty-summary', id: String(ep?.id ?? '') });
        continue;
      }
      if (summary.length > opt.episodeMaxChars * 4) {
        rejected.push({ reason: 'summary-too-long', id: String(ep?.id ?? ''), chars: summary.length });
        continue;
      }
      if (chatKey && ep?.namespace?.chatKey && String(ep.namespace.chatKey) !== String(chatKey)) {
        rejected.push({ reason: 'scope-widened', id: String(ep?.id ?? ''), got: String(ep.namespace.chatKey) });
        continue;
      }
      const refs = Array.isArray(ep?.sourceRefs) ? ep.sourceRefs.slice(0, opt.maxEpisodeSourceRefs) : [];
      if (!refs.length) {
        rejected.push({ reason: 'no-source-refs', id: String(ep?.id ?? '') });
        continue;
      }
      const badRef = refs.find((r) => {
        const mid = String(r?.messageId ?? r?.id ?? '');
        if (!mid) return true;
        return !hasEvidenceRow(store, mid);
      });
      if (badRef) {
        rejected.push({
          reason: 'unknown-source-ref',
          id: String(ep?.id ?? ''),
          messageId: String(badRef?.messageId ?? badRef?.id ?? '')
        });
        continue;
      }
      accepted.push({
        id: String(ep?.id || `ep-${nowOf(clock)}-${accepted.length}`),
        namespace: { accountId: accountId || 'default', scope: kind || 'group', chatKey },
        sourceRange: Array.isArray(ep?.sourceRange) ? ep.sourceRange : [],
        sourceRefs: refs.map((r) => ({
          messageId: String(r?.messageId ?? r?.id ?? ''),
          chatKey: String(r?.chatKey ?? chatKey ?? ''),
          speakerId: String(r?.speakerId ?? ''),
          at: num(r?.at)
        })),
        summary: summary.slice(0, opt.episodeMaxChars * 4),
        openTodoIds: Array.isArray(ep?.openTodoIds) ? ep.openTodoIds.map(String).slice(0, 16) : [],
        version: Math.max(1, Math.floor(num(ep?.version, 1))),
        at: nowOf(clock),
        validUntil: ep?.validUntil == null ? null : Number(ep.validUntil),
      });
    }
    return { accepted, rejected };
  }

  function hasEvidenceRow(store, messageId) {
    try {
      return !!getEvidence(store, messageId);
    } catch {
      return false;
    }
  }

  /**
   * ★ 2026-10-19（第五批 N4）：印象候选校验。与 `validateEpisodes` 同纪律 —— 逐条拒收并
   * **如实记账**（`rejected` 带 reason），不做静默丢弃、不修字段：
   *   · `subjectId` 必须是**本批来源里真实出现过的说话人**（不许凭空写人；机器人自己不算"人物"）；
   *   · `claim` 非空，超长截断到 `impressionMaxChars` 并计入 `truncated`（截断必须可见）；
   *   · `sourceRefs` 只认**本批 liveSources 的 messageId**（抑制复查同一道），且**至少一条是这个
   *     说话人自己的发言**（拿别人的话当依据 ⇒ 拒收：杜绝"无来源推断/拿角色台词当人物事实"）；
   *   · 上限两道：单批 `impressionRunCap`、单人 `impressionSubjectCap`（默认 3 / 1）。
   *
   * @returns {{accepted:Array<{subjectId,claim,type,kind?,evidenceIds:string[]}>, rejected:Array, truncated:number}}
   */
  function validateImpressions(list, { chatKey, kind, liveSources }) {
    const speakerByMsg = new Map(liveSources.map((s) => [s.messageId, String(s.speakerId ?? '')]));
    // 人物 = 本批出现过的**非机器人自己**的说话人。self 行是她自己的经历，不作为人物印象主体。
    const humanSpeakers = new Set(
      liveSources.filter((s) => s?.self !== true).map((s) => String(s.speakerId ?? '')).filter(Boolean)
    );
    if (accountId) humanSpeakers.delete(String(accountId));
    const accepted = [];
    const rejected = [];
    let truncated = 0;
    for (const raw of Array.isArray(list) ? list : []) {
      const subjectId = String(raw?.subjectId ?? '').trim();
      if (!subjectId) {
        rejected.push({ reason: 'empty-subject' });
        continue;
      }
      if (!humanSpeakers.has(subjectId)) {
        rejected.push({ reason: 'unknown-subject', subjectId });
        continue;
      }
      const claimRaw = String(raw?.claim ?? '').trim();
      if (!claimRaw) {
        rejected.push({ reason: 'empty-claim', subjectId });
        continue;
      }
      const refs = [];
      for (const r of Array.isArray(raw?.sourceRefs) ? raw.sourceRefs : []) {
        const mid = String(r?.messageId ?? r?.id ?? '');
        if (mid && speakerByMsg.has(mid) && !refs.includes(mid)) refs.push(mid);
      }
      const ownRef = refs.some((mid) => speakerByMsg.get(mid) === subjectId);
      if (!refs.length || !ownRef) {
        rejected.push({ reason: 'no-own-source-ref', subjectId });
        continue;
      }
      if (accepted.filter((x) => x.subjectId === subjectId).length >= impressionSubjectCap) {
        rejected.push({ reason: 'over-subject-cap', subjectId });
        continue;
      }
      if (accepted.length >= impressionRunCap) {
        rejected.push({ reason: 'over-run-cap', subjectId });
        continue;
      }
      const claim = claimRaw.length > impressionMaxChars ? claimRaw.slice(0, impressionMaxChars) : claimRaw;
      if (claim !== claimRaw) truncated += 1;
      const kindName = String(raw?.kind ?? '').trim();
      const hasKind = Object.prototype.hasOwnProperty.call(IMPRESSION_KIND_TO_TYPE, kindName);
      accepted.push({
        subjectId,
        claim,
        type: hasKind ? IMPRESSION_KIND_TO_TYPE[kindName] : 'impression',
        ...(hasKind ? { kind: kindName } : {}),
        evidenceIds: refs,
      });
    }
    return { accepted, rejected, truncated };
  }

  // ── 来源收集（游标之后的消息） ────────────────────────────────────────────

  /** 从证据账本里取出「游标之后、属于本会话」的消息引用（整理器的输入）。 */
  /**
   * 收集「游标之后」的来源。★ N39 追加：支持**按 subjectId 收窄**。
   *
   * @param {string[]} [subjectIds]
   *   · 不给 / 空数组 ⇒ **全收**（旧行为）：以会话级游标为界。
   *   · 给了 ⇒ **只收这些人**，且每条以**该人自己的游标**为界
   *     （`subjectCursorOf`），所以「上次只整了甲，乙丙没动」时乙丙仍然收得到。
   *
   * ★ 为什么收窄批次**必须**改用按人物的游标：游标是"已整理到哪"的时间戳，
   *   若收窄批次还推进会话级游标，别人更早的消息会被跨过去（功能上的洞）。
   *
   * ★ 双人格隔离（2026-10-13 证据归属标）：机器人自己的来源（行带 `self: true`）
   *   按**在位人格**过一遍可见性判据，并用**按人格分桶的游标**（`selfCursorOf`）划界 ——
   *   另一人格的行不进本批（不喂模型），但**也不被本批的游标跨过去**，等她在位时再整理。
   *   判据不在本文件另写：只有 `index.js` 那个 `evidenceVisibleToPersona`，它内部调
   *   `emotion/persona-hygiene.js` 的 `selfRowVisibleNow`（全树一份，compose / prompt 也是它）。
   *
   * @returns {{sources:Array, personaHidden:number}} personaHidden 只给**条数**，不给正文。
   */
  function collectSources(st, chatKey, limit, subjectIds = null) {
    const cur = cursorOf(st, chatKey);
    const from = num(cur.sourceCursor);
    const { personaTwo, hygiene } = personaContext();
    const only = Array.isArray(subjectIds) && subjectIds.length
      ? new Set(subjectIds.map(String).filter(Boolean))
      : null;
    let rows = [];
    let personaHidden = 0;
    try {
      const store = openStore(dataDir);
      const seen = new Map();
      for (const ev of store.evidence.values()) {
        if (String(ev?.chatKey ?? '') !== String(chatKey ?? '')) continue;
        const speaker = String(ev?.sender?.id ?? ev?.speakerId ?? '');
        if (only && !only.has(speaker)) continue;            // ★ 收窄：不是他要整的人，跳过
        const at = num(ev?.at);
        const isSelfRow = ev?.self === true;
        // 边界：**取会话游标与这个人自己的游标里较晚的那个**。
        //   · 收窄批（only 非空）：那个人的桶就是边界。
        //   · 全收批：也要看分人桶，否则「上次单独整过甲」之后，
        //     甲的旧消息会被全收批**重复整理一遍**（多花模型钱 + episodes 出现重复摘要）。
        //     用 max(会话游标, 该人游标) 正好：谁都不重复。
        //   · 机器人自己的行：只看**在位这个人**的桶（见 `selfCursorOf` 为什么不回落会话游标）。
        const boundary = isSelfRow
          ? selfCursorOf(cur, personaTwo)
          : (only
            ? subjectCursorOf(cur, speaker)
            : Math.max(from, subjectCursorOf(cur, speaker)));
        if (at <= boundary) continue;
        // 可见性放在划界**之后**：已经被她整理过的行不该算"隐去"，读数才不虚高。
        if (isSelfRow && !evidenceVisibleToPersona(ev, personaTwo, hygiene)) { personaHidden += 1; continue; }
        const id = String(ev?.id ?? '');
        if (!id || seen.has(id)) continue;
        seen.set(id, true);
        rows.push({
          messageId: id,
          chatKey: String(ev.chatKey),
          speakerId: speaker,
          at,
          sourceType: String(ev?.sourceType ?? ''),
          // 两个布尔：推进游标时要知道这行是谁的经历、该给哪几个桶记账（不落正文之外的信息）
          ...(isSelfRow ? { self: true, persona2: ev.persona2 === true } : {}),
          text: String(ev?.text ?? '').slice(0, 600),
        });
      }
    } catch {
      return { sources: [], personaHidden: 0 };
    }
    rows.sort((a, b) => a.at - b.at || a.messageId.localeCompare(b.messageId));
    return { sources: rows.slice(0, Math.max(1, limit)), personaHidden };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 公开出口
  // ═════════════════════════════════════════════════════════════════════════
  return {
    /**
     * 收到消息：入证据账本 + 标记待整理。
     * ★ **不再推进游标**（方案 §4.3）—— 游标是"已整理到哪"，不是"见到几条"。
     * 只做本地 I/O，**热路径不等待模型**（方案 §4.2 表）。
     */
    observe: async (opts = {}) => {
      const { chatKey, kind, messageRefs, evidence } = opts;
      if (!chatKey || !Array.isArray(messageRefs)) {
        return { ok: false, error: 'invalid-opts' };
      }
      if (!messageRefs.length) {
        return { ok: true, observed: 0, queued: 0, duplicates: 0, persisted: true, dirty: false };
      }

      // 证据由 orchestrator 校验后传入；这里只负责入账（不扩权、不学习被准入规则拒掉的内容）。
      const validEvidence = Array.isArray(evidence) ? evidence : [];
      const result = validEvidence.length ? await recordEvidence(validEvidence, { dataDir }) : { ok: true, added: [], duplicate: [], invalid: [] };

      const invalidIds = new Set((Array.isArray(result?.invalid) ? result.invalid : []).map((r) => String(r?.id ?? r ?? '')));
      const added = Array.isArray(result?.added) ? result.added : [];
      const duplicates = Array.isArray(result?.duplicate) ? result.duplicate : [];
      const duplicateIds = new Set(duplicates.map((r) => String(r?.id ?? r ?? '')));

      let observed = 0;
      for (const ref of messageRefs) {
        const msgId = String(ref?.messageId ?? ref?.id ?? '');
        if (!msgId || invalidIds.has(msgId) || duplicateIds.has(msgId)) continue;
        observed += 1;
      }

      // 只标 dirty；**游标不动**。
      const st = loadState();
      const ck = cursorOf(st, chatKey);
      st.cursors[chatKey] = { ...ck, dirtyAt: ck.dirtyAt || nowOf(clock), pendingObserved: observed };

      return {
        ok: result?.ok !== false && invalidIds.size === 0,
        observed,
        queued: added.length,
        duplicates: duplicates.length,
        persisted: true,
        dirty: observed > 0,
        cursorAdvanced: false,   // ★ 如实：observe 不推进游标
      };
    },

    /**
     * 回复前组包。顺序严格按方案 §5.2：
     *   ① 可见范围 / 撤回 / 过期 / 来源版本过滤 → ② 近因 + 事实 + episode + todos → ③ 检索
     *
     * ★ M1（2026-10-12）新增两样，都不改变上面那条顺序：
     *   · `coverage`：本轮到底读全了没有（`complete` / `partial` / `degraded`）+ 已整理到第几条来源；
     *   · `diagnostics.readings`：本轮读了多少条、花了多少毫秒 —— 每轮成本必须能被看见，
     *     才谈得上"聊天时不扫全量历史"（读数由本函数自己计，不靠外部计时）。
     */
    prepareContext: async (opts = {}) => {
      const { chatKey, kind, subjectIds, query, now, budget, excludedMessageIds } = opts;
      const nowTs = num(now) || nowOf(clock);
      // ★ 2026-10-16（JEV 同一次判 · 按需消费可选记忆）：
      //   · `opts.deferOptionalRecall:true` = JEV 前的**轻上下文**（跳过可选长期/向量/整段印象/情节）；
      //   · `opts.memoryPolicy` = 最终决定（ds3 侧给；缺失/非法 ⇒ 保守 `recall:true/mixed`）。
      //   两者都**只影响本轮可选记忆的读取**：不动存储、不停写入/整理、不清索引；
      //   近期原文、工作状态、必须更正（correction）、当前关系/实时状态、跨轮心声都不受影响。
      const memoryPolicyIn = normalizeMemoryPolicy(opts.memoryPolicy);
      const lightContext = opts.deferOptionalRecall === true || memoryPolicyIn.recall === false;
      // 轻上下文如实回 `recall:false + mode:'none'`（跳过可选读取的**唯一**合法配对，
      // compose 也只认这一对才会跳可选段；reason 区分"判定说不用"与"这次只是 JEV 前的轻取"）。
      const memoryPolicy = lightContext
        ? {
          recall: false,
          mode: 'none',
          reason: memoryPolicyIn.recall === false ? memoryPolicyIn.reason : 'defer-optional-recall',
        }
        : memoryPolicyIn;
      const clockMs = () => (typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now());
      const t0 = clockMs();
      const readings = {
        chatRowsRead: 0,        // ChatStore.recent 交回的条数（受 limit 约束，不是全部历史）
        recentKept: 0,          // 扣掉本轮消息与自我消息后，真进上下文的条数
        observationRowsScanned: 0, // 检索时扫过的"当前有效观察"条数
        recallCandidates: 0,    // 过完范围与 need 过滤后剩下的候选数
        recallTruncated: 0,     // 因上限没被选中的候选数（没删，只是这轮没进）
        workingExpired: 0,      // ① 被年龄闸拦下的短期状态条数（关键词腿 + 语义腿，两条腿合计数）
        workingRescued: 0,      // ① 超期但本轮话题命中、因此放行的条数
        episodeRowsRead: 0,
        evidenceLookups: 0,     // 回查证据账本的次数（抑制表缺说话人/时间时才发生）
        recalledCount: 0,
        elapsedMs: 0,
      };
      let retrievalFailed = false;

      let recentMessages = [];
      const excludedCurrent = [];
      const inferredCurrent = [];
      // ★ 双人格隔离（2026-10-13 接线）：本轮近期原文里，另一人格说过的话**不作为背景喂模型**。
      //   判据不在本文件 —— 全树只有 `emotion/persona-hygiene.js` 那一份（compose/提示词同一份）。
      //   在位状态与开关优先由调用方 per-call 覆盖，没给就用装配层注入 memory.configure 的那份。
      const personaCtx = personaContext();
      const personaTwo = typeof opts.personaTwo === 'boolean' ? opts.personaTwo : personaCtx.personaTwo;
      const personaHygiene = opts.memoryHygiene && typeof opts.memoryHygiene === 'object' && !Array.isArray(opts.memoryHygiene)
        ? opts.memoryHygiene : personaCtx.hygiene;
      if (chatStore && typeof chatStore.recent === 'function') {
        const allRecentRaw = chatStore.recent(chatKey, { limit: (budget?.recentMessages || 40) + 10, includeSelf: true });
        const allRecent = (Array.isArray(allRecentRaw) ? allRecentRaw : [])
          .filter((row) => selfRowVisibleNow(row, { personaTwo, hygiene: personaHygiene }));
        readings.chatRowsRead = Array.isArray(allRecentRaw) ? allRecentRaw.length : 0;
        readings.personaHiddenRecent = Math.max(0, readings.chatRowsRead - allRecent.length);
        const toExclude = new Set();
        if (Array.isArray(excludedMessageIds)) {
          excludedMessageIds.forEach((id) => toExclude.add(String(id)));
        } else if (Array.isArray(opts.evidence)) {
          opts.evidence.forEach((e) => toExclude.add(String(e?.id || e?.messageId)));
        }
        for (const msg of allRecent) {
          const mid = String(msg?.mid || msg?.id || '');
          if (toExclude.has(mid)) {
            if (!excludedCurrent.includes(mid)) excludedCurrent.push(mid);
            continue;
          }
          if (msg.ts === now) {
            if (!inferredCurrent.includes(mid)) inferredCurrent.push(mid);
            continue;
          }
          recentMessages.push(msg);
        }
        const limit = budget?.recentMessages || 40;
        if (recentMessages.length > limit) recentMessages = recentMessages.slice(-limit);
      }
      readings.recentKept = recentMessages.length;

      // ── ③ 检索：关键词 + 语义（语义不可用则**如实降级**） ────────────────
      //   ①（2026-10-14）年龄口径在这里解析一次：关键词腿把它交给 `retrieve()` 内部那道拦截，
      //   语义腿在下面 `recallWithSemantic` 的二次验证里用同一份 —— 两条腿必须共用一个口径。
      const workingCtx = resolveWorking(opts.working ?? opt.working);
      const recallLimit = Math.max(1, Number(budget?.recalledItems ?? opt.recallLimit) || opt.recallLimit);
      let keywordItems = [];
      let keywordDropped = 0;
      let keywordTruncated = 0;
      try {
        // ★ P1-8（功能表 5 · 2026-10-11）：把本轮的 query 一并当**话题**交给 retrieve。
        //   改前只传 subjectIds ⇒ `memory/index.js:293 topicOverlap` 拿到的 topic 恒为空、
        //   0.2 的话题权重**恒为 0**（等于检索只按近因/置信/范围排序）。
        //   只补这一个键，权重一个字节都不动。
        const res = await retrieve({
          chatKey, kind, dataDir, now: nowTs, topic: query ?? '',
          personaTwo, memoryHygiene: personaHygiene,
          // ① 年龄闸口径：每次调用带的优先，其次工厂 options 带的，都没有则由 `retrieve()` 里
          //   走 `memory.configure({working})` 注入的那份 / 缺省。本模块不 import config-store。
          working: opts.working ?? opt.working,
          // ★ 轻上下文不记命中（`retrieve` 的 ⑦ 步）：同一轮两次 prepare 只该记一次账。
          noHit: lightContext,
          need: { subjectIds, limit: recallLimit }
        });
        keywordItems = Array.isArray(res?.items) ? res.items : [];
        // ★ 轻上下文（JEV 前）：只保留"必须更正"这一类观察，其余长期印象/近况等留给最终上下文
        //   按 `memoryPolicy` 取。判据走 `memory/index.js isCorrectionObservation`（与 prompt 的
        //   【明确更正】入口判据同一口径：correction===true ‖ memoryClass/type 的 legacy 兜底），
        //   不在这里另写一句 `correction===true`（形状差会让必须更正被误滤）。
        //   `noHit` 让这次读取**不记命中**（两次 prepare 不许重复记账）。
        if (lightContext) keywordItems = keywordItems.filter((it) => isCorrectionObservation(it));
        keywordDropped = Array.isArray(res?.dropped) ? res.dropped.length : 0;
        keywordTruncated = num(res?.truncated);
        readings.observationRowsScanned = num(res?.scanned);
        readings.recallCandidates = num(res?.candidateCount);
        readings.recallTruncated = keywordTruncated;
        readings.workingExpired = num(res?.workingGate?.expiredDropped);
        readings.workingRescued = num(res?.workingGate?.topicRescued);
      } catch { /* 检索失败不抛：降级成"没召回到"，诊断里体现 */ retrievalFailed = true; }

      // ★ 轻上下文：**跳过语义腿**（可选长期召回），只带更正类关键词结果；
      //   最终上下文（`memoryPolicy.recall!==false`）才跑向量检索。
      const recalled = lightContext
        ? {
          items: keywordItems.slice(0, recallLimit),
          recallMode: 'deferred', semanticDegraded: false, semanticReason: 'defer-optional-recall',
          droppedStale: 0, droppedWorking: 0,
        }
        : await recallWithSemantic({ chatKey, kind, query, subjectIds, nowTs, recallLimit, keywordItems, working: workingCtx, personaTwo, personaHygiene });
      // ① 语义这条腿拦下的条数并进同一个计数（两条腿合计数，见上面 readings 那两行的注释）
      readings.workingExpired += num(recalled?.droppedWorking);
      // 两条召回路径（关键词 / 语义）出来的条目都必须带齐小契约的四个键：
      //   memoryId / personId / sourceIds / reason。缺哪个补哪个，值一律取自己那份旧键，不另造数据。
      //   （`score` 只有关键词路径给，语义命中不带 —— 面板要显示分数时按"缺就没有"处理。）
      const recalledItems = (Array.isArray(recalled.items) ? recalled.items : []).map((it) => ({
        ...it,
        memoryId: it?.memoryId ?? it?.id,
        personId: it?.personId ?? it?.subjectId,
        sourceIds: Array.isArray(it?.sourceIds) ? it.sourceIds : (it?.evidenceIds || []).slice(),
        reason: it?.reason ?? (it?.source === 'semantic' ? '语义相近' : '按综合得分排到前面'),
      }));
      readings.recalledCount = recalledItems.length;

      let activeTodos = [];
      if (todos && typeof todos.activeTodos === 'function') {
        activeTodos = readMemory({ route: 'activeTodos', input: {
          todos, options: { chatKey, limit: 10, personIds: subjectIds }
        } }).items;
      }

      const st = loadState();
      const ck = cursorOf(st, chatKey);

      // episode 只取**未过期**的；默认不给正文以外的诊断字段（方案 §4.2：status 不含聊天正文）。
      //
      // ★ P0-3 读端（功能表 5 · 2026-10-11）：`forget()` 之后若不在这里拦，后台整理/旧 episode
      //   会把用户已经忘掉的事实**原样送回提示词**（= 复活；本文件 :21-22 那条纪律的"另一半"，
      //   改前只有写端一条腿）。抑制表键是 (chatKey, speakerId) + from 时间 ⇒ 逐条 sourceRef 判。
      //   extractor 只照抄 messageId（extractor.js:107-109），validateEpisodes 补的
      //   speakerId=''/at:0 判不了 ⇒ 缺的就回查证据账本；还判不了就**如实放行**，不假装抑制。
      const episodeSuppress = makeSuppressionFilter({ dataDir });
      let evidenceStore = null;
      const isSuppressedRef = (ref) => {
        const refChatKey = String(ref?.chatKey ?? '') || String(chatKey ?? '');
        let speakerId = String(ref?.speakerId ?? '');
        let at = num(ref?.at);
        const messageId = String(ref?.messageId ?? '');
        if ((!speakerId || !at) && messageId) {
          try {
            evidenceStore ||= openStore(dataDir);
            readings.evidenceLookups += 1;
            const ev = getEvidence(evidenceStore, messageId);
            if (ev) {
              if (!speakerId) speakerId = String(ev.speakerId ?? '');
              if (!at) at = num(ev.at);
            }
          } catch { /* 证据账本读不到 ⇒ 这条 ref 判不了，走"放行"分支 */ }
        }
        if (!speakerId || !at) return false;
        return episodeSuppress({ chatKey: refChatKey, speakerId, at });
      };
      // ★ 轻上下文：**跳过情节摘要召回**（可选长段），最终上下文才读。
      const allEpisodes = lightContext ? [] : readMemory({ route: 'episodes', input: { dataDir } }).items;
      readings.episodeRowsRead = allEpisodes.length;
      // ★ 归属标读端（2026-10-13 裁定 A 批）：另一人格在位时压出的摘要**不送回本轮视图**。
      //   判据不在此处另写 —— 与近期原文（:590）、证据账本（:478）走同一个 `observationVisibleToPersona`；
      //   存量无 `persona2` 标的行 ⇒ 恒按第一人格可见（零迁移）。UI/排障那条读路径不过这里，展示不滤。
      const liveEpisodes = allEpisodes
        .filter((ep) => String(ep?.namespace?.chatKey ?? '') === String(chatKey ?? ''))
        .filter((ep) => observationVisibleToPersona(ep, personaTwo, personaHygiene))
        .filter((ep) => ep.validUntil == null || num(ep.validUntil) >= nowTs)
        .filter((ep) => !(Array.isArray(ep?.sourceRefs) && ep.sourceRefs.some(isSuppressedRef)));
      const episodeSummaries = liveEpisodes.slice(-20)
        .map((ep) => {
          // ★ 这条摘要**覆盖了哪段时间的消息**：取来源引用的消息时间，不是 `ep.at`。
          //   `ep.at` 是"这条摘要被写出来的那一刻"（normalizeEpisode 里 `at: nowOf(clock)`），
          //   拿它判"原文还在不在本轮窗口里"必然判错 —— 摘要总是比它总结的消息新。
          //   来源没时间（老数据 / 模型没回 `at`）⇒ 两格都给 null：读端据此**保留**，
          //   因为"证明不了冗余"不等于"冗余"，宁可多给一行摘要也不误删信息。
          const refTimes = (Array.isArray(ep?.sourceRefs) ? ep.sourceRefs : [])
            .map((r) => num(r?.at)).filter((v) => Number.isFinite(v) && v > 0);
          return {
            id: ep.id, summary: ep.summary, at: ep.at, version: ep.version, openTodoIds: ep.openTodoIds || [],
            firstSourceAt: refTimes.length ? Math.min(...refTimes) : null,
            lastSourceAt: refTimes.length ? Math.max(...refTimes) : null
          };
        });

      // ★ 2026-10-17（派单⑥统一输出）：**向量腿**补充情节摘要（已在 recallWithSemantic 二次复核
      //   权威行 + named 抑制），这里再过窗口口径 suppression + 同 id 去重后**补位**合并：
      //   关键词腿（上面 `slice(-20)` 的最新 20 行）打头，向量腿只在有名额时按语义相似度排序补进。
      //   名额上限 20 与关键词腿一致 —— 不因向量腿抬高注入量，只是把"语义相关的旧摘要"找回来。
      const mergedEpisodeSummaries = (() => {
        const vector = Array.isArray(recalled?.episodeSummaries) ? recalled.episodeSummaries : [];
        if (!vector.length) return episodeSummaries;
        const seenIds = new Set(episodeSummaries.map((s) => String(s?.id ?? '')));
        const added = [];
        for (const v of vector) {
          const vid = String(v?.id ?? '');
          if (!vid || seenIds.has(vid)) continue;
          if (episodeSummaries.length + added.length >= 20) break;
          // 同一行可能与关键词腿判据不同 —— 这里统一用**窗口口径** `isSuppressedRef`（与 :828 同一实现）。
          if (Array.isArray(v?.sourceRefs) && v.sourceRefs.some(isSuppressedRef)) continue;
          seenIds.add(vid);
          added.push({
            id: vid, summary: v.summary, at: v.at, version: v.version, openTodoIds: v.openTodoIds || [],
            firstSourceAt: v.firstSourceAt ?? null, lastSourceAt: v.lastSourceAt ?? null,
          });
        }
        return [...episodeSummaries, ...added];
      })();
      readings.episodeSummariesVectorAdded = Array.isArray(recalled?.episodeSummaries)
        ? Math.max(0, mergedEpisodeSummaries.length - episodeSummaries.length)
        : 0;
      readings.semanticCardsReturned = Array.isArray(recalled?.semanticCards) ? recalled.semanticCards.length : 0;

      const pendingJobs = Object.values(st.jobs).filter((j) => j.status === 'queued' || j.status === 'running').length;
      // ★ coverage 是**按范围**的数（`coverage.scope` 就是这个会话）⇒ 排队/失败只算本会话的 job，
      //   别的群积压不该让本会话报 partial（那会把"这个群读全了"冲掉）。
      //   `diagnostics.pendingJobs` 仍是全局数（老键，面板/自测在读，不改它的含义）。
      const jobsHere = Object.values(st.jobs).filter((j) => String(j?.chatKey ?? '') === String(chatKey ?? ''));
      const pendingHere = jobsHere.filter((j) => j.status === 'queued' || j.status === 'running').length;
      const failedHere = jobsHere.filter((j) => j.status === 'failed').length;

      // expiresAt = 最早使本次视图失效的时间（有期限的 episode 里最早那个），没有则 null。
      const expiries = liveEpisodes.map((ep) => num(ep.validUntil, 0)).filter((v) => v > 0);
      const expiresAt = expiries.length ? Math.min(...expiries) : null;

      readings.elapsedMs = Math.round((clockMs() - t0) * 100) / 100;

      // `coverage.state` 三档，判据只看**本轮实际读到了什么**（不预测、不粉饰）：
      //   degraded ⇒ 该读的东西没读到：拿不到会话近期原文，或记忆检索直接失败；
      //   partial  ⇒ 读到了但不全：本会话还有没做完的整理 / 候选超上限这轮没取完 /
      //              来源前沿已经越过游标（有账本里的来源还没被任何批次处理过）；
      //   complete ⇒ 近期原文、有效观察、当前事项都读到了，且没有已知缺口。
      const sourceHighWater = evidenceHighWater(chatKey);
      const processedThrough = num(ck.sourceCursor);
      const unprocessedSources = sourceHighWater !== null && sourceHighWater > processedThrough;
      const stateReason = (!chatStore || typeof chatStore.recent !== 'function')
        ? 'no-chat-store'
        : retrievalFailed
          ? 'retrieval-failed'
          : pendingHere > 0
            ? 'pending-jobs'
            : keywordTruncated > 0
              ? 'candidates-truncated'
              : unprocessedSources
                ? 'sources-ahead-of-cursor'
                : '';
      const coverageState = (!chatStore || typeof chatStore.recent !== 'function' || retrievalFailed)
        ? 'degraded'
        : (pendingHere > 0 || keywordTruncated > 0 || unprocessedSources ? 'partial' : 'complete');

      return {
        schemaVersion: 1,
        namespace: { accountId: accountId || 'default', scope: kind || 'group', chatKey },
        revisions: { content: 1, working: 1, todo: 1, permission: 1, source: ck.sourceCursor, historyEpoch: 1 },
        // ★ 七键（唯一指导 §6.2，M2 · 2026-10-14）：形状与"测不出来就写 null"的规矩在 `coverage.js`，
        //   三个读出口共用那一处，不在本文件再写一份。
        coverage: buildCoverage({
          state: coverageState,
          sourceHighWater,
          processedThrough,
          pendingCount: pendingHere,
          failedCount: failedHere,
          scope: { accountId: accountId || 'default', kind: kind || 'group', chatKey: String(chatKey ?? '') },
          ...coverageGeneration(),
          lastSuccessfulThrough: ck.successThrough,
          stateReason,
        }),
        checkpoint: {
          id: `cp-${nowTs}`,
          version: 1,
          sourceCursor: ck.sourceCursor,
          backgroundItems: 0,
          episodeSummaries: mergedEpisodeSummaries,
        },
        recent: recentMessages,
        working: [],
        recalled: recalledItems,
        // ★ 2026-10-17（派单⑥统一输出）：向量腿语义卡（已复核权威卡表）。compose 合并度用 ——
        //   形状与 `SemanticCardStore.match()` 的产物同构（type/title/detail/tags/key…）。
        //   ★ 消费侧口径（`compose.js:2692-2730` 实读，2026-10-17 更正本注释）：
        //   `api.architecture.semanticTopN` 夹的是**两条腿合并后的总数**；但 20 分钟重复过滤
        //   `filterFreshCards` 只作用在 `store.match()` 的关键词腿上，**向量腿这批卡不过它** ——
        //   同一张卡在 20 分钟内被向量腿反复命中时会反复注入（已作为跨域项交指挥，修在消费侧）。
        semanticCards: Array.isArray(recalled?.semanticCards) ? recalled.semanticCards : [],
        // ★ 2026-10-16：把本轮**实际执行**的记忆策略如实回给调用方（ds3 用它决定注入/展示口径）。
        memoryPolicy,
        todos: activeTodos,
        dependencies: recalledItems.map((r) => ({ kind: 'observation', id: String(r?.id ?? ''), version: num(r?.version, 1) })),
        expiresAt,
        diagnostics: {
          // ★ 语义召回是否真在用，如实报（方案 §4.2 要求 `diagnostics.recallMode`）。
          recallMode: recalled.recallMode || 'keyword',
          semanticDegraded: recalled.semanticDegraded === true,
          semanticReason: recalled.semanticReason || '',
          // ★ 轻上下文（JEV 前）如实标记：跳过的是**可选**读取，不是"读失败"。
          lightContext,
          memoryPolicy,
          droppedCounts: keywordDropped + num(recalled.droppedStale),
          pendingJobs,
          excludedCurrentIds: excludedCurrent,
          inferredCurrentIds: inferredCurrent,
          readings,
        },
      };
    },

    /**
     * 语义召回（方案 §5.2 第 3 条）：
     *   「按 namespace/允许 sourceIds 限定候选，**再二次验证观察状态**」
     *
     * ★ 两条纪律：
     *   ① **不许以"索引还没同步"为由返回已失效事实** ⇒ 候选必须再过一次
     *      `activeObservations` + 有效期 + 抑制检查，失效的一律剔掉并记账。
     *   ② 缺 embedder / 索引没就绪 ⇒ **如实降级成关键词**并在 `recallMode` 标出来，
     *      绝不伪装成语义成功、也绝不静默返回空。
     */
    recordOutcome: async (opts = {}) => {
      const { chatKey, kind, turnId, toolResults, confirmedSendReceipts } = opts;
      const events = [];

      if (Array.isArray(toolResults)) {
        toolResults.forEach((row, index) => {
          const tool = String(row?.tool ?? '').trim();
          if (!tool) return;
          const state = String(row.state ?? '');
          events.push({
            id: `outcome:${String(turnId ?? 'turn')}:tool:${index}:${tool}`,
            at: nowOf(clock),
            chatKey: String(chatKey ?? ''),
            kind,
            sourceType: 'tool_confirm',
            sender: { id: accountId },
            text: `${tool}：${row.ok === true ? '完成' : '失败'}${state ? `（${state}）` : ''}`,
            toolReceipt: { tool, ok: row.ok === true, state, ...(row.resultText ? { resultResult: String(row.resultText).slice(0, 4000) } : {}) },
            mentions: [],
            media: [],
          });
        });
      }

      if (Array.isArray(confirmedSendReceipts)) {
        confirmedSendReceipts.forEach((sent, index) => {
          const receipt = sent?.receipt;
          // ★ 只认**已确认**的回执（方案 §5.4：「发送失败/结果未知不能写成『已经告诉用户』」）。
          if (!receipt || receipt.ok !== true || !receipt.platformId) return;
          events.push({
            id: `outcome:${String(turnId ?? 'turn')}:send:${String(receipt.platformId)}:${index}`,
            at: num(receipt.at) || nowOf(clock),
            chatKey: String(chatKey ?? ''),
            kind,
            sourceType: 'bot_output',
            sender: { id: accountId },
            text: String(sent.text ?? ''),
            toolReceipt: { platformId: String(receipt.platformId), ok: true, tool: String(sent?.tool ?? '') },
            mentions: [],
            media: [],
          });
        });
      }

      if (!events.length) {
        return { ok: true, recorded: 0, persisted: true, reason: 'no-confirmed-outcomes' };
      }
      const result = await recordEvidence(events, { dataDir });
      const invalidCount = Array.isArray(result?.invalid) ? result.invalid.length : 0;
      const addedCount = Array.isArray(result?.added) ? result.added.length : 0;
      const duplicateCount = Array.isArray(result?.duplicate) ? result.duplicate.length : 0;
      return {
        ok: result?.ok !== false && invalidCount === 0,
        recorded: addedCount + duplicateCount,
        persisted: result?.ok !== false && invalidCount === 0,
        duplicateCount,
        reason: invalidCount ? 'm6-outcome-evidence-rejected' : '',
      };
    },

    /**
     * 请求后台整理（方案 §4.2 表）。
     * ★ **只排队，不干活**：「不在 HTTP 请求里扫描全部旧聊天」。
     * ★ **合并重复请求**：同一 `(chatKey, kind)` 已有 queued/running 的 job ⇒ 返回**同一个 jobId**。
     *
     * ★★ N39 追加 · 新入参 **`subjectIds`**（"只整理某人"）：
     *   `requestConsolidation({ chatKey, kind, reason, subjectIds: ['10001'] })`
     *   · 不给 / 空数组 ⇒ 全收（旧行为，会话级游标）。
     *   · 给了 ⇒ 只整理这些人，且**游标只推进这些人**（`cursors[chatKey].subjects[sid]`），
     *     没被选中的人**留在原地、下次还在**。
     *   ★ 合并键**含 subjectIds**：整会话的 job 与"只整甲"的 job 是**两件事**，
     *     合成一个会让收窄意图丢失（也正是本条要修的那个洞）。
     */
    requestConsolidation: async (opts = {}) => {
      const { chatKey, kind, reason } = opts;
      if (!chatKey) return { ok: false, queued: false, error: 'invalid-opts' };
      const wantSubjects = Array.isArray(opts.subjectIds)
        ? [...new Set(opts.subjectIds.map(String).filter(Boolean))].sort()
        : null;
      const subjectKey = wantSubjects && wantSubjects.length ? wantSubjects.join(',') : '';
      // ★ 手工编辑锁：自动/手动 job 的合并键必须区分 —— 合在一起会悄悄改变锁语义
      //   （手动绕过锁的请求不该把自动请求"带过"锁检查）。约定 reason === 'auto-maintenance' 受锁。
      const isAuto = String(reason || '') === 'auto-maintenance';
      const mergeKey = `${subjectKey}|${isAuto ? 'auto' : 'manual'}`;

      const st = loadState();
      const stKind = String(kind || 'group');
      // ① 合并重复：有活跃 job 就并进去，不新建、不重复计费。
      //    ★ 收窄集合不同就不合并（见上）；自动/手动不同也不合并（锁语义）。
      for (const [id, job] of Object.entries(st.jobs)) {
        if (job.status !== 'queued' && job.status !== 'running') continue;
        if (String(job.chatKey) !== String(chatKey) || String(job.kind) !== stKind) continue;
        const jobSubjectKey = Array.isArray(job.subjectIds) && job.subjectIds.length ? job.subjectIds.join(',') : '';
        const jobIsAuto = String(job.reason || '') === 'auto-maintenance';
        const jobMergeKey = `${jobSubjectKey}|${jobIsAuto ? 'auto' : 'manual'}`;
        if (jobMergeKey !== mergeKey) continue;
        job.mergeCount = num(job.mergeCount, 1) + 1;
        job.lastRequestedAt = nowOf(clock);
        if (reason) job.reasons = [...new Set([...(job.reasons || [job.reason || '']), String(reason)])].filter(Boolean);
        saveState(st);
        return { ok: true, queued: true, merged: true, jobId: id, status: job.status, mergeCount: job.mergeCount, narrowed: !!subjectKey };
      }

      // ② 新建。
      const jobId = `job-${nowOf(clock).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      st.jobs[jobId] = {
        chatKey: String(chatKey),
        kind: stKind,
        subjectIds: wantSubjects && wantSubjects.length ? wantSubjects : null,
        reason: String(reason || ''),
        reasons: reason ? [String(reason)] : [],
        status: 'queued',
        createdAt: nowOf(clock),
        lastRequestedAt: nowOf(clock),
        attempts: 0,
        mergeCount: 1,
      };
      saveState(st);
      return { ok: true, queued: true, merged: false, jobId, status: 'queued', mergeCount: 1, narrowed: !!subjectKey, subjectIds: wantSubjects };
    },

    /**
     * 真正执行一个排队中的 job（串行；可重入 —— 已在跑就直接报 `busy`）。
     * 调用方可以是定时器 / 装配层 / 测试。**默认不自带定时器**（模块不自起常驻进程）。
     *
     * @returns {Promise<object>} job 的最终状态（含 episodes/rejected/cursor 读数）
     */
    runNextJob: async (opts = {}) => {
      if (running) return { ok: true, ran: false, reason: 'busy' };
      const st = loadState();
      const pending = Object.entries(st.jobs)
        .filter(([, j]) => j.status === 'queued')
        .sort((a, b) => num(a[1].createdAt) - num(b[1].createdAt));
      if (!pending.length) return { ok: true, ran: false, reason: 'queue-empty' };
      const [jobId] = pending[0];
      running = true;
      try {
        return await runJob(st, jobId, opts);
      } finally {
        running = false;
      }
    },

    /** 只读状态（方案 §4.2 表）：队列 / 游标 / 版本 / 最近整理状态；**默认无聊天正文**。 */
    status: async (opts = {}) => {
      const st = loadState();
      const chatKey = opts?.chatKey;
      const jobs = Object.entries(st.jobs).map(([id, j]) => ({
        jobId: id,
        chatKey: j.chatKey,
        kind: j.kind,
        status: j.status,
        attempts: num(j.attempts),
        mergeCount: num(j.mergeCount, 1),
        createdAt: j.createdAt,
        episodes: num(j.episodes),
        rejected: num(j.rejected),
        // ★ 第五批 N4：这批自动整理写了几条人物印象（0 = 没写/旧 extract 不产印象）。
        impressions: num(j.impressions),
        impressionRejected: num(j.impressionRejected),
        impressionRecheckLockedSkipped: Array.isArray(j.impressionRecheckLockedSkipped) ? j.impressionRecheckLockedSkipped : null,
        // ★ N39：这一批是不是"只整某人"、整的是谁（UI/排障要看，别让它是个黑盒）。
        narrowed: Array.isArray(j.subjectIds) && j.subjectIds.length > 0,
        subjectIds: Array.isArray(j.subjectIds) ? j.subjectIds : null,
        reason: j.status === 'unconsolidated' ? String(j.reason || 'no-extractor') : '',
      }));
      const filtered = chatKey ? jobs.filter((j) => String(j.chatKey) === String(chatKey)) : jobs;
      const byStatus = {};
      for (const j of filtered) byStatus[j.status] = (byStatus[j.status] || 0) + 1;
      return {
        ok: true,
        version: STATE_VERSION,
        queues: byStatus.queued || 0,
        running: byStatus.running || 0,
        unconsolidated: byStatus.unconsolidated || 0,
        failed: byStatus.failed || 0,
        done: byStatus.done || 0,
        activeJobs: (byStatus.queued || 0) + (byStatus.running || 0),
        cursor: chatKey ? cursorOf(st, chatKey).sourceCursor : Object.fromEntries(
          Object.entries(st.cursors).map(([k, v]) => [k, cursorOf(st, k).sourceCursor])
        ),
        // ★ 裁定（M2 收口 2026-10-14）：成功前沿也上面板，和上面的 cursor 放一处对照就能看出
        //   "整过去了"和"真整理成功"不是一回事（摘要全被拒而跳过的那一批推进 cursor、不动这里）。
        //   形状照 cursor：给 chatKey 就单值，不给就按会话成图；没记过是 null，不报成 0。
        lastSuccessfulThrough: chatKey
          ? (cursorOf(st, chatKey).successThrough ?? null)
          : Object.fromEntries(Object.entries(st.cursors).map(([k]) => [k, cursorOf(st, k).successThrough ?? null])),
        // ★ N39：按人分桶的游标（"只整某人"时只有被选中那个人会前进）。
        //   UI/排障要能看见「乙丙还欠着没整」，否则那个洞又会变成"看不见的洞"。
        subjectCursors: chatKey
          ? { ...(cursorOf(st, chatKey).subjects || {}) }
          : Object.fromEntries(Object.entries(st.cursors).map(([k]) => [k, { ...(cursorOf(st, k).subjects || {}) }])),
        jobs: filtered,
        // ★ 2026-10-17（派单⑦轻计数）：episodesOnDisk 不再整读 episodes.jsonl（stat 快照命中即复用）；
        //   加一张三类长期源的行/卡条数（各只读文件条数，无任何摘要正文/卡内容）。
        episodesOnDisk: episodeCount(dataDir),
        longtermSourceCounts: {
          episodes: episodeCount(dataDir),
          semanticCards: cardCountOf(path.join(dataDir, 'semantic-cards')),
        },
        suppressions: suppressionStats({ dataDir }),
        hasExtractor: typeof extract === 'function',
        hasSemantic: !!semantic && typeof semantic.retrieve === 'function',
        // ★ 派单③：创建工厂时从数据文件恢复的上次中断的 running（给 UI/排障/自测看，别让它变成看不见的黑盒）。
        startupRecovery,
        semanticMaintenance: {
          enabled: semanticReady(),
          pendingChanges: semanticChanges,
          running: !!semanticRebuildRunning,
          lastRunAt: semanticLastRunAt,
          lastReason: semanticLastReason,
          lastResult: semanticLastResult,
        },
        semanticIndex: semanticReady()
          ? (typeof semantic.runtimeStatus === 'function'
            ? await semantic.runtimeStatus()
            : { state: typeof semantic.status === 'function' ? semantic.status() : null })
          : null,
        updatedAt: st.updatedAt,
      };
    },

    /** 读 episodes（只读；给 UI/排障）。 */
    episodes: async (opts = {}) => {
      const rows = readEpisodes();
      const chatKey = opts?.chatKey;
      const nowTs = num(opts?.now) || nowOf(clock);
      return rows
        .filter((ep) => !chatKey || String(ep?.namespace?.chatKey ?? '') === String(chatKey ?? ''))
        .filter((ep) => ep.validUntil == null || num(ep.validUntil) >= nowTs);
    },

    /** 显式遗忘时写抑制（由 `forget()` 或调用方调）；**必须在撤回之后、任何再整理之前**。 */
    suppress: (opts = {}) => addSuppression({ dataDir, ...opts }),

    /** 启动 / 内容积累 / 手动入口：从当前有效观察重建语义索引。 */
    rebuildSemanticIndex: (opts = {}) => rebuildSemanticIndex(opts),

    /** 关闭：停串行标志 + 持久化队列状态（方案 §4.2 表：`close()` 停定时器、持久化队列状态）。 */
    close: async () => {
      running = false;
      semanticRebuildClosed = true;
      if (semanticRebuildTimer) clearTimeout(semanticRebuildTimer);
      semanticRebuildTimer = null;
      unsubscribeObservationChanges();
      for (const off of unsubscribeLongtermChanges) {
        try { off(); } catch { /* 关闭期解除失败不抛 */ }
      }
      if (semanticRebuildRunning) await semanticRebuildRunning.catch(() => {});
      try { saveState(loadState()); } catch { /* 关闭期写失败不抛 */ }
      return { ok: true };
    },
  };

  // ── 内部：语义召回（方案 §5.2 第 3 条） ──────────────────────────────────
  //
  //   「按 namespace/允许 sourceIds 限定候选，**再二次验证观察状态**」
  //
  // ★ 两条纪律：
  //   ① **不许以"索引还没同步"为由返回已失效事实** ⇒ 候选必须再过一次
  //      `activeObservations` + 有效期 + 范围，失效的一律剔掉并记账。
  //   ② 缺 embedder / 索引没就绪 ⇒ **如实降级成关键词**并在 `recallMode` 标出来，
  //      绝不伪装成语义成功、也绝不静默返回空。
  async function recallWithSemantic({ chatKey, kind, query, subjectIds, nowTs, recallLimit, keywordItems, working, personaTwo, personaHygiene }) {
    const kw = Array.isArray(keywordItems) ? keywordItems : [];
    // ① 年龄闸：关键词腿在 `index.js retrieve()` 里已经拦过一道，语义这条腿的候选来自向量索引，
    //   不经过那里 ⇒ 必须在这里用**同一份判据**（`working-window.js`）补上，否则超期的短期状态
    //   只要被语义索引捞到就还是会给模型。口径由调用方解析后传进来，两条腿共用。
    const workingCtx = working || resolveWorking(null);
    const finish = (mode, reason) => ({
      items: kw.slice(0, recallLimit),
      recallMode: mode,
      semanticDegraded: mode === 'keyword',
      semanticReason: reason || '',
      droppedStale: 0,
      droppedWorking: 0,
      // ★ 2026-10-17（派单⑤分源型复核）：语义腿的三类输出各自归口 —— 观察条目仍在 `items`
      //   （走既有 recallItemShape），新源型走专属输出（卡片给 compose 合卡注入、情节给 checkpoint 合并）。
      semanticCards: [],
      episodeSummaries: [],
    });
    if (!semantic || typeof semantic.retrieve !== 'function') return finish('keyword', 'no-semantic-index');
    if (typeof semantic.embedding === 'function' && !semantic.embedding()) return finish('keyword', 'no-embedder');

    let semResult;
    try {
      semResult = await readMemory({ route: 'semanticCandidates', input: {
        semantic,
        options: {
          query: String(query ?? ''),
          scope: kind || 'group',
          scopeChatKey: kind === 'global' ? null : chatKey,
          at: nowTs,
          topK: recallLimit,
        },
      } });
    } catch (error) {
      return finish('keyword', `semantic-threw:${String(error?.message ?? error).slice(0, 80)}`);
    }

    // ★ 2026-10-17（qwen3 审查修）：卡/情节候选**不占观察那条腿的 `recallLimit` 窗口**。
    //   `mergeWithKeyword` 把语义项排在关键词项之前统一截断，而卡/情节的产出走的是**另外的通道**
    //   （`semanticCards` / `episodeSummaries`）。它们混在同一个窗口里时，向量腿只要返回
    //   `recallLimit` 条卡，`merged.items` 就没有任何观察 ⇒ `keep` 空 ⇒ `items: []`：
    //   群里的长期印象会被卡整批挤掉（7c783232 前不存在这条路径，那时卡根本不进向量腿）。
    //   这里在融合前把两类新源型摘出来，观察窗口仍归观察；卡/情节按各自通道在末尾单独夹取。
    const semItems = Array.isArray(semResult?.items) ? semResult.items : [];
    const isLongtermShape = (it) => it?.sourceType === 'semantic_card' || it?.sourceType === 'episode_summary';
    const longtermCandidates = semItems.filter(isLongtermShape);
    const merged = mergeWithKeyword(
      kw,
      longtermCandidates.length ? { ...semResult, items: semItems.filter((it) => !isLongtermShape(it)) } : semResult,
      { limit: recallLimit },
    );
    if (merged?.degraded) return finish('keyword', String(merged.reason || 'semantic-degraded').slice(0, 160));

    // ★★ 二次验证：向量索引可能比账本旧（撤回/过期不会自动从索引消失）。
    let live;
    try {
      const store = openStore(dataDir);
      live = new Map();
      for (const row of activeObservations(store)) {
        if (row.validUntil != null && num(row.validUntil) < nowTs) continue;
        live.set(String(row.id), row);
      }
    } catch {
      return finish('keyword', 'revalidate-store-unavailable');
    }

    const subjectFilter = Array.isArray(subjectIds) && subjectIds.length ? new Set(subjectIds.map(String)) : null;
    // ★ M6 读点②的另一条腿（2026-10-14）：语义召回**也要**过抑制账本。
    //   二次验证只挡"已撤回/已过期/越范围"，挡不住"来源被点名字忘掉但这一行还活着"；
    //   关键词那条腿在 `memory/index.js retrieve()` 里收口，语义这条腿不走它 ⇒ 必须在此处补同一判据。
    //   判据共用 `suppressions.js namedSuppressedEvidenceIds`（只比编号）：
    //   窗[from, ∞)口径是给写侧用的，读侧照抄会连坐没被忘的旧内容（本文件 :172 那条自测钉着）。
    const namedSuppressed = namedSuppressedEvidenceIds({ dataDir });
    const sourceSuppressed = (row) => namesSuppressedSource(row.evidenceIds, namedSuppressed);
    // ★ 2026-10-17（安全审查 · 读侧 fail-closed）：抑制账本读不全 ⇒ 这一轮**一条候选都不采信**。
    //   理由与 `memory/index.js retrieve()` 同：空集合在上游语义上就是"没被忘过"，
    //   而"读不到"绝不能被折算成那个意思（那才是遗忘失效的成因本身）。
    //   正常可读时下面的 `keep` 循环逐字不变。
    const suppressionHealth = ledgerHealthOf(namedSuppressed);
    const ledgerSick = suppressionHealth.ok === false;
    const keep = [];
    const semanticCards = [];
    const vectorEpisodeSummaries = [];
    let droppedStale = 0;
    let droppedWorking = 0;

    // ★ 2026-10-17（派单⑤）分源型到**正确权威源**复核：现把任何候选都查 `activeObservations`
    //   live Map ⇒ 新源型（semantic_card / episode_summary）全被当 stale 丢掉。现在：
    //   · observation → activeObservations（原路径，逐字保留）；
    //   · semantic_card → cards.json 最新卡表（stat 缓存读，热路径近乎免费）；
    //   · episode_summary → episodes.jsonl 最新行（同 id 重写取最后一行）。
    //   复核统一覆盖：范围（chatKey/namespace）、行/卡有效期、人格可见性（episode 存 persona2 标）、
    //   真实证据抑制（named set）、subject 收窄 —— 不绕 prepareContext 的会话授权。
    let cardBy = null;
    try {
      const cardsSnap = cachedCardRows(path.join(dataDir, 'semantic-cards'));
      if (cardsSnap.readable !== false) {
        cardBy = new Map();
        for (const c of cardsSnap.rows ?? []) if (c && typeof c === 'object' && c.key) cardBy.set(String(c.key), c);
      }
    } catch { /* 卡权威读失败 = 这类候选按 stale 处理（不装作"索引是好的"） */ }
    let epBy = null;
    try {
      const epsSnap = cachedEpisodeRows(dataDir);
      if (epsSnap.readable !== false) epBy = latestEpisodeRowsById(dataDir);
    } catch { /* 情节权威读失败 = 这类候选按 stale 处理 */ }

    for (const item of [...(merged.items || []), ...longtermCandidates]) {
      // 抑制账本读不全 ⇒ 整批候选一律不采信（见上方 `ledgerSick` 的口径说明）。
      if (ledgerSick) { droppedStale += 1; continue; }
      const sourceType = String(item?.sourceType ?? '');

      // ── 语义卡候选：`card:<key>` → 权威卡行 ─────────────────────────────────
      if (sourceType === 'semantic_card') {
        const recordId = String(item?.id ?? '');
        const cardKey = recordId.startsWith('card:') ? recordId.slice('card:'.length) : '';
        const row = cardBy ? (cardBy.get(cardKey) ?? null) : null;
        if (!row) { droppedStale += 1; continue; }               // 索引有、权威卡表已没有（过期/被挤出/坏行）
        // 范围：查询侧 scope 过滤过一次；这里按权威行 chatKey 再核（不打准的候选当场剔）。
        if (String(row.chatKey ?? '') !== String(chatKey ?? '')) { droppedStale += 1; continue; }
        // 有效版本：plan 30 天（与 `match()` 同口径；过期卡在 sync 时已被隔离，索引里不应再有）。
        const ageMs = Math.max(0, num(nowTs) - (Number(row.lastTs) || 0));
        if (row.type === 'plan' && ageMs > 30 * 24 * 60 * 60 * 1000) { droppedStale += 1; continue; }
        // 真实证据抑制：只比编号（写出侧的隔离与整体 prune 在 rebuildSemanticIndex 收口）。
        const cardEvidence = (Array.isArray(row.sourceRefs) ? row.sourceRefs : [])
          .map((r) => String(r?.messageId || r?.localId || '').trim()).filter(Boolean);
        if (namesSuppressedSource(cardEvidence, namedSuppressed)) { droppedStale += 1; continue; }
        // subject 收窄：卡是会话范围级材料、行上无 subjectId —— 收窄模式下不给（宁缺勿错）。
        if (subjectFilter) { droppedStale += 1; continue; }
        semanticCards.push({
          key: String(row.key),
          id: recordId,
          type: row.type === 'plan' ? 'plan' : (row.type === 'fact' ? 'fact' : 'topic'),
          title: String(row.title ?? ''),
          detail: String(row.detail ?? ''),
          tags: Array.isArray(row.tags) ? row.tags.slice(0, 8) : [],
          chatKey: String(row.chatKey ?? ''),
          hits: num(row.hits, 1),
          lastTs: Number(row.lastTs) || 0,
          score: Number.isFinite(Number(item?.score)) ? Number(item.score) : null,
          weightedScore: Number.isFinite(Number(item?.weightedScore)) ? Number(item.weightedScore) : null,
          source: 'semantic-vector',
          sourceType: 'semantic_card',
        });
        continue;
      }

      // ── 情节摘要候选：记录 id（真实或派生）→ 权威行 ───────────────────────────
      if (sourceType === 'episode_summary') {
        const recordId = String(item?.id ?? '');
        const row = epBy ? (epBy.get(recordId) ?? null) : null;
        if (!row) { droppedStale += 1; continue; }
        if (String(row?.namespace?.chatKey ?? '') !== String(chatKey ?? '')) { droppedStale += 1; continue; }
        if (row.validUntil != null && num(row.validUntil) < nowTs) { droppedStale += 1; continue; }
        if (!observationVisibleToPersona(row, personaTwo, personaHygiene)) { droppedStale += 1; continue; }
        const refs = Array.isArray(row?.sourceRefs) ? row.sourceRefs : [];
        const epEvidence = refs.map((r) => String(r?.messageId ?? '').trim()).filter(Boolean);
        if (namesSuppressedSource(epEvidence, namedSuppressed)) { droppedStale += 1; continue; }
        // subject 收窄：情节只带发言指针 —— 行的说话人**无歧义且全部在收窄集合里**才放行；
        // 判不出归属（老行无 speakerId）⇒ 不给（宁缺勿错，prepareContext 只授权当前会话）。
        if (subjectFilter) {
          const speakers = [...new Set(refs.map((r) => String(r?.speakerId ?? '').trim()).filter(Boolean))];
          if (!speakers.length || speakers.some((s) => !subjectFilter.has(s))) { droppedStale += 1; continue; }
        }
        const refTimes = refs.map((r) => num(r?.at)).filter((v) => Number.isFinite(v) && v > 0);
        vectorEpisodeSummaries.push({
          id: recordId,
          summary: String(row.summary ?? ''),
          at: num(row.at),
          version: num(row.version, 1),
          openTodoIds: Array.isArray(row.openTodoIds) ? row.openTodoIds.map(String).slice(0, 16) : [],
          firstSourceAt: refTimes.length ? Math.min(...refTimes) : null,
          lastSourceAt: refTimes.length ? Math.max(...refTimes) : null,
          // 供 prepareContext 复用既有 `isSuppressedRef`（窗口口径）做合并前最后一道防线。
          sourceRefs: refs.slice(0, 8),
          score: Number.isFinite(Number(item?.score)) ? Number(item.score) : null,
          weightedScore: Number.isFinite(Number(item?.weightedScore)) ? Number(item.weightedScore) : null,
          source: 'semantic-vector',
          sourceType: 'episode_summary',
        });
        continue;
      }

      // ── 观察候选（原路径，逐字保留）───────────────────────────────────────
      const id = String(item?.id ?? item?.sourceId ?? '');
      const row = id ? live.get(id) : null;
      if (!row) { droppedStale += 1; continue; }                       // 索引里有、账本里已失效
      if (subjectFilter && !subjectFilter.has(String(row.subjectId ?? ''))) { droppedStale += 1; continue; }
      // prepareContext 只授权当前会话。跨群共享要走带逐条授权的专用读取入口，
      // 不能因为向量候选的 scope=global 就绕过会话与授权检查。
      // 2026-11-05：跨房主体（默认只有她本人）例外——她在哪个房间都是同一个人，
      // 私聊里记的和群里记的分成两套，等于两边各失忆一半。别人仍走下面的严格检查。
      const crossSubject = crossScopeSubjects().has(String(row.subjectId ?? '').trim());
      if (!crossSubject && (row.scope !== (kind || 'group') || String(row.chatKey ?? '') !== String(chatKey ?? ''))) { droppedStale += 1; continue; }
      if (!observationVisibleToPersona(row, personaTwo, personaHygiene)) { droppedStale += 1; continue; }
      if (sourceSuppressed(row)) { droppedStale += 1; continue; }      // 来源被抑制 = 忘掉的内容
      // ① 年龄闸（语义这条腿）：判据、口径都跟关键词腿同一份。计数单列，不并进 droppedStale —
      //   "账本里失效"和"账本里还活着、只是这轮不该当近况"是两件事，混在一起面板就查不出是哪一种。
      if (shortTermAgeVerdict({ row, now: nowTs, working: workingCtx, topic: query }).blocked) {
        droppedWorking += 1;
        continue;
      }
      // ★ 2026-10-16：形状与关键词腿归一（`recall-item.js`）—— 语义腿也要带 `subjectId`/`type`，
      //   否则按人聚合的印象注入（compose→prompt）看不见这些条目，按主体过滤也拿不到主体。
      //   值一律取**刚重读的权威 row**；row 上没有的键就不出现（不瞎补类型/置信）。
      keep.push(recallItemShape({
        item,
        row,
        reason: item?.reason ?? '语义相近',
        source: 'semantic',
      }));
    }
    if (!keep.length && !semanticCards.length && !vectorEpisodeSummaries.length) {
      return {
        ...finish('keyword', ledgerSick
          ? `suppression-ledger-unreadable:${suppressionHealth.reason || 'unknown'}`
          : 'all-semantic-candidates-stale'),
        items: kw.slice(0, recallLimit), droppedStale, droppedWorking
      };
    }
    // ★ 如实标记：`degraded` 的含义是「**本轮没真正用上语义**」。
    //   `merged.mode` 还有一种会落到 'keyword-only'/'empty' 的情况：**语义跑了但一条都没进结果**
    //   （索引空、全部被时间边界切掉、相似度都不过阈值）。那种情况必须**照样标 degraded**，
    //   否则会出现 `recallMode:'keyword' + semanticDegraded:false` 这种自相矛盾的读数，
    //   让人以为语义召回健康 —— 这正是方案 §5.2/§5.3 要防的"假装成功"。
    const mode = merged.mode === 'empty' ? 'keyword' : (merged.mode || 'keyword');
    const usedSemantic = mode !== 'keyword' && mode !== 'keyword-only';
    return {
      items: keep.slice(0, recallLimit),
      recallMode: mode,
      semanticDegraded: !usedSemantic,
      semanticReason: usedSemantic ? '' : 'semantic-returned-no-usable-items',
      // ★ 2026-10-17：抑制账本读健康随召回结果带出（只带状态，不带任何正文/编号）。
      suppressionLedger: ledgerSick
        ? { ok: false, reason: suppressionHealth.reason, badLines: suppressionHealth.badLines }
        : { ok: true, absent: suppressionHealth.absent },
      droppedStale,
      droppedWorking,
      // 新源型输出与观察条目分离（卡/情节不是观察，形状也不一样，不塞进 `items` 混账）。
      semanticCards: semanticCards.slice(0, Math.max(1, recallLimit)),
      episodeSummaries: vectorEpisodeSummaries.slice(0, Math.max(1, recallLimit)),
    };
  }

  // ── 内部：跑一个 job ─────────────────────────────────────────────────────

  /**
   * 推进游标 —— ★ N39 追加：**收窄时只推进被选中那个人的桶**，不动会话级游标。
   *
   * 这是「没选中的人留到下次」的唯一实现点。三个分支（无可整理 / 无合格摘要 / 提交成功）
   * **都必须**走它，否则任一分支漏掉都会把别人的消息跨过去。
   *
   * @param {object} stState 持久化状态（就地改）
   * @param {string} chatKey
   * @param {Array} processed 本批**真正处理过**的来源（含被抑制的 —— 它们也算处理过，
   *   否则用户忘掉的东西会让队列永久卡住）
   * @param {string[]|null} subjectIds 本 job 的收窄集合；null = 全收
   * @param {string} jobId
   * @param {boolean} [countedAsSuccess] 这批算不算**拿到明确处理结果**（M2 · §6.2「不能把跳过说成整理成功」）。
   *   · 提交成功（写了摘要）⇒ true；确实没有可整理的来源 ⇒ true（这就是它的处理结果：没有）。
   *   · 抓来的摘要全被判不合格、游标照样跨过这批 ⇒ **false**：`successThrough` 留在原地。
   *   默认 false：漏传只会少报成功，不会把跳过报成成功。
   * @returns {number} 推进后的**会话级**游标（调用方拿它回报用）
   */
  function advanceCursor(stState, chatKey, processed, subjectIds, jobId, countedAsSuccess = false) {
    const cur = cursorOf(stState, chatKey);
    const only = Array.isArray(subjectIds) && subjectIds.length
      ? new Set(subjectIds.map(String).filter(Boolean))
      : null;
    const stamp = nowOf(clock);
    // ★ 机器人自己的行另按**人格**记账（2026-10-13 证据归属标）：
    //   谁的桶推到"这批里她看得见的那些行的最晚时刻"；她看不见的那半**不进她的桶**，留在原地等她自己整理。
    //   开关放开时一行对两个人格都可见 ⇒ 两个桶一起推，同一条不被整理两遍。
    const { hygiene } = personaContext();
    const selfCursors = {
      first: num(cur.selfCursors?.first),
      second: num(cur.selfCursors?.second),
    };
    for (const s of processed) {
      if (s?.self !== true) continue;
      const at = num(s.at);
      if (evidenceVisibleToPersona(s, false, hygiene)) selfCursors.first = Math.max(selfCursors.first, at);
      if (evidenceVisibleToPersona(s, true, hygiene)) selfCursors.second = Math.max(selfCursors.second, at);
    }
    if (!processed.length) {
      // 一条都没处理 ⇒ 游标不动（否则"没消息"和"消息被别的游标跨过"分不清）。
      stState.cursors[chatKey] = { ...cur, selfCursors, lastJobId: jobId, lastAt: stamp };
      return num(cur.sourceCursor);
    }
    const lastAt = Math.max(...processed.map((s) => num(s.at)));
    if (only) {
      // ★ 收窄：只动被选中的人的桶。会话级游标**原封不动** ⇒ 别人下次还在。
      const subjects = { ...(cur.subjects || {}) };
      for (const sid of only) {
        subjects[sid] = Math.max(num(subjects[sid]), num(cur.sourceCursor), lastAt);
      }
      stState.cursors[chatKey] = { ...cur, selfCursors, subjects, lastJobId: jobId, lastAt: stamp };
      return num(cur.sourceCursor);   // 会话级没动 —— **如实回报**
    }
    const next = Math.max(num(cur.sourceCursor), lastAt);
    // 全收批：也把**这批里出现过的人**的分人游标推到同一位置 ——
    //   否则下一轮全收批会用 `max(会话游标, 该人游标)` 把他们**再整一遍**（重复消耗）。
    const subjects = { ...(cur.subjects || {}) };
    for (const s of processed) {
      const sid = String(s?.speakerId ?? '');
      if (!sid) continue;
      subjects[sid] = Math.max(num(subjects[sid]), next);
    }
    // 成功前沿只在**这批真出了结果**时才跟着走；被拒收而跨过的那一批留在原地（§6.2）。
    const successThrough = countedAsSuccess ? Math.max(num(cur.successThrough), lastAt) : cur.successThrough;
    stState.cursors[chatKey] = { ...cur, selfCursors, sourceCursor: next, successThrough, subjects, lastJobId: jobId, lastAt: stamp };
    return next;
  }

  async function runJob(st, jobId, runOpts = {}) {
    const job = st.jobs[jobId];
    if (!job) return { ok: false, ran: false, reason: 'job-not-found' };
    const chatKey = String(job.chatKey);
    const kind = String(job.kind || 'group');
    // ★ 本 job 的收窄集合（requestConsolidation 时定的，存进 job 里 ⇒ 合并重复请求时也一致）。
    let subjectIds = Array.isArray(job.subjectIds) && job.subjectIds.length ? job.subjectIds.slice() : null;

    // ★ 手工编辑锁（约定 reason === 'auto-maintenance' 受锁，其余绕过）：
    //   自动整理对受锁 subject 跳过 —— 不收集其来源、不推进其游标、抽取后不写回。
    //   手动请求（reason !== 'auto-maintenance'）完全不看锁。
    const isAuto = String(job.reason || '') === 'auto-maintenance';
    const lockWin = getLockWindowMs(opt.manualEditLockConfig ?? null);
    let lockedSubjects = new Set();
    if (isAuto) {
      // 先从全量/收窄集里判锁；subjectIds 为 null 时先收集一次发现说话人。
      const discoverForLock = subjectIds || null;
      const discovered = discoverForLock
        ? discoverForLock.map(String)
        : (() => {
          // 全量批：从证据表枚举本会话出现过的说话人
          try {
            const store = openStore(dataDir);
            const speakers = new Set();
            for (const ev of store.evidence.values()) {
              if (String(ev?.chatKey ?? '') !== chatKey) continue;
              const speaker = String(ev?.sender?.id ?? ev?.speakerId ?? '');
              if (speaker) speakers.add(speaker);
            }
            return [...speakers];
          } catch { return []; }
        })();
      lockedSubjects = filterLockedSubjects(discovered, dataDir, lockWin);
      if (lockedSubjects.size) {
        // 把受锁者从有效收窄集排除；全量批转为"非受锁者"收窄批 ⇒
        //   advanceCursor 只推非受锁者的桶、会话游标不动 ⇒ 受锁者游标不被"顺带推进"。
        const nonLocked = discovered.filter((sid) => !lockedSubjects.has(sid));
        subjectIds = nonLocked.length ? nonLocked : [];
        job.lockedSkipped = [...lockedSubjects];
      }
    }

    job.status = 'running';
    job.attempts = num(job.attempts) + 1;
    job.startedAt = nowOf(clock);
    saveState(st);

    // ★ 全部受锁 ⇒ 跳过（不收集、不推进游标、不调 extract）。
    //   subjectIds 为 [] 时 collectSources 会当 null 全收 ⇒ 必须在此显式拦截。
    if (isAuto && Array.isArray(subjectIds) && subjectIds.length === 0) {
      job.status = 'done';
      job.reason = 'all-subjects-locked';
      job.episodes = 0;
      job.finishedAt = nowOf(clock);
      saveState(st);
      return {
        ok: true, ran: true, jobId, status: 'done',
        reason: 'all-subjects-locked', episodes: 0, rejected: 0, impressions: 0,
        lockedSkipped: [...lockedSubjects],
        cursor: cursorOf(st, chatKey).sourceCursor, sourceCount: 0,
      };
    }

    // ① 没有 extract ⇒ **如实标"未整理"，一条 episode 都不写**（不许编造摘要）。
    if (typeof extract !== 'function') {
      job.status = 'unconsolidated';
      job.reason = 'no-extractor';
      job.finishedAt = nowOf(clock);
      saveState(st);
      return {
        ok: true, ran: true, jobId, status: 'unconsolidated',
        reason: 'no-extractor', episodes: 0, rejected: 0, impressions: 0,
        cursor: cursorOf(st, chatKey).sourceCursor, sourceCount: 0,
      };
    }

    // ② 收集游标之后的来源（**只在草稿里推进，提交成功才写回**）。
    // ★ 收集上限 = 抽取端真的会读的条数（min）。否则多收的那截被游标跨过去 = 静默丢。
    const collectCap = Math.max(1, Math.min(
      Math.floor(num(opt.consolidateLimit, 200)),
      Math.floor(num(opt.maxSourcesPerExtract, 80))
    ));
    const collected = collectSources(st, chatKey, collectCap, subjectIds);
    const sources = collected.sources;
    // ★ 本批隐去了多少条"另一人格说过的话"（只记条数，不记正文）。
    job.personaHiddenSources = collected.personaHidden;
    const personaHiddenSources = collected.personaHidden;
    const suppress = makeSuppressionFilter({ dataDir });
    const liveSources = sources.filter((s) => !suppress({ chatKey: s.chatKey, speakerId: s.speakerId, at: s.at }));

    if (!liveSources.length) {
      // 没有可整理的来源：算作**处理完成**（否则会无限重复扫同一段空）。
      // ★ 抑制掉的来源也算"处理过" —— 否则用户忘掉的东西会让队列永久卡住。
      // ★ 用 `sources`（含被抑制的）推进，不是 `liveSources`：被抑制的确实处理过了。
      const stNow = loadState();
      const nextCursor = advanceCursor(stNow, chatKey, sources, subjectIds, jobId, true);
      const j = stNow.jobs[jobId];
      j.status = 'done';
      j.episodes = 0;
      j.skippedSuppressed = sources.length - liveSources.length;
      j.personaHiddenSources = personaHiddenSources;
      j.finishedAt = nowOf(clock);
      saveState(stNow);
      return {
        ok: true, ran: true, jobId, status: 'done', episodes: 0, rejected: 0, impressions: 0,
        skippedSuppressed: sources.length - liveSources.length,
        personaHiddenSources,
        narrowed: !!subjectIds,
        cursor: nextCursor, sourceCount: 0,
      };
    }

    // ③ 调 extract（注入的；M6 自己不 import llm）。
    let out;
    try {
      out = await extract({
        chatKey,
        kind,
        reason: job.reason || '',
        sources: liveSources,
        attempt: job.attempts,
        cursor: cursorOf(st, chatKey).sourceCursor,
        maxEpisodes: 8,
        // ★ 第五批 N4：印象候选跟着同一次调用产出；上限写进调用参数（老 extract 忽略它）。
        maxImpressions: impressionRunCap,
      });
    } catch (error) {
      return failJob(st, jobId, `extract-threw:${String(error?.message ?? error).slice(0, 120)}`, sources.length);
    }

    // ④ 校验 + 抑制复查（extract 可能"顺手"把被抑制的来源写成 episode）。
    const store = (() => { try { return openStore(dataDir); } catch { return null; } })();
    const { accepted, rejected } = store
      ? validateEpisodes(out?.episodes, { chatKey, kind, store })
      : { accepted: [], rejected: [{ reason: 'store-unavailable' }] };
    const allowed = new Set(liveSources.map((s) => s.messageId));
    const kept = accepted.filter((ep) => ep.sourceRefs.some((r) => allowed.has(r.messageId)));
    const droppedBySuppression = accepted.length - kept.length;

    // ④b ★ 2026-10-19（第五批 N4）：人物印象候选 —— 跟同一次整理调用的产出（`out.impressions`）
    //     走**同一条纪律**：逐条校验 → 手工编辑锁提交前复核（自动 job）→ 经公开出口 `commit()` 落盘
    //     （证据账本复核 / 幂等 / persona 打标 / 变更通知全在 commit 里，本模块不另写一份）。
    //     写不写都不改变 episodes 的既有口径；老 extract（只回 episodes）⇒ 候选为空、行为同旧。
    const impOut = store
      ? validateImpressions(out?.impressions, { chatKey, kind, liveSources })
      : { accepted: [], rejected: [{ reason: 'store-unavailable' }], truncated: 0 };
    let impressionCandidates = impOut.accepted;
    if (isAuto && impressionCandidates.length) {
      // extract 期间用户可能刚手工改了印象（与 episodes 的复核同一把锁、同一时机）。
      const impressionLocked = new Set();
      impressionCandidates = impressionCandidates.filter((c) => {
        if (filterLockedSubjects([c.subjectId], dataDir, lockWin).has(c.subjectId)) {
          impressionLocked.add(c.subjectId);
          return false;
        }
        return true;
      });
      if (impressionLocked.size) {
        job.impressionRecheckLockedSkipped = [...impressionLocked];
        // 复核被拦下的 subject 不推进游标：并进同一张集合，让下面的 cursor 过滤也剔掉他们。
        job.recheckLockedSkipped = [...new Set([...(job.recheckLockedSkipped || []), ...impressionLocked])];
      }
    }
    const impScope = kind === 'private' ? 'private' : 'group';
    const batchPersonaTwo = personaContext().personaTwo === true;
    let impressionsWrote = 0;
    let impressionsDuplicate = 0;
    const impressionWriteErrors = [];
    for (let i = 0; i < impressionCandidates.length; i += 1) {
      const candidate = impressionCandidates[i];
      const stamp = nowOf(clock);
      try {
        const res = await commit(
          {
            // id 带 chatKey 归一戳：同一毫秒内两个会话各写第 i 条也不撞（写入键唯一）。
            id: `imp-${stamp}-${i}-${String(chatKey).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48)}`,
            subjectId: candidate.subjectId,
            claim: candidate.claim,
            type: candidate.type,
            scope: impScope,
            chatKey,
            // ★ 铁律①：证据必须在账本里（就是本批 liveSources 里的 messageId，校验时已挡过一道）。
            evidenceIds: candidate.evidenceIds,
            // ★ 不拿模型自报置信度：抽取没有"确定度"信号，取中性 0.5（与回复后自评写入口径一致）。
            confidence: 0.5,
            at: stamp,
            // contracts:452 的 origin 三值之一，本就是为"抽取而来"准备的标。
            origin: 'extracted',
            ...(candidate.kind
              ? { impressionType: candidate.kind, impressionTypeSource: 'model' }
              : { impressionTypeSource: 'none' }),
          },
          {
            dataDir,
            // 幂等键带上证据集合：同说法+同证据的重放不重复写；新证据会走正常的"升版本/补支持"。
            idempotencyKey: `auto-imp:${chatKey}:${candidate.subjectId}:${candidate.evidenceIds.slice().sort().join('+')}:${claimKeyOf(candidate.subjectId, impScope, candidate.claim, chatKey, accountId || 'default')}`,
            persona2: batchPersonaTwo,
          }
        );
        if (res?.ok) {
          if (res.duplicate === true || res.replay === true) impressionsDuplicate += 1;
          else impressionsWrote += 1;
        } else {
          impressionWriteErrors.push(String(res?.errors?.[0] ?? 'rejected'));
        }
      } catch (error) {
        impressionWriteErrors.push(String(error?.message ?? error).slice(0, 80));
      }
    }
    job.impressions = impressionsWrote;
    job.impressionDuplicates = impressionsDuplicate;
    job.impressionRejected = impOut.rejected.length + impressionWriteErrors.length;
    if (impressionWriteErrors.length) job.impressionWriteErrors = impressionWriteErrors.slice(0, 8);
    const impressionStats = {
      impressions: impressionsWrote,
      impressionsDuplicate,
      impressionsRejected: job.impressionRejected,
      ...(job.impressionRecheckLockedSkipped ? { impressionRecheckLockedSkipped: job.impressionRecheckLockedSkipped } : {}),
    };

    if (!kept.length) {
      // 没有合格摘要：算"这一批处理过了"（游标推进），但**如实记账**为 rejected。
      // ★ 这一批**不算整理成功**（`countedAsSuccess` 默认 false）：来源被游标跨过去了，
      //   可一条摘要都没落地 ⇒ `lastSuccessfulThrough` 留在原地，两者一比就是"跳过"的距离。
      // ★ 第五批 N4 追加：印象候选若真的落了盘（或确认重复），这批就**有明确处理结果** ⇒
      //   算成功前沿（改前没有印象可写 ⇒ `impressionsWrote` 恒 0 ⇒ 行为与旧版逐字节相同）。
      const stNow = loadState();
      const recheckSkip = new Set(job.recheckLockedSkipped || []);
      const cursorSources = recheckSkip.size
        ? liveSources.filter((s) => !recheckSkip.has(String(s?.speakerId ?? '')))
        : liveSources;
      const cursorSubjectIds = subjectIds && recheckSkip.size
        ? subjectIds.filter((sid) => !recheckSkip.has(String(sid)))
        : subjectIds;
      const nextCursor = advanceCursor(
        stNow, chatKey, cursorSources, cursorSubjectIds, jobId,
        impressionsWrote > 0 || impressionsDuplicate > 0
      );
      const j = stNow.jobs[jobId];
      j.status = 'done';
      j.episodes = 0;
      j.rejected = rejected.length + droppedBySuppression;
      // ★ ④b 的读数落盘（stNow 是从盘上重读的，必须显式写回，status() 才看得见）。
      j.impressions = impressionsWrote;
      j.impressionDuplicates = impressionsDuplicate;
      j.impressionRejected = job.impressionRejected;
      j.personaHiddenSources = personaHiddenSources;
      j.finishedAt = nowOf(clock);
      saveState(stNow);
      return {
        ok: true, ran: true, jobId, status: 'done', episodes: 0,
        rejected: rejected.length, droppedBySuppression,
        rejectedReasons: [...new Set(rejected.map((r) => r.reason))],
        impressionRejectedReasons: [...new Set(impOut.rejected.map((r) => r.reason))],
        ...impressionStats,
        personaHiddenSources,
        narrowed: !!subjectIds,
        cursor: nextCursor, sourceCount: liveSources.length,
      };
    }

    // ⑤ ★ 提交成功才推进游标（方案 §4.3）。先写 episode，写成功后才更新 state。
    //   ★ 归属标（2026-10-13 裁定 A 批）：整理批次**跑起来时谁在位**，这条摘要就归谁 —— 摘要是在位
    //     人格读完全群消息后写下的第一人称结论，另一个人在位时不该拿它当"我记过的东西"。
    //     这里只**打标**（可见性判据仍只有 `observationVisibleToPersona` 那一份，读端用），
    //     不改文件形状：存量没标的新行照旧按第一人格处理，零迁移。
    // ★ 手工编辑锁·提交前复核（老树 src/orchestrator.js:5714 的"模型返回后再查一次"）：
    //   extract 期间用户可能手工改了印象 ⇒ 提交前再查锁，受锁 subject 的 episode 不写回。
    let finalKept = kept;
    if (isAuto && kept.length) {
      const speakerByMsg = new Map(liveSources.map((s) => [s.messageId, s.speakerId]));
      const recheckLocked = new Set();
      for (const ep of kept) {
        for (const ref of (ep.sourceRefs || [])) {
          const speaker = speakerByMsg.get(ref.messageId);
          if (speaker && filterLockedSubjects([speaker], dataDir, lockWin).has(speaker)) {
            recheckLocked.add(speaker);
          }
        }
      }
      if (recheckLocked.size) {
        finalKept = kept.filter((ep) => {
          const speakers = (ep.sourceRefs || []).map((ref) => speakerByMsg.get(ref.messageId)).filter(Boolean);
          return !speakers.some((sid) => recheckLocked.has(sid));
        });
        // ★ 与 ④b 的印象复核结果**并集**（同一个字段，别覆盖掉对方拦下的 subject）。
        job.recheckLockedSkipped = [...new Set([...(job.recheckLockedSkipped || []), ...recheckLocked])];
      }
    }
    if (!finalKept.length) {
      // 全被复核拦下：游标不推进（这批没落地），如实记账。
      const stNow = loadState();
      const j = stNow.jobs[jobId];
      j.status = 'done';
      j.episodes = 0;
      j.rejected = rejected.length + droppedBySuppression;
      j.reason = 'recheck-locked';
      // ★ ④b 的读数落盘（同 `!kept.length` 分支的理由）。
      j.impressions = impressionsWrote;
      j.impressionDuplicates = impressionsDuplicate;
      j.impressionRejected = job.impressionRejected;
      j.personaHiddenSources = personaHiddenSources;
      j.finishedAt = nowOf(clock);
      saveState(stNow);
      return {
        ok: true, ran: true, jobId, status: 'done', episodes: 0,
        rejected: rejected.length, droppedBySuppression,
        recheckLockedSkipped: job.recheckLockedSkipped || [],
        reason: 'recheck-locked',
        ...impressionStats,
        personaHiddenSources,
        narrowed: !!subjectIds,
        cursor: cursorOf(stNow, chatKey).sourceCursor, sourceCount: liveSources.length,
      };
    }
    let wrote;
    try {
      wrote = appendEpisodes(finalKept.map((ep) => ({ ...ep, persona2: batchPersonaTwo })));
    } catch (error) {
      return failJob(st, jobId, `append-failed:${String(error?.message ?? error).slice(0, 120)}`, liveSources.length);
    }
    // ★ 复核被拦下的 subject 不推进游标（"不能顺带推进其游标"）：
    //   从 liveSources 里剔掉他们的来源，advanceCursor 就不会动他们的桶。
    const recheckSkip = new Set(job.recheckLockedSkipped || []);
    const cursorSources = recheckSkip.size
      ? liveSources.filter((s) => !recheckSkip.has(String(s?.speakerId ?? '')))
      : liveSources;
    const cursorSubjectIds = subjectIds && recheckSkip.size
      ? subjectIds.filter((sid) => !recheckSkip.has(String(sid)))
      : subjectIds;
    advanceCursor(st, chatKey, cursorSources, cursorSubjectIds, jobId, true);
    job.status = 'done';
    job.episodes = wrote;
    job.rejected = rejected.length + droppedBySuppression;
    job.sourceCount = liveSources.length;
    job.skippedSuppressed = sources.length - liveSources.length;
    job.personaHiddenSources = personaHiddenSources;
    job.finishedAt = nowOf(clock);
    const finalCursor = cursorOf(st, chatKey).sourceCursor;
    saveState(st);

    return {
      ok: true, ran: true, jobId, status: 'done',
      episodes: wrote,
      rejected: job.rejected,
      rejectedReasons: [...new Set(rejected.map((r) => r.reason))],
      droppedBySuppression,
      skippedSuppressed: job.skippedSuppressed,
      ...impressionStats,
      narrowed: !!subjectIds,
      cursor: finalCursor,
      sourceCount: liveSources.length,
      attempt: job.attempts,
    };
  }

  /** 失败：按方案 §5.3「每批最多重试 2 次，连续失败后退避并显示状态」。 */
  function failJob(st, jobId, reason, sourceCount) {
    const job = st.jobs[jobId];
    job.reason = String(reason).slice(0, 200);
    job.finishedAt = nowOf(clock);
    job.sourceCount = num(job.sourceCount, sourceCount);
    if (job.attempts < MAX_ATTEMPTS) {
      job.status = 'queued';                       // 重试
      job.backoffUntil = nowOf(clock) + BACKOFF_BASE_MS * job.attempts;
    } else {
      job.status = 'failed';                       // 退避并显示状态；**不循环调模型修 JSON**
    }
    saveState(st);
    return {
      ok: true, ran: true, jobId, status: job.status,
      reason: job.reason, attempts: job.attempts, episodes: 0, rejected: 0,
      // 失败前若已写过印象（如 append 失败重试前），如实带出，不假装没发生。
      impressions: num(job.impressions, 0),
      cursor: cursorOf(st, job.chatKey).sourceCursor,
    };
  }
}
