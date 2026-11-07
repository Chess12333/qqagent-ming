// ★ N45（2026-10-10 · qwen2）枚举闸门 —— 让"白名单漏码"变成**自测会红**，而不是靠人扫。
//
// 【要治的病】白名单枚举漏了写入点真会产出的值 ⇒ `safeEnum` 把它悄悄换成 fallback。
//   信息没了、不报错、自测照样绿。同一个病在这仓复发过三次：
//     2026-10-05 `tier_restricted` → 'other'（用户报"开了仅@的群还一直说"，查不到真因）
//     2026-10-09 00:3x  plan/compose 的 19 个码 → 'other'（"私聊为什么不回"根本查不出来）
//     2026-10-09 N36    plan 又 5 个码 → 'other'（含 `FREE_INTERJECTION`，而它**同一行**的
//                       兄弟 `FREE_TOPIC_SWITCH` 却在表里 ⇒ 一行代码两个分支，一个能查一个被吃掉）
//
// 【为什么不是"扫全仓字段名"】N45 实测过：`status` 这个字段名在语料里有 **248 处**、
//   `source` 158 处、`action` 63 处、`outcome` 62 处，分属**完全不同的词汇表**
//   （`jev/anchors.js` 的 `'not-ready'`/`'stale'` 是召回状态，`cache-keepalive.js` 的
//   `'stop'`/`'keep'` 是保温动作，都跟 STAGE_STATUSES/ACTIONS 无关）。
//   ⇒ 按字段名扫会产出几百条误报，闸门第一天就会被豁免表淹掉，等于没有。
//
// 【所以这里的口径是**按写入点锚定**，不是按字段名扫】
//   每个锚点都声明"哪个流的哪张表，由哪个文件里哪个结构的值喂进来"，只在那个结构里取值：
//     · `objectFields` —— 台账调用的那个对象字面量（`ledger?.('decision', {…})`），
//                         shorthand 键回溯到**同函数内**的 `const/let 赋值`
//     · `returnObject` / `returnLiterals` —— 产出这些字段的函数的 return
//     · `callArg`     —— 工厂函数的固定实参位（`makePlan(action, code, …)` 的第 0/1 位）
//   取值时只认**结果位**的字面量：比较运算的操作数（`x === 'error'`）、三元的条件
//   （`'a' ? …`）、`includes('b')` 的入参一律不算 —— 这条规则是 N45 逐个写入点验出来的，
//   见 `isOperandPosition`。另外只认 token 形状的值（`^[0-9A-Za-z_][\w.-]*$`，长度≥2），
//   把 `':'`、`''`、中文消息串这些噪音挡在外面。
//
// 【锚不到的表怎么办】⇒ `CENSUS_ONLY`：**显式登记 + 写明理由**（票面要求"豁免要留痕"）。
//   它们不是没人管：`sanitize.js` 的 N45 记账段会在运行时数出每一次改写，
//   `stats().enumCoercions.total > 0` 就是"有码被吃掉了"，`rows` 直接给出字段/原值/被换成什么。
//   ⇒ 静态锚点管"提交前就能红"，运行时记账管"锚不到的地方也不再静默"。两条腿。
//
// 【还有一类留痕：`NOT_A_PRODUCER`】登记**看着像写入点、其实到不了这张表**的结构。
//   这是 N36 踩过的坑：静态差集扫出 16 个"漏码"，追代码后只有 5 个真到得了台账，
//   另 11 个是 early-return / 走别的列 / 被上游映射收敛掉了。**把它们补进白名单等于给死码
//   发通行证**，比漏码更难查。所以下面每一处都写清"为什么不是"，别让下一个人重新推一遍。

import fs from 'node:fs';
import path from 'node:path';
import { LEDGER_SCHEMAS, SPAN_SCHEMA, EVENT_SCHEMA } from './ledgers.js';
import { TRACE_ENUMS } from './trace.js';
import { LEVELS } from './logs.js';

/** 语料：真会往观测写东西的地方。**排除 core/observability 自己** —— 那里是表的定义处，
 *  定义里的字面量（`fallback: 'ambient'`、注释里举的码）不是写入点，扫进来就是自证清白。 */
export const CORPUS_DIRS = ['refactor/modules', 'refactor/apps/server'];
const EXCLUDE_FILE = /selftest|key-ledger|enum-gate/;

/* ───────────────────────── 白名单列的自动收集（不许手抄，抄就会漂） ───────────────────────── */

function columnsOfSchema(prefix, schema) {
  const out = [];
  for (const [field, spec] of Object.entries(schema || {})) {
    if (spec?.t !== 'enum' && spec?.t !== 'enum?') continue;
    out.push({
      id: `${prefix}.${field}`,
      allowed: spec.allowed,
      fallback: spec.t === 'enum'
        ? (spec.fallback ?? 'other')
        : (spec.invalid === undefined ? 'other' : spec.invalid),
      optional: spec.t === 'enum?'
    });
  }
  return out;
}

/** 全部受闸门管的枚举列。**从 schema 现算**，新增一列不登记覆盖方式就会红（见 uncoveredColumns）。 */
export function collectColumns() {
  const cols = [];
  for (const [name, schema] of Object.entries(LEDGER_SCHEMAS)) cols.push(...columnsOfSchema(name, schema));
  cols.push(...columnsOfSchema('spans', SPAN_SCHEMA));
  cols.push(...columnsOfSchema('events', EVENT_SCHEMA));
  for (const [id, spec] of Object.entries(TRACE_ENUMS)) {
    cols.push({ id, allowed: spec.allowed, fallback: spec.fallback ?? '(dropped)', optional: spec.fallback == null });
  }
  cols.push({ id: 'log.level', allowed: new Set(Object.keys(LEVELS)), fallback: 'info', optional: false });
  return cols;
}

/* ───────────────────────── 源码读取：去注释但**保留行号与偏移** ───────────────────────── */

/** 把注释字符换成空格（换行留着）⇒ 位置/行号与原文件一致，且注释里举的码不会被当成写入点。 */
export function stripComments(text) {
  let out = '';
  let q = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (q) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 1; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { q = c; out += c; continue; }
    if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') { out += ' '; i += 1; } out += '\n'; continue; }
    if (c === '/' && next === '*') {
      out += '  '; i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { out += text[i] === '\n' ? '\n' : ' '; i += 1; }
      out += '  '; i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

/** 从 startIdx 起读一个"值表达式"：到深度 0 的 `,` `;` 或收口括号为止（上限 600 字）。 */
function readExpr(text, startIdx) {
  let depth = 0;
  let q = null;
  for (let i = startIdx; i < text.length && i < startIdx + 600; i += 1) {
    const c = text[i];
    if (q) { if (c === '\\') { i += 1; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth += 1; continue; }
    if (c === ')' || c === ']' || c === '}') { if (depth === 0) return { text: text.slice(startIdx, i), end: i }; depth -= 1; continue; }
    if (depth === 0 && (c === ',' || c === ';')) return { text: text.slice(startIdx, i), end: i };
  }
  return { text: text.slice(startIdx, startIdx + 600), end: startIdx + 600 };
}

/** 找出 text 里的全部字符串字面量，带前后文（用来判"结果位 vs 操作数位"）与绝对偏移。 */
function scanLiterals(text, base = 0) {
  const out = [];
  let q = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === '\\') { i += 1; continue; }
      if (c === q) {
        out.push({
          value: text.slice(start + 1, i),
          abs: base + start,
          before: text.slice(Math.max(0, start - 16), start),
          after: text.slice(i + 1, i + 16)
        });
        q = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { q = c; start = i; }
  }
  return out;
}

const TOKEN_SHAPE = /^[0-9A-Za-z_][0-9A-Za-z0-9_.-]*$/;
/** 只认"像个枚举码"的字面量：token 形状、长度≥2、不是纯数字。挡掉 `':'`、`''`、中文消息串。 */
export function isTokenLiteral(value) {
  return value.length >= 2 && value.length <= 64 && TOKEN_SHAPE.test(value) && !/^\d+$/.test(value);
}

const CMP_BEFORE = /(?:===|!==|==|!=|<=|>=|<|>)\s*$/;
const CALL_BEFORE = /\.(?:includes|has|startsWith|endsWith|indexOf|test)\s*\(\s*$/;
/**
 * 操作数位判定（★ 这条规则是逐个写入点验出来的，不是拍的）：
 *   `outcome === 'error'`            → 'error' 是**被比较的值**，不是要落盘的码 ⇒ 排除
 *   `x === 'schedule' ? 'A' : 'B'`   → 'schedule' 后面紧跟 `?` ⇒ 排除；'A'/'B' 保留
 *   `['sent','partial'].includes(o)` → 入参 ⇒ 排除
 * 少了这条，`modelStageLedgerFields` 会一次误报 8 个 composeOutcome 值。
 */
export function isOperandPosition(lit) {
  if (CMP_BEFORE.test(lit.before)) return true;
  if (CALL_BEFORE.test(lit.before)) return true;
  if (/^\s*\?/.test(lit.after)) return true;
  return false;
}

/** 结果位的 token 字面量。 */
function candidates(text, base = 0) {
  return scanLiterals(text, base)
    .filter((lit) => isTokenLiteral(lit.value) && !isOperandPosition(lit))
    .map((lit) => ({ value: lit.value, abs: lit.abs }));
}

/* ───────────────────────── 结构定位 ───────────────────────── */

/** 按大括号配平取一段（从 idx 起第一个 `{` 到它的配对 `}`）。 */
function braceBlock(text, idx) {
  const open = text.indexOf('{', idx);
  if (open < 0) return null;
  let depth = 0;
  let q = null;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (q) { if (c === '\\') { i += 1; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return { start: open, end: i + 1, text: text.slice(open, i + 1) }; }
  }
  return null;
}

/** 取一个实参列表（从 idx 起第一个 `(` 到配对 `)`），按深度 0 的逗号切。 */
function callArgs(text, idx) {
  const open = text.indexOf('(', idx);
  if (open < 0) return [];
  const args = [];
  let depth = 0;
  let q = null;
  let cur = '';
  let curAbs = open + 1;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (q) { cur += c; if (c === '\\') { cur += text[i + 1] ?? ''; i += 1; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === '(') { depth += 1; if (depth === 1) { cur = ''; curAbs = i + 1; continue; } }
    if (c === ')') { depth -= 1; if (depth === 0) { args.push({ text: cur, abs: curAbs }); return args; } }
    if (c === ',' && depth === 1) { args.push({ text: cur, abs: curAbs }); cur = ''; curAbs = i + 1; continue; }
    if (depth >= 1) cur += c;
  }
  return args;
}

/** 所有 `function NAME(` / `NAME(` 方法定义的函数体范围（用来把赋值回溯限制在同一个函数里）。 */
function functionBodies(text) {
  const out = [];
  const re = /(?:^|[\s;}])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const block = braceBlock(text, m.index + m[0].length - 1);
    if (block) out.push({ name: m[1], ...block });
  }
  return out;
}

/** 包含 idx 的最内层函数体（没有就返回整篇）。 */
function scopeOf(text, idx) {
  let best = { start: 0, end: text.length, name: '(file)' };
  for (const fn of functionBodies(text)) {
    if (fn.start <= idx && idx <= fn.end && (fn.end - fn.start) < (best.end - best.start)) best = fn;
  }
  return best;
}

/** 在 scope 内找 `NAME = <expr>` / `const NAME = <expr>` 的赋值，收结果位字面量。 */
function assignedLiterals(text, scope, name) {
  const out = [];
  const re = new RegExp(`(?:^|[\\s;{,(])(?:const\\s+|let\\s+|var\\s+)?${name}\\s*=(?!=)\\s*`, 'g');
  re.lastIndex = scope.start;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index < scope.start || m.index > scope.end) break;
    const at = m.index + m[0].length;
    const expr = readExpr(text, at);
    for (const cand of candidates(expr.text, expr.abs ?? at)) out.push({ ...cand, via: `${name} =` });
    re.lastIndex = expr.end;
  }
  return out;
}

/** 拆一个对象字面量的顶层键：`k: expr` 与 shorthand `k`（含 `...spread` 记录在案）。 */
function objectEntries(blockText, blockStart) {
  const body = blockText.slice(1, -1);
  const entries = [];
  let depth = 0;
  let q = null;
  let cur = '';
  let curAbs = blockStart + 1;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (q) { cur += c; if (c === '\\') { cur += body[i + 1] ?? ''; i += 1; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    if (c === ')' || c === ']' || c === '}') depth -= 1;
    if (c === ',' && depth === 0) { entries.push({ text: cur, abs: curAbs }); cur = ''; curAbs = blockStart + 1 + i + 1; continue; }
    cur += c;
  }
  if (cur.trim()) entries.push({ text: cur, abs: curAbs });
  const fields = [];
  const spreads = [];
  for (const entry of entries) {
    const trimmed = entry.text.trim();
    if (!trimmed) continue;
    const spread = trimmed.match(/^\.\.\.\s*([A-Za-z_$][\w$.?]*)/);
    if (spread) { spreads.push(spread[1]); continue; }
    const kv = trimmed.match(/^([A-Za-z_$][\w$]*)\s*:\s*/);
    if (kv) {
      const valueStart = entry.abs + entry.text.indexOf(kv[0]) + kv[0].length;
      fields.push({ name: kv[1], expr: trimmed.slice(kv[0].length), abs: valueStart });
      continue;
    }
    const short = trimmed.match(/^([A-Za-z_$][\w$]*)$/);
    if (short) fields.push({ name: short[1], expr: null, abs: entry.abs });
  }
  return { fields, spreads };
}

/* ───────────────────────── 锚点表（★ 每条都写明"为什么这个结构就是写入点"） ───────────────────────── */

const ORCH = 'refactor/modules/orchestrator/index.js';
const PLAN = 'refactor/modules/plan/index.js';

export const ANCHORS = [
  {
    id: 'events/requestPrefixSection', stream: 'events',
    file: 'refactor/modules/orchestrator/request-prefix.js',
    column: 'events.prefixChangedSection', fn: 'sectionOf', returnLiterals: true,
    why: 'DS 最终请求的固定分段标签，不采集提示正文或标题原文。'
  },
  {
    id: 'events/requestPrefixBoundary', stream: 'events',
    file: 'refactor/modules/orchestrator/request-prefix.js',
    column: 'events.prefixChangedSection', fn: 'changedSectionOf', returnLiterals: true,
    why: '首轮、相同前缀、截断上限和消息末端等固定原因码。'
  },
  {
    id: 'decision/planDecisionLedger',
    stream: 'decision',
    file: ORCH,
    anchor: 'run.planDecisionLedger = {',
    resolveShorthand: true,
    why: '主决策行的**唯一**装配点（orchestrator/index.js:1914）。lane/source/decision/reasonCode 四个键'
      + '都是 shorthand ⇒ 回溯到同函数内的 `const`（:1908-1913），那里才是真取值处。'
  },
  {
    id: 'decision/ledgerCalls',
    stream: 'decision',
    file: ORCH,
    anchor: "ledger?.('decision'",
    all: true,
    resolveShorthand: true,
    why: '三道 decision 台账写入（:820 主链、:2389 白名单入站闸、:2408 档位闸）。'
      + '后两道是直接字面量写的（lane:\'ambient\' / source:\'allow_list_policy\' / decision:\'skip\'），'
      + ':820 是 `{...base, ...modelStageLedgerFields(), reasonCode}` ⇒ spread 由下面两条锚点各自负责。'
  },
  {
    id: 'decision/modelStageLedgerFields',
    stream: 'decision',
    file: ORCH,
    fn: 'modelStageLedgerFields',
    returnObject: true,
    resolveShorthand: true,
    why: ':820 那个 spread 的源头。返回 `{modelOutcome, policyOutcome, blockReason}` 三个 shorthand，'
      + '真值在函数体的 `let`/`=` 赋值里（:785-809）。**这条锚点最依赖 isOperandPosition**：'
      + '函数里有 8 个 composeOutcome 字面量（\'error\'/\'silent\'/\'drafted\'/…）全在比较位，必须排除。'
  },
  {
    id: 'decision/decisionComposeReasonCode',
    stream: 'decision',
    file: ORCH,
    column: 'decision.reasonCode',
    fn: 'decisionComposeReasonCode',
    returnLiterals: true,
    why: '主链 reasonCode 的**收口函数**（:756-775）：compose 有 outcome 时由它决定最终码，'
      + '没有时原样透传 plan 的码。只取 `return` 之后的字面量 —— 函数里的 \'sent\'/\'partial\'/'
      + '\'delivery_unknown\'/\'silent\'/\'drafted\'/\'incomplete\'/\'empty\' 都是**被比较的 composeOutcome**，'
      + '不是 reasonCode（N36 就是把这类值误当成漏码，追代码才发现到不了台账）。'
  },
  {
    id: 'decision/planMakePlanCode',
    stream: 'decision',
    file: PLAN,
    column: 'decision.reasonCode',
    call: 'makePlan',
    argIndex: 1,
    resolveAssign: true,
    why: 'plan 侧 reasonCode 的**唯一**产出口：`makePlan(action, code, message, …)`（plan/index.js:183）'
      + '→ `reason: reason(code, message)`（:19/:200）→ orchestrator:1910 `split(\':\')[0]` 取前缀进台账。'
      + '第 1 位实参就是码。`resolveAssign` 是**必须的**：:229 传的是标识符 `code`，'
      + '真值在 :226 的三元里（PROACTIVE_SCHEDULE/RANDOM/OPPORTUNITY）—— N36 漏的就是这三个，'
      + '因为它们不在任何 `makePlan(\'…\', \'CODE\')` 字面里，只 grep 字面量一定漏。'
  },
  {
    id: 'send/ledgerCall',
    stream: 'send',
    file: ORCH,
    anchor: "ledger?.('send'",
    resolveShorthand: true,
    why: 'send 台账的唯一写入点（:1545-1548）。`action: \'send\'` 是字面量；`planAction: action` 是'
      + ' shorthand，回溯到 `const action = String(plan.action ?? \'\')`（:1907）⇒ 无字面量，'
      + '真值域由下一条锚点（makePlan 第 0 位）给出。'
  },
  {
    id: 'send/planMakePlanAction',
    stream: 'send',
    file: PLAN,
    column: 'send.planAction',
    call: 'makePlan',
    argIndex: 0,
    why: 'planAction 的值就是 ActionPlan 的 action，产出口同样是 makePlan 的第 0 位实参'
      + '（全仓 15 处调用，实测只有 reply/continue/skip 三种）。'
  }
];

/**
 * 锚不到、改由运行时记账（`sanitize.js` 的 N45 段 + `stats().enumCoercions`）覆盖的列。
 * ★ 每条都必须写清**为什么锚不到**，不许空着 —— 这张表就是票面要的"豁免留痕"。
 */
export const CENSUS_ONLY = {
  'decision.authority': '值来自 `beginTurn({authority})` 的调用方，跨模块透传（orchestrator:1916 `trace.authority ?? null`），'
    + '没有单一产出点可锚；且它是 `enum?`（缺省 null，不改写）。',
  'jev.status': '★ JEV 行由 `modules/jev` 产出、经 `apps/server/assembly.js:840` 转写；写入点不在本域。'
    + '当前缺失或非法时落 null；保留登记，等生产字段接线后继续由运行时记账覆盖。',
  'jev.decision': '同上；JEV 当前没有稳定的 decision 写入点，缺失或非法时落 null，不再推断成 error。',
  'jev.requestedChannel': 'JEV 当前没有稳定的 requestedChannel 写入点，缺失或非法时落 null，不再推断成 local。',
  'jev.channel': '同上；JEV 当前没有稳定的 channel 写入点，缺失或非法时落 null，不再推断成 local。',
  'jev.errorCode': '同 jev.status（JEV 冻结）；`enum?`，缺省 null。',
  'jev.memoryMode': '`enum?`，语义为 JEV 选择的记忆模式（`none/recent/long_term/mixed`）；字段在 `refactor/core/observability/ledgers.js:180` 登记，'
    + '值由 `refactor/modules/jev/judge.js:262` 从校验后的 `parsed.memory.mode` 动态透传（模式白名单在 judge.js:22），'
    + '不是观测写入点上的静态字面量，故本闸无法按写入点锚定；运行时仍由 schema enum 校验并由 enumCoercions 留痕。',
  'send.errorCode': '唯一写入点（orchestrator:1545）只在**发送成功**时写，压根不带 errorCode 键 ⇒ 现在无失真面。'
    + '字段名 `errorCode` 在语料里另有别的词汇表，按名扫必误报。',
  'spans.status': '值来自全仓每一处 `span(...)`/`.end(status)` 调用；`status` 这个字段名在语料里有 **248 处**、'
    + '分属至少 6 套互不相干的词汇表（N45 实测）⇒ 按字段名锚定必然几百条误报。',
  'events.status': '同 spans.status（`event(...)` 的调用方遍布全仓）。',
  'trace.lane': '写入点是 `beginTurn({lane})` 的调用方（跨模块透传）。注：orchestrator 侧喂给台账的 lane '
    + '已由 decision/planDecisionLedger 锚点覆盖（两者同一个 LANES 词汇表，但 Set 是各自独立的实例）。',
  'trace.status': '同 spans.status。',
  'trace.modelMetaReason': '★ N36 实测：`summarizePromptStructure` 在生产里**零调用**（整条 model-meta 链没接线）'
    + '⇒ 现在无失真面。丢弃路径已接 `noteEnumDrop`，一旦接线立刻开始计数。',
  'trace.modelMetaStripped': '同 trace.modelMetaReason（零调用；过滤路径已接 noteEnumDrop）。',
  'log.level': '写入点是全仓每一处 `log(...)`/`logger.*` 调用（几百处）⇒ 无法逐点锚定。'
    + '已接 `pickLevel()` 记账：拼错的级别（如 `configure({level:\'verbose\'})`）以前静默变 info，现在数得出来。'
};

/**
 * ★ 看着像写入点、其实**到不了**这张表的结构。登记理由，别让下一个人重新推一遍、
 *   更别把它们补进白名单（给死码发通行证比漏码更难查 —— N36 的 16 个候选里有 11 个是这种）。
 */
export const NOT_A_PRODUCER = [
  {
    structure: '`undeliveredReason()` 的 9 个码（COMPOSE_POLICY_SKIPPED / COMPOSE_DELIVERY_UNKNOWN / '
      + 'COMPOSE_PARTIAL / COMPOSE_UNCLASSIFIED / COMPOSE_UNKNOWN / SEND_NOT_CONFIRMED / SEND_FAILED / …）'
      + '与 `INCOMPLETE_REASON_CODES` 映射表',
    file: `${ORCH}:1039-1098`,
    notAColumnOf: 'decision.reasonCode',
    why: '它们经 `planReason(code,msg)` 写进 **`finish.reason`**（:2182-2187），流向是 '
      + '`reasonCode(finish.reason)` → `closeStage(...)` 的 **`code`**（:871/:878）—— 那是 `t:\'id\'` 字段，'
      + '**没有白名单**，也进 UI 文案。台账的 reasonCode 走的是 `decisionComposeReasonCode`，'
      + '只读 `finish.composeOutcome`/`composeReason`，**从不读 `finish.reason`**。'
      + '⇒ 这 9 个码补进 REASONS 就是 9 条永不出现的死码。'
  },
  {
    structure: '`receipt.reasonCode`（unknown_incomplete_receipt / known_all_failed / known_all_blocked / '
      + 'known_partial_no_receipt / known_no_receipt / known_partial_failed / platform_threw_unknown_or_all_failed）',
    file: 'refactor/modules/act/index.js:1548-1573',
    notAColumnOf: 'decision.reasonCode',
    why: '那是**发送回执自己的**原因词汇表，挂在 receipt 对象上；send 台账的 schema 里没有 reasonCode 这一列'
      + '（只有 errorCode）。同名字段、两套词汇表 —— 按字段名扫会在这里一次误报 7 条。'
  },
  {
    structure: "`log(..., {reasonCode: 'incomplete-tool-evidence' | 'event-contract-invalid' | 'event-contract-check-failed'})`",
    file: `${ORCH}:1200/1213/1217`,
    notAColumnOf: 'decision.reasonCode',
    why: 'log 的 `fields` 走 `safeFields()`（自由 ASCII 键值，**没有白名单**），不是台账枚举列。'
  },
  {
    structure: '`PLAN_MISSING`（:1904）与 `REPEAT_BLOCK_CIRCUIT`（:1955）',
    file: ORCH,
    notAColumnOf: 'decision.reasonCode',
    why: '这两处 `writeFinish` 发生在 `run.planDecisionLedger` 于 :1914 赋值**之前** ⇒ '
      + '`recordDecisionLedger`（:814）`if (!base …) return` 直接 early-return，**这一轮根本不写 decision 台账**。'
  },
  {
    structure: '`MODEL_TOOL_CALLS`（compose.js:1099）',
    file: 'refactor/modules/orchestrator/compose.js',
    notAColumnOf: 'decision.reasonCode',
    why: '进的是 `modelCallReasons` 数组（usage 台账的 `t:\'ids\'` 列），不是 decision.reasonCode。'
  }
];

/**
 * 显式豁免：**确实被某个锚点扫到、但故意不进白名单**的值。
 * 每条必须写理由，且 `runEnumGate` 会反向检查"这条豁免还真被扫到吗"（staleExempt）⇒
 * 豁免表不许变成垃圾场：写入点一消失，豁免就变红，逼着人来删。
 */
export const EXEMPT = [];

/* ───────────────────────── 采集 ───────────────────────── */

function readSource(repoRoot, rel) {
  const full = path.join(repoRoot, rel);
  if (!fs.existsSync(full)) return null;
  return stripComments(fs.readFileSync(full, 'utf8'));
}

function harvestAnchor(repoRoot, anchor, columnsById) {
  const text = readSource(repoRoot, anchor.file);
  if (text == null) return { error: `锚点文件不存在：${anchor.file}`, hits: [], inspected: [] };
  const hits = [];
  const inspected = new Set();          // 锚点**看过**的列（哪怕一个值都没扫到 —— 与"扫到了"分开记）
  const push = (column, value, abs, via) => {
    if (!columnsById.has(column)) return;             // 不是枚举列的键（kind/messageCount/…）直接跳过
    hits.push({ column, value, file: anchor.file, line: lineOf(text, abs), via: via || anchor.id });
  };
  const look = (column) => { if (columnsById.has(column)) inspected.add(column); };

  const resolveName = (name, abs, scopeHint) => {
    const scope = scopeHint || scopeOf(text, abs);
    return assignedLiterals(text, scope, name);
  };

  const fromObject = (blockText, blockStart, columnPrefix, scopeHint) => {
    const { fields } = objectEntries(blockText, blockStart);
    for (const field of fields) {
      const column = `${columnPrefix}.${field.name}`;
      if (!columnsById.has(column)) continue;
      look(column);
      if (field.expr == null) {                        // shorthand ⇒ 回溯同函数内的赋值
        for (const lit of resolveName(field.name, field.abs, scopeHint)) {
          push(column, lit.value, lit.abs, `${anchor.id} ←${field.name}=`);
        }
        continue;
      }
      for (const cand of candidates(field.expr, field.abs)) push(column, cand.value, cand.abs, `${anchor.id} ${field.name}:`);
    }
  };

  if (anchor.returnLiterals) {
    const fn = functionBodies(text).find((f) => f.name === anchor.fn);
    if (!fn) return { error: `找不到函数 ${anchor.fn}（${anchor.file}）`, hits, inspected: [...inspected] };
    look(anchor.column);
    const re = /return\s+/g;
    re.lastIndex = fn.start;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index >= fn.end) break;
      const at = m.index + m[0].length;
      const expr = readExpr(text, at);
      for (const cand of candidates(expr.text, at)) push(anchor.column, cand.value, cand.abs, `${anchor.id} return`);
      re.lastIndex = expr.end;
    }
    return { hits, inspected: [...inspected] };
  }

  if (anchor.returnObject) {
    const fn = functionBodies(text).find((f) => f.name === anchor.fn);
    if (!fn) return { error: `找不到函数 ${anchor.fn}（${anchor.file}）`, hits, inspected: [...inspected] };
    const body = text.slice(fn.start, fn.end);
    const at = body.lastIndexOf('return');
    if (at < 0) return { error: `${anchor.fn} 里没有 return`, hits, inspected: [...inspected] };
    const block = braceBlock(body, at);
    if (!block) return { error: `${anchor.fn} 的 return 不是对象字面量`, hits, inspected: [...inspected] };
    fromObject(block.text, fn.start + block.start, anchor.stream, fn);
    return { hits, inspected: [...inspected] };
  }

  if (anchor.call) {
    const re = new RegExp(`(^|[^.\\w$])${anchor.call}\\s*\\(`, 'g');
    let m;
    let found = 0;
    look(anchor.column);
    while ((m = re.exec(text)) !== null) {
      const at = m.index + m[0].length - 1;
      const args = callArgs(text, at);
      const arg = args[anchor.argIndex];
      if (!arg) continue;
      found += 1;
      for (const cand of candidates(arg.text, arg.abs)) push(anchor.column, cand.value, cand.abs, `${anchor.id} arg${anchor.argIndex}`);
      if (anchor.resolveAssign) {
        const bare = arg.text.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(bare)) {
          const scope = scopeOf(text, arg.abs);
          for (const lit of assignedLiterals(text, scope, bare)) {
            push(anchor.column, lit.value, lit.abs, `${anchor.id} arg${anchor.argIndex} ←${bare}=`);
          }
        }
      }
    }
    if (!found) return { error: `${anchor.file} 里找不到 ${anchor.call}( 的第 ${anchor.argIndex} 位实参`, hits, inspected: [...inspected] };
    return { hits, inspected: [...inspected] };
  }

  // anchor.anchor：定位对象字面量
  const needle = anchor.anchor;
  let from = 0;
  let found = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    found += 1;
    const block = braceBlock(text, at + needle.length - 1);
    if (block) fromObject(block.text, block.start, anchor.stream);
    from = at + needle.length;
    if (!anchor.all) break;
  }
  if (!found) return { error: `${anchor.file} 里找不到锚点 ${needle}`, hits, inspected: [...inspected] };
  return { hits, inspected: [...inspected] };
}

/**
 * 跑一遍闸门。返回报告；**不抛** —— 由 selftest 决定哪几项算红。
 */
export function runEnumGate({ repoRoot }) {
  const columns = collectColumns();
  const columnsById = new Map(columns.map((c) => [c.id, c]));
  const harvested = [];
  const inspected = new Set();
  const errors = [];

  for (const anchor of ANCHORS) {
    const res = harvestAnchor(repoRoot, anchor, columnsById);
    if (res.error) errors.push(res.error);
    harvested.push(...res.hits);
    for (const id of res.inspected) inspected.add(id);
  }

  const harvestedColumns = [...new Set(harvested.map((h) => h.column))].sort();
  // ★ "看过但一个字面量都没扫到"的列（值全是透传/运行时才有）—— 这类**必须**在 CENSUS_ONLY 里
  //   写明理由，否则就是"看着被锚点覆盖了、其实什么都没验"的假覆盖。
  const silentInspected = [...inspected].filter((id) => !harvestedColumns.includes(id)).sort();

  const unknown = [];
  const exemptUsed = [];
  for (const hit of harvested) {
    const col = columnsById.get(hit.column);
    if (!col) continue;
    if (col.allowed.has(hit.value)) continue;
    const exempt = EXEMPT.find((e) => e.column === hit.column && e.value === hit.value);
    if (exempt) { exemptUsed.push({ ...hit, why: exempt.why }); continue; }
    unknown.push(hit);
  }

  const staleExempt = EXEMPT.filter((e) => !harvested.some((h) => h.column === e.column && h.value === e.value));
  const uncoveredColumns = columns
    .filter((c) => !harvestedColumns.includes(c.id) && !CENSUS_ONLY[c.id])
    .map((c) => c.id);
  const silentButUndeclared = silentInspected.filter((id) => !CENSUS_ONLY[id]);
  const censusClaimsUnknownColumn = Object.keys(CENSUS_ONLY).filter((id) => !columnsById.has(id));
  const notAProducerClaimsUnknownColumn = NOT_A_PRODUCER.filter((n) => !columnsById.has(n.notAColumnOf)).map((n) => n.structure);

  return {
    columns,
    harvested,
    harvestedColumns,
    inspectedColumns: [...inspected].sort(),
    silentInspected,
    censusOnlyColumns: Object.keys(CENSUS_ONLY).sort(),
    unknown,
    exemptUsed,
    staleExempt,
    uncoveredColumns,
    silentButUndeclared,
    censusClaimsUnknownColumn,
    notAProducerClaimsUnknownColumn,
    anchorErrors: errors
  };
}
