/**
 * refactor/apps/server/index.js — 唯一出口 createServer
 *
 * 职责：HTTP 入口 + 生命周期（start/stop）。
 * 只做 IO/接线，不做决定。A→F 调用序列在 M15 modules/orchestrator/ 里。
 *
 * 依赖方向：apps → modules → core → contracts（只许 import 各模块的 index.js）
 */
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assemble } from './assembly.js';
import { handleRequest } from './http.js';
import { denialResponse, isApiPath, judgeApiRequest } from './api-gate.js';
import { resolveDataDir, UI_ROOT } from './paths.js';
import { createOneBotLink } from './onebot-link.js';
import { createSseHub } from './sse.js';
import { createSseBridge, BRIDGED_UI_NAMES } from './sse-bridge.js';
// ★ N-MEDIA-SHAPE（2026-10-11）：platform 模块的**纯函数**（onebot.js:611，无 IO/无发送面，
//   只把协议端消息段解析成 {kind,file,url,summary}）。modules.platform 被 setPlatform
//   换成本文件造的门面后（assembly.js:1391）就摸不到模块命名空间了 ⇒ orchestrator/index.js
//   的 P0 入站落盘（:2975）恒走回落支，把证据形状 {type,id} 写进 ChatStore，而消费侧
//   （act/executors/media.js:238/252 · compose 的 resolveUrl · 金句墙上传）要的是
//   {kind,file,url}。静态按 index.js 引入（文件头依赖规则：apps → modules 只许 import index.js）。
import { extractMediaFromSegments, expandForwardNodes } from '../../modules/platform/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
/** 二进制上传（import-zip）的体积上限；与 `api/shell.js` 的 ZIP_MAX_BYTES 必须同一个数。 */
const ZIP_UPLOAD_PATH = '/api/skills/import-zip';
const ZIP_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
/** 其余 /api 请求体的上限（防"不封顶地把 body 收进内存"；见 socket 分发段的说明）。 */
const API_BODY_MAX_BYTES = 64 * 1024 * 1024;
const FINGERPRINT_FILES = [
  'refactor/apps/server/index.js', 'refactor/apps/server/assembly.js',
  'refactor/modules/orchestrator/index.js', 'refactor/modules/orchestrator/compose.js',
  'refactor/modules/llm/llm.js', 'refactor/modules/llm/final-body.js',
  'refactor/core/observability/ledgers.js'
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  const sort = (node) => {
    if (Array.isArray(node)) return node.map(sort);
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.keys(node).sort().map((key) => [key, sort(node[key])]));
    }
    return node;
  };
  return JSON.stringify(sort(value));
}

/** Extract a local-only query string for the M7 coordinator; never log or persist it here. */
function vectorRecallQueriesForInbound(rawBatch) {
  const rows = Array.isArray(rawBatch) ? rawBatch
    : Array.isArray(rawBatch?.raw) ? rawBatch.raw
      : Array.isArray(rawBatch?.messages) ? rawBatch.messages
        : (rawBatch && typeof rawBatch === 'object' ? [rawBatch] : []);
  const defaultChatKey = String(rawBatch?.chatKey ?? '');
  const byChat = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const chatKey = String(row.chatKey ?? (row.message_type === 'group' && row.group_id != null
      ? `group:${row.group_id}`
      : row.message_type === 'private' && row.user_id != null
        ? `private:${row.user_id}` : defaultChatKey)).trim();
    if (!chatKey) continue;
    const segments = Array.isArray(row.message) ? row.message
      : Array.isArray(row.segments) ? row.segments : null;
    const segmentText = segments
      ? segments.filter((segment) => segment?.type === 'text')
        .map((segment) => String(segment?.data?.text ?? segment?.text ?? '')).filter(Boolean).join('\n')
      : '';
    const text = String(segmentText || row.text || row.raw_message || (typeof row.message === 'string' ? row.message : '')).trim();
    if (!text) continue;
    byChat.set(chatKey, [byChat.get(chatKey), text].filter(Boolean).join('\n').slice(-2048));
  }
  return byChat;
}

function runtimeCodeIdentity() {
  let commitHash = '';
  try {
    commitHash = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch { /* packaged/runtime environments may not include git */ }

  try {
    const diff = execFileSync('git', ['diff', '--binary', 'HEAD', '--', 'refactor'], {
      cwd: REPO_ROOT, encoding: null, timeout: 5000, maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return { commitHash, buildHash: sha256(Buffer.concat([Buffer.from(`${commitHash}\n`), diff])), buildHashSource: 'git-head-plus-refactor-diff' };
  } catch { /* fall through to a small source fingerprint */ }

  const digest = createHash('sha256');
  let included = 0;
  for (const file of FINGERPRINT_FILES) {
    try {
      digest.update(file).update('\0').update(readFileSync(path.join(REPO_ROOT, file))).update('\0');
      included += 1;
    } catch { /* a partial install may not contain every optional source file */ }
  }
  return { commitHash, buildHash: included ? digest.digest('hex') : '', buildHashSource: included ? 'source-file-set' : 'unavailable' };
}

// ══════════════════════════════════════════════════════════════════════
// ★ 启动分段计时（2026-10-11 mimo3 · 新#2「启动卡十秒」）
//   真实卡顿只在真启动里出现（当天三次启动：端口起来后主循环停摆 17~22s，
//   onebot 3s 心跳全程静默）⇒ 事后翻日志必须能回答"卡在哪一段"，只报总时长没用。
//   四段：进程起 → 装配 → 端口监听 → 首屏可取（首个 HTTP 请求被应答）。
//   进程起 = 本进程 JS 启动（Electron 主进程 ≈ electron.exe 拉起时刻）。
// ══════════════════════════════════════════════════════════════════════
const PROC_T0 = Math.round(performance.timeOrigin);
const sinceProcStart = () => Date.now() - PROC_T0;

// ══════════════════════════════════════════════════════════════════════
// W1 门面：把活 OneBot 客户端包成「只读白名单 + 拍一拍默认关 + 已配置头像切换」的 call
// ══════════════════════════════════════════════════════════════════════
// 为什么要有这一层：M15 的 `act.callProtocol`（modules/act/index.js:647）和 HTTP 侧
//   （api/media.js:395 · api/shell.js:940 · sticker-manager 构造）都需要一个能
//   `call(action, params)` 的协议端，而 onebot-link 的活门面（onebot-link.js:164-176）
//   刻意只给四个发送出口。裸递客户端等于"任何调用方都能拼任意动作"——
//   modules/platform/onebot.js:185 是 `${httpUrl}/${action}`，**零校验**。
//   这一层把"能叫哪些动作"变成一张看得见的名单，并且**在发 HTTP 之前**拒绝。
// ★ 边界（不许夸）：白名单只约束**新接入门面的调用方**（act.callProtocol / api/media /
//   sticker-manager）；裸客户端仍可从 `ctx.onebot.client` 拿到，现网就有这么用的
//   （api/shell.js:496-502 的 /api/onebot/groups）⇒ **这不是安全边界**，
//   只是"新接线不许无意间拿到任意动作"。
/** 只读动作白名单。每条都点名它照亮的那个 UI 功能，无来头的动作不进这张表。 */
export const PROTOCOL_READ_ACTIONS = Object.freeze([
  'get_image',                 // POST /api/media-data（api/media.js:417 取协议端本地缓存图）
  'fetch_custom_face_detail',  // /api/stickers/annotate + act 的 list_stickers（sticker-manager.js:181）
  'get_group_member_list',     // GET /api/groups/:id/members（api/shell.js:945）
  'get_forward_msg',           // act 的 read_forward 展开合并转发（executors/messaging.js:125）
  'get_msg'                    // 引用兜底：被引消息不在本地 ChatStore 时按 QQ message_id 回读原文
                                // （老树 src/app.js:857 resolveReply 的主路径；新树 resolveQuote 目前只有
                                //  findByRef 一条路 ⇒ 库外引用 quoted=null。已经在 media/boundaries.js:116
                                //  的 ONEBOT_READONLY_ALLOWED 里同为只读；客户端方法 getMsg 在
                                //  platform/onebot.js:428）
]);
/** 头像切换只供双人格状态服务使用；参数取自已保存的 persona2.avatarOn/avatarOff。 */
export const PROTOCOL_PERSONA_ACTIONS = Object.freeze(['set_qq_avatar', '_set_qq_avatar']);
/** 拍一拍一族：**默认关**，要开必须在配置里显式写 `protocol.pokeEnabled=true`。 */
export const PROTOCOL_POKE_ACTIONS = Object.freeze(['send_poke', 'friend_poke', 'group_poke']);
export const PROTOCOL_POKE_CONFIG_KEY = 'protocol.pokeEnabled';
/**
 * 群管理一族（2026-10-28 加，她要的「溟能在群里禁言」）。
 * ★ 名单刻意只有一条：`set_group_ban`（禁言/解禁）。踢人（set_group_kick / kick_members）、
 *   全员禁言（set_group_whole_ban）、改群资料一律**不进名单** —— 协议端有，这里不给。
 * ★ 没有额外的 `protocol.*Enabled` 配置闸：开关就是工具自己的权限位
 *   （`tools.overrides.mute_member`，界面上能关），加上这张代码名单。名单外一律在发 HTTP 之前拒。
 * ★ 参数在这一层再校一遍：group_id / user_id 必须是正整数，duration 是秒且 ≤30 天，
 *   不许把"忘了传时长"变成协议端的默认值。
 */
export const PROTOCOL_MODERATION_ACTIONS = Object.freeze(['set_group_ban']);
/** 禁言时长上限（秒）：30 天。协议端也收这个数，这里先挡一次。 */
export const GROUP_BAN_MAX_SECONDS = 2592000;

/**
 * 造门面。**不是**安全边界（见上面的边界说明），是接线层的动作闸。
 * @param {{onebot: object, cfg: object}} opts onebot=createOneBotLink 的返回，cfg=core/config-store 命名空间
 */
export function createProtocolFacade({ onebot, cfg } = {}) {
  const readSet = new Set(PROTOCOL_READ_ACTIONS);
  const pokeSet = new Set(PROTOCOL_POKE_ACTIONS);
  const moderationSet = new Set(PROTOCOL_MODERATION_ACTIONS);
  const currentPlatform = () => onebot?.platform ?? null;
  const live = currentPlatform();
  // setPlatform 的硬要求（assembly.js:549-552）在这里先自查一遍：不满足就抛给调用点记日志，
  // 而不是造出一个"注入了但发不出去"的半残门面。
  if (!live || typeof live.sendTextBatch !== 'function') {
    throw new Error('[apps/server] 门面需要 onebot.platform（带 sendTextBatch 的活实例），现在是空/半残');
  }

  /** 拍一拍闸：`cfg.effective` 缺失 / 抛错 / 值不是严格的 true ⇒ 一律拒（fail **closed**）。 */
  const pokeGate = () => {
    if (typeof cfg?.effective !== 'function') {
      return { ok: false, reason: `配置端 cfg.effective 不是函数 ⇒ ${PROTOCOL_POKE_CONFIG_KEY} 读不到，按关闭处理` };
    }
    let res;
    try { res = cfg.effective(PROTOCOL_POKE_CONFIG_KEY, {}); }
    catch (e) { return { ok: false, reason: `读 ${PROTOCOL_POKE_CONFIG_KEY} 失败：${e?.message ?? e}` }; }
    const value = res && typeof res === 'object' && Object.hasOwn(res, 'value') ? res.value : res;
    if (value === true) return { ok: true };
    return { ok: false, reason: `${PROTOCOL_POKE_CONFIG_KEY}=${String(value)}（默认关；要拍一拍必须在配置里显式写 true）` };
  };

  function configuredAvatarFile(candidate) {
    const file = String(candidate ?? '');
    if (!file) return false;
    for (const key of ['persona2.avatarOn', 'persona2.avatarOff']) {
      let configured = '';
      try { configured = String(cfg?.get?.(key) ?? '').trim(); } catch { /* fail closed */ }
      if (!configured) continue;
      const absolute = path.isAbsolute(configured) ? configured : path.resolve(REPO_ROOT, configured);
      if (file === configured || file === absolute || file === pathToFileURL(absolute).href) return true;
      try {
        if (file === `base64://${readFileSync(absolute).toString('base64')}`) return true;
      } catch { /* nonexistent configured avatar is rejected */ }
    }
    return false;
  }

  /**
   * 白名单化的协议调用。签名与裸客户端一致（onebot.js:184），所以调用方无需改写法。
   * 拒绝一律在**发 HTTP 之前**，并把闸名写进错误里（排障时能一眼看出是门面挡的，不是网关挡的）。
   */
  async function call(action, params = {}, timeoutMs = 15000, options = {}) {
    const name = String(action ?? '');
    const client = onebot?.client;   // getter：start() 之后才存在，stop() 之后回到 null
    if (!client || typeof client.call !== 'function') {
      throw new Error('协议门面不可用：OneBot 客户端未起（start() 之后 ctx.onebot.client 才存在）');
    }
    if (readSet.has(name)) return client.call(name, params, timeoutMs, options);
    if (PROTOCOL_PERSONA_ACTIONS.includes(name)) {
      if (!params || Object.keys(params).some((key) => key !== 'file') || !configuredAvatarFile(params.file)) {
        throw new Error('协议门面拒绝：头像动作只能使用 persona2.avatarOn/avatarOff 配置的图片文件');
      }
      return client.call(name, params, timeoutMs, options);
    }
    if (pokeSet.has(name)) {
      const gate = pokeGate();
      if (!gate.ok) throw new Error(`协议门面拒绝：拍一拍 ${name} —— ${gate.reason}`);
      return client.call(name, params, timeoutMs, options);
    }
    if (moderationSet.has(name)) {
      // 群禁言：只认 set_group_ban，参数三个都得在，且都在界内（见 PROTOCOL_MODERATION_ACTIONS 注释）。
      const num = (value) => {
        const n = Number(value);
        return Number.isSafeInteger(n) && n > 0 ? n : null;
      };
      const groupId = num(params?.group_id);
      const userId = num(params?.user_id);
      const duration = Number(params?.duration);
      if (!groupId || !userId) {
        throw new Error(`协议门面拒绝：${name} 需要正整数 group_id 与 user_id`);
      }
      if (!Number.isSafeInteger(duration) || duration < 0 || duration > GROUP_BAN_MAX_SECONDS) {
        throw new Error(`协议门面拒绝：${name} 的 duration 必须是 0..${GROUP_BAN_MAX_SECONDS} 的整数秒（0=解禁）`);
      }
      if (String(userId) === String(currentPlatform()?.selfId ?? '')) {
        throw new Error(`协议门面拒绝：${name} 不能作用于机器人自己`);
      }
      return client.call(name, { group_id: groupId, user_id: userId, duration }, timeoutMs, options);
    }
    throw new Error(`协议门面拒绝：动作「${name || '(空)'}」不在白名单。`
      + `只读=${PROTOCOL_READ_ACTIONS.join(', ')}；拍一拍=${PROTOCOL_POKE_ACTIONS.join(', ')}（需 ${PROTOCOL_POKE_CONFIG_KEY}=true）；头像=${PROTOCOL_PERSONA_ACTIONS.join(', ')}；群管理=${PROTOCOL_MODERATION_ACTIONS.join(', ')}`);
  }

  // 各入口每次都读取当前活实例；stop/start 后旧门面不保留上一连接的 platform 对象。
  // ★ N-MEDIA-SHAPE：extractMediaFromSegments 是 platform 模块的纯函数（无 IO/无发送面），
  //   与 call 并列暴露 —— orchestrator/index.js:2975 的 P0 入站落盘要从消息段里抽
  //   {kind,file,url,summary}；少了它写盘点只能回落证据形状 {type,id}，消费侧全部读不到。
  return Object.freeze({
    get connected() { return currentPlatform()?.connected ?? false; },
    // ★ 2026-10-11 sp4（指挥位窄授）：W1 门面透出下层 platform 的 selfId
    //   （onebot-link.js:187 的 getter ⇒ OneBot client 的 get selfId()）。
    //   M15/modulesObj.platform 看到的就是这一层 ⇒ ctx.selfId 靠它才有值。只加 getter。
    get selfId() { return currentPlatform()?.selfId ?? ''; },
    get connectionGeneration() { return currentPlatform()?.connectionGeneration ?? null; },
    getMsg: (messageId, options = {}) => {
      const getMsg = currentPlatform()?.getMsg;
      return typeof getMsg === 'function' ? getMsg(messageId, options) : null;
    },
    sendTextBatch: (...args) => {
      const send = currentPlatform()?.sendTextBatch;
      if (typeof send !== 'function') throw new Error('协议门面不可用：OneBot 发送队列未起');
      return send(...args);
    },
    sendImage: (...args) => {
      const send = currentPlatform()?.sendImage;
      if (typeof send !== 'function') throw new Error('协议门面不可用：OneBot 发送队列未起');
      return send(...args);
    },
    sendSegments: (...args) => {
      const send = currentPlatform()?.sendSegments;
      if (typeof send !== 'function') throw new Error('协议门面不可用：OneBot 发送队列未起');
      return send(...args);
    },
    call,
    extractMediaFromSegments,
    // setPlatform 会替换模块命名空间；read_forward 仍需此本地解析函数展开协议结果。
    expandForwardNodes
  });
}

/**
 * 创建服务器实例。
 * @param {object} opts
 * @param {string} opts.dataDir - **必须显式给**（fail-closed）
 * @param {number} [opts.port=3220] - 监听端口
 * @param {object} [opts.log] - 日志函数
 * @returns {Promise<{ start, stop, port, ctx }>}
 */
export async function createServer({ dataDir, port, log = console.log, allowProductionData = false } = {}) {
  // fail-closed：dataDir 必须显式注入；allowProductionData 闸的语义不变（默认拒、必须显式）
  const resolvedDataDir = resolveDataDir(dataDir, { allowProductionData });

  // ── 启动分段：四段毫秒 + 停摆哨兵（见文件头说明）─────────────────────
  const asmBeginMs = sinceProcStart();
  let startupPhase = '装配';
  let startBeginMs = 0;
  let listenMs = 0;
  const firstReq = { arriveMs: 0, at: 0, url: '', done: false };
  // 停摆哨兵：启动 90s 内每 1s 自查；迟到 >1s = 主循环被同步工作卡住 ⇒ 记一行（带阶段）。
  // 阶段标注能直接回答"卡在装配 / 卡在壳层等 start / 卡在监听后"——真实那次 17s 停摆落在"监听后"。
  const stallDeadline = Date.now() + 90000;
  let stallExpect = Date.now() + 1000;
  const stallSentinel = setInterval(() => {
    const now = Date.now();
    const lateMs = now - stallExpect;
    if (lateMs > 1000) {
      log(`[apps/server] 启动主循环停摆 ${lateMs}ms（阶段=${startupPhase}，进程起+${sinceProcStart()}ms）`);
    }
    stallExpect = now + 1000;
    if (now >= stallDeadline) clearInterval(stallSentinel);
  }, 1000);

  // ★ 2026-10-05 实测踩到的真坑（盘上有时间戳为证）：
  //   有些**旧树技能**（`skills/*`）在新进程里仍然 import 旧树的 `src/config.js`
  //   （写作相对路径向上两级 + `src`），而那份的 `DATA_DIR` 是**导入期求值**的（老树 config 第 42 行）
  //   ⇒ 只传 `createServer({dataDir})` 并不会改它 —— 于是"用临时目录起的新树探针"会去**读写生产 `data/`**。
  //   证据：00:02:03 一次探针跑完，`data/config.json` 被改写（技能日志自己打出"数据目录：<仓库>\data"）。
  //   ⇒ 在任何模块 / 插件被 import 之前，把进程环境指向本次真正要用的目录（插件加载在 assemble() 里）。
  //   注意：这是全局环境变量，本进程内所有"旧树遗留 import"都按它解析 —— 这正是我们要的收口。
  //   （本注释刻意不写出那个 import 字面量：apps/server 的静态门会把它当成真的 src/ 引用。）
  if (resolvedDataDir) process.env.QQ_AGENT_DATA_DIR = resolvedDataDir;

  // 装配（allowProductionData 透传给 assemble 的 resolveDataDir）
  const ctx = await assemble({ dataDir: resolvedDataDir, log, allowProductionData });
  // Explicit caller ports (including 0) win; desktop instances use their loaded per-account config.
  if (port === undefined) port = ctx.configStore.get("server.port", 3210);
  const asmEndMs = sinceProcStart();
  startupPhase = '壳层段（createServer 已回、等壳层调 start()）';

  // ★ W1：HTTP 分片读的是 `ctx.platform`（api/media.js:395 · api/shell.js:940 `ctx?.platform ?? ctx?.onebot`），
  //   而 assemble 的返回里没有这个键（它只有 setPlatform，写进 M15 看到的 modules 命名空间）。
  //   用 getter 而非普通赋值：start() 之前恒为 null ⇒ 分片如实 501「缺 ctx.platform」，
  //   stop() 之后也回到 null，不会留下一个"看着像活着、其实客户端已经关了"的门面。
  Object.defineProperty(ctx, 'platform', { get: () => protocolFacade, configurable: true, enumerable: true });

  // ★★ 2026-10-05 18:0x 指挥位修（**真连实测缺陷：连上了但 UI 显示没连上**）：
  //   `console-api.js:50 const onebot = ctx?.onebot;` 是全树 7 处 `ctx.onebot` 读取之一（另有
  //   `api/shell.js:496` 的 /api/onebot/groups、`:552` 的 onebot 状态、`api/media.js:116/395` 的
  //   `ctx?.platform ?? ctx?.onebot`）。而**本文件从来没有给 ctx 赋过 onebot** —— 只有上面这个 platform getter。
  //   ⇒ `/api/status` 的 `onebot.connected` 恒为 `null`（`onebot?.connected ?? null`），于是**网关明明连上了，
  //   UI 却判"没连上"**；`self.nickname` / `everConnected` / `lastConnectError` 一并拿不到。
  //   这里补上：把 onebot-link 的对象（含 `connected` / `client` 两个 getter）挂成惰性 getter，
  //   与 platform 同一风格 —— start() 之前为 null，UI 如实显示"未连"；连上之后立刻变真值。
  //   （`onebot-link.js:127-130` 的返回对象就有 `get platform` / `get client`，`client` 上有
  //    `everConnected` / `lastConnectError` / `selfInfo`。）
  Object.defineProperty(ctx, 'onebot', { get: () => onebot, configurable: true, enumerable: true });

let server = null;
  let listeningPort = 0;
  let onebot = null;
  /** W1 门面（HTTP 侧读的 `ctx.platform` 就是它）；未起 = null ⇒ api/*.js 如实 notPorted。 */
  let protocolFacade = null;
  let lockHeartbeat = null;
  let tickTimer = null;
  /** M15 运行时（**单例**：OneBot 入站、外部 onInbound、心跳三处必须是同一个实例）*/
  let runtime = null;

  /**
   * SSE（`/api/events`）：传输层 `sse.js` + 语义层 `sse-bridge.js`。
   * 两者都在 createServer 期建好（桥只订 bus，不需要运行时就绪）；`start()` 里再把 onebot 的
   * 状态订阅挂上去（onebot-link 的 `client` 是 start() 之后才存在的）。
   */
  const sseHub = createSseHub({ log, allowedNames: BRIDGED_UI_NAMES });
  const sseBridge = createSseBridge({ hub: sseHub, obs: ctx.obs, log });

  /**
   * SnowLuma 自动拉起（设置页 `snowluma.autoLaunch`；对齐老树 `src/app.js:3789-3803` 的启动行为）。
   *   · 只在 `autoLaunch === true`、且端口探测**确认未运行**时启动；复用 `modules/snowluma` 的既有出口
   *     （configure / resolveDirOrBundled / wsPort / isPortOpen / launch，模块本身不改）；
   *   · 目录、端口、失败原因逐条写进日志（失败不拦启动，与老树同款 try/catch）；
   *   · **不在这里等端口就绪**：HTTP 监听在本函数末尾的 `server.listen`，阻塞等待会拖住首屏
   *     （老树是 listen 在前才敢等 20s）；就绪情况由后台探针补日志，OneBot 客户端自带重连
   *     （`modules/platform/onebot.js:135/:163`），端口起得慢也会自己连上；
   *   · 正式启动入口显式允许使用随包 snowluma/，自定义目录优先；
   *     模块独立使用时仍要求调用方配置目录或显式允许随包目录。
   */
  async function autoLaunchSnowluma() {
    const cs = ctx.configStore || {};
    try {
      if (cs.get?.('snowluma.autoLaunch', false) !== true) return;
      const mod = ctx.modules?.get?.('modules/snowluma') || ctx.modulesObj?.snowluma || null;
      if (!mod || typeof mod.launch !== 'function' || typeof mod.isPortOpen !== 'function') {
        log('[snowluma] 自动启动跳过：modules/snowluma 未装配或缺 launch/isPortOpen（不冒重复启动的风险）');
        return;
      }
      // 与 POST /api/snowluma/launch 同一份"当前配置"读法（api/shell.js 的 snowlumaConfig）。
      mod.configure?.({
        dir: String(cs.get?.('snowluma.dir', '') || ''),
        allowBundledDir: true,
        wsUrl: String(cs.get?.('snowluma.wsUrl', '') || ''),
        webuiPassword: String(cs.get?.('snowluma.webuiPassword', '') || ''),
        accountWhitelist: cs.get?.('snowluma.accountWhitelist', []) || [],
        autoUnhookStrangers: cs.get?.('snowluma.autoUnhookStrangers', true) !== false
      });
      const dir = String(mod.resolveDirOrBundled?.() ?? '') || '';
      const wsPort = Number(mod.wsPort?.() || 0) || 3001;
      if (await mod.isPortOpen('127.0.0.1', wsPort)) {
        log(`[snowluma] 自动启动：端口 ${wsPort} 已在监听 ⇒ 确认已在运行，跳过`);
        return;
      }
      log(`[snowluma] 自动启动：目录=${dir || '（未配置）'} 端口=${wsPort} 未监听，开始拉起…`);
      const r = await mod.launch();
      if (r?.ok && r?.launched) {
        log(`[snowluma] 自动启动：已拉起（${r.embedded === true ? '内嵌模式' : '独立窗口'}${r.pid ? ` pid=${r.pid}` : ''}）`);
        watchSnowlumaReady(mod, wsPort);
      } else if (r?.alreadyRunning) {
        log(`[snowluma] 自动启动：模块复查发现已在运行（端口 ${wsPort}）⇒ 未重复启动`);
      } else {
        log(`[snowluma] 自动启动失败：${r?.error || '原因未知（模块未返回 error）'}`);
      }
    } catch (error) {
      log(`[snowluma] 自动启动失败：${error?.message ?? error}`);
    }
  }

  /** 自动拉起后的后台就绪探针：老树等 20×1s（`src/app.js:3795-3799`），这里只记日志、不阻塞启动。 */
  function watchSnowlumaReady(mod, wsPort) {
    void (async () => {
      const beganAt = Date.now();
      for (let i = 0; i < 20; i += 1) {
        if (await mod.isPortOpen('127.0.0.1', wsPort)) {
          log(`[snowluma] 自动启动：端口 ${wsPort} 就绪（用时 ${Date.now() - beganAt}ms）`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      log(`[snowluma] 自动启动：20s 内未见端口 ${wsPort} 就绪；OneBot 会按自身重连节奏继续尝试（详情见 SnowLuma 日志）`);
    })().catch((error) => log(`[snowluma] 自动启动：就绪探针异常 ${error?.message ?? error}`));
  }

  async function start() {
    if (server) throw new Error('[apps/server] 已在运行，不许重复 start()');
    startBeginMs = sinceProcStart();
    startupPhase = 'start()（实例锁/运行时/建连）';

    // ★ 实例锁（T-CUTOVER-4 C 节）：同一个 dataDir 只许一个实例在跑。
    //   旧树 src/app.js 有、桌面壳 apps/desktop/main.js:198 有，但 apps/server 一直是**零**。
    //   两套同时写 data/ 一次就可能不可逆（配置/账本各写各的），所以这里必须挡。
    //   同进程已持锁（壳先 acquire 再 in-process createServer）时不再抢，只续心跳。
    const lockApi = ctx.configStore || {};
    if (typeof lockApi.acquireInstanceLock === 'function') {
      const alreadyMine = typeof lockApi.touchInstanceLock === 'function' && lockApi.touchInstanceLock(0) === true;
      if (!alreadyMine) {
        const lock = await lockApi.acquireInstanceLock();
        if (lock && lock.ok === false) {
          throw new Error(`[apps/server] 同一数据目录已有实例在跑（pid=${lock.pid}，${lock.dir}）—— 拒绝启动，`
            + '先停掉那个实例（旧树/壳/另一个标签页）再起这个。理由：两套同时写 data/ 会造成不可逆的互相覆盖。');
        }
        if (lock?.tookOver) log(`[apps/server] 接管了残留实例锁：${lock.tookOver.reason}`);
        if (lock?.degraded) log(`[apps/server] 实例锁降级（不拦启动）：${lock.error}`);
      }
      if (typeof lockApi.startInstanceHeartbeat === 'function') {
        lockHeartbeat = lockApi.startInstanceHeartbeat(() => listeningPort);
      }
    }

    // M7 embedding 必须在 OneBot 与账号 coordinator 创建前就绪；失败由 assembly 记录原因并保留关键词检索。
    try { await ctx.startVectorEmbedding?.(); }
    catch (e) { log(`[apps/server] M7 向量启动流程异常，记忆保持关键词召回：${e?.message ?? e}`); }

    // 创建 M15 运行时 + OneBot 接线
    const runtimeTarget = ctx.createRuntime();
    const inboundWithVectorQuery = (rawBatch) => {
      const leases = [];
      for (const [chatKey, query] of vectorRecallQueriesForInbound(rawBatch)) {
        const token = ctx.setVectorRecallQuery?.(chatKey, query);
        if (token) leases.push([chatKey, token]);
      }
      let result;
      try { result = runtimeTarget.onInbound(rawBatch); }
      catch (error) {
        for (const [chatKey, token] of leases) ctx.clearVectorRecallQuery?.(chatKey, token);
        throw error;
      }
      return Promise.resolve(result).finally(() => {
        for (const [chatKey, token] of leases) ctx.clearVectorRecallQuery?.(chatKey, token);
      });
    };
    // M15 returns a frozen object, so a Proxy cannot legally replace its non-configurable
    // `onInbound` property (the Proxy invariant throws on first access). Build the public
    // facade explicitly and keep the same M15 methods while routing inbound through M7.
    runtime = Object.freeze({
      onInbound: inboundWithVectorQuery,
      wake: (request) => request?.proactive === true
        ? runtimeTarget.wake(request) : inboundWithVectorQuery(request),
      onTick: runtimeTarget.onTick,
      status: runtimeTarget.status,
      pause: runtimeTarget.pause,
      resume: runtimeTarget.resume,
      abortAll: runtimeTarget.abortAll,
      sendScheduled: runtimeTarget.sendScheduled
    });
    // ★ 同一个 runtime 也要交给 HTTP ctx：`/api/pause`、`/api/resume`（api/shell.js:388-409）读 `ctx.runtime`。
    //   不注入的话那两条永远 501「运行时未起」—— 而运行时其实好好活着（用户点暂停 = 点了没反应）。
    try {
      ctx.setRuntime(runtime);
      log('[apps/server] 已注入活 runtime → HTTP 的 /api/pause · /api/resume 可用');
    } catch (e) {
      log(`[apps/server] 注入活 runtime 失败（HTTP 暂停/恢复将不可用）：${e?.message ?? e}`);
    }
    // ── SnowLuma 自动拉起（snowluma.autoLaunch）──────────────────────────────
    //   对齐老树 src/app.js:3789-3803：确认没在跑才拉起，随后才建 OneBot（下面 createOneBotLink）。
    //   失败只记日志、不拦启动；"为什么不在这里等端口"见 autoLaunchSnowluma 的函数头注释。
    await autoLaunchSnowluma();
    // ★ 2026-10-18（令牌同步链）：正式启动入口**显式允许**使用随包的 `snowluma/`（与自动拉起、
    //   shell 的 launch 端点同一口径：配置目录优先，留空才回落随包目录）。没有这一步，干净包的
    //   `snowluma.dir` 为空 + 模块安全门（N47）会让"从账号文件认领令牌"直接判 no-dir —— WS 401
    //   刷屏就修不掉。注意只开"回落"，不写具体目录；模块独立使用（无此授权）仍默认拒绝。
    try {
      const slMod = ctx.modules?.get?.('modules/snowluma') || ctx.modulesObj?.snowluma || null;
      if (typeof slMod?.configure === 'function') {
        slMod.configure({ dir: String(ctx.configStore?.get?.('snowluma.dir', '') || ''), allowBundledDir: true });
      }
    } catch (error) {
      log(`[snowluma] 目录授权失败（令牌自动认领可能不可用）：${error?.message ?? error}`);
    }
    // modules 传对象（createOneBotLink 用 modules.platform.OneBotClient 属性访问）
    const modulesObj = {};
    for (const [id, mod] of ctx.modules) {
      modulesObj[id.replace(/^modules\//, '')] = mod;
    }
    modulesObj.configStore = ctx.configStore;
    modulesObj.observability = ctx.obs;
    /**
     * ★ N61（七）：store 必须**显式注进来**，别让 `onebot-link.js` 的 `resolveStore()` 再建一个。
     * 读侧（orchestrator / act）用的是 `assembly.js` 建的那一个；出站留档走的是这一侧。
     * 两个对象 ⇒ "谁写谁读不在一处"，写进档里的东西读侧看不见。
     * 注不到（装配层没建成）才退回工厂自己建 —— 那条路径 `resolveStore` 会打日志，不静默。
     */
    onebot = createOneBotLink({
      cfg: ctx.configStore, runtime, modules: modulesObj,
      store: ctx.modulesObj?.memory?.store ?? null,
      log,
      // ★ 2026-10-16（selfId 迟到收口）：`selfId` 只来自 OneBot 的 HTTP `get_login_info`，
      //   建连那一刻失败时它会是空 —— **发言链本身读活值**（下一轮 compose 读 `platform.selfId` 即可恢复），
      //   但**派生绑定**（`budgetService.configure` 的账号、JEV 判据模型、协调器账号）是注入期算一次。
      //   ⇒ selfId 一旦就绪，重新注入一次 platform：等价于把启动时那段 setPlatform 再跑一遍
      //   （会刷新 JEV 绑定 + 协调器账号；门面语义不变、不绕过任何预算校验）。
      onSelfIdResolved: () => {
        try {
          const facade = createProtocolFacade({ onebot, cfg: ctx.configStore });
          ctx.setPlatform(facade);
          protocolFacade = facade;
          log('[apps/server] selfId 就绪 ⇒ 已重新注入 platform（刷新 JEV/协调器账号绑定）');
        } catch (error) {
          log(`[apps/server] selfId 就绪后重新注入 platform 失败（发言不受影响，账号绑定稍后自愈）：${error?.message ?? error}`);
        }
      }
    });

    // OneBot 建连（失败不静默）
    try {
      onebot.start();
    } catch (e) {
      log(`[apps/server] OneBot 连接失败（继续启动 HTTP）：${e?.message ?? e}`);
    }

    // ★ 把活着的 platform 注入 M15 看到的 modules 命名空间（§3.7 唯一发送出口）。
    //   必须在 start() 之后：client 是在 start() 里创建的。
    //   不注入的话 act.send 每轮都抛 "platform.sendTextBatch 不是可用的公开发送出口"。
    // ★ W1 PART A：platform.call 必须是 WRAPPER（白名单），不是原始 client。
    //   合并两个门面为 createProtocolFacade()（唯一实现，用 onebot.client.call）。
    try {
      const facadePlatform = createProtocolFacade({ onebot, cfg: ctx.configStore });
      ctx.setPlatform(facadePlatform);
      protocolFacade = facadePlatform;  // HTTP 分片读的就是它（:127 的 getter）
      log('[apps/server] 已注入活 platform（W1 白名单 facade）→ M15 发送出口 platform.sendTextBatch 可用');
    } catch (e) {
      log(`[apps/server] 注入活 platform 失败（发送将不可用）：${e?.message ?? e}`);
    }

    // ★ T-SSE-BRIDGE：SSE 桥起订（订 bus 的 6 条冻结事件 + onebot 状态的边沿触发）。
    //   放在 onebot.start() 之后 —— onebot-link 的 `client` 那时才存在（onebot-link.js:130 `get client()`）。
    //   这一步以前**不存在**：这就是"通道活着却一条帧都没有"的另一半原因（另一半是没人往 sseClients 写）。
    sseBridge.start({ onebot });

    // ★ 缺口②「主动性没有发起者」：旧树两套自走循环（`src/orchestrator.js:4847` 提醒 /
    //   `:5132` 主动开话题 + `:5163` 私聊定时）都有各自的 setTimeout；新树把调度权收在
    //   `runtime.onTick(now)` 一处，**由这里唯一一个心跳按时喂时间**（模块不许自己 setTimeout）。
    //   旧树节奏：提醒 20s 一跳、主动 30~90min 一跳、私聊定时 30s 对一次钟
    //   ⇒ 这里 5s 一跳足够准，具体间隔由各模块自己的 nextAt 决定。
    const tickMs = Math.max(1000, Number(ctx.configStore?.get?.('tickIntervalMs', 5000)) || 5000);
    tickTimer = setInterval(() => {
      try { runtime.onTick(Date.now()); }
      catch (e) { log(`[apps/server] onTick 失败：${e?.message ?? e}`); }
      // ★ 2026-10-15（ds3 · 记忆自动整理调度）：记忆自动整理与本地维护走**同一个心跳**，
      //   不是第二个 timer（模块内部自带节流：补发扫描 ≥60s、本地维护到 maintenanceIntervalMs 才跑）。
      //   `memory.consolidateEnabled` 必须显式 true 才会真的排自动整理（默认关，见 memory-maintenance.js）。
      try { ctx.memoryMaintenance?.tick(Date.now()); }
      catch (e) { log(`[apps/server] memoryMaintenance.tick 失败：${e?.message ?? e}`); }
    }, tickMs);
    log(`[apps/server] 心跳已启动：每 ${tickMs}ms 调一次 runtime.onTick()（提醒/主动/定时广播的唯一发起者）`);
    {
      const mm = ctx.memoryMaintenance?.status?.() ?? null;
      log(`[apps/server] 记忆自动整理：${mm?.enabled ? '已启用（opt-in=true）' : '默认关闭（memory.consolidateEnabled 需显式 true）'}；`
        + `限频 ${mm?.minIntervalMs ?? '?'}ms；本地维护间隔 ${mm?.maintenanceIntervalMs ?? '?'}ms`);
    }

    // ── 首屏可取：首个 HTTP 请求（SSE 与一次性响应都算）从监听到被应答的读数 ──
    const noteFirstScreen = () => {
      if (!firstReq.at || firstReq.done) return;
      firstReq.done = true;
      startupPhase = '运行期（首请求已应答）';
      log(`[apps/server] 首屏可取 ${JSON.stringify({
        url: firstReq.url,
        '监听后到达': firstReq.arriveMs - listenMs,
        '应答': Date.now() - firstReq.at,
        '进程起+': sinceProcStart()
      })}`);
    };

    /**
     * 来源闸（与 `api/console.js:100-120` 的「明文密钥端点」同口径，实现留在本文件，不改别人的文件）：
     * 本端点会**代用户**用已保存提供商的密钥发一次出站请求 ⇒ 不许被外部网页冒用浏览器打 127.0.0.1 触发。
     * fail-closed：拿不到 req、来源不是本机控制台 ⇒ 403。
     */
    function judgeModelsOriginAllowed(req) {
      const token = String(ctx.configStore?.get?.('server.token', '') ?? '');
      const headers = req?.headers || {};
      if (token) {
        let searchToken = '';
        try { searchToken = new URL(String(req?.url || '/'), 'http://127.0.0.1').searchParams.get('token') || ''; } catch { searchToken = ''; }
        if (headers['x-console-token'] === token || searchToken === token) return true;
      }
      const host = String(headers.host ?? '');
      const isLoopbackHost = /^127\.0\.0\.1:\d+$/.test(host) || /^localhost:\d+$/.test(host);
      // ★ 2026-10-17（ds1 安全审查 · 与 api/console.js:100 同一处顺序修正）：本机 Host 是前置条件
      //   —— 带自定义头那条不再跳过 Host 校验（DNS rebinding 是同源、无预检，旧顺序挡不住它）。
      if (!isLoopbackHost) return false;
      if (headers['x-console-token']) return true;
      const origin = String(headers.origin ?? '');
      const referer = String(headers.referer ?? '');
      if (origin) return origin === `http://${host}`;
      if (referer) return referer.startsWith(`http://${host}/`);
      return true;
    }

    /**
     * ★ 2026-10-17（用户令 · 云 JEV 判定模型自动拉取）：`POST /api/jev/judge-models {providerId}`。
     *
     * 为什么在 `index.js` 里截住、而不是复用分片那条 `POST /api/providers/fetch-models`：
     *   那条的密钥取自**当前发言配置**（`cfg.api.apiKey`），地址才来自 body ⇒ 用它去取"判定提供商"
     *   的模型目录，会拼出"A 厂地址 + B 厂密钥"（判定提供商自己的密钥在 `dshProviderKeys` 里）。
     *   这里按 **providerId** 从 `llm.currentProviders()`（`providers.js:184` = `withResolvedKey`）
     *   拿**该提供商自己**的 baseUrl 与已解析密钥，密钥只在进程内用：出参、日志都不含它（只回报 hasKey）。
     *
     * 只读：不写回 provider、不改预算/密钥、不动已选判定模型；调用方（UI）负责去重/序号，本端点只做一次取。
     * 失败语义：403 来源不被信任 / 404 提供商不存在 / 400 无地址或未给 id / 501 llm 出口缺 / 502 取列表失败。
     */
    async function handleJevJudgeModels(method, body, req) {
      const json = (status, payload) => ({
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload)
      });
      if (!judgeModelsOriginAllowed(req)) return json(403, { ok: false, error: '请求来源不被信任，已拒绝代发模型目录请求。' });
      if (String(method || '').toUpperCase() !== 'POST') return json(405, { ok: false, error: 'method-not-allowed' });
      const providerId = String(body?.providerId ?? '').trim();
      if (!providerId) return json(400, { ok: false, error: '缺少 providerId' });
      const llm = ctx.modules?.get?.('modules/llm') || ctx.modulesObj?.llm || null;
      if (typeof llm?.fetchModelsFrom !== 'function' || typeof llm?.currentProviders !== 'function') {
        return json(501, { ok: false, error: 'llm 出口缺 fetchModelsFrom/currentProviders' });
      }
      let provider = null;
      try { provider = (llm.currentProviders() || []).find((p) => p && String(p.id) === providerId) || null; }
      catch (error) { return json(500, { ok: false, error: `读提供商目录失败：${String(error?.message ?? error).slice(0, 160)}` }); }
      if (!provider) return json(404, { ok: false, providerId, error: '提供商不存在（已保存列表里没有这个 id）' });
      const baseUrl = String(provider.baseURL ?? provider.baseUrl ?? '').trim();
      if (!baseUrl) return json(400, { ok: false, providerId, error: '该提供商没有地址（baseUrl 为空）' });
      const apiKey = String(provider.apiKey || '');
      try {
        const models = await llm.fetchModelsFrom(baseUrl, apiKey);
        log(`[apps/server] /api/jev/judge-models providerId=${providerId} models=${Array.isArray(models) ? models.length : 0} hasKey=${apiKey ? 'yes' : 'no'}`);
        return json(200, {
          ok: true, providerId, models: Array.isArray(models) ? models : [],
          hasKey: !!apiKey, source: 'llm.fetchModelsFrom'
        });
      } catch (error) {
        return json(502, { ok: false, providerId, hasKey: !!apiKey, error: String(error?.message ?? error).slice(0, 200) });
      }
    }

server = http.createServer((req, res) => {
      if (!firstReq.at) {
        firstReq.at = Date.now();
        firstReq.arriveMs = sinceProcStart();
        firstReq.url = req.url;
      }
      // ── ★ 全局 API 来源闸（2026-10-17 · ds1 安全审查收口，用户授权）────────────
      // 位置即语义：**所有** `/api/**`（含 SSE 与三条明文密钥端点）都在这里、在任何 body 读取之前过一遍。
      // 判据与理由见 `api-gate.js` 文件头；挡的是 DNS rebinding / 跨站简单请求 / 伪自定义头，
      // 放行的是本机 CLI、同源控制台、回环跨端口面板、以及带**匹配 server.token** 的调用（那一条不要求回环）。
      // 先拒 ⇒ 直接 403 + 关连接，绝不把 body 收进内存（`req.resume()` 只丢弃）。
      const apiPathOnly = String(req.url || '/').split('?')[0];
      // ★ 2026-10-17（ds1）：只认 origin-form（`/开头`）。绝对形式（`GET http://host/api/x`，代理形状）、
      //   `OPTIONS *` 这类目标在本服务里既没有路由也没有语义 —— fail-closed 拒掉，别让它绕过来源闸
      //   （`isApiPath('http://…')` 会判 false ⇒ 旧写法会让它绕过闸再落到 404）。
      if (!apiPathOnly.startsWith('/')) {
        denyApiRequest(req, res,
          { ok: false, code: 'bad-request-target', message: '请求目标不是 origin-form（须以 / 开头），已拒绝。' },
          { pathOnly: apiPathOnly.slice(0, 80), method: req.method });
        return;
      }
      if (isApiPath(apiPathOnly)) {
        const verdict = judgeApiRequest(req, { token: readConsoleToken() });
        if (!verdict.ok) {
          denyApiRequest(req, res, verdict, { pathOnly: apiPathOnly, method: req.method });
          return;
        }
      }

      // ── SSE 长连接（/api/events）：不能走 respond() 一次性那条 ──
      // ★ T-SSE-BRIDGE：这段曾经只写一条 hello 就把人加进 `sseClients`，然后**全树再没有一处往里写过东西**
      //   （`sseClients` 只出现在 :43/:131/:132/:133，唯一的 res.write 是 :129 那句 hello）⇒ 通道建好却从未广播。
      //   现在交给 sseHub：帧格式、逐客户端 try/catch（一个坏客户端不许炸主链）、事件名白名单、保活、close 全在里面。
      //   `handle()` 返回 true = 已接管 ⇒ 必须立刻 return，不许再落进一次性响应（那会二次写头）。
      if (sseHub.handle(req, res)) { noteFirstScreen(); return; }

      // ★ N-DELETE-BODY（2026-10-11，sp3 控件全盘扫实测）：DELETE 也要读 body ——
      //   面板的删除按钮历来就是 `DELETE + body` 发参数（app.js:12208/16937、api/media.js 两条），
      //   旧代码只给 POST/PUT 读 body ⇒ 四个删除端点从头到尾收到 null：
      //   删自定义搜索源（api/console.js:925 读 body.id ⇒ 400 缺少 id）、从提供商删模型（:831 ⇒ 404）、
      //   删梗（api/media.js:274）、删图库图（:235）。这是对齐既有契约，不是新造约定。
      // ★ 2026-10-17（import-zip 收口）：原始字节**同时**留一份交给分片 —— `/api/skills/import-zip`
      //   读的从来不是 JSON，旧写法把它 JSON.parse 之后流已排空 ⇒ 该端点恒 400「空的上传体」。
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
        const chunks = [];
        // ★ 2026-10-17（ds1 · 体积边界）：body 收进内存前先限高。两个数都是"没有任何合法调用会碰到"的值：
        //   · import-zip = 20MB，与 `api/shell.js` 的 ZIP_MAX_BYTES 同一个数（分片那边也再核一次）；
        //   · 其余 /api = 64MB —— 面板最大合法载荷是图库导入的文件 dataURL（UI 侧单文件 10MB 上限，base64 ≈ 13.4MB），
        //     主题导入只发文本；六十四兆是给"以后有更大的合法载荷"留的余量，不是给攻击面留的。
        //   超限不再累积（丢弃后续块），收完直接 400 + 关连接。
        const bodyLimit = !isApiPath(apiPathOnly) ? Infinity
          : (apiPathOnly === ZIP_UPLOAD_PATH ? ZIP_UPLOAD_MAX_BYTES : API_BODY_MAX_BYTES);
        let bodySize = 0;
        let oversized = false;
        req.on('data', (c) => {
          bodySize += c.length;
          if (bodySize > bodyLimit) { oversized = true; return; }
          chunks.push(c);
        });
        req.on('end', () => {
          if (oversized) {
            const payload = JSON.stringify({
              ok: false,
              error: bodyLimit === ZIP_UPLOAD_MAX_BYTES
                ? 'ZIP 不能超过 20MB'
                : `请求体超过 ${Math.round(API_BODY_MAX_BYTES / 1024 / 1024)}MB 上限`
            });
            res.writeHead(400, {
              'content-type': 'application/json; charset=utf-8',
              'content-length': String(Buffer.byteLength(payload)),
              connection: 'close'
            });
            res.end(payload);
            return;
          }
          let rawBody = null;
          let body = null;
          try {
            rawBody = Buffer.concat(chunks);
            body = JSON.parse(rawBody.toString('utf8'));
          } catch { body = null; }
          respond(req, res, body, rawBody);
        });
        return;
      }
      respond(req, res, null, null);
    });

    /** 当前配置的控制台令牌（空串 = 未配置）。读不到就按"未配置"处理：`api-gate.js` 仍有回环闸兜着。 */
    function readConsoleToken() {
      try { return String(ctx.configStore?.get?.('server.token', '') ?? ''); } catch { return ''; }
    }

    /** 被来源闸拒绝：403 + 关连接 + 丢弃未读 body。日志有上限，不给刷日志留放大面。 */
    let gateDeniedCount = 0;
    function denyApiRequest(req, res, verdict, { pathOnly = '', method = '' } = {}) {
      const out = denialResponse(verdict, { pathOnly, method });
      gateDeniedCount += 1;
      if (gateDeniedCount <= 20 || gateDeniedCount % 100 === 0) {
        log(`${out.logLine}（本进程累计 ${gateDeniedCount} 次${gateDeniedCount <= 20 ? '' : '，之后每 100 次记一行'}）`);
      }
      try {
        res.writeHead(out.status, out.headers);
        res.end(out.body);
      } catch { /* 对端已断：照样把 body 丢掉 */ }
      try { req.resume(); } catch { /* already ended */ }
    }

    async function respond(req, res, body, rawBody = null) {
      try {
        // ★ handleRequest 现在是 async（分片 `api/*.js` 的 handle 都是 async）⇒ 必须 await；
        //   同时把原始 req/res 传下去（`/api/skills/import-zip` 这类要读原始字节的端点需要）。
        // ★ 2026-10-17（云 JEV 判定模型自动拉取）：这条只读端点在本文件截住（原因见
        //   `handleJevJudgeModels` 的注释：它要按 providerId 解析该提供商**自己**的地址与密钥），
        //   其余 /api/* 一律照旧走通用分发表。
        const result = String(req.url || '').split('?')[0] === '/api/jev/judge-models'
          ? await handleJevJudgeModels(req.method, body, req)
          : await handleRequest(req.method, req.url, body, ctx, { req, res, rawBody });
        let outgoing = result;
        if (req.method === 'GET' && String(req.url || '').split('?')[0] === '/api/status'
          && typeof ctx.vectorEmbeddingStatus === 'function' && typeof result?.body === 'string') {
          try {
            const payload = JSON.parse(result.body);
            const headers = { ...(result.headers || {}) };
            for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-length') delete headers[key];
            outgoing = {
              ...result,
              headers,
              body: JSON.stringify({ ...payload, vectorEmbedding: ctx.vectorEmbeddingStatus() })
            };
          } catch (error) {
            log(`[apps/server] /api/status 附加 M7 状态失败：${error?.message ?? error}`);
          }
        }
        res.writeHead(outgoing.status, outgoing.headers);
        /**
         * 二进制载荷约定（2026-10-05 补，起因：主题族的 `/api/themes/css` 与 `/api/themes/wallpaper`）：
         * 分片可以返回 `{status, headers, body, encoding:'base64'}` —— 那是旧树 `res.writeHead + res.end(binary)`
         * 在新树里的等价形状。**不认这个标记**的后果很隐蔽：浏览器会把 base64 字符当 CSS/图片内容收下
         * （`<link href="/api/themes/css">` 拿到一串 base64 文本 ⇒ 主题样式静默失效）。
         * Buffer 也照收（静态文件那条路本来就可能给 Buffer）。
         */
        if (outgoing.encoding === 'base64') res.end(Buffer.from(String(outgoing.body ?? ''), 'base64'));
        else if (Buffer.isBuffer(outgoing.body)) res.end(outgoing.body);
        else res.end(outgoing.body);
        noteFirstScreen();
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
        noteFirstScreen();
      }
    }

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        listeningPort = server.address().port;
        listenMs = sinceProcStart();
        startupPhase = 'start()收尾（分段/身份记录）';
        server.off('error', reject);
        resolve();
      });
    });

    log(`[apps/server] 已启动 http://127.0.0.1:${listeningPort}/ (dataDir=${resolvedDataDir}, ui=${UI_ROOT})`);
    log(`[apps/server] 启动分段 ${JSON.stringify({
      '进程起→装配': asmBeginMs,
      '装配': asmEndMs - asmBeginMs,
      '装配→start': startBeginMs - asmEndMs,
      'start→监听': listenMs - startBeginMs,
      '进程起→监听': listenMs
    })}`);
    try {
      const configSnapshot = ctx.configStore?.snapshot?.();
      const code = runtimeCodeIdentity();
      const record = {
        event: 'instance-started',
        at: new Date().toISOString(),
        ...code,
        configSource: path.join(resolvedDataDir, 'config.json'),
        configHash: configSnapshot ? sha256(canonicalJson(configSnapshot)) : '',
        dataDir: resolvedDataDir,
        port: listeningPort,
        uiType: /[\\/]refactor[\\/]apps[\\/]ui(?:[\\/]|$)/i.test(UI_ROOT) ? 'refactor' : 'legacy',
        ui: UI_ROOT
      };
      // Snapshot contents (which may include credentials) are hashed in memory and never logged.
      log(`[apps/server] instance-started ${JSON.stringify(record)}`);
    } catch (error) {
      log(`[apps/server] instance-started 记录失败：${String(error?.message ?? error)}`);
    }
    // 真实那次 17s 停摆发生在 instance-started（本行之前）之后 ⇒ 之后的卡顿要么在壳层开窗段、
    // 要么在服务端收尾/运行期 —— 阶段推到这里，下次真启动哨兵报的阶段就能点名归属。
    startupPhase = '壳层段（start 已返回：开窗/托盘/首请求前）';
    return listeningPort;
  }

  async function stop() {
    // 启动停摆哨兵随实例停掉（否则 start 后 90s 内它还在对已停的实例报阶段）
    try { clearInterval(stallSentinel); } catch { /* ignore */ }
    // 先停心跳（缺口②的那个心跳），免得停一半还去唤轮
    try { if (tickTimer) clearInterval(tickTimer); } catch { /* ignore */ }
    tickTimer = null;
    // ★ T-SSE-BRIDGE：SSE 要在 server.close() **之前**收干净。
    //   核对旧 stop() 的结论：**它以前压根不关 SSE** —— 长连接会挂着，进程退不掉、端口也不释放。
    //   顺序：先退订桥（不许停的过程中还有新帧进来）→ 再关 hub（结束所有 res + 清保活定时器）。
    try { sseBridge.stop(); } catch (e) { log(`[apps/server] SSE 桥退订失败：${e?.message ?? e}`); }
    try { sseHub.close(); } catch (e) { log(`[apps/server] SSE 关闭失败：${e?.message ?? e}`); }
    try { onebot?.stop(); } catch { /* ignore */ }
    onebot = null;
    protocolFacade = null;  // HTTP getter 回到 "not running"（不留 facade 包死 client）
    // 情绪状态兜底落盘（每轮回合的 flush 在 M15；这里只兜一次，失败不许静默）
    try {
      const flushed = ctx?.flushEmotionState?.();
      if (flushed && flushed.ok === false) {
        log(`[apps/server] 情绪状态未落盘：${flushed.reason}${flushed.file ? ' file=' + flushed.file : ''}`);
      }
    } catch (e) {
      log(`[apps/server] 情绪状态落盘失败：${e?.message ?? e}`);
    }
    try { await ctx?.stopVectorEmbedding?.(); }
    catch (e) { log(`[apps/server] M7 向量 runtime 停止流程失败：${e?.message ?? e}`); }
    // 人设分界退订（subscribeConfigChange + REGISTRY 移除）。
    // 放在 if (!server) 之前：ctx 在 createServer 期就已建好，无论 start 是否成功都要收。
    // closePersonaBoundary 内部有 closed 幂等保护；失败只记日志、不中断后续清理。
    try {
      const closed = ctx?.closePersonaBoundary?.();
      if (closed && closed.ok === false) {
        log(`[apps/server] 人设分界关闭失败：${closed.reason}`);
      }
    } catch (e) { log(`[apps/server] 人设分界关闭异常：${e?.message ?? e}`); }
    if (!server) return;
    // 放实例锁 + 停心跳（顺序：先停心跳，再放锁，免得刚放掉又被自己续上）
    try { if (lockHeartbeat) clearInterval(lockHeartbeat); } catch { /* ignore */ }
    lockHeartbeat = null;
    try { ctx?.configStore?.releaseInstanceLock?.(); } catch (e) { log(`[apps/server] 释放实例锁失败：${e?.message ?? e}`); }
    await new Promise((resolve) => server.close(resolve));
    server = null;
    listeningPort = 0;
    log('[apps/server] 已停止');
  }

  return {
    start,
    stop,
    get port() { return listeningPort; },
    get dataDir() { return resolvedDataDir; },
    get onebot() { return onebot; },
    ctx,

    // ── 以下两个句柄是**给探针/自测用**的（票面 §1(2) 明确授权的追加，不改既有返回形状）──
    // 为什么需要：不暴露的话，探针只能在"真 HTTP 客户端"与"真 bus"之间做端到端断言这件事上退让
    //   —— 改成读源码比对，而那不算证据。有了 obs，探针才能在**真 bus** 上 emit 一条冻结事件，
    //   看它有没有以映射后的 UI 事件名到达真客户端；有了 sse，才能断言 count()/close()。
    // 语义：只读句柄。**不许**拿它们当业务入口用。
    /** 真 bus（core/observability）句柄：探针用来 emit 冻结事件做端到端断言。给探针/自测用。 */
    get obs() { return ctx.obs; },
    /** 真 SSE 中枢句柄（sse.js）：探针用来断言 count() / close() / broadcast 白名单。给探针/自测用。 */
    get sse() { return sseHub; },
    /** 真 SSE 桥句柄（sse-bridge.js）：探针用来读映射表与统计。给探针/自测用。 */
    get sseBridge() { return sseBridge; },

    /** 创建 M15 运行时（§3.8 createRuntime）。M15 未落地时抛错。 */
    createRuntime() {
      return ctx.createRuntime();
    },

    /**
     * 消息入口：转发给 M15 的 runtime.onInbound(rawBatch)。
     * ★ 与 OneBot 入站、心跳共用**同一个** runtime 实例（以前这里另起了一个，
     *   外部喂进来的消息与 OneBot 收到的不在一个运行时里，突发合并/并发闸都各算各的）。
     * M15 未落地时抛错，不许 stub 成假绿。
     */
    onInbound(rawBatch) {
      if (!runtime) runtime = ctx.createRuntime();
      return runtime.onInbound(rawBatch);
    },

    /** 手动喂一次心跳（旧树 `wake` 的等价入口；测试/排障用）。 */
    onTick(now = Date.now()) {
      if (!runtime) runtime = ctx.createRuntime();
      return runtime.onTick(now);
    },

    /** 取活着的 M15 运行时（未 start 过就是 null —— 不许悄悄造一个假的）。 */
    get runtime() { return runtime; }
  };
}

export { resolveDataDir, UI_ROOT };
