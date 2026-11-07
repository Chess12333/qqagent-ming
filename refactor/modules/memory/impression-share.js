/**
 * M6 memory · 跨会话共享的授权记录表（`memory/impression-share.jsonl`）
 *
 * 为什么需要这一份（2026-10-11 指挥决定，方案 a）：
 *   读取接口 `retrieveCrossChatImpressions`（`index.js:374`）要求 `scope=global`、`type=impression`、
 *   并且带共享标记；实测全树没有任何生产代码会把标记设为 `true`（`memory_append` 的作用域由当前会话
 *   推导，只会是 `private` 或 `group`，这是刻意设计，不让模型自行放宽跨会话可见范围）。
 *   因此不先做授权入口就去接读取接口，结果是那个接口永远返回空列表。
 *
 * 为什么单独建表，而不是修改观察记录本身（指挥否决方案 b 的理由）：
 *   用 `supersedes` 重写记录来打标记，每授权一次就多产生一个版本，会把刚整理清楚的更正与遗忘历史重新弄乱。
 *   本表只追加、不改写 observations，由读取侧合并：
 *     · 文件顺序即时间顺序，同一个键以最后写入的那条为准
 *     · `shared:false` 可以撤销数据行上原本自带的 `crossChatShareable:true`（授权可以收回）
 *     · 表中没有该记录时，回落到数据行自带的标记（旧数据行为完全不变）
 *
 * 三条使用边界（按重要程度排列）：
 *   ① 只有管理侧可以写入。本模块不被 `modules/act/**` 的任何工具引用，也不给工具增加参数
 *      —— 让模型自己决定哪条印象可以跨群说，等于真实的信息泄露。
 *   ② 授权前必须先核对记录：不存在、作用域不是 `global`、类型不是 `impression` 都明确拒绝
 *      （`not-shareable-eligible`）。不允许出现"写入了一行记录、回头发现什么都没授权"的结果。
 *   ③ 列表接口不返回来源信息：`listShareableImpressions()` 只输出 `cardId/subjectId/impression/
 *      confidence/at/shared/source`，不含证据编号、不含来源会话（与具体会话无关才是一条印象
 *      可以跨会话共享的前提）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { memoryFile, ensureMemoryDir } from './data-dir.js';
import { claimKeyOf, openStore, activeObservations } from './store.js';

const FILE = 'impression-share.jsonl';
const MEM_DIR = 'memory';

/** 调用方显式给的 dataDir 优先，没给才走 data-dir.js 的全局解析（与 suppressions.js 保持一致）。 */
function fileOf(dataDir) {
  if (typeof dataDir === 'string' && dataDir) return path.join(dataDir, MEM_DIR, FILE);
  return memoryFile(FILE);
}

function ensureDir(dataDir) {
  if (typeof dataDir === 'string' && dataDir) {
    const dir = path.join(dataDir, MEM_DIR);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  return ensureMemoryDir();
}

function storeOf(dataDir) {
  return openStore(typeof dataDir === 'string' && dataDir ? dataDir : undefined);
}

/** 这张卡在提示词侧的唯一标识（与 `index.js` 里 bumpHit 使用的键保持一致）。 */
export function cardIdOf(row) {
  return row.claimKey ?? claimKeyOf(row.subjectId, row.scope, row.claim, row.chatKey);
}

function readRows(dataDir) {
  let text = '';
  try {
    text = fs.readFileSync(fileOf(dataDir), 'utf8');
  } catch {
    return { rows: [], badLines: 0 };
  }
  const rows = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    const s = String(line || '').trim();
    if (!s) continue;
    try {
      const row = JSON.parse(s);
      if (row && typeof row === 'object') rows.push(row);
    } catch {
      badLines += 1;   // 坏行跳过并计数返回：账本里一行坏数据不应导致整次注入失败
    }
  }
  return { rows, badLines };
}

/**
 * 生效的授权表：`claimKey -> {claimKey, subjectId, shared, at, actor, note}`。
 * 以文件写入顺序为准，同一个键取最后一条；不比较 `at`（账本行的 `at` 沿用被授权卡自己的时间，
 * 不代表这两行的先后，见 `setImpressionShare`）。
 */
export function shareLedger({ dataDir } = {}) {
  const { rows, badLines } = readRows(dataDir);
  const table = new Map();
  for (const row of rows) {
    const key = String(row.claimKey ?? '');
    if (!key) continue;
    table.set(key, {
      claimKey: key,
      subjectId: String(row.subjectId ?? ''),
      shared: row.shared === true,
      at: Number(row.at) || 0,
      actor: String(row.actor ?? ''),
      note: String(row.note ?? '')
    });
  }
  return { table, badLines, file: fileOf(dataDir) };
}

/**
 * 这张卡是否允许跨会话共享：账本有记录就以账本为准，没有记录则回落到数据行自带的标记。
 * @param {object} row 观察行
 * @param {Map} table `shareLedger().table`
 * @param {string} [cardId] 调用方已算好的键（省一次重算）
 */
export function resolveShare(row, table, cardId = null) {
  if (!row || typeof row !== 'object') return false;
  const entry = table && typeof table.get === 'function' ? table.get(cardId ?? cardIdOf(row)) : null;
  if (entry) return entry.shared === true;
  return row.crossChatShareable === true;
}

/**
 * 管理员授权 / 回收一张跨会话共享（**只追加**，不物理删除）。
 *
 * @param {object} opts
 *   · `claimKey` 那张卡的键（取 `listShareableImpressions()` 的 `cardId`）
 *   · `shared`   true=允许跨会话；false=回收（能盖掉行上原有的 `crossChatShareable:true`）
 *   · `actor`    谁批的（审计用，默认 `admin`）· `note` 一句理由（≤200 字）
 *   · `dataDir`  显式目录优先
 * @returns {{ok:boolean, shared:boolean, claimKey:string, reason?:string}}
 *   四种失败都返回明确原因，并且不写入账本：
 *     `invalid-arguments` / `store-read-failed` / `card-not-found` / `not-shareable-eligible`
 *     （最后一种附上这张卡实际的 scope/type，让调用方知道为什么不行）
 */
export function setImpressionShare({ claimKey, shared, actor = 'admin', note = '', dataDir = null } = {}) {
  const key = String(claimKey ?? '').trim();
  if (!key || typeof shared !== 'boolean') {
    return { ok: false, shared: false, claimKey: key, reason: 'invalid-arguments' };
  }
  let rows = [];
  try {
    rows = activeObservations(storeOf(dataDir));
  } catch (error) {
    return { ok: false, shared: false, claimKey: key, reason: 'store-read-failed', error: String(error?.message ?? error) };
  }
  const card = rows.find((row) => cardIdOf(row) === key);
  if (!card) return { ok: false, shared: false, claimKey: key, reason: 'card-not-found' };
  if (card.scope !== 'global' || card.type !== 'impression') {
    return {
      ok: false, shared: false, claimKey: key, reason: 'not-shareable-eligible',
      card: { scope: String(card.scope ?? ''), type: String(card.type ?? '') }
    };
  }

  const row = {
    claimKey: key,
    subjectId: String(card.subjectId ?? ''),
    shared,
    at: Number.isFinite(Number(card.at)) && Number(card.at) > 0 ? Number(card.at) : Date.now(),
    actor: String(actor ?? 'admin').slice(0, 64) || 'admin',
    note: String(note ?? '').slice(0, 200)
  };
  try {
    ensureDir(dataDir);
    fs.appendFileSync(fileOf(dataDir), `${JSON.stringify(row)}\n`, 'utf8');
  } catch (error) {
    return { ok: false, shared: false, claimKey: key, reason: 'ledger-write-failed', error: String(error?.message ?? error) };
  }
  return { ok: true, shared, claimKey: key, subjectId: row.subjectId, at: row.at };
}

/**
 * 待授权清单（给管理端点/界面读，不返回证据编号、不返回来源会话）。
 *
 * ★ 2026-10-16（用户：跨群共享授权页翻不到/选不到所有内容）：
 *   改前只有 `limit`（默认 50、上限 200），界面拿 `limit=200` 只能看到前 200 条，
 *   且**不知道后面还有没有** —— "看不到"被当成了"没有"。现在提供真分页：
 *   · `page`     从 1 开始（非法/缺省 ⇒ 1）；
 *   · `pageSize` 每页条数，默认 20、上限 200；**旧 `limit` 仍兼容**（等价于 pageSize）；
 *   · 排序**稳定**（`shared` 降序 → `at` 降序 → `cardId` 升序），并按 `cardId` **去重**
 *     ⇒ 同一条不会在两页重复、也不漏；`total` = 当前筛选下的真实总数（不是本页条数）；
 *   · 每次调用都按权威数据重读（撤回/失效/最新授权状态当次生效）。
 *
 * ★ 2026-10-17（用户：授权页按人看时"永远翻空页"）：新增可选 `subjectId` ——
 *   **先**做资格筛选（global + impression + 有正文）**再**按主体收窄，**然后**才去重/排序/分页，
 *   `total/pages/hasMore/filter` 与同一个（收窄后的）集合一致；未给 `subjectId` 保持原全局口径。
 *   这是**收窄**筛选：不放宽任何跨群资格、不透露证据编号、不返回来源会话。
 * @returns {{items:Array, total:number, page:number, pageSize:number, hasMore:boolean,
 *            pages:number, filter:object, ledger:{granted:number, revoked:number, badLines:number}}}
 */
export function listShareableImpressions({ dataDir = null, limit = null, page = null, pageSize = null, subjectId = null } = {}) {
  const pageNum = Math.max(1, Math.floor(Number(page) || 1));
  // `limit` 是旧字段（等价 pageSize）；两个都给时以 `pageSize` 为准。
  const rawSize = Number(pageSize) > 0 ? Number(pageSize) : (Number(limit) > 0 ? Number(limit) : 20);
  const size = Math.max(1, Math.min(200, Math.floor(rawSize)));
  const wantSubject = subjectId === null || subjectId === undefined ? '' : String(subjectId).trim();
  const filter = {
    scope: 'global', type: 'impression', sort: 'shared,at,cardId', dedupe: 'cardId',
    subjectId: wantSubject || null,
  };
  const ledger = shareLedger({ dataDir });
  let active = [];
  try {
    active = activeObservations(storeOf(dataDir));
  } catch {
    return {
      // ★ 读不到账本时 `total` 给 **null（未知）**，不编 0 —— 0 的意思是"筛选下确实没有"。
      items: [], total: null, page: pageNum, pageSize: size, hasMore: false, pages: null,
      filter, ledger: { granted: 0, revoked: 0, badLines: ledger.badLines }, reason: 'store-read-failed'
    };
  }
  let granted = 0, revoked = 0;
  for (const entry of ledger.table.values()) {
    if (entry.shared) granted += 1; else revoked += 1;
  }
  // ① 资格筛选（同一口径：只有 global + impression + 有正文的行可被授权）
  const eligible = active.filter((row) => row.scope === 'global' && row.type === 'impression'
    && typeof row.claim === 'string' && row.claim.trim()
    // ② 主体收窄（可选；空串/缺失 = 不筛）
    && (!wantSubject || String(row.subjectId ?? '') === wantSubject));
  // ③ 按 cardId 去重（同一张卡只出现一次；保留最新 at 的那行，保证排序键唯一 ⇒ 分页不重不漏）
  const byCard = new Map();
  for (const row of eligible) {
    const cardId = cardIdOf(row);
    const at = Number(row.at) || 0;
    const prev = byCard.get(cardId);
    if (!prev || at > prev.at) byCard.set(cardId, { row, cardId, at });
  }
  const rows = [...byCard.values()];
  const items = rows
    .map(({ row, cardId }) => {
      const entry = ledger.table.get(cardId);
      return {
        cardId,
        subjectId: String(row.subjectId ?? ''),
        impression: String(row.claim).replace(/\s+/g, ' ').trim(),
        confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
        at: Number(row.at) || 0,
        shared: resolveShare(row, ledger.table, cardId),
        // source 让界面说实话：这张是账本批的 / 账本回收的 / 行上本来就带的 / 还没批。
        source: entry ? (entry.shared ? 'ledger-granted' : 'ledger-revoked')
          : (row.crossChatShareable === true ? 'row-flag' : 'unapproved')
      };
    })
    .sort((a, b) => (b.shared === a.shared ? 0 : b.shared ? 1 : -1)
      || (Number(b.at) || 0) - (Number(a.at) || 0)
      || String(a.cardId).localeCompare(String(b.cardId)));
  const total = items.length;
  const pages = Math.ceil(total / size);
  const start = (pageNum - 1) * size;
  const slice = items.slice(start, start + size);
  return {
    items: slice,
    total,
    page: pageNum,
    pageSize: size,
    hasMore: start + slice.length < total,
    pages,
    // 界面用这份 filter 说明"当前筛选下共 total 条"，跨页全选只覆盖这个范围。
    filter,
    ledger: { granted, revoked, badLines: ledger.badLines },
  };
}
