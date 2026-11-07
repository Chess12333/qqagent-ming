// 牌局存档：每个会话最多一局，落 <DATA_DIR>/mini-games.json。
//
// 为什么自己落盘而不是塞进 store/session：
//   · 局面要扛得住"这轮结束了、下一轮再来"——会话对象是每次运行新开的；
//   · 钩子（before-llm-messages，5 秒超时、不许发网络）也要读到它，那条路上没有 session。
// 路径从 ../../refactor/modules/extensions/host-api.js 取 DATA_DIR：与 plugins/life-system 同一做法，
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../refactor/modules/extensions/host-api.js';

const FILE = path.join(DATA_DIR, 'mini-games.json');
const MAX_CHATS = 200;          // 上限保护：最多记这么多会话，超了丢最旧的

let cache = null;               // { mtimeMs, data }
let writeQueue = Promise.resolve();

function emptyDoc() {
  return { version: 1, chats: {} };
}

function load() {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(FILE).mtimeMs; } catch { mtimeMs = 0; }
  if (cache && cache.mtimeMs === mtimeMs) return cache.data;
  let data = emptyDoc();
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && j.chats && typeof j.chats === 'object') data = j;
  } catch { /* 首次运行 / 文件坏了都当空 */ }
  cache = { mtimeMs, data };
  return data;
}

/**
 * 落盘（串行化 + 原子写：tmp + rename）。
 *
 * ⚠️ 2026-09-22 修掉一个真会咬人的缺陷：**序列化必须在调用那一刻完成**。
 * 旧写法把 `JSON.stringify(doc)` 推迟到队列任务里做，而 doc 是**共享的可变对象**：
 * 于是"清掉一局"（clearGame 在原地删了 key 之后排了个 save）会被**更早排入、此刻才执行**
 * 的任务写回去 —— 落盘的还是删除前的快照，牌局就复活了。
 * 实测（test/mini-games-test.mjs 海龟汤用例）：揭晓后 readGame 仍能拿到整局，
 * 连汤底一起回来，于是已经公开的答案会重新武装上泄漏守卫。
 * 现在每个 save 在**调用时就固定自己的内容**，"最后一次改动对应的那次 save"必然最后落盘，
 * FIFO 队列保证最终文件就是最新状态。
 *
 * 同一个修复的另一半：写完**不要把 cache 置空**，而是把缓存指回刚写下去的这份 doc，
 * 并把 mtimeMs 记成刚落的那个文件。置空会让紧接着的一次读回到磁盘上"还没写全"的旧快照，
 * 内存状态被顶回去、后续改动叠加在旧状态上 —— 同样是丢更新（实测：t8 的牌局在揭晓前就没了）。
 * 记成一致的 mtime 之后，只有**外部真的改过文件**（mtime 变了）才会重新读盘，
 * 这正是多实例/外部写入需要的语义。
 */
function save(doc) {
  let payload;
  try {
    // MAX_CHATS 上限在快照前裁掉（原来在任务里裁，同样是"改共享对象"）
    const chats = Object.entries(doc.chats || {});
    if (chats.length > MAX_CHATS) {
      chats.sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0));
      doc.chats = Object.fromEntries(chats.slice(0, MAX_CHATS));
    }
    payload = JSON.stringify(doc, null, 1);
  } catch {
    return writeQueue;          // 序列化都失败就没什么可写的
  }
  writeQueue = writeQueue.then(() => {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      const tmp = `${FILE}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, FILE);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(FILE).mtimeMs; } catch { mtimeMs = 0; }
      cache = { mtimeMs, data: doc };
    } catch { /* 落盘失败不影响本局继续玩 */ }
  }).catch(() => {});
  return writeQueue;
}

/** 读某会话的牌局（没有就返回 null；过期的顺手清掉）。 */
export function readGame(chatKey, { ttlMinutes = 120 } = {}) {
  const key = String(chatKey || '');
  if (!key) return null;
  const doc = load();
  const st = doc.chats?.[key];
  if (!st) return null;
  const ttl = Math.max(5, Number(ttlMinutes) || 120) * 60 * 1000;
  if (Date.now() - (Number(st.at) || 0) > ttl) {
    delete doc.chats[key];
    save(doc);
    return null;
  }
  return st;
}

/** 写/更新某会话的牌局。 */
export function writeGame(chatKey, state) {
  const key = String(chatKey || '');
  if (!key) return;
  const doc = load();
  doc.chats = doc.chats || {};
  doc.chats[key] = { ...state, at: Date.now() };
  save(doc);
}

/** 结束并删除。 */
export function clearGame(chatKey) {
  const key = String(chatKey || '');
  if (!key) return;
  const doc = load();
  if (doc.chats?.[key]) {
    delete doc.chats[key];
    save(doc);
  }
}

/** 诊断/测试用：当前所有牌局。 */
export function allGames() {
  return { ...(load().chats || {}) };
}

/** 测试用：等写队列排空（落盘是异步的，断言文件内容前必须等它）。 */
export function flushWrites() {
  return writeQueue;
}

export const internals = { FILE, load, save, flush: flushWrites };
