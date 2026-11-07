/**
 * M6 memory · 注入给模型的记忆段（**照老树 `src/memory.js:2170-2299` `formatForPrompt` 搬**）
 *
 * ★★★ 用户 2026-10-09 原话：「干脆就严格按照老树的格式注入来得了」。
 *   本文件就是那个格式的落点。产出的形状与老树**逐段对齐**：
 *
 *   【印象】京玉(QQ123)[好感75/100·亲近·因+5：Jev判断：正面互动]: ★[喜好]只听古典摇滚OST 近况：今天好累（半小时前）
 *   （态度）对京玉(QQ123)：亲近。帮腔护着点；对方被怼可站他/替他说话；但不必顺着夸，可以抬杠；别为了正确硬顶
 *   Jev建议：京玉 这轮互动值得调整好感（方向 +5，理由：…）。你可以自行决定是否调用 memory_favor 调整；不调整也可以。
 *
 * ★ 与新树既有 `【记忆视图】`（`modules/prompt/blocks.js:142` `renderMemoryView`）的关系：
 *   **两个都在，都不删。** 区别是数据源与形状：
 *   · `renderMemoryView` 吃 M6 `retrieve()` 的观察（claim + 证据 ID + 置信 + scope），
 *     逐条列 `- [证据 ids] （scope=…；置信 …）<claim>` —— 强调**可追溯**。
 *   · 本文件吃**按人聚合**的记忆（谁的 + 好感档 + 印象 + 近况），产出老树那句人话 —— 强调**可用**。
 *   老树两者都有：印象段是这条，`prefetch`/预检索是那条（`src/orchestrator.js:2716-2752`）。
 *   ★ **接线在 `modules/prompt/**`（别人域，本票不碰）** —— 本文件先备好格式与出口。
 *
 * ★ 数据源说明（诚实交代，不是"照抄就能跑"）：
 *   新树 M7 `emotion-state` 是好感唯一真值；`people` 只供印象、近况与态度，
 *   必须由调用方传入 `emotionState`。没有 M7 状态时按中性值处理，不回退读 `people[].favor`。
 *   老树这份数据住在 `data/memory/people/*.json`（成员库：impressions/surface/favor/attitude）。
 *   新树 M6 把同一批内容搬进了 `observations.jsonl`（385 条，`modules/memory/store.js`），
 *   且 `apps/server/api/memory.js` 白纸黑字写着「surface: **新树无表层记忆字段**」。
 *   ⇒ 本函数**接受已聚合好的记忆条目**（`people` 形参），不自己读数据文件。
 *   聚合由调用方做：`memory.retrieve()` 的结果按 `subjectId` 分组即可。
 *   「近况：」那一段在没有 surface 数据时**自然为空**（老树也是这么退化的：`:2234` 过滤后为空则不拼）。
 */

/** 印象类型 → 注入时显示的中文标签（老树 `IMP_TYPE_LABEL`，`src/memory.js:157-164`，逐字）。 */
export const IMP_TYPE_LABEL = Object.freeze({
  identity: '身份',
  preference: '喜好',
  edge: '雷点',
  style: '风格',
  event: '事件',
  attitude: '态度'
});

/** 印象类型全集（老树 `IMP_TYPES`，逐字）。 */
export const IMP_TYPES = Object.freeze(['identity', 'preference', 'edge', 'style', 'event', 'attitude']);

/**
 * 没有类型时按内容猜一个（老树 `guessImpressionType`，`src/memory.js:166-174`，**正则逐字照抄**）。
 * 猜测出来的类型标 `typeGuess: true`，好让"人工/模型给的类型"与"猜的"能区分。
 */
export function guessImpressionType(content) {
  const t = String(content || '');
  if (/(态度|对他要|对他该|对他用|对他：|宠着|少怼|顺着说|站他)/.test(t)) return 'attitude';
  if (/(别|不要|讨厌|烦死|雷点|忌|禁止|一提就|不想听)/.test(t)) return 'edge';
  if (/(喜欢|爱吃|爱玩|爱好|常用|常去|最爱)/.test(t)) return 'preference';
  if (/(学生|打工|程序员|上班|住|老家|女朋友|男朋友|在读|岁|xx岁)/.test(t)) return 'identity';
  if (/(说话|口头禅|风格|社牛|社恐|话痨|爱玩梗|昵称)/.test(t)) return 'style';
  return 'event';
}

/**
 * 好感七档标签（老树 `favorTierInfo`，`src/memory.js:241-250`，**阈值逐字照抄**）。
 *
 * ⚠️ 边界逐字定义（别"顺手改成 >=`）：
 *   `v <= 13` 敌意 / `<= 27` 冷淡 / `<= 41` 疏远 / `<= 57` 中性 / `<= 71` 友好 / `<= 85` 亲近 / 其余 死党。
 *   注意老树 `Number(favor) || 50`：**0 会走成 50**（不是 0）—— 这是老树的真实行为，照抄。
 */
export function favorTierInfo(favor) {
  const v = Math.min(100, Math.max(0, Math.round(Number(favor) || 50)));
  if (v <= 13) return { key: 'hostile', label: '敌意', tag: '敌意', color: 'red' };
  if (v <= 27) return { key: 'cold', label: '冷淡', tag: '好感低', color: 'red' };
  if (v <= 41) return { key: 'distant', label: '疏远', tag: '稍冷', color: 'orange' };
  if (v <= 57) return { key: 'neutral', label: '中性', tag: '', color: 'accent' };
  if (v <= 71) return { key: 'friendly', label: '友好', tag: '稍友好', color: 'green' };
  if (v <= 85) return { key: 'close', label: '亲近', tag: '好感高', color: 'green' };
  return { key: 'protect', label: '贴心/护短', tag: '死党', color: 'green' };
}

/** 注入时跟在好感数字后面的那个短标签（老树 `favorFavTag`，逐字）。 */
export function favorFavTag(favor) {
  return favorTierInfo(favor).tag;
}

/**
 * 高好感：帮腔、护着、站他（不必顺着夸）；低好感：冷淡、少理。
 * 老树 `favorToneHint`，`src/memory.js:351-363` —— **七档文案逐字照抄**。
 * `neutral` 档返回空串（中性即隐身，不注入任何态度话）。
 */
export function favorToneHint(who, favor) {
  const t = favorTierInfo(favor);
  switch (t.key) {
    case 'hostile': return `对${who}：明显敌意，能避就避；被粘着可短句怼完就走，别耐心解释`;
    case 'cold': return `对${who}：冷淡敷衍，少接话；别热情贴上去`;
    case 'distant': return `对${who}：稍冷、话少；不主动帮腔`;
    case 'neutral': return '';
    case 'friendly': return `对${who}：友好，愿意接话、语气松一点`;
    case 'close': return `对${who}：亲近。帮腔护着点；对方被怼可站他/替他说话；但不必顺着夸，可以抬杠；别为了正确硬顶`;
    case 'protect': return `对${who}：死党/贴心。明显偏袒护短，主动站对方、替他挡话；但不必顺着夸——可以抬杠、可以得寸进尺、可以反过来跟他要东西；别人怼他可回怼回去（仍别过火）`;
    default: return '';
  }
}

/** 好感变化理由的 7 天新鲜度窗口（老树 `FAVOR_REASON_TTL_MS`，逐字）。 */
export const FAVOR_REASON_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 最近一次「有理由」的好感变化 → 提示词片段：`·因+5：Jev判断：正面互动…`
 * 老树 `favorWhyLine`，`src/memory.js:337-348` —— 边界逐字：
 *   · **没有理由 ⇒ 返回空串**（调用方据此保证老记录的提示词逐字节不变）；
 *   · `favorReasonAt` 缺失/0/NaN/负数/未来 ⇒ 不注入；
 *   · `now - favorReasonAt > 7×24h` ⇒ 不注入（**正好 7 天仍注入**）。
 */
export function favorWhyLine(reason, delta, reasonAt = 0, now = Date.now()) {
  const why = String(reason || '').trim().slice(0, 60);
  if (!why) return '';
  const at = Number(reasonAt);
  if (!Number.isFinite(at) || at <= 0) return '';
  const age = Number(now) - at;
  if (!Number.isFinite(age) || age < 0) return '';
  if (age > FAVOR_REASON_TTL_MS) return '';
  const d = Number(delta);
  const dir = Number.isFinite(d) && d !== 0 ? `${d > 0 ? '+' : ''}${Math.round(d)}` : '';
  return dir ? `·因${dir}：${why}` : `·因：${why}`;
}

/**
 * 好感建议的提示词文本。措辞三要素（老树 `favorSuggestionLine`，`src/memory.js:330-334`，逐字）：
 * ①明确是建议 ②给方向与理由 ③显式说明可不遵守。
 */
export function favorSuggestionLine(who, v) {
  const delta = Number(v?.delta) || 0;
  const dir = delta > 0 ? `+${delta}` : `${delta}`;
  const reason = String(v?.reason || '').trim();
  const why = reason ? `，理由：${reason}` : '';
  return `Jev建议：${who} 这轮互动值得调整好感（方向 ${dir}${why}）。你可以自行决定是否调用 memory_favor 调整；不调整也可以。`;
}

/** 单条印象的新鲜度 0~1（老树 `impressionRecency`，`src/memory.js:512-521`，**分界逐字**）。 */
export function impressionRecency(e, now = Date.now()) {
  const t = Math.max(Number(e?.lastSeen) || 0, Number(e?.lastActiveAt) || 0, Number(e?.createdAt) || 0);
  if (!t) return 0.2;
  const days = Math.max(0, (now - t) / 86400000);
  if (e?.pin) return 1;
  if (days <= 7) return 1;
  if (days <= 30) return 0.75;
  if (days <= 60) return 0.45;
  return 0.15;
}

/** 单条印象参与排序的时间戳（老树 `impressionRankTime`，逐字）。 */
export function impressionRankTime(e) {
  return Math.max(Number(e?.lastSeen) || 0, Number(e?.lastActiveAt) || 0, Number(e?.createdAt) || 0);
}

/**
 * 话题相关性 0~1（老树 `topicOverlap`，`src/memory.js:614-642` 的语义）。
 * 新树没有 bigram 那套索引（那是 `src/memory.js` 私有的），这里用等价的
 * 「整串命中 = 1，否则按分词命中比例」——**与新树 `memory/index.js:183` `topicOverlap` 同源**，
 * 保持两处算法一致（老树是 `topicSets` 入参，这儿接受原始字符串/数组）。
 */
function topicOverlap(content, topic) {
  const c = String(content || '').toLowerCase();
  const list = (Array.isArray(topic) ? topic : [topic]).map((x) => String(x || '').toLowerCase()).filter(Boolean);
  if (!list.length || !c) return 0;
  let best = 0;
  for (const t of list) {
    if (!t) continue;
    if (c.includes(t)) { best = 1; break; }
    const parts = t.split(/[\s,，。;；/|]+/).filter((x) => x.length >= 2);
    if (!parts.length) continue;
    let hit = 0;
    for (const p of parts) if (c.includes(p)) hit += 1;
    best = Math.max(best, hit / parts.length);
  }
  return best;
}

/**
 * 印象排序（老树 `rankImpressions`，`src/memory.js:644-662` —— **权重与过滤逐字**）。
 *
 * ⚠️ 老树这里有个反直觉但刻意的过滤：`type: 'style'` 的条目**不注入**
 *   （原注：「consolidate 出来的通用画像 —— 对『该怎么回他』几乎没有指导价值，
 *   却占着名额，而且这种档案腔最容易被模型原样念出来。留在库里，但不注入提示词。」）
 *   ★ **照抄这个过滤**，别"优化"掉。
 */
export function rankImpressions(impressions, topic, now = Date.now()) {
  return (impressions || [])
    .filter((e) => String(e?.type || '') !== 'style')
    .map((e) => {
      const rec = impressionRecency(e, now);
      const typeW = e.type === 'attitude' ? 0.4
        : e.type === 'edge' ? 0.35
        : e.type === 'preference' ? 0.3
        : e.type === 'identity' ? 0.15
        : 0;
      const rel = topicOverlap(e.content, topic);
      return { e, rec, rel, score: (e.pin ? 10 : 0) + rec + typeW + rel };
    })
    .filter((x) => x.e.pin || x.rec >= 0.2)
    .sort((a, b) => b.score - a.score);
}

/**
 * 近况条目的粗年龄（老树用 `ageLabel`，与 `modules/emotion/half-life.js:100` **同一份**）。
 * 这里内联一份是为了让本文件**零跨模块依赖**（老树 `memory.js` 也不 import emotion）。
 */
export function ageLabel(ageMin) {
  const m = Number(ageMin);
  if (!Number.isFinite(m) || m < 0) return '';
  if (m < 2) return '刚刚';
  if (m < 10) return '几分钟前';
  if (m < 50) return '半小时左右';
  if (m < 90) return '1小时前';
  if (m < 60 * 20) return '几个小时前';
  if (m < 60 * 48) return '昨天';
  if (m < 60 * 24 * 8) return '几天前';
  if (m < 60 * 24 * 45) return '几周前';
  return '很久以前';
}

/**
 * ★ 老树 `formatForPrompt`（`src/memory.js:2170-2299`）的等价实现。
 *
 * @param {object} opts
 *   · `people` — **已聚合好**的按人记忆数组（调用方从 `memory.retrieve()` 分组而来）：
 *     `{ userId, name?, attitude?,
 *        impressions?: [{content, type?, pin?, createdAt?, lastSeen?, lastActiveAt?}],
 *        surface?: [{text, at, kind?}] }`
 *   · `emotionState` — M7 `emotion-state` 对象，好感只从 `persons[userId].favor` 读取；
 *     缺失时按 M7 的中性默认值 50 处理，不读 `people[].favor`。
 *   · `userIds` — 只注入这些人（老树 `relevantUserIds`；`null` = 不筛）
 *   · `topic`   — 当前触发文本（数组逐条，别拼成一坨；沿用老树 `src/prompt.js:1898` 的做法）
 *   · `picks`   — 本地 Jev 捞上来的落榜条目（`Map<userId, content[]>`，老树 `topicPicks` 的产物）
 *   · `suggestion` — 待注入的好感建议 `{userId, delta, reason}`（老树 consume-once 队列的取用结果）
 *   · `notes`   — 管理员备注 `{[userId]: name}`（老树 `config.memberNotes`）
 *   · `maxPeople=4` / `maxEach=2` / `maxChars=380` / `now` — 老树默认参数，逐字
 * @returns {string} `【印象】…` 整段；无内容时返回 `''`
 */
export function formatForPrompt({
  people = [], userIds = null, topic = '', picks = null,
  suggestion = null, notes = {}, maxPeople = 4, maxEach = 2,
  maxChars = 380, now = Date.now(), emotionState = null
} = {}) {
  const filter = userIds ? new Set([...userIds].map(String)) : null;
  const nm = notes || {};
  const relationCache = new Map();
  const relationFor = (m) => {
    const uid = String(m?.userId ?? '').trim();
    if (!uid) return null;
    if (relationCache.has(uid)) return relationCache.get(uid);
    // M7 state is injected by the caller. Read only its canonical person record here;
    // memory must not import another module's implementation or fall back to people[].favor.
    const raw = emotionState?.persons?.[uid];
    const relation = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? {
        favor: Number.isFinite(Number(raw.favor)) ? Number(raw.favor) : 50,
        lastChange: raw.lastChange ?? null
      }
      : null;
    relationCache.set(uid, relation);
    return relation;
  };
  const favorFor = (m) => Number(relationFor(m)?.favor ?? 50);
  // 认人以 QQ 为准：显示「名字(QQ号)」或裸 QQ，别光给可改昵称（老树 `:2211-2216`，逐字）
  const whoOf = (m) => {
    const uid = String(m?.userId || '').trim();
    const name = String(nm[uid] || m?.name || '');
    if (!uid) return name || '未知';
    return name && name !== uid ? `${name}(QQ${uid})` : `QQ${uid}`;
  };

  // ★ 好感建议**先于**早退/名额裁剪取出来（老树 `:2188-2204`）：
  //   否则「没有印象、也不在 filter 里」的人会拿不到他那条建议。
  let suggestionText = '';
  if (suggestion) {
    const s = normalizeSuggestion(suggestion);
    if (s) suggestionText = favorSuggestionLine(whoOf({ userId: s.userId }), s);
  }

  // 候选 = 有长期印象、活着的近况、或非中性好感的人（老树 `:2174-2187`）
  let list = [...(people || [])]
    .filter((m) => (
      (m.impressions || []).length
      || (m.surface || []).length
      || favorFor(m) !== 50
      || String(m.attitude || '').trim()
    ))
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  if (filter) list = list.filter((m) => m.userId && filter.has(String(m.userId)));
  if (!list.length) return suggestionText;   // ★ 早退也要带上建议（老树 `:2204`）

  list = list.slice(0, Math.max(1, maxPeople));
  const parts = [];
  const favorHints = [];
  for (const m of list) {
    const who = whoOf(m);
    const visibleImpressions = m.impressions || [];
    const ranked = rankImpressions(visibleImpressions, topic, now);
    // Jev 捞上来的落榜条目（字面不重合但语义相关）先占名额，其余按名次补（老树 `:2220-2224`）
    const forced = new Set((picks && typeof picks.get === 'function' ? picks.get(String(m.userId)) : null) || []);
    const ordered = forced.size
      ? [...ranked.filter((x) => forced.has(String(x.e.content))), ...ranked.filter((x) => !forced.has(String(x.e.content)))]
      : ranked;
    const lines = ordered.slice(0, Math.max(1, maxEach)).map((x) => {
      const tag = x.e.pin ? '★' : (IMP_TYPE_LABEL[x.e.type] ? `[${IMP_TYPE_LABEL[x.e.type]}]` : '');
      // 偏好/身份给更长；事件默认 90 字，别把「推歌三类」砍半（老树 `:2227-2230`，逐字）
      const limit = (x.e.type === 'preference' || x.e.type === 'identity' || x.e.pin) ? 140 : 90;
      const body = String(x.e.content).slice(0, limit);
      return tag ? `${tag}${body}` : body;
    });
    // ── 近况（表层记忆）：按浓度取最新的几条，带粗年龄 ──（老树 `:2232-2247`）
    const surface = (m.surface || [])
      .slice(0, Math.max(0, 2))
      .map((e) => {
        const age = ageLabel(Math.max(0, (now - (Number(e.at) || now)) / 60000));
        return age ? `${e.text}（${age}）` : String(e.text || '');
      })
      .filter(Boolean);
    const surfaceText = surface.join('、');

    const relation = relationFor(m);
    const favor = Number(relation?.favor ?? 50);
    const attitude = String(m.attitude || '').trim();
    const favTag = favorFavTag(favor);
    const favorText = favor !== 50 ? `好感${favor}/100${favTag ? `·${favTag}` : ''}` : '';
    // 理由只挂在"非中性"的括号里：favor===50 时 favorText 为空 ⇒ 一个字都不注入（老树 `:2252-2256`）
    const lastChange = relation?.lastChange;
    const favorChanged = Array.isArray(lastChange?.fields) && lastChange.fields.includes('favor');
    const favorLedger = favorChanged && Array.isArray(emotionState?.ledger)
      ? [...emotionState.ledger].reverse().find((entry) => (
        entry?.target === `person:${m.userId}` && entry?.field === 'favor'
      ))
      : null;
    const favorWhy = favorText && favorChanged
      ? favorWhyLine(lastChange.reasonText ?? lastChange.reason, favorLedger?.delta, lastChange.at, now)
      : '';
    const favorBracket = favorText ? `[${favorText}${favorWhy}]` : '';
    const tail = surfaceText ? `${lines.length ? ' ' : ''}近况：${surfaceText}` : '';
    if (lines.length) {
      const freshest = Math.max(0, ...visibleImpressions.map((e) => Number(e.lastSeen) || Number(e.createdAt) || 0));
      const ageDays = freshest ? Math.max(0, (now - freshest) / 86400000) : 30;
      const oldMark = ageDays > 30 ? '[旧]' : '';
      parts.push(`${who}${oldMark}${favorBracket}: ${lines.join(' / ')}${tail}`);
    } else if (surfaceText) {
      // 只有近况、还没攒下印象的人（新面孔/刚开口的）（老树 `:2263-2265`）
      parts.push(`${who}${favorBracket}: 近况：${surfaceText}`);
    } else if (favorBracket || attitude) {
      parts.push(`${who}${favorBracket}`);
    }
    // 管理员写的「态度」优先；没写再按好感档位提示（老树 `:2269-2275`）
    if (attitude) favorHints.push(`对${who}：${attitude}`);
    else {
      const hint = favorToneHint(who, favor);
      if (hint) favorHints.push(hint);
    }
  }
  if (!parts.length && !favorHints.length) return '';
  let text = parts.join('; ');
  const hintLine = favorHints.length ? `（态度）${favorHints.join('；')}` : '';
  // ⚠️ 态度行算进**同一个** maxChars 预算（老树 `:2291-2294`：它原来挂在预算之外，
  //   于是"520 字上限"实测能到 600+，而这整块排在缓存断点之后 = 每轮按原价重算）
  const budget = Math.max(80, Number(maxChars) - (hintLine ? hintLine.length + 1 : 0));
  if (text.length > budget) text = text.slice(0, Math.max(0, budget - 1)) + '…';
  // ★ 建议行**不进 maxChars 预算**：它是本轮唯一"可执行"的信息，单独一行放最后（老树 `:2295-2298`）
  const sugLine = suggestionText ? `\n${suggestionText}` : '';
  return `【印象】${text}${hintLine ? `\n${hintLine}` : ''}${sugLine}`;
}

/**
 * 好感建议的 consume-once 队列（老树 `src/memory.js:279-327`）。
 *
 * 老树原注（保留，它是这个设计的关键）：
 *   「Jev 后置判定发生在**回复之后**，所以这条建议**只能影响下一轮**（也就是『发言前』），
 *   对当轮发言无效。」+「纯内存 Map，**不写入文件** ⇒ 进程重启即清空，不会留成永久污染。」
 *
 * @param {number} ttlMs 老树 `FAVOR_SUGGEST_TTL_MS` = 30 分钟
 */
export function createFavorSuggestionQueue({ ttlMs = 30 * 60 * 1000 } = {}) {
  const pending = new Map();
  const prune = (now) => {
    for (const [k, v] of pending) {
      if (!v || !Number.isFinite(v.at) || now - v.at > ttlMs) pending.delete(k);
    }
  };
  return {
    /** 记一条待注入建议；键是 chatKey ⇒ **不跨群泄漏**（老树 `:301-309`）。 */
    set(chatKey, { userId, delta, reason } = {}) {
      const ck = String(chatKey || '').trim();
      const uid = String(userId ?? '').trim();
      const d = Number(delta);
      if (!ck || !/^\d{1,15}$/.test(uid) || !Number.isFinite(d) || d === 0) return false;
      prune(Date.now());
      pending.set(ck, { userId: uid, delta: Math.round(d), reason: String(reason || '').trim().slice(0, 60), at: Date.now() });
      return true;
    },
    /** 取用并删除（consume-once）。只读不改 ⇒ 同一份建议不会被两轮重复读到。 */
    take(chatKey, now = Date.now()) {
      const ck = String(chatKey || '').trim();
      if (!ck) return null;
      prune(now);
      const v = pending.get(ck);
      if (!v) return null;
      pending.delete(ck);
      if (!Number.isFinite(v.at) || now - v.at > ttlMs || now < v.at) return null;
      return v;
    },
    size() { prune(Date.now()); return pending.size; }
  };
}

/** 建议条目的合法性校验（老树 `setFavorSuggestion` 的入参门槛，逐字）。 */
function normalizeSuggestion(v) {
  if (!v) return null;
  const uid = String(v.userId ?? '').trim();
  const d = Number(v.delta);
  if (!/^\d{1,15}$/.test(uid) || !Number.isFinite(d) || d === 0) return null;
  return { userId: uid, delta: Math.round(d), reason: String(v.reason || '').trim().slice(0, 60) };
}
