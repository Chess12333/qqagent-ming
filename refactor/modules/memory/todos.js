// 待办状态机（新树 M6 memory 的可选子模块）——**逐字搬**自 `src/conversation-memory/pending.js`（176 行）。
//
// ── 与旧实现唯一的差别（其余逐字照搬，见回执 `.tmp-dispatch/r-tools-memory2.md` 的对照表）──
//   ① `DATA_DIR`（模块级 import）→ **构造时注入的 dataDir**（工厂 `createTodos({dataDir, log})`）。
//      理由与 `modules/memory/data-dir.js` 同源：core/config-store 的懒加载会把生产 `data/` 喂回来，
//      而"库不许自己找数据目录"是新树铁律。
//   ② `read()` 的 `catch → []` 收紧 + 写前自检（照 `modules/media/memes.js:41-59` 的 `assertWritable`）：
//      旧实现**只有** `catch { return [] }`，于是"文件在但读不动"会被上层当空库回写 ⇒ 整库待办被覆盖。
//      现在：**只有 ENOENT（文件不存在）算空库**；读不动就一律拒绝写并把原因报出去。
//   ③ 文件名（`pending-todos.json`）、`{version, todos}` 外壳、每条 todo 的**字段名与状态机一字未改**
//      ⇒ 旧实例写过的 `data/pending-todos.json` 能被直接读走，反过来也成立。
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/util/index.js';

const MAX = 40;

/**
 * @param {{dataDir?:string, log?:Function}} [opts]
 *   `dataDir` 必填或走 `QQ_AGENT_DATA_DIR`（与 memory/data-dir.js 的规则一致）；**没有它直接抛**，不猜。
 * @returns {{saveTodo:Function, completeTodo:Function, markTodoResultUnknown:Function,
 *            activeTodos:Function, renderTodosForPrompt:Function, file:Function}}
 */
export function createTodos({ dataDir = '', log = null } = {}) {
  const dir = String(dataDir || process.env.QQ_AGENT_DATA_DIR || '');
  if (!dir) {
    throw new Error('createTodos: 需要 dataDir（不许用没被授权的目录写文件，也不许自己找生产 data/）');
  }
  const FILE = path.join(dir, 'pending-todos.json');

  /** 上次读取失败的原因（null = 正常 / 文件不存在）。防「读坏 → 当空 → 覆盖」，见 read()/assertWritable()。 */
  let loadFault = null;

  function read() {
    try {
      let t = fs.readFileSync(FILE, 'utf8');
      if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
      const j = JSON.parse(t);
      if (!Array.isArray(j?.todos)) throw new Error('pending-todos.json 里没有 todos 数组');
      loadFault = null;
      return j.todos;
    } catch (error) {
      // ★ 只有"文件不存在"才算空库；"在但读不动"必须留住故障标记（照 memes.js:29-33）。
      if (error?.code !== 'ENOENT') loadFault = String(error?.message ?? error);
      return [];
    }
  }

  /** 写之前先确认"现有文件可读"，读不动就一律拒绝写 —— 照 memes.js:41-59 */
  function assertWritable() {
    let text;
    try {
      text = fs.readFileSync(FILE, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') { loadFault = null; return; }   // 真·空库，允许创建
      loadFault = String(error?.message ?? error);
      throw new Error(`拒绝写 ${path.basename(FILE)}：读不动（${loadFault}）`);
    }
    try {
      const parsed = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
      if (!Array.isArray(parsed?.todos)) throw new Error('pending-todos.json 里没有 todos 数组');
      loadFault = null;
    } catch (error) {
      loadFault = String(error?.message ?? error);
      throw new Error(`拒绝写 ${path.basename(FILE)}：现有文件读不动（${loadFault}）。`
        + ' 不许把"读不到"当成"空库"覆盖用户数据 —— 先修文件或备份，再重试。');
    }
  }

  function write(todos) {
    // 顺手清掉过期（旧 pending.js:23-30 逐字）
    const now = Date.now();
    const alive = todos
      // 已完成/结果不明的保留 24 小时（复盘要看），之后清掉 —— 否则它们会一直占着
      // slice(-MAX) 的名额，把真正在办的待办挤出去。
      .filter((t) => !['completed', 'result_unknown'].includes(String(t.status || ''))
        || now - (Number(t.completedAt || t.updatedAt) || 0) < 86400000)
      .filter((t) => !t.expiresAt || Number(t.expiresAt) > now)
      .slice(-MAX);
    assertWritable();                      // ★ 新增：唯一防住「读坏 → 当空 → 覆盖」的闸
    writeJsonAtomic(FILE, { version: 1, todos: alive }, { indent: 1 });
    if (typeof log === 'function') log('info', 'todos-saved', { file: FILE, kept: alive.length });
    return alive;
  }

  /**
   * 保存待办。expireInMinutes 由模型填（默认 120，上限 7 天）。（旧 pending.js:38-91 逐字）
   */
  function saveTodo({ chatKey, text, expireInMinutes = 120, userId = '', note = '' }) {
    const body = String(text || '').trim().slice(0, 100);
    if (!body) return { ok: false, error: '待办内容不能为空' };
    let mins = Number(expireInMinutes);
    if (!Number.isFinite(mins) || mins <= 0) mins = 120;
    mins = Math.min(7 * 24 * 60, Math.round(mins));
    const now = Date.now();
    const todos = read();
    const uid = String(userId || '').replace(/^-?\d{5,15}$/, (m) => String(Math.abs(Number(m))));
    const fixedUid = /^\d{1,15}$/.test(uid) ? uid : '';
    // 同会话同文去重，刷新过期时间
    const key = `${chatKey}|${body.toLowerCase()}`;
    const existing = todos.find((t) => `${t.chatKey}|${String(t.text).toLowerCase()}` === key);
    if (existing) {
      existing.expiresAt = now + mins * 60000;
      existing.updatedAt = now;
      existing.note = String(note || '').slice(0, 80);
      if (fixedUid) existing.userId = fixedUid;
      // 同文但上一轮已经办完/结果不明 → 这是一件**新事**，必须回到 pending，
      // 否则它会因为 status !== 'pending' 被 activeTodos 过滤掉，等于"记了但永远不提醒"。
      if (existing.status && existing.status !== 'pending') {
        existing.status = 'pending';
        existing.completedAt = null;
        existing.evidence = '';
      }
      write(todos);
      return { ok: true, todo: existing, deduped: true };
    }
    const todo = {
      id: `t${now.toString(36)}`,
      chatKey: String(chatKey || ''),
      userId: fixedUid,
      text: body,
      note: String(note || '').slice(0, 80),
      createdAt: now,
      updatedAt: now,
      expiresAt: now + mins * 60000,
      expireInMinutes: mins,
      // ── 2026-09-23 新增：状态机 ──
      // 依据那份《Jev 与记忆系统》方案 §9：待办要有独立状态机，
      // 而且**"到点"不等于"做完"**（expired）、**"调用发出去了但结果不明"也不等于完成**
      //（result_unknown，要先查状态、不能直接重试）。
      // 目前只有模型主动调 complete_todo 才会变 completed —— 这是"完成证据"。
      status: 'pending',
      completedAt: null,
      evidence: ''
    };
    todos.push(todo);
    write(todos);
    return { ok: true, todo };
  }

  /** 读坏了就不许静默当"没找到"（否则"记了但永远不提醒"查不出来）。只在本轮真的读坏时发火。 */
  function assertHealthyForLookup() {
    if (loadFault) {
      throw new Error(`读 ${path.basename(FILE)} 失败（${loadFault}）：`
        + ' 这次不判"没找到"—— 坏文件会让所有待办凭空消失。先修文件或备份，再重试。');
    }
  }

  /** 标记完成。evidence = 凭什么算完成（例如"提醒已发出"）。（旧 pending.js:93-109 逐字） */
  function completeTodo({ chatKey, text, evidence = '' }) {
    const key = String(text || '').trim().toLowerCase();
    if (!key) return false;
    const todos = read();
    assertHealthyForLookup();          // ★ 新增：读坏 ⇒ 显式失败，不静默说"没找到"
    const now = Date.now();
    let hit = false;
    const next = todos.map((t) => {
      if (chatKey && t.chatKey && t.chatKey !== chatKey) return t;
      if (String(t.text || '').toLowerCase() !== key) return t;
      hit = true;
      return { ...t, status: 'completed', completedAt: now, updatedAt: now, evidence: String(evidence || '').slice(0, 80) };
    });
    if (!hit) return false;
    write(next);
    return true;
  }

  /**
   * 调用发出去了、但结果不明 → 标 result_unknown。
   * 语义：**不能**当成完成，也不能直接重发（可能已经生效了）；要先查状态。
   * 和 completed 分开，是为了让"虚假完成"和"重复动作"都能被复盘出来。
   * （旧 pending.js:111-131 逐字）
   */
  function markTodoResultUnknown({ chatKey, text, note = '' }) {
    const key = String(text || '').trim().toLowerCase();
    if (!key) return false;
    const todos = read();
    assertHealthyForLookup();          // ★ 同上
    const now = Date.now();
    let hit = false;
    const next = todos.map((t) => {
      if (chatKey && t.chatKey && t.chatKey !== chatKey) return t;
      if (String(t.text || '').toLowerCase() !== key) return t;
      hit = true;
      return { ...t, status: 'result_unknown', updatedAt: now, evidence: String(note || '').slice(0, 80) };
    });
    if (!hit) return false;
    write(next);
    return true;
  }

  /**
   * 未过期的待办。
   * @param {object} o
   * @param {string|null} [o.chatKey] 会话过滤
   * @param {string[]} [o.personIds] 本轮触发里出现的 QQ 号——绑人的待办优先
   * （旧 pending.js:133-166 逐字）
   */
  function activeTodos({ chatKey = null, limit = 4, personIds = [] } = {}) {
    const now = Date.now();
    const people = new Set((personIds || []).map(String).filter(Boolean));
    return read()
      .filter((t) => {
        // 只有 pending 才注入：completed 是"办完了"，result_unknown 是"结果不明、别重发"
        // （后者会由执行层另行处理，不该继续当"未办待办"喂给模型）
        if (t.status && t.status !== 'pending') return false;
        if (t.expiresAt && t.expiresAt <= now) return false;
        if (chatKey && t.chatKey && t.chatKey !== chatKey) return false;
        // 绑了人的待办：只有该人出现在本轮才注入
        if (t.userId && people.size && !people.has(String(t.userId))) return false;
        if (t.userId && people.size === 0) return false;
        return true;
      })
      .sort((a, b) => {
        const ap = a.userId && people.has(String(a.userId)) ? 0 : 1;
        const bp = b.userId && people.has(String(b.userId)) ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return (a.expiresAt || 0) - (b.expiresAt || 0);
      })
      .slice(0, Math.max(1, limit))
      .map((t) => ({
        text: t.text,
        userId: t.userId || '',
        leftMin: Math.max(0, Math.round(((t.expiresAt || 0) - now) / 60000)),
        note: t.note || ''
      }));
  }

  /** 渲染成提示词片段（无待办时返回空串）。（旧 pending.js:168-176 逐字） */
  function renderTodosForPrompt(chatKey, { max = 3, personIds = [] } = {}) {
    const list = activeTodos({ chatKey, limit: max, personIds });
    if (!list.length) return '';
    const lines = list.map((t) => {
      const who = t.userId ? `@${t.userId}` : '';
      return `- ${who}${t.text}${t.leftMin <= 60 ? `（约${t.leftMin}分后忘）` : ''}`;
    });
    return `【未完待办·会自动过期】\n${lines.join('\n')}\n（记得就去办；到点没办完也会忘，别一直挂着）`;
  }

  return {
    saveTodo,
    completeTodo,
    markTodoResultUnknown,
    activeTodos,
    renderTodosForPrompt,
    /** 便于自测/排障断言"没在碰生产 data/"（旧实现没有这个出口）。 */
    file: () => FILE,
    loadFault: () => loadFault
  };
}