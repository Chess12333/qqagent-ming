/**
 * M9 jev · 提示词构造 + 模型输出解析 + 状态判定
 *
 * ★ 这里**不直连**任何推理服务（README §0 铁律 / 派单硬要求 6）：
 *   模型由 `configure({ model })` 或 `ask(..., { model })` 注入，形状见 MODEL_CONTRACT。
 *   自测用桩模型跑四档（NO / 超时 / 弃权 / 低置信），不需要真 0.8B。
 */
import { ABSTAIN_LABEL, roleOf } from './roles.js';

/**
 * 注入模型的契约（第 3 批由装配层实现：本地小模型服务或云端裁判都算）。
 *   async (req) => string | { label } | { probs } | { label, probs }
 *   req = { roleId, prompt, labels, input, timeoutMs, traceId }
 * 返回文本时本模块只取「标签词命中」，概率未知 → 一律记 'low-confidence'（未知概率不许被当成有把握）。
 */
export const MODEL_CONTRACT = 'async ({roleId,prompt,labels,input,timeoutMs,traceId}) => string | {label?, probs?}';

/** 全部可查状态（派单硬要求 5：超时/弃权/低置信各自可查）。 */
export const STATUSES = [
  'accepted',        // 标签 + 概率都过角色的门槛
  'low-confidence',  // 有标签，但 p 或 margin 未达门槛（或模型没给概率）→ **不是 NO**
  'abstain',         // 模型没给出合法标签 → **不是 NO**
  'timeout',         // 超过 budgetMs → **不是 NO**
  'error',           // 模型抛错
  'unavailable',     // 没注入模型 / 模型自报不可用
  'invalid',         // 角色 id 不认识（配了没人调、拼错都归这里，必须能被查到）
];

const TIMEOUT_HINT = /timeout|timed\s*out|abort|超时|deadline/i;

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** 输入截断：超长只留头尾（旧版 probe 同口径），并留痕 inputTruncated。 */
export function clipInput(text, maxChars) {
  const s = String(text ?? '');
  const max = clamp(Number(maxChars) || 400, 80, 2000);
  if (s.length <= max) return { text: s, truncated: false };
  const head = s.slice(0, Math.floor(max * 0.55));
  const tail = s.slice(-Math.floor(max * 0.3));
  return { text: `${head} … ${tail}`, truncated: true };
}

/** 单标签短问句：0.8B 选项越多越容易弃权/乱标（旧版注释原话），一次只问一个原子问题。 */
export function buildPrompt(role, rawInput) {
  const { text } = clipInput(rawInput, role.inputMaxChars);
  const shots = (role.examples || [])
    .map((ex) => `例：${String(ex.input).replace(/\s+/g, ' ').slice(0, 120)}\n答：${ex.label}`)
    .join('\n');
  return [
    `你是「${role.cn}」判定器，只输出一个标签词，不要解释。`,
    `问题：${role.question}`,
    `可选标签：${role.labels.join(' | ')}`,
    `什么时候问它：${role.scene}`,
    `答错的后果：${role.consequence}`,
    shots ? shots : '',
    `现在：${text}`,
    '答：',
  ].filter(Boolean).join('\n');
}

/** 把模型给出的概率归一化，并算出 top1 / p / margin。 */
function fromProbs(probs, labels) {
  const supplied = labels.filter((lb) => Object.prototype.hasOwnProperty.call(probs || {}, lb));
  const rawEntries = supplied.map((lb) => [lb, probs[lb]]);
  if (rawEntries.some(([, v]) => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
    return { label: null, p: null, margin: null, pSource: 'invalid-distribution', reason: 'malformed-probability-distribution' };
  }
  const entries = rawEntries;
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  if (entries.reduce((sum, [, value]) => sum + value, 0) === 0) {
    return { label: null, p: null, margin: null, pSource: 'invalid-distribution', reason: 'zero-mass-distribution' };
  }
  // One observed label is not a distribution. In particular, do not normalize it to p=1.
  if (entries.length === 1) return { label: entries[0][0], p: null, margin: null, pSource: 'single-label' };
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  const top = entries[0];
  const second = entries[1] ? entries[1][1] : 0;
  return {
    label: top[0],
    p: Number((top[1] / total).toFixed(4)),
    margin: Number(((top[1] - second) / total).toFixed(4)),
    pSource: 'model-distribution',
  };
}

/** 纯文本输出：只认「恰好命中一个合法标签」；命中 0 个或 2 个都算弃权（不许猜）。 */
function fromText(text, labels) {
  const s = String(text ?? '').toLowerCase();
  // Permit tokenizer whitespace/punctuation between characters of a label, while
  // requiring token boundaries so e.g. "noteworthy" is not the label "not".
  const hits = labels.filter((lb) => {
    const chars = [...String(lb).toLowerCase()].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = chars.join('[\\s\\p{P}]*');
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${pattern}(?:$|[^\\p{L}\\p{N}])`, 'u').test(s);
  });
  if (hits.length > 1) return { label: null, p: null, margin: null, pSource: 'ambiguous-label', reason: 'multiple-labels' };
  if (hits.length !== 1) return null;
  return { label: hits[0], p: null, margin: null, pSource: 'unknown' };
}

// ★★ K-1（2026-10-07）：**值域也查**。原来只查"是真有限数"，于是模型自报 `p: 5` 会
//   一路穿到 `classify` 的门槛（`5 < 0.6` 为假 ⇒ **accepted**）—— **模型可以给自己打任意高分**。
//   这与 V0 修掉的"未知不许变 0"是**镜像病**：
//     · 已修：缺失被当成 `0`（把"不知道"变成"确定不发生"）
//     · 本条：非法高分被当成"高置信"（把"胡说"变成"很确定"）
// ⇒ 原则写成一句话：**缺失、越界、非数 —— 三种都不许当有效值。**
// ⚠ **越界当"未知"（null），绝不 clamp 到 0/1**：把 `p:5` 夹成 `1.0` = "模型最高置信"，
//   那是把胡说**升级**成确定，比原病更坏。宁可当不知道。
function optionalScore(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;   // 缺失 / 非数
  if (value < 0 || value > 1) return null;                                  // 越界（p 与 margin 同口径）
  return value;
}

export function parseModelOutput(raw, labels) {
  if (raw && typeof raw === 'object') {
    if (raw.probs && typeof raw.probs === 'object') {
      const got = fromProbs(raw.probs, labels);
      if (got) return {
        ...got,
        // The local StartLux adapter derives this distribution from the option
        // letter logits. Preserve its provenance instead of downgrading it to
        // the generic "model-distribution" label.
        ...(raw.pSource === 'startlux-letter-logprob' ? { pSource: raw.pSource } : {}),
      };
    }
    if (typeof raw.label === 'string' && labels.includes(raw.label)) {
      // ★★ V1-0b（2026-10-07）**这里原来把模型真给了的 p/margin 直接丢掉**，
      //   却又把 pSource 标成 `single-label` —— 而 `single-label` 的真身是
      //   `fromProbs:77`（分布里**只喂了一个候选标签** ⇒ 没有分布可算 ⇒ p:null）。
      //   两者语义**完全不同**，混用会让读代码的人以为"这是 single-label 那种情况"。
      //   后果（回放阳性对照 `R-C-JEV-3` 由 accepted 变 low-confidence）：
      //     模型用**扁平 `{label,p,margin}`** —— 这是 **MODEL_CONTRACT 允许的形状**
      //     （`core.js:156` 的报错文本写着"期望 `{role,status,label,p,margin}`"，
      //      `compat.js:49` 的 rawTag 也按 `label|status|p|margin` 拼）
      //     —— 却被当成"未校准证据"把数值扔掉 ⇒ `classify:161` 命中 `p===null`
      //     ⇒ **永远 low-confidence**，模型说了真话也不采信。
      // ⇒ 现在**保留真数值**。缺失 / 非有限数仍然给 `null` ——
      //   **"未知不许变 0"是 V0 的功劳，不许破**（0 = "判过且概率为零"，与"不知道"是两件事）。
      const declaredP = optionalScore(raw.p);
      const declaredMargin = optionalScore(raw.margin);
      return {
        label: raw.label,
        p: declaredP,
        margin: declaredMargin,
        // ★ 新名 `model-declared`：**模型自己声明**的数（我们既没归一化、也没校准）。
        //   刻意**不用** `single-label`：那是"分布里只有一个标签"（见 fromProbs:77），语义不同。
        //   也刻意**不复用** `classify:160` 已有的 `model-supplied` 兜底名 ——
        //   那个是"**没给 pSource 时**的推断"，复用会把"本分支显式声明"与"缺字段推断"混成一个词。
        //   两个都没给（真未知）⇒ 仍是 `unknown`，与改前一致。
        pSource: (declaredP === null && declaredMargin === null) ? 'unknown' : 'model-declared',
      };
    }
    return fromText(raw.text ?? raw.content ?? '', labels);
  }
  return fromText(raw, labels);
}

/** 带 deadline 的调用：超时**不**被解释成 NO（硬要求 4）。
 *  ★ 2026-10-14（J5 取消链路）：超时即 `abort()`，`req.signal`（标准 AbortSignal）挂到请求对象上
 *    往下传——模型侧可监听 `signal.aborted` 中止工作。正常请求（不触发超时）行为不变。
 */
export async function callWithTimeout(model, req, timeoutMs) {
  const requestedMs = Number(timeoutMs) || req.roleBudgetMs || 2000;
  // ★ 2026-10-19（第五批 · 用户裁定："云裁判自定义响应"= 可调响应超时）：
  //   上限从 15000 抬到 **120000** —— 与 `localJev.judgeTimeoutMs` 的有效区间 1000..120000
  //   对齐，"填 60 秒、实际仍 15 秒"的 15s 硬顶到此取消。下界保留 100（selftest 小档
  //   与旧角色预算还在用；配置区间的下限由 core.js configure 把关）。
  //   任何**真实发生**的夹取仍随返回值带 timeoutClamped/timeoutRequestedMs 进判据行（不静默）。
  const budget = clamp(requestedMs, 100, 120000);
  // ★ 2026-10-15（云判据链核查）：这里原来是**静默夹取** —— 调用方要 20000ms 也只会拿到 15000ms，
  //   账本行里没有任何痕迹（只有 durationMs≈15003 这种"看起来像巧合"的读数）。
  //   ⇒ 把「要了多少 / 实际生效多少 / 有没有被夹」随返回值带出，由 core.structuredCall 落到行上。
  const budgetMeta = {
    requestedMs,
    budgetMs: budget,
    ...(budget !== requestedMs ? { timeoutClamped: true } : {})
  };
  const ac = new AbortController();
  let timer = null;
  const gate = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ac.abort(new DOMException(`jev-timeout ${budget}ms`, 'AbortError'));
      reject(Object.assign(new Error(`jev-timeout ${budget}ms`), { code: 'ETIMEDOUT' }));
    }, budget);
    if (typeof timer?.unref === 'function') timer.unref();
  });
  try {
    const raw = await Promise.race([Promise.resolve().then(() => model({ ...req, signal: ac.signal })), gate]);
    return { raw, ...budgetMeta };
  } catch (error) {
    return { error, ...budgetMeta };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 一次判定的完整状态判定（不改标签、不产生 allow/deny）。
 * @returns {{label:string|null, p:number|null, margin:number|null, status:string, reason?:string}}
 */
export function classify(role, parsed, error) {
  if (error) {
    const msg = `${error?.message ?? ''} ${error?.code ?? ''} ${error?.cause?.code ?? ''}`;
    return { label: null, p: null, margin: null, pSource: 'unknown', status: TIMEOUT_HINT.test(msg) ? 'timeout' : 'error', reason: String(error?.message ?? error).slice(0, 160) };
  }
  if (!parsed || !parsed.label) {
    return { label: null, p: null, margin: null, pSource: parsed?.pSource || 'unknown', status: 'abstain', ...(parsed?.reason ? { reason: parsed.reason } : {}) };
  }
  if (parsed.label === ABSTAIN_LABEL) {
    // 角色标签表里不许出现 'abstain'（selftest 有断言）；真出现了按弃权处理，绝不落成 NO。
    return { label: null, p: optionalScore(parsed.p), margin: optionalScore(parsed.margin), pSource: parsed.pSource || 'unknown', status: 'abstain' };
  }
  const p = optionalScore(parsed.p);
  const margin = optionalScore(parsed.margin);
  const pSource = parsed.pSource || (p === null ? 'unknown' : 'model-supplied');
  if (p === null || margin === null) {
    return { label: parsed.label, p, margin, pSource, status: 'low-confidence', reason: pSource === 'single-label' ? 'single-label-no-distribution' : 'model-gave-no-probabilities' };
  }
  if (p < (role.minP ?? 0.6) || margin < (role.minMargin ?? 0.1)) {
    return { label: parsed.label, p, margin, pSource, status: 'low-confidence', reason: 'below-threshold' };
  }
  return { label: parsed.label, p, margin, pSource, status: 'accepted' };
}

export { roleOf, optionalScore };
