// 自适应上下文缓存 + 缓存保温（阿里云百炼专属优化的通用实现）。
//
// ── 为什么需要它（2026-09-21 实测，号A = qwen3.8-flash，真实提示词打真接口）──
// 提示词的 token 构成（implicit/explicit 布局，人设卡在 system 里）：
//     工具定义 5,457 + system 8,760 = 14,217 tok  ← 86.8%，跨运行完全不变
//     每轮变化的 user 尾部 2,158 tok                ← 13.2%
// 也就是说 86.8% 的输入本来是可以每次都命中的，**唯一的敌人是百炼显式缓存的 5 分钟 TTL**：
// 官方文档明确"有效期 5 分钟，每次命中重置"；而 QQ 群聊的真实节奏常常是十来分钟才聊两句，
// 于是每次运行的**首次调用**都踩在过期之后。实测数据（号A 09-21，30 次运行 55 次调用）：
//     首次调用命中率 33.7%~38.3%（与模式无关）
//     第 2 次及以后 78.7%~94.4%
// 即"每轮最贵的那一次"永远按原价重算 14,217 tok 的前缀。
//
// ── 2026-09-22 补充实测：隐式块与显式块**互不可见**，所以不能"冷不打、热才打" ──
// 曾经的想法是：冷启动打标记要吃 125% 创建费（14,217×1.25+2,158 ≈ 19,929 单位），
// 不打标记交给服务端隐式缓存建（约 13,100 单位），所以"冷的时候就不打标记"。
// 但实测（同一前缀、全新 nonce 排除旧缓存）：
//     不打标记创建 → 打标记请求：**0% 命中**，还要按 125% 重建
//     打标记创建   → 打标记请求：命中
//     打标记创建   → 不打标记请求：也能命中（单向可见）
// 于是"冷不打、热再打"省下的那点创建费，下一次打标记时连本带利还回去，还白废一个隐式块。
// 线上表现就是：首次带标记那一次 hit=0（cacheMarked=是 却命中 0）。
//
// ── 所以这一版做两件事 ──
//   ① 标记策略：**只要保温开着就始终打 cache_control**（显式块自洽，保温链每次命中都续 TTL）；
//      保温关掉才退回纯隐式（不打标记）。
//   ② 保温链：命中之后按固定间隔（默认 4 分钟，小于 5 分钟 TTL）发一次 1-token 的
//      极小请求，用同一份 system+工具前缀把 TTL 一次次续上。实测 T0 建缓存 →
//      T+3.5min 保温 → T+6.6min 真实调用仍然命中 9803 tok，确认"命中即续期"成立。
//      群安静下来（超过 quietAfterMs 没新消息）就停，不白烧钱。
//
// 成本量级：一次保温 ≈ 14,217×10% ≈ 1,422 单位（约 0.0001 元），
// 而把一次冷启动首调用变成热命中，省下的是 14,217×0.8 − 1,422 ≈ 9,900 单位。**净赚约 7 倍。**
//
// ── 2026-09-22 补：保温链此前是"黑盒"，这一版把它记进台账 ──
// 问题：保温请求的 usage 不落任何台账，`[cache]` 只打 console.log（Electron 下不落盘），
// 统计只在内存（重启即失忆）。结果是"保温到底跑没跑、哪一棒没中、为什么停"事后完全查不到 ——
// 只能靠"下一次真实调用命中没中"反推，而反推不出原因。
// 现在每次保温 / 每次停链都会往 data/cache-keepalive.ndjson 追加一行（见 appendKeepAliveLedger）。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../core/config-store/index.js';

/** 显式缓存 TTL（官方文档：5 分钟，命中即重置）。 */
const PREFIX_TTL_MS = 5 * 60 * 1000;
/** 提前量：别踩在过期边界上。 */
const WARM_MARGIN_MS = 30 * 1000;
/** 小于这个命中量就当没命中（官方：缓存块最少 1024 token）。 */
const MIN_CACHE_TOKENS = 1024;

export const DEFAULT_KEEP_ALIVE = {
  enabled: true,
  intervalMs: 240000,     // 4 分钟一次（< 5 分钟 TTL）
  // 群聊覆盖 3 棒(12 分钟) → 6 棒(24 分钟)，2026-09-22 按实测重算过。
  //
  // 算法（真实间隔分布，9/21–9/22 四会话 324 次相邻运行）：
  //   一棒成本 = 前缀 15,000 × 命中价 10% ≈ 1,500 单位
  //   救回一次冷启动 = 15,000 × (1.25 重建 − 0.1 命中) ≈ 17,250 单位
  //   → 盈亏平衡 = 每棒命中 8.7%
  // 实测每棒命中率：群聊 12 分钟覆盖时 29.2%（168 棒中 49 次救回），
  // 拉到 32 分钟覆盖仍有 21.3%（334 棒中 71 次）——**远高于平衡点，值得多烧**。
  // 拉到 24 分钟（6 棒）是"多赚"与"别在没人时白烧"的折中。
  maxPerChat: 6,
  // 私聊单独放宽：一对一本来就更容易"过一会儿再回一句"，而群里沉默更常见。
  // 2026-09-21 管理员反馈：「主要是私聊，我不可能一直去触发那个保温链」——
  // 所以私聊给更长的覆盖（8 棒 ≈ 32 分钟），群里保持克制。
  // ⚠️ 同日实测：**私聊每棒命中率只有 8.1%，基本就压在 8.7% 的平衡点上**（136 棒中 11 次）。
  //    也就是说私聊这套 8 棒几乎不赚不亏，属于"为了体验买的保险"，别再往上加；
  //    真要省，砍的是私聊而不是群聊 —— 但群里那 29% 才是真金白银。
  privateMaxPerChat: 8,
  quietAfterMs: 1800000,        // 群聊：超过 30 分钟没动静就不再保温（配合 6 棒 = 24 分钟覆盖）
  privateQuietAfterMs: 1800000, // 私聊：30 分钟
  minPrefixTokens: 4096   // 前缀太小（不值得保温）就跳过
};

/** 会话是私聊吗（决定用哪套保温参数）。 */
export function isPrivateChatKey(chatKey) {
  return String(chatKey || '').startsWith('private:');
}

/**
 * 到底要不要给 system 打显式缓存标记？（2026-09-21 实验后定的规则）
 *
 * 实验（同一前缀、打乱顺序、用全新 nonce 排除旧缓存）：
 *   ① 不打标记创建 → 打标记请求：**不能命中**，且要按 125% 重新创建
 *   ② 打标记创建 → 打标记请求：能命中
 *   ③ 打标记创建 → 不打标记请求：能命中
 * 也就是说：**隐式块对显式请求不可见，反过来可以。**
 *
 * 所以"冷的时候不打标记、热了再打"是错的：省下的那点创建费，下一次打标记时连本带利还回去，
 * 还白废一个隐式块。线上表现就是首次带标记那一次 0% 命中（实测 cacheMarked=是 却 hit=0）。
 *
 * 结论：
 *   · 保温开着 → 始终打标记（显式块自洽，保温链每次命中都会把 5 分钟 TTL 续上）
 *   · 保温关掉 → 不打（纯隐式：创建免费、命中约 12.5~20%，但对稀疏流量没有续期手段）
 *   · explicit 模式 → 始终打（老行为，不带保温）
 */
export function shouldMarkPrefix(mode, { keepAliveEnabled = false } = {}) {
  const m = String(mode || '').toLowerCase();
  if (m === 'explicit') return true;
  if (m === 'adaptive') return keepAliveEnabled === true;
  return false;
}

/** 按会话类型挑保温参数（私聊：更长覆盖 + 更长的安静判定）。 */
export function keepAliveOptionsFor(chatKey, options = {}) {
  const merged = { ...DEFAULT_KEEP_ALIVE, ...(options || {}) };
  if (!isPrivateChatKey(chatKey)) return merged;
  return {
    ...merged,
    maxPerChat: Number(merged.privateMaxPerChat ?? DEFAULT_KEEP_ALIVE.privateMaxPerChat),
    quietAfterMs: Number(merged.privateQuietAfterMs ?? DEFAULT_KEEP_ALIVE.privateQuietAfterMs)
  };
}

/**
 * 缓存槽的键。
 *
 * ⚠️ 2026-09-22 修的一个真 bug：这里原来只按 `(端点, 模型)` 存**一个槽**，
 *   但被记住的 `systemText` 是**每个会话一份**的 —— 它里面带着【会话标识】
 *   （chatKey + 群号 + 机器人 QQ，见 prompt.js 的 identity 段）。
 *   于是进程里同时活跃两个群时，后一个群会把前一个群的前缀覆盖掉：
 *   保温请求带着 A 群的 system 去续 B 群要用的缓存块，台账上看到的是
 *   「两个不同群、13 秒内发出的保温请求 prompt/cached token 完全一样」（实测）。
 *   后果：保温链统计满分（157 棒全 hit），但真实首枪命中率仍然只有 66.6%，
 *   其中 28.2% 的冷首枪里有 54.1% 在 5 分钟前刚有一条「命中」的保温记录
 *   —— 本该热却报 0，就是因为续错了对象。
 *   现在把 chatKey 也编进键里：一个会话一个槽，互不覆盖。
 */
export function cacheKeyOf(api = {}, chatKey = '') {
  const base = `${String(api.baseUrl || '')}|${String(api.model || '')}`;
  const chat = String(chatKey || '').trim();
  // 兼容旧调用（不传 chatKey 时退化成"全局槽"，只用于诊断/单会话场景）
  return chat ? `${base}|${chat}` : base;
}

/**
 * 从**任意形态**的 usage 里读出三个数。
 *
 * ⚠️ 2026-09-21 踩的坑：`chatCompletion` 返回的 `usage` 是**接口原始结构**
 * （`{prompt_tokens, prompt_tokens_details:{cached_tokens, cache_creation_input_tokens}}`），
 * 不是项目里归一化后的 `{promptTokens, cachedTokens}`。我一开始只读后者，
 * 结果永远读到 0 → 状态机以为"从没命中过" → 自适应标记与保温链**全都不启动**。
 * 线上表现就是：跑了十几轮，`cacheMarked` 一直 false，命中全靠服务端隐式缓存。
 */
export function readUsageNumbers(usage = {}) {
  const u = usage || {};
  const num = (...vals) => {
    for (const v of vals) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  };
  const details = u.prompt_tokens_details || u.promptTokensDetails || u.input_tokens_details || {};
  return {
    prompt: num(u.promptTokens, u.prompt_tokens, u.input_tokens, u.inputTokens),
    cached: num(
      u.cachedTokens, u.cached_tokens, details.cached_tokens, details.cachedTokens,
      // DeepSeek 官方（自动前缀缓存）
      u.prompt_cache_hit_tokens,
      // Anthropic 协议 / 百炼 Anthropic 兼容 / 部分中转
      u.cache_read_input_tokens,
      // Responses 风格
      u.input_tokens_details?.cached_tokens
    ),
    created: num(
      u.cacheCreationTokens, u.cache_creation_input_tokens, details.cache_creation_input_tokens, details.cacheCreationInputTokens,
      // 顶层（Anthropic 兼容）
      u.cache_creation_input_tokens,
      // OpenRouter / Kimi 的写法
      u.cache_write_tokens, details.cache_write_tokens
    )
  };
}

/**
 * 缓存状态机（不碰定时器、不碰网络，纯逻辑，便于测试）。
 *
 * 用法：
 *   const k = new CacheKeeper();
 *   k.remember(api, { systemText, tools, prefixTokens });   // 每次运行开始时
 *   k.noteUsage(api, response.usage);                        // 每次调用之后
 *   if (k.shouldMark('adaptive', api)) { ...打 cache_control... }
 *   const plan = k.planChain(api, chatKey, cfg.api?.cacheKeepAlive);  // 运行结束时
 */
// 活跃 CacheKeeper 登记表（纯观测用：memory-guard 采样读各内存表条目数，见
// cacheKeeperTableStats）。存 WeakRef 而非强引用：持有方（orchestrator，全进程
// 只 new 一次且从不丢弃）之外——测试/脚本里临时创建的实例——不会被这里钉住，
// 观测可证明不产生任何保留；失效引用在统计时顺手剪掉。
const LIVE_KEEPERS = new Set();

/** 只读观测：各 CacheKeeper 实例的内存表条目数（不改任何行为）。 */
export function cacheKeeperTableStats() {
  let instances = 0, prefixes = 0, warm = 0, history = 0;
  for (const ref of LIVE_KEEPERS) {
    const k = ref.deref?.();
    if (!k) { LIVE_KEEPERS.delete(ref); continue; }   // 剪掉已失效的观测引用
    instances += 1;
    try { prefixes += k.prefixes.size; } catch { /* ignore */ }
    try { warm += k.warm.size; } catch { /* ignore */ }
    try { history += Array.isArray(k.history) ? k.history.length : 0; } catch { /* ignore */ }
  }
  return { instances, prefixes, warm, history };
}

export class CacheKeeper {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.prefixes = new Map();   // key -> { systemText, tools, prefixTokens, updatedAt }
    this.warm = new Map();       // key -> 到期时间戳
    this.history = [];           // 最近的续期/命中记录（诊断用）
    LIVE_KEEPERS.add(new WeakRef(this));   // 纯观测登记（弱引用，不影响回收），不改变任何行为
  }

  /** 记住这次运行用的稳定前缀（保温必须一字不差地复用它）。 */
  remember(api, { systemText = '', tools = null, prefixTokens = 0, chatKey = '' } = {}) {
    if (!systemText) return;
    const key = cacheKeyOf(api, chatKey);
    const prev = this.prefixes.get(key);
    // prefixTokens 只在没测到时沿用旧值
    const tokens = Number(prefixTokens) > 0 ? Number(prefixTokens) : (prev?.prefixTokens || 0);
    this.prefixes.set(key, { systemText, tools, prefixTokens: tokens, updatedAt: this.now(), chatKey: String(chatKey || '') });
  }

  /** 把一次调用的 usage 记进来：命中 ≥1024 tok 视为"前缀还热着"，续 5 分钟。 */
  noteUsage(api, usage = {}, chatKey = '') {
    const { cached } = readUsageNumbers(usage);
    const key = cacheKeyOf(api, chatKey);
    const p = this.prefixes.get(key);
    if (cached >= MIN_CACHE_TOKENS) {
      this.markSent(api, chatKey);
      if (p) p.prefixTokens = Math.max(p.prefixTokens || 0, cached);
      this.#push({ at: this.now(), key, kind: 'hit', cached });
      return true;
    }
    this.#push({ at: this.now(), key, kind: 'miss', cached });
    return false;
  }

  /**
   * 「刚刚有一次成功的调用」→ 这段前缀现在应该是在缓存里的。
   *
   * 为什么这是对的（官方文档 + 实测）：隐式/显式缓存都是**每次请求结束就把前缀存进缓存**
   * （显式还要按 125% 计费，隐式免费），有效期 5 分钟。
   * 所以"这次没命中"不等于"现在没缓存" —— 恰恰相反，没命中的这次调用自己就把缓存建好了。
   *
   * 不这么记的后果（2026-09-21 踩的坑）：保温链要求"先命中过一次"才起链，
   * 而私聊本来就很少 5 分钟内连聊 → 永远命中不了 → 链永远起不来 → 缓存永远冷。
   * 现在改成"调用过就算热"，第一次保温（4 分钟后）就能命中；万一没命中，链会自己停。
   */
  markSent(api, chatKey = '') {
    const key = cacheKeyOf(api, chatKey);
    if (!this.prefixes.has(key)) return false;   // 没有前缀可保温就不记
    this.warm.set(key, this.now() + PREFIX_TTL_MS - WARM_MARGIN_MS);
    return true;
  }

  /** 前缀现在还热吗？（决定要不要打标记、要不要继续保温） */
  isWarm(api, at = this.now(), chatKey = '') {
    return (this.warm.get(cacheKeyOf(api, chatKey)) || 0) > at;
  }

  /** 该给 system 打 cache_control 吗？ */
  shouldMark(mode, api, at = this.now(), chatKey = '') {
    const m = String(mode || '').toLowerCase();
    if (m === 'explicit') return true;                 // 老行为：始终打
    if (m === 'adaptive') return this.isWarm(api, at, chatKey); // 只用于诊断；实际决策见 shouldMarkPrefix
    return false;                                      // implicit / off：不打
  }

  /** 这个实例能保温吗（有前缀、够大、开关没关）。 */
  canKeepAlive(api, options = {}, at = this.now(), chatKey = '') {
    const cfg = { ...DEFAULT_KEEP_ALIVE, ...(options || {}) };
    if (cfg.enabled !== true) return { ok: false, reason: '未开启' };
    const key = cacheKeyOf(api, chatKey);
    const p = this.prefixes.get(key);
    if (!p?.systemText) return { ok: false, reason: '没有可复用的前缀' };
    if (!this.isWarm(api, at, chatKey)) return { ok: false, reason: '前缀已冷（先有一次成功调用才能接力）' };
    if (Number(cfg.minPrefixTokens) > 0 && (p.prefixTokens || 0) > 0 && p.prefixTokens < Number(cfg.minPrefixTokens)) {
      return { ok: false, reason: `前缀太小（${p.prefixTokens} < ${cfg.minPrefixTokens}）` };
    }
    return { ok: true, prefix: p, cfg };
  }

  /** 取前缀（保温调用用）。 */
  prefixFor(api, chatKey = '') {
    return this.prefixes.get(cacheKeyOf(api, chatKey)) || null;
  }

  /** 群安静了就清掉热身状态（下次要重新命中一次才能续）。 */
  cool(api, chatKey = '') {
    this.warm.delete(cacheKeyOf(api, chatKey));
  }

  dump() {
    return {
      prefixes: [...this.prefixes.entries()].map(([k, v]) => ({ key: k, prefixTokens: v.prefixTokens, updatedAt: v.updatedAt })),
      warm: [...this.warm.entries()].map(([k, v]) => ({ key: k, until: v })),
      recent: this.history.slice(-20)
    };
  }

  #push(row) {
    this.history.push(row);
    if (this.history.length > 200) this.history.shift();
  }
}

/**
 * 保温链的调度决策（同样不碰定时器，纯函数，便于测试）。
 * 返回接下来该做什么：'keep'（继续发保温）| 'stop'（收工）
 */
export function nextKeepAliveStep({ chainFired = 0, options = {}, lastActivityAt = 0, now = Date.now(), warm = false } = {}) {
  const cfg = { ...DEFAULT_KEEP_ALIVE, ...(options || {}) };
  if (cfg.enabled !== true) return { action: 'stop', reason: '保温未开启' };
  if (!warm) return { action: 'stop', reason: '前缀已冷，不再接力' };
  if (chainFired >= Number(cfg.maxPerChat)) return { action: 'stop', reason: `已达上限 ${cfg.maxPerChat} 次` };
  if (!lastActivityAt) return { action: 'stop', reason: '没有活动记录' };
  if (now - lastActivityAt > Number(cfg.quietAfterMs)) return { action: 'stop', reason: '群已安静' };
  return { action: 'keep', delayMs: Math.max(30000, Number(cfg.intervalMs) || DEFAULT_KEEP_ALIVE.intervalMs) };
}

/** 默认的保温请求体：同一份 system 前缀 + 一个 1 token 的占位 user。 */
export function keepAliveMessages(systemText) {
  return [
    { role: 'system', content: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }] },
    { role: 'user', content: '（缓存保温：请只回一个字）' }
  ];
}

// ── 保温台账（2026-09-22）────────────────────────────────────────────────
// 每棒保温、每次停链各写一行；只记事实，不进模型请求。
// 行形状：
//   { kind:'warm',  at, chatKey, model, fired, prompt, cached, created, hit, ms }
//   { kind:'stop',  at, chatKey, why, fired }
//   { kind:'skip',  at, chatKey, why }        （链根本没起来的原因）
//   { kind:'error', at, chatKey, why, ms }
const KA_LEDGER_FILE = path.join(DATA_DIR, 'cache-keepalive.ndjson');
const KA_KEEP_LINES = 1000;   // 超过就只留最后 1000 行
let kaAppends = 0;

/** 台账路径（给 /api/status 显示，出问题时直接去看文件）。 */
export function keepAliveLedgerPath() {
  return KA_LEDGER_FILE;
}

/** 追加一行保温台账（同步、极小；失败不影响主流程）。 */
export function appendKeepAliveLedger(row = {}) {
  try {
    fs.mkdirSync(path.dirname(KA_LEDGER_FILE), { recursive: true });
    fs.appendFileSync(KA_LEDGER_FILE, `${JSON.stringify({ ...row, at: Number(row.at) || Date.now() })}\n`, 'utf8');
    kaAppends += 1;
    if (kaAppends >= 500) { kaAppends = 0; compactKeepAliveLedger(); }
  } catch { /* 记不上不能影响保温本身 */ }
}

/** 把台账裁到最后 KA_KEEP_LINES 行（避免无限长）。 */
export function compactKeepAliveLedger(keep = KA_KEEP_LINES) {
  try {
    const lines = fs.readFileSync(KA_LEDGER_FILE, 'utf8').split('\n').filter(Boolean);
    if (lines.length <= keep) return false;
    fs.writeFileSync(KA_LEDGER_FILE, `${lines.slice(-keep).join('\n')}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 汇总台账（给 /api/status / 诊断用）。只看尾部 limit 行，零成本。
 * 返回：几棒、中几棒、花了多少 token、最近为什么停。
 */
export function summarizeKeepAliveLedger(limit = 500) {
  const out = {
    file: KA_LEDGER_FILE, rows: 0, warm: 0, warmHit: 0,
    warmPromptTokens: 0, warmCachedTokens: 0, stops: {}, skips: {}, errors: 0, last: null
  };
  let lines = [];
  try {
    lines = fs.readFileSync(KA_LEDGER_FILE, 'utf8').split('\n').filter(Boolean).slice(-limit);
  } catch {
    return out;
  }
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    out.rows += 1;
    out.last = r;
    if (r.kind === 'warm') {
      out.warm += 1;
      if (r.hit) out.warmHit += 1;
      out.warmPromptTokens += Number(r.prompt) || 0;
      out.warmCachedTokens += Number(r.cached) || 0;
    } else if (r.kind === 'stop') {
      const k = String(r.why || '未知');
      out.stops[k] = (out.stops[k] || 0) + 1;
    } else if (r.kind === 'skip') {
      const k = String(r.why || '未知');
      out.skips[k] = (out.skips[k] || 0) + 1;
    } else if (r.kind === 'error') {
      out.errors += 1;
    }
  }
  return out;
}
