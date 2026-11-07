// 井字棋 3x3：发起人执 X 先落子，第二个人执 O，第三人插手 reject。三连结束、九格满平局。
//
// ── 为什么只让两个人玩 ──
// 三个人必然抢 X/O 两个记号，判定会自相矛盾（"谁赢了"没法回答）。第三人插手直接 reject：局面不动，
// 理由进 forModel。**群里不是不发消息，而是发一条节流过的短提示** —— 2026-10-01 改（C1）：
// 原来"一个字都不发"是为了防刷屏（这条理由仍然成立），但副作用是玩家报了格子却"没人理"，
// 落子误判（A1）因此完全不可见。现在由 index.js 的 noticeReject 统一发：同一局 60 秒最多一条，
// 且把给模型的长理由压成一句人话 —— 防刷屏的初衷没丢，只是不再静默。
//
// ── 为什么 say 里不写"该你了 / 传 game_move" ──
// say 是插件**直接发到群里**的，会永久留在聊天记录里、每轮重新计费，还会把模型教坏
// （实测它照着抄）。所以：给模型的话一律放 forModel；群里只说"谁落了哪一格"。
//
// ── 平局 ──
// 契约里 over 必须给 winner，所以平局用 winner:'平局' 占位；判"谁赢了"时必须先排除它。
//
// ── 没有隐藏信息 ──
// 棋盘是公开的，secretOf 明确返回 []（不是"忘了写"）。
const WIN_LINES = [
  [1, 2, 3], [4, 5, 6], [7, 8, 9],
  [1, 4, 7], [2, 5, 8], [3, 6, 9],
  [1, 5, 9], [3, 5, 7]
];

const clip = (s, n) => {
  const t = String(s || '');
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

/** 口癖 / 句读 / 方位词尾巴：剥完还剩实字，就说明这句根本不是落子话。 */
const NOT_PLACE = /[我你他她它们咱大家这那走去来是在个玩棋手打的号格位第排行边间角心\p{P}\p{S}\s]/gu;

/**
 * 这**是不是一句落子指令**（而不是"句子里恰好有个方位字"）。
 *
 * 2026-10-01 修（P0 · A1）：`dirPos()` 的兜底一直在整句里搜方位字，于是随口一句话就被当落子——
 *   「我下不了」→ 8 号格（T08）、「我在中国」→ 5 号格（T09）。
 * 判据（两关，都不依赖"这句话像不像人话"的猜测）：
 *   ① **有否定字就不算**（不/别/没/甭/无/否）——「我下不了」「不下」「别下」直接挡掉；
 *   ② **剥掉数字、方位字、口癖字之后必须空无一物**——「中国」剩下「国」、「马上」剩下「马」、
 *      「我上厕所」剩下「所」，都不是落子话。
 * 挡掉：我下不了 / 我在中国 / 不下了 / 不下 / 中国 / 马上 / 晚上 / 我上厕所
 * 放行：上排 / 下排 / 左边 / 中间 / 中心 / 右下 / 左上角 / 我在左上 / 我下中间
 * （只在**无数字**时启用 —— 带数字的句子仍走 parsePos 的 ①②③，那几支各有各的判据，不受这次改动影响。）
 */
function isPlacement(t) {
  const s = String(t || '');
  if (/(?:不|别|没|甭|无|否)/.test(s)) return false;
  const residue = s.replace(/\d+/gu, '').replace(/[上中下左右]/gu, '').replace(NOT_PLACE, '');
  return !residue;
}

/**
 * 方位词 → 格号（无数字时的原逻辑，独立成函数便于数字分支复用）。
 * 横竖都认：先在小窗口里找"行词+列词"，找不到再退化成"只说了上/左"，
 * 最后再退到"整句只有一个方位字"（上排 / 左边 / 中间）。
 *
 * 2026-09-30 的注释说"有意不搜『上』以免命中马上/晚上"，但那只对两字窗口成立 ——
 * 后面的词表和"单字方位"两支**一直在整句任意位置搜**，注释与实现是打架的。
 * 2026-10-01 起：无数字时先过 `isPlacement()`，注释与实现重新对齐（见上）。
 */
function dirPos(t) {
  if (!/\d/.test(t) && !isPlacement(t)) return 0;
  // 2026-10-01 修（#2e · 中下死条目）：词表里的 ['中下', 8] 一直是死值 —— 下面的两字窗口在
  //   「中下」上把两个「中」同时当行和列（r=1,c=1）恒返回 5，先于词表命中，玩家说「中下」
  //   会被误落到中心位。这里在窗口前先认「中下」= 8（词表原义）。连带：「我在中下」5→8（同
  //   因修复）、「上中下」2→8（边缘句式，窗口起点从"上中"移到整词）；「右中」仍是 5 ——
  //   #2c 已裁决删其表项，本批只修被点名的中下，不越权动它。
  if (t.includes('中下')) return 8;
  const rows = ['上', '中', '下'];
  const cols = ['左', '中', '右'];
  for (let i = 0; i < t.length; i += 1) {
    const w = t.slice(i, i + 2);
    const r = rows.findIndex((c) => w.includes(c));
    const c = cols.findIndex((x) => w.includes(x));
    if (r >= 0 && c >= 0) return r * 3 + c + 1;
  }
  if (/左上|上左/.test(t)) return 1;
  if (/右上|上右/.test(t)) return 3;
  if (/左下|下左/.test(t)) return 7;
  if (/右下|下右/.test(t)) return 9;
  // 2026-10-01 修（本批 ④）：删掉 `['右中', 6]` —— 死表项：含"右中"的句子在上面 :66-71 的
  //   两字窗口里一定先命中（窗口把「中」同时当行和列 ⇒ 恒返回 5），这张表的 6 永远走不到；
  //   死值留在词表里容易被后人当"右中=6"的真语义改坏。`['中下', 8]` 是同类死（窗口恒 5）
  //   但本批派单只点名右中 —— 中下保留原样、已记档上报（回执 §项4）。
  for (const [word, pos] of [['左上', 1], ['中上', 2], ['右上', 3], ['左中', 4], ['中间', 5],
    ['左下', 7], ['中下', 8], ['右下', 9], ['中心', 5]]) {
    if (t.includes(word)) return pos;
  }
  const row = rows.findIndex((x) => t.includes(x));
  const col = cols.findIndex((x) => t.includes(x));
  if (row >= 0) return row * 3 + 2;      // 只说「上排」= 上排中间
  if (col >= 0) return 4 + col;          // 只说「左边」= 左列中间
  return 0;
}

/**
 * 文本 → 格号。
 *
 * 2026-09-30 修（中）：原来是 `t.match(/[1-9]/)` —— **句子出现的第一个数字**就是格子：
 * 「我第3次下棋」被读成 3 号格、「太6了」被读成 6 号格、「10号格」被读成 1 号格、
 * 「下排第2格」被读成 2 号格（在上排）。现在数字必须"就是这一步"才认：
 *   ① 明确带号/格/位（完整数字，越界拒）；带「上/中/下+排/行」时按**行内编号**换算
 *      （下排第2格 → 8）；
 *   ② 整句除口癖/方位外就一个 1~9 → 按数字（「我下5」「左下7」「上排2」照常）；
 *   ③ 有数字但说不清：方位判定若**恰好等于**那个数字就按方位，否则拒（不猜）；
 *   ④ 没数字 → 原方位判定。
 */
function parsePos(text) {
  const t = String(text || '');
  const digits = t.match(/\d+/g) || [];
  // ① 带号/格/位：按完整数字捞（10号格 → 10 → 越界 → 拒）
  const tagged = t.match(/(\d+)\s*[号格位]/);
  if (tagged) {
    const n = Number(tagged[1]);
    if (!(n >= 1 && n <= 9)) return 0;
    const rowSuf = t.match(/([上中下])[排行]/);   // 「下排」这种行后缀才做行内换算
    if (rowSuf && n <= 3) return ['上', '中', '下'].indexOf(rowSuf[1]) * 3 + n;
    return n;
  }
  // ② 单个数字 + 口癖/方位全剥掉没剩下别的实字
  if (digits.length === 1) {
    const n = Number(digits[0]);
    const residue = t.replace(/\d+/g, '')
      .replace(/[我你他她它们上下中左右走放落了的吧呀啊号格位第排行\s，,。.!！?？：:、~～]/gu, '');
    if (n >= 1 && n <= 9 && !residue) {
      const rowSuf = t.match(/([上中下])[排行]/);   // 「上排2」= 行内第 2 格；「左下7」无行后缀 → 原数
      if (rowSuf && n <= 3) return ['上', '中', '下'].indexOf(rowSuf[1]) * 3 + n;
      return n;
    }
  }
  // ③ 有数字但说不清：方位跟数字对得上才用方位，对不上就拒
  if (digits.length) {
    const d = dirPos(t);
    if (d && digits.length === 1 && Number(digits[0]) === d) return d;
    return 0;
  }
  // ④ 纯方位
  return dirPos(t);
}

/** 记号 → 玩家名：优先查 board 里记的，再退回引擎的开局人 */
function nameOf(state, mark) {
  const b = state?.board || {};
  const n = mark === 'X' ? b.xName : b.oName;
  if (n) return String(n);
  const host = state?.host || null;
  if (mark === 'X' && host?.name) return String(host.name);
  return '这位';
}

export default {
  id: 'tictactoe',
  name: '井字棋',
  aliases: ['井字', '井字棋', 'tic-tac-toe', 'tictactoe', '三连', '圈叉'],
  desc: '3x3 井字棋：两人轮流落子，先把三个连成一线的人赢',

  start(cfg, { player } = {}) {
    // 2026-10-01 修（P1-A4）：认不出开局人就不发开场白、不开盘 —— 否则 state.host=null、
    //   px=''、xName='这位'，之后任何人都走不了这局（认人/轮次判定全拒），群里只剩
    //   一条没人走得动的废局。say:'' 让引擎跳过群播报（引擎用 ?? 保空串），forModel
    //   让模型先问清由谁开局再重开；与 draw.js「认不出不预发签」同一处置。
    if (!player) {
      return {
        reject: true,
        say: '',
        forModel: '没认出是谁要开的局（发起人身份为空），这局没开。先在群里问清楚由谁开局，'
          + '等有人应下后再用 mini-games__game_start 重开。'
      };
    }
    const id = player?.id != null ? String(player.id) : '';
    const name = String(player?.name || '') || '这位';
    const host = player ? { id, name } : null;
    return {
      // board 必须能 JSON 序列化：格子数组 + 两个玩家 + 轮次，不存函数不存 Map
      board: {
        cells: [], px: id, nx: '', xName: name, oName: '',
        turn: 'X', over: false, winner: '', starter: 'X'
      },
      say: `井字棋开局：格子编号 1 2 3 / 4 5 6 / 7 8 9，报数字或「左上/中/右下」都行。`
        + `${name} 执 X 先走，第二个人进来执 O。`,
      forModel: `这局井字棋由 ${name} 执 X 先落子，第二个人进来执 O。`
        + '玩家报数字或方位词后，把他的话原样交给 mini-games__game_move，输赢由插件判。'
    };
  },

  move(cfg, state, { text, player } = {}) {
    const b = state?.board || {};
    const cells = Array.isArray(b.cells) ? b.cells : [];
    if (b.over) return { reject: true, forModel: '这局已经结束了，别再把这一步算进去。' };
    if (!player) return { reject: true, forModel: '没认出这一步是谁说的。' };
    const pos = parsePos(text);
    if (!pos) return { reject: true, forModel: '没听到格子。让玩家报 1~9 的数字，或「左上/中/右下」这种方位词。' };
    if (cells.some((c) => Number(c.i) === pos)) {
      return { reject: true, forModel: `${pos} 号格已经有 ${cells.find((c) => Number(c.i) === pos)?.n || '子'} 了，换一个空格。` };
    }

    const id = player?.id != null ? String(player.id) : '';
    const name = String(player?.name || '') || '这位';
    const px = String(b.px ?? '');
    const mineX = !!id && id === px;
    // X/O 由"是不是发起人"定，名字只在引擎查不到 id 时兜底。
    // 2026-09-30 修（中）：原来 O 侧没有名字兜底，且 `!b.nx → 一律发 O` ——
    //   · 执 O 的人下次没带 id 就会被判成第三人（X 侧有名字兜底，O 侧没有，不对称）；
    //   · 只要 O 位还空着，**任何人**（含轮到 X 时认不出的发起人）都会被硬发 O，
    //     随后在轮次判定里自相矛盾（"轮到 X，他是 O"）。
    // 现在：O 位空缺**且轮到 O** 才发 O；轮到 X 却认不出 → 拒并说明，不再硬发记号。
    let mark = '';
    // 名字作证的两种情形：说话人没带 id，或局面没记下该记号的 id（px/nx 为空）——
    // 缺证据的一侧不能拿来当反证（否则开局没拿到 id 的发起人、匿名入座的 O 都会被误判成第三人）。
    if (mineX || ((!id || !px) && name && name === String(b.xName || ''))) mark = 'X';
    else if (b.nx && id && id === String(b.nx)) mark = 'O';
    else if ((!b.nx || !id) && name && b.oName && name === String(b.oName)) mark = 'O';
    else if (!b.nx && !b.oName && (b.turn || 'X') === 'O') mark = 'O';
    else if ((b.turn || 'X') === 'X' && !b.nx && !b.oName) {
      return { reject: true, forModel: `没认出这一步是不是 ${nameOf(state, 'X')}（X）本人说的，先别记进局面。` };
    } else {
      return { reject: true, forModel: `这局是 ${nameOf(state, 'X')} 和 ${nameOf(state, 'O')} 在下，第三个人先别插手，等这局结束再开一局。` };
    }

    if ((b.turn || 'X') !== mark) {
      const t = b.turn || 'X';
      if (t === 'O' && !b.oName) {
        return { reject: true, forModel: `还没有第二个人执 O，${name} 是 ${mark}，这一步不记进局面；等有人入座 O 再走。` };
      }
      return { reject: true, forModel: `现在轮到 ${nameOf(state, t)}（${t}），${name} 是 ${mark}，这一步先别记进局面。` };
    }

    const place = [...cells, { i: pos, n: mark, id, name }];
    const win = WIN_LINES.find((L) => L.every((i) => place.some((c) => Number(c.i) === i && c.n === mark)));
    const board = {
      ...b, cells: place, px,
      // O 的 id 缺席时（引擎没解析到 senderId）保留已记的 nx，别用空串把老座位洗掉
      nx: mark === 'O' ? (id || b.nx || '') : (b.nx || ''),
      xName: b.xName || (mark === 'X' ? name : ''), oName: b.oName || (mark === 'O' ? name : ''),
      turn: mark === 'X' ? 'O' : 'X'
    };
    if (win) {
      return {
        board: { ...board, over: true, winner: name }, over: true, winner: name,
        say: `🎉 ${name}（${mark}）落 ${pos} 号，${win.join('-')} 三连，赢了！`
      };
    }
    if (place.length >= 9) {
      return {
        board: { ...board, over: true, winner: '平局' }, over: true, winner: '平局',
        say: `九格满了，${name}（${mark}）落 ${pos} 号，这局平局。`
      };
    }
    const nt = board.turn;
    const nName = nt === 'X' ? board.xName : board.oName;
    return {
      board,
      say: `${name}（${mark}）落 ${pos} 号。${nName ? `轮到 ${nName}（${nt}）。` : `还差一个人来执 ${nt}。`}`,
      // 2026-09-30 修（中）：原来 O 位空缺时写「${name} 可以接着用 ${nt} 走」——
      // 但认人/轮次判定只会把发起人认成 X，他再走一步必被拒。别替引擎承诺走不了的棋。
      forModel: nName
        ? `现在轮到「${nName}」（${nt}）。`
        : `还差一个人执 ${nt}，等第二个人报格子（那时才把他记成 ${nt}）；发起人别自己接着走。`
    };
  },

  /** 一行状态：棋盘压成「1:X 5:O」这种，再写轮到谁。不写祈使句。 */
  hint(cfg, state) {
    const b = state?.board || {};
    const marks = (Array.isArray(b.cells) ? b.cells : [])
      .filter((c) => c && c.n)
      .map((c) => `${c.i}:${c.n}`)
      .join(' ');
    const t = (b.turn || 'X') === 'O' ? 'O' : 'X';
    return clip(`棋盘 ${marks || '空盘'}｜轮到 ${t} ${clip(nameOf(state, t), 6)}`, 60);
  },

  /** 井字棋没有隐藏信息（棋盘是公开的） */
  secretOf() { return []; }
};
