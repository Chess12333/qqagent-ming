// 群内小游戏 · 技能入口 v3（工具 + 三个钩子）
//
//   · `api.registerTool` / `api.config` / `api.log`，以及 `activate()` 生命周期
// 引擎与泄漏检测**懒加载**：lib 缺文件或新旧混装时只降级，不让整个技能加载失败
// （群里那次"灰的点不开"就是这么来的）。
//
// ══ v3 相比 v2 的四条硬约束 ══
//   ① 工具返回**永不为空**：宿主会把工具结果放进下一条请求，undefined 会让整个请求 400
//      → 那一轮直接死掉，群里就是"玩着玩着突然不回复"。这里每个 execute 都过一层包装，
//      任何路径（含抛错）都返回 { content: string }。
//   ② 不替群友出牌：判定交给引擎，引擎会校验"这一步在本次唤醒的群友消息里找得到出处"。
//   ③ 群里只说群友该看的：say / forModel 分开，内部说明绝不进群。
//   ④ 隐藏信息（暗牌、手牌、谜底…）由游戏的 secretOf 声明，测试逐个断言它不出现在 say/hint 里。
//
// ══ 省 token ══
//   工具只留 3 个（开局 / 出牌 / 收摊），描述只说"什么时候用"；玩法在 skill.json 的静态片段里
//   （跨运行缓存）。每轮只注入一行局面，且每轮先删旧的再追加 —— 上下文里永远只有一份。
import { DATA_DIR } from '../../refactor/modules/extensions/host-api.js';
import { recoverBlockedSegments, sendRecoverySummary } from '../../refactor/modules/platform/send-recovery.js';

// ── 懒加载引擎（半截复制也能装上，只降级）──
let engine = {};
let leakMod = {};
let engineReady = null;
let engineError = '';

async function ensureEngine() {
  engineReady ||= (async () => {
    try { engine = await import('./lib/engine.js'); } catch (e) { engineError = String(e?.message ?? e); }
    try { leakMod = await import('./lib/leak.js'); } catch (e) { engineError ||= String(e?.message ?? e); }
    const missing = REQUIRED_EXPORTS.filter((k) => typeof engine[k] !== 'function');
    if (missing.length) engineError ||= `引擎导出不全，缺 ${missing.join('、')}`;
    if (engineError) log(`⚠️ 群内小游戏：${engineError} —— 多半是 skills/mini-games/ 没复制全，请把整个目录重新复制一遍。`);
    return engine;
  })();
  return engineReady;
}

const REQUIRED_EXPORTS = [
  'loadGames', 'listGames', 'startGame', 'moveGame', 'stopGame', 'hintLine', 'spoilerOf', 'looksLikeOwnOutput'
];
const BROKEN = '小游戏引擎没加载成功（lib/ 缺文件或版本不匹配）：请把 skills/mini-games/ **整个目录**重新复制一遍。';
const MARK = '⟦小游戏⟧';
const INJECT_RE = new RegExp(`${MARK}[^\\n]*${MARK}`, 'g');

let cfg = () => ({});
let log = () => {};

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});

  const guard = () => (cfg().enabled === false ? '小游戏被管理员关掉了（设置 → 技能 → 群内小游戏）。' : '');
  /** 一局当前的局面行（给工具返回补一行，模型就知道现在什么状态）。 */
  const boardLine = (ctx) => {
    try { const l = engine.hintLine?.(cfg(), ctx?.chatKey) || ''; return l ? `\n${l}` : ''; } catch { return ''; }
  };
  /**
   * 所有工具的统一外壳：**保证返回 { content: string }**。
   * 这是 v3 的第一条硬约束 —— undefined 会污染下一条请求（宿主把它塞进 tool 消息），
   * 模型 API 直接 400，那一轮就静默死掉（群里表现＝"玩着玩着突然不回复"）。
   */
  const tool = (def) => api.registerTool({
    ...def,
    execute: async (ctx, args) => {
      try {
        // 记下一条**能用的发送通道**：闲置自动关闭的通知要发到任意会话，而定时器手里没有 ctx。
        // （skills/schedule 就是这么做的：第一次拿到 ctx.sender 就留住。）
        if (ctx && typeof ctx.sender?.sendTextBatch === 'function' && !noticeSender) noticeSender = ctx.sender;
        const r = await def.execute(ctx, args);
        if (r && typeof r.content === 'string' && r.content) return r;
        const text = r && typeof r.content !== 'undefined' ? String(r.content) : '';
        return {
          content: text || '（这一步没有可说的内容，局面没变。）',
          isError: !!r?.isError,
          finishTurn: r?.finishTurn === true
        };
      } catch (error) {
        return { content: `小游戏这一步出错了：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 1/3 开一局 ──
  tool({
    id: 'game_start',
    name: '开小游戏',
    description: '在群里开一局小游戏。game 填游戏名（清单见系统提示）或「随机」；已经有别的一局时会拒绝。',
    category: 'utility',
    icon: '🎮',
    parameters: {
      type: 'object',
      properties: {
        game: { type: 'string', description: '游戏名，或「随机」' },
        force: { type: 'boolean', description: '已有牌局时是否顶掉重开' },
        puzzle: { type: 'string', description: '仅海龟汤自定义题：汤面' },
        solution: { type: 'string', description: '仅海龟汤自定义题：汤底（绝不能说出去）' },
        title: { type: 'string', description: '仅海龟汤自定义题：小标题' }
      },
      required: ['game']
    },
    async execute(ctx, args) {
      const bad = guard();
      if (bad) return { content: bad, isError: true };
      await ensureEngine(); await engine.loadGames?.();
      const r = engine.startGame?.(cfg(), ctx.chatKey, {
        game: args?.game,
        player: playerOf(ctx, String(args?.game || '')),
        force: args?.force === true,
        ctx,
        ...({ puzzle: args?.puzzle, solution: args?.solution, title: args?.title })
      }) || { ok: false, say: BROKEN };
      const closedHere = await flushIdleNotices(ctx);   // startGame 会先读局面 → 可能顺手关掉一局过期的
      if (!r.ok) {
        // A4：认不出开局人的拒绝 r.say=''（不发开场白），没东西可进群就不通知、不空占 C1 时间窗；
        //      非空 say（如"没有叫X的游戏"）照旧补一条节流提示。
        if (!closedHere && r.say) await noticeReject(ctx, r.say);  // 刚通知过"这局超时关了"就别再叠一句废话
        // A4：reject 带 forModel 时优先给模型（"先问清由谁开局再重开"），其余仍按 say 回。
        return { content: r.forModel || r.say || BROKEN, isError: true };
      }
      const delivery = await say(ctx, r.say);
      const sent = isCompleteDelivery(delivery);
      const head = formatAnnouncementOutcome(delivery, {
        label: '开场白',
        completeText: `开场白已全部发出 ${delivery.sentCount} 条（「${String(r.say).slice(0, 40)}」）。`,
        fallbackText: `要说的话：${r.say}`
      });
      return { content: `${head}${r.forModel ? `\n${r.forModel}` : ''}${boardLine(ctx)}`, finishTurn: sent };
    }
  });

  // ── 2/3 群友出牌 ──
  tool({
    id: 'game_move',
    name: '把群友这一步交给插件判定',
    description: '群友本人出了一步时调用（猜数、掷、接龙、出拳、落子、提问…）：把他的原话传进 text，'
      + '判定由插件给出。别自己判、也别替群友出牌。',
    category: 'utility',
    icon: '🎯',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '群友这一步的原话，例如「我猜 50」' } },
      required: ['text']
    },
    async execute(ctx, args) {
      const bad = guard();
      if (bad) return { content: bad, isError: true };
      await ensureEngine(); await engine.loadGames?.();
      const text = String(args?.text || '').trim();
      const r = engine.moveGame?.(cfg(), ctx.chatKey, { text, player: playerOf(ctx, text), ctx }) || { ok: false, forModel: BROKEN };
      const closedHere = await flushIdleNotices(ctx);   // moveGame 会先读局面 → 可能顺手关掉一局过期的
      if (!r.ok) {
        // C1：判非法也要在群里留一句（节流过的），否则玩家"报了却没人理"、误判完全不可见
        if (!closedHere) await noticeReject(ctx, r.forModel);
        return { content: r.forModel || BROKEN, isError: true };
      }
      const delivery = await say(ctx, r.say);
      const sent = isCompleteDelivery(delivery);
      const tail = formatMoveDeliveryTail(r, delivery);
      return { content: `${r.forModel}${tail ? `\n${tail}` : ''}${boardLine(ctx)}`, finishTurn: sent };
    }
  });

  // ── 3/3 收摊（reveal=true 时先公布答案）──
  tool({
    id: 'game_stop',
    name: '结束小游戏',
    description: '结束当前这局（群友说「不玩了」，或已经分出结果时）。reveal=true 时先把答案原样公布出来。',
    category: 'utility',
    icon: '🛑',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '为什么结束（可省）' },
        reveal: { type: 'boolean', description: '收摊前先公布答案' }
      }
    },
    async execute(ctx, args) {
      const bad = guard();
      if (bad) return { content: bad, isError: true };
      await ensureEngine(); await engine.loadGames?.();
      const r = engine.stopGame?.(cfg(), ctx.chatKey, {
        reason: String(args?.reason || ''), reveal: args?.reveal === true
      }) || { ok: false, say: BROKEN };
      const closedHere = await flushIdleNotices(ctx);
      if (!r.ok) {
        if (!closedHere) await noticeReject(ctx, r.say);
        return { content: r.say || BROKEN, isError: true };
      }
      const delivery = await say(ctx, r.say);
      const sent = isCompleteDelivery(delivery);
      const content = formatAnnouncementOutcome(delivery, {
        label: '收摊消息',
        completeText: `收摊的话已全部发出 ${delivery.sentCount} 条。`,
        fallbackText: `要说的话（原样发出去）：${r.say}`
      });
      return { content, finishTurn: sent };
    }
  });
}

// ── 钩子 ──
//   ① before-llm-messages：把局面注入到最后一条 user 消息（一行；先删旧的再加新的）
//   ② before-tool：泄漏守卫 L1 —— 模型把"不能提前说的东西"（海龟汤汤底）抄进 send_* 参数就拦下
//   ③ after-response：泄漏守卫 L2 —— 模型把它写进**正文**时在源头抹掉
//      （正文补发那条路径不经过 before-tool，所以必须有 L2）
export const hooks = {
  'before-llm-messages': async ({ messages, chatKey }) => {
    if (cfg().enabled === false) return;
    await ensureEngine();
    stripInjection(messages);
    const line = engine.hintLine?.(cfg(), chatKey) || '';
    if (line) appendToLastUser(messages, line);
  },

  'before-tool': async ({ toolName, argsRaw, chatKey }) => {
    if (cfg().enabled === false) return;
    await ensureEngine();
    // 小游戏自己的工具不查：game_start 带 solution 是合法开局参数，
    // game_move 的 text 是群友原话（他自己猜中答案正是游戏的目的）。
    if (String(toolName || '').startsWith('mini-games__')) return;
    const secret = engine.spoilerOf?.(cfg(), chatKey) || '';
    if (!secret) return;
    const chunk = leakMod.leakedChunk?.(String(argsRaw || ''), secret) || '';
    if (!chunk) return;
    return {
      block: true,
      reason: `【泄漏拦截】这次 ${toolName} 里有 ${chunk.length} 个字是这一局**不能提前说出去**的答案，不能发。`
        + '按游戏规则回话（海龟汤只回「是/不是/无关/部分是」），要公布就走 mini-games__game_stop（reveal=true）。'
    };
  },

  'after-response': async ({ response, chatKey }) => {
    if (cfg().enabled === false) return;
    await ensureEngine();
    const secret = engine.spoilerOf?.(cfg(), chatKey) || '';
    if (!secret) return;
    const hits = redactSecret(response, secret);
    if (hits) log(`小游戏：模型正文里抄了不能说的答案，已在发送前抹掉（${hits} 处）`);
  }
};

let idleSweeper = null;
// 2026-10-01 修（R-a · 本批 ②）：activate 是 async（先 await 引擎加载）——"先 activate 不 await、
//   紧接着 deactivate"这个调用序里，deactivate 跑到时定时器还没建出来（idleSweeper 还是 null），
//   清了个寂寞；等 activate 恢复再建就漏清了（竞态窗口 = 首个 await 那段）。这面旗把"停"记在
//   module 级：deactivate 立旗、activate 入口放倒、建定时器**前**检查 —— 恢复后看见立着就不再建。
//   plugin-loader 热重载时序（新旧两个副本各查一次 deactivate）不受影响，仍是幂等清理。
let sweeperStopped = false;

/** 加载时预热（游戏注册表是异步扫描的；工具与钩子都依赖它）。 */
export async function activate() {
  sweeperStopped = false;   // 重新激活：入口先放倒上次 deactivate 立的旗（在第一个 await 之前）
  try { await ensureEngine(); await engine.loadGames?.(); } catch { /* 单个游戏坏了不影响别的 */ }
  try { log(`群内小游戏已加载：${engine.listGames?.().length ?? 0} 个游戏`); } catch { /* 日志无所谓 */ }
  // 闲置快速关闭：每 60 秒把"超过 idleCloseMinutes（配置，默认 5 分钟）没有任何触发"的牌局
  // 清掉（释放状态、不再占用）。纯本地定时器，unref 不拖住进程退出；不碰 Jev、不联网。
  // 工具/钩子入口另有惰性关闭兜底（即使这里没跑到，下一步操作也不会撞上过期的局）。
  if (!sweeperStopped && !idleSweeper && typeof engine.sweepIdleGames === 'function') {
    idleSweeper = setInterval(() => {
      try {
        const n = engine.sweepIdleGames(cfg()) || 0;
        if (n) log(`群内小游戏：${n} 局闲置超时，已自动关闭并释放状态`);
        // C2：定时扫描这条路也要能通知群里（惰性关闭那条在工具执行里 flush）。
        // 手里没有 ctx ⇒ 用工具执行时记下的 noticeSender；还没记下就只写日志、不装作已通知。
        flushIdleNotices(null).catch(() => {});
      } catch { /* 扫失败不影响运行 */ }
    }, 60_000);
    try { idleSweeper.unref?.(); } catch { /* 不支持 unref 就算了 */ }
  }
}

// 2026-10-01（P1-★7）：热重载不泄漏定时器。plugin-loader 对**新旧两个**插件副本都找
//   deactivate 钩子（旧版 index.js 没有这个导出 ⇒ 走不到这里，零影响）；activate 是幂等的
//   （`if (!idleSweeper)` 守卫），deactivate 把句柄清回 null 后可以再次 activate。
//   只清自己模块级的定时器，不碰别的插件。
//   （本批 ② 的 sweeperStopped 旗补住 R-a 竞态：还没建出来的定时器也会被"记账"拦住。）
export function deactivate() {
  sweeperStopped = true;   // 立旗在最前：即使定时器还没建出来（activate 正卡在 await），它也别再建
  if (idleSweeper) {
    clearInterval(idleSweeper);
    idleSweeper = null;
    log('群内小游戏：闲置扫描定时器已停（deactivate）');
  }
}

// ── 内部工具 ──

// ══ C1：判非法也要在群里留一句（2026-10-01 · 本批 ⑥）══
// 原来 `if (!r.ok) return {...}` 直接回给模型，**群里一个字都不发** —— 玩家报了格子/出了拳/
// 猜了数却"没人理"，A1/A2/B3 这类误判因此完全不可见。
// 但 tictactoe.js 头部写明"第三人插手不发消息"是**有意防刷屏**的，所以这里不能无脑每步一条：
//   · 同一局 **60 秒最多一条**（时间窗限流，硬上限，可复算）；
//   · 文案由给模型的拒因**压成一句人话**（只取第一句、去掉工具名与加粗记号、封顶 46 字），
//     绝不把 `mini-games__game_move` 这种工具名发进群；
//   · announceInGroup=false 或没有发送通道时静默（say() 自己会处理）。
const NOTICE_WINDOW_MS = 60_000;
const NOTICE_MAX_KEYS = 200;
const noticeAt = new Map();   // chatKey -> 上一次发过通知的时间
let noticeSender = null;      // 定时器用的发送通道（工具执行时顺手记下）

function shouldNotice(chatKey) {
  const key = String(chatKey || '');
  if (!key) return false;
  const now = Date.now();
  if (now - (noticeAt.get(key) || 0) < NOTICE_WINDOW_MS) return false;
  noticeAt.set(key, now);
  if (noticeAt.size > NOTICE_MAX_KEYS) {
    for (const [k, at] of noticeAt) if (now - at >= NOTICE_WINDOW_MS) noticeAt.delete(k);
    while (noticeAt.size > NOTICE_MAX_KEYS) noticeAt.delete(noticeAt.keys().next().value);
  }
  return true;
}

/** 把"只给模型看的"拒因压成一句能进群的话：取第一句、洗掉工具名/记号、封顶 46 字。 */
function groupNoticeText(raw) {
  const parts = String(raw || '').split(/[。！？\n]+/).map((s) => s.trim()).filter(Boolean);
  let head = parts[0] || '';
  if (head && head.length < 10 && parts[1]) head = `${head}；${parts[1]}`;
  head = head.replace(/mini-games__\S+/g, '小游戏工具').replace(/\*\*/g, '').trim();
  if (!head) return '';
  return `（小游戏：${head.length > 46 ? `${head.slice(0, 45)}…` : head}）`;
}

/** 判非法时给群里补一条**节流过的**短提示（失败不影响判定本身）。 */
async function noticeReject(ctx, reason) {
  try {
    const key = ctx?.chatKey;
    if (!key || shouldNotice(key) === false) return;
    const text = groupNoticeText(reason);
    if (text) await say(ctx, text);
  } catch { /* 通知发不出去就算了，绝不能把判定本身带崩 */ }
}

// ══ C2：闲置自动关闭要通知群里（2026-10-01 · 本批 ⑦）══
// 引擎只管把状态清掉（它没有发送通道），关闭这件事记在一张待发队列里；
// 这里负责发出去，**两条入口都覆盖**：
//   · 惰性关闭（readIdleGame 在工具/钩子里触发）→ 工具执行完顺手 flush；
//   · 定时扫描（idleSweeper 每 60 秒）→ 扫完 flush。
// 没有可用通道时**如实记日志、不装作已通知**。
/** 把闲置关闭的通知发出去。@returns {number} 发到 `ctx.chatKey` 这个会话的条数
 *  （调用方据此决定要不要再叠一条"判非法"提示 —— 局刚被关掉时那条是废话）。 */
async function flushIdleNotices(ctx) {
  let list = [];
  try { list = (typeof engine.drainIdleNotices === 'function' ? engine.drainIdleNotices() : []) || []; } catch { list = []; }
  if (!list.length) return 0;
  // 2026-10-01（P1-★8）：跨群分支（noticeSender.sendTextBatch）与定时器路径（flushIdleNotices(null)）
  //   都绕过了 say() 里的 announceInGroup 开关 ⇒ 这里用**与 say() 同一判定**（cfg().announceInGroup === false）
  //   拦下：关着就不发群、如实写日志（局照关、队列照排空，不假装已通知）；
  //   开着才走下面的分发。say() 自己仍会再判一次（同群分支），双保险不冲突。
  // 2026-10-01 修（R-b · 本批 ①）：闸门原来在 try **之外**整体判一次 —— cfg() 中途一抖，
  //   异常直接冒泡：整批通知全丢（排在后面那群的也发不出去），还把工具整步打成"出错了"。
  //   现在闸门读数挪进 per-item 循环、批内缓存 announceOff（null=未读，true=关着，false=开着）：
  //   读成功整批复用（不重复调 cfg）；读抛错只丢**当一条**（catch 里如实记日志），下一条重问 ——
  //   抖一次不陪葬整批，且异常永远不出这个函数。
  let announceOff = null;   // 批内闸门缓存；null 表示还没读过
  let gateLogged = false;   // ★8 那条闸门日志每批只写一次
  let mine = 0;
  for (const n of list) {
    try {
      if (announceOff === null) announceOff = cfg().announceInGroup === false;
      if (announceOff) {
        if (!gateLogged) {
          gateLogged = true;
          const keys = [...new Set(list.map((x) => x.chatKey))].join('、');
          log(`群内小游戏：announceInGroup 已关闭，${list.length} 条闲置关闭通知不发群（局已自动关闭：${keys}）`);
        }
        continue;
      }
      if (ctx && ctx.chatKey === n.chatKey && typeof ctx.sender?.sendTextBatch === 'function') {
        await say(ctx, n.text);
        mine += 1;
      } else if (typeof noticeSender?.sendTextBatch === 'function') {
        await noticeSender.sendTextBatch(n.chatKey, [n.text]);
      } else {
        log(`群内小游戏：${n.chatKey} 闲置超时已自动关闭（当前没有可用的发送通道，未在群里提示）`);
      }
    } catch (e) {
      // 单条失败（cfg 抖动 / 发送异常）如实记账、绝不往上冒泡 —— 局已经关了，通知失败不陪葬。
      log(`群内小游戏：${n.chatKey} 的闲置关闭通知没发出去（${e?.message ?? e}）`);
    }
  }
  return mine;
}

/**
 * 这一步是谁做的。
 * 优先用"本次唤醒的群友消息"（带真实发送者），拿模型传来的文本里的数字/词对号入座；
 * 对不上就退回最后一个说话的人。**真正的"这一步存不存在"由引擎 groundMove 判定**，
 * 这里只负责认人。
 */
function playerOf(ctx, hint = '') {
  const cands = [];
  const push = (m) => {
    if (!m || m.self) return;
    if (!m.senderId && !m.senderName) return;
    if (engine.looksLikeOwnOutput?.(m.text)) return;
    cands.push(m);
  };
  try { (ctx?.session?.trigger || []).forEach(push); } catch { /* ignore */ }
  // 2026-09-30 修（中）：limit 12 → 40，与引擎 humanMessages 对齐——两边窗口不一致时，
  // 引擎按出处认出的人和 playerOf 认出的人会各说各话（moveGame 取 playerOf 的答案，归属就错）。
  try { (ctx?.store?.recent?.(ctx.chatKey, { limit: 40, includeSelf: false }) || []).forEach(push); } catch { /* ignore */ }
  if (!cands.length) return null;
  const make = (m) => ({ id: String(m.senderId || ''), name: String(m.senderName || m.senderId || '') });
  const tokens = engine.tokensOf?.(hint) || [];
  if (tokens.length) {
    for (let i = cands.length - 1; i >= 0; i -= 1) {
      const t = String(cands[i].text || '');
      if (tokens.some((k) => t.includes(k))) return make(cands[i]);
    }
  } else {
    // 2026-09-30 修（中）：「掷」「过」这类短动作抽不出词元，原来**直接退回最后说话的人**——
    // 最后说话的可能只是接了句"哈哈哈"，动作其实是更早那位说的（引擎 groundMove 是按原话
    // 逐条回找的，认出真说话人；两边不一致时 moveGame 取这里的答案 → 归属错到旁观者头上）。
    // 现在按引擎同款"原话包含该动作"回找；一条都对不上才退回最后说话的人。
    const needle = String(hint || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (needle) {
      for (let i = cands.length - 1; i >= 0; i -= 1) {
        const source = String(cands[i].text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        if (source.includes(needle)) return make(cands[i]);
      }
    }
  }
  return make(cands[cands.length - 1]);
}

/**
 * 由插件直接把这句话发到群里（走 ctx.sender 的发送队列：串行/限频/去重/留档）。
 * @returns {{ attempted: boolean, sentCount: number, blockedCount: number, failedCount: number }}
 */
async function say(ctx, text) {
  const body = String(text || '').trim();
  if (!body) return emptyDeliveryResult();        // 空 = 这一步插件不发（由模型自己说）
  if (cfg().announceInGroup === false) return emptyDeliveryResult();
  try {
    return await deliverAnnouncement(ctx, body);
  } catch {
    return { ...emptyDeliveryResult(), attempted: true, failedCount: 1 }; // 发失败也别吞结果：交给模型说
  }
}

async function deliverAnnouncement(ctx, body) {
  const result = await ctx.sender.sendTextBatch(ctx.chatKey, [body]);
  const recovery = await recoverBlockedSegments(ctx.sender, ctx.chatKey, result);
  const outcome = sendRecoverySummary(recovery);
  const at = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  try {
    for (const item of outcome.delivered) {
      ctx.session?.sent?.push({ type: 'text', text: String(item?.text ?? body), at });
    }
  } catch { /* 留档失败不影响已发出的消息 */ }
  return {
    attempted: true,
    sentCount: outcome.sentCount,
    blockedCount: outcome.blockedCount,
    failedCount: outcome.failedCount,
    retryRounds: outcome.retryRounds,
    exhausted: outcome.exhausted
  };
}

function emptyDeliveryResult() {
  return { attempted: false, sentCount: 0, blockedCount: 0, failedCount: 0 };
}

function isCompleteDelivery(delivery) {
  return delivery?.attempted === true && delivery.sentCount > 0
    && delivery.blockedCount === 0 && delivery.failedCount === 0;
}

function formatDeliverySummary(label, delivery) {
  return `${label}发送不完整：已确认发出 ${delivery.sentCount} 条；被拦 ${delivery.blockedCount} 条；结果不确定 ${delivery.failedCount} 条。`;
}

function formatAnnouncementOutcome(delivery, { label, completeText, fallbackText }) {
  if (isCompleteDelivery(delivery)) return completeText;
  return delivery.attempted ? formatDeliverySummary(label, delivery) : fallbackText;
}

function formatMoveDeliveryTail(result, delivery) {
  if (delivery.attempted && !isCompleteDelivery(delivery)) {
    const ended = result?.over === true;
    return `（${ended ? '这局已结束；' : ''}${formatDeliverySummary('结果消息', delivery)}${ended ? '不要重放出牌动作。' : ''}）`;
  }
  if (isCompleteDelivery(delivery)) {
    return result?.over === true
      ? '（这局结束了，结果消息已全部发出；要补一句话由你决定，但别复述结果。）'
      : '（结果消息已全部发出。没别的话就结束这一轮，别再复述。）';
  }
  return result?.over === true
    ? '（这局已结束；插件没有发出结算消息。不要重放出牌动作。）'
    : '';
}

/** 删掉历史里所有旧的注入行（只认我们自己那种单行标记）。 */
function stripInjection(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  for (const m of arr) {
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') {
      if (m.content.includes(MARK)) m.content = m.content.replace(INJECT_RE, '').replace(/\n+$/, '');
      continue;
    }
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && typeof part.text === 'string' && part.text.includes(MARK)) {
          part.text = part.text.replace(INJECT_RE, '').replace(/\n+$/, '');
        }
      }
    }
  }
}

/** 把一行局面追加到最后一条 user 消息末尾（原地改，不改结构）。 */
function appendToLastUser(messages, lineText) {
  const arr = Array.isArray(messages) ? messages : [];
  const last = [...arr].reverse().find((m) => m && m.role === 'user');
  if (!last) return false;
  const suffix = `\n${lineText}`;
  if (Array.isArray(last.content)) {
    const texts = last.content.filter((p) => p && p.type === 'text');
    if (!texts.length) return false;
    const cur = String(texts[texts.length - 1].text || '');
    if (cur.includes(MARK)) return false;
    texts[texts.length - 1].text = `${cur}${suffix}`;
    return true;
  }
  if (typeof last.content !== 'string') return false;
  if (last.content.includes(MARK)) return false;
  last.content = `${last.content}${suffix}`;
  return true;
}

/** L2：把模型正文里的答案抹掉（整段都是答案就干脆不发）。 */
function redactSecret(response, secret) {
  const msg = response?.message;
  if (!msg) return 0;
  let hits = 0;
  if (typeof msg.content === 'string') {
    const r = leakMod.stripSecret?.(msg.content, secret) || { hits: 0 };
    if (r.hits) {
      msg.content = (String(r.text).replace(/（略）/g, '').trim().length < 4) ? null : r.text;
      hits += r.hits;
    }
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part && typeof part.text === 'string') {
        const r = leakMod.stripSecret?.(part.text, secret) || { hits: 0 };
        if (r.hits) { part.text = r.text; hits += r.hits; }
      }
    }
  }
  return hits;
}

// 测试出口（不参与运行时逻辑）
export const internals = {
  playerOf, stripInjection, appendToLastUser, redactSecret, deliverAnnouncement,
  formatDeliverySummary, formatAnnouncementOutcome, formatMoveDeliveryTail, DATA_DIR,
  REQUIRED_EXPORTS,
  setEngineForTest(value) { engine = value; engineReady = Promise.resolve(value); engineError = ''; }
};
