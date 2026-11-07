// 知识库（原梗库）：梗/口头禅/内部笑话/可复用短笔记。
// 文件仍是 memes.json（兼容）；UI/对外称「知识库」。
// 模型可直接 memory_meme_save；约 30 天未被搜/闪/再存触发的条目会清理。
import fs from 'node:fs';
import { writeJsonAtomic } from '../../core/util/index.js';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../../core/config-store/index.js';
import { logMemoryChange } from '../memory/index.js';

const FILE = path.join(DATA_DIR, 'memes.json');
// 2026-09-21：200 → 400。原上限 200 是拍脑袋定的，而库是按需检索（memory_meme_search）
// 用的，不整库进提示词 → 容量不影响 token；反而库太小会"搜不到合适的梗"。
const MAX = 400;
/** 多少天没有任何触发（保存去重 / 搜索命中 / 脑内闪过）就清掉。 */
const STALE_DAYS = 30;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;
/** 剩余不足这么多天时 UI 标黄（提醒可钉住）。 */
const WARN_LEFT_DAYS = 10;
/** 上次读取失败的原因（null = 正常/文件不存在）。防"读坏 → 当空 → 覆盖"，见 read()/assertWritable()。 */
let loadFault = null;

function read() {
  try {
    let t = fs.readFileSync(FILE, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    const j = JSON.parse(t);
    if (!Array.isArray(j?.memes)) throw new Error('memes.json 里没有 memes 数组');
    return j.memes;
  } catch (error) {
    // ★ 2026-10-04（T-CUTOVER-5 复核抓到的数据丢失路径）：**只有"文件不存在"才算空库**。
    //   "文件在但读不动"必须留住故障标记 —— 否则上层把空数组当现状再回写，
    //   用户整库梗就被静默覆盖掉了（`memes.json` 135 KB，无备份）。
    if (error?.code !== 'ENOENT') loadFault = String(error?.message ?? error);
    return [];
  }
}

/**
 * 写之前先确认"现有文件可读"，读不动就拒绝写（fail-closed）。
 * 这是唯一防住「读坏 → 当空 → 覆盖」的闸；只在**文件已损坏**时发火，正常路径零影响。
 */
function assertWritable() {
  let text;
  try {
    text = fs.readFileSync(FILE, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') { loadFault = null; return; }   // 真·空库，允许创建
    loadFault = String(error?.message ?? error);
    throw new Error(`拒绝写 ${path.basename(FILE)}：读不动（${loadFault}）`);
  }
  try {
    const parsed = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
    if (!Array.isArray(parsed?.memes)) throw new Error('memes.json 里没有 memes 数组');
    loadFault = null;
  } catch (error) {
    loadFault = String(error?.message ?? error);
    throw new Error(`拒绝写 ${path.basename(FILE)}：现有文件读不动（${loadFault}）。`
      + ' 不许把"读不到"当成"空库"覆盖用户数据 —— 先修文件或备份，再重试。');
  }
}

function write(memes) {
  assertWritable();
  // ★ N62：统一走 core/util 的原子落盘（写 tmp→rename；失败立刻删 tmp）。indent:1 = 与老写法逐字节一致。
  writeJsonAtomic(FILE, { version: 1, memes: memes.slice(-MAX) }, { indent: 1 });
}

function lastTouchedAt(m) {
  return Number(m.lastUsedAt || m.updatedAt || 0);
}

function isPinned(m) {
  return m.pinned === true || m.pinned === 1;
}

/** 清掉超过 STALE_DAYS 没被触发的条目（钉住的不删）；返回剩余列表。 */
function purgeStale(list) {
  const cutoff = Date.now() - STALE_MS;
  const kept = [];
  let removed = 0;
  for (const m of list) {
    if (isPinned(m)) {
      kept.push(m);
      continue;
    }
    const touched = lastTouchedAt(m);
    if (touched && touched < cutoff) {
      removed += 1;
      continue;
    }
    kept.push(m);
  }
  if (removed) {
    write(kept);
    logMemoryChange({ type: 'knowledge_expire', source: 'auto', removed, text: `${removed}条` });
  }
  return kept;
}

function touchEntry(m) {
  m.lastUsedAt = Date.now();
  m.updatedAt = m.lastUsedAt;
}

function ageMeta(m, now = Date.now()) {
  const last = lastTouchedAt(m);
  if (!last) {
    return { ageDays: 0, daysLeft: STALE_DAYS, aging: false, pinned: isPinned(m) };
  }
  const ageDays = Math.floor((now - last) / (24 * 60 * 60 * 1000));
  const daysLeft = Math.max(0, STALE_DAYS - ageDays);
  const pinned = isPinned(m);
  return {
    ageDays,
    daysLeft,
    aging: !pinned && daysLeft <= WARN_LEFT_DAYS,
    pinned
  };
}

/** 启动/读写时顺手清一次（不阻塞主路径错误）。 */
export function expireStaleKnowledge() {
  try {
    return purgeStale(read());
  } catch {
    return read();
  }
}

/** 钉住/取消钉住：钉住的不会被 30 天清理删掉。 */
export function setMemePinned(text, pinned) {
  const key = String(text || '').trim().toLowerCase();
  if (!key) return { ok: false, error: '内容不能为空' };
  const list = read();
  const m = list.find((x) => String(x.text || '').toLowerCase() === key);
  if (!m) return { ok: false, error: '条目不存在' };
  m.pinned = !!pinned;
  m.updatedAt = Date.now();
  write(list);
  logMemoryChange({
    type: pinned ? 'knowledge_pin' : 'knowledge_unpin',
    source: 'admin',
    text: m.text.slice(0, 40)
  });
  return { ok: true, meme: m };
}

function tokenize(s) {
  const t = String(s || '').toLowerCase();
  const out = new Set();
  // 2 字以上中文片段（贪婪整句）+ 拉丁
  for (const w of t.match(/[一-鿿]{2,}|[a-z0-9_]{3,}/g) || []) out.add(w);
  // 中文无空格：再切 2~4 字滑窗，避免「曹操这人…」整句当一个 token
  const cjk = t.match(/[一-鿿]+/g) || [];
  for (const seg of cjk) {
    for (let n = 2; n <= 4; n += 1) {
      for (let i = 0; i + n <= seg.length; i += 1) out.add(seg.slice(i, i + n));
    }
  }
  return out;
}

/** 中文二字滑动窗：用于「沾点边就闪」的弱联想。 */
function bigrams(s) {
  const t = String(s || '').replace(/[^一-鿿a-z0-9_]/gi, '').toLowerCase();
  const out = new Set();
  for (let i = 0; i < t.length - 1; i += 1) {
    const a = t[i];
    const b = t[i + 1];
    if (/[一-鿿]/.test(a) && /[一-鿿]/.test(b)) out.add(a + b);
    else if (/[a-z0-9_]/.test(a) && /[a-z0-9_]/.test(b)) out.add(a + b);
  }
  return out;
}

/** 保存一条知识库条目（梗/笔记）；重复 key 去重。模型可直接调用。 */
export function saveMeme({ text, tags = [], note = '', kind = 'meme', source = 'manual' }) {
  const body = String(text || '').trim().slice(0, 120);
  if (!body) return { ok: false, error: '内容不能为空' };
  let list = read();
  list = purgeStale(list);
  const key = body.toLowerCase();
  const existing = list.find((m) => String(m.text || '').toLowerCase() === key);
  if (existing) {
    existing.uses = (existing.uses || 0) + 1;
    touchEntry(existing);
    if (tags?.length) existing.tags = [...new Set([...(existing.tags || []), ...tags.map(String).slice(0, 6)])];
    if (note) existing.note = String(note).slice(0, 120);
    write(list);
    return { ok: true, meme: existing, deduped: true };
  }
  const now = Date.now();
  const meme = {
    id: `m${now.toString(36)}`,
    text: body,
    kind: kind === 'note' ? 'note' : 'meme',
    tags: (tags || []).map(String).filter(Boolean).slice(0, 6),
    note: String(note || '').slice(0, 120),
    uses: 1,
    lastUsedAt: now,
    updatedAt: now
  };
  list.push(meme);
  write(list);
  logMemoryChange({ type: 'knowledge_save', source, text: body.slice(0, 40), kind: meme.kind });
  return { ok: true, meme };
}

/**
 * 关键词搜梗（管理页/工具用，可稍严）。
 * @param {number} minScore 默认 2.5：允许弱命中，方便人工翻库。
 */
export function searchMeme(query, { limit = 5, minScore = 2.5 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  let list = read();
  list = purgeStale(list);
  const qt = tokenize(q);
  const qb = bigrams(q);
  const scored = [];
  for (const m of list) {
    const hay = `${m.text} ${(m.tags || []).join(' ')} ${m.note || ''}`.toLowerCase();
    let score = 0;
    if (hay.includes(q)) score += 5;
    for (const t of qt) {
      if (t.length < 2) continue;
      if (hay.includes(t)) score += 2;
    }
    // 二字共现：沾一点边
    const hb = bigrams(hay);
    let co = 0;
    for (const b of qb) if (hb.has(b)) co += 1;
    score += Math.min(3, co * 0.8);
    if (String(m.text || '').toLowerCase().includes(q)) score += 3;
    score += Math.min(1.5, (m.uses || 1) / 8);
    if (score >= minScore) scored.push({ score, m });
  }
  scored.sort((a, b) => b.score - a.score);
  // 命中即续命：避免「搜过但没再存」被 30 天清理误伤
  const hitIds = new Set(scored.slice(0, Math.max(1, limit)).map((x) => x.m.id));
  let dirty = false;
  for (const m of list) {
    if (hitIds.has(m.id)) {
      m.uses = (m.uses || 1) + 1;
      touchEntry(m);
      dirty = true;
    }
  }
  if (dirty) write(list);
  return scored.slice(0, Math.max(1, limit)).map(({ m, score }) => ({
    text: m.text,
    tags: m.tags || [],
    uses: m.uses || 1,
    score: Math.round(score * 10) / 10
  }));
}

/**
 * 「脑内闪过」联想：弱相关也闪，闲聊也能沾边。
 * 输入可以是触发文本 + 附近几句；标签权重大于标题字面。
 */
/**
 * 「噪音标签」：匹配时直接忽略的标签。
 *
 * 为什么需要（2026-09-21 实测）：库里不少条目带着**人名标签**（阿澈/京玉/小鲸鱼…），
 * 而这些名字在群里几乎每条消息都出现 → 带这类标签的长条目对**任何**触发都判成"相关"：
 * 25 个真实触发里，「阿澈给小鲸鱼画了第二形态写真…」霸榜 4 次、「电子榨菜」4 次。
 * 通用词（回复/短句/吐槽/反应图…）同理 —— 它们区分不了语境，只配当弱信号里的弱信号。
 */
function noiseTagSet(extra = null) {
  const set = new Set([
    '回复', '短句', '吐槽', '反应图', '群友', '自嘲', '整活', '语气', '日常', '搞笑',
    '网络', '梗', '热梗', '句式', '调侃', '情绪', '性格', '夸', '夸人', '怼人', '敷衍',
    '社交', '生活', '表情包', '评论区', '玩梗', '互动', '发言', '闲聊'
  ]);
  try {
    const notes = getConfig().memberNotes || {};
    for (const v of Object.values(notes)) if (v) set.add(String(v).toLowerCase());
    const botName = String(getConfig().persona?.botName || '').toLowerCase();
    if (botName) set.add(botName);
  } catch { /* 配置读不到不影响匹配 */ }
  for (const t of (Array.isArray(extra) ? extra : [])) set.add(String(t).toLowerCase());
  return set;
}

export function cueMemories(triggerText, { limit = 3, minScore = 1.6, noiseTags = null } = {}) {
  const qRaw = String(triggerText || '').toLowerCase();
  const q = qRaw.replace(/[，,。.！!？?、\s：:；;~～…\[\]【】"'"`]+/g, '');
  if (!q) return [];
  let list = read();
  list = purgeStale(list);
  if (!list.length) return [];

  // 词：2~6 字片段（比以前宽一点，能抓到「新三国」「大胖鲸」）
  const qt = [...tokenize(qRaw)].filter((t) => t.length >= 2 && t.length <= 6);
  const qb = bigrams(qRaw);
  const noise = noiseTagSet(noiseTags);
  // 触发句的 3/4 字窗（一次建好，全库复用）——用来判"这个梗的正文到底有没有沾上"
  const q3 = new Set(); const q4 = new Set();
  for (let i = 0; i + 3 <= q.length; i += 1) q3.add(q.slice(i, i + 3));
  for (let i = 0; i + 4 <= q.length; i += 1) q4.add(q.slice(i, i + 4));
  const scored = [];

  for (const m of list) {
    const title = String(m.text || '').toLowerCase().replace(/[，,。.！!？?、\s：:；;~～…]+/g, '');
    const tags = (m.tags || []).map(String);
    const tagsJoined = tags.join(' ').toLowerCase();
    const note = String(m.note || '').toLowerCase();
    let score = 0;

    // ── ① 正文证据：唯一的强通道 ──
    // ⚠️ 2026-09-21 重构。老评分里标签被计了两次（+3.2 一次、token 循环 +2.4 再一次），
    //    再叠滑窗 +2.2、二字共现 +2.8、使用次数 +1.2 —— 一条三标签的条目**正文一个字都不出现**
    //    也能拿 17 分。实测后果：25 个真实触发里「阿澈给小鲸鱼画了第二形态写真…」「电子榨菜」
    //    这类条目霸榜（分数 8~13），真正的梗被挤掉；Jev 复核一看不搭就否 →「4% 触发率 + 0% 使用率」。
    //    现在：正文没有任何 3 字以上重合 → 直接不参与（宁可少闪，不要乱闪）。
    let evidence = 0;
    let wholeTitle = false;
    let hit4 = 0;
    if (title.length >= 3 && q.includes(title)) { evidence = Math.max(evidence, title.length + 4); wholeTitle = true; }   // 整条梗原样出现
    else {
      let hit3 = 0;
      for (let i = 0; i + 4 <= title.length; i += 1) if (q4.has(title.slice(i, i + 4))) hit4 += 1;
      for (let i = 0; i + 3 <= title.length; i += 1) if (q3.has(title.slice(i, i + 3))) hit3 += 1;
      if (hit4) evidence = 4 + Math.min(6, hit4);
      else if (hit3 >= 2) evidence = 3 + Math.min(2, hit3 - 2);
      else if (hit3 === 1 && title.length <= 10) evidence = 3;   // 短梗允许一个 3 字窗（如「蚌埠住了」）
    }
    if (!evidence) continue;

    // ── ⓪ 分层闸（2026-09-22）──
    // 全库 345 条按"能不能随口用"分过层（test/meme-layers.json → memes.json 的 layer 字段）：
    //   1 = 随口可用·口头禅（233 条）   2 = 特定作品引用（110 条）   3 = 事件/事实记录（2 条）
    const layer = Number(m.layer) || 0;
    // 事件/事实记录不是"能说出口的梗"，永远不闪（本来就该走记忆通道）。
    if (layer === 3) continue;
    // 作品引用：必须"真的提到"才闪 —— 整条原样出现，或 4 字窗命中。
    // 实测这类被 3 字窗误撞出来的最难看：「危机合约高层」对着"什么奇奇怪怪的bug"、
    // 「DeepSeek 深度求索」对着随便一句提到 DeepSeek 的闲聊 —— 云端教师对这类全判 NO。
    if (layer === 2 && !wholeTitle && !hit4) continue;

    score += 5 + evidence;
    // 口头禅层在同等证据下优先（它就是为"随口接一句"准备的）
    if (layer === 1) score += 0.8;
    // 长条目（多半是"事实/事件"记录而非梗）在有同等证据时降权
    if (title.length > 24) score *= 0.7;

    // ── ② 标签：弱加成，且跳过人名/通用标签 ──
    let tagHits = 0;
    for (const t of tags) {
      const tl = String(t).toLowerCase();
      if (!tl || tl.length < 2 || noise.has(tl)) continue;
      if (q.includes(tl)) tagHits += 1;
    }
    score += Math.min(3, tagHits * 1.5);

    // ── ③ 备注：只在已有正文证据时加成 ──
    if (note) {
      let h = 0;
      for (const t of qt.slice(0, 10)) if (t.length >= 3 && note.includes(t)) h += 1;
      score += Math.min(1.5, h * 0.5);
    }

    // ── ④ 二字共现 / 使用次数：只当极小扰动 ──
    const hb = bigrams(`${title} ${tagsJoined} ${note}`);
    let co = 0;
    for (const b of qb) if (hb.has(b)) co += 1;
    score += Math.min(1, co * 0.2);
    score += Math.min(0.6, (m.uses || 1) / 20);

    if (score >= minScore) scored.push({ score, m });
  }

  // 若全无强命中：**不再随机硬塞**一条「最近活的」——会闪到无关梗，模型更不敢用
  // （以前 soft 抽样是为了提高触达，实测反而让【脑内闪过】变成噪音）

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, Math.max(1, limit));
  let dirty = false;
  for (const { m } of top) {
    touchEntry(m);
    dirty = true;
  }
  if (dirty) write(list);
  return top.map(({ m, score, soft }) => ({
    id: m.id,
    text: m.text,
    note: String(m.note || '').slice(0, 100),
    tags: m.tags || [],
    score: Math.round(score * 10) / 10,
    soft: !!soft
  }));
}

export function listMemeTips({ max = 8 } = {}) {
  const list = read().slice().sort((a, b) => (b.uses || 0) - (a.uses || 0));
  return list.slice(0, max).map((m) => m.text);
}

/**
 * 记账：这条梗真的被说进群里了（模型发出的文本里出现了它）。
 *
 * 为什么必须单独记（2026-09-22）：`uses` 只统计"保存去重"和"搜索命中"，闪梗只 touch lastUsedAt，
 * 于是"给了到底用没用"**根本量不出来** —— 线上留档只能看到「193 轮闪梗」，看不到采用率。
 * 有了 adopted + session.memeCued/memeAdopted，改完三天就能量出效果，不用再猜。
 */
export function markMemeAdopted(text) {
  const key = String(text || '').trim().toLowerCase();
  if (!key) return false;
  const list = read();
  const m = list.find((x) => String(x.text || '').toLowerCase() === key);
  if (!m) return false;
  m.adopted = (m.adopted || 0) + 1;
  m.adoptedAt = Date.now();
  touchEntry(m);
  write(list);
  try { logMemoryChange({ type: 'knowledge_adopt', source: 'auto', text: String(m.text).slice(0, 40) }); } catch { /* 审计失败不影响 */ }
  return true;
}

/** 库的采用概览（诊断用）：闪了多少条、被用掉多少条。 */
export function memeAdoptStats() {
  const list = read();
  const adopted = list.filter((m) => (m.adopted || 0) > 0);
  const byLayer = new Map();
  for (const m of list) {
    const k = Number(m.layer) || 0;
    const cur = byLayer.get(k) || { total: 0, adopted: 0 };
    cur.total += 1;
    if ((m.adopted || 0) > 0) cur.adopted += 1;
    byLayer.set(k, cur);
  }
  return {
    total: list.length,
    adoptedEntries: adopted.length,
    adoptedTimes: list.reduce((a, m) => a + (m.adopted || 0), 0),
    byLayer: Object.fromEntries([...byLayer.entries()].map(([k, v]) => [k || '未分层', v]))
  };
}

/**
 * 放宽版召回（2026-09-22）：多通道捞候选，专门交给 Jev 去否。
 *
 * ── 为什么要放宽（实测）──
 * 老 cueMemories 只有一条硬门槛：**梗正文与触发句要有 3 字以上重合**。
 * 结果 9/19–9/22 四天：856 个会话里只有 22.4% 闪过梗，而且**模型一次都没真用出去**
 * （192 轮注入 → 0 条落进发言）。库里 345 条，305 条从没被任何一轮捞到过。
 * 根因是"只有字面撞上才闪"：梗的正文不长在群友嘴里，而是长在**语境**里。
 *
 * ── 与 cueMemories 的分工 ──
 *   cueMemories：要求字面证据，谁也别乱闪（老路径，保留）。
 *   cueMemesWide：多通道召回 + 标明来源，**宁可多给几条交给 Jev 去否**。
 * 通道（按可信度）：
 *   literal  梗正文与场景重合（老证据，最可信）
 *   tag      场景里出现了这条梗的非噪音标签（如场景在聊游戏 → 打「游戏」标签的梗）
 *   note     场景与**备注**重合 —— 备注写的就是"这条梗什么时候用"（如"不想打字时甩表情包"），
 *            是最接近语义的一条通道，也是这次放宽的主要来源
 *   hot      常用梗轮换：故意不看场景，纯探索（老版本 09-21 删掉了随机硬塞，
 *            当时没有 Jev 兜底；现在有了场景门，探索通道才敢开）
 *
 * 注意：命中即 touch（续命），跟 cueMemories 一致 —— 否则放宽捞到的梗会被 30 天清理误杀。
 */
export function cueMemesWide(sceneText, {
  limit = 8,
  noiseTags = null,
  recentIds = null,
  maxPerChannel = { literal: 3, tag: 3, note: 3, hot: 1 },
  hotMinUses = 2,
  maxTagDf = 0
} = {}) {
  const qRaw = String(sceneText || '').toLowerCase();
  const q = qRaw.replace(/[，,。.！!？?、\s：:；;~～…\[\]【】"'"`]+/g, '');
  if (!q) return [];
  let list = read();
  list = purgeStale(list);
  if (!list.length) return [];
  const noise = noiseTagSet(noiseTags);
  const recent = recentIds instanceof Set ? recentIds : new Set();
  const q3 = new Set(); const q4 = new Set();
  for (let i = 0; i + 3 <= q.length; i += 1) q3.add(q.slice(i, i + 3));
  for (let i = 0; i + 4 <= q.length; i += 1) q4.add(q.slice(i, i + 4));
  const clean = (s) => String(s || '').toLowerCase().replace(/[，,。.！!？?、\s：:；;~～…]+/g, '');
  const win3 = (s) => { const out = new Set(); for (let i = 0; i + 3 <= s.length; i += 1) out.add(s.slice(i, i + 3)); return out; };

  const picks = new Map();
  const put = (m, channel, score, extra = {}) => {
    const cur = picks.get(m.id) || { m, chans: [], score: 0, ...extra };
    if (!cur.chans.includes(channel)) cur.chans.push(channel);
    cur.score = Math.max(cur.score, score);
    Object.assign(cur, extra);
    picks.set(m.id, cur);
  };

  // 标签的**文档频率**：出现在太多条上的标签区分不了语境。
  // 2026-09-22 实测：放宽后 tag 通道一口气贡献 85 条候选，其中大量是"话题沾边但没法用"的
  // （场景提到 DeepSeek → 闪「DeepSeek 深度求索」；提到方舟 → 闪「危机合约高层」）。
  // 根因是 新三国(83条)/折棒(83)/自嘲(45)/吐槽(44)/游戏(38)/回复(39) 这种大标签一碰就中。
  // 与其手写黑名单，不如按数据砍：默认只认"全库 ≤2% 条目才带的标签"（345 条 → ≤7 条）。
  const tagDf = new Map();
  for (const m of list) {
    for (const t of new Set((m.tags || []).map((x) => String(x).toLowerCase()))) {
      if (t) tagDf.set(t, (tagDf.get(t) || 0) + 1);
    }
  }
  const dfMax = Math.max(1, Number(maxTagDf) || Math.ceil(list.length * 0.02));

  for (const m of list) {
    const title = clean(m.text);
    // ① literal：老口径原样搬过来
    let ev = 0;
    if (title.length >= 3 && q.includes(title)) ev = title.length + 4;
    else {
      let hit4 = 0, hit3 = 0;
      for (let i = 0; i + 4 <= title.length; i += 1) if (q4.has(title.slice(i, i + 4))) hit4 += 1;
      for (let i = 0; i + 3 <= title.length; i += 1) if (q3.has(title.slice(i, i + 3))) hit3 += 1;
      if (hit4) ev = 4 + Math.min(6, hit4);
      else if (hit3 >= 2) ev = 3 + Math.min(2, hit3 - 2);
      else if (hit3 === 1 && title.length <= 10) ev = 3;
    }
    // 梗文案就是场景原话 → 闪了也没用（模型只会复读），连 Jev 都不用问
    const echo = title.length >= 2 && q.includes(title);
    if (ev && !(echo && title.length < 12)) put(m, 'literal', 10 + ev);
    // ② tag：场景命中**有辨识度**的标签（大标签不算，见上面的 tagDf）
    let tagHits = 0;
    for (const t of (m.tags || [])) {
      const tl = String(t).toLowerCase();
      if (!tl || tl.length < 2 || noise.has(tl)) continue;
      if ((tagDf.get(tl) || 0) > dfMax) continue;
      if (qRaw.includes(tl)) tagHits += 1;
    }
    if (tagHits) put(m, 'tag', 5 + Math.min(3, tagHits * 1.5));
    // ③ note：备注是"这条梗什么时候用"的说明，当弱语义通道
    const note = clean(m.note);
    if (note.length >= 6) {
      let hit = 0;
      for (const w of win3(note)) if (q.includes(w)) hit += 1;
      if (hit >= 2) put(m, 'note', 4 + Math.min(3, hit * 0.5));
    }
  }
  // ④ hot：常用梗轮换（不看场景，纯探索）
  const hot = list
    .filter((m) => (m.uses || 1) >= hotMinUses && !recent.has(m.id))
    .sort((a, b) => (b.uses || 0) - (a.uses || 0) || String(a.id).localeCompare(String(b.id)));
  for (const m of hot.slice(0, Math.max(0, Number(maxPerChannel.hot) || 0))) put(m, 'hot', 2);

  // 每条只按"最强通道"归组，再按通道限量，避免一个通道刷满整个候选池
  const ORDER = ['literal', 'tag', 'note', 'hot'];
  const mainOf = (p) => ORDER.find((c) => p.chans.includes(c)) || 'note';
  const grouped = new Map(ORDER.map((c) => [c, []]));
  for (const p of picks.values()) {
    const main = mainOf(p);
    p.main = main;
    grouped.get(main).push(p);
  }
  const out = [];
  for (const c of ORDER) {
    const cap = Math.max(0, Number(maxPerChannel[c]) || 0);
    grouped.get(c).sort((a, b) => b.score - a.score);
    out.push(...grouped.get(c).slice(0, cap));
  }
  out.sort((a, b) => b.score - a.score);
  const top = out.slice(0, Math.max(1, limit));
  let dirty = false;
  for (const { m } of top) { touchEntry(m); dirty = true; }
  if (dirty) write(list);
  return top.map(({ m, score, main, chans }) => ({
    id: m.id,
    text: m.text,
    note: String(m.note || '').slice(0, 100),
    tags: m.tags || [],
    uses: m.uses || 1,
    score: Math.round(score * 10) / 10,
    channel: main,
    channels: chans
  }));
}

export function memeCount() {
  return read().length;
}

/** 从 tags 推主分类（知识库 UI 用）。 */
function categoryOf(entry) {
  const tags = (entry.tags || []).map((t) => String(t).toLowerCase());
  // 高频/成套 IP 优先
  const priority = ['新三国', '折棒', '明日方舟', 'switch', 'deepseek', '大胖鲸', '评论区梗', '反应图', '台词梗', '人物梗'];
  for (const p of priority) {
    if (tags.some((t) => t.includes(p.toLowerCase()))) return p;
  }
  if (entry.kind === 'note') return '笔记';
  // 取第一个有辨识度的 tag
  const t = (entry.tags || [])[0];
  if (t && !/^(回复|短句|吐槽|理论梗|世界观|历史梗|时间线|自嘲)$/.test(String(t))) return String(t);
  return t ? String(t) : '其他';
}

/** 知识库分类统计 + 条目（含原梗）。 */
export function listKnowledge({ q = '', category = '', limit = 200 } = {}) {
  const list = read();
  const query = String(q || '').trim().toLowerCase();
  let out = list.map((m) => ({
    ...m,
    kind: m.kind || 'meme',
    category: categoryOf(m)
  }));
  if (query) {
    out = out.filter((m) => `${m.text} ${(m.tags || []).join(' ')} ${m.note || ''}`.toLowerCase().includes(query));
  }
  if (category && category !== '全部') {
    out = out.filter((m) => m.category === category);
  }
  // 排序：钉住的优先 → 用过次数多的优先 → 本地化文字兜底。
  // ⚠️ 2026-09-21 改：以前按 updatedAt 排，而「被用过一次」就会刷新 updatedAt ——
  // 于是机器人在群里每用一次梗，那条就被顶到最前，知识库页面的分类卡片和条目跟着整体重排。
  // 管理员反馈的「知识库 UI 有时候会乱飘」有一半来自这里。改成次数+文字后顺序基本不动。
  out.sort((a, b) => (isPinned(b) ? 1 : 0) - (isPinned(a) ? 1 : 0)
    || (b.uses || 0) - (a.uses || 0)
    || String(a.text || '').localeCompare(String(b.text || ''), 'zh'));
  const cats = new Map();
  for (const m of list.map((x) => ({ ...x, category: categoryOf(x) }))) {
    cats.set(m.category, (cats.get(m.category) || 0) + 1);
  }
  const categories = [...cats.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  const now = Date.now();
  return {
    items: out.slice(0, Math.max(1, limit)).map((m) => {
      const meta = ageMeta(m, now);
      return {
        text: m.text,
        kind: m.kind,
        category: m.category,
        tags: m.tags || [],
        note: m.note || '',
        uses: m.uses || 1,
        updatedAt: m.updatedAt || 0,
        lastUsedAt: lastTouchedAt(m) || 0,
        pinned: meta.pinned,
        aging: meta.aging,
        ageDays: meta.ageDays,
        daysLeft: meta.daysLeft
      };
    }),
    categories: [{ name: '全部', count: list.length }, ...categories],
    total: list.length,
    staleDays: STALE_DAYS
  };
}

/** 管理页列表：可选关键词过滤。 */
export function listAllMemes({ q = '', limit = 100 } = {}) {
  const list = read();
  const query = String(q || '').trim().toLowerCase();
  const out = query
    ? list.filter((m) => `${m.text} ${(m.tags || []).join(' ')} ${m.note || ''}`.toLowerCase().includes(query))
    : list;
  return out
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, Math.max(1, limit))
    .map((m) => ({
      text: m.text,
      kind: m.kind || 'meme',
      tags: m.tags || [],
      note: m.note || '',
      uses: m.uses || 1,
      updatedAt: m.updatedAt || 0
    }));
}

export function removeMeme(text) {
  const key = String(text || '').trim().toLowerCase();
  if (!key) return false;
  const list = read();
  const next = list.filter((m) => String(m.text || '').toLowerCase() !== key);
  if (next.length === list.length) return false;
  write(next);
  return true;
}
