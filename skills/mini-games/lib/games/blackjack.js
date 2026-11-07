// 21 点：座位上每人一手牌，庄家一张明牌一张暗牌。玩家说「要」补牌、说「停」比牌。
//
// ══ 为什么整副牌一次洗好、写进 board ══
// 每步 move 重新随机 = 同一张牌可能发两次、点数前后对不上，群里立刻会发现"刚才的牌变了"。
// 所以 start 用 Fisher–Yates 洗一次 52 张（不用随机 sort：它不等概率），顺序整个存进 board，
// 之后只按 idx 递增取牌 —— 任何一步都可复现，判定完全确定。
//
// ══ 暗牌纪律 ══
// 庄家暗牌（board.hole）由 secretOf 声明，**结算之前**不许出现在任何 say / hint 里：
//   · 开局和每步 say 只报庄家明牌；
//   · hint 只写"当前座位的手牌与点数 + 庄家明牌"；
//   · 只有 finish() 翻暗牌，那一句 say 里才有「庄家 ♠9 + 暗牌 ♣4 = 20 点」。
//
// ══ 多人时只认"第一个还没打完的座位" ══
// 顺序就是轮次，但**轮次只用来挡"抢别人的牌"**：不是当前座位的人插手一律 reject（局面不动、
// 群里不发消息，理由只进 forModel）。别人出局/停牌后，座位自动往前走。
//
// ══ 措辞 ══
// 群里真出过事：新玩家坐进来说「停」，写成"坐下就停牌"没人看得懂。现在的写法是
// 「X 加入：♠K ♥7（17 点）（直接停牌）」，玩家一眼知道自己这手已经停了。
const SUITS = ['♠', '♥', '♣', '♦'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

const nick = (p) => String(p?.name || '') || '这位';
/** 身份键：群里重名很常见，所以优先 id */
const who = (p) => (String(p?.id || '') ? `i:${p.id}` : String(p?.name || '') ? `n:${p.name}` : '');
const clip = (s, n) => {
  const t = String(s || '');
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};
/** hint 的字数硬上限：引擎注入时还会在前面拼上「⟦小游戏⟧21点｜」（约 9 字） */
const HINT_MAX = 48;

/**
 * 点数：A 先当 11，爆了再逐个降成 1 —— 也就是"不超过 21 的最大值"。
 *
 * ⚠️ 牌面是**花色在前**（'♠9'、'♣10'），所以取点数必须 slice(1)。
 * 老代码写的是 slice(0, -1)（花色在后），于是 '♠9' 被当成 '♠' → 每个人都是 0 点：
 * 21 点判不出来、爆点判不出来、庄家补牌一路补到整副牌发完。
 * 这个 bug 在群里是"能玩完但结果全错"，比崩溃更难发现。
 */
function score(cards) {
  let sum = 0;
  let aces = 0;
  for (const c of Array.isArray(cards) ? cards : []) {
    const r = String(c).slice(1);
    if (r === 'A') { sum += 11; aces += 1; } else if (r === 'J' || r === 'Q' || r === 'K') sum += 10;
    else sum += Number(r) || 0;
  }
  while (sum > 21 && aces > 0) { sum -= 10; aces -= 1; }
  return sum;
}

function newDeck() {
  const d = SUITS.flatMap((s) => RANKS.map((r) => s + r));
  for (let i = d.length - 1; i > 0; i -= 1) {          // Fisher–Yates：等概率
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/** 座位 → 名字：board.seats 里有就用它，没有就退回引擎记的开局人 */
function nameOfSeat(state, seat) {
  if (seat?.name) return String(seat.name);
  const host = state?.host;
  if (seat && host && host.id != null && `i:${host.id}` === seat.k) return String(host.name || '这位');
  return '这位';
}

/** "第一个还没打完的座位"在哪个下标（都打完了返回 -1） */
const currentIdx = (seats) => (Array.isArray(seats) ? seats.findIndex((s) => !s.done) : -1);

/** 一行手牌：♠K ♥7（17 点） */
const show = (seat) => `${seat.name} ${(seat.cards || []).join(' ')}（${score(seat.cards)} 点）`;

/**
 * 全部座位都打完了：庄家补到 ≥17 再逐个比，然后翻暗牌收局。
 * 全员爆点时庄家不必补牌（也没得比），暗牌就不翻 —— 那种局面下它已经不是任何人的信息。
 */
function finish(b, seats) {
  const allBust = seats.every((s) => score(s.cards) > 21);
  let dScore = null;
  let draws = [];
  if (!allBust) {
    const d = [b.up, b.hole];
    let idx = Number(b.idx) || 0;
    while (score(d) < 17 && idx < b.deck.length) { d.push(b.deck[idx]); idx += 1; }
    draws = d.slice(2);
    dScore = score(d);
  }
  const res = seats.map((s) => {
    const ps = score(s.cards);
    if (ps > 21) return `${s.name} 爆点输`;
    if (dScore > 21 || ps > dScore) return `${s.name} 赢`;
    return ps === dScore ? `${s.name} 平` : `${s.name} 输`;
  });
  const win = seats.filter((s) => dScore !== null && score(s.cards) <= 21 && (dScore > 21 || score(s.cards) > dScore));
  const dealer = allBust
    ? `庄家只亮了 ${b.up}（都爆了，不补牌）`
    : `庄家 ${b.up} + 暗牌 ${b.hole}${draws.length ? ` + ${draws.join(' ')}` : ''} = ${dScore} 点`;
  // 牌面（含暗牌）在结算这一步才第一次公布：牌局已经结束，没有泄漏可言
  return {
    board: { ...b, seats, over: true },
    over: true,
    winner: win.length ? win.map((s) => s.name).join('、') : '庄家',
    say: `${dealer}：${res.join('、')}。`
  };
}

/** 把玩家绑到座位上：老玩家换名字就地更新，新玩家加一个座位。返回 {seats, seat} */
function bindSeat(seats, k, name) {
  const list = Array.isArray(seats) ? seats : [];
  const i = k ? list.findIndex((s) => s.k === k) : -1;
  if (i >= 0) {
    const next = list.map((s, j) => (j === i ? { ...s, name } : s));
    return { seats: next, seat: next[i] };
  }
  const seat = { k, name, cards: [], done: false };
  return { seats: [...list, seat], seat };
}

export default {
  id: 'blackjack',
  name: '21点',
  aliases: ['21点', '二十一点', 'blackjack', '要牌', '比大小21'],
  desc: '轮流对庄家：说「要」补牌、说「停」比牌，超过 21 点就爆，庄家补到 17 点再比',

  start(cfg, { player } = {}) {
    const deck = newDeck();
    const k = who(player);
    // 2026-10-01 修（P0 · A2）：认不出人（没 id 也没昵称 ⇒ who() 返回 ''）时**不许落座**。
    // 原来照落不误，于是 board.seats 里留下一个 k:'' 的"幽灵座位"，之后
    // `seats.findIndex((s) => s.k === k && k)` 被空键骗成 -1，每一步都提示
    // 「轮到「这位」」，这局永远走不动，只能等 5 分钟闲置关闭（T18_seat0={"k":"",…}）。
    if (!k) {
      return {
        reject: true,
        say: '21 点开局要能认出你是谁（昵称或号码），这一步没认出来，先不开；等能认出人再喊我。'
      };
    }
    const me = { k, name: nick(player), cards: [deck[0], deck[1]], done: false };
    const b = { deck, idx: 4, up: deck[2], hole: deck[3], seats: [me], over: false };
    const head = `21 点开局：${show(me)}，庄家明牌 ${b.up}。说「要」补牌，说「停」比牌；` +
      '超过 21 点就爆，庄家补到 17 点再比。别人说「我也来」可以一起坐进来（一个打完轮到下一个）。';
    // ⚠️ 起手就 21 点必须当场 done。留着 done:false 的话，这一步只能被"要"（必爆）或"停"处理，
    // 而插件又拒"要" —— 单人局会永远停在这个座位上（实测 fuzz 里真卡死过）。
    // 只把座位标成打完，不直接收官：庄家和其他人还没打。
    if (score(me.cards) !== 21) return { board: b, say: head };
    const done = { ...me, done: true };
    return {
      board: { ...b, seats: [done] },
      say: `${head} 起手就 21 点，这一手自动停牌。`
    };
  },

  move(cfg, state, { text, player } = {}) {
    const b = state?.board || {};
    const seats = Array.isArray(b.seats) ? b.seats : [];
    if (b.over) return { reject: true, forModel: '这局已经结算完了，别再把这一步算进去。' };

    const t = String(text || '');
    const k = who(player);
    const name = nick(player);
    // 「不要了」里也有"要"，所以先认停牌、再认要牌；
    // 「来一手」这种**要加入**的话不算要牌，否则新人一进门就白多拿一张
    // 2026-09-30 修（中）：原来是 `不要了`（必须带"了"）——群友说「不要」「不要牌」会被下面的
    // hit 认成"要"，白补一张（想停牌的人反而被推向爆点）。改成 `不要`：子串匹配，「不要了」照常命中。
    const stand = /停|不要|不抽|不补|够了|就这样|收手|过牌|stand/i.test(t);
    const hit = !stand && !/加入|我也|算我|带我|一起|来一?手|坐下/.test(t)
      && /要|再来|发牌|补牌|加牌|抽|拿|hit/i.test(t);
    const join = /加入|我也|算我|带我|一起|来一?手|坐下/.test(t);

    // k 为空时 `s.k === k && k` 恒假 ⇒ si 恒 -1（这条是对的），但**绝不能因此就让无名者落座**：
    // 见下面 si<0 那一支（2026-10-01 修 · A2）。两处一致：空键既骗不到座位，也换不到座位。
    const si = k ? seats.findIndex((s) => s.k === k) : -1;
    const cur = currentIdx(seats);
    // 自己这一手已经打完：**只挡"补牌/闲聊"**，喊「停」要放行到下面的收局分支。
    // 2026-10-01 修（P0 · A3）：原来 doneSeat 一律先拒 ⇒ 起手就 21 点的**本人结束不了**
    // （T19_seat_holder_stand 的 forModel 恒为「已经是 21 点，这一手自动停牌了，别再补牌。」），
    // 这局只能等 5 分钟闲置关；而**没入座的旁人**说「停」却会走到收局分支、结算文案里还没他。
    // 现在两件事一起改：本人能停（doneSeat 放行 stand），旁人不能替他停（收局搬进 si>=0 之后）。
    const doneSeat = si >= 0 && seats[si].done;
    if (doneSeat && !stand) {
      const ps = score(seats[si].cards);
      return {
        reject: true,
        forModel: ps === 21
          ? `${name} 已经是 21 点，这一手自动停牌了，别再补牌。`
          : `${name} 这手已经打完了（${ps} 点），这一步不算。`
      };
    }

    // 不在座位上（含"没认出人"⇒ si 恒 -1）：只有"要/停/加入"才算坐进来 —— 随便一句闲聊不能把整局搅乱。
    // 这一支**先于**收局分支：否则旁人说一句「停」就能替全桌结账（T19_bystander_over=true）。
    if (si < 0) {
      if (!(stand || hit || join)) {
        return { reject: true, forModel: `${name} 不在这一局里。想坐进来就说一句「我也来」。` };
      }
      // 2026-10-01 修（A2）：认不出人就不落座 —— 否则又造出一个 k:'' 的幽灵座位。
      if (!k) {
        return { reject: true, forModel: '没认出这一步是谁（拿不到昵称/号码），不落座；等能认出人再坐。' };
      }
      // 全桌都打完了：收局必须由**在座的人**喊「停」触发，旁人只有一条路——说「我也来」开新的一手。
      if (cur < 0 && !join) {
        return { reject: true, forModel: '这一桌已经全部打完了，等结算完再坐进来；想现在开就说一句「我也来」。' };
      }
      const idx = Number(b.idx) || 0;
      if (idx + 2 > (b.deck || []).length) return { reject: true, forModel: '牌堆不够发两手了，这一步先不收。' };
      // 起手先发两张，但**先不算进牌局**：这一手正在打的时候，新人只能坐在旁边等，
      // 他这一手要等前面那个座位打完才成立（语义就是"只处理第一个没打完的座位"）。
      // cards 留空到轮到他为止 —— 否则"别人手牌进注入"这件事就绕过了 hint 的暗牌纪律。
      const waiting = cur >= 0;
      const peek = [b.deck[idx], b.deck[idx + 1]];
      // 新人起手 21 点也当场算停牌（同 start 的理由：不留一个永远打不完的座位）
      const stopped = !!stand || score(peek) === 21;
      // 等着的人：cards 空着、牌压在 pending 上 —— 这样"别人的手牌"永远不会被打进 hint
      const fresh = { k, name, cards: waiting ? [] : peek, pending: waiting ? peek : null, done: stopped };
      const next = [...seats, fresh];
      const nb = { ...b, idx: idx + 2, seats: next };
      // 措辞：别写"坐下就停牌"（实测看不懂），写「X 加入：…（直接停牌）」
      const shown = { ...fresh, cards: peek };
      const head = waiting
        ? `${name} 坐下等这一手打完：${show(shown)}${stopped ? '（直接停牌）' : ''}。`
        : `${name} 加入：${show(shown)}${stopped ? '（直接停牌）' : ''}。`;
      if (!next.every((s) => s.done)) return { board: nb, say: head };
      const r = finish(nb, next);
      return { ...r, say: `${head}${r.say}` };
    }

    // 所有座位都打完了（最后一个人停牌 / 起手就 21）→ 庄家补牌、翻暗牌收局。
    // ⚠️ 这一条必须有：单人局里"停牌"本来就是最后一步，如果只写成"再补一张"的分支，
    // 局面会停在 done 的座位上没人能接着走，外面的人说什么都只收到"这一手还在打"。
    // **只有在座的人（si>=0）走得到这里** —— 旁人已经在上面那支被挡掉，不能替全桌结账。
    if (cur < 0) {
      const nb = { ...b, seats };
      return finish(nb, seats);
    }

    // 抢别人的牌：不是当前座位就统一在这里挡住 —— 局面不动、群里不发消息
    if (cur !== si) {
      return { reject: true, forModel: `现在轮到「${nameOfSeat(state, seats[cur])}」那一手，${name} 这一步先别记进局面。` };
    }
    {
      /** 轮到他了：把"坐着等"压在 pending 上的两张牌真正发到手上（这一步全局只在这里发生） */
      const live = () => {
        if ((seats[si].cards || []).length || !seats[si].pending) return seats;
        return seats.map((s, j) => (j === si ? { ...s, cards: s.pending, pending: null } : s));
      };
      if (stand) {
        const next = live().map((s, j) => (j === si ? { ...s, done: true, pending: null } : s));
        const nb = { ...b, seats: next };
        const head = `${name} 停牌：${show(next[si])}。`;
        if (!next.every((s) => s.done)) return { board: nb, say: head };
        return finish(nb, next);
      }
      if (!hit) return { reject: true, forModel: `${name} 这一句没听出是「要」还是「停」，先别动局面。` };
      const idx = Number(b.idx) || 0;
      if (idx >= (b.deck || []).length) return { reject: true, forModel: '牌堆发完了，这一步没法补牌。' };
      const now = live();
      const cards = [...now[si].cards, b.deck[idx]];
      const ps = score(cards);
      const bust = ps > 21;
      // 到 21 自动停：再要必然爆（不是规则限制，是这一步没有任何别的结果）
      const done = bust || ps === 21;
      const next = now.map((s, j) => (j === si ? { ...s, cards, pending: null, done } : s));
      const nb = { ...b, idx: idx + 1, seats: next };
      const head = `${name} 补到 ${cards.join(' ')}（${ps} 点）`;
      if (!done) return { board: nb, say: `${head}。` };
      if (!next.every((s) => s.done)) {
        return { board: nb, say: bust ? `${head} —— 爆了！` : `${head}，21 点自动停牌。` };
      }
      const r = finish(nb, next);
      return { ...r, say: `${bust ? `${head} —— 爆了！` : `${head}，21 点自动停牌。`}${r.say}` };
    }
  },

  /**
   * 一行状态（单行、只写状态、不写"该谁做什么"）：
   * 当前座位的手牌 + 点数、庄家**明牌**、其他座位已经打完的点数。暗牌绝不出现。
   */
  hint(cfg, state) {
    const b = state?.board || {};
    const seats = Array.isArray(b.seats) ? b.seats : [];
    if (!seats.length) return '还没发牌';
    const cur = currentIdx(seats);
    // 等着的人（前面那手还没打完）：pending 里压着他的两张牌，这里只报名字
    const waiting = seats.filter((x) => x.pending && !(x.cards || []).length).map((x) => x.name).join('、');
    const s = cur >= 0 ? seats[cur] : seats[seats.length - 1];
    const others = seats
      .filter((x) => x !== s && x.done)
      .map((x) => `${x.name} ${score(x.cards)} 点`)
      .join('、');
    const head = cur >= 0
      ? `${show(s)}｜庄家明牌 ${b.up}｜轮到 ${s.name}`
      : `${s.name} ${score(s.cards)} 点（都打完了）｜庄家明牌 ${b.up}`;
    return clip(`${head}${waiting ? `｜等位 ${waiting}` : ''}${others ? `｜另外 ${others}` : ''}`, HINT_MAX);
  },

  /** 本局不能提前进群的值：庄家暗牌（结算那一步才翻） */
  secretOf(state) {
    const b = state?.board || {};
    if (b.over) return [];
    return b.hole ? [String(b.hole)] : [];
  }
};
