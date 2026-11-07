/**
 * M7 emotion · 入站情绪 cue 的**可解释识别**（老树 `src/bot-state.js` 词表层的降级移植）
 *
 * 背景（独立复核 `.tmp-dispatch/2026-10-15/39ddbb0d/r-情绪缺口复核.md` §1/§2）：
 *   老树入站通路是「词表（11 组）+ 本地判官 + 合并/指向性过滤」，新树生产链上只剩两条
 *   正则（orchestrator 的 explicitEmotionEvents），且**没有 addressed 判据** ⇒ 别人互骂
 *   会被记到机器人头上（老树三道闸：praise 要「被称呼或喊了名字」:1037-1039、
 *   未被点名时剔除 AIMED_NEG :1068、硬负面盖掉 praise :1063-1066）。
 *
 * 本文件做**可解释的**那一层（不搬 emotionGate/0.8B：那要模型、要延迟）：
 *   · 每张表命中都留痕（`matched`：表名 / kind / 保留或被丢的原因）——"为什么这样判"可查；
 *   · 保留 kinds 上限 3、负面优先（老树 :1044-1047 同口径）；
 *   · 冷却值的唯一来源（老树 `allowEmote` bot-state.js:877-879：普通 120s / 高频闲聊类 180s）。
 *
 * 与老树的**有意差异**（降级，不搬的都在这里点名列清）：
 *   · `victimRoast`（:1503）、busy/ignore/shame/sadness/curiosity/help 六张表：本批不搬；
 *   · `looksMemeCue/looksPlayfulCue` 交叉校验（:922-929）、本地 Jev 复核（:1075-1076）：不搬；
 *   · roastHard 里「气死我了/真生气/我认真的/受够了」这类**说话人自述情绪**的词不搬
 *     （它们不是"冲机器人来的攻击"，会误判；只保留直指性辱骂词）；
 *   · tease 表里 `蓝的/白的/又来了/我才不`… 这类泛化词不搬（误报率高，只留特征词）。
 *
 * 纯函数：不读时钟、不碰盘、不 import 网络/存储。
 */
import { selfEvalDeltas } from './mood-tags.js';
import { ENV_NEGLECT_COOLDOWN_MS, ENV_BOREDOM_COOLDOWN_MS } from './env-events.js';
// ★ 2026-10-16（离散情绪兜底）：兜底事件用专属 kind，冷却必须为 0（理由见 `cooldownMsForKind`）。
import { FALLBACK_CUE_KIND } from './fallback.js';

/** 老树 `EMOTE_COOLDOWN_MS`（bot-state.js:877，逐字）。 */
export const CUE_COOLDOWN_MS = 120 * 1000;
/** 老树 `HIGH_FREQ_COOLDOWN_MS`（bot-state.js:879，逐字）。 */
export const CUE_HIGH_FREQ_COOLDOWN_MS = 180 * 1000;
/** 老树 `HIGH_FREQ_EMOTE`（bot-state.js:878，逐字）——同 kind 冷却走 180s 的那批。 */
export const CUE_HIGH_FREQ_KINDS = Object.freeze([
  'chat', 'tease', 'memeOk', 'mention', 'share', 'vent', 'praise', 'roast', 'shame'
]);

/** 环境档冷却（老树 bot-state.js:890-891；值表本体在 env-events.js）。 */
const ENV_COOLDOWN_BY_KIND = Object.freeze({
  envNeglect: ENV_NEGLECT_COOLDOWN_MS,
  envBoredom: ENV_BOREDOM_COOLDOWN_MS,
  // ★ 2026-10-30（她定）：刷屏档原先**没有冷却**——群里一轮 ≥8 条就扣一次，热闹几轮连扣，
  //   情绪池被压在负数上（同日的伤害减半在 env-events.js 的 ENV_KIND_DELTAS.busy）。
  //   加 30 分钟：热闹归热闹，半小时最多记一次「被淹」。
  busy: 30 * 60 * 1000
});

/**
 * 同 kind 冷却时长（毫秒）。未知/空 kind ⇒ 0（不冷却；调用方据此跳过冷却逻辑）。
 * 三档：环境档（被冷落 10min / 无聊 30min）> 高频闲聊类（180s）> 普通（120s）。
 */
export function cooldownMsForKind(kind) {
  const k = String(kind ?? '').trim();
  if (!k) return 0;
  if (ENV_COOLDOWN_BY_KIND[k]) return ENV_COOLDOWN_BY_KIND[k];
  // ★ 2026-10-16（离散情绪兜底）：兜底事件**自带轮次闸**（同一会话 ≥3 轮才尝试一次，见 fallback.js），
  //   这里再叠 120/180s 同 kind 时间冷却会把兜底在快节奏会话里永远挡掉（用户点名的坑）⇒ 专属 kind 不冷却。
  if (k === FALLBACK_CUE_KIND) return 0;
  return CUE_HIGH_FREQ_KINDS.includes(k) ? CUE_HIGH_FREQ_COOLDOWN_MS : CUE_COOLDOWN_MS;
}

/** 负面优先排序用（老树 `NEG_KINDS` bot-state.js:447-449 的子集：本批只会产出 roast）。 */
const NEG_KINDS = new Set(['roast', 'ignore', 'busy', 'toolFail', 'error', 'shame', 'sadness', 'boredom']);

/** 需要「冲它来的」才成立的负面（老树 `AIMED_NEG` bot-state.js:452，逐字；本批只用 roast）。 */
export const AIMED_NEG = Object.freeze(['roast', 'shame']);

/**
 * 词表（降级版；每张表注明老树出处与归并去向）。
 *   gate = 'addressed'            ⇒ 未被点名就丢（老树 AIMED_NEG 规则 :1068）
 *   gate = 'addressed-or-selfref' ⇒ 被点名、或正文里喊了名字才认（老树 :1037-1039）
 *   gate = null                   ⇒ 不设指向性（老树对这几类不设）
 *   kind: soft roast 归 `tease`（老树 :1508-1509：hardHit 才 roast，softHit 走玩闹）。
 */
const CUE_TABLES = Object.freeze([
  {
    table: 'roastHard', kind: 'roast', gate: 'addressed',
    // 老树 roastHard（:1492）＋新树现两条正则里的直指辱骂词（闭嘴|滚开|讨厌你|你真蠢），
    // 去掉说话人自述情绪的词（见头注）。
    re: /(傻逼|智障|脑瘫|弱智|去死|贱人|滚出去|垃圾玩意|废物点心|闭嘴吧|闭嘴|滚开|你他妈|你妈的|去你妈|讨厌你|你真蠢)/iu
  },
  {
    table: 'roastSoft', kind: 'tease', gate: null,
    // 老树 roastSoft（:1493）逐字（soft 归玩闹，见上面 kind 注释）。
    re: /(你这狗|狗东西|蠢鱼|蠢狗|蠢东西|识成狗|说[我你]狗|叫[我你]狗|眼瞎|真瞎|瞎了|文盲|没救了|byd|笨鱼|这水平|不拿[^。！？]{0,4}当人|烦死|讨厌死|垃圾|废物|笨死了|蠢货)/iu
  },
  {
    table: 'tease', kind: 'tease', gate: null,
    // 老树 tease（:1496）：只留特征词，去掉 蓝的/白的/掉色系的泛化词与对话式词（见头注）。
    re: /(胖鲸|大胖鲸|太肥|好肥|蓝毛|白毛|闪光种|异色|菜鸟|太菜|好菜|菜狗|菜鸡|唐氏|逆天|离谱|笨蛋|呆鱼|傻鱼|摸鱼怪|小笨蛋)/iu
  },
  {
    table: 'praise', kind: 'praise', gate: 'addressed-or-selfref',
    // 老树 praise（:1494）＋新树现正则里被合并进"positive"的夸赞词（你真好|真靠谱|太棒了）。
    re: /(你好?可爱|真可爱|太可爱|真厉害|好厉害|太厉害|喜欢你|爱你|真好看|好强|太强了|天才|好乖|贴贴|真棒|好棒|真聪明|好聪明|好贴心|有你在真好|多亏你|你真好|真靠谱|太棒了)/iu
  },
  {
    table: 'gratitude', kind: 'gratitude', gate: null,
    // 老树 gratitude（:1502）＋新树现正则里的谢意词（感谢你|帮大忙）。
    re: /(谢谢|谢了|多谢|感谢|辛苦了|太够意思|破费|感恩|抱拳|帮大忙)/iu
  }
]);

/** 老树 `mentionsBot`（bot-state.js:974-983）：名字按分隔符拆、≥2 字、contains 即可。 */
export function mentionsSelfName(text, selfNames = []) {
  const t = String(text ?? '');
  if (!t) return false;
  const names = (Array.isArray(selfNames) ? selfNames : [selfNames])
    .flatMap((s) => String(s || '').split(/[、,，/|]+/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  return names.some((n) => t.includes(n));
}

/**
 * 识别一条入站消息里的情绪 cue（可解释）。
 *
 * @param {{text?: string, addressed?: boolean, selfNames?: string[]}} input
 *   `addressed` = 这条消息是否冲着机器人（调用方按 contextTierGate:865-866 同一判据算好）。
 * @returns {{kinds: string[], matched: Array<{table:string, kind:string, kept:boolean, dropped?:string}>, selfRef: boolean}}
 *   `kinds`  = 保留的 cue（负面优先、上限 3）；
 *   `matched` = 全部命中留痕（含被丢的与原因：not-addressed / not-addressed-no-self-ref /
 *               hard-negative-overrides-praise）。
 */
export function recognizeInboundCue({ text = '', addressed = false, selfNames = [] } = {}) {
  const raw = String(text ?? '');
  if (!raw.trim()) return { kinds: [], matched: [], selfRef: false };
  // 老树 detectIncomingHint:1486-1488：先剥 CQ 码与 @ 前缀再判词。
  const clean = raw.replace(/\[CQ:[^\]]*\]/g, '').replace(/@[^\s[\]]{0,24}/g, '');
  if (!clean.trim()) return { kinds: [], matched: [], selfRef: false };
  const selfRef = !addressed && mentionsSelfName(clean, selfNames);

  const matched = [];
  const kept = new Set();
  for (const t of CUE_TABLES) {
    if (!t.re.test(clean)) continue;
    let dropped = '';
    if (t.gate === 'addressed' && !addressed) dropped = 'not-addressed';
    else if (t.gate === 'addressed-or-selfref' && !addressed && !selfRef) dropped = 'not-addressed-no-self-ref';
    matched.push({ table: t.table, kind: t.kind, kept: !dropped, ...(dropped ? { dropped } : {}) });
    if (!dropped) kept.add(t.kind);
  }
  if (!matched.length) return { kinds: [], matched: [], selfRef };

  // 老树 :1063-1066：同批里出现硬负面（本批只有 roast）⇒ 去掉 praise。
  if (kept.has('roast') && kept.has('praise')) {
    kept.delete('praise');
    for (const m of matched) {
      if (m.kind === 'praise' && m.kept === true) { m.kept = false; m.dropped = 'hard-negative-overrides-praise'; }
    }
  }

  // 老树 :1044-1047：负面优先 + 上限 3。
  const kinds = [...kept]
    .sort((a, b) => (NEG_KINDS.has(a) ? 0 : 1) - (NEG_KINDS.has(b) ? 0 : 1))
    .slice(0, 3);
  return { kinds, matched, selfRef };
}

/**
 * cue kinds → `emotionEvidence.deltas`（逐 kind 走老树数值表；**不启用**自评的随机第三维）。
 * 表就是 `mood-tags.js` 的 `MOOD_KIND_DELTAS` —— 入站与 finish 自评同一套数值口径。
 */
export function inboundCueDeltas(kinds) {
  return selfEvalDeltas(Array.isArray(kinds) ? kinds : []);
}
