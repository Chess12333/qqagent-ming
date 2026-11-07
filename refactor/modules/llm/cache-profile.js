/**
 * M4 · `llm/cache-profile.js` —— **Provider 缓存能力的唯一判据出口**（CACHE-PROFILE-1）
 *
 * ── 为什么单独一个文件 ─────────────────────────────────────────────────────
 * 老状况：`llm.js` 的 `supportsCacheMarkers()/isAutoCacheEndpoint()` 两张正则表 + `capability-matrix.js`
 * 又有一张"期望值快照"，再加上 compose/keep-alive-runtime 各自拼条件 —— 同一件事四处在说。
 * 本文件把**决策所需的全部事实收在一张表里**，谁要问"这个端点能不能打标记 / 有没有自动前缀缓存 /
 * 值不值得保温"，只许问 `cacheProfileFor()` / `cacheDecisionFor()`，不许各写各的正则。
 *
 * ── 三件事分别是什么（与用户 2026-10-16 裁定对齐）────────────────────────────
 *   · `explicit`：**确认**支持显式 `cache_control`（Anthropic 风格）的端点才为 true。
 *     ⇒ 官方文档没写的（未知域名、MiMo、普通中转）一律 false：**不盲发**未文档化的字段。
 *     ⇒ 唯一例外：OpenRouter 官方文档明确"透传 cache_control"，属已确认（还配 `cacheAffinityField`）。
 *   · `auto`：供应商侧**自动前缀缓存**（请求里不带任何字段）。DeepSeek / GLM / MiMo / Kimi /
 *     硅基 / MiniMax / Ark / OpenAI 官方属这一类 —— 有缓存 ≠ 要付钱续期（见 `warm`）。
 *   · `warm`：**值不值得按固定节奏主动保温（付真钱）**。只在"TTL 短 + 官方确认命中即续期 +
 *     本仓的传输形状真的能用"三者同时成立时为 true（目前只有百炼显式缓存：官方 5 分钟 TTL）。
 *     自动缓存且 TTL 长（DeepSeek 官方未承诺固定值）或未公布（GLM / MiMo）的端点 ⇒ false：
 *     **默认不做主动保温**（策略判断，不是"已测净收益为负"）。**有缓存 ≠ 要付钱续期。**
 *   · `transport`：本仓实际发送形状（恒为 OpenAI 兼容 `/chat/completions`）。baseUrl 带 `/anthropic`
 *     的路径形状 ⇒ `unsupported-path`，`explicit` 与 `warm` **同时**降级（不允许"不打标记却保温"）。
 *
 * ── 官方依据（2026-10-16 核对，用户提供链接）────────────────────────────────
 *   · 百炼上下文缓存 https://help.aliyun.com/zh/model-studio/context-cache
 *     显式缓存指南 https://www.alibabacloud.com/help/en/model-studio/explicit-cache-guide
 *     ⇒ 显式缓存 TTL 5 分钟、命中即重置；Qwen3.5+ 只支持**消息级**断点；多个 system 消息会被
 *       内部合并；同一条消息上放多个标记无效（本仓只用 1 个标记、且只认"唯一 system"形状）。
 *   · DeepSeek https://api-docs.deepseek.com/zh-cn/guides/kv_cache/
 *     ⇒ 自动前缀缓存（按 common-prefix detection，会额外落盘）；Anthropic 兼容路径忽略 cache_control。
 *       官方不承诺固定 TTL（数小时~数天量级）⇒ 不值得 4 分钟续期。
 *   · GLM/Z.AI https://docs.z.ai/guides/capabilities/cache ⇒ 自动缓存；TTL 未公布。
 *   · MiMo https://mimo.mi.com/docs/zh-CN/api/chat/openai-api
 *     ⇒ 响应里**已确认** `usage.prompt_tokens_details.cached_tokens`；全站**没有** cache_control 的
 *       声明；TTL 未找到官方说明 ⇒ `explicit:false`、`warm:false`（不推断 TTL）。
 *
 * ── 纪律 ───────────────────────────────────────────────────────────────────
 *   1. **只按 baseUrl（hostname + 路径形状）判**，不读 model 名：中转站不许凭模型名给人传厂商私参。
 *   2. 本文件是纯函数，不读配置、不发请求、不 import `llm.js`（`llm.js` 反向 import 本文件做转发，
 *      避免环）。
 *   3. 不做任何"自动探测/自动预热"：没有付费探针，也不从"带标记返回 200"推断支持（用户明令）。
 *   4. 未知端点 = 保守画像（不打标记、不保温），并给出**可定位的 reason**，不是静默。
 */

export const CACHE_PROFILE_VERSION = 1;

/** 解析 hostname（失败返回 ''）。本文件自带一份，避免与 llm.js 互相 import 成环。 */
function hostOfUrl(baseUrl) {
  try { return new URL(String(baseUrl || '')).hostname.toLowerCase(); } catch { return ''; }
}

/** 请求协议形状：本仓只发 OpenAI 兼容 `/chat/completions`；baseUrl 带 `/anthropic` 的走单独口径。 */
function protocolOfUrl(baseUrl) {
  try {
    const u = new URL(String(baseUrl || ''));
    return /\/anthropic(\/|$)/i.test(u.pathname) ? 'anthropic' : 'openai';
  } catch { return 'unknown'; }
}

/**
 * ★ 唯一厂商表。字段：
 *   · `id`/`note`     身份与一句话说明（给人看；也用来自检对账）
 *   · `probe`         该厂商的一个典型 baseUrl（只给文档/自测当样本，不参与判定）
 *   · `host`          hostname 判据（正则；**本文件是唯一来源**）
 *   · `thinking`      思考参数方言的**期望值快照**（供 capability-matrix 自检对账；真判据在 llm.js）
 *   · `affinity`      该端点要不要发会话粘性字段（真实现仍在 llm.js 的 cacheAffinityField）
 *   · `explicit`      确认支持显式 cache_control（见文件头）
 *   · `auto`          供应商侧自动前缀缓存
 *   · `warm`          值不值得付费保温（TTL 短且官方确认续期语义）
 *   · `warmWhy`       warm 的判据一句话（true/false 都要写）
 *   · `notes`         已知坑（给排查用，不参与判定）
 */
export const CACHE_VENDORS = Object.freeze([
  {
    // ★ 2026-10-16 边界收口：**只认官方模型服务域** —— 主域/地区/子域形式的 dashscope，
    //   以及官方 Model Studio 的 maas 子域（含 token-plan）。任意 OSS/自建 ECS 的
    //   `*.aliyuncs.com` 主机（oss-cn-*、ecs、bucket…）**不再**拿到 explicit/warm。
    //   官方形态依据：providers.js:18 `token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`；
    //   官方文档示例 `{WorkspaceId}.cn-beijing.maas.aliyuncs.com`、`dashscope.aliyuncs.com/compatible-mode/v1`、
    //   国际站 `dashscope-intl.aliyuncs.com`，coding/地区入口同为 dashscope 子域。
    id: 'dashscope', note: '阿里云百炼（dashscope / maas 官方模型服务域）', thinking: 'dashscope',
    probe: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    host: /(^|\.)(?:dashscope(?:-[a-z0-9-]+)?|maas)\.aliyuncs\.com$/i,
    affinity: false,
    explicit: true, auto: false, warm: true,
    warmWhy: '官方显式缓存 TTL 5 分钟、命中即重置 ⇒ 4 分钟保温在设计窗口内（官方事实 + 策略判断；不是已测净收益）',
    notes: [
      'Qwen3.5+ 只支持消息级断点；多个 system 消息会被内部合并；同一条消息多个标记无效 —— 本仓只用 1 个标记、且只认"唯一 system"形状',
      'Anthropic 兼容协议另有一套语义与路径形状；本仓只走 OpenAI 兼容 /chat/completions ⇒ 带 /anthropic 的 baseUrl 降级为"不打标记、不保温"'
    ]
  },
  {
    id: 'openrouter', note: 'OpenRouter（官方文档明确透传 cache_control；粘性路由靠 session_id/prompt_cache_key）', thinking: 'generic',
    probe: 'https://openrouter.ai/api/v1',
    host: /(^|\.)openrouter\.ai$/i,
    affinity: true,
    explicit: true, auto: false, warm: false,
    warmWhy: '透传不等于有固定 TTL（随上游 provider 变化）⇒ 默认不做主动保温（策略判断）',
    notes: ['要配合 cacheAffinityField() 发 session_id / prompt_cache_key，否则粘性路由会漂']
  },
  {
    id: 'deepseek', note: 'DeepSeek 官方', thinking: 'deepseek',
    probe: 'https://api.deepseek.com/v1',
    host: /(^|\.)deepseek\.com$/i,
    affinity: false,
    explicit: false, auto: true, warm: false,
    warmWhy: '官方为自动前缀缓存、未承诺固定 TTL（量级数小时~数天）⇒ 默认不做主动保温（策略判断；不是已测净收益）',
    notes: ['common-prefix detection（会额外落盘）；官方文档未说"改中段必 miss"', 'Anthropic 兼容路径忽略 cache_control']
  },
  {
    id: 'zhipu', note: '智谱 GLM / Z.AI', thinking: 'zhipu',
    probe: 'https://open.bigmodel.cn/api/paas/v4',
    // ★ 后缀锚定：旧写法 `bigmodel\.cn|zhipu` 是**子串**匹配，`zhipu-relay.example` 这类中转会被当成原厂；
    //   现在只认官方域（bigmodel.cn / z.ai / zhipuai.cn）。
    host: /(^|\.)bigmodel\.cn$|(^|\.)z\.ai$|(^|\.)zhipuai\.cn$/i,
    affinity: false,
    explicit: false, auto: true, warm: false,
    warmWhy: '官方为自动缓存、TTL 未公布 ⇒ 默认不做主动保温（策略判断）',
    notes: []
  },
  {
    id: 'mimo', note: '小米 MiMo', thinking: 'generic',
    probe: 'https://api.xiaomimimo.com/v1',
    host: /(^|\.)xiaomimimo\.com$/i,
    affinity: false,
    explicit: false, auto: true, warm: false,
    warmWhy: '仅确认 cached_tokens 字段；无 cache_control 声明、TTL 无官方说明 ⇒ 不打标记、默认不保温（策略判断）',
    notes: ['Anthropic 兼容响应有 cache_read_input_tokens（读取器已认），但 Anthropic 协议路径本仓不走']
  },
  {
    id: 'moonshot', note: 'Moonshot / Kimi', thinking: 'moonshot',
    probe: 'https://api.moonshot.cn/v1',
    // ★ 后缀锚定：旧写法 `moonshot|(^|\.)kimi` 会把 `kimi-api.relay.com` 这类中转当原厂。
    host: /(^|\.)moonshot\.(cn|ai)$|(^|\.)kimi\.(cn|ai)$/i,
    affinity: false,
    explicit: false, auto: true, warm: false, warmWhy: '自动缓存、TTL 未公布 ⇒ 默认不做主动保温（策略判断）', notes: []
  },
  {
    id: 'siliconflow', note: 'SiliconFlow 硅基流动', thinking: 'siliconflow',
    probe: 'https://api.siliconflow.cn/v1',
    host: /(^|\.)siliconflow\.(cn|com)$/i,
    affinity: false,
    explicit: false, auto: true, warm: false, warmWhy: '自动缓存、TTL 未公布 ⇒ 默认不做主动保温（策略判断）', notes: []
  },
  {
    id: 'minimax', note: 'MiniMax', thinking: 'generic',
    probe: 'https://api.minimax.chat/v1',
    // ★ 后缀锚定：旧写法 `minimax|minimaxi` 是子串匹配。
    host: /(^|\.)minimax\.(chat|io)$|(^|\.)minimaxi\.(com|cn|io)$/i,
    affinity: false,
    explicit: false, auto: true, warm: false, warmWhy: '被动缓存 TTL 由系统负载决定 ⇒ 不可按固定节奏续期（策略判断）', notes: []
  },
  {
    id: 'ark', note: '火山方舟 Ark', thinking: 'ark',
    probe: 'https://ark.cn-beijing.volces.com/api/v3',
    // ★ 后缀锚定：旧写法 `volces.com|volcengine|ark.cn-` 是子串匹配（`volcengine.attacker.com` 也会中）。
    host: /(^|\.)volces\.com$|(^|\.)volcengine\.com$|(^|\.)volcengineapi\.com$/i,
    affinity: false,
    explicit: false, auto: true, warm: false, warmWhy: '官方未提供 cache_control；TTL 未公布 ⇒ 默认不做主动保温（策略判断）', notes: []
  },
  {
    id: 'openai', note: 'OpenAI 官方 / 本机（LM Studio 等）', thinking: 'none',
    probe: 'https://api.openai.com/v1',
    host: /(^|\.)openai\.com$|localhost|127\.0\.0\.1|\[::1\]/i,
    affinity: false,
    // 官方自动缓存前缀 TTL 短，但那是"官方侧行为"且本仓四项优化不含它；保温维持关闭（保守）。
    explicit: false, auto: true, warm: false, warmWhy: '自动缓存且本仓不对它做主动保温（策略判断）', notes: ['本机端点既无标记也无自动缓存声明，落在下方"未知保守"口径']
  },
  {
    id: 'baidu', note: '百度千帆', thinking: 'generic',
    probe: 'https://qianfan.baidubce.com/v2',
    // ★ 后缀锚定：旧写法 `baidubce|qianfan|baidu` 是子串匹配（`baidu-proxy.example` 也会中）。
    host: /(^|\.)baidubce\.com$|(^|\.)baidu\.com$/i,
    affinity: false,
    explicit: false, auto: false, warm: false, warmWhy: '未确认显式缓存、也未确认自动前缀 ⇒ 全保守（策略判断）', notes: []
  }
]);

/** 本机端点（localhost/127.0.0.1）单独说明：不打标记、不保温。 */
function isLocalHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/** 某主机命中的厂商行；未命中返回 null（= 未知端点）。 */
export function vendorRowFor(baseUrl) {
  const host = hostOfUrl(baseUrl);
  if (!host) return null;
  return CACHE_VENDORS.find((v) => v.host.test(host)) ?? null;
}

/**
 * ★ 2026-10-17（用户裁定 · 每厂商专属缓存策略）：策略枚举/归一化的**本地副本**（本文件保持纯函数、
 * 不 import 配置层也 import 不出环）。`providers.js` 的同名归一化是配置侧出口；两边判据一致。
 *   auto / deepseek / dashscope / zhipu / mimo / compatible；空白 ⇒ auto；非法 ⇒ auto + 原因。
 */
const CACHE_STRATEGIES = new Set(['auto', 'deepseek', 'dashscope', 'zhipu', 'mimo', 'compatible']);
function normalizeStrategyOption(value) {
  const selected = String(value ?? '').trim().toLowerCase();
  if (!selected) return { effective: 'auto', selected: '', source: 'auto', reason: '' };
  if (CACHE_STRATEGIES.has(selected)) {
    return { effective: selected, selected, source: selected === 'auto' ? 'auto' : 'manual', reason: '' };
  }
  return { effective: 'auto', selected, source: 'fallback', reason: `未知 cacheStrategy '${selected}' ⇒ 安全回 auto` };
}

/**
 * 手动策略 → 能力意图。**只有官方资料确证的行为才分叉**（不确定的宁保守）：
 *   · deepseek   自动公共前缀缓存（官方 docs/guides/kv_cache）：不发 cache_control、不做付费保温
 *                （官方未承诺固定 TTL，本仓不设 5 分钟接力；也不写死 128 token / 242 字节块）
 *   · dashscope  显式缓存（官方 explicit-cache-guide）：唯一 system 消息级标记 + 短 TTL 保温
 *   · zhipu/mimo 自动缓存 + usage 读取（cached_tokens）；无 cache_control 声明、TTL 未公布
 *                ⇒ 不打标记、不保温（不编造参数/TTL）
 *   · compatible 只稳通用前缀：不发专属 cache 参数、不保温；`auto` 保持端点判据原值
 *                （**不代表**宣称厂商自动缓存被关闭）
 */
const STRATEGY_CAPABILITIES = Object.freeze({
  deepseek: { explicit: false, auto: true, warm: false,
    why: 'DeepSeek 官方为自动公共前缀缓存（无需请求参数）：不发 cache_control、不做付费保温、不写死固定块大小' },
  dashscope: { explicit: true, auto: false, warm: true,
    why: '百炼官方显式缓存：唯一 system 消息级标记 + 短 TTL（约 5 分钟、命中即续期）⇒ 可保温' },
  zhipu: { explicit: false, auto: true, warm: false,
    why: 'GLM 官方为自动缓存（TTL 未公布）：不打标记、不保温；只按已确认的 usage 读取' },
  mimo: { explicit: false, auto: true, warm: false,
    why: 'MiMo 仅确认 cached_tokens 读取；无 cache_control 声明、TTL 无官方说明 ⇒ 不打标记、不保温' },
  compatible: { explicit: false, auto: null, warm: false,
    why: 'compatible：只稳通用前缀（不发专属 cache 参数、不保温）；不声称厂商自动缓存已关闭' }
});

/** 把"手动策略"套到端点画像上（auto 不走这里；协议不支持时同样拒绝打标记/保温）。 */
function applyStrategyToProfile(base, strategy) {
  const caps = STRATEGY_CAPABILITIES[strategy.effective];
  const protocolUsable = base.protocol !== 'anthropic' && base.transport !== 'unsupported-path';
  const explicit = protocolUsable && caps.explicit === true;
  const auto = caps.auto === null ? base.auto === true : caps.auto === true;
  // ★ 2026-10-17（用户裁定）：**付费保温**额外要求端点本身也是"已确认短 TTL"（`base.warm`）——
  //   手选策略只在**中转/未验证端点上**打开"按该协议打标记"，绝不因此自动新增付费接力
  //   （未验证 TTL 的端点做 4 分钟接力可能白烧；未知兼容性也不许用探针验证）。
  const warm = protocolUsable && caps.warm === true && base.warm === true;
  const warmBlockedByEndpoint = caps.warm === true && base.warm !== true;
  const protocolNote = protocolUsable ? '' : '；但 baseUrl 是 Anthropic 兼容路径（本仓只发 OpenAI 兼容 /chat/completions）⇒ 不打标记、不保温';
  return {
    ...base,
    // 手选**不改变端点身份是否已验证**：known/endpointVendor 仍是实际探测出来的那份。
    endpointVendor: base.id,
    strategy: strategy.effective,
    strategySelected: strategy.selected || strategy.effective,
    strategySource: strategy.source,
    ...(strategy.reason ? { strategyReason: strategy.reason } : {}),
    explicit,
    auto,
    warm,
    warmReason: warm
      ? `${caps.why}；端点：${base.vendor}`
      : (warmBlockedByEndpoint
        ? `${caps.why}；但该端点未经确认短 TTL（画像 warm=false）⇒ 不保温（不对未验证端点新增付费接力）`
        : `${caps.why}${protocolNote} ⇒ 不保温`),
    reason: `手动缓存策略 '${strategy.effective}'（按该协议尝试；**未由端点验证**，known=${base.known}）：${caps.why}${protocolNote}`,
    source: 'strategy-override',
    notes: [...(base.notes || []), `cacheStrategy=${strategy.effective}（手选，按该协议尝试；端点画像本身仍是 ${base.id}）`]
  };
}

/**
 * 端点的**基础画像**（不含手动策略）：纯函数；任何异常都退化成"未知保守"，绝不抛。
 * 公开出口是 `cacheProfileFor()`（它在基础画像之上套 cacheStrategy）。
 *
 * @param {string} baseUrl
 * @returns {{
 *   version:number, host:string, protocol:'openai'|'anthropic'|'unknown',
 *   transport:'openai-compatible'|'unsupported-path'|'unknown',
 *   known:boolean, id:string, vendor:string,
 *   explicit:boolean, auto:boolean, warm:boolean,
 *   warmReason:string, reason:string, source:string, notes:string[]
 * }}
 */
function baseCacheProfileFor(baseUrl) {
  const host = hostOfUrl(baseUrl);
  const protocol = protocolOfUrl(baseUrl);
  if (!host) {
    return {
      version: CACHE_PROFILE_VERSION, host: '', protocol, transport: 'unknown',
      known: false, id: 'unknown',
      vendor: '未识别的端点（baseUrl 解析不出主机名）',
      explicit: false, auto: false, warm: false,
      warmReason: '判不了端点 ⇒ 不做主动保温（策略判断）',
      reason: 'baseUrl 解析不出主机名 ⇒ 保守：不打标记、不保温',
      source: 'unknown-default', notes: []
    };
  }
  const row = CACHE_VENDORS.find((v) => v.host.test(host)) ?? null;
  if (!row) {
    return {
      version: CACHE_PROFILE_VERSION, host, protocol, transport: protocol === 'anthropic' ? 'unsupported-path' : 'openai-compatible',
      known: false, id: 'unknown',
      vendor: '未识别的端点（保守兜底）',
      explicit: false, auto: false, warm: false,
      warmReason: '未识别端点：机制/TTL 未知 ⇒ 保守不做主动保温（策略判断）',
      reason: isLocalHost(host)
        ? '本机端点：不打标记、不保温'
        : '未达到"确认支持"标准（官方文档未说明显式缓存/自动前缀）⇒ 保守：不打标记、不保温',
      source: 'unknown-default', notes: []
    };
  }
  const anthropicPath = protocol === 'anthropic';
  // ★ 2026-10-16 收口：**本仓只发 OpenAI 兼容 `/chat/completions`**。baseUrl 带 `/anthropic`
  //   的路径形状下，显式标记语义不同（或按官方说明被忽略）、且那条传输本仓没有实现
  //   ⇒ explicit 与 warm **同时**降级，绝不出现"profile.explicit=false 却还启动付费保温"的组合。
  const protocolUsable = !anthropicPath;
  const explicit = protocolUsable && row.explicit === true;
  const warm = protocolUsable && row.warm === true;
  const warmReason = protocolUsable
    ? row.warmWhy
    : `${row.warmWhy}；但 baseUrl 是 Anthropic 兼容路径（本仓只发 OpenAI 兼容 /chat/completions）⇒ 不保温`;
  return {
    version: CACHE_PROFILE_VERSION,
    host,
    protocol,
    transport: protocolUsable ? 'openai-compatible' : 'unsupported-path',
    known: true,
    id: row.id,
    vendor: row.note,
    explicit,
    auto: row.auto === true,
    warm,
    warmReason,
    reason: anthropicPath
      ? `${row.note}：baseUrl 是 Anthropic 兼容路径（本仓只发 OpenAI 兼容 /chat/completions）⇒ 不打标记、不保温`
      : (row.explicit
        ? `${row.note}：确认支持显式 cache_control`
        : `${row.note}：${row.auto ? '自动前缀缓存' : '无确认缓存机制'}；不打标记${row.warm ? '' : '、不保温'}`),
    source: 'vendor-table',
    notes: [...(row.notes || [])]
  };
}

/**
 * ★ 2026-10-17（用户裁定 · 每厂商专属缓存策略）：**公开画像出口** —— 基础画像之上套 `cacheStrategy`。
 *
 * @param {string} baseUrl
 * @param {{cacheStrategy?: string}} [opts] 策略枚举 auto/deepseek/dashscope/zhipu/mimo/compatible
 *   · 缺省/`auto` ⇒ **逐字保持原端点判据与默认行为**（只多几个描述字段，不改任何布尔）；
 *   · 手选厂商 ⇒ 按该协议的**已知官方行为**分叉（见 `STRATEGY_CAPABILITIES`）；`known`/`endpointVendor`
 *     仍是端点实测身份（手选**不算**身份/能力已验证）；Anthropic 兼容路径照旧拒绝打标记/保温；
 *   · 非法值 ⇒ 安全回 auto 并带 `strategyReason`（`strategySource='fallback'`）。
 * @returns 基础画像字段 + `{ strategy, strategySelected, strategySource, endpointVendor, strategyReason? }`
 */
export function cacheProfileFor(baseUrl, { cacheStrategy = 'auto' } = {}) {
  const base = baseCacheProfileFor(baseUrl);
  const strategy = normalizeStrategyOption(cacheStrategy);
  if (strategy.effective === 'auto') {
    return {
      ...base,
      strategy: 'auto',
      strategySelected: strategy.selected,
      strategySource: strategy.source,
      ...(strategy.reason ? { strategyReason: strategy.reason } : {}),
      endpointVendor: base.id
    };
  }
  return applyStrategyToProfile(base, strategy);
}

/**
 * 缓存动作决策 —— **唯一决策点**（打不打标记 / 要不要保温）。
 *
 * 用户配置语义（`api.cacheMode`，四值都保留，不许被另一个布尔悄悄覆盖）：
 *   · `off`      不打标记、不保温
 *   · `implicit` 只稳前缀：不打标记、不保温
 *   · `explicit` 想打标记 —— 但**端点必须已被确认支持**（否则回隐式并给 reason，不盲发）
 *   · `adaptive` 保温开着才打标记（冷也打，因为隐式块对显式请求不可见）；保温本身仍要端点
 *               `warm:true` 且用户开关为 true
 *   非法值（含历史 `null`）⇒ 按 off 语义，并给出 reason（配置问题要看得见）。
 *
 * ★ 2026-10-17（每厂商专属缓存策略）：`cacheStrategy` 与画像**同源**——传了 profile 且它的策略与
 *   本次参数一致（或本次是 auto）就直接用，否则按 `baseUrl` + 策略现算一份（避免"主请求一套、
 *   保温另一套"）。返回对象带 `strategy/strategySelected/strategySource/endpointVendor`，
 *   供 /api/status 与出站诊断读取；`mark/keepAlive` 只表达**当前计划的决策**（不是已命中/定时器在跑）。
 *
 * @param {object} p `{ baseUrl, cacheMode, keepAliveEnabled, cacheStrategy?, profile? }`
 *   · `profile` 可选：调用方已算好的画像（例如保温链用注入画像做同一判定，避免二次/错源判定）。
 * @returns {{mode:string, mark:boolean, keepAlive:boolean, reason:string,
 *            strategy:string, strategySelected:string, strategySource:string, endpointVendor:string,
 *            profile:object, steps:Array<{step:string,value:*}>}}
 */
export function cacheDecisionFor({ baseUrl = '', cacheMode = 'adaptive', keepAliveEnabled = false,
  cacheStrategy = 'auto', markerStripped = false, profile = null } = {}) {
  const strategy = normalizeStrategyOption(cacheStrategy);
  const p = profile && typeof profile === 'object'
    && (strategy.source === 'auto' || profile.strategy === strategy.effective)
    ? profile
    : cacheProfileFor(baseUrl, { cacheStrategy: strategy.selected || strategy.effective });
  const raw = String(cacheMode ?? '').trim().toLowerCase();
  const valid = ['off', 'implicit', 'explicit', 'adaptive'].includes(raw);
  const mode = valid ? raw : 'off';
  const keepOn = keepAliveEnabled === true;
  const steps = [
    { step: '端点画像', value: `${p.known ? p.id : 'unknown'}（explicit=${p.explicit} auto=${p.auto} warm=${p.warm}）` },
    { step: 'cacheStrategy', value: `${p.strategy ?? 'auto'}（source=${p.strategySource ?? 'auto'}${p.strategySelected && p.strategySelected !== p.strategy ? `，selected=${p.strategySelected}` : ''}${p.strategyReason ? `；${p.strategyReason}` : ''}）` },
    { step: 'api.cacheMode', value: valid ? mode : `${raw || 'null'}（非法 ⇒ 按 off）` },
    { step: '保温开关', value: keepOn }
  ];
  const manualNote = p.strategySource === 'manual' ? '（手动策略，按该协议尝试；**端点未验证**）' : '';

  // ★ 2026-10-17（400 剥标记 → 诊断闭环）：该身份上标记被剥过且剥后重试成功 ⇒ 不再报"已启用"。
  //   记忆由调用方按 endpoint/账号/模型/策略 隔离后以 `markerStripped` 传入（本文件保持纯函数）。
  if (markerStripped === true) {
    return {
      mode, mark: false, keepAlive: false,
      reason: '该身份（endpoint/账号/模型/策略）上 cache_control 标记曾因 400 被剥、且剥后重试成功 ⇒ 不打标记、不保温',
      strategy: p.strategy ?? 'auto',
      strategySelected: p.strategySelected || p.strategy || 'auto',
      strategySource: p.strategySource ?? 'auto',
      ...(p.strategyReason ? { strategyReason: p.strategyReason } : {}),
      endpointVendor: p.endpointVendor ?? (p.known ? p.id : 'unknown'),
      profile: p,
      steps: [...steps, { step: '剥标记记忆', value: true }]
    };
  }

  let mark = false;
  let keepAlive = false;
  let reason = '';

  if (mode === 'off') {
    reason = valid ? "cacheMode='off'：不打标记、不保温" : `cacheMode='${raw || 'null'}' 不是合法值 ⇒ 按 off 处理（不动前缀布局）`;
  } else if (mode === 'implicit') {
    reason = "cacheMode='implicit'：只稳前缀，不发 cache_control、不保温";
  } else if (mode === 'explicit') {
    if (p.explicit) { mark = true; reason = `显式模式 + ${p.strategySource === 'manual' ? `手动策略 ${p.strategy}` : '端点已确认支持'}${manualNote} ⇒ 打标记`; }
    else reason = p.protocol === 'anthropic'
      ? `不支持该 baseUrl 形状：${p.reason}`
      : `端点不认/未确认支持显式缓存（${p.vendor}）⇒ 回隐式：不打标记（不盲发未文档化字段）`;
    if (p.warm && keepOn) { keepAlive = true; reason += '；保温开启（TTL 短、值得续期）'; }
    else if (p.warm && !keepOn) reason += '；保温开关关着';
    else reason += `；不保温（${p.warmReason}）`;
  } else {   // adaptive
    if (p.explicit) {
      mark = keepOn;
      reason = keepOn
        ? `cacheMode='adaptive' 且保温开着 ⇒ 始终打标记（冷也打：隐式块对显式请求不可见）${manualNote}`
        : "cacheMode='adaptive' 但保温关着 ⇒ 不打标记（没人续期，白打）";
    } else {
      reason = p.protocol === 'anthropic'
        ? `不支持该 baseUrl 形状：${p.reason}`
        : `端点不认/未确认支持显式标记（${p.vendor}）⇒ 不打标记，靠${p.auto ? '自动前缀缓存' : '普通前缀'}`;
    }
    if (p.warm && keepOn) { keepAlive = true; reason += '；保温开启'; }
    else if (p.warm) reason += '；保温开关关着';
    else reason += `；不保温（${p.warmReason}）`;
  }
  steps.push({ step: '最终', value: `${mark ? '打标记' : '不打标记'} / ${keepAlive ? '保温开' : '保温关'}` });
  return {
    mode, mark, keepAlive, reason,
    // ★ 2026-10-17（供 /api/status.cacheStrategyState 与出站诊断读取；不含 URL/密钥/正文）：
    //   effective = 解析到的策略；selected = 配置里那串（缺省时空）；source = auto|manual|fallback；
    //   endpointVendor = 端点实测画像身份（手选不改变它）。mark/keepAlive 只是**当前计划**的决策。
    strategy: p.strategy ?? 'auto',
    strategySelected: p.strategySelected || p.strategy || 'auto',
    strategySource: p.strategySource ?? 'auto',
    ...(p.strategyReason ? { strategyReason: p.strategyReason } : {}),
    endpointVendor: p.endpointVendor ?? (p.known ? p.id : 'unknown'),
    profile: p, steps
  };
}
