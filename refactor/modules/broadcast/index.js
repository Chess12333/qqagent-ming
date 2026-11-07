/**
 * M-broadcast · 定时文本广播（旧 `src/crazy-thursday.js` 的搬运，面板上叫「疯狂星期四」）
 *
 * 契约（指挥位定，2026-10-05）：
 *   createBroadcast({ dataDir, log, cfg }) -> Object.freeze({ onTick(now, {wake,status,sendScheduled}), status() })
 *   · **不起常驻定时器**：调度权在 M15 `runtime.onTick(now)`（应用层心跳每 5 秒喂一次）。
 *   · **发送只走 tick 载荷里的 `sendScheduled`**（不经模型的受控发送）：不 import M3/M10，
 *     不碰 `platform.sendTextBatch`。`delivered === true` 才算发出。
 *   · 只读配置，**绝不写 config.json**。
 *
 * 语义逐条照搬 `src/crazy-thursday.js`（旧行号写在对应位置，别自己简化）：
 *   ① 新键优先：`cfg.broadcastSchedules.items` 非空数组 ⇒ 只用它；否则由 legacy `cfg.crazyThursday`
 *      合成一条（旧 L93-135）。
 *   ② 总闸是真的：`broadcastSchedules.enabled === false` ⇒ 两条路径一律不发（旧 L110-119，
 *      记过"这个键全文件从不读"的哑配置坑）。
 *   ③ 槽位身份 = 它在配置数组里的下标，跨 tick 稳定（旧 L125-128 / L143-144）；"今天这条发过没"
 *      按 **槽位无关的 `dateKey|hhmm|gid`** 认（旧 L104 ⑤ 硬约束，`test/hooks-send-consumers-test.mjs:681`
 *      也硬编码了这个键形）。
 *   ④ 发送未确认送达 ⇒ 只有"零条被确认"进复探（同 key，最多 2 轮 / 30 分钟窗口 / 容量 256），
 *      其余一律**停手留档、绝不换 key 重发**（旧 L3-5 / L188-201 / L326-335）。
 *   ⑤ 认领推迟到"文案已就绪、真要发"这一刻，并与四张表复查原子进行；某条计划被拒时它的候选
 *      原样留给后面的计划（旧 N3：L234-242 / L269-297）。
 *   ⑥ 时刻按**分钟等值**匹配，绝不改成 `>=`（旧 L101 ②；否则重启会补发当天已过的档）。
 *   ⑦ `groupIds` 空 ⇒ 直接不发，**绝不回落全群广播**（旧 L103 ④）。
 *   ⑧ ★ 出站过聊天白名单闸（2026-10-11 新#4）：入站 allow 闸在 orchestrator 的准入循环，
 *      `sendScheduled` 一道都没有 ⇒ 广播（含复探补发）曾对白名单外的群照发。
 *      现在首发与复探**各自**过 `core/policy/allow-gate`（与入站同一判据本体，读注入 cfg 的活值）；
 *      判不过 ⇒ 记 stopped 留档 + 一条日志，**不发、不认领、不换 key**。
 *      fail-closed：cfg 读不到 allow 信息 ⇒ 不发（cfg 整体读不到时 readConfig 本来就不发）。
 *
 * ★ 与旧树的一处**语义收缩**（出口决定，不是偷懒）：旧代码能分辨"before-send 明确拦下"（可重试）
 *   与"结果不确定"（永不重试），因为它拿到的是分段 `{sent/blocked/failed}`；新出口只给
 *   `{ok, delivered, reasons, receipt}`。这里用 `receipt.coverage` 判："请求 N 条 / 回执 0 条"
 *   视作旧树的"整批被拦"⇒ 进复探；其余未送达 ⇒ 留档。
 *   ⇒ 复探**始终复用同一个 idempotencyKey**，而 M10 的 `sendIdempotency` 按 key 记忆回执
 *     （`modules/act/index.js:18/:483-485`）⇒ 复探不可能造成重复发，最坏是拿回同一条 memoized 回执。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/util/index.js';
import { allowGate } from '../../core/policy/allow-gate.js';
// ★ 这个 import **只作"无注入时的最后兜底"用**（见 readConfig 的优先级）：
//   `get()` 会触发 config-store 的**懒加载**，而它的 `DATA_DIR` 是**导入期求值**的常量 ⇒
//   在探针/自测这类"没人先 load() 过"的场合，它会读到**生产 data/**（2026-10-05 上午就是这条链
//   把用户的 config.json 改写了一次）。装配层传了 `cfg` 就**一个字都不碰它**
//   （自测的把关：开头 0a 先把 config-store 钉到空合成目录，8h/8h2/10a 再验"有注入 ⇒ 没被懒加载"）。
import { get as readLiveConfig } from '../../core/config-store/index.js';

// ── 旧常量逐字照搬 ────────────────────────────────────────────────────────
const SEND_RECOVERY_MAX_RETRIES = 2;          // src/send-recovery.js:7
const RECOVERY_MAX_AGE_MS = 30 * 60 * 1000;   // src/crazy-thursday.js:17
const MAX_PENDING_RECOVERIES = 256;           // src/crazy-thursday.js:15
const MAX_STOPPED_RECOVERIES = 256;           // src/crazy-thursday.js:16
const DEFAULT_TIMES = ['07:00', '13:00', '19:00'];   // src/crazy-thursday.js:89
const SCHEMA_VERSION = 1;
const FIRED_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;  // 状态文件里的 fired 只留 8 天（旧树是进程内 Set，不落盘）

/**
 * legacy/`mode:'llm'` 的内置提示词 —— **逐字照搬 src/crazy-thursday.js:56-71**。
 * 本模块不 import M4（依赖方向：不许碰兄弟模块），所以把提示词与清洗函数**导出**，
 * 由装配层注入 `genCopy` 时原样使用；不注入 ⇒ llm 计划整条跳过（见 status().copyMissing）。
 */
export function buildLlmCopyMessages(what) {
  const w = what || {};
  const sys = [
    '你是一个写文案的助手，不是任何群友、角色或虚拟形象。',
    '任务：写一段「疯狂星期四」群公告/玩梗文案。',
    '要求：',
    '1. 中文，长度大于100字，小于220字。',
    '2. 狂欢、安利肯德基疯狂星期四的氛围，可以玩梗，鼓励群友 V 我 50 一起去吃。',
    '3. 不要出现鲸鱼、小鲸鱼、DeepSeek、北极爷、管理员等任何机器人人设或内部梗。',
    '4. 口语、群聊感，像真人随手发的，不要书面腔、不要分点列提纲。',
    '5. 只输出正文，不要引号包裹，不要解释，不要标题。'
  ].join('\n');
  // 旧 L66-70：legacy 走这里时 prompt/templates 都是空 ⇒ 不追加任何东西
  const extra = [];
  if (Array.isArray(w.templates) && w.templates.length) extra.push(`额外风格要求：\n${w.templates.join('\n')}`);
  if (typeof w.prompt === 'string' && w.prompt.trim()) extra.push(w.prompt.trim());
  const sysFull = extra.length ? `${sys}\n${extra.join('\n')}` : sys;
  return {
    messages: [
      { role: 'system', content: sysFull },
      { role: 'user', content: '今天是星期四。请编一段疯狂星期四文案（>100字）。' }
    ],
    temperature: 0.95
  };
}

/** 模型输出的清洗（逐字照搬 src/crazy-thursday.js:80-84）。 */
export function normalizeCopyText(raw) {
  return String(raw || '')
    .replace(/^["'“”]|["'“”]$/g, '')
    .replace(/^(文案|标题)[:：]\s*/i, '')
    .replace(/^#+\s*/, '')
    .trim();
}

/**
 * 广播计划解析 —— **整函数逐字照搬** src/crazy-thursday.js:108-163（只把 `cfg` 变成入参）。
 */
export function resolveBroadcastPlans(cfg) {
  const items = cfg?.broadcastSchedules?.items;
  const bsEnabled = cfg?.broadcastSchedules?.enabled;
  if (bsEnabled === false) return [];   // 旧 L119：总闸关停 ⇒ 两条路径都不发
  if (!Array.isArray(items) || items.length === 0) {
    const ct = cfg?.crazyThursday || {};
    return [{
      legacy: true,
      id: 'legacy-crazy-thursday',
      slotIdx: 0,                        // 旧 L128：legacy 合成路径恒为 0
      enabled: ct.enabled !== false,
      days: [4],                         // 旧 L130：等价于改前的 now.getDay() !== 4
      times: (Array.isArray(ct.times) && ct.times.length) ? ct.times.map(String) : DEFAULT_TIMES.slice(),
      groupIds: Array.isArray(ct.groupIds) ? ct.groupIds : [],
      what: { mode: 'llm', texts: [], templates: [], prompt: null, minLength: 100 }
    }];
  }
  return items.map((it, i) => {
    const what = it?.what || {};
    const when = it?.when || {};
    return {
      legacy: false,
      id: String(it?.id ?? `item-${i}`),
      slotIdx: i,                        // 旧 L143-144：槽位身份 = 配置数组下标，跨 tick 稳定
      enabled: it?.enabled !== false,
      days: (Array.isArray(when.days) && when.days.length) ? when.days.map(Number) : [4],
      times: (Array.isArray(when.times) && when.times.length) ? when.times.map(String) : DEFAULT_TIMES.slice(),
      groupIds: Array.isArray(it?.where?.groupIds) ? it.where.groupIds : [],
      what: {
        mode: what.mode || 'llm',
        texts: Array.isArray(what.texts) ? what.texts : [],
        templates: Array.isArray(what.templates) ? what.templates : [],
        prompt: (typeof what.prompt === 'string') ? what.prompt : null,
        // 旧 L154-159：`0` 是显式设定（不设长度门）必须保留；null/''/NaN/负数 ⇒ 回落 100
        minLength: (typeof what.minLength === 'number' && Number.isFinite(what.minLength) && what.minLength >= 0)
          ? what.minLength
          : 100
      }
    };
  });
}

/**
 * 取配置。**优先级 = 注入优先**（指挥位 2026-10-05 令）：
 *   ① `cfg` 是访问器 `{ get(keyPath) }` ⇒ 逐键读（装配层给的就是这个形状，也是 config-store 的同一个模块实例）；
 *   ② `cfg` 是函数 ⇒ 调用它拿整份配置；
 *   ③ `cfg` 是原始配置对象 ⇒ 直接用（自测走这条，零外部依赖）；
 *   ④ **只有 `cfg` 没给（null/undefined）** ⇒ 才兜底用 config-store 的 `get()`，
 *      那会触发懒加载 ⇒ 顺带 warn 一次，免得排查时被"读到了生产 data/"打了个措手不及。
 * 任何一支读不动 ⇒ 返回 null ⇒ 本跳不发（fail-closed，不许猜默认值）。
 */
let warnedLiveConfig = false;
function readConfig(cfg, log = () => {}) {
  try {
    if (cfg && typeof cfg.get === 'function') {
      return {
        broadcastSchedules: cfg.get('broadcastSchedules') ?? null,
        crazyThursday: cfg.get('crazyThursday') ?? null
      };
    }
    if (typeof cfg === 'function') return cfg() || null;
    if (cfg && typeof cfg === 'object') return cfg;
    if (!warnedLiveConfig) {
      warnedLiveConfig = true;
      log('[broadcast] 没注入 cfg ⇒ 兜底走 config-store get()（会懒加载，导入期 DATA_DIR 已定 ⇒ 可能读生产 data/）');
    }
    return readLiveConfig() || null;
  } catch {
    return null;
  }
}

export function createBroadcast({ dataDir, log = console.log, cfg = null, genCopy = null } = {}) {
  // fail-closed：数据目录必须显式注入（不许默认落到仓库 data/）
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new Error('createBroadcast: dataDir 必须显式注入（非空字符串）—— 不许默认落到仓库 data/');
  }
  const dir = path.resolve(dataDir);
  const STATE_FILE = path.join(dir, 'broadcast-state.json');

  // 四张表：旧 src/crazy-thursday.js:11-14 的模块级 Set/Map，这里改成"每实例一份 + fired 落盘"
  const fired = new Map();              // key(`dateKey|hhmm|gid`) -> at
  const inFlight = new Set();
  const pendingRecoveries = new Map();
  const stoppedRecoveries = new Map();
  const copyRotate = {};                // 'plan<slotIdx>' -> 上次用过的下标（旧 L35/L52-54）
  let stateFault = null;                // 状态文件读不动的原因（不许当空库覆盖）
  let lastTickAt = 0;
  let lastFault = null;
  let copyMissing = 0;
  let sentCount = 0;
  let usesNewKey = false;               // 本跳走的是新键还是 legacy 兜底（给 status/UI 排查用）
  let gateClosed = false;               // 本跳总闸是否关停
  let configFault = false;              // 本跳配置读不到 ⇒ 没发（不是"没命中"）

  // ── 状态文件：读（fail-closed，照 modules/media/memes.js:21-35 的写法）──────
  function loadState() {
    let text;
    try {
      text = fs.readFileSync(STATE_FILE, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') { stateFault = null; return; }   // 真·没有状态文件，允许从空开始
      stateFault = String(error?.message ?? error);
      log(`[broadcast] 状态文件读不动 ⇒ 本实例停用广播（不许把"读不到"当"没发过"）: ${stateFault}`);
      return;
    }
    try {
      const parsed = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
      if (!parsed || typeof parsed !== 'object') throw new Error('broadcast-state.json 不是对象');
      if (parsed.schemaVersion !== SCHEMA_VERSION) throw new Error(`不认识 schemaVersion=${parsed.schemaVersion}`);
      if (!parsed.fired || typeof parsed.fired !== 'object') throw new Error('broadcast-state.json 里没有 fired 表');
      for (const [key, at] of Object.entries(parsed.fired)) fired.set(key, Number(at) || 0);
      if (parsed.copyRotate && typeof parsed.copyRotate === 'object') Object.assign(copyRotate, parsed.copyRotate);
      for (const [key, row] of Object.entries(
        (parsed.stopped && typeof parsed.stopped === 'object') ? parsed.stopped : {})) {
        stoppedRecoveries.set(key, row && typeof row === 'object' ? row : { reason: 'restored', at: 0 });
      }
      stateFault = null;
    } catch (error) {
      // 文件在但坏 ⇒ 记故障 + 停发；**绝不**当空库、绝不回写覆盖
      stateFault = String(error?.message ?? error);
      log(`[broadcast] 状态文件坏了 ⇒ 本实例停用广播（先备份/修文件）: ${stateFault}`);
    }
  }

  function saveState(now) {
    if (stateFault) return false;   // 读都读不动 ⇒ 更不许写（一写就把用户当天的状态覆盖没了）
    try {
      const firedOut = {};
      for (const [key, at] of fired) {
        if (now - at <= FIRED_RETENTION_MS) firedOut[key] = at;
      }
      const stoppedOut = {};
      let kept = 0;
      for (const [key, row] of [...stoppedRecoveries].reverse()) {   // 新的优先留
        if (kept >= MAX_STOPPED_RECOVERIES) break;
        // 陈旧留档也占容量：键里带日期，早过 8 天就再不会撞上 ⇒ 直接丢，别把 256 格占满
        if (now - (Number(row?.at) || 0) > FIRED_RETENTION_MS) continue;
        stoppedOut[key] = row; kept += 1;
      }
      writeJsonAtomic(STATE_FILE, {
        schemaVersion: SCHEMA_VERSION,
        fired: firedOut,
        copyRotate,
        stopped: stoppedOut,
        savedAt: now
      });
      return true;
    } catch (error) {
      lastFault = `写状态文件失败: ${error?.message ?? error}`;
      log(`[broadcast] ${lastFault}`);
      return false;
    }
  }

  loadState();

  // ── 小工具 ─────────────────────────────────────────────────────────────
  const firedKey = (dateKey, hhmm, gid) => `${dateKey}|${hhmm}|${gid}`;         // 旧 L104 ⑤ 键形
  const idemKeyOf = (slotIdx, dateKey, hhmm, gid) => `sched:broadcast:${slotIdx}:${dateKey}:${hhmm}:${gid}`;

  // ── 出站白名单闸（新#4，2026-10-11）──────────────────────────────────────
  /** 按注入 cfg 的三种形状逐键读（与 readConfig 的注入优先同款）；读不到 ⇒ undefined ⇒ allow-gate 默认拒。 */
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
  /** 这个会话现在可不可以出站（判据本体 = core/policy/allow-gate，与入站同一份）。 */
  function allowChatKey(chatKey) {
    const sep = String(chatKey ?? '').indexOf(':');
    const kind = sep > 0 ? String(chatKey).slice(0, sep) : '';
    const id = sep > 0 ? String(chatKey).slice(sep + 1) : '';
    if ((kind !== 'group' && kind !== 'private') || !id) return false;   // 认不出形状 ⇒ 不发（fail-closed）
    return allowGate(kind, id, allowReader);
  }

  function rememberStopped(key, reason, details = {}) {
    stoppedRecoveries.set(key, { reason, at: details.at || 0, ...details });
    while (stoppedRecoveries.size > MAX_STOPPED_RECOVERIES) {
      stoppedRecoveries.delete(stoppedRecoveries.keys().next().value);   // 旧 L346-348
    }
  }

  /** 按 what 出文案（旧 L44-55 的 fixed/list 分支；llm 分支必须靠注入的 genCopy）。 */
  async function makeCopy(what, now) {
    if (what.mode === 'fixed' || what.mode === 'list') {
      const pool = (Array.isArray(what.texts) && what.texts.length) ? what.texts.map(String) : [];
      if (!pool.length) return '';
      const slot = `plan${what.slotIdx ?? 0}`;
      copyRotate[slot] = ((copyRotate[slot] ?? -1) + 1) % pool.length;
      return pool[copyRotate[slot]];
    }
    if (typeof genCopy !== 'function') {
      copyMissing += 1;
      log('[broadcast] mode:llm 但没有装配层注入 genCopy ⇒ 这条计划跳过（绝不发半句、也不认领）。'
        + ' 请在 apps/server/assembly.js 里注入用 buildLlmCopyMessages/normalizeCopyText 的生成器。');
      return null;   // null = 没法出文案；空串('') 是"文案不合格"，两者都跳过但计数不同
    }
    const raw = await genCopy({ what, now });
    return normalizeCopyText(typeof raw === 'string' ? raw : raw?.text);
  }

  /** 一次 tick 的核心（旧 checkOnce L165-342）。
   *  ★ N40（2026-10-09 起，2026-10-10 收尾）：第三个参数 `report` 由 `onTick` 建好后传进来
   *    （只观察、不改任何发送判定）。未提交的半成品在这里引用了一个**不存在的** `report`
   *    ⇒ `ReferenceError: report is not defined`（selftest 直接红）。现在参数显式传入，
   *    且**每一条退出路径都 `lastReport = report; return report;`** —— 否则日志里照样有空白格。 */
  async function checkOnce(nowMs, payload, report) {
    const now = new Date(nowMs);
    const sendScheduled = payload?.sendScheduled;
    if (typeof sendScheduled !== 'function') {
      lastFault = 'tick 载荷里没有 sendScheduled ⇒ 广播不发送（接线缺口）';
      log(`[broadcast] ${lastFault}`);
      report.errors.push('no-send-scheduled');
      lastReport = report;
      return report;
    }
    if (stateFault) {
      // 状态读不动 ⇒ 一律不发；也要在报告里留一笔（只写原因，不写正文）
      report.errors.push(`state-fault: ${stateFault}`);
      lastReport = report;
      return report;
    }

    // ★ 次序（2026-10-11 指挥位批准的修正）：`readConfig` 必须**挡在复探循环之前**。
    //   原来复探先跑、配置后读（:305 vs :344）⇒ 配置读不到时复探照样发，是条 fail-open。
    //   现在配置读不到 ⇒ 本跳直接返回（含复探），fail-closed。
    const config = readConfig(cfg, log);
    if (!config) {
      configFault = true;
      lastFault = '配置读不到 ⇒ 本跳不发（fail-closed，不猜默认值）';
      log(`[broadcast] ${lastFault}`);
      lastReport = report;
      return report;
    }
    configFault = false;

    // ── 相零：复探队列（旧 L170-206：窗口 30 分钟、最多 2 轮、超了就停手留档）──
    for (const [key, recovery] of [...pendingRecoveries]) {
      if (inFlight.has(key)) continue;
      if (nowMs - recovery.createdAt > RECOVERY_MAX_AGE_MS) {
        pendingRecoveries.delete(key);
        rememberStopped(key, 'retry window expired', { at: nowMs, chatKey: recovery.chatKey });
        report.stopped.push({ chatKey: recovery.chatKey, why: 'retry-window-expired' });
        log(`[broadcast] 补发窗口已到，停止复探 ${recovery.chatKey}（同 key 最多 ${SEND_RECOVERY_MAX_RETRIES} 轮）`);
        continue;
      }
      inFlight.add(key);
      try {
        // ★ 新#4：复探再过一道白名单闸（与配置可读性无关的独立防线）。
        if (!allowChatKey(recovery.chatKey)) {
          pendingRecoveries.delete(key);
          rememberStopped(key, 'not allowlisted', { at: nowMs, chatKey: recovery.chatKey });
          report.stopped.push({ chatKey: recovery.chatKey, why: 'not-allowlisted' });
          log(`[broadcast] 复探目标不在白名单，停发 ${recovery.chatKey}（allow 闸）`);
          continue;
        }
        const out = await sendScheduled(recovery.chatKey, [recovery.text], { idempotencyKey: recovery.idempotencyKey });
        recovery.attempts += 1;
        if (out?.delivered === true) {
          pendingRecoveries.delete(key);
          fired.set(key, nowMs);
          sentCount += 1;
          saveState(nowMs);
          report.recovered.push({ chatKey: recovery.chatKey, attempts: recovery.attempts });
          log(`[broadcast] 复探确认已送达 ${recovery.chatKey}`);
        } else if (recovery.attempts >= SEND_RECOVERY_MAX_RETRIES) {
          pendingRecoveries.delete(key);
          rememberStopped(key, 'retry limit reached', { at: nowMs, chatKey: recovery.chatKey, reasons: out?.reasons || [] });
          report.stopped.push({ chatKey: recovery.chatKey, why: 'retry-limit-reached', attempts: recovery.attempts });
          log(`[broadcast] 停止复探 ${recovery.chatKey}：${SEND_RECOVERY_MAX_RETRIES} 轮仍未确认送达`);
        } else {
          report.keptRecovery.push({ chatKey: recovery.chatKey, attempts: recovery.attempts });
          log(`[broadcast] 复探仍未确认 ${recovery.chatKey}（第 ${recovery.attempts} 轮）: ${JSON.stringify(out?.reasons || [])}`);
        }
      } catch (error) {
        pendingRecoveries.delete(key);
        rememberStopped(key, `recovery failed: ${error?.message ?? error}`, { at: nowMs, chatKey: recovery.chatKey });
        report.stopped.push({ chatKey: recovery.chatKey, why: 'recovery-failed' });
        log(`[broadcast] 复探失败并停止 ${recovery.chatKey}: ${error?.message ?? error}`);
      } finally {
        inFlight.delete(key);
      }
    }

    usesNewKey = Array.isArray(config.broadcastSchedules?.items) && config.broadcastSchedules.items.length > 0;
    gateClosed = config.broadcastSchedules?.enabled === false;
    const plans = resolveBroadcastPlans(config);
    report.plansTotal = plans.length;
    report.gate = configFault ? 'fault' : gateClosed ? 'off' : 'on';
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const dateKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;   // 旧 L106 ⑦：月/日不补零

    // 旧 L217-223 H3：同一分钟同一群只准入第一个计划
    const claimedThisMinute = new Set();
    const activePlans = [];
    for (const plan of plans) {
      if (!plan.enabled) continue;
      if (!plan.days.includes(now.getDay())) continue;
      if (!plan.times.includes(hhmm)) continue;                    // 旧 L101 ②：分钟等值，绝不 >=
      const targets = plan.groupIds
        .map(String)
        .map((s) => s.trim())
        .filter((s) => /^\d{5,15}$/.test(s));                       // 旧 L229-232
      if (!targets.length) continue;                                // 旧 L103 ④：空 ⇒ 不发，绝不回落全群
      // 旧 L234-242 N3：相一**只筛候选、不认领**
      const pending = targets.filter((gid) => {
        const key = firedKey(dateKey, hhmm, gid);
        if (claimedThisMinute.has(key)) return false;
        if (!fired.has(key) && !inFlight.has(key)
          && !pendingRecoveries.has(key) && !stoppedRecoveries.has(key)) {
          // ★ 新#4：白名单外的群本条不发 —— 记 stopped 留档（下一 tick 静默），日志只打一次。
          if (!allowChatKey(`group:${gid}`)) {
            rememberStopped(key, 'not allowlisted', { at: nowMs, chatKey: `group:${gid}` });
            report.stopped.push({ chatKey: `group:${gid}`, why: 'not-allowlisted' });
            log(`[broadcast] 目标群 ${gid} 不在白名单，本条不发（allow 闸）`);
            return false;
          }
          return true;
        }
        return false;
      });
      if (!pending.length) continue;
      activePlans.push({ ...plan, targets, pending });
    }

    // 旧 L249-263 H2/N2/N5：总闸关停 / 命中但无目标 / 没命中 —— 三种日志必须分清
    if (gateClosed) {
      log(`[broadcast] broadcastSchedules.enabled === false ⇒ 总闸关停（${usesNewKey ? '新键' : 'legacy 兜底'}路径），本跳不发任何计划；这不是"没命中"。`);
      lastReport = report;
      return report;
    }
    if (usesNewKey) {
      // ★ 2026-10-11 sp4 修（隔离验证抓到）：原判据是"有计划命中 && activePlans 空"。
      //   发出后同一分钟里 fired 表挡掉所有群 ⇒ activePlans 空 ⇒ 原生条件成立 ⇒
      //   **每秒都打一句"groupIds 为空或全是非法群号"**——日志说谎（群号明明是好的，
      //   只是这一分钟发过了）。改成只认"真的没有合法群号"那一种情况；
      //   因去重而静默是正确的（分钟等值去重），不打日志。
      const hitNoGroupIds = plans.some((p) => {
        if (!p.enabled || !p.days.includes(now.getDay()) || !p.times.includes(hhmm)) return false;
        const targets = p.groupIds
          .map(String)
          .map((s) => s.trim())
          .filter((s) => /^\d{5,15}$/.test(s));
        return targets.length === 0;
      });
      if (hitNoGroupIds && !activePlans.length) {
        log('[broadcast] 已命中计划的星期/时刻，但 where.groupIds 为空或全是非法群号 ⇒ 本跳不发（去设置里填群号）');
      }
    }
    report.plansHit = activePlans.length;
    if (!activePlans.length) { lastReport = report; return report; }

    for (const plan of activePlans) {
      const what = { ...plan.what, slotIdx: plan.slotIdx };
      let text = '';
      try {
        const made = await makeCopy(what, nowMs);
        if (made === null) { report.skipped.push({ planId: plan.id, why: 'no-gen-copy' }); continue; }   // 没注入 genCopy ⇒ 不认领，后面的计划照常有机会
        text = made;
      } catch (error) {
        log(`[broadcast] 文案生成失败: ${error?.message ?? error}`);
        report.skipped.push({ planId: plan.id, why: 'copy-failed' });
        continue;                        // 旧 L279-281 N3：生成失败不认领
      }
      if (!text || text.length < what.minLength) {
        log(`[broadcast] 文案过短/为空跳过: ${String(text || '').length} ${JSON.stringify(String(text || '').slice(0, 40))}`);
        report.skipped.push({ planId: plan.id, why: 'copy-too-short', chars: String(text || '').length });
        continue;                        // 旧 L283-286 N3：文案被拒不认领
      }
      // 旧 L287-295 N3：认领 + 四张表复查，此刻做、且只在这一刻做
      const pending = plan.pending.filter((gid) => {
        const key = firedKey(dateKey, hhmm, gid);
        if (claimedThisMinute.has(key)) return false;
        if (fired.has(key) || inFlight.has(key) || pendingRecoveries.has(key) || stoppedRecoveries.has(key)) return false;
        return true;
      });
      if (!pending.length) continue;
      for (const gid of pending) claimedThisMinute.add(firedKey(dateKey, hhmm, gid));
      const attemptKeys = pending.map((gid) => firedKey(dateKey, hhmm, gid));
      for (const key of attemptKeys) inFlight.add(key);
      try {
        for (let i = 0; i < pending.length; i += 1) {
          const gid = pending[i];
          const key = attemptKeys[i];
          const chatKey = `group:${gid}`;
          try {
            const out = await sendScheduled(chatKey, [text], {
              idempotencyKey: idemKeyOf(plan.slotIdx, dateKey, hhmm, gid)
            });
            if (out?.delivered === true) {
              fired.set(key, nowMs);
              sentCount += 1;
              saveState(nowMs);
              log(`[broadcast] 已发 ${chatKey} (${text.length}字)`);
              report.sent.push({ chatKey, planId: plan.id, gid, chars: text.length });
            } else if (out?.receipt?.coverage && out.receipt.coverage.requestedCount > 0
              && Number(out.receipt.coverage.receiptCount) === 0) {
              // 零条被确认 = 旧树"整批被 before-send 拦下" ⇒ 保留复探（同 key，不会重复发）
              if (pendingRecoveries.size < MAX_PENDING_RECOVERIES) {
                pendingRecoveries.set(key, {
                  chatKey, text, attempts: 0, createdAt: nowMs,
                  idempotencyKey: idemKeyOf(plan.slotIdx, dateKey, hhmm, gid)
                });
                log(`[broadcast] 未送达，保留复探 ${chatKey}: ${JSON.stringify(out?.reasons || [])}`);
              } else {
                rememberStopped(key, 'recovery capacity reached', { at: nowMs, chatKey });
                log(`[broadcast] 复探队列已满，停止并留档 ${chatKey}`);
              }
            } else {
              // 其余一律"拿不准" ⇒ 停手留档，绝不换 key 重发（旧 L326-331）
              rememberStopped(key, out?.receipt?.error ? 'delivery uncertain' : 'no delivery confirmed',
                { at: nowMs, chatKey, reasons: out?.reasons || [] });
              log(`[broadcast] 未确认送达 ${chatKey} ⇒ 留档不重发: ${JSON.stringify(out?.reasons || [])}`);
              saveState(nowMs);
            }
          } catch (error) {
            // 旧 L332-335：抛异常的发送可能已经到达对端 ⇒ 不自动重发
            rememberStopped(key, `delivery uncertain: ${error?.message ?? error}`, { at: nowMs, chatKey });
            log(`[broadcast] 发送结果不确定 ${chatKey}，不自动重发: ${error?.message ?? error}`);
            saveState(nowMs);
          }
        }
      } finally {
        for (const key of attemptKeys) inFlight.delete(key);
      }
    }
    lastReport = report;      // ★ 正常走完这一跳也要留报告（否则面板/日志只看到 early-exit）
    return report;
  }

  let ticking = null;
  /**
   * ★ N40（2026-10-09）：`onTick` 原来**返回 undefined**（照老树 `checkOnce`，它只 log）。
   * 但同一棵树里 `proactive.onTick` / `reminders.onTick` 都返回结构化报告，而编排层
   * `orchestrator/index.js:2523` 是把三个 tick 的返回值汇进日志的 ⇒ 广播这一路在日志里**永远空白**，
   * 面板上"定时广播到底发没发/为什么没发"查不到。
   * ⇒ 这里补一份**纯增量**的报告：只观察、不改任何发送判定（老树的去重/闸门/认领次序一个字没动）。
   */
  function newReport(nowMs) {
    return {
      now: nowMs,
      gate: 'unknown',          // 'off'（总闸关）/ 'fault'（配置读不到）/ 'on'
      plansTotal: 0,
      plansHit: 0,              // 命中星期+时刻的计划数
      sent: [],                  // [{chatKey, planId, gid, chars}]
      recovered: [],             // 复探确认送达的
      keptRecovery: [],          // 未确认 ⇒ 留档不重发
      stopped: [],               // 复探窗口/容量到头 ⇒ 停止
      skipped: [],               // [{why, ...}]：被去重/闸门/文案过短挡下
      errors: []
    };
  }
  let lastReport = null;

  async function onTick(now, payload = {}) {
    const nowMs = Number(now);
    // ★ N40：本跳的报告（只观察，不改判定）
    const report = newReport(Number.isFinite(nowMs) ? nowMs : null);
    if (!Number.isFinite(nowMs)) throw new Error('broadcast.onTick(now): 必须是有限数字（时间由调用方给）');
    lastTickAt = nowMs;
    // 应用层 5 秒一喂，发送没回来时不许同 tick 重入（旧树靠 setTimeout 串行，这里靠这把锁）
    if (ticking) return ticking;
    ticking = checkOnce(nowMs, payload, report).finally(() => { ticking = null; });
    return ticking;
  }

  function status() {
    return {
      stateFile: STATE_FILE,
      stateFault,
      usesNewKey,
      gateClosed,
      configFault,
      lastTickAt,
      lastFault,
      lastReport,
      sentCount,
      copyMissing,
      fired: fired.size,
      pending: [...pendingRecoveries].map(([key, r]) => ({
        key, chatKey: r.chatKey, attempts: r.attempts, ageMs: Math.max(0, lastTickAt - r.createdAt)
      })),
      stopped: [...stoppedRecoveries].slice(-20).map(([key, row]) => ({ key, ...row }))
    };
  }

  return Object.freeze({ onTick, status, internals: Object.freeze({
    fired, inFlight, pendingRecoveries, stoppedRecoveries, copyRotate, STATE_FILE
  }) });
}
