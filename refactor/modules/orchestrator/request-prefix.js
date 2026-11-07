import { createHash } from 'node:crypto';

// 只在内存保留有界的成功首轮请求；不输出正文，不缓存图片原始数据，不写盘、不设定时器。
const baselines = new Map();
const MAX_ENTRIES = 32;
const MAX_CHARS = 128_000;
const TOTAL_CHARS = 1_000_000;
const TTL_MS = 30 * 60_000;
const hash = (value) => createHash('sha256').update(value).digest('hex');

function sectionOf(title, role) {
  if (role === 'system') return 'system';
  if (/历史上下文|过去状态/u.test(title)) return 'history';
  if (/跨轮心声/u.test(title)) return 'thoughts';
  if (/本体状态|关系状态|会话身份/u.test(title)) return 'state';
  if (/本轮上下文|本次唤醒|当前消息/u.test(title)) return 'current-turn';
  if (/记忆|印象|情节|待办/u.test(title)) return 'memory';
  if (/表情|引导/u.test(title)) return 'stable-assets';
  return 'other';
}

function snapshotOf(body) {
  let text = '';
  const ranges = [];
  const historyIds = [];
  const historyHashes = [];
  let historyComplete = true;
  let truncated = false;
  const append = (value, section) => {
    const remaining = MAX_CHARS - text.length;
    if (value.length > remaining) truncated = true;
    const part = value.slice(0, Math.max(0, remaining));
    if (part) ranges.push({ start: text.length, end: text.length + part.length, section });
    text += part;
  };
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    const role = String(message?.role ?? '');
    append(JSON.stringify({ role, name: message?.name, tool_call_id: message?.tool_call_id }) + '\n', 'message-meta');
    const parts = typeof message?.content === 'string'
      ? [{ type: 'text', text: message.content }] : (Array.isArray(message?.content) ? message.content : []);
    for (const part of parts) {
      if (typeof part?.text !== 'string') {
        append(`\n[part:${hash(JSON.stringify(part) ?? 'null')}]\n`, 'image-or-part');
        continue;
      }
      append(JSON.stringify({ type: part.type, cache_control: part.cache_control }) + '\n', 'message-meta');
      const source = part.text;
      const starts = [...source.matchAll(/^【([^】\r\n]{1,80})】[^\r\n]*(?:\r?\n|$)/gm)];
      if (!starts.length || starts[0].index > 0) {
        append(source.slice(0, starts[0]?.index ?? source.length), role === 'system' ? 'system' : 'other');
      }
      for (let i = 0; i < starts.length; i += 1) {
        append(source.slice(starts[i].index, starts[i + 1]?.index ?? source.length), sectionOf(starts[i][1], role));
      }
      // 历史统计只看历史区域，避免把本轮唤醒的编号误算成已发送历史。
      if (role === 'user') {
        const history = source.split(/(?:本轮时间：|【本轮上下文】)/u)[0];
        for (const row of history.matchAll(/^\[\d\d-\d\d \d\d:\d\d\] #([1-9]\d*) [^\r\n]*/gm)) {
          if (historyHashes.length >= 2048) { historyComplete = false; break; }
          historyIds.push(Number(row[1]));
          historyHashes.push(hash(row[0]));
        }
      }
      append('\n', 'message-meta');
    }
    if (message?.tool_calls) append(JSON.stringify(message.tool_calls), 'tool-calls');
    append('\n[end-message]\n', 'message-meta');
  }
  return { text, ranges, truncated, toolsHash: hash(JSON.stringify(body?.tools ?? [])),
    historyHead: historyIds[0] ?? null, historyRows: historyIds.length, historyHashes, historyComplete };
}

function purge(now) {
  for (const [key, row] of baselines) if (now - row.at >= TTL_MS) baselines.delete(key);
  let chars = [...baselines.values()].reduce((sum, row) => sum + row.text.length, 0);
  while (baselines.size > MAX_ENTRIES || chars > TOTAL_CHARS) {
    const key = baselines.keys().next().value;
    chars -= baselines.get(key).text.length;
    baselines.delete(key);
  }
}

function changedSectionOf(previous, current, common) {
  if (!previous) return 'baseline';
  if (common === MAX_CHARS && (previous.truncated || current.truncated)) return 'prefix-limit';
  if (previous.text === current.text && !previous.truncated && !current.truncated) return 'none';
  return current.ranges.find((range) => common >= range.start && common < range.end)?.section ?? 'message-end';
}

/** 比较应用实际发送的消息顺序；UTF-16 字符前缀只是定位信息，不代表厂商 token 命中。 */
export function inspectFinalRequestPrefix(identity, body, { now = Date.now() } = {}) {
  purge(now);
  const key = hash(JSON.stringify(identity));
  const previous = baselines.get(key);
  const current = snapshotOf(body);
  let common = 0;
  if (previous) {
    while (common < Math.min(previous.text.length, current.text.length)
      && previous.text[common] === current.text[common]) common += 1;
  }
  const limitReached = Boolean(previous && common === MAX_CHARS && (previous.truncated || current.truncated));
  const section = changedSectionOf(previous, current, common);
  return {
    facts: {
      prefixDiagnosticsAvailable: true,
      prefixBaselineAvailable: Boolean(previous), prefixCommonChars: previous ? common : 0,
      prefixComparedChars: current.text.length, prefixChangedSection: section,
      prefixLimitReached: limitReached,
      prefixToolsChanged: Boolean(previous && previous.toolsHash !== current.toolsHash),
      prefixHistoryHeadChanged: Boolean(previous && previous.historyHead !== current.historyHead),
      prefixHistoryRows: current.historyRows,
      prefixHistoryRowsLimited: !current.historyComplete,
      prefixHistoryAppendOnly: Boolean(previous && previous.historyComplete && current.historyComplete
        && previous.historyRows > 0 && current.historyRows > previous.historyRows
        && previous.historyHashes.every((value, index) => value === current.historyHashes[index]))
    },
    // 只有实际请求成功才调用；重试失败和工具续轮不覆盖下次初轮的基准。
    commit() {
      baselines.delete(key);
      baselines.set(key, { ...current, at: now });
      purge(now);
    }
  };
}

export function resetFinalRequestPrefixBaselinesForTest() { baselines.clear(); }
