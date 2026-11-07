// OpenAI 兼容 Chat Completions 客户端（非流式）。
// 支持工具调用、usage 统计、可自选模型 —— 这是与 DSH 解耦后的"大脑"接口。
import { get as getConfig } from '../../core/config-store/index.js';
import { resolveOfficialPrice, resolveModelPrice, priceAt } from './model-prices.js';
import { isHypeMode } from '../emotion/index.js';
// 缓存用量字段的**唯一**读取口径（保温链也用它）。llm.js ← cache-keepalive.js 是单向依赖，
// 不会成环：cache-keepalive 只 import config.js。
import { readUsageNumbers } from './cache-keepalive.js';
// ★ N49（指挥位 2026-10-09 裁定走 (b)）：最终发送体的**纯观测**回调缝。
//   受管副本只多这一行 import 与 send 里的一次调用；脱敏/缓存标记事实都在 EXTRA 文件里。
//   登记见 modules/llm/selftest.mjs 的 AUTHORIZED_DEVIATIONS。
import { emitFinalBody } from './final-body.js';
// ★ CACHE-PROFILE-1（2026-10-16 用户裁定）：缓存能力的**唯一判据表**在 ./cache-profile.js。
//   本文件只做兼容转发 —— 避免"同一件事两处正则"（旧实现里未知域名默认认 cache_control = 盲发）。
import { cacheProfileFor } from './cache-profile.js';
// ★ 2026-10-17（用户裁定 · 每厂商专属缓存策略）：策略**唯一解析/归一化出口**在 ./providers.js
//   （providers[].cacheStrategy；按本次请求真正用的 provider/端点解析，换了 provider/baseUrl 会重解析）。
import { cacheStrategyForApi, normalizeCacheStrategy } from './providers.js';
// ★ 2026-10-17（400 剥标记 → 诊断闭环）：按 endpoint/账号/模型/策略 隔离的进程内记忆（只读证据）。
import { noteCacheMarkerStripped } from './cache-marker-memory.js';
let inFlightRequestCount = 0;
/** Number of pending /chat/completions fetch attempts; excludes /models and retains no request data. */
export function getInFlightRequestCount() { return inFlightRequestCount; }
// 【接线 · 2026-10-11 mimo2】能力表的**唯一生产读点**：send() 把端点能力裁决交给 onFinalBody 观测缝。
//   ⚠ 与 ./capability-matrix.js 成 ESM 环（它 import 本文件 6 个判据函数；本文件只在 send() 运行期
//   调 capabilityFactsFor，两边全是 export function（hoisted）⇒ 模块求值期互不读值，环是安全的）。
//   它**不参与任何请求决策**：决策仍然只走本文件同名函数。登记见 selftest.mjs 的 AUTHORIZED_DEVIATIONS。
import { capabilityFactsFor } from './capability-matrix.js';
import { executeBudgetedRequest } from '../../core/budget/index.js';

/**
 * 2026-11-01（溟）：剔掉字符串里的孤立代理（半个 emoji）。
 * 任何按 UTF-16 码元做的截断都可能把代理对切开，剩下的半个字符发到模型 API 那边
 * utf-8 编码直接失败（502 surrogates not allowed）。递归处理整个 payload，只动字符串。
 */
function stripLoneSurrogates(value) {
  if (typeof value === 'string') {
    return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  }
  if (Array.isArray(value)) return value.map(stripLoneSurrogates);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = stripLoneSurrogates(value[key]);
    return out;
  }
  return value;
}

function joinUrl(base, path) {
  const b = String(base ?? '').trim();
  if (!b || !/^https?:\/\//i.test(b)) {
    throw new Error(`模型 baseUrl 无效（当前「${b || '空'}」）。请在设置里重新保存模型/供应商。`);
  }
  return `${b.replace(/\/+$/, '')}${path}`;
}

/**
 * 供应商错误体脱敏（2026-10-17 安全审查）。
 *
 * 背景：`HTTP 401 {"error":{"message":"Incorrect API key provided: sk-xxx"}}` 这类响应体
 * 会被原样塞进 Error.message → console（chatCompletionWithRetry）→ 诊断面板/UI。
 * 部分网关还会把整条 Authorization 头或 key 明文回显。日志与 UI 都会外流
 * （用户贴日志求助、截图），所以进 Error 之前先按"形状"打码。
 *
 * 只按命名与前缀匹配，不做通用长串正则 —— 宁可少盖一点，也不要把正常的错误说明改成乱码。
 */
function redactSecrets(text) {
  let out = String(text ?? '');
  try {
    out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
    out = out.replace(/\b(sk_live_|sk_test_|rk_live_|ghp_|gho_|github_pat_)[A-Za-z0-9_-]{8,}/g, '$1***');
    out = out.replace(/(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***');
    out = out.replace(
      /((?:api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|secret[-_]?key|client[-_]?secret|password|authorization)["']?\s*[:=]\s*["']?)([^"'\s,}&]{6,})/gi,
      '$1***'
    );
  } catch { /* 脱敏失败就原样返回，绝不能因为脱敏把错误处理本身搞挂 */ }
  return out;
}

function authHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/**
 * 解析当前 api 配置里真正该用的 API Key。
 *
 * 优先级：**当前选中的目录提供商的 Key > 顶层 api.apiKey**。
 *
 * 注意顺序很重要：api.apiKey 是手动模式遗留字段，一旦用户在 UI 里选了某个
 * 目录提供商，就该用它对应的 Key。否则会出现「选了 openrouter，却拿着 a6api 的
 * Key 去请求 openrouter.ai」的情况 —— 表现为全部会话 401 Missing Authentication。
 *
 * 兼容历史数据：providers[].apiKey 也可能存有明文（老配置），也认。
 */
export function resolveApiKey(cfg) {
  const pid = String(cfg?.api?.provider ?? '').trim();
  if (pid) {
    const fromDsh = String(cfg?.dshProviderKeys?.[pid] ?? '').trim();
    if (fromDsh && fromDsh !== '******') return fromDsh;
    const p = (cfg?.providers || []).find((x) => x.id === pid);
    const legacy = String(p?.apiKey ?? '').trim();
    if (legacy && legacy !== '******') return legacy;
  }
  const direct = String(cfg?.api?.apiKey ?? '').trim();
  return direct === '******' ? '' : direct;
}

/** 返回一个 key 已解析好的 api 配置（不影响配置本体）。 */
function effectiveApi() {
  const cfg = getConfig();
  return applyCacheStrategy({ ...cfg.api, apiKey: resolveApiKey(cfg) }, cfg);
}

/**
 * ★ 2026-10-17（用户裁定 · 每厂商专属缓存策略）：策略**按本次请求真正用的 provider/端点**解析
 * （顶层 `providers[].cacheStrategy`），随 api 对象一起流到主请求 / 工具轮 / 保温 / 身份快照 ——
 * 全链同源，不各自读配置、不按 hostname 猜测、不被未知域名洗回 auto。
 * 字段只影响缓存行为（画像/决策/保温），不动厂商身份、模型、密钥、思考/视觉参数方言。
 */
function applyCacheStrategy(api, cfg = getConfig()) {
  const meta = cacheStrategyForApi(api, cfg);
  api.cacheStrategy = meta.strategy;
  api.cacheStrategySelected = meta.selected || meta.strategy;
  api.cacheStrategySource = meta.source;
  api.cacheStrategyReason = meta.reason;
  return api;
}

/** 在"当前生效的 api 配置"上临时覆盖几个字段（例如被截断时加大输出预算）。 */
export function apiWith(overrides = {}) {
  const api = { ...effectiveApi(), ...overrides };
  // 显式给了策略 ⇒ 归一化后用（自测/特殊调用；非法值同样安全回 auto）；
  // 换了 provider 或 baseUrl ⇒ 按本次请求的 api 重解析（真正用哪家就按哪家）。
  if (overrides.cacheStrategy !== undefined) {
    const meta = normalizeCacheStrategy(overrides.cacheStrategy);
    api.cacheStrategy = meta.strategy;
    api.cacheStrategySelected = meta.selected || meta.strategy;
    api.cacheStrategySource = meta.source;
    api.cacheStrategyReason = meta.reason;
    return api;
  }
  if (overrides.provider !== undefined || overrides.baseUrl !== undefined) {
    return applyCacheStrategy(api);
  }
  return api;
}

/**
 * 判断一个错误是否值得重试。
 *
 * 可重试（多半是暂时性的，再试一次可能就好）：
 *   - 网络层失败 / 超时 / 连接被重置
 *   - HTTP 5xx（服务端出问题）
 *   - HTTP 429（限流，等一会儿再来）
 *   - 响应解析失败（偶发的空响应/截断）
 *
 * 不重试（重试也不会变好，只会浪费额度）：
 *   - HTTP 4xx：401 密钥错、400 请求体错、403 无权限、404 模型不存在
 *   - 主动中止（abort）
 */
export function isRetryableError(error) {
  const msg = String(error?.message ?? error ?? '');

  // 主动中止（用户/系统取消）：重试没有意义
  if (/aborted|中止|已取消|cancel/i.test(msg)) return false;

  // 明确的客户端错误：重试也不会变好，只会白烧额度
  if (/HTTP\s*(401|400|403|404|405|409|413|422)/i.test(msg)) return false;
  if (/unauthorized|forbidden|invalid api.?key|incorrect api.?key/i.test(msg)) return false;

  // 明确的暂时性故障
  if (/HTTP\s*5\d\d/i.test(msg)) return true;                        // 5xx
  if (/429|rate.?limit|限流|too many requests|quota/i.test(msg)) return true;
  if (/超时|timeout|timed out/i.test(msg)) return true;

  // 网络层：错误码太多列不全（bad port、EHOSTUNREACH、证书、DNS…），
  // 凡是带 "模型请求失败" 前缀的都是 fetch 抛的，统一视为可重试
  if (/模型请求失败/.test(msg)) return true;
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|EPIPE|socket hang up|fetch failed|network/i.test(msg)) return true;

  // 响应解析失败（偶发空响应/截断）
  if (/无法解析的 JSON|Unexpected end|unexpected token|JSON/i.test(msg)) return true;

  // 兜底：模型 API 类错误默认不重试（避免未知错误疯狂重试）
  return false;
}

/**
 * 带重试的单次对话请求。
 *
 * 只在**可重试**的错误上重试（网络抖动、5xx、429），
 * 4xx（密钥错、参数错）直接抛出 —— 重试不会让它变好。
 * 退避策略：1s → 2s（指数退避，避免雪崩）。
 *
 * 注意：这里重试的是**同一轮**请求，messages 不变，所以是幂等的，
 * 不会造成重复发言。会话级的整体重试在 orchestrator 里做。
 *
 * @param {object} args 同 chatCompletion
 * @param {number} [retries=2] 最多额外重试几次（默认 2，即总共最多 3 次尝试）
 */
export async function chatCompletionWithRetry(args, retries = 3, onTraceEvent = null) {
  let lastError = null;
  const reportTraceEvent = (event) => {
    if (typeof onTraceEvent !== 'function') return;
    try { onTraceEvent(event); } catch { /* tracing must never affect a model request */ }
  };
  for (let attempt = 0; attempt <= retries; attempt++) {
    // ── 账号池（account-pool 插件的能力）──
    // 有插件提供 llm.endpoint-pick 时，每次尝试前问它"这轮用哪个端点"（多账号轮询/
    // 限流分摊/按延迟挑），并在成功/失败后回报延迟与错误，让它更新统计。
    // 没装这个插件 → 两个调用都返回 undefined，行为与从前完全一致。
    const pick = await pickPoolEndpoint(args?.poolKey || '');
    const started = Date.now();
    // 每次尝试一份独立的观测容器：chatCompletion 往里写响应头耗时（fetches）
    // 与 400/图片降级次数（fallbacks），随 model_attempt 事件带进 turn-trace。
    // 只含毫秒数、HTTP 状态码和固定的原因枚举，不含 payload / 密钥 / prompt。
    const traceMeta = { fetches: [], fallbacks: [] };
    const callArgs = pick ? { ...args, overrides: { ...(args?.overrides || {}), ...pick } } : args;
    try {
      const res = await chatCompletion({ ...callArgs, traceMeta });
      const endedAt = Date.now();
      reportPoolEndpoint(pick, { ok: true, ms: endedAt - started });
      reportTraceEvent({
        type: 'model_attempt', attempt, startedAt: started, endedAt, status: 'ok', code: 'response',
        responseHeadersMs: traceMeta.responseHeadersMs ?? null,
        fetches: traceMeta.fetches, fallbacks: traceMeta.fallbacks
      });
      return res;
    } catch (error) {
      lastError = error;
      const endedAt = Date.now();
      reportPoolEndpoint(pick, {
        ok: false,
        ms: endedAt - started,
        error: String(error?.message ?? error),
        status: Number(error?.status ?? error?.statusCode) || 0
      });
      reportTraceEvent({
        type: 'model_attempt', attempt, startedAt: started, endedAt, status: 'error', code: error?.name || 'request_failed',
        responseHeadersMs: traceMeta.responseHeadersMs ?? null,
        fetches: traceMeta.fetches, fallbacks: traceMeta.fallbacks
      });
      if (attempt >= retries || args?.signal?.aborted || !isRetryableError(error)) throw error;
      // 2026-10-21 溟修：连接层的失败（other side closed / ECONNRESET / socket hang up）
      // 是 undici 复用了一条已被对端关掉的 keep-alive 连接，下一次尝试会开新连接，
      // 所以这里不必等指数退避——拖得越久越像「不回话」。给 300~700ms 立刻重来；
      // 真·服务端错误仍按 0.8/1.6/3.2s 退避，并加一点抖动避免多会话同拍重试。
      const socketGone = /other side closed|ECONNRESET|socket hang up|EPIPE/i.test(String(error?.message ?? error));
      // 2026-10-21 溟修（第二版）：连接被对端关掉时第一次可以快（新连接立刻能通），
      // 但如果连着两次都断，多半是这一小段时间网络在抽风 —— 快重试只是在风里连撞。
      // 所以按 0.4s / 1.2s / 3s 递进，把窗口撑到 4~5 秒，给网络恢复留时间。
      const socketWaits = [400, 1200, 3000];
      const wait = socketGone
        ? (socketWaits[Math.min(attempt, socketWaits.length - 1)] + Math.floor(Math.random() * 250))
        : Math.floor(800 * Math.pow(2, attempt)) + Math.floor(Math.random() * 400);
      console.warn(`[llm] 请求失败（第 ${attempt + 1} 次尝试），${wait}ms 后重试：${error?.message ?? error}`);
      const waitStartedAt = Date.now();
      await new Promise((r) => setTimeout(r, wait));
      reportTraceEvent({ type: 'retry_wait', attempt, startedAt: waitStartedAt, endedAt: Date.now(), status: 'ok', code: `backoff_${wait}ms` });
    }
  }
  throw lastError;
}

/** 问账号池要一个端点（没装插件 / 没开 / 池子空 → undefined）。 */
async function pickPoolEndpoint(key) {
  try {
    const { skillManager } = await import('../extensions/index.js');
    for (const p of skillManager.getCapabilityProviders('llm.endpoint-pick', {})) {
      const r = p.fn({ key });
      if (r && (r.baseUrl || r.apiKey)) return r;
    }
  } catch { /* 插件坏了不影响主链路 */ }
  return undefined;
}

/** 回报本轮结果（延迟/错误），供账号池调权重。永不抛错。 */
function reportPoolEndpoint(pick, result) {
  if (!pick) return;
  import('../extensions/index.js').then(({ skillManager }) => {
    for (const p of skillManager.getCapabilityProviders('llm.endpoint-feedback', {})) {
      try {
        // 字段名对齐 account-pool 的签名：{ accountId, ok, latencyMs, error, status }
        p.fn({ accountId: pick.id || pick.accountId || '', ok: !!result.ok, latencyMs: Number(result.ms) || 0, error: result.error || '', status: Number(result.status) || 0 });
      } catch { /* ignore */ }
    }
  }).catch(() => { /* ignore */ });
}

/**
 * 是否阿里云百炼（DashScope）端点 —— 认 enable_thinking / thinking_budget /
 * cache_control（显式缓存）。其它端点按域名另配参数，见 thinkingStyleFor。
 */
function isDashScopeEndpoint(baseUrl) {
  try { return /(^|\.)aliyuncs\.com$/i.test(new URL(String(baseUrl || '')).hostname); } catch { return false; }
}
export { isDashScopeEndpoint };

/** 取 baseUrl 的 hostname（失败返回 ''）。 */
export function hostOf(baseUrl) {
  try { return new URL(String(baseUrl || '')).hostname.toLowerCase(); } catch { return ''; }
}

/**
 * 思考控制参数风格（常见国内 OpenAI 兼容端点）。
 * 返回：
 *   dashscope  — enable_thinking / thinking_budget（阿里百炼）
 *   ark        — thinking:{type:disabled|enabled,budget_tokens}（火山方舟 / 豆包）
 *   zhipu      — 同上（智谱 GLM-4.5+）
 *   moonshot   — thinking:{type:...}（Kimi k2.6；k3/k2.7 不认 disabled 时 400 回退）
 *   deepseek   — thinking:{type:disabled} + reasoning_effort（2026 官方 OpenAI 格式）
 *   siliconflow— chat_template_kwargs.enable_thinking（硅基流动）
 *   generic    — 尝试 enable_thinking:false（未知端点；400 会自动去掉重试）
 *   none       — 不发思考相关字段（OpenAI 官方 / 本地 LM Studio 等）
 */
export function thinkingStyleFor(baseUrl) {
  const h = hostOf(baseUrl);
  if (!h) return 'none';
  if (isDashScopeEndpoint(baseUrl)) return 'dashscope';
  if (/(^|\.)volces\.com$|volcengine|ark\.cn-beijing/i.test(h)) return 'ark';
  if (/(^|\.)bigmodel\.cn$|zhipuai|zhipu/i.test(h)) return 'zhipu';
  if (/moonshot|(^|\.)kimi/i.test(h)) return 'moonshot';
  if (/(^|\.)siliconflow\.(cn|com)$/i.test(h)) return 'siliconflow';
  if (/minimax|minimaxi/i.test(h)) return 'generic';
  // DeepSeek 官方：OpenAI 格式 thinking.type + reasoning_effort（非 token 预算）
  if (/(^|\.)deepseek\.com$/i.test(h)) return 'deepseek';
  if (/(^|\.)openai\.com$/i.test(h)) return 'none';
  // ★ 2026-10-26（溟 · 实测）：本机 127.0.0.1:8788 是 DeepSeek 语义的中转，**只认**
  //   `thinking:{type:'disabled'}`。原来 localhost 一律判 'none' ⇒ thinkingFields 返回 {}，
  //   `disableThinking` 与 `thinkingBudget` 一条都没下发。后果实测：
  //   挑表情那一枪 maxTokens=64，64 个 token 全被 reasoning 吃光、tool_calls 永远是空
  //   （10-26 一天 auto-sticker no-match 103 次、成功 0 次），用户侧就是「表情包区域坏了」。
  //   同一中转上量过四种写法（max_tokens 64）：
  //     无字段 / enable_thinking:false / reasoning_effort:low → reasoning 216~228、tool_calls 空
  //     thinking:{type:'disabled'}                            → reasoning 0、38 token、tool_calls 正常
  //   端点若不认 thinking 字段，llm.js 的 400 回退会剥掉它重试（bodyHasThinkingFields/stripThinkingFields），
  //   所以本地换成 deepseek 风格是安全降级。副作用：主聊天的 thinkingBudget=64 现在才真生效
  //   （→ reasoning_effort:low），思考变短、更快更省。
  if (/localhost|127\.0\.0\.1|\[::1\]/i.test(h)) return 'deepseek';
  if (/baidubce|qianfan|baidu/i.test(h)) return 'generic';
  // 中转站 / 未知域名：关思考时试一把 enable_thinking，400 自动回退
  return 'generic';
}

/**
 * 是否给消息块打 cache_control（显式缓存标记）。
 *
 * ★ 2026-10-16（CACHE-PROFILE-1，用户裁定）：本函数只是 `./cache-profile.js` 的**兼容转发**。
 *   旧实现在这里维护"点名否认 + 未知默认 true"的正则：智谱/方舟/DeepSeek/Kimi/硅基/OpenAI 被点名
 *   否认，而**未知域名、MiMo、百度千帆会被盲发** cache_control（靠 400 兜底才发现）。现在：
 *   · 只有**已确认**支持该字段的端点返回 true：百炼（*.aliyuncs.com，含官方 maas/token-plan 子域）、
 *     OpenRouter（官方文档明确透传；仍需 `cacheAffinityField()` 配合 sticky routing）；
 *   · 未知/未确认一律 false —— **不盲发未文档化的字段**（MiMo 官方无 cache_control 声明）。
 *   决策与 reason/steps 走 `cache-profile.js` 的 `cacheDecisionFor()`。
 */
export function supportsCacheMarkers(baseUrl) {
  // ★ CACHE-PROFILE-1（2026-10-16 用户裁定）：判据收敛到 ./cache-profile.js 的厂商表。
  //   旧实现对本函数名的语义是"点名否认 + 未知默认认"（会给 MiMo/千帆/未知中转盲发 cache_control）；
  //   现在只有**已确认**支持该字段的端点（百炼、OpenRouter 透传）为 true，未知/未确认一律 false。
  //   需要"为什么"请用 cache-profile.js 的 cacheDecisionFor()（带 reason/steps）。
  return cacheProfileFor(baseUrl).explicit === true;
}

/**
 * 已知的「自动前缀缓存」端点：不能用 cache_control 打标记，但供应商侧**确实有缓存**。
 *
 * ★ 2026-10-16（CACHE-PROFILE-1）：名单收敛到 `./cache-profile.js` 的厂商表（本函数只做转发）。
 *   ⚠️ "有自动缓存"**不等于**"值得按 4 分钟付费保温" —— 后者是画像里的 `warm`：
 *   DeepSeek（TTL 数小时~数天）/ GLM（TTL 未公布）/ MiMo（TTL 未说明）都是 auto:true、warm:false。
 */
export function isAutoCacheEndpoint(baseUrl) {
  return cacheProfileFor(baseUrl).auto === true;
}

/**
 * 该端点要不要在 body 里带"会话粘性"字段（OpenRouter 的 sticky routing 需要它）。
 * 不带的后果：命中的缓存块分散在不同 provider 上，下一轮路由过去就冷了。
 */
export function cacheAffinityField(baseUrl, api) {
  const h = hostOf(baseUrl);
  if (!h) return {};
  if (/openrouter\.ai$/i.test(h)) {
    const key = String(api?.chatKey || api?.affinityKey || '').trim();
    return { session_id: key || 'qq-agent', prompt_cache_key: key || 'qq-agent' };
  }
  return {};
}

/** 按风格拼思考相关 body 字段。off=关思考；budget=开思考时的长度上限。 */
function thinkingFields(style, { off, budget }) {
  const b = Number(budget) > 0 ? Math.max(1, Math.min(32768, Math.round(Number(budget)))) : 0;
  if (off) {
    switch (style) {
      case 'dashscope': return { enable_thinking: false };
      case 'ark':
      case 'zhipu':
      case 'moonshot':
      case 'deepseek': return { thinking: { type: 'disabled' } };
      case 'siliconflow': return { chat_template_kwargs: { enable_thinking: false } };
      case 'generic': return { enable_thinking: false };
      default: return {};
    }
  }
  if (!b) return {};
  switch (style) {
    case 'dashscope': return { thinking_budget: b };
    case 'ark':
    case 'zhipu':
    case 'moonshot': return { thinking: { type: 'enabled', budget_tokens: b } };
    // DeepSeek 用 reasoning_effort（low/high/max），不是 token 预算；
    // 预算映射到 effort：小预算→low，大预算→high（max 需显式要求，不默认发）
    case 'deepseek': return { reasoning_effort: b <= 128 ? 'low' : 'high' };
    default: return {};   // 未知端点不乱发预算（易 400）
  }
}

/** body 里是否带着思考相关字段（用于 400 回退判断）。 */
function bodyHasThinkingFields(body) {
  if (!body || typeof body !== 'object') return false;
  for (const k of ['enable_thinking', 'disable_thinking', 'thinking_budget', 'thinking', 'chat_template_kwargs']) {
    if (k in body) return true;
  }
  return false;
}

function stripThinkingFields(body) {
  const next = { ...body };
  for (const k of ['enable_thinking', 'disable_thinking', 'thinking_budget', 'thinking', 'chat_template_kwargs']) {
    delete next[k];
  }
  return next;
}

/** 去掉 messages 里的 cache_control 标记（端点不认时回退用）。 */

/**
 * 去掉 tools 上的 cache_control（400 兜底：有些端点只对 tools 字段报错）。
 *
 * ⚠️ 2026-09-22：以前是**原地** delete —— 而 cacheKeeper.remember() 存的是同一个数组的引用，
 *   所以一次 400 回退之后，"记住的前缀"里 tools 已经被悄悄改过，与真实发出的请求永久不一致
 *   （保温调用复用它就再也命不中）。现在改成返回**副本**，不动调用方手里那份。
 */
export function stripToolsCacheControl(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((t) => {
    if (!t || typeof t !== 'object') return t;
    const { cache_control: _drop, ...rest } = t;
    if (rest.function && typeof rest.function === 'object' && 'cache_control' in rest.function) {
      const { cache_control: _dropFn, ...fnRest } = rest.function;
      return { ...rest, function: fnRest };
    }
    return rest;
  });
}

export function stripCacheMarkers(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || !Array.isArray(m.content)) return m;
    let touched = false;
    const content = m.content.map((part) => {
      if (part && typeof part === 'object' && 'cache_control' in part) {
        const { cache_control, ...rest } = part;
        touched = true;
        return rest;
      }
      return part;
    });
    if (!touched) return m;
    // 单块纯文本可退回 string，保持和非显式缓存路径一致
    if (content.length === 1 && content[0]?.type === 'text' && typeof content[0].text === 'string') {
      return { ...m, content: content[0].text };
    }
    return { ...m, content };
  });
}

/**
 * 当前视觉接口能不能吃这种图片格式。
 *
 * 实测（2026-09-11 00:14）：本地 LM Studio 收到 data:image/webp 直接回
 * 400 "'url' field must be a base64 encoded image."，整轮运行报 error ——
 * 图没发出去、话也没说出来（用户看到的就是"图片发不出来了"）。
 * 百炼的 qwen-vl 支持 webp，所以只对非百炼端点降级。
 */
export function visionUnsupported(mime) {
  if (!/^image\/(webp|avif)$/i.test(String(mime || ''))) return false;
  try {
    return !isDashScopeEndpoint(getConfig().api?.baseUrl);
  } catch {
    return true;   // 判断不了就当不支持：宁可少看一张图，也不能把整轮打挂
  }
}

/** 接口是因为"图片格式/编码"拒绝的这次请求吗（LM Studio 实测 400 "'url' field must be a base64 encoded image."）。 */
export function isImageRejection(status, text) {
  if (![400, 415, 422].includes(Number(status))) return false;
  return /base64 encoded image|image_url|invalid image|unsupported (image|media)|must be a base64/i.test(String(text || ''));
}

/**
 * 把所有图片段换成一句文字说明，返回新 messages；没有图片则返回 null。
 * 用于"接口不认这种图"时的降级重试：宁可这轮看不见图，也不能整轮报错什么都不发。
 */
export function stripImageParts(messages) {
  let touched = false;
  const out = (messages || []).map((m) => {
    if (!Array.isArray(m?.content)) return m;
    const kept = [];
    let dropped = 0;
    for (const part of m.content) {
      if (part?.type === 'image_url') { dropped += 1; continue; }
      kept.push(part);
    }
    if (!dropped) return m;
    touched = true;
    kept.push({ type: 'text', text: `（有 ${dropped} 张图片无法传给当前模型：接口不支持这种图片格式，已省略）` });
    return { ...m, content: kept };
  });
  return touched ? out : null;
}

/**
 * 单次对话请求。messages 为 OpenAI 格式；tools 为 OpenAI function 格式（可为空）。
 * 返回 { message, usage, raw }；usage 形如 { prompt_tokens, completion_tokens, total_tokens }。
 * overrides: { baseUrl, apiKey, model, timeoutMs } 可选，用于记忆整理专用模型等场景。
 *
 * 可选 traceMeta（观测出参，调用方传一个普通对象进来，正常调用方可完全不传）：
 *   - traceMeta.fetches[]          每次底层 fetch 收到响应头时记一条
 *                                  { responseHeadersMs, status }。responseHeadersMs
 *                                  **不是纯 TTFT**：它覆盖「请求发出 → 响应头到达」，
 *                                  body 下载与 JSON 解析不含在内（那部分属于
 *                                  chatCompletionWithRetry 里的整个 attempt 耗时）。
 *   - traceMeta.responseHeadersMs  最终成功响应（res.ok）的响应头耗时。
 *   - traceMeta.fallbacks[]        每次因图片不支持 / HTTP 400 剥参数后**再发起
 *                                  fetch** 记一条 { reason, status, stripped? }；
 *                                  reason ∈ 'image_rejected' | 'http400_param_strip' | 'plugin_advisor'，
 *                                  stripped ∈ ['thinking','cache_control']。
 *                                  fallback 次数 = fallbacks.length。
 *   只写毫秒数、HTTP 状态码和固定枚举字符串；绝不写 payload、密钥或 prompt 内容。
 */
// 能力列表沿 manager/registry 的注册顺序；转换链后者覆盖前者。
// 内建先构造默认值，插件后转换；降级先尝试每个插件至多一次建议，再保留内建兜底。
const isTransformObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

async function llmTransformLists(context) {
  try {
    const { skillManager } = await import('../extensions/index.js');
    return {
      request: skillManager.getRequestTransforms(context),
      response: skillManager.getResponseTransforms(context),
      usage: skillManager.getUsageTransforms(context),
      retry: skillManager.getRetryAdvisors(context)
    };
  } catch { return { request: [], response: [], usage: [], retry: [] }; }
}

async function callLlmTransform(fn, args) {
  let timer;
  try {
    // 与普通钩子一样有界、失败开放；副本防止抛错/超时插件污染已经构造的请求。
    const value = await Promise.race([
      Promise.resolve().then(() => fn(structuredClone(args))),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('LLM transform timeout')), 5000); })
    ]);
    // 循环引用/BigInt等不可JSON编码的返回也按失败开放处理，避免泄漏请求计时器。
    if (isTransformObject(value)) JSON.stringify(value);
    return value;
  } catch { return undefined; }
  finally { clearTimeout(timer); }
}

export async function chatCompletion({ messages, tools = null, toolChoice = 'auto', temperature = null, signal = null, overrides = null, affinityKey = '', traceMeta = null, onFinalBody = null, singleAttempt = false, requestLifecycle = null }) {
  // ⚠️ overrides 必须叠在 effectiveApi 上，不能整份顶掉：
  // 否则 { disableThinking } 会丢掉 baseUrl/model/key → fetch "Invalid URL"
  // ★ 2026-10-17：走 `apiWith` —— 同一层顺带把"本次请求真正用的 provider/端点"对应的 cacheStrategy
  //   解析好（overrides 换了 provider/baseUrl 也重解析）；auto 时与从前逐字相同。
  const api = apiWith(overrides || {});
  let body = {
    model: api.model,
    // 2026-11-05（溟）：tools 挪到 messages 之前。
    // 缓存按**请求体的序列化前缀**匹配；原来 tools 排在 messages 后面，
    // messages 每轮都会变一个字，27 342 字符的 tools 就整段作废——
    // 实测 01:38 / 01:41 两轮 toolsHash 完全相同，命中却卡在 7296 token。
    // 挪到前面后 tools 成为前缀的一部分。字段顺序不影响 API 语义。
    ...(tools && tools.length > 0 ? { tools, tool_choice: toolChoice } : {}),
    messages,
    stream: false
  };
  // 会话粘性（OpenRouter 的 sticky routing 靠它把同一会话钉在同一 provider 上，
  // 否则"首条非 system 消息每轮都变"→ 分会话键一直变 → 缓存永远冷）。其它端点忽略这两个字段。
  Object.assign(body, cacheAffinityField(api.baseUrl, { chatKey: affinityKey }));
  // tools 已在 body 头部赋值（见上），这里不再重复写，避免把它挤回 messages 之后。
  // 思考模式：按端点风格下发（百炼 enable_thinking / 方舟·智谱·Kimi thinking.type /
  // 硅基流动 chat_template_kwargs / 未知端点试 enable_thinking，400 自动去掉重试）。
  //
  // ⚠️ 2026-09-11 实测（号A = qwen3.7-flash，真实会话盲评 12 局）：
  //   关思考输了 8 局：出现"不是""对"这种一个词的回复，还有约 1/3 把回复写成内心独白
  //   （正文不发送 → 群里静默），用户感受就是"这模型好蠢"。
  //   开思考质量明显更好，但不限长时要思考 300~3300 token、单次 8~37 秒，群聊等不了。
  //   折中：thinking_budget 限制思考长度 —— budget=128 实测 2.3s、budget=320 时 5.0s。
  // 优先级：亢奋强制关思考 > overrides.disableThinking > 全局 disableThinking
  let thinkOff = (overrides && Object.prototype.hasOwnProperty.call(overrides, 'disableThinking'))
    ? overrides.disableThinking === true
    : getConfig().api?.disableThinking === true;
  if (isHypeMode()) thinkOff = true;
  const thinkStyle = thinkingStyleFor(api.baseUrl);
  const thinkBudget = Number(api.thinkingBudget ?? getConfig().api?.thinkingBudget) || 0;
  Object.assign(body, thinkingFields(thinkStyle, { off: thinkOff, budget: thinkBudget }));
  const temp = temperature === null ? (api.temperature ?? 0.8) : temperature;
  if (temp !== null && temp !== undefined && Number.isFinite(Number(temp))) body.temperature = Number(temp);

  // 采样参数（治小模型的复读与啰嗦）：本地小模型/小上下文尤其需要
  //   - frequency_penalty：按出现次数惩罚重复 token（直接压复读）
  //   - presence_penalty：出现过就惩罚（鼓励换话题）
  //   - top_p / max_tokens：收窄采样面、掐掉长篇大论
  // 全部可选：配成 0 / 空就不发这些字段（保持各家端点的默认行为）。
  const extras = {
    top_p: api.topP,
    frequency_penalty: api.frequencyPenalty,
    presence_penalty: api.presencePenalty,
    max_tokens: api.maxTokens
  };
  for (const [key, raw] of Object.entries(extras)) {
    const n = Number(raw);
    if (raw === null || raw === undefined || raw === '' || !Number.isFinite(n) || n === 0) continue;
    body[key] = n;
  }

  // 旧 disableThinking 是内建默认值，不压住插件自身设置；亢奋/按次显式覆盖仍优先。
  const transformContext = { thinkingMode: api.thinkingMode, affinityKey };
  if (isHypeMode()) transformContext.thinkingMode = 'off';
  else if (overrides && Object.prototype.hasOwnProperty.call(overrides, 'disableThinking')) {
    transformContext.thinkingMode = overrides.disableThinking === true ? 'off' : 'on';
  }
  const transforms = await llmTransformLists(transformContext);
  let thinking;
  if (transforms.request.length) {
    // 插件先看不带内建思考字段的副本，避免另一方言的字段残留。
    // 只有有效 body 才提交；没有插件接管 thinking 时保留内建思考默认值。
    let next = stripThinkingFields(body);
    for (const key of Object.keys(thinkingFields(thinkStyle, { off: thinkOff, budget: thinkBudget }))) delete next[key];
    let changed = false;
    let omitTemperature = false;
    for (const fn of transforms.request) {
      const value = await callLlmTransform(fn, { body: next, api, context: transformContext });
      if (!isTransformObject(value?.body)) continue;
      next = value.body;
      changed = true;
      if (isTransformObject(value.thinking)) thinking = value.thinking;
      if (typeof value.omitTemperature === 'boolean') omitTemperature = value.omitTemperature;
    }
    if (changed) {
      if (thinking?.applied !== true) Object.assign(next, thinkingFields(thinkStyle, { off: thinkOff, budget: thinkBudget }));
      if (omitTemperature) delete next.temperature;
      body = next;
    }
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(5000, Number(api.timeoutMs) || 180000);
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
  // ★ 2026-10-17：调用方 signal 上的监听器必须能摘掉。`{ once: true }` 只在**它自己触发**
  //   时移除；请求先成功返回时它永远不触发，而 signal 由编排层跨轮复用 ⇒ 每轮挂一个、
  //   永远攒着（>10 个还会打 MaxListenersExceededWarning）。
  let detachCallerSignal = null;
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason ?? new Error('aborted'));
    else {
      const onAbort = () => controller.abort(signal.reason ?? new Error('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      detachCallerSignal = () => { try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ } };
    }
  }
  /** 收尾：停超时定时器 + 摘监听器。请求成功/失败/抛错前都必须过一次。 */
  const settle = () => {
    clearTimeout(timer);
    if (detachCallerSignal) { detachCallerSignal(); detachCallerSignal = null; }
  };

  let res;
  // ── 观测辅助：只碰 traceMeta，任何异常都被吞掉，绝不影响请求本身 ──
  const noteHeaders = (resp, fetchStartedAt) => {
    if (!traceMeta || typeof traceMeta !== 'object') return;
    try {
      const entry = { responseHeadersMs: Math.max(0, Date.now() - fetchStartedAt), status: Number(resp?.status) || 0 };
      if (!Array.isArray(traceMeta.fetches)) traceMeta.fetches = [];
      traceMeta.fetches.push(entry);
      if (resp?.ok) traceMeta.responseHeadersMs = entry.responseHeadersMs;
    } catch { /* tracing must never affect a model request */ }
  };
  const noteFallback = (entry) => {
    if (!traceMeta || typeof traceMeta !== 'object') return;
    try {
      if (!Array.isArray(traceMeta.fallbacks)) traceMeta.fallbacks = [];
      traceMeta.fallbacks.push(entry);
    } catch { /* tracing must never affect a model request */ }
  };
  const send = async (payload) => {
    // ★ N49：纯观测。放在 send 里 = 每一次真实投递（含 retry 变换 / strip 图片 / 剥 cache_control
    //   之后的那个 payload）都会被看到一次。不返回值、不改 payload、异常全部吞掉。
    emitFinalBody(payload, onFinalBody, { capability: capabilityFactsFor(api.baseUrl, { chatKey: affinityKey }) });
    // 2026-11-01（溟）：出口兜底。任何一处按 UTF-16 码元截断，都可能把 emoji 切成半个字符，
    //   留下孤立代理（\ud83d 这种）；发出去时 utf-8 编码直接失败，整条请求 502
    //   （upstream unreachable: surrogates not allowed）。私聊连挂十轮就是它。
    //   与其追每个 slice 点，不如堵在出口：投递前把所有孤立代理剔掉，最多丢半个字，不丢整轮。
    payload = stripLoneSurrogates(payload);
    let url;
    try {
      url = joinUrl(api.baseUrl, '/chat/completions');
    } catch (error) {
      settle();
      throw error;
    }
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(api.apiKey) },
      body: JSON.stringify(payload),
      signal: controller.signal
    };
    const fetchStartedAt = Date.now();
    try { requestLifecycle?.onFetchStart?.(); } catch { /* accounting telemetry must not alter the request */ }
    inFlightRequestCount += 1;
    try {
      const resp = await fetch(url, init);
      noteHeaders(resp, fetchStartedAt);
      return resp;
    } catch (error) {
      settle();
      if (error?.name === 'AbortError') throw new Error(`模型请求超时（${timeoutMs}ms）`);
      throw new Error(`模型请求失败：${error?.cause?.message ?? error?.message ?? error}`);
    } finally {
      inFlightRequestCount = Math.max(0, inFlightRequestCount - 1);
    }
  };

  // 请求预算由 chatCompletionOnce 的调用方在真实发送前持久预留；原始请求体不写入预算账本。
  res = await send(body);
  if (!res.ok) {
    let text = await res.text().catch(() => '');
    let payload = body;
    // 先追加插件专用降级（例如 GIF 首帧），失败后仍走原有兜底；成功体不再被内建覆盖。
    for (const { fn } of (singleAttempt ? [] : transforms.retry)) {
      if (res.ok || controller.signal.aborted) break;
      const advice = await callLlmTransform(fn, { body: payload, api, context: transformContext, thinking, errorText: text, status: res.status });
      if (!isTransformObject(advice?.body) || JSON.stringify(advice.body) === JSON.stringify(payload)) continue;
      payload = advice.body;
      noteFallback({ reason: 'plugin_advisor', status: Number(res.status) || 0 });
      res = await send(payload);
      if (!res.ok) text = await res.text().catch(() => '');
    }
    // ── 图片格式被接口拒绝时的降级 ──
    if (!singleAttempt && !res.ok && isImageRejection(res.status, text)) {
      const stripped = stripImageParts(payload.messages);
      if (stripped) {
        console.warn(`[llm] 接口不接受请求里的图片（HTTP ${res.status}），已省略图片重试一次：${redactSecrets(text).slice(0, 160)}`);
        payload = { ...payload, messages: stripped };
        noteFallback({ reason: 'image_rejected', status: Number(res.status) || 0 });
        res = await send(payload);
        if (!res.ok) text = await res.text().catch(() => '');
      }
    }
    // ── 400：可能是思考参数 / cache_control 不被认 —— 各剥一层再试一次 ──
    if (!singleAttempt && !res.ok && res.status === 400) {
      let degraded = false;
      let next = payload;
      const strippedKinds = [];
      if (bodyHasThinkingFields(next)) {
        next = stripThinkingFields(next);
        degraded = true;
        strippedKinds.push('thinking');
      }
      if ((next.messages && JSON.stringify(next.messages).includes('cache_control')) || (next.tools && JSON.stringify(next.tools).includes('cache_control'))) {
        const cleanedMessages = stripCacheMarkers(next.messages);
        const cleanedTools = stripToolsCacheControl(next.tools);
        next = { ...next, messages: cleanedMessages, tools: cleanedTools };
        degraded = true;
        strippedKinds.push('cache_control');
      }
      if (degraded && next !== payload) {
        console.warn(`[llm] HTTP 400，已去掉思考/缓存标记重试：${redactSecrets(text).slice(0, 200)}`);
        noteFallback({ reason: 'http400_param_strip', status: Number(res.status) || 0, stripped: strippedKinds });
        res = await send(next);
        if (!res.ok) text = await res.text().catch(() => '');
        else if (strippedKinds.includes('cache_control')) {
          // ★ 2026-10-17（用户裁定 · 剥标记→诊断闭环）：**剥掉标记后重试成功**才算"这个身份
          //   不接受这个标记"的证据，记进按 endpoint/账号/模型/策略 隔离的记忆 —— 下一次
          //   贴标记点与保温决策会读到它，不再"一边被剥离、一边报已启用"。
          try { noteCacheMarkerStripped(api, strippedKinds); } catch { /* 记忆失败不影响请求 */ }
        }
        payload = next;
      }
    }
    if (!res.ok) {
      settle();
      throw new Error(`模型 API HTTP ${res.status}：${redactSecrets(text).slice(0, 500)}`);
    }
  }
  settle();
  const data = await res.json().catch(() => { throw new Error('模型 API 返回了无法解析的 JSON'); });
  const choice = data?.choices?.[0];
  if (!choice) throw new Error(`模型 API 响应缺少 choices：${JSON.stringify(data).slice(0, 300)}`);
  let result = {
    message: choice.message ?? {},
    finishReason: choice.finish_reason ?? null,
    usage: data.usage ?? null,
    model: data.model ?? api.model,
    raw: data
  };
  for (const fn of transforms.response) {
    const value = await callLlmTransform(fn, { result, api, context: transformContext });
    if (isTransformObject(value?.result)) result = { ...result, ...value.result };
  }
  for (const fn of transforms.usage) {
    const value = await callLlmTransform(fn, { usage: result.usage, result, api, context: transformContext });
    if (isTransformObject(value) && Object.keys(value).length) result = { ...result, usage: { ...(result.usage || {}), ...value } };
  }
  return result;
}

/** One budgeted provider attempt. A request is never sent before its durable reservation. */
export function chatCompletionOnce({ budgetService, budgetRequest = {}, estimatedTokens = null, ...args } = {}) {
  // ★ 2026-10-17：同 chatCompletion —— 用 `apiWith` 保持 cacheStrategy 与本次请求同源。
  const api = apiWith(args.overrides || {});
  return executeBudgetedRequest({
    budgetService, budgetRequest, estimatedTokens,
    request: { messages: args.messages, tools: args.tools, maxTokens: api.maxTokens, signal: args.signal },
    model: String(budgetRequest.model || api.model || ''),
    invoke: (requestLifecycle) => chatCompletion({
      ...args, singleAttempt: true, requestLifecycle
    })
  });
}
/** 获取模型列表（GET /models）。返回 [{ id }]；失败抛错。 */
export async function listModels() {
  const cfg = effectiveApi();
  const res = await fetch(joinUrl(cfg.baseUrl, '/models'), {
    headers: authHeaders(cfg.apiKey),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`获取模型列表失败：HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return list.map((m) => ({ id: String(m.id ?? m.model ?? m) })).filter((m) => m.id);
}

/**
 * 累加 usage。
 * 同时累计 cachedTokens（命中前缀缓存的 prompt 部分）与 cacheCreationTokens（显式缓存写入）。
 *
 * ⚠️ 2026-09-22：以前这里只认 3 个字段（prompt_tokens_details.cached_tokens /
 *   prompt_cache_hit_tokens / cached_tokens），于是走 Anthropic 协议或部分中转时
 *   `cache_read_input_tokens` 读不到 → 命中率恒为 0、成本页把命中的 token 全按原价算；
 *   `cache_write_tokens`（OpenRouter 的写法）也漏了，写入量记成 0。
 *   现在统一走 cache-keepalive 里那份"能认多种形态"的读取器（readUsageNumbers），
 *   一个项目只有一套口径 —— 保温链那边早就读得更全，两边一致才不会互相打脸。
 */
export function addUsage(target, usage) {
  if (!usage) return target;
  const nums = readUsageNumbers(usage);
  const prompt = nums.prompt || 0;
  const completion = Number(usage.completion_tokens) || Number(usage.completionTokens) || 0;
  target.promptTokens += prompt;
  target.completionTokens += completion;
  target.totalTokens += Number(usage.total_tokens) || (prompt + completion);
  target.cachedTokens = (Number(target.cachedTokens) || 0) + (nums.cached || 0);
  // 显式缓存创建量：百炼按输入单价 125% 计费；Kimi / OpenRouter 叫 cache_write_tokens
  target.cacheCreationTokens = (Number(target.cacheCreationTokens) || 0) + (nums.created || 0);
  return target;
}

export function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, calls: 0 };
}

/** 缓存命中率（0~1）。没有 prompt 数据时返回 0。 */
export function cacheHitRate(usage) {
  const p = Number(usage?.promptTokens) || 0;
  if (!p) return 0;
  return Math.min(1, Math.max(0, (Number(usage?.cachedTokens) || 0) / p));
}

/**
 * 按配置单价折算成本（元）。
 *
 * 三种单价来源：
 *   1. useOfficialPrice=true 且模型 id 在内置价格表里 → 用官方价（缓存部分单独计价）
 *   2. 否则用用户手填的 priceInputPerM / priceOutputPerM / priceCachedPerM
 *   3. 都没有 → 0（不估算）
 *
 * 缓存命中部分优先走 cached 单价；官方价里 cached 为 null 时（该模型无缓存优惠）
 * 退回按普通输入价计算。
 *
 * 峰谷分时：opts.at 传调用时刻（毫秒时间戳）时，对支持分时的厂商（DeepSeek）
 * 按该时刻自动取高峰价或闲时价。不传 at 则按闲时计价（保守估值，会偏低）。
 * 历史统计请看 sumCostByTime() —— 它按每条记录的时刻分别计价后汇总，更准。
 */
export function estimateCost(usage, opts = {}) {
  const cfg = effectiveApi();
  // 成本只与"实际调用的模型"有关。opts.model 优先（统计时逐条传入各自的模型），
  // 不传才回退到当前选中的模型。
  const model = String(opts.model ?? cfg.model ?? '');

  const promptTokens = Number(usage?.promptTokens) || 0;
  const completionTokens = Number(usage?.completionTokens) || 0;
  const cachedTokens = Math.min(Number(usage?.cachedTokens) || 0, promptTokens);
  // 显式缓存创建量已含在 prompt 里；优先使用模型单列的创建价。
  const creationTokens = Math.min(Number(usage?.cacheCreationTokens) || 0, Math.max(0, promptTokens - cachedTokens));
  // 未命中缓存的普通输入 = 总输入 - 命中部分 - 缓存创建部分
  const freshTokens = Math.max(0, promptTokens - cachedTokens - creationTokens);

  // 统一走 resolveModelPrice：自定义 > 内置官方表 > 全局兜底
  // 注意：第二个参数要传完整配置对象（内部读 cfg.api.*），
  // 传 effectiveApi() 的返回值（它就是 api 本身）会导致取不到字段。
  const p = resolveModelPrice(model, getConfig());

  // 峰谷：传了 at（调用时刻）且该模型有 peak 档位就取对应档
  const atMs = Number(opts.at);
  const timeKnown = Number.isFinite(atMs) && atMs > 0;
  const tier = p.peak && timeKnown ? priceAt(p, atMs) : null;
  const inPrice = tier ? tier.in : p.in;
  const outPrice = tier ? tier.out : p.out;
  const cachedPrice = tier ? tier.cached : p.cached;
  // ★ 2026-10-17：只有价格条目明确给了 created 才按创建价；否则按普通输入价。
  //   旧实现的 `inPrice * 1.25` 是百炼显式缓存的规则，套到 DeepSeek（无创建费）会高估。
  const creationPrice = Number((tier?.created ?? p.created) != null ? (tier?.created ?? p.created) : inPrice) || 0;

  const source = p.source;
  const matched = p.matched;
  const peak = Boolean(tier?.peak);
  const hasPeakTiers = Boolean(p.peak);
  // ★ 2026-10-17：价格来源不可信/时间缺失时如实标注（不许把 0 当可信成本）。
  const priced = p.priced !== false;
  const peakUnknown = hasPeakTiers && !timeKnown;

  const cost =
    (freshTokens / 1_000_000) * inPrice +
    (creationTokens / 1_000_000) * creationPrice +
    (cachedTokens / 1_000_000) * cachedPrice +
    (completionTokens / 1_000_000) * outPrice;

  return {
    cost,
    source,
    priced,
    unpriced: !priced,
    zero: p.zero === true,
    peakUnknown,
    timeKnown,
    breakdown: {
      fresh: (freshTokens / 1_000_000) * inPrice,
      creation: (creationTokens / 1_000_000) * creationPrice,
      cached: (cachedTokens / 1_000_000) * cachedPrice,
      output: (completionTokens / 1_000_000) * outPrice
    },
    prices: { in: inPrice, out: outPrice, cached: cachedPrice, created: creationPrice },
    matched,
    // 峰谷信息：hasPeakTiers 表示这个模型是否分时段计价
    peak,
    hasPeakTiers
  };
}
