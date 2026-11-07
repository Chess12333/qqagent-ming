/**
 * S3 控制台 API 切片 · **记忆类**（独占写：`apps/server/api/memory.js`）
 *
 * 契约见 `.tmp-dispatch/ui-api-slices-brief.md` §一：
 *   `export async function handle({method, pathname, query, body, ctx, req, res})`
 *   不认识 ⇒ `return null`（让下一个分片接）；**不许动 `http.js`**（自动加载）。
 *
 * ── 我认领的 15 条（四个记忆侧出口到位后从 console.js 接回）───────────────
 *   仍须让位（见各处 return null 的注释）：
 *     GET    /api/memory-guard              → console-api.js（501 点名文案）
 *     GET    /api/memory-people             → console-api.js（200 按人聚合 + merge 读数）
 *     DELETE /api/memory-people/all         → api/console.js（400 请逐个删除）
 *   本轮接回：
 *     DELETE /api/memory-people/:qq         → 本切片（memory.removeMember）
 *     DELETE /api/memory-people/:qq/surface → 本切片（memory.clearSurface；kind 明确 400）
 *     POST   /api/memory-people/cleanup     → 本切片（memory.cleanupAll；透出 notImplemented）
 *     DELETE /api/memory-people/name-only   → 本切片（memory.removeNameOnlyMember）
 *   保留：
 *   GET    /api/memory-audit                     ✅ 已实现（readAuditLog 真拷贝 + 好感两段账）
 *   PUT    /api/memory-people/:qq                editPersonImpressions（200 / 参数400 / 写失败500）
 *   POST   /api/memory-people/consolidate-all    ✅ N33：接 ctx.memoryCoordinator.requestConsolidation（真排队）
 *   GET    /api/memory-files                     ✅ N33：按**新架构**列盘上真有的记忆文件与按会话统计
 *   POST   /api/memory-files/consolidate         ✅ N33：接 ctx.memoryCoordinator.requestConsolidation（真排队）
 *   GET    /api/semantic-cards                   ✅ 已实现（M6 cards()，字段名有缺口已如实标注）
 *   DELETE /api/semantic-cards/:id               ✅ M6 forget()（按 scope+chatKey+evidenceIds 收窄到
 *                                                 **用户点的那一张卡**；定位不到就 409 拒删）
 *                                                 ★ 改前是 `forget(subjectId)` 不带范围 ⇒ 删一张 =
 *                                                 撤回这个人在所有会话的全部记忆（P0，2026-10-11 修）
 *   ★A5 GET    /api/memory/impressions/shareable  ✅ 待授权清单（qwen1 listShareableImpressions）
 *   ★A5 POST   /api/memory/impressions/share      ✅ 授权/回收（setImpressionShare；失败按 reason 透出 400/404/409/500）
 *   ★A5 GET    /api/memory/suppressions           ✅ 被抑制来源只读投影（listSuppressions）
 *   ★A5 POST   /api/memory/suppressions/reinstate  ✅ 重新记住（reinstate；无活跃抑制也回 200 + reinstated:false）
 *   ★ 这四条只做 HTTP 转发：形状照 qwen1 契约 §二；dataDir 只取装配层、**不读请求体里的 dataDir**。
 *
 * ── 铁律遵守（§二）──────────────────────────────────────────────────────────
 * 1. 只走公开出口：`ctx.modules.memory.*` / `ctx.modules.configStore`。**零 import 兄弟模块**
 *    （连 `node:` 都不 import —— 本切片纯转发 + 判能力）。
 * 2. 缺能力 ⇒ **501 + 点名缺哪个出口**；**绝不用 `[]` 假装没有数据**（见下面 memory-audit 的坑）。
 * 3. 错误不吞成 200：抛了 ⇒ 500 + 原文。
 * 4. 不抢实例锁、不碰生产目录：除 `DELETE /api/semantic-cards/:id`（走 M6 forget() 撤回，
 *    范围锁死在那张卡自己的 scope/chatKey/evidenceIds）外，人物印象 PUT 也经公开出口写入，HTTP 层不直接写记忆文件。
 *
 * ── ★ A 方案（人物只读视图）─────────────────────────────────────────────────
 *   ⚠ 2026-10-12 P1 消重：那份实现**已移交给 console-api.js**（本片 return null）。
 *   口径本身仍有效，读它的实现在 console-api.js 的 getMemoryPeople（字段：
 *   userId / impressions / name / favor / scopes + counts/merge 读数）；本段只留作背景。
 *
 * ── ★ 本切片踩到并解决的一个坑（值得记）────────────────────────────────────
 *   `readAuditLog()` 内部 `catch { return [] }`（memory-audit.js:63-65），而它依赖的
 *   `memoryFile()` 在 dataDir 解析不出来时会**抛**（data-dir.js:63-64）—— 两者叠起来的后果是：
 *   **「dataDir 根本没注入」和「真的没有审计记录」都返回 `[]`**，接口看起来一切正常。
 *   这正是铁律第 2 条禁止的\"空数组假装没有数据\"。
 *   ⇒ 我的做法：**先探 `getDataDir()`**（memory/index.js:35 有导出），探不到就 **501 并点名**，
 *     只有探到了、确认目录可解析，才把 `readAuditLog` 的结果原样返回（此时 `[]` 才代表\"确实没有\"）。
 */

// ★ N33：`GET /api/memory-files` 要真的列盘上的文件 ⇒ 需要 node:fs / node:path。
//   （本文件此前**零 import**，因为它只读 `ctx.modules.memory.*`；这条是新加的读盘路径。）
import fs from 'node:fs';
import path from 'node:path';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

const ok = (payload) => ({ status: 200, headers: JSON_HEADERS, body: JSON.stringify(payload) });

/** 501：必须点名缺哪个出口（铁律 2） */
const notPorted = (what) => ({
  status: 501,
  headers: JSON_HEADERS,
  body: JSON.stringify({ ok: false, error: `not-ported: ${what}` })
});

/** 500：调用出口抛了就说原文（铁律 3） */
const failed = (error) => ({
  status: 500,
  headers: JSON_HEADERS,
  body: JSON.stringify({ ok: false, error: String(error?.message ?? error) })
});

/** 404：确实没有这个东西（**不许**回 200 {ok:false} —— 面板的 api() 只看 HTTP 状态，会把"没删掉"显示成"已删除"） */
const notFound = (what) => ({
  status: 404,
  headers: JSON_HEADERS,
  body: JSON.stringify({ ok: false, error: what })
});

/** 409：能定位到对象、但**拒绝执行**（会把范围搞宽或搞歧义）—— 说明写进 error，不许静默挑一个 */
const refused = (error, extra = {}) => ({
  status: 409,
  headers: JSON_HEADERS,
  body: JSON.stringify({ ok: false, error, ...extra })
});

/** 以旧成员印象库 removalSucceeded 判据拦住缺字段/异常响应，避免 UI 假报已删除。 */
const removalSucceeded = (result) => result?.ok === true
  && (result?.deleted === true || result?.removed === true)
  && !result?.reason && !result?.error;

function resultFailure(result, status, fallback) {
  return {
    status,
    headers: JSON_HEADERS,
    body: JSON.stringify({ ...result, ok: false, error: result?.error || fallback })
  };
}

/**
 * ★ 记忆页实时刷新（bus `memory-update` 的**手工修改**生产点；自动整理那半在装配层的 coordinator 包壳里，
 *   见 `apps/server/assembly.js` 的 wireMemoryUpdateEvents）。
 *   只在**真改动落账**之后调用；载荷只有 `{phase:'refresh'}` —— 不带 chatKey/userId/正文/名字（无隐私面）。
 *   缺 ctx.emit 时照 `api/media.js:373-378` 的惯例告警一行，绝不静默。
 */
function emitMemoryUpdate(ctx, payload = { phase: 'refresh' }) {
  const emit = ctx?.emit;
  if (typeof emit !== 'function') {
    console.warn('[api/memory] ⚠ ctx 缺 emit ⇒ memory-update 发不出去（记忆页不会自动刷新）——装配层应给 ctx.emit');
    return;
  }
  try { emit('memory-update', payload); } catch { /* 事件不许反噬主链 */ }
}

/** `readAuditLog` 依赖 dataDir；解析不出来时它会静默给 []。先探一次，把\"没注入\"和\"没记录\"分开。 */
function memoryDataDirOrNull(mem) {
  try {
    if (typeof mem?.getDataDir !== 'function') return null;
    const dir = mem.getDataDir();
    return typeof dir === 'string' && dir ? dir : null;
  } catch {
    return null;   // data-dir.js 就是这么 fail-closed 的（抛错）—— 这里转成\"探不到\"
  }
}

/**
 * （已随 GET /api/memory-people 的让位一并删除：buildFavorMap 只被那份实现使用，
 *   生效实现从 console-api 的 getMemoryPeople 取 favor —— 2026-10-12 P1 消重。）
 */

/**
 * ★ 2026-10-16（清理 B/C provider 接线）：端点的**门意图**解析。
 * 只有请求体里**明确写出来**才认（`true` / `'both'` / `'semantic'` / `'type'`，别名见下）；
 * 别的值（含 `'1'` 这类含糊写法）一律当"没写" ⇒ 不注入门、不花额度、模块侧如实回 blocked。
 */
function cleanupGateIntent(value) {
  if (value === true) return 'both';
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'both' || text === 'all' || text === 'true') return 'both';
  if (text === 'semantic' || text === 'b' || text === 'dedupe-semantic') return 'semantic';
  if (text === 'type' || text === 'c' || text === 'refine-types') return 'type';
  return '';
}

/**
 * ★ 2026-10-16：HTTP 边界的数值夹取（防呆 + 卡在 30s 之内）。
 * 非有限数/≤0 ⇒ 用 fallback；否则夹进 [min, max]。
 */
function clampGateNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * B1 读侧（2026-10-11 指挥位批）：把 **M7 情绪台账里 field=favor 的行**读成好感页签的行。
 * 只读 `emotion-state.json` 的 `ledger`（**现成流水，不造第二份**），行形状来自
 * `modules/emotion/apply.js push()`：`{seq, at?, target:'person:<qq>', field:'favor', before, after, delta, source, reason, evidenceIds}`。
 * ★ `at` 由 mimo1 `8188a333` 起才带上 ⇒ **改之前写的行没有时间**（生产现盘 0 条 favor 行，但
 *   用户重启前的实例仍会写旧行）⇒ 这些行 `ts: null` + `timeUnknown: true`，
 *   ★ **绝不填 0 / 假日期**（UI `new Date(ts||0)` 会显示成 1970 —— 所以它们不进 `rows`，
 *   单独放 `rowsWithoutTime`，由面板标"无时间记录"）。
 * @returns {{rows: object[]|null, unavailable: string|null}} 拿不到台账时 rows=null
 */
function favorLedgerRows(ctx) {
  const modules = ctx?.modules;
  const emotion = ctx?.modulesObj?.emotion
    ?? (typeof modules?.get === 'function' ? modules.get('modules/emotion') ?? modules.get('emotion') : modules?.emotion)
    ?? null;
  let state = null;
  try {
    state = typeof emotion?.stateOf === 'function' ? emotion.stateOf() : null;
  } catch { state = null; }
  if (!state && ctx?.emotionState) state = ctx.emotionState;
  if (!state || !Array.isArray(state.ledger)) {
    return { rows: null, unavailable: 'emotion.stateOf()（M7 台账）读不到 —— 只回老账，不把"读不到"演成"没有新变动"' };
  }
  const rows = [];
  for (const r of state.ledger) {
    if (String(r?.field ?? '') !== 'favor') continue;
    const at = Number(r.at);
    const hasTime = Number.isFinite(at) && at > 0;
    const pid = String(r.target ?? '').replace(/^person:/, '');
    rows.push({
      type: 'favor',
      ts: hasTime ? at : null,
      timeUnknown: !hasTime,
      from: r.before ?? null,
      to: r.after ?? null,
      delta: Number(r.delta) || 0,
      reason: r.reason == null ? '' : String(r.reason),
      source: r.source == null ? '' : String(r.source),
      userId: pid,
      evidenceIds: Array.isArray(r.evidenceIds) ? r.evidenceIds.map(String).slice(0, 8) : [],
      stream: 'm7-ledger'
    });
  }
  return { rows, unavailable: null };
}

export async function handle({ method, pathname, query, body, ctx } = {}) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/api/')) return null;
  const modules = ctx?.modules;
  const mem = ctx?.modulesObj?.memory
    ?? (typeof modules?.get === 'function' ? modules.get('modules/memory') ?? modules.get('memory') : modules?.memory)
    ?? null;
  const q = query ?? null;
  const qp = (k) => (q && typeof q.get === 'function' ? (q.get(k) ?? '') : '');

  // ── GET /api/memory/auto-status（★ 2026-10-19 第六批 · 只读）──────────────────
  //   目的：把**既有**调度器读数（`ctx.memoryMaintenance.status()`，memory-maintenance.js:279）
  //   如实给记忆页，解释"为什么自动人物印象没产出"。它只读：不 tick、不排队、不调模型。
  //   ★ 不新造开关、不改 opt-in 语义；缺出口 ⇒ 501 点名（不拿空对象假装已启用）。
  //   ★ 不凭 0 条判断故障：enabled/modelConfigured/待补发/阈值/上次维护都是可核读数。
  if (pathname === '/api/memory/auto-status' && method === 'GET') {
    const mm = ctx?.memoryMaintenance;
    if (!mm || typeof mm.status !== 'function') {
      return notPorted('ctx.memoryMaintenance.status()（apps/server/memory-maintenance.js；assembly.js 已暴露）');
    }
    try {
      const s = mm.status() || {};
      const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
      const lastMaintenanceAt = numOrNull(s.lastMaintenanceAt);
      const lastScanAt = numOrNull(s.lastScanAt);
      return ok({
        ok: true,
        enabled: s.enabled === true,
        modelConfigured: s.modelConfigured === true,
        deferredChats: Number.isSafeInteger(Number(s.deferredChats)) ? Number(s.deferredChats) : null,
        deferredTop: Array.isArray(s.deferredTop)
          ? s.deferredTop.slice(0, 5).map((x) => ({
            chatKey: String(x?.chatKey ?? ''),
            observed: Number.isFinite(Number(x?.observed)) ? Number(x.observed) : 0,
            firstAt: numOrNull(x?.firstAt),
            lastAt: numOrNull(x?.lastAt)
          }))
          : [],
        minIntervalMs: numOrNull(s.minIntervalMs),
        impressionThresholds: s.impressionThresholds && typeof s.impressionThresholds === 'object'
          ? {
            minImpressions: numOrNull(s.impressionThresholds.minImpressions),
            maxPerMember: numOrNull(s.impressionThresholds.maxPerMember)
          }
          : null,
        maintenanceIntervalMs: numOrNull(s.maintenanceIntervalMs),
        lastMaintenanceAt: lastMaintenanceAt && lastMaintenanceAt > 0 ? lastMaintenanceAt : null,
        lastScanAt: lastScanAt && lastScanAt > 0 ? lastScanAt : null,
        constraints: [
          'consolidateEnabled-opt-in',       // 显式 true 才可能自动整理（默认关）
          'model-configured',                // 无模型 ⇒ 不会真正调用
          'message-threshold-trigger',       // 主触发：新消息观察达到既有消息阈值（item.observed > 0）
          'impression-dual-thresholds-supplementary', // 补充触发：印象总量/单人上限
          'cooldown',                        // 同会话最小间隔
          'manual-edit-lock'                 // 手动编辑锁（只约束自动请求）
        ],
        observedBy: 'apps/server/memory-maintenance.js status()（只读；本端点不触发 tick/排队/模型调用）'
      });
    } catch (error) { return failed(error); }
  }

  // ── GET /api/memory-audit（旧 src/app.js:3014-3020）─────────────────────────
  if (pathname === '/api/memory-audit' && method === 'GET') {
    if (typeof mem?.readAuditLog !== 'function') {
      return notPorted('ctx.modules.memory.readAuditLog()（记忆变更审计账；旧 src/memory-audit.js 的真拷贝出口）');
    }
    const dataDir = memoryDataDirOrNull(mem);
    if (!dataDir) {
      // ★ 不能就这么返回 rows:[] —— 那会把\"dataDir 没注入\"说成\"没有审计记录\"
      return notPorted('可解析的 dataDir（memory/getDataDir() 抛错：必须显式注入 dataDir 或设 QQ_AGENT_DATA_DIR）。'
        + '不设的话 readAuditLog 会静默返回空数组，那会把\"没配置\"伪装成\"没有记录\"');
    }
    const userId = String(qp('userId') || '');
    const limit = Number(qp('limit')) || 50;
    const kind = String(qp('kind') || 'memory');
    try {
      const rows = mem.readAuditLog({ userId, limit, kind, dataDir });
      // ★★ B1 读侧（2026-10-11 指挥位批 A→B）：kind=favor 时把**两条现成的流水**并成一页
      //   ① `audit.jsonl` 的老账（老树写的，带真实 ts）② M7 情绪台账 `ledger` 里 field=favor 的新行。
      //   为什么要并：新树**从不往 audit.jsonl 写 favor** ⇒ 只读老账 ⇒ 页签永远停在老树最后一条；
      //   而新变更全在 M7 台账里。**不造第二份流水**，两边都只读。
      //   ★ 排序/口径（指挥位原话）：新变更**按时间倒序**看得到；**没有时间的行绝不显示成 1970**
      //     ⇒ 它们不进 `rows`，单列 `rowsWithoutTime`（`ts:null` + `timeUnknown:true`），
      //     由面板标"无时间记录"；★ 两段用 `stream` 标明（`legacy-audit` / `m7-ledger`），不混成一种。
      let favorStream = null;
      let rowsWithoutTime = [];
      let auditRows = rows;
      if (kind === 'favor') {
        const legacy = rows
          .map((r) => ({ ...r, type: 'favor', stream: 'legacy-audit', timeUnknown: !(Number(r?.ts) > 0) }))
          .filter((r) => Number(r.ts) > 0);                 // 老账没 ts 的同样不许假装有时间
        const live = favorLedgerRows(ctx);
        const liveAll = live.rows ?? [];
        const liveRows = userId ? liveAll.filter((r) => String(r.userId) === String(userId)) : liveAll;
        const timed = [
          ...legacy,
          ...liveRows.filter((r) => !r.timeUnknown)
        ].sort((a, b) => Number(b.ts) - Number(a.ts));
        rowsWithoutTime = liveRows.filter((r) => r.timeUnknown);
        auditRows = timed.slice(0, limit);
        favorStream = {
          legacy: legacy.length,
          live: liveRows.length,
          shown: auditRows.length,
          liveShown: auditRows.filter((r) => r.stream === 'm7-ledger').length,
          withoutTime: rowsWithoutTime.length,
          source: live.unavailable
            ? `audit.jsonl（老账）；${live.unavailable}`
            : 'audit.jsonl（老账）+ emotion-state.json ledger(field=favor)（M7 新账）',
          note: rowsWithoutTime.length
            ? `另有 ${rowsWithoutTime.length} 条台账行没有时间（8188a333 之前写的），已在 rowsWithoutTime 如实列出，**不给假日期、不混进列表**`
            : '列表里每一行都有真实时间；没有时间的行不会出现在 rows 里（不显示 1970）'
        };
      }
      // ★★ P1-6（2026-10-11）：**真正的观察变更不在这里**。
      //   上面这份 `readAuditLog` 读的是旧 `audit.jsonl`（好感/印象账，生产里基本只有 media 写它）；
      //   而 commit / revise / retract 全部记在 M6 的 `changes.jsonl`，唯一读口是
      //   `modules/memory/index.js:470 audit()` —— 它**没有 HTTP 路由** ⇒ 界面上"记忆变动"页
      //   看不到任何一次新增/改写/撤回（用户刚删一张卡，日志里一条都没有）。
      //   这里把真账接出来：仍然由**服务端**按 audit() 自己的范围规则算好（别群的群内细节不外泄），
      //   前端只负责显示 —— **不造第二份状态、不在前端拼**。
      //   ⚠ 两份账是**不同域**，不合并、不互相顶替：rows = 旧账（favor/impression/knowledge），
      //     observationChanges = M6 观察变更账。
      if (typeof mem?.audit !== 'function') {
        return notPorted('ctx.modules.memory.audit()（M6 观察变更账 changes.jsonl；modules/memory/index.js:470）'
          + ' —— 没有它，界面只能看到旧账，看不到任何 commit/revise/retract');
      }
      const auditChat = String(qp('chatKey') || '').trim();
      const auditKind = String(qp('scope') || '').trim();
      const obsAudit = mem.audit({
        chatKey: auditChat || undefined,
        kind: auditKind || undefined,
        n: limit,
        subjectId: userId || undefined,
        dataDir
      });
      return ok({
        ok: true,
        rows: auditRows,
        count: auditRows.length,
        kind,
        userId,
        dataDir,
        // ↓ 真账（M6 观察变更）
        observationChanges: obsAudit?.rows ?? [],
        observationTotal: Number(obsAudit?.total) || 0,
        observationSource: 'memory.audit(changes.jsonl)',
        ...(favorStream ? { favorStream, rowsWithoutTime } : {}),
        note: (favorStream
          ? `rows = 好感变动（按时间倒序；legacy-audit=老树 audit.jsonl，m7-ledger=新树情绪台账）；`
            + `rowsWithoutTime = 没有时间的台账行（不显示假日期）；`
          : `rows = 旧审计账（audit.jsonl：好感/印象/梗库，生产主要由 media 写）；`)
          + `observationChanges = M6 观察变更账（changes.jsonl：commit/revise/retract，memory_append / 删卡都记在这）`
      });
    } catch (error) {
      return failed(error);
    }
  }

  // ── GET /api/memory-guard —— ★ P1 消重（2026-10-12）让位 ────────────────────
  // 由 console-api.js 应答它那份 501 点名文案（实测真实分发 = console-api 的 body）；
  // 本片原来另有一段不同文案的 501 ⇒ 同一路径两段话，退掉留一份。
  if (pathname === '/api/memory-guard' && method === 'GET') {
    return null;
  }

  // ── A5 授权口 + 抑制投影（qwen1 `368f400` / `de2a8c8` 的 HTTP 半边 · 2026-10-11）────
  // 形状照 `.tmp-dispatch/2026-10-11/qwen1/r-A5授权账本与抑制投影.md` §二，**不自造形状**。
  // ★ 硬口径①：dataDir **只取装配层**（`memoryDataDirOrNull`）——模块的 `dirOf()`/`data-dir.js`
  //   在不给时会回落**生产 `data/`** ⇒ 请求体里的 dataDir **一律不读**。
  // ★ 硬口径②：授权失败必须把 `reason` **原样透出**（把 `not-shareable-eligible` 包成 200「已授权」
  //   就是假成功；qwen1 那侧有牙在等，这里不许再补一层糖）。
  if (pathname === '/api/memory/impressions/shareable' && method === 'GET') {
    if (typeof mem?.listShareableImpressions !== 'function') {
      return notPorted('memory.listShareableImpressions（待授权清单出口；modules/memory/index.js 再导出，qwen1 368f400）'
        + ' —— 缺它就没有"哪些印象可以跨群共享"的清单');
    }
    const dataDir = memoryDataDirOrNull(mem);
    if (!dataDir) return notPorted('可解析的 dataDir（memory/getDataDir() 抛错：必须显式注入）—— 授权账本按 dataDir 定位，不回落真 data/');
    try {
      // ★ 2026-10-16（用户：授权页翻不到所有内容）：分页协议 —— `page`（从 1 起）/`pageSize`
      //   （默认 20、上限 200）；旧 `limit` 仍兼容（等价 pageSize）。响应带
      //   `{items,total,page,pageSize,hasMore,pages,filter,ledger}`；`total` 是筛选下真实总数
      //   （读不到账本时是 `null`=未知，不编 0）。
      // ★ 2026-10-17：`subjectId`（可选）**先筛选后分页** —— 按人看时 total/pages/hasMore
      //   都是这个人的集合，不会连翻空页；不给 = 原全局口径（glm1 固定用 ?subjectId=<当前人>&page=&pageSize=）。
      const out = mem.listShareableImpressions({
        dataDir,
        ...(qp('limit') ? { limit: Number(qp('limit')) } : {}),
        ...(qp('page') ? { page: Number(qp('page')) } : {}),
        ...(qp('pageSize') ? { pageSize: Number(qp('pageSize')) } : {}),
        ...(qp('subjectId') ? { subjectId: String(qp('subjectId')) } : {})
      });
      return ok({ ok: true, ...out });   // {items,total,page,pageSize,hasMore,pages,filter,ledger}
    } catch (error) { return failed(error); }
  }

  if (pathname === '/api/memory/impressions/share' && method === 'POST') {
    if (typeof mem?.setImpressionShare !== 'function') {
      return notPorted('memory.setImpressionShare（覆盖账本 memory/impression-share.jsonl 的授权/回收写口；qwen1 368f400）');
    }
    const dataDir = memoryDataDirOrNull(mem);
    if (!dataDir) return notPorted('可解析的 dataDir（memory/getDataDir() 抛错：必须显式注入）—— 账本按 dataDir 定位，不回落真 data/');
    const actor = body?.actor ?? 'admin';
    const note = body?.note ?? '';
    // ★ 2026-10-16：跨页多选要有界批量提交 —— `{items:[{claimKey,shared},…]}`；
    //   **逐条**走同一个 `setImpressionShare`（资格复核一条都不省），逐条回成功/失败原因；
    //   权限口径不变（不因为"批量"就放宽），也不悄悄授权未来新出现的记录。
    if (Array.isArray(body?.items)) {
      const MAX_BATCH = 100;
      if (body.items.length > MAX_BATCH) {
        return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({
          ok: false, reason: 'batch-too-large', error: `一次最多提交 ${MAX_BATCH} 条`, got: body.items.length
        }) };
      }
      const results = [];
      let applied = 0;
      let failedCount = 0;
      for (const [index, item] of body.items.entries()) {
        if (!item || typeof item !== 'object') {
          failedCount += 1;
          results.push({ index, claimKey: '', ok: false, reason: 'invalid-arguments' });
          continue;
        }
        let r;
        try {
          r = mem.setImpressionShare({
            claimKey: item.claimKey, shared: item.shared,
            actor: item.actor ?? actor, note: item.note ?? note, dataDir
          });
        } catch (error) {
          r = { ok: false, reason: 'error', error: String(error?.message ?? error) };
        }
        if (r?.ok === true) applied += 1; else failedCount += 1;
        results.push({
          index, claimKey: String(item.claimKey ?? ''), ok: r?.ok === true,
          shared: r?.ok === true ? r.shared === true : undefined,
          ...(r?.ok === true ? {} : { reason: String(r?.reason ?? 'error'), ...(r?.card ? { card: r.card } : {}) })
        });
      }
      if (applied > 0) emitMemoryUpdate(ctx);
      return ok({ ok: failedCount === 0, applied, failed: failedCount, total: body.items.length, results });
    }
    try {
      const r = mem.setImpressionShare({
        claimKey: body?.claimKey,
        shared: body?.shared,            // ★ 必须布尔；非布尔由出口回 reason:'invalid-arguments'（不在这儿翻译）
        actor,
        note,
        dataDir                          // ★ 不读 body.dataDir（硬口径①）
      });
      if (r?.ok === true) {
        emitMemoryUpdate(ctx);   // 授权/回收真落账 ⇒ 刷记忆页
        return ok(r);  // {ok, shared, claimKey, subjectId, at}
      }
      // 失败：状态码按 reason 分级，**body 原样**（含 reason / card / error）
      const reason = String(r?.reason ?? 'error');
      const status = reason === 'invalid-arguments' ? 400
        : reason === 'card-not-found' ? 404
          : reason === 'not-shareable-eligible' ? 409 : 500;
      return { status, headers: JSON_HEADERS, body: JSON.stringify(r) };
    } catch (error) { return failed(error); }
  }

  if (pathname === '/api/memory/suppressions' && method === 'GET') {
    if (typeof mem?.listSuppressions !== 'function') {
      return notPorted('memory.listSuppressions（被抑制来源的只读投影；qwen1 de2a8c8）—— 缺它界面就无从显示"谁被抑制着"');
    }
    const dataDir = memoryDataDirOrNull(mem);
    if (!dataDir) return notPorted('可解析的 dataDir（memory/getDataDir() 抛错：必须显式注入）');
    try {
      const activeOnly = String(qp('activeOnly') ?? 'true') !== 'false';
      const out = mem.listSuppressions({ dataDir, activeOnly, limit: Number(qp('limit')) || 100 });
      return ok({ ok: true, ...out });   // {items, total, active, file}
    } catch (error) { return failed(error); }
  }

  if (pathname === '/api/memory/suppressions/reinstate' && method === 'POST') {
    if (typeof mem?.reinstate !== 'function') {
      return notPorted('memory.reinstate（"重新记住"写口；qwen1 368f400：无活跃抑制 ⇒ reinstated:false 且一个字节不写）');
    }
    const dataDir = memoryDataDirOrNull(mem);
    if (!dataDir) return notPorted('可解析的 dataDir（memory/getDataDir() 抛错：必须显式注入）');
    // 先自检参数（模块也判，但把"缺参"和"写失败"分开成 400/500，别都塞 500）
    const chatKey = String(body?.chatKey ?? '');
    const speakerId = String(body?.speakerId ?? '');
    if (!chatKey || !speakerId) {
      return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({ ok: false, error: 'chatKey 与 speakerId 都必填' }) };
    }
    try {
      const r = mem.reinstate({ chatKey, speakerId, at: body?.at ?? 0, note: body?.note ?? '', dataDir });
      // ★ 200 里两种都要带：reinstated:true（真重新记住）/ reinstated:false + reason:'no-active-suppression'
      //   ⇒ **UI 文案必须分开**：后者是「这个人本来就没被抑制着」，不是「已重新记住」。
      if (r?.ok === true) {
        if (r.reinstated === true) emitMemoryUpdate(ctx);   // reinstated:false = 一个字节没写 ⇒ 不算变化、不发
        return ok(r);
      }
      return failed(new Error(r?.error ?? 'reinstate failed'));   // 写失败 ⇒ 500 + 原文
    } catch (error) { return failed(error); }
  }

  // ── GET /api/memory-people —— 归 console-api.js（★ P1 消重 2026-10-12 让位）────────
  // 实测：真实分发由 `console-api.js` 应答 200 `{chatKey,counts,merge,ok,people,scope,source}`
  // （按人聚合 + merge 读数，含我 2026-10-11 加的来源数）；本片原有一份 A 方案实现（形状不同：
  // `{dataDir,dispatchNote,total,...}`、`name` 恒为 null，前端读不到名字），**从未被问到** ⇒ 整段删除，
  // 不再维护第二份（留着就是下一次"读代码以为它生效"的陷阱）。
  // OWNED_PATHS 已同步移除该条；覆盖转到 console-api.selftest（生效实现的形状断言）。
  if (pathname === '/api/memory-people' && method === 'GET') {
    return null;
  }

  // ── PUT /api/memory-people/:qq（旧 src/app.js:3330-3340，数字 QQ 号）────────
  const personPut = /^\/api\/memory-people\/(\d+)$/.exec(pathname);
  if (personPut && method === 'PUT') {
    if (typeof mem?.editPersonImpressions !== 'function') return notPorted('memory.editPersonImpressions（改人物印象）');
    const dataDir = memoryDataDirOrNull(mem);
    if (!dataDir) return notPorted('可解析的 dataDir（改人物印象必须显式注入）');
    try {
      const bodyObj = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
      // ★ 2026-10-18（N2）：好感（favor）**不归 memory** —— `editPersonImpressions` 会把它列进
      //   `notApplied: not-memory-owned` 静默丢弃（旧面板滑块"保存成功却没变化"的根因）。
      //   这里把 favor 摘出来，写进真正的归属：装配层绑定的 M7 实时状态所有者
      //   （`ctx.modulesObj.emotion.replaceState` → state-owner.manageEdit 的 relation 分支，
      //   落 `person:<qq>` 台账）。只摘 favor；attitude/note 仍交给 memory（继续按它的 notApplied 如实回报）。
      const { favor: favorInput, ...memBody } = bodyObj;
      const result = await mem.editPersonImpressions({ ...memBody, subjectId: personPut[1], dataDir });
      if (result?.ok === true) {
        // ★ 复核 C（aaf16f9c）：只在真有增删改（或真改名）时发 refresh —— 原样保留的"空提交"不算变化。
        //   判据用出口自己的 applied 桶（modules/memory/index.js:1294-1310 的成功返回）：added/revised/removed/name。
        const applied = result.applied && typeof result.applied === 'object' ? result.applied : {};
        const impressionsChanged = (applied.added?.length ?? 0) + (applied.revised?.length ?? 0)
          + (applied.removed?.length ?? 0) + (applied.name ? 1 : 0);
        const emotion = ctx?.modulesObj?.emotion ?? null;
        // ★ N2：好感单独写；写不进去时**不许报成功** —— 响应用 favorApplied/favorError 如实交代，UI 据此提示。
        let favorResult = null;
        if (favorInput !== undefined && favorInput !== null) {
          if (typeof emotion?.replaceState === 'function') {
            try {
              const rel = emotion.replaceState({ relation: { personId: personPut[1], favor: favorInput } });
              favorResult = rel?.ok === true
                ? { ok: true, applied: Array.isArray(rel.applied) ? rel.applied : [] }
                : { ok: false, error: String(rel?.error ?? '关系修改未生效') };
            } catch (error) {
              favorResult = { ok: false, error: String(error?.message ?? error) };
            }
          } else {
            favorResult = { ok: false, error: '实时情绪状态未注入（ctx.modulesObj.emotion.replaceState 缺失）—— 好感未写入' };
          }
        }
        const favorApplied = favorResult?.ok === true;
        // ★ N2：手动改的管理字段只置脏，正式写盘在轮末/stop —— 这里主动 flush 一次并如实回报，
        //   避免"面板已改、重启回到旧值"（flush 失败时响应里写明，不假装持久化成功）。
        let favorPersisted = null;
        let favorPersistError = '';
        if (favorApplied) {
          try {
            const flushed = typeof emotion?.flush === 'function' ? emotion.flush() : null;
            favorPersisted = flushed ? flushed.ok === true && !flushed.skipped : null;
            if (favorPersisted === false) favorPersistError = String(flushed?.reason || flushed?.skipped || '落盘未完成');
          } catch (error) {
            favorPersisted = false;
            favorPersistError = String(error?.message ?? error);
          }
        }
        if (impressionsChanged > 0 || favorApplied) emitMemoryUpdate(ctx);
        // 回读真实值（读不到 = null，**不冒充 0/50**）；面板用这个值刷新条/滑块。
        let favorNow = null;
        try {
          const relNow = typeof emotion?.relationOf === 'function' ? emotion.relationOf({ senderId: personPut[1] }) : null;
          if (relNow && typeof relNow.favor === 'number') favorNow = relNow.favor;
        } catch { favorNow = null; }
        return ok({
          ...result,
          member: { ...(result.person || {}), ...(favorNow !== null ? { favor: favorNow } : {}) },
          ...(favorInput === undefined || favorInput === null ? {} : {
            favorApplied,
            favor: favorNow,
            ...(favorApplied ? { favorPersisted, ...(favorPersisted === false ? { favorPersistError } : {}) } : {}),
            ...(favorApplied ? {} : { favorError: favorResult?.error || '好感未写入（原因未知）' })
          })
        });
      }
      const status = result?.reason === 'invalid-arguments' ? 400 : 500;
      return { status, headers: JSON_HEADERS, body: JSON.stringify({
        ...result, ok: false, error: (result?.errors || []).join('；') || '改人物印象失败'
      }) };
    } catch (error) { return failed(error); }
  }

  // ── DELETE /api/memory-people/:qq（旧 src/app.js:3330-3360）───────────────
  const personDelete = /^\/api\/memory-people\/(\d+)$/.exec(pathname);
  if (personDelete && method === 'DELETE') {
    if (typeof mem?.removeMember !== 'function') return notPorted('memory.removeMember（删成员）');
    const dataDir = memoryDataDirOrNull(mem);
    if (!dataDir) return notPorted('可解析的 dataDir（删除成员必须显式注入）');
    try {
      const result = await mem.removeMember({ subjectId: personDelete[1], dataDir });
      if (removalSucceeded(result)) {
        emitMemoryUpdate(ctx);
        return ok(result);
      }
      const reason = String(result?.reason ?? '');
      const status = reason === 'bad-uid' ? 400 : reason === 'not-found' ? 404 : 500;
      const message = reason === 'bad-uid' ? 'uid 格式不合法，未删除'
        : reason === 'not-found' ? '未找到该成员，未删除'
          : reason === 'unlink-failed' ? '删除成员失败（精确删除失败）' : '删除成员失败，服务端未确认删除';
      return resultFailure(result, status, message);
    } catch (error) { return failed(error); }
  }

  // ── DELETE /api/memory-people/:qq/surface（新树按成员+会话清全部短期状态）──
  const surfaceDelete = /^\/api\/memory-people\/(\d+)\/surface$/.exec(pathname);
  if (surfaceDelete && method === 'DELETE') {
    // 新树没有 kind 维度；即便 ?kind= 为空也拒绝，不能悄悄扩大/改变删除含义。
    if (q && typeof q.has === 'function' && q.has('kind')) {
      return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({
        ok: false, error: '新树不支持按 kind 清理'
      }) };
    }
    if (typeof mem?.clearSurface !== 'function') return notPorted('memory.clearSurface（清理成员短期记忆）');
    const dataDir = memoryDataDirOrNull(mem);
    if (!dataDir) return notPorted('可解析的 dataDir（清理成员短期记忆必须显式注入）');
    const diagnostics = {};
    const input = { subjectId: surfaceDelete[1], dataDir, diagnostics };
    if (q && typeof q.has === 'function' && q.has('chatKey')) input.chatKey = String(qp('chatKey'));
    try {
      const removed = await mem.clearSurface(input);
      if (removed !== 0 && removed !== 1) return failed(new Error('memory.clearSurface 返回值不是 0 或 1'));
      if (diagnostics.missed > 0 || diagnostics.reason === 'retract-incomplete') {
        return resultFailure({ removed, diagnostics }, 500, '清理短期记忆未全部落账');
      }
      if (removed === 1) emitMemoryUpdate(ctx);   // removed=0 = 本来就没东西可清 ⇒ 不算变化、不发
      return ok({ ok: true, removed });
    } catch (error) { return failed(error); }
  }

  // ── POST /api/memory-people/cleanup（旧 src/app.js:3156-3260）──────────────
  // ★ 2026-10-15（ds1 · 一键清理三动作）：**默认仍然只读盘点**；只有请求体显式
  //   `{apply: true}` 才让模块执行确定性动作。
  // ★ 2026-10-16（分项执行契约，与 UI 共用；字段名不许私改）：
  //   · `{}` ⇒ 只读盘点；
  //   · `{apply:true}`（旧档）⇒ **只执行 A**（`dedupeFuzzy`）；
  //   · `{apply:true, actions:['dedupeFuzzy'|'dedupeSemantic'|'refineTypes', …]}` ⇒ **只执行列出的动作**，
  //     未列出的不写、不问门、不调模型；`actions` 由模块判合法（非法/为空 ⇒ 模块 fail-closed，
  //     本层按 409 原样透出 `reasonCode`/`invalidActions`/`allowedActions`）；
  //   · `gate:'semantic'|'type'|'both'` = 模型门意图：**必须与 actions 对得上**（`both` = B+C，不含 A），
  //     对不上 ⇒ 409 `gate-action-mismatch`；旧档只给 `gate` 不给 `actions` ⇒ 自动翻成等价选择器
  //     （`semantic`→B、`type`→C、`both`→B+C）⇒ **不会再顺带执行 A**。
  //   门 = `ctx.modulesObj.memoryCleanupGates`（assembly 备好的 provider：llm 的 budgeted 调用 +
  //   llmBudgetService 真预留/结算 + 记忆域模型解析；**这里只注入，不自己调模型**）。
  //   额度边界：总预算默认 20s、单问默认 8s（可传 `gateBudgetMs`/`gateTimeoutMs`，夹取见
  //   `clampGateNumber`：总预算上限 20s + 单问上限 8s ⇒ 最坏 ~28s，留在 HTTP 30s 之内）；串行/超时/
  //   次数上限由 `modules/memory/index.js` 的 `askGateOnce` 强制执行；任一问失败即逐项失败，绝不猜 YES/子类。
  //   缺 provider / 模型没配 ⇒ **不注入**，模块如实回 `no-semantic-gate` / `no-type-gate`（200 + `gate.why`）。
  //   `apply: 'true'` / 1 / 其它一律当只读。
  if (pathname === '/api/memory-people/cleanup' && method === 'POST') {
    if (typeof mem?.cleanupAll !== 'function') return notPorted('memory.cleanupAll（盘点旧树清理步骤）');
    const dataDir = memoryDataDirOrNull(mem);
    if (!dataDir) return notPorted('可解析的 dataDir（一键清理盘点必须显式注入）');
    try {
      const apply = body?.apply === true;
      const intent = cleanupGateIntent(body?.gate);
      const actionsProvided = body?.actions !== undefined;
      const rawActions = body?.actions;
      // ① 选了动作却没给 apply ⇒ 不匹配请求：fail-closed（模块侧也会拦，这里把原因说清楚）。
      if (actionsProvided && !apply) {
        return refused('actions 需要显式 {apply:true} 才可能执行（未执行、未调用模型）', {
          ok: false, reason: 'apply-required', actions: rawActions
        });
      }
      // ② gate 意图 ↔ actions 的对应关系（`both` = B+C，**不含 A**）。
      const gateActions = intent === 'both' ? ['dedupeSemantic', 'refineTypes']
        : intent === 'semantic' ? ['dedupeSemantic']
          : intent === 'type' ? ['refineTypes'] : [];
      if (actionsProvided && gateActions.length && Array.isArray(rawActions)) {
        const list = rawActions.map((item) => String(item ?? '').trim());
        const missing = gateActions.filter((name) => !list.includes(name));
        if (missing.length) {
          return refused(`gate:"${intent}" 要求 actions 包含 ${gateActions.join('+')}，当前缺少 ${missing.join('+')}（未执行、未调用模型）`, {
            ok: false, reason: 'gate-action-mismatch', gate: intent, requiredActions: gateActions, actions: list
          });
        }
      }
      // ③ 旧档（只给 gate 不给 actions）⇒ 翻成等价选择器；`both` 明确只列 B/C。
      const effectiveActions = actionsProvided ? rawActions : (gateActions.length ? gateActions : undefined);
      const provider = apply && intent ? (ctx?.modulesObj?.memoryCleanupGates ?? null) : null;
      const gates = {};
      let gateInfo = { requested: intent || 'none', applied: false, available: false, why: '' };
      if (intent && !apply) {
        gateInfo = { requested: intent, applied: false, available: false, why: 'apply-required' };
      } else if (intent) {
        const state = typeof provider?.available === 'function' ? provider.available() : { ok: false, why: 'gate-provider-unavailable' };
        if (state?.ok === true) {
          if (intent === 'semantic' || intent === 'both') gates.semanticGate = provider.semanticGate;
          if (intent === 'type' || intent === 'both') gates.typeGate = provider.typeGate;
          gateInfo = {
            requested: intent, applied: true, available: true, why: '',
            ...(typeof provider?.describe === 'function' ? { provider: provider.describe() } : {})
          };
        } else {
          gateInfo = { requested: intent, applied: false, available: false, why: String(state?.why || 'gate-provider-unavailable') };
        }
      }
      const withGates = Object.keys(gates).length > 0;
      const result = await mem.cleanupAll({
        dataDir,
        ...(apply ? { apply: true } : {}),
        ...(effectiveActions !== undefined ? { actions: effectiveActions } : {}),
        ...gates,
        ...(withGates ? {
          // 最坏情况 = 预算上限 + 最后一次单问上限 = 20s + 8s = 28s < HTTP 30s —— 见上面的注释。
          gateBudgetMs: clampGateNumber(body?.gateBudgetMs, 20000, 1000, 20000),
          gateTimeoutMs: clampGateNumber(body?.gateTimeoutMs, 8000, 500, 8000)
        } : {})
      });
      // ★ 模块对 `actions` 的 fail-closed 结论（非法/为空）原样透出：409 + 原因 + 清单，不吞、不假装成功。
      if (result?.ok !== true && (result?.reasonCode === 'invalid-actions' || result?.reasonCode === 'empty-actions')) {
        return refused(`memory.cleanupAll 拒绝执行：${result.reasonCode}（未执行、未调用模型）`, {
          ok: false, reason: result.reasonCode,
          invalidActions: Array.isArray(result?.invalidActions) ? result.invalidActions : [],
          allowedActions: Array.isArray(result?.allowedActions) ? result.allowedActions : []
        });
      }
      if (result?.ok !== true || !Array.isArray(result.notImplemented)) {
        return failed(new Error('memory.cleanupAll 未返回 ok:true 与 notImplemented 清单'));
      }
      // 保持旧路由 {ok, ...r}；notImplemented / actions 必须原样到面板，0 计数不能冒充已清理。
      if (apply && Number(result?.apply?.changed) > 0) emitMemoryUpdate(ctx);
      return ok({ ok: true, ...result, gate: gateInfo });
    } catch (error) { return failed(error); }
  }

  // ── POST /api/memory-people/consolidate-all（旧 src/app.js:3263-3308）──────
  if (pathname === '/api/memory-people/consolidate-all' && method === 'POST') {
    // ★ N33（2026-10-09 · 指挥位追加票）：改前这里是 501「编排层未暴露该出口」，面板上点了没反应。
    //   现在接到 **bunny2 的真排队出口** `coordinator.requestConsolidation({chatKey,kind,reason})`
    //   （`modules/memory/coordinator.js:221` → `{ok:true, queued:true, jobId}`），
    //   实例由**装配层造唯一一份**并挂在 `ctx.memoryCoordinator`（`assembly.js`）——
    //   与 `/api/memory-files/consolidate` **共用同一个对象**，不各写一套。
    //
    //   老树这条是「逐会话各排一个任务」⇒ 这里同样逐会话排队，逐条回 jobId，
    //   **一条失败不吞掉其余**（老树 src/app.js:3263-3308 也是逐个 try）。
    const coordinator = ctx?.memoryCoordinator ?? null;
    if (typeof coordinator?.requestConsolidation !== 'function') {
      return notPorted('ctx.memoryCoordinator.requestConsolidation（modules/memory/coordinator.js:221；'
        + '装配层未挂或该出口不存在）');
    }
    const store = mem?.store ?? null;
    let chatKeys = [];
    try {
      chatKeys = typeof store?.listChats === 'function' ? store.listChats().map(String) : [];
    } catch (error) {
      return failed(error);
    }
    if (!chatKeys.length) {
      return ok({
        ok: true, queued: 0, total: 0, jobs: [], chatKeys: [],
        note: '本机还没有任何会话记忆可整理（不是失败：没有会话 ⇒ 没有要整理的东西）'
      });
    }
    const jobs = [];
    for (const chatKey of chatKeys) {
      const kind = chatKey.startsWith('private:') ? 'private' : 'group';
      try {
        const r = await coordinator.requestConsolidation({ chatKey, kind, reason: 'consolidate-all' });
        jobs.push({ chatKey, ok: r?.ok !== false, queued: r?.queued === true, jobId: r?.jobId ?? null, error: r?.ok === false ? (r.error ?? 'requestConsolidation returned ok:false') : null });
      } catch (error) {
        // ★ 逐条如实记账：一条挂了就记那一条，**不许整批回一句"失败"**
        jobs.push({ chatKey, ok: false, queued: false, jobId: null, error: String(error?.message ?? error) });
      }
    }
    const queued = jobs.filter((j) => j.queued).length;
    return ok({
      ok: jobs.every((j) => j.ok),
      queued, total: jobs.length, jobs, chatKeys,
      via: 'memoryCoordinator.requestConsolidation（真排队，非同步跑）'
    });
  }

  // ── DELETE /api/memory-people/name-only?name=…（旧 src/app.js:3316-3330）────
  if (pathname === '/api/memory-people/name-only' && method === 'DELETE') {
    if (typeof mem?.removeNameOnlyMember !== 'function') return notPorted('memory.removeNameOnlyMember(name)（删无号壳）');
    const dataDir = memoryDataDirOrNull(mem);
    if (!dataDir) return notPorted('可解析的 dataDir（删除无号壳必须显式注入）');
    try {
      const result = await mem.removeNameOnlyMember({ name: String(qp('name')), dataDir });
      if (removalSucceeded(result)) {
        emitMemoryUpdate(ctx);
        return ok(result);
      }
      const reason = String(result?.reason ?? '');
      const status = reason === 'not-found' ? 404 : 500;
      const message = reason === 'not-found' ? '未找到无号壳，未删除'
        : reason === 'unreadable' ? '记录读不出来，已保留'
          : reason === 'unlink-failed' ? '删除无号壳失败（精确删除失败）' : '删除无号壳失败，服务端未确认删除';
      return resultFailure(result, status, message);
    } catch (error) { return failed(error); }
  }

  // ── DELETE /api/memory-people/all —— ★ P1 消重（2026-10-12）让位 ─────────────
  // 由 `api/console.js` 应答 **400「请逐个删除成员」**（旧树有意拒绝防误删，是决定不是缺口）；
  // 本片原来是一段不同语义的 501 ⇒ 退掉，别让 501 盖住那条 400。
  if (pathname === '/api/memory-people/all' && method === 'DELETE') {
    return null;
  }

  // ── POST /api/memory-files/consolidate（旧 src/app.js:3434-3466）────────────
  if (pathname === '/api/memory-files/consolidate' && method === 'POST') {
    // ★ N33（指挥位追加票）：老 UI `ui/app.js:9156-9160` 就是打这条
    //   `POST {chatKey, userIds:[qq], force:true}` 并只认 `r.ok` —— 改前这里是 501，**点了没反应**。
    //   现在接 bunny2 的真排队出口（同上，与 consolidate-all 共用 `ctx.memoryCoordinator`）。
    const chatKey = String(body?.chatKey ?? '').trim();
    if (!chatKey) {
      return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({ ok: false, error: '缺少 chatKey（group:群号 / private:QQ号）' }) };
    }
    if (!/^(group|private):\d+$/.test(chatKey)) {
      return { status: 400, headers: JSON_HEADERS, body: JSON.stringify({ ok: false, error: `chatKey 不合法：${chatKey}` }) };
    }
    const coordinator = ctx?.memoryCoordinator ?? null;
    if (typeof coordinator?.requestConsolidation !== 'function') {
      return notPorted('ctx.memoryCoordinator.requestConsolidation（modules/memory/coordinator.js:221；'
        + '装配层未挂或该出口不存在）');
    }
    const kind = chatKey.startsWith('private:') ? 'private' : 'group';
    // ★ N38：`userIds` 现在**真的生效**了 —— 记进装配层的待用作用域，
    //   下一次该会话的抽取只把这些人的消息喂给模型（老 UI 的「整理此人印象」按钮）。
    //   队列契约（bunny2 的 `requestConsolidation`）一个字没改。
    const userIds = (Array.isArray(body?.userIds) ? body.userIds : [])
      .map((x) => String(x ?? '').trim()).filter(Boolean);
    const scopeSetter = ctx?.consolidationScope;
    const narrowedTo = (typeof scopeSetter?.add === 'function' && userIds.length)
      ? scopeSetter.add(chatKey, userIds) : null;
    try {
      const r = await coordinator.requestConsolidation({
        chatKey, kind, reason: String(body?.reason ?? 'manual-consolidate')
      });
      const unconsumed = [];
      // ★ `force`：新架构里队列会**按会话合并重复请求**（`requestConsolidation` 的合并逻辑，
      //   同一 chatKey 有活跃 job 就并进去、不重复计费）。老树的 `force` 是"忽略去重强插"，
      //   在这里**没有对应的一档** ⇒ 如实回显，不假装它生效了（重复跑 = 重复调模型 = 重复花钱）。
      if (body?.force === true) unconsumed.push('force（新架构无"忽略去重强插"：同会话的重复请求会被合并，不重复计费）');
      return ok({
        ok: r?.ok !== false,
        chatKey, kind,
        queued: r?.queued === true,
        jobId: r?.jobId ?? null,
        narrowedTo,
        narrowedAt: narrowedTo ? 'extract（只把这些人的消息喂给模型）' : null,
        unconsumed,
        caveat: narrowedTo
          ? '收窄发生在**抽取层**：没被选中的人的这段消息不会留到下次（队列游标成功后照常推进）。'
            + '要连游标一起按人收窄，需 coordinator 按 subjectId 过滤 collectSources —— 属 modules/memory/**（bunny2）。'
          : null,
        via: 'memoryCoordinator.requestConsolidation（真排队，非同步跑）'
      });
    } catch (error) {
      return failed(error);
    }
  }

  // ── GET /api/memory-files（旧 src/app.js:2929-2932；★ N33 追加票新增）──────
  //
  // 改前这条**整条路由缺失** ⇒ 落到 `http.js:154` 的兜底 404「未找到」。
  // 老树回的是"成员印象库的文件列表"（`data/memory/people/*.json` 那套），
  // ★ 而用户已裁定「长期记忆按新版本做」⇒ 这里**不照老树那套成员库**，
  //   如实列**新架构盘上真有的东西**：
  //     · `<dataDir>/memory/` 下的记忆文件（evidence / observations / changes / idempotency / cards-hits / episodes …）
  //       —— 每份给字节数与行数；
  //     · 按会话的观察统计（从 observations 的 scope/namespace 聚合）—— 这是"哪个会话有多少记忆"的真答案。
  // 形状：老树那条只给 `{files:[…]}`，这里给 `{ok:true, files, sessions, totals, dataDir}`；
  //      老 UI 今天**不调**这条（实测 `grep memory-files ui/app.js` 只命中 consolidate 那条），
  //      所以这是"补齐 + 说清口径"，不是迁就某个既有形状。
  if (pathname === '/api/memory-files' && method === 'GET') {
    const dataDir = memoryDataDirOrNull(mem);
    if (!dataDir) {
      return notPorted('可解析的 dataDir（memory/getDataDir() 抛错）—— 读不到目录就列不出文件，'
        + '不能回空数组假装"没有记忆文件"');
    }
    try {
      const memDir = path.join(dataDir, 'memory');
      const files = [];
      if (fs.existsSync(memDir)) {
        for (const name of fs.readdirSync(memDir).sort()) {
          const full = path.join(memDir, name);
          let stat;
          try { stat = fs.statSync(full); } catch { continue; }
          if (!stat.isFile()) continue;
          let lines = null;
          if (name.endsWith('.jsonl')) {
            try { lines = fs.readFileSync(full, 'utf8').split('\n').filter((l) => l.trim()).length; } catch { lines = null; }
          }
          files.push({ name, bytes: stat.size, lines });
        }
      }
      // 按会话聚合观察数（新架构的真口径：从 observations.jsonl 的 scope/namespace 读）
      const sessions = new Map();
      const obsFile = path.join(memDir, 'observations.jsonl');
      if (fs.existsSync(obsFile)) {
        for (const line of fs.readFileSync(obsFile, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          let row; try { row = JSON.parse(line); } catch { continue; }
          const key = String(row?.namespace?.chatKey ?? row?.chatKey ?? '').trim();
          if (!key) continue;
          const scope = String(row?.scope ?? row?.namespace?.scope ?? '');
          const cur = sessions.get(key) ?? { chatKey: key, scope, observations: 0, subjects: new Set(), lastAt: 0 };
          cur.observations += 1;
          if (row?.subjectId) cur.subjects.add(String(row.subjectId));
          cur.lastAt = Math.max(cur.lastAt, Number(row?.at) || 0);
          sessions.set(key, cur);
        }
      }
      const sessionRows = [...sessions.values()]
        .map((s) => ({ chatKey: s.chatKey, scope: s.scope, observations: s.observations, subjects: s.subjects.size, lastAt: s.lastAt || null }))
        .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
      return ok({
        ok: true,
        dataDir: memDir,
        files,
        sessions: sessionRows,
        totals: {
          files: files.length,
          bytes: files.reduce((n, f) => n + f.bytes, 0),
          observations: sessionRows.reduce((n, s) => n + s.observations, 0),
          sessions: sessionRows.length
        },
        note: '长期记忆按新架构（M6 evidence→observation→card + 整理队列）统计；'
          + '老树那套"成员印象库文件"（data/memory/people/*.json）不再是真相源。'
      });
    } catch (error) {
      return failed(error);
    }
  }

  // ── GET /api/semantic-cards（旧 src/app.js:3371-3385）──────────────────────
  if (pathname === '/api/semantic-cards' && method === 'GET') {
    if (typeof mem?.cards !== 'function') {
      return notPorted('ctx.modules.memory.cards()（M6 卡片视图；memory/index.js:378）');
    }
    const dataDir = memoryDataDirOrNull(mem);
    if (!dataDir) {
      return notPorted('可解析的 dataDir（memory/getDataDir() 抛错）。'
        + '不设的话 cards() 会写到 workspace 的默认位置/读空 —— 那会把\"没配置\"伪装成\"没有卡片\"');
    }
    try {
      const r = mem.cards({ dataDir });
      const all = r?.cards || [];
      // ★ 只把"当前还有生效观察"的卡给面板：activeId=null 的卡 = 已全部撤回（用户视角=已删）。
      //   删完立刻能在列表里消失，否则刷新一下又回来（看着像"删了却没删"）。
      //   ⚠ 不藏：撤掉的条数如实进 stats.retiredOnly（要翻历史用 memory.history / 记忆审计）。
      const cards = all.filter((c) => c.activeId);
      const retiredOnly = all.length - cards.length;
      // ★★ P1-9（2026-10-11 · 用户真机报"语义卡里面什么都没有"）：title/detail/type/sourceCount
      //   原来恒 null/0（旧字段映射"对不上的不编"），⇒ 面板每行只剩一个空标题 + "0 条来源证据"，
      //   看着就像"什么都没有"。但正文**是有的**：M6 卡片的正文就是它当前生效那条观察的 `claim`
      //   （`store.js:490 cardRows` 只有 claimKey + 统计，claim 在 observation 上）。
      //   ⇒ 用**同一份 store** 的 `mem.history()` 按 activeId 取出来投影（不是第二份状态、不是前端拼）。
      //   ⚠ 取不到（该卡没有生效观察 / history 不在位）时仍给 null，并让 fieldGaps 说清，不编。
      const hist = typeof mem.history === 'function' ? mem.history({ dataDir }) : { versions: [] };
      const obsById = new Map();
      for (const v of hist?.versions || []) obsById.set(String(v.id), v);
      const SCOPE_LABEL = { global: '全局', group: '群聊', private: '私聊' };
      const rows = cards.map((c) => {
        // 旧字段 → 新字段如实映射；**取不到的不编**（见 fieldGaps）
        const obs = obsById.get(String(c.activeId)) || null;
        const claim = obs ? String(obs.claim ?? '').trim() : '';
        const evidenceIds = obs && Array.isArray(obs.evidenceIds) ? obs.evidenceIds : [];
        const origin = [SCOPE_LABEL[c.scope] || c.scope || '', c.chatKey ? `· ${c.chatKey}` : ''].filter(Boolean).join(' ');
        return {
          cardId: c.cardId,
          subjectId: c.subjectId,
          scope: c.scope,
          chatKey: c.chatKey,
          hits: Number(c.hits) || 0,
          writes: Number(c.writes) || 0,
          versions: Number(c.versions) || 0,
          activeId: c.activeId ?? null,
          lastHitAt: Number(c.lastHitAt) || 0,
          lastWriteAt: Number(c.lastWriteAt) || 0,
          // 旧 UI 要的 key（旧 src/app.js:3373-3383）
          key: c.cardId,
          type: obs?.type ?? null,
          title: claim || null,
          detail: origin || null,
          tags: c.scope ? [String(c.scope)] : [],
          lastTs: Number(c.lastWriteAt) || Number(c.lastHitAt) || 0,
          sourceCount: evidenceIds.length,
          // 真实但旧 UI 不显示的，一并给（排障/下一轮对齐用）
          subjectName: typeof mem.getSubjectName === 'function'
            ? (() => { try { return mem.getSubjectName(String(c.subjectId ?? ''), { dataDir }); } catch { return null; } })()
            : null,
          confidence: obs?.confidence ?? null,
          observedAt: obs?.at ?? null
        };
      });
      return ok({
        ok: true,
        cards: rows,
        stats: {
          count: rows.length,
          orphanHits: r?.orphanHits ?? {},
          writes: rows.reduce((n, c) => n + c.writes, 0),
          retiredOnly
        },
        // ★ 旧 UI 依赖字段的现状（**逐条如实**，别让 UI 自己静默显示空白）：
        //   投影后 title/detail/sourceCount/tags 已是真值（来自该卡当前生效观察的 claim/evidenceIds/scope）；
        //   仍缺的两条点名在这里，等 UI 侧补。
        fieldGaps: [
          'title/detail/sourceCount/tags：已从该卡当前生效观察投影（claim ⇒ title，scope+chatKey ⇒ detail，evidenceIds ⇒ sourceCount，scope ⇒ tags）'
            + '；取不到生效观察时仍为 null（那种卡不会出现在列表里，因为 activeId 为空）',
          'type：M6 观察的 type 是 impression/trait/preference/fact/topic/promise/question/recent 八种；'
            + '旧 UI 的标签表只有 plan/fact/topic 三态 ⇒ 其余会显示成「话题」（需要 UI 补标签表，不是数据缺口）',
          'detail 的正文维度：M6 没有旧卡那种"摘要正文"字段，claim 即正文；旧 UI 若想显示"计划/事实"分栏，需要读 observation.type'
        ],
        notPorted: null,
        dataDir
      });
    } catch (error) {
      return failed(error);
    }
  }

  // ── DELETE /api/semantic-cards/:id（旧 src/app.js:3386-3391）────────────────
  // ★★★ P0（2026-10-11 · mimo1 审计 P0-4 + §6 破坏数据）：**删除范围必须锁死在用户点的那张卡上**。
  //   改前这一行就够了：`mem.forget(card.subjectId, { dataDir, reason:'delete-card' })`
  //   —— 既不给 scope 也不给 chatKey ⇒ modules/memory/index.js:432 的过滤器两个都不生效
  //   ⇒ **删一张卡 = 撤回这个人在所有 scope / 所有会话里的全部当前观察**。
  //   用户看到的现象：只删了一张卡，别的群/私聊里关于这个人的记忆一起没了。
  //   现在：scope + chatKey 取卡片自己的，再用卡片当前生效那一版观察的 evidenceIds 收窄到
  //   **这一条 claim**；收不窄就拒删（409 + 说明），**绝不退回"删这个人整个范围"**。
  const cardMatch = /^\/api\/semantic-cards\/(.+)$/.exec(pathname);
  if (cardMatch && method === 'DELETE') {
    const key = decodeURIComponent(cardMatch[1]);
    if (typeof mem?.cards !== 'function' || typeof mem?.forget !== 'function') {
      return notPorted('ctx.modules.memory.cards() / forget()（M6 卡片视图 + 撤回出口；memory/index.js:378,432）');
    }
    const dataDir = memoryDataDirOrNull(mem);
    if (!dataDir) {
      return notPorted('可解析的 dataDir（memory/getDataDir() 抛错）。'
        + '不设的话 cards() 会写到 workspace 的默认位置/读空 —— 那会把"没配置"伪装成"没有卡片"');
    }
    try {
      const r = mem.cards({ dataDir });
      const hits = (r?.cards || []).filter((c) => c.cardId === key);
      if (!hits.length) {
        // ★ 改前这里是 `ok({ok:false, error:'card not found'})`（HTTP 200）。
        //   面板的 api() 只在 HTTP 非 2xx 时抛 ⇒ 那个 200 会让按钮照显示"已删除"，
        //   而盘上什么都没发生 —— 正是"不许看起来删了"要堵的口子。⇒ 404。
        return notFound(`card not found: ${key}`);
      }
      if (hits.length > 1) {
        // claimKey 里编了 scope/chatKey/subject/claim（store.js:57 claimKeyOf）⇒ 正常不该重名。
        // 真出现了也不许"挑第一张就删"：那张卡可能属于另一个会话。
        return refused(`cardId 对应多张卡（${hits.length} 张），拒绝猜测要删哪一张`, {
          cardId: key,
          candidates: hits.map((c) => ({ subjectId: c.subjectId, scope: c.scope, chatKey: c.chatKey, activeId: c.activeId ?? null }))
        });
      }
      const card = hits[0];
      const scope = String(card.scope ?? '');
      const chatKey = String(card.chatKey ?? '');
      // 收窄到"这一条 claim"：卡片当前生效的那一版观察（activeId）。
      // 定位不到 / 没有 evidenceIds ⇒ 拒删并说明，不给"范围变大"的退路。
      let evidenceIds = [];
      if (card.activeId && typeof mem.history === 'function') {
        const hist = mem.history({ subjectId: card.subjectId, scope, dataDir });
        const active = (hist?.versions || []).find((v) => String(v.id) === String(card.activeId)) ?? null;
        evidenceIds = (active?.evidenceIds || []).map(String).filter(Boolean);
      }
      if (!card.activeId || !evidenceIds.length) {
        return refused(
          `拒绝删除：无法把删除范围收窄到这一张卡（cardId=${key}）`,
          {
            cardId: key,
            subjectId: card.subjectId,
            scope,
            chatKey,
            why: card.activeId
              ? '该卡当前生效的观察没有 evidenceIds，只能按 subject+scope+chatKey 整段撤回（那会连带删掉同一范围里别人的其它记忆）'
              : '该卡当前没有生效的观察（可能已全部撤回）',
            hint: '要删请用带范围的操作，或先在记忆审计里确认范围'
          }
        );
      }
      const result = await mem.forget(card.subjectId, {
        dataDir,
        reason: 'delete-card',
        scope,
        chatKey,
        evidenceIds
      });
      const retracted = Array.isArray(result?.retracted) ? result.retracted : [];
      // ★ 复核 A（aaf16f9c）：只有 mem.forget **真撤回至少一条**才发 refresh —— HTTP 200 本身不是"真变更"
      //   （modules/memory/index.js:973 的「没有匹配的当前观察」也回 ok:true/retracted:[]）。
      if (result?.ok === true && retracted.length > 0) emitMemoryUpdate(ctx);
      return ok({
        ok: true,
        deleted: true,
        cardId: key,
        subjectId: card.subjectId,
        // 把"到底删了哪一块"如实回出来：调用方/审计能核对，不用猜
        scope,
        chatKey,
        retracted,
        matched: Number(result?.matched) || retracted.length,
        keptHistory: result?.keptHistory !== false,
        note: 'M6 不做物理删除：只把这一张卡当前生效的观察标 retracted，历史仍可在 memory.history / 记忆审计里翻到'
      });
    } catch (error) {
      return failed(error);
    }
  }

  // 不属于我：return null 让下一个分片接（如 /api/memory-files/group_123、/api/chats… 等）
  return null;
}

export const OWNED_PATHS = Object.freeze([
  // 仍让位：GET /api/memory-guard、GET /api/memory-people、DELETE /api/memory-people/all。
  'GET /api/memory-audit',
  'PUT /api/memory-people/:qq',
  'DELETE /api/memory-people/:qq',
  'DELETE /api/memory-people/:qq/surface',
  'POST /api/memory-people/cleanup',
  'DELETE /api/memory-people/name-only',
  'POST /api/memory-people/consolidate-all',
  'POST /api/memory-files/consolidate',
  'GET /api/memory-files',
  'GET /api/semantic-cards',
  'DELETE /api/semantic-cards/:id',
  // ★ A5（2026-10-11，出口=qwen1 368f400/de2a8c8；本切片只做 HTTP 转发，形状照他的契约 §二）
  'GET /api/memory/impressions/shareable',
  'POST /api/memory/impressions/share',
  'GET /api/memory/suppressions',
  'POST /api/memory/suppressions/reinstate',
]);
