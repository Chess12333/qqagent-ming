/**
 * 记忆自动整理的**调度 + 本地维护**（apps/server 域；2026-10-15 · ds3）
 *
 * ── 这张票解决什么 ────────────────────────────────────────────────────────────
 * 用户口径：主设置页的「启用记忆自动整理」与间隔等键**必须真的影响 runtime**。改前实测：
 *   · 新树的自动整理触发源早就存在 —— `modules/orchestrator/index.js:674-730` 的观察计数泵
 *     （`observe()` 每轮到 `pendingConsolidation` 记数，够阈值/够静默就 `requestConsolidation`），
 *     但它**不读任何设置**：不看 `consolidateEnabled`、不看 `consolidateMinIntervalMs`、不看模型配置
 *     ⇒ 默认关（`defaults.js:1090 consolidateEnabled:false`）也照排，键在 `key-ledger.mjs:723` 记为 dead。
 *   · 调度权已收口：全树**只有一个心跳**（`apps/server/index.js` 的 5s `setInterval` → `runtime.onTick`），
 *     模块不许自起 setTimeout（见 index.js:502-506 的注释）。
 *
 * ── 本模块的形状（为什么不改别人的域）─────────────────────────────────────────
 * 唯一收口 = 装配层造的**那一个** coordinator 实例（`assembly.js` N33 段）：
 * 自动泵与 HTTP 手动端点共用它。所以本模块只做两件事：
 *   ① `attach(coordinator)`：包住 `requestConsolidation`。
 *      · **自动**请求（`orchestrator-observed-*` / 本模块自己的 `auto-maintenance`）→ 不进队列，
 *        改记进本模块的 `deferred`（待办），并由 `tick()` 按策略补发（补发时 reason **精确用
 *        `auto-maintenance`**）。给泵的回执是 `{ok:true,queued:true,deferred:true,jobId:null}` ——
 *        语义是"**请求已被调度器接管**"，不是"已经排进 coordinator 队列"：泵拿到它就会清掉自己的
 *        pending（`index.js:701`），从而**不会每 5s 重试刷日志**，也不会有假的 jobId。
 *      · **手动**请求（`consolidate-all` 等）与其它 reason → **原样透传**，一个字不改（手动路径不动）。
 *   ② `tick(nowMs)`：由**同一个心跳**驱动（apps/server/index.js 那个 setInterval，紧随 `runtime.onTick`）。
 *      内部自带节流，不需要第二个 timer：本地维护到点才跑，补发扫描 ≥60s 一次、每轮最多补 8 个会话。
 *
 * ── 成本与判据（opt-in 是硬闸）───────────────────────────────────────────────
 * 自动整理**会调模型花钱** ⇒ 只有 `memory.consolidateEnabled === true`（显式 true）才补发；
 * 缺省/缺键/任何非 true 值一律不排（与旧树 `src/orchestrator.js:5444` 的 `!== true` 判据同口径）。
 * 另外两道门：当前选用的聊天模型或记忆专用模型未配齐时不排；账户未绑定（拿不到 coordinator）不排。
 * 限频：`memory.consolidateMinIntervalMs`（缺省 7 天，**地板 1 小时**），按会话判定；
 * "上次整理时间"取**可核实的落盘事实** —— `coordinator.status()` 里该会话 jobs 的最新 `createdAt`
 * （coordinator 的队列状态是持久化的，进程重启后仍然算数），外加本进程自己的补发时刻。
 * 不重复入队：该会话已有 queued/running job 时直接清掉待办，不再排。
 *
 * ── 与回复进程的关系 ────────────────────────────────────────────────────────
 * 本模块**只排队、不执行**：真正跑 job 的是既有的 orchestrator 整理泵（`runNextJob`），
 * 而它自己带 `busy` 门（`index.js:675`）⇒ 不会与回复抢线程。本模块一次模型调用都不发起。
 *
 * ── 如实登记的差距（不许用改名假装对齐）──────────────────────────────────────
 * · ★ 2026-10-15 回修：旧树的触发量是**人物印象条数**（`memory.consolidationState(chatKey).counts.memberImpression` /
 *   `members[].count`），据此用 `consolidateMinImpressions` / `maxImpressionsPerMember` 两个键判定。
 *   现已接线：`modules/memory activeImpressionCountsBySubject()` 提供真实只读印象计数，
 *   `flushDeferred` 补上双阈值门（总印象数 > consolidateMinImpressions **或** 任一成员 > maxImpressionsPerMember）。
 *   **不以消息观察数冒充印象数**（`observed` 字段仍是消息观察计数，与印象计数分开）。
 * · `memory.maintenanceIntervalMs`：只接了**本地无模型维护**这一半（`pruneSurface`，旧树
 *   `src/app.js:3855-3860` 的 `onPruneSurface` 同款）；旧树那条"增量索引"在新树已经由 coordinator
 *   自带的语义重建定时器负责（`coordinator.js:105-127`，32 条变更 / 静默 60s），本模块**不重复驱动**。
 */

import { resolveMemoryExtractModel } from './memory-extract.js';

export const AUTO_REASON = 'auto-maintenance';

/** 自动请求的判据：本模块补发的，或 orchestrator 观察计数泵发来的（唯一两种）。 */
export function isAutoReason(reason) {
  const r = String(reason ?? '');
  return r === AUTO_REASON || r.startsWith('orchestrator-observed-');
}

const DEFAULT_MIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;   // 对齐 defaults.js:1092
const MIN_INTERVAL_FLOOR_MS = 60 * 60 * 1000;              // 地板 1 小时（旧树 :5467 同口径）
const DEFAULT_MAINTENANCE_MS = 3600000;                    // 对齐 defaults.js:1104
const SCAN_MIN_MS = 60_000;                                // 补发扫描节流：不许每 5s tick 扫
const MAX_ENQUEUE_PER_TICK = 8;                            // 一轮最多补发几个会话（避免一次性连环调模型）
const DEFER_MAX_CHATS = 200;                               // 待办上限（只按会话记，不存正文）
const DEFER_TTL_MS = 30 * 24 * 60 * 60 * 1000;             // 30 天没人动就丢（不猜，直接忘）
// ③ 排水节流（2026-10-28）：15 秒最多起一次整理；同一次只跑一个 job（coordinator 自己也有 running 锁）。
const DRAIN_MIN_MS = 15_000;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 从 `orchestrator-observed-N-messages` 里取 N（**只取数**，不解析正文；取不到就是 0）。 */
export function observedFromReason(reason) {
  const m = /^orchestrator-observed-(\d+)-messages$/.exec(String(reason ?? ''));
  return m ? Math.max(0, Number(m[1]) || 0) : 0;
}

/**
 * @param {object} deps
 * @param {object} deps.configStore  config-store（读 `memory.*` / `api.*`；每 tick 重新读 ⇒ 改值最迟下个周期生效）
 * @param {object} [deps.memory]     `modules/memory` 门面（只用 `pruneSurface`，只读调用，不改它）
 * @param {Function} [deps.getCoordinator] 取**那一个** coordinator（未绑定/未装配返回 null）
 * @param {Function} [deps.log]
 * @param {Function} [deps.now]
 */
export function createMemoryMaintenance({ configStore, memory = null, getCoordinator = null, log = null, now = () => Date.now() } = {}) {
  /** chatKey → { kind, observed, firstAt, lastAt }（**只有计数与 id，没有聊天正文**）。 */
  const deferred = new Map();
  const lastRequestAt = new Map();
  /** coordinator → 未被本模块包装的原始 requestConsolidation（补发时走它，避免自打自）。 */
  const rawRequests = new WeakMap();
  const warned = new Set();
  let lastMaintenanceAt = 0;
  let lastScanAt = 0;
  let lastDrainAt = 0;
  let draining = false;
  let maintenanceFallbackLogged = false;

  const read = (key, fallback) => (typeof configStore?.get === 'function' ? configStore.get(key, fallback) : fallback);

  /** ★ opt-in 硬闸：必须**显式 true**，缺省/缺键/字符串 'true' 一律算关。 */
  const consolidateEnabled = () => read('memory.consolidateEnabled', false) === true;

  const modelConfigured = () => resolveMemoryExtractModel(configStore).configured;

  /** 印象双阈值（老树 `src/orchestrator.js:5449-5465`）：总印象 > min 或 任一成员 > max 才触发。 */
  const DEFAULT_MIN_IMPRESSIONS = 4;    // 老树 MEMORY_THRESHOLDS.memberImpression
  function resolveImpressionThresholds() {
    const minImpressions = Math.max(1,
      num(read('memory.consolidateMinImpressions', null)) || DEFAULT_MIN_IMPRESSIONS);
    const maxPerMember = Math.max(4,
      num(read('memory.maxImpressionsPerMember', null)) || 12);
    return { minImpressions, maxPerMember };
  }

  /** 整理最小间隔：配置优先（动态读），非法/缺省 → 7 天；地板 1 小时。 */
  function resolveMinIntervalMs() {
    const n = num(read('memory.consolidateMinIntervalMs', null));
    return Math.max(MIN_INTERVAL_FLOOR_MS, n && n > 0 ? n : DEFAULT_MIN_INTERVAL_MS);
  }

  /** 本地维护间隔：配置优先（动态读），非法/<=0 → 1 小时并**只**打一次日志（旧树 app.js:3882-3888 同口径）。 */
  function resolveMaintenanceMs() {
    const raw = read('memory.maintenanceIntervalMs', null);
    const n = num(raw);
    if (n && n > 0) return n;
    if (!maintenanceFallbackLogged) {
      maintenanceFallbackLogged = true;
      log?.(`[apps/server] 本地维护间隔配置无效（memory.maintenanceIntervalMs=${JSON.stringify(raw ?? null)}）→ 回退 ${DEFAULT_MAINTENANCE_MS}ms`);
    }
    return DEFAULT_MAINTENANCE_MS;
  }

  function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    log?.(`[apps/server] ${message}`);
  }

  /** 记一条待办（同会话合并：观察数取大、firstAt 保序、lastAt 刷新）。 */
  function deferRequest(opts = {}, reason = '') {
    const chatKey = String(opts.chatKey ?? '').trim();
    if (!chatKey) return false;
    const prev = deferred.get(chatKey);
    const at = now();
    deferred.set(chatKey, {
      kind: prev?.kind ?? (opts.kind === 'private' ? 'private' : 'group'),
      observed: Math.max(prev?.observed ?? 0, observedFromReason(reason)),
      firstAt: prev?.firstAt ?? at,
      lastAt: at
    });
    if (deferred.size > DEFER_MAX_CHATS) {
      // 只按"最久没动"丢最老的，丢的是**待办**不是数据（下次观察到还会再来）。
      const oldest = [...deferred.entries()].sort((a, b) => (a[1].lastAt || 0) - (b[1].lastAt || 0))[0];
      if (oldest) deferred.delete(oldest[0]);
    }
    return true;
  }

  /**
   * 包住 coordinator 的排队入口（装配层在造出实例后立刻调；只包 `requestConsolidation`）。
   * @returns {boolean} 是否挂上（没有可包的实例返回 false，调用方据此如实记日志）
   */
  function attach(coordinator) {
    if (!coordinator || typeof coordinator.requestConsolidation !== 'function') return false;
    if (rawRequests.has(coordinator)) return true;
    const raw = coordinator.requestConsolidation.bind(coordinator);
    rawRequests.set(coordinator, raw);
    coordinator.requestConsolidation = async (opts = {}) => {
      const reason = String(opts?.reason ?? '');
      if (!isAutoReason(reason)) return raw(opts);          // 手动/其它路径：原样透传
      if (!deferRequest(opts, reason)) return raw(opts);    // 连 chatKey 都没有 ⇒ 不接管，交回原实现
      // ★ 回执口径（见文件头）：queued:true = "调度器已接管，别再重试"。**没有** jobId，
      //   `deferred:true` 让排障一眼看出这不是 coordinator 真排的队。
      return { ok: true, queued: true, merged: false, jobId: null, deferred: true, reason: 'auto-deferred' };
    };
    return true;
  }

  /** ① 本地维护（不调模型）：到点跑一次 `pruneSurface`。每 tick 动态读配置 ⇒ 改值下个周期生效。 */
  function runLocalMaintenance(tickAt) {
    if (!memory || typeof memory.pruneSurface !== 'function') return;
    const interval = resolveMaintenanceMs();
    if (lastMaintenanceAt && tickAt - lastMaintenanceAt < interval) return;
    lastMaintenanceAt = tickAt;
    try {
      const result = memory.pruneSurface();
      // 只报**数字**（被清掉几条），不把清理内容/人名写进日志。
      const nums = result && typeof result === 'object'
        ? Object.fromEntries(Object.entries(result).filter(([, v]) => typeof v === 'number'))
        : null;
      log?.(`[apps/server] 本地记忆维护完成（pruneSurface，间隔 ${interval}ms）${nums ? ` ${JSON.stringify(nums)}` : ''}`);
    } catch (error) {
      log?.(`[apps/server] ⚠ 本地记忆维护失败（不影响聊天）：${error?.message ?? error}`);
    }
  }

  /** ② 补发被接管的自动整理请求（三道门：opt-in / 模型 / 账户绑定；再限频 + 去重）。 */
  async function flushDeferred(tickAt) {
    if (!deferred.size) return;
    if (!consolidateEnabled()) return;                 // 默认关；非 true 一律不排
    if (!modelConfigured()) return;                    // 没选模型不排（旧树 :5446 同口径）
    if (tickAt - lastScanAt < SCAN_MIN_MS) return;     // 补发扫描节流：不是每个 5s tick 都扫
    const coordinator = typeof getCoordinator === 'function' ? getCoordinator() : null;
    if (!coordinator) return;                          // 账户未绑定/未装配 ⇒ 不排队
    const raw = rawRequests.get(coordinator);
    if (typeof raw !== 'function') return;
    lastScanAt = tickAt;

    let jobs = null;
    try {
      const status = await coordinator.status();
      jobs = Array.isArray(status?.jobs) ? status.jobs : null;
    } catch { jobs = null; }                           // 状态读不到 ⇒ 这轮不排（宁可晚，不乱排）
    if (!jobs) return;

    const minInterval = resolveMinIntervalMs();
    let budget = MAX_ENQUEUE_PER_TICK;
    const due = [...deferred.entries()]
      .filter(([, item]) => tickAt - (item.lastAt || 0) <= DEFER_TTL_MS)
      .sort((a, b) => (a[1].firstAt || 0) - (b[1].firstAt || 0));

    for (const [chatKey] of due) {
      if (budget <= 0) break;
      if (!consolidateEnabled()) break;                // 一轮里配置被改回关 ⇒ 立刻停手
      const item = deferred.get(chatKey);
      if (!item) continue;
      const mine = jobs ? jobs.filter((j) => String(j?.chatKey ?? '') === chatKey) : [];
      // 已有在排/在跑的 job ⇒ 不重复入队（同会话的排队请求 coordinator 自己会合并，这里连试都不试）。
      if (mine.some((j) => j?.status === 'queued' || j?.status === 'running')) {
        deferred.delete(chatKey);
        continue;
      }
      const lastAt = Math.max(
        lastRequestAt.get(chatKey) ?? 0,
        ...mine.map((j) => num(j?.createdAt) ?? 0)
      );
      if (lastAt && tickAt - lastAt < minInterval) continue;   // 限频：按会话（默认 7 天，地板 1h）
      // ★ 印象双阈值门（老树 `:5453-5465`）+ 鸡生蛋死锁修复（第五批 N4，2026-10-19）：
      //   自动整理是**写印象的唯一路径**，若只认"先有 >4 条印象"，0 印象的新库永远不排
      //   （用户实测：105 条消息 → 0 条写入）。修法：**有新的未整理素材即算够触发**
      //   （`item.observed > 0`，泵只在够阈值时记；N 来自 orchestrator-observed-N-messages）；
      //   印象双阈值保留为补充触发（`consolidateMinImpressions` / `maxImpressionsPerMember` 语义不变）。
      //   只数 `type==='impression'` 的 active 观察，**不拿消息观察数冒充印象数**。
      if (typeof memory?.activeImpressionCountsBySubject === 'function') {
        let thresholdsMet = false;
        try {
          const { minImpressions, maxPerMember } = resolveImpressionThresholds();
          const imp = memory.activeImpressionCountsBySubject({ chatKey });
          const total = Number(imp?.counts?.memberImpression) || 0;
          const anyOverloaded = (Array.isArray(imp?.members) ? imp.members : [])
            .some((m) => Number(m?.count) > maxPerMember);
          thresholdsMet = total > minImpressions || anyOverloaded;
        } catch { continue; }                       // 计数读不到 ⇒ 这轮不排（宁可晚，不乱排）
        if (!thresholdsMet && !(Number(item.observed) > 0)) continue;
      }
      budget -= 1;
      let result = null;
      try {
        // ★ reason 精确用 'auto-maintenance'（用户裁定）：这一条是**本模块发起**的自动整理。
        result = await raw({ chatKey, kind: item.kind, reason: AUTO_REASON });
      } catch (error) {
        result = { ok: false, error: error?.message ?? String(error) };
      }
      if (result?.ok === true && (result?.queued === true || result?.merged === true)) {
        deferred.delete(chatKey);
        lastRequestAt.set(chatKey, tickAt);
      } else {
        warnOnce(`auto-request:${chatKey}`, `自动整理入队被拒（${chatKey}）：${String(result?.error ?? result?.reason ?? 'unknown').slice(0, 80)}`);
      }
    }
  }

  /**
   * ③ 把队列里排着的整理 job 真的跑掉（2026-10-28 加）。
   *
   * 为什么另起一条：原来唯一的排水口在 orchestrator.onTick，而它的 `busy` 判据是
   * 「有回复在跑 / 有待发 / 队列非空」——群一热闹就恒为 true，排队的 job 只能等全场安静。
   * 实测：12:56 排的手工 job，十几分钟里 attempts 仍是 0，而群里一直在说话。
   * 记忆稀疏不是模型不行，是**整理几乎没机会跑**。
   *
   * 这里走同一个 coordinator.runNextJob（串行、自带 running 锁），只是不被聊天活动挡住：
   *   · 15 秒最多起一次，同一时刻只一个（`draining`）；
   *   · 队列空、或已有 job 在跑 ⇒ 直接返回；
   *   · 失败只记一行（无正文），不影响聊天。
   */
  function maybeDrainQueue(at) {
    if (draining) return;
    if (at - lastDrainAt < DRAIN_MIN_MS) return;
    const coordinator = typeof getCoordinator === 'function' ? getCoordinator() : null;
    if (!coordinator || typeof coordinator.runNextJob !== 'function') return;
    lastDrainAt = at;
    draining = true;
    Promise.resolve()
      .then(async () => {
        const st = await coordinator.status();
        if (Number(st?.running) > 0 || Number(st?.queues) <= 0) return;
        const r = await coordinator.runNextJob();
        if (r && r.ran === true) {
          log?.(`[apps/server] 记忆整理跑完一批（${String(r.chatKey ?? '')} status=${String(r.status ?? '?')} `
            + `episodes=${Number(r.episodes) || 0} impressions=${Number(r.impressions) || 0}）`);
        }
      })
      .catch((error) => {
        log?.(`[apps/server] ⚠ 记忆整理排水失败（不影响聊天）：${String(error?.message ?? error).slice(0, 160)}`);
      })
      .finally(() => { draining = false; });
  }

  /**
   * 心跳入口（**同一个** setInterval 调，不是第二个 timer）。内部只做节流判断 + 至多一次状态读。
   * @param {number} [tickAt] 心跳时间戳（缺省取 now()）
   */
  async function tick(tickAt) {
    const at = num(tickAt) ?? now();
    runLocalMaintenance(at);
    await flushDeferred(at);
    maybeDrainQueue(at);
  }

  /** 排障/面板读数（无正文）：待办会话数、当前生效的间隔、上次维护/扫描时刻。 */
  function status() {
    return {
      enabled: consolidateEnabled(),
      modelConfigured: modelConfigured(),
      deferredChats: deferred.size,
      // 待办里有几个会话、各自**攒了多少条观察**（就是触发源的可核实读数，只有 id 与计数）。
      deferredTop: [...deferred.entries()]
        .sort((a, b) => (a[1].firstAt || 0) - (b[1].firstAt || 0))
        .slice(0, 5)
        .map(([chatKey, item]) => ({ chatKey, observed: item.observed, firstAt: item.firstAt, lastAt: item.lastAt })),
      minIntervalMs: resolveMinIntervalMs(),
      impressionThresholds: resolveImpressionThresholds(),
      maintenanceIntervalMs: resolveMaintenanceMs(),
      lastMaintenanceAt: lastMaintenanceAt || null,
      lastScanAt: lastScanAt || null
    };
  }

  return { attach, tick, status, isAutoReason, AUTO_REASON };
}
