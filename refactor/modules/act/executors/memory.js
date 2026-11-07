/**
 * M10 执行器切片 `memory`：记忆 / 好感 / 梗 / 待办 / 自我印象，共 11 个，旧实现见 `src/tools.js`。
 *
 * 契约（见 ../executors/index.js，不许改）：`async (ctx, args) => ({ok, data, error})`。
 * 能力只从 `ctx.modules.<模块>` 的**公开出口**取；**不 import 任何兄弟模块**（本文件零 import）。
 *
 * ── 本切片的移植结论（逐条依据见回执 `.tmp-dispatch/r-tools-memory.md` / `r-N35-act工具补齐.md`）────
 * 11 个工具**现在都有真出口**（N16 对齐参数 → N35 补执行器依赖）：
 *   · `memory_meme_save` / `memory_meme_search` → `ctx.modules.media`（`media/index.js:50` 的 `export * from './memes.js'`）
 *   · `memory_query` / `memory_append` / `memory_remove` → M6 的 `readMemory` / `commit` / `forget`
 *   · `memory_todo_save` / `memory_todo_done` → `ctx.modules.memory.todos`（`memory/todos.js`，装配层 assembly.js:252 挂）
 *   · `remember_self_impression` → `ctx.modules.configStore.updateConfigAndSave()`
 *   · ★ `memory_search` → `memory.readMemory({ route:'searchChatMessages' })`（`memory/chat-search.js`）
 *   · ★ `memory_archive` → `memory.{listArchiveChatKeys,listArchiveDays,listArchiveHours,countArchiveMatches,loadArchive,loadArchiveContextAround}`（`memory/archive-view.js`）
 *   · `memory_favor` 不写库（2026-10-02 用户裁决）：只读 M7 关系 + 把 delta/reason 放进回执，
 *     由 `orchestrator/index.js:2261` 从回执派生 `relationDelta` 事件落账（N12）。
 *
 * ★★ 上面两个 ★ 是 N35 修的：它们原先探的是**老树的嵌套形状**（`modules.conversationMemory.search` /
 *   `modules.memory.archive.load`），而 M6 把同样的能力搬成了**扁平公开出口** ⇒ 探测恒 undefined
 *   ⇒ 两个工具从上线起一次都没跑通过（`memory_archive` 连 `mode=list` 都报「依赖未就绪」）。
 *   能力一直都在，缺的只是本文件里那层适配（见 `archiveExit()`）。
 *
 * ── 前向兼容写法（刻意为之）────────────────────────────────────────────────
 * 每个"依赖未就绪"都写成**按出口存在性探测**（`typeof mem?.setFavor === 'function'`），
 * 而不是无条件拒绝 ⇒ 将来谁把对应出口挂到 `ctx.modules.memory` / `.media` 上，
 * 这批执行器**不用改代码**就自动开始工作；在那之前一律显式报缺什么。
 */

/** 依赖未就绪的统一说法：说清缺什么、为什么现在不行（契约第 6 条：不许返回假的成功）。 */
function notReady(tool, need, extra = {}) {
  return {
    ok: false,
    error: `依赖未就绪：${tool} 需要 ${need}。迁移期缺口，本工具**没有**执行任何写入。`,
    data: { tool, ready: false, needs: need, ...extra }
  };
}

/** 参数归一化：照搬 `src/tools.js:2052` 的 norm（去首尾空白 + 剥一层引号）。 */
const norm = (args, key) => String(args?.[key] ?? '').trim().replace(/^["']|["']$/g, '');

/** 照搬 `src/tools.js:2057`：中文引号也剥一层。 */
const unquote = (s) => String(s ?? '').replace(/^["'“”]|["'“”]$/g, '').trim();

/** QQ 号归一化：照搬 `src/tools.js:2062-2068`（负号转正；target 同样处理）。 */
function normalizeQq(raw) {
  let v = String(raw ?? '').trim();
  if (/^-?\d{5,15}$/.test(v)) v = String(Math.abs(Number(v)));
  return v;
}

/**
 * 本轮真实发言者候选 —— 照搬 `src/tools.js:3535-3551` 的 `candidateUserIdList`。
 *
 * ★ 关键：它读 `ctx.triggerUserIds` 与 `ctx.memory.cache`，**而契约 §2 的 ctx 白名单里没有这两个字段**
 *   （白名单只有 modules / platform / cfg / chatKey / kind / evidenceId / evidence / context /
 *    jevSignal / plan / signal / idempotencyKey）。所以：
 *   · `triggerUserIds` 缺失 ⇒ `known=false` ⇒ #6 的两道校验（强制拒 / 软警告）**都不触发**，
 *     行为退化成「必须显式填 userId」—— 这是**安全的那一侧**（没有候选可比对时不允许凭空写号）。
 *   · `label()` 需要 `ctx.memory.cache`（昵称）；缺失时只显示裸号，不报错。
 *   等 M15 把 `triggerUserIds` 注入白名单，这里无需改代码即自动恢复候选校验。
 */
function candidateUserIdList(ctx) {
  const raw = ctx?.triggerUserIds;
  const known = Array.isArray(raw);
  const ids = known
    ? [...new Set(raw.map((x) => String(x).replace(/^-/, '')).filter((x) => /^\d{5,15}$/.test(x)))]
    : [];
  const cache = ctx?.memory?.cache;
  const label = (uid) => {
    let name = '';
    try {
      const m = typeof cache?.get === 'function' ? cache.get(String(uid)) : null;
      name = String(m?.nickname || m?.name || '').trim();
    } catch { name = ''; }
    return name ? `${uid}（${name}）` : String(uid);
  };
  return { known, ids, label, hint: ids.length ? ids.map(label).join('、') : '' };
}

/** M6 语义记忆出口（`modules/memory/index.js`）。 */
const mem6 = (ctx) => ctx?.modules?.memory ?? null;
/** M11 媒体出口（`modules/media/index.js`，含 memes.js 的 `export *`）。 */
const media = (ctx) => ctx?.modules?.media ?? null;
/**
 * 待办出口（前向兼容探测，2026-10-05 指挥位指定写法）：
 *   首选 `modules.memory.todos`（工厂实例），兼容 `modules.memory` 直接摊平，
 *   再兼容 `modules.pending`。**装配层尚未挂载时返回 null** ⇒ 工具显式报"依赖未就绪"。
 */
const todosExit = (ctx) => {
  const mem = ctx?.modules?.memory ?? null;
  return mem?.todos ?? mem?.todosApi ?? mem ?? ctx?.modules?.pending ?? null;
};

/**
 * 记忆数据目录 —— ctx 白名单（executors/index.js §2）里**没有 dataDir**，
 * 而 M6 的归档/检索出口一律要求**显式**传 dataDir（`memory/archive-view.js:47`、
 * `memory/chat-search.js:62` 都是 fail-closed，拿不到就报 501，绝不自己去找目录）。
 * 走 memory 的公开出口 `getDataDir()`：装配层 `apps/server/assembly.js:654` 已经
 * `memory.setDataDir(resolvedDataDir)` ⇒ 这里读到的就是本轮真实数据目录。
 * 读不到 ⇒ 返回空串，调用方显式报「依赖未就绪」（**不猜**一个目录）。
 */
function memoryDataDir(ctx) {
  const mem = mem6(ctx);
  if (typeof mem?.getDataDir === 'function') {
    try {
      const dir = mem.getDataDir();
      if (typeof dir === 'string' && dir.trim()) return dir.trim();
    } catch { /* 落到下面的兜底 */ }
  }
  const raw = ctx?.dataDir;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
}

/**
 * ★ 双人格记忆隔离（2026-10-13）：本轮**谁在位** + 两个可见性开关。
 *   判据不在这里 —— 全树只有 `modules/emotion/persona-hygiene.js` 那一份实现，
 *   这里只把"此刻的状态"交给真正做过滤的那几个出口（检索 / 写入打标）。
 *   探针缺失或抛错 ⇒ 按第一人格在位（不放宽隔离）；开关读不到 ⇒ 按 defaults 的"隐"走。
 */
function personaStateOf(ctx) {
  let personaTwo = false;
  try { personaTwo = ctx?.modules?.emotion?.isPersonaTwo?.() === true; } catch { personaTwo = false; }
  let hygiene = {};
  try {
    const raw = ctx?.cfg?.get?.('persona2.memoryHygiene', null);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) hygiene = raw;
  } catch { /* 配置读不到就按默认：两个开关都隐 */ }
  return { personaTwo, hygiene };
}

/**
 * 归档出口 —— 把 M6 的**扁平**公开出口拼回老树 `ArchiveReader` 的调用形状。
 *
 * ★ 为什么要这一层（这就是 `memory_archive` 原先连 `mode=list` 都永远失败的原因）：
 *   老树是 `new ArchiveReader({messagesDir}).listDays(...)` 一个对象五个方法；
 *   M6 搬过来时拆成了扁平导出（`memory/archive-view.js` → `memory/index.js:45-49`）：
 *   `listArchiveChatKeys / listArchiveDays / listArchiveHours / countArchiveMatches /
 *    loadArchive / loadArchiveDay / loadArchiveContextAround`。
 *   而本文件原先探的是 `ctx.modules.memory.archive.load` 这个**嵌套形状** ⇒ 恒 undefined
 *   ⇒ 五个模式一个都到不了，全部退化成「依赖未就绪」。
 *   扁平出口其实一直都在，缺的只是这层适配 —— 不用改 memory 域一个字节。
 * 真挂了嵌套门面（将来若有人补）就优先用它，保持前向兼容口径不变。
 */
function archiveExit(ctx) {
  const mem = mem6(ctx);
  if (!mem) return null;
  const nested = ctx?.modules?.conversationMemory?.archive ?? mem.archive ?? null;
  if (typeof nested?.load === 'function') return nested;
  const dataDir = memoryDataDir(ctx);
  if (!dataDir) return null;
  const flat = ['listArchiveChatKeys', 'listArchiveDays', 'listArchiveHours', 'countArchiveMatches', 'loadArchive'];
  if (flat.some((name) => typeof mem[name] !== 'function')) return null;
  const rows = (result, key) => (result?.ok === true && Array.isArray(result[key]) ? result[key] : []);
  return {
    dataDir,
    listChatKeys: () => rows(mem.listArchiveChatKeys({ dataDir }), 'chatKeys'),
    listDays: (chatKey, { limit = 20 } = {}) => rows(mem.listArchiveDays({ chatKey, dataDir, limit }), 'days'),
    listHours: (chatKey, day, { limit = 24 } = {}) => rows(mem.listArchiveHours({ chatKey, day, dataDir, limit }), 'hours'),
    count: (options = {}) => mem.countArchiveMatches({ ...options, dataDir }),
    load: (options = {}) => mem.loadArchive({ ...options, dataDir }),
    loadContextAround: (options = {}) => (typeof mem.loadArchiveContextAround === 'function'
      ? mem.loadArchiveContextAround({ ...options, dataDir })
      : { ok: false, error: 'memory.loadArchiveContextAround() 不存在' })
  };
}

/**
 * 单次运行的记忆检索预算 —— 照搬 `src/tools.js:728-741`（`memory_search` 与 `memory_archive` 共用）。
 * 老树原话就是它的意义：「搜不到就承认想不起来，不要继续搜」—— 没有上限时模型会在一轮里连搜十几次。
 * 配置键与钳位口径逐字照老树（`src/orchestrator.js:3182-3187`）：`api.conversationMemory.maxSearchPerRun`，
 * 缺省 3、≤0 表示不限、上限钳到 8。
 *
 * ★ 计数为什么不挂 ctx：老树把 `memorySearchUsed` 挂在 ctx 上（一次 run 一个 ctx）；
 *   新树的 ctx 是**每轮新建**（`orchestrator/compose.js:1114` 每次都 `buildToolExecutionContext`）
 *   ⇒ 挂 ctx 上等于每轮清零、上限形同虚设。改成按 `evidenceId`（一次 run 一个）在本模块记一张
 *   有上限的表，与 `query.js:105-125` 的 `fetchedPages` 同一套路（LRU 逐出，不会无界长）。
 */
const SEARCH_BUDGET_RUNS_MAX = 64;
const searchBudgetUsed = new Map();

function takeMemorySearchBudget(ctx) {
  const raw = Number(ctx?.cfg?.get?.('api.conversationMemory.maxSearchPerRun', 3));
  const n = Number.isFinite(raw) ? raw : 3;
  const cap = n <= 0 ? 0 : Math.min(8, Math.round(n));
  if (!cap) return { ok: true, cap: 0, used: null, left: Infinity };
  const runKey = String(ctx?.evidenceId ?? '').trim() || String(ctx?.idempotencyKey ?? '').trim() || '(no-run-id)';
  const used = Number(searchBudgetUsed.get(runKey)) || 0;
  if (used >= cap) {
    return {
      ok: false,
      cap,
      used,
      left: 0,
      error: `本次运行记忆检索已达上限（${cap} 次）`
        + ' —— memory_query / memory_search / memory_archive 是**合计**计数，换个入口也一样。'
        + '搜不到就承认想不起来，不要继续搜。'
    };
  }
  searchBudgetUsed.set(runKey, used + 1);
  while (searchBudgetUsed.size > SEARCH_BUDGET_RUNS_MAX) {
    searchBudgetUsed.delete(searchBudgetUsed.keys().next().value);
  }
  return { ok: true, cap, used: used + 1, left: cap - used - 1 };
}

/**
 * 只读看一眼本轮已用几次（**不扣次数**）—— 给面板用："这一轮搜了几次记忆"。
 * 计数粒度与 `takeMemorySearchBudget` 完全一致（同一个 `evidenceId` 键），所以面板看到的数
 * 与拦住模型那次调用用的数是同一个；上限未设（配置 ≤0）时 `cap` 为 null、`left` 为 null。
 */
export function memorySearchBudgetState(ctx = {}) {
  const raw = Number(ctx?.cfg?.get?.('api.conversationMemory.maxSearchPerRun', 3));
  const n = Number.isFinite(raw) ? raw : 3;
  const cap = n <= 0 ? 0 : Math.min(8, Math.round(n));
  const runKey = String(ctx?.evidenceId ?? '').trim() || String(ctx?.idempotencyKey ?? '').trim() || '(no-run-id)';
  const used = Number(searchBudgetUsed.get(runKey)) || 0;
  return { cap: cap || null, used, left: cap ? Math.max(0, cap - used) : null };
}

/** 回执里带的那一份：`left` 为 Infinity（不限）时对面板透成 null，别让它渲染出 "Infinity"。 */
const searchBudgetField = (budget) => ({ cap: budget.cap || null, used: budget.used ?? null, left: Number.isFinite(budget.left) ? budget.left : null });

/** 会话来源标签（照搬 `src/tools.js:744-750`）：当前 / 私聊 / 群。 */
function classifyChatKey(chatKey, current) {
  const k = String(chatKey || '');
  if (k && current && k === current) return '当前会话';
  if (k.startsWith('private:')) return '私聊';
  if (k.startsWith('group:')) return '群';
  return k || '未知';
}

/**
 * 记忆碎片洗成人话 —— 照搬 `src/tools.js:758-771` 的 `cleanMemoryText`（新树没有这个出口）。
 * 为什么要在 act 里搬：它是**纯文本变换、零 IO**，与本文件已搬的「自我印象」区同一路数
 * （brief §一.4 只许用 `ctx.modules.<模块>` 的公开出口，而新树 `modules/prompt` 没有对应导出 ——
 *   它的 `formatAt` 是**时间**格式化，不是 @ 人性化，同名不同物）。
 * 存档里存的是原始消息，直接喂模型会带着 `[CQ:at,qq=…]` 这类机器码：既费 token 又难看懂。
 * ★ 与老树唯一的差别：老树最后一步走扩展钩子 `message.inline-at-normalize`（`src/prompt.js:866`），
 *   新树的扩展钩子在 `ctx.modules.extensions`，本文件不 import 兄弟模块 ⇒ 有出口就用、没有就跳过。
 */
function cleanMemoryText(ctx, raw) {
  let s = String(raw ?? '');
  const selfId = String(ctx?.selfId ?? '').replace(/\D/g, '')
    || String(ctx?.cfg?.get?.('onebot.selfId', '') ?? '').replace(/\D/g, '');
  const notes = ctx?.cfg?.get?.('memberNotes', {}) || {};
  const nameOf = (rawName, qq) => String(notes[String(qq)] || rawName || qq || '某人').trim() || '某人';
  if (s.includes('@') || s.includes('[CQ:')) {
    s = s
      .replace(/@([^\s@[\]]{0,24})\[CQ:at,[^\]]*?qq=(\d+)[^\]]*\]/g,
        (m, name, qq) => (selfId && String(qq) === selfId ? '@你' : `@${nameOf(name, qq)}`))
      .replace(/\[CQ:at,[^\]]*?qq=(\d+)[^\]]*\]/g,
        (m, qq) => (selfId && String(qq) === selfId ? '@你' : `@${nameOf('', qq)}`))
      .replace(/\[CQ:[^\]]*\]/g, ' ');
  }
  s = s
    .replace(/\[引用\s*([^\]]{0,80})\]/g, (m, inner) => `↩${String(inner).replace(/\[(at|reply)\]/g, '').trim().slice(0, 20)}`)
    .replace(/\[合并转发[^\]]*\]/g, '[转发]')
    .replace(/\[图片\]/g, '[图]')
    .replace(/\[表情\d*\]/g, '[表情]')
    .replace(/\[拍一拍\]/g, '（拍一拍）')
    .replace(/\[(at|reply)\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

/** 存档消息的时间戳 → 老树 `fmtLine` 同款「MM-DD HH:mm」短标签（`archive-view.js:191` 的 when 口径）。 */
function archiveWhen(value) {
  const at = Number(value);
  if (!Number.isFinite(at) || at <= 0) return '';
  try {
    const d = new Date(at);
    const pad = (x) => String(x).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return ''; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 「## 自我印象」区：格式逐字搬自 `src/self-impressions.js`（2026-10-05，指挥位给了落点）
// ─────────────────────────────────────────────────────────────────────────────
// 为什么搬在这里而不是 import 兄弟模块：brief §一.4 只许用 `ctx.modules.<模块>` 的公开出口，
// 而新树**没有** selfImpressions 模块。这几个函数是**纯文本变换、零 IO**，逐字照搬旧实现即可，
// 唯一区别是旧版最后一步 `updateConfig(...)`（只改内存）换成了 `updateConfigAndSave(...)`（真落盘）。
// ★ 格式（标记、标题、说明行、`- ` 前缀、插入位置）**一个字没改** —— 改了就等于换了一种人设卡语法。
const SELF_IMP_START = '<!--self-impressions:start-->';   // src/self-impressions.js:6
const SELF_IMP_END = '<!--self-impressions:end-->';       // :7
const SELF_IMP_MAX = 8;                                 // :8

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');   // :10-12

/** 标记区匹配（src/self-impressions.js:14-16） */
const selfSectionRe = () => new RegExp(`${escapeRe(SELF_IMP_START)}[\\s\\S]*?${escapeRe(SELF_IMP_END)}`, 'm');

/** 整节（标题+说明+标记区）匹配（src/self-impressions.js:19-21） */
const selfFullSectionRe = () =>
  /##\s*自我印象（低权重参考·可灵活违背）\s*\n仅背景板[^\n]*\n<!--self-impressions:start-->[\s\S]*?<!--self-impressions:end-->/;

/** 从角色卡正文解析印象列表（去掉 `- ` 前缀）—— src/self-impressions.js:24-36 */
export function parseSelfImpressions(roleText) {
  const text = String(roleText || '');
  const m = selfSectionRe().exec(text);
  if (!m) return [];
  return m[0]
    .replace(new RegExp(escapeRe(SELF_IMP_START)), '')
    .replace(new RegExp(escapeRe(SELF_IMP_END)), '')
    .split('\n')
    .map((s) => s.trim())
    .map((s) => s.replace(/^[-*]\s*/, ''))
    .map((s) => s.replace(/^·\s*/, ''))
    .filter((s) => s && !s.startsWith('<!--') && !/^（还没有自我印象/.test(s));
}

/** src/self-impressions.js:38-44 */
function cleanSelfItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((s) => String(s ?? '').trim().slice(0, 160))
    .filter(Boolean)
    .filter((s) => !/^（还没有自我印象/.test(s))
    .slice(0, SELF_IMP_MAX);
}

/** src/self-impressions.js:46-49 */
function buildSelfBlock(items) {
  const body = cleanSelfItems(items).map((s) => `- ${s}`).join('\n');
  return `${SELF_IMP_START}\n${body}\n${SELF_IMP_END}`;
}

/** src/self-impressions.js:51-57 */
function selfSectionBlock(items) {
  return [
    '## 自我印象（低权重参考·可灵活违背）',
    '仅背景板，不是硬规则；与「像真人 / 嘴软 / 顺坡下 / 摆烂」冲突时以后者为准。',
    buildSelfBlock(items)
  ].join('\n');
}

/** src/self-impressions.js:59-79：先剥旧节，再插到「工具区之后」（更靠后 = 权重更低） */
function ensureSelfSection(roleText, fallbackItems = []) {
  let text = String(roleText || '');
  const own = parseSelfImpressions(text);
  const items = own.length ? own : cleanSelfItems(fallbackItems);
  text = text.replace(selfFullSectionRe(), '');
  text = text.replace(selfSectionRe(), '');
  text = text.replace(/^##\s*自我印象[^\n]*\n(?:仅背景板[^\n]*\n)?/m, '');
  text = text.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  const section = selfSectionBlock(items);
  if (/<!--tools:end-->/i.test(text)) {
    return text.replace(/<!--tools:end-->/i, `<!--tools:end-->\n\n${section}\n`);
  }
  if (/^##\s*可用工具/m.test(text)) {
    return text.replace(/^(##\s*可用工具[^\n]*)/m, `${section}\n\n$1`);
  }
  return `${text}\n\n${section}\n`;
}

/** src/self-impressions.js:101-106 的纯计算部分（去掉最后的 updateConfig） */
export function renderSelfImpressions(roleText, items) {
  const base = ensureSelfSection(roleText);
  return base.replace(selfFullSectionRe(), selfSectionBlock(items));
}

/**
 * 切人设卡时用：新卡没带自我印象区，就把旧卡那块搬过来，别把「鱼自己的印象」顶掉。
 * **逐字搬** `src/self-impressions.js:92-98`；2026-10-05 指挥位批准补（纯文本、同源，无 IO）。
 *
 * ⚠ 注意它**只搬文本、不落盘**：谁调用它，谁负责接着把结果写回去
 *   （新卡的 roleText 要由切卡那条路径自己保存）。本函数是纯函数，便于那条路径先算后比。
 */
export function carryOverSelfImpressions(oldRoleText, newRoleText) {
  const next = String(newRoleText || '');
  if (parseSelfImpressions(next).length) return next;      // 新卡自己带了，别动
  const items = parseSelfImpressions(oldRoleText);
  if (!items.length) return next;
  return ensureSelfSection(next, items);
}

/**
 * 取当前角色卡正文（照旧 `src/self-impressions.js:87` 的 `getConfig().persona?.roleText || ''`）。
 */
function currentRoleText(ctx) {
  return String(ctx?.cfg?.get?.('persona.roleText', '') ?? '');
}

/**
 * 落盘角色卡：**只用** `updateConfigAndSave`（或 `updateConfig` + 显式 `saveConfig`），
 * 绝不拿只改内存的 `set/updateConfig` 当保存（票面约束②）。保留 `persona` 的其余键（旧 `:82`）。
 *
 * ★ 我**故意没有**把 `remember_self_impression` 也改成走这里：那条路径已落盘验收过（真落盘 +
 *   旧内容不丢 + 失败抛错文案都有断言），为了"少写一份重复代码"去动已验证的路径不划算。
 *   这里抽出来给两个新出口用，三处的错误文案各自表述（`persistRoleText` 只返回结构化结果）。
 *
 * @returns {{ok:true, roleText:string, saved:object|null}|{ok:false, needs:string}}
 */
function persistRoleText(ctx, roleText) {
  const store = ctx?.modules?.configStore ?? null;
  const canUpdate = typeof store?.updateConfig === 'function'
    && (typeof store?.updateConfigAndSave === 'function' || typeof store?.saveConfig === 'function');
  if (!canUpdate) {
    return {
      ok: false,
      needs: '配置落盘出口 ctx.modules.configStore.updateConfigAndSave()'
        + '（cfg.set/updateConfig 只改内存、不落盘 —— 已知 G6）'
    };
  }
  const persona = { ...(ctx?.cfg?.get?.('persona', {}) || {}), roleText };
  const saved = typeof store.updateConfigAndSave === 'function'
    ? store.updateConfigAndSave({ persona }, { log: ctx?.log ?? null })
    : (store.updateConfig({ persona }), store.saveConfig({ log: ctx?.log ?? null }));
  return { ok: true, roleText, saved };
}

/**
 * 整段替换自我印象区（逐字搬 `src/self-impressions.js:100-106`，2026-10-05 指挥位批准）。
 * 旧实现：`ensureSection(当前) → replace(fullSectionRe, sectionBlock(items)) → writeRoleText`。
 * @param {object} ctx 需要 `cfg.get` 与 `modules.configStore` 的落盘出口
 * @param {string[]} items 新的印象列表（一行一条；内部会 cleanItems：trim/截 160/滤占位/截 8 条）
 */
export function setSelfImpressions(ctx, items) {
  const roleText = currentRoleText(ctx);
  const next = renderSelfImpressions(roleText, items);
  let written;
  try {
    written = persistRoleText(ctx, next);
  } catch (error) {
    return { ok: false, error: `自我印象没落盘：${error?.message ?? error}`, data: { writtenToDisk: false } };
  }
  if (!written.ok) return notReady('setSelfImpressions', written.needs, { written: false });
  return {
    ok: true,
    data: {
      saved: true,
      items: parseSelfImpressions(next),
      roleText: next,
      file: written.saved?.file ?? null,
      backedUp: written.saved?.backedUp ?? null
    }
  };
}

/**
 * 按内容删一条（精确匹配；逐字搬 `src/self-impressions.js:117-125`）。
 * ★ 旧实现的"没找到"是**提前 return、不落盘**，这里照旧：删不存在的东西不许碰盘。
 */
export function removeSelfImpression(ctx, text) {
  const line = String(text ?? '').trim();
  if (!line) return { ok: false, error: '内容为空' };
  const list = parseSelfImpressions(currentRoleText(ctx));
  const next = list.filter((s) => s !== line);
  if (next.length === list.length) {
    return {
      ok: false,
      error: `没找到这条印象：${line.slice(0, 40)}`,
      data: { removed: false, kept: list.length, wroteToDisk: false, note: '旧实现同样不落盘' }
    };
  }
  const res = setSelfImpressions(ctx, next);
  if (!res.ok) return res;
  return {
    ok: true,
    data: {
      removed: true,
      items: res.data.items,
      roleText: res.data.roleText,
      file: res.data.file,
      backedUp: res.data.backedUp ?? null
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// memory_search 的取数与排版（照老树 `src/tools.js:773-830` 的 formatSearchHits）
// ─────────────────────────────────────────────────────────────────────────────
/** 一次「全库搜」最多翻几个会话：老树 hippocampus 有倒排索引，一次调用就扫全库；
 *  新出口是逐会话的有界扫描（`chat-search.js:76` 每次最多读 maxScan 条）⇒ 必须自己给上限，
 *  否则会话一多就变成"一次工具调用扫几十个群"。12 是"够用且不炸"的折中。 */
const MAX_SEARCH_CHATS = 12;
/** 当前会话扫深一点（最可能命中），其它会话浅扫（只为兜底）。上限受 `chat-search.js:6` MAX_SCAN=1000 钳。 */
const MAX_SCAN_CURRENT = 1000;
const MAX_SCAN_OTHER = 300;

/** 当前会话之外的归档会话（有上限）。取不到归档出口就返回空数组 —— 只搜当前会话，不报错。 */
function otherChatKeys(ctx, max) {
  const archive = archiveExit(ctx);
  if (!archive) return [];
  let keys = [];
  try { keys = archive.listChatKeys() || []; } catch { return []; }
  return keys.filter((k) => k && k !== ctx?.chatKey).slice(0, max);
}

/** 一条命中消息 → 老树 snippet 那一行（`  10-09 20:31 张三: 正文`）。 */
function snippetLine(ctx, item) {
  const when = archiveWhen(item?.at) || '时间未知';
  const who = item?.self ? '我' : String(item?.senderName || item?.senderId || '群友');
  return `  ${when} ${who}: ${cleanMemoryText(ctx, item?.text)}`;
}

/** 命中块的时间位置：老树用 `h.hourKey || h.dayKey`（`src/tools.js:794`）。 */
function blockPlace(block) {
  const at = Number(block?.items?.[0]?.at);
  if (!Number.isFinite(at) || at <= 0) return '';
  try {
    const d = new Date(at);
    const pad = (x) => String(x).padStart(2, '0');
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return `${day} ${pad(d.getHours())}`;
  } catch { return ''; }
}

/**
 * 命中排版 —— 照老树 `formatSearchHits`（`src/tools.js:773-830`）：
 *   ① 表头【命中】/【粗匹配命中】 ② 按来源排序（当前会话 > 私聊 > 群）再按分
 *   ③ 每块最多 3 条 snippet、只出前 3 块 ④ 命中词写出来（模型才知道是靠实词还是泛词蹭上的）
 *   ⑤ 第一条/当前会话自动带【前后文】。
 * ★ 文案与标记一个字没改 —— 用户 22:0x 裁定「凡与老树不一致处，一律照老树」。
 */
function formatSearchHits(ctx, blocks, { loose = '', left = null } = {}) {
  const head = loose ? `【粗匹配命中】原词没中，已改用短词：${loose}` : '【命中】';
  const parts = [head];
  const rank = (b) => {
    const tag = classifyChatKey(b.chatKey, ctx?.chatKey);
    if (tag === '当前会话') return 0;
    if (tag === '私聊') return 1;
    return 2;
  };
  const scoreOf = (b) => Math.max(0, ...(b.items || []).map((i) => Number(i?.score) || 0));
  const sorted = [...blocks].sort((a, b) => rank(a) - rank(b) || scoreOf(b) - scoreOf(a));
  const archive = archiveExit(ctx);

  sorted.slice(0, 3).forEach((block, i) => {
    const tag = classifyChatKey(block.chatKey, ctx?.chatKey);
    const items = (block.items || []).slice(0, 3);
    const sn = items.map((item) => snippetLine(ctx, item)).join('\n');
    const matched = [...new Set(items.flatMap((item) => (Array.isArray(item?.matched) ? item.matched : [])))];
    // 命中词写出来：模型才知道这块是靠"推歌/音乐"命中的，还是只靠"喜欢"这种泛词蹭上的
    const why = matched.length ? ` 命中词:${matched.slice(0, 6).join('/')}` : ' 命中词:（无实词）';
    parts.push(`#${i + 1} [${tag}] ${blockPlace(block)} chat=${block.chatKey}${why}\n${sn}`);

    // 当前会话或第一条：自动带前后文（老树 :799-816）
    if ((i === 0 || tag === '当前会话') && archive && block.chatKey) {
      try {
        const place = blockPlace(block);
        const around = archive.loadContextAround({
          chatKey: block.chatKey,
          hour: place || undefined,
          anchor: String(items[0]?.text ?? ''),
          before: 6,
          after: 6,
          maxChars: 900
        });
        if (around?.ok && Array.isArray(around.lines) && around.lines.length) {
          parts.push(`【前后文·${tag}】`);
          parts.push(around.lines.map((line) => cleanMemoryText(ctx, line)).join('\n'));
        }
      } catch { /* 前后文是附加信息，取不到不影响主结果 */ }
    }
  });
  const rest = sorted.length - Math.min(3, sorted.length);
  if (rest > 0) parts.push(`（另有 ${rest} 处命中未列出：换更具体的词，或用 memory_archive 按天翻）`);
  // ── 尾注：逐条照老树 src/tools.js:822-834（用户 22:0x 裁定「凡与老树不一致处，一律照老树」）
  const hasCurrent = sorted.some((b) => classifyChatKey(b.chatKey, ctx?.chatKey) === '当前会话');
  if (!hasCurrent) parts.push('（没搜到当前会话里的记录，以下是私聊/其它群的）');
  // 全是"靠泛词蹭上的块"时明说 —— 比让模型拿一堆不相干的碎片硬编强。
  // 判据：前三块里没有一条命中是带实词（≥2 字）的。
  const weak = !loose && sorted.slice(0, 3)
    .every((b) => !(b.items || []).some((item) => Array.isArray(item?.matched) && item.matched.length));
  if (weak) {
    parts.push('⚠️ 这几块都没命中你要的实词，八成只是字面沾边：**别据此编**，换更具体的词（人名/时间/关键名词）再搜，或直接说想不起来。');
  }
  const place0 = blockPlace(sorted[0]);
  if (place0) {
    parts.push(`再挖整天：memory_archive(mode=day, chatKey=${sorted[0].chatKey}, day=${place0.slice(0, 10)}, hour=${place0})`);
  }
  parts.push('可据此回答；没有把握就说想不起来。');
  if (left !== null && left !== undefined) parts.push(`剩余检索:${left}`);
  return parts.join('\n');
}

/** 老形状出口（`conversationMemory.search`，返回 chunk+snippets）时的原样流程 —— 保留前向兼容。 */
function legacySearch(ctx, cm, query, limit, forceAll, left = null) {
  let hits = [];
  if (!forceAll && ctx?.chatKey) {
    hits = cm.search(query, { chatKey: ctx.chatKey, limit, maxSnippets: 4 }) || [];
  }
  if (hits.length < 2) {
    const seen = new Set(hits.map((h) => h.chunkId));
    for (const h of cm.search(query, { chatKey: null, limit, maxSnippets: 4 }) || []) {
      if (!seen.has(h.chunkId)) hits.push(h);
    }
  }
  let loose = '';
  if (!hits.length) {
    const words = query.replace(/[，,。.！!？?、\s]+/g, '').match(/[一-鿿]{2}|[a-z0-9]{3,}/g);
    if (words?.length >= 2) {
      loose = words.join(' ');
      hits = cm.search(words.slice(0, 6).join(' '), { chatKey: null, limit, maxSnippets: 4 }) || [];
    }
  }
  if (!hits.length) {
    return { ok: true, data: { content: '无命中。可换更短/更泛的词再搜；仍无就承认想不起来，勿编。' } };
  }
  const rank = (h) => {
    const tag = classifyChatKey(h.chatKey, ctx?.chatKey);
    return tag === '当前会话' ? 0 : tag === '私聊' ? 1 : 2;
  };
  const sorted = [...hits].sort((a, b) => rank(a) - rank(b) || (b.score || 0) - (a.score || 0));
  const parts = [loose ? `【粗匹配命中】原词没中，已改用短词：${loose}` : '【命中】'];
  const archive = archiveExit(ctx);
  sorted.slice(0, 3).forEach((h, i) => {
    const tag = classifyChatKey(h.chatKey, ctx?.chatKey);
    const sn = (h.snippets || []).slice(0, 3)
      .map((s) => `  ${s.when} ${s.self ? '我' : s.who}: ${cleanMemoryText(ctx, s.text)}`).join('\n');
    const why = Array.isArray(h.matched) && h.matched.length ? ` 命中词:${h.matched.join('/')}` : ' 命中词:（无实词）';
    parts.push(`#${i + 1} [${tag}] ${h.hourKey || h.dayKey || ''}${h.chatKey ? ` chat=${h.chatKey}` : ''}${why}\n${sn}`);
    // 当前会话或第一条：自动带前后文（老树 :799-816）；没有归档出口就安静跳过。
    if ((i === 0 || tag === '当前会话') && archive && h.chatKey) {
      try {
        const around = archive.loadContextAround({
          chatKey: h.chatKey, hour: h.hourKey || undefined, day: h.dayKey || undefined,
          anchor: h.snippets?.[0]?.text || '', before: 6, after: 6, maxChars: 900
        });
        if (around?.ok && Array.isArray(around.lines) && around.lines.length) {
          parts.push(`【前后文·${tag}】`);
          parts.push(around.lines.map((line) => cleanMemoryText(ctx, line)).join('\n'));
        }
      } catch { /* 前后文是附加信息，取不到不影响主结果 */ }
    }
  });
  // 尾注同样照老树 :822-834（与上面 formatSearchHits 一套口径，别两处漂开）
  if (!sorted.some((h) => classifyChatKey(h.chatKey, ctx?.chatKey) === '当前会话')) {
    parts.push('（没搜到当前会话里的记录，以下是私聊/其它群的）');
  }
  const weak = !loose && sorted.slice(0, 3).every((h) => !(Array.isArray(h.matched) && h.matched.length));
  if (weak) {
    parts.push('⚠️ 这几块都没命中你要的实词，八成只是字面沾边：**别据此编**，换更具体的词（人名/时间/关键名词）再搜，或直接说想不起来。');
  }
  const h0 = sorted[0];
  if (h0?.hourKey) {
    parts.push(`再挖整天：memory_archive(mode=day, chatKey=${h0.chatKey}, day=${h0.dayKey}, hour=${h0.hourKey})`);
  }
  parts.push('可据此回答；没有把握就说想不起来。');
  if (left !== null && left !== undefined) parts.push(`剩余检索:${left}`);
  return { ok: true, data: { content: parts.join('\n'), count: hits.length, left } };
}

export const executors = {
  // ─────────────────────────────────────────────────────────────────────────
  // memory_query（旧 src/tools.js:2305-2329）—— 2026-10-05 改判：对到 M6 语义记忆
  // 出口：`ctx.modules.memory.readMemory({ route:'retrieve' })` / `.history()`
  // ★ 不再找"成员印象库"：新树把事实拆给 memory（证据→观察→卡），旧库语义已被覆盖。
  // ★ 范围不许自己拍（铁律③）：scope/chatKey 一律由 M6 按本轮上下文过滤，
  //   我**不传 need.scope** 去扩大可见性（旧工具也没有这个参数）。
  // ─────────────────────────────────────────────────────────────────────────
  async memory_query(ctx, args) {
    const topic = String(args?.query ?? '').trim();
    const userId = normalizeQq(args?.userId);
    const mem = mem6(ctx);
    if (typeof mem?.readMemory !== 'function') {
      return notReady('memory_query', 'ctx.modules.memory.readMemory()（M6 统一记忆读取入口；旧成员印象库已被它取代）', {
        parsed: { topic, userId }
      });
    }
    // ★ 2026-10-13 裁定：用户说的"搜记忆"是**整体口径** ⇒ `memory_query` 与 `memory_search`/`memory_archive`
    //   共用同一个计数器，一条来消息的一整次运行**合计 3 次**（不是各 3）。
    //   代价照记档：query 一次 + search 两次就触顶 —— 这正是要的"别一直搜"。
    //   放在依赖可用性检查之后：没接上的调用不该扣次数（`memory_archive` 沿用老树顺序，这里不跟着改它）。
    const budget = takeMemorySearchBudget(ctx);
    if (!budget.ok) return { ok: false, error: budget.error };
    // 旧口径：按话题查时压到 12 条（tools.js:2322），不给模型灌几百字
    const need = { limit: topic ? 12 : 20 };
    if (userId) need.subjectIds = [userId];
    const r = await mem.readMemory({ route: 'retrieve', input: {
      chatKey: ctx?.chatKey,
      kind: ctx?.kind,
      topic,
      evidence: ctx?.evidence || [],
      senderId: ctx?.selfId,
      need
    } });
    const items = (r?.items || []).map((x) => ({
      claim: x.claim,
      subjectId: x.subjectId ?? '',
      type: x.type ?? '',
      confidence: x.confidence ?? null,
      at: x.at ?? null,
      evidenceCount: (x.evidenceIds || []).length
    }));
    const out = {
      items,
      total: items.length,
      scanned: r?.scanned ?? null,
      // 面板要看的两份计数：本轮合计用了几次/还剩几次（`memorySearchBudgetState` 是同一个计数器的只读视图）
      searchBudget: searchBudgetField(budget),
      // 范围被裁掉的条数**不带 claim 正文**（M6 的规矩：dropped 不泄漏内容），如实透出计数即可
      droppedByScope: (r?.dropped || []).length,
      ignoredRequests: r?.ignored || []
    };
    if (!items.length) {
      // ★ 预算见底时**不许**再递"换个入口接着搜"这句 —— 那正是模型一轮里连搜十几次的起点。
      const spent = budget.left === 0;
      out.note = topic
        ? `记忆里没有跟「${topic}」沾边的观察（不等于没这回事，只是没记过）。`
          + (spent ? '这一轮的检索次数已经用完，别再搜了：照实说没查到，或直接问对方。'
            : '可以再 memory_search 翻聊天，或直接问对方。')
        : (userId ? `没有查到 ${userId} 的记忆。` : '记忆库是空的。');
    }
    // 给了 userId 时**额外**带上历史版本（含被 supersede 的旧版）——
    // 旧工具没有这个能力，但"发现记错了"正是它存在的意义（M6 history 不做物理删除，index.js:293）。
    // ★ 2026-10-16（用户："用户删掉的印象，memory_query 还能查到"）：**撤回（retracted）的版本不列出来** ——
    //   用户已经删掉的内容不该再由这个工具送回模型眼前（superseded 是"改过口"，仍列出以便更正）。
    if (userId && typeof mem?.readMemory === 'function') {
      try {
        const h = mem.readMemory({ route: 'history', input: { subjectId: userId } });
        const retired = (h?.versions || []).filter((v) => !v.current && v.status !== 'retracted');
        if (retired.length) {
          out.retiredVersions = retired.map((v) => ({ claim: v.claim, status: v.status, at: v.at, version: v.version }));
        }
      } catch { /* 历史是附加信息，取不到不影响主结果 */ }
    }
    return { ok: true, data: out };
  },

  // ─────────────────────────────────────────────────────────────────────────
  // memory_search（旧 src/tools.js:2910-2972）—— 2026-10-09 N35 接通
  // 出口：`ctx.modules.memory.readMemory({route:'searchChatMessages',input:{query,options}})`
  //   （实现 `modules/memory/chat-search.js:49`，经 `memory/index.js:45` 转出）。
  // ★ 原先探的是 `ctx.modules.conversationMemory.search`（老树 hippocampus 的形状），新树**没有**这个
  //   命名空间 ⇒ 这个工具从来一次都没跑通过，模型点了只会拿到「依赖未就绪」。
  // ★ 与老树的一处**刻意**差别：老树 `cm.search(q,{chatKey:null})` 一次搜全库；
  //   新出口是 fail-closed 的单会话检索（`chat-search.js:46` 注释：scope 绝不在里面放宽）
  //   ⇒ "全库"改由本执行器**显式枚举** `listArchiveChatKeys()` 逐会话搜（有上限，见 MAX_SEARCH_CHATS）。
  //   语义与老树一致（当前会话 > 私聊 > 群），但没有偷偷放宽任何模块的范围契约。
  // ─────────────────────────────────────────────────────────────────────────
  async memory_search(ctx, args) {
    const query = String(args?.query ?? '').trim();
    const limit = Math.min(8, Math.max(1, Number(args?.limit) || 4));
    const budget = takeMemorySearchBudget(ctx);
    if (!budget.ok) return { ok: false, error: budget.error };
    if (!query) return { ok: false, error: '缺少 query（要搜的关键词）' };

    const mem = mem6(ctx);
    // 前向兼容：真挂了老形状的 conversationMemory.search 就照老树走（一行都不用改）
    const cm = ctx?.modules?.conversationMemory ?? mem?.conversation ?? null;
    if (typeof cm?.search === 'function') {
      return legacySearch(ctx, cm, query, limit, args?.all === true, budget.left === Infinity ? null : budget.left);
    }

    if (typeof mem?.readMemory !== 'function') {
      return notReady(
        'memory_search',
        'ctx.modules.memory.readMemory()（M6 统一原始聊天存档检索入口）',
        { parsed: { query, limit, all: args?.all === true } }
      );
    }
    const dataDir = memoryDataDir(ctx);
    if (!dataDir) {
      return notReady('memory_search', 'ctx.modules.memory.getDataDir()（M6 检索要显式 dataDir，装配层未注入）', {
        parsed: { query, limit }
      });
    }

    const persona = personaStateOf(ctx);
    const one = (chatKey, q, maxScan) => {
      try {
        const r = mem.readMemory({
          route: 'searchChatMessages',
          input: { query: q, options: { chatKey, dataDir, limit, maxScan, ...persona } },
        });
        return r?.ok === true ? (Array.isArray(r.items) ? r.items : []) : [];
      } catch { return []; }
    };

    // ① 先只搜当前会话（老树 :2936-2944）
    const forceAll = args?.all === true;
    /** @type {Array<{chatKey:string, items:Array}>} */
    let blocks = [];
    if (!forceAll && ctx?.chatKey) {
      const items = one(ctx.chatKey, query, MAX_SCAN_CURRENT);
      if (items.length) blocks.push({ chatKey: ctx.chatKey, items });
    }
    // ② 当前不够 → 翻其它会话（老树 :2946-2955 的 chatKey:null 全库搜）
    const hitCount = () => blocks.reduce((n, b) => n + b.items.length, 0);
    if (hitCount() < 2) {
      for (const key of otherChatKeys(ctx, MAX_SEARCH_CHATS)) {
        if (hitCount() >= limit) break;
        const items = one(key, query, MAX_SCAN_OTHER);
        if (items.length) blocks.push({ chatKey: key, items });
      }
    }
    // ③ 仍无 → 粗词重试（老树 :2957-2965）
    let loose = '';
    if (!blocks.length) {
      const words = query.replace(/[，,。.！!？?、\s]+/g, '').match(/[一-鿿]{2}|[a-z0-9]{3,}/g);
      if (words?.length >= 2) {
        loose = words.join(' ');
        for (const key of [ctx?.chatKey, ...otherChatKeys(ctx, MAX_SEARCH_CHATS)].filter(Boolean)) {
          const items = one(key, words.slice(0, 6).join(' '), MAX_SCAN_OTHER);
          if (items.length) blocks.push({ chatKey: key, items });
          if (hitCount() >= limit) break;
        }
      }
    }
    if (!blocks.length) {
      // 与 memory_query 同一条规矩：额度见底时不许再递"换个词接着搜"（那正是连搜十几次的起点）。
      const spent = budget.left === 0;
      return {
        ok: true,
        data: {
          content: spent
            ? '无命中。这一轮的检索次数已经用完，别再换词硬搜：照实说想不起来就行。'
            : '无命中。可换更短/更泛的词再搜；仍无就承认想不起来，勿编。',
          hits: 0,
          searchBudget: searchBudgetField(budget)
        }
      };
    }
    return {
      ok: true,
      data: {
        content: formatSearchHits(ctx, blocks, { loose, left: budget.left === Infinity ? null : budget.left }),
        left: budget.left === Infinity ? null : budget.left,
        hits: hitCount(),
        searchBudget: searchBudgetField(budget)
      }
    };
  },

  // ─────────────────────────────────────────────────────────────────────────
  // memory_append（旧 src/tools.js:2028-2135）—— 2026-10-05 改判：对到 M6 `commit()`
  // 出口：`ctx.modules.memory.commit(observation, opts)`（index.js:104）+ OBS_TYPES（store.js:35）
  // ★ 铁律①：**记忆写必须带证据** —— 拿不到证据就显式失败，不写"无源卡"（contracts:403-411 也强制
  //   evidenceIds 非空）。铁律②：subjectId 就是 QQ 号字符串（#6 闸门照旧）。铁律③：scope 按
  //   本轮上下文推，**不自己拍**跨群可见性。
  // ─────────────────────────────────────────────────────────────────────────
  async memory_append(ctx, args) {
    // ★ 2026-10-09 N35 照老树放宽：老树 src/tools.js:2041 只在 schema 里写死 enum:['memberImpression']，
    //   execute 里**从不校验**这个参数（:2118 直接把 'memberImpression' 传下去）。新树这里做硬拒，
    //   而 category 是"只有一个合法值的固定字段" ⇒ 模型漏填就被拒，是本切片自测长期 14 组红的根因。
    //   口径改为：**漏填按唯一合法值补上；填错了才拒**（填错说明模型误解了工具，必须让它看见）。
    const category = norm(args, 'category') || 'memberImpression';
    if (category !== 'memberImpression') {
      return { ok: false, error: 'category 必须是 memberImpression' };
    }
    // ① 参数归一化：逐字照搬 src/tools.js:2052-2071
    let userId = normalizeQq(norm(args, 'userId'));
    const target = norm(args, 'target');
    const content = unquote(norm(args, 'content'));
    if (!content) {
      return {
        ok: false,
        error: 'content 不能为空。示例：{"category":"memberImpression","userId":123456789,"content":"推歌要古典/摇滚"}'
      };
    }
    if (userId && !/^\d{5,15}$/.test(userId)) userId = '';
    const candidateTarget = normalizeQq(target);
    if (!userId && /^\d{5,15}$/.test(candidateTarget)) userId = candidateTarget;

    // ② #6：QQ 号必须来自本轮真实发言者（照搬 src/tools.js:2082-2112）
    const cand = candidateUserIdList(ctx);
    const candIds = cand.ids;
    const proactiveOpen = ctx?.isProactiveTurn === true && candIds.length === 0;
    if (!userId && cand.known && candIds.length === 1) {
      userId = candIds[0];
    } else if (cand.known && !proactiveOpen && userId && !candIds.includes(String(userId))) {
      if (!candIds.length) {
        return {
          ok: false,
          error: `本轮发言者里没有可绑定的 QQ 号，不能凭空写一个（你填的 ${userId}）。`
            + '本轮触发消息里没有别人发言 ⇒ 没有可记的人。若要记自己，用 remember_self_impression；'
            + '若确实要记这个人，先让他在本轮发言再记。'
        };
      }
      return {
        ok: false,
        error: `userId ${userId} 不在本轮发言者里，不能凭空写一个 QQ 号。可选：${cand.hint}。请从上面挑一个填 userId。`
      };
    }
    if (!userId) {
      return {
        ok: false,
        error: cand.known && !candIds.length && !proactiveOpen
          ? '缺 userId，且本轮发言者里没有可绑定的 QQ 号（本轮没有别人发言）—— 不能凭空写一个。'
          : '缺 userId（对方 QQ 号）。从聊天行「名字(QQ数字)」里抄数字填 userId'
            + (cand.hint ? `；本轮可选：${cand.hint}` : '')
            + '；只有名字以后会对不上人。'
      };
    }

    // ③ 别把自己记成别人（照搬 src/tools.js:2113-2117）
    const selfId = String(ctx?.selfId ?? '').replace(/\D/g, '')
      || String(ctx?.cfg?.get?.('onebot.selfId', '') ?? '').replace(/\D/g, '');
    if (selfId && String(userId) === selfId) {
      return {
        ok: false,
        error: `userId ${userId} 是你自己的 QQ 号，不能用 memory_append 记录自己。`
          + '请改用 remember_self_impression 工具记录自我印象。'
      };
    }

    const mem = mem6(ctx);
    if (typeof mem?.commit !== 'function') {
      return notReady('memory_append', 'ctx.modules.memory.commit()（M6 语义记忆写入）', {
        parsed: { userId, contentChars: content.length }
      });
    }

    // ④ 铁律①：证据从本轮 ctx.evidence 里挑「这个人自己说的那些」，挑不到就显式失败。
    //    （不拿"模型自己写的内容"当证据 —— 那正是无源卡。）
    const all = Array.isArray(ctx?.evidence) ? ctx.evidence : [];
    const mine = all.filter((e) => {
      const sid = String(e?.sender?.id ?? e?.senderId ?? '');
      if (sid && sid === String(userId)) return true;
      return Array.isArray(e?.mentions) && e.mentions.some((m) => String(m?.id ?? '') === String(userId));
    });
    if (!mine.length) {
      return {
        ok: false,
        error: `没有证据，不写无源记忆：本轮证据里找不到 ${userId} 本人发言（可引用 ${all.length} 条）。`
          + '记忆必须能回指原始消息 —— 请让对方先说两句再记，或改用 memory_search 翻已有记录。',
        data: { written: false, reason: 'no-evidence', evidenceAvailable: all.length }
      };
    }
    const evidenceIds = mine.map((e) => String(e?.id ?? '')).filter(Boolean);
    if (!evidenceIds.length) {
      return {
        ok: false,
        error: '本轮证据缺 id，无法回指原始消息，不写无源记忆。',
        data: { written: false, reason: 'evidence-without-id', matched: mine.length }
      };
    }

    // ⑤ confidence：commit 契约强制 [0,1] 的数字（contracts:414-415），而旧工具的入参里**没有**这一项。
    //    ⇒ 不编造默认值：模型给了就用；没给就显式失败并说清卡在哪个字段（登记在回执里，等指挥位改 schema）。
    const confRaw = args?.confidence;
    const confidence = Number(confRaw);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return {
        ok: false,
        error: '缺 confidence（0~1 的小数，写这条记忆有多确定）。'
          + '记忆系统的契约要求它，不接受我替你编一个 —— 请在 memory_append 里带上 confidence。',
        data: { written: false, reason: 'missing-confidence', got: confRaw ?? null, needs: 'confidence ∈ [0,1]' }
      };
    }

    // ⑥ type：旧工具的 6 类 → M6 的 OBS_TYPES（store.js:35）。映射写死在这里，不猜。
    const typeMap = {
      identity: 'fact',
      preference: 'preference',
      edge: 'fact',
      style: 'trait',
      event: 'fact',
      attitude: 'impression'
    };
    const asked = norm(args, 'type');
    const type = typeMap[asked] || 'impression';
    // ★ 2026-10-16（一键清理 C 的安全前提）：这张映射是**有损**的（identity/edge/event 都落成 fact），
    //   而"模型到底给过哪个子类"是后来做类型升级/审计的**唯一可靠来源** ⇒ 原样带上子类与 provenance：
    //     · 模型明确给了合法子类 ⇒ `impressionType` + `impressionTypeSource:'model'`（升级时"模型给过的不动"）；
    //     · 没给 ⇒ 只带 `impressionTypeSource:'none'`（明确"没有子类"——一键清理 C 的合法候选）。
    //   枚举的权威在 store.js 的 `IMPRESSION_TYPE_SOURCES`；本文件零 import ⇒ 子类表就从 typeMap 的键取。
    const subtype = Object.prototype.hasOwnProperty.call(typeMap, asked) ? asked : '';

    // ⑦ scope（铁律③）：只由本轮上下文推导，不接受模型传入的 scope。
    const derivedScope = ctx?.kind === 'private' ? 'private' : 'group';
    // ★ 2026-10-09 N35：原先只是"静默忽略"传入的 scope。静默改口径 = 模型以为写了全库、实际只写了本会话，
    //   而这类"跨群可见性"是本项目的铁律③ ⇒ 不一致就显式拒，让它看见。
    //   （工具表 additionalProperties:false，正常路径下 scope 到不了这里；这道闸防的是直接调执行器/未来加参数。）
    const askedScope = norm(args, 'scope');
    if (askedScope && askedScope !== derivedScope) {
      return {
        ok: false,
        error: `scope 由本轮会话推导（本轮=${derivedScope}），不接受传入的 ${askedScope}。`
          + '跨群可见性不由工具放宽：要记到别的会话，请在那个会话里记。',
        data: { written: false, reason: 'scope-mismatch', derivedScope, askedScope }
      };
    }

    // ⑦b supersedes（功能表 5 · P0-1 · 2026-10-11）：改口必须能**取代**旧卡，不是并列多一条。
    //    不发明新语义：两个入口 —— 观察 id（memory_query/history 直接带回的）或旧记忆**逐字原文**；
    //    一律经 M2 统一读取入口的 history 路由取回真实行核对，scope/subject 由本轮上下文说了算，模型改不了。
    const askedSupersedes = norm(args, 'supersedes');
    let supersedesId = '';
    if (askedSupersedes) {
      if (typeof mem?.readMemory !== 'function') {
        return notReady('memory_append.supersedes', "ctx.modules.memory.readMemory({ route: 'history' })（M2 统一读取入口 / M6 版本历史）", {
          parsed: { userId, supersedes: askedSupersedes }
        });
      }
      const token = askedSupersedes.trim();
      let versions = [];
      try {
        const h = mem.readMemory({ route: 'history', input: { subjectId: userId, scope: derivedScope } });
        versions = Array.isArray(h?.versions) ? h.versions : [];
      } catch (error) {
        return {
          ok: false,
          error: `查历史失败，没法确认要取代的旧记忆：${error?.message ?? error}`,
          data: { written: false, reason: 'supersedes-history-failed' }
        };
      }
      // 同一个 QQ 号可能在别的群里也有卡（scope 都是 group）⇒ 只在**本会话**的版本里找。
      const chatKey = String(ctx?.chatKey ?? '');
      const pool = chatKey ? versions.filter((v) => String(v.chatKey ?? '') === chatKey) : versions;
      const hit = pool.find((v) => String(v.id) === token)
        || pool.find((v) => String(v.claim ?? '').trim() === token);
      if (!hit) {
        return {
          ok: false,
          error: `没找到要更正的旧记忆：${userId} 名下（本会话 ${derivedScope}）没有 id 或内容为「${token.slice(0, 30)}」的观察。`
            + '先 memory_query 抄回旧说法的**逐字原文**（或它的 id）再填 supersedes；对不上就不取代，免得改错卡。',
          data: { written: false, reason: 'supersedes-not-found', scanned: pool.length, versions: versions.length }
        };
      }
      if (String(hit.subjectId) !== String(userId)) {
        return {
          ok: false,
          error: `supersedes 指向的观察属于 ${hit.subjectId}，和 userId ${userId} 不是同一个人。`,
          data: { written: false, reason: 'supersedes-subject-mismatch' }
        };
      }
      if (String(hit.scope) !== derivedScope) {
        return {
          ok: false,
          error: `supersedes 指向的观察记在 ${hit.scope} 会话里，本轮推出来是 ${derivedScope} —— 跨会话的卡不由这个工具改。`,
          data: { written: false, reason: 'supersedes-scope-mismatch', targetScope: hit.scope, derivedScope }
        };
      }
      if (!hit.current) {
        return {
          ok: false,
          error: `supersedes 指向的不是当前生效的那条（状态 ${hit.status ?? '未知'}）—— 更正要取代的是现在还在用的版本。`,
          data: { written: false, reason: 'supersedes-not-current', status: hit.status ?? null }
        };
      }
      supersedesId = String(hit.id);
    }

    try {
      const res = await mem.commit(
        {
          subjectId: String(userId),
          claim: content,
          type,
          scope: derivedScope,
          confidence,
          evidenceIds,
          ...(subtype ? { impressionType: subtype, impressionTypeSource: 'model' } : { impressionTypeSource: 'none' }),
          ...(supersedesId ? { supersedes: supersedesId } : {})
        },
        {
          chatKey: ctx?.chatKey,
          kind: ctx?.kind,
          // ★ 写侧打标、不拦（2026-10-13 裁定）：记下"这条经历是谁写下的"，读侧据此对另一人格隐去。
          //   执行器手里就有本轮的在位状态 ⇒ 显式传，不依赖装配层有没有把探针注进 memory.configure。
          persona2: personaStateOf(ctx).personaTwo,
          evidence: mine
          // ★ 不传 dataDir：M6 的 dataDir 由装配层/调用方注入（memory/data-dir.js 的口径），
          //   执行器不许自己找目录 —— 更不许猜到生产 data/ 去。
        }
      );
      if (!res?.ok) {
        return {
          ok: false,
          error: `记忆没写成：${(res?.errors || []).join('；') || '记忆库拒绝（字段不合契约）'}`,
          data: { written: false, errors: res?.errors || [], evidenceIds: evidenceIds.length }
        };
      }
      return {
        ok: true,
        data: {
          saved: true,
          byName: false,
          observation: {
            id: res.id, subjectId: String(userId), claim: content, type, scope: derivedScope, confidence,
            ...(supersedesId ? { supersedes: supersedesId } : {})
          },
          evidenceCount: evidenceIds.length,
          duplicate: !!res.duplicate,
          // P0-1：把"取代了谁"如实回给模型与 trace —— 没写就是没取代（别让调用方以为改了旧卡）。
          supersedes: supersedesId || null,
          version: res.version ?? null
        }
      };
    } catch (error) {
      return { ok: false, error: `记忆写入失败：${error?.message ?? error}`, data: { written: false } };
    }
  },

  // ─────────────────────────────────────────────────────────────────────────
  // memory_favor（旧 src/tools.js:2218-2303）—— 好感度
  // 2026-10-02 用户裁决：好感只许模型自己调这个工具改，系统侧不许自动写。
  // ★ 落账链（N12 之后**已通**）：本工具只把 delta/reason 如实放进回执 ⇒ M15 从回执派生
  //   `relationDelta` 事件（`orchestrator/index.js:1184` 定义 · `:2261` 调用）⇒ M7 `applyEvent` 写库。
  //   条件（`:1198-1202`）：mode='write' · written=false · delta≠0 · **reason 非空** · 本轮有可用证据。
  // ─────────────────────────────────────────────────────────────────────────
  async memory_favor(ctx, args) {
    let uid = String(args?.userId ?? '').trim().replace(/^-/, '');
    if (/^-?\d{5,15}$/.test(String(args?.userId ?? ''))) uid = String(Math.abs(Number(args.userId)));

    // 软校验（照搬 src/tools.js:2243-2253）：不在候选里也放行，只记一条警告。
    const favCand = candidateUserIdList(ctx);
    const favCandIds = favCand.ids;
    let favSoftWarn = '';
    if (!uid && favCand.known && favCandIds.length === 1) {
      uid = favCandIds[0];
    } else if (favCand.known && uid && !favCandIds.includes(String(uid))) {
      favSoftWarn = favCandIds.length
        ? `（提醒：${uid} 不在本轮发言者里，本次仍按你填的号处理；本轮可选：${favCand.hint}）`
        : `（提醒：${uid} 不在本轮发言者里 —— 本轮没有别人发言，没有可比对的候选；本次仍按你填的号处理）`;
    }
    if (!/^\d{1,15}$/.test(uid)) return { ok: false, error: 'userId 必须是对方 QQ 号' };

    // ── 2026-10-05 改判：**不改数据结构**。落账不走本工具，走「M15 发 relationDelta」那条链。
    //   本工具只做两件事：① 从 M7 读当前关系用于回话 ② 把"改了多少、为什么"如实放进 data。
    //   ★ 为什么不自己调 `modules.emotion.applyEvent`：M15 是情绪事件的**唯一 owner**
    //     （orchestrator/index.js:75-84），且 relationDelta 需要证据（emotion/events.js:59）。
    //     工具私自推进状态 = 绕过 owner + 无源写库，正是本项目反复在抓的那类事故。
    const emo = ctx?.modules?.emotion ?? null;
    const hasRead = emo && (typeof emo.relationOf === 'function' || typeof emo.styleHint === 'function');
    let relation = null;
    let hint = '';
    if (hasRead && typeof emo.relationOf === 'function') {
      try {
        relation = emo.relationOf({ chatKey: ctx?.chatKey, senderId: uid }) || null;
      } catch { relation = null; }
    }
    if (hasRead && typeof emo.styleHint === 'function' && typeof emo.stateOf === 'function') {
      try {
        hint = String(emo.styleHint(emo.stateOf(), { personId: uid }) || '');
      } catch { hint = ''; }
    }

    const hasDelta = !(args?.delta === undefined || args?.delta === null || args?.delta === '');
    const reasonGiven = Object.prototype.hasOwnProperty.call(args || {}, 'reason');
    const delta = hasDelta ? Math.max(-10, Math.min(10, Math.round(Number(args.delta)))) : null;
    if (hasDelta && !Number.isFinite(Number(args.delta))) {
      return { ok: false, error: 'delta 必须是数字（-10~10）' };
    }
    // ★★ B10（2026-10-11 用户裁定）：**不许按字数截理由**。改前这里是 `.slice(0, 30)`，与
    //   `act/index.js` 的 `maxLength: 30` 是同一道闸的两半（参数层拒长的、执行器截短的），
    //   自由文本理由被腰斩后语义常反过来（"…不是我的错"被切成"…不是我的"）。
    const reason = String(args?.reason ?? '');

    // 只读查看（照搬 src/tools.js:2258-2264 的拒绝口径：传了 reason 却没 delta ⇒ 不动）
    if (!hasDelta && reasonGiven) {
      return { ok: false, error: '传了 reason 但缺少 delta；要写入好感度必须带 delta。本次未修改。' };
    }

    const written = false;
    // ★ `written:false` 是**契约字段**，不是"没写"的自白：消费方 `orchestrator/index.js:1458`
    //   明确要求 `data.mode==='write' && data.written===false` 才派生 relationDelta（工具自己不许落账，
    //   见上面 2026-10-05 改判）。改成 true 会**当场断链** ⇒ 别动这个值。
    const missingReason = hasDelta && !reason;
    // ★★ B10（2026-10-11 用户裁定「好感改回老树语义」）：**这一段的类别门槛与"永不计分语"全部撤掉**。
    //   改前（glm1 · 同日上午）工具**当场**借 M7 的 `classifyFavorReason` / `neverScoreHit` 预判：
    //   归不进七类、或撞上"顶嘴/反对/拒绝/被纠正"，就回执"本次不会落账"，还教模型"换一句能归进去的再调"
    //   ⇒ 模型为了过闸去**改写自己的评价**（实测两句真理由被拦："本人自愿当实验品"、"本人主动申报自己是麻烦精"）。
    //   用户判语：「吵架、争执、意见不同本身就是会掉好感的，什么叫这个不掉就是服从度。好感就是 LLM 自己
    //   决定的，他有权决定自己对谁好对谁坏。」⇒ act 侧现在只做两件事：**理由原样带上**、**回执不许"看起来已生效"**。
    //   ★ 方向与幅度**只听模型的 delta**：绝不按理由文案改符号、改幅度或改成 0。
    //   ★ 落账最终判定在 M15/M7（`orchestrator/index.js:1478-1495`），那侧的类别门槛归 sp2 撤（B10 另一半），
    //     本文件不许为了"回执好听"去猜它判什么。
    let favorNote;
    if (missingReason) {
      favorNote = '本次**不会落账**：改好感必须同时给 reason —— 照实写你为什么这么判就行（不要求字数、不要求格式、不必归进任何类别）。补上 reason 再调一次。';
    } else if (hasDelta && delta === 0) {
      favorNote = '本次**不会改好感**：delta=0（等于没要求改）。要动就给一个非零值，正负与幅度都由你定。';
    } else if (!hasDelta) {
      favorNote = '';
    } else {
      favorNote = `已转交系统按你的理由计分（${delta > 0 ? '+' : ''}${delta}，理由按你原话带上、不限类别）：本轮结束时由 M15 从本回执派生 relationDelta 落账；**此刻还没落账**，别当成已经改完。`;
    }
    // ★★ 2026-10-11（指挥位派单）：加**显式落账状态字段**，治"回执看着像成功、账上却没动"。
    //   ★ 语义必须是**老树撤门槛后**的样子：`applied===false` 从此只有一种含义 = **没进落账链**；
    //     原先那种"归不进七类所以不落账"已随 B15 用户裁定消失，这里**不许**再产那种值。
    //   ★★ `favorOutcome` 的取值只能是这两种之一 —— **工具不许报 `settled`**：
    //     `memory_favor` 从不写库（2026-10-02/10-05 用户裁决：M15 是情绪事件唯一 owner，见上面 written 的契约说明），
    //     落账发生在**本轮结束时**（M15 派生 relationDelta → M7 applyEvent）。工具返回的那一刻**不可能知道**落没落 ⇒
    //     报 `settled`/`applied:true` 就是当场造假（正是本项目反复在抓的"看起来成功"）。
    //     ★ 真"已落账"的权威信号在 M15 那侧：它已经按 reasonCode 逐条留痕
    //       （`orchestrator/index.js` 的 `emotion-relation-delta-skipped`：incomplete-tool-evidence /
    //       event-contract-invalid / …），界面要显示" settles 了没"应当读那条，不是读这里（已报指挥）。
    //   `pending-round-end` = 工具这半的条件齐了、已进链，等轮末落账；
    //   `not-settled:<原因>` = **当场就能确定不会落账**（三种真原因：只查看 / delta=0 / 缺 reason）。
    const favorOutcome = !hasDelta
      ? 'not-settled:只查看（没传 delta，本次不请求改好感）'
      : missingReason
        ? 'not-settled:reason 为空（M15 派生不出事件，reasonCode: incomplete-tool-evidence）'
        : delta === 0
          ? 'not-settled:delta=0（等于没要求改）'
          : 'pending-round-end';
    const out = {
      userId: uid,
      mode: hasDelta ? 'write' : 'view-only',
      requestedDelta: delta,
      reason,
      written,
      // ★ 派单要求的显式字段（与 `written:false` 并存，各管一件事：`written` 是 M15 的**触发条件**，
      //   `applied` 是给调用方/界面看的**结果口径**）。★ 恒 false —— 理由见上面 favorOutcome 那段。
      applied: false,
      favorOutcome,
      // 当前关系：数字只给 UI/trace 看（emotion/relation.js:5-7 的口径）⇒ 这里只回"话"，不回裸分
      relationKnown: !!(relation && relation.known),
      styleHint: hint,
      // ★ B10：原先这里有 `reasonClassified: 'help' | 'never-score' | 'unclassified'` —— 那是**类别门槛**
      //   在回执里的残留（让模型当场看见"我这句归到哪类/归不进"）。门槛撤了，这个字段就没了意义，
      //   而且留着等于继续暗示"要写成能归类的样子"。★ 撤掉，不改名保留。
      //   （派单说"可能还有人读"⇒ 已全仓核过：`reasonClassified` 除本切片自测外**零读者**，不复活。）
      note: !hasDelta
        ? '仅查看；本次未修改好感度。'
        : favorNote,
      // 落账条件照消费方逐条写清（`orchestrator/index.js:1472-1476`）：缺任一条就静默跳过，
      // 模型看不到原因 ⇒ 这里如实说，别让它以为"调了就生效"。
      settlesVia: 'M15 从本回执派生 relationDelta → M7 applyEvent（orchestrator/index.js:1478-1495）',
      ...(missingReason ? { chainBreak: 'reason 为空 ⇒ 会被跳过（reasonCode: incomplete-tool-evidence），好感不变' } : {}),
      ...(favSoftWarn ? { warning: favSoftWarn } : {})
    };
    return { ok: true, data: out };
  },

  // ─────────────────────────────────────────────────────────────────────────
  // memory_archive（旧 src/tools.js:2973-3078）—— 2026-10-09 N35 五个模式全接通
  // 出口：M6 的扁平归档出口（`modules/memory/archive-view.js`，见上面 `archiveExit()` 的说明）。
  // ★ 修掉的病：原先探 `ctx.modules.memory.archive.load` 这个**不存在的嵌套形状** ⇒ 恒 null
  //   ⇒ **连 mode=list 都永远报「依赖未就绪」**（工具表里挂着、模型点了必失败）；
  //   而 list 之外的 4 个模式压根没写，直接 `error: '…分支尚未迁移'`。
  // ★ 与老树共用「单次运行检索上限」（`takeMemorySearchBudget`，老树 :2993）——超限拒绝，
  //   防模型在一轮里连着翻归档。
  // ⚠ ChatStore（modules/memory/chat-store.js）只负责**存取原始消息**，没有日/小时聚合视图
  //   —— 别把它当 ArchiveReader 用（聚合视图在 archive-view.js）。
  // ─────────────────────────────────────────────────────────────────────────
  async memory_archive(ctx, args) {
    // 老树 :2997 的口径：不填 mode 就当 list（工具表 required:['mode']，但模型常漏）
    const mode = String(args?.mode || 'list');
    const chatKey = String(args?.chatKey || ctx?.chatKey || '');
    const all = args?.all === true;
    const budget = takeMemorySearchBudget(ctx);
    if (!budget.ok) return { ok: false, error: budget.error };

    const archive = archiveExit(ctx);
    if (!archive) {
      return notReady(
        'memory_archive',
        '归档聚合读取（memory.listArchiveChatKeys/listArchiveDays/listArchiveHours/countArchiveMatches/loadArchive）'
        + ' + 显式 dataDir（memory.getDataDir()，装配层 apps/server/assembly.js:654 注入）',
        {
          parsed: {
            mode,
            chatKey,
            all,
            day: args?.day ?? null,
            hour: args?.hour ?? null,
            dayFrom: args?.dayFrom ?? null,
            dayTo: args?.dayTo ?? null,
            limit: Math.min(40, Math.max(5, Number(args?.limit) || 20))
          }
        }
      );
    }
    const text = (content) => ({ ok: true, data: { content, left: budget.left === Infinity ? null : budget.left } });
    const fail = (error) => ({ ok: false, error: String(error ?? '归档失败') });

    try {
      // ── list：会话列表 / 单会话的按天分布（老树 :3000-3018）─────────────────
      if (mode === 'list') {
        if (all) {
          const keys = archive.listChatKeys();
          const rows = keys.map((k) => {
            let last = null;
            try { last = archive.listDays(k, { limit: 1 })[0] ?? null; } catch { last = null; }
            return `${k} last=${last ? `${last.dayKey}×${last.count}` : '空'}`;
          });
          return text(`会话×${keys.length}\n${rows.join('\n')}\n指定会话: chatKey=group:xxx 再 list/day/hours`);
        }
        if (!chatKey) return fail('缺少 chatKey（不填就用当前会话，但本轮没有当前会话）');
        const days = archive.listDays(chatKey, { limit: 20 });
        if (!days.length) return text(`${chatKey || '当前'} 无归档。`);
        return text(`${chatKey}\n${days.map((d) => `${d.dayKey} ×${d.count}`).join('\n')}`
          + `\n小时: mode=hours day=${days[0].dayKey} · 全天: mode=day chatKey=${chatKey} day=${days[0].dayKey}`);
      }

      // ── hours：某天的分小时分布（老树 :3020-3028）──────────────────────────
      if (mode === 'hours') {
        if (!chatKey) return fail('mode=hours 需要 chatKey');
        const day = String(args?.day || '');
        const hours = archive.listHours(chatKey, day, { limit: 24 });
        if (!hours.length) return text(`${chatKey} ${day} 无小时段。`);
        return text(hours.map((h) => `${h.hourKey} ×${h.count}`).join('\n')
          + `\n读: mode=day chatKey=${chatKey} day=${day} hour=${hours[hours.length - 1].hourKey}`);
      }

      // ── count：关键词命中统计（老树 :3030-3053）────────────────────────────
      if (mode === 'count') {
        const query = String(args?.query ?? '').trim();
        if (!query) return fail('mode=count 必须给 query（要统计的词）');
        const runOne = (ck) => archive.count({
          chatKey: ck,
          query,
          day: args?.day || null,
          hour: args?.hour || null,
          dayFrom: args?.dayFrom || null,
          dayTo: args?.dayTo || null,
          maxSamples: 2
        });
        if (all) {
          let messages = 0;
          let occurrences = 0;
          const byChat = [];
          for (const ck of archive.listChatKeys()) {
            let r = null;
            try { r = runOne(ck); } catch { r = null; }
            if (!r?.ok || !r.messages) continue;
            messages += r.messages;
            occurrences += r.occurrences;
            byChat.push(`${ck}:${r.messages}`);
          }
          return text(`「${query}」全库 消息${messages}次\n${byChat.join(' ')}\n\n细查: chatKey=… mode=count`);
        }
        if (!chatKey) return fail('mode=count 需要 chatKey（或 all=true 扫全库）');
        const r = runOne(chatKey);
        if (!r?.ok) return fail(r?.error || '统计失败');
        const top = (r.byDay || []).slice(0, 5).map((d) => `${d.dayKey}:${d.messages}`).join(' ');
        const samp = (r.samples || []).map((s) => `- ${s.when} ${s.self ? '我' : s.who}: ${cleanMemoryText(ctx, s.text)}`).join('\n');
        return text(`${chatKey}「${r.query}」消息${r.messages}次 跨${r.daysTouched}天\n${top}${samp ? `\n${samp}` : ''}`);
      }

      // ── day / range / load：读原文（老树 :3055-3074）───────────────────────
      if (!chatKey) return fail(`mode=${mode} 需要 chatKey`);
      const r = archive.load({
        chatKey,
        day: args?.day || null,
        hour: args?.hour || null,
        dayFrom: args?.dayFrom || null,
        dayTo: args?.dayTo || null,
        offset: Number(args?.offset) || 0,
        limit: Math.min(40, Math.max(5, Number(args?.limit) || 20)),
        query: args?.query || ''
      });
      if (!r?.ok) return fail(r?.error || '归档失败');
      if (!r.lines?.length) return text(`${chatKey} ${r.scope?.day || r.scope?.hour || ''} 无记录。`);
      const body = r.lines
        .map((l) => `${String(l.when).slice(5)} ${l.self ? '我' : l.who}: ${cleanMemoryText(ctx, l.text)}`)
        .join('\n');
      const tail = r.hasMore ? `\n再翻: offset=${r.nextOffset}` : '\n本页结束';
      return text(`${chatKey} ${r.scope?.day || r.scope?.hour || ''} 共${r.total} [${r.offset}..${r.offset + r.returned}]\n${body}${tail}`);
    } catch (error) {
      return fail(`归档读取失败：${error?.message ?? error}`);
    }
  },

  // ─────────────────────────────────────────────────────────────────────────
  // memory_remove（旧 src/tools.js:2330-2351）—— 2026-10-05 改判：对到 M6 `forget()`
  // 出口：`ctx.modules.memory.forget(subjectId, opts)`（index.js:298）
  // ★ 语义变了、且是**故意**的变：M6 是「撤回（retract）不做物理删除」（index.js:293），
  //   旧实现是真删。给 userId 就撤回该人的当前观察；给了 content 就先用 history() 找到
  //   那条版本的 evidenceIds 再精确撤回（forget 的入参是 evidenceIds，不是 claim —— index.js:299）。
  // ─────────────────────────────────────────────────────────────────────────
  async memory_remove(ctx, args) {
    // 同 memory_append：老树 src/tools.js:2335 只写 enum、:2343 直接硬传 'memberImpression'，从不校验。
    const category = String(args?.category ?? '').trim() || 'memberImpression';
    if (category !== 'memberImpression') {
      return { ok: false, error: 'category 必须是 memberImpression' };
    }
    const userId = normalizeQq(args?.userId);
    const target = String(args?.target ?? '').trim();
    const content = String(args?.content ?? '').trim();
    const mem = mem6(ctx);
    if (typeof mem?.forget !== 'function') {
      return notReady('memory_remove', 'ctx.modules.memory.forget()（M6 撤回；旧"真删"语义已被取代）', {
        parsed: { userId, target, content }
      });
    }
    // 没给 userId 时，旧实现允许用 target（名字）删；新记忆以 subjectId（QQ 号）索引，
    // 没有"按名字找观察"的出口 ⇒ 显式要 QQ 号，不猜。
    if (!userId) {
      return {
        ok: false,
        error: '要删记忆必须给 userId（对方 QQ 号）。新记忆按 QQ 号索引，没有按名字删的出口 —— '
          + '先 memory_query 找到人，再把号填进来。',
        data: { removed: 0, reason: 'need-userId', gotTarget: target }
      };
    }

    let evidenceIds = null;
    let matchedClaim = null;
    if (content && typeof mem?.readMemory === 'function') {
      try {
        const h = mem.readMemory({ route: 'history', input: { subjectId: userId } });
        const hit = (h?.versions || []).find((v) => String(v.claim || '').trim() === content);
        if (!hit) {
          return {
            ok: false,
            error: `没找到这条记忆：${userId} 名下没有内容为「${content.slice(0, 30)}」的观察（可能已被改写过；`
              + 'memory_query 会带回旧版本给你比对）。',
            data: { removed: 0, reason: 'claim-not-found', versions: (h?.versions || []).length }
          };
        }
        matchedClaim = hit.claim;
        evidenceIds = (hit.evidenceIds || []).slice();
      } catch (error) {
        return { ok: false, error: `查历史失败：${error?.message ?? error}`, data: { removed: 0 } };
      }
    }

    const res = await mem.forget(userId, {
      ...(evidenceIds ? { evidenceIds } : {}),
      chatKey: ctx?.chatKey,
      scope: ctx?.kind === 'private' ? 'private' : 'group',
      reason: `memory_remove：${content ? `按内容「${content.slice(0, 30)}」` : '按人全部'}`
    });
    if (res?.ok === false) {
      return { ok: false, error: `撤回失败：${(res?.errors || []).join('；') || '记忆库拒绝'}`, data: { removed: 0 } };
    }
    return {
      ok: true,
      data: {
        removed: res?.matched ?? 0,
        retracted: res?.retracted ?? [],
        matchedClaim,
        // 关键：M6 不做物理删除，历史还能翻（index.js:293）
        keptHistory: res?.keptHistory !== false,
        // P0-3（2026-10-11）：忘一条已进过情节摘要的记忆，会连带**来源抑制** ——
        // 如实回给模型：抑制成功 = 旧情节摘要不再进提示词；没写成也照实说（别让调用方以为防住了）。
        suppression: res?.suppression ?? null,
        note: res?.note || '保留历史，不做物理删除'
      }
    };
  },

  // ─────────────────────────────────────────────────────────────────────────
  // memory_meme_save（旧 src/tools.js:2352-2386）—— ★ 已搬（出口：ctx.modules.media）
  // ─────────────────────────────────────────────────────────────────────────
  async memory_meme_save(ctx, args) {
    const text = String(args?.text ?? '').trim();
    if (!text) return { ok: false, error: '缺 text（梗/结论原文，≤60字）' };
    const m = media(ctx);
    if (typeof m?.saveMeme !== 'function') {
      return notReady('memory_meme_save', 'ctx.modules.media.saveMeme()（梗库；media/index.js:50 的 memes.js 出口）', {
        parsed: { chars: text.length, tags: Array.isArray(args?.tags) ? args.tags.length : 0 }
      });
    }

    // 梗保存闸门（旧 src/tools.js:2367 的 memeSaveGate）未搬：新树 jev 角色表限 5 个，此角色未入选 ⇒ 闸门恒关。要开单独开票。
    // （原实现那段 `jev.hasRole('memeSaveGate')` 分支已于 2026-10-05 按指挥位裁定删除：角色表里没有它 ⇒
    //   该分支永不触发，却会被 jev selftest 的「双向闸」判成"表外调用点"。角色表上限 5 是有意裁定，
    //   补回角色 = 改模型可见行为（L1），不在本票范围。旧树事实：src/local-jev.js:185/:1831 定义、
    //   src/config.js:610 列在默认 roles、src/tools.js:2367-2368 调用。）

    const r = m.saveMeme({ text, tags: args?.tags, note: args?.note, source: 'model' });
    if (!r?.ok) return { ok: false, error: r?.error || '保存失败' };
    return { ok: true, data: { saved: true, deduped: !!r.deduped, meme: r.meme } };
  },

  // ─────────────────────────────────────────────────────────────────────────
  // memory_meme_search（旧 src/tools.js:2387-2406）—— ★ 已搬（出口：ctx.modules.media）
  // ─────────────────────────────────────────────────────────────────────────
  async memory_meme_search(ctx, args) {
    const query = String(args?.query ?? '').trim();
    if (!query) return { ok: false, error: '缺 query（关键词或梗片段）' };
    const m = media(ctx);
    if (typeof m?.searchMeme !== 'function') {
      return notReady('memory_meme_search', 'ctx.modules.media.searchMeme()/memeCount()', { parsed: { query } });
    }
    const limit = Math.min(8, Math.max(1, Number(args?.limit) || 4));
    const hits = m.searchMeme(query, { limit }) || [];
    const total = typeof m.memeCount === 'function' ? m.memeCount() : null;
    if (!hits.length) {
      return { ok: true, data: { content: `梗库无命中（共${total ?? '?'}条）。可以说不知道，或用 memory_meme_save 新梗。` } };
    }
    return { ok: true, data: { memes: hits, total } };
  },

  // ─────────────────────────────────────────────────────────────────────────
  // memory_todo_save（旧 src/tools.js:2526-2559）—— 2026-10-05 改判：对到新模块 `todos`
  // 出口：`ctx.modules.memory.todos?.saveTodo ?? ctx.modules.memory.saveTodo`（前向兼容探测，
  //   接线由指挥位收口；modules/memory/index.js 归 sb4，本切片不碰）。
  // 能力本体见 `refactor/modules/memory/todos.js`（逐字搬 src/conversation-memory/pending.js）。
  // ─────────────────────────────────────────────────────────────────────────
  async memory_todo_save(ctx, args) {
    const text = String(args?.text ?? '').trim();
    if (!text) return { ok: false, error: '缺 text（待办，≤80字）' };
    // 归一化照搬 src/tools.js:2540-2545：负号转正 + 本轮只有一人时自动绑定
    let uid = normalizeQq(args?.userId);
    const raw = ctx?.triggerUserIds;
    if (!uid && Array.isArray(raw) && raw.length === 1) uid = String(raw[0]);
    const saveTodo = todosExit(ctx)?.saveTodo;
    if (typeof saveTodo !== 'function') {
      return notReady(
        'memory_todo_save',
        'ctx.modules.memory.todos.saveTodo（modules/memory/todos.js 已交付，装配层尚未挂载）',
        { parsed: { textChars: text.length, expireInMinutes: Number(args?.expireInMinutes) || 120, userId: uid } }
      );
    }
    const r = saveTodo({
      chatKey: ctx?.chatKey,
      text,
      expireInMinutes: args?.expireInMinutes,
      userId: uid,
      note: args?.note
    });
    if (!r?.ok) return { ok: false, error: r?.error || '保存失败' };
    return {
      ok: true,
      data: {
        saved: true,
        expiresAt: r.todo?.expiresAt,
        inMinutes: r.todo?.expireInMinutes,
        deduped: !!r.deduped
      }
    };
  },

  // ─────────────────────────────────────────────────────────────────────────
  // memory_todo_done（旧 src/tools.js:2561-2572）
  // ─────────────────────────────────────────────────────────────────────────
  async memory_todo_done(ctx, args) {
    const text = String(args?.text ?? '').trim();
    const completeTodo = todosExit(ctx)?.completeTodo;
    if (typeof completeTodo !== 'function') {
      return notReady(
        'memory_todo_done',
        'ctx.modules.memory.todos.completeTodo（modules/memory/todos.js 已交付，装配层尚未挂载）',
        { parsed: { text } }
      );
    }
    const done = completeTodo({ chatKey: ctx?.chatKey, text });
    return { ok: true, data: { done: done === true } };
  },

  // ─────────────────────────────────────────────────────────────────────────
  // remember_self_impression（旧 src/tools.js:2136-2216）—— 写 persona.roleText 的「## 自我印象」区
  // 2026-10-05 指挥位给了落点：M1 的落盘出口已上线，挂载点 `modules.configStore`（apps/server/assembly.js:151）。
  // ★ 旧 tools.js 只是委托给 `src/self-impressions.js`，**真正的拼接格式在那个文件**（已逐字搬成本文件顶部）。
  // ★ 硬约束：`set()` / `updateConfig()` 只改内存，不许当保存用（config-store/index.js:218 / :262）——
  //   这里只用 `updateConfigAndSave`（:413）；若它不在，退回 `updateConfig` + 显式 `saveConfig`，再否则报未就绪。
  // ─────────────────────────────────────────────────────────────────────────
  async remember_self_impression(ctx, args) {
    // ① 入参校验照搬 src/tools.js:2162-2175（剥引号 / 160 字上限 / 禁注释标记）
    const content = unquote(args?.content);
    if (!content) return { ok: false, error: '缺少 content 参数或内容为空' };
    if (content.length > 160) {
      return { ok: false, error: `内容过长（${content.length} 字符），限制 160 字符` };
    }
    // 禁注释标记：这两串正是自我印象区的定界符，放进来就能提前闭合区块、改写人设卡
    if (/<!--|-->/i.test(content)) return { ok: false, error: '内容包含非法注释标记' };

    const store = ctx?.modules?.configStore ?? null;
    const cfg = ctx?.cfg;
    const canUpdate = typeof store?.updateConfig === 'function'
      && (typeof store?.updateConfigAndSave === 'function' || typeof store?.saveConfig === 'function');

    // ② 若将来有人把 selfImpressions 模块搬进来，优先用它（省得我再拼一次）
    const mod = ctx?.modules?.selfImpressions ?? null;
    if (typeof mod?.addSelfImpression === 'function') {
      const items = typeof mod.getSelfImpressions === 'function' ? mod.getSelfImpressions() : [];
      if (items.length >= SELF_IMP_MAX && !items.includes(content)) {
        return { ok: false, error: `自我印象已满（${items.length}/${SELF_IMP_MAX}），无法添加。请先在角色卡或记忆页清理旧印象。` };
      }
      const r = mod.addSelfImpression(content);
      if (!r?.ok) return { ok: false, error: r?.error || '添加自我印象失败' };
      return {
        ok: true,
        data: {
          saved: true,
          deduped: !!r.deduped,
          message: r.deduped ? '该自我印象已存在，无需重复记录' : '自我印象已记录到人设卡',
          content,
          currentCount: r.items?.length ?? items.length,
          maxItems: SELF_IMP_MAX,
          via: 'ctx.modules.selfImpressions'
        }
      };
    }

    // ③ 自拼（格式逐字照搬 src/self-impressions.js）——但**必须有真落盘出口**
    if (!canUpdate) {
      return notReady(
        'remember_self_impression',
        '配置落盘出口 ctx.modules.configStore.updateConfigAndSave()'
        + '（cfg.set/updateConfig 只改内存、不落盘 —— 已知 G6）',
        { parsed: { chars: content.length, maxItems: SELF_IMP_MAX } }
      );
    }

    const roleText = String(cfg?.get?.('persona.roleText', '') ?? '');
    const items = parseSelfImpressions(roleText);

    // 去重优先（旧 :112-113 的口径）：已有这条 ⇒ 不算"满员"、不算新增
    if (items.includes(content)) {
      return {
        ok: true,
        data: {
          saved: true,
          deduped: true,
          message: '该自我印象已存在，无需重复记录',
          content,
          currentCount: items.length,
          maxItems: SELF_IMP_MAX,
          via: 'ctx.modules.configStore'
        }
      };
    }
    // 满员拒绝（旧 tools.js:2183-2185）
    if (items.length >= SELF_IMP_MAX) {
      return {
        ok: false,
        error: `自我印象已满（${items.length}/${SELF_IMP_MAX}），无法添加。请先在角色卡或记忆页清理旧印象。`
      };
    }

    // ④ 拼整段角色卡：保留 persona 其余键（旧 src/self-impressions.js:82 的 `{...(getConfig().persona||{}), roleText}`）
    const persona = { ...(cfg?.get?.('persona', {}) || {}), roleText: renderSelfImpressions(roleText, [...items, content]) };
    const nextCount = cleanSelfItems([...items, content]).length;
    try {
      const saved = typeof store.updateConfigAndSave === 'function'
        ? store.updateConfigAndSave({ persona }, { log: ctx?.log ?? null })
        : (store.updateConfig({ persona }), store.saveConfig({ log: ctx?.log ?? null }));
      return {
        ok: true,
        data: {
          saved: true,
          message: '自我印象已记录到人设卡',
          content,
          length: content.length,
          currentCount: nextCount,
          maxItems: SELF_IMP_MAX,
          roleTextChars: persona.roleText.length,
          file: saved?.file ?? null,
          backedUp: saved?.backedUp ?? null,
          via: 'ctx.modules.configStore'
        }
      };
    } catch (error) {
      // M1 的语义（config-store/index.js:408）：内存**已经**是新值，只是没写下去。
      // 必须说清楚，否则模型/用户会以为"没生效"，而下一次别的保存会把它带上去。
      return {
        ok: false,
        error: `自我印象没落盘：${error?.message ?? error}`
          + '（内存里已经是新值，但磁盘未更新 ⇒ 重启会丢；请管理员在记忆页重试或手工保存）',
        data: { saved: false, writtenToDisk: false, memoryUpdated: true, content, maxItems: SELF_IMP_MAX }
      };
    }
  }
};
