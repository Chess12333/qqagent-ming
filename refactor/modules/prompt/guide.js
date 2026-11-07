/**
 * M8b · system 提示尾部的【引导说明】（G-1 搬运：开局操作手册）。
 *
 * 出处（老树 `src/prompt.js`，只读参照）：
 *   表情包 0~3 档 :1938-1944（逐字；索引严格对应，老树注释警告过错位 bug）
 *   hype 极简引导 :1950-1956（★G-1b 订正：**逐字相同的只有第 1 行标题** `:1951`。
 *     `:1952`「你只有 send_message。正文不会发到 QQ。发完系统自动结束。」**整条删除**（见下"故意没搬"）；
 *     `:1953`+`:1954` **合并改写成 1 行**；`:1955` 改写（"那些工具不存在"→"现在只说话"）。
 *     ⇒ 本段**没有"第 4 行逐字"这回事**，原注释那句是错的，已删）
 *   compact 一行版 :1958（按新树改写）
 *   full 完整版   :1960-1976（★G-1b 订正：**不是"逐字"** —— 例外共 **3** 处，列全：
 *     `:1963` 改写（send_message → 正文即消息）· `:1965` 改写（"什么都不调即可"→"就不用多说什么"）·
 *     `:1975` 整条删除（见下"故意没搬"）。
 *     ⇒ 逐字的是 `:1961 :1962 :1966 :1969 :1970 :1971 :1973`。
 *     原注释写"逐字；两处例外见下"，**漏了 `:1965`** ⇒ 属于"元数据说谎"，已订正）
 *   收尾 :1992（按新树改写）· 身份收尾 :1993（逐字）· tidyBrackets :1972-1974（逐字，条件同老）
 *
 * ★ 唯一必须改写处（票 G-1 §二；新树正文即消息，见 compose.js:25 REPLY_PROTOCOL_REMINDER）：
 *   老树「要发言就调 send_message / 禁止只写正文 / 正文不会发到 QQ」
 *   ⇒ 新树「要说话就用 send_message 说；别只在正文里写想法、旁白」。
 *   老树那句出现在哪一档，就改写哪一档；★ 牙 6 钉死的是**不许出现 A26 之前的「正文即消息」口径**
 *   （`正文不会发到 QQ` 在 A26b 翻案后是真话，【最后一步·硬要求】那句照旧保留）。
 *   ★ 这里刻意不用「分析」二字：`modules/media/auto-vision.js` 的 explicitTask 词表把「分析」
 *     当"对方点名要看图"的触发词，而它求值的文本就是**整块装配好的 user 提示词**（见该文件
 *     `textPart`）。手册常驻一句带「分析」⇒ 凡是带图的轮子都被判成"派活看图"，
 *     附回来的说明从"接情绪"变成"先说清主体、动作/表情，再单列图中文字"的报告体。
 *
 * ★ 故意没搬的（★G-1b 已补全，回执 `.tmp-dispatch/r-g1b-元数据订正.md` 有前后对照）：
 *   ① 网图行 `:1964`（工具条件分支，票未列）
 *   ② finish 分支收尾 `:1983-1990`（finish 教学已在 system【发言方式】，此处不再条件分叉）
 *   ③ 问图/问旧事硬要求 `:2005-2020`（触发条件型，和手册常驻性质不同）
 *   ④ ★补登记 `:1975`「- 记得：你的普通文本输出不会发到 QQ，只有工具调用会。」
 *      **为什么删**：新树"正文即消息"⇒ 这句为**假**；留着会与本文件 `:56`/`:71`
 *      那两句"正文即消息"**直接矛盾**。⇒ 删对了，但原来**不在清单里**（漏登记）。
 *   ⑤ ★补登记 `:1952`「- 你只有 send_message。正文不会发到 QQ。发完系统自动结束。」（hype 段）
 *      **为什么删**：同上，新树口径下为**假**；hype 段已由 `:84` 承担"发完即结束"的语义。
 *
 * 纯函数、无 import（字符串拼装 only）；调用方（buildMessages）从 cfg 解析开关后传入。
 */

/** 表情包积极程度 0~3 档文案（老 :1938-1944 逐字；索引错位即 ticket 级 bug，牙 5 钉死严格对应）。 */
export const STICKER_GUIDES = Object.freeze([
  '- 表情包是备选项，不勉强；纯文字回应完全没问题。',
  '- 合适的时机可以配一个表情包（比如接梗、吐槽、附和），但只在真的贴切时用。',
  '- 积极使用表情包：回应、吐槽、接梗时优先考虑配一个贴切的表情，让对话更有活人感；别每次都用同一张。',
  '- 你是表情包爱好者：能配表情的地方尽量配，接梗/调侃/附和时几乎都会带一张，聊天要有表情包的烟火气；注意换着用，不要连发同一张。'
]);

/**
 * 表情包档位段。level 0 ⇒ null（老 :1935 `lvl > 0` 才附）；非 0~3 整数 ⇒ 直接 throw。
 *
 * ★★ G-1b 订正（2026-10-07，独立只读复核实测）：**下面这个 throw 在生产路径上不可达。**
 *   真相是：`index.js` 里 `const stickerLevel = …` 那行（**紧跟着 `rawEncourage` 的读取**）
 *   **先用 `Math.floor` + `Math.min/max` 把值钳成 0~3 的整数**，才传给本函数
 *   ⇒ 实测 16 个取值（含全部边界与非数：`0/3/'2'/1.5/2.7/0.4/-1/-0.5/99/3.9/null/undefined/''/'abc'/NaN/true`）
 *   中让本守卫为真的次数 = **0**。
 *   ★ 这里**故意不写行号**：写行号就会在"上面加一行注释"时立刻腐烂 —— 本次订正自己就踩了
 *     （先写成 `index.js:280-281`，加完注释它就漂到了 285-286）⇒ **引用一律按代码内容认，不按行号**。
 *   全树 `stickerGuide` 的调用点只有三处：`index.js` 里 `const stickerText = stickerGuide(stickerLevel)`
 *   （生产，**已被钳**）、该文件的 re-export 行、以及 `selftest.mjs` 里 `try { M.stickerGuide(bad); }`
 *   （**直接传非法值，只有它能触发本 throw**）。
 *   ⇒ 所以本 throw 是**库级防线**（防止有人绕过 index.js 直接调它），**不是生产症状出口**。
 *   ⇒ ⚠ **行为一律不许因此改动**：钳法不动、本 throw 不删、不动任何字符串常量。
 *      本条只把注释里原先那句「不静默、不钳制，错了就炸出来」改成与盘面相符的说法 ——
 *      **生产路径是"钳"，不是"炸"**；而非法值被钳成 0 或 1~3 **不留可见痕迹**
 *      （`index.js` 里 `diagnostics.guide = { … stickerLevel … }` 记的是**钳后**的值，
 *      读不到"曾经非法"；实测该字段**只写不读**，全树没有读取点）—— 想让它可见**另开票**，
 *      且必须先给那个字段安排**真实的消费者**，否则就是又一个没人读的假记录。
 *
 * ★ 顺带记一条 G-1 的**正向价值**（复核实测）：老树 `src/prompt.js:1934`
 *   `Math.min(3, Math.max(0, Number(x) || 0))` 对 `x = 1.5 / 2.7 / 0.4` **不取整**
 *   ⇒ 老树 `guide[1.5]` = `undefined` ⇒ 老树会真的把 **`【表情包用法】undefined`**
 *   印进提示词 —— 正是老树 `:1936-1937` 注释警告过的那一类**索引错位** bug。
 *   新树加了 `Math.floor` ⇒ **这个洞被修掉了**（不是回归）。
 */
export function stickerGuide(level) {
  if (!Number.isInteger(level) || level < 0 || level > 3) {
    throw new RangeError(`stickerLevel must be an integer 0-3 (got ${String(level)})`);
  }
  if (level === 0) return null;
  return `【表情包用法】${STICKER_GUIDES[level]}`;
}

/** 档位名 → system 手册变体（lean/soft/soft2 走 full 版；老树 user 侧本就不分档，见 :1948-1977）。 */
export function guideTierForMode(mode) {
  if (mode === 'hype') return 'hype';
  if (mode === 'compact') return 'compact';
  return 'full';
}

const HEART_VOICE_LINE = '- 心声：收尾时可另起一行写「（心声：…）」（≤40字，写你自己的想法、判断或犹豫，不复述群友发言或你已经发出的消息；没有新想法就别编）。它只进你自己的内心记录、下一轮你还能看见，**绝不发进群**；被点名或被直接问时不能只写心声，该回还是要回。';
/**
 * 输出契约（2026-10-14 事故 `m15-15`）：把"要说的话"和"心声"在**结构**上分开 ——
 * 说话只认 send_message 的参数，正文固定只承担"这轮为什么不发"这一句。
 * 为什么不是措辞偏好：那轮模型**没调任何工具**、只在正文里写了 213 字"盘点上下文→权衡说不说→我决定…就说…"，
 * 于是 `compose.js` 的空工具兜底把整段正文合成成 send_message 发了出去（`bodyRecovery.reason = body-sent-via-send-message`）。
 * ★ 这里同时**撤掉一句谎**：三个档位原来都写"正文只作内部记录，不会发到 QQ" —— 那条兜底路径下它确实会发出去，
 *   契约不能靠一个不成立的保证。改成"正文不是发言通道 + 别在正文里排练怎么回"，并说明排练的代价。
 */
const SPEECH_CHANNEL_LINE = '【最后一步·硬要求】要说出口的话只有一条路：写进 send_message 的参数里。正文不是发言通道，只写一句"这轮为什么不发"（不调工具时那段会被当草稿原样发出去，所以别在正文里排练"我决定…就说…""要不要调侃他…"，那属于心声）。';

function fullGuide({ memoryEnabled, tidyBrackets, botName }) {
  const lines = [
    '【引导说明】',
    // ★ 2026-10-18（#10 资格误导收口）：删掉"值不值得说话"这句自评框架 —— 本轮是已经被准入的
    //   一轮，模型的活是"怎么接好"，不是再判一遍"要不要回"（那层判据在 plan/JEV，模型自评只会
    //   多一层无依据的否决）。保留"谁在说话/有没有人找你/有没有话头"这些**事实扫读**。
    '- 扫一眼【本轮上下文】：谁在说话、有没有人在找你、有没有你接得上或想接的话头。',
    '- 想说话就用 send_message 说；别只在正文里写想法、旁白。想引用就带 replyToMessageId，填**聊天记录里那条行首的 #编号**（如 #318，照抄整串：负号、长数字一个字都别改；【本轮上下文】里的新消息和历史行都有，更早的用 get_recent_messages 查）。**绝对不要自己编编号**：填错的编号会被丢掉（系统不会让它引用到别的消息），这一条就等于没引用上。',
    // ★ 2026-10-18（#10）：原句"不回是正常选项，不是失职"无条件成立，会与"被点名必回"打架。
    //   现在把沉默许可限定在"确实没话可说"，并把被找上时的回应义务说清（保留沉默原因写法，
    //   selftest 的"写清这轮为什么不发"契约不动）。
    '- 确实没话可说时才不回：不调用 send_message，在正文简短写清这轮为什么不发，系统自动结束；被点名或明确问到你时该回就回，别用"没什么可说"躲。',
    HEART_VOICE_LINE
  ];
  if (memoryEnabled) {
    lines.push(
      '- 旧事：先 memory_search（默认先搜当前会话，再扩私聊/其它群）。结果标了【当前会话】【私聊】【群】；优先信当前会话。不够再 memory_archive(mode=day, day=…)。查不到就说想不起来，禁止编。',
      '- 想不起某人的喜好/雷点/习惯（推歌口味、不吃什么、在忙什么）：memory_query(query="那个话题")，别拿泛泛的印象硬猜，也别去 memory_search 里翻他随口说的话。'
      // ★★ G-1c（2026-10-07，指挥位读码坐实 + 我复核）：**这里原来还有第三条**，从老树
      //   `src/prompt.js:1971` 逐字搬来，内容是教模型去读
      //   「【记忆】里『**近况：**』后面是对方最近说过的一两句话（带"刚刚/半小时左右"这种粗年龄…）』，
      //     并**让它照着学**：「只在聊到时自然带一句（"**你刚不是说外卖丢了吗**"）」。
      //   ⇒ **已整条删除**，理由是「手册与现实不咬合」，不是文字偏好：
      //     · 新树**从不产出「近况：」** —— 全树 grep「近况：」在 `refactor/**` 命中**仅此一条**
      //       （就是这句手册自己）；`apps/server/api/memory.js` 里白纸黑字写着
      //       「surface: **新树无表层记忆字段**（旧 `member.surface[]`，是半衰期管理的近况条目）」。
      //     · 新树的记忆段真身是 `renderMemoryView` 产出的 **【记忆视图】**，
      //       每行形状是 `- [证据 <ids>] （scope=… · 置信 … · <时间>）<claim>`
      //       —— **没有「近况：」这个子标签，也没有"对方最近说过的一两句"这种数据**。
      //     · 老树侧是真的有：`src/memory.js` 里 `近况：${surfaceText}` 是实拼出来的。
      //   ⇒ 留着它 = **教模型去找一个不存在的数据源** ⇒ 模型只能**编**（手册自己另一处
      //     就写着"禁止编"，这条自相矛盾）。**没有等价物可改写，所以只能删。**
      //   ⇒ 配套：selftest.mjs 里加了「手册⇄现实咬合牙」，把这类错误变成机器可判定
      //     （从手册抽它引用的数据标签，去**真 renderer 的输出**里对账）。
    );
  }
  if (tidyBrackets) {
    lines.push('- 聊天里不要用【】「」[] 这类方块标点包着词，也别在句尾挂方块 —— 直接说人话（这条是硬要求：结尾多余的方块会被自动删掉，写了也白写）。');
  }
  lines.push(
    SPEECH_CHANNEL_LINE,
    `【身份收尾】你是「${botName}」，按角色卡活；别自曝AI/程序，别扯去模型话题。`
  );
  return lines.join('\n');
}

function compactGuide() {
  return `【怎么回】想说话就用 send_message 说；不想说话时，在正文简短写清这轮为什么不发，不调用 send_message。\n${SPEECH_CHANNEL_LINE}\n${HEART_VOICE_LINE}`;
}

function hypeGuide() {
  return [
    '【亢奋·极简引导】',
    '- 想说话就用 send_message 说；发完即结束。不想说话时，在正文简短写清这轮为什么不发，不调用 send_message；别在正文里排练怎么回，那段可能被当草稿发出去。',
    '- 别提表情包/搜图/记忆/拍一拍，现在只说话。',
    HEART_VOICE_LINE
  ].join('\n');
}

/**
 * @param {object} p
 * @param {'full'|'compact'|'hype'} [p.tier] 未知值按 full 处理（显式档位由 guideTierForMode 定，这里不二次告警）
 * @param {boolean} [p.memoryEnabled] 对应老 `api.conversationMemory.enabled !== false`
 * @param {boolean} [p.tidyBrackets] 对应老 `send.tidyBrackets === true`
 * @param {string} [p.botName] 身份收尾用名（空 ⇒ 老缺省'角色卡里那个人'）
 * @param {number} [p.stickerLevel] 表情使用说明档位（0~3），随手册一并放在 system 尾部
 */
export function guideRules({ tier = 'full', memoryEnabled = true, tidyBrackets = false, botName = '', stickerLevel = 0 } = {}) {
  let guide;
  if (tier === 'hype') guide = hypeGuide();
  else if (tier === 'compact') guide = compactGuide();
  else {
    const name = String(botName || '').trim() || '角色卡里那个人';
    guide = fullGuide({ memoryEnabled: memoryEnabled !== false, tidyBrackets: tidyBrackets === true, botName: name });
  }
  return [guide, stickerGuide(stickerLevel)].filter(Boolean).join('\n\n');
}
