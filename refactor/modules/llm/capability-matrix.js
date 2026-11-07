/**
 * M4 · `llm/capability-matrix.js` —— **provider / 模型能力的一处统一出口**（N70）
 *
 * ── 一页说明：这个仓库里"模型/provider 能力"到底有哪几层，各自谁说话算数 ────────────
 *
 * ★ 2026-10-16（CACHE-PROFILE-1，用户裁定）：**缓存三件事的判据已收敛到
 *   `./cache-profile.js` 的一张厂商表**（explicit / auto / warm）与一个决策函数
 *   （`cacheDecisionFor()`）。本文件**不再持有 host 正则** —— `VENDORS` 由那张表派生，
 *   `cacheMarkingTrace/Plan` 直接转调决策函数。`llm.js` 的 `supportsCacheMarkers()` /
 *   `isAutoCacheEndpoint()` 也转发到同一处（值必然一致，不会出现"两份真相"）。
 *
 *   ① **汇总**：一次调用给出某个端点的全部能力裁决（思维风格 / 显式标记 / 自动前缀 /
 *      值不值得保温 / 会话亲和 / 图片格式）；缓存四项来自 cache-profile.js，思维/亲和/图片
 *      来自 `llm.js` 的既有函数。
 *   ② **点名"未知"**：命中不了任何已知厂商的端点，`known:false` 单独标出来 ——
 *      ★ 旧行为是"未知 ⇒ 乐观认为认 cache_control"；现在**保守**（不打标记、不保温），
 *      并且**不盲发未文档化字段**（MiMo 官方无 cache_control 声明）。
 *   ③ **交叉验算**：本文件的厂商表是那张唯一表的**派生视图**，自测里逐行与 llm.js 的
 *      转发函数对账，谁改了表却没同步下游，立刻红。
 *
 * ## 缓存三层 + 一个"值不值得保温"，各是什么（用户视角）
 *   · **显式缓存（explicit）**：请求里真带 `cache_control: {type:'ephemeral'}`。
 *     ⇐ 只有画像表 `explicit:true`（已确认支持）的端点才会带：百炼、OpenRouter（透传）。
 *     未知/MiMo/千帆/普通中转一律不带（不盲发）。本仓只打 1 个标记、只认"唯一 system"形状
 *     （百炼官方：Qwen3.5+ 只支持消息级断点、多 system 会内部合并、同消息多标记无效）。
 *   · **隐式 / 自动前缀（implicit / auto）**：**请求里不带任何字段**，供应商自己按前缀命中。
 *     ⇐ `auto:true` = 这个厂商这么做（DeepSeek / GLM / MiMo / Kimi / 硅基 / MiniMax / Ark / OpenAI 官方…）。
 *     注意：`cacheMode='implicit'` 的用户值是"只稳前缀、不打标记不保温"的明确语义（有读点）。
 *   · **会话亲和（affinity）**： OpenRouter 的 sticky routing，靠往 body 里塞
 *     `session_id` / `prompt_cache_key` 把同一会话钉在同一 provider 上（`cacheAffinityField`）。
 *   · **值不值得保温（warm）**：**有缓存 ≠ 要付钱续期**。只有 TTL 短且官方确认"命中即续期"的
 *     端点才 warm:true（目前只有百炼显式缓存：官方 5 分钟 TTL）；DeepSeek（TTL 数小时~天）/
 *     GLM / MiMo（TTL 未公布）都是 warm:false ⇒ 不再每 4 分钟发付费保温请求。
 *
 * ## TTL
 *   **没有任何地方读 TTL 配置，也没有任何地方设置 TTL。** 供应商侧行为不是本仓可调的旋钮。
 *   能在本仓调的只有"隔多久发一根保温棒"（`api.cacheKeepAlive.intervalMs`，默认 240000 ms）
 *   与"哪些端点值得保温"（画像表 `warm`）。
 *
 * 依赖纪律：本文件是 EXTRA（`src/` 无对应物），只 `import` 兄弟模块 `llm.js` / `cache-profile.js`
 * 的**公开函数**，不复制它们的任何正则。
 *
 * 【接线 · 2026-10-11 mimo2 / 2026-10-16 更新】`capabilityFactsFor()` 是生产读点：
 *   `llm.js` 的 `send()` 把它算出来的 capability 塞进 `emitFinalBody` 的 facts（观测缝），
 *   facts 里同时带 `cacheDecision`（唯一决策函数 mark/keepAlive/reason/steps）⇒ 观测 = 执行。
 *   它仍然**不参与任何请求决策** —— 决策一律走 `cache-profile.js`（贴标记点在 compose）。
 *   读 cacheMode / cacheKeepAlive.enabled 是为了给 facts/plan 填默认入参，真源仍是 `api.*`。
 */

import { get as getConfig } from '../../core/config-store/index.js';

import {
  hostOf,
  thinkingStyleFor,
  cacheAffinityField,
  visionUnsupported
} from './llm.js';

// ★ CACHE-PROFILE-1（2026-10-16 用户裁定）：缓存三件事（显式标记 / 自动前缀 / 值不值得保温）的
//   **唯一判据表**在 `./cache-profile.js`。本文件不再自己维护 host 正则 —— 厂商表直接从那里派生，
//   决策（打不打标记/开不开保温）也直接转调 `cacheDecisionFor()`，保证"观测事实 = 执行决策"。
import { CACHE_VENDORS, cacheProfileFor, cacheDecisionFor } from './cache-profile.js';

/**
 * 已知厂商表 —— **由 `cache-profile.js` 的唯一表派生**（此处只加 probe/期望值快照字段，供自测逐项对账）。
 *
 * 字段含义：
 *   · `probe`        典型 baseUrl（文档/自测样本，不参与判定）
 *   · `host`         hostname 正则（与 cache-profile.js 同源，来自同一行对象）
 *   · `note`         一句话说明
 *   · `thinking`     该厂商的思维参数方言（对应 thinkingStyleFor 的返回值；**期望值快照**）
 *   · `markers`      `supportsCacheMarkers` 的期望值（true=确认支持 Anthropic 风格 cache_control）
 *   · `auto`         `isAutoCacheEndpoint` 的期望值（true=供应商侧自动前缀缓存）
 *   · `warm`         是否值得付费保温（对应 cache-profile 的 warm）
 *   · `affinity`     是否往 body 塞会话亲和字段
 */
export const VENDORS = Object.freeze(CACHE_VENDORS.map((v) => ({
  probe: v.probe,
  host: v.host,
  note: v.note,
  thinking: v.thinking,
  markers: v.explicit === true,
  auto: v.auto === true,
  warm: v.warm === true,
  affinity: v.affinity === true
})));
/** 某主机命中的厂商行；没命中返回 null（= 未知端点）。 */
export function vendorOfHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return null;
  return VENDORS.find((v) => v.host.test(h)) ?? null;
}

/**
 * 一个端点的**全部**能力裁决。底层全部转调受管副本 ⇒ 只有一处真相。
 *
 * @param {string} baseUrl 任意 baseUrl（可以是配置里的，也可以是探针里的）
 * @param {object} [opts] `{ chatKey }` —— 只在 OpenRouter 的亲和字段里用到
 * @returns {{
 *   host:string, known:boolean, vendor:string,
 *   thinkingStyle:string,
 *   explicitCacheMarkers:boolean,   // 请求里会不会真带 cache_control
 *   autoPrefixCache:boolean,        // 供应商侧自动前缀缓存（不带字段）
 *   affinityFields:string[],        // 会往 body 里多塞哪些字段
 *   imageWebpSafe:boolean,          // webp/avif 能不能原样发（false ⇒ 会被 visionUnsupported 挡）
 *   verdict:string                  // 一行人话
 * }}
 */
export function capabilityOf(baseUrl, opts = {}) {
  const host = hostOf(baseUrl);
  const profile = cacheProfileFor(baseUrl);
  const row = vendorOfHost(host);
  const style = thinkingStyleFor(baseUrl);
  const affinity = cacheAffinityField(baseUrl, { chatKey: opts.chatKey ?? '' });

  const cap = {
    host,
    known: Boolean(row),
    vendor: row ? row.note : profile.vendor,
    thinkingStyle: style,
    // ★ CACHE-PROFILE-1：三件事全部来自唯一画像表（llm.js 的同名函数也转发到同一处，值必然一致）。
    explicitCacheMarkers: profile.explicit === true,
    autoPrefixCache: profile.auto === true,
    warmEligible: profile.warm === true,
    cacheProfile: {
      id: profile.id, protocol: profile.protocol, transport: profile.transport, source: profile.source,
      explicit: profile.explicit, auto: profile.auto, warm: profile.warm,
      warmReason: profile.warmReason, reason: profile.reason, notes: profile.notes
    },
    affinityFields: Object.keys(affinity ?? {}),
    // ★ `visionUnsupported(mime)` 读的是**配置里的** baseUrl，入参里没有端点 ⇒ 它回答的永远是
    //   "当前配置的那个端点"。跨端点提问时这里给 null（= 判不了），不拿配置的答案冒充传入端点的答案。
    imageWebpSafe: host === '' ? null : visionUnsupported('image/webp') === false,
    verdict: ''
  };
  cap.verdict = formatCapabilityLine(cap);
  return cap;
}

/** 一行人话：这个端点能干什么、不能干什么。 */
export function formatCapabilityLine(cap) {
  if (!cap || !cap.host) return 'baseUrl 解析不出主机名 ⇒ 判不了任何能力';
  const parts = [`${cap.vendor}`];
  parts.push(`思维参数=${cap.thinkingStyle}`);
  parts.push(cap.explicitCacheMarkers ? '确认支持 Anthropic 风格 cache_control（显式缓存可用）'
    : cap.autoPrefixCache ? '不认 cache_control；走供应商侧自动前缀缓存'
      : '既无确认的显式标记、也无确认的自动前缀缓存 ⇒ 保守（不打标记）');
  parts.push(cap.warmEligible ? '值得保温（TTL 短、命中续期）' : '不自动保温（TTL 长/未知，不烧钱续期）');
  if (cap.affinityFields.length) parts.push(`会话亲和字段=${cap.affinityFields.join('/')}`);
  if (cap.imageWebpSafe === null) parts.push('webp 能不能发：baseUrl 解析不出主机名，判不了');
  else parts.push(`webp/avif（按当前配置端点判，非本行端点）=${cap.imageWebpSafe ? '可原样发' : '会被挡'}`);
  if (!cap.known) parts.push('★ 未识别端点：缓存按保守画像处理（不打标记、不保温）——不盲发未文档化字段');
  return `${cap.host}：${parts.join('；')}`;
}

/** 一批端点的一次性对照表（给控制台/排查用）。 */
export function capabilityMatrix(urls = [], opts = {}) {
  return (Array.isArray(urls) ? urls : [urls]).map((u) => capabilityOf(u, opts));
}

/**
 * 缓存标记的**决策轨迹**：这一次到底为什么打/没打。
 *
 * ★ CACHE-PROFILE-1（2026-10-16）：本函数只做**转发** —— 真决策在 `cache-profile.js` 的
 *   `cacheDecisionFor()`（端点画像 + 用户 `cacheMode` + 保温开关，一处说清）。
 *   以前这里有一份自己的 if/else（还带“implicit 没有读点”的旧说法），现在 `implicit` 有明确定义。
 *
 * @param {object} p `{ baseUrl, cacheMode, keepAliveEnabled, chatKey }`
 * @returns {{marked:boolean, keepAlive:boolean, mode:string, reason:string, steps:Array<{step:string, value:*}>}}
 */
export function cacheMarkingTrace({ baseUrl = '', cacheMode = 'adaptive', keepAliveEnabled = false, chatKey = '' } = {}) {
  void chatKey;
  const decision = cacheDecisionFor({ baseUrl, cacheMode, keepAliveEnabled });
  return {
    marked: decision.mark,
    keepAlive: decision.keepAlive,
    mode: decision.mode,
    reason: decision.reason,
    steps: decision.steps
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
 * N70 追加：`onFinalBody` 观测缝要回答的 **provider 级"缓存标记适配"口径**
 *
 * 用户/指挥位要的三个数：**这个端点认不认 `cache_control`** / **最多几个** / **最短多长**。
 * 诚实交代这三条的来源与可核程度（★ 不许脑补）：
 *
 *   ① **认不认** —— 唯一判据在 `cache-profile.js` 的画像表（`explicit`）。
 *      `llm.js` 的 `supportsCacheMarkers()` 现在只是转发到同一处；本文件也一样。
 *      ★ 2026-10-16 用户裁定：**未知端点不再乐观默认 true** —— 未确认支持的一律 false（不盲发）。
 *   ② **最多几个标记** —— 老树 `src/orchestrator.js:398-412 buildInitialMessages()` 的写法是
 *      **system 前缀上且仅一个** `{type:'ephemeral'}`（"one ephemeral marker on the initial
 *      system prefix only" 是它原注释）。Anthropic 官方上限是 4 个，但**本仓从不打第 2 个**
 *      ⇒ 这里的口径是"**本仓行为 = 1**"，不是"provider 上限 = 1"。两个数都列出，别混。
 *      ★ 百炼官方（Qwen3.5+）：只支持**消息级**断点；同一条消息的 content 数组里多个标记
 *      **不能**得到多个独立缓存块 ⇒ **content 块上的标记计数 ≠ 有效断点数**，本仓只用 1 个标记
 *      且只认"唯一 system"形状，与官方形状一致；tools 上的标记会被忽略（本仓不在 tools 上打）。
 *   ③ **最短多长**（前缀值不值得打标记/保温）—— 真源是 `api.cacheKeepAlive.minPrefixTokens`
 *      （默认 4096 token）。★ 2026-10-16 收口：它已是 `keep-alive-runtime.js` 的**真门槛** ——
 *      `0 = 不限制`；只认"已确认的稳定前缀 token 量"（命中时的 cached / 冷创建时官方回报的 creation），
 *      **未知大小保守 skip 并给原因**；门槛只作用于保温，永不拦主回复。
 *
 * ⚠ 这三个数**都不由本文件定义**，本文件只做"一处可查"：改口径请改上面点名的真源。
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 本仓实际会打的 `cache_control` 标记个数（老树 `buildInitialMessages` 的行为：system 前缀 1 个）。 */
export const CACHE_MARKERS_PER_REQUEST = 1;

/** Anthropic 官方文档的 `cache_control` 断点数上限（**不是**本仓行为，仅作对照）。 */
export const PROVIDER_MAX_CACHE_MARKERS = 4;

/** `api.cacheKeepAlive.minPrefixTokens` 的默认值（`cache-keepalive.js` 的 `DEFAULT_KEEP_ALIVE`）。 */
export const DEFAULT_MIN_PREFIX_TOKENS = 4096;

/**
 * 一次给出"这个端点这次请求的缓存标记适配"全份口径。
 *
 * @param {object} p
 *   · `baseUrl`            端点
 *   · `cacheMode`          `api.cacheMode`（`resolveCacheMode` 归一后的值）
 *   · `keepAliveEnabled`   保温链开不开（`api.cacheKeepAlive.enabled`）
 *   · `minPrefixTokens`    `api.cacheKeepAlive.minPrefixTokens`（缺省用 DEFAULT_MIN_PREFIX_TOKENS）
 *   · `systemChars`        实测 system 段字符数（可选；仅用于"离最短长度还差多少"的估算）
 * @returns {{marked:boolean, markers:number, providerMax:number, minPrefixTokens:number,
 *            hostOk:boolean, reason:string, note:string}}
 */
export function cacheMarkingPlan({
  baseUrl = '', cacheMode = 'adaptive', keepAliveEnabled = false,
  minPrefixTokens = DEFAULT_MIN_PREFIX_TOKENS, systemChars = null
} = {}) {
  const trace = cacheMarkingTrace({ baseUrl, cacheMode, keepAliveEnabled });
  // ★ 0 = 不限制（真语义，不许被 `||` 吞掉）；只有拿不到有限值时才回默认 4096。
  const rawMin = Number(minPrefixTokens);
  const min = Number.isFinite(rawMin) && rawMin >= 0 ? rawMin : DEFAULT_MIN_PREFIX_TOKENS;
  const chars = Number(systemChars);
  const note = Number.isFinite(chars) && chars > 0
    ? `实测 system 段 ${chars} 字符（≈${Math.round(chars / 2)} token 粗估；阈值判的是 token，不是字符，仅供量级参考）`
    : '未传 systemChars，不估算是否达到最短长度';
  return {
    marked: trace.marked,
    markers: trace.marked ? CACHE_MARKERS_PER_REQUEST : 0,
    providerMax: PROVIDER_MAX_CACHE_MARKERS,
    minPrefixTokens: min,
    // ★ CACHE-PROFILE-1：hostOk = "端点是否确认支持显式标记"（来自唯一画像表）。
    hostOk: cacheProfileFor(baseUrl).explicit === true,
    warm: trace.keepAlive === true,
    reason: trace.reason,
    note
  };
}

/**
 * **被生产代码读的那个出口**：把这个端点的"能力裁决 + 缓存标记口径"合成一份 facts。
 *
 * 唯一调用点：`llm.js` 的 `send()` → `emitFinalBody(payload, onFinalBody, { capability })`
 * （观测缝；没有回调时调用方根本不算，零请求开销）。
 *
 * @param {string} baseUrl 端点（`api.baseUrl`；调用方在 send() 里传，不猜配置）
 * @param {object} [opts]
 *   · `chatKey`         只影响 OpenRouter 的亲和字段名
 *   · `cacheMode`       缺省读 `api.cacheMode`（**没读点的非法值由 `resolveCacheMode` 降级，这里只做原样透传**）
 *   · `keepAliveEnabled` 缺省读 `api.cacheKeepAlive.enabled`
 *   · `minPrefixTokens` 缺省 `DEFAULT_MIN_PREFIX_TOKENS`
 * @returns {object|null} baseUrl 解析不出主机名 ⇒ 仍然给（`host:''`、`known:false`），由调用方决定要不要塞
 */
export function capabilityFactsFor(baseUrl, opts = {}) {
  const cfg = (() => { try { return getConfig() ?? {}; } catch { return {}; } })();
  const cacheMode = opts.cacheMode ?? String(cfg?.api?.cacheMode ?? 'adaptive');
  const keepAliveEnabled = opts.keepAliveEnabled
    ?? (cfg?.api?.cacheKeepAlive?.enabled === true);
  const cap = capabilityOf(baseUrl, { chatKey: opts.chatKey ?? '' });
  // ★ CACHE-PROFILE-1：facts 里带上唯一决策的**原始输出**（mode/mark/keepAlive/reason/steps），
  //   观测到的"打没打/保没保温"与执行侧问的是同一个函数，不会各说各话。
  const decision = cacheDecisionFor({ baseUrl, cacheMode, keepAliveEnabled: keepAliveEnabled === true });
  const plan = cacheMarkingPlan({
    baseUrl,
    cacheMode,
    keepAliveEnabled: keepAliveEnabled === true,
    minPrefixTokens: opts.minPrefixTokens ?? DEFAULT_MIN_PREFIX_TOKENS,
    systemChars: opts.systemChars ?? null
  });
  return {
    ...cap,
    cachePlan: plan,
    cacheDecision: {
      mode: decision.mode,
      mark: decision.mark,
      keepAlive: decision.keepAlive,
      reason: decision.reason,
      steps: decision.steps
    }
  };
}
