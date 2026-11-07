# QQ-Agent · 模块化重构（`refactor/`）

> **本目录是新写的另一套，旁边那套（`src/` `ui/` `electron/`）继续跑线上，不许碰。**
> 本文件是**唯一真相源**：模块边界 + 冻结接口 + 分工。任何实现与本文件冲突时，**改实现或先改本文件**（改本文件要走指挥位）。

---

## 0. 铁律（违反即返工）

1. **只写本目录**：`refactor/**`。**绝不改** `src/`、`ui/`、`electron/`、`plugins/`、`skills/`、`data/`、`data-2/`。
2. **不读也不写 `data/**`**（真实聊天）。**测试数据与临时产物一律写系统临时目录**：`fs.mkdtempSync(path.join(os.tmpdir(), '<模块名>-'))`，用完自己删自己那一个。
   - **★ 2026-10-04 20:xx 事故后改的（原为"跑测试用 `.tmp-refactor/`"）**：六个模块的残留挤在**同一个**仓库内目录里，一个模块清理时用 `Remove-Item -Recurse` 把**别人的验证脚本一起删了**。
   - ⇒ **不许在仓库内建 `.tmp-refactor/`**（已退役）；**`refactor/**` 里不许留任何测试残留**（日志/输出/探针都不行）；**清理只许删自己创建的那个临时目录**，**任何情况下不许 `-Recurse` 删共享路径**。
3. **一个文件同一时刻只有一个写者**（跨 agent 也一样）。
4. **依赖只允许向下**：`apps → modules/* → core/* → contracts/`。模块之间**只能**通过 `contracts/` 的数据结构 + `core/bus` 的事件通信，**不许 import 别人的内部文件**。
   - **例外（只限第 1/2 批的「搬」模块）**：搬运保真优先，允许 `import { … } from '../<name>/index.js'`（**公开出口，不是内部文件**）。这些跨模块直连**已登记为债**，第 3 批用适配器 / `core/bus` 收口；**必须导出**的名字清单见 **§3.5**。
5. **决定权唯一**：一轮消息只在一个地方被决定"回/不回"。Jev **不再**是串联否决器，只提供证据不足时的候选信号。
6. **没回执不算发过**：任何"已发送/已收藏/已写入"的判定必须以平台回执或工具结果为准。
7. **每个模块自带验证**：`node --check` + 一个 `selftest.mjs`（喂合成输入，断言输出形状与不变量）。**没有自测的模块不算交付**。
   - **自测 harness 必须"收全部红项、末尾按失败数决定 EXIT"**：遇错即中止的写法会**掩盖后面的红**（实测：一次只暴露一条，看的人以为只坏了一处 —— M2 的席位就因此把"首红"归因错了，被复核者抓出）。
   - **判红要判"首红是谁"**：报告里写"改了 X 会红"时，**必须真跑一次并抄下第一处红的原文**，不许写"我以为会红的那条"。
   - **测试临时产物一律写 `os.tmpdir()`**（`fs.mkdtempSync(path.join(os.tmpdir(), '<模块名>-'))`），`refactor/**` 里零残留。

---

## 1. 目标流水线（A→F，每轮消息只走这一条）

```
A scenario  还原事实：谁对谁、引用谁、图里是谁、机器人说过什么  → MessageEvidence（不可改写）
B memory    取回状态：本轮窗口 + 当前话题 + 相关人物/待办        → Context（带证据 ID）
C plan      形成行动意图：reply|continue|wait|skip|ask|tool      → ActionPlan（唯一决定点）
D vetd      按后果校验：硬规则管权限/范围/频率；Jev 只给候选信号  → Verdict（可解释、可追溯）
E act       生成/发送/核验：以回执为准                          → SendReceipt
F commit    更新状态与记忆：后台抽取、幂等、证据可回溯            → MemoryObservation
```

**语义要点**：A 只还原事实不推断人格；B 的过滤发生在检索前；**直接 @ / 明确提问 / 未完成承诺不走"主动意愿"闸**；F 里"模型说出来"≠事实。

---

## 2. 模块表（16 个）

| # | 目录 | 职责 | 来源 |
|---|---|---|---|
| M0 | `contracts/` | 数据结构 + 校验 + 版本。**零依赖** | 新写（从现有用法归纳） |
| M1 | `core/config-store/` | 配置默认值/迁移/有效值来源（全局 vs 群覆盖）、存储、实例锁 | 搬 `config.js` `store.js` `sessions.js` `instance-lock.js` |
| M2 | `core/observability/` | span/trace、阶段计时、三类账本、日志 | 搬 `turn-trace` `decision-ledger` `usage-ledger` `phase-timer` `jev-observer` `logger` |
| M3 | `modules/platform/` | 协议端接入、发送、回执、失败恢复 | **搬** `onebot` `sender` `send-recovery` `reply-recovery` `salvage` |
| M4 | `modules/llm/` | 云端模型、流式、重试、缓存标记、价格 | **搬** `llm` `providers` `model-prices` `cache-keepalive` |
| M5 | `modules/scenario/` | 阶段 A | **重写**（从 `orchestrator` 拆） |
| M6 | `modules/memory/` | 阶段 B/F：证据账本 + 视图（人物/群/近况/待办/语义卡） | **重写**（`memory.js` + `conversation-memory/*` 作参考） |
| M7 | `modules/emotion/` | 情绪/精力/好感/关系的**纯状态模型**（不决定说不说话） | **重写**（参考 `bot-state` `emotion-*`） |
| M8 | `modules/plan/` | 阶段 C：**唯一决定点** `decide()` | **重写**（参考 `prompt*` `personas`） |
| **M8b** | `modules/prompt/` | **提示词与人设组装**（原定"塞在 M8 里"，2026-10-04 20:xx 独立成模块：它有自己的依赖面 —— 人设卡/记忆视图/配置，与 `decide()` 的纯函数性互相拉扯） | **搬 + 改边界**（`src/prompt*` `personas.js` `persona-two.js`；**不许照搬 146 KB 全文**，见派单） |
| M9 | `modules/jev/` | 阶段 D 的受限校验方 | **重写**（参考 `local-jev` `local-reply-policy`） |
| M10 | `modules/act/` | 阶段 E：工具执行 + 发送核验 | **重写**（`tools.js` 拆） |
| M11 | `modules/media/` | 表情/图片/视频/视觉 | 搬 + 改边界（`stickers*` `vision-*` `image-*` `memes`） |
| M12 | `modules/extensions/` | 插件/技能加载与桥 | **搬** `plugin-loader` `skills/*` `skill-bridge` |
| M13 | `apps/` | 桌面端入口 + UI + 桌宠 | **搬** `electron/*` `ui/*` |
| M14 | `modules/internet/` | 外部查询（搜索/百科/B站/资讯/价格） | **搬** `web-search` `wiki` `bilibili` `api-news` `price-feed` `safe-fetch` |
| **M15** | `modules/orchestrator/` | **运行时与调度**：唤醒/并发、收尾状态机、退化断路器、定时循环、控制接口。**A→F 的调用序列在这里实现**（装配层只做 IO/接线，见 §3.7/§3.8） | **重写**（从 `orchestrator` 拆；段落级盘点见 `.tmp-dispatch/r-refactor-assembly-recon.md` E2） |

**"搬"= 复制实现 + 改 import 路径 + 适配新合同（不改行为、不改内部逻辑）。"重写"= 只保留行为意图，代码新写。**

**`core/util/`（不在 15 个模块里）**：无状态工具函数的收容所 —— `util.js`（`src/util.js`）+ `md-to-plain.js`（`src/md-to-plain.js`）搬运，公开出口 `core/util/index.js`，**零内部依赖**（只用 `node:fs` `node:path`）。**第 1 批由 M3 附带交付**（它是唯一消费者，且卡着 `platform/index.js` 起不来）。

---

## 3. 冻结接口（**先实现这些，别人都在等**）

### 3.1 `contracts/`（M0）
```js
// 全部是纯数据 + 校验函数；不许 import 任何东西（除 node: 内置）
export const SCHEMA_VERSION = 1;

// A 阶段产出：一条不可改写的消息证据
MessageEvidence = {
  id, at, chatKey, kind: 'group'|'private', selfId,
  sender: { id, name },                       // 谁发的
  text,                                        // 规范化后的正文（原文不改写）
  mentions: [{ id, name, isSelf }],            // 谁被点了名
  refs: { toSelf, quoted: null|{ id, sender, text }, replyTo },
  media: [{ type: 'image'|'sticker'|'video', id, desc?, ocr? }],
  botSaidBefore: [{ id, text, at }]            // 最近几轮机器人自己说过的话（有回执的）
}

// C 阶段产出：唯一决定点的结构化意图
ActionPlan = {
  action: 'reply'|'continue'|'wait'|'skip'|'ask'|'tool',
  reason: string,                              // 机器可读的原因码 + 人话
  recipient: string,                           // 收件人（chatKey 或 userId；未定用空串）
  topic: string,                               // 话题标签（可为空串）
  purpose: string,                             // 这一轮想干什么（可为空串）
  memoryRefs: [evidenceId],
  toolPlan: [{ name, args, sideEffect: 'read'|'write' }],
  urgency: number,                             // 0..1（M0 校验与 M10 预算都用它）
  by: 'rule'|'llm'|'jev'
}

// D 阶段：校验结论（可解释、可追溯；**不是**又一个黑箱分数）
Verdict = { allow: boolean, blockedBy: null|string, signals: [{ from:'jev'|'rule', role?, label?, p?, margin? }] }

SendReceipt = { ok: boolean, platformId?, at, error?, idempotencyKey }
IdempotencyKey = `${chatKey}:${evidenceId}:${action}`        // 重试/重复回调必须幂等
MemoryObservation = { id, subjectId, claim, evidenceIds:[...], scope:'group'|'private'|'global', confidence, at, supersedes? }
```
**校验函数**：`validateMessageEvidence/…Plan/…Verdict/…Receipt(x)` → `{ ok, errors[] }`，非法即抛/返回错误，**不许静默放过**。
**自带**：`contracts/selftest.mjs` 覆盖每种结构的**合法 + 非法**样例（非法必须被拒）。

### 3.2 `core/config-store/`（M1）
```js
export function load({ dataDir })                       // 读盘 + 迁移 + 默认值合并
export function get(keyPath, fallback)                  // 点路径读（'localJev.roles'）
export function effective(keyPath, { chatKey, kind })    // 有效值 + 来源：覆盖 > 全局 > 默认
export function sourceOf(keyPath, { chatKey, kind })     // 'chat'|'global'|'default'  ← UI 排障要用
export function set(keyPath, value, { scope:'chat'|'global', chatKey })  // 留痕
export function snapshot()                               // 只读快照（给 trace/UI）
```
**不变量**：**任何模块都不许自己 deepMerge 配置**；一律走 `effective()`。

**兼容别名（搬运层在用，必须一起导出）**：`getConfig()` / `updateConfig(patch)` / `DATA_DIR` / `DEFAULT_CONFIG` / `subscribeConfigChange(fn)`。
**参数形态（冻结，别再猜）**：
- `get()` **无参** → 返回**活配置对象**（旧 `getConfig()` 语义，调用点会就地读它）；`get('a.b', fallback)` → 点路径读。
- `snapshot()` → **深拷贝**（给 trace/UI 读，改它不影响配置）。`get()` 与 `snapshot()` **不许互相顶替**。
- `set(keyPath, value, {scope, chatKey})` → 点路径写。
- `set(patch)` / `set(patch, undefined)` → **单参数且是纯对象 = 整块 patch 深合并**（旧 `updateConfig(patch)` 语义：深合并 + 落盘 + 发布）。`updateConfig(patch)` 是它的显式别名。
  ⇒ 即 `set` **双形态**，两种都必须支持；旧调用点 `import { set as updateConfig }` / `import { get as getConfig }` 一律**不用改**。

### 3.3 `core/observability/`（M2）
```js
export function span(name, fields)      // 返回 { end(extra) }；用于首字延迟分段
export function event(kind, fields)     // 结构化事件（trace 行）
export function ledger(name, row)       // 追加账本：'decision'|'usage'|'jev'|'send'
export function recent({ name, n })     // 只读查看（UI/排障）
export function log(level, msg, fields) // 日志（不写正文）
```
**不变量**：账本行**不含聊天正文原文**；每个 span 必带 `chatKey/roundId`；写入失败不许抛给主流程。

### 3.4 `core/bus`（M2 里，20 行就够）
```js
export function on(kind, fn) ; export function emit(kind, payload)   // 同步、失败隔离、不许 await 阻塞主链
```

---

### 3.5 搬运层兼容面（**冻结**：谁都不许改名，改名等于改搬运层的调用点）

> 由 `.tmp-dispatch/rf-compat-surface.mjs` 扫 `refactor/**/*.js` 的**跨模块 import** 得出（2026-10-04 首扫，原始数据 `.tmp-dispatch/rf-compat-surface.json`）。
> 含义：这些名字**必须**由对应模块的 `index.js` 导出，否则搬运层的 `import` 直接炸。**表里没有的名字 = 对方还没承诺，不许假设。**

| 目标模块 | 必须导出的名字 | 谁在用 |
|---|---|---|
| `core/config-store` | `get` `snapshot` `set` `DATA_DIR` `DEFAULT_CONFIG` `getConfig` `updateConfig` `subscribeConfigChange` | platform(sender/salvage)、llm(llm/cache-keepalive)、internet(api-news/price-feed/web-search/wiki/safe-fetch)、extensions(plugin-loader/skills/config) |
| `core/config-store`（实例锁） | `acquireInstanceLock` `releaseInstanceLock` `touchInstanceLock` `startInstanceHeartbeat` `describeInstance`（旧 `src/instance-lock.js`，§2 划给 M1） | apps(desktop/main.js:185) |
| `core/util` | `sleep` `randInt` `createSendChain` `escapeCqText` `formatClockTime` `isLocalHostUrl` `sanitizeUserText` `mdToPlain` `splitForQQ` | platform(onebot/sender) |
| `core/observability` | `span` `event` `ledger` `recent` `log` `on` `emit` + **兼容别名 `logger`**（旧 `src/logger.js` 的用法；`apps/desktop/main.js:9` 在用） | apps(desktop) |
| `modules/llm` | `chatCompletion` `apiWith` `setRemotePrices` **`visionUnsupported`**（media 的 vision-image.js 在用） | platform(salvage)、internet(api-news/price-feed)、media |
| `modules/memory` | `msgRef` `normalizeRef` `logMemoryChange` `readAuditLog` **`configure` `setDataDir` `retrieve` `commit`** | platform(sender)、media(image-lib/memes)、act(tools)、**装配层(apps/server)** |
| `modules/emotion` | `isHypeMode` ← **唯一归属地**；**`renderRelationSummary(relation) -> string`**（把 M7 自己拥有的字段渲染成文本，供 M8b 用；M8b 只认字符串、不认字段） | platform(sender)、llm、**M15→M8b** |
| `modules/jev` | `localJevHasRole` `jevJudgeTextOnly` `jevSaySkipLine` **`asSignal` `ask` `stats`**（§3.7 装配序列在用） | platform(salvage)、装配层 |
| `modules/act` | `registerTool` `unregisterTool` `unregisterToolsBySkill` `getTool` `listTools` `getToolAvailability` **`run` `send` `assertDelivered` `registry` `selectTools`** | extensions(plugin-loader/skill-bridge)、装配层 |
| `modules/extensions` | `skillManager`（side-effect import 也算）**`loadPlugins`** | platform(sender)、装配层 |
| `modules/platform` | **`OneBotClient`**（media 的 sticker-manager.js 在用） | media |
| `modules/internet` | **`safeFetchBinary`**（media 的 sticker-manager.js 在用） | media |
| `contracts` | **`makeMessageEvidence` `makeActionPlan` `makeVerdict` `makeSendReceipt` `makeMemoryObservation` `makeIdempotencyKey` `validateMemoryObservation`**（装配层与各模块都在用） | 全体 |

**维护规则**：任何模块**新增**跨模块 import → 先跑这个探针、把名字加进本表、再动手。
**2026-10-04 21:1x 补齐（来源：`.tmp-dispatch/r-refactor-integration-matrix.md` 的"危险项 12 条"）**：上表原来漏掉了 **12 个"消费者在用、生产者已导出、但表里没写"**的名字（`OneBotClient` `safeFetchBinary` `visionUnsupported` `configure` `setDataDir` `loadPlugins` + `contracts` 的 5 个 `make*` 与 `validateMemoryObservation`）—— 已全部补进表。**教训**：冻结表只从"搬运层扫描"生成，会漏掉**装配层自创的调用面**；以后每加一次装配层调用，都要回填本表。
**"允许的差异类型"（搬运保真检查的显式白名单 —— 2026-10-04 21:xx 采纳 REVIEW-1 的建议）**：
1. **静态 import 行**（改路径/改名）；
2. **函数体内的动态 `import()` 行**（缩进行也算，不是只有顶层 import 语句）；
3. **纯注释新增**（无行为）；
⇒ **白名单之外一律硬失败**（不许"只要不是 import 行就只警告"——那种写法等于保真声明没有闸门，REVIEW-1 实测抓到过：`llm.js` 里 `'cache_control'` 被改成 `'cache_controX'` 仍然 EXIT=0）。
**归口裁定**：`isHypeMode` **只**从 `modules/emotion/index.js` 出（llm 里那份 `../plan/index.js` 的写法要改）；`SendReceipt` 的构造**只**在 `modules/act`（E 阶段）做 —— 平台层只负责把协议端原始结果（`message_id` 等）往上传，**不许**在 M3 里造回执；`memory-audit`（`logMemoryChange` `readAuditLog`）归 **M6 memory**（记忆域自己的审计，不是通用可观测层），`act`/`media` 从 `../memory/index.js` 取。

### 3.6 `modules/plan/`（M8）输入形状（**冻结** —— Luna2 2026-10-04 夜提出"`Context`/`relation`/`cfg`/`jevSignal` 没有冻结形状"，此处补上）

```js
decide({ evidence, context, relation, cfg, jevSignal, now, rand }) -> ActionPlan   // 纯函数
```

| 入参 | 形状 | 谁拥有 / 纪律 |
|---|---|---|
| `evidence` | `MessageEvidence[]`（§3.1） | M0 已冻结 |
| `context` | `{ items:[{claim, scope, evidenceIds[], confidence, at}], dropped:[{reason}], topic?, need? }` | **M6 `retrieve()` 的输出**；允许有额外键，**M8 不许依赖额外键** |
| `relation` | **不透明对象**（M7 拥有） | M8 **只透传**给提示层，**不许读具体字段、不许自己定义字段** |
| `cfg` | **只读访问器** `{ get(keyPath, fallback), sourceOf(keyPath), effective(keyPath,{chatKey,kind}) }` | 装配层注入 M1 实例；**M8 不许自己 deepMerge** |
| `jevSignal` | `null` 或 `Verdict.signals` 里的 jev 条目 `{ from:'jev', role?, label?, p?, margin? }` | **只是候选信号**；`null` **不等于**否决（验收第 1 条） |
| `now` / `rand` | 数字 / `() => number` | 纯函数要求：时间与随机**从入参给**，不许自己取 |

**M8b（提示词/人设组装）独立成模块 `modules/prompt/`**（2026-10-04 20:xx 改的口径：它有自己的依赖面 —— 人设卡 / 记忆视图 / 配置，与 M8 `decide()` 的纯函数性互相拉扯，塞在一起会互相污染）。接口见派单，**不要**塞回 `modules/plan/`。

### 3.8 `modules/orchestrator/`（M15）—— 运行时与调度（**冻结**；2026-10-04 21:xx 补，此前只在 §2 表里提过它，导致 M15 席位按"规格缺失"正确停工）

```js
export function createRuntime({ cfg, log, bus, modules, clock }) -> {
  onInbound(rawBatch) -> Promise<RunOutcome>,  // 防抖聚批 → 同群互斥 → 全局并发上限 → 跑一轮 A→F（§3.7）
  onTick(now) -> void,                         // 定时驱动（提醒 / 主动开话题的触发时机）；由装配层按分钟 tick
  status()  -> { running:[{chatKey, roundId, stage}], pending:[{chatKey, since}], paused:boolean },
  pause(reason) -> void,
  abortAll(reason) -> void
}
```
- **`modules` 是注入的**（各模块 `index.js` 的命名空间）：**M15 不许自己 import 兄弟模块**（只许 `contracts` + `core/*` + `node:`）⇒ 这样它才能在 selftest 里用桩把整条链路跑起来，也才能证明"编排"本身是对的。
- **`clock` 是注入的**：时间/随机**不许**自取（`onTick(now)` 由装配层驱动，**不许起常驻定时器**；要起就必须可停 + 不许泄漏）。
- **它 owns 旧 `orchestrator.js` 里没有归属的那 10 类**（段落级盘点见 `.tmp-dispatch/r-refactor-assembly-recon.md` E2）：唤醒调度与并发运行时 · 收尾状态机（**`finish` 只许一个写入点**）· 退化断路器（`repeatBlocks ≥ 3`）· 提醒/闹钟循环 · 主动开话题的**触发时机**（该不该说话仍归 M8）· 协议恢复/正文兜底的裁决壳 · 人格切换事务（三样一起换）· favor 后置结算的并发控制 · 梗记账 + 表情冷却状态 · 控制接口。
- **`botSaidBefore` 的长窗口由 M15 提供**（"最近一小时 ∪ 最近 N 轮"，从 E 阶段回执账本取）：M8 的**冷却 / 每小时上限**直接读 `evidence[].botSaidBefore`，**M8 不需要新参数**。提示词侧只取最近 N 条（M8b 负责）。
  ⇒ **不提供长窗口 = 小时上限静默失效**，这是最贵的那类错 ⇒ M15 自测里必须有牙：喂足一小时内的历史 ⇒ 上限真的生效。



### 3.7 装配契约（**冻结** —— 第 3 批接线照这个调；来源：`r-refactor-assembly-recon.md` + 各模块实际交付的出口名）

**谁实现这个序列**：**M15 `modules/orchestrator/`**（它 `onInbound(batch)` 里跑完 A→F）。装配层（`apps/server`）**只负责装配与注入**：把 `modules` 命名空间、`cfg/log/bus/clock` 交给 `createRuntime()`，然后 `runtime.onInbound(rawBatch)`。
（2026-10-04 21:2x 定稿：曾一度打算把序列放 `apps/server/pipeline.js` 并由 M15 注入 `runOneTurn`，**已撤** —— M15 自己实现更好，因为"收尾状态机"必须夹在多轮之间，与序列同属一个所有者。`apps/server/pipeline.js` 已删除，**不要再造第二份**。）

一轮消息的**唯一调用序列**（**模块之间不互相调**，由 M15 按序调）：

```js
// A 事实还原
scenario.ingestBatch(rawBatch, { selfId, selfNames, resolveQuote, resolveAtName, maxTextChars })
   -> MessageEvidence[]                       // 名字以 M5 实际交付为准：ingestBatch / inspectBatch

// B 取回状态
memory.retrieve({ chatKey, kind, evidence, topic, senderId, need }) -> Context

// C 行动意图（唯一决定点）
plan.decide({ evidence, context, relation, cfg, jevSignal, now, rand }) -> ActionPlan

// D 受限校验（**只是候选信号，不是否决器**）
jev.asSignal({ plan, evidence, context, cfg }) -> Verdict.signals 里的 jev 条目 | null

// E 生成 + 执行 + 发送 + 核验（回执为准）
//   ★ 2026-10-04 22:xx 补：「生成」此前在 A→F 里**没有归属**（M8 是纯函数、ActionPlan 里没有正文字段，
//     M8b/M4 全树零调用者）⇒ 实盘表现为"连上 QQ 但一个字发不出去"。现归 M15 的 E 阶段显式一步：
//     ① prompt.buildMessages({evidence, context, relation, relationText, cfg, tools:{names}, now, hype})
//     ② llm.chatCompletionWithRetry({messages, tools, affinityKey: chatKey})
//     ③ 模型调工具 → act.run({action:'tool', toolPlan:[…]})（`send_message` 由 M10 内部走 act.send 产回执）
//        模型给正文 → M15 用下面的 act.send 发出（引用/@ 只在"这条消息是冲着机器人来的"时候带）
act.run(plan, { platform, cfg, skills, budget }) -> ToolResult[]
act.send(receiptInput, platform) -> SendReceipt
act.assertDelivered(results) -> { delivered, reasons[] }

// F 提交状态与记忆（幂等）
memory.commit(observation, { evidence, idempotencyKey }) -> MemoryObservation
```
- **E 阶段「生成」归 M15（2026-10-04 22:xx 冻结）**：实现在 `modules/orchestrator/compose.js`。
  **不塞回 M8**（M8 保持纯函数、保持"唯一决定点"）；**回执仍然只在 M10 造**（compose 不构造 SendReceipt）。
  模型轮次上限 `composeMaxModelRounds`（默认 3）；工具名不是 OpenAI 合法函数名的（例如中文名的技能工具）**不进 schema**，并留日志 `compose-tool-name-dropped`。
- **`clock` 字段名（冻结）**：`clock = { now, random, schedule, cancel }`。M15 读 **`clock.random`**（不是 `rand`）——
  此前装配层只给 `rand`，实盘每轮都在 plan 阶段抛 `clock.random is required`（2026-10-04 实测）。
- **活 platform 的注入（冻结）**：M10 的唯一发送出口是 **`platform.sendTextBatch(chatKey, messages, options) -> {sent,failed}`**；
  M3 的 `OneBotClient` **本身没有这个方法**（出口在 M3 的 `SendQueue`）⇒ 装配层把**活门面**（`SendQueue` 包装）经 `ctx.setPlatform()` 注入到 M15 看到的 `modules.platform`；**不许**把 M3 模块命名空间当 platform 传。
- `relation` 来源 = `emotion.relationOf({ chatKey, senderId })`（M7 出口）：**不透明对象**，只许交给 M8 的提示层透传。
  ⇒ M7 是**纯状态模型**（`relationOf(state, personId)`）⇒ 活状态实例由**装配层**绑成上面这个形状（`apps/server/assembly.js` 的 `buildRuntimeModules()`）。

- **`botSaidBefore` 的窗口（调用方责任）**：M8 的「冷却 / 每小时上限」两个硬闸**只能从冻结输入里看到的历史**算 ⇒ **调用方（M15）喂给 A 阶段的 `botSaidBefore` 必须是"最近一小时 ∪ 最近 N 轮"**（从 E 阶段回执账本里取），否则**小时上限在新树里根本无法执行**（旧实现靠进程内计数器，那条路故意没搬）。
  ⇒ 提示词侧只取最近 N 条（**M8b 负责裁剪**）。**M8 不需要新参数**：它直接读 `evidence[].botSaidBefore`（2026-10-04 21:xx 修正：曾提出 `recentSends`，已退休，避免改 M8 接口）。
- `MessageEvidence.id` **必须唯一且稳定** —— 幂等键 `${chatKey}:${evidenceId}:${action}` 依赖它。
- **装配层必须显式注入**：`dataDir`（`config-store.load({dataDir})`）、`selfNames`、`cfg` 访问器、`platform` 实例、`budget`、`skills`。
  ⇒ **没有显式 `dataDir` 就不许落盘**（M6 已 fail-closed；线上实例可能正在用 `data/`，见 `.tmp-dispatch/重构作战板.md` §五）。

**`core/bus` 事件名（冻结）**：
`evidence:built` · `context:retrieved` · `plan:decided` · `verdict:issued` · `receipt:confirmed` · `observation:committed` · `config:changed` · `extension:loaded` · `extension:reloaded`

**回放集纪律（`refactor/test/replay/`，2026-10-04 21:xx 裁定）**：
1. **回放只许调用 §3.7 的真实出口**（`scenario.ingestBatch` / `memory.retrieve·commit` / `plan.decide` / `jev.asSignal` / `act.run·send·assertDelivered`）。
2. **模块不许为测试加出口**（没有 `replayRoute` / `replayMedia` 这类名字）。`did[]` 记号**由回放侧的适配器从真实输出推导**（`ActionPlan.action/reason`、`Verdict.signals`、`SendReceipt`、`retrieve().items/dropped[].reason`）。理由：测试脚手架不许进生产代码；而且回放要验的正是"真实路径"。
3. **有 SKIP 就不算绿**：默认只要有 SKIP ⇒ **EXIT≠0**；要放行必须显式 `--allow-skip`，且汇总里逐条复列被跳过的用例。

**装配与入口的落位（第 3 批）**：`apps/server/`（`src/server.js` 只有 37 行，但**胶水是新写的**，约 900 行量级：入口/路由/静态/装配根/路径对齐）· `modules/orchestrator/`（M15，运行时与调度，A→F 序列在这里）· `apps/desktop/`（electron 壳，已搬）· `apps/ui/`（已搬）。

---

## 4. 目录约定
```
refactor/
  README.md                 ← 本文件（冻结）
  contracts/                ← M0（含 selftest）
  core/config-store/  core/observability/   ← M1 M2
  modules/<name>/           ← M3…M12 M14（每个含 index.js 公开出口 + selftest.mjs）
  apps/desktop/  apps/ui/   ← M13
  test/replay/              ← 回放集与 14 条验收（第 3 批做）
```
- 每个模块**只暴露 `index.js`**；别的模块只能 `import { … } from '../<name>/index.js'`。
- 文件名用 kebab-case；不许出现 `utils.js` 这种垃圾桶文件（放 `core/*` 具体模块里）。

---

## 5. 分工与批次

**第 1 批（地基，已派）**：M0 contracts · M1 config-store · M2 observability · M3 platform（搬）· M4 llm（搬）
**第 2 批（等第 1 批的合同落地）**：M5 scenario · M6 memory · M7 emotion · M8 plan · M9 jev · M10 act · M11 media · M12 extensions · M13 apps · M14 internet
**第 3 批（集成验）**：装配与入口 1 人 · 独立只读复核 1 人 · 回放/14 条验收 1 人
- **装配与入口（第 3 批才做，现在谁都不要碰）**：`src/server.js` → `refactor/apps/server/`（HTTP 入口 + 静态目录指向 `apps/ui/`）；启动器（`.bat`、打包脚本的 `main` 字段）；**`APP_ROOT` 语义对齐**（旧 `electron/..` = 仓库根 ⇒ 新树由装配层决定 `apps/desktop` 的最终落位）；`core/bus` 的接线。

---

## 6. 验收（第 3 批执行；来自 09-27 方案的 14 条，逐条要能被回放集复现）
明确 @ 不被低意愿吞掉 · 续话题不被当新插话 · 转题就停 · 未完成承诺继续且工具失败不说"已办好" · 主模型选"不发"就不发且发图失败不记成功 · 图里动作不归因给发图人 · 用户更正后旧观察保留历史但当前不再沿用 · 全局印象跨群可用而群内/私聊细节不外泄 · 引用里的"我"不被误认 · 卡片"写入次数≠命中次数" · 归档增量不丢说话人/ID · 低精力仍答明确请求（只是更简洁）· 生活账本只在有来源时支持"刚睡醒" · 一条未回复能查到停在哪一阶段 + 当时的有效配置。
