/** Read-only browse/count views over the M6 raw chat archive. */
import fs from 'node:fs';
import path from 'node:path';

const MAX_PAGE = 80;
const MAX_DAY_BUCKETS = 366;
const MAX_CONTEXT_ROWS = 100;
const MAX_CONTEXT_CHARS = 10_000;
const MAX_QUERY_CHARS = 240;

class ArchiveViewError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function invalid(message) {
  throw new ArchiveViewError(400, message);
}

function unavailable(exportName, reason) {
  throw new ArchiveViewError(501, `not-ported: memory.${exportName}() ${reason}`);
}

function publicCall(exportName, action) {
  try {
    return action();
  } catch (error) {
    return {
      ok: false,
      status: error instanceof ArchiveViewError ? error.status : 500,
      error: error instanceof ArchiveViewError
        ? error.message
        : `memory.${exportName}() archive read failed: ${String(error?.code || error?.message || error)}`
    };
  }
}

function validChatKey(value) {
  const key = String(value ?? '').trim();
  if (!/^(?:group|private):\d{1,32}$/.test(key)) invalid('chatKey must be group:<digits> or private:<digits>');
  return key;
}

function safeKey(chatKey) {
  return chatKey.replace(/[^a-z0-9_]/gi, '_');
}

function pathsFor(dataDir, exportName) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    unavailable(exportName, 'requires explicit dataDir; source is unavailable');
  }
  const root = path.resolve(dataDir.trim());
  const hot = path.join(root, 'messages');
  const cold = path.join(root, 'messages-cold');
  let stat;
  try {
    stat = fs.statSync(hot);
  } catch (error) {
    unavailable(exportName, `messages source unavailable (${String(error?.code || error?.message || error)})`);
  }
  if (!stat.isDirectory()) unavailable(exportName, 'messages source is not a directory');
  try {
    fs.accessSync(hot, fs.constants.R_OK);
  } catch (error) {
    unavailable(exportName, `messages source unreadable (${String(error?.code || error?.message || error)})`);
  }
  try {
    const coldStat = fs.statSync(cold);
    if (!coldStat.isDirectory()) unavailable(exportName, 'messages-cold source is not a directory');
    fs.accessSync(cold, fs.constants.R_OK);
  } catch (error) {
    if (error instanceof ArchiveViewError) throw error;
    if (error?.code !== 'ENOENT') unavailable(exportName, `messages-cold source unreadable (${String(error?.code || error?.message || error)})`);
  }
  return { root, hot, cold };
}

function readArchiveFile(file, exportName) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    unavailable(exportName, `archive file unreadable (${path.basename(file)}: ${String(error?.code || error?.message || error)})`);
  }
  try {
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages)) {
      throw new Error('expected object with messages array');
    }
    return parsed.messages;
  } catch (error) {
    throw new ArchiveViewError(500, `memory.${exportName}() corrupt archive ${path.basename(file)}: ${String(error?.message || error)}`);
  }
}

function readChatMessages(chatKey, dataDir, exportName) {
  const key = validChatKey(chatKey);
  const { hot, cold } = pathsFor(dataDir, exportName);
  const prefix = safeKey(key);
  const coldFiles = [];
  try {
    for (const name of fs.readdirSync(cold)) {
      const match = new RegExp(`^${prefix}\\.(\\d+)\\.json$`).exec(name);
      if (match) coldFiles.push({ seq: Number(match[1]), file: path.join(cold, name) });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') unavailable(exportName, `messages-cold source unreadable (${String(error?.code || error?.message || error)})`);
  }
  coldFiles.sort((a, b) => a.seq - b.seq);
  const messages = [];
  for (const item of coldFiles) {
    const rows = readArchiveFile(item.file, exportName);
    if (rows) messages.push(...rows);
  }
  const hotRows = readArchiveFile(path.join(hot, `${prefix}.json`), exportName);
  if (hotRows) messages.push(...hotRows);
  return messages.filter((row) => row && typeof row === 'object');
}

function listArchiveFiles(dirs, exportName) {
  const keys = new Set();
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      unavailable(exportName, `archive directory unreadable (${String(error?.code || error?.message || error)})`);
    }
    for (const name of names) {
      const match = /^(group|private)_(\d+)(?:\.(\d+))?\.json$/.exec(name);
      if (!match) continue;
      const key = `${match[1]}:${match[2]}`;
      const file = path.join(dir, name);
      readArchiveFile(file, exportName);
      keys.add(key);
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b, 'en'));
}

function integerParam(value, fallback, { name, min = 0, max }) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min) invalid(`${name} must be an integer >= ${min}`);
  return Math.min(max, n);
}

function validDay(value, name = 'day') {
  if (value == null || value === '') return null;
  const text = String(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) invalid(`${name} must be YYYY-MM-DD`);
  const [, y, m, d] = match.map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) invalid(`${name} is not a calendar date`);
  return text;
}

function validHour(value) {
  if (value == null || value === '') return null;
  const text = String(value);
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2})$/.exec(text);
  if (!match) invalid('hour must be YYYY-MM-DD HH');
  validDay(match[1], 'hour date');
  if (Number(match[2]) > 23) invalid('hour must be between 00 and 23');
  return text;
}

function dayKeyOf(ts) {
  const date = new Date(Number(ts));
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function hourKeyOf(ts) {
  const date = new Date(Number(ts));
  if (!Number.isFinite(date.getTime())) return null;
  return `${dayKeyOf(ts)} ${String(date.getHours()).padStart(2, '0')}`;
}

function formatWhen(ts) {
  const date = new Date(Number(ts));
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fmtLine(message) {
  const who = message.self ? '我' : (message.senderName || message.senderId || '?');
  const text = String(message.text || '').replace(/\s+/g, ' ').trim();
  const media = Array.isArray(message.media) && message.media.length ? `[媒体x${message.media.length}]` : '';
  return {
    ts: Number(message.ts) || 0,
    when: formatWhen(message.ts),
    mid: message.mid ?? null,
    localId: message.id ?? null,
    who,
    self: !!message.self,
    text: (text + (media && !text.includes(media) ? ` ${media}` : '')).slice(0, 300)
  };
}

function scopeMessages(messages, { day, hour, dayFrom, dayTo }) {
  return messages.filter((message) => {
    const dk = dayKeyOf(message.ts);
    if (!dk) return false;
    if (hour && hourKeyOf(message.ts) !== hour) return false;
    if (day && dk !== day) return false;
    // Calendar-date bounds are closed: both dayFrom and dayTo are included.
    if (dayFrom && dk < dayFrom) return false;
    if (dayTo && dk > dayTo) return false;
    return true;
  });
}

function parseScope(options) {
  const hour = validHour(options.hour);
  const day = validDay(options.day);
  const dayFrom = validDay(options.dayFrom, 'dayFrom');
  const dayTo = validDay(options.dayTo, 'dayTo');
  if (hour && (day || dayFrom || dayTo)) invalid('hour cannot be combined with day/dayFrom/dayTo');
  if (day && (dayFrom || dayTo)) invalid('day cannot be combined with dayFrom/dayTo');
  if (dayFrom && dayTo && dayFrom > dayTo) invalid('dayFrom must be <= dayTo');
  return { hour, day, dayFrom, dayTo };
}

function sortedMessages(messages) {
  return [...messages].sort((a, b) => Number(a.ts) - Number(b.ts) || Number(a.id ?? 0) - Number(b.id ?? 0));
}

/** Old ArchiveReader.listChatKeys equivalent; malformed sources fail visibly. */
export function listArchiveChatKeys({ dataDir } = {}) {
  return publicCall('listArchiveChatKeys', () => {
    const dirs = pathsFor(dataDir, 'listArchiveChatKeys');
    return { ok: true, chatKeys: listArchiveFiles([dirs.hot, dirs.cold], 'listArchiveChatKeys') };
  });
}

/** Old ArchiveReader.listDays equivalent. Buckets use local calendar dates. */
export function listArchiveDays({ chatKey, dataDir, limit = 40 } = {}) {
  return publicCall('listArchiveDays', () => {
    const rows = readChatMessages(chatKey, dataDir, 'listArchiveDays');
    const cap = integerParam(limit, 40, { name: 'limit', min: 1, max: MAX_DAY_BUCKETS });
    const buckets = new Map();
    for (const row of rows) {
      const dayKey = dayKeyOf(row.ts);
      if (!dayKey) continue;
      const ts = Number(row.ts);
      const current = buckets.get(dayKey) || { dayKey, count: 0, firstTs: ts, lastTs: ts };
      current.count += 1;
      current.firstTs = Math.min(current.firstTs, ts);
      current.lastTs = Math.max(current.lastTs, ts);
      buckets.set(dayKey, current);
    }
    const days = [...buckets.values()].sort((a, b) => b.dayKey.localeCompare(a.dayKey)).slice(0, cap);
    return { ok: true, chatKey, days, total: buckets.size, limit: cap };
  });
}

/** Old ArchiveReader.listHours equivalent; hour labels use local time. */
export function listArchiveHours({ chatKey, day, dataDir, limit = 24 } = {}) {
  return publicCall('listArchiveHours', () => {
    const selectedDay = validDay(day);
    if (!selectedDay) invalid('day is required');
    const rows = readChatMessages(chatKey, dataDir, 'listArchiveHours');
    const cap = integerParam(limit, 24, { name: 'limit', min: 1, max: 24 });
    const buckets = new Map();
    for (const row of rows) {
      if (dayKeyOf(row.ts) !== selectedDay) continue;
      const hourKey = hourKeyOf(row.ts);
      buckets.set(hourKey, (buckets.get(hourKey) || 0) + 1);
    }
    const hours = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, cap)
      .map(([hourKey, count]) => ({ hourKey, count }));
    return { ok: true, chatKey, day: selectedDay, hours, total: buckets.size, limit: cap };
  });
}

/** Old ArchiveReader.load equivalent. Date range endpoints are inclusive. */
export function loadArchive(options = {}) {
  return publicCall('loadArchive', () => {
    const chatKey = validChatKey(options.chatKey);
    const scope = parseScope(options);
    const limit = integerParam(options.limit, 40, { name: 'limit', min: 1, max: MAX_PAGE });
    const offset = integerParam(options.offset, 0, { name: 'offset', max: 1_000_000 });
    const direction = options.direction ?? 'asc';
    if (direction !== 'asc' && direction !== 'desc') invalid('direction must be asc or desc');
    const query = String(options.query ?? '').trim();
    if (query.length > MAX_QUERY_CHARS) invalid(`query exceeds ${MAX_QUERY_CHARS} characters`);
    let rows = scopeMessages(readChatMessages(chatKey, options.dataDir, 'loadArchive'), scope);
    if (query) rows = rows.filter((row) => String(row.text || '').toLowerCase().includes(query.toLowerCase()));
    rows = sortedMessages(rows);
    const total = rows.length;
    const page = direction === 'desc'
      ? rows.slice(Math.max(0, total - offset - limit), Math.max(0, total - offset)).reverse()
      : rows.slice(offset, offset + limit);
    const lines = page.map(fmtLine);
    const returned = lines.length;
    return {
      ok: true, chatKey, scope, total, offset, limit, direction, returned,
      nextOffset: direction === 'desc' ? offset + returned : offset + returned,
      hasMore: direction === 'desc' ? Math.max(0, total - offset - returned) > 0 : offset + returned < total,
      lines
    };
  });
}

/** Old ArchiveReader.loadDay equivalent. */
export function loadArchiveDay({ chatKey, day, dataDir, offset = 0, limit = 40, query = '' } = {}) {
  const result = loadArchive({ chatKey, day, dataDir, offset, limit, query, direction: 'asc' });
  if (!result.ok && result.error?.includes('memory.loadArchive()')) {
    return { ...result, error: result.error.replace('memory.loadArchive()', 'memory.loadArchiveDay()') };
  }
  return result;
}

/** Old ArchiveReader.loadContextAround equivalent; this is strictly read-only. */
export function loadArchiveContextAround(options = {}) {
  return publicCall('loadArchiveContextAround', () => {
    const chatKey = validChatKey(options.chatKey);
    const scope = parseScope({ day: options.day, hour: options.hour });
    const before = integerParam(options.before, 8, { name: 'before', max: MAX_CONTEXT_ROWS });
    const after = integerParam(options.after, 8, { name: 'after', max: MAX_CONTEXT_ROWS });
    const maxChars = integerParam(options.maxChars, 1200, { name: 'maxChars', min: 1, max: MAX_CONTEXT_CHARS });
    const rows = sortedMessages(scopeMessages(readChatMessages(chatKey, options.dataDir, 'loadArchiveContextAround'), scope));
    if (!rows.length) return { ok: true, chatKey, lines: [], totalInSlice: 0, note: '该时段无原始存档' };
    const anchor = String(options.anchor ?? '').trim();
    let index = Math.floor(rows.length / 2);
    if (anchor) {
      let best = -1;
      let bestScore = 0;
      const terms = anchor.match(/[\u3400-\u9fff]{2}|[a-z0-9]{3,}/gi) || [];
      for (let i = 0; i < rows.length; i += 1) {
        const text = String(rows[i].text || '');
        let score = text.includes(anchor) ? 100 : 0;
        if (!score) for (const term of terms) if (text.toLowerCase().includes(term.toLowerCase())) score += 2;
        if (score > bestScore) { best = i; bestScore = score; }
      }
      if (best >= 0) index = best;
    }
    const start = Math.max(0, index - before);
    const end = Math.min(rows.length, index + 1 + after);
    const lines = [];
    let used = 0;
    for (let i = start; i < end; i += 1) {
      const line = fmtLine(rows[i]);
      const text = `${line.when.slice(5)} ${line.self ? '我' : line.who}: ${line.text}${i === index ? ' ◄命中' : ''}`;
      if (used + text.length > maxChars) break;
      used += text.length;
      lines.push(text);
    }
    return { ok: true, chatKey, hour: scope.hour || scope.day || dayKeyOf(rows[index].ts), totalInSlice: rows.length, anchorIndex: index, lines };
  });
}

/** Old ArchiveReader.count equivalent; messages counts matching rows, occurrences counts substrings. */
export function countArchiveMatches(options = {}) {
  return publicCall('countArchiveMatches', () => {
    const chatKey = validChatKey(options.chatKey);
    const query = String(options.query ?? '').trim();
    if (!query) invalid('query must be non-empty');
    if (query.length > MAX_QUERY_CHARS) invalid(`query exceeds ${MAX_QUERY_CHARS} characters`);
    const scope = parseScope(options);
    const caseSensitive = options.caseSensitive === true;
    const maxSamples = integerParam(options.maxSamples, 8, { name: 'maxSamples', min: 1, max: 50 });
    const rows = sortedMessages(scopeMessages(readChatMessages(chatKey, options.dataDir, 'countArchiveMatches'), scope));
    const needle = caseSensitive ? query : query.toLowerCase();
    const byDay = new Map();
    const byWho = new Map();
    const samples = [];
    let messages = 0;
    let occurrences = 0;
    for (const row of rows) {
      const text = String(row.text || '');
      const hay = caseSensitive ? text : text.toLowerCase();
      if (!hay.includes(needle)) continue;
      messages += 1;
      occurrences += hay.split(needle).length - 1;
      const dayKey = dayKeyOf(row.ts);
      byDay.set(dayKey, (byDay.get(dayKey) || 0) + 1);
      const who = row.self ? '我' : (row.senderName || row.senderId || '?');
      byWho.set(who, (byWho.get(who) || 0) + 1);
      if (samples.length < maxSamples) {
        const line = fmtLine(row);
        samples.push({ when: line.when, who: line.who, self: line.self, text: line.text, mid: line.mid, dayKey });
      }
    }
    const byDayRows = [...byDay.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 15)
      .map(([dayKey, count]) => ({ dayKey, messages: count }));
    const byWhoRows = [...byWho.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12)
      .map(([who, count]) => ({ who, messages: count }));
    return {
      ok: true, chatKey, query, scope, messages, occurrences, daysTouched: byDay.size,
      byDay: byDayRows, byWho: byWhoRows, samples,
      note: 'messages 按命中消息条数计；occurrences 是每条消息内非重叠出现次数之和。'
    };
  });
}
