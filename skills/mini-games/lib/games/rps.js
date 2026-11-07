// 猜拳：每人出一手，喊「开」时**一起亮牌**判胜负。
//
// ── 2026-09-22 修的坑（管理员反馈"一个人发出去全都知道是什么了"）──
// 旧版每出一手就播报"阿狸 出 石头"，于是后面的人只要出「布」就稳赢 —— 游戏直接没了。
// 现在：出拳阶段群里只看到"谁出拳了 / 已出几人"，**手牌进 board 不出群**（`secretOf` 声明、
// 结算时才亮）。这件事由测试逐个游戏守着：非结算状态下 say/hint 里不许出现手牌。
export default {
  id: 'rps',
  name: '猜拳',
  aliases: ['石头剪刀布', '剪刀石头布', '石头剪子布', 'rps', '划拳'],
  desc: '每人出一手石头/剪刀/布，喊「开」时一起亮牌判胜负',

  start() {
    return {
      board: { plays: [], round: 1 },
      say: '猜拳：每人说一句「石头」「剪刀」或「布」，都说完了喊「开」，我一起亮牌判胜负。'
    };
  },

  move(cfg, state, { text, player }) {
    const b = state.board || {};
    const plays = Array.isArray(b.plays) ? b.plays : [];
    const name = player?.name || '这位';
    const raw = String(text || '').trim();

    // ── 开：亮牌 + 判胜负 ──
    // 2026-09-29 修（严重）：原来 `^开` 前缀命中就算——「开饭」「开始」会当场亮牌结束；
    // 现在整句必须是"开/结算"这个意图（前缀口癖 + 句尾语气词放行）。
    if (/^(?:我|我们|咱|咱们|大家|都|来|一起|可以|那就)?\s*[，,、]?\s*(?:开|结算|亮牌|揭晓|都出完了|比一下|比一比)(?:吧|了|呗|嘛|么|啊|呀|哦)?[!?。！？\s…]*$/.test(raw)) {
      if (plays.length < 2) return { reject: true, forModel: `现在只有 ${plays.length} 个人出拳，至少两个人才能比。` };
      const show = plays.map((p) => `${p.name} ${p.hand}`).join('、');
      const win = winnerOf(plays);
      if (!win.hand) {
        // 平局不清盘：直接开下一回合（否则每个人都已出过，这局就卡死了）
        const round = (Number(b.round) || 1) + 1;
        return { board: { plays: [], round }, say: `亮牌：${show} —— 平局！第 ${round} 回合，重新出拳。` };
      }
      const winners = plays.filter((p) => p.hand === win.hand);
      const losers = [...new Set(plays.filter((p) => p.hand !== win.hand).map((p) => p.hand))];
      return {
        board: { ...b, plays },
        over: true,
        winner: winners.map((p) => p.name).join('、'),
        say: `亮牌：${show} —— ${winners.map((p) => p.name).join('、')} 赢（${win.hand} 克 ${losers.join('/')}）。`
      };
    }

    // ── 出拳 ──
    const hand = parseHand(raw);
    if (!hand) {
      return { reject: true, forModel: '没听出出的是什么。让他说「石头」「剪刀」或「布」（说「随便」我替他出）。' };
    }
    const key = whoKey(player);
    if (key && plays.some((p) => p.key === key)) {
      return { reject: true, forModel: `${name} 这一回合已经出过了，等别人出完喊「开」。` };
    }
    const next = [...plays, { key, name, hand }];
    // 只说"出拳了"：**手牌不出群**，否则后面的人直接克制就完事了
    return { board: { ...b, plays: next }, say: `${name} 出拳了（已出 ${next.length} 人）` };
  },

  /** 一行状态。**不列手牌**（`secretOf` 会由引擎和测试一起盯着这件事）。 */
  hint(cfg, state) {
    const n = (state.board?.plays || []).length;
    return n ? `已出拳 ${n} 人（手牌保密），等群友喊「开」亮牌` : '还没人出拳，等群友出石头/剪刀/布';
  },

  /** 结算前绝不能出现在群里的值：大家已经出了的手。 */
  secretOf(state) {
    return (state.board?.plays || []).map((p) => String(p.hand));
  }
};

/** 身份键：优先 QQ 号（群里重名很常见），没有就退回名字，都没有返回 ''（不做去重）。 */
function whoKey(player) {
  const id = String(player?.id || '').trim();
  if (id) return `id:${id}`;
  const name = String(player?.name || '').trim();
  return name ? `name:${name}` : '';
}

/**
 * 认手牌：石头/剪刀/布 + 常见叫法（拳、锤、剪、巴掌、rock/paper/scissors、✌）。
 * 「随便」由插件当场摇一手（同样保密）。
 */
export function parseHand(text) {
  let t = String(text || '');
  if (/随便|随机|你替我|帮我出/.test(t)) {
    const all = ['石头', '剪刀', '布'];
    return all[Math.floor(Math.random() * all.length)];
  }
  // 2026-09-29 修（严重）：先抠掉**长得像手势、其实是别的词**的常见词，再认手势。
  // 原来「我宣布…」→ 凭空记一手布、「剪彩/剪辑」→ 剪刀、「拳拳到肉/拳击」→ 石头，
  // 这一手不是玩家出的，却会挤掉后面真实出拳的人（同一个人被判重复出拳）。
  // 抠词只删这些整词：真出拳（出布 / 剪刀 / 拳头 / 拳）不受影响——
  // 「我宣布出布」抠掉「宣布」后仍然认出布。
  t = t.replace(/宣布|发布|分布|布局|布置|布告|布匹|抹布|花布|台布|密布|棋布|剪彩|剪辑|剪贴|剪裁|剪切|拳击|拳法|拳拳|太极拳/g, '');
  if (/石头|石頭|拳|锤|rock|✊|👊/i.test(t)) return '石头';
  if (/剪刀|剪子|剪|scissors|✌/i.test(t)) return '剪刀';
  if (/布|paper|巴掌|🖐|✋/i.test(t)) return '布';
  return '';
}

/** 谁赢：一种手势或三种凑齐 = 平局；两种时取能克制另一种的那一方。 */
function winnerOf(plays) {
  const hands = [...new Set(plays.map((p) => p.hand))];
  if (hands.length !== 2) return { hand: '' };
  const beats = { 石头: '剪刀', 剪刀: '布', 布: '石头' };
  const winHand = hands.find((h) => beats[h] === hands.find((x) => x !== h));
  return { hand: winHand || '' };
}
