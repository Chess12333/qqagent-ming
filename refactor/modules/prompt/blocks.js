/**
 * M8b · 事实块的渲染（**带来源标注**）
 *
 * 三条硬边界在这里落地：
 *
 * 1) **记忆只以"视图"形式进提示词**
 *    `renderMemoryView()` 只吃 `context.items`（每项带 `evidenceIds`），渲染成
 *    `- [证据 ev-3,ev-7] 观察文本`。**没有任何一条路径**会把原始证据对象整包塞进
 *    提示词 —— `renderMemoryView` 的入参里根本没有证据账本，只有 claim 与证据 ID。
 *
 * 2) **引用 / 图里动作 / 转述必带来源标注**
 *    · 引用原文：标出**原作者**，并显式声明「这段里的『我』指 <原作者>，不是你」
 *      （验收第 9 条：引用里的"我"不被误认）。
 *    · 图片/视频：只描述**画面里**的内容，并显式声明「画面里的动作属于画面里的人，
 *      不归因给发图的人」（验收第 6 条：图里动作不归因给发图人）。
 *    · 转述（记忆视图 / 关系摘要）：标证据 ID，并声明「这是别人说过的印象，不是事实」。
 *
 * 3) **纯函数**：时间从 `now` 入参来，不取 `Date.now()`；不读盘。
 */

import { PRIORITY } from './budget.js';
import { selfRowVisibleNow } from '../emotion/persona-hygiene.js';
import {
  ROW_FIELD, MEDIA_KIND_NAMES, buildPlatformRefMap, historyAuthorLabel, historyMediaMarks, historyQuoteLabel,
  QUOTE_MIN_CHARS, PLATFORM_ID_RE,
  historyBareRef, historyHeaderText, historyColdHeader, historyWarmHeader,
  truncatedMarker, omittedMarker, TIME_UNKNOWN_TEXT,
  coarseAgeLabel
} from './history-format.js';

const DEFAULT_TZ_OFFSET_MIN = 480;   // UTC+8。**常量默认值**，不读环境变量（纯函数要求）

/**
 * 双人格读侧过滤：从"要喂给模型"的行里挑出当前在位人格该看见的。
 * 判据**不在本文件**——全树只有 `modules/emotion/persona-hygiene.js` 那一份（compose 侧 import 同一个符号）。
 * 非己行（群友）恒可见；无 `persona2` 标的自发言 = 第一人格写的 ⇒ **第一人格在位时与改动前逐字节一致**（存量零迁移）；
 * 红在位时这类行是否隐去，由 `hideFirstPersonaHistory` 决定（defaults 为 true ⇒ 两个方向都隔离）。
 * 默认 `personaTwo=false`（第一人格在位）⇒ 调用方漏传时走"隐去红期间行"这一侧，不放宽。
 * @returns {{rows:Array, hidden:number}}
 */
export function personaVisibleRows(rows, { personaTwo = false, hygiene = {} } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === 'object');
  const kept = list.filter((row) => selfRowVisibleNow(row, { personaTwo: personaTwo === true, hygiene }));
  return { rows: kept, hidden: list.length - kept.length };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 把时间戳格式化成「2026-10-05 03:04:05」。
 * @param {number} at 时间戳
 * @param {number} now 参照的"现在"（由入参给）
 * @param {number} tzOffsetMinutes 时区偏移（常量默认 480）
 */
export function formatAt(at, now, tzOffsetMinutes = DEFAULT_TZ_OFFSET_MIN) {
  const ms = Number(at);
  if (!Number.isFinite(ms)) return '时间未知';
  const d = new Date(ms + tzOffsetMinutes * 60000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} `
    + `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/**
 * 历史行 / 本次输入行的行首时间：照老树 `src/util.js:81-84` `formatShortTime` —— `[MM-DD HH:MM]`，
 * **无年份、无秒**（老树实测冷历史块里每行白写 13 字是完整时间戳，`src/prompt.js:928-931`）。
 * ★ 与 `formatAt`（精确到秒、诊断与本轮上下文用）的分工：给模型看的行首只用这一份短写法。
 * ⚠ **不照搬老树的"同分钟整段不写 / `+Nm`"**：那两条要看前一行的时间（`prevTs`），窗口起点每轮
 *   滑一条就会整块错位；新树的冷藏切点还没粘住（任务 #66，归 luna1），所以这一版每行都写完整短时间。
 */
export function formatShortAt(at, tzOffsetMinutes = DEFAULT_TZ_OFFSET_MIN) {
  const ms = Number(at);
  if (!Number.isFinite(ms)) return TIME_UNKNOWN_TEXT;
  const d = new Date(ms + tzOffsetMinutes * 60000);
  return `[${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}]`;
}

/** 相对时间（参照 `now`，不取系统时间）。 */
export function sinceLabel(at, now) {
  const a = Number(at);
  const n = Number(now);
  if (!Number.isFinite(a) || !Number.isFinite(n)) return '';
  const sec = Math.max(0, Math.round((n - a) / 1000));
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.round(hr / 24)} 天前`;
}

function clip(s, max) {
  const t = String(s ?? '');
  if (!Number.isFinite(max) || max <= 0 || t.length <= max) return t;
  return t.slice(0, max) + `…（已截 ${t.length - max} 字）`;
}

/* ═══════════════════════════════════════════════════════════════════════
 * 单条证据（MessageEvidence, §3.1）→ 事实行
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * 本轮判定标签（照老树 `src/prompt.js:1510-1538` `triggerLabels`）：行尾 `（@我/提问）` 这种短标签。
 * ★ 判据用**新树的结构化字段**（`mentions` / `refs`），不照搬老树的正则 —— 老树注释自己记着
 *   `text.startsWith('@')` 把"@ 别人"也标成"@我"的坑（`:1519-1523`），而 §3.1 冻结字段里已经按 QQ 号判过了。
 * ★ 老树那条「提到我（备注名）」**没照搬**：它拿的是**发言人自己**的备注名（`notes[entry.senderId]`）
 *   去正文里找，跟"提到我"没关系，是老树的一处错判；要加得先按"我的备注名"重写判据，那是新行为不是照搬。
 */
function triggerLabels(e, { selfName = '' } = {}) {
  const text = String(e?.text ?? '');
  const lower = text.toLowerCase();
  const labels = [];
  const mentions = Array.isArray(e?.mentions) ? e.mentions : [];
  if (mentions.some((m) => m?.isSelf === true)) labels.push('@我');
  else if (mentions.some((m) => m?.isSelf !== true)) labels.push('@别人');
  const name = String(selfName ?? '').trim();
  if (name && lower.includes(name.toLowerCase())) labels.push('提到我');
  if (/[?？]\s*$/.test(text.trim()) || /[吗呢]/.test(text)) labels.push('提问');
  if (e?.refs?.quoted) labels.push('引用');
  // 「冲你来的」与「引用了谁」是两件事实，改前是 else-if：一条**带引用的**回复只会写「引用」，
  //   那句"这条是冲你来的"（改前的独立一行）就随格式一起丢了。两个标签各自独立判断，最多共存四个字符。
  if (e?.refs?.toSelf === true) labels.push('回复你');
  if (text.includes('[拍一拍]')) labels.push('拍一拍');
  return labels;
}

/**
 * 渲染一条证据（§3.1 冻结字段）。**2026-10-14 照搬老树密度：一条消息一行**。
 * 老树 `buildTriggerBlock`（`src/prompt.js:1541-1557`）就是"历史行同一个渲染器 + 行尾短标签"；
 * 改前新树把同一条消息拆成 消息/时间/群聊/发信人/正文/说明/引用/媒体 4~10 行，是两块里最贵的一处。
 * ★ 收成一行的同时**没有丢掉的事实**：
 *   · 「这条是群聊还是私聊」——【本轮上下文】与【会话】已经写了本轮的会话类型，逐条再写一遍是重复；
 *   · 「这条离现在多久」——行首 `[MM-DD HH:MM]` + 【会话】里的本轮时间，模型自己算得到；
 *   · 「@ 了谁 / 引用了谁 / 带没带图」——变成行尾标签与行内 `[引用 …]`、行内 `[图片]`；
 *   · **认出来的画面内容**（`画面描述` / `画面文字`）仍然逐条给：老树把原图挂在动态 user 末尾、
 *     模型看得见像素，新树的 `get_message_images` 只认**本轮**候选编号，这份识别文字是画面唯一通道。
 * ★ 改前那句 `引用编号：replyToMessageId=…` **不再单独成行**：它给的是被引那条的 **QQ 消息号**，
 *   而工具参数要的是行首那种 `#短编号`（`act/index.js:267/273` 的说明、`:766-775` 的归一与存在性校验）⇒
 *   照抄它必然被执行侧拒。这一条不是"省掉信息"，是省掉一个抄了会失败的号码；本地编号的透传缺来源，已另报。
 * @returns {{text:string, mediaChars:number}}
 */
export function renderEvidence(e, { now, maxMediaDescChars = 200, selfName = '', notes = {}, batchRefs = null } = {}) {
  // 发信人标签与历史行同一个函数（`history-format.js` 的 `historyAuthorLabel` → `memory/author-label.js`），
  // 同一批人在两处必须是同一个长相，否则模型分不清是不是同一个人。
  // ★ 2026-10-31（溟）：原来这里把 self 写死成 false —— 证据永远是入站消息，靠场景保证「不是我说的」。
  //   场景确实保证得住（message_sent 在 scenario/evidence.js 就被 continue 掉、自己 id 的回执在
  //   onebot-link 也被丢），所以线上没出过事；但**这是靠上游不出事撑着的**，一旦哪天有路径把
  //   我自己的话塞进 evidence（重放、主动轮、合成消息），这一行就会把我的话标成「私聊对方」。
  //   所以显式认上游给的 self 标记：给了就照它，没给才退回 false（行为与今天一致）。
  const evidenceSelf = e?.self === true || e?.sender?.self === true;
  const who = evidenceSelf ? '我' : historyAuthorLabel(
    { [ROW_FIELD.senderName]: e.sender?.name, [ROW_FIELD.senderId]: e.sender?.id, [ROW_FIELD.self]: false },
    { notes, kind: e.kind === 'private' ? 'private' : 'group' }
  );
  // ★ 2026-10-19（第六批 · 引用链收口）：被引正文/原作者/可回编号（目标在本轮时）都进主模型上下文。
  //   `batchRefs` = 本轮可见消息 id 集合（prompt/index.js 传入）；历史行那一路仍走 refMap。
  const quote = historyQuoteLabel(e.refs?.quoted, {
    notes, maxQuoteChars: Math.max(QUOTE_MIN_CHARS, maxMediaDescChars * 3), batchRefs
  }) || (e.refs?.replyTo
    // 有 reply 段但原文没解析出来：明说"原消息未取得"；目标 ID 是原始 QQ 号（负号/长数字原样），
    // 不像 QQ 号就不写 id。绝不留空、也绝不让当前消息正文冒充引用原文。
    ? (() => {
      const rid = String(e.refs.replyTo).replace(/^[#＃]/, '').trim();
      return PLATFORM_ID_RE.test(rid)
        ? `[引用（原消息未取得：QQ${rid}）]`
        : '[引用（原消息未取得）]';
    })()
    : '');
  const rawBody = String(e.text ?? '').replace(/\r?\n/g, ' / ').trim();
  const body = rawBody || '（这条没有文字）';
  const marks = (Array.isArray(e.media) ? e.media : []).map((md) => {
    const name = MEDIA_KIND_NAMES[md?.type] || '媒体';
    // ★ 行内**只放占位符**，识别出来的画面内容全在下面那两行（`画面描述` / `画面文字`）逐条给。
    //   以前这里也把 `desc` 内联进来，同一段文字在一行里出现两遍。
    return `[${name}]`;
  }).join('');
  const labels = triggerLabels(e, { selfName });
  const lines = [`${formatShortAt(e.at)} #${e.id} ${who}：${quote}${body}${marks}${labels.length ? `（${labels.join('/')}）` : ''}`];

  // ── 画面内容：认出来的才写（一行一份），没认出来就只留上面那个占位符。
  let mediaChars = 0;
  for (const md of e.media || []) {
    const desc = clip(md.desc || '', maxMediaDescChars);
    const ocr = clip(md.ocr || '', maxMediaDescChars);
    mediaChars += desc.length + ocr.length;
    const label = md.type === 'image' ? '图片' : md.type === 'sticker' ? '表情包' : '视频';
    if (desc) lines.push(`  ${label}画面描述：${desc}`);
    if (ocr) lines.push(`  ${label}画面文字：${ocr}`);
  }

  return { text: lines.join('\n'), mediaChars };
}

/* ═══════════════════════════════════════════════════════════════════════
 * 记忆视图（M6 retrieve() 的输出）
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * 渲染记忆视图。
 * **硬边界**：只吃 `context.items`（`{claim, scope, evidenceIds[], confidence, at}`），
 * **不吃**原始证据账本。每一行都带证据 ID；没有证据 ID 的条目**不许进提示词**
 * （「模型说出来」≠ 事实；无来源的记忆是传闻）。
 *
 * @param {object} context M6 retrieve() 输出：`{ items, dropped, topic, need }`
 * @param {object} opts { now, maxItems, selfName }
 * @returns {{text:string, used:Array, skipped:Array}}
 */
export function renderMemoryView(context, {
  now, maxItems = 12, selfName = '', heading = '', stableOrder = false
} = {}) {
  const items = Array.isArray(context?.items) ? context.items : [];
  const scored = items.map((it, i) => {
    const ids = Array.isArray(it?.evidenceIds) ? it.evidenceIds.filter((x) => x !== null && x !== undefined && x !== '') : [];
    const conf = Number(it?.confidence);
    // ★ 2026-10-16：**未上报的置信不许写成 0**。语义召回腿（coordinator）按小契约只给 score，
    //   不带 confidence（`semantic.js:757-761` 融合时还优先放语义项）⇒ 旧渲染会把这类条目
    //   印成「置信 0」，既像低置信又误导排序观感。这里区分「未报」与「真的是 0」：
    //   排序仍按 0 参与（不改顺序行为），**展示**照实说未报。
    const confKnown = Number.isFinite(conf);
    return {
      i,
      claim: String(it?.claim ?? '').trim(),
      scope: String(it?.scope ?? 'global'),
      ids,
      conf: confKnown ? conf : 0,
      confKnown,
      at: Number(it?.at),
      hasEvidence: ids.length > 0
    };
  });
  // 优先级：① 有证据的 ② confidence 高 ③ 近的。**无证据的一律排到最后并单独标注**
  const ranked = [...scored].sort((a, b) => {
    if (a.hasEvidence !== b.hasEvidence) return a.hasEvidence ? -1 : 1;
    if (b.conf !== a.conf) return b.conf - a.conf;
    return (b.at || 0) - (a.at || 0);
  });
  const used = ranked.filter((s) => s.hasEvidence).slice(0, maxItems);
  // 先照原规则选条目，再给已选集合定序；不冻结召回结果，不把低分项换进来。
  if (stableOrder) {
    const keys = new Map(used.map((row) => [row, String(items[row.i]?.id ?? items[row.i]?.observationId ?? '')
      || JSON.stringify([row.scope, row.ids.slice().sort(), items[row.i]?.at ?? null, row.claim])]));
    used.sort((a, b) => keys.get(a) < keys.get(b) ? -1 : keys.get(a) > keys.get(b) ? 1 : 0);
  }
  const skipped = ranked.filter((s) => !used.includes(s));

  const lines = [heading || '【记忆视图】以下条目都是**过去有人说过、留了出处**的印象，不是本轮的新事实；引用它们时要记得它们只是印象：'];
  if (!used.length) lines.push('（本次没有可用的、带证据的记忆条目）');
  for (const s of used) {
    const when = Number.isFinite(s.at) ? ` · ${formatAt(s.at, now)}` : '';
    lines.push(`- [证据 ${s.ids.join(',')}] （scope=${s.scope}；置信 ${s.confKnown ? s.conf : '未报'}${when}）${s.claim}`);
  }
  const noEvidence = skipped.filter((s) => !s.hasEvidence);
  if (noEvidence.length) {
    lines.push(`- 另有 ${noEvidence.length} 条**没有证据 ID** 的记忆条目，按「无出处不算事实」的纪律**未注入**。`);
  }
  const overLimit = skipped.filter((s) => s.hasEvidence);
  if (overLimit.length) {
    lines.push(`- 另有 ${overLimit.length} 条带证据的记忆条目因名额（${maxItems} 条）未注入。`);
  }
  return { text: lines.join('\n'), used, skipped };
}

/** 仅压缩提示词里的旧迁移包装；摘要原文与完整来源 id 仍留在存档。 */
export function renderEpisodeSummary(entry, { compact = false } = {}) {
  let summary = String(typeof entry === 'string' ? entry : entry?.summary ?? '').trim();
  if (!summary) return '';
  const id = String(entry?.id ?? '').trim();
  let source = id;
  if (compact) {
    if (id.startsWith('legacy:')) {
      summary = summary
        .replace(/\[CQ:at,qq=([^,\]\r\n]+)(?:,[^\]\r\n]*)?\]/gi, '@$1')
        .replace(/\[markdown\]/gi, '[富文本]')
        .replace(/\[inline_keyboard\]/gi, '[按钮]');
    }
    if (id.length > 48) source = `${id.startsWith('legacy:') ? '旧版情节' : '情节'}·ID尾号 ${id.slice(-12)}`;
  }
  return `- ${source ? `[${source}] ` : ''}${summary}`;
}

/* ═══════════════════════════════════════════════════════════════════════
 * 本地双方近期聊天（ChatStore 冷段 + 热段的有界窗口）
 * ═══════════════════════════════════════════════════════════════════════ */

function historyTime(row) {
  const value = row?.ts ?? row?.at;
  if (value === null || value === undefined || value === '') return NaN;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Date.parse(String(value));
}

// 2026-11-01（溟）：`slice` 按 UTF-16 码元切，正好切在 emoji 的代理对中间时会留下孤立高位代理
//   （\ud83d 这种），送到模型 API 那边 utf-8 编码直接 502（surrogates not allowed）。
//   私聊 13:25 起连挂十轮就是它。截断没问题，切在半个字上才是问题 —— 按码点收尾。
function safeCharSlice(value, maxChars) {
  const n = Math.max(0, Number(maxChars) || 0);
  if (value.length <= n) return value;
  let end = n;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // 别把高位代理留在末尾
  return value.slice(0, end);
}

export function historyBody(text, maxChars) {
  const value = String(text ?? '').replace(/\r?\n/g, ' / ').trim() || '（存档中没有可读正文）';
  return value.length > maxChars ? `${safeCharSlice(value, maxChars)}${truncatedMarker()}` : value;
}

/* ═══════════════════════════════════════════════════════════════════════
 * 自己历史发言的清洗（N61 补丁 · 老树 `src/prompt.js:1324-1366` 逐字搬）
 *
 * ★ 为什么必须有：存档里"自己说过的话"留的是**占位符格式**（`[表情包:贴贴]`、`[图片]`），
 *   模型下一轮读到就照这个格式抄 —— 管理员 09-11 17:2x 实测「打成括号形式了，气笑了」。
 *   ⇒ **留什么格式，它就抄什么格式**，所以喂回去之前必须洗干净。
 * ★ 门是 `store.sanitizeSelfStyle`，**默认开**（老树 `!== false` 口径）；
 *   新树此前 0 处读点 ⇒ 这个门从来没生效过（qwen1 N61 补丁点名的）。
 * ⚠ `sanitizeSelfImageClaim` 按老树 1368-1371 的"兼容旧调用"处理：**直接返回原文**
 *   （管理员已提供真实照片，不再从历史里清洗「这是我」类发言）。
 * ═══════════════════════════════════════════════════════════════════════ */

/** 这条"自己的发言"其实只是表情/图片的记录吗（存档用它当占位）。 */
export function isSelfMediaMarker(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  return /^[\[【]\s*(表情|表情包|图片|贴图)\s*[:：]?[^\]】]*[\]】]$/.test(t)     // [表情包:贴贴] / [图片]
    || /^[（(【\[]?\s*(我)?\s*(给你)?\s*(发了?|来|扔|甩|贴|塞)(了|个|一张|张)?\s*[^）)】\]]{0,30}?(表情包?|贴图)\s*[）)】\]]?$/.test(t)
    // 连"描述式"的也算：模型被要求发表情却没工具，就写「（发了个绿发小恶魔抱紧你的表情）」
    // 这种当话发出去过（17:17 私聊），留着就继续被抄。
    || /^[（(【\[]\s*(我)?\s*(发了?|来|扔|甩|贴|塞)(了|个|一张|张)?[^）)】\]]{0,30}表情[^）)】\]]{0,20}[）)】\]]$/.test(t);
}

/** 兼容旧调用：管理员已提供真实照片，不再从历史里清洗「这是我」类发言。 */
export function sanitizeSelfImageClaim(text) {
  return String(text ?? '');
}

/** 自己发言的风格清洗：剥"图片 #N 描述："腔、换掉 QQ 表情内部 id、删占位符、收波浪号/叠字/句尾语气词。 */
export function tidyOwnStyle(text) {
  return String(text ?? '')
    // 「图片 #N 描述：…」是模型对着图写标注的腔调（2026-09-21 22:43 实测一次吐了 7 条）。
    // 存档里留着，下一轮它就读到「我：图片 #1 描述：…」并当范文抄 → 前缀直接剥掉。
    .replace(/^图片\s*#?\d*\s*描述\s*[：:]\s*/g, '')
    // QQ 表情的内部 id 会漏进文字（实测 09-11 19:20 群里出现「em_jb_微笑」，
    // 号A 在历史里看到它，原样抄着发了一遍）。这种记号一律换成正式写法。
    .replace(/\bem_[a-z]+_[^\s，。！？、,.!?]{1,20}/g, '（表情）')
    // 存档里表情/图片是用方括号标记记的（[表情包:名字]、[图片]）。
    // ⚠️⚠️ 这里**必须直接删掉，不能换成任何替代文字**：
    //    第一版我换成了「（发了个表情）」，结果模型把这个括号格式照抄成一句话发出去
    //    （管理员 09-11 17:2x：「打成括号形式了，气笑了」）。留什么格式，它就抄什么格式。
    .replace(/[\[【]\s*表情包?\s*[:：][^\]】]*[\]】]/g, ' ')
    .replace(/[\[【]\s*图片\s*[\]】]/g, ' ')
    .replace(/[~～]+/g, '')                          // 波浪号尾巴
    .replace(/哈{2,}/g, '哈哈')                       // 哈哈哈哈 → 哈哈
    .replace(/([嘿嘻欸诶])\1+/g, '$1')                // 欸嘿嘿 → 欸嘿（叠字语气词是最容易被抄的样板）
    .replace(/([啦哒哟喔哦嘛呢嘞诶欸])(?=[，。！？?!,.;；、]|$)/g, '')  // 句尾语气词
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * 一条历史消息 → 模型看到的行（**一条消息一行**，2026-10-14 照搬老树密度；
 * 格式口径全部来自 `history-format.js`）。
 * 老树 `src/prompt.js:896-936` `formatEntry`：`[时间] #编号 发言人：[引用 …]正文 [图片]` ——
 * 引用段与媒体占位符都**内联在这一行里**，不再各起一行（引用行的「我」归属句、媒体行的
 * 「画面未读取」句改由块头 `historyHeaderText` 一轮说一次）。
 * ★ 与老树差别只有两处，都是有意保留新树更强的那一半：
 *   · **每行都带 `#编号`**（老树只在带媒体的行带）：`send_message.replyToMessageId` 与看图工具
 *     填的就是这个 `#短编号`（`act/index.js:267/273` 的工具说明），历史行不带编号 = 模型没法回旧消息。
 *   · **画面识别文字内联**（老树把原图挂在动态 user 末尾，模型看得见像素；新树只有本轮的图能取）。
 * ★ 引用与媒体仍是"有就说、没有就不写"：没有引用段时绝不出现在这里，画面没读到时不写任何看起来像画面内容的东西。
 */
export function historyLine(row, {
  notes = {}, refMap, kind = 'group', maxChars = 600, receipt = false,
  sanitizeSelfStyle = true, authorOverride = ''
}) {
  const id = historyBareRef(row);
  // ★ 编号语义**逐字不变**：只有普通行是 `#<id>`（模型唯一能照抄去 replyToMessageId 的形状）；
  //   心声/回执**不给 `#`** —— 它们不是"聊天记录里那条消息"，别诱导模型去引用一个不该引的目标。
  //   拿不到编号的普通行**不再印 `#?`**：那是一个谁也回不了的假编号，空着比它诚实。
  const ref = row.memoryKind === 'thought' ? `心声 ${id || '未知'} `
    : receipt && !row.localId ? `回执 ${id || '未知'} ` : (id ? `#${id} ` : '');
  const at = historyTime(row);
  const when = Number.isFinite(at) ? formatShortAt(at) : TIME_UNKNOWN_TEXT;
  // 发言人标签走契约那一处（群友带 QQ 号；自己的行是 `我`）。调用方可覆盖（跨轮自身段全是自己）。
  const author = String(authorOverride ?? '').trim() || historyAuthorLabel(row, { notes, kind });
  // N61：只洗"自己说的话"（row.self===true）；群友说的一个字都不动（那是别人的原话）。
  let body = row.text;
  if (sanitizeSelfStyle !== false && row.self === true && typeof body === 'string') {
    if (isSelfMediaMarker(body)) return null;          // 占位符行整行不渲染
    body = sanitizeSelfImageClaim(tidyOwnStyle(body)); // 否则洗干净再渲染
  }
  const quote = historyQuoteLabel(row[ROW_FIELD.reply], { notes, refMap });
  return `${when} ${ref}${author}：${quote}${historyBody(body, maxChars)}${historyMediaMarks(row)}`;
}

/**
 * 系统说明里"历史行长什么样"的范例（`prompt/tiers.js` 经 ctx 注入使用）。
 * ★ 必须用真实渲染器生成：这句以前是手写的，与程序实际输出的时间写法、`#编号` 位置、
 *   `(QQ号)` 写法三处都不一致，模型照范例理解真实历史行就会错位。
 * ★ 名字与号码都是编的，不含任何真实聊天。
 */
export function exampleHistoryLines() {
  const at = Date.UTC(2026, 9, 13, 2, 0, 0);              // 2026-10-13 10:00:00（UTC+8）
  const rows = [
    { id: 41, mid: '8801', ts: at - 600000, senderId: '10001', senderName: '阿南',
      text: '我把图片发来了', media: [{ kind: 'image', file: 'sample.png', url: '', summary: '' }] },
    { id: 42, mid: '8802', ts: at, senderId: '10002', senderName: '阿北', text: '我不同意',
      reply: { id: '8801', sender: '阿南', senderId: '10001', text: '我把图片发来了' } },
    { id: 43, mid: '8803', ts: at + 60000, senderId: 'self', senderName: '我', text: '收到', self: true }
  ];
  const refMap = buildPlatformRefMap(rows);
  return rows.map((row) => historyLine(row, { now: at, refMap, maxChars: 120 })).join('\n');
}

function historyRange(rows, now) {
  const times = rows.map(historyTime).filter(Number.isFinite);
  if (!times.length) return '时间范围未知；不能当成刚发生。';
  const start = Math.min(...times), end = Math.max(...times);
  return `时间范围：${formatAt(start, now)} ～ ${formatAt(end, now)}；最后一条${sinceLabel(end, now) || '距今未知'}。`;
}

/**
 * ② 给模型的时效一句（2026-10-14 派单·状态时效）。
 * ★ 与上面 `historyRange` 的分工：那个精确到秒/分、只进 diagnostics；这个把"距现在"降到能说出口的粗档
 *   （档位在 `history-format.js:coarseAgeLabel`，全链只那一份）。这里只陈述时间事实，不写"别回应旧消息"
 *   那类禁令 —— 这句是时间事实，禁令该由档位正文说，重复一遍只会把语感拉成说明书。
 * ★ 2026-10-14 照搬老树密度：这句**从历史块头挪到热段标题上**（老树 `src/prompt.js:1907-1910` 同位）。
 *   块头里留每轮变的字，等于每轮把后面整块追加式历史的字节冲掉；热段本来就是逐轮变的那一段。
 */
function historySpanText(rows, now) {
  const times = rows.map(historyTime).filter(Number.isFinite);
  if (!times.length) return '';
  const start = Math.min(...times), end = Math.max(...times);
  const label = coarseAgeLabel((Number(now) - end) / 60000);
  return `这一段发生在 ${formatShortAt(start)}～${formatShortAt(end)}，最后一条${label || '距现在未知'}`;
}

/** 过去状态是一条双方时间线；跨轮心声在另一段，不能替代自己实际说过的话。 */
export function renderRecentChat(history, {
  now, maxMessages = 40, maxMessageChars = 600, kind = 'group', sanitizeSelfStyle = true,
  personaTwo = false, hygiene = {}, notes = {}, includeContextHeadings = true, headChunk = 0
} = {}) {
  return renderTimelineHistory(history, {
    now, maxMessages, maxMessageChars, kind, sanitizeSelfStyle, personaTwo, hygiene, notes,
    includeContextHeadings, headChunk
  });
}

/**
 * ★ 2026-10-16（缓存前缀收口 · 段头对齐取尾）：`slice(-take)` 的段头会**随每条新消息滑一格** ——
 *   前缀缓存（DeepSeek 自动前缀检测 / 任何共同前缀检测）从滑动点整段失效。调用方给了
 *   `headChunk`（>0）时，把段头按消息 id 对齐到 ≤`headChunk` 条的块（与编排层历史窗口头
 *   `compose.js` 锚定块同一手法）：头只在跨块时前移一次，块内追加不改历史字节。
 *   **只增不减**：条数 ∈ [take, take+headChunk−1]，绝不比旧行为少一条（不缩减历史）。
 *   `headChunk` 缺省 0 = 逐字保持旧行为（自测与其它调用方不受影响）。
 */
const SEGMENT_HEAD_CHUNK_CAP = 12;
function takeTailWithAlignedHead(rows, take, headChunk) {
  const list = Array.isArray(rows) ? rows : [];
  const n = Math.max(0, Math.floor(Number(take) || 0));
  const chunk = Math.max(0, Math.floor(Number(headChunk) || 0));
  if (!n || list.length <= n || chunk <= 0) {
    const picked = n ? list.slice(-n) : [];
    return { picked, omitted: list.length - picked.length };
  }
  const width = Math.min(chunk, SEGMENT_HEAD_CHUNK_CAP);
  const newestId = Number(list[list.length - 1]?.id);
  let start = list.length - n;
  if (Number.isSafeInteger(newestId) && newestId > 0) {
    const anchor = Math.floor((newestId - n) / width) * width;
    if (anchor > 0) {
      const idx = list.findIndex((row) => Number(row?.id) > anchor);
      if (idx >= 0 && idx < start) start = idx;
    }
  }
  const picked = list.slice(start);
  return { picked, omitted: list.length - picked.length };
}

/** Render the caller's cold/warm partition with the same historyLine path as the ordinary timeline. */
export function renderRecentChatSplit(history, split, {
  now, maxColdMessages = 0, maxWarmMessages = 40, maxMessageChars = 600,
  warmMaxMessageChars = null,
  kind = 'group', sanitizeSelfStyle = true, personaTwo = false, hygiene = {}, notes = {},
  includeContextHeadings = true, headChunk = 0
} = {}) {
  const source = history && typeof history === 'object' ? history : {};
  const coldPass = personaVisibleRows(split?.coldMessages, { personaTwo, hygiene });
  const warmPass = personaVisibleRows(split?.warmMessages, { personaTwo, hygiene });
  const coldSource = coldPass.rows;
  const warmSource = warmPass.rows;
  const personaHidden = coldPass.hidden + warmPass.hidden;
  // 引用段带的是 QQ 消息号；对号只在**真正展示出来的行**里对（2026-10-13 缺陷①：
  // 目标被裁剪/未展示时绝不能仍显示 #编号 —— 模型会照抄一个看不见的编号；这种情况由
  // historyQuoteLabel 走「引用一条没展示的消息」降级）。先取 picked、再建表。
  const pickSegment = (messages, cap) => {
    const rows = messages.filter((row) => row && typeof row === 'object')
      .sort((a, b) => (historyTime(a) || 0) - (historyTime(b) || 0));
    const take = Math.max(0, Math.floor(Number(cap) || 0));
    // ★ 2026-10-16：`headChunk > 0` 时段头按消息 id 对齐取块（只增不减），见 `takeTailWithAlignedHead`。
    const { picked, omitted } = takeTailWithAlignedHead(rows, take, headChunk);
    return { rows, picked, omitted };
  };
  const renderLines = (picked, refMap, charCap) => {
    const lines = [];
    for (const row of picked) {
      const line = historyLine(row, { notes, refMap, kind,
        maxChars: Math.max(0, Number(charCap) || 0), sanitizeSelfStyle });
      if (line) lines.push(line);
    }
    return lines;
  };
  const cold = pickSegment(coldSource, maxColdMessages);
  const warm = pickSegment(warmSource, maxWarmMessages);
  const refMap = buildPlatformRefMap([...cold.picked, ...warm.picked]);
  // ★ 2026-10-16（历史预算稳定化）：冷/热分段的**逐行上限可以分开**（`warmMaxMessageChars`）。
  //   预算收缩时先只压热段行上限 ⇒ 冷段（前缀最前端）字节不动；不传 = 两段同上限（旧行为）。
  const coldCharCap = Math.max(0, Number(maxMessageChars) || 0);
  const warmCharCap = warmMaxMessageChars === null || warmMaxMessageChars === undefined
    ? coldCharCap : Math.max(0, Number(warmMaxMessageChars) || 0);
  cold.lines = renderLines(cold.picked, refMap, coldCharCap);
  warm.lines = renderLines(warm.picked, refMap, Math.min(coldCharCap, warmCharCap));
  // ★ 模型看到的正文只有：一处块头（逐轮字节相同）→ 较早段 → 最近段（时效句在这里，逐轮变）。
  //   计数（展示 N/M、省略 N 条）一律只进 `statusText`（diagnostics），不再压在历史正文之前。
  const truncatedRows = [...cold.lines, ...warm.lines].filter((line) => line.includes(truncatedMarker())).length;
  const lines = includeContextHeadings ? [historyHeaderText()] : [];
  if (cold.lines.length) lines.push(...(includeContextHeadings ? [historyColdHeader()] : []), ...cold.lines);
  if (warm.lines.length) {
    // ★ 2026-10-16（缓存前缀收口）：时效一句（"这一段发生在 …最后一条X分钟前"）**挪到热段行之后**。
    //   它逐轮变；留在热段标题里时，位于追加式热段正文之前 ⇒ 每轮从热段第一行就把共同前缀切断
    //   （可复用前缀只剩到冷段尾）。挪到行后：可复用前缀含到**上一轮最后一条历史行**，逐轮变的
    //   内容（时效句 / 话题 / 时间 / 本轮新消息）正好从它之后开始，与上一轮的自然断点重合。
    lines.push(...(includeContextHeadings ? [historyWarmHeader('')] : []), ...warm.lines);
    const span = includeContextHeadings ? historySpanText(warm.picked, now) : '';
    if (span) lines.push(`（以上是最近这一段：${span}）`);
  }
  const status = ['【历史时效·本轮判断】以下分片按存档顺序拆分；较早段只作背景，最近段保留当前热档。'];
  for (const [label, part, explanation] of [
    ['较早', cold, '较早聊天只作背景，不是本轮附近消息'],
    ['最近', warm, `最近聊天（热档目标 ${Math.max(0, Math.floor(Number(split?.warmCount) || 0))} 条）`]
  ]) {
    status.push(`【过去状态·${label}】${explanation}（展示 ${part.picked.length}/${part.rows.length} 条；${part.omitted} 条未展示。）`);
    status.push(part.picked.length ? historyRange(part.picked, now)
      : label === '最近' ? '（没有展示最近聊天记录；不要把较早记录当成刚发生。）' : '（没有展示较早正文。）');
  }
  if (truncatedRows) status.push(`（${truncatedRows} 行的正文按单行字数上限截短，行尾标了「${truncatedMarker()}」。）`);
  const totalRows = coldSource.length + warmSource.length;
  if (source.total !== null && source.total !== undefined && Number.isFinite(Number(source.total))) {
    status.push(`（本地存档共 ${source.total} 条；上面只是有限时间窗口，不是完整聊天回放。）`);
  }
  const excludedCurrent = Math.max(0, Number(source.excludedCurrent) || 0);
  if (excludedCurrent > 0) status.push(`（本次唤醒已有 ${excludedCurrent} 条消息，不在历史重复。）`);
  if (totalRows === 0 && includeContextHeadings) lines.push('（本地存档没有可用的双方聊天记录。）');
  return {
    text: lines.join('\n'), statusText: status.join('\n'),
    picked: [...cold.picked, ...warm.picked], omitted: cold.omitted + warm.omitted,
    coldPicked: cold.picked, warmPicked: warm.picked,
    coldOmitted: cold.omitted, warmOmitted: warm.omitted, excludedCurrent, personaHidden
  };
}

function renderTimelineHistory(history, {
  now, maxMessages, maxMessageChars, kind, sanitizeSelfStyle = true, personaTwo = false, hygiene = {}, notes = {},
  includeContextHeadings = true, headChunk = 0
}) {
  const source = history && typeof history === 'object' ? history : {};
  const pass = personaVisibleRows(source.messages, { personaTwo, hygiene });
  const messages = pass.rows
    .sort((a, b) => (historyTime(a) || 0) - (historyTime(b) || 0));
  const take = Math.max(0, Math.floor(Number(maxMessages) || 0));
  // 前部只保留绝对时间与原顺序；跨过30分钟边界不重新分组正文。
  // ★ 2026-10-16：`headChunk > 0` 时段头按消息 id 对齐取块（只增不减），防每轮滑头破坏前缀。
  const picked = takeTailWithAlignedHead(messages, take, headChunk).picked;
  // 缺陷①：对号只用**展示出来的行**（被裁剪的旧行不再产生 #编号，走「未展示」降级）。
  const refMap = buildPlatformRefMap(picked);
  const warm = picked.filter((row) => Number.isFinite(historyTime(row)) && historyTime(row) >= Number(now) - 30 * 60000);
  const cold = picked.filter((row) => !warm.includes(row));
  const omittedCount = messages.length - picked.length;
  const lines = includeContextHeadings ? [historyHeaderText()] : [];
  const status = ['【历史时效·本轮判断】以本轮时间判断新旧，前部历史绝对时间不表示刚发生。'];
  const excludedCurrent = Math.max(0, Number(source.excludedCurrent) || 0);
  if (source.status === 'unavailable') {
    if (includeContextHeadings) lines.push('（本地聊天存档当前不可用；没有编造或补写历史内容。）');
  } else {
    // 这一路没有冷/热分段 ⇒ 段名用【过去状态】本身；★ 2026-10-16 时效一句挪到**行之后**
    //   （同 split 路：逐轮变的字放在追加式历史前面会每轮切断共同前缀）。
    if (includeContextHeadings && picked.length) lines.push(historyWarmHeader('', '过去状态'));
    for (const row of picked) {
      const line = historyLine(row, { notes, refMap, kind,
        maxChars: Math.max(0, Number(maxMessageChars) || 0), sanitizeSelfStyle });
      if (line) lines.push(line);
    }
    if (includeContextHeadings && picked.length) {
      const span = historySpanText(picked, now);
      if (span) lines.push(`（以上是这一段：${span}）`);
    }
    for (const [name, rows, meaning] of [
      ['较早', cold, '超过30分钟或时间未知，只供背景'],
      ['最近', warm, '近30分钟']
    ]) {
      status.push(`【过去状态·${name}】${meaning}（${rows.length} 条；正文见前部时间线）`);
      if (rows.length) {
        status.push(historyRange(rows, now));
      } else status.push(name === '最近' ? '（没有可用的近30分钟聊天记录；不要把较早记录当成刚发生。）' : '（没有保留较早正文。）');
    }
    if (omittedCount > 0) status.push(`（历史取样：${omittedMarker(omittedCount)}；保留最新记录，不是完整连续回放。）`);
    if (source.total !== null && source.total !== undefined && Number.isFinite(Number(source.total))) {
      status.push(`（本地存档共 ${source.total} 条；上面只是有限时间窗口，不是完整聊天回放。）`);
    }
    if (excludedCurrent > 0) status.push(`（本次唤醒已有 ${excludedCurrent} 条消息，不在历史重复。）`);
  }
  return { text: lines.join('\n'), statusText: status.join('\n'), picked, omitted: messages.length - picked.length, excludedCurrent, personaHidden: pass.hidden };
}

/* ═══════════════════════════════════════════════════════════════════════
 * 跨轮心声（只渲染未发送的模型正文）
 * ═══════════════════════════════════════════════════════════════════════ */

export function renderRecentSends(botSaidBefore, {
  now, max = 6, selfName = '', maxMessageChars = 600, sanitizeSelfStyle = true, personaTwo = false, hygiene = {}, notes = {}
} = {}) {
  const pass = personaVisibleRows(botSaidBefore, { personaTwo, hygiene });
  const list = pass.rows;
  const personaHidden = pass.hidden;
  const thoughts = list.filter((entry) => entry?.memoryKind === 'thought'
    && !(Number.isFinite(Number(entry.weight)) && Number(entry.weight) <= 0));
  // ★ 无意义碎片过滤的正典在 act/inner-voice.js（isMeaningfulThoughtText）。
  //   本模块零跨模块依赖（只 import contracts + node:），不能 import act/ ⇒ 不在此处另抄词表。
  //   **上游过滤**：compose.js retrieveCrossRoundThoughts 已按同一判据过滤（import 自 inner-voice.js）；
  //   写入端 orchestrator/index.js 也已过滤。此处只做最基础的空串检查（非判据，无词表）。
  const withText = thoughts.filter((entry) => typeof entry?.text === 'string' && entry.text.trim());
  const missingText = thoughts.length - withText.length;
  // 跨轮块只展示未发出的模型心声；真实聊天由【本轮上下文】与【相关情节摘要】承载。
  const newestFirst = (a, b) => (historyTime(b) || 0) - (historyTime(a) || 0);
  const picked = [...withText].sort(newestFirst).slice(0, max)
    .sort((a, b) => (historyTime(a) || 0) - (historyTime(b) || 0));
  // ★ 块头只留"这一格是什么"和"标『心声』的那条没发出去过"两句（2026-10-14 用户令删独立块 · 裁定甲）。
  //   原来这里是一句 60 字的说明 + 行尾再来一句「行首的主语是你自己…正文里的『我』按该行作者理解」：
  //   前者讲的"时间线里已有的不复投"是**本段的实现方式**（调用方已经按消息身份滤过，模型不需要被告知），
  //   后者与【过去状态·怎么读】那一段逐字重复，而且这一段的行首恒为「我」，那句反而绕。
  //   『心声』那句留下：它是这一段独有的事实（这些行没对外发过），别处没有第二处说。
  if (!picked.length) {
    // ★ 没有可给的行 ⇒ **整段消失**（块头也不给）。以前这里会给一句「（没有可用的跨轮记忆；不编造过去心声。）」：
    //   "别编造自己这边的事"协议里已经有那句（【你是谁·边界也是事实】"只有上下文里已经出现过才算数"），
    //   这一句只是把空段撑成一个每轮都变的标题，模型从这一格得不到任何新事实。
    return { text: '', picked, dropped: list.length, personaHidden };
  }
  const lines = ['【跨轮心声】'];
  const rowLines = [];
  const weightLabels = [];
  for (const b of picked) {
    const at = historyTime(b);
    const weight = Number(b.weight);
    if (Number.isFinite(weight) && weight <= 0) continue;
    let body = String(b.text ?? '').trim();
    if (sanitizeSelfStyle !== false && b.self === true) {
      if (isSelfMediaMarker(body)) continue;
      body = sanitizeSelfImageClaim(tidyOwnStyle(body));
    }
    if (!body) continue;
    rowLines.push(`${Number.isFinite(at) ? formatShortAt(at) : TIME_UNKNOWN_TEXT} 心声：${historyBody(body, maxMessageChars)}`);
    weightLabels.push(Number.isFinite(weight)
      ? (weight >= 2 / 3 ? '高' : weight >= 1 / 3 ? '中' : '低') : '未标注');
  }
  // 行全被清洗掉（自己说的话洗空即整行丢）⇒ 同样整段不给，别留一个讲"这里有内容"的空标题。
  if (!rowLines.length) return { text: '', picked, dropped: list.length, personaHidden };
  lines.push(...rowLines);
  // 衰减权重只放在正文之后，按三档显示；不改变上游的筛选、排序和过期规则。
  lines.push(`心声参考权重（按上文顺序）：${weightLabels.join('、')}。`);
  const olderDropped = withText.length - picked.length;
  const dropped = list.length - picked.length;
  // 时效与展示数**只进诊断**（调用方 `prompt/index.js` 把它写进 diagnostics，不再作为一节给模型）。
  const statusText = ['跨轮心声时效', historyRange(picked, now),
    `展示 ${picked.length} 条；另有 ${olderDropped} 条未复投、${missingText} 条无正文。`].join('\n');
  return { text: lines.join('\n'), statusText, picked, dropped, personaHidden };
}

export { PRIORITY, clip };
