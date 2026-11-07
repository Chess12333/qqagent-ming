/** Bounded, same-chat keyword recall over the M6 raw chat archive. */
import fs from 'node:fs';
import { createChatStore, messagesDir, coldDir } from './chat-store.js';
import { selfRowVisibleNow } from '../emotion/persona-hygiene.js';
import { namedSuppressedEvidenceIds, ledgerHealthOf } from './suppressions.js';
import { openStore, getEvidence } from './store.js';
import { buildCoverage } from './coverage.js';

const MAX_QUERY_CHARS = 240;
const MAX_SCAN = 1000;
const MAX_RESULTS = 8;

function scopeOf(chatKey) {
  const key = String(chatKey ?? '');
  return { accountId: 'default', kind: key.startsWith('private:') ? 'private' : 'group', chatKey: key };
}

function failClosed(reason, chatKey) {
  return {
    ok: false,
    status: 501,
    error: `not-ported: memory.searchChatMessages() ${reason}`,
    // 出问题时也按**同一形状**回（§6.3）：coverage 说 `degraded`，调用方不用另外防一个 undefined。
    coverage: buildCoverage({ state: 'degraded', scope: scopeOf(chatKey), stateReason: String(reason).slice(0, 120) }),
  };
}

function termsOf(value) {
  const normalized = String(value).normalize('NFKC').toLowerCase();
  const runs = normalized.match(/[\p{Script=Han}]+|[a-z0-9]+/gu) || [];
  const terms = new Set();
  for (const run of runs) {
    if (/^\p{Script=Han}+$/u.test(run)) {
      if (run.length === 1) terms.add(run);
      else for (let i = 0; i < run.length - 1; i += 1) terms.add(run.slice(i, i + 2));
    } else if (run.length >= 2) {
      terms.add(run);
    }
  }
  return [...terms];
}

function checkReadableDirectory(dir, { required = false } = {}) {
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (error) {
    if (!required && error?.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isDirectory()) throw new Error(`source-not-directory:${dir}`);
  fs.accessSync(dir, fs.constants.R_OK);
}

/**
 * 被点名忘掉编号 → **存档行身份**（M6 读点①专用；见 `searchChatMessages` 里那段说明）。
 *
 * 存档行里没有证据编号，所以只能把编号先换成能对上行的东西：
 *   · `mids`：证据 id 本身就是消息 id（实时路径如此，`orchestrator/index.js:2420`）；
 *   · `sources`：`(发言人, 时刻)` —— 证据行的 `at` 与 `speakerId` 直接抄自同一条存档消息
 *     （`scenario/evidence.js:91-97`），所以能与 `row.ts` / `row.senderId` 精确相等。
 * 只收**本 chatKey** 的证据行（检索范围永不放宽）。
 * 账本读不动、或编号在账本里没有对应行 ⇒ 什么都不加 ⇒ 一律放行：
 *   迁移证据（`mig-ev:*`）是照老树印象文本造的，本就不指向存档行，硬当"已抑制"会把检索静默切断。
 */
function namedSourceKeys(ids, { dataDir, chatKey }) {
  const mids = new Set();
  const sources = [];
  if (!(ids instanceof Set) || ids.size === 0) return { mids, sources };
  let store = null;
  try {
    store = openStore(dataDir);
  } catch {
    return { mids, sources };
  }
  for (const id of ids) {
    let ev = null;
    try {
      ev = getEvidence(store, id);
    } catch { /* 单条查不到不影响其余 */ }
    if (!ev) continue;
    if (String(ev.chatKey ?? '') !== String(chatKey)) continue;
    mids.add(String(id));
    const speakerId = String(ev.speakerId ?? '');
    const at = Number(ev.at) || 0;
    if (speakerId && at) sources.push({ speakerId, at });
  }
  return { mids, sources };
}

/** 一条存档行是否正是被点名字忘掉的那几条来源之一（只比身份，不比时间窗口）。 */
function rowMatchesNamedSource(row, { mids, sources }) {
  if (mids.size) {
    if (row?.mid !== null && row?.mid !== undefined && mids.has(String(row.mid))) return true;
    if (row?.id !== null && row?.id !== undefined && mids.has(String(row.id))) return true;
  }
  if (!sources.length) return false;
  const senderId = String(row?.senderId ?? '');
  const ts = Number(row?.ts) || 0;
  if (!senderId || !ts) return false;
  return sources.some((s) => s.speakerId === senderId && s.at === ts);
}

/**
 * ★ 2026-10-16（遗忘边界 · 历史读侧）：给"权威读侧出模前"的**每轮**过滤器（存档行口径）。
 *
 * 与 `searchChatMessages` 的 M6 读点①共用上面同一份映射/判定（不复制第二套）：
 *   · 判据 = `namedSuppressedEvidenceIds`（只比被**点名**的编号；`reinstate` 后自动退场）；
 *   · 编号 → 存档行身份（`mid` 或 `(senderId, 时刻)`），只收本 chatKey 的证据行；
 *   · 判不出身份的一律放行（判不了 ≠ 已抑制），别的会话/此人以后的新发言不连坐。
 *
 * 调用方纪律：
 *   · **每轮现取、不要缓存结果** —— `forget()`/`reinstate()` 不改 ChatStore 的 sourceRevision，
 *     缓存会把遗忘拖到下一轮，甚至让 reinstate 后仍不回显。
 *   · 账本读不全时暂停本次召回并给出原因，避免已遗忘内容复活。
 *
 * @param {{dataDir?:string, chatKey:string}} opts `dataDir` 显式优先（缺省走 data-dir.js 全局解析）
 * @returns {{hide:(row:object)=>boolean, namedIds:number, mappedMids:number, mappedSources:number, reason:string}}
 */
export function namedSourceSuppressionFilter({ dataDir, chatKey } = {}) {
  let ids;
  try {
    ids = namedSuppressedEvidenceIds({ dataDir });
    if (!ledgerHealthOf(ids).ok) throw Object.assign(new Error("suppression-ledger-unreadable"), { code: "LEDGER_UNREADABLE" });
  } catch (error) {
    return {
      hide: () => true, namedIds: 0, mappedMids: 0, mappedSources: 0,
      reason: `suppression-table-unavailable:${String(error?.code || error?.name || 'error')}`
    };
  }
  if (!ids.size) return { hide: () => false, namedIds: 0, mappedMids: 0, mappedSources: 0, reason: '' };
  const named = namedSourceKeys(ids, { dataDir, chatKey });
  return {
    hide: (row) => rowMatchesNamedSource(row, named),
    namedIds: ids.size, mappedMids: named.mids.size, mappedSources: named.sources.length, reason: ''
  };
}

/**
 * Search only the explicitly selected chat's most recent bounded message window.
 * Scope is never widened here; callers that want another chat must make another call.
 * Missing/unreadable archive sources return a named 501 result, never an empty hit list.
 *
 * ★ 双人格读侧过滤（2026-10-13）：`personaTwo` / `hygiene` 由调用方注入，判据是
 *   `modules/emotion/persona-hygiene.js` 那**一份**（与 compose / 提示词同口径）。
 *   不给 `personaTwo` ⇒ 按第一人格在位处理（隐去带 `persona2` 标的自发言）；
 *   存量自发言没有那个标 ⇒ 第一人格在位时与改动前逐字节一致（零迁移）；
 *   红在位时这类行是否隐去，由 `hideFirstPersonaHistory` 决定（defaults 为 true ⇒ 两个方向都隔离）。
 *
 * ★ 抑制账本读侧过滤（M6 读点①，2026-10-14）：被 `forget()` 点名字忘掉的那几条来源，
 *   在**这一层**（检索出口）收口 —— 存档行不随遗忘消失，而关键词检索是模型能直接点到的另一条腿，
 *   只在别处拦等于放开这一个口子。隐去几条走 `suppressionHiddenRows`（只给排障与自测计数，不含正文）。
 */
export function searchChatMessages(query, {
  chatKey,
  dataDir,
  limit = MAX_RESULTS,
  maxScan = MAX_SCAN,
  personaTwo = false,
  hygiene = {},
} = {}) {
  const key = String(chatKey ?? '').trim();
  const q = String(query ?? '').trim();
  if (!/^(?:group|private):[A-Za-z0-9_-]{1,64}$/.test(key)) {
    return { ok: false, status: 400, error: 'chatKey must be one explicit group:<id> or private:<id> scope' };
  }
  if (!q) return { ok: false, status: 400, error: 'query must be non-empty' };
  if (q.length > MAX_QUERY_CHARS) return { ok: false, status: 400, error: `query exceeds ${MAX_QUERY_CHARS} characters` };
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    return failClosed('requires explicit dataDir; source is unavailable', key);
  }
  const terms = termsOf(q);
  if (!terms.length) return { ok: false, status: 400, error: 'query has no searchable terms' };

  let messages;
  let personaHiddenRows = 0;
  let suppressionHiddenRows = 0;
  // coverage 用的存档读数（本出口**从最新往旧**扫一个有界窗口，见下面 `outOfWindowCount` 那段）。
  let scannedRows = 0;
  let windowTopTs = null;
  let archiveTotal = null;
  let archiveHighWaterTs = null;
  try {
    const store = createChatStore({ dataDir: dataDir.trim() });
    // ★ 2026-10-17（qwen3 审查修）：这两次目录解析必须带调用方显式给的 dataDir。
    //   `messagesDir()/coldDir()` 不带参时走 `data-dir.js` 的**全局解析**（override / QQ_AGENT_DATA_DIR），
    //   与本出口(:168 起)强制要求的显式 `dataDir` 不是同一个来源 ⇒ 改前校验的是**别人的目录**：
    //   · 全局没配置时 `getDataDir()` 直接抛错 ⇒ 明明给了合法 dataDir，检索照样 failClosed；
    //   · 双号两目录不同时 ⇒ `required:true` 量的是另一一号的热段：它缺失就把本号的历史检索整个打死，
    //     它存在又读不出问题时则形同没校验（`store.getHealth()` 才是本号的真健康）。
    const hotDir = messagesDir(dataDir.trim());
    const cold = coldDir(dataDir.trim());
    checkReadableDirectory(hotDir, { required: true });
    checkReadableDirectory(cold);
    const scanLimit = Math.max(1, Math.min(MAX_SCAN, Math.floor(Number(maxScan) || MAX_SCAN)));
    const read = store.recent(key, { limit: scanLimit, offset: 0, includeSelf: true });
    scannedRows = read.length;
    windowTopTs = read.length ? Math.max(...read.map((row) => Number(row?.ts) || 0)) : null;
    const meta = store.getChatMeta(key);
    archiveTotal = Number.isFinite(Number(meta?.total)) ? Number(meta.total) : null;
    archiveHighWaterTs = Number.isFinite(Number(meta?.lastTs)) ? Number(meta.lastTs) : null;
    // 读侧隔离：另一人格说过的话**不进候选**（群友行恒可见；无标行 = 第一人格 ⇒ 恒可见）
    const personaKept = read.filter((row) => selfRowVisibleNow(row, { personaTwo, hygiene }));
    personaHiddenRows = read.length - personaKept.length;
    // ★ M6 读点①（2026-10-14）：被**点名字**忘掉的那几条来源，不许再被关键词检索捞回来。
    //   改前这里只按双人格标过滤：`forget()` 不动聊天存档行，检索侧也不核对抑制账本
    //   ⇒ 用户说"忘掉这件事"之后，模型调一次关键词检索就能看到原文（= 假忘）。
    //   判据与两条观察腿同一份（`suppressions.js namedSuppressedEvidenceIds`）：**只比编号**，
    //   不用 `[from, ∞)` 窗口 —— 窗口按 (会话, 发言人) 封人，读侧照抄会连坐没被忘的旧消息。
    //   存档行没有证据编号，所以先由证据账本把编号换成行身份（见 `namedSourceKeys`）；
    //   换不出身份的编号一律放行（判不了 ≠ 已抑制：一律拦等于把这条会话的检索静默切断）。
    const suppressIds = namedSuppressedEvidenceIds({ dataDir: dataDir.trim() });
    if (!ledgerHealthOf(suppressIds).ok) return failClosed("suppression-ledger-unreadable", key);
    const named = namedSourceKeys(suppressIds, { dataDir: dataDir.trim(), chatKey: key });
    messages = personaKept.filter((row) => !rowMatchesNamedSource(row, named));
    suppressionHiddenRows = personaKept.length - messages.length;
    const health = store.getHealth();
    if (health.corrupt.length) {
      const details = health.corrupt.map((entry) => `${entry.reason}`).join(', ');
      return failClosed(`source unreadable (${details})`, key);
    }
  } catch (error) {
    return failClosed(`source unavailable (${String(error?.code || error?.message || error)})`, key);
  }

  const scored = [];
  const seenIds = new Set();
  for (const message of messages) {
    const identity = message?.mid !== undefined && message?.mid !== null
      ? `mid:${String(message.mid)}`
      : `local:${String(message?.id ?? '')}`;
    if (seenIds.has(identity)) continue;
    seenIds.add(identity);
    const text = String(message?.text ?? '');
    const normalized = text.normalize('NFKC').toLowerCase();
    const matched = terms.filter((term) => normalized.includes(term));
    if (!matched.length) continue;
    const phrase = normalized.includes(q.normalize('NFKC').toLowerCase()) ? 1 : 0;
    const score = matched.length * 10 + phrase * 2;
    scored.push({
      id: message.id ?? null,
      mid: message.mid ?? null,
      at: Number(message.ts) || 0,
      senderId: message.senderId ?? '',
      senderName: message.senderName ?? '',
      self: message.self === true,
      text,
      matched,
      score,
    });
  }
  scored.sort((a, b) => b.score - a.score || b.at - a.at || Number(a.id ?? 0) - Number(b.id ?? 0));
  const resultLimit = Math.max(1, Math.min(MAX_RESULTS, Math.floor(Number(limit) || MAX_RESULTS)));
  const items = scored.slice(0, resultLimit);
  // ★ coverage（§6.2 七键 + §6.3 第 5 条 · M2 2026-10-14）：这条出口与另两条腿**同一个形状**，
  //   形状本身在 `coverage.js`，本文件只负责给出自己测得出的那些数。
  //   · 本出口是"从最新往旧扫一个有界窗口"，所以它的缺口是**窗口之外还有多少条没扫**（`outOfWindowCount`），
  //     不是"整理到哪了"；窗口证明覆盖了整个存档且命中没被条数上限切掉，才敢写 `complete`。
  //   · 存档总数读不出来 ⇒ 说不清覆盖 ⇒ `partial`（不许默认成"覆盖全了"）。
  //   · 整理队列两个数不归本出口 ⇒ `null` + 落进 `coverage.unmeasured`，调用方不会把它读成 0。
  const outOfWindowCount = archiveTotal === null ? null : Math.max(0, archiveTotal - scannedRows);
  const hitsTruncated = Math.max(0, scored.length - items.length);
  const coverageStateReason = archiveTotal === null
    ? 'archive-total-unavailable'
    : outOfWindowCount > 0
      ? 'archive-beyond-window'
      : hitsTruncated > 0
        ? 'hits-truncated'
        : '';
  return {
    ok: true,
    schemaVersion: 1,
    query: q,
    chatKey: key,
    items,
    total: scored.length,
    scanned: messages.length,
    personaHiddenRows,
    suppressionHiddenRows,
    scanLimit: Math.max(1, Math.min(MAX_SCAN, Math.floor(Number(maxScan) || MAX_SCAN))),
    // 窗口之外没被这次检索扫到的条数（存档总数读不出来时为 null）。
    outOfWindowCount,
    coverage: buildCoverage({
      state: coverageStateReason ? 'partial' : 'complete',
      sourceHighWater: archiveHighWaterTs,
      processedThrough: windowTopTs,
      scope: scopeOf(key),
      // 本出口只扫聊天存档，语义（向量）那条腿没接在这儿 ⇒ 代次给 null 并写明成因，不写 `'none'`。
      generationState: 'not-wired',
      stateReason: coverageStateReason,
      reasons: ['本出口只扫聊天存档，不声明整理进度（pendingCount / failedCount 见 unmeasured）'],
    }),
  };
}
