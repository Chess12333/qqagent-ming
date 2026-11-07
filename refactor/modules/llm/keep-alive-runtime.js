/**
 * M4 · `llm/keep-alive-runtime.js` —— 把 `api.cacheKeepAlive.*` 接成**真读点**（2026-10-09 · N5）
 *
 * ## 之前为什么是死键
 * `cache-keepalive.js` 里 `CacheKeeper` / `nextKeepAliveStep` / `keepAliveOptionsFor` /
 * `keepAliveMessages` / `appendKeepAliveLedger` **全都在**，`api.cacheKeepAlive.*` 六个键也都在配置里
 * （`core/config-store/defaults.js:91`），但**全树没有任何一处调用它们** ——
 * 于是这六个键改了不起作用：能落盘、没人读。
 *
 * ## 为什么住在这个新文件（EXTRA），不改 `cache-keepalive.js`
 * `cache-keepalive.js` 是**从 `src/` 搬来的受管副本**，`modules/llm/selftest.mjs` 的搬运保真闸门
 * 要求它与 `src/cache-keepalive.js` 的行差异**只许**落在「静态 import / 动态 import 说明符 / 注释」
 * 三类白名单里，加真实代码 = 硬失败（A55 实测：动 `llm.js` + `cache-keepalive.js` ⇒ 47 条硬失败）。
 * `request-budget.js`（A55 建）与本文件都是**新树新增**（`src/` 无对应物）⇒ 改它们不触发那条闸门。
 * 与 A55 同一套路：**能力放 EXTRA，闸门保持绿**。
 *
 * ## 口径来源
 * 照抄老树 `src/orchestrator.js:4756-4840`（`#scheduleKeepAlive` / `#keepAliveOnce`）与
 * `:3037-3047`（每次调用前决定要不要打 cache_control 标记）。老树那套是"正确答案"，本文件只做搬运 + 加可测性。
 *
 * ## 2026-10-16 收口（CACHE-PROFILE-1 续）
 *   · **值不值得保温**改由 `cache-profile.js` 的画像 `warm` 裁（不再用"有缓存 ⇒ 付钱续期"的旧推导）；
 *     端点画像里 explicit 与 warm 同步降级（不支持的协议形状不会出现"不打标记却保温"）。
 *   · **排链/每棒/发棒前都问同一个 `cacheDecisionFor()`**（画像 + 模式 + 开关）：链条不再自拼第二套
 *     模式判据（配置模式为空/非法时曾与贴标记点的归一化结果不一致）。
 *   · **账号/密钥指纹**：换号（含账号池换号）后旧账号的"前缀 token 量"证据作废并冷却 ——
 *     缓存是账号级隔离的，凭据不跨账号复用。
 *   · `api.cacheKeepAlive.minPrefixTokens` 成为**真门槛**：`0 = 不限制`；只认"已确认的稳定前缀 token 量"
 *     （命中时的 cached / 冷创建时官方回报的 creation），**未知大小保守 skip 并给原因**；
 *     门槛只作用于保温，永不影响主回复。
 *   · 注入 `optionsNow`（活配置读点）：开关/模式/间隔/上限/安静门槛/前缀门槛的热更新在**下一棒**与
 *     **发棒前**都生效（`#tick` / `#fire` 现读，且在 `send` 之前）。生产接线：compose `keepAliveFor()`
 *     （2026-10-16 完成，从活 runtime 取当前 llmMod/cfg，不锁第一轮 cfg）；未注入 ⇒ 用排链时快照
 *     （兼容旧调用方/自测）。活配置读不到（`liveError` / 读点抛异常）⇒ **保守不付费** + 诊断，
 *     绝不拿旧快照继续烧钱。
 *
 * ## 可测性约定（重要）
 * 本文件**不直接发网络请求、不 new 定时器**：`now` / `setTimer` / `clearTimer` / `send` 全部由调用方注入。
 * 所以「六个键改了行为真的变」可以在自测里**不花钱、不等真实 4 分钟**地断言。
 */

import {
  DEFAULT_KEEP_ALIVE,
  CacheKeeper,
  nextKeepAliveStep,
  keepAliveOptionsFor,
  keepAliveMessages,
  shouldMarkPrefix,
  readUsageNumbers,
  appendKeepAliveLedger
} from './cache-keepalive.js';
// ★ CACHE-PROFILE-1（2026-10-16 用户裁定）：端点"值不值得保温"由唯一画像表裁（`warm` 字段）。
//   以前这里用 `supportsCacheMarkers || isAutoCacheEndpoint` 当判据 ⇒ "有隐式缓存"被当成必须
//   每 4 分钟付费保温的理由（DeepSeek/GLM/MiMo/未知中转都在烧钱）。
import {
  cacheProfileFor as defaultCacheProfileFor,
  cacheDecisionFor as defaultCacheDecisionFor
} from './cache-profile.js';
// ★ 2026-10-16：usage 的"上报/未上报"逐字段判据只有这一份（`reported.*` 布尔）——前缀 token 证据
//   只认官方上报的值，未上报 ≠ 上报 0。不复制第二套字段猜测。
import { readCacheUsageReport } from './request-budget.js';
// ★ 2026-10-17（400 剥标记 → 诊断闭环）：与贴标记点读同一份按身份隔离的记忆 —— 剥过的端点不打标记、
//   也不保温（保温棒自带标记，会白付一棒且掩盖真实原因）。
import { cacheMarkerStrippedOn } from './cache-marker-memory.js';

/**
 * 账号/密钥指纹（**非明文**的短散列）：`baseUrl|model|apiKey|cacheStrategy` → 8 位 base36。
 * 用途：
 *   · 切换密钥/账号池换号后，旧账号建立的"前缀 token 量"证据不许带到新账号上（缓存是账号级隔离的）；
 *   · ★ 2026-10-17（每厂商专属缓存策略）：指纹**含有效 cacheStrategy** —— 切换策略同样作废旧前缀
 *     证据并冷却（旧策略的命中/创建量对新策略没有证明力）。
 * 只存指纹、不存密钥，也不打印。
 */
function accountFingerprint(api = {}) {
  const s = `${String(api?.baseUrl || '')}|${String(api?.model || '')}|${String(api?.apiKey || '')}`
    + `|${String(api?.cacheStrategy || 'auto')}`;
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;   // djb2-xor
  return h.toString(36);
}

/** 六个键 + 开关。缺省一律走 `DEFAULT_KEEP_ALIVE`（与 `cache-keepalive.js` 内部合并口径一致）。 */
export const KEEP_ALIVE_KEYS = Object.freeze([
  'enabled',
  'intervalMs',
  'maxPerChat',
  'privateMaxPerChat',
  'quietAfterMs',
  'privateQuietAfterMs',
  'minPrefixTokens'
]);

/**
 * ★ N5 的**真读点**：把 `api.cacheKeepAlive.*` 从配置读成一份 options。
 *
 * @param {{get?: Function}} cfg M1 配置门面（`cfg.get(key, fallback)`）
 * @returns {{enabled:boolean, intervalMs:number, maxPerChat:number, privateMaxPerChat:number,
 *            quietAfterMs:number, privateQuietAfterMs:number, minPrefixTokens:number,
 *            configured:Object, present:string[]}}
 */
export function readKeepAliveOptions(cfg = null) {
  const get = typeof cfg?.get === 'function' ? (key, fallback) => cfg.get(key, fallback) : () => undefined;
  const configured = {};
  const present = [];
  for (const key of KEEP_ALIVE_KEYS) {
    const value = get(`api.cacheKeepAlive.${key}`, undefined);
    configured[key] = value;
    if (value !== undefined && value !== null) present.push(key);
  }
  // ⚠ 口径与 `cache-keepalive.js` 内部一致：**只在该键真的没配时才用默认值**；
  //   配了 0 就是 0（例如 maxPerChat: 0 = 一棒都不发），不许被 `||` 吞掉。
  const merged = { ...DEFAULT_KEEP_ALIVE };
  for (const key of KEEP_ALIVE_KEYS) {
    const value = configured[key];
    if (value === undefined || value === null || value === '') continue;
    if (key === 'enabled') merged.enabled = value === true;
    else merged[key] = Number(value);
  }
  return { ...merged, configured, present };
}

/** 端点值不值得保温。
 *
 * ★ CACHE-PROFILE-1（2026-10-16 用户裁定）：判据 = 端点画像的 `warm`（TTL 短且官方确认续期语义）。
 *   旧判据 `supportsCacheMarkers || isAutoCacheEndpoint` 的真实含义是"这个端点在打标记或**有**缓存"，
 *   不等于"值得付钱续期" —— DeepSeek（TTL 数小时~天）/ GLM / MiMo / 未知中转都被它误开保温。
 *   画像优先（`helpers.cacheProfileFor`，生产由 compose 注入 llm 的同一份）；没注入时才退回老两个布尔
 *   （仅作自测/旧调用方的兼容缝，语义在登记里写明）。
 *
 * @returns {{ok:boolean, marked:boolean, auto:boolean, warm:boolean, reason:string, vendor:string}}
 */
export function endpointHasCache(api = {}, helpers = {}) {
  const profileFor = typeof helpers.cacheProfileFor === 'function' ? helpers.cacheProfileFor : defaultCacheProfileFor;
  // ★ 2026-10-17（每厂商专属缓存策略）：画像按**同一个有效策略**算（手选策略对中转也生效）；
  //   auto 时行为与从前逐字相同。
  const strategy = api?.cacheStrategySelected || api?.cacheStrategy || 'auto';
  let profile = null;
  try { profile = profileFor(api?.baseUrl, { cacheStrategy: strategy }); } catch { profile = null; }
  if (profile && typeof profile === 'object') {
    return {
      ok: profile.warm === true,
      marked: profile.explicit === true,
      auto: profile.auto === true,
      warm: profile.warm === true,
      reason: String(profile.warmReason || profile.reason || ''),
      vendor: String(profile.known ? profile.id : 'unknown'),
      // ★ 2026-10-17：诊断带上有效策略与来源（不含 URL/密钥/正文）。
      strategy: String(profile.strategy ?? 'auto'),
      strategySource: String(profile.strategySource ?? 'auto'),
      endpointVendor: String(profile.endpointVendor ?? (profile.known ? profile.id : 'unknown'))
    };
  }
  // 兼容缝：没有画像时按旧两个布尔推导（仅旧调用方/自测会用到这里）。
  const marked = typeof helpers.supportsCacheMarkers === 'function' && helpers.supportsCacheMarkers(api?.baseUrl) === true;
  const auto = typeof helpers.isAutoCacheEndpoint === 'function' && helpers.isAutoCacheEndpoint(api?.baseUrl) === true;
  return { ok: !!marked || !!auto, marked: !!marked, auto: !!auto, warm: !!marked || !!auto, reason: '', vendor: 'legacy-helpers',
    strategy: 'auto', strategySource: 'legacy', endpointVendor: 'legacy-helpers' };
}

/**
 * 保温链运行时：一个进程一份（与老树 `src/orchestrator.js:437 this.cacheKeeper = new CacheKeeper()` 同构）。
 *
 * 状态：每个 chatKey 一份 —— 已发棒数 `fired`、定时器 `timer`、最后一次活动时间 `lastActivityAt`。
 */
export class KeepAliveChain {
  constructor({
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(h),
    send = null,
    apiWith = null,
    supportsCacheMarkers = null,
    isAutoCacheEndpoint = null,
    // ★ CACHE-PROFILE-1：默认用本模块的画像表；生产由 compose 注入 llm 的同一份（唯一判据）。
    cacheProfileFor = null,
    // 活配置读点（热更新即时生效）：生产由 compose `keepAliveFor()` 注入；未注入 = 排链时快照
    // （见 `#liveOptions` 的合并顺序与"读不到不付费"约定）。
    optionsNow = null,
    onLedger = appendKeepAliveLedger,
    log = null
  } = {}) {
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.send = send;                       // 注入：真正发保温请求（生产=llm.chatCompletionWithRetry）
    this.apiWith = apiWith;                 // 注入：取 api + overrides
    this.helpers = {
      supportsCacheMarkers,
      isAutoCacheEndpoint,
      cacheProfileFor: typeof cacheProfileFor === 'function' ? cacheProfileFor : null,
      optionsNow: typeof optionsNow === 'function' ? optionsNow : null
    };
    this.onLedger = typeof onLedger === 'function' ? onLedger : () => {};
    this.log = typeof log === 'function' ? log : () => {};
    this.keeper = new CacheKeeper({ now });
    this.fired = new Map();                 // chatKey -> number
    this.timers = new Map();                // chatKey -> timer handle
    this.lastActivityAt = new Map();        // chatKey -> number
    this.accountTags = new Map();           // chatKey -> 账号/密钥指纹（换号后旧证据作废）
    // ★ 2026-10-16（晚到 usage 收口）：每个 chatKey 一份**前缀身份令牌**（真实请求归属证据）——
    //   由 `rememberPrefix()` 在登记那一刻原子写入；`noteUsage({identity})` 与 `#fire` 的
    //   await 之后复核都用它。代次装饰（写一个自增号再自比）识别不了请求归属，已撤。
    //   令牌含 systemText/tools（**不落日志**，只在内存里比对对象身份与字节等价）。
    this.prefixIdentities = new Map();      // chatKey -> frozen token {systemText, tools, accountTag, model, baseUrl}
    this.usageEvidence = new Map();         // chatKey -> 最近一次 usage 读数（诊断；计数/布尔，无正文）
    this.stats = { armed: 0, calls: 0, hits: 0, skipped: 0, stopped: 0, promptTokens: 0, cachedTokens: 0 };
    this.reasons = [];                      // 最近若干条决策理由（诊断）
  }

  /** 前缀身份令牌（不导出正文）：登记/复核共用一份判据。 */
  #identityToken(api, { systemText = '', tools = null } = {}) {
    return Object.freeze({
      systemText: String(systemText ?? ''),
      tools: tools ?? null,
      accountTag: accountFingerprint(api),
      model: String(api?.model || ''),
      baseUrl: String(api?.baseUrl || ''),
      // ★ 2026-10-17：有效缓存策略也是身份的一部分（切换策略 ⇒ 旧前缀证据作废，见 #identityStillCurrent）。
      cacheStrategy: String(api?.cacheStrategy || 'auto')
    });
  }

  /**
   * 这份令牌是否仍代表"当前这一棒"的前缀/账号/模型：
   *   · 令牌必须就是当前登记的那一份（换了前缀 ⇒ 对象不同）；
   *   · keeper 里槽位的前缀正文/工具必须与令牌逐字一致（防有人绕过 rememberPrefix 直接 remember）；
   *   · 活 api（`apiWith({})`，可为 null）的账号指纹/模型/baseUrl 必须没变（换号/换模型 = 缓存隔离）。
   * 任何一条不成立都表示"这份 usage 属于上一棒"——可以记账，但绝不能给新前缀续 TTL。
   */
  #identityStillCurrent(chatKey, token, { api, liveApi = null } = {}) {
    if (!token) return true;                      // 没登记过身份（旧调用方）⇒ 不做此项判定，保持旧行为
    if (this.prefixIdentities.get(String(chatKey)) !== token) return false;
    const current = this.keeper.prefixFor(api, chatKey);
    if (!current) return false;
    if (String(current.systemText ?? '') !== token.systemText) return false;
    if (JSON.stringify(current.tools ?? null) !== JSON.stringify(token.tools ?? null)) return false;
    // ★ 2026-10-17（每厂商专属缓存策略）：有效策略变了 ⇒ 这份 usage 不属于当前这一棒
    //   （除了指纹里已含策略，这里再做一次明文比对，诊断里能直接看出原因）。
    const liveStrategy = String((liveApi || api)?.cacheStrategy || 'auto');
    if (liveStrategy !== String(token.cacheStrategy || 'auto')) return false;
    if (liveApi) {
      if (accountFingerprint(liveApi) !== token.accountTag) return false;
      if (String(liveApi.model || '') !== token.model) return false;
      if (String(liveApi.baseUrl || '') !== token.baseUrl) return false;
    } else if (accountFingerprint(api) !== token.accountTag
      || String(api?.model || '') !== token.model
      || String(api?.baseUrl || '') !== token.baseUrl) {
      return false;
    }
    return true;
  }

  /**
   * 记住本轮用的稳定前缀（保温必须一字不差复用它）。老树口径：不要求命中过。
   *
   * ★ 2026-10-16：返回**前缀身份令牌**（truthy；旧返回 `true`，调用方只做真值判断）。
   *   调用方拿它传给之后的 `noteUsage({identity})` —— 这是"这份 usage 属于哪一棒"的唯一凭据，
   *   不是自增号自比：令牌是登记那一刻的 system/tools/账号/模型字节快照，晚到的 usage 复核对不上
   *   就只记账、不给新前缀续 TTL。
   */
  rememberPrefix({ api, chatKey, systemText = '', tools = null, prefixTokens = 0 } = {}) {
    if (!systemText) return false;
    const key = String(chatKey || '');
    const previous = this.keeper.prefixFor(api, chatKey);
    // ★ 换账号/换密钥（缓存账号级隔离）：旧账号建立的前缀证据全部作废、并冷却 ——
    //   下一次要重新拿到新账号自己的 usage 证据（cached/creation）才允许保温。
    const tag = accountFingerprint(api);
    const prevTag = this.accountTags.get(key);
    if (prevTag !== undefined && prevTag !== tag) {
      if (previous) previous.prefixTokens = 0;
      this.keeper.cool(api, chatKey);
    }
    this.accountTags.set(key, tag);
    if (previous && (previous.systemText !== systemText
      || JSON.stringify(previous.tools) !== JSON.stringify(tools))) {
      previous.prefixTokens = 0;
      this.keeper.cool(api, chatKey);
    }
    this.keeper.remember(api, { systemText, tools, prefixTokens, chatKey });
    const token = this.#identityToken(api, { systemText, tools });
    this.prefixIdentities.set(key, token);
    return token;
  }

  /**
   * 一次成功的真实调用结束后记 usage：命中续期，冷创建也可启动首次保温。
   *
   * ★ 2026-10-16（晚到 usage 收口）：可选 `identity` = `rememberPrefix()` 返回的前缀身份令牌。
   *   传了就必须复核"这份 usage 仍属于当前这一棒"（前缀字节/工具/账号/模型都没换）；对不上 ⇒
   *   **只留诊断、不动 keeper**（不续 TTL、不写前缀 token 证据、不 markSent）并返回 false。
   *   不传 identity 的老调用方与从前逐字一致。
   *   ★ 前缀 token 证据只认**官方上报**的值（creation / 命中的 cached）：未上报 ≠ 上报 0，
   *   用 `readCacheUsageReport().reported.*` 逐字段分开（显式 0 不再被当成"有证据"）。
   */
  noteUsage({ api, chatKey, usage = null, identity = null } = {}) {
    const key = String(chatKey || '');
    this.lastActivityAt.set(key, this.now());
    if (!usage) return false;
    const token = identity && typeof identity === 'object' ? identity : null;
    const stillCurrent = token ? this.#identityStillCurrent(key, token, { api }) : true;
    const numbers = readUsageNumbers(usage);
    const report = readCacheUsageReport(usage);
    const reported = report?.reported ?? {};
    this.usageEvidence.set(key, {
      at: this.now(),
      hit: false,                       // keeper 判定后回填
      superseded: token ? stillCurrent !== true : false,
      cached: numbers.cached || 0, created: numbers.created || 0, prompt: numbers.prompt || 0,
      reportedCached: reported.prompt_cache_hit_tokens === true,
      reportedCreated: reported.cache_creation_tokens === true,
      reportedPrompt: reported.prompt_tokens === true,
      identity: token ? { model: token.model, baseUrl: token.baseUrl, accountTag: token.accountTag } : null
    });
    if (token && stillCurrent !== true) {
      this.#note({ phase: 'late-usage-ignored', chatKey: key,
        why: 'usage 对应的前缀/账号/模型已被替换（晚到）——只记账，不续 TTL、不作前缀证据' });
      return false;
    }
    const hit = this.keeper.noteUsage(api, usage, key) === true;
    const prefix = this.keeper.prefixFor(api, key);
    if (prefix && reported.cache_creation_tokens === true && numbers.created > 0) {
      prefix.prefixTokens = Math.max(prefix.prefixTokens || 0, numbers.created);
    }
    if (prefix && reported.prompt_cache_hit_tokens === true && numbers.cached > 0) {
      prefix.prefixTokens = Math.max(prefix.prefixTokens || 0, numbers.cached);
    }
    if (!hit) this.keeper.markSent(api, key);
    const evidence = this.usageEvidence.get(key);
    if (evidence) evidence.hit = hit === true;
    return hit;
  }

  /**
   * 该给 system 打显式 cache_control 吗？（诊断/旧调用方用）
   *
   * ⚠ 2026-10-16（CACHE-PROFILE-1）：**生产决策已不再走这里** —— compose 的贴标记点改问
   *   `cache-profile.js` 的 `cacheDecisionFor()`（端点画像 + 模式 + 保温开关，带 reason）。
   *   本方法保留老语义（只看模式 + 保温开关），供自测与旧调用方；它**不认识端点画像**。
   */
  shouldMark({ mode, options, chatKey = '' } = {}) {
    void chatKey;
    return shouldMarkPrefix(mode, { keepAliveEnabled: options?.enabled === true }) === true;
  }

  /** 只读诊断：这个会话的前缀现在热不热（不影响上面的决策）。 */
  isWarm({ api, chatKey = '' } = {}) {
    return this.keeper.isWarm(api, this.now(), chatKey) === true;
  }

  /** 端点画像 —— 走注入的 `cacheProfileFor`（生产由 compose 注入 llm 的同一份），否则用本模块默认。 */
  #profileOf(api) {
    const profileFor = typeof this.helpers.cacheProfileFor === 'function'
      ? this.helpers.cacheProfileFor : defaultCacheProfileFor;
    // ★ 2026-10-17：同一有效策略（手选策略对中转也生效；auto 时与从前逐字相同）。
    const strategy = api?.cacheStrategySelected || api?.cacheStrategy || 'auto';
    try { return profileFor(api?.baseUrl, { cacheStrategy: strategy }); } catch { return null; }
  }

  /**
   * 与"贴标记点"**同一判定**：这次（画像 + 模式 + 保温开关）到底允不允许保温。
   * 以前这里只有一道"模式 ∈ adaptive|explicit"的自拼判据，与 compose 侧归一化后的模式可能不一致
   * （如配置里模式为空/非法时：贴标记按 off、链条却照排）。现在一律问 `cacheDecisionFor()`。
   */
  #decisionFor(api, options, enabled) {
    const profile = this.#profileOf(api);
    const args = {
      baseUrl: api?.baseUrl, cacheMode: options?.mode, keepAliveEnabled: enabled === true, profile,
      // ★ 2026-10-17（每厂商专属缓存策略）：保温与主请求、贴标记点**同一个有效策略**（手选策略
      //   对中转同样生效）；切策略 ⇒ 决策变了，链条立刻收手，不会继续用旧策略花钱。
      cacheStrategy: api?.cacheStrategySelected || api?.cacheStrategy || 'auto',
      // ★ 2026-10-17（400 剥标记 → 诊断闭环）：同一份四元隔离记忆，剥过的身份不打标记也不保温。
      markerStripped: (() => {
        try { return cacheMarkerStrippedOn(api)?.stripped === true; } catch { return false; }
      })()
    };
    try {
      return typeof this.helpers.cacheDecisionFor === 'function'
        ? this.helpers.cacheDecisionFor(args)
        : defaultCacheDecisionFor(args);
    } catch { return null; }
  }

  /**
   * 活配置（`optionsNow`）：热更新后 `enabled/模式/间隔/上限/安静门槛/前缀门槛` 立即生效，
   * 而不是等下一轮 compose 重排。没注入时返回排链时那份快照（行为与从前一致）。
   *
   * ★ 2026-10-16（保温热更新接线）—— 合并顺序修正：
   *   入参 `options` 是**排链快照**；`optionsNow()` 返回的是**最新原始配置**（含全局 max/quiet 与
   *   私聊专用 privateMax/privateQuiet）。原实现 `{...base, ...live}` 会让 live 的**全局原始**
   *   `maxPerChat`/`quietAfterMs` 把 `keepAliveOptionsFor(chatKey)` 已按私聊归一化的值覆盖回去
   *   （群聊吃私聊上限/私聊门槛被顶掉）。现在：**先合并最新原始配置，再按 chatKey 应用
   *   `keepAliveOptionsFor`** ⇒ 私聊仍取 `privateMaxPerChat`/`privateQuietAfterMs`（`0` 不被默认值吃掉），
   *   群聊仍取全局键；`optionsNow(): rawOptions` 的接口不变。
   *
   * 活配置读不到：`optionsNow()` 返回带 `liveError` 的对象，或读点抛异常 ⇒ **不付费**（enabled:false）
   * 并落一条 `live-config-unavailable` 诊断（`#note` + 日志），绝不退回旧快照继续烧钱。
   * 返回 `null`/非对象 = "这一棒没有活配置可读"，退回快照（旧调用方兼容缝）。
   */
  #liveOptions(chatKey, options) {
    const base = keepAliveOptionsFor(chatKey, options || {});
    if (typeof this.helpers.optionsNow !== 'function') return base;
    let live = null;
    try {
      live = this.helpers.optionsNow();
    } catch (error) {
      this.#liveConfigUnavailable(chatKey, `live-config-read-failed:${String(error?.code || error?.name || 'error')}`);
      return { ...base, enabled: false };
    }
    if (!live || typeof live !== 'object') return base;
    const merged = keepAliveOptionsFor(chatKey, { ...base, ...live });
    const liveError = typeof live.liveError === 'string' ? live.liveError.trim() : '';
    if (liveError) {
      this.#liveConfigUnavailable(chatKey, liveError);
      return { ...merged, enabled: false };
    }
    return merged;
  }

  /** 活配置不可用：只诊断 + 钱上保守（调用方把 enabled 置 false），绝不抛。 */
  #liveConfigUnavailable(chatKey, why) {
    this.#note({ phase: 'live-config-unavailable', chatKey, why });
    try { this.log('info', 'compose-keepalive-live-config-unavailable', { chatKey, why }); } catch { /* ignore */ }
  }

  /** 停掉某个会话的链（回合真正结束时、或要收工时用）。 */
  stop(chatKey, why = '') {
    const key = String(chatKey || '');
    const timer = this.timers.get(key);
    if (timer !== undefined) { try { this.clearTimer(timer); } catch { /* ignore */ } }
    this.timers.delete(key);
    if (why) this.#note({ phase: 'stop', chatKey: key, why });
    return true;
  }

  stopAll() { for (const key of [...this.timers.keys()]) this.stop(key, 'stopAll'); }

  /**
   * 回合结束后排一条保温链（老树 `#scheduleKeepAlive`）。
   *
   * @param {object} p
   * @param {object} p.api 当前 api（baseUrl/model）
   * @param {string} p.chatKey
   * @param {object} p.options `readKeepAliveOptions()` 的结果
   * @param {() => boolean} [p.isPaused]
   * @param {() => boolean} [p.isAborted]
   * @returns {{armed:boolean, reason:string, delayMs?:number}} 决策摘要（可观测、可测）
   */
  schedule({ api, chatKey = '', options, isPaused = () => false, isAborted = () => false, log: sink = null } = {}) {
    const key = String(chatKey || '');
    const say = typeof sink === 'function' ? sink : this.log;
    // ① 端点值不值得保温（画像 warm：TTL 短且官方确认续期语义；未知端点/长 TTL/未说明一律不烧钱）
    const ep = endpointHasCache(api, this.helpers);
    if (!ep.ok) {
      const why = ep.reason
        ? `该端点不保温（${ep.vendor}）：${ep.reason}`
        : '端点没有可保温的缓存机制';
      return this.#skip(key, why, say);
    }
    // ② 开关（★ 这一步就是 `api.cacheKeepAlive.enabled` 的读点）
    const opts = keepAliveOptionsFor(key, options || {});
    if (opts.enabled !== true) return this.#skip(key, '保温开关关着（api.cacheKeepAlive.enabled）', say);
    // ③ 与贴标记点同一决策（CACHE-PROFILE-1 续）：画像 + 模式 + 保温开关三者一起判 ——
    //    不再自己拼"模式 ∈ adaptive|explicit"的第二套判据（曾与归一化后的模式不一致：
    //    配置模式为空/非法时，贴标记点按 off、这里却照排付费保温）。
    const decision = this.#decisionFor(api, options, opts.enabled === true);
    if (!decision || decision.keepAlive !== true) {
      const why = decision ? `决策不允许保温：${decision.reason}` : '决策函数不可用 ⇒ 保守不保温';
      return this.#skip(key, why, say);
    }
    // ④ 有没有登记过前缀（这一轮没发过请求就没有）
    if (!this.keeper.prefixFor(api, key)) return this.#skip(key, '没有登记过前缀（这一轮没发过请求？）', say);
    // ⑤ 前缀 token 门槛（★ CACHE-PROFILE-1 收口：`api.cacheKeepAlive.minPrefixTokens` 真拦点）
    const gate = this.#prefixGate(api, key, opts);
    if (!gate.ok) return this.#skip(key, gate.reason, say);
    // ⑥ 重排：先清掉上一条链，重新计棒
    this.stop(key, '');
    this.fired.set(key, 0);
    const step = this.#tick({ api, chatKey: key, options, isPaused, isAborted, say });
    if (step.action === 'keep') this.stats.armed += 1;
    return { armed: step.action === 'keep', reason: step.reason || '', delayMs: step.delayMs };
  }

  /**
   * 前缀 token 门槛 —— 只影响**保温**，永不影响主回复。
   *
   * 口径（2026-10-16 用户裁定）：
   *   · `minPrefixTokens = 0` ⇒ 不限制；
   *   · 只用**已确认的稳定前缀 token 量**（`prefix.prefixTokens`：命中时的 cached、或冷创建时
   *     官方回报的 creation 量 —— 两者都是"这个前缀真的被缓存系统处理过"的证据）；
   *   · 数值**未知**（没有任何 usage 证据）⇒ **保守 skip 并给原因**，绝不拿整请求/动态尾部的
   *     token 数冒充前缀大小。
   */
  #prefixGate(api, chatKey, options) {
    const min = Math.max(0, Number(options?.minPrefixTokens) || 0);
    if (min <= 0) return { ok: true, reason: '' };
    const prefix = this.keeper.prefixFor(api, chatKey);
    const tokens = Number(prefix?.prefixTokens) || 0;
    if (tokens <= 0) {
      return { ok: false, reason: `前缀 token 量未知（没有 usage 证据）⇒ 保守不保温（minPrefixTokens=${min}）` };
    }
    if (tokens < min) return { ok: false, reason: `前缀太小（${tokens} < ${min}）` };
    return { ok: true, reason: '' };
  }

  #skip(chatKey, why, say) {
    this.stats.skipped += 1;
    const row = { phase: 'skip', chatKey, why };
    this.#note(row);
    try { say?.('info', 'compose-keepalive-skip', { chatKey, why }); } catch { /* ignore */ }
    return { armed: false, reason: why };
  }

  /** 一次 tick：判定 keep/stop，keep 就排下一次。老树同名逻辑（`src/orchestrator.js:4778-4806`）。 */
  #tick({ api, chatKey, options, isPaused, isAborted, say }) {
    // 活配置优先（注入 optionsNow 时）：开关/模式/间隔/上限/安静门槛/前缀门槛的热更新在下一棒就生效。
    const opts = this.#liveOptions(chatKey, options);
    if (isPaused() || isAborted()) {
      this.stats.stopped += 1;
      this.timers.delete(chatKey);
      const why = isPaused() ? '已暂停' : '已中止';
      this.#note({ phase: 'stop', chatKey, why });
      try { say?.('info', 'compose-keepalive-stop', { chatKey, why }); } catch { /* ignore */ }
      return { action: 'stop', reason: why };
    }
    const at = this.now();
    // ★ CACHE-PROFILE-1 续：tick 也重跑同一决策（热更新/中途变更时链条立刻收手，不留旧凭据空转）。
    const decision = this.#decisionFor(api, { mode: opts.mode ?? options?.mode }, opts.enabled === true);
    if (!decision || decision.keepAlive !== true) {
      const why = decision ? `决策不允许保温：${decision.reason}` : '决策函数不可用 ⇒ 保守不保温';
      this.stats.stopped += 1;
      this.timers.delete(chatKey);
      this.#note({ phase: 'stop', chatKey, why });
      try { say?.('info', 'compose-keepalive-stop', { chatKey, why }); } catch { /* ignore */ }
      return { action: 'stop', reason: why };
    }
    // ★ CACHE-PROFILE-1 收口：tick 也过同一道前缀 token 门槛 —— 前缀被重登记成"未知/太小"时
    //   立刻停链（取消旧链，失败不空转），而不是继续排下一棒。
    const gate = this.#prefixGate(api, chatKey, opts);
    if (!gate.ok) {
      this.stats.stopped += 1;
      this.timers.delete(chatKey);
      this.#note({ phase: 'stop', chatKey, why: gate.reason });
      try { say?.('info', 'compose-keepalive-stop', { chatKey, why: gate.reason }); } catch { /* ignore */ }
      return { action: 'stop', reason: gate.reason };
    }
    const lastActivityAt = this.lastActivityAt.get(chatKey) || 0;
    const step = nextKeepAliveStep({
      chainFired: this.fired.get(chatKey) || 0,
      options: opts,
      // ⚠ 传**绝对时间戳**，不是"距今多久" —— `nextKeepAliveStep` 内部自己算 `now - lastActivityAt`
      //   （老树 `src/orchestrator.js:4790` 传的是绝对值）。传成 age 会让它永远判"群已安静"。
      lastActivityAt,
      now: at,
      warm: this.keeper.isWarm(api, at, chatKey)
    });
    if (step.action !== 'keep') {
      this.stats.stopped += 1;
      this.timers.delete(chatKey);
      this.#note({ phase: 'stop', chatKey, why: step.reason || 'step≠keep' });
      try { say?.('info', 'compose-keepalive-stop', { chatKey, why: step.reason || 'step≠keep' }); } catch { /* ignore */ }
      return step;
    }
    this.#note({ phase: 'arm', chatKey, delayMs: step.delayMs });
    try { say?.('info', 'compose-keepalive-arm', { chatKey, delayMs: step.delayMs }); } catch { /* ignore */ }
    const handle = this.setTimer(() => {
      const isCurrent = () => this.timers.has(chatKey) && this.timers.get(chatKey) === handle;
      this.#fire({ api, chatKey, options, isPaused, isAborted, say, isCurrent }).finally(() => {
        if (isCurrent()) {
          this.timers.delete(chatKey);
          this.#tick({ api, chatKey, options, isPaused, isAborted, say });
        }
      });
    }, step.delayMs);
    this.timers.set(chatKey, handle);
    return step;
  }

  /** 发一棒保温请求（老树 `#keepAliveOnce`）。命中与否都记回状态机与台账。 */
  async #fire({ api, chatKey, options, isPaused, isAborted, say, isCurrent = () => true }) {
    if (!isCurrent()) return;
    const prefix = this.keeper.prefixFor(api, chatKey);
    if (!prefix?.systemText) return this.#skip(chatKey, '取不到前缀', say);
    // ★ 2026-10-16（晚到 usage 收口）：与前缀同一刻捕获**身份令牌**（system/tools/账号/模型字节快照）。
    //   send 的 await 期间主请求可能换前缀、账号池可能换号/换模型 —— 回来必须用它复核归属。
    const identity = this.prefixIdentities.get(String(chatKey)) || null;
    if (isPaused() || isAborted()) return this.#skip(chatKey, '已暂停/中止', say);
    if (typeof this.send !== 'function') return this.#skip(chatKey, '未注入 send（本实例不发真实请求）', say);
    // ★ CACHE-PROFILE-1 续：发棒前用活配置再核一次决策 —— 中途关开关/改模式 ⇒ 这一棒不发。
    const liveOpts = this.#liveOptions(chatKey, options);
    const decision = this.#decisionFor(api, { mode: liveOpts.mode ?? options?.mode }, liveOpts.enabled === true);
    if (!decision || decision.keepAlive !== true) {
      return this.#skip(chatKey, `决策不允许保温：${decision ? decision.reason : '决策函数不可用'}`, say);
    }
    // ★ 2026-10-16（保温热更新接线 · 发棒前复核）：这一棒是 timer **排定之后**才发的，
    //   排定与发棒之间可能刚改了配置（把 maxPerChat/privateMaxPerChat 设 0、调高 minPrefixTokens、
    //   调高 quietAfterMs）⇒ 发棒前把 tick 的同一组闸门再核一遍（上限 / 安静门槛 / 前缀门槛），
    //   避免"两次 tick 之间关掉/收紧，仍多烧一棒"。
    //   ⚠ 边界如实写明：闸门全在 `this.send(...)` **之前**；一旦进入 send，这条请求不可取消
    //   （本仓没有取消框架，按用户口径不新增），其失败/超时由下方既有错误路径收尾（错误即停链）。
    const firedSoFar = this.fired.get(chatKey) || 0;
    const cap = Number(liveOpts.maxPerChat);
    if (Number.isFinite(cap) && firedSoFar >= cap) {
      return this.#skip(chatKey, `发棒前复核：已达上限 ${cap} 次（热更新后）`, say);
    }
    const lastActivityAt = this.lastActivityAt.get(chatKey) || 0;
    if (!lastActivityAt || this.now() - lastActivityAt > Number(liveOpts.quietAfterMs)) {
      return this.#skip(chatKey, '发棒前复核：已安静/无活动记录（热更新后）', say);
    }
    const preSendGate = this.#prefixGate(api, chatKey, liveOpts);
    if (!preSendGate.ok) return this.#skip(chatKey, `发棒前复核：${preSendGate.reason}`, say);
    try {
      const active = typeof this.apiWith === 'function' ? this.apiWith({}) : null;
      if (active && (String(active.baseUrl || '') !== String(api?.baseUrl || '')
        || String(active.model || '') !== String(api?.model || ''))) {
        this.stop(chatKey, '端点或模型已切换');
        return;
      }
      // ★ 换账号/密钥（账号池换号也算）：缓存是**账号级隔离**的 —— 旧账号的保温凭据不带过去。
      if (active) {
        const stored = this.accountTags.get(String(chatKey || ''));
        if (stored !== undefined && stored !== accountFingerprint(active)) {
          this.stop(chatKey, '账号/密钥已切换');
          return;
        }
      }
    } catch { /* 下方发送仍由现有错误处理路径接住 */ }
    const t0 = this.now();
    let usage = null;
    try {
      const marked = endpointHasCache(api, this.helpers).marked;
      const messages = marked ? keepAliveMessages(prefix.systemText) : [
        { role: 'system', content: prefix.systemText },
        { role: 'user', content: '（缓存保温：请只回一个字）' }
      ];
      const result = await this.send({
        messages,
        tools: prefix.tools || null,
        temperature: 0,
        overrides: typeof this.apiWith === 'function' ? this.apiWith({ maxTokens: 1, disableThinking: true }) : undefined
      });
      usage = result?.usage ?? result?.raw?.usage ?? null;
      const numbers = readUsageNumbers(usage || {});
      const fired = (this.fired.get(chatKey) || 0) + 1;
      // ★ 2026-10-16（晚到 usage 收口 · 钱与证据分开）：
      //   await 回来先问"这一棒还算不算数"——timer 被换掉（新轮重排）或前缀/账号/模型被换掉
      //   （身份令牌对不上）都算晚到。**已付费的 usage 照实统计/记账**（superseded 标记），
      //   但绝不拿它给新前缀续 TTL / 写前缀 token 证据（`noteUsage(identity)` 内部复核后再落 keeper）。
      const liveApiAfter = (() => {
        try { return typeof this.apiWith === 'function' ? this.apiWith({}) : null; } catch { return null; }
      })();
      const stillCurrent = isCurrent()
        && this.#identityStillCurrent(String(chatKey), identity, { api, liveApi: liveApiAfter });
      this.stats.calls += 1;
      this.stats.promptTokens += numbers.prompt;
      this.stats.cachedTokens += numbers.cached;
      this.fired.set(chatKey, fired);
      const hit = this.noteUsage({ api, chatKey, usage, identity }) === true;
      if (!stillCurrent) {
        try {
          this.onLedger({
            kind: 'warm', chatKey, model: String(api?.model || ''), fired, hit: false, superseded: true,
            prompt: numbers.prompt, cached: numbers.cached, created: numbers.created,
            ms: this.now() - t0
          });
        } catch { /* 台账失败不许连累 */ }
        try { say?.('info', 'compose-keepalive-fire', { chatKey, fired, hit: false, superseded: true }); } catch { /* ignore */ }
        this.stop(chatKey, '本棒所属前缀/账号已被替换（usage 只记账，不续 TTL）');
        return;
      }
      if (hit) this.stats.hits += 1;
      try {
        // 行形状照 `cache-keepalive.js:336-338` 的台账契约（prompt/cached/created）——
        // 少写这三个数，`summarizeKeepAliveLedger` 的「花了几 token、命中几 token」永远是 0（假读数）。
        this.onLedger({
          kind: 'warm', chatKey, model: String(api?.model || ''), fired, hit,
          prompt: numbers.prompt, cached: numbers.cached, created: numbers.created,
          ms: this.now() - t0
        });
      } catch { /* 台账失败不许连累 */ }
      try { say?.('info', 'compose-keepalive-fire', { chatKey, fired, hit }); } catch { /* ignore */ }
      // 没命中 = 接力断了（超 TTL 或前缀变了）⇒ 停链，别继续花钱（老树同口径）
      if (!hit) this.stop(chatKey, '本棒未命中，链自停');
    } catch (error) {
      if (isCurrent()) this.stop(chatKey, `保温请求失败：${String(error?.message ?? error).slice(0, 120)}`);
    }
  }

  #note(row) {
    this.reasons.push({ ...row, at: this.now() });
    if (this.reasons.length > 100) this.reasons.shift();
  }

  /** 只读统计（给 UI / 排查；不改变任何行为）。 */
  report() {
    return {
      ...this.stats,
      chains: this.timers.size,
      fired: Object.fromEntries([...this.fired.entries()]),
      keeper: this.keeper.dump(),
      recent: this.reasons.slice(-10),
      // ★ 2026-10-16：usage 读数（含 reported* 布尔，显式 0 与未上报分开）与身份摘要。
      //   身份摘要**不带 systemText**（正文不进诊断）：只给长度/模型/账号指纹，够定位"换了哪一棒"。
      evidence: Object.fromEntries([...this.usageEvidence.entries()]),
      identities: Object.fromEntries([...this.prefixIdentities.entries()].map(([key, token]) => [key, {
        model: String(token?.model ?? ''),
        baseUrl: String(token?.baseUrl ?? ''),
        accountTag: String(token?.accountTag ?? ''),
        cacheStrategy: String(token?.cacheStrategy ?? 'auto'),
        systemChars: String(token?.systemText ?? '').length,
        toolsChars: token?.tools ? JSON.stringify(token.tools).length : 0
      }]))
    };
  }
}
