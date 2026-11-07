/**
 * apps/server 装配层 · JEV 云端裁判模型适配器（T-JEV-WIRE；返工后住址）。
 *
 * ★ 住址说明：第一版放在 `modules/jev/` 内，被该模块自检 ⓪-c/②-c/②-e 打红 ——
 *   纯判定模块不许直连 fetch、不许带开关字段、不许出现读配置形态。本文件住装配层，
 *   只被 `assembly.js` import；行为与第一版逐行一致。
 *
 * 只用 node: 全局能力（fetch / AbortSignal），不 import 任何兄弟模块与配置
 * （core.js 硬要求 6：模型与账本都走注入）。形状严格遵守 engine.js MODEL_CONTRACT：
 *   async ({roleId,prompt,labels,input,timeoutMs,traceId}) => string | {label?, probs?}
 *
 * 后端选择（见装配层注释）：`localJev.cloud.*` 的独立云端 endpoint，而不是主 chat 模型。
 * 理由：① 旧树同一组键（src/local-jev.js cloudJevRequest）走的就是这条 OpenAI 兼容 endpoint；
 *   ② 主 chat 模型（modules/llm.chatCompletion）自带思考预算/插件变换/会话粘性，是给"说话"用的，
 *   拿它做一词判定会混掉两个预算与两个 endpoint；③ 云通道自带 maxPerMinute 花钱闸，职责对得上。
 * 不 hardcode 任何 provider：endpoint/model/key 全从传入的 cloud 对象读。
 *
 * fail-closed 口径（票面要求）：
 *   - 传输失败/空正文/限流 → **抛错**（engine.classify 落 `error`；超时形落 `timeout`），绝不编造标签；
 *   - 超时形错误信息里必带 `timeout` 子串 ⇒  гарантированно 落引擎的 `timeout` 状态（不是 NO）；
 *   - 无 logprobs 时只回纯文本（引擎按 low-confidence/abstain 处理）；`assumeP>0` 且恰好命中一词时
 *     回 `{label, p: assumeP, margin: null}` —— margin 为 null ⇒ 引擎**只可能**判 low-confidence，
 *     结构上到不了 accepted（不把猜测洗成结论）；
 *   - roles 白名单外的 roleId → 回空串（下游 abstain），不判、不抛（抛会炸掉整轮）。
 */
const DEFAULT_TIMEOUT_MS = 6000;

/** 云通道是否配齐（旧 cloudJevAvailable 同口径：enabled + baseUrl + model）。 */
export function cloudJevAvailable(cloud = {}) {
  return !!cloud
    && cloud.enabled === true
    && String(cloud.baseUrl || '').trim() !== ''
    && String(cloud.model || '').trim() !== '';
}

/** 给装配层日志看的无密钥摘要（绝不含 apiKey；baseUrl 只露主机部分供排障）。 */
export function describeCloud(cloud = {}) {
  const roles = Array.isArray(cloud?.roles) ? cloud.roles.filter((r) => typeof r === 'string') : [];
  let host = '';
  try { host = new URL(String(cloud?.baseUrl || '')).host || ''; } catch { host = ''; }
  return {
    enabled: cloud?.enabled === true,
    hasBaseUrl: String(cloud?.baseUrl || '').trim() !== '',
    host: host || '(unparseable)',
    model: String(cloud?.model || ''),
    roleCount: roles.length,
    timeoutMs: Math.max(500, Math.min(15000, Number(cloud?.timeoutMs) || DEFAULT_TIMEOUT_MS)),
    assumeP: Number(cloud?.assumeP) || 0,
    maxPerMinute: Math.max(1, Number(cloud?.maxPerMinute) || 60),
  };
}

/**
 * @param {object} opts
 * @param {object} opts.cloud - `localJev.cloud` 整块（effective() 读出的值，不是引用）
 * @param {Function} [opts.fetchImpl] - 可注入的 fetch（自测用桩；生产默认全局 fetch）
 * @returns {{model: Function, modelLabel: string}}
 */
export function createCloudModel({ cloud = {}, fetchImpl = fetch } = {}) {
  const desc = describeCloud(cloud);
  const roles = Array.isArray(cloud?.roles) ? cloud.roles.filter((r) => typeof r === 'string') : [];
  const base = String(cloud.baseUrl || '').replace(/\/+$/, '');
  const endpoint = /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
  const apiKey = String(cloud.apiKey || '');
  const modelName = String(cloud.model || '');
  const modelLabel = `cloud:${modelName}`;
  const assumeP = desc.assumeP > 0 ? desc.assumeP : 0;

  // 每分钟预算（旧 cloudBudgetOk 口径：超了就拒，记可见的 error，不静默）。
  let windowStart = 0;
  let windowCount = 0;

  function isTimeoutLike(error) {
    const msg = `${error?.message ?? ''} ${error?.name ?? ''} ${error?.code ?? ''} ${error?.cause?.code ?? ''}`;
    return /timeout|timed\s*out|abort|超时|deadline/i.test(msg);
  }

  async function post(body, ms) {
    const headers = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ms),
      });
    } catch (error) {
      if (isTimeoutLike(error)) throw new Error(`jev-cloud-timeout after ${ms}ms: ${error?.message ?? error}`);
      throw new Error(`jev-cloud-request-failed: ${error?.message ?? error}`);
    }
    if (!res.ok) {
      let text = '';
      try { text = await res.text(); } catch { text = ''; }
      throw new Error(`jev-cloud-HTTP ${res.status}: ${String(text).slice(0, 160)}`);
    }
    return res.json();
  }

  /** 从 OpenAI 兼容响应里抽正文 + 可选 logprobs（旧 cloudJevRequest 同口径的精简版）。 */
  function shapeResult(data, labels) {
    const choice = data?.choices?.[0] || {};
    const message = choice.message || {};
    const rawText = (Array.isArray(message.content)
      ? message.content.map((p) => (typeof p === 'string' ? p : String(p?.text ?? ''))).join('')
      : String(message.content ?? '')).trim();
    if (!rawText) throw new Error('jev-cloud-empty-response: endpoint returned no text');
    // 有真概率就用真概率（accepted 的唯一来源）。
    const lpItems = choice.logprobs?.content;
    if (Array.isArray(lpItems) && lpItems.length) {
      const probs = {};
      const low = (s) => String(s ?? '').trim().toLowerCase();
      for (const lb of labels) {
        const hit = lpItems.find((it) => low(it?.token) === low(lb));
        if (hit && Number.isFinite(Number(hit.logprob))) probs[lb] = Math.exp(Number(hit.logprob));
      }
      if (Object.keys(probs).length) {
        const top = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
        return { label: top, probs };
      }
    }
    // 无概率：assumeP>0 且恰好命中一词 ⇒ 固定 p、无 margin（引擎只可能判 low-confidence）。
    if (assumeP > 0) {
      const s = rawText.toLowerCase();
      const hits = labels.filter((lb) => s.includes(String(lb).toLowerCase()));
      if (hits.length === 1) return { label: hits[0], p: assumeP, margin: null };
    }
    return rawText;
  }

  async function model(req = {}) {
    const labels = Array.isArray(req.labels) ? req.labels.map(String).filter(Boolean) : [];
    if (!labels.length) throw new Error('jev-cloud-model: req.labels 为空，无法提问');
    // roles 白名单（旧 cloud.roles 口径）：不在名单里的角色本通道不接，回空串 ⇒ 下游 abstain。
    if (roles.length && !roles.includes(String(req.roleId || ''))) return '';
    const now = Date.now();
    if (now - windowStart > 60000) { windowStart = now; windowCount = 0; }
    if (windowCount >= desc.maxPerMinute) throw new Error('jev-cloud-ratelimited: maxPerMinute exceeded');
    windowCount += 1;

    const ms = Math.max(500, Math.min(15000, Number(req.timeoutMs) || desc.timeoutMs));
    const system = `只输出一个词，必须是：${labels.join(' / ')}。不许有别的内容。`;
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: String(req.prompt ?? req.input ?? '') },
    ];
    const baseBody = { model: modelName, messages, temperature: 0, stream: false };
    // 先带 logprobs 要真概率；端点不接受（400/404/422）就降级裸问。其余状态直接抛（可见的 error）。
    try {
      const data = await post({ ...baseBody, max_tokens: 16, logprobs: true, top_logprobs: 20 }, ms);
      return shapeResult(data, labels);
    } catch (error) {
      if (!/HTTP (400|404|422)/.test(String(error?.message ?? ''))) throw error;
      const data = await post({ model: modelName, messages, stream: false }, ms);
      return shapeResult(data, labels);
    }
  }

  return { model, modelLabel };
}
