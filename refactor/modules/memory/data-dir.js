/**
 * M6 memory · dataDir 解析（唯一一处）
 *
 * 铁律：**不读也不写真实 `data/**`**。本模块自己的存储一律用它解析出的目录。
 *
 * ── 解析顺序（**只认"显式意图"两种**；全都命中不了就抛错） ──────────────────
 *   ① 显式注入：`configure({dataDir})` / `setDataDir(dir)` / 每次调用传 `{dataDir}`
 *   ② 显式设了环境变量 `QQ_AGENT_DATA_DIR`（测试、影子运行、多实例用它表达"我知道我在指哪个目录"）
 *   ③ 都没有 → **抛错**（文案点名"必须显式注入 dataDir 或设 QQ_AGENT_DATA_DIR"）
 *
 * ── 为什么连 `core/config-store` 的 `snapshot()` / `DATA_DIR` 也**不许**当兜底 ──
 * （2026-10-04 复核后决定 · 事故复盘）
 *   实测链路：`core/config-store/index.js:276 snapshot()` 内部会 `ensureLoaded()`
 *   → `load({ dataDir: DATA_DIR })`，而 `DATA_DIR` 的缺省就是**仓库根 `data/`**（与 `src/` 一致）。
 *   ⇒ `snapshot()` **从不抛"还没 load 过"**，它给出的 `dataDir` 就是**生产目录**；
 *   ⇒ 只要保留这条回落路径，"出错时一律不放行"就是假的：本模块会在"没人显式授权"的情况下解析出生产目录
 *     并写进去（12:19 那次 `data/memory/audit.jsonl` 被追加一行，就是这条链击穿出来的）。
 *   ⇒ 所以"收紧"**不是等 M1 补 `DATA_DIR`**，而是**现在就把这两条兜底删掉**：
 *     **上游的懒加载永远会给回一个"看起来合法"的生产路径，它不能当作授权。**
 *   另：本文件**不再 import `core/config-store`**（连命名空间导入一起删）—— 免得任何一次间接
 *   `snapshot()` 调用把生产配置读一遍 / 触发它的懒加载。
 *
 * ★ 历史：这里一度留过 `// TODO(batch3): M1 补齐 DATA_DIR 后收紧为「显式注入优先」`；
 *   该 TODO 已在本轮兑现（就是上面这次删除），不再存在。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 进程内显式覆盖（null = 没被覆盖过）。 */
let overrideDir = null;

/** 显式指定数据目录。传 null/'' 表示撤销覆盖（撤销后只剩 env 或抛错）。 */
export function setDataDir(dir) {
  if (dir === null || dir === undefined || dir === '') {
    overrideDir = null;
    return null;
  }
  if (typeof dir !== 'string') throw new Error('setDataDir: dataDir 必须是字符串');
  overrideDir = path.resolve(dir);
  return overrideDir;
}

/** 当前覆盖值（无覆盖 → null）。测试用来断言"没在碰真实 data/"。 */
export function overriddenDataDir() {
  return overrideDir;
}

/** 环境变量里的显式意图（空串 → 视为没设）。 */
export function envDataDir() {
  const v = process.env.QQ_AGENT_DATA_DIR;
  return typeof v === 'string' && v.trim() ? path.resolve(v.trim()) : null;
}

/**
 * 解析出当前生效的数据目录（绝对路径）。
 * ★ 出错时一律不放行：**只接受显式注入**（调用参数 / setDataDir / QQ_AGENT_DATA_DIR）；都没有就**抛错**。
 *   不回落到 `<cwd>/data`，也不去问 `config-store`（它的懒加载会把生产目录喂回来）。
 */
export function getDataDir() {
  if (overrideDir) return overrideDir;
  const fromEnv = envDataDir();
  if (fromEnv) return fromEnv;
  throw new Error(
    'memory: 解析不出 dataDir —— 必须显式注入 dataDir 或设 QQ_AGENT_DATA_DIR；不许回落到 workspace 的 data/。',
  );
}

/** 本模块存储根：`<dataDir>/memory/`（与旧 `data/memory/audit.jsonl` 同一处，路径不变）。 */
export function memoryDir() {
  return path.join(getDataDir(), 'memory');
}

/** 取文件路径（不建目录）。 */
export function memoryFile(name) {
  return path.join(memoryDir(), name);
}

/** 确保 `<dataDir>/memory/` 存在（只在真要写的时候调用）。 */
export function ensureMemoryDir() {
  const dir = memoryDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
