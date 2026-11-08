/**
 * M10 act — 阶段 E：工具注册、筛选、执行、发送和回执核验。
 *
 * 工具实现：
 *   ① 内建工具的实现在 `./executors/*.js`（契约见 `executors/index.js`）——`baseRegistry()` 会把
 *      它们挂到内建工具定义上，所以 `act.run()` 拿到 `tool.execute` 就能跑（2026-10-05 之前：
 *      内置工具除 `send_message` 外**全都执行不了**，每次调用都「未注入 X 执行器」）。
 *   ② 外部仍可用 `ctx.executors[name]` 覆盖/补充（插件与技能走这条路）。
 * 平台发送只调用公开的 SendQueue.sendTextBatch / sendSegments(chatKey, payload, options) 出口。
 * getTool()/listTools() 为 M12 进程内装配层保留 execute；这两个出口只许进程内使用，
 * 不许透给插件沙箱外或任何不经进程边界的调用方。
 */
import { makeIdempotencyKey, makeSendReceipt, validateSendReceipt, TOOL_REJECT_REASONS } from '../../contracts/index.js';
import { log as observabilityLog } from '../../core/observability/index.js';
import { escapeCqText, tidyBrackets, stripEmoji, looksLikeToolArgFragment, looksLikeAiSelfClaim, normalizeMessageList } from '../../core/util/index.js';
import { splitInnerVoice, narrationHit, internalDraftHit, looksLikeSelfDirective, looksLikePlanningMonologue, looksLikeSelfInquiryTail, looksLikeDecisionMonologue } from './inner-voice.js';
import { splitLongGroupBubbles } from './qq-split.js';
import { builtinExecutors } from './executors/index.js';
// ★ T-ACT-FAILCLOSED 附带：公开展示自我印象纯文本变换，供 GET /api/self-impressions 经模块出口取用
//  （apps/server 不许直连 executors/ 内部文件；memory.js 零 import，无循环导入风险）。
export { parseSelfImpressions, renderSelfImpressions, memorySearchBudgetState } from './executors/memory.js';

const toolRegistry = new Map();
// ★ 2026-10-19（S11 收口）：幂等缓存分两层 ——
//   · `idempotency`：**防重标记**（key → { pending } 或 { marker }），在途 Promise 与
//     `state='unknown'` 的写/发送保护**永不因 LRU 淘汰**（删掉会让整轮重试重复外发）；
//   · `idemPayloads`：完整结果载荷，按 LRU 有界（大载荷只留标记，不重复占内存）。
//   旧注释里的“unbounded process-local memory”债务由这两层 + pruneIdemCaches() 收口。
const idempotency = new Map();
const idemPayloads = new Map();
// Confirmed and ambiguous send outcomes are cached only in this process. In particular, an
// accepted platform call whose receipt is lost must stay unknown under this key; deleting it
// would let a whole-turn retry repeat a message that may already be visible.
// M15 synthetic ids must still distinguish separate logical sends.
const sendIdempotency = new Map();
const disabledBuiltIns = new Set();
const undeclaredSideEffects = new Set();
const PROTOCOL_ACTIONS = new Set(['send_poke', 'get_forward_msg', 'get_msg', 'set_group_ban']);

// 容量：标记远大于载荷；「未知/在途」不受上限影响（只在候选里跳过）。
const IDEMPOTENCY_MARKER_MAX = 2048;
const IDEMPOTENCY_PAYLOAD_MAX = 128;
const IDEMPOTENCY_PAYLOAD_MAX_CHARS = 96 * 1024;
const SEND_IDEMPOTENCY_MAX = 1024;

/** 结果 → 小标记（不含大 data；回执保留，重复调用仍可如实记账）。 */
function idemMarkerOf(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    ok: result.ok === true,
    state: result.state == null ? null : String(result.state),
    tool: result.tool == null ? null : String(result.tool),
    reasonCode: result.reasonCode == null ? null : String(result.reasonCode),
    error: result.error == null ? null : String(result.error),
    receipt: result.receipt && typeof result.receipt === 'object' ? result.receipt : null,
    at: Date.now()
  };
}

/** 载荷已被淘汰时的重复调用回执：**不再次执行**，明确说明这是省略了载荷的幂等结果。 */
function idemDuplicateResult(marker, idempotencyKey) {
  const base = marker && typeof marker === 'object' ? marker : {};
  return {
    ok: base.ok === true,
    ...(base.state ? { state: base.state } : {}),
    ...(base.tool ? { tool: base.tool } : {}),
    ...(base.error ? { error: base.error } : {}),
    ...(base.reasonCode ? { reasonCode: base.reasonCode } : {}),
    ...(base.receipt ? { receipt: base.receipt } : {}),
    data: { duplicate: true, note: '重复调用：首次结果载荷已省略（未再次执行）' },
    idempotencyKey
  };
}

function payloadCharsOf(result) {
  try { return JSON.stringify(result)?.length ?? 0; } catch { return Number.POSITIVE_INFINITY; }
}

/** 只缓存“能放下”的完整载荷；超限的由标记单独承担防重（不会因此重放副作用）。 */
function rememberIdemPayload(key, result) {
  if (!result || typeof result !== 'object') return;
  if (payloadCharsOf(result) > IDEMPOTENCY_PAYLOAD_MAX_CHARS) return;
  idemPayloads.delete(key);
  idemPayloads.set(key, result);
}

function touchIdemPayload(key) {
  const value = idemPayloads.get(key);
  if (!value) return null;
  idemPayloads.delete(key);
  idemPayloads.set(key, value);
  return value;
}

/** 清点只影响缓存：不碰账本/历史；未知与在途一律保留。 */
function pruneIdemCaches() {
  while (idemPayloads.size > IDEMPOTENCY_PAYLOAD_MAX) {
    const oldest = idemPayloads.keys().next();
    if (oldest.done) break;
    idemPayloads.delete(oldest.value);
  }
  if (idempotency.size > IDEMPOTENCY_MARKER_MAX) {
    for (const [key, entry] of [...idempotency.entries()]) {
      if (idempotency.size <= IDEMPOTENCY_MARKER_MAX) break;
      if (!entry || entry.pending) continue;                    // 在途永不淘汰
      if (entry.marker?.state === 'unknown') continue;          // 未知写/发送保护永不淘汰
      idempotency.delete(key);
      idemPayloads.delete(key);
    }
  }
  if (sendIdempotency.size > SEND_IDEMPOTENCY_MAX) {
    for (const [key, value] of [...sendIdempotency.entries()]) {
      if (sendIdempotency.size <= SEND_IDEMPOTENCY_MAX) break;
      if (value && typeof value.then === 'function') continue;   // 在途
      if (value?.state === 'unknown') continue;                 // 未知回执永不淘汰
      sendIdempotency.delete(key);
    }
  }
}

const objectSchema = (properties = {}, required = []) => ({
  type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false
});
const string = (description = '') => ({ type: 'string', ...(description ? { description } : {}) });

function mediaToSegments(media = [], messages = [], atUserId = null, chatKey = '') {
  const segments = [];
  for (const message of (Array.isArray(messages) ? messages : [messages])) {
    const text = String(message ?? '');
    if (text.trim()) segments.push({ type: 'text', data: { text: escapeCqText(text) } });
  }
  for (const item of media) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('media 每项必须是对象');
    const type = String(item.type ?? '');
    if (type === 'text') {
      const text = String(item.text ?? item.content ?? '');
      if (!text.trim()) throw new Error('media.text 不能为空');
      segments.push({ type: 'text', data: { text: escapeCqText(text) } });
    } else if (type === 'image' || type === 'sticker') {
      const file = String(item.file ?? item.dataUrl ?? item.url ?? '').trim();
      if (!file) throw new Error(`${type} 媒体必须提供 file、dataUrl 或 url`);
      segments.push({ type: 'image', data: { file } });
    } else if (type === 'music_card') {
      const platform = String(item.platform ?? '163').toLowerCase();
      const songId = String(item.songId ?? item.id ?? '').trim().replace(/[^0-9]/g, '');
      const title = String(item.title ?? '').trim().slice(0, 80) || '音乐分享';
      const artist = String(item.artist ?? item.content ?? '').trim().slice(0, 40);
      const url = String(item.url ?? '').trim();
      const audio = String(item.audio ?? '').trim();
      if (!songId && !(url && audio)) throw new Error('music_card 需要 songId，或同时提供 url 和 audio');
      const textLine = artist ? `${title} - ${artist}` : title;
      segments.push({ type: 'text', data: { text: escapeCqText(`🎵 ${textLine}${url ? `\n${url}` : ''}`) } });
      const data = songId && platform !== 'custom'
        ? { type: platform === 'qq' ? 'qq' : '163', id: songId, title, content: artist }
        : { type: 'custom', url, audio, title, content: artist, image: String(item.image ?? '') };
      segments.push({ type: 'music', data });
    } else if (type === 'bilibili_card') {
      const url = String(item.url ?? '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('bilibili_card 需要 http(s) 视频链接');
      const title = String(item.title ?? 'B站视频').slice(0, 80);
      // ★ 2026-10-19（#8 收口，ds5 交接 A 段）：不再发 QQ 视频 JSON 卡（群里点不开）——
      //   改成「封面图 + 标题链接」。cover 是合法的 OneBot file 形态（`base64://…` 或 http(s)）；
      //   空 cover ⇒ 只发标题+链接，绝不编图。
      const cover = String(item.cover ?? '').trim().replace(/^http:/i, 'https:');
      if (cover) segments.push({ type: 'image', data: { file: cover } });
      segments.push({ type: 'text', data: { text: escapeCqText(`${title}\n${url}`) } });
    } else {
      throw new Error(`不支持的媒体段类型：${type || '(空)'}`);
    }
  }
  if (String(chatKey).startsWith('group:') && atUserId != null && String(atUserId).trim()) {
    segments.unshift({ type: 'at', data: { qq: String(atUserId).trim() } });
  }
  return segments;
}

const BUILT_INS = [
  {
    name: 'get_recent_messages', category: 'query', sideEffect: 'read',
    parameters: objectSchema({ limit: { type: 'integer', minimum: 1, maximum: 50 } }),
    purpose: ['lookup', 'history', 'context']
  },
  {
    name: 'get_message_detail', category: 'query', sideEffect: 'read',
    parameters: objectSchema({ messageId: string('目标消息 ID') }, ['messageId']),
    purpose: ['lookup', 'history', 'context']
  },
  {
    name: 'web_search', category: 'web', sideEffect: 'read', requiresSearch: true,
    parameters: objectSchema({ query: string('搜索关键词') }, ['query']),
    purpose: ['lookup', 'search', 'research']
  },
  {
    name: 'memory_query', category: 'memory', sideEffect: 'read',
    description: '查已经记下的印象/观察（不是翻原始聊天，翻聊天用 memory_search）。可按话题或 QQ 号筛。'
      + '★ 本轮相关的人（含当前说话人）的印象会**自动注入**，不需要每轮先查一遍；只在需要查"某个人/某件事"时才用。'
      + '已删除/已撤回的内容查不到（没有就是没有，别换入口硬搜）。'
      + '★ 它与 memory_search / memory_archive **共用同一个次数上限**（一条消息内合计，不是各算各的）⇒ 用完会被直接拒，'
      + '那时照实说没查到就行，别换个入口接着搜、更别编。',
    parameters: objectSchema({
      userId: { type: ['integer', 'string'], description: '可选：只查这个 QQ 号对应的主体记忆' },
      query: string('可选：按话题筛选记忆')
    }),
    purpose: ['memory', 'context', 'lookup']
  },
  {
    name: 'send_message', category: 'messaging', sideEffect: 'write',
    permission: 'tools.overrides.send_message', defaultEnabled: false,
    description: '传字符串发送一条消息；传数组时，每个字符串分别发送一条消息。'
      + '★ 这里的每一条都会**原样发到当前会话、对方直接看得到**：只放要对对方说的话；'
      + '心里话、给自己的指示、对别人行为的评述都别写进来（那些写正文或 finish.summary，不会发出去）。',
    parameters: objectSchema({
      messages: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: '要**对外说**的话，可与 media 同包发送；只放会对对方说出口的句子。草稿、思路、"消息组织："这类写给自己的计划内容别放进来（那些写正文或 finish.summary，不会发出去）' },
      media: { type: 'array', description: '图片/表情/卡片走这个字段；支持 image、sticker、bilibili_card、music_card，也可包含 text 段', items: {
        type: 'object', properties: {
          type: { type: 'string', enum: ['image', 'sticker', 'bilibili_card', 'music_card', 'text'] },
          file: string(), dataUrl: string(), url: string(), stickerId: string(), title: string(), desc: string(), cover: string(),
          songId: string(), platform: string(), artist: string(), content: string(), audio: string(), image: string(), text: string()
        }, required: ['type'], additionalProperties: false
      } },
      replyToMessageId: {
        type: ['integer', 'string'],
        description: '可选：要引用哪条消息。填聊天记录里那条前面的 #短编号（带 # 或只写数字都算同一条）；'
          + '要引用已经翻出窗口的老消息也可以填 QQ 原始消息 id（8 位以上，可能带负号）。'
          + '★ 这两种之外的编号在本会话查不到 ⇒ 这条消息照样发出去，但引用挂不上（结果里会告你没挂上）。不引用就别填。'
      },
      atUserId: { type: ['integer', 'string'] }
    }),
    purpose: ['reply', 'chat', 'conversation']
  },
  {
    name: 'memory_append', category: 'memory', sideEffect: 'write',
    permission: 'tools.overrides.memory_append', defaultEnabled: false,
    description: '记录一条有本轮原始证据支持的群友印象。confidence 必填；不能把模型自己的推断当作对方发言。',
    parameters: objectSchema({
      category: { type: 'string', enum: ['memberImpression'], description: '固定填 memberImpression' },
      userId: { type: ['integer', 'string'], description: '对方 QQ 号' },
      target: { type: 'string', description: '可选备注昵称；不能替代 userId' },
      content: { type: 'string', description: '印象内容，≤80字' },
      type: { type: 'string', enum: ['identity', 'preference', 'edge', 'style', 'event', 'attitude'] },
      confidence: { type: 'number', minimum: 0, maximum: 1, description: '对该记忆的置信度，0~1；必填' },
      // 2026-10-11 功能表 5 · P0-1（窄授权：只加这一个可选键，required 不动）：
      // 改口/更正必须能"取代旧的那张卡"，否则更正只是**并列**的一条新卡 —— 旧说法照样在场，
      // 提示词里旧新打架。契约层本来就有 supersedes（contracts `validateMemoryObservation:436` 允许可选
      // 字符串；store.js:347-362 已实现按它升版本），缺的只是把参数从模型侧通到执行器。
      supersedes: {
        type: 'string',
        description: '更正/改口时填：要被这条**取代**的旧记忆 —— 旧记忆原文（逐字），或 memory_query/history 带回的观察 id。'
          + '不填 = 新事实，不取代任何旧卡。'
      }
    }, ['category', 'userId', 'content', 'confidence']),
    purpose: ['memory-write', 'memory']
  },
  {
    name: 'memory_favor', category: 'memory', sideEffect: 'write',
    permission: 'tools.overrides.memory_favor', defaultEnabled: false,
    parameters: objectSchema({
      userId: { type: ['integer', 'string'], description: '对方 QQ 号' },
      delta: { type: 'integer', minimum: -10, maximum: 10, description: '变化量；省略时只查看' },
      // ★★ B10（2026-10-11 用户裁定）：好感**改回老树语义** —— 撤掉类别门槛与"永不计分语"。
      //   改前两样东西在**这一行**里：`maxLength: 30`（长理由被 `:447` 的通用校验当场判"长度大于 30"
      //   ⇒ 参数层就在拦）+ "要能归到七类 / 顶嘴反对拒绝被纠正不计分"（教模型把评价写成合规短语）。
      //   实测两次理由被拦（"本人自愿当实验品"、"本人主动申报自己是麻烦精"）⇒ 用户判："这叫服从度。
      //   好感就是 LLM 自己决定的，他有权决定自己对谁好对谁坏。"⇒ 理由**自由文本、原样传**，
      //   涨跌方向与幅度**听模型的 delta**；`executors/memory.js` 那边配套改成不拦、不截、不改写。
      reason: { type: 'string', description: '更新时照实写下你自己的判断就行 —— 不要求字数、不要求格式，也不必归进任何类别；只读查看时省略。★ 这是你对这个人的评价，不是走流程：吵架、争执、意见不同本来就会掉好感，被真心夸、被实际帮忙本来就会涨，涨跌方向和幅度都由你定。' }
    }, ['userId']),
    purpose: ['memory-write', 'memory']
  },
  {
    name: 'memory_archive', category: 'memory', sideEffect: 'write',
    permission: 'tools.overrides.memory_archive', defaultEnabled: false,
    // 2026-10-09 N35：description / offset / query 照老树 src/tools.js:2974-2988 补齐。
    // ★ 缺 query 是硬伤：执行器里 mode=count 没 query 直接拒（老树同口径），
    //   参数表却不声明 ⇒ 模型永远凑不出合法的 count 调用。offset 同理（翻页全靠它）。
    description: '聊天归档。list=会话列表(可all); day/hours/count/load 需 chatKey。与 memory_search 共用单次运行检索上限，超限拒绝。',
    parameters: objectSchema({
      mode: { type: 'string', enum: ['list', 'day', 'range', 'count', 'hours'] },
      chatKey: { type: 'string', description: 'group:xxx / private:xxx；不填=当前会话；list 可 all=true' },
      all: { type: 'boolean', description: 'list/count 时扫全部会话' },
      day: { type: 'string', description: 'YYYY-MM-DD' },
      hour: { type: 'string', description: 'YYYY-MM-DD HH' },
      dayFrom: { type: 'string' },
      dayTo: { type: 'string' },
      offset: { type: 'integer', description: '翻页起点；结果尾行会给出 nextOffset' },
      limit: { type: 'integer', minimum: 5, maximum: 40 },
      query: { type: 'string', description: 'count 必填' }
    }, ['mode']),
    purpose: ['memory-write', 'memory']
  },
  {
    name: 'send_poke', category: 'messaging', sideEffect: 'write', permission: 'tools.overrides.send_poke',
    description: '拍一拍（群聊传 targetUserId；私聊默认拍对方）。targetUserId 必须是数字 QQ 号：不知道对方 QQ 号时，先调 get_active_members 或 get_recent_messages 查到再拍，绝对不要传名字、昵称或"未知"。适合用"戳一下"代替一句废话、回应别人的拍一拍，或偶尔逗一下正在聊的人。别频繁。',
    parameters: objectSchema({ targetUserId: { type: ['integer', 'string'], description: '要拍的群友 QQ 号（数字，群聊必填；不知道就先查 get_active_members）' } }),
    purpose: ['reply', 'chat']
  },
  {
    name: 'mute_member', category: 'messaging', sideEffect: 'write', permission: 'tools.overrides.mute_member',
    // ★ 2026-10-28（她要的）：群禁言。走的是 M10 的 callProtocol 受控出口（白名单含 set_group_ban），
    //   不是 send()，所以没有 SendReceipt —— 结果如实写 protocol-ok，不假装有投递回执。
    description: '禁言一个群成员（需要机器人自己在群里是管理员）。userId 必须是数字 QQ 号：不知道就先 get_active_members 或 get_recent_messages 查到，绝不要传昵称。seconds 默认 600，0 = 解除禁言，最长 2592000（30 天）。它只改禁言状态，不发送任何消息 —— 需要说一句"禁了"就另外用 send_message。禁言理由/时长规矩由她定，拿不准就先问、别自己决定长期限。',
    parameters: objectSchema({
      userId: { type: ['integer', 'string'], description: '要禁言的人的数字 QQ 号（必填，不知道就先查 get_active_members）' },
      seconds: { type: 'integer', minimum: 0, maximum: 2592000, description: '禁言秒数，默认 600（10 分钟）；0 = 解除禁言；上限 2592000（30 天）' },
      groupId: { type: ['integer', 'string'], description: '可选：群号；默认就是当前群' }
    }, ['userId']),
    purpose: ['reply', 'chat']
  },
  {
    name: 'send_forward', category: 'messaging', sideEffect: 'write', permission: 'tools.overrides.send_forward',
    // ★ 2026-10-10 N48（用户批准放开）：以前这份说明写着"只整理、不发送"，现在真能投出去了，
    //   但投出去的是**一条文字消息**，不是协议端的合并转发卡片（卡片要 platform.sendForward，
    //   活门面没暴露它），也**不能发到别的会话** ⇒ 两条都写进说明，别让文档教模型调不存在的能力。
    description: '把聊天记录整理成一条文字消息发到**当前会话**（一行一条，最多 20 条）。⚠️ 这不是"合并转发卡片"（协议端那条出口尚未接通），也发不到别的会话。内容照过 send_message 的发出前守卫，拿到平台回执才算发出。',
    parameters: objectSchema({
      nodes: { type: 'array', description: '节点列表；与 fromArchive 二选一', items: { type: 'object', properties: { name: string(), uin: { type: ['string', 'integer'] }, content: string() }, required: ['content'] } },
      fromArchive: { type: 'boolean', description: 'true=从存档打包' },
      sourceChatKey: { type: 'string', description: '从哪个会话取存档，默认当前会话' },
      query: { type: 'string', description: 'fromArchive 时可选过滤关键词' },
      limit: { type: 'integer', description: 'fromArchive 时取最近多少条，默认 10，最大 20' },
      replyToMessageId: { type: ['integer', 'string'] }
    }),
    purpose: ['reply', 'chat']
  },
  {
    name: 'read_forward', category: 'messaging', sideEffect: 'write', permission: 'tools.overrides.read_forward',
    description: '展开合并转发聊天记录。文本是 [合并转发聊天记录] 占位时用；已是 [合并转发 共N条] 则直接读存档。旧实现会写回存档并进入长期记忆索引；当前执行器只返回展开内容。',
    parameters: objectSchema({ messageId: { type: ['integer', 'string'], description: '转发消息自己的 QQ 消息 id（聊天记录里的 #数字，可能为负数）' } }, ['messageId']),
    purpose: ['lookup', 'history', 'context']
  },
  {
    name: 'report_feedback', category: 'messaging', sideEffect: 'write', permission: 'tools.overrides.report_feedback',
    description: '向管理员（控制台）反馈你遇到的问题、困惑或需要人工介入的情况。不要用于聊天。',
    parameters: objectSchema({ level: { type: 'string', enum: ['info', 'warning', 'error'] }, message: string() }, ['message']),
    purpose: ['feedback']
  },
  {
    name: 'switch_back', category: 'messaging', sideEffect: 'write', permission: 'tools.overrides.switch_back',
    description: '请求在本轮收尾后切回常态人格；本工具只记录待退出意图，不声称已立即切换。',
    parameters: objectSchema({}), purpose: ['reply', 'chat']
  },
  {
    name: 'switch_in', category: 'messaging', sideEffect: 'write', permission: 'tools.overrides.switch_in',
    description: '请求切到第二人格（红）。你自己觉得该你上了就调——不用解释、不用告别。调了先掷骰：成不成看返回，没成保持现状、下一轮可以再试；成了也是下一轮生效（这一轮仍由当前人格说完）。与 switch_back 完全对称：两个方向都由你触发、都要掷骰，系统没有任何自动切换。',
    parameters: objectSchema({}), purpose: ['reply', 'chat']
  },
  {
    name: 'finish', category: 'messaging', sideEffect: 'write', permission: 'tools.overrides.finish',
    description: '收尾 + 自评。**它本身不负责发消息**；要对人说的话必须先用 send_message（正文不会自动发送）。已有成功发送后再调 finish，并尽量与 send_message 放在同一批。只调 finish 且本轮仍要求回复时，系统最多再给一次只开放 send_message/finish 的收口机会；静默或本轮无需回复时可只调 finish。summary 尽量填，mood 与 favorDelta 可选；writeMemory 默认 false。这一轮没什么变化也可空参调用。',
    parameters: objectSchema({
      summary: { type: 'string', description: '尽量填。一句话记清这轮：对方说了啥、你怎么回的（例：「他问是不是AI，我玩笑说是小鲸鱼」）。不要写工具报错。' },
      mood: { type: 'string', enum: ['闲聊', '被点名', '被夸', '被怼', '真生气', '玩闹', '接梗', '求助', '分享', '吐槽', '带节奏', '刷屏', '被冷落', '好奇', '出丑', '比较', '独处', '恶心', '内疚', '惊讶', '恐惧', '悲伤', '紧张', '无聊', '期待', '感激', '无事发生'], description: '可选。有明显情绪就标，别只会闲聊/无事发生/玩闹。难过→悲伤；怕→恐惧；酸/比下去→比较；孤单→独处；自责→内疚；谢谢→感激；等结果→期待；惊→惊讶；慌→紧张；腻→无聊；反胃→恶心。' },
      // ★★ B10（2026-10-11 用户裁定）：`favorDelta` 的理由就是 `summary` 原话 —— 不再要求"能归进七类"。
      //   改前这句尾巴写着"归不进不落账，改用 memory_favor 带可归类理由"⇒ 等于教模型**换成合规短语**，
      //   而不是说自己在想什么（同上一行 `memory_favor.reason` 的病）。争执/被怼**本来就掉好感**。
      favorDelta: { type: 'integer', description: '可选。对本轮主要说话的人好感变化：被真心夸/帮忙 +3~+8；被怼、争执、意见不同 -3~-8；平常 0 或不填。单次绝对值 ≤8。落账理由取 summary —— 照实写你的判断就行，不要求字数、不要求格式、不必归进任何类别；方向与幅度都听你这个 delta。' },
      writeMemory: { type: 'boolean', default: false, description: '本条是否值得写入长期记忆/印象。true 表示把本轮自评作为长期印象候选交给 M15；false 或省略均为不写，默认 false。它会按本轮证据校验，并与同轮 memory_append 的相同内容去重；本工具本身不直接写记忆。' }
    }), purpose: ['finish']
  },
  {
    name: 'send_image', category: 'media', sideEffect: 'write', permission: 'tools.overrides.send_image',
    description: '把一张网图发到当前会话（独立气泡）。url 必须是图片直链（http/https，png/jpg/gif/webp）——网页地址不行：先 web_fetch 抓那页，再从返回的 images 里挑一条直链。默认要求先看一眼（先 send_image(url, preview=true) 看一眼再发），但浏览锁定站点内的图可以直接发。一次处理最多发 2 张。**正式发送的调用即发送（preview=true 除外）**，不用自己再转发一次；是否真的发出去看结果里的 deliveryState（delivered 才算投递成功，unknown / not_deliverable 都不算）。',
    parameters: objectSchema({ url: { type: 'string', description: '图片直链（http/https，png/jpg/gif/webp）' }, preview: { type: 'boolean', description: 'true = 只下载给自己看一眼，不发送（发图前默认要先看一眼）' }, note: { type: 'string', description: '可选：一句话说明这张图是什么（只进存档）' }, replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用哪条消息（聊天记录里那条前面的 #短编号，如 #318）' }, atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' } }, ['url']),
    purpose: ['reply', 'chat']
  },
  {
    name: 'send_sticker', category: 'media', sideEffect: 'write', permission: 'tools.overrides.send_sticker',
    description: '发送一个 QQ 收藏表情（一条消息只能一张表情，不能附带文字；想说的话先用 send_message 单独发一条）。stickerId 必须是 list_stickers 返回的 id（一长串字符，形如 collected_123 或 1927…_0_0；不是备注文字，也不是 QQ 面板小数字）。**调用即发送**，不用自己再转发；是否真的发出去看结果里的 deliveryState（delivered 才算投递成功，unknown / not_deliverable 都不算）。',
    parameters: objectSchema({ stickerId: { type: 'string', description: '表情 id（list_stickers 返回的 id 字段，照抄不要改）' }, replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用哪条消息（聊天记录里那条前面的 #短编号，如 #318）' }, atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' } }, ['stickerId']),
    purpose: ['reply', 'chat']
  },
  {
    name: 'collect_sticker', category: 'media', sideEffect: 'write', permission: 'tools.overrides.collect_sticker',
    description: '把新鲜、确实有机会以后接梗复用的表情/梗图主动收藏到本地库；不是每轮都收，也不用等管理员提醒。当前触发图已自动附给你时，直接填【本次唤醒】中的 #短编号；更早的图片先读取确认。普通照片、隐私图或无复用价值的截图不收。备注写清可见动作/画面和醒目梗字，不要把水印当出处。',
    parameters: objectSchema({ messageId: { type: ['integer', 'string'], description: '那条消息的 QQ 消息 id（聊天记录里的 #数字）' }, note: { type: 'string', description: '简短写清可见主体/动作和可读梗字；水印、logo 不当作出处或画面情节。' } }, ['messageId', 'note']),
    purpose: ['memory-write', 'memory']
  },
  {
    name: 'list_stickers', category: 'media', sideEffect: 'read',
    description: '查看/搜索你的 QQ 收藏表情（含备注和你的本地笔记）。返回的 id 就是要填给 send_sticker / get_sticker_image 的 stickerId（照抄，别改别编）。',
    parameters: objectSchema({ query: { type: 'string', description: '可选搜索词，匹配备注/笔记/标签' }, limit: { type: 'integer', description: '最多返回条数，默认 24' }}),
    purpose: ['lookup', 'context']
  },
  {
    name: 'get_sticker_image', category: 'media', sideEffect: 'read', requiresVision: true,
    description: '查看一个没有备注/不确定含义的表情的图片（视觉模型可直接"看懂"）。',
    parameters: objectSchema({ stickerId: { type: 'string', description: '表情 id' } }, ['stickerId']),
    purpose: ['lookup', 'context']
  },
  {
    name: 'sticker_note', category: 'media', sideEffect: 'write', permission: 'tools.overrides.sticker_note',
    description: '给一个表情记下你的理解（含义/用法/标签），下次能更准地选用。',
    parameters: objectSchema({ stickerId: string(), note: { type: 'string', description: '你的理解/含义' }, tags: { type: 'array', items: { type: 'string' }, description: '标签列表（可选）' }, usage: { type: 'string', description: '适用场景（可选）' } }, ['stickerId', 'note']),
    purpose: ['memory-write', 'memory']
  },
  {
    name: 'image_lib_search', category: 'media', sideEffect: 'read',
    description: '搜本地图库（和表情包库分开）。category=self 是自己的形象/人设图；也可按标签/备注搜。命中后用 image_lib_send 发（它调用即发送）。',
    parameters: objectSchema({ query: { type: 'string', description: '关键词：形象/自拍/梗图名等' }, category: { type: 'string', enum: ['self', 'meme', 'art', 'other'], description: '可选分类过滤' }, limit: { type: 'integer', description: '默认 6' } }),
    purpose: ['lookup', 'context']
  },
  {
    name: 'image_lib_send', category: 'media', sideEffect: 'write', permission: 'tools.overrides.image_lib_send',
    description: '把图库里的图发到当前会话。传 imageId（来自 image_lib_search）。要「发我的图/形象照」先 image_lib_search(category=self) 再 send。**调用即发送**，不用自己再转发；是否真的发出去看结果里的 deliveryState（delivered 才算投递成功，unknown / not_deliverable 都不算）。',
    parameters: objectSchema({ imageId: { type: 'string', description: '图库 id' }, replyToMessageId: { type: ['integer', 'string'] } }, ['imageId']),
    purpose: ['reply', 'chat']
  },
  {
    name: 'search_images', category: 'media', sideEffect: 'read', requiresSearch: true,
    description: '搜网图，直接拿到"能发的图片直链"。用法：先 search_images("关键词") 看列表，再挑标题最贴切的一条用 send_image(url) 发出去（一张图一条气泡）。被要求"发张图 / 来点表情 / 发个自拍 / 给我看看"时就用它 —— 不要只说"我没有图"。不要默认总挑第 1 条。',
    parameters: objectSchema({ query: { type: 'string', description: '想搜的画面，用具体名词更好搜（例如"猫 表情包 gif""Q版 蓝发 女孩 插画""摸鱼 表情包"）。别塞整句寒暄。' }, limit: { type: 'integer', description: '可选：最多返回几条（默认 8，上限 12）' } }, ['query']),
    purpose: ['search', 'lookup']
  },
  {
    name: 'identify_image', category: 'media', sideEffect: 'read', requiresVision: true, requiresSearch: true,
    description: '以图搜图认人/认角色：把图丢给反查（IQDB等）找出处和标题。认不出就说不确定，别硬编；搜到可以接话，不要对着图做长篇点评。',
    parameters: objectSchema({ messageId: { type: ['integer', 'string'], description: '聊天记录 #数字' }, stickerId: { type: 'string', description: '表情库 id' }, url: { type: 'string', description: '图片直链（有则优先，省上传）' }, webSearch: { type: 'boolean', description: '反查后再 web_search 核实标题（默认 true）' } }),
    purpose: ['lookup', 'search']
  },
  {
    name: 'get_message_images', category: 'media', sideEffect: 'read', requiresVision: true,
    description: '查看某条消息里的图片/表情（视觉模型可以直接看懂）。消息文本出现 [图片] 时可用。'
      + '要填的是本轮聊天记录里**那条消息前面的 #短编号**（照抄，# 可省）；记录里没出现过的编号不要调，先看 get_recent_messages。',
    parameters: objectSchema({ messageId: { type: ['integer', 'string'], description: '照抄聊天记录里那条消息前的 #短编号（# 可省）。这不是 QQ 消息号：别自己拼数字，别填长串或负数，也别用记忆里记住的那个 id' } }, ['messageId']),
    purpose: ['lookup', 'context']
  },
  {
    name: 'parse_video', category: 'media', sideEffect: 'read', requiresSearch: true,
    description: '总结 B 站视频内容。优先字幕；其次官方AI总结/热评/简介；可选抽帧视觉。丢 bilibili.com/video 或 b23.tv、问讲了啥时用。别编台词。',
    parameters: objectSchema({ url: { type: 'string', description: 'B 站视频链接（或裸 BV/av 号）' }, includeRaw: { type: 'boolean', description: '默认 false。true 时附带截断字幕（费 token，一般不用）' }, useFrames: { type: 'boolean', description: '默认 false。true 时若无字幕且本机有 ffmpeg+视觉模型，则抽帧看画面总结（更慢更贵）' } }, ['url']),
    purpose: ['search', 'lookup']
  },
  {
    name: 'memory_search', category: 'memory', sideEffect: 'read',
    description: '搜以前的聊天。默认先搜当前会话，不够再翻私聊/其它群。结果会标【当前会话】【私聊】【群】。query 带时间词（昨天/中午）更好。'
      + '★ 它与 memory_query / memory_archive 共用同一个次数上限（一条消息内合计）⇒ 被拒就是这轮搜完了，照实说想不起来，别编。',
    parameters: objectSchema({ query: { type: 'string', description: '关键词，含时间+事件更好，如「昨天中午 猪脚饭」' }, limit: { type: 'integer', description: '最多命中块，默认 4' }, all: { type: 'boolean', description: 'true=跳过「先当前会话」直接全库搜' } }, ['query']),
    purpose: ['memory', 'context', 'lookup']
  },
  {
    name: 'memory_remove', category: 'memory', sideEffect: 'write', permission: 'tools.overrides.memory_remove',
    description: '撤回过时/错误的群友记忆。M6 按 QQ 号定位；优先传 userId+content 撤回一条，不传 content 撤回该人的当前记忆。',
    parameters: objectSchema({ category: { type: 'string', enum: ['memberImpression'] }, userId: { type: ['integer', 'string'], description: '对方 QQ 号；M6 必填' }, target: { type: 'string', description: '可选备注，仅用于错误提示' }, content: { type: 'string', description: '可选：只撤回这条内容' } }, ['category', 'userId']),
    purpose: ['memory-write', 'memory']
  },
  {
    name: 'memory_meme_save', category: 'memory', sideEffect: 'write', permission: 'tools.overrides.memory_meme_save',
    description: '存一条梗/口头禅/内部笑话/可复用结论到本地知识库（≤60字）。群里形成的新梗、反复玩笑、值得以后复用的结论才存；普通闲聊别存。约30天没再触发会自动清掉。',
    parameters: objectSchema({ text: { type: 'string', description: '梗/结论原文，≤60字' }, tags: { type: 'array', items: { type: 'string' }, description: '可选标签' }, note: { type: 'string', description: '可选：怎么用/出处' } }, ['text']),
    purpose: ['memory-write', 'memory']
  },
  {
    name: 'memory_meme_search', category: 'memory', sideEffect: 'read',
    description: '在梗库里搜梗（按需，平常别调）。聊到可能相关的梗、别人玩老梗时用。有 memes 才用，没有就说没有。',
    parameters: objectSchema({ query: { type: 'string', description: '关键词或梗片段' }, limit: { type: 'integer', description: '默认 4' } }, ['query']),
    purpose: ['memory', 'context']
  },
  {
    name: 'memory_todo_save', category: 'memory', sideEffect: 'write', permission: 'tools.overrides.memory_todo_save',
    description: '存一条未完待办，expireInMinutes 由你定（如 30/120/1440=1天）。到点自动过期不再提醒。只记「接下来要办的事」，别存闲聊。',
    parameters: objectSchema({ text: { type: 'string', description: '待办，≤80字' }, expireInMinutes: { type: 'integer', description: '多久后忘掉，默认 120' }, userId: { type: ['integer', 'string'], description: '绑定谁的 QQ 号；对方下次出现时才会提醒' }, note: { type: 'string', description: '可选备注' } }, ['text']),
    purpose: ['memory-write', 'memory']
  },
  {
    name: 'memory_todo_done', category: 'memory', sideEffect: 'write', permission: 'tools.overrides.memory_todo_done',
    description: '划掉一条待办（办完了/不做了）。按 text 关键句匹配。',
    parameters: objectSchema({ text: { type: 'string', description: '待办原文或其中一段' } }, ['text']),
    purpose: ['memory-write', 'memory']
  },
  {
    name: 'remember_self_impression', category: 'memory', sideEffect: 'write', permission: 'tools.overrides.remember_self_impression',
    description: '记录【你自己】的自我印象（自我认知、风格、偏好、习惯）。写给自己看的备忘，会融入你的人设系统。重要身份区分：这是记录【你自己】的印象，不是记录群友；记录群友印象用 memory_append；记录你自己用本工具。限制：每条最多 160 字符，最多保留 8 条，超过时需先清理旧的；会触发完整人设重写（比普通印象重）。',
    parameters: objectSchema({ content: { type: 'string', description: '自我印象内容（160 字符内，例如：「推歌优先推摇滚」「被夸聪明时要嘴硬」）' } }, ['content']),
    purpose: ['memory-write', 'memory']
  },
  {
    name: 'get_active_members', category: 'query', sideEffect: 'read',
    description: '查看当前会话最近活跃的成员（QQ 号、名字、最近发言时间、发言数），用于 @ 或拍一拍时找人。',
    parameters: objectSchema({ limit: { type: 'integer', description: '默认 10，最大 20' } }),
    purpose: ['lookup', 'context']
  },
  {
    name: 'web_fetch', category: 'web', sideEffect: 'read', requiresSearch: true,
    description: '只读抓取网页正文（默认 ≤8000 字符，设置里可调；同一次处理里重复抓同一页只返回一次）。群友发来链接问"写了什么"时直接抓；配合 web_search 阅读搜索结果的详细内容。返回的 images 是这一页里的图片直链（可直接喂给 send_image 发图，它调用即发送）。禁止访问内网/本机地址；开了浏览锁定后只能抓锁定站点。',
    parameters: objectSchema({ url: { type: 'string', description: '要抓取的 http(s) URL' } }, ['url']),
    purpose: ['search', 'lookup']
  },
  {
    name: 'external_lookup', category: 'web', sideEffect: 'read', requiresSearch: true,
    description: '查外部百科/设定（萌娘、维基等管理员配置的 wiki 源）。角色/作品/出处不确定时用。实时新闻/新梗仍用 web_search。别把百科原文当群梗存进内部库。',
    parameters: objectSchema({ query: { type: 'string', description: '页面名或关键词，如「博丽灵梦」「东方Project」' }, source: { type: 'string', description: '可选：moegirl / wikipedia / all / 自定义 id' }, limit: { type: 'integer', description: '默认 2' } }, ['query']),
    purpose: ['search', 'lookup']
  },
  {
    name: 'search_music', category: 'music', sideEffect: 'read', requiresSearch: true,
    description: '搜网易云候选（不发送）。类型词（古典/摇滚/OST）会自动扩写成具体曲目；「随机」返回一组不同候选。拿到 id 后 send_music(songId=…)。',
    parameters: objectSchema({ query: { type: 'string', description: '歌名/歌手，或类型词，或「随机」' }, limit: { type: 'integer', description: '默认 6' } }, ['query']),
    purpose: ['search', 'lookup']
  },
  {
    name: 'send_music', category: 'music', sideEffect: 'write', permission: 'tools.overrides.send_music', requiresSearch: true,
    description: '发网易云音乐卡片。query=具体歌名（可加歌手）自动搜出卡；query=随机/古典/摇滚/OST 会自动扩写挑选并避开最近发过的；或 musicUrl / songId。多首分多次调用。**调用即发送**，不用自己再转发；是否真的发出去看结果里的 deliveryState（delivered 才算投递成功，unknown / not_deliverable 都不算）。注意：音乐卡不支持引用；传入 replyToMessageId 会被丢弃并在结果中说明。想配一句话就在**同一次调用里**一起调 send_message（引用加在它身上）+ send_music，别分两轮。',
    parameters: objectSchema({ query: { type: 'string', description: '歌名或「歌名 歌手」；也可填「随机」或「古典/摇滚/OST…」让系统扩写挑选并避重。' }, musicUrl: { type: 'string', description: '已有网易云链接时用，如 https://music.163.com/#/song?id=186016' }, songId: { type: ['integer', 'string'], description: '歌曲数字 id' }, title: { type: 'string', description: '可选：覆盖卡片标题' }, artist: { type: 'string', description: '可选：覆盖歌手名' }, replyToMessageId: { type: ['integer', 'string'], description: '可选兼容字段；音乐卡不支持引用，传入会被丢弃并在结果中说明。' } }),
    purpose: ['reply', 'chat']
  },
  {
    name: 'search_bilibili', category: 'web', sideEffect: 'read', requiresSearch: true,
    description: '在 B 站搜视频（不发送）。拿到 bvid/url 后用 send_bilibili 转发到群里。用户说「搜个 XX 视频发我/发群里」时先搜再转。',
    parameters: objectSchema({ query: { type: 'string', description: '搜索关键词，如「深海 电影解说」「摸鱼 日常」' }, limit: { type: 'integer', description: '最多返回几条，默认 8，上限 20' } }, ['query']),
    purpose: ['search', 'lookup']
  },
  {
    name: 'list_bili_fav', category: 'web', sideEffect: 'read', requiresSearch: true,
    description: '列出管理员指定的 B 站收藏夹（默认「小鲸鱼专用」）里的视频。只从这个夹转发，不要翻其它夹。拿到 url 后 send_bilibili。需已登录 Cookie。',
    parameters: objectSchema({ mediaId: { type: ['integer', 'string'], description: '可选：覆盖收藏夹 id。一般留空，自动用配置里的「小鲸鱼专用」' }, page: { type: 'integer', description: '页码，默认 1' }, limit: { type: 'integer', description: '每页条数，默认 12' } }),
    purpose: ['search', 'lookup']
  },
  {
    name: 'send_bilibili', category: 'web', sideEffect: 'write', permission: 'tools.overrides.send_bilibili', requiresSearch: true,
    description: '把 B 站视频转发到当前会话：封面图 + 标题链接一起发（保证可见；没有可用封面时只发标题+链接）。传 bilibili.com/video 或 b23.tv / BV 号。要总结内容用 parse_video。**调用即发送**，不用自己再转发；是否真的发出去看结果里的 deliveryState（delivered 才算投递成功，unknown / not_deliverable 都不算）。',
    parameters: objectSchema({ url: { type: 'string', description: 'B 站视频链接或 BV/av 号' } }, ['url']),
    purpose: ['reply', 'chat']
  }
];

function toolId(tool) {
  return String(tool?.id ?? tool?.name ?? '');
}

function cloneTool(tool) {
  // Keep legacy extension execute callbacks callable; parameters/metadata are
  // copied, while execute intentionally retains the same function reference.
  return {
    ...tool,
    id: toolId(tool),
    parameters: structuredClone(tool.parameters),
    purpose: [...(tool.purpose || [])]
  };
}

function validateParameterValue(schema, value, field, errors) {
  if (!schema || typeof schema !== 'object') return;
  const types = schema.type === undefined ? [] : (Array.isArray(schema.type) ? schema.type : [schema.type]);
  const validType = (type) => {
    if (type === 'null') return value === null;
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (type === 'integer') return Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'string') return typeof value === 'string';
    if (type === 'boolean') return typeof value === 'boolean';
    return true;
  };
  if (types.length && !types.some(validType)) {
    errors.push(`${field} 类型必须是 ${types.join('|')}`);
    return;
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => {
      const candidateErrors = [];
      validateParameterValue(candidate, value, field, candidateErrors);
      return candidateErrors.length === 0;
    }).length;
    if (matches !== 1) errors.push(`${field} 必须且只能匹配一个参数形状`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((choice) => Object.is(choice, value))) errors.push(`${field} 不在允许值中`);
  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) errors.push(`${field} 长度小于 ${schema.minLength}`);
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) errors.push(`${field} 长度大于 ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push(`${field} 小于 ${schema.minimum}`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) errors.push(`${field} 大于 ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) errors.push(`${field} 项数小于 ${schema.minItems}`);
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) errors.push(`${field} 项数大于 ${schema.maxItems}`);
    if (schema.items) value.forEach((item, index) => validateParameterValue(schema.items, item, `${field}[${index}]`, errors));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) errors.push(`${field} 缺少必需参数 ${required}`);
    }
    for (const [key, nested] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateParameterValue(nested, value[key], `${field}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) errors.push(`${field} 包含未知参数 ${key}`);
    }
  }
}

function validateToolParameters(schema, args) {
  const errors = [];
  validateParameterValue(schema, args, 'args', errors);
  return errors;
}

/**
 * 授权闸的判据（只对 sideEffect:'write' 的工具问一次）。返回 `null` = 允许；
 * 返回 `{ code, reason }` = 拒绝，且 reason 会直接进模型可见的工具失败文本。
 *
 * ★ T-ACT-FAILCLOSED：这里原来有**两处** fail-open —— 依赖不是函数时 `return true`、
 *   依赖抛错时 warn 之后仍 `return true`。这条闸是"未授权会话不许打协议端"的唯一执行点
 *   （写工具的 defaultEnabled:false 在 getToolAvailability 里被 `sideEffect !== 'write'` 短路掉了），
 *   所以"缺闸"绝不能等于"放行"：缺依赖 / 依赖抛错 ⇒ 一律拒，并点名是哪一种。
 * ★ 反过来，**依赖可用但对这个键没表态**（返回 undefined、{value:undefined}、true、{value:true}…）
 *   仍是配置语义上的"默认开"，不是缺闸 —— 这里不许顺手改成默认关（那会静默改变所有写工具的默认值）。
 */
function permissionVerdict(effective, permission, configContext, onError) {
  if (typeof effective !== 'function') {
    return {
      code: 'authz-dependency-missing',
      reason: `授权依赖缺失（effective 未注入或不是函数，实得 ${typeof effective}）⇒ 有副作用的动作一律拒绝`
    };
  }
  try {
    const result = effective(permission, configContext);
    if (result === false) return { code: 'tool-disabled-explicit', reason: `已被显式关闭：${permission}=false` };
    if (result && typeof result === 'object') {
      if (Object.hasOwn(result, 'value') && result.value === false) return { code: 'tool-disabled-explicit', reason: `已被显式关闭：${permission}.value=false` };
      if (Object.hasOwn(result, 'enabled') && result.enabled === false) return { code: 'tool-disabled-explicit', reason: `已被显式关闭：${permission}.enabled=false` };
    }
    // 依赖可用、且没有对这个键明确关闭 ⇒ 配置语义上的默认开。
    return null;
  } catch (error) {
    onError?.(error);
    return {
      code: 'authz-dependency-failed',
      reason: `授权闸求值抛错，已 fail-closed：${String(error?.message ?? error)}`
    };
  }
}

function permissionContext(options = {}) {
  return { chatKey: options.chatKey, kind: options.kind };
}

/**
 * 未执行工具的拒绝文案：原话「工具未注册、未授权或当前目的不可用」做前缀（M15/模型见过的措辞），
 * 后面补上可用性判据 —— 缺授权依赖时必须点名"授权依赖缺失"，不许只留一句含糊的"未授权"。
 */
function unavailableFailure(name, availability) {
  const generic = '工具未注册、未授权或当前目的不可用';
  if (!availability || availability.enabled || !availability.reason) return generic;
  return `${generic}（${availability.code}：${availability.reason}）`;
}

/**
 * 不可用的判据（`availability.code`）→ 批准的原因码。复用现成机器值、不另造一套分类：
 *   · 没注册 ⇒ `not-found`
 *   · **配置不让用**（单工具关 / 总开关关 / 分类关 / 不在白名单）⇒ `disabled-by-config`
 *   · **授权这道闸本身出问题**（依赖没注入、求值抛错，两者都 fail-closed）⇒ `authz-dependency-missing` / `authz-eval-failed`
 *   · 其余（技能未激活、缺能力、无视觉/无搜索…）⇒ `tool-unavailable`
 * ★ 后三档是指挥 2026-10-13 拆的：**"有人把它关了"是配置决定，"授权查失败"是故障**，排障时不能混在一桶里。
 *   更细的判据仍留在 `error` 文案里（原文带 `availability.code`），码只负责能统计。
 */
const CONFIG_DISABLED_AVAILABILITY_CODES = new Set([
  'tool-disabled-explicit', 'tools-disabled', 'tool-disabled', 'category-disabled', 'not-in-allowlist'
]);
const AUTHZ_EVAL_FAILED_AVAILABILITY_CODES = new Set(['authz-dependency-failed', 'tool-permission-eval-failed']);

function unavailableReasonCode(availability) {
  if (!availability || availability.enabled) return '';
  const code = String(availability.code ?? '');
  if (code === 'not-found') return TOOL_REJECT_REASONS.NOT_FOUND;
  if (code === 'authz-dependency-missing') return TOOL_REJECT_REASONS.AUTHZ_DEPENDENCY_MISSING;
  if (AUTHZ_EVAL_FAILED_AVAILABILITY_CODES.has(code)) return TOOL_REJECT_REASONS.AUTHZ_EVAL_FAILED;
  if (CONFIG_DISABLED_AVAILABILITY_CODES.has(code)) return TOOL_REJECT_REASONS.DISABLED_BY_CONFIG;
  return TOOL_REJECT_REASONS.TOOL_UNAVAILABLE;
}

function baseRegistry() {
  // ★ 内建工具现在自带执行器（executors/*.js）。`send_message` 不需要：它由 runOne 特判走 act.send。
  const execs = builtinExecutors();
  const defs = new Map(BUILT_INS.filter((tool) => !disabledBuiltIns.has(tool.name)).map((tool) => [
    tool.name,
    cloneTool({ ...tool, id: tool.name, sideEffectDeclared: true, ...(execs[tool.name] ? { execute: execs[tool.name] } : {}) })
  ]));
  for (const [name, tool] of toolRegistry) defs.set(name, cloneTool(tool));
  return defs;
}

function canonicalSchema(value) {
  // 数组（enum/oneOf/required等）保持原顺序；只固定对象键顺序。
  if (Array.isArray(value)) return value.map(canonicalSchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalSchema(value[key])]));
}

/** 老树 `src/protocol-tools.js:19` 的 `PROTOCOL_TOOLS`：只由开关决定、不受 api.tools 白名单管的工具。 */
const WHITELIST_EXEMPT_TOOLS = new Set(['finish']);

/**
 * 从注入的配置访问器取**原始值**。
 * ★ `effective()` 返回 `{ value, source, found }` 描述对象（core/config-store/index.js:242）⇒ 必须剥值，
 *   否则 `=== false` / `=== true` 这类判据永远不成立（N61 查出的五道门全塌就是这么来的）。
 */
function contextCfgValue(context, key) {
  if (!context || typeof context !== 'object') return undefined;
  try {
    if (typeof context.cfg?.get === 'function') return context.cfg.get(key);
  } catch { /* 落到 effective */ }
  const eff = typeof context.effective === 'function' ? context.effective
    : (typeof context.cfg?.effective === 'function' ? context.cfg.effective : null);
  if (!eff) return undefined;
  try {
    const resolved = eff(key, { chatKey: String(context.chatKey ?? ''), kind: String(context.kind ?? 'group') });
    if (resolved && typeof resolved === 'object' && Object.hasOwn(resolved, 'value')) {
      return resolved.found === false ? undefined : resolved.value;
    }
    return resolved;
  } catch { return undefined; }
}

/**
 * `send_message` 的 messages 参数 schema —— 照老树 `src/tools.js:891-905`（`messagesParamSchema`）：
 * `api.sendMessagesArrayOnly === true` 时**只给数组**一种写法。老树注释记着为什么：本地小模型经常生成
 * `{"messages":"[\"第一条\",\"第二条\"]"}`（把数组塞进字符串），两种可选写法 = 多一个出错机会。
 * ★ 只是**不再告诉**模型可以传字符串，后台照旧兼容（`runOne` 里 `normalizeMessageList` 归一）。
 */
function messagesParamSchema(context) {
  if (contextCfgValue(context, 'api.sendMessagesArrayOnly') === true) {
    return {
      type: 'array',
      items: { type: 'string' },
      description: '要发送的内容，字符串数组，每个元素是一条消息。就算只说一句也要写成 ["你好"] 这种数组。'
        + '★ 每一条都会原样发到当前会话、对方直接看得到：只放要对对方说的话；'
        + '心里话、给自己的指示（像"得接住""我先…""这波"）、草稿和思路（像"消息组织："这类计划内容）都别写进来，那些写正文或 finish.summary。',
      minItems: 1
    };
  }
  return null;
}

/** 把 messages 的数组专用 schema 换进 send_message 的定义（其余工具原样返回）。 */
function withMessagesPolicy(tool, context) {
  if (!tool || toolId(tool) !== 'send_message') return tool;
  const replacement = messagesParamSchema(context);
  if (!replacement) return tool;
  const parameters = tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : {};
  const properties = parameters.properties && typeof parameters.properties === 'object' ? parameters.properties : {};
  return { ...tool, parameters: { ...parameters, properties: { ...properties, messages: replacement } } };
}

/**
 * 候选行的通用解析：装配层喂的快照统一是 `[{ messageId:'#7', summary:'…' }, …]`。
 * 只收 1-7 位的本地短编号（`chat-store.js` 的 findByRef 认的那个形态），重复编号只留第一条。
 */
function refCandidateRows(rows) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const raw = String(row?.messageId ?? '').trim();
    if (!/^#?\d{1,7}$/.test(raw)) continue;      // 本地短编号只有 1-7 位；不像编号的候选一律不收
    const number = Number(raw.replace(/^#/, ''));
    if (!number || seen.has(number)) continue;
    seen.add(number);
    out.push({ number, ref: `#${number}`, summary: String(row?.summary ?? '').replace(/\s+/g, ' ').trim() });
  }
  return out;
}

/**
 * 本轮"真能看的图"的候选编号。列表由装配层喂进来：`compose.js` 的 `visibleImageMessagesForTurn()`
 * 产出 `[{ messageId:'#7', summary:'今晚的猫' }, …]`，**user 段那一行与工具执行上下文共用同一份快照**。
 * act 只负责把它收成文字 + 执行时按同一份比对，不自建第二份（判据归装配层与执行器）。
 */
function imageViewCandidates(context) {
  return refCandidateRows(context?.visibleImageMessages);
}

/** 候选行 → 「#7「今晚的猫」」那种写法（编号 + 摘要）。 */
const candidateListed = (candidates) => candidates.map((row) => `${row.ref}${row.summary ? `「${row.summary}」` : ''}`).join('、');

/**
 * 本轮可看/可引用的编号 → **一行文字**（2026-10-14 钱包主线第 1 件，指挥位裁定：退回 user 段末尾）。
 *
 * 为什么从工具参数里撤出来：被显式缓存的那一块 = `system` + `tools`（当日实测约 13.9k token）。
 *   旧写法把本轮可见图编号写进 `get_message_images` 的 `enum` 与 `description`，本轮只要有图，
 *   tools 那一份 JSON 就变 ⇒ 整块前缀作废重写（真实账本：17 轮里出现 16 个不同 `toolSchemaHash`，
 *   且同一轮内不变 ⇒ 抖的就是这份"本轮量"）。老树把同一类信息放在 user 段尾部
 *   （`src/prompt.js:1956-1964` 表情清单、`:2042` 条件硬要求），user 段排在标记块之后 ⇒ 不碰前缀。
 * ★ 撤掉 `enum` 不等于撤掉这道检查：拦假编号的是执行侧（`imageViewRefVerdict` —— 不在同一份快照里、
 *   store 又取不到 ⇒ 拒绝并点名能看的是哪几条），自己拼的数字仍旧发不出去。
 * ★ 引用编号那行**不做**（指挥位 2026-10-14 裁定，作为已知缺口留盘面）：装配层从来没有"本轮哪些消息可引用"
 *   的快照来源（`compose.js` 里没有 `visibleRefMessages`），要补得先跨域定判据 ⇒ 这轮不开这个口子。
 *   引用参数的值域也一直不锁：平台唯一引用入口 `modules/platform/sender.js:194 #resolveReply` 有意放行
 *   "8 位以上的原始 QQ message id"（`:222`）—— 滚出窗口的老消息本地查不到，但引用是真的。
 * ★ 快照为空 / 装配层没喂 ⇒ 返回空串（这一段由 `modules/prompt` 决定放不放，这里不塞一句空话）。
 *
 * @param {object} context 装配层喂的那一份快照（`visibleImageMessages`）
 * @returns {string} 空串 = 本轮没有要交代的编号
 */
export function turnCandidateNote(context = {}) {
  const images = imageViewCandidates(context);
  if (!images.length) return '';
  return `【本轮可看的图】只有这些：${candidateListed(images)}。`
    + '要看就照抄上面的编号（带 # 或只写数字都算同一条）；没列出来的那条这一轮看不了（不代表那条消息不存在），别自己拼数字。';
}

/** 按 store 复核一条编号到底取不取得回图片；判据与执行器取图那句一致（`executors/media.js` 的 kind=image 且有 url）。 */
function storeImageRefState(rawRef, context) {
  const store = context?.modules?.memory?.store;
  if (typeof store?.findByRef !== 'function') return 'unavailable';
  let entry = null;
  try { entry = store.findByRef(String(context?.chatKey ?? ''), rawRef) || null; } catch { entry = null; }
  if (!entry) return 'missing';
  const mediaList = Array.isArray(entry.media) ? entry.media : [];
  return mediaList.some((item) => item?.kind === 'image' && item?.url) ? 'lookable' : 'no-image';
}

/**
 * 执行侧的比对：先归一，再看它在不在这份快照里。
 * `#7` / `"7"` / `7` 本来就是同一个目标（`chat-store.js` 的 findByRef 三种都认），所以必须归一后再比 ⇒
 * 否则候选值会把三种合法写法收成一种。归一的目标形态就是候选值本身的 `#7`。
 * 快照为空/没喂 ⇒ 一律不拦（行为与改动前一致，别在这儿变成一个没人接的检查点）。
 *
 * 不在候选值里**不立刻拒**：候选快照在发起模型请求之前算，工具在模型回话之后才跑，
 * 这中间刚落库的那条图还没进列表（用户看到的"刚发的图我看不见"就是它）⇒ 退一步问 store
 * 取不取得回一条带图的消息，取回得了就放行。
 * ★ 取不回才拒：核心是"自己拼的编号一定被拒"，不是"列表没有就当不存在"。
 */
function imageViewRefVerdict(args, context) {
  const raw = typeof args?.messageId === 'string' || typeof args?.messageId === 'number' ? String(args.messageId).trim() : '';
  if (!raw) return { args };
  const candidates = imageViewCandidates(context);
  if (!candidates.length) return { args };
  const text = raw.replace(/^#/, '');
  const number = /^\d{1,7}$/.test(text) ? Number(text) : null;
  if (number !== null && candidates.some((row) => row.number === number)) return { args: { ...args, messageId: `#${number}` } };
  const storeState = storeImageRefState(text, context);
  if (storeState === 'lookable') return { args: { ...args, messageId: number === null ? raw : `#${number}` } };
  if (storeState === 'no-image') {
    return {
      reasonCode: TOOL_REJECT_REASONS.NO_IMAGE,
      reject: `${raw} 这条消息在记录里查得到，但它没有可下载的图片（QQ 表情那类只有表情、没有图片直链）⇒ 这一轮看不了它的画面。`
        + '别描述、别猜；要看已收藏的表情用 get_sticker_image。'
    };
  }
  return {
    reasonCode: TOOL_REJECT_REASONS.NOT_FOUND,
    reject: `这个工具本轮只能看这些图：${candidateListed(candidates)}（照抄编号，带 # 或只写数字都算同一条）。`
      + `你填的 ${raw} 不在其中，在本会话的记录里也查不到这条 ⇒ 这一轮看不了它，别自己拼数字。`
  };
}

/**
 * 引用目标（send_message）的执行侧核对，做三件事：
 *   ① 编号归一：`#7` / `"7"` / `7` 是同一个目标，幂等键按归一后的形态算 ⇒ 一次引用不会被算成两次调用。
 *   ② 按 store 判断这条引用挂不挂得上（`chat-store.js` 的 findByRef 自己会归一，这里不复制那套解析；
 *      下面的正则只决定"归一成哪个形态"）。
 *   ③ **不拦、不改写值**：引用问题不该让整条消息发不出去（那正好变成用户报的"该说不说"），
 *      只把结果说清楚。平台查不到编号时会**静默丢掉引用**（`modules/platform/sender.js:231`，消息照发、只留一行日志），
 *      模型原先并不知道，于是会在话里说"我引用了那条"—— 这里补的就是这句话。
 * store 没挂上来（脚本/测试里手工构造的上下文）⇒ 一律原样交出去，行为与改动前一致。
 *
 * @returns {{args: object, quote?: {requested: string, outcome: 'dropped'|'unverified', reason: string, note: string}}}
 */
function replyQuoteVerdict(args, context) {
  const value = args?.replyToMessageId;
  if (typeof value !== 'string' && typeof value !== 'number') return { args };
  const raw = String(value).trim();
  if (!raw || raw === 'null' || raw === 'undefined') return { args };
  const store = context?.modules?.memory?.store;
  if (typeof store?.findByRef !== 'function') return { args };
  const text = raw.replace(/^[#＃]+/, '');
  const number = /^\d{1,7}$/.test(text) ? Number(text) : null;
  const requested = number === null ? raw : `#${number}`;
  const nextArgs = number === null ? args : { ...args, replyToMessageId: `#${number}` };
  let entry = null;
  try { entry = store.findByRef(String(context?.chatKey ?? ''), raw) || null; } catch { entry = null; }
  if (entry) {
    const mid = entry?.mid;
    // 本地有记录、也有 QQ 消息 id ⇒ 平台的 #resolveReply 会挂上引用，结果里不需要多说什么
    if (mid !== null && mid !== undefined && String(mid) !== '') return { args: nextArgs };
    return {
      args: nextArgs,
      quote: {
        requested, outcome: 'dropped', reason: 'no-mid',
        note: `${requested} 在聊天记录里查得到，但它没有 QQ 消息 id（当初这条的发送回执没留下来）⇒ 这条引用挂不上。`
          + '消息已发出，但**没有引用**：别在话里说引用了哪条。'
      }
    };
  }
  if (/^-?\d{8,}$/.test(raw)) {
    // 形状像原始 QQ 消息 id：平台照旧放行（可能是滚出窗口的老消息），但没人能核对它指到哪条
    return {
      args,
      quote: {
        requested: raw, outcome: 'unverified', reason: 'unverified-raw-id',
        note: `${raw} 在本会话的消息记录里查不到，已按 QQ 原始消息 id 交给平台直接引用（无法核对到底引用了哪条）⇒`
          + '别断言"我引用了某条"，除非那个 id 确实是你本轮见过的那条。'
      }
    };
  }
  return {
    args: nextArgs,
    quote: {
      requested, outcome: 'dropped', reason: 'unknown-ref',
      // 这里原先有一支"把本轮可引用编号列出来"的写法，但装配层从来没喂过那份快照 ⇒ 一次没触发过，
      // 按 2026-10-14 裁定撤掉；撤后文字与生产上当今实际吐出的那一句逐字相同。
      note: `这条消息发出去了，但引用没挂上：${requested} 在本会话的消息记录里查不到（这种编号多半是自己写的）。`
        + '要引用就照抄聊天记录里那条前面的 #短编号。'
        + '这条消息没有引用，别在话里说引用了谁。'
    }
  };
}

/** 返回当前可用的工具定义。写工具只有 effective 明确授权后才会出现。 */
export function registry(options = {}) {
  const tools = [...baseRegistry().entries()]
    .filter(([id]) => getToolAvailability(id, options).enabled)
    .map(([id, tool]) => {
      // ★ N61：send_message 的 messages schema 按 `api.sendMessagesArrayOnly` 现算（老树同口径：
      //   schema 每次调用现建 ⇒ 改了配置不用重启就生效）。
      // ★ 反过来，这里**不许**吃每轮变的量（2026-10-14 钱包主线第 1 件）：tools 与被标记的 system 同属
      //   可缓存前缀，本轮可见图编号一类一旦进来，整块前缀每轮作废重写 ⇒ 那份清单改由 `turnCandidateNote`
      //   产文字、排在 user 段末尾。判据只留配置/授权/开关（见 `getToolAvailability`）。
      const shaped = withMessagesPolicy(cloneTool(tool), options);
      return {
        ...shaped,
        parameters: canonicalSchema(shaped.parameters),
        name: id,
        displayName: String(tool.displayName ?? (tool.name === id ? '' : tool.name)),
        sideEffectDeclared: tool.sideEffectDeclared !== false
      };
    }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const tool of tools) delete tool.execute;
  tools.undeclaredSideEffects = [...undeclaredSideEffects];
  return tools;
}

/** 聚合状态面：明确列出按 read 兼容、但未声明 sideEffect 的工具。 */
export function status(options = {}) {
  const tools = registry(options);
  return {
    registeredCount: baseRegistry().size,
    availableCount: tools.length,
    undeclaredSideEffects: [...undeclaredSideEffects]
  };
}

/** 注册工具。重复注册同名工具会覆盖；不满足基本契约则拒绝。 */
export function registerTool(def) {
  const id = String(def?.id ?? def?.name ?? '').trim();
  if (!id || id !== String(def?.id ?? def?.name ?? '') || /[\u0000-\u001f\u007f-\u009f]/.test(id) || Array.from(id).length > 128) {
    throw new Error('工具 id 必须非空、无首尾空白/控制字符且不超过 128 个 Unicode 字符');
  }
  if (def.sideEffect !== undefined && def.sideEffect !== 'read' && def.sideEffect !== 'write') throw new Error(`工具 ${id} 的 sideEffect 必须是 read 或 write`);
  if (!def.parameters || typeof def.parameters !== 'object') throw new Error(`工具 ${def.name} 必须提供 parameters`);
  if (typeof def.execute !== 'function') throw new Error(`工具 ${id} 必须提供 execute 函数`);
  const declared = def.sideEffect !== undefined;
  const sideEffect = def.sideEffect ?? 'read';
  const originalExecute = def.execute;
  const execute = async (ctx, args) => {
    const errors = validateToolParameters(def.parameters, args);
    if (errors.length) throw new Error(`工具 ${id} 参数校验失败：${errors.join('；')}`);
    return originalExecute(ctx, args);
  };
  const tool = Object.freeze({
    category: 'system', defaultEnabled: true, purpose: [], ...def,
    id, name: String(def.name || id), displayName: String(def.name || id), sideEffect,
    sideEffectDeclared: declared,
    // 写工具的 permission 是“显式 false 时关闭”的配置键；缺配置默认开启。
    permission: sideEffect === 'write' ? (def.permission || `tools.overrides.${id}`) : def.permission,
    execute
  });
  disabledBuiltIns.delete(id);
  if (declared) undeclaredSideEffects.delete(id);
  else undeclaredSideEffects.add(id);
  toolRegistry.set(id, tool);
  return cloneTool(tool);
}

export function unregisterTool(name) {
  const id = String(name);
  if (toolRegistry.delete(id)) {
    undeclaredSideEffects.delete(id);
    return true;
  }
  if (BUILT_INS.some((tool) => tool.name === id) && !disabledBuiltIns.has(id)) {
    disabledBuiltIns.add(id);
    return true;
  }
  return false;
}

export function unregisterToolsBySkill(skillId) {
  const removed = [];
  for (const [name, tool] of toolRegistry) {
    if (tool.skillId && tool.skillId === skillId) {
      toolRegistry.delete(name);
      undeclaredSideEffects.delete(name);
      removed.push(name);
    }
  }
  return removed;
}

export function getTool(name, options = {}) {
  const id = String(name);
  const tool = baseRegistry().get(id);
  if (!tool) return null;
  const availability = getToolAvailability(id, options);
  if (!options.includeUnauthorized && !availability.enabled) return null;
  const result = { ...withMessagesPolicy(cloneTool(tool), options), name: id, displayName: String(tool.displayName ?? (tool.name === id ? '' : tool.name)) };
  if (!availability.enabled && tool.sideEffect === 'write') delete result.execute;
  return result;
}

export function listTools(options = {}) {
  return [...baseRegistry().values()]
    .flatMap((tool) => {
      const id = toolId(tool);
      const availability = getToolAvailability(id, options);
      if (!options.includeUnauthorized && !availability.enabled) return [];
      const result = { ...withMessagesPolicy(cloneTool(tool), options), name: id, displayName: String(tool.displayName ?? (tool.name === id ? '' : tool.name)) };
      if (!availability.enabled && tool.sideEffect === 'write') delete result.execute;
      return [result];
    });
}

/**
 * 可用性判据能读到的运行时上下文（2026-10-14 钱包主线第 2 件，指挥位裁定：工具可用性只由配置/授权/开关决定）。
 *
 * ★ 为什么单列这一份：装配层喂来的 `runtimeContext` 里带着 `evidenceId`（`compose.js` 那侧
 *   `{ chatKey, kind, evidenceId }`）—— 每轮都变。技能可用性一吃它，工具名单就在 44/45 之间抖，
 *   而 tools 与被标记的 system 同属可缓存前缀 ⇒ 一处抖动作废两块缓存（真实账本：17 轮里 16 个不同
 *   `toolSchemaHash`）。执行侧**照旧**拿完整的 `runtimeContext`（本轮量在那儿是有用的），只有判据这一头收窄。
 * ★ 白名单而不是黑名单：黑名单会漏掉以后新加的本轮字段，白名单漏了会当场在自测里红。
 *   只留 `chatKey` / `kind` —— 一次会话内不变（前缀本就按会话热），确有技能按群聊/私聊决定开不开。
 *   实测本机 16 个 skill/plugin 的 `available()` **一个都不接参数**，老树同位置压根不传上下文
 *   （`modules/extensions/skill-bridge.js:103` 是 `isActive(skillId, {})`）⇒ 收窄不会切断合法判据。
 */
const AVAILABILITY_CONTEXT_KEYS = Object.freeze(['chatKey', 'kind']);
function availabilityScope(context = {}) {
  const source = context.runtimeContext && typeof context.runtimeContext === 'object' ? context.runtimeContext : {};
  const scoped = {};
  for (const key of AVAILABILITY_CONTEXT_KEYS) {
    const value = source[key] ?? context[key];
    if (value !== undefined) scoped[key] = value;
  }
  return scoped;
}

/** 集中返回启用状态与原因，供装配层/扩展桥使用。 */
export function getToolAvailability(name, context = {}) {
  const id = String(name);
  const tool = baseRegistry().get(id);
  if (!tool) return { id: String(name), enabled: false, code: 'not-found', reason: '工具未注册', skillId: null };
  if (tool.sideEffect === 'write') {
    const verdict = permissionVerdict(context.effective, tool.permission, permissionContext(context), (error) => {
      const detail = String(error?.message ?? error);
      observabilityLog('warn', `tool-permission-eval-failed tool=${id} permission=${tool.permission} error=${detail}`, {
        code: 'tool-permission-eval-failed', tool: id, permission: tool.permission
      });
    });
    if (verdict) return { id, enabled: false, code: verdict.code, reason: verdict.reason, skillId: tool.skillId ?? null };
  }
  const cfg = context.toolsCfg || {};
  const deny = (code, reason) => ({ id, enabled: false, code, reason, skillId: tool.skillId ?? null });
  if (cfg.enabled === false) return deny('tools-disabled', '工具总开关已关闭');
  // ★ N61 接回 `api.tools` 白名单。老树这条判据**只活在一处**（`src/protocol-tools.js:44-56` 的 `hasTool`），
  //   工具表过滤（`src/orchestrator.js:3152`）与提示词文案（`src/prompt.js:98/116/121`）都问它；
  //   新树此前只有设置页读 `api.tools` ⇒ 用户设的名单对模型能调什么**毫无作用**（能设不生效）。
  //   口径逐条照老树（`src/orchestrator.js:3150-3155`，注释原文"别顺手放宽/收紧别的工具"）：
  //     ① 名单空/非数组 = 全开；
  //     ② 协议工具（老树 `PROTOCOL_TOOLS`，目前只有 `finish`）**豁免** —— 只由 `api.finishRound.enabled`
  //        决定（开关赢白名单，2026-10-04 用户裁决）；
  //     ③ **skill 扩展工具也豁免**（老树 `!d.skillId && toolWhitelist && …`）—— 它们归
  //        `config.skills[id].enabled` 管，把白名单套上去会比老树**更严**：用户一设名单就把技能卸掉。
  const allowList = contextCfgValue(context, 'api.tools');
  if (!WHITELIST_EXEMPT_TOOLS.has(id) && !tool.skillId && Array.isArray(allowList) && allowList.length
    && !allowList.map(String).includes(id)) {
    return deny('not-in-allowlist', `该工具不在 api.tools 白名单里（名单 ${allowList.length} 项）`);
  }
  const skills = context.skills;
  const runtimeContext = availabilityScope(context);
  if (tool.skillId) {
    if (!skills || typeof skills.isActive !== 'function') return deny('skill-unavailable', `技能 ${tool.skillId} 尚未注入可用性检查`);
    const status = skills.isActive(tool.skillId, runtimeContext);
    if (!status?.active) return deny(status?.code || 'skill-disabled', `${tool.skillId}：${status?.reason || '技能未启用'}`);
  }
  const requires = Array.isArray(tool.requires) ? tool.requires : [];
  if (requires.length) {
    if (!skills || typeof skills.explainCapability !== 'function') return deny('capability-unavailable', '尚未注入能力检查器');
    for (const capability of requires) {
      const status = skills.explainCapability(capability, runtimeContext);
      if (!status?.available) return deny('capability-missing', `缺少能力 ${capability}：${status?.reason || '不可用'}`);
    }
  }
  if (cfg.categories?.[tool.category] === false) return deny('category-disabled', `分类「${tool.category}」已关闭`);
  const override = cfg.overrides?.[id];
  if (override === false || (override === undefined && tool.defaultEnabled === false && tool.sideEffect !== 'write')) return deny('tool-disabled', '该工具已被单独关闭');
  if (tool.requiresVision && context.visionEnabled === false) return deny('no-vision', '当前模型不支持图片输入');
  if (tool.requiresSearch && context.searchEnabled === false) return deny('no-search', '联网搜索已关闭');
  if (skills && typeof skills.getToolGuards === 'function') {
    for (const guard of skills.getToolGuards(runtimeContext) || []) {
      try {
      const result = guard.fn?.({ toolId: id, tool, context: runtimeContext });
        if (result === false || result?.ok === false) return deny('skill-guard', String(result?.reason || '技能运行时否决'));
      } catch { /* 与旧注册表一致：guard 异常记在别处，不阻断工具 */ }
    }
  }
  return { id, enabled: true, code: null, reason: '', skillId: tool.skillId ?? null };
}

/**
 * 进程内受控协议动作出口。文本只能经 send() 走 SendQueue 并取得 SendReceipt；
 * 本白名单仅保留同步协议动作，任何调用都先经 M2 event + log 留痕。
 */
export async function callProtocol(action, params, ctx = {}) {
  const actionName = String(action ?? '');
  const chatKey = String(ctx.chatKey ?? '');
  const observability = ctx.modules?.observability;
  if (typeof observability?.event !== 'function' || typeof observability?.log !== 'function') {
    throw new Error('依赖未就绪：ctx.modules.observability.event/log');
  }

  const audit = (ok, error = '') => {
    observability.event('protocol_action', {
      chatKey, name: actionName, status: ok ? 'ok' : 'error',
      code: ok ? 'protocol-ok' : 'protocol-error'
    });
    // M2's structured event schema has no error-text field; preserve the original
    // protocol error in its bounded log message without recording request params.
    observability.log(ok ? 'info' : 'error',
      `protocol action=${actionName} chatKey=${chatKey} ok=${ok} error=${error}`,
      { action: actionName, chatKey, ok });
  };

  if (!PROTOCOL_ACTIONS.has(actionName)) {
    const error = `协议动作不在 M10 白名单：${actionName}`;
    audit(false, error);
    throw new Error(error);
  }

  try {
    if (typeof ctx.platform?.call !== 'function') throw new Error('依赖未就绪：ctx.platform.call');
    const result = await ctx.platform.call(actionName, params);
    audit(true);
    return result;
  } catch (error) {
    const original = String(error?.message ?? error);
    audit(false, original);
    if (error instanceof Error) throw error;
    throw new Error(original);
  }
}

function purposeTags(plan) {
  const value = [plan?.purpose, plan?.reason, plan?.action].filter((x) => typeof x === 'string').join(' ').toLowerCase();
  const tags = new Set();
  if (/search|lookup|查|搜|历史|消息/.test(value)) tags.add('lookup');
  if (/memory|记忆|印象|好感|归档/.test(value)) tags.add('memory');
  if (/reply|continue|chat|conversation|闲聊|回复|续话/.test(value)) tags.add('reply');
  if (/research|联网|网页|资料/.test(value)) tags.add('search');
  if (/write|append|favor|archive|写入|记录|更新/.test(value)) tags.add('memory-write');
  return tags;
}

/** 按 action/purpose 选工具；明确 toolPlan 是工具调用的上限。 */
export function selectTools(plan, { cfg = {} } = {}) {
  if (!plan || ['wait', 'skip', 'ask'].includes(plan.action)) return [];
  const tools = registry(cfg);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  if (plan.action === 'tool') {
    const requested = new Set((plan.toolPlan || []).map((tool) => tool.name));
    return [...requested].filter((name) => byName.has(name));
  }
  const tags = purposeTags(plan);
  const picked = [];
  for (const tool of tools) {
    if (tool.sideEffect === 'write' && tool.name !== 'send_message' && !tags.has('memory-write')) continue;
    if (tool.name === 'send_message') {
      if (plan.action === 'reply' || plan.action === 'continue' || tags.has('reply')) picked.push(tool.name);
      continue;
    }
    if (tool.purpose.some((tag) => tags.has(tag))) picked.push(tool.name);
  }
  const allowed = cfg.allowedTools ? new Set(cfg.allowedTools) : null;
  return picked.filter((name) => !allowed || allowed.has(name));
}

function normalizeIdempotencyArgs(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.filter((item) => item !== undefined).map(normalizeIdempotencyArgs);
  if (value && typeof value === 'object') {
    const normalized = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) normalized[key] = normalizeIdempotencyArgs(value[key]);
    }
    return normalized;
  }
  return value;
}

function argsDigest(args) {
  const serialized = JSON.stringify(normalizeIdempotencyArgs(args ?? {})) ?? 'null';
  let hash = 0x811c9dc5;
  for (let i = 0; i < serialized.length; i += 1) {
    hash ^= serialized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function toolCallBaseKey(ctx, action) {
  return ctx.idempotencyKey
    ? String(ctx.idempotencyKey)
    : makeIdempotencyKey(String(ctx.chatKey || ''), String(ctx.evidenceId || ''), action);
}

function toolCallKey(ctx, action, name, args) {
  const base = toolCallBaseKey(ctx, action);
  // A positional key can return a different tool/args call's cached receipt, reporting a new
  // message as delivered without ever sending it. Key the logical call instead: name + args.
  return `${base}:${name}:${argsDigest(args)}`;
}

function receiptProvesSomeDelivery(receipt) {
  const receiptCount = Number(receipt?.coverage?.receiptCount ?? 0);
  const platformId = receipt?.platformId != null && String(receipt.platformId).trim() !== '';
  return receiptCount > 0 || platformId;
}

function keepsMemo(result, tool) {
  if (result?.ok === true) return true;
  if (tool?.sideEffect === 'read') return false;
  if (result?.state === 'unknown') return true;
  if (result?.receipt) return receiptProvesSomeDelivery(result.receipt);
  // A write failure with no receipt is conservatively retained: we cannot prove it did not happen.
  return true;
}

/**
 * ★ 拒绝原因码：**取值表在 `contracts/index.js` 的 `TOOL_REJECT_REASONS`**（指挥 2026-10-13 裁的闭集，
 *   act 与 compose 共用一份 —— 同一件事在两处各起一个名字，"工具名 × 原因"的分布表就对不上）。
 *   失败行的状态（`state`）回答"成没成"，`reasonCode` 回答"卡在哪一步"，两件事分开才出得了分布。
 *   ★ 本模块只许贴下面这十六个（合同表里另外六个 —— 收口、轮次上限、扩展否决… —— 由编排层产生）：
 *   过滤器做成**双向**的，编排侧的码串到 act 行上会被丢字段，两边不会互相污染。
 *   ★ act 的**每一条**拒绝路径都必须落在这十五个里（缺码 = bug，自测会红）；
 *   加新码先走指挥裁定，再往合同表里追加，不要在这里临时造名字，也不要把码塞进 `error` 文案。
 */
const ACT_REJECT_REASON_VALUES = Object.freeze(new Set([
  TOOL_REJECT_REASONS.SCHEMA_INVALID,
  TOOL_REJECT_REASONS.NOT_FOUND,
  TOOL_REJECT_REASONS.NO_IMAGE,
  TOOL_REJECT_REASONS.DISABLED_BY_CONFIG,
  TOOL_REJECT_REASONS.AUTHZ_DEPENDENCY_MISSING,
  TOOL_REJECT_REASONS.AUTHZ_EVAL_FAILED,
  TOOL_REJECT_REASONS.TOOL_UNAVAILABLE,
  TOOL_REJECT_REASONS.INVALID_IDEMPOTENCY_KEY,
  TOOL_REJECT_REASONS.CALL_BUDGET_EXHAUSTED,
  TOOL_REJECT_REASONS.TIME_BUDGET_EXHAUSTED,
  TOOL_REJECT_REASONS.HYPE_COUNT_INSUFFICIENT,
  TOOL_REJECT_REASONS.EXECUTOR_MISSING,
  TOOL_REJECT_REASONS.EXECUTOR_FAILED,
  TOOL_REJECT_REASONS.TIMEOUT,
  TOOL_REJECT_REASONS.SEND_NOT_CONFIRMED,
  TOOL_REJECT_REASONS.INNER_VOICE_BLOCKED
]));

/** 只有批准过的码才落字段；成功行和取不到码的路径一律不带这个字段。 */
function reasonField(reasonCode) {
  return ACT_REJECT_REASON_VALUES.has(reasonCode) ? { reasonCode } : {};
}

function failure(name, error, idempotencyKey, state = 'failed', reasonCode = '') {
  return {
    ok: false, error: String(error?.message ?? error), state, tool: name, idempotencyKey,
    ...reasonField(reasonCode)
  };
}

// ══════════════════════════════════════════════════════════════════════════
// ★ P0-4（2026-10-08）媒体闭环：**「已准备」与「已投递」是两个状态**
//
// 主人的原话是"说发了其实没发"：`media.js` 的三个发图工具只回 `pendingSend`、`music-bili.js`
// 只回卡片 ⇒ 模型和账本都以为发出去了，**平台那边一条都没发**。
// 修法：执行器**仍然一次都不碰平台**（`executors/index.js` 契约第 5 条不变），
// 由 act 拿到"已准备"载荷后**统一复用 `send()`**（幂等键 + 卫生链 + 与文本**同形状**的回执）完成投递。
// ⇒ 判据只有一个：**平台回执**。没有回执 ⇒ 终态不许出现 delivered / sent / 已播放 语义。
// ══════════════════════════════════════════════════════════════════════════

/** 哪些工具的 `data` 是"已准备"载荷，需要 act 接着投递。 */
const MEDIA_PREPARE_TOOLS = new Set(['send_image', 'send_sticker', 'image_lib_send', 'send_music', 'send_bilibili']);

/**
 * 从"已准备"的 `data` 里取出 `send()` 认得的 media 数组；认不出 ⇒ `null`（按普通工具结果处理，
 * 例如 `send_image(preview=true)` 只看一眼，本来就不该投递）。
 */
function preparedMedia(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const pending = data.pendingSend;
  if (pending && typeof pending === 'object') {
    const file = String(pending.dataUrl ?? pending.file ?? pending.url ?? '').trim();
    if (!file) return null;
    return {
      media: [{ type: pending.type === 'sticker' ? 'sticker' : 'image', file }],
      replyTo: pending.replyTo ?? null,
      at: pending.at ?? null
    };
  }
  if (data.kind === 'music_card') {
    return {
      media: [{ type: 'music_card', platform: String(data.platform ?? '163'), songId: String(data.songId ?? ''), title: data.title, artist: data.artist, url: data.url, audio: data.audio }],
      replyTo: null,
      at: null
    };
  }
  if (data.kind === 'bilibili_card') {
    // ★ 2026-10-19（#8 收口，ds5 交接 A 段）：投递形态 = 封面图 + 标题链接（不再依赖 QQ JSON 分享卡）。
    //   cover 非空才附 image；空 cover 只发标题+链接，不编图。replyTo 保持 null（引用会被 QQ 吞）。
    const url = String(data.url ?? '').trim();
    const title = String(data.title || 'B站视频').slice(0, 80);
    const cover = String(data.cover ?? '').trim();
    return {
      media: [
        ...(cover ? [{ type: 'image', file: cover }] : []),
        { type: 'text', text: `${title}\n${url}` }
      ],
      replyTo: null,
      at: null
    };
  }
  return null;
}

/**
 * 把"已准备"的媒体载荷交给 `send()` 投递。**只有平台回执才算已投递。**
 * @returns {{state:'delivered'|'unknown'|'not_deliverable'|'failed', reasonCode?:string, receipt?:object, error?:string}}
 *   · `unknown` = 已经送到平台但结果未确认（没拿到 message_id / 只盖了一部分 / 超时）
 *     ⇒ **不许重发成功部分、不许把未知当失败乱补发**（幂等键仍留着那条可能已发出的记录）。
 *   · `not_deliverable` = 出口未连通 ⇒ 一次都没发出去，如实说不可投递，绝不伪装成功。
 *   · `failed` = 还没碰到平台就被拦下（卫生链/空载荷）⇒ 确定什么都没发出去。
 */
async function deliverPreparedMedia(name, prepared, ctx, plan, timeoutMs, idempotencyKey) {
  if (!ctx?.platform || typeof ctx.platform.sendSegments !== 'function') {
    return {
      state: 'not_deliverable',
      reasonCode: TOOL_REJECT_REASONS.SEND_NOT_CONFIRMED,
      error: 'platform.sendSegments 不是可用的公开媒体发送出口（媒体出口未连通）'
    };
  }
  let receipt;
  try {
    receipt = await executeWithBudget((toolCtx) => send({
          signal: toolCtx.signal, deadline: toolCtx.deadline,
      media: prepared.media,
      chatKey: ctx.chatKey,
      evidenceId: ctx.evidenceId,
      action: `${plan.action}-${name}-deliver`,
      idempotencyKey: `${idempotencyKey}#deliver`,
      replyToMessageId: prepared.replyTo ?? undefined,
      atUserId: prepared.at ?? undefined,
      cfg: ctx.cfg,
      ...(typeof ctx?.effective === 'function' ? { effective: ctx.effective } : {})
    }, ctx.platform), {}, ctx, timeoutMs);
  } catch (error) {
    return {
      state: 'unknown',
      reasonCode: error?.timeout ? TOOL_REJECT_REASONS.TIMEOUT : TOOL_REJECT_REASONS.SEND_NOT_CONFIRMED,
      error: `投递超时、结果未知：${String(error?.message ?? error)}`
    };
  }
  if (receipt?.ok === true && receipt?.platformId) return { state: 'delivered', receipt };
  const reachedPlatform = Number(receipt?.coverage?.requestedCount ?? 0) > 0;
  return {
    state: reachedPlatform ? 'unknown' : 'failed',
    reasonCode: TOOL_REJECT_REASONS.SEND_NOT_CONFIRMED,
    ...(receipt ? { receipt } : {}),
    error: receipt?.error || '媒体发送未取得平台回执'
  };
}

/** 媒体/卡片类工具的收口：把"已准备"的结果翻成 `deliveryState` 四种终态之一。 */
async function finishPreparedMedia(name, prepared, data, plan, ctx, timeoutMs, idempotencyKey) {
  const delivery = await deliverPreparedMedia(name, prepared, ctx, plan, timeoutMs, idempotencyKey);
  // base64 大载荷不进回执、不进模型上下文
  const trimmed = data?.pendingSend && typeof data.pendingSend === 'object'
    ? { ...data, pendingSend: Object.fromEntries(Object.entries(data.pendingSend).filter(([key]) => key !== 'dataUrl')) }
    : data;
  // ★ 「已播放」记账只在**投递被平台确认之后**写；未确认 ⇒ false，绝不提前算"已播放"。
  const ledgerSong = data?.playLedger?.songId ? String(data.playLedger.songId) : '';
  const recordPlayed = () => {
    try {
      return typeof ctx?.modules?.internet?.rememberMusicPlayed === 'function'
        && ctx.modules.internet.rememberMusicPlayed(ledgerSong) === true;
    } catch { return false; }
  };
  if (delivery.state === 'delivered') {
    return {
      ok: true,
      data: { ...trimmed, deliveryState: 'delivered', ...(ledgerSong ? { playedRecorded: recordPlayed() } : {}) },
      state: 'completed', tool: name, receipt: delivery.receipt, idempotencyKey
    };
  }
  let error;
  if (delivery.state === 'not_deliverable') error = `媒体已准备好，但**不可投递**：${delivery.error}`;
  else if (delivery.state === 'unknown') error = `媒体已送到平台但**未确认投递**（结果未知）：${delivery.error}。不要重发。`;
  else error = `媒体投递失败（未发出）：${delivery.error}`;
  return {
    ok: false,
    error,
    state: delivery.state,
    tool: name,
    ...reasonField(delivery.reasonCode),
    ...(delivery.receipt ? { receipt: delivery.receipt } : {}),
    data: { ...trimmed, deliveryState: delivery.state, ...(ledgerSong ? { playedRecorded: false } : {}) },
    idempotencyKey
  };
}

// ══════════════════════════════════════════════════════════════════════════
// ★ N48（2026-10-10，用户批准放开）：send_forward 的受控投递
//
// 上面 P0-4 的口径**一条都没改**：执行器只准备、act 复用 `send()`、判据只有平台回执。
// 差别只在"已准备"的东西是**文字**不是媒体 ⇒ 必须走 `send()` 的 messages 分支：
//   · messages 分支过 `applySendHygiene` **全链**（心声剥离 / 内部分析硬拦 / send.maxPerRun 预算），
//     与 send_message 是同一套裁判；
//   · media 分支里的文字只过 `applyMediaTextGuard`（只有 internalDraft 一道窄门，见其注释）。
//     转发装的是**别人的聊天原文**，不能从弱门走出去 ⇒ 单列一条投递路，不塞进 MEDIA_PREPARE_TOOLS。
// ★ 也没扩 `PROTOCOL_ACTIONS`：那条要 `ctx.platform.call`，而活门面只有
//   sendTextBatch/sendImage/sendSegments（apps/server/onebot-link.js）⇒ 恒报「依赖未就绪」；
//   何况它是绕过 SendQueue 的裸协议调用（无幂等键、无守卫链、无回执），正是 P0-4 定的"不许这样发"。
// ══════════════════════════════════════════════════════════════════════════

/** 哪些工具的 `data` 是"已整理、待以文字投递"的转发内容。 */
const FORWARD_PREPARE_TOOLS = new Set(['send_forward']);

/** 转发只落**一条**气泡：超出上限就整行截尾并如实记账，不许悄悄塞超长气泡，也不许拆成 N 条刷屏。 */
const FORWARD_TEXT_MAX_CHARS = 2000;

/** 从"已整理"的 `data` 里取出待投递的转发文字；取不出 ⇒ `null`（按普通工具结果处理）。 */
function preparedForward(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.prepared !== true) return null;
  const lines = (Array.isArray(data.messages) ? data.messages : [])
    .map((line) => String(line ?? '').trim()).filter(Boolean);
  if (!lines.length) return null;
  return { lines, replyTo: data.replyToMessageId ?? null };
}

/**
 * 把整理好的转发文字交给 `send()` 投递。**只有平台回执才算已投递。**
 * 四态口径与 `deliverPreparedMedia` 逐字一致（delivered / unknown / not_deliverable / failed）。
 */
async function deliverPreparedForward(name, prepared, ctx, plan, timeoutMs, idempotencyKey) {
  if (!ctx?.platform || typeof ctx.platform.sendTextBatch !== 'function') {
    return {
      state: 'not_deliverable', keptCount: 0, truncated: 0,
      reasonCode: TOOL_REJECT_REASONS.SEND_NOT_CONFIRMED,
      error: 'platform.sendTextBatch 不是可用的公开发送出口（转发出口未连通）'
    };
  }
  const total = prepared.lines.length;
  const render = (list, dropped) => `[聊天记录 共${list.length}条]\n${list.join('\n')}`
    + (dropped ? `\n（另有 ${dropped} 条因单条消息长度上限未包含）` : '');
  let kept = prepared.lines.slice();
  let truncated = 0;
  while (kept.length > 1 && render(kept, total - kept.length).length > FORWARD_TEXT_MAX_CHARS) {
    kept.pop();
    truncated = total - kept.length;
  }
  const text = render(kept, truncated);
  let receipt;
  try {
    receipt = await executeWithBudget((toolCtx) => send({
          signal: toolCtx.signal, deadline: toolCtx.deadline,
      messages: [text],
      chatKey: ctx.chatKey,
      kind: ctx.kind,
      evidenceId: ctx.evidenceId,
      action: `${plan.action}-${name}-deliver`,
      idempotencyKey: `${idempotencyKey}#deliver`,
      replyToMessageId: prepared.replyTo ?? undefined,
      cfg: ctx.cfg,
      sendBudget: ctx.sendBudget,
      ...(typeof ctx?.effective === 'function' ? { effective: ctx.effective } : {})
    }, ctx.platform), {}, ctx, timeoutMs);
  } catch (error) {
    return {
      state: 'unknown', keptCount: kept.length, truncated,
      reasonCode: error?.timeout ? TOOL_REJECT_REASONS.TIMEOUT : TOOL_REJECT_REASONS.SEND_NOT_CONFIRMED,
      error: `投递超时、结果未知：${String(error?.message ?? error)}`
    };
  }
  const base = { keptCount: kept.length, truncated, ...(receipt ? { receipt } : {}) };
  if (receipt?.ok === true && receipt?.platformId) return { state: 'delivered', ...base };
  const reachedPlatform = Number(receipt?.coverage?.requestedCount ?? 0) > 0;
  return {
    state: reachedPlatform ? 'unknown' : 'failed',
    reasonCode: TOOL_REJECT_REASONS.SEND_NOT_CONFIRMED,
    ...base,
    error: receipt?.error || '转发未取得平台回执'
  };
}

/** 转发的收口：翻成 `deliveryState` 四种终态之一；节点原文不回传（与 messages 重复，只会烧上下文）。 */
async function finishPreparedForward(name, prepared, data, plan, ctx, timeoutMs, idempotencyKey) {
  const delivery = await deliverPreparedForward(name, prepared, ctx, plan, timeoutMs, idempotencyKey);
  const summary = {
    nodeCount: Number(data?.nodeCount ?? prepared.lines.length),
    includedCount: delivery.keptCount,
    truncatedCount: delivery.truncated
  };
  if (delivery.state === 'delivered') {
    return {
      ok: true,
      data: { ...summary, sent: true, deliveryState: 'delivered' },
      state: 'completed', tool: name, receipt: delivery.receipt, idempotencyKey
    };
  }
  const error = delivery.state === 'not_deliverable'
    ? `转发内容已整理好，但**不可投递**：${delivery.error}`
    : delivery.state === 'unknown'
      ? `转发内容已送到平台但**未确认投递**（结果未知）：${delivery.error}。不要重发。`
      : `转发投递失败（未发出）：${delivery.error}`;
  return {
    ok: false,
    error,
    state: delivery.state,
    tool: name,
    ...reasonField(delivery.reasonCode),
    ...(delivery.receipt ? { receipt: delivery.receipt } : {}),
    data: { ...summary, sent: false, deliveryState: delivery.state },
    idempotencyKey
  };
}

/**
 * 执行一次工具/发送，带超时。
 * ★ 2026-10-19（S10 收口）：**超时 = 停止等待，不等于底层工作已停止**。
 *   · 每次执行创建独立 AbortController（与整轮 ctx.signal 组合；父级中止会同步下发），
 *     通过 `ctx.signal` 交给执行器 —— 支持取消的只读网络/子进程（如 B 站抽帧）据此真正停下；
 *   · 超时只 abort 这次调用的 signal，并在错误上标 `abortRequested`；**不宣称写/发送已取消**：
 *     上层仍按 state='unknown' + 幂等保护处理，不会因超时重放副作用；
 *   · 发送类调用传入该 signal 和 deadline：排队未开始时可确认为 not_sent；已开始后仍按 unknown 保护，
 *     不把超时或取消误判成未发送。
 */
async function executeWithBudget(executor, args, ctx, timeoutMs) {
  let timer;
  let toolAbort = null;
  let onParentAbort = null;
  let toolCtx = ctx;
  try {
    if (typeof AbortController === 'function') {
      toolAbort = new AbortController();
      const parent = ctx?.signal;
      if (parent && typeof parent.addEventListener === 'function') {
        onParentAbort = () => { try { toolAbort.abort(parent.reason); } catch { /* 取消失败不影响超时判定 */ } };
        if (parent.aborted) onParentAbort();
        else parent.addEventListener('abort', onParentAbort, { once: true });
      }
      toolCtx = { ...ctx, signal: toolAbort.signal };
    }
    return await Promise.race([
      Promise.resolve().then(() => executor(toolCtx, args)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = Object.assign(new Error(`工具执行超时 (${timeoutMs}ms)`), {
            timeout: true, abortRequested: false
          });
          if (toolAbort) {
            try { toolAbort.abort(error); } catch { /* ignore */ }
            error.abortRequested = toolAbort.signal.aborted === true;
          }
          reject(error);
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
    if (onParentAbort) {
      try { ctx?.signal?.removeEventListener?.('abort', onParentAbort); } catch { /* ignore */ }
    }
  }
}

/**
 * Repair only JSON-serialized send_message text shapes. Ordinary strings stay
 * untouched; JSON-looking inputs must parse to a string or an all-string array.
 */
function normalizeSerializedSendMessages(value) {
  if (typeof value !== 'string') return { ok: true, value };
  const source = value.trim();
  if (!source) return { ok: true, value };

  // Any array prefix is an attempted serialized list; malformed candidates fail closed.
  const jsonLike = source.startsWith('"') || source.startsWith('{') || source.startsWith('[');
  if (!jsonLike) return { ok: true, value };

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    // Match the legacy normalizer: unparsable JSON-looking text remains plain text.
    return { ok: true, value };
  }
  if (typeof parsed === 'string') return { ok: true, value: parsed };
  if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
    return { ok: true, value: parsed };
  }
  return { ok: false, error: 'send-message-json-shape-unsupported' };
}

function configuredTextSendLimit(receiptInput) {
  const scope = { chatKey: String(receiptInput?.chatKey ?? ''), kind: String(receiptInput?.kind ?? 'group') };
  const effective = typeof receiptInput?.effective === 'function'
    ? receiptInput.effective : receiptInput?.cfg?.effective;
  let value;
  try {
    const resolved = effective?.('send.maxPerRun', scope);
    value = resolved && typeof resolved === 'object' && Object.hasOwn(resolved, 'value')
      ? (resolved.found === false ? undefined : resolved.value)
      : resolved;
  } catch { /* use get() below */ }
  if (value === undefined || value === null) {
    try { value = receiptInput?.cfg?.get?.('send.maxPerRun', 4); } catch { /* use default */ }
  }
  if (value === undefined || value === null) value = 4;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 4;
}

function sendBudgetOf(receiptInput) {
  let budget = receiptInput?.sendBudget;
  if (!budget || typeof budget !== 'object') budget = { limit: configuredTextSendLimit(receiptInput), used: 0 };
  const parsedLimit = Number(budget.limit);
  if (!Number.isFinite(parsedLimit)) budget.limit = configuredTextSendLimit(receiptInput);
  else budget.limit = Math.max(0, Math.floor(parsedLimit));
  const parsedUsed = Number(budget.used);
  budget.used = Number.isFinite(parsedUsed) ? Math.max(0, Math.floor(parsedUsed)) : 0;
  return budget;
}

async function runOne(tool, args, plan, ctx, timeoutMs, resolvedIdempotencyKey = '') {
  const name = toolId(tool);
  const idempotencyKey = resolvedIdempotencyKey || toolCallKey(ctx, plan.action, name, args);
  const cachedEntry = idempotency.get(idempotencyKey);
  if (cachedEntry) {
    if (cachedEntry.pending) return cachedEntry.pending;            // 在途：共用同一次执行
    const payload = touchIdemPayload(idempotencyKey);
    if (payload) return payload;                                     // 正常重复：返回完整结果
    return idemDuplicateResult(cachedEntry.marker, idempotencyKey);  // 载荷淘汰：只防重、不重放
  }
  const pending = (async () => {
    try {
      const parameterErrors = validateToolParameters(tool.parameters, args);
      if (parameterErrors.length) {
        return failure(name, `参数校验失败：${parameterErrors.join('；')}`, idempotencyKey, 'failed', TOOL_REJECT_REASONS.SCHEMA_INVALID);
      }
      let data;
      if (name === 'send_message') {
        const normalizedMessages = normalizeSerializedSendMessages(args?.messages);
        if (!normalizedMessages.ok) return failure(name, normalizedMessages.error, idempotencyKey, 'failed', TOOL_REJECT_REASONS.SCHEMA_INVALID);
        // ★ N61：老树在这里用的是 `normalizeMessageList(args.messages)`（`src/tools.js:936`，字符串也归成
        //   一条元素的数组）。新树此前只做 JSON 碎片修复 ⇒ 模型传裸字符串时 `messages` 还是字符串，
        //   下面亢奋下限那道拿的 `messages.length` 成了**字符数**（"亢奋至少发 5 条"被一句 20 字的话蒙过去）。
        //   归一也顺带保住 `api.sendMessagesArrayOnly` 的开法：schema 只教数组，后台仍兼容字符串（老树同口径）。
        const messageList = normalizeMessageList(normalizedMessages.value);
        let sendArgs = { ...args, messages: messageList };
        // ★ 2026-10-09 N35：亢奋模式的两道硬锁照老树补回（`src/tools.js:931-943`）。
        //   新树这两道**原先都不在**：① 受保护 QQ 的 `@` 不剥离（`sanitizeHypeProtectedArgs`）
        //   ② 「亢奋时至少发 N 条」的连击下限不校验（`hypeMode.minMessages`，defaults.js:675 = 5）。
        //   后果：亢奋模式下模型可以只发 1 条、还能 @ 到那个被硬保护的号 —— 正是老树要拦的。
        //   出口来自 M7（`emotion/hype-mode.js:60/73`，N30 补齐的 5 个只读出口）；act 只调不改。
        const hype = ctx.modules?.emotion;
        if (typeof hype?.sanitizeHypeProtectedArgs === 'function') {
          const sanitized = hype.sanitizeHypeProtectedArgs(sendArgs);
          if (sanitized?.strippedAt && sanitized.args) sendArgs = sanitized.args;
        }
        if (typeof hype?.isHypeMode === 'function' && hype.isHypeMode()) {
          const hypeMin = Math.max(0, Number(ctx.cfg?.get?.('hypeMode.minMessages', 0)) || 0);
          const count = sendArgs.messages.length;
          if (hypeMin > 0 && count > 0 && count < hypeMin) {
            const sample = Array.from({ length: hypeMin }, (_, i) => `"${i + 1}"`).join(',');
            return failure(name, `亢奋模式至少发 ${hypeMin} 条（当前 ${count} 条）。把连击补满再 send_message，例如 [${sample}]。`,
              idempotencyKey, 'failed', TOOL_REJECT_REASONS.HYPE_COUNT_INSUFFICIENT);
          }
        }
        // ★ T-HYGIENE-FUNNEL：卫生检查只活在 send() 里（单检查点，不双洗）。
        //   这里只把配置透传进 receiptInput（opt-in 门要 cfg；默认门无 cfg 照开）。
        const receipt = await executeWithBudget((toolCtx) => send({
          signal: toolCtx.signal, deadline: toolCtx.deadline,
          ...sendArgs,
          chatKey: ctx.chatKey,
          kind: ctx.kind,
          evidenceId: ctx.evidenceId,
          action: `${plan.action}-${name}`,
          idempotencyKey,
          cfg: ctx.cfg,
          sendBudget: ctx.sendBudget,
          ...(typeof ctx?.effective === 'function' ? { effective: ctx.effective } : {})
        }, ctx.platform), {}, ctx, timeoutMs);
        if (!receipt.ok) {
          const error = String(receipt.error || '平台未确认发送');
          const blockedBy = error.startsWith('outbound-content-blocked:') ? 'outbound-content' : '';
          // ★ 心声兜底那条单独一个码（2026-10-13 裁定）⇒ 分布表能数出"被拦了几次"，
          //   不混进"平台没确认发出"里 —— 后者是投递问题，前者是内容被判成写给自己的话。
          const rejectCode = error.startsWith('outbound-content-blocked:inner-voice')
            ? TOOL_REJECT_REASONS.INNER_VOICE_BLOCKED
            : TOOL_REJECT_REASONS.SEND_NOT_CONFIRMED;
          return { ok: false, error, ...(blockedBy ? { blockedBy } : {}),
            state: receipt.state === 'unknown' ? 'unknown' : 'failed', tool: name, receipt, idempotencyKey,
            ...reasonField(rejectCode) };
        }
        // ★ 引用没挂上时把这件事写进结果（`replyQuoteVerdict` 第③件事）：消息确实发出去了，
        //   但平台按"查不到就不引用"处理了 ⇒ 不写出来，模型会以为自己引用成功了。
        data = {
          platformId: receipt.platformId,
          ...(receipt.hygiene ? { hygiene: receipt.hygiene } : {}),
          ...(ctx.replyQuote ? { quote: ctx.replyQuote } : {})
        };
        return { ok: true, data, state: 'completed', tool: name, receipt, idempotencyKey };
      }
      const executor = ctx.executors?.[name] || tool.execute;
      if (typeof executor !== 'function') {
        return failure(name, `未注入 ${name} 执行器`, idempotencyKey, 'failed', TOOL_REJECT_REASONS.EXECUTOR_MISSING);
      }
      const result = await executeWithBudget(executor, args, ctx, timeoutMs);
      if (result?.ok === false || result?.isError === true) {
        return failure(name, result.error ?? result.content ?? '工具执行失败', idempotencyKey, 'failed', TOOL_REJECT_REASONS.EXECUTOR_FAILED);
      }
      data = result?.data !== undefined ? result.data : result;
      // ★ P0-4：发图/发卡类工具只交出"已准备"载荷 ⇒ 由 act 统一投递，一次完成"准备 + 投递"。
      //   （`send_image(preview=true)` 不给 pendingSend ⇒ 落回普通只读路径，不投递。）
      if (MEDIA_PREPARE_TOOLS.has(name)) {
        const prepared = preparedMedia(data);
        if (prepared) return await finishPreparedMedia(name, prepared, data, plan, ctx, timeoutMs, idempotencyKey);
      }
      // ★ N48：send_forward 走文字投递（与 send_message 同一套守卫链 + 平台回执）
      if (FORWARD_PREPARE_TOOLS.has(name)) {
        const prepared = preparedForward(data);
        if (prepared) return await finishPreparedForward(name, prepared, data, plan, ctx, timeoutMs, idempotencyKey);
      }
      const evidenceIds = Array.isArray(data?.evidenceIds) ? data.evidenceIds : (ctx.evidenceId ? [String(ctx.evidenceId)] : []);
      return { ok: true, data, ...(tool.sideEffect === 'read' ? { evidenceIds } : {}), state: 'completed', tool: name, idempotencyKey };
    } catch (error) {
      // ★ 2026-10-19（S10）：被取消（AbortError）与超时同档 —— **不能声称失败/未发生**：
      //   已开始的写可能部分落地，统一记 unknown（保守、不重放）；真正的执行错误才是 failed。
      const cancelled = error?.abortRequested === true
        || error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
        || (typeof error?.name === 'string' && /abort/i.test(error.name));
      const state = error?.timeout || cancelled ? 'unknown' : 'failed';
      const reasonCode = error?.timeout ? TOOL_REJECT_REASONS.TIMEOUT
        : name === 'send_message' ? TOOL_REJECT_REASONS.SEND_NOT_CONFIRMED
        : TOOL_REJECT_REASONS.EXECUTOR_FAILED;
      const uncertainMessageCount = name === 'send_message' && state === 'unknown'
        ? (Array.isArray(args?.messages) ? args.messages.filter((message) => String(message ?? '').trim()).length
          : String(args?.text ?? '').trim() ? 1 : 0)
        : 0;
      return { ...failure(name, error, idempotencyKey, state, reasonCode), ...(uncertainMessageCount ? { uncertainMessageCount } : {}) };
    }
  })();
  idempotency.set(idempotencyKey, { pending });
  const result = await pending;
  if (keepsMemo(result, tool)) {
    // ★ S11：标记必须留下；完整载荷另存且可被 LRU 淘汰（标记在 ⇒ 永不重放副作用）。
    idempotency.set(idempotencyKey, { marker: idemMarkerOf(result) });
    rememberIdemPayload(idempotencyKey, result);
  } else {
    const current = idempotency.get(idempotencyKey);
    if (current?.pending === pending) idempotency.delete(idempotencyKey);
  }
  pruneIdemCaches();
  return result;
}

/** 执行已筛选工具；次数/总时长/单工具时长预算都在此强制。 */
export async function run(plan, ctx = {}) {
  const started = Date.now();
  const budget = ctx.budget || {};
  const maxCalls = Number.isFinite(Number(budget.maxCalls)) ? Math.max(0, Number(budget.maxCalls)) : 8;
  const maxMs = Number.isFinite(Number(budget.maxMs)) ? Math.max(0, Number(budget.maxMs)) : 30000;
  const timeoutMs = Number.isFinite(Number(budget.perToolTimeoutMs)) ? Math.max(1, Number(budget.perToolTimeoutMs)) : Math.max(1, maxMs);
  const requested = Array.isArray(plan?.toolPlan) ? plan.toolPlan : [];
  let runContext;
  try {
    // Fail closed before selection, availability checks, or executor lookup. This
    // keeps malformed base keys inside the act boundary instead of the M15 catch.
    runContext = { ...ctx, idempotencyKey: toolCallBaseKey(ctx, plan?.action) };
  } catch (error) {
    const reason = `工具幂等键无效，已 fail-closed：${String(error?.message ?? error)}`;
    return requested.map((item) => failure(item?.name, reason, 'invalid:tool:key',
      'failed', TOOL_REJECT_REASONS.INVALID_IDEMPOTENCY_KEY));
  }
  const availabilityContext = {
    ...(ctx.cfg || {}),
    effective: ctx.effective ?? ctx.cfg?.effective,
    chatKey: ctx.chatKey,
    kind: ctx.kind,
    skills: ctx.skills,
    runtimeContext: ctx.runtimeContext
  };
  const selected = selectTools(plan, { cfg: availabilityContext });
  const requestedByName = new Map();
  for (const item of requested) {
    const entries = requestedByName.get(item.name) || [];
    entries.push(item);
    requestedByName.set(item.name, entries);
  }
  const results = [];
  const selectedSet = new Set(selected);
  for (const item of requested) {
    if (!selectedSet.has(item.name)) {
      const availability = getToolAvailability(item.name, availabilityContext);
      results.push(failure(item.name, unavailableFailure(item.name, availability),
        toolCallKey(runContext, plan.action, item.name, item?.args ?? {}), 'failed',
        unavailableReasonCode(availability) || TOOL_REJECT_REASONS.TOOL_UNAVAILABLE));
    }
  }
  let calls = 0;
  // toolPlan is the authorization list for this turn; candidate selection can
  // only narrow it and can never add an executable tool.
  for (const name of selected) {
    const entries = requestedByName.get(name);
    if (!entries) continue;
    for (const item of entries) {
      if (calls >= maxCalls) {
        results.push(failure(name, '超过本轮工具调用次数预算', toolCallKey(runContext, plan.action, name, item?.args ?? {}),
          'failed', TOOL_REJECT_REASONS.CALL_BUDGET_EXHAUSTED));
        continue;
      }
      if (Date.now() - started >= maxMs) {
        results.push(failure(name, '超过本轮工具时间预算', toolCallKey(runContext, plan.action, name, item?.args ?? {}),
          'unknown', TOOL_REJECT_REASONS.TIME_BUDGET_EXHAUSTED));
        continue;
      }
      const tool = baseRegistry().get(name);
      const availability = getToolAvailability(name, availabilityContext);
      if (!tool || !availability.enabled) {
        results.push(failure(name, unavailableFailure(name, availability),
          toolCallKey(runContext, plan.action, name, item?.args ?? {}), 'failed',
          unavailableReasonCode(availability) || TOOL_REJECT_REASONS.TOOL_UNAVAILABLE));
        continue;
      }
      calls += 1;
      // 只服务这一个工具：编号先归一、再按本轮快照比对（见 imageViewRefVerdict）。
      // 放在幂等键之前 ⇒ `#7` / `"7"` / `7` 是同一个目标，不会被算成两次调用。
      const rawArgs = item?.args ?? {};
      let args = rawArgs;
      let replyQuote = null;
      if (name === 'get_message_images') {
        const verdict = imageViewRefVerdict(rawArgs, ctx);
        if (verdict.reject) {
          results.push(failure(name, verdict.reject, toolCallKey(runContext, plan.action, name, rawArgs),
            'failed', verdict.reasonCode));
          continue;
        }
        args = verdict.args;
      }
      // 引用目标同样先归一再核对（幂等键按归一后的形态算），核对出来的话只加进结果，不参与拦这次发送。
      if (name === 'send_message') {
        const verdict = replyQuoteVerdict(rawArgs, ctx);
        args = verdict.args;
        replyQuote = verdict.quote ?? null;
      }
      const callKey = toolCallKey(runContext, plan.action, name, args);
      const callContext = {
        ...runContext,
        idempotencyKey: callKey,
        ...(replyQuote ? { replyQuote } : {})
      };
      results.push(await runOne(tool, args, plan, callContext, Math.min(timeoutMs, Math.max(1, maxMs - (Date.now() - started))), callKey));
    }
  }
  return results;
}

/**
 * ★★ 2026-10-05 18:4x 指挥位补：**出站文本卫生链**（旧 `src/tools.js:976-1054` 那 6 道门，新树此前**一道都没有**）。
 *
 * 为什么必须补：真连实测——用户看到「各种乱七八糟的括号和引号」。根因就是旧树这组门没搬：
 *   · `blockJsonFragments`（默认开）：模型偶尔把**工具参数/JSON 碎片**当正文发出来
 *     （旧树实测原例：`["哭这么大声 我在隔壁湾都听见了"], "replyToMessageId":`），命中就**拦回去让它重说**；
 *   · `stripEmoji`（opt-in，本机配置**开着**）：句尾挂 emoji 会被剥掉；
 *   · `tidyBrackets`（opt-in）：清 `～】]` 这类学舌的方块尾巴；
 *   · `blockPureEnglish` / `blockAiSelfClaim` / 图片标注腔（后两条默认开）：拦住整段英文、自曝 AI、"图片 #N 描述："腔。
 * 判据一律走 `ctx.effective(key)`（新树的配置冻结出口），缺它时**按各自默认**（默认开的门仍开，opt-in 的仍关）。
 * ★ T-HYGIENE-FUNNEL：本函数是**唯一的发出前检查点**（`send()` 内调用，四条出站路径全经此）。
 *   `ctx` 形参接受任一带 `effective` / `cfg.effective` 的对象（runOne 传 ctx，send() 传 receiptInput；
 *   orchestrator 两处直调今天不带 cfg ⇒ 走默认门，要开 opt-in 门时由各调用方把 cfg 添进 receiptInput 即可，
 *   不必改本函数）。`opts.allowEmpty` 为真时允许空正文（媒体单发：旧树 `!messages.length && !looseSticker` 同理）。
 *
 * @returns {{ok:true, messages:string[], voices:string[]} | {ok:false, error:string, voices?:string[]}}
 *   `voices` = 从正文里摘下来的「（心声：…）」原文（W2，追加字段、不改既有字段名），**只供上层留档**，
 *   绝不进 `messages`。★ 2026-10-14 裁定②：形状门整条打回的那段作战稿**也并进 `voices`**（它就是心声，
 *   不许凭空消失）；写进 `session.innerVoice` 那一行在 orchestrator/index.js（W1 独占）⇒ 仍待分工落地。
 */
function applySendHygieneOne(messages, ctx, opts = {}) {
  const allowEmpty = opts?.allowEmpty === true;
  // ★ P0-4b（全树文案审计）：兼容显式标记的正文调用与模型 send_message 参数，两者被拦后的引导不同。
  //   A26 后 M15 不再把普通模型正文交给 send()；正常模型发言只走 send_message。
  const isBodyText = opts?.bodyText === true;
  const retryHint = isBodyText ? '这句正文已被丢弃、未发出；本路径不再处理' : '重新 send_message';
  const retryHintArg = isBodyText ? '这句正文已被丢弃、未发出；本路径不再处理' : '把真正要说的话（纯文字）放进 messages 数组重发';
  const emptyFail = (error) => (allowEmpty ? { ok: true, messages: [] } : { ok: false, error });
  const eff = typeof ctx?.effective === 'function' ? ctx.effective
    : (typeof ctx?.cfg?.effective === 'function' ? ctx.cfg.effective : null);
  // ★ N61：`effective()` 返回的是 `{ value, source, found }` **描述对象**（core/config-store/index.js:242），
  //   原来这里直接把它当配置值比较 ⇒ 五道门全塌：opt-in 的 `=== true`（stripEmoji / tidyBrackets）**永不触发**
  //   （本机 `send.stripEmoji=true` 是用户开着的），默认开的 `!== false` 三条**恒成立、关不掉**。
  //   判据不变（仍走 effective，保留会话级覆盖），只是先剥出值。
  const cfg = (key) => {
    if (!eff) return undefined;
    try {
      const resolved = eff(key, { chatKey: String(ctx?.chatKey ?? ''), kind: String(ctx?.kind ?? 'group') });
      if (resolved && typeof resolved === 'object' && Object.hasOwn(resolved, 'value')) {
        return resolved.found === false ? undefined : resolved.value;
      }
      return resolved;
    } catch { return undefined; }
  };
  const voices = [];
  let list = (Array.isArray(messages) ? messages : [messages]).map((m) => String(m ?? '')).filter((m) => m.trim());
  if (!list.length) return { ...emptyFail('消息内容为空'), voices };

  // ⓪ 心声剥离（W2 · 老树 splitInnerVoice 对位）：心声是模型写给自己看的独白，**绝不发进群**。
  //   与老树同理 —— 每一条消息、每一行都过一遍（模型会一边调 send_message 一边在 content 里留心声）。
  {
    const cleaned = [];
    for (const text of list) {
      const split = splitInnerVoice(text);
      if (split.voices.length) voices.push(...split.voices);
      if (split.text) cleaned.push(split.text);
    }
    list = cleaned;
    if (!list.length) {
      return {
        ...emptyFail(`这条只有「心声」（写给自己看的独白），没有要说给别人听的话。${isBodyText ? '这句正文已被丢弃、未发出；本路径不再处理。' : '把真正要发出口的那句重新说一遍。'}`),
        voices
      };
    }
  }
  // ★ 出站硬拦：内部分析/指令复述无论来自正文还是 send_message 参数，都不能发出去。
  // 使用窄判据，旧 narrationHit 的宽规则仍只用于正文路径，避免误伤工具参数里的正常聊天。
  for (const text of list) {
    if (internalDraftHit(text) >= 0) {
      return { ok: false, error: 'outbound-content-blocked:internal-analysis（内部分析或指令复述未发送；请直接回复对方）', voices };
    }
  }
  // ★ ⓪c 心声形状兜底（2026-10-13，指挥位裁定）：措辞是唯一覆盖面，这条只兜"末尾挂自我指示、全句无对方指向"这一种形状。
  //   与旧树那套宽判据的区别：命中条件要两条同时成立，实测 33 条真人口语 0 误拦；**不发、不丢**，原因回给模型让它重写。
  //   ★ 2026-10-13 追加形状：当天 4 条真漏句（delivered=true）收尾都不是"得接住"，
  //   而是整段"作战稿"（思路／消息组织／状态判断），另有 `looksLikePlanningMonologue` 按结构证据兜住。
  //   ★ 2026-10-13 再补一种：13:08:18 那条两段都没有骨架关键词、弱信号只有一条，三道门前两道都不认；
  //   它的结构特征是**收尾那一句同时在做两件事**（给自己派取证活 + 告诫自己别凭印象说话），`looksLikeSelfInquiryTail` 兜这种。
  //   ★ 2026-10-14 指挥位裁定①（强度）：命中就**整条打回**，不"剥掉那一行剩下的照发"——
  //     实测 00:25 案剥完剩 78+6 字、00:38 案剩 50 字，两条剩句都不对着谁、也都不命中现有判据，剥了照发只会更糟。
  //     这条判据**作用在工具参数上**（`list` 就是 send_message 的 messages），正是老树那四处回退（都在"本轮没调工具"里）覆盖不到的地方。
  //   ★ 2026-10-14 指挥位裁定②（去处）：被打回的这段本身就是心声 ⇒ 并进 `voices` 交上层留档，别让它凭空消失。
  //   ★ 2026-10-14 第四道（事故 `m15-15`，213 字零标签独白被 body-dispatch 合成成 send_message 发出去了）：
  //     前三道都不认这种"盘点上下文→权衡说不说→我决定…就说…"的**决策独白**，而且引号里的草稿句
  //     「所以你肥不肥」还把第一道的受话人豁免触发了 ⇒ `looksLikeDecisionMonologue` 先剥引用再判，
  //     要求"无受话人标记 + 第三人称指称 + 同句自我宣布说话行为"三条同时成立。
  //     实测：36,450 条 `self=true` 真实出站里单独命中 1 条，就是这条已确认漏句 ⇒ 误拦 0、漏句 1/1。
  for (const text of list) {
    const shapeReason = looksLikeSelfDirective(text)
      ? '这句收在"得接住／应一声"这类写给自己的指示上，整句也没有对着谁说的话，判定是心声，未发出。'
      : looksLikePlanningMonologue(text)
        ? '这段是写给自己的作战稿（行首挂着"接法：""消息组织："这类计划标签，或思路／状态判断一类的内容），不是要对对方说的话，判定是心声，未发出。'
        : looksLikeSelfInquiryTail(text)
          ? '这段最后收在给自己派活的话上（"先查一下…别拿印象说"这类），全段没有一句是对着对方说的，判定是心声，未发出。'
          : looksLikeDecisionMonologue(text)
            ? '这段是决策独白——在宣布"我打算怎么说"（盘点上下文→权衡说不说→"我决定…就说…"），对当前受话人用的是第三人称，判定是心声，未发出。'
            : null;
    if (!shapeReason) continue;
    return {
      ok: false,
      error: 'outbound-content-blocked:inner-voice（' + shapeReason
        + `${isBodyText ? '这句正文已被丢弃、未发出；本路径不再处理。' : '把真正要对对方说的那句重新 send_message 一次；想法写正文或 finish.summary，那些不会发出去。'}）`,
      voices: isBodyText ? voices : [...voices, text]
    };
  }
  // ⓪b 独白否决（W2 · 老树 looksLikeNarration 对位，一票否决）：判据逐条照抄老树，
  //   宁可少拦也不许把该说的话拦死 —— 命中说明这段是内心戏，不是要说给群里听的。
  //   ★ 2026-10-06 指挥位裁定：只有调用方显式传 `opts.narrationGuard === true` 才开这道门。
  //     老树 `looksLikeNarration` 调用点作用于正文/未发送内容，不作用于 `send_message` 的工具参数；
  //     A26 后普通模型正文不会进入 send()，模型 send_message 仍不走这道门。
  //     实测（.tmp-dispatch/牙-W2-误杀率.mjs）：这套判据对"真人在群里会说的话"误杀 13/30，
  //     例如「接不接都行 你定」「先决定吃啥」「打算发个朋友圈」「准备发工资了 兄弟们」「不用查记忆 我记得这事」
  //     ——老树宁可漏拦也不许把话拦死的初衷，正是为了这些。工具参数若也过这道门，
  //     模型**已经写好的**一句话会被判成内心戏并收到报错（它无法自我修正）⇒ 静默丢话。
  if (opts.narrationGuard === true) {
    let hitIndex = -1;
    let hit = '';
    for (const t of list) {
      const i = narrationHit(t);
      if (i >= 0) { hitIndex = i; hit = t; break; }
    }
    if (hitIndex >= 0) {
      return { ok: false, error: `这句是内心戏/计划，不是要说给群里听的话（命中判据 #${hitIndex}）：「${String(hit).slice(0, 40)}」。${isBodyText ? '这句正文已被丢弃、未发出；本路径不再处理。' : '直接回群里那句话，别把「怎么回、要不要回」写出来。'}`, voices };
    }
  }

  // ① 方块装饰（send.tidyBrackets，opt-in）
  if (cfg('send.tidyBrackets') === true) {
    const cleaned = [];
    for (const text of list) { const t = tidyBrackets(text); if (t) cleaned.push(t); }
    list = cleaned;
    if (!list.length) return { ...emptyFail('这条消息清掉方块标记之后是空的，重新说一句正常的话。'), voices };
  }
  // ② emoji（send.stripEmoji，opt-in）
  if (cfg('send.stripEmoji') === true) {
    const cleaned = [];
    for (const text of list) { const s = stripEmoji(text); if (s) cleaned.push(s); }
    list = cleaned;
    if (!list.length) return { ...emptyFail('这条消息去掉 emoji 之后是空的（本机设置不许发 emoji）。换句话再说一遍，别拿 emoji 顶字数。'), voices };
  }
  if (!list.length) return { ...emptyFail('消息内容为空'), voices };

  // ③ 中文优先（send.blockPureEnglish，默认开）：拦「像句子」的整段英文
  if (cfg('send.blockPureEnglish') !== false) {
    const bad = [];
    for (const text of list) {
      const t = String(text || '');
      const cjk = (t.match(/[一-鿿]/g) || []).length;
      if (cjk > 0) continue;
      const words = t.match(/[A-Za-z][A-Za-z']*/g) || [];
      if (t.trim().length >= 8 && words.length >= 3) bad.push(t.slice(0, 40));
    }
    if (bad.length) return { ok: false, error: `这几句是纯英文，群里默认说中文。改成中文再说：「${bad[0]}」。允许夹一两个英文词，但主体要是中文。`, voices };
  }
  // ④ 不许自曝 AI（send.blockAiSelfClaim，默认开）
  if (cfg('send.blockAiSelfClaim') !== false) {
    const hit = list.find((t) => looksLikeAiSelfClaim(t));
    if (hit) return { ok: false, error: `禁止发「自称 AI/模型/程序」的话：「${String(hit).slice(0, 40)}」。你是角色卡里那只鲸，按人设装傻/反讽/转移话题，${retryHint}。`, voices };
  }
  // ⑤ 结构碎片（send.blockJsonFragments，默认开）← 用户实测症状的正主
  if (cfg('send.blockJsonFragments') !== false) {
    const fragHit = list.find((t) => looksLikeToolArgFragment(t));
    if (fragHit) return { ok: false, error: `这条不是要发的话，是工具参数的碎片：「${String(fragHit).slice(0, 60)}」。${retryHintArg}。`, voices };
  }
  // ⑥ 图片标注腔（旧树无条件拦）
  {
    const capHit = list.find((t) => /图片\s*#?\d*\s*描述/.test(String(t || '')));
    if (capHit) return { ok: false, error: `别发图片标注：「${String(capHit).slice(0, 40)}」。群里怎么看图就怎么说人话 —— 一两句随口的反应就行（「这猫吓得耳朵都贴后脑勺了」），不要「图片 #N 描述：…」这种格式，也别把一句话拆成好几条。`, voices };
  }
  return { ok: true, messages: list, voices };
}

/** 每条消息单独过同一套兜底门，拦截项记原因并剔除，其余按原顺序继续发送。 */
export function applySendHygiene(messages, ctx, opts = {}) {
  const input = Array.isArray(messages) ? messages : [messages];
  const nonEmpty = input
    .map((message, index) => ({ index, text: String(message ?? '') }))
    .filter((item) => item.text.trim());
  if (!nonEmpty.length) {
    const empty = applySendHygieneOne(input, ctx, opts);
    return { ...empty, inputCount: 0, acceptedCount: 0, acceptedIndexes: [], dropped: [] };
  }

  const kept = [];
  const voices = [];
  const dropped = [];
  const reasonOf = (error) => {
    const value = String(error ?? '');
    if (value.startsWith('outbound-content-blocked:internal-analysis')) return 'internal-analysis';
    if (value.startsWith('outbound-content-blocked:inner-voice')) return 'self-directive-shape';
    if (value.includes('只有「心声」')) return 'inner-voice-only';
    if (value.includes('内心戏/计划')) return 'narration';
    if (value.includes('纯英文')) return 'pure-english';
    if (value.includes('自称 AI/模型/程序')) return 'ai-self-claim';
    if (value.includes('工具参数的碎片')) return 'json-fragment';
    if (value.includes('图片标注')) return 'image-caption';
    if (value.includes('方块标记之后是空')) return 'tidy-brackets-empty';
    if (value.includes('去掉 emoji 之后是空')) return 'emoji-only';
    return 'content-guard';
  };
  const guardErrors = [];
  for (const item of nonEmpty) {
    const result = applySendHygieneOne([item.text], ctx, opts);
    if (Array.isArray(result.voices)) voices.push(...result.voices);
    const text = result.ok ? String(result.messages?.[0] ?? '') : '';
    if (text.trim()) kept.push({ index: item.index, text });
    else {
      dropped.push({ index: item.index + 1, reason: reasonOf(result.error) });
      guardErrors.push(String(result.error ?? ''));
    }
  }

  const report = {
    inputCount: nonEmpty.length,
    acceptedCount: kept.length,
    acceptedIndexes: kept.map((item) => item.index + 1),
    dropped
  };
  if (!kept.length && opts?.allowEmpty !== true) {
    // ★ 全批被拦时，把守卫原本要说的那句**原因**留给模型（2026-10-13）：
    //   以前这里一律换成 batch-all-rejected + 内部标签（如 self-directive-shape），
    //   模型只看得到标签、不知道该重写什么 ⇒ "不丢但要告诉模型"落空。
    //   同一条判据命中全部输入时，直接回那条判据的原文；不同判据才回聚合行。
    const shared = guardErrors.length > 0 && guardErrors.every((errorText) => errorText === guardErrors[0])
      ? guardErrors[0] : '';
    if (shared) {
      const indexes = dropped.map((item) => item.index).join('、');
      return {
        ok: false,
        error: nonEmpty.length > 1 ? `${shared}（第${indexes}条同因）` : shared,
        messages: [], voices, ...report
      };
    }
    const reasons = dropped.map((item) => `第${item.index}条 ${item.reason}`).join('；');
    return {
      ok: false,
      error: `outbound-content-blocked:batch-all-rejected（输入 ${nonEmpty.length} 条，全部被守卫丢弃：${reasons || '无可发送内容'}）`,
      messages: [], voices, ...report
    };
  }
  return { ok: true, messages: kept.map((item) => item.text), voices, ...report };
}

/** 媒体文字沿用旧合同：这里只查原有的 internalDraft 门，不扩到正文/工具文本的其它判据。 */
function applyMediaTextGuard(texts) {
  const input = Array.isArray(texts) ? texts.map((text) => String(text ?? '')) : [];
  const messages = [];
  const acceptedIndexes = [];
  const dropped = [];
  for (let index = 0; index < input.length; index += 1) {
    if (internalDraftHit(input[index]) >= 0) dropped.push({ index: index + 1, reason: 'internal-analysis' });
    else { messages.push(input[index]); acceptedIndexes.push(index + 1); }
  }
  return { ok: true, messages, inputCount: input.length, acceptedCount: messages.length, acceptedIndexes, dropped, voices: [] };
}

/** 发送并构造合同回执。仅平台原始回执中的 messageId 可产生 ok=true。 */
export async function send(receiptInput, platform) {
  let idempotencyKey = String(receiptInput?.idempotencyKey || '');
  try {
    if (!idempotencyKey) idempotencyKey = makeIdempotencyKey(String(receiptInput?.chatKey || ''), String(receiptInput?.evidenceId || ''), String(receiptInput?.action || 'send'));
  } catch (error) {
    return makeSendReceipt({ ok: false, at: Date.now(), error: error.message, idempotencyKey: 'invalid:send:key' });
  }
  if (sendIdempotency.has(idempotencyKey)) {
    // Reuse is correct for the same real outbound message/platform id; synthetic M15 keys must
    // already distinguish rounds. Any confirmed partial delivery is also retained to avoid duplicates.
    const previous = await sendIdempotency.get(idempotencyKey);
    if (previous) return previous;
  }
  const pending = (async () => {
    // ★ T-HYGIENE-FUNNEL：唯一的发出前卫生检查点（四条出站路径全经 send()）。
    //   配置经 receiptInput 透传（receiptInput.effective ?? receiptInput.cfg?.effective；runOne 见下）。
    //   不带配置的调用方走各自默认门（默认开的仍开）—— 拦模型碎片的那几道门不需要任何配置。
    //   媒体单发允许空正文（旧树 !messages.length && !looseSticker 同理）；caption 照常过门。
    const originalMedia = Array.isArray(receiptInput?.media) ? receiptInput.media : [];
    const textMedia = [];
    for (let index = 0; index < originalMedia.length; index += 1) {
      if (originalMedia[index]?.type === 'text') textMedia.push({ mediaIndex: index, text: String(originalMedia[index].text ?? originalMedia[index].content ?? '') });
    }
    const messageHygiene = applySendHygiene(receiptInput?.messages, receiptInput, {
      allowEmpty: originalMedia.length > 0,
      // ★ P0-4b（全树文案审计）：同一句报错对**两条路径**只有一个是对的 ⇒ 卫生链文案要按路径分叉。
      //   正文路径（orchestrator/index.js:1020 打标 `bodyText:true`）：拦下 = 这句没发出去，
      //   正确指引是"把正文重写一遍"；只有工具路径才该说"重新 send_message / 放进 messages 数组"。
      bodyText: receiptInput?.bodyText === true,
      // ★ 2026-10-06 指挥位：独白否决只对"模型正文被当消息发"那条路开（见 applySendHygiene ⓪b）。
      //   正文路径由 orchestrator 显式打标 `bodyText: true`；工具参数（模型自己写好的 send_message）
      //   因此**不过**这道门，只过心声剥离 —— 与老树一致。
      narrationGuard: receiptInput?.bodyText === true
    });
    const mediaTextHygiene = applyMediaTextGuard(textMedia.map((item) => item.text));
    const acceptedMediaTexts = new Map();
    for (let i = 0; i < (mediaTextHygiene.acceptedIndexes ?? []).length; i += 1) {
      const source = textMedia[(mediaTextHygiene.acceptedIndexes[i] ?? 0) - 1];
      if (source) acceptedMediaTexts.set(source.mediaIndex, mediaTextHygiene.messages[i]);
    }
    let media = originalMedia.flatMap((item, index) => {
      if (item?.type !== 'text') return [item];
      if (!acceptedMediaTexts.has(index)) return [];
      return [{ ...item, text: acceptedMediaTexts.get(index) }];
    });
    let messages = messageHygiene.messages ?? [];
    const dropped = [
      ...(messageHygiene.dropped ?? []).map((item) => ({ ...item, source: 'messages' })),
      ...(mediaTextHygiene.dropped ?? []).map((item) => ({
        ...item,
        index: textMedia[(item.index ?? 0) - 1]?.mediaIndex + 1 || item.index,
        source: 'media.text'
      }))
    ];
    const sendBudget = sendBudgetOf(receiptInput);
    const sendLimit = sendBudget.limit;
    const usedBefore = sendBudget.used;
    const acceptedMediaTextCount = () => media.filter((item) => item?.type === 'text').length;
    const textCountBeforeLimit = messages.length + acceptedMediaTextCount();
    const availableText = sendLimit > 0 ? Math.max(0, sendLimit - usedBefore) : textCountBeforeLimit;
    // 2026-10-29 她点的「怎么又开始大长段了」：群里一条只干一件事。
    // 单条正文超过 18 字就在最后一个逗号处拆成两条，句末句号去掉（qq-split.js）。私聊不动。
    messages = splitLongGroupBubbles(messages, receiptInput?.chatKey, {
      cap: sendLimit > 0 ? availableText : Number.POSITIVE_INFINITY
    });
    let limitDroppedCount = 0;
    if (sendLimit > 0 && textCountBeforeLimit > availableText) {
      const keepMessages = Math.min(messages.length, availableText);
      let remainingForMediaText = Math.max(0, availableText - keepMessages);
      const keepMediaText = remainingForMediaText;
      limitDroppedCount += messages.length - keepMessages;
      messages = messages.slice(0, keepMessages);
      let keptMediaText = 0;
      media = media.filter((item) => {
        if (item?.type !== 'text') return true;
        if (keptMediaText < keepMediaText) { keptMediaText += 1; return true; }
        limitDroppedCount += 1;
        return false;
      });
      for (let index = 0; index < limitDroppedCount; index += 1) {
        dropped.push({ index: index + 1, reason: 'send.maxPerRun', source: 'send.maxPerRun' });
      }
    }
    const retainedTextCount = messages.length + acceptedMediaTextCount();
    const hasSendablePayload = messages.length > 0 || media.length > 0;
    // 守卫那句原因原样交给模型（判据是同一条时不再换成内部标签）；媒体文字另有原因才聚合。
    const guardError = String(messageHygiene.error ?? '').startsWith('outbound-content-blocked:inner-voice')
      && dropped.every((item) => item.reason === 'self-directive-shape')
      ? String(messageHygiene.error) : '';
    const rejectedError = limitDroppedCount && !hasSendablePayload
      ? `send.maxPerRun: 本轮文字发送上限 ${sendLimit} 条已用完，另有 ${limitDroppedCount} 条文字未发送`
      : guardError || `outbound-content-blocked:batch-all-rejected（输入 ${messageHygiene.inputCount + (mediaTextHygiene.inputCount ?? 0)} 条文字，全部被守卫丢弃：${dropped.filter((item) => item.reason !== 'send.maxPerRun').map((item) => `${item.source}第${item.index}条 ${item.reason}`).join('；') || '无可发送内容'}）`;
    const hygiene = {
      ok: hasSendablePayload || (!dropped.length && messageHygiene.ok && originalMedia.length > 0),
      error: !hasSendablePayload && dropped.length ? rejectedError : messageHygiene.error,
      messages,
      voices: [...(messageHygiene.voices ?? []), ...(mediaTextHygiene.voices ?? [])],
      inputCount: (messageHygiene.inputCount ?? 0) + (mediaTextHygiene.inputCount ?? 0),
      acceptedCount: retainedTextCount,
      acceptedIndexes: (messageHygiene.acceptedIndexes ?? []).slice(0, messages.length),
      dropped
    };
    const hasMedia = media.length > 0;
    let requestedCount = messages.filter((message) => String(message ?? '').trim()).length;
    let atomicSegments = false;
    let platformCallStarted = false;
    const makeCoveredReceipt = (fields, receiptIds = []) => {
      const receipt = makeSendReceipt({ ...fields, idempotencyKey });
      // Coverage is M10's verification metadata; the SendReceipt's frozen base
      // fields remain contract-valid and the platform layer never constructs it.
      receipt.coverage = {
        requestedCount,
        receiptCount: receiptIds.length,
        receiptIds: receiptIds.map(String),
        ...(atomicSegments ? { atomic: true } : {})
      };
      if (hygiene.dropped?.length) {
        const droppedSummary = hygiene.dropped.map((item) => `第${item.index}条 ${item.reason}`).join('；');
        const guardDroppedCount = hygiene.dropped.filter((item) => item.reason !== 'send.maxPerRun').length;
        const sendLimitDroppedCount = hygiene.dropped.length - guardDroppedCount;
        const summary = sendLimitDroppedCount > 0
          ? `批次输入 ${hygiene.inputCount} 条，守卫丢弃 ${guardDroppedCount} 条、发送上限截去 ${sendLimitDroppedCount} 条（${droppedSummary}），保留 ${hygiene.acceptedCount} 条；平台回执 ${receiptIds.length} 条。`
          : `批次输入 ${hygiene.inputCount} 条，守卫丢弃 ${guardDroppedCount} 条（${droppedSummary}），保留 ${hygiene.acceptedCount} 条；平台回执 ${receiptIds.length} 条。`;
        receipt.hygiene = {
          inputCount: hygiene.inputCount,
          acceptedCount: hygiene.acceptedCount,
          acceptedIndexes: hygiene.acceptedIndexes,
          dropped: hygiene.dropped.map((item) => ({ ...item })),
          platformReceiptCount: receiptIds.length,
          summary
        };
      }
      // 编排层要把“实际发出的文本”投影进 session/历史，不能从原始参数猜（心声剥离等规则会改写文本）。
      // 不枚举此字段，避免把消息正文附带进 round-finished 回执日志。
      Object.defineProperty(receipt, 'sentTextMessages', {
        value: messages.slice(), enumerable: false, configurable: false, writable: false
      });
      return receipt;
    };
    if (!hygiene.ok) return makeCoveredReceipt({ ok: false, at: Date.now(), error: hygiene.error });
    try {
      if (media.length) {
        if (typeof platform?.sendSegments !== 'function') throw new Error('platform.sendSegments 不是可用的公开媒体发送出口');
        const segments = mediaToSegments(media, messages, receiptInput.atUserId, receiptInput.chatKey);
        if (!segments.length) throw new Error('发送请求没有有效媒体段');
        requestedCount = segments.length;
        atomicSegments = true;
        sendBudget.used += retainedTextCount;
        platformCallStarted = true;
        const raw = await platform.sendSegments(receiptInput.chatKey, segments, {
          signal: receiptInput.signal, deadline: receiptInput.deadline,
          replyToMessageId: receiptInput.replyToMessageId,
          atUserId: receiptInput.atUserId,
          idempotencyKey
        });
        const messageId = raw?.message_id;
        const hasReceipt = messageId !== undefined && messageId !== null && String(messageId).trim() !== '';
        const ids = hasReceipt ? [String(messageId)] : [];
        const receipt = makeCoveredReceipt({
          ok: hasReceipt,
          ...(hasReceipt ? { platformId: String(messageId) } : {}),
          at: Date.now(),
          ...(!hasReceipt ? { error: '媒体发送未取得平台 message_id 回执' } : {})
        }, ids);
        if (!hasReceipt) receipt.state = 'unknown';
        return receipt;
      }
      if (typeof platform?.sendTextBatch !== 'function') throw new Error('platform.sendTextBatch 不是可用的公开发送出口');
      if (requestedCount === 0) throw new Error('发送请求没有有效消息或媒体');
      sendBudget.used += retainedTextCount;
      platformCallStarted = true;
      const raw = await platform.sendTextBatch(receiptInput.chatKey, messages, {
        replyToMessageId: receiptInput.replyToMessageId,
        atUserId: receiptInput.atUserId,
        signal: receiptInput.signal, deadline: receiptInput.deadline,
        idempotencyKey
      });
      const sent = Array.isArray(raw?.sent) ? raw.sent : [];
      const ids = sent.map((entry) => entry?.messageId).filter((value) => value !== undefined && value !== null && String(value).trim());
      const uniqueIds = new Set(ids.map(String));
      const failed = Array.isArray(raw?.failed) ? raw.failed : [];
      const blocked = Array.isArray(raw?.blocked) ? raw.blocked : [];
      const nonSentIndexes = [...failed, ...blocked].map((entry) => entry?.index);
      const nonSentIndexesValid = nonSentIndexes.every((index) => Number.isInteger(index) && index >= 0 && index < requestedCount)
        && new Set(nonSentIndexes).size === nonSentIndexes.length;
      const covered = sent.length === requestedCount && ids.length === requestedCount && uniqueIds.size === requestedCount;
      const responseComplete = sent.length + failed.length + blocked.length === requestedCount
        && ids.length === sent.length && uniqueIds.size === sent.length
        && nonSentIndexesValid;
      if (responseComplete && sent.length < requestedCount) {
        // The platform accounted for these items as not sent; they do not consume the run's sent-text quota.
        sendBudget.used = Math.max(0, sendBudget.used - (requestedCount - sent.length));
      }
      const ok = requestedCount > 0 && covered && failed.length === 0 && blocked.length === 0 && responseComplete;
      // ★ N3：把「已知失败（可重试）」与「真未知（不重发）」分成两个明确类别，各带一个理由码。
      //   口径（指挥位定死，照做）：
      //   · 真未知（回执自相矛盾、覆盖不足）⇒ `state:'unknown'` ⇒ **不自动重发**（fail-closed）。
      //     不确定发没发出去时宁可漏发，也不冒"重复发一条"的险 —— 这是 `2527f108` 的原意，**不许改回去**。
      //   · 已知失败（平台逐条交代了，带 index）⇒ **不是 unknown** ⇒ 同键可重试（重试不可能造成重复）。
      //
      //   理由码**独立于**下面的错误文案分支算（文案保持逐字不变，有别的断言钉着）：
      //   平台把每条都交代了 ⇒ 我们**确知**每一条的结果；只有"它自己都对不上账"才是真未知。
      const nonSentCount = failed.length + blocked.length;
      // ★ 2026-10-18（#13）：平台逐条交代过（responseComplete）且一条都没发出去 ⇒ **已知失败**。
      //   这句话只作为覆盖说明的后缀，旧文案（/回执覆盖不完整/ 有断言钉着）保持不变；
      //   模型/日志能据此分清"确定未发出"与"结果未知（不要重发）"。
      const allKnownNotSent = nonSentCount === requestedCount && requestedCount > 0
        && sent.length === 0 && ids.length === 0;
      let reasonCode = null;
      if (!responseComplete) reasonCode = 'unknown_incomplete_receipt';
      else if (sent.length === 0 && ids.length === 0 && nonSentCount === requestedCount) {
        // ★ 已知全败：一条都没发出去，且平台逐条给了 index ⇒ 重发不可能造成重复。
        reasonCode = failed.length > 0 ? 'known_all_failed' : 'known_all_blocked';
      } else if (!covered) reasonCode = ids.length > 0 ? 'known_partial_no_receipt' : 'known_no_receipt';
      else if (nonSentCount > 0) reasonCode = 'known_partial_failed';
      let error;
      if (!responseComplete) error = '平台发送结果不完整或互相矛盾，结果未知';
      else if (!covered && ids.length > 0 && ids.length < requestedCount) error = `partial: 请求 ${requestedCount} 条 / 回执 ${ids.length} 条`;
      else if (!covered) error = `回执覆盖不完整：请求 ${requestedCount} 条 / 回执 ${ids.length} 条${allKnownNotSent ? '（平台逐条确认全部未发出，未有投递）' : ''}`;
      else if (failed.length || blocked.length) error = `平台未发送 ${failed.length + blocked.length} 条消息`;
      const receipt = makeCoveredReceipt({ ok, ...(ids[0] !== undefined ? { platformId: String(ids[0]) } : {}), at: Date.now(), ...(error ? { error } : {}) }, ids);
      if (reasonCode) receipt.reasonCode = reasonCode;
      if (!ok && !responseComplete) receipt.state = 'unknown';
      else if (!ok) receipt.state = 'failed';   // 已知失败：显式标出来（全树只判 === 'unknown'，故不影响既有消费者）
      return receipt;
    } catch (error) {
      const receipt = makeCoveredReceipt({ ok: false, at: Date.now(), error: String(error?.message ?? error) });
      // ★ N3 口径不变（抛异常按真未知、fail-closed），但**已知全败已改由平台层结构化返回**：
      //   2026-10-18（#13）起 `platform/sender.js sendTextBatch` 全败不再 throw，而是返回
      //   `{sent:[], failed:[{index,…}]}`（上面 responseComplete 分支按 state=failed 分类）。
      //   走到这里的抛错只剩：发送前校验失败（platformCallStarted=false ⇒ state=failed）与
      //   真正的传输异常（⇒ state=unknown）。reasonCode 名称保留（内部排障串，语义=平台层抛错、无法逐条交代）。
      receipt.reasonCode = 'platform_threw_unknown_or_all_failed';
      if (platformCallStarted) receipt.state = 'unknown';
      return receipt;
    }
  })();
  sendIdempotency.set(idempotencyKey, pending);
  const receipt = await pending;
  if (receipt?.ok === true || receipt?.state === 'unknown' || receiptProvesSomeDelivery(receipt)) {
    sendIdempotency.set(idempotencyKey, receipt);
  } else if (sendIdempotency.get(idempotencyKey) === pending) {
    sendIdempotency.delete(idempotencyKey);
  }
  // ★ S11：发送回执缓存同样有界；unknown/在途保留，已终结的可安全淘汰。
  pruneIdemCaches();
  return receipt;
}

/** 未有成功且有效的平台回执，绝不认定为已发送。 */
export function assertDelivered(results) {
  const reasons = [];
  let delivered = false;
  for (const result of Array.isArray(results) ? results : []) {
    if (result?.receipt) {
      if (result?.state === 'unknown' || result.receipt?.state === 'unknown') {
        reasons.push(`发送结果未知：${result.receipt.error || result.error || '平台调用未取得回执'}`);
        continue;
      }
      const validation = validateSendReceipt(result.receipt);
      const coverage = result.receipt.coverage || result.coverage;
      const coverageValid = coverage
        && Number.isInteger(coverage.requestedCount)
        && coverage.requestedCount > 0
        && Array.isArray(coverage.receiptIds)
        && coverage.receiptIds.every((id) => typeof id === 'string' && id.length > 0)
        && new Set(coverage.receiptIds).size === coverage.receiptIds.length
        && String(result.receipt.platformId || '') === coverage.receiptIds[0]
        && (coverage.atomic === true
          ? coverage.receiptCount === 1 && coverage.receiptIds.length === 1
          : coverage.receiptCount === coverage.requestedCount && coverage.receiptIds.length === coverage.requestedCount);
      if (validation.ok && result.receipt.ok === true && result.receipt.platformId && coverageValid) delivered = true;
      else reasons.push(...(validation.ok
        ? [result.receipt.error || (coverageValid ? '发送回执未确认成功' : '缺少完整请求/回执覆盖信息')]
        : validation.errors));
    } else if (result?.tool === 'send_message' || result?.sent === true) {
      reasons.push('缺少平台回执');
    }
  }
  if (!delivered && reasons.length === 0) reasons.push('没有可核验的发送回执');
  return { delivered, reasons };
}

/** 自测辅助：清掉本进程注册和幂等状态。 */
export function resetActState() {
  toolRegistry.clear();
  idempotency.clear();
  idemPayloads.clear();
  sendIdempotency.clear();
  disabledBuiltIns.clear();
  undeclaredSideEffects.clear();
}
