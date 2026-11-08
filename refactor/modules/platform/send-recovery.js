/**
 * Bounded recovery for segments explicitly rejected by before-send.
 * Only `blocked` is proof that a segment was not sent. Failed/throwing sends
 * have an unknown delivery result and are recorded, never retried.
 * Every retry uses sender.sendTextBatch, so hooks, rate limits and dedupe apply.
 */
export const SEND_RECOVERY_MAX_RETRIES = 2;
export const SEND_RECOVERY_ATTEMPT_TIMEOUT_MS = 2000;
export const SEND_RECOVERY_ROUND_BUDGET_MS = 2000;

const asArray = (value) => Array.isArray(value) ? value : [];
const shortError = (error) => String(error?.message ?? error ?? 'unknown send error').slice(0, 240);

function blockedRows(result) {
  return asArray(result?.blocked).map((row, fallbackIndex) => ({
    segmentIndex: Number.isInteger(row?.index) ? row.index : fallbackIndex,
    segmentPath: [Number.isInteger(row?.index) ? row.index : fallbackIndex],
    text: String(row?.text ?? ''),
    atUserId: row?.atUserId ?? null,
    reason: shortError(row?.reason || 'blocked by before-send'),
    attempts: 0
  }));
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('send recovery timed out')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createSendRecovery(result, { now = Date.now() } = {}) {
  const sent = asArray(result?.sent);
  const failed = [...asArray(result?.failed), ...asArray(result?.unknown)];
  return {
    createdAt: now,
    sentCount: sent.length,
    delivered: sent.map((row) => ({ text: String(row?.text ?? ''), messageId: row?.messageId ?? null, at: row?.at ?? null })),
    retryRounds: 0,
    pending: blockedRows(result),
    uncertain: failed.map((row) => ({
      segmentIndex: Number.isInteger(row?.index) ? row.index : null,
      segmentPath: Number.isInteger(row?.index) ? [row.index] : [],
      reason: shortError(row?.error || 'send result is uncertain')
    }))
  };
}

/** Retry one bounded round of explicitly blocked segments, one segment at a time. */
export async function retryBlockedOnce(sender, chatKey, recovery, {
  timeoutMs = SEND_RECOVERY_ATTEMPT_TIMEOUT_MS,
  roundBudgetMs = SEND_RECOVERY_ROUND_BUDGET_MS,
  sendOptions = {}
} = {}) {
  if (!recovery || !Array.isArray(recovery.pending) || !recovery.pending.length) return recovery;

  const current = recovery.pending;
  recovery.pending = [];
  recovery.retryRounds = (Number(recovery.retryRounds) || 0) + 1;
  const deadline = Date.now() + Math.max(1, Number(roundBudgetMs) || SEND_RECOVERY_ROUND_BUDGET_MS);

  for (let index = 0; index < current.length; index += 1) {
    const segment = current[index];
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      recovery.pending.push(...current.slice(index));
      break;
    }
    if (!String(segment.text ?? '').trim()) {
      recovery.uncertain.push({
        segmentIndex: segment.segmentIndex,
        segmentPath: [...segment.segmentPath],
        reason: 'blocked segment text was unavailable; not resent'
      });
      continue;
    }
    try {
      // Use the per-block record, not the batch-level atUserId: only original
      // segment zero carries the mention, and a later blocked segment must not
      // inherit it just because its retry becomes local index zero.
      const options = { ...sendOptions, atUserId: segment.atUserId ?? null };
      const pendingSend = Promise.resolve().then(() => sender.sendTextBatch(chatKey, [segment.text], options));
      const attemptTimeout = Math.min(remainingMs,
        Math.max(1, Number(timeoutMs) || SEND_RECOVERY_ATTEMPT_TIMEOUT_MS));
      const result = await withTimeout(pendingSend, attemptTimeout);
      const sent = asArray(result?.sent);
      const blocked = asArray(result?.blocked);
      const failed = [...asArray(result?.failed), ...asArray(result?.unknown)];
      recovery.sentCount += sent.length;
      recovery.delivered.push(...sent.map((row) => ({
        text: String(row?.text ?? segment.text), messageId: row?.messageId ?? null, at: row?.at ?? null
      })));

      for (const row of blocked) {
        const childIndex = Number.isInteger(row?.index) ? row.index : 0;
        recovery.pending.push({
          segmentIndex: segment.segmentIndex,
          segmentPath: [...segment.segmentPath, childIndex],
          text: String(row?.text ?? segment.text),
          atUserId: row?.atUserId ?? segment.atUserId ?? null,
          reason: shortError(row?.reason || 'blocked by before-send'),
          attempts: (Number(segment.attempts) || 0) + 1
        });
      }
      for (const row of failed) {
        recovery.uncertain.push({
          segmentIndex: segment.segmentIndex,
          segmentPath: [...segment.segmentPath, ...(Number.isInteger(row?.index) ? [row.index] : [])],
          reason: shortError(row?.error || 'send result is uncertain')
        });
      }
      if (!sent.length && !blocked.length && !failed.length) {
        recovery.uncertain.push({
          segmentIndex: segment.segmentIndex,
          segmentPath: [...segment.segmentPath],
          reason: 'send returned no delivery outcome'
        });
      }
    } catch (error) {
      // A timeout/rejection may arrive after the remote side accepted the text.
      // Never retry an outcome that is not an explicit before-send block.
      recovery.uncertain.push({
        segmentIndex: segment.segmentIndex,
        segmentPath: [...segment.segmentPath],
        reason: shortError(error)
      });
    }
  }
  return recovery;
}

export async function recoverBlockedSegments(sender, chatKey, result, options = {}) {
  const recovery = createSendRecovery(result, options);
  const maxRetries = Math.min(SEND_RECOVERY_MAX_RETRIES,
    Math.max(0, Math.trunc(Number(options.maxRetries ?? SEND_RECOVERY_MAX_RETRIES) || 0)));
  while (recovery.pending.length && recovery.retryRounds < maxRetries) {
    await retryBlockedOnce(sender, chatKey, recovery, options);
  }
  recovery.exhausted = recovery.pending.length > 0;
  return recovery;
}

export function sendRecoverySummary(recovery) {
  const pending = Array.isArray(recovery?.pending) ? recovery.pending : [];
  const uncertain = Array.isArray(recovery?.uncertain) ? recovery.uncertain : [];
  return {
    sentCount: Number(recovery?.sentCount) || 0,
    blockedCount: pending.length,
    failedCount: uncertain.length,
    retryRounds: Number(recovery?.retryRounds) || 0,
    exhausted: recovery?.exhausted === true || (pending.length > 0
      && (Number(recovery?.retryRounds) || 0) >= SEND_RECOVERY_MAX_RETRIES),
    delivered: asArray(recovery?.delivered).map((row) => ({
      text: String(row?.text ?? ''), messageId: row?.messageId ?? null, at: row?.at ?? null
    })),
    pending: pending.map((row) => ({
      segmentIndex: row.segmentIndex,
      segmentPath: [...row.segmentPath],
      text: row.text,
      atUserId: row.atUserId ?? null,
      reason: row.reason,
      attempts: row.attempts
    })),
    uncertain: uncertain.map((row) => ({ ...row, segmentPath: [...row.segmentPath] }))
  };
}

export function isSendRecoveryComplete(recovery) {
  return (recovery?.pending?.length || 0) === 0 && (recovery?.uncertain?.length || 0) === 0;
}
