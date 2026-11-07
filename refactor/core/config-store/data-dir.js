// 数据目录解析（config-store 内部共用）
// ★ 为什么单独一个文件：`index.js` 与 `instance-lock.js` 都要用「同一套 dataDir 解析」，
//   放一起会成环（index 要 re-export 实例锁）⇒ 抽成无依赖的小模块。
// ★ 语义逐字照搬 src/config.js:42-43：`QQ_AGENT_DATA_DIR` 优先；否则按 PROFILE_ID 落 data / data-<profile>。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE_ID } from './defaults.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 缺省数据目录（env 优先）。冻结名 `DATA_DIR` 就是它。 */
export const DEFAULT_DATA_DIR = process.env.QQ_AGENT_DATA_DIR
  || path.join(ROOT, PROFILE_ID ? `data-${PROFILE_ID}` : 'data');

let loaded = null;
/** `load({dataDir})` 成功后登记 ⇒ 实例锁等"按文件工作"的模块与配置**读同一个目录**。 */
export function setLoadedDataDir(dir) { loaded = dir || null; }
/** 当前生效的数据目录：load 过就用 load 的那份，否则用缺省。**不在模块加载期做任何盘上动作**。 */
export function resolveDataDir() { return loaded || DEFAULT_DATA_DIR; }