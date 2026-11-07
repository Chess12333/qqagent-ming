// 多提供商模型目录：从 DSH 的 settings.yaml 导入模型列表，统一成 OpenAI 兼容调用。
// 说明：DSH 里 api: anthropic-messages 的提供商，本程序按 OpenAI 兼容模式调用
// （A6API 这类中转站两种协议都支持；baseURL 缺 /v1 时自动补上）。
// 密钥来源优先级：DSH .credentials.yaml 的 refs > 环境变量（含别名）。
import fs from 'node:fs';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { get as getConfig, set as updateConfig } from '../../core/config-store/index.js';

// DSH 未写 baseURL 的提供商，按官方默认端点补全（可在 UI 修改）。
// 来源：
// - mimo.mi.com/docs Token Plan 快速接入（tp- 密钥专用网关，与 sk- 开放平台相互独立不可混用）
// - help.aliyun.com/zh/model-studio/token-plan-personal-quick-start（sk-sp- 密钥专用网关，与按量付费 sk- 不可混用）
// - opencode.ai/docs/go（OpenCode Go 订阅网关）
const PROVIDER_URL_DEFAULTS = {
  openrouter: 'https://openrouter.ai/api/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  'qwen-token-plan-cn': 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  xiaomi: 'https://api.xiaomimimo.com/v1',
  'xiaomi-token-plan-cn': 'https://token-plan-cn.xiaomimimo.com/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1'
};

// 密钥环境变量的常见别名（如 DSH 写 A6API_API_KEY，本机实际是 A6API_APIKEY）
const KEY_ENV_ALIASES = {
  A6API_API_KEY: ['A6API_API_KEY', 'A6API_APIKEY']
};

function envApiKey(envName) {
  for (const name of KEY_ENV_ALIASES[envName] || [envName]) {
    const value = process.env[name];
    if (value) return { key: String(value), from: `环境变量 ${name}` };
  }
  return { key: '', from: '' };
}

/**
 * ★ 2026-10-17（用户裁定 · 每厂商专属缓存策略）：`providers[].cacheStrategy` 的**唯一枚举与归一化**。
 *   · auto       按端点画像自动判（缺省；行为与从前逐字相同）
 *   · deepseek   自动公共前缀缓存：不发 cache_control、不做付费保温
 *   · dashscope  显式缓存：唯一 system 消息级标记 + 短 TTL 保温（仍受 cacheMode / 保温开关双约束）
 *   · zhipu      自动缓存：只用已确认的 usage 读取，不编造标记/TTL
 *   · mimo       自动缓存：同上（仅确认 cached_tokens 字段）
 *   · compatible 只稳通用前缀：不发专属 cache 参数、不保温；**不代表**关闭厂商自动缓存
 * 空白/缺失 ⇒ auto；非法值 ⇒ 安全回 auto 并给原因（不抛、不静默）。
 * 该字段只影响缓存行为，不影响厂商身份/模型/密钥/思考/视觉参数方言。
 */
export const CACHE_STRATEGY_IDS = Object.freeze(['auto', 'deepseek', 'dashscope', 'zhipu', 'mimo', 'compatible']);

/** 归一化一个 cacheStrategy 取值 → { strategy, selected, source, reason }（source: auto|manual|fallback）。 */
export function normalizeCacheStrategy(value) {
  const selected = String(value ?? '').trim().toLowerCase();
  if (!selected) return { strategy: 'auto', selected: '', source: 'auto', reason: '' };
  if (CACHE_STRATEGY_IDS.includes(selected)) {
    return { strategy: selected, selected, source: selected === 'auto' ? 'auto' : 'manual', reason: '' };
  }
  return { strategy: 'auto', selected, source: 'fallback', reason: `未知 cacheStrategy '${selected}' ⇒ 安全回 auto` };
}

/**
 * 按**本次请求真正用的 provider id** 解析缓存策略（providers[] 条目上的可选字段）。
 * 找不到该 id / 没有条目 ⇒ auto + 原因（不读全局开关、不按 hostname 猜测、不把中转洗回 auto 丢掉手选）。
 */
export function cacheStrategyForProvider(providerId, cfg = getConfig()) {
  const id = String(providerId ?? '').trim();
  if (!id) return { strategy: 'auto', selected: '', source: 'fallback', reason: 'api.provider 为空 ⇒ 回 auto' };
  const entry = (cfg?.providers || []).find((p) => p && String(p.id) === id);
  if (!entry) return { strategy: 'auto', selected: '', source: 'fallback', reason: `providers 里找不到 '${id}' ⇒ 回 auto` };
  return normalizeCacheStrategy(entry.cacheStrategy);
}

/**
 * ★ 2026-10-17：按**整个本次请求的 api** 解析策略（覆盖 `apiWith`/overrides 换 provider 或换端点的情形）：
 *   ① 有 provider id 且条目端点与本次 baseUrl 一致 ⇒ 用该条目；
 *   ② 条目在但端点被 overrides 换掉 ⇒ 按 baseUrl 再匹配一次（避免张冠李戴、也不连坐别家）；
 *   ③ 都没有 ⇒ auto + 原因。返回值同 `normalizeCacheStrategy`。
 */
export function cacheStrategyForApi(api = {}, cfg = getConfig()) {
  const providers = Array.isArray(cfg?.providers) ? cfg.providers : [];
  const wantBase = normalizeBaseUrl(api?.baseUrl);
  const id = String(api?.provider ?? '').trim();
  if (id) {
    const entry = providers.find((p) => p && String(p.id) === id);
    if (entry) {
      const entryBase = normalizeBaseUrl(entry.baseURL);
      if (!wantBase || !entryBase || entryBase === wantBase) return normalizeCacheStrategy(entry.cacheStrategy);
      const byBase = providers.find((p) => normalizeBaseUrl(p?.baseURL) === wantBase);
      if (byBase) return normalizeCacheStrategy(byBase.cacheStrategy);
      return { strategy: 'auto', selected: '', source: 'fallback',
        reason: `provider '${id}' 的端点与本次请求不一致 ⇒ 回 auto` };
    }
    return { strategy: 'auto', selected: '', source: 'fallback', reason: `providers 里找不到 '${id}' ⇒ 回 auto` };
  }
  const byBase = wantBase ? providers.find((p) => normalizeBaseUrl(p?.baseURL) === wantBase) : null;
  if (byBase) return normalizeCacheStrategy(byBase.cacheStrategy);
  return { strategy: 'auto', selected: '', source: 'fallback', reason: '没有 provider id、也匹配不到端点 ⇒ 回 auto' };
}

/** 读取 DSH 的 .credentials.yaml（refs.<环境变量名> = 密钥）。 */
export function readDshCredentials(yamlPath) {
  const credPath = path.join(path.dirname(yamlPath), '.credentials.yaml');
  try {
    const doc = loadYaml(fs.readFileSync(credPath, 'utf8'));
    const refs = doc?.refs;
    return refs && typeof refs === 'object' ? refs : {};
  } catch {
    return {};
  }
}

function normalizeBaseURL(raw, { wasAnthropic, providerId }) {
  let url = String(raw || '').trim();
  if (!url) url = PROVIDER_URL_DEFAULTS[providerId] || '';
  if (!url) return '';
  if (wasAnthropic && !/\/v1\/?$/.test(url)) url = url.replace(/\/+$/, '') + '/v1';
  return url.replace(/\/+$/, '');
}

/** 解析 DSH settings.yaml，返回规范化的提供商数组。 */
export function parseDshSettings(yamlPath) {
  const text = fs.readFileSync(yamlPath, 'utf8');
  const doc = loadYaml(text);
  const providers = doc?.['llm-pi-ai']?.providers ?? {};
  const creds = readDshCredentials(yamlPath);
  const out = [];
  for (const [id, p] of Object.entries(providers)) {
    const rawModels = Array.isArray(p?.models) ? p.models : [];
    const models = rawModels
      .map((m) => (typeof m === 'string' ? m : String(m?.id || m?.model || '')))
      .filter(Boolean);
    if (!models.length) continue;
    const wasAnthropic = String(p?.api || '').includes('anthropic');
    const envName = String(p?.apiKeyEnv || '');
    // 密钥优先级：DSH 凭据文件 > 环境变量
    let key = '';
    let keyFrom = '';
    if (creds[envName]) {
      key = String(creds[envName]);
      keyFrom = 'DSH 凭据文件';
    } else {
      ({ key, from: keyFrom } = envApiKey(envName));
    }
    const entry = {
      id,
      displayName: String(p?.displayName || id),
      api: 'openai',
      anthropicOrigin: wasAnthropic,
      baseURL: normalizeBaseURL(p?.baseURL, { wasAnthropic, providerId: id }),
      apiKey: key,
      apiKeyFrom: keyFrom,
      models,
      needsBaseUrl: false
    };
    if (!entry.baseURL) entry.needsBaseUrl = true;
    out.push(entry);  }
  return out;
}

/** 从 DSH 导入并写入配置（整体替换 providers，并把密钥拆到 dshProviderKeys）。返回导入摘要。 */
export function importFromDsh(yamlPath) {
  const providers = parseDshSettings(yamlPath);
  const dshProviderKeys = {};
  // ★ 2026-10-17（缓存策略字段保真）：DSH 导入**不携带** cacheStrategy（那是本仓的每厂商选项）——
  //   按 provider id 把用户已保存的策略带回来，否则每次导入都会把策略洗成缺省 auto。
  const previousStrategy = new Map((getConfig().providers || [])
    .map((p) => [String(p?.id ?? ''), String(p?.cacheStrategy ?? '').trim()])
    .filter(([, value]) => value));
  const providersWithoutKeys = providers.map((p) => {
    if (p.apiKey) dshProviderKeys[p.id] = p.apiKey;
    const { apiKey, ...rest } = p;
    const kept = previousStrategy.get(String(p.id));
    return kept ? { ...rest, cacheStrategy: kept } : rest;
  });
  updateConfig({ providers: providersWithoutKeys, dshProviderKeys });
  return {
    imported: providersWithoutKeys.length,
    models: providersWithoutKeys.reduce((n, p) => n + p.models.length, 0),
    withKeys: Object.keys(dshProviderKeys).length,
    providers: providersWithoutKeys.map((p) => ({ id: p.id, models: p.models.length, hasKey: !!dshProviderKeys[p.id], baseURL: p.baseURL }))
  };
}

/** 当前生效的提供商目录（配置里的 providers）。 */
export function currentProviders() {
  const cfg = getConfig();
  return (cfg.providers || []).map((p) => withResolvedKey(p, cfg));
}

/** 给指定提供商设置 API Key（存进配置的 dshProviderKeys，不动 providers 数组）。 */
export function setProviderKey(providerId, apiKey) {
  const key = String(apiKey ?? '').trim();
  const keys = { ...(getConfig().dshProviderKeys || {}) };
  if (key) keys[providerId] = key;
  else delete keys[providerId];
  updateConfig({ dshProviderKeys: keys });
  return currentProviders().find((p) => p.id === providerId) || null;
}

// ── 手动管理提供商/模型（设置页“模型 API”） ──────────────────────────────

function normalizeBaseUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

function hostDisplayName(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return u.hostname || '自定义提供商';
  } catch {
    return '自定义提供商';
  }
}

function normalizeModelInput(models) {
  const out = [];
  for (const m of Array.isArray(models) ? models : []) {
    if (!m) continue;
    if (typeof m === 'string') {
      const id = m.trim();
      if (id) out.push({ id, name: id });
    } else if (typeof m === 'object') {
      const id = String(m.id ?? m.model ?? '').trim();
      if (id) out.push({ id, name: String(m.name ?? m.id ?? id).trim() || id });
    }
  }
  return out;
}

/** 从当前配置里取 provider.apiKey 对应的真实值（含旧版 top-level key 回退）。 */
function providerKeyValue(provider, cfg) {
  if (provider && typeof provider === 'object') {
    const top = String(provider.apiKey ?? '').trim();
    if (top && top !== '******') return top;
    const dshKey = String(cfg?.dshProviderKeys?.[provider.id] ?? '').trim();
    if (dshKey && dshKey !== '******') return dshKey;
  }
  return '';
}

/** 提供商对象里 apiKey 可能是掩码/引用，请求前必须解出真实 key。 */
function withResolvedKey(p, cfg = getConfig()) {
  const real = providerKeyValue(p, cfg);
  return { ...p, apiKey: real };
}

/** 用指定 baseUrl/key 获取模型列表（OpenAI /models）。 */
export async function fetchModelsFrom(baseUrl, apiKey, timeoutMs = 15000) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('请先填写 Base URL');
  const res = await fetch(`${base}/models`, {
    headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`获取模型列表失败：HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return list.map((m) => String(m.id ?? m.model ?? m)).filter(Boolean);
}

/**
 * 单次连通性探测（流式）。
 *
 * 为什么改成流式：非流式必须等模型把整段话（推理模型的思考过程也在里面）生成完
 * 才返回，于是"测试连通性"测到的是**模型思考速度**，而不是"地址通不通"。
 * 实测同一个 qwen3.8-flash 的 ping：非流式 2.4~11s（首包其实 0.66s 就到了），
 * 而 DNS 21ms / TCP 40ms / GET /models 236ms —— 网络完全没问题。
 *
 * 现在分别报告：
 *   ttfbMs       首包（响应头/流开始）耗时 —— 真正的"连通性"指标
 *   firstTextMs  模型第一个可见文字的时间（推理模型会晚很多）
 *   latencyMs    读到流结束的总耗时（若端点不支持流式，则等于整包耗时）
 */
async function runChatProbe({ base, apiKey, model, extra = {}, thinkingDisabled = false }) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('超时')), 20000);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model: String(model).trim(),
        messages: [{ role: 'user', content: '请只回复两个字符：pong' }],
        max_tokens: 32,
        stream: true,
        ...extra
      }),
      signal: controller.signal
    });
    const ttfbMs = Date.now() - startedAt;
    const contentType = String(res.headers.get('content-type') || '');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const errText = String(body?.error?.message ?? body?.message ?? '').slice(0, 200);
      return { ok: false, httpStatus: res.status, latencyMs: Date.now() - startedAt, ttfbMs, thinkingDisabled, note: `HTTP ${res.status}${errText ? `：${errText}` : ''}` };
    }

    let text = '';
    let firstTextMs = null;
    let sawStream = false;

    if (contentType.includes('event-stream')) {
      // 标准 SSE：逐行取 data:，累计首个非空 content
      sawStream = true;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let json = null;
            try { json = JSON.parse(payload); } catch { continue; }
            const piece = String(json?.choices?.[0]?.delta?.content ?? '');
            if (piece) {
              text += piece;
              if (firstTextMs === null) firstTextMs = Date.now() - startedAt;
            }
          }
        }
      } finally {
        try { await reader.cancel(); } catch { /* 已经读完 */ }
      }
    } else {
      // 端点忽略了 stream:true，按整包 JSON 处理（兼容不支持流式的中转）
      const body = await res.json().catch(() => ({}));
      text = String(body?.choices?.[0]?.message?.content ?? '');
      if (text) firstTextMs = Date.now() - startedAt;
    }

    const latencyMs = Date.now() - startedAt;
    const reply = text.trim().slice(0, 60);
    return {
      ok: true,
      httpStatus: res.status,
      latencyMs,
      ttfbMs,
      firstTextMs,
      streamed: sawStream,
      thinkingDisabled,
      note: reply
        ? `模型回复：「${reply}」`
        : (sawStream ? '请求成功（流式返回，无文本内容）' : '请求成功（无文本返回）')
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const msg = String(error?.cause?.message ?? error?.message ?? error);
    return { ok: false, latencyMs, thinkingDisabled, note: msg === '超时' ? '连接超时' : `网络错误：${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 用用户提供的 baseUrl + apiKey + modelId 发送一次最小 chat 测试请求。
 *
 * 两个针对"测试"的优化（只影响这个测试，不影响正常聊天）：
 *   1. 流式：能分别看到"首字延迟"和"总耗时"；
 *   2. 常见关思考参数（enable_thinking / thinking.type=disabled 等）——
 *      推理模型为一个 ping 也会思考上百 token。端点不认时（400）自动去掉重试。
 */
export async function testModelChat({ baseUrl, apiKey, model }) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('请先填写 Base URL');
  if (!String(model || '').trim()) throw new Error('请先填写模型 ID');

  const { thinkingStyleFor } = await import('./llm.js');
  const style = thinkingStyleFor(base);
  const extra = style === 'ark' || style === 'zhipu' || style === 'moonshot' || style === 'deepseek'
    ? { thinking: { type: 'disabled' } }
    : style === 'siliconflow'
      ? { chat_template_kwargs: { enable_thinking: false } }
      : style === 'dashscope' || style === 'generic'
        ? { enable_thinking: false }
        : null;
  if (!extra) {
    return runChatProbe({ base, apiKey, model });
  }
  const first = await runChatProbe({ base, apiKey, model, extra, thinkingDisabled: true });
  if (first.ok || first.httpStatus !== 400) return first;
  // 端点不认这些参数（老网关/非标准实现）→ 去掉后再来一次
  const fallback = await runChatProbe({ base, apiKey, model });
  if (fallback.ok) {
    return { ...fallback, note: `${fallback.note}（该端点不支持关闭思考，已回退）` };
  }
  return fallback;
}

/** 测试一个提供商端点（按 providerId 查目录，或直接给 baseUrl/apiKey）。 */
export async function testOneProvider({ providerId = '', baseUrl = '', apiKey = '' } = {}) {
  let p = currentProviders().find((x) => x.id === providerId);
  if (!p) {
    const base = normalizeBaseUrl(baseUrl);
    if (!base) return { ok: false, verdict: 'no-endpoint', note: '没有端点地址', latencyMs: 0 };
    p = { id: providerId || '__tmp__', displayName: hostDisplayName(base), baseURL: base, apiKey: apiKey || '', models: [] };
  } else if (apiKey && apiKey !== '******') {
    p = { ...p, apiKey };
  }
  return testProvider(p);
}

/** 新建提供商；若同 baseURL 已存在则合并模型。返回 { provider, created }。 */
export function upsertProvider({ baseUrl, apiKey, models = [] }) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('Base URL 不能为空');
  const providers = currentProviders().map((p) => { const { apiKey: _ak, ...rest } = p; return { ...rest, models: [...(p.models || [])] }; });
  const existing = providers.find((p) => normalizeBaseUrl(p.baseURL) === base);
  const entries = normalizeModelInput(models);
  if (existing) {
    // modelNames 必须在 updateConfig 之前写进 providers —— 否则只改到内存，
    // 落盘的仍是旧对象（此前显示名合并不进配置就是这个原因）。
    existing.modelNames = { ...(existing.modelNames || {}) };
    for (const m of entries) {
      if (!existing.models.includes(m.id)) existing.models.push(m.id);
      existing.modelNames[m.id] = m.name;
    }
    if (apiKey) {
      const keys = { ...(getConfig().dshProviderKeys || {}) };
      keys[existing.id] = String(apiKey).trim();
      updateConfig({ providers, dshProviderKeys: keys });
    } else {
      updateConfig({ providers });
    }
    return { provider: withResolvedKey(existing), created: false };
  }
  const id = `custom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const modelNames = {};
  for (const m of entries) modelNames[m.id] = m.name;
  const provider = {
    id,
    displayName: hostDisplayName(base),
    api: 'openai',
    anthropicOrigin: false,
    baseURL: base,
    apiKey: '',
    apiKeyFrom: apiKey ? 'manual' : '',
    models: entries.map((m) => m.id),
    modelNames,
    needsBaseUrl: false
  };
  providers.push(provider);
  const keys = { ...(getConfig().dshProviderKeys || {}) };
  if (apiKey) keys[id] = String(apiKey).trim();
  updateConfig({ providers, ...(apiKey ? { dshProviderKeys: keys } : {}) });
  return { provider: withResolvedKey(provider), created: true };
}

/** 给指定提供商追加模型（合并 modelNames）。 */
export function addModelsToProvider(providerId, models = []) {
  const entries = normalizeModelInput(models);
  const providers = currentProviders().map((p) => ({ ...p, models: [...(p.models || [])] }));
  const p = providers.find((x) => x.id === providerId);
  if (!p) return null;
  p.modelNames = { ...(p.modelNames || {}) };
  for (const m of entries) {
    if (!p.models.includes(m.id)) p.models.push(m.id);
    p.modelNames[m.id] = m.name;
  }
  updateConfig({ providers: providers.map((x) => { const { apiKey, ...rest } = x; return rest; }) });
  return p;
}

/** 从提供商移除一个模型。 */
export function removeModelFromProvider(providerId, modelId) {
  const providers = currentProviders().map((p) => ({ ...p, models: [...(p.models || [])] }));
  const p = providers.find((x) => x.id === providerId);
  if (!p) return null;
  const targetId = String(modelId ?? '');
  const modelIdOf = (model) => String(model?.id ?? model ?? '');
  if (!targetId || !p.models.some((model) => modelIdOf(model) === targetId)) return null;
  p.models = p.models.filter((model) => modelIdOf(model) !== targetId);
  if (p.modelNames) {
    p.modelNames = { ...p.modelNames };
    delete p.modelNames[targetId];
  }
  updateConfig({ providers: providers.map((x) => { const { apiKey, ...rest } = x; return rest; }) });
  return p;
}

// ── 连通性测试：GET {baseURL}/models（OpenAI 兼容探测） ────────────────────

/**
 * 测试一个提供商的端点连通性与密钥有效性。
 * 返回 { ok, httpStatus, modelCount, latencyMs, verdict, note }。
 * verdict: ok（可用）/ bad-key（密钥被拒）/ no-models-route（端点可达但无 /models 路由）/ no-endpoint / error
 */
export async function testProvider(p, timeoutMs = 12000) {
  if (!p.baseURL) return { ok: false, verdict: 'no-endpoint', note: '没有端点地址', latencyMs: 0 };
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('超时')), timeoutMs);
  try {
    const res = await fetch(`${p.baseURL}/models`, {
      headers: {
        ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {})
      },
      signal: controller.signal
    });
    const latencyMs = Date.now() - startedAt;
    if (res.ok) {
      let count = 0;
      try {
        const data = await res.json();
        const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
        count = list.length;
      } catch { /* body 不是 JSON */ }
      return { ok: true, httpStatus: res.status, modelCount: count, latencyMs, verdict: 'ok', note: count ? `列到 ${count} 个模型` : '端点可用（未返回模型列表）' };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, httpStatus: res.status, latencyMs, verdict: 'bad-key', note: `HTTP ${res.status}：密钥无效或无权限` };
    }
    if (res.status === 404) {
      return { ok: false, httpStatus: 404, latencyMs, verdict: 'no-models-route', note: '端点可达但没有 /models 路由（chat/completions 未必不可用）' };
    }
    return { ok: false, httpStatus: res.status, latencyMs, verdict: 'error', note: `HTTP ${res.status}` };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const msg = String(error?.cause?.message ?? error?.message ?? error);
    return { ok: false, latencyMs, verdict: 'error', note: msg === '超时' ? '连接超时' : `网络错误：${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/** 并发测试全部提供商（限 4 并发）。 */
export async function testAllProviders(providers, limit = 4) {
  const results = {};
  const queue = [...providers];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const p = queue.shift();
      results[p.id] = { ...(await testProvider(p)), displayName: p.displayName };
    }
  });
  await Promise.all(workers);
  return results;
}
