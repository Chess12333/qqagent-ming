// 抽签 / 抓阄：开局给发起人抽一条任务签，群友说「抽」再抽一条给自己（每人每局上限 3 次），
// 说「抽个人」就从本局参与者里随机点一个（点中即结束）。
//
// ── v3 契约在这个游戏里的四条落点 ──
//   · say 只说群友看得到的（谁抽到什么、点中了谁）；给模型的说明全走 forModel。
//   · hint 只报「抽了几条/几个人/上限」，**绝不列签池**（没抽出来的签是隐藏值）。
//   · 未抽出的签由 secretOf 声明 —— hint 里列签池就等于把整池答案摊给模型。
//   · 随机只由插件摇（Math.random），摇完立刻写进 board：跨轮一致、可复查、可 JSON。
//     模型"摇"其实是编 —— 同一个请求给两次结果会不一样，群里当场对不上账。
//
// ── 为什么"抽过的签不再抽"（池子抽干净才重置）──
//   24 条签在多人局里必然撞，同局两人抽到同一条，群友立刻觉得是假的；顺带把"一局最多 24 次"也限住了。
//
// ── 为什么没有发起人时不预发签 ──
//   预发会往 board.draws 里塞一个**没人认领的"幽灵参与者"**（不是群里任何一个人），
//   后面「抽个人」就可能抽到一个根本没在这局里出现过的名字。认不出开局的人就只报规则，不发签。

/** 任务/惩罚签池：24 条，全部**能当场在群里做**（打字/发语音就行，不需要道具、不涉及隐私照） */
const TASKS = [
  '学猫叫三声',
  '下一句发言必须带「喵」',
  '模仿群里一个人说话，让大家猜是谁',
  '夸群里最近发言的人三句',
  '说一件你今天的糗事',
  '用方言打一句「我爱你」',
  '报出你的手机电量',
  '发一个你最常用的表情包',
  '讲一个冷笑话',
  '用一句话形容你今天的心情',
  '背一首古诗的前两句',
  '描述你今天吃的第一顿饭',
  '学一种动物叫',
  '接下来三条消息必须用问号结尾',
  '用一个字总结你这一周',
  '报出你现在穿的袜子颜色',
  '说一件你最近最后悔的小事',
  '给群里下一个人起个外号',
  '用三个词形容你的桌面',
  '说出你手机里第三个 App 的名字',
  '模仿一句你最讨厌的广告词',
  '说出你最拿手的一道菜的第一步',
  '三秒内说出一个和「鱼」有关的词',
  '用一个表情总结你的今天，再解释一句'
];

const MAX_PER = 3;

/** 长得像抽签、其实不是的词。必须**先**过这张黑名单，再看动作。 */
const NOT_DRAW = /抽象|抽风|抽烟|抽筋|抽搐|抽空|抽水|抽身|标签|签到|签名|抽奖池/;

/** 「抽个人」这一类的说法（比「抽」更具体，必须先在前面拦走）
 *  2026-09-29 修（严重）：原来句中任意位置命中就算——「随机点个外卖」会被当成点人、当场结束。
 *  现在整句必须是点人这个意图（前缀口癖 + 句尾语气词放行，正文里夹带词不算）。 */
const PICK_PERSON = /^(?:谁?来|我们?|咱们?|大家|都|来|我)?\s*[，,、]?\s*(?:抽(?:个|一)?人|抽谁|点(?:个|一)?人|点谁|抓一个|抓个人|随机点(?:个人|人|一个)?|抽个倒霉蛋)(?:吧|了|呗|嘛|么|啊|呀|哦)?[!?。！？\s…]*$/;

/** 收摊的说法：抽签没有输赢，靠这句话给这局一个结束点
 *  2026-09-29 修（严重）：原来句中任意位置命中就算——「我吃够了」会当场把局收掉。
 *  现在整句必须是收摊这个意图。 */
const STOP = /^(?:我|我们|咱|咱们|大家|都|来|行了|差不多)?\s*[，,、]?\s*(?:结束|收摊|不抽了|够了|散了|到此为止)(?:吧|了|呗|嘛|么|啊|呀|哦)?[!?。！？\s…]*$/;

/** 机器人自己那句播报的形状（同群多实例时会被当成"群友消息"喂回来）。本文件所有播报都以 🎲 开头。 */
const OWN_SAY = /^🎲|抽到[：:]/;

export default {
  id: 'draw',
  name: '抽签',
  aliases: ['抓阄', '抽奖', '抽一个', '签', 'draw'],
  desc: '抽一条当场能做的任务签（发起人开局先抽一条），说「抽」再抽给自己，说「抽个人」随机点人',
  library: TASKS,   // 签池（自检/维护用；引擎不读）

  start(cfg, { player } = {}) {
    // cfg.drawMode = 'person' 时开成"抽人局"（只点人，不发任务签）
    const mode = String(cfg?.drawMode || '').trim() === 'person' ? 'person' : 'task';
    const host = player && (player.id || player.name)
      ? { id: player.id ?? null, name: player.name || '这位' }
      : null;
    const board = { mode, host, draws: [], used: [], counts: {} };
    const tip = `说「抽」再抽一条，每人 ${MAX_PER} 次；说「抽个人」我随机点一个。`;
    // 抽人局 / 认不出发起人：不预发签（见文件头"幽灵参与者"那条）
    if (mode === 'person' || !host) return { board, say: `🎲 抽签开始：${tip}` };
    // 默认：先给发起人抽一条 —— 不然开局是空的，群里不知道接下来干什么
    const task = pick(TASKS);
    record(board, host, task);
    return { board, say: `🎲 ${host.name} 先抽到：${task}\n（${tip}）` };
  },

  move(cfg, state, { text, player }) {
    const b = state.board || {};
    const raw = String(text || '').trim();
    const name = player?.name || '这位';
    if (!raw) return { reject: true, forModel: '没收到玩家原话，把他说的话原样传进来。' };

    // 同群多实例时，别的实例发的播报会以"群友消息"的形式喂回来（引擎的前缀表认不出抽签的播报），
    // 自己再挡一道：播报不是一次抽签动作。判在所有分支之前 ——
    // 「🎲 甲 先抽到：…（说「抽」…说「抽个人」…）」里就带着「抽个人」三个字，放进来会被当成一次点人。
    if (OWN_SAY.test(raw)) {
      return { reject: true, forModel: '这句看着是机器人自己发的播报，不是群友说的话，这一步不算。' };
    }

    if (STOP.test(raw)) {
      return { board: b, over: true, say: `🎲 抽签收摊：这轮一共抽了 ${(b.draws || []).length} 条。` };
    }

    // 抽人：从**本局参与者**（发起人 + 抽过签的人）里随机点一个，点中即结束
    if (PICK_PERSON.test(raw)) {
      const people = participants(b);
      if (!people.length) {
        return { reject: true, forModel: '这局还没有参与者（开局的人没认出来、也没人抽过签），先等群友说「抽」抽一条，再点人。' };
      }
      const hit = people[Math.floor(Math.random() * people.length)];
      return {
        board: b,
        over: true, winner: hit.name,
        say: `🎲 抽中了：${hit.name}（从 ${people.length} 人里抽的）。`
      };
    }

    // 「抽象」「标签」「签到」「抽烟」这类词群里天天有人说，别当成抽签动作
    if (!looksDraw(raw)) {
      return { reject: true, forModel: '这一步不像抽签动作。群友说「抽」就传「抽」，说「抽个人」就传「抽个人」，说「收摊」结束。' };
    }

    // 2026-10-01（P1-A5）：id 空但有 name 时旧写法 `String(id ?? name)` 得到 ''（?? 对 '' 不生效）
    //   ⇒ 次数记不上还误报"拿不到身份"。对齐 memory.js:55：id 优先、空则退回 name；两边都空才拒（文案才真）。
    const key = String(player?.id ?? '') || String(player?.name ?? '');
    if (!key) return { reject: true, forModel: '这一步拿不到玩家身份（id 和 name 都空），没法记次数。' };
    const n = Number(b.counts?.[key]) || 0;
    if (n >= MAX_PER) {
      return { reject: true, forModel: `${name} 这局已经抽满 ${MAX_PER} 次了，局面不变；换个人抽，或者用「抽个人」点一个。` };
    }

    const used = Array.isArray(b.used) ? b.used : [];
    const rest = TASKS.filter((t) => !used.includes(t));
    const reset = rest.length === 0;      // 签池抽干净了才重置（重置后只记这一条）
    const task = pick(reset ? TASKS : rest);
    const nth = n + 1;
    const board = { ...b, draws: [...(b.draws || [])], used: reset ? [task] : [...used, task], counts: { ...(b.counts || {}) } };
    record(board, player, task);
    return {
      board,
      say: `🎲 ${name} 抽到：${task}${nth >= MAX_PER ? '（次数用完了）' : `（第 ${nth}/${MAX_PER} 次）`}`
    };
  },

  /** 收摊公布：把这轮抽出来的签列一遍（都是群里已经出现过的话，不泄漏任何没抽的签） */
  reveal(cfg, state) {
    const draws = Array.isArray(state?.board?.draws) ? state.board.draws : [];
    if (!draws.length) return { over: true, say: '这轮一条签都没抽出去。' };
    return { over: true, say: `这轮抽出的签（${draws.length} 条）：${draws.map((d) => `${d.name}：${d.task}`).join('；')}` };
  },

  // 一行局面：只报进度，**不列签池、也不列没抽出来的签**（那些是隐藏值）。≤60 字
  // （引擎注入时前面已经带了「抽签」，这里不再重复游戏名）
  hint(cfg, state) {
    const b = state.board || {};
    const drawn = (b.draws || []).length;
    const mode = b.mode === 'person' ? '抽人局：' : '';
    return `${mode}已抽 ${drawn} 条，${participants(b).length} 人参与，每人上限 ${MAX_PER} 次`;
  },

  /** 本局不能提前出现在群里的值：**还没抽出来的签**（抽出来的已经当众发过了，立刻从这里移出去）
   *  2026-09-29 修（严重）：签池抽干净会重置 `used`（只记重置后这一条），但**抽过的签早就当众念过了**——
   *  只看 `used` 会把它们重新算成"没抽出的签"，泄漏守卫去拦模型复述已经公开的签。
   *  判据改成"这局当众出过的"：`draws`（全程历史）∪ `used`（当前未重置部分）。 */
  secretOf(state) {
    const b = state?.board || {};
    const shown = new Set([
      ...(Array.isArray(b.draws) ? b.draws : []).map((d) => String(d?.task || '')),
      ...(Array.isArray(b.used) ? b.used : [])
    ]);
    return TASKS.filter((t) => !shown.has(t));
  }
};

/** 参与者 = 发起人 + 抽过签的人（按 id 优先、其次 name 去重） */
function participants(b) {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    const k = String(p?.id ?? '') || String(p?.name ?? '');   // A5：与 move/record 同一 key 口径
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ id: p?.id ?? null, name: p?.name || '这位' });
  };
  add(b.host);
  for (const d of (b.draws || [])) add(d);
  return out;
}

/** 纯随机取一条（随机性只在这里发生，结果随即写进 board） */
function pick(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * 这句是不是"抽一条"的动作。放在「抽人/收摊」判定**之后**用（那两种已在上面被拦走）。
 *
 * 为什么要分两步、还带一张黑名单：只写 /抽/ 的话，「抽象」「标签」「签到」「抽烟」
 * 全都会被当成抽签动作 —— 群里一定有人这么说话，模型会把原话原样传进来。
 * 长句也不认：「我今天抽空签了个到」这种整句不是动作，只有整句就是在说抽签才算。
 */
function looksDraw(raw) {
  const t = String(raw || '').trim();
  if (NOT_DRAW.test(t)) return false;
  if (/抽签|抓阄|抽奖|抽个签|来一发/.test(t)) return true;
  // 简说：「抽」「再抽一次」「我想抽一个」「抽我」—— 整句除了这几个动词就只剩语气词才算
  return /^[我俺想也要来给他再给]{0,3}(抽|摇|抓)(一)?(个|张|次|下|条|发)?[我他她自己]{0,2}[吧啊呀哦了]{0,2}$/.test(t);
}

/** 记一次抽签：draws 供"参与者"用，counts 用于次数上限 */
function record(board, player, task) {
  const name = player?.name || '这位';
  const key = String(player?.id ?? '') || String(player?.name ?? '');   // A5：与 move 同一 key 口径
  board.draws = [...(board.draws || []), { id: player?.id ?? null, name, task }];
  board.counts = { ...(board.counts || {}), [key]: (Number(board.counts?.[key]) || 0) + 1 };
  // ⚠️ 2026-09-22 修：这里以前**只写 draws/counts，忘了记进 used** —— 后果有两个：
  //   ① 同一局会抽到重复的签（文件头明说要避免"两个人抽到同一条"）；
  //   ② `secretOf`（未抽出的签）会把已经当众抽出来的签也算成"密值"，
  //      而它刚刚才在群里念过。开局预发的那条也走这里，所以开局就中招。
  board.used = [...new Set([...(board.used || []), task])];
}
