import { DEFAULT_EMBEDDING_PROFILE, EMBEDDING_DIMENSIONS, embeddingCacheKey, profileFingerprint, validateEmbeddingProfile, validateVector } from './profile.js';
import { assertEvaluationInput } from './evaluation.js';

export { DEFAULT_EMBEDDING_PROFILE, EMBEDDING_DIMENSIONS, POOLING_MODES, MAX_POSITION_TOKENS, configuredPorts, validateRuntimeConfig, embeddingCacheKey, profileFingerprint, validateEmbeddingProfile, validateVector } from './profile.js';
export { assertEvaluationInput, validateEvaluationSplits } from './evaluation.js';
// V1a 票形（与 V0 旧形并存；差异逐条见票与回执，不在此改旧行为）
export { TICKET_PROFILE_DEFAULTS, isTicketProfileShape, toFiniteNumber, validateTicketProfile, makeProfile, isProfileVerified, validateDimensions, BGE_ZH_LOCAL_PROFILE, BGE_ZH_LOCAL_CUDA_PROFILE } from './profile.js';
export { makeFakeEmbedder, fakeVectorForText, cosineSimilarity } from './fake-embedder.js';
export { createMemoryStore, createIndex, createVectorNamespaces, VECTOR_NAMESPACES } from './vector-index.js';
export { createLlamaEmbeddingAdapter, createLlamaEmbeddingRuntime } from './llama-embedder.js';
// ★ 2026-10-17（端口回落）：装配层要在 start() 前自己核"这个口空不空"，用**与 runtime 内部同一套**
//   探测实现（不是各写一份 socket 判定）—— 同一个导出，两处同源。
export { portAvailable } from './llama-embedder.js';

export const READ_STATUSES = Object.freeze(['success', 'empty', 'not-ready', 'timeout', 'cancelled', 'version-incompatible', 'stale', 'partial-coverage', 'error']);

function inScope(item, scope) {
  if (!scope || typeof scope !== 'object') return false;
  return Object.entries(scope).every(([key, value]) => item?.scope?.[key] === value);
}

function cosine(a, b) {
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

/** Pure adapter shell. embed/store are injected; constructing or importing it starts no process. */
export function createVectorIndex({
  profile = DEFAULT_EMBEDDING_PROFILE,
  embed,
  store,
  instanceId = 'default',
  generation = 'v0',
  profileVersion = 'bge-v1',
  labelSchemaVersion = 'labels-v1',
} = {}) {
  const validProfile = validateEmbeddingProfile(profile);
  if (!validProfile.ok) throw new TypeError(`invalid embedding profile: ${validProfile.errors.join('; ')}`);
  if (typeof embed !== 'function') throw new TypeError('embed must be injected');
  if (!store || typeof store !== 'object') throw new TypeError('store adapter must be injected');
  let state = 'not-ready';
  const versions = { generation, profileVersion, labelSchemaVersion };

  function status() { return { state, versions: { ...versions }, profileFingerprint: profileFingerprint(profile) }; }
  async function markReady() {
    if (typeof store.checkCompatibility !== 'function') return { ...status(), ok: false, reason: 'store.checkCompatibility is required' };
    let check;
    try { check = await store.checkCompatibility({ versions: { ...versions }, profileFingerprint: profileFingerprint(profile) }); }
    catch (error) { return { ...status(), ok: false, reason: String(error?.message || error) }; }
    if (check?.ready !== true) return { ...status(), ok: false, reason: 'index is not built/ready' };
    const actualVersions = check.versions;
    if (!actualVersions || typeof actualVersions !== 'object') return { ...status(), ok: false, reason: 'index version metadata is missing' };
    for (const key of Object.keys(versions)) {
      if (actualVersions[key] !== versions[key]) { state = 'version-incompatible'; return { ...status(), ok: false, reason: `incompatible ${key}` }; }
    }
    if (check.profileFingerprint !== profileFingerprint(profile)) { state = 'version-incompatible'; return { ...status(), ok: false, reason: 'incompatible embedding profile' }; }
    state = 'ready';
    return { ...status(), ok: true };
  }
  async function embedText(text, purpose = 'query') {
    const template = purpose === 'document' ? profile.documentTemplate : profile.queryTemplate;
    const encodedText = template.replace('{text}', String(text ?? ''));
    const cacheKey = embeddingCacheKey({ instanceId, profile, encodedText, purpose });
    const vector = validateVector(await embed({ text: encodedText, purpose, profile, cacheKey }), EMBEDDING_DIMENSIONS);
    return { vector, cacheKey, encodedText };
  }
  async function query({ text, scope, limit = 10, evaluationExample, evaluationMode = false } = {}) {
    if (state !== 'ready') return { ok: false, status: state === 'closed' ? 'cancelled' : state, items: [] };
    if (evaluationMode && !evaluationExample) return { ok: false, status: 'error', error: 'evaluationExample is required in evaluation mode', items: [] };
    if (evaluationExample) {
      try { assertEvaluationInput(evaluationExample, text); }
      catch (error) { return { ok: false, status: 'error', error: String(error?.message || error), items: [] }; }
    }
    if (!scope || typeof scope !== 'object' || !Object.keys(scope).length) return { ok: false, status: 'error', error: 'scope is required', items: [] };
    try {
      const { vector } = await embedText(text, 'query');
      if (state === 'closed') return { ok: false, status: 'cancelled', items: [] };
      const candidates = await store.list();
      if (state === 'closed') return { ok: false, status: 'cancelled', items: [] };
      if (!Array.isArray(candidates)) throw new TypeError('store.list() must return an array');
      // Enforce scope before touching the similarity function.
      const visible = candidates.filter((item) => inScope(item, scope));
      const expectedProfile = profileFingerprint(profile);
      const incompatible = visible.find((item) => !item.versions || Object.keys(versions).some((key) => item.versions[key] !== versions[key]) || item.profileFingerprint !== expectedProfile);
      if (incompatible) return { ok: false, status: 'version-incompatible', error: `record ${String(incompatible.id ?? incompatible.sourceId ?? '')} has incompatible generation/profile/label schema`, items: [] };
      const items = visible.map((item) => ({ ...item, similarity: cosine(vector, validateVector(item.vector)) }))
        .sort((a, b) => b.similarity - a.similarity).slice(0, Math.max(1, Number(limit) || 10));
      return items.length ? { ok: true, status: 'success', items } : { ok: true, status: 'empty', items: [] };
    } catch (error) {
      if (state === 'closed') return { ok: false, status: 'cancelled', items: [] };
      const statusCode = error?.name === 'AbortError' ? 'cancelled' : /timeout/i.test(String(error?.message)) ? 'timeout' : 'error';
      return { ok: false, status: statusCode, error: String(error?.message || error), items: [] };
    }
  }
  async function upsert(record) {
    if (state !== 'ready') return { ok: false, status: state === 'closed' ? 'cancelled' : state, error: 'index is not ready' };
    if (!record?.sourceId || !Array.isArray(record.evidenceIds) || record.evidenceIds.length === 0) return { ok: false, status: 'error', error: 'sourceId and evidenceIds are required' };
    try {
      const { vector } = await embedText(record.text, 'document');
      await store.upsert({ ...record, vector, versions: { ...versions }, profileFingerprint: profileFingerprint(profile) });
      return { ok: true, status: 'success' };
    } catch (error) { return { ok: false, status: 'error', error: String(error?.message || error) }; }
  }
  async function remove(sourceId) {
    if (state !== 'ready') return { ok: false, status: state === 'closed' ? 'cancelled' : state, error: 'index is not ready' };
    if (typeof store.remove !== 'function') return { ok: false, status: 'error', error: 'store.remove is unavailable' };
    try { await store.remove(sourceId); return { ok: true, status: 'success' }; }
    catch (error) { return { ok: false, status: 'error', error: String(error?.message || error) }; }
  }
  async function rebuild() { return state === 'ready' ? { ok: false, status: 'error', error: 'rebuild belongs to the write-side lifecycle adapter in V1' } : { ok: false, status: state === 'closed' ? 'cancelled' : state, error: 'index is not ready' }; }
  async function close() { state = 'closed'; return { ok: true, status: 'cancelled' }; }
  return Object.freeze({ status, markReady, embedText, query, upsert, remove, rebuild, close });
}
