// 谜语 / 脑筋急转弯：内置题库随机抽一条，群友把谜底说出来就算赢，猜 5 次不中就公布答案。
//
// ── v3 契约在这个游戏里的四条落点 ──
//   · say 只说群友看得到的：谜面、谁猜了什么、对不对。给模型的说明全走 forModel。
//   · hint 只报「已猜 N 次」——**不复述谜面**（群里已经有了，复述纯属每轮重复计费），更不带谜底。
//   · 谜底是隐藏值 → secretOf 声明它；猜满 5 次自动公布与 reveal 是全篇唯一允许出现谜底的地方。
//   · 随机只在 start 里 Math.random 抽一条，抽完立刻写进 board → 跨轮一致、可 JSON、可复查。
//
// ── 判定为什么用「关键词命中」而不是精确比对 ──
//   群友只会说「是不是水啊」「我猜是水」，精确匹配必然判错。关键词命中是"这句人话里有没有
//   说出谜底"的最省事做法，而且**完全确定**：不调模型、不花 token、也不会跨轮改口。
//   所以题库里的 keywords 要写全口语说法（同义词、常见别名），且不能用会误伤的词。

/** 题库：谜面 / 谜底 / 类别（只用于「给点提示」的第二档，**不能含谜底**）/ 判定关键词。
 *  必须定义在 export 之前（library 在模块初始化时就要取到）。 */
const RIDDLES = [
  { q: '什么东西天气越热，它爬得越高？', a: '温度计', tag: '日用品', keywords: ['温度计', '温度表', '寒暑表', '温度'] },
  { q: '什么东西有五个头，人却不觉得奇怪？', a: '手套', tag: '日用品', keywords: ['手套', '手指'] },
  { q: '什么东西明明是你的，别人却用得比你多？', a: '名字', tag: '抽象物', keywords: ['名字', '姓名', '外号'] },
  { q: '什么东西有翅膀却不会飞，转起来还挺凉快？', a: '电风扇', tag: '电器', keywords: ['电风扇', '风扇', '电扇', '吊扇'] },
  { q: '什么东西有几十颗牙齿，却从来不吃东西？', a: '梳子', tag: '日用品', keywords: ['梳子'] },
  { q: '什么东西专门吃纸，吃进去还能吐出一样的纸？', a: '复印机', tag: '电器', keywords: ['复印机', '打印机', '影印机'] },
  { q: '什么东西你能看到别人的，别人也能看到你的，你自己却看不到？', a: '后背', tag: '身体部位', keywords: ['后背', '背后', '背部', '后脑勺'] },
  { q: '一个小姑娘，坐在水中央，身穿粉红袄，撑船不用桨。（打一植物）', a: '荷花', tag: '植物', keywords: ['荷花', '莲花', '水芙蓉'] },
  { q: '有面没有口，有脚没有手，虽有四只脚，自己不会走。（打一物）', a: '桌子', tag: '家具', keywords: ['桌子', '书桌', '饭桌', '餐桌'] },
  { q: '什么东西白天睡觉，晚上才睁眼，专门站在路边？（打一物）', a: '路灯', tag: '公共设施', keywords: ['路灯', '街灯'] },
  { q: '什么东西不用浇水也能一直长大？', a: '年龄', tag: '抽象物', keywords: ['年龄', '岁数', '年纪'] },
  { q: '什么东西别人请你吃，你自己还得掏钱？', a: '吃亏', tag: '抽象物', keywords: ['吃亏'] },
  { q: '一斤棉花和一斤铁，哪个重？', a: '一样重', tag: '脑筋急转弯', keywords: ['一样重', '一样', '同样重', '都一样', '一样沉'] },
  { q: '什么人一年只上一天班，还不会被开除？', a: '圣诞老人', tag: '脑筋急转弯', keywords: ['圣诞老人', '圣诞'] }
];

const MAX_TRIES = 5;

/** 机器人自己那句播报的形状（开场白、提示都算）。只认自己那两种开头，玩家正常说话不会误伤。 */
const OWN_SAY = /^谜语[：:]|^提示[：:]/;

/** 猜测句的"框"：猜谜的人前后总要带点话——「我猜是」「是不是」「答案是」「啊」「呢」。
 *  判赢前先把框去掉，剩下的才是群友真正说的谜底本身。 */
const GUESS_PREFIX = /^(?:我猜(?:是|为|到)?|我觉得(?:是)?|我以为(?:是)?|我认为(?:是)?|我想(?:是)?|应该是|肯定是|大概是|或许(?:是)?|答案(?:是|就是)?|谜底(?:是|就是)?|是不是|就是|正是|是)/;
const GUESS_TAIL = /[啊呀吧呢了嘛呗哦哈诶唉啦？?！!。，,、~～\s的]+$/;

/** 放弃 / 要求公布的**整句**判定（用在 move 的第 ② 支，注释见那里）。
 *  结构照 twentyfour.js 的 GIVEUP：可选口癖前缀 + 动词，或"整句就是开吧"。
 *  注意两支是**或**关系：口癖前缀只服务动词支，「开吧」支一个前缀都不给。 */
const GIVEUP = /^(?:(?:我|我们|咱|咱们|大家|真的|实在|算了|唉|哎|哎呀|那就|还是)*[，,、]?\s*(?:公布答案|揭晓答案|公布|揭晓|放弃|不玩了|认输|投降|说答案|答案是[什么啥怎谁哪])|开吧)(?:了|呗|嘛|么|啊|呀|哦)?[!?。！？\s…]*$/;

/** 去掉猜测框（前后缀各剥最多 3 层，循环到剥不动为止）。 */
function guessCore(raw) {
  let s = String(raw || '').trim();
  for (let i = 0; i < 3; i++) {
    const s2 = s.replace(GUESS_PREFIX, '').replace(GUESS_TAIL, '');
    if (s2 === s) break;
    s = s2;
  }
  return s;
}

/** 这句算不算猜中：去掉猜测框后，**整句就是**谜底/关键词，或关键词顶在句首、后面只剩语气词。
 *  2026-09-30 修（中）：原来是 `raw.includes(关键词)` —— 任意位置沾边就算赢：第 3 题（谜底
 *  「名字」）还没人答，群里随口一句「我名字改了」直接判赢，答非所问也算赢。现在关键词必须
 *  是这句的主体；「名字啊」「我猜是名字」照常赢，「我名字改了」「这路灯真亮」不再误判。 */
function riddleWin(keys, raw) {
  const core = guessCore(raw);
  if (!core) return false;
  if (keys.some((k) => k && core === String(k))) return true;
  return keys.some((k) => {
    const kw = String(k || '');
    if (!kw || !core.startsWith(kw)) return false;
    return !/[一-龥]/.test(core.slice(kw.length));
  });
}

export default {
  id: 'riddle',
  name: '谜语',
  aliases: ['猜谜', '脑筋急转弯', '急转弯', 'riddle', '谜语'],
  desc: '我出一条谜语/脑筋急转弯，说出谜底就赢，猜 5 次不中就公布答案',
  library: RIDDLES,   // 题库（自检/维护用；引擎不读）

  start() {
    const r = RIDDLES[Math.floor(Math.random() * RIDDLES.length)];
    return {
      // answer 是规范字段（引擎的泄漏守卫/自测按它取谜底），a 是老字段，一并留着免得外部用例读不到
      board: { q: r.q, a: r.a, answer: r.a, tag: r.tag, keywords: r.keywords, tries: 0, hints: 0 },
      // 谜面必须完整给，说明压成半句：开场白越短越像群里真有人在出题
      say: `谜语：${r.q}\n（说谜底就行；输「提示」我给点线索，猜 ${MAX_TRIES} 次不中我公布答案）`
    };
  },

  move(cfg, state, { text, player }) {
    const b = state.board || {};
    const name = player?.name || '这位';
    const raw = String(text || '').trim();
    if (!raw) return { reject: true, forModel: '没收到玩家原话，把他说的话原样传进来。' };

    // 同群多实例时，别的实例发的开场白/提示会以"群友消息"的形式喂回来（引擎的前缀表认不出谜语），
    // 这里自己再挡一道，别把它算成一次猜测。玩家喊「提示」（没有冒号）不受影响。
    if (OWN_SAY.test(raw)) {
      return { reject: true, forModel: '这句看着是机器人自己发的播报，不是群友的答案，这一步不算。' };
    }
    if (!/[\u4e00-\u9fa5A-Za-z]/.test(raw)) {
      return { reject: true, forModel: '这一步看不出猜的是什么（只有数字或符号）。让群友把谜底说出来，或者说「提示」。' };
    }

    const tries = Number(b.tries) || 0;
    const answer = String(b.a || '');

    // ① 先判对错：答对了就不用管他顺带说了「不知道」之类的词
    const keys = Array.isArray(b.keywords) ? b.keywords : [];
    if (riddleWin(keys, raw)) {
      return {
        board: { ...b, tries: tries + 1 },
        over: true, winner: name,
        say: `🎉 ${name} 答对了：${answer}！`
      };
    }

    // ② 主动认输/要求公布：群里最常见的收场方式，别逼他们去喊工具
    // 2026-09-30 修（中）：原正则只有「答案是啥」——群友更常说「答案是什么」「答案是啥啊」，
    // 认不出来就掉进④白扣一次机会。改成「答案是」+常见疑问尾（啥/什么/怎么样/谁…）。
    // 2026-10-01 修（P0 · B1）：再改成**整句锚** —— 原来 `/公布|揭晓|放弃|不玩了|认输|开吧|…/`
    // 句中任意位置命中就 `over:true` 并念谜底，于是「我们开吧」（想开局）「别揭晓」（叫别人别揭晓）
    // 「不会开吧」（猜疑问）会当场把局炸掉、答案当场漏。同族 twentyfour.js 的 GIVEUP 已修过一次
    // （它的注释写明「不会吧」会炸局）、rps.js / dice.js 也都是整句锚 —— 这个文件是唯一漏的。
    // ⚠️「开吧」不给任何前置口癖：「我们开吧」= 想开局，不算放弃；单独一句「开吧」才算。
    if (GIVEUP.test(raw)) {
      return { board: { ...b, tries }, over: true, say: `公布答案：${answer}` };
    }

    // ③ 要提示：只说字数和类别，**绝不说出谜底本身**（说了这局就没了）
    if (/提示|给点|再给|不会|好难|猜不到|想不到|不知道|hint|不懂/.test(raw)) {
      const hints = (Number(b.hints) || 0) + 1;
      const detail = hints === 1
        ? `谜底是 ${[...answer].length} 个字`
        : `谜底是 ${[...answer].length} 个字的${b.tag || '东西'}`;
      return { board: { ...b, hints }, say: `提示：${detail}。` };
    }

    // ④ 猜错：记一次，够次数就自动公布（不结束会一直卡着局面）
    const t2 = tries + 1;
    const guess = raw.slice(0, 20);
    if (t2 >= MAX_TRIES) {
      return {
        board: { ...b, tries: t2 },
        over: true,   // 猜满次数没中：没有 winner
        say: `${name} 猜「${guess}」：不对，机会用完啦。答案：${answer}`
      };
    }
    return {
      board: { ...b, tries: t2 },
      say: `${name} 猜「${guess}」：不对，还有 ${MAX_TRIES - t2} 次机会。`
    };
  },

  /** 收摊公布（game_stop reveal=true）：答案由插件原样发出，不经过模型复述 */
  reveal(cfg, state) {
    const b = state.board || {};
    return { over: true, say: `答案：${b.a}（谜面：${b.q}）` };
  },

  // 一行局面：只报进度。不复述谜面（群里已有），更不带谜底。≤60 字
  hint(cfg, state) {
    const t = Number(state?.board?.tries) || 0;
    return `已猜 ${t} 次，还剩 ${Math.max(0, MAX_TRIES - t)} 次机会`;
  },

  /** 本局不能提前出现在群里的值（引擎的泄漏守卫与自测按它逐个断言） */
  secretOf(state) {
    const a = String(state?.board?.a || '');
    return a ? [a] : [];
  }
};
