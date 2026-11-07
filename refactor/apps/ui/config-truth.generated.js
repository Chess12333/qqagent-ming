/* 本文件由 refactor/tools/gen-config-truth.mjs 生成，**不要手改**。
 * 真值来源（生成时会重新读一遍，改了源要重跑生成器）：
 *   · refactor/core/config-store/key-ledger.mjs   —— 死键/活键的权威判定
 *   · 对 refactor/{modules,act,core,llm,prompt,orchestrator,agents,apps/server}/** 的实证 grep
 *   · 派生表：core/config-store/index.js 的 deriveTierFields() + tier-slider.js 的 sliderToTier()
 * 生成时间：2026-10-19T06:52:08.431Z
 * 面板字段总数：138
 * 判定分布：live(grep 独立确认)=111 live(仅台账判)=4 dead=13 derived=0 weak=10 unlisted=0
 * 滑条分段口径：0–10 → 1 档（意愿强制 0%）｜10–20 → 2 档（意愿强制 0%）｜20–90 → 3 档（意愿按 (pos−20)/70 线性 0→100%）｜90–100 → 4 档（意愿 100%）
 */
(function (root) {
  var TRUTH = {
  "api.architecture.crossTurnWorking": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/assembly.js",
    "needle": "api.architecture.crossTurnWorking",
    "readers": [
      "refactor/apps/server/assembly.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.architecture.pendingTodos": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/compose.js",
    "needle": "api.architecture.pendingTodos",
    "readers": [
      "refactor/modules/orchestrator/compose.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.architecture.semanticCards": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/compose.js",
    "needle": "api.architecture.semanticCards",
    "readers": [
      "refactor/modules/orchestrator/compose.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.architecture.semanticTopN": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/compose.js",
    "needle": "api.architecture.semanticTopN",
    "readers": [
      "refactor/modules/orchestrator/compose.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.architecture.workingDecayMin": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/assembly.js",
    "needle": "api.architecture.workingDecayMin",
    "readers": [
      "refactor/apps/server/assembly.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.architecture.workingMaxChars": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/prompt/index.js",
    "needle": "api.architecture.workingMaxChars",
    "readers": [
      "refactor/modules/prompt/index.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.architecture.workingTtlMin": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/assembly.js",
    "needle": "api.architecture.workingTtlMin",
    "readers": [
      "refactor/apps/server/assembly.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.autoFinish.enabled": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/compose.js",
    "needle": "api.autoFinish.enabled",
    "readers": [
      "refactor/modules/orchestrator/compose.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.autoFinish.multiOnly": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/compose.js",
    "needle": "api.autoFinish.multiOnly",
    "readers": [
      "refactor/modules/orchestrator/compose.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.autoVisionMaxBytesMB": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/media/auto-vision.js",
    "needle": "api.autoVisionMaxBytesMB",
    "readers": [
      "refactor/modules/media/auto-vision.js",
      "refactor/modules/orchestrator/compose.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.autoVisionMaxTotalChars": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/media/auto-vision.js",
    "needle": "api.autoVisionMaxTotalChars",
    "readers": [
      "refactor/modules/media/auto-vision.js",
      "refactor/modules/orchestrator/compose.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.budget.hardLimitTokens": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/apps/server/console-api.js",
    "needle": "api.budget",
    "readers": [
      "refactor/apps/server/assembly.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.budget.instanceShares": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/apps/server/console-api.js",
    "needle": "api.budget",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.cacheKeepAlive.enabled": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/llm/keep-alive-runtime.js",
    "needle": "api.cacheKeepAlive.",
    "readers": [
      "refactor/modules/orchestrator/compose.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.cacheKeepAlive.intervalMs": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/llm/keep-alive-runtime.js",
    "needle": "api.cacheKeepAlive.",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.cacheKeepAlive.maxPerChat": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/llm/keep-alive-runtime.js",
    "needle": "api.cacheKeepAlive.",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.cacheKeepAlive.minPrefixTokens": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/llm/keep-alive-runtime.js",
    "needle": "api.cacheKeepAlive.",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.cacheKeepAlive.privateMaxPerChat": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/llm/keep-alive-runtime.js",
    "needle": "api.cacheKeepAlive.",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.cacheKeepAlive.privateQuietAfterMs": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/llm/keep-alive-runtime.js",
    "needle": "api.cacheKeepAlive.",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.cacheKeepAlive.quietAfterMs": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/llm/keep-alive-runtime.js",
    "needle": "api.cacheKeepAlive.",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.cacheMode": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/compose.js",
    "needle": "api.cacheMode",
    "readers": [
      "refactor/modules/llm/cache-profile.js",
      "refactor/modules/orchestrator/compose.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.conversationMemory.enabled": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/prompt/index.js",
    "needle": "api.conversationMemory.enabled",
    "readers": [
      "refactor/modules/orchestrator/compose.js",
      "refactor/modules/prompt/index.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.conversationMemory.maxSearchPerRun": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/act/executors/memory.js",
    "needle": "api.conversationMemory.maxSearchPerRun",
    "readers": [
      "refactor/modules/act/executors/memory.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.costGuard.dayTokenMax": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/apps/server/console-api.js",
    "needle": "api.costGuard",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.costGuard.enabled": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/apps/server/console-api.js",
    "needle": "api.costGuard",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.finishRound.enabled": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/compose.js",
    "needle": "api.finishRound.enabled",
    "readers": [
      "refactor/modules/orchestrator/compose.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.frequencyPenalty": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/llm/llm.js",
    "needle": "api.frequencyPenalty",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.localReplyTrial.complexTokens": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/orchestrator/compose.js",
    "needle": "api.localReplyTrial",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.localReplyTrial.enabled": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/orchestrator/compose.js",
    "needle": "api.localReplyTrial",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.localReplyTrial.maxTokens": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/orchestrator/compose.js",
    "needle": "api.localReplyTrial",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.maxRounds": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/compose.js",
    "needle": "api.maxRounds",
    "readers": [
      "refactor/modules/orchestrator/compose.js",
      "refactor/modules/orchestrator/index.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.maxTokens": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/llm/llm.js",
    "needle": "api.maxTokens",
    "readers": [
      "refactor/modules/orchestrator/compose.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.memeAutoCue": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/media/meme-cue.js",
    "needle": "api.memeAutoCue",
    "readers": [
      "refactor/modules/media/meme-cue.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.memeCueMinScore": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/media/meme-cue.js",
    "needle": "api.memeCueMinScore",
    "readers": [
      "refactor/modules/media/meme-cue.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.memeCuePlayfulOnly": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/media/meme-cue.js",
    "needle": "api.memeCuePlayfulOnly",
    "readers": [
      "refactor/modules/media/meme-cue.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.memoryAutoPrefetch": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/compose.js",
    "needle": "api.memoryAutoPrefetch",
    "readers": [
      "refactor/modules/orchestrator/compose.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.memoryRecallReminder": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/compose.js",
    "needle": "api.memoryRecallReminder",
    "readers": [
      "refactor/modules/orchestrator/compose.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.presencePenalty": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/llm/llm.js",
    "needle": "api.presencePenalty",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.priceRemoteUrl": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/api/console.js",
    "needle": "api.priceRemoteUrl",
    "readers": [
      "refactor/apps/server/api/console.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.replyReminder": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/compose.js",
    "needle": "api.replyReminder",
    "readers": [
      "refactor/modules/orchestrator/compose.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.thinkingBudget": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/llm/llm.js",
    "needle": "api.thinkingBudget",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.timeoutMs": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/llm/llm.js",
    "needle": "api.timeoutMs",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.topP": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/llm/llm.js",
    "needle": "api.topP",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "api.useOfficialPrice": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/llm/model-prices.js",
    "needle": "api.useOfficialPrice",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "broadcastSchedules.enabled": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/broadcast/index.js",
    "needle": "broadcastSchedules.enabled",
    "readers": [],
    "grepConfirmed": false
  },
  "burstAdaptive.enabled": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/orchestrator/index.js",
    "needle": "burstAdaptive",
    "readers": [
      "refactor/modules/orchestrator/index.js"
    ],
    "grepConfirmed": true,
    "via": "subtree"
  },
  "burstMaxWaitMs": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/index.js",
    "needle": "burstMaxWaitMs",
    "readers": [
      "refactor/modules/orchestrator/index.js"
    ],
    "grepConfirmed": true
  },
  "burstSettleMs": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/index.js",
    "needle": "burstSettleMs",
    "readers": [
      "refactor/modules/orchestrator/index.js"
    ],
    "grepConfirmed": true
  },
  "drainDelayMs": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/index.js",
    "needle": "drainDelayMs",
    "readers": [
      "refactor/modules/orchestrator/index.js"
    ],
    "grepConfirmed": true
  },
  "emotion.amplitudeLevel": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/emotion/apply.js",
    "needle": "config.amplitudeLevel",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "emotion.decayLevel": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/emotion/apply.js",
    "needle": "config.decayLevel",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "emotion.ignoreSenderIds": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/index.js",
    "needle": "emotion.ignoreSenderIds",
    "readers": [
      "refactor/modules/orchestrator/index.js",
      "refactor/core/config-store/index.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "emotion.ramp": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/emotion/apply.js",
    "needle": "config.ramp",
    "readers": [
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "extensions.hotReload": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/assembly.js",
    "needle": "extensions.hotReload",
    "readers": [
      "refactor/apps/server/assembly.js"
    ],
    "grepConfirmed": true
  },
  "knowledge.external.enabled": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/compose.js",
    "needle": "knowledge.external.enabled",
    "readers": [
      "refactor/modules/orchestrator/compose.js"
    ],
    "grepConfirmed": true
  },
  "knowledge.images.autoCueSelf": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/compose.js",
    "needle": "knowledge.images.autoCueSelf",
    "readers": [
      "refactor/modules/orchestrator/compose.js"
    ],
    "grepConfirmed": true
  },
  "localJev.ctxSize": {
    "v": "dead",
    "risk": null
  },
  "localJev.enabled": {
    "v": "dead",
    "risk": "retired-role"
  },
  "localJev.gateBudgetMs": {
    "v": "dead",
    "risk": null
  },
  "localJev.inputMaxChars": {
    "v": "dead",
    "risk": null
  },
  "localJev.judgeApi.mode": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/assembly.js",
    "needle": "localJev.judgeApi.mode",
    "readers": [
      "refactor/apps/server/assembly.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "localJev.judgeApi.model": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/assembly.js",
    "needle": "localJev.judgeApi.model",
    "readers": [
      "refactor/apps/server/assembly.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "localJev.judgeApi.providerId": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/assembly.js",
    "needle": "localJev.judgeApi.providerId",
    "readers": [
      "refactor/apps/server/assembly.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "localJev.judgeDisableThinking": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/assembly.js",
    "needle": "localJev.judgeDisableThinking",
    "readers": [
      "refactor/apps/server/assembly.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "localJev.judgeMaxTokens": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/assembly.js",
    "needle": "localJev.judgeMaxTokens",
    "readers": [
      "refactor/apps/server/assembly.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "localJev.judgeMode.enabled": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/index.js",
    "needle": "localJev.judgeMode.enabled",
    "readers": [
      "refactor/modules/orchestrator/index.js",
      "refactor/apps/server/assembly.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "localJev.judgeMode.prompt": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/assembly.js",
    "needle": "localJev.judgeMode.prompt",
    "readers": [
      "refactor/apps/server/assembly.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "localJev.judgeTimeoutMs": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/assembly.js",
    "needle": "localJev.judgeTimeoutMs",
    "readers": [
      "refactor/apps/server/assembly.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "localJev.maxInflight": {
    "v": "dead",
    "risk": null
  },
  "localJev.minConfidence": {
    "v": "dead",
    "risk": null
  },
  "localJev.minMargin": {
    "v": "dead",
    "risk": null
  },
  "localJev.modelId": {
    "v": "dead",
    "risk": "retired-role"
  },
  "localJev.modelPath": {
    "v": "dead",
    "risk": "retired-role"
  },
  "localJev.port": {
    "v": "dead",
    "risk": "retired-role"
  },
  "localJev.replyChance.cooldownMs": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/plan/index.js",
    "needle": "localJev.replyChance.cooldownMs",
    "readers": [
      "refactor/modules/plan/index.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "localJev.replyChance.maxPerHour": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/plan/index.js",
    "needle": "localJev.replyChance.maxPerHour",
    "readers": [
      "refactor/modules/plan/index.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "localJev.replyChance.mode": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/index.js",
    "needle": "localJev.replyChance.mode",
    "readers": [
      "refactor/modules/orchestrator/index.js",
      "refactor/core/config-store/key-ledger.mjs"
    ],
    "grepConfirmed": true
  },
  "localJev.roles": {
    "v": "dead",
    "risk": "generic-leaf"
  },
  "localJev.startOnLaunch": {
    "v": "dead",
    "risk": null
  },
  "localJev.useGrammar": {
    "v": "dead",
    "risk": null
  },
  "maxConcurrentRuns": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/index.js",
    "needle": "maxConcurrentRuns",
    "readers": [
      "refactor/modules/emotion/persona-two.js",
      "refactor/modules/orchestrator/index.js",
      "refactor/modules/proactive/index.js"
    ],
    "grepConfirmed": true
  },
  "memory.consolidateMinImpressions": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/memory-maintenance.js",
    "needle": "memory.consolidateMinImpressions",
    "readers": [
      "refactor/apps/server/memory-maintenance.js"
    ],
    "grepConfirmed": true
  },
  "memory.consolidateMinIntervalMs": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/memory-maintenance.js",
    "needle": "memory.consolidateMinIntervalMs",
    "readers": [
      "refactor/apps/server/memory-maintenance.js"
    ],
    "grepConfirmed": true
  },
  "memory.manualEditLockMs": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/memory/manual-edit-lock.js",
    "needle": "memory.manualEditLockMs",
    "readers": [
      "refactor/modules/memory/manual-edit-lock.js"
    ],
    "grepConfirmed": true
  },
  "memory.maxImpressionsPerMember": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/memory-maintenance.js",
    "needle": "memory.maxImpressionsPerMember",
    "readers": [
      "refactor/apps/server/memory-maintenance.js"
    ],
    "grepConfirmed": true
  },
  "persona.compactSystemPrompt": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/prompt/index.js",
    "needle": "persona.compactSystemPrompt",
    "readers": [
      "refactor/modules/prompt/index.js"
    ],
    "grepConfirmed": true
  },
  "persona.customRules": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/prompt/index.js",
    "needle": "persona.customRules",
    "readers": [
      "refactor/modules/prompt/index.js"
    ],
    "grepConfirmed": true
  },
  "persona.emotionProfile": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/console-api.js",
    "needle": "persona.emotionProfile",
    "readers": [
      "refactor/modules/emotion/state-owner.js",
      "refactor/apps/server/console-api.js"
    ],
    "grepConfirmed": true
  },
  "persona.roleText": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/console-api.js",
    "needle": "persona.roleText",
    "readers": [
      "refactor/modules/act/executors/memory.js",
      "refactor/modules/orchestrator/compose.js",
      "refactor/apps/server/assembly.js"
    ],
    "grepConfirmed": true
  },
  "persona.systemMode": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/prompt/index.js",
    "needle": "persona.systemMode",
    "readers": [
      "refactor/modules/emotion/hype-mode.js",
      "refactor/modules/prompt/index.js"
    ],
    "grepConfirmed": true
  },
  "security.allowPrivateFetchHosts": {
    "v": "weak",
    "evidence": "refactor/modules/internet/web-search.js",
    "readers": [],
    "basis": "suffix"
  },
  "security.browseLock.domains": {
    "v": "weak",
    "evidence": "refactor/modules/act/executors/query.js",
    "readers": [],
    "basis": "suffix"
  },
  "security.browseLock.enabled": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/internet/safe-fetch.js",
    "needle": "security?.browseLock",
    "readers": [
      "refactor/modules/internet/safe-fetch.js"
    ],
    "grepConfirmed": true,
    "via": "subtree"
  },
  "security.browseLock.includeSubdomains": {
    "v": "weak",
    "evidence": "refactor/modules/internet/safe-fetch.js",
    "readers": [],
    "basis": "suffix"
  },
  "security.browseLock.searchUrl": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/act/executors/query.js",
    "needle": "security.browseLock.searchUrl",
    "readers": [
      "refactor/modules/act/executors/query.js"
    ],
    "grepConfirmed": true
  },
  "security.imageSend.maxBytesMB": {
    "v": "weak",
    "evidence": "refactor/modules/act/executors/media.js",
    "readers": [],
    "basis": "suffix"
  },
  "security.imageSend.maxPerRun": {
    "v": "weak",
    "evidence": "refactor/modules/act/executors/media.js",
    "readers": [],
    "basis": "suffix"
  },
  "security.imageSend.maxPreviewsPerRun": {
    "v": "weak",
    "evidence": "refactor/modules/act/executors/media.js",
    "readers": [],
    "basis": "suffix"
  },
  "security.imageSend.skipPreviewForLockedHosts": {
    "v": "weak",
    "evidence": "refactor/modules/act/executors/media.js",
    "readers": [],
    "basis": "suffix"
  },
  "send.blockAiSelfClaim": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/act/index.js",
    "needle": "send.blockAiSelfClaim",
    "readers": [
      "refactor/modules/act/index.js"
    ],
    "grepConfirmed": true
  },
  "send.blockJsonFragments": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/act/index.js",
    "needle": "send.blockJsonFragments",
    "readers": [
      "refactor/modules/act/index.js"
    ],
    "grepConfirmed": true
  },
  "send.blockPureEnglish": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/act/index.js",
    "needle": "send.blockPureEnglish",
    "readers": [
      "refactor/modules/act/index.js"
    ],
    "grepConfirmed": true
  },
  "send.byLengthMs": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/platform/sender.js",
    "needle": "getConfig().send",
    "readers": [
      "refactor/core/config-store/migrations.js"
    ],
    "grepConfirmed": true
  },
  "send.hardSplitAt": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/platform/sender.js",
    "needle": "getConfig().send",
    "readers": [
      "refactor/modules/platform/sender.js"
    ],
    "grepConfirmed": true,
    "via": "subtree"
  },
  "send.maxGapMs": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/platform/sender.js",
    "needle": "getConfig().send",
    "readers": [
      "refactor/core/config-store/migrations.js"
    ],
    "grepConfirmed": true
  },
  "send.maxPerHour": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/platform/sender.js",
    "needle": "send.maxPerHour",
    "readers": [
      "refactor/modules/platform/sender.js"
    ],
    "grepConfirmed": true
  },
  "send.maxPerMinute": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/platform/sender.js",
    "needle": "send.maxPerMinute",
    "readers": [
      "refactor/modules/platform/sender.js"
    ],
    "grepConfirmed": true
  },
  "send.maxPerRun": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/index.js",
    "needle": "send.maxPerRun",
    "readers": [
      "refactor/modules/act/index.js",
      "refactor/modules/orchestrator/index.js"
    ],
    "grepConfirmed": true
  },
  "send.minGapMs": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/platform/sender.js",
    "needle": "getConfig().send",
    "readers": [
      "refactor/core/config-store/migrations.js"
    ],
    "grepConfirmed": true
  },
  "send.splitLongAt": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/platform/sender.js",
    "needle": "getConfig().send",
    "readers": [
      "refactor/modules/platform/sender.js"
    ],
    "grepConfirmed": true,
    "via": "subtree"
  },
  "send.stripEmoji": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/act/index.js",
    "needle": "send.stripEmoji",
    "readers": [
      "refactor/modules/act/index.js"
    ],
    "grepConfirmed": true
  },
  "send.tidyBrackets": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/act/index.js",
    "needle": "send.tidyBrackets",
    "readers": [
      "refactor/modules/act/index.js",
      "refactor/modules/prompt/index.js"
    ],
    "grepConfirmed": true
  },
  "sticker.autoPick.cooldownMs": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/index.js",
    "needle": "sticker.autoPick.cooldownMs",
    "readers": [
      "refactor/modules/orchestrator/index.js"
    ],
    "grepConfirmed": true
  },
  "sticker.autoPick.shortlist": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/index.js",
    "needle": "sticker.autoPick.shortlist",
    "readers": [
      "refactor/modules/orchestrator/index.js"
    ],
    "grepConfirmed": true
  },
  "sticker.collectEnabled": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/prompt/index.js",
    "needle": "sticker.collectEnabled",
    "readers": [
      "refactor/modules/prompt/index.js"
    ],
    "grepConfirmed": true
  },
  "sticker.maxCollectPerHour": {
    "v": "weak",
    "evidence": "refactor/modules/media/sticker-manager.js",
    "readers": [],
    "basis": "suffix"
  },
  "sticker.promptMaxStickers": {
    "v": "weak",
    "evidence": "refactor/modules/media/sticker-manager.js",
    "readers": [
      "refactor/modules/orchestrator/compose.js"
    ],
    "basis": "suffix"
  },
  "sticker.rotatePeriodMin": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/compose.js",
    "needle": "sticker.rotatePeriodMin",
    "readers": [
      "refactor/modules/orchestrator/compose.js",
      "refactor/modules/orchestrator/index.js"
    ],
    "grepConfirmed": true
  },
  "store.historyCold.enabled": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/compose.js",
    "needle": "store.historyCold.enabled",
    "readers": [
      "refactor/modules/orchestrator/compose.js"
    ],
    "grepConfirmed": true
  },
  "store.historyCold.warmCount": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/compose.js",
    "needle": "store.historyCold.warmCount",
    "readers": [
      "refactor/modules/orchestrator/compose.js"
    ],
    "grepConfirmed": true
  },
  "store.hotMessagesPerChat": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/store-caps.js",
    "needle": "store.hotMessagesPerChat",
    "readers": [
      "refactor/apps/server/store-caps.js"
    ],
    "grepConfirmed": true
  },
  "store.keepSessionFiles": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/index.js",
    "needle": "store.keepSessionFiles",
    "readers": [
      "refactor/modules/orchestrator/index.js"
    ],
    "grepConfirmed": true
  },
  "store.maxMessagesPerChat": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/store-caps.js",
    "needle": "store.maxMessagesPerChat",
    "readers": [
      "refactor/apps/server/store-caps.js"
    ],
    "grepConfirmed": true
  },
  "ui.desktopPetShowMood": {
    "v": "live",
    "basis": "out-of-corpus",
    "evidence": "refactor/apps/server/console-api.js",
    "needle": "cs.updateConfigAndSave",
    "readers": [],
    "grepConfirmed": false
  },
  "ui.desktopPetShowUsage": {
    "v": "live",
    "basis": "out-of-corpus",
    "evidence": "refactor/apps/server/console-api.js",
    "needle": "cs.updateConfigAndSave",
    "readers": [],
    "grepConfirmed": false
  },
  "ui.refreshMs": {
    "v": "live",
    "basis": "out-of-corpus",
    "evidence": "refactor/apps/server/console-api.js",
    "needle": "cs.updateConfigAndSave",
    "readers": [],
    "grepConfirmed": false
  },
  "vector.enabled": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/assembly.js",
    "needle": "vector.enabled",
    "readers": [
      "refactor/apps/server/assembly.js"
    ],
    "grepConfirmed": true
  },
  "vector.executablePath": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/assembly.js",
    "needle": "vector.executablePath",
    "readers": [
      "refactor/apps/server/assembly.js"
    ],
    "grepConfirmed": true
  },
  "vector.logPath": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/assembly.js",
    "needle": "vector.logPath",
    "readers": [
      "refactor/apps/server/assembly.js"
    ],
    "grepConfirmed": true
  },
  "vector.modelPath": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/assembly.js",
    "needle": "vector.modelPath",
    "readers": [
      "refactor/apps/server/assembly.js"
    ],
    "grepConfirmed": true
  },
  "vector.port": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/assembly.js",
    "needle": "vector.port",
    "readers": [
      "refactor/apps/server/assembly.js"
    ],
    "grepConfirmed": true
  },
  "vector.runtime": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/apps/server/assembly.js",
    "needle": "vector.runtime",
    "readers": [
      "refactor/apps/server/assembly.js"
    ],
    "grepConfirmed": true
  },
  "wakeDelayMs": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/orchestrator/index.js",
    "needle": "wakeDelayMs",
    "readers": [
      "refactor/modules/orchestrator/index.js"
    ],
    "grepConfirmed": true
  },
  "webSearch.biliFavFolderName": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/act/executors/music-bili.js",
    "needle": "webSearch.biliFavFolderName",
    "readers": [
      "refactor/modules/act/executors/music-bili.js"
    ],
    "grepConfirmed": true
  },
  "webSearch.biliFavMediaId": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/act/executors/music-bili.js",
    "needle": "webSearch.biliFavMediaId",
    "readers": [
      "refactor/modules/act/executors/music-bili.js"
    ],
    "grepConfirmed": true
  },
  "webSearch.fetchMaxChars": {
    "v": "live",
    "basis": "full",
    "evidence": "refactor/modules/act/executors/query.js",
    "needle": "webSearch.fetchMaxChars",
    "readers": [
      "refactor/modules/act/executors/query.js"
    ],
    "grepConfirmed": true
  },
  "webSearch.maxResults": {
    "v": "live",
    "basis": "parent",
    "evidence": "refactor/modules/internet/web-search.js",
    "needle": "cfg.maxResults",
    "readers": [
      "refactor/modules/internet/web-search.js"
    ],
    "grepConfirmed": true,
    "via": "subtree"
  },
  "webSearch.searchUrl": {
    "v": "weak",
    "evidence": "refactor/modules/act/executors/query.js",
    "readers": [],
    "basis": "suffix"
  }
};
  var TALLY = {"liveGrepConfirmed":111,"liveLedgerOnly":4,"dead":13,"derived":0,"weak":10,"unlisted":0};
  var BANDS = "0–10 → 1 档（意愿强制 0%）｜10–20 → 2 档（意愿强制 0%）｜20–90 → 3 档（意愿按 (pos−20)/70 线性 0→100%）｜90–100 → 4 档（意愿 100%）";
  /** 这个配置路径是真旋钮吗？返回 {ok, why, badge} —— 面板据此禁用控件 / 加角标。 */
  function truthOf(p) {
    var row = TRUTH[p];
    if (!row) return { v: 'unlisted', ok: true, badge: '', why: '这个键没进配置台账（没人判过它是死是活）' };
    if (row.v === 'live')    return { v: 'live', ok: true, badge: '', why: '真旋钮：新树有代码读它（' + (row.evidence || '未填') + (row.grepConfirmed ? (row.via === 'subtree' ? '，本次核到父级子树读点：' + String(row.needle || '').slice(0, 60) : '，本次 grep 也独立确认了') : '；注意：本次没独立确认到读点 —— 代码里可能以局部变量拼装访问（台账为准）') + '）' };
    if (row.v === 'derived') return { v: 'derived', ok: false, badge: '派生', why: '**这不是旋钮**：它由「' + row.from + '」派生出来，改这里下次读盘就被覆盖回去（config-store/index.js 的 deriveTierFields）' };
    if (row.v === 'dead') {
      // 用户 2026-10-11 决定废弃的那一整块（短时跨群感知）：单独的说法与角标。
      // 返回的 v 仍是 'dead'（面板照旧禁用，也为了和台账对账的断言保持一致）。
      // 注意：本段位于生成器的模板字符串里，**不能出现反引号**，否则会截断模板。
      if (row.risk === 'deprecated') {
        return {
          v: 'dead', ok: false, badge: '已废弃',
          why: '**已废弃（用户 2026-10-11 决定）**：短时跨群感知整块删除，设置页入口已移除；配置文件里的值保留着，供旧版本回退使用。新树本来也没有代码读它。'
        };
      }
      return { v: 'dead', ok: false, badge: '死键', why: '**新树没有任何代码读它**：改了不生效。config-store/key-ledger.mjs 判为 dead' + (row.risk ? '（风险标记 ' + row.risk + '）' : '') };
    }
    if (row.v === 'weak')    return { v: 'weak', ok: true, badge: '接线待核', why: '台账说它是活的，但只按**叶子名**撞上了别的子树（' + ((row.readers && row.readers[0]) || row.evidence || '') + '）——读到的是另一个键，不能算证据' };
    return { v: 'unlisted', ok: true, badge: '', why: '' };
  }
  root.CONFIG_TRUTH = { byPath: TRUTH, tally: TALLY, bands: BANDS, truthOf: truthOf, of: truthOf };
})(typeof globalThis !== 'undefined' ? globalThis : window);
