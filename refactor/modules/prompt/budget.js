/**
 * M8b · 预算与**可见**裁剪
 *
 * 派单硬边界第 5 条：提示词长度要有界，**超限按优先级裁剪，且必须在返回里留痕** ——
 * 不许静默截断（同 M5 那条裁定的同一条原则）。
 *
 * 设计：
 *   · 段（section）带 `priority`（越小越不能丢）+ `droppable`；
 *   · `minChars` 以下的段永远不丢（哪怕超预算也要留）—— 丢规则 = 换人格；
 *   · 两轮裁剪：① 按优先级从低到高整段丢；② 还超就按段内 `truncate` 截尾。
 *     每一刀都写进 `trimmed[]`。
 */

/** 段优先级（约定值，调用方可覆盖单段）。 */
export const PRIORITY = Object.freeze({
  RULES: 0,        // 稳定规则 + 人设卡：永不丢、永不截
  TRIGGER: 10,     // 本次唤醒的证据：永不丢、永不截
  CORRECTION: 15,  // 有来源的明确更正，优先保留
  TODO: 18,        // 尚未完成且未过期的必要待办
  RELATION: 20,    // 关系摘要（由调用方渲染好传进来）
  WORKING: 22,     // 当前话题与短期状态
  PAST_CHAT: 25,   // 双方聊天时间线；预算不足时先收缩正文
  EPISODE: 32,     // 有来源的情节摘要
  SELF: 30,        // 跨轮心声
  MEMORY: 40,      // 记忆视图
  MEDIA: 50,       // 图片/视频的描述与 OCR
  EXTRA: 60        // 扩展提示词片段
});

/**
 * ★ 2026-10-17（用户：段布局显式化，别靠 push 顺序）：**段的布局登记表 = 唯一来源**。
 *
 * 背景与纪律（写给下一个改这里的人）：
 *   · 此前 `PRESENTATION_ORDER` 只有 4 个段有显式序，其余走默认 50，而 `Array#sort` 稳定
 *     ⇒ 这些段的**实际顺序 = `sections.push` 的顺序**：列存在，但没有约束力，中间插一段就静默变序。
 *   · 现在每个"本层真的会 push 的段名"都在这里登记：`order`（呈现顺序）/ `user`（是否进 user 文本）/
 *     `why`（一句话依据）。**未登记的段名**：`order = UNREGISTERED_SECTION_ORDER`（安全尾部）、
 *     `user = true`（不静默丢内容），并由调用方写进 `diagnostics.sectionLayout.unregistered` 告警 ——
 *     目的是"漏登记不改变前缀里的稳定内容位置、也不让整轮发言抛错"。
 *
 * 三条不许混为一谈的规则：
 *   ① `order` 只管**可见顺序**（user 文本里谁在前）；与 `priority`/`droppable`（预算裁剪）**无关**；
 *   ② `user:false` = 本层推到 `sections` 只为诊断（或由 compose 后追加），**不进 user 文本**，不是"删段"；
 *   ③ 排在前面的 ≠ 更"重要"，只按"轮与轮之间字节更稳定"排 —— 但**确实稳定的文字才配排历史之前**：
 *      本体状态/跨轮心声/印象/关系/语义卡/记忆事实都可能逐轮变（JEV 选择、召回集合随问句变）
 *      ⇒ 一律排在 `current-context`（内含历史）**之后**，不抄"稳定区放历史前"的排法。
 */
export const UNREGISTERED_SECTION_ORDER = 900;

export const SECTION_LAYOUT = Object.freeze({
  // ── 实际进 user 文本的段（由 order 明确出站顺序）──
  'current-context': { order: 0, user: true, why: '本轮上下文（标题 + 历史正文 + 实时三行）；历史断点在此段内部' },
  'history-context': { order: 0, user: true, why: 'DS 独立历史段；不含本轮时间或唤醒原文' },
  self: { order: 20, user: true, why: '跨轮心声（会新增和过期，仍放在历史之后、召回记忆与印象之前）' },
  'bot-state': { order: 25, user: true, why: '本体状态（情绪/精力）变化较多，放在跨轮心声之后' },
  episodes: { order: 30, deepseekOrder: 21, user: true, why: '有来源的情节摘要；DS 在跨轮心声之后、本体状态之前' },
  identity: { order: 40, user: true, why: '会话身份与此刻（易变半：时间/styleHint）；稳定半在 system 尾部' },
  relation: { order: 42, user: true, why: '关系状态摘要' },
  impressions: { order: 44, deepseekOrder: 24, user: true, why: '人物印象（召回集合随涉及的人变；DS 在跨轮心声、记忆事实之后，本体状态之前）' },
  'memory-recall-reminder': { order: 46, user: true, why: '按需召回提示' },
  'memory-prefetch': { order: 48, user: true, why: '记忆预取（EXTRA）' },
  'recent-digest': { order: 50, user: true, why: '近期动态摘要' },
  'semantic-cards': { order: 52, user: true, why: '语义卡（抽取/排序随 query 变，不是稳定区）' },
  corrections: { order: 54, deepseekOrder: 22, user: true, why: '有证据的明确更正；DS 在跨轮心声、情节之后，裁剪优先级不变' },
  'memory-facts': { order: 56, deepseekOrder: 23, user: true, why: '记忆视图；DS 在跨轮心声、明确更正之后，本体状态之前' },
  'current-turn': { order: 80, user: true, why: 'DS 本轮话题/需要/时间/唤醒及图片候选，放动态尾部' },

  // ── 推到 sections 但不进 user 文本（显式黑名单：每条都给"为什么"）──
  'missing-tools': { order: 60, user: false, why: '缺工具提示：现无任何注入路径（本层被 user 过滤丢弃、compose 无 append）—— 见回执潜在缺口' },
  'turn-candidates': { order: 62, user: false, why: '候选（图片/引用）已并入 current-context（candidateContextText）⇒ 不重复加' },
  participation: { order: 64, user: false, why: '参与度参考：现无任何注入路径（本层被 user 过滤丢弃、compose 无 append）—— 见回执潜在缺口（key-ledger 记 live 与此不符）' },
  'pending-todos': { order: 66, user: false, why: '待办：实际注入 = compose appendToUser(pendingTodosText)（按正文标记判是否已消费）⇒ 本层副本不重复加' },
  working: { order: 68, user: false, why: '当前话题/短期状态：话题与需要已并入 current-context（contextTopic/contextNeed）' },
  todos: { order: 70, user: false, why: '待办清单：渲染来源与 pending-todos 不同，本层历史设计不进 user 白名单（老树由 compose 侧处理）' },
  'memory-dropped': { order: 72, user: false, why: '被丢记忆的计数句：只作诊断，不告诉模型"另有 N 条看不见"' },
  toolplan: { order: 74, user: false, why: '工具计划只读清单：现无任何注入路径（未见消费者；工具可用性以 tools schema 为准）' },
  'meme-cue': { order: 76, user: false, why: '闪梗：实际注入 = compose appendToUser(memeCueText)（无条件追加）；本层副本不进 user ⇒ 不重复加' },
  // 幽灵项：白名单里曾长期列着它，但本层已不生成该段（compose 仍传 crossTurnText 只为调用兼容）。
  'cross-turn': { order: 78, user: false, why: '跨轮记忆注入已取消：本层不生成该段（参数保留只为 compose 调用兼容）' },
});

/** 段布局查询（**总不抛错**）：未登记 ⇒ 安全尾部 + 仍进 user + 由调用方记告警。 */
export function sectionLayoutOf(name) {
  const key = String(name ?? '');
  const hit = SECTION_LAYOUT[key];
  if (hit) return hit;
  return { order: UNREGISTERED_SECTION_ORDER, user: true, why: '未登记（安全尾部；请补进 SECTION_LAYOUT）', unregistered: true };
}

/** 全量登记名 → 顺序（诊断/审阅用；不含未登记段）。 */
export const PRESENTATION_ORDER = Object.freeze(
  Object.fromEntries(Object.entries(SECTION_LAYOUT).map(([name, spec]) => [name, spec.order])),
);

/**
 * 段顺序。两种来源，优先级：**调用方显式 `layoutOrder`**（数字） > 登记表。
 *
 * ★ 2026-10-17（洛版 DS 布局接入）：`layoutOrder` 是**唯一**允许绕过登记表的通道，
 *   专给"调用方产出的稳定前置段"（`buildMessages` 的 `stablePrefixSections`，DS 策略下放在
 *   历史之前，用负数）——这些段名在运行时才知道，无法预先登记。**仍不许**用它把
 *   记忆/心声/印象这类逐轮会变的段搬到历史之前（对准入的告诫见 SECTION_LAYOUT 表头）。
 */
export function presentationOrder(section) {
  const override = Number(section?.layoutOrder);
  if (Number.isFinite(override)) return override;
  return sectionLayoutOf(section?.name).order;
}

/** 该段是否"调用方显式声明了顺序"（= 不算漏登记）。 */
export function hasExplicitLayoutOrder(section) {
  return Number.isFinite(Number(section?.layoutOrder));
}

export const DEFAULT_BUDGET = Object.freeze({
  /**
   * **用户段**字符总和上限。
   *
   * ★ 2026-10-08（P2 修正）：这一行原来写的是「全部消息 content 的字符总和上限（**含 system**）」——
   *   **代码从来没这么做过**：system 段在 `prompt/index.js` 里先由 `systemRules()` 拼好，
   *   再和裁剪后的用户段一起进 `messages`，`applyBudget()` 只看得见用户段（见 :63 的入参）。
   *   也就是说「含 system」这句注释**一直在骗人**：真超限时 system 与工具 schema 是不计入的。
   *   现在按事实拆成两个数：
   *     · `maxChars`       —— 用户段上限（**行为不变**，老调用方与老用例都不受影响）
   *     · `maxTotalChars`  —— **整份请求**上限（system + 工具 schema + 用户段），0 = 不限
   *   整份请求的真实计量在 `applyRequestBudget()` / `measureRequest()`，留痕在 `diagnostics.request`。
   */
  maxChars: 18000,   // 2026-11-07（她：「1+2」）：12000 → 18000，用户段能多装历史/记忆
  /** 整份请求（system + tools schema + 用户段）字符上限；0/缺省 = 不启用这道闸。 */
  maxTotalChars: 0,
  /** 记忆视图最多几条（按 confidence 降序，保留带证据的那批优先）。 */
  maxMemoryItems: 12,
  /**
   * ★ N28（2026-10-09）：**第二道闸 —— 整段字符上限**。
   * 改前记忆视图只有 `maxMemoryItems` 一道条数闸，**每条 claim 原文照灌**
   * （用户原话：「这块还打不了缓存，占用还这么大」）。
   * 现在组包时按**真渲染长度**从上限往下回退条数（至少留 1 条：一条都不给会制造
   * 「这里什么都没有」的假前提）。这层与 `applyBudget()`/`applyRequestBudget()` 的整段闸
   * 独立 —— 后者按优先级丢整段，本闸只收记忆视图这一段。
   */
  maxMemoryChars: 2400, // 2026-11-07（她：「1+2」）：1200 → 2400，记忆视图多一倍
  /** 单条记忆 claim 的字符上限；超出时在该条后明确标注截了多少（不静默）。 */
  maxMemoryClaimChars: 160,
  /** 明确更正、情节摘要与待办均有独立预算，且高于普通长期记忆。 */
  maxMemoryCorrections: 4,
  // ★ 2026-10-14 用户口径（`.agent/本次输入应该输入的东西.md`）：【相关情节摘要】**最多五条**。
  //   原值 4（早先"瘦身"时压下来的），按新口径放回 5；段内再有的 shrink 只会往下砍，不会超过这个上限。
  maxEpisodeSummaries: 5,
  maxTodos: 4,
  /** 跨轮心声最多几条；时间线已包含的行不重复。 */
  maxRecentSends: 6,
  /**
   * 历史正文的**条数**上限；当前唤醒证据始终优先。
   * ★ 2026-10-14 裁定（③ 输入瘦身第一件）改变了它在冷热分片那一路的作用域：
   *   · 冷热分片段：只约束**热段**条数。冷段一条都不由它减 —— 冷段边界只由 compose 的切点决定，
   *     拿它砍冷段等于每轮移动"看得见的较早段"起点，而老树那条省写规则（一条消息一行，要看前文的
   *     `prevTs`/`seen`）读到什么前文正由这个起点决定 ⇒ 起点一漂，写法错位、缓存前缀也白写。
   *   · 单时间线那一路（本轮没分段时）：语义不变，仍是整段历史的条数上限。
   *   ⚠ 所以"这一格能塞多少条历史"在两条路上不再是同一个数：分片那一路的真实总量 = 冷段（切点给多少算多少）
   *     + 热段（本数封顶）。总量超 `maxChars` 时按 逐条字数 → 热段条数 收缩，压到底仍超 ⇒ 按数注入并记超限，
   *     不静默截断（实现见 `index.js` 的 `useHistoryCold` 那一段与 `historyCold.overBudget`）。
   */
  // ★ 2026-10-26（溟·她说「把 qq 上下文扩大吧」「加吧，没事」）：40 → 80。
  //   实测群里 40 条只覆盖 13 分钟，历史正文才 3000–6000 字，离 maxChars 12000 还远，
  //   所以加条数是安全的；每轮多约 700 token，她点头付这个钱。
  maxRecentChatMessages: 80,
  /** 两段历史中单条正文最多注入字符数；超出时在该条后明确标注截断。 */
  maxRecentChatCharsPerMessage: 600,
  /** 单条媒体 desc/ocr 的字符上限。 */
  maxMediaDescChars: 200,
  /** 单个可丢段最短保留长度（低于它丢整段比截半句干净）。 */
  minCharsToDrop: 40
});

export function mergeBudget(budget) {
  const b = budget && typeof budget === 'object' ? budget : {};
  const out = { ...DEFAULT_BUDGET };
  for (const k of Object.keys(DEFAULT_BUDGET)) {
    const v = b[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

export function chars(s) {
  return typeof s === 'string' ? s.length : 0;
}

/**
 * 按预算裁剪一段段内容。**三刀，每一刀都留痕**：
 *   ① `shrink`：段自己收缩（记忆视图"少给几条"比"整段丢掉"好）；
 *   ② 整段丢弃：优先级最低的可丢段；
 *   ③ 段内截尾：还超就截**优先级最低的段**（含不可丢段，但会留痕）。
 *
 * @param {Array<{name:string, priority:number, text:string, droppable?:boolean, shrink?:()=>(string|null), meta?:object}>} sections
 * @param {object} budget
 * @param {object} diagnostics 会被就地写入 trimmed[]
 * @returns {Array} 保留的段（保持原顺序）
 */
export function applyBudget(sections, budget, diagnostics) {
  const list = sections.map((s) => ({ ...s, text: String(s.text ?? '') }));
  const trimmed = [];
  const total = () => list.reduce((n, s) => n + chars(s.text), 0);

  const shrinkSection = (s) => {
    while (total() > budget.maxChars) {
      const next = s.shrink(list);
      if (typeof next !== 'string' || !next || next.length >= s.text.length) break;
      const before = chars(s.text);
      s.text = next;
      trimmed.push({
        section: s.name,
        action: 'shrink',
        reason: `超预算 ${budget.maxChars} 字符，该段按自身粒度收缩（保留高优先条目）`,
        beforeChars: before,
        afterChars: next.length,
        savedChars: before - next.length,
        ...(s.meta ? { meta: s.meta } : {})
      });
    }
  };
  // ① 通常先自收缩；DS 稳定历史显式延后到动态段丢弃之后。
  for (const s of [...list].sort((a, b) => b.priority - a.priority)) {
    if (typeof s.shrink !== 'function' || s.shrinkAfterDrop === true) continue;
    shrinkSection(s);
  }

  // ② 整段丢弃：从优先级最高（最不重要）的可丢段开始
  const droppable = list
    .filter((s) => s.droppable && chars(s.text) >= budget.minCharsToDrop)
    .sort((a, b) => b.priority - a.priority);
  for (const victim of droppable) {
    if (total() <= budget.maxChars) break;
    const i = list.indexOf(victim);
    if (i < 0) continue;
    const before = chars(victim.text);
    list.splice(i, 1);
    trimmed.push({
      section: victim.name,
      action: 'drop',
      reason: `超预算 ${budget.maxChars} 字符，按优先级 ${victim.priority} 整段丢弃`,
      beforeChars: before,
      afterChars: 0,
      savedChars: before,
      ...(victim.meta ? { meta: victim.meta } : {})
    });
  }

  for (const s of [...list].sort((a, b) => b.priority - a.priority)) {
    if (typeof s.shrink === 'function' && s.shrinkAfterDrop === true) shrinkSection(s);
  }

  // ③ 段内截尾：还超就截**优先级最低的可丢段**。
  //   ★ 2026-10-08（P2 修正）：原来这一刀**连不可丢段一起截**（注释里写着「含不可丢段，但会留痕」）。
  //   后果：`droppable:false` 的段（system 规则、人设卡、本次唤醒证据、会话身份、引导说明）
  //   在预算不够时会被**切掉尾巴** —— 也就是「必保段被截」，与段自己的 `droppable:false` 声明矛盾。
  //   现在 `droppable === false` 的段一律**不截**：超了就交给 ④ 如实报 `over-budget`。
  if (total() > budget.maxChars) {
    const byLowPriorityFirst = [...list]
      .filter((s) => s.droppable !== false)
      .sort((a, b) => b.priority - a.priority);
    for (const s of byLowPriorityFirst) {
      const over = total() - budget.maxChars;
      if (over <= 0) break;
      const keep = Math.max(0, chars(s.text) - over);
      if (keep >= chars(s.text)) continue;
      const before = chars(s.text);
      // 2026-11-01（溟）：按 UTF-16 码元截尾，正好切在 emoji 代理对中间时会留下孤立高位代理
      //   （\ud83d 这种），模型 API 那边 utf-8 编码直接 502（surrogates not allowed）。
      //   私聊 13:25 起连挂十轮的根因就是这里：预算紧 + 切点落在 emoji 上。
      let safeKeep = keep;
      const tailUnit = s.text.charCodeAt(safeKeep - 1);
      if (tailUnit >= 0xd800 && tailUnit <= 0xdbff) safeKeep -= 1;
      s.text = s.text.slice(0, safeKeep) + `\n…（本段已按预算截尾，省掉 ${before - safeKeep} 字）`;
      trimmed.push({
        section: s.name,
        action: 'truncate',
        reason: `超预算 ${budget.maxChars} 字符，按优先级 ${s.priority} 截尾`,
        beforeChars: before,
        afterChars: chars(s.text),
        savedChars: before - safeKeep,
        ...(s.meta ? { meta: s.meta } : {})
      });
    }
  }

  // ④ 裁到底仍然超预算 —— 这是**必须被看见**的硬超限（必保段一分不让，所以它一定还在）
  //   ★ 2026-10-08（P2）：原文写死「全部段均为必保内容」，P2 之后这句话可能不成立
  //   （可能还剩可丢段，只是它们已经不能再丢/不能再缩）⇒ 改成把**剩下的段逐条点名**，
  //   并区分「必保」与「可丢但已到极限」，这样"被丢了什么"才是可读的答案而不是一句套话。
  const finalTotal = total();
  if (finalTotal > budget.maxChars) {
    const survivors = [...list]
      .sort((a, b) => b.priority - a.priority)
      .map((s) => ({ section: s.name, priority: s.priority, chars: chars(s.text), required: s.droppable === false }));
    trimmed.push({
      section: '*',
      action: 'over-budget',
      reason: `裁剪到底仍超预算 ${finalTotal - budget.maxChars} 字符；必保段（droppable:false）一律不截，`
        + `需调用方放宽 maxChars 或减少必保段。剩余段：`
        + survivors.map((s) => `${s.section}(${s.chars}${s.required ? '，必保' : '，可丢但已到极限'})`).join('、'),
      beforeChars: finalTotal,
      afterChars: finalTotal,
      savedChars: 0,
      survivors,
      requiredChars: survivors.filter((s) => s.required).reduce((n, s) => n + s.chars, 0)
    });
  }

  diagnostics.trimmed = (diagnostics.trimmed || []).concat(trimmed);
  diagnostics.chars = finalTotal;
  diagnostics.budget = budget;
  // P2：把「必保 / 可丢」的字符账一并留下（`chars` 仍是用户段总数，行为不变）
  diagnostics.requiredChars = list.filter((s) => s.droppable === false).reduce((n, s) => n + chars(s.text), 0);
  diagnostics.droppableChars = list.filter((s) => s.droppable !== false).reduce((n, s) => n + chars(s.text), 0);
  return list;
}

/* ═══════════════════════════════════════════════════════════════════════
 * P2「完整请求预算」：从「用户段预算」升级成「**整份请求**预算」
 *
 * 起点事实（2026-10-08 读码确认，不是推测）：
 *   · `applyBudget()` 只看得见 `sections`（用户段）；system 段与工具 schema **不在预算内**。
 *   · system 段在 `prompt/index.js` 里先拼好再与裁剪后的用户段一起进 messages。
 *   · 工具 schema 由 M10（act）拼、经 `chatCompletion({messages, tools})` 上线，prompt 层根本没见过。
 * ⇒ 所以「整份请求」的账只能在这两个地方合起来记：
 *   本文件记 **组包期**的账（system + 工具 schema + 用户段），`llm/request-budget.js` 记**上线前**的账（真 body）。
 * ═══════════════════════════════════════════════════════════════════════ */

/** 工具 schema 的字符数：按**真的会被 JSON 序列化上去**的形状算，不按对象键数糊弄。 */
export function toolSchemaChars(tools) {
  if (tools == null) return 0;
  if (typeof tools === 'string') return tools.length;
  try {
    const text = JSON.stringify(tools);
    return typeof text === 'string' ? text.length : 0;
  } catch {
    return 0;
  }
}

/**
 * 整份请求的计量（**组包期**：system + tools + 用户段）。
 *
 * @param {object} p
 * @param {string} [p.system]     system 段正文（必保）
 * @param {*}      [p.tools]      工具 schema（必保；string 或对象皆可）
 * @param {string} [p.userText]   裁剪后的用户段正文
 * @param {Array}  [p.sections]   用户段（可选；给了就算必保/可丢的分账）
 * @returns {{systemChars:number, toolSchemaChars:number, userChars:number, totalChars:number,
 *            requiredChars:number, droppableChars:number, requiredParts:Array}}
 */
export function measureRequest(p = {}) {
  const systemChars = chars(p.system);
  const schemaChars = toolSchemaChars(p.tools);
  const userChars = typeof p.userText === 'string'
    ? p.userText.length
    : (Array.isArray(p.sections) ? p.sections.reduce((n, s) => n + chars(s?.text), 0) : 0);
  const sections = Array.isArray(p.sections) ? p.sections : [];
  const requiredParts = [
    { part: 'system', chars: systemChars, required: true },
    { part: 'tools', chars: schemaChars, required: true },
    ...sections.map((s) => ({ part: String(s?.name ?? '?'), chars: chars(s?.text), required: s?.droppable === false }))
  ];
  const requiredChars = requiredParts.filter((x) => x.required).reduce((n, x) => n + x.chars, 0);
  return {
    systemChars,
    toolSchemaChars: schemaChars,
    userChars,
    totalChars: systemChars + schemaChars + userChars,
    requiredChars,
    // `droppableChars` 是**可丢段正文之和**（不含段间分隔符）；`userChars − droppableChars`
    // 才是"必保段 + 分隔符"，两者差值就是分隔符，别拿它们互相验。
    droppableChars: sections.filter((s) => s?.droppable !== false).reduce((n, s) => n + chars(s?.text), 0),
    separatorChars: Math.max(0, userChars - sections.reduce((n, s) => n + chars(s?.text), 0)),
    requiredParts
  };
}

/**
 * 组包期的一站式入口：先按 `maxChars` 裁用户段，再用**整份请求**口径复核一遍并留痕。
 *
 * 与 `applyBudget` 的差别只有两点：① system 与 tools 计入总量；② `maxTotalChars` 这道闸。
 * **裁剪行为本身不变**（还是只动可丢段），所以老调用方拿到的 `messages` 与以前一致。
 *
 * @returns {{sections:Array, measurement:object, over:boolean}}
 */
export function applyRequestBudget({ sections = [], system = '', tools = null, budget, diagnostics = {} } = {}) {
  const b = mergeBudget(budget);
  const kept = applyBudget(sections, b, diagnostics);
  // 用户段正文**带段间分隔符**（index.js 就是这么 join 的）⇒ 计量必须用同一个字符串，
  // 否则「测出来的」和「真发出去的」会差掉若干个 \n\n（实测 3 段就差 6 字）。数字对不上就不叫计量。
  const userText = kept.map((s) => s.text).join('\n\n');
  const measurement = measureRequest({ system, tools, userText, sections: kept });
  const limit = Number(b.maxTotalChars) > 0 ? Number(b.maxTotalChars) : null;

  if (limit !== null && measurement.totalChars > limit) {
    const overflow = measurement.totalChars - limit;
    diagnostics.trimmed = (diagnostics.trimmed || []).concat([{
      section: '*',
      action: 'request-over-budget',
      reason: `整份请求（system ${measurement.systemChars} + tools ${measurement.toolSchemaChars} + 用户段 ${measurement.userChars}）`
        + `= ${measurement.totalChars} 字符，超 ${limit} 共 ${overflow} 字符；`
        + `必保部分 ${measurement.requiredChars} 字符**一分未截**，缺口全部记在这里`,
      beforeChars: measurement.totalChars,
      afterChars: measurement.totalChars,
      savedChars: 0,
      overflowChars: overflow,
      requiredChars: measurement.requiredChars,
      requiredParts: measurement.requiredParts.filter((x) => x.required)
    }]);
  }
  diagnostics.request = { ...measurement, maxChars: b.maxChars, maxTotalChars: limit, overflowChars: limit === null ? 0 : Math.max(0, measurement.totalChars - limit) };
  return { sections: kept, measurement, userText, over: limit !== null && measurement.totalChars > limit };
}

/**
 * 工具结果追加后的**复查**（验收 3）。
 *
 * 为什么必须复查：预算只在组包那一刻核过一次；一轮里模型可能连着调好几个工具，
 * 每次返回都追加进 messages ⇒ **总量会在核过之后继续长**。不复查就等于没核。
 *
 * 纯函数、只读：不改 messages、不裁任何东西，只回答「现在超没超、超多少、要砍谁」。
 * 调用方（orchestrator/compose 侧）拿 `report.plan` 决定砍哪一段。
 *
 * @param {object} p
 * @param {Array<{role:string, content:any}>} p.messages 追加工具结果**之后**的完整消息数组
 * @param {*}      [p.tools]      工具 schema
 * @param {object} [p.budget]     覆盖 DEFAULT_BUDGET（`maxTotalChars` 才是这道闸）
 * @returns {{totalChars:number, limit:number|null, over:boolean, overflowChars:number,
 *            systemChars:number, toolSchemaChars:number, userChars:number,
 *            growthSinceFirstCheck:number, plan:Array}}
 */
export function recheckAfterToolResults({ messages = [], tools = null, budget = null } = {}) {
  const b = mergeBudget(budget);
  const limit = Number(b.maxTotalChars) > 0 ? Number(b.maxTotalChars) : null;
  let systemChars = 0;
  let userChars = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    const n = typeof m?.content === 'string' ? m.content.length : toolSchemaChars(m?.content);
    if (m?.role === 'system') systemChars += n;
    else userChars += n;
  }
  const schemaChars = toolSchemaChars(tools);
  const totalChars = systemChars + schemaChars + userChars;
  const overflowChars = limit === null ? 0 : Math.max(0, totalChars - limit);
  // 「要砍谁」：只给**非 system** 的候选（system 是必保，砍它就是本末倒置）
  const plan = limit === null || overflowChars <= 0 ? [] : (Array.isArray(messages) ? messages : [])
    .map((m, i) => ({ index: i, role: String(m?.role ?? ''), chars: typeof m?.content === 'string' ? m.content.length : toolSchemaChars(m?.content) }))
    .filter((m) => m.role !== 'system')
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 5);
  return {
    totalChars, limit, over: overflowChars > 0, overflowChars,
    systemChars, toolSchemaChars: schemaChars, userChars,
    plan
  };
}

/**
 * 前缀稳定性（验收 4）：可缓存的前缀 = **system 段 + 工具 schema**。
 * 同一会话连续两次请求，只要这两块字节不变，前缀就还能命中缓存。
 *
 * ⚠ 本函数**只报告**，不修：真正的不稳定源（例如 volatile 的 `styleHint` 混进了 system 段）
 * 要由组装层自己决定挪不挪，本层不越权改别人的拼装顺序。
 *
 * @returns {{prefixChars:number, stable:boolean, fingerprint:string, systemChars:number, toolSchemaChars:number}}
 */
export function prefixFingerprint({ system = '', tools = null } = {}) {
  const sys = typeof system === 'string' ? system : '';
  const schema = toolSchemaChars(tools) ? safeJson(tools) : '';
  const head = `${sys}\u0000${schema}`;
  return {
    prefixChars: head.length,
    systemChars: sys.length,
    toolSchemaChars: schema.length,
    fingerprint: hash32(head),
    stable: true
  };
}

function safeJson(v) {
  try { const t = JSON.stringify(v); return typeof t === 'string' ? t : ''; } catch { return ''; }
}

/** 32 位 FNV-1a：只为「两次数值一样/不一样」这件事服务，不用于安全。 */
function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
