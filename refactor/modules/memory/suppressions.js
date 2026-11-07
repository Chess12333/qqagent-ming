/**
 * M6 memory · 遗忘抑制账本（`memory/suppressions.jsonl`）
 *
 * 方案 §4.3 表：「`memory/suppressions.jsonl` — **不可当普通缓存清空**；遗忘抑制记录，
 * 防止同一批旧证据又被整理回来」；§5.4：「用户遗忘：撤回事实、失效派生视图，并写来源抑制记录，
 * **避免下一次后台整理从旧消息复活它**」。
 *
 * 为什么这份记录是必需的（不是可选的缓存）：
 *   没有它，遗忘并不彻底。时序如下：
 *     ① 用户说「别记我说过 X」→ `forget()` 撤回观察（当前有效集里没有了）。
 *     ② 但旧消息仍在聊天存档里，整理游标还没走过那一段。
 *     ③ 后台整理扫到那段旧消息 → 摘要/事实重新写回记忆 → X 又被记起来了。
 *   `forget()` 只能动 observations，动不了"还没被整理过的旧消息"，读侧也无法收住这个口子
 *   —— 抑制记录就是为了堵住它。
 *
 * 语义：抑制的是"来源"，不是"文本"。
 *   一条抑制记录表达的是「`chatKey` 中 `speakerId=X` 在 `since` 之后的消息，不许再被整理成事实」。
 *   这样：
 *   · 用户只撤回自己说过的那部分，不影响同一会话里别人的正常整理；
 *   · 模型换一种说法重提也绕不过去（限制的是来源，不是措辞）。
 *
 * 只追加、不改写（与 `changes.jsonl` 相同）：撤回本身也是历史的一部分。
 *   读取时按文件顺序归并：同一个 `(chatKey, speakerId)` 以最后写入的一条为准
 *   （不能比较 `at` —— 否则"重新记住"会被判成"又抑制了一次"，原因见下方 reinstate 的说明）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { memoryFile, ensureMemoryDir } from './data-dir.js';

const FILE = 'suppressions.jsonl';
const MEM_DIR = 'memory';

/**
 * 账本文件路径：**调用方显式给的 dataDir 优先**，没给才走 `data-dir.js` 的全局解析。
 * （改前 `suppressionTable({dataDir})` 收下这个参数却从不使用 —— `readAll` 里的
 *  `memoryFile()` 一律读全局解析出的目录。显式注入与全局不一致时，抑制会写到**另一个**
 *  目录里，调用方还以为写在了自己那个 dataDir。P0-3 落码时顺手补上。）
 */
function fileOf(name, dataDir) {
  if (typeof dataDir === 'string' && dataDir) return path.join(dataDir, MEM_DIR, name);
  return memoryFile(name);
}

function ensureDir(dataDir) {
  if (typeof dataDir === 'string' && dataDir) {
    const dir = path.join(dataDir, MEM_DIR);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  return ensureMemoryDir();
}

/** 键：同一会话同一个人只有一条生效记录（后写覆盖先写）。 */
function keyOf(chatKey, speakerId) {
  return JSON.stringify([String(chatKey ?? ''), String(speakerId ?? '')]);
}

/**
 * 读整个账本，并把**读健康**一并带出来。
 *
 * ★ 2026-10-17（安全审查）：改前这里是 `try { readFileSync } catch { return [] }` ——
 *   任何读失败都返回空集，而空集在下游**语义上等于"谁都没被遗忘"** ⇒ 整个点名遗忘失效，
 *   而且没有任何痕迹。所以必须把两种"空"分开：
 *     · `absent`（ENOENT）= 这个号/这个目录**还没写过**抑制 ⇒ 空账本是**正常状态**，
 *       与"读失败"完全不是一回事（新号首启就走这条路，不能因此报错或断供）。
 *     · `ok:false`（别的 errno：EACCES/EISDIR/EBUSY/… 或有坏行）= **读不全**。
 *       坏行仍跳过（既有取舍：一行坏 JSON 不许让整轮整理失败），但必须**记账**——
 *       坏掉的那行本身可能就是一条抑制记录，静默跳过 = 遗忘失效且无迹可寻。
 *
 * @returns {{rows:Array<object>, file:string, ok:boolean, absent:boolean,
 *            badLines:number, reason:string}}
 */
function readLedger(dataDir) {
  const file = fileOf(FILE, dataDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = String(error?.code ?? '');
    if (code === 'ENOENT') {
      return { rows: [], file, ok: true, absent: true, badLines: 0, reason: 'absent' };
    }
    return { rows: [], file, ok: false, absent: false, badLines: 0, reason: `unreadable:${code || 'unknown'}` };
  }
  const rows = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    const s = String(line || '').trim();
    if (!s) continue;
    try {
      const row = JSON.parse(s);
      if (row && typeof row === 'object') rows.push(row);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  return {
    rows,
    file,
    ok: badLines === 0,
    absent: false,
    badLines,
    reason: badLines ? `corrupt-lines:${badLines}` : ''
  };
}

/** 只取 rows 的薄包装（内部用；对外一律走 `suppressionLedgerHealth` 拿健康）。 */
function readAll(dataDir) {
  return readLedger(dataDir).rows;
}

/**
 * 把读健康挂到返回的 Map/Set 上（非枚举属性：不改变 JSON/展开/迭代的形状，
 * 现有调用点那些 `instanceof Set`、`.has`、`.size` 全部照旧）。
 *
 * 为什么不加一个新函数返回 `{ids, health}`：那要改全部调用点的解构形状，
 * 而本轮的要求是"正常可读情形输出不变"。挂属性是唯一能做到零调用点改动的方式。
 */
function attachHealth(target, ledger) {
  const l = ledger && typeof ledger === 'object' ? ledger : {};
  const health = {
    ok: l.ok !== false,
    absent: l.absent === true,
    badLines: Number(l.badLines) || 0,
    reason: String(l.reason || ''),
    file: l.file
  };
  try {
    Object.defineProperty(target, 'ledgerHealth', { value: health, enumerable: false, configurable: true });
  } catch { /* 挂不上就退化成"无标记"：调用方按未知处理，绝不因此抛错 */ }
  return target;
}

/**
 * 取回某张表/某个集合的读健康。
 *
 * 拿到的是普通 Map/Set（没有标记）⇒ 一律按 **ok** 处理（老行为），
 * 这样"判不了"永远只来自**明确读失败**，不会被一个漏挂标记静默变成断供。
 *
 * @returns {{ok:boolean, absent:boolean, badLines:number, reason:string, file?:string}}
 */
export function ledgerHealthOf(target) {
  const h = target?.ledgerHealth;
  if (!h || typeof h !== 'object') return { ok: true, absent: false, badLines: 0, reason: '', file: '' };
  return {
    ok: h.ok !== false,
    absent: h.absent === true,
    badLines: Number(h.badLines) || 0,
    reason: String(h.reason || ''),
    file: String(h.file || '')
  };
}

/** 只读账本健康，不建表（给只想知道"这条读腿能不能信"的调用方/诊断用）。 */
export function suppressionLedgerHealth({ dataDir } = {}) {
  const { rows, ...health } = readLedger(dataDir);
  void rows;
  return health;
}

/**
 * 生效的抑制表：`key -> {chatKey, speakerId, at, reason, suppressed:true|false}`。
 *
 * ★★ `suppressed` 是**显式布尔**，不是靠 `at` 推断的。原因（我自己踩过）：
 *   「重新记住」必须能被表达。若把"撤销"实现成"再写一条 at 更晚的抑制记录"，
 *   那条记录会把**它之后**的新消息重新抑制掉 —— 撤销变成了"从现在起重新封禁"，语义完全错。
 *   撤销只能写成 `suppressed:false`，读取时以最后写入的一条为准。
 */
export function suppressionTable({ dataDir } = {}) {
  const ledger = readLedger(dataDir);
  const table = new Map();
  for (const row of ledger.rows) {
    const k = keyOf(row.chatKey, row.speakerId);
    // 文件顺序即时间顺序：后写的直接覆盖（不比较 at）。
    table.set(k, {
      key: k,
      chatKey: String(row.chatKey ?? ''),
      speakerId: String(row.speakerId ?? ''),
      at: Number(row.at) || 0,
      reason: String(row.reason ?? ''),
      suppressed: row.suppressed !== false,
      evidenceIds: Array.isArray(row.evidenceIds) ? row.evidenceIds.slice(0, 32) : [],
    });
  }
  return attachHealth(table, ledger);
}

/**
 * 供管理端点 `GET /api/memory/suppressions` 读取的列表（2026-10-11）。
 *
 * 为什么需要它：界面上看不到"谁在哪个会话被抑制"，就没有可以点的行，`reinstate()` 再可用也没人能用。
 * 内容范围只有一条约定：只返回来源与状态，不返回聊天正文，也不返回证据编号。
 *
 * @param {object} [opts]
 *   · `dataDir`    显式目录优先，没给则用 data-dir.js 的全局解析（与本模块其余出口一致）
 *   · `activeOnly` 默认 true：只列仍在生效的抑制；传 false 则连已"重新记住"的也列出来
 *   · `limit`      1..500，默认 100
 * @returns {{items:Array<{chatKey:string,speakerId:string,at:number,reason:string,suppressed:boolean,writes:number}>,
 *            total:number, active:number, file:string}}
 *   `writes` = 这个键在账本里写过几行（抑制与解除抑制的来回次数，含已被后续写入覆盖的那些）
 *   `total`  = 符合 `activeOnly` 条件的条数（`limit` 截断之前）；`active` = 全表中仍在生效的条数
 */
export function listSuppressions({ dataDir = null, activeOnly = true, limit = 100 } = {}) {
  const take = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const writes = new Map();
  for (const row of readAll(dataDir)) {
    const k = keyOf(row.chatKey, row.speakerId);
    writes.set(k, (writes.get(k) || 0) + 1);
  }
  const items = [];
  let active = 0;
  for (const row of suppressionTable({ dataDir }).values()) {
    if (row.suppressed) active += 1;
    if (activeOnly && !row.suppressed) continue;
    items.push({
      chatKey: row.chatKey,
      speakerId: row.speakerId,
      at: row.at,
      reason: row.reason,
      suppressed: row.suppressed,
      writes: writes.get(row.key) || 0,
    });
  }
  items.sort((a, b) => b.at - a.at || String(a.chatKey).localeCompare(String(b.chatKey))
    || String(a.speakerId).localeCompare(String(b.speakerId)));
  // ★ 2026-10-17：读健康同 `suppressionStats` —— 面板上"空列表"必须能区分
  //   "没有生效中的抑制"与"账本没读出来"。
  const health = suppressionLedgerHealth({ dataDir });
  return {
    items: items.slice(0, take),
    total: items.length,
    active,
    file: fileOf(FILE, dataDir),
    ledgerOk: health.ok,
    ledgerAbsent: health.absent,
    ledgerBadLines: health.badLines,
    ledgerReason: health.reason
  };
}

/**
 * 写一条抑制记录（`forget()` 与 `requestConsolidation` 的丢弃分支都会调它）。
 *
 * @param {object} opts
 *   · `chatKey` / `speakerId` —— 被抑制的来源（缺一不可，否则无法判断"是不是同一个人"）
 *   · `at` —— 抑制生效时刻（**默认不填**：调用方应传真实时刻；不传就用 store 的时钟约定 Date.now）
 *   · `reason` —— 如实写为什么（`forget` / `manual` / `superseded`）
 *   · `evidenceIds` —— 被抑制的具体证据（可选，仅供审计）
 *   · `dataDir` —— 可选：显式写进哪个数据目录（缺省用 data-dir.js 的全局解析）
 * @returns {{ok:boolean, suppressed:boolean, key:string, count:number}}
 */
export function addSuppression({ chatKey, speakerId, at = 0, reason = 'forget', evidenceIds = [], dataDir = null } = {}) {
  const ck = String(chatKey ?? '');
  const sid = String(speakerId ?? '');
  if (!ck || !sid) return { ok: false, suppressed: false, key: '', count: 0, error: 'chatKey 与 speakerId 都必填' };
  const row = {
    key: keyOf(ck, sid),
    chatKey: ck,
    speakerId: sid,
    at: Number(at) > 0 ? Number(at) : Date.now(),
    reason: String(reason || 'forget'),
    suppressed: true,
    evidenceIds: (Array.isArray(evidenceIds) ? evidenceIds : []).map(String).slice(0, 32),
  };
  try {
    ensureDir(dataDir);
    fs.appendFileSync(fileOf(FILE, dataDir), `${JSON.stringify(row)}\n`, 'utf8');
    return { ok: true, suppressed: true, key: row.key, count: 1 };
  } catch (error) {
    return { ok: false, suppressed: false, key: row.key, count: 0, error: String(error?.message ?? error) };
  }
}

/**
 * 判断一条来源是否被抑制 —— **整理器写任何东西之前必过这一关**。
 *
 * ★ 2026-10-17（安全审查 · 写侧 fail-closed）：账本**读不全**时，这里一律返回 true。
 *   原先 `readAll` 读失败返回空表 ⇒ 空表判不出任何键 ⇒ `false` ⇒ 整理器照常从这条来源
 *   写出新事实 —— 而"写不出来"正是用户点了遗忘、账本却被 IO 错误挡住时的样子，
 *   等于在遗忘失效之上再叠一层"把忘掉的东西重新整理出来"。
 *   口径取舍：本函数原来的注释是"坏行宁可少抑制，不许让整轮整理失败"。
 *   现在只在**明确读失败/有坏行**时收紧，正常账本逐字不变；
 *   代价是账本坏掉期间不再新增事实（可恢复：账本一好就自动恢复）。
 *
 * @param {object} opts `{chatKey, speakerId, at}` —— `at` 是该条消息的时刻
 * @returns {boolean} true = 抑制中（或判不了），**不许再从它整理出事实**
 */
export function isSuppressed({ chatKey, speakerId, at = 0, table = null } = {}) {
  const ck = String(chatKey ?? '');
  const sid = String(speakerId ?? '');
  if (!ck || !sid) return false;
  const t = table || suppressionTable();
  if (ledgerHealthOf(t).ok === false) return true;   // 判不了 ≠ 没忘过
  const row = t.get(keyOf(ck, sid));
  if (!row || row.suppressed !== true) return false;   // 撤销后（reinstate）不抑制
  const from = Number(row.at) || 0;
  if (!from) return false;
  // 抑制只对**抑制时刻之后**的消息生效（用户先说的话不该被后来的遗忘吃掉）。
  const msgAt = Number(at) || 0;
  return msgAt <= 0 || msgAt >= from;
}

/** 批量过滤：给整理器用（一次读表、多次判定，别每条都开文件）。 */
export function makeSuppressionFilter({ dataDir } = {}) {
  const table = suppressionTable({ dataDir });
  return (opts) => isSuppressed({ ...opts, table });
}

/**
 * 被**点名**忘掉的具体来源编号（生效中的抑制记录里逐条列出的那些证据）。
 *
 * ★ 读侧判据只有这一份，且**刻意不是** `isSuppressed` 的 `[from, ∞)` 窗口：
 *   · 窗口口径是给**写侧**用的（"这个人从这里往后的新消息先别再整理成事实"），它按
 *     (会话, 发言人) 封人；读侧照抄就会**连坐** —— 同一会话里没被忘的旧内容会被一起隐去。
 *     `coordinator.selftest.mjs:172` 钉的正是这条边界（"不许连坐"），别再改回去。
 *   · 用户说的"把这件事忘掉"指的正是 `forget()` 逐条列名进账本的那几条来源，
 *     读侧要收的就是这些。
 *
 * 用在三个读点上（各按自己的行形状比对，判据都来自这里）：
 *   · `memory/index.js retrieve()` —— 关键词那条腿的观察候选（行自带 `evidenceIds`）
 *   · `memory/coordinator.js recallWithSemantic()` —— 语义那条腿的观察候选（同上）
 *   · `memory/chat-search.js` —— 关键词检索：存档行没有编号，先由证据账本把编号换成
 *     `(发言人, 时刻)` 再比对
 *
 * 情节摘要那条腿（`coordinator.js:663` 一带）沿用**窗口**口径，那是 P0-3 的既有设计，本轮不动。
 *
 * **判不了就如实放行**：编号在账本里查不到证据行的，不算抑制 —— 把"查不到"当成"已抑制"
 * 等于把整段会话记忆静默切断（`coordinator.selftest.mjs:173` 那条反向检查钉这一点）。
 *
 * reinstate 后原样回来：撤销写的是 `suppressed:false`，这些编号随之从集合里退场。
 *
 * @param {object} [opts] `{dataDir}` —— 显式目录优先，缺省走 `data-dir.js` 的全局解析
 * @returns {Set<string>} 生效中的被点名编号
 */
export function namedSuppressedEvidenceIds({ dataDir } = {}) {
  const table = suppressionTable({ dataDir });   // 只读一次账本
  const ids = new Set();
  for (const row of table.values()) {
    if (row.suppressed !== true) continue;
    for (const id of row.evidenceIds || []) {
      const s = String(id ?? '').trim();
      if (s) ids.add(s);
    }
  }
  // 集合本身照旧（`instanceof Set`、`.has`、`.size` 全不变）；健康挂在非枚举属性上，
  // 读腿据此判断"这道过滤能不能信"，而不是靠"集合是不是空"去猜。
  return attachHealth(ids, ledgerHealthOf(table));
}

/**
 * 一批来源编号里有没有**被点名**的 —— 读侧两处观察腿共用这一句判定。
 *
 * 只比编号，不看时间、不看发言人：没被点名的行一律返回 false（不连坐）。
 *
 * @param {Array<string>} evidenceIds 行自带的来源编号
 * @param {Set<string>} named `namedSuppressedEvidenceIds()` 的产物
 * @returns {boolean} true = 这一行不许再进模型眼前
 */
export function namesSuppressedSource(evidenceIds, named) {
  if (!(named instanceof Set) || named.size === 0) return false;
  for (const id of Array.isArray(evidenceIds) ? evidenceIds : []) {
    if (named.has(String(id ?? '').trim())) return true;
  }
  return false;
}

/** 只读统计（给 `status()`；不返回任何聊天正文）。 */
export function suppressionStats({ dataDir } = {}) {
  const table = suppressionTable({ dataDir });
  let active = 0;
  for (const row of table.values()) if (row.suppressed) active += 1;
  // ★ 2026-10-17（qwen3 审查修）：原先回的是 `memoryFile(FILE)` —— 它无视调用方显式给的 `dataDir`，
  //   报的是全局解析那个目录：① 显式目录与全局不同时路径报错（计数却是对的，两者不一致更误导）；
  //   ② 没设 override/QQ_AGENT_DATA_DIR 时 `getDataDir()` 直接抛错，把一个只读计数出口变成会抛。
  //   改成本模块统一的 `fileOf`（显式目录优先，缺省才回全局解析），与 `listSuppressions` 一致。
  // ★ 2026-10-17（安全审查）：把读健康一起带出来。`keys:0 / active:0` 在"账本读失败"和
  //   "这个号还没忘过任何东西"两种情况下长得一模一样 —— 面板据此看不出遗忘到底生没生效。
  const health = ledgerHealthOf(table);
  return {
    keys: table.size,
    active,
    file: fileOf(FILE, dataDir),
    ledgerOk: health.ok,
    ledgerAbsent: health.absent,
    ledgerBadLines: health.badLines,
    ledgerReason: health.reason
  };
}

/**
 * 显式撤回一条抑制（= 用户说"重新记住"）。
 * 方案 §5.4：「明确新的『重新记住』可以开启新版本」⇒ 抑制必须可撤销。
 *
 * 实现：**追加一条 `suppressed:false` 的记录**（读取时以最后写入的一条为准，因此天然生效）。
 * 不做物理删除 —— 抑制历史本身也是历史。
 * 这里不能用"再写一条 at 更晚的抑制记录"来撤销（那样会把这个会话之后的新消息一并封禁）。
 *
 * 2026-10-11 修改：**先查有没有生效中的抑制，没有就什么都不写**。
 *   改前无论有没有生效中的抑制都照样追加一行并返回 `reinstated:true`，于是对从没被遗忘过的人
 *   点"重新记住"也会返回成功，账本里还多出一条没有意义的解除抑制记录。
 *   现在：没有生效中的抑制 ⇒ `{ok:true, reinstated:false, reason:'no-active-suppression'}`，不写文件。
 *   `ok` 仍为 true：请求本身合法、也确实没有要解除的东西，只是不能报告"已解除"。
 */
export function reinstate({ chatKey, speakerId, at = 0, note = '', dataDir = null } = {}) {
  const ck = String(chatKey ?? '');
  const sid = String(speakerId ?? '');
  if (!ck || !sid) return { ok: false, reinstated: false, error: 'chatKey 与 speakerId 都必填' };
  const key = keyOf(ck, sid);
  const active = suppressionTable({ dataDir }).get(key);
  if (!active || active.suppressed !== true) {
    return { ok: true, reinstated: false, reason: 'no-active-suppression', key };
  }
  const row = {
    key,
    chatKey: ck,
    speakerId: sid,
    at: Number(at) > 0 ? Number(at) : Date.now(),
    reason: 'reinstate',
    suppressed: false,
    note: String(note || '').slice(0, 200),
    evidenceIds: [],
  };
  try {
    ensureDir(dataDir);
    fs.appendFileSync(fileOf(FILE, dataDir), `${JSON.stringify(row)}\n`, 'utf8');
    return { ok: true, reinstated: true, key: row.key, at: row.at };
  } catch (error) {
    return { ok: false, reinstated: false, error: String(error?.message ?? error) };
  }
}

export { ensureMemoryDir };
