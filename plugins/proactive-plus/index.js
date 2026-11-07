// 更好的主动聊天插件 1.0 · 入口
//
// 目标（用户口径）：
//   · 夜里 23:00–次日 07:00 不主动找人；早上恢复。
//   · 保留白天原有概率，但加最小间隔、每天上限、单轮最多几条。
//   · 可选允许分享 B站视频 / 歌 / 网页链接；默认全关。
//   · B站视频不再发 QQ 卡片（群里/私聊根本点不开），改成“封面图 + 标题链接”。
//   · 筛选全靠主模型自己判断，不额外调用小模型。
//
// 纯插件、不改核心：
//   · 发送都走核内 act 工具；`before-tool` 钩子在这些工具执行前拦/改。
//   · 夜间“连唤醒一起停”= 插件临时把 proactive 的三个开关写 false，早上恢复；
//     只在当前值仍是我们写的那份 `false` 时才恢复，用户夜里手改的不覆盖。
//   · B站覆盖 = 在 `before-tool` 里把 send_bilibili 的调用改成 send_message：
//     media=[封面图(data URL), 标题+链接文本]。发送仍走核内 send_message 的回执链。
import fs from 'node:fs';
import path from 'node:path';

import { getConfig, updateConfigAndSave } from '../../refactor/core/config-store/index.js';
import { writeJsonAtomic } from '../../refactor/core/util/index.js';
import { DATA_DIR } from '../../refactor/modules/extensions/host-api.js';
import * as logic from './logic.js';

const STATE_NAME = 'proactive-plus-state.json';
const TICK_MS = 5 * 60 * 1000;
const FIRST_TICK_MS = 10 * 1000;
const BILI_TIMEOUT_MS = 3200;
const BILI_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  referer: 'https://www.bilibili.com/',
  accept: 'application/json,text/plain,*/*'
};

let api = null;
let state = logic.defaultState();
let stateFile = '';
let writing = false;

// ── 状态盘 ───────────────────────────────────────────────────────────────

function dataDir() {
  const env = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  if (env) return env;
  return String(DATA_DIR || '').trim();
}

function statePathOf() {
  const dir = dataDir();
  return dir ? path.join(dir, STATE_NAME) : '';
}

function loadState() {
  const file = statePathOf();
  if (!file) return logic.defaultState();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return logic.normalizeState(JSON.parse(raw));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      try { api?.warn?.(`更好的主动聊天插件：状态盘读取失败，按空状态继续：${error?.message ?? error}`); } catch { /* ignore */ }
    }
    return logic.defaultState();
  }
}

function saveState() {
  if (!stateFile) return false;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    writeJsonAtomic(stateFile, state, { indent: 1 });
    return true;
  } catch (error) {
    try { api?.warn?.(`更好的主动聊天插件：状态盘写入失败：${error?.message ?? error}`); } catch { /* ignore */ }
    return false;
  }
}

// ── 配置 / 核心 proactive ────────────────────────────────────────────────

function readConfig() {
  try {
    return logic.normalizeConfig(api?.config?.() || {});
  } catch {
    return logic.normalizeConfig({});
  }
}

function coreProactive() {
  try {
    const config = getConfig();
    return config && typeof config.proactive === 'object' && config.proactive ? config.proactive : {};
  } catch (error) {
    try { api?.warn?.(`更好的主动聊天插件：读取核心 proactive 配置失败：${error?.message ?? error}`); } catch { /* ignore */ }
    return {};
  }
}

function writeQuietBackup(session) {
  try {
    writing = true;
    updateConfigAndSave({ skills: { [logic.PLUGIN_ID]: { quietSession: session } } });
    return true;
  } catch (error) {
    try { api?.warn?.(`更好的主动聊天插件：写静音备份失败：${error?.message ?? error}`); } catch { /* ignore */ }
    return false;
  } finally {
    writing = false;
  }
}

// ── 静音切换 ─────────────────────────────────────────────────────────────

function enterQuiet(now, reason = '') {
  if (state.quiet?.active) return;
  const config = readConfig();
  if (!logic.isQuietAt(config, now)) return;
  const current = coreProactive();
  const original = {};
  const applied = {};
  for (const key of logic.QUIET_KEYS) {
    const value = current[key] === true;
    if (value) {
      original[key] = true;
      applied[key] = false;
    }
  }
  let configWritten = false;
  if (Object.keys(applied).length) {
    try {
      writing = true;
      updateConfigAndSave({ proactive: applied });
      configWritten = true;
    } catch (error) {
      try { api?.warn?.(`更好的主动聊天插件：夜间临时关 proactive 失败（发送仍会被硬拦）：${error?.message ?? error}`); } catch { /* ignore */ }
    } finally {
      writing = false;
    }
  }
  const session = {
    active: true,
    startedAt: now,
    configWritten,
    original,
    applied: configWritten ? applied : {}
  };
  state.quiet = session;
  writeQuietBackup(session);
  saveState();
  try {
    api?.log?.(`更好的主动聊天插件：进入静音 ${logic.quietWindowText(config)}${reason ? `（${reason}）` : ''}`
      + `${configWritten ? `；已临时关闭 ${Object.keys(applied).join('、')}` : '；核心 proactive 本来就关着'}`);
  } catch { /* ignore */ }
}

function exitQuiet(now, reason = '') {
  if (!state.quiet?.active) return false;
  const current = coreProactive();
  const plan = logic.quietRestorePlan({
    original: state.quiet.original,
    applied: state.quiet.applied,
    current
  });
  if (Object.keys(plan.patch).length) {
    try {
      writing = true;
      updateConfigAndSave({ proactive: plan.patch });
    } catch (error) {
      try { api?.warn?.(`更好的主动聊天插件：早上恢复 proactive 失败，下个 tick 再试：${error?.message ?? error}`); } catch { /* ignore */ }
      return false;
    } finally {
      writing = false;
    }
  }
  writeQuietBackup(null);
  state.quiet = null;
  saveState();
  try {
    api?.log?.(`更好的主动聊天插件：退出静音${reason ? `（${reason}）` : ''}`
      + `${plan.restored.length ? `；已恢复 ${plan.restored.join('、')}` : '；没有需要恢复的键'}`
      + `${plan.skipped.length ? `；跳过 ${plan.skipped.map((x) => x.key).join('、')}` : ''}`);
  } catch { /* ignore */ }
  return true;
}

function recoverQuietOnSetup(now) {
  let backup = null;
  try { backup = api?.config?.()?.quietSession || null; } catch { backup = null; }
  if (state.quiet?.active) {
    const kept = logic.quietStillControlled({
      original: state.quiet.original,
      applied: state.quiet.applied,
      current: coreProactive()
    });
    if (!kept.keep) {
      state.quiet = null;
      writeQuietBackup(null);
      saveState();
    } else {
      state.quiet.original = kept.original;
      state.quiet.applied = kept.applied;
      saveState();
    }
    return;
  }
  if (!backup || backup.active !== true) return;
  const config = readConfig();
  if (logic.isQuietAt(config, now)) {
    const kept = logic.quietStillControlled({
      original: backup.original || {},
      applied: backup.applied || {},
      current: coreProactive()
    });
    if (kept.keep) {
      state.quiet = {
        active: true,
        startedAt: Number(backup.startedAt) || now,
        configWritten: true,
        original: kept.original,
        applied: kept.applied
      };
      saveState();
    } else {
      writeQuietBackup(null);
    }
    return;
  }
  const plan = logic.quietRestorePlan({
    original: backup.original || {},
    applied: backup.applied || {},
    current: coreProactive()
  });
  if (Object.keys(plan.patch).length) {
    try {
      writing = true;
      updateConfigAndSave({ proactive: plan.patch });
    } catch (error) {
      try { api?.warn?.(`更好的主动聊天插件：启动时恢复 proactive 失败：${error?.message ?? error}`); } catch { /* ignore */ }
      return;
    } finally {
      writing = false;
    }
  }
  writeQuietBackup(null);
}

const HOLIDAYS_FILE = 'C:/dsh/hers_workplace/live/holidays.json';
let holidaysCache = { at: 0, off: new Set(), work: new Set() };
function holidaysNow() {
  const t = Date.now();
  if (t - holidaysCache.at < 60000) return holidaysCache;
  let off = new Set();
  let work = new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(HOLIDAYS_FILE, 'utf8'));
    const toSet = (arr) => new Set((Array.isArray(arr) ? arr : []).map((d) => String(d).slice(0, 10)));
    off = toSet(raw.off);
    work = toSet(raw.work);
  } catch { /* 没表就只按周末算 */ }
  holidaysCache = { at: t, off, work };
  return holidaysCache;
}

/** 今天算不算休息日：法定假日/周末休息，调休上班日算工作。 */
function isRestDay(now) {
  const d = new Date(now);
  const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const h = holidaysNow();
  if (h.off.has(key)) return true;
  if (h.work.has(key)) return false;
  const wd = d.getDay();
  return wd === 0 || wd === 6;
}

function checkQuiet(now, reason = '') {
  const config = readConfig();
  const quiet = logic.isQuietAt(config, now, isRestDay(now));
  if (quiet && !state.quiet?.active) enterQuiet(now, reason);
  else if (!quiet && state.quiet?.active) exitQuiet(now, reason);
}

function tick(reason) {
  try {
    checkQuiet(Date.now(), reason);
  } catch (error) {
    try { api?.warn?.(`更好的主动聊天插件：tick 失败：${error?.message ?? error}`); } catch { /* ignore */ }
  }
}

function registerSchedules() {
  if (!api || typeof api.schedule !== 'function') return;
  api.schedule({
    id: 'proactive-plus-tick',
    every: TICK_MS,
    delayMs: FIRST_TICK_MS,
    coalesce: 'skip'
  }, () => tick('interval'));
  const config = readConfig();
  if (!config.quietEnabled) return;
  const startCron = logic.cronForHHMM(config.quietStart);
  const endCron = logic.cronForHHMM(config.quietEnd);
  if (startCron) {
    api.schedule({ id: 'proactive-plus-quiet-start', cron: startCron, coalesce: 'skip' }, () => tick('quiet-start'));
  }
  if (endCron) {
    api.schedule({ id: 'proactive-plus-quiet-end', cron: endCron, coalesce: 'skip' }, () => tick('quiet-end'));
  }
}

// ── B站：封面图 + 标题链接（不走卡片）─────────────────────────────────────

function parseBiliIds(value) {
  const text = String(value || '');
  const bvid = /\/video\/(BV[0-9A-Za-z]+)/i.exec(text)?.[1] || (/^BV[0-9A-Za-z]{10}$/i.test(text) ? text : '');
  const aid = /\/video\/av(\d+)/i.exec(text)?.[1] || (/^av\d+$/i.test(text) ? text.replace(/^av/i, '') : '');
  return { bvid, aid };
}

function isBiliHost(value) {
  try {
    const host = new URL(String(value || '')).hostname.toLowerCase();
    return host === 'b23.tv' || host === 'bili2233.cn' || /(^|\.)bilibili\.com$/.test(host);
  } catch {
    return false;
  }
}

async function fetchWithTimeout(fetcher, input, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BILI_TIMEOUT_MS);
  try {
    return await fetcher(input, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function biliCookie() {
  try {
    return String(getConfig()?.webSearch?.bilibiliCookie || '').trim();
  } catch {
    return '';
  }
}

async function fetchBiliInfo(url) {
  const base = { url: String(url || ''), title: '', coverDataUrl: '' };
  const fetcher = api?.fetch;
  if (typeof fetcher !== 'function') return base;
  const cookie = biliCookie();
  const headers = cookie ? { ...BILI_HEADERS, cookie } : BILI_HEADERS;
  const work = (async () => {
    let finalUrl = base.url;
    let ids = parseBiliIds(finalUrl);
    if (!ids.bvid && !ids.aid) {
      const res = await fetchWithTimeout(fetcher, finalUrl, { redirect: 'follow', headers });
      finalUrl = String(res?.url || finalUrl);
      ids = parseBiliIds(finalUrl);
    }
    if (!ids.bvid && !ids.aid) return base;
    const query = ids.bvid ? `bvid=${encodeURIComponent(ids.bvid)}` : `aid=${encodeURIComponent(ids.aid)}`;
    const res = await fetchWithTimeout(fetcher, `https://api.bilibili.com/x/web-interface/view?${query}`, { headers: BILI_HEADERS });
    if (!res || res.ok === false) return base;
    const json = await res.json();
    if (json?.code !== 0 || !json?.data) return base;
    const data = json.data;
    const title = String(data.title || '').slice(0, 120);
    const pic = String(data.pic || data.cover || '').replace(/^http:/i, 'https:');
    let coverDataUrl = '';
    if (pic) {
      try {
        const image = await fetchWithTimeout(fetcher, pic, { headers: { ...headers, referer: 'https://www.bilibili.com/' } });
        if (image && image.ok !== false) {
          const type = String(image.headers?.get?.('content-type') || 'image/jpeg');
          const buffer = Buffer.from(await image.arrayBuffer());
          if (buffer.length > 0 && buffer.length <= 1.6 * 1024 * 1024) {
            coverDataUrl = `data:${type.startsWith('image/') ? type : 'image/jpeg'};base64,${buffer.toString('base64')}`;
          }
        }
      } catch { /* 封面失败只发文字 */ }
    }
    const bvid = String(data.bvid || ids.bvid || '').trim();
    return {
      url: bvid ? `https://www.bilibili.com/video/${bvid}` : finalUrl,
      title,
      coverDataUrl
    };
  })();
  try {
    return await Promise.race([
      work,
      new Promise((resolve) => setTimeout(() => resolve(base), BILI_TIMEOUT_MS + 200))
    ]);
  } catch {
    return base;
  }
}

async function buildBilibiliMessage(url) {
  const info = await fetchBiliInfo(url);
  const target = String(info.url || url);
  const text = info.title ? `${info.title}\n${target}` : target;
  return { messages: [text], coverDataUrl: info.coverDataUrl || '' };
}

/** 封面单独发（尽力而为）：标题+链接已经走 send_message 的回执链，封面失败不影响链接。 */
async function sendCover(chatKey, dataUrl) {
  if (!dataUrl || !chatKey) return false;
  const sender = api?.sender;
  try {
    if (sender && typeof sender.sendImage === 'function') {
      await sender.sendImage(chatKey, { dataUrl }, {});
      return true;
    }
    if (sender && typeof sender.sendSegments === 'function') {
      await sender.sendSegments(chatKey, [{ type: 'image', data: { file: dataUrl } }]);
      return true;
    }
  } catch (error) {
    try { api?.warn?.(`更好的主动聊天插件：B站封面发送失败（标题+链接已发）：${error?.message ?? error}`); } catch { /* ignore */ }
  }
  return false;
}

// ── 钩子 ─────────────────────────────────────────────────────────────────

function roundKeyOf(payload = {}) {
  const chatKey = String(payload.chatKey || '');
  const evidenceId = String(payload.evidenceId || '');
  const round = Number(payload.round) || 0;
  return `${chatKey}|${evidenceId || 'p'}|${round}`;
}

function applyPatches(chatKey, patches = []) {
  let changed = false;
  for (const patch of patches) {
    if (!patch) continue;
    state = logic.applyChatPatch(state, chatKey, patch);
    changed = true;
  }
  if (changed) saveState();
  return changed;
}

async function handleBilibili(payload, config, now) {
  const chatKey = String(payload.chatKey || '');
  const proactive = payload.proactive === true;
  const args = logic.parseToolArgs(payload.argsRaw);
  const url = String(args.url || '').trim();
  if (!url) return undefined;   // 交给核心报参数错误
  const ids = parseBiliIds(url);
  // 只接管 B站视频/BV/av/b23 短链；别的地址不碰，让核心自己报“不是 B 站地址”。
  if (!ids.bvid && !ids.aid && !isBiliHost(url)) return undefined;

  const share = logic.decideShare({ config, state, chatKey, type: 'bilibili', proactive, now });
  if (!share.allow) return { block: true, reason: share.reason };
  const pro = proactive
    ? logic.decideProactiveSend({ config, state, chatKey, now, roundKey: roundKeyOf(payload) })
    : { allow: true, reason: '', patch: null };
  if (!pro.allow) return { block: true, reason: pro.reason };
  applyPatches(chatKey, [share.patch, pro.patch]);

  if (!payload.call?.function) return undefined;
  const replacement = await buildBilibiliMessage(url);
  payload.call.function.name = 'send_message';
  payload.call.function.arguments = JSON.stringify({ messages: replacement.messages });
  if (replacement.coverDataUrl) void sendCover(chatKey, replacement.coverDataUrl);
  return { block: false };
}

async function beforeTool(payload = {}) {
  const toolName = String(payload.toolName || '');
  if (!logic.OUTBOUND_TOOLS.includes(toolName)) return undefined;
  const config = readConfig();
  const now = Date.now();
  const chatKey = String(payload.chatKey || '');
  const proactive = payload.proactive === true;

  if (proactive && logic.isQuietAt(config, now)) {
    return {
      block: true,
      reason: `现在是静音时段（${logic.quietWindowText(config)}）：本轮不要发送任何消息。`
    };
  }

  if (toolName === 'send_bilibili') return handleBilibili(payload, config, now);

  const type = logic.CONTENT_TOOL_TYPES[toolName]
    || (toolName === 'send_message' && logic.argsContainUrl(payload.argsRaw) ? 'link' : '');
  const share = type
    ? logic.decideShare({ config, state, chatKey, type, proactive, now })
    : { allow: true, reason: '', patch: null };
  if (!share.allow) return { block: true, reason: share.reason };

  const pro = proactive
    ? logic.decideProactiveSend({ config, state, chatKey, now, roundKey: roundKeyOf(payload) })
    : { allow: true, reason: '', patch: null };
  if (!pro.allow) return { block: true, reason: pro.reason };

  applyPatches(chatKey, [share.patch, pro.patch]);
  return undefined;
}

export const hooks = {
  'before-tool': async (payload = {}) => {
    try {
      return await beforeTool(payload);
    } catch (error) {
      try { api?.warn?.(`更好的主动聊天插件：before-tool 失败（放行）：${error?.message ?? error}`); } catch { /* ignore */ }
      return undefined;
    }
  },

  'before-llm-messages': (payload = {}) => {
    // 不再注入“本轮”动态 system。清理旧消息中的插件段，发送限制仍由 before-tool 执行。
    const messages = payload.messages;
    if (!Array.isArray(messages)) return;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (logic.isTurnMessage(messages[index])) messages.splice(index, 1);
    }
  }
};

// ── 生命周期 ─────────────────────────────────────────────────────────────

export function setup(a) {
  api = a;
  stateFile = statePathOf();
  state = loadState();
  // ★ 加载 ≠ 启用：这里只做只读准备，绝不改核心配置。
  //   真正的静音切换/定时器放到 activate()，避免“插件被关着却把 proactive 关了”。
  try {
    api?.onConfigChange?.(() => {
      if (writing) return;
      try {
        registerSchedules();
        checkQuiet(Date.now(), 'config-change');
      } catch (error) {
        try { api?.warn?.(`更好的主动聊天插件：配置变更处理失败：${error?.message ?? error}`); } catch { /* ignore */ }
      }
    });
  } catch { /* 订阅失败不阻断插件 */ }
  const config = readConfig();
  try {
    api?.log?.(`更好的主动聊天插件已加载（启用后生效；静音 ${logic.quietWindowText(config)}）`);
  } catch { /* ignore */ }
}

/** 启用时才开始：对账夜间备份、进入/退出静音、挂定时器。 */
export function activate() {
  recoverQuietOnSetup(Date.now());
  checkQuiet(Date.now(), 'activate');
  registerSchedules();
}

export function available() {
  return { ok: true };
}

export function promptSections() {
  const stable = logic.shareRulesSection(readConfig());
  if (!stable) return [];
  return [{ id: 'proactive-plus-share', title: '', priority: 0.4, content: stable }];
}

export function deactivate(context = {}) {
  if (state.quiet?.active && context?.reason !== 'reload') {
    exitQuiet(Date.now(), 'deactivate');
  }
}

export function dispose() {
  if (state.quiet?.active) exitQuiet(Date.now(), 'dispose');
  api = null;
}

export const internals = {
  state: () => state,
  readConfig,
  checkQuiet,
  enterQuiet,
  exitQuiet,
  fetchBiliInfo,
  buildBilibiliMessage,
  beforeTool
};
