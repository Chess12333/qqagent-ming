// refactor/core/config-store/key-ledger.mjs —— 配置键台账（活键 / 死键）
//
// ★ 为什么台账要是**字面量数据**而不是运行时算出来的：
//   如果分类是 import 时现算的，那么"把某个活键在台账里改成死"这件事根本不会改变判定结果
//   ⇒ 牙就抓不住它自己 ⇒ 台账就成了摆设。所以这里锁死一份**手写台账**，
//   `verifyLedger()` 拿它去和**盘面真实情况**对账：对不上就红。
//
//   ★★ 语料**先剥注释再匹配**（`stripComments`，`readCorpus` 里接上）—— 注释不是读点，两个方向都骗：
//     · 假死：2026-10-10 实测 `modules/llm/final-body.js:155` 写了句「`api.costGuard.chatPromptMax`
//       全树零读点」（那是**文档**），牙④「死键的 needle 一次都不许出现」当场红 ⇒ 逼着人把死键标活。
//     · 假活：同一轮量出**9 行活键的 evidence 其实只在注释里**（如 `ui.navOrder` 指的
//       `plugin-loader.js:472` 是一句英文注释）。正是头注警告的那类危险方向，这次是扫描器自己造的。
//     剥注释只剥注释：字符串字面量原样留着（`'api.imageGate'` 这种是真代码），行号不漂。
//
//   ★★ 匹配走**独立标识符**而不是子串（`needleHits`）—— 同一台扫描器的第二种造假，N51 实测：
//     后缀式 needle 天生会被**更长的驼峰标识符**吃掉 ⇒ 量出 **4 行假活**：
//     `allCount` 撞 `toolCallCount`/`modelCallCount`/`callCount`（`store.allCount`+`store.private.allCount`
//     其实全树零读点 ⇒ 正是 E4「档位从读多少退化成读不读」那条票的同一族）、
//     `participation` 撞内部名 `participation_gate`、`api.textOnlyJudge` 撞兄弟键 `api.textOnlyJudgeLocal`（真读点在 compose.js）。
//     头注下面"两个已知方向性错误"讲的假活，**这次是扫描器自己造出来的**，比人写错更隐蔽。
//     ★ N73 跟进：那四行里 `store.allCount`/`store.private.allCount` 的**判死是对的**，但 E4 那族配额键
//     随后被 luna1 接通（`contextMessageCount` 用模板字符串拼 `store.${leaf}` ⇒ 带点号字面量永不出现）
//     ⇒ 现按**末段 needle + basis suffix** 记活，与 `store.private.contextTier` 同口径。
//     ★ 这颗牙盖不住的一类：字符串字面量里的连字符名（`'malformed-probability-distribution'` 含 `probability`）
//     两侧都不是标识符字符 ⇒ 仍算命中 ⇒ 单段通用名做 needle 一律不许（本轮人工降级 `sticker.autoPick.probability`）。
//
// ── 判定口径（`classifyKey` 的规则，牙与报告共用同一套）──
//   CORPUS = refactor/modules/ + refactor/apps/server/ 下的 *.js/*.mjs；
//            refactor/runtime/ 当前盘面缺失，存在时再显式加入；排除所有 selftest 命名的文件。
//   needle = 键名从长到短的第一个"采信得住"的后缀：
//     · 整条路径命中         ⇒ basis 'full'   （最强：字面量 cfg.get('api.model') 这类）
//     · 整条路径没命中 ⇒ 依次试更短后缀；采信条件 = 该后缀 ≥2 段（够具体）
//       或命中文件数 ≤ RARE（够独特）；'enabled' 这种到处都是的单段名**不采信**（采信了就是自欺）
//     · 一个都没采信到 ⇒ needle = 整条路径，basis 'none' ⇒ 判死
//   ★ N36 追加一种人工填的 basis：`'out-of-corpus'` —— 真读点确实存在，但住在 CORPUS_DIRS **之外**
//     （目前已知两处盲区：`refactor/core/**` 自己、`refactor/apps/ui|desktop/**`）。
//     这类行 kind 仍按**事实**填 live，evidence 填语料内**能证明链路接上了**的调用点，
//     真读点写进行内注释。⇒ 不许因为"扫不到"就把活键判死（那是本表头注警告的假死键）。
//
// ── 这张表的两个已知方向性错误（如实写在台账里，不藏）──
//   · **假活键**：消费者若经由"整块取 cfg.persona2 再点 .systemMode"访问，`persona2` 出现在某文件里
//     就可能被算成"有消费者"，而那一行其实读的是别的键。方向 = 把死键说成活的（危险：会掩盖缺口）。
//   · **假死键**：反过来，若整条路径不出现、且唯一可匹配的后缀是通用单段名（`enabled`/`port`/`timeoutMs`），
//     就会把活键判成死。方向 = 把活键说成死的（危险：会让人以为功能没了）。
//   ⇒ 报告 `.tmp-dispatch/v-死键台账.md` 把这两类**分别列出**，人工裁决以那份为准。
//     `RISK_GENERIC_LEAF` 标出来的是**已知的假死候选**（叶子名通用的死键）。

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
// refactor/runtime/ 在当前盘面不存在，不把一个会被静默跳过的目录写成扫描范围。
// ★ N36：语料范围是台账**最大的结构性盲区**，两个方向都错过，如实记在这里别当没发生：
//   ① 不在语料里的三处消费域 ⇒ 那里的读点一律看不见：
//      · `refactor/core/**`（本目录自己！deny.private 的真读点在 core/policy/allow-gate.js:27）
//      · `refactor/apps/ui/**`（19 个 ui.* 键的消费者全在 app.js）
//      · `refactor/apps/desktop/**`（server.autoStart/autoStartPeer/closeToTray、ui.desktopPetX/Y
//        的消费者全在 main.js；桌宠一族新树功能其实是完整的）
//      ⇒ 这三处的键**不许**因为"扫不到"就判死；用 basis 'out-of-corpus' + 行内注释写真读点。
//   ② 但 `refactor/apps/ui` **不能**直接加进 CORPUS_DIRS：app.js 是面板控件声明表，
//      里面写着大量 `path: 'localJev.roles'` 这类**字面键名**（app.js:2184/2193 实测），
//      那是"这个控件编辑哪个键"，不是运行时消费 ⇒ 加进去会一次性造出几十个**假活键**，
//      比现在的假死更危险（会掩盖真缺口）。要治得先让扫描区分"控件声明"与"读点"，那是另一张票。
export const CORPUS_DIRS = ['refactor/modules', 'refactor/apps/server'];
// 显式纳入 core 中唯一的配置兼容读点（旧 persona.ignoreSenderIds → 新 emotion.ignoreSenderIds）。
export const CORPUS_FILES = ['refactor/core/config-store/index.js'];
export const RARE = 4;                                  // 单段后缀的"够独特"门槛（命中文件数）
/** 叶子名通用的死键 = 假死候选（消费者可能走"整块取 cfg.x 再点 .enabled"） */
export const RISK_GENERIC_LEAF = ['enabled', 'disabled', 'port', 'timeoutMs', 'maxTokens', 'model', 'name', 'type', 'count', 'mode', 'url', 'id', 'key', 'value', 'path', 'list', 'text', 'provider', 'sources', 'feeds', 'width', 'height', 'gpuLayers', 'items', 'roles', 'stats', 'saved', 'seconds', 'ms', 'tokens', 'size', 'depth', 'apiKey', 'baseUrl', 'engine', 'hidden', 'min', 'max', 'priority'];

export function corpusFiles() {
  const out = [];
  for (const rel of CORPUS_DIRS) {
    const root = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(root)) continue;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        // ★ 排除所有 selftest 命名：包括 selftest.mjs、selftest-*.mjs 与 *.selftest.mjs。
        //   自测不是运行时消费者；纳入语料会制造假命中（如 memory/selftest-semantic-v0.mjs）。
        else if (/\.(js|mjs)$/.test(e.name) && !/^selftest[^/]*\.(js|mjs)$/i.test(e.name) && !/\.selftest\.(js|mjs)$/i.test(e.name)) out.push(path.relative(REPO_ROOT, full).replace(/\\/g, '/'));
      }
    };
    walk(root);
  }
  for (const rel of CORPUS_FILES) {
    if (fs.existsSync(path.join(REPO_ROOT, rel))) out.push(rel);
  }
  return out.sort();
}

export function suffixesOf(key) {
  const parts = key.split('.');
  const out = [];
  for (let i = 0; i < parts.length; i += 1) out.push(parts.slice(i).join('.'));
  return out;
}

/** 台账里每一行：{ key, kind: 'live'|'dead', needle, basis: 'full'|'suffix'|'parent'|'out-of-corpus'|'none', evidence: 相对仓库根的文件|null }
 *  ★ N36 追加的两种人工 basis（都是**两段式访问**逼出来的，见头注）：
 *    · `'parent'`        —— 父路径字面命中（`cfg.get('security.imageSend')` / `getConfig().security?.browseLock`），
 *                           叶子在同文件同处点取（`opt.enabled`）。字面全路径永不出现 ⇒ 机器判死，实际是活的。
 *    · `'out-of-corpus'` —— 真读点住在 CORPUS_DIRS 之外（`refactor/core/**`、`refactor/apps/ui|desktop/**`），
 *                           evidence 只能填语料内证明链路接上的调用点，真读点写进行内注释。
 *    · `'dynamic-index'` —— 键的最后一段是**运行时变量**（`getConfig()?.skills?.[String(id)]`），
 *                           字面全路径不可能出现；needle 记那段动态取法本身。
 *  ★ risk 追加两个值：`'legacy-alias'`（已被迁移成别的键，死得其所，**不进值得接线清单**）·
 *    `'inert-read'`（**有读点但功能仍是死的** ⇒ 要进值得接线清单。两种形态：① 读出来的值没人消费
 *      （`hypeMode.roleText` 只被压成布尔塞进一个没人看的快照）；② 读点本身取不到值
 *      （`vector.*` 走 `snapshot()[dottedKey]`，而 snapshot 返回的是信封 ⇒ 恒 undefined））·
 *    `'retired-role'`（两棵树都已退役，死得其所）·
 *    `'ui-label-only'`（纯显示名，两棵树都无人读 ⇒ 死得其所，不进清单）·
 *    `'out-of-corpus-consumer'`（消费者在 CORPUS_DIRS 之外：apps/ui、apps/desktop ⇒ **功能其实是通的**，
 *      kind 仍按台账口径记 dead，但报告必须靠这个 risk 把它们从"值得接线"里筛掉，见 :35 说明①②）。 */
export const KEY_LEDGER = [
  { key: "api.baseUrl", kind: 'live', needle: "api.baseUrl", basis: 'full', evidence: "refactor/apps/server/api/console.js" },
  { key: "api.apiKey", kind: 'live', needle: "api.apiKey", basis: 'full', evidence: "refactor/apps/server/api/console.js" },
  { key: "api.model", kind: 'live', needle: "api.model", basis: 'full', evidence: "refactor/apps/server/api/console.js" },
  { key: "api.provider", kind: 'live', needle: "api.provider", basis: 'full', evidence: "refactor/modules/llm/model-prices.js" },
  { key: "api.vision", kind: 'live', needle: "api.vision", basis: 'full', evidence: "refactor/modules/act/executors/media.js" },
  { key: "api.imageGate", kind: 'dead', needle: "api.imageGate", basis: 'none', evidence: null },
  // ★ N83 追加（2026-10-10 · qwen2，指挥位裁定"补"）：自动看图总开关**进主 DEFAULT_CONFIG**。
  //   这把键**一直有真读点**，缺的只是声明：`modules/orchestrator/compose.js:956`
  //   `cfg?.get?.('api.autoVision', true) === false` ⇒ 跳过（不下载、不附图）；老树同一口径
  //   `src/orchestrator.js:3061` `cfg.api?.autoVision !== false`；他们域里还有行为测试
  //   `modules/orchestrator/selftest.mjs:2459`（legacy opt-out）⇒ 判 live 是**事实**，不是背书。
  //   ⚠ 形状是**标量布尔**（照老树），不是 `api.autoVision.enabled`：那条路会让 :956 的 `=== false`
  //     静默失效（对象 ≠ false）⇒ 见 defaults.js 里那段的完整理由。
  { key: "api.autoVision", kind: 'live', needle: "api.autoVision", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js" },
  // ★ N83（2026-10-10 · qwen2）：自动看图的两道体积闸做成可调键。默认值 = sp2 在
  //   `modules/media/auto-vision.js` 里写死的常量（commit 9a898aff：AUTO_VISION_MAX_BYTES
  //   = 2MB / AUTO_VISION_MAX_TOTAL_CHARS = 3·1024·1024 字符）。
  //   读点已接：compose 读取配置并传 limits；auto-vision.js 的 attachTriggerImages
  //   未收到有效 limits 时通过 cfgLimit 读这两个键，非有限数或 ≤0 回落默认值。
  //   运行时读链：modules/orchestrator/compose.js:1773-1774 → modules/media/auto-vision.js:275/278。
  //   设置入口：`apps/ui/app.js:2286-2287` 开发者模式「表情与图片进阶」；通用 devCollectPatch 按同一路径
  //   收集并 POST `/api/config`。两项仍是 live，生成表会把它们列入已接入旋钮（运行时读链不变）。
  //   needle 用整条路径：`maxBytesMB` 这个叶子名已经被 `security.imageSend.maxBytesMB`
  //   当作 suffix needle 占着（:381），拿它做死键 needle 会一红撞两头。
  { key: "api.autoVisionMaxBytesMB", kind: 'live', needle: "api.autoVisionMaxBytesMB", basis: 'full', evidence: "refactor/modules/media/auto-vision.js" },
  { key: "api.autoVisionMaxTotalChars", kind: 'live', needle: "api.autoVisionMaxTotalChars", basis: 'full', evidence: "refactor/modules/media/auto-vision.js" },
  // ★ N36 回对：两段式访问（`getConfig().api?.disableThinking`，llm.js:497）⇒ 字面点路径永不出现，
  //   旧行判 dead 是**假死键**。needle 记属性访问形，与 :500 的 thinkingBudget 同族。
  { key: "api.disableThinking", kind: 'live', needle: "api?.disableThinking", basis: 'suffix', evidence: "refactor/modules/llm/llm.js" },
  { key: "api.thinkingBudget", kind: 'live', needle: "api.thinkingBudget", basis: 'full', evidence: "refactor/modules/llm/llm.js" },
  { key: "api.cacheMode", kind: 'live', needle: "api.cacheMode", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js" },
  // ★ 2026-10-17（开发者页待核项收口）：这 7 个键的真读点是 **父级子树 + 动态拼装** ——
  //   `keep-alive-runtime.js:101-106` 的 `readKeepAliveOptions()` 做
  //   `get(\`api.cacheKeepAlive.${key}\`, undefined)`（六个键同一入口）⇒ 任何"全路径字面量"
  //   needle 都撞不上，旧 basis:'suffix' 的"仅叶子撞名"结论对它们是**误判**（值确实从这棵子树读出）。
  //   basis 改 'parent' + needle 用**真实存在的前缀** `api.cacheKeepAlive.`；生成器按 needle 在
  //   evidence 文件里出现与否独立复核。
  { key: "api.cacheKeepAlive.enabled", kind: 'live', needle: "api.cacheKeepAlive.", basis: 'parent', evidence: "refactor/modules/llm/keep-alive-runtime.js", risk: 'generic-leaf' },
  { key: "api.cacheKeepAlive.intervalMs", kind: 'live', needle: "api.cacheKeepAlive.", basis: 'parent', evidence: "refactor/modules/llm/keep-alive-runtime.js" },
  { key: "api.cacheKeepAlive.maxPerChat", kind: 'live', needle: "api.cacheKeepAlive.", basis: 'parent', evidence: "refactor/modules/llm/keep-alive-runtime.js" },
  { key: "api.cacheKeepAlive.quietAfterMs", kind: 'live', needle: "api.cacheKeepAlive.", basis: 'parent', evidence: "refactor/modules/llm/keep-alive-runtime.js" },
  { key: "api.cacheKeepAlive.privateMaxPerChat", kind: 'live', needle: "api.cacheKeepAlive.", basis: 'parent', evidence: "refactor/modules/llm/keep-alive-runtime.js" },
  { key: "api.cacheKeepAlive.privateQuietAfterMs", kind: 'live', needle: "api.cacheKeepAlive.", basis: 'parent', evidence: "refactor/modules/llm/keep-alive-runtime.js" },
  { key: "api.cacheKeepAlive.minPrefixTokens", kind: 'live', needle: "api.cacheKeepAlive.", basis: 'parent', evidence: "refactor/modules/llm/keep-alive-runtime.js" },
  // ★ 遗留兼容键：主键是 `api.cacheMode`（migrations.js:181 把旧开关迁成它），
  //   老树也只在 cacheMode 缺失/非法时兜底 ⇒ **不是欠账**，不要在"值得接线"清单里出现。
  // ★ N51：原先判 dead（全语料零读点），luna1 接上 compose.js `markInitialSystemPrefix` 里
  //   `cacheMode` 取值不合法时的兜底读点 ⇒ 现判 live。含义不变，只是"兜底"真的有线了。
  { key: "api.explicitCache", kind: 'live', needle: "api.explicitCache", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js", risk: 'legacy-alias' },
  { key: "api.temperature", kind: 'live', needle: "api.temperature", basis: 'full', evidence: "refactor/modules/llm/llm.js" },
  { key: "api.topP", kind: 'live', needle: "api.topP", basis: 'full', evidence: "refactor/modules/llm/llm.js" },
  { key: "api.frequencyPenalty", kind: 'live', needle: "api.frequencyPenalty", basis: 'full', evidence: "refactor/modules/llm/llm.js" },
  { key: "api.presencePenalty", kind: 'live', needle: "api.presencePenalty", basis: 'full', evidence: "refactor/modules/llm/llm.js" },
  { key: "api.maxTokens", kind: 'live', needle: "api.maxTokens", basis: 'full', evidence: "refactor/modules/llm/llm.js" },
  // ★ sp3 回对（2026-10-11 · 功能表第 2 项「面板操作确实改变程序行为」）：这 3 行旧判 dead 是**假死**。
  //   消费者走「整块取 cfg 再点属性」：compose.js:189 `const options = cfg?.get?.('api.localReplyTrial', {}) ?? {}`，
  //   接着 :190 `options.enabled !== true`（不开 ⇒ 整段本地试跑不发）、:200 `options.maxTokens`、:203 `options.complexTokens`；
  //   调用点 compose.js:1115 `localReplyTrialBudget(cfg, kaApi, evidence)` ⇒ 值真实决定这轮给本地端点多少预算。
  //   整条点路径永不出现（needleHits 撞不上）⇒ 旧行被机器判死，面板 3 个控件（app.js:2328-2330）被真值表锁成 disabled。
  //   ⚠ `autoFinish` 仍判死：全树零读点（compose.js:721 读的是**另一个键** `api.autoFinish.enabled`）。
  { key: "api.localReplyTrial.enabled", kind: 'live', needle: "api.localReplyTrial", basis: 'parent', evidence: "refactor/modules/orchestrator/compose.js" },
  { key: "api.localReplyTrial.maxTokens", kind: 'live', needle: "api.localReplyTrial", basis: 'parent', evidence: "refactor/modules/orchestrator/compose.js" },
  { key: "api.localReplyTrial.complexTokens", kind: 'live', needle: "api.localReplyTrial", basis: 'parent', evidence: "refactor/modules/orchestrator/compose.js" },
  { key: "api.localReplyTrial.autoFinish", kind: 'dead', needle: "api.localReplyTrial.autoFinish", basis: 'none', evidence: null },
  { key: "api.autoFinish.enabled", kind: 'live', needle: "api.autoFinish.enabled", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js", risk: 'generic-leaf' },
  { key: "api.autoFinish.multiOnly", kind: 'live', needle: "api.autoFinish.multiOnly", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js" },
  { key: "api.finishRound.enabled", kind: 'live', needle: "api.finishRound.enabled", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js", risk: 'generic-leaf' },
  // ★ 2026-10-17（用户裁定）：`api.minToolCallsBeforeFinish` **只删面板控件**（apps/ui/app.js 的
  //   DEV_ITEMS 那一行已撤），底层兼容键与默认值（core/config-store/defaults.js:163）保留不动；
  //   台账仍判 dead —— 编排器零读点（`modules/orchestrator/selftest.mjs` 的"停用键不改变轮数/无读点"两条断言）。
  { key: "api.minToolCallsBeforeFinish", kind: 'dead', needle: "api.minToolCallsBeforeFinish", basis: 'none', evidence: null },
  { key: "api.tools", kind: 'live', needle: "api.tools", basis: 'full', evidence: "refactor/apps/server/api/shell.js" },
  // ★ 2026-10-11：api.maxRounds 已在 compose.js 作为单条消息的模型请求上限读取；使用完整键避免旧的短 needle 撞局部变量而假活。
  { key: "api.maxRounds", kind: 'live', needle: "api.maxRounds", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js" },
  // ★ 2026-10-13 判死（读点随 `7c7c0bf1 Stop body judge from vetoing drafted replies` 删除）：
  //   该提交让正文裁判不再否决成稿，连带删掉 compose.js 里
  //   `cfg?.get?.('api.nudgeTextOnly', true) !== false && !textOnlyNudgeUsed` 那行（原 :1402 一带）；
  //   全语料现在零命中（自测桩与面板声明不算读点）。默认值同笔从 defaults 移除；
  //   面板控件 `apps/ui/app.js:2328`「只写文字未发送时催一次」由 luna2 撤。
  { key: "api.nudgeTextOnly", kind: 'dead', needle: "api.nudgeTextOnly", basis: 'none', evidence: null },
  // ★ N51 复验：luna1 已接通（`compose.js` 的 `cfg?.get?.('api.replyReminder', true) !== false`，两处注入都听它）
  //   ⇒ 老树 `src/prompt.js:1986-1994` 的"最后一步硬要求"门在新树有了对位，不再是"无条件注入关不掉"。
  { key: "api.replyReminder", kind: 'live', needle: "api.replyReminder", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js" },
  { key: "api.conversationMemory.enabled", kind: 'live', needle: "api.conversationMemory.enabled", basis: 'full', evidence: "refactor/modules/prompt/index.js" },
  // ★ N36 回对：真读点在 act/executors/memory.js:165（`ctx.cfg.get('api.conversationMemory.maxSearchPerRun', 3)`）
  //   ⇒ 旧行判 dead 是假死键。缺省口径（2026-10-12 用户裁定 5→3）：新树 defaults 与代码兜底**都是 3**
  //   （改前 defaults 写 5、代码兜底写 3，两边不一致 ⇒ 现场按合并后的 5 跑）；老树配置默认仍是 5
  //   （src/config.js:297）。⚠ 界面保存过的旧值优先于缺省（mergeConfig 合并口径），改缺省不覆盖已存值。
  { key: "api.conversationMemory.maxSearchPerRun", kind: 'live', needle: "api.conversationMemory.maxSearchPerRun", basis: 'full', evidence: "refactor/modules/act/executors/memory.js" },
  // ★ 2026-10-15 转活（7ece7e76 把三段动态记忆纳入 prompt 最终 userSections 白名单后复核）：
  //   · 读点：`modules/orchestrator/compose.js:2041-2050` 用这两个键 gate「问旧事·硬要求 / 本地预检索线索」
  //     两段文案的生产（memory-recall.js 拼装）；放行：`modules/prompt/index.js:956-959` 白名单已收录
  //     'memory-recall-reminder' / 'memory-prefetch' ⇒ 经 applyRequestBudget 后进最终 user 段（:993-994）。
  //   · **条件/预算型生效**（不是无条件每轮出现）：只在触发文本命中「问旧事」词表的那一轮产生文案；
  //     预算超限时两段都是 droppable（PRIORITY.MEMORY / EXTRA），会被整段丢弃（budget.js:149-168，diagnostics.trimmed 留痕）。
  { key: "api.memoryRecallReminder", kind: 'live', needle: "api.memoryRecallReminder", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js" },
  { key: "api.memoryAutoPrefetch", kind: 'live', needle: "api.memoryAutoPrefetch", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js" },
  // ★ N51 回对（2026-10-10）：牙④当场红了这三行 —— media 席位 N58 把接梗闸门搬进了
  //   `modules/media/meme-cue.js`（`read('api.memeAutoCue', true)` / `read('api.memeCueMinScore', 2.2)` /
  //   `read('api.memeCuePlayfulOnly', true)`，三个键都是**真读点**且默认值与老树一致）⇒ 旧行判 dead 是**过时**，不是判错。
  //   台账跟着现实改；老树参照点 `src/orchestrator.js` 的同一套判据（总闸 !== false / 前置闸 === false 才关 / 非有限数回退 2.2）。
  { key: "api.memeAutoCue", kind: 'live', needle: "api.memeAutoCue", basis: 'full', evidence: "refactor/modules/media/meme-cue.js" },
  { key: "api.memeCueMinScore", kind: 'live', needle: "api.memeCueMinScore", basis: 'full', evidence: "refactor/modules/media/meme-cue.js" },
  { key: "api.memeCuePlayfulOnly", kind: 'live', needle: "api.memeCuePlayfulOnly", basis: 'full', evidence: "refactor/modules/media/meme-cue.js" },
  // 读点 refactor/apps/server/assembly.js:850；消费 refactor/modules/memory/working-window.js:82-83/132（enabled 参与 verdict）
  { key: "api.architecture.crossTurnWorking", kind: 'live', needle: "api.architecture.crossTurnWorking", basis: 'full', evidence: "refactor/apps/server/assembly.js" },
  // ★ 2026-10-17（用户裁定 · 保留并接线）：两条都改成**全路径 + compose 真读点**证据。
  //   · `semanticCards`：compose.js:2579 `cfg?.get?.('api.architecture.semanticCards', false) === true`
  //     是出模的真闸（关掉不出卡）——旧行只记 suffix 撞 console-api 子树 ⇒ 面板一直挂"接线待核"，现已不成立。
  //   · `semanticTopN`：compose.js:2593 真读，且 2026-10-17 起语义是 **0~8 有界整数**（缺失/非法才回默认 2；
  //     **0 = 真不注入**，不再被 `Math.min(4, Number(...) || 2)` 夹成 2），上限同时约束
  //     "向量卡 + 旧匹配卡"合并后的最终注入总数 ⇒ 旧行判 dead 是**过时**。
  { key: "api.architecture.semanticCards", kind: 'live', needle: "api.architecture.semanticCards", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js" },
  { key: "api.architecture.semanticTopN", kind: 'live', needle: "api.architecture.semanticTopN", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js" },
  // ── ★ 短时跨群感知（老树旁听）整块：用户 2026-10-11 决定废弃 ────────────────
  //   用户原话：「短期记忆这个删了吧，新架构肯定是要重新定义的。」
  //   处置：设置页入口（开发者页 5 个 + 设置页 2 个复选框）由 luna2 删除；
  //   **配置文件里的值保留不动**（旧版本回退还要用），所以这里只标 `risk: 'deprecated'`，
  //   不删行、不改 kind（仍是 dead：新树本来就没有代码读它们）。
  //   面板侧读法：真值表里这几项显示「已废弃」而不是普通「死键」。
  { key: "api.architecture.crossChatAwareness", kind: 'dead', needle: "api.architecture.crossChatAwareness", basis: 'none', evidence: null, risk: 'deprecated' },
  { key: "api.architecture.crossChatMinutes", kind: 'dead', needle: "api.architecture.crossChatMinutes", basis: 'none', evidence: null, risk: 'deprecated' },
  { key: "api.architecture.crossChatMaxChats", kind: 'dead', needle: "api.architecture.crossChatMaxChats", basis: 'none', evidence: null, risk: 'deprecated' },
  { key: "api.architecture.crossChatMaxChars", kind: 'dead', needle: "api.architecture.crossChatMaxChars", basis: 'none', evidence: null, risk: 'deprecated' },
  { key: "api.architecture.crossChatRoutes", kind: 'dead', needle: "api.architecture.crossChatRoutes", basis: 'none', evidence: null, risk: 'deprecated' },
  { key: "api.architecture.crossChatIncludePrivate", kind: 'dead', needle: "api.architecture.crossChatIncludePrivate", basis: 'none', evidence: null, risk: 'deprecated' },
  { key: "api.architecture.crossChatInPrivateChat", kind: 'dead', needle: "api.architecture.crossChatInPrivateChat", basis: 'none', evidence: null, risk: 'deprecated' },
  // 读点 refactor/apps/server/assembly.js:851；消费 refactor/modules/memory/working-window.js:84-85/134（TTL 参与 verdict）
  { key: "api.architecture.workingTtlMin", kind: 'live', needle: "api.architecture.workingTtlMin", basis: 'full', evidence: "refactor/apps/server/assembly.js" },
  // 读点 refactor/apps/server/assembly.js:852；消费 refactor/modules/memory/working-window.js:86-87/142（衰减周期参与判断）
  { key: "api.architecture.workingDecayMin", kind: 'live', needle: "api.architecture.workingDecayMin", basis: 'full', evidence: "refactor/apps/server/assembly.js" },
  // 读点及预算消费 refactor/modules/prompt/index.js:299-303
  { key: "api.architecture.workingMaxChars", kind: 'live', needle: "api.architecture.workingMaxChars", basis: 'full', evidence: "refactor/modules/prompt/index.js" },
  // ★ N51 复验：luna1 已接通（`compose.js` 读该开关后调 `memory.todos.renderTodosForPrompt(chatKey)`）
  //   ⇒ N36 记的"半件已在、只差注入调用点 + 读开关"这轮补齐了（老树 arch.js:88 → renderTodosForPrompt）。
  { key: "api.architecture.pendingTodos", kind: 'live', needle: "api.architecture.pendingTodos", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js" },
  // ★ B7（2026-10-11 用户裁定）：成本护栏改成**一个日上限、度量 = 当日 prompt+completion token**。
  //   新键由 `console-api.js` 的 getCostGuard 读（`cs.get('api.costGuard')` 整块取 → 点 `.dayTokenMax`），
  //   判定的真正消费者在 `orchestrator/compose.js`（luna2 那半）—— 上线后那边也会有读点。
  { key: "api.costGuard.dayTokenMax", kind: 'live', needle: "api.costGuard", basis: 'parent', evidence: "refactor/apps/server/console-api.js" },
  { key: "api.costGuard.enabled", kind: 'live', needle: "api.costGuard", basis: 'parent', evidence: "refactor/apps/server/console-api.js" },
  // ↓ 旧键：迁移来源（migrations.js 的 migrateCostGuardTokenMax 读 dayPromptMax），
  //   **不再参与判定**（chatPromptMax 的干预按裁定去掉）⇒ 按事实记 dead。
  //   ⚠ 它们仍在 DEFAULT_CONFIG 里（留档 + 迁移来源），但代码不读 ⇒ 面板控件会被锁成"死键"，
  //     这是**诚实信号**：改它们不再影响任何行为。
  { key: "api.costGuard.dayPromptMax", kind: 'dead', needle: "api.costGuard.dayPromptMax", basis: 'none', evidence: null },
  { key: "api.costGuard.chatPromptMax", kind: 'dead', needle: "api.costGuard.chatPromptMax", basis: 'none', evidence: null },
  // ★ 2026-10-12（指挥位裁定）：预算**硬额度**两个键，与上面的软阈值 `api.costGuard.*` 分开记账。
  //   读点与上面两行同构：`console-api.js` 的 getCostGuard 用 `cs.get('api.budget')` 整块取再点字段。
  //   生产装配在 `apps/server/assembly.js` 创建预算服务；`hardLimitTokens=null` 表示不设全局硬上限，
  //   付费请求仍会继续，已配置的 `instanceShares` 仍单独限制实例。软阈值 `dayTokenMax` 不代替硬额度。
  //   ★ 2026-10-18（用户追加）：**出厂默认就是 null = 无限**（defaults.js 的 api.budget.hardLimitTokens）；
  //   core/budget 对 null 只在首次预留时记一条提示，reserve 直接放行（index.js:294-295/339）；0/NaN/超大数字都不是
  //   "无限"的写法（0 = 拒绝所有正估算请求，NaN/'abc' = invalid 走 fail-closed，UI 侧 min=1 + 留空=null）。
  //   显式设置的有限额度**保留**（不迁移、不清理：老安装的 1000 万等值原样生效，直到用户自己清空）。
  { key: "api.budget.hardLimitTokens", kind: 'live', needle: "api.budget", basis: 'parent', evidence: "refactor/apps/server/console-api.js" },
  { key: "api.budget.instanceShares", kind: 'live', needle: "api.budget", basis: 'parent', evidence: "refactor/apps/server/console-api.js" },
  // ★ N51 回对：evidence 原先写 `platform/salvage.js`，那里只有**兄弟键** `api.textOnlyJudgeLocal`/`…Tokens`
  //   （子串匹配把 `api.textOnlyJudge` 算成命中 ⇒ 假证据）。真读点：`compose.js` 的 `cfg?.get?.('api.textOnlyJudge', true)`。
  { key: "api.textOnlyJudge", kind: 'live', needle: "api.textOnlyJudge", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js" },
  // ★ N73 复验：同一个 commit `f5de1644` 接上（compose.js:1362 `cfg?.get?.('api.protocolRecovery', false) === true`）
  //   ⇒ 老树"成品没走 send_message 时按判官结论补发"的兜底开关有了对位；**缺省 false（要显式开）**，与老树一致。
  { key: "api.protocolRecovery", kind: 'live', needle: "api.protocolRecovery", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js" },
  { key: "api.textOnlyJudgeTokens", kind: 'live', needle: "api.textOnlyJudgeTokens", basis: 'full', evidence: "refactor/modules/platform/salvage.js" },
  { key: "api.textOnlyJudgeLocal", kind: 'live', needle: "api.textOnlyJudgeLocal", basis: 'full', evidence: "refactor/modules/platform/salvage.js" },
  // ★ 2026-10-13 判死（同 `7c7c0bf1`）：正文裁判不再否决成稿 ⇒ "裁判不可用就盲发"的兜底失去前提，
  //   compose.js 里那行 `cfg?.get?.('api.textOnlyFallback', true) !== false` 已随该提交删除，全语料零命中。
  //   默认值同笔从 defaults 移除；面板控件 `apps/ui/app.js:2333`「纯文本兜底发送」由 luna2 撤。
  { key: "api.textOnlyFallback", kind: 'dead', needle: "api.textOnlyFallback", basis: 'none', evidence: null },
  { key: "api.timeoutMs", kind: 'live', needle: "api.timeoutMs", basis: 'full', evidence: "refactor/modules/llm/llm.js" },
  { key: "api.priceInputPerM", kind: 'live', needle: "api.priceInputPerM", basis: 'full', evidence: "refactor/modules/llm/model-prices.js" },
  { key: "api.priceOutputPerM", kind: 'live', needle: "api.priceOutputPerM", basis: 'full', evidence: "refactor/modules/llm/model-prices.js" },
  { key: "api.priceCachedPerM", kind: 'live', needle: "api.priceCachedPerM", basis: 'full', evidence: "refactor/modules/llm/model-prices.js" },
  { key: "api.useOfficialPrice", kind: 'live', needle: "api.useOfficialPrice", basis: 'full', evidence: "refactor/modules/llm/model-prices.js" },
  { key: "api.priceRemoteUrl", kind: 'live', needle: "api.priceRemoteUrl", basis: 'full', evidence: "refactor/apps/server/api/console.js" },
  { key: "api.modelPrices", kind: 'live', needle: "api.modelPrices", basis: 'full', evidence: "refactor/modules/llm/model-prices.js" },
  { key: "providers", kind: 'live', needle: "providers", basis: 'full', evidence: "refactor/apps/server/api/console.js" },
  { key: "dshProviderKeys", kind: 'live', needle: "dshProviderKeys", basis: 'full', evidence: "refactor/apps/server/console-api.js" },
  // ★ 2026-10-12（P1 消重的连带更正）：这个键原来的唯一读点在 `api/console.js` 的
  //   `GET /api/providers` 分支（`source: cfgGet(ctx, 'providersSourceYaml', undefined)`）。
  //   那份实现与总分表同路径、**从未被问到**；P1 退掉（return null）后，连文本读点也没了
  //   ⇒ 全树只剩 `core/config-store/defaults.js` 的默认值定义（语料按全路径排除该文件）
  //   ⇒ 如实记 dead（生效的 `GET /api/providers` 回 `[ok, providers]`，本来就没有 source 键，
  //   界面也不读它）。
  { key: "providersSourceYaml", kind: 'dead', needle: "providersSourceYaml", basis: 'none', evidence: null },
  { key: "providersImported", kind: 'dead', needle: "providersImported", basis: 'none', evidence: null },
  // ★ N51 复验：luna1 补上了**情绪总闸**（`orchestrator/index.js` 的 `readConfig(cfg, 'emotion.enabled', true) !== false`）
  //   ⇒ 老树 `src/bot-state.js:894-902` 那处"一处收口断掉全部情绪写入"在新树有了对位（N36 A#7 说的"整套在跑却没有总闸"已不成立）。
  { key: "emotion.enabled", kind: 'live', needle: "emotion.enabled", basis: 'full', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "emotion.ignoreSenderIds", kind: 'live', needle: "emotion.ignoreSenderIds", basis: 'full', evidence: "refactor/modules/orchestrator/index.js" },
  // ★ 2026-10-17（待核项收口）：真读点是 `emotion/apply.js` 里**传入的 emotion 子树对象**上的
  //   `config.ramp`（同文件 :273 读正向的 `config.posRamp`）⇒ 不是"只按叶子名撞上别的子树"。
  //   basis 改 'parent'、needle 用真实存在的 `config.ramp`（生成器按它在 evidence 文件里出现与否复核）。
  { key: "emotion.ramp", kind: 'live', needle: "config.ramp", basis: 'parent', evidence: "refactor/modules/emotion/apply.js" },
  { key: "emotion.posRamp", kind: 'live', needle: "config.posRamp", basis: 'parent', evidence: "refactor/modules/emotion/apply.js" },
  // 活性档位随整块 emotion 配置传给 apply.js；resolveActivityConfig 读取 config.amplitudeLevel / config.decayLevel。
  { key: "emotion.amplitudeLevel", kind: 'live', needle: "config.amplitudeLevel", basis: 'parent', evidence: "refactor/modules/emotion/apply.js" },
  { key: "emotion.decayLevel", kind: 'live', needle: "config.decayLevel", basis: 'parent', evidence: "refactor/modules/emotion/apply.js" },
  // ★ 2026-10-15（用户裁定：assembly 撤掉旧本地/独立云 JEV 模型；本单按**当前生产调用点**逐键裁定）：
  //   旧模型整块已无读点 —— `localJev.enabled/port/modelPath/modelId/gpuLayers` 与 `localJev.cloud.*`
  //   那批（原 evidence=assembly.js，旧装配段已删）全判 dead；值仍留在配置文件里供回退（口径：不删键）。
  //   仍在**真读**的行保持 live：
  //     · localJev.judgeMode.enabled → orchestrator/index.js:870/3673/4953（另 assembly.js:1289 也读）
  //     · localJev.judgeTimeoutMs    → assembly.js:1236（云判定单次预算 configure，2026-10-15 补回）
  //     · localJev.replyChance.cooldownMs / maxPerHour → plan/index.js:396/401
  //   同族**撞名假活**（与 N36 的 quiet/busy 族同形态，证据指向的文件读的其实是别人的字段）一并判死：
  //     · minConfidence ← memory/index.js:598 的检索请求字段 `need.minConfidence`
  //     · minMargin     ← jev/engine.js:219 的角色默认值 `role.minMargin`
  //     · inputMaxChars ← jev/core.js:145 的角色默认值 `role.inputMaxChars`
  { key: "localJev.enabled", kind: 'dead', needle: "'localJev.enabled'", basis: 'none', evidence: "旧本地/独立云 JEV 模型已由 assembly 撤除（2026-10-15），全树零读点", risk: 'retired-role' },
  // ★ 2026-10-18（合同 #1）：本键语义收口为**云裁判全局请求总闸** —— 关闭 = 自由接话/聚焦续聊/
  //   记忆补判都不发起云判定请求（orchestrator 的 R01 收口在读；默认保持 false，旧配置显式 true 保留）。
  { key: "localJev.judgeMode.enabled", kind: 'live', needle: "localJev.judgeMode.enabled", basis: 'full', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "localJev.startOnLaunch", kind: 'dead', needle: "localJev.startOnLaunch", basis: 'none', evidence: null },
  { key: "localJev.port", kind: 'dead', needle: "'localJev.port'", basis: 'none', evidence: "旧本地 JEV 已撤（2026-10-15），全树零读点", risk: 'retired-role' },
  { key: "localJev.modelPath", kind: 'dead', needle: "'localJev.modelPath'", basis: 'none', evidence: "旧本地 JEV 已撤（2026-10-15），全树零读点", risk: 'retired-role' },
  { key: "localJev.exePath", kind: 'dead', needle: "localJev.exePath", basis: 'none', evidence: null },
  { key: "localJev.modelId", kind: 'dead', needle: "'localJev.modelId'", basis: 'none', evidence: "旧本地 JEV 已撤（2026-10-15），全树零读点", risk: 'retired-role' },
  { key: "localJev.ctxSize", kind: 'dead', needle: "localJev.ctxSize", basis: 'none', evidence: null },
  { key: "localJev.maxTokens", kind: 'dead', needle: "localJev.maxTokens", basis: 'none', evidence: null, risk: 'generic-leaf' },
  { key: "localJev.gpuLayers", kind: 'dead', needle: "'localJev.gpuLayers'", basis: 'none', evidence: "旧本地 JEV 已撤（2026-10-15），全树零读点", risk: 'retired-role' },
  { key: "localJev.minConfidence", kind: 'dead', needle: "'localJev.minConfidence'", basis: 'none', evidence: "撞名假活：原 evidence 的 memory/index.js:598 读的是检索 need.minConfidence" },
  { key: "localJev.minMargin", kind: 'dead', needle: "'localJev.minMargin'", basis: 'none', evidence: "撞名假活：原 evidence 的 jev/engine.js:219 用的是 role.minMargin 默认值" },
  { key: "localJev.useGrammar", kind: 'dead', needle: "localJev.useGrammar", basis: 'none', evidence: null },
  { key: "localJev.maxInflight", kind: 'dead', needle: "localJev.maxInflight", basis: 'none', evidence: null },
  { key: "localJev.maxQueue", kind: 'dead', needle: "localJev.maxQueue", basis: 'none', evidence: null },
  { key: "localJev.inputMaxChars", kind: 'dead', needle: "'localJev.inputMaxChars'", basis: 'none', evidence: "撞名假活：原 evidence 的 jev/core.js:145 用的是 role.inputMaxChars 默认值" },
  { key: "localJev.judgeTimeoutMs", kind: 'live', needle: "localJev.judgeTimeoutMs", basis: 'full', evidence: "refactor/apps/server/assembly.js" },
  // 2026-10-16 C10: judge-only thinking tri-state.
  //   true/'off' = ask for closed thinking; 'on' = explicitly enable (a real enable field is sent
  //   for known styles); false/null/other = inherit the global api.disableThinking setting.
  //   The adapter injects a provider-specific field only for known styles; unknown styles stay neutral.
  { key: "localJev.judgeDisableThinking", kind: 'live', needle: "localJev.judgeDisableThinking", basis: 'full', evidence: "refactor/apps/server/assembly.js" },
  // ★ 2026-10-16（用户令：判定可单独指定厂商）：独立判定身份（provider/baseURL/model/key 同源解析）。
  { key: "localJev.judgeApi.mode", kind: 'live', needle: "localJev.judgeApi.mode", basis: 'full', evidence: "refactor/apps/server/assembly.js" },
  { key: "localJev.judgeApi.providerId", kind: 'live', needle: "localJev.judgeApi.providerId", basis: 'full', evidence: "refactor/apps/server/assembly.js" },
  { key: "localJev.judgeApi.model", kind: 'live', needle: "localJev.judgeApi.model", basis: 'full', evidence: "refactor/apps/server/assembly.js" },
  // 判定输出预算（max_tokens）：合法区间 **128..1024**（modules/jev/core.js 的 JUDGE_OUTPUT_MIN/MAX）——
  //   上界由"输入上界 + 输出 ≤ 2000"的联合硬上限推出（最小判定输入上界 ≈ 880，1024+880 ≤ 2000），
  //   保证合法配置不会出现"必定不发"；比配置更大的请求由适配器按判据侧上限夹住并标 clamped。
  { key: "localJev.judgeMaxTokens", kind: 'live', needle: "localJev.judgeMaxTokens", basis: 'full', evidence: "refactor/apps/server/assembly.js" },
  // ★ 2026-10-18（合同 #4：可编辑裁判业务提示词）：空串 = 内置默认（jev/judge.js 的 JUDGE_PROMPT，
  //   已按用户口径放宽）；非空 = 自定义业务判据。判据经**既有配置注入**进 jev（configure({judgePrompt})，
  //   judge.js 在 renderJudgePrompt 内读取并在预算内按 utf8 字节夹取）；固定 JSON 尾注/字段校验/
  //   预算/授权边界不受自定义文本影响。装配层还需一行接线（assembly.js，归 ds1；本批 ds2 未改该文件）：
  //   `judgePrompt: configStore.get('localJev.judgeMode.prompt', '')`。
  //   ⚠ 接线前生成物里的 readers 只有台账自身的自匹配命中（生成器把 key-ledger.mjs 计入扫描面，
  //   对既有 full 行同样成立），不算真实读点证据；接线后 assembly.js 会真实命中。
  { key: "localJev.judgeMode.prompt", kind: 'live', needle: "localJev.judgeMode.prompt", basis: 'full', evidence: "refactor/apps/server/assembly.js" },
  // ★ 2026-10-17（用户令：每厂商缓存策略）：`providers[].cacheStrategy` 按 provider id 各存一份，
  //   枚举 auto/deepseek/dashscope/zhipu/mimo/compatible（缺省 auto）；读时由
  //   core/config-store/index.js 的 readProviderCacheStrategy() 归一（非法回 auto + 原因）。
  //   真读点：apps/server/console-api.js 的 GET /api/providers（回显归一值）与 /api/status 的
  //   cacheStrategyState（复用 modules/llm 公开出口 cacheProfileFor/cacheDecisionFor 做同一次决策）。
  //   只影响缓存参数；api.cacheMode / api.cacheKeepAlive.* 的用户值保持原样，不因此自动开保温。
  { key: "providers[].cacheStrategy", kind: 'live', needle: "cacheStrategy", basis: 'parent', evidence: "refactor/apps/server/console-api.js" },
  { key: "localJev.gateBudgetMs", kind: 'dead', needle: "localJev.gateBudgetMs", basis: 'none', evidence: null },
  { key: "localJev.ensureBudgetMs", kind: 'dead', needle: "localJev.ensureBudgetMs", basis: 'none', evidence: null },
  { key: "localJev.cloud.enabled", kind: 'dead', needle: "'localJev.cloud.enabled'", basis: 'none', evidence: "独立云 JEV 模型已由 assembly 撤除（2026-10-15），全树零读点", risk: 'retired-role' },
  { key: "localJev.cloud.baseUrl", kind: 'dead', needle: "'localJev.cloud.baseUrl'", basis: 'none', evidence: "独立云 JEV 已撤（2026-10-15），全树零读点", risk: 'retired-role' },
  { key: "localJev.cloud.apiKey", kind: 'dead', needle: "'localJev.cloud.apiKey'", basis: 'none', evidence: "独立云 JEV 已撤（2026-10-15），全树零读点", risk: 'retired-role' },
  { key: "localJev.cloud.model", kind: 'dead', needle: "'localJev.cloud.model'", basis: 'none', evidence: "独立云 JEV 已撤（2026-10-15），全树零读点", risk: 'retired-role' },
  { key: "localJev.cloud.timeoutMs", kind: 'dead', needle: "'localJev.cloud.timeoutMs'", basis: 'none', evidence: "独立云 JEV 已撤（2026-10-15），全树零读点", risk: 'retired-role' },
  { key: "localJev.cloud.upgradeBelow", kind: 'dead', needle: "localJev.cloud.upgradeBelow", basis: 'none', evidence: null },
  { key: "localJev.cloud.minConfidence", kind: 'dead', needle: "'localJev.cloud.minConfidence'", basis: 'none', evidence: "独立云 JEV 已撤 + 撞名假活（原 evidence 读的是检索 need.minConfidence）", risk: 'retired-role' },
  { key: "localJev.cloud.assumeP", kind: 'dead', needle: "'localJev.cloud.assumeP'", basis: 'none', evidence: "独立云 JEV 已撤（2026-10-15），全树零读点", risk: 'retired-role' },
  { key: "localJev.cloud.roles", kind: 'dead', needle: "'localJev.cloud.roles'", basis: 'none', evidence: "独立云 JEV 已撤（2026-10-15），全树零读点", risk: 'retired-role' },
  { key: "localJev.cloud.priceInPerM", kind: 'dead', needle: "localJev.cloud.priceInPerM", basis: 'none', evidence: null },
  { key: "localJev.cloud.priceOutPerM", kind: 'dead', needle: "localJev.cloud.priceOutPerM", basis: 'none', evidence: null },
  { key: "localJev.cloud.maxPerMinute", kind: 'dead', needle: "'localJev.cloud.maxPerMinute'", basis: 'none', evidence: "独立云 JEV 已撤（2026-10-15），全树零读点", risk: 'retired-role' },
  { key: "localJev.secondary.enabled", kind: 'dead', needle: "localJev.secondary.enabled", basis: 'none', evidence: null, risk: 'generic-leaf' },
  { key: "localJev.secondary.modelPath", kind: 'dead', needle: "localJev.secondary.modelPath", basis: 'none', evidence: null },
  { key: "localJev.secondary.modelId", kind: 'dead', needle: "localJev.secondary.modelId", basis: 'none', evidence: null },
  { key: "localJev.secondary.port", kind: 'dead', needle: "localJev.secondary.port", basis: 'none', evidence: null, risk: 'generic-leaf' },
  { key: "localJev.secondary.ctxSize", kind: 'dead', needle: "localJev.secondary.ctxSize", basis: 'none', evidence: null },
  { key: "localJev.secondary.gpuLayers", kind: 'dead', needle: "localJev.secondary.gpuLayers", basis: 'none', evidence: null, risk: 'generic-leaf' },
  { key: "localJev.secondary.roles", kind: 'dead', needle: "localJev.secondary.roles", basis: 'none', evidence: null, risk: 'generic-leaf' },
  { key: "localJev.vision.enabled", kind: 'dead', needle: "localJev.vision.enabled", basis: 'none', evidence: null, risk: 'generic-leaf' },
  { key: "localJev.vision.mmprojPath", kind: 'dead', needle: "localJev.vision.mmprojPath", basis: 'none', evidence: null },
  { key: "localJev.vision.port", kind: 'dead', needle: "localJev.vision.port", basis: 'none', evidence: null, risk: 'generic-leaf' },
  { key: "localJev.vision.ctxSize", kind: 'dead', needle: "localJev.vision.ctxSize", basis: 'none', evidence: null },
  { key: "localJev.vision.gpuLayers", kind: 'dead', needle: "localJev.vision.gpuLayers", basis: 'none', evidence: null, risk: 'generic-leaf' },
  { key: "localJev.vision.maxTokens", kind: 'dead', needle: "localJev.vision.maxTokens", basis: 'none', evidence: null, risk: 'generic-leaf' },
  // ★ 2026-10-17（用户裁定：全局/逐群「云裁判 vs 随机回复」）：新键 `store.replyMode` 是唯一模式开关；
  //   本旧键改为**有界兼容读** —— 仅在新键未显式配置（effective.source === 'default'）时参考它，
  //   新键显式值（含单群覆盖）永远优先，旧值不能盖新控件。读点：orchestrator/index.js 的 resolveReplyMode。
  { key: "localJev.replyChance.mode", kind: 'live', needle: "localJev.replyChance.mode", basis: 'full', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "localJev.replyChance.enabled", kind: 'dead', needle: "localJev.replyChance.enabled", basis: 'none', evidence: null, risk: 'generic-leaf' },
  { key: "localJev.replyChance.minConfidence", kind: 'dead', needle: "'localJev.replyChance.minConfidence'", basis: 'none', evidence: "撞名假活：原 evidence 的 memory/index.js:598 读的是检索 need.minConfidence" },
  { key: "localJev.replyChance.minMargin", kind: 'dead', needle: "'localJev.replyChance.minMargin'", basis: 'none', evidence: "撞名假活：原 evidence 的 jev/engine.js:219 用的是 role.minMargin 默认值" },
  { key: "localJev.replyChance.cooldownMs", kind: 'live', needle: "localJev.replyChance.cooldownMs", basis: 'full', evidence: "refactor/modules/plan/index.js" },
  { key: "localJev.replyChance.maxPerHour", kind: 'live', needle: "localJev.replyChance.maxPerHour", basis: 'full', evidence: "refactor/modules/plan/index.js" },
  { key: "localJev.replyChance.prefilter", kind: 'dead', needle: "localJev.replyChance.prefilter", basis: 'none', evidence: null },
  { key: "localJev.replyChance.cloudVerify", kind: 'dead', needle: "localJev.replyChance.cloudVerify", basis: 'none', evidence: null },
  { key: "localJev.replyChance.doubleAsk", kind: 'dead', needle: "localJev.replyChance.doubleAsk", basis: 'none', evidence: null },
  { key: "localJev.replyChance.adaptive.enabled", kind: 'dead', needle: "localJev.replyChance.adaptive.enabled", basis: 'none', evidence: null, risk: 'generic-leaf' },
  { key: "localJev.replyChance.adaptive.windowMinutes", kind: 'dead', needle: "localJev.replyChance.adaptive.windowMinutes", basis: 'none', evidence: null },
  { key: "localJev.replyChance.adaptive.fullRate", kind: 'dead', needle: "localJev.replyChance.adaptive.fullRate", basis: 'none', evidence: null },
  { key: "localJev.replyChance.adaptive.fullSpeakers", kind: 'dead', needle: "localJev.replyChance.adaptive.fullSpeakers", basis: 'none', evidence: null },
  // ★ N36 回对（**假活键**，一次性纠 11 行）：下面 quiet/busy/burstJudge 的 minConfidence·minMargin·
  //   cooldownMs·maxPerHour 旧行全是 basis:'suffix' 撞通用叶子名（memory/index.js 的 minConfidence、
  //   jev/engine.js 的 minMargin、stickers.js 的 cooldownMs、plan/index.js 的 maxPerHour），**与本键无关**。
  //   实查：`burstJudge` 与 `replyChance.adaptive` 在语料里**零命中**（grep 全空）；adaptive 依赖的
  //   computeGroupHeat 未搬 ⇒ 新树无 heat 概念，静态阈值读点在 plan/index.js:264-273，不读这 11 个键。
  //   needle 一律改成带引号的全路径（= 真实 `cfg.get('…')` 读点的形状），谁接线了就红。
  { key: "localJev.replyChance.adaptive.quiet.minConfidence", kind: 'dead', needle: "'localJev.replyChance.adaptive.quiet.minConfidence'", basis: 'none', evidence: null },
  { key: "localJev.replyChance.adaptive.quiet.minMargin", kind: 'dead', needle: "'localJev.replyChance.adaptive.quiet.minMargin'", basis: 'none', evidence: null },
  { key: "localJev.replyChance.adaptive.quiet.cooldownMs", kind: 'dead', needle: "'localJev.replyChance.adaptive.quiet.cooldownMs'", basis: 'none', evidence: null },
  { key: "localJev.replyChance.adaptive.quiet.maxPerHour", kind: 'dead', needle: "'localJev.replyChance.adaptive.quiet.maxPerHour'", basis: 'none', evidence: null },
  { key: "localJev.replyChance.adaptive.busy.minConfidence", kind: 'dead', needle: "'localJev.replyChance.adaptive.busy.minConfidence'", basis: 'none', evidence: null },
  { key: "localJev.replyChance.adaptive.busy.minMargin", kind: 'dead', needle: "'localJev.replyChance.adaptive.busy.minMargin'", basis: 'none', evidence: null },
  { key: "localJev.replyChance.adaptive.busy.cooldownMs", kind: 'dead', needle: "'localJev.replyChance.adaptive.busy.cooldownMs'", basis: 'none', evidence: null },
  { key: "localJev.replyChance.adaptive.busy.maxPerHour", kind: 'dead', needle: "'localJev.replyChance.adaptive.busy.maxPerHour'", basis: 'none', evidence: null },
  // ★ 2026-10-15 复核（71d6b5ce §四.4「死键配活控件」）：burstJudge 四行**判死不变** ——
  //   剥注释实查 `refactor/modules/**` 与 `apps/server/**` 对 `burstJudge` **零命中**
  //   （既没有 `cfg.get('localJev.burstJudge.*')`，也没有整块取 `cfg.localJev?.burstJudge`）；
  //   唯一的语料外消费者是 defaults.js 的默认块本身。旧树确有该能力（连发防抖：
  //   `src/orchestrator.js:1124`++ / `src/local-jev.js:2762`），**新树未移植** ⇒ 不是"接线了"，
  //   是"能力没搬"。UI 侧仍有可保存控件（app.js:2315-2317 pacing 组、:2436 jev-runtime 组、
  //   :18257-18265 采集）⇒ 需 ds2 收口（撤控件或标注「新树无消费者」），本单不碰 app.js。
  { key: "localJev.burstJudge.enabled", kind: 'dead', needle: "localJev.burstJudge.enabled", basis: 'none', evidence: "新树无生产读点（2026-10-15 剥注释复核）；旧树连发防抖未移植；UI 控件待收口", risk: 'generic-leaf' },
  { key: "localJev.burstJudge.minConfidence", kind: 'dead', needle: "'localJev.burstJudge.minConfidence'", basis: 'none', evidence: "同上：新树无读点，旧树能力未移植，UI 控件待收口" },
  { key: "localJev.burstJudge.minMargin", kind: 'dead', needle: "'localJev.burstJudge.minMargin'", basis: 'none', evidence: "同上：新树无读点，旧树能力未移植，UI 控件待收口" },
  { key: "localJev.burstJudge.timeoutMs", kind: 'dead', needle: "localJev.burstJudge.timeoutMs", basis: 'none', evidence: "同上：新树无读点，旧树能力未移植，UI 控件待收口", risk: 'generic-leaf' },
  { key: "localJev.roles", kind: 'dead', needle: "localJev.roles", basis: 'none', evidence: "仅注释/迁移，无运行时读点（cj1 只读复核）", risk: 'generic-leaf' },
  // ★ N36 回对（**假活键**）：旧行 basis:'full' 引 roles.js，但那里的两处命中
  //   （roles.js:16 / :28）**全在注释里**，是把它当反面靶子写进退役名单（LEGACY_RETIRED_IDS:33-38）。
  //   把注释当读点正是本文件头注警告的"假活键"。老树调用点也已于 2026-10-02 删除
  //   （src/orchestrator.js:4603-4610 留了尸检注释：result 恒 null）⇒ **两棵树都没有功能**，不是欠账。
  //   needle 用带引号形（真读点的形状），roles.js 的注释/名单都不会误触发。
  { key: "localJev.favorJudge.enabled", kind: 'dead', needle: "'localJev.favorJudge.enabled'", basis: 'none', evidence: "仅注释/迁移，无运行时读点（cj1 只读复核）", risk: 'retired-role' },
  { key: "localJev.favorJudge.timeoutMs", kind: 'dead', needle: "'localJev.favorJudge.timeoutMs'", basis: 'none', evidence: null, risk: 'retired-role' },
  { key: "memoryGuard.enabled", kind: 'dead', needle: "memoryGuard.enabled", basis: 'none', evidence: null, risk: 'generic-leaf' },
  // ★ 2026-10-11 二分复核（mimo2，指挥位裁）：这 5 行原本是 live + 短 needle，
  //   命中处全是**同名局部变量/别的键的块读**（tickMs←tickIntervalMs、idleMs←本地推导、
  //   minGapMs←send.minGapMs、avatar*←persona2.* 的叶子），**全树（剥注释、除定义）零读点** ⇒ 判死。
  //   同族 memoryGuard.restart.* 现已 6/6 全死；hypeMode.avatarOn/Off 的**真读点**是 persona2.avatarOn/Off（另有活行）。
  { key: "memoryGuard.tickMs", kind: 'dead', needle: "memoryGuard.tickMs", basis: 'none', evidence: null },
  { key: "memoryGuard.orphanCleanup", kind: 'dead', needle: "memoryGuard.orphanCleanup", basis: 'none', evidence: null },
  { key: "memoryGuard.staleBeatMs", kind: 'dead', needle: "memoryGuard.staleBeatMs", basis: 'none', evidence: null },
  { key: "memoryGuard.restart.enabled", kind: 'dead', needle: "memoryGuard.restart.enabled", basis: 'none', evidence: null, risk: 'generic-leaf' },
  { key: "memoryGuard.restart.idleMs", kind: 'dead', needle: "memoryGuard.restart.idleMs", basis: 'none', evidence: null },
  { key: "memoryGuard.restart.maxRequests", kind: 'dead', needle: "memoryGuard.restart.maxRequests", basis: 'none', evidence: null },
  { key: "memoryGuard.restart.maxUptimeMs", kind: 'dead', needle: "memoryGuard.restart.maxUptimeMs", basis: 'none', evidence: null },
  { key: "memoryGuard.restart.maxWorkingSetMb", kind: 'dead', needle: "memoryGuard.restart.maxWorkingSetMb", basis: 'none', evidence: null },
  { key: "memoryGuard.restart.minGapMs", kind: 'dead', needle: "memoryGuard.restart.minGapMs", basis: 'none', evidence: null },
  { key: "memoryGuard.sampleEvery", kind: 'dead', needle: "memoryGuard.sampleEvery", basis: 'none', evidence: null },
  { key: "memoryGuard.samplesMax", kind: 'dead', needle: "memoryGuard.samplesMax", basis: 'none', evidence: null },
  { key: "memoryGuard.ledger.enabled", kind: 'dead', needle: "memoryGuard.ledger.enabled", basis: 'none', evidence: null, risk: 'generic-leaf' },
  { key: "memoryGuard.ledger.maxAgeDays", kind: 'dead', needle: "memoryGuard.ledger.maxAgeDays", basis: 'none', evidence: null },
  { key: "memoryGuard.ledger.maxBytes", kind: 'dead', needle: "memoryGuard.ledger.maxBytes", basis: 'none', evidence: null },
  // ★ N45 回对（假证据）：旧 evidence `extensions/skills/config.js:6` 是**文件头注释**里提了一句
  //   「webSearch.enabled 仍由各自模块读取」，不是读点。真读点 = prompt/index.js:272 `readCfg(cfg, 'webSearch.enabled', true)`。
  { key: "webSearch.enabled", kind: 'live', needle: "webSearch.enabled", basis: 'full', evidence: "refactor/modules/prompt/index.js" },
  { key: "webSearch.searchUrl", kind: 'live', needle: "searchUrl", basis: 'suffix', evidence: "refactor/modules/act/executors/query.js" },
  { key: "webSearch.imageSearchUrl", kind: 'live', needle: "imageSearchUrl", basis: 'suffix', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.imageSearchUrlBaidu", kind: 'live', needle: "imageSearchUrlBaidu", basis: 'suffix', evidence: "refactor/modules/internet/web-search.js" },
  // ★ 2026-10-17（待核项收口）：真读点 `web-search.js:36/:71` 的 `Number(cfg.maxResults) || 6`
  //   —— `cfg` 是该文件里的 webSearch 子树对象（同处已有 `webSearch.fetchMaxChars` 的 full 读点同源）
  //   ⇒ 不是"撞名"。needle 用真实存在的 `cfg.maxResults`。
  { key: "webSearch.maxResults", kind: 'live', needle: "cfg.maxResults", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.fetchMaxChars", kind: 'live', needle: "webSearch.fetchMaxChars", basis: 'full', evidence: "refactor/modules/act/executors/query.js" },
  // ★ N36 回对（**一次性纠 34 行假死键**）：webSearch 的每个 provider 块都是"先取父对象再点叶子"
  //   （`const cfg = getConfig().webSearch?.zhipu ?? {}` → `cfg.apiKey`），字面全路径**永不出现**
  //   ⇒ 机器判死，实际全是活的。basis 一律记 'parent'，needle 记父路径/局部变量点取形，均已逐行实查。
  //   唯一真死的是 `webSearch.custom.name`（见该行）。
  { key: "webSearch.wiki.enabled", kind: 'live', needle: "w.enabled === false", basis: 'parent', evidence: "refactor/modules/internet/wiki.js" },
  { key: "webSearch.wiki.default", kind: 'live', needle: "wikiCfg().default", basis: 'parent', evidence: "refactor/modules/internet/wiki.js" },
  { key: "webSearch.wiki.wikiSearchSource", kind: 'live', needle: "wikiSearchSource", basis: 'suffix', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.wiki.sources", kind: 'live', needle: "webSearch.wiki.sources", basis: 'full', evidence: "refactor/modules/internet/wiki.js" },
  { key: "webSearch.provider", kind: 'live', needle: "webSearch.provider", basis: 'full', evidence: "refactor/apps/server/api/console.js" },
  { key: "webSearch.native.model", kind: 'live', needle: "nat.model", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.native.timeoutMs", kind: 'live', needle: "nat.timeoutMs", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.native.maxTokens", kind: 'live', needle: "nat.maxTokens", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.native.strategy", kind: 'live', needle: "strategy", basis: 'suffix', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.deepseek.apiKey", kind: 'live', needle: "webSearch?.deepseek", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.deepseek.baseUrl", kind: 'live', needle: "webSearch?.deepseek", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.deepseek.model", kind: 'live', needle: "webSearch?.deepseek", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.deepseek.timeoutMs", kind: 'live', needle: "webSearch?.deepseek", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.zhipu.apiKey", kind: 'live', needle: "webSearch?.zhipu", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.zhipu.baseUrl", kind: 'live', needle: "webSearch?.zhipu", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.zhipu.engine", kind: 'live', needle: "webSearch?.zhipu", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.zhipu.count", kind: 'live', needle: "webSearch?.zhipu", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.zhipu.timeoutMs", kind: 'live', needle: "webSearch?.zhipu", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.bocha.apiKey", kind: 'live', needle: "webSearch?.bocha", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.bocha.baseUrl", kind: 'live', needle: "webSearch?.bocha", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.bocha.count", kind: 'live', needle: "webSearch?.bocha", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.bocha.timeoutMs", kind: 'live', needle: "webSearch?.bocha", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.baidu.apiKey", kind: 'live', needle: "webSearch?.baidu", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.baidu.baseUrl", kind: 'live', needle: "webSearch?.baidu", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.baidu.count", kind: 'live', needle: "webSearch?.baidu", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.baidu.timeoutMs", kind: 'live', needle: "webSearch?.baidu", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.metaso.apiKey", kind: 'live', needle: "webSearch?.metaso", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.metaso.baseUrl", kind: 'live', needle: "webSearch?.metaso", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.metaso.count", kind: 'live', needle: "webSearch?.metaso", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.metaso.timeoutMs", kind: 'live', needle: "webSearch?.metaso", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.providers", kind: 'live', needle: "webSearch.providers", basis: 'full', evidence: "refactor/apps/server/api/console.js" },
  // ★ `custom.name` 是 webSearch 35 行里**唯一真死**的：全语料（含 apps/ui）零读点，
  //   自定义搜索槽位只显示 `webSearch.providers[].name`（web-search.js:1155），旧的单槽位 name 没人取。
  { key: "webSearch.custom.name", kind: 'dead', needle: "'webSearch.custom.name'", basis: 'none', evidence: null, risk: 'ui-label-only' },
  { key: "webSearch.custom.type", kind: 'live', needle: "ws.custom ?? {}", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.custom.baseUrl", kind: 'live', needle: "ws.custom ?? {}", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.custom.apiKey", kind: 'live', needle: "ws.custom ?? {}", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.custom.model", kind: 'live', needle: "ws.custom ?? {}", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.custom.count", kind: 'live', needle: "ws.custom ?? {}", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.custom.timeoutMs", kind: 'live', needle: "ws.custom ?? {}", basis: 'parent', evidence: "refactor/modules/internet/web-search.js" },
  { key: "webSearch.apiNews.enabled", kind: 'live', needle: "webSearch?.apiNews?.enabled", basis: 'parent', evidence: "refactor/modules/internet/api-news.js" },
  { key: "webSearch.apiNews.sources", kind: 'live', needle: "cfg.sources", basis: 'parent', evidence: "refactor/modules/internet/api-news.js" },
  { key: "webSearch.apiNews.feeds", kind: 'live', needle: "feeds", basis: 'suffix', evidence: "refactor/modules/internet/api-news.js" },
  { key: "webSearch.bilibiliCookie", kind: 'live', needle: "webSearch.bilibiliCookie", basis: 'full', evidence: "refactor/modules/act/executors/media.js" },
  { key: "webSearch.biliFavFolderName", kind: 'live', needle: "webSearch.biliFavFolderName", basis: 'full', evidence: "refactor/modules/act/executors/music-bili.js" },
  { key: "webSearch.biliFavMediaId", kind: 'live', needle: "webSearch.biliFavMediaId", basis: 'full', evidence: "refactor/modules/act/executors/music-bili.js" },
  // ★ N45 回对（假证据）：全路径 `security.allowPrivateXxxHosts` 在语料里**只出现在注释**里
  //   （safe-fetch.js:9/272、web-search.js:475/922 都是说明文字）；真读点是两段式
  //   `getConfig().security?.allowPrivateImageHosts`（safe-fetch.js:282/368/405）与
  //   `…?.allowPrivateFetchHosts`（web-search.js:476/923）⇒ needle 改成带 `?.` 的真实形状，同 `api?.disableThinking` 口径。
  { key: "security.allowPrivateImageHosts", kind: 'live', needle: "security?.allowPrivateImageHosts", basis: 'suffix', evidence: "refactor/modules/internet/safe-fetch.js" },
  { key: "security.allowPrivateFetchHosts", kind: 'live', needle: "security?.allowPrivateFetchHosts", basis: 'suffix', evidence: "refactor/modules/internet/web-search.js" },
  // ★ N36 回对（**假死键**）：真读点 act/executors/media.js:246-247 —— `cfgGet(ctx,'security.imageSend',{})`
  //   取父对象再点 `.enabled`（两段式），字面全路径永不出现 ⇒ basis 记 'parent'。
  { key: "security.imageSend.enabled", kind: 'live', needle: "security.imageSend", basis: 'parent', evidence: "refactor/modules/act/executors/media.js" },
  { key: "security.imageSend.requirePreview", kind: 'live', needle: "requirePreview", basis: 'suffix', evidence: "refactor/modules/act/executors/media.js" },
  { key: "security.imageSend.maxPerRun", kind: 'live', needle: "maxPerRun", basis: 'suffix', evidence: "refactor/modules/act/executors/media.js" },
  { key: "security.imageSend.maxPreviewsPerRun", kind: 'live', needle: "maxPreviewsPerRun", basis: 'suffix', evidence: "refactor/modules/act/executors/media.js" },
  { key: "security.imageSend.maxBytesMB", kind: 'live', needle: "maxBytesMB", basis: 'suffix', evidence: "refactor/modules/act/executors/media.js" },
  { key: "security.imageSend.skipPreviewForLockedHosts", kind: 'live', needle: "skipPreviewForLockedHosts", basis: 'suffix', evidence: "refactor/modules/act/executors/media.js" },
  // ★ N36 回对（**假死键**）：真读点 internet/safe-fetch.js:308-309 `getConfig().security?.browseLock`
  //   → `.enabled`，消费方 :321 hostAllowed / :342 safeFetch，media.js:266/436、query.js:232 都在用。
  { key: "security.browseLock.enabled", kind: 'live', needle: "security?.browseLock", basis: 'parent', evidence: "refactor/modules/internet/safe-fetch.js" },
  { key: "security.browseLock.domains", kind: 'live', needle: "domains", basis: 'suffix', evidence: "refactor/modules/act/executors/query.js" },
  { key: "security.browseLock.includeSubdomains", kind: 'live', needle: "includeSubdomains", basis: 'suffix', evidence: "refactor/modules/internet/safe-fetch.js" },
  { key: "security.browseLock.searchUrl", kind: 'live', needle: "security.browseLock.searchUrl", basis: 'full', evidence: "refactor/modules/act/executors/query.js" },
  { key: "snowluma.dir", kind: 'live', needle: "snowluma.dir", basis: 'full', evidence: "refactor/apps/server/api/shell.js" },
  // ★ 2026-10-15（既有红修账，非本单范围）：`76e8fbb7` 接通了启动自动拉起
  //   （`apps/server/index.js:333` 读 `snowluma.autoLaunch`），本行原 dead 是欠账。
  { key: "snowluma.autoLaunch", kind: 'live', needle: "snowluma.autoLaunch", basis: 'full', evidence: "refactor/apps/server/index.js" },
  { key: "snowluma.wsUrl", kind: 'live', needle: "snowluma.wsUrl", basis: 'full', evidence: "refactor/apps/server/api/shell.js" },
  { key: "snowluma.httpUrl", kind: 'live', needle: "snowluma.httpUrl", basis: 'full', evidence: "refactor/apps/server/onebot-link.js" },
  { key: "snowluma.accessToken", kind: 'live', needle: "snowluma.accessToken", basis: 'full', evidence: "refactor/apps/server/onebot-link.js" },
  { key: "snowluma.httpAccessToken", kind: 'live', needle: "snowluma.httpAccessToken", basis: 'full', evidence: "refactor/apps/server/onebot-link.js" },
  { key: "snowluma.accountWhitelist", kind: 'live', needle: "snowluma.accountWhitelist", basis: 'full', evidence: "refactor/apps/server/api/shell.js" },
  { key: "snowluma.autoUnhookStrangers", kind: 'live', needle: "snowluma.autoUnhookStrangers", basis: 'full', evidence: "refactor/apps/server/api/shell.js" },
  { key: "snowluma.webuiPassword", kind: 'live', needle: "snowluma.webuiPassword", basis: 'full', evidence: "refactor/apps/server/api/shell.js" },
  { key: "hypeMode.enabled", kind: 'live', needle: "hypeMode.enabled", basis: 'full', evidence: "refactor/modules/emotion/hype-mode.js" },
  // ★ N36 回对（**假死键**）：切换事务真读它 —— console-api.js:1030 `cs.get('hypeMode')` 取整块，
  //   :1044 用 `nextHm.model` 写进 api.model；另有 emotion/hype-mode.js:127 `hypeCfg('model')` 出状态。
  { key: "hypeMode.model", kind: 'live', needle: "hypeCfg('model'", basis: 'suffix', evidence: "refactor/modules/emotion/hype-mode.js" },
  // ★ 同上（console-api.js:1070 `nextHm.restoreModel`；hype-mode.js:128 `hypeCfg('restoreModel')`）。
  { key: "hypeMode.restoreModel", kind: 'live', needle: "hypeCfg('restoreModel'", basis: 'suffix', evidence: "refactor/modules/emotion/hype-mode.js" },
  { key: "hypeMode.systemMode", kind: 'live', needle: "systemMode", basis: 'suffix', evidence: "refactor/modules/prompt/index.js" },
  // ★ N36 回对（**有读点但功能是死的**，risk 'inert-read'）：唯一读点 emotion/hype-mode.js:130
  //   只把它压成布尔 `hasRoleText` 塞进 hypeStatus 快照，而 GET /api/hype-mode（console-api.js:990-1010）
  //   **不走 hypeStatus** ⇒ 读了也没人看。老树的功能（src/hype-mode.js:182 进亢奋时整份换人设卡）
  //   在 console-api.js:1048 被硬编码前缀 `'## 亢奋模式\n' + persona.roleText` 顶替了
  //   ⇒ 属"接错了"而不是"没接"，仍进值得接线清单（域 apps/server）。
  { key: "hypeMode.roleText", kind: 'live', needle: "hypeCfg('roleText'", basis: 'suffix', evidence: "refactor/modules/emotion/hype-mode.js", risk: 'inert-read' },
  // ★ N36 回对：已由别的席位接上 —— act/index.js:1034 `ctx.cfg.get('hypeMode.minMessages', 0)`
  //   （send_message 的连击下限硬闸，对齐老树 src/tools.js:939-942）。
  //   ⚠ 同文件 :1025 那条注释还写着"连击下限不校验"，已被 :1034 的实现推翻 —— 注释过时，只报不改（域 act）。
  { key: "hypeMode.minMessages", kind: 'live', needle: "hypeMode.minMessages", basis: 'full', evidence: "refactor/modules/act/index.js" },
  { key: "hypeMode.protectedQQ", kind: 'live', needle: "hypeMode.protectedQQ", basis: 'full', evidence: "refactor/modules/prompt/index.js" },
  { key: "hypeMode.avatarOn", kind: 'dead', needle: "hypeMode.avatarOn", basis: 'none', evidence: null },
  { key: "hypeMode.avatarOff", kind: 'dead', needle: "hypeMode.avatarOff", basis: 'none', evidence: null },
  { key: "hypeMode.emotionThreshold", kind: 'live', needle: "hypeMode.emotionThreshold", basis: 'full', evidence: "refactor/apps/server/console-api.js" },
  { key: "hypeMode.emotionAutoExitMin", kind: 'live', needle: "hypeMode.emotionAutoExitMin", basis: 'full', evidence: "refactor/apps/server/console-api.js" },
  // ★ N30（bunny2）已接线：`hypeMode.stats` 的读点是 hypeCfg('stats') 动态拼键，
  //   字面点路径只在 hype-mode.js:95 的**注释**里出现 ⇒ basis 记 'suffix'，不记 'full'
  //   （把注释当读点正是台账头注警告的"假活键"）。程序写回的状态，不是用户旋钮。
  { key: "hypeMode.stats", kind: 'live', needle: "hypeCfg('stats'", basis: 'suffix', evidence: "refactor/modules/emotion/hype-mode.js" },
  // ★ sp3 回对（2026-10-11 全盘扫）：`hypeMode.saved` 旧判 dead，其实**有读点**：
  //   `console-api.js:1105` `cs.get('hypeMode')` 整块取 → `:1113` 写 saved → `:1131` `const saved = hm.saved || {}`
  //   退出亢奋时照它还原第一人格（roleText/systemMode/compactSystemPrompt/tools）。
  //   ⇒ 关掉亢奋会不会把设定改乱，全看这个键；把它当死键会让人以为"退出不还原"。
  { key: "hypeMode.saved", kind: 'live', needle: "hypeMode", basis: 'parent', evidence: "refactor/apps/server/console-api.js" },
  // assembly.js buildRuntimeModules() 每次写自述时读取 persona2.enabled，作为 ChatStore 人格标记的实时来源。
  { key: "persona2.enabled", kind: 'live', needle: "persona2.enabled", basis: 'full', evidence: "refactor/apps/server/assembly.js" },
  { key: "persona2.featureEnabled", kind: 'live', needle: "featureEnabled", basis: 'suffix', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona2.systemMode", kind: 'live', needle: "systemMode", basis: 'suffix', evidence: "refactor/modules/prompt/index.js" },
  // ★ sp3 回对（2026-10-11 · 牙④当场红）：这三行旧判 dead 是**假死**，理由同 burstAdaptive 那一族
  //   —— 消费者走「整块取 cfg 再点属性」：`modules/emotion/persona-two.js:32` `read('persona2', {})`，
  //   接着 :38 `p2.roleText`（进二人格前的非空校验）、:57 `p2.saved`（退出时还原第一人格）、
  //   :112-113 `p2.stats?.enteredAt / p2.stats?.reason`（personaTwoStatus 回显）。
  //   整条点路径永不出现（`persona2.roleText` 只在 :39 的**错误文案**里以字面量出现，正是牙④抓到的形状）
  //   ⇒ 机器判死。现在按 parent 记活。
  // ★ sp3 回对（2026-10-11 · 全盘扫复查）：`persona2.onSpans` 也翻活 —— 我上次的注释写错了。
  //   `modules/emotion/persona-two.js:71` `p2.onSpans = closeSpan(p2.onSpans, at)`：
  //   **先读** `p2.onSpans`（closeSpan 要在既有区间里补一个结束时间）再写回 ⇒ 是读写俱全，不是"只写"。
  //   （:48 进入时 openSpan 同理要先 filter 既有 list。）
  { key: "persona2.onSpans", kind: 'live', needle: "persona2", basis: 'parent', evidence: "refactor/modules/emotion/persona-two.js" },
  { key: "persona2.roleText", kind: 'live', needle: "persona2", basis: 'parent', evidence: "refactor/modules/emotion/persona-two.js" },
  { key: "persona2.adminQQ", kind: 'live', needle: "persona2.adminQQ", basis: 'full', evidence: "refactor/modules/prompt/index.js" },
  // ★ 回程骰子（2026-10-12 用户裁定：切过去与切回来两向都掷）：模型调 switch_back 时先掷，
  //   roll < 此值才真退；缺键 = 不掷必成（defaults 给生产 0.5）。真读点 = requestPersonaTwoExit
  //   里的 `read('persona2.switchBackChance', 1)` 整条点路径字面量。
  { key: "persona2.switchBackChance", kind: 'live', needle: "persona2.switchBackChance", basis: 'full', evidence: "refactor/modules/emotion/persona-two.js" },
  // ★ 进入骰子（2026-10-13 口径：两向都掷、触发者=LLM）：模型调 switch_in 先掷，roll<此值才挂起进入；
  //   与 switchBackChance 完全对称。真读点 = requestPersonaTwoEnter 里的整条点路径字面量。
  { key: "persona2.switchEnterChance", kind: 'live', needle: "persona2.switchEnterChance", basis: 'full', evidence: "refactor/modules/emotion/persona-two.js" },
  { key: "persona2.trigger.enabled", kind: 'live', needle: "trigger.enabled", basis: 'suffix', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona2.trigger.threshold", kind: 'live', needle: "trigger.threshold", basis: 'suffix', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona2.trigger.recoverThreshold", kind: 'live', needle: "trigger.recoverThreshold", basis: 'suffix', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona2.trigger.recoverExitEnabled", kind: 'live', needle: "trigger.recoverExitEnabled", basis: 'suffix', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona2.trigger.minDwellMin", kind: 'live', needle: "trigger.minDwellMin", basis: 'suffix', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona2.trigger.cooldownMin", kind: 'live', needle: "trigger.cooldownMin", basis: 'suffix', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona2.trigger.random.enabled", kind: 'live', needle: "random.enabled", basis: 'suffix', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona2.trigger.random.intervalMinMin", kind: 'live', needle: "random.intervalMinMin", basis: 'suffix', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona2.trigger.random.intervalMaxMin", kind: 'live', needle: "random.intervalMaxMin", basis: 'suffix', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona2.trigger.random.chancePerCheck", kind: 'live', needle: "random.chancePerCheck", basis: 'suffix', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona2.trigger.random.afterSpeakMin", kind: 'live', needle: "random.afterSpeakMin", basis: 'suffix', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona2.trigger.random.occupancyWindowH", kind: 'live', needle: "random.occupancyWindowH", basis: 'suffix', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona2.trigger.random.occupancyMax", kind: 'live', needle: "random.occupancyMax", basis: 'suffix', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona2.maxTurns", kind: 'live', needle: "maxTurns", basis: 'suffix', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona2.maxMinutes", kind: 'live', needle: "maxMinutes", basis: 'suffix', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona2.avatarOn", kind: 'live', needle: "avatarOn", basis: 'suffix', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona2.avatarOff", kind: 'live', needle: "avatarOff", basis: 'suffix', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona2.lastSwitchAt", kind: 'live', needle: "lastSwitchAt", basis: 'suffix', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona2.memoryHygiene.hideFirstPersonaHistory", kind: 'dead', needle: "persona2.memoryHygiene.hideFirstPersonaHistory", basis: 'none', evidence: null },
  { key: "persona2.memoryHygiene.hideSecondPersonaHistory", kind: 'dead', needle: "persona2.memoryHygiene.hideSecondPersonaHistory", basis: 'none', evidence: null },
  { key: "persona2.memoryHygiene.clearDraftsOnEnter", kind: 'dead', needle: "persona2.memoryHygiene.clearDraftsOnEnter", basis: 'none', evidence: null },
  { key: "persona2.saved", kind: 'live', needle: "persona2", basis: 'parent', evidence: "refactor/modules/emotion/persona-two.js" },
  { key: "persona2.stats", kind: 'live', needle: "persona2", basis: 'parent', evidence: "refactor/modules/emotion/persona-two.js" },
  { key: "persona.botName", kind: 'live', needle: "persona.botName", basis: 'full', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona.selfNickname", kind: 'live', needle: "persona.selfNickname", basis: 'full', evidence: "refactor/modules/orchestrator/index.js" },
  // ★ sp3 回对（2026-10-11 · A7 收敛重复实现）：读点从 `api/console.js` **搬到了** `console-api.js`
  //   —— 分片那份 self-impressions 已让路（死代码），活实现 `console-api.js:1252`
  //   `cs?.get?.('persona.roleText', '')` 才是真读点。牙③当场红的（"读点被搬走了"），按事实改证据。
  { key: "persona.roleText", kind: 'live', needle: "persona.roleText", basis: 'full', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona.compactSystemPrompt", kind: 'live', needle: "persona.compactSystemPrompt", basis: 'full', evidence: "refactor/modules/prompt/index.js" },
  // ★ 2026-10-18（#15）：新增值 `custom` —— 完全自定义系统风格（业务风格层整层替换，正文取 persona.customRules；
  //   空串告警回退 full）。优先级: hype > lean > compact > personaTwo/soft2 > soft > custom > full（tiers.js）。
  { key: "persona.systemMode", kind: 'live', needle: "persona.systemMode", basis: 'full', evidence: "refactor/modules/prompt/index.js" },
  // ★ N51 假活键降级：needle 是后缀 `participation`，撞的是 trace 阶段名 `participation_gate`（orchestrator/index.js）
  //   —— 全树**没有**任何 `persona.participation` 读点。老树 `src/prompt.js:1555`/`:1886` 把
  //   `participationText(cfg.persona.participation)` 渲成【参与度参考】三段话；新树**整块没有这个 block**（只在注释里提过老树）。
  // ★ N81 复验（2026-10-10 · 牙④报红 ⇒ 逐条 grep 验后改判，不是消音）：sp1 按 N45 派单项 1 把它接上了 ——
  //   `refactor/modules/prompt/index.js:403` `readCfg(cfg, 'persona.participation', 'medium')` ⇒
  //   `:404 participationText(participation)` ⇒ `:405 sections.push({ name:'participation', …, text })`
  //   ⇒ **读点 + 消费点都在**（真的进提示词段落，不是只读不用），`:406 diagnostics.participation` 还留了痕。
  //   ⚠ `:401` 那句是注释（A1b 注释牙会剥掉，所以报红的就是 `:403` 这行真代码）。
  { key: "persona.participation", kind: 'live', needle: "persona.participation", basis: 'full', evidence: "refactor/modules/prompt/index.js" },
  // 老树旧存档仍用 persona.ignoreSenderIds；config-store 合并时兼容映射到 emotion.ignoreSenderIds。
  { key: "persona.ignoreSenderIds", kind: 'live', needle: "persona.ignoreSenderIds", basis: 'full', evidence: "refactor/core/config-store/index.js" },
  { key: "persona.emotionProfile", kind: 'live', needle: "persona.emotionProfile", basis: 'full', evidence: "refactor/apps/server/console-api.js" },
  { key: "persona.customRules", kind: 'live', needle: "persona.customRules", basis: 'full', evidence: "refactor/modules/prompt/index.js" },
  { key: "customPersonas", kind: 'live', needle: "customPersonas", basis: 'full', evidence: "refactor/apps/server/api/shell.js" },
  { key: "allow.groups", kind: 'live', needle: "allow.groups", basis: 'full', evidence: "refactor/modules/proactive/index.js" },
  { key: "allow.private", kind: 'live', needle: "allow.private", basis: 'full', evidence: "refactor/modules/proactive/index.js" },
  { key: "deny.groups", kind: 'live', needle: "groups", basis: 'suffix', evidence: "refactor/apps/server/api/console.js" },
  // ★ N36 回对（**假死键**）：真读点是 `read(\`deny.${key}\`)`（core/policy/allow-gate.js:27，
  //   单复数键都认），调用方 orchestrator/index.js:588 `allowInboundGate` ← :2382 入站门。
  //   判 dead 的唯一原因是 allow-gate.js 住在 CORPUS_DIRS **之外**（:31 只扫 modules + apps/server）
  //   ⇒ basis 记 'out-of-corpus'，evidence 填语料内能证明链路接上的调用点。
  { key: "deny.private", kind: 'live', needle: "allowInboundGate", basis: 'out-of-corpus', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "allowAllWhenEmpty", kind: 'live', needle: "allowAllWhenEmpty", basis: 'full', evidence: "refactor/modules/proactive/index.js" },
  // ★ N73：luna1 `32dd5441 fix(orchestrator): restore scoped history and cross-turn context` 接通
  //   ⇒ 真读点 orchestrator/index.js:1501（`cfg?.get?.('wakeDelayMs', 2000)`），
  //   值参与 :1801-1835 的聚批延迟计算（空闲首条就按它走）。
  //   ★ `wakeDelayMs` 这条正是 N36 点名的**行为回退**键（线没接时首响按 burst 走，用户设的 2000 用不上）⇒ 接得对，记账留这里。
  // ★ 2026-10-16（防抖真值 · 按 018f1d3e 复核）：真读点是 `readBurstKnobs()`
  //   （`orchestrator/index.js:2836` 默认值表 + `:2860-2862` 逐键读，排窗口时现读）——
  //   行号从 2026-10-11 的 :1501/:627/:634 迁到了这里，语义不变且更明确：
  //     · `wakeDelayMs` 默认 2000，**0 归一成 2000**（`allowZero:false`）⇒ 想"首条立刻跑"要改 burstSettleMs=0；
  //     · `burstSettleMs` 默认 15000，**0 = 不聚批**（`pointed || burstMs===0` ⇒ 直接用 wakeDelayMs）；
  //     · `burstMaxWaitMs` 默认 30000，**0 = 不封顶**（`>0 ? v : Infinity`，:3213）。
  { key: "wakeDelayMs", kind: 'live', needle: "wakeDelayMs", basis: 'full', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "burstSettleMs", kind: 'live', needle: "burstSettleMs", basis: 'full', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "burstMaxWaitMs", kind: 'live', needle: "burstMaxWaitMs", basis: 'full', evidence: "refactor/modules/orchestrator/index.js" },
  // ★ 2026-10-16（真值复核 · 018f1d3e）：读点已随聚批重写迁到 `orchestrator/index.js:3218` 起
  //   （`readConfig(cfg, 'burstAdaptive', {})` + `adaptive?.enabled !== false` ⇒ 每次排窗口**现读**、
  //   按**这个人**的历史连发倾向插值；enabled:false 退化成固定 burstSettleMs），
  //   `k` / `minSamples` / `priorPrivate` / `priorGroup` 四个子键语义不变。
  { key: "burstAdaptive.enabled", kind: 'live', needle: "burstAdaptive", basis: 'parent', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "burstAdaptive.k", kind: 'live', needle: "burstAdaptive", basis: 'parent', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "burstAdaptive.minSamples", kind: 'live', needle: "burstAdaptive", basis: 'parent', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "burstAdaptive.priorPrivate", kind: 'live', needle: "burstAdaptive", basis: 'parent', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "burstAdaptive.priorGroup", kind: 'live', needle: "burstAdaptive", basis: 'parent', evidence: "refactor/modules/orchestrator/index.js" },
  // ★ N73：luna1 `32dd5441` 接通 ⇒ :1510 读（`cfg?.get?.('drainDelayMs', 1200)`，下限夹到 200ms），
  //   值用在 :2587 的排空 setTimeout ⇒ 牙④报红后验真改判。
  { key: "drainDelayMs", kind: 'live', needle: "drainDelayMs", basis: 'full', evidence: "refactor/modules/orchestrator/index.js" },
  // ★ N45 回对（假证据）：这三行原 evidence 都写 `apps/server/assembly.js`，那里**只有注释**提到键名。
  //   真读点：orchestrator/index.js:1274 `cfg?.get?.('maxConcurrentRuns', 2)`、
  //   broadcast/index.js:336 `config.broadcastSchedules?.items`、proactive/index.js:340 `read.get('proactive.enabled')`。
  { key: "maxConcurrentRuns", kind: 'live', needle: "maxConcurrentRuns", basis: 'full', evidence: "refactor/modules/orchestrator/index.js" },
  // ★ N51 复验（2026-10-10）：`platform/sender.js` 的 `sendTextBatch` 现在是
  //   `const sendConfig = getConfig().send || {}; const splitAt = … Number(sendConfig.splitLongAt) …`
  //   ⇒ **全路径 needle 永远撞不上**（读的是 `.send` 对象上的属性），旧行 dead 是 needle 形状的假死。
  //   软拆本体 `splitLongMessages()`（按中文句读切、上限 4 段）与老树 `src/tools.js:1056-1059` 一致 ⇒ 已接线。
  // ★ 2026-10-17（待核项收口）：这五个键的值都从 **`getConfig().send` 子树对象**上读
  //   （`sender.js:247/285-291` 的 `const cfg = getConfig().send` + `cfg.minGapMs/maxGapMs/byLengthMs`；
  //    `:305-308` 的 `const sendConfig = getConfig().send || {}` + `sendConfig.splitLongAt/hardSplitAt`）
  //   ⇒ 旧 needle 只写叶子名（basis:'suffix'）会被判"撞名待核"，实际是**父级子树读点**。
  //   needle 改用真实存在的 `getConfig().send`，生成器按它在 evidence 文件里出现与否独立复核。
  { key: "send.splitLongAt", kind: 'live', needle: "getConfig().send", basis: 'parent', evidence: "refactor/modules/platform/sender.js" },
  { key: "send.maxPerRun", kind: 'live', needle: "send.maxPerRun", basis: 'full', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "send.minGapMs", kind: 'live', needle: "getConfig().send", basis: 'parent', evidence: "refactor/modules/platform/sender.js" },
  { key: "send.maxGapMs", kind: 'live', needle: "getConfig().send", basis: 'parent', evidence: "refactor/modules/platform/sender.js" },
  { key: "send.byLengthMs", kind: 'live', needle: "getConfig().send", basis: 'parent', evidence: "refactor/modules/platform/sender.js" },
  { key: "send.maxPerMinute", kind: 'live', needle: "send.maxPerMinute", basis: 'full', evidence: "refactor/modules/platform/sender.js" },
  { key: "send.maxPerHour", kind: 'live', needle: "send.maxPerHour", basis: 'full', evidence: "refactor/modules/platform/sender.js" },
  { key: "send.blockPureEnglish", kind: 'live', needle: "send.blockPureEnglish", basis: 'full', evidence: "refactor/modules/act/index.js" },
  { key: "send.stripEmoji", kind: 'live', needle: "send.stripEmoji", basis: 'full', evidence: "refactor/modules/act/index.js" },
  { key: "send.tidyBrackets", kind: 'live', needle: "send.tidyBrackets", basis: 'full', evidence: "refactor/modules/act/index.js" },
  { key: "send.blockAiSelfClaim", kind: 'live', needle: "send.blockAiSelfClaim", basis: 'full', evidence: "refactor/modules/act/index.js" },
  { key: "send.blockJsonFragments", kind: 'live', needle: "send.blockJsonFragments", basis: 'full', evidence: "refactor/modules/act/index.js" },
  { key: "send.hardSplitAt", kind: 'live', needle: "getConfig().send", basis: 'parent', evidence: "refactor/modules/platform/sender.js" },
  { key: "send.biliJsonCard", kind: 'live', needle: "biliJsonCard", basis: 'suffix', evidence: "refactor/modules/platform/sender.js" },
  // ★ N36 回对（**假死键**）：broadcast/index.js:100 `cfg?.crazyThursday || {}` → :105 `ct.enabled !== false`
  //   合成 legacy 计划（总闸 broadcastSchedules.enabled 先判），:152 还整块 `cfg.get('crazyThursday')` 出状态。
  { key: "crazyThursday.enabled", kind: 'live', needle: "crazyThursday", basis: 'parent', evidence: "refactor/modules/broadcast/index.js" },
  { key: "crazyThursday.times", kind: 'live', needle: "times", basis: 'suffix', evidence: "refactor/modules/broadcast/index.js" },
  { key: "crazyThursday.groupIds", kind: 'live', needle: "groupIds", basis: 'suffix', evidence: "refactor/modules/broadcast/index.js" },
  { key: "broadcastSchedules.enabled", kind: 'live', needle: "broadcastSchedules.enabled", basis: 'full', evidence: "refactor/modules/broadcast/index.js" },
  { key: "broadcastSchedules.items", kind: 'live', needle: "broadcastSchedules.items", basis: 'full', evidence: "refactor/modules/broadcast/index.js" },
  { key: "proactive.enabled", kind: 'live', needle: "proactive.enabled", basis: 'full', evidence: "refactor/modules/proactive/index.js" },
  { key: "proactive.checkIntervalMinMs", kind: 'live', needle: "proactive.checkIntervalMinMs", basis: 'full', evidence: "refactor/modules/proactive/index.js" },
  { key: "proactive.checkIntervalMaxMs", kind: 'live', needle: "proactive.checkIntervalMaxMs", basis: 'full', evidence: "refactor/modules/proactive/index.js" },
  { key: "proactive.idleThresholdMs", kind: 'live', needle: "proactive.idleThresholdMs", basis: 'full', evidence: "refactor/modules/proactive/index.js" },
  { key: "proactive.probability", kind: 'live', needle: "proactive.probability", basis: 'full', evidence: "refactor/modules/proactive/index.js" },
  { key: "proactive.privateIdleEnabled", kind: 'live', needle: "proactive.privateIdleEnabled", basis: 'full', evidence: "refactor/modules/proactive/index.js" },
  { key: "proactive.privateIdleThresholdMs", kind: 'live', needle: "proactive.privateIdleThresholdMs", basis: 'full', evidence: "refactor/modules/proactive/index.js" },
  { key: "proactive.privateIdleProbability", kind: 'live', needle: "proactive.privateIdleProbability", basis: 'full', evidence: "refactor/modules/proactive/index.js" },
  { key: "proactive.privateScheduleEnabled", kind: 'live', needle: "proactive.privateScheduleEnabled", basis: 'full', evidence: "refactor/modules/proactive/index.js" },
  { key: "proactive.privateSchedules", kind: 'live', needle: "proactive.privateSchedules", basis: 'full', evidence: "refactor/modules/proactive/index.js" },
  { key: "sticker.enabled", kind: 'live', needle: "sticker.enabled", basis: 'full', evidence: "refactor/modules/prompt/index.js" },
  { key: "sticker.promptMaxStickers", kind: 'live', needle: "promptMaxStickers", basis: 'suffix', evidence: "refactor/modules/media/sticker-manager.js" },
  { key: "sticker.rotatePeriodMin", kind: 'live', needle: "sticker.rotatePeriodMin", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js" },
  { key: "sticker.collectEnabled", kind: 'live', needle: "sticker.collectEnabled", basis: 'full', evidence: "refactor/modules/prompt/index.js" },
  { key: "sticker.maxCollectPerHour", kind: 'live', needle: "maxCollectPerHour", basis: 'suffix', evidence: "refactor/modules/media/sticker-manager.js" },
  // 回复后自动配表情由 orchestrator 的 maybeSendAutoSticker 读取；只有文字确认投递后才可能触发。
  { key: "sticker.autoPick.enabled", kind: 'live', needle: "sticker.autoPick.enabled", basis: 'full', evidence: "refactor/modules/orchestrator/index.js", risk: 'generic-leaf' },
  { key: "sticker.autoPick.probability", kind: 'live', needle: "sticker.autoPick.probability", basis: 'full', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "sticker.autoPick.shortlist", kind: 'live', needle: "sticker.autoPick.shortlist", basis: 'full', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "sticker.autoPick.cooldownMs", kind: 'live', needle: "sticker.autoPick.cooldownMs", basis: 'full', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "sticker.encourage", kind: 'live', needle: "sticker.encourage", basis: 'full', evidence: "refactor/modules/prompt/index.js" },
  { key: "media.visionScan.allowOutbound", kind: 'live', needle: "media.visionScan.allowOutbound", basis: 'full', evidence: "refactor/apps/server/api/console.js" },
  // ★ N51 追加裁定 + 2026-10-15 luna2 接通（复核回执 .tmp-dispatch/2026-10-15/39ddbb0d §五 V1）：
  //   · N51 当时判 dead 的理由成立且已过时：缺的不是缺省、是"没人传" —— 缺省两树一致（本树 defaults 0 / 3000，
  //     老树 src/config.js:1033/1041 同值）；chat-store.js 收 {maxPerChat, hotPerChat}、有 setter、归档水位
  //     = 老树 src/store.js:507，一行代码都不缺。
  //   · 落点在装配层（老树两个读点都在 src/app.js）：`:615` 构造注入 / `:2680-2681` 配置变更热更新。
  //   · **已接通（2026-10-15 luna2）**：`apps/server/store-caps.js` 的 `wireStoreCaps` = **唯一接线点**
  //     （初值 + subscribeConfigChange 热更新；同一实例只订阅一次）—— assembly.js 主装配建 store 后与
  //     onebot-link.js 兜底自建后共用它（兜底也吃到热更新，V2）。`act/executors/media.js` 不传键
  //     = 刻意不覆盖（chat-store.js 的 hasOwn 守卫），不是漏接。
  //   · 两行由 dead 转 live；needle 保持整条路径（store-caps.js 里是字面读取点），basis 'full'。
  { key: "store.maxMessagesPerChat", kind: 'live', needle: "store.maxMessagesPerChat", basis: 'full', evidence: "refactor/apps/server/store-caps.js" },
  { key: "store.hotMessagesPerChat", kind: 'live', needle: "store.hotMessagesPerChat", basis: 'full', evidence: "refactor/apps/server/store-caps.js" },
  { key: "store.contextTier", kind: 'live', needle: "store.contextTier", basis: 'full', evidence: "refactor/modules/orchestrator/index.js" },
  // ★ 2026-10-17（用户裁定：全局/逐群「云裁判 vs 随机回复」）：唯一读点 = orchestrator/index.js 的
  //   resolveReplyMode（`cfg.effective('store.replyMode', {chatKey, kind})` 分层读取）。
  //   单群覆盖写在 store.perChat[chatKey].replyMode（scope.js 会话层），未写/null = 继承全局。
  //   ★ 2026-10-18（合同）：出厂默认改 'random'（defaults.js）；总闸（judgeMode.enabled）关闭时
  //   'jev' 不允许绕过闸、按普通随机路线降级。resolveReplyMode 的字面默认回落（'jev'）与
  //   对应 selftest 断言在 orchestrator（ds1）侧随合同更新 —— 本行仍是"读点存在"的台账记录。
  { key: "store.replyMode", kind: 'live', needle: "store.replyMode", basis: 'full', evidence: "refactor/modules/orchestrator/index.js" },
  // ★ 2026-10-18（合同：聚焦续聊窗口总开关）：出厂 false、手动开启；读侧走
  //   effective/scoped 分层（`readScopedConfig(cfg, 'store.followupEnabled', …)`，
  //   perChat[chatKey].followupEnabled 可逐群覆盖）。消费已在 orchestrator/index.js 接线：
  //   总开关关 ⇒ 不开窗并清旧窗/定时器、已排队聚焦批收手；UI（apps/ui）同批给出总开关与逐群覆盖控件。
  { key: "store.followupEnabled", kind: 'live', needle: "store.followupEnabled", basis: 'full', evidence: "refactor/modules/orchestrator/index.js" },
  // ★★ N73 复验（**这八行由死转活**，N51-B 派出去的 E4 配额键 luna1 已经接上了）：
  //   读点 `orchestrator/index.js:641 contextMessageCount(cfg, scope, key, fallback)` —— 键路径是
  //   **模板字符串拼出来的**（``readScopedConfig(cfg, `store.${key}`, scope, fallback)``），
  //   所以带点号的字面量 `store.allCount` **永远不会出现** ⇒ needle 只能记**末段**（`basis: 'suffix'`），
  //   与同族的 `store.contextTier` / `store.private.contextTier` 一个口径。
  //   调用点：:659 allCount(80) · :660 atCount(20) · :661 keywordCount(15) · :662 randomCount(8)
  //   ⇒ 老树 `src/prompt.js:1230-1267 resolveContextTier` 的"档位决定读多少条"回来了（之前只剩 allow/deny + 硬编码 40）。
  //   ★ `store.private.*` 四行同样转活：私聊层不是靠字面量读的，是 `core/config-store/index.js:242 effective()`
  //     → `scope.js:53-56` 在 kind=private 且 privateOverride 时把 `store.private.<末段>` 顶上去 ⇒ 与本体共用同一个末段 needle。
  { key: "store.atCount", kind: 'live', needle: "atCount", basis: 'suffix', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "store.keywordCount", kind: 'live', needle: "keywordCount", basis: 'suffix', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "store.keywords", kind: 'live', needle: "store.keywords", basis: 'full', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "store.randomPercent", kind: 'live', needle: "store.randomPercent", basis: 'full', evidence: "refactor/modules/plan/index.js" },
  { key: "store.randomCount", kind: 'live', needle: "randomCount", basis: 'suffix', evidence: "refactor/modules/orchestrator/index.js" },
  // ★ N51 曾按**假活降级**（当时后缀 needle `allCount` 撞的是 `toolCallCount`/`modelCallCount`/`callCount`，
  //   全树对 `store.allCount` 确实零读点）⇒ 那一判是对的，红的是台账不是牙；N73 复验后按上面的读点转活。
  { key: "store.allCount", kind: 'live', needle: "allCount", basis: 'suffix', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "store.deepseekAnchorMinChunk", kind: 'live', needle: "store.deepseekAnchorMinChunk", basis: 'full', evidence: "refactor/modules/prompt/deepseek-history.js" },
  { key: "store.privateOverride", kind: 'live', needle: "privateOverride", basis: 'suffix', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "store.private.contextSliderPos", kind: 'dead', needle: "store.private.contextSliderPos", basis: 'none', evidence: null },
  { key: "store.private.contextTier", kind: 'live', needle: "contextTier", basis: 'suffix', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "store.private.atCount", kind: 'live', needle: "atCount", basis: 'suffix', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "store.private.keywordCount", kind: 'live', needle: "keywordCount", basis: 'suffix', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "store.private.keywords", kind: 'live', needle: "keywords", basis: 'suffix', evidence: "refactor/modules/act/executors/media.js" },
  { key: "store.private.randomPercent", kind: 'live', needle: "randomPercent", basis: 'suffix', evidence: "refactor/modules/plan/index.js" },
  { key: "store.private.randomCount", kind: 'live', needle: "randomCount", basis: 'suffix', evidence: "refactor/modules/orchestrator/index.js" },
  { key: "store.private.allCount", kind: 'live', needle: "allCount", basis: 'suffix', evidence: "refactor/modules/orchestrator/index.js" },
  // ★ N51 复验：luna1 已接通（`orchestrator/index.js` 建 sessionRegistry 时把该键传成 `keepFiles`）
  //   ⇒ N36 A#3 的"模块已支持、唯一调用方永远传 0"补齐（老树 src/app.js:618 → src/sessions.js:49 finish 修剪旧会话文件）。
  { key: "store.keepSessionFiles", kind: 'live', needle: "store.keepSessionFiles", basis: 'full', evidence: "refactor/modules/orchestrator/index.js" },
  // ★ N36 回对 + 2026-10-15 转活（63187692 接读点、7ece7e76 放行白名单后复核）：
  //   · 读点：`modules/orchestrator/compose.js:2114-2188`（effective 整块 + 小时桶缓存 + 剔本轮）；
  //     叶子键由 `modules/prompt/recent-digest.js:14-20` 的 `clampDigestParams` 读（hours / maxChars / maxItems）。
  //   · 放行：`modules/prompt/index.js:956-959` 白名单已收录 'recent-digest' ⇒ 经 applyRequestBudget 后进最终 user 段。
  //   · **条件/预算型生效**（不是无条件每轮出现）：enabled===true 且 api.conversationMemory.enabled !== false 才产段；
  //     窗口内无可摘内容时不产段；预算超限时 droppable（PRIORITY.EXTRA）可整段丢（budget.js:149-168 留痕）。defaults 默认关。
  // ★ 2026-10-15（既有红修账，非本单范围）：近24h摘要这四行原来写 basis 'full' + 整条点路径，
  //   但真实读法是**整块取再点叶子**：compose.js:2121/2124 取 `'store.recent24hDigest'` 块、
  //   2125 点 `digestCfg.enabled`；叶子 hours/maxChars/maxItems 由
  //   prompt/recent-digest.js:16-18 `clampDigestParams` 在同一个块对象上点取。
  //   ⇒ 按 N36 的 'parent' 口径改 needle（整条点路径永不出现，原 needle 是**假红**）。
  { key: "store.recent24hDigest.enabled", kind: 'live', needle: "digestCfg.enabled", basis: 'parent', evidence: "refactor/modules/orchestrator/compose.js", risk: 'generic-leaf' },
  { key: "store.recent24hDigest.hours", kind: 'live', needle: "d.hours", basis: 'parent', evidence: "refactor/modules/prompt/recent-digest.js" },
  { key: "store.recent24hDigest.maxChars", kind: 'live', needle: "d.maxChars", basis: 'parent', evidence: "refactor/modules/prompt/recent-digest.js" },
  { key: "store.recent24hDigest.maxItems", kind: 'live', needle: "d.maxItems", basis: 'parent', evidence: "refactor/modules/prompt/recent-digest.js" },
  // N101：compose.js:404-405 通过 cfg.get 真读两个键，控制分片开关和 warmLimit；不再是无读点键。
  { key: "store.historyCold.enabled", kind: 'live', needle: "store.historyCold.enabled", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js", risk: 'generic-leaf' },
  { key: "store.historyCold.warmCount", kind: 'live', needle: "store.historyCold.warmCount", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js" },
  { key: "store.perChat", kind: 'live', needle: "perChat", basis: 'suffix', evidence: "refactor/modules/cleanup/index.js" },
  { key: "memory.consolidateEnabled", kind: 'live', needle: "memory.consolidateEnabled", basis: 'full', evidence: "refactor/apps/server/memory-maintenance.js" },
  { key: "memory.consolidateMinIntervalMs", kind: 'live', needle: "memory.consolidateMinIntervalMs", basis: 'full', evidence: "refactor/apps/server/memory-maintenance.js" },
  // ★ 2026-10-15（ds1 补账）：印象双阈值门的「总量侧」。`3e191b2b` 起
  //   `apps/server/memory-maintenance.js:109` 真读它（`num(read('memory.consolidateMinImpressions', null)) || 4`）；
  //   此前它**不在 defaults.js 也不在台账** ⇒ 值只能手改 config.json（config-store 的
  //   mergeConfig 不拦默认表外的键，读了拿得到值，但面板/台账看不见这个键）。
  //   同日已把默认值 4 补进 defaults.js（与老树 `MEMORY_THRESHOLDS.memberImpression` 同值）⇒ 转 live。
  { key: "memory.consolidateMinImpressions", kind: 'live', needle: "memory.consolidateMinImpressions", basis: 'full', evidence: "refactor/apps/server/memory-maintenance.js" },
  // ★ 2026-10-15（既有红修账，非本单范围）：`997fe517` 的记忆自动整理用
  //   `apps/server/memory-maintenance.js:111` 真读本键；原 dead 行是欠账。
  { key: "memory.maxImpressionsPerMember", kind: 'live', needle: "memory.maxImpressionsPerMember", basis: 'full', evidence: "refactor/apps/server/memory-maintenance.js" },
  { key: "memory.useChatModel", kind: 'live', needle: "memory.useChatModel", basis: 'full', evidence: "refactor/apps/server/memory-extract.js" },
  { key: "memory.provider", kind: 'live', needle: "memory.provider", basis: 'full', evidence: "refactor/apps/server/memory-extract.js", risk: 'generic-leaf' },
  { key: "memory.model", kind: 'live', needle: "memory.model", basis: 'full', evidence: "refactor/apps/server/memory-extract.js", risk: 'generic-leaf' },
  { key: "memory.semanticCardsViaLlm", kind: 'live', needle: "memory.semanticCardsViaLlm", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js" },
  { key: "memory.maintenanceIntervalMs", kind: 'live', needle: "memory.maintenanceIntervalMs", basis: 'full', evidence: "refactor/apps/server/memory-maintenance.js" },
  { key: "memory.manualEditLockMs", kind: 'live', needle: "memory.manualEditLockMs", basis: 'full', evidence: "refactor/modules/memory/manual-edit-lock.js" },
  // ★ N36 回对（**假死键 · 动态索引类**）：这 20 行不是 20 个键各自被读，而是**一个通用机制**在读：
  //   `isSkillEnabledInConfig(id)` → `getConfig()?.skills?.[String(id)]`（skills/config.js:36）。
  //   技能 id 是运行时变量 ⇒ `skills.ban-state.enabled` 这种字面全路径**永远不可能出现**。
  //   消费链已闭合：manager.js:145 isEnabled → :207-218 isActive → act/index.js:656（工具可用性门）
  //   → orchestrator/compose.js:479（报给模型的工具 schema 过滤）。⇒ 20 行全部改活，basis 'dynamic-index'。
  //   ⚠ 真缺口不在这里：启动只调 loadPlugins、没调 initExtensions（apps/server/assembly.js:948），
  //     订阅/定时器类技能的激活要等热重载或 zip 导入才跑 —— 见值得接线清单（域 apps/server，一行）。
  { key: "skills.ban-state.enabled", kind: 'live', needle: "skills?.[String(id)]", basis: 'dynamic-index', evidence: "refactor/modules/extensions/skills/config.js" },
  { key: "skills.image-compat.enabled", kind: 'live', needle: "skills?.[String(id)]", basis: 'dynamic-index', evidence: "refactor/modules/extensions/skills/config.js" },
  { key: "skills.speaker-identity.enabled", kind: 'live', needle: "skills?.[String(id)]", basis: 'dynamic-index', evidence: "refactor/modules/extensions/skills/config.js" },
  { key: "skills.thinking-adapters.enabled", kind: 'live', needle: "skills?.[String(id)]", basis: 'dynamic-index', evidence: "refactor/modules/extensions/skills/config.js" },
  { key: "skills.conversation-memory.enabled", kind: 'live', needle: "skills?.[String(id)]", basis: 'dynamic-index', evidence: "refactor/modules/extensions/skills/config.js" },
  { key: "skills.memory-recall.enabled", kind: 'live', needle: "skills?.[String(id)]", basis: 'dynamic-index', evidence: "refactor/modules/extensions/skills/config.js" },
  { key: "skills.knowledge-memes.enabled", kind: 'live', needle: "skills?.[String(id)]", basis: 'dynamic-index', evidence: "refactor/modules/extensions/skills/config.js" },
  { key: "skills.sticker-annotate.enabled", kind: 'live', needle: "skills?.[String(id)]", basis: 'dynamic-index', evidence: "refactor/modules/extensions/skills/config.js" },
  { key: "skills.reverse-image.enabled", kind: 'live', needle: "skills?.[String(id)]", basis: 'dynamic-index', evidence: "refactor/modules/extensions/skills/config.js" },
  { key: "skills.account-pool.enabled", kind: 'live', needle: "skills?.[String(id)]", basis: 'dynamic-index', evidence: "refactor/modules/extensions/skills/config.js" },
  { key: "skills.media-download.enabled", kind: 'live', needle: "skills?.[String(id)]", basis: 'dynamic-index', evidence: "refactor/modules/extensions/skills/config.js" },
  { key: "skills.speech-to-text.enabled", kind: 'live', needle: "skills?.[String(id)]", basis: 'dynamic-index', evidence: "refactor/modules/extensions/skills/config.js" },
  { key: "skills.owner-identity.enabled", kind: 'live', needle: "skills?.[String(id)]", basis: 'dynamic-index', evidence: "refactor/modules/extensions/skills/config.js" },
  { key: "skills.reply-safety.enabled", kind: 'live', needle: "skills?.[String(id)]", basis: 'dynamic-index', evidence: "refactor/modules/extensions/skills/config.js" },
  { key: "skills.video-frames.enabled", kind: 'live', needle: "skills?.[String(id)]", basis: 'dynamic-index', evidence: "refactor/modules/extensions/skills/config.js" },
  { key: "skills.calculator.enabled", kind: 'live', needle: "skills?.[String(id)]", basis: 'dynamic-index', evidence: "refactor/modules/extensions/skills/config.js" },
  { key: "skills.text-tools.enabled", kind: 'live', needle: "skills?.[String(id)]", basis: 'dynamic-index', evidence: "refactor/modules/extensions/skills/config.js" },
  { key: "skills.weather-query.enabled", kind: 'live', needle: "skills?.[String(id)]", basis: 'dynamic-index', evidence: "refactor/modules/extensions/skills/config.js" },
  { key: "skills.random-image.enabled", kind: 'live', needle: "skills?.[String(id)]", basis: 'dynamic-index', evidence: "refactor/modules/extensions/skills/config.js" },
  { key: "skills.image-generate.enabled", kind: 'live', needle: "skills?.[String(id)]", basis: 'dynamic-index', evidence: "refactor/modules/extensions/skills/config.js" },
  { key: "extensions.hotReload", kind: 'live', needle: "extensions.hotReload", basis: 'full', evidence: "refactor/apps/server/assembly.js" },
  { key: "knowledge.internal.enabled", kind: 'dead', needle: "knowledge.internal.enabled", basis: 'none', evidence: null, risk: 'generic-leaf' },
  // ★ N73 复验：`f5de1644` 把老树 src/orchestrator.js:2868-2919 那两块提示注入搬回来了
  //   （compose.js:206 externalKnowledgeHint / :238 selfImageHint）⇒ 这三个键有真读点；
  //   ⚠ **同族的 `knowledge.internal.enabled` 与 `knowledge.images.enabled` 仍然零读点**（见上/下行）——
  //   那个 commit 只接了"外部知识 + 自拍"，没接"内部知识总开关"和"图库提示总开关"，别顺手以为整族都通了。
  { key: "knowledge.external.enabled", kind: 'live', needle: "knowledge.external.enabled", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js", risk: 'generic-leaf' },
  // ★ N36 回对（**当时是假活键**）：旧行 needle 'triggerWords' 撞的是 internet/wiki.js:29 从
  //   `webSearch.wiki.sources[].triggerWords` 取的词表 —— **两套不同的词表**，那轮判死是对的。
  //   ★ N73：现在真消费点接上了（compose.js:223，先查 wiki 源词表、没命中再回落到这个键）⇒ 转活。
  { key: "knowledge.external.triggerWords", kind: 'live', needle: "'knowledge.external.triggerWords'", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js" },
  { key: "knowledge.images.enabled", kind: 'dead', needle: "knowledge.images.enabled", basis: 'none', evidence: null, risk: 'generic-leaf' },
  { key: "knowledge.images.autoCueSelf", kind: 'live', needle: "knowledge.images.autoCueSelf", basis: 'full', evidence: "refactor/modules/orchestrator/compose.js" },
  { key: "server.port", kind: 'live', needle: "server.port", basis: 'full', evidence: "refactor/apps/server/api/shell.js" },
  { key: "server.instanceName", kind: 'live', needle: "server.instanceName", basis: 'full', evidence: "refactor/apps/server/api/shell.js" },
  { key: "server.token", kind: 'live', needle: "server.token", basis: 'full', evidence: "refactor/apps/server/api/console.js" },
  // ★ N36 回对（**语料盲区，不是欠账**）：三个键的消费者全在 `refactor/apps/desktop/main.js`
  //   （Electron 主进程，不在 CORPUS_DIRS 里）：autoStart :171,429,1266-1336 · autoStartPeer :460 ·
  //   closeToTray :1737,1742。老树对应 electron/main.js:148,404,1231-1301 / :435 / :1702,1707。
  //   ⚠ 别误判：apps/server/jev-local-model.js:213 的 `autoStart` 是 Jev 本地模型的 `local.autoStart`，
  //     与 `server.autoStart` 同名不同键。
  { key: "server.autoStart", kind: 'dead', needle: "server.autoStart", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },
  { key: "server.autoStartPeer", kind: 'dead', needle: "server.autoStartPeer", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },
  { key: "server.closeToTray", kind: 'dead', needle: "server.closeToTray", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },
  { key: "ui.theme", kind: 'live', needle: "theme", basis: 'suffix', evidence: "refactor/apps/server/api/shell.js" },
  { key: "ui.customBg", kind: 'live', needle: "customBg", basis: 'suffix', evidence: "refactor/modules/themes/index.js" },
  { key: "ui.customBg2", kind: 'live', needle: "customBg2", basis: 'suffix', evidence: "refactor/modules/themes/index.js" },
  { key: "ui.customBg3", kind: 'live', needle: "customBg3", basis: 'suffix', evidence: "refactor/modules/themes/index.js" },
  { key: "ui.customAccent", kind: 'live', needle: "customAccent", basis: 'suffix', evidence: "refactor/modules/themes/index.js" },
  { key: "ui.customText", kind: 'live', needle: "customText", basis: 'suffix', evidence: "refactor/modules/themes/index.js" },
  { key: "ui.customMuted", kind: 'live', needle: "customMuted", basis: 'suffix', evidence: "refactor/modules/themes/index.js" },
  { key: "ui.customFaint", kind: 'live', needle: "customFaint", basis: 'suffix', evidence: "refactor/modules/themes/index.js" },
  { key: "ui.customToolAccent", kind: 'live', needle: "customToolAccent", basis: 'suffix', evidence: "refactor/modules/themes/index.js" },
  { key: "ui.customThemeId", kind: 'live', needle: "ui.customThemeId", basis: 'full', evidence: "refactor/apps/server/api/shell.js" },
  // ★ N36 回对（**语料盲区**）：下面这些键的消费者全在 `refactor/apps/ui/app.js` 与
  //   `refactor/apps/desktop/main.js`，两者都**故意**不在 CORPUS_DIRS 里（见 :35 的说明②）。
  //   2026-10-14 设置页零读点行为核验把 `ui.refreshMs`、`ui.desktopPetShowUsage`、
  //   `ui.desktopPetShowMood` 翻成 live/out-of-corpus：改值后轮询间隔、桌宠对应行确实改变。
  //   它们的设置读写路径由本语料中的 console-api 配置接口承接；直接消费者行号见下方。
  //   其他不在设置页这批 61 项中的 UI/桌宠键继续保留原判定。实查消费点：
  //   customExtraColors app.js:885,1028-1031 · mechFx :1056,14745 · brightness :402,14686-14695 ·
  //   uiScale :566,14712-14735 · showVision :10947 · refreshMs :5537,5755 · hideApiNews :1651,3959-3988 ·
  //   hideInstanceTabs :4673 · topOrder :4052,4248 · topHidden :4053,4249 · devMode :1860,2833 ·
  //   devChanges :2834,2915-2990（UI 写回的留痕，非旋钮）·
  //   desktopPetSize app.js:14072,14246 + desktop/main.js:596,613 + pet-renderer.js:381 ·
  //   desktopPetAutoActions app.js:14095,14254 + main.js:289 + pet-renderer.js:955,1334 ·
  //   desktopPetShowUsage app.js:15158,18314 → main.js:847,849 → pet-renderer.js:340,1335 ·
  //   desktopPetShowMood app.js:15159,18315 → main.js:847,849 → pet-renderer.js:352,1336 ·
  //   desktopPetSkin app.js:14091,14302 + main.js:617-619,678 + apps/desktop/pet-skins/ ·
  //   desktopPetX/Y main.js:824-825,843-844（主进程拖动后写回，**非旋钮**）。
  //   这三个字段的 UI 角标由 `gen-config-truth.mjs` 根据下方 live 台账行生成，不手改生成表。
  { key: "ui.customExtraColors", kind: 'dead', needle: "ui.customExtraColors", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },
  { key: "ui.mechFx", kind: 'dead', needle: "ui.mechFx", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },
  { key: "ui.brightness", kind: 'dead', needle: "ui.brightness", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },
  { key: "ui.uiScale", kind: 'dead', needle: "ui.uiScale", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },
  { key: "ui.showVision", kind: 'dead', needle: "ui.showVision", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },
  { key: "ui.refreshMs", kind: 'live', needle: "cs.updateConfigAndSave", basis: 'out-of-corpus', evidence: "refactor/apps/server/console-api.js", risk: 'out-of-corpus-consumer' },
  { key: "ui.hideApiNews", kind: 'dead', needle: "ui.hideApiNews", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },
  { key: "ui.hideInstanceTabs", kind: 'dead', needle: "ui.hideInstanceTabs", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },
  // ★ N45 回对（**假活键**，扫描器自己造的）：这两行原记 kind:'live' + evidence `extensions/plugin-loader.js`，
  //   而 plugin-loader.js:472 那句 `"navOrder/navHidden preferences continue to take precedence over plugin"`
  //   是**注释**，不是读点。真消费者全在 apps/ui（app.js:3959-3961/3980 重排与隐藏、:4183-4184 与 :17193-17194 写回、
  //   :3017/3049-3051/3072-3073 devmode 页签、:15782 可见性）⇒ 与上面那一族同口径：kind 按"语料内有无消费者"记 dead，
  //   功能其实通着，靠 risk 从"值得接线"里筛掉。
  { key: "ui.navOrder", kind: 'dead', needle: "ui.navOrder", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },
  { key: "ui.navHidden", kind: 'dead', needle: "ui.navHidden", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },
  { key: "ui.topOrder", kind: 'dead', needle: "ui.topOrder", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },
  { key: "ui.topHidden", kind: 'dead', needle: "ui.topHidden", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },
  { key: "ui.desktopPetSize", kind: 'dead', needle: "ui.desktopPetSize", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },
  { key: "ui.desktopPetAutoActions", kind: 'dead', needle: "ui.desktopPetAutoActions", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },
  { key: "ui.desktopPetShowUsage", kind: 'live', needle: "cs.updateConfigAndSave", basis: 'out-of-corpus', evidence: "refactor/apps/server/console-api.js", risk: 'out-of-corpus-consumer' },
  { key: "ui.desktopPetShowMood", kind: 'live', needle: "cs.updateConfigAndSave", basis: 'out-of-corpus', evidence: "refactor/apps/server/console-api.js", risk: 'out-of-corpus-consumer' },
  { key: "ui.desktopPetSkin", kind: 'dead', needle: "ui.desktopPetSkin", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },
  { key: "ui.desktopPetX", kind: 'dead', needle: "ui.desktopPetX", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },
  { key: "ui.desktopPetY", kind: 'dead', needle: "ui.desktopPetY", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },
  { key: "ui.devMode", kind: 'dead', needle: "ui.devMode", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },
  { key: "ui.devChanges", kind: 'dead', needle: "ui.devChanges", basis: 'none', evidence: null, risk: 'out-of-corpus-consumer' },

  // ── M7 本地语义召回：开关与环境参数由 assembly 启动时读取，运行态状态由 apps/server 暴露 ──
  // modelSha256 随制品固定在 BGE_ZH_LOCAL_PROFILE（core/vector/profile.js:208），不是用户配置项。
  { key: "vector.enabled", kind: 'live', needle: "vector.enabled", basis: 'full', evidence: "refactor/apps/server/assembly.js" },
  { key: "vector.modelPath", kind: 'live', needle: "vector.modelPath", basis: 'full', evidence: "refactor/apps/server/assembly.js" },
  { key: "vector.executablePath", kind: 'live', needle: "vector.executablePath", basis: 'full', evidence: "refactor/apps/server/assembly.js" },
  // ★ 2026-10-17：'auto' | 'cpu' | 'cuda' —— 决定用哪支 profile（CPU/CUDA 档）与 --gpu-layers 缺省。
  //   真读点 = assembly 的 `wantsCuda`（默认 'auto' 时按 executablePath 是否指向 llama-cuda 判）。
  //   无 GPU 的普通 Windows 是可用基线：缺省 CPU 档，机器能跑 CUDA 时用户显式选 cuda。
  { key: "vector.runtime", kind: 'live', needle: "vector.runtime", basis: 'full', evidence: "refactor/apps/server/assembly.js" },
  { key: "vector.logPath", kind: 'live', needle: "vector.logPath", basis: 'full', evidence: "refactor/apps/server/assembly.js" },
  { key: "vector.port", kind: 'live', needle: "vector.port", basis: 'full', evidence: "refactor/apps/server/assembly.js" },
];

/** 叶子键（数组与空对象算一个叶子）。 */
export function leavesOf(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) leavesOf(v, key, out);
    else out.push(key);
  }
  return out;
}

/** 按台账口径判定单个键，返回 {live, needle, basis, evidence, hits}。 */
export function classifyKey(key, corpusText) {
  const filesWith = (needle) => corpusText.filter((f) => f.text.includes(needle)).map((f) => f.rel);
  let needle = key;
  let hits = filesWith(key);
  let basis = hits.length ? 'full' : 'none';
  if (!hits.length) {
    for (const cand of suffixesOf(key).slice(1)) {
      const h = filesWith(cand);
      if (h.length && (cand.split('.').length >= 2 || h.length <= RARE)) { needle = cand; hits = h; basis = 'suffix'; break; }
    }
  }
  return { live: hits.length > 0, needle, basis, evidence: hits[0] ?? null, hits: hits.length };
}

export function readCorpus() {
  return corpusFiles().map((rel) => ({ rel, text: stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')) }));
}

/**
 * needle 的**独立标识符**匹配次数（N51 加的第三颗扫描器牙，前两颗是"注释不算读点"和"行号不绑死"）。
 *
 * ★★ 为什么要它：`includes(needle)` 会把 needle 当成**任意子串**，而后缀式 needle 天生会被更长的驼峰标识符吃掉：
 *   实测 4 行假活 —— needle `allCount` 撞的是 `toolCallCount`/`modelCallCount`/`callCount`
 *   （`store.allCount`/`store.private.allCount` 因此被标成"活键"，实际全树零读点 —— 正是 N51-B 那 6 个配额键的**同一族**）；
 *   needle `participation` 撞的是 `participation_gate`（一个不相干的内部名）；
 *   needle `api.textOnlyJudge` 撞的是 `api.textOnlyJudgeLocal`（同行还有 `…Tokens`）⇒ evidence 指到了 salvage.js，
 *   真读点其实在 `orchestrator/compose.js` 的 `cfg?.get?.('api.textOnlyJudge', true)`。
 *   ⇒ 假活比假死危险：它把真缺口说成"功能通了"，下一个人就不来了。
 *
 * 规则：命中位置的**前一个字符**不能是标识符字符（`[A-Za-z0-9_$]`）、**后一个**也不能。
 *   `.` 两侧都放行 ⇒ `sendConfig.splitLongAt`（真读点）算命中，`toolCallCount`（撞名）不算；
 *   后缀式 needle 是**有意**用点号后面那截的，所以"前面是点"必须允许。
 * ⚠ 已知过度匹配（如实记）：`a.imageSend.maxPerRun` 里有 needle `imageSend.maxPerRun`，
 *   两侧都是点 ⇒ 算命中。要防这种得用整条点路径，而那正是"整块取 cfg.send 再点属性"漏报的原因。
 *   两害相权：**漏报（假死）能被牙④/人工回对抓到，误命中（假活）没人会去查** ⇒ 这里选择允许点号。
 *   ⚠ 另一种漏过来的：连字符/空格包的字符串字面量也算命中 —— 实测 needle `probability`
 *   命中 `modules/jev/engine.js` 的 `'malformed-probability-distribution'`（`sticker.autoPick.probability` 因此被标成活键，
 *   本轮已降级）。⇒ **单段通用名（`probability`/`enabled`/`model`…）永远不许当 needle**，`RISK_GENERIC_LEAF` 的口径不变。
 */
export function needleHits(text, needle) {
  const n = String(needle ?? '');
  if (!n) return 0;
  const word = '[A-Za-z0-9_$]';
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<!${word})(?:${escaped})(?!${word})`, 'g');
  return String(text ?? '').match(re)?.length ?? 0;
}

/**
 * 剥掉 `//` 行注释与 `/* *\/` 块注释，**保留字符串/模板字面量**，并保持行数不漂
 * （注释换成等长空白，这样万一有人拿 offset 算行号也不会漂）。
 * ⚠ 不处理正则字面量里的 `/`：语料里 `/\d+/` 这类不含 `//`，实测不影响判定；
 *   真要出现 `x = a / /re/.test(b)/` 这种写法会被误剥 —— 那属于"扫描器少认一点"，
 *   少认只会让键显得更死（假死方向），而假死会被人工回对（本表的 out-of-corpus risk 就是这么来的）抓到。
 */
export function stripComments(text) {
  let out = '';
  let q = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (q) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 1; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { q = c; out += c; continue; }
    if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') { out += ' '; i += 1; } out += '\n'; continue; }
    if (c === '/' && next === '*') {
      out += '  '; i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { out += text[i] === '\n' ? '\n' : ' '; i += 1; }
      out += '  '; i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

export function isRiskGenericLeaf(key) {
  return RISK_GENERIC_LEAF.includes(key.split('.').at(-1));
}
