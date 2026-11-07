// 24 点：开局给 4 个 1~13 的整数，用 + - * / 和括号、每个数各用一次，凑出 24。
//
// ── 为什么开局要暴力验一次有解 ──
// 随机四张牌里约四成凑不出 24。群里发一道无解的题，玩家会一直算下去、互相怀疑，这局直接废掉。
// 所以 start 里最多重抽 200 次，每次用 solve() 判定"能不能凑出 24"；200 次都没撞上有解的
// （概率极低），就退回一组**已知有解**的备用牌。
//
// ── 为什么答案从来不进 hint，也不进开场白 ──
// hint 是注入提示词的，注入 ≈ 群里看得到（模型会说漏嘴）。所以：
//   · hint 只写四个数字，一个字都不多；
//   · 参考答案只存在 board.solutions 里，由 secretOf 声明，只有"看答案"这一步和 reveal() 会读它；
//   · 开场白的"例如 (6+6)*(4-2)"**必须用本题没有的数字**：示例恰好等于答案时，那句"例如"
//     就是把答案念出来了 —— 实测过。
//
// ── 验算 ──
// ① 四个数都用且各用一次（按数字多重集合比对）② 只允许 + - * / 和括号
// ③ 结果等于 24（浮点误差 1e-6）。自写调度场 + 逆波兰解析，**不用 eval** ——
// eval 会让"只允许四则运算"形同虚设，玩家能往里塞任意 JS。
const TARGET = 24;
const EPS = 1e-6;

const clip = (s, n) => {
  const t = String(s || '');
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

/** 数字显示：整数不带小数点，小数最多 4 位 */
const fmt = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 10000) / 10000));

/** 投降 / 要参考答案的说法
 *  2026-09-29 修（严重）：原来 `/答案是|不会/` 句中任意位置命中就公布全部参考答案并结束——
 *  「不会吧」「答案是怎么想出来的」这类聊天会当场把局炸掉、答案全漏。
 *  现在整句必须是投降/要答案这个意图才算（「答案是什么」=明确要答案，仍然放行；
 *  「不会吧」的「吧」不在句尾白名单里 → 不算；算式里带「答案是」会被下面按算式正常验算）。 */
const GIVEUP = /^(?:我|我们|咱|咱们|真的|实在|是|唉|哎|哎呀)*[，,、]?\s*(?:看答案|公布答案|给答案|说答案|答案是[什么啥]?|不会|想不出|没思路|算不出|投降|放弃|认输)(?:了|呗|嘛|么|啊|呀|哦)?[!?。！？\s…]*$/;

export default {
  id: 'twentyfour',
  name: '24点',
  aliases: ['24', '24点', '二十四点', '算24', 'twentyfour'],
  desc: '给四个数，用 +-*/ 和括号各用一次凑出 24',

  start() {
    let cards = null;
    let sols = [];
    for (let tries = 0; tries < 200 && !cards; tries += 1) {
      const c = [0, 0, 0, 0].map(() => 1 + Math.floor(Math.random() * 13));
      const s = solve(c);
      if (s.length) { cards = c; sols = s; }
    }
    if (!cards) { cards = [4, 6, 1, 1]; sols = solve(cards); }   // 兜底：已知有解

    const list = cards.join(' ');
    return {
      board: { cards, solutions: sols.slice(0, 3) },
      say: `24 点开始：${list}，用 +-*/ 和括号凑 24，四个数各用一次。例如 ${pickDemo(cards)}。`,
      forModel: `这局的四个数是 ${list}（参考答案在插件里，别自己编）。`
        + '玩家报出算式后，把他的话原样交给 mini-games__game_move，由插件验算。'
    };
  },

  move(cfg, state, { text, player } = {}) {
    const b = state?.board || {};
    const cards = Array.isArray(b.cards) ? b.cards : [];
    const name = String(player?.name || '') || '这位';
    const raw = String(text || '').trim();
    const sol = (Array.isArray(b.solutions) ? b.solutions : []).map(String).filter(Boolean);

    // 「看答案 / 不会 / 投降」：答案只能从这里出来，而且是插件直发（不经过模型）
    if (GIVEUP.test(raw)) {
      return {
        board: { ...b, givenUp: true },
        over: true,
        winner: '',
        say: sol.length
          ? `这道 ${cards.join(' ')} 的参考答案：${sol.join('、')}。这局就到这里，想再来一局直接说。`
          : `这局没存下参考答案，${cards.join(' ')}。这局就到这里。`
      };
    }

    if (!raw) return { reject: true, forModel: '没听到算式。让玩家把算式原样发出来，例如 (3+3)*(5-1)。' };
    if (/[A-Za-z]/.test(raw)) return { reject: true, forModel: '算式中不能有字母，只能用 + - * / 和括号。' };

    const toks = tokenize(raw);
    if (!toks.length) return { reject: true, forModel: '没看出算式。只能用 + - * / 和括号，把算式原话传进来。' };
    if (toks.some((t) => t && t.bad)) {
      return { reject: true, forModel: `算式里有不认识的符号，只能用 + - * / 和括号（这局的数是 ${cards.join(' ')}）。` };
    }

    // 四个数各用一次：按多重集合比对，"用 3 3 3 3 顶替 3 4 5 6"这种要拦住
    const nums = toks.filter((t) => typeof t.num === 'number').map((t) => t.num);
    const used = [...nums].sort((x, y) => x - y);
    const want = [...cards].sort((x, y) => x - y);
    if (nums.length !== cards.length || used.some((v, i) => v !== want[i])) {
      return { reject: true, forModel: `必须用 ${cards.join(' ')} 这四个数、每个各用一次（这一步用的是 ${nums.join(' ') || '空'}）。` };
    }

    let v = null;
    try { v = evalRpn(toRpn(toks)); } catch { v = null; }
    if (v === null) return { reject: true, forModel: '式子没算出来（出现了除以 0 或者括号不配对），检查一下。' };
    if (Math.abs(v - TARGET) > EPS) {
      return { reject: true, forModel: `式子合法，但结果是 ${fmt(v)}，不是 24。再想想。` };
    }
    return {
      board: { ...b },
      over: true,
      winner: name,
      say: `🎉 ${name} 报出 ${raw}，等于 24，赢了！`
    };
  },

  /** 一行状态：只有四个数字。参考答案绝不出现（单行 ≤60，这里远低于预算） */
  hint(cfg, state) {
    const cards = Array.isArray(state?.board?.cards) ? state.board.cards : [];
    return clip(`数字 ${cards.join(' ')}｜用 +-*/ 和括号凑 24，每个数各用一次`, 60);
  },

  /** 本局不能提前进群的值：参考答案（可能多组） */
  secretOf(state) {
    const b = state?.board || {};
    if (b.over || b.givenUp) return [];
    return (Array.isArray(b.solutions) ? b.solutions : []).map(String);
  },

  /** 收摊揭晓：答案由插件原样发出 */
  reveal(cfg, state) {
    const b = state?.board || {};
    const cards = Array.isArray(b.cards) ? b.cards : [];
    const sol = (Array.isArray(b.solutions) ? b.solutions : []).map(String).filter(Boolean);
    return { over: true, say: `这题 ${cards.join(' ')} 的参考答案：${sol.join('、') || '（没存下来）'}` };
  }
};

/**
 * 开场白的"例如"：造一个合法算式，而且**一个数都不许是本题的牌**。
 * 示例里出现本题的数字、又恰好等于答案时，那句"例如"就是把答案念出来了 —— 实测过。
 *
 * 做法：拿 1~13 里"本题没有的数"填进几种固定形状，再用本项目自己的逆波兰解析**验一遍**
 * （既验证它只用了这些数、又验证它真的等于 24）。四张牌最多占掉四个数，这些形状里
 * 必然有一组能填出来。真到不了就退回固定示例（那个算式本身永远是 24）。
 */
function pickDemo(cards) {
  const have = new Set((Array.isArray(cards) ? cards : []).map(Number));
  const pool = [];
  for (let n = 1; n <= 13; n += 1) if (!have.has(n)) pool.push(n);
  const shapes = [
    (a, b, c) => `(${a}+${a})*(${b}-${c})`,
    (a, b, c) => `(${a}-${b})*(${c}+${c})`,
    (a, b, c) => `(${a}+${b})*(${c}+${c})`,
    (a, b, c) => `(${a}*${b})-${c}`,
    (a, b, c) => `(${a}*${b})+${c}`,
    (a, b) => `(${a}+${a})*${b}`,
    (a, b, c) => `(${a}+${a})*(${b}-${c - c})`
  ];
  for (const shape of shapes) {
    for (const a of pool) {
      for (const b of pool) {
        for (const c of pool) {
          const s = shape(a, b, c);
          const nums = (s.match(/\d+/g) || []).map(Number);
          if (nums.some((n) => have.has(n))) continue;      // 形状里出现本题的牌 → 换一组
          let v = null;
          try { v = evalRpn(toRpn(tokenize(s))); } catch { v = null; }
          if (v !== null && Math.abs(v - TARGET) < EPS) return s;
        }
      }
    }
  }
  return '(6+6)*(4-2)';
}

/** 把式子切成 token：数字（允许小数）、四则运算符、括号（半角/全角都认）；其它标 bad */
function tokenize(s) {
  const out = [];
  const re = /\s*(\d+(?:\.\d+)?|[+\-*/×÷()（）]|[^\s])/g;
  let m;
  while ((m = re.exec(String(s || '')))) {
    const t = m[1];
    if (/^\d/.test(t)) out.push({ num: Number(t) });
    else if ('+-*/'.includes(t)) out.push({ op: t });
    else if (t === '×') out.push({ op: '*' });
    else if (t === '÷') out.push({ op: '/' });
    else if (t === '(' || t === '（') out.push({ op: '(' });
    else if (t === ')' || t === '）') out.push({ op: ')' });
    else out.push({ bad: t });
  }
  return out;
}

/** 中缀 → 逆波兰（调度场），顺便查括号是否配对；不合法时 rpn 为 null */
function toRpn(toks) {
  const prec = { '+': 1, '-': 1, '*': 2, '/': 2 };
  const out = [];
  const ops = [];
  let prevValue = false;                       // 上一个是数字或右括号 = 这一步该是运算符
  for (const t of toks) {
    if (typeof t.num === 'number') {
      if (prevValue) return null;              // 两个数字挨着，例如 "3 3"
      out.push(t);
      prevValue = true;
      continue;
    }
    if (t.op === '(') { ops.push(t.op); prevValue = false; continue; }
    if (t.op === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') out.push({ op: ops.pop() });
      if (!ops.length) return null;            // 右括号多了
      ops.pop();
      prevValue = true;
      continue;
    }
    if (!prevValue) return null;               // 运算符打头，或连着两个运算符
    while (ops.length && ops[ops.length - 1] !== '(' && prec[ops[ops.length - 1]] >= prec[t.op]) {
      out.push({ op: ops.pop() });
    }
    ops.push(t.op);
    prevValue = false;
  }
  while (ops.length) {
    const o = ops.pop();
    if (o === '(') return null;                // 左括号没闭合
    out.push({ op: o });
  }
  return out.length ? out : null;
}

/** 算逆波兰；除以 0 / 式子不完整 → null */
function evalRpn(rpn) {
  if (!Array.isArray(rpn)) return null;
  const st = [];
  for (const t of rpn) {
    if (typeof t.num === 'number') { st.push(t.num); continue; }
    const b = st.pop();
    const a = st.pop();
    if (a === undefined || b === undefined) return null;
    if (t.op === '+') st.push(a + b);
    else if (t.op === '-') st.push(a - b);
    else if (t.op === '*') st.push(a * b);
    else {
      if (Math.abs(b) < 1e-9) return null;
      st.push(a / b);
    }
  }
  return st.length === 1 && Number.isFinite(st[0]) ? st[0] : null;
}

/** 去掉最外层多余括号：((6+6)*(4-2)) → (6+6)*(4-2) */
function tidy(s) {
  let t = String(s);
  for (let i = 0; i < 4; i += 1) {
    if (!(t.startsWith('(') && t.endsWith(')'))) break;
    let depth = 0;
    let wraps = true;
    for (let j = 0; j < t.length; j += 1) {
      if (t[j] === '(') depth += 1;
      else if (t[j] === ')') {
        depth -= 1;
        if (depth === 0 && j < t.length - 1) { wraps = false; break; }
      }
    }
    if (!wraps) break;
    t = t.slice(1, -1);
  }
  return t;
}

/** 从四个数递归试所有「取两个数做一次运算再放回」的组合，收集能凑出 24 的式子（最多 3 个） */
function solve(cards) {
  const found = [];
  const walk = (items) => {
    if (found.length >= 3) return;
    if (items.length === 1) {
      if (Math.abs(items[0].v - TARGET) < EPS) {
        const s = tidy(items[0].s);
        if (s && !found.includes(s)) found.push(s);
      }
      return;
    }
    for (let i = 0; i < items.length; i += 1) {
      for (let j = 0; j < items.length; j += 1) {
        if (i === j) continue;
        const a = items[i];
        const b = items[j];
        const rest = items.filter((_, k) => k !== i && k !== j);
        const cand = [
          { v: a.v + b.v, s: `(${a.s}+${b.s})` },
          { v: a.v - b.v, s: `(${a.s}-${b.s})` },
          { v: a.v * b.v, s: `(${a.s}*${b.s})` }
        ];
        if (Math.abs(b.v) > 1e-9) cand.push({ v: a.v / b.v, s: `(${a.s}/${b.s})` });
        for (const c of cand) {
          walk([...rest, c]);
          if (found.length >= 3) return;
        }
      }
    }
  };
  walk((Array.isArray(cards) ? cards : []).map((n) => ({ v: Number(n), s: String(n) })));
  return found;
}
