/**
 * ★ 2026-10-17（用户裁定 · 400 剥标记 → 诊断反馈闭环）：**进程内**记忆"这个身份上
 *   `cache_control` 标记被端点 400 剥过、且剥掉之后重试成功"。
 *
 * 用途：让"一边被剥离、一边报已启用"不再发生 ——
 *   · 主请求贴标记点（compose `markInitialSystemPrefix`）读到 ⇒ 不再打标记并给出原因；
 *   · 保温决策（KeepAliveChain、同一个 `cacheDecisionFor`）读到 ⇒ 不打标记也不保温
 *     （保温棒本身带标记，剥过的端点会白付一棒）。
 * 只影响**缓存计划**：不动厂商身份、模型、密钥、思考/视觉参数方言；不写任何配置。
 *
 * 隔离口径（用户裁定）：按 `endpoint(host) + 账号指纹 + 模型 + 有效 cacheStrategy` 四项联合记忆 ——
 *   一个中转/一个账号被剥过，**不会连坐**别的账号、模型或策略；换账号或换策略会重新尝试
 *   （缓存是账号级隔离的，标记兼容性也可能随策略不同）。
 * 只存指纹/种类/时间，不存 URL 全文、密钥、正文；进程重启即清空（保守：重启允许再试一次）。
 */

const MAX_ENTRIES = 64;
const entries = new Map();          // key -> { at, kinds }

function hashTag(value) {
  const s = String(value ?? '');
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;   // djb2-xor
  return h.toString(36);
}

function hostOf(baseUrl) {
  try { return new URL(String(baseUrl ?? '')).hostname.toLowerCase(); } catch { return ''; }
}

/** 联合身份键（空 host 判不出 ⇒ 返回 ''，调用方按"没记忆"处理，绝不错杀别家）。 */
export function cacheMarkerIdentity(api = {}) {
  const host = hostOf(api?.baseUrl);
  if (!host) return '';
  return [host, hashTag(api?.apiKey), String(api?.model ?? ''), String(api?.cacheStrategy ?? 'auto')].join('|');
}

/** 记一笔"标记被剥过"（只在剥掉后**重试成功**时调用；返回是否记上）。 */
export function noteCacheMarkerStripped(api = {}, kinds = []) {
  const key = cacheMarkerIdentity(api);
  if (!key) return false;
  entries.delete(key);
  entries.set(key, { at: Date.now(), kinds: Array.isArray(kinds) ? kinds.map(String) : [] });
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
  return true;
}

/** 这个身份有没有"标记被剥过"的记忆（只读；不改变任何行为）。 */
export function cacheMarkerStrippedOn(api = {}) {
  const key = cacheMarkerIdentity(api);
  const hit = key ? entries.get(key) : null;
  return hit ? { stripped: true, at: hit.at, kinds: [...hit.kinds] } : { stripped: false, at: 0, kinds: [] };
}

/** 只读快照（诊断；不含 URL/密钥/正文）。 */
export function cacheMarkerMemorySnapshot() {
  return [...entries.entries()].map(([key, row]) => ({ keyHash: hashTag(key), at: row.at, kinds: [...row.kinds] }));
}
