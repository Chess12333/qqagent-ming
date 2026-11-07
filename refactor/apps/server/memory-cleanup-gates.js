/**
 * M6 一键清理的**模型门 provider**（2026-10-16 · B/C 接线）。
 *
 * 用途：把 `cleanupAll({ apply:true, semanticGate, typeGate })` 需要的两个门接到**已有的**
 * 预算通道上 —— 与 compose 的 `chatCompletionWithBudget` 同一套做法：
 *   · 模型通道 = `modules/llm` 的 `chatCompletionWithRetryBudgeted`（**绝不**裸 `chatCompletion`）；
 *   · 预算 = `modules/llmBudgetService` 的真实 `reserve/settle`（`requestId` 由服务端生成）；
 *   · purpose = `memory_cleanup_gate`（在预算账上可单独识别）。
 *
 * 调用纪律（**由调用方保证**，本文件只提供门）：
 *   · 只在**用户显式 apply + 明确 gate 意图**时被注入（`apps/server/api/memory.js`）；
 *     默认盘点、执行 A 一律不碰模型；线圈里没有任何"自动批量花费"的入口；
 *   · 串行 / 单问超时 / 总预算 / 次数上限由 `modules/memory/index.js` 的 `askGateOnce` + `gateDiscipline`
 *     强制执行；本文件把 `signal` 透传下去 ⇒ 超时能真取消上游请求；
 *   · 每一次 ask 都可能失败：失败一律回 `{error}`（或把 abort 抛回去让清理侧记 `gate-timeout`），
 *     **绝不猜 YES / 绝不猜子类**。
 *
 * 模型选择与 `memory-extract.js` 同源（`resolveMemoryExtractModel`）：用户配了记忆专用模型就用它
 * （专用模型不继承聊天密钥）；没配则用当前聊天模型。每次 ask 都重新解析 ⇒ 改配置立即生效。
 */
import { resolveMemoryExtractModel } from './memory-extract.js';
import { IMP_TYPES } from '../../modules/memory/prompt-format.js';

/** 门口的固定参数（改动会进预算账与日志，别随手调）。 */
export const CLEANUP_GATE = Object.freeze({
  purpose: 'memory_cleanup_gate',
  maxTokens: 96,        // 答案只有一个 JSON 对象；给紧一点，别让门顺手写小作文
  retries: 0,           // 失败就逐项失败：重试 = 静默多花一次额度，这里不要
  temperature: 0
});

const TYPE_GATE_SYSTEM = [
  '你在给"关于某个人的印象条目"归类。只从这个固定清单里选一个子类：',
  `  ${IMP_TYPES.join(' / ')}`,
  '含义：identity=身份/职业/所在地等事实；preference=喜好与习惯；edge=关系、边界、约定；',
  '      style=说话或行为风格；event=发生过的事；attitude=态度、评价、情绪倾向。',
  '规则：只依据给出的原文判断，**不许补充原文没有的信息**；拿不准就输出 {"label":null}；',
  '只输出一个 JSON 对象，不要解释、不要多余文字。'
].join('\n');

const SEMANTIC_GATE_SYSTEM = [
  '你在判断两条人际印象是否在说**同一件事**（语义重复，措辞可以不同）。',
  '规则：只有两条确实指向同一事实/偏好/关系/风格/事件/态度才算重复；',
  '一方是另一方的更细补充、或时间/情境不同的两件事，都**不算**重复；',
  '拿不准就输出 {"label":null}；只输出一个 JSON 对象，不要解释、不要多余文字。'
].join('\n');

/** 从模型文本里取 JSON 对象（容忍 ```json 围栏/前后废话；取不到就 null）。 */
function parseJsonObject(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const candidates = [raw];
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    } catch { /* 换下一个候选 */ }
  }
  return null;
}

/**
 * 造门 provider。
 *
 * @param {object} deps
 * @param {object} deps.llm `modules/llm`（用它的 `chatCompletionWithRetryBudgeted` / `apiWith`）
 * @param {object} deps.budgetService `modules/llmBudgetService`（`newRequestId/reserve/settle`）
 * @param {object} [deps.cfg] 只读配置访问器（`get()/describeInstance()`；与 memory-extract 同源）
 * @param {() => string} [deps.selfId] 机器人账号（预算账的 accountId 来源，装配层给）
 * @param {(level:string, code:string, fields?:object) => void} [deps.log]
 * @returns {{available:()=>{ok:boolean,why:string}, semanticGate:Function, typeGate:Function,
 *            purpose:string, describe:()=>({purpose:string,model:string,source:string})}|null}
 *   `null` = 依赖不全（调用方如实保持 blocked，不要传假门）。**参数不合法时返回 null，不抛**。
 */
export function createMemoryCleanupGates({ llm, budgetService, cfg = null, selfId = null, log = null } = {}) {
  if (typeof llm?.chatCompletionWithRetryBudgeted !== 'function') return null;
  if (!budgetService || typeof budgetService.newRequestId !== 'function'
    || typeof budgetService.reserve !== 'function' || typeof budgetService.settle !== 'function') return null;

  const logLine = (level, code, fields) => {
    try { log?.(level, code, fields); } catch { /* 日志不许影响门 */ }
  };
  const digits = (value) => String(value ?? '').replace(/\D/g, '');

  /** 当前可用性（每次 ask 前都会重新判）：给出**具体原因**，供 HTTP 层如实报给面板。 */
  function availability() {
    if (typeof selfId !== 'function') return { ok: false, why: 'self-id-source-unavailable' };
    if (!digits(selfId())) return { ok: false, why: 'budget-account-id-unavailable' };
    const selected = resolveMemoryExtractModel(cfg);
    if (!selected.configured) return { ok: false, why: 'memory-gate-model-not-configured' };
    return { ok: true, why: '' };
  }

  /** 当前会用的模型（只作展示/预算记账；真正生效的是 ask 时解析的 overrides）。 */
  function describe() {
    const selected = resolveMemoryExtractModel(cfg);
    const overrides = selected.overrides || {};
    let activeModel = String(overrides.model ?? '').trim();
    if (!activeModel) {
      try { activeModel = String(llm.apiWith?.(overrides)?.model ?? '').trim(); } catch { activeModel = ''; }
    }
    if (!activeModel) activeModel = String(cfg?.get?.('api.model', '') ?? '').trim();
    return {
      purpose: CLEANUP_GATE.purpose,
      model: activeModel,
      source: selected.overrides ? 'memory-model' : 'chat-model'
    };
  }

  /**
   * 问一次门。返回值形状与清理侧契约一致：
   *   `{label}`（合法答案）| `{abstain:true}`（模型明确"拿不准"）| `{error}`（预算/通道/解析失败）。
   * abort/timeout **不吞**：抛回去让清理侧按 `gate-timeout` 逐项记账。
   */
  async function ask({ system, user, signal, chatKey = '' } = {}) {
    const state = availability();
    if (!state.ok) return { error: state.why };
    const selected = resolveMemoryExtractModel(cfg);
    const overrides = { ...(selected.overrides || {}), maxTokens: CLEANUP_GATE.maxTokens, disableThinking: true };
    let requestId = '';
    try { requestId = String(budgetService.newRequestId?.() ?? '').trim(); } catch { requestId = ''; }
    if (!requestId) return { error: 'request-id-unavailable' };
    const accountId = digits(selfId());
    let modelId = String(overrides.model ?? '').trim();
    if (!modelId) {
      try { modelId = String(llm.apiWith?.(overrides)?.model ?? '').trim(); } catch { modelId = ''; }
    }
    if (!modelId) modelId = String(cfg?.get?.('api.model', '') ?? '').trim();
    if (!modelId) return { error: 'budget-model-unavailable' };
    let instanceId = '';
    try { instanceId = String(cfg?.describeInstance?.() ?? '').trim(); } catch { instanceId = ''; }

    let result = null;
    const startedAt = Date.now();
    try {
      result = await llm.chatCompletionWithRetryBudgeted({
        messages: [
          { role: 'system', content: String(system ?? '') },
          { role: 'user', content: String(user ?? '') }
        ],
        tools: null,
        temperature: CLEANUP_GATE.temperature,
        overrides,
        ...(signal ? { signal } : {}),
        budgetService,
        budgetRequest: {
          requestId, accountId, instanceId,
          purpose: CLEANUP_GATE.purpose,
          model: modelId,
          chatKey: String(chatKey ?? '').trim().slice(0, 120)
        }
      }, CLEANUP_GATE.retries, null);
    } catch (error) {
      const name = String(error?.name ?? '');
      if (name === 'TimeoutError' || name === 'AbortError') throw error;   // 取消/超时 ⇒ 由清理侧记 gate-timeout
      logLine('warn', 'memory-cleanup-gate-call-failed', { purpose: CLEANUP_GATE.purpose, code: String(error?.code || name || 'error').slice(0, 48), ms: Math.max(0, Date.now() - startedAt) });
      return { error: 'model-call-failed' };
    }
    if (result?.ok !== true || !result.result) {
      const reason = String(result?.reason || 'budget-request-rejected').slice(0, 80);
      logLine('warn', 'memory-cleanup-gate-unavailable', { purpose: CLEANUP_GATE.purpose, code: reason, actualCalls: Number(result?.actualCalls) || 0 });
      return { error: reason };
    }
    const text = String(result.result?.message?.content ?? '');
    return { text, requestId, usageState: String(result?.usageState ?? ''), ms: Math.max(0, Date.now() - startedAt) };
  }

  /** B：两条印象是否语义重复 ⇒ `{label:'YES'|'NO'}` / `{abstain:true}` / `{error}`。 */
  async function semanticGate({ keepId = '', dropId = '', keepClaim = '', dropClaim = '', sim = null, signal = null } = {}) {
    const numberLine = Number.isFinite(Number(sim)) ? `\n相似度参考（机械相似度，可能误报）：${Number(sim).toFixed(2)}` : '';
    const answer = await ask({
      system: SEMANTIC_GATE_SYSTEM,
      user: `甲（保留）：${String(keepClaim ?? '').slice(0, 300)}\n乙（候选删除）：${String(dropClaim ?? '').slice(0, 300)}${numberLine}\n`
        + '只回答 {"label":"YES"}（重复）或 {"label":"NO"}（不重复）；拿不准回答 {"label":null}。',
      signal
    });
    if (answer?.error) return answer;
    const obj = parseJsonObject(answer.text);
    if (!obj) return { error: 'gate-parse-failed' };
    const label = String(obj.label ?? '').trim().toUpperCase();
    if (label === 'YES' || label === 'NO') return { label, requestId: answer.requestId };
    if (obj.label === null || label === '') return { abstain: true };
    return { error: 'gate-parse-failed' };
  }

  /** C：给一条印象补子类 ⇒ `{label: <IMP_TYPES 之一>}` / `{abstain:true}` / `{error}`。 */
  async function typeGate({ id = '', subjectId = '', claim = '', guess = '', signal = null } = {}) {
    const guessLine = String(guess ?? '').trim() ? `\n参考（正则粗略猜测，可能不对，不要盲从）：${String(guess).trim()}` : '';
    const answer = await ask({
      system: TYPE_GATE_SYSTEM,
      user: `印象原文：${String(claim ?? '').slice(0, 300)}${guessLine}\n只回答 {"label":"<子类>"} 或 {"label":null}。`,
      signal
    });
    if (answer?.error) return answer;
    const obj = parseJsonObject(answer.text);
    if (!obj) return { error: 'gate-parse-failed' };
    const label = String(obj.label ?? '').trim();
    if (IMP_TYPES.includes(label)) return { label, requestId: answer.requestId };
    if (obj.label === null || label === '') return { abstain: true };
    return { error: 'gate-parse-failed' };
  }

  return { available: availability, describe, semanticGate, typeGate, purpose: CLEANUP_GATE.purpose };
}
