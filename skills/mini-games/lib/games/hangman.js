// 猜词（吊死鬼）：插件藏一个 2~4 字的中文词，群友每次猜一个字（也可以直接猜整个词），错 6 次判负。
//
// ── v3 契约在这个游戏里的四条落点 ──
//   · say 只说群友看得到的（谁猜了什么、中没中）；给模型的说明一律走 forModel（它不进群）。
//   · hint 只报「几个字 + 已猜中的位置 + 错了几次」——**完整的词一个字都不出现**：
//     这一行每轮都跟着提示词重新计费，写进去等于把答案摊在模型眼前，迟早漏进群。
//   · 词是隐藏值 → secretOf 声明它（引擎与测试会逐个断言它没提前进群）；公布只在 over/reveal。
//   · 随机只发生一次：start 里 Math.random 选词，结果立刻写进 board → 跨轮一致、可 JSON、可复查。
//
// ── 为什么词库内置、不让模型出词 ──
//   ① 判定要逐字比对，模型自己都会记错它出的词（跨轮改口）；
//   ② 结束时必须一字不差地公布答案，走模型复述必错；
//   ③ 词库不进提示词（hint 只报局面）→ 几乎零 token，符合这个技能"省 token"的初衷。

/** 词库：2~4 字、群里常见的词（生僻的没人猜得动，同一条词里尽量不重复用字）。 */
const WORDS = [
  // 2 字
  '鲸鱼', '火锅', '奶茶', '榴莲', '香菜', '秃头', '加班', '摸鱼', '老板', '键盘',
  '蚂蚁', '减肥', '熬夜', '泡面', '拖鞋', '相亲', '外卖', '起床', '空调', '雪糕',
  '蚊子', '西瓜', '口罩', '电梯', '眼镜', '秋裤',
  // 3 字
  '充电宝', '自行车', '程序员', '麻辣烫', '打工人', '电风扇', '洗衣机', '方便面',
  '表情包', '复读机', '铲屎官', '拖延症', '大熊猫', '冰淇淋', '保温杯', '地铁站',
  // 4 字
  '麻辣香锅', '摸鱼达人', '熬夜冠军', '社恐患者', '快乐星球', '干饭机器', '早睡早起',
  '躺平青年', '电子榨菜', '人间清醒'
];

const MAX_WRONG = 6;

/** 句首句尾中间的废话/语气词：「我猜是不是鱼吧」里真正要猜的只有「鱼」 */
const FILLER = '我你猜想要来请试估计答案个这那字词下次给的是不没吧呢啊呀哦啦嘛么了嗯吗喂哈您好';

/** 机器人自己那句播报的形状（同群多实例时会被当成"群友消息"喂回来）。只认结果措辞。 */
const OWN_SAY = /中了 ?✓|不是这个词|词里没有这个字/;

export default {
  id: 'hangman',
  name: '猜词',
  aliases: ['猜字', '吊死鬼', 'hangman', '猜词游戏'],
  desc: '我藏一个 2~4 字的词，每次猜一个字（也可以直接猜整个词），错 6 次就输',
  library: WORDS,   // 词库（自检/维护用；引擎不读）

  start() {
    const word = WORDS[Math.floor(Math.random() * WORDS.length)];
    return {
      board: { word, guessed: [], wrong: [] },
      // 开场白压到 ~30 字：QQ 里一屏就是一条消息，写成长说明没人读
      say: `猜词开始：${[...word].length} 个字的词，猜一个字或直接猜整个词，错 ${MAX_WRONG} 次就输。`
    };
  },

  move(cfg, state, { text, player }) {
    const b = state.board || {};
    const word = String(b.word || '');
    const name = player?.name || '这位';
    const guessed = Array.isArray(b.guessed) ? b.guessed : [];
    const wrong = Array.isArray(b.wrong) ? b.wrong : [];
    const raw = String(text || '');

    // 同群多实例时，别的实例发的那句播报会以"群友消息"的形式喂进来（引擎的前缀表认不出猜词的播报），
    // 这里自己再挡一道。只认结果措辞，不认「猜「鱼」」这种玩家也可能照着打的形状 ——
    // 宁可少判一步（局面不变、群里不发），也不要把播报当成一次猜测记进局面。
    if (OWN_SAY.test(raw)) {
      return { reject: true, forModel: '这句看着是机器人自己发的播报，不是群友的猜测，这一步不算。' };
    }

    // 只取汉字：「我猜 鱼！」「是不是鱼」里的标点和语气词都不是猜测内容
    const han = raw.replace(/[^\u4e00-\u9fa5]/g, '');
    if (!han) return { reject: true, forModel: '这句话里没有汉字。群友要猜一个字（如「鱼」），或者直接猜整个词。' };

    // ① 直接猜整个词：话里带上了完整的词就算（「我猜是鲸鱼」这种包着说的也认）
    if (word && han.includes(word)) {
      return {
        board: { ...b, guessed: [...new Set([...guessed, ...[...word]])], wrong },
        over: true, winner: name,
        say: `🎉 ${name} 直接把词猜出来了：${word}！`
      };
    }

    // ② 抠出真正要猜的东西：把语气词/废话（「我猜是不是…吧」）去掉，只留他要猜的字。
    //    为什么全去掉而不是只削两端：「是不是鲸啊」的"不"夹在中间，只削两端会拼出「不是鲸」这种鬼词。
    let core = [...han].filter((c) => !FILLER.includes(c));
    if (!core.length) {
      // 整句都是废话（「啊」/「是不是不啊」）：退回到"句子里出现的、又确实在词里的字"，取**最后一个**。
      // 「是不是想啊」里真正要猜的是「想」，而「不」也是「不想上班」里的字，取第一个就会猜错字。
      // 再没有就退回最后一个汉字 —— 保证任何一句话都能落成一个确定的猜测。
      const inWord = [...new Set([...han].filter((c) => word.includes(c)))];
      core = inWord.length ? [inWord[inWord.length - 1]] : [[...han].pop()];
    }

    // ③ 一次说了两个字以上（又不是整个词）：当"整个词猜错了"处理，只扣一次失误
    if (core.length >= 2) {
      const guess = core.join('');
      if (wrong.includes(guess)) return { reject: true, forModel: `「${guess}」这一步之前已经猜过了，局面不变。` };
      return missStep(b, word, guess, name, guessed, wrong, true);
    }

    const ch = core[0];
    if (guessed.includes(ch) || wrong.includes(ch)) {
      return { reject: true, forModel: `「${ch}」这一步之前已经猜过了，局面不变（同一个字猜两次不算）。` };
    }

    if (word.includes(ch)) {
      const g2 = [...guessed, ch];
      const done = [...word].every((c) => g2.includes(c));
      return {
        board: { ...b, guessed: g2, wrong },
        ...(done ? { over: true, winner: name } : {}),
        say: done
          ? `🎉 ${name} 补上「${ch}」，整个词拼出来了：${word}！`
          : `${name} 猜「${ch}」：中了 ✓ ${mask(word, g2)}`
      };
    }

    return missStep(b, word, ch, name, guessed, wrong);
  },

  /** 收摊公布（game_stop reveal=true）：答案由插件原样发出，不经过模型复述 */
  reveal(cfg, state) {
    const b = state.board || {};
    const w = (b.wrong || []).length;
    return { over: true, say: `答案：${b.word}（这局错 ${w} 次）` };
  },

  /**
   * 一行局面：只有字数、已猜中的位置、错了几次。
   * 「_ 鱼 _」这种遮罩本身不会拼出完整的词（字之间有空格，且全猜中时这局已经结束了）。
   */
  hint(cfg, state) {
    const b = state.board || {};
    const word = String(b.word || '');
    const g = Array.isArray(b.guessed) ? b.guessed : [];
    const w = Array.isArray(b.wrong) ? b.wrong : [];
    return `${[...word].length} 字：${mask(word, g)}，错 ${w.length}/${MAX_WRONG}`;
  },

  /** 本局不能提前出现在群里的值（引擎的泄漏守卫与自测按它逐个断言） */
  secretOf(state) {
    const word = String(state?.board?.word || '');
    return word ? [word] : [];
  }
};

/** 猜错一步的公共分支：记一次失误，够 6 次就判负（判负时这局已经结束，才允许出现答案） */
function missStep(b, word, guess, name, guessed, wrong, whole = false) {
  const why = whole ? '不是这个词' : '词里没有这个字';
  const w2 = [...wrong, guess];
  if (w2.length >= MAX_WRONG) {
    return {
      board: { ...b, guessed, wrong: w2 },
      over: true,   // 输：没有 winner
      say: `❌ ${name} 猜「${guess}」：${why}，失误满 ${MAX_WRONG} 次。答案：${word}`
    };
  }
  return {
    board: { ...b, guessed, wrong: w2 },
    say: `${name} 猜「${guess}」：${why} ✗（错 ${w2.length}/${MAX_WRONG}）`
  };
}

/** 已猜中的字显示原字，没猜中的显示下划线（位置信息保留） */
function mask(word, guessed) {
  return [...String(word || '')].map((c) => (guessed.includes(c) ? c : '_')).join(' ');
}
