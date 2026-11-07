// ─────────────────────────────────────────────────────────────────────────────
// refactor/core/config-store —— M1
//
// 职责（README §2 M1）：配置默认值 / 迁移 / 有效值来源（全局 vs 群覆盖）、存储、实例锁。
// 本文件是本模块**唯一公开出口**（README §4：别的模块只能 `import { … } from '../config-store/index.js'`）。
//
// 冻结接口（README §3.2，六个）：
//   load({dataDir}) / get(keyPath, fallback) / effective(keyPath,{chatKey,kind})
//   sourceOf(keyPath,{chatKey,kind}) / set(keyPath,value,{scope,chatKey}) / snapshot()
//
// 2026-10-05 补的两块（缺口⑥：配置"改了不落盘"）：
//   · **档位派生**：搬 `src/tier-slider.js` + `src/config.js:1531-1543` 的 deriveTierFields
//     ⇒ 只传 `store.contextSliderPos` 的调用方也能得到一致的 contextTier/randomPercent。
//   · **落盘出口**：`configFilePath()` / `saveConfig({backup,log})` / `updateConfigAndSave(patch)`
//     / `setAndSave(keyPath,value,options)` —— 语义照搬 `src/config.js:1551-1554`（tmp + rename）。
//     ★ `set()`/`updateConfig()` 本身**仍然只改内存**（那是既有契约，消费者 `skill-bridge` 依赖它）；
//       要持久化就显式调上面三个出口。落盘**不写**默认值：写的是迁移后的 raw（老树是写整份合并视图）。
//
// ★ 不变量（README §3.2 + 铁律）：
//   1. **任何模块都不许自己 deepMerge 配置** —— 合并只在这里发生（migrations.js 的 deepMerge 是唯一定义）。
//   2. 默认值与迁移**逐字搬自现网**，行为不许变；搬运对照表见 .tmp-dispatch/r-refactor-m1-config-store.md。
//   3. **不读也不写真实 data/**（铁律 2）：load() 的 dataDir 由调用方给，selftest 用 .tmp-refactor/ 下的合成目录。
//
// TODO(M2): wire log()  ← 本模块还不许 import core/observability（M2 未落地）。
//   需要记日志的地方一律留这一行注释，等 M2 落地再接。
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, PROFILE_ID } from './defaults.js';
import {
  deepMerge, ensureBotAliasKeywords, migrateLocalJev, migrateSendPacing, migrateCacheDefaults,
  migrateCostGuardTokenMax
} from './migrations.js';
import { scopedStoreConfig, hasStoreField, resolveLayers } from './scope.js';
import { sliderToTier } from './tier-slider.js';

export { scopedStoreConfig, deepMerge, DEFAULT_CONFIG };
// ★ 2026-10-05（qwen3 的 S1 实测点名）：`PERSONAS` 内建人设表早就搬好了，但一直没从本模块公开出口再导出
//   ⇒ `/api/persona-templates` 只能回 501（"缺 M1 出口"）。这里补一行 re-export（**不新增实现，不复制表**）。
export { PERSONAS } from './personas.js';
export { TIER_SLIDER_BANDS, sliderToTier, tierToSlider } from './tier-slider.js';

// ── 冻结名 `DATA_DIR`（消费者：llm/cache-keepalive、internet/api-news、internet/price-feed）──
// ★ 语义逐字照搬 src/config.js:42-43：env 优先；否则按 PROFILE_ID 落到 data / data-<profile>。
//   解析细节在 data-dir.js（index 与 instance-lock 共用同一套，避免成环）。
import { DEFAULT_DATA_DIR, setLoadedDataDir } from './data-dir.js';
export { resolveDataDir } from './data-dir.js';
export const DATA_DIR = DEFAULT_DATA_DIR;
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// ── 实例锁（README §2 把"实例锁"划给 M1；消费者：apps/desktop/main.js）──
export {
  acquireInstanceLock, touchInstanceLock, startInstanceHeartbeat, releaseInstanceLock, describeInstance
} from './instance-lock.js';

let state = null; // { dataDir, raw, defaults, merged, changed:Set<string>, runtimeMode }
const listeners = new Set();

/** 点路径读（不认数组下标，只认对象键；越界返回 undefined）。 */
function readPath(obj, keyPath) {
  if (typeof keyPath !== 'string' || keyPath === '') return undefined;
  let cur = obj;
  for (const seg of keyPath.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * 配置合并：兼容旧存档的 persona.ignoreSenderIds，向运行时统一提供 emotion.ignoreSenderIds。
 * 新路径一旦显式存在就优先，旧值留在 raw 中，不改写用户存档。
 */
function mergeConfig(defaults, raw) {
  const merged = deepMerge(structuredClone(defaults), raw);
  if (readPath(raw, 'emotion.ignoreSenderIds') === undefined) {
    const legacyIgnoreSenderIds = readPath(raw, 'persona.ignoreSenderIds');
    if (legacyIgnoreSenderIds !== undefined) {
      if (!merged.emotion || typeof merged.emotion !== 'object') merged.emotion = {};
      merged.emotion.ignoreSenderIds = structuredClone(legacyIgnoreSenderIds);
    }
  }
  return merged;
}

/**
 * 响应档位派生：把 `store.contextSliderPos`（滑条位置）换算成 `contextTier` + `randomPercent`。
 * ★ 逐字照搬 `src/config.js:1531-1543`（老树注释：「前端只负责上报滑条位置，档位和概率一律由这里换算；
 *   这样即使前端算错、或者有人直接调接口只传位置，配置也不会自相矛盾」）。
 * 群聊/私聊各一份，`store.perChat[chatKey]` 逐个会话一份，互不干扰。
 * 只动传进来的那个对象（原地改），返回它，便于串起来写。
 * @param {object} cfg 含 `store` 的配置对象（raw 或 merged 都行）
 * @returns {object} 同一个对象
 */
/**
 * ★ 2026-10-17（用户令：每个厂商可单独选缓存优化方式）：`providers[].cacheStrategy` 的**唯一枚举与归一化**。
 *   · 枚举 `auto / deepseek / dashscope / zhipu / mimo / compatible`（缺省 auto）；
 *   · **按提供商 id 各存一份**（不做全局策略跟着所有厂商串）；
 *   · 非法值安全回 `auto` 并带原因（`source='fallback'`）——不静默、不抛、不改盘上原值（读时归一）；
 *   · `compatible` = **不发送厂商专属缓存参数**（不表示厂商自动缓存被关闭）。
 * 纯函数：只做"值→语义"归一，不读写配置、不碰网络；策略只影响缓存，不改 thinking/视觉/URL/key。
 */
export const CACHE_STRATEGIES = Object.freeze(['auto', 'deepseek', 'dashscope', 'zhipu', 'mimo', 'compatible']);
export function readProviderCacheStrategy(rawValue) {
  const raw = rawValue === null || rawValue === undefined ? '' : String(rawValue).trim().toLowerCase();
  if (raw === '') return { selected: 'auto', source: 'auto', valid: true, reason: '' };
  if (CACHE_STRATEGIES.includes(raw)) {
    return { selected: raw, source: raw === 'auto' ? 'auto' : 'manual', valid: true, reason: '' };
  }
  return {
    selected: 'auto',
    source: 'fallback',
    valid: false,
    reason: `cacheStrategy='${raw.slice(0, 24)}' 不在枚举（${CACHE_STRATEGIES.join('/')}）⇒ 按 auto 处理`
  };
}

/**
 * @param {object} cfg 含 `store` 的配置对象（raw 或 merged 都行）
 * @returns {object} 同一个对象
 */
export function deriveTierFields(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const derive = (block) => {
    if (!block || typeof block !== 'object') return;
    const posRaw = block.contextSliderPos;
    if (posRaw === undefined || posRaw === null) return;
    const { tier, randomPercent } = sliderToTier(posRaw);
    block.contextTier = tier;
    block.randomPercent = randomPercent;
  };
  derive(cfg.store);
  derive(cfg.store?.private);
  for (const block of Object.values(cfg.store?.perChat || {})) derive(block);
  return cfg;
}

/**
 * 读盘 + 迁移 + 默认值合并。
 * @param {{dataDir:string, fileName?:string}} opts
 *   dataDir 必须是调用方指定的目录（selftest 传 .tmp-refactor/ 下的合成目录）。
 * @returns {{dataDir:string, config:object, migrated:string[], fromDisk:boolean, missingFile:boolean}}
 */
export function load({ dataDir, fileName = 'config.json' } = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') {
    throw new Error('load() 需要 dataDir（不许隐式读进程环境/真实 data/）');
  }
  const file = path.join(dataDir, fileName);
  let disk = null;
  let missingFile = false;
  try {
    disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') missingFile = true;
    else throw new Error(`配置读取失败：${file}：${error?.message ?? error}`);
  }

  // ① 盘上原样（先留一份，供 sourceOf 的 'global' 层判定，也供 UI 排障对比）
  const raw = disk && typeof disk === 'object' ? disk : {};
  // ② 迁移：顺序与现网 loadConfig 一致（见对照表）。
  //   ★ 迁移函数本身只收 `cfg`、原地改、返回 cfg（**签名一个字没改**），
  //   所以「哪几条迁移真的动了东西」由我**如实探测**：每跑一条前后比一次 JSON。
  //   不去改迁移函数加个 out 参数 —— 那会动到搬过来的代码。
  const cfg = structuredClone(raw);
  const migrated = [];
  const runMigration = (name, fn) => {
    const before = JSON.stringify(cfg);
    fn(cfg);
    if (JSON.stringify(cfg) !== before) migrated.push(name);
  };
  runMigration('migrateLocalJev', migrateLocalJev);
  runMigration('migrateSendPacing', migrateSendPacing);
  runMigration('migrateCacheDefaults', migrateCacheDefaults);
  runMigration('migrateCostGuardTokenMax', migrateCostGuardTokenMax);
  runMigration('ensureBotAliasKeywords', ensureBotAliasKeywords);
  // ③′ 档位派生：老树在**写配置**时派生（src/config.js:1531-1543）；新树在读盘后也派生一次，
  //    这样"手改过滑条位置但没走过写接口"的配置也能拿到自洽的 contextTier/randomPercent。
  deriveTierFields(cfg);
  // ③ 合并默认值（唯一入口：deepMerge）
  const merged = mergeConfig(DEFAULT_CONFIG, cfg);
  // ④ 迁移标记落回 merged（迁移可能改的是顶层键，deepMerge 之后要再确认标记存在）
  for (const key of ['localJev', 'send', 'cacheKeepAlive']) {
    if (cfg[key] && typeof cfg[key] === 'object' && merged[key] && typeof merged[key] === 'object') {
      for (const [k, v] of Object.entries(cfg[key])) {
        if (v !== undefined && merged[key][k] === undefined) merged[key][k] = v;
      }
    }
  }

  setLoadedDataDir(dataDir);   // ★ 让实例锁等按文件工作的模块用同一套 dataDir 解析
  state = {
    dataDir,
    raw: structuredClone(raw),
    defaults: structuredClone(DEFAULT_CONFIG),
    // ★ 合并视图只算一次：值一律从这里读（否则上层拿到的是**半片对象**，
    //   会以为某段配置就这么点 —— 这正是 README 不变量「一律走 effective()」要防的）。
    merged: merged,
    changed: new Set(),
    loadFailed: false
  };
  // TODO(M2): wire log()
  return { dataDir, config: merged, migrated, fromDisk: !missingFile, missingFile };
}

function must() {
  if (!state) throw new Error('config-store 还没 load() 过 —— 不许在未读盘的情况下取配置');
  return state;
}

/**
 * 懒初始化（供 `getConfig()` 用）：没 load 过就按 DATA_DIR 读一次。
 * ★ **绝不抛**：读盘坏了就退回「默认值 + 空 raw」，让上层拿到一个可用的配置对象
 *   —— 旧 `getConfig()` 也是这个性格（M12 的 `getConfig()?.skills?.[id]` 那种永不抛的读法必须仍能用）。
 */
function ensureLoaded() {
  if (state) return state;
  try {
    load({ dataDir: DATA_DIR });
  } catch {
    setLoadedDataDir(DATA_DIR);
    state = {
      dataDir: DATA_DIR,
      raw: {},
      defaults: structuredClone(DEFAULT_CONFIG),
      merged: structuredClone(DEFAULT_CONFIG),
      changed: new Set(),
      runtimeMode: false,
      // ★ 读盘失败 ⇒ 这一份是"默认值兜底"，**不是用户配置**。saveConfig() 会据此拒绝覆盖（防洗成默认值）。
      loadFailed: true
    };
  }
  return state;
}

/** 点路径读（读的是**有效值**：会话覆盖 > 全局 > 默认）。 */
export function get(keyPath, fallback = undefined) {
  // ★ 无参 = 返回**活配置对象**（旧 `getConfig()` 的语义，M12/M14 依赖它）。
  if (keyPath === undefined) return ensureLoaded().merged;
  const v = effective(keyPath, {});
  return v.found ? v.value : fallback;
}

/**
 * 活配置对象（旧 `getConfig()` 的等价名）。**懒加载 + 永不抛**。
 * ⚠ 与 `snapshot()` 的分工：`getConfig()` 给的是**活对象**（改了会进状态），
 *   `snapshot()` 给的是**深拷贝**（改了不影响状态）。两者**不许互相顶替**。
 */
export function getConfig() {
  return get();
}

/**
 * 变更发布（订阅者用）。写失败不许抛给主流程。
 * ★ 重入保护（补做，对齐 src/config.js:1463-1467 的 `publishingConfigChange`）：
 *   监听器自己调 `updateConfig` 是允许的（那次写**照样生效**），
 *   但它**不许**再触发一轮 config-change 事件 —— 否则 A 改配置 → 通知 → A 又改 → 无限递归。
 *   src 那边是"嵌套写照样提交、只是不再发布"，这里逐字照搬该语义。
 */
let publishingConfigChange = false;
function publish(patch) {
  if (!listeners.size) return;
  if (publishingConfigChange) return;
  publishingConfigChange = true;
  try {
    for (const fn of [...listeners]) {
      try { fn(structuredClone(patch), getConfig()); } catch { /* 监听器抛错不许连累写配置的主链 */ }
    }
  } finally {
    publishingConfigChange = false;
  }
}

/** 订阅配置变更，返回退订函数（语义照搬 src/config.js:1444）。 */
export function subscribeConfigChange(handler) {
  if (typeof handler !== 'function') return () => {};
  listeners.add(handler);
  return () => listeners.delete(handler);
}

/**
 * 有效值 + 来源。优先级：**会话覆盖 > 全局 > 默认**。
 * ★ 值取**合并视图**（默认 + 全局），来源按 raw 判层 ——
 *   否则上层拿到的会是**半片对象**（例如 `get('api')` 只返回盘上写过的那几段），
 *   它会以为配置就这么点 —— 这正是「一律走 effective()」要防的事。
 * @returns {{value:any, source:'chat'|'private'|'global'|'default'|'missing', found:boolean}}
 */
export function effective(keyPath, { chatKey = '', kind = 'group' } = {}) {
  const s = ensureLoaded();
  const layers = resolveLayers(s.raw?.store, keyPath, { chatKey, kind });
  if (layers.hasChat) return { value: layers.chat, source: 'chat', found: true };
  if (layers.hasPrivate) return { value: layers.private, source: 'private', found: true };
  const inRaw = readPath(s.raw, keyPath) !== undefined
    || (keyPath === 'emotion.ignoreSenderIds' && readPath(s.raw, 'persona.ignoreSenderIds') !== undefined);
  const mergedValue = readPath(s.merged, keyPath);
  if (mergedValue !== undefined) return { value: mergedValue, source: inRaw ? 'global' : 'default', found: true };
  return { value: undefined, source: 'missing', found: false };
}

/** 只回来源：'chat'|'private'|'global'|'default'|'missing' —— UI 排障要用（README §3.2）。 */
export function sourceOf(keyPath, { chatKey = '', kind = 'group' } = {}) {
  return effective(keyPath, { chatKey, kind }).source;
}

/**
 * 写配置。**两种形态**（票面 §2③）：
 *   · `set(keyPath, value, {scope, chatKey})` —— 点路径，返回 `{keyPath, value, scope, chatKey}`（留痕用）
 *   · `set(patch)` —— **单参数纯对象**，深合并进活配置并**返回整份 config**（旧 `updateConfig` 的返回形状）
 * ★ 只改内存态；**落盘留给上层**（README 没冻结落盘接口，擅自落盘会踩铁律 1 的边界）。
 */
export function set(keyPath, value, options = {}) {
  const s = ensureLoaded();

  // ── 形态二：单参数对象 = 深合并整份（兼容旧 updateConfig 的调用形状）
  if (value === undefined && keyPath && typeof keyPath === 'object' && !Array.isArray(keyPath)) {
    return updateConfig(keyPath);
  }

  const { scope = 'global', chatKey = '' } = options;
  const segs = String(keyPath).split('.');
  const root = segs[0];
  if (scope === 'chat') {
    if (root !== 'store') throw new Error(`会话覆盖只支持 store 子树（收到 ${keyPath}）—— 现网也只有 store 有会话层`);
    if (!chatKey) throw new Error('scope=chat 必须给 chatKey');
    if (!s.raw.store || typeof s.raw.store !== 'object') s.raw.store = {};
    if (!s.raw.store.perChat || typeof s.raw.store.perChat !== 'object') s.raw.store.perChat = {};
    if (!s.raw.store.perChat[chatKey] || typeof s.raw.store.perChat[chatKey] !== 'object') s.raw.store.perChat[chatKey] = {};
    let cur = s.raw.store.perChat[chatKey];
    for (let i = 1; i < segs.length - 1; i += 1) {
      if (!cur[segs[i]] || typeof cur[segs[i]] !== 'object') cur[segs[i]] = {};
      cur = cur[segs[i]];
    }
    cur[segs[segs.length - 1]] = value;
  } else {
    let cur = s.raw;
    for (let i = 0; i < segs.length - 1; i += 1) {
      if (!cur[segs[i]] || typeof cur[segs[i]] !== 'object') cur[segs[i]] = {};
      cur = cur[segs[i]];
    }
    cur[segs[segs.length - 1]] = value;
  }
  s.changed.add(keyPath);
  // 档位随滑条位置派生（群/私聊/perChat 一把过，见 deriveTierFields）。
  deriveTierFields(s.raw);
  // 合并视图是**派生缓存** ⇒ 写完必须失效重算，否则刚写的值读不到（这正是"合并只发生在一处"的代价）。
  s.merged = mergeConfig(s.defaults, s.raw);
  publish({ [keyPath]: value });
  // TODO(M2): wire log()
  return { keyPath, value, scope, chatKey: scope === 'chat' ? chatKey : null };
}

/**
 * 更新并持久化配置（深合并到当前值，保留 patch 里没传的键）——
 * 语义照搬 src/config.js 的 `updateConfig`，**返回整份 config**（消费者 skill-bridge 依赖它做浅合并）。
 * ★ 本模块**不落盘**（README 没冻结落盘接口）；落盘由上层决定。
 */
export function updateConfig(patch) {
  const s = ensureLoaded();
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('updateConfig(patch) 需要一个纯对象');
  }
  // 合并只发生在一处（不变量）：先用 deepMerge 作用到 raw，再重算合并视图。
  s.raw = deepMerge(s.raw, patch);
  // 老树 updateConfig 的两道"写时收口"（src/config.js:1524 / 1531-1543）：别名关键词 + 档位派生。
  ensureBotAliasKeywords(s.raw);
  deriveTierFields(s.raw);
  s.merged = mergeConfig(s.defaults, s.raw);
  for (const keyPath of collectPaths(patch)) s.changed.add(keyPath);
  publish(patch);
  // TODO(M2): wire log()
  return s.merged;
}

/** 把 patch 的叶子键路径摊平（照搬 src/config.js 的 collectTouchedPaths 口径，用于留痕）。 */
function collectPaths(value, prefix = '', out = []) {
  for (const [key, v] of Object.entries(value || {})) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) out.push(p);
    else if (v && typeof v === 'object' && !Array.isArray(v)) collectPaths(v, p, out);
    else out.push(p);
  }
  return out;
}

/** 只读快照（给 trace / UI）：深拷贝，调用方改不到内部状态。与 getConfig() 的活对象**不许互相顶替**。 */
export function snapshot() {
  const s = ensureLoaded();
  return structuredClone({
    dataDir: s.dataDir,
    config: mergeConfig(s.defaults, s.raw),
    raw: s.raw,
    changed: [...s.changed]
  });
}

/**
 * 当前实例会写到哪个文件（UI / 日志展示用；**不等于"文件一定存在"**）。
 */
export function configFilePath() {
  const s = ensureLoaded();
  return path.join(s.dataDir, 'config.json');
}

/**
 * 落盘：把**迁移后的 raw** 原子写到 `<dataDir>/config.json`（tmp + rename，语义照搬 `src/config.js:1551-1554`）。
 *
 * 三处**故意**与老树不同（都写进回执，别当没发生）：
 *   ① 写的是 `raw`（用户真正设过的键），不再把整份默认值烤进用户文件；
 *   ② 覆盖前把上一份复制成 `config.json.bak`（老树没有这一步，坏写就没退路）；
 *   ③ rename **之前**自检 `JSON.parse` 能过 —— fail-closed（铁律：读坏/写坏不许当成功）。
 *
 * ★ 失败**抛错**：不动盘上旧文件，也不把失败的持久化更新留在内存态。
 * ★ 读盘失败过（配置可能损坏）时**拒绝保存**，除非显式 `{force:true}`
 *   —— 否则"读不动 → 退回默认值 → 存回去"等于把用户配置洗成默认值（`memes.js` 踩过同一个坑）。
 *
 * @param {{backup?:boolean, force?:boolean, log?:Function}} [opts]
 *   `log` 是注入的日志出口（M2 未落地前不许 import observability；调用方传 `log(level, code, data)`）
 * @returns {{file:string, bytes:number, changed:string[], backedUp:boolean}}
 */
export function saveConfig({ backup = true, force = false, log = null } = {}) {
  const s = ensureLoaded();
  if (typeof s.dataDir !== 'string' || s.dataDir === '') {
    throw new Error('saveConfig: 没有 dataDir —— 不许隐式落盘');
  }
  const file = path.join(s.dataDir, 'config.json');
  if (s.loadFailed && force !== true) {
    throw new Error(`saveConfig: 之前读 ${file} 失败过（可能损坏），拒绝用现在这份内存配置覆盖它；先人工核对，确要覆盖就传 {force:true}`);
  }

  const payload = structuredClone(s.raw);
  ensureBotAliasKeywords(payload);
  deriveTierFields(payload);
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  JSON.parse(text); // 自检：写出去的必须仍是可解析 JSON

  fs.mkdirSync(s.dataDir, { recursive: true });
  let backedUp = false;
  if (backup && fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.bak`);
      backedUp = true;
    } catch (error) {
      throw new Error(`saveConfig: 备份上一份配置失败（${file}.bak）：${error?.message ?? error} —— 未写入`);
    }
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  const changed = [...s.changed];
  s.changed.clear();
  // force 表示用户已确认覆盖此前读坏的配置；此后当前内存态已有一份有效盘上副本。
  s.loadFailed = false;
  const bytes = Buffer.byteLength(text);
  // 日志不是持久化事务的一部分：日志出口异常不能把已经 rename 成功的保存伪报成失败。
  if (typeof log === 'function') {
    try { log('info', 'config-saved', { file, bytes, changed, backedUp }); } catch { /* 保存已提交 */ }
  }
  return { file, bytes, changed, backedUp };
}

/** 暂存候选状态，成功落盘后才发布；失败时完整恢复旧内存态。 */
function saveCandidate(s, candidate, opts, eventPatch) {
  const previous = { raw: s.raw, merged: s.merged, changed: s.changed, loadFailed: s.loadFailed };
  s.raw = candidate.raw;
  s.merged = candidate.merged;
  s.changed = candidate.changed;
  let saved;
  try {
    saved = saveConfig(opts);
  } catch (error) {
    s.raw = previous.raw;
    s.merged = previous.merged;
    s.changed = previous.changed;
    s.loadFailed = previous.loadFailed;
    throw error;
  }
  publish(eventPatch);
  return { ...saved, config: s.merged };
}

/**
 * 改配置 + **立刻落盘**（UI 的 `POST /api/config`、skill 开关这类"用户点了就要生效并留存"的路径走这里）。
 * ★ 先写候选值，落盘成功后才更新内存并通知订阅者；保存失败时旧配置继续生效且错误抛给调用方。
 * @param {object} patch 深合并补丁（= updateConfig 的入参）
 * @param {{backup?:boolean, force?:boolean, log?:Function}} [opts]
 * @returns {{file:string, bytes:number, changed:string[], backedUp:boolean, config:object}}
 */
export function updateConfigAndSave(patch, opts = {}) {
  const s = ensureLoaded();
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('updateConfig(patch) 需要一个纯对象');
  }
  const raw = deepMerge(s.raw, patch);
  ensureBotAliasKeywords(raw);
  deriveTierFields(raw);
  const merged = mergeConfig(s.defaults, raw);
  const changed = new Set(s.changed);
  for (const keyPath of collectPaths(patch)) changed.add(keyPath);
  return saveCandidate(s, { raw, merged, changed }, opts, patch);
}

/**
 * 点路径写 + **立刻落盘**（`set()` 的持久化版本）。
 * @param {string} keyPath
 * @param {*} value
 * @param {{scope?:'global'|'chat', chatKey?:string} & {backup?:boolean, force?:boolean, log?:Function}} [options]
 * @returns {{file:string, bytes:number, changed:string[], backedUp:boolean, set:object}}
 */
export function setAndSave(keyPath, value, options = {}) {
  const { backup = true, force = false, log = null, ...setOpts } = options;
  const s = ensureLoaded();
  const { scope = 'global', chatKey = '' } = setOpts;
  const pathKey = String(keyPath);
  const segs = pathKey.split('.');
  const root = segs[0];
  const raw = structuredClone(s.raw);
  if (scope === 'chat') {
    if (root !== 'store') throw new Error(`会话覆盖只支持 store 子树（收到 ${keyPath}）—— 现网也只有 store 有会话层`);
    if (!chatKey) throw new Error('scope=chat 必须给 chatKey');
    if (!raw.store || typeof raw.store !== 'object') raw.store = {};
    if (!raw.store.perChat || typeof raw.store.perChat !== 'object') raw.store.perChat = {};
    if (!raw.store.perChat[chatKey] || typeof raw.store.perChat[chatKey] !== 'object') raw.store.perChat[chatKey] = {};
    let cur = raw.store.perChat[chatKey];
    for (let i = 1; i < segs.length - 1; i += 1) {
      if (!cur[segs[i]] || typeof cur[segs[i]] !== 'object') cur[segs[i]] = {};
      cur = cur[segs[i]];
    }
    cur[segs[segs.length - 1]] = value;
  } else {
    let cur = raw;
    for (let i = 0; i < segs.length - 1; i += 1) {
      if (!cur[segs[i]] || typeof cur[segs[i]] !== 'object') cur[segs[i]] = {};
      cur = cur[segs[i]];
    }
    cur[segs[segs.length - 1]] = value;
  }
  deriveTierFields(raw);
  const merged = mergeConfig(s.defaults, raw);
  const changed = new Set(s.changed);
  changed.add(pathKey);
  const persisted = saveCandidate(s, { raw, merged, changed }, { backup, force, log }, { [pathKey]: value });
  return { file: persisted.file, bytes: persisted.bytes, changed: persisted.changed,
    backedUp: persisted.backedUp, set: { keyPath, value, scope, chatKey: scope === 'chat' ? chatKey : null } };
}

/** 只读出口：迁移函数逐条导出，便于对照表逐条验（也便于上层做"迁移预览"）。 */
export { migrateLocalJev, migrateSendPacing, migrateCacheDefaults, migrateCostGuardTokenMax, ensureBotAliasKeywords, hasStoreField };
