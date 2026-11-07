// 掷骰子比大小：每人一次 1~100，谁大谁赢；都掷完喊「开」结算。
//
// ── 2026-09-22 在群里修过的两个坑（别再退回去）──
//   ① 认人以前比 `r.name === name`（拿**名字**当身份）。而玩家认不出时名字是「这位」，
//      于是第二个人也被当成"已经掷过"当场拒掉；有人改昵称更糟。
//      现在：**优先 player.id（QQ 号）**，拿不到 id 才退回名字，两个都没有时**不做去重**
//      —— 宁可能多掷一次，也不能把真人挡在门外。
//   ② say 里曾经又报点数又报"目前最大"，hint 再写一遍，重复计费。现在 say 只报点数，
//      排名只在 hint 里一行。
//
// ── 谁算赢家 ──
//   开局的人（start 里的 player）也占一个位子：开始玩之前他**不用**再掷一次，
//   直接按插件摇好的点数算。这样"我开一局"之后不会出现"开局的人被关在门外"。
//
// ── v3 契约要点 ──
//   say      = 群友看得到的（点名 + 点数）
//   hint     = 一行状态：已掷几人 + 当前最大（不写"该谁掷""该谁开"）
//   secretOf = 空数组：这局**没有**隐藏值 —— 每个人的点数一掷出来就当着群里报了，
//             开局点数也在开场白里。真正要藏的是别的游戏（猜数字的答案、炸弹的位置）。
//
// 文件里**故意不 import 别的东西**：这个模块是被 engine.js 动态扫描加载的，
// 保持零依赖，单独复制/单独加载都不会因为缺文件而整块坏掉。
const clip = (s, n = 52) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
// 2026-09-29 修（严重）：原来**句中任意位置**有这些词就算「开」——「开饭了」「开始了」
// 这类闲聊会当场把局结掉；平局时 `reduce((a,x)=> x.n>a.n?x:a)` 还把并列最大的**第一个**记成唯一赢家。
// 现在：整句必须是"开/结算"这个意图才算（前缀口癖 + 句尾语气词放行，正文里夹带词不算）。
const OPEN_RE = /^(?:我|我们|咱|咱们|大家|都|来|一起|可以|那就)?\s*[，,、]?\s*(?:开|结算|揭晓|公布|比一下|比一比|结束|收摊|算了)(?:吧|了|呗|嘛|么|啊|呀|哦)?[!?。！？\s…]*$/;
const ROLL_RE = /(掷|摇|投|roll|骰)/i;
/** 播报的长相（和 engine.looksLikeOwnOutput 同源）：`甲 掷出 63 点。` 这种不是群友的动作。 */
const BROADCAST_RE = /^(?:\S+\s+)?掷出\s*\d+/;
const MAX_ROLL = 100;

/** 身份键：优先 QQ 号；没有就退回名字；都没有返回 ''（认不出人 → 不做去重）。 */
function whoKey(player) {
  const id = String(player?.id ?? '').trim();
  if (id) return `id:${id}`;
  const name = String(player?.name ?? '').trim();
  return name ? `name:${name}` : '';
}

const nickOf = (player) => String(player?.name ?? '').trim() || '这位';
const rollOnce = () => 1 + Math.floor(Math.random() * MAX_ROLL);

export default {
  id: 'dice',
  name: '掷骰子',
  aliases: ['骰子', '比大小', 'roll', 'd100', '掷骰'],
  desc: '每人掷一次 1~100 比大小，喊「开」时结算',

  start() {
    // ⚠️ 2026-09-22：**不替发起人预摇**。之前开局就替开的人摇了一次（"我先替 X 掷了 51 点"），
    // 那属于"机器人替玩家出牌"——和逢七过里模型自己报数是一类毛病（玩家没说过那一步，
    // 却被算成他的成绩）。现在谁想说「掷」谁掷，开局只报规则、空盘等第一个人。
    return {
      board: { rolls: [], size: MAX_ROLL },
      say: `掷骰子比大小：谁想说「掷」我就替他摇一次（1~${MAX_ROLL}），都掷完了喊「开」，点数最大的赢。`
    };
  },

  move(cfg, state, { text, player }) {
    const b = state.board || {};
    const rolls = Array.isArray(b.rolls) ? b.rolls : [];
    const name = nickOf(player);
    const raw = String(text || '').trim();

    // 先认「开」，再认「掷」：群友也可能把动作说成「我掷出了 63」，那仍然是一次掷，
    // 不该被下面的"播报过滤"吃掉（播报只在两个动作都不像时才判）。
    if (OPEN_RE.test(raw) && !ROLL_RE.test(raw)) {
      if (rolls.length < 2) {
        return { reject: true, forModel: `现在只有 ${rolls.length} 个人有分数，至少两个才能比大小。等别人掷。` };
      }
      const show = rolls.map((r) => `${r.name} ${r.n}`).join('、');
      const max = Math.max(...rolls.map((r) => r.n));
      const top = rolls.filter((r) => r.n === max);
      if (top.length > 1) {
        // 平局：并列最大的人都算平，不能只记第一个（原来就是这样，赢家记错）
        return {
          board: { ...b, rolls },
          over: true,
          winner: '平局',
          say: `结算：${show} —— ${top.map((r) => r.name).join('、')} 都是 ${max} 点、并列最大，平局。`
        };
      }
      return {
        board: { ...b, rolls },
        over: true,
        winner: top[0].name,
        say: `结算：${show} —— ${top[0].name} 的 ${max} 最大，赢。`
      };
    }

    if (ROLL_RE.test(raw)) {
      const key = whoKey(player);
      const dup = key ? rolls.find((r) => r.key === key && r.key !== '') : null;
      if (dup) {
        return { reject: true, forModel: `${name} 这一轮已经掷过了（${dup.n} 点）。他真要再掷得等下一局；别人掷不用管他。` };
      }
      const n = rollOnce();                   // 点数完全由插件决定，模型猜不到也改不了
      return { board: { ...b, rolls: [...rolls, { key, name, n }] }, say: `${name} 掷出 ${n} 点。` };
    }

    if (BROADCAST_RE.test(raw)) {
      return { reject: true, forModel: '这句像是插件/机器人自己的播报，不是群友要掷或要开，已忽略。' };
    }
    return {
      reject: true,
      forModel: `没看出这一步是「掷」还是「开」（原话：${raw.slice(0, 20)}）。群友说「掷」就掷一次，说「开」就按已有点数结算。`
    };
  },

  // 只报人数 + 当前最大。点数一掷出来群里就看见了，这里不是秘密
  hint(cfg, state) {
    const rolls = state.board?.rolls || [];
    if (!rolls.length) return clip('还没人有分数');
    const best = rolls.reduce((a, x) => (x.n > a.n ? x : a));
    return clip(`已掷 ${rolls.length} 人，当前最大 ${best.name} ${best.n}`);
  },

  // 这局没有隐藏值：每个人掷出多少当场就报给群里了
  secretOf() { return []; }
};
