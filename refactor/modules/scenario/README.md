# M5 `modules/scenario/` —— 阶段 A：还原事实场景

> 派单：`.tmp-dispatch/_msg-rf-m5.txt`；唯一真相源：`refactor/README.md`（§1 流水线 / §3.1 契约 / §4 目录）。
> 旧实现参考：`src/orchestrator.js` + `src/app.js` 的 ingest 段（**只作意图参考，未照抄**）。

## 一句话

**输入**一批原始入站消息 → **输出**一串 `MessageEvidence`（`refactor/contracts/index.js` 的冻结形状）。
阶段 A 只回答事实，不回答"该不该回"。

```js
import { ingestBatch } from '../scenario/index.js';

const evidence = ingestBatch({
  chatKey: 'group:1001',
  kind: 'group',
  selfId: '999',
  raw: [...],          // 原始入站项（见下方"入参"）
  botSaid: [...],      // 可选：机器人此前说过的话（**必须带回执**才会被采用）
  now: 1730000000000   // 可选：raw 项没有时间时的兜底（注入，绝不读系统时钟）
}, {
  selfNames: ['鲸鲸'],       // 注入：机器人自己的名字（M5 不读配置）
  resolveAtName: (id) => '',  // 注入：@ 的同步名字解析（不许异步）
  resolveQuote: (id) => null, // 注入：被引消息的同步解析
  merge: false,               // 多片连发合并（默认关，见下）
  botSaidLimit: 5,
  maxTextChars: 8000,         // 正文截断阈值（可配；负数/0/小数/NaN 一律回落默认 8000）
  strict: false
});
```

排障用同一个入口的孪生兄弟：`inspectBatch(batch, options)` → `{ evidence, diagnostics }`。
`diagnostics` = `counts` / `issues[]` / `merges[]` / **`truncated[{evidenceId, originalChars, keptChars}]`** / `textLimit` / `botSaid`。
★ 截断留痕只走诊断通道，**不进 evidence 对象**（会被 M0 契约拒）。

## 入参（宽收口，协议端形态与上游归一形态都吃）

| 事实 | 认得的字段名（按优先级） |
|---|---|
| 消息 id | `id` → `message_id` → `mid` |
| 时间 | `at`(毫秒) → `ts`(毫秒) → `time`(秒 → ×1000) → `batch.now`；**都没有就抛 `E_NO_TIME`** |
| 说话人 id | `sender.user_id` → `sender.id` → `sender.uin` → `senderId` → `user_id` → `userId` |
| 说话人名 | `sender.card` → `sender.nickname` → `sender.name` → `sender.nick` → `senderName` → `nickname` |
| 正文 | `segments` → `message`(段数组或 CQ 串) → `raw_message` → `text` |
| 自述 | `post_type === 'message_sent'` 或 说话人 id == `selfId` |
| 回执 | `receipt`（形状由 `contracts.validateSendReceipt` 判） |
| 引用（上游已解析） | `quoted` / `reply`（`{sender, senderId/self, text, id/mid}`） |

## 六条硬规矩（selftest 逐条断言）

1. **只还原事实**：不猜动机、不判人格、不判真伪、**不做情绪分类**（那是 M7）。
2. **引用内容绝不进 `text`** —— 只进 `refs.quoted`。
   被引原话里的「我」如果被拼进正文，下游会把它当成**当前说话人**说的（验收第 9 条）。
3. **图片内容不归因给发图人**：`media[]` 条目只有 `{type,id,desc?,ocr?}`，**结构上没有发送者字段**（验收第 6 条）；
   画面描述不进 `text`，正文里只有 `[图片]` 占位符。
4. **`botSaidBefore` 只收带回执的机器人消息**（`receipt.ok === true` 且形状合法）。
   没回执 / 发失败 / 回执形状坏 → 一条都不收，且在 `diagnostics.issues` 里**明确报出来**。
5. **规范化但不改写原文**：只 `trim` / 拼接 / 给非文本段配占位符（`[图片]` `[语音]` `[表情123]`…），
   不概括、不润色、不删中间内容。
6. **确定性**：无 `Math.random` / `Date.now` / `new Date` / `process.env`（selftest 静态扫源码强制）。
   同一输入 → 逐字节相同输出。

## 输出（`MessageEvidence`，逐字来自 contracts）

```
{ id, at, chatKey, kind, selfId,
  sender: {id,name},
  text,
  mentions: [{id,name,isSelf}],
  refs: { toSelf, quoted: null|{id,sender,text}, replyTo },
  media: [{type:'image'|'sticker'|'video', id, desc?, ocr?}],
  botSaidBefore: [{id,text,at}] }
```

`refs.toSelf`（"这条是在跟机器人说话吗"）由**三个事实**合成，没有一个是猜的：
① 引用了机器人（平台引用目标）② @ 了机器人（`at` 段）③ 正文**开头**直接叫名字（名单由调用方注入，名单空则这一路整个关闭）。

## 故意与旧实现不同 / 没搬的

| 项 | 旧实现（`src/app.js` + `src/onebot.js` + `src/store.js`） | 本模块 | 为什么 |
|---|---|---|---|
| 引用原文 | 拼进正文：`[引用 #318 A：原话]` | **只进 `refs.quoted`**，正文一个字不加 | 正文里的"我"会被误认成当前说话人（验收第 9 条） |
| @ 的渲染 | `@名字[CQ:at,qq=123]`（名字和号都塞进正文） | 只 `@名字`（号在 `mentions[].id`） | 同一事实不重复表达；下游靠 `mentions` 判定，不靠正文 |
| 多片连发 | 不合并，每条各自成 entry | 提供合并，但**默认关闭** | 契约里没有"这条由哪几片合成"的字段，合并后无法自证 ⇒ 必须由调用方显式选择 |
| 名字呼叫判定 | `callsBotByName` 读 config 拿名单 | 名单由调用方注入 `options.selfNames` | 阶段 A **不许读配置**（M5 不 import M1）；名单空 = 该路关闭 |
| 段→文本 | `onebot.segmentsToText`（async，会联网解析 @ 名字） | 同步纯函数，解析不到就用号码 | 阶段 A 无 IO；异步解析器会被忽略并在 diagnostics 里报出 |
| 媒体抽取 | `extractMediaFromSegments` 给 `{kind,file,url,summary}` | 归一成契约的 `{type,id,desc,ocr}` | 契约是唯一形状 |
| 语音/文件 | 只在正文留占位符 | 同样只在正文留占位符，另外报 `media-type-unsupported` | 契约的 `media.type` 没有 `record`/`file` 位。**指挥位裁定 1（2026-10-04）：不动契约** ⇒ 登记为**第 3 批契约缺口候选**，装配期真需要结构化定位（转写/时长）时再一次性改三处（M0 校验 + M5 + M11） |
| 正文截断 | **不截断**（多长都存） | 截到 `options.maxTextChars`（默认 8000），**必须留痕**：`diagnostics.truncated[{evidenceId, originalChars, keptChars}]` + `issues` 里一条 `text-truncated` | ⚠️ 这是**新加的行为**（旧实现没有），**指挥位裁定 2：保留但必须留痕、可配置**。目的是一条转发卡片就能把提示词顶爆；它确实丢尾部信息 ⇒ 所以强制留痕 + 阈值可配 + **不许**往 evidence 加字段 |
| 去重标记 | `dupSuspect` 等打标落 store | **不做** | 那是存储层的事（M6/M1），阶段 A 不产出契约外的字段 |
| 时间兜底 | `Date.now()` | `E_NO_TIME` 抛错 / 用注入的 `batch.now` | 原样搬 `Date.now()` 会破坏确定性 |

## 文件

| 文件 | 职责 |
|---|---|
| `index.js` | **唯一公开出口** + `SCENARIO_INFO`（自述承诺） |
| `segments.js` | 段 → 正文 / mentions / refs / media（纯函数） |
| `inbound.js` | 一条原始入站项 → 规范化事实记录（宽收口、时间校验） |
| `merge.js` | 多片连发合并（默认关） |
| `bot-said.js` | 回执闸：谁才算"说过" |
| `evidence.js` | 事实记录 → `MessageEvidence`（过 `makeMessageEvidence` 收口）+ 批量编排 |
| `errors.js` | `ScenarioError`（带 `code`） |
| `selftest.mjs` | 20 个用例 / 155 条断言 |

## 验证

```powershell
node --check refactor/modules/scenario/*.js
node refactor/modules/scenario/selftest.mjs        # → EXIT=0
node .tmp-refactor/m5-mutation-selfcheck.mjs       # → EXIT=0（改一行必红，对照组必绿）
```
