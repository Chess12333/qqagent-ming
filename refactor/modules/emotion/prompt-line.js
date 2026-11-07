/**
 * M7 emotion · botStatePromptLine（**注入给模型的那一句**，照老树 `src/bot-state.js:1285-1351` 逐字搬）
 *
 * ★★★ 这是用户 2026-10-09 亲口点名的那一处：
 *   「干脆就严格按照老树的格式注入来得了，没有的或者改过的功能，类似的功能按照老树相同的格式注入」
 *   ⇒ 本文件就是「老树格式」的落点。形状逐段对齐：
 *
 *   （此刻）精力还行，心情平稳。情绪：向内偏重：焦虑(心里没底)；向外有点：得意(有点得意)。倾向（内部提示，别照着念）：先确认再接话。有点上火，被惹了可以炸回去。
 *
 *   五段结构与老树**逐段同序**：
 *   ① `（此刻）` + 精力/心情两个 label + 压力说人话
 *   ② `情绪：` 三向聚合（out/in/neu），每向给强度副词 + 至多 2 个 `标签(人话)`
 *   ③ `倾向（内部提示，别照着念）：` + `computeIntent()` 的意图串
 *   ④ 行为约束（气到份上 / 上火 / 绷着 / 脑子转不动 / 别装死）—— **油门与刹车都给**
 *   ⑤ 亢奋模式整段替换（老树 `:1287-1292`：极简亢奋协议下不叠规则，只补一句 + 硬锁）
 *
 * ★ 与 `styleHint()` 的分工（**两者都保留、都导出**，不互相顶替）：
 *   · `botStatePromptLine` = 老树口径的**状态摘要 + 情绪 + 意图 + 行为约束**（本文件）。
 *   · `styleHint` = 按人给的一句关系化倾向（「和 TA 熟，直接说结论就行」）。
 *   老树把两者合成一行注入；新树原本只有 `styleHint`，且它被 `prompt/system-rules.js:248`
 *   单独渲染成 `【此刻说话倾向】` 段。⇒ 本函数是**新增出口**，接线由 `prompt/**` 决定，
 *   在别人域内，本票不碰。
 */
import { isPlainObject, clamp } from './state.js';
import { EMO_KEYS, EMOTIONS, EMO_PLAIN, CAT_LABEL } from './catalog.js';
import { isHypeMode, getHypeProtectedQQ } from './hype-mode.js';

function validPoolValue(pool) {
  const raw = isPlainObject(pool) && Object.prototype.hasOwnProperty.call(pool, 'value')
    ? pool.value : pool;
  if (typeof raw !== 'number' && (typeof raw !== 'string' || !raw.trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? clamp(value, 0, 100) : null;
}

/**
 * ★ 2026-10-16（与 `validPoolValue` 同一契约的另一半）：**"可以是 0 的标量"**读数。
 * 缺值（null/undefined/空串/非有限）⇒ 返回老树的默认档 `fallback`（mood 50 / social 60）；
 * **真实 0 保持 0** —— 绝不把 0 与缺失混同。
 *
 * ⚠ 这里**有意**偏离老树 `Number(v) || 50` 的写法：那写法会把 `mood: 0`（真实"最差"）读成 50（"平稳"），
 *   与当前口径"区分缺失与真实低值"相反。老树那处是历史 quirk，不是要保的语义。
 *
 * ★★ 2026-10-16 复核 `457cb8b` 又发现一处同类边界（本函数最初版）：原先只挡 null/空串就 `Number(value)`，
 *   而 `Number(false)`/`Number([])`/`Number([50])`/`Number(true)` 分别得到 **0/0/50/1** ⇒ `mood: false` 会被
 *   显示成"不太妙"、`social: []` 成"想安静" —— 正是"把无效值当真实低值"。现在**只认有限 number 或
 *   非空数字字符串**（与 `validPoolValue` 同一纪律），其余类型一律"不确认"走 `fallback`。
 *   ⚠ 与 `validPoolValue` 的唯一差别：这里**不**解 `{value: …}` 包装 —— 池的契约有形如 `{value}` 的形态，
 *   `self.mood`/`social` 在状态里是**裸标量**（`state.js:160` 归一），解包装会放宽成不该接受的对象。
 */
function numberOrFallback(value, fallback) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? clamp(value, 0, 100) : fallback;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return fallback;
    const n = Number(text);
    return Number.isFinite(n) ? clamp(n, 0, 100) : fallback;
  }
  return fallback;   // null / undefined / 布尔 / 数组 / 对象 / 函数 / symbol：不确认，不当作 0
}

/**
 * 精力档位的人话（老树 `src/bot-state.js:1221-1228` 的档位，逐字）。
 * ★ 当前口径（2026-10-16）：**缺失/非有限/不可确认 ⇒ '未知'**（不编造数值）；
 *   **真实 0 ⇒ '很累'**（0 是"真实竭尽"，不是缺省）。
 */
export function energyLabel(v) {
  const n = validPoolValue(v);
  if (n === null) return '未知';
  if (n >= 85) return '满血';
  if (n >= 65) return '还行';
  if (n >= 40) return '一般';
  if (n >= 25) return '偏累';
  return '很累';
}

/** 心情档位的人话（老树 `src/bot-state.js:1230-1237` 的档位；缺省仍为 50，**真实 0 归 0**）。 */
export function moodLabel(v) {
  const n = numberOrFallback(v, 50);
  if (n >= 72) return '不错';
  if (n >= 58) return '平稳';
  if (n >= 42) return '一般';
  if (n >= 28) return '有点闷';
  return '不太妙';
}

/** 社交电池档位的人话（老树 `src/bot-state.js:1239-1245` 的档位；新树无 social ⇒ 备用；缺省 60、真实 0 归 0）。 */
export function socialLabel(v) {
  const n = numberOrFallback(v, 60);
  if (n >= 75) return '还想聊';
  if (n >= 50) return '还行';
  if (n >= 30) return '有点乏';
  return '想安静';
}

/**
 * 负向情绪总强度：判断「炸毛到什么程度」用（老树 `sumNegEmotions`，逐字）。
 * @param {object} emo **已按 `EMOTION_ALIASES` 归一**的键名表（老树键名）
 */
function sumNegEmotions(emo) {
  let sum = 0;
  for (const k of ['anger', 'irk', 'anxiety', 'sadness', 'down', 'loneliness', 'shame', 'boredom']) {
    sum += Number(emo?.[k]) || 0;
  }
  return sum;
}

/** 外向的负性：愤怒/烦躁堆起来会想怼人。内向负性再高也只是不好受（老树 `sumHotEmotions`，逐字）。 */
function sumHotEmotions(emo) {
  let sum = 0;
  for (const k of ['anger', 'irk']) sum += Number(emo?.[k]) || 0;
  return sum;
}

/** 达标的前 N 项（老树 `topEmotionEntries`，逐字）。 */
function topEmotionEntries(emo, min = 20, max = 2) {
  return EMO_KEYS
    .map((k) => ({ k, v: Number(emo?.[k]) || 0, label: EMOTIONS[k].label }))
    .filter((x) => x.v >= min)
    .sort((a, b) => b.v - a.v)
    .slice(0, max);
}

/**
 * 元认知意图串（老树 `computeIntent`，`src/bot-state.js:373-408` 逐字搬）。
 *
 * ★ 这就是"老树有、新树缺的那个 `intent` 出口"：它是一句**给提示词用的简短策略标签**，
 *   不直接执行、不返回布尔、不否决任何东西。
 *
 * @param {object} emo 已归一的情绪表（老树键名）
 * @param {object} energy 四池 `{physical, cognitive, emotional, will}`
 * @param {object} [opts] `{acuteStress, will, personaTwo}` —— `personaTwo` 命中时返回空串
 */
export function computeIntent(emo, energy, opts = {}) {
  // 第二人格：情绪档意图串一律不下发（老树 `:374-378`，含冲突说明，逐字保留其裁定）。
  if (opts.personaTwo === true) return '';
  const e = energy || {};
  const physical = validPoolValue(e.physical);
  const cognitive = validPoolValue(e.cognitive);
  const will = validPoolValue(e.will);
  const hot = sumHotEmotions(emo);
  const soft = Math.max(0, sumNegEmotions(emo) - hot);
  // 油门：高兴+得意攒够了就说"闹开"（老树 `:387-391`，含 2026-09-29 阈值重标定说明）。
  const high = (Number(emo.joy) || 0) + (Number(emo.cheer) || 0) + (Number(emo.pride) || 0) + (Number(emo.smug) || 0);
  if (high >= 90 && physical !== null && physical >= 45) return '正来劲，闹开：可以抢话头、可以占便宜、可以把战果说出来';
  if (hot >= 28) return '可以怼回去，别一直忍';
  if (soft >= 45) return '心里堵得慌，不想接就别硬接';
  const top = topEmotionEntries(emo, 22, 4).map((x) => x.k);
  if ((cognitive !== null && cognitive < 30) || (Number(opts.acuteStress) || 0) > 70) return '少绕弯，先回最稳的';
  if (top.includes('anger') || top.includes('irk')) return '别上头，短句回';
  if (top.includes('anxiety') || top.includes('shame')) return '先确认再接话';
  if (top.includes('sadness') || top.includes('down') || top.includes('loneliness') || top.includes('boredom')) {
    return '少主动，别硬聊';
  }
  // 这条命中频率最高，「别过火」等于每轮都在踩刹车；只在真可能过火的场合才收（老树 `:401`）
  if (top.includes('joy') || top.includes('cheer') || top.includes('pride') || top.includes('smug')) {
    return high >= 60 ? '可以接梗，接住了就再往前拱一步' : '可以接梗，别过火';
  }
  if (top.includes('curiosity')) return '看心情接，不硬聊';
  if (will !== null && will < 25) return '别揽长活';
  return '';
}

/**
 * 注入提示词：极轻。老树原注（保留）：
 *   「默认只一句状态摘要；仅当有明显情绪/意图时加行为倾向半句。**不要把状态写成说明书。**」
 *
 * @param {object} state emotion state（`initState` 的形状）
 * @param {object} [opts] `{emo, personaTwo}` —— `emo` 可直接给归一后的情绪表（省一次归一）
 * @returns {string} 注入文本；亢奋模式下整段替换（老树 `:1287`）
 */
/**
 * 判断状态是否值得注入（2026-10-15 修复「默认/过期/无变化状态每轮重复插入」）。
 *
 * 值得注入 = 至少一条：
 *   ① 任一情绪 ≥ 20（至少「有点」级别，老树 dirWord 的 `n >= 20` 档）
 *   ② 精力偏离中性 ≥ 20（<30 很累/偏累 或 >70 满血/还行）
 *   ③ 心情偏离中性 ≥ 20（<30 不太妙/有点闷 或 >70 不错）
 *   ④ 压力 ≥ 40（急压/慢压说人话档）
 *   ⑤ 行为约束触发（气到份上/上火/绷着/脑转不动/别装死）
 *
 * 不值得 = 纯默认/低残留（如「心情一般 + 情绪一点点」）⇒ 返回 '' 不注入。
 * 亢奋模式（isHypeMode）走独立分支，不受本判据影响（第二人格触发保留）。
 */
export function isNotableState(state) {
  if (!isPlainObject(state)) return false;
  const s = state.self || {};
  const pools = s.pools || {};
  const validPools = [];
  for (const k of ['physical', 'cognitive', 'emotional', 'will']) {
    const n = validPoolValue(pools[k]);
    if (n !== null) validPools.push(n);
  }
  const avgE = validPools.length === 4
    ? Math.round(validPools.reduce((a, b) => a + b, 0) / 4) : null;
  const emo = normalizeForPrompt(s.affect || {});
  const acuteStress = Number(s.acuteStress) || 0;
  const chronicStress = Number(s.chronicStress) || 0;
  // ① 任一情绪 ≥ 20
  for (const k of EMO_KEYS) {
    if ((Number(emo[k]) || 0) >= 20) return true;
  }
  // ② 精力偏离中性 ≥ 20
  if (avgE !== null && Math.abs(avgE - 50) >= 20) return true;
  // ③ 心情偏离中性 ≥ 20
  // ★ 2026-10-16：与 `moodLabel` 同口径 —— **真实 0 必须参与判定**。原来 `Number(s.mood) || 50`
  //   会把 `mood: 0`（最差）读成 50（中性）⇒ 这条判据不成立 ⇒ 整条状态行被判"不值得注入"而丢失。
  const mood = numberOrFallback(s.mood, 50);
  if (Math.abs(mood - 50) >= 20) return true;
  // ④ 压力 ≥ 40
  if (acuteStress >= 40 || chronicStress >= 40) return true;
  // ⑤ 行为约束触发（与 botStatePromptLine 末段同判据）
  const hotNow = sumHotEmotions(emo);
  if (hotNow >= 14 || acuteStress >= 70) return true;
  const cognitive = validPoolValue(pools.cognitive);
  if (cognitive !== null && cognitive < 25) return true;
  if ((Number(emo.shame) || 0) >= 25) return true;
  return false;
}

export function botStatePromptLine(state, opts = {}) {
  // 亢奋模式：系统已换成极简亢奋协议，这里只补一句状态，不再叠规则（老树 `:1286-1292`，逐字）
  if (isHypeMode()) {
    const lock = getHypeProtectedQQ();
    return lock
      ? `（亢奋模式）按【角色设定】的亢奋卡打，别软。硬锁：QQ ${lock} 不能骂/阴阳/@/波及。`
      : '（亢奋模式）按【角色设定】的亢奋卡打，别软。';
  }
  if (!isPlainObject(state)) return '';
  if (!isNotableState(state)) return '';
  const s = state.self || {};
  const pools = s.pools || {};
  // Same pool-parsing rule as isNotableState; a missing/non-finite pool must not be turned into 0.
  const validPools = [];
  for (const k of ['physical', 'cognitive', 'emotional', 'will']) {
    const n = validPoolValue(pools[k]);
    if (n !== null) validPools.push(n);
  }
  const avgE = validPools.length === 4
    ? Math.round(validPools.reduce((a, b) => a + b, 0) / 4) : null;
  const emo = opts.emo || normalizeForPrompt(s.affect || {});
  const energy = Object.fromEntries(['physical', 'cognitive', 'emotional', 'will']
    .map((key) => [key, validPoolValue(pools[key])]));
  const acuteStress = Number(s.acuteStress) || 0;
  const chronicStress = Number(s.chronicStress) || 0;

  // 情绪系统关掉时只报精力（老树 `:1297`）。新树无该开关 ⇒ 保留分支语义，恒为 false。
  if (opts.emotionEnabled === false) return `（此刻）精力${energyLabel(avgE)}。`;

  const parts = [`精力${energyLabel(avgE)}`, `心情${moodLabel(s.mood)}`];
  // 压力说人话：急压 = 刚被刺激过还没缓过来；慢压 = 一直没停着（老树 `:1302-1304`，逐字）
  if (acuteStress >= 40) parts.push('刚被刺激过，还没缓过来');
  else if (chronicStress >= 40) parts.push('一直没停，有点绷不住');

  // 三类聚合：模型不需要看 14 个标签，知道「向内闷着」还是「有外露的火气」就够（老树 `:1306`，逐字）
  const dirSum = { out: 0, in: 0, neu: 0 };
  const dirTop = { out: [], in: [], neu: [] };
  for (const k of EMO_KEYS) {
    const v = Number(emo[k]) || 0;
    if (v < 10) continue;
    const cat = EMOTIONS[k].cat;
    dirSum[cat] += v;
    dirTop[cat].push({ k, v, label: EMOTIONS[k].label });
  }
  // 分档强度副词（老树 `:1321`，含 2026-09-29 重标定说明的关键数字）
  const dirWord = (n) => (n >= 90 ? '很重' : n >= 60 ? '偏重' : n >= 20 ? '有点' : n >= 6 ? '一点点' : '');
  const bits = [];
  for (const [key, name] of [['in', '向内'], ['out', '向外'], ['neu', '中性']]) {
    const w = dirWord(dirSum[key]);
    if (!w) continue;
    dirTop[key].sort((a, b) => b.v - a.v);
    const named = dirTop[key].slice(0, 2)
      .map((x) => (EMO_PLAIN[x.k] ? `${x.label}(${EMO_PLAIN[x.k]})` : x.label)).join('、');
    bits.push(`${name}${w}${named ? '：' + named : ''}`);
  }
  let line = `（此刻）${parts.join('，')}。`;
  if (bits.length) line += `情绪：${bits.join('；')}。`;
  // 「别念出来」不是废话：2026-09-21 实测模型把这句学舌成了发言（老树 `:1333-1335`，逐字保留）
  const intent = computeIntent(emo, energy, { acuteStress, personaTwo: opts.personaTwo });
  if (intent) line += `倾向（内部提示，别照着念）：${intent}。`;
  // 行为约束：负性堆够了就给攻击许可，而不是一味让忍（老树 `:1336-1349`，逐字）
  const strong = (k) => (Number(emo[k]) || 0) >= 25;
  const hotNow = sumHotEmotions(emo);
  if (hotNow >= 28) {
    line += '气到这份上了，想骂就骂，别硬憋。';
  } else if (hotNow >= 14) {
    line += '有点上火，被惹了可以炸回去。';
  } else if (acuteStress >= 70) {
    line += '有点绷着，先别硬刚。';
  } else if (energy.cognitive !== null && energy.cognitive < 25) {
    line += '脑子转不动就少查少绕。';
  } else if (strong('shame')) {
    line += '别装死，承认就行。';
  }
  return line;
}

/**
 * 按 `EMOTION_ALIASES` 把盘上的 affect 键名归一到老树键名（**只读，不改 state**）。
 * 与 `apply.js` 里的同名 helper 是同一套规则；这里独立一份是为了让本文件
 * **零 import `apply.js`**（老树 `botStatePromptLine` 也不依赖结算逻辑）。
 */
export function normalizeForPrompt(affect) {
  const ALIAS = { irritation: 'irk', excitement: 'cheer' };
  const out = {};
  for (const [k, v] of Object.entries(affect || {})) {
    const key = ALIAS[k] || k;
    const n = Number(v) || 0;
    out[key] = key === k ? n : (out[key] || 0) + n;
  }
  return out;
}

export { CAT_LABEL };
