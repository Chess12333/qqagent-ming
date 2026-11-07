// 海龟汤：我出「汤面」，玩家只能问能用「是 / 不是」回答的问题，把「汤底」推出来。
//
// ── 这个游戏和前几个不一样：判定是**语义**的 ──
// "他是自杀的吗" 没法用正则判，必须有人拿着汤底去理解。所以分工是：
//   · **模型判**（它拿着汤底，见下面的 hint）：回「是/不是/无关/部分是」，玩家说通了就揭晓；
//   · **插件管四件事**：① 权威持有汤底（揭晓时**原样**发出，不会念错、不会改口）；
//     ② 记问答台账——每轮把"已经问过什么、当时怎么答的"注入提示词，防模型自相矛盾
//        （海龟汤最典型的崩法：「他死了吗」先答"不是"、三轮后答"是"）；
//     ③ 泄漏守卫（index.js 的 before-tool + after-response）：模型把汤底原文抄进发言时拦掉；
//     ④ 揭晓只走 mini-games__game_stop（reveal=true，答案由插件原样发）。
//
// ── 2026-09-22 群里实测的事故（已修，别再退回去）──
//   ① **say 里写着给模型的话，被原样发进了群**：
//      "第 1 问（X）：… → 现在回一个词：是 / 不是 / 无关 / 部分是；如果他其实猜到了整个汤底，
//       就调 mini-games__game_stop（reveal=true）揭晓。" —— 群友看到的是机器人对着自己念操作说明；
//      而且这条**永久留在群聊记录里**，每轮都重新计费、还教模型照着抄。
//      现在：move 的 say 是空的（**插件什么都不发**），那个「是/不是」由模型自己回；
//      给模型的话全部走 forModel（只出现在工具返回里）。
//   ② 「第 N 问（谁）：原话」这种记账回声也去掉：那句话群里刚说过，发出来纯属噪音。
//   ③ hint 以前 254 字（汤面 + 汤底 + 6 问台账 + 规则），现在只留"汤底 + 最近三问"，
//      规则与玩法在 skill.json 的静态片段里（跨运行缓存）。
//
// ── 题目从哪来 ──
// 默认用**内置题库**（下面 PUZZLES，六道经典）。理由：汤底必须由插件权威持有，
// 才能保证"揭晓时一字不差"和"跨轮一致"；只存在模型脑子里的题，玩到第三轮就飘了。
// 想玩新鲜的，mini-games__game_start 时可以带 puzzle/solution 让模型自己出题（设置 allowModelPuzzle 控制）。
//
// ── 判定为什么不用本地 Jev（实测否证，别再试一遍）──
// 本来打算把「汤底 + 问题 → 是/不是/无关」交给 18080 的 0.8B，好处是汤底不进主上下文。
// 实测不可用：三分类 10/18（常量基线"永远答是"= 7/18，且 IRRELEVANT 一次都没预测出来）；
// 二元 10/14（基线"永远答不是"= 7/14），答错的 4 条置信度全在 0.76~0.99。
// 它是台"一律答不是"的机器，游戏直接不成立。所以判定归模型，泄漏靠守卫兜。
// 顺带：0.4 版根本没有 src/local-jev.js，包内一个都不引用（compat 测试有硬断言守着）。

const PUZZLES = [
  {
    id: 'turtle-soup',
    title: '海龟汤',
    face: '一个男人走进海边的餐馆，点了一碗海龟汤。他喝了一口，放下勺子，结了账，回家自杀了。',
    solution: '多年前他和同伴在海难中漂流，食物吃光了。同伴说打到了一只海龟、煮了汤给他喝，他才活下来。'
      + '今天他喝到真正的海龟汤，发现味道完全不对——他这才明白，当年喝下的是同伴的肉，同伴把自己给了他。'
  },
  {
    id: 'half-match',
    title: '半根火柴',
    face: '沙漠正中间发现一具尸体，手里紧紧攥着半根火柴。周围没有脚印，也没有别的东西。',
    solution: '几个人乘热气球飞越沙漠，气囊漏气、不断下降，必须丢下一个人才能飞出去。'
      + '大家抽火柴决定谁跳——抽到半根的人跳了下去，攥着那半根火柴落在了沙漠里。'
  },
  {
    id: 'elevator',
    title: '电梯',
    face: '他住在二十楼。每天下班回家，他都坐电梯到十楼，再走楼梯上去。但下雨天，他会直接坐到二十楼。',
    solution: '他个子很矮，站在电梯里只够按到十楼的按钮。下雨天他手里有伞，可以用伞尖按到二十楼。'
  },
  {
    id: 'funeral',
    title: '葬礼上的男人',
    face: '一个女人的母亲去世了。葬礼上她遇到一个从没见过的男人，一见钟情。几天后，她杀死了自己的姐姐。',
    solution: '她想再见那个男人一面。她认为他还会出现在家人的葬礼上，于是杀掉姐姐，制造下一场葬礼。'
  },
  {
    id: 'weeds',
    title: '河里的水草',
    face: '一个男人跳河自杀了，尸体一直没找到。三年后，他妻子在河边钓鱼，钓上来一团水草。她看了一眼，回家也自杀了。',
    solution: '那不是水草，是丈夫的头发——他的尸体一直就在这片浅水里。她当年要是再找得仔细一点，本可以把他捞上来。'
  },
  {
    id: 'surgeon',
    title: '外科医生',
    face: '一个男人出了车祸，被送进医院。外科医生看了一眼说：「我不能给他做手术，他是我儿子。」',
    solution: '外科医生是他的母亲。'
  }
];

function pick(cfg, id) {
  const want = String(id || '').trim();
  if (want) {
    const hit = PUZZLES.find((p) => p.id === want || p.title === want);
    if (hit) return hit;
  }
  return PUZZLES[Math.floor(Math.random() * PUZZLES.length)];
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 台账一行：`问→答`，各自截断，避免 hint 超预算。 */
function ledgerLine(qa, n) {
  return (qa || []).slice(-n).map((x) => `${clip(x.q, 12)}→${clip(x.a, 6)}`).join('；');
}

export default {
  id: 'turtle',
  name: '海龟汤',
  aliases: ['汤', '海龟', '推理', '猜故事', '汤面'],
  desc: '我出汤面，你只能问「是/不是」类问题，把汤底推出来',
  /** 有隐藏答案的游戏：index.js 的泄漏守卫和 game_stop(reveal=true) 都靠这个标记 */
  hidden: true,
  library: PUZZLES,

  start(cfg, { puzzle = '', solution = '', title = '' } = {}) {
    const custom = String(solution || '').trim();
    let p;
    if (custom) {
      // 模型自带题目：汤底同样存进插件（揭晓时由插件原样发出）
      if (cfg.allowModelPuzzle === false) {
        return { reject: true, say: '设置里不允许自己出题，用内置题库吧（去掉 puzzle/solution 参数）。' };
      }
      p = {
        id: 'custom',
        title: String(title || '自定义').slice(0, 20),
        face: String(puzzle || '').trim() || '（模型没给汤面，让它补一句）',
        solution: custom.slice(0, 600),
        custom: true
      };
    } else {
      p = pick(cfg, puzzle);
    }
    return {
      board: { tid: p.id, title: p.title, face: p.face, solution: p.solution, custom: !!p.custom, qa: [], pending: null, count: 0 },
      // say = 群友看得到的（汤面 + 一句玩法）。玩法细节在静态片段里，这里不重复。
      say: `【海龟汤·${p.title}】\n${p.face}\n（只能问能用「是 / 不是」回答的问题，猜到了直接说汤底）`
    };
  },

  /**
   * 一步 = 玩家提问（或猜汤底）。
   * 这里**不判定**，只：
   *   ① 把上一问的答复从聊天记录里收回来记台账（模型上轮答了什么，存档里查得到）
   *   ② 把这一问挂成 pending，并告诉模型"该你答了"
   * **不发任何群消息**（say 为空）：那个「是 / 不是」由模型自己回，那才是群友该看到的。
   */
  move(cfg, state, { text, player, ctx }) {
    const b = state.board || {};
    const q = String(text || '').trim().slice(0, 60);
    if (!q) return { reject: true, forModel: '没收到玩家的话。把他说的问题原样传进来。' };

    // ① 结算上一问：取「那条提问之后、机器人自己说的第一句」当答案
    if (b.pending) {
      let answer = '';
      try {
        // 2026-09-30 修：limit 30 → 40，与引擎 grounding/playerOf 的窗口口径对齐——
        // 提问后涌入超 30 条消息会把机器人那句答复截出台账（误记「（没答）」）。
        const msgs = ctx?.store?.recent?.(ctx.chatKey, { limit: 40 }) || [];
        const after = msgs.filter((m) => Number(m.ts) >= Number(b.pending.at || 0));
        const mine = after.find((m) => m?.self && String(m.text || '').trim());
        if (mine) answer = String(mine.text).trim().slice(0, 20);
      } catch { /* 查不到就当没答 */ }
      b.qa = [...(b.qa || []), { q: b.pending.q, a: answer || '（没答）', by: b.pending.by || '' }].slice(-12);
    }
    b.pending = { q, at: Date.now(), by: player?.name || '' };
    b.count = (Number(b.count) || 0) + 1;

    const asked = (b.qa || []).length;
    return {
      board: b,
      say: '',                                    // 群里什么都不发（由模型回那一个词）
      forModel: `${player?.name || '某位'}问：${q}\n`
        + '只回「是 / 不是 / 无关 / 部分是」其中一个词，不解释、不补充、不暗示；'
        + '他要是把整个汤底说通了，就调 mini-games__game_stop（reveal=true）揭晓。'
        + (asked ? `（已答过 ${asked} 问，别和前面的答案打架。）` : '')
    };
  },

  /** 揭晓：由插件把汤底**原样**发出（模型只负责决定"该揭晓了"） */
  reveal(cfg, state) {
    const b = state.board || {};
    return {
      over: true,
      say: `【汤底·${b.title}】\n${b.solution}\n（一共问过 ${Number(b.count) || 0} 个问题）`
    };
  },

  /**
   * 这个游戏的**注入里必须带答案**（模型要拿汤底判「是/不是」）—— 契约里显式声明，
   * 测试据此只检查"群可见文本里不含汤底"，而不会误判注入。
   * 代价是模型可能说漏嘴：由 index.js 的两层泄漏守卫兜（抄整段才拦，正常回答不误伤）。
   */
  hintMayContainSecret: true,

  /** 结算前不能出现在群里的值（＝汤底）。 */
  secretOf(state) {
    return [String(state?.board?.solution || '')];
  },

  /**
   * 注入提示词的一行局面。**必须带汤底** —— 判定要靠它。
   * 预算 ≤150 字：汤底（必需）+ 最近 3 问台账 + 待答那一问；汤面/规则都不放（群里和静态片段里都有）。
   */
  hint(cfg, state) {
    const b = state.board || {};
    const qa = ledgerLine(b.qa, 3);
    return `汤底(绝不能说出去)：${b.solution}`
      + (qa ? `｜已问：${qa}` : '')
      + (b.pending ? `｜待答：${clip(b.pending.q, 16)}` : '');
  },

  /**
   * 给泄漏守卫用的"绝不能出现"的整段文本。
   * **这里不做长度判断** —— 多长的重合才算"抄"由 lib/leak.js 按长度自适应决定
   * （短汤底 n-2、下限 6；低于 6 字才放弃）。
   * 早先这里写过 `length >= 16` 的门槛，结果内置题库里的「外科医生」那道（10 字）
   * 完全没守卫 —— 随机抽到它就等于裸奔。门槛只能有一处，就在 leak.js。
   */
  spoilerOf(state) {
    return String(state?.board?.solution || '');
  }
};
