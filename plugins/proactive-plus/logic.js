// 更好的主动聊天插件 1.0 · 纯逻辑层
//
// 只做四件事，全部无 IO：
//   ① 配置归一（静音时段、主动上限、分享开关/上限、筛选口径）；
//   ② 静音时段判定（含跨午夜）与“早上恢复”计划；
//   ③ 主动发言/分享内容的额度判定（同一轮、最小间隔、每天上限）；
//   ④ 生成注入给模型的稳定规则与本轮提示。
//
// 刻意不做：不读文件、不联网、不调用模型、不碰真实 data/。

export const PLUGIN_ID = 'proactive-plus';
export const TURN_MARK = '【更好的主动聊天插件 · 本轮】';

/** 所有“对外发消息”的核内工具。主动轮里这些都要过静音/额度闸。 */
export const OUTBOUND_TOOLS = Object.freeze([
  'send_message',
  'send_image',
  'send_sticker',
  'image_lib_send',
  'send_music',
  'send_bilibili',
  'send_forward',
  'send_poke'
]);

export const CONTENT_TOOL_TYPES = Object.freeze({
  send_bilibili: 'bilibili',
  send_music: 'music'
});

export const TYPE_LABELS = Object.freeze({
  bilibili: 'B站视频',
  music: '歌',
  link: '网页链接'
});

/** 夜间要临时关掉、早上恢复的三个 proactive 键。 */
export const QUIET_KEYS = Object.freeze(['enabled', 'privateIdleEnabled', 'privateScheduleEnabled']);
export const MAX_CHATS = 300;

// ── 小工具 ───────────────────────────────────────────────────────────────

const asBool = (value, fallback = false) => (value === true ? true : value === false ? false : fallback);

const asInt = (value, fallback, min, max) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
};

const textBlock = (value, max = 0) => {
  let text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (max > 0 && text.length > max) text = text.slice(0, max);
  return text;
};

/** 解析 HH:MM → 当天分钟数；非法返回 null。 */
export function parseHHMM(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatHHMM(totalMinutes) {
  const value = Math.max(0, Math.min(1439, Math.round(Number(totalMinutes) || 0)));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

/** 5 字段 cron（宿主本地时区）。 */
export function cronForHHMM(value) {
  const minutes = parseHHMM(value);
  if (minutes == null) return '';
  return `${minutes % 60} ${Math.floor(minutes / 60)} * * *`;
}

export function dayKeyOf(now) {
  const date = new Date(now);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

// ── 配置 ─────────────────────────────────────────────────────────────────

export function defaultConfig() {
  return {
    quietEnabled: true,
    quietStart: '00:30',
    quietEnd: '12:10',
    quietWorkEnabled: true,
    quietWorkStart: '13:50',
    quietWorkEnd: '18:15',
    /** true = 这段只在工作日静音（节假日/双休日照常主动）。 */
    quietWorkRestOnly: true,
    capEnabled: true,
    minIntervalMin: 120,
    maxPerDay: 3,
    maxPerRound: 2,
    allowBilibili: false,
    allowMusic: false,
    allowLink: false,
    shareMinIntervalMin: 240,
    shareMaxPerDay: 1,
    shareCriteria: ''
  };
}

export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const defaults = defaultConfig();
  const start = parseHHMM(src.quietStart);
  const end = parseHHMM(src.quietEnd);
  const workStart = parseHHMM(src.quietWorkStart);
  const workEnd = parseHHMM(src.quietWorkEnd);
  return {
    quietEnabled: asBool(src.quietEnabled, defaults.quietEnabled),
    quietEnabled: asBool(src.quietEnabled, defaults.quietEnabled),
    quietStart: start == null ? defaults.quietStart : formatHHMM(start),
    quietEnd: end == null ? defaults.quietEnd : formatHHMM(end),
    quietWorkEnabled: asBool(src.quietWorkEnabled, defaults.quietWorkEnabled),
    quietWorkStart: workStart == null ? defaults.quietWorkStart : formatHHMM(workStart),
    quietWorkEnd: workEnd == null ? defaults.quietWorkEnd : formatHHMM(workEnd),
    quietWorkRestOnly: asBool(src.quietWorkRestOnly, defaults.quietWorkRestOnly),
    capEnabled: asBool(src.capEnabled, defaults.capEnabled),
    minIntervalMin: asInt(src.minIntervalMin, defaults.minIntervalMin, 0, 1440),
    maxPerDay: asInt(src.maxPerDay, defaults.maxPerDay, 0, 50),
    maxPerRound: asInt(src.maxPerRound, defaults.maxPerRound, 1, 5),
    allowBilibili: asBool(src.allowBilibili, false),
    allowMusic: asBool(src.allowMusic, false),
    allowLink: asBool(src.allowLink, false),
    shareMinIntervalMin: asInt(src.shareMinIntervalMin, defaults.shareMinIntervalMin, 0, 10080),
    shareMaxPerDay: asInt(src.shareMaxPerDay, defaults.shareMaxPerDay, 0, 20),
    shareCriteria: textBlock(src.shareCriteria, 1200)
  };
}

/** 只保留面板该写的键。 */
export function configForSave(raw) {
  const config = normalizeConfig(raw);
  return { ...config };
}

// ── 静音 ─────────────────────────────────────────────────────────────────

/** 当前时刻是否在静音时段内（支持 23:00 → 次日 07:00 这种跨午夜）。 */
export function isQuietAt(config, now, rest = null) {
  const conf = config && typeof config === 'object' ? config : defaultConfig();
  if (conf.quietEnabled === false) return false;
  const time = Number(now);
  if (!Number.isFinite(time)) return false;
  const date = new Date(time);
  const current = date.getHours() * 60 + date.getMinutes();
  const inWin = (s, e) => {
    const a = parseHHMM(s);
    const b = parseHHMM(e);
    if (a == null || b == null || a === b) return false;
    return a < b ? current >= a && current < b : current >= a || current < b;
  };
  if (inWin(conf.quietStart, conf.quietEnd)) return true;
  if (conf.quietWorkEnabled !== false && inWin(conf.quietWorkStart, conf.quietWorkEnd)) {
    if (conf.quietWorkRestOnly === false) return true;
    return rest === false;
  }
  return false;
}

export function quietWindowText(config) {
  const conf = config && typeof config === 'object' ? config : defaultConfig();
  const crosses = parseHHMM(conf.quietStart) > parseHHMM(conf.quietEnd);
  const night = conf.quietStart + (crosses ? '–次日 ' : '–') + conf.quietEnd;
  if (conf.quietWorkEnabled === false) return night;
  const work = conf.quietWorkStart + '–' + conf.quietWorkEnd
    + (conf.quietWorkRestOnly === false ? '' : '（仅工作日）');
  return night + ' / ' + work;
}

// ── 状态 ─────────────────────────────────────────────────────────────────

export function defaultState() {
  return { version: 1, quiet: null, chats: {} };
}

function normalizeChat(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    lastProactiveAt: Number(src.lastProactiveAt) || 0,
    dayKey: String(src.dayKey || ''),
    dayCount: Math.max(0, Number(src.dayCount) || 0),
    roundKey: String(src.roundKey || ''),
    roundCount: Math.max(0, Number(src.roundCount) || 0),
    lastShareAt: Number(src.lastShareAt) || 0,
    shareDayKey: String(src.shareDayKey || ''),
    shareDayCount: Math.max(0, Number(src.shareDayCount) || 0)
  };
}

export function normalizeState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const state = defaultState();
  if (src.quiet && typeof src.quiet === 'object' && src.quiet.active === true) {
    state.quiet = {
      active: true,
      startedAt: Number(src.quiet.startedAt) || 0,
      configWritten: src.quiet.configWritten === true,
      original: src.quiet.original && typeof src.quiet.original === 'object' ? { ...src.quiet.original } : {},
      applied: src.quiet.applied && typeof src.quiet.applied === 'object' ? { ...src.quiet.applied } : {}
    };
  }
  const chats = src.chats && typeof src.chats === 'object' ? src.chats : {};
  const rows = Object.entries(chats)
    .filter(([chatKey]) => /^(group|private):\d{5,15}$/.test(String(chatKey)))
    .map(([chatKey, value]) => [chatKey, normalizeChat(value)])
    .sort((a, b) => Math.max(b[1].lastProactiveAt, b[1].lastShareAt) - Math.max(a[1].lastProactiveAt, a[1].lastShareAt))
    .slice(0, MAX_CHATS);
  for (const [chatKey, value] of rows) state.chats[chatKey] = value;
  return state;
}

export function chatStateOf(state, chatKey) {
  return state?.chats?.[String(chatKey || '')] || null;
}

/** 把判定补丁写进 state.chats（纯函数：返回新 state，不改入参）。 */
export function applyChatPatch(state, chatKey, patch) {
  const base = normalizeState(state);
  if (!patch || !chatKey) return base;
  const key = String(chatKey);
  const current = base.chats[key] || normalizeChat({});
  base.chats[key] = normalizeChat({ ...current, ...patch });
  return base;
}

// ── 额度 ─────────────────────────────────────────────────────────────────

/**
 * 主动轮对外发送的额度。
 * @returns {{allow:boolean, reason:string, patch:object|null}}
 *   · 同一轮（roundKey 相同）最多 maxPerRound 条；
 *   · 新一轮遵守 minIntervalMin 与 maxPerDay（0 = 不限）。
 */
export function decideProactiveSend({ config, state, chatKey, now, roundKey }) {
  const conf = config && typeof config === 'object' ? config : defaultConfig();
  if (conf.capEnabled === false) return { allow: true, reason: '', patch: null };
  const chat = chatStateOf(state, chatKey) || normalizeChat({});
  const today = dayKeyOf(now);
  const maxPerRound = Math.max(1, Number(conf.maxPerRound) || 1);
  const key = String(roundKey || '');

  if (key && chat.roundKey === key) {
    const used = Math.max(0, Number(chat.roundCount) || 0);
    if (used >= maxPerRound) {
      return { allow: false, reason: `这一轮已经主动发过 ${used} 条，本轮不再补发`, patch: null };
    }
    return { allow: true, reason: '', patch: { roundCount: used + 1, lastProactiveAt: now } };
  }

  const dayCount = chat.dayKey === today ? Math.max(0, Number(chat.dayCount) || 0) : 0;
  if (conf.maxPerDay > 0 && dayCount >= conf.maxPerDay) {
    return { allow: false, reason: `今天主动发言已达 ${conf.maxPerDay} 次上限`, patch: null };
  }
  const last = Math.max(0, Number(chat.lastProactiveAt) || 0);
  const gap = Math.max(0, Number(conf.minIntervalMin) || 0) * 60000;
  if (gap > 0 && last > 0 && now - last < gap) {
    const wait = Math.max(1, Math.ceil((gap - (now - last)) / 60000));
    return { allow: false, reason: `距离上次主动发言不到 ${conf.minIntervalMin} 分钟（还差约 ${wait} 分钟）`, patch: null };
  }
  return {
    allow: true,
    reason: '',
    patch: { dayKey: today, dayCount: dayCount + 1, lastProactiveAt: now, roundKey: key, roundCount: 1 }
  };
}

/**
 * 分享内容额度/开关。
 * - B站/歌：开关关 = 一律不发（包括对方点名要）。
 * - 网页链接：开关关只拦主动轮；对方明确要时允许（避免“回答里带链接”被误杀）。
 * - 开关开：主动轮受 shareMinIntervalMin / shareMaxPerDay 限制；日常聊天允许并记账。
 */
export function decideShare({ config, state, chatKey, type, proactive, now }) {
  const conf = config && typeof config === 'object' ? config : defaultConfig();
  const kind = String(type || '');
  if (!Object.prototype.hasOwnProperty.call(TYPE_LABELS, kind)) return { allow: true, reason: '', patch: null };
  const enabled = kind === 'bilibili' ? conf.allowBilibili
    : kind === 'music' ? conf.allowMusic
      : conf.allowLink;
  const isProactive = proactive === true;

  if (!enabled) {
    // 开关管的是“主动分享”：关掉后主动轮不发；对方点名要时仍允许（B站仍会改成标题+链接）。
    if (!isProactive) return { allow: true, reason: '', patch: null };
    return {
      allow: false,
      reason: `「${TYPE_LABELS[kind]}」主动分享未开启（设置 → 更好的主动聊天插件）`,
      patch: null
    };
  }

  const chat = chatStateOf(state, chatKey) || normalizeChat({});
  const today = dayKeyOf(now);
  const dayCount = chat.shareDayKey === today ? Math.max(0, Number(chat.shareDayCount) || 0) : 0;

  if (!isProactive) {
    return {
      allow: true,
      reason: '',
      patch: { lastShareAt: now, shareDayKey: today, shareDayCount: dayCount + 1 }
    };
  }

  if (conf.shareMaxPerDay > 0 && dayCount >= conf.shareMaxPerDay) {
    return { allow: false, reason: `今天分享内容已达 ${conf.shareMaxPerDay} 次上限`, patch: null };
  }
  const last = Math.max(0, Number(chat.lastShareAt) || 0);
  const gap = Math.max(0, Number(conf.shareMinIntervalMin) || 0) * 60000;
  if (gap > 0 && last > 0 && now - last < gap) {
    const wait = Math.max(1, Math.ceil((gap - (now - last)) / 60000));
    return { allow: false, reason: `距离上次分享不到 ${conf.shareMinIntervalMin} 分钟（还差约 ${wait} 分钟）`, patch: null };
  }
  return {
    allow: true,
    reason: '',
    patch: { lastShareAt: now, shareDayKey: today, shareDayCount: dayCount + 1 }
  };
}

// ── 恢复计划 ─────────────────────────────────────────────────────────────

/**
 * 早上恢复：只恢复“当前值仍是我们写进去的 false”的键。
 * 用户夜里手动改过的键不覆盖。
 */
export function quietRestorePlan({ original = {}, applied = {}, current = {} } = {}) {
  const patch = {};
  const restored = [];
  const skipped = [];
  for (const key of QUIET_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(applied, key)) continue;
    const appliedValue = applied[key];
    const currentValue = current?.[key];
    const originalValue = original?.[key];
    if (currentValue !== appliedValue) {
      skipped.push({ key, reason: 'user-changed' });
      continue;
    }
    if (typeof originalValue !== 'boolean') {
      skipped.push({ key, reason: 'no-original' });
      continue;
    }
    if (originalValue === appliedValue) {
      skipped.push({ key, reason: 'no-change' });
      continue;
    }
    patch[key] = originalValue;
    restored.push(key);
  }
  return { patch, restored, skipped };
}

/** 启动时对账：只保留“当前值仍等于我们写入值”的键。 */
export function quietStillControlled({ original = {}, applied = {}, current = {} } = {}) {
  const keptOriginal = {};
  const keptApplied = {};
  for (const key of QUIET_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(applied, key)) continue;
    if (current?.[key] === applied[key]) {
      keptOriginal[key] = original[key];
      keptApplied[key] = applied[key];
    }
  }
  return {
    original: keptOriginal,
    applied: keptApplied,
    keep: Object.keys(keptApplied).length > 0
  };
}

// ── 提示词 ───────────────────────────────────────────────────────────────

export function anyShareEnabled(config) {
  const conf = config && typeof config === 'object' ? config : defaultConfig();
  return conf.allowBilibili === true || conf.allowMusic === true || conf.allowLink === true;
}

/** 稳定分享规则：按开关只写启用的类型，逐字节稳定（利于缓存）。 */
export function shareRulesSection(config) {
  const conf = config && typeof config === 'object' ? config : defaultConfig();
  const enabled = [];
  if (conf.allowBilibili) enabled.push('B站视频');
  if (conf.allowMusic) enabled.push('歌');
  if (conf.allowLink) enabled.push('网页链接');
  if (!enabled.length) return '';
  const lines = [
    '【分享内容 · 可选】',
    `- 本实例允许你在聊天里分享：${enabled.join('、')}。`,
    '- 只有当你真的觉得对方会感兴趣、且它值得占用对方一次注意力时才发；不确定就不发，不要为了发而发。',
    '- B站视频用 send_bilibili(url=…)：本插件会把它发成“封面图 + 标题链接”，不走卡片；歌先用 search_music 找候选，再 send_music(songId=…)；网页先用 web_search / fetch_web 确认，再用 send_message 发标题 + 链接。',
    '- 分享前先筛：有信息量、有趣、和对方/当前话题有关，或能自然接话；不要广告、带货、标题党、低质搬运、擦边/争议、医疗投资建议、隐私内容；同一内容或同一作者不要短期重复。',
    '- 一条消息最多一个链接/一张卡；配一句自己的话说明为什么发，不要只丢链接。',
    '- 对方情绪不好、正在忙、或刚说过不想看东西时，不发。',
    '- 分享是可选动作，不是每轮任务：日常聊天不要硬塞；主动轮找不到值得发的，就正常说一句或保持安静。'
  ];
  const extra = String(conf.shareCriteria || '').trim();
  if (extra) lines.push(extra);
  return lines.join('\n');
}

/** 旧版兼容的文字生成器；当前宿主钩子已停止注入本轮动态提示。 */
export function turnNote({ config, state, chatKey, proactive, quiet, now }) {
  const conf = config && typeof config === 'object' ? config : defaultConfig();
  const lines = [];
  if (proactive && quiet) {
    lines.push(`- 现在是静音时段（${quietWindowText(conf)}）：本轮不要发送任何消息，直接 finish 收尾。`);
  } else if (proactive) {
    const chat = chatStateOf(state, chatKey) || normalizeChat({});
    const today = dayKeyOf(now);
    const dayCount = chat.dayKey === today ? Math.max(0, Number(chat.dayCount) || 0) : 0;
    if (conf.capEnabled && conf.maxPerDay > 0 && dayCount >= conf.maxPerDay) {
      lines.push(`- 今天主动发言已到 ${conf.maxPerDay} 次上限：本轮不要再发消息。`);
    } else {
      const last = Math.max(0, Number(chat.lastProactiveAt) || 0);
      const gap = Math.max(0, Number(conf.minIntervalMin) || 0) * 60000;
      if (conf.capEnabled && gap > 0 && last > 0 && now - last < gap) {
        const wait = Math.max(1, Math.ceil((gap - (now - last)) / 60000));
        lines.push(`- 距离上次主动发言不到 ${conf.minIntervalMin} 分钟（还差约 ${wait} 分钟）：本轮不要再发消息。`);
      } else {
        lines.push(`- 本轮是主动轮：最多说 ${conf.maxPerRound} 条，不要连发；有值得说的就说，没有就保持安静。`);
      }
    }
    if (anyShareEnabled(conf)) {
      lines.push('- 如果确实找到值得分享的内容，可以发；找不到就正常说一句或保持安静。');
    } else {
      lines.push('- 本轮不要发 B站视频/歌/网页链接（对应分享开关未开）。');
    }
  } else if (anyShareEnabled(conf)) {
    lines.push('- 分享只在话题合适时用；对方没问就别主动塞视频/歌/链接。');
  } else {
    lines.push('- 不要主动发 B站视频/歌/网页链接（分享开关未开）。');
  }

  if (anyShareEnabled(conf)) {
    const chat = chatStateOf(state, chatKey) || normalizeChat({});
    const last = Math.max(0, Number(chat.lastShareAt) || 0);
    const gap = Math.max(0, Number(conf.shareMinIntervalMin) || 0) * 60000;
    if (gap > 0 && last > 0 && now - last < gap) {
      lines.push('- 最近刚分享过内容，别急着再发。');
    }
  }
  return lines.length ? `${TURN_MARK}\n${lines.join('\n')}` : '';
}

export function isTurnMessage(message) {
  return message?.role === 'system'
    && typeof message.content === 'string'
    && message.content.startsWith(TURN_MARK);
}

// ── 小解析 ───────────────────────────────────────────────────────────────

export function parseToolArgs(raw) {
  try {
    const value = JSON.parse(String(raw ?? ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function containsUrl(value) {
  return /https?:\/\/[^\s"'<>）)】]+/i.test(String(value ?? ''));
}

export function argsContainUrl(argsRaw) {
  const raw = String(argsRaw ?? '');
  if (!raw) return false;
  try {
    return containsUrl(JSON.stringify(JSON.parse(raw)));
  } catch {
    return containsUrl(raw);
  }
}
