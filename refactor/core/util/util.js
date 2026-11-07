// 通用小工具：无业务逻辑。
import fs from 'node:fs';
import path from 'node:path';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function randInt(min, max) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** 带抖动的均匀随机区间。 */
export function randRange([min, max]) {
  return randInt(min, max);
}

export function nowMs() {
  return Date.now();
}

/**
 * 剥掉正文开头的"引用/消息id/时间戳/自称"装饰。
 *
 * 为什么需要（2026-09-11 实测，号A 关思考后高发）：
 *   模型会把提示词里学到的格式照抄进正文，例如
 *     "[引用 阿澈：盘外招] 我明明是白的！"
 *     "#1720239017 阿澈说"好骂"…" （后面往往接内心分析）
 *     "[09-11 22:40] 阿澈：盘外招，小鱼"
 *   这些前缀有两个坏处：
 *     ① 以 "[" 开头会被 orchestrator 的"括号内心戏"判定吞掉 → 该发的话被静默丢弃；
 *     ② 真发出去群里就是一串方括号 + 消息 id，很怪。
 *   所以统一在"判性质"和"发送"两处先剥掉它们。
 *
 * 注意：只剥**开头**的整段装饰，行内的内容一个字不动；
 *      "回复"这类前缀**必须有冒号**才算装饰（否则"回复他的时候记得说"会被误伤）。
 */
const LEADING_PREFIX_RES = [
  /^\[\s*引用[^\]]*\]\s*/u,
  /^\[\s*reply\s*[:：]?\s*-?\d+\s*\]\s*/iu,
  // 实测 09-11 23:18（某个群）：模型把消息 id 用方括号包着写在开头，群里收到的是
  // 「[1326868411] 那张图不是我」—— 这类"方括号包的裸 id"也要剥掉
  /^\[\s*-?\d{4,}\s*\]\s*/u,
  /^\[\s*emid\s*=[^\]]*\]\s*/iu,
  /^\[\s*\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\s*\]\s*/u,
  /^#\s*-?\d{4,}\s*/u,
  /^回复\s*@?[^\s:：]{1,24}\s*[:：]\s*/u,
  /^(?:我|机器人|bot)\s*[:：]\s*/iu
];

export function stripLeadingReplyPrefix(text) {
  let s = String(text ?? '');
  for (let guard = 0; guard < 8; guard += 1) {
    let changed = false;
    for (const re of LEADING_PREFIX_RES) {
      const next = s.replace(re, '');
      if (next !== s) { s = next; changed = true; }
    }
    if (!changed) break;
  }
  return s.trim();
}

// ── 时间格式化（全部走本地时区，给模型/界面看） ─────────────────────────
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 2026-08-30 21:33:05（周六） */
export function formatFullTime(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}（${WEEKDAYS[d.getDay()]}）`;
}

/** 08-30 21:33 */
export function formatShortTime(ts = Date.now()) {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 21:33:05 */
export function formatClockTime(ts = Date.now()) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ── 文本处理 ─────────────────────────────────────────────────────────────

/** 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。 */
export function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

/**
 * 防提示注入/泄露：把用户昵称、消息文本里的“指令式方括号标记”弱化，
 * 避免群友伪装成系统段（如【本次唤醒】）骗模型。只处理外观，不改变语义。
 */
export function sanitizeUserText(text) {
  let s = String(text ?? '');
  // 全角化方括号包裹的疑似系统标记：【xxx】→【xxx】保留，但 [xxx] 中含中文关键词的换成（xxx）
  s = s.replace(/\[(本次唤醒|系统|管理员|owner| Owner|OWNER|角色扮演|会话令牌|当前时间)[^\]]*\]/gi, '($1)');
  return s;
}

/**
 * 清掉模型写话时挂上的"方块装饰"。
 *
 * 实测（2026-09-11 01:11）：管理员把一段方括号垃圾贴回群里问"这是什么情况"，
 * 本地小模型会立刻学会这个风格 —— 之后**每条**消息都以 ～】] 结尾
 * （"哈哈 你这是在考我吗～】]"、"是「」那个右括号～】]"），群里看着就是"全都带方块"。
 * 这些话又进了聊天存档，模型接着照着自己学，滚成正反馈。
 *
 * 只做绝对安全的清理，三件事：
 *   ① 结尾悬挂的闭括号 ] 】 } 」 』（没有对应开括号的闭括号，正常表达里不存在这种收尾）
 *   ② 空括号对：「」【】[]（）这种里面什么都没有的纯装饰
 *   ③ 折叠多余空格
 * 不碰成对出现的正常括号（「银魂」、【注意】原样保留），也不动 ASCII 圆括号
 * （真人爱用 :) 这种笑脸，把结尾的 ) 删掉反而像出 bug）。
 */
export function tidyBrackets(text) {
  // ⚠️ 必须先 trim：实测模型爱在结尾多带一个 \n（"…～】]\n"），
  //    不 trim 的话 endsWith(']') 判false，整段垃圾就漏过去了。
  let s = String(text ?? '').trim();
  if (!s) return s;
  const PAIRS = [[']', '['], ['】', '【'], ['}', '{'], ['」', '「'], ['』', '『']];
  for (const [close, open] of PAIRS) {
    let opens = 0;
    let closes = 0;
    for (const ch of s) {
      if (ch === open) opens += 1;
      else if (ch === close) closes += 1;
    }
    while (closes > opens && s.endsWith(close)) {
      s = s.slice(0, -1).replace(/\s+$/, '');
      closes -= 1;
    }
  }
  s = s.replace(/[「【\[｛{]\s*[」】\]｝}]/g, '');   // 空括号对
  // 手搓工具调用的 XML 残留（实测 01:55：消息里带着 </parameter>、<parameter=xx>）
  s = s.replace(/<\/?[A-Za-z_][^<>\s]{0,60}>/g, ' ');
  return s.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '').trim();
}

/**
 * 这是"要说的话"，还是模型把**工具参数/JSON 碎片**当话发出来了？
 *
 * ★ 2026-10-05 18:4x 指挥位从旧树 `src/tools.js` **原样搬**入（新树此前整个缺失，真连实测漏出去的就是它）：
 *   实测泄漏（旧树注释里的原例）：`["哭这么大声 我在隔壁湾都听见了"], "replyToMessageId":`
 *   —— 用户看到的就是"各种乱七八糟的括号和引号"。
 */
export function looksLikeToolArgFragment(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (/"replyToMessageId"|"messages"\s*:|"atUserId"|"stickerId"|"tool"\s*:/.test(t)) return true;
  // 形如 ["..."] 或 {"..."} 的整体外壳（正常聊天不会这么写）
  if (/^[[{]\s*"/.test(t)) return true;
  if (/]\s*,\s*"/.test(t) && !/[\u4e00-\u9fff]{4,}/.test(t)) return true;
  return false;
}

/** 模型自曝「我是 AI/大模型/程序」。不许多发：命中就拦回让它按角色卡重说。 */
export function looksLikeAiSelfClaim(text) {
  const t = String(text ?? '');
  if (!t) return false;
  // 注意 `一个?` 的老写法其实要求必须有「一」（"我是AI"漏网）—— 这里改成"可选的数量词"。
  const aiWord = '(?:AI|人工智能|大模型|语言模型|LLM|程序|助手|机器人|bot)';
  return new RegExp(
    `我\\s*(?:是|就是|其实是|只是|只不过是?|不过是)\\s*(?:一|个|一名|一个|一只|一台|位)?\\s*${aiWord}`
    + `|作为(?:一个)?${aiWord}`
    + `|我由.{0,12}(?:训练|调优|微调)`
    + `|我是被训练出来的`
    + `|(?:AI|人工智能|大模型|语言模型)助手`, 'i').test(t);
}

/**
 * 去掉文本里的 emoji。
 *
 * 用于"这个号不许发 emoji"的配置（send.stripEmoji）：小模型爱在句尾挂个 😅，
 * 但真人聊天里它常常显得敷衍/出戏。中文标点（～？！……、。"）不算 emoji，原样保留。
 * 覆盖：图形字符本体、变体选择符（️）、ZWJ（👨👩👧 的连接符）、肤色修饰、区域指示符（国旗）。
 */
export function stripEmoji(text) {
  const s = String(text ?? '');
  if (!s) return s;
  return s
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')                 // 区域指示符（国旗）
    .replace(/\p{Extended_Pictographic}/gu, '')             // 图形字符本体
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')                 // 肤色修饰
    .replace(/[\u{FE0E}\u{FE0F}\u{20E3}\u{200D}]/gu, '')    // 变体选择符 / 键帽 / ZWJ
    .replace(/[ \t]{2,}/g, ' ')                             // 去掉留下的空隙
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。 */
export function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch { /* 原样返回 */ }
  }
  return value;
}

/**
 * 把 send_message 的单条参数收敛成可发的纯文本。
 * 处理：对象内容块、Python/JSON 残片、流式切碎的 {'type':'text','text':'…'}。
 */
export function coerceMessageText(m) {
  if (m == null) return '';
  if (typeof m === 'string') return m.trim();
  if (typeof m === 'number' || typeof m === 'boolean') return String(m).trim();
  if (typeof m === 'object') {
    // OpenAI/多模态内容块：{ type:'text', text:'…' } 或 { type:'text', content:'…' }
    const t = m.text ?? m.content ?? m.message ?? m.value;
    if (typeof t === 'string' && t.trim()) return t.trim();
    try { return JSON.stringify(m); } catch { return String(m); }
  }
  return String(m ?? '').trim();
}

/** 从疑似 Python/JSON 内容块残片里抠出 text 字段（流式切碎时常见）。 */
function extractContentBlockText(s) {
  const t = String(s ?? '').trim();
  if (!t || t.length > 400) return '';
  // {'type': 'text', 'text': 'foo'} / {"type":"text","text":"foo"}
  const m = /['"]text['"]\s*:\s*['"]((?:\\.|[^'"])*)['"]/i.exec(t);
  if (m && /^[\[{]/.test(t) && /type/i.test(t)) {
    try {
      return String(m[1]).replace(/\\(['"\\/])/g, '$1').trim();
    } catch { /* fallthrough */ }
  }
  // 只剩 "text': 'foo'}" 这类半截
  const half = /text['"]\s*:\s*['"]((?:\\.|[^'"])*)['"]\s*\}?/i.exec(t);
  if (half && /type|text['"]\s*:/.test(t) && /^[\[{']|^text['"]/.test(t)) {
    return String(half[1]).replace(/\\(['"\\/])/g, '$1').trim();
  }
  return '';
}

/** 整批是否像「内容块被切碎后当消息发」——是则丢弃并让上层报错。 */
export function looksLikeContentBlockSpam(messages) {
  if (!Array.isArray(messages) || messages.length < 3) return false;
  let blockish = 0;
  for (const s of messages) {
    const t = String(s ?? '');
    if (!t) continue;
    if (/^[\[{]\s*['"]?type['"]?\s*:/.test(t) || /^text['"]\s*:/.test(t) || /['"]text['"]\s*:/.test(t)) blockish += 1;
    else if (t.length <= 12 && /^[\]}']/.test(t) === false && /['"]/.test(t) && /:/.test(t) === false && /text/i.test(t)) blockish += 1;
  }
  return blockish >= Math.max(3, Math.ceil(messages.length * 0.6));
}

/** 兼容模型把数组序列化成 JSON 字符串传入的情况；字符串→单元素数组。 */
export function normalizeMessageList(input) {
  let value = input;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) value = parsed;
      } catch { /* 保持字符串；下面再试宽松抠 text */ }
    } else if (trimmed.startsWith('"')) {
      const unquoted = unquoteJsonString(trimmed);
      if (typeof unquoted === 'string') value = unquoted;
    }
  }
  if (Array.isArray(value)) {
    // 先原样收字符串；对象内容块抽出 .text；整批像切碎片则直接丢掉
    const raw = value.map(coerceMessageText).filter(Boolean);
    if (raw.length && looksLikeContentBlockSpam(raw)) {
      const extracted = raw.map(extractContentBlockText).filter(Boolean);
      // 能拼回完整句子就拼回去；拼不回就当垃圾丢弃（宁可报错重发，不刷屏）
      if (extracted.length >= 2 && extracted.join(' ').length >= 4) {
        return [extracted.join(' ').trim()];
      }
      return [];
    }
    // 零星混进一两个内容块残片：单条抠 text
    return raw.map((s) => extractContentBlockText(s) || s);
  }
  const single = coerceMessageText(value);
  if (!single) return [];
  const one = extractContentBlockText(single);
  return [one || single];
}

/**
 * 这个地址是不是"本机"（127.0.0.1 / localhost / ::1）。
 *
 * 用途：OneBot 协议端在本机时，我们才敢把**本地文件路径**当图片载荷发过去
 * （协议端自己去读文件，请求体只剩几百字节）；跨机时路径对它毫无意义，只能传字节。
 */
export function isLocalHostUrl(url) {
  try {
    const host = new URL(String(url || '')).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

/** 简单串行队列：保证发送按顺序、带间隔执行。 */
export function createSendChain() {  let chain = Promise.resolve();
  return function enqueue(task) {
    const next = chain.then(task, task);
    // 防止单次失败中断整条链
    chain = next.then(() => undefined, () => undefined);
    return next;
  };
}

/** 简易事件总线。 */
export function createEventBus() {
  const listeners = new Map();
  const on = (type, fn) => {
    if (typeof fn !== 'function') return () => {};
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type)?.delete(fn);
  };
  const emit = (type, payload) => {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (error) { console.error(`[bus] ${type} 监听器出错:`, error); }
    }
  };
  // `app.js` exposes the existing emit function to extensions. Attach the
  // existing on() subscription function so `api.on(type, handler)` can use
  // that same bus without changing app.js or existing emit() behavior.
  emit.on = on;
  return { on, emit };
}

/** 截断长文本（日志/会话记录展示用）。 */
export function truncate(text, max = 400) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}…(共${s.length}字)`;
}

// ── 原子落盘 ──────────────────────────────────────────────────────────
// 以前 8 个模块各自复制了一份「写 tmp 再 rename」，且都没在失败时清理 tmp：
// 进程被强杀一次就永久留一个孤儿文件（实测 memory-v2 下攒了 55 个 28MB 的
// index.json.<pid>.tmp，共 1.5GB）。统一到这里：rename 失败立刻删 tmp。
/**
 * 原子落盘（写 tmp → rename；失败立刻删 tmp，见上面那段复盘）。
 *
 * ★ 2026-10-05 修一个静默失效的真缺陷（sb4 复核时发现）：
 *   原来写的是 `JSON.stringify(data, indent)` —— `indent` 落在了 **replacer** 位，不是 **space** 位，
 *   ⇒ 参数**完全无效**（输出永远紧凑）；更坏的形态：万一有人传**数组**当 indent，它会变成
 *   **属性白名单**，静默把不在名单里的字段剥掉。
 *   现在：`space` 位收 `indent`，**默认保持"紧凑"**（与修复前逐字节一致 ⇒ 不改变任何现有文件的格式），
 *   要缩进就显式传 `{ indent: 2 }`。
 */
export function writeJsonAtomic(file, data, { indent = null } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, indent), 'utf8');
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 删不掉也先把错抛出去 */ }
    throw error;
  }
}

// ★ N73 补的两个洞（**两树共有**，不是搬运漂移 —— 老树 src/util.js:341 同一行正则、:347 同一个 maxDepth = 2）：
//   ① 尾巴原先要求"全是数字"（`-\\d+(-\\d+)?`），而本仓实际的临时名是 `.tmp-<pid>-<base36>`
//     （`cleanup` / `topics` / `memory/coordinator` / 各处原子写）⇒ 这类遗留**永远扫不掉**；
//     现改成"横线后先是一位数字（pid 的头）再跟字母数字"，`.tmp` 这个边界本身**不放宽**：
//     `notes.tmp-bak` / `x.tmp-abc`（尾巴不是数字起头）照样不动，宁可少删。
//   ② 深度原先默认 2 = 只覆盖"根 + 一层子目录"⇒ 孙子目录里的 tmp 漏扫
//     （实测：`data/<模块>/<会话>/<文件>.json.tmp-<pid>-<ts>` 就是第三层）。
//     默认提到 4；调用方仍可显式收窄。
const STALE_TMP_RE = /\.tmp(-\d[0-9A-Za-z_-]*)?$/;

/**
 * 启动清扫：删掉历史崩溃留下的 *.tmp / *.tmp-<pid>-<…>。
 * ⚠️ 必须在拿到实例锁之后调用 —— 否则会把并发实例正在写的 tmp 删掉。
 * ⚠️ 这条动作的语义是**在 DATA_DIR 下删文件** ⇒ 接线前要用户点头（本仓硬约束①）。
 */
export function sweepStaleTmp(dir, { maxDepth = 4 } = {}) {
  let removed = 0;
  let bytes = 0;
  const walk = (d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) walk(p, depth + 1);
        continue;
      }
      if (!STALE_TMP_RE.test(e.name)) continue;
      try {
        const st = fs.statSync(p);
        fs.rmSync(p, { force: true });
        removed += 1;
        bytes += st.size;
      } catch { /* 删不掉就留着，下次再扫 */ }
    }
  };
  walk(dir, 1);
  return { removed, bytes };
}
