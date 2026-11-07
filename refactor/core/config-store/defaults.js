// ─────────────────────────────────────────────────────────────────────────────
// 本文件由脚本从 `src/config.js 第 180–1229 行` **逐字搬运**（生成器：.tmp-dispatch/_t-refactor-gen.mjs）
// 内容 = DEFAULT_CONFIG 整块（全部默认值：api/store/localJev/finishRound/persona2/broadcastSchedules…）
// ★ 搬运原则：**一个字都没改**（含注释与空行），只改了 export 修饰与文件归属。
//   行为等价性靠 selftest.mjs 断言，见回执的「迁移逻辑逐条对照表」。
// ─────────────────────────────────────────────────────────────────────────────

// ★ 搬运适配（本文件唯一允许的第二处改动）：下面这两个常量在原文件里定义在 DEFAULT_CONFIG 之前，
//   且被 DEFAULT_CONFIG 的端口默认值引用（`port: 18080 + Math.max(0, PROFILE_INDEX - 1) * 10`）。
//   **逐字照搬**，只去掉 `export` 前缀（本模块不把它们当公开出口）。它们只读进程环境变量，不碰 data/。
const PROFILE_ID = String(process.env.QQ_AGENT_PROFILE || '').trim();
const PROFILE_INDEX = /^\d+$/.test(PROFILE_ID) ? Number(PROFILE_ID) : 0;

// 默认控制台端口：无 profile = 3210（保持原行为）；profile 2/3… 依次 +1。
// 端口被占用时仍会自动往后找空位（见 app.js start()），也可用 QQ_AGENT_PORT 直接指定。
// ★ 2026-10-05 修（qwen3 实测发现）：搬运生成器把下面第二行**截掉了** ⇒ `Number(undefined)` = **NaN**
//   ⇒ 不设 QQ_AGENT_PORT 时 `DEFAULT_CONFIG.server.port = NaN`（落盘会变 `null`、`/api/instances` 只能如实回 `port:0`）。
//   现按 `src/config.js:137-138` **逐字补回**。
const DEFAULT_CONSOLE_PORT = Number(process.env.QQ_AGENT_PORT)
  || (3210 + Math.max(0, PROFILE_INDEX - 1));

// ★ 搬运适配（第三处，唯一目的：解决跨文件可见性）。DEFAULT_CONFIG.persona2.roleText 的默认值
//   来自 src/persona2-card.js —— 新树不依赖 src/**（README 铁律 1/4），故把那一份常量逐字搬进来。
import { PERSONA2_CARD } from './persona2-card.js';
// ★ 搬运适配（第四处，同上）：DEFAULT_CONFIG.persona.roleText 等默认值引用了 PERSONAS。
import { PERSONAS } from './personas.js';
// ★ 搬运适配（第五处，同上，逐字照搬 src/config.js 的这一行）：
const BOT_ALIAS_KEYWORDS = Object.freeze(['鲸鱼娘', '胖鲸', '小鲸鱼', '异色鱼']);



export const DEFAULT_CONFIG = {
  // OpenAI 兼容 API（必填才能跑）
  api: {
    // 出厂留空：这是作者本机的网关地址，对其他人毫无意义，
    // 留空能让「就绪度体检」正确提示"还没填 Base URL"。
    baseUrl: '',                             // 例如 https://api.deepseek.com/v1 或自建网关
    apiKey: '',
    model: '',                              // UI 里选择/填写
    provider: '',                           // 当前模型所属提供商（多提供商目录的选中项）
    vision: true,                           // 模型是否支持图片输入（关掉则移除看图工具）
    // 旧版认图闸配置保留以兼容已有 config；当前运行时不再使用。
    // Jev 只收到文字和图片数量、没有图像像素，不能可靠判图文相关性；
    // 前置判定还会挡掉真实图片或在主回复前额外发起模型调用。原图现直接交给主视觉模型。
    imageGate: 'hybrid',
    // ── 自动看图·总开关（N83 追加，2026-10-10）──
    // ★ 形状**照老树**：`src/orchestrator.js:3061` 是 `cfg.api?.autoVision !== false` —— 一个**标量布尔**；
    //   新树同款读点在 `modules/orchestrator/compose.js:956`
    //   （`cfg?.get?.('api.autoVision', true) === false` ⇒ 记一条 `compose-auto-vision-skip {skip:'disabled'}`，
    //   **不下载、不附图**，直接跳过）。这把键**本来就有线**，原来缺的只是"它在 DEFAULT_CONFIG 里没有 ⇒
    //   面板看不见 ⇒ 用户只能手改 config.json"（指挥位裁定：补）。
    //   ⚠ 为什么不是 `api.autoVision.enabled`：同一个路径**不能既是标量又是块**。做成块会让上面那个
    //   `=== false` 永远不成立（对象不等于 false）⇒ "一键关掉"静默失效，而 orchestrator 自己的自测
    //   （`modules/orchestrator/selftest.mjs:2459`）喂的是假 cfg、照样绿 —— 典型的"测过了但其实坏了"。
    //   ★ 关掉时的明确口径：**完全不附图**（既不下载图片，也不另造一份"文字占位"；提示词层原有的
    //     `〔图片 · 媒体 id〕` 记号归提示词侧，不由看图模块复刻）。这是 N79 那类
    //     "一张大图把整轮撑爆 ⇒ 模型哑掉"事故的逃生门，所以它必须是个**能一键关**的真键。
    autoVision: true,
    // ── 自动看图的体积上限（N83，2026-10-10）── 与上面那把开关同族（平铺兄弟，同 `api.memeAutoCue` /
    //   `api.memeCueMinScore` / `api.memeCuePlayfulOnly` 一族的写法）
    // 为什么要这两道闸（N79 实测）：png/jpeg 在新旧两树的 `toVisionDataUrls` 里都是**原样透传**
    // （不转码、不缩尺寸），用户发一张手机原图/长截图（实测 8.6MB ⇒ base64 11.5M 字符）整张挂进
    // user 消息，那一轮模型直接 0 字输出 —— 不是"看不见"，是"图太大把整轮撑爆"。
    // sp2 已把闸落进 `modules/media/auto-vision.js`（commit 9a898aff），当时阈值是写死的常量；
    // 这两个键就是把它做成可调，**默认值 = 他现在的常量**，谁也没改变行为：
    //   · `autoVisionMaxBytesMB`：单张**下载到的原图字节**上限，单位 MB
    //     （命名照本仓库既有的 `security.imageSend.maxBytesMB`；老树**没有**自动看图这一档，
    //      那一条服务的是 send_image 出站发图，功能不同，只借它的单位与写法）
    //   · `autoVisionMaxTotalChars`：一轮里**附进提示词的 base64 字符总数**上限，单位是字符个数
    //     （不是字节 —— 与 `*MaxChars` 一族同口径；3,145,728 个 base64 字符 ≈ 2.25MB 原图）
    // 非法值口径（接口形状，给 sp2 读键时照抄）：读到**非有限数或 ≤0** ⇒ **回落这里的默认值**，
    //   不当作"不限制"。理由：N79 修的就是"没有上限"，让 0 变成无上限等于给用户一个一键退回 bug 的按钮。
    //   真要放松，请填一个更大的正数（比如单张 4、合计 6291456）。
    // 读点已接：compose 读取这两个键并传入 limits；auto-vision.js 的 attachTriggerImages
    //   未收到有效 limits 时通过 cfgLimit 读取配置，非有限数或 ≤0 回落默认值。
    autoVisionMaxBytesMB: 2,
    autoVisionMaxTotalChars: 3 * 1024 * 1024,
    // 关闭模型"思考模式"。按端点自动选参数（常见国内均适配）：
    //   阿里百炼 enable_thinking:false · 火山/智谱/Kimi/DeepSeek thinking.type=disabled
    //   硅基流动 chat_template_kwargs · 未知中转试 enable_thinking，400 自动去掉重试
    //   OpenAI 官方/本地推理不发该字段。
    //
    // ⚠️ 2026-09-11 重测结论（号A = qwen3.7-flash，6 个真实会话 × 2 次，另一个模型盲评）：
    //   关思考 输 8 : 赢 4 —— 会出现"不是""对"这种一个词的回复，约 1/3 还把回复写成
    //   内心独白（正文不发送 → 群里静默），用户感受就是"这模型好蠢"。
    //   所以对混合推理模型**不建议**直接关思考；更好的做法是关掉这个开关、
    //   改用下面的 thinkingBudget 限长思考（128~320 就能兼顾脑子和速度）。
    disableThinking: false,
    // 思考长度上限（开思考且端点支持时生效；0 = 不限制，用端点默认）。
    // 百炼 thinking_budget / 方舟·智谱·Kimi thinking.budget_tokens。
    // 实测 qwen3.7-flash：不限制 → 8~37 秒；128 → 约 2.3 秒；320 → 约 5.0 秒。
    // 号A 目标配 64：目标把思考压到约 2 秒内，同时仍保留一点脑子（好过关思考）。
    thinkingBudget: 64,
    // 上下文缓存模式：
    //   adaptive = 自适应（推荐）：保温开着 → 始终打 cache_control + 自动保温续 TTL；
    //              保温关掉 → 退回纯隐式（不打标记）。见 src/cache-keepalive.js。
    //   implicit = 只稳定前缀，不发 cache_control（无 5 分钟硬过期/创建溢价）；
    //   explicit = 稳定 system 末尾始终打一个 cache_control（不打保温）；
    //   off      = 旧布局，不为缓存搬运静态块。
    // null 用于兼容旧配置：未迁移时仍读取下面的 explicitCache。
    //
    // ⚠️ 2026-09-21 实测（qwen3.8-flash，真实提示词）：可缓存前缀（工具 5,457 + system 8,760
    //   = 14,217 tok）占整个提示词的 86.8%，但因为百炼显式缓存只有 5 分钟 TTL 且"命中才续期"，
    //   而 QQ 聊天常常十几分钟才两句 → **每次运行的首次调用命中率只有 33~38%**，等于每轮都把
    //   这 14,217 tok 按原价重算。所以新增 adaptive：保温开着就始终打标记 + 保温续期。
    //
    // ⚠️ 2026-09-22 实测（同一提示词，冷/热互相打标记）：**隐式创建的缓存块对显式请求不可见** ——
    //   不带标记的那次调用建好的块，带标记的调用完全命中不到（0% + 按 125% 重建）。
    //   所以"冷着就不打标记"是错的：那样只会让热起来之后的第一枪白废一次创建费。
    //   现在只要保温开着就一律打标记，第一枪付 125%，之后每一枪都命中 10%。
    // ⚠️ 2026-09-22：默认值从 null 改成 'adaptive' —— 与线上实例保持一致。
    //   null 会被 resolveCacheMode 判成 'off'（既不搬静态块也不打标记），
    //   于是"新装/未迁移的实例"和"跑了一阵的实例"行为完全不同，
    //   同一个包里两份配置两种命中率。老配置里有显式值的不会被覆盖（见 migrateCacheMode）。
    cacheMode: 'adaptive',
    // 缓存保温（仅"画像 warm"的端点生效：目前只有百炼显式缓存这类短 TTL 端点）：
    //   命中一次之后，按 intervalMs 发一次 1-token 的极小请求，把 5 分钟 TTL 一次次续上，
    //   下一轮消息来时首调用就能命中。实测 T0 建缓存 → T+3.5min 保温 → T+6.6min 仍命中。
    //   一次保温约 0.0001 元，省下的是首调用里 14,217 tok 的原价 → 净赚约 7 倍（2026-09-21 实测，号A）。
    //   quietAfterMs 内没有新消息就自动停，不白烧；maxPerChat 限制每次运行后最多续几棒。
    //   ★ minPrefixTokens（2026-10-16 起是**真门槛**）：0 = 不限制；只认"已确认的稳定前缀 token 量"
    //     （命中时报的 cached / 冷创建时官方报的 creation），量未知时保守 skip；门槛只作用保温。
    // ⚠️ 2026-09-22：maxPerChat 3 → 6、quietAfterMs 10min → 30min，与线上实例对齐
    //   （3 棒 × 4 分钟 = 12 分钟覆盖，只够聊两句；6 棒 = 24 分钟，才盖得住"群里隔一会儿说一句"）。
    cacheKeepAlive: {
      enabled: true,
      intervalMs: 240000,
      maxPerChat: 6,
      quietAfterMs: 1800000,
      privateMaxPerChat: 8,          // 私聊更长：本来就来一句停一会儿
      privateQuietAfterMs: 1800000,
      minPrefixTokens: 4096
    },
    // 旧字段只作迁移兼容；新设置页会同步写入。不要直接用它判断布局。
    explicitCache: false,
    temperature: 0.8,
    // 采样参数（可选，0/空 = 用端点默认）。本地小模型建议：
    //   topP 0.9、frequencyPenalty 0.4、presencePenalty 0.3、maxTokens 220
    // 这组能明显压掉"复读同一句"和"长篇大论"。
    topP: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    maxTokens: 0,
    // 可选：本地端点预算放大试验（仅 localhost 且 enabled=true 时生效）。
    localReplyTrial: { enabled: false, autoFinish: false, complexTokens: 3072, maxTokens: 4096 },
    // 通用自动收尾（任意模型，含云端）：一轮里只发了消息、没有待办、也没报错时，
    // 直接结束本轮，不再为让模型说一句「我讲完了」多跑一整轮。
    // 护栏见 local-reply-policy.js 的 canEndReplyBatch（发图/搜索未完成、疑似半截话一律不收尾）。
    autoFinish: { enabled: true, multiOnly: true },
    // ★ 2026-10-04（用户拍板）：finish 轮开关（默认开 = 恢复 09-20 之前那套"模型调 finish 收尾+自评"）。
    //   开：交付完这一批、又没待办时，**不立刻收尾**，而是给模型**一次收尾轮**去调 `finish`
    //      （参数 summary/mood/favorDelta，可选）—— 情绪、好感、跨轮记忆、心声都在这一轮自评；
    //      若模型**同一轮里**已经调过 finish（=自己认为这轮没什么可自评的），就不再多跑那一轮。
    //   关：回到"发送成功即自动收尾"（**注意：不等于回到 dfb7d4dd 那版** —— 门 1 是无条件拆掉的，
    //      而且这个开关**同时会把 `finish` 从下发给模型的工具表里摘掉**，见 orchestrator 的工具过滤）。
    //   ★ 用户口径（2026-10-04 逐字）：「**finish 默认打开，如果谁不喜欢就让他自己关去**」。
    //   ★ `finish` 是**收尾协议工具**，不受 `api.tools` 白名单管（白名单只收窄"能力"工具）——
    //     两个线上号的 `api.tools` 都不含 finish，靠这条豁免才能拿到它。
    finishRound: { enabled: true },
    // ⚠️ **已停用（2026-10-04）**：这是 T63 那道"裸发言多给一轮"的门（门 1）的档位杆。
    //   用户 2026-10-04 明令拆掉门 1（它与 finish 轮抢同一个位置），`orchestrator.js` 已不再读它。
    //   键与归一函数**保留**只为兼容老配置（删了会让老配置文件多出一坨未知键），改它不会再有任何效果。
    minToolCallsBeforeFinish: 2,
    // 工具子集（小模型建议开）：只列名字就只暴露这几个工具。
    // 例：['send_message','send_image','search_images','web_search','web_fetch','list_stickers','send_sticker']
    // 留空 = 全部工具都给。
    tools: [],
    maxRounds: 12,                          // 单次运行的最多工具轮数
    // ★ 2026-10-13 已废弃（读点随 `7c7c0bf1`「正文裁判不再否决成稿」删除）：本键**不再被任何代码读取**
    //   （"只写正文时催一次"的逻辑随该提交一并删掉）。条目**留档不删**（指挥位裁定 B）：
    //   台账判 dead、面板控件会被锁成死键 —— 与 api.costGuard.dayPromptMax / chatPromptMax
    //   同一处置（曾存在过的键留在 defaults 供老配置对照，由台账与真值表表达"这功能没了"）。
    nudgeTextOnly: true,
    // 协议提醒（默认开，2026-09-11 实测有效）：在用户提示词**最末尾**追加一句
    // "要发言就立刻调用 send_message，不打算说话就调用 finish"。
    // 实测号A（qwen3.7-flash）同一批真实会话 ×3：不加 22% 的运行整轮不调工具
    // （群里静默），加了降到 6%。成本约 60 token/次。
    replyReminder: true,
    // 会话考古（memory_search）：按需检索很久以前的聊天碎片。
    // 号A（远程、能力够）开着；号B（本地/弱模型）建议 false，避免瞎调/乱编。
    // maxSearchPerRun：单次运行内检索合计最多几次（0=不限，不建议）
    // ★ 2026-10-12 用户裁定：缺省 5 → 3（"别一直搜"）。读点 act/executors/memory.js:165
    //   的代码兜底本来就是 3，这次让 defaults 与兜底一致。
    //   ⚠ 若界面曾保存过这项，data/config.json 里的旧值优先于缺省（合并口径 mergeConfig），
    //     改缺省后要到界面把这项设成 3（或从配置文件里删掉）才会真的生效。
    conversationMemory: { enabled: true, maxSearchPerRun: 3 },
    // 问旧事时：句式命中则注入硬要求，并本地预检索塞进提示词（仍不常驻每条消息）。
    memoryRecallReminder: true,
    memoryAutoPrefetch: true,
    // 梗库联想：弱相关也可「突然想起」1~2 条梗名（不灌全文）；false 关闭
    memeAutoCue: true,
    // 触发联想的最低分（越低越容易闪；2.5≈沾边就闪，5≈强命中）
    memeCueMinScore: 2.5,
    // 场合闸（2026-09-22 默认开）：只有这轮真有"接梗/玩闹"信号才查梗库。
    // 868 轮实测：不开闸时 72% 的闪梗落在不需要玩梗的轮次（报错/点歌/广告），
    // 而有信号的轮次 65% 没闪，模型采用率 0/193。判据是现成的词表，零成本零延迟。
    // 设 false 退回老行为（每轮都可能闪）。
    memeCuePlayfulOnly: true,
    // 架构增强（本地为主，短注入）：待办默认保留；跨轮摘要/语义卡默认关闭，
    // 需要时可单独开启。原始最近聊天与 memory_search 不受影响。
    architecture: {
      crossTurnWorking: false,
      semanticCards: false,
      semanticTopN: 2,
      // 跨群旁听默认关：要读其它会话消息文件，和【过去状态】职责重叠、又砸缓存前缀
      crossChatAwareness: false,
      crossChatMinutes: 10,
      crossChatMaxChats: 2,
      crossChatMaxChars: 120,
      // 每个目标会话单独声明它可以读取哪些来源会话；无授权关系时不跨群传递话题。
      // 结构：{ "group:目标": ["group:来源"], "private:目标": [...] }
      crossChatRoutes: {},
      // ⚠️ 2026-09-23 新增：私聊要不要参与"旁听"。
      //   默认 false = 只旁听其它群，私聊内容不会漏进群里（旧行为是混在一起的）。
      //   打开 = 恢复旧行为（私聊里的动静也会出现在别的会话的提示词里）。
      crossChatIncludePrivate: false,
      // ⚠️ 2026-09-23 新增：**在私聊里**要不要注入"别处动静"（目标侧）。
      //   两件事要分开看：crossChatIncludePrivate 管"收谁的消息"，这条管"往哪儿说"。
      //   默认 false：私聊里不再注入别的群聊什么 —— 方案 §10 的默认范围表把
      //   「群内梗/群内约定/当前工作进度」归到**当前会话**，跨群只该在群与群之间发生。
      //   实测（改造前）：private 会话有 4.0%（101/2500）的提示词带着别群话题，
      //   机器人在私聊里可能顺口提到别的群。打开可恢复旧行为。
      crossChatInPrivateChat: false,
      workingTtlMin: 90,
      // 静默淡忘：空窗每满 N 分钟丢掉最早一轮跨轮记忆；0=关闭逐条淡忘（只留整体 TTL）
      workingDecayMin: 30,
      workingMaxChars: 160,
      // 待办状态机：LLM 自定过期分钟数；到点自动不注入
      pendingTodos: true
    },
    // 成本护栏：**当日 prompt+completion token 总量**超过上限才启动（削减可选注入）；
    // 未超 ⇒ 完全不干预。度量口径 = token 数（不是条数/字符数），
    // 真实日总量由 `core/observability` 的 `dayTokenTotal()` 聚合（不受 recent 2000 行夹子影响）。
    costGuard: {
      enabled: true,
      // ★ B7（2026-10-11 用户裁定）：默认上限 3000 万 token/天。
      dayTokenMax: 30000000,
      // ↓ 旧键：只作**迁移来源**保留，不再参与判定（chatPromptMax 的干预按裁定去掉）。
      //   老配置里显式设过 dayPromptMax 的，由 migrateCostGuardTokenMax 平移到 dayTokenMax。
      dayPromptMax: 800000,
      chatPromptMax: 200000
    },
    // ★ 2026-10-12（指挥位裁定，按 §3.2 新增持久配置）；★ 2026-10-18（用户追加：出厂默认无限）：
    //   · `hardLimitTokens`：达到后拒绝新的付费请求（硬额度）。**出厂默认 null = 无限**：不设全局硬上限，
    //     付费请求（主回复与云判定）照常继续；已配置的 `instanceShares` 仍单独限制实例。
    //     ⚠ 不要用 0/NaN/超大数字冒充无限：0 = 拒绝所有正估算请求；NaN/'abc' = invalid（fail-closed）；
    //     超大数字只是把拦截推迟。老配置里显式设置的有限额度**原样保留**，不迁移、不清理。
    //   · ★ 不许拿软阈值 `api.costGuard.dayTokenMax` 当硬额度用（§10.2 明文禁止）：
    //     那是"当日用量超了就削减可注入内容"的告警口径，不是"拒付"的额度，两者度量与后果都不同。
    //   · `instanceShares`：双号（多实例）首版的互不重叠份额，形如 { 实例 id: token 数 };
    //     默认 null = 不分实例份额；若设置全局硬额度，由全局额度限制总用量。
    //   · 读点：`apps/server/console-api.js` 的 `getCostGuard`（响应里的 `budget` 块）；
    //     生产装配创建预算服务；未配置全局硬额度时仍可请求，已设置的实例份额独立生效。
    budget: {
      hardLimitTokens: null,
      instanceShares: null
    },
    // 正文裁判（默认开）：模型整轮没调工具、只写了正文时，用一次极小提示词的调用
    // 判断这段正文是"成品消息"还是"内心思考"——前者补发出去（否则群里静默），
    // 后者丢弃（防止把"没人叫我…安静结束"发进群）。
    // 判定失败一律按"内心思考"处理（安全侧）。关掉设为 false，则退回旧的盲发兜底。
    textOnlyJudge: true,
    // 号 A 可选：用一次短上下文裁判补回漏发正文（含已发消息后的补充），
    // 校验原文来源并去重。失败时不盲发；保留 finish 的安静结束语义。
    protocolRecovery: false,
    // 裁判调用的输出预算。会思考的本地小模型容易把 300 token 全花在 reasoning 上，
    // 这里默认给 1200；本地小模型裁判也不准，建议保持 textOnlyJudgeLocal=false。
    textOnlyJudgeTokens: 1200,
    // 是否允许"本地端点"当裁判（默认 false = 跳过）。
    // 本地小模型（≤4B 级）长提示词下不可靠，本地跑得动 9B+ 再打开。
    textOnlyJudgeLocal: false,
    // ★ 2026-10-13 已废弃（读点随 `7c7c0bf1` 删除）：正文裁判不再否决成稿后，
    //   "裁判不可用就盲发"这条兜底失去前提，compose.js 也不再读它。
    //   条目留档不删（指挥位裁定 B）：台账判 dead、面板控件锁成死键（同 nudgeTextOnly）。
    textOnlyFallback: true,
    timeoutMs: 180000,
    // 成本核算（仅本地估算展示，不参与任何请求）
    priceInputPerM: 0,      // 输入单价（元 / 百万 token）—— 兜底默认值
    priceOutputPerM: 0,     // 输出单价
    priceCachedPerM: 0,     // 输入且命中缓存的单价；留 0 时按 priceInputPerM 计
    useOfficialPrice: true, // true = 优先用内置官方价格表（按模型 id 匹配）
    // 远程价格表 URL（可选）：指向一个自托管的 JSON（格式见 scripts/export-prices.mjs 产物）。
    // 启动时拉取一次，之后每 24 小时自动刷新（失败过 3 小时重试）；
    // 拉取全程异步、失败不清表 —— 对正常使用零影响。
    // 远程条目按模型 id 覆盖内置表，内置表其余条目仍是兜底。
    priceRemoteUrl: '',
    // 按模型单独设定的价格：{ [模型 id]: { in, out, cached } }
    // 优先级最高 —— 一旦这里有记录，就不再用内置官方表，也不受全局默认单价影响。
    // 改动只存在这里，不会回写内置价格表（src/model-prices.js）。
    modelPrices: {}
  },
  // 多提供商模型目录（设置页手动维护）
  providers: [],
  // ★ 2026-10-17（用户令：每个厂商有专属缓存优化方式，可在设置切换）：
  //   `providers[]` 每项可带可选 `cacheStrategy` —— auto / deepseek / dashscope / zhipu / mimo / compatible，
  //   缺省 auto；**按 provider id 各存一份**（不做全局策略）。非法值由
  //   `core/config-store/index.js` 的 `readProviderCacheStrategy()` 安全回 auto 并带原因（读时归一，不改盘上原值）。
  //   语义：只影响"发不发厂商专属缓存参数"，**不改** thinking/视觉/baseURL/key，手选也不冒充原厂身份；
  //   `compatible` = 不发厂商专属参数（**不**表示厂商自动缓存被关闭）。
  //   `api.cacheMode` 与 `api.cacheKeepAlive.*` 的用户值保持原样；本字段**不会**自动打开付费保温。
  dshProviderKeys: {},   // providerId -> 真实 API Key（providers[] 里不再存明文 Key）
  providersSourceYaml: '',
  providersImported: true,
  // 情绪系统总开关（控制台「情绪」页顶部也有一键）。
  // 关掉 = 不再因群友发言调整情绪/心情，提示词里也不再注入心情与情绪标签。
  // 精力仍按钟点目标 + 聊天消耗运转；世界系统开启时还会叠加日历/账本修正。
  emotion: {
    enabled: true,
    // 情绪事件忽略名单；旧配置路径 persona.ignoreSenderIds 由 config-store 映射兼容。
    ignoreSenderIds: [],
    // 旧 ramp：含义不变，只管**负向与好奇**，范围 [0.5, 2.5]，分界仍是各档
    // 原 softCeil.floors[2]（默认 52 分）。生产配置里的 1.8 原样保留、不迁移、不覆盖。
    ramp: 1,
    // 正向专用爬坡（posRamp 方案 2026-09-29）：只作用 POS_EMO，
    // 仅正向表 softCeilPos 的 floors[1]（=40）以下才乘；范围 [0.5, 1.5]。
    // 缺失/默认 = 1，**不回落读 ramp**（ramp 是负向/好奇的旧值，1.8 不得当正向倍率）。
    posRamp: 1,
    // ★ 活性旋钮 A「一次影响多大」（2026-10-14 用户裁定"更敏感"）：
    //   conservative / medium / aggressive → 决定 ramp/posRamp 倍率。
    //   默认 medium（ramp=1.8, posRamp=1.3）：比现状更敏感，单次幅度仍有上限。
    //   显式给 emotion.ramp / emotion.posRamp 时优先于档位（向后兼容）。
    amplitudeLevel: 'medium',
    // ★ 活性旋钮 B「多快回落」（2026-10-14 用户裁定"时间回落"）：
    //   conservative / medium / aggressive → 决定 halfLifeMul 系数。
    //   默认 medium（halfLifeMul=0.8）：比回落更快，确定性衰减。
    decayLevel: 'medium'
  },
  // 本地 Jev 式决策旁路：包内 llama-server + 小 Qwen，只做结构化小决策，不当聊天主脑。
  // roles 能填哪些、各自管什么、判错后果 —— 以 local-jev.js 的 JEV_ROLES 目录为唯一出处
  // （控制台「设置 → 本地 Jev」按那份渲染，这里不再抄一遍清单，抄了就会对不上）。
  localJev: {
    // ★ 2026-10-06 主人令：「先默认把 jev 关掉吧，到时候改完了再开」。
    //   新树默认关（老树默认开）。理由：本地 0.8B 每轮问一次拖慢响应，且新树
    //   replyChance 那批旋钮尚未接线（见 .tmp-dispatch/r-频率-诊断.md）。
    //   想开回来：设置页「本地 Jev」把总开关打开即可（值会落到 data/config.json）。
    enabled: false,
    // ★ 2026-10-18（合同）：`judgeMode` 是**云裁判全局请求总闸**，缺省关闭。
    //   关闭 = 自由接话/聚焦续聊/记忆补判都不发起云判定请求（不是仅改 UI 文案）；
    //   打开后由编排层按 judgeMode 路径执行。旧配置里显式 true 保留，不强行清空现有设置。
    //   `prompt`：业务判据字符串，空串 = 内置默认（judge.js 的 JUDGE_PROMPT，已按用户口径放宽）；
    //   非空 = 自定义业务判据（只换判据文本；固定 JSON 输出约束/字段校验/预算/授权边界不受影响）。
    judgeMode: { enabled: false, prompt: '' },
    // 打开软件时就把本地模型拉起来（默认开）。关掉 = 回到「懒启动」：
    // 一直等到第一次真要用它才起进程，省内存，但第一问要多等几百毫秒。
    // ⚠️ 它只在 enabled=true 时有意义 —— enabled=false 时任何情况都不会起。
    startOnLaunch: true,
    // 例：不带 profile = 18080；profile 2 = 18090（每份实例错开 10 个端口）。
    // ⚠️ 2026-09-22：以前这里写死 18080，于是「复制一份目录再开第二个号」
    //   会两个实例抢同一个端口：第二份的 llama-server 起来就 EADDRINUSE 退出，
    //   UI 上只显示「未启动 / llama-server exit 1」，用户完全看不出是端口撞了。
    //   现在默认按实例号错开；而且 local-jev.js 起不来时还会**自动往后找空位**
    //   （18080→18081→…），所以就算配置里存着老值也不会两个人抢一个口。
    port: 18080 + Math.max(0, PROFILE_INDEX - 1) * 10,
    modelPath: 'models/Qwen3.5-0.8B-Q6_K.gguf',
    exePath: 'runtime/llama/llama-server.exe',
    modelId: 'qwen3.5-0.8b',
    ctxSize: 4096,
    maxTokens: 16,
    gpuLayers: 0,
    // 弃权阈值（标签分布概率）。实测扫出来的操作点（见 docs/Jev-优化记录.txt）：
    //   p≥0.6 且 margin≥1.0 → 0.8B 采信 74%、采信部分正确率 86%；
    //   旧规则（p≥0.75 一刀切、p 还是几何均值）是采信 33%、正确率 87% —— 同样准，覆盖面翻倍多。
    // 调高=更保守（更少采信），调低=更激进。两个阈值要一起看。
    minConfidence: 0.6,
    // 前二名标签的对数间隔下限。0.8B 的概率绝对值不太可靠，但「和次选差多少」更可靠：
    // margin 小的题几乎都是它自己也在犹豫的题。调 0 = 只按概率弃权。
    minMargin: 1.0,
    // 用 grammar 把输出**硬约束**成标签本身（YES|NO|是|否…）：
    // ① 再不会有「答了句废话 → 解析失败」的浪费；② 前缀 token 归属唯一，概率才算得准。
    useGrammar: true,
    // 在途请求上限（跟 llama-server --parallel 一致）；排队超过 maxQueue 直接弃权不拖主流程
    maxInflight: 2,
    maxQueue: 6,
    inputMaxChars: 160,
    // ★ 2026-10-16（用户样本）：判定曾以 `JUDGE_UNAVAILABLE: 云判定未完成 (jev-timeout 2500ms)` 失败
    //   —— 第三方中转 + 思考模型下 2.5s 常见不够。默认提到 **5000ms**（主会话记录里给的候选观察起点；
    //   不声称五秒必定够）。显式配过 2500 的取值不受影响。
    // ★ 2026-10-19（第五批 · 用户裁定"云裁判自定义响应" = 可调响应超时）：有效区间统一
    //   **1000..120000ms**（UI 按秒 1..120）；**15s 静默硬顶已取消**（填 60000 就按 60000 等），
    //   非法值按明确默认 5000 回退并在判据行留原因；本键仍是云裁判专用，不影响主模型/主动发言。
    judgeTimeoutMs: 5000,
    // ★ 2026-10-16（用户令：判定"经常未完成"，要能单独指定厂商、与发言拉开）：
    //   `judgeApi.mode='follow'`（默认）逐字沿用发言的 provider/baseUrl/model/key（旧行为不变）；
    //   `'independent'` 时用 `providerId` + `model`，其 baseURL 与 Key **都从同一个已保存提供商条目解析**
    //   （Key 走 `dshProviderKeys[providerId]`，不在这里复制明文、不新增密钥字段）——
    //   独立模式任一项解析不出 ⇒ 判定不可用并如实说明，**绝不悄悄退回发言厂商**。
    judgeApi: {
      mode: 'follow',
      providerId: '',   // providers[].id（在「设置 → 模型/供应商」里管理；判定只借它的 baseURL + Key）
      model: ''         // 判定专用模型名（建议非思考型号；不与发言模型联动）
    },
    // 判定输出预算（max_tokens）：判定只要一行 JSON，384 足够；若开启思考可按需调大。
    // 合法区间 **128..1024**（非法/缺失回 384，并在状态里明说"填的是 X、实际按 Y 用"）。
    // ★ 上界 1024 由**联合硬上限**推出来：单次请求"输入上界（utf8 字节 + 协议余量） + 本值 ≤ 2000"
    //   （J1 用户裁定），而最小一次判定的输入上界 ≈ 880 ⇒ 1024+880 ≤ 2000，**任何合法配置都放得下**。
    //   要更大的输出请先抬总上限（另一条裁定）。
    // 正常判定另有"约 600 token/次"的**软目标**（软裁剪只动 recent/关键词尾巴，不裁焦点/授权/话题）。
    // 思考与正文共享这一份 max_tokens（百炼官方 usage 里 reasoning_tokens 属于 completion_tokens），
    // 所以"开启思考"要把本值一起调大，别指望思考另跑一份预算。
    judgeMaxTokens: 384,
    // 判定专用思考控制（三态；旧名保留，值域扩展）：
    //   true / 'off'                ⇒ 关思考（仅受支持端点下发，见 llm.js thinkingFields 的 off 分支）
    //   'on'                        ⇒ **显式开启**（真正下发 enable 字段 + 一个 >0 的思考预算）
    //   false / null / 缺失 / 其它  ⇒ 跟随全局（api.disableThinking / api.thinkingBudget）
    //   旧复选框写下的 false 语义 = 跟随，保持不变。
    judgeDisableThinking: null,
    // 每条消息「前置门控」的总时间预算：到点就用手上判完的结果，没判完的当弃权
    gateBudgetMs: 1500,
    // ensure（拉起/等待本地模型就绪）的时间预算（2026-09-29 A 方案）：到点立即返回
    // not-ready，后台 promise 继续拉起（不清 starting、不杀进程，后续调用自然 join）。
    // 一个旋钮、四个判定站点共用（不属于 replyChance 一个角色）。读取时实时取并
    // clamp（300–8000，硬顶防误填把无界 await 请回来）；本轮不进设置页 UI。
    ensureBudgetMs: 2000,
    // 云端 Jev 通道：本地判不出来（弃权/失败）时，把这一题升级给云端小模型再判一次。
    // 真 Jev 的价值就在「有真概率」，所以云端通道默认关，开了也只接本地弃权的那部分。
    cloud: {
      enabled: false,
      baseUrl: '',            // OpenAI 兼容端点（不含 /chat/completions）
      apiKey: '',
      model: '',              // 例如 javis / gpt-4.1-nano / qwen-flash …
      timeoutMs: 6000,
      // 只在本地弃权、且本地标签概率低于这个值时升级（高于它说明本地只是差一点，不必花钱）
      upgradeBelow: 0.6,
      // 云端也必须过阈值；云端概率是真概率，通常可以比本地低一档
      minConfidence: 0.6,
      // ⚠️ 2026-09-22 新增：端点**不给 logprobs** 时的兜底采信概率。
      //   官方端点和不少中转不带概率，以前一律弃权 → 云端通道等于没用（用户报的"单独用云端不通"）。
      //   设成 0（默认）保持旧行为；设成 0.7 之类，则"答案命中标签"就按这个固定概率采信。
      //   代价：失去弃权能力（模型瞎猜时也会被当成结论），所以默认关，需要自己开。
      assumeP: 0,
      // 只让云端接管这几个角色（留空 = 全部角色都能升级到云端）。
      //   本地关掉后每一次窄域判定都会变成一次网络请求，建议收窄到真正需要的几个。
      roles: [],
      // 成本记账用（元 / 百万 token），只用于统计展示，不参与任何决策
      priceInPerM: 0,
      priceOutPerM: 0,
      maxPerMinute: 60        // 每分钟最多问几次，防手滑把云端判成烧钱机器
    },
    // 备用模型：2B 实验已下线。保留空结构兼容旧配置；modelPath 为空就不会起第二台。
    secondary: {
      enabled: false,
      modelPath: '',
      modelId: '',
      port: 18081,
      ctxSize: 4096,
      gpuLayers: 0,
      roles: []
    },
    // ── 视觉实例：同一个 0.8B + mmproj 投影文件，让包内 llama-server 能看图 ──
    // 用途：离线批量任务（目前只有「表情包备注」）。按需拉起、用完就关 ——
    //       CPU 上编码一张图约 1~3 秒，批量可接受，换来的是不烧云端 vision。
    // 注意：这只服务「看图写备注」这类离线活；实时回复链路不碰它。
    vision: {
      enabled: true,
      mmprojPath: 'models/mmproj-Qwen3.5-0.8B-BF16.gguf',
      // 与主实例一样按实例号错开（复制目录再开第二个号时不再撞 18085）
      port: 18085 + Math.max(0, PROFILE_INDEX - 1) * 10,
      ctxSize: 4096,
      gpuLayers: 0,
      maxTokens: 64
    },
    // 「概率响应」的新归属：档位 3（随机档）原本靠 Math.random 掷骰子决定回不回，
    // 现在改成让 Jev 读一眼这批消息再决定（可以插嘴/接话/不回），骰子只当兜底。
    //
    // minConfidence/minMargin 是判定基准值；cooldownMs/maxPerHour 是显式频率限制。
    // Jev 模式下活跃度和接话意愿只调判定门槛，不覆盖频率限制。
    replyChance: {
      // 档位 3（随机档）的「要不要响应」由谁判。两条路**互斥**，不再串联：
      // 'jev'         = 骰子退场。这批消息直接交给本地 Jev 读一眼，判「值不值得接一句」。
      //                 响应概率在新语义下 = 「插话意愿」：调 Jev 判定门槛；
      //                 灰区和软 NO 另按该意愿抽样。频率由下面的显式设置决定。
      // 'probability' = 保留纯骰子、不看内容。命中的那次插话同样要过下面的冷却/配额。
      // ★ 2026-10-17（用户裁定：逐群可切换云裁判/随机）：`mode` **不再是模式开关** ——
      //   真键是 `store.replyMode`（perChat[chatKey] > global，读点见 orchestrator 的 resolveReplyMode）；
      //   本键只在新键**未显式配置**时做有界兼容（新键显式值永远优先，旧值不能偷盖）。
      mode: 'jev',
      enabled: true,
      // 这两条是「该不该插话」专用的，比全局那对更严：判 YES 是要真发话的。
      // minConfidence 是基准值：实际门槛还会受插话意愿与群活跃度影响。
      minConfidence: 0.6,
      minMargin: 1.0,
      // 同会话两次「自由插话」之间的最小间隔（毫秒）：再想插也不能连着插。
      // ★ 2026-10-17（频率链复核）：本键**只作用于旧/随机自由插话路径**
      //   （旧 judgeMode=false 或 store.replyMode=random）；云裁判（jev）的自由入场是
      //   概率候选 → 裁判 → 主模型，**不消费**它 —— 控件/文案不要声称"全链生效"。
      //   0 = 关闭冷却（仅随机路径）。
      cooldownMs: 5000,
      // 每小时最多自由插话几次。**0 = 一律不插（不是不限）**；同样只在旧/随机路径消费
      //   （plan/index.js 的旧自由插话分支：recentSends >= maxPerHour ⇒ HARD_HOURLY_CAP）。
      maxPerHour: 100,
      // ── 不花钱的调优三件套（2026-09-21）──
      // prefilter：模型之前先过规则。「@某人/回复某条 且几乎没别的内容」「纯符号/表情」
      //   这两类在 9-19 的 2154 条真实决策点里是最大的错误源（@+没内容 → 接话率 69% vs 基线 92%），
      //   机器就能判定，不值得花一次推理。只往「不插嘴」方向短路，永远不会因为预过滤多说话。
      prefilter: true,
      // cloudVerify：本地判 YES 之后，云端再用同一道题复核一遍，双 YES 才真插嘴。
      //   现任老师（flash）bench 36/38，远高于 0.8B —— 让它当「二审」比换老师便宜得多。
      //   只在 cloud.enabled=true 时生效；云端挂了/超时按本地结果放行（不让复核卡死主链路）。
      cloudVerify: true,
      // doubleAsk：本地同题问两遍，两遍都 YES 才插嘴（不一致视为弃权）。
      //   热态 ~100ms/问，买一份自一致性。默认关：开了 cloudVerify 后通常用不着。
      doubleAsk: false,
      // ── 按群活跃度自适应 ──
      // 每天群里热度不一样：正刷屏时它频繁接话显得抢戏，只剩一两人说话时它又缩着不动。
      // 用最近 windowMinutes 分钟的群消息算 heat∈[0,1]（见 local-jev.js
      // computeGroupHeat）。Jev 模式只插值判定门槛；纯概率模式仍使用四项自适应参数。
      // 整块可关：adaptive.enabled=false 回到上面的基准值。
      //
      // ⚠️ 2026-09-21 收紧冷清端：原来 quiet = {0.55 / 0.9 / 75s / 每小时 10 次}，
      //   等于"群里没人说话时它每 75 秒就能接一句、一小时二十句"，实测把冷清群变成它的独角戏：
      //   群 100000001 近 12 小时群友只发了 9 条，机器人自己发了 20 条（占全群 69%）。
      //   现在只比热闹端**略**愿意一点（0.72 < 0.88、180s < 300s、6 > 3），不再放飞。
      adaptive: {
        enabled: true,
        windowMinutes: 15,    // 用最近多久的群消息算热度
        // ⚠️ 2026-09-22：3 条/分太容易达到 —— 普通"有几个人在聊"的群 perMin 就能到 2~3，
        //   rateScore≈0.7~1.0 → heat 长期贴着热闹端 → 用户把接话意愿调到 90% 也被这层压住
        //   （表现为"设 90 回应率还是很低"）。放宽到 5 条/分，让普通群落在中间段。
        fullRate: 5,          // 达到这个「条/分钟」就算非常热闹（rateScore 记满）
        fullSpeakers: 5,      // 达到这个发言人数量就算非常热闹（speakerScore 记满）
        // 冷清端：群基本静默 / 只有一两个人在说 → 门槛略降、冷却略短
        quiet: { minConfidence: 0.72, minMargin: 1.8, cooldownMs: 180000, maxPerHour: 6 },
        // 热闹端：群里刷屏 → 门槛抬高、冷却拉长、每小时上限压死（这一端才是"别抢戏"的主力）
        busy: { minConfidence: 0.88, minMargin: 2.6, cooldownMs: 300000, maxPerHour: 3 }
      }
    },
    // ── 连发合并（自适应防抖）交给本地 Jev 判 ──
    // 原来纯靠计时：一串话静默 burstSettleMs 就开跑。计时器看不出「这句说完了没有」。
    // 实测（test/burst-dataset.mjs 抽 448 个真实决策点，再用 test/jev-burst-lab.mjs 跑两批）：
    //   · 串内「总是等」只有 40%/47% 的时候是对的 —— 一半以上的等待是白等；
    //   · 小模型**确实**有信号但不是万能：它判「说完了」且概率 ≥0.8 时，
    //     两批合起来 25 次里 22 次真的是说完了（88%）；
    //     概率放到 ≥0.7 就掉到 75%（79 次里 59 次），更激进就别用了。
//   · 「还在说 → 把等待拉长」这条路**实测不比瞎猜强**（命中 17%~32%，而"不拉长"本身
//     就有 16%~46% 的底），所以只做缩短，不做延长。
//   ★ 2026-10-08（说真话整改）：原文这里写着「见 orchestrator#refineBurstDelay」——
//     **那个函数在新树不存在**（全树 `grep refineBurstDelay` 只命中 defaults.js 本行与 apps/ui/app.js 的说明文字，
//     `modules/**` 零命中）。老树那条"问小模型说完没有"的自适应链路**没有搬过来** ⇒ 下面 `burstJudge` 整组仍**无读点**。
//     （⚠ 2026-10-16 更正：**`burstAdaptive` 不是死键**，它已接线，见上一段的真值说明——两者是不同的东西。）
//     「打开后…」那段（下一段）描述的是**老树**的行为，新树不会发生。
//     打开后（**老树口径存档，新树不实现**）：连发时（本来要干等 settle 那一下）先问一句「他这句说完了没」，
//       说完了且够自信 → 等待缩回 wakeDelayMs（老树口径；新树的 wakeDelayMs 是**真键**，见上一段的真值说明）。
// 默认关 = 老行为。本地模型没启用/起不来/判不出来/超时 → 完全退回纯计时。
// ⚠️ 判「说完了」而对方其实还有下句 = 抢话 + 多跑一次运行，所以这两个阈值故意偏保守。
// ★ 新树实况：`orchestrator/index.js:827 scheduleFlush()` 只有一行 `delay = burstMs`
//   （`burstMs` = `burstSettleMs`），再用 `burstMaxWaitMs` 封顶 —— 没有"首条短窗口"、没有按人自适应、没有问 Jev。
    burstJudge: {
      enabled: false,
      // 越大越保守。0.8/1.0 = 实测 88% 准（两批合计 25 次里 3 次抢话）；
      // 0.7/0.8 = 75% 准但覆盖翻三倍。想更省事就往下调，想更稳就往上调。
      minConfidence: 0.8,
      minMargin: 1.0,
      timeoutMs: 2000        // 判不出来就退回计时，绝不拖主链路
    },
    // 默认启用的 Jev 角色。⚠️ 这是**唯一权威来源**：local-jev.js 的
    // DEFAULT_JEV_ROLES 引用这里，别再各自维护一份清单（之前两份不一致，
    // stickerPickGate/replyChanceGate 就这么漏掉过）。
    // 新增角色时改这里即可 —— migrateLocalJev 会把它补进老配置的 roles。
    roles: [
      // ⚠️ 2026-09-22：textOnlyJudge / unsentLinesJudge **都不进默认表**了。
      //   它们判的是同一类问题 ——「这段写在正文里的话，到底该不该发到群里」——
      //   而这是道**语义理解题**，不是窄域标签题，0.8B 干不了。
      //   · 09-21 只从默认表删了 unsentLinesJudge（理由见下），textOnlyJudge 留着；
      //   · 09-22 用 15 条真实存档样本做 A/B：本地 0.8B 判错 7 条（6 条旁白被放行 →
      //     会原样发进群，另 3 条该发的弃权），同一批云端裁判 0 错。
      //     实测漏出的旁白长这样：「先正经回阿澈的UI问题（他是管理员+死党），顺手损一句
      //     群里那个"扩展包"」「他刚醒，回了"醒了""你这鱼"，正好接上昨晚的夜猫子梗。」
      //     —— 这两条连 orchestrator 的 20 条旁白正则都拦不住。
      //   · 反向也错：模型写好的「草 这配置」「这张猫好欠，牙还漏出来了」被判 skip 丢掉，
      //     群里表现就是"叫他他不理"（号A 存档里 163 次 localJev 判 skip，正则只拦下 2 条）。
      //   · 去掉后两条兜底路径都自动回退云端裁判（salvage.js，提示词里有 7 条明确规则+示例）。
      //   · 角色仍留在 catalog 里，想开可以去设置页勾 —— 但正文裁判另受
      //     api.textOnlyJudgeLocal 管辖（默认 false，见上面那段注释）。
      // unsentLinesJudge 的原始理由（2026-09-21）：它和 textOnlyJudge 判的是同一件事，
      //   而 textOnlyJudgeLocal 早就因为"本地小模型裁判不准"默认关掉了 —— 这条却还在用
      //   0.8B 逐行判。实测代价（22:20 前后）：模型写好的「草 这猫的表情跟我看抽卡结果时
      //   一模一样」「dsh是谁 我不认识 别乱点兵」被判 NO 丢掉。
      'replyChanceGate',
      'topicContinuityGate',
      'memoryRecallGate',
      'imageCueGate',
      'imageWantsGate',
      'stickerAskGate',
      'emotionGate',
      'cueVerifyGate',
      'stickerPickGate',
      'impressionTypeGate',
      'impressionDupeGate',
      'memeGate',
      // 认图前置闸：自动附图前先判「这张图跟当前话题关系大不大」（2026-09-21 管理员要求）。
      // 不相关就不把图挂给主模型，免得它以为表情包在说自己、把话题扯到认图上。
      'imageRelevanceGate',
      // 语义卡准入：抽出来的卡入库前问一次「值不值得长期记」（后台巩固里跑，零延迟成本）。
      'cardGate',
      'memeSaveGate',
      'wikiGate',
      // 生活账本的主语判定（"我更饿了" vs "你饿不饿"）。低风险：判错只是多记/少记一条近况。
      'selfStateGate'
      // ⚠️ 2026-09-21 实测后**不进默认表**：impressionPickGate（"落榜的那条印象跟现在这句话
      //   有关吗"）在 30 条真数据上只有 20/30，且错的方向是过度 YES（把"音乐口味""高达模型"
      //   判成跟"今天好累""睡了明天见"有关）。字面重合那部分已由 memory.js 的
      //   rankImpressions + topicOverlap 免费做掉（"推歌"那条就是这么捞回来的），
      //   语义那一档要开自己去勾 —— 角色仍留在 catalog 里可手动启用。
    ],
    // ── 后置好感度判定（jevFavorJudge）──
    // 机器人回复发出后，用本地 Jev 回看「用户说了什么 + 我回了什么」，
    // 判定这轮对话对好感度的影响（favorDelta ∈ [-10, +10]）。
    // 替代原 finish 工具（已移除）：finish 在生成时判，但模型看不到自己将说什么；
    // 后置判定能看到完整上下文，且不占用户付费的云端轮次。
    favorJudge: {
      enabled: true,
      timeoutMs: 8000  // 后置结算可以比实时判定稍宽松，但仍需防止积压
    }
  },
  // ── ★ N36 追加（2026-10-09 · qwen2）：向量嵌入运行时（M6 记忆语义召回）──
  //
  // 【为什么是"新增"而不是"搬运"】老树 `src/config.js` **没有 vector 这一块**（grep 零命中）
  //   ⇒ 无老树口径可照。键名不自己发明，按**既有消费者的必填参数名**定：
  //     · `core/vector/llama-embedder.js` `createLlamaEmbeddingRuntime({modelPath, executablePath,
  //       logPath, port, …})` —— 这四个是它仅有的必填显式入参（缺任一当场 throw TypeError）；
  //     · `apps/server/assembly.js` 按 `vector.{enabled,modelPath,executablePath,runtime,logPath,port}` 读取：
  //       `enabled` 控制显式启动，`runtime` 决定用 CPU/CUDA 哪支 profile，`port` 被占时会在 [port, port+20] 回落。
  //
  // 【默认值口径】一律**仓库根相对路径**（照本文件 localJev.modelPath / localJev.exePath 的既有写法），
  //   **不写死本机绝对路径**（`D:\...`）。四个值都实测存在：
  //     · `models/new true/bge-base-zh-v1.5-q8_0.gguf`（110,001,568 B，sha256 = 893a0f07…4be7，
  //       与 `core/vector/profile.js` BGE_ZH_LOCAL_PROFILE.modelSha256 逐字相符）
  //     · `runtime/llama/llama-server.exe`（**随包 CPU 运行环境**，build 10685）
  //   ★ 2026-10-17（发行版基线 = 无 GPU 的普通 Windows，用户令"向量默认开"）：
  //     · `enabled` 由 false 改 **true**：这是随包功能，出厂即应可用；服务起不来时
  //       assembly 会**显式降级关键词召回**并把原因写进状态与日志（不假装成功）。
  //     · 默认 exe 由 `runtime/llama-cuda` 改 `runtime/llama`（CPU）：CUDA 版在无 N 卡机器上
  //       会因缺 CUDA 运行时而起不来/崩，而 profile 的 build 对账也要求"profile 与真机二进制同支"。
  //       GPU 机器想用 CUDA：把 `vector.runtime` 设为 `cuda`（或直接把 executablePath 指到
  //       `runtime/llama-cuda/llama-server.exe`），assembly 会换成 CUDA 档 profile。
  //     · 端口被占时 assembly 会**依次往后找空闲口**（只对本次进程生效，不改配置），
  //       避免双号/残留进程抢同一个 18081。
  //   ⇒ 用户要换机器/换盘，只改这几个路径/端口，不动代码。
  //
  // 【★ modelSha256 为什么刻意不做成配置键】它是**随制品冻结的代码常量**，不是用户旋钮：
  //   `BGE_ZH_LOCAL_PROFILE`（profile.js）已带 64-hex，`isProfileVerified()` 回 true，
  //   adapter 会拿它与真机算出的 sha 对账（不符 ⇒ `version-incompatible`，llama-embedder.js:105）。
  //   做成键只会让用户能把它改错、把"模型换过了"这件事静默过去 ⇒ **不做**。
  //   ⇒ 接法：**profile 由装配层按运行环境选**（CPU 档 `BGE_ZH_LOCAL_PROFILE` /
  //     CUDA 档 `BGE_ZH_LOCAL_CUDA_PROFILE`，见 apps/server/assembly.js），配置只提供
  //     "去哪找模型/可执行文件/日志/端口"这些环境量。
  //
  // 【logPath 口径】★ 2026-10-17 逐号隔离：带 `PROFILE_ID` 时落到 `data-<n>/logs/`，
  //   不带（号 A）仍是 `data/logs/`。此前两个号都写 `data/logs/vector-embedding.log`，
  //   号 B 的启动/停止/失败痕迹会混进号 A 的日志里，排障时分不清是哪个实例。
  //   相对路径按安装目录解析，不跟随 `QQ_AGENT_DATA_DIR`；
  //   runtime 会 `mkdir(dirname(resolve(logPath)))`（llama-embedder.js）⇒ 父目录不存在也不会炸。
  vector: {
    // 出厂默认开（用户令 2026-10-17）；关掉 = 只走关键词召回并在状态里如实标 disabled。
    enabled: true,
    // 路径里有空格（`new true`）是安全的：`--model` 走 spawn 的**参数数组**（llama-embedder.js），不经 shell。
    modelPath: 'models/new true/bge-base-zh-v1.5-q8_0.gguf',
    // 'auto' | 'cpu' | 'cuda'：auto = 有 cuda 档就用 cuda，否则 CPU（读点在 apps/server/assembly.js）。
    runtime: 'auto',
    executablePath: 'runtime/llama/llama-server.exe',
    logPath: `data${PROFILE_ID ? `-${PROFILE_ID}` : ''}/logs/vector-embedding.log`,
    // 与 `configuredPorts()` 的口径一致（embedding = decision + 1，profile.js:86-95），
    // 也与 createLlamaEmbeddingRuntime 自己的默认 18081（llama-embedder.js）一致；
    // 避开 18080（localJev decision）与 18085（localJev vision）。
    // ⚠ 占用了不致命：assembly 会在 [port, port+20] 里找第一个空闲口（见该文件的端口回落注释）。
    port: 18081 + Math.max(0, PROFILE_INDEX - 1) * 10
  },
  // ── 内存定期释放（memory-guard，src/memory-guard.js）──
  // 背景：llama-server 的 PID 只在内存里，核心一重启就失联但进程还在（历史事故见
  // instance-lock.js 头注）；且 llama-server 没有"重置"接口，释放内存 = 重启进程。
  // 这里做三件事：游离进程回收、空闲窗口重启、采样观测（问题在用户机上，必须让
  // 采样自己说话）。量化降级方案已被用户否决，这里不含任何模型/量化改动。
  memoryGuard: {
    enabled: true,
    tickMs: 60000,             // 守卫 tick 周期（也是注册表心跳间隔；staleBeatMs 应 ≥ 2×tick）
    // 游离 llama-server 回收。只杀两类：在册但心跳过期的、监听着本 profile
    // 独占端口的遗留孤儿。兄弟实例（号B 共享主号模型）与用户自己的 llama.cpp 不命中。
    orphanCleanup: true,
    staleBeatMs: 150000,       // 注册表心跳过期阈值（150s = 2.5×tick，容忍一次丢拍）
    restart: {
      // 空闲窗口重启 primary：CPU 冷启动会让重启后头几问踩超时、加重 Jev 弃权，
      // 所以必须「在途 0 + 静默满 idleMs」才动手；三个触发器命中任一即可。
      enabled: true,
      idleMs: 180000,          // 静默窗：最近 3 分钟没有本地判定才允许重启
      maxRequests: 4000,       // 累计判定次数触发（0=不按请求数）
      maxUptimeMs: 86400000,   // llama-server 进程运行时长触发（0=不按时长）
      maxWorkingSetMb: 0,      // 工作集阈值触发（0=关；默认关，等采样证实堆积后再开）
      minGapMs: 3600000        // 两次重启最小间隔，防触发器互相接力把进程反复重启
    },
    sampleEvery: 10,           // 每 N 个 tick 采一条内存观测（60s tick → 10 分钟一条）
    samplesMax: 512,           // 观测落盘上限（条），超出丢最旧
    // 台账裁剪（文件级，对齐 jev-observer 的 14 天口径）：
    // data/cache-keepalive.ndjson、data/usage-ledger.ndjson、data/memory/audit.jsonl
    ledger: {
      enabled: true,
      maxAgeDays: 14,
      maxBytes: 67108864       // 单文件 64MB 软顶，超出从尾部保留一半
    }
  },
  // 联网搜索（默认 Wikipedia MediaWiki；可选 Bing/DeepSeek/智谱/博查/百度/秘塔）
  webSearch: {
    enabled: true,
    searchUrl: 'https://cn.bing.com/search',
    // 搜图入口（search_images 工具 → 拿到能直接发的图片直链）
    imageSearchUrl: 'https://cn.bing.com/images/search',       // Bing 图搜（兜底）
    imageSearchUrlBaidu: 'https://image.baidu.com/search/acjson', // 百度图搜（默认主用：返回 JSON、中文相关度好）
    maxResults: 6,
    // web_fetch 每次返回的正文上限（字符）。中文 1 字符 ≈ 1 token，抓一页 2 万字
    // 就是一次 ¥0.01+ 的输入，比一次正常运行还贵——所以默认压到 8000。
    fetchMaxChars: 8000,
    // 外部知识源（MediaWiki）。模型用 external_lookup 查；实时新闻仍走 web_search。
    // sources 行格式：id | 显示名 | https://根地址
    wiki: {
      enabled: true,
      default: '',
      wikiSearchSource: '',
      sources: []
    },
    // 可选：'native' | 'bing' | 'deepseek' | 'zhipu' | 'bocha' | 'baidu' | 'metaso'
    // native = 用当前聊天模型的 enable_search（Qwen/DashScope 等），失败自动退回 Bing
    provider: 'native',
    // native 搜索：用聊天模型 enable_search；model 留空跟聊天模型，可填更轻的
    native: {
      model: '',
      timeoutMs: 18000,
      maxTokens: 350,
      // 百炼只认 standard/pro_ultra/pro/lite/pro_max/turbo/max（'fast' 会 400）
      strategy: 'standard'
    },
    deepseek: {
      apiKey: '',                     // 留空时回退环境变量 DEEPSEEK_API_KEY
      baseUrl: 'https://api.deepseek.com/responses',
      model: 'deepseek-v4-flash',     // Responses API 模型名：deepseek-v4-flash / deepseek-v4-pro
      timeoutMs: 60000
    },
    zhipu: {
      apiKey: '',                     // 留空时回退环境变量 ZHIPU_API_KEY
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/web_search',
      engine: 'search_std',           // search_std(¥0.01) | search_pro(¥0.03) | search_pro_sogou | search_pro_quark
      count: 10,
      timeoutMs: 20000
    },
    bocha: {
      apiKey: '',                     // 留空时回退环境变量 BOCHA_API_KEY
      baseUrl: 'https://api.bochaai.com/v1/web-search',
      count: 10,
      timeoutMs: 20000
    },
    baidu: {
      apiKey: '',                     // 留空时回退环境变量 BAIDU_SEARCH_API_KEY
      baseUrl: 'https://qianfan.baidubce.com/v2/ai_search/web_search',
      count: 6,
      timeoutMs: 20000
    },
    metaso: {
      apiKey: '',                     // 留空时回退环境变量 METASO_API_KEY（无 key 也尝试官方免费额度）
      baseUrl: 'https://metaso.cn/api/open/v1/search',
      count: 6,
      timeoutMs: 20000
    },
    // 自定义搜索提供商列表（设置页可像添加模型提供商一样自行添加，可多个）。
    // 每项：{ id, name, type, baseUrl, apiKey, model, count, timeoutMs }
    // type: 'openai' = POST JSON 搜索接口；'bing' = GET 页面并按 b_algo 解析
    // 在「搜索提供方」下拉框里以 custom:<id> 的形式出现
    providers: [],
    // 自定义搜索服务（旧的单槽位，保留以兼容；新添加的建议用上面的 providers 数组）
    custom: {
      name: '',                       // 展示名，如"我的 SearXNG"
      type: 'openai',                 // 'openai' = OpenAI 风格的 JSON 搜索 API；'bing' = 抓 HTML 解析 b_algo
      baseUrl: '',                    // openai: 搜索端点；bing: 搜索页地址
      apiKey: '',                     // openai 类型需要（可选，视服务而定）
      model: '',                      // openai 类型可选： Responses API 风格的模型名
      count: 6,
      timeoutMs: 20000
    },
    // 免费 API 页：每天凌晨 4 点抓一次「免费额度 / 限时免费 / 即将开放」情报
    apiNews: {
      enabled: true,
      // 抓取源（留空 = 用内置：yangmao.ai / AI Pulse / linux.do）
      // 每项：{ id, name, type, url }；type: yangmao | xphub | discourse | rss
      sources: [],
      // 额外 RSS（默认空；综合资讯源会带进大量开源项目，按需再加）
      feeds: []
    },
    // B 站：只允许从指定收藏夹转发（AI 专用池）
    bilibiliCookie: '',
    // 收藏夹显示名：list_bili_fav 只认这个夹；空 = 不限制
    biliFavFolderName: '小鲸鱼专用',
    // 可选：固定 mediaId（数字）。留空则按名字在收藏夹列表里搜
    biliFavMediaId: ''
  },
  // 安全例外（默认全部关闭）
  security: {
    allowPrivateImageHosts: false,          // true 时图片下载允许内网地址（仅本地测试/自建图床）
    allowPrivateFetchHosts: false,          // true 时 web_fetch / 站内搜索允许内网地址（自建站点用，风险自负）
    // 从网页下载图片再发到群里的开关（send_image 工具）
    imageSend: {
      enabled: true,                        // 总开关
      requirePreview: true,                 // true = 必须先"看一眼"（preview）才能发；关掉可省一轮调用
      maxPerRun: 2,                         // 一次运行最多发几张（防刷屏）
      maxPreviewsPerRun: 3,                 // 一次运行最多预览几张（视觉 token 也不便宜）
      maxBytesMB: 5,                        // 单张大小上限（QQ 侧太大容易被拒）
      // 锁定站点里的图视为可信来源，不再要求先"看一眼"（省一轮视觉 token）
      skipPreviewForLockedHosts: true
    },
    // 浏览锁定：把机器人的"上网范围"限制在指定站点内。
    // 生效后 web_fetch（抓网页）、send_image（下网图）、web_search（过滤站外结果）都只认这些域名；
    // 表情包和群聊图片（QQ 自己的图源）不受影响。
    browseLock: {
      enabled: false,
      domains: [],                          // 例：['zh.wikipedia.org', 'bilibili.com']（不带协议、可含子域）
      includeSubdomains: true,              // true = 连带 *.域名 一起放行
      // 站内搜索地址模板（含 {query} 占位符）。填了之后 web_search 直接抓这个地址，
      // 而不是去全网搜完再过滤。例：
      //   https://zh.wikipedia.org/w/index.php?search={query}
      //   https://www.someacg.top/search?keyword={query}
      // 留空则退回"给关键词自动加 site: 限定"。
      searchUrl: ''
    },
  },
  // SnowLuma / OneBot v11
  snowluma: {
    dir: '',                   // SnowLuma 程序目录；留空 = 自动探测项目内 ./snowluma
    autoLaunch: false,         // 应用启动时自动拉起 SnowLuma（未运行时）
    // ⚠️ 2026-09-22：默认地址按实例号错开（3001/3000 → 3011/3010 …）。
    //   以前写死 3001/3000，于是"复制一份目录开第二个号"会静默连上**第一个实例的**
    //   SnowLuma：两个机器人绑同一个 QQ 号，同一条消息被回两遍，而且不给任何告警。
    wsUrl: `ws://127.0.0.1:${3001 + Math.max(0, PROFILE_INDEX - 1) * 10}`,
    httpUrl: `http://127.0.0.1:${3000 + Math.max(0, PROFILE_INDEX - 1) * 10}`,
    accessToken: '',           // WebSocket 令牌
    httpAccessToken: '',       // HTTP API 令牌（SnowLuma 可与 WS 不同；留空沿用 accessToken）
    // ── 账号白名单：只允许这些 QQ 号挂在本机 SnowLuma 上 ──
    // 背景：SnowLuma 的"自动注入"（hookAutoLoad / SNOWLUMA_HOOK_AUTOLOAD）是
    // "发现一个 QQ 进程就注入一个"，很容易把管理员自己的号也挂上桥。
    // 填上允许的机器人号，程序会定时检查，发现白名单外的号就报警（默认并自动卸载）。
    // 留空 = 不检查（保持老行为）。
    accountWhitelist: [],
    autoUnhookStrangers: true, // true = 自动卸载白名单外的号；false = 只报警不动手
    webuiPassword: ''          // SnowLuma 网页密码（自动卸载要用它的 API；留空则只报警）
  },
  // ── 亢奋模式 ──
  // ★ 2026-10-17（发行版口径：默认关，入口收进开发者模式 —— UI 侧归 qwen1）：
  //   `enabled` 默认 false，**只能手动切**。新树里这是**真键**：`emotion/hype-mode.js:37`
  //   （isHypeMode → 目标净化/工具收窄）真读它，切换动作在装配层 console-api。
  // 切过去后：模型/协议/人设卡一并换掉，情绪全部拉满，
  // 行为约束（说话风格、沉默规则、嘴软原则…）全部放开 —— 只有工具调用协议还照常生效。
  hypeMode: {
    enabled: false,
    model: '',                // 亢奋模式用的模型；空 = 跟随当前聊天模型
    restoreModel: '',         // 关亢奋后切回的模型；空 = 不切
    systemMode: 'hype',
    roleText: '',
    minMessages: 5,
    // 受保护 QQ（骂人/拍一拍硬锁）；发行版默认空 = 不锁
    protectedQQ: '',
    avatarOn: '',
    avatarOff: '',
    // ── 情绪自动触发（2026-10-03 用户口径：两级路由）──
    // ⚠ 2026-10-17 实况更正（说真话）：那套"两级路由"在**新树没有实现** ——
    //   `src/emotion-route.js`（老树）没有搬过来，新树也没有任何写 `hypeMode.stats.reason='emotion(…)'`
    //   的地方，`emotion/hype-mode.js:hypeAutoExitDue()` 因此恒返回 `manual(…)`。
    //   ⇒ 下面两个键当前**只有面板/状态读点**（`apps/server/console-api.js` 读 emotionThreshold），
    //     没有自动进入方。留档不删（与 api.nudgeTextOnly 同处置：台账标 dead、面板锁成死键）；
    //     它们**不是**本发行版"默认关自动触发"的开关 —— 真正的开关是上面的 `enabled`。
    emotionThreshold: 70,
    emotionAutoExitMin: 5,
    stats: null,              // { enteredAt, reason } —— 自动退靠它判"是不是情绪触发的"
    saved: null
  },
  // ── 第二人格（双人格）──
  // 与亢奋的区别：这个是**情绪自动触发**的（也能手点）。触发时只换三样东西 ——
  // 系统协议（soft2）、人设卡、QQ 头像；**不动模型、不动工具、不动限频、不动思考开关**。
  // 自动触发在 orchestrator 每轮组装提示词之前判定，见 src/persona-two.js。
  persona2: {
    enabled: false,
    // ⚠️ **本号总开关，默认关**（2026-10-03 事故：src/config.js 是两个号共用的默认值，
    //   我把"随机顶上"的默认值开成 true，结果号B 也被绑上了 —— 实测号B 被
    //   `random(timer)` 顶上过，生效卡都被换成第二人格卡）。
    //   所以这套人格系统必须**逐个号显式opt-in**：号A 的 config.json 里写 true 才生效；
    //   没写的号（含以后新建的档）一律不参与 —— 情绪不自动切、随机不顶上、亢奋情绪触发也不走。
    featureEnabled: false,
    // 第二人格用的协议档：buildSystemPrompt 里 'soft2' → buildPersonaTwoProtocol()
    systemMode: 'soft2',
    roleText: PERSONA2_CARD,   // 第二人设卡；改卡改这里（或 src/persona2-card.js 的默认值）
    adminQQ: '',               // 管理员 QQ（卡里写死的那个）；空 = 回落到 hypeMode.protectedQQ
    trigger: {
      // ★ 2026-10-17（发行版口径：第二人格默认关，含**自动触发**）：本键默认 false =
      //   情绪阈值这一路自动顶上整个关掉；要重新打开去开发者模式勾回来（UI 侧 qwen1 负责）。
      //   与 featureEnabled 的分工：featureEnabled = 本号是否启用这套人格；本键 = 允不允许它
      //   **自己**顶上来。两者都 false 时，唯一入口是面板/模型显式切换。
      enabled: false,          // false = 只手动切，不再自动顶上来
      // 负向情绪和（anger+irk+anxiety+sadness+shame+loneliness+down+boredom）> 这个值 → 她顶上来。
      // 2026-10-03 用户口径：**40 切人，70 进亢奋**（两级路由见 src/emotion-route.js）。
      // （computeIntent() 里那条 soft≥45 是"措辞倾向"的意图串，跟模式切换无关，故意不跟着改。）
      threshold: 40,
      recoverThreshold: 25,    // 滞回：降到这个值以下才算「她缓过来了」（只在 recoverExitEnabled 打开时有意义）
      // 情绪缓过来时自动退回：**默认关**。
      // 卡里写的是"你什么时候退回去：只有你自己能决定" —— 所以兜底一律不替她做决定
      // （2026-10-03 用户明确要求：退回只留 switch_back）。
      recoverExitEnabled: false,
      minDwellMin: 5,          // 最短驻留（分钟）：刚上来不许马上退（只挡情绪那条）
      cooldownMin: 20,         // 两次自动切换之间的最小间隔（分钟）
      // ── 随机顶上（独立心跳，不依赖"主动开话题"那套开关）──
      // 用户口径（2026-10-03）：平时也要偶尔突然切出来；**发言后刷新**——自己刚说过话就不冒；
      // 目标"第一人格占 75% 的时间"（靠占用率闸门实现，见 personaTwoOccupancy）；
      // 群和私聊都要冒（私聊仍过 allow.private 白名单，防给陌生人发消息）。
      random: {
        // ★ 2026-10-17（同上的发行版口径）：随机顶上**默认关**。它是一条独立心跳，
        //   不看任何消息就能自己切人 —— 出厂包不该在用户没要求时发生人格切换。
        enabled: false,        // 总开关
        intervalMinMin: 20,    // 两次"掷骰子"之间的最小间隔（分钟）
        intervalMaxMin: 40,    // 最大间隔；到点先排下一次，再判闸门
        chancePerCheck: 0.5,   // 到点也只有一半概率真的冒（"切换不要太频繁"）
        afterSpeakMin: 3,      // 发言后刷新：自己在这个会话最后一次发言距今 < 3 分钟 → 不冒
        occupancyWindowH: 6,   // 占用率统计窗口（小时）
        occupancyMax: 0.25     // 她在这个窗口里的在位时间占比上限 = 保证第一人格 ≥75% 的时间
      }
    },
    // 在位时间段台账 [[start,end],…]（end=null 表示正在位）。占用率闸门靠它算，
    // 只保留 occupancyWindowH 窗口内的（写盘量很小）。
    onSpans: [],
    // 兜底：**0 = 不限**。默认全关 → 她只会因为自己调 switch_back 而退回去。
    // 想恢复"防止永久卡住"的自动兜底，把数字调回去即可（6 / 30），不用改代码。
    maxTurns: 0,               // 超时兜底：最多撑几轮（0 = 不限）
    maxMinutes: 0,             // 超时兜底：最多撑多久（0 = 不限）
    // ★ 回程骰子（2026-10-12 用户裁定：两向都掷）：模型调 switch_back 时先掷，roll < 这个值才真退。
    //   0.5 = 一半概率真退；1 = 必成（=不掷）；缺键也 = 不掷（自测替身零随机的依据）。
    switchBackChance: 0.5,
    // ★ 进入骰子（2026-10-13 用户口径：触发者=LLM）：模型调 switch_in 时先掷，roll < 这个值才挂起进入。
    //   语义与 switchBackChance 完全对称（0.5/1=必成/缺键=不掷）。
    switchEnterChance: 0.5,
    avatarOn: 'data/avatars/hype.png',      // 红黑：她
    avatarOff: 'data/avatars/normal.png',   // 蓝白：她日常那个
    lastSwitchAt: 0,           // 上次自动切换时刻（冷却用）
    // ── 记忆卫生（换人不换口吻）──
    // 历史里"我"的发言按**发言归属**过滤（归属标记见 store.appendSelf）。
    // 不开的话第二人格会照着第一人格刚说过的话说话 —— 那是模型最强的模仿信号。
    memoryHygiene: {
      hideFirstPersonaHistory: true,    // 她在位时：隐去第一人格说过的话（保留"我回过话"这个位置的语义由块头说明承担）
      hideSecondPersonaHistory: true,   // 第一人格在位时：隐去第二人格说过的话（卡里要求"她不知道你的存在"）
      clearDraftsOnEnter: true          // 进入时清跨轮工作记忆（那些"未发送想法"是第一人格的语气）
    },
    saved: null,               // 进第二人格前的原值快照
    stats: null                // { enteredAt, reason }
  },
  // 人设与行为
  persona: {
    botName: '小鲸鱼',
    selfNickname: '',                       // 在群里的展示名（留空用 QQ 昵称）
    roleText: PERSONAS.xiaojingyu.text,     // 默认人设：原版"小鲸鱼"角色卡（适配版）
    // true = 系统提示只发"精简版规则"（安全边界 + 工具协议 + 说话要点，约 800 字），
    // 通用长规则（反 AI 味/主体性/表情策略/QQ 场景…几千字）不再每轮重复发。
    // 小模型 / 短上下文（约 8k 窗口）建议打开；人格细节由角色设定卡承担。
    compactSystemPrompt: false,
    // system 组装风格（2026-10-18 按当前代码订正文案）：
    //   'full'（缺省）新版分节完整协议 ｜ 'lean'（'cleaned' 是其别名）老树 3.8 生产用精简协议
    //   （系统块约 1.4k→2.1k 字，扩展段只附 life-worldbook，与老树同口径）｜ 'soft'/'soft2' 旧协议
    //   ｜ 'hype' 亢奋极简 ｜ 'custom' **完全自定义系统风格**（业务风格层整层替换为 persona.customRules
    //   的正文，空串 ⇒ 告警回退 full；工具协议/身份边界/权限与收尾引导继续独立——合同见
    //   `.agent/第二批体验修复派发-20261018.md` 末尾《自定义风格配置合同》）。
    //   ⚠ 旧注释"角色卡不塞进 system"已过期：当前组装把 roleText 注入 system（【角色设定】/【管理员附加人设】）。
    systemMode: 'full',
    participation: 'medium',                // low | medium | high —— 参与度参考
    // 旧配置别名：新设置项为 emotion.ignoreSenderIds；config-store 会兼容读取本键。
    ignoreSenderIds: [],
    // 情绪计算性格档（九型人格，见 emotion-personality.js）：
    // t1…t9（完美/助人/成就/自我/理智/忠诚/活泼/挑战/和平）
    // 旧 id（extrovert_sunny 等）会自动映射，不用手工改
    emotionProfile: 't7',
    // 管理员附加规则（可选）：其它档追加为【管理员附加规则】；systemMode='custom' 时它=**自定义系统风格正文**
    // （业务风格层整层替换；空串 ⇒ 告警回退 full，不裸奔、不叠内置风格）。
    customRules: ''
  },
  // 用户自定义人设库（保存在配置里，可在设置页添加/选择）
  customPersonas: [],
  // 接入白名单
  allow: { groups: [], private: [] },
  deny: { groups: [], private: [] },
  allowAllWhenEmpty: false,
  // 运行节奏
  // ★ 2026-10-16（防抖真值 · 按 018f1d3e 的真实接线更新，收回 2026-10-08 的"死键"结论）：
  //   `wakeDelayMs` **不是死键**：`orchestrator/index.js` 的 `readBurstKnobs()`（:2836/:2860）真读它，
  //   语义 = 空闲首条消息的防抖窗口（`pointed || burstSettleMs === 0` 时直接用它），默认 2000。
  //   ★ 0 会被**归一成 2000**（`read('wakeDelayMs', { allowZero: false })`）—— 想让首条立刻跑请改
  //   `burstSettleMs: 0`（见下），不要指望这里的 0。
  wakeDelayMs: 2000,
  // 连发合并：同一会话消息一条接一条时把窗口拉长到 burstSettleMs（等这串话说完），整串最多等到 burstMaxWaitMs。
  // ★ 2026-10-16（真值）：`burstSettleMs: 0` = **不聚批**（`pointed || burstMs === 0` ⇒ 直接按 wakeDelayMs 开跑）；
  //   `burstMaxWaitMs: 0` = **不封顶**（`maxWait = burstMaxWaitMs > 0 ? burstMaxWaitMs : Infinity`，orchestrator:3213）。
  //   默认 15000 / 30000。两把键都由 `readBurstKnobs()` 每次排窗口现读（改完即生效，不用重启）。
  burstSettleMs: 15000,     // 连发时"最后一条之后再等多久"（要盖过常见的人手连发间隔 10~30s）
  burstMaxWaitMs: 30000,    // 一串连发从第一条算起最多等多久（0 = 不封顶）
  // ★ 2026-11-05（溟 · 她要的两档等法）：上面那套是"猜"，下面这套是"她明说"。
  //   一串话里出现 burstSlowTriggers 里的任一词 ⇒ 后面还有话，等她说完再发车，窗口用 burstSlowWaitMs。
  //   命中时不走 burstAdaptive（自适应是在猜她还要说多少，她既然明说了就按明说的算）。
  //   `burstSlowWaitMs: 0` 或触发词列表为空 = 这条通路关掉，行为与没加这两个键时一致。
  burstSlowWaitMs: 10000,   // "听我说"之后等多久（仍是"最后一条之后再等"的语义）
  burstSlowTriggers: ['听我说', '你先听我说', '听我说完', '我说完你再'],
  // ── 连发窗口按「这个人自己爱不爱连发」自适应（2026-09-20 设计，2026-10-16 确认已接线）──
  // ★ 2026-10-16（真值 · 按 018f1d3e）：`burstAdaptive.*` 已由 `orchestrator/index.js:3218` 起**每次现读**：
  //   `enabled:false` ⇒ 退化成固定 `burstSettleMs`；开启则按**这个人**的历史连发倾向插值：
  //     窗口 = wakeDelayMs + (burstSettleMs − wakeDelayMs) × min(1, 连发倾向 / k)，仍受 burstMaxWaitMs 封顶。
  //   下面是当年选参的实测依据（仍然有效，不再是"老树口径存档"）。
  // 原来只有两个死值：新串首条 = wakeDelayMs、串内 = burstSettleMs，对所有人都一样。
  // 实测（test/burst-scope-lab.mjs，15.4 万条真实入站消息，剔除了自测夹具）：
  //   · 「他还会接着发吗」按人差得非常远：p10=10.6% / p50=29.6% / p90=51.0%，
  //     而且稳定（前半段估的值预测后半段 r=0.85）→ 可以照人给窗口。
  //   · 私聊首条最容易被低估：47.9% 会被接着说，而群里只有 25.8%。
  //   · 参数扫描（规则：平均等待不许增加，在此前提下打断率最低）选中下面的公式：
  //       窗口 = wakeDelayMs + (burstSettleMs − wakeDelayMs) × min(1, 连发倾向 / k)
  //     平均等待 9.40s ≤ 老行为 9.69s，打断率 11.7% < 11.8%；
  //     "说完就闭嘴"的人窗口从 9.1s 降到 5.6s，而打断率 8.4%→8.6%（几乎没变）。
  //   · 「按人算串」（换个说话的人就开新串）实测**不成立**：换了个人说之后
  //     "他还会接着说"是 38.0%，比同一人接着说（34.2%）还略高 —— 群里热闹时人人都连发。
  // 关掉它 = 完全回到老行为（首条短窗口 / 串内长窗口）。
  burstAdaptive: {
    enabled: false,
    k: 0.3,           // 连发倾向达到它就给满 burstSettleMs（越小越偏"多等一会"）
    minSamples: 6,    // 这个人的消息对数不够就用下面的类型先验
    priorPrivate: 0.45,
    priorGroup: 0.28
  },
  drainDelayMs: 1200,       // 一次运行结束后发现还有未读，到下一次运行的间隔
  maxConcurrentRuns: 2,     // 全局同时进行的 agent 运行数
  // 发送保护
  send: {
    splitLongAt: 0,         // 单条超过这么多字就按标点自动拆成几条（0 = 不拆；小模型建议 30~40）
    maxPerRun: 4,           // 单次运行最多发几条文字（防小模型一口气刷屏；0/空 = 不限制）
    minGapMs: 500,          // 相邻两条消息最小间隔
    maxGapMs: 1200,         // 最大间隔
    byLengthMs: 30,         // 按字数附加的间隔（毫秒/字）
    maxPerMinute: 80,
    maxPerHour: 500,
    // 拦下整段英文（无中文且 ≥3 个英文词）；允许夹在中文里的英文词
    blockPureEnglish: true,
    // ── 发送前清理与内容兜底（T76a 补默认值：这 5 键原先只在读取点有兜底、这里没有）
    //    两个「清理」是 opt-in（读取点判 === true），默认 false = 不清理；
    //    两个「兜底」是 opt-out（读取点判 !== false），默认 true = 照旧拦。
    stripEmoji: false,        // 发出前剥掉 emoji（tools.js send_message；剥空会打回重说）
    tidyBrackets: false,      // 发出前清掉句尾方块装饰 ～】]（tools.js send_message / prompt.js 组装）
    blockAiSelfClaim: true,   // 拦「我是 AI/模型」自称（tools.js 身份兜底，looksLikeAiSelfClaim）
    blockJsonFragments: true, // 拦把工具参数当正文发出来（tools.js 结构碎片兜底）
    hardSplitAt: 4000,      // QQ 硬限制切分（0 = 不限制）
    biliJsonCard: false     // B站视频 json 卡；true 时用 video 卡。仍「过期/升级后使用」就保持 false（只发封面+链接）
  },
  // 疯狂星期四：每周四固定点直发文案（不走 LLM、不带人设）
  // groupIds 留空 = 不向任何群发送（不会回落到 allow.groups）
  crazyThursday: {
    enabled: true,
    times: ['07:00', '13:00', '19:00'], // 一天三次，间隔 6 小时
    groupIds: []                       // 必须显式填群号；空 = 本轮不发
  },
  // ★ G4-a2 · 通用定时文本广播（新键优先；**旧键 crazyThursday 保留为兜底**）
  //   ★★ H1（本次最危险的一条）：`items` 必须是 **[]**。
  //   一旦默认非空 ⇒ legacy 兜底对**所有人**都不可达 ⇒ 每个老用户现有的 `crazyThursday.groupIds`
  //   会被**静默忽略** ⇒ **重启即静默停发**。所以这里只声明形状，不预置任何计划。
  //   schema 细节见 `.tmp-dispatch/g4-prep/change-list.md` 的字段级草案。
  broadcastSchedules: {
    enabled: true,                     // ★ H2：现在真的会被读（resolveBroadcastPlans 会用）
    items: []                          // ★ H1：必须为空数组
  },
  // 主动开话题（可选）
  proactive: {
    enabled: false,
    checkIntervalMinMs: 1800000,
    checkIntervalMaxMs: 5400000,
    idleThresholdMs: 1800000,   // 群里静默多久才算"冷场"
    probability: 0.25,
    // ── 私聊主动 ──
    // 冷场：和群聊共用检查循环；阈值/概率可单独覆盖
    privateIdleEnabled: false,
    privateIdleThresholdMs: 3600000,
    privateIdleProbability: 0.25,
    // 定时：独立轻量循环（约每 30s 对一次钟），到点唤醒对应私聊
    privateScheduleEnabled: false,
    // [{ chatId: "10000003", time: "21:00", days: [1,2,3,4,5] }]
    // days: 0=周日…6=周六；省略或空数组 = 每天
    privateSchedules: [],
    // 白名单里「能聊」但「不主动找他」的号（2026-10-31 溟加）：余数的私聊是开的，
    // 但冷场骰子不该去敲他的门——主动找人不属于「开放私聊」。默认空 = 行为不变。
    privateExclude: []
  },
  // 表情包
  sticker: {
    enabled: true,
    // 提示词里列几张表情（一半常用、一半轮换）。列得多选择多，但也多花 token：
    // 每张约 45 token，12 张 ≈ 540 token。
    promptMaxStickers: 12,
    // 轮换批次的更换周期（分钟）。库越大越该短一点，否则没露过脸的表情永远轮不到。
    rotatePeriodMin: 60,
    collectEnabled: true,
    maxCollectPerHour: 10,
    // 回复发出后额外调用主模型挑表情。新配置默认关闭，避免静默增加模型调用；
    // 老配置中显式开启的实例会继续保持开启。
    autoPick: {
      enabled: false,
      probability: 0.35,
      shortlist: 8,
      cooldownMs: 120000
    },
    // 发表情包的积极程度（0=不鼓励 1=偶尔 2=较积极 3=很积极）。
    // 这是在提示词层面引导模型"更愿意用表情回应"，不是强制每次都发 ——
    // 强制会显得机械，引导才能让它在合适的时候自然用上。
    encourage: 1
  },
  // 受控出站开关（modules/media/boundaries.js 的闸读这里；闸本身保留，这里只是默认档位）
  media: {
    visionScan: {
      // 模型视觉探测（POST /api/vision/scan）会向**用户自己配置的 provider** 发出站请求：
      // 每模型 2~4 次 chat/completions，带 32×32 纯色探测图，用该 provider 的 apiKey。
      // 老树没有这道闸、该端点本来就是要发探测图的（src/app.js:2379）⇒ 默认开 = 恢复既有行为；
      // 关回去 = 显式 false，闸会**显式失败**（third_party_upload_disabled），不静默空结果。
      allowOutbound: true
    }
    // media.reverseImage.allowThirdPartyUpload：维持边界层默认关（老树同样默认关，不在这张票动）
  },
  // 存储
  store: {
    // 单群 JSON 最大保留条数。**0 = 不限制**。
    // 用户明确要求取消上限（原为 2000）。配套措施：
    //   - 前端存档页已分页（首屏 500 条、滚动追加 200 条），不会因数据多而卡
    //   - store 的 #trim 在 maxPerChat<=0 时直接跳过
    // 注意：单群文件会随时间增长，磁盘占用请自行留意。
    maxMessagesPerChat: 0,
    // ── 落盘热段条数（2026-09-22）──
    // 最近这么多条留在 messages/<key>.json（每次收发消息都要重写它，所以越小越快）；
    // 更老的原文归档到 messages-cold/<key>.NNNNN.json（每片 5000 条，写满即冻结）。
    // 内存里以及所有读取路径（模型上下文 / 翻页 / 存档页 / 记忆巩固）始终是全量，
    // 这个值只决定"哪一段走慢写"——所以调它不会改变任何功能行为。
    // 实测依据：20,000 条 ≈ 34ms，线性外推 172,998 条约 290ms；3000 条约 5ms。
    // 0 = 不分层（退回单文件全量写，仅用于排障对照）。
    hotMessagesPerChat: 3000,
    // ── 上下文读取档位（决定本次唤醒读多少条历史）──
    // 档位是"累积生效"的：选 4 档时 1/2/3 档也都生效，按 4→3→2→1 顺序检查，
    // 第一个命中的决定读取条数。这个设置替代了原来的 pastStateLimit 固定值。
    contextTier: 4,             // 1=仅艾特 2=+关键词 3=+随机 4=全读
    atCount: 20,                // 档1：机器人被艾特时读 w 条
    keywordCount: 15,           // 档2：命中关键词时读 x 条
    keywords: [...BOT_ALIAS_KEYWORDS], // 档2 的关键词表；内置身份别名始终保留
    randomPercent: 10,          // 档3：y% 概率
    randomCount: 8,             // 档3：命中时读 z 条
    allCount: 80,               // 档4：读全部（上限）
    // 只影响 deepseek 策略；可在 private/perChat 覆盖，4..192，设4恢复原缩放下限。
    deepseekAnchorMinChunk: 77,
    // ── 自由接话方式（2026-10-17 用户裁定：可切换，且逐群可单独设置；2026-10-18 合同：出厂改 random）──
    // 'random' = 随机回复（**出厂默认**）：该群只按真实 randomPercent 抽样（0 = 不入，100 = 可入），
    //            自由入场不请求云判定；主模型是否实际发送仍看工具/准入合同。
    // 'jev' = 云裁判：第 3 档先按 randomPercent 抽候选，抽中再请求云判定，放行才进主模型；
    //         点名 / 私聊 / 有效窗口续聊不受影响（走各自既有响应合同）。
    //         ⚠ 需 `localJev.judgeMode.enabled`（云判定总闸）开启；总闸关闭时本值**不允许绕过闸**，
    //         按普通随机路线降级（实际模式与原因由 UI/诊断显示）。
    // 单群覆盖写在 store.perChat[chatKey].replyMode；未写/null = 继承全局（删键即恢复继承）。
    // 旧 localJev.replyChance.mode 只做**有界兼容**（新键未显式配置时才参考），不再与它争优先级。
    replyMode: 'random',
    // ── 聚焦续聊窗口总开关（2026-10-18 合同）──
    // 机器人接过话后的一小段窗口里，跟进的下一句更容易被接上（聚焦窗口的开/收/调度与消费总开关）。
    // 出厂 false，手动开启；读侧一律走 `effective('store.followupEnabled', {chatKey,kind})` ——
    // 单群覆盖写在 store.perChat[chatKey].followupEnabled（true/false；删键 = 继承全局）。
    // 关闭 = 及时收起窗口/定时器/缓存；不影响点名、私聊与其它明确唤醒。
    // 聚焦关闭或随机模式下不得借聚焦发起云判定；总闸（judgeMode.enabled）关闭时更不允许（走本地资格）。
    followupEnabled: false,
    // ── 私聊单独设置 ──
    // 上面这一套 = 群聊参数。privateOverride=false 时私聊沿用群聊（老行为，向后兼容）；
    // 打开后私聊改读 private 里的同名字段（缺哪个字段就回落到群聊那份）。
    // 为什么需要：私聊一般不会 @ 机器人、也未必命中关键词，若和群聊共用
    // "3 档 + 随机概率"，1v1 的消息会被概率性地标记已读、直接不回。
    privateOverride: false,
    private: {
      contextSliderPos: 100,
      contextTier: 4,
      atCount: 20,
      keywordCount: 15,
      keywords: [],
      randomPercent: 100,
      randomCount: 8,
      allCount: 80
    },
    keepSessionFiles: 0,        // 保留最近多少个会话记录文件；**0 = 不限制**（原为 300）
    // 近 24h 本地摘要（可选，可按 群聊默认 / 私聊 / 单群 覆盖）：
    // 本地扫存档压成短文本；注入长度被 maxChars 封顶，大群不会因消息多而多花 token。
    // 默认关。字段也可出现在 store.private 与 store.perChat[chatKey] 里。
    recent24hDigest: {
      enabled: false,
      hours: 24,
      maxChars: 240,
      maxItems: 8
    },
    // ── 历史冷藏（缓存友好）──
    // 过去状态拆成「冷藏段（粘住切点，少变）+ 热段（新消息追加）」。
    // 显式缓存时冷藏进 user stable，热段进 volatile → system+冷藏跨运行可命中。
    historyCold: {
      enabled: true,
      warmCount: 12
    },
    // ── 峰期 / 谷期独立回复概率（2026-10-22 她要的）──
    // 只作用于**群聊**：命中峰期窗口用 peakPercent，其余时间用 offPeakPercent，
    // 覆盖 `contextSliderPos` 派生的 store.randomPercent（一个值管全天的老做法）。
    // enabled=false 时整块不生效（出厂关闭，行为与补丁前逐字一致）。
    // 窗口左闭右开、允许跨零点（如 19:00 → 01:00）；perChat[chatKey] 可整体覆盖同名字段。
    // 读点：modules/time-profile/index.js，接线在 orchestrator#scopedReplyProbability 与 plan#decide。
    timeProfile: {
      enabled: false,
      peakStart: '19:00',
      peakEnd: '23:45',
      peakPercent: 35,
      offPeakPercent: 8,
      perChat: {}
    },
    // ── 单个群/好友单独设置响应档位 ──
    // key = chatKey（"group:群号" / "private:QQ号"），value = 与群聊同名的参数块
    // （contextSliderPos/contextTier/randomPercent/atCount/keywordCount/keywords/randomCount/allCount）。
    // 优先级：perChat[chatKey] > 私聊单独设置（privateOverride）> 群聊默认。
    // 没配的会话完全跟随默认，老配置不受影响。
    perChat: {}
  },
  // 新树自动整理按会话观察到的新消息触发，生成情节摘要；**按人物印象条数的双阈值门已于
  // 2026-10-15 接入**（`3e191b2b`：`apps/server/memory-maintenance.js` 的 flushDeferred 读
  // `consolidateMinImpressions` / `maxImpressionsPerMember` 两个键）。
  memory: {
    consolidateEnabled: false,   // 2026-10-03 用户口径「不用每晚自动整理」⇒ 默认关（opt-in；与 orchestrator `!== true` 判据两侧一致）
    // 默认一周一次：一天一次删太多，用户明确嫌狠
    consolidateMinIntervalMs: 7 * 24 * 60 * 60 * 1000,
    // 印象双阈值门的「总量侧」：总印象数 > 本值 ⇒ 触发整理（另一侧 = maxImpressionsPerMember）。
    // 老树语义逐字对齐：`src/orchestrator.js:5449-5465` 的
    // `Number(cfg.memory?.consolidateMinImpressions) || MEMORY_THRESHOLDS.memberImpression(4)`。
    // 新树读点：`apps/server/memory-maintenance.js:109`（`3e191b2b` 的双阈值门）。
    // ★ 2026-10-15 补进 defaults（key-ledger ds1）：此前只在代码里回退 4 ⇒ 面板与台账都看不见它，
    //   用户只能手改 config.json 才生效（config-store 对默认表外的键不做拦，见 index.js mergeConfig）。
    //   补的默认值 = 4，与代码回退逐字相同 ⇒ 运行时行为零变化。
    consolidateMinImpressions: 4,
    // 印象双阈值门的「单人侧」+ 旧版人物印象整理阈值。★ 2026-10-15 更正旧注释：新树**已消费**它 ——
    // 读点 `apps/server/memory-maintenance.js:110-111`（双阈值门），不再是"保留旧配置供兼容"。
    maxImpressionsPerMember: 12,
    useChatModel: true,                   // true = 整理模型跟随聊天模型；false = 使用下方专用模型
    provider: '',                         // 专用模型所属提供商 id（useChatModel=false 时生效）
    model: '',                            // 专用模型 id（useChatModel=false 时生效）
    semanticCardsViaLlm: true,            // 巩固时用模型抽 1~2 张语义卡（弱模型可关）
    // memory-v2 维护循环间隔（长期会话记忆巩固，本地索引不调模型）。单位毫秒；
    // 缺失/非数字/<=0 ⇒ 运行时回退 3600000（=1 小时，T47 之前的硬编码行为）。
    maintenanceIntervalMs: 3600000,
    // 手动编辑印象后，这段时间内自动整理跳过。单位毫秒；
    // 非法/<=0 ⇒ 运行时回退 4 小时；运行时另夹在 [5 分钟, 24 小时]（上限护栏，防"锁一整天"）。
    // ★ 手动一键整理不受此锁影响（手动走 force，不看这个锁）。
    manualEditLockMs: 4 * 60 * 60 * 1000
  },
  // 扩展底座（skills/ + plugins/）：开关唯一来源 config.skills[id].enabled
  // 这里放的是 0.3.1 官方、你魔改版核心没有的扩展；与已内建功能同名的未装
  skills: {
    'ban-state': { enabled: true },
    'image-compat': { enabled: true },
    'speaker-identity': { enabled: true },
    'thinking-adapters': { enabled: true },
    // ── 2026-09-22 从 0.4 移植过来的扩展（默认开关按"是否与核心重复"定）──
    // 重复的关掉：核心已经有同样功能，开着只会双份注入/双份工具
    //   conversation-memory：它的 before-llm-messages 钩子会再调一次 buildArchitectureInject
    //     （语义卡/跨轮/待办/跨群），而核心本来就注入了一遍 → 提示词里会出现两份
    //   memory-recall / knowledge-memes / sticker-annotate / reverse-image：核心已有
    //     memory_search/archive、memory_meme_*、表情备注、identify_image 反向搜图
    'conversation-memory': { enabled: false },
    'memory-recall': { enabled: false },
    'knowledge-memes': { enabled: false },
    'sticker-annotate': { enabled: false },
    'reverse-image': { enabled: false },
    // 不重复、按需开的（依赖外部东西，默认关着，用户自己填好再开）
    'account-pool': { enabled: false },   // 多账号轮询：核心 llm.js 已接 llm.endpoint-pick
    'media-download': { enabled: false }, // 下载 B站/抖音，需要 yt-dlp/ffmpeg
    'speech-to-text': { enabled: false }, // 语音转文字，需要 whisper-cli + 模型
    'owner-identity': { enabled: false }, // 主人识别：填了主人 QQ 才有效
    'reply-safety': { enabled: false },   // 核心已内建 reply-recovery/inline-calls/salvage
    // 自包含、装上就能用的工具类（默认开）
    'video-frames': { enabled: true },
    calculator: { enabled: true },
    'text-tools': { enabled: true },
    'weather-query': { enabled: true },
    'random-image': { enabled: false },
    'image-generate': { enabled: false }
  },
  extensions: {
    // 监听 skills/ plugins/ 变化自动重载（等价于落地 JS 会被执行；共享机建议关）
    hotReload: true
  },
  // 知识库三件套：内部（梗库）/ 外部（wiki）/ 图库（与表情分开）
  knowledge: {
    internal: { enabled: true },          // 群内梗/结论，模型 memory_meme_*
    external: {
      enabled: true,                      // 触发词命中时 external_lookup 查 wiki
      triggerWords: [
        '百科', '设定', 'wiki', '萌娘', '维基',
        '角色是谁', '是什么设定', '背景故事', '出自哪里'
      ]
    },
    images: {
      enabled: true,                      // 独立图库（可发图/形象）
      autoCueSelf: true                   // 「你长什么样」等触发时提示去图库
    }
  },
  // 桌面端/控制台
  server: {
    port: DEFAULT_CONSOLE_PORT,
    instanceName: '',         // 界面账号标签页上显示的名字；留空 = 主账号 / 账号 N
    token: '',                // 留空 = 只监听 127.0.0.1
    autoStart: false,         // 开机自启（仅 Electron 桌面端生效）
    autoStartPeer: true,      // 存在 data-2/ 时，桌面端一起拉起第二个账号的实例（界面顶部出现账号标签页）
    closeToTray: true         // 点关闭 = 最小化到托盘
  },
  ui: {
    // 主题：'dark' | 'light' | 'system'（system = 跟随系统偏好）。
    // 前端以 localStorage 为准做到即时生效，这里只是跨设备/重装后保留用。
    theme: 'dark',
    // 自定义配色（覆盖 --bg / --accent 等；空字符串 = 用主题默认）
    customBg: '',
    customBg2: '',
    customBg3: '',
    customAccent: '',
    customText: '',
    customMuted: '',
    customFaint: '',
    customToolAccent: '',
    customThemeId: '',        // 当前使用的自定义/预设主题 id（themes/ 或内置 mech-orange）
    customExtraColors: {},    // 用户对任意主题颜色键的本机改色；桌面端两号互通
    mechFx: true,             // 机甲主题是否启用特效（发光/角标）；可关
    brightness: 100,          // 界面亮度 70~130，100=默认；两号桌面互通
    uiScale: 100,             // 界面缩放 % 80~200，100=默认；卡牌/字体/间距整页等比
    showVision: true,         // 模型目录显示图片输入能力徽标
    refreshMs: 15000,         // 界面轮询间隔
    hideApiNews: false,       // 隐藏顶部「免费API」页签（不影响后台抓取）
    // 顶栏"账号标签"（本机多实例一键切换）。
    // 2026-09-22 的来回与最终形态：
    //   · 先出过"莫名多按钮/点了黑屏" → 我一度把开关默认**关**掉并落盘成 `ui.instanceTabs: false`；
    //   · 用户随后要"两个号合并在一个窗口里切" → 恢复默认开，但**只列同版本的实例**；
    //   · 问题来了：旧配置里已经存着 `instanceTabs: false`，默认值再改也盖不过它 ——
    //     用户那边"还是合并不了"。所以这个开关**改名**：老键当没看见，新键语义是"隐藏"。
    hideInstanceTabs: false,
    // ── 顶部工具栏自定义（设置 → 桌面端 → 界面）──
    // navOrder / topOrder：显示顺序（id 数组）；空 = 用出厂默认顺序
    // navHidden / topHidden：要隐藏的 id；隐藏后仍可通过设置恢复
    navOrder: [],
    navHidden: [],
    topOrder: [],
    topHidden: [],
    // ── 独立桌宠悬浮窗（设置 → 桌面端 → 桌宠）──
    // 尺寸按「窗口宽度 px」记：高度由主进程按 320/280 比例推导。
    desktopPetSize: 280,           // 窗口宽度，150~420（主进程校验并夹紧）
    desktopPetAutoActions: true,   // 播放发呆 / 干活逐帧动画
    desktopPetShowUsage: true,     // 显示今日用量摘要
    desktopPetShowMood: true,      // 显示心情/精力/情绪词
    desktopPetSkin: 'qq-agent-default', // 皮肤包 id；非法/缺失回落 qq-agent-default，再回落内置旧图 default
    // #9 做法①：窗口位置（px 屏幕坐标）。null = 没存过 = 首次落在光标屏右下角；
    // 拖动结束由主进程写入，恢复时按「最近显示器的 workArea」夹紧（多屏/分辨率变化不丢屏外）。
    desktopPetX: null,
    desktopPetY: null,
    // ── 开发者模式（隐藏的高级入口）──
    // 入口：顶栏品牌区的版本号连点 5 次；一次开启跨重启持久（本文件落盘）。
    // 关闭按钮 = 关掉 devMode + 把 ui.devChanges 留痕过的改动恢复出厂默认。
    devMode: false,
    // 改动留痕：{ [配置路径]: { name, group, val, at } }。
    // 不记 def —— 默认值单一来源 = 服务端 GET /api/config/defaults（投影本文件的 DEFAULT_CONFIG），
    // 恢复默认按端点值写回；端点取不到即拒绝执行（绝不拿空值当默认值写回）。
    devChanges: {}
  }
};

// 搬运适配第五处的常量：供 migrations.js（ensureBotAliasKeywords）使用 —— 同一份值，不复制第二份
export { BOT_ALIAS_KEYWORDS, PROFILE_ID };
