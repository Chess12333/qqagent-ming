# M7 `modules/emotion` —— 情绪·精力·好感·关系（纯状态模型）

**它只回答「现在是什么状态、和这个人关系如何」，不回答「要不要开口」。** 决定权在 M8 plan（README §0 铁律 5）。

## 公开出口（`index.js`）

| 名字 | 形状 | 说明 |
|---|---|---|
| `initState(input)` | → state | 新建/载入；`input.at` 给时刻，模块不读时钟 |
| `applyEvent(state, event)` | → state（新对象） | 纯函数；不改入参、不写盘、`Date.now()` 一次都不出现 |
| `styleHint(state, {personId})` | → string | **一句**可行动的说话倾向；没有数字、没有否决话术 |
| `renderRelationSummary(relation)` | → string | 把关系渲染成提示词用的一小段人话；≤120 字符、不念数值、异常入参返回空串**不抛**。§3.5 登记，消费者 **M15 → M8b** |
| `relationOf(state, personId)` | → `{familiarity,trust,boundary,tone,recentShared,...}` | 按人；`personId` 空即抛。**字段稳定性见下** |

**★ 字段稳定性（指挥位 2026-10-04 裁定 2）**：`relationOf` 返回值里**只有 `familiarity / trust / boundary / tone / recentShared` 这 5 个是 README §3 冻结的、对外保证稳定**；`favor / known / preferences / openEvents / lastChange` 是 **M7 的内部扩展，随时可能变**，只供 M8 原样透传与 UI 只读显示 —— **别按它们写逻辑**（`relation` 是不透明对象，所有权在 M7）。

**★ 关系的文本渲染归 M7**（指挥位 2026-10-04 裁定，M8b 交付时提出的真问题）：正因为 `relation` 是 M7 拥有的不透明对象，「把它说成人话」是 M7 的本分 —— 只有我知道各档该怎么措辞。
对外形状是 `renderRelationSummary(relation) → string`：M15 调我拿字符串，再整段交给 M8b；**M8b 只认字符串，不许认识字段**。三条约束：不念数值（与 `styleHint` 同口径）、上界 120 字符（`RELATION_SUMMARY_MAX_CHARS`，装不下就少说一档、不硬截半句）、异常入参返回空串**不抛**（提示词少一段不致命，主链断掉致命）。

| `snapshot(state)` | → 只读深拷贝 | 四池 + 恢复目标 + 最后变化来源 + 台账尾 20 行 |
| `isHypeMode()` | → boolean | §3.5 冻结名（唯一归属地），语义对齐 `src/hype-mode.js:51` |

其余是只读常量与 `validateEvent`（装配层可预检）。

## 形状的两条分界（票面第 1 条）

- `state.self`：**跨群共享一份**本体状态 —— 四池 `physical/cognitive/emotional/will`、心情、唤醒、急性/慢性压力、6 类情绪余温、近况条目、恢复目标与其偏移。
- `state.persons[personId]`：**按人**的熟悉度 / 信任 / 边界 / 语气 / 好感 / 共同经历。
- 两者不共用任何字段，所以「拿精力当好感」「把某个群的心情当成全局心情」这类混用在代码里写不出来。

## 「为什么它结构上不可能否决消息」

三层，都不是靠约定而是靠形状：
1. 事件能改写的字段被 `events.js` 的 `DELTA_FIELDS` 钉死（8 个池/心情/压力 + 6 类情绪余温）；白名单外的键 —— 包括任何 `shouldReply` —— `validateEvent` 判非法、`applyEvent` **抛错**（selftest 1c/10 末条）。
2. 对外唯一的表达是 `styleHint`，返回类型是 **字符串**；本模块没有任何返回布尔/动作的出口（selftest 1a/1b 用正则扫公开出口名单）。
3. 本模块不 import 也不构造 `Verdict` / `ActionPlan` —— 否决与决定住在 contracts 的那两个结构里，由 M8/M9 产（selftest 1d 扫源码）。

## 变化必须有来源（验收第 13 条）

`EVIDENCE_SOURCES = time | calendar | recent-situation | tool | emotion-evidence`；带能量的事件还必须带 `evidenceIds`（空数组即非法）。
**`role-statement`（模型自己说出来的话）不在可施力来源里**：它只能作为 `roleStatement` 事件进 `state.pending`，`status:'unconfirmed'`，**一个数值都不碰**（selftest 5a–5d）。反过来说，「我刚睡醒」想真的变成精力↑，必须由外部证据以 `recent-situation`/`calendar`/`tool` 来源带 `evidenceIds` 进来。

## 幂等与「一轮一次」（票面第 4 条）

- 每个有能量的事件带 `idempotencyKey`（消息缺省由 `contracts.makeIdempotencyKey(chatKey, evidenceId, 'emotion:absorb')` 生成）；同键第二次 apply **完全等价于没发生**（selftest 3a/3b）。
- `relationDelta` 还额外受 `roundId` 约束：同一轮对同一个人第二次计分被拒并在台账留痕 `rejected:'scored-once-per-round'`（selftest 4a/4b）—— 键不同也拦。
- ~~好感只能由 `FAVOR_REASONS`（陪伴/帮忙/共同经历/道歉修复/边界被尊重/可靠/伤人）变动；`disagreement / refusal / said-no / corrected-me` **永不计分**（§八：好感不是服从度，selftest 10）。~~ ⇒ **2026-10-11 用户裁定 B10 撤门槛**：**任何理由都能计分，正负与幅度听模型的 `delta`**（"好感就是 LLM 自己决定的"；对齐老树 `src/tools.js:2282` 自由文本理由 + `setFavor`）。`FAVOR_REASONS` / `NEVER_SCORE_REASONS` 两常量保留导出（UI 标签 + `favor-reason.js` 兜底打标用），但 `events.js` 不再拿它们拦事件。favor 侧唯一保留：`reason` 必填（不许无因涨跌）+ 一人一轮只计一次 + 必须有 `evidenceIds`。

## 半衰期按类别（票面第 5 条）

`impulse 6′ · mood 16′ · energy 15′ · acuteStress 8′ · calendar 12h · episode 4h · chronicStress 3d · impression 3d · tone 2w · preference 30d · relation 90d`。
未知类别**抛错**而不是兜底（selftest 6e）；偏好六小时后权重仍 >0.99，临时情绪六小时后归零（6c/6d）。

★ 2026-10-07（票 E-2）：新增两个**具名**类别 `emotionPool 4′ · willPool 25′`，四池**各用自己的半衰**
（`POOL_HALF_LIFE_CATEGORY`：身体/认知 `energy` 15′、情绪 `emotionPool` 4′、意志 `willPool` 25′）。
既有键一个都没改名（别的模块按名读）。依据：规格「情绪精力半衰约 4 分钟」「意志较慢地回落」＋老树
`src/bot-state.js:299`（4′）、`:301`（`kf*0.6` ≈ 25′）。

## 认知软地板（票 E-2 · 规格「认知很低时扣得更少」）

`cognitiveDrainScale(v) = clamp((v-20)/(60-20), 0.25, 1)` —— 只作用于**认知的扣减**（涨认知不打折）；
身体/意志/情绪池不照抄。**软**而非截断：阈值处没有跳变，任何步长都单调、不越 0，池子不会锁死在谷底。

## 台账两根轴：「什么引起的」与「能不能重算」（票 E-2 · 指挥位裁定①）

每行台账都带两根**可枚举**小集合字段（`apply.js` 的 `push()` 统一给默认值，不许自由文本）：
- `kind` —— `event`（外部证据引起，events.js 进来的）／`decay`（**纯时间结算步**，`apply.js` 的 `relax` 行）。
  「聊天引起的」与「时间引起的」就靠它一眼分开：`ledger.filter(r => r.kind === 'decay')`。
- `deterministic` —— 默认 `false`（依赖外部证据）；`decay` 行为 `true`：只由 (池值, 恢复目标, dt) 决定，
  **同样输入必然同样输出**，不依赖任何外部证据 ⇒ 随时可重算核对。
- decay 行的 `evidenceIds` 装的是**重算键** `decay@<at>`，**不是聊天证据**（证据槽不允许空，见上文「空数组即非法」）；
  前缀就是明示。`source` 仍是 `time`（`events.js:12` 里已是一等来源），**没有新增来源枚举值**。

📌 **设计债（2026-10-07 指挥位登记，不在本票拍板）**：`decay` 行是否该独立成一张台账（现在混在同一本里靠 `kind` 分流）。
量到的现状（`node .tmp-dispatch/_e2-decay-rate2.mjs`，下午档初值，60 分钟窗口）：
静置每分钟一步 **7 行/60min**、每 5 分钟一步 4 行、每 15 分钟一步 2 行；聊天节奏 每分钟一条 40 行、每 5 分钟一条 12 行。
**改前（四池共用 15′）分别是 9 / 5 / 3 与 40 / 12** ⇒ 本票的三条修复**没有让台账更吵**（意志变慢抵掉了情绪变快），
真正新增的只有"偏差刚出现后的头几分钟"。

## 两件已由指挥位裁定（2026-10-04 夜，f0917af6）

1. **`isHypeMode` 的向下依赖合规**（裁定选 a，不改名不挪走）。
   指挥位把口径纠正为：**允许 import `contracts/` + `core/*`（config-store / observability / util）+ `node:`；禁止的是兄弟模块的内部文件（§0.4）** —— 原票面「只 import contracts」写窄了。
   ⇒ `hype-mode.js` 静态 import `core/config-store` 的 `get('hypeMode.enabled')` 合规；读不到保守返回 `false` 也对（宁可不开亢奋，也不许抛给主链）。
   ★ 保持这条设计的理由：**亢奋不进 state、不参与衰减、不出现在 snapshot** —— 「配置」与「情绪状态」只有一处真相。
2. **`relationOf` 的超集保留**（§3.6 里 `relation` 是不透明对象、归 M7 拥有，M8 只透传）。
   ⇒ 但对外只保证上文那 5 个字段，其余按「内部扩展」对待。

## 现版行为我**故意没搬/改了**（票面「只作参考」）

| 现版 | 本模块 | 为什么 |
|---|---|---|
| `botStatePromptLine` 把「精力78／心情62」念进提示词 | 只出一句 `styleHint`，数字只进 snapshot | 票面第 7 条 + docs §五重构建议 |
| `getBotState()` 内部 `Date.now()` + 20 秒 `DECAY_COMMIT` 节流 + 读写 `bot-state.json` | 时间从 `event.at` 拿；不落盘，节流交给调用方 | 票面第 6 条（纯函数） |
| 14 类离散情绪表 + 中文词表 + `EMOTION_PROFILES` 增益 | 6 个 `affect` 槽（joy/irritation/sadness/loneliness/excitement/anxiety） | 情绪**命名与措辞**属提示词域（M8）；要更多槽位请报我加 |
| `parseEmotionTags` / `applyRunToBotState`：模型输出的标签直接改本体状态 | 删掉这条通路；只能以 `emotionEvidence`/`relationDelta` 带来源进入 | 这正是验收第 13 条要防的自证 |
| 情绪阈值自动开亢奋 + 5 分钟自动退（`emotionThreshold`/`hypeAutoExitDue`） | 不搬：`isHypeMode` 只读，开关与计时属决策/装配域 | README §0 铁律 5（决定权唯一） |
| `setHypeMode/getHypeProtectedQQ/sanitizeHypeProtectedArgs/HYPE_TOOLS/hypeStatus` | 不搬（写配置、裁工具、保护 QQ 都不在 M7） | §3.5 只冻结 `isHypeMode` 这一个名字 |
| 情绪 gate 顺带涨好感（`favorDeltaForKinds`） | 必须带 `reason`+`evidenceIds`+`idempotencyKey`+`roundId` | 票面第 4 条（不许无因涨跌/一轮多次） |
| `energyLabel/moodLabel/socialLabel` 数值档位文案 | 不导出 | 同上：数字不进上下文 |
| 精力按小时曲线跟随目标 | 保留（改按 **UTC** 小时，`targetsFor`） | 纯函数要跨机器可复现；换时区会让人跨时段，已在代码注释说明 |

## 未核 / 无牙

- 没跑真机器人、没读 `data/**`；一切是合成数据。测试目录只用 `.tmp-refactor/m7-emotion/`（空目录，config-store 读不到文件即 `missingFile`）。
- `calendar/episode/impression/tone/preference/relation` 的半衰期**数值**是新定的（现版没有对应长效条目）；`impulse/mood/energy/acuteStress` 对齐现版量级。数值调参需要回放集，那是第 3 批。
- 跨模块真 import（llm/platform 取 `isHypeMode`）第 3 批统一验；我只跑了本模块的 import 面（selftest 12f）。
- 与 `plugins/life-system` 的 `energyTargets` 具体偏移值未逐项对表，只保住了「偏移只碰恢复目标、不直接清空精力」这条不变量（selftest 11a–11c）。
