/**
 * M6 memory · store（证据账本 + 观察版本，**追加写**）
 *
 * 五个层次里的 A/B/C/D 就落在这里（E 是视图，见 cards.js / index.js 的 brief()）：
 *   A 原始事件   → `evidence.jsonl`（消息/图片元信息/工具回执，**只追加**，能回到原始证据）
 *   B 证据记录   → evidence.jsonl 里的 `sourceType`（自述/转述/引用/模型推测/机器人输出/工具确认）
 *   C 当前观察   → `observations.jsonl`（多版本，`supersedes` 链，**不做物理删除**）
 *   D 对话状态   → 同一张表里 `type:'topic'|'promise'|'question'|'recent'` 的观察（短期状态）
 *   审计         → `changes.jsonl`（`audit()` 的数据源）+ 旧 `audit.jsonl`（memory-audit.js）
 *
 * ★ 不变量（README 验收 + 派单）：
 *   1. **没有证据不许写**：`evidenceIds` 非空**且**每条都能在证据账本里查到，否则拒。
 *   2. **duplicate / 重试不许产生多份"独立支持"**：同一 claim 的支撑数按**去重后的证据 ID** 算，
 *      且只有**当前版本**的证据算数（旧版本被 supersede 后不再贡献支撑）。
 *   3. **修订保留旧版本**，当前不再沿用（旧版本标 `superseded`，行还在数据文件里）。
 *   4. 删来源 → **撤回**依赖它的观察（标 `retracted`），**永不物理删除**。
 *   5. 读取失败/坏行**不许抛给主流程**（逐行 try，坏行跳过并计入 `badLines`）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/util/index.js';
import { memoryDir, memoryFile, ensureMemoryDir } from './data-dir.js';

const FILES = {
  evidence: 'evidence.jsonl',
  observations: 'observations.jsonl',
  changes: 'changes.jsonl',
  idempotency: 'idempotency.jsonl',
  // 命中计数走**追加日志**（一行一次命中），读时归并。
  // 为什么不用 cards.json 整文件覆盖：两个写者（同进程并发 / 多实例）后写者会把前者的计数抹掉；
  // 追加写不会互相覆盖，单行小写入也基本原子（指挥位 2026-10-04 的第 3 条决定）。
  hits: 'cards-hits.jsonl',
};

/** 观察类型（C 稳定认识 / D 短期状态分开，**不许混成稳定印象**）。 */
export const OBS_TYPES = ['impression', 'trait', 'preference', 'fact', 'topic', 'promise', 'question', 'recent'];

/**
 * ★ 2026-10-16（一键清理 C 的安全前提）：印象**子类**的 provenance 枚举（落在观察行的
 * `impressionTypeSource` 上；`impressionType` 则是模型/门给出的原始子类，取值 = 旧树 IMP_TYPES）。
 *   · `'model'` —— 写这条的模型在工具参数里明确给了子类（`act/executors/memory.js` 的 memory_append）；
 *   · `'none'`  —— 明确"没有子类"（同一条写路径，模型没给）⇒ 一键清理 C 的合法候选；
 *   · `'gate'`  —— 后来由模型门补判（`cleanupAll({ apply:true, typeGate })` 的升版写入）；
 *   · **没有这个键 = 历史行**（元数据机制之前写入）⇒ 事后不可反推，一键清理**一律不动**。
 * ⚠ `cleanup-actions.js` 里有一份同名副本（那个模块零 import）；改这里要同步改那里。
 */
export const IMPRESSION_TYPE_SOURCES = Object.freeze(['model', 'none', 'gate']);

/** 证据来源类型（B 层）。 */
export const SOURCE_TYPES = ['self_report', 'relay', 'quote', 'model_infer', 'bot_output', 'tool_confirm', 'message'];

/**
 * 「发信人是机器人自己」的那两类来源（`index.js` 的遗忘抑制也按这两类排除机器人自己的发言）。
 * ★ 这是**行的形状映射**（哪条证据算她自己说的话），不是可见性判据；
 *   可见性只由 `emotion/persona-hygiene.js` 那份 `selfRowVisibleNow` 决定。
 */
export const SELF_SOURCE_TYPES = ['bot_output', 'tool_confirm'];

const stores = new Map(); // dataDir -> store

// ── 小工具 ────────────────────────────────────────────────────────────────

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const s = String(x ?? '');
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** claim 归一化：判"说法变没变"与 claimKey 用**同一把尺**（trim + 压空白 + 小写）。 */
function normClaim(claim) {
  return String(claim ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** claimKey：同一 subject 在同一 scope 下"说的是同一件事"的归一化键（= 语义卡 ID）。 */
export function claimKeyOf(subjectId, scope, claim, chatKey, accountId = 'default') {
  const norm = normClaim(claim);
  const ns = { accountId, scope, chatKey: scope === 'global' ? 'global' : String(chatKey ?? '') };
  return JSON.stringify(['v2', ns, subjectId, norm]);
}

function readJsonl(file) {
  let text = '';
  try {
    if (!fs.existsSync(file)) return { rows: [], badLines: 0 };
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { rows: [], badLines: 0 };
  }
  const rows = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      badLines += 1;
    }
  }
  return { rows, badLines };
}

function appendJsonl(file, row) {
  ensureMemoryDir();
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

/**
 * ★ 2026-10-16（独立审查必须修项）：**一次 write 写两行**（新行 + 旧版 status 行）。
 * 原来两次 append 之间的失败窗口 = "新行在、旧版 status 行缺" ⇒ 文件里同一 claim 两行都 active。
 * 合成一个 buffer 之后只剩两种可判定的结果：
 *   · 整段没落（append 抛错且探针查不到新行）⇒ 干净失败：内存/文件都没变，原样抛；
 *   · 前缀落了（新行在、status 行缺）⇒ 已写入事实成立，调用方按 partial 如实记账 + 自愈（见 writeObservation）。
 */
function appendJsonlPair(file, first, second) {
  ensureMemoryDir();
  fs.appendFileSync(file, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, 'utf8');
  return first;
}

/**
 * ★ 2026-10-16：追加失败后的**实况探针**（只在失败路径/自愈路径用，正常路径零开销）。
 * 读文件判断某行是否真在盘上；读不了 ⇒ false（保守：宁可按"没落"处理，走干净失败）。
 */
function fileHasLine(file, needle) {
  try { return fs.readFileSync(file, 'utf8').includes(needle); } catch { return false; }
}

/** status 行的判据串（键序与写入一致：t,id,status ⇒ 精确匹配、不会与 obs 行撞）。 */
function supersededNeedle(id) {
  return `"t":"status","id":"${id}","status":"superseded"`;
}

/** 每个 dataDir 一把内存锁：并发 commit 不许互相覆盖（串行化同 store 的写）。 */
function withLock(store, fn) {
  const run = async () => fn();
  const prev = store.lock || Promise.resolve();
  const next = prev.then(run, run);
  store.lock = next.catch(() => {});   // 锁本身不传播失败
  return next;
}

// ── 打开 / 装载 ────────────────────────────────────────────────────────────

/**
 * 打开（或复用）某个 dataDir 的记忆存储，按需从数据文件重放 JSONL。
 * `dataDir` 不给就用 data-dir.js 的解析结果（`<dataDir>/memory/`）。
 */
export function openStore(dataDir = memoryDir()) {
  const key = path.resolve(dataDir);
  const cached = stores.get(key);
  if (cached) return cached;

  const store = {
    dataDir: key,
    files: {},
    evidence: new Map(),      // evidenceId -> 证据行
    obs: new Map(),           // observationId -> 版本行（含 status）
    claims: new Map(),        // claimKey -> { claimKey, subjectId, scope, chatKey, activeId, versions:[], writes, hits, ... }
    changes: [],              // 变更审计行（内存里保留全量，给 audit()）
    idem: new Map(),          // idempotencyKey -> commit 结果
    orphanHits: new Map(),    // 命中日志里出现、但当前没有对应卡片的 cardId -> 次数（不丢，留着）
    badLines: 0,
    derivedSupersedes: 0,   // ★ 2026-10-16：装载对账派生出来的 superseded 条数（磁盘上没有 status 行的那些）
    lock: null,
    loaded: false,
  };
  for (const [k, name] of Object.entries(FILES)) store.files[k] = path.join(key, 'memory', name);
  stores.set(key, store);
  load(store);
  return store;
}

/** 从数据文件重放（幂等；坏行只计数不抛）。 */
export function load(store) {
  const { rows: evRows, badLines: evBad } = readJsonl(store.files.evidence);
  const { rows: obsRows, badLines: obsBad } = readJsonl(store.files.observations);
  const { rows: chRows, badLines: chBad } = readJsonl(store.files.changes);
  const { rows: idemRows, badLines: idemBad } = readJsonl(store.files.idempotency);
  const { rows: hitRows, badLines: hitBad } = readJsonl(store.files.hits);
  store.badLines = evBad + obsBad + chBad + idemBad + hitBad;

  store.evidence.clear();
  store.obs.clear();
  store.claims.clear();
  store.changes.length = 0;
  store.idem.clear();
  store.orphanHits.clear();

  for (const row of evRows) if (row && row.id) store.evidence.set(String(row.id), row);

  for (const row of obsRows) {
    if (!row || !row.id) continue;
    if (row.t === 'status') applyStatus(store, row);
    else if (row.t === 'obs') applyVersion(store, row);
  }

  for (const row of chRows) if (row && row.at) store.changes.push(row);
  for (const row of idemRows) if (row && row.key) store.idem.set(String(row.key), row.result);

  // 命中计数：**从追加日志归并**（一行一次命中）——
  // 这样"另一个写者（同进程并发/多实例）追加的行"也在，不存在后写者抹掉前者的问题。
  for (const row of hitRows) {
    if (!row || row.t !== 'hit' || !row.cardId) continue;
    let cardId = String(row.cardId);
    if (store.aliases && store.aliases.has(cardId)) cardId = store.aliases.get(cardId);
    const card = store.claims.get(cardId);
    if (!card) { store.orphanHits.set(String(row.cardId), (store.orphanHits.get(String(row.cardId)) || 0) + 1); continue; }
    card.hits += 1;
    if (!card.lastHitAt || Number(row.at) > Number(card.lastHitAt)) card.lastHitAt = Number(row.at) || card.lastHitAt;
  }

  // ★ 2026-10-16（独立审查必须修项）：重放完做一次**只读对账**（派生在内存里，不写盘、不删任何行）。
  reconcileSupersedes(store);

  store.loaded = true;
  return store;
}

/**
 * ★ 2026-10-16（独立审查必须修项）：**装载对账**。
 *
 * 为什么需要：追加失败/历史数据可能留下"同一 claim 里多行还标着 active，但磁盘上缺那条
 * superseded status 行"（正是本次修的失败窗口的残留形态）。行都在文件里（不丢），可 `status`
 * 口径会让 `activeObservations()` / 历史读数出现双 active。
 *
 * 口径：claim 卡片的 `activeId` 是重放顺序里**最后生效**的版本 ⇒ 它之前、仍标 active 的版本，
 * 在内存里降为 `superseded`（带 `supersededDerived: true`，标明"磁盘上没有对应 status 行，
 * 这是装载派生"）。**只读**：不写文件、不删行、不动 `status === 'retracted'` 的行；
 * 真正的补齐走两条自愈路径（重复调用 `healSupersedeStatus` / 下次同 claim 写入）。
 * @returns {number} 派生条数（同时写进 `store.derivedSupersedes`，供 stats/盘点显示）
 */
function reconcileSupersedes(store) {
  let derived = 0;
  for (const card of store.claims.values()) {
    const activeId = String(card.activeId ?? '');
    if (!activeId) continue;                       // 没有生效版本（如已撤回）⇒ 不派生
    for (const id of card.versions) {
      if (String(id) === activeId) break;          // versions 按写入顺序：activeId 之前的才是旧版
      const row = store.obs.get(String(id));
      if (!row || row.t === 'status-only' || row.status !== 'active') continue;
      row.status = 'superseded';
      row.supersededBy = activeId;
      row.supersededDerived = true;
      derived += 1;
    }
  }
  store.derivedSupersedes = derived;
  return derived;
}

/**
 * ★ 2026-10-16：**重复调用自愈** —— 幂等重放时，如果这条观察取代了旧版、而磁盘上缺那条
 * status 行（上次追加失败），补写一次（best-effort，不抛、不删）。真的不缺就不写（探针先查）。
 * @returns {boolean} 是否补写了
 */
function healSupersedeStatus(store, id) {
  const row = id ? store.obs.get(String(id)) : null;
  const targetId = row?.supersedes ? String(row.supersedes) : '';
  if (!targetId) return false;
  if (fileHasLine(store.files.observations, supersededNeedle(targetId))) return false;   // 已补齐 ⇒ 幂等
  try {
    appendJsonl(store.files.observations, { t: 'status', id: targetId, status: 'superseded', supersededBy: String(id), at: row.at });
    const target = store.obs.get(targetId);
    if (target && target.status === 'active') { target.status = 'superseded'; target.supersededBy = String(id); }
    return true;
  } catch { return false; }
}

/** 关闭并丢弃内存态（测试用；不影响数据文件）。 */
export function closeStore(dataDir) {
  if (dataDir === undefined) { stores.clear(); return; }
  stores.delete(path.resolve(dataDir));
}

function ensureClaim(store, row) {
  let key = claimKeyOf(row.subjectId, row.scope, row.claim, row.chatKey);
  if (row.claimKey && row.claimKey !== key) {
    if (!store.aliases) store.aliases = new Map();
    store.aliases.set(row.claimKey, key);
  }
  row.claimKey = key; // mutate to new key so callers see it
  
  let card = store.claims.get(key);
  if (!card) {
    card = {
      claimKey: key, subjectId: row.subjectId, scope: row.scope, chatKey: row.chatKey ?? '',
      activeId: null, versions: [], writes: 0, hits: 0, lastWriteAt: null, lastHitAt: null,
    };
    store.claims.set(key, card);
  }
  return card;
}

function applyVersion(store, row) {
  const id = String(row.id);
  const status = store.obs.get(id);   // 先前若有 status 行，保留其状态
  const merged = { ...row, id, status: status?.status ?? row.status ?? 'active' };
  if (status) {
    merged.status = status.status;
    if (status.supersededBy) merged.supersededBy = status.supersededBy;
    if (status.retractedBy) merged.retractedBy = status.retractedBy;
  }
  store.obs.set(id, merged);
  const card = ensureClaim(store, merged);
  if (!card.versions.includes(id)) card.versions.push(id);
  card.writes = card.versions.length;   // 写入次数 = 已保存的版本数
  card.lastWriteAt = merged.at ?? Date.now();
  if (merged.status === 'active') card.activeId = id;
}

function applyStatus(store, row) {
  const id = String(row.id);
  const cur = store.obs.get(id);
  if (cur) {
    cur.status = row.status;
    if (row.supersededBy) cur.supersededBy = row.supersededBy;
    if (row.retractedBy) cur.retractedBy = row.retractedBy;
    let cKey = cur.claimKey; if (store.aliases && store.aliases.has(cKey)) cKey = store.aliases.get(cKey); const card = store.claims.get(cKey);
    if (card && card.activeId === id && row.status !== 'active') card.activeId = null;
  } else {
    // status 行先于版本行（不该发生，但别丢信息）
    store.obs.set(id, { t: 'status-only', id, status: row.status, supersededBy: row.supersededBy ?? null });
  }
}

// ── 证据账本（A/B） ────────────────────────────────────────────────────────

/**
 * 一条原始事件归一化（MessageEvidence 形状即可，字段多几个少几个都能收）。
 *
 * ★ 双人格归属标（2026-10-13 指挥位批准，口径同 M6：**打标不拦**）：
 *   · 机器人自己说的话（`sourceType` ∈ `SELF_SOURCE_TYPES`）落 `self: true` ——
 *     群友的行**不落这个键**，读侧因此恒可见（隔离只隐"她自己说过的"，不隐世界）；
 *   · `ctx.persona2 === true`（红在位）时**再加** `persona2: true`；只有 true 才落键 ⇒
 *     蓝在位写入与存量一样是"无标 = 第一人格"，**数据一个字节都不必迁移**；
 *   · 标错了不拦写：非 boolean 的 `ctx.persona2` 一律按第一人格（无标）落，绝不静默丢行。
 * @returns {{ok:boolean, row?:object, error?:string}}
 */
export function normalizeEvidence(e, ctx = {}) {
  if (!e || typeof e !== 'object') return { ok: false, error: '证据必须是对象' };
  const id = String(e.id ?? '');
  if (!id) return { ok: false, error: '证据缺 id（没有 id 就无法回指原始证据）' };
  const at = Number(e.at);
  if (!Number.isFinite(at)) return { ok: false, error: `证据 ${id} 缺 at（时间戳）` };
  const chatKey = String(e.chatKey ?? ctx.chatKey ?? '');
  if (!chatKey) return { ok: false, error: `证据 ${id} 缺 chatKey` };
  const kind = e.kind === 'private' ? 'private' : (ctx.kind === 'private' ? 'private' : 'group');
  const sourceType = SOURCE_TYPES.includes(e.sourceType) ? e.sourceType : 'message';
  const mentionIds = Array.isArray(e.mentions) ? e.mentions.map((m) => m?.id).filter(Boolean) : [];
  const isSelfRow = SELF_SOURCE_TYPES.includes(sourceType);
  return {
    ok: true,
    row: {
      t: 'evidence',
      id,
      at,
      chatKey,
      kind,
      speakerId: String(e.sender?.id ?? e.senderId ?? ''),
      speakerName: String(e.sender?.name ?? e.senderName ?? ''),
      sourceType,
      subjectIds: uniq([...(Array.isArray(e.subjectIds) ? e.subjectIds : []), ...mentionIds]),
      text: typeof e.text === 'string' ? e.text : '',
      refs: e.refs ?? null,
      media: Array.isArray(e.media) ? e.media : [],
      toolReceipt: e.toolReceipt ?? null,
      ...(isSelfRow ? { self: true } : {}),
      ...(isSelfRow && ctx.persona2 === true ? { persona2: true } : {}),
    },
  };
}

/**
 * 追加进证据账本。**重复 id 不重复写**（同一证据永远只有一份）。
 * `ctx.persona2 === true` ⇒ 机器人自己的行带上红人格归属标（见 `normalizeEvidence`）。
 * @returns {{added:string[], duplicate:string[], invalid:{id:string,error:string}[]}}
 */
export function ingestEvidence(store, list, ctx = {}) {
  const added = [];
  const duplicate = [];
  const invalid = [];
  for (const item of list || []) {
    const norm = normalizeEvidence(item, ctx);
    if (!norm.ok) { invalid.push({ id: String(item?.id ?? ''), error: norm.error }); continue; }
    if (store.evidence.has(norm.row.id)) { duplicate.push(norm.row.id); continue; }
    appendJsonl(store.files.evidence, norm.row);
    store.evidence.set(norm.row.id, norm.row);
    added.push(norm.row.id);
  }
  return { added, duplicate, invalid };
}

/** 证据是否在账本里（"没有证据不许写"的判据）。 */
export function hasEvidence(store, id) {
  return store.evidence.has(String(id));
}

export function getEvidence(store, id) {
  return store.evidence.get(String(id)) ?? null;
}

// ── 观察（C/D） ────────────────────────────────────────────────────────────

function recordChange(store, row) {
  const full = { ts: Date.now(), at: new Date().toISOString(), ...row };
  appendJsonl(store.files.changes, full);
  store.changes.push(full);
  return full;
}

function persistCards(store) {
  const cards = {};
  for (const [k, c] of store.claims) {
    cards[k] = { writes: c.writes, hits: c.hits, lastHitAt: c.lastHitAt ?? null, activeId: c.activeId };
  }
  writeJsonAtomic(store.files.cards, { v: 1, updatedAt: Date.now(), cards });
}

/**
 * 写一条观察（幂等 + 去重 + 版本化）。**不做校验** —— 校验在 index.js 的 commit() 里做，
 * 这里假定入参已经是合法形状（避免两处校验走偏）。
 */
export function writeObservation(store, input, { idempotencyKey = '', duplicateWindow = true } = {}) {
  return withLock(store, async () => {
    if (idempotencyKey && store.idem.has(idempotencyKey)) {
      const replayResult = { ...store.idem.get(idempotencyKey), replay: true };
      // ★ 2026-10-16：重复调用**自愈** —— 上次若"新行在、旧版 status 行缺"（部分成功），这次顺手补齐
      //   （best-effort；已在盘上就什么都不做 ⇒ 幂等）。
      healSupersedeStatus(store, replayResult.id);
      return replayResult;
    }

    const evidenceIds = uniq(input.evidenceIds);
    const counterEvidenceIds = uniq(input.counterEvidenceIds);
    const claimKey = claimKeyOf(input.subjectId, input.scope, input.claim, input.chatKey);
    const card = store.claims.get(claimKey);
    const active = card?.activeId ? store.obs.get(card.activeId) : null;

    // ① 重复：同一 claim、同一证据（新证据不超出已有证据集）→ 不产生新版本、不加支持数
    if (active && duplicateWindow) {
      const known = new Set(active.evidenceIds || []);
      const fresh = evidenceIds.filter((id) => !known.has(id));
      if (fresh.length === 0 && !input.supersedes) {
        const result = {
          ok: true, duplicate: true, id: active.id, claimKey, version: active.version,
          supportCount: active.evidenceIds.length, evidenceIds: active.evidenceIds.slice(),
          writes: card.writes, hits: card.hits,
        };
        recordChange(store, {
          action: 'duplicate', id: active.id, subjectId: input.subjectId, claim: input.claim,
          scope: input.scope, chatKey: input.chatKey ?? '', evidenceIds, version: active.version,
          reason: '同一证据重复写入：不产生新的独立支持',
        });
        if (idempotencyKey) { appendIdem(store, idempotencyKey, result); }
        return result;
      }
    }

    // ② 修订：supersedes 指定旧版本，或同一 claim 已有 active 版本（隐式取代）
    const supersedesId = input.supersedes ? String(input.supersedes) : (active ? active.id : null);
    let version = 1;
    // ★ P0-2（功能表 5 · 2026-10-11）：这一版是不是**更正**（改说法）。
    //   只有"取代了某张卡 + 说法确实变了"才是更正；同一说法补一条新证据只是升版本，
    //   那种**不算**更正（提示词里不该把普通补证据当成"用户改口"）。
    //   生产者只有这一处 —— `prompt/index.js:607` 的三判据读 `row.correction === true`，
    //   读端（memory/index.js retrieve 白名单 + coordinator 语义 keep）负责把它带出去。
    let correction = false;
    let supersedeTarget = null;   // ★ 2026-10-16：旧版的 superseded 状态行延后到新行落地之后再写（见下）
    if (supersedesId) {
      const target = store.obs.get(supersedesId);
      if (!target) throw new Error(`supersedes 指向不存在的观察：${supersedesId}`);
      // 修订的锚点是**同一个主体 + 同一个范围**；claim 允许被改写（"用户更正"就是要改说法）。
      // 旧实现把改正确的写法直接原地覆盖（旧文本不保留）—— 这里改成新版本 + 旧版留档。
      if (String(target.subjectId) !== String(input.subjectId) || target.scope !== input.scope) {
        throw new Error(`supersedes 的 subjectId/scope 与被写入的观察不一致：${supersedesId}`);
      }
      version = (Number(target.version) || 1) + 1;
      correction = normClaim(target.claim) !== normClaim(input.claim);
      supersedeTarget = target;
      // ★ 2026-10-16（一键清理 C 的事务前提）：**先落新行、再标旧版**（原来是反过来）。
      //   两个 append 都是独立调用 ⇒ 中间失败原本会留下"旧版已 superseded、新版没落地"= 这条卡没了；
      //   换序后任何一步失败都至少保住旧版（文件里旧行仍 active；重放时若新行已在，则由新行接管
      //   activeId —— 见本文件 `applyVersion`/`applyStatus` 的重放口径）。旧版**永不物理删除**。
    }

    const row = {
      t: 'obs',
      id: String(input.id),
      subjectId: String(input.subjectId),
      claim: String(input.claim),
      claimKey,
      type: OBS_TYPES.includes(input.type) ? input.type : 'impression',
      scope: input.scope,
      kind: input.kind ?? (input.scope === 'private' ? 'private' : 'group'),
      chatKey: String(input.chatKey ?? ''),
      evidenceIds,
      counterEvidenceIds,
      confidence: input.confidence,
      at: Number(input.at),
      validUntil: input.validUntil ?? null,
      supersedes: supersedesId,
      // 只在"取代了旧卡"的版本上写（没有 supersedes 的普通新卡不该带这个键）
      ...(supersedesId ? { correction } : {}),
      version,
      status: 'active',
      createdAt: Date.now(),
      ...(input.schemaVersion !== undefined ? { schemaVersion: input.schemaVersion } : {}),
      ...(input.namespace !== undefined ? { namespace: input.namespace } : {}),
      ...(input.memoryClass !== undefined ? { memoryClass: input.memoryClass } : {}),
      ...(input.factSlot !== undefined ? { factSlot: input.factSlot } : {}),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      ...(input.sourceRefs !== undefined ? { sourceRefs: input.sourceRefs } : {}),
      ...(input.crossChatShareable === true ? { crossChatShareable: true } : {}),
      // ★ 双人格归属标（2026-10-13 裁定：打标不拦）。只有 true 才落键 ⇒ 无标 = 第一人格写的，
      //   存量数据一个字节都不变；读侧判据在 `emotion/persona-hygiene.js`（全树唯一实现）。
      ...(input.persona2 === true ? { persona2: true } : {}),
      ...(input.todoId !== undefined ? { todoId: input.todoId } : {}),
      // ★ 2026-10-16（一键清理 C 的安全前提）：印象子类与它的 provenance —— **只在提供且形状合法时落键**
      //   （不补默认值：老行没有这两个键，读侧一律按"历史行、不可反推"处理，见 IMPRESSION_TYPE_SOURCES）。
      ...(typeof input.impressionType === 'string' && input.impressionType.trim()
        ? { impressionType: String(input.impressionType).trim().slice(0, 32) } : {}),
      ...(IMPRESSION_TYPE_SOURCES.includes(String(input.impressionTypeSource ?? ''))
        ? { impressionTypeSource: String(input.impressionTypeSource) } : {})
    };
    // ★ 2026-10-16（独立审查必须修项）：**新行 + 旧版 status 行一次写**（一个 buffer 一次 append），
    //   把"两次 append 之间失败"的窗口压掉。三条边界见下（成功 / 部分成功 / 干净失败）。
    const statusLine = supersedeTarget
      ? { t: 'status', id: supersedesId, status: 'superseded', supersededBy: String(input.id), at: input.at }
      : null;
    const warnings = [];
    try {
      if (statusLine) appendJsonlPair(store.files.observations, row, statusLine);
      else appendJsonl(store.files.observations, row);
    } catch (error) {
      // ① 干净失败：探针查不到新行 ⇒ 文件/内存都没变 ⇒ 原样抛（不把"没写"报成"写了"）。
      if (!fileHasLine(store.files.observations, `"t":"obs","id":"${row.id}"`)) throw error;
      // ② 新行已落盘（status 行可能缺）⇒ 已写入事实成立，**不 thrown 掩盖**：先补一次 status 行
      //    （best-effort）；补上了记 `append-failed-recovered`（信息性），补不上记
      //    `supersede-status-line-missing`（**真缺数据** ⇒ partial），重复调用/下次装载都能自愈。
      const detail = { error: String(error?.message ?? error).slice(0, 160) };
      let statusOnDisk = !statusLine || fileHasLine(store.files.observations, supersededNeedle(supersedesId));
      if (statusLine && !statusOnDisk) {
        try { appendJsonl(store.files.observations, statusLine); statusOnDisk = true; }
        catch (again) { warnings.push({ code: 'supersede-status-line-missing', id: supersedesId, error: String(again?.message ?? again).slice(0, 160) }); }
      }
      warnings.push(statusOnDisk ? { code: 'append-failed-recovered', ...detail } : { code: 'append-failed-partial', ...detail });
    }
    applyVersion(store, row);
    // 内存按**文件实况**对齐：新版本已生效 ⇒ 旧版本即 superseded（不再出现"内存双 active"）。
    if (supersedeTarget) {
      supersedeTarget.status = 'superseded';
      supersedeTarget.supersededBy = String(input.id);
    }

    // 成功 / 部分成功的边界：`append-failed-recovered` 是信息性的（数据完整），其余 warning = 真缺数据。
    const missingData = warnings.some((w) => w.code !== 'append-failed-recovered');
    const result = {
      ok: true, duplicate: false, id: row.id, claimKey, version,
      supportCount: evidenceIds.length, evidenceIds: evidenceIds.slice(),
      writes: store.claims.get(claimKey).writes, hits: store.claims.get(claimKey).hits,
      supersedes: supersedesId,
      ...(warnings.length ? { warnings: warnings.slice() } : {}),
      ...(missingData ? { partial: true } : {}),
    };
    // ③ 审计/幂等**不再依赖 status 行成败**（它们描述的是新行，而新行已经成立）：各自 best-effort，
    //    失败如实并进 warnings —— 不因为审计行写不进去，就把已写入的新行报成失败。
    try {
      recordChange(store, {
        action: supersedesId ? 'revise' : 'commit', id: row.id, subjectId: row.subjectId, claim: row.claim,
        scope: row.scope, chatKey: row.chatKey, evidenceIds, version, supersedes: supersedesId,
        ...(supersedesId ? { correction } : {}),
      });
    } catch (error) {
      result.partial = true;
      if (!result.warnings) result.warnings = [];
      result.warnings.push({ code: 'audit-line-missing', error: String(error?.message ?? error).slice(0, 160) });
    }
    if (idempotencyKey) {
      try { appendIdem(store, idempotencyKey, result); }
      catch (error) {
        result.partial = true;
        if (!result.warnings) result.warnings = [];
        result.warnings.push({ code: 'idempotency-line-missing', error: String(error?.message ?? error).slice(0, 160) });
      }
    }
    return result;
  });
}

function appendIdem(store, key, result) {
  appendJsonl(store.files.idempotency, { key, at: new Date().toISOString(), result });
  store.idem.set(String(key), result);
}

/**
 * 撤回：把（依赖这些证据 / 属于这个 subject 的）当前观察标 `retracted`。
 * **永不物理删除**：行还在 `observations.jsonl`，`history()` 还能查到。
 */
export function retract(store, ids, meta = {}) {
  return withLock(store, async () => {
    const retracted = [];
    for (const id of ids) {
      const row = store.obs.get(String(id));
      if (!row || row.t === 'status-only') continue;
      if (row.status === 'retracted') continue;
      row.status = 'retracted';
      row.retractedBy = { at: meta.at ?? Date.now(), evidenceIds: uniq(meta.evidenceIds), reason: meta.reason ?? '' };
      appendJsonl(store.files.observations, {
        t: 'status', id: row.id, status: 'retracted', at: row.retractedBy.at, retractedBy: row.retractedBy,
      });
      let cKey = row.claimKey; if (store.aliases && store.aliases.has(cKey)) cKey = store.aliases.get(cKey); const card = store.claims.get(cKey);
      if (card && card.activeId === row.id) card.activeId = null;
      retracted.push(row.id);
      recordChange(store, {
        action: 'retract', id: row.id, subjectId: row.subjectId, claim: row.claim, scope: row.scope,
        chatKey: row.chatKey ?? '', evidenceIds: row.evidenceIds || [], version: row.version,
        reason: row.retractedBy.reason,
      });
    }
    return { ok: true, retracted, keptHistory: true };
  });
}

/** 当前有效的观察（C：稳定认识 + D：短期状态）。 */
export function activeObservations(store) {
  const out = [];
  for (const card of store.claims.values()) {
    if (!card.activeId) continue;
    const row = store.obs.get(card.activeId);
    if (row && row.status === 'active') out.push(row);
  }
  return out;
}

/** 某个 claim 的全部版本（含被 supersede / retract 的）—— 验收第 7 条要"旧观察保留历史"。 */
export function versionsOf(store, { subjectId, claim, scope = null }) {
  const rows = [];
  for (const row of store.obs.values()) {
    if (row.t === 'status-only') continue;
    if (subjectId && String(row.subjectId) !== String(subjectId)) continue;
    if (claim !== undefined && claim !== null && row.claim !== claim) continue;
    if (scope && row.scope !== scope) continue;
    rows.push(row);
  }
  return rows.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0) || String(a.id).localeCompare(String(b.id)));
}

// ── 命中计数（"写入次数 ≠ 命中次数"） ───────────────────────────────────────

/**
 * 一次真实命中：只有**确实进了上下文**的卡才 +1。
 * 写入方式是**追加一行**到 `cards-hits.jsonl`（不做整文件覆盖 ⇒ 并发/多实例不会互相抹计数）。
 * 注意：这里**只写命中统计**，不写证据/观察/修订（那是 commit 的事 —— 指挥位 2026-10-04 的第 3 条决定）。
 */
export function bumpHit(store, claimKey, at = Date.now(), meta = {}) {
  appendJsonl(store.files.hits, {
    t: 'hit', cardId: String(claimKey), at, chatKey: String(meta.chatKey ?? ''), scope: meta.scope ?? null,
  });
  const card = store.claims.get(claimKey);
  if (!card) {
    store.orphanHits.set(String(claimKey), (store.orphanHits.get(String(claimKey)) || 0) + 1);
    return null;
  }
  card.hits += 1;
  card.lastHitAt = at;
  return { claimKey, hits: card.hits, writes: card.writes };
}

/** 卡片视图（E：给提示词/UI 的极短可重建摘要；计数器用来暴露"写了没人用"）。 */
export function cardRows(store) {
  return [...store.claims.values()].map((c) => ({
    cardId: c.claimKey,
    subjectId: c.subjectId,
    scope: c.scope,
    chatKey: c.chatKey,
    writes: c.writes,
    hits: c.hits,
    lastWriteAt: c.lastWriteAt,
    lastHitAt: c.lastHitAt,
    activeId: c.activeId,
    versions: c.versions.length,
  }));
}

export function changeRows(store) {
  return store.changes.slice();
}

/** 命中日志里出现、但当前没有对应卡片的 cardId 计数（不丢，给排障看）。 */
export function orphanHitCount(store) {
  return Object.fromEntries(store.orphanHits);
}

export function getSubjectName(subjectId, { dataDir } = {}) {
  const file = dataDir
    ? path.join(dataDir, 'memory', 'subjects.json')
    : memoryFile('subjects.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && data[String(subjectId)] && data[String(subjectId)].name) {
      return data[String(subjectId)].name;
    }
  } catch (e) {}
  return '未知';
}

/**
 * 人物显示名的**写侧**（`getSubjectName` 的对应物；改名归 `editPersonImpressions` 用）。
 *
 * ★ 读不动就不写：`subjects.json` 解析失败时**拒绝覆盖** —— 人工改一个名字，
 *   不该把一份只是暂时读不懂的账本静默替换成"只剩这一条"。
 * @returns {{ok:boolean, from?:string|null, to?:string, file?:string, error?:string}}
 */
export function setSubjectName(subjectId, name, { dataDir } = {}) {
  const subj = String(subjectId ?? '').trim();
  const text = String(name ?? '').trim().slice(0, 60);
  if (!subj) return { ok: false, error: 'setSubjectName: 缺 subjectId' };
  if (!text) return { ok: false, error: 'setSubjectName: name 不能是空串（要保留原名就别调它）' };
  const file = dataDir
    ? path.join(String(dataDir), 'memory', 'subjects.json')
    : memoryFile('subjects.json');
  let data = {};
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return { ok: false, error: `subjects.json 形状不对（不是对象），拒绝覆盖：${file}` };
      data = parsed;
    } catch (error) {
      return { ok: false, error: `subjects.json 解析失败，拒绝覆盖：${String(error?.message ?? error)}` };
    }
  }
  const from = String(data?.[subj]?.name ?? '') || null;
  data[subj] = { ...(data[subj] && typeof data[subj] === 'object' ? data[subj] : {}), name: text };
  try {
    writeJsonAtomic(file, data);
  } catch (error) {
    return { ok: false, error: `subjects.json 落盘失败：${String(error?.message ?? error)}` };
  }
  return { ok: true, from, to: text, file };
}

/** `subjects.json` 的路径（与 `getSubjectName`/`setSubjectName` 同一处解析，新加的读侧不再抄第三遍三元式）。 */
function subjectFile(dataDir) {
  return dataDir
    ? path.join(String(dataDir), 'memory', 'subjects.json')
    : memoryFile('subjects.json');
}

/**
 * 读整张显示名表。**读不出来必须如实报**，不许像 `getSubjectName` 那样静默回落「未知」：
 * 旧树 `removeNameOnlyMember` 要分「没有这个壳」(`not-found`) 与「盘上有但读不出」(`unreadable`)
 * （`src/memory.js` N8-b2 那段）—— 混了就等于把"一条都没删"报成"早就删掉了"。
 * @returns {{ok:boolean, subjects?:Record<string,any>, file:string, missing?:boolean, error?:string}}
 */
export function readSubjects({ dataDir } = {}) {
  const file = subjectFile(dataDir);
  if (!fs.existsSync(file)) return { ok: true, subjects: {}, file, missing: true };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { ok: false, file, error: `subjects.json 解析失败（记录仍在盘上）：${String(error?.message ?? error)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, file, error: `subjects.json 形状不对（不是对象）：${file}` };
  }
  return { ok: true, subjects: parsed, file };
}

/**
 * 删掉一个显示名记录（`removeMember` / `removeNameOnlyMember` 的名字那一半）。
 * 与 `setSubjectName` 同一条门：**读不动就不写** —— 一次删除不该把整张只是暂时读不懂的表换成"只剩这一条"。
 * 键本来不存在 ⇒ `{ok:true, removed:false}`：删一个没有的键既不算失败，也不算删掉了什么。
 * @returns {{ok:boolean, removed:boolean, from?:string|null, file?:string, error?:string}}
 */
export function removeSubjectName(subjectId, { dataDir } = {}) {
  const subj = String(subjectId ?? '').trim();
  if (!subj) return { ok: false, removed: false, error: 'removeSubjectName: 缺 subjectId' };
  const read = readSubjects({ dataDir });
  if (!read.ok) return { ok: false, removed: false, file: read.file, error: read.error };
  const data = read.subjects;
  if (!Object.prototype.hasOwnProperty.call(data, subj)) return { ok: true, removed: false, file: read.file };
  const from = String(data[subj]?.name ?? '') || null;
  delete data[subj];
  try {
    writeJsonAtomic(read.file, data);
  } catch (error) {
    return { ok: false, removed: false, file: read.file, error: `subjects.json 落盘失败：${String(error?.message ?? error)}` };
  }
  return { ok: true, removed: true, from, file: read.file };
}

export { FILES };
