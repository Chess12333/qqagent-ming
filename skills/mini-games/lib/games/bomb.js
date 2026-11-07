// 数字炸弹：1~N 里埋一个炸弹，群友轮流报数收窄区间，**谁报到谁输**
// （和猜数字正好相反：猜中输，猜偏了反而安全）。
//
// ── 为什么区间只会收窄、永远不会死局 ──
//   报的数比炸弹小 → 新区间 (n, hi]；比炸弹大 → 新区间 [lo, n)。
//   这条规则保证不变式 `lo ≤ 炸弹 ≤ hi` 永远成立，所以区间里**永远至少有一个合法数**，
//   不会出现"没有任何数能报"的死局；报区间外的数直接 reject，局面一点都不动。
//
// ── 为什么炸弹不让模型掺和 ──
//   炸弹由 start 用 Math.random 摇出来**写进 board**，判定只看 n === bomb。
//   模型既不知道也不用知道炸弹是几（hint 里只有区间），它只负责把群友原话传进来。
//
// ── 为什么不强制轮流 ──
//   player 可能是 null（认不出是谁），硬性"不能连着同一个人报"会把局面卡死。
//   收窄本身就防重复：报过的数一定落到区间外，会被 reject 掉。
//
// ── 为什么 hint 报的是**开区间**而不是 1~99 这种闭区间 ──
//   闭区间会自己把炸弹吐出来：已经锁定「炸弹 ≤ 37」时，注入里写「区间 1~37」＝ 直接告诉
//   模型炸弹就是 37（而"精确到 37"正是踩雷的那一步）。改成开区间「0 < 答案 < 38」
//   报的是同一份信息（能报的还是 1~37），但两端**永远不等于炸弹** ——
//   测试逐个断言 secretOf 里的值不出现在 hint 里，只有这个写法能真的过。
//   两端和数字之间都留了空格：避免边界值（如 100）里又拼出炸弹那串数字。
//
// ── v3 契约要点 ──
//   say      = 群友看得到的（报了什么 + 安全/炸了 + 新区间）
//   hint     = 一行状态：当前区间 + 已报几次（不写"该谁报"）
//   secretOf = [String(bomb)]，测试会逐个断言它不出现在任何 say/hint 里
//
// ── 为什么候选数要"先掐掉范围、再过滤、最后取末尾" ──
//   群友的真实话是「我报 66 吧，反正 1~100 随便报」这种。直接取最后一个数字会取到 100
//   （顺口说的范围），于是**合法的一步**被当成"报了个区间外的数"拒掉（自测里真抓到了）。
//   所以先按 `数字 分隔符 数字` 的形状把"区间描述"整段抠掉（1~100 / 1-100 / 1到100），
//   再只留落在当前区间里的数，最后取最靠后的那个 —— 一个都不剩时才拿去报错。
//
// ── 为什么 hint 里**不做截断** ──
//   曾经用 clip 把长 hint 掐到 52 字，结果「区间 28 < 答案 < 95」被掐成「区间 28 < 答案 < 9…」，
//   掐出来的残数恰好等于炸弹 —— 等于插件自己把答案印进注入（猜数字那边自测抓到过一次）。
//   现在靠"数字本身有上限"保证够短：max 最高 10000，整行最长 ≈40 字，离 60 字预算远得很。
const nick = (p) => String(p?.name ?? '').trim() || '这位';
/** 抠掉「1~100」这种区间描述，剩下的才是群友真正报的那个数。 */
const stripRanges = (text) => String(text || '').replace(/\d+\s*[~～\-—－至到]\s*\d+/g, ' ');
const numsIn = (text) => (stripRanges(text).match(/\d+/g) || []).map(Number).filter(Number.isFinite);

/** 当前合法区间 [lo, hi]（闭区间，炸弹一定在里面）。 */
function boundsOf(b) {
  const hiCap = Number(b.max) || 100;
  const lo = Math.max(1, Math.min(hiCap, Number(b.lo) || 1));
  const hi = Math.max(lo, Math.min(hiCap, Number(b.hi) || hiCap));
  return { lo, hi };
}

export default {
  id: 'bomb',
  name: '数字炸弹',
  aliases: ['炸弹', '埋雷', 'bomb', '踩雷', '数字雷'],
  desc: '1~N 里埋了炸弹，轮流报数收窄范围，谁报到谁输',

  start(cfg) {
    const max = Math.max(10, Math.min(10000, Number(cfg?.numberRange) || 100));
    const bomb = 1 + Math.floor(Math.random() * max);   // 随机只在这里发生，炸弹写进 board
    return {
      board: { bomb, max, lo: 1, hi: max, tries: 0 },
      say: `数字炸弹：1~${max} 里我埋了个炸弹，轮流报数，谁报到谁输。`
    };
  },

  move(cfg, state, { text, player }) {
    const b = state.board || {};
    const { lo, hi } = boundsOf(b);
    const name = nick(player);

    const all = numsIn(text);
    if (!all.length) {
      return { reject: true, forModel: '这一步里没看到数字。群友说的要不是个数（例如「我报 38」），先别当报数处理。' };
    }
    // 和猜数字同样的理由：顺口说的范围（"1~100"）不该被当成报数 —— 先只留区间内的数
    const inRange = all.filter((n) => n >= lo && n <= hi);
    if (!inRange.length) {
      const shown = all[all.length - 1];
      return { reject: true, forModel: `${shown} 不在当前区间 ${lo}~${hi} 内，这一步不算，局面没动。` };
    }
    const n = inRange[inRange.length - 1];
    const tries = (Number(b.tries) || 0) + 1;

    if (n === Number(b.bomb)) {
      return {
        board: { ...b, tries, last: n },
        over: true,
        winner: name,
        say: `💥 ${name} 报 ${n} —— 炸了！就是它。`
      };
    }
    const low = n < Number(b.bomb);       // 比炸弹小 → 区间收到 (n, hi]
    const nlo = low ? Math.max(lo, n + 1) : lo;
    const nhi = low ? hi : Math.min(hi, n - 1);
    return {
      board: { ...b, tries, last: n, lo: nlo, hi: nhi },
      say: `${name} 报 ${n}：安全，范围 ${nlo}~${nhi}。`
    };
  },

  // 只报区间。炸弹由插件管着，模型既不需要也不该知道。
  // 长度由数字上限保证（max ≤ 10000），**这里不截断**，理由见文件头
  hint(cfg, state) {
    const b = state.board || {};
    const { lo, hi } = boundsOf(b);
    return `1~${Number(b.max) || hi} 埋着炸弹，${lo - 1} < 答案 < ${hi + 1}，已报 ${Number(b.tries) || 0} 次`;
  },

  // 本局不能提前出现在群里的值：炸弹位置。炸的那一刻才允许说（那时局面已清）
  secretOf(state) {
    const bomb = state.board?.bomb;
    return bomb == null ? [] : [String(bomb)];
  }
};
