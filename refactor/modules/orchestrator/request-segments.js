import { createHash } from 'node:crypto';

/**
 * ★ 2026-10-17（缓存真实诊断 · 473d331f）：
 *
 * 排序含义之争：这张表是**本诊断自己的枚举序**，不是供应商 token/工具序列化顺序
 * （供应商怎么把 messages/tools 拼进输入序列，源码里证明不了，不冒认）。
 * 但它被 `compareFinalRequestSegments` 当作「先看谁」的顺序 —— `firstChangedSegment`
 * 取**第一个**（按下标）变了的桶 ⇒ 枚举序必须让"实际呈现里的稳定前缀"排在
 * "逐轮变的动态尾"之前，否则一个恒变的桶会把真正想看的信息压在后面。
 *
 * 生产组包（`prompt/index.js` buildCurrentContextText + blocks 渲染，`includeContextHeadings:false`）：
 *   system → 【本轮上下文】标题行 → 历史正文（行首 `[MM-DD HH:MM]`，引用/媒体内联在这一行里）
 *   → 动态尾（当前话题/当前需要/本轮时间/本次唤醒/本轮可看的图）→ 本体状态/心声/记忆…
 * 历史正文历来整段混在 round_context 里 ⇒ 首变恒为 round_context，失去定位能力。
 * 现在拆开：标题行留 round_context（每轮字节相同），历史正文进 history_* 家族，
 * 动态尾进 `current_context_tail` —— 并把该桶插在 history 家族之后、memory/focus 之前；
 * 跨轮心声（own_speech）按真实呈现位（动态尾之后、记忆段之前）后移。
 * DS 第一批调整后，动态尾移到心声/记忆之后。下方桶枚举序保留兼容；
 * 真正按最终消息投影找最早变化的位置，使用 request-prefix.js 的 prefixChangedSection。
 */
const SEGMENT_ORDER = Object.freeze([
  'system_role', 'system_identity_rules', 'system_safety_rules', 'system_speech_rules',
  'system_turn_rules', 'system_history_format', 'system_sticker', 'system_other_rules',
  'round_context', 'operation_manual', 'sticker_context', 'participation', 'session_identity',
  'relation_state', 'meme_cue', 'tool_availability',
  'history_total', 'history_format_text', 'history_count_line', 'history_message_lines',
  'history_quote_media_annotations', 'history_timestamps', 'history_relative_times',
  'recent_history', 'history_messages',
  'current_context_tail', 'short_term_state', 'focus', 'own_speech', 'memory_view',
  'wake_evidence', 'current_message',
  'current_user_other', 'tool_calls', 'tool_results', 'image_parts', 'tool_definitions',
  'request_body'
]);

const SEGMENT_SOURCES = Object.freeze({
  system_role: 'system', system_identity_rules: 'system', system_safety_rules: 'system',
  system_speech_rules: 'system', system_turn_rules: 'system', system_sticker: 'system',
  system_history_format: 'system', system_other_rules: 'system', round_context: 'user_prompt',
  operation_manual: 'user_prompt', sticker_context: 'user_prompt', participation: 'user_prompt',
  session_identity: 'user_prompt', relation_state: 'emotion', meme_cue: 'media',
  tool_availability: 'tools', history_total: 'history', history_format_text: 'history',
  history_count_line: 'history', history_message_lines: 'history',
  history_quote_media_annotations: 'history', history_timestamps: 'history',
  history_relative_times: 'history', recent_history: 'history', own_speech: 'history',
  history_messages: 'history', current_context_tail: 'user_prompt', memory_view: 'memory',
  short_term_state: 'state', focus: 'state', wake_evidence: 'current_input',
  current_message: 'current_input', current_user_other: 'user_prompt', tool_calls: 'tool_call',
  tool_results: 'tool_result', image_parts: 'media', tool_definitions: 'tools', request_body: 'request'
});

const SEGMENT_LIMIT = 40;
const MAX_SESSION_BASELINES = 512;
const priorBySession = new Map();

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function stableJson(value) {
  const sort = (node) => {
    if (Array.isArray(node)) return node.map(sort);
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.keys(node).sort().map((key) => [key, sort(node[key])]));
    }
    return node;
  };
  return JSON.stringify(sort(value));
}

function sectionChunks(text) {
  const source = String(text ?? '');
  const starts = [...source.matchAll(/^【([^】\r\n]{1,80})】[^\r\n]*(?:\r?\n|$)|^你的参与度风格：[^\r\n]*(?:\r?\n|$)/gm)];
  if (!starts.length) return [{ title: '', text: source }];
  const chunks = [];
  if (starts[0].index > 0) chunks.push({ title: '', text: source.slice(0, starts[0].index) });
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i].index;
    const end = i + 1 < starts.length ? starts[i + 1].index : source.length;
    chunks.push({ title: starts[i][1] || (starts[i][0].startsWith('你的参与度风格：') ? '参与度参考' : ''), text: source.slice(start, end) });
  }
  return chunks;
}

function makeBuckets() {
  return new Map(SEGMENT_ORDER.filter((name) => name !== 'request_body').map((name) => [name, {
    name, source: SEGMENT_SOURCES[name], available: true, bytes: 0, items: 0, parts: []
  }]));
}

function addValue(buckets, name, value, { items = 1, rawText = false } = {}) {
  const bucket = buckets.get(name);
  if (!bucket) return;
  let serialized;
  try {
    serialized = rawText && typeof value === 'string' ? value : JSON.stringify(value);
  } catch { serialized = null; }
  if (typeof serialized !== 'string') {
    bucket.available = false;
    return;
  }
  bucket.bytes += Buffer.byteLength(serialized, 'utf8');
  bucket.items += items;
  // Store only a digest in this helper; prompt/tool contents never enter the baseline map.
  bucket.parts.push(`${Buffer.byteLength(serialized, 'utf8')}:${sha256(serialized)}`);
}

function addText(buckets, name, text, items = 1) {
  if (!text) return;
  addValue(buckets, name, text, { items, rawText: true });
}

function systemSectionName(title) {
  if (/角色设定|管理员附加人设|角色卡|共用底线|扩展提示|管理员附加规则/u.test(title)) return 'system_role';
  if (/表情包/u.test(title)) return 'system_sticker';
  if (/历史里的|历史.*格式|消息.*格式/u.test(title)) return 'system_history_format';
  if (/身份|你是谁/u.test(title)) return 'system_identity_rules';
  if (/安全|禁令/u.test(title)) return 'system_safety_rules';
  if (/说话|发言|AI 味/u.test(title)) return 'system_speech_rules';
  if (/工作方式|系统怎么运作|回程|进入|说不说话/u.test(title)) return 'system_turn_rules';
  return 'system_other_rules';
}

function addSystemText(buckets, text) {
  for (const section of sectionChunks(text)) {
    addText(buckets, systemSectionName(section.title), section.text);
  }
}

/**
 * ★ 2026-10-17（按真实渲染器对齐历史行）：
 * 历史行两种来源：
 *   · 生产（blocks.historyLine）：行首 `[MM-DD HH:MM]` 短时间（`formatShortAt`，无年份无秒），
 *     一条消息一行；引用段与媒体占位符**内联**在同一行里，时间读不到时行首是 `时间未知`。
 *   · legacy（老树行式 / 既有自测夹具）：`- YYYY-MM-DD HH:MM:SS ...`，且"引用/图片"说明续行
 *     以空白缩进另起一行。
 * 尾随内容不做限定：正文/编号/说话人/引用/媒体标记都在一行内，逐轮变的只有整行字节。
 */
const HISTORY_ROW_LEGACY_RE = /^-\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})(?:\s+(.*))?$/u;
const HISTORY_ROW_SHORT_RE = /^\[(\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})\]\s+(.*)$/u;
const HISTORY_ROW_UNKNOWN_TIME_RE = /^时间未知\s+(.*)$/u;
const HISTORY_COUNT_RE = /展示\s+\d+\/\d+\s+条(?:，较早\s+\d+\s+条未展示)?/u;
const HISTORY_ANNOTATION_RE = /^\s+(?:引用|媒体|图片|表情包|视频)(?:\s|：|$)/u;
const RELATIVE_TIME_RE = /\d+\s*(?:秒|分钟|小时|天)前/gu;

function isHistoryRow(line) {
  return HISTORY_ROW_LEGACY_RE.test(line) || HISTORY_ROW_SHORT_RE.test(line)
    || HISTORY_ROW_UNKNOWN_TIME_RE.test(line);
}

/** 历史行的行首时间串；`时间未知` 行没有时间，如实跳过（不伪造）。 */
function historyRowTime(line) {
  const match = line.match(HISTORY_ROW_LEGACY_RE);
  if (match) return match[1];
  return line.match(HISTORY_ROW_SHORT_RE)?.[1] ?? null;
}

function addHistorySection(buckets, text) {
  const lines = String(text ?? '').split('\n');
  const firstRow = lines.findIndex((line) => isHistoryRow(line));
  const header = firstRow < 0 ? String(text ?? '') : lines.slice(0, firstRow).join('\n');
  const countLine = header.match(HISTORY_COUNT_RE)?.[0] ?? '';
  const rowCount = firstRow < 0 ? 0 : lines.slice(firstRow).filter((line) => isHistoryRow(line)).length;
  addText(buckets, 'history_total', text, rowCount);
  if (countLine) addText(buckets, 'history_count_line', countLine);
  const formatText = countLine ? header.replace(countLine, '').trim() : header.trim();
  addText(buckets, 'history_format_text', formatText);
  if (firstRow < 0) {
    return;
  }
  const messageLines = [];
  const annotations = [];
  const timestamps = [];
  const relativeTimes = [];
  for (const line of lines.slice(firstRow)) {
    if (isHistoryRow(line)) {
      messageLines.push(line);
      const time = historyRowTime(line);
      if (time) timestamps.push(time);
    } else if (HISTORY_ANNOTATION_RE.test(line)) {
      annotations.push(line);
    }
    relativeTimes.push(...(line.match(RELATIVE_TIME_RE) ?? []));
  }
  addText(buckets, 'history_message_lines', messageLines.join('\n'), rowCount);
  addText(buckets, 'history_quote_media_annotations', annotations.join('\n'), annotations.length);
  addText(buckets, 'history_timestamps', timestamps.join('\n'), timestamps.length);
  addText(buckets, 'history_relative_times', relativeTimes.join('\n'), relativeTimes.length);
  // Keep a whole-row view for direct comparison; component rows above are diagnostic
  // slices/subsets and intentionally overlap this aggregate.
  addText(buckets, 'recent_history', lines.slice(firstRow).filter((line) => isHistoryRow(line)
    || HISTORY_ANNOTATION_RE.test(line)).join('\n'), rowCount);
}

/**
 * ★ 2026-10-17（一轮诊断不再恒报 round_context）：
 * 生产渲染（prompt/index.js buildCurrentContextText）历史上不再有独立段标题：
 *   【本轮上下文】（下方【过去状态】是旧消息，本轮新话在末尾）
 *   [MM-DD HH:MM] #编号 发言人：[引用 …]正文 [图片]      ← 历史正文（无段内标题）
 *   当前话题：… / 当前需要：… / 本轮时间：…            ← 动态尾开头（本轮时间恒存在）
 *   本轮新消息原文… / （主动机会）… / 本轮可看的图…     ← 动态尾其余
 * 这里按**当前真实渲染器**静态对齐：行首时间/仿行标注只在本段中识别；动态尾锚点
 * （话题/需要/本轮时间/唤醒表头/主动措辞/图片候选）之前的历史行进 history_* 家族，
 * 锚点起的一切进 current_context_tail。legacy 【过去状态】独立段仍走原路由。
 * 不认识的形状（无标题/标题不在行首）整段留在 round_context —— 不拆、不冒认历史。
 */
const CURRENT_CONTEXT_TITLE_RE = /^【本轮上下文】/u;
const CURRENT_TERMINAL_TAIL_RE = /^(?:当前话题：|当前需要：|本轮时间：|本轮新消息原文|（定时主动）|（随机）|（主动机会）|本轮可看的图)/u;

function addCurrentContextSection(buckets, text) {
  const lines = String(text ?? '').split('\n');
  if (!CURRENT_CONTEXT_TITLE_RE.test(lines[0] ?? '')) {
    addText(buckets, 'round_context', text);
    return;
  }
  const tailStart = lines.findIndex((line, index) => index > 0 && CURRENT_TERMINAL_TAIL_RE.test(line));
  if (tailStart < 0) {
    addText(buckets, 'round_context', text);
    return;
  }
  // 标题行单独留在 round_context：历史在场与否会翻转它的括注，这本身就是可对比信号。
  addText(buckets, 'round_context', lines[0]);
  const region = lines.slice(1, tailStart).join('\n');
  if (region.trim()) addHistorySection(buckets, region);
  addText(buckets, 'current_context_tail', lines.slice(tailStart).join('\n'), lines.length - tailStart);
}

function addShortTermSection(buckets, text) {
  const lines = String(text ?? '').split('\n');
  const focus = [];
  const state = [];
  for (const line of lines) {
    if (/^-\s*当前(?:话题|需要)：/u.test(line) || /^【焦点/u.test(line)) focus.push(line);
    else state.push(line);
  }
  addText(buckets, 'short_term_state', state.join('\n'));
  addText(buckets, 'focus', focus.join('\n'));
}

function userSectionName(title) {
  if (/^历史上下文$/u.test(title)) return 'history';
  if (/^当前消息$/u.test(title)) return 'current_message';
  if (/^本轮上下文$/u.test(title)) return 'round_context';
  if (/^(?:引导说明|怎么回|亢奋·极简引导)$/u.test(title)) return 'operation_manual';
  if (/表情包/u.test(title)) return 'sticker_context';
  if (/参与度/u.test(title)) return 'participation';
  if (/会话身份与此刻|^会话$/u.test(title)) return 'session_identity';
  if (/关系状态/u.test(title)) return 'relation_state';
  if (/脑内闪过/u.test(title)) return 'meme_cue';
  if (/本轮可用工具清单/u.test(title)) return 'tool_availability';
  if (/本次唤醒/u.test(title)) return 'wake_evidence';
  if (/记忆|印象|待办|情节摘要/u.test(title)) return 'memory_view';
  if (/短期状态|本体状态|本轮上下文/u.test(title)) return 'short_term_state';
  if (/焦点/u.test(title)) return 'focus';
  if (/心声|自身发言|你已经说过的历史发言/u.test(title)) return 'own_speech';
  if (/过去状态/u.test(title)) return 'history';
  return 'current_user_other';
}

function addUserText(buckets, text) {
  for (const section of sectionChunks(text)) {
    const target = userSectionName(section.title);
    if (target === 'history') addHistorySection(buckets, section.text);
    else if (target === 'short_term_state') addShortTermSection(buckets, section.text);
    else if (target === 'round_context') addCurrentContextSection(buckets, section.text);
    else addText(buckets, target, section.text);
  }
}

function addContent(buckets, message, target) {
  const content = message?.content;
  if (typeof content === 'string') {
    if (target === 'system') addSystemText(buckets, content);
    else if (target === 'current_user') addUserText(buckets, content);
    else addText(buckets, target, content);
    return;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === 'image_url' || part?.type === 'image') {
        const payload = typeof part?.image_url?.url === 'string' ? part.image_url.url
          : typeof part?.url === 'string' ? part.url : part;
        addValue(buckets, 'image_parts', payload, { items: 1, rawText: typeof payload === 'string' });
      } else if (typeof part?.text === 'string') {
        if (target === 'system') addSystemText(buckets, part.text);
        else if (target === 'current_user') addUserText(buckets, part.text);
        else addText(buckets, target, part.text);
      } else {
        addValue(buckets, target === 'system' ? 'system_other_rules' : target === 'current_user' ? 'current_user_other' : target, part);
      }
    }
    return;
  }
  if (content !== undefined && content !== null) addValue(buckets, target === 'system' ? 'system_other_rules' : target, content);
}

function metricHash(bucket) {
  return sha256(bucket.parts.join('|'));
}

export function measureFinalRequestSegments(body, { currentUserIndex = -1 } = {}) {
  const buckets = makeBuckets();
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const [index, message] of messages.entries()) {
    const role = String(message?.role ?? '');
    if (role === 'system') addContent(buckets, message, 'system');
    else if (index === currentUserIndex && role === 'user') addContent(buckets, message, 'current_user');
    else if (role === 'tool') addContent(buckets, message, 'tool_results');
    else if (role === 'assistant' && Array.isArray(message?.tool_calls)) {
      addValue(buckets, 'tool_calls', message.tool_calls, { items: message.tool_calls.length });
      if (message.content) addText(buckets, 'tool_calls', String(message.content));
    } else if (index < currentUserIndex && ['user', 'assistant'].includes(role)) {
      addValue(buckets, 'history_messages', { role, content: message?.content ?? null }, { items: 1 });
    } else if (role === 'user') addContent(buckets, message, 'current_user_other');
    else if (message?.content !== undefined && message?.content !== null) addText(buckets, 'current_user_other', String(message.content));
  }
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  addValue(buckets, 'tool_definitions', tools, { items: tools.length });

  const serializedBody = JSON.stringify(body ?? {});
  const bodyBytes = Buffer.byteLength(serializedBody, 'utf8');
  const bodyHash = sha256(serializedBody);
  const rows = SEGMENT_ORDER.filter((name) => name !== 'request_body').map((name) => {
    const bucket = buckets.get(name);
    return {
      name,
      source: bucket.source,
      available: bucket.available,
      bytes: bucket.available ? bucket.bytes : null,
      hash: bucket.available ? metricHash(bucket) : null,
      items: bucket.available ? bucket.items : null,
      changed: 'baseline'
    };
  });
  rows.push({ name: 'request_body', source: 'request', available: true, bytes: bodyBytes, hash: bodyHash,
    items: messages.length, changed: 'baseline' });
  const currentRawMessageAvailable = messages.some((message, index) => {
    if (index !== currentUserIndex || message?.role !== 'user') return false;
    const content = message.content;
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map((part) => String(part?.text ?? '')).join('\n') : '';
    return /(?:^|\n)【当前消息】/u.test(text);
  });
  if (!currentRawMessageAvailable) {
    const row = rows.find((entry) => entry.name === 'current_message');
    row.available = false; row.bytes = null; row.hash = null; row.items = null;
  }
  return { bodyBytes, bodyHash, rows };
}

export function compareFinalRequestSegments(chatKey, snapshot) {
  const keyText = String(chatKey ?? '').trim();
  const sessionKey = keyText ? sha256(keyText) : '';
  const previous = sessionKey ? priorBySession.get(sessionKey) : null;
  let changedSegmentCount = 0;
  let firstChangedSegment = null;
  const previousByName = new Map((previous ?? []).map((entry) => [entry.name, entry]));
  const rows = snapshot.rows.slice(0, SEGMENT_LIMIT).map((entry) => {
    const prior = previousByName.get(entry.name);
    let changed = 'baseline';
    if (previous) {
      if (!entry.available || !prior?.available || !entry.hash || !prior?.hash) changed = 'unavailable';
      else changed = entry.hash === prior.hash ? 'unchanged' : 'changed';
    }
    if (changed === 'changed') {
      changedSegmentCount += 1;
      if (!firstChangedSegment) firstChangedSegment = entry.name;
    }
    return { ...entry, changed };
  });
  if (sessionKey) {
    priorBySession.delete(sessionKey);
    priorBySession.set(sessionKey, rows.map(({ name, available, hash }) => ({ name, available, hash })));
    while (priorBySession.size > MAX_SESSION_BASELINES) priorBySession.delete(priorBySession.keys().next().value);
  }
  return { rows, changedSegmentCount, firstChangedSegment, baselineAvailable: Boolean(previous) };
}

export function resetFinalRequestSegmentBaselinesForTest() { priorBySession.clear(); }

export const REQUEST_SEGMENT_NAMES = SEGMENT_ORDER;
export const REQUEST_SEGMENT_SOURCES = Object.freeze([...new Set(Object.values(SEGMENT_SOURCES))]);
