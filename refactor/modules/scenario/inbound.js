/**
 * M5 scenario · inbound.js —— 一条原始入站消息 → 规范化事实记录
 *
 * 这里**不做任何推断**：不猜动机、不判人格、不判真伪、不做情绪分类（那是 M7 的活）。
 * 只回答五个"谁/什么"：
 *   ① 谁发的（sender，且"机器人自己发的"单独标出来）
 *   ② 正文是什么（text：规范化但**不改写原文**）
 *   ③ 本条 @ 了谁（mentions：只读本条的段）
 *   ④ 本条引用了哪条（refs：replyTo 一定有；quoted 拿到才给；被引内容绝不进 text）
 *   ⑤ 本条带了什么媒体（media：只有"存在 + 已知描述"，没有发送者字段）
 *
 * 纯函数：无 IO / 无时钟（时间一律从入参取）/ 无随机。
 */
import {
  collectMedia,
  collectMentions,
  collectRefs,
  findReplySegment,
  isSelfId,
  normalizeId,
  normalizeMediaList,
  renderText,
  toSegments
} from './segments.js';
import { ScenarioError, SCENARIO_ERROR_CODES } from './errors.js';

/**
 * 正文字符上界**默认值**：只防"一整篇被粘进来"（一条转发卡片就能把提示词顶爆），不做概括。
 * ★ 阈值可由 `options.maxTextChars` 覆盖（裁定 2）；截断**必须留痕**，绝不静默：
 *   记录进 `record.truncations[]` → 最终落成 `diagnostics.truncated[{evidenceId, originalChars, keptChars}]`。
 *   **不许**往 evidence 对象上加字段（会被 M0 契约拒）。
 */
export const MAX_TEXT_CHARS = 8000;

/** 有效阈值：非法/缺省一律回落默认 8000（负数、0、NaN、小数全部不算数）。 */
export function resolveTextLimit(maxTextChars) {
  return Number.isSafeInteger(maxTextChars) && maxTextChars > 0 ? maxTextChars : MAX_TEXT_CHARS;
}

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * 正文里出现机器人名字就算"在叫它"（**纯文本形态**：没有 CQ `at` 段）。
 *
 * ★ 为什么必须补这一支（2026-10-05 指挥位尺子 S4-7 抓到的红行）：群里主人**手打**
 *   「@症状尺 在吗」—— 没有 CQ 段，就是普通文本。旧树 `isAtMe`（`src/prompt.js:958-961`）
 *   的兜底路正是为此存在的（`t.includes('@'+name)`），而本模块原来的 `calledByName`
 *   只判 `head.startsWith(name)` ⇒ **以 @ 开头的文本永远不匹配** ⇒ 只@档里被判成"没点名" ⇒
 *   `tier_restricted` 直接抑制 ⇒ 主人看到"它不理我"。
 *
 * ★ 两把刀的边界**逐字照旧树**（`src/prompt.js`）：
 *   · `isAtMe`（:940-963）②昵称兜底：`@名字` / `@ 名字` 可在**任意位置**；旧树是裸 `includes`，
 *     **没有尾边界** ⇒ 「@症状尺的朋友们」在旧树会被认。**本实现比旧树严**：名字后面必须
 *     是分隔符/标点/呼唤词（见下 `TAIL`）⇒ 挡住 `@名字的朋友们`、`@名字啊`、`名字们` 这类
 *     误命中。**这是有意的收紧**，理由：把机器人当"前缀词"的那句话多半在转述/开玩笑，
 *     认成点名会让"仅@"档无差别回话（比漏回更吵）。收紧方向已在此登记。
 *   · `callsBotByName`（:978-996）：先剥 `[引用…]`/`[CQ:reply…]`（免得把别人嘴里的话算成在叫它），
 *     再判**句首** `^@?\s*名字` + 同一条尾边界。旧树的"只认开头"理由我也照搬：
 *     名字出现在正文中段多半在聊别人（「他说京玉怎么怎么样」）。
 *
 * ★ 名字来源一律**注入**（`options.selfNames`，由 `modules/orchestrator/index.js:397-405`
 *   从 `persona.selfNickname` / `onebot.selfNickname` / `persona.botName` 组装）——
 *   M5 自己**不读配置**（不许 import M1）；名单为空 ⇒ 这一路判定整个关闭，绝不猜。
 *
 * ⚠ 两条**故意不覆盖**的（旧树也不覆盖，属已知缺口，需要时另开票）：
 *   · **全角 `＠`**：旧树正则只认 ASCII `@`，`＠症状尺` 在旧树**也不**算点名。我照旧树口径，没自创。
 *   · **大小写**：旧树是 `includes`（**大小写敏感**），`@Symptom` 叫 `symptom` 的机器人旧树也不认。照旧树。
 */

/** 名字之后允许的"边界"：结束 / 分隔与标点 / 旧树那组呼唤词（照抄 `src/prompt.js:992`）。 */
const TAIL = '(?:$|[\\s，,：:！!。.、~～?？]|(?=在吗|在不在|在么|在不在线|出来|帮我|给我|你看|你说))';

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 剥掉引用块（`[引用 …]` / `[CQ:reply, …]`）—— 旧树 `callsBotByName:982` 的第一步。 */
export function stripQuotedBlocks(text) {
  return String(text ?? '')
    .replace(/\[引用[^\]]*\]/g, '')
    .replace(/\[CQ:reply[^\]]*\]/g, '');
}

export function calledByName(text, selfNames) {
  const raw = String(text ?? '');
  if (!raw.trim()) return false;
  const names = (Array.isArray(selfNames) ? selfNames : [])
    .map((n) => (typeof n === 'string' ? n.trim() : ''))
    .filter(Boolean);
  if (!names.length) return false;
  for (const name of names) {
    // 旧树 `isAtMe:959`：`name.length < 2` 直接跳过（防单字乱命中）
    if (name.length < 2) continue;
    const esc = escapeRe(name);
    // ① 手打 `@名字` / `@ 名字`（任意位置，但**必须有尾边界**）
    if (new RegExp(`@\\s*${esc}${TAIL}`, 'u').test(raw)) return true;
    // ② 句首裸名字（`@` 可有可无）——旧树 `callsBotByName` 口径
    const head = stripQuotedBlocks(raw).trim();
    if (head && new RegExp(`^@?\\s*${esc}${TAIL}`, 'u').test(head)) return true;
  }
  return false;
}

/**
 * 正文里出现**机器人的 QQ 号**也算"在叫它"（纯文本形态，没有 CQ `at` 段）。
 *
 * ★ 口径**逐字照抄**旧树 `isAtMe` 的 ①段（`src/prompt.js:945-955`，注释原话：
 *   「QQ 号：最稳，不随改名失效」）—— 手打 `@10000001` 与 `@名片 (10000001)`
 *   在旧树是**认**的，而本模块原来只认名字，导致只@档里这两种形状被判"没点名" ⇒
 *   `tier_restricted` 抑制 ⇒ 主人看到"叫它 QQ 号也不理"。
 *   · (b) `@\s*<id>\b`：**`\s*`（@ 与号之间允许空格）与 `\b`（`@200001` 多一位数字不许命中）都必须保留**。
 *   · (c) `(<id>)` 且**整段里出现过 `@`** —— 括号号单独出现不算（那是别人在报号）。
 *   · (a) CQ `at` 段**不在这里**：它由 `collectMentions()` + `mentions[].isSelf` 那一路负责
 *     （`src/prompt.js:947-951` 的 CQ 正则等价于"段里有 at 且 qq=self"），别在这里重解析一遍。
 *
 * ★ id 一律**注入**（`context.selfId`，由 `modules/orchestrator` 组装）—— M5 自己
 *   **不读配置、不猜 id**；没注入（空/非字符串/非数字串）⇒ 这一路整个关闭。
 *
 * ⚠ 已知边界（照旧树口径，未扩展）：只认**十进制数字串**的 id；带前缀/分隔的写法
 *   （如 `@uin:20000`）旧树同样不认。
 */
export function calledBySelfId(text, selfIds) {
  const raw = String(text ?? '');
  if (!raw.trim()) return false;
  const list = (Array.isArray(selfIds) ? selfIds : [selfIds])
    .map((v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : (typeof v === 'string' ? v.trim() : '')))
    .filter((v) => /^\d+$/.test(v));
  if (!list.length) return false;
  const hasAt = /@/.test(raw);
  for (const sid of list) {
    // (b) 纯文本 @<id>（@ 与号之间允许空格；\b 挡住 @200001）
    if (new RegExp(`@\\s*${sid}\\b`, 'u').test(raw)) return true;
    // (c) @名片 (<id>) —— 名片后紧跟括号号，且整段里出现过 @
    if (hasAt && new RegExp(`\\(${sid}\\)`, 'u').test(raw)) return true;
  }
  return false;
}

/**
 * 把一条原始入站项归一成**事实记录**（还不是 MessageEvidence —— 那一步在 evidence.js）。
 *
 * 入参形态**宽收口**（协议端可能是 OneBot 事件，也可能是上游归一过的对象）：
 *   id:      id | message_id | mid
 *   time:    at | ts | time*1000 | context.now      ← 都没有就抛 E_NO_TIME（不读时钟）
 *   sender:  sender.user_id | sender.id | senderId | user_id | userId
 *   name:    sender.card | sender.nickname | sender.name | senderName | nickname
 *   body:    segments | message | raw_message | text
 *   quote:   quoted | reply（上游解析过的引用信息；解析不到就靠注入的 resolveQuote）
 *
 * @throws {ScenarioError} E_RAW_NOT_OBJECT / E_NO_TIME
 */
export function normalizeRaw(item, context = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new ScenarioError(SCENARIO_ERROR_CODES.RAW_NOT_OBJECT, '入站项必须是对象');
  }
  const {
    chatKey = '', kind = 'group', selfId = '',
    now = null, selfNames = [], resolveAtName = null, resolveQuote = null, onIssue = null, index = 0
  } = context;

  const senderObj = item.sender && typeof item.sender === 'object' && !Array.isArray(item.sender) ? item.sender : null;
  const senderIdRaw = senderObj ? (senderObj.user_id ?? senderObj.id ?? senderObj.uin) : null;
  const senderId = normalizeId(
    senderIdRaw !== null && senderIdRaw !== undefined ? senderIdRaw
      : (item.senderId ?? item.user_id ?? item.userId)
  );
  const senderName = senderObj
    ? firstString(senderObj.card, senderObj.nickname, senderObj.name, senderObj.nick)
    : (typeof item.sender === 'string' ? item.sender.trim() : firstString(item.senderName, item.nickname, item.name));

  const rawId = item.id ?? item.message_id ?? item.mid;
  const id = rawId === null || rawId === undefined ? '' : String(rawId).trim();

  let at = null;
  if (isFiniteNumber(item.at)) at = item.at;
  else if (isFiniteNumber(item.ts)) at = item.ts;
  else if (isFiniteNumber(item.time)) at = Math.round(item.time * 1000);
  else if (isFiniteNumber(now)) at = now;
  if (at === null) {
    throw new ScenarioError(SCENARIO_ERROR_CODES.NO_TIME, '入站项没有可用时间（at/ts/time 皆缺，且 batch.now 未给）', { index, id });
  }

  const body = item.segments !== undefined ? item.segments
    : (item.message !== undefined ? item.message
      : (item.raw_message !== undefined ? item.raw_message : item.text));
  const segments = toSegments(body);

  let text = renderText(segments, { resolveAtName, onIssue });
  const truncations = [];
  const limit = Number.isSafeInteger(context.maxTextChars) && context.maxTextChars > 0 ? context.maxTextChars : MAX_TEXT_CHARS;
  if (text.length > limit) {
    truncations.push({ originalChars: text.length, keptChars: limit });
    onIssue?.({ code: 'text-truncated', index, id, originalChars: text.length, keptChars: limit });
    text = text.slice(0, limit);
  }

  const mentions = collectMentions(segments, { selfId, resolveAtName, onIssue });
  const refs = collectRefs(segments, { selfId, resolveQuote, quoteHint: item.quoted ?? item.reply ?? null, onIssue });

  // 媒体：段里抽一份，上游预抽的一份按 (type,id) 去重后再并 —— 同一条图不数两次。
  // ★ 2026-10-04 修（回放 R-A6-3 抓到的真 bug）：去重时**必须把上游那份的描述并进来**。
  //   段里抽出来的 `{type,id}` 没有 desc（CQ 段只有文件 id），而上游 `item.media[]` 常常带
  //   `desc`/`ocr` —— 那是模型**唯一**能"看见"图里动作的通道。原先"先来先占、后来跳过"的写法
  //   会把带描述的那份丢掉 ⇒ 用户看到"图里明明写着的事它装作不知道"。
  const media = collectMedia(segments, { onIssue });
  const mediaByKey = new Map(media.map((m) => [`${m.type}|${m.id}`, m]));
  for (const m of normalizeMediaList(item.media, { onIssue })) {
    const key = `${m.type}|${m.id}`;
    const existing = mediaByKey.get(key);
    if (!existing) {
      mediaByKey.set(key, m);
      media.push(m);
      continue;
    }
    if (!existing.desc && m.desc) existing.desc = m.desc;
    if (!existing.ocr && m.ocr) existing.ocr = m.ocr;
  }

  const isSelf = item.post_type === 'message_sent' || isSelfId(senderId, selfId);

  // refs.toSelf = 「这条是在跟机器人说话吗」事实合成：引用机器人 / @机器人 / 开头叫名字 / 叫 QQ 号。
  // ★ 四者都是**平台字段或字面匹配**，没有一条是"猜"。三把刀的旧树出处见 calledByName / calledBySelfId 注释。
  const toSelf = Boolean(
    refs.toSelf
    || mentions.some((m) => m.isSelf === true)
    || calledByName(text, selfNames)
    || calledBySelfId(text, selfId)
  );

  return {
    index,
    id,
    at,
    chatKey: firstString(item.chatKey) || chatKey,
    kind: item.kind === 'private' || item.kind === 'group' ? item.kind : kind,
    selfId,
    senderId,
    senderName,
    isSelf,
    text,
    segments,
    mentions,
    refs: { toSelf, quoted: refs.quoted, replyTo: refs.replyTo },
    media,
    truncations,
    hasReplySegment: findReplySegment(segments) !== null,
    receipt: item.receipt && typeof item.receipt === 'object' ? item.receipt : null
  };
}
