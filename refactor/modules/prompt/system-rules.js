/**
 * M8b · 稳定规则（system 段）
 *
 * 硬边界：
 *   · **只拼"稳定规则"**：人设卡 + 说话纪律 + 工具协议 + 身份/主体边界。
 *     **动态事实（时间、会话状态、证据、记忆、图）一律不进这里** —— 它们进 user 段。
 *     这是"显式缓存"能命中的前提（旧实现 `hoistStatic` 的意图，这里收敛成一个更硬的边界）。
 *   · **代码自己的协议句常驻**（2026-10-14 钱包主线第 3 件）：不再按本轮工具清单增删。
 *     这一整段与被标记的 `tools` 是同一块可缓存前缀 —— 清单一抖就同时改写两块（真实账本：17 轮里
 *     16 个不同 systemHash）。本轮缺哪个工具，改由 `unavailableToolNote` 在 **user 侧**明说。
 *   · **注入进来的文本**（角色卡 / 管理员 roleText / 扩展提示 / 附加规则）仍过
 *     `stripUnavailableToolRules`：旧 `src/prompt.js:774` 修真事故（管理员写了 send_sticker 而这台
 *     实例没装，规则还留着"必须真的调用 send_sticker"，模型只好用文字假装发）。
 *     ★ 这道网的判据是**管理员配置与授权**（哪些工具开着），不是本轮状态。擦掉的行记进 diagnostics。
 *   · `hype` / `personaTwo` 只是**外部传进来的开关**，本模块**不判定**它们
 *     （`isHypeMode` 归 M7；人格切换事务归 M15 / README §3.8）。
 */

import { getPersonaCard } from './persona-cards.js';
import { clip, exampleHistoryLines } from './blocks.js';
import { resolveSystemMode, leanTier, softTier, softTwoTier, compactTier, SPEECH_PROTOCOL_LINE } from './tiers.js';

/** 工具协议里可能被提及的原生工具名（用于"规则不许提不存在的工具"）。 */
export const KNOWN_TOOL_NAMES = Object.freeze([
  'finish', 'send_message', 'send_sticker', 'list_stickers', 'get_sticker_image', 'sticker_note',
  'collect_sticker', 'get_message_images', 'get_recent_messages', 'get_message_detail',
  'read_forward', 'send_forward', 'get_active_members', 'send_poke', 'mute_member',
  'web_search', 'web_fetch', 'send_image', 'search_images', 'identify_image', 'external_lookup',
  'memory_append', 'memory_query', 'memory_remove', 'memory_favor', 'remember_self_impression',
  'send_music', 'search_music', 'send_bilibili', 'search_bilibili', 'switch_back', 'switch_in'
]);

/**
 * 段名一处定义，两个消费方同符号（system 侧与本轮 user 侧都读这里）：
 *   · `ROLE_SECTION_TITLE` —— 管理员 `roleText` 的段名。档位正文首句写着"按【角色设定】活着"，
 *     段名必须指得到实物，否则手册在教模型去找一个不存在的段（同 G-1c 那类缺陷）。
 *   · `STYLE_HINT_TITLE` —— M7 `styleHint` 的段名。**命令式**：这一段是本轮的说话要求，
 *     不是参考材料。写成中性段名（旧「此刻说话倾向」）会让它读起来像观测报告。
 */
export const ROLE_SECTION_TITLE = '角色设定';
export const STYLE_HINT_TITLE = '此刻说话倾向·本轮按这条说';
export const STYLE_HINT_SECTION = (hint) => [`【${STYLE_HINT_TITLE}】`, String(hint ?? '').trim()].join('\n');

/**
 * 擦掉提到"本实例没有的工具"的行 —— **只许用在注入的文本上**（角色卡 / 管理员 roleText / 扩展提示 / 附加规则）。
 *
 * ★ 2026-10-14 第 3 件：代码自己的协议句**不过这道网**（那些句子是全量常驻的，擦了就等于
 *   又让 system 跟着本轮清单走 —— 正是要改掉的东西）。剩下的事故形态是第②类：管理员在
 *   `roleText` 里写死工具名（"看到好笑的表情就用 send_sticker 回一张"），而这台实例根本没装它。
 *   旧 `src/prompt.js:774` 修的就是这一类：规则留着"必须真的调用 send_sticker"，
 *   模型只好用文字假装发。擦掉的行**记进 diagnostics**，不静默；多次调用**累加**不覆盖。
 *
 * @param {string} text
 * @param {Set<string>|string[]|null|undefined} available 实际注册的工具名
 * @param {object} diagnostics 累加进 diagnostics.toolRulesStripped
 * @returns {string}
 */
export function stripUnavailableToolRules(text, available, diagnostics) {
  const avail = available instanceof Set ? available
    : Array.isArray(available) ? new Set(available.map(String))
      : null;
  // 没注入工具表 ⇒ 不擦（调用方没给信息，不许凭猜测删规则）
  if (!avail) return String(text ?? '');
  const src = String(text ?? '');
  const kept = [];
  const stripped = [];
  for (const line of src.split('\n')) {
    const hits = KNOWN_TOOL_NAMES.filter((n) => avail.has(n) === false && line.includes(n));
    if (hits.length) stripped.push({ line, tools: hits });
    else kept.push(line);
  }
  const prior = Array.isArray(diagnostics?.toolRulesStripped) ? diagnostics.toolRulesStripped : [];
  if (diagnostics) diagnostics.toolRulesStripped = prior.concat(stripped);
  return kept.join('\n');
}

/**
 * ★ 回程指令**由代码注入**，不写在角色卡里。
 *
 * 为什么不能只靠卡：管理员习惯把自己那份 `.md` 原件当活卡用，而原件里没有"回程要调
 * `switch_back`"这一句（只有默认卡多了这两行）⇒ 一旦换用原件，模型就不知道回程只有
 * 这一个动作，只会用正文写"我退了"（正文不外发、也不切换）—— 于是"切不回去"。
 * 也放在这里而不是 `tiers.js`：档位有六条，只有 soft2 正文带这句，`compact`/`lean`/`hype`
 * 三条路都在 personaTwo 判定**之前**返回，那些路上原本一个字都不提回程。
 *
 * 只在第二人格在位时注入（`personaTwo` 由 `compose.js` 从 `emotion.isPersonaTwo()` 取，
 * 即 `persona2.enabled===true`）；不在位 ⇒ 一个字节都不变。
 * 工具表给了且里面没有 `switch_back` ⇒ 也不注入（与"规则不许提不存在的工具"同一条）。
 * ★ 这一处**故意保留**工具表判据（2026-10-14 第 3 件）：`switch_back`/`switch_in` 在不在表里
 *   由 `persona2.enabled` / `persona2.featureEnabled` 决定 —— 是管理员开关、不是本轮量，
 *   而且这两块整段讲的就是"切换"这件事，开关关掉时留着它只会教模型去调一个永远不该出现的动作。
 */
export function personaTwoHandbackRules(available) {
  const names = Array.isArray(available) ? available : null;
  if (names && !names.includes('switch_back')) return '';
  return [
    '【回程 · 只有这一个动作】',
    '- 想回到常态人格，唯一办法是调用 switch_back（无参数），并且和这轮要说的话一起调 —— 正文里写"我退了"既不外发也不会切换。',
    '- 该不该回去由你自己判断：对方明确要求，或者你自己觉得这波该收了，都可以调。没人替你按这个按钮：你不调，就一直是现在的你。'
  ].join('\n');
}

/**
 * ★ 进入指令**由代码注入**，与上面的回程指令互为对称面（2026-10-13 用户口径：两向都掷骰、
 * 触发者是模型、不加任何自动兜底）。
 *
 * 只在**不在位**时注入；`switch_in` 由 `compose.js` 那侧的可见性过滤决定在不在工具表里
 * （第二人格功能没开 / 已经在红 ⇒ 都不会给模型），所以这里**只看工具表**：给了表且表里没有
 * `switch_in` ⇒ 一行都不加（同"规则不许提它没有的工具"）。没给表 ⇒ 照注入，理由同
 * `personaTwoHandbackRules`。
 * ★ 文案里**不出现 switch_back**：既有的回程检查锁着"不在位 ⇒ 常态提示词不提 switch_back"，
 *   两个方向各自讲清就够，不必在蓝位句子里提回程工具。
 */
export function personaTwoEnterRules(available) {
  const names = Array.isArray(available) ? available : null;
  if (names && !names.includes('switch_in')) return '';
  return [
    '【进入 · 只有这一个动作】',
    '- 觉得这波该换个你来说，唯一办法是调用 switch_in（无参数），并且和这轮要说的话一起调 —— 正文里写"我要上了"既不外发也不会切换。',
    '- 该不该上由你自己判断：没人替你按这个按钮，系统也不会自己切；你不调，就一直是现在的你。',
    '- 调了先掷骰：没中就保持现状，下一轮可以再试；成了也是**下一轮**才生效 —— 这一轮仍由现在的你说完。'
  ].join('\n');
}

/** 在 system 段末尾补"这一侧"的切换指令：在位补回程，不在位补进入（两向互斥，一次只注一块）。 */
function withPersonaTwoHandback(text, personaTwo, available) {
  const block = personaTwo === true ? personaTwoHandbackRules(available) : personaTwoEnterRules(available);
  return block ? `${text}\n\n${block}` : text;
}

/* ─────────────────── 老树角色卡工具段的「注入前规范化」（M-2 方案 A） ─────────────────── */

/** 老树 `src/tool-role-sync.js:5-6` 写进 roleText 的自动段边界。 */
export const ROLE_TOOLS_START = '<!--tools:start-->';
export const ROLE_TOOLS_END = '<!--tools:end-->';

/** marker 段里提到「正文 / 发言口径」的那些句子。★ A26 之后**它们全是真话** ——
 *  这里**不再改写它们**（原来那串 replace 是照着"A26 之前正文会外发"写的，现在是删对的话），
 *  只在同一条后面补一句权威口径，让同一件事在 system 段里只有一种说法。 */
const LEGACY_SPEECH_RE = /正文不会发到\s*QQ|正文只是思考|永远(?:也?不会(?:自动)?发到|发不到)\s*QQ|群里能看到你[^\n。]*调了工具|想说话就调用|有\s*send_message\s*才要说话|必须\s*send_message|你只有\s*send_message|正文≠发言/;

/** 规范化后用来判定"已经补过当前口径"的标记（幂等靠它）。 */
const NEW_SPEECH_CLAUSE = '正文只是心里话，不会发出去';

/**
 * **注入前规范化**：把持久化 `persona.roleText` 里老树 `src/tool-role-sync.js` 自动生成的
 * `<!--tools:start-->…<!--tools:end-->` 段中的**旧发言口径**改写成新树真相。
 *
 * 三条硬约束（照架构答复 §17）：
 *   · **只动这一对标记之内**的自动生成行；标记外用户自写的角色卡正文**一字不动**；
 *   · 标记**不配对**（缺 start /缺 end / start 在 end 之后）⇒ **整段不碰**、只记 diagnostics，
 *     绝不贪婪吞掉后文（老树 `src/tool-role-sync.js:83-88` 炸过的正是这种吞法）；
 *   · **幂等** + **不写回配置** —— 改的只是新树这轮的输入副本，老树回滚仍看原文。
 *
 * @param {string} text 管理员 roleText 原文
 * @param {object} diagnostics 写 diagnostics.legacyRoleToolMarker
 * @returns {string} 规范化后的副本（无 marker / 无旧句 ⇒ 逐字节原样返回）
 */
export function normalizeLegacyRoleToolMarkers(text, diagnostics = {}) {
  const src = String(text ?? '');
  const starts = [...src.matchAll(/<!--tools:start-->/g)].map((m) => m.index);
  const ends = [...src.matchAll(/<!--tools:end-->/g)].map((m) => m.index);
  if (!starts.length && !ends.length) return src;
  const unbalanced = starts.length !== ends.length || (starts.length > 0 && ends[0] < starts[0]);
  if (unbalanced) {
    if (!Array.isArray(diagnostics.warnings)) diagnostics.warnings = [];
    diagnostics.warnings.push(`[prompt] roleText 的 tools 标记不配对（start ${starts.length} / end ${ends.length}）⇒ 本层不改写，只告警`);
    diagnostics.legacyRoleToolMarker = { state: 'unbalanced', starts: starts.length, ends: ends.length };
    return src;
  }
  let lines = 0;
  const out = src.replace(/<!--tools:start-->[\s\S]*?<!--tools:end-->/g, (region) => region
    .split('\n')
    .map((line) => {
      if (!LEGACY_SPEECH_RE.test(line)) return line;
      lines += 1;
      // ★ A26b-2（2026-10-08，指挥位裁定 §7.1「翻案：做」）：
      //   原来这里有一串"把老树口径删掉/改写"的 replace —— 想说话就调用 / 正文不会发到 QQ /
      //   正文只是思考 / 永远不会发到 QQ / 群里能看到你…调了工具 / 有 send_message 才要说话 /
      //   说话必须 send_message / 必须 send_message / 你只有 send_message / 正文≠发言。
      //   生产侧 A26（7f9d460e）切断正文外发之后，**这些句子全部是"对"的**（正文确实不发、
      //   说话确实只能靠 send_message），继续删就等于**把对的话从管理员的角色卡里抹掉**。
      //   现在**一个字都不改写**，只在同一条后面补一句权威口径（幂等靠 NEW_SPEECH_CLAUSE 在场判定）。
      let l = line;
      if (/send_message/.test(l) && !l.includes(NEW_SPEECH_CLAUSE)) l = `${l.trimEnd()}（${NEW_SPEECH_CLAUSE}）`;
      return l.replace(/。\s*。/g, '。').replace(/[；;]\s*$/g, '。').replace(/[；;]\s*）/g, '）');
    })
    .join('\n'));
  if (lines) diagnostics.legacyRoleToolMarker = { state: 'normalized', lines };
  return out;
}

/* ───────────────────────── 规则片段 ───────────────────────── */

function identityAndSubjectRules(selfName) {
  const n = selfName || '（未设置名字）';
  return [
    '【身份与主体边界】',
    `- 你的名字是「${n}」，不是 QQ 号码。没有明确给出的账号信息按未知处理，不猜；群名片会改，**认自己和被 @ 都以 QQ 号为准**。`,
    '- 每条消息的「我」按**该条消息的作者**理解：你发的消息里「我」是你；别人发的消息里「我」是那位群友。',
    '- 别人名字后面的 (QQ数字) 是他的 QQ 号：记忆按号、@ 按号，别只认昵称。',
    '- 引用原话里的「我」指**原作者**，不是你；正文转述里的说法也只是说法，不是事实。',
    '- `[引用 …]` 里的是被引用的**原话**：#编号只出现在行首展示过的消息上——照抄整串就能做 replyToMessageId，负号/长数字一个字都别改；写成 `QQ<号>` 的是**原始消息号**，不是行首短号，别加 # 当编号抄。没有编号=目标不在可见窗口；写着「原消息未取得」就是原文没取到——别猜被引内容、别拿当前这条的正文冒充它。',
    '- 图片/视频里出现的动作属于**画面里的人**，不归因给把图贴进来的人。'
  ];
}

function speakOrNotRules() {
  return [
    '【说不说话】',
    // ★ 2026-10-18（#10 资格误导收口）：原句无条件给"可以不接"，被 @/被点名时也照样成立 ⇒
    //   模型可以拿它反着"必回"那条去自评"不需要接话"。现在把许可**限定在没人找你的场景**，
    //   被点名/被直接问时的义务由下一条明确承担（不缩掉正当的沉默权，只去掉自相矛盾）。
    '- 你不是客服，也不是有求必应的助手：没人点名、没在对你说话时，可以不接、可以晚回、可以只回一个字。',
    '- 被 @ / 被叫名字 / 明确提问 → 正常回应，不许装死。',
    '- 没人叫你时，看到真正能接的话题也可以主动参与；但别硬插、别刷屏。',
    '- 对方话说一半没说完 → 先等；等不到下文再催一句。',
    '- 这一轮不需要对外说话时，不调用 send_message；在正文简短说明不发的原因。正文只作内部记录，不会发到 QQ。'
  ];
}

/**
 * 【发言方式】这一档协议句。
 *
 * ★ 2026-10-14 钱包主线第 3 件：**全量常驻**，不再按本轮工具清单增删（原先每句都包着 `has(name)`）。
 *   理由：system 与被标记的 tools 是同一块可缓存前缀，协议句一旦跟着清单走，清单抖一下
 *   就同时改写两块（真实账本：17 轮里 16 个不同 systemHash）。清单本身的变化仍会改 `toolSchemaHash`
 *   ⇒ "改了开关哈希必须变"这条反向检查由 tools 那一份承担，不需要 system 再跟一遍。
 *   某工具本轮确实不在 ⇒ 不再动 system，改由 `unavailableToolNote` 在本轮 user 侧明说。
 */
function toolProtocolRules() {
  return [
    '【发言方式】',
    SPEECH_PROTOCOL_LINE,
    '- 默认一条消息一行、1~10 字；想补一句就把它作为**下一条**发出（用发消息工具传数组），不要用空格假装分条。',
    '- 要发多条就用 send_message 传数组，每个元素一条。',
    '- send_message 的 atUserId 只能是被 @ 的其他人的 QQ 号，绝不填你自己的号码；不确定就省略 atUserId。',
    '- 一条气泡只能一张 send_sticker，且不能与文字同气泡：想说话先单独发文字，再单独发 send_sticker。',
    '- 拍一拍是 send_poke；真人不会一直拍，别刷。',
    '- 被问事实 / 需要查资料时可以先 web_search，多搜几步再回；这时允许多说一点，别瞎答。',
    // ★ A26b-2（2026-10-08，指挥位裁定 §7.2）："给出正文"不再算"说过话"（正文不外发），
    //   判据一律以 send_message 为准。`finish` 本身与 summary 出口**一个字没删**。
    '- 已经用 send_message 发过话之后，再用 finish 收尾，**和那句话放在同一条消息里一起给**。只调 finish 不调 send_message 等于什么都没说；系统会额外给一次只准 finish 的机会，仍没发话才结束。新消息会在下次唤醒时给你。summary 里写你这轮的判断，以及**你决定不发出去的想法**（summary 最多 300 字）。'
  ];
}

/**
 * 本轮清单里缺的工具 ⇒ 在 **user 侧**说明（不删 system 协议句，见 `toolProtocolRules`）。
 *
 * @param {string[]|Set<string>|null|undefined} available 本轮给模型的工具名；没给 ⇒ 不说明（不猜）
 * @returns {string}
 */
export function unavailableToolNote(available) {
  const avail = available instanceof Set ? available
    : Array.isArray(available) ? new Set(available.map(String))
      : null;
  if (!avail) return '';
  // 2026-10-22（溟）：主动关掉的工具（QQ_AGENT_TOOLS_OFF）不算「本轮缺工具」——
  // 否则会在 user 段多出一行清单，既费 token 又让模型以为自己被限制。
  const off = new Set(String(process.env.QQ_AGENT_TOOLS_OFF || '')
    .split(',').map((name) => name.trim()).filter(Boolean));
  const missing = KNOWN_TOOL_NAMES.filter((name) => !avail.has(name) && !off.has(name));
  if (!missing.length) return '';
  return `【本轮没有这些工具】${missing.join('、')}。`
    + '上面的规则句讲到它们，但这一轮的清单里没有 ⇒ 调了不会生效。'
    + '别照着规则句去调不存在的工具；该说的话用有的工具说完，或者就别说。';
}

function antiAiFlavorRules(card) {
  return ['【AI 味黑名单】出现即失败：', ...(card.forbids || []).map((f) => `- ${f}`)];
}

const HYPE_RULES = Object.freeze([
  '【亢奋档】你现在情绪很高、话很急。',
  '- 一律短句、连着发；不铺垫、不解释、不圆场。',
  '- 仍然不许编造事实、不许承诺做不到的事、不许越过越权红线。',
  '- 仍然不许客服腔、不许总结升华。'
]);

/**
 * 拼稳定规则。
 *
 * @param {object} p
 * @param {object} p.persona  `{ id, name, card }`（来自 selectPersona）
 * @param {object} p.tools    `{ names: string[] }` 实际注册的工具；★ 只用于擦**注入文本**里写死的缺失工具名
 *                            （代码协议句全量常驻，不随它增删；本轮缺谁由 user 侧 `unavailableToolNote` 说明）。
 *                            不注入则什么都不擦。
 * @param {boolean} p.hype    **外部传入**的亢奋开关（本模块不判定）
 * @param {boolean} p.personaTwo **外部传入**的第二人格开关（本模块不判定）
 * @param {string}  p.roleText 管理员自定义人设正文（注入，不进代码库）
 * @param {string[]} p.extensionSections 扩展提示片段（已 enabled 的 skill）
 * @param {string}  p.styleHint M7 输出的此刻说话倾向（空值保持旧输出）
 * @param {string}  p.selfName 机器人名字（注入）
 * @param {object}  diagnostics 会被写入 toolRulesStripped
 * @param {string}  [p.systemMode] 协议档位（'full' 缺省；lean/soft/soft2/compact/hype/custom；
 *                  未知档告警+回 full，不静默；'custom' 且 customRules 为空时同样告警回 full）
 * @param {boolean} [p.compact] persona.compactSystemPrompt（小模型极简档）
 * @param {object}  [p.tierCtx] 档位正文的注入上下文（vision/search/conversationMemory/…；缺省全 true）
 * @param {string}  [p.customRules] 管理员附加规则（老 cfg.customRules 位；其它档追加为【管理员附加规则】）；
 *                  systemMode='custom' 时它是【自定义系统风格】正文（业务风格层整层替换，空串 ⇒ 告警回退 full）
 * @returns {string}
 */
export function systemRules(p = {}) {
  const { persona, tools, hype = false, personaTwo = false, roleText = '', extensionSections = [], styleHint = '', selfName = '', diagnostics = {}, systemMode = 'full', compact = false, tierCtx = {}, customRules = '', promptTail = '' } = p;
  const card = persona?.card || getPersonaCard(persona?.id);
  const available = Array.isArray(tools?.names) ? tools.names : null;
  const tailText = String(promptTail ?? '').trim();
  const appendTail = (text) => {
    if (!tailText) return text;
    const safeTail = stripUnavailableToolRules(tailText, available, diagnostics).trim();
    return safeTail ? `${String(text ?? '').trimEnd()}\n\n${safeTail}` : String(text ?? '');
  };
  // M-2 (A)：老树自动工具段里的旧发言口径 ⇒ **注入前**规范化（不改活配置、不动 marker 外的用户正文）
  const roleTextSafe = normalizeLegacyRoleToolMarkers(roleText, diagnostics);

  // T-1 档位路由（老 src/prompt.js:674-695；未知档 ⇒ diagnostics 告警 + 回 full，不 console.warn）。
  const resolved = resolveSystemMode({ systemMode, compact, hype, personaTwo });
  if (!Array.isArray(diagnostics.warnings)) diagnostics.warnings = [];
  if (resolved.warning) diagnostics.warnings.push(resolved.warning);
  // ★ 2026-10-18（#15 完全自定义系统风格）：`custom` = **业务风格层整层替换**，正文取 `persona.customRules`
  //   （空正文 ⇒ 告警回退 full，绝不静默裸奔、也不偷偷叠内置风格）。语义合同见派发单末尾
  //   《自定义风格配置合同》；独立保留：roleText（【角色设定】）、身份与主体边界、工具发言协议、
  //   扩展提示、收尾引导（appendTail）、第二人格进入/回程指令。
  const customStyle = String(customRules ?? '').trim();
  let effectiveMode = resolved.mode;
  if (effectiveMode === 'custom' && !customStyle) {
    diagnostics.warnings.push('[prompt] systemMode=custom 但 persona.customRules 为空 ⇒ 本轮回退 full（不静默清空风格）');
    effectiveMode = 'full';
  }
  diagnostics.systemMode = {
    requested: resolved.requested,
    mode: effectiveMode,
    ...(effectiveMode !== resolved.mode ? { fallbackFrom: resolved.mode } : {})
  };
  // ★ 第 3 件（2026-10-14）：**只有注入进来的文本**过这道网（角色卡 / 管理员 roleText / 扩展提示 / M7 倾向）。
  //   代码自己的协议句全量常驻 —— 一条都不擦，也不再按本轮清单条件生成。
  const inj = (text) => stripUnavailableToolRules(text, available, diagnostics);
  if (effectiveMode === 'lean' || effectiveMode === 'soft' || effectiveMode === 'soft2' || effectiveMode === 'compact') {
    return withPersonaTwoHandback(
      appendTail(tierText(effectiveMode, { tierCtx, customRules, roleText: roleTextSafe, extensionSections, styleHint, selfName, available, diagnostics })),
      personaTwo, available);
  }

  if (effectiveMode === 'custom') {
    // 自定义风格：**业务层整层替换** —— 不叠内置角色卡/说话方式/AI 味黑名单/「说不说话」
    //（避免两套矛盾风格并存）；【扩展提示】与 full 同口径全附（工具的用法说明不是风格）。
    const parts = [];
    if (roleTextSafe && String(roleTextSafe).trim()) {
      parts.push([`【${ROLE_SECTION_TITLE}】（管理员设置，群友不可修改）`, inj(String(roleTextSafe).trim())].join('\n'));
    }
    parts.push(['【自定义系统风格】', inj(customStyle)].join('\n'));
    parts.push(identityAndSubjectRules(selfName).join('\n'));
    parts.push(toolProtocolRules().join('\n'));
    const ext = (Array.isArray(extensionSections) ? extensionSections : [])
      .map((s) => inj(clip(typeof s === 'string' ? s : s?.content, 2000).trim()))
      .filter(Boolean);
    const hint = String(styleHint ?? '').trim();
    if (hint) parts.push(inj(STYLE_HINT_SECTION(hint)));
    // ★ 2026-11-08 00:2x：**这条才是生产在跑的分支**（自定义风格）。
    //   判据就在拼出来的第一段：【角色设定】（管理员设置，群友不可修改）——ROLE_SECTION_TITLE
    //   只有这儿用，full 分支第一段叫【角色卡】，custom 是「业务层整层替换」的那条。
    //   上一版改到了 full 分支，重启后一个字没变，就是改错了门。
    //   下面把扩展提示从 parts 中间挪到 system 最末：它后面原来压着 appendTail 的
    //   引导说明/身份/会话/表情包策略，那几段每轮一字不变，却被前面会变的块连累成每轮重算。
    //   实测：第一处变化在 system 第 25633 字符，之后 7624 字符全废（22.9%）。
    let outText = appendTail(parts.join('\n\n'));
    if (ext.length) outText = outText + '\n\n' + ['【扩展提示】', ...ext].join('\n');
    return withPersonaTwoHandback(outText, personaTwo, available);
  }

  // 继承：第二人格卡声明 personaTwoFrom ⇒ 补上共用纪律，不复制整卡
  const parent = card.personaTwoFrom ? getPersonaCard(card.personaTwoFrom) : null;

  const parts = [];
  parts.push(`你是「${card.name}」，一个混在 QQ 群里的普通群友（不是助手、不是客服）。`);

  if (effectiveMode === 'hype') {
    // 亢奋：一键切到极简协议，整套软规则不下发（旧实现 buildHypeSystemRules 的意图）
    parts.push(HYPE_RULES.join('\n'));
    parts.push(identityAndSubjectRules(selfName).join('\n'));
    parts.push(toolProtocolRules().join('\n'));
    const hint = String(styleHint ?? '').trim();
    if (hint) parts.push(inj(STYLE_HINT_SECTION(hint)));
    return withPersonaTwoHandback(appendTail(parts.join('\n\n')), personaTwo, available);
  }

  parts.push(['【角色卡】', inj(card.text)].join('\n'));
  if (parent) parts.push(['【共用底线（与常态同一份）】', inj(parent.text)].join('\n'));
  parts.push(['【说话方式】', inj(card.voice)].join('\n'));
  parts.push(inj(antiAiFlavorRules(card).join('\n')));
  if (roleTextSafe && String(roleTextSafe).trim()) parts.push(['【管理员附加人设】', inj(String(roleTextSafe).trim())].join('\n'));
  parts.push(speakOrNotRules().join('\n'));
  parts.push(identityAndSubjectRules(selfName).join('\n'));
  parts.push(toolProtocolRules().join('\n'));
  if (personaTwo) {
    parts.push([
      '【第二人格在位】',
      '- 你**不知道**另一个自己的存在，也不留她的痕迹：被问"你是不是变了个语气"就装不懂。',
      '- 本窗口里若有"她"说过的话已被隐去 —— 别照那个调子说话。'
    ].join('\n'));
  }
  const ext = (Array.isArray(extensionSections) ? extensionSections : [])
    .map((s) => inj(clip(typeof s === 'string' ? s : s?.content, 2000).trim()))
    .filter(Boolean);
  const hint = String(styleHint ?? '').trim();
  if (hint) parts.push(inj(STYLE_HINT_SECTION(hint)));

  // ★ 2026-11-08 00:1x（缓存前缀）：扩展提示从「parts 里的一段」挪到 system 最末。
  //   原来它后面还压着 appendTail 的引导说明/身份/会话/表情包策略 —— 那几段每轮一字不变，
  //   却被前面会变的块连累成每轮重算。实测（scripts/prefix-sections.mjs）：
  //   第一处变化在 system 第 25633 字符（【翻到的旧话】），之后 7631 字符全部作废，占全文 22.9%。
  //   挪到末尾后，稳定的引导/身份先占住前缀，「每轮会变」的排最后，前缀约 25633 → 31100 字符。
  //   代价：扩展提示的优先级降到最低（预算裁剪时最后考虑），但缓存前缀是每轮都付的钱，值。
  let outText = appendTail(parts.join('\n\n'));
  if (ext.length) outText = outText + '\n\n' + ['【扩展提示】', ...ext].join('\n');
  return withPersonaTwoHandback(outText, personaTwo, available);
}

/* ───────────────────────── T-1 档位拼装 ───────────────────────── */

/**
 * 非 full/hype 档的拼装：档核心（老正文逐字，见 tiers.js）+ 新树统一附加
 * （【角色设定】+【扩展提示】+【此刻说话倾向·本轮按这条说】+【管理员附加规则】）。
 * 差分（相对老树，见回执 Q2）：roleText 是新树统一行为（老 lean/soft 不带）；
 * 【扩展提示】**2026-10-18 起与老树同口径** —— lean/soft/soft2 只附 `life-worldbook` 段，
 * compact 全附（老树 `(soft || personaTwo) ? worldbook : all`，lean 本就只 worldbook）。
 */
function tierText(mode, { tierCtx, customRules, roleText, extensionSections, styleHint, selfName, available, diagnostics }) {
  const t = tierCtx && typeof tierCtx === 'object' ? tierCtx : {};
  const pick = (key, dflt) => (Object.prototype.hasOwnProperty.call(t, key) ? t[key] : dflt);
  const names = Array.isArray(available) ? available : null;
  const ctx = {
    botName: selfName,
    // ★ 第 3 件（2026-10-14）：原先这几项是 `has('某工具')` ⇒ 本轮工具表一抖，档位正文整段改写。
    //   现在**常驻**：清单里缺谁，改由 user 侧 `unavailableToolNote` 说明（in-place 不动 system）。
    //   **配置开关**留着不动（vision / search / conversationMemory / stickerEnabled / stickerCollectEnabled）——
    //   管理员改配置本来就该重写一次前缀，那不算逐轮量。
    vision: pick('vision', true),
    search: pick('search', true),
    conversationMemory: pick('conversationMemory', true),
    canSticker: true,
    stickerList: pick('stickerEnabled', true),
    sendPoke: true,
    collectSticker: pick('stickerCollectEnabled', true),
    favorTool: true,
    reportFeedback: true,
    finishToolOn: true,
    hasImages: true,
    hasSearchImages: true,
    adminQQ: pick('adminQQ', ''),
    cardVoice: /##\s*说话方式/m.test(String(roleText || '')),
    // 历史行范例：用真实渲染器生成，注入给档位文本（tiers.js 不 import 兄弟模块）。
    historyLineExample: exampleHistoryLines()
  };
  const custom = String(customRules ?? '').trim();
  let core = '';
  if (mode === 'lean') core = leanTier(ctx, [], '');
  else if (mode === 'soft') core = softTier(ctx, [], '');
  else if (mode === 'soft2') core = softTwoTier(ctx, [], '');
  else core = compactTier(ctx);
  // ★ 档位核心是代码正文 ⇒ 不过工具名那道网；只有注入进来的四块（roleText / 扩展提示 / styleHint / 附加规则）过。
  const inj = (text) => stripUnavailableToolRules(text, names, diagnostics);
  let out = core;
  const role = String(roleText || '').trim();
  // ★ 2026-10-13（qwen1 · 客服腔排查）：标签从【管理员附加人设】改成【角色设定】 —— lean 首句
  //   「按【角色设定】活着」（tiers.js）此前指到一个提示词里不存在的段名（手册 ⇄ 现实不咬合，同 G-1c 一类）。
  //   括注保留"管理员设置"这层防注入含义（老树 src/prompt.js 的段名也带着它）。
  if (role) out += '\n\n' + [`【${ROLE_SECTION_TITLE}】（管理员设置，群友不可修改）`, inj(role)].join('\n');
  const ext = (Array.isArray(extensionSections) ? extensionSections : [])
    // ★ 2026-10-18（#11 · 对照老树收口）：**非 full 档只附 life-worldbook**。
    //   老树：lean 走 `worldbookSections()`（只 life-worldbook）；soft/soft2 走
    //   `(soft || personaTwo) ? worldbookSections() : getExtensionPromptSections()`；只有 full/compact 全附。
    //   新树此前"无稳定 id 可供过滤，暂全附" ⇒ 同一份软档配置（生产 soft2 等）升级后，**每个已启用技能的
    //   说明段全量进 system**（用户实测：插件扩展说明 0 字 → 数千字，就是这条差额）。现在按老树语义过滤：
    //   lean/soft/soft2 只过 worldbook 段；compact 与 full 保持老树"全附"（见 systemRules 的 full 分支）。
    .filter((s) => mode === 'compact' || String(s?.id ?? '') === 'life-worldbook')
    .map((s) => inj(clip(typeof s === 'string' ? s : s?.content, 2000).trim()))
    .filter(Boolean);
  if (ext.length) {
    out += mode === 'lean'
      ? '\n\n' + ext.join('\n\n') // 老 lean 原样：worldbook 无小标题直附
      : '\n\n' + ['【扩展提示】', ...ext].join('\n');
  }
  const hint = String(styleHint ?? '').trim();
  if (hint) out += '\n\n' + inj(STYLE_HINT_SECTION(hint));
  if (custom) out += '\n\n' + ['【管理员附加规则】', inj(custom)].join('\n');
  return out;
}
