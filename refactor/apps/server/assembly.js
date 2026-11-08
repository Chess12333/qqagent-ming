/**
 * refactor/apps/server/assembly.js — 装配根
 *
 * 职责：加载配置、初始化各模块、注入依赖、注册 bus 事件。
 * **只做 IO/接线，不做决定。**
 *
 * 依赖方向：apps → modules → core → contracts（只许 import 各模块的 index.js）
 * 只许 import 各模块的 index.js，不许进内部文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveDataDir, extensionRoots, REPO_ROOT } from './paths.js';
import { pathToFileURL } from 'node:url';
import { createLlamaEmbeddingRuntime, BGE_ZH_LOCAL_PROFILE, BGE_ZH_LOCAL_CUDA_PROFILE, portAvailable } from '../../core/vector/index.js';
import { createPersonaBoundary } from '../../core/persona-context.js';
import { createUiPreview } from './ui-preview.js';
// ★ N33 第二次追加：M6 的 `extract` 依赖实现（调模型做情节摘要；走 llm 公开出口，不改受管副本）
import { createMemoryExtract } from './memory-extract.js';
// ★ 2026-10-16：一键清理 B/C 的模型门 provider（预算/结算是同一 llmBudgetService，模型通道是 llm 的
//   budgeted 调用；只在用户显式 apply + 明确 gate 意图时被端点注入，默认盘点/A 一律不碰模型）。
import { createMemoryCleanupGates } from './memory-cleanup-gates.js';
import { createMemoryMaintenance } from './memory-maintenance.js';
import { wireStoreCaps } from './store-caps.js';
import { createEmotionConfigStore } from './emotion-config.js';
import { createBudgetService } from '../../core/budget/index.js';
import { allowGate } from '../../core/policy/allow-gate.js';

// ── 模块加载表（§3.7 冻结出口名）─────────────────────────────────────────
// 每项：{ id, specifier, exports: [必须存在的导出名] }
// 加载时逐个 import，缺失的列出来，不许静默降级。

const MODULE_LOAD_TABLE = [
  {
    id: 'contracts',
    specifier: '../../contracts/index.js',
    exports: ['SCHEMA_VERSION', 'validateMessageEvidence', 'makeMessageEvidence', 'makeIdempotencyKey']
  },
  {
    id: 'core/config-store',
    specifier: '../../core/config-store/index.js',
    exports: ['load', 'get', 'set', 'effective', 'sourceOf', 'snapshot', 'DEFAULT_CONFIG',
      'describeInstance',
      // ★ A60：装配层要用它接 `extensions.hotReload` 的**活开关**（配置一改就重新判定 watcher）。
      //   core/config-store 早就导出了这个函数，只是没进本表 ⇒ 装配层拿不到。
      'subscribeConfigChange']
  },
  {
    id: 'core/observability',
    specifier: '../../core/observability/index.js',
    exports: ['span', 'event', 'ledger', 'log', 'on', 'emit', 'recent']
  },
  {
    id: 'modules/scenario',
    specifier: '../../modules/scenario/index.js',
    exports: ['ingestBatch']
  },
  {
    id: 'modules/memory',
    specifier: '../../modules/memory/index.js',
    exports: ['retrieve', 'commit', 'configure', 'setDataDir']
  },
  {
    id: 'modules/plan',
    specifier: '../../modules/plan/index.js',
    exports: ['decide', 'createTopicRegistry', 'DEFAULT_TOPIC_IDLE_MS', 'explicitlyChangesTopic']
  },
  {
    id: 'modules/act',
    specifier: '../../modules/act/index.js',
    exports: ['run', 'send', 'assertDelivered']
  },
  {
    id: 'modules/emotion',
    specifier: '../../modules/emotion/index.js',
    exports: ['relationOf']
  },
  {
    id: 'modules/jev',
    specifier: '../../modules/jev/index.js',
    exports: ['asSignal', 'isJudgeModelBound']
  },
  {
    id: 'modules/platform',
    specifier: '../../modules/platform/index.js',
    exports: []
  },
  {
    id: 'modules/llm',
    specifier: '../../modules/llm/index.js',
    exports: ['chatCompletion', 'resolveApiKey', 'createBudgetedJudgeModel']
  },
  {
    id: 'modules/extensions',
    specifier: '../../modules/extensions/index.js',
    exports: ['loadPlugins', 'skillManager']
  },
  {
    id: 'modules/prompt',
    specifier: '../../modules/prompt/index.js',
    exports: ['buildMessages']
  },
  {
    id: 'modules/proactive',
    specifier: '../../modules/proactive/index.js',
    exports: ['createProactive']
  },
  {
    id: 'modules/reminders',
    specifier: '../../modules/reminders/index.js',
    // 主动性（缺口②）：**登记进表 = 硬要求**（assemble 对 missing 一律抛，不做"可选模块"降级）。
    // 表里有、而文件不在 ⇒ 启动就报错；不想让它成为硬要求就别登记（SELF_DRIVEN 那圈会跳过）。
    exports: ['createReminders']
  },
  {
    id: 'modules/broadcast',
    specifier: '../../modules/broadcast/index.js',
    exports: ['createBroadcast', 'buildLlmCopyMessages', 'normalizeCopyText']
  },
  {
    id: 'modules/orchestrator',
    specifier: '../../modules/orchestrator/index.js',
    exports: ['createRuntime'],
    optional: false  // M15 未落地时必须报缺失（EXIT≠0），不许 stub
  },
  {
    id: 'modules/media',
    specifier: '../../modules/media/index.js',
    exports: []
  },
  {
    id: 'modules/internet',
    specifier: '../../modules/internet/index.js',
    exports: []
  },
  {
    // 2026-10-05 T-THEMES-PORT：主题族 5 条 API 从 501 变真实现（旧 src/themes.js）。
    // themesDir 由模块自解析（configure / QQ_AGENT_THEMES_DIR / 仓库根 themes），装配层不注入。
    id: 'modules/themes',
    specifier: '../../modules/themes/index.js',
    exports: ['listThemes', 'getThemeById', 'buildThemeUiConfig', 'importTheme', 'resolveThemesDir']
  },
  {
    // 2026-10-05 W3（sb2 5165c7dd）：雪洛玛**进程管理**（launch/stop/logs/check-accounts/open-folder/open-webui）。
    // ★ 不是移植网关本体 —— 网关仍在工作区 `snowluma/`（launcher.bat + 自带 node.exe），本模块只管进程与状态。
    // ⚠️ dir 由模块自解析（configure / config.snowluma.dir），**装配层不注入**；spawn 语义与失败可见性由模块自测逐字节验。
    // 指挥位 2026-10-05 15:5x 补这行（sb2 的请求）：shell.js 会优先用 `ctx.modules.snowluma`，
    // 没有它时才 import 本模块一次并缓存（进程内单实例，环形日志不会被劈成两半）。
    id: 'modules/snowluma',
    specifier: '../../modules/snowluma/index.js',
    // ★ 这份名单是**消费者契约**（fail-closed：列出的名字必须都存在），不是"模块全部导出"。
    //   依据 = api/shell.js 各端点在调用点声明的 needed：
    //     launch→['launch'] · logs→['getLogs'] · stop→['stop','status'] ·
    //     check-accounts→['checkAccounts','scanAccounts','getWarning'] · open-folder→['openFolder'] ·
    //     open-webui→['openWebui'] · 且 launch/check-accounts 会先调 configure。
    //   sb2 2026-10-05 16:1x 提醒：漏了 scanAccounts / getWarning 会让 check-accounts 那条**日后**被人"精简"名单时静默 501 ⇒ 已补。
    //   刻意**不**把模块的 27 个名字全列进来 —— 那会让任何私有改名都把整棵树卡在加载期。
    exports: ['status', 'launch', 'stop', 'getLogs', 'checkAccounts', 'scanAccounts', 'getWarning',
              'openFolder', 'openWebui', 'configure']
  },
  {
    // 2026-10-05 T-SESSION-CLEANUP-PORT（sb2 5165c7dd）：会话登记表 + 清理服务。
    // ★ 两个模块都是**工厂**（createXxx），不是现成实例 —— 实例化需要 dataDir / registry，只有接线层知道。
    //   ⇒ 这里只保证"名字存在"（fail-closed 契约），实例化在 `api/shell.js` 里懒构造并缓存
    //   （它拿得到 `ctx.dataDir` 与 `ctx.modules`）。
    //   ⚠️ 与 snowluma 同理：**只列消费者真正 import 的名字**，不列模块的全部导出。
    id: 'modules/sessions',
    specifier: '../../modules/sessions/index.js',
    exports: ['createSessionRegistry']
  },
  {
    id: 'modules/cleanup',
    specifier: '../../modules/cleanup/index.js',
    exports: ['createCleanupService']
  },
  {
    // 2026-10-05 T-PETSKINS-PORT：`GET /api/pet-skins`（旧树 src/pet-skins/registry.js）。
    // ★ 这一条是**指挥位补的洞**：模块 `modules/pet-skins/`（mimo）与 `api/media.js` 的 handler 都已落地，
    //   但**加载表里没有这一行** ⇒ `ctx.modules.get('modules/pet-skins')` 永远 undefined ⇒
    //   handler 走 `notPorted(...)` 分支 ⇒ 端点**永久 501**，而 501 正好也是"还没搬"的合法答复，
    //   于是"看起来搬完了"和"永远没好"在日志上长得一模一样（静默假绿）。命令实测抓不到，只能读表抓到。
    // === 为什么这里只登记命名空间、不实例化 ===
    //   `createSkinRegistry({repoRoot, ttlMs})` 要的是**仓库根**，不是 dataDir；装配层不掌握仓库根的唯一来源
    //   ⇒ 与 sessions/cleanup 同理，实例化交给接线层（`api/media.js` 的 handler）。
    //   exports 仍是**消费者契约**（fail-closed）：media.js 的 handler 只用这两个名字。
    //   ⚠️ 顺带记下接线层必须自己解决的问题：`ctx.repoRoot` 在 apps/server 全树**不存在**
    //   （唯一出现处就是 media.js:480 的读取点）⇒ 现在它恒为 undefined，registry 会退回 `process.cwd()`，
    //   若 cwd 不是仓库根就扫不到 skin 目录 ⇒ 返回 `{skins:[],problems:[...]}` 的 **200 空表**（假绿比 501 更毒）。
    //   验收锚点只能是"与旧树同一磁盘状态下的同一答复"，不是我们的口味。
    id: 'modules/pet-skins',
    specifier: '../../modules/pet-skins/index.js',
    exports: ['createSkinRegistry', 'petSkinsView']
  }
];

/**
 * 加载全部模块，返回 { loaded: Map, missing: [] }。
 * 缺失模块**不静默降级**，由调用方决定是否继续。
 */
export async function loadModules() {
  const loaded = new Map();
  const missing = [];
  for (const entry of MODULE_LOAD_TABLE) {
    try {
      const mod = await import(entry.specifier);
      // 检查必须存在的导出名
      const absent = entry.exports.filter((name) => !(name in mod));
      if (absent.length > 0) {
        missing.push({ id: entry.id, specifier: entry.specifier, reason: `缺少导出: ${absent.join(', ')}` });
        continue;
      }
      loaded.set(entry.id, mod);
    } catch (error) {
      missing.push({
        id: entry.id,
        specifier: entry.specifier,
        reason: `ERR_MODULE_NOT_FOUND: ${error?.message ?? error}`
      });
    }
  }
  return { loaded, missing };
}

/**
 * 建立语义召回对象。调用者必须先显式启动 runtime；失败时不创建 adapter，避免状态误报。
 * @param {{loaded: Map<string, object>, runtime: object, log?: function}} deps
 * @returns {object|null}
 */
function createSemanticRecallOrNull({ loaded, runtime, log }) {
  const memMod = loaded.get('modules/memory');
  if (typeof memMod?.createMemorySemanticRecall !== 'function') {
    throw new Error('modules/memory 未导出 createMemorySemanticRecall');
  }
  // ★ 2026-10-17：profile **取自 runtime 自己那一支**（CPU/CUDA 两档），不再钉死 CPU 档常量 ——
  //   索引侧会拿 profileFingerprint 与 embedder 对账（vector-index.js 的 createIndex），
  //   这里若与实际运行的运行环境档不一致，索引会判 version-incompatible。
  const activeProfile = runtime?.profile ?? null;
  if (!activeProfile || typeof runtime?.embedder?.embed !== 'function') {
    throw new Error('向量 runtime 未就绪，不能建立 semantic recall');
  }
  try {
    return memMod.createMemorySemanticRecall({ profile: activeProfile, embedder: runtime.embedder });
  } catch (error) {
    throw new Error(`semantic recall 装配失败：${error?.message ?? error}`);
  }
}

/**
 * 把「已加载的模块 Map」变成 M15 看到的 modules 命名空间（属性访问，不是 Map.get）。
 *
 * ★ 这是活实例的注入点，必须与实盘共用同一份逻辑——自测自己手搓一个 modulesObj
 *   就会出现「自测全绿、实盘每轮都报错」的假绿（2026-10-04 实测）。
 *   - OneBot platform 由 ctx.setPlatform() 在 start() 后注入；
 *   - M7 情绪是纯状态模型，活状态实例在这里绑成 §3.7 冻结形状 relationOf({chatKey,senderId})。
 * @param {Map<string, object>} loaded - loadModules() 的结果
 * @param {object} [opts]
 * @param {string} [opts.dataDir] - 给了才启用情绪落盘（`<dataDir>/emotion-state.json`）
 * @param {function} [opts.log]
 * @returns {object} modules 命名空间（同一份对象要一直被复用）
 */
export function buildRuntimeModules(loaded, {
  dataDir = '', log = null, configStore: configStoreOverride = null,
  getSemanticRecall = () => null, getVectorRecallQuery = () => ''
} = {}) {
  const modulesObj = {};
  for (const [id, mod] of loaded) {
    const shortName = id.replace(/^modules\//, '');
    modulesObj[shortName] = mod;
  }
  // 也放入 config-store / observability
  modulesObj.configStore = configStoreOverride ?? loaded.get('core/config-store');
  modulesObj.observability = loaded.get('core/observability');

  // ★ 聊天存档（ChatStore）注入（2026-10-05，sb4 的 store 已落地）：
  //   工具执行器按 `ctx.modules.memory.store` 探测（"引用追问/翻旧账/#318" 那 5~6 个工具全卡在这），
  //   而 **ESM 模块命名空间对象不可写**（`loaded.get()` 拿到的是 namespace，加属性会抛）
  //   ⇒ 只能在外层包一份门面：模块原有的导出一个不少，只多挂一个 `store` 实例。
  //   传的 dataDir 必须是装配层解析出来的那个（ChatStore 自己不许去找数据目录）。
  const memoryMod = loaded.get('modules/memory');
  let chatStoreForModules = null;
  /** ★ N33：全树唯一的 Memory Coordinator 实例；没装成功就是 null，端点如实报 501。 */
  let memoryCoordinator = null;
  let memoryCoordinatorAccountId = '';
  /**
   * ★ N38：「只整理这一个人」的**待用作用域**（chatKey → subjectId 集合），**每个装配实例一份**。
   *
   * 为什么要有：coordinator 的 `requestConsolidation` 契约里**没有** subjectIds 这一档
   * （bunny2 的 N34 契约），而 `runNextJob` 调 extract 时也不带它 ⇒ 端点无法把"只整理谁"
   * 直接送进队列。**合并不覆盖**：连点两个人时两个都进，宁可多整理也不静默丢掉一个。
   * **取用即清空**：只对下一次该会话的抽取生效，不残留到后面几轮。
   * ★ 为什么**不放模块级**：自测会连着起多个实例（临时 dataDir 各不相同），模块级 Map 会让
   *   **不同实例共享同一份待用作用域**（实测：第二个实例读到了第一个实例留下的 id）。
   */
  const pendingConsolidationScope = new Map();
  /**
   * ★ N38：「只整理这一个人」的**待用作用域**（chatKey → subjectId 集合）。
   * 为什么要有：coordinator 的 `requestConsolidation` 契约里**没有** subjectIds 这一档
   * （bunny2 的 N34 契约），而 `runNextJob` 调 extract 时也不带它 ⇒ 端点无法把"只整理谁"
   * 直接送进队列。**合并不覆盖**：连点两个人时两个都进，宁可多整理也不静默丢掉一个。
   * **取用即清空**：只对下一次该会话的抽取生效，不残留到后面几轮。
   */

  if (memoryMod && typeof memoryMod.createChatStore === 'function') {
    try {
      // 与老树 isPersonaTwo() 同义：按 persona2.enabled 的当前持久化状态打自述标记。
      // 保留读取器而非启动时快照，让成功的切换写盘后下一条自述立即读到新状态。
      const isPersonaTwo = () => {
        try { return modulesObj.configStore?.get?.('persona2.enabled') === true; }
        catch { return false; }
      };
      // ★ 存储上限（store.maxMessagesPerChat / hotMessagesPerChat）：初值 + 热更新统一走 store-caps.js
      //   的 wireStoreCaps（与 onebot-link 兜底自建共用同一函数；同一实例只订阅一次）。只调 setter、
      //   不主动裁剪（裁剪只在 store 写入路径上发生）；UI 侧护栏（非零下限 100 + 下调二次确认）保持不变。
      const chatStore = memoryMod.createChatStore({ dataDir, log, isPersonaTwo });
      chatStoreForModules = chatStore;
      wireStoreCaps(chatStore, modulesObj.configStore, log);
      // 待办（旧 `src/conversation-memory/pending.js` 的搬运，`modules/memory/todos.js`）：
      //   执行器按 `ctx.modules.memory.todos?.saveTodo ?? ctx.modules.memory.saveTodo` 探测 ⇒ 挂在这层最简单。
      const todos = typeof memoryMod.createTodos === 'function' ? memoryMod.createTodos({ dataDir, log }) : null;
      modulesObj.memory = Object.freeze({ ...memoryMod, store: chatStore, ...(todos ? { todos } : {}) });
      log?.(`[apps/server] 已装配 ChatStore${todos ? ' + todos' : ''} → ctx.modules.memory.store/todos`);

      // ── ★ N33（2026-10-09）：**唯一**一个 Memory Coordinator 实例 ──────────────
      //
      // 背景（实测）：`modules/memory/index.js` 导出了 `createMemoryCoordinator`，
      // `coordinator.js` 有 `requestConsolidation({chatKey,kind,reason})`（真排队，回 `{ok,queued,jobId}`），
      // 而 `modules/orchestrator/index.js:180` 读的是 `memory?.coordinator` ——
      // ★ **全树没有任何一处把 coordinator 赋给 memory** ⇒ 那条分支是**死代码**。
      //
      // 现在这里造**一个**实例挂到 `ctx.memoryCoordinator`，给 HTTP 层两条整理端点共用
      // （**同一个对象，不各写一套**）。⚠ 刻意**不**挂成 `modulesObj.memory.coordinator`：
      //   那会让 orchestrator 从「M6 retrieve 兜底」切成 coordinator 路径 —— 那是 **bunny1 的域**，
      //   本票不擅自翻转；需要接线请派给他，实例已经现成。
      if (typeof memoryMod.createMemoryCoordinator === 'function') {
        try {
          // ① `extract`：调模型做"情节摘要"。实现住在 apps/server/memory-extract.js
          //    （方案 §4.2：M6 不直接依赖 llm，抽取由装配层注入），
          //    走 `modules/llm` 的**公开出口** `chatCompletion`，**不改 llm.js 受管副本**。
          const llmMod = loaded.get('modules/llm');
          const baseExtract = createMemoryExtract({ llm: llmMod, cfg: modulesObj.configStore, log });
          // ★ N38：「只整理这一个人」的收窄。
          //   `requestConsolidation({chatKey,kind,reason})`（bunny2 的契约）**没有 subjectIds 这一档**，
          //   而 `runNextJob` 调 extract 时也不带它 ⇒ 唯一的通道是先记在这儿、由 extract 包装层取用。
          //   **合并而不是覆盖**：连点两个人时两个都进（宁可多整理，不静默丢掉一个）。
          //   ⚠ 取用即清空：作用域只对**下一次**该会话的抽取生效，不会残留到后面几轮。
          //   ⚠ 已知边界（已写进回执）：收窄只发生在**抽取层**；队列游标成功后仍会推进，
          //     所以没被选中的人的这段消息不会留到下次 —— 要做到那一步需要 coordinator 按
          //     subjectId 收窄 `collectSources`（`modules/memory/**`，bunny2 的域）。
          const extract = baseExtract
            ? async (args) => {
              const key = String(args?.chatKey ?? '');
              const scope = key ? pendingConsolidationScope.get(key) : null;
              if (key) pendingConsolidationScope.delete(key);
              return baseExtract({ ...args, subjectIds: scope || null });
            }
            : null;
          /**
           * ★ 记忆页实时刷新（bus 事件 `memory-update`）——**唯一**事件生产点（装配层包一层；不改 modules/memory）。
           *   自动整理（orchestrator 的整理泵）与手工整理（api/memory.js）调用的是**同一个** coordinator 实例
           *   （`modulesObj.__memoryCoordinator` = `ctx.memoryCoordinator` = createCoordinator 返回的这一个）
           *   ⇒ 两种来源天然共用这一对事件，不各发一套、不会重复。
           *   事件语义（对齐旧树 `src/app.js:3276-3295` / `:3453-3459` 的 `emit('memory-update', …)` 三档；
           *   2026-10-15 按复核回执 aaf16f9c 的 B/C 条修正）：
           *     · consolidate-start —— 只在**马上要真的跑**时发：`runNextJob` 包壳里先 peek 到
           *       "下一个将被执行的 job"（与 runNextJob 同源同序：queued 按 createdAt 升序第一个）再发。
           *       **排队本身不是"整理中"**：忙碌 / 空队列 / 排着还没轮到 都不发帧；合并请求天然不发
           *       （start 与排队解耦后不再需要 merged 特判）。
           *     · consolidate-done  —— job 终态 done（含"没有可整理来源"那批）。
           *     · consolidate-error —— job 终态 failed / unconsolidated；`error` 只带**短码**（如 'extract-threw'）——
           *       只放行"机器码形状"（字母/数字/_/-，≤40）；**没有冒号**的 reason 也一律折叠，绝不把可能
           *       夹着模型输出片段的原文带进 SSE（全文照旧只进日志 / status()）。
           *   终态与 chatKey 都从 `status()` 按 jobId **反查盘上状态**（runJob 的返回不带 chatKey，不猜、不编）。
           *   重试中的 job（failJob 把 status 放回 queued）**不发终态帧**：UI 保持"整理中"，
           *   下一轮重跑会再发一次同 chatKey 的 start（幂等覆盖 startedAt，不产生需要清理的悬挂态）。
           *   隐私：载荷只有 {phase, chatKey}（含 error 短码）——无正文、无名字、无印象内容、无 userId。
           *   失败隔离：emit 抛错绝不影响整理主链。
           */
          const shortMemoryErrorCode = (value) => {
            const raw = String(value ?? '').trim();
            if (!raw) return 'failed';
            // ★ 复核 C/D（aaf16f9c）：先取冒号前的段，再按"机器码形状"放行；带空格 / 中文 / 引号 / JSON 残片
            //   的一律折叠成 'failed' —— reason 没有冒号时也不能把原文放出去。
            const head = raw.split(/[:：]/, 1)[0].trim().slice(0, 40);
            return /^[A-Za-z0-9_-]+$/.test(head) ? head : 'failed';
          };
          const wireMemoryUpdateEvents = (coordinator) => {
            if (!coordinator
              || typeof coordinator.status !== 'function'
              || typeof coordinator.runNextJob !== 'function') return;
            const emitUpdate = (payload) => {
              try { modulesObj.observability?.emit?.('memory-update', payload); } catch { /* 事件不许反噬 */ }
            };
            const nextQueued = (jobs) => (Array.isArray(jobs) ? jobs : [])
              .filter((j) => j?.status === 'queued')
              .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0))[0] ?? null;
            const rawRun = coordinator.runNextJob.bind(coordinator);
            coordinator.runNextJob = async (opts = {}) => {
              // ★ start 发在"开跑前一刻"（复核 B）：peek 到就发，紧随其后的 rawRun 才真正执行；
              //   队列空 ⇒ 不发；忙碌（别人正在跑）⇒ 也走这里但下面会记一行（r.ran=false 分支）。
              let next = null;
              try { next = nextQueued((await coordinator.status())?.jobs); } catch { next = null; }
              if (next?.chatKey) emitUpdate({ phase: 'consolidate-start', chatKey: String(next.chatKey) });
              const r = await rawRun(opts);
              if (r?.ran === true && r?.jobId) {
                let job = null;
                try { job = (await coordinator.status())?.jobs?.find((j) => j.jobId === r.jobId) ?? null; } catch { job = null; }
                if (!job) {
                  log?.('[apps/server] memory-update：整理 job 终态读不到（runNextJob 已返回但 status() 查无此 job）——本轮不发事件');
                } else if (job.status === 'done') {
                  emitUpdate({ phase: 'consolidate-done', chatKey: String(job.chatKey ?? '') });
                } else if (job.status === 'failed' || job.status === 'unconsolidated') {
                  emitUpdate({
                    phase: 'consolidate-error',
                    chatKey: String(job.chatKey ?? ''),
                    error: shortMemoryErrorCode(r?.reason ?? job?.reason)
                  });
                }
                // queued（重试中）不发终态帧 —— 还没完；下一轮重跑会重发 start（幂等），终态时再收尾。
              } else if (next?.chatKey) {
                // 预告过 start 但本次没真跑（busy / 队列已被别的调用消费）：不补其它帧、不吞错记一行。
                // 该 job 被**真正执行**的那一次调用会发同 chatKey 的 start（覆盖）+ 终态帧收尾 ⇒ 不会永久悬挂。
                log?.(`[apps/server] memory-update：start 已预告（chatKey=${String(next.chatKey)}）但本次 runNextJob 未执行（${r?.reason ?? 'no-reason'}）`);
              }
              return r;
            };
          };
          const createCoordinator = (accountId) => {
            const semantic = getSemanticRecall?.() || null;
            const coordinator = memoryMod.createMemoryCoordinator({
              dataDir, accountId, chatStore, todos,
              extract: extract || undefined,
              semantic: semantic || undefined,
              options: { manualEditLockConfig: modulesObj.configStore },
              clock: { now: () => Date.now() },
              log
            });
            // The orchestrator currently supplies an empty query for ordinary inbound turns.
            // Only when semantic recall is enabled, fill that missing query from the server's
            // current local-turn text; explicit topic/query values remain authoritative.
            if (semantic && typeof coordinator?.prepareContext === 'function') {
              const prepare = coordinator.prepareContext.bind(coordinator);
              coordinator.prepareContext = (options = {}) => {
                const query = String(options?.query ?? '').trim();
                if (query) return prepare(options);
                const localTurnQuery = String(getVectorRecallQuery?.(options?.chatKey) ?? '').trim();
                return prepare(localTurnQuery ? { ...options, query: localTurnQuery } : options);
              };
            }
            // ★ memory-update：把事件壳包在 coordinator 上（自动/手工两条路径共用同一个实例；见函数头注释）。
            wireMemoryUpdateEvents(coordinator);
            // ★ 2026-10-15（ds3 · 记忆自动整理调度）：把"自动整理的成本/限频闸"挂到**同一个**实例上。
            //   包的是 requestConsolidation：`orchestrator-observed-*` 这类自动请求被调度器接管（不直接入队、
            //   由心跳按 opt-in/限频补发，reason 用 'auto-maintenance'），手动 reason 原样透传 ⇒ HTTP 手动路径不变。
            //   详见 apps/server/memory-maintenance.js 文件头。
            memoryMaintenance.attach(coordinator);
            return coordinator;
          };
          // 平台登录号只在 OneBot 建连后可读；在此之前不以空值创建 default 账户账本。
          // orchestrator 首次读侧或 HTTP getter 取得真实 selfId 后会通过此回调创建唯一实例。
          modulesObj.__setMemoryCoordinatorAccountId = (value) => {
            const accountId = String(value ?? '').replace(/\D/g, '').trim();
            if (!accountId) return null;
            if (accountId === memoryCoordinatorAccountId && memoryCoordinator) return memoryCoordinator;
            try {
              memoryCoordinator = createCoordinator(accountId);
              memoryCoordinatorAccountId = accountId;
              modulesObj.__memoryCoordinator = memoryCoordinator;
              log?.('[apps/server] Memory Coordinator 已绑定平台账号作用域');
              return memoryCoordinator;
            } catch (error) {
              memoryCoordinator = null;
              memoryCoordinatorAccountId = '';
              modulesObj.__memoryCoordinator = null;
              log?.(`[apps/server] ⚠ Memory Coordinator 账号绑定失败：${error?.message ?? error}`);
              return null;
            }
          };
          /**
           * ★ 2026-10-16（C：向量语义召回的"活接线"）：`semantic` 只在 createMemoryCoordinator 那一刻被读入
           *   （memory/coordinator.js:74），而账号绑定（OneBot 一连上）通常**早于**向量 llama 加载完成 ⇒
           *   旧 coordinator 会永远拿 null，用户看到的就是"开关开着、还只走关键词"。
           *   这里给装配层一个内部入口：向量可用性变化后重建 + **重新发布**同一账号的 coordinator。
           *   消费方每次现取（orchestrator/index.js:365 的 getCoordinator、ctx.memoryCoordinator 的 getter）
           *   ⇒ 发布即生效；旧实例有 close 就关，失败只记日志，不吞错也不阻断主链。
           */
          modulesObj.__rebindMemoryCoordinatorForVector = () => {
            const accountId = memoryCoordinatorAccountId;
            if (!accountId || !memoryCoordinator) return false;
            const previous = memoryCoordinator;
            try {
              memoryCoordinator = createCoordinator(accountId);
              modulesObj.__memoryCoordinator = memoryCoordinator;
              try { previous?.close?.(); }
              catch (error) { log?.(`[apps/server] 旧 Memory Coordinator 关闭失败：${error?.message ?? error}`); }
              log?.('[apps/server] 向量语义召回可用性变化 ⇒ 已重建并重新发布 Memory Coordinator（索引随之接上/摘除）');
              return true;
            } catch (error) {
              log?.(`[apps/server] ⚠ 向量可用性变化后重建 Memory Coordinator 失败：${error?.message ?? error}`);
              return false;
            }
          };
          log?.(`[apps/server] Memory Coordinator 工厂已准备`
            + `（extract=${extract ? '已注入' : '缺 llm.chatCompletion'}；等待平台账号标识）`);
        } catch (error) {
          log?.(`[apps/server] ⚠ Memory Coordinator 装配失败（整理类端点会如实报 501）：${error?.message ?? error}`);
        }
      }
      // 内部接线标记（`__` 前缀 = 不是模块名）。不进 memory facade，避免翻转 orchestrator。
      modulesObj.__memoryCoordinator = memoryCoordinator;
      modulesObj.__consolidationScope = {
        add(chatKey, subjectIds) {
          const key = String(chatKey ?? '').trim();
          const ids = (Array.isArray(subjectIds) ? subjectIds : [subjectIds]).map((x) => String(x ?? '').trim()).filter(Boolean);
          if (!key || !ids.length) return [];
          const merged = new Set([...(pendingConsolidationScope.get(key) || []), ...ids]);
          pendingConsolidationScope.set(key, [...merged]);
          return [...merged];
        },
        peek(chatKey) { return [...(pendingConsolidationScope.get(String(chatKey ?? '')) || [])]; }
      };
    } catch (error) {
      log?.(`[apps/server] ⚠ ChatStore 装配失败（引用追问/翻旧账类工具会报"依赖未就绪"）：${error?.message ?? error}`);
    }
  }

  /**
   * ★ 2026-10-15（ds3 · 记忆自动整理调度）：**唯一** coordinator 的活取用口。
   *   平台登录号只在 OneBot 建连后可读 ⇒ 每次取用时自绑定（判据与下面 `get memoryCoordinator()`
   *   完全同源，避免两处各写一份）。未绑定/未装配一律 null ⇒ 调用方据此**不排队**。
   */
  function resolveMemoryCoordinator() {
    const accountId = String(modulesObj.platform?.selfId ?? modulesObj.platform?.client?.selfId ?? '').replace(/\D/g, '').trim();
    if (accountId) modulesObj.__setMemoryCoordinatorAccountId?.(accountId);
    return modulesObj.__memoryCoordinator ?? null;
  }
  // assemble() 返回的 HTTP ctx 也要用同一个解析入口；它不在本函数的词法作用域内。
  modulesObj.__resolveMemoryCoordinator = resolveMemoryCoordinator;

  /**
   * ★ 自动整理调度器（apps/server/memory-maintenance.js）：本实例**不自起 timer、不造第二个 coordinator**，
   *   只包那一个实例的排队入口，并由**同一个**心跳驱动（`apps/server/index.js` 的 setInterval 调 `tick`）。
   *   `memory.consolidateEnabled` 必须显式 true 才补发；`consolidateMinIntervalMs`（默认 7 天、地板 1h）限频；
   *   `maintenanceIntervalMs` 驱动本地无模型维护（pruneSurface）。差距与未接线项写在那个文件的文件头。
   */
  const memoryMaintenance = createMemoryMaintenance({
    configStore: modulesObj.configStore,
    memory: memoryMod,
    getCoordinator: resolveMemoryCoordinator,
    log
  });
  // `__` 前缀 = 内部接线标记（与 `__memoryCoordinator` / `__consolidationScope` 同规矩），不是模块名：
  // 这里只是把它带出 buildRuntimeModules，给 assemble 的 ctx 用（心跳那一侧）。
  modulesObj.__memoryMaintenance = memoryMaintenance;

  // ★ P0-5 技能可用性门面（照上面 store 门面的现成写法）：
  //   `act.getToolAvailability` 判技能工具时读 `context.skills.isActive/explainCapability/getToolGuards`，
  //   而这三个口只存在于 `modules/extensions` 转出的 `skillManager` 单例上（skills/manager.js:207/353/498）。
  //   不挂这层 ⇒ `orchestrator/compose.js` 的 `registry({...})` 拿不到 skills ⇒ 技能工具被
  //   `skill-unavailable` **静默过滤**（act/index.js:618-624 + :497-499）⇒ 模型工具表里一个技能工具都没有。
  //   ESM 模块命名空间不可写 ⇒ 与 store 一样在外层包门面；挂 `null` 而不是静默留空，
  //   让下游 `skills === undefined` 的短路（act/index.js:620 那个 `if (tool.skillId)`）保持原语义。
  const extensionsMod = loaded.get('modules/extensions');
  if (typeof extensionsMod?.skillManager?.isActive === 'function') {
    modulesObj.skills = extensionsMod.skillManager;
    log?.('[apps/server] 已装配技能可用性门面 → ctx.modules.skills（act 工具可用性判定用）');
  } else {
    modulesObj.skills = null;
    log?.('[apps/server] ⚠ 没有 skillManager（modules/extensions 未装配）⇒ 技能工具将对模型不可见');
  }

  // ★ 音乐（G19）：M14 新增的 `configureMusic({dataDir})` 必须由装配层调一次 ——
  //   不调 ⇒ 它的状态文件（`<dataDir>/music-played.json`）一律**拒写**（fail-closed 是设计，不是 bug），
  //   表现成"播过的歌不记账 ⇒ 避重失效"。它**不 import config-store**（防"导入期数据目录"那类坑），
  //   所以 dataDir 只能从这里的显式注入拿到。
  const internetMod = loaded.get('modules/internet');
  if (internetMod && typeof internetMod.configureMusic === 'function') {
    try {
      internetMod.configureMusic({ dataDir });
      log?.('[apps/server] 已注入音乐状态目录 → music-played.json 可写');
    } catch (error) {
      log?.(`[apps/server] ⚠ configureMusic 失败（避重记账会失效）：${error?.message ?? error}`);
    }
  }

  // ★ 主动性三兄弟（缺口②）：提醒 / 主动开话题 / 定时广播。
  //   挂点形状（M15 `onTick` 里逐字调用）：
  //     `modules.<name>.onTick(now, { wake, status, sendScheduled })`
  //   驱动者**只有应用层那一个心跳**（`apps/server/index.js` 的 setInterval）——模块不许自己 setTimeout。
  //   工厂式模块（导出 `createXxx`）由这里实例化并把 `dataDir / log / cfg` 注入：
  //   模块**不许自己去找数据目录**（core/config-store 的 DATA_DIR 是导入期求值的，找不到就会写错地方）。
  //   缺模块 ⇒ 静默跳过（这三个是"可选能力"，不是主链依赖；主链缺了才会在上面抛）。
  const SELF_DRIVEN = [
    ['modules/reminders', 'reminders', 'createReminders'],
    ['modules/proactive', 'proactive', 'createProactive'],
    ['modules/broadcast', 'broadcast', 'createBroadcast']
  ];
  // 主动链（sb1 的 proactive）除了 `dataDir/cfg` 还要 `chats`：候选筛选要"哪些会话冷场/有没有未读"。
  // 来源必须是**装配层已建好的那一个 ChatStore 实例**（不许它另建：两套写入者）。
  // 真实字段已核：`getChatMeta()` 回 `{ chatKey, total, unread, lastTs, lastText }` —— 与 proactive 的假设一致。
  const chatsAdapter = chatStoreForModules
    ? { listChats: () => chatStoreForModules.listChats(), getChatMeta: (chatKey) => chatStoreForModules.getChatMeta(chatKey) }
    : null;
  for (const [id, name, factoryName] of SELF_DRIVEN) {
    const mod = loaded.get(id);
    if (!mod) continue;
    if (typeof mod[factoryName] === 'function') {
      try {
        // ★ 广播的 `mode:'llm'` 分支必须靠**注入的** `genCopy`（qwen2 抓到的最大坑）：
        //   legacy 合成路径（配置里没填 `broadcastSchedules.items` 的老用户）**恒为 llm**
        //   ⇒ 不注入 = 覆盖上线后"到点整条静默跳过"，用户只会觉得"疯狂星期四没了"。
        //   文案生成走 M4 的 chatCompletion（广播模块自己不许 import 兄弟模块）；
        //   M4 返回形状 `{ message: choice.message ?? {}, ... }`（见 modules/llm/llm.js:653-656）。
        const extras = {};
        if (name === 'proactive' && chatsAdapter) extras.chats = chatsAdapter;
        if (name === 'proactive' && !chatsAdapter) {
          log?.('[apps/server] ⚠ proactive 没拿到 chats（ChatStore 不可用）⇒ 冷场候选筛不出来，这一路会静默不工作');
        }
        if (name === 'broadcast'
          && typeof mod.buildLlmCopyMessages === 'function'
          && typeof modulesObj.llm?.chatCompletion === 'function') {
          extras.genCopy = async ({ what }) => {
            // ★ 2026-10-11 sp4 修（隔离验证抓到）：buildLlmCopyMessages 返回的是
            //   **{ messages, temperature } 整套入参**，原来写成 `{ messages: <整个对象> }`
            //   ⇒ 发给模型的 messages 是个对象不是数组 ⇒ 真 provider 直接 400、假 provider
            //   返回空 content ⇒ 文案恒空、广播每分钟只打一句"文案过短/为空跳过"（静默不发）。
            //   正确做法：把整套 spec 原样透传给 chatCompletion（它本来就收 temperature）。
            const response = await modulesObj.llm.chatCompletion(mod.buildLlmCopyMessages(what));
            return mod.normalizeCopyText(response?.message?.content);
          };
        } else if (name === 'broadcast') {
          log?.('[apps/server] ⚠ broadcast 没拿到 genCopy（M4 chatCompletion 缺失）⇒ mode:llm 的计划会被整条跳过');
        }
        // ★ 2026-10-05 sb1 的独立复核抓到一处**静默硬失败**（我埋的）：这里原来传的是
        //   `cfg: modulesObj.configStore`（**模块命名空间**：33 个导出、0 个配置字段）
        //   ⇒ proactive 读 `cfg.proactive.enabled` 恒 undefined ⇒ 两个总闸恒 false ⇒
        //   **主动链 100% 不工作、而且它的 faults 是空数组（零告警）**。
        //   传法改成"**每次取一份新的平铺配置 + 一个 get() 兜底**"的函数：
        //     · proactive 读平铺字段（`cfg.proactive.*` / `cfg.allow.*` / `cfg.maxConcurrentRuns`）；
        //     · broadcast 用 `cfg.get('broadcastSchedules')` 重建（它的 readConfig 支持函数形状）；
        //     · reminders 不读 cfg，不受影响。
        //   用**函数**而不是快照：配置运行期会变，模块每次 tick 应拿到最新值。
        const cfgForModules = () => {
          const store = modulesObj.configStore;
          const flat = typeof store?.getConfig === 'function' ? (store.getConfig() ?? {}) : {};
          const merged = { ...flat };
          merged.get = (keyPath, fallback) => (typeof store?.get === 'function' ? store.get(keyPath, fallback) : fallback);
          return merged;
        };
        modulesObj[name] = mod[factoryName]({ dataDir, log, cfg: cfgForModules, ...extras });
        log?.(`[apps/server] 已装配主动性模块 ${name}（${factoryName}${extras.genCopy ? ' + genCopy' : ''}）`);
      } catch (error) {
        // 装配失败**不许静默**：喊出来，但这三个不阻塞主链（提醒/广播哑掉 ≠ 不能回消息）
        log?.(`[apps/server] ⚠ 主动性模块 ${name} 装配失败（这一路将不工作）：${error?.message ?? error}`);
      }
    } else {
      // 单例式模块（直接导出 onTick）也接受 —— 契约只管挂点形状，不管工厂
      modulesObj[name] = mod;
    }
  }

  // M7 状态生命周期由 emotion 模块持有；assembly 只接到运行时门面。
  const emotionMod = loaded.get('modules/emotion');
  let emotionOwner = null;
  const personaTwo = typeof emotionMod?.createPersonaTwoController === 'function'
    ? emotionMod.createPersonaTwoController({
      configStore: modulesObj.configStore,
      getPlatform: () => modulesObj.platform ?? null,
      getChatStore: () => modulesObj.memory?.store ?? null,
      getEmotionState: () => emotionOwner?.stateOf?.() ?? null,
      resolveAvatarArgs: (target) => {
        const absolute = path.isAbsolute(target) ? target : path.resolve(REPO_ROOT, target);
        if (!fs.existsSync(absolute)) throw new Error(`avatar file does not exist: ${absolute}`);
        const base64 = `base64://${fs.readFileSync(absolute).toString('base64')}`;
        return [
          { action: 'set_qq_avatar', file: pathToFileURL(absolute).href },
          { action: 'set_qq_avatar', file: absolute },
          { action: 'set_qq_avatar', file: base64 },
          { action: '_set_qq_avatar', file: base64 }
        ];
      },
      log: (message) => log?.(message)
    }) : null;
  if (typeof emotionMod?.createStateOwner === 'function' && typeof emotionMod?.relationOf === 'function') {
    const owner = emotionMod.createStateOwner({ dataDir, log: (m) => log?.(m), configStore: createEmotionConfigStore(modulesObj.configStore) });
    emotionOwner = owner;
    modulesObj.emotion = Object.freeze({
      ...emotionMod,
      ...(personaTwo || {}),
      // M7 自评表的随机第三维由装配注入；缺少此口的旧替身仍不抽取。
      moodRandomSource: () => Math.random(),
      relationOf: owner.relationOf,
      applyEvent: owner.applyEvent,
      snapshot: owner.snapshot,
      replaceState: owner.manageEdit,
      stateOf: owner.stateOf,
      project: owner.project,
      flush: owner.flush,
      persistence: owner.persistence
    });
  }
  return modulesObj;
}

/**
 * ★ 0.4 扩展契约的宿主发送出口（老树 `src/app.js:632-635` 那个 SendQueue 的角色）。
 *
 * 两处消费者：① `setExtensionSender(...)` 给插件的 `api.sender`（老树 app.js:673-674）；
 *            ② `modulesObj.sender` ⇒ 工具 ctx 的 `ctx.sender`（老树 orchestrator.js:3175）。
 *
 * 为什么不直接把 OneBot 的 SendQueue 递进去：新树发送唯一出口是 `act.send`
 * （T-HYGIENE-FUNNEL：四条出站路径全经它 —— 卫生门/预算/幂等/回执形状）。
 * 插件自己碰协议端 = 第二条发送路径 ⇒ 这里只做「老签名 → act.send」的翻译层，
 * 加上回执形状还原，**不自己发**。
 *
 * 覆盖插件真在用的三个方法（grep skills/ + plugins/ 实测的调用点）：
 *   sendTextBatch / sendSegments / sendImage —— 返回老 SendQueue 的 `{sent,failed,blocked}`
 *   形状（mini-games 的 recoverBlockedSegments、schedule 的兜底路径只认这个形状）。
 *
 * @param {{getModules: () => object, configStore: object, log?: Function}} deps
 *   getModules **惰性求值**：活 platform 要等 start() 经 setPlatform 注入，创建本对象时还没有。
 */
function createExtensionSender({ getModules, configStore, log = () => {} }) {
  const cfg = {
    get: (key, fallback) => (typeof configStore?.get === 'function' ? configStore.get(key, fallback) : fallback),
    effective: (key, scope) => (typeof configStore?.effective === 'function' ? configStore.effective(key, scope) : undefined),
    sourceOf: (key) => (typeof configStore?.sourceOf === 'function' ? configStore.sourceOf(key) : 'default')
  };
  let seq = 0;
  // 每次调用独立键：老 SendQueue 对相同文本也各发各的；共键会让 act.send 的幂等表把第二条
  // 当成第一条的回执（静默吞一条真消息）。代价是重试会重发（fail-open、看得见）——两害相权取其轻。
  const nextKey = (chatKey) => { seq += 1; return `ext-send:${chatKey}:${Date.now().toString(36)}:${seq}`; };
  const indexOfRow = (row) => Math.max(0, (Number(row?.index) || 1) - 1);
  const outboundAllowDecision = (chatKey) => {
    const match = /^(group|private):([^:\s]+)$/.exec(String(chatKey ?? ''));
    if (!match) return { allow: false, reason: 'invalid-chat-key', kind: '', id: '' };
    const [, kind, id] = match;
    const scope = { chatKey: String(chatKey), kind };
    const readFailures = new Set();
    const read = (keyPath) => {
      let effectiveThrew = false;
      try {
        const resolved = configStore?.effective?.(keyPath, scope);
        if (resolved && typeof resolved === 'object' && Object.hasOwn(resolved, 'value')) {
          if (resolved.found !== false) return resolved.value;
        } else if (resolved !== undefined && resolved !== null) return resolved;
      } catch { effectiveThrew = true; }
      try {
        const value = configStore?.get?.(keyPath, undefined);
        if (value !== undefined && value !== null) return value;
        if (!effectiveThrew) return undefined;
      } catch {
        if (effectiveThrew) readFailures.add(keyPath);
        return undefined;
      }
      if (effectiveThrew) readFailures.add(keyPath);
      return undefined;
    };
    const allowAllWhenEmpty = read('allowAllWhenEmpty');
    const allowed = allowGate(kind, id, read);
    if (readFailures.size || typeof allowAllWhenEmpty !== 'boolean') {
      return { allow: false, reason: 'allow-config-unreadable', kind, id };
    }
    return { allow: allowed, reason: allowed ? '' : 'not-allowlisted', kind, id };
  };

  async function sendOnce(chatKey, payload, options = {}) {
    const modules = typeof getModules === 'function' ? getModules() : null;
    const act = modules?.act;
    const platform = modules?.platform;
    if (typeof act?.send !== 'function') throw new Error('扩展发送：act.send 不存在（M10 未装配？）');
    if (!platform || typeof platform.sendTextBatch !== 'function') {
      throw new Error('扩展发送：活 platform 未注入（OneBot 未起？）—— 不糊假发送');
    }
    const key = String(chatKey || '');
    const allow = outboundAllowDecision(key);
    if (!allow.allow) {
      const reason = `${allow.reason}${allow.kind ? `:${allow.kind}` : ''}`;
      log(`[extension-sender] 发送被白名单拦截 target=${key || '(empty)'} reason=${reason}`);
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const blockedMessages = messages.length ? messages : [''];
      return {
        sent: [], failed: [],
        blocked: blockedMessages.map((text, index) => ({ index, text: String(text ?? ''), reason, atUserId: null }))
      };
    }
    const receipt = await act.send({
      chatKey: key,
      kind: key.startsWith('private:') ? 'private' : 'group',
      messages: Array.isArray(payload.messages) ? payload.messages : [],
      ...(Array.isArray(payload.media) && payload.media.length ? { media: payload.media } : {}),
      ...(payload.atUserId ? { atUserId: payload.atUserId } : {}),
      ...(payload.replyToMessageId ? { replyToMessageId: payload.replyToMessageId } : {}),
      cfg,
      idempotencyKey: String(options.idempotencyKey || '') || nextKey(key),
      signal: options.signal,
      deadline: options.deadline,
      action: 'extension-send'
    }, platform);
    const texts = Array.isArray(receipt?.sentTextMessages) && receipt.sentTextMessages.length
      ? receipt.sentTextMessages : (Array.isArray(payload.messages) ? payload.messages : []);
    const dropped = Array.isArray(receipt?.hygiene?.dropped) ? receipt.hygiene.dropped : [];
    if (receipt?.ok === true) {
      const messageId = receipt.platformId ?? null;
      return {
        sent: texts.map((text, index) => ({
          text: String(text),
          messageId: index === 0 ? messageId : null,
          at: new Date(receipt.at ?? Date.now()).toLocaleTimeString('zh-CN', { hour12: false })
        })),
        failed: [],
        blocked: [],
        ...(Array.isArray(payload.media) && payload.media.length ? { message_id: messageId } : {})
      };
    }
    // 被守卫明确拦下的段 ⇒ 老形状的 blocked（调用方可按退避重试）。
    const blocked = dropped.map((row) => ({
      index: indexOfRow(row),
      text: String(texts[indexOfRow(row)] ?? ''),
      reason: String(row?.reason ?? 'dropped'),
      atUserId: null
    }));
    if (blocked.length && receipt?.state !== 'unknown' && !receipt?.platformId
      && !(Number(receipt?.coverage?.receiptCount) > 0)) {
      return { sent: [], failed: [], blocked };
    }
    // 其它失败（抛错/结果未知）：一律当失败抛，让调用方按 uncertain 记 —— 绝不假装发出去。
    const error = String(receipt?.error ?? '发送失败');
    log(`[extension-sender] 发送失败 chatKey=${key}：${error}`);
    throw Object.assign(new Error(error), { state: receipt?.state || 'unknown', receipt });
  }

  return {
    async sendTextBatch(chatKey, messages, options = {}) {
      const list = (Array.isArray(messages) ? messages : [messages])
        .map((item) => String(item ?? '')).filter((item) => item.trim());
      if (!list.length) throw new Error('消息内容为空');
      return sendOnce(chatKey, {
        messages: list,
        ...(options.atUserId ? { atUserId: String(options.atUserId) } : {}),
        ...(options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {})
      }, options);
    },
    async sendSegments(chatKey, segments, options = {}) {
      // OneBot 段 → act media 项。不支持的段类型**如实抛**，不猜、不糊。
      const media = [];
      let atUserId = null;
      for (const seg of (Array.isArray(segments) ? segments : [])) {
        const type = String(seg?.type ?? '');
        const data = seg?.data ?? {};
        if (type === 'text') {
          const text = String(data.text ?? '');
          if (text.trim()) media.push({ type: 'text', text });
        } else if (type === 'image') {
          const file = String(data.file ?? data.url ?? '').trim();
          if (!file) throw new Error('扩展发送：image 段没有 file/url');
          media.push({ type: 'image', file });
        } else if (type === 'at') {
          atUserId = String(data.qq ?? '').trim() || null;
        } else {
          throw new Error(`扩展发送：不支持的段类型 ${type || '(空)'}（act.send 只承 text/image/at）`);
        }
      }
      if (!media.length && !atUserId) throw new Error('发送请求没有有效段');
      return sendOnce(chatKey, {
        messages: [],
        media,
        atUserId,
        ...(options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {})
      }, options);
    },
    async sendImage(chatKey, payload = {}, options = {}) {
      const file = String(payload?.file ?? payload?.dataUrl ?? payload?.url ?? '').trim();
      if (!file) throw new Error('扩展发送：sendImage 需要 file / dataUrl / url');
      const note = String(payload?.note ?? '').trim();
      if (note) log(`[extension-sender] ${chatKey} ${note}`);
      return sendOnce(chatKey, {
        messages: [],
        media: [{ type: 'image', file }],
        ...(options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {})
      }, options);
    }
  };
}

/**
 * 装配：加载配置 + 初始化模块 + 注入依赖 + 注册 bus。
 * @param {object} opts
 * @param {string} opts.dataDir - **必须显式给**（fail-closed）
 * @param {object} [opts.log] - 日志函数
 * @returns {Promise<object>} 装配好的运行时对象
 */
export async function assemble({ dataDir, log = console.log, allowProductionData = false, extensionRootsOverride = null } = {}) {
  // fail-closed：dataDir 必须显式注入
  const resolvedDataDir = resolveDataDir(dataDir, { allowProductionData });
  const defaultExtensionRoots = extensionRoots();
  const resolvedExtensionRoots = {
    skills: typeof extensionRootsOverride?.skills === 'string' && extensionRootsOverride.skills.trim()
      ? path.resolve(extensionRootsOverride.skills) : defaultExtensionRoots.skills,
    plugins: typeof extensionRootsOverride?.plugins === 'string' && extensionRootsOverride.plugins.trim()
      ? path.resolve(extensionRootsOverride.plugins) : defaultExtensionRoots.plugins
  };

  const { loaded, missing } = await loadModules();

  // 缺失模块 ⇒ 抛错（点名模块名 + specifier），不许静默降级
  if (missing.length > 0) {
    const lines = missing.map((m) => `  - ${m.id} (${m.specifier}): ${m.reason}`);
    throw new Error(
      `[apps/server] 装配失败：${missing.length} 个模块缺失或不完整：\n${lines.join('\n')}\n`
      + '  缺依赖时不许静默降级。请先落地缺失模块再启动。'
    );
  }

  // 初始化 config-store
  const configStore = loaded.get('core/config-store');
  configStore.load({ dataDir: resolvedDataDir });
  let vectorRuntime = null;
  let vectorSemanticRecall = null;
  let vectorStartPromise = null;
  let vectorAppliedConfig = null;
  let vectorStatus = { state: 'not-started', mode: 'keyword', reason: '' };
  const vectorRecallQueries = new Map();
  // ★ 2026-10-17（发行版：向量默认开 + 无 GPU 也能跑）——
  //   · `runtime`：'auto'（默认，按 executablePath/存在的运行环境自动选档）/ 'cpu' / 'cuda'。
  //     它决定**用哪支 profile**：CPU 支 `BGE_ZH_LOCAL_PROFILE`（build 10685）、
  //     CUDA 支 `BGE_ZH_LOCAL_CUDA_PROFILE`（build 11068）。profile 的 runtime/build 是
  //     与真机 `--version` 对账的输入，选错必然 `version-incompatible`（不是静默降级）。
  //   · `port` 被占不再直接失败：start 前在 [port, port+20] 里依次找空闲口（见下方注释）。
  const readVectorConfig = () => ({
    enabled: configStore.get('vector.enabled', false) === true,
    modelPath: String(configStore.get('vector.modelPath', '') ?? '').trim(),
    executablePath: String(configStore.get('vector.executablePath', '') ?? '').trim(),
    runtime: String(configStore.get('vector.runtime', 'auto') ?? 'auto').trim().toLowerCase(),
    logPath: String(configStore.get('vector.logPath', '') ?? '').trim(),
    port: Number(configStore.get('vector.port'))
  });
  const vectorConfigSignature = (value) => JSON.stringify(value);
  const getVectorEmbeddingStatus = () => {
    const current = readVectorConfig();
    const applied = vectorAppliedConfig;
    // ★ 2026-10-16（C 收口）：逐字段说明"改了什么还没应用"，UI 不必自己 diff。
    const changedFields = !applied ? [] : ['enabled', 'modelPath', 'executablePath', 'runtime', 'logPath', 'port']
      .filter((key) => current[key] !== applied[key]);
    // 索引层的真实状态（进程 ready ≠ 索引 ready ≠ 本轮真的走了 semantic）。
    let index = null;
    try {
      const st = vectorSemanticRecall?.status?.();
      if (st !== undefined && st !== null) index = typeof st === 'string' ? { status: st } : { ...st };
    } catch (error) {
      index = { status: 'error', reason: String(error?.message ?? error).slice(0, 160) };
    }
    return {
      ...vectorStatus,
      configuredEnabled: current.enabled,
      appliedEnabled: applied?.enabled === true,
      restartRequired: Boolean(applied && vectorConfigSignature(current) !== vectorConfigSignature(applied)),
      changedFields,
      port: Number.isInteger(current.port) ? current.port : null,
      index,
      // 进程内最近几次"要不要召回"的本地查询：只记时间/长度与当时 semantic 是否已就绪（**不含聊天正文**）。
      lastRecallQueries: [...vectorRecallQueries.values()].slice(-20).map((q) => ({
        at: Number(q.at) || null, live: q.live === true, queryChars: String(q.query ?? '').length
      }))
    };
  };
  /**
   * ★ 2026-10-16（C：向量就绪要真的接上已有 coordinator）：semantic 只在 createMemoryCoordinator
   * 那一刻被读入 ⇒ 运行时晚于账号绑定就绪（常态竞态）时，旧 coordinator 永远拿 null。
   * 可用性**变化**后重建并重新发布（消费方每次现取，见 orchestrator/index.js:365 与 ctx.memoryCoordinator）。
   */
  const rebindVectorCoordinator = (hadSemanticBefore) => {
    const hasSemanticNow = vectorSemanticRecall !== null;
    if (hadSemanticBefore === hasSemanticNow) return false;
    try { return modulesObj.__rebindMemoryCoordinatorForVector?.() === true; }
    catch (error) { log(`[apps/server] 向量就绪后重建 coordinator 失败：${error?.message ?? error}`); return false; }
  };
  // 缺省卡在扩展启动前成为显式配置，避免其他配置写入者把另一份默认卡写进盘上，
  // 导致本进程用缺省卡、重启后却用不同正文。已有配置（包括空卡）保持原值。
  if (configStore.sourceOf('persona.roleText') === 'default') {
    configStore.setAndSave('persona.roleText', configStore.get('persona.roleText'), { log });
  }

  // B1 预算服务与配置目录同源。dayTokenMax 只作软阈值，硬额度必须由用户单独设置。
  const budgetConfig = configStore.get('api.budget', {}) || {};
  const costGuardConfig = configStore.get('api.costGuard', {}) || {};
  const configuredShares = budgetConfig.instanceShares;
  const initialShares = configuredShares && typeof configuredShares === 'object' && !Array.isArray(configuredShares)
    ? configuredShares : {};
  const budgetService = createBudgetService({
    dataDir: resolvedDataDir,
    hardLimitTokens: budgetConfig.hardLimitTokens ?? null,
    softLimitTokens: costGuardConfig.dayTokenMax ?? 30_000_000,
    instanceShares: initialShares
  });
  await budgetService.ready;

  // ★ 2026-10-17（用户最终口径）：人设切换只隔离**短期输入**，长期记忆完全共享。
  //   这里创建的都是"切换分界"这一件小事：真实换卡/切人格才推进 epoch+changedAt；
  //   同卡重复应用、改 API/主题、刷新都不算。分界持久化在 `<dataDir>/persona-boundary.json`，
  //   重启继承（不每重启又切一次）。compose 用它过滤历史/短期块；长期召回不经过它。
  //   ⚠ 挂到 modulesObj 的赋值放在 buildRuntimeModules 调用之后（见下方 personaBoundary 赋值）。
  //   ★ 2026-10-17 收口：签名按**当前有效角色卡**算（第二人格在位 = persona2.roleText），
  //     后台编辑未生效那张卡不假切；`deferSignature` 等 emotion 实例就绪后再做首次判定，
  //     避免用配置兜底签名把 v1 旧文件误判成一次切换（迁移语义见 persona-context.js 头注释）。
  let runtimeModulesForPersonaBoundary = null;
  const personaBoundary = createPersonaBoundary({
    dataDir: resolvedDataDir,
    configStore,
    deferSignature: true,
    getEffectivePersona: () => {
      try {
        const emotion = runtimeModulesForPersonaBoundary?.emotion;
        if (typeof emotion?.effectivePersona !== 'function') return null;
        const effective = emotion.effectivePersona();
        if (!effective || typeof effective !== 'object' || Array.isArray(effective)) return null;
        return { roleText: effective.roleText, personaTwo: effective.personaTwo === true };
      } catch { return null; }
    }
  });

  // ★ 2026-10-05 事故（S2 探针写脏生产 data/）的系统性防线：
  //   `core/config-store` 的 `DATA_DIR` 是**导入期**从 `QQ_AGENT_DATA_DIR` 读的常量；
  //   而 M11/M6 等模块内部按 `DATA_DIR` 落盘 ⇒ **只要 env 没在 import 之前设好**，
  //   "ctx.dataDir=临时目录" 只覆盖 API 层，**模块层照样写生产目录**。
  //   这里做一次一致性检查：不一致就**大声喊**（不抛 —— 直接调 assemble() 的自测/探针属合法用法，
  //   但必须让他们在日志里立刻看到；真正的 fail-closed 在 createServer：它在 import 之前就设好 env）。
  const importTimeDataDir = String(configStore.DATA_DIR ?? '');
  const dirMismatch = importTimeDataDir && path.resolve(importTimeDataDir) !== path.resolve(resolvedDataDir);
  if (dirMismatch) {
    log('[apps/server] ⚠⚠ 数据目录不一致：模块导入期的 DATA_DIR=' + importTimeDataDir
      + ' 与本次装配的 dataDir=' + resolvedDataDir + ' 不同 ⇒ '
      + '**模块层（M11/M6 等按 DATA_DIR 落盘的代码）会写到前者**。'
      + '调用方必须在 import 任何模块之前设好 QQ_AGENT_DATA_DIR（createServer 已经这么做）。');
  }

  // 初始化 memory 的 dataDir
  const memory = loaded.get('modules/memory');
  if (typeof memory.setDataDir === 'function') {
    memory.setDataDir(resolvedDataDir);
  }
  if (typeof memory.configure === 'function') {
    memory.configure({
      dataDir: resolvedDataDir,
      isPersonaTwo: () => configStore.get('persona2.enabled') === true,
      memoryHygiene: configStore.get('persona2.memoryHygiene', {}),
      // 配置读取保持为 getter：下次记忆读取时，已保存的设置即可生效，无需重启。
      // 数字缺省与 core/config-store/defaults.js 一致；具体类型与正数校验由 memory/working-window.js 负责。
      working: () => ({
        crossTurnWorking: configStore.get('api.architecture.crossTurnWorking', false),
        workingTtlMin: configStore.get('api.architecture.workingTtlMin', 90),
        workingDecayMin: configStore.get('api.architecture.workingDecayMin', 30)
      })
    });
  }

  // 注册 bus 事件（§3.7 冻结事件名）
  const obs = loaded.get('core/observability');

  // 配置事件只在持久化出口成功返回后发。subscribeConfigChange 也会被只改内存的 set/updateConfig
  // 触发，因此不能用它冒充“保存成功”；HTTP ctx 与模块命名空间共用这个窄代理。
  const configSaveMethods = new Set(['saveConfig', 'setAndSave', 'updateConfigAndSave']);
  const configStoreWithSaveEvents = new Proxy(configStore, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (!configSaveMethods.has(property) || typeof value !== 'function') return value;
      return (...args) => {
        const result = Reflect.apply(value, target, args);
        try { obs.emit('config:changed', {}); }
        catch (error) {
          try { log(`[apps/server] config:changed 发射失败（配置已保存）：${error?.message ?? error}`); }
          catch { /* 日志失败不能把已保存的配置伪报成失败 */ }
        }
        return result;
      };
    }
  });
  const emitPluginsReloaded = () => {
    try { obs.emit('plugins-reloaded', {}); }
    catch (error) {
      try { log(`[apps/server] plugins-reloaded 发射失败（扩展重载已完成）：${error?.message ?? error}`); }
      catch { /* 日志失败不能反噬已完成的重载 */ }
    }
  };
  // ══ T-OBS-PERSIST：把观测账本接上落盘 ══
  // 背景（qwen2 在 T-BUS-LOOP 复核里报的 F-1，指挥位已复核）：**真装配从来没有调用过
  // `obs.configure({dataDir})`** —— 全文只有 memory/jev/orchestrator 三处 configure。
  // 而 observability 的 sink 没有 dir 时只进内存（core/observability/sink.js:92）、
  // `read()` 退化成 `peek()` ⇒ events/spans/usage/jev 台账只活在 200 条内存环里、**一行都不落盘**。
  // 后果：① 旧树 `data/jev-observations/` 有 6 天真实日档（jev-2026-10-04.jsonl 271 KB，
  //   旧树 src/jev-observer.js:6 写的），新树**重启即空** —— 这是回归，不是"还没接"；
  //   ② 下面那个"缺口⑩ 把 M9 的 JEV 台账接上"（`jev.configure({ledger})` → `obs.ledger('jev',row)`）
  //   在盘上**其实没有产出**；③ `/api/usage/*` 读 `obs.recent({name:'usage'})` ⇒ 重启归零。
  //
  // 三条设计决定：
  // 1. **dataDir 同源**：直接用上面 memory 用的同一个 `resolvedDataDir`（`:359` 的解析结果），
  //    不另解析一套（票面要求，也免掉两套解析漂移）。
  // 2. ★ **必须镜像 `allowRealData: allowProductionData`** —— 这不是可选项：
  //    · observability 自己还有**一道独立于服务层**的生产目录闸（core/observability/index.js:82-89，
  //      任何路径段叫 `data`/`data-2` 就拒写，除非 `allowRealData`）；
  //    · 而桌面壳 `apps/desktop/main.js:527-531` 是生产启动器，**显式传 `allowProductionData: true`**
  //      并用 `resolveDataDir()`（默认就指向仓库 data/）；
  //    · `apps/server/selftest-asm.selftest.mjs:206-212` 有一条**现成的绿断言**："data/ + allowProductionData:true 不抛"。
  //    ⇒ 不镜像的话：桌面壳启动直接抛（应用起不来），且那条断言变红。
  // 3. **位置必须在下面注册 bus 订阅之前**：`obs.configure` 会**重建 sink**（index.js:98），
  //    configure 之前记下的行只存在于旧内存环，重建时被丢弃 ⇒ 越早接越少丢行。
  // 4. **失败不许冒到主链**：接不上盘也照样把服务器拉起来（观测退化成内存模式），
  //    但日志要说得足够响 —— 静默退化成"重启即空"正是本票要消灭的东西。
  if (typeof obs?.configure === 'function') {
    try {
      obs.configure({ dataDir: resolvedDataDir, allowRealData: allowProductionData === true });
      log(`[apps/server] 观测账本已接上落盘（obsDir=${obs.obsConfig?.().obsDir ?? '(未报告)'}，`
        + '重启后仍可读；retention/capacity 裁剪与 200 条内存环语义不变）');
    } catch (e) {
      log(`[apps/server] ⚠ 观测账本落盘配置失败 ⇒ 退化为**内存模式**（events/spans/usage/jev 只剩`
        + `200 条内存环、**重启即丢**）：${e?.message ?? e}`);
    }
  }

  const busEvents = [
    'evidence:built', 'context:retrieved', 'plan:decided',
    'verdict:issued', 'receipt:confirmed', 'observation:committed',
    'config:changed', 'plugins-reloaded', 'extension:loaded', 'extension:reloaded'
  ];
  for (const kind of busEvents) {
    obs.on(kind, (payload) => {
      // ★ T-BUS-LOOP：`{ echo: false }` = **只记录、不回灌**。
      //   这一行原先是 `obs.event(kind, payload)`，而 `core/observability/index.js` 的 event()
      //   会把刚建好的行**再 emit 回同一条 bus** ⇒ 命中下面这个刚注册的订阅者 ⇒ 递归 ⇒
      //   一次 `bus.emit` 扇出 1763 行账本 + 1763 层递归（实测：.tmp-dispatch/busloop-baseline.mjs），
      //   爆栈还被 `core/observability/bus.js:44-49` 的 per-subscriber catch 静默吞掉。
      //   经 sse-bridge 还会变成同量级的 SSE 帧灌向 UI。
      //   注意：**不是**改成"干脆不订阅" —— 账本必须照样有 event 行（票面明令：用消失换安静不行）。
      try { obs.event(kind, payload, { echo: false }); } catch { /* 观测不许反噬 */ }
    });
  }

  // ★ 缺口⑩的一半：把 M9 的观测账本接上（`ledger('jev', row)`）。
  //   M9 自己**不 import core/observability**（硬要求 6：账本是注入的），而装配层一直没人注入
  //   ⇒ `isLedgerBound()` 恒 false，Jev 每次判定的 label / p / margin / channel 全都没落盘，
  //   "它为什么不接这句话"在盘上查不到证据（UI 的 Jev 观测页也没有数据源）。
  //   写入失败**不许冒到主链**（M9 内部已有 try/catch，这里再加一道保险）。
  const jev = loaded.get('modules/jev');
  if (jev && typeof jev.configure === 'function') {
    try {
      jev.configure({ ledger: (row) => { try { obs.ledger('jev', row); } catch { /* 观测不许反噬 */ } } });
      log('[apps/server] M9 观测账本已接上（ledger(\'jev\')）');
    } catch (error) {
      log(`[apps/server] M9 观测账本注入失败（Jev 台账会缺）：${error?.message ?? error}`);
    }
  }

  // JEV 仅使用与主聊天相同的云模型；判定适配器在下方 refreshJudgeRuntime 接线。
  // 初始化扩展：loadPlugins({ roots })（必须显式传 roots，plugin-loader 的 APP_ROOT 权重问题）
  const extensions = loaded.get('modules/extensions');
  // ★ 0.4 启动顺序（老树 `src/app.js:673-675`）：**先 setExtensionSender，再 initExtensions**。
  //   为什么必须是这个顺序：`plugin-loader.js:607` 的 `api.sender = extensionSender` 是 api 对象
  //   构造时（loadSkillDir）的**快照** ⇒ 先 load 后注入 = 本轮所有插件的 api.sender 恒 null，
  //   要等下一次热重载才活。老树就是 sender 先、load 后，这里照抄。
  //   getModules 惰性求值：活 platform 要等 start() 经 setPlatform 注入，现在还没有。
  const extensionSender = typeof extensions?.setExtensionSender === 'function'
    ? createExtensionSender({ getModules: () => modulesObj, configStore, log })
    : null;
  if (extensions?.loadPlugins) {
    try {
      const roots = resolvedExtensionRoots;
      await extensions.loadPlugins({ log, roots });
      log(`[apps/server] 扩展已加载（roots: skills=${roots.skills}, plugins=${roots.plugins}）`);

      if (extensionSender) {
        extensions.setExtensionSender(extensionSender);
        log('[apps/server] 已注入扩展发送出口（api.sender ← act.send 唯一出口的适配器）');
      }
      // ★ initExtensions = loadPlugins + 逐个 activate 已启用技能（skill-bridge.js:38-59）。
      //   只调 loadPlugins 时 `loadedOnce` 闸不开 ⇒ 5 个钩子空转、`api.on` 订阅与
      //   `api.schedule` 定时全死（extensions/selftest ⑥ 的两条 WARNING 点名的就是这里）。
      //   激活 ctx 照 api/shell.js:105-107 的现成口径：{cfg, log}。
      if (typeof extensions.initExtensions === 'function') {
        await extensions.initExtensions({ log, context: () => ({ cfg: configStoreWithSaveEvents, log }), roots });
        log('[apps/server] 扩展已激活（initExtensions：钩子/定时/api.sender 就位）');
      }

      // ── ★ A60：接 `extensions.hotReload`（此前是**死键**：能落盘，没人读）────────
      // 事实：watcher 早就写好了（`modules/extensions/plugin-loader.js:1047 watchPlugins`，
      //   带防抖 + 重入保护 + `close()`），`skill-bridge.js:61 startExtensionWatch` 也导出了，
      //   但**全树没有任何一处调用它** —— `apps/server/sse-bridge.js:112-116` 早把这条记成缺口。
      //   所以这个键以前改了不起作用：扩展改了必须重启 agent。
      // 老树口径（照抄，`src/app.js:677`）：`if (getConfig().extensions?.hotReload !== false)`
      //   ⇒ **默认开**，只有显式 `false` 才关。（新树默认值同样是 `true`，见 `core/config-store/defaults.js:1031`）
      // 本层比老树多走一步：**配置一改就重新判定**（`subscribeConfigChange`），
      //   所以开关这个键**不必重启**；老树是读单次（改键要重启）。
      // ⚠ 为什么接线放在装配层、而不是 extensions 里加函数：
      //   `plugin-loader.js` / `skill-bridge.js` 受 selftest 的**搬运保真闸门**管
      //   （`modules/extensions/selftest.mjs` 的 FIDELITY 表：只许差 import 路径与注释），
      //   加真实代码会硬失败 —— 与 `modules/llm` 的 MOVED 同一条纪律。所以新逻辑只能落在这层。
      let watch = null;          // { close() } | null（null = 没在监听）
      let watchTried = false;    // 试过但目录不存在 ⇒ 别每次配置变更都重试刷屏
      let notedOff = false;      // 「已停用」只报一次，别每次配置变更都刷屏
      const wantHotReload = () => configStore.get('extensions.hotReload') !== false;
      const syncExtensionWatch = async (reason) => {
        if (typeof extensions?.startExtensionWatch !== 'function') return;
        const want = wantHotReload();
        if (want && !watch && !watchTried) {
          watchTried = true;
          notedOff = false;
          const handle = await extensions.startExtensionWatch({
            log,
            roots,
            // 传**函数**而不是对象：skill-bridge.js:66 在**重载那一刻**才求值，
            // 那时 platform/orchestrator 早就注入好了（老树传的是函数 `extensionContext()`，同一口径）。
            context: () => ({ cfg: configStoreWithSaveEvents, log }),
            // 只在扫描与重新激活均完成后发；传空载荷，UI handler 不读业务字段。
            onReloadComplete: (result) => {
              try {
                log(`[apps/server] 扩展热重载完成（${reason}）：loaded=${result?.loaded?.length ?? 0} failed=${result?.failed?.length ?? 0}`);
              } catch { /* 日志失败不能压住已完成重载的事件 */ }
              emitPluginsReloaded();
            }
          });
          watch = handle ?? null;
          log(handle
            ? `[apps/server] 扩展热重载已启用（extensions.hotReload=${String(want)}）`
            : `[apps/server] 扩展热重载未启动：监听目录不存在（extensions.hotReload=${String(want)}）`);
        } else if (!want && watch) {
          try { watch.close?.(); } catch { /* 关不掉也不能影响主流程 */ }
          watch = null;
          watchTried = false;
          log('[apps/server] 扩展热重载已停用（extensions.hotReload=false）');
        } else if (!want && !watch && !notedOff) {
          // 显式关掉时也要**看得见**，否则"我明明关了/开了却没反应"没法排查
          notedOff = true;
          log('[apps/server] 扩展热重载未启用（extensions.hotReload=false，改扩展需重启 agent）');
        }
      };
      await syncExtensionWatch('启动');
      // 配置一改就重新判定 ⇒ 开关这个键不必重启 agent（老树做不到这一点）
      if (typeof configStore?.subscribeConfigChange === 'function') {
        configStore.subscribeConfigChange(() => { void syncExtensionWatch('配置变更'); });
      }
    } catch (e) {
      log(`[apps/server] 扩展加载失败（忽略，不影响启动）: ${e?.message ?? e}`);
    }
  }

  log(`[apps/server] 装配完成：${loaded.size} 个模块加载成功，dataDir=${resolvedDataDir}`);

  // M15 orchestrator：装配出 runtime（§3.8 createRuntime）
  // 未落地时 orchestrator 为 null，由调用方决定是否继续
  const orchestrator = loaded.get('modules/orchestrator') ?? null;

  // modules 传对象（M15 用 modules.scenario.ingestBatch 等属性访问，不是 Map.get）。
  // ★ 只建一次并在 ctx 上共享：接线层注入的活实例（OneBot platform）必须被 M15 看到。
  const modulesObj = buildRuntimeModules(loaded, {
    dataDir: resolvedDataDir,
    log,
    configStore: configStoreWithSaveEvents,
    getSemanticRecall: () => vectorSemanticRecall,
    getVectorRecallQuery: (chatKey) => vectorRecallQueries.get(String(chatKey ?? ''))?.query ?? ''
  });
  // ★ 2026-10-17（人设分界首个签名判定）：emotion 实例已装配 ⇒ 用**当前有效角色卡**完成首次判定。
  //   放在这里而不是 createPersonaBoundary 里，避免拿配置兜底签名把 v1 旧文件误判成一次切换
  //   （v1→v2 迁移只迁移、不推进 epoch，见 core/persona-context.js 头注释）。
  runtimeModulesForPersonaBoundary = modulesObj;
  try { personaBoundary.initSignature(); }
  catch (error) { log(`[apps/server] 人设分界初始化失败（本实例暂不过滤短期输入）：${error?.message ?? error}`); }
  // 手动热重载走 HTTP 的 initExtensions()，与 watcher 使用同一事件名和空载荷。
  // 启动阶段的首次 initExtensions 已在上面完成，不在这里补发启动事件。
  let extensionsForContext = modulesObj.extensions;
  if (typeof modulesObj.extensions?.initExtensions === 'function') {
    const extensionsModule = modulesObj.extensions;
    extensionsForContext = new Proxy(extensionsModule, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== 'initExtensions' || typeof value !== 'function') return value;
        return async (...args) => {
          const result = await Reflect.apply(value, target, args);
          emitPluginsReloaded();
          return result;
        };
      }
    });
    modulesObj.extensions = extensionsForContext;
  }
  // HTTP shell routes resolve extensions from the returned module Map; give them the same wrapped
  // public facade as modulesObj so manual /api/hot-reload also emits after successful activation.
  const modulesForContext = new Map(loaded);
  if (extensionsForContext) modulesForContext.set('modules/extensions', extensionsForContext);
  // 不覆盖 modulesObj.budget：该字段用于动作执行的单轮限制。
  modulesObj.llmBudgetService = budgetService;
  if (typeof modulesObj.plan?.createTopicRegistry === 'function') {
    modulesObj.topicRegistry = modulesObj.plan.createTopicRegistry({
      idleMs: modulesObj.plan.DEFAULT_TOPIC_IDLE_MS
    });
  }

  const llm = loaded.get('modules/llm');
  // ★ 2026-10-16（清理 B/C provider 接线）：把门挂到门面上 —— **不在这里调用任何模型**，只是把
  //   "怎么问（预算/结算/模型解析）"备好；是否真的问由 `apps/server/api/memory.js` 在
  //   "显式 apply + 明确 gate 意图"时决定（默认只读盘点与执行 A 都不带门）。
  //   `selfId` 每次 ask 时才读 ⇒ 换号/晚装配都不影响；`cfg` 用模块门面上的同一个配置访问器。
  // ★ 2026-10-17（人设切换短期分界）：运行时可取用（compose 过滤短期历史；长期记忆不使用它）。
  modulesObj.personaBoundary = personaBoundary;
  modulesObj.memoryCleanupGates = createMemoryCleanupGates({
    llm,
    budgetService,
    cfg: modulesObj.configStore,
    selfId: () => String(modulesObj.platform?.selfId ?? '').trim(),
    log
  });
  const jevModule = loaded.get('modules/jev');
  let judgeAdapterSignature = '';
  let judgeBindingReason = 'model-not-configured';
  const readBudgetConfig = () => {
    const currentBudget = configStore.get('api.budget', {}) || {};
    const currentCostGuard = configStore.get('api.costGuard', {}) || {};
    const shares = currentBudget.instanceShares;
    return {
      hardLimitTokens: currentBudget.hardLimitTokens ?? null,
      softLimitTokens: currentCostGuard.dayTokenMax ?? 30_000_000,
      instanceShares: shares && typeof shares === 'object' && !Array.isArray(shares) ? shares : {}
    };
  };
  /** 判定专用思考三态：'off' 关 / 'on' 显式开 / 'inherit' 跟随全局（false/null/未知都落这里，旧复选框语义不变）。 */
  const judgeThinkingModeOf = (raw) => {
    if (raw === true || raw === 'off') return 'off';
    if (raw === 'on') return 'on';
    return 'inherit';
  };
  const urlHostOf = (value) => {
    try { return new URL(String(value)).host; } catch { return ''; }
  };
  const currentJudgeIdentity = () => {
    const fullConfig = configStore.get() || {};
    const api = fullConfig.api && typeof fullConfig.api === 'object' ? fullConfig.api : {};
    let speakApiKey = '';
    try { speakApiKey = String(llm?.resolveApiKey?.(fullConfig) ?? '').trim(); }
    catch { speakApiKey = ''; }
    const speakBaseUrl = String(api.baseUrl ?? '').trim().replace(/\/+$/, '');
    const speakModel = String(api.model ?? '').trim();
    // ── ★ 2026-10-16（用户令：云判定可与发言分开）──────────────────────────────
    //   判定身份两种模式（契约见 core/config-store/defaults.js 的 localJev.judgeApi 注释）：
    //     · follow（默认）：逐字沿用发言的 provider/baseUrl/model/key —— 旧行为不变；
    //     · independent ：providerId + model，其中 **baseURL 与 Key 都从这一条 providers[] 解析**
    //       （Key 优先条目内未脱敏明文=老配置，否则 dshProviderKeys[providerId]）——
    //       绝不与发言的 apiKey/baseUrl 拼，防止"A 厂 URL + B 厂 key"。
    //   独立模式缺任何一项 ⇒ 绑定理由直接指认缺哪项（见 refreshJudgeRuntime），**不悄悄回落发言厂商**。
    const judgeModeRaw = String(configStore?.get?.('localJev.judgeApi.mode', 'follow') ?? '').trim();
    const judgeProviderId = String(configStore?.get?.('localJev.judgeApi.providerId', '') ?? '').trim();
    const judgeModelInput = String(configStore?.get?.('localJev.judgeApi.model', '') ?? '').trim();
    const providerList = Array.isArray(fullConfig.providers) ? fullConfig.providers : [];
    const judgeProvider = judgeProviderId
      ? (providerList.find((p) => p && String(p.id ?? '') === judgeProviderId) ?? null) : null;
    let judgeProviderKey = '';
    if (judgeProvider) {
      const inline = String(judgeProvider.apiKey ?? '').trim();
      const saved = String(fullConfig.dshProviderKeys?.[judgeProviderId] ?? '').trim();
      judgeProviderKey = inline && inline !== '******' ? inline : saved;
      if (judgeProviderKey === '******') judgeProviderKey = '';
    }
    const judgeProviderBaseUrl = judgeProvider
      ? String(judgeProvider.baseURL ?? judgeProvider.baseUrl ?? '').trim().replace(/\/+$/, '') : '';
    const independent = judgeModeRaw === 'independent';
    const rawJudgeDisableThinking = configStore?.get?.('localJev.judgeDisableThinking', null);
    const judgeThinking = judgeThinkingModeOf(rawJudgeDisableThinking);
    // 输出预算：判定只要一行 JSON；128..4096 之外/非法一律回 384（与 defaults 注释同口径）。
    const rawJudgeMaxTokens = Number(configStore?.get?.('localJev.judgeMaxTokens', 384));
    const judgeMaxTokens = Number.isFinite(rawJudgeMaxTokens) && rawJudgeMaxTokens >= 128
      ? Math.min(4096, Math.floor(rawJudgeMaxTokens)) : 384;
    // 'on' 时必须带一个 >0 的思考预算，否则 llm.js 的 enable 分支根本不发字段（界面说开启、实际没开）。
    const globalThinkingBudget = Number(api.thinkingBudget) > 0 ? Math.floor(Number(api.thinkingBudget)) : null;
    // G1 身份口径：账号标识取机器人 QQ 号；实例标识用配置仓库提供的稳定实例标识，
    // 不把端口或用户可改的昵称当成标识，也不把两种身份混在一起。
    const accountId = String(modulesObj.platform?.selfId ?? '').trim();
    const instanceId = String(configStore.describeInstance?.() ?? '').trim();
    return {
      api, accountId, instanceId,
      apiKey: independent ? judgeProviderKey : speakApiKey,
      baseUrl: independent ? judgeProviderBaseUrl : speakBaseUrl,
      model: independent ? judgeModelInput : speakModel,
      judgeThinking, judgeMaxTokens, globalThinkingBudget,
      judgeSource: independent ? 'independent' : 'follow',
      judgeModeRaw, judgeProviderId,
      judgeProviderFound: judgeProvider !== null,
      judgeProviderHasKey: judgeProviderKey !== '',
      speakProvider: String(api.provider ?? '').trim()
    };
  };
  const refreshJudgeRuntime = () => {
    const identity = currentJudgeIdentity();
    const budgetValues = readBudgetConfig();
    budgetService.configure({
      ...budgetValues,
      accountId: identity.accountId,
      instanceId: identity.instanceId
    });
    // ★ 2026-10-15（拆掉本地/独立云 JEV 模型后补回的唯一断线）；2026-10-19（第五批新语义）：
    //   `localJev.judgeTimeoutMs` 是**云判定**的单次预算（判据链读 `modules/jev/core.js`
    //   的 `timeoutState().configuredMs`）。拆旧模型块时，全树最后两处 `configure({defaultTimeoutMs})`
    //   一起被删了 ⇒ 用户改这个键不再有任何效果（键在 key-ledger.mjs 仍记 live、面板仍在）。
    //   语义（与 `core.js` configure 逐字对齐；**别照 configure 的返回值念**）：
    //     · 合法 = 有限数且在 **1000..120000ms** 区间内 ⇒ 原样生效（**15s 静默硬顶已取消**）；
    //     · 非法值（有限数超区间 / 非数）⇒ 按**明确默认 5000ms** 回退 + 记 rejected{raw, reason}
    //       ⇒ 判据行带 timeoutConfigRejected（"填了 X、为什么没生效、实际按 5000 用"）；
    //     · `undefined`（键不存在）⇒ configure **不动**该字段；null/空串 ⇒ 记"没配过"
    //       （`configuredMs = null`）⇒ 判据回自己的常量 2500ms。configure 返回的 `defaultTimeoutMs`
    //       是**内部字段**（没配过时也会是 2000）⇒ 不许拿它当日志里的"生效超时"，那是假证据。
    //     · 如实记一处副作用：`core.js` 的**旧角色 ask** 路径拿 `state.defaultTimeoutMs` 当兜底，
    //       这次接线后它从 core 的 2000 变成配置里的值（= defaults.js 的键默认值 5000）；
    //       旧角色路径在编排名单里已是退役件，且这正是老树本地接线时同一把键的行为。
    //   放在 refresh 里而不是只写一次：该键**不在** judgeAdapterSignature 里，只有换模型才 configure
    //   会把"改了超时"静默吞掉；每轮刷新写一次只是一个纯赋值，代价可忽略。
    jevModule?.configure?.({
      defaultTimeoutMs: configStore.get('localJev.judgeTimeoutMs'),
      // ★ 2026-10-16（单次 token 收口）：判定输出预算的唯一出处 —— judge.js 用它参与
      //   "输入估计 + 输出预算 ≤ 2000" 的合计守门；这里不传的话 core 保持 384。
      judgeMaxTokens: configStore.get('localJev.judgeMaxTokens'),
      // ★ 2026-10-18（收口 · 合同 #4）：可编辑业务判据 `localJev.judgeMode.prompt` 的注入点 ——
      //   jev 侧已实现 `configure({judgePrompt})` 消费（core.js judgePromptState() → judge.js 渲染；
      //   空串 = 内置默认，结构校验/预算/授权边界不可被自定义文本取消）。这里与超时/输出预算同一处
      //   **每轮现读**：初始装配（下方 refreshJudgeRuntime() 首调）与热加载
      //   （subscribeConfigChange → refreshJudgeRuntime）都生效，不参与 judgeAdapterSignature。
      judgePrompt: configStore.get('localJev.judgeMode.prompt', '')
    });

    const independent = identity.judgeSource === 'independent';
    const urlIsValid = /^https?:\/\//i.test(identity.baseUrl);
    const shares = budgetValues.instanceShares;
    const needsInstanceShare = Object.keys(shares).length > 0;
    const shareAssigned = !needsInstanceShare
      || (identity.instanceId !== '' && Object.prototype.hasOwnProperty.call(shares, identity.instanceId));
    // 绑定理由：独立模式按"缺哪一项"逐项指认（全部齐了才绑；缺一个就**不可用**，绝不回落发言厂商）；
    // follow 模式保持旧口径（model/URL 缺失 ⇒ `model-not-configured`）。
    const bindProblem = !identity.model
      ? (independent ? 'judge-model-not-configured' : 'model-not-configured')
      : (independent && !identity.judgeProviderId) ? 'judge-provider-not-selected'
        : (independent && !identity.judgeProviderFound) ? 'judge-provider-not-found'
          : !urlIsValid ? (independent ? 'judge-provider-url-missing' : 'model-not-configured')
            : (independent && !identity.judgeProviderHasKey) ? 'judge-provider-key-missing'
              : !identity.accountId ? 'account-id-unavailable'
                : !identity.instanceId ? 'instance-id-unavailable'
                  : !shareAssigned ? 'instance-share-not-configured'
                    : typeof llm?.createBudgetedJudgeModel !== 'function' ? 'single-request-adapter-unavailable' : '';
    if (bindProblem !== '') {
      judgeBindingReason = bindProblem;
      if (judgeAdapterSignature !== '' || jevModule?.isJudgeModelBound?.()) {
        jevModule?.configure?.({ judgeModel: null, judgeModelLabel: '' });
        judgeAdapterSignature = '';
      }
    } else {
      const signature = createHash('sha256').update(JSON.stringify({
        source: identity.judgeSource,
        provider: independent ? identity.judgeProviderId : (identity.speakProvider ?? ''),
        baseUrl: identity.baseUrl, model: identity.model,
        credential: identity.apiKey, instanceId: identity.instanceId,
        judgeThinking: identity.judgeThinking, judgeMaxTokens: identity.judgeMaxTokens
      })).digest('hex');
      judgeBindingReason = '';
      if (signature !== judgeAdapterSignature) {
        const judgeModel = llm.createBudgetedJudgeModel({
          budgetService,
          accountId: identity.accountId,
          instanceId: identity.instanceId,
          model: identity.model,
          baseUrl: identity.baseUrl,
          apiKey: identity.apiKey,
          purpose: 'cloud_judge',
          maxTokens: identity.judgeMaxTokens,
          thinking: identity.judgeThinking,
          thinkingBudget: identity.globalThinkingBudget
        });
        jevModule.configure({
          judgeModel,
          judgeModelLabel: independent ? `${identity.model} @ ${identity.judgeProviderId}` : identity.model
        });
        judgeAdapterSignature = signature;
      }
    }

    let budgetStatus = null;
    try {
      budgetStatus = budgetService.getStatus({ accountId: identity.accountId, instanceId: identity.instanceId });
    } catch (error) {
      budgetStatus = { level: 'unavailable', reason: String(error?.message ?? error), pausedPurposes: [] };
    }
    const level = String(budgetStatus?.level ?? 'unavailable');
    const reason = String(budgetStatus?.reason ?? 'budget-status-unavailable');
    const pausedPurposes = Array.isArray(budgetStatus?.pausedPurposes)
      ? budgetStatus.pausedPurposes.map((value) => String(value)).slice(0, 20) : [];
    // 默认无限和软阈值不阻止请求；仅真实硬限/账本故障报告暂停。
    if (level === 'soft-limit' || level === 'unconfigured') pausedPurposes.length = 0;
    if ((pausedPurposes.includes('jev') || ['unreliable', 'hard-limit', 'unavailable'].includes(level))
      && !pausedPurposes.includes('cloud_judge')) pausedPurposes.push('cloud_judge');
    const modeEnabled = configStore.get('localJev.judgeMode.enabled', false) === true;
    let state = 'ready';
    if (['unreliable', 'unavailable'].includes(level)) state = 'budget-unavailable';
    else if (level === 'hard-limit' || pausedPurposes.includes('cloud_judge')) state = 'budget-exhausted';
    else if (!jevModule?.isJudgeModelBound?.()) state = judgeBindingReason || 'model-not-configured';
    else if (!modeEnabled) state = 'mode-disabled';
    const judgeBudget = (() => {
      try { return jevModule?.judgeBudgetState?.() ?? null; } catch { return null; }
    })();
    // 仅将非法硬额度列为缺项；null 是合法的无限设置。
    const judgeMissing = [];
    if (independent) {
      if (!identity.judgeProviderId) judgeMissing.push('localJev.judgeApi.providerId');
      if (identity.judgeProviderId && !identity.judgeProviderFound) judgeMissing.push('localJev.judgeApi.providerId(不存在)');
      if (!identity.model) judgeMissing.push('localJev.judgeApi.model');
      if (identity.judgeProviderId && identity.judgeProviderFound && !identity.judgeProviderHasKey) judgeMissing.push('供应商密钥（设置 → 模型/供应商）');
      if (identity.judgeProviderId && !identity.baseUrl) judgeMissing.push('供应商 baseURL');
    } else if (!identity.model || !urlIsValid) {
      judgeMissing.push('api.model / api.baseUrl（跟随发言配置）');
    }
    const budgetMissing = budgetStatus?.hardLimitMode === 'invalid'
      ? ['api.budget.hardLimitTokens'] : [];
    const budgetReasonLabel = budgetStatus?.hardLimitMode === 'invalid'
      ? '硬额度配置非法（不是有效的 token 数）——请改成正整数或留空'
      : (level === 'unconfigured'
        ? '未设每日付费硬额度（默认不限）：判定请求可继续'
        : (level === 'soft-limit' ? '已达日用量软阈值：不阻止请求' : ''));
    return {
      modeEnabled,
      modelBound: jevModule?.isJudgeModelBound?.() === true,
      state,
      reason: state.startsWith('budget-') ? reason : (state === 'ready' || state === 'mode-disabled' ? '' : judgeBindingReason || reason),
      // 一句话给 UI：为什么现在不可用 + 要去改哪个设置（缺失时为空字符串）。
      actionNeeded: budgetMissing.length
        ? '请将每日付费硬额度改为正整数，或留空恢复默认无限'
        : (state === 'budget-exhausted' ? '每日硬额度不足：可调大或留空；账本用量不会被清零'
          : (state === 'budget-unavailable' ? '预算状态不可用，请检查账本与错误原因'
            : (state === 'ready' || state === 'mode-disabled' ? '' : (judgeMissing.length ? `判定配置不完整：${judgeMissing.join('、')}` : String(judgeBindingReason || reason || ''))))),
      settingsPath: budgetMissing.length || state === 'budget-exhausted' ? 'api.budget.hardLimitTokens' : (judgeMissing.length ? 'localJev.judgeApi' : ''),
      missing: budgetMissing.length ? budgetMissing : judgeMissing,
      // ★ 2026-10-16（独立云判定收口）：把"这一轮判定到底用的是谁"如实带出来 ——
      //   模式、提供商、主机、模型、思考三态、输出预算。**不含凭据**（只有"有没有 key"这一个布尔）。
      judge: {
        source: identity.judgeSource,                 // follow | independent
        modeRaw: identity.judgeModeRaw,               // 配置原文（认不出的值按 follow 处理，这里能看出来）
        speakProvider: identity.speakProvider || null,
        providerId: independent ? identity.judgeProviderId : (identity.speakProvider || null),
        providerFound: independent ? identity.judgeProviderFound : null,
        providerHasKey: independent ? identity.judgeProviderHasKey : null,
        host: urlHostOf(identity.baseUrl) || null,
        model: identity.model || null,
        thinking: identity.judgeThinking,             // inherit | off | on
        maxTokens: identity.judgeMaxTokens,
        // follow 模式下，独立框里填着的值**不生效**——单独标出来，免得用户以为已经切过去了。
        inactiveFields: !independent ? [
          ...(identity.judgeProviderId ? ['judgeApi.providerId'] : []),
          ...(String(configStore?.get?.('localJev.judgeApi.model', '') ?? '').trim() ? ['judgeApi.model'] : [])
        ] : [],
        // ★ 2026-10-16（配置真值）：用户填的输出上限与实际生效值都给；非法/被夹时明说，不静默违背用户设置。
        configuredMaxTokens: Number.isFinite(Number(configStore.get('localJev.judgeMaxTokens')))
          ? Number(configStore.get('localJev.judgeMaxTokens')) : null,
        effectiveMaxTokens: identity.judgeMaxTokens,
        maxTokensNote: (() => {
          const raw = Number(configStore.get('localJev.judgeMaxTokens'));
          if (!Number.isFinite(raw)) return '未配置/非法 ⇒ 按默认 384 用（合法 128..4096）';
          if (raw < 128 || raw > 4096) return `配置 ${raw} 超出 128..4096 ⇒ 实际按 ${identity.judgeMaxTokens} 用`;
          return '';
        })(),
        effective: judgeBudget ? {
          outputTokens: judgeBudget.outputTokens,
          totalCapTokens: judgeBudget.totalCapTokens,
          inputCapTokens: judgeBudget.inputTokensCap
        } : null
      },
      budget: {
        level,
        reason,
        reasonLabel: budgetReasonLabel,
        actionNeeded: budgetMissing.length ? 'fix-api-budget-hard-limit-tokens' : (state === 'budget-exhausted' ? 'review-api-budget-hard-limit-tokens' : ''),
        missing: budgetMissing,
        settingsPath: 'api.budget.hardLimitTokens',
        hardLimitConfigured: budgetStatus?.hardLimitConfigured === true,
        hardLimitMode: String(budgetStatus?.hardLimitMode ?? 'unknown'),
        date: String(budgetStatus?.date ?? ''),
        usedTokens: Number.isSafeInteger(budgetStatus?.usedTokens) ? budgetStatus.usedTokens : null,
        hardLimitTokens: Number.isSafeInteger(budgetStatus?.hardLimitTokens) ? budgetStatus.hardLimitTokens : null,
        balanceTokens: Number.isSafeInteger(budgetStatus?.balanceTokens) ? budgetStatus.balanceTokens : null,
        // 判定自己的用途分账（与主调用同一个预算身份：accountId/instanceId 同一份）
        purposeTokens: Number.isSafeInteger(budgetStatus?.purposeTotals?.cloud_judge) ? budgetStatus.purposeTotals.cloud_judge : null,
        pausedPurposes
      }
    };
  };
  modulesObj.getJudgeAvailability = ({ kind = 'group', proactive = false } = {}) => {
    if (kind !== 'group' || proactive === true) return null;
    return refreshJudgeRuntime();
  };
  // 配置改变后更新预算上限、实例份额及判定模型凭据；运行每轮也会再次刷新。
  if (typeof configStore.subscribeConfigChange === 'function') {
    configStore.subscribeConfigChange(() => {
      try { refreshJudgeRuntime(); }
      catch (error) { log(`[apps/server] JEV 运行状态刷新失败：${error?.message ?? error}`); }
    });
  }
  try { refreshJudgeRuntime(); }
  catch (error) { log(`[apps/server] JEV 运行状态初始化失败：${error?.message ?? error}`); }
  // ★ 0.4 工具 ctx 的 `sender`（老树 orchestrator.js:3175 的 this.sender）。
  //   与 api.sender 同一个适配器（走 act.send 唯一出口）；M15 的 buildToolExecutionContext
  //   把它读进 ctx（compose.js 的 `sender: modules?.sender`）⇒ 技能/插件工具拿得到。
  if (extensionSender) {
    modulesObj.sender = extensionSender;
    log('[apps/server] 已装配扩展发送出口 → ctx.sender（0.4 契约，技能工具的自发送走 act.send）');
  }

  // ★ W-3b(1)「输入预览」的抄手：在 llm/prompt 外面套一层"照原样抄一份再转发"。
  //   为什么套在这里而不是 UI 侧重拼：扩展钩子（M12 hookBeforeLlmMessages，compose.js:364）
  //   是在**发给模型之前**就地改 messages 的 ⇒ 只有这一层看到的是真发出去的那份。
  //   只写 <dataDir>/ui-preview/**，不碰 ledger/trace；套不上（模块缺出口）就原样返回，不影响主链。
  const uiPreview = createUiPreview({ dataDir: resolvedDataDir, log });
  uiPreview.applyTo(modulesObj);

  // ★ 活 runtime 的落点：HTTP 层（`api/shell.js` 的 `/api/pause`、`/api/resume`）要**同一个**实例 ——
  //   另造一个只会造出"pause 了一个没人用的运行时"这种假动作。用 getter 暴露 ⇒ 注入后立刻可见。
  let liveRuntime = null;

  async function startVectorEmbedding({ force = false } = {}) {
    if (vectorStartPromise) return vectorStartPromise;
    const pendingConfig = readVectorConfig();
    // ★ 2026-10-16（"配置 ON ≠ 已应用"）：模型/端口/开关改过就必须**真重启** owned runtime；
    //   否则 ready 早退会让"点了应用没反应"，状态与实际长期不一致。只动我们自己启动的实例，
    //   绝不接管/重启用户的其它进程。
    const configChanged = Boolean(vectorAppliedConfig
      && vectorConfigSignature(pendingConfig) !== vectorConfigSignature(vectorAppliedConfig));
    if (vectorRuntime && vectorStatus.state === 'ready' && !configChanged && force !== true) {
      return getVectorEmbeddingStatus();
    }
    vectorStartPromise = (async () => {
      const hadSemantic = vectorSemanticRecall !== null;
      if (vectorRuntime || vectorStatus.state === 'ready') {
        try { await stopVectorEmbedding(); }
        catch (error) { log(`[apps/server] M7 应用新配置前停止旧 runtime 失败：${error?.message ?? error}`); }
      }
      const config = readVectorConfig();
      vectorAppliedConfig = config;
      vectorSemanticRecall = null;
      if (!config.enabled) {
        vectorStatus = { state: 'disabled', mode: 'keyword', reason: '' };
        log('[apps/server] M7 向量语义召回已关闭（vector.enabled=false）；记忆保持关键词召回。');
        rebindVectorCoordinator(hadSemantic);
        return getVectorEmbeddingStatus();
      }

      vectorStatus = { state: 'starting', mode: 'keyword', reason: '', port: config.port };
      let candidate = null;
      try {
        const missing = [];
        if (!config.modelPath) missing.push('vector.modelPath');
        if (!config.executablePath) missing.push('vector.executablePath');
        if (!config.logPath) missing.push('vector.logPath');
        if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) missing.push('vector.port');
        if (missing.length) throw new Error(`配置无效：缺少或不合法的 ${missing.join('、')}`);

        const absolutePath = (value) => path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
        const exePath = absolutePath(config.executablePath);
        const modelFilePath = absolutePath(config.modelPath);
        // ★ 2026-10-17：`QQ_AGENT_VECTOR_LOG_PATH` 可覆盖日志落点 —— 给"用独立 dataDir 起探针/回归"
        //   的场景用（配置里的相对路径按**安装目录**解析，不随 QQ_AGENT_DATA_DIR 走，见 defaults 的 logPath 注释）。
        const logFileOverride = String(process.env.QQ_AGENT_VECTOR_LOG_PATH ?? '').trim();
        const logFilePath = logFileOverride ? path.resolve(logFileOverride) : absolutePath(config.logPath);
        // ★ 2026-10-17（CPU/GPU 运行环境选择，无 GPU 的 Windows 是可用基线）：
        //   ① 显式 `vector.runtime='cuda'` ⇒ CUDA 档（用户知道自己有 N 卡）；
        //   ② 显式 `'cpu'` ⇒ CPU 档；
        //   ③ 默认 'auto'：executablePath 落在 `runtime/llama-cuda` 里 ⇒ 尊重路径选 CUDA 档
        //      （显式指到 CUDA exe 的人显然要 CUDA），否则 **CPU 档**（随包默认，任何机器都能起）。
        //   为什么不是"有 CUDA 目录就优先 CUDA"：那目录随包存在，不代表本机能跑 CUDA 内核 ——
        //   默认挑它会在一台没装 CUDA 运行时的机器上把默认功能做成"起不来"。
        const wantsCuda = config.runtime === 'cuda'
          || (config.runtime !== 'cpu' && /llama-cuda/i.test(exePath));
        const activeProfile = wantsCuda ? BGE_ZH_LOCAL_CUDA_PROFILE : BGE_ZH_LOCAL_PROFILE;
        candidate = createLlamaEmbeddingRuntime({
          profile: activeProfile,
          modelPath: modelFilePath,
          executablePath: exePath,
          logPath: logFilePath,
          host: '127.0.0.1',
          port: config.port
        });
        // ★ 2026-10-17（端口回落）：配置端口被占（双号同默认口 / 残留 llama-server）不再整条降级 ——
        //   在 [port, port+20] 里依次找第一个**真能 bind** 的口，只用候选 runtime 自己的 setPort 改写
        //   （绝不改用户配置、不接管别人的进程）。都占着才失败并如实说明。
        let chosenPort = config.port;
        if (!(await portAvailable('127.0.0.1', chosenPort)).ok) {
          chosenPort = null;
          for (let offset = 1; offset <= 20; offset += 1) {
            const probe = config.port + offset;
            if (probe > 65535) break;
            if ((await portAvailable('127.0.0.1', probe)).ok) { chosenPort = probe; break; }
          }
          if (chosenPort === null) {
            throw new Error(`向量端口 ${config.port}~${Math.min(65535, config.port + 20)} 全部被占用：无法启动本地嵌入服务`);
          }
          log(`[apps/server] M7 向量端口 ${config.port} 被占用，本次运行改用空闲端口 ${chosenPort}（只影响本进程，不改配置）。`);
          candidate.setPort(chosenPort);
        }
        const started = await candidate.start();
        if (started?.ok !== true || started.status !== 'ready') {
          throw new Error(String(started?.reason || started?.status || 'llama-server 未报告 ready'));
        }
        const semantic = createSemanticRecallOrNull({ loaded, runtime: candidate, log });

        vectorRuntime = candidate;
        vectorSemanticRecall = semantic;
        vectorStatus = {
          state: 'ready', mode: 'semantic', reason: '', port: started.port ?? chosenPort,
          endpoint: started.endpoint || `http://127.0.0.1:${chosenPort}`,
          profileFingerprint: started.profileFingerprint || '',
          runtime: wantsCuda ? 'cuda' : 'cpu'
        };
        log(`[apps/server] M7 向量语义召回已就绪（${vectorStatus.endpoint}，${wantsCuda ? 'CUDA' : 'CPU'} 运行环境，BGE ${activeProfile.dims} 维；coordinator 将注入 semantic recall）。`);
        rebindVectorCoordinator(hadSemantic);
        return getVectorEmbeddingStatus();
      } catch (error) {
        const reason = String(error?.message ?? error);
        if (candidate) {
          try { await candidate.close(); }
          catch (closeError) { log(`[apps/server] M7 失败 runtime 清理失败：${closeError?.message ?? closeError}`); }
        }
        vectorStatus = { state: 'unavailable', mode: 'keyword', reason, port: config.port };
        log(`[apps/server] M7 向量语义召回启动失败，已降级关键词召回；原因：${reason}`);
        rebindVectorCoordinator(hadSemantic);
        return getVectorEmbeddingStatus();
      }
    })().finally(() => { vectorStartPromise = null; });
    return vectorStartPromise;
  }

  async function stopVectorEmbedding() {
    const hadSemantic = vectorSemanticRecall !== null;
    const owned = vectorRuntime;
    const semantic = vectorSemanticRecall;
    vectorRuntime = null;
    vectorSemanticRecall = null;
    if (!owned) {
      // ★ 2026-10-16：即使没有 owned runtime（例如从没启动过），可用性也可能因配置变化而改变 ——
      //   coordinator 该重建就重建（关掉开关后它必须停止再用索引）。
      rebindVectorCoordinator(hadSemantic);
      return { ok: true, stopped: false };
    }
    try {
      try { await semantic?.close?.(); }
      catch (error) { log(`[apps/server] M7 semantic index 停止失败：${error?.message ?? error}`); }
      const result = await owned.close();
      vectorStatus = { state: 'stopped', mode: 'keyword', reason: result?.ok === false ? String(result.error || 'runtime stop failed') : '' };
      if (result?.ok === false) log(`[apps/server] M7 向量 runtime 停止失败：${vectorStatus.reason}`);
      else log('[apps/server] M7 向量语义召回 runtime 已停止。');
      rebindVectorCoordinator(hadSemantic);
      return result;
    } catch (error) {
      vectorStatus = { state: 'stopped', mode: 'keyword', reason: String(error?.message ?? error) };
      log(`[apps/server] M7 向量 runtime 停止失败：${vectorStatus.reason}`);
      rebindVectorCoordinator(hadSemantic);
      return { ok: false, reason: vectorStatus.reason };
    }
  }

  return {
    dataDir: resolvedDataDir,
    modules: modulesForContext,
    modulesObj,
    configStore: configStoreWithSaveEvents,
    memory,
    obs,
    /**
     * ★ A3（2026-10-11 mimo3）：老树 `ctx.emit` 的等价出口 = 观测 bus（sse-bridge 订的就是它）。
     *   缺这个键时 `api/media.js:363` 的 sticker-annotate 提取静默 no-op ⇒ 补备注进度帧一个都到不了
     *   （sse-bridge.js BRIDGE_ROWS 的 sticker-annotate 行以 status:'not-ported' 记过这条）。
     *   ⚠ 与 T-BUS-LOOP（本文件 :1081）的边界：`obs.emit` 是**原样 bus emit**（不经 obs.event、不回灌），
     *   订阅方只有 sse-bridge 转发 SSE 帧，没有任何路径再触发标注 ⇒ 不构成自激回路。
     */
    emit: obs.emit,
    extensionRoots: resolvedExtensionRoots,
    /**
     * ★ N33：Memory Coordinator（`modules/memory/coordinator.js`）的唯一实例。
     * HTTP 层「整理印象」两条端点共用它 ⇒ **同一个对象，不各写一套**。
     * ⚠ 编排层（`modules/orchestrator/index.js:180`）读的是 `modulesObj.memory.coordinator`，
     *   本票**刻意没挂过去**（那是 bunny1 的域，翻不翻由指挥位定）—— 见装配处那段注释。
     */
    get memoryCoordinator() {
      // ★ 2026-10-15 修线上 500（`resolveMemoryCoordinator is not defined`）：这个 getter 与
      //   `resolveMemoryCoordinator()`（buildRuntimeModules 内的函数声明）**不在同一个词法作用域**
      //   —— 以前的写法是直接调用它 ⇒ 每次 /api/memory-* 取 ctx.memoryCoordinator 都抛 ReferenceError。
      //   现在入口由 `modulesObj.__resolveMemoryCoordinator`（装配时挂，见上面那行）带出来。
      //   万一这条线又断：**如实记一条日志并降级为"账号未绑定"**（走 501 那条既有路径），
      //   不再抛 500 —— 但也不静默：日志里点名缺的是哪个入口。
      const resolve = modulesObj.__resolveMemoryCoordinator;
      if (typeof resolve !== 'function') {
        log?.('[apps/server] ⚠ memoryCoordinator 解析入口缺失（modulesObj.__resolveMemoryCoordinator）⇒ 记忆整理类端点按"账号未绑定"处理');
        return null;
      }
      return resolve();
    },
    /**
     * ★ 2026-10-15（ds3 · 记忆自动整理调度）：调度器读数/心跳入口（`tick` 由 apps/server/index.js
     *   那个**唯一**的 5s setInterval 调）。排障用 `status()` 看"现在到底开没开、待办几个会话"。
     */
    memoryMaintenance: modulesObj.__memoryMaintenance ?? null,
    /**
     * ★ N38：`/api/memory-files/consolidate` 的「只整理这一个人」作用域。
     * 端点在排队前调 `add(chatKey, subjectIds)`；装配层的 extract 包装层在下一次抽取时取用并清空。
     * ⇒ 队列契约（bunny2 的 `requestConsolidation`）一个字没改，收窄全部落在 apps/server 内。
     */
    consolidationScope: modulesObj.__consolidationScope ?? { add: () => [], peek: () => [] },
    modulesLoaded: [...loaded.keys()],
    busEvents,
    orchestrator,
    /** M7 的 llama-server 由本装配实例持有；调用者明确启动/停止，外部实例不接管。 */
    startVectorEmbedding,
    stopVectorEmbedding,
    vectorEmbeddingStatus: getVectorEmbeddingStatus,
    setVectorRecallQuery(chatKey, query) {
      const key = String(chatKey ?? '').trim();
      const text = String(query ?? '').trim();
      if (!key || !text) return null;
      const token = Symbol('vector-recall-query');
      // `at`/`live` 只做诊断（"这一轮到底有没有在用 semantic"）：live 记录**写下这次查询时**语义召回是否已就绪。
      vectorRecallQueries.set(key, { token, query: text.slice(-2048), at: Date.now(), live: vectorSemanticRecall !== null });
      return token;
    },
    clearVectorRecallQuery(chatKey, token) {
      const key = String(chatKey ?? '').trim();
      const current = vectorRecallQueries.get(key);
      if (!key || !current || current.token !== token) return false;
      vectorRecallQueries.delete(key);
      return true;
    },
    /** W-3b(1)：本轮真发给模型的 messages 只读抄手（`GET /api/ui-preview` 的源头）。 */
    uiPreview,

    /** HTTP ctx 读的活 runtime（`api/shell.js:390 ctx?.runtime`）。start() 注入前是 null。 */
    get runtime() { return liveRuntime; },

    /**
     * 把活 runtime 注入 HTTP ctx（`apps/server/index.js` 的 start() 在 `createRuntime()` 之后立刻调）。
     * 校验必需出口：缺一个就**抛**，不许让 `/api/pause` 拿到一个半残的对象然后静默 501/500。
     * @param {object} live - M15 runtime（§3.8：`{onInbound,onTick,status,pause,resume,abortAll,...}`）
     */
    setRuntime(live) {
      const need = ['onInbound', 'onTick', 'status', 'pause', 'resume', 'abortAll'];
      const missing = need.filter((k) => typeof live?.[k] !== 'function');
      if (missing.length) {
        throw new Error(`[apps/server] setRuntime 需要 M15 运行时的 ${need.join('/')} 出口；缺：${missing.join(', ')}`);
      }
      liveRuntime = live;
      return live;
    },

    /** 情绪状态兜底落盘（server.stop() 调；每轮的 flush 由 M15 调）。 */
    flushEmotionState() {
      const emotion = modulesObj.emotion;
      if (typeof emotion?.flush !== 'function') return { ok: false, reason: 'no-emotion-store' };
      return emotion.flush();
    },

    /**
     * ★ 2026-10-17：显式关闭人设分界（退订 `subscribeConfigChange` + 从 REGISTRY 移除）。
     *   · 热装配/重复 `assemble()`：同 dataDir 的新实例在 helper 里**自动关掉旧实例**，
     *     不需要调用方记得；
     *   · 进程关停：订阅随进程消失；`apps/server/index.js` 的 stop() 目前没有调用本方法
     *     （跨文件、本轮不改），要给长期驻留进程做干净拆卸时在这里接一次即可。
     */
    closePersonaBoundary() {
      try { personaBoundary.close(); return { ok: true }; }
      catch (error) { return { ok: false, reason: String(error?.message ?? error) }; }
    },

    /**
     * 把活着的 platform 实例注入 M15 看到的 modules 命名空间。
     * §3.7：发送唯一出口是 platform.sendTextBatch；M3 的模块命名空间没有这个出口。
     * @param {{sendTextBatch: Function}} live - onebot-link 里的活客户端
     */
    setPlatform(live) {
      if (!live || typeof live.sendTextBatch !== 'function') {
        throw new Error('[apps/server] setPlatform 需要带 sendTextBatch 的活 platform 实例（不许注入模块命名空间）');
      }
      modulesObj.platform = live;
      const accountId = String(live.selfId ?? live.client?.selfId ?? '').replace(/\D/g, '').trim();
      if (accountId) modulesObj.__setMemoryCoordinatorAccountId?.(accountId);
      else {
        // ★ 2026-10-16（事故收口）：selfId 为空不是小毛病 —— 预算化模型调用会**每轮**被拒
        //   （compose.js:581-583 → `budget-account-id-unavailable`），症状是"收得到消息、永远不发言、
        //   只留系统记录"。这里在注入点就把阶段与下一步写清楚（不记令牌、不记内容）。
        log('[apps/server] ⚠ 注入的 platform.selfId 为空 ⇒ 预算化模型调用会被拒（budget-account-id-unavailable）：'
          + '多半是 OneBot 的 HTTP `get_login_info` 没成功（selfId 只来自它，见 modules/platform/onebot.js:143-151）；'
          + '核对 snowluma.httpUrl / snowluma.httpAccessToken，并查日志里的 "[onebot] 获取登录信息失败" 一行');
      }
      try { refreshJudgeRuntime(); }
      catch (error) { log(`[apps/server] JEV 平台身份更新失败：${error?.message ?? error}`); }
      return live;
    },

    /**
     * 创建运行时（§3.8：createRuntime({cfg, log, bus, modules, clock}) -> {onInbound, onTick, status, pause, abortAll}）。
     * M15 未落地时抛错，不许 stub 成假绿。
     */
    createRuntime() {
      if (!orchestrator?.createRuntime) {
        throw new Error(
          '[apps/server] modules/orchestrator.createRuntime 不存在（M15 未落地）—— 不许 stub 成假绿。'
        );
      }
      return orchestrator.createRuntime({
        cfg: { get: configStore.get, effective: configStore.effective, sourceOf: configStore.sourceOf },
        // ★ D-2 B：M15 的日志出口是**结构化**签名 `log(level, message, fields)`
        //   （见 modules/orchestrator/index.js:26），而这里传进来的 `log` 是"一行文本"型
        //   （apps/desktop/main.js:544：`(...args) => logger.info('app', args.map(String).join(' '))`）。
        //   直接透传的实测后果：fields 被 String() 成 `[object Object]` ——
        //   盘上 `16:10:35 [INFO ] [app] info round-finished [object Object]` 就是这么来的，
        //   于是"这轮为什么没发出去"在日志里查不到 chatKey/轮数/原因。
        //   ⇒ 在边界上显式拍平（不指望被调方猜签名），结构化字段原样进 JSON 尾巴。
        log: (level, message, fields) => {
          if (message === undefined) return log(String(level ?? ''));   // 一行式调用原样透传
          let tail = '';
          if (fields != null) {
            try { tail = ` ${typeof fields === 'string' ? fields : JSON.stringify(fields)}`; }
            catch { tail = ' [fields 不可序列化]'; }
          }
          return log(`${String(level ?? 'info')} ${String(message ?? '')}${tail}`);
        },
        bus: { on: obs.on, emit: obs.emit },
        modules: modulesObj,
        clock: {
          now: () => Date.now(),
          random: Math.random, // §3.8：M15 读 clock.random（时间/随机不许自取）
          rand: Math.random,
          schedule: (fn, ms) => setTimeout(fn, ms),
          cancel: (h) => clearTimeout(h)
        }
      });
    },

    /**
     * 注入 botSaidBefore 长窗口（§3.7 第 0 条硬要求，修订版）。
     * M8 的冷却/小时上限读的是 evidence[].botSaidBefore —— 长窗口由调用方喂进 A 阶段。
     * 装配层的责任是保证能注入下去；真正取数与注入在 M15。
     * @param {Array<{at: number}>} botSaidBefore - "最近一小时 ∪ 最近 N 轮"的并集
     */
    injectBotSaidBefore(botSaidBefore) {
      if (orchestrator?.configure) {
        orchestrator.configure({ botSaidBefore });
      }
    }
  };
}

export { MODULE_LOAD_TABLE };
