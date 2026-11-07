/**
 * M6 memory · 提示词冷/热切点的**会话内粘滞值**（2026-10-14 指挥位催的那份接口，存取实现归记忆域）
 *
 * 为什么住在 memory：这是个要跨轮、跨重启活下来的会话状态 ⇒ 新树的会话状态落盘一律走本模块
 *   （原文存档 `chat-store.js`、待办 `todos.js`），装配层不自己开文件、不自己拼路径。
 * ★ 这里**只存一个数**（热段起始那条的本地序号），不判断"该不该移动切点" ⇒ 判据归装配层 `compose.js`。
 *
 * 落盘位置：`<dataDir>/history-cut/<safeKey>.json`，一个会话一个文件。
 *   ★ 为什么不放进 `messages/` 或 `messages-cold/`：那两个目录按**消息布局**被读
 *   （`chat-store.js:171-176` 用 `<safeKey>.NNNNN.json` 猜冷分片序号、`archive-view.js:52-56` 当存档浏览），
 *   混进去会被当成一条消息或一个坏分片。
 *
 * `dataDir` 解析不出来时**照本模块铁律抛错**（与 `chat-store.js` 同口径：不回落到仓库 `data/`）⇒
 *   调用方按"这一轮没这份状态"处理，绝不许把抛错变成整轮失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from './data-dir.js';
import { writeJsonAtomic } from '../../core/util/index.js';

/** 文件格式版本：以后改形状就 +1，读侧遇到不认识的就当没存过（不猜、不迁移旧形状）。 */
export const HISTORY_CUT_SCHEMA_VERSION = 1;

/** 粘滞值目录：`<dataDir>/history-cut`。解析不出 dataDir 就抛错（见文件头）。 */
export function historyCutDir(dataDir = null) {
  const root = typeof dataDir === 'string' && dataDir.trim() ? path.resolve(dataDir) : getDataDir();
  return path.join(root, 'history-cut');
}

function safeKey(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

/** 单会话文件：`<dataDir>/history-cut/<safeKey>.json`。 */
export function historyCutFile(chatKey, dataDir = null) {
  return path.join(historyCutDir(dataDir), `${safeKey(chatKey)}.json`);
}

/** 只认正整数（本地消息序号从 1 起）；别的形状一律返回 null，宁可当没存过。 */
function validWarmStartId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 读某会话的粘滞切点。**任何情况都不抛**（除 dataDir 解析不出来）。
 *
 * @returns {{warmStartId:number|null, reason:string, file?:string}}
 *   reason ∈ 'ok' | 'absent' | 'unreadable' | 'unparsable' | 'invalid' | 'schema' | 'no-chatkey'
 *   `warmStartId` 非 null 只可能出现在 `reason === 'ok'`；其余一律 null（调用方按未粘住处理）。
 */
export function readHistoryCut(chatKey, { dataDir = null } = {}) {
  const key = String(chatKey ?? '').trim();
  if (!key) return { warmStartId: null, reason: 'no-chatkey' };
  const file = historyCutFile(key, dataDir);
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { warmStartId: null, reason: error?.code === 'ENOENT' ? 'absent' : 'unreadable', file };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { warmStartId: null, reason: 'unparsable', file };
  }
  if (Number(parsed?.schemaVersion) !== HISTORY_CUT_SCHEMA_VERSION) return { warmStartId: null, reason: 'schema', file };
  const id = validWarmStartId(parsed?.warmStartId);
  if (id === null) return { warmStartId: null, reason: 'invalid', file };
  return { warmStartId: id, reason: 'ok', updatedAt: Number(parsed?.updatedAt) || null, file };
}

/**
 * 写某会话的粘滞切点。**值没变就不落盘**（这条状态一个会话几十轮才动一次，没必要每轮重写存档目录）。
 *
 * @param {string} chatKey group:123 / private:456
 * @param {{warmStartId:number}} value 热段起始那条的本地序号（正整数）
 * @returns {{ok:boolean, wrote:boolean, reason:string}} reason ∈ 'ok' | 'unchanged' | 'invalid' | 'no-chatkey' | 'write-failed:…'
 */
export function writeHistoryCut(chatKey, { warmStartId } = {}, { dataDir = null } = {}) {
  const key = String(chatKey ?? '').trim();
  if (!key) return { ok: false, wrote: false, reason: 'no-chatkey' };
  const id = validWarmStartId(warmStartId);
  if (id === null) return { ok: false, wrote: false, reason: 'invalid' };
  const current = readHistoryCut(key, { dataDir });
  if (current.reason === 'ok' && current.warmStartId === id) return { ok: true, wrote: false, reason: 'unchanged' };
  const file = historyCutFile(key, dataDir);
  try {
    writeJsonAtomic(file, {
      schemaVersion: HISTORY_CUT_SCHEMA_VERSION,
      chatKey: key,
      warmStartId: id,
      updatedAt: Date.now()
    });
  } catch (error) {
    return { ok: false, wrote: false, reason: `write-failed:${String(error?.code || error?.message || error)}` };
  }
  return { ok: true, wrote: true, reason: 'ok' };
}
