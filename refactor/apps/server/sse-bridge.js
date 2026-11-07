/**
 * refactor/apps/server/sse-bridge.js —— `/api/events` 的**语义层**：bus 冻结事件名 → UI 旧树事件名
 *
 * 为什么需要这一层（2026-10-05 尺子）：
 *   新树 bus 的事件名是**冻结的 9 个**（`apps/server/assembly.js:402-406`：`evidence:built` /
 *   `context:retrieved` / `plan:decided` / `verdict:issued` / `receipt:confirmed` /
 *   `observation:committed` / `config:changed` / `extension:loaded` / `extension:reloaded`）；
 *   而 `apps/ui/app.js:4656-4739` 的 `new EventSource('/api/events')` 监听的是**旧树**的 12 个名字。
 *   **两套名字的中间那层从来没有过** —— 这就是本文件。
 *
 * ★ 本文件的唯一判据（也是本票的判据）：**看得见 + 不编**。
 *   - 有真来源 ⇒ 接上，并在表里写清"来源 = 哪个模块哪一行"。
 *   - 没有真来源 ⇒ **整条 not-ported**，并写清"为什么没有"。宁可 UI 少几个事件，
 *     也不发空事件/编载荷 —— `session-update` 半份快照会把 UI 的会话卡片写坏（票面 §1(3)）。
 *   - `status` / `onebot-status` **只允许边沿触发**（值真变了才发）。绝不许"每 N 秒发一条假装还活着"：
 *     那种帧会让 UI 的连接看起来很健康，实际什么也没发生 —— 本票最想避免的就是这种假绿。
 * ★ 票 S-4（2026-10-07）：`session-*` 三条仍是 not-ported，但**理由已从"没有会话注册表"改成真话**
 *   （"编排层零 emit 站点"），并新增 `SESSION_FRAME_CONTRACT` / `PENDING_BUS_TO_UI`
 *   —— 契约先立、生产者后接；装弹条件与那一处深度限制见那两段的注释。
 * ★ 票 N57（2026-10-09）：① `feedback` 接上（act 的 `report_feedback` 执行器真 emit 了）；
 *   ② `plugins-reloaded` 的 not-ported **理由更正**（原来说"没人调 onReloadComplete"已过期 ——
 *   `assembly.js:1021-1032` 现在确实调了；真实缺口改成"没人往 bus emit 事件"）。
 *
 * 依赖方向：apps（只吃注入的 `hub` 与 `obs`，不 import 任何 modules/**）
 */

/** UI 监听的事件名全集（来源：`apps/ui/app.js:4656-4739`，只读引用）。 */
export const UI_EVENT_NAMES = [
  'plugins-reloaded', 'session-start', 'session-update', 'session-end', 'chat-update',
  'memory-update', 'onebot-status', 'status', 'snowluma-status', 'snowluma-log',
  'feedback', 'sticker-annotate'
];

/**
 * bus 冻结事件名 → UI 事件名。**只列有真来源的**。
 * 六条都指向 `chat-update`：M15 每推进一步都会带上 `chatKey`，而 UI 的 `chat-update` handler
 * （`app.js:4714-4717`）**根本不读载荷**，只做"这个聊天变了，去重新拉"——所以这是如实映射，
 * 不是硬造事件。UI 因此能在轮次进行中看到会话列表刷新，而不是等用户手动刷新。
 */
export const BUS_TO_UI = {
  'evidence:built': 'chat-update',
  'context:retrieved': 'chat-update',
  'plan:decided': 'chat-update',
  'verdict:issued': 'chat-update',
  'receipt:confirmed': 'chat-update',
  'observation:committed': 'chat-update'
};

/**
 * 会话三帧的映射 —— **刻意与 `BUS_TO_UI` 分开成表**。
 * 为什么：上面这张表是"六个 bus 冻结事件 → 同一个 UI 名（chat-update）"，而
 * `sse.selftest.mjs:207-210` 的 ⑤a 把"**恰好六条且都指向 chat-update**"钉成了契约。
 * 会话三帧是**另一族**（三个不同 UI 名、有各自的字段契约），塞进那张表会把 ⑤a 顶红 ——
 * 而那把尺子不是我的（不许为了让自己的改动变绿去改验收尺子）。
 * ⇒ 三张表都真接：`start()` 订阅它们的并集，白名单也按并集算（见 `BRIDGED_UI_NAMES`）。
 */
export const SESSION_BUS_TO_UI = Object.freeze({
  'session:started': 'session-start',
  'session:updated': 'session-update',
  'session:ended': 'session-end'
});

/**
 * ★ N57（2026-10-09）：**工具层产出的 bus 事件 → UI 事件名**（第三张表，与上面两张分开的理由同源）。
 *
 * 唯一一行：`feedback` ← `feedback`。生产者是 **act 的 `report_feedback` 执行器**
 * （`modules/act/executors/messaging.js:187-189` 的 `observability.emit('feedback', …)`，
 *  由 qwen1 在 N35 接通）。旧树同一条链在 `src/tools.js:2587`：
 *  `ctx.emit('feedback', {sessionId, chatKey, level, message})`。
 *
 * 载荷差异（如实记）：旧树带 `sessionId`；新树执行器发的是 `{chatKey, level, message, at}`，**无 sessionId**。
 * UI 侧 handler（`apps/ui/app.js:5002-5005`）只读 `level` / `message` ⇒ 不影响；
 * 但这一条不许当成"完全等价"——将来 handler 要读 sessionId 就得去 act 那边补键。
 *
 * ⚠ 这张表**不许**并进 `BUS_TO_UI`：`sse.selftest.mjs:207-210` 的 ⑤a 把"恰好六条且都指向 chat-update"
 *   钉成了契约。并进去会把别人的尺子顶红（与 SESSION_BUS_TO_UI 当初分表的同一条纪律）。
 */
export const TOOL_BUS_TO_UI = Object.freeze({
  'feedback': 'feedback'
});

/**
 * ★ A3（2026-10-11 mimo3）：表情批量补备注进度帧（**第 4 张表**，分表理由同 SESSION/TOOL）。
 * 生产者：`api/media.js` stickersAnnotate + `modules/media/sticker-manager.js` annotateMissing ——
 *   经装配层补上的 `ctx.emit`（assembly.js ctx 返回块，A3 同票）上 bus `sticker-annotate`；
 *   UI 侧 `apps/ui/app.js:5053` 监听同名事件刷进度 hint（start/progress/done/error 四态）。
 * ⚠ 不许并进 `BUS_TO_UI`：⑤a 把"恰好六条且都指向 chat-update"钉成了契约（与 SESSION/TOOL 分表同一纪律）。
 */
export const STICKER_BUS_TO_UI = Object.freeze({
  'sticker-annotate': 'sticker-annotate'
});

/**
 * ★ S3 另一半（2026-10-14 mimo3）：SnowLuma 同名直通（bus 名 = UI 名，第 6 张表）。
 * 生产者：`modules/snowluma/index.js:258` pushLog → `snowluma-log`；`:392/:409/:413` 内嵌启动/退出 → `snowluma-status`
 * （老树同位 `src/app.js:476/:541/:546`）。分表理由与 SESSION/TOOL/STICKER 相同：
 * ⑤a 把 BUS_TO_UI 钉成"恰好六条且都 chat-update"，并进去会顶红别人的尺子。
 */
export const SNOWLUMA_BUS_TO_UI = Object.freeze({
  'snowluma-status': 'snowluma-status',
  'snowluma-log': 'snowluma-log'
});

/**
 * ★ 装弹（2026-10-14 mimo2，指挥位派单）：面板刷新两事件（发射端 luna2 `e51babad` 已在
 * `apps/server/assembly.js` 落地，载荷都是 `{}`，界面 handler 也不读载荷）。
 *   · `config:changed` → 界面 `status`：**改名直通**（不是同名）—— UI `app.js:5171` 只 refreshStatus；
 *   · `plugins-reloaded` → 同名：UI `app.js:5054` schedulePluginMenuRefresh。
 * 分表理由与 SESSION/TOOL/STICKER/SNOWLUMA 相同：⑤a 把 `BUS_TO_UI` 钉成"恰好六条且都 chat-update"，
 * 并进去会顶红别人的尺子。
 */
export const PANEL_BUS_TO_UI = Object.freeze({
  'config:changed': 'status',
  'plugins-reloaded': 'plugins-reloaded'
});

/**
 * ★ 记忆页实时刷新（2026-10-15 luna2，指挥位派单；同日按复核 aaf16f9c 回修 A/B/C）：
 *   `memory-update` 同名直通（bus 名 = UI 名，第 8 张表）。
 * 生产者**两个**，都在 apps/server 侧（**不动** modules/orchestrator —— 自动整理那半走的是同一个 coordinator 实例）：
 *   · `apps/server/assembly.js` 的 `wireMemoryUpdateEvents`（壳包在 coordinator 上）——
 *     runNextJob 包壳先 peek「下一个将被执行的 job」再发 `consolidate-start`（**排队不发**；busy/空队列不发）；
 *     终态 done/failed/unconsolidated → done/error（chatKey 按 jobId 反查；重试中不发终态、下轮重发 start）。
 *   · `apps/server/api/memory.js` 手工修改**真落账**点 → `{phase:'refresh'}`（删成员/删无号壳/清短期 removed=1/
 *     删卡 ok&&retracted>0/重新记住 reinstated=true/共享授权 ok/改印象有增删改或真改名）。
 * UI 侧 `apps/ui/app.js:5308-5352` 只读 phase/chatKey/note/error（三档 phase + 兜底刷新）。
 * 分表理由与 SESSION/TOOL/STICKER/SNOWLUMA/PANEL 相同：⑤a 把 BUS_TO_UI 钉成"恰好六条且都 chat-update"，
 * 并进去会顶红别人的尺子。
 */
export const MEMORY_BUS_TO_UI = Object.freeze({
  'memory-update': 'memory-update'
});

/**
 * ★ 裁甲（2026-10-11 指挥位）：旧树 UI 事件名**同名直通**（bus 名 = UI 名）。
 * **真生产者两个**：
 *   · `apps/server/api/media.js:382` —— 表情标注完成 `emit('chat-update', '')`
 *   · `apps/server/api/console.js:453` —— mark-read 完成 `ctx.emit('chat-update', chatKey)`（mimo2 `1a31193` 补产，缺口自记在 `:445-452`）
 * ★ 载荷残余（已知、如实记）：桥转发在 `BRIDGE_ROWS` 同级的 start() 里对**非对象载荷只带
 *   `{source: busName}`** ⇒ UI 实收 `{"source":"chat-update"}`，而老树带的是 chatKey；
 *   两处 UI handler（`app.js:4714/4982`）**都不读载荷** ⇒ 行为等价。
 *   **哪天要"按 chatKey 精确刷"，得改桥的载荷透传 —— 等真有需求再做，别现在动。**
 * UI 耳朵现成：`app.js:4982` 监听 `chat-update` → 列表刷新（15s 合流 `:20`；handler 不读载荷）。
 * ⚠ 不并进 `BUS_TO_UI`：⑤a 把"恰好六条且都 chat-update"钉成契约 —— 与 SESSION/TOOL/STICKER 分表同一纪律。
 * ⚠ 载荷是 `''`/字符串：⑦e 钉过非对象载荷原样通过。
 */
export const DIRECT_BUS_TO_UI = Object.freeze({
  'chat-update': 'chat-update'
});

/** 八张映射表的并集 = 桥真正订阅的 bus 事件 → UI 事件名。 */
export const ACTIVE_BUS_TO_UI = Object.freeze({
  ...BUS_TO_UI, ...SESSION_BUS_TO_UI, ...TOOL_BUS_TO_UI, ...STICKER_BUS_TO_UI, ...DIRECT_BUS_TO_UI,
  ...SNOWLUMA_BUS_TO_UI, ...PANEL_BUS_TO_UI, ...MEMORY_BUS_TO_UI
});

/** UI 事件名 → 白名单（hub 用它挡帧注入）。transport 的 `hello` 由 hub 自己发，不走桥。 */
export const BRIDGED_UI_NAMES = [...new Set(Object.values(ACTIVE_BUS_TO_UI))].concat(['onebot-status']);

/**
 * 映射表。**每行四列**：UI 事件名 ← 来源（新树模块 + 行号）+ 载荷形状 + 状态。
 * 复核者可以直接按 `evidence` 里的行号去盘上核对；本表任何一行都禁得起"照着行号去看"。
 */
export const BRIDGE_ROWS = [
  {
    ui: 'chat-update',
    status: 'bridged',
    source: 'bus 冻结事件 6 条 · modules/orchestrator/index.js::734/777/885/928/930/1096`/261/294/335/337/468'
      + ' ＋ 同名直通 2 条（裁甲 2026-10-11）· apps/server/api/media.js:382 标注完成 emit(\'chat-update\', \'\')'
      + ' · apps/server/api/console.js:453 mark-read 完成 ctx.emit(\'chat-update\', chatKey)（mimo2 1a31193）',
    payload: '{chatKey, roundId, ...bus 载荷, source:"<bus 事件名>"}（六条来源）；同名直通两源载荷为 \'\' 与 chatKey 字符串，'
      + '但桥对非对象载荷只带 {source:"chat-update"} ⇒ UI 实收 {source}（**已知残余**：老树是 chatKey；'
      + 'handler app.js:4714-4717 不读载荷 ⇒ 行为等价；要按 chatKey 精确刷需改桥透传，等真需求）',
    evidence: [
      'refactor/modules/orchestrator/index.js::577` 创建单例 emit(bus, \'receipt:confirmed\', {chatKey, roundId, ok, platformId})',
      'refactor/modules/orchestrator/index.js::577` 创建单例 emit(bus, \'evidence:built\', {...chatKey})',
      'refactor/modules/orchestrator/index.js::577` 创建单例 emit(bus, \'context:retrieved\', {chatKey, roundId, itemCount})',
      'refactor/modules/orchestrator/index.js::577` 创建单例 emit(bus, \'plan:decided\', {chatKey, roundId, action, reason})',
      'refactor/modules/orchestrator/index.js::577` 创建单例 emit(bus, \'verdict:issued\', {chatKey, roundId, signal})',
      'refactor/modules/orchestrator/index.js::577` 创建单例 emit(bus, \'observation:committed\', {chatKey, roundId, count})',
      'refactor/apps/ui/app.js:4714 es.addEventListener(\'chat-update\', () => { scheduleChatUpdateRefresh(); refreshStatus(); })',
      'refactor/apps/server/api/media.js:382 emit(\'chat-update\', \'\') ← 同名直通生产者①（标注完成 · A3 后 ctx.emit 已通）',
      'refactor/apps/server/api/console.js:453 ctx.emit(\'chat-update\', chatKey) ← 同名直通生产者②（mark-read · mimo2 1a31193）',
      '端到端读数：refactor/tools/进度帧验收.mjs 映射前 names=[hello, sticker-annotate]（白发）→ 映射后 + chat-update 帧'
    ]
  },
  {
    ui: 'onebot-status',
    status: 'bridged',
    source: 'OneBot 客户端状态 · modules/platform/onebot.js:94 onStatus / :99-104 #setStatus（经 apps/server/onebot-link.js:130 `get client()` 可达）',
    payload: '{connected, everConnected, error} —— UI handler app.js:4707 也不读载荷，只刷新状态',
    edgeTriggered: true,
    evidence: [
      'refactor/modules/platform/onebot.js:94-97 onStatus(fn) 返回退订函数',
      'refactor/modules/platform/onebot.js:99-104 #setStatus(connected) → 逐个 statusListeners 发 {connected, everConnected, error}（**只在连接状态迁移时触发**）',
      'refactor/apps/server/onebot-link.js:130 get client() { return client; } ⇒ index.js 能订阅',
      'refactor/apps/server/onebot-link.js:178 client.onStatus?.((st) => {...}) ← 旧内联块只写日志，没人往 SSE 送',
      'refactor/apps/ui/app.js:4707 es.addEventListener(\'onebot-status\', () => {...})'
    ]
  },
  {
    ui: 'status',
    status: 'bridged',
    source: 'refactor/apps/server/assembly.js:858 obs.emit(\'config:changed\', {})（luna2 e51babad）· 第 7 张表 PANEL_BUS_TO_UI 改名直通 → 界面 status',
    payload: '{}`（载荷空对象；UI handler app.js:5171 不读载荷，只 refreshStatus + 情绪页刷新）',
    evidence: [
      'refactor/apps/server/assembly.js:858 try { obs.emit(\'config:changed\', {}); }（配置保存成功路径）',
      'refactor/apps/ui/app.js:5171 es.addEventListener(\'status\', () => { refreshStatus(); … })',
      '端到端读数：.tmp-dispatch/2026-10-14/mimo2/r-桥表两条与记忆前沿.md（真 HTTP+真 SSE，含断线补取）'
    ]
  },
  {
    ui: 'plugins-reloaded',
    status: 'bridged',
    source: 'refactor/apps/server/assembly.js:868 obs.emit(\'plugins-reloaded\', {})（luna2 e51babad）· 第 7 张表 PANEL_BUS_TO_UI 同名直通',
    payload: '{}`（载荷空对象；UI handler app.js:5054 schedulePluginMenuRefresh 不读载荷）',
    evidence: [
      'refactor/apps/server/assembly.js:868 try { obs.emit(\'plugins-reloaded\', {}); }（扩展重载成功路径）',
      'refactor/apps/ui/app.js:5054 es.addEventListener(\'plugins-reloaded\', schedulePluginMenuRefresh)',
      '端到端读数：.tmp-dispatch/2026-10-14/mimo2/r-桥表两条与记忆前沿.md（真 HTTP+真 SSE，含断线补取）'
    ]
  },
  {
    ui: 'memory-update',
    // ★ 2026-10-15 luna2 由 not-ported 改成 bridged；同日按复核 aaf16f9c 回修 A/B/C（start 改到真开跑前、短码收紧、手工点加真变更门）。
    status: 'bridged',
    source: '装配层 coordinator 事件壳 · apps/server/assembly.js:379-419 wireMemoryUpdateEvents（runNextJob 包壳 peek 下一个 queued → :395 start；'
      + '终态 :403 done / :406 error）＋ 手工修改真落账点 · apps/server/api/memory.js:427/535/460/841/374/332/408',
    payload: '{phase, chatKey}（consolidate-start/done/error；error 只放行机器码形状的短码，≤40，其余折叠成 "failed"）· '
      + '手工修改帧 = {phase:"refresh"} —— 不含正文/名字/印象内容/userId；桥对对象载荷加 source:"memory-update"（与 ⑥b 同口径）',
    evidence: [
      'refactor/apps/server/assembly.js:386-395 nextQueued + 开跑前 emit「consolidate-start」——排队/忙碌/空队列不发（复核 B：排队≠整理中；merged 语义随之消失）',
      'refactor/apps/server/assembly.js:397-418 终态：done :403 / failed|unconsolidated :406-408（chatKey 由 jobId 反查 status()；重试中的 queued 不发终态、下轮重发 start 幂等；busy 预告过 start 时 :415 记一行）',
      'refactor/apps/server/assembly.js:371-378 shortMemoryErrorCode：冒号前取段 + 只放行 /^[A-Za-z0-9_-]+$/（≤40）——没有冒号的 reason 也折叠（复核 C/D，模型输出片段一律不进 SSE）',
      'refactor/apps/server/api/memory.js:113-120 emitMemoryUpdate（只在真改动落账后调；缺 ctx.emit 时照 api/media.js:373-378 告警一行）',
      'refactor/apps/server/api/memory.js:841 删语义卡（ok && retracted>0 才发，复核 A）/ :408 改印象（applied 有增删改或真改名才发，复核 C）/ :427 删成员 / :535 删无号壳 / :460 清短期（removed=1）/ :374 重新记住（reinstated=true）/ :332 共享授权',
      'refactor/apps/ui/app.js:5308-5352 三档 phase + 兜底 loadMemoryView（state.consolidating 的置位/清除都在这）',
      '旧树口径（只读）：src/app.js:3276-3295 consolidate-all 三帧 / :3453-3459 按人整理 / :3327-3366 人物改名·改·删',
      '★ 自动整理那半**没有改** orchestrator：它的 getCoordinator() 读 modules.__memoryCoordinator'
        + '（modules/orchestrator/index.js:355-365），拿到的就是被本壳包过的同一实例',
      '★ 免发纪律（HTTP 200 ≠ 真变更）：语义卡 retracted=0 · 改印象空提交 · removed=0 · reinstated=false · 一键清理（盘点不删东西，契约-一键清理.md）——都不发帧'
    ]
  },
  {
    ui: 'sticker-annotate',
    // ★ A3（2026-10-11 mimo3）由 not-ported 改成 bridged：**两端同票落地**——
    //   ① 生产者到 bus：装配层 ctx 补 `emit: obs.emit` ⇒ api/media.js:373 的提取不再 no-op
    //      （缺失时 console.warn，不再静默）；
    //   ② 桥订阅 + 白名单：STICKER_BUS_TO_UI 进 ACTIVE 并集 ⇒ BRIDGED_UI_NAMES 派生自动放行。
    status: 'bridged',
    evidence: [
      'refactor/modules/media/sticker-manager.js:304 emit(\'sticker-annotate\', { phase: \'start\', total, engine: \'primary-vision\' })',
      'refactor/apps/server/api/media.js:373 const emit = typeof ctx?.emit === \'function\' ? ctx.emit : () => {}（缺失时 console.warn）',
      'refactor/apps/server/assembly.js ctx 返回块 `emit: obs.emit`（A3 补键）',
      '端到端读数：refactor/tools/进度帧验收.mjs 改前 0 帧 → 改后 start/progress/done 到达'
    ]
  },
  {
    ui: 'feedback',
    status: 'bridged',
    // ★ N57（2026-10-09）由 not-ported 改成 bridged：**生产者落地了**。
    //   act 的 `report_feedback` 执行器（qwen1 N35 接通）现在会
    //   `observability.emit('feedback', {chatKey, level, message, at})` —— observability 的 emit
    //   就是 core/bus 的 emit（index.js:423-424 原样再导出），与桥订阅的是同一条 bus。
    //   ⇒ 把 bus 名 `feedback` → UI 名 `feedback` 加进 `TOOL_BUS_TO_UI`，桥就真能转发。
    // 载荷差异（如实记）：旧树带 `sessionId`（src/tools.js:2587），新树执行器发
    //   `{chatKey, level, message, at}`，**无 sessionId**；UI handler（app.js:5002-5005）
    //   只读 level/message ⇒ 现在不影响，但别当成"字段全等"。
    source: 'act report_feedback 执行器 · modules/act/executors/messaging.js:187-189 `observability.emit(\'feedback\', …)`',
    payload: '{chatKey, level, message, at} + source:"feedback"（UI handler app.js:5002 只读 level/message）',
    evidence: [
      'refactor/modules/act/executors/messaging.js:187-189 obs.emit(\'feedback\', { chatKey, level, message, at })',
      'refactor/core/observability/index.js:423-424 `export { on, once, off, emit, … }`（再导出 core/bus 的同一条总线）',
      'refactor/apps/server/index.js:157 createSseBridge({ hub: sseHub, obs: ctx.obs, log }) ← 与 act 侧同一个 obs',
      'refactor/apps/server/index.js:199 modulesObj.observability = ctx.obs（执行器拿到的就是它）',
      'refactor/apps/ui/app.js:5002-5005 es.addEventListener(\'feedback\', (ev) => { const d = JSON.parse(ev.data); if (d.level === \'error\') console.warn(…) })',
      'src/tools.js:2587 （只读，老树口径）ctx.emit(\'feedback\', { sessionId, chatKey, level, message })'
    ]
  },
  {
    ui: 'session-start',
    status: 'bridged',
    source: "编排层会话创建点 · modules/orchestrator/index.js::577` 创建单例 emitSessionFrame(run, 'session:started')（在 registry.create() 返回之后立刻发）",
    payload: '{sessionId, chatKey, status(=running), startedAt} + guarded 三键（深度≤6 才带）+ 收尾四键不在这一帧带；契约见 SESSION_FRAME_CONTRACT.started',
    evidence: [
      "refactor/modules/orchestrator/index.js::577` 创建单例 emitSessionFrame(run, 'session:started')",
      "refactor/modules/orchestrator/index.js::577` 创建单例-867 const created = sessionRegistry.create({chatKey, trigger, triggerSummary, status:''running''}) → run.sessionId = String(created?.session?.id ?? '')",
      'refactor/modules/orchestrator/index.js::577` 创建单例-133 sessionFramePayload / emitSessionFrame（peek 拿不到就不发；深度闸在 guarded 三键上；bus 从 run 上取）',
      'refactor/apps/ui/app.js:4692-4695 session-start handler **不读载荷**（只 scheduleSessionEventRefresh({autoFollow:true}) + refreshStatus）'
    ],
    group: 'session-*',
    contract: 'SESSION_FRAME_CONTRACT.started'
  },
  {
    ui: 'session-update',
    status: 'bridged',
    source: "编排层「正文进会话」点 · modules/orchestrator/index.js::577` 创建单例 emitSessionFrame(run, 'session:updated')（appendMessage 写成功之后，按会话节流 1.2s）",
    payload: '必给 11 个标量 + guarded 3 键（turnPlan/turnTrace/messages，深度>6 就不发）+ 收尾四键只在本帧之后的 ended 帧带',
    evidence: [
      "refactor/modules/orchestrator/index.js::577` 创建单例 emitSessionFrame(run, 'session:updated')",
      'refactor/apps/ui/app.js:4696-4732 session-update handler：:4699-4700 sessionId 缺失直接 return；:4702-4716 逐字段 merge；:4719-4722 收尾字段只认 patch；:4727 另读 data.trigger',
      "实测 redact 深度（.tmp-dispatch/_s4-redact.txt）：盘上真形状 turnTrace 深度 3 / messages 深度 2 完好；深度 34 的合成形状被截断并注入 9+18 个 '[redacted]' ⇒ 生产者侧深度闸（≤6）"
    ],
    group: 'session-*',
    contract: 'SESSION_FRAME_CONTRACT.updated'
  },
  {
    ui: 'session-end',
    status: 'bridged',
    source: "编排层收尾点 · modules/orchestrator/index.js::577` 创建单例 emitSessionFrame(run, 'session:ended', {closing:true})（在 registry.finish() 写盘之后）",
    payload: '{sessionId, chatKey, status} + guarded 3 键 + 收尾四键（sent/finishReason/error/endedAt，只在有值时带）',
    evidence: [
      'refactor/modules/orchestrator/index.js::577` 创建单例-351 registry.finish?.(run.sessionId, run.finish.status) 之后立刻 emitSessionFrame(..., {closing:true})',
      'refactor/apps/ui/app.js:4743-4747 const id = data.sessionId; if (id && id === state.currentSessionId) { pendingSessionDetail.delete(id); loadSessionDetail(id, {quiet:true}); } ⇒ 假 id 会清掉别人的详情'
    ],
    group: 'session-*',
    contract: 'SESSION_FRAME_CONTRACT.ended'
  },
  {
    ui: 'snowluma-status',
    status: 'bridged',
    source: 'modules/snowluma/index.js:392/:409/:413 内嵌启动确认/不确定/退出 emit（老树 src/app.js:541/:546 同位）· 第 6 张表 SNOWLUMA_BUS_TO_UI 同名直通',
    payload: '{running, embedded, pid}（老树同形）；UI handler app.js:5175 不读载荷，只刷状态与雪云马页',
    evidence: [
      'refactor/modules/snowluma/index.js:392 emit(\'snowluma-status\', {running:false,…}) ← 子进程 exit',
      'refactor/modules/snowluma/index.js:409/:413 emit(\'snowluma-status\', {running:true, embedded:true, pid}) ← 内嵌 spawn 确认/无 error 超时两路',
      'refactor/apps/ui/app.js:5175 es.addEventListener(\'snowluma-status\', () => { refreshStatus(); … })',
      '端到端读数：.tmp-dispatch/2026-10-13/mimo3/r-雪云马总线事件.md（真 HTTP+真 SSE，含断线 30 秒补取）'
    ]
  },
  {
    ui: 'snowluma-log',
    status: 'bridged',
    source: 'modules/snowluma/index.js:258 pushLog 逐行 emit（老树 src/app.js:476 同位）· 第 6 张表 SNOWLUMA_BUS_TO_UI 同名直通',
    payload: '{at, stream, text}（= 环形行原样；UI handler app.js:5176-5183 读 d.text）',
    evidence: [
      'refactor/modules/snowluma/index.js:258 emit(\'snowluma-log\', line) ← pushLog 环形落账之后',
      'src/app.js:476 emit(\'snowluma-log\', line)（老树同位，只读引用）',
      'refactor/apps/ui/app.js:5176-5183 snowluma-log handler：JSON.parse(ev.data) 后读 d.text 刷 loading/日志页',
      '端到端读数：.tmp-dispatch/2026-10-13/mimo3/r-雪云马总线事件.md（真 HTTP+真 SSE，含断线 30 秒补取）'
    ]
  }
];

/**
 * ★★ 票 S-4（2026-10-07）：`session-*` 三帧的**真·未接原因**（下面那三行的 `reason` 已按这份清单改写）
 *
 * 主人症状：「预输出的时候没有卡出现，只有发言完后才会出现会话卡片」。
 *
 * ## 一、上一版那句"新树没有会话注册表"**已过期**（留着会误导下一个人）
 *   会话注册表**早就在**：`modules/sessions/index.js:457 createSessionRegistry` 已导出，
 *   `apps/server/assembly.js` 的"必须存在"清单里列着它，`modules/orchestrator/index.js::577` 创建单例` 真在创建单例，
 *   `:757-761` 每回合一开始 `create({chatKey, trigger, status:'running'})` 并把真 id 存进 `run.sessionId`，
 *   `writeFinish` 里 `:244 update` / `:247 finish` 都在。
 *
 * ## 二、现在真正的缺口（两件，都不在本文件）
 *   ① **编排层从没发过 `session-*`**：`modules/orchestrator/index.js` 的全部 `emit(bus, …)` 站点是
 *      `:628 receipt:confirmed` · `:671 evidence:built` · `:776 context:retrieved` · `:819 plan:decided`
 *      · `:821 verdict:issued` · `:987 observation:committed` · `:1141/:1159 wake:suppressed`
 *      · `:1142/:1161 plan:decided`(skip 档) —— **零个 `session-*`**。
 *      （`core/observability/bus.js:32 emit` 不校验事件名 ⇒ 加名字不需要动 `assembly.js:499-503` 的冻结清单，
 *        但冻结清单里没有 ⇒ 这几个 kind 也不会进观测账本的 echo，那是另一笔账，见 §五。）
 *   ② **UI merge 清单要的字段是"整套"**（见下方 `SESSION_FRAME_CONTRACT`），少一个键就会把卡片写坏
 *      （`rounds` 缺失 ⇒ `|| 0` ⇒ 卡片显示"0 轮"这种**假话**）。
 *
 * ## 三、`SESSION_FRAME_CONTRACT`：编排层要按这份清单发（本文件只声明，不实现）
 *   时机（三个点，一个字都不能挪到写盘之后）：
 *     · `session:started` —— `create()` **返回之后立刻**（`orchestrator/index.js::577` 创建单例-761` 那一块）；
 *       此时会话文件还没落盘，UI 靠这一帧先建卡片。
 *     · `session:updated` —— **有实质进展时**（默认只发：`markActivity` 有新文案、usage 变了、轮数变了）；
 *       票面明令**别刷屏**：没有节流的逐事件 emit 会把 SSE 打满。
 *     · `session:ended` —— `finish()` **写盘之后**（`orchestrator/index.js::577` 创建单例` 那一块）。
 *
 * ## 四、为什么现在**不**把三个名字搬进 `BUS_TO_UI`（"看得见 + 不编"）
 *   · bus 名字自由（`bus.js:32`），但**搬进去就等于对外声称"这条有真生产者"** —— 今天它一个帧都不会有。
 *     本文件顶部纪律：没有真来源 ⇒ 整条 not-ported。搬进去会把这条纪律变成"看起来接好了"。
 *   · 现有尺子也会当场顶红，且**要改别人拥有的测试文件**才能过：
 *     `sse.selftest.mjs:213` 要求 `BUS_TO_UI` 的每个键在 `BUS_PRODUCERS` 里有**带真行号**的字符串；
 *     `:228-230` 要求 `NOT_PORTED` 与"已 bridged 的名字集合"**不相交**。
 *     ⇒ 装弹（arm）的动作 = 编排层 emit 落地之后，把三个名字搬进 `BUS_TO_UI` + 在 `BUS_PRODUCERS`
 *     填**那个 emit 的真行号**。搬完 `BRIDGED_UI_NAMES` 跟着长，`apps/server/index.js:156` 的
 *     `allowedNames: BRIDGED_UI_NAMES` 自动放行帧注入（不用改第三个文件）。
 *
 * ## 五、装弹时要注意的一处真实限制
 *   `apps/server/sse.js:44-52 redact()` 的深度上限 `MAX_DEPTH = 8` ⇒ `turnTrace` / `messages` 里
 *   嵌套太深的对象会被替换成 `"[redacted]"`。装弹后第一件事就是核这条（现在没数据可核 ⇒ 记为待验）。
 */

/**
 * 已装弹（2026-10-07）：三个名字都已进 `BUS_TO_UI`，这里保留成**空表 + 装弹记录**，
 * 让"曾经 pending 过"这件事留在代码里（下一个动会话帧的人能看见这一步的历史）。
 * 新增映射时照样先写这里、再连同 `BUS_PRODUCERS` 的真行号一起搬进 `BUS_TO_UI`。
 */
export const PENDING_BUS_TO_UI = Object.freeze({});

/** 会话帧载荷契约：**必给**的键来自 UI 的逐字段 merge 清单，一个都不能少（缺 `rounds` 会显示"0 轮"这种假话）。 */
export const SESSION_FRAME_CONTRACT = Object.freeze({
  idRule: 'payload.sessionId 必须是 registry.create() 返回的那个真 id（UI 在 session-end 里会 pendingSessionDetail.delete(id) 再拉详情 ⇒ 假 id 会清掉别人的详情）。',
  started: {
    bus: 'session:started',
    ui: 'session-start',
    when: 'create() 返回之后立刻（会话文件尚未落盘）',
    // UI 的 handler（app.js:4692-4695）其实**一行载荷都不读**（只触发刷新 + autoFollow）；
    // 这里仍然要求带真 id 与四个基本字段：① 帧本身可自证 ② 将来 handler 要读时有据 ③ 牙 2 要断言 status==='running'。
    required: ['sessionId', 'chatKey', 'status', 'startedAt'],
    niceToHave: ['triggerSummary', 'activity', 'rounds', 'usage'],
    status: 'running'
  },
  updated: {
    bus: 'session:updated',
    ui: 'session-update',
    when: '有实质进展时（正文进会话 / usage 或轮数变化）；生产者侧按会话节流 1.2s（编排层 SESSION_FRAME_UPDATE_MIN_GAP_MS）',
    // 标量必给：全部来自 app.js:4702-4716 + :4727 的 merge 清单
    required: ['sessionId', 'chatKey', 'status', 'waitUntil', 'activity', 'webSearchCount', 'rounds',
      'usage', 'triggerSummary', 'startedAt', 'trigger'],
    // ★ 深度闸键：UI 确实读这三个（`|| []` / `?? null`），但它们**可能过不了 SSE 脱敏** ——
    //   `apps/server/sse.js:36-52 redact()` 在 `depth > MAX_DEPTH(8)` 处换成**字符串** `"[redacted]"`，
    //   而 UI 是逐字段 merge ⇒ 把字符串并进对象字段 = 把好数据写坏。实测（`.tmp-dispatch/_s4-redact.txt`）：
    //   盘上真形状 turnTrace 深度 3 / messages 深度 2 完好；深度 34 的合成形状被截断并注入 9+18 个
    //   `"[redacted]"`。⇒ 生产者只在深度 ≤ 6 时带这三个键，**否则整个键不发**（UI 的 `?? null` / `|| []` 会兜底）。
    //   姿态：**宁可少发三个键，也不许往 UI 状态里写坏值。**
    guarded: ['turnPlan', 'turnTrace', 'messages'],
    guardedMaxDepth: 6,
    // 收尾字段：**给了才进 patch**（app.js:4719-4722；无脑写 null 会把已有值冲掉）
    conditional: ['sent', 'finishReason', 'error', 'endedAt']
  },
  ended: {
    bus: 'session:ended',
    ui: 'session-end',
    when: 'finish() 写盘之后（生产者侧：peek 落空时退回 get() 读刚写下去的那份文件）',
    // UI 只用 sessionId（比对 currentSessionId 后丢弃残留 patch 并重拉详情），其余是"顺带如实带上"
    required: ['sessionId', 'chatKey', 'status'],
    guarded: ['turnPlan', 'turnTrace', 'messages'],
    guardedMaxDepth: 6,
    conditional: ['finishReason', 'error', 'sent', 'endedAt']
  }
});

/** UI 事件名全集里、桥上仍是 not-ported 的名字（便捷读数；装弹后不含 session-*）。 */
export const NOT_PORTED = BRIDGE_ROWS.filter((r) => r.status === 'not-ported').map((r) => r.ui);

/** bus 事件名 → 该事件在盘上的真实生产者（行号），供回执与复核者核对。 */
export const BUS_PRODUCERS = {
  'evidence:built': 'modules/orchestrator/index.js:777',
  'context:retrieved': 'modules/orchestrator/index.js:885',
  'plan:decided': 'modules/orchestrator/index.js:928',
  'verdict:issued': 'modules/orchestrator/index.js:930',
  'receipt:confirmed': 'modules/orchestrator/index.js:734',
  'observation:committed': 'modules/orchestrator/index.js:1096',
  // 冻结清单里有、但**零生产者** —— 所以它们不在 BUS_TO_UI 里，发它们必须零帧（反向对照就用这个）
  'config:changed': 'refactor/apps/server/assembly.js:858',
  'plugins-reloaded': 'refactor/apps/server/assembly.js:868',
  'extension:loaded': null,
  'extension:reloaded': null,
  // ★ N57：这一条从 null 变成**真生产者**（act report_feedback 执行器 + qwen1 N35 接通）。
  //   与 `session:*` 三帧同一个性质：桥订它，它就真会有帧。
  'feedback': 'modules/act/executors/messaging.js:187',
  // ★ S-4：这三个从 `null` 变成**真生产者**（编排层 emit 已落地，2026-10-07 装弹）
  'session:started': 'modules/orchestrator/index.js:871',
  'session:updated': 'modules/orchestrator/index.js:600',
  'session:ended': 'modules/orchestrator/index.js:351',
  // ★ A3：真生产者（sticker-manager annotateMissing 的 start/progress 帧 + api/media 的 done/error 帧）
  'sticker-annotate': 'modules/media/sticker-manager.js:304',
  // ★ 裁甲：同名直通的**两个**真生产者（旧树"列表变了去重拉"语义）
  //   标注完成 media.js:382 · mark-read console.js:453（mimo2 1a31193）
  'chat-update': 'apps/server/api/media.js:382 + api/console.js:453',
  // ★ S3 另一半（2026-10-14 mimo3）：SnowLuma 两个同名直通的真生产者（第 6 张表 SNOWLUMA_BUS_TO_UI）
  'snowluma-status': 'modules/snowluma/index.js:392 + :409 + :413',
  'snowluma-log': 'modules/snowluma/index.js:258',
  // ★ 记忆页实时刷新（第 8 张表 MEMORY_BUS_TO_UI）：装配层 coordinator 事件壳 + api/memory.js 手工修改真落账点
  'memory-update': 'apps/server/assembly.js:395 + api/memory.js:408',
};

/**
 * 创建桥。
 *
 * @param {object} opts
 * @param {{broadcast: Function, count: Function}} opts.hub - sse.js 的中枢
 * @param {{on: Function}} opts.obs - core/observability（`.on(kind, fn)` 返回退订函数）
 * @param {(msg: string, extra?: object) => void} [opts.log]
 * @returns {{
 *   start: (opts?: {onebot?: object}) => void,
 *   stop: () => void,
 *   rows: typeof BRIDGE_ROWS,
 *   stats: () => object,
 *   publishOnebotStatus: (st: object) => object
 * }}
 */
export function createSseBridge({ hub, obs, log = () => {} } = {}) {
  const offs = [];
  let started = false;
  let onebotOff = null;
  /** onebot 状态的"上一次值"—— 边沿触发的核心：同值重发一律吞掉。 */
  let lastOnebotKey = null;
  const counters = { busFrames: 0, onebotFrames: 0, onebotSwallowed: 0, unmappedEmits: 0 };

  function say(msg, extra) { try { log(`[sse-bridge] ${msg}`, extra ?? {}); } catch { /* 日志不许反噬 */ } }

  /**
   * 订阅 bus。**只订映射表里那几条** —— 没在表里的 bus 事件名一律不碰，
   * 这就是"反向对照必须零帧"的根据：我们不监听它，就不可能凭空发它。
   */
  function start({ onebot = null } = {}) {
    if (started) return;
    started = true;

    for (const [busName, uiName] of Object.entries(ACTIVE_BUS_TO_UI)) {
      const off = obs?.on?.(busName, (payload) => {
        try {
          // 载荷 = 真实 bus 载荷 + `source`（哪个 bus 事件）。脱敏在 hub.broadcast 里做。
          const body = (payload && typeof payload === 'object') ? { ...payload, source: busName } : { source: busName };
          hub.broadcast(uiName, body);
          counters.busFrames += 1;
        } catch (e) {
          // bus 本身已做失败隔离（core/bus.js:44-49），这里再兜一层是防 hub 被换掉时炸主链
          say(`bus ${busName} → ${uiName} 转发失败：${e?.message ?? e}`);
        }
      });
      if (typeof off === 'function') offs.push(off);
    }

    // onebot 状态：边沿触发，且**只在 client 已存在时**订阅（onebot-link 的 client 是 start() 后才有的）
    if (onebot?.client?.onStatus) {
      try {
        onebotOff = onebot.client.onStatus((st) => publishOnebotStatus(st));
      } catch (e) {
        say(`订阅 onebot 状态失败：${e?.message ?? e}`);
        onebotOff = null;
      }
    }

    say(`已启动：订阅 ${Object.keys(BUS_TO_UI).length} 条 bus 事件 → ${BRIDGED_UI_NAMES.length} 个 UI 事件名`
      + `；onebot 边沿触发=${onebotOff ? 'on' : 'off'}`);
  }

  /**
   * 边沿触发的 onebot 状态。同值重发吞掉（这正是"绝不发假装还活着"的实现点）。
   * @returns {{sent: boolean, reason?: string}}
   */
  function publishOnebotStatus(st) {
    const body = (st && typeof st === 'object') ? { ...st } : { connected: Boolean(st) };
    let key;
    try { key = JSON.stringify([body.connected ?? null, body.everConnected ?? null, body.error ?? null]); }
    catch { key = String(body.connected); }
    if (key === lastOnebotKey) {
      counters.onebotSwallowed += 1;
      return { sent: false, reason: 'unchanged（边沿触发：同值不发）' };
    }
    lastOnebotKey = key;
    try {
      hub.broadcast('onebot-status', body);
      counters.onebotFrames += 1;
      return { sent: true };
    } catch (e) {
      say(`onebot 状态转发失败：${e?.message ?? e}`);
      return { sent: false, reason: 'broadcast-threw' };
    }
  }

  /** 退订全部。幂等。 */
  function stop() {
    for (const off of offs) { try { off(); } catch { /* ignore */ } }
    offs.length = 0;
    if (onebotOff) { try { onebotOff(); } catch { /* ignore */ } onebotOff = null; }
    started = false;
    lastOnebotKey = null;
  }

  return {
    start,
    stop,
    rows: BRIDGE_ROWS,
    notPorted: NOT_PORTED,
    publishOnebotStatus,
    stats: () => ({
      started,
      subscriptions: offs.length,
      busMapped: Object.keys(ACTIVE_BUS_TO_UI).length,
      sessionMapped: Object.keys(SESSION_BUS_TO_UI).length,
      busProducersMissing: Object.entries(BUS_PRODUCERS).filter(([, v]) => !v).map(([k]) => k),
      bridgedUiNames: [...BRIDGED_UI_NAMES],
      notPorted: [...NOT_PORTED],
      // ★ 票 S-4：待装弹的会话帧（契约已定、生产者未接）。显式报出来，不许藏在注释里。
      pendingSessionFrames: Object.entries(PENDING_BUS_TO_UI).map(([busName, uiName]) => ({ busName, uiName, armed: false })),
      onebotEdgeArmed: !!onebotOff,
      onebotLastKey: lastOnebotKey,
      // ★ 本桥**不起任何定时器**：没有"周期性假装还活着"的帧。计数恒为 0 就是这条不变量。
      timers: 0,
      ...counters
    })
  };
}
