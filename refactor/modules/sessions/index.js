/**
 * `modules/sessions` —— 会话登记表（列出 / 取单条）· T-SESSION-CLEANUP-PORT（sb2 · 2026-10-05）
 *
 * 搬运来源（旧树 `src/sessions.js`，663 行 → 本模块只搬"读"这一半）：
 *   · `newSessionId()`   旧 :21-23   `${base36}-${hex8}`
 *   · `sessionFile(id)`   旧 :25-27   `<dataDir>/sessions/<id>.json`
 *   · `readJsonLoose`     旧 :38-41   **容忍 BOM**（Windows 记事本写的 BOM 会让旧实现静默丢会话）
 *   · `#summary(s)`       旧 :262-288 列表条目的 17 个字段（逐字照搬）
 *   · `#loadOne` 收尾     旧 :115-137 陈旧 running/waiting ⇒ aborted/error 并**回写文件**
 *   · `#loadOne` 坏文件   旧 :140-155 跳过 + warn（引号内片段抹掉，隐私）
 *   · `get(id)`           旧 :326-337 内存 current 优先，否则读盘；读不到回 null
 *   · `peek(id)`          旧 :345-352 不克隆（热路径）
 *   · `listSummaries(limit=100)` 旧 :469-478 + `pruneMissingFiles()` 旧 :481-494（幽灵自愈）
 *
 * ★★ 2026-10-05 追加：读侧之外补上**写侧**（票 T-SB2-SESSIONS-WRITE）。
 *   缺陷背景：新树**没有任何路径**写 `data/sessions/*.json` ⇒ 聊天记录永远不落盘（主人报的"回复没进会话记录"）。
 *   搬运来源（旧树 `src/sessions.js` 写侧 + `src/orchestrator.js` 调用点）：
 *   · `create({chatKey, trigger, triggerSummary, status, waitUntil})` 旧 :290-324（含初始 25 字段形状）
 *   · `update(id)`          旧 :354-363 —— **节流**落盘（旧 :600-608：每会话 2 秒最多一次）
 *   · `setActivity(id, s)`  旧 :365-372
 *   · `finish(id, status)`  旧 :374-407 —— **立即**落最终态 + keepFiles 修剪（旧 :385-405）
 *   · `discard(id)`         旧 :420-438 —— 只准丢 `waiting` 的（跑过的不许丢，否则抹掉用量账）
 *   · `reingest(id)`        旧 :454-466 —— 回收站恢复后进程内立刻可见
 *   · `#persist(s)`         旧 :630-647（形状来源）+ `#bumpTodayUsage`
 *   · 调用契约来自 `src/orchestrator.js`：它**直接改 session 对象**（`session.turnPlan = …`、
 *     `session.messages.push(…)`，见 :3378/:3408/:3668/:3707）**再调 `update(id)` / `finish(id, status)`**
 *     （:1619 create → :1647 update → :1683 finish → :4555 finish）。所以本模块提供 `update`/`finish`
 *     这两个"提交点"，另给 `appendMessage` 作为**带落盘**的便捷出口（运行时的推荐用法）。
 *
 * ★ 与旧树三处**有意的不同**（都往"更诚实/更安全"方向，理由在代码注释里）：
 *   1. **原子写**：旧树在 :610-629 明确把「tmp+rename」换成**直接覆写**（为省 Windows 上固定 43ms 的 rename）。
 *      本票要求原子写 ⇒ 复用 `core/util` 的 `writeJsonAtomic`（tmp+rename，失败删 tmp 并抛）。
 *      代价是每次落盘多付一次 rename；换来"不会把正在跑的会话写成半截 JSON"。
 *   2. **失败可见**：旧 `#persist` 用 try/catch **吞掉**写盘错误（只 console.error，旧 :644-646），
 *      调用方拿到的是一个"以为存上了"的会话。本模块的写操作一律返回 `{ok, error?}`，
 *      并可在 `strict` 模式下直接抛；`diagnostics().lastPersistError` 可查。**绝不静默假装成功。**
 *   3. **不做"今天用量"累加**（旧 `#bumpTodayUsage`）：那是用量页的统计口径，属观账本那条线，不在本模块。
 *
 * ★ **只读摘要缓存**：`listSummaries({readOnly:true})` / `snapshot()` 会使用进程内缓存与落盘索引。
 *   写侧通过 `patchCacheRow()` / `persistDurableIndex()` 同步维护；主索引旁保留原子 `.bak`，写失败不删旧文件并写 `.stale` 标记；
 *   陈旧标记存在时只接受与当前目录指纹精确匹配的备份，否则回到全量扫描，不能把旧摘要当最新数据。
 *   目录变化时当前请求只重读变化文件并更新摘要。
 *   ★ S04（2026-10-19）：索引条目 ≥512 条后，每次写入改为向 `<index>.journal.jsonl` **追加一行**，
 *   读侧"基索引 + 日志"合并后再对账；日志满 512 行合并回整份基索引并清日志（崩溃最坏重复应用一次，幂等）。
 *   小索引仍走整份原子写 —— 体量有界、既有校验/备份/自测锚点不变。日志损坏 ⇒ 退回全量/重建，不猜。
 *
 * ★★ **只读保证不受影响**：`snapshot()` 与 `listSummaries({readOnly:true})` 仍然**零写入**
 *   （陈旧收尾只在内存里改副本，不落盘），这一点由自测 5.x 的 mtime+size 对照钉死。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { writeJsonAtomic } from '../../core/util/index.js';

const DAY_MS = 24 * 3600 * 1000;
/**
 * ★ S-2（2026-10-07）：`summaryOf()` 多了 `sentCount` 与 `finishReason` ⇒ **旧索引回灌的条目没有这两个键**
 *   ⇒ 必须抬版本，否则面板还是"没给数/说不出原因"，等于没修。代价：**首次一次冷扫**
 *   （指挥位实测冷 10,636ms / 热 9.6ms，一次性；`probe-s2-coldscan.mjs` 复核"只在第一次冷"）。
 * ★ S-2c（2026-10-07 16:2x，指挥位线上实测）：**2 这一版是漏的** —— 常量是为 `sentCount` 抬到 2 的，
 *   `finishReason` 16:18 才加、**没跟着再抬** ⇒ `v` 校验通过 ⇒ 不重扫 ⇒ 盘上 10,609 条只有 1 条真带
 *   `finishReason` ⇒ 键数看着是 18、**值全是 null**（判「未发送」的 634 条带得出原因的 0 条）。
 *   ⇒ 抬到 **3**。但**真正的修法不是这个**：一个数字常量挡不住"加键忘抬版本"（人一定会犯），
 *   能挡的是**键形状** ⇒ 见 `INDEX_SHAPE_KEYS` / `loadDiskIndex()` 的形状闸（`:412` 附近）。
 * ★ P1-a（2026-10-08）：`summaryOf()` 再加**三键**（`replyOutcome` / `replyReason` / `toolOutcome`）⇒ 抬到 **4**。
 *   两道闸都在：① 版本号一不一致 ⇒ 整份索引作废重建；② `INDEX_SHAPE_KEYS` 从 `summaryOf` 本身推导
 *   ⇒ 旧条目**缺这三个键**，形状闸逐条验 ⇒ 照样判无效重建（票面要求的是①，别因为有②就省①：
 *   今晚 `finishReason` 就是"只加键没抬版本"白干了一轮）。代价：一次冷扫（实测冷 10,636ms / 热 9.6ms）。
 * ★ N89 追加：`turn.failedCount` 是嵌套字段，根级 `INDEX_SHAPE_KEYS` 看不见；索引版本升到 **5**，
 *   让旧摘要重新从会话文件投影，避免列表缓存继续漏字段。
 */
const DISK_INDEX_VERSION = 5;
/** ★ S-2c 牙 3 要能**直接钉这个数**（导出只为了断言，不改任何行为）：谁把它改回去 ⇒ 探针必红。 */
export { DISK_INDEX_VERSION };
/** 会话 id 严格式（旧 `cleanup.js:33` 同款）：天然排除 `_manifest` 等保留名，并挡掉路径穿越。 */
export const SESSION_ID_RE = /^[a-z0-9]+-[0-9a-f]{8}$/;

let configuredDataDir = '';
let runtimeCurrentSessions = null;

/** 返回进程中当前会话数；不返回会话内容。尚未创建登记表时为 undefined。 */
export function getActiveSessionCount() {
  return runtimeCurrentSessions instanceof Map ? runtimeCurrentSessions.size : undefined;
}

/** 注入 dataDir（生产由装配层传；不传则只认 `QQ_AGENT_DATA_DIR`）。 */
export function configure(options = {}) {
  if (options?.dataDir !== undefined) configuredDataDir = String(options?.dataDir ?? '').trim();
  return { dataDir: configuredDataDir };
}

export function configuredSessionsDir() { return configuredDataDir; }

/**
 * ★★ 2026-10-05 18:1x 指挥位加：**进程内摘要缓存**（真连实测补救）。
 *
 * 用途：读路径缓存摘要，避免 UI 列表请求重复读取并 parse 全部会话。
 *
 * 设计（有意保守）：
 *   · **只缓存只读路径**（`readOnly:true`）。非只读路径会跑"陈旧收尾回写"（settleStale 会写盘），
 *     拿缓存顶掉它 = 悄悄改语义 ⇒ 不缓存。
 *   · 目录 mtime / JSON 数量变化立即做增量刷新；逐文件比较 mtime/size，只 parse 新增或变化的文件。
 *   · **TTL 15s**：TTL 内返回缓存；超时后同步逐文件复核，只重读元信息变化的文件。
 *   · 返回**拷贝**：`pruneMissingFiles()` 会原地改数组（`into.length=0; push(...)`），缓存不能被它改坏。
 *   · ★ 2026-10-16：**易过期状态（running/waiting）每轮刷新都纳入重读**（见 `refreshCacheSync`）——
 *     陈旧收尾 `settleStale(...,{readOnly:true})` 只改内存、**不写盘** ⇒ 卡住的行文件 mtime/size 永远不变，
 *     靠"文件变化"永远等不到重读；不补这一步，大目录（>64 个 json，走 rescan-signature 增量）会把
 *     超 15 分钟的 running 一直当 running 顶给读侧。这类行数量本就少（在跑的轮），开销 O(活行数)。
 *   · `diagnostics.lastIndexLoad` 记录模式、扫描/读取文件数与耗时。
 *
 * ⚠ 这是**临时补救，不是终点**：旧树的**落盘索引**（`sessions-index.json` + 7 道校验 + Tier-2 重读）
 *   才是"功能相同"的那件东西（它正是为 9923 个 json / 685 MB 的旧盘做的）。已登记为后续票。
 * @type {Map<string, {scannedAt:number, summaries:object[], diagnostics:object, fileMeta?:Map<string,{mtimeMs:number,size:number}>, fileNames?:Set<string>}>}
 */
const readOnlyScanCache = new Map();
const READONLY_CACHE_TTL_MS = 15000;
const backgroundIndexRebuildJobs = new Map();
const backgroundIndexRebuildFailures = new Map();
let nextBackgroundIndexRebuildId = 1;
const BACKGROUND_REBUILD_RETRY_MS = 30000;

/**
 * 目录指纹（**廉价门**，每次读都查）：`{ mtimeMs, count }`。
 *
 * - `mtimeMs` = `fs.statSync(dir).mtimeMs`：**增/删/改名**都会变（O(1)）。
 * - `count` = 目录里 `.json` **条目数**（一次 `readdirSync`）。
 *
 * ★★ **为什么光看 mtime 不够（本机实测，2026-10-05）**：目录 mtime 的精度约 **1ms**，
 *   **同一毫秒内**连续创建/删除文件时它**根本不变**（实测 `back-to-back write changed = false`）。
 *   而"外部改盘"最典型的形态恰恰就是**紧接着上一次读**再写（探针/另一个进程）⇒
 *   只看 mtime 会出现**同毫秒盲区**：廉价门不触发 ⇒ 等 TTL 到期后逐文件复核。
 *   （我第一版只放 mtime，自测 12.3 有一轮**侥幸绿**、下一轮就红了 —— 就是踩了这个。）
 *   `count` 补上这个洞：同毫秒内**条目数**照样变。
 *   代价：一次 `readdirSync`（真盘 1 万项约几毫秒 —— 旧树 `src/sessions.js:12-13` 实测
 *   "readdir 3ms / 读+parse 全部 10925ms"），目录检查远比逐文件读取便宜。
 *
 * ⚠ 仍然存在的盲区（取舍，写在这里不藏）：**原地改文件内容**既不改目录 mtime 也不改条目数
 *   ⇒ 只能等 `scannedAt` 超 TTL 的逐文件复核（最坏 15s）。
 */
function dirFingerprintCheap(dir) {
  try {
    const names = fs.readdirSync(dir);
    let count = 0;
    for (const n of names) if (n.endsWith('.json')) count += 1;
    return { mtimeMs: fs.statSync(dir).mtimeMs, count };
  } catch {
    return { mtimeMs: null, count: -1 };      // 读不动目录：count=-1 让它与任何真实指纹不同
  }
}

/**
 * ★ 手动失效某个 sessions 目录的只读扫描缓存（**写侧专用**，2026-10-05）。
 *
 * 为什么必须有（指挥位 18:08 那个缓存的洞，由本票的写侧暴露）：
 *   缓存的快路径是 `age < 15s` 且目录指纹未变化 ⇒ **写完之后 15 秒内**，
 *   `listSummaries({readOnly:true})` 会直接吐**旧摘要**，而 `diagnostics.lastIndexLoad.mode`
 *   还报 'cache'。写侧没接上时这不可察觉；**一旦有了写侧，它就是主人报的"回复没进记录"**
 *   （自测 11.4/11.6 在修之前的红行就是它：`mode=cache`、`status=running`）。
 *
 * 为什么选"写后删条目"而不是"每次读都复核所有文件"：
 *   逐文件复核仅在 TTL 到期时执行；写后删条目仍是 **O(1)**，且**纯读者照样吃 15s 缓存**。代价是"绕过本模块直接改盘"的写法
 *   （例如有人手工编辑 `data/sessions/*.json`）仍要等 TTL 到期 —— 那本来也不是本模块该管的事。
 */
export function invalidateSessionsCache(sessionsDir) {
  if (!sessionsDir) return false;
  return readOnlyScanCache.delete(String(sessionsDir));
}

/**
 * ★ 就地补一行（2026-10-05 T-SB2-CACHE-PATCH）。
 *
 * 背景（指挥位实测）：写路径原来在成功后 `delete` 整个缓存条目 ⇒ **每次写之后的那一次读都是全量冷扫**
 * （S7-1 实测 readMs 56ms vs 热读 7ms；真盘 10323 文件的冷扫 ≈ **6037ms**）。而运行时**每轮都在写**
 * （`create → update(节流) → appendMessage(多条) → finish`）⇒ 主人"机器人在说话时点开会话列表"
 * 正好撞上冷扫 —— 那是卡顿回潮的路径。
 *
 * 做法：**只改受影响的那一行**（O(1)）：
 *   · 写/改一条 ⇒ 用刚落盘的那份重算摘要，替换缓存数组里的同 id 行（没有就插到**最前**，与扫盘序一致）；
 *   · unlink（discard）⇒ 从缓存数组里摘掉那一行；
 *   · 目录 mtime 廉价门（每次读都查）+ `scannedAt` 超 TTL 的逐文件门。
 *     补行只是"省掉**我自己造成的**全表失效"，不改变外部改动的收敛口径。
 *   · `dirMtime` 一并推进到当前值：否则**我自己这次写**会让下一读廉价门立刻触发全量扫（等于没补）。
 *     ⚠ 取舍：同一毫秒内若还有外部增删，会被这次推进**掩盖到 TTL**（逐文件门兜底）—— 与
 *     「同毫秒写两次 mtime 可能不变」是同一类取舍，已写在这里，不藏着。
 *   · **失败可见**：补行本身出错（摘要重算抛等）⇒ **退回删条目**（= 旧行为，绝不"补了半行还假装新鲜"），
 *     并在 `diagnostics.cachePatchErrors` 记一笔。
 * @returns {{patched:boolean, reason?:string, error?:string}}
 */
function patchCacheRow(sessionsDir, session, diag) {
  const hit = readOnlyScanCache.get(sessionsDir);
  if (!hit) return { patched: false, reason: 'no-cache-entry' };   // 没缓存 ⇒ 无需补（下次读自然会全量扫）
  try {
    if (session === null) {
      // 摘除模式由调用方直接给 id（见 removeCacheRow）
      return { patched: false, reason: 'use-remove' };
    }
    const summary = summaryOf(session);
    const idx = hit.summaries.findIndex((e) => e.id === summary.id);
    if (idx >= 0) hit.summaries[idx] = summary;
    else hit.summaries.unshift(summary);            // 扫盘序是文件名倒序 ⇒ 新的在最前
    hit.patchedAt = Date.now();
    hit.fp = dirFingerprintCheap(sessionsDir);      // 推进廉价门（否则自己写的这次会让下一读全量扫）
    diag.cachePatches += 1;
    return { patched: true };
  } catch (error) {
    const msg = String(error?.message ?? error);
    diag.cachePatchErrors += 1;
    readOnlyScanCache.delete(sessionsDir);          // 退回旧行为：宁可下次冷扫，也不留半新半旧
    return { patched: false, reason: 'patch-failed', error: msg };
  }
}

/** 从缓存里摘掉一行（`discard` 的 unlink 路径用）。同样失败即退回删条目。 */
function removeCacheRow(sessionsDir, id, diag) {
  const hit = readOnlyScanCache.get(sessionsDir);
  if (!hit) return { patched: false, reason: 'no-cache-entry' };
  try {
    const before = hit.summaries.length;
    hit.summaries = hit.summaries.filter((e) => e.id !== id);
    hit.patchedAt = Date.now();
    hit.fp = dirFingerprintCheap(sessionsDir);
    diag.cachePatches += 1;
    return { patched: hit.summaries.length !== before };
  } catch (error) {
    diag.cachePatchErrors += 1;
    readOnlyScanCache.delete(sessionsDir);
    return { patched: false, reason: 'patch-failed', error: String(error?.message ?? error) };
  }
}

/** 诊断用：当前缓存里有几个目录的条目（探针/自测可断言"写后条目被清掉"）。 */
export function readOnlyCacheKeys() {
  return [...readOnlyScanCache.keys()];
}

/**
 * ⚠ **只给自测用的钩子**：把某个 sessionsDir 的廉价指纹**强制**改成给定值。
 *
 * 为什么需要它：自测要确定性地验"**目录 mtime 门失效时靠 TTL 逐文件复核兜底**"这条路径，
 * 但真实手段（`utimesSync` 掰 mtime）只有**毫秒精度**，而 `statSync` 返回的是**亚毫秒**值
 * （实测 `…810.1094` vs `…810.109`）⇒ 掰不回去，廉价门照样响，测不成那条路径。
 * 与其把断言放松成"差不多"（那就测不到真东西），不如给一个**明确的、只给自测的**开关。
 * 生产路径**不会**调用它。
 */
export function __forceCacheFingerprint(sessionsDir, fp) {
  const hit = readOnlyScanCache.get(String(sessionsDir));
  if (!hit) return false;
  hit.fp = { mtimeMs: fp?.mtimeMs ?? null, count: fp?.count ?? -1 };
  return true;
}


/**
 * dataDir → sessions 目录。**没给就抛**，绝不猜。
 * @returns {string}
 */
export function resolveSessionsDir(dataDir = configuredDataDir) {
  const dir = String(dataDir || process.env.QQ_AGENT_DATA_DIR || '').trim();
  if (!dir) {
    const error = new Error('modules/sessions: dataDir 未设置（configure({dataDir}) 或 QQ_AGENT_DATA_DIR）—— 不猜目录');
    error.reason = 'dataDir-unset';
    throw error;
  }
  return path.join(dir, 'sessions');
}

export function newSessionId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

/** 会话文件路径（旧 :25）。id 不合法 ⇒ 抛（**不做路径拼接**）。 */
export function sessionFile(id, sessionsDir = resolveSessionsDir()) {
  const clean = String(id ?? '').trim();
  if (!SESSION_ID_RE.test(clean)) {
    const error = new Error(`modules/sessions: 会话 id 不合法：${JSON.stringify(String(id ?? '').slice(0, 40))}`);
    error.reason = 'bad-id';
    throw error;
  }
  return path.join(sessionsDir, `${clean}.json`);
}

/** Context checkpoint storage is isolated under the configured dataDir and keyed by hashes. */
export const CONTEXT_CHECKPOINT_VERSION = 2;
export const CONTEXT_COMPRESSION_PROGRESS_VERSION = 1;
const CONTEXT_CHECKPOINT_HASH_RE = /^[a-f0-9]{64}$/;

function stableCheckpointJson(value) {
  const sort = (node) => {
    if (Array.isArray(node)) return node.map(sort);
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.keys(node).sort().map((key) => [key, sort(node[key])]));
    }
    return node;
  };
  return JSON.stringify(sort(value));
}

export function contextCheckpointHash(value) {
  try {
    const serialized = stableCheckpointJson(value);
    if (typeof serialized !== 'string') return '';
    return crypto.createHash('sha256').update(serialized).digest('hex');
  } catch { return ''; }
}

function contextNamespaceHash(namespace) {
  const accountId = String(namespace?.accountId ?? '').trim();
  const kind = String(namespace?.kind ?? '').trim();
  const chatKey = String(namespace?.chatKey ?? '').trim();
  if (!accountId || !kind || !chatKey) return '';
  return contextCheckpointHash({ accountId, kind, chatKey });
}

function stableContextCursor(cursor) {
  if (cursor && typeof cursor === 'object' && !Array.isArray(cursor)
    && Number.isSafeInteger(cursor.sourceRevision) && cursor.sourceRevision >= 0) return true;
  if (typeof cursor === 'string') {
    const value = cursor.trim();
    return value.length > 0 && !/^\d+$/.test(value)
      && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value);
  }
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return false;
  if (Number.isSafeInteger(cursor.localId) && cursor.localId > 0) return true;
  if (Number.isSafeInteger(cursor.id) && cursor.id > 0) return true;
  const id = cursor.messageId ?? cursor.id ?? cursor.localId;
  if (typeof id === 'string') return stableContextCursor(id);
  return false;
}

function safeJsonClone(value) {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? JSON.parse(serialized) : null;
  } catch { return null; }
}

function containsToolPairMessages(value, depth = 0) {
  if (depth > 24) return true;
  if (Array.isArray(value)) return value.some((item) => containsToolPairMessages(item, depth + 1));
  if (!value || typeof value !== 'object') return false;
  if (value.role === 'tool' || (value.role === 'assistant'
    && Array.isArray(value.tool_calls) && value.tool_calls.length > 0)) return true;
  return Object.values(value).some((item) => containsToolPairMessages(item, depth + 1));
}

function checkpointFingerprint(input, hashKey, valueKey) {
  const supplied = String(input?.[hashKey] ?? '').trim();
  if (CONTEXT_CHECKPOINT_HASH_RE.test(supplied)) return supplied;
  if (!Object.hasOwn(input ?? {}, valueKey)) return '';
  return contextCheckpointHash(input[valueKey]);
}

function contextCheckpointRecordError(record, namespaceHash = '') {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'checkpoint-malformed';
  if (record.schemaVersion !== CONTEXT_CHECKPOINT_VERSION) return 'checkpoint-version-unsupported';
  if (!namespaceHash || record.namespaceHash !== namespaceHash) return 'checkpoint-namespace-mismatch';
  if (!stableContextCursor(record.sourceCursor)
    || record.sourceCursorHash !== contextCheckpointHash(record.sourceCursor)) return 'checkpoint-cursor-unverifiable';
  if (!Number.isSafeInteger(record.sourceRevision) || record.sourceRevision < 0) return 'checkpoint-source-revision-unavailable';
  if (!Number.isSafeInteger(record.sourceTotal) || record.sourceTotal < 0) return 'checkpoint-source-total-unavailable';
  if (Number.isSafeInteger(record.sourceCursor?.sourceRevision)
    && record.sourceCursor.sourceRevision !== record.sourceRevision) return 'checkpoint-cursor-revision-mismatch';
  if (!CONTEXT_CHECKPOINT_HASH_RE.test(String(record.contextHash ?? ''))
    || !Array.isArray(record.contextSegments)
    || record.contextHash !== contextCheckpointHash(record.contextSegments)) return 'checkpoint-context-hash-invalid';
  if (record.toolPairState !== 'none' || containsToolPairMessages(record.contextSegments)) {
    return 'checkpoint-tool-pair-not-reconstructable';
  }
  if (!CONTEXT_CHECKPOINT_HASH_RE.test(String(record.permissionFingerprint ?? ''))) return 'checkpoint-permission-fingerprint-invalid';
  if (!CONTEXT_CHECKPOINT_HASH_RE.test(String(record.toolSchemaFingerprint ?? ''))) return 'checkpoint-tool-schema-fingerprint-invalid';
  return '';
}

/**
 * Decide whether a persisted context checkpoint is a candidate for ChatStore's
 * revisioned incremental reader. The caller must still validate readSince and the
 * final source revision before it may count this as a hot hit.
 */
export function decideContextCheckpoint(checkpoint, expected = {}) {
  const namespaceHash = contextNamespaceHash(expected.namespace);
  const invalid = contextCheckpointRecordError(checkpoint, namespaceHash);
  if (invalid) return { action: 'cold-rebuild', reasonCode: invalid, candidateValid: false };
  const sourceRevision = expected.sourceRevision;
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) {
    return { action: 'cold-rebuild', reasonCode: 'checkpoint-source-revision-unavailable', candidateValid: false };
  }
  if (sourceRevision < checkpoint.sourceRevision) {
    return { action: 'cold-rebuild', reasonCode: 'checkpoint-source-revision-regressed', candidateValid: false };
  }
  const permissionFingerprint = checkpointFingerprint(expected, 'permissionFingerprint', 'permissions');
  if (!permissionFingerprint) {
    return { action: 'cold-rebuild', reasonCode: 'checkpoint-permission-fingerprint-unavailable', candidateValid: false };
  }
  if (permissionFingerprint !== checkpoint.permissionFingerprint) {
    return { action: 'cold-rebuild', reasonCode: 'checkpoint-permission-changed', candidateValid: false };
  }
  const toolSchemaFingerprint = checkpointFingerprint(expected, 'toolSchemaFingerprint', 'toolSchema');
  if (!toolSchemaFingerprint) {
    return { action: 'cold-rebuild', reasonCode: 'checkpoint-tool-schema-fingerprint-unavailable', candidateValid: false };
  }
  if (toolSchemaFingerprint !== checkpoint.toolSchemaFingerprint) {
    return { action: 'cold-rebuild', reasonCode: 'checkpoint-tool-schema-changed', candidateValid: false };
  }
  return {
    action: 'hot-candidate',
    reasonCode: sourceRevision > checkpoint.sourceRevision
      ? 'checkpoint-source-advanced' : 'checkpoint-source-current',
    candidateValid: true
  };
}

/** 读 JSON，容忍 BOM（旧 :38-41 的理由照搬：BOM 会让旧实现静默丢掉整份会话列表）。 */
export function readJsonLoose(file) {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
}

/**
 * ★ P1-a（2026-10-08，票《面板口径》§E.15）：**把"为什么没发"/"为什么没调工具"做成字段**。
 *
 * 名字与取值**照抄架构答复**（不许自创）：
 *   · `replyOutcome`: sent | partial | silent | skipped | blocked | failed | unknown
 *   · `toolOutcome` : not_entered | no_tools_offered | text_chosen | tools_used（+ 诚实档 unknown）
 *   · `replyReason` : 稳定原因码（真源给过码就**照抄那个码**，没给才用下面这套派生码）
 *
 * ★ **单一派生点**：列表投影 `summaryOf()` 与详情 `console-api.getSessionDetail()` 都调这一个函数，
 *   ⇒ "详情说有、列表说没"这件事**按构造不可能发生**（票面牙 2 打的就是它；S-2 今晚真踩过）。
 *
 * ★ **今天哪些值是真源、哪些是派生**（接上编排层显式码后要来换的就是这几处）：
 *   · `sent` / `partial` —— 真源：`sent[]` 长度 + `turnTrace.receipt.sentCount`（M15 回执，**唯一的真话**）；
 *       `partial` 的真源是 `turnTrace.actions[]` 里 **send_ 类工具 outcome==='error'** 且仍有别条发出去（盘上 23 条）。
 *   · `failed` —— 真源：`status==='error'`，或 send_ 类动作全失败且一条没发出去。
 *   · `blocked` —— 真源：`turnTrace.blockReason` / `turnTrace.policyOutcome==='blocked'`（老树留的**观测口**，
 *       新树还没写）+ `finishReason` 里的 `COMPOSE_GUARD`（新树 compose 给的真码）。
 *       ★ 卫生链拦下**绝不记成"模型没回答"**：这条排在 silent 之前，且 silent 要求"确实没正文证据"。
 *   · `skipped` —— 真源：**没进模型**（没有 model_call/model_attempt 阶段、actions 空、`usage.calls` 为 0、
 *       finishReason 也不是 COMPOSE_ 打头）⇒ 闸门/规划没放行。盘上实测 status=skip 的 17 条全是 calls=0 ⇒ 判得实。
 *       ★ 别用 `rounds` 判：老树 skip 行 rounds 恒 1，那是假话。
 *   · `silent` —— 真源：进了模型、回执数已知为 0、且没有任何拦截/失败信号 ⇒ 模型自己选了沉默
 *       （`finishReason` 的 `COMPOSE_EMPTY` / `COMPOSE_FINISHED_NO_TEXT` 会照抄成原因码）。
 *   · `unknown` —— **只有**真拿不到才给：没有 turnTrace（老数据 81 条 aborted）、发送数三源全空、
 *     轮次还在跑（running/waiting）、被中止（aborted）、状态自称发过而回执为 0（`STATUS_SAYS_SENT`）。
 *     **不许**拿它当默认值。
 *   · `no_tools_offered` —— ★ **今天没有生产者**：要区分"这轮压根没给工具清单"和"给了没选"，
 *     需要每次调用的 toolset 形状落在 turnTrace 上（编排层的活）。本函数**永不产出**它，
 *     枚举里留着只是把契约写全，接上真码后由编排层显式给。
 */
export const REPLY_OUTCOMES = Object.freeze(['sent', 'partial', 'silent', 'skipped', 'blocked', 'failed', 'unknown']);
export const TOOL_OUTCOMES = Object.freeze(['not_entered', 'no_tools_offered', 'text_chosen', 'tools_used', 'unknown']);

/** 派生原因码（真源没给码时才用这套；每个都必须能在 `apps/ui/status-vocab.js` 查到人话）。 */
export const REPLY_REASON_CODES = Object.freeze([
  'SENT_OK', 'SENT_PARTIAL', 'SEND_FAILED', 'MODEL_ERROR', 'ROUND_ERROR',
  'TEXT_ONLY_JUDGE', 'POLICY_BLOCK', 'CIRCUIT_BLOCK', 'TOOL_HOOK_BLOCK',
  'MODEL_SILENT', 'PLAN_SKIPPED', 'RUNNING', 'ABORTED', 'COUNT_UNKNOWN', 'NO_TRACE',
  'STATUS_SAYS_SENT'
]);

/** 盘上真源里"compose 跑完了但**没产出可发的正文**"的码（比 status 那个字更接近原因）。 */
const COMPOSE_NO_TEXT_CODES = new Set(['COMPOSE_EMPTY', 'COMPOSE_FINISHED_NO_TEXT']);

/**
 * 「状态**自称**已经把消息投递出去了」的终态（`orchestrator/index.js:1099`：`delivered.delivered` 才写得出它）。
 * ★ 只收 `delivered`：盘上实测 2000 条里 `delivered` + 发送数 0 有 20 条（0 个 model 阶段、0 个动作，
 *   finishReason 是 PRIVATE_RULE / DIRECT_QUESTION / FREE_INTERJECTION 这类**规划放行码**）
 *   ⇒ 状态说"发过了"、回执说"一条没发"，两个真源打架，**不裁定**：判 `unknown`，说 sent 和说 silent 都是撒谎。
 *   ★ compose 已经给了"为什么没发"的码（COMPOSE_EMPTY / COMPOSE_FINISHED_NO_TEXT）时**不在此列**：
 *     那就是 `silent`，原因比 status 那个字值钱。
 * `done` / `noreply` / `completed` **不在此列**：它们是中性终态（沉默本来就长这样）——
 *   `completed` + 0 的 24 条里 17 条是 `COMPOSE_EMPTY`，不许误判成 unknown。
 */
const SENT_CLAIMING_STATUSES = new Set(['delivered']);

/** `finishReason` 的真码前缀（同 orchestrator 的 `reasonCode` 口径：大写下划线，至少 3 字）。 */
function sourceReasonCode(raw) {
  const m = /^([A-Z][A-Z0-9_]{2,})(?=$|[:\s])/.exec(String(raw ?? '').trim());
  return m ? m[1] : '';
}

/** 发送数的三个真源，谁有数听谁的（口径同 `apps/ui/status-vocab.js` 的 `sentCountOf`）。 */
function sentTruthOf(session) {
  const cands = [];
  if (Array.isArray(session?.sent)) cands.push(session.sent.length);
  if (typeof session?.sentCount === 'number' && Number.isFinite(session.sentCount)) cands.push(session.sentCount);
  const rc = session?.turnTrace?.receipt?.sentCount;
  if (Number.isFinite(rc)) cands.push(rc);
  if (!cands.length) return { known: false, count: 0 };
  return { known: true, count: Math.max(0, ...cands) };
}

/** 动作表里 send_ 类工具（`send_message` / `send_sticker` / `send_image` / `send_music` …）的成败。 */
function sendActionTruth(actions) {
  let seen = 0;
  let failed = 0;
  for (const a of actions) {
    if (!/^send_/i.test(String(a?.tool ?? ''))) continue;
    seen++;
    if (String(a?.outcome ?? '') === 'error') failed++;
  }
  return { seen, failed, allFailed: seen > 0 && failed === seen };
}

/**
 * 一轮的**结果口径**（replyOutcome / replyReason / toolOutcome）。
 * ★ 判不出就 `unknown` + 说明，**不许**猜、不许把"规划跳过"和"平台失败"挤成一格。
 * @param {object} session 会话对象（列表投影或详情对象都行：吃的字段是二者的并集）
 */
export function deriveOutcomes(session) {
  const s = session ?? {};
  const status = String(s.status ?? '');
  const trace = s.turnTrace && typeof s.turnTrace === 'object' ? s.turnTrace : null;
  const actions = Array.isArray(trace?.actions) ? trace.actions : [];
  const stages = Array.isArray(trace?.stages) ? trace.stages : [];
  const sent = sentTruthOf(s);
  const sends = sendActionTruth(actions);
  const sourceCode = sourceReasonCode(s.finishReason);
  // 「进了模型」的证据，四选一拍板（**别用 rounds**：盘上 skip 行 rounds 恒 1，是假话）：
  //   ① trace 里有 model_call / model_attempt 阶段 ② 有动作表 ③ 老树留了 modelOutcome
  //   ④ usage.calls>0（新树没有 model_* 阶段名时的旁证）⑤ finishReason 是 COMPOSE_ 打头
  //     ——compose 只有真跑完模型才产得出码（盘上 COMPOSE_FINISHED_NO_TEXT 行 stages 全空，
  //     旧判据把它们演成"规划跳过"，正是票面禁的"把沉默和跳过挤成一格"）。
  const entered = stages.some((st) => /^model_(call|attempt)$/.test(String(st?.name ?? '')))
    || actions.length > 0
    || (typeof trace?.modelOutcome === 'string' && trace.modelOutcome !== '')
    || (Number.isFinite(s.usage?.calls) && s.usage.calls > 0)
    || (sent.known && sent.count > 0)          // ★ 发出去过东西 = 一定进过模型（否则说不出那句话）
    || /^COMPOSE_/.test(sourceCode);
  // 「模型给了正文」的证据：发出去的文字、只给正文没调工具、或正文被守卫摘掉（**说明有正文**）。
  const textEvidence = (Array.isArray(s.sent) && s.sent.some((row) => String(row?.type ?? '') === 'text'))
    || trace?.modelOutcome === 'text_only'
    || trace?.blockReason === 'text_only_judge'
    || sourceCode === 'COMPOSE_GUARD';
  const blocked = trace?.blockReason || trace?.policyOutcome === 'blocked' || sourceCode === 'COMPOSE_GUARD';
  const composeExplained = COMPOSE_NO_TEXT_CODES.has(sourceCode);   // compose 自己说了"没产出正文" ⇒ 不用 status 猜
  const running = status === 'running' || status === 'waiting';

  // ── toolOutcome ────────────────────────────────────────────────
  let toolOutcome;
  if (!trace) toolOutcome = 'unknown';                       // 老数据没追踪 ⇒ 不许演成"没进模型"
  else if (actions.length > 0 || trace?.modelOutcome === 'tool_calls') toolOutcome = 'tools_used';
  else if (textEvidence) toolOutcome = 'text_chosen';
  else if (!entered) toolOutcome = 'not_entered';
  else if (sent.known && sent.count > 0) toolOutcome = 'unknown'; // 发出去过东西却没记动作也没记正文 ⇒ 追踪缺页，别说"没进模型"
  else toolOutcome = 'unknown';
  // `no_tools_offered` 今天**永不产出**（没有生产者，见上面注释）。

  // ★ **真源打架要报名**：状态自称"投递过了"（delivered）而回执说 0 条，且 compose 没给出原因 ⇒ 两个真源
  //   互相矛盾，**不裁定**：判 unknown + STATUS_SAYS_SENT。说 sent 是撒谎，说 silent/skipped 也是撒谎。
  //   （盘上实测 2000 条里这种行有 20 条，finishReason 全是 PRIVATE_RULE 那类"为什么放行"的规划码，答不了"为什么没发"。）
  const claimsSentButZero = SENT_CLAIMING_STATUSES.has(status) && !composeExplained && !blocked && sent.known && sent.count === 0;

  // ── replyOutcome（判序即语义：**先发出去没有 → 还在跑的不裁定 → 谁拦的 → 最后才轮到沉默/跳过**）──
  let replyOutcome;
  if (sent.known && sent.count > 0) {
    replyOutcome = sends.failed > 0 ? 'partial' : 'sent';
  } else if (running) {
    replyOutcome = 'unknown';                                 // ★ 还没发完 ≠ 没发：不许演成 skipped/silent
  } else if (status === 'error') {
    replyOutcome = 'failed';
  } else if (sends.seen > 0 && sends.allFailed) {
    replyOutcome = 'failed';                                  // 平台侧真把发送打挂了（一条没出去且发送动作全错）
  } else if (status === 'stopped') {
    replyOutcome = 'blocked';
  } else if (blocked) {
    replyOutcome = 'blocked';                                 // ★ 有正文被拦 ⇒ 绝不许落进 silent
  } else if (status === 'aborted') {
    replyOutcome = 'unknown';
  } else if (!trace) {
    replyOutcome = 'unknown';
  } else if (!sent.known) {
    replyOutcome = 'unknown';                                 // 三源全空：不知道就是不知道
  } else if (claimsSentButZero) {
    replyOutcome = 'unknown';
  } else if (!entered) {
    replyOutcome = 'skipped';
  } else {
    replyOutcome = 'silent';
  }

  const out = {
    replyOutcome,
    toolOutcome,
    replyReason: claimsSentButZero ? 'STATUS_SAYS_SENT' : (sourceCode || derivedReasonCode({ replyOutcome, status, running, trace, sent, sends }))
  };
  // ★ **显式码优先 + 幂等**：编排层（或已投影好的行）自己给了合法值 ⇒ 听它的，派生只补空。
  //   这条同时让"在列表行上再算一次"不会把结论算**差**（投影里没有 turnTrace，重算会退成 unknown）。
  if (REPLY_OUTCOMES.includes(s.replyOutcome)) out.replyOutcome = s.replyOutcome;
  if (TOOL_OUTCOMES.includes(s.toolOutcome)) out.toolOutcome = s.toolOutcome;
  if (typeof s.replyReason === 'string' && s.replyReason.trim()) out.replyReason = s.replyReason.trim();
  return out;
}

/**
 * 派生原因码：**只在真源没给码时**用这套（真源给过的码一律照抄，见 `deriveOutcomes` 里 `sourceCode || …`）。
 * 每个码都必须在 `apps/ui/status-vocab.js` 的 `REPLY_REASON` 表里查得到人话 ⇒ 不许在这里造完就丢。
 */
function derivedReasonCode({ replyOutcome, status, running, trace, sent, sends }) {
  if (replyOutcome === 'sent') return 'SENT_OK';
  if (replyOutcome === 'partial') return 'SENT_PARTIAL';
  if (replyOutcome === 'failed') {
    if (status === 'error') return 'ROUND_ERROR';
    if (trace?.modelOutcome === 'error' || trace?.modelOutcome === 'timeout') return 'MODEL_ERROR';
    return 'SEND_FAILED';
  }
  if (replyOutcome === 'blocked') {
    if (status === 'stopped') return 'CIRCUIT_BLOCK';
    if (trace?.blockReason === 'tool_hook') return 'TOOL_HOOK_BLOCK';
    if (trace?.blockReason) return 'TEXT_ONLY_JUDGE';       // text_only_judge / narration_guard / other
    if (sends.seen > 0) return 'TOOL_HOOK_BLOCK';
    return 'POLICY_BLOCK';
  }
  if (replyOutcome === 'skipped') return 'PLAN_SKIPPED';
  if (replyOutcome === 'silent') return 'MODEL_SILENT';
  if (running) return 'RUNNING';
  if (status === 'aborted') return 'ABORTED';
  if (!trace) return 'NO_TRACE';
  if (!sent.known) return 'COUNT_UNKNOWN';
  return 'NO_TRACE';
}

/** 列表条目（旧 `#summary` 的 16 个字段逐字照搬 + S-2 的 `sentCount`/`finishReason` + P1-a 的三键 ⇒ 共 21）。 */
export function summaryOf(session) {
  const s = session ?? {};
  const outcomes = deriveOutcomes(s);
  const actions = Array.isArray(s.turnTrace?.actions) ? s.turnTrace.actions : [];
  // ★ S-2：列表要能报"发了几条" ⇒ 在**已经 parse 过的对象**上取数（零额外 I/O，registry 本来就 parse 过每条）。
  //   两个真源**都没有** ⇒ `null`，不是 `0`：`0` 是"查了，确实一条没发"（面板亮「未发送」+ 原因），
  //   `null` 是"没给数"（面板亮「发送数未给」）。把"没查过"演成 0 就是本票的原病。
  const fromList = Array.isArray(s.sent) ? s.sent.length : null;
  const fromReceipt = Number.isFinite(s.turnTrace?.receipt?.sentCount) ? s.turnTrace.receipt.sentCount : null;
  return {
    id: s.id,
    chatKey: s.chatKey,
    startedAt: s.startedAt,
    endedAt: s.endedAt ?? null,
    status: s.status,                      // waiting | running | done | noreply | error | aborted
    waitUntil: s.waitUntil ?? null,
    activity: s.activity ?? '',
    activityAt: s.activityAt ?? null,        // UI 用它显示"已等 N 秒"
    webSearchCount: s.webSearchCount ?? 0,
    outcome: s.outcome ?? null,            // { sent: n, finishReason }
    usage: s.usage ?? null,
    model: s.model ?? '',
    trigger: s.triggerSummary ?? '',
    promptChars: s.promptChars ?? 0,
    rounds: s.rounds ?? 0,
    turn: s.turnTrace ? {
      lane: s.turnTrace.lane ?? 'ambient',
      source: s.turnTrace.source ?? '',
      outcome: s.turnTrace.outcome ?? null,
      durationMs: s.turnTrace.durationMs ?? null,
      stageCount: Array.isArray(s.turnTrace.stages) ? s.turnTrace.stages.length : 0,
      actionCount: actions.length,
      failedCount: actions.filter((action) => action?.ok === false).length
    } : null,
    sentCount: fromList == null && fromReceipt == null ? null : Math.max(0, fromList ?? 0, fromReceipt ?? 0),
    // ★ S-2 后半（指挥位 15:4x 令）：列表要说得清"为什么没发" ⇒ 原因也进投影。
    //   只带 `finishReason`（真源短机器词，全量普查：盘上 9381 条有它，平均 25.7 字符 / 最长 110），**不带** `error`：
    //   全量 10,606 条里"面板判未发送"的 634 条 ⇒ 304 条有 finishReason、**0 条**只有 error ⇒
    //   多一个自由文本键只让响应体再涨 2.5%（+14.2% vs +11.4%）却一条原因都买不到（详见回执 / `probe-s2-reason.mjs --all`）。
    finishReason: s.finishReason ?? null,
    // ★ P1-a：面板要一眼回答"为什么没发"和"为什么没调工具" ⇒ 三键进列表投影，
    //   且**必须在算列表投影时就用完整对象算好**（盘上索引存的就是这份摘要 ⇒ 不抬版本新键永远是 null）。
    replyOutcome: outcomes.replyOutcome,
    replyReason: outcomes.replyReason,
    toolOutcome: outcomes.toolOutcome
  };
}

/**
 * ★ S-2c：索引条目**必须具备**的键 = `summaryOf()` 当前真会产出的键（**从 `summaryOf` 本身推导**，不是另抄一份清单）。
 *   抄一份清单就会重演本票的病：加了键只改清单、忘改校验，或者反过来。
 *   用途：`loadDiskIndex()` 的**形状闸** —— 条目缺任一必需键 ⇒ 整份索引判无效、拒绝、重建。
 *   `null` 值是合法的（`sentCount: null` = "没给数"）⇒ 闸只看**键在不在**（`k in entry`），不看真假。
 */
export const INDEX_SHAPE_KEYS = Object.keys(summaryOf({}));

/** "最后活动时间" = endedAt ?? startedAt（旧 `cleanup.js:194-197` 同源口径）。没有可用时间戳 ⇒ null。 */
export function lastActiveAt(summary) {
  const t = summary?.endedAt ?? summary?.startedAt;
  return Number.isFinite(t) ? t : null;
}

/**
 * 陈旧收尾（旧 :118-136）：磁盘上还写着 running/waiting，但早就该结束了。
 * @returns {boolean} 是否**改写过文件**（`readOnly:true` 时恒为 false）
 */
function settleStale(data, file, now, { readOnly }) {
  if (!data?.id || (data.status !== 'running' && data.status !== 'waiting')) return false;
  const started = Number(data.startedAt || 0);
  const wait = Number(data.waitUntil || 0);
  const STALE_MS = 15 * 60 * 1000;
  if (data.status === 'waiting' && wait && now - wait > 90 * 1000) {
    data.status = 'aborted';
    data.error = data.error || '等待启动超时（疑似定时器丢失），已自动收尾';
    data.endedAt = data.endedAt || now;
    data.waitUntil = null;
  } else if ((data.status === 'running' || !wait) && started && now - started > STALE_MS) {
    // ★ 2026-10-16 C8 复核：原条件 `!wait` 让 `running` + `waitUntil` 残留的行两个分支都不进、
    //   永远不被 settleStale 收尾。`waitUntil` 只对 `waiting` 有意义，`running` 的超时判据
    //   一律是 `startedAt`。保留 `!wait` 对 waiting 的语义（waitUntil 未到 90s 时不动）。
    data.status = 'error';
    data.error = '进程重启后仍停在运行中，已标为异常（疑似中断未收尾）';
    data.endedAt = data.endedAt || now;
  } else {
    return false;
  }
  if (readOnly) return false;      // ★ 只读快照：**只改内存副本，不落盘**
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
  return true;
}

/** 坏文件告警文案（旧 :147-154）：引号内片段一律抹掉（隐私），只留文件名 + 错误类型 + 去内容消息。 */
function badFileRecord(f, error) {
  const msg = String(error?.message ?? error).replace(/"[^"]*"/g, '"…"').replace(/'[^']*'/g, "'…'").slice(0, 160);
  let st = null;
  try { st = fs.statSync(f); } catch { /* file disappeared during scan */ }
  return { f: path.basename(f), errorName: error?.name ?? 'Error', msg,
    size: st?.size ?? null, mtimeMs: st?.mtimeMs ?? null };
}

/**
 * 建一个登记表实例（依赖全注入 —— 与旧树 `cleanup.js:21-23` 的纪律一致：
 * 本模块顶层只有 node: 内建 import ⇒ 测试能在 tmp 夹具上跑，**绝不碰生产 `data/**`**）。
 * @param {{dataDir?:string, now?:() => number, warn?:(msg:string) => void}} [options]
 */
function diskIndexFile(sessionsDir) {
  return path.join(path.dirname(sessionsDir), 'sessions-index.json');
}

function diskIndexBackupFile(file) { return `${file}.bak`; }
function diskIndexStaleFile(file) { return `${file}.stale`; }

// ── ★ S04（2026-10-19 ds3）：派生摘要索引的**有界追加日志** ─────────────────────────
//   病：旧写侧每落一条会话都 `writeDiskIndex()` —— 把**整份摘要数组**（与历史条数成正比）
//   重新 stringify + 原子写两次（`.bak` + 主文件）。历史越大，每次 append 越贵/越伤盘；
//   报告实测 1000 份历史时单次追加累计写约 793.6 KB。
//   设计（有界 + 可校验 + 向后兼容）：
//     · **小索引（< INDEX_JOURNAL_MIN_ENTRIES 条）继续走既有整份原子写** —— 体量有界，
//       行为、备份、`.stale` 标记与既有自测锚点全部不变（真实历史一般远大于这个门槛）。
//     · 大索引：每次写入只向 `<index>.journal.jsonl` **追加一行** `{v,id,summary}`；
//       加载时把日志按 id 覆盖到基索引上，再走原有的"名字集合增量对账"（新增/删除/形状闸都在）。
//     · 日志**满 INDEX_JOURNAL_MAX_LINES 行**（或显式 rebuild）⇒ 合并：整份写一次基索引并清日志
//       （摊销成本 = 每 512 次追加一次整份写，而不是每次都写）。合并先写基索引、成功后才删日志；
//       两者之间崩溃最多让日志被**重复应用一次**（按 id 覆盖 ⇒ 幂等）。
//     · 校验：日志行必须 `v`/`id`/完整 `INDEX_SHAPE_KEYS` 形状；**末尾半行**（崩溃截断）忽略；
//       中间坏行/超字节上限 ⇒ 整份日志不可信 ⇒ 返回 null 交给既有全量/重建路径（不猜）。
//     · `sentCount`/`unknown`/未回复筛选字段都在 `summaryOf()` 的 21 键里；日志行逐键校验 ⇒ 不丢字段。
const INDEX_JOURNAL_VERSION = 1;
/** 索引条目达到这个数才启用追加日志；小索引维持整份原子写（有界、可预期）。 */
const INDEX_JOURNAL_MIN_ENTRIES = 512;
/** 追加多少行后合并回基索引（摊销整份写的次数）。 */
const INDEX_JOURNAL_MAX_LINES = 512;
/** 日志读取上限（外部篡改/损坏时直接放弃日志，走全量路径）。 */
const INDEX_JOURNAL_MAX_BYTES = 4 * 1024 * 1024;

function diskIndexJournalFile(file) { return `${file}.journal.jsonl`; }

/**
 * 读日志并按 id 合并出"待覆盖的摘要"。只读、不做任何写入。
 * @returns {{ok:boolean, upserts?:Map<string,object>, present?:boolean, lines?:number, reason?:string}}
 */
function readIndexJournal(file) {
  const journalFile = diskIndexJournalFile(file);
  let text;
  try { text = fs.readFileSync(journalFile, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, upserts: new Map(), present: false, lines: 0 };
    return { ok: false, reason: 'journal-unreadable' };
  }
  if (text.length > INDEX_JOURNAL_MAX_BYTES) return { ok: false, reason: 'journal-too-large' };
  const upserts = new Map();
  const lines = text.split('\n');
  let validLines = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch {
      // 崩溃时最后一行可能只写了一半 ⇒ 只有"后面还有非空行"才判整份日志损坏。
      if (lines.slice(i + 1).some((rest) => rest.trim())) return { ok: false, reason: 'journal-malformed-middle' };
      break;
    }
    if (!row || row.v !== INDEX_JOURNAL_VERSION || !SESSION_ID_RE.test(String(row.id ?? ''))) {
      return { ok: false, reason: 'journal-malformed-row' };
    }
    if (row.removed === true) { upserts.delete(row.id); validLines += 1; continue; }
    const summary = row.summary;
    if (!summary || typeof summary !== 'object' || summary.id !== row.id) {
      return { ok: false, reason: 'journal-summary-invalid' };
    }
    for (const key of INDEX_SHAPE_KEYS) {
      if (!(key in summary)) return { ok: false, reason: 'journal-shape-old' };
    }
    upserts.set(row.id, summary);
    validLines += 1;
    if (upserts.size > 4096) return { ok: false, reason: 'journal-too-many-entries' };
  }
  return { ok: true, upserts, present: true, lines: validLines };
}

/** 把日志覆盖到基索引条目上（同 id 覆盖；被覆盖的文件从 bad/noId 名单里摘掉）。 */
function mergeJournalIntoIndex(raw, upserts) {
  if (!upserts || !upserts.size) return raw;
  const byId = new Map();
  for (const entry of Array.isArray(raw?.entries) ? raw.entries : []) {
    if (entry && typeof entry.id === 'string' && entry.id) byId.set(entry.id, entry);
  }
  for (const [id, summary] of upserts) byId.set(id, summary);
  const upsertFiles = new Set([...upserts.keys()].map((id) => `${id}.json`));
  return {
    ...raw,
    entries: [...byId.values()],
    bad: (Array.isArray(raw?.bad) ? raw.bad : []).filter((b) => !upsertFiles.has(b?.f)),
    noIdFiles: (Array.isArray(raw?.noIdFiles) ? raw.noIdFiles : []).filter((f) => !upsertFiles.has(f))
  };
}

function diskIndexIsStale(file) {
  try { return JSON.parse(fs.readFileSync(diskIndexStaleFile(file), 'utf8')).stale === true; }
  catch { return fs.existsSync(diskIndexStaleFile(file)); }
}

function loadDiskIndex(file, fp, keepFiles) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!raw || raw.v !== DISK_INDEX_VERSION || raw.keepFiles !== keepFiles ||
        raw.fileCount !== fp.count || raw.dirMtimeMs !== fp.mtimeMs ||
        !Array.isArray(raw.entries) || !Array.isArray(raw.bad)) return null;
    const noId = Number(raw.noId) || 0;
    const expected = fp.count;
    if (raw.entries.length + raw.bad.length + noId !== expected) return null;
    const noIdFiles = Array.isArray(raw.noIdFiles) ? raw.noIdFiles : (noId === 0 ? [] : null);
    if (!noIdFiles || noIdFiles.length !== noId) return null;
    const names = fs.readdirSync(path.join(path.dirname(file), 'sessions')).filter((n) => n.endsWith('.json'));
    if (names.length !== fp.count) return null;
    const present = new Set(names);
    const seen = new Set();
    if (raw.entries.some((e) => {
      if (!e || typeof e.id !== 'string' || !e.id || seen.has(e.id)) return true;
      // ★ S-2c 形状闸（2026-10-07）：条目缺 `summaryOf` 当前会产出的**任一**键 ⇒ 这份索引是**旧形状**，
      //   整份判无效、拒绝、重建。为什么要它：`v` 只挡"有人记得抬版本"，而 `finishReason` 那一次**没人抬**
      //   （v 仍是 2 ⇒ 校验通过 ⇒ 不重扫 ⇒ 盘上 10,609 条只有 1 条真带 `finishReason`、值全是 null）。
      //   只看**键在不在**：`sentCount: null` / `finishReason: null` 是合法答案（"没给数"/"没记原因"），不是缺键。
      for (const k of INDEX_SHAPE_KEYS) if (!(k in e)) return true;
      const filename = `${e.id}.json`;
      if (path.basename(filename) !== filename || !present.has(filename)) return true;
      seen.add(e.id); return false;
    })) return null;
    const badNames = new Set();
    for (const b of raw.bad) {
      if (!b || typeof b.f !== 'string' || path.basename(b.f) !== b.f || !b.f.endsWith('.json') ||
          !present.has(b.f) || badNames.has(b.f) || seen.has(b.f.slice(0, -5)) ||
          !Number.isFinite(b.size) || !Number.isFinite(b.mtimeMs)) return null;
      badNames.add(b.f);
      const st = fs.statSync(path.join(path.dirname(file), 'sessions', b.f));
      if (st.size !== b.size || st.mtimeMs !== b.mtimeMs) return null;
      try { readJsonLoose(path.join(path.dirname(file), 'sessions', b.f)); return null; }
      catch { /* still malformed, as recorded */ }
    }
    for (const f of noIdFiles) {
      if (typeof f !== 'string' || path.basename(f) !== f || !f.endsWith('.json') ||
          !present.has(f) || badNames.has(f) || seen.has(f.slice(0, -5))) return null;
      badNames.add(f);
      try {
        const data = readJsonLoose(path.join(path.dirname(file), 'sessions', f));
        if (data?.id) return null;
      } catch { return null; }
    }
    if (seen.size + badNames.size !== fp.count) return null;
    return { entries: raw.entries, bad: raw.bad, noId, noIdFiles };
  } catch { return null; }
}

/**
 * ★ A40（2026-10-08）：**"索引过期"不等于"全量扫盘"** —— 名字集合增量。
 *
 * 病根（U8 探针实测，真实盘 10882 个 json / 937MB）：
 *   `loadDiskIndex()` 的严格校验里有 `raw.fileCount !== fp.count || raw.dirMtimeMs !== fp.mtimeMs`
 *   ⇒ **只要会话目录动一下（新增/删除一个会话就是一次）**，整份索引立刻作废
 *   ⇒ 冷读退化成 `scan()` 的全量 `readJsonLoose` 循环 ⇒ **实测 6852ms / 14348ms**
 *   （`indexLoad.mode = 'full'`）。而索引新鲜时是十几毫秒 ⇒ **同一台机器快慢差 500 倍**。
 *
 * 这里做的事（只读，不写任何文件）：
 *   1. `readdir` 拿当前文件名集合（实测 5ms）；
 *   2. **旧条目原样复用** —— 它的文件还在、形状过关，就不重读（重读 10882 个文件就是那十几秒）；
 *   3. **只读新增的那几个**（目录里有、索引里没有的）—— 这正是主人关心的"刚新增的会话不丢"；
 *   4. 文件没了的条目丢掉；
 *   5. **形状不过关的条目照样重读**（S-2c 那道形状闸在这里不能被绕过：
 *      旧形状条目若被原样复用，`finishReason` 缺失就会重新混进来）。
 *
 * ★ 诚实口径（架构要求：不许假装是最新的）：**同名文件的"原地改写"本轮不验**
 *   —— 原地改写既不改目录 mtime 也不改条目数，便宜门看不见（模块头注释 §"仍然存在的盲区"已登记）。
 *   所以返回里带 `staleSameNamed` 与一句 `note`，由 `diagnostics.lastIndexLoad` 如实透出。
 *   本进程自己写会话时会同步索引（S04 起大索引是"基索引 + 追加日志"）⇒ 那种原地改写是**看得见的**，
 *   看不见的只有"另一个进程原地改"这一种。
 *
 * ★ S04（2026-10-19 ds3）：先读**追加日志**并按 id 覆盖到基索引条目上，再走同一套对账。
 *   日志缺失/不合法 ⇒ 返回 null 交给上层（全量/重建），绝不猜、不静默丢条目。
 */
function loadJournalAwareDiskIndex(file, fp, keepFiles, sessionsDir, warn) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    // ★ A40：版本必须**严格**匹配（`v === DISK_INDEX_VERSION`）。
    //   实测（本机）：盘上那份是 `v: 1`，缺 `finishReason`/`replyOutcome`/`replyReason`/`toolOutcome`
    //   （S-2c 与 P1-a 加的键）⇒ 拿它当底子会把这些行显示成错的（面板据此判"未发送"）。
    //   所以**旧版本索引不做增量底子** —— 逐条形状闸（`INDEX_SHAPE_KEYS`）也会把它们全判掉、导致全量重读
    //   （实测 shapeFixed=10882 ⇒ 7157ms，比全量扫还慢）。老索引的正解是让写侧把它重写成当前版本。
    //   本路径治的是**另一个也更常犯**的病：索引**版本是对的**、只是指纹过期（新增一个会话就会失配）。
    if (!raw || raw.v !== DISK_INDEX_VERSION || raw.keepFiles !== keepFiles ||
        !Array.isArray(raw.entries) || !Array.isArray(raw.bad)) return null;
    const journal = readIndexJournal(file);
    if (!journal.ok) return null;
    if (!journal.present || !journal.upserts.size) return reconcileDiskIndexEntries(raw, sessionsDir, warn);
    const merged = mergeJournalIntoIndex(raw, journal.upserts);
    const result = reconcileDiskIndexEntries(merged, sessionsDir, warn);
    if (result) {
      result.incremental = {
        ...(result.incremental ?? {}),
        journal: { version: INDEX_JOURNAL_VERSION, lines: journal.lines, upserts: journal.upserts.size }
      };
    }
    return result;
  } catch { return null; }
}

function reconcileDiskIndexEntries(raw, sessionsDir, warn = () => {}) {
  try {
    let names = [];
    try { names = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')); } catch { return null; }
    const present = new Set(names);
    const covered = new Set();                       // 索引已经盖住的文件名

    // ── 复用旧条目（存在 + 形状过关 + id 不重复）──
    const reused = [];
    const seenIds = new Set();
    let shapeFixed = 0;
    for (const e of raw.entries) {
      if (!e || typeof e.id !== 'string' || !e.id) { shapeFixed += 1; continue; }
      const filename = `${e.id}.json`;
      if (path.basename(filename) !== filename) { shapeFixed += 1; continue; }
      if (seenIds.has(e.id)) { shapeFixed += 1; continue; }     // 重复 id：丢一份，另一份照走重读
      if (!present.has(filename)) continue;                       // 文件没了 ⇒ 丢
      seenIds.add(e.id);
      covered.add(filename);
      let shaped = true;
      for (const k of INDEX_SHAPE_KEYS) if (!(k in e)) { shaped = false; break; }
      if (!shaped) {
        // 形状旧的：**不信任**，把它的文件挪进"要重读"那一份（下面统一处理）
        covered.delete(filename);
        shapeFixed += 1;
        continue;
      }
      reused.push(e);
    }
    // bad / noIdFiles 也是索引盖住的文件（它们各自带校验信息，沿用严格路径那套核对）
    const bad = [];
    const badSeen = new Set();
    for (const b of raw.bad) {
      if (!b || typeof b.f !== 'string' || path.basename(b.f) !== b.f || !b.f.endsWith('.json') ||
          !present.has(b.f) || badSeen.has(b.f) || seenIds.has(b.f.slice(0, -5)) ||
          !Number.isFinite(b.size) || !Number.isFinite(b.mtimeMs)) { shapeFixed += 1; continue; }
      badSeen.add(b.f);
      covered.add(b.f);
      try {
        const st = fs.statSync(path.join(sessionsDir, b.f));
        if (st.size === b.size && st.mtimeMs === b.mtimeMs) bad.push(b);   // 形状与内容都没变 ⇒ 沿用
        else shapeFixed += 1;                                               // 变了 ⇒ 交给下面重读
      } catch { shapeFixed += 1; }
    }
    const noIdFiles = [];
    for (const f of (Array.isArray(raw.noIdFiles) ? raw.noIdFiles : [])) {
      if (typeof f !== 'string' || path.basename(f) !== f || !f.endsWith('.json') ||
          !present.has(f) || badSeen.has(f) || seenIds.has(f.slice(0, -5))) { shapeFixed += 1; continue; }
      covered.add(f);
      noIdFiles.push(f);
    }

    // ── 只重读"没被盖住"的那些 = 新增的 + 上面判定要重读的 ──
    const toRead = names.filter((n) => !covered.has(n));
    const added = [];
    const rereadBad = [];
    const rereadNoId = [];
    for (const f of toRead) {
      const full = path.join(sessionsDir, f);
      try {
        const data = readJsonLoose(full);
        if (data?.id) added.push(summaryOf(data));
        else rereadNoId.push(f);
      } catch (error) {
        const rec = badFileRecord(full, error);
        rereadBad.push(rec);
        warn(`[sessions] 跳过无法解析的会话文件 ${f}：${rec.errorName} ${rec.msg}`);
      }
    }

    const entries = [...reused, ...added];
    // 目录里 .json 的总数必须被"复用 + 新增 + 坏文件 + 无 id"正好瓜分完，否则这份目录读不干净 ⇒ 交回全量。
    if (entries.length + rereadBad.length + rereadNoId.length !== names.length) return null;
    // 顺序约定：新的在前（与全量扫的 sort().reverse() 同向 ⇒ 面板第一屏看到的是最新会话）
    entries.sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0));
    return {
      entries,
      bad: [...bad, ...rereadBad],
      noId: rereadNoId.length,
      noIdFiles: rereadNoId,
      incremental: {
        reused: reused.length,
        added: added.length,
        reread: rereadBad.length + rereadNoId.length,
        dropped: (Array.isArray(raw.entries) ? raw.entries.length : 0) - reused.length,
        shapeFixed,
        staleSameNamed: reused.length,
        note: '同名文件的原地改写本轮未验（只验了增/删）；本进程自己的写会同步索引，看不见的只有别的进程原地改'
      }
    };
  } catch { return null; }
}

function loadAvailableDiskIndex(file, fp, keepFiles, sessionsDir, { incremental = false, warn } = {}) {
  const staleMarked = diskIndexIsStale(file);
  // 双写也失败时，备份只能作为旧副本留存，不能再拿它的增量底子冒充最新；正确性优先退回完整重建。
  if (incremental && staleMarked) {
    const backup = loadDiskIndex(diskIndexBackupFile(file), fp, keepFiles);
    return backup ? { ...backup, source: 'backup' } : null;
  }
  // ★ S04：增量路径先走"基索引 + 追加日志"（日志不存在时 = 原增量），
  //   日志损坏/版本不符 ⇒ 两者的结论都是 null ⇒ 继续退到全量/重建（不猜、不静默丢条目）。
  const candidates = staleMarked
    ? [diskIndexBackupFile(file)]
    : [file, diskIndexBackupFile(file)];
  for (const candidate of candidates) {
    const disk = incremental
      ? loadJournalAwareDiskIndex(candidate, fp, keepFiles, sessionsDir, warn)
      : loadDiskIndex(candidate, fp, keepFiles);
    if (disk) return { ...disk, source: candidate === file ? 'primary' : 'backup' };
  }
  return null;
}

function writeDiskIndex(file, hit, keepFiles) {
  const fp = hit.fp;
  if (!fp || !Number.isInteger(fp.count) || fp.count < 0 || !Number.isFinite(fp.mtimeMs)) return false;
  const bad = hit.diagnostics.bad;
  const noId = hit.diagnostics.noId;
  const expected = fp.count;
  if (hit.summaries.length + bad.length + noId !== expected) return false;
  const noIdFiles = hit.diagnostics.noIdFiles ?? [];
  if (noIdFiles.length !== noId) return false;
  const payload = { v: DISK_INDEX_VERSION, keepFiles, fileCount: fp.count,
    dirMtimeMs: fp.mtimeMs, noId, noIdFiles, bad, entries: hit.summaries };
  let backupOk = false;
  try { writeJsonAtomic(diskIndexBackupFile(file), payload); backupOk = true; } catch { /* 主索引仍会单独尝试 */ }
  try {
    writeJsonAtomic(file, payload);
    try {
      writeJsonAtomic(diskIndexStaleFile(file), { stale: false });
      fs.rmSync(diskIndexStaleFile(file), { force: true });
    } catch { /* 主索引有效；标记清理失败不影响当前索引 */ }
    return { ok: true, primaryOk: true, backupOk };
  } catch {
    try { writeJsonAtomic(diskIndexStaleFile(file), { stale: true, source: backupOk ? 'backup' : 'unknown' }); }
    catch { /* 仍保留原文件；当前进程会在 diagnostics 标记陈旧 */ }
    return { ok: backupOk, primaryOk: false, backupOk };
  }
}

function invalidateDiskIndex(file) {
  // ★ S04：日志一并清掉 —— 基索引都判废了，日志里的增量没有可覆盖的底子（留着只会成孤儿）。
  let ok = true;
  for (const target of [file, diskIndexBackupFile(file), diskIndexStaleFile(file), diskIndexJournalFile(file)]) {
    try { fs.unlinkSync(target); }
    catch (error) { if (error?.code !== 'ENOENT') ok = false; }
  }
  return ok;
}

export function createSessionRegistry(options = {}) {
  const sessionsDir = resolveSessionsDir(options?.dataDir);
  const dataDir = path.dirname(sessionsDir);
  const contextCheckpointDir = path.join(sessionsDir, 'context-checkpoints');
  const contextCompressionProgressDir = path.join(sessionsDir, 'context-compression-progress');
  const now = typeof options?.now === 'function' ? options.now : () => Date.now();
  const warn = typeof options?.warn === 'function' ? options.warn : (msg) => process.stderr.write(`${msg}\n`);
  /** 运行中会话（写侧接的就是它）。cleanup 用 `isLive()` 做"running 豁免"。 */
  const current = new Map();
  runtimeCurrentSessions = current;
  /** 节流时间戳（旧 :601-608 的 `_lastPersistAt`）。 */
  const lastPersistAt = new Map();
  /** `keepFiles > 0` 时 finish 会修剪超出份数的旧文件（旧 :385-405）。0 = 不限制（旧 :49-51 的语义）。 */
  const keepFiles = Math.max(0, Number.isFinite(Number(options?.keepFiles)) ? Math.round(Number(options.keepFiles)) : 0);
  /** 用量台账联动（旧 :642 的 `getUsageLedger().upsertFromSession`）：注入式，不注入就不联动。 */
  const ledger = options?.ledger ?? null;
  /** strict：写失败直接抛（默认 false ⇒ 返回 `{ok:false,error}`，绝不静默假装成功）。 */
  const strict = options?.strict === true;
  /** 缓存与 TTL 用的时钟（**可注入** ⇒ 自测能推进时间，不必真睡 6 秒）。 */
  const clock = typeof options?.clock === 'function' ? options.clock : () => Date.now();
  const indexFile = diskIndexFile(sessionsDir);
  const diagnostics = {
    lastIndexLoad: null, bad: [], noId: 0, noIdFiles: [], dirReadable: null, dirError: null,
    lastPersistError: null, lastIndexPersist: null, lastIndexPersistError: null, writes: 0, throttledSkips: 0,
    cachePatches: 0, cachePatchErrors: 0, badEntries: 0, cachePatchedAt: null
  };
  const contextCheckpointStats = {
    reads: 0, writes: 0, coldRebuilds: 0, hotHits: 0, sourceRowsRead: 0,
    pairRewindCount: 0, orphanCallIds: 0, orphanResultIds: 0,
    reasons: Object.create(null), last: null
  };

  function noteContextCheckpoint({ operation, action = '', reasonCode, namespaceHash = '', sourceCursorHash = '', sourceRevision = null, contextHash = '',
    sourceRowsRead = null, pairRewindCount = null, orphanCallIds = null, orphanResultIds = null }) {
    if (operation === 'read') contextCheckpointStats.reads += 1;
    if (operation === 'write') contextCheckpointStats.writes += 1;
    if ((operation === 'outcome' || operation === 'rebuild') && action === 'cold-rebuild') contextCheckpointStats.coldRebuilds += 1;
    if (operation === 'outcome' && action === 'hot-hit') contextCheckpointStats.hotHits += 1;
    if (Number.isSafeInteger(sourceRowsRead) && sourceRowsRead >= 0) contextCheckpointStats.sourceRowsRead += sourceRowsRead;
    if (Number.isSafeInteger(pairRewindCount) && pairRewindCount >= 0) contextCheckpointStats.pairRewindCount += pairRewindCount;
    if (Number.isSafeInteger(orphanCallIds) && orphanCallIds >= 0) contextCheckpointStats.orphanCallIds += orphanCallIds;
    if (Number.isSafeInteger(orphanResultIds) && orphanResultIds >= 0) contextCheckpointStats.orphanResultIds += orphanResultIds;
    const reason = String(reasonCode ?? 'checkpoint-reason-unknown');
    contextCheckpointStats.reasons[reason] = (contextCheckpointStats.reasons[reason] ?? 0) + 1;
    contextCheckpointStats.last = {
      operation: String(operation ?? ''), action: String(action ?? ''), reasonCode: reason,
      ...(CONTEXT_CHECKPOINT_HASH_RE.test(String(namespaceHash ?? '')) ? { namespaceHash: String(namespaceHash) } : {}),
      ...(CONTEXT_CHECKPOINT_HASH_RE.test(String(sourceCursorHash ?? '')) ? { sourceCursorHash: String(sourceCursorHash) } : {}),
      ...(Number.isSafeInteger(sourceRevision) ? { sourceRevision } : {}),
      ...(CONTEXT_CHECKPOINT_HASH_RE.test(String(contextHash ?? '')) ? { contextHash: String(contextHash) } : {}),
      ...(Number.isSafeInteger(sourceRowsRead) && sourceRowsRead >= 0 ? { sourceRowsRead } : {}),
      ...(Number.isSafeInteger(pairRewindCount) && pairRewindCount >= 0 ? { pairRewindCount } : {}),
      ...(Number.isSafeInteger(orphanCallIds) && orphanCallIds >= 0 ? { orphanCallIds } : {}),
      ...(Number.isSafeInteger(orphanResultIds) && orphanResultIds >= 0 ? { orphanResultIds } : {})
    };
  }

  function contextCheckpointDiagnostics() {
    return {
      reads: contextCheckpointStats.reads,
      writes: contextCheckpointStats.writes,
      coldRebuilds: contextCheckpointStats.coldRebuilds,
      hotHits: contextCheckpointStats.hotHits,
      sourceRowsRead: contextCheckpointStats.sourceRowsRead,
      pairRewindCount: contextCheckpointStats.pairRewindCount,
      orphanCallIds: contextCheckpointStats.orphanCallIds,
      orphanResultIds: contextCheckpointStats.orphanResultIds,
      reasons: Object.fromEntries(Object.entries(contextCheckpointStats.reasons)),
      last: contextCheckpointStats.last ? { ...contextCheckpointStats.last } : null
    };
  }

  function writeContextCheckpoint(input = {}) {
    const namespaceHash = contextNamespaceHash(input.namespace);
    if (!namespaceHash) return { ok: false, reasonCode: 'checkpoint-namespace-invalid' };
    const sourceCursor = safeJsonClone(input.sourceCursor);
    if (!stableContextCursor(sourceCursor)) return { ok: false, reasonCode: 'checkpoint-cursor-unverifiable' };
    const sourceRevision = input.sourceRevision;
    if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) {
      return { ok: false, reasonCode: 'checkpoint-source-revision-unavailable' };
    }
    const sourceTotal = input.sourceTotal;
    if (!Number.isSafeInteger(sourceTotal) || sourceTotal < 0) {
      return { ok: false, reasonCode: 'checkpoint-source-total-unavailable' };
    }
    const contextSegments = safeJsonClone(input.contextSegments);
    if (!Array.isArray(contextSegments)) return { ok: false, reasonCode: 'checkpoint-context-invalid' };
    const contextHash = contextCheckpointHash(contextSegments);
    const suppliedContextHash = String(input.contextHash ?? '').trim();
    if (suppliedContextHash && suppliedContextHash !== contextHash) {
      return { ok: false, reasonCode: 'checkpoint-context-hash-mismatch' };
    }
    const permissionFingerprint = checkpointFingerprint(input, 'permissionFingerprint', 'permissions');
    if (!permissionFingerprint) return { ok: false, reasonCode: 'checkpoint-permission-fingerprint-unavailable' };
    const toolSchemaFingerprint = checkpointFingerprint(input, 'toolSchemaFingerprint', 'toolSchema');
    if (!toolSchemaFingerprint) return { ok: false, reasonCode: 'checkpoint-tool-schema-fingerprint-unavailable' };
    if (input.toolPairState !== 'none' || containsToolPairMessages(contextSegments)) {
      return { ok: false, reasonCode: 'checkpoint-tool-pair-not-reconstructable' };
    }

    const checkpoint = {
      schemaVersion: CONTEXT_CHECKPOINT_VERSION,
      namespaceHash,
      sourceCursor,
      sourceCursorHash: contextCheckpointHash(sourceCursor),
      sourceRevision,
      sourceTotal,
      contextHash,
      permissionFingerprint,
      toolSchemaFingerprint,
      toolPairState: 'none',
      contextSegments
    };
    const invalid = contextCheckpointRecordError(checkpoint, namespaceHash);
    if (invalid) return { ok: false, reasonCode: invalid };

    const target = path.join(contextCheckpointDir, `${namespaceHash}.json`);
    try {
      fs.mkdirSync(contextCheckpointDir, { recursive: true });
      writeJsonAtomic(target, checkpoint);
    } catch {
      noteContextCheckpoint({ operation: 'write', reasonCode: 'checkpoint-write-failed', namespaceHash,
        sourceCursorHash: checkpoint.sourceCursorHash, sourceRevision, contextHash });
      return { ok: false, reasonCode: 'checkpoint-write-failed' };
    }
    noteContextCheckpoint({ operation: 'write', reasonCode: 'checkpoint-written', namespaceHash,
      sourceCursorHash: checkpoint.sourceCursorHash, sourceRevision, contextHash });
    return {
      ok: true, schemaVersion: checkpoint.schemaVersion, namespaceHash,
      sourceCursorHash: checkpoint.sourceCursorHash, sourceRevision,
      sourceTotal, contextHash, contextSegmentCount: contextSegments.length
    };
  }

  function readContextCompressionProgress(namespace) {
    const namespaceHash = contextNamespaceHash(namespace);
    if (!namespaceHash) return { ok: false, reasonCode: 'compression-progress-namespace-invalid' };
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(contextCompressionProgressDir, `${namespaceHash}.json`), 'utf8'));
    } catch (error) {
      const reasonCode = error?.code === 'ENOENT' ? 'compression-progress-missing'
        : error instanceof SyntaxError ? 'compression-progress-malformed' : 'compression-progress-read-failed';
      return { ok: false, reasonCode };
    }
    const revision = record?.compactionCursor?.sourceRevision;
    const cursorHash = contextCheckpointHash({ sourceRevision: revision });
    if (record?.schemaVersion !== CONTEXT_COMPRESSION_PROGRESS_VERSION
      || record?.namespaceHash !== namespaceHash
      || !Number.isSafeInteger(revision) || revision < 0
      || record?.compactionCursorHash !== cursorHash
      || !CONTEXT_CHECKPOINT_HASH_RE.test(String(record?.contextHash ?? ''))
      || !Number.isSafeInteger(record?.promptMessageCount) || record.promptMessageCount < 0
      || !Number.isSafeInteger(record?.historyMessageCount) || record.historyMessageCount < 0
      || !Number.isSafeInteger(record?.coldMessageCount) || record.coldMessageCount < 0
      || !Number.isSafeInteger(record?.warmMessageCount) || record.warmMessageCount < 0
      || !Number.isFinite(record?.completedAt) || record.completedAt < 0) {
      return { ok: false, reasonCode: 'compression-progress-invalid' };
    }
    return { ok: true, progress: structuredClone(record) };
  }

  function writeContextCompressionProgress(input = {}) {
    const namespaceHash = contextNamespaceHash(input.namespace);
    if (!namespaceHash) return { ok: false, reasonCode: 'compression-progress-namespace-invalid' };
    const sourceRevision = input.sourceRevision;
    if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0) {
      return { ok: false, reasonCode: 'compression-progress-cursor-invalid' };
    }
    const contextHash = String(input.contextHash ?? '').trim();
    if (!CONTEXT_CHECKPOINT_HASH_RE.test(contextHash)) {
      return { ok: false, reasonCode: 'compression-progress-context-hash-invalid' };
    }
    const count = (value, fallback = 0) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
    const record = {
      schemaVersion: CONTEXT_COMPRESSION_PROGRESS_VERSION,
      namespaceHash,
      compactionCursor: { sourceRevision },
      compactionCursorHash: contextCheckpointHash({ sourceRevision }),
      contextHash,
      promptMessageCount: count(input.promptMessageCount, -1),
      historyMessageCount: count(input.historyMessageCount, -1),
      coldMessageCount: count(input.coldMessageCount, -1),
      warmMessageCount: count(input.warmMessageCount, -1),
      completedAt: Number.isFinite(Number(input.completedAt)) && Number(input.completedAt) >= 0
        ? Number(input.completedAt) : now()
    };
    if (Object.values(record).some((value) => value === -1)) {
      return { ok: false, reasonCode: 'compression-progress-count-invalid' };
    }
    const existing = readContextCompressionProgress(input.namespace);
    if (existing.ok && existing.progress.compactionCursor.sourceRevision > sourceRevision) {
      return { ok: false, reasonCode: 'compression-progress-regressed' };
    }
    try {
      fs.mkdirSync(contextCompressionProgressDir, { recursive: true });
      writeJsonAtomic(path.join(contextCompressionProgressDir, `${namespaceHash}.json`), record);
    } catch {
      return { ok: false, reasonCode: 'compression-progress-write-failed' };
    }
    return {
      ok: true, schemaVersion: record.schemaVersion, namespaceHash,
      sourceRevision, compactionCursorHash: record.compactionCursorHash, contextHash,
      promptMessageCount: record.promptMessageCount, historyMessageCount: record.historyMessageCount,
      coldMessageCount: record.coldMessageCount, warmMessageCount: record.warmMessageCount,
      completedAt: record.completedAt
    };
  }

  const startupFp = dirFingerprintCheap(sessionsDir);
  const startupDisk = startupFp.count >= 0
    ? loadAvailableDiskIndex(indexFile, startupFp, keepFiles, sessionsDir, { warn })
    : null;
  let startupDiskPending = !!startupDisk;
  let durableHit = startupDisk ? {
    fp: startupFp, summaries: startupDisk.entries,
    diagnostics: { bad: startupDisk.bad, noId: startupDisk.noId, noIdFiles: startupDisk.noIdFiles }
  } : null;
  /** ★ S04：本实例自上次合并以来追加了多少行日志（只作合并触发计数，不代表盘上真实行数）。 */
  let journalAppends = 0;
  /** 合并失败后的退避时间戳：避免每次追加都重试整份写（外部并发写导致计数对不上时尤其重要）。 */
  let journalCompactBlockedUntil = 0;

  /** 清掉追加日志（整份写/合并成功后调用；删除失败只留冗余行，按 id 覆盖 ⇒ 不影响正确性）。 */
  function clearIndexJournal() {
    try { fs.rmSync(diskIndexJournalFile(indexFile), { force: true }); return true; }
    catch (error) {
      warn(`[sessions] 摘要索引日志清理失败（冗余行按 id 覆盖，不影响正确性）：${error?.name ?? 'Error'}`);
      return false;
    }
  }

  /** 是否走"追加日志"路径：**只有索引够大才启用**，小索引维持整份原子写（体量有界、行为不变）。 */
  function indexUsesJournal(hit) {
    return (hit?.summaries?.length ?? 0) >= INDEX_JOURNAL_MIN_ENTRIES;
  }

  /**
   * 追加一行摘要（O(1)，不重写整份索引）。返回 false 由调用方退回整份写 —— 失败可见，不静默丢。
   */
  function appendIndexJournal(summary) {
    if (!summary?.id) return false;
    // 没有基索引可覆盖时不能只用日志（日志只带增量）⇒ 退回整份写，先把基索引建出来。
    if (!fs.existsSync(indexFile)) return false;
    try {
      fs.appendFileSync(diskIndexJournalFile(indexFile),
        `${JSON.stringify({ v: INDEX_JOURNAL_VERSION, id: summary.id, summary })}\n`, 'utf8');
      journalAppends += 1;
      diagnostics.lastIndexPersist = { mode: 'journal-append', stale: false, appendsSinceCompact: journalAppends };
      diagnostics.lastIndexPersistError = null;
      if (journalAppends >= INDEX_JOURNAL_MAX_LINES && Date.now() >= journalCompactBlockedUntil) maybeCompactIndexJournal();
      return true;
    } catch (error) {
      diagnostics.lastIndexPersistError = `sessions-index-journal-append-failed:${String(error?.code || error?.name || 'Error')}`;
      return false;
    }
  }

  /** 把日志合并回基索引（整份原子写 + `.bak`），成功后才清日志；崩溃最多让日志被重复应用一次（幂等）。 */
  function maybeCompactIndexJournal(force = false) {
    if (!force && journalAppends < INDEX_JOURNAL_MAX_LINES) return false;
    const hit = readOnlyScanCache.get(sessionsDir) ?? durableHit;
    if (!hit) return false;
    try { hit.fp = dirFingerprintCheap(sessionsDir); } catch { return false; }
    const result = writeDiskIndex(indexFile, hit, keepFiles);
    if (result.ok) {
      durableHit = hit;
      clearIndexJournal();
      journalAppends = 0;
      journalCompactBlockedUntil = 0;
      diagnostics.lastIndexPersist = { mode: 'journal-compact', stale: !result.primaryOk, backupOk: result.backupOk };
      diagnostics.lastIndexPersistError = result.primaryOk ? null : 'sessions-index-primary-write-failed; backup-retained';
      return true;
    }
    // 合并失败：日志与上一份索引都保留（读侧继续用"基索引+日志"），并沿用既有陈旧标记语义。
    journalCompactBlockedUntil = Date.now() + 60 * 1000;   // 退避：失败后 60s 内不再尝试整份写
    try { writeJsonAtomic(diskIndexStaleFile(indexFile), { stale: true, source: 'unknown' }); }
    catch { /* 若连标记也不可写，至少保留旧索引并在当前实例诊断中标陈旧 */ }
    diagnostics.lastIndexPersist = { mode: 'journal-compact-failed', stale: true };
    diagnostics.lastIndexPersistError = 'sessions-index-compaction-failed; journal-retained';
    warn('[sessions] 摘要索引日志合并失败，保留日志与上一份索引');
    return false;
  }

  /** 写后提交索引：大索引只追加一行；小索引/无基索引/追加失败 ⇒ 退回既有整份原子写。 */
  function persistIndexAfterWrite(summary) {
    const hit = readOnlyScanCache.get(sessionsDir) ?? durableHit;
    if (!hit || !indexUsesJournal(hit)) return persistDurableIndex();
    if (appendIndexJournal(summary)) return true;
    return persistDurableIndex();
  }

  /**
   * 删除类变更（trim/discard）后的索引提交：日志只有追加语义，删除由读侧"名字集合对账"覆盖
   * （文件没了 ⇒ 条目丢掉）⇒ 大索引下不写整份、也不追加日志；小索引维持既有整份写。
   */
  function persistIndexAfterDelete() {
    const hit = readOnlyScanCache.get(sessionsDir) ?? durableHit;
    if (hit && indexUsesJournal(hit)) {
      diagnostics.lastIndexPersist = { mode: 'journal-delete-deferred', stale: false };
      diagnostics.lastIndexPersistError = null;
      return true;
    }
    return persistDurableIndex();
  }

  function persistDurableIndex() {
    const hit = readOnlyScanCache.get(sessionsDir);
    if (hit) {
      durableHit = hit;
      const result = writeDiskIndex(indexFile, hit, keepFiles);
      if (result.ok) {
        clearIndexJournal();                       // ★ S04：整份写把日志里的增量也落进来了
        journalAppends = 0;
        diagnostics.lastIndexPersist = { mode: result.primaryOk ? 'primary' : 'backup-only', stale: !result.primaryOk };
        diagnostics.lastIndexPersistError = result.primaryOk ? null : 'sessions-index-primary-write-failed; backup-retained';
        return true;
      }
    } else if (durableHit) {
      durableHit.fp = dirFingerprintCheap(sessionsDir);
      const result = writeDiskIndex(indexFile, durableHit, keepFiles);
      if (result.ok) {
        clearIndexJournal();
        journalAppends = 0;
        diagnostics.lastIndexPersist = { mode: result.primaryOk ? 'primary' : 'backup-only', stale: !result.primaryOk };
        diagnostics.lastIndexPersistError = result.primaryOk ? null : 'sessions-index-primary-write-failed; backup-retained';
        return true;
      }
    }
    // 写索引失败时保留盘上最后一份可用版本；删掉它会让下次 `/api/sessions` 冷读全量扫盘。
    try { writeJsonAtomic(diskIndexStaleFile(indexFile), { stale: true, source: 'unknown' }); }
    catch { /* 若连标记也不可写，至少保留旧索引并在当前实例诊断中标陈旧 */ }
    diagnostics.lastIndexPersist = { mode: 'retained-previous', stale: true };
    diagnostics.lastIndexPersistError = 'sessions-index-write-failed; previous-index-retained';
    warn('[sessions] 摘要索引写入失败，保留上一份索引并标记陈旧');
    return false;
  }

  function startBackgroundIndexRebuild() {
    const existing = backgroundIndexRebuildJobs.get(sessionsDir);
    if (existing) {
      existing.diagnostics.add(diagnostics);
      diagnostics.lastIndexLoad = { ...existing.snapshot };
      return existing.snapshot;
    }

    const failed = backgroundIndexRebuildFailures.get(sessionsDir);
    if (failed && Date.now() < failed.retryAt) {
      diagnostics.lastIndexLoad = { ...failed.snapshot };
      return failed.snapshot;
    }
    backgroundIndexRebuildFailures.delete(sessionsDir);

    const id = nextBackgroundIndexRebuildId++;
    const startedAt = Date.now();
    const job = {
      id,
      startedAt,
      diagnostics: new Set([diagnostics]),
      worker: null,
      settled: false,
      snapshot: {
        mode: 'background-rebuild',
        state: 'rebuilding',
        rebuildId: id,
        startedAt,
        entries: null,
        readOnly: true,
        filesScanned: 0,
        filesRead: 0
      }
    };
    backgroundIndexRebuildJobs.set(sessionsDir, job);
    diagnostics.lastIndexLoad = { ...job.snapshot };
    warn(`[sessions] 会话摘要索引后台重建开始 id=${id}`);

    const finish = (result) => {
      if (job.settled) return;
      job.settled = true;
      backgroundIndexRebuildJobs.delete(sessionsDir);
      const finishedAt = Date.now();
      let completed = result;
      if (completed?.ok === true) {
        try {
          const persisted = persistBackgroundIndexSnapshot(completed);
          if (!persisted.ok) completed = { ...completed, ok: false, errorCode: persisted.errorCode };
          else completed = { ...completed, indexPersist: persisted.indexPersist };
        } catch (error) {
          completed = {
            ...completed,
            ok: false,
            errorCode: String(error?.code || 'sessions-index-rebuild-persist-failed'),
            errorName: String(error?.name || 'Error')
          };
        }
      }
      const snapshot = completed?.ok === true
        ? {
            mode: 'background-rebuild-ready',
            state: 'ready',
            rebuildId: id,
            startedAt,
            finishedAt,
            ms: Math.max(0, finishedAt - startedAt),
            entries: Number(completed.entries) || 0,
            readOnly: true,
            filesScanned: Number(completed.filesScanned) || 0,
            filesRead: Number(completed.filesRead) || 0,
            attempts: Number(completed.attempts) || 1,
            indexPersist: completed.indexPersist ?? null
          }
        : {
            mode: 'background-rebuild-failed',
            state: 'failed',
            rebuildId: id,
            startedAt,
            finishedAt,
            ms: Math.max(0, finishedAt - startedAt),
            entries: null,
            readOnly: true,
            filesScanned: Number(completed?.filesScanned) || 0,
            filesRead: Number(completed?.filesRead) || 0,
            errorCode: String(completed?.errorCode || 'sessions-index-rebuild-failed'),
            errorName: String(completed?.errorName || 'Error')
          };
      for (const target of job.diagnostics) target.lastIndexLoad = { ...snapshot };
      if (snapshot.state === 'ready') {
        backgroundIndexRebuildFailures.delete(sessionsDir);
        warn(`[sessions] 会话摘要索引后台重建完成 id=${id} entries=${snapshot.entries} ms=${snapshot.ms}`);
      } else {
        backgroundIndexRebuildFailures.set(sessionsDir, {
          retryAt: finishedAt + BACKGROUND_REBUILD_RETRY_MS,
          snapshot
        });
        warn(`[sessions] 会话摘要索引后台重建失败 id=${id} code=${snapshot.errorCode}`);
      }
    };

    try {
      const worker = new Worker(new URL('./index-rebuild-worker.mjs', import.meta.url), {
        workerData: { dataDir, keepFiles }
      });
      job.worker = worker;
      worker.once('message', (message) => finish(message));
      worker.once('error', (error) => finish({
        ok: false,
        errorCode: String(error?.code || 'sessions-index-worker-error'),
        errorName: String(error?.name || 'Error')
      }));
      worker.once('exit', (code) => {
        if (!job.settled) finish({
          ok: false,
          errorCode: `sessions-index-worker-exit-${Number(code) || 0}`,
          errorName: 'WorkerExit'
        });
      });
    } catch (error) {
      finish({
        ok: false,
        errorCode: String(error?.code || 'sessions-index-worker-start-failed'),
        errorName: String(error?.name || 'Error')
      });
    }
    return job.snapshot;
  }

  function scanForBackgroundIndexRebuild() {
    const startedAt = Date.now();
    let lastLoad = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      readOnlyScanCache.delete(sessionsDir);
      const rows = scan({ readOnly: true, forceFull: true, preserveDiskIndex: true });
      lastLoad = diagnostics.lastIndexLoad;
      const hit = readOnlyScanCache.get(sessionsDir);
      if (!hit || !isRebuildSnapshotStable(hit)) continue;
      return {
        ok: true,
        entries: rows.length,
        filesScanned: Number(lastLoad?.filesScanned) || 0,
        filesRead: Number(lastLoad?.filesRead) || 0,
        attempts: attempt,
        ms: Math.max(0, Date.now() - startedAt),
        fp: hit.fp,
        fileNames: [...hit.fileNames],
        fileMeta: [...hit.fileMeta],
        summaries: hit.summaries,
        bad: hit.diagnostics.bad,
        noId: hit.diagnostics.noId,
        noIdFiles: hit.diagnostics.noIdFiles
      };
    }
    const error = new Error('session directory changed during each index rebuild attempt');
    error.code = 'sessions-index-snapshot-unstable';
    throw error;
  }

  function persistBackgroundIndexSnapshot(result) {
    if (!Array.isArray(result?.summaries) || !Array.isArray(result?.fileNames) || !Array.isArray(result?.fileMeta)) {
      return { ok: false, errorCode: 'sessions-index-rebuild-result-invalid' };
    }
    const hit = {
      scannedAt: clock(),
      fp: result.fp,
      fileNames: new Set(result.fileNames),
      fileMeta: new Map(result.fileMeta),
      summaries: result.summaries,
      patchedAt: 0,
      patchReportedAt: 0,
      diagnostics: {
        bad: Array.isArray(result.bad) ? result.bad : [],
        noId: Number(result.noId) || 0,
        noIdFiles: Array.isArray(result.noIdFiles) ? result.noIdFiles : [],
        dirReadable: true,
        dirError: ''
      }
    };
    if (!isRebuildSnapshotStable(hit)) return { ok: false, errorCode: 'sessions-index-snapshot-changed' };
    readOnlyScanCache.set(sessionsDir, hit);
    diagnostics.bad = [...hit.diagnostics.bad];
    diagnostics.noId = hit.diagnostics.noId;
    diagnostics.noIdFiles = [...hit.diagnostics.noIdFiles];
    diagnostics.dirReadable = true;
    diagnostics.dirError = '';
    if (!persistDurableIndex()) {
      readOnlyScanCache.delete(sessionsDir);
      return { ok: false, errorCode: 'sessions-index-persist-failed' };
    }
    return { ok: true, indexPersist: diagnostics.lastIndexPersist };
  }

  function isRebuildSnapshotStable(hit) {
    let names;
    try {
      names = fs.readdirSync(sessionsDir).filter((name) => name.endsWith('.json'));
    } catch { return false; }
    if (names.length !== hit.fileNames?.size || names.length !== hit.fp?.count) return false;
    const currentFp = dirFingerprintCheap(sessionsDir);
    if (currentFp.count !== names.length || currentFp.mtimeMs !== hit.fp?.mtimeMs) return false;
    for (const name of names) {
      const before = hit.fileMeta?.get(name);
      if (!before) return false;
      try {
        const stat = fs.statSync(path.join(sessionsDir, name));
        if (stat.size !== before.size || stat.mtimeMs !== before.mtimeMs) return false;
      } catch { return false; }
    }
    return true;
  }

  function activateDiskIndex(disk, fp, t0) {
    for (const entry of disk.entries) {
      if (entry.status !== 'running' && entry.status !== 'waiting') continue;
      try {
        const full = path.join(sessionsDir, `${entry.id}.json`);
        const data = readJsonLoose(full);
        if (data?.id !== entry.id) return null;
        settleStale(data, full, now(), { readOnly: true });
        Object.assign(entry, summaryOf(data));
      } catch { return null; }
    }
    const at = clock();
    const hitFromDisk = {
      scannedAt: at, fp, summaries: disk.entries,
      fileNames: new Set([
        ...disk.entries.map((entry) => `${entry.id}.json`),
        ...disk.bad.map((entry) => entry.f),
        ...(disk.noIdFiles ?? [])
      ]),
      patchedAt: 0, patchReportedAt: 0,
      diagnostics: { bad: disk.bad, noId: disk.noId, noIdFiles: disk.noIdFiles, dirReadable: true, dirError: '' }
    };
    readOnlyScanCache.set(sessionsDir, hitFromDisk);
    primeFileMetadata(hitFromDisk);
    // ★ A40：`mode` 如实报走的是哪条路（`disk` = 严格校验全过；`incremental` = 名字集合增量）。
    //   增量那条把"复用了多少 / 新读了多少 / 同名原地改没验"一并带出去，不许看起来像"全新的"。
    diagnostics.lastIndexLoad = {
      mode: `${disk.incremental ? 'incremental' : 'disk'}${disk.source === 'backup' ? '-backup' : ''}`,
      ms: Date.now() - t0,
      entries: disk.entries.length,
      readOnly: true,
      ...(disk.incremental ? { incremental: disk.incremental, stale: true } : {})
    };
    diagnostics.bad = [...disk.bad]; diagnostics.noId = disk.noId; diagnostics.noIdFiles = [...disk.noIdFiles];
    diagnostics.dirReadable = true; diagnostics.dirError = '';
    return disk.entries.slice();
  }

  function primeFileMetadata(hit) {
    if (hit.fileMeta || hit.metadataPromise) return;
    hit.metadataPromise = (async () => {
      const before = dirFingerprintCheap(sessionsDir);
      const names = (await fs.promises.readdir(sessionsDir)).filter((f) => f.endsWith('.json'));
      const fileMeta = new Map();
      for (const name of names) {
        const st = await fs.promises.stat(path.join(sessionsDir, name));
        fileMeta.set(name, { mtimeMs: st.mtimeMs, size: st.size });
      }
      const after = dirFingerprintCheap(sessionsDir);
      if (before.count === after.count && before.mtimeMs === after.mtimeMs && names.length === after.count) {
        hit.fileMeta = fileMeta;
        hit.fileNames = new Set(names);
      }
    })().catch((error) => {
      warn(`[sessions] 摘要元信息预热失败：${error?.name ?? 'Error'}`);
    }).finally(() => { hit.metadataPromise = null; });
  }

  function refreshCacheSync(hit, reason) {
    const startedAt = Date.now();
    let filesRead = 0;
    let names;
    try { names = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')).sort().reverse(); }
    catch (error) {
      diagnostics.dirReadable = false;
      diagnostics.dirError = String(error?.message ?? error);
      diagnostics.lastIndexLoad = {
        mode: 'refresh-failed', ms: Date.now() - startedAt, entries: hit.summaries.length, readOnly: true,
        filesScanned: 0, filesRead: 0, errorName: error?.name ?? 'Error', errorCode: error?.code ?? ''
      };
      warn(`[sessions] 摘要增量刷新失败：${error?.name ?? 'Error'} ${error?.code ?? ''}`);
      return;
    }
    const present = new Set(names);
    const previousNames = hit.fileNames ?? new Set([
      ...hit.summaries.map((entry) => `${entry.id}.json`),
      ...(hit.diagnostics.bad ?? []).map((entry) => entry.f),
      ...(hit.diagnostics.noIdFiles ?? [])
    ]);
    const previousMeta = hit.fileMeta;
    let nextMeta = previousMeta ? new Map(previousMeta) : null;
    if (nextMeta) for (const name of nextMeta.keys()) if (!present.has(name)) nextMeta.delete(name);
    const changed = new Set(names.filter((name) => !previousNames.has(name)));
    if (reason === 'rescan-signature') {
      if (!previousMeta) {
        // 磁盘索引激活后的元信息预热尚未完成；这条少见冷路径保留完整校验。
        for (const name of names) changed.add(name);
      } else {
        nextMeta = new Map();
        for (const name of names) {
          let st;
          try { st = fs.statSync(path.join(sessionsDir, name)); }
          catch { changed.add(name); continue; }
          const current = { mtimeMs: st.mtimeMs, size: st.size };
          nextMeta.set(name, current);
          const old = previousMeta.get(name);
          if (!old || old.mtimeMs !== current.mtimeMs || old.size !== current.size) changed.add(name);
        }
      }
    }
    // 小目录的完整校验成本低，并保留 selftest 中 `mode=full` 的既有可观察契约。
    const full = names.length <= 64 || (reason === 'rescan-signature' && !previousMeta);
    if (full) for (const name of names) changed.add(name);
    // ★ 2026-10-16：**易过期状态必须每轮重算**。`settleStale(...,{readOnly:true})` 只改内存、不写盘
    //   ⇒ 卡住的 running（>15 分钟）/ waiting（>90 秒）行文件 mtime/size 永远不变，而下面只重读
    //   `changed` 里的文件 ⇒ 大目录下这类行会被缓存**无限期**当成 running 顶给读侧（UI 显示"疑似卡住"）。
    //   把缓存摘要里仍是 running/waiting 的行一律纳入 changed：重读那次会照常走 settleStale（只读、不写盘），
    //   摘要随即变成 error/aborted ⇒ 下一次不再属于"活行" ⇒ 开销只在真正在跑的轮上（O(活行数)）。
    //   只借"重读"，不动阈值、不改业务状态、不写任何文件。
    for (const entry of hit.summaries) {
      if (entry?.status === 'running' || entry?.status === 'waiting') changed.add(`${entry.id}.json`);
    }
    const summariesByFile = new Map(hit.summaries.map((entry) => [`${entry.id}.json`, entry]));
    const badByFile = new Map((hit.diagnostics.bad ?? []).map((entry) => [entry.f, entry]));
    const noId = new Set(hit.diagnostics.noIdFiles ?? []);
    const bad = [];
    const noIdFiles = [];
    for (const name of names) {
      const fullPath = path.join(sessionsDir, name);
      if (!changed.has(name)) {
        if (summariesByFile.has(name)) continue;
        if (badByFile.has(name)) { bad.push(badByFile.get(name)); continue; }
        if (noId.has(name)) { noIdFiles.push(name); continue; }
      }
      filesRead += 1;
      try {
        const data = readJsonLoose(fullPath);
        // ★ 2026-10-16：与 scan 路径（:1710）**同一口径** —— 重读时也跑一次陈旧收尾。
        //   只读路径下 settleStale 只改内存副本、不写盘；不补这一步，"强制重读 running 行"拿回来的
        //   仍是 running（判据/阈值依旧只有 settleStale 那一处，不在本层复制）。
        settleStale(data, fullPath, now(), { readOnly: true });
        if (data?.id) summariesByFile.set(name, summaryOf(data));
        else { summariesByFile.delete(name); noIdFiles.push(name); }
        badByFile.delete(name);
      } catch (error) {
        summariesByFile.delete(name);
        noId.delete(name);
        const rec = badFileRecord(fullPath, error);
        bad.push(rec);
        warn(`[sessions] 跳过无法解析的会话文件 ${name}：${rec.errorName} ${rec.msg}`);
      }
      if (nextMeta) {
        try {
          const st = fs.statSync(fullPath);
          nextMeta.set(name, { mtimeMs: st.mtimeMs, size: st.size });
        } catch { nextMeta.delete(name); }
      }
    }
    const summaries = names.flatMap((name) => summariesByFile.has(name) ? [summariesByFile.get(name)] : []);
    const fp = dirFingerprintCheap(sessionsDir);
    if (fp.count !== names.length || fp.mtimeMs === null) {
      diagnostics.lastIndexLoad = {
        mode: 'refresh-retry', ms: Date.now() - startedAt, entries: hit.summaries.length, readOnly: true,
        filesScanned: names.length, filesRead, stale: true, errorCode: 'directory-changed'
      };
      warn('[sessions] 摘要增量刷新期间目录有变化，将在下一次读取重试');
      return;
    }
    hit.summaries = summaries;
    hit.fileNames = present;
    hit.fileMeta = nextMeta;
    hit.fp = fp;
    hit.diagnostics = { ...hit.diagnostics, bad, noId: noIdFiles.length, noIdFiles, dirReadable: true, dirError: '' };
    hit.scannedAt = clock();
    diagnostics.bad = [...bad]; diagnostics.noId = noIdFiles.length; diagnostics.noIdFiles = [...noIdFiles];
    diagnostics.dirReadable = true; diagnostics.dirError = '';
    diagnostics.lastIndexLoad = {
      mode: full ? 'full' : reason,
      ms: Date.now() - startedAt, entries: summaries.length, readOnly: true,
      filesScanned: names.length, filesRead,
      ...(full ? {} : { incremental: { reused: names.length - filesRead, changed: filesRead } })
    };
    if (!hit.fileMeta) primeFileMetadata(hit);
  }

  function scan({ readOnly, forceFull = false, preserveDiskIndex = false }) {
    const t0 = clock();
    // ── 只读路径：进程内缓存 + 同步增量刷新 ────
    //
    // ⚠⚠ **反面教材（别再抄回去）**：上一版这里是
    //     `if (age < TTL || fullSignatureUnchanged) { hit.scannedAt = t0; … }`
    //   两个错叠在一起：
    //     ① `hit.at = t0` 在**每次命中**时把 TTL 锚点往后推 ⇒ 读得比 TTL 快时（UI 轮询、探针 1 秒一次）
    //        `age` **永远 < TTL** ⇒ **外部改盘永远看不见**
    //        （指挥位 `probe-symptoms-e2e.mjs --only S7` 实测：等 22 秒计数一直不变）；
    //   `scannedAt` = 这份摘要**是哪一刻校验出来的**；命中时不改。
    //   每次读检查目录 mtime / 条目数；变化时同步只解析新增/变化文件。TTL 到期时逐文件比较元信息。
    if (readOnly && !forceFull) {
      if (startupDiskPending) {
        startupDiskPending = false;
        const fp = dirFingerprintCheap(sessionsDir);
        if (fp.mtimeMs === startupFp.mtimeMs && fp.count === startupFp.count) {
          const rows = activateDiskIndex(startupDisk, fp, t0);
          if (rows) return rows;
        }
      }
      const hit = readOnlyScanCache.get(sessionsDir);
      if (hit) {
        const age = t0 - hit.scannedAt;
        const fp = dirFingerprintCheap(sessionsDir);
        const cheapChanged = fp.mtimeMs !== hit.fp.mtimeMs || fp.count !== hit.fp.count;
        if (cheapChanged) {
          // 目录指纹变了（mtime 或条目数）⇒ 当前请求只读增量文件并同步更新列表。
          refreshCacheSync(hit, 'rescan-mtime');
          return hit.summaries.slice();
        } else if (age < READONLY_CACHE_TTL_MS) {
          // 目录没动且还没到 TTL ⇒ 吃缓存。**不动 scannedAt**（动了就把 TTL 变成滑动窗口 = 回到反面教材）
          // ? mode 诚实：这一轮**吃到过补过的行**就报 patch（只报第一次，之后回到普通 cache）
          const patched = !!(hit.patchedAt && hit.patchedAt !== hit.patchReportedAt);
          if (patched) hit.patchReportedAt = hit.patchedAt;
          diagnostics.cachePatchedAt = hit.patchedAt ?? null;
          diagnostics.lastIndexLoad = { mode: patched ? 'patch' : 'cache', ms: Date.now() - t0, entries: hit.summaries.length, readOnly: true, ageMs: age, patched };
          diagnostics.bad = [...hit.diagnostics.bad];
          diagnostics.noId = hit.diagnostics.noId;
          diagnostics.noIdFiles = [...(hit.diagnostics.noIdFiles ?? [])];
          diagnostics.dirReadable = hit.diagnostics.dirReadable;
          diagnostics.dirError = hit.diagnostics.dirError;
          return hit.summaries.slice();
        } else {
          // TTL 到期后同步比较元信息，只重读 mtime/size 改变的文件。
          diagnostics.lastIndexLoad = { mode: 'rescan-signature', ms: Date.now() - t0, entries: hit.summaries.length, readOnly: true, ageMs: age };
          refreshCacheSync(hit, 'rescan-signature');
          return hit.summaries.slice();
        }
      }
      if (!hit) {
        const fp = dirFingerprintCheap(sessionsDir);
        const disk = fp.count >= 0
          ? loadAvailableDiskIndex(indexFile, fp, keepFiles, sessionsDir)
          : null;
        if (disk) {
          const rows = activateDiskIndex(disk, fp, t0);
          if (rows) return rows;
        }
        // ★ A40：严格校验没过（绝大多数是 `fileCount` / `dirMtimeMs` 对不上 —— 会话目录新增一个文件就变）
        //   ⇒ **这里原本直接掉进全量扫盘**（实测 6852ms / 14348ms，937MB）。
        //   现在先试**名字集合增量**：旧条目原样复用、只读新增的那几个、删掉的丢掉（见 loadJournalAwareDiskIndex）。
        //   增量也兜不住（索引形状对不上 / 目录读不干净）⇒ 才落回全量，那条路保持原样不动。
        const inc = fp.count >= 0
          ? loadAvailableDiskIndex(indexFile, fp, keepFiles, sessionsDir, { incremental: true, warn })
          : null;
        if (inc) {
          const rows = activateDiskIndex(inc, fp, t0);
          if (rows) return rows;
        }
        // Large cold directories with no usable primary/backup index are rebuilt off-thread.
        // Small directories retain the synchronous path so first-run behavior stays simple.
        if (fp.count > 64) {
          startBackgroundIndexRebuild();
          return [];
        }
      }
    }
    const summaries = [];
    const bad = [];
    let noId = 0;
    const noIdFiles = [];
    const fileMeta = new Map();
    let names = [];
    let dirReadable = null;
    let dirError = '';
    try {
      names = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')).sort().reverse();
      dirReadable = true;
    } catch (error) {
      // ★ 目录不存在 = "还没有会话"（合法空态，`dirReadable:null`）；**读不动**（权限/EACCES/ENOTDIR）
      //   必须是 `false` + 原因。旧实现 `catch { mode:'none' }`（旧 :102-104）把两者混同。
      //   ⚠ 我第一版写成 `dirReadable = error?.code === 'ENOENT'` ⇒ ENOENT 时求值为 **true**，
      //   于是"目录不存在"被错报成"可读"。自测 4.6 当场抓到（期望 null，实得 true）。
      if (error?.code === 'ENOENT') {
        dirReadable = null;
        dirError = '';
      } else {
        dirReadable = false;
        dirError = String(error?.message ?? error);
      }
    }
    const stamp = now();
    let settledAny = false;
    for (const f of names) {
      const full = path.join(sessionsDir, f);
      if (readOnly) {
        try {
          const st = fs.statSync(full);
          fileMeta.set(f, { mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* 读写竞争会由下一次刷新重试。 */ }
      }
      try {
        const data = readJsonLoose(full);
        settledAny = settleStale(data, full, stamp, { readOnly }) || settledAny;
        if (data?.id) summaries.push(summaryOf(data));
        else { noId += 1; noIdFiles.push(f); }
      } catch (error) {
        const rec = badFileRecord(path.join(sessionsDir, f), error);
        bad.push(rec);
        warn(`[sessions] 跳过无法解析的会话文件 ${f}：${rec.errorName} ${rec.msg}`);
      }
    }
    diagnostics.lastIndexLoad = {
      mode: names.length || dirReadable === true ? 'full' : 'none',
      ms: Date.now() - t0, entries: summaries.length, readOnly: !!readOnly,
      filesScanned: names.length, filesRead: names.length
    };
    diagnostics.bad = bad;
    diagnostics.noId = noId;
    diagnostics.noIdFiles = noIdFiles;
    diagnostics.dirReadable = dirReadable;
    diagnostics.dirError = dirError;
    if (settledAny && !preserveDiskIndex) {
      invalidateDiskIndex(indexFile);
      readOnlyScanCache.delete(sessionsDir);
    }
    // ── 只读路径：缓存全量兜底结果与本次读取的元信息 ──
    if (readOnly) {
      readOnlyScanCache.set(sessionsDir, {
        scannedAt: t0,                 // ★ 这份摘要的时刻；命中时**不许**改（TTL 只挂它）
        fp: dirFingerprintCheap(sessionsDir),   // ★ 廉价指纹（mtime + .json 条目数）：每次读都查它
        fileMeta,
        fileNames: new Set(names),
        summaries: summaries.slice(),
        patchedAt: 0, patchReportedAt: 0,   // ★ 补行时刻 / 已报告给 diagnostics 的那一刻
        diagnostics: { bad: [...bad], noId, noIdFiles: [...noIdFiles], dirReadable, dirError }
      });
    }
    return summaries;
  }

  const registry = {
    sessionsDir,
    current,

    /** 诊断：目录可读性 + 坏文件账目（供探针对账）。 */
    diagnostics() {
      return { ...diagnostics, bad: [...diagnostics.bad], sessionsDir,
        contextCheckpoint: contextCheckpointDiagnostics() };
    },

    /**
     * 读取按 account/kind/chat 隔离的 checkpoint。无效、缺失和读取失败都返回明确原因，
     * 诊断只保留哈希、游标、修订号、计数和原因码；正文只在有效 checkpoint 返回值里供调用方使用。
     */
    readContextCheckpoint(namespace) {
      const namespaceHash = contextNamespaceHash(namespace);
      if (!namespaceHash) {
        noteContextCheckpoint({ operation: 'read', action: 'cold-rebuild', reasonCode: 'checkpoint-namespace-invalid' });
        return { ok: false, action: 'cold-rebuild', reasonCode: 'checkpoint-namespace-invalid' };
      }
      const file = path.join(contextCheckpointDir, `${namespaceHash}.json`);
      let record;
      try {
        record = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        const reasonCode = error?.code === 'ENOENT' ? 'checkpoint-missing'
          : error instanceof SyntaxError ? 'checkpoint-malformed' : 'checkpoint-read-failed';
        noteContextCheckpoint({ operation: 'read', action: 'cold-rebuild', reasonCode, namespaceHash });
        return { ok: false, action: 'cold-rebuild', reasonCode };
      }
      const reasonCode = contextCheckpointRecordError(record, namespaceHash);
      if (reasonCode) {
        noteContextCheckpoint({ operation: 'read', action: 'cold-rebuild', reasonCode, namespaceHash,
          sourceCursorHash: String(record?.sourceCursorHash ?? ''),
          sourceRevision: record?.sourceRevision, contextHash: String(record?.contextHash ?? '') });
        return { ok: false, action: 'cold-rebuild', reasonCode };
      }
      noteContextCheckpoint({ operation: 'read', reasonCode: 'checkpoint-loaded', namespaceHash,
        sourceCursorHash: record.sourceCursorHash, sourceRevision: record.sourceRevision, contextHash: record.contextHash });
      return { ok: true, checkpoint: structuredClone(record), namespaceHash };
    },

    /** Metadata validation is strict; the caller must verify readSince before treating a candidate as a hit. */
    planContextCheckpoint(namespace, expected = {}) {
      const read = registry.readContextCheckpoint(namespace);
      if (!read.ok) {
        noteContextCheckpoint({ operation: 'decision', action: 'cold-rebuild', reasonCode: read.reasonCode,
          namespaceHash: contextNamespaceHash(namespace) });
        return { action: 'cold-rebuild', reasonCode: read.reasonCode, candidateValid: false };
      }
      const decision = decideContextCheckpoint(read.checkpoint, { ...expected, namespace });
      noteContextCheckpoint({ operation: 'decision', action: decision.action, reasonCode: decision.reasonCode,
        namespaceHash: read.namespaceHash, sourceCursorHash: read.checkpoint.sourceCursorHash,
        sourceRevision: read.checkpoint.sourceRevision, contextHash: read.checkpoint.contextHash });
      return {
        ...decision,
        namespaceHash: read.namespaceHash,
        sourceCursorHash: read.checkpoint.sourceCursorHash,
        sourceRevision: read.checkpoint.sourceRevision,
        contextHash: read.checkpoint.contextHash,
        ...(decision.candidateValid ? { checkpoint: structuredClone(read.checkpoint) } : {})
      };
    },

    /** Record a caller-verified outcome using only hashes, revisions, counters and a reason code. */
    recordContextCheckpointOutcome(input = {}) {
      const allowedActions = new Set(['hot-hit', 'cold-rebuild']);
      const action = allowedActions.has(input.action) ? input.action : 'cold-rebuild';
      const suppliedReason = String(input.reasonCode ?? 'checkpoint-reason-unknown');
      const reasonCode = /^[a-z0-9-]{1,80}$/.test(suppliedReason) ? suppliedReason : 'checkpoint-reason-invalid';
      noteContextCheckpoint({
        operation: 'outcome', action, reasonCode,
        namespaceHash: String(input.namespaceHash ?? ''),
        sourceCursorHash: String(input.sourceCursorHash ?? ''),
        sourceRevision: input.sourceRevision,
        contextHash: String(input.contextHash ?? ''),
        sourceRowsRead: input.sourceRowsRead,
        pairRewindCount: input.pairRewindCount,
        orphanCallIds: input.orphanCallIds,
        orphanResultIds: input.orphanResultIds
      });
      return contextCheckpointDiagnostics();
    },

    /** Caller supplies the context rebuilt from source rows; this persists it as the next cold checkpoint. */
    writeContextCheckpoint,

    /** Independent post-prompt completion watermark; never used as the ChatStore read cursor. */
    readContextCompressionProgress,
    writeContextCompressionProgress,

    /** Explicit cold path: persist the rebuilt context and return safe readings without message bodies. */
    writeContextCheckpointAfterColdRebuild(input, reasonCode = 'checkpoint-cold-rebuild') {
      const saved = writeContextCheckpoint(input);
      const safeReason = /^[a-z0-9-]{1,80}$/.test(String(reasonCode ?? '')) ? String(reasonCode) : 'checkpoint-cold-rebuild';
      noteContextCheckpoint({ operation: 'rebuild', action: 'cold-rebuild', reasonCode: saved.ok ? safeReason : saved.reasonCode,
        namespaceHash: saved.namespaceHash ?? contextNamespaceHash(input?.namespace),
        sourceCursorHash: saved.sourceCursorHash, sourceRevision: saved.sourceRevision, contextHash: saved.contextHash });
      return {
        action: 'cold-rebuild', reasonCode: saved.ok ? safeReason : saved.reasonCode,
        checkpointSaved: saved.ok,
        ...(saved.ok ? { namespaceHash: saved.namespaceHash, sourceCursorHash: saved.sourceCursorHash,
          sourceRevision: saved.sourceRevision, contextHash: saved.contextHash, contextSegmentCount: saved.contextSegmentCount }
          : { writeReasonCode: saved.reasonCode })
      };
    },

    /** Safe checkpoint diagnostics; never includes context segments or source text. */
    contextCheckpointDiagnostics,

    /**
     * 列出摘要（旧 `listSummaries`，旧 :469-478）。
     * @param {number|{limit?:number, readOnly?:boolean}} [arg]
     *   传数字 = 旧签名（limit）；传对象可要**只读快照**（跳过陈旧回写）。
     */
    listSummaries(arg = 100) {
      const opts = typeof arg === 'object' && arg !== null ? arg : { limit: Number(arg) };
      const readOnly = opts.readOnly === true;
      const limit = Number(opts.limit ?? 100);
      const summaries = scan({ readOnly });
      registry.pruneMissingFiles(summaries);
      if (readOnly && !['rebuilding', 'failed'].includes(diagnostics.lastIndexLoad?.state)) {
        diagnostics.lastIndexLoad = { ...diagnostics.lastIndexLoad, state: 'ready' };
      }
      return Number.isFinite(limit) ? summaries.slice(0, Math.max(0, limit)) : summaries;
    },

    /** Full read-only scan for the worker; index persistence stays in the main thread. */
    scanForBackgroundIndexRebuild() { return scanForBackgroundIndexRebuild(); },

    /** 零写入快照（本票 `planCleanup` 用的就是它）。 */
    snapshot() {
      return scan({ readOnly: true });
    },

    /**
     * 丢掉"磁盘文件已经不在"的索引条目（幽灵记录，旧 :481-494）。
     * 一次 readdir 代替逐条 existsSync（旧树 32s 节拍下曾阻塞 600~1000ms）。
     * @returns {number} 清掉的条数
     */
    pruneMissingFiles(into = null) {
      let present = new Set();
      try { present = new Set(fs.readdirSync(sessionsDir)); } catch { /* 目录读不到 ⇒ 全部算不在 */ }
      const list = into ?? scan({ readOnly: true });
      let dropped = 0;
      const kept = [];
      for (const e of list) {
        const stillThere = present.has(`${e.id}.json`);
        if (stillThere || current.has(e.id)) kept.push(e);
        else dropped += 1;
      }
      if (into) { into.length = 0; into.push(...kept); }
      return dropped;
    },

    /** 取单条（旧 `get`，旧 :326-337）：内存优先，否则读盘；读不到回 null。 */
    get(id) {
      const clean = String(id ?? '').trim();
      if (current.has(clean)) return structuredClone(current.get(clean));
      if (!SESSION_ID_RE.test(clean)) return null;
      try {
        return readJsonLoose(path.join(sessionsDir, `${clean}.json`));
      } catch {
        return null;      // 旧 :334-336：读不到就是 null（端点据此回 404）
      }
    },

    /** 不克隆读取（旧 `peek`，旧 :345-352）：返回活对象，调用方**不许改**。 */
    peek(id) {
      const clean = String(id ?? '').trim();
      if (current.has(clean)) return current.get(clean);
      if (!SESSION_ID_RE.test(clean)) return null;
      try {
        return readJsonLoose(path.join(sessionsDir, `${clean}.json`));
      } catch {
        return null;
      }
    },

    /** cleanup 用的豁免判断（旧 `cleanup.js:120`：`registry.current?.has?.(id)`）。 */
    isLive(id) {
      return current.has(String(id ?? '').trim());
    },

    /** 自测/接线用：往"运行中"里塞一条（写侧接入前的替身）。 */
    __setCurrent(id, session) { current.set(String(id), session); return true; },
    /** 自测用：清掉运行中集合。 */
    __clearCurrent() { current.clear(); lastPersistAt.clear(); return true; },

    // ══════════════════════════════════════════════════════════════════════
    // 写侧（2026-10-05 票：主人报"回复没进会话记录"——因为新树**没有任何路径**写这些文件）
    // ══════════════════════════════════════════════════════════════════════

    /**
     * 落盘（旧 `#persist`，旧 :630-647 的形状，但**三处不同**，见文件头注释）：
     *   ① **原子写**（`writeJsonAtomic`：tmp+rename）——旧树为省 43ms rename 改成直接覆写，本票要求原子。
     *   ② **失败可见**：`{ok:false, error}` 返回给调用方（strict 模式直接抛）。旧树是 catch 掉只打打日志。
     *   ③ 不做"今天用量"累加（旧 `#bumpTodayUsage`）—— 属观账本那条线。
     *   ④ **写成功后让只读扫描缓存失效**（见 `invalidateSessionsCache`）—— 不失效的话，
     *      写完 15 秒内的 `listSummaries({readOnly:true})` 会吐**旧摘要**（指挥位 18:08 那个缓存的洞）。
     * @param {string|object} idOrSession 会话 id，或会话对象本身
     *   （★ 对象入口是必需的：`finish()` 要先落最终态、再把会话移出 `current`，
     *     若 `persist` 只能按 id 去 `current` 查，它就永远查不到 —— 我第一版就这样，
     *     于是 finish **从来没落过盘**，症状正是主人报的"记录停在 running"。）
     * @returns {{ok:boolean, error?:string, path?:string}}
     */
    persist(idOrSession) {
      const s = (idOrSession && typeof idOrSession === 'object')
        ? idOrSession
        : current.get(String(idOrSession ?? '').trim());
      if (!s || !s.id) return { ok: false, error: 'not-in-current' };
      let file;
      try {
        file = sessionFile(s.id, sessionsDir);
        writeJsonAtomic(file, s);          // 紧凑 JSON（indent 默认 null，与旧树格式逐字节同形）
        diagnostics.writes += 1;
        diagnostics.lastPersistError = null;
        try { ledger?.upsertFromSession?.(s); } catch { /* 台账失败不影响会话（旧 :642 同款） */ }
        // ★ 写成功 ⇒ **就地补这一行**（T-SB2-CACHE-PATCH：不再整表丢，否则写后第一次读是全量冷扫）
        //   补行失败时自己退回 invalidateSessionsCache（见 patchCacheRow 的 catch）。
        patchCacheRow(sessionsDir, s, diagnostics);
        const summary = summaryOf(s);
        const hit = readOnlyScanCache.get(sessionsDir);
        if (hit) {
          const idx = hit.summaries.findIndex((row) => row.id === summary.id);
          if (idx >= 0) hit.summaries[idx] = summary;
          else hit.summaries.unshift(summary);
          hit.fp = dirFingerprintCheap(sessionsDir);
          hit.patchedAt = Date.now();
          persistIndexAfterWrite(summary);       // ★ S04：大索引只追加一行；小索引沿用整份写
        } else if (durableHit) {
          const idx = durableHit.summaries.findIndex((row) => row.id === summary.id);
          if (idx >= 0) durableHit.summaries[idx] = summary;
          else durableHit.summaries.unshift(summary);
          durableHit.fp = dirFingerprintCheap(sessionsDir);
          persistIndexAfterWrite(summary);
        } else invalidateDiskIndex(indexFile);
        return { ok: true, path: file };
      } catch (error) {
        const msg = String(error?.message ?? error);
        diagnostics.lastPersistError = msg;
        if (strict) throw error;
        return { ok: false, error: msg, id: s.id };
      }
    },

    /**
     * 建一个会话（旧 `create`，旧 :290-324；初始 25 字段形状逐字照搬）。
     * @returns {{session:object, persisted:{ok:boolean, path?:string, error?:string}}}
     */
    create({ chatKey, trigger, triggerSummary, status = 'running', waitUntil = null, id = null } = {}) {
      const sid = String(id ?? newSessionId());
      if (!SESSION_ID_RE.test(sid)) {
        const error = new Error(`modules/sessions: 会话 id 不合法：${JSON.stringify(sid.slice(0, 40))}`);
        error.reason = 'bad-id';
        if (strict) throw error;
        return { session: null, persisted: { ok: false, error: 'bad-id' } };
      }
      const session = {
        id: sid,
        chatKey,
        startedAt: now(),
        endedAt: null,
        status,
        waitUntil,
        trigger,                                 // 'message' | 'proactive'（旧 :299）
        triggerSummary: String(triggerSummary ?? '').slice(0, 120),   // 旧 :300
        triggerText: triggerEntriesToText(trigger),                   // 旧 :656-660
        systemPrompt: '',
        userPrompt: '',
        promptChars: 0,
        model: '',
        rounds: 0,
        turnPlan: null,
        turnTrace: null,
        messages: [],                            // OpenAI 消息序列（旧 :313）
        sent: [],                                // 实际发出的每一条（旧 :314）
        feedbacks: [],
        finishReason: null,
        error: null,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, calls: 0 }
      };
      current.set(session.id, session);
      const persisted = registry.persist(session.id);
      return { session, persisted };
    },

    /**
     * 提交点（旧 `update`，旧 :354-363）：运行中会话落盘**带节流**（每会话 2 秒最多一次，旧 :600-608）。
     * 运行时模式：直接改 `peek(id)` 拿到的对象 → 调它（旧 orchestrator 就是这么干的）。
     * @returns {{ok:boolean, throttled?:boolean, error?:string}}
     */
    update(id) {
      const sid = String(id ?? '').trim();
      if (!current.has(sid)) return { ok: false, error: 'not-in-current' };
      const stamp = now();
      const last = Number(lastPersistAt.get(sid)) || 0;
      if (stamp - last < PERSIST_THROTTLE_MS) {
        diagnostics.throttledSkips += 1;
        return { ok: true, throttled: true };      // 节流掉：**不算失败**（旧 :604 静默 return）
      }
      lastPersistAt.set(sid, stamp);
      return registry.persist(sid);
    },

    /**
     * 追加一条消息**并落盘**（旧树没有这个方法：它让 orchestrator 直接 `session.messages.push(…)`
     * 再 `update(id)`，落盘时机取决于节流窗口 ⇒ 最坏情况丢 2 秒。
     * 这里给运行时一个**明确的提交点**：push 完立刻落盘，返回落盘结果，不许假装成功）。
     *
     * ★ entry 形状（2026-10-05 指挥位裁定：**看得见，而不是拒收**）：
     *   · **非对象** ⇒ 拒 `{ok:false, reason:'bad-entry'}`（那一定是调用方 bug，不该进 transcript）；
     *   · **是对象** ⇒ **原样落盘**（保留旧树 `session.messages.push` 的自由度，我不替别人改数据），
     *     但 `role` 不在 user/assistant/system/tool 里、或正文既不是 `content` 也不是 `text` 字符串
     *     ⇒ 记进 `diagnostics.badEntries`（**调用方传错形状在盘上看得见**），
     *     **但这次写仍然成功** —— 不许因为一个坏 entry 让整轮记录丢掉。
     * @returns {{ok:boolean, count?:number, error?:string, reason?:string, badEntry?:boolean}}
     */
    appendMessage(id, entry) {
      const sid = String(id ?? '').trim();
      const s = current.get(sid);
      if (!s) return { ok: false, error: 'not-in-current' };
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return { ok: false, reason: 'bad-entry', count: Array.isArray(s.messages) ? s.messages.length : 0 };
      }
      // ★ S03：单条 = 单元素批（同一套形状口径/记账只留一处实现）。
      const r = registry.appendMessages(sid, [entry]);
      const one = r.results?.[0] ?? {};
      return r.ok
        ? { ok: true, count: r.count, badEntry: one.badEntry === true }
        : { ok: false, error: r.error, count: r.count, badEntry: one.badEntry === true };
    },

    /**
     * ★ S03（2026-10-19 ds3）：批量追加、**只落盘一次**。
     *
     * 病：运行时对同一批触发消息逐条调 `appendMessage`（orchestrator `appendSessionMessage` 的循环）
     * ⇒ 一批 N 条就把整份会话文件（含完整 messages + 最终提示词）原子重写 N 次。
     * 这里把同一批合成**一次**落盘；形状口径与 `appendMessage` 完全一致（非对象拒收、可疑形状照收并记账），
     * 逐条结果按序返回，绝不因为一条坏 entry 丢掉整批。
     * @returns {{ok:boolean, count:number, persisted?:object, results:Array<{ok:boolean,reason?:string,badEntry?:boolean}>, error?:string}}
     */
    appendMessages(id, entries) {
      const sid = String(id ?? '').trim();
      const s = current.get(sid);
      if (!s) return { ok: false, error: 'not-in-current', count: 0, results: [] };
      if (!Array.isArray(entries) || entries.length === 0) {
        return { ok: false, error: 'bad-entries', count: Array.isArray(s.messages) ? s.messages.length : 0, results: [] };
      }
      if (!Array.isArray(s.messages)) s.messages = [];
      const results = [];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          results.push({ ok: false, reason: 'bad-entry' });
          continue;
        }
        const role = String(entry.role ?? '');
        const body = entry.content ?? entry.text;
        const shapeOk = ['user', 'assistant', 'system', 'tool'].includes(role) && typeof body === 'string';
        if (!shapeOk) {
          diagnostics.badEntries += 1;
          warn(`[sessions] appendMessages 收到形状可疑的 entry（已原样落盘，badEntries=${diagnostics.badEntries}）：role=${JSON.stringify(role)}`);
        }
        s.messages.push(entry);
        results.push({ ok: true, badEntry: !shapeOk });
      }
      const r = registry.persist(sid);           // 一批只写一次（消息是留档的主体，不走节流）
      return r.ok
        ? { ok: true, count: s.messages.length, persisted: r, results }
        : { ok: false, error: r.error, count: s.messages.length, persisted: r, results };
    },

    /** 设置运行中的活动状态（旧 `setActivity`，旧 :365-372）。 */
    setActivity(id, activity) {
      const sid = String(id ?? '').trim();
      const s = current.get(sid);
      if (!s) return { ok: false, error: 'not-in-current' };
      s.activity = String(activity ?? '');
      s.activityAt = now();                      // UI 用它显示"已等 N 秒"（旧 :271）
      return registry.update(sid);
    },

    /**
     * 结束会话（旧 `finish`，旧 :374-407）：**立即**落最终态（旧 :382 不走节流 ⇒ 留档完整），
     * 然后移出 `current`，并按 `keepFiles` 修剪过老的文件（旧 :385-405）。
     * @returns {{ok:boolean, session:object|null, persisted:object, trimmed?:number}}
     */
    finish(id, status) {
      const sid = String(id ?? '').trim();
      const s = current.get(sid);
      if (!s) return { ok: false, session: null, persisted: { ok: false, error: 'not-in-current' } };
      s.status = status;
      s.endedAt = now();
      // ★ 顺序要紧：**先按对象落最终态，再移出 current**（旧 :374-382 同样先 #persist 再 delete）。
      //   我第一版写成"先 delete 再 persist(id)" ⇒ persist 去 current 里查不到 ⇒ **finish 从来没落过盘**，
      //   症状就是主人报的"记录停在 running"。自测 8.15/8.16 与 11.6 把这条钉死。
      const persisted = registry.persist(s);
      current.delete(sid);
      lastPersistAt.delete(sid);                 // 旧 :381：防 map 无限增长
      const summary = summaryOf(s);
      let trimmed = 0;
      if (keepFiles > 0) {
        try {
          const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')).sort();
          if (files.length > keepFiles) {
            for (const f of files.slice(0, files.length - keepFiles)) {
              try {
                fs.unlinkSync(path.join(sessionsDir, f));
                trimmed += 1;
                try { ledger?.remove?.(f.slice(0, -5)); } catch { /* ignore */ }
              } catch { /* ignore */ }
            }
          }
        } catch { /* 目录读不到就当没东西可修剪 */ }
      }
      if (trimmed > 0) {
        const hit = readOnlyScanCache.get(sessionsDir);
        if (hit || durableHit) {
          try {
            const existing = new Set(fs.readdirSync(sessionsDir));
            const target = hit ?? durableHit;
            target.summaries = target.summaries.filter((row) => existing.has(`${row.id}.json`));
            target.diagnostics.bad = target.diagnostics.bad.filter((b) => existing.has(b.f));
            target.diagnostics.noIdFiles = (target.diagnostics.noIdFiles ?? []).filter((f) => existing.has(f));
            target.diagnostics.noId = target.diagnostics.noIdFiles.length;
            target.fp = dirFingerprintCheap(sessionsDir);
            if (hit) durableHit = hit;
            persistIndexAfterDelete();     // ★ S04：大索引下删除由读侧名字对账覆盖，不重写整份
          } catch {
            readOnlyScanCache.delete(sessionsDir);
            invalidateDiskIndex(indexFile);
          }
        } else invalidateDiskIndex(indexFile);
      }
      return { ok: persisted.ok, session: s, persisted, trimmed, summary };
    },

    /**
     * 彻底丢弃（旧 `discard`，旧 :420-438）：**只准丢 `waiting` 的** ——
     * 已经跑过、消耗过 token 的必须走 `finish`，否则用量/成本账对不上（旧 :425-426）。
     * @returns {{ok:boolean, reason?:string}}
     */
    discard(id) {
      const sid = String(id ?? '').trim();
      const s = current.get(sid);
      if (!sid) return { ok: false, reason: 'bad-id' };
      if (s && s.status !== 'waiting') return { ok: false, reason: 'has-run' };
      current.delete(sid);
      lastPersistAt.delete(sid);
      let unlinked = false;
      try {
        const file = sessionFile(sid, sessionsDir);
        if (fs.existsSync(file)) { fs.unlinkSync(file); unlinked = true; }
      } catch { /* ignore（旧 :432） */ }
      // ★ unlink 也是"改了 sessions 目录"⇒ 同样要让只读扫描缓存失效（否则 15s 内的只读还看得见这条）
      if (unlinked) removeCacheRow(sessionsDir, sid, diagnostics);   // ★ 从缓存里**?掉那一行**（不是整表丢；摘不掉才退回删条目）
      try { ledger?.remove?.(sid); } catch { /* ignore */ }
      const hit = readOnlyScanCache.get(sessionsDir);
      if (hit) {
        hit.fp = dirFingerprintCheap(sessionsDir);
        persistIndexAfterDelete();
      } else if (durableHit) {
        durableHit.summaries = durableHit.summaries.filter((row) => row.id !== sid);
        durableHit.fp = dirFingerprintCheap(sessionsDir);
        persistIndexAfterDelete();
      } else invalidateDiskIndex(indexFile);
      return { ok: true, unlinked };
    },

    /**
     * 回收站恢复后的"进程内补登记"（旧 `reingest`，旧 :454-466）。
     * ★ 与旧树的**实现差异**：旧树靠进程内 `index` 数组立刻可见；本模块读侧**没有缓存**
     *   （每次现扫盘）⇒ 这里只需确认文件可读，就已经是"立刻可见"。
     * @returns {{ok:boolean, visible:boolean, reason?:string}}
     */
    reingest(id) {
      const sid = String(id ?? '').trim();
      if (!sid || sid.includes('/') || sid.includes('\\') || sid.includes('..')) {
        return { ok: false, visible: false, reason: 'bad-id' };
      }
      let file;
      try { file = sessionFile(sid, sessionsDir); } catch { return { ok: false, visible: false, reason: 'bad-id' }; }
      if (!fs.existsSync(file)) return { ok: false, visible: false, reason: 'file-missing' };
      try {
        const data = readJsonLoose(file);
        return { ok: data?.id === sid, visible: data?.id === sid };
      } catch (error) {
        return { ok: false, visible: false, reason: `unreadable:${String(error?.message ?? error).slice(0, 60)}` };
      }
    },

    /** 直接把一份会话对象灌进 `current`（运行时从磁盘恢复运行中会话时用；不落盘）。 */
    __adopt(session) {
      if (!session?.id) return false;
      current.set(String(session.id), session);
      return true;
    },

    /** 写侧诊断：最近一次写失败原因 + 写/节流计数 + S04 追加日志状态。 */
    persistDiagnostics() {
      return {
        writes: diagnostics.writes,
        throttledSkips: diagnostics.throttledSkips,
        cachePatches: diagnostics.cachePatches,
        cachePatchErrors: diagnostics.cachePatchErrors,
        cachePatchedAt: diagnostics.cachePatchedAt,
        badEntries: diagnostics.badEntries,
        lastPersistError: diagnostics.lastPersistError,
        // ★ S04：journal 只在索引条目 ≥ minEntries 时启用；appendsSinceCompact 达到 maxAppends 即合并。
        indexJournal: {
          minEntries: INDEX_JOURNAL_MIN_ENTRIES,
          maxAppends: INDEX_JOURNAL_MAX_LINES,
          appendsSinceCompact: journalAppends
        },
        keepFiles,
        strict,
        currentCount: current.size
      };
    }
  };
  return registry;
}

/** 运行中落盘节流窗口（旧 :602-604：2000ms）。 */
export const PERSIST_THROTTLE_MS = 2000;

/** trigger 数组 → 展示文本（旧 `triggerEntriesToText`，旧 :656-660）。 */
export function triggerEntriesToText(trigger) {
  if (Array.isArray(trigger)) {
    return trigger.map((m) => `${m.senderName || m.senderId || '?'}: ${String(m.text ?? '').slice(0, 80)}`).join(' | ');
  }
  return '';
}

/** `now - keepDays` 天的时间戳（供调用方与自测对齐口径）。 */
export function cutoffFor(now, keepDays) {
  return Number(now) - Number(keepDays) * DAY_MS;
}
export { DAY_MS };
