import fs from 'node:fs';
import path from 'node:path';
import { createSessionRegistry, deriveOutcomes, sessionFile } from '../../modules/sessions/index.js';
import { parseSelfImpressions, renderSelfImpressions } from '../../modules/act/index.js';
import { createJudgeLedgerIndex } from './judge-ledger-index.js';

/**
 * refactor/apps/server/console-api.js — 控制台后端接口
 *
 * 只做 IO/接线，不做决定。每个接口指向真实数据源；
 * 能力未就绪的回 501 not-ported，绝不返回空数组假装"没有数据"。
 */
import { resolveDataDir } from './paths.js';
import { makePriceOf, createPriceCache, costOfRows, readUsageLedgerWithMeta, usageWindowCoverage, peakCalendarFor } from './api/console.js';
// ★ N57（2026-10-09）：回收站清扫器与 topicStore 探测的唯一实现在 S1 分片。
//   与本文件已有的 `./api/console.js` 同方向（console-api → api/*），不新增耦合。
import { pickTopicStore, armCleanupSweeper } from './api/shell.js';

/**
 * ★ N33（2026-10-09）：情绪目录/标签的**唯一真相源改成 `modules/emotion`**，不再在本文件抄一份。
 *
 * 背景（N30 回执 §四.1 第 2 条点名的项，属 apps/server 域）：
 *   本文件原来**硬抄**了一份 14 条 `EMOTION_CATALOG`，另有 `EMOTION_AFFECT_LABEL` **只 6 条**
 *   ⇒ 新树那 16 个 affect 键里有 10 个在面板上**显示裸英文 key**（`pride` / `smug` / `shame`…）。
 *   而 bunny2 的 N30 已经在 `modules/emotion/catalog.js` 备好了 `EMOTIONS` / `EMO_KEYS` /
 *   `EMO_PLAIN` / `CAT_LABEL` / `SIGN_LABEL`（照老树 `src/bot-state.js:37-52,59-74` 搬的）。
 *   ⇒ 两份目录迟早分叉。现在统一读模块的；模块缺出口时才回落到下面这份**兜底**（仅保命）。
 */
const EMOTION_CATALOG_FALLBACK = Object.freeze({
  anger: { halfLifeMin: 6, label: '愤怒', cat: 'out', sign: 'neg' },
  irk: { halfLifeMin: 5, label: '烦躁', cat: 'out', sign: 'neg' },
  joy: { halfLifeMin: 18, label: '喜悦', cat: 'out', sign: 'pos' },
  cheer: { halfLifeMin: 15, label: '开心', cat: 'out', sign: 'pos' },
  pride: { halfLifeMin: 20, label: '自豪', cat: 'out', sign: 'pos' },
  smug: { halfLifeMin: 18, label: '得意', cat: 'out', sign: 'pos' },
  gratitude: { halfLifeMin: 18, label: '感激', cat: 'out', sign: 'pos' },
  anxiety: { halfLifeMin: 12, label: '焦虑', cat: 'in', sign: 'neg' },
  sadness: { halfLifeMin: 22, label: '悲伤', cat: 'in', sign: 'neg' },
  shame: { halfLifeMin: 15, label: '羞耻', cat: 'in', sign: 'neg' },
  loneliness: { halfLifeMin: 25, label: '孤独', cat: 'in', sign: 'neg' },
  down: { halfLifeMin: 20, label: '低落', cat: 'in', sign: 'neg' },
  boredom: { halfLifeMin: 15, label: '无聊', cat: 'in', sign: 'neg' },
  curiosity: { halfLifeMin: 12, label: '好奇', cat: 'neu', sign: 'neu' }
});
const EMOTION_CAT_LABEL = Object.freeze({ out: '向外', in: '向内', neu: '中性' });
const EMOTION_SIGN_LABEL = Object.freeze({ pos: '正性', neg: '负性', neu: '中性' });
/** 老树 `src/bot-state.js:29` 的 14 条目录键；`joy/sadness/loneliness/anxiety` 是旧 UI 直接读的那 4 条。 */
const LEGACY_UI_EMOTION_KEYS = Object.freeze(['joy', 'sadness', 'loneliness', 'anxiety']);
/** 新树把老树的 `irk`/`cheer` 另起名叫 `irritation`/`excitement`（state.js:15 `EMOTION_ALIASES`）——面板两套名都得能显示。 */
const AFFECT_ALIAS_LABEL = Object.freeze({ irritation: '烦躁', excitement: '开心' });

/**
 * 从模块拿情绪视图原料；模块没带 catalog 出口时回落到兜底表（只保命，不当真相源）。
 * @param {object} emotion `ctx.modulesObj.emotion`
 */
function emotionView(emotion) {
  const catalog = (emotion && typeof emotion.EMOTIONS === 'object' && emotion.EMOTIONS)
    ? emotion.EMOTIONS : EMOTION_CATALOG_FALLBACK;
  const keys = (Array.isArray(emotion?.EMO_KEYS) && emotion.EMO_KEYS.length)
    ? emotion.EMO_KEYS : Object.keys(catalog);
  const catLabel = emotion?.CAT_LABEL || EMOTION_CAT_LABEL;
  const signLabel = emotion?.SIGN_LABEL || EMOTION_SIGN_LABEL;
  return { catalog, keys, catLabel, signLabel };
}

/** 某个 affect 键的中文 label：先查老树目录（含别名归一），再查别名表，最后退回裸 key。 */
function affectLabel(catalog, key) {
  if (catalog[key]?.label) return catalog[key].label;
  const aliasKey = key === 'irritation' ? 'irk' : key === 'excitement' ? 'cheer' : null;
  if (aliasKey && catalog[aliasKey]?.label) return catalog[aliasKey].label;
  return AFFECT_ALIAS_LABEL[key] || key;
}

// ── 工具 ─────────────────────────────────────────────────────────────────

function json(status, obj) {
  const body = JSON.stringify(obj, null, 2);
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(body)) },
    body
  };
}

function notPorted(what) {
  return json(501, { ok: false, error: `not-ported: ${what}` });
}

function errorResponse(e) {
  return json(500, { ok: false, error: String(e?.message ?? e) });
}

/** 从 ctx.modules 取模块（兼容 Map 和对象两种形态） */
function getMod(ctx, name) {
  if (ctx?.modulesObj?.[name]) return ctx.modulesObj[name];
  const mods = ctx?.modules;
  if (!mods) return null;
  if (typeof mods.get === 'function') return mods.get('modules/' + name) ?? mods.get(name) ?? null;
  return mods[name] ?? null;
}

/**
 * 最近接话判定（`/api/status.replyGate.recentDecisions`）—— **UI 的唯一数据源**。
 *
 * 为什么住在这里（2026-10-05 指挥位补）：UI 的面板读的是
 * `(s.replyGate?.recentDecisions || [])`（`refactor/apps/ui/app.js:4335`），而本文件的 `replyGate`
 * 一直是**写死的 `null`** ⇒ 面板永远显示"还没有新的路由记录"。
 * 后果不是"少个面板"，而是**主人看不出它为什么不说话**：档位门把消息拦下时（主人报的"仅@的群还一直说"），
 * 盘上有账、日志有行，UI 里却一片空白 —— 跟我们没修好时长得一模一样。
 *
 * 口径：订阅观测总线的 `plan:decided`（M8 每次"放行/沉默"决定都会发，含档位抑制那条），
 * 在内存里留最近 `RING` 条，`/api/status` 只回最近 8 条给 UI（UI 自己也会 `slice(-8)`）。
 * 只留**判定元数据**：不放聊天正文（与 UI 那句"不含聊天正文"的承诺一致）。
 * 总线没接上（老装配/自测夹具）⇒ 回空数组，**不回 null**（UI 那边 `null?.recentDecisions` 也安全，
 * 但空数组更诚实：真的没有决定，而不是"这个接口没做"）。
 */
const DECISION_RING = 32;
const decisionFeed = [];
let decisionFeedBound = null;

function ensureDecisionFeed(ctx) {
  const obs = ctx?.obs;
  if (!obs || typeof obs.on !== 'function') return;
  if (decisionFeedBound === obs) return;      // 同一个 obs 只订一次（自测会换 ctx）
  decisionFeedBound = obs;
  const push = (row) => {
    if (!row || typeof row !== 'object') return;
    // 只收**判定**行（有 decision 或 reasonCode）：`plan:decided` 还有另一种产者
    // （`orchestrator/index.js:482` 的 `{chatKey, roundId, action, reason}`），
    // 那种行没有判定语义，混进面板会显示成"未放行"（误导主人），这里挡掉。
    if (row.decision == null && row.reasonCode == null) return;
    const at = Number(row.at) || Date.now();
    decisionFeed.push({
      at,
      chatKey: String(row.chatKey ?? ''),
      // UI 的 `laneNames` / `sourceNames` / `reasonNames` 是词表；这里只**透传**，
      // 缺就是不写（让 UI 的空值兜底去处理，不替它编一个来源）。
      lane: row.lane == null ? '' : String(row.lane),
      source: row.source == null ? '' : String(row.source),
      // 旧树两处产者字段名不同（`reasonCode` / `reason`），都认。
      reasonCode: String(row.reasonCode ?? row.reason ?? ''),
      decision: row.decision == null ? '' : String(row.decision),
      authority: row.authority == null ? '' : String(row.authority),
      messageCount: Number.isFinite(Number(row.messageCount)) ? Number(row.messageCount) : null,
      tier: Number.isFinite(Number(row.tier)) ? Number(row.tier) : null
    });
    if (decisionFeed.length > DECISION_RING) decisionFeed.splice(0, decisionFeed.length - DECISION_RING);
  };
  try { obs.on('plan:decided', push); } catch { /* 观测不许反噬接口 */ }
  try { obs.on('wake:suppressed', push); } catch { /* 同上（这条只在没有 plan:decided 的产者上兜底） */ }
}

function recentDecisions(ctx) {
  ensureDecisionFeed(ctx);
  return decisionFeed.slice(-8);
}

// ── SnowLuma 进程探活（W-3c 2026-10-07，主人报的第 6 条「启动了但显示未运行」）────────
//
// ★ 这是**全树唯一**的"在不在跑"判定实现：别的地方（api/shell.js 的 launch/stop、
//   modules/snowluma 的 launch 内部）只用各自的口径做事，不再各自写一份状态。
//
// 改前的事实（读码 + 活体只读实测，见回执 .tmp-dispatch/r-w3c-雪鹭进程.md）：
//   · 旧块写死 `running: null` ⇒ UI apps/ui/app.js:5886 `!!(null) = false` → :5956 恒显示「未运行」；
//   · 而当时 SnowLuma 进程活着、3010/3011/5101 三个端口全通 ⇒ **面板说没跑，实际在跑**。
//   · `modules/snowluma` 只给了 `status() = {embedded, pid}`（index.js:230-231，纯内存句柄，
//     独立窗口模式 pid=null）和 `isPortOpen`（index.js:187-204，但只被 launch() :259/:265 用）。
//   · 今天**没有任何只读端点**能读到 status() —— 只有 POST /api/snowluma/stop（要杀进程）才回 pid。
//
// 探法（两条，都 read-only，不发信号、不改盘）：
//   ① TCP 端口：ws 端口取配置 `snowluma.wsUrl`（★ 模块没被 configure 过时它自己的 cfg 是空的、
//      wsPort() 会退回 3001 —— 线上配的是 3011，所以必须以配置为准，模块值只作兜底）+ webui 端口；
//   ② 内嵌 pid 存活：`process.kill(pid, 0)`（只探测不投递信号；ESRCH 才算死，EPERM = 活着但没权限）。
//
// 五态（`state`）与面板文案的对应（**UI 不许改，故只写 UI 已有的两个槽位**）：
//   running      端口通                → running=true  → 「运行中」（app.js:5956）
//   starting     pid 活、端口没通      → running=true  → 「运行中」+ ⚠ 顶栏横幅「起了但未就绪…」（app.js:1540）
//   dead         pid 在但已死          → running=false → 「未运行」+ ⚠ 「起了又死了…」
//   not_running  都没有                → running=false → 「未运行」
//   unknown      探不到（模块没注入/探活抛错）→ running=null → 与改前同义：**没查过，不编数**
//
// 面板自刷新不靠人工点：app.js:5055-5060 每 4s（refreshIntervalMs 默认 4000）重拉本接口，
// 启动/关闭按钮后另有 2.5s 定时重拉（app.js:6017）。

/** 端口探测超时。面板每 4s 轮询一次，探活必须比这快一个量级；连接被拒在本机是即时返回。 */
const SNOWLUMA_PROBE_TIMEOUT_MS = 300;

/** 从 ws/http url 里取端口；取不到回 fallback（不猜 3001，猜错就是"探了别人的端口"）。 */
function portFromUrl(raw, fallback) {
  try {
    const u = new URL(String(raw ?? ''));
    return u.port ? Number(u.port) : fallback;
  } catch { return fallback; }
}

/**
 * SnowLuma 真状态。任何一步失败都不许冒成"未运行"——探不到就 running=null + warning 写明原因。
 * @returns {Promise<{dir:string, running:boolean|null, state:string, embedded:boolean, pid:number|null,
 *   webuiUrl:string, warning:string, whitelist:string[], probe:object|null, unported?:string}>}
 */
async function snowlumaRuntimeStatus(ctx, configStore) {
  const dir = configStore?.get?.('snowluma.dir', '') || '';
  const whitelist = (configStore?.get?.('snowluma.accountWhitelist', []) || []).map(String);
  const mod = getMod(ctx, 'snowluma');
  const base = { dir, running: null, state: 'unknown', embedded: false, pid: null, webuiUrl: '', warning: '', whitelist, probe: null };
  if (!mod || typeof mod.status !== 'function') {
    return { ...base, unported: 'not-ported: ctx.modules.snowluma 未注入（running=null = 没查过，不是没在跑）' };
  }

  // ① 内嵌句柄（内存态；独立窗口模式恒 null）
  let st = null;
  try { st = mod.status(); } catch { st = null; }
  const pid = Number(st?.pid) || null;
  const embedded = !!st?.embedded;
  let pidAlive = null;
  if (pid) {
    try { process.kill(pid, 0); pidAlive = true; }
    catch (error) { pidAlive = error?.code === 'EPERM'; }   // EPERM = 进程在，只是没权限；只有 ESRCH 才是死了
  }

  // ② 端口（并行，各 300ms 上限）
  const wsPort = portFromUrl(configStore?.get?.('snowluma.wsUrl', ''), 0)
    || (typeof mod.wsPort === 'function' ? Number(mod.wsPort()) || 0 : 0);
  let webuiPort = 0;
  try { webuiPort = typeof mod.webuiPort === 'function' ? Number(mod.webuiPort()) || 0 : 0; } catch { webuiPort = 0; }
  const probePort = typeof mod.isPortOpen === 'function'
    ? (p) => Promise.resolve(mod.isPortOpen('127.0.0.1', p, SNOWLUMA_PROBE_TIMEOUT_MS))
    : null;
  let wsOpen = false;
  let webuiOpen = false;
  let probeError = '';
  const probeAt = Date.now();
  if (probePort && (wsPort || webuiPort)) {
    try {
      const [a, b] = await Promise.all([
        wsPort ? probePort(wsPort).catch(() => false) : Promise.resolve(false),
        webuiPort ? probePort(webuiPort).catch(() => false) : Promise.resolve(false)
      ]);
      wsOpen = a === true;
      webuiOpen = b === true;
    } catch (error) { probeError = String(error?.message ?? error); }
  } else if (!probePort) {
    probeError = 'modules/snowluma.isPortOpen 不可用（模块导出缺了）';
  } else {
    probeError = '拿不到待探端口（snowluma.wsUrl 为空且 webuiPort=0）';
  }

  const portOpen = wsOpen || webuiOpen;
  const ports = [wsPort && `ws:${wsPort}`, webuiPort && `webui:${webuiPort}`].filter(Boolean).join(' ') || '无';
  let state;
  let running;
  let warning = '';
  if (portOpen) {
    state = 'running';
    running = true;
  } else if (pid && pidAlive) {
    state = 'starting';
    running = true;
    warning = `起了但未就绪：SnowLuma 进程还在（pid=${pid}），但端口还没监听（${ports}）`;
  } else if (pid && pidAlive === false) {
    state = 'dead';
    running = false;
    warning = `起了又死了：SnowLuma 进程 pid=${pid} 已退出，端口未监听（${ports}）；详细日志见「SnowLuma」页运行日志`;
  } else if (probeError) {
    state = 'unknown';
    running = null;
    warning = `SnowLuma 状态没查到（这不等于没在跑）：${probeError}`;
  } else {
    state = 'not_running';
    running = false;
  }

  let webuiUrl = '';
  try { webuiUrl = typeof mod.webuiUrl === 'function' ? String(mod.webuiUrl() || '') : ''; } catch { webuiUrl = ''; }

  return {
    dir, running, state, embedded, pid, webuiUrl, warning, whitelist,
    probe: { wsPort, webuiPort, wsOpen, webuiOpen, pidAlive, timeoutMs: SNOWLUMA_PROBE_TIMEOUT_MS, at: probeAt, tookMs: Date.now() - probeAt }
  };
}

// ── P0 首屏接口 ──────────────────────────────────────────────────────────

/**
 * usage 行里某个数字**是否真的被报告**（★ 2026-10-17）：`0` 是合法读数，缺键不是。
 * 生产者（glm2 的写入点）只在拿得到有限非负数时才落键 ⇒ 键缺失 = 未报告，不许当 0。
 */
function usageNumberReported(value) {
  return value !== null && value !== undefined && value !== ''
    && typeof value !== 'boolean' && Number.isFinite(Number(value)) && Number(value) >= 0;
}

/** usage 行的时刻：数字 / Date / ISO 字符串都认（解析不出返回 null，不按当前时间猜）。 */
function usageAtMs(value) {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) && t > 0 ? t : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const s = String(value ?? '').trim();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** usage 行的用途标签；**没有/空** ⇒ ''（历史行一律 unknown，绝不反推成主请求）。 */
function usagePurposeOf(row) {
  return String(row?.purpose ?? '').trim();
}

/**
 * GET /api/status — 轮询就绪度（pollUntilReady 的唯一依赖）
 * 旧树返回 onebot/snowluma/orchestrator/usage/cost 等。
 * 新树按实际可用能力返回，缺失的字段给 null（UI 有防御性检查）。
 */
export async function getStatus(ctx) {
  const onebot = ctx?.onebot;
  const obs = ctx?.obs;
  const configStore = ctx?.configStore;
  const runtime = ctx?.runtime;

  // ── onebot（真数据）──
  const onebotStatus = {
    connected: onebot?.connected ?? null,
    everConnected: onebot?.client?.everConnected ?? null,
    error: onebot?.client?.lastConnectError || '',
    warning: '',
    self: onebot?.client?.selfInfo ? {
      userId: onebot.client.selfInfo.user_id,
      nickname: onebot.client.selfInfo.nickname
    } : null
  };
  if (!onebot) {
    onebotStatus.connected = null;
    onebotStatus.everConnected = null;
    onebotStatus.unported = 'not-ported: onebot（M3 未注入）';
  }

  // ── snowluma（W-3c：真探活，见上面 snowlumaRuntimeStatus 的实现说明）──
  // ★ 旧实现是写死 `running: null` + `unported` ⇒ UI 恒显示「未运行」，哪怕进程活着、端口全通。
  //   现在 running 是真布尔（探不到才回 null），四态原因走 `state` / `warning`（UI 读 warning 画顶栏）。
  const snowlumaStatus = await snowlumaRuntimeStatus(ctx, configStore);

  // ── orchestrator（ctx.runtime.status()）──
  let orchStatus;
  if (runtime?.status) {
    try {
      const st = runtime.status();
      orchStatus = {
        running: st?.running ?? [],
        pending: st?.pending ?? [],
        paused: st?.paused ?? null,
        pauseReason: st?.pauseReason ?? null
      };
    } catch {
      orchStatus = { running: null, pending: null, paused: null, pauseReason: null, unported: 'not-ported: runtime.status() 抛错' };
    }
  } else {
    orchStatus = { running: null, pending: null, paused: null, pauseReason: null, unported: 'not-ported: ctx.runtime（M15 未起）' };
  }

  // ── usage / cost / cacheHitRate（M2 usage 台账 + 共享计价口径）──
  let usageStatus = null;
  let cost = null;
  let cacheHitRate = null;
  // ★ 2026-10-17（用户 70% 读数口径）：主模型缓存率与覆盖单独成数；综合 `cacheHitRate` 保持原语义。
  let mainCacheHitRate = null;
  let cacheUsageCoverage = null;
  let webSearchCount = null;
  if (obs?.recent) {
    try {
      // ★ 2026-10-17：读台账优先 recentWithMeta（与用量页共用 readUsageLedgerWithMeta）。
      //   原实现 obs.recent({name:'usage',n:5000}) 会被 sink 静默钳到 2000 且**哨不出**——
      //   现在 meta 里 requested/limit/returned/字节预算/坏行如实带出，行数打满与读取中途截断
      //   （字节预算/IO/超大行/坏行）分开评价；meta 缺失（回退旧 recent）⇒ readIncomplete=null。
      const { rows: rawUsageRows, meta: readMeta } = await readUsageLedgerWithMeta(obs, 5000);
      if (!Array.isArray(rawUsageRows)) throw new Error('usage-ledger-not-array');
      const list = rawUsageRows;
      // ★ 2026-10-16（调试清零）：顶栏与用量页共用**同一条持久边界** —— 清零后从边界重新累计、
      //   重启不复活；边界 `invalid`/`unreadable` 时行原样保留、状态如实带出（不许静默当"没边界"）。
      let scopedList = list;
      let resetBoundary = { state: 'absent', at: null, atIso: null, reason: '' };
      if (typeof obs.usageRowsSinceReset === 'function') {
        try {
          const scoped = await obs.usageRowsSinceReset(list);
          if (scoped && Array.isArray(scoped.rows) && scoped.boundary) {
            scopedList = scoped.rows;
            resetBoundary = scoped.boundary;
          }
        } catch {
          resetBoundary = { state: 'unavailable', at: null, atIso: null, reason: 'reset-boundary-read-failed' };
        }
      }
      // 本地自然日过滤（今天）
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      // 有效窗口起点 = 今天零点与清零边界的较晚者（边界之前的行本来就不计入，不算"被截"）。
      const effectiveStart = resetBoundary.state === 'ok' && Number.isFinite(Number(resetBoundary.at))
        ? Math.max(midnight.getTime(), Number(resetBoundary.at)) : midnight.getTime();
      // ★ 2026-10-17：`at` 解析不出的行不再无声并不"0 消费"——单独计未归属行
      //   （这些行**可能属于今天**；boundary=ok 时行已被 reset 滤走 ⇒ 只报 boundary 的
      //   droppedUnknownAt 数量，token 拿不到就 null，不编）。
      let unattributedCalls = 0;
      let unattributedTokens = 0;
      let unattributedLocalCount = 0;
      let oldestValidAt = null;
      const todayRows = [];
      for (const r of scopedList) {
        // ★ 2026-10-17：时刻解析与计价同源（数字/ISO 都认）。
        const ms = usageAtMs(r?.at);
        if (ms == null) {
          unattributedCalls += 1;
          unattributedLocalCount += 1;
          unattributedTokens += (Number(r?.promptTokens) || 0) + (Number(r?.completionTokens) || 0);
          continue;
        }
        if (oldestValidAt == null || ms < oldestValidAt) oldestValidAt = ms;
        const d = new Date(ms);
        if (`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === todayStr) {
          todayRows.push(r);
        }
      }
      if (resetBoundary.state === 'ok' && Number(resetBoundary.droppedUnknownAt || 0) > unattributedCalls) {
        unattributedCalls = Number(resetBoundary.droppedUnknownAt);
        unattributedTokens = null;   // 边界滤走的行拿不到 token —— 数量如实报，token 不编
      }
      // 读取覆盖：行数上限截窗（rowCapHit）与读取中途截断（readIncomplete）分开评价；
      // 窗口级覆盖读数与 /api/usage/stats 用**同一份判据**（usageWindowCoverage）。
      const statusCoverage = usageWindowCoverage({
        rowsLength: list.length, oldestValidAt, readMeta, requested: 5000, effectiveStart
      });
      const coverage = statusCoverage.dataCoverage;   // 含 windowStart / rowCapHit / readIncomplete
      const windowComplete = coverage.rowCapHit !== true
        && coverage.readIncomplete !== true
        && !(unattributedCalls > 0);
      let promptTokens = 0, completionTokens = 0, cachedTokens = 0, calls = 0;
      for (const r of todayRows) {
        promptTokens += Number(r?.promptTokens || 0);
        completionTokens += Number(r?.completionTokens || 0);
        cachedTokens += Number(r?.cachedTokens || 0);
        calls += 1;
      }
      usageStatus = {
        promptTokens, completionTokens, cachedTokens, totalTokens: promptTokens + completionTokens,
        runs: calls, calls, resetBoundary,
        dataCoverage: coverage,          // ★ 相容追加：今天的台账读取覆盖（UI 可忽略）
        unattributed: { calls: unattributedCalls, tokens: unattributedTokens, localCount: unattributedLocalCount }
      };
      webSearchCount = todayRows.reduce((s, r) => s + Number(r?.webSearchCount || 0), 0);
      // ★ 计价：复用 api/console.js 的唯一口径（costOfRows/createPriceCache/makePriceOf）
      const llm = getMod(ctx, 'llm');
      if (llm && typeof makePriceOf === 'function') {
        try {
          const getPrice = createPriceCache(makePriceOf(ctx, llm));
          const totals = costOfRows(todayRows, getPrice, llm);
          // ★ 2026-10-17（DS 峰谷 / 未知价）：保留旧 `cost/source/breakdown` 三键不动，
          //   追加峰谷、未知时间与"是否可信"读数；`complete=false` 时**不许**把成本当可信 0。
          //   再并入窗口级信号：窗口早端可能被截 / 读取中途截断 / 有未归属时间的行
          //   ⇒ 价格全知也不再是"可信完成"。
          totals.costComplete = totals.costComplete === true && windowComplete;
          cost = {
            cost: totals?.cost ?? 0,
            source: 'observability.recent(usage)',
            breakdown: totals,
            peakCost: totals?.peakCost ?? 0,
            offPeakCost: totals?.offPeakCost ?? 0,
            unknownTimeCost: totals?.unknownTimeCost ?? 0,
            hasPeakModel: totals?.hasPeakModel === true,
            pricedCalls: totals?.pricedCalls ?? 0,
            unpricedCalls: totals?.unpricedCalls ?? 0,
            zeroPricedCalls: totals?.zeroPricedCalls ?? 0,
            timeUnknownCalls: totals?.timeUnknownCalls ?? 0,
            complete: totals?.costComplete !== false,
            priceSources: totals?.costSources ?? null,
            // ★ 2026-10-17 新增（相容追加，UI 可忽略）：读取覆盖 / 未归属行 / 峰谷日历覆盖
            dataCoverage: coverage,
            unattributed: { calls: unattributedCalls, tokens: unattributedTokens, localCount: unattributedLocalCount },
            peakCalendar: peakCalendarFor(llm, todayRows),
          };
        } catch {
          cost = null;
        }
      } else {
        cost = null;
      }
      // ★ cacheHitRate = cached / promptTokens（旧树 src/app.js:4100 口径）——**综合值，含全部调用**
      //   （主模型 + 自动表情 + 判定等）。2026-10-17 起：逐行钳制 `cached > prompt` 的异常读数
      //   （不伪造、不删除任何行），异常行数在 cacheUsageCoverage 里如实暴露。
      let cachedClamped = 0;
      let ratioPrompt = 0;
      let totalAnomalyRows = 0;
      let totalMissingPromptRows = 0;
      let totalMissingCacheRows = 0;
      for (const r of todayRows) {
        const promptOk = usageNumberReported(r?.promptTokens);
        const cacheOk = usageNumberReported(r?.cachedTokens);
        if (!promptOk) { totalMissingPromptRows += 1; continue; }
        const p = Number(r.promptTokens);
        ratioPrompt += p;
        if (!cacheOk) { totalMissingCacheRows += 1; continue; }
        const cRaw = Number(r.cachedTokens);
        if (cRaw > p) { totalAnomalyRows += 1; cachedClamped += p; } else cachedClamped += cRaw;
      }
      cacheHitRate = ratioPrompt > 0 ? cachedClamped / ratioPrompt : null;

      // ── ★ 2026-10-17：**主模型**缓存率 + 覆盖（glm2 在真实写入点带 `purpose`；本层只消费）──
      //   规则（固定契约）：
      //     · 只有 `purpose === 'main_model'` 的行进 main 读数；历史行没有 purpose ⇒ 一律 unknown，
      //       **绝不反推当主请求**；
      //     · 样本 = prompt 与 cache **都真实报告**（键缺失 = 未报告；`0` 是合法读数）；
      //     · 逐行钳制 `cached > prompt`，异常单独计数；缺字段的行不进率、也不伪造成 0；
      //     · 顶层 usage 行是**轮聚合**（compose 把 perCallUsage 作为明细嵌在行里）⇒ 不展开明细，
      //       避免与聚合行双重计数。
      let mainRows = 0;
      let mainReportedRows = 0;
      let mainMissingCacheRows = 0;
      let mainMissingPromptRows = 0;
      let mainPromptSum = 0;
      let mainCachedSum = 0;
      let mainCacheAnomalyRows = 0;
      let unknownPurposeRows = 0;
      const mainByModel = new Map();
      for (const r of todayRows) {
        if (!usagePurposeOf(r)) unknownPurposeRows += 1;
        if (usagePurposeOf(r) !== 'main_model') continue;
        mainRows += 1;
        const model = String(r?.model ?? '');
        const row = mainByModel.get(model)
          || { model, rows: 0, reportedRows: 0, missingCacheRows: 0, missingPromptRows: 0, anomalyRows: 0, promptTokens: 0, cachedTokens: 0 };
        row.rows += 1;
        const promptOk = usageNumberReported(r?.promptTokens);
        const cacheOk = usageNumberReported(r?.cachedTokens);
        if (!promptOk) { mainMissingPromptRows += 1; row.missingPromptRows += 1; }
        if (!cacheOk) { mainMissingCacheRows += 1; row.missingCacheRows += 1; }
        if (promptOk && cacheOk) {
          const p = Number(r.promptTokens);
          const cRaw = Number(r.cachedTokens);
          const c = Math.min(cRaw, p);
          if (cRaw > p) { mainCacheAnomalyRows += 1; row.anomalyRows += 1; }
          mainPromptSum += p;
          mainCachedSum += c;
          mainReportedRows += 1;
          row.reportedRows += 1;
          row.promptTokens += p;
          row.cachedTokens += c;
        }
        mainByModel.set(model, row);
      }
      mainCacheHitRate = mainReportedRows > 0 && mainPromptSum > 0 ? mainCachedSum / mainPromptSum : null;
      cacheUsageCoverage = {
        // 固定契约字段
        mainRows, mainReportedRows, mainMissingCacheRows, unknownPurposeRows,
        // 可核的账本分项（缺什么、异常多少，都如实给，不做"提高分子"的裁剪）
        mainMissingPromptRows,
        mainCacheAnomalyRows,
        mainPromptTokens: mainReportedRows > 0 ? mainPromptSum : null,
        mainCachedTokens: mainReportedRows > 0 ? mainCachedSum : null,
        totalRows: todayRows.length,
        totalMissingPromptRows,
        totalMissingCacheRows,
        totalAnomalyRows,
        combinedPromptTokens: ratioPrompt > 0 ? ratioPrompt : null,
        combinedCachedTokens: ratioPrompt > 0 ? cachedClamped : null,
        // 按**实际 model** 分组（行上没有 model 的归 ''；不编造 provider）
        byModel: [...mainByModel.values()]
          .map((row) => ({
            model: row.model,
            rows: row.rows,
            reportedRows: row.reportedRows,
            missingCacheRows: row.missingCacheRows,
            missingPromptRows: row.missingPromptRows,
            anomalyRows: row.anomalyRows,
            cacheHitRate: row.reportedRows > 0 && row.promptTokens > 0 ? row.cachedTokens / row.promptTokens : null,
          }))
          .sort((a, b) => b.rows - a.rows || String(a.model).localeCompare(String(b.model))),
        note: 'mainCacheHitRate = 主模型（purpose=main_model）且 prompt/cache 都真实报告的样本 Σcached/Σprompt；'
          + 'cacheHitRate 仍是含全部调用的综合值（逐行钳制 cached>prompt）。历史行无 purpose 一律 unknown，不计入主模型读数。',
      };
    } catch {
      usageStatus = null;
      cost = null;
      cacheHitRate = null;
      mainCacheHitRate = null;
      cacheUsageCoverage = {
        state: 'unavailable', reason: 'usage-read-failed',
        mainRows: null, mainReportedRows: null, mainMissingCacheRows: null, unknownPurposeRows: null,
      };
      webSearchCount = null;
    }
  } else {
    // obs 出口缺失（旧装配/测试替身）：主模型读数与覆盖如实标"未接"，不冒充 0。
    cacheUsageCoverage = {
      state: 'unported', reason: 'not-ported: observability.recent(usage)',
      mainRows: null, mainReportedRows: null, mainMissingCacheRows: null, unknownPurposeRows: null,
    };
  }

  // ── 其余：有真出口就接，没有就 null + unported ──
  const jev = getMod(ctx, 'jev');
  const emotion = getMod(ctx, 'emotion');

  return json(200, {
    onebot: onebotStatus,
    snowluma: snowlumaStatus,
    orchestrator: orchStatus,
    usage: usageStatus ?? { promptTokens: null, completionTokens: null, cachedTokens: null, calls: null, unported: 'not-ported: observability.recent(usage)' },
    cost,
    cacheHitRate,
    // ★ 2026-10-17（固定契约）：主模型缓存率（无可计量样本为 null）+ 覆盖读数。
    //   `cacheHitRate` 仍是含全部调用的综合值（语义未变）。
    mainCacheHitRate,
    cacheUsageCoverage,
    webSearchCount: webSearchCount ?? null,
    cacheKeepAlive: null,
    // ★ 2026-10-17（每厂商缓存策略）：只读状态对象，固定字段 —— 作用域是**默认发言提供商**
    //   （本仓没有 chat 级 cache 覆盖；这里不代表每轮真实值，真实请求诊断在 LLM 侧）。
    //   不回声 key / 完整 URL / 正文；未知一律 null/unknown；策略只影响缓存参数，不冒充原厂身份。
    cacheStrategyState: (() => {
      try {
        const llmMod = getMod(ctx, 'llm');
        const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
        const cfg = (typeof cs?.get === 'function' ? cs.get() : null) ?? {};
        const api = cfg.api && typeof cfg.api === 'object' ? cfg.api : {};
        const providerId = String(api.provider ?? '').trim();
        const list = Array.isArray(cfg.providers) ? cfg.providers : [];
        const entry = providerId ? (list.find((p) => p && String(p.id) === providerId) ?? null) : null;
        const cfgStrategy = readCacheStrategyOf(ctx, entry?.cacheStrategy);
        // ★ 2026-10-17（对齐 f0e47d69 的真实字段）：身份与策略都走 ds3 的**同一套公开出口**，
        //   不在状态层另算一份决策。`apiWith()` = 生产同源的有效 api（key 已解析 ⇒ 只读其中几个字段，绝不外发整对象）。
        const apiForStatus = typeof llmMod?.apiWith === 'function' ? llmMod.apiWith() : null;
        const baseUrl = String(apiForStatus?.baseUrl ?? api.baseUrl ?? '').trim()
          || String(entry?.baseURL ?? entry?.baseUrl ?? '').trim();
        const cacheMode = String(apiForStatus?.cacheMode ?? api.cacheMode ?? 'adaptive');
        const keepAliveEnabled = cfg?.api?.cacheKeepAlive?.enabled === true;
        // selected = 保存的 auto/手选值（ds3 归一后的字段优先，缺出口时用配置层归一）。
        const selected = String(apiForStatus?.cacheStrategySelected ?? cfgStrategy.selected ?? 'auto');
        // 传给唯一决策点的策略：优先**配置里保存的原值**（让 ds3 自己归一 ⇒ fallback 来源可辨），
        // 没有该条目时退回有效 api 上的选择值。
        const strategyForDecision = entry?.cacheStrategy !== null && entry?.cacheStrategy !== undefined && String(entry.cacheStrategy).trim() !== ''
          ? entry.cacheStrategy
          : selected;
        // 400 剥标记记忆：**同一身份**（endpoint+账号指纹+模型+有效策略）读点；剥过 ⇒ 决策同步收手。
        let markerStripped = false;
        try {
          const rec = typeof llmMod?.cacheMarkerStrippedOn === 'function'
            ? llmMod.cacheMarkerStrippedOn(apiForStatus ?? {}) : null;
          markerStripped = rec?.stripped === true;
        } catch { markerStripped = false; }
        // 唯一决策点（ds3）：传 selected 让它按端点解析 effective；markerStripped 同一身份传进去。
        let decision = null;
        try {
          decision = typeof llmMod?.cacheDecisionFor === 'function'
            ? llmMod.cacheDecisionFor({ baseUrl, cacheMode, keepAliveEnabled, cacheStrategy: strategyForDecision, markerStripped })
            : null;
        } catch { decision = null; }
        const profile = decision?.profile && typeof decision.profile === 'object' ? decision.profile : null;
        return {
          providerId: providerId || null,
          // 保存值：auto / 手选（归一后小写）。按 ds3 的映射口径：decision.strategySelected 优先。
          selected: String(decision?.strategySelected ?? selected),
          // ★ effective = **解析后的有效策略**（auto 时按实际端点识别；手选中转 deepseek 时就是 deepseek）。
          //   绝不取 endpointVendor / profile.id —— 那是端点身份，不是策略。
          effective: typeof decision?.strategy === 'string' ? decision.strategy : null,
          source: String(decision?.strategySource ?? cfgStrategy.source ?? 'auto'),   // auto | manual | fallback
          endpointVendor: typeof decision?.endpointVendor === 'string' ? decision.endpointVendor : null,
          mode: decision ? String(decision.mode ?? 'unknown') : null,
          mark: decision ? decision.mark === true : null,          // 只是**当前计划允许**，非已命中
          keepAlive: decision ? decision.keepAlive === true : null, // 同上：不冒充定时器在跑
          reason: String(decision?.reason || apiForStatus?.cacheStrategyReason || cfgStrategy.reason || '') || '',
          // 作用域与端点身份：供 UI 说清"这是默认提供商范围，不是每轮真实值"；真实请求诊断在 LLM 侧。
          scope: 'default-provider',
          baseUrlHost: safeHostLabelOf(baseUrl) || null,
          endpointKnown: profile ? profile.known === true : null,
          endpointProtocol: profile ? String(profile.protocol ?? 'unknown') : null,
          // 剥标记闭环的可见性：true ⇒ mark/keepAlive 已被同一决策收手（原因在 reason 里）。
          ...(decision ? { markerStripped: markerStripped === true } : {}),
          ...(cfgStrategy.reason ? { strategyReason: cfgStrategy.reason } : {})
        };
      } catch { return null; }
    })(),
    replyGate: { recentDecisions: recentDecisions(ctx) },
    paused: orchStatus.paused,
    pauseReason: orchStatus.pauseReason,
    jev: jev?.stats ? (() => { try { return jev.stats(); } catch { return null; } })() : null,
    localJev: (() => {
      if (!jev?.stats) return { unported: 'not-ported: jev.stats（M9）' };
      try {
        const stats = jev.stats();
        // ★ 2026-10-16（独立云判定/未完成诊断）：顶栏与设置页要能直接看到"这一枪判定用谁、
        //   思考态、为什么不可用"——由装配层的 getJudgeAvailability 如实给出，取不到就 null。
        return stats && typeof stats === 'object' ? { ...stats, judge: judgeAvailabilityOf(ctx) } : stats;
      } catch { return null; }
    })(),
    botState: emotion?.snapshot ? (() => {
      try {
        // ★ W-3b(3)：过去这里恒喂 `initState()` ⇒ 桌宠/概览拿到的是**空白默认态**，
        //   不是机器人此刻的状态（一个"看着有数、其实是编的"的显示）。改成与 /api/bot-state 同一条链。
        const nowMs = Date.now();
        const live = typeof emotion.stateOf === 'function' ? emotion.stateOf() : ctx?.emotionState ?? null;
        if (live == null) {
          // ★ 2026-10-16（导航契约）：没有真实状态时**不拿空白默认态编数** —— 扁平字段一律 null/'未知'，
          //   空白 snapshot 仍原样给出（供需要结构的下游），但不把它当"当前值"。
          const blank = emotion.initState?.({ at: nowMs });
          const base = blank ? emotion.snapshot(blank) : null;
          return base ? { ...base, ...navStateProjection(null, nowMs) } : null;
        }
        const base = emotion.snapshot(typeof emotion.project === 'function' ? emotion.project(nowMs) : live);
        if (!base) return null;
        // ★ 2026-10-16（导航情绪条后端契约）：UI/桌宠读的是 energy/mood/social/energyDetail 这些**扁平键**，
        //   而 snapshot 把数值装在 self.pools.* 里 ⇒ 用与 /api/bot-state **同一个投影函数**补上，
        //   原 snapshot 的 self/persons/recentChanges 一个不少；取不到就是 null/'未知'，真实 0 保留。
        return { ...base, ...navStateProjection(emotion, nowMs) };
      } catch { return null; }
    })() : { unported: 'not-ported: emotion.snapshot（M7）' }
  });
}

/**
 * GET /api/config — 配置快照（脱敏，不暴露密钥）
 */
export function getConfig(ctx) {
  try {
    const snap = ctx?.configStore?.snapshot?.();
    if (!snap) return json(500, { ok: false, error: 'configStore.snapshot() 无返回' });
    // ★ snapshot() 返回 {dataDir, config, raw, changed} 包装器
    //   UI 读的是 FLAT 配置（app.js:7682 cfgNow?.emotion?.enabled 等）
    //   ⇒ 必须解包到 snap.config（旧树 src/app.js:2651 同一形状）
    const flat = snap.config ?? snap;
    return json(200, sanitizeConfig(flat));
  } catch (e) {
    return errorResponse(e);
  }
}

// ── P1 能用接口 ──────────────────────────────────────────────────────────

/** GET /api/instance-info — 实例信息（http.js 已有，这里保留兼容） */
export function getInstanceInfo(ctx) {
  return json(200, {
    ok: true,
    dataDir: ctx?.dataDir ?? null,
    modules: ctx?.modulesLoaded ?? [],
    busEvents: ctx?.busEvents ?? []
  });
}

/** 从地址取一个可显示的主机名（没有地址/解析失败 = ''）；只取 host，不碰路径与凭据。 */
function safeHostLabelOf(url) {
  try {
    const parsed = new URL(String(url ?? '').trim());
    return parsed.host || '';
  } catch { return ''; }
}

/**
 * ★ 2026-10-17（用户令：每个厂商可单独选缓存优化方式）：读 config-store 的**唯一**策略归一器
 *   （枚举与非法回退都在 `core/config-store/index.js` 的 `readProviderCacheStrategy`）。
 *   出口缺失（旧装配/替身）⇒ 不猜枚举：按"未提供"处理并把原因带出去（如实，不编 selected）。
 */
function readCacheStrategyOf(ctx, rawValue) {
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  if (typeof cs?.readProviderCacheStrategy === 'function') return cs.readProviderCacheStrategy(rawValue);
  return { selected: 'auto', source: 'fallback', valid: false, reason: 'config-store.readProviderCacheStrategy 出口缺失' };
}

/**
 * ★ 2026-10-16（导航情绪条后端契约）：把 M7 的 `snapshot` 折算成 UI/桌宠直接读的**稳定扁平字段**
 *   （energy / energyDetail / mood / moodRaw / moodLabel / social / socialRaw / socialLabel / energyLabel）。
 * 唯一出处：`/api/status` 的 botState 与 `/api/bot-state` 共用本函数，标签阈值只此一份（不造第二套算法）。
 * 取不到就是 null / '未知'，**不补默认值、不编数**；真实 0 走 Number.isFinite 判定后原样保留。
 */
function navStateProjection(emotion, nowMs) {
  const empty = {
    energy: null, energyLabel: '未知',
    mood: null, moodRaw: null, moodLabel: '未知',
    social: null, socialRaw: null, socialLabel: '未知',
    energyDetail: { physical: null, cognitive: null, emotional: null, will: null },
    navAt: null
  };
  try {
    if (typeof emotion?.snapshot !== 'function') return empty;
    const raw = typeof emotion.stateOf === 'function' ? emotion.stateOf() : null;
    if (raw == null) return empty;
    const projected = typeof emotion.project === 'function' ? emotion.project(nowMs) : raw;
    const snap = emotion.snapshot(projected);
    const s = snap?.self ?? {};
    const pools = s.pools ?? {};
    const readPool = (v) => {
      const inner = v !== null && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, 'value') ? v.value : v;
      const n = Number(inner);
      return Number.isFinite(n) ? n : null;
    };
    const energyDetail = {
      physical: readPool(pools.physical),
      cognitive: readPool(pools.cognitive),
      emotional: readPool(pools.emotional),
      will: readPool(pools.will)
    };
    const poolVals = [energyDetail.physical, energyDetail.cognitive, energyDetail.emotional, energyDetail.will];
    const hasAllPools = poolVals.every((v) => Number.isFinite(v));
    const energy = hasAllPools ? Math.round(poolVals.reduce((a, b) => a + b, 0) / poolVals.length) : null;
    const moodRaw = Number.isFinite(Number(s.mood)) ? Number(s.mood) : null;
    const mood = moodRaw === null ? null : Math.round(moodRaw - 50);   // 旧契约：mood 是居中值
    const moodLabel = moodRaw === null ? '未知'
      : moodRaw >= 72 ? '不错' : moodRaw >= 58 ? '平稳' : moodRaw >= 42 ? '一般' : moodRaw >= 28 ? '有点闷' : '不太妙';
    const socialRaw = energyDetail.emotional;
    const social = Number.isFinite(socialRaw) ? Math.round((socialRaw / 100) * 3) : null;
    const socialLabel = Number.isFinite(socialRaw)
      ? (socialRaw >= 75 ? '还想聊' : socialRaw >= 50 ? '还行' : socialRaw >= 30 ? '有点乏' : '想安静') : '未知';
    const energyLabel = Number.isFinite(energy)
      ? (energy >= 85 ? '满血' : energy >= 65 ? '还行' : energy >= 40 ? '一般' : energy >= 25 ? '偏累' : '很累') : '未知';
    return { energy, energyLabel, mood, moodRaw, moodLabel, social, socialRaw, socialLabel, energyDetail, navAt: Number(snap?.at) || null };
  } catch { return empty; }
}

/** GET /api/bot-state — 情绪/精力/好感读数 */
export function getBotState(ctx) {
  const emotion = getMod(ctx, 'emotion');
  // 已接线：emotion.snapshot 定义在 modules/emotion/view.js:11（re-exported at index.js:19）
  try {
    // ★ W-3b(3) 取数链对齐：面板过去读的是 `ctx.emotionState`（**上次结算时**的原始态），
    //   而 compose.js:240-242 喂给模型的是 `emotion.project(now)`（投影到此刻）⇒
    //   同一时刻"面板显示的档位"和"模型看到的档位"可以不是同一个（两轮之间没事件时必然陈旧）。
    //   这里改成与主链同一条链：stateOf() → project(now) → styleHint(projected)。
    //   `stateSource` 如实说明取到哪一层（老装配层没有 project/stateOf 时会退，面板要能显示这条退路）。
    const nowMs = Date.now();
    let stateSource = 'project(now)';
    let raw = typeof emotion.stateOf === 'function' ? emotion.stateOf() : ctx?.emotionState ?? null;
    if (raw == null) {
      raw = emotion.initState ? emotion.initState({ at: nowMs }) : null;
      stateSource = 'initState(空白态)';
    } else if (raw === ctx?.emotionState) {
      stateSource = 'ctx.emotionState(未投影)';
    } else {
      stateSource = 'stateOf()(未投影)';
    }
    if (!raw) return notPorted('emotion.initState');
    const projected = typeof emotion.project === 'function' ? emotion.project(nowMs) : raw;
    if (typeof emotion.project === 'function') stateSource = 'stateOf() → project(now)';
    const snap = emotion.snapshot(projected);
    const s = snap?.self ?? {};

    // ── 旧形状字段（UI loadEmotionsView 读的 10 个，加法式补）──
    // ★ 2026-10-16：数值/标签统一走 navStateProjection（与 /api/status 的 botState 同一函数），
    //   本函数不再自己算一份标签阈值。
    const nav = navStateProjection(emotion, nowMs);
    const energyDetail = nav.energyDetail;
    // energy: 四池均值（口径：算术平均，四舍五入到整数）—— 四池缺任一则 null（不编数）。
    const energy = nav.energy;
    // moodRaw / mood use the legacy UI contract: raw is 0..100; mood is centered at 50.
    // 缺 mood 时沿用历史默认 50（面板居中口径，行为与改前一致；50 对应标签"平稳"）。
    const moodRaw = nav.moodRaw === null ? 50 : nav.moodRaw;
    const mood = Math.round(moodRaw - 50);
    const moodLabel = nav.moodRaw === null ? '平稳' : nav.moodLabel;
    const social = nav.social;
    const socialLabel = nav.socialLabel;
    const energyLabel = nav.energyLabel;
    const affect = s.affect ?? {};
    // ★ N33：目录与 label 一律从 `modules/emotion` 取（本文件不再自带一份，见文件头注释）。
    const view = emotionView(emotion);
    // ★ N33 照老树 `src/bot-state.js:1252-1277` `listEmotionCatalog()`：**每条都给真值**。
    //   改前这里有一道 `EMOTION_AFFECT_KEYS`（只 4 条）闸，把另外 10 条**硬写成 0** ——
    //   于是 anger/cheer/pride/smug/shame/down/boredom/loneliness/curiosity 在面板上恒为 0
    //   （N30 回执 §四.1 第 2 条说的"16 个键里 10 个是 0"就是它）。
    const clamp01 = (v) => Math.min(100, Math.max(0, Math.round(Number(v) || 0)));
    const emotions = Object.fromEntries(view.keys.map((key) => [key, clamp01(affect[key])]));
    const emotionCatalog = view.keys.map((key) => {
      const meta = view.catalog[key] || {};
      const value = emotions[key];
      return {
        key, label: meta.label || affectLabel(view.catalog, key),
        sign: meta.sign || 'neu', cat: meta.cat || 'neu',
        catLabel: view.catLabel[meta.cat] || meta.cat || '中性',
        signLabel: view.signLabel[meta.sign] || meta.sign || '中性',
        halfLifeMin: meta.halfLifeMin, value, active: value >= 8
      };
    }).sort((a, b) => {
      // 老树排序：先方向（向内 → 向外 → 中性），同方向按强度降序（`src/bot-state.js:1273-1276`）
      const order = { in: 0, out: 1, neu: 2 };
      if (order[a.cat] !== order[b.cat]) return order[a.cat] - order[b.cat];
      return b.value - a.value;
    });
    const emotionPhrases = emotionCatalog.filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value).slice(0, 5).map((item) => item.label);
    // ★ W-3b(3)②：归因**有**真源头 —— M7 的状态自带台账（modules/emotion/view.js:49-53 的
    //   `recentChanges` = state.ledger 末 20 行，每行 {seq,at,target,field,delta,magnitude,source,evidenceIds,reason,rejected}）。
    //   过去这里写死 `eventLog=[]/lastEvent=null` 并称"合约缺这个字段"，是**过期说法**：
    //   主人问"负面情绪为什么飙高"时，面板只能显示空白。现在从台账取，缺字段就如实缺（不编）。
    const changes = Array.isArray(snap?.recentChanges) ? snap.recentChanges : [];
    const eventLog = changes.map((r) => ({
      seq: Number(r?.seq) || 0,
      at: Number(r?.at) || 0,
      target: String(r?.target ?? ''),
      field: String(r?.field ?? ''),
      // 旧 UI 契约（`bs.eventLog[].type / .text / .delta(对象)`）来自老树；
      // 新树台账是**逐字段一行** ⇒ type 用 source（机器词，UI 侧再翻成人话），
      // text **留空**（合约里没有正文，也不许在这里编正文）。
      type: String(r?.source ?? ''),
      text: '',
      delta: Number(r?.delta) || 0,
      magnitude: Number(r?.magnitude) || 0,
      source: String(r?.source ?? ''),
      // kind/deterministic 来自 M7 投影（view.js:52-54）：票 E-2 裁定① 要台账一眼分开"聊天引起的"和"时间引起的"。
      kind: r?.kind === 'decay' ? 'decay' : 'event',
      deterministic: r?.deterministic === true,
      evidenceIds: Array.isArray(r?.evidenceIds) ? r.evidenceIds.map(String).slice(0, 8) : [],
      reason: r?.reason == null ? '' : String(r.reason),
      rejected: r?.rejected == null ? '' : String(r.rejected),
    })).reverse();
    const lastEvent = eventLog[0] ?? (snap?.self?.lastChange ? {
      seq: Number(snap.self.lastChange.seq) || 0,
      at: Number(snap.self.lastChange.at) || 0,
      target: String(snap.self.lastChange.target ?? 'self'),
      field: String(snap.self.lastChange.field ?? ''),
      type: String(snap.self.lastChange.source ?? ''),
      text: '',
      delta: Number(snap.self.lastChange.delta) || 0,
      source: String(snap.self.lastChange.source ?? ''),
      evidenceIds: [], reason: '', rejected: '',
    } : null);
    // 台账只说"哪个字段被哪类来源抬了多少"；**没有**"哪条消息"以外的正文，也**没有**按情绪维度的分账。
    // 这一点如实标出来，别让人以为能从这里点到某句话。
    const attributionGaps = changes.length
      ? []
      : ['recentChanges 台账为空：本轮至今没有状态推进事件（不是缺字段）'];
    // promptLine: styleHint 的输出（真来源，与 compose 同一条链：project(now) → styleHint）
    let promptLine = '';
    try { promptLine = emotion.styleHint?.(projected) ?? ''; } catch { promptLine = ''; }
    // ★ N33（照老树 `src/bot-state.js:1389`）：`intent` 是老树视图里的一等字段（`s.intent`，一个中文串）。
    //   bunny2 的 N30 已在 `modules/emotion/prompt-line.js:98` 备好 `computeIntent(emo, energy, opts)`
    //   （老树 `src/bot-state.js:373-408` 的逐字版，12 条意图串）。
    //   改前这个接口的 `notPorted` 里一直写着"intent: M7 无等价意图出口" —— **那是过期说法**，
    //   出口已经在了，只是没人调。能量按四池取（老树口径：computeIntent 吃的是 energy 对象）。
    let intent = '';
    try {
      intent = typeof emotion.computeIntent === 'function'
        ? String(emotion.computeIntent(affect, {
          physical: energyDetail.physical, cognitive: energyDetail.cognitive,
          emotional: energyDetail.emotional, will: energyDetail.will
        }, { acuteStress: Number(s.acuteStress ?? 0) }) ?? '')
        : '';
    } catch { intent = ''; }
    // 四个高光 AFFECT 维度（票面口径）：按当前值取 top4，其余留全量
    // ★ N33：label 改从模块目录取（含别名归一）—— 改前只认 6 个键，其余**显示裸英文 key**。
    const affectTop = Object.entries(affect)
      .map(([key, value]) => ({ key, label: affectLabel(view.catalog, key), value: Number(value) || 0 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 4);

    // ★ E3（2026-10-13 派单）：面板要能看出「改了但还没落盘」。
    //   数据源 = emotion 模块的 `persistence()`（owner 自述，装配层挂在 assembly.js:593）：
    //   `{ file, blocked, dirty, lastFlushError }` —— dirty=改了还没刷盘；blocked=为什么不落盘
    //   （现只有 'unmigrated'）；lastFlushError=最近一次**真写盘失败**的原因（成功刷盘即清）。
    //   ★ 不补默认值：出口缺失或抛错 ⇒ state='unknown' + note 写清"取不到"，绝不演成"已落盘"；
    //     owner 版本较老、persistence() 里没有 lastFlushError 字段 ⇒ 该字段照写"取不到"。
    //   ★ 2026-10-14 更新（mimo1 `8ea74c36` 补字段后）：**权限型刷盘失败现在看得见了** ——
    //     写失败（例如 EPERM/目录只读）会记进 lastFlushError ⇒ 本视图判 failed；下次成功刷盘即清。
    //     但 `no-data-dir` / `blocked` / `clean` 三种**没走到写盘**的回执不动它（照 mimo1 口径）。
    const persistenceView = (() => {
      if (typeof emotion?.persistence !== 'function') {
        return {
          state: 'unknown',
          note: '取不到：emotion 模块没有 persistence() 出口（装配层未挂 owner.persistence）',
          dirty: null, blocked: null, file: null, lastFlushError: '取不到'
        };
      }
      let p;
      try {
        p = emotion.persistence();
      } catch (e) {
        return {
          state: 'unknown',
          note: `取不到：persistence() 抛错 —— ${String(e?.message ?? e)}`,
          dirty: null, blocked: null, file: null, lastFlushError: '取不到'
        };
      }
      const blocked = p?.blocked == null ? null : String(p.blocked);
      // 老版 owner 没有这个字段 ⇒ 照写"取不到"（不默认成 null，null 是"从未失败"的意思）
      const hasFlushErr = Object.prototype.hasOwnProperty.call(p ?? {}, 'lastFlushError');
      const lastFlushError = !hasFlushErr ? '取不到' : (p.lastFlushError == null ? null : String(p.lastFlushError));
      const flushFailed = typeof lastFlushError === 'string' && lastFlushError !== '取不到' && lastFlushError !== '';
      const state = (blocked || flushFailed) ? 'failed' : (p?.dirty === true ? 'pending' : 'saved');
      const note = blocked
        ? `不落盘（${blocked}）`
        : flushFailed
          ? `上次刷盘失败：${lastFlushError}${p?.dirty === true ? '（改动仍未落盘）' : ''}`
          : (p?.dirty === true ? '有改动还没写到盘（等轮末或停止时刷盘）' : '已落盘（没有待写改动）');
      return { state, note, dirty: p?.dirty === true, blocked, file: p?.file == null ? null : String(p.file), lastFlushError };
    })();

    // ★ 面板一行·记忆整理成功前沿（2026-10-14 按 qwen1 规格 `.tmp-dispatch/2026-10-14/qwen1/派-面板一行-记忆成功前沿.md`）：
    //   数据源 = `ctx.memoryCoordinator.status()`（装配层唯一实例，api/memory.js:395 已在用，别另造）。
    //   返回的 cursor / lastSuccessfulThrough 原样透传（单会话是数字、无参会是 {会话:数字} 的表）；
    //   **取不到照 E3 口径写字面"取不到"，不补默认值** —— null 就是 null（"没记过"），绝不演成"已整理好"。
    const memoryFrontierView = (() => {
      const mc = ctx?.memoryCoordinator;
      if (!mc || typeof mc.status !== 'function') {
        return {
          cursor: null,
          lastSuccessfulThrough: null,
          source: '取不到：ctx.memoryCoordinator.status 不存在（装配层未挂协调器）'
        };
      }
      try {
        const st = mc.status();
        return {
          cursor: st?.cursor ?? null,
          lastSuccessfulThrough: st?.lastSuccessfulThrough ?? null,
          source: 'memoryCoordinator.status()'
        };
      } catch (e) {
        return {
          cursor: null,
          lastSuccessfulThrough: null,
          source: `取不到：status() 抛错 —— ${String(e?.message ?? e)}`
        };
      }
    })();

    return json(200, {
      ok: true,
      data: snap,
      // ── 旧形状（UI loadEmotionsView 直接读）──
      acuteStress: Number(s.acuteStress ?? 0),
      arousal: Number(s.arousal ?? 0),
      chronicStress: Math.round(Number(s.chronicStress ?? 0)),
      energyLabel,
      emotionCatalog,
      emotionPhrases,
      emotions,
      // ★ N33：旧 UI 直接读的那 4 个键（`src/bot-state.js` 的旧契约）单列一份，
      //   免得 UI 只能靠"取前 4 个 key"这种约定去猜。
      emotionsLegacy: Object.fromEntries(LEGACY_UI_EMOTION_KEYS.map((k) => [k, clamp01(affect[k])])),
      energyDetail,
      energy,
      eventLog,
      lastEvent,
      mood,
      moodLabel,
      moodRaw,
      promptLine,
      // ★ N33：新接上 —— 老树视图里的一等字段 `intent`（`src/bot-state.js:1389`）。
      //   改前这个响应里根本没有这个键，面板与排障都看不到「此刻该往哪走」。
      intent,
      // ── W-3b(3)：取数链与归因（面板要能说明"这数是哪儿来的"）──
      stateSource,
      promptLineChain: typeof emotion.project === 'function'
        ? 'stateOf() → project(now) → styleHint()（与 compose.js:240-242 发给模型的那条同一条链）'
        : 'stateOf() → styleHint()（装配层没有 project ⇒ 退到未投影状态，与主链同退）',
      affectTop,
      // ★ N33：全量维度也从模块目录取（全 14 条 + 别名名），不再只回 6 条
      affectAll: [
        ...view.keys.map((key) => ({ key, label: affectLabel(view.catalog, key), value: clamp01(affect[key]) })),
        ...Object.keys(affect)
          .filter((key) => !view.keys.includes(key))
          .map((key) => ({ key, label: affectLabel(view.catalog, key), value: clamp01(affect[key]) }))
      ],
      attributionGaps,
      social,
      socialLabel,
      updatedAt: Number(snap.at) || Date.now(),
      // ★ E3：待写/失败三态（已落盘 saved · 待处理 pending · 不落盘/刷盘失败 failed；取不到 unknown）
      //   lastFlushError：最近一次真写盘失败原因（成功刷盘即清；从未失败 null；字段缺失=取不到）
      persistence: persistenceView,
      // ★ 面板一行：记忆整理成功前沿（qwen1 规格；取不到写"取不到"，null=没记过）
      memoryFrontier: memoryFrontierView,
      // notPorted 点名缺哪些（绝不静默省略字段）
      // ★ W-3b(3) 更正：`eventLog`/`lastEvent` 过去被写成"M7 无等价出口"，其实合约**有**台账
      //   （view.js:49 的 recentChanges）⇒ 现在从真源头取。这里只留**真缺**的那些。
      // ★ N33：这两句也是**过期说法**，本轮一并更正 ——
      //   ① `intent` 已接（N30 备好了 `computeIntent`，本文件此前没调）；
      //   ② "emotionCatalog 值恒 0 的未移植维度" 那道 4 键闸已经拆掉，14 条都给真值。
      notPorted: `intent: ${typeof emotion.computeIntent === 'function' ? '已接 modules/emotion/prompt-line.js:computeIntent' : 'M7 无等价意图出口（emotion 模块未导出 computeIntent）'}`
        + `${attributionGaps.length ? `; 归因: ${attributionGaps.join('; ')}` : ''}`
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * POST /api/bot-state —— 情绪/精力的**写侧**（旧 `src/app.js:1654` → `setBotState(body)`）。
 *
 * ★ N31（2026-10-09）：改前新树**没有这条路由** ⇒ 落到 `http.js:154` 的兜底 404「未找到 POST /api/bot-state」，
 *   于是老 UI 上那个「重置心情/精力/压力」按钮（`ui/app.js:7785`，打的是 `{reset:true}`）**点了没反应**。
 *   真出口是装配层新加的 `emotion.replaceState()`（`assembly.js`，与 GET 读侧 `stateOf()` 同源）。
 *
 * 响应形状照老树「改完直接回最新视图」的口径：成功回 **200 + 完整的 GET 视图**（老 UI 改完立刻
 * `loadEmotionsView()`，回一份全量比让它再 GET 一次更省一次往返），并带 `applied` 说明**真改了哪几项**。
 * 改不了的老树能力（`emotions` 离散情绪）回 400 并点名 —— **不静默忽略**。
 */
export function postBotState(ctx, body) {
  const emotion = getMod(ctx, 'emotion');
  if (typeof emotion?.replaceState !== 'function') {
    return notPorted('emotion.replaceState（装配层 assembly.js；旧 src/app.js:1654 → setBotState）');
  }
  let result;
  try {
    result = emotion.replaceState(body && typeof body === 'object' ? body : {});
  } catch (e) {
    return json(400, { ok: false, error: String(e?.message ?? e) });
  }
  if (!result || result.ok !== true) {
    return json(400, { ok: false, error: String(result?.error ?? 'replaceState 没有改动任何字段'), unsupported: result?.unsupported ?? [] });
  }
  const view = getBotState(ctx);
  // 视图本体仍是 notPorted 时（如 emotion.snapshot 缺失）如实透传它的状态码，不硬改成 200
  if (view.status !== 200) return view;
  try {
    const payload = JSON.parse(view.body);
    return json(200, { ...payload, applied: result.applied, unsupported: result.unsupported ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * W-3b(1)：面板的「本轮真发给模型的输入」预览。
 * 数据源只有一个：装配层在 llm/prompt 外面套的那层抄手（apps/server/ui-preview.js）
 * ⇒ 显示的就是发出去的那份，**不是** UI 按配置重拼的。缺抄手就如实 501，不许退化成"看起来像"。
 * GET /api/ui-preview → 最近若干次模型调用的目录（含分段元数据，不含正文）
 * GET /api/ui-preview/:id → 那一次的完整 messages 正文（只从本机 ui-preview 目录读）
 * GET /api/ui-preview/by-session/:sessionId → ★P-2：只给这一个**运行会话**的调用（面板用它，不用 chatKey）
 */
const UI_PREVIEW_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
// ★ P-2：会话 id 的形状 = `newSessionId()` 的 `${base36}-${hex8}`（modules/sessions/index.js:267）
//   ⇒ 十六进制/字母数字 + 连字符；不匹配就直接 400，别把任意字符串当成路径片段去查。
const UI_PREVIEW_SESSION_RE = /^[A-Za-z0-9-]{1,80}$/;

function getUiPreview(ctx) {
  const preview = ctx?.uiPreview;
  if (!preview || typeof preview.list !== 'function') return notPorted('ctx.uiPreview（装配层未挂输入抄手）');
  try {
    return json(200, { ok: true, ...preview.list({ limit: 40 }) });
  } catch (e) {
    return errorResponse(e);
  }
}

function getUiPreviewDetail(ctx, pathname) {
  const preview = ctx?.uiPreview;
  if (!preview || typeof preview.read !== 'function') return notPorted('ctx.uiPreview（装配层未挂输入抄手）');
  const id = decodeURIComponent(String(pathname || '').slice('/api/ui-preview/'.length));
  if (!UI_PREVIEW_ID_RE.test(id)) return json(400, { ok: false, error: 'bad-id' });
  try {
    return json(200, preview.read(id));
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * ★ P-2：按**运行会话**取输入预览（面板的主关联键）。
 * 走**路径式**路由而不是 `?sessionId=` —— http.js 在分发前把 query 剥掉了（见 :682 附近注释），
 * 带 query 的写法在这台机器上是"看着对、其实收不到参数"。
 * id 形状不对 ⇒ 400，不碰抄手也不碰文件系统（与详情那条同一个口径）。
 */
function getUiPreviewBySession(ctx, pathname) {
  const preview = ctx?.uiPreview;
  if (!preview || typeof preview.list !== 'function') return notPorted('ctx.uiPreview（装配层未挂输入抄手）');
  const sid = decodeURIComponent(String(pathname || '').slice('/api/ui-preview/by-session/'.length));
  if (!UI_PREVIEW_SESSION_RE.test(sid)) return json(400, { ok: false, error: 'bad-session-id' });
  try {
    return json(200, { ok: true, ...preview.list({ sessionId: sid, limit: 40 }) });
  } catch (e) {
    return errorResponse(e);
  }
}

function postUiPreviewClear(ctx) {
  const preview = ctx?.uiPreview;
  if (!preview || typeof preview.clear !== 'function') return notPorted('ctx.uiPreview（装配层未挂输入抄手）');
  try {
    return json(200, { ok: true, ...preview.clear() });
  } catch (e) {
    return errorResponse(e);
  }
}

/** 只从明确注入的 dataDir 建只读登记表；不依赖 M6 claim history。 */
function sessionsFor(ctx) {
  const injected = getMod(ctx, 'sessions');
  if (typeof injected?.listSummaries === 'function' && typeof injected?.get === 'function') return injected;
  const dataDir = String(ctx?.dataDir ?? '').trim();
  if (!dataDir) return null;
  return createSessionRegistry({ dataDir, warn: (message) => ctx?.log?.(message) });
}

// Match modules/cleanup's public session-id format before any service or path is touched.
const SESSION_ACTION_ID_RE = /^[a-z0-9]+-[0-9a-f]{8}$/;
const cleanupServicesByContext = new WeakMap();

/** The cleanup module is a factory; keep one registry/service pair per live request context. */
function cleanupFor(ctx) {
  const injected = ctx?.cleanup ?? getMod(ctx, 'cleanup');
  if (typeof injected?.softDelete === 'function' && typeof injected?.restore === 'function') return injected;
  if (!ctx || typeof ctx !== 'object') return null;
  const dataDir = String(ctx?.dataDir ?? '').trim();
  if (!dataDir || typeof injected?.createCleanupService !== 'function') return null;
  let byDataDir = cleanupServicesByContext.get(ctx);
  if (!byDataDir) { byDataDir = new Map(); cleanupServicesByContext.set(ctx, byDataDir); }
  if (byDataDir.has(dataDir)) return byDataDir.get(dataDir).cleanup;
  const registry = sessionsFor(ctx);
  if (!registry) return null;
  // M6's reingest returns {ok, visible}; cleanup's legacy hook expects a boolean.
  // Adapt only that return shape so restore reports the completed hook accurately.
  const cleanupRegistry = Object.create(registry);
  cleanupRegistry.reingest = (id) => {
    const result = registry.reingest?.(id);
    return result === true || (result?.ok === true && result?.visible === true);
  };
  // ★ N57（2026-10-09）两件事：
  //   ① `topicStore` —— 新树**没有** topics 模块，所以这里是 null（**不硬造**）。
  //      null ⇒ cleanup 的 P4 闸门按"提取失败"记账 ⇒ 回收站**到期也不删**。
  //      这就是 qwen1 在 N48 钉死的安全语义；谁搬来 topics 模块这里就自动接上。
  //   ② 接上**回收站清扫器**（老树 src/app.js:3763-3764：启动扫一次 + 每 6 小时扫一次，unref）。
  //      `sweepTrash` 由 qwen1 N48 从老树补搬回来了，但此前全树零调用点 ⇒ 回收站只进不出。
  //      同一份实现在 api/shell.js（`armCleanupSweeper`），按 dataDir 去重 ⇒ 两个分片共用一个定时器。
  const cleanup = injected.createCleanupService({
    dataDir,
    registry: cleanupRegistry,
    topicStore: pickTopicStore(ctx?.topicStore ?? getMod(ctx, 'topics') ?? getMod(ctx, 'conversation-memory')),
    log: (line) => ctx?.log?.(line)
  });
  armCleanupSweeper(cleanup, { dataDir, log: (line) => ctx?.log?.(line) });
  byDataDir.set(dataDir, { registry, cleanup });
  return cleanup;
}

/** POST /api/sessions/:id/{delete,reingest,restore} — preserve legacy status/body semantics. */
async function postSessionAction(ctx, pathname) {
  const match = /^\/api\/sessions\/([\w-]+)\/(delete|reingest|restore)$/.exec(pathname);
  if (!match) return null;
  const [, id, action] = match;
  if (action === 'reingest') {
    const registry = sessionsFor(ctx);
    if (!registry) return notPorted('modules/sessions.createSessionRegistry 需要显式 ctx.dataDir；未猜测或回退到 data/。');
    if (!SESSION_ACTION_ID_RE.test(id)) return json(409, { ok: false, reingested: false, reason: 'reingest_not_applied' });
    try {
      const result = registry.reingest(id);
      const reingested = result === true || (result?.ok === true && result?.visible === true);
      if (!reingested) return json(409, { ok: false, reingested: false, reason: 'reingest_not_applied' });
      return json(200, { ok: true, reingested: true, id });
    } catch (error) {
      return errorResponse(error);
    }
  }

  const cleanup = cleanupFor(ctx);
  if (!cleanup) return json(503, { ok: false, error: '会话清理服务尚未就绪' });
  // Keep old cleanup semantics: malformed-but-routable ids are a structured HTTP 200 failure.
  // This check runs before the cleanup service can inspect or mutate any filesystem path.
  if (!SESSION_ACTION_ID_RE.test(id)) {
    if (action === 'restore') return json(200, { ok: false, reason: 'bad-id' });
    return json(200, { ok: false, moved: 0, results: [{ id, ok: false, reason: 'bad-id' }] });
  }
  try {
    return json(200, action === 'delete' ? cleanup.softDelete(id) : cleanup.restore(id));
  } catch (error) {
    return errorResponse(error);
  }
}

/** `/api/sessions?limit=N` 的上限。没给 limit ⇒ 沿用旧上限（前端要全量做本地分页）。 */
const SESSIONS_LIMIT_MAX = 1048576;

/**
 * ★ U4：读 `?limit=`（`URLSearchParams` 或裸对象都吃；两种形状都有人调）。
 * 过去这里没有这个函数：`getSessions()` 把 limit **写死 1048576**，而 `http.js` 又把 query 剥了
 *   ⇒ 前端就算请求 `?limit=50`，服务端也当全量吐 10860 条。
 * 没给 / 给了非法值 ⇒ 回旧上限（不静默变成 0 条，那会让面板"空得像坏了"）。
 */
function sessionsLimitOf(query) {
  const raw = query instanceof URLSearchParams
    ? query.get('limit')
    : (query && typeof query === 'object' ? (query.limit ?? query.get?.('limit')) : null);
  if (raw == null || raw === '') return SESSIONS_LIMIT_MAX;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return SESSIONS_LIMIT_MAX;
  return Math.min(Math.floor(n), SESSIONS_LIMIT_MAX);
}

/** GET /api/sessions?limit=N — T-SESSION-CLEANUP-PORT 的真实只读摘要。 */
export function getSessions(ctx, query) {
  const registry = sessionsFor(ctx);
  if (!registry) return notPorted('modules/sessions.createSessionRegistry 需要显式 ctx.dataDir；未猜测或回退到 data/。');
  try {
    const limit = sessionsLimitOf(query);
    const sessions = registry.listSummaries({ limit, readOnly: true });
    const diag = typeof registry.diagnostics === 'function' ? registry.diagnostics() : null;
    if (diag?.dirReadable === false) return json(500, { ok: false, error: '会话目录读取失败：' + diag.dirError });
    // ★ U8：响应字段说明（写在这里，是这个响应唯一会长久被读到的地方）
    //   · `count` = **本页条数**（`sessions.length`）。语义自 U4 起**不变**，不许改 ——
    //     它已经打给现有调用方了，改语义就是打坏它们。
    //   · `total` = **总量**（盘上会话总数，取自索引的 `entries`）。
    //   为什么两个都要：`count` 这个名字会被下一个人读成"总数"（指挥位 U8 就是这么被绕进去的），
    //     而前端真正要的是后者 ⇒ 名字不够用就**另起一个够用的名字**，不去改旧的。
    //   `total` 为什么取 `indexLoad.entries` 而不是再扫一遍盘：它是**零额外开销**的（索引/缓存已经在手上），
    //   而再扫一遍要多付一次全量 pass（冷读时那是十几秒，见 U8 回执 §0）。两者实测相等（幽灵行差 0）。
    const totalEntries = Number(diag?.lastIndexLoad?.entries);
    const total = Number.isFinite(totalEntries) && totalEntries >= 0 ? totalEntries : sessions.length;
    return json(200, { sessions, count: sessions.length, total, limit, indexLoad: diag?.lastIndexLoad ?? null });
  } catch (e) {
    return errorResponse(e);
  }
}

/** GET /api/chats — 聊天列表（stats 真来源；chats 列表无聚合出口 ⇒ 点名） */
export function getChats(ctx) {
  const memory = getMod(ctx, 'memory');
  // 已接线：memory.stats 定义在 modules/memory/index.js:541
  try {
    const stats = memory.stats();
    return json(200, { ok: true, chats: [], stats, notPorted: 'chats 列表: M6 memory 无 chats 聚合出口' });
  } catch (e) {
    return errorResponse(e);
  }
}

/** GET /api/memory-people — 记忆页左栏：当前生效的人物记忆（按真实 scope 列） */
export async function getMemoryPeople(ctx, query) {
  const memory = getMod(ctx, 'memory');
  // 已接线：memory.history 定义在 modules/memory/index.js:502
  try {
    const dataDir = String(ctx?.dataDir ?? '').trim() || undefined;
    // ★★ P1-5（2026-10-11）：原来这里硬写 `scope:'global'`，注释写的是"没有 chat 上下文时只展示
    //   global，避免跨群/私聊泄露"。但**模型写记忆根本不走 global**：
    //   `modules/act/executors/memory.js:908` `scope: derivedScope`（group/private，由本轮会话推导）
    //   + `:913` `chatKey: ctx.chatKey` ⇒ 刚记的人/事**一条都不会出现在记忆页左栏**，
    //   用户看到的是"我让它记了，页面上没有"——而数据其实在盘上（界面说谎的反面：有数据却不给看）。
    //   现在按**真实 scope 列**：默认全部生效观察，每条带自己的 scope/chatKey；
    //   要收窄就显式传 `?scope=global|group|private` 或 `?chatKey=group:123`。
    //   ⚠ 泄露口径没有放松 —— 但**不许**把守卫说大：`keyEndpointAllowed` 只守着
    //     `api/console.js` 的三条明文密钥端点（/api/api-key、/api/search-key、/api/providers/key），
    //     控制台其余路由（含本接口）**没有** token/origin 闸，能连到 127.0.0.1:<port> 的请求即可读。
    //     每条记忆都带 scope/chatKey，操作者一眼能看出是哪来的；"只给 global"不是安全边界，
    //     只是把页面变成空页面。
    const wantScope = String(query?.get?.('scope') ?? '').trim();
    const wantChat = String(query?.get?.('chatKey') ?? '').trim();
    if (wantScope && !['global', 'group', 'private'].includes(wantScope)) {
      return json(400, { ok: false, error: `scope 只支持 global|group|private（收到 ${wantScope}）` });
    }
    const history = memory.history(wantScope ? { scope: wantScope, dataDir } : { dataDir });
    let observations = (Array.isArray(history?.versions) ? history.versions : [])
      .filter((item) => item?.current === true && item?.scope);
    if (wantScope) observations = observations.filter((item) => item.scope === wantScope);
    if (wantChat) {
      // 指定会话 ⇒ 该会话的 group/private + 全局印象（global 本来就不属于任何会话）
      observations = observations.filter((item) => item.scope === 'global' || String(item.chatKey ?? '') === wantChat);
    }
    observations.sort((a, b) => Number(b?.at ?? 0) - Number(a?.at ?? 0) || String(a?.id ?? '').localeCompare(String(b?.id ?? '')));
    // ★ 投影：按 subjectId 分组（subjectId 就是人物标识）
    const bySubject = {};
    const emotion = getMod(ctx, 'emotion');
    for (const item of observations) {
      const sid = String(item?.subjectId ?? '');
      if (!sid) continue;
      if (!bySubject[sid]) {
        let favorVal = null;
        // ★ 2026-10-18（N2）：`known:false` = 这个人还没有关系记录（favor 是 PERSON_DEFAULTS 的中性 50，
        //   不是从聊天里算出来的）；null = 取不到。UI 据此区分"真实值 / 默认值 / 未知"，不再把默认值当记录。
        let favorKnown = null;
        if (typeof emotion?.relationOf === 'function') {
          try {
            const rel = emotion.relationOf({ senderId: sid });
            if (rel && typeof rel.favor === 'number') { favorVal = rel.favor; favorKnown = rel.known === true; }
          } catch (e) {}
        }
        bySubject[sid] = {
          userId: sid,
          impressions: [],
          name: typeof memory?.getSubjectName === 'function' ? memory.getSubjectName(sid, { dataDir }) : '未知',
          favor: favorVal,
          favorKnown,
          // 这个人在各 scope/会话里各有多少条（分栏用，不让前端再数一遍）
          scopes: {}
        };
      }
      bySubject[sid].impressions.push({
        // ★ 2026-10-17（用户/glm1：界面不能靠文本反推身份）：带上真实观察 id。
        //   `id` = 保留下来的那条观察；`observationIds` 在下面合并同文多来源时补齐（含本行 id）。
        id: String(item?.id ?? ''),
        text: String(item?.claim ?? ''),
        scope: item?.scope,
        chatKey: item?.chatKey ?? '',
        at: item?.at ?? item?.createdAt ?? null
      });
      const sk = `${item?.scope}:${item?.chatKey ?? ''}`;
      bySubject[sid].scopes[sk] = (bySubject[sid].scopes[sk] || 0) + 1;
    }
    // ★★ 新#3（用户 2026-10-11：分群是老设计 ⇒ **一个人一份**）：
    //   ① 聚合维度**只有 subjectId**，scope/chatKey **只当来源标注**留着（不删字段、不动盘上格式）；
    //   ② 同一个人的**同一条印象**在多个群里各写过一遍 ⇒ 只出一条，来源合并进那条的 `alsoIn`
    //      （照用户话："重复性很高"）。去重键 = 文本**去掉全部空白**后比较（只认逐字相同/仅空白差异，
    //      不猜语义近似）。
    //   ③ 每人给 `sourceCount/sources/multiSource`，响应给 `merge` 读数 —— 合并到底发生了什么，
    //      一眼可核（例：3 个会话 13 条 ⇒ 1 人 12 条，去重 1）。
    const impressionsBefore = Object.values(bySubject).reduce((n, p) => n + p.impressions.length, 0);
    let deduped = 0;
    let crossSourcePeople = 0;
    for (const p of Object.values(bySubject)) {
      const seen = new Map();               // 归一文本 → 保留下来的那条
      const kept = [];
      const sourceSet = new Set();          // 来源按**去重前**算全（这个人的内容确实来自这几个会话）
      for (const row of p.impressions) {
        const key = String(row.text ?? '').replace(/\s+/g, '');
        const src = `${row.scope}:${row.chatKey ?? ''}`;
        sourceSet.add(src);
        if (key && seen.has(key)) {
          const prev = seen.get(key);
          if (!prev.alsoIn.includes(src)) prev.alsoIn.push(src);
          // ★ 2026-10-17：同文多来源合并时**保留每一条真实观察 id**（界面/删除都不必再反推文本）。
          const rid = String(row.id ?? '');
          if (rid && !prev.observationIds.includes(rid)) prev.observationIds.push(rid);
          deduped += 1;
          continue;
        }
        row.alsoIn = [];
        row.observationIds = String(row.id ?? '') ? [String(row.id)] : [];
        if (key) seen.set(key, row);
        kept.push(row);
      }
      p.impressions = kept;
      // scopes 保持旧键形状、按去重后的条目重算（"每个来源还剩几条"，别处可能在读）
      const scopes = {};
      for (const row of kept) {
        const sk = `${row.scope}:${row.chatKey ?? ''}`;
        scopes[sk] = (scopes[sk] || 0) + 1;
      }
      p.scopes = scopes;
      p.sourceCount = sourceSet.size;
      p.sources = [...sourceSet];
      p.multiSource = sourceSet.size > 1;
      if (sourceSet.size > 1) crossSourcePeople += 1;
    }
    const impressionsAfter = impressionsBefore - deduped;
    const counts = { total: observations.length, global: 0, group: 0, private: 0 };
    for (const item of observations) {
      if (counts[item.scope] !== undefined) counts[item.scope] += 1;
    }
    const peopleList = Object.values(bySubject);
    return json(200, {
      ok: true,
      people: peopleList,
      source: 'memory.history.active',
      scope: wantScope || 'all',
      chatKey: wantChat || null,
      counts,
      // ★ 合并读数：只报真算出来的数，不编"合并前"的猜测
      merge: {
        dimension: 'subjectId（scope/chatKey 不作为分组维度）',
        people: peopleList.length,
        impressionsBefore,
        impressionsAfter,
        deduped,
        crossSourcePeople,
        summary: `${peopleList.length} 人 · ${impressionsAfter} 条`
          + `（跨 ${crossSourcePeople} 人有多个来源会话；去重 ${deduped} 条）`
      }
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/** GET /api/topics — 只读读取旧 topics 数据文件；不把 M6 claim 冒充为 topic。 */
export function getTopics(ctx) {
  const dataDir = String(ctx?.dataDir ?? '').trim();
  if (!dataDir) return notPorted('旧 topicStore.listTopics/listAll() 的数据目录需要显式 ctx.dataDir；未猜测或回退到 data/。');
  const topicsDir = path.join(dataDir, 'topics');
  let names;
  try { names = fs.readdirSync(topicsDir); }
  catch (error) {
    // 旧 TopicStore.listAll 把目录不存在视为尚无话题；其它目录错误必须可见。
    if (error?.code === 'ENOENT') return json(200, { ok: true, topics: [] });
    return json(500, { ok: false, error: `topics 目录读取失败：${String(error?.message ?? error)}` });
  }
  const topics = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('_')) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(topicsDir, name), 'utf8'));
      for (const topic of record?.topics ?? []) topics.push(topic);
    } catch { /* 与旧 listAll 一致：坏文件不拖垮其余可读话题。 */ }
  }
  return json(200, { ok: true, topics });
}

/** GET /api/cost-guard — 成本守护 */
export async function getCostGuard(ctx) {
  const obs = ctx?.obs;
  const memory = getMod(ctx, 'memory');
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  const llm = getMod(ctx, 'llm');
  if (!obs?.dayTokenTotal) {
    // 真日聚合不在位（observability 未升级）⇒ 501 点名，**不许退回 2000 行夹子冒充日总量**
    return notPorted('observability.dayTokenTotal（自然日 token 真聚合；core/observability/sink.js:95）'
      + ' —— 没有它只能拿 recent 的 2000 行冒充当日总量，会算小');
  }
  try {
    // ★ P0-b（sp3 2026-10-11）：响应原来没有 `enabled` / 上限 ⇒ 面板恒显示「/ 0」、护栏已关永不出现。
    //   这里从**真配置**读，不许在界面补默认值。
    // ★★ B7（2026-10-11 用户裁定）：口径改成**一个日上限、度量 = 当日 prompt+completion token**：
    //   · 配置键 `api.costGuard.dayTokenMax`（默认 30000000）；
    //   · 旧 `dayPromptMax` / `chatPromptMax` **不再参与判定**（迁移见 core/config-store/migrations.js
    //     的 migrateCostGuardTokenMax；单会话上限的干预按裁定去掉）；
    //   · 当日总量必须**真**：`obs.dayTokenTotal()` 是 observability 的日聚合出口
    //     （不受 recent 2000 行夹子影响，账本缺数时 `truncated=true` 如实回）。
    const guard = (typeof cs?.get === 'function' ? (cs.get('api.costGuard', {}) ?? {}) : {}) || {};
    const guardEnabled = guard.enabled !== false;
    const dayTokenMax = Number(guard.dayTokenMax) || 0;
    // ★ 2026-10-12（指挥位批准「只加键」）：预算**硬额度**状态，读法与上面 api.costGuard 同构
    //   （整块取 `api.budget` 再点字段 ⇒ 台账记 needle=api.budget / basis=parent）。
    //   `configured` **由真实配置推出来**：null / 空 / 非正数 ⇒ false；不许写死，也**不许拿软阈值
    //   `dayTokenMax` 顶替**（§10.2：软阈值是"超了削减注入"，不是"拒付"）。
    //   `budget.configured=false` 表示未设全局硬额度，不代表请求被全局硬额度拒绝；实例份额仍独立生效。
    const budgetCfg = (typeof cs?.get === 'function' ? (cs.get('api.budget', {}) ?? {}) : {}) || {};
    const hardLimitTokens = budgetCfg.hardLimitTokens == null || budgetCfg.hardLimitTokens === ''
      ? null : Number(budgetCfg.hardLimitTokens);
    const budgetConfigured = Number.isFinite(hardLimitTokens) && hardLimitTokens > 0;
    const day = await obs.dayTokenTotal({});
    const totalTokens = Number(day?.totalTokens) || 0;
    const totalPrompt = Number(day?.promptTokens) || 0;
    const totalCompletion = Number(day?.completionTokens) || 0;
    const truncated = day?.truncated === true;
    const todos = memory?.activeTodos ? (() => { try { return memory.activeTodos(); } catch { return []; } })() : [];
    return json(200, {
      ok: true,
      day: day?.date ?? new Date().toISOString().slice(0, 10),
      enabled: guardEnabled,
      // ↓ 新口径（面板按这两个显示："今日 X / 上限 N token"）
      dayTokenMax,
      totalTokens,
      totalPrompt,
      totalCompletion,
      usageRows: Number(day?.rows) || 0,
      truncated,
      // ↓ 明细（不计入判定，仅供展开看）
      totalCost: null,
      totalCalls: Number(day?.rows) || 0,
      todos: Array.isArray(todos) ? todos : [],
      // ↓ 预算硬额度状态（2026-10-12 只加这一个键；上面 enabled/dayTokenMax/todos 等一律原样）
      budget: {
        hardLimitTokens: budgetConfigured ? hardLimitTokens : null,
        instanceShares: budgetCfg.instanceShares ?? null,
        configured: budgetConfigured
      },
      source: 'observability.dayTokenTotal + config-store.api.costGuard + memory.activeTodos',
      note: `度量 = 当日 prompt+completion token 之和；超过 dayTokenMax（${dayTokenMax}）才启动护栏，未超不干预。`
        + (truncated ? ' ⚠ 账本不完整（有缺数/损坏/超容量），下方 token 数**偏小**，不能当真实总量。' : '')
        + ' 旧键 dayPromptMax/chatPromptMax 已不参与判定（只作迁移来源留档）。'
    });
  } catch (e) {
    return errorResponse(e);
  }
}

const JUDGE_SENT_WITHOUT_USAGE = new Set(['response-without-usage', 'request-sent-without-usage']);
const JUDGE_KNOWN_PRICE_SOURCES = new Set(['official', 'custom', 'manual']);

function localDayKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function timestampMs(value) {
  if (value == null || value === '') return NaN;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value).trim();
  if (/^\d{10,16}$/.test(text)) {
    const numeric = Number(text);
    return text.length <= 10 ? numeric * 1000 : numeric;
  }
  return Date.parse(text);
}

function nonnegativeTokens(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'object'
    || (typeof value === 'string' && !value.trim())) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function budgetHardLimitView(ctx) {
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  if (typeof cs?.get !== 'function') return { available: false, configured: null, hardLimitTokens: null };
  try {
    const budget = cs.get('api.budget', undefined);
    if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
      return { available: false, configured: null, hardLimitTokens: null };
    }
    const raw = budget.hardLimitTokens;
    if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) {
      return { available: true, configured: false, hardLimitTokens: null };
    }
    const limit = nonnegativeTokens(raw);
    return limit === null
      ? { available: true, configured: null, hardLimitTokens: null, invalid: true }
      : { available: true, configured: true, hardLimitTokens: limit };
  } catch {
    return { available: false, configured: null, hardLimitTokens: null };
  }
}

// S13（第四批 P2）：预算账按版本增量索引，不再每次请求全量重读重解。
const judgeLedgerIndex = createJudgeLedgerIndex({
  statFile(file) { return fs.statSync(file); },
  readRange(file, start, end) {
    const length = end - start;
    const bytes = Buffer.allocUnsafe(length);
    const fd = fs.openSync(file, 'r');
    try {
      let offset = 0;
      while (offset < length) {
        const read = fs.readSync(fd, bytes, offset, length - offset, start + offset);
        if (read <= 0) {
          const error = new Error(`short read: ${file}`);
          error.code = 'SHORT_READ';
          throw error;
        }
        offset += read;
      }
    } finally { fs.closeSync(fd); }
    return bytes;
  }
});

function readJudgeBudgetRows(ctx, day) {
  const dataDir = String(ctx?.dataDir ?? '').trim();
  if (!dataDir) return { available: false, error: 'missing-explicit-dataDir', rows: [], malformedRows: 0 };
  const result = judgeLedgerIndex.read(path.join(dataDir, 'budget', 'requests.jsonl'), day);
  if (!result.available) return { available: false, error: result.error, rows: [], malformedRows: 0 };
  const rows = result.rows.filter((row) => row?.purpose === 'cloud_judge' && row?.date === day);
  return { available: true, file: 'budget/requests.jsonl', rows, malformedRows: result.malformedRows };
}

function judgeSentState(row) {
  if (row?.status === 'settled' && nonnegativeTokens(row.actualTokens) !== null) return 'known';
  if (row?.status === 'unknown' && JUDGE_SENT_WITHOUT_USAGE.has(String(row.outcomeCode ?? ''))) return 'unknown';
  if (row?.status === 'reserved') return 'pending';
  if (row?.status === 'cancelled' || row?.status === 'rejected') return 'not-sent';
  return 'unclassified';
}

function sessionStartedDay(value) {
  const at = timestampMs(value);
  return Number.isFinite(at) ? localDayKey(at) : '';
}

// S13（第四批 P2）：终态会话按 (sessionsDir, id, 文件版本) 复用 turnPlan 抽取结果；
// 活会话与拿不到 sessionsDir（注入式假登记表）时回退逐次 get，保持原语义。
const JUDGE_SESSION_CACHE_MAX = 1024;
const judgeSessionExtractCache = new Map();

function readJudgeSessionExtract(registry, id) {
  const session = registry.get(id);
  if (!session) return null;
  const plan = session?.turnPlan;
  return { plan, jev: plan?.jevSummary };
}

function judgeSessionExtractCached(registry, summary) {
  const id = summary?.id;
  const live = summary?.status === 'running' || summary?.status === 'waiting';
  const dir = typeof registry?.sessionsDir === 'string' && registry.sessionsDir ? registry.sessionsDir : '';
  if (!dir || live) return readJudgeSessionExtract(registry, id);
  const key = `${dir}\u0000${String(id ?? '')}`;
  let version;
  try {
    const stat = fs.statSync(sessionFile(id, dir));
    version = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    judgeSessionExtractCache.delete(key);
    return readJudgeSessionExtract(registry, id);
  }
  const cached = judgeSessionExtractCache.get(key);
  if (cached && cached.version === version) {
    judgeSessionExtractCache.delete(key);
    judgeSessionExtractCache.set(key, cached);
    return cached.extract;
  }
  const extract = readJudgeSessionExtract(registry, id);
  judgeSessionExtractCache.delete(key);
  judgeSessionExtractCache.set(key, { version, extract });
  while (judgeSessionExtractCache.size > JUDGE_SESSION_CACHE_MAX) {
    judgeSessionExtractCache.delete(judgeSessionExtractCache.keys().next().value);
  }
  return extract;
}

async function judgeSessionStats(ctx, day, sentRows) {
  const registry = sessionsFor(ctx);
  const emptyStats = {
    available: false,
    todaySessionCount: null,
    matchedCalls: 0,
    unmatchedCalls: sentRows.length,
    memoryInjection: { injectedItems: null, knownCalls: 0, unknownCalls: sentRows.length, complete: false },
    crossChat: { successfulReads: null, returnedItems: null, unknownReads: sentRows.length, complete: false }
  };
  const empty = { stats: emptyStats, byRequestId: new Map() };
  if (!registry || typeof registry.listSummaries !== 'function' || typeof registry.get !== 'function') return empty;
  try {
    const summaries = registry.listSummaries({ limit: 1048576, readOnly: true });
    if (!Array.isArray(summaries)) return empty;
    const diag = typeof registry.diagnostics === 'function' ? registry.diagnostics() : null;
    if (diag?.dirReadable === false) return empty;
    const today = summaries.filter((row) => sessionStartedDay(row?.startedAt) === day);
    const matched = new Map();
    const sentIds = new Set(sentRows.map((row) => String(row.requestId ?? '')));
    let readErrors = 0;
    let scanned = 0;
    for (const summary of today) {
      // Yield before each batch; count skipped/error rows as well.
      if (scanned++ % 32 === 0) await new Promise((resolve) => setImmediate(resolve));
      let extract;
      try { extract = judgeSessionExtractCached(registry, summary); }
      catch { readErrors += 1; continue; }
      if (!extract) { readErrors += 1; continue; }
      const plan = extract.plan;
      const jev = extract.jev;
      if (jev?.requestState !== 'called') continue;
      const requestId = String(jev.requestId ?? '').trim();
      if (!requestId || !sentIds.has(requestId)) continue;
      if (!matched.has(requestId)) matched.set(requestId, { plan, jev });
    }

    let injectedItems = 0;
    let injectionKnownCalls = 0;
    let successfulReads = 0;
    let returnedItems = 0;
    let crossUnknownReads = 0;
    let crossCountUnknown = false;
    for (const requestId of sentIds) {
      const record = matched.get(requestId);
      if (!record) {
        crossUnknownReads += 1;
        continue;
      }
      const count = nonnegativeTokens(record.plan?.memoryInjection?.selectedCount);
      if (count !== null) { injectionKnownCalls += 1; injectedItems += count; }

      if (!['reply', 'continue'].includes(String(record.plan?.action ?? ''))) continue;
      const cross = record.jev.memoryRecall?.crossChat;
      if (record.jev.memoryCrossChat === false || cross?.state === 'not-requested') continue;
      if (['available', 'empty'].includes(String(cross?.state ?? ''))) {
        successfulReads += 1;
        const items = nonnegativeTokens(cross?.count);
        if (items !== null) returnedItems += items;
        else crossCountUnknown = true;
      } else crossUnknownReads += 1;
    }
    const unmatchedCalls = [...sentIds].filter((requestId) => !matched.has(requestId)).length;
    const sessionAvailable = readErrors === 0;
    return {
      byRequestId: matched,
      stats: {
        available: sessionAvailable,
        todaySessionCount: today.length,
        matchedCalls: matched.size,
        unmatchedCalls,
        memoryInjection: {
          injectedItems: sessionAvailable ? injectedItems : null,
          knownCalls: injectionKnownCalls,
          unknownCalls: Math.max(sentRows.length - injectionKnownCalls, readErrors),
          complete: sessionAvailable && injectionKnownCalls === sentRows.length
        },
        crossChat: {
          successfulReads: sessionAvailable ? successfulReads : null,
          returnedItems: sessionAvailable ? returnedItems : null,
          unknownReads: crossUnknownReads + (readErrors > 0 ? 1 : 0) + (crossCountUnknown ? 1 : 0),
          complete: sessionAvailable && crossUnknownReads === 0 && !crossCountUnknown
        }
      }
    };
  } catch {
    return empty;
  }
}

/** GET /api/judge-usage — cloud_judge 预算账 + 当日会话 turnPlan 的只读聚合。 */
export async function getJudgeUsage(ctx, now = Date.now()) {
  const day = localDayKey(now);
  const hardLimit = budgetHardLimitView(ctx);
  const ledger = readJudgeBudgetRows(ctx, day);
  if (!ledger.available) {
    return json(200, {
      ok: true, day, hardLimit,
      budget: { available: false, sentCalls: null, knownCalls: null, unknownTokenCalls: null, pendingCalls: null, unclassifiedCalls: null,
        knownTotalTokens: null, tokenTotalComplete: false, averageKnownTokens: null, estimatedCostYuan: null,
        pricedCalls: 0, costUnknownCalls: null, calls: [], malformedRows: null },
      sessions: { available: false, todaySessionCount: null, matchedCalls: 0, unmatchedCalls: null,
        memoryInjection: { injectedItems: null, knownCalls: 0, unknownCalls: null, complete: false },
        crossChat: { successfulReads: null, returnedItems: null, unknownReads: null, complete: false } },
      source: { budget: 'dataDir/budget/requests.jsonl', sessions: 'session.turnPlan' },
      error: `budget-ledger-unavailable:${ledger.error}`
    });
  }

  const latestRows = ledger.rows;
  const sentRows = [];
  let pendingCalls = 0;
  let notSentCalls = 0;
  let unclassifiedCalls = 0;
  let knownTotalTokens = 0;
  let knownCalls = 0;
  let unknownTokenCalls = 0;
  let estimatedCostYuan = 0;
  let pricedCalls = 0;
  let costUnknownCalls = 0;
  let estimateInputsComplete = ledger.malformedRows === 0;
  const llm = getMod(ctx, 'llm');
  const getPrice = createPriceCache(makePriceOf(ctx, llm));
  const internalCalls = [];

  for (const row of latestRows) {
    const state = judgeSentState(row);
    if (state === 'pending') { pendingCalls += 1; continue; }
    if (state === 'not-sent') { notSentCalls += 1; continue; }
    if (state === 'unclassified') { unclassifiedCalls += 1; estimateInputsComplete = false; continue; }
    sentRows.push(row);
    const actualTokens = state === 'known' ? nonnegativeTokens(row.actualTokens) : null;
    if (actualTokens === null) unknownTokenCalls += 1;
    else { knownCalls += 1; knownTotalTokens += actualTokens; }

    let cost = null;
    if (state === 'known') {
      const promptTokens = nonnegativeTokens(row.promptTokens);
      const completionTokens = nonnegativeTokens(row.completionTokens);
      let price = null;
      try { price = row.model ? getPrice(String(row.model), '') : null; } catch { /* 该模型无法计价时保留未知 */ }
      const priced = price && JUDGE_KNOWN_PRICE_SOURCES.has(String(price.source ?? ''))
        && Number.isFinite(Number(price.in)) && Number.isFinite(Number(price.out));
      if (promptTokens !== null && completionTokens !== null && priced && llm) {
        const at = timestampMs(row.at);
        const costRow = { model: String(row.model), vendor: '', at: Number.isFinite(at) ? at : now,
          promptTokens, completionTokens, cachedTokens: 0, cacheCreationTokens: 0 };
        try {
          cost = costOfRows([costRow], getPrice, llm).cost;
          if (Number.isFinite(cost)) { estimatedCostYuan += cost; pricedCalls += 1; }
          else { cost = null; costUnknownCalls += 1; estimateInputsComplete = false; }
        } catch {
          cost = null; costUnknownCalls += 1; estimateInputsComplete = false;
        }
      } else { costUnknownCalls += 1; estimateInputsComplete = false; }
    } else { costUnknownCalls += 1; estimateInputsComplete = false; }

    internalCalls.push({
      requestId: String(row.requestId ?? ''),
      at: Number.isFinite(timestampMs(row.at)) ? new Date(timestampMs(row.at)).toISOString() : null,
      actualTokens, promptTokens: nonnegativeTokens(row.promptTokens), completionTokens: nonnegativeTokens(row.completionTokens),
      estimatedCostYuan: cost
    });
  }

  internalCalls.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
  const sessionData = await judgeSessionStats(ctx, day, sentRows);
  const sessionStats = sessionData.stats;
  for (const call of internalCalls) {
    const session = sessionData.byRequestId.get(call.requestId);
    const count = nonnegativeTokens(session?.plan?.memoryInjection?.selectedCount);
    call.memoryInjectedItems = count;
    call.crossChatRead = 'unknown';
    call.crossChatItems = null;
    if (session && (!['reply', 'continue'].includes(String(session.plan?.action ?? ''))
      || session.jev?.memoryCrossChat === false || session.jev?.memoryRecall?.crossChat?.state === 'not-requested')) {
      call.crossChatRead = 'not-requested';
      call.crossChatItems = 0;
    } else if (session) {
      const cross = session.jev.memoryRecall?.crossChat;
      if (['available', 'empty'].includes(String(cross?.state ?? ''))) {
        call.crossChatRead = 'success';
        call.crossChatItems = nonnegativeTokens(cross.count);
      }
    }
  }
  const sessions = sessionStats;

  const calls = internalCalls.map((row, index) => ({
    index: index + 1, at: row.at, actualTokens: row.actualTokens,
    promptTokens: row.promptTokens, completionTokens: row.completionTokens,
    estimatedCostYuan: row.estimatedCostYuan,
    memoryInjectedItems: row.memoryInjectedItems,
    crossChatRead: row.crossChatRead, crossChatItems: row.crossChatItems
  }));
  return json(200, {
    ok: true, day, hardLimit,
    budget: {
      available: true,
      sentCalls: sentRows.length,
      knownCalls,
      unknownTokenCalls,
      pendingCalls,
      unclassifiedCalls,
      notSentCalls,
      knownTotalTokens,
      tokenTotalComplete: unknownTokenCalls === 0 && pendingCalls === 0 && unclassifiedCalls === 0 && ledger.malformedRows === 0,
      averageKnownTokens: knownCalls ? knownTotalTokens / knownCalls : null,
      estimatedCostYuan: sentRows.length === 0 || pricedCalls > 0 ? estimatedCostYuan : null,
      costEstimateComplete: estimateInputsComplete && costUnknownCalls === 0,
      pricedCalls,
      costUnknownCalls,
      malformedRows: ledger.malformedRows,
      calls
    },
    sessions,
    source: { budget: 'dataDir/budget/requests.jsonl', sessions: 'session.turnPlan', pricing: '当前模型价格设置估算' },
    note: '金额按当前价格设置估算；预算账未记录缓存 token 拆分，输入按普通输入价格估算。跨群读取次数只统计 turnPlan 中状态为 available/empty 的成功读取。'
  });
}

/** GET /api/memory-audit —— 归分片 `api/memory.js`（读 audit.jsonl + M6 观察变更账 + 好感两段账）。
 * 本文件曾有一个同名实现，但分发一直把 `body` 当 `query` 传 ⇒ 它恒返回 null（从未生效），
 * 2026-10-12 P1 消重时删除：留着只会让下一个人读到一份"看起来像实现"的死代码。
 * （真实响应含 `observationChanges`/`favorStream` 等键，见 api/memory.js 的 memory-audit 分支。） */

/** GET /api/memory-guard — 记忆守护 */
export async function getMemoryGuard(ctx) {
  const memory = getMod(ctx, 'memory');
  if (typeof memory?.runtimeStatus !== 'function') {
    return notPorted('modules/memory.runtimeStatus({ dataDir, coordinator })');
  }
  try {
    const status = await memory.runtimeStatus({
      dataDir: ctx?.dataDir,
      coordinator: ctx?.memoryCoordinator ?? null,
    });
    return json(200, status);
  } catch (error) {
    return errorResponse(error);
  }
}

/** GET /api/hype-mode — 亢奋模式状态 */
export function getHypeMode(ctx) {
  const emotion = getMod(ctx, 'emotion');
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  // 已接线：emotion.isHypeMode 定义在 modules/emotion/hype-mode.js:35（re-exported at index.js:33）
  try {
    const enabled = emotion.isHypeMode();
    // ★ UI 读 hy.emotionThreshold 和 hy.emotionAutoExitMin（app.js:14557-14558）
    //   从配置真读（config-store 的 hypeMode 配置），不编默认值
    const emotionThreshold = cs?.get?.('hypeMode.emotionThreshold', null) ?? null;
    const emotionAutoExitMin = cs?.get?.('hypeMode.emotionAutoExitMin', null) ?? null;
    return json(200, {
      ok: true,
      enabled,
      emotionThreshold,
      emotionAutoExitMin,
      source: 'emotion.isHypeMode + config-store.hypeMode'
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST /api/hype-mode — 亢奋模式开关（写配置，副作用归 M7 owner） */
export function postHypeMode(ctx, body) {
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  // 已接线：config-store.updateConfigAndSave 定义在 core/config-store/index.js:442
  try {
    const paramPatch = {};
    if (body?.emotionThreshold !== undefined) {
      paramPatch.emotionThreshold = Math.min(200, Math.max(0, Math.round(Number(body.emotionThreshold) || 0)));
    }
    if (body?.emotionAutoExitMin !== undefined) {
      paramPatch.emotionAutoExitMin = Math.min(1440, Math.max(0, Math.round(Number(body.emotionAutoExitMin) || 0)));
    }
    if (body?.enabled !== undefined || body?.on !== undefined) {
      paramPatch.enabled = body?.enabled === true || body?.on === true;
    }
    const enabled = paramPatch.enabled ?? false;
    let result = { changed: false };
    if (Object.keys(paramPatch).length) {
      const hm = cs.get('hypeMode') || {};
      const persona = cs.get('persona') || {};
      const api = cs.get('api') || {};
      const configUpdates = {};
      const nextHm = { ...hm, ...paramPatch };
      
      if (paramPatch.enabled === true && !hm.enabled) {
        nextHm.stats = { enteredAt: Date.now(), reason: 'manual' };
        nextHm.saved = {
          roleText: persona.roleText,
          systemMode: persona.systemMode,
          compactSystemPrompt: persona.compactSystemPrompt,
          tools: api.tools
        };
        const hypeModel = nextHm.model || 'qwen3.8-flash';
        configUpdates.persona = {
          ...persona,
          systemMode: 'hype',
          roleText: '## 亢奋模式\n' + (persona.roleText || '')
        };
        configUpdates.api = {
          ...api,
          model: hypeModel,
          tools: ['send_message', 'finish']
        };
      } else if (paramPatch.enabled === false && hm.enabled) {
        const saved = hm.saved || {};
        const normalMode = saved.systemMode && saved.systemMode !== 'hype' ? saved.systemMode : 'lean';
        let nextRoleText = saved.roleText || persona.roleText || '';
        if (nextRoleText.startsWith('## 亢奋模式\n')) {
           nextRoleText = nextRoleText.slice('## 亢奋模式\n'.length);
        }
        configUpdates.persona = {
          ...persona,
          systemMode: normalMode,
          roleText: nextRoleText,
          compactSystemPrompt: saved.compactSystemPrompt != null ? saved.compactSystemPrompt : false
        };
        configUpdates.api = {
          ...api,
          model: nextHm.restoreModel || 'qwen3.8-flash',
          tools: Array.isArray(saved.tools) && saved.tools.length ? saved.tools : []
        };
        nextHm.stats = null;
      }
      
      configUpdates.hypeMode = nextHm;
      result = cs.updateConfigAndSave(configUpdates, { backup: true, log: ctx?.log ?? (() => {}) });
    }
    return json(200, {
      ok: true,
      enabled,
      changed: result?.changed ?? true,
      source: 'config-store.updateConfigAndSave',
      notPorted: 'switchHypeAvatar: M7 亢奋模式不自动换头像（纯状态模型已隔离副作用），但人设与协议已接上'
    });
  } catch (e) {
    return errorResponse(e);
  }
}

  /** GET /api/local-jev — 本地 Jev 状态 */
  export function getLocalJev(ctx) {
  const jev = getMod(ctx, 'jev');
  // 已接线：jev.stats 定义在 modules/jev/core.js:243
  try {
    const stats = jev.stats();
    // ★ 2026-10-16（独立云判定）：判定"用的是谁/思考态/预算/为什么不可用"由装配层如实给出；
    //   出口缺失就留 null（不凭空造 available）。
    return json(200, { ok: true, ...stats, judge: judgeAvailabilityOf(ctx) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** 装配层的判定可用状态（modulesObj.getJudgeAvailability）；缺失/抛错 ⇒ null，不伪造。 */
function judgeAvailabilityOf(ctx, { kind = 'group' } = {}) {
  try {
    const fn = ctx?.modulesObj?.getJudgeAvailability;
    return typeof fn === 'function' ? (fn({ kind }) ?? null) : null;
  } catch { return null; }
}

/**
 * POST /api/vector/apply — 立即应用「向量语义召回」配置（**只动本装配实例自己 owned 的 runtime**）。
 *   · enabled=true ⇒ startVectorEmbedding()（模型/端口/开关变过时内部会真重启；就绪后重建并重新发布
 *     Memory Coordinator，让已存在的 coordinator 真的拿到索引）；
 *   · enabled=false ⇒ stopVectorEmbedding()（索引随之摘除，记忆回落关键词召回）。
 * 状态语义分开给：进程 state / 索引 index / 最近查询 lastRecallQueries 各自独立，失败按 500 原样透出。
 */
export async function postVectorApply(ctx) {
  if (typeof ctx?.startVectorEmbedding !== 'function' || typeof ctx?.stopVectorEmbedding !== 'function') {
    return notPorted('apps/server/assembly.startVectorEmbedding/stopVectorEmbedding —— 向量运行时出口未注入');
  }
  try {
    const before = typeof ctx.vectorEmbeddingStatus === 'function' ? ctx.vectorEmbeddingStatus() : null;
    const enabled = before?.configuredEnabled === true;
    const result = enabled ? await ctx.startVectorEmbedding() : await ctx.stopVectorEmbedding();
    const after = typeof ctx.vectorEmbeddingStatus === 'function' ? ctx.vectorEmbeddingStatus() : null;
    return json(200, {
      ok: true, applied: true, action: enabled ? 'start' : 'stop',
      result: result ?? null,
      vectorEmbedding: after,
      note: enabled
        ? '已按当前配置启动/重启自有向量 runtime；index 才是索引层，lastRecallQueries 能看出最近几轮是否真的走了 semantic。'
        : '已停止自有向量 runtime 并摘除索引；记忆回落关键词召回。'
    });
  } catch (e) { return errorResponse(e); }
}

/**
 * GET /api/judge-diagnostics — 云判定最近的判据行（**只读**，供设置页诊断面板）。
 *
 * 数据源 = `jev.observationRows`（进程内环形账，最多 200 行、重启清空；盘上账本仍按 observability
 * 的 schema 走）。本端点只放"能定位未完成"的有限字段：状态/原因/失败分档/HTTP 状态/耗时/生效超时/
 * 模型/端点风格/提供商主机/思考是否真下发/输出预算/正文字数与思考字数/usage。
 * **不含聊天正文、不含凭据**；reason 已由 core 的 classifyJudgeFailure 脱敏（Bearer、sk- 前缀、apiKey= 等）。
 */
export function getJudgeDiagnostics(ctx) {
  const jev = getMod(ctx, 'jev');
  if (!jev || typeof jev.observationRows !== 'function') {
    return notPorted('jev.observationRows（modules/jev/index.js）—— 云判定诊断出口未注入');
  }
  try {
    const rows = jev.observationRows({ n: 200 })
      .filter((row) => row && row.role === 'judge3')
      .slice(-40)
      .reverse();   // 最新在前
    return json(200, {
      ok: true,
      role: 'judge3',
      rows,
      count: rows.length,
      judge: judgeAvailabilityOf(ctx),
      note: '进程内环形账最近 40 条（最多保留 200 条、重启清空）；只含状态/原因/枚举/长度，不含聊天正文与凭据。',
      source: 'jev.observationRows'
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/** GET /api/model-prices — 模型价格 */
export function getModelPrices(ctx) {
  const llm = getMod(ctx, 'llm');
  if (!llm?.listOfficialPrices) return notPorted('llm.listOfficialPrices');
  try {
    const prices = llm.listOfficialPrices();
    return json(200, { ok: true, prices });
  } catch (e) {
    return errorResponse(e);
  }
}

/** GET /api/providers — LLM 提供商列表 */
export function getProviders(ctx) {
  const llm = getMod(ctx, 'llm');
  // 已接线：llm.currentProviders 定义在 modules/llm/providers.js:116
  try {
    // ★ 2026-10-12（凭据脱敏）：`currentProviders()` 回的是**已解析的明文 Key**，
    //   这里原来直接发出去 —— 既把明文 Key 外发，界面还每项显示「⚠无密钥」
    //   （它读的是 hasKey，apps/ui/app.js:11614/12187/12200）。
    //   现在按旧树 src/app.js:2185-2188 的口径：Key 一律回空串，有没有 Key 用 hasKey 表示；
    //   其余字段原样保留（不按旧树白名单裁字段，避免动掉界面可能在读的键）。
    const providers = (llm.currentProviders() || []).map((p) => {
      // ★ 2026-10-17（每厂商缓存策略）：按 provider 各存一份；读时归一（非法回 auto 并带原因），
      //   原字段值原样保留在 p.cacheStrategy 之外不动盘上配置。仍然不回显 key（只留 hasKey 布尔）。
      const strategy = readCacheStrategyOf(ctx, p?.cacheStrategy);
      return {
        ...p,
        // ★ 2026-10-16（用户反馈 `custom_*` 难看）：给 UI 一个**安全可显示名** —— 配置里的 name 优先，
        //   其次地址主机名，最后才是 id。密钥仍然一律回空串（只留 hasKey 布尔），不回显也不进日志。
        name: String(p.name ?? '').trim() || safeHostLabelOf(p.baseURL ?? p.baseUrl) || String(p.id ?? ''),
        cacheStrategy: strategy.selected,
        cacheStrategySource: strategy.source,
        ...(strategy.reason ? { cacheStrategyReason: strategy.reason } : {}),
        apiKey: '',
        hasKey: !!p.apiKey
      };
    });
    return json(200, { ok: true, providers });
  } catch (e) {
    return errorResponse(e);
  }
}

function savePersonaRoleText(ctx, nextRoleText) {
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  const persona = { ...(cs?.get?.('persona', {}) || {}), roleText: nextRoleText };
  // ★ P1 配置收敛（2026-10-12）：删掉「updateConfig + saveConfig」两步兜底 —— 装配出来的
  //   配置仓库必有 updateConfigAndSave（core/config-store/index.js），那个分支永远不会走到。
  //   现在只有两条路：标准入口落盘；出口缺失就明说，不悄悄退回两步写。
  if (typeof cs?.updateConfigAndSave === 'function') {
    return cs.updateConfigAndSave({ persona }, { backup: true, log: ctx?.log ?? (() => {}) });
  }
  throw new Error('缺少配置落盘出口：config-store.updateConfigAndSave');
}

function setSelfImpressionsList(ctx, items) {
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  const roleText = String(cs?.get?.('persona.roleText', '') ?? '');
  const renderFn = getMod(ctx, 'act')?.renderSelfImpressions || renderSelfImpressions;
  const parseFn = getMod(ctx, 'act')?.parseSelfImpressions || parseSelfImpressions;
  const nextRole = renderFn(roleText, items);
  savePersonaRoleText(ctx, nextRole);
  const reloaded = String(cs?.get?.('persona.roleText', '') ?? nextRole);
  return { ok: true, items: parseFn(reloaded), roleText: reloaded };
}

function addOneSelfImpression(ctx, text) {
  const line = String(text || '').trim().slice(0, 160);
  if (!line) return { ok: false, error: '内容为空' };
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  const roleText = String(cs?.get?.('persona.roleText', '') ?? '');
  const parseFn = getMod(ctx, 'act')?.parseSelfImpressions || parseSelfImpressions;
  const list = parseFn(roleText);
  if (list.includes(line)) return { ok: true, items: list, deduped: true };
  return setSelfImpressionsList(ctx, [...list, line]);
}

function removeOneSelfImpression(ctx, text) {
  const line = String(text || '').trim();
  if (!line) return { ok: false, error: '内容为空' };
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  const roleText = String(cs?.get?.('persona.roleText', '') ?? '');
  const parseFn = getMod(ctx, 'act')?.parseSelfImpressions || parseSelfImpressions;
  const list = parseFn(roleText);
  const next = list.filter((s) => s !== line);
  if (next.length === list.length) return { ok: false, error: '没找到这条印象' };
  return setSelfImpressionsList(ctx, next);
}

/** GET /api/self-impressions — 自我印象（旧契约 src/app.js:2949-2954） */
export function getSelfImpressions(ctx) {
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  // ★ A7（sp3 2026-10-11）：缺出口 ⇒ 501 点名。这条守卫原来在 api/console.js 那份（已让路）上，
  //   收敛时一并搬过来 —— 否则 `cs.get` 不在位会静默回 `{items:[]}`，
  //   把"读不到"演成"一条自我印象都没有"（正是铁律禁的"空数据假装没有"）。
  if (typeof cs?.get !== 'function') {
    return notPorted('ctx.configStore.get（读 persona.roleText）—— 缺它会把「读不到」演成「一条都没有」');
  }
  const roleText = String(cs?.get?.('persona.roleText', '') ?? '');
  const parseFn = getMod(ctx, 'act')?.parseSelfImpressions || parseSelfImpressions;
  const items = parseFn(roleText);
  const botName = String(cs?.get?.('persona.botName', '小鲸鱼') || '小鲸鱼');
  return json(200, { items, botName });
}

/** POST /api/self-impressions — 新增/删除/整段替换自我印象（旧契约 src/app.js:2956-2976） */
export function postSelfImpressions(ctx, body) {
  try {
    let r;
    if (Array.isArray(body?.items)) {
      r = setSelfImpressionsList(ctx, body.items);
    } else if (body?.remove != null) {
      r = removeOneSelfImpression(ctx, String(body.remove));
    } else if (body?.add != null) {
      r = addOneSelfImpression(ctx, String(body.add));
    } else {
      return json(400, { ok: false, error: '需要 items / add / remove' });
    }
    if (!r.ok) return json(400, r);
    return json(200, r);
  } catch (error) {
    return errorResponse(error);
  }
}

/** DELETE /api/self-impressions — 删除自我印象（旧契约 src/app.js:2977-2988） */
export function deleteSelfImpressions(ctx, body) {
  try {
    const text = String(body?.text ?? body?.remove ?? '');
    const r = removeOneSelfImpression(ctx, text);
    if (!r.ok) return json(400, r);
    return json(200, r);
  } catch (error) {
    return errorResponse(error);
  }
}

/** GET /api/semantic-cards — legacy archive cards are not M6 claim cards. */
export function getSemanticCards() {
  // The legacy cards differ from M6 claim cards, but api/memory.js owns a truthful adapter + fieldGaps.
  // Return null so HTTP dispatch can pass this route to that slice instead of shadowing it with a stub.
  return null;
}

/**
 * POST /api/usage/reset — 调试：把**用量统计**清零（2026-10-16 用户明确要修；覆盖一般「未搬 UI 不补」裁定）。
 *
 * 语义（与老树 `src/app.js:1944-1966` 的区别写清楚，别照搬旧行为）：
 *   · **不物理删账**：老树清台账 + 覆写 usage-today.json + **删 history-cold** + clearDailyUsage；
 *     新树只写一条**持久清零边界**（`core/observability/usage-reset.js`），所有用法统计
 *     （用量页 / 顶栏 / 分天 / 按会话 / 按模型 / breakdown）从边界重新累计。
 *   · **原始观测账、会话正文、记忆、history-cut/history-cold、预算预留/结算与日硬额度一律不动**
 *     —— 清统计不等于清付费事实（预算侧读的是 dayTokenTotal/预算账本，本端点不经手）。
 *   · 写边界失败（无 obsDir / 写盘失败 / 写后校验不符）⇒ **如实 500，不报成功**。
 *   · 正在进行的请求在清零后完成 ⇒ 其 usage 行 at 晚于边界 ⇒ 计入新统计（付费发生在边界之后）。
 */
export async function postUsageReset(ctx) {
  const obs = ctx?.obs;
  if (!obs || typeof obs.writeUsageResetBoundary !== 'function') {
    return notPorted('observability.writeUsageResetBoundary（core/observability/usage-reset.js）—— 统计清零边界出口未注入');
  }
  try {
    // ① 先排空在途写队列：让"边界之前的内容已落盘"这件事有确定答案（队列排不动也不改变边界语义，继续）。
    try { if (typeof obs.flush === 'function') await obs.flush(); } catch { /* 如实继续；下面的边界写后校验才是成败判据 */ }
    // ② 取边界时刻并写入（原子写 + 写后校验；失败一律 ok:false）
    const at = Date.now();
    const written = await obs.writeUsageResetBoundary({ at, note: 'debug-reset' });
    if (!written?.ok) {
      return json(500, {
        ok: false, executed: false,
        error: String(written?.error || '清零边界写入失败'),
        boundaryState: String(written?.state || 'write-failed')
      });
    }
    // ③ 读回边界（给用户看"从哪一刻开始重新累计"）；sink 健康一并带出，部分失败不藏
    let boundary = null;
    try { boundary = typeof obs.usageResetStatus === 'function' ? await obs.usageResetStatus() : null; } catch { boundary = null; }
    let sinkHealth = null;
    try {
      const stats = typeof obs.stats === 'function' ? obs.stats() : null;
      if (stats?.sink) {
        sinkHealth = {
          integrityStatus: stats.sink.integrityStatus ?? null,
          writeFailures: Number.isFinite(Number(stats.sink.writeFailures)) ? Number(stats.sink.writeFailures) : null,
          rowsDropped: Number.isFinite(Number(stats.sink.rowsDropped)) ? Number(stats.sink.rowsDropped) : null
        };
      }
    } catch { sinkHealth = null; }
    try { ctx?.log?.(`[usage] 调试清零：统计自 ${written.atIso} 重新累计（原始台账与预算未动）`); } catch { /* 日志不许反噬 */ }
    return json(200, {
      ok: true, executed: true,
      at: written.at, atIso: written.atIso,
      // ★ 2026-10-16 收口：单调写入的可诊断字段（不改语义）——
      //   `kept-existing` = 已有更晚/同刻边界、不写低（清零语义已被更晚边界覆盖）；
      //   `kept-newer-concurrent` = 写后被并发清零写了更晚的边界（读回值更高，同样满足"从清零点重算"）。
      ...(written.monotonic ? { monotonic: written.monotonic } : {}),
      ...(written.previousAt !== undefined ? { previousAt: written.previousAt } : {}),
      boundary: {
        state: boundary?.state ?? 'ok',
        at: boundary?.at ?? written.at,
        atIso: boundary?.atIso ?? written.atIso,
        file: boundary?.file ?? written.file ?? ''
      },
      note: `统计已自 ${written.atIso} 重新累计：用量页与顶栏／按天／按会话／按模型／明细都从 0 起算。原始观测台账保留（排障可查）；会话、聊天记录、记忆、history-cut/history-cold、预算预留/结算与日硬额度均未改动。`,
      resetScope: ['用量统计（用量页 · 顶栏 · 分天 · 按会话 · 按模型 · breakdown）'],
      kept: ['观测原始台账（obs/*.ndjson，未删）', 'ChatStore 会话与聊天正文', '记忆/印象/情节摘要', 'history-cut / history-cold 缓存', '预算预留/结算与日硬额度'],
      ...(sinkHealth ? { sinkHealth } : {})
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** GET /api/emotion-personalities — 情绪人格配置 */
export function getEmotionPersonalities(ctx) {
  const emotion = getMod(ctx, 'emotion');
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  // 已接线：emotion.EMOTION_PROFILES 定义在 modules/emotion/state.js:216（re-exported at index.js:15）
  try {
    const profiles = emotion.EMOTION_PROFILES;
    // ★ N33（N30 回执 #22 + §四.5）：形状逐字照老树 `src/emotion-personality.js:178-192` 的
    //   `listEmotionProfiles()` —— 改前少了 `fear` / `rampThreshold` / `posRampThreshold` 三项。
    const list = Object.values(profiles)
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
      .map((p) => ({
        id: p.id, number: p.number, name: p.name, en: p.en,
        mean: p.mean, fear: p.fear,
        // 老树旧字段：负向阈值指向 softCeil.floors[2]（保持不变）
        rampThreshold: Number(p.softCeil?.floors?.[2]) || 52,
        // 老树新字段：正向阈值指向 softCeilPos.floors[1]（正向 UI 40 分膝盖）
        posRampThreshold: Number(p.softCeilPos?.floors?.[1]) || 40,
        tip: p.tip || p.focus,
        desc: p.desc || p.mean
      }));
    // ★ N33：`current` 过去**原样回配置值** ⇒ 配置里存着旧 6 档 id（`extrovert_sunny` 等）时，
    //   它不在 `list` 里 ⇒ 面板一个都不高亮，而实际生效的档位没人知道。
    //   老树 `getEmotionProfile()`（`src/emotion-personality.js:168-176`）会先 `normalizeId`。
    //   权威表在 `modules/emotion/state.js:EMOTION_PROFILES`；老 id 映射逐字搬自
    //   `src/emotion-personality.js:148-156`。模块若日后导出 `normalizeId`，优先用模块的（避免两份真相）。
    const rawId = String(cs?.get?.('persona.emotionProfile') || '').trim();
    const current = typeof emotion.normalizeId === 'function'
      ? emotion.normalizeId(rawId)
      : normalizeEmotionProfileId(rawId, profiles);
    return json(200, {
      ok: true,
      list,
      current,
      // 如实回配置里**原样**存的那个 id（排障要用：看到 legacyId 才能解释"为什么面板显示的是这一档"）
      configuredId: rawId || null,
      legacyMapped: rawId && rawId !== current ? `${rawId} → ${current}` : null,
      source: 'emotion.EMOTION_PROFILES'
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/** 老 6 档 id → 九型（逐字搬 `src/emotion-personality.js:148-166`）。模块没导出 normalizeId 时的兜底。 */
const LEGACY_EMOTION_PROFILE_ID = Object.freeze({
  extrovert_sunny: 't7',
  introvert_soft: 't2',
  calm_rational: 't5',
  optimist: 't7',
  sensitive: 't4',
  fiery: 't8'
});
const DEFAULT_EMOTION_PROFILE_ID = 't7';
function normalizeEmotionProfileId(id, profiles) {
  const raw = String(id || '').trim();
  if (profiles && Object.prototype.hasOwnProperty.call(profiles, raw)) return raw;
  if (LEGACY_EMOTION_PROFILE_ID[raw]) return LEGACY_EMOTION_PROFILE_ID[raw];
  if (/^t[1-9]$/.test(raw)) return raw;
  return DEFAULT_EMOTION_PROFILE_ID;
}

export function postEmotionPersonalities(ctx, body) {
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  const emotion = getMod(ctx, 'emotion');
  const profiles = emotion?.EMOTION_PROFILES ?? null;
  // 拿不到权威人格表 ⇒ 既没法校验也没法归一化 ⇒ 501 点名，**不许**照写（缺出口不是"写啥都行"）
  if (!profiles) return notPorted('emotion.EMOTION_PROFILES（切换情绪人格要有权威人格表；缺它就不许写配置）');
  // 已接线：config-store.updateConfigAndSave 定义在 core/config-store/index.js:442
  try {
    // ★ P3-5（sp3 2026-10-11）：老树 `src/app.js:1712-1720` 是 **normalizeId → 校验 → 落盘**。
    //   新树只剩"照写不校验"⇒ 面板发一个垃圾 id 也回 `{ok:true}`，而读侧会 normalize 成默认档 t7
    //   ⇒ 界面显示"已切到默认"、盘上存的却是垃圾 id（自找的排障坑）。
    //   这里补回校验，但**比老树严一档**（如实记）：老树的 `normalizeId` 对不认识的 id 直接回默认档，
    //   于是 `!EMOTION_PROFILES[id]` 永远不成立 ⇒ 那条 400 在老树里也是死分支，垃圾 id 会被静默换成默认档。
    //   现在：命中人格表 / 老 6 档 alias / t1-9 都照旧接受（alias 仍按老树归一化后落盘）；
    //   只有"落回默认档"的（真·未知 id、空串）才 400 + 合法清单 —— 用户看得见自己发错了什么。
    const raw = String(body?.id ?? '').trim();
    const normalized = typeof emotion?.normalizeId === 'function'
      ? String(emotion.normalizeId(raw))
      : normalizeEmotionProfileId(raw, profiles);
    const direct = Object.prototype.hasOwnProperty.call(profiles, raw);
    // "映射到了非默认档" 才算老 alias（fiery→t8）；落到默认档 = 没映射上
    const legacyMapped = normalized !== DEFAULT_EMOTION_PROFILE_ID
      && Object.prototype.hasOwnProperty.call(profiles, normalized);
    if (!direct && !legacyMapped) {
      const list = Object.values(profiles)
        .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
        .map((p) => ({ id: p.id, name: p.name }));
      return json(400, { ok: false, error: `未知人格 ${raw || '(空)'}`, list });
    }
    // 存**归一化后**的 id（与老树 setPersonaEmotionProfile(id) 同口径）⇒ 盘上不会留下垃圾 id
    const id = direct ? raw : normalized;
    cs.updateConfigAndSave({ persona: { emotionProfile: id } });
    return json(200, { ok: true, current: id });
  } catch (e) {
    return errorResponse(e);
  }
}

/** GET /api/persona2 — 第二人格状态 */
export function getPersona2(ctx) {
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  if (!cs?.get) return notPorted('config-store.get');
  try {
    // ★ 旧树 persona-two.js:655 personaTwoStatus() 的 18 个字段
    //   先判 provided 再 coerce（Number(null)===0 会把 null 变成 0）
    //   运行时状态：未知 ⇒ null（不编 0）
    const defaults = cs.DEFAULT_CONFIG?.persona2?.trigger ?? {};
    const p2 = cs.get('persona2', {}) ?? {};
    const trigger = p2.trigger ?? {};
    const random = trigger.random ?? {};
    const stats = p2.stats ?? {};
    const live = getMod(ctx, 'emotion')?.personaTwoStatus?.() ?? getMod(ctx, 'emotion')?.status?.() ?? null;
    // ★ 先判 provided：null/undefined/空串 = 未提供；0 是合法值
    const provided = (raw) => !(raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === ''));
    const numOr = (raw, def) => {
      if (!provided(raw)) return def;
      const n = Number(raw);
      return Number.isFinite(n) ? n : def; // 畸形值不 coerce 成 0
    };
    const randomDefaults = defaults.random ?? {};
    return json(200, {
      ok: true,
      enabled: live ? live.enabled === true : p2.enabled === true,
      featureEnabled: p2.featureEnabled === true,
      // ★ 2026-10-17（发行版默认关自动触发）：与消费方 `emotion/persona-two.js:315`
      //   的判据 `trigger.enabled === false` 对齐 —— 那里对缺键会**照常自动顶上来**，
      //   所以状态出口也不许把"缺键"报成"已开"。默认 `trigger.enabled: false` 由此在
      //   面板/状态里如实显示；用户显式 true 才显示开。
      triggerEnabled: trigger.enabled === true,
      recoverExitEnabled: trigger.recoverExitEnabled === true,
      threshold: numOr(trigger.threshold, Number(defaults.threshold ?? 40)),
      recoverThreshold: numOr(trigger.recoverThreshold, Number(defaults.recoverThreshold ?? 25)),
      minDwellMin: numOr(trigger.minDwellMin, Number(defaults.minDwellMin ?? 5)),
      cooldownMin: numOr(trigger.cooldownMin, Number(defaults.cooldownMin ?? 20)),
      randomEnabled: random.enabled === true,
      randomIntervalMinMin: numOr(random.intervalMinMin, Number(randomDefaults.intervalMinMin ?? 20)),
      randomIntervalMaxMin: numOr(random.intervalMaxMin, Number(randomDefaults.intervalMaxMin ?? 40)),
      randomChancePerCheck: numOr(random.chancePerCheck, Number(randomDefaults.chancePerCheck ?? 0.5)),
      randomAfterSpeakMin: numOr(random.afterSpeakMin, Number(randomDefaults.afterSpeakMin ?? 3)),
      randomOccupancyWindowH: numOr(random.occupancyWindowH, Number(randomDefaults.occupancyWindowH ?? 6)),
      randomOccupancyMax: numOr(random.occupancyMax, Number(randomDefaults.occupancyMax ?? 0.25)),
      // ★ 运行时状态：未知 ⇒ null（0 是有意义的值，不许编）
      randomHitsLastHour: live?.randomHitsLastHour ?? null,
      occupancy: live?.occupancy ?? null,
      maxTurns: numOr(p2.maxTurns, null),
      maxMinutes: numOr(p2.maxMinutes, null),
      enteredAt: numOr(live?.enteredAt ?? stats.enteredAt, null),
      enterReason: String(live?.enterReason ?? stats.reason ?? ''),
      turns: live?.turns ?? null,
      lastSwitchAt: numOr(live?.lastSwitchAt ?? p2.lastSwitchAt, null),
      pendingExitReason: live?.pendingExitReason ?? null,
      pendingExitAt: live?.pendingExitAt ?? null,
      pendingExitInMemory: null,
      adminQQ: String(p2.adminQQ || ''),
      avatarOn: String(p2.avatarOn || ''),
      avatarOff: String(p2.avatarOff || ''),
      source: 'config-store.persona2 + config-store.DEFAULT_CONFIG.persona2.trigger',
      notPorted: 'pendingExitInMemory: 退出意图以配置持久化为真源；不单独保留仅内存副本'
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST /api/persona2 — 手动进入/退出及白名单参数更新。 */
export async function postPersona2(ctx, body = {}) {
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  const controller = getMod(ctx, 'emotion');
  if (!cs?.get || typeof cs.updateConfigAndSave !== 'function') return notPorted('config-store.updateConfigAndSave');
  try {
    if (typeof body.enabled === 'boolean') {
      if (typeof controller?.setPersonaTwo !== 'function') return notPorted('emotion.setPersonaTwo');
      const result = await controller.setPersonaTwo(body.enabled, { reason: String(body.reason || 'manual-ui') });
      if (result?.ok !== true) return json(409, { ok: false, error: String(result?.error || 'persona switch rejected'), enabled: controller.isPersonaTwo?.() === true });
      // Preserve the lifecycle payload, while making an avatar failure hard to miss
      // for clients that otherwise treat HTTP 200 / ok:true as complete success.
      const avatarFailed = result?.avatar?.switched === false && Boolean(result?.avatar?.error);
      return json(200, { ok: true, ...result, ...(avatarFailed ? { avatarFailed: true } : {}), status: controller.personaTwoStatus?.() ?? controller.status?.() ?? null });
    }
    const current = cs.get('persona2', {}) || {};
    const patch = {};
    const bool = (key) => { if (typeof body[key] === 'boolean') patch[key] = body[key]; };
    bool('featureEnabled');
    const finite = (value, lo, hi, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
    };
    if (body.trigger && typeof body.trigger === 'object') {
      const old = current.trigger || {};
      const trigger = { ...old };
      for (const [key, bounds] of Object.entries({ threshold: [0, 800], recoverThreshold: [0, 800], minDwellMin: [0, 1440], cooldownMin: [0, 10080] })) {
        if (body.trigger[key] !== undefined) trigger[key] = finite(body.trigger[key], ...bounds, Number(old[key]) || 0);
      }
      if (typeof body.trigger.enabled === 'boolean') trigger.enabled = body.trigger.enabled;
      if (typeof body.trigger.recoverExitEnabled === 'boolean') trigger.recoverExitEnabled = body.trigger.recoverExitEnabled;
      if (body.trigger.random && typeof body.trigger.random === 'object') {
        const random = { ...(old.random || {}) };
        if (typeof body.trigger.random.enabled === 'boolean') random.enabled = body.trigger.random.enabled;
        for (const [key, bounds] of Object.entries({ intervalMinMin: [0, 1440], intervalMaxMin: [0, 1440], chancePerCheck: [0, 1], afterSpeakMin: [0, 1440], occupancyWindowH: [0.1, 168], occupancyMax: [0, 1] })) {
          if (body.trigger.random[key] !== undefined) random[key] = finite(body.trigger.random[key], ...bounds, Number(random[key]) || 0);
        }
        trigger.random = random;
      }
      patch.trigger = trigger;
    }
    for (const key of ['maxTurns', 'maxMinutes']) {
      if (body[key] !== undefined) patch[key] = Math.round(finite(body[key], 0, 100000, Number(current[key]) || 0));
    }
    for (const key of ['adminQQ', 'avatarOn', 'avatarOff']) {
      if (typeof body[key] === 'string') patch[key] = body[key].slice(0, 500);
    }
    if (!Object.keys(patch).length) return json(400, { ok: false, error: 'no supported persona2 fields supplied' });
    const saved = cs.updateConfigAndSave({ persona2: patch }, { backup: true, log: ctx?.log ?? (() => {}) });
    return json(200, { ok: true, persisted: true, changed: saved.changed || [] });
  } catch (error) { return errorResponse(error); }
}

/** GET /api/api-key — API Key 状态（不返回实际密钥） */
export function getApiKey(ctx) {
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  if (!cs?.get) return notPorted('config-store.get');
  try {
    const key = cs.get('api.apiKey', '');
    return json(200, { ok: true, hasKey: !!key });
  } catch (e) {
    return errorResponse(e);
  }
}

/** GET /api/usage/breakdown — 归 S3 api/console.js（完整旧形状实现），此处不实现 */

// GET /api/vision/results —— 归分片 `api/console.js:655`（读 media.visionResults + llm.currentProviders，
// 出口缺失时它自己 501 点名）。本文件曾经有一个**从未接进分发**的 501 桩 `getVisionResults()`，
// 2026-10-11 A 档接线实测（隔离实例）端点本来就是 **200**，那个桩只是读代码时会骗人的死函数 ⇒ 删掉；
// 归属由 `console-api.selftest.mjs` 的影子锁钉住（handleConsoleApi 对该路径必须返回 null）。

/** GET /api/life — 生活系统 */
export function getLife(ctx) {
  const extensions = getMod(ctx, 'extensions');
  // Match the legacy capability queries. An unloaded optional life system is a valid unavailable state.
  // 已接线：extensions.skillManager.getCapabilityProviders 定义在 modules/extensions/skills/manager.js:345（skillManager 单例 exported at manager.js:550）
  try {
    const grab = (name) => {
      for (const provider of extensions.skillManager.getCapabilityProviders(name, {})) {
        try { return provider.fn?.(); } catch { return undefined; }
      }
      return null;
    };
    const today = grab('life.today');
    const worldbook = grab('life.worldbook');
    if (today === null && worldbook === null) return json(200, { ok: true, available: false, error: '生活系统未开启' });
    return json(200, {
      ok: true,
      available: true,
      today,
      worldbook: worldbook ?? '',
      facts: grab('life.facts') ?? [],
      calendarFile: grab('life.calendar-file') || { exists: false, year: 0, holidays: 0, makeup: 0, expired: false },
      eventPoolEnabled: extensions.skillManager.settingsOf?.('life-system')?.eventPoolEnabled === true
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/** GET /api/usage/prices — 价格表 */
export function getUsagePrices(ctx) {
  const llm = getMod(ctx, 'llm');
  if (!llm?.listOfficialPrices) return notPorted('llm.listOfficialPrices');
  try {
    const prices = llm.listOfficialPrices();
    return json(200, { ok: true, prices });
  } catch (e) {
    return errorResponse(e);
  }
}

/** GET /api/providers/models — 提供商模型列表 */
export function getProvidersModels(ctx) {
  const llm = getMod(ctx, 'llm');
  // 已接线：llm.currentProviders 定义在 modules/llm/providers.js:116
  try {
    // ★ currentProviders()（modules/llm/providers.js:116）——真来源
    //   不暴露 apiKey（secrets），只给 hasKey
    const providers = llm.currentProviders();
    const result = (Array.isArray(providers) ? providers : []).map((p) => ({
      id: p.id,
      displayName: p.displayName,
      api: p.api,
      baseURL: p.baseURL,
      models: p.models ?? {},
      modelNames: p.modelNames ?? [],
      hasKey: !!p.apiKey,
      needsBaseUrl: p.needsBaseUrl === true
    }));
    return json(200, { ok: true, providers: result, source: 'llm.currentProviders' });
  } catch (e) {
    return errorResponse(e);
  }
}

// GET /api/search-providers —— 归分片 `api/console.js:917`（读 config 的 webSearch.providers；
// 同路径的 DELETE/POST/test 也都在那一片）。同上：本文件曾有一个**从未接进分发**的 501 桩
// `getSearchProviders()`，实测端点本来就 200 ⇒ 删掉，归属由影子锁钉住。

/** GET /api/search-key — 搜索 Key 状态 */
export function getSearchKey(ctx) {
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  if (!cs?.get) return notPorted('config-store.get');
  try {
    const key = cs.get('webSearch.apiKey', '');
    return json(200, { ok: true, hasKey: !!key });
  } catch (e) {
    return errorResponse(e);
  }
}

// ── 认领的参数化/补充端点（S3 名单划归）────────────────────────────────

/** POST /api/providers/fetch-models — 归分片 api/console.js:840（llm.fetchModelsFrom），此处让路 */
export function postFetchModels() {
  // 本文件原来在这里 501（"M4 llm 的 providers"），把分片那份真实现（200 + models，
  // 缺 llm.fetchModelsFrom 时 501 点名）永远挡在 http.js:93 之后 ⇒ UI 点"获取列表"必 501。
  // 旧树 src/app.js:2232 没有"缺 baseUrl 就 400"这道闸，UI 侧已自行拦空串 ⇒ 整条让给分片。
  return null;
}

/** GET /api/config/defaults — 配置默认值 */
export function getConfigDefaults(ctx) {
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  // 已接线：config-store.DEFAULT_CONFIG 定义在 core/config-store/defaults.js:32（re-exported at index.js:36）
  try {
    return json(200, { ok: true, defaults: cs.DEFAULT_CONFIG });
  } catch (e) {
    return errorResponse(e);
  }
}

/** GET /api/sessions/:id — T-SESSION-CLEANUP-PORT 的真实只读详情。 */
export function getSessionDetail(ctx, pathname) {
  const registry = sessionsFor(ctx);
  if (!registry) return notPorted('modules/sessions.createSessionRegistry 需要显式 ctx.dataDir；未猜测或回退到 data/。');
  try {
    const id = pathname.slice('/api/sessions/'.length);
    if (!id || id.includes('/')) return json(400, { ok: false, error: '会话 id 格式错误' });
    // 只检查目录可读性，避免把权限/目录错误谎报成“会话不存在”，也不为单条详情全量扫文件。
    if (typeof registry.sessionsDir === 'string') {
      try { fs.readdirSync(registry.sessionsDir); }
      catch (error) {
        if (error?.code !== 'ENOENT') return json(500, { ok: false, error: '会话目录读取失败：' + String(error?.message ?? error) });
      }
    }
    const session = registry.get(id);
    if (!session) return json(404, { error: '会话不存在' });
    // ★ P1-a：详情的三键走**同一个** `deriveOutcomes()`（列表投影 `summaryOf()` 调的也是它）
    //   ⇒ "详情说有、列表说没"按构造不可能复发（票面牙 2；今晚 S-2 真踩过这一刀）。
    //   写在原对象上而不是另算一份判据：判据只有 `modules/sessions` 那一处。
    return json(200, { ...session, ...deriveOutcomes(session) });
  } catch (e) {
    return errorResponse(e);
  }
}

/** GET /api/memory-people/name-only?name=X — 按名字查人物 */
export function getMemoryPersonByName(ctx, query) {
  const name = query?.get?.('name') ?? '';
  if (!name) return json(400, { ok: false, error: '缺少 name 参数' });
  return notPorted('memory-people/name-only: M6 memory 无按名查询出口（UI 读 people[] + qq + name）');
}

/** GET /api/semantic-cards/:id — 单张语义卡 */
export function getSemanticCard(ctx, pathname) {
  const key = pathname.replace('/api/semantic-cards/', '');
  if (!key) return json(400, { ok: false, error: '缺少卡片 key' });
  return notPorted('semanticCards.get(key)（旧 src/app.js:3386-3395）；新树缺旧版归档语义卡存储出口。M6 memory.cards() 是 claim 卡，不是此接口的数据源。');
}

// ★ 2026-10-11（sp3）：这里原本有一个 `getProviderKey()`（读 dshProviderKeys 回 {hasKey, source}）。
//   **全树零引用 + GET 分发表里没有它的入口** ⇒ 死代码，已删。原因写在这里免得下一个人再写第三份：
//   · 真正在跑的是分片 `api/console.js` 的 `GET /api/providers/key`（回报**明文** key，
//     由 keyEndpointAllowed 校验来源挡外部）；面板 `apps/ui/app.js` 的 fetchRealKey 读的正是 `r.apiKey`。
//   · 本文件这版回的是 `hasKey` + `source`，接上去面板会直接把 Key 读成空 ⇒ 不是"顺手统一"能解决的，
//     要统一得先改面板，那属 luna2 的域。
//   · POST 走本文件的 postProviderKey（:1619），两条路的落盘口径已对齐。

/** POST /api/providers/key — 设置 API Key */
export function postProviderKey(ctx, body) {
  const llm = getMod(ctx, 'llm');
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  // 已接线：llm.setProviderKey 定义在 modules/llm/providers.js:122
  try {
    const providerId = String(body?.providerId ?? '');
    const apiKey = String(body?.apiKey ?? body?.key ?? '');
    if (!providerId) return json(400, { ok: false, error: '缺少 providerId' });
    if (!apiKey) return json(400, { ok: false, error: '缺少 apiKey' });
    // ★ llm.setProviderKey（modules/llm/index.js）——旧树 src/app.js:2319 同一出口
    const updated = llm.setProviderKey(providerId, apiKey);
    if (!updated) return json(404, { ok: false, error: '提供商不存在' });
    // ★★★ P0-a（sp3 2026-10-11 · 面板"保存 Key"是活体假成功）：
    //   `llm.setProviderKey` 只改**内存**（modules/llm/providers.js:122 走 updateConfig，不落盘）；
    //   而面板对"目录提供商"的 Key **只**打这个接口、不并进 /api/config 的 patch
    //   （apps/ui/app.js:16997-17009）⇒ 这里不落盘 = 界面说"已保存"、重启回退旧 Key。
    //   带落盘的那份在 api/console.js:786，但 http.js:93 让本文件先答 ⇒ 那份被遮蔽成死代码。
    //   ⇒ 选①（在本份上补落盘）而不是②（改接落盘版）：路由认领权归本文件，改认领会让
    //     "哪一份是真的"继续悬着；补一行落盘后两份口径一致，且失败如实回错、不拿 200 假装成功。
    if (typeof cs?.updateConfigAndSave !== 'function') {
      return json(501, {
        ok: false,
        error: '缺出口：configStore.updateConfigAndSave —— Key 只进了内存，重启后会回退（不算保存成功）'
      });
    }
    // ★ P1 配置收敛（2026-10-12）：落盘从 `saveConfig` 改走唯一持久写入口 `updateConfigAndSave`。
    //   内存已由上面的 llm.setProviderKey 按 dshProviderKeys 的布局写好 ⇒ 这里 patch 传空对象
    //   = 不再改任何配置、只把整份内存原子落盘（这样别的提供商的密钥一定跟着一起写，不会漏）。
    //   AndSave 的返回比 saveConfig 多一整份 config，去掉它再回给界面 ⇒ 响应字段与原来逐字一致。
    const { config: _wholeConfig, ...saved } = cs.updateConfigAndSave({}, { backup: true, log: ctx?.log ?? (() => {}) });
    return json(200, {
      ok: true,
      hasKey: !!updated.apiKey,
      persisted: { ok: true, saved },
      source: 'llm.setProviderKey + configStore.updateConfigAndSave'
    });
  } catch (e) {
    // 落盘失败（含 config-store 的 fail-closed：读盘坏过就拒绝覆盖）⇒ 500 + 原文，不吞成成功
    return errorResponse(e);
  }
}

/** GET /api/paas/v4 — PaaS 状态 */
export function getPaas(ctx) {
  // ★ 幽灵端点：新旧两棵树的 UI 都不调用、旧树也没有 handler —— 不是缺能力
  //   旧树 grep 'paas' 仅命中 Zhipu web-search URL（config.js:700, web-search.js:999）
  //   新树 UI 仅 app.js:10793 占位字符串，无 fetch('/api/paas/v4')
  return notPorted('paas/v4: 幽灵端点（新旧 UI 均不调用、旧树无 handler —— 不是缺能力）');
}

/** GET /api/persona-templates/:id — 人设模板 */
export function getPersonaTemplate(ctx, pathname) {
  // ★ PERSONAS 存在于 config-store（core/config-store/index.js 导出）
  //   旧树 src/personas.js 的 PERSONAS 配置对象
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  const personas = cs?.PERSONAS ?? getMod(ctx, 'config-store')?.PERSONAS;
  // 已接线：config-store.PERSONAS 定义在 core/config-store/personas.js:4（re-exported at index.js:39）
  try {
    const id = pathname.replace('/api/persona-templates/', '');
    if (!id) return json(400, { ok: false, error: '缺少模板 ID' });
    const found = personas[id];
    if (!found) return json(404, { ok: false, error: `人设模板 ${id} 不存在` });
    return json(200, {
      ok: true,
      id,
      name: found.name ?? '',
      roleText: found.text ?? '',
      source: 'config-store.PERSONAS'
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/** GET /api/memory-people/:id — 单个人物记忆（参数化） */
export async function getMemoryPerson(ctx, pathname) {
  const memory = getMod(ctx, 'memory');
  // 已接线：memory.brief 定义在 modules/memory/index.js:531
  try {
    const dataDir = String(ctx?.dataDir ?? '').trim() || undefined;
    const qq = pathname.replace('/api/memory-people/', '');
    if (!qq) return json(400, { ok: false, error: '缺少人物 ID' });
    const brief = await memory.brief();
    // ★ 投影：按 subjectId 分组，找目标人物
    const bySubject = {};
    const emotion = getMod(ctx, 'emotion');
    for (const item of (brief?.items ?? [])) {
      const sid = String(item?.subjectId ?? '');
      if (!sid) continue;
      if (!bySubject[sid]) {
        let favorVal = null;
        let favorKnown = null;   // ★ 2026-10-18（N2）：与 GET /api/memory-people 同口径（null=取不到 / false=默认值）
        if (typeof emotion?.relationOf === 'function') {
          try {
            const rel = emotion.relationOf({ senderId: sid });
            if (rel && typeof rel.favor === 'number') { favorVal = rel.favor; favorKnown = rel.known === true; }
          } catch (e) {}
        }
        bySubject[sid] = {
          userId: sid,
          impressions: [],
          name: typeof memory?.getSubjectName === 'function' ? memory.getSubjectName(sid, { dataDir }) : '未知',
          favor: favorVal,
          favorKnown
        };
      }
      bySubject[sid].impressions.push({
        // ★ 2026-10-17：与 GET /api/memory-people 同形（真实观察 id；本查询按人取，不合并同文）。
        id: String(item?.id ?? ''),
        observationIds: String(item?.id ?? '') ? [String(item.id)] : [],
        text: String(item?.claim ?? ''),
        scope: item?.scope,
        chatKey: item?.chatKey ?? '',
        at: item?.at ?? item?.createdAt ?? null
      });
    }
    const found = bySubject[String(qq)] ?? null;
    if (!found) return json(404, { ok: false, error: `人物 ${qq} 不存在` });
    return json(200, {
      ok: true,
      person: found,
      source: 'memory.brief.items'
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST /api/config — 配置保存（走 M1 updateConfigAndSave，原子落盘 + .bak） */
export function postConfig(ctx, body) {
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  // ★ 缺写出口 ⇒ **501 + 点名**，不是 500 "cs.updateConfigAndSave is not a function"。
  //   （2026-10-11 修 `console-api.selftest.mjs` 那条一直红着的「无写出口 ⇒ 501」：
  //     原来没有这道闸 ⇒ 调一个不存在的函数，TypeError 被 `catch` 接走变成 500。
  //     500 的含义是"服务器炸了"，而真实情况是"这个能力没接上"—— 面板会把后者显示成
  //     「保存失败：xxx is not a function」这种只有开发能看懂的话，排障方向整个带偏。
  //     同舱惯例：api/shell.js:98-101 的 updateConfig 帮手也是缺出口就抛错点名。
  //   ⚠ 顺序很重要：这道闸必须在 try 里第一个判，且**不许**吞掉它自己的 501。）
  if (typeof cs?.updateConfigAndSave !== 'function') {
    return notPorted('config-store.updateConfigAndSave —— POST /api/config 需要它做原子落盘；'
      + '缺这个出口时配置改动不会留存到重启后，不许当成保存成功');
  }
  // 已接线：config-store.updateConfigAndSave 定义在 core/config-store/index.js:442
  try {
    // `GET /api/config` includes display-only `<secret>Has` flags. Never let
    // those flags become config keys if a caller posts the displayed object
    // back. Empty redacted secret values paired with a true flag are omitted
    // too, so a read → save round-trip cannot erase the stored credential.
    const patch = stripConfigDisplayFields(body);
    const result = cs.updateConfigAndSave(patch, {
      backup: true,
      force: false,
      log: ctx?.log ?? (() => {})
    });
    // ★ 契约 = 老树 `src/app.js:2670`：`{ ok: true, config: <合并视图> }`。
    //   前端 POST /api/config 的读法**全是 `data.config`**（`apps/ui/app.js:1356/2804/17694/…`）
    //   和 `data.ok`（`:7075`）；改前这里直接回**扁平**合并视图 ⇒ `data.config === undefined`
    //   ⇒ `state.config = undefined`，下一次在「聊天」区保存就在 `c.wakeDelayMs` 上炸：
    //   `Cannot read properties of undefined (reading 'wakeDelayMs')`（用户 2026-10-11 报的那条）。
    //   GET 仍然回扁平（前端 `state.config = await api('/api/config')` 认的是扁平），**两个方法两种形状**，
    //   与老树一致 —— 别把它们统一成一种。
    return json(200, { ok: true, config: sanitizeConfig(result.config ?? result) });
  } catch (e) {
    // saveConfig 读盘坏时拒绝覆盖（除非 force）；**真正的写失败**才走这条 ⇒ 500 + 原文
    return errorResponse(e);
  }
}

// ── 脱敏 ─────────────────────────────────────────────────────────────────

// Keep this anchored and explicit. Substring matching masks ordinary settings
// such as maxTokens, keywordCount, and hasApi. dshProviderKeys is an explicit
// secret container whose dynamic child names are provider IDs.
const SECRET_KEY_RE = /^(?:apiKey|dshProviderKeys|accessToken|httpAccessToken|httpToken|webuiPassword|token|key|secret|clientSecret|refreshToken|password|credential|credentials)$/i;
const DISPLAY_HAS_RE = /(?:Has)+$/i;

function isEmptyRedactedSecret(value) {
  return value === '' || value === null || value === undefined
    || (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
}

function secretHasMarkers(key) {
  const current = `${key}Has`;
  const legacy = `${key.replace(/(key|token|secret|password|credential)$/i, '')}Has`;
  return current === legacy ? [current] : [current, legacy];
}

function stripConfigDisplayFields(obj) {
  if (Array.isArray(obj)) return obj.map(stripConfigDisplayFields);
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (DISPLAY_HAS_RE.test(key)) continue;
    if (SECRET_KEY_RE.test(key) && isEmptyRedactedSecret(value)
      && secretHasMarkers(key).some((marker) => obj[marker] === true)) continue;
    out[key] = stripConfigDisplayFields(value);
  }
  return out;
}

function sanitizeConfig(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeConfig);
  if (typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    // Discard old derived fields already persisted by earlier sanitizer runs.
    if (DISPLAY_HAS_RE.test(k)) continue;
    if (SECRET_KEY_RE.test(k)) {
      // Preserve an actually empty object (notably dshProviderKeys) so a
      // round-trip keeps its config type while still hiding any populated map.
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0 ? {} : '';
      out[`${k}Has`] = !isEmptyRedactedSecret(v);
    } else {
      out[k] = sanitizeConfig(v);
    }
  }
  return out;
}

export { sanitizeConfig };
  
/** POST /api/ui-log — 前端启动期日志上报（最多 500 条） */
let uiLogCount = 0;
export function postUiLog(ctx, body) {
  try {
    const msg = String(body?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const tag = String(body?.tag ?? 'ui').replace(/[^\w-]/g, '').slice(0, 32) || 'ui';
    if (msg && uiLogCount < 500) {
      uiLogCount += 1;
      ctx?.log?.(`[ui:${tag}] ${msg}`);
    }
    return json(200, { ok: true });
  } catch (e) {
    return json(200, { ok: false, error: String(e?.message ?? e).slice(0, 160) });
  }
}

// ── 路由表 ───────────────────────────────────────────────────────────────

/**
 * 路由分发：根据路径返回响应。
 * @param {string} method - GET / POST / …
 * @param {string} pathname - 路径
 * @param {object} body - 已解析的 body
 * @param {object} ctx - 装配上下文
 * @returns {{ status, headers, body }}
 */
export async function handleConsoleApi(method, pathname, body, ctx, query = null) {
  // W2 route-family ownership: sessions(+detail), topics, memory-guard,
  // semantic-card detail, and usage/reset are answered here before api slices.
  // Base GET /api/semantic-cards deliberately yields to api/memory.js; keep that adapter reachable.
  // GET 路由
  if (method === 'GET') {
    if (pathname === '/api/status') {
      // ★ 2026-11-04（溟）：顶栏/桌面窗口每秒轮询这个口，而它每次都要现算一大坨
      //   （onebot + snowluma 探活 + 5000 行用量台账 + 各模块快照）。实测过它会间歇卡
      //   20–30 秒，窗口就显示"未响应"——2026-11-04 20:4x 连打六次：四次卡满 30 秒。
      //   这里的改动只有两件，都不动 getStatus 内部：
      //   ① 2 秒缓存：轮询频率远高于状态真正变化的频率，缓存后 UI 不会每秒都撞上重算；
      //   ② 分段计时：超过 800ms 打一行 warn，下次卡的时候能从日志里看到是不是它、花了多久。
      //   缓存挂在函数对象上，不新增模块级变量（回滚 = 把这一段换回一行）。
      const STATUS_CACHE_MS = 2000;
      const cached = handleConsoleApi.__statusCache;
      const nowMs = Date.now();
      if (cached) {
        // ★ stale-while-revalidate：请求**永远不阻塞在重算上**。
        //   实测 getStatus 本身要 1.7–2.7 秒（计时日志 status-slow 抓到的），
        //   卡 20–30 秒是它反复重算叠出来的。这里改成：命中即返回旧值，
        //   过期就顺手在后台刷一次（同一时刻只允许一个刷新在跑）。
        //   代价：状态最多旧 2 秒——连接状态、余额这些数字晚两秒没人看得出来。
        if (nowMs - cached.at >= STATUS_CACHE_MS && !cached.refreshing) {
          cached.refreshing = true;
          const startedAt = Date.now();
          getStatus(ctx).then((value) => {
            const costMs = Date.now() - startedAt;
            if (costMs > 800) {
              try {
                if (ctx?.obs && typeof ctx.obs.log === 'function') {
                  ctx.obs.log('warn', 'status-slow', { ms: costMs, breakpoint: 'handleConsoleApi /api/status (bg)' });
                }
              } catch { /* 诊断日志不许影响请求本身 */ }
            }
            handleConsoleApi.__statusCache = { at: Date.now(), value, refreshing: false };
          }).catch(() => { cached.refreshing = false; });
        }
        return cached.value;
      }
      const startedAt = Date.now();
      const value = await getStatus(ctx);
      const costMs = Date.now() - startedAt;
      if (costMs > 800) {
        try {
          if (ctx?.obs && typeof ctx.obs.log === 'function') {
            ctx.obs.log('warn', 'status-slow', { ms: costMs, breakpoint: 'handleConsoleApi /api/status' });
          }
        } catch { /* 诊断日志不许影响请求本身 */ }
      }
      handleConsoleApi.__statusCache = { at: Date.now(), value, refreshing: false };
      return value;
    }
    if (pathname === '/api/config') return getConfig(ctx);
    if (pathname === '/api/instance-info') return getInstanceInfo(ctx);
    if (pathname === '/api/bot-state') return getBotState(ctx);
    if (pathname === '/api/ui-preview') return getUiPreview(ctx);
    if (pathname === '/api/sessions') return getSessions(ctx, query);
    if (pathname === '/api/judge-usage') return getJudgeUsage(ctx);
    if (pathname === '/api/memory-people') return getMemoryPeople(ctx, query);
    if (pathname === '/api/topics') return getTopics(ctx);
    if (pathname === '/api/cost-guard') return getCostGuard(ctx);
    // GET /api/memory-audit 不在本表：归 api/memory.js（本文件曾有的同名实现因传错参数恒返回 null，已删）
    if (pathname === '/api/memory-guard') return getMemoryGuard(ctx);
    if (pathname === '/api/hype-mode') return getHypeMode(ctx);
    if (pathname === '/api/local-jev') return getLocalJev(ctx);
    if (pathname === '/api/judge-diagnostics') return getJudgeDiagnostics(ctx);
    if (pathname === '/api/providers') return getProviders(ctx);
    if (pathname === '/api/self-impressions') return getSelfImpressions(ctx);
    if (pathname === '/api/semantic-cards') return getSemanticCards(ctx);
    if (pathname === '/api/emotion-personalities') return getEmotionPersonalities(ctx);
    if (pathname === '/api/persona2') return getPersona2(ctx);
    if (pathname === '/api/usage/prices') return getUsagePrices(ctx);
    if (pathname === '/api/providers/models') return getProvidersModels(ctx);
    if (pathname === '/api/life') return getLife(ctx);
    if (pathname === '/api/memory-people/name-only') return getMemoryPersonByName(ctx, query);
    if (pathname === '/api/paas/v4') return getPaas(ctx);
    // 参数化路由（前缀匹配）
    // ★ P-2：by-session 必须排在 `/api/ui-preview/` 详情分支**之前**（详情那条是宽前缀匹配）
    if (pathname.startsWith('/api/ui-preview/by-session/')) return getUiPreviewBySession(ctx, pathname);
    if (pathname.startsWith('/api/ui-preview/')) return getUiPreviewDetail(ctx, pathname);
    if (pathname.startsWith('/api/sessions/')) return getSessionDetail(ctx, pathname);
    if (pathname.startsWith('/api/semantic-cards/')) return getSemanticCard(ctx, pathname);
    if (pathname.startsWith('/api/persona-templates/')) return getPersonaTemplate(ctx, pathname);
    if (pathname.startsWith('/api/memory-people/') && !pathname.includes('/cleanup') && !pathname.includes('/consolidate')) return getMemoryPerson(ctx, pathname);
  }

  // POST 路由（写操作）
  if (method === 'POST') {
    if (pathname === '/api/life') return notPorted('POST /api/life roll/clear capabilities are not wired in the new tree');
    // ★ N31：旧 src/app.js:1654（POST /api/bot-state = setBotState）—— 改前整条路由缺失（404）。
    if (pathname === '/api/bot-state') return postBotState(ctx, body);
    if (pathname === '/api/ui-preview/clear') return postUiPreviewClear(ctx);
    if (pathname.startsWith('/api/sessions/')) {
      const sessionAction = await postSessionAction(ctx, pathname);
      if (sessionAction) return sessionAction;
    }
    if (pathname === '/api/config') return postConfig(ctx, body);
    if (pathname === '/api/ui-log') return postUiLog(ctx, body);
    if (pathname === '/api/providers/fetch-models') return postFetchModels(ctx, body);
    if (pathname === '/api/providers/set-key') return postProviderKey(ctx, body);
    if (pathname === '/api/providers/key') return postProviderKey(ctx, body);
    // ★ 2026-10-16（C）：向量语义召回的"立即应用"入口（自有 runtime；UI 不必等重启）。
    if (pathname === '/api/vector/apply') return postVectorApply(ctx);
    if (pathname === '/api/usage/reset') return postUsageReset(ctx);
    if (pathname === '/api/hype-mode') return postHypeMode(ctx, body);
    if (pathname === '/api/persona2') return postPersona2(ctx, body);
    if (pathname === '/api/emotion-personalities') return postEmotionPersonalities(ctx, body);
    if (pathname === '/api/self-impressions') return postSelfImpressions(ctx, body);
  }

  // DELETE 路由
  if (method === 'DELETE') {
    if (pathname === '/api/self-impressions') return deleteSelfImpressions(ctx, body);
  }

  return null; // 未匹配，调用方继续找
}

export function consoleApiRoutes() {
  return [
    { method: 'GET', path: '/api/status', desc: '就绪度轮询', priority: 'P0' },
    { method: 'GET', path: '/api/config', desc: '配置快照（脱敏）', priority: 'P0' },
    { method: 'GET', path: '/api/instance-info', desc: '实例信息', priority: 'P0' },
    { method: 'GET', path: '/api/bot-state', desc: '情绪/精力/好感', priority: 'P1' },
    { method: 'GET', path: '/api/ui-preview', desc: '发给模型的输入目录（分段/字数，正文只在点开时取）', priority: 'P1' },
    { method: 'GET', path: '/api/ui-preview/:id', desc: '那一次的完整输入（只从本机 ui-preview 目录读）', priority: 'P1' },
    { method: 'GET', path: '/api/ui-preview/by-session/:sessionId', desc: '★P-2：只看这一个运行会话的输入预览（面板主关联键；未盖章的老行不在此列）', priority: 'P1' },
    { method: 'POST', path: '/api/ui-preview/clear', desc: '一键清空输入预览', priority: 'P1' },
    { method: 'GET', path: '/api/sessions', desc: '会话列表', priority: 'P1' },
    { method: 'GET', path: '/api/judge-usage', desc: 'cloud_judge 判定用量与记忆读数', priority: 'P1' },
    { method: 'POST', path: '/api/sessions/:id/delete', desc: '会话移入回收站', priority: 'P1' },
    { method: 'POST', path: '/api/sessions/:id/reingest', desc: '重新登记会话', priority: 'P1' },
    { method: 'POST', path: '/api/sessions/:id/restore', desc: '从回收站恢复会话', priority: 'P1' },
    { method: 'POST', path: '/api/config', desc: '配置保存', priority: 'P1' },
    { method: 'POST', path: '/api/ui-log', desc: '前端日志上报', priority: 'P0' },
  ];
}
