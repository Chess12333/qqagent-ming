import { createHash } from 'node:crypto';
import { makeProfile, profileFingerprint, validateDimensions, toFiniteNumber } from './profile.js';
import { cosineSimilarity } from './fake-embedder.js';

/**
 * ★ 2026-10-17（向量底座收口）：索引只保留一份**安全白名单**的派生元数据 ——
 * 权重/配额真正需要的来源类型与受保护标记，绝不能在建索引这一步被丢掉
 * （此前 `checkRecord`/`stored` 只拣 id/sourceId/evidenceIds/scope/vector/at/版本，
 *   `type/sourceType/stable` 到不了真索引 ⇒ 加权与三类型配额只在无索引内存腿生效）。
 * 只收标量短字段（string ≤64 / boolean），不收任意对象，避免把整条业务记录粘进索引。
 */
const META_FIELDS = ['type', 'sourceType', 'stable'];
const META_STRING_MAX = 64;
const QUERY_TOP_K_MAX = 256;          // 过采样上限（检索层通常只请求 topK×4，远小于此）

function sha256Text(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** 从记录里挑出白名单元数据（非法值忽略，不做类型猜测）。 */
function pickMeta(rec) {
  const meta = {};
  if (!rec || typeof rec !== 'object') return meta;
  for (const key of META_FIELDS) {
    if (key === 'stable') {
      if (rec.stable === true) meta.stable = true;
      continue;
    }
    const value = rec[key];
    if (typeof value === 'string' && value.trim()) meta[key] = value.trim().slice(0, META_STRING_MAX);
  }
  return meta;
}

function sameJson(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** 两条已存记录除 vector 外是否完全一致（用于 unchanged 判定，不做嵌入）。 */
function sameStoredMeta(a, b) {
  if (!a || !b) return false;
  if (a.id !== b.id || a.sourceId !== b.sourceId) return false;
  if (a.at !== b.at) return false;
  if (!sameJson(a.scope, b.scope)) return false;
  if (!sameJson(a.evidenceIds, b.evidenceIds)) return false;
  if (String(a.textHash ?? '') !== String(b.textHash ?? '')) return false;
  if (a.generation !== b.generation || a.labelSchemaVersion !== b.labelSchemaVersion
    || a.profileVersion !== b.profileVersion) return false;
  for (const key of META_FIELDS) {
    if (key === 'stable') { if ((a.stable === true) !== (b.stable === true)) return false; continue; }
    if (String(a[key] ?? '') !== String(b[key] ?? '')) return false;
  }
  return true;
}

/**
 * V1a 向量索引（票 §一/§二.3-4）：纯内存状态机 + 可注入 store，不起进程、不连端口、不读时钟。
 *
 * 状态（status() 只返回这四个；query 结果状态另见下）：
 *   not-ready → ready ｜ version-incompatible（粘滞，rebuild 恢复）｜ stale（粘滞，rebuild 恢复）
 * 选择记录（与票面有出入处，逐条见回执，均已列出）：
 *  1. `stale` 只由"绕过索引直接改 store"触发（revision 漂移），remove()/upsert() 自身不致 stale
 *     （★ 2026-10-18：连"写进行中并发读"也不致 stale —— 自己每写一条即时对齐 revision + 在途计数，
 *      只有"revision 增量对不上自己写的条数"才判外部漂移；误报会让粘滞 stale 永久降级语义召回）。
 *  2. `partial-coverage` 只出现在 query 结果里（时间边界剔掉部分命中时），status() 不返回它。
 *  3. stale 查询返回 {ok:false, items:[]}（不可信则不附数据）；partial-coverage 返回 ok:false 但附 items+reasons（数据可信、只是被时间切薄）。
 *  4. remove()/rebuild() 的返回比票形多一个 `reasons:[]`（诊断用）；其余字段与票形逐字一致。
 *  5. query 第一参数只能是 text 字符串或向量（二者必居其一；同时给不是本签名要表达的事，显式失败）。
 *  6. `score` 只进 items，任何地方不写进 `p`（本模块根本没有 `p` 字段）。
 *  7. threshold 默认 null = 不过滤；调用方给了有限数才按 score>=threshold 留。
 *  8. ★ 2026-10-17：`upsert` 返回 `{ok, inserted, updated, unchanged, rejected, reasons}` ——
 *     同 id 且 textHash 未变时**复用已有向量**（不再嵌入），只有 text 变才重嵌；
 *     元数据（scope/at/type/sourceType/stable/sourceId）单独变化只更新记录。
 *     索引自持活动镜像 + 反向 source ledger（同 id 换 sourceId 不会让旧 source 误删新代）。
 *  9. ★ 2026-10-17：`query` 支持 `sourceIds`（打分前权限收窄）、`topK` 有界（≤256），
 *     结果透出 `type/sourceType/stable`；`ids()/counts()/removeRecords()` 为轻量读/删除口。
 */
export function createMemoryStore() {
  const records = new Map();
  let revision = 0;
  return {
    get revision() { return revision; },
    async upsert(record) {
      if (!record || typeof record.id !== 'string' || !record.id) throw new TypeError('store.upsert needs record.id');
      records.set(record.id, record);
      revision += 1;
      return { ok: true };
    },
    async remove(idOrSourceId) {
      let deleted = 0;
      if (records.has(idOrSourceId)) {
        records.delete(idOrSourceId);
        deleted = 1;
      } else {
        for (const [id, rec] of records) {
          if (rec && rec.sourceId === idOrSourceId) { records.delete(id); deleted += 1; }
        }
      }
      if (deleted > 0) revision += 1;
      return { ok: true, deleted };
    },
    async clear() {
      const n = records.size;
      if (n > 0) revision += 1;
      records.clear();
      return { ok: true, cleared: n };
    },
    async list() { return [...records.values()]; },
    // ★ 2026-10-17：轻量读口 —— 索引侧维护镜像后，`list()` 只留给兼容/重建；
    //   状态计数/删除核验走 get/count/counts，避免每次全量拷贝。
    async get(id) { return records.get(String(id)) ?? null; },
    async ids() { return [...records.keys()]; },
    async count() { return records.size; },
    async counts() {
      const byType = {};
      const bySourceType = {};
      for (const rec of records.values()) {
        if (typeof rec?.type === 'string' && rec.type) byType[rec.type] = (byType[rec.type] || 0) + 1;
        if (typeof rec?.sourceType === 'string' && rec.sourceType) bySourceType[rec.sourceType] = (bySourceType[rec.sourceType] || 0) + 1;
      }
      return { total: records.size, byType, bySourceType };
    },
    async checkCompatibility({ versions, profileFingerprint: fingerprint }) {
      return { ready: true, versions: { ...versions }, profileFingerprint: fingerprint };
    },
  };
}

function inScope(item, scope) {
  if (!scope || typeof scope !== 'object') return false;
  if (!item || typeof item.scope !== 'object' || !item.scope) return false;
  return Object.entries(scope).every(([key, value]) => item.scope[key] === value);
}

const EMBEDDER_STATUSES = ['not-ready', 'timeout', 'cancelled', 'version-incompatible', 'error'];

export function createIndex({ profile, embedder, store = null, generation = 'gen-1', labelSchemaVersion = 'labels-v1' } = {}) {
  const frozen = makeProfile(profile); // 非法当场 throw
  if (!embedder || typeof embedder.embed !== 'function') {
    throw new TypeError('embedder with .embed(text, {purpose}) must be injected (V1a: use makeFakeEmbedder)');
  }
  if (embedder.profile) {
    let embedderFingerprint;
    try {
      embedderFingerprint = typeof embedder.fingerprint === 'function' ? embedder.fingerprint() : profileFingerprint(embedder.profile);
    } catch (error) {
      throw new TypeError(`embedder profile is invalid: ${String(error?.message || error)}`);
    }
    if (embedderFingerprint !== profileFingerprint(frozen)) {
      throw new Error('embedder profile does not match index profile (refusing to mix generations)');
    }
  }
  if (typeof generation !== 'string' || !generation) throw new TypeError('generation must be a non-empty string');
  if (typeof labelSchemaVersion !== 'string' || !labelSchemaVersion) throw new TypeError('labelSchemaVersion must be a non-empty string');
  const activeStore = store === null || store === undefined ? createMemoryStore() : store;
  for (const method of ['upsert', 'list', 'remove']) {
    if (typeof activeStore[method] !== 'function') throw new TypeError(`store.${method} must be a function`);
  }

  const versions = { generation, profileVersion: profileFingerprint(frozen), labelSchemaVersion };
  let state = 'not-ready';
  let dirty = false; // 外部 revision 漂移粘滞位，只 rebuild 清
  let seenRevision = typeof activeStore.revision === 'number' ? activeStore.revision : null;
  // ★ 2026-10-18（向量召回 · stale 误报修复）：索引**自己**正在途中的 store 写条数。
  //   批量 upsert 一轮要依次写多条（每条之间隔着嵌入 await，慢模型下整批可达数百毫秒），
  //   而 seenRevision 此前只在整轮结束时对齐 ⇒ 这期间任何一次 query()/status()（真实消息流
  //   随时会来）看到 revision 已动就误判"外部漂移"，粘滞 dirty 只有 rebuild 能清，而生产
  //   装配从不调 rebuild（coordinator 走 sync）⇒ 语义召回一次误报即永久降级到关键词。
  //   现在每条自己写都即时对齐 revision，并在途计数兜住"对齐前的微任务窗口"：
  //   只有"revision 增量对不上自己写的条数"才是真外部漂移（selftest v1a-stale-partial 语义不变）。
  let selfWritesInFlight = 0;
  let versionNotes = [];
  const ledger = new Map(); // sourceId -> Set(recordId)，撤回级联用
  // ★ 2026-10-17（向量增量底座）：索引自己在内存里维护一份**活动记录镜像**。
  //   用途：① upsert 按 id 查旧 textHash 复用向量（不再无条件 embed）；② 同一 id 换 sourceId 时
  //   维护**反向** source ledger（旧 source 的集合里要摘掉，否则 remove(旧 source) 会误删新代）；
  //   ③ `ids()/counts()` 轻量计数，不再每次 `store.list()` 全量拷贝。
  //   镜像与活动索引同寿命（可常驻）；旧向量不额外囤第二份（store 里的就是唯一副本）。
  const mirror = new Map();       // recordId -> stored record
  const sourceOf = new Map();     // recordId -> sourceId（反向 ledger）
  let mirrorReady = false;
  let mirrorLoading = null;

  function syncRevision() {
    if (typeof activeStore.revision === 'number') seenRevision = activeStore.revision;
  }
  /**
   * 索引自己发起的 store 写：写前计入在途、写后立刻对齐 revision（见 selfWritesInFlight 注释）。
   * 写失败也照样对齐（写可能已部分生效），然后原样抛出，不改各调用点的错误语义。
   */
  async function commitStoreWrite(apply) {
    selfWritesInFlight += 1;
    try {
      await apply();
    } finally {
      syncRevision();
      selfWritesInFlight -= 1;
    }
  }
  async function ensureMirror() {
    if (mirrorReady) return;
    if (mirrorLoading) { await mirrorLoading; return; }
    mirrorLoading = (async () => {
      const all = await activeStore.list();
      if (!Array.isArray(all)) throw new TypeError('store.list() must return an array');
      mirror.clear();
      ledger.clear();
      sourceOf.clear();
      for (const rec of all) {
        if (!rec || typeof rec.id !== 'string' || !rec.id) continue;
        mirror.set(rec.id, rec);
        if (typeof rec.sourceId === 'string' && rec.sourceId) {
          ledgerAdd(rec.sourceId, rec.id);
          sourceOf.set(rec.id, rec.sourceId);
        }
      }
      const notes = [];
      for (const rec of mirror.values()) {
        if (rec.profileVersion !== versions.profileVersion
          || rec.generation !== versions.generation
          || rec.labelSchemaVersion !== versions.labelSchemaVersion) {
          notes.push(`record ${rec.id} carries a foreign generation/profile/label schema`);
          break;
        }
      }
      if (notes.length) {
        state = 'version-incompatible';
        versionNotes = notes;
      }
      mirrorReady = true;
      syncRevision();
    })();
    try { await mirrorLoading; } finally { mirrorLoading = null; }
  }
  function noteStored(stored) {
    const prev = mirror.get(stored.id);
    if (prev && prev.sourceId && prev.sourceId !== stored.sourceId) ledgerDel(prev.sourceId, stored.id);
    mirror.set(stored.id, stored);
    ledgerAdd(stored.sourceId, stored.id);
    sourceOf.set(stored.id, stored.sourceId);
  }
  function forgetId(id) {
    const sourceId = sourceOf.get(id);
    if (sourceId) ledgerDel(sourceId, id);
    sourceOf.delete(id);
    mirror.delete(id);
  }
  function drifted() {
    if (dirty) return true;
    if (seenRevision !== null && typeof activeStore.revision === 'number' && activeStore.revision !== seenRevision) {
      // 自己的在途写（revision 增量正好等于在途条数）不是外部漂移 —— 不置粘滞位。
      if (activeStore.revision === seenRevision + selfWritesInFlight) return false;
      dirty = true;
      return true;
    }
    return false;
  }
  function status() {
    if (state === 'closed') return 'closed';
    if (state === 'version-incompatible') return 'version-incompatible';
    if (drifted()) return 'stale';
    return state; // 'not-ready' | 'ready'
  }
  function statusDetails() {
    return { state: status(), versions: { ...versions }, profileFingerprint: versions.profileVersion };
  }
  function ledgerAdd(sourceId, id) {
    if (!ledger.has(sourceId)) ledger.set(sourceId, new Set());
    ledger.get(sourceId).add(id);
  }
  function ledgerDel(sourceId, id) {
    const set = ledger.get(sourceId);
    if (set) { set.delete(id); if (set.size === 0) ledger.delete(sourceId); }
  }

  function checkRecord(rec, expGen, expLsv) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { ok: false, reason: 'record must be an object' };
    if (typeof rec.id !== 'string' || !rec.id) return { ok: false, reason: 'record.id must be a non-empty string' };
    if (typeof rec.sourceId !== 'string' || !rec.sourceId) return { ok: false, reason: `record ${rec.id}: sourceId is required` };
    if (!Array.isArray(rec.evidenceIds) || rec.evidenceIds.length === 0
      || rec.evidenceIds.some((e) => typeof e !== 'string' || !e)) {
      return { ok: false, reason: `record ${rec.id}: evidenceIds must be a non-empty string array` };
    }
    if (!rec.scope || typeof rec.scope !== 'object' || Array.isArray(rec.scope) || Object.keys(rec.scope).length === 0) {
      return { ok: false, reason: `record ${rec.id}: scope is required (pre-filter key)` };
    }
    if (rec.at === null || rec.at === undefined) return { ok: false, reason: `record ${rec.id}: at is required` };
    let at;
    try {
      at = toFiniteNumber(rec.at, { what: `record ${rec.id}.at`, min: 1 });
    } catch (error) {
      return { ok: false, reason: `record ${rec.id}: ${String(error?.message || error)}` };
    }
    const hasText = typeof rec.text === 'string';
    const hasVec = rec.vec !== null && rec.vec !== undefined;
    if (hasText && hasVec) return { ok: false, reason: `record ${rec.id}: text and vec are exclusive (give one)` };
    if (!hasText && !hasVec) return { ok: false, reason: `record ${rec.id}: text or vec is required` };
    const recGen = rec.generation ?? expGen;
    if (typeof recGen !== 'string' || !recGen) return { ok: false, reason: `record ${rec.id}: generation must be a non-empty string` };
    if (recGen !== versions.generation) {
      return { ok: false, version: true, reason: `record ${rec.id}: version-incompatible generation (record ${recGen} vs index ${versions.generation})` };
    }
    const recLsv = rec.labelSchemaVersion ?? expLsv;
    if (typeof recLsv !== 'string' || !recLsv) return { ok: false, reason: `record ${rec.id}: labelSchemaVersion must be a non-empty string` };
    if (recLsv !== versions.labelSchemaVersion) {
      return { ok: false, version: true, reason: `record ${rec.id}: version-incompatible labelSchemaVersion (record ${recLsv} vs index ${versions.labelSchemaVersion})` };
    }
    const recPv = rec.profileVersion ?? versions.profileVersion;
    if (recPv !== versions.profileVersion) {
      return { ok: false, version: true, reason: `record ${rec.id}: version-incompatible profile (record fingerprint vs index fingerprint)` };
    }
    return { ok: true, normalized: { id: rec.id, sourceId: rec.sourceId, evidenceIds: [...rec.evidenceIds], scope: { ...rec.scope }, text: hasText ? rec.text : undefined, vec: hasVec ? rec.vec : undefined, at, generation: recGen, labelSchemaVersion: recLsv, ...pickMeta(rec) } };
  }

  async function materializeVector(record) {
    if (record.text !== undefined) {
      let result;
      try {
        result = await embedder.embed(record.text, { purpose: 'document' });
      } catch (error) {
        return { ok: false, reason: `embed error: ${String(error?.message || error)}` };
      }
      if (!result || result.ok !== true) {
        const statusCode = result && EMBEDDER_STATUSES.includes(result.status) ? result.status : 'error';
        return { ok: false, version: statusCode === 'version-incompatible', reason: `embed ${statusCode}: ${String(result?.reason || 'no reason')}` };
      }
      const checked = validateDimensions(frozen, result.vec);
      if (!checked.ok) return { ok: false, reason: `embedder returned bad vector: ${checked.reason}` };
      return { ok: true, vector: Array.from(result.vec), embedding: result };
    }
    const checked = validateDimensions(frozen, record.vec);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    return { ok: true, vector: Array.from(record.vec) };
  }

  async function upsert(records, opts = {}) {
    if (state === 'closed') {
      const n = Array.isArray(records) ? records.length : 1;
      return { ok: false, inserted: 0, updated: 0, unchanged: 0, rejected: n, reasons: ['index-closed'] };
    }
    if (state === 'version-incompatible') {
      const n = Array.isArray(records) ? records.length : 0;
      return { ok: false, inserted: 0, updated: 0, unchanged: 0, rejected: n, reasons: ['index-version-incompatible: rebuild-required', ...versionNotes.slice(0, 3)] };
    }
    if (!Array.isArray(records)) return { ok: false, inserted: 0, updated: 0, unchanged: 0, rejected: 1, reasons: ['records must be an array'] };
    const expGen = opts.generation ?? versions.generation;
    const expLsv = opts.labelSchemaVersion ?? versions.labelSchemaVersion;
    if (typeof expGen !== 'string' || !expGen) return { ok: false, inserted: 0, updated: 0, unchanged: 0, rejected: records.length, reasons: ['generation must be a non-empty string'] };
    if (typeof expLsv !== 'string' || !expLsv) return { ok: false, inserted: 0, updated: 0, unchanged: 0, rejected: records.length, reasons: ['labelSchemaVersion must be a non-empty string'] };
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let rejected = 0;
    const reasons = [];
    let versionReject = false;
    try {
      await ensureMirror();
    } catch (error) {
      return { ok: false, inserted: 0, updated: 0, unchanged: 0, rejected: records.length, reasons: [`store.list failed while loading index mirror: ${String(error?.message || error)}`] };
    }
    // 首次加载镜像时可能发现 store 里躺着别的代次/画像 ⇒ 与既有状态语义一致：拒写，要求 rebuild。
    if (state === 'version-incompatible') {
      return { ok: false, inserted: 0, updated: 0, unchanged: 0, rejected: records.length, reasons: ['index-version-incompatible: rebuild-required', ...versionNotes.slice(0, 3)] };
    }
    // 低层去重：同一批里重复 id 以**最后一条**为准（不重复嵌入、不重复计数）。
    const byId = new Map();
    const anon = [];
    for (const rec of records) {
      const id = String(rec?.id ?? '');
      if (id) byId.set(id, rec);
      else anon.push(rec);
    }
    const list = [...byId.values(), ...anon];
    for (const rec of list) {
      const check = checkRecord(rec, expGen, expLsv);
      if (!check.ok) {
        rejected += 1;
        reasons.push(check.reason);
        if (check.version) versionReject = true;
        continue;
      }
      const norm = check.normalized;
      const prev = mirror.get(norm.id) || null;
      const textHash = norm.text !== undefined ? sha256Text(norm.text) : null;
      // ★ 向量复用：同 id 且 text+profile 未变 ⇒ 直接用 store 里已有的向量，不再 embed。
      //   profile 变化在 checkRecord 已经按版本拒收（绝不跨代复用）。
      let vector = null;
      if (norm.vec !== undefined) {
        const checked = validateDimensions(frozen, norm.vec);
        if (!checked.ok) {
          rejected += 1;
          reasons.push(`record ${norm.id}: ${checked.reason}`);
          continue;
        }
        vector = Array.from(norm.vec);
      } else if (prev && textHash && prev.textHash === textHash && Array.isArray(prev.vector)) {
        vector = prev.vector;
      } else {
        const mat = await materializeVector(norm);
        if (!mat.ok) {
          rejected += 1;
          reasons.push(`record ${norm.id}: ${mat.reason}`);
          if (mat.version) versionReject = true;
          continue;
        }
        vector = mat.vector;
      }
      const stored = {
        id: norm.id,
        sourceId: norm.sourceId,
        evidenceIds: norm.evidenceIds,
        scope: norm.scope,
        vector,
        at: norm.at,
        generation: norm.generation,
        profileVersion: versions.profileVersion,
        labelSchemaVersion: norm.labelSchemaVersion,
        ...pickMeta(norm),
        textHash,
      };
      if (prev) {
        if (sameStoredMeta(prev, stored) && norm.vec === undefined) {
          // 完全没变（含元数据）：不写 store；仅把 ledger/镜像对齐（sourceId 变化已含在比较里）。
          unchanged += 1;
          noteStored(stored);
          continue;
        }
        await commitStoreWrite(() => activeStore.upsert(stored));
        // 同 id 换 sourceId：旧 source 的反向 ledger 必须摘掉，否则 remove(旧 source) 会误删新代。
        noteStored(stored);
        updated += 1;
        continue;
      }
      await commitStoreWrite(() => activeStore.upsert(stored));
      noteStored(stored);
      inserted += 1;
    }
    syncRevision();
    if (inserted + updated > 0 && state === 'not-ready') state = 'ready';
    if (versionReject) {
      state = 'version-incompatible';
      versionNotes = reasons.filter((r) => r.includes('version-incompatible'));
    }
    return { ok: rejected === 0, inserted, updated, unchanged, rejected, reasons };
  }

  async function remove(sourceIds) {
    const list = Array.isArray(sourceIds) ? sourceIds : [sourceIds];
    if (state === 'closed') return { ok: false, removed: 0, cascaded: 0, reasons: ['index-closed'] };
    try { await ensureMirror(); } catch (error) {
      return { ok: false, removed: 0, cascaded: 0, reasons: [`store.list failed while loading index mirror: ${String(error?.message || error)}`] };
    }
    let removed = 0;
    let cascaded = 0;
    const reasons = [];
    for (const sourceId of list) {
      if (typeof sourceId !== 'string' || !sourceId) {
        reasons.push('sourceId must be a non-empty string');
        continue;
      }
      // ★ 2026-10-17：删除只认**当前**归属（反向 ledger / 镜像里的 sourceId）。
      //   同一 id 换过 sourceId 后，旧 source 的集合里已经摘掉 ⇒ 不会误删新代。
      let targets = ledger.has(sourceId) ? [...ledger.get(sourceId)] : [];
      if (targets.length === 0) {
        targets = [...mirror.values()].filter((r) => r && r.sourceId === sourceId).map((r) => r.id);
      }
      if (targets.length === 0) {
        reasons.push(`unknown sourceId: ${sourceId} (nothing removed, not reported as success)`);
        continue;
      }
      for (const id of targets) {
        await commitStoreWrite(() => activeStore.remove(id));
      }
      // 核验后再从镜像/ledger 摘除：删除失败（或没有 get 的外部 store 用一次 list）时
      // 镜像必须继续如实保留，否则之后的 sync 会以为它已经没了（漏删且不自知）。
      const left = [];
      const gone = [];
      if (typeof activeStore.get === 'function') {
        for (const id of targets) {
          if (await activeStore.get(id)) left.push(id); else gone.push(id);
        }
      } else {
        const all = await activeStore.list();
        if (!Array.isArray(all)) {
          reasons.push(`store.list() must return an array (while verifying removal of ${sourceId})`);
          continue;
        }
        const remaining = new Set(all.filter((r) => r && targets.includes(r.id)).map((r) => r.id));
        for (const id of targets) (remaining.has(id) ? left : gone).push(id);
      }
      for (const id of gone) { forgetId(id); cascaded += 1; }
      if (left.length > 0) {
        reasons.push(`store failed to delete ${left.length} record(s) of ${sourceId}`);
        cascaded -= left.length;
        continue;
      }
      removed += 1;
    }
    syncRevision();
    return { ok: reasons.length === 0, removed, cascaded, reasons };
  }

  /** ★ 新增：按**记录 id** 精确删除（sync 的缺席清理用；不动别的 source 的记录）。 */
  async function removeRecords(recordIds) {
    const ids = Array.isArray(recordIds) ? recordIds : [recordIds];
    if (state === 'closed') return { ok: false, removed: 0, reasons: ['index-closed'] };
    try { await ensureMirror(); } catch (error) {
      return { ok: false, removed: 0, reasons: [`store.list failed while loading index mirror: ${String(error?.message || error)}`] };
    }
    let removed = 0;
    const reasons = [];
    for (const raw of ids) {
      const id = String(raw ?? '');
      if (!id) { reasons.push('record id must be a non-empty string'); continue; }
      if (!mirror.has(id)) { reasons.push(`unknown recordId: ${id} (nothing removed)`); continue; }
      await commitStoreWrite(() => activeStore.remove(id));
      // 有 get 就核验；没有 get 的外部 store 沿用旧假设（remove 成功）。
      if (typeof activeStore.get === 'function' && await activeStore.get(id)) {
        reasons.push(`store failed to delete record ${id}`);
        continue;
      }
      forgetId(id);
      removed += 1;
    }
    syncRevision();
    return { ok: reasons.length === 0, removed, reasons };
  }

  /** 轻量读口：当前索引里的全部记录 id（镜像；不拷贝 vector）。 */
  async function ids() {
    await ensureMirror();
    return [...mirror.keys()];
  }

  /** 轻量计数：{total, byType, bySourceType} —— 供 runtimeStatus 用，不再 store.list 全量。 */
  async function counts() {
    if (state === 'closed') throw new Error('index-closed');
    await ensureMirror();
    const byType = {};
    const bySourceType = {};
    for (const rec of mirror.values()) {
      if (typeof rec?.type === 'string' && rec.type) byType[rec.type] = (byType[rec.type] || 0) + 1;
      if (typeof rec?.sourceType === 'string' && rec.sourceType) {
        bySourceType[rec.sourceType] = (bySourceType[rec.sourceType] || 0) + 1;
      }
    }
    return { total: mirror.size, byType, bySourceType };
  }

  async function resolveQueryVector(textOrVec) {
    if (typeof textOrVec === 'string') {
      let result;
      try {
        result = await embedder.embed(textOrVec, { purpose: 'query' });
      } catch (error) {
        return { ok: false, status: 'error', reason: `embed error: ${String(error?.message || error)}` };
      }
      if (!result || result.ok !== true) {
        const statusCode = result && EMBEDDER_STATUSES.includes(result.status) ? result.status : 'error';
        return { ok: false, status: statusCode, reason: String(result?.reason || 'embedder gave no reason') };
      }
      const checked = validateDimensions(frozen, result.vec);
      if (!checked.ok) return { ok: false, status: 'error', reason: `embedder returned bad vector: ${checked.reason}` };
      return { ok: true, vector: Array.from(result.vec), embedding: result };
    }
    if (Array.isArray(textOrVec) || ArrayBuffer.isView(textOrVec)) {
      const checked = validateDimensions(frozen, textOrVec);
      if (!checked.ok) return { ok: false, status: 'error', reason: checked.reason };
      return { ok: true, vector: Array.from(textOrVec) };
    }
    return { ok: false, status: 'error', reason: 'query needs a text string or a vector (give exactly one)' };
  }

  async function query(textOrVec, opts = {}) {
    const fail = (statusCode, reasons) => ({ ok: false, status: statusCode, items: [], reasons });
    if (state === 'closed') return fail('cancelled', ['index-closed']);
    if (state === 'not-ready') return fail('not-ready', []);
    if (state === 'version-incompatible') return fail('version-incompatible', ['index-version-incompatible: rebuild-required', ...versionNotes.slice(0, 3)]);
    if (drifted()) return fail('stale', ['store-changed-externally: rebuild-to-clear']);
    const scope = opts.scope;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).length === 0) {
      return fail('error', ['scope is required and must be a non-empty object (pre-filter key)']);
    }
    let topK = 8;
    if (opts.topK !== null && opts.topK !== undefined) {
      try {
        topK = toFiniteNumber(opts.topK, { what: 'topK', integer: true, min: 1 });
      } catch (error) {
        return fail('error', [String(error?.message || error)]);
      }
    }
    // 过采样请求有界：上层最多要 topK×4（用于加权/配额后回填），不接受无界大 topK。
    topK = Math.min(QUERY_TOP_K_MAX, topK);
    let threshold = null;
    if (opts.threshold !== null && opts.threshold !== undefined) {
      try {
        threshold = toFiniteNumber(opts.threshold, { what: 'threshold' });
      } catch (error) {
        return fail('error', [String(error?.message || error)]);
      }
    }
    let queryAt = null;
    if (opts.at !== null && opts.at !== undefined) {
      try {
        queryAt = toFiniteNumber(opts.at, { what: 'query at', min: 1 });
      } catch (error) {
        return fail('error', [String(error?.message || error)]);
      }
    }
    // ★ 2026-10-17：权限前置（sourceIds）在打分之前收窄；不传 = 不筛。
    let sourceIdSet = null;
    if (opts.sourceIds !== null && opts.sourceIds !== undefined) {
      const list = opts.sourceIds instanceof Set
        ? [...opts.sourceIds]
        : (Array.isArray(opts.sourceIds) ? opts.sourceIds : null);
      if (!list || list.some((id) => typeof id !== 'string' || !id)) {
        return fail('error', ['sourceIds must be an array/Set of non-empty strings']);
      }
      sourceIdSet = new Set(list);
    }
    const resolved = await resolveQueryVector(textOrVec);
    if (!resolved.ok) return fail(resolved.status, [resolved.reason]);
    const withQueryEmbedding = (result) => {
      if (opts.includeQueryEmbedding !== true) return result;
      const norm = Math.sqrt(resolved.vector.reduce((sum, value) => sum + value * value, 0));
      const source = resolved.embedding || {};
      return {
        ...result,
        queryEmbedding: {
          vec: [...resolved.vector],
          dims: resolved.vector.length,
          norm,
          normalized: Number.isFinite(norm) && Math.abs(norm - 1) <= 1e-5,
          pooling: frozen.pooling,
          embdNormalize: frozen.embdNormalize,
          profileFingerprint: versions.profileVersion,
          cacheKey: source.cacheKey,
          truncated: source.truncated ?? false,
          tokenCount: source.tokenCount ?? null,
        },
      };
    };
    // ★ 2026-10-17：改用索引自己的活动镜像（与 store 同寿命，常驻）——不再每次 query
    //   都 `store.list()` 做一份全量数组拷贝。精确检索本身 O(n)，但这里只遍历引用、
    //   不深拷贝 vector，也不产生 I/O。
    try { await ensureMirror(); } catch (error) {
      return fail('error', [`store.list failed while loading index mirror: ${String(error?.message || error)}`]);
    }
    // Scope（+ 权限 sourceIds）first：范围外/未授权候选绝不进入版本检查或打分。
    const visible = [];
    for (const item of mirror.values()) {
      if (!inScope(item, scope)) continue;
      if (sourceIdSet && !sourceIdSet.has(item.sourceId)) continue;
      visible.push(item);
    }
    const incompatible = visible.find((item) => !item || typeof item !== 'object'
      || item.generation !== versions.generation
      || item.labelSchemaVersion !== versions.labelSchemaVersion
      || item.profileVersion !== versions.profileVersion);
    if (incompatible) {
      state = 'version-incompatible';
      versionNotes = [`record ${String(incompatible.id ?? incompatible.sourceId ?? '?')} carries a foreign generation/profile/label schema`];
      return fail('version-incompatible', [...versionNotes, 'old data isolated: no items returned']);
    }
    let excluded = 0;
    let inRange = visible;
    if (queryAt !== null) {
      inRange = [];
      for (const item of visible) {
        if (typeof item.at !== 'number' || !Number.isFinite(item.at) || item.at > queryAt) {
          excluded += 1;
          continue;
        }
        inRange.push(item);
      }
    }
    const scored = [];
    for (const item of inRange) {
      const checked = validateDimensions(frozen, item.vector);
      if (!checked.ok) return fail('error', [`record ${String(item.id ?? '?')} has a bad stored vector: ${checked.reason}`]);
      scored.push({
        id: item.id,
        sourceId: item.sourceId,
        scope: { ...item.scope },
        score: cosineSimilarity(resolved.vector, item.vector),
        at: item.at,
        // ★ 2026-10-17：把权重/配额要用的真实来源类型透出（只读标量；不把 score 当 p/confidence）。
        ...(typeof item.type === 'string' && item.type ? { type: item.type } : {}),
        ...(typeof item.sourceType === 'string' && item.sourceType ? { sourceType: item.sourceType } : {}),
        ...(item.stable === true ? { stable: true } : {}),
      });
    }
    const kept = (threshold === null ? scored : scored.filter((s) => s.score >= threshold))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    const timeNote = excluded > 0 ? [`time-excluded:${excluded} (records newer than query at are withheld)`] : [];
    if (excluded > 0 && kept.length > 0) {
      return withQueryEmbedding({ ok: false, status: 'partial-coverage', items: kept, reasons: timeNote });
    }
    if (kept.length > 0) return withQueryEmbedding({ ok: true, status: 'success', items: kept, reasons: timeNote });
    return withQueryEmbedding({ ok: true, status: 'empty', items: [], reasons: timeNote });
  }

  async function rebuild(sourceRecords, opts = {}) {
    if (state === 'closed') return { ok: false, generation: versions.generation, reasons: ['index-closed'] };
    if (!Array.isArray(sourceRecords)) return { ok: false, generation: versions.generation, reasons: ['sourceRecords must be an array'] };
    const recordGens = new Set(sourceRecords.map((r) => (r && typeof r.generation === 'string' && r.generation ? r.generation : null)).filter(Boolean));
    const recordLsvs = new Set(sourceRecords.map((r) => (r && typeof r.labelSchemaVersion === 'string' && r.labelSchemaVersion ? r.labelSchemaVersion : null)).filter(Boolean));
    if (recordGens.size > 1) return { ok: false, generation: versions.generation, reasons: ['rebuild records carry mixed generations (refusing to merge)'] };
    if (recordLsvs.size > 1) return { ok: false, generation: versions.generation, reasons: ['rebuild records carry mixed labelSchemaVersions (refusing to merge)'] };
    const expGen = opts.generation ?? (recordGens.size === 1 ? [...recordGens][0] : versions.generation);
    const expLsv = opts.labelSchemaVersion ?? (recordLsvs.size === 1 ? [...recordLsvs][0] : versions.labelSchemaVersion);
    if (typeof expGen !== 'string' || !expGen) return { ok: false, generation: versions.generation, reasons: ['generation must be a non-empty string'] };
    if (typeof expLsv !== 'string' || !expLsv) return { ok: false, generation: versions.generation, reasons: ['labelSchemaVersion must be a non-empty string'] };
    for (const rec of sourceRecords) {
      if (rec && rec.profileVersion !== undefined && rec.profileVersion !== null && rec.profileVersion !== versions.profileVersion) {
        return { ok: false, generation: versions.generation, reasons: [`record ${String(rec.id ?? '?')}: foreign profileVersion (rebuild does not convert profiles)`] };
      }
    }
    if (typeof activeStore.checkCompatibility === 'function') {
      let check;
      try {
        check = await activeStore.checkCompatibility({ versions: { generation: expGen, profileVersion: versions.profileVersion, labelSchemaVersion: expLsv }, profileFingerprint: versions.profileVersion });
      } catch (error) {
        return { ok: false, generation: versions.generation, reasons: [`store.checkCompatibility failed: ${String(error?.message || error)}`] };
      }
      if (!check || check.ready !== true) {
        return { ok: false, generation: versions.generation, reasons: ['store reports not ready for the adopted versions'] };
      }
    }
    if (typeof activeStore.clear === 'function') {
      await commitStoreWrite(() => activeStore.clear());
    } else {
      const existing = await activeStore.list();
      if (Array.isArray(existing)) {
        for (const rec of existing) {
          if (rec && typeof rec.id === 'string') await commitStoreWrite(() => activeStore.remove(rec.id));
        }
      }
    }
    ledger.clear();
    mirror.clear();
    sourceOf.clear();
    // 新 store 已是空集：镜像直接进入 ready，避免随后 upsert 又 list 一遍。
    mirrorReady = true;
    const previous = { ...versions };
    versions.generation = expGen;
    versions.labelSchemaVersion = expLsv;
    state = 'ready';
    dirty = false;
    versionNotes = [];
    const result = await upsert(sourceRecords, { generation: expGen, labelSchemaVersion: expLsv });
    if (!result.ok) {
      versions.generation = previous.generation;
      versions.labelSchemaVersion = previous.labelSchemaVersion;
      state = 'version-incompatible';
      versionNotes = result.reasons.filter((r) => r.includes('version-incompatible'));
      return { ok: false, generation: versions.generation, reasons: result.reasons };
    }
    syncRevision();
    return { ok: true, generation: versions.generation, reasons: [] };
  }

  async function close() {
    state = 'closed';
    // 关闭即释放常驻镜像（活动索引之外不再囤第二份记录/向量引用）。
    mirror.clear();
    ledger.clear();
    sourceOf.clear();
    mirrorReady = false;
    return { ok: true };
  }

  return Object.freeze({ status, statusDetails, upsert, remove, removeRecords, ids, counts, query, rebuild, close });
}

export const VECTOR_NAMESPACES = Object.freeze(['anchors', 'memory']);

/**
 * Two independent exact-search indexes sharing one encoder. Each namespace gets
 * its own store instance, version state and source-removal ledger.
 */
export function createVectorNamespaces({ profile, embedder, stores = {}, generation = 'gen-1', labelSchemaVersion = 'labels-v1' } = {}) {
  if (!stores || typeof stores !== 'object' || Array.isArray(stores)) throw new TypeError('stores must be a namespace-to-store object');
  for (const key of Object.keys(stores)) {
    if (!VECTOR_NAMESPACES.includes(key)) throw new TypeError(`unknown vector namespace: ${key}`);
  }
  const anchorsStore = stores.anchors ?? createMemoryStore();
  const memoryStore = stores.memory ?? createMemoryStore();
  if (anchorsStore === memoryStore) throw new TypeError('anchors and memory namespaces require separate store instances');
  const indexes = Object.freeze({
    anchors: createIndex({ profile, embedder, store: anchorsStore, generation, labelSchemaVersion }),
    memory: createIndex({ profile, embedder, store: memoryStore, generation, labelSchemaVersion }),
  });
  function forNamespace(namespace) {
    if (!VECTOR_NAMESPACES.includes(namespace)) throw new TypeError(`unknown vector namespace: ${String(namespace)}`);
    return indexes[namespace];
  }
  return Object.freeze({
    namespaces: VECTOR_NAMESPACES,
    status(namespace) {
      const index = forNamespace(namespace);
      return { namespace, ...index.statusDetails() };
    },
    query(namespace, textOrVec, opts) { return forNamespace(namespace).query(textOrVec, opts); },
    upsert(namespace, records, opts) { return forNamespace(namespace).upsert(records, opts); },
    remove(namespace, sourceIds) { return forNamespace(namespace).remove(sourceIds); },
    rebuild(namespace, sourceRecords, opts) { return forNamespace(namespace).rebuild(sourceRecords, opts); },
    async close() { await Promise.all(VECTOR_NAMESPACES.map((namespace) => indexes[namespace].close())); return { ok: true }; },
  });
}
