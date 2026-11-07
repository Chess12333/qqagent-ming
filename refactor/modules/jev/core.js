/**
 * M9 jev · 内核：注入点 + ask + 信号 + 记账
 *
 * ★ 结构上否决不了（派单硬要求 1）：`asSignal()` / `fallback()` 产出的对象里
 *   **永远没有 `allow` 字段**，也没有 `blockedBy` —— Jev 拿不到否决权，只能递一条候选信号。
 * ★ 模型与账本都是注入的（硬要求 6）：本文件不 import 任何推理服务、不 import core/observability。
 */
import { ABSTAIN_LABEL, ROLES, ROLE_IDS, hasRole, roleOf } from './roles.js';
import { MODEL_CONTRACT, STATUSES, buildPrompt, callWithTimeout, classify, clipInput, optionalScore, parseModelOutput } from './engine.js';

export { ABSTAIN_LABEL, MODEL_CONTRACT, ROLES, ROLE_IDS, STATUSES };

// ── 注入点（装配层在启动时调用 configure）───────────────────────────────
const state = {
  model: null,        // async (req) => string | {label?, probs?}  —— 旧角色路径（ask）专用
  modelLabel: '',     // 给 UI/账本看的「用的是哪个模型」
  // ★ J1 专用槽（2026-10-12）：云三项判断与旧角色适配器**必须分开** ——
  //   旧适配器（apps/server/jev-cloud-model.js / jev-local-model.js）要求 req.labels 非空、
  //   走单词式提示词（cloud :134/:143、local :397），judgeOnce 发的是 labels:[] + §8.4 JSON 提示词，
  //   共槽必炸。按指导 §8.1/§8.5，judgeModel 应由装配绑到**对话模型的一次尝试出口**（B 线交付物）；
  //   未绑定 = judgeOnce 回 unavailable → plan 按失败规则跳过（安全降级，不回落旧概率）。
  judgeModel: null,   // async (req) => {text, requestId, actualCalls, usageState, usage, attemptReasons}
  //   ★ 最终裁定（2026-10-12）：judgeModel 直接绑 llm 的 createBudgetedJudgeModel（modules/llm/jev-adapter.js）
  //   —— 预算 reserve/settle 在适配器内部完成一次（purpose='jev'），**外层不得再包预算**（会重复执行）。
  //   失败时适配器抛 code=BUDGETED_JUDGE_REQUEST_FAILED 并保留真实 actualCalls/requestId。
  //   未绑定 = judgeOnce 回 unavailable（不发送）。req 约定：attempt='single' 必填，requestId/turnId/traceId/prompt/timeoutMs 透传。
  judgeModelLabel: '',
  ledger: null,       // (row) => void，接 core/observability 的 ledger('jev', row)
  defaultTimeoutMs: 2000,
  // ★ 2026-10-15（云判据链核查；2026-10-19 第五批改为区间语义）：`defaultTimeoutMs` 一个字段说不出四件事 ——
  //   「配置过没有 / 面板里填的是多少 / 有没有被夹 / 是不是非法值被拒了」。分开记：
  //   `defaultTimeoutConfigured` = 配过的**有效值**或"非法值被拒后按默认 5000 用"（true）；
  //   没配过（键不存在/空串）时 judge.js 保持常量默认值 2500（行为与改前一致）。
  defaultTimeoutConfigured: false,
  defaultTimeoutRequested: null,   // 面板原值（排障用；没配过 = null）
  // ★ 2026-10-19（第五批）：非法值（有限数超区间 / 非数）被拒的原值 + 原因；
  //   此时 defaultTimeoutMs 按明确默认 5000 用，行上带 timeoutConfigRejected。
  defaultTimeoutRejected: null,
  // ★ 2026-10-16（单次 token 收口）：判定的**输出**预算（= providers 侧的 max_tokens）。
  //   配置唯一出处是 `localJev.judgeMaxTokens`（装配层 configure 注入）——judge.js 用它与输入估计
  //   做**同一次请求的合计上限**（2000），这也让"界面上的判定输出预算"与真正发出去的 max_tokens 同源。
  judgeMaxTokens: 384,
  // ★ 2026-10-18（合同：可编辑裁判业务提示词）：`localJev.judgeMode.prompt` 由装配层经本注入点传入。
  //   空串/未注入 = judge.js 用内置默认业务判据（JUDGE_PROMPT，偏宽松）。
  //   非空 = 自定义业务判据。**只替换业务判据文本**：固定 JSON 输出约束（尾部始终追加）、
  //   输出字段校验、单次预算与跨群授权边界都在 judge.js 代码里，不随本值改变。
  judgePrompt: '',
  judgePromptRaw: undefined,   // 注入的原值（非串原样留痕，供排障区分"没配/配了空串"）
};

const RING_CAP = 5000;
const ring = [];      // 进程内的观测环形账（stats 的只读来源；盘上账本由注入的 ledger 负责）

/**
 * ★ 2026-10-16（J1 单次 token 收口）：一次云判定请求的**合计**硬上限（输入上界 + 输出预算）。
 *   出处：J1 用户 2026-10-14 裁定"每次云 JEV 总量不超过 2000 token"（唯一指导 §8 同口径）。
 *   它是**硬上限**，不是"约 600"的目标值——目标值只用于默认值取舍与诊断显示。
 */
export const JUDGE_TOTAL_TOKEN_CAP = 2000;

/**
 * 判定输出预算（`localJev.judgeMaxTokens`）的**合法可配置区间**。
 * 上界为什么是 1024（源码字节账，非厂商 tokenizer 计数）：
 *   固定规则 ≈ 730 utf8 字节 + 协议余量 32 + 最小动态 JSON（focus 空 + 各列表空 ≈ 118 字节）
 *   ⇒ 最小一次判定的输入上界 ≈ 880 token；`1024 + 880 = 1904 ≤ 2000` ⇒ **任何合法配置都仍放得下
 *   一次最小判定**（不会再出现"配置合法却必定不发"）。要更大输出请抬总上限（另一条裁定）。
 * 下界 128：一条 join/continue/memory 的短 JSON 远小于它，低于此值的配置没有意义。
 */
export const JUDGE_OUTPUT_MIN = 128;
export const JUDGE_OUTPUT_MAX = 1024;

/**
 * ★ 2026-10-19（第五批 · 用户裁定："云裁判自定义响应" = 可调**响应超时**）：
 *   `localJev.judgeTimeoutMs` 的**合法可配区间**与出厂默认。
 *   · 区间统一 1000..120000ms（UI 按秒输入 1..120，内部存 ms）；**不再有 15s 静默硬顶**；
 *   · 非法值（有限数但超范围 / 非数）⇒ 报可行动原因 + 按**明确默认 5000ms** 回退
 *     （拒绝事实进 timeoutState().rejected，判据行同步留痕）—— 不允许"填 60 秒、实际仍 15 秒"
 *     这种事静默发生；
 *   · 未配过（键不存在 / null / 空串）仍是老口径：configuredMs = null ⇒ judge.js 用
 *     自己的常量 JUDGE_TIMEOUT_MS = 2500 兜底（出厂配置里该键默认 5000，正常路径按 5000 走）。
 */
export const JUDGE_TIMEOUT_MIN_MS = 1000;
export const JUDGE_TIMEOUT_MAX_MS = 120000;
export const JUDGE_TIMEOUT_DEFAULT_MS = 5000;

/**
 * 注入模型与账本。**没有注入模型 = 本模块什么都不判**（status 'unavailable'），
 * 这就是「不许静态失效」的落地方式：不存在「开关开着但没人调」的第三种状态。
 */
export function configure({ model = undefined, modelLabel = undefined, judgeModel = undefined, judgeModelLabel = undefined, ledger = undefined, defaultTimeoutMs = undefined, judgeMaxTokens = undefined, judgePrompt = undefined } = {}) {
  if (model !== undefined) {
    if (model !== null && typeof model !== 'function') throw new TypeError('configure: model 必须是函数或 null');
    state.model = model;
    state.modelLabel = typeof modelLabel === 'string' ? modelLabel : '';
  }
  if (judgeModel !== undefined) {
    if (judgeModel !== null && typeof judgeModel !== 'function') throw new TypeError('configure: judgeModel 必须是函数或 null');
    state.judgeModel = judgeModel;
    state.judgeModelLabel = typeof judgeModelLabel === 'string' ? judgeModelLabel : '';
  }
  if (ledger !== undefined) {
    if (ledger !== null && typeof ledger !== 'function') throw new TypeError('configure: ledger 必须是函数或 null');
    state.ledger = ledger;
  }
  if (defaultTimeoutMs !== undefined) {
    // ★ 2026-10-19（第五批 · 云裁判响应超时）：有效区间 1000..120000ms，**不再夹到 15s**
    //   （旧行为"填 20000 实际仍 15000"的静默夹取已按用户裁定取消；"超范围不能静默发生"）。
    //   · null/空串：视为"没配过"（configured=false，判据回 2500 常量兜底）；
    //   · 有限数且在区间内：原样生效（不再有任何夹取）；
    //   · 其余（有限数超区间 / 非数）：**按明确默认 5000ms 回退** + 记 rejected{raw, reason}
    //     ⇒ judge.js 落到判据行（timeoutConfigRejected / timeoutConfigRequestedMs）。
    const n = Number(defaultTimeoutMs);
    const isBlank = defaultTimeoutMs === null || defaultTimeoutMs === '';
    const valid = !isBlank && Number.isFinite(n)
      && n >= JUDGE_TIMEOUT_MIN_MS && n <= JUDGE_TIMEOUT_MAX_MS;
    if (isBlank) {
      state.defaultTimeoutConfigured = false;
      state.defaultTimeoutRequested = null;
      state.defaultTimeoutRejected = null;
    } else if (valid) {
      state.defaultTimeoutMs = Math.floor(n);
      state.defaultTimeoutConfigured = true;
      state.defaultTimeoutRequested = n;
      state.defaultTimeoutRejected = null;
    } else {
      state.defaultTimeoutMs = JUDGE_TIMEOUT_DEFAULT_MS;
      state.defaultTimeoutConfigured = true;
      state.defaultTimeoutRequested = Number.isFinite(n) ? n : null;
      state.defaultTimeoutRejected = {
        raw: Number.isFinite(n) ? n : String(defaultTimeoutMs).slice(0, 32),
        reason: Number.isFinite(n) ? 'out-of-range' : 'not-a-number'
      };
    }
  }
  if (judgeMaxTokens !== undefined) {
    const n = Number(judgeMaxTokens);
    const valid = Number.isFinite(n) && n >= JUDGE_OUTPUT_MIN;
    // 合法区间 128..1024（见文件上方 JUDGE_OUTPUT_MAX 的字节账）；非法/未配过就保持 384，但**留下原值**，
    // 让 UI/诊断能说清"你填的是 X，实际按 Y 用"（不静默违背用户设置）。
    state.judgeMaxTokensRaw = judgeMaxTokens;
    state.judgeMaxTokensValid = valid;
    state.judgeMaxTokens = valid ? Math.min(JUDGE_OUTPUT_MAX, Math.floor(n)) : 384;
  }
  if (judgePrompt !== undefined) {
    // 只认字符串；其它类型按"没配"处理（trim 后空串 = 内置默认）。长度上限在 judge.js 的
    // renderJudgePrompt 里按 utf8 字节夹取并留痕（预算守门不许被自定义文本绕开）。
    state.judgePromptRaw = judgePrompt;
    state.judgePrompt = typeof judgePrompt === 'string' ? judgePrompt.trim() : '';
  }
  return { modelBound: !!state.model, judgeModelBound: !!state.judgeModel, ledgerBound: !!state.ledger, defaultTimeoutMs: state.defaultTimeoutMs, judgeMaxTokens: state.judgeMaxTokens };
}

/**
 * ★ 2026-10-18（合同：可编辑裁判业务提示词）：judge.js 的读取口径（也是排障口径）。
 *   `prompt` = 当前生效的**业务判据**（空串 = 未配置自定义，用内置默认）；
 *   `rawProvided` = 注入过的原值形态（undefined = 从未注入；'' = 注入过空串；'xxx' = 自定义文本）。
 */
export function judgePromptState() {
  return {
    prompt: state.judgePrompt || '',
    isCustom: !!(state.judgePrompt && state.judgePrompt.length),
    rawProvided: state.judgePromptRaw
  };
}

/**
 * 面板键口径（judge.js 用，也是排障口径）：
 *   `configuredMs`：**有效配置**才给值（没配过 = null，调用方保持自己的常量默认 2500，
 *     这样"没接线"与"配了空"都不会把判据预算悄悄改成 core 的兜底值）；
 *   `requestedMs`：面板原值（没配过 = null）；
 *   `rejected`：非法值被拒时的 `{raw, reason}`（'out-of-range' | 'not-a-number'）——
 *     此时 configuredMs 是**明确默认 5000**，判据行带 timeoutConfigRejected 说明
 *     "填的是 X、为什么没生效、实际按 5000 用"（2026-10-19 第五批：不再有 15s 静默硬顶）。
 */
export function timeoutState() {
  return {
    configuredMs: state.defaultTimeoutConfigured ? state.defaultTimeoutMs : null,
    requestedMs: state.defaultTimeoutRequested,
    ...(state.defaultTimeoutRejected ? { rejected: { ...state.defaultTimeoutRejected } } : {})
  };
}

export function isModelBound() { return !!state.model; }
export function isJudgeModelBound() { return !!state.judgeModel; }
export function isLedgerBound() { return !!state.ledger; }

/**
 * 判定的单次 token 预算（judge.js 的守门口径 + 排障口径）：
 *   · `outputTokens` = 发出去的真实 max_tokens（= `localJev.judgeMaxTokens`，装配层注入，非法/缺失回 384）；
 *   · `totalCapTokens` = 单次请求的合计硬上限（**输入上界 + 输出预算**），J1 用户裁定 2000；
 *   · `inputTokensCap` = 输入允许占用的上限（totalCap − outputTokens；**≤0 = 连最小输入都放不下 ⇒ 不发**）；
 *   · `configuredRaw` / `valid` = 用户填的原值与是否合法（UI 可据此说明"填了 X、按 Y 用"）。
 * ⚠ 输入侧的上界由 judge.js 的 `upperBoundTokens`（utf8 字节 + 协议余量）负责——这里只说预算数字。
 */
export function judgeBudgetState() {
  const raw = state.judgeMaxTokensRaw;
  const outputTokens = Number.isFinite(Number(state.judgeMaxTokens)) && Number(state.judgeMaxTokens) >= JUDGE_OUTPUT_MIN
    ? Math.min(JUDGE_OUTPUT_MAX, Math.floor(Number(state.judgeMaxTokens))) : 384;
  const totalCapTokens = Number.isFinite(Number(JUDGE_TOTAL_TOKEN_CAP)) ? JUDGE_TOTAL_TOKEN_CAP : 2000;
  return {
    outputTokens,
    totalCapTokens,
    inputTokensCap: totalCapTokens - outputTokens,
    configuredRaw: raw === undefined ? null : raw,
    valid: state.judgeMaxTokensValid === true,
    clamped: state.judgeMaxTokensValid === true && Number(raw) !== outputTokens,
    outputMinTokens: JUDGE_OUTPUT_MIN,
    outputMaxTokens: JUDGE_OUTPUT_MAX
  };
}

/** 只读账本（测试/排障用）。 */
export function observationRows({ n = 200 } = {}) {
  const cap = Math.max(1, Math.min(RING_CAP, Math.floor(Number(n) || 200)));
  return ring.slice(-cap).map((r) => ({ ...r }));
}

/** 写账本：role 由 ask() 保证是真实角色 id（未知角色在 ask 里直接落 status='invalid'）。 */
function record(row) {
  const clean = { ...row };
  if (!STATUSES.includes(clean.status)) clean.status = 'error';
  ring.push(clean);
  if (ring.length > RING_CAP) ring.shift();
  if (state.ledger) {
    try { state.ledger(clean); } catch { /* 账本写入失败不许冒到主链（README §3.3 不变量） */ }
  }
  return clean;
}

function numOrNull(v) { return typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(4)) : null; }

/**
 * 问一个角色一次。
 * @param {string} roleId  ROLES 里的 id
 * @param {string|{text?:string, [k:string]:any}} input 待判的一句话/一小段
 * @param {{timeoutMs?:number, traceId?:string, model?:Function|null, chatKey?:string, roundId?:string}} opts
 *   `model: null` = 这一次调用当作「没有模型」用（测 unavailable 用），不是「回退到默认」。
 * @returns {Promise<{role:string,label:string|null,p:number|null,margin:number|null,status:string,ms:number,reason?:string,traceId?:string}>}
 */
export async function ask(roleId, input, opts = {}) {
  const started = Date.now();
  const role = roleOf(roleId);
  const traceId = typeof opts.traceId === 'string' && opts.traceId ? opts.traceId.slice(0, 160) : undefined;
  const text = typeof input === 'string' ? input : String(input?.text ?? '');

  if (!role) {
    const row = {
      at: started, role: String(roleId ?? '').slice(0, 48), status: 'invalid', label: null,
      p: null, margin: null, ms: 0, inputChars: text.length, reason: 'unknown-role', ...(traceId ? { traceId } : {}),
    };
    record(row);
    return { ...row };
  }

  const model = opts.model === null ? null : (typeof opts.model === 'function' ? opts.model : state.model);
  if (!model) {
    const row = {
      at: started, role: role.id, status: 'unavailable', label: null, p: null, margin: null,
      ms: 0, inputChars: text.length, reason: 'model-not-injected', ...(traceId ? { traceId } : {}),
    };
    record(row);
    return { ...row };
  }

  const clipped = clipInput(text, role.inputMaxChars);
  const timeoutMs = Number(opts.timeoutMs) || role.budgetMs || state.defaultTimeoutMs;
  const req = { roleId: role.id, prompt: buildPrompt(role, clipped.text), labels: role.labels.slice(), input: clipped.text, timeoutMs, traceId };

  const { raw, error } = await callWithTimeout(model, req, timeoutMs);
  const parsed = error ? null : parseModelOutput(raw, role.labels);
  const verdict = classify(role, parsed, error);
  const ms = Math.max(0, Date.now() - started);

  const row = {
    at: started, role: role.id, status: verdict.status, label: verdict.label,
    p: numOrNull(verdict.p), margin: numOrNull(verdict.margin), pSource: verdict.pSource || (verdict.p === null ? 'unknown' : 'model-supplied'),
    positive: verdict.label ? verdict.label === role.positive : null,
    ms, inputChars: text.length, inputTruncated: clipped.truncated,
    model: state.modelLabel || undefined,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    ...(traceId ? { traceId } : {}),
  };
  record(row);
  return { ...row };
}

/** 只有这两档「语义判成了」的状态会产出信号（其余 STATUSES 一律 null = 认识形状但这档不产信号）。 */
export const SEMANTIC_STATUSES = ['accepted', 'low-confidence'];

/**
 * 「**技术未判定**」状态（裁定 4）：这些一律不是语义低意愿，上层不许当否决。
 * 与「语义低意愿」的分界就在 `asSignal()`：技术未判定 → `null`（不产出任何带标签的信号）。
 * 旧版还有一个 `filtered`（`replyChanceGate` 的规则预过滤短路）—— 新架构里预过滤属**硬规则**、归 M8，
 * **jev 不产 `filtered`**；它也不在本模块的状态词表里 ⇒ 谁把它塞进 `asSignal()` 就是接错了，直接抛（裁定：null 不许身兼二职）。
 */
export const TECHNICAL_STATUSES = ['abstain', 'timeout', 'error', 'unavailable', 'invalid'];

/** 这一次判定是「技术上没判成」还是「语义低意愿/判成了」？（给 M8 的分诊口） */
export function isTechnical(result) {
  return !result || TECHNICAL_STATUSES.includes(result.status);
}

export function isSemantic(result) {
  return !!result && SEMANTIC_STATUSES.includes(result.status);
}

/** §3.7 误用的样子长这样：把整个调用上下文塞进 asSignal。认出来就把正确写法写进报错里。 */
function looksLikeDispatchShaped(input) {
  return ['plan', 'evidence', 'context', 'cfg'].some((k) => k in input);
}

function unrecognized(input, why) {
  const keys = input && typeof input === 'object' && !Array.isArray(input)
    ? Object.keys(input).slice(0, 8).join(',') : typeof input;
  const hint = input && typeof input === 'object' && looksLikeDispatchShaped(input)
    ? ' 看起来是按旧 §3.7 的 `asSignal({plan,evidence,context,cfg})` 在调 —— 正确写法是两段式：'
      + '`const r = await jev.ask(roleId, text); const sig = jev.asSignal(r);`（sig 为 null 表示这一档不产信号，抛错表示接错了）'
    : '';
  return new TypeError(`jev.asSignal: 不认识的输入形状 —— ${why}（收到 keys=[${keys}]）。`
    + `期望 ask() 的返回 {role,status,label,p,margin}。`
    + '本函数**故意不静默返 null**：null 是「有这次判定、但这档不产信号」的值，不是「没接上」的错误标记。' + hint);
}

/**
 * 结果 → `Verdict.signals` 里的一项。保留 status，便于 `evaluateRoles()` 调用方
 * 区分 accepted / low-confidence，同时继续传递真实 p 与来源。
 * **没有 allow / 没有 blockedBy**：结构上就否决不了。
 * 三种出口分得很清楚（2026-10-04 裁定）：
 *   ① 不认识的形状（null / 非对象 / 缺 role 或 status / status 不在 STATUSES 词表里 / accepted 却无标签）
 *      ⇒ **抛 TypeError**。「没接上」必须比「没信号」更响，否则整段 Jev 静默失效没人发现。
 *   ② 认识形状、但这档状态不产信号（abstain / timeout / error / unavailable / invalid / 伪造状态白名单外的合法值…）
 *      ⇒ **返回 null**（= 不产出信号，也就永远产不出 NO）。
 *   ③ 认识形状且判成了（accepted / low-confidence）⇒ 返回信号；**低置信照样给信号**，带低 p/margin 让唯一决定点自己权衡。
 */
export function asSignal(input) {
  if (input === null || input === undefined) throw unrecognized(input, '收到 null/undefined');
  if (typeof input !== 'object' || Array.isArray(input)) throw unrecognized(input, `期望对象，得到 ${typeof input}`);
  if (typeof input.role !== 'string' || !input.role) throw unrecognized(input, '缺非字符串的 role 字段（账本要对不上号了）');
  if (typeof input.status !== 'string' || !input.status) throw unrecognized(input, '缺 status 字段 —— 这不是 ask() 的返回');
  if (!STATUSES.includes(input.status)) throw unrecognized(input, `status "${input.status}" 不在 jev 的状态词表里`);
  if (!SEMANTIC_STATUSES.includes(input.status)) return null;
  if (typeof input.label !== 'string' || !input.label) throw unrecognized(input, `${input.status} 却没有 label（判定结果被中途改坏了）`);
  const signal = { from: 'jev', role: String(input.role), status: input.status };
  signal.label = input.label;
  // ★★ K-2（2026-10-07）：`p`/`margin` 走**与 engine 同一套**"缺失/越界/非数 ⇒ 未知"口径。
  //   改前这里是**独立写的第二份实现**（只查 `typeof==='number' && isFinite`，**不查值域**）
  //   ⇒ 模型自报 `p:5` 会**原样透传进 signal**，把 K-1 在 `engine` 那层的修复**整个绕过去**。
  //   ⇒ 现在**直接复用 `engine.js` 的 `optionalScore`**（唯一实现，本文件顶部已 import）：
  //     绝不维护第二份 —— 两份口径迟早漂移，而漂移的那一份没人看。
  //   ★ 语义保持不变的那一点（很重要）：**未知时字段"不存在"**，而不是写 `p:null`。
  //     这正是 `orchestrator/index.js:369` 那个 `0.75` 兜底还能生效的唯一原因
  //     （`Number(undefined)=NaN` 不可达夹取分支；`Number(null)=0` 会静默变 p=0）。
  //     ⇒ 这里**必须**继续"不写字段"，改成 `p:null` 会把那处死兜底变成活 bug。
  const declaredP = optionalScore(input.p);
  const declaredMargin = optionalScore(input.margin);
  if (declaredP !== null) signal.p = declaredP;
  if (declaredMargin !== null) signal.margin = declaredMargin;
  // ★ 同理修正 pSource 的兜底：改前写的是
  //   `input.p === null || undefined ? 'unknown' : 'model-supplied'`
  //   ⇒ `p:5`（越界、已被拒）会得到 **`model-supplied`**，可 `signal.p` 根本不存在
  //   —— **元数据说谎**（说"模型给了数"，而实际上一个数都没留下）。
  //   ⇒ 判据改成"**最终真的留下了合法值**"，与字段口径同源。
  signal.pSource = typeof input.pSource === 'string' && input.pSource
    ? input.pSource
    : (declaredP !== null || declaredMargin !== null ? 'model-supplied' : 'unknown');
  return signal;
}

/**
 * 保守回退信号（超时/弃权/不可用时给决定点看「这一路没人给出过判断」）。
 * @param {string} roleId  必须是真的角色 id —— 传错直接抛，绝不落一条对不上号的账（硬要求 5）
 * @param {string} reason  'timeout' | 'abstain' | 'unavailable' | 'error' | 'low-confidence'
 */
export function fallback(roleId, reason = 'unavailable') {
  if (!hasRole(roleId)) {
    throw new TypeError(`fallback: 角色 "${roleId}" 不在 ROLES 表里（新架构不许给账本留一条对不上号的信号）`);
  }
  return { from: 'jev', role: String(roleId), label: ABSTAIN_LABEL, pSource: 'unknown', reason: String(reason ?? '') };
}

/** 把若干 ask 结果收进一条 Verdict（**只是聚合工具**：allow 由调用方决定，本模块永远传 false 都轮不到 jev 说了算）。
 *  数组里混进非 ask 返回（null / 别的形状）会**照抛** —— 聚合工具不是兜错的地方。 */
export function signalsFor(results) {
  const list = (Array.isArray(results) ? results : [results]).map(asSignal).filter(Boolean);
  return list;
}

/**
 * 按需角色请求（派单 2：不再盲目双问，无信号 ≠ NO）。
 * 调用方给出角色列表，只评估这些角色；技术未判定/不产信号直接跳过，绝不伪造 NO。
 */
export async function evaluateRoles(roleIds, input, opts = {}) {
  const list = Array.isArray(roleIds) ? roleIds : [roleIds];
  const signals = [];
  for (const roleId of list) {
    const res = await ask(roleId, input, opts);
    const sig = asSignal(res);
    if (sig) signals.push(sig);
  }
  return signals;
}

/**
 * 只读统计（给 UI）：各角色调用与状态。
 * `uncalledRoles` = 本进程里从没被调用过的角色 —— 静态死角色闸（硬要求 2）的运行时补充。
 */
export function stats({ n = RING_CAP } = {}) {
  const rows = observationRows({ n });
  const byRole = {};
  for (const id of ROLE_IDS) {
    byRole[id] = {
      cn: ROLES[id].cn, calls: 0, accepted: 0, 'low-confidence': 0, abstain: 0,
      timeout: 0, error: 0, unavailable: 0, invalid: 0, positive: 0, negative: 0,
      avgMs: 0, sumMs: 0, lastStatus: null, lastAt: null,
    };
  }
  const unknownRoles = {};
  for (const row of rows) {
    const b = byRole[row.role];
    if (!b) { unknownRoles[row.role] = (unknownRoles[row.role] || 0) + 1; continue; }
    b.calls += 1;
    if (STATUSES.includes(row.status)) b[row.status] += 1; else b.invalid += 1;
    if (row.positive === true) b.positive += 1;
    if (row.positive === false) b.negative += 1;
    b.sumMs += Number(row.ms) || 0;
    b.lastStatus = row.status;
    b.lastAt = row.at;
  }
  for (const b of Object.values(byRole)) {
    b.avgMs = b.calls ? Math.round(b.sumMs / b.calls) : 0;
    delete b.sumMs;
  }
  return {
    ok: true,
    rows: rows.length,
    modelBound: isModelBound(),
    ledgerBound: isLedgerBound(),
    model: state.modelLabel || null,
    byRole,
    uncalledRoles: ROLE_IDS.filter((id) => byRole[id].calls === 0),
    unknownRoles,
    totalCalls: rows.length,
  };
}

/** 测试用：丢弃进程内环形账（不动注入的配置）。 */
export function resetObservations() {
  ring.length = 0;
  return { ok: true };
}

// ── J1 结构化单请求底层（云 JEV 三项判断专用；2026-10-12 指导 §8.3/§8.4）──
// 与 ask() 共用同一个注入模型、超时与账本；**不走角色表**（join/continue/memory 不是 ROLES 成员）。
// transport 成功时**不记账** —— 最终状态（含 JSON 解析结果）由 judge.js 组装后一次记入，
// 避免"先记 accepted 再记 invalid"的两行假账。每调用 = 一次 model()（§8.3：每批至多一次网络请求）。

/**
 * @param {{prompt:string, timeoutMs?:number, traceId?:string, turnId?:string, model?:Function|null}} opts
 *   `model: null` = 本次按"没有模型"处理（测 unavailable 用）；`model` 函数 = **显式测试通道**（绕过适配器，仅测试）。
 *   `turnId` 透传给适配器进 budgetRequest；`traceId` 由适配器映射为 sourceId。
 * @returns {Promise<{transport:'ok'|'timeout'|'error'|'unavailable', status:string, raw:any, error:any, ms:number,
 *   reason?:string, model:string, requestId?:string, actualCalls?:number, usageState?:string, traceId?:string}>}
 *   ＋ 失败分档 `failureKind` / `httpStatus`（见下方 classifyJudgeFailure）+ 诊断 endpointStyle /
 *   providerHost / thinkingApplied / maxTokens（成功在 `raw`，失败 attach 在 `error` 上带出来）。
 */
/**
 * 判定失败分档（2026-10-16 收口）——把"云判定未完成"从一句笼统原因拆成可核验的种类：
 *   预算口令（core/budget 的**精确**拒绝码）/ HTTP 状态（401·403·404·429·5xx）/ 超时 / 中止 / 网络。
 *   顺序有意固定：**先认 HTTP 状态码**（429 的响应体里常带 "limit"，先按限流收），
 *   再认预算的精确口令，最后才是超时/网络 ⇒ 预算失败不会被说成网络超时、限流也不会被说成预算。
 *   细节文本一律先脱敏（Bearer、sk- 前缀、apiKey= 这类一律替换）再截断，绝不把正文或凭据带进行里。
 */
const JUDGE_BUDGET_CODES = [
  'budget-service-unavailable', 'request-id-required', 'request-invoker-required',
  'request-estimate-unavailable', 'reservation-failed', 'reservation-rejected',
  'request-id-conflict', 'request-id-already-recorded', 'invalid-reservation-fields',
  'invalid-hard-limit-configuration', 'hard-daily-limit-exceeded', 'instance-share-exceeded',
  'reservation-not-found', 'reservation-already-final', 'budget-ledger-'
];
export function sanitizeJudgeDetail(text) {
  let out = String(text ?? '');
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]{6,}/gi, 'Bearer ***');
  out = out.replace(/\b(sk|pk|api|key|token)[-_][A-Za-z0-9]{8,}\b/gi, '$1-***');
  out = out.replace(/(api[_-]?key|access[_-]?token|authorization)["'\s:=]+[^"',\s}]{6,}/gi, '$1=***');
  return out.replace(/\s+/g, ' ').trim().slice(0, 160);
}
export function classifyJudgeFailure(innerRaw) {
  const inner = String(innerRaw ?? '').trim() || 'request-failed';
  const codeHit = JUDGE_BUDGET_CODES.find((code) => inner.startsWith(code) || inner.includes(code));
  if (codeHit) {
    return { transport: 'unavailable', status: 'unavailable', failureKind: `budget:${codeHit}`, httpStatus: null, reason: `budget:${codeHit}` };
  }
  const http = /HTTP\s*(\d{3})/i.exec(inner);
  const httpStatus = http ? Number(http[1]) : null;
  if (httpStatus !== null) {
    const kind = httpStatus === 429 ? 'rate-limited'
      : (httpStatus === 401 || httpStatus === 403) ? 'auth-failed'
        : httpStatus === 404 ? 'model-or-endpoint-not-found'
          : (httpStatus === 400 || httpStatus === 422) ? 'request-rejected'
            : httpStatus >= 500 ? 'server-error' : `http-${httpStatus}`;
    return {
      transport: 'error', status: 'error', failureKind: kind, httpStatus,
      reason: `${kind}(HTTP ${httpStatus})${sanitizeJudgeDetail(inner) ? `：${sanitizeJudgeDetail(inner)}` : ''}`.slice(0, 220)
    };
  }
  if (/timeout|timed\s*out|超时|deadline/i.test(inner)) {
    return { transport: 'timeout', status: 'timeout', failureKind: 'timeout', httpStatus: null, reason: `timeout：${sanitizeJudgeDetail(inner)}`.slice(0, 220) };
  }
  if (/abort/i.test(inner)) {
    return { transport: 'timeout', status: 'timeout', failureKind: 'aborted', httpStatus: null, reason: `aborted：${sanitizeJudgeDetail(inner)}`.slice(0, 220) };
  }
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|ETIMEDOUT/i.test(inner)) {
    return { transport: 'error', status: 'error', failureKind: 'network-error', httpStatus: null, reason: `network-error：${sanitizeJudgeDetail(inner)}`.slice(0, 220) };
  }
  return { transport: 'error', status: 'error', failureKind: 'request-failed', httpStatus: null, reason: sanitizeJudgeDetail(inner) || 'request-failed' };
}

/**
 * 一次结构化判断（每调用最多一次模型请求）——见下方 judge.js 的 judgeOnce；这里是传输层。
 *   内部 chatCompletionOnce 完成唯一一次 reserve/settle（purpose='jev'），**外层不再包预算**（防重复执行）；
 *   失败抛 BUDGETED_JUDGE_REQUEST_FAILED 且保留真实 actualCalls/requestId ⇒ 这里走 classifyJudgeFailure 分档。
 */
export async function structuredCall({ prompt, timeoutMs = null, traceId = null, turnId = null, chatKey = null, personId = null, sourceId = null, model: modelOverride, estimatedTokens = null, maxOutputTokens = null } = {}) {
  const started = Date.now();
  const trace = typeof traceId === 'string' && traceId ? traceId.slice(0, 160) : undefined;
  const modelLabel = state.judgeModelLabel || '';
  const t = Number(timeoutMs) || state.defaultTimeoutMs;
  const clean = (v, max = 180) => v == null || String(v) === '' ? null : String(v).slice(0, max);
  const req = {
    roleId: 'judge3', prompt: String(prompt ?? ''), labels: [], input: '',
    timeoutMs: t, traceId: trace, attempt: 'single',
    // ★ 2026-10-16（单次预算）：判据侧的输入**上界**（judge.js 用 utf8 字节 + 协议余量算）与其输出预算
    //   一起透传给适配器 ⇒ 预算**预留**按这同一个数走（结算仍用供应商回报的真实 usage）。
    ...(Number.isSafeInteger(Number(estimatedTokens)) && Number(estimatedTokens) >= 0
      ? { estimatedTokens: Number(estimatedTokens) } : {}),
    // 本次允许的**最大输出**（有效值）：适配器拿它把 max_tokens 夹住，保证请求不超出联合守门。
    ...(Number.isFinite(Number(maxOutputTokens)) && Number(maxOutputTokens) > 0
      ? { maxOutputTokens: Math.floor(Number(maxOutputTokens)) } : {}),
    // ★ 指挥位最新口径：用途每次调用显式给 cloud_judge（适配器默认值只为兼容，生产不依赖）；
    //   范围四字段**始终带键**：sourceId 无值时显式 null（适配器只在键缺席时才回落 traceId，
    //   带键 null 即杜绝"拿 traceId 冒充 sourceId"；traceId 单独保留用于关联）。
    purpose: 'cloud_judge',
    chatKey: clean(chatKey),
    personId: clean(personId),
    sourceId: clean(sourceId),
    turnId: clean(turnId)
  };
  const attach = (extra) => ({ model: modelLabel, ...(trace ? { traceId: trace } : {}), ...extra });
  // ★ 2026-10-15（云判据链核查）：engine.callWithTimeout 的 15s 上限过去是**静默夹取** ——
  //   调用方（或面板配置）要 20000ms 也只会等到 15000ms，行里没有任何痕迹。
  //   这里把「生效 budgetMs」与「夹取事实 + 原请求值」带进返回值，由 judge.js 落到判据行。
  const timeoutMeta = (wrapped) => ({
    ...(Number.isFinite(wrapped?.budgetMs) ? { timeoutMs: wrapped.budgetMs } : {}),
    ...(wrapped?.timeoutClamped ? { timeoutRequestedMs: wrapped.requestedMs, timeoutClamped: true } : {})
  });

  // ── 显式测试通道：model 传了函数/null ⇒ 不走适配器（selftest 用；生产不要走这支）──
  if (modelOverride !== undefined) {
    const model = modelOverride === null ? null : (typeof modelOverride === 'function' ? modelOverride : null);
    if (!model) {
      return { transport: 'unavailable', status: 'unavailable', raw: null, error: null, ms: 0, reason: 'judge-model-not-injected', ...attach({}) };
    }
    const wrapped = await callWithTimeout(model, req, t);
    const { raw, error } = wrapped;
    const ms = Math.max(0, Date.now() - started);
    if (error) {
      const msg = String(error?.message ?? '');
      const transport = (error?.code === 'ETIMEDOUT' || /timeout|timed\s*out|abort|超时|deadline/i.test(msg)) ? 'timeout' : 'error';
      return { transport, status: transport, raw: null, error, ms, reason: msg.slice(0, 160), ...attach({ budgetBypass: true, ...timeoutMeta(wrapped) }) };
    }
    return { transport: 'ok', status: 'accepted', raw, error: null, ms, ...attach({ budgetBypass: true, ...timeoutMeta(wrapped) }) };
  }

  // ── 生产路径：judgeModel（预算内含，单次 reserve/settle）──
  if (!state.judgeModel) {
    return { transport: 'unavailable', status: 'unavailable', raw: null, error: null, ms: 0, reason: 'judge-model-not-injected', ...attach({}) };
  }
  const seq = (structuredCall._seq = (structuredCall._seq || 0) + 1);
  const requestId = `judge-${started}-${seq}`;
  req.requestId = requestId;

  let wrapped;
  try {
    wrapped = await callWithTimeout(state.judgeModel, req, t);
  } catch (error) {
    wrapped = { error };
  }
  const ms = Math.max(0, Date.now() - started);

  if (wrapped.error) {
    const error = wrapped.error;
    const actualCalls = Number.isSafeInteger(error?.actualCalls) ? error.actualCalls : undefined;
    const usageState = error?.usageState || undefined;
    const rid = error?.requestId || requestId;
    // ★ 失败也要把适配器给的 usage/attemptReasons 带出（有值才带）——面板与 turnPlan 要读五个字段。
    const failExtra = {
      requestId: rid,
      ...(actualCalls !== undefined ? { actualCalls } : {}),
      ...(usageState ? { usageState } : {}),
      ...(error?.usage && typeof error.usage === 'object' ? { usage: error.usage } : {}),
      ...(Array.isArray(error?.attemptReasons) && error.attemptReasons.length ? { attemptReasons: error.attemptReasons } : {}),
      // ★ 2026-10-16：适配器在失败的 error 上 attach 的调用诊断（端点风格 / 提供商主机 / 思考三态 /
      //   输出预算）——失败时也要能看到"这一枪是用谁、关没关思考打的"，不许丢在 error 里。
      ...(error?.endpointStyle ? { endpointStyle: String(error.endpointStyle).slice(0, 24) } : {}),
      ...(error?.providerHost ? { providerHost: String(error.providerHost).slice(0, 80) } : {}),
      ...(error?.thinkingApplied ? { thinkingApplied: String(error.thinkingApplied).slice(0, 24) } : {}),
      ...(Number.isFinite(Number(error?.maxTokens)) ? { maxTokens: Number(error.maxTokens) } : {})
    };
    if (error?.code === 'BUDGETED_JUDGE_REQUEST_FAILED') {
      const inner = String(error.message || '').replace(/^budgeted-judge-request-failed:?/, '').trim() || 'request-failed';
      const verdict = classifyJudgeFailure(inner);
      return {
        transport: verdict.transport, status: verdict.status, raw: null, error, ms, reason: verdict.reason,
        ...attach({
          ...failExtra, failureKind: verdict.failureKind,
          ...(verdict.httpStatus ? { httpStatus: verdict.httpStatus } : {}),
          ...timeoutMeta(wrapped)
        })
      };
    }
    const msg = String(error?.message ?? '');
    const verdict = classifyJudgeFailure(msg);
    // 显式的 ETIMEDOUT（engine.callWithTimeout 的中止）必须仍按 timeout 记，不被文本分档改掉。
    const transport = error?.code === 'ETIMEDOUT' ? 'timeout' : verdict.transport;
    const failureKind = error?.code === 'ETIMEDOUT' ? 'timeout' : verdict.failureKind;
    return {
      transport, status: transport, raw: null, error, ms, reason: verdict.reason,
      ...attach({
        ...failExtra, failureKind,
        ...(verdict.httpStatus ? { httpStatus: verdict.httpStatus } : {}),
        ...timeoutMeta(wrapped)
      })
    };
  }
  const result = wrapped.raw;
  const okExtra = {
    requestId: (result && typeof result === 'object' && result.requestId) || requestId,
    ...(result && Number.isSafeInteger(result.actualCalls) ? { actualCalls: result.actualCalls } : {}),
    ...(result && result.usageState ? { usageState: result.usageState } : {}),
    ...(result && result.usage && typeof result.usage === 'object' ? { usage: result.usage } : {}),
    ...(result && Array.isArray(result.attemptReasons) && result.attemptReasons.length ? { attemptReasons: result.attemptReasons } : {})
  };
  return { transport: 'ok', status: 'accepted', raw: result, error: null, ms, ...attach({ ...okExtra, ...timeoutMeta(wrapped) }) };
}

/** judge 的最终行记账（状态词表同 STATUSES；与 ask 共用环形账与注入的 ledger）。 */
export function recordStructured(row) {
  return record(row);
}
