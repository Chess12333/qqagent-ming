/**
 * M6 memory · 表层近况 surface（老树 `src/memory.js:981 captureSurface` + `src/half-life.js` 的搬运）。
 *
 * 用户说「好累/等外卖/在改插件」这类短时近况 → 正则捕获（零模型）→ 按 (person, chat, kind) 槽位
 * 存储 → 半衰衰减（weight = 0.5^(age/hl)，FLOOR 以下不注入、DEAD 以下真删）→ 注入时带粗年龄。
 *
 * ★ 为什么独立于 M6 证据账本：surface 是**正则捕获的短时状态**，不是"有证据的观察"——
 *   `commit()` 要求 evidenceIds 且走 supersedes 版本链，塞进去会污染账本语义。
 *   `index.js clearSurface` 一并清本 store（见该函数）。
 *
 * ★ 存储：`<dataDir>/memory/surface.json`，单文件 `{ [personId]: { slots: {...}, updatedAt } }`。
 *   槽位键 = `base64url(chatKey)__kind`（老树 `surfaceSlotKey` 同款）⇒ 同人同群同槽覆盖，跨群隔离。
 *
 * ★ 零跨模块依赖（只 import 同目录 data-dir.js + node:），半衰算术内联（老树 src/half-life.js
 *   的 noteEntry/liveEntries/pruneEntries/decayInfo，纯算术，不搬 emotion 的 half-life.js——
 *   那份签名不同且归 M7）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir, memoryDir, ensureMemoryDir } from './data-dir.js';

// ── 半衰常量（老树 src/half-life.js:18-19）────────────────────────────────
const FLOOR = 0.25;   // 低于不再注入（= 2 个半衰期）
const DEAD = 0.06;    // 低于直接删（≈ 4 个半衰期）
const MIN = 60 * 1000;

// ── 槽位类型（老树 src/memory.js:45-51）──────────────────────────────────
const SURFACE_KINDS = {
  body: { hl: 120, cn: '身体' },     // 累/困/疼/病
  mood: { hl: 45, cn: '情绪' },      // 气/乐/破防/无语
  doing: { hl: 90, cn: '在忙' },     // 上班/赶稿/写代码/复习
  wait: { hl: 120, cn: '在等' },     // 等外卖/等审核/等结果
  plan: { hl: 240, cn: '打算' }      // 明天/周末要去做的事
};

/** 抓取规则（老树 src/memory.js:54-60 逐字）：命中即整句记进对应槽位。 */
const SURFACE_RULES = [
  ['body', /(?:好累|累了|太累|累死|累成狗|累瘫|累趴|困死|困得|好困|困了|想睡|去睡|熬夜|没睡好|失眠|头疼|胃疼|肚子疼|感冒|发烧|不舒服|生病|阳了|腰疼)/],
  ['mood', /(?:气死|生气|好气|气到|破防|难受|emo|委屈|烦死|烦人|崩了|寄了|麻了|无语|开心|好爽|笑死|乐死|爽到|蚌埠|绷不住)/],
  ['doing', /(?:在忙|加班|赶稿|赶工|写作业|写代码|改bug|改插件|做视频|剪片|上课|上班|开会|复习|刷题|面试|健身|搬家)/],
  ['wait', /(?:等外卖|等快递|等审核|等通知|等结果|等发货|等回复|排队|挂号|还在等|等了[^。！？]{0,4}(?:小时|分钟|天))|(?:外卖|快递)[^。！？]{0,4}(?:丢|没到|迟|慢)/],
  ['plan', /(?:明天|后天|下周|周末|晚点|待会|一会儿)[^。！？]{0,10}(?:去|要|得|准备|约|做|打|看|见)/]
];

// ── 清洗（老树 src/memory.js:400-409 逐字）────────────────────────────────
function stripSurfaceNoise(raw) {
  return String(raw || '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/\[引用[^\]]{0,80}\]/g, ' ')
    .replace(/\[(?:图片|表情\d*|合并转发[^\]]*|转发消息[^\]]*|拍一拍|语音|视频|文件)\]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@\S{1,24}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── 槽位键（老树 src/memory.js:465-468 逐字）──────────────────────────────
function surfaceSlotKey(chatKey, kind) {
  const encoded = Buffer.from(String(chatKey || ''), 'utf8').toString('base64url') || 'legacy';
  return `${encoded}__${kind}`;
}

// ── 半衰算术（老树 src/half-life.js 的纯函数搬运）────────────────────────
function weightOf(entry, now) {
  const hl = Math.max(1, Number(entry?.hl) || 60);
  const at = Number(entry?.at) || 0;
  if (!at) return 0;
  return Math.pow(0.5, Math.max(0, (now - at) / MIN) / hl);
}

function decayInfo(entry, now) {
  const hl = Math.max(1, Number(entry?.hl) || 60);
  const at = Number(entry?.at) || 0;
  const ageMin = at ? Math.max(0, (now - at) / MIN) : Infinity;
  const weight = at ? Math.pow(0.5, ageMin / hl) : 0;
  return { hl, at, ageMin, weight: Math.round(weight * 1000) / 1000, alive: weight > FLOOR, dead: weight < DEAD };
}

/**
 * 记一条（同 key 覆盖；同文本续期有总寿命上限 capFactor×hl，不重置 shown）。
 * 老树 src/half-life.js:69-97 逐字（去掉 onEvict 回调——本 store 无外部观察者）。
 */
function noteEntry(map, key, text, { halfLifeMin, now, capFactor = 1.5, maxKeys = 100 } = {}) {
  const k = String(key || 'misc');
  const t = String(text || '').trim().slice(0, 60);
  if (!t) return null;
  const hl = Math.max(1, Math.min(1440, Number(halfLifeMin) || 60));
  if (!map || typeof map !== 'object') return null;
  const prev = map[k];
  if (prev && String(prev.text || '') === t) {
    const base = Number(prev.hl) || hl;
    const bornAt = Number(prev.bornAt) || Number(prev.at) || now;
    const cap = bornAt + base * capFactor * MIN;
    prev.at = Math.max(Number(prev.at) || 0, Math.min(now, cap));
    prev.renewed = (Number(prev.renewed) || 0) + 1;
    return prev;
  }
  map[k] = { text: t, at: now, bornAt: now, hl, shown: 0, renewed: 0 };
  const keys = Object.keys(map);
  if (keys.length > Math.max(1, maxKeys)) {
    for (const old of keys
      .map((x) => ({ x, w: weightOf(map[x], now) }))
      .sort((a, b) => a.w - b.w)
      .slice(0, keys.length - Math.max(1, maxKeys))) {
      delete map[old.x];
    }
  }
  return map[k];
}

/** 还活着的条目（weight > FLOOR），按权重降序。老树 src/half-life.js:100-108。 */
function liveEntries(map, now) {
  const out = [];
  for (const [key, entry] of Object.entries(map || {})) {
    const info = decayInfo(entry, now);
    if (!entry?.text || info.weight <= FLOOR) continue;
    out.push({ key, text: String(entry.text), ...info, shown: Number(entry?.shown) || 0, renewed: Number(entry?.renewed) || 0, kind: String(entry?.kind || ''), chatKey: String(entry?.chatKey || '') });
  }
  return out.sort((a, b) => b.weight - a.weight);
}

/** 清掉死条目（weight < DEAD）。老树 src/half-life.js:111-120。 */
function pruneEntries(map, now) {
  let removed = 0;
  for (const [key, entry] of Object.entries(map || {})) {
    const info = decayInfo(entry, now);
    if (info.ageMin === Infinity || info.dead) { delete map[key]; removed += 1; }
  }
  return removed;
}

// ── 存储 ────────────────────────────────────────────────────────────────
function surfaceFile(dataDir = null) {
  return path.join(dataDir ? path.join(dataDir, 'memory') : memoryDir(), 'surface.json');
}

function loadStore(dataDir = null) {
  try {
    const raw = fs.readFileSync(surfaceFile(dataDir), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch { return {}; }
}

function saveStore(store, dataDir = null) {
  try {
    const file = surfaceFile(dataDir);
    if (!dataDir) ensureMemoryDir(); else fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

// ── 公开出口 ────────────────────────────────────────────────────────────

/**
 * 捕获一条近况（老树 `src/app.js:1061-1071` 调 `memory.captureSurface` 的等价物）。
 * 只从**他自己发的话**里抓；2~60 字短句；命中 SURFACE_RULES 才记；同槽覆盖；同文本续期有上限。
 *
 * @param {{dataDir?:string|null, userId:string, name?:string, text:string, now?:number, chatKey:string}} input
 * @returns {boolean} 是否记下了
 */
export function captureSurface({ dataDir = null, userId, name = '', text = '', now = Date.now(), chatKey = '' } = {}) {
  const uid = String(userId || '').trim().replace(/^-/, '');
  if (!/^\d{5,15}$/.test(uid)) return false;
  const clean = stripSurfaceNoise(text);
  if (clean.length < 2 || clean.length > 60) return false;
  let hit = null;
  for (const [kind, re] of SURFACE_RULES) {
    if (re.test(clean)) { hit = kind; break; }
  }
  if (!hit) return false;
  const store = loadStore(dataDir);
  const person = store[uid] || (store[uid] = { slots: {}, updatedAt: 0 });
  if (!person.slots || typeof person.slots !== 'object') person.slots = {};
  const slotKey = chatKey ? surfaceSlotKey(chatKey, hit) : `legacy__${hit}`;
  const text40 = clean.slice(0, 40);
  // ★ 2026-10-15（派单回修）：**同一条消息的重复捕获**是真 no-op —— 同槽 + 同文本 + 同 now 时完全不动
  //   （不 ++renewed、不写盘）。两条捕获路（入站持久化钩子 orchestrator/index.js 与 compose 兜底）
  //   都传同一个证据时间戳（entry.at）⇒ 第二条路不产生任何续期/写盘副作用；隔时间的真重发
  //   （now 不同）仍照旧走 noteEntry 的续期上限。跨群靠 slotKey、跨人靠 uid 隔离，与此判无关。
  const prev = person.slots[slotKey];
  if (prev && String(prev.text || '') === text40 && Number(prev.at) === Number(now)) return true;
  const entry = noteEntry(person.slots, slotKey, text40, {
    halfLifeMin: SURFACE_KINDS[hit].hl,
    now,
    capFactor: 1,       // 同文本最多活 3 个半衰期（≈1.5× 名义寿命）——老树 :1000 同款
    maxKeys: 100
  });
  if (!entry) return false;
  entry.kind = hit;
  entry.chatKey = String(chatKey || '');
  person.name = String(name || person.name || '');
  person.updatedAt = Math.max(Number(person.updatedAt) || 0, now);
  return saveStore(store, dataDir);
}

/**
 * 某人当前还活着的近况（按浓度降序）。
 * @param {{dataDir?:string|null, userId:string, chatKey?:string, now?:number}} input
 *   chatKey 给了就只看该会话的槽位（**禁止跨群泄漏**）。
 * @returns {Array<{kind:string, chatKey:string, text:string, weight:number, ageMin:number, at:number, slot:string, shown:number}>}
 */
export function liveSurface({ dataDir = null, userId, chatKey = '', now = Date.now() } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return [];
  const person = loadStore(dataDir)[uid];
  if (!person?.slots) return [];
  return liveEntries(person.slots, now)
    .filter((e) => !chatKey || String(e.chatKey || '') === String(chatKey))
    .filter((e) => !(e.shown >= 3 && e.weight < 0.5))   // 递过 3 次且淡到一半不再重复（老树 :2236）
    .map((e) => ({
      kind: e.kind || '',
      chatKey: e.chatKey || '',
      text: e.text,
      weight: e.weight,
      ageMin: Math.round(e.ageMin || 0),
      at: e.at,
      slot: e.key,
      shown: e.shown
    }));
}

/**
 * 某会话下所有人的活近况（给 compose 注入用）。
 * @param {{dataDir?:string|null, chatKey:string, now?:number, personIds?:string[]}} input
 *   personIds 限定只取这些人的（evidence 里的发言者）；不给则取全会话。
 * @returns {Map<string, Array>} personId -> liveSurface 数组
 */
export function liveSurfaceByChat({ dataDir = null, chatKey, now = Date.now(), personIds = null } = {}) {
  const key = String(chatKey || '').trim();
  const out = new Map();
  if (!key) return out;
  const store = loadStore(dataDir);
  const filter = personIds && Array.isArray(personIds) && personIds.length ? new Set(personIds.map(String)) : null;
  for (const [uid, person] of Object.entries(store)) {
    if (filter && !filter.has(uid)) continue;
    const entries = liveEntries(person?.slots || {}, now)
      .filter((e) => String(e.chatKey || '') === key)
      .filter((e) => !(e.shown >= 3 && e.weight < 0.5))
      .map((e) => ({
        kind: e.kind || '', chatKey: e.chatKey || '', text: e.text,
        weight: e.weight, ageMin: Math.round(e.ageMin || 0), at: e.at, slot: e.key, shown: e.shown
      }));
    if (entries.length) out.set(uid, entries);
  }
  return out;
}

/**
 * 注入后标记"已递过"（老树 formatForPrompt :2279-2288 的 shown 计数）。
 * @param {{dataDir?:string|null, chatKey:string, personSlots: Record<string,string[]>, now?:number}} input
 *   personSlots = { personId: [slotKey, ...] }
 */
export function markSurfaceShown({ dataDir = null, chatKey, personSlots = {}, now = Date.now() } = {}) {
  const store = loadStore(dataDir);
  let changed = false;
  for (const [uid, slots] of Object.entries(personSlots || {})) {
    const person = store[uid];
    if (!person?.slots) continue;
    for (const slot of (Array.isArray(slots) ? slots : [])) {
      if (person.slots[slot]) {
        person.slots[slot].shown = (Number(person.slots[slot].shown) || 0) + 1;
        changed = true;
      }
    }
  }
  if (changed) { person_touch(store, now); saveStore(store, dataDir); }
  return changed;
}

function person_touch(store, now) {
  for (const p of Object.values(store)) {
    if (p && typeof p === 'object') p.updatedAt = Math.max(Number(p.updatedAt) || 0, now);
  }
}

/**
 * 清掉死条目 + 空壳人（老树 `pruneSurface` :1521-1563 的语义，去掉壳归档——
 * 本 store 不建壳文件，空 person 直接删键）。
 * @param {{dataDir?:string|null, now?:number}} input
 * @returns {{entriesRemoved:number, personsRemoved:number}}
 */
export function pruneSurface({ dataDir = null, now = Date.now() } = {}) {
  const store = loadStore(dataDir);
  let entriesRemoved = 0;
  let personsRemoved = 0;
  for (const [uid, person] of [...Object.entries(store)]) {
    if (!person?.slots || typeof person.slots !== 'object') { delete store[uid]; personsRemoved += 1; continue; }
    const removed = pruneEntries(person.slots, now);
    entriesRemoved += removed;
    if (!Object.keys(person.slots).length) { delete store[uid]; personsRemoved += 1; }
  }
  if (entriesRemoved || personsRemoved) saveStore(store, dataDir);
  return { entriesRemoved, personsRemoved };
}

/** 清掉某人的近况（`index.js clearSurface` 调）。kind/chatKey 可选收窄。 */
export function clearSurfaceFor({ dataDir = null, userId, kind = '', chatKey = null } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return 0;
  const store = loadStore(dataDir);
  const person = store[uid];
  if (!person?.slots) return 0;
  const k = String(kind || '');
  let removed = 0;
  for (const [slot, entry] of Object.entries(person.slots)) {
    const entryKind = String(entry?.kind || slot.match(/__(body|mood|doing|wait|plan)$/)?.[1] || '');
    if ((!k || entryKind === k) && (chatKey == null || String(entry?.chatKey || '') === String(chatKey))) {
      delete person.slots[slot];
      removed += 1;
    }
  }
  if (removed) {
    if (!Object.keys(person.slots).length) delete store[uid];
    saveStore(store, dataDir);
  }
  return removed > 0 ? 1 : 0;
}
