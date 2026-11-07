// M12 extensions —— 插件/技能加载与桥接（唯一公开出口）
// ============================================================================
// 来源：`src/plugin-loader.js` + `src/skill-bridge.js` + `src/skills/**`（**逐字节搬运**，
// 只改 import 路径；见 selftest.mjs 的"搬运保真差异表"与 MANIFEST.json 的 sha256）。
//
// 本文件是**新写的出口**（src/ 里没有对应物），只做再导出，不含任何逻辑：
// 老代码从三个文件分别 import（如 `import { mergeSkillTools } from '../skill-bridge.js'`），
// 新树按 README §4「每个模块只暴露 index.js」合并到这里。
//
// 依赖方向（README §0.4 `apps → modules/* → core/* → contracts/`）：
//   · `../../core/config-store/index.js`  ← M1（load/get/effective/sourceOf/set/snapshot）
//   · 技能开关读写的落点见 skills/config.js 头部注释
//   · tool-registry 由 M10 act 承接（`../act/index.js`，五个函数名见回执「未决」）
//   · `yauzl` 是根 node_modules 的第三方包，位置无关，原样保留裸导入

// ── 加载器 / 热重载 / 卸载（原 plugin-loader.js）──────────────────────────────
// ★ 2026-10-09 N44：这四个入口在本文件里**包了一层 roots 缺省值**，不是纯再导出。
//   原因是一次迁移陷阱（与 apps/server/paths.js:26-38 记的 PET_SKINS 那次同一个病）：
//     plugin-loader.js:40 `APP_ROOT = resolve(dirname(import.meta.url), '..')`
//       · 老树：文件在 `src/`          ⇒ APP_ROOT = **仓库根** ⇒ 缺省扫 `<仓库根>/skills`、`/plugins`（真实目录）
//       · 新树：文件在 `refactor/modules/extensions/` ⇒ APP_ROOT = `refactor/modules/`
//         ⇒ 缺省扫 `refactor/modules/skills`、`refactor/modules/plugins` —— **两个都不存在**
//   两边代码逐字相同，含义却变了。后果不是"少加载几个技能"，而是**卸光**：
//   `loadPlugins` 末尾会按"本轮加载成功的 id"对账，把不在册的全部 `pruneMissing`
//   （plugin-loader.js:1013-1018）⇒ 拿缺省 roots 调一次 = 把已加载的技能全部卸掉、
//   工具从 act 注册表里消失。`apps/server/api/shell.js:259-262` 已经把这个坑写在注释里，
//   并靠"每个调用点自己记得传 roots"来躲 —— 但 :245（导入 zip 后重新 initExtensions）就漏了。
//   ⇒ 缺省值在**出口这一层**修回老树的有效语义（仓库根 skills/ 与 plugins/），
//     这样任何调用点忘了传 roots 都不会再触发误卸；显式传 roots 仍然优先，env 次之，
//     与 skill-bridge.js:21 `resolveExtensionRoots` 的优先级完全一致。
//   ⚠ plugin-loader.js / skill-bridge.js 本身**一行没动**：它们受本目录 selftest 的
//     搬运保真闸门管（只许差 import 路径、登记过的符号别名与注释），改逻辑行会直接判红。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadPlugins as loaderLoadPlugins,
  watchPlugins as loaderWatchPlugins,
  unloadSkill,
  setExtensionSender,
  SKILL_DIRS as LOADER_SKILL_DIRS
} from './plugin-loader.js';

export { unloadSkill, setExtensionSender };

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..', '..');

const nonEmpty = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const envRoot = (name) => nonEmpty(process.env[name]);

/** 调用时求值：env 可以在模块加载之后才设（自检、脚本、容器入口都这样）。 */
function hostRoots() {
  return {
    skills: envRoot('QQ_AGENT_SKILLS_DIR') || path.join(REPO_ROOT, 'skills'),
    plugins: envRoot('QQ_AGENT_PLUGINS_DIR') || path.join(REPO_ROOT, 'plugins')
  };
}

/** 显式 roots > env > 仓库根缺省。允许只给一半（另一半回落缺省），与老树有效行为一致。 */
function resolveRoots(explicit) {
  const base = hostRoots();
  return {
    skills: nonEmpty(explicit?.skills) || base.skills,
    plugins: nonEmpty(explicit?.plugins) || base.plugins
  };
}

/**
 * 宿主看到的扩展根目录。**已修正**为老树的有效缺省（仓库根 `skills/` 与 `plugins/`）。
 * ⚠ 与 `plugin-loader.js:1093` 导出的同名常量**不是同一个值**：那个仍是模块级 APP_ROOT
 *   推导出来的 `refactor/modules/skills`（不存在）。宿主一律用本出口，别用里面那个。
 */
export const SKILL_DIRS = hostRoots();

/** 诊断用：loader 自己那份（错误的）缺省值，方便一眼看出两者差在哪。 */
export const LOADER_DEFAULT_SKILL_DIRS = LOADER_SKILL_DIRS;

export async function loadPlugins(options = {}) {
  return loaderLoadPlugins({ ...options, roots: resolveRoots(options.roots) });
}

export function watchPlugins(options = {}) {
  return loaderWatchPlugins({ ...options, roots: resolveRoots(options.roots) });
}

// ── 扩展底座桥接（原 skill-bridge.js）────────────────────────────────────────
export {
  skillManager,
  setExtensionEnabled,
  mergeSkillTools,
  hookBeforeContext,
  hookBeforeLlmMessages,
  hookAfterResponse,
  hookBeforeTool,
  hookAfterTool,
  listExtensionStatus,
  getExtensionPromptSections
} from './skill-bridge.js';

import {
  initExtensions as bridgeInitExtensions,
  startExtensionWatch as bridgeStartExtensionWatch
} from './skill-bridge.js';

/** 启动入口（老树 `src/app.js:675`）：扫目录 + **逐个 activate 已启用的技能**。 */
export async function initExtensions(options = {}) {
  return bridgeInitExtensions({ ...options, roots: resolveRoots(options.roots) });
}

/** 热重载监听（老树 `src/app.js:678`）。 */
export async function startExtensionWatch(options = {}) {
  return bridgeStartExtensionWatch({ ...options, roots: resolveRoots(options.roots) });
}

/** 只读诊断：缺省 roots 到底存不存在。宿主启动时可以把这行打进日志，别等"技能全没了"再查。 */
export function extensionRootsStatus() {
  const roots = hostRoots();
  return {
    roots,
    skillsExists: fs.existsSync(roots.skills),
    pluginsExists: fs.existsSync(roots.plugins),
    loaderDefaults: LOADER_SKILL_DIRS,
    loaderDefaultsExist: fs.existsSync(LOADER_SKILL_DIRS.skills) || fs.existsSync(LOADER_SKILL_DIRS.plugins)
  };
}

// ── 技能清单安装（原 skills/zip-import.js；src/ 里没有别的出口）───────────────
export { importExtensionZip } from './skills/zip-import.js';

// ── 注册表 / 能力表：M10 act 与 apps 的装配面 ────────────────────────────────
// 说明：`skills/registry.js` 与 `skills/capabilities.js` 在 src/ 里是被
// `tool-registry.js`（将来 M10）与 routes/UI 直接 import 的。新树里 M10 只能
// `import { … } from '../extensions/index.js'`（README §4：不许 import 别人的内部文件），
// 因此这两个类必须从出口再导出，否则 M10 的"工具可用性唯一口径"没有实现来源。
export { SkillRegistry } from './skills/registry.js';
export { CapabilityRegistry } from './skills/capabilities.js';
export { SKILL_ERROR, SkillError, skillErrorText } from './skills/errors.js';
export { SKILL_API_VERSION, DIR_KIND, KIND_LABEL, kindOfDir, normalizeManifest, isManifestUsable } from './skills/manifest.js';

// ── 技能配置读写（原 skills/config.js）──────────────────────────────────────
// 一次性导出全部（含 setSkillEnabled / listConfiguredSkillIds）：这些函数在 src/ 里
// 是 UI/路由（将来 M13 apps）读写技能开关的入口，少导一个就要跨模块摸内部文件。
export {
  getSkillConfig,
  isSkillEnabledInConfig,
  setSkillConfig,
  setSkillEnabled,
  listConfiguredSkillIds
} from './skills/config.js';
