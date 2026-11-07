// 表情包体系（移植自原版 sticker-lib.js）：本地表情知识库 + 搜索 + 提示词摘要。
// QQ 收藏表情（SnowLuma fetch_custom_face_detail）是"源"，本地库是 AI 认知层。
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { writeJsonAtomic } from '../../core/util/index.js';
import path from 'node:path';
import { DATA_DIR } from '../../core/config-store/index.js';

const STICKER_FILE = path.join(DATA_DIR, 'stickers.json');
/** file → 上次读取失败的原因。防"读坏 → 当空 → 覆盖"，见 loadStickerStore/saveStickerStore。 */
const loadFaults = new Map();

/**
 * ★ 2026-10-04（T-CUTOVER-5 复核抓到的数据丢失路径）：写之前先确认"现有文件可读"，
 * 读不动就拒绝写（fail-closed）。只在**文件已损坏**时发火，正常路径零影响。
 */
function assertStickerWritable(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') { loadFaults.delete(file); return; }   // 真·空库，允许创建
    loadFaults.set(file, String(error?.message ?? error));
    throw new Error(`拒绝写 ${path.basename(file)}：读不动（${error?.message ?? error}）`);
  }
  try {
    JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
    loadFaults.delete(file);
  } catch (error) {
    loadFaults.set(file, String(error?.message ?? error));
    throw new Error(`拒绝写 ${path.basename(file)}：现有文件读不动（${error?.message ?? error}）。`
      + ' 不许把"读不到"当成"空库"覆盖用户数据 —— 先修文件或备份，再重试。');
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeStickerEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const id = String(entry.id || entry.emoji_id || entry.resId || '').trim();
  if (!id) return null;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 20)
    : [];
  return {
    id,
    resId: String(entry.resId || entry.emoji_id || id).trim(),
    url: String(entry.url || '').trim(),
    md5: String(entry.md5 || '').trim().toUpperCase(),
    desc: String(entry.desc ?? '').trim(),
    localNote: String(entry.localNote ?? '').trim(),
    noteSource: entry.noteSource === 'manual' || entry.noteSource === 'ai' ? entry.noteSource : '',
    tags,
    usage: String(entry.usage ?? '').trim(),
    source: entry.source === 'manual' ? 'manual' : (entry.source === 'ai' ? 'ai' : 'qq'),
    useCount: Math.max(0, Number(entry.useCount) || 0),
    lastUsedAt: Number(entry.lastUsedAt) || 0,
    lastContext: String(entry.lastContext ?? '').slice(0, 200),
    // 失效条目保留在库中，供刷新恢复；提示清单排除它们。
    broken: entry.broken === true || entry.broken === 'true',
    brokenAt: Number(entry.brokenAt) || 0,
    brokenReason: String(entry.brokenReason ?? '').slice(0, 80),
    createdAt: String(entry.createdAt || nowIso()),
    updatedAt: String(entry.updatedAt || nowIso())
  };
}

export function loadStickerStore(file = STICKER_FILE) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('stickers.json 顶层不是数组');
    loadFaults.delete(file);
    return parsed.map(normalizeStickerEntry).filter(Boolean);
  } catch (error) {
    // 只有"文件不存在"才算空库；读不动要留痕（否则会被当成空库覆盖）
    if (error?.code !== 'ENOENT') loadFaults.set(file, String(error?.message ?? error));
    return [];
  }
}

export function saveStickerStore(entries, file = STICKER_FILE) {
  assertStickerWritable(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // ★ N62：统一走 core/util 的原子落盘（rename 失败会立刻删 tmp；老复盘 55 个 28MB 孤儿 tmp 的修法）。
  //   indent:2 = 与老写法逐字节一致（别让用户真数据文件变形）。
  writeJsonAtomic(file, entries, { indent: 2 });
}

export function mergeStickerLibrary(existing, fetched) {
  const out = existing.map(normalizeStickerEntry).filter(Boolean);
  const byId = new Map(out.map((e) => [e.id, e]));
  const fetchedIds = new Set();
  for (const item of Array.isArray(fetched) ? fetched : []) {
    const id = String(item?.emoji_id || item?.resId || item?.id || '').trim();
    if (id) fetchedIds.add(id);
  }
  for (const item of Array.isArray(fetched) ? fetched : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.emoji_id || item.resId || item.id || '').trim();
    if (!id) continue;
    const old = byId.get(id);
    const merged = normalizeStickerEntry({
      ...(old || {}),
      id,
      resId: String(item.resId || item.emoji_id || id).trim(),
      url: String(item.url || old?.url || '').trim(),
      md5: String(item.md5 || old?.md5 || '').trim().toUpperCase(),
      desc: String(item.desc ?? old?.desc ?? '').trim(),
      localNote: old?.localNote || '',
      noteSource: old?.noteSource || '',
      tags: old?.tags || [],
      usage: old?.usage || '',
      source: old?.source || 'qq',
      useCount: old?.useCount || 0,
      lastUsedAt: old?.lastUsedAt || 0,
      lastContext: old?.lastContext || '',
      // 同步时保留失效标记：markBroken 现在是**标记**而不是删除，硬写 false 会让
      // 下一轮同步又把已确认过期的收藏当活的推给模型（刷新到新地址时由 markAlive 清除）。
      broken: old?.broken === true,
      brokenAt: Number(old?.brokenAt) || 0,
      brokenReason: String(old?.brokenReason || ''),
      createdAt: old?.createdAt || nowIso(),
      updatedAt: nowIso()
    });
    if (!merged) continue;
    if (!byId.has(id)) {
      out.push(merged);
      byId.set(id, merged);
    } else {
      const idx = out.findIndex((e) => e.id === id);
      if (idx >= 0) out[idx] = merged;
    }
  }
  return out.filter((e) => e.source !== 'qq' || fetchedIds.has(e.id));
}

export function findSticker(entries, ref, { fuzzy = true } = {}) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const list = (Array.isArray(entries) ? entries : []).filter(Boolean);
  const md5 = raw.toUpperCase();
  const urlNormalized = raw.replace(/\/+$/, '').replace(/^https?:\/\//i, '');
  const exact = list.find((e) => {
    if (e.id === raw || e.resId === raw) return true;
    if (e.md5 && e.md5 === md5) return true;
    const eUrl = String(e.url || '').replace(/\/+$/, '').replace(/^https?:\/\//i, '');
    if (eUrl && urlNormalized && (eUrl === urlNormalized || eUrl.includes(urlNormalized) || urlNormalized.includes(eUrl))) return true;
    return false;
  });
  if (exact) return exact;
  // 模型常常拿着【可用表情包】里的备注文字（desc/localNote）当 stickerId 来发。
  // 命中规则：去掉引号/括号/空白后，与备注文字完全一致且**唯一**匹配时才反查，
  // 避免模糊 include 误选，也避免歧义时瞎发。
  if (fuzzy) {
    const norm = (s) => String(s ?? '')
      .replace(/[\s"'“”‘’（）()【】\[\],，。.!！?？/\\:：]+/g, '')
      .toLowerCase();
    const q = norm(raw);
    if (q.length >= 3) {
      const hits = list.filter((e) => {
        if (!e) return false;
        if (q === norm(e.localNote)) return true;
        if (q === norm(e.desc)) return true;
        if (q === norm(e.usage)) return true;
        return false;
      });
      if (hits.length === 1) return hits[0];
    }
  }
  return null;
}

export function formatStickerList(entries, query = '', limit = 48, { includeBroken = false } = {}) {
  const all = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const list = includeBroken ? all : all.filter((e) => !e.broken);
  const brokenCount = all.filter((e) => e.broken).length;
  const q = String(query ?? '').trim().toLowerCase();
  const filtered = q
    ? list.filter((e) => {
        const haystack = [e.desc, e.localNote, e.usage, e.id, e.resId, e.md5, ...(e.tags || [])].join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : list;
  const max = Math.max(1, Math.min(500, Number(limit) || 48));
  const items = filtered.slice(0, max).map((e) => ({
    id: e.id,
    desc: e.desc || '',
    localNote: e.localNote || '',
    tags: e.tags || [],
    useCount: e.useCount || 0,
    ...(e.broken ? { broken: true } : {})
  }));
  return {
    total: all.length,
    matched: filtered.length,
    truncated: filtered.length > max,
    brokenSkipped: brokenCount,
    stickers: items
  };
}

/**
 * 提示词里的【可用表情包】摘要（不暴露完整 URL，控制上下文体积）。
 *
 * ⚠️ 每条必须带上 stickerId。
 * 曾经这里只给备注文字、并让模型"想发时先 list_stickers 查 id"——结果模型
 * 每次发表情前都要多花一轮去查，而查询词（"已老实""装死""嫌弃"…）几乎全是
 * 这里已经列出的那几张。实测 list_stickers 占全部调用的 14%（约 ¥0.98/天），
 * 其中一半以上是纯粹为了拿 id。id 本身很便宜（常用表情都是 collected_xxx，
 * 10 条约 200 字符），直接写出来即可。
 *
 * ⚠️⚠️ 列表要"常用 + 轮换"两段，不能只按使用次数取前 N。
 * 实测（125 张的库、847 次发送）：提示词里那 10 张吃掉了 76% 的发送量，
 * 库里有 90 张从来没发过 —— 因为"按次数排序"会自我强化：露脸的越用越多、
 * 没露脸的永远排不上来。现在留一半名额按时间轮换（优先没怎么用过的），
 * 每过 rotatePeriodMs 换一批，整个库才会被真正用起来。
 */
export function buildStickerContext(entries, max = 12, { now = Date.now(), rotatePeriodMs = 3600000, cooldownMs = 0, keepFamiliar = null } = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  if (!list.length) return '';
  const total = Math.max(2, Math.min(30, Number(max) || 12));
  // 失效图不进提示词；只留有文字可判断的（没备注的模型只能瞎猜）
  const live = list.filter((e) => !e.broken);
  const brokenN = list.length - live.length;
  if (!live.length) return brokenN ? '【表情库】暂无可用表情（多张图源已失效）；可用 list_stickers 换词搜，或让群友重发图后再收藏。' : '';
  const usable = live.filter((e) => e.desc || e.localNote || (e.tags || []).length);
  const noNote = live.length - usable.length;
  // ⚠️ 2026-09-22：以前这里在"一张有备注的都没有"时回落到整库（`usable.length ? usable : list`），
  //   于是提示词里出现 12 行一模一样的「无备注 ×0 id=collected_…」——
  //   模型自己都说了"分不清哪个是哪个"，只能瞎挑，挑中过期的图源就发不出去。
  //   现在：**没备注的表情不进提示词**（模型认不出内容＝不可用），并明确告诉它/用户去哪里补。
  const basePool = usable;
  if (!basePool.length) {
    return `【表情库】${live.length} 张都没有可用描述（模型认不出内容，暂不列入清单）。`
      + ' 请到「设置 → 聊天与节奏 → 给没备注的表情补描述」跑一次（或用 get_sticker_image 看一眼 + sticker_note 记一句）。';
  }

  // ⓪ 冷却：刚发过的先排除（默认关，配 sticker.cooldownMin 开启）。
  //    实测号A：132 张只用了 64 张，前 4 张吃掉 65% 的发送量，第一名用了 219 次，
  //    而"常用区"又把它们钉在提示词里 → 越用越靠前。冷却窗口一开，重复率立刻下来。
  const coolMs = Math.max(0, Number(cooldownMs) || 0);
  const cooled = coolMs > 0
    ? basePool.filter((e) => !(e.lastUsedAt && now - Number(e.lastUsedAt) < coolMs))
    : basePool;
  // 冷却后剩下的太少就退回全库（不然没得挑）
  const pool0 = cooled.length >= Math.min(6, Math.max(3, Math.ceil(total / 2))) ? cooled : basePool;

  // ① 常用区：按使用次数（稳定，保证"顺手的那几张"一直在）。
  //    keepFamiliar 可以让管理员把这块调小甚至调 0（0 = 纯轮换，整库都会被轮到）。
  const byUse = [...pool0].sort((a, b) => (b.useCount || 0) - (a.useCount || 0)
    || String(a.id).localeCompare(String(b.id)));
  const stableCount = keepFamiliar === null || keepFamiliar === undefined
    ? Math.max(1, Math.min(byUse.length, Math.round(total / 2)))
    : Math.max(0, Math.min(byUse.length, Math.round(Number(keepFamiliar) || 0)));
  const stable = byUse.slice(0, stableCount);
  const stableIds = new Set(stable.map((e) => e.id));

  // ② 轮换区：其余的按"没怎么用过 / 最久没用"排队，再用时间桶把窗口往前推，
  //    这样即使模型不碰它们，露脸的批次也会自己变，整库才能被看一遍。
  const pool = pool0
    .filter((e) => !stableIds.has(e.id))
    .sort((a, b) => (a.useCount || 0) - (b.useCount || 0)
      || (a.lastUsedAt || 0) - (b.lastUsedAt || 0)
      || String(a.id).localeCompare(String(b.id)));
  const rotateCount = Math.max(0, Math.min(total - stable.length, pool.length));
  const periodMs = Math.max(60000, Number(rotatePeriodMs) || 3600000);
  const bucket = Math.floor(now / periodMs);
  const start = pool.length ? ((bucket * Math.max(1, rotateCount)) % pool.length) : 0;
  const rotating = [];
  for (let i = 0; i < rotateCount; i++) rotating.push(pool[(start + i) % pool.length]);

  const line = (e) => {
    // 本地备注是人工/重新标注后可纠错的版本，应覆盖 QQ 原始 desc；
    // 否则模型明明修正了动作，提示词仍会继续用旧水印/错描述。
    const raw = String(e.localNote || e.desc || '无备注');
    // ⚠️ 2026-09-21：这行以前把「备注 + [全部标签] + 次数 + id」全渲染出来，
    //    6 张表情就要 539 字（每个字都在缓存断点之后按原价算）。
    //    标签是**检索**用的（list_stickers / sticker_note 才有意义），挑表情看备注就够；
    //    备注超过 26 字也截断。这样 6 张 ≈ 330 字，功能不减。
    const label = raw.length > 26 ? `${raw.slice(0, 26)}…` : raw;
    const used = e.useCount ? `×${e.useCount}` : '';
    return `${label}${used} id=${e.id}`;
  };
  const body = [...stable.map(line), ...rotating.map(line)].join('\n');
  const extraNote = [
    noNote ? ` 另${noNote}张没备注（认不出内容，已不列入；补一句描述就能用）。` : '',
    brokenN ? ` 已自动跳过 ${brokenN} 张图源失效表情。` : ''
  ].filter(Boolean).join(' ');
  return `【表情库${live.length}】id 可 send_sticker：\n${body}\n${extraNote}需特定情绪用 list_stickers。`.trim();
}

/**
 * 时间桶表情清单，保留给原调用方；DS 的历史块换批现由 sticker-prompt.js 负责。
 *
 * 与 `buildStickerContext` 的差异（原函数、list 工具、实际选图/发送算法、
 * 真实使用次数存储一律不动）：
 *   · 排序只用**稳定键**（id 升序；缺 id 用排序后的位置兜底 `order-<i>`）——不按 useCount 排序；
 *   · 行内**不渲染使用次数**（去掉 `×N`）——次数仍由 `bumpStickerUse` 真实累计；
 *   · 轮换区按**时间桶**播种（`rotatePeriodMs`，默认 1 小时）：桶内字节稳定、跨桶才换一批
 *     （这是唯一的时间依赖，保留原"整库能被轮换看到"的意图）；
 *   · 冷却默认不参与（DS 前缀要稳；`cooldownMs` 传了才排）；
 *   · 库/配置真变 ⇒ 输出随之变（每次现算、不缓存）。
 *   · stableCandidates 兼容选项按桶号/id 独立排序，库计数置于行列表之后。
 * 没备注/失效图/无可用描述的处理与 `buildStickerContext` 同口径（同样的说明文案）。
 */
export function buildStableStickerContext(entries, max = 12, {
  now = Date.now(), rotatePeriodMs = 3600000, cooldownMs = 0, stableCandidates = false
} = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  if (!list.length) return '';
  const total = Math.max(2, Math.min(30, Number(max) || 12));
  const live = list.filter((e) => !e.broken);
  const brokenN = list.length - live.length;
  if (!live.length) return brokenN ? '【表情库】暂无可用表情（多张图源已失效）；可用 list_stickers 换词搜，或让群友重发图后再收藏。' : '';
  const usable = live.filter((e) => e.desc || e.localNote || (e.tags || []).length);
  const noNote = live.length - usable.length;
  if (!usable.length) {
    return `【表情库】${live.length} 张都没有可用描述（模型认不出内容，暂不列入清单）。`
      + ' 请到「设置 → 聊天与节奏 → 给没备注的表情补描述」跑一次（或用 get_sticker_image 看一眼 + sticker_note 记一句）。';
  }
  const coolMs = Math.max(0, Number(cooldownMs) || 0);
  const cooled = coolMs > 0
    ? usable.filter((e) => !(e.lastUsedAt && now - Number(e.lastUsedAt) < coolMs))
    : usable;
  const pool = cooled.length >= Math.min(6, Math.max(3, Math.ceil(total / 2))) ? cooled : usable;
  // 稳定排序：id 升序，用**码点比较**（`localeCompare` 受 ICU/区域设置影响 —— 同一份库在不同环境
  // 可能排出不同顺序，缓存字节就不稳了）。缺 id 的条目**直接不列**：清单里的 id 必须是真的能发给
  // `send_sticker` 的 id，绝不编一个假 id（`normalizeStickerEntry` 已保证 id 非空，这里是防御）。
  const ordered = pool
    .filter((e) => String(e.id ?? '').trim() !== '')
    .sort((a, b) => {
      const sa = String(a.id); const sb = String(b.id);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
  if (!ordered.length) return '';
  const periodMs = Math.max(60000, Number(rotatePeriodMs) || 3600000);
  const bucket = Math.floor(now / periodMs);
  const pickCount = Math.max(1, Math.min(total, ordered.length));
  let picked;
  if (stableCandidates) {
    // 每张图的桶内次序只由桶号和真实 id 决定，不受库总数、使用次数或源数组顺序影响。
    // 增删未选中的图不会重洗清单；删掉已选图或新图排入前列时只补相应名额。
    const ranked = ordered.map((entry) => ({ entry,
      score: createHash('sha256').update(`${bucket}\0${entry.id}`).digest('hex')
    })).sort((a, b) => a.score < b.score ? -1 : a.score > b.score ? 1
      : a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0);
    picked = ranked.slice(0, pickCount).map(({ entry }) => entry)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  } else {
    const start = ((bucket * pickCount) % ordered.length + ordered.length) % ordered.length;
    picked = [];
    for (let i = 0; i < pickCount; i += 1) picked.push(ordered[(start + i) % ordered.length]);
  }
  const line = (e) => {
    const raw = String(e.localNote || e.desc || '无备注');
    const label = raw.length > 26 ? `${raw.slice(0, 26)}…` : raw;
    return `${label} id=${String(e.id)}`;
  };
  const body = picked.map((e) => line(e)).join('\n');
  const extraNote = [
    noNote ? ` 另${noNote}张没备注（认不出内容，已不列入；补一句描述就能用）。` : '',
    brokenN ? ` 已自动跳过 ${brokenN} 张图源失效表情。` : ''
  ].filter(Boolean).join(' ');
  const heading = stableCandidates ? '【表情库】' : `【表情库${live.length}】`;
  const inventory = stableCandidates ? `库内可用 ${live.length} 张。` : '';
  return `${heading}id 可 send_sticker：\n${body}\n${inventory}${extraNote}需特定情绪用 list_stickers。`.trim();
}

/** 发送前的表情包策略提示（软策略）。 */
export function buildStickerStrategyHint() {
  return [
    '【表情包策略：像真人一样用，不刷屏】',
    '- 合适时机：被戳中笑点/槽点、接梗、怼人、赞同、自嘲、安慰、无语、赢了/输了、告别/晚安、别人发了表情时回一张，都可以自然用。',
    '- 频率：普通闲聊不用每条都配；大约每 3~5 轮来一张就够，热闹/玩梗时可以更密，但不要连续刷屏。',
    '- id 从哪来：优先用【可用表情包】每行末尾的 id=（那是现成的 stickerId）；列表里没有的表情才用 list_stickers 查。send_sticker / get_sticker_image / sticker_note 填的 stickerId 必须是一长串字符（形如 collected_123 或 1927…_0_0）；不要拿备注文字当 id，也不要手打 QQ 面板上那种小数字。没有备注/不确定的表情，先 list_stickers → get_sticker_image 看图，再决定发不发。',
    '- 发送：用 send_sticker；一条消息只能是一张表情，不能在同一气泡里附带文字。想说的话和表情可以**在同一次调用里**一起发（同时调 send_message 和 send_sticker，会按顺序成为两条气泡），不用等下一轮。',
    '- 不要：在严肃/正式/敏感话题硬塞表情；不要每次都用同一个；不要一条消息里塞多个表情；不要把文字和表情混在同一个气泡里。',
    '- 别只会用熟悉的那几张：【可用表情包】下面那段是轮换出来的，每次不一样，挑描述贴切的用；想找特定情绪（装死/嫌弃/笑/困/无语…）就 list_stickers 搜关键词，全库都能用。看到没备注的表情，先用 get_sticker_image 看一眼、再用 sticker_note 记一句，以后它就能直接用了。',
    '- 看别人发的表情时分清三者：发言人是群友、画中角色是图像内容、你是你自己。画中角色不会因为外形相似就变成你；表情通常表达发言人的情绪或玩梗，按这个意思接话。备注只用于理解表情的内容和用法。'
  ].join('\n');
}

export function applyStickerNote(entries, id, patch = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    localNote: patch.note !== undefined ? String(patch.note ?? '').trim() : target.localNote,
    noteSource: patch.noteSource || target.noteSource || '',
    tags: Array.isArray(patch.tags) ? patch.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : target.tags,
    usage: patch.usage !== undefined ? String(patch.usage ?? '').trim() : target.usage,
    source: patch.source || target.source || 'ai',
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}

export function markStickerUsed(entries, id, context = '') {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    useCount: (target.useCount || 0) + 1,
    lastUsedAt: Date.now(),
    lastContext: String(context || '').slice(0, 200),
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}
