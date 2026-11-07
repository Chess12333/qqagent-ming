/**
 * apps/server 装配层 · StartLux-Decision 本地 JEV 适配器。
 *
 * 默认路径按 Jev 协议读取选项字母 A..Z 的原始 logprob，再按官方分类温度
 * 缩放并归一化；不读取模型生成的文本来猜标签或概率。旧 chat-completions
 * 标签解析保留为显式 `protocol: 'legacy-text'`，默认不会走。
 *
 * `createLocalModel()` 可自行启动 repo 内的 llama-server。通过 `start()` 预热，
 * 再调用 `model`；适配器只关闭自己启动的进程，空闲后自动清理，`close()` 可立即清理。
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { roleOf } from '../../modules/jev/roles.js';

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_BOOT_TIMEOUT_MS = 90000;
const IDLE_STOP_MS = 300000;   // ★ N11：原来是 700 —— 那正是 A32（f995436d）要治的「每次冷启必超时」
const PROTOCOL = 'startlux-letter-logprob';
const LEGACY_PROTOCOL = 'legacy-text';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DEFAULT_SERVER = 'runtime/llama-cuda/llama-server.exe';
const DEFAULT_MODEL = 'models/new true/StartLux-Decision-0.8B-Q4_K_M.gguf';
const LETTER_IDS = Array.from({ length: 26 }, (_, i) => 32 + i);
const TEMPERATURES = Object.freeze({ noul: 3.2903, choice: 1.7565, score: 1.8935 });
const SYSTEM = 'Apply the criterion to the evidence. Choose exactly one listed option. Answer with its letter only.';

const ROLE_TYPES = Object.freeze({
  interjectWorth: 'noul',
  recallAsk: 'noul',
  textOnlyJudge: 'noul',
  unsentLinesJudge: 'noul',
  topicShift: 'choice',
});
const ROLE_INSTRUCTIONS = Object.freeze({
  // Match the tested noul criterion and yes/no option framing from jev-lux.mjs.
  interjectWorth: '现在该不该主动插一句话？',
});

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function localPath(value, fallback) {
  const raw = String(value ?? '').trim();
  return path.resolve(ROOT, raw || fallback);
}

function modelPathFor(local) {
  const configured = String(local.modelPath || local.modelId || '').trim();
  // modelId has historically been a server-side model name. Only treat it as a
  // filesystem path when it looks like one; otherwise use the tested GGUF.
  const looksLikePath = /[\\/]/.test(configured) || /\.gguf$/i.test(configured);
  return localPath(looksLikePath ? configured : '', DEFAULT_MODEL);
}

/**
 * ★ A51（2026-10-08）：`gpuLayers` 归一化。
 *
 * 为什么要专门写这个：原来直接 `String(local.gpuLayers ?? 99)`。
 * `??` **只挡 null/undefined，挡不住空串** —— 面板里把「GPU 层数」清空存成 `""` 时，
 * 会真的拼出 `-ngl ""` 把 llama-server 弄挂（而不是回退到默认值）。
 *
 * `0` 是**合法值**（纯 CPU；老树 `src/local-jev.js:594` 就是 `<= 0` 时干脆不传 `-ngl`），
 * 所以**必须原样传下去**，不能被当成「没填」。
 */
export function normalizeGpuLayers(value) {
  if (value === null || value === undefined || value === '') return 99;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 99;
  return Math.floor(n);
}

/**
 * ★ A51：把 llama-server 的启动参数抽成**纯函数**。
 *
 * 为什么要抽出来：`modelPath` / `gpuLayers` 只有在 **spawn 那一刻**才真正传给进程，
 * 之前这两行埋在 `spawn()` 的调用里 ⇒ 没法在自测里断言「配置真的传下去了」
 * （只能去读源码文本，那是假证据）。抽出来后可直接断言 argv 内容，**不起真进程**。
 *
 * @param {{local?: object, modelPath: string, port: number|string}} opts
 * @returns {string[]}
 */
export function buildServerArgs({ local = {}, modelPath, port } = {}) {
  return [
    '-m', String(modelPath ?? ''),
    '-c', String(local.contextSize || 4096),
    '--port', String(port),
    '--parallel', '1',
    '-ngl', String(normalizeGpuLayers(local.gpuLayers)),
  ];
}

/** 本地通道是否配齐。JEV GGUF 是默认模型，允许只配置 enabled。 */
export function localJevAvailable(local = {}) {
  return !!local && local.enabled === true;
}

/** 给装配层日志看的无密钥摘要。 */
export function describeLocal(local = {}) {
  return {
    enabled: local?.enabled === true,
    port: Number(local?.port) || 18080,
    modelId: String(local?.modelId || path.basename(modelPathFor(local))),
    // ★ A51：把这两项也带进摘要，装配层启动日志才看得到「这次到底要加载哪个文件 / 传几层 GPU」
    modelPath: modelPathFor(local),
    gpuLayers: normalizeGpuLayers(local?.gpuLayers),
    protocol: local?.protocol === LEGACY_PROTOCOL ? LEGACY_PROTOCOL : PROTOCOL,
    timeoutMs: clamp(Number(local?.timeoutMs) || DEFAULT_TIMEOUT_MS, 500, 15000),
  };
}

function isTimeoutLike(error) {
  const msg = `${error?.message ?? ''} ${error?.name ?? ''} ${error?.code ?? ''} ${error?.cause?.code ?? ''}`;
  return /timeout|timed\s*out|abort|超时|deadline/i.test(msg);
}

function isConnectionLike(error) {
  const msg = `${error?.message ?? ''} ${error?.code ?? ''} ${error?.cause?.code ?? ''}`;
  return /ECONNREFUSED|fetch failed|network error|ENOTFOUND|ECONNRESET/i.test(msg);
}

function makeEndpoint(port) { return `http://127.0.0.1:${port}`; }

function normalizeOptions(role, labels) {
  const labelsInRoleOrder = role.labels.filter((label) => labels.includes(label));
  if (labelsInRoleOrder.length !== labels.length || labelsInRoleOrder.length < 2) {
    throw new Error(`jev-local-invalid-options: role ${role.id} label set does not match ROLES`);
  }
  const bodies = role.id === 'interjectWorth'
    ? ['yes', 'no']
    : role.id === 'topicShift'
      ? ['follow: continue the current topic', 'shift: the topic has changed']
      : labelsInRoleOrder.map(String);
  return labelsInRoleOrder.map((name, i) => ({ name, body: bodies[i] ?? String(name) }));
}

function renderPrompt({ state, instructions, options }) {
  const optLines = options.map((option, index) => `${String.fromCharCode(65 + index)}) ${option.body}`).join('\n');
  const user = `Evidence:\n${state}\n\nQuestion: ${instructions}\nOptions:\n${optLines}`;
  return `<|im_start|>system\n${SYSTEM}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
}

function softmaxWithTemperature(logprobs, temperature) {
  const scaled = logprobs.map((value) => value / temperature);
  const max = Math.max(...scaled);
  const exps = scaled.map((value) => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) throw new Error('jev-local-invalid-logprobs: cannot normalize option probabilities');
  return exps.map((value) => value / total);
}

function createTransport({ port, fetchImpl }) {
  const endpoint = makeEndpoint(port);
  async function getJson(url, ms, init) {
    let response;
    try {
      response = await fetchImpl(`${endpoint}${url}`, {
        ...init,
        signal: AbortSignal.timeout(ms),
        ...(init?.body ? { headers: { 'content-type': 'application/json', ...init.headers } } : {}),
      });
    } catch (error) {
      if (isTimeoutLike(error)) throw new Error(`jev-local-timeout after ${ms}ms: ${error?.message ?? error}`);
      if (isConnectionLike(error)) throw new Error(`jev-local-unavailable: ${error?.message ?? error}`);
      throw new Error(`jev-local-request-failed: ${error?.message ?? error}`);
    }
    if (!response.ok) {
      let body = '';
      try { body = await response.text(); } catch { /* no body */ }
      throw new Error(`jev-local-unavailable-HTTP ${response.status}: ${body.slice(0, 160)}`);
    }
    return response.json();
  }
  return { endpoint, getJson };
}

/**
 * ★ N11：空闲自动停机的**生效值**（抽成纯函数，好让自测直接断言，不用来回起进程）。
 *
 * ## 之前真正的病根
 * `assembly.js:645` 一直传 `idleStopMs: 300000`（A32 `f995436d` 就是为它改的，原话：
 * 「700→300000，原来每次冷启必超时 = 42 次 unavailable 的真因」），但这一行原来写的是
 * `clamp(..., 100, 10000)` ⇒ **300000 被夹成 10000**：配置/意图值传了等于没传，
 * 实际空闲 10 秒就停机 ⇒ 间隔超过 10 秒的下一次判定必然要吃一次**冷启**，
 * 冷启慢或抢不到就落 `unavailable` ⇒ **A32 想治的病一直在复发**。
 *
 * ## 为什么选「抬 clamp 上限」而不是「加 `localJev.idleStopMs` 配置键」
 * 加配置键必须改 `refactor/core/config-store/defaults.js`（键要有默认值与校验），
 * 而**本票的域禁令明确禁止碰 `core/config-store/**`**（Luna2 的域）⇒ 只能选这条。
 * 装配层的显式传值本来就是 A32 确立的口径，不依赖配置键也能生效。
 *
 * ## 上下界的理由（不是随手拍的，也不是把 clamp 删了）
 * · **下界 100ms**：比这更短的话进程还没来得及serve 任何请求就被停掉，纯浪费一次 spawn。
 * · **上界 600000（10 分钟）**：
 *   代价是**一个常驻 llama-server 进程占着显存**（0.8B GGUF ≈ 500–600MB 盘上尺寸，运行时更高）。
 *   收益只有「省掉冷启延迟」—— ★ 注意**省不到缓存**：供应商侧前缀缓存有自己的 TTL
 *   （`cache-keepalive.js` 的 `PREFIX_TTL_MS = 5 分钟`），停 llama-server **不影响**它。
 *   所以超过 ~5 分钟再常驻就只白占显存、不再产生额外收益；给到 10 分钟是给 A32 的 300000
 *   留 2 倍余量，同时保持「有界」——不会因为忘了停而永久占着显存。
 *   ⇒ 建议值 **600000**；要更省显存可以调回 300000（那时仍比今天的 10 秒好 30 倍）。
 */
export function effectiveIdleStopMs(local = {}) {
  return clamp(Number(local?.idleStopMs) || IDLE_STOP_MS, 100, 600000);
}

function createServerManager({ local, port, fetchImpl, log }) {
  const serverPath = localPath(local.serverPath, DEFAULT_SERVER);
  // ★ A51：`modelPath` 从「构造时算一次」改成「spawn 时现读」。
  // 为什么：装配层把 `localJev.modelPath` 做成活 getter（见 assembly.js），只有现读才看得到改过的值。
  // 物理边界说清楚：llama-server 的 `-m` **只在 spawn 时认** ⇒ 已经跑着的那个进程换不了模型；
  // 但它有空闲自动停机（`idleStopMs`），下一次 spawn 就会用新路径 —— 不用重启整个 agent。
  const resolveModelPath = () => modelPathFor(local);
  const autoStart = local.autoStart !== false;
  const bootTimeoutMs = clamp(Number(local.bootTimeoutMs) || DEFAULT_BOOT_TIMEOUT_MS, 1000, 240000);
  const idleStopMs = effectiveIdleStopMs(local);
  let child = null;
  let owned = false;
  let starting = null;
  let idleTimer = null;
  let spawnError = null;
  let exitCleanup = null;

  async function healthy() {
    try {
      const response = await fetchImpl(`${makeEndpoint(port)}/health`, { signal: AbortSignal.timeout(350) });
      return response.ok;
    } catch { return false; }
  }

  function clearIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function waitExit(proc, timeoutMs) {
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.off('exit', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      proc.once('exit', done);
    });
  }

  async function stop() {
    clearIdleTimer();
    const proc = child;
    if (!proc || !owned) return { stopped: false, owned: false };
    child = null;
    owned = false;
    if (proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill(); } catch { /* already exited */ }
      await waitExit(proc, 5000);
      if (proc.exitCode === null && proc.signalCode === null) {
        try { proc.kill('SIGKILL'); } catch { /* already exited */ }
        await waitExit(proc, 2000);
      }
    }
    if (exitCleanup) process.off('exit', exitCleanup);
    exitCleanup = null;
    return { stopped: true, owned: true, exitCode: proc.exitCode, signal: proc.signalCode };
  }

  async function start() {
    clearIdleTimer();
    if (await healthy()) return { ready: true, startedByUs: false, port };
    if (!autoStart) throw new Error(`jev-local-unavailable: no llama-server is listening on ${port}`);
    if (starting) return starting;
    starting = (async () => {
      if (await healthy()) return { ready: true, startedByUs: false, port };
      spawnError = null;
      // ★ A51：现读 modelPath + 用抽出来的纯函数拼参数，并把**真实 argv 打进日志**
      // （验收要看「实际传给 llama-server 的参数」那一行；以前这行参数谁也看不见）。
      const modelPath = resolveModelPath();
      const args = buildServerArgs({ local, modelPath, port });
      if (typeof log === 'function') {
        log(`[apps/server] M9 JEV (Local) 拉起 llama-server：${serverPath} ${args.join(' ')}`);
      }
      child = spawn(serverPath, args, { cwd: ROOT, windowsHide: true, stdio: 'ignore' });
      owned = true;
      const proc = child;
      exitCleanup = () => {
        if (owned && child === proc && proc.exitCode === null && proc.signalCode === null) {
          try { proc.kill(); } catch { /* process is already exiting */ }
        }
      };
      process.once('exit', exitCleanup);
      proc.once('error', (error) => { spawnError = error; });
      const deadline = Date.now() + bootTimeoutMs;
      while (Date.now() < deadline) {
        if (await healthy()) return { ready: true, startedByUs: true, port };
        if (spawnError) break;
        if (proc.exitCode !== null || proc.signalCode !== null) break;
        await delay(300);
      }
      const failure = spawnError
        ? `cannot spawn llama-server: ${spawnError.message}`
        : `llama-server did not become healthy within ${bootTimeoutMs}ms`;
      await stop();
      throw new Error(`jev-local-start-failed: ${failure}`);
    })();
    try { return await starting; }
    finally { starting = null; }
  }

  function scheduleIdleStop() {
    if (!owned || !child) return;
    clearIdleTimer();
    idleTimer = setTimeout(() => { void stop(); }, idleStopMs);
  }

  return {
    start,
    stop,
    scheduleIdleStop,
    get owned() { return owned; },
    get modelPath() { return resolveModelPath(); },
    get serverPath() { return serverPath; },
  };
}

function createTrueProbabilityModel({ local, getJson }) {
  return async function model(req = {}) {
    const role = roleOf(req.roleId);
    if (!role) throw new Error(`jev-local-invalid-role: ${String(req.roleId)}`);
    const labels = Array.isArray(req.labels) ? req.labels.map(String) : [];
    const options = normalizeOptions(role, labels);
    if (options.length > LETTER_IDS.length) throw new Error('jev-local-too-many-options: StartLux supports at most 26 letter tokens');
    const type = ROLE_TYPES[role.id] || 'choice';
    const temperature = TEMPERATURES[type];
    const instructions = ROLE_INSTRUCTIONS[role.id] || role.question;
    const prompt = renderPrompt({ state: String(req.input ?? ''), instructions, options });
    const timeoutMs = clamp(Number(req.timeoutMs) || Number(local.timeoutMs) || DEFAULT_TIMEOUT_MS, 500, 15000);

    const tokenized = await getJson('/tokenize', timeoutMs, {
      method: 'POST',
      body: JSON.stringify({ content: prompt, add_special: false, parse_special: true }),
    });
    if (!Array.isArray(tokenized?.tokens) || tokenized.tokens.some((id) => !Number.isInteger(id))) {
      throw new Error('jev-local-invalid-tokenization: /tokenize did not return integer token ids');
    }
    const result = await getJson('/completion', timeoutMs, {
      method: 'POST',
      body: JSON.stringify({ prompt: tokenized.tokens, n_predict: 1, temperature: -1, n_probs: 512, cache_prompt: false }),
    });
    const rows = result?.completion_probabilities ?? result?.probs;
    const top = rows?.[0]?.top_logprobs;
    if (!Array.isArray(top)) throw new Error('jev-local-missing-logprobs: no top_logprobs at the answer position');
    const byId = new Map(top.map((item) => [Number(item?.id), Number(item?.logprob)]));
    const letterTokenIds = LETTER_IDS.slice(0, options.length);
    const missing = letterTokenIds.filter((id) => !Number.isFinite(byId.get(id)));
    if (missing.length) throw new Error(`jev-local-missing-option-logprobs: token ids ${missing.join(',')} were not returned`);
    const probabilities = softmaxWithTemperature(letterTokenIds.map((id) => byId.get(id)), temperature);
    const probs = Object.fromEntries(options.map((option, index) => [option.name, probabilities[index]]));
    const best = probabilities.indexOf(Math.max(...probabilities));
    return {
      label: options[best].name,
      probs,
      pSource: PROTOCOL,
      temperatureType: type,
    };
  };
}

/** 旧实现保留作显式对照；没有被指定 protocol 时绝不走。 */
function createLegacyTextModel({ local, fetchImpl, port, modelName }) {
  const endpoint = `${makeEndpoint(port)}/v1/chat/completions`;
  async function post(body, ms) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ms),
      });
    } catch (error) {
      if (isTimeoutLike(error)) throw new Error(`jev-local-timeout after ${ms}ms: ${error?.message ?? error}`);
      if (isConnectionLike(error)) throw new Error(`jev-local-unavailable: ${error?.message ?? error}`);
      throw new Error(`jev-local-request-failed: ${error?.message ?? error}`);
    }
    if (!response.ok) {
      let text = '';
      try { text = await response.text(); } catch { /* no body */ }
      throw new Error(`jev-local-unavailable-HTTP ${response.status}: ${text.slice(0, 160)}`);
    }
    return response.json();
  }
  return async function legacyModel(req = {}) {
    const labels = Array.isArray(req.labels) ? req.labels.map(String).filter(Boolean) : [];
    if (!labels.length) throw new Error('jev-local-model: req.labels 为空，无法提问');
    const timeoutMs = clamp(Number(req.timeoutMs) || Number(local.timeoutMs) || DEFAULT_TIMEOUT_MS, 500, 15000);
    const messages = [
      { role: 'system', content: `只输出一个词，必须是：${labels.join(' / ')}。不许有别的内容。` },
      { role: 'user', content: String(req.prompt ?? req.input ?? '') },
    ];
    const baseBody = { model: modelName, messages, temperature: 0, stream: false };
    let data;
    try {
      data = await post({ ...baseBody, max_tokens: 16, logprobs: true, top_logprobs: 20 }, timeoutMs);
    } catch (error) {
      if (!/HTTP (400|404|422)/.test(String(error?.message ?? ''))) throw error;
      data = await post(baseBody, timeoutMs);
    }
    const choice = data?.choices?.[0] || {};
    const message = choice.message || {};
    const content = Array.isArray(message.content)
      ? message.content.map((part) => typeof part === 'string' ? part : String(part?.text ?? '')).join('')
      : String(message.content ?? '');
    const rawText = (content || String(message.reasoning_content ?? '')).trim();
    if (!rawText) throw new Error('jev-local-empty-response: endpoint returned no text');
    const items = choice.logprobs?.content;
    if (Array.isArray(items) && items.length) {
      const low = (value) => String(value ?? '').trim().toLowerCase();
      const firstTop = items[0]?.top_logprobs || [];
      const probs = {};
      for (const label of labels) {
        const hit = items.find((item) => low(item?.token) === low(label))
          || firstTop.find((item) => low(item?.token) === low(label));
        if (hit && Number.isFinite(Number(hit.logprob))) probs[label] = Math.exp(Number(hit.logprob));
      }
      if (Object.keys(probs).length) {
        const label = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
        return { label, probs };
      }
    }
    return rawText;
  };
}

/**
 * @param {{local?: object, fetchImpl?: Function, log?: Function}} opts
 * @returns {{model: Function, modelLabel: string, protocol: string, start: Function, close: Function}}
 */
export function createLocalModel({ local = {}, fetchImpl = fetch, log } = {}) {
  const desc = describeLocal(local);
  const port = desc.port;
  const legacy = local.protocol === LEGACY_PROTOCOL;
  // ★ A51：modelLabel 也改成**活读**。装配层是在 `await start()` **之后**才打这行日志的，
  // 用 getter 才能打出「这一次真正加载的是哪个文件」（活 getter 见 assembly.js）。
  const resolveModelName = () => (legacy
    ? String(local.modelId || path.basename(modelPathFor(local)))
    : path.basename(modelPathFor(local)));
  const transport = createTransport({ port, fetchImpl });
  const manager = createServerManager({ local, port, fetchImpl, log });
  const model = legacy
    ? createLegacyTextModel({ local, fetchImpl, port, modelName: resolveModelName() })
    : createTrueProbabilityModel({ local, getJson: transport.getJson });

  const managedModel = async (req = {}) => {
    await manager.start();
    try { return await model(req); }
    finally { manager.scheduleIdleStop(); }
  };
  return {
    model: managedModel,
    get modelLabel() { return `local:${resolveModelName()}`; },
    protocol: legacy ? LEGACY_PROTOCOL : PROTOCOL,
    start: manager.start,
    close: manager.stop,
    get serverOwned() { return manager.owned; },
  };
}

/** Explicit helper for callers that need the old generated-label behavior. */
export function createLegacyTextModelAdapter(opts = {}) {
  return createLocalModel({ ...opts, local: { ...(opts.local || {}), protocol: LEGACY_PROTOCOL } });
}

export const STARTLUX_PROTOCOL = PROTOCOL;
export const STARTLUX_TEMPERATURES = TEMPERATURES;
