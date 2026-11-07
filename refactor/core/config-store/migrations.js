// ─────────────────────────────────────────────────────────────────────────────
// 本文件由脚本从 `src/config.js 第 1231–1403 行` **逐字搬运**（生成器：.tmp-dispatch/_t-refactor-gen.mjs）
// 内容 = 深合并 + 五个迁移/补全函数，**顺序与内容逐字照搬**
// ★ 搬运原则：**一个字都没改**（含注释与空行），只改了 export 修饰与文件归属。
//   行为等价性靠 selftest.mjs 断言，见回执的「迁移逻辑逐条对照表」。
// ─────────────────────────────────────────────────────────────────────────────

// ★ 搬运适配（本文件**唯一**允许的改动）：搬来的迁移函数体内引用 DEFAULT_CONFIG
//   （原文件里它是同作用域常量；新模块按文件拆分 ⇒ 必须显式 import）。
//   **只解决作用域可见性，不改任何逻辑、不改任何默认值。**
import { DEFAULT_CONFIG, BOT_ALIAS_KEYWORDS } from './defaults.js';

// ── deepMerge（深合并 + __replace__ 整体替换约定） ──
function deepMerge(base, override) {
  if (override === null || override === undefined) return structuredClone(base);
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return structuredClone(override);
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    // 整体替换约定：{ __replace__: X } → 该键直接用 X，不做递归合并。
    // 用于映射型字段（如 api.modelPrices）需要"删掉旧键"的场景 ——
    // 普通深合并传 {} 是删不掉已有键的。
    if (value && typeof value === 'object' && !Array.isArray(value) && '__replace__' in value) {
      out[key] = structuredClone(value.__replace__);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

// ── ensureBotAliasKeywords（机器人别名关键词补全） ──
// 2026-11-05（溟）：加 `store.autoAliasKeywords` 开关，默认 true ⇒ 出厂行为一个字没变。
// 起因：data-2 那个实例（泠岚，GLM）不是鲸系，她自己的卡上写着「鲸鱼娘/胖鲸/小鲸鱼是别人的名字，
// 被这么叫要纠正」。可这四条是硬编码补回关键词表的 —— 删一次，下一次 load/save 又塞回来，
// 表现就是「改了没效果 / 改了又变回去」。设 `store.autoAliasKeywords: false` 即不再自动补。
function ensureBotAliasKeywords(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  if (!cfg.store || typeof cfg.store !== 'object' || Array.isArray(cfg.store)) cfg.store = {};
  const keywords = Array.isArray(cfg.store.keywords) ? cfg.store.keywords : [];
  if (cfg.store.autoAliasKeywords === false) {
    cfg.store.keywords = keywords;   // 尊重这份自己定的表，一条也不补
    return cfg;
  }
  const present = new Set(keywords.filter((value) => typeof value === 'string').map((value) => value.trim()));
  cfg.store.keywords = [...keywords, ...BOT_ALIAS_KEYWORDS.filter((name) => !present.has(name))];
  return cfg;
}

/**
 * 本地 Jev 的一次性迁移（2026-09-19）。
 *
 * 为什么需要：老配置把「概率 ≥0.75 一刀切」写死在 data/config.json 里，
 * 而实测那样 0.8B 会弃权 16/24（六成题白问），并且把 narrationGate 开着
 * 小模型会把该发的话误判成独白。默认值改了不等于用户会变，
 * 所以这里对**落盘过的**老配置做一次原地升级；迁移完打标记，只跑一次。
 *
 * 迁移内容：
 *   minConfidence 0.75 → 0.5，补上 minMargin 0.6，打开 useGrammar
 *   接管表里摘掉 narrationGate、补上 replyChanceGate（替代档位 3 的掷骰子）
 *   补 replyChance / cloud 两个新配置块
 * 用户之后在设置页怎么改都不会再被覆盖（有标记）。
 */

// ── migrateLocalJev（★ 关键迁移：minConfidence 0.75→… / roles 补 replyChanceGate / 旧键升级） ──
function migrateLocalJev(cfg) {
  const j = cfg?.localJev;
  if (!j || typeof j !== 'object') return cfg;
  // 新角色要能自动出现在已有配置里：用 rolesKnown 记录「用户见过的角色集」。
  // 没见过的新角色 → 补进 roles（跟随默认开启）并记入 rolesKnown；
  // 用户后来手动关掉的（在 rolesKnown 里但不在 roles 里）→ 尊重其选择，不再自动打开。
  // ⚠️ 这段必须在下面的 migrated 早退**之前**跑：每次加载都要执行，
  //    否则以后每加一个角色都得再发一次一次性迁移（本次就栽过 ——
  //    impressionTypeGate 加了却全是 role-off）。
  if (Array.isArray(j.roles)) {
    const known = new Set(Array.isArray(j.rolesKnown) && j.rolesKnown.length ? j.rolesKnown : j.roles);
    let rolesChanged = false;
    for (const r of DEFAULT_CONFIG.localJev.roles) {
      if (known.has(r)) continue;
      known.add(r);
      if (!j.roles.includes(r)) { j.roles.push(r); rolesChanged = true; }
    }
    if (rolesChanged || j.rolesKnown === undefined) j.rolesKnown = [...known];
  }
  // ── 2026-09-22：把本地 0.8B 从「正文该不该发」这道题上真正摘下来 ──
  // 上面那段只**补**新角色、从不删旧角色，所以 09-21 把 unsentLinesJudge 从默认表删掉
  // 对老配置**毫无作用**：老配置的 roles 是显式数组（deepMerge 不合并数组），
  // 两个号上它一直还在跑 —— 这正是"改了默认值却没生效"的典型坑。
  // 这里用一次性标记真删；两个角色仍写进 rolesKnown（= 用户见过），
  // 于是不会被自动补回来，UI 角色表（localJevRoleCatalog 基于 JEV_ROLES 全表）照旧列出，
  // 想恢复去设置页勾一下即可 —— 标记一旦随任意一次保存落盘，这段就不再拦，
  // 用户勾回来的选择会被尊重（只有手动改 config.json / 还原旧备份才会被再摘一次）。
  // 实测依据见 DEFAULT_CONFIG.localJev.roles 上面那段注释。
  if (j.jevTextJudge !== '2026-09-22') {
    const dropped = ['textOnlyJudge', 'unsentLinesJudge'];
    if (Array.isArray(j.roles)) j.roles = j.roles.filter((r) => !dropped.includes(r));
    const knownSet = new Set(Array.isArray(j.rolesKnown) ? j.rolesKnown : []);
    for (const r of dropped) knownSet.add(r);
    j.rolesKnown = [...knownSet];
    j.jevTextJudge = '2026-09-22';
  }
  // ── 2026-09-23：两号的 Jev 端口必须错开 ──
  // 默认值早就改成"按实例号错开"（18080 / 18090 / …），但 `port` 是显式数字字段，
  // 老配置里存着 18080 → 一直停在共享口。后果不是"归属不明"这么轻：
  //   · 第二个号 probeReady 探到第一个号的服务就 reused，**不会**新起进程，
  //     于是本地并发记账（maxInflight）是本号配置、服务端 --parallel 却是另一号的；
  //   · 真正持有进程的那个号一停，另一个号的 Jev 当场全挂（表现为所有闸门一起弃权）。
  // 只挪"还是出厂 18080"的配置；用户自己填过的（比如 19000）一律不动。
  // 标记落在每次加载都执行的位置，标记本身也随保存落盘 → 之后再手动改不回滚。
  if (j.portMigrated !== '2026-09-23') {
    const wantPort = Number(DEFAULT_CONFIG.localJev.port) || 18080;
    if (Number(j.port) === 18080 && wantPort !== 18080) j.port = wantPort;
    const wantSec = Number(DEFAULT_CONFIG.localJev.secondary?.port) || 18081;
    if (j.secondary && Number(j.secondary.port) === 18081 && wantSec !== 18081) j.secondary.port = wantSec;
    const wantVis = Number(DEFAULT_CONFIG.localJev.vision?.port) || 18085;
    if (j.vision && Number(j.vision.port) === 18085 && wantVis !== 18085) j.vision.port = wantVis;
    j.portMigrated = '2026-09-23';
  }
  if (j.migrated === '2026-09-19') return cfg;
  if (Number(j.minConfidence) === 0.75) j.minConfidence = DEFAULT_CONFIG.localJev.minConfidence;
  if (j.minMargin === undefined) j.minMargin = DEFAULT_CONFIG.localJev.minMargin;
  if (j.useGrammar === undefined) j.useGrammar = true;
  if (Array.isArray(j.roles)) {
    const set = new Set(j.roles.filter((r) => r !== 'narrationGate'));
    set.add('replyChanceGate');
    j.roles = [...set];
  }
  j.replyChance = { ...DEFAULT_CONFIG.localJev.replyChance, ...(j.replyChance || {}) };
  j.cloud = { ...DEFAULT_CONFIG.localJev.cloud, ...(j.cloud || {}) };
  j.migrated = '2026-09-19';
  return cfg;
}

/**
 * 分条发送节奏的一次性迁移（2026-09-22）。
 *
 * 为什么必须写成迁移、而不是只改 DEFAULT_CONFIG.send 里的三个数字：
 *   `loadConfig()` 是 `deepMerge(DEFAULT_CONFIG, 存档配置)`，**存档值优先**。
 *   两个号的 config.json 里 send 是显式的 minGapMs:1800 / maxGapMs:4500 / byLengthMs:100，
 *   只改默认值对它们是**零作用** —— 和上面 unsentLinesJudge「改了默认值却没生效」是同一个坑。
 *
 * 实测依据（号A 09-22 当天 n=129 会话）：
 *   模型返回到全部发完还要 4.5s（p50），其中主要就是这里的每条气泡间隔
 *   （`#gap` 算出来约 1.8~3.8s/条）；`send.maxPerMinute=10` 满了还要再 sleep ≤6s。
 *   用户反馈"开始之后很久不说话"。新值 500/1200/30 → 每条约 0.5~1.1s，
 *   仍然看得出是分条发的，但不再把一轮回复拖成半分钟。
 *
 * 只动这三个数：限流（maxPerMinute/maxPerHour）、切段（splitLongAt/hardSplitAt）、
 * 过滤（blockPureEnglish）一个都不碰。
 * 标记落盘后（任意一次设置页保存）不再执行，用户之后在设置页改多少就是多少。
 */

// ── migrateSendPacing（分条发送节奏一次性迁移，pacingMigrated 标记） ──
function migrateSendPacing(cfg) {
  const s = cfg?.send;
  if (!s || typeof s !== 'object') return cfg;
  if (s.pacingMigrated === '2026-09-22') return cfg;
  s.minGapMs = DEFAULT_CONFIG.send.minGapMs;
  s.maxGapMs = DEFAULT_CONFIG.send.maxGapMs;
  s.byLengthMs = DEFAULT_CONFIG.send.byLengthMs;
  s.pacingMigrated = '2026-09-22';
  return cfg;
}

/**
 * 缓存相关的一次性对齐（2026-09-22）。
 *
 * 背景：默认值 vs 线上实例长期不一致 —— 线上跑着 `cacheMode:'adaptive'` +
 * 保温 6 棒/30 分钟，而代码默认是 `null`（被 resolveCacheMode 判成 off）+
 * 3 棒/10 分钟。结果是"同一个包，新装的实例和用了两周的实例命中率差一大截"，
 * 而且新装实例根本不打标记、也没有第二道静态块。
 *
 * 规则（只动"从没被显式设置过"的字段）：
 *   · cacheMode 缺失/null 且没开旧开关 explicitCache → 补 'adaptive'
 *   · 保温参数逐个缺失才补默认（**不覆盖**用户自己调过的值）
 * 迁移标记写在 api.cacheMigrated 上，只跑一次。
 */

// ── migrateCacheDefaults（缓存默认档位迁移） ──
function migrateCacheDefaults(cfg) {
  const api = cfg?.api;
  if (!api || typeof api !== 'object') return cfg;
  if (api.cacheMigrated === '2026-09-22') return cfg;
  const d = DEFAULT_CONFIG.api;
  if (api.cacheMode === undefined || api.cacheMode === null) {
    api.cacheMode = api.explicitCache === true ? 'explicit' : d.cacheMode;
  }
  const ka = api.cacheKeepAlive;
  if (!ka || typeof ka !== 'object') {
    api.cacheKeepAlive = { ...d.cacheKeepAlive };
  } else {
    for (const [k, v] of Object.entries(d.cacheKeepAlive)) {
      if (ka[k] === undefined || ka[k] === null) ka[k] = v;
    }
  }
  api.cacheMigrated = '2026-09-22';
  return cfg;
}

/**
 * 成本护栏口径迁移（B7，2026-10-11 用户裁定）。
 *
 * 背景：老口径是「今日 prompt 累计」+「单会话 prompt 累计」两个上限
 * （`costGuard.dayPromptMax` / `costGuard.chatPromptMax`）；用户裁定后改成
 * **一个日上限、度量 = 当日 prompt+completion token 总量**（`costGuard.dayTokenMax`，
 * 默认 30000000）。单会话上限的干预按裁定**去掉**。
 *
 * 迁移规则（只补"从没设过新键"的，**不覆盖**用户自己调过的值）：
 *   · `dayTokenMax` 缺失 ⇒ 用老 `dayPromptMax` 的值顶上（语义从"单日 prompt"扩成
 *     "单日 prompt+completion"，completion 通常远小于 prompt ⇒ 有效上限基本连续，
 *     不会因为改口径把用户原本的额度突然放宽/收紧）；
 *   · 老 `dayPromptMax` 也缺失/非法 ⇒ 用默认值 `DEFAULT_CONFIG.api.costGuard.dayTokenMax`。
 *   · `chatPromptMax` 原样留在盘上（不删、不再读）—— 留档，别把用户历史设置洗掉。
 * 标记写在 `api.costGuardMigrated` 上，只跑一次。
 */

// ── migrateCostGuardTokenMax（日上限口径迁移：dayPromptMax ⇒ dayTokenMax） ──
function migrateCostGuardTokenMax(cfg) {
  const api = cfg?.api;
  if (!api || typeof api !== 'object') return cfg;
  if (api.costGuardMigrated === '2026-10-11') return cfg;
  const guard = api.costGuard;
  const d = DEFAULT_CONFIG.api.costGuard;
  if (!guard || typeof guard !== 'object') {
    api.costGuard = { ...d };
  } else {
    const legacy = Number(guard.dayPromptMax);
    const legacyOk = Number.isFinite(legacy) && legacy > 0;
    if (guard.dayTokenMax === undefined || guard.dayTokenMax === null) {
      guard.dayTokenMax = legacyOk ? legacy : d.dayTokenMax;
    }
    guard.enabled = guard.enabled === undefined || guard.enabled === null ? d.enabled : guard.enabled;
  }
  api.costGuardMigrated = '2026-10-11';
  return cfg;
}

/** 搬运自 src/store.js 的"合并逻辑"（README 不变量：任何模块都不许自己 deepMerge ⇒ 收口到这里）。 */
export { deepMerge, ensureBotAliasKeywords, migrateLocalJev, migrateSendPacing, migrateCacheDefaults, migrateCostGuardTokenMax };
