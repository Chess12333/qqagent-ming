// 记忆翻牌：4x4 = 16 张牌、8 对（开局洗牌）。群友报两个格号翻两张，成对得分，8 对配完分多者赢。
//
// ── v3 契约在这个游戏里的四条落点 ──
//   · say 只说群友看得到的（翻开的是哪两张、中没中、谁得分了）；给模型的说明全走 forModel。
//   · hint 只报「进度 + 已经当众翻开过（seen）的牌」——**没翻开的牌面绝不出现**。
//   · 没公开的牌面由 secretOf 声明（每个未翻开格号两种写法都声明，hint 形与 say 形都能被断言）。
//   · 洗牌只由插件 Math.random 做一次，结果立刻写进 board → 跨轮一致、可 JSON、可复查。
//
// ── 关键：翻错了要盖回去，但群里已经看见了 ──
//   所以 board 里除了 deck（真实牌面，**绝不能进 hint**）之外另存一份 seen：
//   「哪个位置曾经当众翻开过、是什么」。盖回去之后牌面在群聊里依然是公开信息，
//   模型/群友只能靠这份 seen 推理 —— 位置有记忆、牌不在盘面上，这就是这个游戏的全部乐趣。
//
// ── 绝不能因为"轮到谁"把局面锁死（修过的 bug）──
//   早先用"这一轮轮到 X"硬拦，配上"turn 指回自己"的写法，两个人的局差点谁都动不了：
//   同一个人想连翻就被拒，两个人互相卡住。现在 turn 只是记录**上一个翻牌的人**，
//   一次都不拿来拒绝（只在他连翻第三次时用 say 提一句"换个人也可以"）。
//
// ── 两次翻牌为什么拆成两步 ──
//   允许「3 7」一次说完，也允许先说「翻 3」再补「7」：只报一个号时先把它翻开挂在 pending 上，
//   下一个号（或下一次只说一个号）再凑成一对。

/** 八对牌面：单字、好认、在群里一眼能对上（值只写进 board，没翻开就不许出现在 say/hint） */
const PAIRS = ['鹿', '猫', '鱼', '熊', '兔', '鹅', '龟', '马'];

const CELLS = PAIRS.length * 2;   // 16 格

/** 机器人自己那句播报的形状（同群多实例时会被当成"群友消息"喂回来）。本文件所有播报都以「翻 N 号是」开头。 */
const OWN_SAY = /^翻 ?\d{1,2} ?号是/;

export default {
  id: 'memory',
  name: '记忆翻牌',
  aliases: ['翻牌', '记忆', '配对', '连连看', 'memory'],
  desc: '4x4 十六张牌八对，报两个格号翻两张，成对得分，8 对配完分最多的人赢',
  library: PAIRS,   // 牌面（自检/维护用；引擎不读）

  start() {
    const deck = shuffle([...PAIRS, ...PAIRS]);
    return {
      board: {
        deck, players: [], seen: {}, open: [], done: [], score: {},
        pending: 0, miss: 0, last: null, streak: 0, turn: null
      },
      // 开场白压到 ~50 字：QQ 里一屏就是一条消息，写成长说明没人读
      say: `记忆翻牌：16 张 8 对，格号 1~16 从左上往右下数。一次报两个号（如「3 7」）翻两张，配对得分，配完分多者赢。`
    };
  },

  move(cfg, state, { text, player }) {
    const b = state.board || {};
    const raw = String(text || '').trim();
    const deck = Array.isArray(b.deck) ? b.deck : [];
    const name = player?.name || '这位';
    const key = String(player?.id ?? '') || name;

    // 同群多实例时，别的实例那句「翻 3 号是「鹿」…」会以"群友消息"的形式喂回来，
    // 里面的数字会被当成一次新的翻牌。这里自己挡一道（只认自己那种开头，玩家正常说话不受影响）。
    if (OWN_SAY.test(raw)) {
      return { reject: true, forModel: '这句看着是机器人自己发的播报，不是群友的翻牌，这一步不算。' };
    }
    if (deck.length !== CELLS) {
      return { reject: true, forModel: '这局的牌面丢了（存档不完整）。让群友收摊重开一局吧。' };
    }

    const done = Array.isArray(b.done) ? b.done : [];
    const pending = Number(b.pending) || 0;        // 已经翻开、还没凑成对的那一张
    const progress = `进度 ${done.length / 2}/${PAIRS.length}`;

    // 格号只认 1~16 的数字：「3 7」「翻 3 和 7」都行；其它字（换/左/右）不影响解析
    // 2026-10-01（P1-B2）：按**完整数字**匹配（\d+）——旧 \d{1,2} 会把「100」拆出「10」这类
    //   子串当成格号（三位数就不是格子号了）；整段数字再经 1~CELLS 过滤，超界一律不算。
    const nums = (raw.match(/\d+/g) || []).map(Number).filter((n) => n >= 1 && n <= CELLS);
    const uniq = [...new Set(nums)];
    if (!uniq.length) {
      return { reject: true, forModel: `要两个格子号（1~${CELLS}），例如「3 7」或者「翻 3 和 7」（${progress}）。` };
    }
    if (nums.length >= 2 && uniq.length === 1) {
      return { reject: true, forModel: `${uniq[0]} 和 ${uniq[0]} 是同一格，换一个格子。` };
    }

    // 定出这一次要翻的两格：一次报两个就用那两个；只报一个且前面已经翻了一张，就补成一对
    let a = 0;
    let c = 0;
    if (uniq.length >= 2) {
      [a, c] = uniq;
    } else if (pending) {
      if (uniq[0] === pending) return { reject: true, forModel: `${pending} 就是刚才翻开的那张，再报一个别的格号。` };
      a = pending;
      c = uniq[0];
    } else {
      a = uniq[0];
    }

    const players = withPlayer(b.players, key, name);

    // 只翻开一张：不是错误，是"翻到一半"，先挂起来等第二个号（牌面当众亮过 → 进 seen）
    if (!c) {
      if (done.includes(a)) {
        return { reject: true, forModel: `${a} 号已经配掉了（${progress}），换一个还没配的格子。` };
      }
      return {
        board: { ...b, players, seen: { ...(b.seen || {}), [a]: deck[a - 1] }, open: [a], pending: a },
        say: `翻 ${a} 号是「${deck[a - 1]}」，再报一个格号凑一对。`
      };
    }

    const bad = [a, c].find((n) => !n || done.includes(n));
    if (bad) return { reject: true, forModel: `${bad} 号已经配掉了（${progress}），换两个还没配的格子。` };

    const va = deck[a - 1];
    const vc = deck[c - 1];
    // 当众翻开过 = 永久公开：盖回去只是不在盘面上，群里已经看见了
    const seen = { ...(b.seen || {}), [a]: va, [c]: vc };
    const head = `翻 ${a} 号是「${va}」，${c} 号是「${vc}」`;
    // 轮次只记录、只提示，**绝不拒绝**：谁想连翻就让他翻（见文件头那条死锁教训）。
    // 同一个人连翻第三次才提一句"换个人也可以" —— 提在 say 里（群里看得见），不是 hint，
    // 也不是拒绝：局面的推进权永远在玩家手上。
    const streak = b.last === key ? (Number(b.streak) || 0) + 1 : 1;
    const nudge = players.length >= 2 && streak >= 3 ? `${name} 连翻了几次，换个人也可以。` : '';
    const book = { ...b, players, seen, open: [], pending: 0, last: key, streak, turn: key };

    if (va === vc) {
      const done2 = [...done, a, c];
      const score = { ...(b.score || {}), [key]: (Number(b.score?.[key]) || 0) + 1 };
      const board = { ...book, done: done2, score, miss: 0 };
      if (done2.length >= CELLS) {
        // 8 对全配完 → 按得分定赢家
        const rank = rankOf(score, players);
        return {
          board: { ...board, turn: null },
          over: true, winner: rank.name,
          say: `🎉 ${head}，一对！8 对全配完了：${rank.sheet}${rank.tie ? '，打平。' : `，${rank.name} 赢。`}`
        };
      }
      return { board, say: `${head}，一对！${name} 得分（进度 ${done2.length / 2}/${PAIRS.length}）。${nudge}` };
    }

    // 没配成：盖回去（open 清空），但 seen 记着 —— 这两张的牌面群里已经看见了
    const miss = (Number(b.miss) || 0) + 1;
    return { board: { ...book, miss }, say: `${head}，不是一对，盖回去。${nudge}` };
  },

  /** 收摊公布：把 16 张的牌面按格号列出来（4x4 四行，一眼能对上盘面） */
  reveal(cfg, state) {
    const deck = Array.isArray(state?.board?.deck) ? state.board.deck : [];
    const rows = [];
    for (let i = 0; i < deck.length; i += 4) {
      rows.push(deck.slice(i, i + 4).map((v, j) => `${i + j + 1}:${v}`).join(' '));
    }
    return { over: true, say: `牌面（格号 1~${CELLS}）：\n${rows.join('\n')}` };
  },

  /**
   * 一行局面：只报**已经当众翻开过**的（seen）与进度 —— deck 里的真实牌面绝不出现。
   * 一次配错会往 seen 里塞两条，所以这里限长显示 + 报"还有几张没列"，保证一行 ≤60 字。
   */
  hint(cfg, state) {
    const b = state.board || {};
    const done = Array.isArray(b.done) ? b.done : [];
    const rows = Object.entries(b.seen || {});
    const show = rows.slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' ');
    const more = rows.length > 3 ? ` +${rows.length - 3}` : '';
    const miss = Number(b.miss) || 0;
    return `配对 ${done.length / 2}/${PAIRS.length}｜已见 ${show || '无'}${more}${miss ? `｜连错 ${miss}` : ''}`;
  },

  /**
   * 本局不能提前出现在群里的值：**还没当众翻开过**的格子对应的牌面。
   * 每个格子声明两种形状 —— hint 的紧凑形「3:鹿」和 say 的人话形「3 号是「鹿」」，
   * 这样不管模型/模块用哪种写法泄漏，都能被同一份清单抓到。
   * 已经翻开的格子不在清单里（它在群里已经是公开信息，也可能正当地出现在结果里）。
   */
  secretOf(state) {
    const b = state?.board || {};
    const deck = Array.isArray(b.deck) ? b.deck : [];
    const seen = b.seen || {};
    const out = [];
    for (let i = 1; i <= CELLS; i += 1) {
      const v = deck[i - 1];
      if (v == null || seen[i] != null) continue;
      out.push(`${i}:${v}`, `${i} 号是「${v}」`);
    }
    return out;
  }
};

/**
 * 已经上手玩过的人：{k: id 或名字, name}。人数就靠它记 —— 不需要外部告诉我们谁在玩，
 * 不然"该谁翻"就没得提示、赢家名单也列不出来。超过 2 个也只是排着，不影响判定。
 */
function withPlayer(list, key, name) {
  const cur = Array.isArray(list) ? list : [];
  if (cur.some((p) => p.k === key)) return cur;
  return [...cur, { k: key, name }];
}

/** 按玩家 key 取显示名（记不住就退回"这位"） */
function nameOf(key, players) {
  const hit = (Array.isArray(players) ? players : []).find((p) => p.k === String(key));
  return hit?.name || '这位';
}

/** 得分榜：最高分的人赢，并列就是平局（"平局"占 winner 这个位） */
function rankOf(score, players) {
  const rows = Object.entries(score || {}).sort((x, y) => y[1] - x[1]);
  const sheet = rows.map(([k, v]) => `${nameOf(k, players)} ${v}`).join('、') || '没人得分';
  const tie = rows.length > 1 && rows[0][1] === rows[1][1];
  return { tie, sheet, name: tie || !rows.length ? '平局' : nameOf(rows[0][0], players) };
}

/** 洗牌用 Math.random（插件里唯一的随机源），结果原样写进 board */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
