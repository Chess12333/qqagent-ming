import { createHash } from 'node:crypto';
import { closeSync, createReadStream, openSync, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { embeddingCacheKey, isProfileVerified, makeProfile, profileFingerprint, validateVector } from './profile.js';

const VALID_STATUSES = new Set(['not-ready', 'timeout', 'cancelled', 'version-incompatible', 'stale', 'error']);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function fail(status, reason) { return { ok: false, status, reason: String(reason || status) }; }

function ensureRealProfile(profile) {
  const frozen = makeProfile(profile);
  if (!isProfileVerified(frozen)) throw new TypeError('real llama embeddings require a verified model SHA-256');
  if (frozen.dims !== 768) throw new TypeError('real BGE profile must have 768 dimensions');
  if (frozen.pooling !== 'cls') throw new TypeError('real BGE profile must use CLS pooling');
  if (frozen.embdNormalize !== 2) throw new TypeError('real BGE profile must use Euclidean normalization (2)');
  if (frozen.maxPositions !== 512) throw new TypeError('real BGE profile must use a 512-position limit');
  if (!['llama', 'llama-cuda'].includes(frozen.runtime)) throw new TypeError('profile runtime must be llama or llama-cuda');
  for (const key of ['queryTemplate', 'docTemplate']) {
    if (frozen[key].split('{text}').length !== 2) throw new TypeError(`${key} must contain exactly one {text} placeholder`);
  }
  return frozen;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function profileBuildParts(build) {
  const match = String(build).match(/(?:llama\.cpp\s+)?(\S+)\s+build\s+(\d+)/i);
  return match ? { version: match[1], number: match[2] } : null;
}

function l2Norm(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

function normalize(vector) {
  const checked = validateVector(vector, 768);
  const norm = l2Norm(checked);
  if (!Number.isFinite(norm) || norm <= 0) throw new TypeError('embedding has zero or invalid L2 norm');
  return checked.map((value) => value / norm);
}

function isLocalEndpoint(endpoint) {
  let parsed;
  try { parsed = new URL(endpoint); } catch { return false; }
  return parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname.toLowerCase());
}

function readTail(text, count = 8) {
  return String(text).split(/\r?\n/).filter(Boolean).slice(-count);
}

/**
 * Real local llama-server embedder. Construction/import is inert; model hashing,
 * health checks and network calls happen only when verifyModel()/embed() is called.
 */
export function createLlamaEmbeddingAdapter({
  profile,
  modelPath,
  endpoint = 'http://127.0.0.1:18081',
  instanceId = 'embedding-1',
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  readinessTimeoutMs = 500,
  readinessCooldownMs = 30000,
  now = Date.now,
  maxConcurrent = 1,
  maxQueued = 8,
  cacheEntries = 256,
} = {}) {
  const frozen = ensureRealProfile(profile);
  if (typeof modelPath !== 'string' || !modelPath) throw new TypeError('modelPath is required for artifact verification');
  if (typeof instanceId !== 'string' || !instanceId) throw new TypeError('instanceId is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!isLocalEndpoint(endpoint)) throw new TypeError('embedding endpoint must be local http://localhost');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer');
  if (!Number.isInteger(readinessTimeoutMs) || readinessTimeoutMs < 1) throw new TypeError('readinessTimeoutMs must be a positive integer');
  if (!Number.isInteger(readinessCooldownMs) || readinessCooldownMs < 1) throw new TypeError('readinessCooldownMs must be a positive integer');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new TypeError('maxConcurrent must be a positive integer');
  if (!Number.isInteger(maxQueued) || maxQueued < 0) throw new TypeError('maxQueued must be a non-negative integer');
  if (!Number.isInteger(cacheEntries) || cacheEntries < 0) throw new TypeError('cacheEntries must be a non-negative integer');

  const baseUrl = endpoint.replace(/\/+$/, '');
  const fingerprint = profileFingerprint(frozen);
  const expectedBuild = profileBuildParts(frozen.build);
  let verifiedModel = null;
  let lastStatus = 'not-ready';
  let closed = false;
  let retryAt = 0;
  let unavailableReason = '';
  let active = 0;
  const waiters = [];
  const activeControllers = new Set();
  const cache = new Map();
  const inflight = new Map();

  async function verifyModel() {
    if (closed) return fail('cancelled', 'embedder is closed');
    if (verifiedModel) return { ok: true, sha256: verifiedModel, profileFingerprint: fingerprint };
    try {
      const actual = await sha256File(modelPath);
      if (actual.toLowerCase() !== frozen.modelSha256.toLowerCase()) {
        lastStatus = 'version-incompatible';
        return fail('version-incompatible', `model SHA-256 mismatch: expected ${frozen.modelSha256}, got ${actual}`);
      }
      verifiedModel = actual;
      return { ok: true, sha256: actual, profileFingerprint: fingerprint };
    } catch (error) {
      lastStatus = 'error';
      return fail('error', `cannot verify embedding model: ${String(error?.message || error)}`);
    }
  }

  async function requestJson(route, payload, signal) {
    let response;
    let body;
    try {
      const perform = async () => {
        response = await fetchImpl(`${baseUrl}${route}`, {
          method: payload === undefined ? 'GET' : 'POST',
          headers: payload === undefined ? undefined : { 'content-type': 'application/json' },
          body: payload === undefined ? undefined : JSON.stringify(payload),
          signal,
        });
        const raw = await response.text();
        try { body = JSON.parse(raw); } catch { body = null; }
      };
      // Bound even a transport/body reader that ignores AbortSignal.
      let onAbort;
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(new Error('request aborted'));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
      try { await Promise.race([perform(), aborted]); }
      finally { signal?.removeEventListener('abort', onAbort); }
    } catch (error) {
      if (signal?.aborted) return fail(signal.reason === 'cancelled' ? 'cancelled' : 'timeout', `request ${route} ${signal.reason === 'cancelled' ? 'was cancelled' : 'timed out'}`);
      return fail('not-ready', `cannot reach llama-server at ${baseUrl}${route}: ${String(error?.message || error)}`);
    }
    if (!response.ok) {
      const reason = body?.error?.message || body?.error || `HTTP ${response.status}`;
      if (response.status === 408 || response.status === 504) return fail('timeout', reason);
      if (response.status === 503) return fail('not-ready', reason);
      return fail('error', `${route}: ${String(reason)}`);
    }
    if (!body || typeof body !== 'object') return fail('error', `${route} returned invalid JSON`);
    return { ok: true, body };
  }

  function timeoutSignal(externalSignal, budgetMs = timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort('timeout'); }, budgetMs);
    const relayAbort = () => controller.abort('cancelled');
    if (externalSignal) {
      if (externalSignal.aborted) relayAbort();
      else externalSignal.addEventListener('abort', relayAbort, { once: true });
    }
    activeControllers.add(controller);
    return {
      signal: controller.signal,
      timedOut: () => timedOut,
      externalAborted: () => Boolean(externalSignal?.aborted),
      dispose: () => {
        clearTimeout(timer);
        externalSignal?.removeEventListener('abort', relayAbort);
        activeControllers.delete(controller);
      },
    };
  }

  async function inspectServer(signal) {
    // Offline service must not wait for a cold model-file hash.
    const health = await requestJson('/health', undefined, signal);
    if (!health.ok) {
      if (health.status === 'error') return fail('not-ready', `llama-server health check failed: ${health.reason}`);
      return health;
    }
    const verified = await verifyModel();
    if (!verified.ok) return { ...verified, stage: 'model-verification' };
    const models = await requestJson('/v1/models', undefined, signal);
    if (!models.ok) return models;
    const modelList = Array.isArray(models.body.data) ? models.body.data : [];
    if (!modelList.some((item) => item && String(item.id).toLowerCase() === frozen.modelId.toLowerCase())) {
      lastStatus = 'version-incompatible';
      return fail('version-incompatible', `server model alias does not match profile modelId ${frozen.modelId}`);
    }
    const props = await requestJson('/props', undefined, signal);
    if (!props.ok) return props;
    const reportedPath = typeof props.body.model_path === 'string' ? props.body.model_path : '';
    const reportedBuild = typeof props.body.build_info === 'string' ? props.body.build_info : '';
    const expectedModelName = resolve(modelPath).toLowerCase();
    const actualModelName = reportedPath ? resolve(reportedPath).toLowerCase() : '';
    if (!actualModelName || expectedModelName !== actualModelName) {
      lastStatus = 'version-incompatible';
      return fail('version-incompatible', `server model_path does not match verified artifact ${modelPath}`);
    }
    if (!expectedBuild || !reportedBuild.includes(expectedBuild.number)) {
      lastStatus = 'version-incompatible';
      return fail('version-incompatible', `server build_info does not match profile build ${frozen.build}`);
    }
    lastStatus = 'ready';
    return { ok: true, status: 'ready', profileFingerprint: fingerprint, modelSha256: verified.sha256, modelId: frozen.modelId, build: frozen.build };
  }

  function coolingDown() {
    if (now() >= retryAt) return null;
    return fail('not-ready', `llama-server 暂未就绪，失败冷却中（剩余 ${Math.ceil(retryAt - now())}ms）：${unavailableReason}`);
  }

  function rememberUnavailable(result) {
    if (result.stage === 'model-verification' || !['not-ready', 'timeout', 'error'].includes(result.status)) return result;
    unavailableReason = result.reason;
    retryAt = now() + readinessCooldownMs;
    lastStatus = 'not-ready';
    return fail('not-ready', `llama-server 就绪探测失败：${result.reason}；${readinessCooldownMs}ms 后重试`);
  }

  async function probeServer(signal, bypassCooldown = false) {
    if (closed || signal?.aborted) return fail('cancelled', 'request cancelled');
    const skipped = bypassCooldown ? null : coolingDown();
    if (skipped) return skipped;
    retryAt = 0;
    unavailableReason = '';
    const timer = timeoutSignal(signal, Math.min(timeoutMs, readinessTimeoutMs));
    try {
      const result = await inspectServer(timer.signal);
      if (!result.ok) {
        lastStatus = result.status;
        return rememberUnavailable(result);
      }
      retryAt = 0;
      unavailableReason = '';
      return result;
    } finally { timer.dispose(); }
  }

  function acquire(signal) {
    if (closed) return Promise.reject(Object.assign(new Error('embedder is closed'), { status: 'cancelled' }));
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('request cancelled'), { status: 'cancelled' }));
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve(releaseFactory());
    }
    if (waiters.length >= maxQueued) return Promise.reject(Object.assign(new Error('embedding rate limit exceeded'), { status: 'error' }));
    return new Promise((resolveWaiter, rejectWaiter) => {
      const waiter = { resolve: resolveWaiter, reject: rejectWaiter, signal, abort: null };
      if (signal) {
        waiter.abort = () => {
          const pos = waiters.indexOf(waiter);
          if (pos !== -1) waiters.splice(pos, 1);
          rejectWaiter(Object.assign(new Error('request cancelled'), { status: 'cancelled' }));
        };
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      waiters.push(waiter);
    });
  }

  function releaseFactory() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (waiters.length) {
        const next = waiters.shift();
        next.signal?.removeEventListener('abort', next.abort);
        if (next.signal?.aborted) {
          next.reject(Object.assign(new Error('request cancelled'), { status: 'cancelled' }));
          continue;
        }
        next.resolve(releaseFactory());
        return;
      }
      active -= 1;
    };
  }

  async function tokenizeAndFit(text, signal) {
    const tokenized = await requestJson('/tokenize', {
      content: text,
      add_special: false,
      parse_special: false,
      with_pieces: true,
    }, signal);
    if (!tokenized.ok) return tokenized;
    const tokens = tokenized.body.tokens;
    if (!Array.isArray(tokens) || tokens.some((t) => !t || !Number.isInteger(t.id))) {
      return fail('error', 'llama-server /tokenize returned malformed token pieces');
    }
    // BGE adds CLS and SEP at embedding time. Reserve both positions from 512.
    const maxContentTokens = frozen.maxPositions - 2;
    if (tokens.length <= maxContentTokens) return { ok: true, text, truncated: false, tokenCount: tokens.length };
    for (let count = maxContentTokens; count >= 0; count -= 1) {
      const selected = tokens.slice(0, count);
      if (selected.some((t) => typeof t.piece !== 'string' && !Array.isArray(t.piece))) {
        return fail('error', 'llama-server /tokenize omitted token pieces required for safe truncation');
      }
      try {
        const bytes = Buffer.concat(selected.map((t) => Array.isArray(t.piece) ? Buffer.from(t.piece) : Buffer.from(t.piece, 'utf8')));
        const fitted = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return { ok: true, text: fitted, truncated: true, tokenCount: count };
      } catch {
        // A token boundary can split a UTF-8 character; step back to the last valid prefix.
      }
    }
    return fail('error', 'cannot produce a valid UTF-8 prefix within the BGE 512-position limit');
  }

  function cachePut(key, value) {
    if (cacheEntries === 0) return;
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > cacheEntries) cache.delete(cache.keys().next().value);
  }

  async function embed(text, { purpose = 'query', signal } = {}) {
    if (closed) return fail('cancelled', 'embedder is closed');
    if (typeof text !== 'string') return fail('error', 'embedding text must be a string');
    if (purpose !== 'query' && purpose !== 'document') return fail('error', 'purpose must be query or document');
    if (signal?.aborted) return fail('cancelled', 'request cancelled');
    const skipped = coolingDown();
    if (skipped) return skipped;
    const template = purpose === 'document' ? frozen.docTemplate : frozen.queryTemplate;
    const templated = template.replace('{text}', text);
    let release;
    try { release = await acquire(signal); }
    catch (error) { return fail(VALID_STATUSES.has(error.status) ? error.status : 'error', error.message); }
    let timer;
    try {
      const server = await probeServer(signal);
      if (!server.ok) {
        lastStatus = server.status;
        return server;
      }
      timer = timeoutSignal(signal);
      const fitted = await tokenizeAndFit(templated, timer.signal);
      if (!fitted.ok) {
        lastStatus = fitted.status;
        rememberUnavailable(fitted);
        return fitted;
      }
      const cacheKey = embeddingCacheKey({ instanceId, profile: frozen, encodedText: fitted.text, purpose });
      const cached = cache.get(cacheKey);
      if (cached) {
        cache.delete(cacheKey);
        cache.set(cacheKey, cached);
        lastStatus = 'ready';
        return { ...cached, vec: [...cached.vec], cacheKey, cacheHit: true };
      }
      let promise = inflight.get(cacheKey);
      if (!promise) {
        promise = (async () => {
          const response = await requestJson('/v1/embeddings', { input: fitted.text, model: frozen.modelId, encoding_format: 'float' }, timer.signal);
          if (!response.ok) return response;
          const vector = response.body?.data?.[0]?.embedding;
          if (!Array.isArray(vector)) return fail('error', 'llama-server returned no pooled embedding');
          let normalized;
          try { normalized = normalize(vector); }
          catch (error) { return fail('version-incompatible', `embedding shape/values do not match profile: ${String(error?.message || error)}`); }
          const value = {
            ok: true,
            status: 'success',
            vec: normalized,
            dims: normalized.length,
            norm: l2Norm(normalized),
            normalized: true,
            pooling: frozen.pooling,
            embdNormalize: frozen.embdNormalize,
            profileFingerprint: fingerprint,
            modelSha256: verifiedModel,
            cacheKey,
            purpose,
            tokenCount: fitted.tokenCount,
            truncated: fitted.truncated,
            cacheHit: false,
          };
          cachePut(cacheKey, value);
          return value;
        })();
        inflight.set(cacheKey, promise);
      }
      let result;
      try { result = await promise; }
      finally { if (inflight.get(cacheKey) === promise) inflight.delete(cacheKey); }
      if (!result.ok) {
        lastStatus = result.status;
        rememberUnavailable(result);
        return result;
      }
      lastStatus = 'ready';
      return { ...result, vec: [...result.vec] };
    } catch (error) {
      const status = timer?.externalAborted() ? 'cancelled' : timer?.timedOut() ? 'timeout' : 'error';
      lastStatus = status;
      const result = fail(status, String(error?.message || error));
      rememberUnavailable(result);
      return result;
    } finally {
      timer?.dispose();
      release();
    }
  }

  function status() {
    return { state: closed ? 'cancelled' : lastStatus, profileFingerprint: fingerprint, modelSha256: verifiedModel, reason: unavailableReason || null, retryAt };
  }

  async function close() {
    if (closed) return { ok: true, status: 'cancelled' };
    closed = true;
    for (const controller of activeControllers) controller.abort('cancelled');
    for (const waiter of waiters.splice(0)) {
      waiter.signal?.removeEventListener('abort', waiter.abort);
      waiter.reject(Object.assign(new Error('embedder is closed'), { status: 'cancelled' }));
    }
    cache.clear();
    return { ok: true, status: 'cancelled' };
  }

  return Object.freeze({
    profile: frozen,
    fingerprint: () => fingerprint,
    verifyModel,
    inspectServer: ({ signal, bypassCooldown = false } = {}) => probeServer(signal, bypassCooldown),
    embed,
    status,
    close,
  });
}

async function runVersionCommand(executablePath, outputPath, timeoutMs) {
  let fd;
  let child;
  try {
    fd = openSync(outputPath, 'w');
    child = spawn(executablePath, ['--version'], { stdio: ['ignore', fd, fd], windowsHide: true });
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    return fail('error', `cannot run llama-server --version: ${String(error?.message || error)}`);
  }
  closeSync(fd);
  let timer;
  const exit = new Promise((resolveExit) => {
    child.once('error', (error) => resolveExit({ error }));
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const ended = await exit;
  clearTimeout(timer);
  let output = '';
  try { output = await fs.readFile(outputPath, 'utf8'); } catch {}
  try { await fs.unlink(outputPath); } catch {}
  if (ended.error || ended.code !== 0) return fail('error', `llama-server --version failed: ${String(ended.error?.message || output || ended.code)}`);
  return { ok: true, output, command: [executablePath, '--version'], tail: readTail(output) };
}

/**
 * 这个 (host, port) 现在能不能 bind。**导出**（经 core/vector/index.js）给装配层做"配置端口被占 ⇒
 * 依次找下一个空闲口"用：一处实现、两处同源，免得装配层自己写一份 socket 判定再慢慢漂移。
 */
export function portAvailable(host, port) {
  return new Promise((resolveAvailable) => {
    const server = net.createServer();
    server.once('error', (error) => resolveAvailable({ ok: false, reason: error.message }));
    server.listen(port, host, () => server.close((error) => resolveAvailable(error ? { ok: false, reason: error.message } : { ok: true })));
  });
}

/** Explicit, caller-owned local server lifecycle. No import-time start/autostart. */
export function createLlamaEmbeddingRuntime({
  profile,
  modelPath,
  executablePath,
  host = '127.0.0.1',
  port = 18081,
  logPath,
  threads = 4,
  batchThreads = 4,
  maxConcurrent = 1,
  gpuLayers,
  timeoutMs = 15000,
  startupTimeoutMs = 60000,
  pollIntervalMs = 250,
  fetchImpl = globalThis.fetch,
} = {}) {
  const frozen = ensureRealProfile(profile);
  const expectedBuild = profileBuildParts(frozen.build);
  if (typeof modelPath !== 'string' || !modelPath) throw new TypeError('modelPath is required');
  if (typeof executablePath !== 'string' || !executablePath) throw new TypeError('executablePath is required');
  if (typeof logPath !== 'string' || !logPath) throw new TypeError('logPath is required');
  if (!LOCAL_HOSTS.has(host.toLowerCase())) throw new TypeError('llama-server host must be loopback');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('port must be a valid TCP port');
  if (![threads, batchThreads, maxConcurrent, startupTimeoutMs, pollIntervalMs].every((n) => Number.isInteger(n) && n > 0)) {
    throw new TypeError('threads, batchThreads, maxConcurrent, startupTimeoutMs and pollIntervalMs must be positive integers');
  }
  // ★ 2026-10-17（回落/显式端口）：`--gpu-layers` 必须以**实际运行环境**为准，不能只看 profile
  //   —— `gpuLayers` 缺省时从 profile 推（CPU 档 0 层、CUDA 档 99 层），显式给了就用给的。
  const layers = gpuLayers ?? (frozen.runtime === 'llama-cuda' ? 99 : 0);
  if (!Number.isInteger(layers) || layers < 0) throw new TypeError('gpuLayers must be a non-negative integer');
  // ★ 2026-10-17（懒绑定，修一个"端点钉死在构造期端口"的坑）：
  //   原实现构造时就把 endpoint 定死成构造参数 `port`。装配层为了让端口撞车能**回落到下一个空闲口**，
  //   会在 start() 前改写 `runtimePort` —— 那时 adapter 若已绑 18081，回落后的服务就算起来了，
  //   所有嵌入请求也全都打在旧口上（表现为"启动成功但一条都召不回"，且日志里看不出原因）。
  //   ⇒ adapter 改成**第一次 start() 时**用当时的运行时端口再建；stop() 后重建语义不变。
  let embedder = null;
  let runtimePort = port;
  let process = null;
  let logFd = null;
  let command = null;
  let started = false;
  let stopped = false;

  function ensureEmbedder() {
    if (!embedder) {
      embedder = createLlamaEmbeddingAdapter({
        profile: frozen, modelPath, endpoint: `http://${host}:${runtimePort}`, fetchImpl, timeoutMs, maxConcurrent
      });
    }
    return embedder;
  }

  function serverArgs() {
    return [
      '--model', modelPath,
      '--embedding',
      '--pooling', frozen.pooling,
      '--embd-normalize', String(frozen.embdNormalize),
      '--ctx-size', String(frozen.maxPositions),
      '--host', host,
      '--port', String(runtimePort),
      '--parallel', String(maxConcurrent),
      '--alias', frozen.modelId,
      '--threads', String(threads),
      '--threads-batch', String(batchThreads),
      '--gpu-layers', String(layers),
    ];
  }

  async function stop() {
    if (stopped) return { ok: true, status: 'stopped', pid: process?.pid ?? null, command: 'no owned llama-server process to stop' };
    stopped = true;
    const owned = process;
    if (!owned || owned.exitCode !== null || owned.signalCode !== null) {
      if (logFd !== null) { try { closeSync(logFd); } catch {} logFd = null; }
      try { await fs.appendFile(logPath, `[vector-runtime] stop requested; no live owned process on port ${runtimePort}\n`); } catch {}
      return { ok: true, status: 'stopped', pid: owned?.pid ?? null, command: 'no live owned llama-server process to stop' };
    }
    let timer;
    const exited = new Promise((resolveExit) => {
      owned.once('exit', (code, signal) => resolveExit({ code, signal }));
      owned.once('error', (error) => resolveExit({ error }));
    });
    try { owned.kill('SIGTERM'); } catch {}
    const forced = new Promise((resolveForce) => {
      timer = setTimeout(() => {
        try { owned.kill('SIGKILL'); } catch {}
        resolveForce({ forced: true });
      }, 5000);
    });
    const result = await Promise.race([exited, forced]);
    clearTimeout(timer);
    if (logFd !== null) { try { closeSync(logFd); } catch {} logFd = null; }
    try { await fs.appendFile(logPath, `[vector-runtime] stopped pid=${owned.pid} command=${result.forced === true ? 'SIGTERM then SIGKILL' : 'SIGTERM'}\n`); } catch {}
    return { ok: !result.error, status: 'stopped', pid: owned.pid, signal: result.signal ?? null, forced: result.forced === true, command: result.forced === true ? 'child.kill(SIGTERM), then child.kill(SIGKILL)' : 'child.kill(SIGTERM)', error: result.error?.message };
  }

  async function start() {
    if (started && !stopped) {
      return { ok: true, status: 'ready', pid: process?.pid ?? null, command, endpoint: `http://${host}:${runtimePort}`, port: runtimePort, logPath };
    }
    if (stopped) return fail('cancelled', 'runtime cannot be restarted after stop; construct a new runtime');
    if (embedder && runtimePort !== port) {
      // 端口被外部改写（装配层的空闲口回落）⇒ 旧 adapter 绑的是旧口，必须重建。
      try { await embedder.close(); } catch { /* 关不掉也不影响新 adapter */ }
      embedder = null;
    }
    const active = ensureEmbedder();
    const modelCheck = await active.verifyModel();
    if (!modelCheck.ok) return modelCheck;
    if (!expectedBuild) return fail('version-incompatible', `profile build is not parseable: ${frozen.build}`);
    try { await fs.mkdir(dirname(resolve(logPath)), { recursive: true }); }
    catch (error) { return fail('error', `cannot create llama-server log directory: ${String(error?.message || error)}`); }
    const versionPath = `${logPath}.version-${globalThis.process.pid}.log`;
    const version = await runVersionCommand(executablePath, versionPath, timeoutMs);
    if (!version.ok) return version;
    const actualMatch = version.output.match(/version:\s*(\S+)\s+\(build\s+(\d+)/i);
    if (!actualMatch || actualMatch[1] !== expectedBuild.version || actualMatch[2] !== expectedBuild.number) {
      return fail('version-incompatible', `runtime build does not match profile ${frozen.build}: ${version.output.trim()}`);
    }
    const available = await portAvailable(host, runtimePort);
    if (!available.ok) return fail('error', `embedding port ${runtimePort} is already in use: ${available.reason}`);
    try {
      const args = serverArgs();
      command = [executablePath, ...args];
      await fs.appendFile(logPath, `[vector-runtime] explicit start port=${runtimePort} command=${JSON.stringify(command)}\n`);
      logFd = openSync(logPath, 'a');
      process = spawn(executablePath, args, { stdio: ['ignore', logFd, logFd], windowsHide: true });
      closeSync(logFd);
      logFd = null;
    } catch (error) {
      if (logFd !== null) { try { closeSync(logFd); } catch {} logFd = null; }
      return fail('error', `cannot start llama-server: ${String(error?.message || error)}`);
    }
    started = true;
    const startedProcess = process;
    const until = Date.now() + startupTimeoutMs;
    while (Date.now() < until) {
      if (startedProcess.exitCode !== null || startedProcess.signalCode !== null) {
        const tail = await readLogTail(logPath);
        await stop();
        return fail('error', `llama-server exited before ready; log tail: ${tail.join(' | ')}`);
      }
      // Startup polling is explicit; ordinary reads honor the failure cooldown.
      const probe = await active.inspectServer({ bypassCooldown: true });
      if (probe.ok) return { ok: true, status: 'ready', pid: startedProcess.pid, endpoint: `http://${host}:${runtimePort}`, port: runtimePort, command, logPath, profileFingerprint: probe.profileFingerprint };
      if (probe.status === 'version-incompatible' || probe.status === 'error') {
        const tail = await readLogTail(logPath);
        await stop();
        return { ...probe, reason: `${probe.reason}; log tail: ${tail.join(' | ')}` };
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, pollIntervalMs));
    }
    const tail = await readLogTail(logPath);
    await stop();
    return fail('timeout', `llama-server did not become ready within ${startupTimeoutMs}ms; log tail: ${tail.join(' | ')}`);
  }

  async function readLogTail(filePath, count = 8) {
    try { return readTail(await fs.readFile(filePath, 'utf8'), count); } catch { return []; }
  }

  async function close() {
    const stoppedResult = await stop();
    const adapterResult = await ensureEmbedder().close();
    return { ...stoppedResult, adapterClosed: adapterResult.ok };
  }

  return Object.freeze({
    profile: frozen,
    // ★ 懒绑定的活 adapter（第一次 start() 或显式取用时建）；装配层只能拿这个引用去 embed。
    get embedder() { return ensureEmbedder(); },
    /** 真正的监听端点（回落过的端口以它为准，构造参数 `port` 只是候选起点）。 */
    get endpoint() { return `http://${host}:${runtimePort}`; },
    get port() { return runtimePort; },
    /**
     * 只在 **start() 之前**允许改写监听端口：装配层用它做"配置端口被占 ⇒ 依次找下一个空闲口"。
     * 已启动后改写会被拒绝（返回 false）—— 换口必须整台重起，不许偷偷改一个已在跑的实例。
     */
    setPort(nextPort) {
      if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) return false;
      if (started && !stopped) return false;
      runtimePort = nextPort;
      return true;
    },
    logPath,
    command: () => command ? [...command] : null,
    start,
    stop,
    close,
    status: () => ({ ...ensureEmbedder().status(), pid: process?.pid ?? null, started, stopped, endpoint: `http://${host}:${runtimePort}`, port: runtimePort, logPath }),
    logTail: () => readLogTail(logPath),
  });
}
