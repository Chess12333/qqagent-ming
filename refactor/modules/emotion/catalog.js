/**
 * M7 emotion · 情绪目录（**照老树 `src/bot-state.js:37-74` 逐字搬**）
 *
 * ★ 为什么单独一个文件：老树把「有哪些情绪 / 各叫什么 / 属哪个方向 / 半衰多久」集中在一张
 *   表里（`EMOTIONS` + `EMO_KEYS` + `EMO_PLAIN`），而提示词渲染（`botStatePromptLine`）、
 *   后台目录页（`listEmotionCatalog`）、意图判定（`computeIntent`）**三处都读它**。
 *   新树原先把这件事散在 `hint.js` 的 if 链里 ⇒ 只有 6 类、且没有 label/方向/半衰，
 *   注入给模型的文本格式与老树完全不同（用户 2026-10-09 令：「干脆就严格按照老树的格式注入」）。
 *
 * ★ 三根轴，逐字照老树：
 *   · `cat`  = **方向**，不是正负：out 向外（会外显）/ in 向内（闷在心里）/ neu 中性（机动）。
 *     同一方向里既有正也有负（向外既有愤怒也有得意），所以 `sign` 单独一根轴。
 *   · `halfLifeMin` = 该情绪自己的半衰（尖峰 3~10，底色 15~25）。
 *   · `EMO_PLAIN[k]` = **人话解释**：光写「得意/羞耻」模型只知道有这回事，不知道该怎么反应。
 *
 * ★ 与 `AFFECT`（可写字段）的关系：`AFFECT` 是**状态里真实存在的键**（state.js），
 *   `EMO_KEYS` 是**老树的完整情绪词汇表**（本文件）。两者刻意分开：
 *   `EMO_KEYS` 里有几个键老树自己注明「Jev 不判且无稳定入口，已删」（见下方注释），
 *   目录照样列出来给 UI/渲染看，但状态里不会凭空多出它们。
 */

/**
 * 离散情绪（0~100 强度）+ 半衰期（分钟）。逐字自 `src/bot-state.js:37-52`。
 *
 * ⚠️ 老树原注（保留，因为它解释了为什么是这 14 个而不是更多）：
 *   「情绪池：只保留仍写得进来的维度。Jev 只判 7 种社交向；刷屏/冷落/工具失败走环境规则。
 *     嫉妒/厌恶/内疚/恐惧/惊讶/亢奋/期待 等 —— Jev 不判且无稳定入口，已删。」
 */
export const EMOTIONS = Object.freeze({
  anger: Object.freeze({ halfLifeMin: 6, label: '愤怒', cat: 'out', sign: 'neg' }),
  irk: Object.freeze({ halfLifeMin: 5, label: '烦躁', cat: 'out', sign: 'neg' }),
  joy: Object.freeze({ halfLifeMin: 18, label: '喜悦', cat: 'out', sign: 'pos' }),
  cheer: Object.freeze({ halfLifeMin: 15, label: '开心', cat: 'out', sign: 'pos' }),
  pride: Object.freeze({ halfLifeMin: 20, label: '自豪', cat: 'out', sign: 'pos' }),
  smug: Object.freeze({ halfLifeMin: 18, label: '得意', cat: 'out', sign: 'pos' }),
  gratitude: Object.freeze({ halfLifeMin: 18, label: '感激', cat: 'out', sign: 'pos' }),
  anxiety: Object.freeze({ halfLifeMin: 12, label: '焦虑', cat: 'in', sign: 'neg' }),
  sadness: Object.freeze({ halfLifeMin: 22, label: '悲伤', cat: 'in', sign: 'neg' }),
  shame: Object.freeze({ halfLifeMin: 15, label: '羞耻', cat: 'in', sign: 'neg' }),
  loneliness: Object.freeze({ halfLifeMin: 25, label: '孤独', cat: 'in', sign: 'neg' }),
  down: Object.freeze({ halfLifeMin: 20, label: '低落', cat: 'in', sign: 'neg' }),
  boredom: Object.freeze({ halfLifeMin: 15, label: '无聊', cat: 'in', sign: 'neg' }),
  curiosity: Object.freeze({ halfLifeMin: 12, label: '好奇', cat: 'neu', sign: 'neu' })
});

/** 目录顺序 = 老树 `EMO_KEYS`（`Object.keys(EMOTIONS)`）的逐位顺序，别重排。 */
export const EMO_KEYS = Object.freeze(Object.keys(EMOTIONS));

/**
 * 情绪 → 人话解释，注入提示词时带上。逐字自 `src/bot-state.js:59-74`。
 * 老树原注：「光写『得意/羞耻』这种情绪名，模型只知道有这回事，不知道该怎么反应。」
 */
export const EMO_PLAIN = Object.freeze({
  joy: '心里挺高兴',
  cheer: '心情不错',
  pride: '有点得意',
  smug: '得瑟起来了',
  gratitude: '被人谢了',
  curiosity: '想接着聊',
  anger: '上头了',
  irk: '有点烦',
  anxiety: '心里没底',
  sadness: '不太好受',
  shame: '有点虚',
  down: '有点蔫',
  loneliness: '空落落的',
  boredom: '提不起劲'
});

/** 正向情绪集合（老树 `POS_EMO`，逐字）。用于「正压负 / 负压正」的对立结算与软顶分档。 */
export const POS_EMO = Object.freeze(new Set(['joy', 'cheer', 'pride', 'gratitude', 'smug']));
/** 负向情绪集合（老树 `NEG_EMO`，逐字）。 */
export const NEG_EMO = Object.freeze(new Set(['anger', 'irk', 'anxiety', 'sadness', 'down', 'loneliness', 'shame', 'boredom']));
/** 外向的负性：愤怒/烦躁堆起来会想怼人。内向负性再高也只是不好受（老树 `HOT_NEG`）。 */
export const HOT_NEG = Object.freeze(new Set(['anger', 'irk']));

export const CAT_LABEL = Object.freeze({ out: '向外', in: '向内', neu: '中性' });
export const SIGN_LABEL = Object.freeze({ pos: '正性', neg: '负性', neu: '中性' });

/** 目录里某一维的元信息；未知键返回 null（**不抛** —— 目录是给人看的，不是门禁）。 */
export function metaOf(key) {
  return Object.prototype.hasOwnProperty.call(EMOTIONS, key) ? EMOTIONS[key] : null;
}

/** 人话解释；目录外返回空串。 */
export function plainOf(key) {
  return EMO_PLAIN[String(key || '')] || '';
}

/**
 * 强度达标的前 N 项（老树 `topEmotionEntries`，逐字语义）。
 * 老树默认 `min=20, max=2` —— 低于 min 的不算"有情绪"，宁可不提。
 */
export function topEmotionEntries(emotions, min = 20, max = 2) {
  const emo = emotions || {};
  return EMO_KEYS
    .map((k) => ({ k, v: Number(emo[k]) || 0, label: EMOTIONS[k].label }))
    .filter((x) => x.v >= min)
    .sort((a, b) => b.v - a.v)
    .slice(0, max);
}

/** 只要标签（老树 `topEmotionPhrases`，逐字）。 */
export function topEmotionPhrases(emotions, max = 2) {
  return topEmotionEntries(emotions, 22, max).map((x) => x.label);
}

/**
 * 离散情绪目录（后台整页用）：含全部维度、半衰期、当前强度。
 * 逐字照老树 `src/bot-state.js:1252-1277` 的排序（先按方向 in→out→neu，方向内按强度降序）。
 */
export function listEmotionCatalog(emotions) {
  const emo = emotions || {};
  const clamp = (n) => Math.min(100, Math.max(0, Math.round(Number(n) || 0)));
  return EMO_KEYS.map((k) => {
    const meta = EMOTIONS[k];
    const v = clamp(emo[k]);
    return {
      key: k,
      label: meta.label,
      cat: meta.cat,
      catLabel: CAT_LABEL[meta.cat] || meta.cat,
      // 同一方向里也有正负（向外既有愤怒也有得意），UI 要按这个上色
      sign: meta.sign || 'neu',
      signLabel: SIGN_LABEL[meta.sign] || meta.sign || '中性',
      halfLifeMin: meta.halfLifeMin,
      value: v,
      active: v >= 8
    };
  }).sort((a, b) => {
    const order = { in: 0, out: 1, neu: 2 };
    if (order[a.cat] !== order[b.cat]) return order[a.cat] - order[b.cat];
    return b.value - a.value;
  });
}
