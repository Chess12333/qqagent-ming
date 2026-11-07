/**
 * N28 · 记忆条目的**投影层**（进提示词之前先把条目收拾干净）
 *
 * 为什么单独一个文件：`prompt/blocks.js` 本轮归 sp1（N25 提示词可读性）。
 * 本模块只做**过滤侧**——决定"传什么给 renderMemoryView"，一行都不改 blocks.js。
 *
 * 三件事（每件都对应一个用户抱怨）：
 *
 * ① **私聊不许看见别人的印象**（用户裁定，优先于 `memory/scope.js` 的"global 跨群可用"原设计）
 *    判据（私聊，`kind === 'private'`）——**白名单 + fail-closed**：
 *      · 主体是**本轮对话人**（对方账号）→ 进
 *      · 主体是**机器人自己** → 进（它得记得用户的习惯）
 *      · 主体是**调用方点名要的**（`need.subjectIds`）→ 进（这才是"与本轮话题直接相关"的可验证形态）
 *      · 其余一切（尤其是 `scope='global'` 的**第三方**印象）→ **不进**
 *      · 主体字段为空 ⇒ 来历不明 ⇒ **不进**（宁可少给，不给错人）
 *    ⇒ 这里**刻意不做**"按话题词模糊匹配"：中文短句共用词太多，模糊匹配会把别人的印象
 *      重新漏进私聊，等于把 bug 换个入口。要放宽只能走上面第 ③ 条（显式点名）。
 *
 *    群聊口径：**不变**。群里本来就是"认识的人互相知道"，跨群 global 印象是
 *      `memory/scope.js:34-35` 刻意设计的；用户这次只否掉了私聊里的用法。
 *
 * ② **内部证据 id 不许进模型可见文本**（"给模型看的是内容，不是记账 id"，与 N25 同一条原则）
 *    记忆视图的入参里**根本没有证据账本**（见 blocks.js 顶部硬边界 1），
 *    模型拿着 `mig-ev:person:3985729580:0` 也查不到任何东西，却白烧字符、白泄露内部标识与账号。
 *    ⇒ 换成模型唯一用得上、又不泄露任何内部标识的说法：**有几处出处**。
 *      真实 id 落到 `report.evidenceIds`（diagnostics/日志侧），不进提示词。
 *      ★ 用的是**复制**出来的数组，绝不就地改调用方的 `context.recalled`。
 *
 * ③ **每条 claim 截断 + 整段字符硬上限**（"这块打不了缓存、占用还这么大"）
 *    改前只有 `maxItems` 一道闸，**每条 claim 原文照灌**（探针实测：单条 450 字）。
 *    这里加两道：单条 `maxClaimChars`、整段 `maxChars`（后者在 index.js 里按**真渲染长度**回退条数）。
 *
 * ④ **抑制账本不在这里查**（M6 读点，2026-10-14 定口径）：遗忘的收口在**源头三条腿** ——
 *    `memory/index.js retrieve()`（关键词腿）、`memory/coordinator.js recallWithSemantic()`（语义腿）、
 *    `memory/chat-search.js`（检索出口），三处共用 `memory/suppressions.js` 那一份判据。
 *    本模块不读盘、不持有 `dataDir`，在这里补等于写**第二份**判定口径 —— 两份口径迟早漂移，
 *    漂移后哪一条说了话没人说得清。调用方绕过那三条腿直接塞 `context.items` 时这里给不出兜底，
 *    那是**调用方的 bug**，该在调用方修。
 *
 * 纯函数：不读盘、不调 `Date.now()`（`now` 从入参来）。
 */

/** 单条 claim 截断后的尾标（与 blocks.js `clip()` 同一口径：说清楚被截了多少，不静默）。 */
function clipClaim(text, max) {
  const value = String(text ?? '');
  const cap = Math.floor(Number(max));
  if (!Number.isFinite(cap) || cap <= 0 || value.length <= cap) return value;
  return `${value.slice(0, cap)}…（已截 ${value.length - cap} 字）`;
}

/**
 * 本轮"对话人"的账号集合（**白名单的来源**）。
 *
 * 取值来源，按可靠度：
 *   1. `peerId` —— 调用方显式给的（最权威，目前无人传，留给将来）
 *   2. 本轮证据里 `kind === 'private'` 的**发信人**（对方；机器人自己是 `selfId`，不含）
 *   3. `chatKey` 的 `private:<uin>` 后缀（主动轮没有新证据时唯一可得的来源，
 *      与 `orchestrator/index.js` 里的私聊取号写法一致）
 *
 * @param {object} p
 * @param {'group'|'private'} p.kind
 * @param {string} p.chatKey
 * @param {Array} [p.evidence] 已通过 §3.1 校验的 MessageEvidence
 * @param {string|number} [p.peerId]
 * @param {string|number} [p.selfId] 机器人自己的账号（允许看见关于自己的印象）
 * @returns {{ids:Set<string>, sources:string[]}}
 */
export function counterpartIds({ kind = 'group', chatKey = '', evidence = [], peerId = null, selfId = null } = {}) {
  const ids = new Set();
  const sources = [];
  if (kind !== 'private') return { ids, sources };

  const add = (value, source) => {
    const id = String(value ?? '').trim();
    if (!id) return;
    ids.add(id);
    if (!sources.includes(source)) sources.push(source);
  };

  add(peerId, 'peerId');
  for (const e of Array.isArray(evidence) ? evidence : []) {
    if (e?.kind !== 'private') continue;                 // 群聊证据里的发信人**不是**私聊对话人
    const self = String(e?.selfId ?? '').trim();
    const sender = String(e?.sender?.id ?? '').trim();
    if (sender && sender !== self) add(sender, 'evidence');
  }
  const m = /^private:(.+)$/.exec(String(chatKey ?? '').trim());
  if (m) add(m[1], 'chatKey');
  if (selfId !== null && selfId !== undefined) add(selfId, 'self');

  return { ids, sources };
}

/**
 * 私聊可见性判据：`scope='global'` 的印象**只有主体是白名单里的人**才准进私聊。
 *
 * @returns {{ok:boolean, reason:string}}
 */
export function visibleInChat(item, { kind = 'group', chatKey = '', allowedSubjects = null } = {}) {
  if (!item || typeof item !== 'object') return { ok: false, reason: 'subject:invalid-item' };
  if (kind !== 'private') return { ok: true, reason: 'group:unchanged' };

  const scope = String(item.scope ?? 'global');
  // 本私聊自己的细节：上游 `memory/scope.js` 的 `visibleIn()` 已经把它绑死在**本 chatKey**上，
  // 这里只做防御性复查（万一哪天有别的调用方绕过那道闸）。
  if (scope === 'private') {
    const itemChat = String(item.chatKey ?? '').trim();
    return itemChat && itemChat !== String(chatKey ?? '')
      ? { ok: false, reason: 'scope:foreign-chat' }
      : { ok: true, reason: 'private:own-scope' };
  }

  // ★ 2026-10-16 修复（印象/记忆"只记不注入"的一条真断点）：
  //   语义召回腿（`memory/coordinator.js:1187-1203` 的 keep.push）带的是 `personId`
  //   （= `row.subjectId`），**不带 `subjectId` 这个键**；而向量融合（`semantic.js:757-761`）
  //   又**优先放语义项** ⇒ 向量服务开着时，这条腿的条目在私聊会被旧判据当成"来历不明"挡掉，
  //   等于"开了向量，私聊记忆视图反而更少"。
  //   两键同义（关键词腿 `memory/index.js:692/703` 两个都带；coordinator 小契约 `:700` 也写明
  //   `personId = it.personId ?? it.subjectId`）⇒ 这里按同义取值；两者都空仍是 fail-closed。
  const subject = String(item.subjectId ?? item.personId ?? '').trim();
  if (!subject) return { ok: false, reason: 'subject:unknown' };
  if (allowedSubjects && allowedSubjects.has(subject)) return { ok: true, reason: 'subject:allowed' };
  return { ok: false, reason: 'subject:not-this-conversation' };
}

/**
 * 把一批记忆条目投影成"可以进提示词"的样子。**纯函数，不改入参**。
 *
 * @param {Array} rows `retrieve()` / `prepareContext()` 的条目
 * @param {object} opts
 * @param {'group'|'private'} opts.kind
 * @param {string} [opts.chatKey] 本会话键（private 项复查用）
 * @param {Set<string>} [opts.allowedSubjects] 对话人白名单（私聊才用）
 * @param {number} opts.maxClaimChars 单条 claim 上限；0/NaN = 不截
 * @returns {{items:Array, report:object}}
 */
export function projectMemoryItems(rows, { kind = 'group', chatKey = '', allowedSubjects = null, maxClaimChars = 0 } = {}) {
  const report = {
    input: Array.isArray(rows) ? rows.length : 0,
    kept: 0,
    dropped: 0,
    droppedReasons: {},
    claimClipped: 0,
    claimCharsSaved: 0,
    evidenceIdsDesugared: 0,
    evidenceIds: {}
  };
  const items = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const v = visibleInChat(row, { kind, chatKey, allowedSubjects });
    if (!v.ok) {
      report.dropped++;
      report.droppedReasons[v.reason] = (report.droppedReasons[v.reason] || 0) + 1;
      continue;
    }

    // ── 内部证据 id → "几处出处"（模型查不到内部 id，也不需要；真实 id 留给排障）
    const ids = Array.isArray(row.evidenceIds) ? row.evidenceIds : [];
    const realIds = ids.map((x) => String(x ?? '')).filter((x) => x !== '');
    let evidenceIds = ids;
    if (realIds.length) {
      const token = `${realIds.length} 处出处`;
      evidenceIds = [token];
      // ★ 键用序号而不是 token：`token` 是**按条数**生成的，多条会撞成一个键、
      //   后写的把先写的盖掉（实测过）⇒ 排障时对不上是哪条。用 claim 前 40 字做索引。
      report.evidenceIds[`#${report.evidenceIdsDesugared + 1} ${token}`] = {
        claim: String(row.claim ?? '').slice(0, 40),
        realIds
      };
      report.evidenceIdsDesugared++;
    }

    // ── 单条 claim 截断
    const rawClaim = String(row.claim ?? '');
    const claim = clipClaim(rawClaim, maxClaimChars);
    if (claim !== rawClaim) {
      report.claimClipped++;
      report.claimCharsSaved += rawClaim.length - claim.length;
    }

    items.push({ ...row, claim, evidenceIds });
    report.kept++;
  }

  return { items, report };
}

/**
 * 按**真渲染长度**回退条数：从 `from` 条往下试，取仍不超过 `maxChars` 的最大条数。
 * 至少留 1 条（一条都不给会制造"这里什么都没有"的假前提，比超一点更糟）。
 *
 * @param {(n:number)=>{text:string}} render
 * @param {number} from 起始条数上限
 * @param {number} maxChars 整段字符上限；<=0 = 不启用
 * @returns {{count:number, chars:number}}
 */
export function fitCountByChars(render, from, maxChars) {
  const start = Math.max(1, Math.floor(Number(from) || 0) || 1);
  const cap = Number(maxChars);
  if (!Number.isFinite(cap) || cap <= 0) return { count: start, chars: render(start).text.length };
  for (let n = start; n >= 1; n--) {
    const text = render(n).text;
    if (text.length <= cap || n === 1) return { count: n, chars: text.length };
  }
  return { count: 1, chars: render(1).text.length };
}