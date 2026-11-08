/**
 * M6 memory · chat-store（**旧 `src/store.js` 的 `ChatStore` 移植**）
 *
 * ⚠ **为什么叫 `chat-store.js` 而不是 `store.js`**：`store.js` 这个名字已经被 M6 的
 *   **证据账本 store** 占了（`evidence.jsonl` / `observations.jsonl` / …，`index.js:29` 在 import 它）。
 *   两者是完全不同的东西：那份是「记忆的证据与观察」，这份是「**原始聊天存档**」。
 *   同名不同物 ⇒ 必须分开命名，否则跨席位覆盖。
 *
 * ── 与旧实现的差异（只有 4 处，其余逐字照搬） ──────────────────────────────
 *   ⚠ 其中 ② 会带来**可观察的行为差异**（见下面那条），不是纯搬运。
 *   ① `DATA_DIR`：旧版 `import { DATA_DIR } from `src/config.js`（同模块，不带 `./` 前缀免得被依赖扫描当成真 import）（模块加载即定值，缺省落仓库 `data/`）。
 *      新版工厂经 `./data-dir.js` 的 `getDataDir()` 解析并绑定到实例 —— 那是 M6 的"没授权就不放行"
 *      解析器（只接受显式注入 / `QQ_AGENT_DATA_DIR`，都没有就**抛错**）。未绑定实例的公开路径函数仍即时解析。铁律：不许默认落仓库 `data/`。
 *   ② `writeJsonAtomic`：旧版从 `src/util.js` import。新树**从 `core/util/index.js` import 共享实现**
 *      （core/util 的 util.js 早就搬了这个函数，且比旧版更硬：rename 失败会删 tmp、tmp 名不带时间戳）。
 *      ⚠ 我第一版误判"core/util 里没有这个导出"、就地写了一份副本 —— **判断错，已改**（指挥位 2026-10-05 指出）。
 *      教训同 `msgRef`：**不许两份实现**；查"某个冻结出口有没有"要用**真 import**，
 *      我那次用正则数 `export function` 形式，数不到 `export * from` 的星号再导出。
 *   ③ `isPersonaTwo`：旧版 `import { isPersonaTwo } from `src/persona-two.js`（同上）。
 *      第二人格的判定/切换事务归 **M7 / M15**（README §3.8）⇒ 改成**构造注入**，
 *      默认 `() => false`。保持旧语义「打标失败绝不阻断存档」（吞异常）。
 *   ④ `normalizeRef` / `msgRef`：旧版定义在本文件里。M6 已有 `./msg-ref.js`
 *      （§3.5 冻结名，platform/media/act 都在用）⇒ **复用，绝不搬第二份**（§3.5 维护规则）。
 *
 * ── 2026-10-18 持久化与读路径修复（S01/S02/S09，ds3 `7129975c`）──────────────
 *   A. **提交顺序翻转为"先数据文件、后 revision 元数据"**。原来 `#advanceSourceRevision`
 *      先写 `<dataDir>/messages-revisions/<key>.json`：主档 rename 一旦失败（注入 EPERM 复现），
 *      盘上就出现"元数据版本 2 > 主档版本 1"的超前状态，且内存里的条目照样存在
 *      （重启丢写）。数据文件本身内嵌 sourceRevision / sourceRevisions / historyFloorRevision，
 *      加载端（`loadChat` / `getChatMeta`）对三者与元数据取 max ⇒ **元数据滞后可自愈、超前不再可能**。
 *   B. 本模块所有原子写（热档 / 冷分片 / 元数据）统一走 `writeJsonAtomicRetry`：
 *      rename 被杀软、搜索索引器短暂占用（EPERM/EBUSY）在 Windows 上是瞬时错，值得有限重试；
 *      **数据写重试后仍失败 ⇒ 回滚本次内存追加并抛出** —— 不出现"内存报成功、重启丢写"，
 *      也不能只记日志就丢未读。
 *   C. 未读只可能存在于热段（`#maybeArchive` 的 safePrefix 只归档**已读**前缀）⇒
 *      `peekUnread` 对非驻留会话直接读热档文件，不再为"看几条未读"把**全部冷分片**读进来。
 *      恢复（pause→resume）按会话逐个 peek 时这是老群卡顿的直接来源。
 *   D. 热档写前的"读坏不许覆盖"探查，在**文件仍是本进程上次写出的那一份**（size+mtime 戳一致）时
 *      跳过整份读回；戳不一致（含缺失、被外部改写）时保留原探查/损坏另存语义。减少每次追加的整份读。
 *   E. `activeMembers` 全量结果改为**一次建索引、之后随追加增量维护**，不再每次全量重扫冷片
 *      （编排层点名解析每批都会查一次）。
 *
 * ── 2026-10-19 冷段读放大修复（S09，ds4 `8fa3addc`）────────────────────────
 *   F. **首次装入不再全扫冷片**。原先 `loadChat` 把每个冷分片正文整份读进内存（S09 实测：
 *      只取 1 条热消息也要读 4 片约 2.87MB；老群恢复/查询卡顿的直接来源）。现在：
 *      · 每会话一份**可校验分片清单** `data/messages-cold-meta/<safe>.json`
 *        （格式见 `chat-archive-manifest.js`；**不与消息同目录**，理由同 history-cut.js）；
 *      · 清单项与其文件戳（size/mtimeMs/ctimeMs）对上 ⇒ 只信元数据，正文**按需再读**
 *        （recent 要跨到哪片才读哪片；readSince 先按分片级 `maxSourceRevision` 跳过整片；
 *        findByRef 沿用布隆过滤跳过不可能命中的片）；
 *      · 对不上 / 清单缺失 / 首见分片 ⇒ **只读那一片**正文重建元数据（与旧全读同口径），
 *        随后回写清单 —— 升级后的第一次仍付一次全读，之后不再付；
 *      · 写入侧（归档 / updateByMid）在落盘后同步更新清单；清单写失败只是"缓存没更新"，
 *        下次加载因戳不一致自动退回读正文，**绝不影响数据正确性**。
 *   G. **缺片不当作已删除**：清单记过而盘上不存在的分片只是本次不参与布局，不写任何删改；
 *      文件回来（或此前就存在但读不动）仍会被读到。正文读不动照旧留痕（health.corrupt）。
 *
 * ── 存储分层（照搬旧实现的说明，一字未改其义；10-19 增补清单目录一行） ───────
 *   data/messages/<safe>.json              热段：最近 hotPerChat 条，每次都写入文件
 *   data/messages-cold/<safe>.NNNNN.json   冷分片：更老的原文，写满 COLD_CHUNK 条就冻结
 *   data/messages-cold-meta/<safe>.json    冷分片清单（★ 缓存，非数据；删了只会重读一遍正文）
 *   内存只常驻热段；recent / 引用查找 / 成员统计遇到冷段时逐片读取（从 10-19 起按清单按需读）。
 *
 * ── 条目格式（照搬） ────────────────────────────────────────────────────────
 *   { id, mid, ts, senderId, senderName, text, self, read,
 *     reply?: { sender, text, ref?, senderId?, self? },
 *     media?: [{ kind, url, file, faceId, summary }],
 *     hype?, persona2?, toSelf?, replyToSelf?, dupSuspect? … }
 *   `id` = 本地递增序号（自 1 起、同群唯一，**给模型看的短编号就是它**）；
 *   `mid` = QQ 消息 id（可为负；自己主动发送的本地记录可能没有）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir, setDataDir as setDataDirInternal } from './data-dir.js';
import { msgRef, normalizeRef } from './msg-ref.js';
import { writeJsonAtomic } from '../../core/util/index.js';
import {
  buildColdManifestEntry, coldStampMatches, decodeColdBloom, encodeColdBloom,
  parseColdManifest, serializeColdManifest,
} from './chat-archive-manifest.js';

export { msgRef, normalizeRef };

/**
 * 兴趣唤醒的观察口（2026-11-08 溟加）
 *
 * 为什么加：DSH 那边的 `dsh-ming-interest` 一直在读 `…\.dsh\media\onebot\qq-inbox.jsonl`，
 * 而写那份文件的是一个早停用的 onebot 插件。文件停在 2026-10-21 12:02，三周没长过一个字，
 * 于是插件每轮都诚实地报「没有新消息」——**关键词唤醒从那天起其实一直没工作**。
 *
 * 这里在收到群消息时顺手 append 一行（就是那个插件当初写的格式）。
 * 路径由 `MING_QQ_INBOX` 给，**公开仓里不留私人路径**；没设就什么都不做。
 * 写失败一律吞：这不是主链路，宁可少一条观察，也不能让收消息失败。
 */
const INBOX_PATH = String(process.env.MING_QQ_INBOX || '');
// 这份文件只给「看一眼有没有新消息」用，不值得无限长：超过 8 MB 就轮转成 .1。
// 读取方（dsh-ming-interest）是拿 size 当游标的，文件变短它会自己把游标归 0，所以轮转是安全的。
const INBOX_MAX_BYTES = 8 * 1024 * 1024;
let inboxWrites = 0;
function appendInbox(chatKey, entry) {
  if (!INBOX_PATH) return;
  const key = String(chatKey || '');
  if (!key.startsWith('group:')) return;
  try {
    if ((inboxWrites++ % 500) === 0) {
      try {
        if (fs.statSync(INBOX_PATH).size > INBOX_MAX_BYTES) fs.renameSync(INBOX_PATH, INBOX_PATH + '.1');
      } catch { /* 文件还不存在，或轮转失败：都不影响下面这一笔 */ }
    }
    const line = JSON.stringify({
      ts: Number(entry.ts) || Date.now(),
      kind: 'message',
      decision: { ok: false, stage: 'inbound', reason: '兴趣观察：这条进了消息库，没有当作要回复的消息' },
      frame: {
        message_type: 'group',
        group_id: key.slice(6),
        user_id: String(entry.senderId ?? ''),
        self_id: '',
        sender: { card: String(entry.senderName ?? ''), nickname: String(entry.senderName ?? '') },
        message: [{ type: 'text', data: { text: String(entry.text ?? '') } }],
      },
    });
    fs.appendFileSync(INBOX_PATH, line + '\n');
  } catch {
    /* 观察记录，写不出来就算了 */
  }
}


// ── 路径（**每次调用时**解析，绝不在模块加载时定值） ──────────────────────
/** 热段目录：`<dataDir>/messages`。解析不出 dataDir 就抛错，不放行到默认目录（见 data-dir.js）。 */
export function messagesDir(dataDir = null) {
  const root = typeof dataDir === 'string' && dataDir.trim() ? path.resolve(dataDir) : getDataDir();
  return path.join(root, 'messages');
}
/** 冷分片目录：`<dataDir>/messages-cold`。 */
export function coldDir(dataDir = null) {
  const root = typeof dataDir === 'string' && dataDir.trim() ? path.resolve(dataDir) : getDataDir();
  return path.join(root, 'messages-cold');
}

/** 兼容旧常量名（旧代码写 `COLD_DIR`）。**注意它是函数**，不是定值。 */
export function coldDirPath() {
  return coldDir();
}

/** 单个冷分片的条数上限。写满即冻结（不再重写），只有最后一片可追加。 */
export const COLD_CHUNK = 5000;

/** 热段默认条数（照搬旧值与其理由：3000 条 ≈ 0.8MB ≈ 5ms 写入）。 */
export const DEFAULT_HOT_PER_CHAT = 3000;

const MID_BLOOM_BYTES = 8192;
const MID_BLOOM_BITS = MID_BLOOM_BYTES * 8;
const MID_BLOOM_HASHES = 4;

/**
 * 发言人标签：实现已抽到零依赖的 `./author-label.js`（2026-10-13，历史消息格式）。
 * 抽出去不是为了换个地方放着，是因为 `prompt/history-format.js` 也要用同一份标签口径，
 * 而本文件带 `node:fs` ⇒ 提示词模块不能 import 它。这里原样再导出，
 * `memory/index.js`、`act` 侧和所有旧调用方的取法都不变。
 */
export { quoteAuthorLabel } from './author-label.js';

// ── mid 布隆过滤（照搬） ────────────────────────────────────────────────────
function hashMid(value) {
  const text = String(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x5bd1e995);
  }
  h1 ^= h1 >>> 16;
  h2 ^= h2 >>> 13;
  return [h1 >>> 0, (h2 | 1) >>> 0];
}

function addMidBloom(bloom, messages) {
  for (const message of messages) {
    const [h1, h2] = hashMid(message.mid);
    for (let i = 0; i < MID_BLOOM_HASHES; i += 1) {
      const bit = (h1 + Math.imul(i, h2)) & (MID_BLOOM_BITS - 1);
      bloom[bit >>> 3] |= 1 << (bit & 7);
    }
  }
  return bloom;
}

function createMidBloom(messages) {
  return addMidBloom(new Uint8Array(MID_BLOOM_BYTES), messages);
}

function hasIncreasingLocalIds(messages) {
  let previous = -Infinity;
  for (const message of messages) {
    const id = Number(message.id);
    if (!Number.isFinite(id) || id <= previous) return false;
    previous = id;
  }
  return true;
}

function midBloomMayContain(bloom, value) {
  if (!(bloom instanceof Uint8Array)) return true;
  const [h1, h2] = hashMid(value);
  for (let i = 0; i < MID_BLOOM_HASHES; i += 1) {
    const bit = (h1 + Math.imul(i, h2)) & (MID_BLOOM_BITS - 1);
    if ((bloom[bit >>> 3] & (1 << (bit & 7))) === 0) return false;
  }
  return true;
}

function safeKey(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

function chatFile(chatKey, dir = messagesDir()) {
  return path.join(dir, `${safeKey(chatKey)}.json`);
}

function revisionFile(chatKey, dataDir = null) {
  return path.join(path.dirname(messagesDir(dataDir)), 'messages-revisions', `${safeKey(chatKey)}.json`);
}

function coldChunkFile(chatKey, seq, dir = coldDir()) {
  return path.join(dir, `${safeKey(chatKey)}.${String(seq).padStart(5, '0')}.json`);
}

function isRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function readRevisionMeta(chatKey, health, dataDir = null) {
  const file = revisionFile(chatKey, dataDir);
  const read = readJsonDetailed(file);
  if (!read.ok) {
    health?.noteCorrupt?.(file, read.reason);
    return { sourceRevision: null, historyFloorRevision: null, reliable: false };
  }
  if (read.value === null && read.reason === 'absent') {
    return { sourceRevision: 0, historyFloorRevision: 0, reliable: true };
  }
  const value = read.value;
  if (value?.version !== 1 || value?.chatKey !== chatKey
    || !isRevision(value.sourceRevision) || !isRevision(value.historyFloorRevision)
    || value.historyFloorRevision > value.sourceRevision) {
    health?.noteCorrupt?.(file, 'invalid-source-revision-metadata');
    return { sourceRevision: null, historyFloorRevision: null, reliable: false };
  }
  return {
    sourceRevision: value.sourceRevision,
    historyFloorRevision: value.historyFloorRevision,
    reliable: true,
  };
}

function writeRevisionMeta(chatKey, { sourceRevision, historyFloorRevision }, dataDir = null) {
  writeJsonAtomicRetry(revisionFile(chatKey, dataDir), {
    version: 1,
    chatKey,
    sourceRevision,
    historyFloorRevision,
  });
}

function readRevisionArray(value, length) {
  if (value === undefined) return { values: Array(length).fill(0), valid: true };
  if (!Array.isArray(value) || value.length !== length || !value.every(isRevision)) {
    return { values: Array(length).fill(0), valid: false };
  }
  return { values: [...value], valid: true };
}

/**
 * 读 JSON。**新增留痕**（旧实现一律 `catch{return null}`，坏文件被当空库）。
 * @returns {{ok:boolean, value:any, reason:string|null}}
 *          ok=false 时 reason ∈ 'absent' | 'unreadable' | 'unparsable'
 */
function readJsonDetailed(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, value: null, reason: 'absent' };
    return { ok: false, value: null, reason: `unreadable:${error?.code || error?.message || error}` };
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  if (!text.trim()) return { ok: true, value: null, reason: 'absent' };
  try {
    return { ok: true, value: JSON.parse(text), reason: null };
  } catch (error) {
    return { ok: false, value: null, reason: `unparsable:${error?.message || error}` };
  }
}

/** 旧行为：只要拿到 null 就当没有。**损坏另记 health**（由调用方传入 health 收集器）。 */
function readJson(file, health) {
  const r = readJsonDetailed(file);
  if (!r.ok) health?.noteCorrupt?.(file, r.reason);
  return r.value;
}

/** 同步小睡（重试间隔用）。Atomics.wait 不挂事件循环；环境不支持时退化为忙等兜底。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 忙等兜底（只在重试路径，最长几十毫秒） */ }
  }
}

/** 重试间隔（毫秒）：1 次初试 + 2 次重试，共 3 次。 */
const WRITE_RETRY_DELAYS_MS = [20, 50];

/**
 * 原子写 + 有限重试（★ 2026-10-18 S01）。
 * `writeJsonAtomic` 的"写临时文件 + rename"在 Windows 上会被杀软/索引器瞬时占用（EPERM/EBUSY），
 * 对同步写这类错"再试一次就好"，但对未读入库是"丢一条"的后果。重试仍失败时**原样抛出**，
 * 由调用方决定回滚——这里绝不吞错、绝不返回假成功。
 */
function writeJsonAtomicRetry(file, data) {
  let lastError = null;
  for (let attempt = 0; attempt <= WRITE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      writeJsonAtomic(file, data);
      return;
    } catch (error) {
      lastError = error;
      const wait = WRITE_RETRY_DELAYS_MS[attempt];
      if (wait) sleepSync(wait);
    }
  }
  throw lastError;
}

/**
 * 文件戳（size + mtimeMs + ctimeMs）：热档用它判断"是否仍是本进程上次写出的那一份"
 * （见 `#save` 的探查跳过）；冷分片清单用它做"可校验元数据"的文件戳。
 * 只用于"要不要再读回整份验证"，不用于任何数据判定；取不到就返回 null（走保守路径）。
 */
function stampOf(file) {
  try {
    const stat = fs.statSync(file);
    return { file, size: stat.size, mtimeMs: Number(stat.mtimeMs), ctimeMs: Number(stat.ctimeMs) };
  } catch { return null; }
}

/** 按序号列出某会话已有的冷分片序号（升序）。目录不存在 = 还没有冷段。 */
function listColdSeqs(chatKey, dir) {
  const prefix = `${safeKey(chatKey)}.`;
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
      .map((f) => Number(f.slice(prefix.length, -'.json'.length)))
      .filter((n) => Number.isInteger(n) && n >= 0)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/**
 * 冷分片清单文件：`<dataDir>/messages-cold-meta/<safe>.json`（★ 2026-10-19 S09）。
 * 与 `messages-revisions/` 同级的旁挂目录 —— **绝不放进 messages/ 或 messages-cold/**：
 * 那两个目录按消息布局被全体读取方扫（archive-view 快照、selftest 命名断言），
 * 混进非消息文件会被当消息或坏冷分片（同 history-cut.js 的放置理由）。
 */
function coldManifestFile(chatKey, dataDir = null) {
  return path.join(path.dirname(messagesDir(dataDir)), 'messages-cold-meta', `${safeKey(chatKey)}.json`);
}

const manifestWarned = new Set();
/** 清单不可用/写不出：只是缓存问题，不抛不阻断，留一行可见告警（每文件一次）。 */
function warnColdManifest(file, reason) {
  if (manifestWarned.has(file)) return;
  manifestWarned.add(file);
  console.warn(`[chat-store] 冷分片清单不可用（只是缓存：读取会退回正文，不影响数据）: ${file}  ${reason}`);
}

/** 读清单：任何结构性/IO 问题都返回 null（调用方退"读正文重建"路径），绝不据此删改数据。 */
function readColdManifest(chatKey, dataDir = null) {
  const file = coldManifestFile(chatKey, dataDir);
  const read = readJsonDetailed(file);
  if (!read.ok) { warnColdManifest(file, read.reason); return null; }
  if (read.value === null) return null;
  return parseColdManifest(read.value, chatKey);
}

/**
 * 把当前内存里的分片记录写成清单（含文件戳与布隆过滤）。**永不抛**：
 * 失败只留一行告警 —— 清单是缓存，数据已落盘；下次加载戳对不上会退回读正文自愈。
 */
function flushColdManifest(chatKey, chunks, dataDir = null) {
  const file = coldManifestFile(chatKey, dataDir);
  try {
    const entries = (chunks || []).map((chunk) => buildColdManifestEntry({
      seq: chunk.seq,
      len: chunk.len,
      firstId: chunk.firstId,
      lastId: chunk.lastId,
      idsIncreasing: chunk.idsIncreasing === true,
      lastTs: chunk.lastTs,
      lastText: chunk.lastText,
      maxSourceRevision: chunk.maxSourceRevision,
      sourceRevisionValue: chunk.sourceRevisionValue,
      sourceRevisionPresent: chunk.sourceRevisionPresent === true,
      sourceRevisionValid: chunk.sourceRevisionValid === true,
      sourceRevisionsPresent: chunk.sourceRevisionsPresent === true,
      sourceRevisionsValid: chunk.sourceRevisionsValid === true,
      stamp: chunk.stamp,
      bloom: encodeColdBloom(chunk.midBloom),
    }));
    writeJsonAtomicRetry(file, serializeColdManifest(chatKey, entries));
  } catch (error) {
    warnColdManifest(file, `write-failed:${error?.code || error?.message || error}`);
  }
}

/** 加载一个会话的完整状态（冷分片按序号 + 热段），拼成全量消息数组。 */
function loadChatState(chatKey, dir, cold, health) {
  const chunks = [];
  let coldMessages = [];
  for (const seq of listColdSeqs(chatKey, cold)) {
    const j = readJson(coldChunkFile(chatKey, seq, cold), health);
    const arr = j && Array.isArray(j.messages) ? j.messages : [];
    if (!arr.length) continue;
    chunks.push({ seq, start: coldMessages.length, len: arr.length });
    coldMessages = coldMessages.concat(arr);
  }
  const hot = readJson(chatFile(chatKey, dir), health);
  const hotMessages = hot && Array.isArray(hot.messages) ? hot.messages : [];
  return { chatKey, nextLocalId: hot?.nextLocalId, coldMessages, hotMessages, chunks };
}

/**
 * 读一个会话的**全量**消息（冷分片 + 热段，id 升序）。
 * 给「绕过 ChatStore 直接读 messages 文件」的模块用（conversation-memory 那一族）。
 *
 * @param {string} [messagesDirOverride] 热段目录（缺省 `<dataDir>/messages`）
 * @param {string} chatKey group:123 / private:456
 * @returns {object[]} 全量消息数组
 */
export function readAllMessages(messagesDirOverride, chatKey) {
  const dir = messagesDirOverride || messagesDir();
  const cold = path.join(path.dirname(dir), 'messages-cold');
  const st = loadChatState(chatKey, dir, cold, null);
  return st.coldMessages.concat(st.hotMessages);
}

/** 冷分片轻量摘要（照搬：只 JSON 解析最新一片，其余恒为 COLD_CHUNK 条）。 */
function lightColdSummary(chatKey, dir, cold, health) {
  const seqs = listColdSeqs(chatKey, cold);
  if (!seqs.length) return { total: 0, last: null, sourceRevision: 0 };
  const newest = readJson(coldChunkFile(chatKey, seqs[seqs.length - 1], cold), health);
  const arr = newest && Array.isArray(newest.messages) ? newest.messages : [];
  if (!arr.length) {
    const st = loadChatState(chatKey, dir, cold, health);
    const c = st.coldMessages;
    return {
      total: c.length,
      last: c[c.length - 1] || null,
      sourceRevision: isRevision(newest?.sourceRevision) ? newest.sourceRevision : 0,
    };
  }
  return {
    total: (seqs.length - 1) * COLD_CHUNK + arr.length,
    last: arr[arr.length - 1] || null,
    sourceRevision: isRevision(newest?.sourceRevision) ? newest.sourceRevision : 0,
  };
}

/**
 * 非驻留会话的冷段摘要（★ 2026-10-19 S09）：优先走清单，**不读任何正文**；
 * 清单缺失/坏了/条数为 0 退回旧启发式 `lightColdSummary`（只解析最新一片）。
 * 计数口径：只数"盘上真实存在的分片"的 len（缺片不计、不当作已删除——与旧实现
 * "只枚举真实文件"同口径；旧启发式把非最新片恒记 COLD_CHUNK 条，清单是精确值）。
 * 最新片被外部动过（戳对不上）时只读那一片拿最新尾巴——与旧实现读最新一片的代价一致。
 */
function coldSummary(chatKey, dataDir, health) {
  const dir = messagesDir(dataDir);
  const cold = coldDir(dataDir);
  const manifest = readColdManifest(chatKey, dataDir);
  if (!manifest || manifest.size === 0) return lightColdSummary(chatKey, dir, cold, health);
  // 清单只按"戳"校验已有片；**盘上新出现的片**（外部恢复/拷贝回来的文件）它看不见 ——
  // 覆盖不全就退回旧启发式（宁可不精确，也不在这条只读路径上装作看不见新文件）。
  const diskSeqs = listColdSeqs(chatKey, cold);
  if (!diskSeqs.every((seq) => manifest.has(seq))) return lightColdSummary(chatKey, dir, cold, health);
  let total = 0;
  let newest = null;
  for (const seq of [...manifest.keys()].sort((a, b) => a - b)) {
    const entry = manifest.get(seq);
    if (!entry || entry.len <= 0) continue;
    const stat = stampOf(coldChunkFile(chatKey, seq, cold));
    if (!stat) continue; // 缺片不计数（也不写任何删改）
    total += entry.len;
    newest = { entry, stat };
  }
  if (!newest) return lightColdSummary(chatKey, dir, cold, health);
  const { entry, stat } = newest;
  const revisionOf = (value) => (isRevision(value) ? value : 0);
  if (coldStampMatches(entry, stat)) {
    return {
      total,
      last: { ts: entry.lastTs ?? undefined, text: entry.lastText ?? undefined },
      sourceRevision: entry.sourceRevisionValid ? revisionOf(entry.sourceRevision) : 0,
    };
  }
  const body = readJson(coldChunkFile(chatKey, entry.seq, cold), health);
  const arr = body && Array.isArray(body.messages) ? body.messages : [];
  if (arr.length) {
    const tail = arr[arr.length - 1];
    return { total: total - entry.len + arr.length, last: { ts: tail?.ts, text: tail?.text }, sourceRevision: revisionOf(body?.sourceRevision) };
  }
  return {
    total,
    last: { ts: entry.lastTs ?? undefined, text: entry.lastText ?? undefined },
    sourceRevision: entry.sourceRevisionValid ? revisionOf(entry.sourceRevision) : 0,
  };
}

function loadChat(chatKey, health, dataDir = null) {
  const dir = messagesDir(dataDir);
  const cold = coldDir(dataDir);
  const revisionMeta = readRevisionMeta(chatKey, health, dataDir);
  let sourceRevision = revisionMeta.sourceRevision ?? 0;
  let historyFloorRevision = revisionMeta.historyFloorRevision ?? 0;
  let revisionReliable = revisionMeta.reliable;
  const chunks = [];
  let total = 0;
  let last = null;
  let localIdsOrdered = true;
  let manifestDirty = false;
  // ★ 2026-10-19 S09：清单（几 KB）先行，正文按需再读 —— 不再为"看一眼老群"整扫冷片。
  //   盘上文件名与清单做**并集**：清单有而盘上无 = 缺片（不当作已删除，本次不参与布局）；
  //   盘上有而清单无/戳对不上 = 只读那一片正文重建元数据（与旧实现同口径），然后回写清单。
  const manifest = readColdManifest(chatKey, dataDir);
  const diskSeqs = listColdSeqs(chatKey, cold);
  const diskSet = new Set(diskSeqs);
  const seqs = [...new Set([...diskSeqs, ...(manifest ? manifest.keys() : [])])].sort((a, b) => a - b);
  for (const seq of seqs) {
    if (!diskSet.has(seq)) continue;
    const file = coldChunkFile(chatKey, seq, cold);
    const entry = manifest ? manifest.get(seq) || null : null;
    if (entry && entry.len > 0 && coldStampMatches(entry, stampOf(file))) {
      // 戳对上 ⇒ 信任清单元数据：不读正文，revision 可靠性按清单口径补记（与旧全读逐行同义）。
      if (!entry.sourceRevisionsValid) revisionReliable = false;
      if (entry.sourceRevisionPresent) {
        if (entry.sourceRevisionValid && isRevision(entry.sourceRevision)) {
          sourceRevision = Math.max(sourceRevision, entry.sourceRevision);
        } else revisionReliable = false;
        if (!entry.sourceRevisionsPresent) revisionReliable = false;
      }
      sourceRevision = Math.max(sourceRevision, entry.maxSourceRevision);
      const firstId = entry.firstId === null ? NaN : entry.firstId;
      const lastId = entry.lastId === null ? NaN : entry.lastId;
      if (!entry.idsIncreasing || (chunks.length && firstId <= chunks[chunks.length - 1].lastId)) {
        localIdsOrdered = false;
      }
      chunks.push({
        seq, start: total, len: entry.len, firstId, lastId, idsIncreasing: entry.idsIncreasing,
        midBloom: decodeColdBloom(entry.bloom, MID_BLOOM_BYTES),
        maxSourceRevision: entry.maxSourceRevision,
        sourceRevisionValue: entry.sourceRevision,
        sourceRevisionPresent: entry.sourceRevisionPresent,
        sourceRevisionValid: entry.sourceRevisionValid,
        sourceRevisionsPresent: entry.sourceRevisionsPresent,
        sourceRevisionsValid: entry.sourceRevisionsValid,
        lastTs: entry.lastTs,
        lastText: entry.lastText,
        stamp: { size: entry.size, mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs },
      });
      total += entry.len;
      last = { ts: entry.lastTs, text: entry.lastText };
      continue;
    }
    if (entry && entry.len === 0) { manifestDirty = true; continue; }
    // 退路：清单缺失/戳对不上/首见 —— 读这一片正文重建元数据（旧实现的逐片口径，一字不改）。
    const j = readJson(file, health);
    const arr = j && Array.isArray(j.messages) ? j.messages : [];
    if (!arr.length) { if (entry) manifestDirty = true; continue; }
    const revisionData = readRevisionArray(j?.sourceRevisions, arr.length);
    if (!revisionData.valid) revisionReliable = false;
    if (j?.sourceRevision !== undefined) {
      if (isRevision(j.sourceRevision)) sourceRevision = Math.max(sourceRevision, j.sourceRevision);
      else revisionReliable = false;
      if (j?.sourceRevisions === undefined) revisionReliable = false;
    }
    for (const revision of revisionData.values) sourceRevision = Math.max(sourceRevision, revision);
    const firstId = Number(arr[0]?.id);
    const lastId = Number(arr[arr.length - 1]?.id);
    const idsIncreasing = hasIncreasingLocalIds(arr);
    if (!idsIncreasing || (chunks.length && firstId <= chunks[chunks.length - 1].lastId)) {
      localIdsOrdered = false;
    }
    const tail = arr[arr.length - 1];
    chunks.push({
      seq, start: total, len: arr.length, firstId, lastId, idsIncreasing,
      midBloom: createMidBloom(arr),
      maxSourceRevision: revisionData.values.reduce((max, value) => Math.max(max, value), 0),
      sourceRevisionValue: isRevision(j?.sourceRevision) ? j.sourceRevision : null,
      sourceRevisionPresent: j?.sourceRevision !== undefined,
      sourceRevisionValid: j?.sourceRevision === undefined || isRevision(j.sourceRevision),
      sourceRevisionsPresent: j?.sourceRevisions !== undefined,
      sourceRevisionsValid: revisionData.valid,
      lastTs: tail?.ts,
      lastText: tail?.text,
      stamp: stampOf(file),
    });
    total += arr.length;
    last = { ts: tail?.ts, text: tail?.text };
    manifestDirty = true;
  }
  const hotFile = chatFile(chatKey, dir);
  const hotRead = readJsonDetailed(hotFile);
  if (!hotRead.ok) health?.noteCorrupt?.(hotFile, hotRead.reason);
  const hot = hotRead.value;
  const hotMessages = hot && Array.isArray(hot.messages) ? hot.messages : [];
  const hotRevisionData = readRevisionArray(hot?.sourceRevisions, hotMessages.length);
  if (!hotRevisionData.valid) revisionReliable = false;
  if (hot?.sourceRevision !== undefined) {
    if (isRevision(hot.sourceRevision)) sourceRevision = Math.max(sourceRevision, hot.sourceRevision);
    else revisionReliable = false;
    if (hot?.sourceRevisions === undefined) revisionReliable = false;
  }
  for (const revision of hotRevisionData.values) sourceRevision = Math.max(sourceRevision, revision);
  if (hot?.historyFloorRevision !== undefined) {
    if (isRevision(hot.historyFloorRevision)) historyFloorRevision = Math.max(historyFloorRevision, hot.historyFloorRevision);
    else revisionReliable = false;
  }
  const lastChunk = chunks.length ? chunks[chunks.length - 1] : null;
  const state = {
    chatKey,
    nextLocalId: hot?.nextLocalId ?? (total + hotMessages.length + 1),
    messages: hotMessages,
    sourceRevisions: hotRevisionData.values,
    sourceRevision,
    historyFloorRevision,
    revisionReliable,
    // ★ 2026-10-18：热档"是否仍是我们读到的这份"的戳（#save 据此跳过整份读回探查）；
    //   读坏时不落戳（下次保存会照旧全量探查并另存损坏件）。
    _hotFileStamp: hotRead.ok ? stampOf(hotFile) : null,
    // 成员索引：懒建一次（activeMembers），随后随追加增量维护；#trim 截断时置空重算。
    _memberIndex: null,
    _cold: {
      total,
      chunks,
      localIdsOrdered,
      seq: lastChunk ? lastChunk.seq : -1,
      lastLen: lastChunk ? lastChunk.len : 0,
      lastMessage: last,
      manifestDirty,
    }
  };
  // 本次有"读正文重建"的分片 ⇒ 回写清单（首见/戳对不上/空片剔除）。永不抛，失败只是缓存旧。
  if (manifestDirty) {
    flushColdManifest(chatKey, chunks, dataDir);
    state._cold.manifestDirty = false;
  }
  return state;
}

/**
 * 写冷分片。
 * ★ 新增闸：目标分片**已存在但读不动**时，先把它挪成 `.corrupt-<ts>` 备份再写 ——
 *   否则 `#archive` 会拿 `existing=[]` 覆盖，把那段历史**永久抹掉**（"读坏不许当空库覆盖"）。
 */
function saveColdChunk(chatKey, seq, messages, health, dataDir = null, sourceRevisions = [], sourceRevision = 0) {
  const file = coldChunkFile(chatKey, seq, coldDir(dataDir));
  const probe = readJsonDetailed(file);
  if (!probe.ok) {
    const aside = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, aside);
      health?.notePreserved?.(file, aside, probe.reason);
    } catch (error) {
      health?.noteCorrupt?.(file, `preserve-failed:${error?.code || error?.message || error}`);
    }
  }
  writeJsonAtomicRetry(file, { chatKey, seq, messages, sourceRevisions, sourceRevision });
}

/** 收集"读坏/被挪走"痕迹的 health 收集器（不抛，调用方自己看 getHealth()）。 */
function makeHealth() {
  const corrupt = [];
  const preserved = [];
  const deferred = [];
  const warned = new Set();
  return {
    corrupt,
    preserved,
    deferred,
    noteCorrupt(file, reason) {
      corrupt.push({ file, reason, at: Date.now() });
      if (!warned.has(file)) {
        warned.add(file);
        console.warn(`[chat-store] 存档文件读不动（不当空库，已留痕）: ${file}  ${reason}`);
      }
    },
    notePreserved(file, aside, reason) {
      preserved.push({ file, aside, reason, at: Date.now() });
      console.warn(`[chat-store] 存档文件损坏，已挪到 ${path.basename(aside)} 后重写: ${path.basename(file)}  ${reason}`);
    },
    /**
     * 降级留痕（★ 2026-10-18 S01）：数据文件已落盘、只有冗余的 revision 元数据没追上。
     * 这不是数据损坏——加载端从数据文件内嵌的版本取 max 自愈——所以单独记，不进 corrupt
     * （chat-search 对 corrupt 是 fail-closed，不能把可自愈的滞后当"源不可读"）。
     */
    noteDeferred(file, reason) {
      deferred.push({ file, reason, at: Date.now() });
      if (!warned.has(`deferred:${file}`)) {
        warned.add(`deferred:${file}`);
        console.warn(`[chat-store] revision 元数据写入未完成（数据已落盘，将在下次加载/写入自愈）: ${file}  ${reason}`);
      }
    }
  };
}

export class ChatStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxPerChat=0]  硬上限（>0 时语义是"存档文件里也不留"）；0 = 不限
   * @param {number} [opts.hotPerChat=DEFAULT_HOT_PER_CHAT] 热段条数；0 = 停止新归档
   * @param {string} [opts.dataDir] 本实例固定使用的数据目录；工厂复用时用于区分不同实例
   * @param {() => boolean} [opts.isPersonaTwo] 第二人格判定（**注入**；判定归 M7/M15）。
   *        默认恒 false —— 打标失败顶多是摘要没隔离，比丢存档轻得多（同旧 safeIsPersonaTwo 的取舍）。
   */
  constructor(opts = {}) {
    const { dataDir = null, maxPerChat = 0, hotPerChat = DEFAULT_HOT_PER_CHAT, isPersonaTwo = null } =
      (typeof opts === 'number' ? { maxPerChat: opts } : opts);   // 兼容旧位置参数 new ChatStore(n)
    this.dataDir = typeof dataDir === 'string' && dataDir.trim() ? path.resolve(dataDir) : null;
    this.maxPerChat = Math.max(0, Number(maxPerChat) || 0);
    this.hotPerChat = Math.max(0, Number(hotPerChat) || 0);
    this.chats = new Map();
    this.health = makeHealth();
    this._isPersonaTwo = typeof isPersonaTwo === 'function' ? isPersonaTwo : null;
    this._prunedAt = 0;
  }

  /** 读坏/被挪走的痕迹（不抛，调用方自己看）。 */
  getHealth() {
    return {
      corrupt: [...this.health.corrupt],
      preserved: [...this.health.preserved],
      deferred: [...this.health.deferred],
      dirs: { messages: messagesDir(this.dataDir), cold: coldDir(this.dataDir) }
    };
  }

  setMaxPerChat(cap) { this.maxPerChat = Math.max(0, Number(cap) || 0); }

  /** 热段条数；0 = 停止新归档，已有冷片继续按需读取（仅用于排障对照）。 */
  setHotPerChat(n) { this.hotPerChat = Math.max(0, Number(n) || 0); }

  /** 装配层可在复用单例时补上当前的人格标记器；缺省调用不会清掉已有注入。 */
  setPersonaTwoDetector(fn) {
    if (typeof fn === 'function') this._isPersonaTwo = fn;
  }

  /** 此刻是不是第二人格。吞异常 —— 存档是底层设施，打标失败绝不能让它写失败。 */
  safeIsPersonaTwo() {
    if (!this._isPersonaTwo) return false;
    try { return this._isPersonaTwo() === true; } catch { return false; }
  }

  #state(chatKey) {
    if (!this.chats.has(chatKey)) this.chats.set(chatKey, loadChat(chatKey, this.health, this.dataDir));
    return this.chats.get(chatKey);
  }

  /**
   * 分配下一个 sourceRevision（★ 2026-10-18 S01：**只在内存里先行，不落盘**）。
   * 落盘拆到 `#commitSourceRevision`，必须在数据文件（热档/冷片）写成功之后调用——
   * 这是"revision 元数据永不超前于数据"的保证点。校验不过（不可靠）时在任何改动前抛出。
   */
  #beginSourceRevision(st, { resetHistory = false } = {}) {
    if (!st.revisionReliable || !isRevision(st.sourceRevision) || st.sourceRevision >= Number.MAX_SAFE_INTEGER) {
      throw new Error('chat source revision is unavailable; refusing an untracked write');
    }
    const sourceRevision = st.sourceRevision + 1;
    const historyFloorRevision = resetHistory ? sourceRevision : st.historyFloorRevision;
    st.sourceRevision = sourceRevision;
    st.historyFloorRevision = historyFloorRevision;
    return sourceRevision;
  }

  /**
   * 数据文件已落盘后写 revision 元数据（★ 2026-10-18 S01）。
   * 元数据是冗余旁证：数据文件里已内嵌同一组版本号，加载端（loadChat/getChatMeta）取 max
   * ⇒ 写失败只是"滞后"，不会超前、不丢写，故降级记 health 而不抛（调用方已拿到成功语义）。
   */
  #commitSourceRevision(st) {
    try {
      writeRevisionMeta(st.chatKey, {
        sourceRevision: st.sourceRevision,
        historyFloorRevision: st.historyFloorRevision,
      }, this.dataDir);
    } catch (error) {
      this.health.noteDeferred(revisionFile(st.chatKey, this.dataDir),
        `source-revision-meta-write-failed:${error?.code || error?.message || error}`);
    }
  }

  /** 变更前快照（★ 2026-10-18 S01）：数据写最终失败时回滚内存账目，不许"内存报成功、重启丢写"。 */
  #mutationSnapshot(st) {
    return {
      sourceRevision: st.sourceRevision,
      historyFloorRevision: st.historyFloorRevision,
      nextLocalId: st.nextLocalId,
      messages: st.messages,
      revisions: st.sourceRevisions,
    };
  }

  /**
   * 回滚版本标量与被 `#trim` 换掉的数组引用。
   * 追加的条目由调用方按**对象身份**从尾部弹出（`#archive` 只从头部 splice，尾部就是本次追加的）。
   */
  #restoreRevisionScalars(st, snapshot) {
    st.sourceRevision = snapshot.sourceRevision;
    st.historyFloorRevision = snapshot.historyFloorRevision;
    st.nextLocalId = snapshot.nextLocalId;
    if (st.messages !== snapshot.messages) st.messages = snapshot.messages;
    if (st.sourceRevisions !== snapshot.revisions) st.sourceRevisions = snapshot.revisions;
  }

  /**
   * 读一片冷分片正文（含 revisions 数组与有效性）。★ 2026-10-19 S09：正文只在**真正要**时读，
   * 元数据不再依赖它；这里返回的 revisions 与 messages 同源同长（旧实现读文件与清单各存一份）。
   */
  #readColdChunkDetailed(st, chunk) {
    const file = coldChunkFile(st.chatKey, chunk.seq, coldDir(this.dataDir));
    const read = readJsonDetailed(file);
    if (!read.ok) {
      this.health.noteCorrupt(file, read.reason);
      return { ok: false, messages: [], sourceRevisions: null, revisionValid: false };
    }
    const j = read.value;
    const messages = j && Array.isArray(j.messages) ? j.messages : [];
    const revisionData = readRevisionArray(j?.sourceRevisions, messages.length);
    return { ok: true, messages, sourceRevisions: revisionData.values, revisionValid: revisionData.valid };
  }

  #readColdChunk(st, chunk) {
    return this.#readColdChunkDetailed(st, chunk).messages;
  }

  #findColdMatch(st, predicate, midValue = null) {
    for (const chunk of st._cold.chunks) {
      if (midValue != null && !midBloomMayContain(chunk.midBloom, midValue)) continue;
      const detailed = this.#readColdChunkDetailed(st, chunk);
      const messages = detailed.messages;
      for (let i = 0; i < messages.length; i += 1) {
        if (predicate(messages[i])) {
          return {
            chunk, messages, index: i, message: messages[i],
            sourceRevisions: detailed.sourceRevisions, revisionValid: detailed.revisionValid,
          };
        }
      }
    }
    return null;
  }

  #findColdChunkAt(st, absoluteIndex) {
    let low = 0;
    let high = st._cold.chunks.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const chunk = st._cold.chunks[mid];
      if (absoluteIndex < chunk.start) high = mid - 1;
      else if (absoluteIndex >= chunk.start + chunk.len) low = mid + 1;
      else return chunk;
    }
    return null;
  }

  #findColdLocalId(st, localId) {
    const id = Number(localId);
    if (!Number.isFinite(id)) return null;
    const chunks = st._cold.chunks;
    if (!st._cold.localIdsOrdered) return this.#findColdMatch(st, (message) => message.id === id);
    let low = 0;
    let high = chunks.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const chunk = chunks[mid];
      if (!Number.isFinite(chunk.firstId) || !Number.isFinite(chunk.lastId)) break;
      if (id < chunk.firstId) high = mid - 1;
      else if (id > chunk.lastId) low = mid + 1;
      else {
        const detailed = this.#readColdChunkDetailed(st, chunk);
        const messages = detailed.messages;
        const index = messages.findIndex((message) => message.id === id);
        if (index >= 0) {
          return {
            chunk, messages, index, message: messages[index],
            sourceRevisions: detailed.sourceRevisions, revisionValid: detailed.revisionValid,
          };
        }
        return this.#findColdMatch(st, (message) => message.id === id);
      }
    }
    if (chunks.some((chunk) => !Number.isFinite(chunk.firstId) || !Number.isFinite(chunk.lastId))) {
      return this.#findColdMatch(st, (message) => message.id === id);
    }
    return null;
  }

  #forEachMessage(st, visit) {
    const one = (message) => { if (message && typeof message === 'object') visit(message); };
    for (const chunk of st._cold.chunks) {
      for (const message of this.#readColdChunk(st, chunk)) one(message);
    }
    for (const message of st.messages) one(message);
  }

  #recentFromState(st, { limit = 80, offset = 0, includeSelf = true } = {}) {
    const lim = Math.max(1, Number(limit) || 1);
    const off = Math.max(0, Number(offset) || 0);
    const out = [];
    if (includeSelf) {
      let cursor = st._cold.total + st.messages.length - off - 1;
      while (cursor >= 0 && out.length < lim) {
        if (cursor >= st._cold.total) {
          const hot = st.messages[cursor - st._cold.total];
          if (hot && typeof hot === 'object') out.push(hot);
          cursor -= 1;
          continue;
        }
        const chunk = this.#findColdChunkAt(st, cursor);
        if (!chunk) { cursor -= 1; continue; }
        const messages = this.#readColdChunk(st, chunk);
        // ★ 加固（旧实现没有）：冷片被挪走/重写后长度会变短，下标可能越过该片实际长度
        //   ⇒ messages[i] 可能是 undefined。旧实现在这里会把 undefined 塞进 recent 的返回，
        //   随后 appendIncoming 的查重循环读 prev.self 直接抛 TypeError（本次实测复现）。
        //   这里只收真对象，坏条目跳过（health 里另有留痕）。
        for (let i = Math.min(cursor - chunk.start, messages.length - 1); i >= 0 && out.length < lim; i -= 1) {
          if (messages[i] && typeof messages[i] === 'object') out.push(messages[i]);
        }
        cursor = chunk.start - 1;
      }
      out.reverse();
      return out;
    }
    let skipped = 0;
    const visit = (message) => {
      if (!includeSelf && message.self) return false;
      if (skipped < off) { skipped += 1; return false; }
      out.push(message);
      return out.length >= lim;
    };
    for (let i = st.messages.length - 1; i >= 0 && out.length < lim; i -= 1) {
      if (visit(st.messages[i])) break;
    }
    if (out.length < lim) {
      for (let c = st._cold.chunks.length - 1; c >= 0 && out.length < lim; c -= 1) {
        const messages = this.#readColdChunk(st, st._cold.chunks[c]);
        for (let i = messages.length - 1; i >= 0 && out.length < lim; i -= 1) {
          if (visit(messages[i])) break;
        }
      }
    }
    out.reverse();
    return out;
  }

  /**
   * 写驻留热段。
   * ★ 新增闸：热段文件**存在但读不动**时，先挪成 `.corrupt-<ts>` 再写 ——
   *   否则会把仅存的那份内容**静默覆盖掉**（旧实现 `writeJsonAtomic` 直接盖）。
   */
  #save(st) {
    const file = chatFile(st.chatKey, messagesDir(this.dataDir));
    // ★ 2026-10-18 S02：探查跳过 —— 文件仍是本进程上次写出的那一份（size+mtime 戳一致）时，
    //   不必再把整份热档读回验证。戳不一致/缺失（外部改写、首次写入、上次失败）时照旧全量探查。
    if (!this.#hotFileLooksCurrent(file, st)) {
      const probe = readJsonDetailed(file);
      if (!probe.ok) {
        const aside = `${file}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(file, aside);
          this.health.notePreserved(file, aside, probe.reason);
        } catch (error) {
          this.health.noteCorrupt(file, `preserve-failed:${error?.code || error?.message || error}`);
        }
      }
    }
    writeJsonAtomicRetry(file, {
      chatKey: st.chatKey,
      nextLocalId: st.nextLocalId,
      messages: st.messages,
      sourceRevisions: st.sourceRevisions,
      sourceRevision: st.sourceRevision,
      historyFloorRevision: st.historyFloorRevision,
    });
    st._hotFileStamp = stampOf(file);
  }

  /** 热档是否仍是本进程上次写出的那份（size+mtime 戳一致）。取不到戳/文件变过 ⇒ false（走全量探查）。 */
  #hotFileLooksCurrent(file, st) {
    const stamp = st._hotFileStamp;
    if (!stamp || stamp.file !== file) return false;
    const now = stampOf(file);
    return !!now && now.size === stamp.size && now.mtimeMs === stamp.mtimeMs;
  }

  /** 热段超过水位（hotPerChat*2）时，一次性把它降回 hotPerChat。 */
  #maybeArchive(st) {
    if (this.maxPerChat > 0 || this.hotPerChat <= 0) return;
    const hotLen = st.messages.length;
    const waterline = this.hotPerChat * 2;
    if (hotLen <= waterline) { st._cold.archivePressureWarned = false; return; }
    const target = hotLen - this.hotPerChat;
    // 冷段按约定只能包含已终结消息：未读 / 有活租约的前缀留在热段。
    let safePrefix = 0;
    const now = Date.now();
    for (let i = 0; i < st.messages.length && safePrefix < target; i++) {
      const message = st.messages[i];
      const routeClaim = message.routeClaim;
      const claim = message.routeClaim && typeof message.routeClaim === 'object' ? message.routeClaim : null;
      const leaseUntil = Number(claim?.leaseUntil);
      const liveClaim = Number.isFinite(leaseUntil) && leaseUntil > now;
      if (routeClaim && !liveClaim) delete message.routeClaim;
      if (!message.read || liveClaim) break;
      safePrefix += 1;
    }
    if (safePrefix > 0) this.#archive(st, safePrefix);
    if (st._cold.manifestDirty) {
      st._cold.manifestDirty = false;
      flushColdManifest(st.chatKey, st._cold.chunks, this.dataDir);
    }
    if (st.messages.length > waterline) {
      if (!st._cold.archivePressureWarned) {
        console.warn(`[chat-store] resident messages exceed archive waterline (${st.messages.length} > ${waterline}); unread/live-claim prefix blocks archival`);
        st._cold.archivePressureWarned = true;
      }
    } else st._cold.archivePressureWarned = false;
  }

  /** 把热数组前 count 条搬进冷分片（写满一片就开下一片），再从内存热段移除。 */
  #archive(st, count) {
    let remain = count;
    let sourceIndex = 0;
    while (remain > 0) {
      // ★ 2026-10-18 S01：先算好这一片的全部账目，**落盘成功后才提交进内存**。
      //   失败（重试后仍抛）时 _cold 与盘面保持一致，调用方可安全回滚整次追加；
      //   旧顺序先改内存再写盘，写失败会给下一次归档留下重复叠加的版本账。
      const needNew = st._cold.seq < 0 || st._cold.lastLen >= COLD_CHUNK;
      const seq = needNew ? (st._cold.seq >= 0 ? st._cold.seq + 1 : 0) : st._cold.seq;
      const baseLen = needNew ? 0 : st._cold.lastLen;
      const baseChunk = needNew ? null : st._cold.chunks[st._cold.chunks.length - 1];
      const previousChunk = needNew ? st._cold.chunks[st._cold.chunks.length - 1] : st._cold.chunks[st._cold.chunks.length - 2];
      const take = Math.min(COLD_CHUNK - baseLen, remain);
      const slice = st.messages.slice(sourceIndex, sourceIndex + take);
      const revisionSlice = st.sourceRevisions.slice(sourceIndex, sourceIndex + take);
      let localIdsOrdered = st._cold.localIdsOrdered;
      if (!hasIncreasingLocalIds(slice)
        || (baseChunk?.lastId != null && Number(slice[0]?.id) <= baseChunk.lastId)
        || (baseChunk?.lastId == null && previousChunk?.lastId != null && Number(slice[0]?.id) <= previousChunk.lastId)) {
        localIdsOrdered = false;
      }
      // ★ 2026-10-19 S09：base 片正文 + revisions 一次读回（读不动时它已由 saveColdChunk 挪成
      //   `.corrupt-<ts>` 备份——新文件只装 slice，版本账也按 slice 记，长度严格同源）。
      const base = baseLen > 0 ? this.#readColdChunkDetailed(st, baseChunk) : null;
      const existing = base ? base.messages : [];
      const combined = existing.concat(slice);
      const nextRevisions = (base && Array.isArray(base.sourceRevisions) ? base.sourceRevisions : []).concat(revisionSlice);
      const maxSourceRevision = nextRevisions.reduce((max, value) => Math.max(max, value), 0);
      const nextBloom = baseChunk?.midBloom instanceof Uint8Array
        ? addMidBloom(baseChunk.midBloom.slice(), slice)
        : createMidBloom(combined); // 清单没了布隆（解不出来）⇒ 拿合并后的正文整块重建，绝不用空布隆顶替
      const nextLen = combined.length; // ★ 10-19：以**实际写出的正文**记账（坏 base 被挪走后 combined 只剩 slice；旧实现按 baseLen+take 记会一直虚报）
      const firstId = existing.length
        ? (baseChunk?.firstId != null ? baseChunk.firstId : Number(existing[0]?.id))
        : Number(slice[0]?.id);
      const lastId = slice.length ? Number(slice[slice.length - 1]?.id) : (baseChunk?.lastId ?? null);
      // 落盘在提交内存之前；payload 内嵌当前（已 begin 的）版本——meta 走 #commitSourceRevision，恒不超前。
      saveColdChunk(st.chatKey, seq, combined, this.health, this.dataDir, nextRevisions, st.sourceRevision);
      if (needNew) {
        st._cold.chunks.push({
          seq, start: st._cold.total, len: 0,
          firstId: null, lastId: null, idsIncreasing: true, midBloom: new Uint8Array(MID_BLOOM_BYTES),
          maxSourceRevision: 0,
          sourceRevisionValue: null, sourceRevisionPresent: false, sourceRevisionValid: true,
          sourceRevisionsPresent: true, sourceRevisionsValid: true,
          lastTs: null, lastText: null, stamp: null,
        });
      }
      const chunk = st._cold.chunks[st._cold.chunks.length - 1];
      chunk.maxSourceRevision = maxSourceRevision;
      chunk.midBloom = nextBloom;
      chunk.len = nextLen;
      chunk.firstId = firstId;
      chunk.lastId = lastId;
      chunk.idsIncreasing = hasIncreasingLocalIds(combined);
      // 清单账目（内存），#maybeArchive 末尾统一刷盘；戳 = 刚落盘这份文件此刻的 stat。
      chunk.sourceRevisionValue = isRevision(st.sourceRevision) ? st.sourceRevision : null;
      chunk.sourceRevisionPresent = true;
      chunk.sourceRevisionValid = true;
      chunk.sourceRevisionsPresent = true;
      chunk.sourceRevisionsValid = true;
      const tail = combined[combined.length - 1];
      chunk.lastTs = tail?.ts ?? null;
      chunk.lastText = tail?.text ?? null;
      chunk.stamp = stampOf(coldChunkFile(st.chatKey, seq, coldDir(this.dataDir)));
      st._cold.manifestDirty = true;
      st._cold.seq = seq;
      st._cold.lastLen = nextLen;
      st._cold.total += slice.length;
      if (slice.length) {
        const last = slice[slice.length - 1];
        if (last) st._cold.lastMessage = { ts: last.ts, text: last.text };
      }
      st._cold.localIdsOrdered = localIdsOrdered;
      sourceIndex += take;
      remain -= take;
    }
    st.messages.splice(0, sourceIndex);
    st.sourceRevisions.splice(0, sourceIndex);
  }

  /** 清空该会话全部冷分片（用户设了硬上限时用：上限的语义是存档文件里也不留）。 */
  #clearCold(st) {
    for (const c of st._cold.chunks) {
      try { fs.rmSync(coldChunkFile(st.chatKey, c.seq, coldDir(this.dataDir)), { force: true }); } catch { /* 删不掉就算了 */ }
    }
    // ★ 2026-10-19：冷片没了，清单留着只会全是"缺片"（虽无害），顺手清掉（缓存，删失败/不存在都无所谓）。
    try { fs.rmSync(coldManifestFile(st.chatKey, this.dataDir), { force: true }); } catch { /* 删不掉就算了 */ }
    st._cold.chunks = [];
    st._cold.seq = -1;
    st._cold.lastLen = 0;
    st._cold.total = 0;
    st._cold.lastMessage = null;
    st._cold.archivePressureWarned = false;
    st._cold.localIdsOrdered = true;
  }

  listChats() {
    const out = [...this.chats.keys()];
    const seen = new Set(out);
    try {
      const files = fs.readdirSync(messagesDir(this.dataDir)).filter((f) => /^(group|private)_\d+\.json$/.test(f));
      for (const f of files) {
        const m = /^(group|private)_(\d+)\.json$/.exec(f);
        if (m) {
          const key = `${m[1]}:${m[2]}`;
          if (!seen.has(key)) { seen.add(key); out.push(key); }
        }
      }
    } catch { /* 目录不存在 */ }
    return out;
  }

  /**
   * 把"存档文件已经不在了"的会话从内存里清掉（内存里残留的幽灵记录）。
   * 用户手动删了 data/messages/xxx.json 之后，进程里那份状态还在、列表照样显示。
   * @returns {number} 被清掉的会话数
   */
  pruneMissingFiles() {
    const now = Date.now();
    if (this._prunedAt && now - this._prunedAt < 30000) return 0;
    this._prunedAt = now;
    let dropped = 0;
    for (const key of [...this.chats.keys()]) {
      try {
        if (fs.existsSync(chatFile(key, messagesDir(this.dataDir)))) continue;
      } catch { /* stat 失败也当作不存在 */ }
      this.chats.delete(key);
      dropped += 1;
    }
    return dropped;
  }

  /** 清空某个会话的全部消息记录（热段 + 冷分片 + 内存状态）。 */
  purgeChat(chatKey) {
    const key = String(chatKey || '');
    const st = this.#state(key);
    const messages = st._cold.total + st.messages.length;
    this.#beginSourceRevision(st, { resetHistory: true });
    let removed = 0;
    const rm = (file) => { try { if (fs.existsSync(file)) { fs.rmSync(file, { force: true }); removed += 1; } } catch { /* ignore */ } };
    rm(chatFile(key, messagesDir(this.dataDir)));
    for (const seq of listColdSeqs(key, coldDir(this.dataDir))) rm(coldChunkFile(key, seq, coldDir(this.dataDir)));
    // ★ 2026-10-19：清单只是缓存，删除**不计入 removedFiles**（"会话的消息文件数"语义不变）。
    try { fs.rmSync(coldManifestFile(key, this.dataDir), { force: true }); } catch { /* ignore */ }
    this.chats.delete(key);
    // ★ 2026-10-18 S01：删除后补写版本元数据（清空后它是"游标已作废"的唯一凭证；写失败降级记 health）。
    this.#commitSourceRevision(st);
    return { chatKey: key, removedFiles: removed, messages };
  }

  /** 清空**所有**会话的消息记录（连冷分片目录一起）。 */
  purgeAll() {
    const keys = this.listChats();
    let removedFiles = 0;
    let messages = 0;
    for (const key of keys) {
      const r = this.purgeChat(key);
      removedFiles += r.removedFiles;
      messages += r.messages;
    }
    this.chats.clear();
    return { chats: keys.length, removedFiles, messages };
  }

  /** 会话摘要：旧字段保持原义，sourceRevision 表示该会话的追加/正文修订游标。 */
  getChatMeta(chatKey) {
    const st = this.chats.get(chatKey);
    if (st) {
      const unread = st.messages.filter((m) => !m.read).length;
      const last = st.messages[st.messages.length - 1] || st._cold.lastMessage;
      return {
        chatKey,
        total: st._cold.total + st.messages.length,
        unread,
        lastTs: last?.ts ?? 0,
        lastText: last?.text ?? '',
        sourceRevision: st.revisionReliable ? st.sourceRevision : null,
      };
    }
    const hot = readJson(chatFile(chatKey, messagesDir(this.dataDir)), this.health);
    const hotMessages = hot && Array.isArray(hot.messages) ? hot.messages : [];
    // ★ 2026-10-19 S09：非驻留会话摘要走清单（不整扫正文）；清单缺失/坏时退回旧启发式。
    const cold = coldSummary(chatKey, this.dataDir, this.health);
    const revisionMeta = readRevisionMeta(chatKey, this.health, this.dataDir);
    const sourceRevision = Math.max(
      revisionMeta.sourceRevision ?? 0,
      isRevision(hot?.sourceRevision) ? hot.sourceRevision : 0,
      cold.sourceRevision ?? 0,
    );
    const last = hotMessages[hotMessages.length - 1] || cold.last;
    return {
      chatKey,
      total: cold.total + hotMessages.length,
      unread: hotMessages.filter((m) => !m.read).length,
      lastTs: last?.ts ?? 0,
      lastText: last?.text ?? '',
      sourceRevision: revisionMeta.reliable ? sourceRevision : null,
    };
  }

  /**
   * 追加一条收到的消息（未读）。返回写入的条目。
   * ⚠️ 这里**只观察、不去重**：同一条被上游发两遍时 QQ mid 往往不同，数据上分不出"同一条"；
   *   按"同人+同文+几秒内"硬去重会误杀真实连发。所以只打标记（dupSuspect / dupGapMs / dupPrevMid / dupMediaDiff）。
   */
  appendIncoming(chatKey, { mid, ts, senderId, senderName, text, reply = null, media = [], toSelf = false, replyToSelf = false }) {
    const st = this.#state(chatKey);
    const snapshot = this.#mutationSnapshot(st);
    const sourceRevision = this.#beginSourceRevision(st);
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: String(senderId ?? ''),
      senderName: String(senderName ?? ''),
      text: String(text ?? ''),
      self: false,
      read: false,
      reply: reply || null,
      toSelf: !!toSelf,
      replyToSelf: !!replyToSelf,
      media: Array.isArray(media) ? media : []
    };

    const DUP_WINDOW_MS = 8000;
    const textKey = entry.text.trim();
    if (textKey) {
      const previousMessages = this.#recentFromState(st, { limit: 30 });
      for (let i = previousMessages.length - 1; i >= 0; i -= 1) {
        const prev = previousMessages[i];
        if (!prev || typeof prev !== 'object') continue;   // ★ 加固：坏条目跳过，不许抛
        if (prev.self) continue;
        if (String(prev.mid ?? '') === String(entry.mid ?? '')) continue;
        if (prev.senderId !== entry.senderId) continue;
        const gap = entry.ts - Number(prev.ts || 0);
        if (gap < 0 || gap > DUP_WINDOW_MS) continue;
        if (String(prev.text || '').trim() !== textKey) continue;
        entry.dupSuspect = true;
        entry.dupGapMs = gap;
        entry.dupPrevMid = prev.mid ?? null;
        const prevUrls = (prev.media || []).map((m) => m && m.url).filter(Boolean).join('|');
        const nowUrls = (entry.media || []).map((m) => m && m.url).filter(Boolean).join('|');
        entry.dupMediaDiff = prevUrls !== nowUrls;
        break;
      }
    }

    st.messages.push(entry);
    st.sourceRevisions.push(sourceRevision);
    try {
      this.#trim(st);
      this.#maybeArchive(st);
      this.#save(st);
    } catch (error) {
      // ★ 2026-10-18 S01：数据没写上盘就回滚这次追加，不谎报成功（内存不得比盘面多一条）。
      //   #archive 只从头部 splice 且已改为"先落盘、后记账"，按对象身份从尾部弹回即可。
      this.#restoreRevisionScalars(st, snapshot);
      if (st.messages[st.messages.length - 1] === entry) st.messages.pop();
      if (st.sourceRevisions[st.sourceRevisions.length - 1] === sourceRevision) st.sourceRevisions.pop();
      throw error;
    }
    if (st._memberIndex) this.#indexMember(st._memberIndex, entry);
    this.#commitSourceRevision(st);
    appendInbox(chatKey, entry);   // 兴趣唤醒的观察口，见文件顶部注释；没配 MING_QQ_INBOX 就是空操作
    return entry;
  }

  /**
   * 记录机器人自己发出的消息（已读）。
   * @param {string} chatKey
   * @param {{text:string, ts?:number, mid?:number|null, hype?:boolean,
   *          persona2?:boolean|null, reply?:object|null}} m
   *        persona2 传 null（默认）= 按 `isPersonaTwo()` 此刻自动打标；显式 true/false 以显式值为准。
   */
  appendSelf(chatKey, { text, ts, mid = null, hype = false, persona2 = null, reply = null }) {
    const st = this.#state(chatKey);
    const snapshot = this.#mutationSnapshot(st);
    const sourceRevision = this.#beginSourceRevision(st);
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: 'self',
      senderName: '我',
      text: String(text ?? ''),
      self: true,
      read: true,
      reply: reply || null,
      media: []
    };
    if (hype) entry.hype = true;
    const isP2 = persona2 === null ? this.safeIsPersonaTwo() : persona2 === true;
    if (isP2) entry.persona2 = true;
    st.messages.push(entry);
    st.sourceRevisions.push(sourceRevision);
    try {
      this.#trim(st);
      this.#maybeArchive(st);
      this.#save(st);
    } catch (error) {
      // ★ 2026-10-18 S01：同 appendIncoming —— 写失败回滚，不留下"内存有、盘上没有"的自述记录。
      this.#restoreRevisionScalars(st, snapshot);
      if (st.messages[st.messages.length - 1] === entry) st.messages.pop();
      if (st.sourceRevisions[st.sourceRevisions.length - 1] === sourceRevision) st.sourceRevisions.pop();
      throw error;
    }
    this.#commitSourceRevision(st);
    return entry;
  }

  /** 兼容性全量消费接口，仅用于明确需要一次性清空全部未读的路径。 */
  drainUnread(chatKey) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read && !m.self);
    if (!unread.length) return unread;
    for (const m of st.messages) {
      m.read = true;
      delete m.routeRetry;
      delete m.routeClaim;
    }
    this.#save(st);
    return unread;
  }

  /** 只消费路由判定时快照到的消息 id；之后到达的新消息仍保持未读。 */
  drainUnreadByIds(chatKey, ids = []) {
    const st = this.#state(chatKey);
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isSafeInteger));
    if (!wanted.size) return [];
    const unread = st.messages.filter((m) => wanted.has(Number(m.id)) && !m.read && !m.self);
    if (!unread.length) return unread;
    for (const m of unread) {
      m.read = true;
      delete m.routeRetry;
      delete m.routeClaim;
    }
    this.#save(st);
    return unread;
  }

  /** 在主模型处理期间暂时占用本批消息，但不把它们标为已读。 */
  claimUnreadByIds(chatKey, ids = [], batchId, { leaseMs = 10 * 60 * 1000, now = Date.now() } = {}) {
    const st = this.#state(chatKey);
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isSafeInteger));
    if (!wanted.size || !batchId) return [];
    const leaseUntil = now + Math.max(1000, Number(leaseMs) || 10 * 60 * 1000);
    const claimed = [];
    let changed = false;
    for (const m of st.messages) {
      if (!wanted.has(Number(m.id)) || m.read || m.self) continue;
      const current = m.routeClaim && typeof m.routeClaim === 'object' ? m.routeClaim : null;
      if (current && Number(current.leaseUntil) > now) continue;
      m.routeClaim = { batchId: String(batchId).slice(0, 160), leaseUntil };
      claimed.push(m);
      changed = true;
    }
    if (changed) this.#save(st);
    return claimed;
  }

  /** 续租，防止长回合被别的运行重复占用。 */
  renewRouteClaim(chatKey, ids = [], batchId, { leaseMs = 10 * 60 * 1000, now = Date.now() } = {}) {
    const st = this.#state(chatKey);
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isSafeInteger));
    if (!wanted.size || !batchId) return 0;
    const leaseUntil = now + Math.max(1000, Number(leaseMs) || 10 * 60 * 1000);
    let renewed = 0;
    for (const m of st.messages) {
      if (!wanted.has(Number(m.id)) || m.read || m.self || m.routeClaim?.batchId !== batchId) continue;
      m.routeClaim.leaseUntil = leaseUntil;
      renewed += 1;
    }
    if (renewed) this.#save(st);
    return renewed;
  }

  /** 失败或取消时释放本批占用，让消息仍可由后续唤醒处理。 */
  releaseRouteClaim(chatKey, ids = [], batchId = null) {
    const st = this.#state(chatKey);
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isSafeInteger));
    if (!wanted.size) return 0;
    let n = 0;
    for (const m of st.messages) {
      if (!wanted.has(Number(m.id)) || !m.routeClaim) continue;
      if (batchId && m.routeClaim.batchId !== batchId) continue;
      delete m.routeClaim;
      n += 1;
    }
    if (n) this.#save(st);
    return n;
  }

  /** 只由仍持有对应 claim 的运行提交已读，迟到旧运行不能结案新运行的批次。 */
  commitRouteClaim(chatKey, ids = [], batchId) {
    const st = this.#state(chatKey);
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isSafeInteger));
    if (!wanted.size || !batchId) return 0;
    let n = 0;
    for (const m of st.messages) {
      if (!wanted.has(Number(m.id)) || m.read || m.self || m.routeClaim?.batchId !== batchId) continue;
      m.read = true;
      delete m.routeClaim;
      delete m.routeRetry;
      n += 1;
    }
    if (n) this.#save(st);
    return n;
  }

  /** 只将指定快照中的未读消息标记为已读，不波及同会话后到的消息。 */
  markReadByIds(chatKey, ids = []) {
    const st = this.#state(chatKey);
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isSafeInteger));
    if (!wanted.size) return 0;
    let n = 0;
    for (const m of st.messages) {
      if (wanted.has(Number(m.id)) && !m.read && !m.self) {
        m.read = true;
        delete m.routeRetry;
        delete m.routeClaim;
        n += 1;
      }
    }
    if (n) this.#save(st);
    return n;
  }

  /** 为技术性未判定记录有限、可跨进程重启保留的重试次数。 */
  registerRouteRetry(chatKey, ids = [], { maxAttempts = 2, maxAgeMs = 60000, now = Date.now() } = {}) {
    const st = this.#state(chatKey);
    const wanted = new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isSafeInteger));
    const retryIds = [];
    const exhaustedIds = [];
    let maxAttemptsSeen = 0;
    const attemptsLimit = Math.max(1, Math.floor(Number(maxAttempts) || 2));
    const ageLimit = Math.max(1000, Number(maxAgeMs) || 60000);
    for (const m of st.messages) {
      if (!wanted.has(Number(m.id)) || m.read || m.self) continue;
      const previous = m.routeRetry && typeof m.routeRetry === 'object' ? m.routeRetry : {};
      const firstAt = Number(previous.firstAt) > 0 ? Number(previous.firstAt) : now;
      const attempts = Math.max(0, Number(previous.attempts) || 0) + 1;
      maxAttemptsSeen = Math.max(maxAttemptsSeen, attempts);
      if (attempts >= attemptsLimit || now - firstAt >= ageLimit) {
        exhaustedIds.push(Number(m.id));
        delete m.routeRetry;
      } else {
        m.routeRetry = { attempts, firstAt };
        retryIds.push(Number(m.id));
      }
    }
    if (retryIds.length || exhaustedIds.length) this.#save(st);
    return { retryIds, exhaustedIds, attempts: maxAttemptsSeen };
  }

  /** 把当前所有未读标记为已读，**但不取走它们**（UI 手动标记 / 暂停清空用）。 */
  markAllRead(chatKey) {
    const st = this.#state(chatKey);
    let n = 0;
    for (const m of st.messages) {
      if (!m.read && !m.self) { m.read = true; delete m.routeRetry; delete m.routeClaim; n++; }
    }
    if (n) this.#save(st);
    return n;
  }

  unreadCount(chatKey) {
    const st = this.chats.get(chatKey);
    if (st) return st.messages.filter((m) => !m.read && !m.self).length;
    const hot = readJson(chatFile(chatKey, messagesDir(this.dataDir)), this.health);
    const hotMessages = hot && Array.isArray(hot.messages) ? hot.messages : [];
    return hotMessages.filter((m) => !m.read && !m.self).length;
  }

  /**
   * 查看当前未读消息（不置已读），用于"等待中"会话的触发摘要。
   * ★ 2026-10-18 S09：**未读只可能住热段** —— `#maybeArchive` 的 safePrefix 遇到第一条未读即停
   *   （未读/带活租约的消息不会被归档进冷片）⇒ 非驻留会话直接读热档文件即可，绝不再为
   *   "看几条未读"把全部冷分片读进内存（pause→resume 按会话逐个 peek 时是实测的卡顿源）。
   *   返回**最老**的 N 条未读；已读推进靠 claim/commit —— 分批回放按 limit 切页、处理完提交后再取下一批。
   */
  peekUnread(chatKey, limit = 3) {
    const lim = Math.max(1, Number(limit) || 3);
    const now = Date.now();
    const pick = (messages) => messages.filter((m) => !m.read && !m.self
      && !(m.routeClaim && Number(m.routeClaim.leaseUntil) > now))
      .slice(0, lim);
    const st = this.chats.get(chatKey);
    if (st) return pick(st.messages);
    const hot = readJson(chatFile(chatKey, messagesDir(this.dataDir)), this.health);
    const hotMessages = hot && Array.isArray(hot.messages) ? hot.messages : [];
    return pick(hotMessages);
  }

  /**
   * 取最近的若干条。
   * ⚠️ 从尾部倒扫（不是 filter+slice）：172,998 条的群每轮要调十几次，全表遍历白付几十毫秒。
   *    语义：offset = 在（过滤后的）序列里跳过最近 N 条。
   */
  recent(chatKey, { limit = 80, offset = 0, includeSelf = true } = {}) {
    const st = this.#state(chatKey);
    return this.#recentFromState(st, { limit, offset, includeSelf });
  }

  /**
   * Read messages appended or revised after a sourceRevision cursor.
   * `truncated` also means the cursor predates retained history or a write was
   * interrupted; callers must rebuild from the full source in that case.
   */
  readSince(chatKey, cursor, limit = 1000) {
    const st = this.#state(chatKey);
    const revision = st.revisionReliable ? st.sourceRevision : null;
    const validCursor = isRevision(cursor);
    const cursorNum = validCursor ? cursor : 0;
    const nextCursorOnError = validCursor ? cursorNum : 0;
    const requestedLimit = Number(limit);
    const limitNum = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(1000, Math.floor(requestedLimit)))
      : 1000;
    const empty = (nextCursor, truncated) => ({ items: [], nextCursor, revision, truncated });

    if (!validCursor || revision === null || cursorNum > revision) return empty(nextCursorOnError, true);
    if (cursorNum < st.historyFloorRevision) return empty(cursorNum, true);

    const candidates = [];
    let observedRevision = 0;
    const addCandidates = (messages, revisions) => {
      if (!Array.isArray(messages) || !Array.isArray(revisions) || messages.length !== revisions.length) return false;
      for (let i = 0; i < messages.length; i += 1) {
        const itemRevision = revisions[i];
        if (!isRevision(itemRevision)) return false;
        observedRevision = Math.max(observedRevision, itemRevision);
        if (itemRevision <= cursorNum) continue;
        const message = messages[i];
        if (!message || typeof message !== 'object') return false;
        candidates.push({ ...message, sourceRevision: itemRevision });
      }
      return true;
    };

    for (const chunk of st._cold.chunks) {
      observedRevision = Math.max(observedRevision, chunk.maxSourceRevision || 0);
      if ((chunk.maxSourceRevision || 0) <= cursorNum) continue;
      // ★ 2026-10-19 S09：从清单元数据跳片；只有候选片才读正文（revisions 与正文同源同长的暂读）。
      const detailed = this.#readColdChunkDetailed(st, chunk);
      if (!detailed.ok) return empty(cursorNum, true);
      if (!addCandidates(detailed.messages, detailed.sourceRevisions)) return empty(cursorNum, true);
    }
    if (!addCandidates(st.messages, st.sourceRevisions)) return empty(cursorNum, true);
    observedRevision = st.sourceRevisions.reduce((max, value) => Math.max(max, value), observedRevision);
    if (cursorNum < revision && observedRevision < revision) return empty(cursorNum, true);

    candidates.sort((a, b) => a.sourceRevision - b.sourceRevision || Number(a.id) - Number(b.id));
    const items = candidates.slice(0, limitNum);
    const truncated = candidates.length > limitNum;
    const nextCursor = truncated ? items[items.length - 1].sourceRevision : revision;
    return { items, nextCursor, revision, truncated };
  }

  /**
   * 按"模型给的引用目标"找消息：**先当 QQ message_id，再当本地短编号**。
   * 两种写法都认：`#318` / `318`（现在给模型看的），以及原始 mid `-997425862`（老会话里模型自己写的）。
   */
  findByRef(chatKey, ref) {
    const st = this.#state(chatKey);
    const raw = normalizeRef(ref);
    if (!raw) return null;
    const byMid = this.#findColdMatch(st, (m) => String(m.mid) === raw, raw)?.message
      || st.messages.find((m) => String(m.mid) === raw);
    if (byMid) return byMid;
    if (/^\d{1,7}$/.test(raw)) {
      const n = Number(raw);
      return this.#findColdLocalId(st, n)?.message
        || st.messages.find((m) => Number(m.id) === n)
        || null;
    }
    return null;
  }

  /** 兼容旧名字：语义等同于 findByRef（短编号也认）。 */
  findByMid(chatKey, mid) {
    return this.findByRef(chatKey, mid);
  }

  /**
   * 按 QQ 消息 id 更新一条已存档消息（文本 / 补媒体）并写入文件。
   * 用途：read_forward 把"合并转发占位符"永久升级成展开后的文本。
   */
  updateByMid(chatKey, mid, { text, appendMedia = [] } = {}) {
    const st = this.#state(chatKey);
    const target = String(mid);
    const cold = this.#findColdMatch(st, (m) => String(m.mid) === target, target);
    const hotIndex = cold ? -1 : st.messages.findIndex((m) => String(m.mid) === target);
    if (!cold && hotIndex < 0) return false;
    const snapshot = this.#mutationSnapshot(st);
    const sourceRevision = this.#beginSourceRevision(st);
    const m = cold ? cold.message : st.messages[hotIndex];
    if (text != null) m.text = String(text);
    if (appendMedia.length) {
      m.media = Array.isArray(m.media) ? m.media : [];
      const seen = new Set(m.media.map((x) => x && x.url));
      for (const x of appendMedia) {
        if (x && x.url && !seen.has(x.url)) { m.media.push(x); seen.add(x.url); }
      }
    }
    // ★ 2026-10-18 S01/S02：不再先整份重写热档占位（冷片 payload 自己内嵌新版本，加载端取 max）。
    //   写失败时回滚版本账目；文本/媒体的**内存**修改保留 —— 下一次成功保存会把它一起带上盘，
    //   比"整条更新静默消失"更安全，且调用方仍会收到这次失败。
    if (cold) {
      // ★ 2026-10-19 S09：revisions 来自本次正文读取的暂存数组（不再常驻分片记录）。
      const revisions = Array.isArray(cold.sourceRevisions) ? cold.sourceRevisions.slice() : Array(cold.messages.length).fill(0);
      const prevMax = cold.chunk.maxSourceRevision;
      revisions[cold.index] = sourceRevision;
      const nextMax = revisions.reduce((max, value) => Math.max(max, value), 0);
      try {
        saveColdChunk(st.chatKey, cold.chunk.seq, cold.messages, this.health, this.dataDir,
          revisions, st.sourceRevision);
      } catch (error) {
        cold.chunk.maxSourceRevision = prevMax;
        this.#restoreRevisionScalars(st, snapshot);
        throw error;
      }
      cold.chunk.maxSourceRevision = nextMax;
      cold.chunk.sourceRevisionPresent = true;
      cold.chunk.sourceRevisionValid = true;
      cold.chunk.sourceRevisionValue = st.sourceRevision;
      cold.chunk.sourceRevisionsPresent = true;
      cold.chunk.sourceRevisionsValid = true;
      cold.chunk.stamp = stampOf(coldChunkFile(st.chatKey, cold.chunk.seq, coldDir(this.dataDir)));
      const lastChunk = st._cold.chunks[st._cold.chunks.length - 1];
      if (cold.chunk.seq === lastChunk?.seq && cold.index === cold.messages.length - 1) {
        st._cold.lastMessage = { ts: m.ts, text: m.text };
        cold.chunk.lastTs = m.ts ?? null;
        cold.chunk.lastText = m.text ?? null;
      }
      // 重写过头就把清单刷新到盘上（重启后一次读也命中清单；写失败只是缓存旧，加载端戳不符自愈）。
      flushColdManifest(st.chatKey, st._cold.chunks, this.dataDir);
      st._cold.manifestDirty = false;
    } else {
      const prevRevision = st.sourceRevisions[hotIndex];
      st.sourceRevisions[hotIndex] = sourceRevision;
      try {
        this.#save(st);
      } catch (error) {
        st.sourceRevisions[hotIndex] = prevRevision;
        this.#restoreRevisionScalars(st, snapshot);
        throw error;
      }
    }
    this.#commitSourceRevision(st);
    return true;
  }

  /** 按**本地递增序号**取一条（`msgRef()` 给模型看的就是它）。 */
  findByLocalId(chatKey, localId) {
    const st = this.#state(chatKey);
    return this.#findColdLocalId(st, localId)?.message
      || st.messages.find((m) => m.id === Number(localId))
      || null;
  }

  /**
   * 最近出现过的活跃成员（带最后发言时间）。
   * ★ 2026-10-18 S02：改为**一次全量建索引、之后随追加增量维护**。编排层点名解析每批都要调一次，
   *   旧实现每次都把冷片全部重读一遍（老群每批上百毫秒级同步 IO）；现在只有首次（或截断后）
   *   付一次全量读，追加时 O(1) 更新。归档只搬位置、不改成员归属，索引不受 `#archive` 影响。
   */
  activeMembers(chatKey, limit = 10) {
    const st = this.#state(chatKey);
    if (!st._memberIndex) st._memberIndex = this.#buildMemberIndex(st);
    return [...st._memberIndex.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, Math.max(1, limit));
  }

  /** 单条消息并入成员索引（与全量重建逐条同规则，保证两条路径结果一致）。 */
  #indexMember(map, message) {
    if (!message || message.self) return;
    const prev = map.get(message.senderId);
    if (!prev || prev.lastTs < message.ts) {
      map.set(message.senderId, {
        userId: message.senderId,
        name: message.senderName,
        lastTs: message.ts,
        count: (prev?.count || 0) + 1,
      });
    } else {
      prev.count += 1;
    }
  }

  #buildMemberIndex(st) {
    const map = new Map();
    this.#forEachMessage(st, (message) => this.#indexMember(map, message));
    return map;
  }

  #trim(st) {
    const total = st._cold.total + st.messages.length;
    if (this.maxPerChat <= 0 || total <= this.maxPerChat) return;
    const keep = this.#recentFromState(st, { limit: this.maxPerChat });
    const hotRevisions = new Map(st.messages.map((message, index) => [Number(message.id), st.sourceRevisions[index] ?? 0]));
    const keepRevisions = keep.map((message) => {
      const localId = Number(message.id);
      if (hotRevisions.has(localId)) return hotRevisions.get(localId);
      const cold = this.#findColdLocalId(st, message.id);
      return cold?.sourceRevisions?.[cold.index] ?? 0;
    });
    st.historyFloorRevision = st.sourceRevision;
    // ★ 2026-10-18 S01：先把"截断后的热段"落盘，再删冷分片、最后才提交内存。
    //   旧顺序先删冷片、后（依赖调用方）写热档：写失败会留下"冷片已删、热档还是旧内容"的盘面。
    //   revision 元数据（含新 historyFloorRevision）由调用方在数据写成功后经 #commitSourceRevision 补。
    const prevMessages = st.messages;
    const prevRevisions = st.sourceRevisions;
    const prevFloor = st.historyFloorRevision;
    st.messages = keep;
    st.sourceRevisions = keepRevisions;
    try {
      this.#save(st);
    } catch (error) {
      st.messages = prevMessages;
      st.sourceRevisions = prevRevisions;
      st.historyFloorRevision = prevFloor;
      throw error;
    }
    this.#clearCold(st);
    st._memberIndex = null;   // 截断后成员索引按保留集懒重建
  }
}

/**
 * 装配层工厂（**推荐入口**）。
 *
 * dataDir **不许默认回落**：要么显式传 `dataDir`，要么先有 `QQ_AGENT_DATA_DIR`，
 * 都没有就**抛**（`./data-dir.js` 的 `getDataDir()`）——**绝不**默认落仓库 `data/`。
 * 同一解析后的 dataDir 复用同一实例；每个实例固定读写自己的目录，支持临时多目录并行。
 *
 * ```js
 * // 装配层（apps/server）
 * const store = createChatStore({ dataDir, maxPerChat: 0, hotPerChat: 3000, isPersonaTwo: () => emotion.isPersonaTwoNow() });
 * ```
 *
 * @param {object} [opts] 见 ChatStore 构造；另可传 `dataDir`（会调 `setDataDir`，即显式授权）
 * @returns {ChatStore} 同一规范化 dataDir 在本进程内始终返回同一实例
 */
const CHAT_STORE_SINGLETONS = new Map();

function chatStoreKey(dataDir) {
  const resolved = path.resolve(dataDir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function createChatStore(opts = {}) {
  const { dataDir, ...rest } = opts;
  let resolvedDir = null;
  if (typeof dataDir === 'string' && dataDir.trim()) {
    // 走 M6 的解析器登记（显式注入即显式授权）；不 import 它的名字以外的东西。
    resolvedDir = setDataDirInternal(dataDir);
  } else {
    // onebot-link 复用工厂时不重复传 dataDir；已由装配层显式登记则复用同一 key。
    try { resolvedDir = getDataDir(); } catch { /* 保留原有懒构造：未授权时到第一次读写文件才抛错 */ }
  }
  if (!resolvedDir) return new ChatStore(rest);

  const key = chatStoreKey(resolvedDir);
  let store = CHAT_STORE_SINGLETONS.get(key);
  if (!store) {
    store = new ChatStore({ ...rest, dataDir: resolvedDir });
    CHAT_STORE_SINGLETONS.set(key, store);
    return store;
  }

  // 后续宿主注入可补齐动态人格判定，也允许显式更新已有配置；无配置的复用不覆盖既有值。
  if (Object.hasOwn(rest, 'maxPerChat')) store.setMaxPerChat(rest.maxPerChat);
  if (Object.hasOwn(rest, 'hotPerChat')) store.setHotPerChat(rest.hotPerChat);
  if (typeof rest.isPersonaTwo === 'function') store.setPersonaTwoDetector(rest.isPersonaTwo);
  return store;
}
