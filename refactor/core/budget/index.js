// Durable request reservations. This business ledger is intentionally separate
// from observability so diagnostic rotation or loss cannot erase budget state.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const PAUSED_SOFT = ['query_embedding', 'background_embedding', 'jev', 'background_organization', 'broadcast', 'vision'];
const PAUSED_HARD = ['main_reply', ...PAUSED_SOFT];
// Shared by all budget services in this process so another service instance can
// recognize reservations that are still waiting for this process to settle them.
const PROCESS_OWNER_TOKEN = randomUUID();
const PROCESS_STARTED_AT = Number.isFinite(performance.timeOrigin) && performance.timeOrigin > 0
  ? performance.timeOrigin
  : null;

function ownerProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    // Permission and platform-specific errors do not prove the owner is gone.
    return true;
  }
}

function localDate(at = Date.now()) {
  const d = new Date(at);
  if (!Number.isFinite(d.getTime())) throw new TypeError('invalid budget date');
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function asTokens(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
function cleanId(value, max = 180) { return String(value ?? '').trim().slice(0, max); }
function estimateTokens(request, explicit) {
  const supplied = asTokens(explicit ?? request?.estimatedTokens);
  if (supplied !== null) return supplied;
  let size;
  try { size = Buffer.byteLength(JSON.stringify({ messages: request?.messages, tools: request?.tools }), 'utf8'); }
  catch { return null; }
  const output = asTokens(request?.maxTokens);
  if (output === null || output === 0) return null;
  const estimate = size + output;
  return Number.isSafeInteger(estimate) ? Math.max(1, estimate) : null;
}
function usageTokens(result) {
  const usage = result?.raw?.usage ?? result?.usage;
  const promptTokens = asTokens(usage?.prompt_tokens ?? usage?.promptTokens);
  const completionTokens = asTokens(usage?.completion_tokens ?? usage?.completionTokens);
  const totalTokens = asTokens(usage?.total_tokens ?? usage?.totalTokens)
    ?? (promptTokens !== null && completionTokens !== null && Number.isSafeInteger(promptTokens + completionTokens)
      ? promptTokens + completionTokens : null);
  return { promptTokens, completionTokens, totalTokens };
}
function timestamp(value) {
  const date = new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new TypeError('invalid budget timestamp');
  return date.toISOString();
}

function parseHardLimit(value) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    return { value: null, invalid: false };
  }
  const parsed = asTokens(value);
  return parsed === null ? { value: null, invalid: true } : { value: parsed, invalid: false };
}

const HARD_LIMIT_NOT_PROVIDED = Symbol('hard-limit-not-provided');

/**
 * Create a per-dataDir durable budget ledger.
 * A missing `hardLimitTokens` means requests have no global hard ceiling. Explicit
 * per-instance shares and durable reservation writes still apply. The 30M daily
 * threshold is soft and is never silently treated as a hard limit.
 */
export function createBudgetService({
  dataDir,
  hardLimitTokens = null,
  softLimitTokens = 30_000_000,
  instanceShares = {},
  now = () => Date.now(),
  onWarning = null
} = {}) {
  if (!dataDir) throw new TypeError('budget service requires an explicit dataDir');
  const directory = path.join(path.resolve(dataDir), 'budget');
  const file = path.join(directory, 'requests.jsonl');
  const resourceFile = path.join(directory, 'resources.jsonl');
  const initialHardLimit = parseHardLimit(hardLimitTokens);
  let hardLimit = initialHardLimit.value;
  let hardLimitInvalid = initialHardLimit.invalid;
  let softLimit = asTokens(softLimitTokens) ?? 30_000_000;
  let shares = { ...instanceShares };
  const records = new Map();
  const resourceRecords = new Map();
  // Date -> account -> aggregate. Built once after load() and maintained by
  // persist() deltas so accountUsage() no longer needs a full ledger scan.
  const usageIndex = new Map();
  let usageIndexReady = false;
  let sequence = 0;
  let queue = Promise.resolve();
  let integrity = { ok: true, reason: '', lastErrorAt: null };
  let resourceIntegrity = { ok: true, reason: '', lastErrorAt: null };
  let initialized = false;
  let unconfiguredLimitWarningWritten = false;

  function reportUnconfiguredLimit() {
    if (unconfiguredLimitWarningWritten) return;
    unconfiguredLimitWarningWritten = true;
    const message = '未配置硬额度：付费请求不设全局硬上限；显式实例份额仍会生效。';
    try {
      if (typeof onWarning === 'function') onWarning(message, { code: 'hard-limit-not-configured' });
      else console.warn(message, { code: 'hard-limit-not-configured' });
    } catch { /* diagnostic output must not affect a request */ }
  }

  function keepOpenReservationsUnknown(code, reason) {
    for (const row of records.values()) {
      if (row.status !== 'reserved') continue;
      records.set(row.requestId, { ...row, status: 'unknown', outcomeCode: code, reason, settledAt: timestamp(now()) });
    }
  }

  async function load() {
    await fs.mkdir(directory, { recursive: true });
    let raw;
    try { raw = await fs.readFile(file, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') { initialized = true; return; } throw error; }
    let incompleteTail = false;
    if (raw && !raw.endsWith('\n')) {
      integrity = { ok: false, reason: 'budget-ledger-incomplete-tail', lastErrorAt: new Date(now()).toISOString() };
      incompleteTail = true;
      const completePrefixEnd = raw.lastIndexOf('\n');
      raw = completePrefixEnd < 0 ? '' : raw.slice(0, completePrefixEnd + 1);
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); }
      catch {
        integrity = { ok: false, reason: 'budget-ledger-malformed-row', lastErrorAt: new Date(now()).toISOString() };
        keepOpenReservationsUnknown('budget-ledger-malformed-row', '账本有无法读取的行，未决预留继续按预估值计入。');
        initialized = true;
        return;
      }
      if (row?.version !== 1 || !row.requestId || !['reserved', 'settled', 'unknown', 'cancelled'].includes(row.status)) {
        integrity = { ok: false, reason: 'budget-ledger-invalid-record', lastErrorAt: new Date(now()).toISOString() };
        keepOpenReservationsUnknown('budget-ledger-invalid-record', '账本有无效账项，未决预留继续按预估值计入。');
        initialized = true;
        return;
      }
      sequence = Math.max(sequence, Number.isSafeInteger(row.sequence) && row.sequence > 0 ? row.sequence : 0);
      records.set(row.requestId, row);
    }
    if (incompleteTail) {
      keepOpenReservationsUnknown('budget-ledger-incomplete-tail', '账本尾部不完整，未决预留继续按预估值计入。');
      initialized = true;
      return;
    }
    // Same-process reservations remain reserved while in flight. A recorded PID
    // is releasable only when the OS confirms it is gone. Legacy records without
    // a PID require a valid reservation time strictly before this process started.
    for (const row of records.values()) {
      if (row.status !== 'reserved' || row.ownerProcessToken === PROCESS_OWNER_TOKEN) continue;
      let releaseCode = '';
      let releaseReason = '';
      if (!Number.isSafeInteger(row.ownerPid) || row.ownerPid <= 0) {
        const reservedAt = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
        if (Number.isFinite(PROCESS_STARTED_AT) && Number.isFinite(reservedAt) && reservedAt < PROCESS_STARTED_AT) {
          releaseCode = 'legacy-reservation-predates-process';
          releaseReason = '账项时间早于本次进程启动，按旧进程遗留预留处理，已释放估算额度。';
        } else {
          let reason = '旧格式预留没有有效时间，无法确认它早于本次进程启动，因此保留额度。';
          let outcomeCode = 'legacy-reservation-time-unverifiable';
          if (!Number.isFinite(PROCESS_STARTED_AT)) {
            reason = '无法取得本次进程启动时间，旧格式预留继续保留额度。';
            outcomeCode = 'legacy-reservation-process-start-unavailable';
          } else if (Number.isFinite(reservedAt)) {
            reason = '账项时间不早于本次进程启动，不能证明预留已失效，因此保留额度。';
            outcomeCode = 'legacy-reservation-not-before-process';
          }
          records.set(row.requestId, { ...row, status: 'unknown', outcomeCode, reason, settledAt: timestamp(now()) });
          continue;
        }
      } else {
        const ownerAlive = ownerProcessAlive(row.ownerPid);
        if (ownerAlive === false) {
          releaseCode = 'previous-process-exited-reservation-released';
          releaseReason = '上一个进程已退出，这笔预留不会再收到结算，已释放预估额度。';
        } else {
          const outcomeCode = ownerAlive === true
            ? 'reservation-owner-still-running'
            : 'reservation-owner-unverifiable';
          const reason = ownerAlive === true
            ? '写入预留的进程仍在运行，暂不能确认它不会结算，因此保留额度。'
            : '预留记录的进程号无法核实，暂不能确认它不会结算，因此保留额度。';
          records.set(row.requestId, { ...row, status: 'unknown', outcomeCode, reason, settledAt: timestamp(now()) });
          continue;
        }
      }
      if (releaseCode) {
        const released = {
          ...row, sequence: sequence + 1, status: 'cancelled', actualTokens: 0,
          promptTokens: null, completionTokens: null,
          outcomeCode: releaseCode, reason: releaseReason,
          settledAt: timestamp(now())
        };
        try { await persist(released); }
        catch (error) {
          integrity = { ok: false, reason: `budget-ledger-recovery-write-failed:${error?.code || error?.name || 'error'}`, lastErrorAt: new Date(now()).toISOString() };
          break;
        }
      }
    }
    initialized = true;
  }
  async function loadResources() {
    let raw;
    try { raw = await fs.readFile(resourceFile, 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    if (raw && !raw.endsWith('\n')) {
      resourceIntegrity = { ok: false, reason: 'resource-ledger-incomplete-tail', lastErrorAt: new Date(now()).toISOString() };
      return;
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); }
      catch {
        resourceIntegrity = { ok: false, reason: 'resource-ledger-malformed-row', lastErrorAt: new Date(now()).toISOString() };
        return;
      }
      if (row?.version !== 1 || row.kind !== 'resource' || !row.requestId) {
        resourceIntegrity = { ok: false, reason: 'resource-ledger-invalid-record', lastErrorAt: new Date(now()).toISOString() };
        return;
      }
      resourceRecords.set(row.requestId, row);
    }
  }
  const ready = load().catch((error) => {
    integrity = { ok: false, reason: `budget-ledger-read-failed:${error?.code || error?.name || 'error'}`, lastErrorAt: new Date(now()).toISOString() };
    initialized = true;
  }).then(() => {
    buildUsageIndex();
    usageIndexReady = true;
  }).then(() => loadResources().catch((error) => {
    resourceIntegrity = { ok: false, reason: `resource-ledger-read-failed:${error?.code || error?.name || 'error'}`, lastErrorAt: new Date(now()).toISOString() };
  }));

  async function persist(row) {
    const handle = await fs.open(file, 'a');
    try {
      await handle.writeFile(`${JSON.stringify(row)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    sequence = Math.max(sequence, Number.isSafeInteger(row.sequence) ? row.sequence : sequence);
    const previous = records.get(row.requestId);
    records.set(row.requestId, row);
    if (usageIndexReady) {
      if (previous !== undefined) applyUsageRowToIndex(previous, -1);
      applyUsageRowToIndex(row, 1);
    }
  }

  function createUsageBucket() {
    return { committedTokens: 0, reservedTokens: 0, unknownRequests: 0, purposeTotals: {}, instances: new Map() };
  }

  function applyUsageTokens(bucket, row, sign) {
    let tokens = 0;
    if (row.status === 'settled') tokens = row.actualTokens ?? row.estimatedTokens;
    else if (row.status === 'reserved') tokens = row.estimatedTokens;
    else if (row.status === 'unknown') { tokens = row.estimatedTokens; bucket.unknownRequests += sign; }
    else if (row.status === 'cancelled') tokens = 0;
    if (row.status === 'settled') bucket.committedTokens += sign * tokens;
    else if (row.status === 'reserved' || row.status === 'unknown') bucket.reservedTokens += sign * tokens;
    bucket.purposeTotals[row.purpose] = (bucket.purposeTotals[row.purpose] || 0) + sign * tokens;
  }

  function applyUsageRowToIndex(row, sign) {
    if (typeof row?.accountId !== 'string' || typeof row?.date !== 'string') return;
    let accounts = usageIndex.get(row.date);
    if (!accounts) {
      if (sign < 0) return;
      accounts = new Map();
      usageIndex.set(row.date, accounts);
    }
    let bucket = accounts.get(row.accountId);
    if (!bucket) {
      if (sign < 0) return;
      bucket = createUsageBucket();
      accounts.set(row.accountId, bucket);
    }
    applyUsageTokens(bucket, row, sign);
    if (typeof row.instanceId !== 'string') return;
    let instanceBucket = bucket.instances.get(row.instanceId);
    if (!instanceBucket) {
      if (sign < 0) return;
      instanceBucket = createUsageBucket();
      bucket.instances.set(row.instanceId, instanceBucket);
    }
    applyUsageTokens(instanceBucket, row, sign);
  }

  function buildUsageIndex() {
    usageIndex.clear();
    for (const row of records.values()) applyUsageRowToIndex(row, 1);
  }

  function scanAccountUsage(accountId, date, instanceId = '') {
    let committed = 0;
    let reserved = 0;
    let unknown = 0;
    const purposeTotals = {};
    for (const row of records.values()) {
      if (row.accountId !== accountId || row.date !== date) continue;
      if (instanceId && row.instanceId !== instanceId) continue;
      let tokens = 0;
      if (row.status === 'settled') tokens = row.actualTokens ?? row.estimatedTokens;
      else if (row.status === 'reserved') tokens = row.estimatedTokens;
      else if (row.status === 'unknown') { tokens = row.estimatedTokens; unknown += 1; }
      else if (row.status === 'cancelled') tokens = 0;
      if (row.status === 'settled') committed += tokens;
      else if (row.status === 'reserved' || row.status === 'unknown') reserved += tokens;
      purposeTotals[row.purpose] = (purposeTotals[row.purpose] || 0) + tokens;
    }
    return { committedTokens: committed, reservedTokens: reserved, usedTokens: committed + reserved, unknownRequests: unknown, purposeTotals };
  }

  function accountUsage(accountId, date, instanceId = '') {
    if (!usageIndexReady) return scanAccountUsage(accountId, date, instanceId);
    const accounts = usageIndex.get(date);
    const bucket = accounts ? accounts.get(accountId) : undefined;
    const target = instanceId ? (bucket ? bucket.instances.get(instanceId) : undefined) : bucket;
    if (!target) return { committedTokens: 0, reservedTokens: 0, usedTokens: 0, unknownRequests: 0, purposeTotals: {} };
    return {
      committedTokens: target.committedTokens,
      reservedTokens: target.reservedTokens,
      usedTokens: target.committedTokens + target.reservedTokens,
      unknownRequests: target.unknownRequests,
      purposeTotals: { ...target.purposeTotals }
    };
  }

  function getStatus({ accountId = '', instanceId = '', at = now() } = {}) {
    const account = cleanId(accountId);
    const instance = cleanId(instanceId);
    const date = localDate(at);
    const usage = accountUsage(account, date);
    const instanceUsage = instance ? accountUsage(account, date, instance) : null;
    const instanceShare = instance && asTokens(shares[instance]) !== null ? asTokens(shares[instance]) : null;
    const hardBalance = hardLimit === null ? null : Math.max(0, hardLimit - usage.usedTokens);
    const shareBalance = instanceShare === null || !instanceUsage ? null : Math.max(0, instanceShare - instanceUsage.usedTokens);
    let level = 'normal';
    let reason = '';
    let pausedPurposes = [];
    if (!integrity.ok) {
      level = 'unreliable'; reason = integrity.reason; pausedPurposes = [...PAUSED_HARD];
    } else if (hardLimitInvalid) {
      level = 'unreliable'; reason = 'invalid-hard-limit-configuration'; pausedPurposes = [...PAUSED_HARD];
    } else if (hardLimit === null) {
      level = 'unconfigured'; reason = 'hard-limit-not-configured';
    } else if (usage.usedTokens >= hardLimit) {
      level = 'hard-limit'; reason = 'hard-daily-limit-reached'; pausedPurposes = [...PAUSED_HARD];
    } else if (usage.usedTokens >= softLimit) {
      level = 'soft-limit'; reason = 'soft-daily-limit-reached'; pausedPurposes = [...PAUSED_SOFT];
    }
    return {
      date, accountId: account, instanceId: instance || null,
      usedTokens: usage.usedTokens, committedTokens: usage.committedTokens,
      reservedTokens: usage.reservedTokens, unknownRequests: usage.unknownRequests,
      hardLimitTokens: hardLimit, hardBalanceTokens: hardBalance,
      hardLimitConfigured: hardLimit !== null && !hardLimitInvalid,
      hardLimitMode: hardLimitInvalid ? 'invalid' : (hardLimit === null ? 'unbounded' : 'enforced'),
      softLimitTokens: softLimit, instanceShareTokens: instanceShare,
      instanceBalanceTokens: shareBalance,
      balanceTokens: hardBalance === null ? null : (shareBalance === null ? hardBalance : Math.min(hardBalance, shareBalance)),
      purposeTotals: { ...usage.purposeTotals }, level, reason, pausedPurposes,
      integrity: { ...integrity }
    };
  }

  async function reserve(input = {}) {
    await ready;
    const requestId = cleanId(input.requestId, 220);
    const accountId = cleanId(input.accountId);
    const purpose = cleanId(input.purpose, 64);
    const model = cleanId(input.model, 180);
    const instanceId = cleanId(input.instanceId, 120);
    const estimatedTokens = asTokens(input.estimatedTokens);
    if (!requestId || !accountId || !purpose || !model || estimatedTokens === null) {
      return { ok: false, status: 'rejected', reason: 'invalid-reservation-fields', record: null };
    }
    let result;
    queue = queue.then(async () => {
      const existing = records.get(requestId);
      if (existing) {
        if (existing.accountId !== accountId || (existing.instanceId || '') !== instanceId) {
          result = { ok: false, status: 'rejected', reason: 'request-id-conflict', record: null };
        } else result = { ok: false, status: 'replay', reason: 'request-id-already-recorded', record: { ...existing } };
        return;
      }
      const status = getStatus({ accountId, instanceId, at: input.at ?? now() });
      if (!integrity.ok) { result = { ok: false, status: 'rejected', reason: integrity.reason, record: null }; return; }
      if (hardLimitInvalid) { result = { ok: false, status: 'rejected', reason: 'invalid-hard-limit-configuration', record: null }; return; }
      if (hardLimit !== null && status.usedTokens + estimatedTokens > hardLimit) {
        result = { ok: false, status: 'rejected', reason: 'hard-daily-limit-exceeded', record: null }; return;
      }
      const instanceShare = status.instanceShareTokens;
      if (instanceShare !== null && accountUsage(accountId, status.date, instanceId).usedTokens + estimatedTokens > instanceShare) {
        result = { ok: false, status: 'rejected', reason: 'instance-share-exceeded', record: null }; return;
      }
      const row = {
        version: 1, sequence: sequence + 1, requestId,
        ownerPid: process.pid, ownerProcessToken: PROCESS_OWNER_TOKEN,
        accountId, instanceId: instanceId || null, purpose, model,
        chatKey: cleanId(input.chatKey), personId: cleanId(input.personId) || null,
        sourceId: cleanId(input.sourceId) || null, turnId: cleanId(input.turnId),
        hardLimitConfigured: status.hardLimitConfigured, hardLimitMode: status.hardLimitMode,
        estimatedTokens, actualTokens: null, promptTokens: null, completionTokens: null,
        status: 'reserved', date: status.date, at: timestamp(input.at ?? now())
      };
      try {
        await persist(row);
        result = {
          ok: true, status: 'reserved', reason: '', record: { ...row },
          hardLimitConfigured: status.hardLimitConfigured, hardLimitMode: status.hardLimitMode,
          budgetReason: status.reason
        };
        if (!status.hardLimitConfigured) reportUnconfiguredLimit();
      }
      catch (error) {
        integrity = { ok: false, reason: `budget-ledger-write-failed:${error?.code || error?.name || 'error'}`, lastErrorAt: new Date(now()).toISOString() };
        result = { ok: false, status: 'rejected', reason: integrity.reason, record: null };
      }
    }).catch((error) => { integrity = { ok: false, reason: `budget-ledger-write-failed:${error?.code || error?.name || 'error'}`, lastErrorAt: new Date(now()).toISOString() }; result = { ok: false, status: 'rejected', reason: integrity.reason, record: null }; });
    await queue;
    return result;
  }

  async function settle(input = {}) {
    await ready;
    const requestId = cleanId(input.requestId, 220);
    let result;
    queue = queue.then(async () => {
      const existing = records.get(requestId);
      if (!existing) { result = { ok: false, reason: 'reservation-not-found', record: null }; return; }
      const status = ['settled', 'unknown', 'cancelled'].includes(input.status) ? input.status : 'unknown';
      if (existing.status !== 'reserved') {
        const same = existing.status === status && (status !== 'settled' || existing.actualTokens === asTokens(input.actualTokens));
        result = same ? { ok: true, replay: true, record: { ...existing } } : { ok: false, reason: 'reservation-already-final', record: { ...existing } };
        return;
      }
      const promptTokens = asTokens(input.promptTokens);
      const completionTokens = asTokens(input.completionTokens);
      const componentTotal = promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null;
      const actualTokens = status === 'settled'
        ? (asTokens(input.actualTokens) ?? (componentTotal !== null && Number.isSafeInteger(componentTotal) ? componentTotal : null))
        : status === 'cancelled' ? 0 : null;
      const finalStatus = status === 'settled' && actualTokens === null ? 'unknown' : status;
      const row = {
        ...existing, sequence: sequence + 1, status: finalStatus,
        actualTokens: finalStatus === 'settled' ? actualTokens : null,
        promptTokens: finalStatus === 'settled' ? promptTokens : null,
        completionTokens: finalStatus === 'settled' ? completionTokens : null,
        outcomeCode: cleanId(input.outcomeCode, 64) || null,
        settledAt: timestamp(input.at ?? now())
      };
      try { await persist(row); result = { ok: true, replay: false, record: { ...row } }; }
      catch (error) {
        integrity = { ok: false, reason: `budget-ledger-write-failed:${error?.code || error?.name || 'error'}`, lastErrorAt: new Date(now()).toISOString() };
        result = { ok: false, reason: integrity.reason, record: null };
      }
    }).catch((error) => { integrity = { ok: false, reason: `budget-ledger-write-failed:${error?.code || error?.name || 'error'}`, lastErrorAt: new Date(now()).toISOString() }; result = { ok: false, reason: integrity.reason, record: null }; });
    await queue;
    return result;
  }

  async function lookup(requestId) {
    await ready;
    const row = records.get(cleanId(requestId, 220));
    return row ? { ...row } : null;
  }

  async function recordResourceUsage(input = {}) {
    await ready;
    const requestId = cleanId(input.requestId, 220);
    const purpose = cleanId(input.purpose, 64);
    const model = cleanId(input.model, 180);
    const resourceKind = cleanId(input.resourceKind, 64);
    const durationMs = asTokens(input.durationMs);
    if (!requestId || !purpose || !model || !resourceKind || durationMs === null) {
      return { ok: false, status: 'rejected', reason: 'invalid-resource-fields', record: null };
    }
    let result;
    queue = queue.then(async () => {
      const existing = resourceRecords.get(requestId);
      if (existing) { result = { ok: false, status: 'replay', reason: 'resource-request-already-recorded', record: { ...existing } }; return; }
      if (!resourceIntegrity.ok) { result = { ok: false, status: 'rejected', reason: resourceIntegrity.reason, record: null }; return; }
      const row = {
        version: 1, kind: 'resource', requestId,
        accountId: cleanId(input.accountId) || null, instanceId: cleanId(input.instanceId, 120) || null,
        purpose, model, resourceKind, durationMs,
        memoryBytes: asTokens(input.memoryBytes), at: timestamp(input.at ?? now())
      };
      try {
        const handle = await fs.open(resourceFile, 'a');
        try { await handle.writeFile(`${JSON.stringify(row)}\n`, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        resourceRecords.set(requestId, row);
        result = { ok: true, status: 'recorded', record: { ...row } };
      } catch (error) {
        resourceIntegrity = { ok: false, reason: `resource-ledger-write-failed:${error?.code || error?.name || 'error'}`, lastErrorAt: new Date(now()).toISOString() };
        result = { ok: false, status: 'rejected', reason: resourceIntegrity.reason, record: null };
      }
    }).catch((error) => {
      resourceIntegrity = { ok: false, reason: `resource-ledger-write-failed:${error?.code || error?.name || 'error'}`, lastErrorAt: new Date(now()).toISOString() };
      result = { ok: false, status: 'rejected', reason: resourceIntegrity.reason, record: null };
    });
    await queue;
    return result;
  }

  async function listResourceUsage() {
    await ready;
    return [...resourceRecords.values()].map((row) => ({ ...row }));
  }

  function configure({ hardLimitTokens: nextHard = HARD_LIMIT_NOT_PROVIDED, softLimitTokens: nextSoft = softLimit, instanceShares: nextShares = shares, accountId = '', instanceId = '', at = now() } = {}) {
    if (nextHard !== HARD_LIMIT_NOT_PROVIDED) {
      const wasUnconfigured = hardLimit === null && !hardLimitInvalid;
      const parsed = parseHardLimit(nextHard);
      hardLimit = parsed.value;
      hardLimitInvalid = parsed.invalid;
      if (!wasUnconfigured && hardLimit === null && !hardLimitInvalid) unconfiguredLimitWarningWritten = false;
    }
    softLimit = asTokens(nextSoft) ?? softLimit;
    shares = { ...nextShares };
    return getStatus({ accountId, instanceId, at });
  }

  return {
    directory, file, resourceFile, ready, reserve, settle, lookup, getStatus, configure,
    recordResourceUsage, listResourceUsage,
    async flush() { await ready; await queue; },
    stats() { return { integrity: { ...integrity }, resourceIntegrity: { ...resourceIntegrity }, requestCount: records.size, resourceRecordCount: resourceRecords.size, file, resourceFile }; },
    newRequestId() { return randomUUID(); }
  };
}

/** Persist a reservation before invoking a caller's one-fetch function, then settle actual usage. */
export async function executeBudgetedRequest({ budgetService, budgetRequest = {}, estimatedTokens = null, request = {}, model = '', invoke } = {}) {
  const requestId = cleanId(budgetRequest.requestId, 220);
  if (!budgetService || typeof budgetService.reserve !== 'function' || typeof budgetService.settle !== 'function') {
    return { ok: false, requestId: requestId || null, actualCalls: 0, reason: 'budget-service-unavailable', result: null };
  }
  if (!requestId) return { ok: false, requestId: null, actualCalls: 0, reason: 'request-id-required', result: null };
  if (typeof invoke !== 'function') return { ok: false, requestId, actualCalls: 0, reason: 'request-invoker-required', result: null };
  const estimate = estimateTokens(request, estimatedTokens ?? budgetRequest.estimatedTokens);
  if (estimate === null) return { ok: false, requestId, actualCalls: 0, reason: 'request-estimate-unavailable', result: null };
  let reservation;
  try {
    reservation = await budgetService.reserve({ ...budgetRequest, requestId, model: String(budgetRequest.model || model), estimatedTokens: estimate });
  } catch (error) {
    return { ok: false, requestId, actualCalls: 0, reason: `reservation-failed:${error?.code || error?.name || 'error'}`, result: null };
  }
  if (reservation?.status === 'replay') {
    return { ok: false, replayed: true, requestId, actualCalls: 0, reason: reservation.reason, existing: reservation.record, result: null };
  }
  if (!reservation?.ok) {
    return { ok: false, replayed: false, requestId, actualCalls: 0, reason: reservation?.reason || 'reservation-rejected', existing: reservation?.record || null, result: null };
  }
  const settle = (input) => budgetService.settle({ requestId, ...input });
  if (request.signal?.aborted) {
    const settlement = await settle({ status: 'cancelled', outcomeCode: 'aborted-before-fetch' });
    return { ok: false, requestId, actualCalls: 0, cancelled: true, reason: 'aborted-before-fetch', settlement, result: null };
  }
  let actualCalls = 0;
  try {
    const result = await invoke({ onFetchStart() { actualCalls += 1; } });
    const usage = usageTokens(result);
    const usageKnown = usage.totalTokens !== null;
    const settlement = await settle({
      status: usageKnown ? 'settled' : 'unknown', ...usage,
      outcomeCode: usageKnown ? 'response-usage' : 'response-without-usage'
    });
    return {
      ok: true, requestId, actualCalls, usageState: usageKnown ? 'known' : 'unknown', settlement,
      hardLimitConfigured: reservation.hardLimitConfigured,
      hardLimitMode: reservation.hardLimitMode,
      budgetReason: reservation.budgetReason,
      result
    };
  } catch (error) {
    const sent = actualCalls > 0;
    const settlement = await settle({ status: sent ? 'unknown' : 'cancelled', outcomeCode: sent ? 'request-sent-without-usage' : 'request-not-sent' });
    return {
      ok: false, requestId, actualCalls, usageState: sent ? 'unknown' : 'not-sent',
      reason: String(error?.message || error || 'request-failed'), settlement, result: null
    };
  }
}

export { localDate as budgetLocalDate };
