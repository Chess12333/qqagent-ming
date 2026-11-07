/**
 * 状态条目的年龄口径（2026-10-14 派单 · 形状①「状态话题超期」）。
 *
 * ★ 为什么单开一份：这条判据有**两个消费点** —— 关键词腿（`index.js:retrieve()` 打分前的拦截）
 *   和语义腿（`coordinator.js:recallWithSemantic()` 的二次验证）。写两处一定会漂。
 *
 * ★ 四个配置键怎么进来（M6 的硬边界：本模块不许 import `core/config-store`，理由见
 *   `index.js` 顶部与 `data-dir.js` 的复盘）：**全部由调用方注入** ——
 *   装配层一次性 `memory.configure({ working })`，或每次调用带 `ctx.working`（工具侧 / 自测）。
 *   `working` 接受两种形状：
 *     ① 直接给对象，键名与 `api.architecture.*` 一字不差：
 *        `{ crossTurnWorking, workingTtlMin, workingDecayMin, workingMaxChars }`；
 *     ② 给一个零参函数，返回上面那个对象（★ 推荐：用户改完配置下一轮就生效，不用重启）。
 *   两种都没给 ⇒ 用 `DEFAULT_WORKING`（数值与 `core/config-store/defaults.js` 的那四条一致）。
 *
 * ★ 语义对齐（派单要求"对不上就写明"）：
 *   · `workingTtlMin` → 短期状态类条目（`topic/promise/question/recent`）的**读侧期限**。
 *       超期不删、也不静默丢：本轮话题命中才允许注入，否则进 `dropped`（只带编号与原因，不带正文）。
 *       C 层稳定认识（`impression/trait/preference/fact`）**不吃这个 TTL** —— 那是长期印象，
 *       排序按 7 天半衰期就够；把 90 分钟套上去等于每天把印象清一遍，与账本设计相反。
 *   · `workingDecayMin` → 短期状态类条目的半衰期，是老树"每满一个衰减周期降权"在新树的等价物：
 *       打分里的 recency 分量改用这个周期（只对短期状态类，C 层不动）。
 *   · `workingMaxChars` → ★ **不在本模块落地**：M6 返回的是账本条目，长度收口发生在渲染层。
 *       新树同一件事已有出口 `prompt/budget.js:DEFAULT_BUDGET.maxMemoryClaimChars`（默认 160，与本键同数），
 *       所以由提示词层读这个键（`prompt/index.js`）。这里再裁一刀会裁出两种长度，且改的是账本读数本身。
 *   · `crossTurnWorking` → ★ 老树语义（一整份跨轮工作记忆缓冲）**现已搬入本文件**（2026-10-15 派单）：
 *     生成（`saveCrossTurn`）与消费（`renderCrossTurn`）对齐老树 `src/conversation-memory/cross-turn.js`。
 *     本键仍兼作年龄闸总开关：关掉 = 年龄闸退回旧行为 + 跨轮工作记忆不写不读。
 *
 * ★ 明确不做：不统计"这条递给过模型几次"。那条计数归 mimo1 在身体状态那条路上做，
 *   这里再做一个就会有两套互相不知情的机制（同一个条目两处各自决定给不给）。
 */
import { OBS_TYPES } from './store.js';

const MIN = 60 * 1000;
/** C 层稳定认识的半衰期（老口径，`index.js` 打分原本就用这个数）。 */
export const STABLE_HALF_LIFE_MS = 7 * 24 * 60 * MIN;
/** D 层短期状态：对话状态 / 承诺 / 待答问题 / 刚发生的事。 */
export const SHORT_TERM_TYPES = Object.freeze(
  OBS_TYPES.filter((t) => ['topic', 'promise', 'question', 'recent'].includes(t))
);
/** 没注入时的缺省（与 `core/config-store/defaults.js` 的四条同数，改动要两边一起看）。 */
export const DEFAULT_WORKING = Object.freeze({ enabled: true, ttlMin: 90, decayMin: 30, maxChars: 160 });
/**
 * 话题"命中"的门槛。`topicOverlap` 给的是 0~1：整串命中 = 1，否则按分词命中比例。
 * ★ 取 0.5 而不是 `>0`：分词只留长度 ≥2 的词，两字词碰巧出现在正文里的概率不低，
 *   `>0` 等于"只要沾点边就放行"，那道拦截就白设了；取 1（整串命中）又太严 —— 话题往往是一整句，
 *   条目正文是压缩过的一句话，两边字面很难完全相等。
 */
export const TOPIC_HIT_MIN = 0.5;

let injected = null;   // `memory.configure({ working })` 落这里

const isFn = (v) => typeof v === 'function';

function pickEnabled(raw, fallback) {
  const v = isFn(raw) ? raw() : raw;
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  return fallback;
}

function pickPositiveMin(raw, fallback) {
  const v = Number(isFn(raw) ? raw() : raw);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * 解析本轮用的年龄口径。优先级：每次调用传的 `ctxWorking` > 装配层注入 > 缺省。
 * ⚠ 每条键**单独**看：注入了 ttl 没注入 decay 时，decay 继续用上一层的值，不整层作废。
 */
export function resolveWorking(ctxWorking) {
  const materialize = (x) => (isFn(x) ? x() : x);
  const clean = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : null);
  const fromCtx = clean(materialize(ctxWorking));
  const fromConfig = clean(materialize(injected));
  // ★ 逐键合，不整层换：每次调用带的键盖过装配层注入的，没带的键继续用注入那份。
  const src = { ...(fromConfig || {}), ...(fromCtx || {}) };
  const hasAny = Boolean(fromCtx || fromConfig);
  const base = hasAny ? {} : DEFAULT_WORKING;
  const enabled = pickEnabled(src.crossTurnWorking ?? src.enabled,
    base.enabled ?? DEFAULT_WORKING.enabled);
  const ttlMin = pickPositiveMin(src.workingTtlMin ?? src.ttlMin,
    base.ttlMin ?? DEFAULT_WORKING.ttlMin);
  const decayMin = pickPositiveMin(src.workingDecayMin ?? src.decayMin,
    base.decayMin ?? DEFAULT_WORKING.decayMin);
  const maxChars = pickPositiveMin(src.workingMaxChars ?? src.maxChars,
    base.maxChars ?? DEFAULT_WORKING.maxChars);
  return {
    enabled, ttlMin, decayMin, maxChars,
    source: fromCtx ? 'ctx' : (fromConfig ? 'configure' : 'default')
  };
}

/** 装配层注入（`memory.configure({ working })` 转发到这里）。传 null/undefined = 清掉注入，回到缺省。 */
export function setWorking(input) {
  if (input === null || input === undefined) { injected = null; return resolveWorking(null); }
  if (!isFn(input) && (typeof input !== 'object' || Array.isArray(input))) {
    throw new Error('memory/working: working 只接受配置对象或返回它的零参函数（不猜、不静默忽略）');
  }
  injected = input;
  return resolveWorking(null);
}

export function topicOverlap(claim, topic) {
  if (!topic) return 0;
  const t = String(topic).toLowerCase();
  if (!t) return 0;
  const c = String(claim).toLowerCase();
  if (c.includes(t)) return 1;
  const parts = t.split(/[\s,，。;；/|]+/).filter((x) => x.length >= 2);
  if (!parts.length) return 0;
  let hit = 0;
  for (const p of parts) if (c.includes(p)) hit += 1;
  return hit / parts.length;
}

export function isShortTermType(type) {
  return SHORT_TERM_TYPES.includes(String(type ?? 'impression'));
}

/**
 * 短期状态的年龄判据。**总是**回 `topicScore`（调用方打分要用，别扫两遍正文）。
 * @returns {{blocked:boolean, reason:string, topicScore:number, ageMin:number, topicHit:boolean}}
 */
export function shortTermAgeVerdict({ row, now, working, topic }) {
  const topicScore = topicOverlap(row?.claim, topic);
  const at = Number(row?.at);
  const ageMin = Math.max(0, (Number(now) - (Number.isFinite(at) ? at : Number(now))) / MIN);
  const topicHit = topicScore >= TOPIC_HIT_MIN;
  if (!working?.enabled) return { blocked: false, reason: '', topicScore, ageMin, topicHit };
  if (!isShortTermType(row?.type)) return { blocked: false, reason: '', topicScore, ageMin, topicHit };
  if (ageMin <= working.ttlMin) return { blocked: false, reason: '', topicScore, ageMin, topicHit };
  return topicHit
    ? { blocked: false, reason: 'working:ttl-topic-hit', topicScore, ageMin, topicHit }
    : { blocked: true, reason: 'working:ttl-expired', topicScore, ageMin, topicHit };
}

/** 打分用的半衰期：短期状态按配置的衰减周期，C 层仍按 7 天（开关关掉时两类都回到 7 天）。 */
export function halfLifeFor(type, working) {
  if (working?.enabled && isShortTermType(type)) return Math.max(1, Number(working.decayMin)) * MIN;
  return STABLE_HALF_LIFE_MS;
}

// ═════════════════════════════════════════════════════════════════════════
// 跨轮工作记忆（老树 src/conversation-memory/cross-turn.js 的搬运）
// 只记「这件事进行到哪」，不记模型心里在想什么。三类客观状态：
//   ① pendingAsk  上轮问了对方一句，还没等到回答
//   ② lastQuery   上轮查过什么线索
//   ③ unfinished  开了头没做完的事（有动作、没交代）
// 持久化：`<dataDir>/cross-turn/<safeKey>.json`，形状 `{turns:[...]}`。
// 配置：ttlMin / decayMin / maxChars 从 `working` 取（与年龄闸共用四个键）。
// ═════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';

const CROSS_TURN_MAX_TURNS = 3;

function crossTurnFile(dataDir, chatKey) {
  const safe = String(chatKey || '').replace(/[^a-z0-9_]/gi, '_');
  return path.join(String(dataDir || ''), 'cross-turn', `${safe}.json`);
}

function readCrossTurns(dataDir, chatKey) {
  try {
    const raw = fs.readFileSync(crossTurnFile(dataDir, chatKey), 'utf8');
    const obj = JSON.parse(raw);
    const turns = Array.isArray(obj?.turns) ? obj.turns : (Array.isArray(obj) ? obj : []);
    return turns
      .filter((t) => t && typeof t === 'object')
      // ★ C11 读取端安全过滤：旧持久化的泛化 `unfinished: true`（无 unfinishedNote）不再占名额，
      //   但保留 pendingAsk / lastQuery / 带内容的 unfinished —— 不删文件、只在读侧过滤。
      .map((t) => (t.unfinished && !String(t?.unfinishedNote ?? '').trim()
        ? { ...t, unfinished: false }
        : t));
  } catch { return []; }
}

function writeCrossTurns(dataDir, chatKey, turns) {
  try {
    const file = crossTurnFile(dataDir, chatKey);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ turns }), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

/** 只有「有状态可交代」的轮次才占名额（老树 `isUsefulTurn`）。
 *  ★ 2026-10-16 C11：`unfinished` 必须带 `unfinishedNote`（具体内容）才算有用 ——
 *    纯 `unfinished: true` 是泛化标记，渲染只会输出固定空话"有件事开了头、还没交代"，
 *    三轮连续写三条一模一样。旧持久化的泛化项在读取时也被过滤（见 `readCrossTurns`）。 */
function isUsefulTurn(t) {
  return !!(t?.pendingAsk || t?.lastQuery || (t?.unfinished && String(t?.unfinishedNote ?? '').trim()));
}

/** 粗年龄标签（老树 `ageLabel`，刻意粗）。 */
function crossAgeLabel(ageMin) {
  const m = Number(ageMin);
  if (!Number.isFinite(m) || m < 0) return '';
  if (m < 2) return '刚刚';
  if (m < 10) return `${Math.round(m)}分钟前`;
  if (m < 50) return '半小时左右';
  if (m < 90) return '1小时前';
  if (m < 60 * 20) return `${Math.round(m / 60)}小时前`;
  return '昨天';
}

/** 按空窗淡忘（每满 decayMin 丢最早一轮；老树 `decayTurns`）。 */
function decayTurns(turns, { now, decayMs, maxTurns }) {
  if (!turns.length || !(decayMs > 0)) return turns;
  const gap = now - (Number(turns[0]?.at) || 0);
  if (gap < decayMs) return turns;
  const drop = Math.floor(gap / decayMs);
  if (drop <= 0) return turns;
  return turns.slice(0, Math.max(0, turns.length - drop));
}

/**
 * 保存一轮跨轮工作记忆（老树 `saveAfterRun`）。只存有用的状态轮；空轮不删已有历史。
 *
 * @param {string} chatKey
 * @param {{outcome?:string, sent?:string[], lastQuery?:string, pendingAsk?:boolean, unfinished?:boolean, unfinishedNote?:string}} payload
 * @param {{dataDir:string, working?:object, now?:number}} opts
 * @returns {boolean} 是否写入了
 */
export function saveCrossTurn(chatKey, payload, { dataDir, working = null, now = Date.now() } = {}) {
  if (!working?.enabled) return false;
  const unfinishedNote = String(payload?.unfinishedNote ?? '').trim().slice(0, 60);
  const turn = {
    at: now,
    outcome: String(payload?.outcome ?? ''),
    sent: (Array.isArray(payload?.sent) ? payload.sent : []).map((s) => String(s ?? '').slice(0, 40)).filter(Boolean).slice(0, 1),
    lastQuery: String(payload?.lastQuery ?? '').slice(0, 24),
    pendingAsk: payload?.pendingAsk === true,
    // ★ C11：unfinished 需带 unfinishedNote（具体内容）才生效；纯布尔不再存为泛化标记。
    unfinished: payload?.unfinished === true && Boolean(unfinishedNote),
    ...(unfinishedNote ? { unfinishedNote } : {}),
  };
  if (!isUsefulTurn(turn)) return false;
  const prev = readCrossTurns(dataDir, chatKey);
  const decayMs = Math.max(0, Number(working?.decayMin) || 0) * MIN;
  const kept = decayTurns(prev, { now, decayMs, maxTurns: CROSS_TURN_MAX_TURNS });
  const turns = [turn, ...kept].slice(0, CROSS_TURN_MAX_TURNS);
  return writeCrossTurns(dataDir, chatKey, turns);
}

/**
 * 渲染【跨轮记忆】（老树 `CrossTurnWorking.render`）。只注入三类客观状态，不复读聊天。
 *
 * @param {string} chatKey
 * @param {{dataDir:string, working?:object, botName?:string, now?:number}} opts
 * @returns {string} 空串 = 没有可交代的状态
 */
export function renderCrossTurn(chatKey, { dataDir, working = null, botName = '', now = Date.now() } = {}) {
  if (!working?.enabled) return '';
  const decayMs = Math.max(0, Number(working?.decayMin) || 0) * MIN;
  let turns = readCrossTurns(dataDir, chatKey);
  turns = decayTurns(turns, { now, decayMs, maxTurns: CROSS_TURN_MAX_TURNS });
  // 整体 TTL：最新一轮太老则整段丢弃
  const ttlMs = Math.max(5, Number(working?.ttlMin) || 90) * MIN;
  if (!turns.length || now - (Number(turns[0]?.at) || 0) > ttlMs) return '';
  const maxChars = Math.min(2000, Math.max(40, Number(working?.maxChars) || 280));
  const lines = [];
  for (const [i, t] of turns.slice(0, CROSS_TURN_MAX_TURNS).entries()) {
    const bits = [];
    if (t.pendingAsk) {
      bits.push(`问过「${String(t.sent?.[0] || '').slice(0, 20)}」，还没等到回答`);
    }
    if (t.unfinished) {
      // ★ C11：只有带具体内容（unfinishedNote）的 unfinished 才输出；纯布尔不产生空话。
      const note = String(t.unfinishedNote ?? '').trim();
      if (note) bits.push(`有件事「${note}」还没交代`);
    }
    if (t.lastQuery) bits.push(`查过「${String(t.lastQuery).slice(0, 20)}」`);
    if (!bits.length) continue;
    const tag = i === 0 ? '最近' : i === 1 ? '上次' : '更早';
    const ageMin = Math.max(0, (now - (Number(t.at) || 0)) / MIN);
    lines.push(`${tag}(${crossAgeLabel(ageMin)})：${bits.join('；')}`);
  }
  if (!lines.length) return '';
  const header = '【跨轮记忆】（前几轮做到哪了，别复读、别当成现在的事）';
  const body = lines.map((s) => `- ${s}`).join('\n');
  const room = maxChars - header.length - 1;
  return `${header}\n${body.length > room ? body.slice(0, room - 1) + '…' : body}`;
}
