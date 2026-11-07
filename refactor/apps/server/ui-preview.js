// W-3b (1)：把"真发给模型的那份 messages"抄一份给面板看。
//
// 为什么抄在 **llm 调用边界** 而不是 UI 侧凭配置重拼：
//   重拼必然假绿 —— 扩展钩子（M12 `hookBeforeLlmMessages`）在 compose.js:364 就地改 messages，
//   UI 那边拿不到这次改动，展示出来的就不是发出去的那份。
//   这里包的是 `modulesObj.llm.chatCompletionWithRetry` 的**入参本身** ⇒ 抄到的就是发出去的。
//
// 落盘边界（票面铁律）：
//   · **只**写 `<dataDir>/ui-preview/**`（新目录，与 `data/sessions` 分开）。
//   · **不碰任何 ledger / trace** —— 那些文件里有"正文不落盘"的契约，这里落的多半就是真正文。
//   · 一键清空 = `clear()`。
//   · 任何异常一律 fail-open：观测不许反噬主链，抄不动就少抄，绝不抛给调用方。
import fs from 'node:fs';
import path from 'path';

const RING_MAX = 200;
const DAY_KEEP = 400;
// ★ P-1（主人 04:xx 令「一整块放进去就行了」）：**messages 正文不再截断**。
//   原来每条 60000 字、整轮 400000 字的闸会把主人正要看的那段（长历史/长系统提示）切掉，
//   切完还留一行「…〔预览截断，原 N 字符〕」⇒ 观感更乱。长文本靠**可滚动的整块**呈现，不靠截断。
//   计数与裁剪仍留在**响应侧**（`RESPONSE_PREVIEW_CAP`）：那是"模型回了什么"的摘要，不是发出去的输入。
const RESPONSE_PREVIEW_CAP = 600;

/**
 * ★ A47（2026-10-08）：冷启动回填时**每个文件最多读尾部多少字节**。
 *
 * 为什么要有这个上限：`turns-YYYY-MM-DD.jsonl` 是**只增不减**的（每天追加，**没有轮转**）。
 * 原来回填是 `readFileSync` 整份读 ⇒ 盘上现在才 2.3MB 无感，涨到几百 MB 时一次冷启动会把整个文件读进内存。
 * 取尾部是对的：这些文件是 **append 写在末尾**的 ⇒ 尾部就是最新，而 ring 只需要最新的 `ringMax` 条。
 * 超限被切掉的文件会**如实记账**（`backfilled.truncatedFiles`），不假装读全了。
 */
const BACKFILL_TAIL_BYTES = Math.max(64 * 1024, Number(process?.env?.QQ_AGENT_UI_PREVIEW_TAIL_BYTES) || 8 * 1024 * 1024);
export { BACKFILL_TAIL_BYTES };

/** 系统提示按 `【小标题】` 切块（口径 = modules/prompt/system-rules.js 的 parts 拼接）。 */
export function splitSystemBlocks(text) {
  const src = String(text ?? '');
  const out = [];
  const re = /^【([^】\n]{1,24})】/gm;
  let hit;
  const marks = [];
  while ((hit = re.exec(src)) !== null) marks.push({ label: hit[1], start: hit.index });
  if (!marks.length) return [{ label: '系统规则', start: 0, chars: src.length }];
  if (marks[0].start > 0) out.push({ label: '开场（人格声明）', start: 0, chars: marks[0].start });
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : src.length;
    out.push({ label: m.label, start: m.start, chars: end - m.start });
  });
  return out;
}

/** 分卷按**本地日**切（用 UTC 会让深夜那一轮跑进明天的文件里，人看不出所以然）。 */
function localDay(at) {
  const d = new Date(Number(at) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clipText(value, cap) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}…〔响应摘要裁剪，原 ${text.length} 字符〕`;
}

/** 非字符串 content（多模态数组/对象）按原样序列化 —— 不许悄悄丢掉。 */
function contentText(value) {
  return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
}

/**
 * ★ P-1：把这一轮**真发出去的 messages** 按顺序拼成**一整块**文本。
 *
 * 为什么拼在**服务端**而不是 UI 侧：票面铁律「不许为了排版好看而在 UI 侧重拼一份」——
 *   重拼的那份拿不到 M12 钩子（compose.js:364 就地改 messages）的改动，看着像、其实不是发出去的那份。
 *   这里唯一的数据源就是 `snapshotMessages` 抄到的边界入参，本函数**只加角色行与空行**，不改一个字的正文。
 *
 * 呈现口径（主人原话：「一整块放进去就行了」）：
 *   · 一条消息 = 一行角色标注 + 正文原样，**条目之间空一行**（牙3：角色可辨 + 换行分隔）。
 *   · 工具结果标 `—— 工具结果 ——`（票面给的极简前缀）。
 *   · **没有**分段标题 / 徽章 / 逐段计数 / 分块清单（那些是上一版"太乱"的来源，牙2 逐条断言不存在）。
 *   · **不截断**（牙4）。
 *
 * @param {Array<{role?:string,content?:unknown,toolCallNames?:string[]}>} messages
 * @returns {string}
 */
export function formatTurnBlock(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list.map((m) => {
    const role = String(m?.role ?? '');
    // 两种形状都吃：抄手里的行是 `toolCallNames`，调用方直接传**真 messages** 时是 `tool_calls`
    //   （牙1 要拿"边界那份"逐字符比"整块"，两边拼出来的角色行必须一致）
    const raw = Array.isArray(m?.toolCallNames) ? m.toolCallNames
      : Array.isArray(m?.tool_calls) ? m.tool_calls.map((c) => String(c?.function?.name ?? c?.name ?? '')) : [];
    const calls = raw.filter((n) => String(n ?? '') !== '');
    const label = role === 'tool' ? '工具结果' : (role || '（这条没有 role）');
    const head = calls.length ? `—— ${label}（工具调用：${calls.join('、')}） ——` : `—— ${label} ——`;
    const text = contentText(m?.content);
    // 正文为空（assistant 只调工具不写字）⇒ **只给角色行**，不留一个光秃秃的换行：
    //   留了就会在相邻两块之间多出连续空行，整块看着又"乱"回去了（这条是牙3 抓出来的）。
    return text ? `${head}\n${text}` : head;
  }).join('\n\n');
}

function snapshotMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list.map((m) => ({
    role: String(m?.role ?? ''),
    content: contentText(m?.content),
    contentChars: contentText(m?.content).length,
    name: m?.name == null ? '' : String(m.name),
    toolCallNames: Array.isArray(m?.tool_calls) ? m.tool_calls.map((c) => String(c?.function?.name ?? '')) : [],
    toolCalls: Array.isArray(m?.tool_calls) ? m.tool_calls : [],
  }));
}

/** 历史行（clear() 之前落的）正文本来就带着当年的截断标记 ⇒ 原样给出，不许在这里再切一刀。 */
function messagesFromRow(row) {
  return Array.isArray(row?.messages) ? row.messages : [];
}

function summarize(row) {
  const system = row.messages.find((m) => m.role === 'system');
  const rest = row.messages.filter((m) => m.role !== 'system');
  return {
    id: row.id,
    at: row.at,
    dateKey: row.dateKey,
    chatKey: row.chatKey,
    // ★ P-2：预览的**主关联键是 sessionId（运行会话）**，chatKey 退居"这个聊天对象"的辅助信息。
    //   缺了 sessionId 时（老行 / 编排层没盖章）这两个值是空串 ⇒ 面板必须如实说"没挂上会话"，
    //   不许拿 chatKey 或时间窗**顶替**（那正是主人报的"一个会话看到多次会话的输入预览"的成因）。
    sessionId: String(row.sessionId ?? ''),
    roundId: String(row.roundId ?? ''),
    seq: row.seq,
    messageCount: row.messages.length,
    totalChars: row.messages.reduce((sum, m) => sum + Number(m.contentChars || 0), 0),
    roles: row.messages.map((m) => m.role),
    systemBlocks: system ? splitSystemBlocks(system.content) : [],
    tailSections: rest.map((m) => ({ role: m.role, chars: Number(m.contentChars || 0) })),
    buildSections: row.buildSections || [],
    droppedSections: row.droppedSections || [],
    persona: row.persona || null,
    styleHintChars: Number(row.styleHintChars || 0),
    tools: row.tools || [],
    toolCount: Array.isArray(row.toolSchemas) ? row.toolSchemas.length : 0,
    requestCapture: String(row.requestCapture ?? 'pre-send-only'),
    response: row.response || null,
    error: row.error || '',
  };
}

export function createUiPreview({ dataDir = '', log = null, ringMax = RING_MAX } = {}) {
  const dir = dataDir ? path.join(String(dataDir), 'ui-preview') : '';
  const ring = [];
  let seq = 0;
  let pendingBuilds = new Map();
  let dropped = 0;
  let truncated = 0;

  const note = (level, code, meta = {}) => {
    try { log?.(`[ui-preview] ${level} ${code} ${JSON.stringify(meta)}`); } catch { /* 日志口本身可能不接 */ }
  };

  const dayFile = (dateKey) => (dir ? path.join(dir, `turns-${dateKey}.jsonl`) : '');

  /**
   * ★ U4（2026-10-08）：**冷启动回填**。
   *
   * 病根（本票给的证据，盘上 57 行、全带 sessionId、会话文件都在）：
   *   进程重启后 `ring` 是**空**的，而 `list()` 只读 `ring` ⇒ `/api/ui-preview/by-session/:id`
   *   冷启动后恒返回 `items = 0` ⇒ 面板「系统提示 / 本次输入」两栏空白；
   *   可同一个模块的 `read(id)` 却 `ok = true`（它会兜底去全扫 `turns-*.jsonl`）。
   *   ⇒ **同一个模块两种表现**：数据明明在盘上，只有"目录"这一条路失忆。
   *
   * 这里在**构造期扫一次盘**，把最近的行倒序灌回 `ring`（受 `ringMax` 约束，坏的行跳过不抛），
   * 让 `list()` 与 `read()` 一起恢复。回填**只读不写**：不追加、不改写盘上任何文件。
   *
   * @returns {{rows:number, files:number, skipped:number, ms:number}} 供 diagnostics/日志对账
   */
  /**
   * ★ A47（2026-10-08）：**有上限的读** —— 不再"整份读文件"。
   *
   * 为什么要改（U4 我自己登记的候选）：原来每个 `turns-*.jsonl` 都是 `readFileSync` 整份读进内存。
   * 现在盘上才 2.3MB 无感，但它是**只增不减**的（每天追加，且**没有轮转**）⇒ 涨到几百 MB 时
   * 一次冷启动会把整个文件读进内存。**现在做成有上限，别等它长大。**
   *
   * 上限口径（两个都设，任一到达就停）：
   *   · **每个文件最多读尾部 `BACKFILL_TAIL_BYTES` 字节**（默认 8MB）—— 用 `open`+`read` 只取尾部，
   *     不 `readFileSync` 整份；开头那截被切掉的会**如实记账**（`truncatedFiles`），不假装读全了；
   *   · **总量到 `ringMax` 就停**（行内也停，不再往下扫）。
   *
   * 切在行边界：尾部第一段可能是半行，按 `\n` 找到第一个完整行的起点再开始解（半行丢掉的算 `skipped`）。
   * ★ 结论仍然只取**最新的**那 `ringMax` 条 —— 文件按日期倒序读、每文件内也按 `at` 倒序取，
   *   所以"尾部"正是最新（append 写在文件末尾）。
   */
  function readTailLines(file, maxBytes) {
    let fd = null;
    let size = 0;
    let text = '';
    let truncated = false;
    try {
      fd = fs.openSync(file, 'r');
      size = fs.fstatSync(fd).size;
      const want = Math.max(0, Math.min(size, maxBytes));
      const start = size - want;
      const buf = Buffer.allocUnsafe(want);
      if (want > 0) fs.readSync(fd, buf, 0, want, start);
      text = buf.toString('utf8');
      truncated = start > 0;
      if (truncated) {
        // 切点可能落在半行里：丢掉第一个 '\n' 之前的那截（它是上一行的尾巴，不是完整行）
        const nl = text.indexOf('\n');
        if (nl >= 0) text = text.slice(nl + 1);
        else text = '';                       // 整个窗口里一行都凑不出 ⇒ 这一段没法用
      }
    } catch {
      text = '';
    } finally {
      if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
    return { text, truncated, bytes: size };
  }

  function backfillFromDisk() {
    const t0 = Date.now();
    const cap = Math.max(1, Number(ringMax) || RING_MAX);
    const empty = { rows: 0, files: 0, skipped: 0, ms: 0 };
    if (!dir) return empty;
    let files = [];
    try {
      files = fs.readdirSync(dir)
        .filter((f) => f.startsWith('turns-') && f.endsWith('.jsonl'))
        .sort()
        .reverse();                                  // 最近的日期文件先读，够 cap 就停
    } catch (error) {
      if (error?.code === 'ENOENT') return empty;
      note('warn', 'backfill-readdir-failed', { error: String(error?.message ?? error) });
      return empty;
    }
    const rows = [];
    let skipped = 0;
    let truncatedFiles = 0;
    let readBytes = 0;
    for (const file of files) {
      if (rows.length >= cap) break;
      const { text, truncated, bytes } = readTailLines(path.join(dir, file), BACKFILL_TAIL_BYTES);
      readBytes += Math.min(bytes, BACKFILL_TAIL_BYTES);
      if (truncated) truncatedFiles += 1;
      // 尾部 ⇒ 倒着解；凑够 cap 就能停（更老的行对 ring 没用）
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0 && rows.length < cap; i -= 1) {
        const line = lines[i];
        if (!line.trim()) continue;
        let parsed = null;
        try { parsed = JSON.parse(line); } catch { skipped += 1; continue; }   // 单行坏了不拖累别的
        if (!parsed || typeof parsed !== 'object') { skipped += 1; continue; }
        if (!parsed.id || !Array.isArray(parsed.messages)) { skipped += 1; continue; }  // 缺这两样 summarize() 会炸
        rows.push(parsed);
      }
    }
    // ring 的不变式：`record()` 是 `unshift`，所以 ring[0] = 最新。这里必须同序（新的在前）。
    rows.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0) || (Number(b.seq) || 0) - (Number(a.seq) || 0));
    const kept = rows.slice(0, cap);
    for (const row of kept) ring.push(row);
    while (ring.length > cap) ring.pop();
    const seqMax = kept.reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0);
    if (seqMax > seq) seq = seqMax;                  // 之后的 record() 别把 seq 撞回旧值
    note('info', 'backfill', { rows: ring.length, files: files.length, skipped, cap, truncatedFiles, tailMB: Math.round(BACKFILL_TAIL_BYTES / 1048576), readMB: Math.round(readBytes / 1048576) });
    return { rows: ring.length, files: files.length, skipped, truncatedFiles, readBytes, ms: Date.now() - t0 };
  }

  const backfill = backfillFromDisk();

  function ensureDir() {
    if (!dir) return false;
    try {
      fs.mkdirSync(dir, { recursive: true });
      return true;
    } catch (error) {
      note('warn', 'mkdir-failed', { error: String(error?.message ?? error) });
      return false;
    }
  }

  function appendRow(row) {
    const file = dayFile(row.dateKey);
    if (!file || !ensureDir()) return { ok: false, reason: dir ? 'mkdir-failed' : 'no-data-dir' };
    try {
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
      return { ok: true, file };
    } catch (error) {
      note('warn', 'append-failed', { error: String(error?.message ?? error) });
      return { ok: false, reason: 'append-failed' };
    }
  }

  function pruneDay(dateKey) {
    const file = dayFile(dateKey);
    if (!file || !fs.existsSync(file)) return;
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length <= DAY_KEEP) return;
      fs.writeFileSync(file, lines.slice(lines.length - DAY_KEEP).join('\n') + '\n', 'utf8');
      truncated += lines.length - DAY_KEEP;
    } catch (error) {
      note('warn', 'prune-failed', { error: String(error?.message ?? error) });
    }
  }

  function record(row) {
    seq += 1;
    const at = Number(row.at) || Date.now();
    const dateKey = localDay(at);
    const full = { ...row, id: row.id || `uip-${at}-${seq}`, seq, at, dateKey };
    appendRow(full);
    pruneDay(dateKey);
    ring.unshift(full);
    while (ring.length > ringMax) ring.pop();
    return full;
  }

  /**
   * 记录一次**提示词装配**结果（compose.js:255 的出口）。
   * 只是给下一次模型调用补上"分段/人设/styleHint 长度"这些元数据，正文仍以模型边界为准。
   */
  function recordBuild(params, built) {
    try {
      const chatKey = String(params?.chatKey ?? '');
      // ★ P-2：装配结果按**会话**排队（拿得到 sessionId 就用它），只有编排层没盖章时
      //   才退回 chatKey 队列（老行/别的调用方）—— 退回的是"同一时刻那一份"，不是时间窗猜测。
      const sessionId = String(params?.sessionId ?? '');
      const roundId = String(params?.roundId ?? '');
      const sections = Array.isArray(built?.diagnostics?.sections)
        ? built.diagnostics.sections.map((s) => ({ name: String(s?.name ?? ''), chars: Number(s?.chars) || 0, droppable: s?.droppable === true }))
        : [];
      const item = {
        at: Date.now(),
        chatKey,
        sessionId,
        roundId,
        buildSections: sections,
        droppedSections: (built?.diagnostics?.droppedSections || []).map(String),
        persona: built?.diagnostics?.persona ? {
          id: String(built.diagnostics.persona.id ?? ''),
          name: String(built.diagnostics.persona.name ?? ''),
          hype: built.diagnostics.persona.hype === true,
          personaTwo: built.diagnostics.persona.personaTwo === true,
          configSource: String(built.diagnostics.persona.configSource ?? ''),
        } : null,
        styleHintChars: String(params?.styleHint ?? '').length,
      };
      const queue = pendingBuilds.get(buildQueueKey(sessionId, chatKey)) || [];
      queue.push(item);
      while (queue.length > 8) queue.shift();
      pendingBuilds.set(buildQueueKey(sessionId, chatKey), queue);
    } catch (error) {
      dropped += 1;
      note('warn', 'build-record-skipped', { error: String(error?.message ?? error) });
    }
    return built;
  }

  /** 队列键：会话优先（P-2），没盖章时退回 chatKey（与 P-2 之前的行为逐字一致）。 */
  function buildQueueKey(sessionId, chatKey) {
    return String(sessionId ?? '') ? `s:${sessionId}` : `k:${String(chatKey ?? '')}`;
  }

  /**
   * 取走**这一次调用**该配上的装配留痕。
   * ★ P-2 的并发口径：盖了章的调用**只**认自己会话的队列，绝不退回 chatKey 队列 ——
   *   退回去就是"把别的运行（同聊天对象的另一次运行）的分段/人设安到这一行上"，
   *   那正是"看着像、其实不是"。没盖章的调用（老行为）才用 chatKey 队列，与 P-2 之前逐字一致。
   */
  function takeBuild(chatKey, sessionId = '') {
    const key = buildQueueKey(sessionId, chatKey);
    const queue = pendingBuilds.get(key);
    if (!queue?.length) return null;
    const item = queue.pop();
    if (!queue.length) pendingBuilds.delete(key);
    return item;
  }

  /**
   * 目录（面板的取数口）。
   * ★ P-2：`opts.sessionId` 是**主过滤键** —— 只给"这一个运行会话"的调用；
   *   没盖章的老行（sessionId 为空）在按会话查时**一律不给**（宁缺不混：混进来就是主人报的那个病）。
   *   `opts.chatKey` 保留（别的调用方还在用），但已不是关联主键。
   */
  function list(opts = {}) {
    const limit = Math.max(1, Math.min(Number(opts.limit) || 40, ringMax));
    const chatKey = opts.chatKey == null ? '' : String(opts.chatKey);
    const sessionId = opts.sessionId == null ? '' : String(opts.sessionId);
    const roundId = opts.roundId == null ? '' : String(opts.roundId);
    const rows = ring.filter((row) =>
      (!chatKey || row.chatKey === chatKey)
      && (!sessionId || String(row.sessionId ?? '') === sessionId)
      && (!roundId || String(row.roundId ?? '') === roundId));
    // ★ P-2：`unlinked` = 内存环里**没盖章**（缺 sessionId）的行数。面板要能如实说"还有 N 条未关联的历史预览"，
    //   而不是让它们静默消失 —— 静默消失会被读成"没数据"，混着显示又会被读成"这就是这一轮的"。
    const unlinked = ring.filter((row) => !String(row.sessionId ?? '')).length;
    return {
      ok: true,
      dir: dir || '',
      stored: Boolean(dir),
      filter: { sessionId, roundId, chatKey },
      counted: { inRing: ring.length, droppedBuilds: dropped, pruned: truncated, matched: rows.length, unlinked },
      items: rows.slice(0, limit).map(summarize),
      // ★ P-2 验收口径①：按会话查时，**没盖章的老行不并进 `items`**（并进就是冒充精确关联），
      //   而是另给一份 `unlinkedItems` ⇒ 面板显示成「未关联的历史预览」，既不串、也不让人以为数据消失了。
      unlinkedItems: sessionId
        ? ring.filter((row) => !String(row.sessionId ?? '')).slice(0, limit).map(summarize)
        : [],
    };
  }

  function read(id) {
    const needle = String(id ?? '');
    if (!needle) return { ok: false, reason: 'no-id' };
    let row = ring.find((item) => item.id === needle) || null;
    if (!row) {
      // id 形状 `uip-<毫秒>-<序号>`：先按时间戳猜落在哪个日期文件，猜不到（跨日/时钟跳）再全扫。
      const stamp = Number(String(needle).split('-')[1]);
      const guess = Number.isFinite(stamp) ? dayFile(localDay(stamp)) : '';
      const candidates = guess && fs.existsSync(guess)
        ? [guess]
        : (dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('turns-') && f.endsWith('.jsonl')).map((f) => path.join(dir, f)) : []);
      for (const file of candidates) {
        try {
          for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line.includes(needle)) continue;
            try {
              const parsed = JSON.parse(line);
              if (parsed?.id === needle) { row = parsed; break; }
            } catch { /* 单行坏了不影响别的 */ }
          }
        } catch { /* 读不到就当作没有 */ }
        if (row) break;
      }
    }
    if (!row) return { ok: false, reason: 'not-found', id: needle };
    const msgs = messagesFromRow(row);
    // ★ P-1：整块在服务端由**同一份** messages 拼出来（UI 只印 `block`，不再自己拼一份）。
    return {
      ok: true, id: row.id, at: row.at, chatKey: row.chatKey,
      sessionId: String(row.sessionId ?? ''), roundId: String(row.roundId ?? ''),
      summary: summarize(row), messages: msgs, block: formatTurnBlock(msgs),
      requestCapture: String(row.requestCapture ?? 'pre-send-only'),
      request: row.request ?? null,
      toolSchemas: Array.isArray(row.toolSchemas) ? row.toolSchemas : [],
      response: row.response || null
    };
  }

  function clear() {
    ring.length = 0;
    pendingBuilds = new Map();
    dropped = 0;
    let removed = 0;
    let failed = 0;
    if (dir && fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith('turns-') || !f.endsWith('.jsonl')) continue;
        try { fs.rmSync(path.join(dir, f)); removed += 1; } catch { failed += 1; }
      }
    }
    return { ok: failed === 0, removed, failed, dir: dir || '' };
  }

  /**
   * 把装配层命名空间里的模型/提示词出口换成"抄一份再转发"的壳。
   * ★ 必须**原地换槽位**（`modulesObj.llm = 壳`），不能返回新对象：M15 runtime 与 `setPlatform()`
   *   持有的都是 modulesObj 这一个引用，换了对象就等于"抄了一个没人用的运行时"。
   *   壳本身用展开新建 —— ESM 命名空间对象是不可写的，直接改属性在严格模式里必抛。
   * 原出口缺失时原样返回（不许因为观测把装配搞红）。
   */
  function applyTo(modulesObj) {
    if (!modulesObj) return modulesObj;
    const llm = modulesObj.llm;
    if (llm && typeof llm.chatCompletionWithRetry === 'function') {
      const original = llm.chatCompletionWithRetry.bind(llm);
      modulesObj.llm = {
        ...llm,
        chatCompletionWithRetry: async (args = {}) => {
          const chatKey = String(args?.affinityKey ?? args?.chatKey ?? '');
          // ★ P-2：运行身份由**编排层**盖在同一次调用的入参上（合约见 `.tmp-dispatch/r-p2-预览关联.md` §三：
          //   持有 `run` 的那一层在 `composeReply({ modules })` 处包一层，把 `run.sessionId`/`run.roundId` 并进 args）。
          //   拿不到就是空串 ⇒ 这一行"没挂上会话"，面板如实这么说；
          //   **不许**用 chatKey 或时间窗去猜它属于哪一次运行（那正是"一个会话看到多次会话的预览"的病根）。
          const sessionId = String(args?.sessionId ?? '');
          const roundId = String(args?.roundId ?? '');
          const build = takeBuild(chatKey, sessionId);
          const row = {
            at: Date.now(),
            chatKey,
            sessionId,
            roundId,
            messages: snapshotMessages(args?.messages),
            tools: (Array.isArray(args?.tools) ? args.tools : []).map((t) => String(t?.function?.name ?? t?.name ?? '')),
            toolSchemas: [],
            requestCapture: 'pre-send-only',
            request: null,
            buildSections: build?.buildSections || [],
            droppedSections: build?.droppedSections || [],
            persona: build?.persona || null,
            styleHintChars: Number(build?.styleHintChars || 0),
            response: null,
            error: '',
          };
          try {
            let priorOnFinalBody;
            let priorCallbackReadError = null;
            try { priorOnFinalBody = args?.onFinalBody; }
            catch (error) { priorCallbackReadError = error; }
            const onFinalBody = (body, facts = {}) => {
              if (!body || typeof body !== 'object') return;
              row.requestCapture = 'final-send';
              row.messages = snapshotMessages(body.messages);
              row.toolSchemas = Array.isArray(body.tools) ? body.tools : [];
              row.tools = row.toolSchemas.map((tool) => String(tool?.function?.name ?? tool?.name ?? '')).filter(Boolean);
              row.request = {
                model: String(body.model ?? ''),
                stream: body.stream ?? null,
                toolChoice: body.tool_choice ?? null,
                wireChars: Number(facts.wireChars) || 0,
                cacheLine: String(facts.cacheLine ?? '')
              };
              if (typeof priorOnFinalBody === 'function') {
                try { priorOnFinalBody(body, facts); }
                catch (error) {
                  // Keep request behavior fail-open, but make observer failures visible without logging request data.
                  const errorType = /^[A-Za-z0-9_.-]{1,40}$/.test(String(error?.name ?? '')) ? String(error.name) : 'Error';
                  console.warn(`[ui-preview] onFinalBody forwarding failed (${errorType})`);
                }
              }
            };
            if (priorCallbackReadError) {
              const errorType = /^[A-Za-z0-9_.-]{1,40}$/.test(String(priorCallbackReadError?.name ?? ''))
                ? String(priorCallbackReadError.name) : 'Error';
              console.warn(`[ui-preview] onFinalBody callback read failed (${errorType})`);
            }
            // The model adapter calls this at the final fetch boundary, after request plugins,
            // retry transforms and provider compatibility fallbacks. Keep the complete local
            // snapshot, but retain the helper's recursive secret-field redaction.
            onFinalBody.fullTextSnapshot = true;
            // Keep the adapter's existing args identity (some callers/tests retain it), while
            // installing the observer only for this in-flight request and restoring it after.
            // If an unusual caller freezes its args, lose the observation but never the request.
            let injected = false;
            if (args && typeof args === 'object') {
              try {
                args.onFinalBody = onFinalBody;
                injected = args.onFinalBody === onFinalBody;
              } catch { /* immutable args: keep the adapter call fail-open */ }
            }
            let response;
            try {
              response = await original(args);
            } finally {
              if (injected) {
                try {
                  if (priorOnFinalBody === undefined) delete args.onFinalBody;
                  else args.onFinalBody = priorOnFinalBody;
                } catch { /* restoring an observer must not change a completed model call */ }
              }
            }
            const message = response?.choices?.[0]?.message ?? response?.message ?? null;
            row.response = {
              finishReason: String(response?.choices?.[0]?.finish_reason ?? response?.finishReason ?? ''),
              textChars: String(message?.content ?? '').length,
              textPreview: clipText(String(message?.content ?? ''), RESPONSE_PREVIEW_CAP),
              toolCallNames: (Array.isArray(message?.tool_calls) ? message.tool_calls : []).map((c) => String(c?.function?.name ?? '')),
              model: String(response?.model ?? ''),
              usage: response?.usage ? {
                promptTokens: Number(response.usage.prompt_tokens ?? response.usage.promptTokens) || 0,
                completionTokens: Number(response.usage.completion_tokens ?? response.usage.completionTokens) || 0,
              } : null,
            };
            record(row);
            return response;
          } catch (error) {
            row.error = String(error?.message ?? error).slice(0, 400);
            try { record(row); } catch { /* 抄失败不掩盖原错误 */ }
            throw error;
          }
        },
      };
    }
    const prompt = modulesObj.prompt;
    if (prompt && typeof prompt.buildMessages === 'function' && prompt.__uiPreviewTee !== true) {
      modulesObj.prompt = {
        ...prompt,
        __uiPreviewTee: true,
        buildMessages: (params = {}) => recordBuild(params, prompt.buildMessages(params)),
      };
    }
    return modulesObj;
  }

  return { applyTo, recordBuild, list, read, clear, dir, backfill: backfillFromDisk, backfilled: backfill };
}
