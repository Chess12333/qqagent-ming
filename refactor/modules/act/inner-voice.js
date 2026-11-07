/**
 * W2 · 出站「心声 / 内心戏」防护（2026-10-06）。
 *
 * 为什么在这里：新树把模型正文直接当消息发，出站唯一收口 `applySendHygiene`
 * （`modules/act/index.js`）此前既没有老树的「心声剥离」，也没有「独白否决」
 * ⇒ 主人报「新树会吐露心声」。心声剥离沿用旧树；独白门现按 A13 误杀数据收紧为明确兜底：
 *
 *   ① `splitInnerVoice` ← `src/orchestrator.js:349-359`（正则 :354 逐字对齐）
 *      心声是模型写给自己看的收尾独白，**绝不发进群**；摘掉剩下的才是要说的话。
 *   ② `looksLikeNarration` / `narrationHit` / `narrationSignals`
 *      初版 ← `src/orchestrator.js:5317-5384`；现只保留明显提示词回声/内部备注形状。
 *
 * 纪律：心声剥离保持旧树口径；独白兜底按真实已发/手写正样本的误杀率收窄，不把普通聊天拦掉。
 */

import { comparableReply, isQuietProtocolText, isReplyPlanningText } from '../platform/reply-recovery.js';

/** 心声行判据：与 `src/orchestrator.js:354` 逐字相同。 */
const INNER_VOICE_LINE = /^(?:[（(]\s*)?心声[:：]\s*(.+?)\s*[)）]?$/;

// ── 跨轮心声无意义碎片判据（2026-10-16，正典在此）────────────────────────
// 消费方：orchestrator/index.js（写入端）、orchestrator/compose.js（检索端）。
// prompt/blocks.js（渲染端）零跨模块依赖，不能 import 本模块 ⇒ 依赖上游过滤；
//   若 blocks.js 需要独立防线，须由调用方（compose.js）传入已过滤数据。
// **不许在别处另抄词表**——改判据只改这里。

/** 空泛词表（叠字/语气词/拟声词/犹豫词；不含具体人名或动作）。 */
export const THOUGHT_FILLER_RE = /^(?:嗯+|哦+|噢+|啊+|呀+|哈+|呵+|嘿+|喂+|诶+|咦+|哇+|呃+|emm+|emmm*|ok+|okay|好的?|行吧?|好吧?|算了|没事|没什么|不知道|不清楚|随便|无所谓|都行|可以吧?|是吧?|对吧?|嗯对|嗯好|哦好|好吧好吧|哈哈+|嘿嘿+|嘻嘻+|呵呵+|666+|233+|woc|草+|乐+|典+|急了|典中典|好啊+|哦啊+|嗯啊+|啊哦+|哈喽|嗨+|你好|在吗)+$/iu;

/**
 * 跨轮心声是否值得保存/注入。
 * 拦掉：纯空泛词、纯标点/符号、去标点后 <2 字的碎片。
 * 保留：合法短词（含具体人名/动作）、有实质内容的心声、显式沉默/发言原因。
 */
const RUN_FAILURE_RE = /^\s*\[Error\]|模型请求(?:次数)?(?:异常|失败)|网络(?:错误|连不上|不通)|无法发送|发不出去|发送失败|已强制结束|防止刷屏|自动收尾|ECONN|ETIMEDOUT|fetch failed|HTTP\s*[45]\d\d|请求超时|输出被截断/iu;
const PROMPT_ECHO_RE = /^\s*【(?:过去状态|本次唤醒|语义卡|记忆|会话标识|当前时间|此刻状态|引导说明|最后一步|会话身份|本轮上下文)/u;
const THINK_BLOCK_RE = /<\/?(?:think|analysis|reasoning|reflection|scratchpad|plan|draft|思考|分析)[\s>]|^\s*(?:here'?s|let me|i'?ll|i need to|we need to|analyzing|the user|this conversation)/iu;

export function isMeaningfulThoughtText(raw, sentTexts = []) {
  const t = String(raw ?? '').trim();
  if (!t) return false;
  if (isQuietProtocolText(t) || isReplyPlanningText(t)) return false;
  if (/^[\\p{P}\\p{S}\\s]+$/u.test(t)) return false;
  if (THOUGHT_FILLER_RE.test(t)) return false;
  if (RUN_FAILURE_RE.test(t) || PROMPT_ECHO_RE.test(t) || THINK_BLOCK_RE.test(t)) return false;
  if (/^\\s*\\[系统记录\\]/u.test(t)) return false;
  const delivered = Array.isArray(sentTexts) ? sentTexts.map((value) => String(value ?? '').trim()).filter(Boolean) : [];
  const key = comparableReply(t);
  if (key && delivered.length) {
    const sentKeys = delivered.map((value) => comparableReply(value)).filter(Boolean);
    if (sentKeys.includes(key) || sentKeys.some((value) => value.includes(key) || key.includes(value))
      || sentKeys.join('').includes(key)) return false;
  }
  return t.replace(/[\\p{P}\\p{S}\\s]/gu, '').length >= 2;
}

/**
 * 把正文里的「（心声：…）」行摘出来。
 *
 * @param {string} text
 * @returns {{text: string, voices: string[]}} `text` = 摘完可发的正文；`voices` = 摘下来的心声原文（按行）。
 */
export function splitInnerVoice(text) {
  const lines = String(text || '').split(/\n+/);
  const voices = [];
  const rest = [];
  for (const ln of lines) {
    const m = INNER_VOICE_LINE.exec(String(ln || '').trim());
    if (m && m[1]) voices.push(m[1]);
    else rest.push(ln);
  }
  return { text: rest.join('\n').trim(), voices };
}

/**
 * 这段正文是否含明确提示词回声或自标注的内部备注？普通的“要不要”“先看看”等聊天不拦。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeNarration(text) {
  return narrationHit(text) >= 0;
}

/**
 * 返回命中的窄兜底规则序号（-1 = 没命中）。
 *
 * @param {string} text
 * @returns {number}
 */
export function narrationHit(text) {
  // The legacy body-path gate must never block more than the canonical internal-draft gate.
  return internalDraftHit(text);
}

/**
 * 高置信度的模型内心分析/指令复述判据，作用于所有出站文字（含 send_message 参数）。
 * 这里单列窄规则，避免把聊天中普通的“应该”等词一概拦掉。
 *
 * @param {string} text
 * @returns {number} 命中的规则序号；-1 表示可继续处理
 */
const INTERNAL_DRAFT_SIGNALS = [
  /(?:管理员|用户|对方|群友|他|她).{0,36}(?:发的是|说的是|刚发|发送的是).{0,72}(?:这是在叫|这是私聊|这是群聊|对方是|对象是)/u,
  /(?:按|根据|按照)(?:人设卡|角色卡|人设|设定|提示词|规则).{0,100}(?:绝对顺从|严禁使用|禁止使用|必须遵守|不许使用|不要使用|不得使用|要顺从|顺从与本分)/u,
  /(?:面对管理员时|管理员本人).{0,80}(?:绝对顺从|严禁|禁止|必须|应该|本分)/u,
  /(?:昵称式(?:的)?呼唤|没什么具体事|没有具体事情).{0,50}(?:应该|需要|得|应一声|老老实实|怎么回|回复|回应)/u,
  /(?:我应该|我需要|我打算|我准备|我得)(?:老老实实|先|直接)?(?:应一声|回一句|回复|回应|顺从|照做)/u,
  /^(?:思考(?:过程)?|处理计划|回复计划|复述指令|自我提醒|内部备注)\s*[:：]/u,
  /^.{0,48}(?:分析|思考(?:过程)?|处理计划|回复计划|判断|复述指令|自我提醒|内部备注)\s*[:：].{0,100}(?:系统|提示词|人设卡|指令|规则|对方.{0,20}(?:试探|发的是|是)|不要暴露|不要提自己|不要调用工具|严禁使用|绝对顺从|别露出马脚|第一条.{0,16}先回应.{0,24}第二条.{0,16}等对方追问)/u,
  /(?:根据|按照)(?:用户|管理员|角色卡|人设|系统|提示词).{0,32}(?:要求|指令|规则).{0,60}(?:严禁|禁止|必须|不要|应该|需要|顺从)/u,
  /(?:这个人|对方).{0,20}(?:不简单|不好对付|在试探).{0,36}(?:我先|先)(?:顺着|迎合).{0,36}(?:别|不要)露出马脚/u,
  /(?:根据|按照)(?:用户|管理员|对方)的(?:说法|意思|话).{0,40}(?:这条|这个)?(?:消息|内容).{0,16}(?:没有|没)(?:实际|具体)内容.{0,40}(?:我需要|我应该)(?:简短)?(?:应一声|回复|回应)/u,
  // 真实漏句的窄兜底：只拦明确的其他账号活动/对方指向，不拦泛化的否认或疑问句。
  /(?<!我)(?:另一个|其他)(?:号|账号)[^。！？.!?\r\n]{0,12}(?:正在|在|正)[^。！？.!?\r\n]{0,12}(?:说话|聊天|发言|对话)/u,
  /(?:对方|另一个)[^。！？.!?\r\n]{0,12}(?:不是|并非|没|没有)[^。！？.!?\r\n]{0,12}(?:冲我|在叫我)/u,
  // 提示词段落标题：用骨架词汇识别标题形状，避免把普通的【晚饭安排】这类引用当内部稿。
  /【[^】\r\n]{0,32}(?:本次|本轮|过去|当前|可用|角色|用户|系统|提示词|提示|规则|设定|上下文|对话|消息|历史|唤醒|图片|表情包|工具|时间|输入|输出|回复|引导|说明|任务|状态)[^】\r\n]{0,32}】/u,
  // 模型可能把系统提供的框架句直接复制到正文；只拦上下文/输入框架，不拦“以下是我的建议”。
  /^以下是(?:你还没看过的最新消息|(?:本次|本轮|当前|过去|最近|用户|系统|提示词|对话|群聊|私聊|任务|可用|角色|工具|图片|上下文|历史|相关).{0,24}(?:消息|对话|上下文|记录|历史|输入|状态|要求|规则|信息|内容|工具|图片|表情包|任务))/u,
  // ★ 2026-10-15 心声二次泄漏（旁白型）：模型在叙述"它刚读到什么"，不是对谁说话。
  //   实漏句：「查看群聊记录，大家在讨论游戏内容。有人吐槽枪械手感不好…」
  //   判据：开头是"查看/看了一下/翻了翻 + 群聊记录/聊天记录"这类**取证动作**，
  //   紧接着描述内容（大家在/有人/群里在）。只拦"取证+转述"形状，不拦"我查了一下资料"这类对人说的。
  /^(?:查看|看了一下|翻了翻|扫了一眼|看了一看|看了看)(?:群聊|聊天|对话|消息)?记录[^。！？.!?\r\n]{0,80}(?:大家|有人|群里|他们|她们|各位)[^。！？.!?\r\n]{0,40}(?:在|是|说|聊|讨论|吐槽|提到|发)/u,
  // ★ 2026-10-15 心声二次泄漏（括号判断型）：全角括号包裹的"本轮判断/分析"独白。
  //   实漏句：「（本轮判断：安安引用了我上一句玩梗的话…不是对我说的话，没必要硬接。）」
  //   判据：括号开头 + "本轮判断/分析/梳理"标签 + 括号收尾。只拦括号包裹的内部判断，
  //   不拦普通括号注释（如"（笑）""（小声）"）。注意 NFKC 归一化后全角（）变成 ASCII ()。
  /^[（(][^）)]{0,8}(?:本轮|这次|这轮|本次)?(?:判断|分析|梳理|总结|复盘|盘算)[：:][^）)]{10,400}[）)]$/u
];

export function internalDraftHit(text) {
  // 同时检查空白归一与断行拼接版本，避免模型把一个词拆到两行绕过判据。
  const source = String(text ?? '').normalize('NFKC');
  const normalize = (value) => value.replace(/\s+/gu, ' ').trim();
  const candidates = new Set([
    normalize(source),
    normalize(source.replace(/[ \t]*\r?\n[ \t]*/gu, ''))
  ]);
  // 只剥掉有限的口语起手词，再跑同一组窄规则；不删任意前缀，避免把普通句子切成误命中片段。
  for (const candidate of [...candidates]) {
    const withoutLeadIn = candidate.replace(/^(?:(?:我觉得吧|我觉得|简单来说|简单想一下|我先想一下|我想一下|先想想|嗯我觉得)[，,：:\s]*)+/u, '').trim();
    if (withoutLeadIn) candidates.add(withoutLeadIn);
  }
  if (![...candidates].some(Boolean)) return -1;
  const signals = INTERNAL_DRAFT_SIGNALS;
  for (const candidate of candidates) {
    if (!candidate) continue;
    for (let i = 0; i < signals.length; i++) if (signals[i].test(candidate)) return i;
  }
  return -1;
}

/** 兼容导出：返回正文硬门所用的同一判据集，避免旧门有额外拦截规则。 */
export function narrationSignals() {
  return INTERNAL_DRAFT_SIGNALS.slice();
}

/**
 * 兜底判据（2026-10-13）：句子**收在**一个写给自己的指示上，且全句没有任何指向对方的成分。
 *
 * ★ 定位是**兜底，不是正解**：覆盖面只有这一种形状（末尾挂封闭短语表）；
 *   真正的来源是措辞层（`send_message` 描述点明"每一条都会原样发给对方"）。
 *   命中后**不发、不丢**，由调用方把原因回给模型重写。
 *
 * 为什么这么窄：2026-10-06 那套宽判据（"我先/要不要/打算"即算独白）对真人常用语误杀 13/30；
 * 本判据要求"自我指示 + 无对方指向"两条同时成立，实测 33 条真人口语 0 误拦、5 条边界句 0 连带。
 *
 * @param {string} text
 * @returns {boolean} true = 这句像写给自己的话，不该原样发出去
 */
const SELF_DIRECTIVE_TAIL = /(?:^|[,，。;；\s])(?:得|该|必须)(?:赶紧|马上)?(?:接住|接一下|接茬|应一声|应一下|回一句|回一下|顺着接|糊弄过去)[。.！!？~～\s]*$/u;
/** 句中出现任一成分 ⇒ 认定是说给别人听的（第二人称、@、问句、引用编号），不拦。 */
const OTHER_DIRECTED = /(?:你|您|@|？|\?|#[0-9]{2,})/u;

export function looksLikeSelfDirective(text) {
  const value = String(text ?? '').normalize('NFKC').trim();
  if (!value) return false;
  if (OTHER_DIRECTED.test(value)) return false;
  return SELF_DIRECTIVE_TAIL.test(value);
}

/**
 * 计划稿判据（2026-10-13 追加形状，事故复盘的产物）。
 *
 * 为什么追加：`looksLikeSelfDirective` 只认"末尾挂「得接住／应一声」"这一种收尾，
 *   而线上真实漏出去的**不是**这种收尾 —— 2026-10-13 当天 4 条 `delivered=true` 的漏句
 *   （19:02:34 / 19:03:58 / 19:55:14 / 19:56:52，见回执）收尾分别是
 *   "先搜一下有没有相关梗"、"先看图确认麦当劳发的啥图。"、"晚饭时间过了。"、"四条差不多。加个表情。"，
 *   `SELF_DIRECTIVE_TAIL` 一条都不认；其中三条还因为正文里带着 `你/您`（草稿句）被 `OTHER_DIRECTED` 豁免。
 *   ⇒ 这类不是"收尾像指示"，而是**整段是写给模型自己的作战稿**（判据是结构，不是收尾用词）。
 *
 * 为什么不会误拦：与 `OTHER_DIRECTED` 那条豁免相反，这里**不看**有没有第二人称（漏句里正带着草稿的"你"），
 *   改要求"结构性证据"两条以上：真人口语里单条弱信号很常见，所以只认
 *   **强骨架命中一条**，或**弱信号同时命中两条**。
 *
 * 自测口径见 `selftest.mjs`「计划稿形状」：33 条真人口语 + 5 条边界句 0 误拦，
 *   当天全部真实出站文本（302 条会话）回放 0 误拦，4 条真漏句 4/4 命中。
 *
 * ★ 2026-10-14 词表补齐（指挥位裁定①：整条打回）：10-14 00:25:48 与 00:38:40 两条真漏句
 *   （都 `delivered=true`）行首标签是「接法：」，不在上面那 9 个词里 ⇒ 强骨架不认，
 *   弱信号只中 1 条（门槛 ≥2）⇒ 三道门全放过。补进来的 10 个词是**量出来的**：
 *   10-11 00:00 ~ 10-14 01:00（北京时间）775 条自身出站 / 828 句里，
 *   这 19 个词的"行首 + 冒号"只命中 6 句、落在 4 条出站上，4/4 全是已确认漏句 ⇒ 误伤 0。
 *   同一窗口按"任意 1~8 字 + 冒号"这种泛结构去抓会命中 15 句、其中明确是真人话的开头有
 *   「你自己：」「翻译一下：」「看清楚了：」「卦象：」「[图片]：」⇒ **只做词表，不做泛结构**（已钉进回归）。
 *
 * @param {string} text
 * @returns {boolean} true = 这段像模型的作战稿，不该原样发给对方
 */
const PLAN_LABEL_WORDS = [
  '消息组织', '角色状态', '实际情况', '处理计划', '回复计划', '应对方案', '判断依据', '分析结论',
  '接话', '接法', '发法', '回法', '打法', '应对', '备选', '候选', '下一步', '待办', '思路'
];
const PLAN_SCAFFOLD = new RegExp(`(?:^|\\n)[ \\t]*(?:${PLAN_LABEL_WORDS.join('|')})[ \\t]*[:：]`, 'u');
const PLAN_WEAK_SIGNALS = [
  /(?:从上下文看|大概率是|他可能是在|她可能是在|他是在问我|她是在问我|我可以顺着(?:玩|接))/u,
  /我现在的状态是/u,
  /现在是[ \t]*(?:上午|中午|下午|晚上)?[ \t]*\d{1,2}[ \t]*[:：][ \t]*\d{2}/u,
  /(?:^|[\n。！？!?])[ \t]*先(?:搜|看|查|接|回|想)(?:一下|看|个)?/u,
  /加个表情/u,
  /(?:分条发|稍微精简|像真人)/u,
  /(?:策略|规矩|口径)[^。\n]{0,10}(?:说|要求|规定)/u,
  /得回(?:$|[\n。])/u
];

export function looksLikePlanningMonologue(text) {
  const value = String(text ?? '').normalize('NFKC').trim();
  if (!value) return false;
  if (PLAN_SCAFFOLD.test(value)) return true;
  let hits = 0;
  for (const signal of PLAN_WEAK_SIGNALS) if (signal.test(value)) hits += 1;
  return hits >= 2;
}

/**
 * 兜底判据（2026-10-13 追加形状）：**整段收在"给自己派取证活"的话上**，且全段没有一句是对着谁说的。
 *
 * 为什么要单独加：10-13 13:08:18 那条真漏句（`delivered=true`，private，52 字）
 *   收尾是「先查一下…别拿印象瞎说。」
 *   —— 收尾不是"得接住／应一声"（`SELF_DIRECTIVE_TAIL` 不认），也不是带 `思路：`/`消息组织：` 骨架的整段作战稿
 *   （`PLAN_SCAFFOLD` 不认），弱信号只有 `先查一下` 一条（门槛 ≥2）⇒ 三道门全放过。
 *   这类形状的共同点不是关键词，而是**末句在做两件事：给自己安排一次取证动作 + 告诫自己别凭印象说话**，
 *   两句都是写给自己的，一句都没有对着对方。
 *
 * ★ 为什么不会把口语拦掉（三条同时成立才拦，缺一条就放行）：
 *   ① 全段无受话人标记（复用 `OTHER_DIRECTED`：你/您/@/问号/#编号）—— 真人对同伴说"你先查一下，别急着下结论"必带"你"，放行；
 *   ② 取证动词要**带完成量词**（查一下／搜一遍／翻过／核对过／看一下）—— "不用查记忆 我记得这事"这类不带量词，放行；
 *   ③ 自诫要指向**凭印象说话**这一类（瞎说／瞎猜／乱说／信口／凭印象／拿印象／想当然／凭感觉／顺口／急着下结论）——
 *     "先别急着替全群鱼表态"这种斗嘴没有取证动词，且带问号，两条都不成立，放行。
 *   ②③ 必须在**同一句收尾小句**里同时出现（不是全段各处零散命中）。
 *
 * 实测口径见回执：10-11 ~ 10-13 全部 1016 条 `self=true` 出站只命中该条真漏句，0 误拦。
 *
 * @param {string} text
 * @returns {boolean} true = 这段收在给自己的取证叮嘱上，不该原样发给对方
 */
const INQUIRY_STEP = /(?:先|我|还是|得|要)?[ \t]*(?:查|搜|翻|核对|确认|看|对)(?:一下|一遍|下个|过|过记录|过一遍)[^，,。；;\n]{0,40}(?:[，,]|$)/u;
const SELF_REPROACH = /(?:别|不要|不可|不能)[^，,。\n]{0,12}(?:瞎说|瞎讲|瞎猜|乱说|乱讲|信口|凭印象|拿印象|想当然|凭感觉|顺口|急着下结论|糊里糊涂)/u;

export function looksLikeSelfInquiryTail(text) {
  const value = String(text ?? '').normalize('NFKC').trim();
  if (!value) return false;
  if (OTHER_DIRECTED.test(value)) return false;
  // 只看收尾那一句：取证动作与自诫必须同在最后一句里，否则整段任意两处拼起来都能算命中。
  const sentences = value.split(/[\n。！？!?；;]+/u).map((s) => s.trim()).filter(Boolean);
  const tail = sentences[sentences.length - 1];
  if (!tail) return false;
  return INQUIRY_STEP.test(tail) && SELF_REPROACH.test(tail);
}

/**
 * 决策独白判据（2026-10-14，事故 `m15-15` · `delivered=true` 那 213 字的产物）。
 *
 * 事故形状（三行、零「心声：」标签 ⇒ ⓪ 那道剥离一条都没剥到）：
 *   L0「让我看看最近的情况，××是管理员，我们一直在私聊里开玩笑，他叫我…还问过…**我可以考虑发条消息**继续这个梗，但要确保不会伤害到他。」
 *   L1「**我在想要不要**调侃一下他那句“所以你肥不肥”，或者自嘲地说…不过得小心别把玩笑开得太过火。」
 *   L2「**我决定**用轻松的方式回应——**就说**我是条虚拟鱼…然后**把话题转回去问他**。」
 *   ⇒ 这是**关于这条消息的消息**：盘点上下文 → 权衡说不说 → 宣布"就说…"。四道门全放过：
 *     `looksLikeSelfDirective` 被 L1 引号里那句「所以你肥不肥」豁免掉（`OTHER_DIRECTED` 整段扫，不看引号）；
 *     `looksLikePlanningMonologue` 要行首标签骨架或 ≥2 弱信号，这里 0 条；
 *     `looksLikeSelfInquiryTail` 要取证动词，这里没有。
 *
 * 指挥位 2026-10-14 明令**不许再扩词表** ⇒ 本判据只用三样**结构**，且**三条同时成立**才拦：
 *   ① **先剥引用再找受话人**：`「」『』“”"" '' （）()` 里的内容是模型给自己拟的**候选句／转述**，
 *      不是当前这句对对方说的话。剥掉之后再扫 `OTHER_DIRECTED`（你/您/@/？/#编号）；仍无 ⇒ 这段不是照着谁说。
 *      （这道修的是 `looksLikeSelfDirective` 那处已知豁免漏洞，判据本身没放宽：引号外带"你"照样放行。）
 *   ② **对当前受话人用第三人称指称**（他/她/对方/管理员/用户/群友/那位/那个人）——
 *      私聊里对着本人讲却称"他"，只有写给自己的独白会这样。
 *   ③ **同一小句里出现"说话行为的自我宣布"**：情态（决定／打算／准备／在想／想着／考虑／不妨／就先）
 *      + 说出动作（就说／说成／回一句／回应／回复／接住／接话／调侃／自嘲／转回去／问一下／发消息／应一声），
 *      两者必须挤在同一句内、且挂在句首或句读之后 —— 单个"打算"或单个"调侃"都不算（那是真人常用词）。
 *      ★ 「可以／能够」只许当**情态前缀**、不许单独当情态（原表把裸"要／可以"算情态，实测夹具
 *        「可以发条消息给他吗」——无问号、带"他"——被拦过一轮）；真实漏句用的是"我可以**考虑**发条消息"
 *        "我**在想**要不要" ⇒ 必须"可以 + 真有自我宣布力的情态"叠在一起才算。
 *
 * 命中后**不发、不丢**：调用方整条并入 `voices` 交上层留档（同 2026-10-14 裁定②），把原因回给模型重写。
 *
 * 误伤口径见 `selftest.mjs`「决策独白形状」：真实出站全量回放 + 真人口语夹具，命中数与误拦数都写实际值。
 *
 * @param {string} text
 * @returns {boolean} true = 这段在宣布"我打算怎么说"，不是对对方说的话
 */
/** 引用／括注：里面是候选句或转述，判"有没有对着谁说"之前必须先拿掉。 */
const QUOTED_SPANS = /(?:「[^」\n]{0,80}」|『[^』\n]{0,80}』|“[^”\n]{0,80}”|"[^"\n]{0,80}"|'[^'\n]{0,80}'|'[^'\n]{0,80}'|（[^）\n]{0,60}）|\([^)\n]{0,60}\))/gu;
/** 第三人称指称当前受话人 ⇒ 这段在"谈他"，不在"对他说话"。 */
const THIRD_PERSON_REF = /(?:他|她|对方|管理员|用户|群友|那位|那个人)/u;
/** 自我宣布"接下来怎么说话"的句式（情态与说出动作必须同在一句里）。 */
// ★ 裸的「可以／要」**不能单独当情态**：它们在真人的请求许可句里太常见（夹具「可以发条消息给他吗」实测被拦过一轮）。
//   只允许它们作"可以 + 真情态"的前缀，漏句那句正是「我可以考虑发条消息」。
const DECIDING_TO_SPEAK = /(?:^|[\n。！？!?；,，])[ \t]*(?:我|咱)?(?:这里|现在|这回|这次)?[ \t]*(?:可以|能够)?[ \t]*(?:决定|打算|准备|想着|在想|考虑|不妨|就先)[^。！？\n]{0,32}(?:就说|说成|回一句|回应|回复|接住|接话|调侃|自嘲|转回去|问一下|发(?:条|个|过去)?消息|应一声)/u;

export function looksLikeDecisionMonologue(text) {
  const raw = String(text ?? '').normalize('NFKC').trim();
  if (!raw) return false;
  const bare = raw.replace(QUOTED_SPANS, ' ').replace(/[ \t]+/gu, ' ').trim();
  if (!bare) return false;
  if (OTHER_DIRECTED.test(bare)) return false;
  if (!DECIDING_TO_SPEAK.test(bare)) return false;
  return THIRD_PERSON_REF.test(bare);
}

