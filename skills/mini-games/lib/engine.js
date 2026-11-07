// 群内小游戏 · 引擎 v3
//
// ══ 这一版为什么推倒重来 ══
// v2 在群里真跑了两天，暴露的四类问题都不是"某个游戏写错了"，而是**契约本身缺了约束**：
//
//   ① **机器人替玩家出牌**：注入里写"轮到 1（该报数）"，模型当成"该我报 1 了"，
//      自己调 game_move 把 1、3 都报了；插件再把这份"没人说过的动作"算到最后一个说话的人头上
//      （群里就成了"机器人自己跟自己玩，玩家的 2/4/6 全被忽略"）。
//      → v3：**动作必须能在本次唤醒的群友消息里找到出处**（数字/词能对上），对不上就拒。
//   ② **隐藏信息漏进群**：猜拳第一个人出的拳被公布（"阿狸 出 石头"），后面的人直接克制即可。
//      → v3：游戏用 `secretOf(state)` 声明本局隐藏值，引擎的测试**逐个游戏断言**
//        say/hint 里不出现它（隐藏信息只在结算/揭晓时才允许出现）。
//   ③ **工具返回 undefined**：宿主把工具结果塞进下一条请求，undefined 会让整个请求 400
//      → 那一轮直接死掉，群里表现就是"玩着玩着突然不回复"。
//      → v3：index.js 把每个工具都包了一层，**任何路径都返回 {content: string}**。
//   ④ **注入像命令**：'轮到 X（该报数）'、'要牌或停牌' 这类祈使句会诱导模型动手。
//      → v3：`hint()` 只描述**状态**，不写"该谁做什么"；怎么用工具统一在静态提示词里说。
//
// ══ 游戏模块契约（default 导出）══
//   id / name / aliases / desc                    标识与展示
//   start(cfg, { player, ctx, ...extra })  -> { board, say?, forModel?, reject? }
//   move(cfg, state, { text, player, ctx })-> { board?, say?, forModel?, over?, winner?, reject? }
//   hint(cfg, state)                       -> 一行局面状态（≤60 字；有隐藏答案的 ≤150）
//   secretOf(state)  [可选]                -> 本局**不能提前出现在群里的值**（数组，供测试与守卫用）
//   reveal(cfg, state) [可选]              -> { over: true, say }  收摊/猜通时由插件原样公布
//
//   say      = 群友看得到的（绝不能出现给模型的话；留空 = 这一步插件不发）
//   forModel = 只给模型看的（工具返回值）
//   reject   = 这一步不算：局面不变，理由只给模型
import fs from 'node:fs';
import path from 'node:path';
import { readGame, writeGame, clearGame, allGames } from './store.js';

const GAMES_DIR = new URL('./games/', import.meta.url);

/** 注入块的包裹标记（单行，便于整行替换）。 */
export const MARK = '⟦小游戏⟧';

const gamesCache = new Map();
let loading = null;

export function loadGames() {
  loading ||= (async () => {
    let files = [];
    try { files = fs.readdirSync(GAMES_DIR).filter((f) => f.endsWith('.js')); } catch { /* 目录缺失 */ }
    for (const f of files.sort()) {
      try {
        const mod = await import(new URL(f, GAMES_DIR));
        const g = mod?.default;
        if (g?.id && typeof g.start === 'function' && typeof g.move === 'function' && typeof g.hint === 'function') {
          gamesCache.set(String(g.id), g);
        }
      } catch { /* 单个游戏坏了不影响其它 */ }
    }
    return gamesCache;
  })();
  return loading;
}

export function gameSync(id) { return gamesCache.get(String(id || '')); }
export function listGames() {
  return [...gamesCache.values()].map((g) => ({ id: g.id, name: g.name, desc: g.desc, aliases: g.aliases || [] }));
}

export function resolveGame(name) {
  const raw = String(name || '').trim();
  const all = [...gamesCache.values()];
  if (!all.length) return null;
  if (!raw || /^(随机|随便|任意|random)$/i.test(raw)) return all[Math.floor(Math.random() * all.length)];
  const low = raw.toLowerCase();
  for (const g of all) {
    if (g.id === low || String(g.name) === raw) return g;
    if ((g.aliases || []).some((a) => String(a) === raw || String(a).toLowerCase() === low)) return g;
  }
  for (const g of all) {
    if (String(g.name) && raw.includes(String(g.name))) return g;
    if ((g.aliases || []).some((a) => a && raw.includes(String(a)))) return g;
  }
  return null;
}

/**
 * 这一行是不是**机器人自己发出去的播报**（不是群友说的话）。
 * 用途：同群多实例时，别把对方实例的播报当成"群友的动作"喂进判定。
 */
const OWN_OUTPUT = [
  /^【海龟汤·[^】\n]+】/, /^【汤底·[^】\n]+】/, /^【小游戏/, /^⟦小游戏/, /^「[^」\n]+」收摊了(?:（走了 \d+ 步）)?[：。]/,
  /^第 ?\d+ ?问（[^）\n]*）/, /^(?!(?:我|俺|咱|本人|在下) )(?:[^\n]+ )?掷出 \d+ 点。/,
  // 2026-09-30 修（中）：原来是 `猜 \d+[:：]`（任意位置沾边就算）—— 群友转述
  // 「他上次猜 50：大了」会被当成机器人自己的播报，从出处匹配里被剔掉。
  // number.js 自己的播报只有 `猜 ${n}：大了/小了。` 这一种冒号形（中了那条以 🎉 开头，
  // 已被上面的 /^🎉/ 覆盖），所以锚到行首并把尾巴写全。
  /^猜 \d+[:：](大了|小了)。/,
  /^🎉/, /^结算[:：][^\n]+ —— /,
  // 2026-10-01 修（P0 · B3）：原来是 `出 ?(了)?(石头|剪刀|布|拳)` —— **没有锚**，句中任意位置
  // 沾边就算机器人播报。群友自己说的「我出石头」「出布」「出剪刀」当场被引擎拒掉
  // （T21_runtime_我出石头_ok=false，forModel="这一步看着是机器人自己的播报…"；
  //  而 rps.parseHand('我出石头')==='石头' —— 游戏模块认得出，是引擎先拦的）。
  // 同族 /^猜 \d+[:：](大了|小了)/ 已按"锚到行首 + 尾巴写全"修过（见上），这条是漏网的同类。
  // 现在锚到行首，并要求**「出」前面是"说话人 + 空格"**：
  //   · 真播报（rps.js:59）＝ `${name} 出拳了（已出 N 人）`、老版＝ `阿狸 出 石头`，都带这个形状；
  //   · 群友的「出布」「我出石头」整句里一个空格都没有 ⇒ 不再被误杀。
  /^[^\n]+ 出拳了（已出 \d+ 人）|^\S+ 出 (?:石头|剪刀|布)/,
  // 2026-10-01 修（E2 · 本批 ③）：同群多实例时，**对方实例的播报**也会进 trigger/recent ——
  //   上面的老规则只覆盖猜数字/掷骰/海龟汤/⟦行⟧/🎉/结算，四类游戏的播报全漏了：
  //   井字棋 / 成语接龙 / 21 点 / 谜语（外加猜拳的开场与亮牌）。漏判的方向不是误杀而是**放进来**：
  //   对方实例的「亮牌：…」「阿狸（X）落 5 号」被当成群友动作喂进 groundMove，判到别人那局上。
  //   补法一律"行首锚 + 冒号/结构钉死"，负向控件（我出石头 / 公布答案 / 亮牌 / 阿狸 停牌 / …）保持 false。
  //   有意**不**补 `^答案[:：]` 与 hangman 的「答案：…」—— 真人猜题就打「答案：猫」，加了就杀真动作。
  // 2026-10-01 修（F-1 · 2d 批）：E2 有 5 条规则过宽 —— Qwen 3a97a1c4 §3 实测 5/28 条真人话
  //   被判真（改前全假），其中「我（X）落 5 号」被整步吞掉、「21 点开局怎么算」害模型拒开局。
  //   逐条**收窄到生产播报的真实形状**（对照 games/*.js 的 say 原文核过），21 条 bot 播报保持判真：
  //     ① 成语接龙 → 只认行首「，我先来」「收局」（idiom.js 仅这两形，真人抱怨「，太难了」不再撞）；
  //     ② 落号 → 行首锚 + 第一人称排除 + 「（X）落 N 号」（播报是「名字（X）落 N 号」，
  //        真人自述「我（X）落 5 号」由行首 lookahead 拦住）。★2f 批 G-1 修复：2d 版在此之上
  //        多加的 `(?<![我俺咱自己])` 与 `{0,20}` 会拦掉**昵称以 我/己 结尾（阿我/小己）与
  //        超 20 字昵称**的自家播报（Qwen 实测 97 条生产 say 漏 12、且被喂进别人的局）——
  //        两部件对真人假阳无增益（真杀伤力全在行首 lookahead），已删，用 `[^（\n]*` 放开；
  //     ③ 21 点开局 → 冒号后必须出现「…（N 点）」的点数括号，或接「要能认出」
  //        （blackjack.js:144 开局行 show(me) 恒带（N 点）、:139 认人失败行）；
  //        ★2f 批残余③：拦真人「21 点开局：怎么算」（冒号后无点数括号）；
  //     ④ 提示 → 「谜底是 N 个字」（riddle.js:134-137 两形：N 个字。/ N 个字的类别。）；
  //        ★2f 批残余④：拦真人「提示：谜底是什么呀」（非数字尾巴）；
  //     ⑤ 公布答案 → 冒号后不出现人话框架词（「是」任意位置 / 「我觉得」/「我猜」；riddle.js 的
  //        纯名词答案与 15 条题库均不含这些）——拦「是猫」「猫是假的」「我觉得猫」，见残余清单注记。
  //        （「公布答案：猫」= 真·不可分，有意保留判真，是记档的取舍，不是漏网。）
  //   收窄在 engine.js 内做：looksLikeOwnOutput 是无状态纯函数，index.js 的 playerOf 调它不带局状态
  //   （且 index.js 不在本批写权内）——Qwen 建议的"限定游戏进行时"需改签名，属扩张，不做。
  /^猜拳[:：]每人说一句「石头」/,
  /^亮牌[:：]/,
  /^井字棋开局[:：]格子编号/, /^(?!(?:我|俺|咱|本人|在下)（[XO]）)[^（\n]*（[XO]）落 \d+ 号(?=[。，]|$)/,
  /^成语接龙(?:，我先来|收局)/, /^（成语接龙[:：]第 \d+\/3 次没接上——/, /接「[^」]+」，下一个要接「/,
  /^21 点开局(?:(?:[:：][^，]*?（\d+ 点）)|要能认出)/, /(停牌|加入|补到|坐下等)[^\n]*（\d+ 点）/, /^庄家只亮了 \S+（/, /^庄家 .+= \d+ 点：[^\n]+。/,
  /^谜语[:：](?:什么东西天气越热，它爬得越高？|什么东西有五个头，人却不觉得奇怪？|什么东西明明是你的，别人却用得比你多？|什么东西有翅膀却不会飞，转起来还挺凉快？|什么东西有几十颗牙齿，却从来不吃东西？|什么东西专门吃纸，吃进去还能吐出一样的纸？|什么东西你能看到别人的，别人也能看到你的，你自己却看不到？|一个小姑娘，坐在水中央，身穿粉红袄，撑船不用桨。（打一植物）|有面没有口，有脚没有手，虽有四只脚，自己不会走。（打一物）|什么东西白天睡觉，晚上才睁眼，专门站在路边？（打一物）|什么东西不用浇水也能一直长大？|什么东西别人请你吃，你自己还得掏钱？|一斤棉花和一斤铁，哪个重？|什么人一年只上一天班，还不会被开除？)/, /^提示[:：]谜底是 \d+ 个字/, /^公布答案[:：](?:温度计|手套|名字|电风扇|梳子|复印机|后背|荷花|桌子|路灯|年龄|吃亏|一样重|圣诞老人)$/, /猜「[^」]+」：不对，/,
  //   ── 2f 批 F-2（剩余游戏补缺）── 每条锚 games/*.js say 原文行号；正样本=生产原话形状，
  //      负样本=真人动作/抱怨。一律行首锚+结构钉死（不用裸关键词）；昵称位一律 `[^\n]+` 不设
  //      长度上限（G-1 教训：`{0,20}` 这种帽会拦掉长/怪昵称的自家播报）。第一人称位沿用
  //      `(?!(?:我|俺|咱|本人|在下) …)` 行首排除。正负样本见 probe-2f.mjs S7b。
  /^猜数字[:：]我想了个 \d+~\d+ 的数/,                                                    // number.js:50
  /^掷骰子比大小[:：]谁想说「掷」/,                                                         // dice.js:56
  /^🎲 抽签开始[:：]说「抽」再抽一条/,                                                      // draw.js:80
  /^🎲 (?!(?:我|俺|咱|本人|在下) 先抽到)[^\n]+ 先抽到[:：]/,                                 // draw.js:84
  /^🎲 抽签收摊[:：]这轮一共抽了 \d+ 条/,                                                   // draw.js:101
  /^🎲 抽中了[:：][^\n]+（从 \d+ 人里抽的）/,                                               // draw.js:114
  /^🎲 (?!(?:我|俺|咱|本人|在下) 抽到)[^\n]+ 抽到[:：][^\n]*（(?:第 \d+\/\d+ 次|次数用完了)）/, // draw.js:141
  /^这轮一条签都没抽出去。$/, /^这轮抽出的签（\d+ 条）[:：]/,                                // draw.js:148/:149 reveal
  /^记忆翻牌[:：]16 张 8 对/,                                                               // memory.js:46
  /^翻 \d+ 号是「/,                                                                        // memory.js:104/:115（真人动作「翻 3 号」「3 7」无「号是「」→ 假）
  /^牌面（格号 1~\d+）[:：]/,                                                              // memory.js:151
  /^数字炸弹[:：]1~\d+ 里我埋了个炸弹/,                                                     // bomb.js:63
  /^💥 (?!(?:我|俺|咱|本人|在下) 报 \d+)[^\n]+ 报 \d+ —— 炸了/,                              // bomb.js:90
  /^(?!(?:我|俺|咱|本人|在下) 报 \d+)[^\n]+ 报 \d+[:：]安全，范围 \d+~\d+/,                   // bomb.js:98（「：安全，范围 a~b」真人打不出 → 尾钉）
  /^逢七过[:：]从 1 开始轮流数/,                                                            // seven.js:22
  /^❌ (?!(?:我|俺|咱|本人|在下) 说了)[^\n]+ 说了「过」，可 \d+ 既不是 7 的倍数/,              // seven.js:46
  /^❌ (?!(?:我|俺|咱|本人|在下) 报了)[^\n]+ 报了 \d+ —— [^\n]+，这里要说「过」/,              // seven.js:61
  /^(?!(?:我|俺|咱|本人|在下) 过 ✓)[^\n]+ 过 ✓ 下一个 \d+/,                                  // seven.js:51
  /^(?!(?:我|俺|咱|本人|在下) 报 \d+ ✓)[^\n]+ 报 \d+ ✓ 下一个 \d+/,                          // seven.js:66
  /^数到 \d+ 了，够长了，这局算平局收摊/,                                                   // seven.js:50/:65
  /^24 点开始[:：]\d+ \d+ \d+ \d+/,                                                        // twentyfour.js:56
  /^这道 \d+ \d+ \d+ \d+ 的参考答案[:：]/, /^这题 \d+ \d+ \d+ \d+ 的参考答案[:：]/,           // twentyfour.js:75/:130
  /^这局没存下参考答案，\d+ \d+ \d+ \d+/,                                                  // twentyfour.js:77
  /^猜词开始[:：]\d+ 个字的词/,                                                             // hangman.js:49
  /^(?!(?:我|俺|咱|本人|在下) 猜「)[^\n]+ 猜「[^」]+」：中了 ✓/,                             // hangman.js:112
  /^(?!(?:我|俺|咱|本人|在下) 猜「)[^\n]+ 猜「[^」]+」：[^\n]+ ✗（错 \d+\/\d+）/,             // hangman.js:158
  /^❌ [^\n]+ 猜「[^」]+」：[^\n]+，失误满 \d+ 次。答案：/,                                    // hangman.js:153（只认 ❌ 行首锚的机器输局）
  //   有意不补（2f 批记档取舍）：`^答案[:：]` 不加规则 —— hangman:123/:153 揭晓「答案：词」与
  //   真人猜题「答案：猫」同形、真·不可分；代价是 bot 揭晓行不被滤（现状判假），换真人动作不被杀。
];
export function looksLikeOwnOutput(text) {
  const t = String(text || '').trim();
  return !!t && OWN_OUTPUT.some((re) => re.test(t));
}

/** 从一段话里抽"能对号入座"的 token：数字，以及 ≥2 字的连续汉字（去掉 @/CQ/括号内容）。 */
export function tokensOf(text) {
  const t = String(text || '')
    .replace(/\[CQ:[^\]]*\]/g, ' ')
    .replace(/@[^\s@]{0,20}/g, ' ')
    .replace(/[（(][^）)]*[）)]/g, ' ');
  return [...new Set([...(t.match(/\d+/g) || []), ...(t.match(/[\u4e00-\u9fa5]{2,}/g) || [])])];
}

/** 本次唤醒里"像人说的"消息（排掉机器人自己的播报）。 */
function humanMessages(ctx) {
  const out = [];
  const push = (m) => {
    if (!m || m.self) return;
    if (!m.senderId && !m.senderName) return;
    if (looksLikeOwnOutput(m.text)) return;
    out.push(m);
  };
  try { (ctx?.session?.trigger || []).forEach(push); } catch { /* ignore */ }
  // 2026-09-30 修（中）：limit 12 → 40。busy 群里 12 条很快就滚过去，玩家刚说的
  // 那一步会掉出窗口 → groundMove 找不到出处 → 合法动作被拒（"没人说过含…的话"）。
  try { (ctx?.store?.recent?.(ctx.chatKey, { limit: 40, includeSelf: false }) || []).forEach(push); } catch { /* ignore */ }
  return out;
}

const whoOf = (m) => (m ? { id: String(m.senderId || ''), name: String(m.senderName || m.senderId || '') } : null);

/**
 * 这一步是谁做的 + **它到底有没有发生过**。
 *
 * 这是 v3 最重要的一条约束：模型很爱"替群友把该走的一步走掉"——
 * 注入里写着"轮到 1"，它就自己调 game_move("1")，插件再把这份没人说过的动作
 * 算到最后说话的人头上（群里就成了机器人自己跟自己玩）。
 *   · 动作里有可对号的 token（数字/词）→ 必须在本次唤醒/最近的群友消息里找到出处，否则拒；
 *   · 动作里没有 token（「掷」「开」「过」「要」「停」）→ 仍须在原话里匹配该短动作，
 *     再按最后一条匹配消息认人，避免把无关聊天当成出牌。
 */
function groundMove(text, ctx) {
  const humans = humanMessages(ctx);
  if (!humans.length) return { ok: false, player: null, why: 'no-human-context' };
  const tokens = tokensOf(text);
  if (!tokens.length) {
    // 「掷」「过」「要」这类短动作没有可用词元，也必须能在玩家原话里找到。
    const needle = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (!needle) return { ok: false, player: null, why: 'action-not-found', text };
    for (let i = humans.length - 1; i >= 0; i -= 1) {
      const source = String(humans[i].text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      if (source.includes(needle)) return { ok: true, player: whoOf(humans[i]), why: 'matched-action' };
    }
    return { ok: false, player: null, why: 'action-not-found', text };
  }
  for (let i = humans.length - 1; i >= 0; i -= 1) {
    const t = String(humans[i].text || '');
    if (tokens.some((k) => t.includes(k))) return { ok: true, player: whoOf(humans[i]), why: 'matched' };
  }
  return { ok: false, player: null, tokens };
}

function newState(game, player) {
  return { game: game.id, at: Date.now(), host: player || null, over: false, winner: null, turns: 0, board: {}, log: [] };
}

/**
 * 闲置多久算"没人玩了"（分钟）。**阈值来自配置**（skill.json 的 idleCloseMinutes，默认 5），
 * 这里的 5 只是配置缺失时的兜底，不是唯一来源。
 */
function idleCloseMinutes(cfg) {
  const v = Number(cfg?.idleCloseMinutes);
  return Number.isFinite(v) && v > 0 ? v : 5;
}

/**
 * 闲置被自动关闭的局（待发给群里的提示）。引擎自己没有发送通道，
 * 关闭这件事先记在这儿，由 index.js 的 `drainIdleNotices()` 取走发出去。
 * 上限 50：队列被丢弃也比无界增长好（宁可少通知一条，不许拖垮内存）。
 */
const idleNotices = [];

function noteIdleClose(chatKey, state, cfg) {
  try {
    if (!state) return;
    const name = gameSync(state.game)?.name || state.game;
    idleNotices.push({
      chatKey: String(chatKey),
      text: `「${name}」这局 ${idleCloseMinutes(cfg)} 分钟没人动，已经自动结束了；想玩再喊我开一局。`
    });
    if (idleNotices.length > 50) idleNotices.splice(0, idleNotices.length - 50);
  } catch { /* 记不下就少一条通知，不影响关闭 */ }
}

/** 取走全部闲置关闭通知（一次性）。index.js 发完就没了。 */
export function drainIdleNotices() {
  return idleNotices.splice(0, idleNotices.length);
}

/**
 * 读局面 + **闲置自动关闭**（用户原话："突然不玩游戏后迅速关闭游戏，比如五分钟没有触发"）。
 *   · `state.at` 是 store 每次落盘时盖的**最后活动时刻**（开局、每走一步都会更新；只读注入不算触发）；
 *   · 超过阈值 → `clearGame` 把状态**释放掉**，这里当"没有进行中的游戏"处理；
 *   · 幂等：状态本来就没有 → 直接 null；重复触发时 clearGame 对不存在的会话是空操作，不会报错；
 *   · 纯本地（store 落盘 + 定时/惰性触发），不碰 Jev、不联网、不依赖外部服务。
 *   · 2026-10-01 补（C2）：关掉时记一条**待发通知**（惰性这条路由此覆盖；定时那条在 sweepIdleGames）。
 */
function readIdleGame(cfg, chatKey) {
  const state = readGame(chatKey, { ttlMinutes: cfg?.idleTtlMinutes });
  if (!state) return null;
  if (Date.now() - (Number(state.at) || 0) > idleCloseMinutes(cfg) * 60 * 1000) {
    noteIdleClose(chatKey, state, cfg);
    clearGame(chatKey);
    return null;
  }
  return state;
}

/** 开一局。除引擎自己的字段外，其余参数原样透传给游戏（海龟汤的 puzzle/solution 就这么进来的）。 */
export function startGame(cfg, chatKey, { game, player, force = false, ctx = null, ...extra } = {}) {
  const existing = readIdleGame(cfg, chatKey);
  if (existing && !force) {
    const g = gameSync(existing.game);
    return { ok: false, say: `这个会话已经有一局「${g?.name || existing.game}」在进行中（第 ${existing.turns} 步）。想重开就先用 mini-games__game_stop 结束它。` };
  }
  const g = resolveGame(game);
  if (!g) return { ok: false, say: `没有叫「${game}」的游戏。现在有：${listGames().map((x) => x.name).join('、')}。` };
  const state = newState(g, player);
  const r = g.start(cfg, { ...extra, player, ctx }) || {};
  // 2026-10-01（P1-A4）：`??` 而非 `||` —— 游戏明确给 say:''（认不出开局人、不发开场白）时
  //   保留空串让插件静默跳过群播报，非空 say（如海龟汤的设置拒绝）和缺省都走原 fallback；
  //   forModel 透传给插件做 tool content，让模型先问清由谁开局再重开。
  if (r.reject) return { ok: false, say: r.say ?? '这个开局参数不合法。', forModel: String(r.forModel || '') };
  state.board = r.board || {};
  writeGame(chatKey, state);
  return { ok: true, state, say: String(r.say || `「${g.name}」开始了。`), forModel: String(r.forModel || '') };
}

/** 群友的一步。text 必须是**群友原话**（引擎会校验它在本次唤醒里找得到出处）。 */
export function moveGame(cfg, chatKey, { text, player = null, ctx = null } = {}) {
  const state = readIdleGame(cfg, chatKey);
  if (!state) return { ok: false, forModel: '这个会话现在没有进行中的游戏。想开一局就用 mini-games__game_start。' };
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, forModel: '没给玩家原话。把他说的话原样传进来。' };
  if (looksLikeOwnOutput(raw)) {
    return { ok: false, forModel: '这一步看着是机器人自己的播报，不是群友说的话，已忽略。' };
  }
  const grounded = groundMove(raw, ctx);
  if (!grounded.ok) {
    if (grounded.why === 'no-human-context') {
      return {
        ok: false,
        forModel: '当前上下文里找不到群友原话，这一步不能计入游戏。等玩家实际发出动作后，再用 mini-games__game_move 原样转交。'
      };
    }
    if (grounded.why === 'action-not-found') {
      return {
        ok: false,
        forModel: `群友原话里找不到「${String(raw).slice(0, 20)}」这一步，所以不计入。不要从无关消息推断动作；只把玩家实际说过的原话交给 mini-games__game_move。`
      };
    }
    return {
      ok: false,
      forModel: `这一步在群里找不到出处（没人说过含「${grounded.tokens.join('、')}」的话），所以不算数。`
        + '不要替群友出牌/报数/猜数：只有群友**自己说过**的那一步才用 mini-games__game_move 传进来。'
    };
  }
  const g = gameSync(state.game);
  if (!g) return { ok: false, forModel: `游戏模块「${state.game}」没加载出来，先用 mini-games__game_stop 收摊吧。` };

  const r = g.move(cfg, state, { text: raw, player: player || grounded.player, ctx }) || {};
  if (r.reject) return { ok: false, forModel: String(r.forModel || r.say || '这一步不合法。'), state };
  state.turns = (Number(state.turns) || 0) + 1;
  if (r.board) state.board = r.board;
  if (r.winner) state.winner = r.winner;
  if (r.over) state.over = true;
  state.log = [...(state.log || []), { t: Date.now(), p: (player || grounded.player)?.name || '', m: raw.slice(0, 40) }].slice(-6);

  if (state.over) clearGame(chatKey);
  else writeGame(chatKey, state);
  return {
    ok: true, state, over: !!state.over, winner: state.winner || null,
    say: String(r.say || ''),
    forModel: String(r.forModel || r.say || '这一步已判定。')
  };
}

/** 收摊。reveal=true 时先由插件把答案原样公布了再清盘（海龟汤用）。 */
export function stopGame(cfg, chatKey, { reason = '', reveal = false } = {}) {
  const state = readIdleGame(cfg, chatKey);
  if (!state) return { ok: false, say: '本来就没有进行中的游戏。' };
  const g = gameSync(state.game);
  let tail = '';
  if (reveal && typeof g?.reveal === 'function') {
    try { tail = `\n${String((g.reveal(cfg, state) || {}).say || '')}`; } catch { /* 揭晓失败也得收摊 */ }
  }
  clearGame(chatKey);
  return {
    ok: true, reveal: !!tail,
    say: `「${g?.name || state.game}」收摊了${state.turns ? `（走了 ${state.turns} 步）` : ''}${reason ? `：${reason}` : '。'}${tail}`
  };
}

/**
 * 全量扫一遍：把**所有闲置超时**的牌局清掉（释放状态，不占用会话）。
 * 由 index.js 的本地定时器（activate 里每 60 秒）调用；工具/钩子入口另有惰性关闭兜底。
 * 幂等：重复调用第二次扫到 0 局；没有牌局的库里返回 0，不会抛错。
 * @returns {number} 本次关掉的局数
 */
export function sweepIdleGames(cfg) {
  let closed = 0;
  try {
    const cutoff = Date.now() - idleCloseMinutes(cfg) * 60 * 1000;
    for (const [chatKey, st] of Object.entries(allGames())) {
      if (st && (Number(st.at) || 0) < cutoff) {
        noteIdleClose(chatKey, st, cfg);   // 2026-10-01 补（C2）：定时扫描这条路也要能通知群里
        clearGame(chatKey);
        closed += 1;
      }
    }
  } catch { /* 扫不动就算了，不影响别处 */ }
  return closed;
}

/**
 * 本局**不能提前出现在群里**的值（泄漏守卫 + 测试用）。
 * 游戏用 `secretOf(state)` 声明；海龟汤这种"汤底"另有 spoilerOf（按整段拦，<6 字的不拦 —— 那会误伤正常发言）。
 * 2026-10-01 修（D3 · 本批 ⑤）：`>= 2` → `>= 1`。声明成"1 个字也算密值"的（猜拳手牌
 *   「布」）原来被静默滤掉，导出的契约就说谎了。放宽到 1 字**不改变任何现有行为**：
 *   泄漏守卫（hooks）走的是 spoilerOf（≥6 字），engine.secretOf 目前零生产调用方，
 *   测试用的是各游戏自己的 g.secretOf + 自己的 ≥2 过滤。改动只修这个导出的语义。
 */
export function secretOf(cfg, chatKey) {
  try {
    const state = readIdleGame(cfg, chatKey);
    if (!state || state.over) return [];
    const g = gameSync(state.game);
    if (!g) return [];
    const list = typeof g.secretOf === 'function' ? (g.secretOf(state) || []) : [];
    return list.map(String).filter((v) => v.length >= 1);
  } catch { return []; }
}

/** 给泄漏守卫用的整段文本（海龟汤的汤底这种"抄了就算漏"的长文本）。 */
export function spoilerOf(cfg, chatKey) {
  try {
    const state = readIdleGame(cfg, chatKey);
    if (!state || state.over) return '';
    const g = gameSync(state.game);
    if (!g || typeof g.spoilerOf !== 'function') return '';
    const s = String(g.spoilerOf(state) || '');
    return s.length >= 6 ? s : '';
  } catch { return ''; }
}

/** 诊断/测试用。 */
export function boardOf(cfg, chatKey) {
  const state = readIdleGame(cfg, chatKey);
  if (!state) return null;
  const g = gameSync(state.game);
  return { state, game: g, line: hintLine(cfg, chatKey) };
}

/**
 * 注入提示词的**一行**局面。只报状态（不写"该谁做什么"），≤60 字（有隐藏答案的 ≤150）。
 * index.js 的钩子会先把上一轮的这一行删掉再追加，所以上下文里永远只有一份。
 */
export function hintLine(cfg, chatKey) {
  const state = readIdleGame(cfg, chatKey);
  if (!state || state.over) return '';
  const g = gameSync(state.game);
  const body = g ? String(g.hint(cfg, state) || '') : '（局面模块未加载）';
  return `${MARK}${g?.name || state.game}｜${body}${MARK}`;
}
