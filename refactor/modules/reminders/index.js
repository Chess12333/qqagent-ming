// 提醒链（闹钟/计时）—— 从旧树搬成一个独立模块。
//
// 搬的是两处（行号指 `src/` 盘面，2026-10-04）：
//   · 存档层 `src/reminders.js:29-100` 的 `ReminderStore`
//     （add / pending / due / markAttempted / markFired / cancel / prune）
//   · 触发状态机 `src/orchestrator.js`：
//       `startReminderLoop` L4847-4883（**去掉自带的 setTimeout**，调度权归 M15 心跳）
//       `#isReminderStale`      L4891-4906
//       `#stopReminderRetry`    L4909-4917
//       `#advanceReminder`      L4924-4976
//       销档规则常量 + `reminderDeliveryAction` L5928-5979
//
// ★ 盘上形状与旧树**逐字一致**（数据兼容红线）：文件名 `reminders.json`、顶层 `{reminders:[...]}`、
//   条目字段 `id/chatKey/text/dueAt/createdAt/createdBy/fired` + 可选 `firedAt/attemptedAt`、
//   id 前缀 `r_` + base36 时间戳 + 6 位 hex 随机、序列化缩进 1 空格。
//   ⇒ 老实例写的存档能被本模块直接读 vice versa，不做迁移。
//
// ★ 与旧树**故意不同**的三处（都是"从默默降级改成明面失败"，回执里逐条登记）：
//   ① 存档读坏 ⇒ **不再当空库**。旧 `load()`（src/reminders.js:14-20）catch 住 JSON.parse
//      错误返回 `[]`，随后任何一次 save 都会把用户的提醒整体覆盖写没。这里改成
//      fail-closed：标记存档损坏、拒绝一切写入、`status()` 如实报、tick 不发任何东西。
//   ② 调度器不再自己 `setTimeout`（旧 L4876/L4878）。到点判定只用注入的 `now`；
//      "下一次什么时候被叫醒"由 M15 `runtime.onTick(now)` + 应用层 5s 心跳决定。
//   ③ 发送只走 tick 载荷里的 `sendScheduled`，不经模型、不 import M10/M3。
//
// 不变量（承接旧树专门修过的坑，见 §2 语义重点）：
//   · **只有"全部段确认送达"才 markFired** —— 本模块只发一段，`delivered === true` 才销档。
//   · 未确认送达 ⇒ 不销档、留档；明证被 before-send 拦下 ⇒ 按退避重试；
//     **结果不确定 ⇒ 停手留档**，绝不说"将在下一轮重试"。
//   · `markAttempted` **先落盘再触碰发送路径**。
//   · 过期闸只用**落盘字段** + 内存态，不依赖进程内存（重启安全）。
//   · 会话 key 非法 ⇒ 停重试 + 留档，**绝不静默 markFired**。
//
// 零兄弟模块依赖：只用 node:fs / node:path / node:crypto + `core/policy/allow-gate`（纯函数、零 import、无 IO）。
// 不许 import M10/M3/observability。
//
// ★ 新#4（2026-10-11）：出站补一道聊天白名单闸 —— 入站 allow 闸在 orchestrator 准入循环，
//   `sendScheduled` 没有闸 ⇒ 白名单关掉后提醒照发。现在 advance() 在触碰发送路径前过
//   与入站同一判据本体（allow-gate）；cfg 未注入（仅自测/探针，装配层必注入）⇒ 按旧行为发送，
//   cfg 在但判不过 ⇒ 按 blocked 口径走既有退避阶梯（≤3 轮 / ≈14 分钟后 stop 留档，不无限重试）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// ★ N93：原子写收口（modules/broadcast 已在用；这里把 reminders 的 tmp+rename 也并进来）
import { writeJsonAtomic } from '../../core/util/index.js';
import { allowGate } from '../../core/policy/allow-gate.js';

/* ───────────────────────── 销档规则常量（搬 src/orchestrator.js:5934-5950） ───────────────────────── */

/** 单条提醒最多补发 3 轮。1 次首发 + 2 次同轮补发 + 3 次跨 tick 补发 = 上界 6 次。 */
export const REMINDER_DELIVERY_MAX_ROUNDS = 3;
/** 退避阶梯 60s → 180s → 600s。60s 起跳是限频窗口（sender 的 60000ms + maxPerMinute）；合计 840s ≈ 14 分钟。 */
export const REMINDER_DELIVERY_BACKOFF_MS = [60000, 180000, 600000];
/** 到期后 60 分钟仍未确认送达 ⇒ 不再自动补发（只在存档里留着，不记成"已提醒"）。 */
export const REMINDER_DELIVERY_STALE_MS = 60 * 60 * 1000;
/** 从未尝试发送的提醒允许在到期后 24 小时内做一次尽力投递。 */
export const UNATTEMPTED_STALE_MS = 24 * 60 * 60 * 1000;

/** 提醒正文前缀（旧树原文，照抄：用户在群里一眼认出这是提醒）。 */
export const REMINDER_PREFIX = '⏰ 提醒：';
/** 存档文件名 —— 数据兼容红线，不许改。 */
export const REMINDER_FILE_NAME = 'reminders.json';

/** 存档损坏/写入失败专用错误。调用点可以按 `err.code` 分流。 */
export class ReminderStoreError extends Error {
  constructor(message, code = 'reminder-store-error') {
    super(message);
    this.name = 'ReminderStoreError';
    this.code = code;
  }
}

/* ───────────────────────── 纯判定（搬 src/orchestrator.js:5957-5979） ───────────────────────── */

/**
 * 纯判定：这一条提醒现在该「销档 / 继续补发 / 停手留档」。
 * 逐字搬旧树的判据（这是旧树 P0-1 修出来的，不能简化）：
 *   blocked>0 → 还有"明证没发出去"的段 ⇒ retry（未到轮数上限）/ stop（到上限）
 *   failed>0  → 结果不确定，**永不自动重发**（可能已经落进群里）
 *   sent>0    → fire（全部段确认发出）
 *   其它      → stop（旧代码这里会 markFired，属于把没发说成发了）
 */
export function reminderDeliveryAction(state = {}) {
  const sentCount = Math.max(0, Number(state.sentCount) || 0);
  const blockedCount = Math.max(0, Number(state.blockedCount) || 0);
  const failedCount = Math.max(0, Number(state.failedCount) || 0);
  const rounds = Math.max(0, Number(state.rounds) || 0);
  if (blockedCount > 0) {
    if (rounds < REMINDER_DELIVERY_MAX_ROUNDS) {
      const uncertainNote = failedCount > 0 ? `；另有 ${failedCount} 段结果不确定，不重发` : '';
      return { action: 'retry', reason: `仍有 ${blockedCount} 段被 before-send 拦下，按退避只补发这些段${uncertainNote}` };
    }
    const uncertainNote = failedCount > 0 ? `；另有 ${failedCount} 段结果不确定，不重发` : '';
    return { action: 'stop', reason: `补发已到 ${rounds} 轮上限仍有 ${blockedCount} 段被拦，停止自动重试${uncertainNote}` };
  }
  if (failedCount > 0) {
    return { action: 'stop', reason: `有 ${failedCount} 段结果不确定（可能已送达），不自动重发以免重复提醒` };
  }
  if (sentCount > 0) return { action: 'fire', reason: '全部段都已确认发出' };
  return { action: 'stop', reason: '没有任何一段被确认发出，且没有可补发的被拦段，停止自动重试' };
}

/**
 * 把 `sendScheduled` 的返回收敛成三态：**delivered / blocked / uncertain**。
 *
 * ★ 为什么必须有这一步：`sendScheduled` 只给 `{ok, delivered, reasons, receipt}`，
 *   没有"这段到底发出去没有"的字段。而旧树的分段恢复（`src/send-recovery.js`）是靠
 *   `sender.sendTextBatch` 的 `{sent, blocked, failed}` 三桶区分的。本模块经 M15 出口发，
 *   拿不到那三桶 —— 于是只能按"**明证**"原则分级：
 *   · `delivered === true`                        → delivered（唯一可销档的证据）
 *   · 返回形状不对 / 抛错 / 有 failed 类证据        → uncertain（停手留档，绝不重发）
 *   · `delivered !== true` 且 `ok === false` 且 reasons 明说是 before-send 拦下 → blocked（可退避重试）
 * 判据刻意保守：把 uncertain 当 blocked 就会重复提醒（旧树 2026-09 那次事故的根因）；
 * 把 blocked 当 uncertain 只会少发一次并留档 —— 后者安全，所以这是有意的偏向。
 */
const BLOCK_MARKERS = /(before[-_ ]?send|blocked|拦下|拦截|hook|forbidden|拒绝发送|禁发)/i;
const FAILED_MARKERS = /(fail|failed|timeout|timed out|error|exception|超时|失败|异常|不确定|网络|ECONN|ETIMEDOUT|socket)/i;

export function classifyDelivery(result) {
  if (!result || typeof result !== 'object') {
    return { state: 'uncertain', reason: 'sendScheduled 没有给出任何投递结论' };
  }
  if (result.delivered === true) {
    return { state: 'delivered', reason: '回执确认送达（delivered===true）' };
  }
  const reasons = (Array.isArray(result.reasons) ? result.reasons : [])
    .map((r) => String(r ?? '')).filter(Boolean);
  const haystack = reasons.join(' | ');
  if (FAILED_MARKERS.test(haystack)) {
    return { state: 'uncertain', reason: `结果不确定（可能已送达），不自动重发：${haystack.slice(0, 160)}` };
  }
  if (result.ok === false && reasons.length && BLOCK_MARKERS.test(haystack)) {
    return { state: 'blocked', reason: `被 before-send 明证拦下（未送达，可安全补发）：${haystack.slice(0, 160)}` };
  }
  if (result.ok === false && !reasons.length) {
    return { state: 'uncertain', reason: '发送返回 ok=false 且没给原因，按不确定处理（宁可不发也不重复）' };
  }
  return { state: 'uncertain', reason: `未确认送达且无法判定原因（delivered=${String(result.delivered)} ok=${String(result.ok)}）` };
}

/** 会话 key 合法性：必须是 `group:<id>` 或 `private:<id>`（旧树 #advanceReminder L4926-4932 的同一判据）。 */
export function isValidChatKey(chatKey) {
  const raw = String(chatKey ?? '');
  const parts = raw.split(':');
  if (parts.length !== 2) return false;
  const [kind, id] = parts;
  return (kind === 'group' || kind === 'private') && !!id;
}

/* ───────────────────────── 存档层（搬 src/reminders.js:29-100 + fail-closed） ───────────────────────── */

/**
 * 存档。盘上形状与旧树逐字一致；**唯一的行为改动**是读坏时不再当空库。
 */
export class ReminderStore {
  /**
   * @param {{dataDir:string, log?:Function}} opts dataDir 必填（不注入就抛，绝不猜仓库 data/）
   */
  constructor({ dataDir, log = () => {} } = {}) {
    const dir = String(dataDir ?? '');
    if (!dir) throw new ReminderStoreError('ReminderStore 需要显式 dataDir（本模块不猜仓库 data/）', 'no-data-dir');
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, REMINDER_FILE_NAME);
    this.log = log;
    this.corrupt = null;               // {message, at} —— 一旦置上，所有写入被拒
    this.reminders = this.#load();
  }

  #load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];          // 新实例第一次用：空库是合法的
      this.corrupt = { message: `读取失败：${String(error?.message ?? error).slice(0, 200)}`, at: Date.now() };
      throw new ReminderStoreError(`reminders.json 读取失败（拒绝当空库）：${this.corrupt.message}`, 'unreadable');
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.reminders)) {
        throw new Error('顶层不是 {reminders:[…]}');
      }
      return parsed.reminders;
    } catch (error) {
      // ★ fail-closed：旧实现在这里 return []，下一次 save 就把用户的提醒整体覆盖写没。
      this.corrupt = { message: `解析失败：${String(error?.message ?? error).slice(0, 200)}`, at: Date.now() };
      throw new ReminderStoreError(
        `reminders.json 已损坏，拒绝当空库、拒绝覆盖写：${this.corrupt.message}`, 'corrupt');
    }
  }

  /** 原子写（N93：统一走 core/util.writeJsonAtomic；与旧树一致）。存档损坏时**抛**，绝不覆盖。 */
  save() {
    if (this.corrupt) {
      throw new ReminderStoreError(`存档已损坏（${this.corrupt.message}），拒绝覆盖写；请人工修好 ${this.file}`, 'corrupt');
    }
    // ★ N93：tm+rename 统一收口到 core/util.writeJsonAtomic（失败会自己清 tmp）。
    //   ★★ `indent: 1` 是**显式传的**：该函数默认紧凑输出，不传就等于把 reminders.json
    //     整体重写字节（盘上兼容红线：老实例/老包读的就是缩进 1 的这份）。
    try {
      writeJsonAtomic(this.file, { reminders: this.reminders }, { indent: 1 });
    } catch (error) {
      throw new ReminderStoreError(`写 reminders.json 失败：${String(error?.message ?? error).slice(0, 200)}`, 'write-failed');
    }
    return true;
  }

  /** 新增一条提醒。返回该提醒（字段与旧树一字不差）。 */
  add({ chatKey, text, dueAt, createdBy = '' } = {}) {
    const at = Number(dueAt);
    if (!Number.isFinite(at) || at <= 0) {
      // 旧实现在这里是 `dueAt: Number(dueAt)`，NaN 会被 JSON.stringify 成 null，
      // 写出一条永远到不了点、也永远不会被过期闸清掉的僵尸提醒。改成当场拒。
      throw new ReminderStoreError(`set_reminder 需要可用的 dueAt（收到 ${JSON.stringify(dueAt)}）`, 'bad-due-at');
    }
    const entry = {
      id: `r_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
      chatKey: String(chatKey),
      text: String(text ?? '').trim(),
      dueAt: at,
      createdAt: Date.now(),
      createdBy: String(createdBy ?? ''),
      fired: false
    };
    this.reminders.push(entry);
    this.save();
    return entry;
  }

  /** 列出未触发的提醒（可按会话过滤），按到期时间升序。 */
  pending(chatKey = null) {
    return this.reminders
      .filter((r) => !r.fired && (!chatKey || r.chatKey === chatKey))
      .sort((a, b) => a.dueAt - b.dueAt);
  }

  /** 到点且未触发的提醒。 */
  due(now = Date.now()) {
    const at = Number(now);
    return this.reminders.filter((r) => !r.fired && Number(r.dueAt) <= at);
  }

  /** 记录"已进入发送尝试"（落盘）。重复调用保留首次时间。 */
  markAttempted(id, at = Date.now()) {
    const r = this.reminders.find((x) => x.id === id);
    const attemptedAt = Number(at);
    if (!r || !Number.isFinite(attemptedAt) || attemptedAt <= 0) return false;
    if (Number.isFinite(Number(r.attemptedAt)) && Number(r.attemptedAt) > 0) return true;
    r.attemptedAt = attemptedAt;
    this.save();
    return true;
  }

  /** 标记已触发（落盘）。at 可注入（默认墙钟；旧树固定用 Date.now()）。 */
  markFired(id, at = Date.now()) {
    const r = this.reminders.find((x) => x.id === id);
    if (!r) return false;
    r.fired = true;
    r.firedAt = Number(at) || Date.now();
    this.save();
    return true;
  }

  /** 按 id 取消。 */
  cancel(id) {
    const before = this.reminders.length;
    this.reminders = this.reminders.filter((x) => x.id !== id);
    if (this.reminders.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  /** 清理已触发很久的旧提醒（保留最近 200 条已触发的，防文件无限增长）。 */
  prune() {
    const fired = this.reminders.filter((r) => r.fired).sort((a, b) => (b.firedAt || 0) - (a.firedAt || 0));
    const pending = this.reminders.filter((r) => !r.fired);
    if (fired.length > 200) {
      this.reminders = [...pending, ...fired.slice(0, 200)];
      this.save();
      return true;
    }
    return false;
  }

  /** 只读快照（给 status/UI；不含正文）。 */
  summary() {
    const fired = this.reminders.filter((r) => r.fired).length;
    return {
      file: this.file,
      total: this.reminders.length,
      fired,
      pending: this.reminders.length - fired,
      corrupt: this.corrupt ? { ...this.corrupt } : null
    };
  }
}

/* ───────────────────────── 触发状态机（搬 orchestrator L4847-4976，去掉自带计时器） ───────────────────────── */

/**
 * 工厂。**dataDir 必填**（不注入就抛：绝不猜仓库 `data/`，那是真实聊天数据所在）。
 * @param {{dataDir:string, log?:Function, cfg?:object}} opts
 * @returns {{onTick:Function, add:Function, pending:Function, due:Function, cancel:Function, status:Function}}
 */
export function createReminders({ dataDir, log = () => {}, cfg = null } = {}) {
  // ★ 缺 dataDir 是**装配层编程错误**，当场抛（fail fast）：悄悄建一个"永远不提醒也不报错"的实例
  //   比启动失败坏得多 —— 到点不提醒没人会发现。
  //   （数据损坏是另一回事，走下面的 storeError 软路径，不炸装配层。）
  if (!String(dataDir ?? '')) {
    throw new ReminderStoreError('createReminders 需要显式 dataDir（本模块不猜仓库 data/，那是真实聊天数据所在）', 'no-data-dir');
  }
  const recoveries = new Map();      // id → {rounds, nextAt, stopped, reason, staleLogged}
  const firing = new Set();          // 本轮正在处理的 id（防重入）
  let lastTick = null;
  let store = null;
  let storeError = null;

  const say = (msg) => { try { log(msg); } catch { /* 日志不许反噬 */ } };

  // ── 出站白名单闸（新#4）：判据本体与入站同一份（core/policy/allow-gate），读注入 cfg 的活值 ──
  function allowReader(keyPath) {
    try {
      const c = typeof cfg === 'function' ? cfg() : cfg;
      if (c && typeof c.get === 'function') {
        const v = c.get(keyPath, undefined);
        if (v !== undefined) return v;
      }
      let cur = c;
      for (const seg of String(keyPath).split('.')) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[seg];
      }
      return cur === undefined ? undefined : cur;
    } catch { return undefined; }
  }
  function allowChatKey(chatKey) {
    const [kind, id] = String(chatKey ?? '').split(':');
    if ((kind !== 'group' && kind !== 'private') || !id) return false;   // 认不出形状 ⇒ 不发（fail-closed）
    return allowGate(kind, id, allowReader);
  }

  // 构造期就把存档读出来。读坏 ⇒ 记进 storeError 并**保持 store=null**：
  // 此时任何写操作都不许发生（没有 store 就写不了），tick 也不发任何东西。
  try {
    store = new ReminderStore({ dataDir, log: say });
  } catch (error) {
    storeError = { message: String(error?.message ?? error), code: error?.code ?? 'store-error', at: Date.now() };
    say(`[reminders] 存档不可用，本实例不发送任何提醒：${storeError.message}`);
  }

  const stateOf = (id) => {
    const hit = recoveries.get(id);
    if (hit) return hit;
    const fresh = { rounds: 0, nextAt: 0, stopped: false, reason: '', staleLogged: false, sentOnce: false };
    recoveries.set(id, fresh);
    return fresh;
  };

  /** 停止自动重试并留档（不销档：档还在，人工/下轮对话能看到它没送达）。搬 L4909-4917。 */
  function stopRetry(r, reason) {
    const state = stateOf(r.id);
    state.stopped = true;
    state.reason = String(reason || '').slice(0, 240);
    say(`[reminders] 停止自动重试（${r.chatKey} / ${r.id}）：${state.reason}`);
    return state;
  }

  /**
   * 过期太久就不再自动补发。搬 L4891-4906。
   * 为什么需要这道闸：不销档的提醒会一直留在 reminders.json 里，而"停止重试"的标记只在内存 ——
   * 进程一重启，一条永远发不出去的提醒就又拿到一份补发预算。dueAt/attemptedAt 都是**已落盘**字段，
   * 拿它们做时效闸就是重启安全的：把"每重启一次就重打一遍"封在一个有限窗口里。
   */
  function isStale(r, now) {
    const dueAt = Number(r?.dueAt);
    if (!Number.isFinite(dueAt) || dueAt <= 0) return false;   // 到期时间不可信 → 不当过期，宁可多发一次也不误杀
    const state = stateOf(r.id);
    const attemptedAt = Number(r?.attemptedAt);
    const attempted = (Number.isFinite(attemptedAt) && attemptedAt > 0)
      || state.sentOnce === true || state.reason !== '' || state.stopped === true || (Number(state.rounds) || 0) > 0;
    const staleAfterMs = attempted ? REMINDER_DELIVERY_STALE_MS : UNATTEMPTED_STALE_MS;
    if (now - dueAt <= staleAfterMs) return false;
    if (!state.staleLogged) {
      state.staleLogged = true;
      say(`[reminders] 已过期 ${Math.round((now - dueAt) / 60000)} 分钟仍未确认送达（${r.chatKey} / ${r.id}）：`
        + `不再自动补发，这条提醒留在存档里等人工处理（没有记成"已提醒"）`);
    }
    return true;
  }

  /**
   * 推进一条提醒的投递。搬 L4924-4976，发送出口换成 `sendScheduled`。
   * @returns {Promise<{action:'fire'|'retry'|'stop', id:string, reason:string, delivery?:object}>}
   */
  async function advance(r, state, sendScheduled, now) {
    const chatKey = String(r.chatKey || '');
    // 非法会话 key：发不出去，重试也重试不出来。旧实现在这里静默 return 后被 markFired ——
    // 等于把一条从没送达的提醒记成"已提醒"。现在不销档，只留档。
    if (!isValidChatKey(chatKey)) {
      stopRetry(r, `会话 key 非法（${chatKey}），提醒无法发送`);
      return { action: 'stop', id: r.id, reason: `会话 key 非法（${chatKey}）` };
    }
    // ★ 先持久写入 attempt marker 再触碰发送路径：重启后仍能区分"试过"与"从未试过"。
    //   旧树这里是 `markAttempted(...) === false → throw`（L4935-4938），照搬。
    if (typeof store?.markAttempted === 'function' && store.markAttempted(r.id, now) === false) {
      throw new Error('无法持久记录提醒发送尝试');
    }

    // ★ 新#4：出站白名单闸 —— 判不过就完全不碰 sendScheduled；按 blocked 口径走既有退避阶梯
    //   （白名单可能很快恢复；≤3 轮 / ≈14 分钟后 stop 留档，不无限重试、不虚增"发送尝试"）。
    if (cfg != null && !allowChatKey(chatKey)) {
      if (state.sentOnce) state.rounds = (Number(state.rounds) || 0) + 1;
      else state.sentOnce = true;
      const decision = reminderDeliveryAction({ blockedCount: 1, rounds: state.rounds });
      if (decision.action === 'retry') {
        state.nextAt = now + REMINDER_DELIVERY_BACKOFF_MS[Math.min(state.rounds, REMINDER_DELIVERY_BACKOFF_MS.length - 1)];
        state.stopped = false;
        state.reason = `白名单外，不发送：${decision.reason}`;
        say(`[reminders] ${chatKey} / ${r.id} 不在白名单，不发送`
          + `（第 ${state.rounds + 1}/${REMINDER_DELIVERY_MAX_ROUNDS} 次判定，${Math.round((state.nextAt - now) / 1000)} 秒后重判）`);
        return { action: 'retry', id: r.id, reason: state.reason };
      }
      stopRetry(r, `白名单外，不发送（${decision.reason}）`);
      return { action: 'stop', id: r.id, reason: `白名单外，不发送（${decision.reason}）` };
    }

    // 唯一的合法发送出口：tick 载荷里的 sendScheduled（不经模型）。稳定 idempotencyKey ⇒
    // M10 按 key 记忆回执，重试不会重复发（最多一次）。
    let result;
    try {
      result = await sendScheduled(chatKey, [`${REMINDER_PREFIX}${r.text}`], {
        idempotencyKey: `sched:reminder:${r.id}`,
        action: 'scheduled-send'
      });
    } catch (error) {
      // 抛错 = 结果不确定：可能已经落进群里，重发就是重复提醒。停手 + 留档。
      const reason = `发送抛错，结果不确定（${String(error?.message ?? error).slice(0, 160)}）`;
      stopRetry(r, reason);
      return { action: 'stop', id: r.id, reason };
    }

    // ★ 复刻旧树的轮次计数口径（L4939-4954）：**补发轮次在"进入补发路径"时 +1，首发那轮是 0**。
    //   旧树靠 send-recovery 的 retryBlockedOnce 去 +1；本模块不经那条链，自己记。
    //   计数错位会让退避阶梯整体错一格、并让轮数上限形同虚设，所以这里显式写出来。
    if (state.sentOnce) state.rounds = (Number(state.rounds) || 0) + 1;
    else state.sentOnce = true;

    const delivery = classifyDelivery(result);
    const decision = reminderDeliveryAction({
      sentCount: delivery.state === 'delivered' ? 1 : 0,
      blockedCount: delivery.state === 'blocked' ? 1 : 0,
      failedCount: delivery.state === 'uncertain' ? 1 : 0,
      rounds: state.rounds
    });

    if (decision.action === 'fire') {
      // 只有"全部段确认送达"才走到这一行（本模块只发一段 ⇒ delivered 即可）。
      recoveries.delete(r.id);
      store.markFired(r.id, now);
      return { action: 'fire', id: r.id, reason: decision.reason, delivery };
    }
    if (decision.action === 'retry') {
      const rounds = state.rounds;
      // ★ 用注入的 now，不用 Date.now()：退避排期必须与调用方给的时钟同源 ——
      //   否则注入时钟与墙钟一漂就排错，测试也无法确定性断言退避阶梯。
      state.nextAt = now + REMINDER_DELIVERY_BACKOFF_MS[Math.min(rounds, REMINDER_DELIVERY_BACKOFF_MS.length - 1)];
      state.stopped = false;
      state.reason = decision.reason;
      say(`[reminders] 未完全送达（${chatKey} / ${r.id}）：${decision.reason}`
        + `（第 ${rounds + 1}/${REMINDER_DELIVERY_MAX_ROUNDS} 轮补发排在 ${Math.round((state.nextAt - Date.now()) / 1000)} 秒后）`);
      return { action: 'retry', id: r.id, reason: decision.reason, delivery };
    }
    stopRetry(r, decision.reason);
    return { action: 'stop', id: r.id, reason: decision.reason, delivery };
  }

  /**
   * 唯一驱动入口。由 M15 `runtime.onTick(now)` 每 5 秒喂一次；**本模块自己不计时**。
   * @param {number} now 注入的当前时间（毫秒）
   * @param {{wake?:Function, status?:Function, sendScheduled?:Function}} payload
   * @returns {Promise<object>} tick 报告（同步返回不可能，因为发送是异步的）
   */
  async function onTick(now, payload = {}) {
    const at = Number(now);
    // ★ 严格判时间：`Number(null)===0`、`Number('')===0` 都是"有限数"，直接放行会把
    //   null/空串当成"1970 年"静默跑一轮（proactive 那边的自测先抓到了这个缺口，两边口径一致）。
    const timeUsable = (typeof now === 'number' && Number.isFinite(now))
      || (typeof now === 'string' && now.trim() !== '' && Number.isFinite(at));
    const report = {
      now: Number.isFinite(at) ? at : null, considered: 0, fired: [], retried: [],
      stopped: [], stale: [], skipped: [], errors: []
    };
    if (!timeUsable || !Number.isFinite(at)) {
      report.errors.push('onTick(now) 需要有限的注入时间（null/空串不算）');
      lastTick = report;
      return report;
    }
    if (!store) {
      // fail-closed：存档读坏时**一条都不发**（宁可到点不提醒，也不覆盖写掉用户的提醒）。
      report.errors.push(`store-unavailable: ${storeError?.message ?? 'unknown'}`);
      lastTick = report;
      return report;
    }
    const sendScheduled = payload?.sendScheduled;
    if (typeof sendScheduled !== 'function') {
      report.errors.push('tick 载荷里没有 sendScheduled —— 本模块不碰 platform/M10，不会退化到别的发送路径');
      lastTick = report;
      return report;
    }

    let dueList;
    try {
      dueList = store.due(at);
    } catch (error) {
      report.errors.push(`due() 失败：${String(error?.message ?? error).slice(0, 160)}`);
      lastTick = report;
      return report;
    }
    report.considered = dueList.length;

    for (const r of dueList) {
      if (firing.has(r.id)) { report.skipped.push({ id: r.id, why: 'in-flight' }); continue; }
      const state = stateOf(r.id);
      if (state.stopped) { report.skipped.push({ id: r.id, why: 'stopped', reason: state.reason }); continue; }
      if (state.nextAt && at < state.nextAt) { report.skipped.push({ id: r.id, why: 'backoff', nextAt: state.nextAt }); continue; }
      if (isStale(r, at)) { report.stale.push({ id: r.id }); continue; }
      firing.add(r.id);
      try {
        const out = await advance(r, state, sendScheduled, at);
        if (out.action === 'fire') report.fired.push({ id: r.id, chatKey: r.chatKey, reason: out.reason });
        else if (out.action === 'retry') report.retried.push({ id: r.id, chatKey: r.chatKey, reason: out.reason, nextAt: state.nextAt });
        else report.stopped.push({ id: r.id, chatKey: r.chatKey, reason: out.reason });
      } catch (error) {
        // 走到这里 = 存档写失败之类 ⇒ 结果不确定 ⇒ 停手 + 留档，绝不再说"将在下一轮重试"。
        stopRetry(r, `处理中抛错，结果不确定（${String(error?.message ?? error).slice(0, 160)}）`);
        report.stopped.push({ id: r.id, chatKey: r.chatKey, reason: 'processing-threw' });
        report.errors.push(`${r.id}: ${String(error?.message ?? error).slice(0, 160)}`);
      } finally {
        firing.delete(r.id);
      }
    }

    if (dueList.length) {
      try { store.prune(); } catch (error) { report.errors.push(`prune 失败：${String(error?.message ?? error).slice(0, 160)}`); }
    }
    lastTick = report;
    return report;
  }

  /** 新增一条提醒（模型 set_reminder 的落点）。 */
  function add(input) {
    if (!store) throw new ReminderStoreError(`存档不可用，拒绝新增：${storeError?.message ?? 'unknown'}`, storeError?.code ?? 'store-error');
    return store.add(input);
  }

  /** 列出未触发提醒（按到期升序）。 */
  function pending(chatKey = null) {
    if (!store) return [];
    return store.pending(chatKey);
  }

  /** 到点且未触发的提醒。 */
  function due(now = Date.now()) {
    if (!store) return [];
    return store.due(now);
  }

  /** 取消一条（按 id）。 */
  function cancel(id) {
    if (!store) return false;
    return store.cancel(id);
  }

  /**
   * 现状读数。**不含提醒正文**（正文是用户内容，不进诊断面）；只给计数、id、chatKey、停手原因。
   * 旧树没有 status()，这是新增的排障面。
   */
  function status() {
    return {
      ready: !!store,
      dataDir: store?.dir ?? (dataDir ? path.resolve(dataDir) : null),
      storeError: storeError ? { ...storeError } : null,
      store: store ? store.summary() : null,
      recoveries: [...recoveries.entries()].map(([id, s]) => ({
        id, rounds: s.rounds, nextAt: s.nextAt || 0, stopped: s.stopped === true,
        reason: String(s.reason || '').slice(0, 240), staleLogged: s.staleLogged === true
      })),
      inFlight: [...firing],
      lastTick,
      constants: {
        maxRounds: REMINDER_DELIVERY_MAX_ROUNDS,
        backoffMs: [...REMINDER_DELIVERY_BACKOFF_MS],
        staleMs: REMINDER_DELIVERY_STALE_MS,
        unattemptedStaleMs: UNATTEMPTED_STALE_MS
      },
      cfgKeys: cfg && typeof cfg === 'object' ? Object.keys(cfg).sort() : []
    };
  }

  return { onTick, add, pending, due, cancel, status };
}

export default createReminders;