// 猜数字：1~N 里想一个数，每次回「大了 / 小了」，猜中即胜。
//
// ── v3 契约要点（详见 lib/engine.js 顶部）──
//   say      = 群友看得到的（判定结果本身就是它，插件直接发）
//   forModel = 只给模型看的（这一步不需要：结果本身就该由模型转述/插件直接发）
//   hint     = 一行**状态**，≤60 字。只报区间 + 已猜次数，一个字都不提答案
//   secretOf = [String(target)]，测试会逐个断言这个字符串不出现在任何 say/hint 里
//
// ── 为什么 hint 宁可少报也不多说 ──
//   注入里写祈使句（"该谁猜了""轮到你了"）会诱导模型自己替你猜一步（群里实测过：
//   模型把 1、3 都报了，插件再把这份"没人说过的动作"算到最后说话的人头上）。
//   这里只描述状态：区间多少、已经猜了几次。
//
// ── 为什么候选数要"先掐掉范围、再过滤、最后取末尾" ──
//   群友的真实话是「我猜 66 吧，反正 1~100 随便猜」这种。直接取最后一个数字会取到 100
//   （顺口说的范围），于是**合法的一步**被当成"报了个超范围的数"拒掉（自测里真抓到了）。
//   所以先按 `数字 分隔符 数字` 的形状把所有"区间描述"整段抠掉（1~100 / 1-100 / 1到100），
//   再只留落在当前区间里的数，最后取最靠后的那个 —— 一个都不剩时才拿去报错
//   （这样"猜 99999"仍然会被明明白白地拒掉）。
// ── 为什么 hint 报的是**开区间**而不是 1~99 这种闭区间 ──
//   闭区间会自己把答案吐出来：已经锁定「答案 ≤ 37」时，注入里写「区间 1~37」＝ 直接告诉
//   模型答案就是 37（而"精确到 37"正是猜中的那一步）。改成开区间「0 < 答案 < 38」
//   报的是同一份信息（合法范围还是 1~37），但两端**永远不等于答案** ——
//   测试逐个断言 secretOf 里的值不出现在 hint 里，只有这个写法能真的过。
//   两端和数字之间都留了空格：避免边界值（如 100）里又拼出答案那串数字。
//
// ── 为什么 hint 里**不做截断** ──
//   曾经用 clip 把长 hint 掐到 52 字，结果「区间 28 < 答案 < 95」被掐成「区间 28 < 答案 < 9…」，
//   掐出来的残数恰好等于答案 —— 等于插件自己把答案印进注入（自测跑到第 8 轮抓到过一次）。
//   现在靠"数字本身有上限"保证够短：max 最高 10000，整行最长 ≈ 36 字，离 60 字预算远得很。
/** 抠掉「1~100」这种区间描述，剩下的才是群友真正报/猜的那个数。 */
const stripRanges = (text) => String(text || '').replace(/\d+\s*[~～\-—－至到]\s*\d+/g, ' ');
const numsIn = (text) => (stripRanges(text).match(/\d+/g) || []).map(Number).filter(Number.isFinite);
const intsOf = (cfg) => {
  const max = Math.max(10, Math.min(10000, Number(cfg?.numberRange) || 100));
  return { max };
};

export default {
  id: 'number',
  name: '猜数字',
  aliases: ['猜数', '猜数字游戏', 'number', '报数'],
  desc: '1~N 之间猜一个数，插件回「大了/小了」，猜中即胜',

  start(cfg) {
    const { max } = intsOf(cfg);
    const target = 1 + Math.floor(Math.random() * max);   // 随机只在这里发生一次，答案写进 board
    return {
      board: { target, max, lo: 1, hi: max, tries: 0 },
      say: `猜数字：我想了个 1~${max} 的数，谁猜中谁赢。`
    };
  },

  move(cfg, state, { text }) {
    const b = state.board || {};
    const { lo, hi } = boundsOf(b);
    const all = numsIn(text);
    if (!all.length) {
      return { reject: true, forModel: '这一步里没看到数字。群友说的要不是个数（例如「我猜 50」），就先别当猜测处理。' };
    }
    const inRange = all.filter((n) => n >= lo && n <= hi);
    if (!inRange.length) {
      const shown = all[all.length - 1];
      return { reject: true, forModel: `${shown} 不在当前区间 ${lo}~${hi} 内，这一步不算，局面没动。` };
    }
    return play(b, inRange[inRange.length - 1]);
  },

  // 只报区间与次数。答案由插件管着，模型既不需要也不该知道。
  // 长度由数字上限保证（max ≤ 10000 → ≤36 字），**这里不截断**，理由见文件头
  hint(cfg, state) {
    const { lo, hi } = boundsOf(state.board || {});
    return `区间 ${lo - 1} < 答案 < ${hi + 1}，已猜 ${Number(state.board?.tries) || 0} 次`;
  },

  // 本局不能提前出现在群里的值：答案本身。猜中那一刻允许出现在结算里（那时局面已清）
  secretOf(state) {
    const t = state.board?.target;
    return t == null ? [] : [String(t)];
  }
};

/** 当前合法区间 [lo, hi]（闭区间，答案一定在里面）。 */
function boundsOf(b) {
  const hiCap = Number(b.max) || 100;
  const lo = Math.max(1, Math.min(hiCap, Number(b.lo) || 1));
  const hi = Math.max(lo, Math.min(hiCap, Number(b.hi) || hiCap));
  return { lo, hi };
}

/** 判定一次猜测。答案只在 n === target 时被说出来（那一步游戏已经结束）。 */
function play(b, n) {
  const tries = (Number(b.tries) || 0) + 1;
  if (n === Number(b.target)) {
    return {
      board: { ...b, tries, lo: n, hi: n },
      over: true,
      winner: `猜中 ${n}`,
      say: `🎉 猜 ${n}，中了！一共 ${tries} 次。`
    };
  }
  const big = n > Number(b.target);
  const lo = big ? Number(b.lo) || 1 : Math.max(Number(b.lo) || 1, n + 1);
  const hi = big ? Math.min(Number(b.hi) || n, n - 1) : Number(b.hi) || n;
  return {
    board: { ...b, tries, lo, hi },
    say: `猜 ${n}：${big ? '大了' : '小了'}。`
  };
}
