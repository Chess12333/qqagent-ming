/**
 * 接梗提示（meme cue）的**判据半**：老树 `src/orchestrator.js:2762-2860` 那一套的前置部分。
 * 零 import、纯函数（clock 由调用方注入）—— 与 `auto-vision.js` 同一套路。
 *
 * 为什么单独一个文件：`api.memeAutoCue` / `api.memeCueMinScore` /
 * `api.memeCuePlayfulOnly` 三个键在**老树里是真读的**（`src/orchestrator.js:2763` /
 * `:2770` / `:2784-2785`），新树 `refactor/modules/**` 里 **0 个读点**（我全树 grep 过，
 * 连 `looksMemeCue` / `looksPlayfulOccasion` 这两个词表在新树也整个不存在，
 * 它们原来住在 `src/bot-state.js:922/958`）。⇒ 这里是补齐"判据 + 键语义"这一半；
 * 检索（memory 的 `cueMemories`）、冷却/注入（orchestrator + prompt）归 bunny1 / sp1，
 * JEV 复核（`jevGate('memeGate')`）**用户已冻结 ⇒ 本文件刻意不碰**。
 *
 * 三键语义（照老树）：
 *   · `memeAutoCue !== false`            —— 总闸（默认开）
 *   · `memeCuePlayfulOnly === false`      —— 关掉"只在玩闹场合闪"的前置闸（默认开）
 *   · `memeCueMinScore`                   —— 检索最低分，非有限数回退 2.2（老树默认值）
 */

/** 这轮对方的话里有没有「玩梗」信号（老树 `src/bot-state.js:922`，逐字同词表）。 */
export function looksMemeCue(text) {
  return /(梗|玩梗|复读|难绷|绷不住|典|乐|草|666|牛魔|哈+|哈哈|笑死|蚌埠|打脸|整活|抽象|急了|破防|赢麻|乐子|截图|名场面|重开|摆烂)/i.test(String(text || ''));
}

/** 这轮有没有「损友玩闹」信号（老树 `src/bot-state.js:927`，逐字同词表）。 */
export function looksPlayfulCue(text) {
  return /(胖鲸|大胖鲸|菜鸟|太菜|好菜|菜狗|菜鸡|笨|呆|傻|蠢|逆天|离谱|唐氏|摸鱼怪|废物|小废物|拉胯|辣鸡|滚|爬|笑死|哈+|草|呵呵|阴阳|就这|不行啊|谁教你)/i.test(String(text || ''));
}

/**
 * 这一轮是不是"可以玩梗"的场合（老树 `src/bot-state.js:958`）。
 * 返回 `{ok, why}`：why ∈ 'meme' | 'tease' | ''。
 * 空文本一律 `ok:false`（老树同款：`if (!t.trim()) return { ok:false, why:'' }`）。
 */
export function looksPlayfulOccasion(text) {
  const t = String(text || '');
  if (!t.trim()) return { ok: false, why: '' };
  if (looksMemeCue(t)) return { ok: true, why: 'meme' };
  if (looksPlayfulCue(t)) return { ok: true, why: 'tease' };
  return { ok: false, why: '' };
}

/**
 * 一个梗候选"值不值得闪"（老树 `src/orchestrator.js:2788-2803` 的 usable 过滤器）。
 * 判据：非空；正文 ≥12 字直接要；否则不许被触发句原样包含；≥8 字要有标签；
 * 短到 3 字也允许 —— 但必须有标签（语境明确）。
 * @param {{text?:string, tags?:string[]}} cue
 * @param {string} nearText 触发句原文（用于"梗就是原话"判定）
 */
export function isUsableCue(cue, nearText = '') {
  const text = String(cue?.text ?? '').trim();
  if (!text) return false;
  const hasTag = (cue?.tags ?? []).length > 0;
  if (text.length >= 12) return true;
  if (String(nearText || '').includes(text)) return false;
  if (text.length >= 8) return hasTag;
  return hasTag && text.length >= 3;
}

/** 老树的检索最低分（`Number.isFinite(Number(cfg.api.memeCueMinScore)) ? … : 2.2`）。 */
export function memeCueMinScore(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 2.2;
}

/**
 * 闪梗：检索 → 筛值得闪的 → 排掉闪过的 → 取一条 → 生成**注入文字**。
 * 老树整套在 `src/orchestrator.js:2782-2860`；这里只搬"能用 media 口径复现"的部分，
 * `cueMemories`（`media/memes.js:287`，新树已有同款）与 seen/冷却状态由调用方注入。
 * ★ JEV 复核（`jevGate('memeGate')`）**刻意不接** —— 用户已冻结；要恢复就在编排层自己接。
 *
 * @param {object} p
 * @param {Function} p.cueMemories media 的检索入口（`(text,{limit,minScore}) => cues[]`）
 * @param {string} p.nearText 触发批原文
 * @param {number} [p.minScore] 检索最低分（老树缺省 2.2）
 * @param {Map<string,number>|object} [p.seen] 同会话"闪过什么"（key=梗正文, value=时刻）
 * @param {number} [p.now] 当前时刻（注入）
 * @param {number} [p.seenTtlMs] 同一条梗多久内不重闪（老树 20 分钟）
 * @returns {{picked:object|null, pool:Array, inject:string}}
 */
export function pickMemeCue({
  cueMemories, nearText = '', minScore = 2.2, seen = null, now = 0, seenTtlMs = 20 * 60 * 1000, limit = 3
} = {}) {
  const at = Number(now) || 0;
  const cues = typeof cueMemories === 'function' ? (cueMemories(nearText, { limit, minScore }) || []) : [];
  const usable = cues.filter((c) => isUsableCue(c, nearText));
  const seenAt = (text) => {
    if (!seen) return 0;
    const key = String(text || '');
    const ts = typeof seen.get === 'function' ? seen.get(key) : seen[key];
    return Number(ts) || 0;
  };
  const pool = usable.filter((c) => {
    const ts = seenAt(c?.text);
    return !(ts && at && at - ts <= seenTtlMs);
  });
  const pick = pool.filter((c) => !c?.soft).sort((a, b) => (Number(b?.score) || 0) - (Number(a?.score) || 0))[0] || pool[0] || null;
  return { picked: pick, pool, inject: pick ? memeCueInject(pick) : '' };
}

/**
 * 注入文字 —— **逐字照老树 `src/orchestrator.js:2845-2848`**（2026-09-22 那条"只给一条 +
 * 明说能自然带上就用出去"的修也照搬）。用户令：注入格式照老树。
 */
export function memeCueInject(pick) {
  if (!pick?.text) return '';
  const tags = (pick.tags || []).filter(Boolean).slice(0, 5).join('、');
  const note = pick.note ? '；' + pick.note : '';
  return '\n【脑内闪过】这轮有人在接梗/玩闹，手边正好有一条群里的熟梗：'
    + `「${pick.text}」${tags ? `（${tags}${note}）` : ''}。`
    + '能自然带上就用出去（直接说，别解释出处、别说"我想起一个梗"、别把这条说明念出来）；'
    + '确实不合适就正常回话，不用勉强。';
}

/**
 * 闪梗前置决策（**不检索、不调模型、不碰时钟**）：把三个配置键的语义算成
 * 一句可执行的结论 + 原因，供编排层直接照着做。
 *
 * @param {object} p
 * @param {(key:string, fallback?:any)=>any} [p.get] 配置读法（`cfg.get`；不传按缺省值）
 * @param {string} p.nearText 触发批原文
 * @param {number} p.now 当前时刻（注入；老树用 Date.now()）
 * @param {number} [p.lastCueAt] 同会话上次闪梗时刻（0 = 没闪过）
 * @returns {{run:boolean, skip?:'disabled'|'not-playful'|'cooldown', occasion:object, minScore:number, cooldownMs:number, seenTtlMs:number}}
 */
export function memeCueDecision({ get = null, nearText = '', now = 0, lastCueAt = 0 } = {}) {
  const read = (key, fallback) => {
    try { return typeof get === 'function' ? get(key, fallback) : fallback; } catch { return fallback; }
  };
  const base = { occasion: { ok: false, why: '' }, minScore: memeCueMinScore(read('api.memeCueMinScore', 2.2)), cooldownMs: 3 * 60 * 1000, seenTtlMs: 20 * 60 * 1000 };
  if (read('api.memeAutoCue', true) === false) return { ...base, run: false, skip: 'disabled' };
  const occasion = read('api.memeCuePlayfulOnly', true) === false
    ? { ok: true, why: 'gate-off' }        // 配置里关掉场合闸（老树 :2771）
    : looksPlayfulOccasion(nearText);
  if (!occasion.ok) return { ...base, occasion, run: false, skip: 'not-playful' };
  const last = Number(lastCueAt) || 0;
  const at = Number(now) || 0;
  if (at && last && at - last < base.cooldownMs) return { ...base, occasion, run: false, skip: 'cooldown' };
  return { ...base, occasion, run: true };
}
