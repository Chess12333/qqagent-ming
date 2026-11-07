/**
 * M14 internet · 自定义搜索服务（provider）的增删查 —— **照老树 `src/app.js:2399-2498` 的形状**
 *
 * ★ 为什么这段逻辑归本模块（老树它在 `app.js` 里）：
 *   老树那 4 个端点直接手写"读 config → 改数组 → `updateConfig` → 回 200"。
 *   新树 `apps/server/**` 不是本模块的域，而这段逻辑**读写的是 `webSearch.providers`** ——
 *   那个数组的**生产者就是 `web-search.js:1151` `resolveCustomConfig`**（它按 `id` 取那一项）。
 *   ⇒ 形状定义在本模块，HTTP 适配层只该做「解析入参 / 调这里 / 转 JSON」。
 *
 * ★ 契约形状与老树**逐项一致**（ Minimax 那边照此接线即可）：
 *   · 一项 = `{ id, name, type:'openai'|'bing', baseUrl, apiKey, model, count, timeoutMs }`
 *   · `count` clamp `[1,20]`，默认 6；`timeoutMs` 下限 5000，默认 20000
 *   · **同 `baseUrl` + `type` 视为同一项**（新增即覆盖）
 *   · 掩码 `******` 或空 = **保持原 Key 不变**（老树 `:2431-2432`）
 *   · 对外一律**不回明文 Key**，只给 `hasApiKey`（老树 `:2408`）
 *   · 删除后若正选中被删的那项 ⇒ **回落 `bing`**（老树 `:2465-2469`，避免搜索直接报错）
 *
 * ★ 这些函数是**纯函数**（只吃 list、只吐新 list），不读也不写 config ——
 *   落盘由调用方的 config-store 做。这样本模块能自测、也不会在测试里写真实 `data/`。
 */

const DEFAULT_COUNT = 6;
const DEFAULT_TIMEOUT_MS = 20000;
const FALLBACK_PROVIDER = 'bing';

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function clampNumber(value, min, max, dflt) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** 只认 'bing'，其余一律 'openai'（老树 `:2418` 的写法，逐字）。 */
function normalizeType(type) {
  return str(type) === 'bing' ? 'bing' : 'openai';
}

/** 生成 provider id（老树 `:2436` 的形状：`sp_` + 时间 + 随机）。 */
function makeProviderId(now = Date.now(), rand = Math.random()) {
  return `sp_${now.toString(36)}${rand.toString(36).slice(2, 6)}`;
}

/** 把一项变成**可外发**的形状：抹掉明文 Key，换成 `hasApiKey`（老树 `:2400-2410`）。 */
export function sanitizeProvider(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    id: String(p.id ?? ''),
    name: String(p.name ?? ''),
    type: normalizeType(p.type),
    baseUrl: String(p.baseUrl ?? ''),
    model: String(p.model ?? ''),
    count: clampNumber(p.count, 1, 20, DEFAULT_COUNT),
    timeoutMs: Math.max(5000, Number(p.timeoutMs) || DEFAULT_TIMEOUT_MS),
    hasApiKey: !!str(p.apiKey)
  };
}

/** 列表（已脱敏）。UI 面板读的就是这个形状。 */
export function listProviders(list) {
  return (Array.isArray(list) ? list : []).map(sanitizeProvider).filter(Boolean);
}

/**
 * 新增 / 更新。**同 `baseUrl` + `type` 视为同一项**，覆盖其配置（老树 `:2414-2447`）。
 *
 * @param {Array} list 现有一项项数组（**原样返回，不改入参**）
 * @param {object} body 请求体 `{name,type,baseUrl,apiKey,model,count,timeoutMs}`
 * @returns {{ok:boolean, list:Array, provider:object, error?:string}}
 *   `provider` 已脱敏（`apiKey:''` + `hasApiKey`）
 */
export function upsertProvider(list, body = {}) {
  const baseUrl = str(body.baseUrl);
  const type = normalizeType(body.type);
  if (!baseUrl) return { ok: false, error: '接口地址不能为空', list: (list || []).slice(), provider: null };

  const next = [...(Array.isArray(list) ? list : [])];
  const idx = next.findIndex((p) => str(p?.baseUrl) === baseUrl && normalizeType(p?.type) === type);
  const submittedKey = str(body.apiKey);

  let entry;
  if (idx >= 0) {
    entry = { ...next[idx] };
    entry.name = str(body.name) || entry.name;
    entry.baseUrl = baseUrl;
    entry.type = type;
    entry.model = str(body.model ?? entry.model);
    entry.count = clampNumber(body.count, 1, 20, clampNumber(entry.count, 1, 20, DEFAULT_COUNT));
    entry.timeoutMs = Math.max(5000, Number(body.timeoutMs) || Number(entry.timeoutMs) || DEFAULT_TIMEOUT_MS);
    // 掩码/空 = 保持原 Key 不变（★老树 `:2431-2432` 的口径，别改成"空即清空"）
    if (submittedKey && submittedKey !== MASK) entry.apiKey = submittedKey;
    next[idx] = entry;
  } else {
    entry = {
      id: makeProviderId(),
      name: str(body.name) || baseUrl,
      type,
      baseUrl,
      apiKey: submittedKey === MASK ? '' : submittedKey,
      model: str(body.model),
      count: clampNumber(body.count, 1, 20, DEFAULT_COUNT),
      timeoutMs: Math.max(5000, Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS)
    };
    next.push(entry);
  }
  return { ok: true, list: next, provider: sanitizeProvider(entry) };
}

/** UI 回填用的掩码串（老树前端就是这么传的）。 */
export const MASK = '******';

/**
 * 删除一项（老树 `:2458-2474`）。
 * @returns {{ok:boolean, list:Array, removed:string, fallbackTo:string|null, error?:string}}
 *   `fallbackTo` 非空 ⇒ 调用方要把 `webSearch.provider` 改成它（老树 `:2465-2469`：
 *   正选中被删的那项就回落 bing，否则搜索直接报错）。
 */
export function removeProvider(list, id, currentProvider = '') {
  const sid = str(id);
  if (!sid) return { ok: false, error: '缺少 id', list: (list || []).slice(), removed: '', fallbackTo: null };
  const src = Array.isArray(list) ? list : [];
  const next = src.filter((p) => str(p?.id) !== sid);
  const removed = src.length - next.length;
  const wasSelected = str(currentProvider) === `custom:${sid}`;
  return {
    ok: true,
    list: next,
    removed: String(removed),
    // ★ 即便已经没选中也要报出来？—— 只在"确实正选中它"时报，避免调用方乱改用户当前选择。
    fallbackTo: wasSelected ? FALLBACK_PROVIDER : null
  };
}

/** 计数上限等常量导出给调用方做 UI 校验（老树是前端硬编码的，这里给出唯一真相）。 */
export const PROVIDER_LIMITS = Object.freeze({
  count: Object.freeze({ min: 1, max: 20, default: DEFAULT_COUNT }),
  timeoutMs: Object.freeze({ min: 5000, default: DEFAULT_TIMEOUT_MS }),
  fallbackProvider: FALLBACK_PROVIDER
});

/**
 * 「测试连通性」的结果形状（老树 `:2477-2498`）。
 *
 * ★ 老树刻意**不抛**：连通性测试失败也回 `ok:true`，把失败写在 `result.ok=false` + `note` 里 ——
 *   否则前端会把它当成 500，看不出到底是"服务不通"还是"我们自己的路由坏了"。
 *   这里只负责**算结果**，发不发是调用方的事。
 *
 * @param {string} providerId `'custom:<id>'` 或 null（null = 用默认单槽位）
 * @param {object} deps `{ customSearch, now }` —— `customSearch` 由**调用方从本模块的
 *   `web-search.js` 传进来**（避免这里重复实现搜索、也便于测试注入假实现）
 */
export async function testProviderConnectivity(providerId, deps = {}) {
  const startedAt = typeof deps.now === 'function' ? deps.now() : Date.now();
  const search = deps.customSearch;
  if (typeof search !== 'function') {
    return {
      ok: true,
      result: { ok: false, note: '未接入 customSearch（调用方未注入）', latencyMs: 0 }
    };
  }
  try {
    // 查询词与老树逐字一致（老树 `:2482`）：固定短语，便于各服务返回稳定的形状。
    const r = await search('qq agent 测试', str(providerId) || null);
    const results = Array.isArray(r?.results) ? r.results : [];
    const latencyMs = (typeof deps.now === 'function' ? deps.now() : Date.now()) - startedAt;
    return { ok: true, result: { ok: true, count: results.length, sample: results[0]?.title || '', latencyMs } };
  } catch (error) {
    const latencyMs = (typeof deps.now === 'function' ? deps.now() : Date.now()) - startedAt;
    return { ok: true, result: { ok: false, note: String(error?.message ?? error), latencyMs } };
  }
}
