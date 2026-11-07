/**
 * M9 jev · 角色表（阶段 D 的**候选信号**分类，不是闸门）
 *
 * 依据 refactor/README.md §1（D 行「Jev 只给候选信号」）§0.5（决定权唯一）
 * + docs/让QQ-Agent更像人-整体重构与后续优化方案-20260927.txt 第六节：
 *   「角色精简：只保留互不重叠且每个都能说明后果的角色。多个近义 gate 串行会叠加漏判。」
 *
 * ★ 每个角色**必须**写 `callSite`（唯一调用点）与 `callSite.status`：
 *     `bound`   = 调用点此刻就在 `refactor/modules/<module>/` 里（selftest 实扫，扫不到就红灯）；
 *     `pending` = 目标模块还没接上（第 2 批邻居在建），selftest 如实登记、不判红。
 *   ⇒ 想把 pending 改成 bound，必须**真的**有人在代码里调它 —— 这就是防止现版
 *     topicContinuityGate / stickerPickGate / imageRelevanceGate 三个死角色复发的闸。
 * ★ `layer` = 属于 09-27 第六节的哪一层。**同一层不许有两个标签集相同的角色**
 *   （那正是「近义 gate 串行叠加漏判」的形态）。
 * ★ 这里**没有** enabled/disabled 开关字段：角色存在 ⇔ 有调用点；没有调用点的角色不许进表。
 *   （旧版 `favorJudge.enabled` 恒 null 那种「配了没人调」在新表里无处安放。）
 */

/** 所有角色共用的「弃权」标签；它**不许**出现在任何角色的 labels 里（见 selftest 断言）。 */
export const ABSTAIN_LABEL = 'abstain';

/**
 * **退役名单**（裁定 1 / 裁定 5 的靶子；selftest ②-e 逐条断言，不靠人工看名单）。
 * 依据指挥位对生产账本的实测（10,612 条观测 / 6 天，只取聚合数字）：
 *   `topicContinuityGate` / `stickerPickGate` / `imageRelevanceGate`
 *     —— 有定义、**全仓零调用点**，配置里却开着 = 三个死角色。
 *   `favorJudge`
 *     —— `localJev.favorJudge.enabled: true`，但链路被写死成空
 *        （`src/orchestrator.js:4433-4439` 的 `let result = null` + `:52` 的 `JEV_FAVOR_WRITES_ENABLED = false`）
 *        ⇒ 账本里 98 条 favorJudge 全在 10-01 之前，10-02 起一条没有：**配置在说谎**。
 * ★ 这些 id 永远不许回到 `ROLES`。要复活必须有**真实调用点 + 真实触发率**，照新表的规矩走。
 */
export const LEGACY_RETIRED_IDS = [
  'topicContinuityGate',
  'stickerPickGate',
  'imageRelevanceGate',
  'favorJudge',
];

export const ROLES = {
  // ── 自由插话层（09-27 第六节的第三层）────────────────────────────────
  // 前身 `replyChanceGate`：旧账本 6 天 351 次调用 = 全部 Jev 量的 3.3% —— 它是**真正决定
  // 「要不要主动开口」的那一个**，却被 wiki/记忆/图片提示类判定（64%）淹在账本里看不见。
  // ⚠️ 与 M8 现有的「意愿 + 概率」逻辑可能本来就重叠（指挥位裁定 1）：装配验收时 M8 没明确要它 ⇒
  //   **按重复删除**，不强行接线。
  interjectWorth: {
    id: 'interjectWorth',
    cn: '这轮值得凑上去接一句吗',
    question: '没有人点你的名字，你自己想凑一句 —— 这一轮凑上去值不值得？',
    labels: ['worth', 'not'],
    positive: 'worth',
    layer: '自由插话',
    scene: '自由插话层：群里有人在聊，你没被 @、不是在追问你、也没有未完成的承诺。',
    consequence: '采「worth」→ 你主动发言（可能插进别人的话）；采「not」→ 这一轮沉默。',
    // 高风险方向是「不该插的时候插了」，所以门槛比别的角色高。
    budgetMs: 2000,
    minP: 0.6,
    minMargin: 0.15,
    inputMaxChars: 400,
    callSite: {
      module: 'plan',
      status: 'pending', // 装配验收时仍无调用点 ⇒ 删（裁定 1）
      where: 'M8 plan `decide()` 的自由插话层分支（§1 C→D：plan 决定 action，jev 只给候选）',
      patterns: ['@jev:interjectWorth', "ask('interjectWorth'", 'ask("interjectWorth"'],
    },
    examples: [
      { input: '群友A：昨晚那局太坑了\n群友B：我以为你会奶我啊', label: 'worth' },
      { input: '群友A：在吗\n群友B：在在', label: 'not' },
    ],
  },

  // ── 话题跟进层（09-27 第六节的第二层）───────────────────────────────
  // ⚠️ 前身 `topicContinuityGate` 正是旧账本里**三个死角色之一**（有定义、全仓零调用点）⇒
  //   它进新树的唯一理由是 M8 真的会调它；装配验收时接线不存在 ⇒ 直接删（裁定 1），不许"先挂着"。
  //   另一条前置：09-27 第六节要求「高置信延续不能每轮再过一遍无关的随机插话闸」——
  //   这条角色存在的意义就是让话题跟进层**少过一道闸**，不是多加一道。
  topicShift: {
    id: 'topicShift',
    cn: '这句是延续当前话题，还是已经换题了',
    question: '你刚在这个话题里说过话 —— 新来的这句是在接着聊，还是已经翻篇了？',
    labels: ['follow', 'shift'],
    positive: 'follow',
    layer: '话题跟进',
    scene: '话题跟进层：`botSaidBefore` 里有你最近的发言，且这条新消息没 @ 你。',
    consequence: '采「follow」→ 继续跟聊（不再另过一次插话闸）；采「shift」→ 停止跟聊。'
      + '⚠️ 这个信号**覆盖不了**直接 @ / 明确提问 / 未完成承诺：那三条由 M8 的硬规则直接 reply，不经过 jev。',
    budgetMs: 2000,
    minP: 0.6,
    minMargin: 0.15,
    inputMaxChars: 500,
    callSite: {
      module: 'plan',
      status: 'pending', // 装配验收时仍无调用点 ⇒ 删（裁定 1）
      where: 'M8 plan `decide()` 的话题跟进层分支',
      patterns: ['@jev:topicShift', "ask('topicShift'", 'ask("topicShift"'],
    },
    examples: [
      { input: '（刚在说周末爬山）群友：那个索道要不要排队', label: 'follow' },
      { input: '（刚在说周末爬山）群友：谁把我文档删了', label: 'shift' },
    ],
  },

  // ── 检索意图（只影响要不要多查一次记忆，不发消息）────────────────────
  // 前身 `memoryRecallGate`：旧账本 6 天 2269 次 —— **有**真实触发率（不是死角色），但它属于
  // 那 64%「用户看不见的地方」的隐形开销。留下的理由是它最便宜（最多白查一次记忆，不发一句话）；
  // 装配验收时若按"隐形开销"整体收紧，这个是可以第一个砍的 —— 砍它就删这一行，不要改成默认关。
  recallAsk: {
    id: 'recallAsk',
    cn: '这句要不要翻长期记忆',
    question: '这句话里有没有指向过去、需要翻长期记忆才能接住的线索？',
    labels: ['recall', 'now'],
    positive: 'recall',
    layer: '检索',
    scene: '阶段 A/B 之间：词表和时间窗都没命中、但线索含糊（「上次」「你不是说过」「我那条还留着吗」）。',
    consequence: '采「recall」→ 多查一次长期记忆（更慢，不发任何消息）；采「now」→ 不查，就地回答。',
    // 低风险（最多白查一次），门槛放宽，省得频繁弃权。
    budgetMs: 1500,
    minP: 0.55,
    minMargin: 0.1,
    inputMaxChars: 300,
    callSite: {
      module: 'scenario',
      status: 'pending', // 装配验收时仍无调用点 ⇒ 删（裁定 1）
      where: 'M5 scenario 还原指代/时间线索处（A 阶段产出 MessageEvidence 时顺带判定）',
      patterns: ['@jev:recallAsk', "ask('recallAsk'", 'ask("recallAsk"'],
    },
    examples: [
      { input: '我上礼拜放你那儿的那本书呢', label: 'recall' },
      { input: '这周五几点开会', label: 'now' },
    ],
  },

  // ── 协议失败旁路（不是「回不回」的决定；话已经定了，只是怎么送）────────
  textOnlyJudge: {
    id: 'textOnlyJudge',
    cn: '这段正文是成品消息，还是内心戏',
    question: '你把话写进了正文 —— 这段是能直接发进群的成品消息，还是违规写下的内心旁白？',
    labels: ['say', 'skip'],
    positive: 'say',
    layer: '协议恢复',
    scene: '仅协议失败恢复旁路（M3 `salvage.js`），且调用方自己确认要用本地裁判时才问。'
      + '★ 不参与 §1 新链路的「回不回」决定 —— 那一轮早就在 C 决定过了，这里只决定「这段误写进正文的话要不要原样送出去」。',
    consequence: '采「say」→ 整段正文发进群（旁白泄漏就是这条路径）；采「skip」→ 这段丢掉。',
    // 实测（旧 JEV_ROLES 注释）：0.8B 15 条样本判错 7 条，方向是「旁白被判 say」。
    // 所以取**高门槛**，且判 say 之后仍过一道旁白正则否决（见 compat.js）。
    budgetMs: 3000,
    minP: 0.8,
    minMargin: 0.3,
    inputMaxChars: 420,
    callSite: {
      module: 'platform',
      status: 'bound',
      where: 'M3 `salvage.js` judgeTextOnly()（搬运层兼容面 `localJevHasRole` + `jevJudgeTextOnly`）',
      patterns: ["localJevHasRole('textOnlyJudge')", 'localJevHasRole("textOnlyJudge")', '@jev:textOnlyJudge'],
    },
    examples: [
      { input: '行 那我下班顺路帮你带一杯', label: 'say' },
      { input: '先正经回他的问题，顺手损一句', label: 'skip' },
    ],
  },

  unsentLinesJudge: {
    id: 'unsentLinesJudge',
    cn: '这一行草稿该发吗（逐行）',
    question: '这一行草稿单独看 —— 是该发给群友的成品，还是没写好的过程话？',
    labels: ['send', 'drop'],
    positive: 'send',
    layer: '协议恢复',
    scene: '仅协议失败恢复旁路（M3 `salvage.js`）：模型写了一堆行却没调工具，逐行挑。',
    consequence: '采「send」→ 这一行发出去；采「drop」→ 这一行被丢弃（写好的话可能就这么没了）。',
    // ★ 标签词与 textOnlyJudge 刻意不同（整段 vs 逐行是两道不同的题，共用一套词会让
    //   「同层近义 gate」看不出区别）；对外 compat 形状不变，仍是 `{ say: boolean }`。
    budgetMs: 2500,
    minP: 0.8,
    minMargin: 0.3,
    inputMaxChars: 200,
    callSite: {
      module: 'platform',
      status: 'bound',
      where: 'M3 `salvage.js` judgeUnsentLines()（搬运层兼容面 `localJevHasRole` + `jevSaySkipLine`）',
      patterns: ["localJevHasRole('unsentLinesJudge')", 'localJevHasRole("unsentLinesJudge")', '@jev:unsentLinesJudge'],
    },
    examples: [
      { input: '醒了 你那 UI 问题我改了', label: 'send' },
      { input: '（想想还是别接这句）', label: 'drop' },
    ],
  },
};

export const ROLE_IDS = Object.keys(ROLES);

/** 这个角色存在吗（拼错的角色 id 一律要被发现，不许静默当成「判过了」）。 */
export function hasRole(roleId) {
  return Object.prototype.hasOwnProperty.call(ROLES, String(roleId ?? ''));
}

export function roleOf(roleId) {
  return ROLES[String(roleId ?? '')] ?? null;
}
