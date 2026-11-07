import { createHash } from 'node:crypto';

export const EMBEDDING_DIMENSIONS = 768;
export const MAX_POSITION_TOKENS = 512;
export const POOLING_MODES = Object.freeze(['none', 'mean', 'cls', 'last', 'rank']);

// ★ 2026-10-17（发行版基线 = 无 GPU 的普通 Windows）：本 profile 的 `runtime` 指向**随包 CPU
//   运行环境** `runtime/llama`（build 10685），不再指 `runtime/llama-cuda`。理由：
//   `createLlamaEmbeddingAdapter` 会把 profile.build 与真机 `--version` 逐字对账，而 `runtime/llama`
//   与 `runtime/llama-cuda` 是两个不同 build ⇒ 拿 CUDA profile 启 CPU 二进制必然
//   `version-incompatible`。GPU 机器要走 CUDA 用下面的 `BGE_ZH_LOCAL_CUDA_PROFILE`（装配层按
//   `vector.runtime` 选，见 apps/server/assembly.js）。
export const DEFAULT_EMBEDDING_PROFILE = Object.freeze({
  id: 'bge-base-zh-v1.5-q8_0',
  modelFile: 'models/new true/bge-base-zh-v1.5-q8_0.gguf',
  modelSha256: null, // Fill from the distributed artifact at install/verification time.
  runtime: 'runtime/llama',
  runtimeBuild: 'llama.cpp 0.2.0-dev build 10685',
  cpuRuntime: 'runtime/llama',
  cpuRuntimeBuild: 'llama.cpp 0.2.0-dev build 10685',
  pooling: 'cls',
  embdNormalize: true,
  dimensions: EMBEDDING_DIMENSIONS,
  maxPositionTokens: MAX_POSITION_TOKENS,
  queryTemplate: '为这个句子生成表示以用于检索相关文章：{text}',
  documentTemplate: '{text}',
  templateTokenBudget: 'template-and-prefix-count-toward-512',
  gpuLayers: 99,
  cpuFallbackGpuLayers: 0,
});

export function validateEmbeddingProfile(profile) {
  const errors = [];
  if (!profile || typeof profile !== 'object') return { ok: false, errors: ['profile must be an object'] };
  for (const key of ['id', 'modelFile', 'runtime', 'runtimeBuild', 'queryTemplate', 'documentTemplate']) {
    if (typeof profile[key] !== 'string' || !profile[key]) errors.push(`${key} must be a non-empty string`);
  }
  if (!/^[a-f\d]{64}$/i.test(profile.modelSha256 || '')) errors.push('modelSha256 must be verified SHA-256 hex before opening an embedding profile');
  if (!POOLING_MODES.includes(profile.pooling)) errors.push(`pooling must be one of ${POOLING_MODES.join('|')}`);
  if (profile.embdNormalize !== true && profile.embdNormalize !== false) errors.push('embdNormalize must be boolean');
  if (profile.dimensions !== EMBEDDING_DIMENSIONS) errors.push(`dimensions must equal ${EMBEDDING_DIMENSIONS}`);
  if (profile.maxPositionTokens !== MAX_POSITION_TOKENS) errors.push(`maxPositionTokens must equal ${MAX_POSITION_TOKENS}`);
  return { ok: errors.length === 0, errors };
}

function stableProfile(profile) {
  return Object.fromEntries(Object.keys(profile).sort().map((key) => [key, profile[key]]));
}

export function profileFingerprint(profile) {
  if (isTicketProfileShape(profile)) {
    // V1a 票形：先走票面校验（非法当场 throw，和旧路同语义），再稳定哈希。
    const checked = validateTicketProfile(profile);
    if (!checked.ok) throw new TypeError(`invalid embedding profile: ${checked.errors.join('; ')}`);
    return createHash('sha256').update(JSON.stringify(stableProfile(profile))).digest('hex');
  }
  const checked = validateEmbeddingProfile(profile);
  if (!checked.ok) throw new TypeError(`invalid embedding profile: ${checked.errors.join('; ')}`);
  return createHash('sha256').update(JSON.stringify(stableProfile(profile))).digest('hex');
}

export function embeddingCacheKey(first, purposeOrText, templatedText) {
  if (first && typeof first === 'object' && !Array.isArray(first) && 'instanceId' in Object(first)) {
    // V0 旧形：embeddingCacheKey({ instanceId, profile, encodedText, purpose }) —— 行为逐字节不变。
    const { instanceId, profile, encodedText, purpose } = first;
    if (typeof instanceId !== 'string' || !instanceId) throw new TypeError('instanceId is required');
    if (typeof encodedText !== 'string') throw new TypeError('encodedText must be a string');
    if (purpose !== 'query' && purpose !== 'document') throw new TypeError('purpose must be query or document');
    const profileId = profileFingerprint(profile);
    const textHash = createHash('sha256').update(encodedText, 'utf8').digest('hex');
    return `${instanceId}:${profileId}:${purpose}:${textHash}`;
  }
  // V1a 票形：embeddingCacheKey(profile, purpose, templatedText) —— 无 instanceId，照票面。
  const profile = first;
  const purpose = purposeOrText;
  if (purpose !== 'query' && purpose !== 'document') throw new TypeError('purpose must be query or document');
  if (typeof templatedText !== 'string') throw new TypeError('templatedText must be a string');
  const profileId = profileFingerprint(profile);
  const textHash = createHash('sha256').update(templatedText, 'utf8').digest('hex');
  return `${profileId}:${purpose}:${textHash}`;
}

export function validateVector(vector, dimensions = EMBEDDING_DIMENSIONS) {
  if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) throw new TypeError('embedding must be an array or typed array');
  if (vector.length !== dimensions) throw new RangeError(`embedding dimension mismatch: expected ${dimensions}, got ${vector.length}`);
  for (let i = 0; i < vector.length; i += 1) {
    if (typeof vector[i] !== 'number' || !Number.isFinite(vector[i])) throw new TypeError(`embedding[${i}] must be finite`);
  }
  return Array.from(vector);
}

export function configuredPorts(profileNumber, { decisionPort, embeddingPort } = {}) {
  const n = Number(profileNumber);
  if (!Number.isInteger(n) || n < 1) throw new RangeError('profileNumber must be a positive integer');
  const base = 18080 + (n - 1) * 10;
  const decision = decisionPort === undefined ? base : Number(decisionPort);
  const embedding = embeddingPort === undefined ? base + 1 : Number(embeddingPort);
  if (![decision, embedding].every((p) => Number.isInteger(p) && p > 0 && p < 65536)) throw new RangeError('ports must be valid TCP ports');
  if (decision === embedding) throw new Error(`port conflict: decision and embedding both use ${decision}`);
  return { decision, embedding };
}

export function validateRuntimeConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') return { ok: false, errors: ['runtime config must be an object'] };
  for (const key of ['dataDir', 'modelDir', 'decisionExecutable', 'embeddingExecutable']) {
    if (typeof config[key] !== 'string' || !config[key]) errors.push(`${key} must be configured`);
  }
  try { configuredPorts(config.profileNumber, config.ports); } catch (error) { errors.push(error.message); }
  for (const key of ['threads', 'batchThreads', 'concurrency']) {
    if (!Number.isInteger(config[key]) || config[key] < 1) errors.push(`${key} must be a positive integer`);
  }
  if (!['on-demand', 'resident'].includes(config.serviceTier)) errors.push('serviceTier must be on-demand or resident');
  if (!Number.isInteger(config.gpuLayers) || config.gpuLayers < 0) errors.push('gpuLayers must be a non-negative integer (0 enables CPU)');
  return { ok: errors.length === 0, errors };
}

// ── V1a 票形 Profile（票 V1a §一；与 V0 旧形并存，不替换） ───────────────────────
// 票形字段：profileVersion/modelId/modelSha256/runtime('llama'|'llama-cuda')/build/
// pooling(5 档)/embdNormalize(数字,默认2)/queryTemplate/docTemplate/maxPositions(默认512)/dims(默认768)。
// 旧形标记：dimensions/documentTemplate 等；票形标记：dims/profileVersion/docTemplate/modelId/maxPositions。
// 两形字段名不同（embdNormalize 布尔 vs 数字、documentTemplate vs docTemplate）， fingerprint/缓存键按标记分流。

export const TICKET_PROFILE_DEFAULTS = Object.freeze({
  embdNormalize: 2,
  queryTemplate: '为这个句子生成表示以用于检索相关文章：{text}',
  docTemplate: '{text}',
  maxPositions: 512,
  dims: EMBEDDING_DIMENSIONS,
});

export function isTicketProfileShape(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return false;
  return 'dims' in profile || 'profileVersion' in profile || 'docTemplate' in profile
    || 'modelId' in profile || 'maxPositions' in profile || 'build' in profile
    || typeof profile.embdNormalize === 'number';
}

/**
 * 集中数字守卫（票 V1a §三）：凡从外部来的数，先显式判 null/undefined/'' 再 Number()。
 * 本模块新代码一律走它，不许裸写 Number(外部值)。非法一律 throw（调用方转成 {ok:false} 自便）。
 */
export function toFiniteNumber(value, opts = {}) {
  const what = typeof opts.what === 'string' && opts.what ? opts.what : 'number';
  if (value === null || value === undefined || value === '') {
    throw new TypeError(`${what} is missing (null/undefined/'' are never coerced to 0)`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError(`${what} must be a finite number`);
  if (opts.integer === true && !Number.isInteger(n)) throw new TypeError(`${what} must be an integer`);
  if (opts.min !== undefined && n < opts.min) throw new RangeError(`${what} must be >= ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw new RangeError(`${what} must be <= ${opts.max}`);
  return n;
}

export function validateTicketProfile(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['profile must be an object'] };
  if (typeof input.profileVersion !== 'string' || !input.profileVersion) errors.push('profileVersion must be a non-empty string');
  if (typeof input.modelId !== 'string' || !input.modelId) errors.push('modelId must be a non-empty string');
  // modelSha256 允许留空（null/undefined = 未验证；真机启用门由 isProfileVerified/V1b 启动器负责，V1a fake 路径不受限）。
  // 只有"填了但格式不对"才算错。
  if (input.modelSha256 !== null && input.modelSha256 !== undefined
    && (typeof input.modelSha256 !== 'string' || !/^[a-f\d]{64}$/i.test(input.modelSha256))) {
    errors.push('modelSha256 must be 64-hex SHA-256 once filled');
  }
  if (input.runtime !== 'llama' && input.runtime !== 'llama-cuda') errors.push("runtime must be 'llama' or 'llama-cuda'");
  if (typeof input.build !== 'string' || !input.build) errors.push('build must be a non-empty string');
  if (!POOLING_MODES.includes(input.pooling)) errors.push(`pooling must be one of ${POOLING_MODES.join('|')}`);
  if (input.embdNormalize === null || input.embdNormalize === undefined) {
    // 缺失走默认 2，不算错（makeProfile 回填）。
  } else if (typeof input.embdNormalize !== 'number' || !Number.isFinite(input.embdNormalize)) {
    errors.push('embdNormalize must be a finite number');
  }
  for (const key of ['queryTemplate', 'docTemplate']) {
    if (input[key] === null || input[key] === undefined) continue; // 缺失走默认
    if (typeof input[key] !== 'string' || !input[key]) errors.push(`${key} must be a non-empty string once given`);
  }
  for (const [key, dflt] of [['maxPositions', 512], ['dims', EMBEDDING_DIMENSIONS]]) {
    if (input[key] === null || input[key] === undefined) continue; // 缺失走默认
    if (typeof input[key] !== 'number' || !Number.isInteger(input[key]) || input[key] < 1) {
      errors.push(`${key} must be a positive integer once given (default ${dflt})`);
    }
  }
  if (input.dims !== null && input.dims !== undefined && input.dims !== EMBEDDING_DIMENSIONS) {
    errors.push(`dims must equal ${EMBEDDING_DIMENSIONS} (V1a frozen; got ${input.dims})`);
  }
  return { ok: errors.length === 0, errors };
}

/** 票形构造器：字段全在、缺失/非法当场 throw；有默认的回填；返回冻结对象。多余字段忽略（前向兼容）。 */
export function makeProfile(input) {
  const checked = validateTicketProfile(input);
  if (!checked.ok) throw new TypeError(`invalid embedding profile: ${checked.errors.join('; ')}`);
  return Object.freeze({
    profileVersion: input.profileVersion,
    modelId: input.modelId,
    modelSha256: input.modelSha256,
    runtime: input.runtime,
    build: input.build,
    pooling: input.pooling,
    embdNormalize: input.embdNormalize === null || input.embdNormalize === undefined ? 2 : input.embdNormalize,
    queryTemplate: input.queryTemplate === null || input.queryTemplate === undefined ? TICKET_PROFILE_DEFAULTS.queryTemplate : input.queryTemplate,
    docTemplate: input.docTemplate === null || input.docTemplate === undefined ? TICKET_PROFILE_DEFAULTS.docTemplate : input.docTemplate,
    maxPositions: input.maxPositions === null || input.maxPositions === undefined ? 512 : input.maxPositions,
    dims: input.dims === null || input.dims === undefined ? EMBEDDING_DIMENSIONS : input.dims,
  });
}

/**
 * Verified local BGE profile shipped with the repository's llama.cpp runtimes.
 *
 * ★ 2026-10-17（发行版基线 = 无 GPU 的普通 Windows）：**默认出口改成 CPU 那一支**。
 *   `runtime`/`build` 是"真机二进制对账"的输入（`llama-embedder.js` 会拿 `--version` 逐字比），
 *   所以 profile 必须与**实际要启的 exe**同支：
 *     · `BGE_ZH_LOCAL_PROFILE`       = CPU（`runtime/llama`，build 10685）—— 随包默认；
 *     · `BGE_ZH_LOCAL_CUDA_PROFILE`  = CUDA（`runtime/llama-cuda`，build 11068）—— 显式 opt-in。
 *   两者 `modelSha256` 相同（同一个 bge 模型文件），差异只在运行环境。
 */
export const BGE_ZH_LOCAL_PROFILE = makeProfile({
  profileVersion: 'bge-zh-v1',
  modelId: 'bge-base-zh-v1.5-q8_0',
  modelSha256: '893a0f07100c135b35196fc95058f5933c3435905b167ac29c58d77d7cef4be7',
  runtime: 'llama',
  build: 'llama.cpp 0.2.0-dev build 10685',
  pooling: 'cls',
  embdNormalize: 2,
  queryTemplate: '为这个句子生成表示以用于检索相关文章：{text}',
  docTemplate: '{text}',
  maxPositions: 512,
  dims: EMBEDDING_DIMENSIONS,
});

/** 同一模型的 CUDA 运行环境档（只在机器真的能跑 CUDA 且用户显式选择时用，见 assembly 的 vector.runtime）。 */
export const BGE_ZH_LOCAL_CUDA_PROFILE = makeProfile({
  profileVersion: 'bge-zh-v1',
  modelId: 'bge-base-zh-v1.5-q8_0',
  modelSha256: '893a0f07100c135b35196fc95058f5933c3435905b167ac29c58d77d7cef4be7',
  runtime: 'llama-cuda',
  build: 'llama.cpp 0.4.1-dev build 11068',
  pooling: 'cls',
  embdNormalize: 2,
  queryTemplate: '为这个句子生成表示以用于检索相关文章：{text}',
  docTemplate: '{text}',
  maxPositions: 512,
  dims: EMBEDDING_DIMENSIONS,
});

/** 真机启用门（V1b 的启动器负责拦）：sha 未填/非法 ⇒ false。V1a 的 fake 路径不受此限（否则自检跑不起来），见票 §五。 */
export function isProfileVerified(profile) {
  return !!profile && typeof profile.modelSha256 === 'string' && /^[a-f\d]{64}$/i.test(profile.modelSha256);
}

/** 票形 validateDimensions：读 profile.dims（兼容旧形 dimensions）；只返回 {ok}，不抛。 */
export function validateDimensions(profile, vec) {
  const rawDims = profile ? (profile.dims ?? profile.dimensions) : undefined;
  let dims;
  try {
    dims = toFiniteNumber(rawDims, { what: 'profile dims', integer: true, min: 1 });
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  }
  if (!Array.isArray(vec) && !ArrayBuffer.isView(vec)) return { ok: false, reason: 'vector must be an array or typed array' };
  if (vec.length !== dims) return { ok: false, reason: `dimension mismatch: profile wants ${dims}, got ${vec.length}` };
  for (let i = 0; i < vec.length; i += 1) {
    if (typeof vec[i] !== 'number' || !Number.isFinite(vec[i])) return { ok: false, reason: `vector[${i}] must be a finite number` };
  }
  return { ok: true };
}
