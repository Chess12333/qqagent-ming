/**
 * refactor/apps/server/paths.js — 路径语义对齐
 *
 * 旧世界 APP_ROOT = 仓库根（electron/..）。新树 refactor/ 独立后，
 * 各资源落位由本模块统一给出，装配层只从这里取路径。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** apps/server/ → refactor/ 根 */
export const REFACTOR_ROOT = path.resolve(__dirname, '..', '..');
/** refactor/ → 仓库根 */
export const REPO_ROOT = path.resolve(REFACTOR_ROOT, '..');

/** 静态目录：refactor/apps/ui/（M13 已搬） */
export const UI_ROOT = path.join(REFACTOR_ROOT, 'apps', 'ui');

/**
 * 桌宠皮肤：**内置根**。refactor/apps/desktop/pet-skins/（迁移时已把 electron/pet-skins/qq-agent-default
 * 连同 6.5MB 资源搬到这里）。旧树对应 `electron/pet-skins/`（electron/main.js:200）。
 */
export const PET_SKINS_ROOT = path.join(REFACTOR_ROOT, 'apps', 'desktop', 'pet-skins');

/**
 * 桌宠皮肤：**用户根**。`<仓库根>/pet-skins/`（**不搬** —— 用户把自己的皮肤包丢这里，现在盘上就有
 * `example-soft/`）。旧树对应 `path.join(APP_ROOT,'pet-skins')`，而那里 APP_ROOT = electron/.. = **仓库根**
 * （electron/main.js:49,201）。
 *
 * ★ 2026-10-05 指挥位：为什么必须由本模块给出这个常量 —— 同一个表达式 `path.resolve(__dirname,'..')`
 *   在旧树（`electron/` → 仓库根）与迁移后的 `refactor/apps/desktop/`（→ `refactor/apps/`）**含义变了**，
 *   于是 `refactor/apps/desktop/main.js` 的 user 根静默指向 **不存在的** `refactor/apps/pet-skins/`
 *   ⇒ 桌宠只剩内置皮肤、用户皮肤全看不见，而两边代码逐行读起来一模一样（迁移陷阱，不是笔误）。
 *   皮肤的两个根 = 本模块 + `apps/desktop/main.js` **必须同源**；谁改都要两边一起改（验收见
 *   `.tmp-dispatch/r-指挥位-petskins-roots.md`）。
 */
export const PET_SKINS_USER_ROOT = path.join(REPO_ROOT, 'pet-skins');

/**
 * 扩展根目录：旧仓库的 skills/ 与 plugins/（不搬，继续用旧目录）。
 * 装配层传给 loadPlugins({ roots }) 时用这两个。
 */
export const SKILLS_ROOT = path.join(REPO_ROOT, 'skills');
export const PLUGINS_ROOT = path.join(REPO_ROOT, 'plugins');

/**
 * 解析数据目录 —— **必须显式给**，绝不默认落到仓库 data/。
 * 生产数据目录硬闸：若解析出的路径等于仓库根 data/ 或 data-2/，
 * 除非显式传 allowProductionData: true，否则启动就抛。
 * @param {string|undefined} dataDir - 显式注入的数据目录
 * @param {object} [opts]
 * @param {boolean} [opts.allowProductionData=false] - 显式允许生产数据目录
 * @returns {string} 绝对路径
 * @throws {Error} dataDir 未提供 / 生产路径未授权时抛出（fail-closed）
 */
export function resolveDataDir(dataDir, { allowProductionData = false } = {}) {
  if (dataDir === undefined || dataDir === null || String(dataDir).trim() === '') {
    throw new Error(
      '[apps/server] dataDir 必须显式注入，不许默认落到仓库 data/ 或 <cwd>/data。'
      + ' 用法：createServer({ dataDir: "…", … })。'
      + ' 理由：线上实例随时可能正在用 data/，新旧两套都能写 = 两个决定权。'
    );
  }
  const resolved = path.resolve(String(dataDir));
  // 生产数据目录硬闸
  const prodDirs = [path.join(REPO_ROOT, 'data'), path.join(REPO_ROOT, 'data-2')];
  if (!allowProductionData && prodDirs.includes(resolved)) {
    throw new Error(
      `[apps/server] dataDir 指向生产数据目录 (${resolved}) —— 线上实例可能正在用它，拒绝启动。`
      + ' 用 QQ_AGENT_DATA_DIR 指向临时目录，或显式传 allowProductionData: true（自担风险）。'
    );
  }
  return resolved;
}

/**
 * 给 plugin-loader 的 roots 参数（§3.5 要求）。
 * 必须显式传，否则 plugin-loader 的 APP_ROOT 会指向 refactor/modules/（错）。
 */
export function extensionRoots() {
  return { skills: SKILLS_ROOT, plugins: PLUGINS_ROOT };
}
