import { randomUUID } from 'node:crypto';
import { chatCompletionOnce, thinkingStyleFor } from './llm.js';

/**
 * Convert JEV's model(req) contract to the single budgeted chat call.
 *
 * ★ 2026-10-15（云判据链核查）· 为什么**没有**在这里硬加 `disableThinking: true`：
 *   协议支持是有的 —— `llm.js:508-514` 认 `overrides.disableThinking`，`thinkingFields()`
 *   按端点风格下发（dashscope `enable_thinking:false` / ark·zhipu·moonshot·deepseek
 *   `thinking:{type:'disabled'}` / siliconflow `chat_template_kwargs` / generic `enable_thinking:false`，
 *   见 `llm.js:300-325`）。但两条硬事实让"硬加"不安全：
 *     ① `chatCompletionOnce` 走 `singleAttempt: true`，而 400 参数剥离回退被 `!singleAttempt`
 *        挡在门外（`llm.js:645`）⇒ 端点只要不认这个参数，判据请求会**直接 400 失败**（现在不会）。
 *     ② 本适配器的 overrides **不含** disableThinking ⇒ 判据请求其实已经在用全局思考配置
 *        （默认 `api.thinkingBudget=64` → dashscope 发 `thinking_budget:64`；全局关思考时它也是关的）。
 *        ⇒"探针没关思考"≠"生产没关思考"，不能拿探针的 0/5 直接推生产。
 *   ⇒ 要动它，先用**用户真实端点**跑"带/不带该参数"的对照，证实端点接受参数、且空正文确实来自
 *     思考占满 384 输出预算（本轮禁发真请求，故只留证据需求）。
 *
 * ★ 2026-10-16（用户令：判定"经常未完成"，要能单独关思考/换厂商）· 现在改为**三态**（`thinking`）：
 *   `'off'` 关思考 / `'on'` **显式开启** / `'inherit'` 跟随全局（默认，等价旧行为）。
 *   · 只在**已确认支持**该字段的端点风格上注入（`thinkingStyleFor(baseUrl)`，与 llm.js 的
 *     `thinkingFields` 同一张表）；未知中转**不盲发**，并把 `thinkingApplied:'unsupported-style'` 带出去，
 *     界面/诊断能看出"选了但没发"，不假装生效。
 *   · `'on'` 必须真的下发：`disableThinking:false` **加**一个 >0 的思考预算 —— 否则 llm.js 的
 *     enable 分支（`budget>0` 才发字段）什么都不发 ⇒ "界面说开启、实际没开"。
 *   · 这只影响**这一次判定调用**；主聊天思考由全局 `api.disableThinking/thinkingBudget` 决定，互不影响。
 *     乐观副作用（可核）：`llm.js` 在 overrides 带 `disableThinking` 时把 transformContext.thinkingMode
 *     置 on/off；亢奋模式（isHypeMode）仍**强制关思考**（判定也一样），这是全局模式的既有优先级。
 *   · `disableThinking` 旧参数保留：`true` ⇒ 'off'，`false`/null ⇒ 'inherit'（旧复选框语义不变）。
 */
export function createBudgetedJudgeModel({
  budgetService, accountId, instanceId = '', model, baseUrl = '', apiKey = '',
  maxTokens = 384, estimatedTokens = null, purpose = 'cloud_judge',
  thinking = null, thinkingBudget = null, disableThinking = null
} = {}) {
  const providerModel = String(model ?? '').trim();
  if (!providerModel) throw new TypeError('judge adapter requires a model');
  const thinkingMode = thinking === 'off' || thinking === 'on'
    ? thinking
    : (disableThinking === true ? 'off' : 'inherit');
  // 已确认能关 / 能开的端点风格（与 llm.js thinkingFields 的两个分支逐个对应）。
  //   ⚠ moonshot 只在"开"名单里：关的那支本仓从未核对过官方口径，不加进来（不把按域名识别当支持证明）。
  const OFF_SAFE_STYLES = new Set(['dashscope', 'ark', 'zhipu', 'deepseek', 'siliconflow']);
  const ON_SAFE_STYLES = new Set(['dashscope', 'ark', 'zhipu', 'moonshot', 'deepseek']);
  const endpointStyle = thinkingStyleFor(baseUrl);
  const judgeThinkingBudget = Number.isFinite(Number(thinkingBudget)) && Number(thinkingBudget) > 0
    ? Math.max(1, Math.min(32768, Math.floor(Number(thinkingBudget)))) : 128;
  const thinkingOverrides = {};
  let thinkingApplied = 'inherit';
  if (thinkingMode === 'off' && OFF_SAFE_STYLES.has(endpointStyle)) {
    thinkingOverrides.disableThinking = true;
    thinkingApplied = 'off';
  } else if (thinkingMode === 'on' && ON_SAFE_STYLES.has(endpointStyle)) {
    thinkingOverrides.disableThinking = false;
    thinkingOverrides.thinkingBudget = judgeThinkingBudget;
    thinkingApplied = 'on';
  } else if (thinkingMode !== 'inherit') {
    thinkingApplied = 'unsupported-style';
  }
  const providerHost = (() => { try { return new URL(String(baseUrl)).host; } catch { return ''; } })();
  const effectiveMaxTokens = Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0 ? Math.floor(Number(maxTokens)) : 384;
  return async function judgeModel(req = {}) {
    if (req.attempt !== 'single') throw new Error('judge adapter requires attempt=single');
    const scope = req.budgetRequest && typeof req.budgetRequest === 'object'
      ? req.budgetRequest
      : (req.budget && typeof req.budget === 'object' ? req.budget : {});
    const callValue = (key, fallback = undefined) => Object.prototype.hasOwnProperty.call(req, key)
      ? req[key]
      : (Object.prototype.hasOwnProperty.call(scope, key) ? scope[key] : fallback);
    const requestId = String(req.requestId ?? scope.requestId ?? '').trim() || randomUUID();
    const prompt = String(req.prompt ?? '');
    const timeoutMs = Number(req.timeoutMs);
    // ★ 2026-10-19（第五批 B 接口 · 第六批 A 落）：无父 signal 时的兜底上限与
    //   `localJev.judgeTimeoutMs` 的有效区间（1000..120000ms）一致 —— 不再保留旧 15s 硬顶。
    //   下界仍保留 100 兼容旧角色/测试小档；取消语义不变（超时即 abort 本次请求）。
    const signal = req.signal || (Number.isFinite(timeoutMs) && timeoutMs > 0
      ? AbortSignal.timeout(Math.min(120000, Math.max(100, timeoutMs))) : null);
    const requestedMax = effectiveMaxTokens;
    // ★ 2026-10-16（联合守门）：本次允许的最大输出由判据侧给出（core 的有效值 ≤ 用户配置，并保证
    //   "输入上界 + 输出 ≤ 2000"）；万一构造时的 maxTokens 更大（旧装配层只夹到 4096），这里**取下限**。
    const capCandidate = Number(callValue('maxOutputTokens', null));
    const capMax = Number.isFinite(capCandidate) && capCandidate > 0 ? Math.floor(capCandidate) : null;
    const appliedMax = capMax === null ? requestedMax : Math.min(requestedMax, capMax);
    const configuredEstimate = req.estimatedTokens ?? estimatedTokens;
    const hasConfiguredEstimate = configuredEstimate !== null && configuredEstimate !== undefined && configuredEstimate !== '';
    const estimate = hasConfiguredEstimate && Number.isSafeInteger(Number(configuredEstimate)) && Number(configuredEstimate) >= 0
      ? Number(configuredEstimate)
      : Math.ceil(prompt.length / 4) + Math.max(0, Number(appliedMax) || 384);
    const execution = await chatCompletionOnce({
      budgetService,
      budgetRequest: {
        requestId,
        accountId: String(accountId ?? '').trim(),
        purpose: String(callValue('purpose', purpose) ?? 'cloud_judge').trim() || 'cloud_judge',
        model: providerModel,
        instanceId: String(instanceId ?? '').trim(),
        chatKey: String(callValue('chatKey', '') ?? '').slice(0, 180) || null,
        personId: String(callValue('personId', '') ?? '').slice(0, 180) || null,
        sourceId: String(callValue('sourceId', req.traceId) ?? '').slice(0, 180) || null,
        turnId: String(callValue('turnId', '') ?? '').slice(0, 180) || null
      },
      estimatedTokens: estimate,
      overrides: {
        baseUrl,
        apiKey,
        model: providerModel,
        maxTokens: appliedMax,
        ...thinkingOverrides
      },
      messages: [{ role: 'user', content: prompt }],
      signal
    });
    if (!execution?.ok) {
      const error = new Error(`budgeted-judge-request-failed:${execution?.reason || 'request-failed'}`);
      error.code = 'BUDGETED_JUDGE_REQUEST_FAILED';
      error.requestId = execution?.requestId || requestId;
      error.actualCalls = Number.isSafeInteger(execution?.actualCalls) ? execution.actualCalls : 0;
      error.usageState = execution?.usageState || 'unknown';
      error.attemptReasons = [{ reason: String(execution?.reason || 'request-failed'), actualCalls: error.actualCalls }];
      // ★ 2026-10-16：失败时也把"这一枪用谁打的/思考态/输出预算"attach 出去（identity 诊断，
      //   不含正文与凭据）——否则失败行只剩一句 reason，查不出是配置问题还是端点问题。
      error.endpointStyle = endpointStyle;
      if (providerHost) error.providerHost = providerHost;
      error.thinkingMode = thinkingMode;
      error.thinkingApplied = thinkingApplied;
      error.maxTokens = appliedMax;
      throw error;
    }
    // ★ 2026-10-15（云判据链核查）：判据无效时必须能分清"空正文 / 被截断 / 解析失败"，
    //   但**不许落模型正文** —— 只带长度与 finish_reason 这类枚举/计数（长度有界、无内容）。
    //   reasoning_content 只数长度、**绝不回填进 text**：思考不是判据正文，回填等于让模型的
    //   分析文本冒充裁决（legacy 角色路径 jev-local-model.js:416 的回落是给"标签词"用的，
    //   J1 判的是 JSON，回填会把思考里的半截 JSON 当成有效判据）。
    const message = execution.result?.message ?? null;
    const content = message?.content;
    const reasoningRaw = message?.reasoning_content ?? message?.reasoning ?? null;
    const reasoningChars = typeof reasoningRaw === 'string'
      ? reasoningRaw.length
      : Array.isArray(reasoningRaw)
        ? reasoningRaw.reduce((n, part) => n + String(typeof part === 'string' ? part : part?.text ?? '').length, 0)
        : 0;
    const finishReasonRaw = execution.result?.finishReason ?? null;
    const rawUsage = execution.result?.usage ?? execution.result?.raw?.usage ?? null;
    const readTokens = (value) => value !== null && value !== undefined && value !== ''
      && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
    const promptTokens = readTokens(rawUsage?.prompt_tokens ?? rawUsage?.promptTokens);
    const completionTokens = readTokens(rawUsage?.completion_tokens ?? rawUsage?.completionTokens);
    const totalTokens = readTokens(rawUsage?.total_tokens ?? rawUsage?.totalTokens)
      ?? (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null);
    const usage = rawUsage ? { promptTokens, completionTokens, totalTokens } : null;
    const text = Array.isArray(content)
      ? content.map((part) => typeof part === 'string' ? part : String(part?.text ?? '')).join('')
      : String(content ?? '');
    return {
      text,
      // ★ 判据链只读诊断（2026-10-15）：正文/思考长度与供应商 finish_reason。
      //   `text` 语义不变（还是 message.content）；这几项只给 judge.js 记"无效原因"用。
      contentChars: text.length,
      reasoningChars,
      ...(finishReasonRaw !== null && finishReasonRaw !== undefined && String(finishReasonRaw) !== ''
        ? { finishReason: String(finishReasonRaw).slice(0, 32) } : {}),
      // ★ 2026-10-16（独立云判定/未完成诊断）：这一次调用实际用的端点风格、提供商主机、思考三态与
      //   输出预算。全是枚举/短串，**不含 prompt/正文/凭据**，供 judge.js 落进判据行、面板显示。
      endpointStyle,
      ...(providerHost ? { providerHost } : {}),
      thinkingMode,
      thinkingApplied,
      ...(thinkingApplied === 'on' ? { thinkingBudgetApplied: judgeThinkingBudget } : {}),
      // ★ 2026-10-16（联合守门真值）：实际发出去的 max_tokens 与"构造时想要的值"分开写，
      //   被判据侧上限压下时带 `maxOutputTokensClamped`（不静默）。
      maxTokens: appliedMax,
      maxOutputTokensRequested: requestedMax,
      ...(appliedMax < requestedMax ? { maxOutputTokensClamped: true } : {}),
      requestId: execution.requestId || requestId,
      actualCalls: Number.isSafeInteger(execution.actualCalls) ? execution.actualCalls : 0,
      usageState: execution.usageState || 'unknown',
      usage,
      attemptReasons: execution.actualCalls > 0 ? [{ reason: 'provider-response', actualCalls: execution.actualCalls }] : []
    };
  };
}
