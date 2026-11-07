/**
 * refactor/apps/server/api/console.js — 控制台 API 分片 **S3「会话·记忆·用量」**（qwen3.8flash 20de42f8）
 *
 * 契约见 `.tmp-dispatch/ui-api-slices-brief.md` §一：只导出一个 async `handle()`，
 * 不认识的路径 **return null** 让下一片接。分发器归 mimo（`http.js:107` 按文件名顺序问 `api/*.js`）。
 *
 * ★ 响应形状**逐条照旧树 `src/app.js`**（UI 是旧 UI 的整份拷贝，形状不对它就崩）：
 *   旧 `GET /api/chats` 回 `{chats}`（**没有** ok）、`GET /api/model-prices` 回 `{prices,current,remote}`、
 *   `GET /api/usage/stats` 回 `{ok,range,...stats}` —— 都按原样回，不"顺手规范化"。
 * ★ 能力没就绪 ⇒ **501 + `not-ported: 缺哪个出口`**（§二.2），绝不回空数组假装"没有数据"。
 *   旧行号一并写进 error，后续席位才知道从哪儿搬。
 *
 * ★ 落盘口径（§二.3）：本片的写接口先叫模块自己的公开出口改内存（`llm/providers.js` 的
 *   `setProviderKey/upsertProvider/addModelsToProvider/removeModelFromProvider` 内部就是
 *   `config-store.set`），随后**必须**调 `ctx.configStore.saveConfig({backup:true,log})` 落盘
 *   —— 它就是 `updateConfigAndSave` 的落盘那一半（`core/config-store/index.js:413-417`）。
 *   只 `updateConfig` 不 save = 重启就丢（见对照表「配置写不落盘」）。
 *
 * ★ 路由先后（console-api.js 在 http.js:90 抢先，分片按文件名序在它之后才被问）：
 *   2026-10-05 01:06 用 `.tmp-dispatch/probe-ui-s3.mjs` 实测 **55 条里 18 条被遮蔽**
 *   （bot-state、sessions×2、topics、memory-people、semantic-cards、usage/stats、vision/results、
 *   search-providers、hype-mode、persona2、self-impressions、local-jev、api-key/search-key/providers/key
 *   的来源守卫、providers/set-key、providers/fetch-models）。
 *   ★ W2 由 console-api.js 接管 sessions(+detail)/topics/memory-guard/semantic-card detail/usage-reset；
 *   base GET /api/semantic-cards deliberately falls through to api/memory.js, where the cards()+fieldGaps adapter lives.
 *   其余历史遮蔽数字仅供线索，随 console-api 改动而变。
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/**
 * 视觉扫描的进程内旗（I-2，对位旧树 src/app.js:612 的 `visionScan = { running: false }`）。
 * POST 置真 / 收尾清除，GET /api/vision/results 的 `scanning` 读的就是这里 —— API 分片只加载一次
 * （http.js:18-21,37），两个路由共享同一模块实例 ⇒ 这面旗是真状态，不是摆设。
 */
const visionScan = { running: false };

// ── 通用出口 ──────────────────────────────────────────────────────────────

function json(status, obj) {
  const body = JSON.stringify(obj, null, 2);
  return { status, headers: { ...JSON_HEADERS, 'content-length': String(Buffer.byteLength(body)) }, body };
}

function notPorted(what) {
  return json(501, { ok: false, error: `not-ported: ${what}` });
}

function fail(status, message) {
  return json(status, { ok: false, error: String(message ?? '') });
}

function serverError(error) {
  return json(500, { ok: false, error: String(error?.message ?? error) });
}

/**
 * 取模块命名空间。
 * `ctx.modules` 是 Map（键是全 id ⇒ 拿到的是**裸 ESM 命名空间**），`ctx.modulesObj` 才是
 * 装配层加工过的运行面（`memory.store`、`emotion` 的活状态 facade 都只在这里）。
 * 优先 `modulesObj`，再退回 Map，最后退回 `ctx.modules[name]`（自测里传的是普通对象）。
 */
function getMod(ctx, name) {
  if (ctx?.modulesObj?.[name]) return ctx.modulesObj[name];
  const mods = ctx?.modules;
  if (mods && typeof mods.get === 'function') return mods.get(`modules/${name}`) ?? mods.get(name) ?? null;
  return mods?.[name] ?? null;
}

function cfgGet(ctx, keyPath, fallback) {
  try {
    const value = ctx?.configStore?.get?.(keyPath);
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/** 落盘日志出口：走 M2 的 `obs.log(level, msg, fields)`；没有就静默（saveConfig 的 log 是可选的）。 */
function saveLog(ctx) {
  const log = ctx?.obs?.log;
  if (typeof log !== 'function') return undefined;
  return (level, code, data) => { try { log(level, code, data); } catch { /* 日志坏了不许把落盘结果吞掉 */ } };
}

/** 内存已改 ⇒ 落盘（原子 + .bak + 写前自检，见 config-store:354-404）。 */
function persistConfig(ctx) {
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  if (typeof cs?.saveConfig !== 'function') return { ok: false, error: '缺出口：configStore.saveConfig（配置改动不会留存到重启后）' };
  const saved = cs.saveConfig({ backup: true, log: saveLog(ctx) });
  return { ok: true, saved };
}

// ── 明文密钥端点守卫（逐字搬旧 `src/app.js:1395-1412`）──────────────────────
/**
 * 本机控制台可以「显示密钥」；防线是**校验来源**（挡外部网页冒用浏览器打 127.0.0.1）。
 * `req` 由分发器传（`http.js:146` 的 `io = {req,res}`）；拿不到 req ⇒ **fail-closed**（403），
 * 绝不因为探针/别名路径少了 req 就把明文 Key 吐出去。
 */
function keyEndpointAllowed(ctx, req) {
  const token = String(cfgGet(ctx, 'server.token', '') ?? '');
  const headers = req?.headers || {};
  if (token) {
    let searchToken = '';
    try {
      searchToken = new URL(String(req?.url || '/'), 'http://127.0.0.1').searchParams.get('token') || '';
    } catch { searchToken = ''; }
    if (headers['x-console-token'] === token || searchToken === token) return true;
  }

  const host = String(headers.host ?? '');
  const isLoopbackHost = /^127\.0\.0\.1:\d+$/.test(host) || /^localhost:\d+$/.test(host);
  // ★ 2026-10-17（ds1 安全审查 · 顺序修正）：本机 Host 是**前置条件**，对"带自定义头"那条同样生效。
  //   旧口径（旧树 src/app.js:1401-1402）的理由是"带自定义头 ⇒ 不可能是简单跨站请求（要过 CORS 预检）"——
  //   那对**跨源**请求成立，对**同源冒用**不成立：DNS rebinding 让外部页面以 `evil.com:<port>`
  //   （与目标同源）打进来时，自定义头不需要预检，而 Host 是 evil.com。旧顺序先无条件放行自定义头
  //   ⇒ 那条路直接跳过 Host 校验，明文密钥就出去了。
  //   现在：非本机 Host 一律拒；自定义头只免除"Origin 必须等于 Host"这一条（桌面 file:// / 跨端口面板
  //   两种情况仍照旧放行）。配置了 server.token 且**匹配**的路径不受影响（上面已返回）。
  if (!isLoopbackHost) return false;
  if (headers['x-console-token']) return true;

  const origin = String(headers.origin ?? '');
  const referer = String(headers.referer ?? '');
  if (origin) return origin === `http://${host}`;
  if (referer) return referer.startsWith(`http://${host}/`);
  return true;
}

const KEY_DENIED = '请求来源不被信任，已拒绝读取明文密钥。';

/** 提供商脱敏（旧 `src/app.js:1419-1423`）：明文 key 一律不外发，只留 hasKey。 */
function sanitizeProvider(p) {
  if (!p || typeof p !== 'object') return p;
  const { apiKey, ...rest } = p;
  return { ...rest, apiKey: '', hasKey: Boolean(String(apiKey ?? '').trim()) };
}

// ── 用量：数据源 = M2 只读出口 obs.recent({name:'usage'}) ────────────────────

const USAGE_ROW_CAP = 2000;   // core/observability/sink.js:123 的上限就是 2000，超了只能报"可能不全"

/**
 * ★ 2026-10-17（读取边界的诚实化）：
 *   - "行数打满 2000" ≠ 数据不完整 —— 只要读到比有效窗口起点更早的行，窗口就是**覆盖完整**的
 *     （这是**如实边界**，价格可算完整，只是没读到那么远）；
 *   - 真正的"读取不完整"是读的过程中因**字节预算 / IO 错误 / 超大行 / 坏行**提前停
 *     （ds3 在 sink.readWithMeta 落的契约 meta{truncated/byteLimitReached/ioErrors/
 *     oversizedLines/malformedRows}）—— 这时读到的尾部**可能漏账本行**，窗口覆盖看起来好
 *     也必须把成本标成"不可信完成"。
 *   下面三个出口共用这一份判据（stats/breakdown 路由 + console-api 的 /api/status）。
 */

/** 读 usage 台账（最近 n 行）。优先 obs.recentWithMeta（ds3 的 readWithMeta 契约带 meta）；
 *  obs 层还没暴露该方法 / 抛错 / 返回形状变了 ⇒ 显式回退旧 obs.recent（meta=null，
 *  调用方据此标"读取完整性未知"，不作假完整）。obs.recent 返回非数组 ⇒ rows:null（调用方回 501）。 */
export async function readUsageLedgerWithMeta(obs, n) {
  if (typeof obs?.recentWithMeta === 'function') {
    try {
      const res = await obs.recentWithMeta({ name: 'usage', n });
      if (Array.isArray(res?.rows) && res.meta && typeof res.meta === 'object') {
        return { rows: res.rows, meta: normalizeUsageReadMeta(res.meta, res.rows, n) };
      }
      if (Array.isArray(res)) return { rows: res, meta: null };   // 退化为数组（签名变了）→ 旧用法
    } catch { /* 回退：旧 recent 从不把读失败往外抛，这里保持同口径 */ }
  }
  const rows = await obs.recent({ name: 'usage', n });
  if (!Array.isArray(rows)) return { rows: null, meta: null };
  return { rows, meta: null };
}

/** 把 ds3 契约的 read meta 归一成统计层能放心消费的形状（缺键用保守默认，不猜）。 */
function normalizeUsageReadMeta(meta, rawRows, requested) {
  const rowsReturned = Array.isArray(rawRows) ? rawRows.length : 0;
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const requested0 = num(meta.requested, requested) || requested;
  const limit = num(meta.limit, null);
  const returned = num(meta.returned, rowsReturned);
  return {
    requested: requested0,
    limit,
    returned,
    bytesRead: num(meta.bytesRead, null),
    // 行数打满 ⇒ hasMore（readWithMeta 的 rows-limit 语义）；meta 没给就用 returned>=limit 推。
    hasMore: meta.hasMore === true || (limit != null ? returned >= limit : false),
    byteLimitReached: meta.byteLimitReached === true,
    oversizedLines: Math.max(0, num(meta.oversizedLines, 0) || 0),
    malformedRows: Math.max(0, num(meta.malformedRows, 0) || 0),
    ioErrors: Math.max(0, num(meta.ioErrors, 0) || 0),
    truncated: meta.truncated === true,
    reason: typeof meta.reason === 'string' ? meta.reason : ''
  };
}

/**
 * 窗口覆盖性（⇒ { dataCoverage, rowCapHit }）
 *
 * · rowCapHit（保留旧字段语义，判据改按 meta）：按行数上限截断且**最老的有效行比有效窗口起点
 *   新** ⇒ 窗口更早的部分可能被截。meta 缺失时沿用旧判据 rowsLength>=cap。
 *   行数打满但窗口已被读到（oldest ≤ effectiveStart）⇒ **不**算被截，成本照旧可算完整。
 * · readIncomplete：读取**中途**停（字节预算 / IO 错误 / 超大行 / 坏行）⇒ 读到的尾部可能漏行，
 *   必须标 false（true）；meta 缺失 ⇒ null（完整性未知，不冒充完整也不武断说残缺）。
 * · unattributed（时间解析不出的行）不在本函数 —— 归属问题由调用方在窗口循环里数。
 *
 * @param {{rowsLength:number, oldestValidAt:?number, readMeta:?object, requested:number,
 *          effectiveStart:number}} arg
 */
export function usageWindowCoverage({ rowsLength, oldestValidAt, readMeta, requested, effectiveStart }) {
  const cap = readMeta?.limit ?? requested;
  const rowCapHit = (readMeta ? readMeta.hasMore === true : rowsLength >= cap)
    && (oldestValidAt == null || Number(oldestValidAt) > Number(effectiveStart));
  const readIncomplete = readMeta
    ? (readMeta.byteLimitReached === true
      || readMeta.ioErrors > 0
      || readMeta.oversizedLines > 0
      || readMeta.malformedRows > 0)
    : null;
  const dataCoverage = readMeta
    ? {
        metaAvailable: true,
        requested, readLimit: cap, returned: readMeta.returned ?? rowsLength, bytesRead: readMeta.bytesRead,
        hasMore: readMeta.hasMore === true, byteLimitReached: readMeta.byteLimitReached === true,
        oversizedLines: readMeta.oversizedLines, malformedRows: readMeta.malformedRows, ioErrors: readMeta.ioErrors,
        truncatedRead: readMeta.truncated === true,
        readIncomplete,
        windowStart: Number(effectiveStart),
        rowCapHit,
        reason: readMeta.reason || ''
      }
    : {
        metaAvailable: false,
        requested, returned: rowsLength, readIncomplete: null,
        windowStart: Number(effectiveStart),
        rowCapHit,
        reason: 'recent-with-meta-unavailable'
      };
  return { dataCoverage, rowCapHit };
}

/**
 * ★ 2026-10-17：峰谷节假日日历覆盖说明 —— rows 里出现哪几年、哪几年有官方日历为凭，
 * 哪几年只能按"工作日窗口"估算；日历来源一并带出。llm 模块没有新出口（旧版本）⇒
 * calendarYears=null（覆盖未知，宁可让 UI 显示"未知"也不冒充已覆盖）。
 */
export function peakCalendarFor(llm, rows) {
  const rowsYears = new Set();
  for (const r of rows) {
    const ms = Number(r?.at);
    if (Number.isFinite(ms) && ms > 0) rowsYears.add(new Date(ms).getFullYear());
  }
  const calendarYears = typeof llm?.peakCalendarYears === 'function' ? llm.peakCalendarYears().map(Number) : null;
  const covered = [];
  const estimated = [];
  for (const y of rowsYears) {
    (calendarYears != null && calendarYears.includes(y) ? covered : estimated).push(y);
  }
  const byYear = (a, b) => a - b;
  return {
    calendarYears,
    coveredYears: covered.sort(byYear),
    estimatedYears: estimated.sort(byYear),
    sources: typeof llm?.peakCalendarSources === 'function' ? llm.peakCalendarSources() : null,
    note: '峰谷节假日判定：覆盖年份按官方法定节假日日历（节假日全天空闲）；未覆盖年份按工作日窗口估算，节假日会误判为高峰（成本偏高）。'
  };
}

/** 旧 `src/app.js:3992-4008`。 */
function resolveRange(raw) {
  const s = String(raw || '7').trim().toLowerCase();
  const now = Date.now();
  if (s === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return { mode: 'today', start: d.getTime(), end: now, label: '今天' };
  }
  if (s === '24h') return { mode: '24h', start: now - 24 * 60 * 60 * 1000, end: now, label: '最近 24 小时' };
  const n = Math.min(30, Math.max(1, Number(s) || 7));
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return { mode: 'days', start: d.getTime() - (n - 1) * 24 * 60 * 60 * 1000, end: now, label: `最近 ${n} 天` };
}

/** 旧 `src/app.js:4011-4014`：本地时区 YYYY-MM-DD。 */
function dayKeyOf(ts) {
  const d = new Date(Number(ts) || 0);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * 取时间窗内的 usage 行。
 * 旧树是 `getUsageLedger().query(win)`（自带对账）；新树只有 M2 的 ndjson 台账 ⇒ 读最近
 * `USAGE_ROW_CAP` 行后自己按窗口过滤。读不到出口 ⇒ null（调用方回 501，不许当成"零用量"）。
 *
 * ★ 2026-10-17（读取/归属两类完整性）：
 *   · 读台账走 readUsageLedgerWithMeta（优先 recentWithMeta，缺方法回退 recent）——
 *     行数上限与读取中途截断从此分开如实报（dataCoverage / rowCapHit）；
 *   · `at` 解析不出的行**不再无声丢弃** ⇒ 计入 `unattributed`（数量+token），
 *     不进任何窗口/分天/峰谷，也不补 0；调用方把它并入 costComplete 语义
 *     （这些行**可能属于窗口**，在归属清楚之前什么完整都谈不上）。
 */
async function collectUsageRows(ctx, { range }) {
  const obs = ctx?.obs;
  if (typeof obs?.recent !== 'function') return null;
  const llm = getMod(ctx, 'llm');
  const { rows: raw, meta: readMeta } = await readUsageLedgerWithMeta(obs, USAGE_ROW_CAP);
  if (!Array.isArray(raw)) return null;
  // ★ 2026-10-16（用户令 · 调试清零）：统计只算**清零边界之后**的行；原始账本一个字节不动。
  //   `obs.usageRowsSinceReset` 缺失（旧出口/测试替身）⇒ 不筛（保持旧行为）；
  //   边界 `invalid`/`unreadable` 时行原样返回、状态带出去给上层显示（不静默当"没边界"）。
  let scopedRows = raw;
  let resetBoundary = { state: 'absent', at: null, atIso: null, reason: '', dropped: 0, droppedUnknownAt: 0 };
  if (typeof obs.usageRowsSinceReset === 'function') {
    try {
      const scoped = await obs.usageRowsSinceReset(raw);
      if (scoped && Array.isArray(scoped.rows) && scoped.boundary) {
        scopedRows = scoped.rows;
        resetBoundary = scoped.boundary;
      }
    } catch {
      resetBoundary = { state: 'unavailable', at: null, atIso: null, reason: 'reset-boundary-read-failed', dropped: 0, droppedUnknownAt: 0 };
    }
  }
  const win = resolveRange(range);
  // ★ 未归属行（时间解析不出）：boundary=ok 时它们已被 usageRowsSinceReset 滤走（行数
  //   记在 boundary.droppedUnknownAt，token 拿不到）；boundary 缺失/不可用时还在
  //   scopedRows 里，本地数（token 可数）。数量取两路之大，token 只在本地数得到时才给。
  let unattributedCalls = 0;
  let unattributedTokens = 0;
  let unattributedLocalCount = 0;
  let oldestValidAt = null;
  const rows = [];
  for (const row of scopedRows) {
    // ★ 2026-10-17：`at` 既可能是毫秒数，也可能是 ISO 字符串（历史/导入台账）——
    //   统一走 llm.toEpochMs（同一份判据，数字/Date/ISO 都认）。
    const at = typeof llm?.toEpochMs === 'function' ? (llm.toEpochMs(row?.at) ?? 0) : (Number(row?.at) || 0);
    if (!at) {
      unattributedCalls += 1;
      unattributedLocalCount += 1;
      unattributedTokens += (Number(row?.promptTokens) || 0) + (Number(row?.completionTokens) || 0);
      continue;
    }
    if (oldestValidAt == null || at < oldestValidAt) oldestValidAt = at;
    if (at < win.start || at > win.end) continue;
    const model = String(row?.model ?? '');
    const vendor = row?.vendor ? String(row.vendor) : '';
    // 旧台账自带 modelKey（渠道：模型 复合身份），新台账没有 ⇒ 用 llm 的公开出口 modelLabel 现算，
    // 否则"渠道价"永远匹配不上（旧 app.js:4039-4047 的口径）。
    const modelKey = vendor && typeof llm?.modelLabel === 'function' ? llm.modelLabel(vendor, model) : model;
    rows.push({ ...row, at, model, vendor, modelKey, dayKey: dayKeyOf(at) });
  }
  if (resetBoundary.state === 'ok' && Number(resetBoundary.droppedUnknownAt || 0) > unattributedCalls) {
    unattributedCalls = Number(resetBoundary.droppedUnknownAt);
    unattributedTokens = null;   // 边界滤走的行拿不到 token —— 数量如实报，token 不编
  }
  rows.sort((a, b) => a.at - b.at);
  // 有效窗口起点 = 窗口起点与清零边界的较晚者（边界之前的行本来就不计入，不该被当成"被截"）。
  const effectiveStart = resetBoundary.state === 'ok' && Number.isFinite(Number(resetBoundary.at))
    ? Math.max(win.start, Number(resetBoundary.at)) : win.start;
  // 2000 行上限 + 读取中途截断分开评；rowCapHit：窗口内最老一行比"有效窗口起点"新
  // ⇒ 前面可能被截掉，如实告诉前端"这份统计可能不全"。
  const coverage = usageWindowCoverage({ rowsLength: raw.length, oldestValidAt, readMeta, requested: USAGE_ROW_CAP, effectiveStart });
  let searchCount = 0;
  const toolCounts = {};
  for (const r of rows) {
    searchCount += Number(r.webSearchCount) || 0;
    for (const name of (Array.isArray(r.toolNames) ? r.toolNames : [])) {
      const key = String(name || '');
      if (key) toolCounts[key] = (toolCounts[key] || 0) + 1;
    }
  }
  return {
    rows, win, searchCount, toolCounts, building: false, progress: { done: 0, total: 0 },
    rowCapHit: coverage.rowCapHit,
    resetBoundary,
    dataCoverage: coverage.dataCoverage,
    unattributed: { calls: unattributedCalls, tokens: unattributedTokens, localCount: unattributedLocalCount }
  };
}

/** 旧 `src/app.js:4039-4047`：渠道价只在 source==='custom' 时才算数。 */
// ★ 新树唯一的用量计价口径，console-api.js 的 /api/status 复用它（T-STATUS-TRUTH-BACK）
export function makePriceOf(ctx, llm) {
  const cfg = (() => { try { return ctx?.configStore?.get?.() ?? {}; } catch { return {}; } })();
  return function priceOf(model, vendor) {
    if (vendor && typeof llm?.resolveModelPrice === 'function') {
      const label = typeof llm.modelLabel === 'function' ? llm.modelLabel(vendor, model) : model;
      const byVendor = llm.resolveModelPrice(label, cfg);
      if (byVendor?.source === 'custom') return byVendor;
    }
    if (typeof llm?.resolveModelPrice === 'function') return llm.resolveModelPrice(model, cfg);
    // 兼容缝（旧 llm 模块只有 resolveOfficialPrice）：把来源/priced 一并带上，
    // 否则 costOfRows 会把"查不到价"的 0 当成可信成本（2026-10-17 修）。
    if (typeof llm?.resolveOfficialPrice === 'function') {
      const p = llm.resolveOfficialPrice(model);
      // ★ 2026-10-17（来源可分）：旧 llm 模块没有 resolveModelPrice 的新分层字段，
      //   这里按表条目 src 把 approximate/priceSrc/note 尽量带出（official 拆精确 vs 近似）。
      return p
        ? {
          ...p,
          source: 'official',
          priced: true,
          approximate: p.src === 'derived',
          priceSrc: p.src ?? 'official',
          note: typeof p.note === 'string' ? p.note : ''
        }
        : { in: 0, out: 0, cached: 0, source: 'unmatched', priced: false };
    }
    return { in: 0, out: 0, cached: 0, source: 'none', priced: false };
  };
}

/** 单次请求内的价格缓存（旧 `src/app.js:4054-4063`：价表前缀扫描很贵）。 */
export function createPriceCache(priceOf) {
  const cache = new Map();
  return (model, vendor) => {
    const key = String(vendor || '') + ' ' + String(model || '');
    if (cache.has(key)) return cache.get(key);
    const p = priceOf(model, vendor);
    cache.set(key, p);
    return p;
  };
}

/**
 * 旧 `src/app.js:4066-4106`：字段名一个都不许改（UI 直接读这些键）。
 *
 * ★ 2026-10-17（DeepSeek 峰谷 / 未知价）：
 *   · 每行按**自己的 `at`** 选峰谷；`at` 不是有限正数 ⇒ 用基础（空闲）档 + 记
 *     `unknownTimeCost/tokens`、`timeUnknownCalls`，**不按当前时间猜**；
 *   · 价格对象带 `priced:false`（unmatched/none）⇒ 计入 `unpricedCalls/Tokens`，
 *     成本贡献仍是 0（相容），但 `costComplete=false`，调用方必须显示"未定价/部分估算"；
 *   · `created` 只有价格条目明确给出才算创建价，否则按普通输入价（不套 1.25）。
 */
export function costOfRows(rows, getPrice, llm) {
  let cost = 0, peakCost = 0, offPeakCost = 0, unknownTimeCost = 0;
  let peakTokens = 0, offPeakTokens = 0, unknownTimeTokens = 0;
  let promptTokens = 0, completionTokens = 0, cachedTokens = 0, creationTokens = 0, exactCalls = 0;
  let hasPeakModel = false, pricedCalls = 0, unpricedCalls = 0, zeroPricedCalls = 0, timeUnknownCalls = 0;
  let pricedTokens = 0, unpricedTokens = 0;
  // ★ 2026-10-17（来源可分）：official 拆三股 —— 官方精确 / officialApprox（表内 'derived'
  //   近似条目：旧别名/按档折算，不是官方精确现价）/ remote（远程价格表覆盖，可能是旧缓存，
  //   内置表或已重核更新）。旧四键照旧累加，新增两键从 0 起且只增不动旧键 —— UI 现有读取不受影响。
  const costSources = { official: 0, officialApprox: 0, remote: 0, custom: 0, manual: 0, unmatched: 0, none: 0 };
  const sessionIds = new Set();
  for (const r of rows) {
    const p = getPrice(r.model, r.vendor);
    if (p.peak) hasPeakModel = true;
    const priced = p?.priced !== false;   // 旧价格对象没有 priced 字段 ⇒ 沿用旧口径（视为已定价）
    const sourceKey = String(p?.source || 'none');
    // ★ 2026-10-17：official 命中再分层 —— remote 优先（来源 provenance 最能解释"为什么和内置表不一样"），
    //   其次 approximate（表内近似条目）；都没有才落官方精确桶。旧模块价格对象没有这些
    //   字段 ⇒ 一律照旧落 official（行为不额外变差）。
    if (sourceKey === 'official' && p?.remote === true) costSources.remote += 1;
    else if (sourceKey === 'official' && p?.approximate === true) costSources.officialApprox += 1;
    else if (Object.prototype.hasOwnProperty.call(costSources, sourceKey)) costSources[sourceKey] += 1;
    if (priced) { pricedCalls += 1; if (p.zero === true) zeroPricedCalls += 1; } else unpricedCalls += 1;
    const atMs = typeof llm?.toEpochMs === 'function' ? llm.toEpochMs(r.at) : Number(r.at);
    const timeKnown = atMs != null && Number.isFinite(Number(atMs)) && Number(atMs) > 0;
    if (!timeKnown) timeUnknownCalls += 1;
    const tier = p.peak
      ? (typeof llm?.priceAt === 'function'
        ? llm.priceAt({ in: p.in, out: p.out, cached: p.cached, created: p.created, peak: p.peak }, timeKnown ? atMs : null)
        : { in: p.in, out: p.out, cached: p.cached, created: p.created, peak: false, peakUnknown: !timeKnown })
      : { in: p.in, out: p.out, cached: p.cached, created: p.created, peak: false, peakUnknown: false };
    const prompt = Number(r.promptTokens) || 0;
    const completion = Number(r.completionTokens) || 0;
    const cached = Math.min(Number(r.cachedTokens) || 0, prompt);
    const creation = Math.min(Number(r.cacheCreationTokens) || 0, Math.max(0, prompt - cached));
    const fresh = Math.max(0, prompt - cached - creation);
    const creationPrice = Number(tier.created != null ? tier.created : tier.in) || 0;
    const c = (fresh / 1_000_000) * tier.in
      + (creation / 1_000_000) * creationPrice
      + (cached / 1_000_000) * (tier.cached ?? 0)
      + (completion / 1_000_000) * (tier.out ?? 0);
    cost += c;
    const tk = prompt + completion;
    if (priced) pricedTokens += tk; else unpricedTokens += tk;
    // 峰谷归属按"调用发生在哪个时段"判定；时间不可信 ⇒ 单独一桶，不冒充任何时段。
    //   注意：这个归属**与模型是否有分档无关**（旧口径）—— GLM 等无峰谷模型在高峰时段
    //   花掉的钱也要落进 peakCost，否则"高峰花了多少"会失真。
    //   有峰谷分档的模型（p.peak）与分档取价用的是同一个 isPeakHour ⇒ 两处一致。
    const isPeakTime = timeKnown && (p.peak
      ? tier.peak === true
      : (typeof llm?.isPeakHour === 'function' ? llm.isPeakHour(atMs) === true : false));
    if (!timeKnown) { unknownTimeCost += c; unknownTimeTokens += tk; }
    else if (isPeakTime) { peakCost += c; peakTokens += tk; }
    else { offPeakCost += c; offPeakTokens += tk; }
    promptTokens += prompt;
    completionTokens += completion;
    cachedTokens += cached;
    creationTokens += creation;
    if (r.exact) exactCalls += 1;
    if (r.sessionId) sessionIds.add(String(r.sessionId));
  }
  const sessions = sessionIds.size || (rows.length ? rows.length : 0);
  return {
    cost, peakCost, offPeakCost, unknownTimeCost, peakTokens, offPeakTokens, unknownTimeTokens,
    promptTokens, completionTokens, cachedTokens, cacheCreationTokens: creationTokens,
    totalTokens: promptTokens + completionTokens,
    cacheHitRate: promptTokens ? Math.min(1, cachedTokens / promptTokens) : 0,
    peakRatio: (peakTokens + offPeakTokens) ? peakTokens / (peakTokens + offPeakTokens) : 0,
    exactCalls, hasPeakModel, runs: rows.length, sessions,
    callsPerSession: sessions ? rows.length / sessions : 0,
    promptPerSession: sessions ? promptTokens / sessions : 0,
    // ★ 2026-10-17 新增（相容追加）：价格来源与完整性 —— unpriced/timeUnknown 时成本不是"可信 0"；
    //   costSources.official 现在只数"官方精确"命中，表内近似与远程覆盖分别落
    //   officialApprox / remote（本函数不管读取覆盖 —— 那是调用方的窗口级语义）。
    pricedCalls, unpricedCalls, zeroPricedCalls, timeUnknownCalls,
    pricedTokens, unpricedTokens, costSources,
    costComplete: unpricedCalls === 0 && timeUnknownCalls === 0,
  };
}

/** 旧 `src/app.js:4109-4120`。 */
function groupBy(rows, field, getPrice, llm) {
  const map = new Map();
  for (const r of rows) {
    const k = String(r[field] ?? '(未知)');
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  const out = [...map.entries()].map(([key, list]) => ({ key, ...costOfRows(list, getPrice, llm) }));
  out.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
  return out;
}

// ── 聊天存档：数据源 = ctx.modulesObj.memory.store（装配层挂的 ChatStore 实例）──

/** 旧 `src/app.js:3473-3479`：字段必须逐条给全，`media` 漏了前端图片全丢。 */
function messageRow(m) {
  return {
    id: m?.id, mid: m?.mid ?? null, ts: m?.ts, senderId: m?.senderId, senderName: m?.senderName,
    text: m?.text, self: m?.self, read: m?.read, reply: m?.reply ?? null,
    media: Array.isArray(m?.media) ? m.media : []
  };
}

function storeOf(ctx) {
  return getMod(ctx, 'memory')?.store ?? null;
}

const STORE_MISSING = () => notPorted(
  'memory.store（ChatStore 实例）—— 装配层已挂 modulesObj.memory.store（assembly.js:162-163）；'
  + ' 若这里仍报缺失说明 ctx 不是真实运行时。旧实现 src/app.js:2909-2926'
);

// ── /api/config/defaults 的默认值投影（旧 src/app.js:2695-2723）──────────────

/**
 * 密钥名判定：旧树用「词边界 + 单复数」三件套（app.js:1327-1332 + SECRET_SINGLE_WORDS）。
 * 新树没有那套件 ⇒ 用与 console-api.js:206 同一张正则，**只严不松**：
 * 命中就把默认值藏掉并记 problem；number/boolean 的默认值放行（旧树同口径 :2718）。
 */
const SECRET_NAME_RE = /(key|token|secret|password|credential|apikey|accesstoken)/i;
const SECRET_NAME_EXCLUDE = /from$/i;

function defaultPathValue(defaults, dotted) {
  let cur = defaults;
  for (const seg of String(dotted).split('.')) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(seg)) return undefined;                    // 段白名单
    if (!cur || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;       // 不走原型链
    cur = cur[seg];
  }
  return cur;
}

function secretNamedPath(dotted) {
  const segs = String(dotted).split('.');
  return segs.some((seg) => SECRET_NAME_RE.test(seg) && !SECRET_NAME_EXCLUDE.test(seg));
}

// ── 主入口 ────────────────────────────────────────────────────────────────

export async function handle({ method, pathname, query, body, ctx, req }) {
  if (!pathname || pathname !== '/api' && !pathname.startsWith('/api/')) return null;

  const memory = getMod(ctx, 'memory');
  const llm = getMod(ctx, 'llm');
  const internet = getMod(ctx, 'internet');
  const media = getMod(ctx, 'media');

  // GET /api/api-news (legacy src/app.js:3121-3129): M14 exports the original cache/refresher.
  if (pathname === '/api/api-news' && method === 'GET') {
    if (typeof internet?.getApiNews !== 'function' || typeof internet?.apiNewsStatus !== 'function') {
      return notPorted('internet.getApiNews()/apiNewsStatus()（M14 modules/internet/index.js）');
    }
    try {
      const data = await internet.getApiNews({ force: query?.get?.('force') === '1' });
      return json(200, { ...data, status: internet.apiNewsStatus() });
    } catch (error) {
      return json(200, { ok: false, error: String(error?.message ?? error), items: [] });
    }
  }
  // POST /api/api-news（旧 src/app.js:3131-3139）—— 强制刷新。
  // ★ N31：改前**没有这个 handler** ⇒ 落到 `http.js:154` 的兜底 404「未找到 POST /api/api-news」。
  //   而它的兄弟 GET 在同一个能力缺失时回的是 **501 not-ported** —— 同一族端点两种"没有"，
  //   排障时会被当成两件不同的事。现在统一成 501，并点名缺哪个出口。
  //   形状仍照旧树：成功 `{...data, status}`；失败 **500** + `{ok:false,error,items:[]}`。
  if (pathname === '/api/api-news' && method === 'POST') {
    if (typeof internet?.refreshApiNews !== 'function' || typeof internet?.apiNewsStatus !== 'function') {
      return notPorted('internet.refreshApiNews()/apiNewsStatus()（旧 src/app.js:3131-3139）');
    }
    try {
      const data = await internet.refreshApiNews();
      return json(data?.ok === false ? 500 : 200, { ...data, status: internet.apiNewsStatus() });
    } catch (error) {
      return json(500, { ok: false, error: String(error?.message ?? error), items: [] });
    }
  }

  // ═══ 0b. 清洗消息记录 / 会话存档（旧 src/app.js:2881-2899，POST /api/purge-records）═══
  //
  // ★ N31（2026-10-09）：改前**没有这个 handler** ⇒ 落到 http.js 兜底 404。
  //   老树一次洗两样：① 消息记录 `data/messages/**`（store.purgeAll/purgeChat）
  //                  ② 会话存档 `data/sessions/**`（sessions.purge，按 chatKey / all）。
  //   新树的真实出口盘点：
  //     · 消息 —— `modules/memory/chat-store.js:615/628` 有 purgeChat / purgeAll ⇒ **能照老树真做**；
  //     · 会话 —— 新树 sessions 只有 `softDeleteBatch`（进回收站）与 cleanup 的"从回收站永久删"，
  //       **没有"按 chatKey 永久删存档"这个出口** ⇒ 老树那半**照抄不了**。
  //   ⇒ 这里的选择：**能做的那半真做，做不了的那半如实说**，绝不回一句 "ok:true" 假装全洗了
  //     （那正是这个仓库最恨的那种假绿）。`sessions` 字段原样带回未完成的原因。
  if (pathname === '/api/purge-records' && method === 'POST') {
    const all = body?.all === true || body?.scope === 'all';
    const chatKey = all ? null : String(body?.chatKey || '').trim();
    if (!all && !/^(group|private):\d+$/.test(chatKey)) {
      return json(400, { ok: false, error: '需要合法的会话（group:群号 / private:QQ号），或 all=true' });
    }
    const wantMessages = body?.messages !== false;
    const wantSessions = body?.sessions !== false;
    const store = storeOf(ctx);
    const out = { ok: true, scope: all ? 'all' : chatKey };
    if (wantMessages) {
      if (typeof store?.purgeAll !== 'function' || typeof store?.purgeChat !== 'function') {
        out.ok = false;
        out.messages = { ok: false, error: 'not-ported: chat-store.purgeAll/purgeChat（装配层未挂 memory.store）' };
      } else {
        try {
          out.messages = all ? store.purgeAll() : store.purgeChat(chatKey);
        } catch (error) {
          out.ok = false;
          out.messages = { ok: false, error: String(error?.message ?? error) };
        }
      }
    }
    if (wantSessions) {
      out.sessions = {
        ok: false,
        error: 'not-ported: 老树 sessions.purge({chatKey,all})（按会话**永久**删存档）——'
          + '新树只有回收站（softDeleteBatch）与"从回收站永久删"，没有按 chatKey 直接永久删的出口。'
          + '老树那半**照抄不了**，不假装做完。'
      };
      out.ok = false;
    }
    try { ctx?.obs?.log?.('info', 'purge-records', { scope: out.scope, messages: out.messages ?? null }); } catch { /* 日志不许拖垮洗记录 */ }
    return json(200, out);
  }

  // ═══ 1. 聊天列表与存档（旧 src/app.js:2909-2926 / 3468-3481 / 3575-3590）═══

  if (pathname === '/api/chats' && method === 'GET') {
    const store = storeOf(ctx);
    if (typeof store?.listChats !== 'function' || typeof store?.getChatMeta !== 'function') return STORE_MISSING();
    let chats;
    try {
      chats = store.listChats().map((key) => {
        const meta = store.getChatMeta(key) || {};
        // 保持旧列表的公开字段；sourceRevision 是 ChatStore 增量读取游标，不属于此接口形状。
        return {
          key,
          chatKey: meta.chatKey,
          total: meta.total,
          unread: meta.unread,
          lastTs: meta.lastTs,
          lastText: meta.lastText,
        };
      }).sort((a, b) => b.lastTs - a.lastTs);
    } catch (error) { return serverError(error); }
    // 群名：旧实现走 orchestrator.getChatName（超时 3s 退回 ''）。新树 orchestrator 只有
    // createRuntime，没有这个出口 ⇒ 按旧树的**失败分支**给 ''，UI 自动只显示群号。
    for (const c of chats) c.chatName = '';
    return json(200, { chats });
  }

  const chatMsgMatch = /^\/api\/chats\/(group|private)_(\d+)\/messages$/.exec(pathname);
  if (chatMsgMatch && method === 'GET') {
    const store = storeOf(ctx);
    if (typeof store?.recent !== 'function') return STORE_MISSING();
    const chatKey = `${chatMsgMatch[1]}:${chatMsgMatch[2]}`;
    const limit = Math.min(1048576, Math.max(1, Number(query?.get?.('limit')) || 1048576));
    try {
      return json(200, { chatKey, messages: store.recent(chatKey, { limit }).map(messageRow) });
    } catch (error) { return serverError(error); }
  }

  const chatMarkRead = /^\/api\/chats\/(group|private)_(\d+)\/mark-read$/.exec(pathname);
  if (chatMarkRead && method === 'POST') {
    const store = storeOf(ctx);
    if (typeof store?.drainUnread !== 'function') return STORE_MISSING();
    const chatKey = `${chatMarkRead[1]}:${chatMarkRead[2]}`;
    try {
      const drained = store.drainUnread(chatKey) || [];
      // ★ 2026-10-11（mark-read 刷新缺口 · 指挥位转 mimo2）：老树这里 `emit('chat-update', chatKey)`
      //   推 SSE ⇒ UI 的 chat-update handler（apps/ui/app.js:4714/4982：**不读载荷**，只当"这会话变了，去重拉"）
      //   立刻刷新会话列表。新树当年因为"bus 事件名冻结、不含 chat-update"没搬（本注释原话），
      //   ★ 但裁甲 `edcd267b` 已把 bus 的 `chat-update` **同名直通**进桥（sse-bridge `DIRECT_BUS_TO_UI`），
      //     且 hub 的 allowedNames 由 `BRIDGED_UI_NAMES` 派生（index.js:287）⇒ 这里**补一行生产者**即闭环。
      //   生产者出口 = `ctx.emit`（= `obs.emit`，assembly.js:1393；同款用法见 api/media.js:382）。
      //   缺 emit **不静默**：留一行可见告警再继续（照 api/media.js:375-378 的口径）——
      //   反正 drain 已经生效，只是列表要等 UI 下次轮询才刷新。
      if (typeof ctx?.emit === 'function') ctx.emit('chat-update', chatKey);
      else console.warn(`[api/console] ⚠ ctx 缺 emit ⇒ mark-read(${chatKey}) 的列表刷新帧发不出（UI 只能等下次轮询）`);
      return json(200, { ok: true, marked: drained.length });
    } catch (error) { return serverError(error); }
  }

  const chatWake = /^\/api\/chats\/(group|private)_(\d+)\/wake$/.exec(pathname);
  if (chatWake && method === 'POST') {
    // ★ N105（2026-10-10）接线。老树：`orchestrator.forceWake(chatKey)`（旧 src/app.js:3551-3556
    //   → src/orchestrator.js:1210，注释原文「**手动触发一次处理（UI 按钮）**」= `scheduleWake(chatKey, 0)`；
    //   该会话正在跑就回 false，否则排队回 true）。
    // ★ 新树等价物**已经挂上运行时了**（此前没有，所以这里一直 501）：
    //     · `modules/orchestrator/index.js:3063` `createRuntime` 返回
    //       `{ onInbound, wake, onTick, status, pause, resume, abortAll, sendScheduled }`（含 `wake`）；
    //     · `wake(request)` 在 `:2759` 按载荷形状分流，`{chatKey, proactive:true}` ⇒
    //       `startProactiveRound()`（`:2724`）—— 同样先判 aborted/paused/busy/pending/并发满，
    //       再排一次轮；UI 按钮文案正是「唤醒一次处理」（apps/ui/app.js:7084）。
    // ★ HTTP ctx 拿得到运行时：`apps/server/index.js:188 ctx.setRuntime(runtime)` + `:381 get runtime()`
    //   （同款用法见 `api/shell.js:577`）。
    // ★ 语义差异**如实记，别当下一个人猜**：老树唤醒的是该会话**已有的待处理证据**；新树在该会话
    //   有积压时 `startProactiveRound` 返回 `skip('chat-pending')`（交给既有队列处理），没有积压时跑
    //   **无证据主动轮**。两者都仍要过白名单/档位/plan 等全部闸，不是旁路直发。
    // ★ 不 await：一轮可能跑好几秒，挂住 HTTP 没有意义（老树 forceWake 本身也是同步回 true/false）。
    const runtimeWake = ctx?.runtime;
    if (typeof runtimeWake?.wake !== 'function') {
      return notPorted('runtime.wake(request)（老树 orchestrator.forceWake：旧 src/app.js:3551-3556 → src/orchestrator.js:1210 scheduleWake(chatKey,0)）'
        + '—— M15 运行时未起、未注入 HTTP ctx，或该运行时未暴露 wake（modules/orchestrator/index.js:3063）');
    }
    const wakeChatKey = `${chatWake[1]}:${chatWake[2]}`;
    try {
      const out = runtimeWake.wake({ chatKey: wakeChatKey, proactive: true, proactiveReason: 'manual-console' });
      if (out && typeof out.then === 'function') {
        out.then((r) => {
          ctx?.log?.(`[console] 唤醒 ${wakeChatKey} → ${r?.status ?? 'done'}${r?.reason ? ` (${r.reason})` : ''}`);
        }).catch((e) => { ctx?.log?.(`[console] 唤醒 ${wakeChatKey} 失败：${e?.message ?? e}`); });
      }
      return json(200, {
        ok: true, chatKey: wakeChatKey, queued: true,
        note: '已排入运行时；接受/跳过的原因（chat-busy / chat-pending / paused / 并发满…）落在服务日志与状态里，本轮不等它跑完。'
      });
    } catch (error) { return serverError(error); }
  }
  const chatTestSend = /^\/api\/chats\/(group|private)_(\d+)\/test-send$/.exec(pathname);
  if (chatTestSend && method === 'POST') {
    return notPorted(
      '控制台直发测试消息（旧 src/app.js:3559-3574 直接 onebot.sendText + store.appendSelf）。'
      + ' 新树唯一发送出口是 act.send/platform.sendTextBatch，要它得由指挥位接线，API 层不许自己发'
    );
  }

  // ═══ 2. 会话 / 话题 / 记忆页（台账与印象库未移植 ⇒ 501）═══

  if (pathname === '/api/memory-audit' && method === 'GET') {
    return null; // 让位给 api/memory.js 切片
  }
  if (pathname === '/api/memory-people' && method === 'GET') {
    // ★ N67（2026-10-10）改回 **让位**：这里原来硬回 501，于是**同一份文件集里已经写好的真实现**
    //   `api/memory.js:154-244`（A 方案只读视图：`memory.retrieve({types:['impression']})` 按 subjectId
    //   聚合 + `emotion.persons[].favor` + 逐项诚实 notPorted）**永远够不着** ——
    //   分片按文件名字母序（`http.js:24` `.sort()`）console 先于 memory 被问，本片一回 501 就把
    //   下一片的 200 吃掉了。`memory.js` 自己的 `OWNED_PATHS` 里**明写着认领这条**。
    //   ⇒ 与 N33 对 `consolidate-all` / `memory-files/consolidate` 的处置同一条规矩（见 `:474`/`:495`）。
    // ★ 生产行为不变（`console-api.js:881 getMemoryPeople` 用 `memory.history({scope:'global'})`
    //   在**所有分片之前**就答了，`http.js:93-94`）；改的是**分片链自洽**：不再让一片的 501
    //   盖住下一片的真实现。断言同步从"必须 501"移进 `MUST_YIELD`，理由写在 console.selftest 里。
    return null;
  }
  if (pathname === '/api/memory-people/cleanup' && method === 'POST') {
    // 四份记忆侧契约已交付；api/memory.js 负责转发并把 notImplemented 原样给面板。
    return null;
  }
  if (pathname === '/api/memory-people/consolidate-all' && method === 'POST') {
    // ★ N33（2026-10-09）：这里原来硬回 501，于是 `api/memory.js` 里新接好的**真排队实现**
    //   （`ctx.memoryCoordinator.requestConsolidation`，逐会话排 job）**永远够不着** ——
    //   分片按文件名序，console.js 在 memory.js 之前被问（`http.js:29-31`）。
    //   ⇒ **必须 return null 让路**（与本文件下方 semantic-cards 那段同一个道理，已写在 `:833-838` 的注释里）。
    //   真缺的能力仍在 `api/memory.js` 那侧如实 501（缺 coordinator 时）。
    return null;
  }
  if (pathname === '/api/memory-people/all' && method === 'DELETE') {
    // 旧 src/app.js:3310-3313：**有意**拒绝一键清空（防误删），不是缺能力 ⇒ 保持 400，不许改成 501
    return json(400, { ok: false, error: '请逐个删除成员' });
  }
  if (pathname === '/api/memory-people/name-only' && method === 'DELETE') {
    return null; // api/memory.js 接 memory.removeNameOnlyMember(name)。
  }
  if (/^\/api\/memory-people\/\d+$/.test(pathname) && method === 'PUT') {
    return null; // api/memory.js 接 editPersonImpressions，PUT 校验失败为 400。
  }
  if (/^\/api\/memory-people\/\d+$/.test(pathname) && method === 'DELETE') {
    return null; // api/memory.js 接 memory.removeMember，按 reason 分级 400/404/500。
  }
  if (/^\/api\/memory-people\/\d+\/surface$/.test(pathname) && method === 'DELETE') {
    return null; // api/memory.js 接 memory.clearSurface；kind 维度不支持，由它明确回 400。
  }
  if (pathname === '/api/memory-files/consolidate' && method === 'POST') {
    // ★ N33：同上 —— 老 UI `ui/app.js:9156` 打的正是这条，改前恒 501「点了没反应」。
    //   现在实现住在 `api/memory.js`（接 `ctx.memoryCoordinator.requestConsolidation` 真排队），
    //   本片必须让路，否则那条实现永远到不了。
    return null;
  }
  // ★ 2026-10-11（sp3 · P0 删卡范围 + P2-3）：这里原先回 501「新树无此出口」，
  //   把 `api/memory.js` 的真实现整条挡住（分片按文件名序 console < memory，`http.js:114` 先答者赢）
  //   ⇒ 面板那个"删除"按钮永远只显示一句开发者文案。真实现早就在：
  //   `api/memory.js` 的 DELETE /api/semantic-cards/:id 走 M6 `cards()` + `forget()`，
  //   且 2026-10-11 起**范围锁死**在卡片自己的 scope/chatKey + 当前生效观察的 evidenceIds
  //   （改前是 `forget(subjectId)` 不带范围 ⇒ 删一张 = 撤回这个人在所有会话的全部记忆）。
  //   ⇒ 本片让路（与上面 memory-files/consolidate 同一处置）。别再在本片写第二份。
  if (/^\/api\/semantic-cards\//.test(pathname) && method === 'DELETE') return null;

  // ═══ 3. 用量（数据源 obs.recent({name:'usage'})，聚合按旧 src/app.js:3992-4190）═══

  if ((pathname === '/api/usage/stats' || pathname === '/api/usage/breakdown') && method === 'GET') {
    if (typeof ctx?.obs?.recent !== 'function') return notPorted('observability.recent（M2 只读出口）—— 用量台账读不到');
    if (typeof llm?.resolveModelPrice !== 'function' || typeof llm?.priceAt !== 'function' || typeof llm?.isPeakHour !== 'function') {
      return notPorted('llm 的计价出口 resolveModelPrice/priceAt/isPeakHour（旧 src/app.js:4039-4106 全靠它）');
    }
    const raw = String(query?.get?.('range') || query?.get?.('days') || '7');
    try {
      const collected = await collectUsageRows(ctx, { range: raw });
      if (!collected) return notPorted('observability.recent({name:"usage"}) 无返回');
      const { rows, win, searchCount, toolCounts, building, progress, rowCapHit, resetBoundary, dataCoverage, unattributed } = collected;
      // ★ 2026-10-17：好价态可分（渠道价/自定义/官方/近似/远程），读取/归属覆盖与价格无涉但
      //   同属于"这份统计完整吗"——路由层把窗口级信号并入 totals.costComplete 后返回。
      const windowComplete = rowCapHit !== true
        && dataCoverage.readIncomplete !== true
        && !(unattributed.calls > 0);
      if (pathname === '/api/usage/stats') {
        const getPrice = createPriceCache(makePriceOf(ctx, llm));
        const totals = costOfRows(rows, getPrice, llm);
        // 价格口径全知 ≠ 统计完整：窗口早端可能被截 / 读取中途截断 / 有未归属时间的行
        // ⇒ 成本不能再标"可信完成"。分组（days/chats/models）里的 costComplete 仍只是
        // **价格口径**（各分组行集合只是 subsets，读取覆盖是整读同一份，放顶层不重复）。
        totals.costComplete = totals.costComplete === true && windowComplete;
        const byDay = win.mode === 'days'
          ? groupBy(rows, 'dayKey', getPrice, llm).map((x) => ({ day: x.key, ...x })).sort((a, b) => a.day.localeCompare(b.day))
          : [];
        const chats = groupBy(rows, 'chatKey', getPrice, llm);
        const { splitModelLabel } = llm;
        const models = groupBy(rows, 'modelKey', getPrice, llm).map((m) => (
          typeof splitModelLabel === 'function' ? { ...m, ...splitModelLabel(m.key) } : { ...m, vendor: '', model: m.key }
        ));
        return json(200, {
          ok: true, range: raw,
          rangeLabel: win.label, mode: win.mode, totals, searchCount, toolCounts,
          days: byDay, chats, models, building, progress,
          costScopeNote: '估算成本与缓存命中率仅统计 usage 账中的对话模型调用，不含后台缓存保温（cache_keepalive）；保温请求仍计入预算 usedTokens。',
          rowCapHit,                       // 新增字段（旧树没有）：台账 2000 行上限可能截窗，UI 忽略不影响
          resetBoundary,                   // 新增字段：调试清零边界（state=ok 表示统计自 at 起重新累计）
          // ★ 2026-10-17 新增字段（相容追加，UI 可忽略）：读取覆盖 / 未归属时间行 / 峰谷日历覆盖
          dataCoverage,
          unattributed,
          peakCalendar: peakCalendarFor(llm, rows),
          source: 'observability.recent(usage)'
        });
      }
      const dim = String(query?.get?.('dim') || '');
      const key = String(query?.get?.('key') || '');
      const by = String(query?.get?.('by') || '');
      const fieldOf = (d) => (d === 'day' ? 'dayKey' : d === 'model' ? 'modelKey' : 'chatKey');
      const subset = dim ? rows.filter((r) => String(r[fieldOf(dim)] ?? '') === key) : rows;
      const getPrice = createPriceCache(makePriceOf(ctx, llm));
      const groups = groupBy(subset, fieldOf(by) || 'chatKey', getPrice, llm);
      const sum = costOfRows(subset, getPrice, llm);
      // ★ 2026-10-17：与 stats 同一套窗口级完整语义（价格全知 ≠ 统计完整）。
      sum.costComplete = sum.costComplete === true && windowComplete;
      return json(200, {
        ok: true, range: raw, dim, key, by, totals: sum,
        showPeak: sum.hasPeakModel && (sum.peakCost > 0 || sum.offPeakCost > 0),
        rows: groups.map((g) => ({
          key: g.key, cost: g.cost, promptTokens: g.promptTokens, completionTokens: g.completionTokens,
          cachedTokens: g.cachedTokens, totalTokens: g.totalTokens, cacheHitRate: g.cacheHitRate,
          runs: g.runs, exactCalls: g.exactCalls,
          // ★ 2026-10-17：峰谷/未定价明细（相容追加；旧 UI 忽略不影响）。
          //   分组内 costComplete 仅价格口径；窗口整体完整度看下面的 dataCoverage/unattributed。
          peakCost: g.peakCost, offPeakCost: g.offPeakCost, unknownTimeCost: g.unknownTimeCost,
          peakTokens: g.peakTokens, offPeakTokens: g.offPeakTokens, unknownTimeTokens: g.unknownTimeTokens,
          hasPeakModel: g.hasPeakModel, peakRatio: g.peakRatio,
          pricedCalls: g.pricedCalls, unpricedCalls: g.unpricedCalls, zeroPricedCalls: g.zeroPricedCalls,
          timeUnknownCalls: g.timeUnknownCalls, costComplete: g.costComplete, costSources: g.costSources
        })),
        rowCapHit,
        resetBoundary,                   // 新增字段：与 stats 同一边界（明细弹窗也从清零后算起）
        dataCoverage,                    // ★ 新增：与 stats 同一份读取覆盖读数
        unattributed,                    // ★ 新增：时间解析不出的行（数量/token），不进任何分组
        peakCalendar: peakCalendarFor(llm, rows),
        source: 'observability.recent(usage)'
      });
    } catch (error) { return serverError(error); }
  }

  // ═══ 4. 模型价格（旧 src/app.js:1983-2000）═══

  if (pathname === '/api/model-prices' && method === 'GET') {
    if (typeof llm?.listOfficialPrices !== 'function' || typeof internet?.priceFeedStatus !== 'function') {
      return notPorted('llm.listOfficialPrices + internet.priceFeedStatus（旧 src/app.js:1985-1989）');
    }
    try {
      const model = String(query?.get?.('model') || cfgGet(ctx, 'api.model', '') || '');
      return json(200, {
        prices: llm.listOfficialPrices(),
        current: typeof llm.resolveOfficialPrice === 'function' ? llm.resolveOfficialPrice(model) : null,
        remote: internet.priceFeedStatus()
      });
    } catch (error) { return serverError(error); }
  }
  if (pathname === '/api/model-prices/refresh' && method === 'POST') {
    if (typeof internet?.refreshPriceFeed !== 'function' || typeof llm?.listOfficialPrices !== 'function') {
      return notPorted('internet.refreshPriceFeed（旧 src/app.js:1993-2000 → src/price-feed.js:140）');
    }
    try {
      const st = await internet.refreshPriceFeed(String(cfgGet(ctx, 'api.priceRemoteUrl', '') || ''));
      return json(200, {
        ok: st.ok,
        remote: st,
        prices: llm.listOfficialPrices(),
        current: typeof llm.resolveOfficialPrice === 'function' ? llm.resolveOfficialPrice(cfgGet(ctx, 'api.model', '') || '') : null
      });
    } catch (error) { return serverError(error); }
  }

  // ═══ 5. 模型视觉能力（旧 src/app.js:2332-2396）═══

  if (pathname === '/api/vision/results' && method === 'GET') {
    if (typeof media?.visionResults !== 'function' || typeof llm?.currentProviders !== 'function') {
      return notPorted('media.visionResults + llm.currentProviders（旧 src/app.js:2333）');
    }
    try {
      const builtin = typeof media.builtinVisionResults === 'function' ? media.builtinVisionResults(llm.currentProviders()) : {};
      // scanning 读模块级真旗（I-2）：POST 发起的扫描还没收尾时这里就是 true。
      return json(200, { results: { ...builtin, ...media.visionResults() }, scanning: visionScan.running });
    } catch (error) { return serverError(error); }
  }
  if (pathname === '/api/vision/scan' && method === 'POST') {
    if (typeof media?.scanModelsVisionGuarded !== 'function' || typeof llm?.currentProviders !== 'function') {
      return notPorted('media.scanModelsVisionGuarded + llm.currentProviders（旧 src/app.js:2379-2396；W1 受控出口缺失），未发起扫描。');
    }
    // I-2 编排（对位旧树 src/app.js:2379-2396）：409 并发闸 ⇒ 202 火并忘 ⇒ 收尾 persistConfig 落盘。
    // 探测只经 W1 的 guarded 出口（闸 media.visionScan.allowOutbound，默认开由 I-2 第一段落进 defaults）；
    // 不 await 整轮 —— 几十个模型 × 2~4 个请求，await 会把这条 HTTP 挂死（旧树同样先回 202）。
    if (visionScan.running) return json(409, { ok: false, error: '已有一次扫描正在进行' });
    // 判闸在**起旗之前**（闸本体没删，关着就 501 + 显式原因，不静默、不假成功）。
    // resolveVisionScanPolicy 与 guarded 内部同一判据 ⇒ 判过即真，guarded 兜底一致。
    const scanCfg = ctx?.configStore ?? getMod(ctx, 'config-store');
    if (typeof media.resolveVisionScanPolicy === 'function' && media.resolveVisionScanPolicy(scanCfg) !== true) {
      return json(501, {
        ok: false,
        notDone: true,
        reason: 'third_party_upload_disabled',
        error: '模型视觉探测：出站开关 media.visionScan.allowOutbound 关，未发起扫描（未向任何模型 provider 发出探测图）'
      });
    }
    const ids = Array.isArray(body?.providerIds) ? body.providerIds.map(String) : null;
    const input = {
      providers: llm.currentProviders(),
      emit: null,                      // 新旧 UI 都不听 vision-scan SSE（对位报告 §二）⇒ 不接
      onlyProviderIds: ids,
      timeoutMs: 25000,                // 单次 HTTP 请求上限（旧树同值，不是整轮预算）
      limit: 3                         // 并发 worker 数（旧树同值）
    };
    visionScan.running = true;
    // 收尾链：成功 ⇒ **显式 persistConfig 落盘**（新树 updateConfig 不落盘，core/config-store/index.js:308-310）；
    // 半途崩 ⇒ 也把已 flush 的结果落盘再清旗（旧树每 2s/5 条 flush 的鲁棒性口径）。
    // ★★ 中途落盘（2026-10-11 指挥位授权，只动这一段）：老树 `src/vision-scan.js` 的 flushPending 每满 5 条 /
    //   每 2s 调一次 `updateConfig`，而老树 `src/config.js` 的 updateConfig **每调一次就写盘**；新树同名函数只改
    //   内存 ⇒ 扫描中途进程崩/重启，已探测结果全丢（实测打死在 4.5s：假网关已答 27 发、多批 flush 已完成却全在内存，
    //   重启后 0 条；同一脚本改后同样打死点 → 盘上 9 条、重启后 9 条）。
    //   修法**不碰 vision-scan.js** —— media 保真表 F2 要求该文件与老树只差 1 条 import 行（加行即判红），而偏离
    //   登记表在 media/selftest.mjs，不在本件授权的「只这两处」内。改为：扫描期间订阅配置变更，凡 flush 出来的
    //   `modelVision` 补丁**当场 persist 一次** —— 频次跟 flush 同频（满 5 条 / 2s 批量，不逐条、不另起节流器，
    //   内容与老树同一份 config.json），收尾那次 persistConfig 原样保留；中途写失败的条目仍在内存 ⇒ 收尾兜底重写。
    //   写失败一律走 persistConfig 的 {ok:false,error} 契约记 `vision-scan-persist-failed`，不许静默。
    const reportVisionPersist = (phase) => {
      let persisted;
      try { persisted = persistConfig(ctx); }
      catch (error) { persisted = { ok: false, error: String(error?.message ?? error) }; }
      if (persisted?.ok === true) return;
      try { ctx?.obs?.log?.('warn', 'vision-scan-persist-failed', { phase, error: String(persisted?.error ?? '未知') }); }
      catch { /* 日志坏了也不许反噬：旗照常清 */ }
    };
    let unsubscribeVision = null;
    if (typeof scanCfg?.subscribeConfigChange === 'function') {
      unsubscribeVision = scanCfg.subscribeConfigChange((patch) => {
        if (!patch || typeof patch !== 'object' || !Object.hasOwn(patch, 'modelVision')) return;
        reportVisionPersist('midway');
      });
    } else {
      try { ctx?.obs?.log?.('warn', 'vision-scan-persist-unavailable', { error: '缺出口：configStore.subscribeConfigChange ⇒ 中途落盘退化成只有收尾那一次' }); } catch { /* 同上 */ }
    }
    void media.scanModelsVisionGuarded(input, {
      cfg: scanCfg,
      label: '模型视觉探测'
    }).then((result) => {
      if (result?.ok !== true) {
        try { ctx?.obs?.log?.('warn', 'vision-scan-refused', { reason: String(result?.reason ?? ''), detail: String(result?.detail ?? '') }); } catch { /* 日志不许反噬 */ }
      }
    }).catch((error) => {
      try { ctx?.obs?.log?.('warn', 'vision-scan-failed', { error: String(error?.message ?? error) }); } catch { /* 同上 */ }
    }).finally(() => {
      try { unsubscribeVision?.(); } catch { /* 退订失败不许吃掉后面的落盘与清旗 */ }
      reportVisionPersist('final');   // 收尾那次照旧（重入安全：中途写过也无害，写的是同一份 raw）
      visionScan.running = false;
    });
    return json(202, { ok: true, started: true });
  }

  // ═══ 6. 配置默认值投影（旧 src/app.js:2695-2723）═══

  if (pathname === '/api/config/defaults' && method === 'GET') {
    const defaults = ctx?.configStore?.DEFAULT_CONFIG ?? null;
    if (!defaults || typeof defaults !== 'object') return notPorted('configStore.DEFAULT_CONFIG（旧 src/app.js:2706 的单一权威默认值源）');
    const paths = String(query?.get?.('paths') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const out = {};
    const problems = [];
    if (!paths.length) return json(200, { defaults: out, problems: ['缺少 paths 参数'] });
    const limited = paths.slice(0, 200);
    if (paths.length > limited.length) problems.push('超过 200 条上限，已截断');
    for (const p of limited) {
      if (secretNamedPath(p)) {
        const dv = defaultPathValue(defaults, p);
        if (!(typeof dv === 'number' || typeof dv === 'boolean')) { out[p] = null; problems.push(p); continue; }
      }
      const v = defaultPathValue(defaults, p);
      out[p] = v === undefined ? null : v;
    }
    return json(200, { defaults: out, problems });
  }

  // ═══ 7. 明文密钥回读（旧 src/app.js:2198-2229，守卫 :1395-1412）═══

  if (pathname === '/api/api-key' && method === 'GET') {
    if (!keyEndpointAllowed(ctx, req)) return json(403, { error: KEY_DENIED });
    return json(200, { apiKey: String(cfgGet(ctx, 'api.apiKey', '') || '') });
  }
  if (pathname === '/api/search-key' && method === 'GET') {
    if (!keyEndpointAllowed(ctx, req)) return json(403, { error: KEY_DENIED });
    const field = String(query?.get?.('field') || '');
    const allowed = ['deepseek', 'zhipu', 'bocha', 'baidu', 'metaso'];
    if (!allowed.includes(field)) return json(400, { error: `未知搜索服务：${field}` });
    return json(200, { apiKey: String(cfgGet(ctx, `webSearch.${field}.apiKey`, '') || '') });
  }

  // ═══ 8. 服务商（旧 src/app.js:2180-2330）═══

  if (pathname === '/api/providers' && method === 'GET') {
    // ★ P1 消重（2026-10-12）：让位 —— 这条由 `console-api.js getProviders` 应答
    //   （实测真实分发回 200 {ok,providers}；本片那份回 {providers,source}，形状不同且从未被问到）。
    //   退掉之后：console-api 应答；本片不再维护第二份。
    return null;
  }
  if (pathname === '/api/providers' && method === 'POST') {
    if (typeof llm?.upsertProvider !== 'function') return notPorted('llm.upsertProvider（旧 src/app.js:2281-2293）');
    try {
      const r = llm.upsertProvider({
        baseUrl: String(body?.baseUrl ?? ''),
        apiKey: String(body?.apiKey ?? ''),
        models: body?.models || []
      });
      const persisted = persistConfig(ctx);
      return json(200, { ok: true, ...r, provider: sanitizeProvider(r.provider), persisted });
    } catch (error) { return fail(400, error?.message ?? error); }
  }
  if (pathname === '/api/providers/key' && method === 'GET') {
    if (!keyEndpointAllowed(ctx, req)) return json(403, { error: KEY_DENIED });
    if (typeof llm?.currentProviders !== 'function') return notPorted('llm.currentProviders（旧 src/app.js:2203）');
    const pid = String(query?.get?.('providerId') || '');
    const p = llm.currentProviders().find((x) => x.id === pid);
    return json(200, { apiKey: p?.apiKey || '' });
  }
  if (pathname === '/api/providers/set-key' && method === 'POST') {
    // ★ P1 消重（2026-10-12）：让位 —— 由 `console-api.js postProviderKey` 应答。
    //   实测（临时实例、真实 provider）：真实分发 = console-api ⇒ 200 [hasKey,ok,persisted,source]；
    //   本片那份回 200 [hasKey,ok,persisted]（**少一个 source**），且因 console-api 恒返回非 null 从未被问到。
    //   错误路径两边逐字一致（404 {ok,error:"提供商不存在"}）⇒ 退它不改变任何响应。
    return null;
  }
  if (pathname === '/api/providers/models' && method === 'POST') {
    if (typeof llm?.addModelsToProvider !== 'function') return notPorted('llm.addModelsToProvider（旧 src/app.js:2296-2305）');
    try {
      const p = llm.addModelsToProvider(String(body?.providerId ?? ''), body?.models || []);
      if (!p) return json(404, { ok: false, error: '提供商不存在' });
      const persisted = persistConfig(ctx);
      return json(200, { ok: true, provider: sanitizeProvider(p), persisted });
    } catch (error) { return fail(400, error?.message ?? error); }
  }
  if (pathname === '/api/providers/models' && method === 'DELETE') {
    if (typeof llm?.removeModelFromProvider !== 'function') return notPorted('llm.removeModelFromProvider（旧 src/app.js:2308-2317）');
    try {
      const p = llm.removeModelFromProvider(String(body?.providerId ?? ''), String(body?.modelId ?? ''));
      if (!p) return json(404, { ok: false, error: '提供商或模型不存在' });
      const persisted = persistConfig(ctx);
      return json(200, { ok: true, provider: sanitizeProvider(p), persisted });
    } catch (error) { return fail(400, error?.message ?? error); }
  }
  if (pathname === '/api/providers/fetch-models' && method === 'POST') {
    if (typeof llm?.fetchModelsFrom !== 'function') return notPorted('llm.fetchModelsFrom（旧 src/app.js:2232-2243）');
    try {
      const baseUrl = String(body?.baseUrl || cfgGet(ctx, 'api.baseUrl', '') || '');
      const apiKey = body?.apiKey !== undefined ? String(body.apiKey ?? '') : String(cfgGet(ctx, 'api.apiKey', '') || '');
      return json(200, { ok: true, models: await llm.fetchModelsFrom(baseUrl, apiKey) });
    } catch (error) { return fail(502, error?.message ?? error); }
  }
  if (pathname === '/api/providers/test-chat' && method === 'POST') {
    if (typeof llm?.testModelChat !== 'function' || typeof llm?.resolveApiKey !== 'function') {
      return notPorted('llm.testModelChat + llm.resolveApiKey（旧 src/app.js:2263-2278）');
    }
    try {
      const submitted = String(body?.apiKey ?? '').trim();
      const apiKey = (submitted && submitted !== '******') ? submitted : llm.resolveApiKey(ctx?.configStore?.get?.() ?? {});
      const result = await llm.testModelChat({
        baseUrl: String(body?.baseUrl ?? ''),
        apiKey,
        model: String(body?.model ?? '')
      });
      return json(200, { ok: true, result });
    } catch (error) { return fail(400, error?.message ?? error); }
  }
  if (pathname === '/api/providers/test-one' && method === 'POST') {
    // ★ N31（2026-10-09）：从 501 变成真实现。出口 `llm.testOneProvider` **本来就在**
    //   （`modules/llm/providers.js:333`，由 `modules/llm/index.js` 导出）——
    //   这一片当年只把它标成「不在派单清单里」，用户点"测试"就是 501。
    //   形状逐字照旧树 `src/app.js:2246-2258`：`{ok:true,result}` / 出错 `{ok:false,error}` + 500。
    if (typeof llm?.testOneProvider !== 'function') return notPorted('llm.testOneProvider（旧 src/app.js:2246-2258）');
    try {
      const result = await llm.testOneProvider({
        providerId: String(body?.providerId ?? ''),
        baseUrl: String(body?.baseUrl ?? ''),
        apiKey: String(body?.apiKey ?? '')
      });
      return json(200, { ok: true, result });
    } catch (error) { return json(500, { ok: false, error: String(error?.message ?? error) }); }
  }
  if (pathname === '/api/providers/test-all' && method === 'POST') {
    // ★ N31：同上，出口 `llm.testAllProviders` 本来就在（`modules/llm/providers.js:466`）。
    //   形状照旧树 `src/app.js:2326-2330`：`{ok:true,results,okCount,total}`。
    if (typeof llm?.testAllProviders !== 'function') return notPorted('llm.testAllProviders（旧 src/app.js:2326-2330）');
    try {
      const providers = typeof llm.currentProviders === 'function' ? llm.currentProviders() : [];
      const results = await llm.testAllProviders(providers);
      const okCount = Object.values(results || {}).filter((r) => r?.ok).length;
      return json(200, { ok: true, results, okCount, total: Object.keys(results || {}).length });
    } catch (error) { return json(500, { ok: false, error: String(error?.message ?? error) }); }
  }
  // ★ N31：GET /api/models —— 旧树 `src/app.js:2816-2824` 直接回 `{models}`，
  //   出错回 **502**（不是 500，别把"拉模型列表失败"说成服务器炸了）。出口 `llm.listModels` 本来就在。
  if (pathname === '/api/models' && method === 'GET') {
    if (typeof llm?.listModels !== 'function') return notPorted('llm.listModels（旧 src/app.js:2818）');
    try {
      return json(200, { models: await llm.listModels() });
    } catch (error) { return json(502, { error: String(error?.message ?? error) }); }
  }
  // ★ N31：POST /api/test/api —— 旧树 `src/app.js:2500-2512` 的「打一发 ping 看模型通不通」。
  //   **形状逐字照旧**：`{ok:true, model, reply, latencyMs}`；出错也是 **200** + `{ok:false,error,latencyMs}`
  //   （老树故意不让它 5xx：这是个给人点的按钮，5xx 会把"模型答错了"说成"服务器坏了"）。
  if (pathname === '/api/test/api' && method === 'POST') {
    if (typeof llm?.chatCompletion !== 'function') return notPorted('llm.chatCompletion（旧 src/app.js:2500）');
    const startedAt = Date.now();
    try {
      const r = await llm.chatCompletion({
        messages: [{ role: 'user', content: '请只回复两个字符：pong' }],
        tools: null, temperature: 0
      });
      const reply = typeof r?.message?.content === 'string' ? r.message.content.slice(0, 100) : '';
      return json(200, { ok: true, model: r?.model, reply, latencyMs: Date.now() - startedAt });
    } catch (error) {
      return json(200, { ok: false, error: String(error?.message ?? error), latencyMs: Date.now() - startedAt });
    }
  }

  // ═══ 9. 自定义搜索服务（旧 src/app.js:2399-2498）═══

  if (pathname === '/api/search-providers' && method === 'GET') {
    const list = (cfgGet(ctx, 'webSearch.providers', []) || []).map((p) => ({
      id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, model: p.model,
      count: p.count, timeoutMs: p.timeoutMs,
      hasApiKey: Boolean(String(p.apiKey || '').trim())   // 不返回明文（旧口径）
    }));
    return json(200, { providers: list });
  }
  if (pathname === '/api/search-providers' && method === 'DELETE') {
    const id = String(body?.id ?? '').trim();
    if (!id) return fail(400, '缺少 id');
    const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
    const list = (cfgGet(ctx, 'webSearch.providers', []) || []).filter((p) => String(p.id) !== id);
    const patch = { webSearch: { providers: list } };
    const cur = String(cfgGet(ctx, 'webSearch.provider', ''));
    if (cur === `custom:${id}`) {
      patch.webSearch.provider = 'bing';
    }
    try {
      if (typeof cs?.updateConfig === 'function') cs.updateConfig(patch);
      const persisted = persistConfig(ctx);
      return json(200, { ok: true, persisted });
    } catch (error) {
      return fail(400, error?.message ?? error);
    }
  }
  if (pathname === '/api/search-providers' && method === 'POST') {
    try {
      const baseUrl = String(body?.baseUrl ?? '').trim();
      const type = String(body?.type ?? 'openai').trim() === 'bing' ? 'bing' : 'openai';
      if (!baseUrl) return fail(400, '接口地址不能为空');
      const list = [...(cfgGet(ctx, 'webSearch.providers', []) || [])];
      const existing = list.find((p) => p.baseUrl === baseUrl && p.type === type);
      let entry;
      if (existing) {
        existing.name = String(body?.name ?? existing.name ?? '').trim() || existing.name;
        existing.baseUrl = baseUrl;
        existing.type = type;
        existing.model = String(body?.model ?? existing.model ?? '').trim();
        existing.count = Math.min(20, Math.max(1, Number(body?.count) || existing.count || 6));
        existing.timeoutMs = Math.max(5000, Number(body?.timeoutMs) || existing.timeoutMs || 20000);
        const submitted = String(body?.apiKey ?? '').trim();
        if (submitted && submitted !== '******') existing.apiKey = submitted;
        entry = existing;
      } else {
        entry = {
          id: `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          name: String(body?.name ?? '').trim() || baseUrl,
          type,
          baseUrl,
          apiKey: String(body?.apiKey ?? '').trim() === '******' ? '' : String(body?.apiKey ?? '').trim(),
          model: String(body?.model ?? '').trim(),
          count: Math.min(20, Math.max(1, Number(body?.count) || 6)),
          timeoutMs: Math.max(5000, Number(body?.timeoutMs) || 20000)
        };
        list.push(entry);
      }
      const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
      if (typeof cs?.updateConfig === 'function') cs.updateConfig({ webSearch: { providers: list } });
      const persisted = persistConfig(ctx);
      return json(200, {
        ok: true,
        provider: { ...entry, apiKey: '', hasApiKey: Boolean(String(entry.apiKey || '').trim()) },
        persisted
      });
    } catch (error) {
      return fail(400, error?.message ?? error);
    }
  }
  if (pathname === '/api/search-providers/test' && method === 'POST') {
    if (typeof internet?.customSearch !== 'function') return notPorted('internet.customSearch（旧 src/app.js:2477-2498）');
    const startedAt = Date.now();
    try {
      const provId = String(body?.providerId ?? '').trim();
      const r = await internet.customSearch('qq agent 测试', provId || null);
      const results = Array.isArray(r?.results) ? r.results : [];
      return json(200, {
        ok: true,
        result: { ok: true, count: results.length, sample: results[0]?.title || '', latencyMs: Date.now() - startedAt }
      });
    } catch (error) {
      // 旧树同样回 200，把失败放进 result.ok=false（这是"测试结果"，不是接口失败）
      return json(200, { ok: true, result: { ok: false, note: String(error?.message ?? error), latencyMs: Date.now() - startedAt } });
    }
  }

  // ═══ 10. 外部库连通性测试（旧 src/app.js:3244-3260）═══

  if (pathname === '/api/external-lookup-test' && method === 'POST') {
    if (typeof internet?.wikiLookup !== 'function') return notPorted('internet.wikiLookup（旧 src/app.js:3246-3250 → src/wiki.js:218）');
    const q = String(body?.q ?? '东方Project').slice(0, 40) || '测试';
    try {
      const r = await internet.wikiLookup(q, { limit: 1 });
      const results = Array.isArray(r?.results) ? r.results : [];
      return json(200, {
        ok: !!r?.ok, label: r?.label, hits: results.length,
        error: r?.error || null, first: results[0]?.title || null
      });
    } catch (error) {
      return json(200, { ok: false, error: String(error?.message ?? error) });   // 旧树同口径：测试结果不叫接口失败
    }
  }

  // ═══ 11. 明确未移植的能力（501，逐条点名缺哪个出口 + 旧行号）═══
  //
  // ★ N67（2026-10-10）两条 ⛔ 不是"忘了接"，是**用户裁定本轮不做** ——
  //   原票要求"别让它们继续以 501 的形式当神秘死按钮"，所以把裁定写进**给用户看的那句话**里。
  //   状态码仍是 501（诚实：能力确实没有），`n31-oldtree-coverage.selftest.mjs:159` 的
  //   反向牙只要求 `501 或未找到` + `不许 200 ok:true`，不校验文案 ⇒ 改文案不会顶红。

  // ★★ A5（sp3 2026-10-11 · mimo2 `r-反向牙清单.md` 点名的过期牙）：这里原来回 501
  //   「persona-two 模块 … **新树无此模块** … 有意不实现」—— 这句话**现在是假的**：
  //   persona-two 生命周期今天已接线（`console-api.js:1948` GET getPersona2 · `:1981` POST postPersona2，
  //   `08531453`；`console-api.selftest.mjs:464-471` 有"进/出/还原原卡"的正例）。
  //   原来那句"用户裁定双人格本轮不做"的依据（`.agent/待办清单.md`）已被后来接线推翻。
  //   ⇒ 本片让路（与 cost-guard / semantic-cards 同一处置），不再维护第二份、不再说假话。
  if (pathname === '/api/persona2') return null;
  // ★ A7（sp3 2026-10-11 · 全盘扫收敛重复实现）：这里原本自己实现了一份 self-impressions
  //   （读 persona.roleText 再 parseSelfImpressions，回 `{ok:true, items, count}`）。
  //   但 `console-api.js:1945/:1983/:1988` 的 GET/POST/DELETE **都在它之前答**（http.js:93 先问
  //   console-api）⇒ 本片这份是**死代码**：实跑读响应键可证（活的那版回 `{items, botName}`，没有 count）。
  //   两份形状还不一样（活的没有 ok/count）⇒ 谁改一份忘另一份就分叉。
  //   ⇒ 本片让路（与 cost-guard / semantic-cards / persona2 / local-jev 同一处置）。
  //   ★ 牙已迁到活实现上：`console-api.selftest.mjs` 新增一段钉 GET/POST 的真行为与缺出口 501；
  //     本片 `console.selftest.mjs` 的 "3b" 块相应改成"必须让路"（没删断言）。
  if (pathname === '/api/self-impressions') return null;
  // ★★ A6（sp3 2026-10-11 · mimo2 `r-反向牙清单.md`）：**读口已接、写口没接**，必须分开说。
  //   · GET 已接：`console-api.js:1943` → `:1167 getLocalJev` → `jev.stats()`，生产回 200
  //     ⇒ 本片 GET 让路（原来那句"新树无本地进程管理"只对**写口**成立，罩住 GET 就是假话）。
  //   · 写口没接：`POST /api/local-jev` 会 spawn/停 llama-server，用户裁定「JEV 冻结」
  //     （用户原话：jev 我要重新训练，所以现在先不用管）⇒ **有意不实现，不是漏接**。
  //     ★★ 这条继续钉 501：`console-api.js` 没有 POST local-jev 分支，本片是它唯一的诚实答复。
  if (pathname === '/api/local-jev') {
    if (method === 'GET') return null;
    return notPorted('local-jev 进程管理 ensureLocalJev/stopLocalJev（旧 src/app.js:2572-2650 → src/local-jev.js:395，含 spawn llama-server）'
      + ' —— 读口已接（GET 走 console-api.js:1167 getLocalJev → jev.stats()），**写口**没接。'
      + '★★ 按用户裁定「JEV 冻结」（用户原话：jev 我要重新训练，所以现在先不用管）⇒ 这条不是漏接，是**有意不实现**；'
      + '另注：`POST /api/local-jev` 会 spawn/停 llama-server，属禁打端点，不许拿它当探针。');
  }
  // ★ P2-4（sp3 2026-10-11）：这里原本另写了一份 cost-guard ——
  //   `costGuardStatsShape({day})` 造一份**当日零值** stats + `costGuardVerdict({}, guard)`，
  //   note 里自己都写着"stats 为当日零值"。它被 `http.js:93` 的分发顺序挡着不可达
  //   （正主 `console-api.js` 的 getCostGuard 先答：真 observability usage 账本 + 真 `api.costGuard` 配置）。
  //   风险：一旦分发顺序倒置 / 路由改名，面板就会显示"今日 prompt 0 / 0 · 待办 0 条"这种
  //   **真实感十足的假数据** —— 比原来"分母恒 0"更毒，因为它连分子都像真的。
  //   ⇒ 本片**让路**（与下面 :1036-1043 语义卡那条同一处置），不再维护第二份实现。
  //   ⚠ 不许"顺手统一"：本片 import console-api.js 会成环（console-api 反过来 import 本片）。
  if (pathname === '/api/cost-guard') return null;
  // ★ P1 消重（2026-10-12）：下面三条让位 —— 由 `console-api.js` 应答（实测真实分发回它的响应）。
  //   退掉之后：memory-guard 由 console-api 透传 modules/memory.runtimeStatus；usage/reset、sessions/topics 也由 console-api 接管。
  if (pathname === '/api/memory-guard') {
    return null;
  }
  if (pathname === '/api/usage/reset' && method === 'POST') {
    return null;
  }
  if (pathname === '/api/sessions' && method === 'GET') {
    return null;
  }
  if (/^\/api\/sessions\//.test(pathname) && method === 'GET') {
    return notPorted('sessions.detail（旧 src/app.js:2835 → src/sessions.js）—— 新树由 console-api.js 接管');
  }
  if (pathname === '/api/topics' && method === 'GET') {
    return null;
  }

  return null;   // 不认识 ⇒ 交给下一片（S2/S1）或 mimo 的兜底
}
