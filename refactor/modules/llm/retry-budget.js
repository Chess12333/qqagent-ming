// Budget wrapper for the retrying provider path. Kept beside the LLM module so
// callers use the module's public index instead of adding their own accounting.
import { executeBudgetedRequest } from '../../core/budget/index.js';
import { apiWith, chatCompletionWithRetry } from './llm.js';

// api.maxTokens=0 means "do not send a provider output cap" in this module.
// Budgeting still needs a non-zero reservation estimate; this estimate never
// changes the provider request. Usage is settled from the provider response.
const DEFAULT_OUTPUT_RESERVATION_TOKENS = 4096;

/**
 * Reserve and settle one logical retrying LLM call.
 *
 * budgetRequest carries requestId/accountId/instanceId/purpose/model and the
 * per-call scope fields chatKey/personId/sourceId/turnId. estimatedTokens, when
 * supplied, represents the whole logical call. Every underlying provider fetch
 * is counted. If retry/fallback sends more than once, final-response usage does
 * not describe earlier sends, so the durable reservation settles as unknown.
 *
 * The return envelope matches chatCompletionOnce:
 * { ok, requestId, actualCalls, usageState, settlement, result, reason? }.
 */
export async function chatCompletionWithRetryBudgeted(
  { budgetService, budgetRequest = {}, estimatedTokens = null, ...args } = {},
  retries = 3,
  onTraceEvent = null
) {
  const api = apiWith(args.overrides || {});
  const configuredMaxTokens = Number(api.maxTokens);
  const outputReservationTokens = Number.isSafeInteger(configuredMaxTokens) && configuredMaxTokens > 0
    ? configuredMaxTokens : DEFAULT_OUTPUT_RESERVATION_TOKENS;
  let providerFetches = 0;
  const execution = await executeBudgetedRequest({
    budgetService,
    budgetRequest,
    estimatedTokens,
    request: {
      messages: args.messages,
      tools: args.tools,
      // maxTokens=0 is intentionally omitted from the outgoing body. For the
      // reservation estimator only, use a bounded fallback instead of treating
      // the usual unbounded provider default as an unavailable estimate.
      maxTokens: outputReservationTokens,
      signal: args.signal
    },
    model: String(budgetRequest.model || api.model || ''),
    invoke: async (budgetLifecycle) => {
      const upstreamLifecycle = args.requestLifecycle;
      const result = await chatCompletionWithRetry({
        ...args,
        requestLifecycle: {
          onFetchStart() {
            providerFetches += 1;
            budgetLifecycle.onFetchStart();
            try { upstreamLifecycle?.onFetchStart?.(); } catch { /* instrumentation must not affect requests */ }
          }
        }
      }, retries, onTraceEvent);
      return {
        // A retry may have incurred usage that is absent from the final response.
        usage: providerFetches === 1 ? (result?.raw?.usage ?? result?.usage ?? null) : null,
        completion: result
      };
    }
  });

  return {
    ...execution,
    result: execution.result?.completion ?? null
  };
}
