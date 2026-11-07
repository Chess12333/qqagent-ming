// 主动开话题（群冷场 + 私聊冷场 + 私聊定时）—— 从旧树搬成一个独立模块。
//
// 搬的是三处（行号指 `src/orchestrator.js` 盘面，2026-10-04）：
//   · `startProactiveLoop`        L5132-5160（**去掉自带 setTimeout**，改成"自己算 nextIdleAt、到点由 tick 判定"）
//   · `#startScheduleLoop`        L5163-5169（**整个不搬**：不再持有计时器）
//   · `#checkPrivateSchedules`    L5171-5216
//   · `#proactiveCandidates`       L5218-5247
//   · 随机区间 L5136-5139（`randInt(max(60000, checkIntervalMinMs||1800000), max(120000, checkIntervalMaxMs||5400000))`）
//
// ★ 与旧树的**故意不同**（逐条登记在文件末尾「与旧树的差异」）：
//   ① 不自建 `setTimeout/setInterval` —— 调度权在 M15 `runtime.onTick(now)` + 应用层 5s 心跳。
//   ② 概率缺省用 `??` 而不是 `||`：**显式 0 表示"绝不主动"**（旧 L5152-5153 的 `|| 0.25`
//      让 `probability: 0` 变成 0.25，等于关不掉 —— 对"骚扰"这一类功能是危险的默认值）。
//   ③ 随机源**必须注入**：`payload.clock?.random` → `factoryRandom` → **都没有就不抽样、不唤轮**，
//      记 fault。**绝不使用 `Math.random()`**（新树铁律：时间与随机从入参给）。
//   ④ 候选筛选用注入的 `now` 判冷场（旧 L5242 用 `Date.now()`），边界口径不变：
//      `now - lastTs >= idleMs` 才算冷场（**刚好等于阈值算通过**）。
//   ⑤ 私聊定时**每个 tick 都查**（旧树是 30s 一查）。5s 心跳比 30s 更密，分钟级定时不会漂；
//      去重键 `<chatId>|<HH:MM>|<日期>` 保证不会重复打。
//
// 不变量（与旧树一致）：
//   · **一次 tick 只打一个会话**（L5149 随机选一个 + L5214 `break`）。
//   · 群白名单空 ⇒ 要 `allowAllWhenEmpty` 才放行；**私聊白名单空 ⇒ 一个都不打**（防骚扰陌生人，L5235）。
//   · `unread > 0` 跳过（有人说话时不插嘴）。
//   · 正在跑的会话跳过 + 并发闸（`running.size >= max(1, maxConcurrentRuns||2)` 就整轮放弃）。
//   · 概率闸过不了就不唤轮。
//   · 状态盘读坏 ⇒ **fail-closed**：不当作空状态、不覆盖写、不唤轮、status 如实报 fault。
//
// ★ 依赖：零**兄弟**模块依赖；只用 node:fs / node:path + core/util 的 writeJsonAtomic
//   （N93 收口；core/util 自身零依赖，只碰 fs/path，导入期没有副作用）。
//   **不 import core/config-store**（导入期求值会把生产 data/ 带进来）。

import fs from 'node:fs';
import path from 'node:path';
// ★ N93：原子写收口（与 modules/broadcast 同一出处，别在这里再抄一份 tmp+rename）
import { writeJsonAtomic } from '../../core/util/index.js';

export const PROACTIVE_STATE_FILE = 'proactive-state.json';
/** 去重标记上限（搬旧 L5205-5208：超过 200 就删到剩 100）。 */
export const SCHEDULE_FIRED_LIMIT = 200;
export const SCHEDULE_FIRED_KEEP = 100;
/** 缺省概率（旧 L5152-5153 的 0.25）。注意是"缺省"，不是"0 会被顶成 0.25"。 */
export const DEFAULT_PROBABILITY = 0.25;

export class ProactiveStateError extends Error {
  constructor(message, code = 'proactive-state-error') {
    super(message);
    this.name = 'ProactiveStateError';
    this.code = code;
  }
}

/* ───────────────────────── 小工具 ───────────────────────── */

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const dateKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;   // 与旧 L5184 同口径（不补零）

/* ───────────────────────── 配置读取（三种形状 + 形状自检） ───────────────────────── */

/** 本模块会读的四个顶层键 —— 用来判断"这个 cfg 是不是我认识的形状"。 */
export const CONFIG_KEYS = Object.freeze(['proactive', 'allow', 'maxConcurrentRuns', 'allowAllWhenEmpty']);

/**
 * 判断 cfg 的形状。**为什么要专门判**：F1 那次硬失败就是"cfg 传成了 config-store 的模块命名空间"
 * ⇒ `cfg.proactive.enabled` 恒 undefined ⇒ 三总闸恒 false ⇒ **主动链 100% 不工作、且 faults 是空的**。
 * 形状不认识时必须喊出来（`cfg-shape-unrecognized`），绝不许静默。
 *
 * - `missing`      ：cfg 压根没给（null/undefined）⇒ 全闸关（安全方向），但要报，因为"以为配了其实没配"是接线错误。
 * - `accessor`     ：有 `get(keyPath, fallback)`（README §3.6 的只读访问器形状）。
 * - `flat`         ：平铺字段里至少有一个本模块认识的顶层键。
 * - `unrecognized` ：给了一个对象，但四个键一个都没有、也没有 `get` ⇒ **几乎必然是传错了东西**。
 *   ⚠️ 代价要说清：空对象 `{}` 也会落到这里。要表达"全部关掉"，请显式写 `proactive:{enabled:false}`。
 */
export function detectCfgShape(cfg) {
  const flat = typeof cfg === 'function' ? safeCallCfg(cfg) : cfg;
  if (flat === null || flat === undefined) return 'missing';
  if (typeof flat !== 'object') return 'unrecognized';
  // ① 平铺字段里真的有本模块认识的键
  if (CONFIG_KEYS.some((k) => Object.hasOwn(flat, k))) return 'flat';
  // ② 有 `get` ⇒ **探针一下它到底能不能读出我要的键**。
  //    ★ 这一步是 F4 的关键教训：config-store 的**模块命名空间**也有 `get`（我第一版按
  //    `typeof get === 'function'` 判成 accessor ⇒ F1 那种形态会**继续静默**）。
  //    真正能用的 accessor 必须读得出东西；读不出 ⇒ 它不是"可用的 accessor"，就是传错了。
  if (typeof flat.get === 'function') {
    for (const keyPath of ['proactive.enabled', 'allowAllWhenEmpty', 'maxConcurrentRuns', 'allow.groups']) {
      try {
        if (flat.get(keyPath, undefined) !== undefined) return 'accessor';
      } catch { /* 抛了就当不可用，继续试下一个键 */ }
    }
  }
  return 'unrecognized';
}

function safeCallCfg(cfg) {
  try { return cfg(); } catch { return undefined; }
}

/**
 * 统一的配置读取器。**三种形状都支持**（这是 F4 的另一半：光会喊还不够，得真读得到）：
 *   1. `cfg` 是函数 ⇒ 每次调用它取一份最新（装配层的 `cfgForModules()` 就是这个形状）
 *   2. 解析结果有 `get(keyPath, fallback)` ⇒ **优先走它**（活值、权威）
 *   3. 否则走平铺字段点路径（`proactive.enabled`）
 * @returns {{get:(keyPath:string, fallback:any)=>any, shape:string, raw:()=>any}}
 */
export function makeConfigReader(cfg) {
  const raw = () => (typeof cfg === 'function' ? safeCallCfg(cfg) : cfg);
  return {
    get shape() { return detectCfgShape(cfg); },
    raw,
    get(keyPath, fallback = undefined) {
      const c = raw();
      if (c == null || (typeof c !== 'object' && typeof c !== 'function')) return fallback;
      if (typeof c.get === 'function') {
        try {
          const viaAccessor = c.get(keyPath, undefined);
          if (viaAccessor !== undefined) return viaAccessor;
        } catch { /* accessor 抛了就退回平铺字段 */ }
      }
      let cur = c;
      for (const seg of String(keyPath).split('.')) {
        if (cur == null || typeof cur !== 'object') return fallback;
        cur = cur[seg];
      }
      return cur === undefined ? fallback : cur;
    }
  };
}

/** cfg 已经是 reader 就直接用，否则包一层（三处调用点共用）。 */
function asReader(cfg) {
  return cfg && typeof cfg.get === 'function' && typeof cfg.shape === 'string' ? cfg : makeConfigReader(cfg);
}

/** 概率缺省：`null/undefined/非数` → 0.25；**显式 0 → 0（绝不主动）**；并夹逼到 [0,1]。 */
export function resolveProbability(value) {
  if (value === null || value === undefined || value === '') return DEFAULT_PROBABILITY;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_PROBABILITY;
  return clamp01(n);
}

/** 群冷场阈值：至少 5 分钟（搬旧 L5222 的 `Math.max(300000, …)`）。 */
export function resolveGroupIdleMs(cfg) {
  const read = asReader(cfg);
  return Math.max(300000, Number(read.get('proactive.idleThresholdMs')) || 1800000);
}

/** 私聊冷场阈值：至少 1 分钟，缺省跟群一样（搬旧 L5223）。 */
export function resolvePrivateIdleMs(cfg, groupIdleMs) {
  const read = asReader(cfg);
  const raw = read.get('proactive.privateIdleThresholdMs');
  const n = Number(raw);
  // ★ 2026-10-26（溟，她定的新玩法）：私聊**显式填 0 就是 0** —— 不等冷场。
  //   她要的是「每半小时投一个骰子，不等冷场」，原来这里 Math.max(60000, …) 会把 0 抬回 1 分钟，
  //   而且 `|| groupIdleMs` 让 0 直接变成群的 20 分钟。两个坑一起犯，配成 0 等于没配。
  if (raw !== null && raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0) {
    return n === 0 ? 0 : Math.max(60000, n);
  }
  return Math.max(60000, Number(groupIdleMs) || 1800000);
}

/** 冷场间隔随机区间（搬旧 L5136-5139），返回 [min,max]。 */
export function resolveIdleIntervalMs(cfg) {
  const read = asReader(cfg);
  return [
    Math.max(60000, Number(read.get('proactive.checkIntervalMinMs')) || 1800000),
    Math.max(120000, Number(read.get('proactive.checkIntervalMaxMs')) || 5400000)
  ];
}

/* ───────────────────────── wake() 返回值：分清「闸门跳过」与「轮次结束」 ───────────────────────── */

/**
 * M15 `startProactiveRound()` 的六条闸门跳过时 resolve 的 reason 集合（L528-540）。
 * ★ **判据必须是 reason 白名单，不能只看 status** —— 轮次跑完 `writeFinish()` 也可能给
 *   `{status:'skipped', reason:'NO_EVIDENCE: …'}`（plan 决定不reply），那是**轮次结果**、不是闸门跳过。
 *   混在一起的后果：把"模型/规则决定不说话"记成"闸门把我拦了"，退避与黑名单都用错。
 */
export const GATE_SKIP_REASONS = Object.freeze([
  'invalid-chat-key', 'aborted', 'paused', 'chat-busy', 'chat-pending', 'concurrency-full'
]);
/** 瞬时跳过：稍后重试即可 ⇒ 短退避 60~180s。 */
export const TRANSIENT_SKIP_REASONS = Object.freeze(['paused', 'chat-busy', 'chat-pending', 'concurrency-full']);
/** 短退避区间（用注入的随机源抽样，不用 Math.random）。 */
export const SKIP_BACKOFF_MS = Object.freeze([60_000, 180_000]);
/** 永久跳过（本次运行内不会变好）⇒ 长退避 6 小时；另外把会话拉黑。 */
export const LONG_BACKOFF_MS = 6 * 60 * 60 * 1000;

/**
 * 把 `wake()` 的 resolve 值收敛成四态。
 * @returns {{status:'gate-skipped'|'woken'|'finished'|'unknown', reason:?string, finishStatus:?string}}
 */
export function readWakeOutcome(result) {
  if (result == null || typeof result !== 'object') return { status: 'unknown', reason: null, finishStatus: null };
  const status = String(result.status ?? '');
  const reason = result.reason == null ? null : String(result.reason);
  if (status === 'skipped' && reason && GATE_SKIP_REASONS.includes(reason)) {
    return { status: 'gate-skipped', reason, finishStatus: null };
  }
  if (status === 'skipped') return { status: 'finished', reason, finishStatus: 'skipped' };
  // ★ 只有 delivered 才算"真的唤出去了"。M15 里"轮次跑完但没确认送达"给的是 completed
  //   —— 主动轮模型没说话时 reason=COMPOSE_EMPTY，走的**也是 completed** ⇒ 那是 finished，不是 woken。
  //   （这是 OBS-c 自测抓出来的：我第一版把 completed 和 delivered 一起当"唤过"，等于把"没说话"记成"说了"。）
  if (status === 'delivered') return { status: 'woken', reason, finishStatus: 'delivered' };
  if (status === 'completed') return { status: 'finished', reason, finishStatus: 'completed' };
  if (status === 'error' || status === 'aborted' || status === 'stopped') {
    return { status: 'finished', reason, finishStatus: status };
  }
  if (!status) return { status: 'unknown', reason, finishStatus: null };
  return { status: 'finished', reason, finishStatus: status };
}

/** 这个 reason 该短退避还是长退避？未知 reason 按**瞬时**处理（早点重试才能学到行为）。 */
export function isTransientSkipReason(reason) {
  if (!reason) return true;
  if (TRANSIENT_SKIP_REASONS.includes(reason)) return true;
  if (GATE_SKIP_REASONS.includes(reason)) return false;   // invalid-chat-key / aborted
  return true;
}

/** 定时条目归一化：把旧 L5189-5196 的现场校验抽成纯函数（口径一字不改）。 */export function normalizeScheduleItem(item) {
  if (!item || item.enabled === false) return null;
  const chatId = String(item.chatId || item.userId || item.id || '').trim();
  if (!/^\d{5,15}$/.test(chatId)) return null;
  const t = String(item.time || '').trim();
  if (!/^\d{1,2}:\d{2}$/.test(t)) return null;
  const [th, tm] = t.split(':').map((x) => Number(x));
  if (Number.isNaN(th) || Number.isNaN(tm)) return null;
  const target = `${String(th).padStart(2, '0')}:${String(tm).padStart(2, '0')}`;
  const days = Array.isArray(item.days) ? item.days.map(Number).filter((n) => n >= 0 && n <= 6) : [];
  return { chatId, target, days, enabled: true };
}

/* ───────────────────────── 状态存储（fail-closed） ───────────────────────── */

/**
 * 极小状态盘：只存"下一次冷场检查时间"与"私聊定时的去重标记"。
 * ★ 为什么落盘：旧树这两个都在内存（`this.lastScheduleFired` / `proactiveTimer`），
 *   **重启即丢** ⇒ 同一天里重启一次就会把已打过的定时再打一遍。落盘把这个已知取舍收窄。
 *   代价见回执：状态盘损坏 ⇒ 本模块**整个不动作**（fail-closed），主动功能会静默停摆。
 * 盘上形状（本模块自定，无历史包袱）：
 *   { "version": 1, "nextIdleAt": <ms|0>, "scheduleFired": { "<chatId>|<HH:MM>|<日期>": <ms> } }
 */
export function createStateStore({ dataDir, log = () => {} } = {}) {
  const dir = String(dataDir ?? '');
  if (!dir) throw new ProactiveStateError('createProactive 需要显式 dataDir（本模块不猜仓库 data/）', 'no-data-dir');
  const root = path.resolve(dir);
  const file = path.join(root, PROACTIVE_STATE_FILE);
  let corrupt = null;
  let state = { nextIdleAt: 0, scheduleFired: {}, blocked: {} };

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { nextIdleAt: 0, scheduleFired: {}, blocked: {}, probAttempts: {}, lastTick: null };   // 首次运行：空状态合法
      corrupt = { message: `读取失败：${String(error?.message ?? error).slice(0, 200)}`, at: Date.now() };
      throw new ProactiveStateError(`proactive-state.json 读取失败（拒绝当空状态）：${corrupt.message}`, 'unreadable');
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('顶层不是对象');
      const marks = parsed.scheduleFired && typeof parsed.scheduleFired === 'object' && !Array.isArray(parsed.scheduleFired)
        ? parsed.scheduleFired : null;
      if (parsed.scheduleFired !== undefined && !marks) throw new Error('scheduleFired 不是对象');
      const blocked = parsed.blocked && typeof parsed.blocked === 'object' && !Array.isArray(parsed.blocked)
        ? { ...parsed.blocked }
        : (parsed.blocked === undefined ? {} : null);
      if (blocked === null) throw new Error('blocked 不是对象');
      // ★ 2026-10-26（溟）：概率递进的计数（每个会话连续几次没中）。老状态盘没有这个字段，
      //   缺省 {} —— 不存在就当 0 次，不报错、不当损坏。
      const probAttempts = parsed.probAttempts && typeof parsed.probAttempts === 'object' && !Array.isArray(parsed.probAttempts)
        ? { ...parsed.probAttempts }
        : (parsed.probAttempts === undefined ? {} : null);
      if (probAttempts === null) throw new Error('probAttempts 不是对象');
      // ★ 2026-10-26（溟）：最近一次投骰的自检信息（纯排障用，进 state 而不是日志 ——
      //   这个模块拿到的 logSink 只接单参，结构化字段会静默丢掉）。
      const lastTick = parsed.lastTick && typeof parsed.lastTick === 'object' && !Array.isArray(parsed.lastTick) ? parsed.lastTick : null;
      return { nextIdleAt: Number(parsed.nextIdleAt) || 0, scheduleFired: { ...marks }, blocked, probAttempts, lastTick };
    } catch (error) {
      corrupt = { message: `解析失败：${String(error?.message ?? error).slice(0, 200)}`, at: Date.now() };
      throw new ProactiveStateError(`proactive-state.json 已损坏，拒绝当空状态、拒绝覆盖写：${corrupt.message}`, 'corrupt');
    }
  }

  function save() {
    if (corrupt) {
      throw new ProactiveStateError(`状态盘已损坏（${corrupt.message}），拒绝覆盖写；请人工修好 ${file}`, 'corrupt');
    }
    // ★ N93：tmp+rename 统一收口到 core/util.writeJsonAtomic（失败会自己清 tmp）。
    //   ★★ `indent: 1` 是**显式传的**：该函数默认紧凑输出，不传就等于把 proactive-state.json
    //     整体重写字节（盘上形状是本模块自定的，但改格式会让"重启后续跑"读回不同形状）。
    try {
      writeJsonAtomic(file, { version: 1, nextIdleAt: state.nextIdleAt || 0, scheduleFired: state.scheduleFired, blocked: state.blocked, probAttempts: state.probAttempts || {}, lastTick: state.lastTick || null }, { indent: 1 });
    } catch (error) {
      throw new ProactiveStateError(`写 ${PROACTIVE_STATE_FILE} 失败：${String(error?.message ?? error).slice(0, 200)}`, 'write-failed');
    }
    return true;
  }

  // ★ 初始化时就把状态读进来（fail-closed 在此生效）。
  //   这一行曾经漏掉：load() 定义了但没人调，结果 nextIdleAt 永远是 0 ⇒
  //   ① 每次 tick 都重新上弦 → 冷场扫描退化成"每 15 秒扫一遍全表"；
  //   ② 私聊定时的去重标记跨实例失效 ⇒ 重启后当天重复发（正是旧树的已知取舍）。
  //   是自测 ③b（重启后不该重复发）与 ②b（间隔 30~90 分钟）把它抓出来的。
  state = load();

  return {
    file,
    get corrupt() { return corrupt ? { ...corrupt } : null; },
    /** 只读快照。 */
    snapshot() { return { nextIdleAt: state.nextIdleAt || 0, firedCount: Object.keys(state.scheduleFired).length, probAttempts: { ...(state.probAttempts || {}) }, corrupt: corrupt ? { ...corrupt } : null }; },
    get fired() { return state.scheduleFired; },
    get nextIdleAt() { return state.nextIdleAt || 0; },
    set nextIdleAt(v) { state.nextIdleAt = Number(v) || 0; },
    /** 去重标记是否已存在（不写盘）。 */
    hasFired(key) { return Object.hasOwn(state.scheduleFired, key); },
    /** 会话是否被拉黑（invalid-chat-key 这类"发不出去"的会话不该反复进候选）。 */
    isBlocked(chatKey) { return Object.hasOwn(state.blocked, String(chatKey)); },
    blockedList() { return Object.entries(state.blocked).map(([chatKey, v]) => ({ chatKey, reason: String(v?.reason ?? ''), at: Number(v?.at) || 0 })); },
    /** 拉黑（带上限，防状态盘无限长）。 */
    blockChat(chatKey, reason, at) {
      state.blocked[String(chatKey)] = { reason: String(reason ?? '').slice(0, 64), at: Number(at) || 0 };
      const keys = Object.keys(state.blocked);
      if (keys.length > 200) for (const k of keys.slice(0, keys.length - 100)) delete state.blocked[k];
      save();
      return true;
    },
    unblockChat(chatKey) { if (!Object.hasOwn(state.blocked, String(chatKey))) return false; delete state.blocked[String(chatKey)]; save(); return true; },
    /** 记一条去重标记（内存 + 立即落盘）；超上限按旧 L5205-5208 删到剩 100。 */
    markFired(key, at) {
      state.scheduleFired[key] = Number(at) || 0;
      const keys = Object.keys(state.scheduleFired);
      if (keys.length > SCHEDULE_FIRED_LIMIT) {
        for (const k of keys.slice(0, keys.length - SCHEDULE_FIRED_KEEP)) delete state.scheduleFired[k];
      }
      save();
      return true;
    },
    /**
     * ★ 2026-10-26（溟，她定的新玩法）：主动发言的概率**逐次递进**。
     *   她要的是「每半小时投一个骰子，先是 5%，再是 25%，然后 45%，以此类推，发出来之后重置」。
     *   ⇒ 每个会话记一个"连续没中的次数"，第 n 次掷骰的概率 = 基数 + n × 步长。
     *   默认步长 0.2（正好是 5→25→45→65→85→105，第五次必中）。
     *   发出去了（woken/delivered）就清零；没中就 +1 —— 于是"越等越容易中"。
     *   存在状态盘里，重启不丢。
     */
    getProbAttempts(chatKey) { return Number(state.probAttempts?.[String(chatKey)]) || 0; },
    bumpProbAttempts(chatKey) {
      const k = String(chatKey);
      state.probAttempts[k] = (Number(state.probAttempts[k]) || 0) + 1;
      const keys = Object.keys(state.probAttempts);
      if (keys.length > 200) for (const kk of keys.slice(0, keys.length - 100)) delete state.probAttempts[kk];
      save();
      return state.probAttempts[k];
    },
    /**
     * ★ 2026-10-26（溟）：把"这一 tick 走到哪了"记进状态盘。
     *   为什么不用日志：`createProactive` 拿到的 logSink 只接单参（assembly 传的 `log(msg)`），
     *   结构化字段全被丢掉，我加的诊断行一条都没落盘 —— 排障时等于瞎。
     *   状态盘是现成的、能落盘、能读、也能给 UI 看。只记分支名与几个计数，不记聊天内容。
     */
    noteTick(info) {
      state.lastTick = { at: Date.now(), ...(info && typeof info === 'object' ? info : {}) };
      save();
      return state.lastTick;
    },
    resetProbAttempts(chatKey) {
      const k = String(chatKey);
      if (!state.probAttempts || !Object.hasOwn(state.probAttempts, k)) return false;
      delete state.probAttempts[k];
      save();
      return true;
    },
    /** 推进下一次冷场检查时间并落盘。 */    setNextIdleAt(at) { state.nextIdleAt = Number(at) || 0; save(); return state.nextIdleAt; },
    save,
    load
  };
}

/* ───────────────────────── 候选筛选（搬 #proactiveCandidates L5218-5247） ───────────────────────── */

/**
 * 挑"安静且允许"的会话。**逐条对齐旧树**：
 *   群：总闸 `proactive.enabled === true`；白名单非空则必须在其中，为空则要 `allowAllWhenEmpty`
 *   私聊：总闸 `proactive.privateIdleEnabled === true`；**白名单必须命中**（空列表 ⇒ 一个都不打）
 *   两者都：`meta.unread > 0` 跳过；`now - meta.lastTs >= idleMs`；正在跑的不打
 * @returns {{out:string[], skipped:Array<{chatKey:string,why:string}>}}
 */
export function proactiveCandidates(cfg, chats, { now, running = new Set() } = {}) {
  const read = asReader(cfg);
  const groupOn = read.get('proactive.enabled') === true;
  const privateIdleOn = read.get('proactive.privateIdleEnabled') === true;
  const out = [];
  const skipped = [];
  if (!groupOn && !privateIdleOn) return { out, skipped };
  const groupIdleMs = resolveGroupIdleMs(cfg);
  const privateIdleMs = resolvePrivateIdleMs(cfg, groupIdleMs);
  const allowGroups = (read.get('allow.groups') ?? []).map(String);
  const allowPrivate = (read.get('allow.private') ?? []).map(String);
  // ★ 2026-10-31（溟）：白名单是「能跟她说话的人」，不等于「我可以主动找他说话」。
  //   余数 100000003 的私聊是 10-31 开的，但他没让我主动找他——不排除的话，
  //   冷场骰子会按给她的那套（15 分钟一掷、20% 起）也去敲他的门。
  //   排除表默认空，行为不变；要放谁就把它从表里删掉。
  const privateExclude = (read.get('proactive.privateExclude') ?? []).map(String);
  const allowPrivateIdle = allowPrivate.filter((id) => !privateExclude.includes(id));

  let list;
  try {
    list = chats.listChats();
  } catch (error) {
    return { out, skipped: [{ chatKey: '*', why: `listChats 抛错：${String(error?.message ?? error).slice(0, 120)}` }] };
  }
  for (const chatKey of Array.isArray(list) ? list : []) {
    const [kind, id] = String(chatKey).split(':');
    if (kind === 'group') {
      if (!groupOn) { skipped.push({ chatKey, why: 'group-gate-off' }); continue; }
      if (allowGroups.length > 0 ? !allowGroups.includes(id) : read.get('allowAllWhenEmpty') !== true) {
        skipped.push({ chatKey, why: 'group-not-allowlisted' });
        continue;
      }
    } else if (kind === 'private') {
      if (!privateIdleOn) { skipped.push({ chatKey, why: 'private-gate-off' }); continue; }
      // 私聊白名单空列表 ⇒ 不主动私聊（防骚扰陌生人，旧 L5235）
      if (!allowPrivateIdle.includes(id)) { skipped.push({ chatKey, why: allowPrivate.includes(id) ? 'private-idle-excluded' : 'private-not-allowlisted' }); continue; }
    } else {
      skipped.push({ chatKey, why: 'unknown-kind' });
      continue;
    }
    const meta = chats.getChatMeta(chatKey);
    // ★ fail-closed：拿不到 meta（旧树会在这里抛）⇒ 跳过并留痕，不拿"未知"去当"可以插嘴"
    if (!meta || typeof meta !== 'object') { skipped.push({ chatKey, why: 'no-meta' }); continue; }
    // 2026-11-04 00:2x 改：unread 不能是永久闸。
    //   原来只要 meta.unread > 0 就 skip ⇒ 她那边一条没点开，主动私聊就整晚锁死
    //   （10-30 栽过一次；今晚又栽：private:100000001 unread=6，lastTick 里
    //    skippedDetail 明写 {"chatKey":"private:100000001","why":"unread"}，
    //    probAttempts 已经掷到 1 次，一条「想你」都没发出去）。
    //   口径回到本意：unread 只挡「她刚说过话、我不该插嘴」；超过 30 分钟还挂着，
    //   那只是没点开，不是她正在说。
    const UNREAD_GUARD_MS = 30 * 60 * 1000;
    const unreadLastTs = Number(meta.lastTs);
    if (Number(meta.unread) > 0 && Number.isFinite(unreadLastTs) && now - unreadLastTs < UNREAD_GUARD_MS) {
      skipped.push({ chatKey, why: 'unread' });
      continue;
    }
    // ★ 第 5 处有意与旧树不同（指挥位 2026-10-05 裁定）：**一条消息都没有的会话不算冷场**。
    //   判据用 `meta.total === 0`（ChatStore.getChatMeta 给 `total`）。
    //   理由（产品口径）：「冷场」的语义是"曾经有动静、现在安静"，**零消息的会话根本没有"曾经"**；
    //   白名单里刚建/刚拉进群的会话，被判冷场没有任何证据支持"这里有人想让它开口"，
    //   而**开口的代价（被踢 / 被说"这机器人乱说话"）由用户承担**。
    //   ★ 旧树会把零消息会话当冷场（`src/orchestrator.js:5242` 只看 `now - lastTs`，
    //     而 `lastTs` 在空会话是 0 ⇒ 差值极大 ⇒ 通过）。**这是有意不同，不是漏搬。**
    //   `total` 缺失/非数时**不启用**这道闸（保持旧行为，不拿"不知道"当"没有"）。
    const total = Number(meta.total);
    if (Number.isFinite(total) && total <= 0) { skipped.push({ chatKey, why: 'no-messages' }); continue; }
    const idleMs = kind === 'private' ? privateIdleMs : groupIdleMs;
    const lastTs = Number(meta.lastTs);
    if (!Number.isFinite(lastTs)) { skipped.push({ chatKey, why: 'bad-lastTs' }); continue; }
    // 边界口径与旧树一致：`now - lastTs < idleMs` 才跳过 ⇒ **刚好等于阈值算冷场**
    if (now - lastTs < idleMs) { skipped.push({ chatKey, why: 'not-idle-enough' }); continue; }
    if (running.has(chatKey)) { skipped.push({ chatKey, why: 'running' }); continue; }
    out.push(chatKey);
  }
  return { out, skipped };
}

/* ───────────────────────── 工厂 ───────────────────────── */

/**
 * @param {{dataDir:string, log?:Function, cfg?:object, chats?:{listChats:Function,getChatMeta:Function}, random?:Function}} opts
 *   cfg     —— 注入的配置**访问器或字面量**（`.proactive.*` / `.allow.*` / `.allowAllWhenEmpty` / `.maxConcurrentRuns`）
 *   chats   —— 由装配层从 ChatStore 注入；拿不到 ⇒ onTick 记 fault，**不唤轮、不假装**
 *   random  —— 可选。随机源解析顺序：`payload.clock.random` → 这里的 `random` → **都没有就不抽样**
 * @returns {{onTick:Function, status:Function}}
 */
export function createProactive({ dataDir, log = () => {}, cfg = null, chats = null, random = null } = {}) {
  // ★ 缺 dataDir 是**装配层编程错误**，当场抛：悄悄建一个"什么都不做还不报错"的实例
  //   比启动失败坏得多 —— 主动功能停了没人会发现。
  //   （状态盘**损坏**是另一回事，走下面的 stateError 软路径，不炸装配层。）
  if (!String(dataDir ?? '')) {
    throw new ProactiveStateError('createProactive 需要显式 dataDir（本模块不猜仓库 data/，那是真实聊天数据所在）', 'no-data-dir');
  }
  const say = (msg) => { try { log(msg); } catch { /* 日志不许反噬 */ } };
  // F4：cfg 一律经 reader 读（函数 / accessor / 平铺三种形状都支持），
  // 并**主动自检形状** —— 不认识就记 fault，绝不静默（F1 就是这么变成 100% 静默不工作的）。
  const cfgRead = makeConfigReader(cfg);
  const cfgOf = () => cfgRead.raw() || {};

  let store = null;
  let stateError = null;
  try {
    store = createStateStore({ dataDir, log: say });
    // 触发一次真实读盘（fail-closed 在这里生效）
    store.snapshot();
  } catch (error) {
    stateError = { message: String(error?.message ?? error), code: error?.code ?? 'state-error', at: Date.now() };
    say(`[proactive] 状态盘不可用，本实例不动作：${stateError.message}`);
  }

  const faults = [];
  let lastTick = null;
  let lastPayload = {};          // ★ T-PROACTIVE-OBS：attachWakeOutcome 要用本 tick 的 clock.random 做退避抽样
  const fired = [];          // 最近若干次唤轮记录（只留 id/原因/时间，不留会话内容）

  function fault(code, detail) {
    const item = { code, detail: String(detail ?? '').slice(0, 200), at: Date.now() };
    faults.push(item);
    if (faults.length > 50) faults.splice(0, faults.length - 50);
    return item;
  }

  /** M15 的 status → {paused, running:Set}。取不到就当"没在跑"（旧树 aborted 也没暴露给本模块）。 */
  function runtimeState(payloadStatus) {
    const paused = payloadStatus?.paused === true;
    const running = new Set();
    const rows = Array.isArray(payloadStatus?.running) ? payloadStatus.running : [];
    for (const row of rows) {
      const key = String(row?.chatKey ?? row ?? '').trim();
      if (key) running.add(key);
    }
    return { paused, running };
  }

  function resolveRandom(payload) {
    const fromClock = payload?.clock?.random;
    if (typeof fromClock === 'function') return fromClock;
    if (typeof random === 'function') return random;
    return null;
  }

  /**
   * ★ T-PROACTIVE-OBS 补丁 B：**我侧预先拒绝**（还没调 wake 就放弃）也要退避。
   * 原缺陷的另一半：nextIdleAt 在决定唤不唤之前就推到了整窗口，于是
   * paused / 并发闸满 / 无随机源 / 概率没中 这些"我没唤成"的路径**照样吞掉整个窗口**。
   * 这些都是**瞬时**原因 ⇒ 一律短退避 60~180s。
   * @param {'paused'|'concurrency-cap'|'no-random-source'|'probability-miss'} why
   */
  function declineLocally(report, why, at, { keepWindow = false } = {}) {
    report.errors.push(why);
    // ★ 2026-10-26（溟）：`probability-miss` 传 keepWindow —— 她的规格是「每半小时投一个骰子」，
    //   没中就该等下个半点，不该 60~180 秒后又掷一次。原来这里一律短退避，等于 miss 后
    //   两分钟就重投，半小时能投十几次、概率飞速堆到 100%，跟她要的节奏完全不是一回事。
    //   （短暂的 paused / 并发满 / 没随机源 仍然短退避：那是坏在系统上，不是骰子没中。）
    if (!keepWindow) {
      const [lo, hi] = SKIP_BACKOFF_MS;
      const jitter = resolveRandom(lastPayload) ? clamp01(resolveRandom(lastPayload)()) : 0;
      store.setNextIdleAt(at + lo + Math.floor(jitter * (hi - lo)));
    }
    report.declinedLocally = why;
    report.skipBackoffMs = store.nextIdleAt - at;
    report.nextIdleAtAfterSkip = store.nextIdleAt;
    return report;
  }

  /** `status().recentWake` 的真实结果记录（pending → woken/skipped/failed 会就地改写）。 */
  function recordWake(entry) {
    fired.push(entry);
    if (fired.length > 50) fired.splice(0, fired.length - 50);
    return entry;
  }
  function patchLastWake(predicate, patch) {
    for (let i = fired.length - 1; i >= 0; i -= 1) {
      if (predicate(fired[i])) { Object.assign(fired[i], patch); return fired[i]; }
    }
    return null;
  }

  /**
   * ★ T-PROACTIVE-OBS（本票的核心）：**读 `wake()` 的返回值**。
   *
   * 为什么不能 `await`：M15 的 `wake()` 在**接受**之后要 resolve 到整轮跑完（含模型调用），
   * 在 tick 里 await 会把 5 秒心跳挂住几十秒。所以这里**不阻塞**：挂 `.then()` 就地改写
   * 同一个 report 对象（`status().lastTick` 拿到的就是改写后的），并按 reason 重新排期。
   *
   * 口径（指挥位 2026-10-05 定的）：
   *   · **跳过不是 fault** —— 只记 `report.wokenSkipped` + `report.errors` 里一条可观测标记；
   *   · 瞬时 reason（paused / chat-busy / chat-pending / concurrency-full）⇒ **短退避 60~180s**；
   *   · 永久 reason（invalid-chat-key / aborted）⇒ **长退避 6h**，且 `invalid-chat-key` 额外**拉黑该 chatKey**；
   *   · 未知 reason ⇒ 按瞬时处理（早点重试才能学到行为）。
   *
   * ★ `fault('wake-failed')` **保留**，但它**不覆盖跳过** —— 只有 `wake()` 真的 reject 时才触发
   *   （当前 M15 现实路径不 reject；这是给未来 M15 改代码留的唯一通道）。
   */
  function attachWakeOutcome(report, promise, { chatKey, via, at, probability = null, fireKey = null, resetProbabilityOnDelivered = false }) {
    const rand = resolveRandom(lastPayload);
    const settle = (outcome) => {
      if (outcome.status === 'gate-skipped') {
        const transient = isTransientSkipReason(outcome.reason);
        report.wokenSkipped = { chatKey, via, reason: outcome.reason };
        delete report.woken;                              // ★ 不能既"唤过"又"被跳过"
        report.errors.push(`wake-skipped:${outcome.reason}`);
        patchLastWake((e) => e.chatKey === chatKey && e.result === 'pending',
          { result: 'skipped', skipReason: outcome.reason, transient });
        if (via === 'idle') {
          if (transient) {
            const [lo, hi] = SKIP_BACKOFF_MS;
            const jitter = rand ? clamp01(rand()) : 0;
            store.setNextIdleAt(at + lo + Math.floor(jitter * (hi - lo)));
          } else {
            store.setNextIdleAt(at + LONG_BACKOFF_MS);
            if (outcome.reason === 'invalid-chat-key') store.blockChat(chatKey, outcome.reason, at);
          }
          report.nextIdleAtAfterSkip = store.nextIdleAt;
          report.skipBackoffMs = store.nextIdleAt - at;
        }
        return outcome;
      }
      if (outcome.status === 'woken') {
        report.woken = { chatKey, via, status: outcome.finishStatus || 'delivered', probability, fireKey, pending: false };
        patchLastWake((e) => e.chatKey === chatKey && e.result === 'pending',
          { result: 'woken', finishStatus: outcome.finishStatus });
        // ★ 2026-10-26（溟）：她说的"发出来之后重置" —— 只有真唤出去（delivered）才清零。
        //   "轮次跑完但没说话"（finished）不算发出去，概率继续往上堆。
        if (resetProbabilityOnDelivered) {
          try { store.resetProbAttempts(chatKey); } catch { /* 状态盘写失败不该毁掉唤轮结论 */ }
        }
      } else if (outcome.status === 'finished') {
        // 轮次跑完了，但结果是"这一轮没说话/被守卫拦下"（COMPOSE_EMPTY / COMPOSE_GUARD / error …）。
        // 这是**轮次结果**，不是闸门跳过 ⇒ 不退避、不拉黑，但要如实记。
        report.woken = { chatKey, via, status: outcome.finishStatus, reason: outcome.reason, probability, fireKey, pending: false };
        patchLastWake((e) => e.chatKey === chatKey && e.result === 'pending',
          { result: 'finished', finishStatus: outcome.finishStatus, reason: outcome.reason });
      } else {
        report.errors.push('wake-unknown-result');
        patchLastWake((e) => e.chatKey === chatKey && e.result === 'pending', { result: 'unknown' });
      }
      return outcome;
    };
    Promise.resolve(promise)
      .then((result) => settle(readWakeOutcome(result)))
      .catch((error) => {
        fault('wake-failed', `${chatKey}: ${String(error?.message ?? error).slice(0, 160)}`);
        report.wokenFailed = { chatKey, via, error: String(error?.message ?? error).slice(0, 160) };
        delete report.woken;
        report.errors.push('wake-failed');
        patchLastWake((e) => e.chatKey === chatKey && e.result === 'pending', { result: 'failed' });
      });
    return promise;
  }

  /**
   * ★ F4（2026-10-05，独立复核批准的补丁）：**cfg 形状自检**。
   * F1 那次硬失败的表现就是"cfg 传错了形状 ⇒ 三总闸恒 false ⇒ 主动链 100% 不工作、
   * 而 `status().faults` 是空数组"。所以这里主动喊：
   *   · `missing` / `unrecognized` ⇒ 记 fault，**一次形状变化只记一次**（否则每 5 秒刷屏）。
   * 不因为"喊了"就改变行为 —— 读不到配置仍然是"全闸关"（安全方向），区别只在于**它不再是静默的**。
   */
  let lastCfgShape = null;
  function checkCfgShape() {
    const shape = cfgRead.shape;
    if (shape === lastCfgShape) return shape;
    lastCfgShape = shape;
    if (shape === 'missing') {
      fault('cfg-missing', 'createProactive 没拿到 cfg（三个总闸会全关 ⇒ 主动链不工作）。要"全关"请显式写 proactive:{enabled:false}');
    } else if (shape === 'unrecognized') {
      const keys = Object.keys(cfgOf()).slice(0, 6);
      // ⚠️ 文案要**短**：fault() 会截到 200 字符，关键信息必须排在前面（我第一版把 F1 的提示写在末尾 ⇒ 被截掉）。
      fault('cfg-shape-unrecognized',
        `cfg 形状不认识（收到 ${keys.length ? keys.join(',') : '(空对象)'}）：只认 ①函数 ②get()能真读出值的 accessor ③含 proactive/allow/maxConcurrentRuns/allowAllWhenEmpty 的平铺对象。`
        + '★"有 get 但读不出值" = config-store 模块命名空间 = F1 的形态');
    }
    return shape;
  }

  /**
   * 私聊定时检查（搬 #checkPrivateSchedules L5171-5216）。
   * @returns {{fired:object|null, considered:number}}
   */
  function checkPrivateSchedules(cfg, { now, running, rand }) {
    const read = asReader(cfg);
    if (read.get('proactive.privateScheduleEnabled') !== true) return { fired: null, considered: 0 };
    const list = Array.isArray(read.get('proactive.privateSchedules')) ? read.get('proactive.privateSchedules') : [];
    if (!list.length) return { fired: null, considered: 0 };
    if (running.size >= Math.max(1, Number(read.get('maxConcurrentRuns')) || 2)) return { fired: null, considered: 0 };
    const allowPrivate = (read.get('allow.private') ?? []).map(String);
    const d = new Date(now);
    const time = hhmm(d);
    const day = dateKey(d);
    const dow = d.getDay();                       // 0=Sun（旧 L5185）
    let considered = 0;

    for (const item of list) {
      const norm = normalizeScheduleItem(item);
      if (!norm) continue;
      considered += 1;
      if (allowPrivate.length && !allowPrivate.includes(norm.chatId)) continue;
      if (norm.target !== time) continue;
      if (norm.days.length && !norm.days.includes(dow)) continue;
      const fireKey = `${norm.chatId}|${norm.target}|${day}`;
      if (store.hasFired(fireKey)) continue;
      // 旧树口径：**先记去重标记，再看 running** ⇒ 正在跑时这一分钟不会再打（当天不会补）。
      // 我照搬，并把它写进 status 的 knownTradeoffs，不擅自"修好"。
      store.markFired(fireKey, now);
      const chatKey = `private:${norm.chatId}`;
      if (running.has(chatKey)) return { fired: { chatKey, fireKey, skippedRunning: true }, considered };
      say(`[proactive] 私聊定时触发 ${chatKey} @${norm.target}`);
      return { fired: { chatKey, fireKey, skippedRunning: false }, considered };
    }
    return { fired: null, considered };
  }

  /**
   * 唯一驱动入口。由 M15 `runtime.onTick(now)` 喂；本模块**不自己计时**。
   * @param {number} now
   * @param {{wake?:Function, status?:object, sendScheduled?:Function, clock?:{random?:Function}}} payload
   * @returns {object} tick 报告（同步返回；内部不 await —— 唤轮 fire-and-forget，错误自己接住）
   */
  function onTick(now, payload = {}) {
    lastPayload = payload || {};
    const at = Number(now);
    // ★ 严格判时间：`Number(null)===0`、`Number('')===0` 都是"有限数"，直接放行会把
    //   null/空串当成"1970 年"静默跑一轮。必须先判类型，再判有限。
    const timeUsable = (typeof now === 'number' && Number.isFinite(now))
      || (typeof now === 'string' && now.trim() !== '' && Number.isFinite(at));
    const report = {
      now: Number.isFinite(at) ? at : null,       checkedIdle: false, consideredCandidates: 0, scheduleGate: 'off',
      woken: null, scheduled: null, errors: []
    };
    if (!timeUsable || !Number.isFinite(at)) {
      fault('bad-now', 'onTick(now) 需要有限的注入时间（null/空串不算）');
      report.errors.push('bad-now');
      lastTick = report;
      return report;
    }
    if (!store) {
      // fail-closed：状态盘坏 ⇒ 整个不动作（不唤轮、不覆盖写）
      fault('state-unavailable', stateError?.message ?? 'unknown');
      report.errors.push('state-unavailable');
      lastTick = report;
      return report;
    }
    checkCfgShape();          // ★ F4：形状不认识 ⇒ 记 fault（不改变行为，只是不再静默）
    if (!chats || typeof chats.listChats !== 'function' || typeof chats.getChatMeta !== 'function') {
      // ★ 指挥位点名：拿不到 chats ⇒ 记 fault，**不唤轮、不假装**
      fault('no-chats', 'chats 未注入（需要 {listChats, getChatMeta}）');
      report.errors.push('no-chats');
      lastTick = report;
      return report;
    }

    const cfg = cfgOf();
    const rt = runtimeState(payload.status);
    const rand = resolveRandom(payload);

    /* ── 私聊定时：每个 tick 都查（比旧树 30s 更密，去重键保证不重复） ── */
    if (!rt.paused) {
      try {
        const sched = checkPrivateSchedules(cfg, { now: at, running: rt.running, rand });
        report.scheduled = sched.fired ? { ...sched.fired, time: new Date(at).toISOString() } : null;
        report.consideredSchedules = sched.considered;
        // gate 反映**配置**，不是"有没有调用到函数" —— 否则总闸关着也会显示 'on'。
        report.scheduleGate = cfgRead.get('proactive.privateScheduleEnabled') === true ? 'on' : 'off';
        if (sched.fired && !sched.fired.skippedRunning && typeof payload.wake === 'function') {
          const key = sched.fired.fireKey;
          // ★ T-PROACTIVE-OBS：读 `wake()` 的返回值（下面 attachWakeOutcome 统一处理）。
          //   私聊定时**不推 nextIdleAt**（它走分钟级去重键），所以这里只记真实结果、不做退避；
          //   去重标记"先写后看 running"的次序**保持现状**（已登记为取舍，本票不动）。
          attachWakeOutcome(report, payload.wake({ chatKey: sched.fired.chatKey, proactive: true, proactiveReason: 'schedule' }), {
            chatKey: sched.fired.chatKey, via: 'schedule', at, fireKey: key
          });
          report.woken = { chatKey: sched.fired.chatKey, reason: 'schedule', fireKey: key, pending: true };
          recordWake({ at, chatKey: sched.fired.chatKey, reason: 'schedule', result: 'pending', fireKey: key });
        } else if (sched.fired && sched.fired.skippedRunning) {
          report.errors.push('schedule-skipped-running');
        }
      } catch (error) {
        fault('schedule-check-failed', error?.message ?? error);
        report.errors.push('schedule-check-failed');
      }
    } else {
      // paused 时**不检查定时**（旧口径），但要把 idle 的窗口补上：
      // 下面 idle 分支会在 nextIdleAt 到点时统一处理；这里只标记本轮是暂停态。
      report.errors.push('paused');
    }

    /* ── 冷场主动：到点才查（随机 30~90 分钟一次，搬旧 L5136-5139） ── */
    try {
      if (store.nextIdleAt === 0) store.setNextIdleAt(at + 15000);      // 旧 L5158 的首查延迟 15s
      if (at >= store.nextIdleAt) {
        report.checkedIdle = true;
        const [lo, hi] = resolveIdleIntervalMs(cfg);
        // 先把下一次排期写好（即使这轮什么都不做，也不会变成每 tick 都扫一遍全表）
        store.setNextIdleAt(at + lo + Math.floor((rand ? clamp01(rand()) : 0) * (hi - lo)));
        // ★ 2026-10-26（溟）：诊断写进状态盘，不写日志 —— 这个模块拿到的 logSink 只接单参，
        //   结构化字段会被静默丢掉（我先前加的两行 log 一条都没落盘）。
        //   ⚠️ 同一处还有个自己挖的坑：先前的扫描日志用了下面才声明的 groupOn/privateIdleOn，
        //      const 的 TDZ 让这一 tick 直接抛错、被上层 try/catch 吞掉 ⇒ 整个 idle 分支中断、
        //      抽样永不执行、probAttempts 永远是空的。所以这里只用内联取值，不引用后声明的变量。
        store.noteTick({
          branch: 'idle-enter', paused: rt.paused === true, nextIdleAt: store.nextIdleAt,
          privateIdleOn: cfgRead.get('proactive.privateIdleEnabled') === true,
          groupOn: cfgRead.get('proactive.enabled') === true
        });
        if (rt.paused) {
          // ★ T-PROACTIVE-OBS 补丁 B：**我侧预先拒绝**（还没调 wake 就放弃）⇒ 短退避，
          //   别让"paused 时什么也没做"吞掉一整个 30~90 分钟窗口（resume 后很快能补）。
          declineLocally(report, 'paused', at);
        } else {
          const picked = proactiveCandidates(cfg, chats, { now: at, running: rt.running });
          // ★ T-PROACTIVE-OBS：被拉黑的会话（invalid-chat-key 那种"根本发不出去"的）不进候选。
          const out = [];
          const skipped = [...picked.skipped];
          for (const key of picked.out) {
            if (store.isBlocked(key)) { skipped.push({ chatKey: key, why: 'blocked' }); continue; }
            out.push(key);
          }
          report.consideredCandidates = out.length;
          report.skippedCandidates = skipped.length;
          // ★ 光有"跳过了几个"排障时看不出**为什么**（同会话在跑 / 不够冷 / 零消息 / 被拉黑）。
          //   这里补一份带理由的明细（只有 chatKey 与 why，不含聊天正文）。
          report.skippedCandidateDetail = skipped.map((s) => ({ chatKey: s.chatKey, why: s.why }));
          const groupOn = cfgRead.get('proactive.enabled') === true;
          const privateIdleOn = cfgRead.get('proactive.privateIdleEnabled') === true;
          // 到这里才有 groupOn/privateIdleOn —— 上面的 noteTick 故意不引用它们（TDZ）。
          store.noteTick({
            branch: 'idle-scan', candidates: out.length, skipped: skipped.length,
            skippedDetail: skipped.slice(0, 3), groupOn, privateIdleOn, hasRandom: !!rand
          });
          if (out.length && (groupOn || privateIdleOn)) {
            if (rt.running.size >= Math.max(1, Number(cfgRead.get('maxConcurrentRuns')) || 2)) {
              declineLocally(report, 'concurrency-cap', at);   // ★ 瞬时 ⇒ 短退避
            } else if (!rand) {
              // ★ 没有注入随机源 ⇒ 不抽样、不唤轮（旧树这里用 Math.random，新树铁律禁止）
              fault('no-random-source', '需要 payload.clock.random 或 createProactive({random})');
              declineLocally(report, 'no-random-source', at);
            } else {
              // ★ N70：`Math.floor(clamp01(rand()) * out.length)` 在 rand() 恰好返回 1 时
              //   等于 out.length ⇒ 越界成 `undefined`（旧树用 Math.random() 永远 <1 所以没暴露；
              //   新树的随机源是**注入的**，测试桩/某些实现返回 1 完全合法）⇒ 显式夹到最后一项。
              const chatKey = out[Math.min(out.length - 1, Math.floor(clamp01(rand()) * out.length))];
              const isPrivate = String(chatKey).startsWith('private:');
              const baseProb = isPrivate
                ? resolveProbability(cfgRead.get('proactive.privateIdleProbability') ?? cfgRead.get('proactive.probability'))
                : resolveProbability(cfgRead.get('proactive.probability'));
              // ★ 2026-10-26（溟，她定的新玩法）：概率逐次递进 —— 基数 5%、每次没中 +20 个百分点。
              //   原来这里是固定 35%，掷不中就等下一个窗口，跟"越等越该中"的直觉相反。
              //   现在：第 n 次（n = 连续没中次数）的 prob = base + n × step，夹到 1。
              //   没中 ⇒ 计数 +1（存盘，重启不丢）；真的唤出去（delivered）⇒ 清零（她说的"发出来之后重置"）。
              const step = Math.max(0, Math.min(1, Number(cfgRead.get('proactive.probabilityStep')) || 0.2));
              const attempts = store.getProbAttempts(chatKey);
              const prob = Math.min(1, baseProb + step * attempts);
              report.probabilityAttempt = { chatKey, attempts, base: baseProb, step, prob };
              if (rand() > prob) {
                store.bumpProbAttempts(chatKey);
                declineLocally(report, 'probability-miss', at, { keepWindow: true });   // 没中就等下个半点，不提前重投
              } else if (typeof payload.wake !== 'function') {
                fault('no-wake', 'tick 载荷里没有 wake —— 不唤轮、不假装');
                report.errors.push('no-wake');
              } else {
                // ★ T-PROACTIVE-OBS：同样读返回值 + 按 reason 退避（这里是冷场路，**有** nextIdleAt 要推）。
                attachWakeOutcome(report, payload.wake({ chatKey, proactive: true, proactiveReason: 'idle' }), {
                  chatKey, via: 'idle', at, probability: prob, resetProbabilityOnDelivered: true
                });
                report.woken = { chatKey, reason: 'idle', probability: prob, pending: true };
                recordWake({ at, chatKey, reason: 'idle', result: 'pending', probability: prob });
              }
            }
          }
        }
      }
    } catch (error) {
      fault('idle-check-failed', error?.message ?? error);
      report.errors.push('idle-check-failed');
    }

    if (fired.length > 50) fired.splice(0, fired.length - 50);
    lastTick = report;
    return report;
  }

  /** 排障读数。**不含聊天正文**。 */
  function status() {
    return {
      ready: !!store,
      stateFile: store?.file ?? null,
      stateError: stateError ? { ...stateError } : null,
      state: store ? store.snapshot() : null,
      chatsInjected: !!(chats && typeof chats.listChats === 'function' && typeof chats.getChatMeta === 'function'),
      // ★ F4：接线探针可以直接断言这个，不必去 faults 里猜
      cfgShape: {
        kind: checkCfgShape(),
        knownKeys: [...CONFIG_KEYS],
        keys: Object.keys(cfgOf()).slice(0, 40)
      },
      randomSource: (typeof random === 'function') ? 'factory' : 'payload.clock',
      constants: { scheduleFiredLimit: SCHEDULE_FIRED_LIMIT, scheduleFiredKeep: SCHEDULE_FIRED_KEEP, defaultProbability: DEFAULT_PROBABILITY },
      faults: [...faults],
      recentWake: [...fired],
      /** 被拉黑的会话（invalid-chat-key 那种"根本发不出去"的）。 */
      blocked: store ? store.blockedList() : [],
      lastTick,
      knownTradeoffs: [
        '`recentWake` 记的是**真实结果**：pending → woken（真发出去）/ skipped（被 M15 闸门挡了，带 skipReason）/ finished（轮次跑完但没说话，如 COMPOSE_EMPTY）/ failed（wake reject）。',
        '★ `fault(\'wake-failed\')` **不覆盖跳过**：它只在 `wake()` 真的 reject 时触发（当前 M15 现实路径不 reject）。跳过走 `report.wokenSkipped` 与 `recentWake[].skipReason`。',
        '瞬时跳过（paused/chat-busy/chat-pending/concurrency-full）⇒ 短退避 60~180s；永久跳过（invalid-chat-key/aborted）⇒ 长退避 6h，且 invalid-chat-key 会把该会话**拉黑**（`status().blocked`）。',
        '私聊定时的去重键 = <chatId>|<HH:MM>|<日期>（旧树口径）；状态盘删掉/损坏 ⇒ 当天可能重发一次。',
        '定时命中但会话正在跑时，去重标记已先写入 ⇒ 当天不会再补打（旧 L5201-5210 的次序，照搬未改）。',
        '本模块主动轮只"起一轮让模型说话"，自己不发送任何文本；真要发只有 sendScheduled 一条路，而主动路径当前不经过它。'
      ],
      cfgKeys: (() => { const c = cfgOf(); return c && typeof c === 'object' ? Object.keys(c).sort() : []; })()
    };
  }

  return { onTick, status };
}

export default createProactive;