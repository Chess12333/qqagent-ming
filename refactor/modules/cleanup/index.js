/**
 * `modules/cleanup` —— 会话软删 / 回收站 / 到期硬删 · T-SESSION-CLEANUP-PORT（sb2 · 2026-10-05）
 *
 * 搬运来源（旧树 `src/cleanup.js`，451 行）：
 *   · `SessionCleanup` 构造与依赖纪律   旧 :51-75（依赖全注入；旧 :21-23 顶层只有 node: 内建 import）
 *   · `listTrash()`                     旧 :94-100（manifest 条目 + `daysLeft`，只读）
 *   · `softDeleteBatch()` / `softDelete` 旧 :106-151（rename 进回收站 + manifest；原因码逐条照搬）
 *   · `restore()`                       旧 :157-181（搬回 + 摘 manifest + reingest 钩子）
 *   · `planCleanup(keepDays)`           旧 :188-218（**只读**预演 + perChat + oldestKept）
 *   · `applyCleanup(keepDays)`          旧 :221-227（= 批量软删，并带同一份 plan）
 *   · `purgeNow(id, opts)`              旧 :255-344（**提取失败 ⇒ 一个字节都不删**；force 先归档再删 + 双通道审计）
 *   · ID 严格式 / 布局常量             旧 :33-35（`ID_RE`、`_manifest.json`、`_sweep-state.json`）
 *
 * ★★ 本票对旧树的三处**收紧**（都是"更诚实"，不是"更聪明"，回执里逐条登记）：
 *   1. **`planCleanup` 严格只读**：旧实现经 `registry.listSummaries()` 触发"陈旧 running/waiting **回写文件**"
 *      （`src/sessions.js:118-136`）⇒ 旧 plan **不是只读的**。这里改用 `registry.snapshot()`（零写入快照）。
 *   2. **删前把路径列表写进结果**（可审计）：旧 `planCleanup` 只回 `ids`，`applyCleanup` 只回结果计数。
 *      现在 `planCleanup` 额外给 **`paths`（将要删的每个文件的绝对路径）**，`applyCleanup`/`purgeNow`
 *      的结果里也带 `paths` ⇒ 事后能对着清单对账。旧字段**一个没删**。
 *   3. **路径闸**：任何 unlink/rename 之前先校验目标**在 sessionsDir 之内**，
 *      越界即 `reason:'path-escape'` 并**拒绝**（旧树靠 `ID_RE` 挡，本模块两道都留）。
 *
 * ★ 不变量（票面硬要求，代码里逐条落成断言）：
 *   · 不可逆操作先给计划：`planCleanup` 只读 + 列路径；`applyCleanup`/`purgeNow` 才真删。
 *   · `applyCleanup` **只删计划里的**那些 id（多一个都不删）。
 *   · **只动 dataDir 之内**（回收站就在 `sessionsDir/.trash`）；dataDir 没给就**抛**，不猜目录。
 *   · 目录读不动 / 权限不足 ⇒ 结构化错误（`dirReadable:false` + `dirError`），**不当"空"**。
 *
 * ★ 2026-10-10 N48 对账补齐（三处按老树搬回，见回执 §B）：
 *   · **`sweepTrash()`**（旧 :351-425）—— 搬运版整块**没搬** ⇒ 回收站只进不出。
 *     老树 `src/app.js:3761-3764` 是"启动扫一次 + 每 6 小时扫一次"，新树一个调用点都没有。
 *     ★ 搬回来时**默认仍然一个字节都不会删**：`topicStore` 没注入（新树还没有 topics 模块）
 *       ⇒ P4 闸门按 fail-safe 走 ⇒ 只记账（`retries` / `keepForever`），不 unlink。
 *   · **`chatKeyOfFile()`**（旧 :429-434）—— 旧 `purgeNow`(:275) 与 `sweepTrash`(:381) 都靠它兜底
 *     取 chatKey；搬运版 `purgeNow` 写成 `entry?.chatKey ?? null` ⇒ 孤儿/无条目的一律提取失败。
 *   · **force 审计的第二通道**：旧树 `console.log` 是无条件的，搬运版改成注入 `log` 但**默认静默**，
 *     而装配（`apps/server/api/shell.js:1063`）没传 ⇒ 强制清理只剩 `_sweep-state.json` 一条留痕，
 *     那条写失败就**毫无痕迹**。现在缺省回落到 `process.stderr.write`。
 *
 * ★ 仍未搬：`createProductionCleanup()`（旧 :440-450）。**不是漏搬，是搬不了** —— 它动态 import
 *   `config.js` / `usage-ledger.js` / `topics.js`，新树后两者**整块不存在**（`refactor/modules/` 下没有
 *   topics 与 usage-ledger）⇒ 强行搬会 import 不存在的路径。装配现在是
 *   `apps/server/api/shell.js:1058-1063` 手工 `createCleanupService({ registry, dataDir })`。
 *   **后果**：没有 topicStore ⇒ `purgeNow` 默认路径按 P4 fail-safe —— `reason:'extract-failed'` +
 *   **`deleted:false`，一个字节都不删**（旧 :279-291 同款）；要真删必须走 `opts.force`（运维口：先归档 + 双通道审计）。
 *   回收站要真正"到期即清"，需要 ①topics 模块落地 ②装配在启动/定时调 `sweepTrash` —— 两条都不在本域，已上报。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/util/index.js';

const DAY_MS = 24 * 3600 * 1000;
/** 会话 id 严格式（旧 :33，天然挡路径穿越）。 */
export const ID_RE = /^[a-z0-9]+-[0-9a-f]{8}$/;
const MANIFEST = '_manifest.json';
const SWEEP_STATE = '_sweep-state.json';
const DEFAULT_RETENTION_MS = 7 * DAY_MS;
const DEFAULT_MAX_EXTRACT_RETRIES = 3;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** 路径闸：目标必须落在 sessionsDir 之内（票面硬要求；旧树只靠 ID_RE 挡一道）。 */
function insideSessionsDir(sessionsDir, target) {
  const rel = path.relative(path.resolve(sessionsDir), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 孤儿文件取 chatKey（读一次文件；读不出 → null）。只用于兜底路径。旧 :429-434。 */
function chatKeyOfFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof data?.chatKey === 'string' && data.chatKey ? data.chatKey : null;
  } catch { return null; }
}

/**
 * 建清理服务。
 * @param {{sessionsDir?:string, dataDir?:string, registry:object, ledger?:object,
 *          topicStore?:object|null, now?:() => number, retentionMs?:number,
 *          maxExtractRetries?:number, log?:Function}} deps
 *   `registry` **必填**（旧 :64 就是这么要求的）：没有它就**抛**，不许"没有登记表 ⇒ 假装没有垃圾"。
 */
export function createCleanupService(deps = {}) {
  const registry = deps.registry;
  if (!registry || typeof registry.listSummaries !== 'function') {
    const error = new Error('modules/cleanup: registry 必填（需要 listSummaries；没有它就不许清理 —— 不能"没有登记表 ⇒ 假装没有垃圾"）');
    error.reason = 'registry-missing';
    throw error;
  }
  const dataDir = String(deps.dataDir || '').trim();
  const sessionsDir = String(deps.sessionsDir || (dataDir ? path.join(dataDir, 'sessions') : '')).trim();
  if (!sessionsDir) {
    const error = new Error('modules/cleanup: sessionsDir/dataDir 必填（不猜目录）');
    error.reason = 'dataDir-unset';
    throw error;
  }
  const trashDir = deps.trashDir ? String(deps.trashDir) : path.join(sessionsDir, '.trash');
  if (!insideSessionsDir(sessionsDir, trashDir)) {
    const error = new Error(`modules/cleanup: 回收站必须在 sessionsDir 之内（sessionsDir=${sessionsDir} trashDir=${trashDir}）`);
    error.reason = 'path-escape';
    throw error;
  }
  const ledger = deps.ledger ?? null;
  const topicStore = deps.topicStore ?? null;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const retentionMs = Number.isFinite(Number(deps.retentionMs)) ? Number(deps.retentionMs) : DEFAULT_RETENTION_MS;
  const maxExtractRetries = Number.isFinite(Number(deps.maxExtractRetries)) ? Number(deps.maxExtractRetries) : DEFAULT_MAX_EXTRACT_RETRIES;
  // ★ N48：旧树的 force 审计是**双通道**（state 文件 + 无条件 console.log），第二条是兜底 ——
  //   状态写失败时"删了什么"仍必须留下痕迹。搬运版把 console 换成注入的 `log`，但缺省成了空函数，
  //   而装配（shell.js:1063）没传 ⇒ 兜底通道等于没有。缺省回落到 stderr（不改调用方传函数时的行为）。
  const log = typeof deps.log === 'function'
    ? deps.log
    : (message) => { try { process.stderr.write(`${message}\n`); } catch { /* 写不进也不许挡删除 */ } };
  const inflight = new Set();
  let sweeping = false;   // 清扫单飞（旧 :74 `this._sweeping`）

  /**
   * P2 的「还在跑吗」判据。
   * ★ N52 裁定②（指挥位 2026-10-10）：**判不出来就倒向"少删"** —— registry 没有 `isLive`/`current`、
   *   或探针自己抛了 ⇒ **当成还在跑**（跳过删除）。理由：清理类的失败必须倒向可恢复那一边 ——
   *   少删最坏是留一个垃圾文件，多删是**误删用户数据**（不可恢复）。
   *   ★ 走了这条保守分支**不许静默**：把原因写进 `sink`，由调用方汇总成**一条**日志（逐条打会刷屏）。
   * @param {string} id @param {{reason?:string}} [sink]
   */
  function isStillRunning(id, sink) {
    try {
      if (typeof registry.isLive === 'function') return registry.isLive(id) === true;
      if (registry.current && typeof registry.current.has === 'function') return registry.current.has(id) === true;
      if (sink) sink.reason = 'registry 没有 isLive / current';
    } catch (error) {
      if (sink) sink.reason = `liveness 探针抛：${String(error?.message ?? error)}`;
    }
    return true;
  }
  const reportLivenessFallback = (sink, op) => {
    if (!sink?.reason) return;
    try { log(`[cleanup] ${op} ⇒ liveness 判不出来 ⇒ 按"还在跑"跳过（**倒向少删**）：${sink.reason}`); } catch { /* 留痕失败不挡业务 */ }
  };

  const ensureTrash = () => fs.mkdirSync(trashDir, { recursive: true });
  const manifestPath = () => path.join(trashDir, MANIFEST);
  const statePath = () => path.join(trashDir, SWEEP_STATE);
  const loadManifest = () => {
    const m = readJson(manifestPath(), null);
    return (m && Array.isArray(m.entries)) ? m : { version: 1, entries: [] };
  };
  const saveManifest = (m) => { ensureTrash(); writeJsonAtomic(manifestPath(), m, { indent: 1 }); };
  const loadState = () => {
    const s = readJson(statePath(), null);
    return (s && typeof s === 'object')
      ? { version: 1, retries: {}, keepForever: {}, orphanFirstSeen: {}, forceAudit: [], ...s }
      : { version: 1, retries: {}, keepForever: {}, orphanFirstSeen: {}, forceAudit: [] };
  };
  const saveState = (s) => { ensureTrash(); writeJsonAtomic(statePath(), s, { indent: 1 }); };

  /** 目录可读性（票面：读不动 ⇒ 结构化错误，不当"空"）。 */
  function dirStatus() {
    try {
      fs.readdirSync(sessionsDir);
      return { dirReadable: true, dirError: '' };
    } catch (error) {
      if (error?.code === 'ENOENT') return { dirReadable: null, dirError: '', missing: true };
      return { dirReadable: false, dirError: String(error?.message ?? error) };
    }
  }

  const service = {
    sessionsDir,
    trashDir,
    /** 诊断：目录可读性（探针与端点的"看得见"用）。 */
    dirStatus,

    /** 回收站视图（旧 :94-100，只读）。 */
    listTrash() {
      const stamp = now();
      return loadManifest().entries.map((e) => ({
        ...e,
        daysLeft: Math.max(0, Math.ceil((e.purgeAfter - stamp) / DAY_MS))
      }));
    },

    /**
     * 一键清理**预演**（旧 :188-218；★ 本票收紧：走只读快照 + 额外列 `paths`）。
     * @param {number} keepDays 只收 7 / 30（端点侧已校验，这里再兜一层，不合就抛）
     * @returns {{ok:true, keepDays, cutoff, willDelete, perChat, oldestKept, ids, paths, readOnly:true}}
     */
    planCleanup(keepDays) {
      if (![7, 30].includes(Number(keepDays))) {
        const error = new Error(`modules/cleanup: keepDays 只收 7 / 30（收到 ${JSON.stringify(keepDays)}）`);
        error.reason = 'bad-keepDays';
        throw error;
      }
      const stamp = now();
      const cutoff = stamp - Number(keepDays) * DAY_MS;
      // ★ 只读快照：旧实现用 listSummaries() 会顺带**回写**陈旧会话文件（旧 sessions.js:118-136），
      //   那样"预演"就不是只读了。这里显式用 snapshot()（零写入）。
      const all = typeof registry.snapshot === 'function' ? registry.snapshot() : registry.listSummaries(Infinity);
      const liveness = { reason: '' };
      const lastActive = (e) => {
        const t = e.endedAt ?? e.startedAt;
        return Number.isFinite(t) ? t : null;
      };
      const items = all.filter((e) => {
        if (isStillRunning(e.id, liveness)) return false;
        if (e.status === 'running' || e.status === 'waiting') return false;   // P2：永远跳过
        const t = lastActive(e);
        return t !== null && t < cutoff;                                        // 严格小于（旧 :202）
      });
      reportLivenessFallback(liveness, 'planCleanup');
      const perChat = {};
      for (const e of items) {
        const key = e.chatKey ?? '(unknown)';
        perChat[key] = (perChat[key] ?? 0) + 1;
      }
      const deleting = new Set(items.map((e) => e.id));
      let oldestKept = null;
      for (const e of all) {
        if (deleting.has(e.id)) continue;
        const t = lastActive(e);
        if (t === null) continue;
        if (oldestKept === null || t < oldestKept) oldestKept = t;
      }
      return {
        ok: true,
        keepDays: Number(keepDays),
        cutoff,
        willDelete: items.length,
        perChat,
        oldestKept,
        ids: items.map((e) => e.id),
        // ★ 本票新增：将要删除的**具体路径**（可审计；旧树只给 ids）
        paths: items.map((e) => path.join(sessionsDir, `${e.id}.json`)),
        readOnly: true
      };
    },

    /**
     * 一键清理执行（旧 :221-227）：**先算计划、再按计划删**，结果里带 `paths`。
     * @returns {{ok, moved, results, plan, paths}}
     */
    applyCleanup(keepDays) {
      const plan = service.planCleanup(keepDays);
      const r = service.softDeleteBatch(plan.ids);
      // 只把"计划里、且确实删掉了"的路径写进结果（其余那些一条都没动）
      const deletedIds = new Set(r.results.filter((x) => x.ok).map((x) => x.id));
      return {
        ...r,
        plan: {
          keepDays: plan.keepDays, cutoff: plan.cutoff, willDelete: plan.willDelete,
          perChat: plan.perChat, oldestKept: plan.oldestKept
        },
        // ★ 两个路径字段**分工明确**（我第一版两个都叫 `paths`，自测 3.3 直接把我的期望打红，
        //   逼我把语义分开 —— 歧义字段就是 bug）：
        //   `paths`     = 计划里**将被删的源文件**绝对路径（审计"本来该删谁"）
        //   `movedPaths` = 实际**搬进回收站**的目标路径（审计"实际动了谁"，来自 softDeleteBatch）
        paths: plan.paths.filter((p) => deletedIds.has(path.basename(p, '.json'))),
        movedPaths: r.paths
      };
    },

    /**
     * 软删一批（旧 :106-151）：rename 进回收站 + 写 manifest。**只删 `ids` 里的**。
     * @returns {{ok:boolean, moved:number, results:Array<{id,ok,reason?}>, paths?:string[]}}
     */
    softDeleteBatch(ids) {
      const results = [];
      const manifest = loadManifest();
      const summaries = registry.listSummaries(Infinity);
      const byId = new Map(summaries.map((e) => [e.id, e]));
      const liveness = { reason: '' };
      let dirty = false;
      for (const rawId of ids ?? []) {
        const id = String(rawId ?? '').trim();
        if (!ID_RE.test(id)) { results.push({ id, ok: false, reason: 'bad-id' }); continue; }
        if (inflight.has(id)) { results.push({ id, ok: false, reason: 'inflight' }); continue; }
        inflight.add(id);
        try {
          const summary = byId.get(id);
          if (!summary) { results.push({ id, ok: false, reason: 'not-found' }); continue; }
          if (isStillRunning(id, liveness) || summary.status === 'running' || summary.status === 'waiting') {
            results.push({ id, ok: false, reason: 'running' }); continue;      // P2：永远跳过
          }
          const src = path.join(sessionsDir, `${id}.json`);
          const dst = path.join(trashDir, `${id}.json`);
          // ★ 路径闸（旧树只靠 ID_RE 挡一道；这里两道都查）
          if (!insideSessionsDir(sessionsDir, src) || !insideSessionsDir(sessionsDir, dst)) {
            results.push({ id, ok: false, reason: 'path-escape' }); continue;
          }
          ensureTrash();
          if (fs.existsSync(dst)) { results.push({ id, ok: false, reason: 'trash-collision' }); continue; }
          if (!fs.existsSync(src)) { results.push({ id, ok: false, reason: 'file-missing' }); continue; }
          fs.renameSync(src, dst);   // 同卷原子
          const deletedAt = now();
          manifest.entries.push({
            id,
            chatKey: summary.chatKey ?? null,
            startedAt: summary.startedAt ?? null,
            endedAt: summary.endedAt ?? null,
            status: summary.status ?? null,
            deletedAt,
            purgeAfter: deletedAt + retentionMs
          });
          dirty = true;
          results.push({ id, ok: true, movedTo: dst });   // ★ 附加：搬去了哪（审计）
        } catch (error) {
          results.push({ id, ok: false, reason: `error:${error?.message ?? error}` });
        } finally {
          inflight.delete(id);
        }
      }
      if (dirty) saveManifest(manifest);
      return {
        ok: results.every((r) => r.ok),
        moved: results.filter((r) => r.ok).length,
        results,
        paths: results.filter((r) => r.ok).map((r) => r.movedTo)     // ★ 审计：实际动了哪些路径
      };
    },

    softDelete(id) { return service.softDeleteBatch([id]); },

    /** 撤销软删（旧 :157-181）：搬回 + 摘 manifest + reingest 钩子。绝不覆盖现网文件。 */
    restore(id) {
      const clean = String(id ?? '').trim();
      if (!ID_RE.test(clean)) return { ok: false, reason: 'bad-id' };
      if (inflight.has(clean)) return { ok: false, reason: 'inflight' };
      inflight.add(clean);
      try {
        const manifest = loadManifest();
        const idx = manifest.entries.findIndex((e) => e.id === clean);
        const src = path.join(trashDir, `${clean}.json`);
        const dst = path.join(sessionsDir, `${clean}.json`);
        if (!insideSessionsDir(sessionsDir, dst) || !insideSessionsDir(sessionsDir, src)) {
          return { ok: false, reason: 'path-escape' };
        }
        if (idx < 0 && !fs.existsSync(src)) return { ok: false, reason: 'not-in-trash' };
        if (fs.existsSync(dst)) return { ok: false, reason: 'target-exists' };   // 绝不覆盖
        fs.renameSync(src, dst);
        if (idx >= 0) { manifest.entries.splice(idx, 1); saveManifest(manifest); }
        if (typeof registry.reingest === 'function') {
          const ok = registry.reingest(clean);
          return { ok: true, reingested: ok === true, needsRestart: ok !== true, paths: [dst] };
        }
        return { ok: true, reingested: false, needsRestart: true, paths: [dst] };
      } catch (error) {
        return { ok: false, reason: `error:${error?.message ?? error}` };
      } finally {
        inflight.delete(clean);
      }
    },

    /**
     * 立即彻底删除（旧 :255-344）。**不可逆**。
     * 不带 `force` 时按 P4 fail-safe：**提取失败 ⇒ 一个字节都不删**（`deleted:false` + 原因）。
     * 带 `force`（运维口，**禁止接 UI 按钮**）：先归档到 `backups/<id>.json` + 双通道审计，再 unlink。
     * @returns {{ok, deleted, extracted, paths?:string[], reason?:string, audit?:object}}
     */
    async purgeNow(id, opts = {}) {
      const clean = String(id ?? '').trim();
      if (!ID_RE.test(clean)) return { ok: false, deleted: false, reason: 'bad-id' };
      if (inflight.has(clean)) return { ok: false, deleted: false, reason: 'inflight' };
      inflight.add(clean);
      try {
        const file = path.join(trashDir, `${clean}.json`);
        // ★ 路径闸：unlink 之前必须确认目标在 sessionsDir 之内
        if (!insideSessionsDir(sessionsDir, file)) {
          return { ok: false, deleted: false, reason: 'path-escape', paths: [] };
        }
        if (!fs.existsSync(file)) return { ok: false, deleted: false, reason: 'not-in-trash', paths: [] };
        const force = opts?.force === true;
        const state = loadState();
        if (!force && state.keepForever[clean]) {
          return {
            ok: false, deleted: false, reason: 'kept-forever',
            extractRetries: Number(state.retries[clean]) || 0, keptForever: true, paths: []
          };
        }
        const manifest = loadManifest();
        const entry = manifest.entries.find((e) => e.id === clean) ?? null;
        let extracted = false;
        let extractError = null;
        if (topicStore && typeof topicStore.extractFromSessions === 'function') {
          try {
            // ★ N48 补回旧 :275 的兜底：manifest 没条目、或条目没 chatKey 时读一次文件拿（旧 chatKeyOfFile）。
            //   搬运版写成 `?? null` ⇒ 这两类文件提取必然失败 ⇒ 永远卡在回收站里出不去。
            const r = await topicStore.extractFromSessions([file], { chatKey: entry?.chatKey ?? chatKeyOfFile(file) });
            extracted = r?.ok === true;
            if (!extracted) extractError = r?.error ?? 'unknown';
          } catch (error) { extractError = String(error?.message ?? error); }
        } else {
          extractError = 'no-topic-store';     // 旧 :279-283 同款：缺 topicStore = 提取不可用 = fail-safe
        }
        if (!extracted && !force) {
          const tries = (Number(state.retries[clean]) || 0) + 1;
          state.retries[clean] = tries;
          const keptForever = tries >= maxExtractRetries;
          if (keptForever) state.keepForever[clean] = true;
          saveState(state);
          // ★ 关键：这里**没有** unlink。一个字节都没删，结果里 deleted:false + 原因。
          return {
            ok: false, deleted: false, reason: 'extract-failed', extractError,
            extractRetries: tries, keptForever, paths: []
          };
        }
        let audit = null;
        if (force) {
          const bytes = fs.statSync(file).size;
          const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16).toUpperCase();
          const backupDir = path.join(trashDir, 'backups');
          fs.mkdirSync(backupDir, { recursive: true });
          fs.copyFileSync(file, path.join(backupDir, `${clean}.json`));   // 归档失败 ⇒ 抛 ⇒ 一个字节都不删
          audit = {
            id: clean, forced: true,
            actor: (typeof opts?.actor === 'string' && opts.actor.trim()) ? opts.actor.trim().slice(0, 64) : 'ops-api',
            reason: (typeof opts?.reason === 'string' && opts.reason.trim()) ? opts.reason.trim().slice(0, 200) : null,
            at: now(), bytes, sha256_16: sha, extracted, extractError,
            archive: `backups/${clean}.json`,
            purgedPath: file          // ★ 审计：删的是哪个绝对路径
          };
          const intent = { ...audit, phase: 'intent' };
          if (state.retries[clean]) delete state.retries[clean];
          if (state.keepForever[clean]) delete state.keepForever[clean];
          state.forceAudit = [...(Array.isArray(state.forceAudit) ? state.forceAudit : []), intent].slice(-50);
          try { saveState(state); } catch { /* 状态写失败不挡删除 */ }
          try { log(`[cleanup] FORCE_PURGE ${JSON.stringify(intent)}`); } catch { /* 同上 */ }
        }
        const dryRun = opts?.dryRun === true;
        if (dryRun) {
          return { ok: true, deleted: false, dryRun: true, extracted, wouldDelete: [file], id: clean };
        }
        fs.unlinkSync(file);
        if (force) {
          const result = { id: clean, forced: true, phase: 'result', at: audit.at, deleted: true, extracted };
          state.forceAudit = [...(Array.isArray(state.forceAudit) ? state.forceAudit : []), result].slice(-50);
          try { saveState(state); } catch { /* 同上 */ }
          try { log(`[cleanup] FORCE_PURGE_RESULT ${JSON.stringify(result)}`); } catch { /* 同上 */ }
        }
        if (entry) {
          manifest.entries = manifest.entries.filter((e) => e.id !== clean);
          saveManifest(manifest);
        }
        if (!force && state.retries[clean]) { delete state.retries[clean]; saveState(state); }
        try { ledger?.remove?.(clean); } catch { /* 记账联动失败不挡删除 */ }
        if (force) return { ok: true, deleted: true, extracted, forced: true, archive: audit.archive, audit, paths: [file] };
        return { ok: true, deleted: true, extracted: true, paths: [file] };
      } catch (error) {
        return { ok: false, deleted: false, reason: `error:${error?.message ?? error}`, paths: [] };
      } finally {
        inflight.delete(clean);
      }
    },

    /**
     * 清扫回收站（旧 :351-425；★ 2026-10-10 N48 搬回 —— 搬运版整块没搬，回收站因此只进不出）。
     * 到期的先提话题、**成功才硬删**（P4）。真相源 = 目录列举，manifest 只是元数据
     * ⇒ 崩溃留下的孤儿文件也能兜底（按"首次发现时间 + 保留期"补 purgeAfter，不丢、不提前删）。
     * ★ 没有 topicStore ⇒ 每个到期条目都按提取失败记账（retries++，连挂到上限转 keepForever），
     *   **一个字节都不删** —— 与 purgeNow 同一条 fail-safe 闸门。
     */
    async sweepTrash(opts = {}) {
      if (sweeping) return { ok: false, reason: 'already-sweeping' };
      sweeping = true;
      try {
        ensureTrash();
        const stamp = now();
        const manifest = loadManifest();
        const state = loadState();
        let names = [];
        try { names = fs.readdirSync(trashDir); } catch { names = []; }
        const files = names.filter((n) => n.endsWith('.json') && !n.startsWith('_'));
        const fileIds = new Set(files.map((n) => n.slice(0, -'.json'.length)));

        // 对账：manifest 有、文件没 ⇒ 摘条目；文件有、manifest 没 ⇒ 孤儿补 purgeAfter（旧 :364-373）
        const before = manifest.entries.length;
        manifest.entries = manifest.entries.filter((e) => fileIds.has(e.id));
        const manifestIds = new Set(manifest.entries.map((e) => e.id));
        const workList = [...manifest.entries];
        for (const id of fileIds) {
          if (manifestIds.has(id)) continue;
          if (!state.orphanFirstSeen[id]) state.orphanFirstSeen[id] = stamp;
          workList.push({ id, chatKey: null, orphan: true, purgeAfter: state.orphanFirstSeen[id] + retentionMs });
        }

        // ★ 这里是 `<=`（到期即扫），与 planCleanup 的严格 `<`（旧 :202）不同口径 —— 照搬旧树，别"统一"掉
        const expired = workList.filter((e) => !state.keepForever[e.id] && e.purgeAfter <= stamp);
        const groups = new Map();   // chatKey -> [{entry, file}]
        for (const entry of expired) {
          const file = path.join(trashDir, `${entry.id}.json`);
          let chatKey = entry.chatKey;
          if (!chatKey) chatKey = chatKeyOfFile(file);   // 孤儿没有 chatKey ⇒ 读一次文件拿
          if (!chatKey) {
            state.retries[entry.id] = (state.retries[entry.id] ?? 0) + 1;
            if (state.retries[entry.id] >= maxExtractRetries) state.keepForever[entry.id] = true;
            continue;
          }
          if (!groups.has(chatKey)) groups.set(chatKey, []);
          groups.get(chatKey).push({ entry, file });
        }

        const stats = {
          ok: true, scanned: files.length, expired: expired.length, swept: 0, kept: 0, failed: 0,
          keepForever: Object.keys(state.keepForever).length,
          manifestPruned: before - manifest.entries.length, extractedGroups: 0
        };
        for (const [chatKey, items] of groups) {
          let extractOk = false;
          if (topicStore && typeof topicStore.extractFromSessions === 'function') {
            try {
              extractOk = (await topicStore.extractFromSessions(items.map((x) => x.file), { chatKey }))?.ok === true;
            } catch { extractOk = false; }
          }
          // P4 闸门：提取成功才删；topicStore 缺失按提取失败处理（fail-safe ⇒ 永不硬删）
          if (!extractOk) {
            for (const { entry } of items) {
              state.retries[entry.id] = (state.retries[entry.id] ?? 0) + 1;
              if (state.retries[entry.id] >= maxExtractRetries) { state.keepForever[entry.id] = true; stats.keepForever += 1; }
              stats.failed += 1;
            }
            continue;
          }
          stats.extractedGroups += 1;
          for (const { entry, file } of items) {
            // 路径闸（本模块收紧 #3；旧树靠文件来自 readdirSync(trashDir) 天然成立 ⇒ 行为不变）
            if (!insideSessionsDir(sessionsDir, file)) { stats.kept += 1; continue; }
            if (opts?.dryRun) { stats.swept += 1; stats.dryRunFiles = [...(stats.dryRunFiles || []), file]; continue; }
            try {
              fs.unlinkSync(file);
              manifest.entries = manifest.entries.filter((e) => e.id !== entry.id);
              try { ledger?.remove?.(entry.id); } catch { /* 记账联动失败不挡删除 */ }
              stats.swept += 1;
            } catch { stats.kept += 1; }
          }
        }
        saveManifest(manifest);
        saveState(state);
        return stats;
      } finally {
        sweeping = false;
      }
    }
  };
  return service;
}

export { DAY_MS, MANIFEST, SWEEP_STATE };
