// 桌宠皮肤注册表：扫描皮肤根目录 → 逐包校验 → 注册（id → 皮肤）。
//
// 职责拆分（与 src/skills 的分工一致）：
//   manifest.js —— 纯数据规范化/校验，不碰文件系统
//   registry.js —— 文件系统扫描 + fs 级安全兜底（资源存在性、符号链接
//                  越界）+ id 索引。给 Electron 主进程与应用设置路由复用，
//                  因此 roots 可注入；对外响应**不携带绝对路径**，只有
//                  { rootLabel, dir } 这种可展示的来源标识。
//
// 容错口径：任何单个包/单个根目录出问题都只产生逐包 problems，
// 不抛出、不中断扫描；查不到任何合法包时调用方回退内置 default 皮肤。

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  normalizeSkinManifest,
  extractResourcePaths,
  validatePackageRelativePath,
  LIMITS,
  SKIN_FORMAT,
} from './manifest.js';
import { PET_SKINS_USER_ROOT as PET_SKINS_USER_ROOT_FROM_PATHS } from '../../server/paths.js';

/**
 * 默认扫描根：<仓库根>/pet-skins/（**用户根**）。
 *
 * ★ 2026-10-05（T-DESKTOP-SKINROOT）修同族语义漂移：
 *   旧写法 `fileURLToPath(new URL('../../pet-skins/', import.meta.url))` 在旧树 src/pet-skins/ 下
 *   正好解析到 <repo>/pet-skins（用户根 ✅）；搬到这个深度后解析成 refactor/apps/pet-skins（不存在 ❌）。
 *   与 main.js 的 PET_SKIN_ROOTS 是同一个坑的第二处现场，两边读起来都像"显然对"。
 *   ⇒ 现在直接取 apps/server/paths.js 的 PET_SKINS_USER_ROOT，与服务端设置页列表、桌面渲染同源。
 *   builtin 根不在这里：它是应用自带的 pet-skins/，由 roots.js 的 PET_SKIN_ROOTS 显式列出。
 */
export const DEFAULT_SKIN_ROOT = PET_SKINS_USER_ROOT_FROM_PATHS;

/** 内置回退皮肤 id：专指"内置旧图 fallback"，由核心渲染器用应用自带旧图兜底。 */
export const BUILTIN_SKIN_ID = 'default';

const MANIFEST_FILE = 'skin.json';
const MANIFEST_MAX_BYTES = 256 * 1024;
const MAX_PACKAGES_PER_ROOT = 64;

/** 内置 default 皮肤的对外档案：专指"内置旧图 fallback"（应用自带旧图资源；
 *  后续主任务将另加新的内置 SVG 角色作为默认呈现，default 语义不变）。 */
export const BUILTIN_SKIN_SUMMARY = Object.freeze({
  id: BUILTIN_SKIN_ID,
  name: '默认桌宠（内置旧图 fallback）',
  author: '',
  description: '内置旧图 fallback：应用自带旧图资源渲染，第三方皮肤不可用/被拒时回退到此',
  renderer: 'builtin',
  version: SKIN_FORMAT,
  builtin: true,
  source: { root: 'builtin', dir: BUILTIN_SKIN_ID },
  problems: [],
});

/** roots 归一化：接受字符串数组或 { label, dir } 数组，返回统一结构。 */
export function normalizeRoots(roots) {
  const list = roots === undefined || roots === null ? [DEFAULT_SKIN_ROOT] : roots;
  const arr = Array.isArray(list) ? list : [list];
  return arr
    .map((item) => {
      if (typeof item === 'string') return { label: path.basename(item) || 'skin-root', dir: item };
      if (item && typeof item === 'object' && typeof item.dir === 'string') {
        return { label: String(item.label || path.basename(item.dir) || 'skin-root'), dir: item.dir };
      }
      return null;
    })
    .filter(Boolean);
}

/**
 * 读取并校验一个皮肤包目录。
 * @param {{ rootLabel: string, rootDir: string, packageDir: string }} pkg
 *   packageDir 是 rootDir 下的一级目录名（只允许单段安全目录名），且必须
 *   与 manifest.id 完全一致，否则整包拒绝。
 * @returns {{ ok: boolean, skin?: object, problem?: string, absDir?: string,
 *             rootDir?: string, declaredResources?: Set<string> }}
 *   skin 内不含任何绝对路径；absDir / rootDir / declaredResources 由调用方
 *   内部保存，用于核心读文件与 resolve 白名单及每次调用时的越界复查，
 *   绝不出现在对外响应里。
 */
export async function readSkinPackage({ rootLabel, rootDir, packageDir }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(packageDir) || packageDir === '.' || packageDir === '..') {
    return { ok: false, problem: `皮肤包目录名非法：${packageDir}` };
  }
  const absDir = path.resolve(rootDir, packageDir);
  const manifestPath = path.join(absDir, MANIFEST_FILE);

  // 本函数是导出 API，不能依赖扫描器先过滤 symlink 目录：
  // realpath 复核包目录本身必须位于 rootDir 内。
  let rootReal = path.resolve(rootDir);
  try {
    rootReal = await fs.realpath(rootDir);
  } catch { /* 根目录缺失时由下方 lstat 报"缺少 skin.json" */ }
  let pkgReal = absDir;
  try {
    pkgReal = await fs.realpath(absDir);
  } catch { /* 包目录异常时由下方 lstat/realpath 兜住 */ }
  if (pkgReal !== rootReal && !pkgReal.startsWith(rootReal + path.sep)) {
    return { ok: false, problem: `皮肤包目录越界（"${packageDir}" 经 realpath 定位到 rootDir 之外），已拒绝` };
  }

  // lstat 不跟随符号链接：skin.json 必须是包内普通文件，防 symlink 指向包外 JSON
  let lst;
  try {
    lst = await fs.lstat(manifestPath);
  } catch {
    return { ok: false, problem: `缺少 ${MANIFEST_FILE}` };
  }
  if (lst.isSymbolicLink() || !lst.isFile()) {
    return { ok: false, problem: `${MANIFEST_FILE} 必须是包内普通文件（禁止符号链接/目录等非常规文件）` };
  }
  if (lst.size > MANIFEST_MAX_BYTES) {
    return { ok: false, problem: `${MANIFEST_FILE} 超过 ${MANIFEST_MAX_BYTES} 字节上限` };
  }

  // realpath 复核 manifest 本体未逃出包目录（pkgReal 已在包目录越界检查段解析）；
  // 后续读取使用已验证的 realManifest（canonical 路径），不按原 symlink 可疑路径重开
  let realManifest = null;
  try {
    realManifest = await fs.realpath(manifestPath);
  } catch {
    return { ok: false, problem: `${MANIFEST_FILE} 不可读` };
  }
  if (realManifest !== pkgReal && !realManifest.startsWith(pkgReal + path.sep)) {
    return { ok: false, problem: `${MANIFEST_FILE} 越界（符号链接指向包外）` };
  }

  let raw;
  try {
    raw = JSON.parse(await fs.readFile(realManifest, 'utf8'));
  } catch (err) {
    return { ok: false, problem: `${MANIFEST_FILE} 解析失败：${err?.message || err}` };
  }

  const { manifest, problems } = normalizeSkinManifest(raw);
  if (!manifest) {
    return { ok: false, problem: problems.join('; ') || 'skin.json 判废' };
  }

  // 强规则：目录名必须与 manifest.id 一致，避免重复/误导路径
  if (manifest.id !== packageDir) {
    return { ok: false, problem: `目录名 "${packageDir}" 必须与 manifest.id "${manifest.id}" 完全一致` };
  }

  // ---- fs 级兜底：每个资源必须存在，且 realpath 不得逃出包目录 ----
  // （pkgReal 已在包目录越界检查段解析）

  const resources = extractResourcePaths(manifest);
  const resourceProblems = [];
  const validResources = new Set();
  let totalResourceBytes = 0;
  for (const rel of resources) {
    const check = validatePackageRelativePath(rel);
    if (!check.ok) { resourceProblems.push(`资源 "${rel}"：${check.problem}`); continue; }
    const absRes = path.resolve(absDir, check.path);
    let realRes = null;
    try {
      realRes = await fs.realpath(absRes);
    } catch {
      resourceProblems.push(`资源 "${check.path}" 不存在`);
      continue;
    }
    if (realRes !== pkgReal && !realRes.startsWith(pkgReal + path.sep)) {
      resourceProblems.push(`资源 "${check.path}" 越界（符号链接指向包外），已拒绝`);
      continue;
    }
    // 顺序执行：realpath 校验通过后再对 canonical 路径 stat
    let st = null;
    try {
      st = await fs.stat(realRes);
    } catch {
      resourceProblems.push(`资源 "${check.path}" 不存在`);
      continue;
    }
    if (!st.isFile()) {
      // 目录即使后缀是 .svg 也不能计为可用资源
      resourceProblems.push(`资源 "${check.path}" 不是常规文件（目录或其他），已拒绝`);
      continue;
    }
    if (st.size > LIMITS.resourceMaxBytes) {
      resourceProblems.push(`资源 "${check.path}" ${st.size} 字节，超过单资源 ${LIMITS.resourceMaxBytes} 字节上限，已拒绝`);
      continue;
    }
    totalResourceBytes += st.size;
    if (totalResourceBytes > LIMITS.packageResourcesMaxBytes) {
      return { ok: false, problem: `包内已声明资源合计 ${totalResourceBytes} 字节，超过 ${LIMITS.packageResourcesMaxBytes} 字节上限，整包拒绝` };
    }
    validResources.add(check.path);
  }
  problems.push(...resourceProblems);

  // 所有资源都缺 → 包不可用（有部分资源可用时仍可加载，渲染端按缺图兜底）
  if (resources.length && !validResources.size) {
    return { ok: false, problem: `包内无任何可用资源：${problems.join('; ')}` };
  }

  return {
    ok: true,
    skin: {
      id: manifest.id,
      name: manifest.name,
      author: manifest.author,
      description: manifest.description,
      renderer: manifest.renderer,
      version: manifest.version,
      format: SKIN_FORMAT,
      canvas: manifest.canvas,
      states: manifest.states,
      builtin: false,
      source: { root: rootLabel, dir: packageDir },
      problems,
    },
    absDir,
    rootDir,
    declaredResources: validResources,
  };
}

/**
 * 扫描多个根目录下的全部皮肤包。
 * @param {{ roots?: Array<string | {label: string, dir: string}> }} [options]
 * @returns {{ skins: object[], problems: object[] }}
 *   skins  —— 合法包档案数组（不含绝对路径，按 root 顺序、目录名排序；
 *             同 id 先到先得，前面的 root 优先，重复包不入列）
 *   problems —— 逐包/逐根问题：{ rootLabel, dir?, id?, problem }
 */
export async function scanSkins({ roots } = {}) {
  const skins = [];
  const problems = [];
  const seenIds = new Map(); // id -> 来源（先到先得：roots 按 builtin → user 排序，先见者保留，重复包记 problem 并跳过，绝不覆盖——兜底链不可被用户根同名包替换）

  for (const root of normalizeRoots(roots)) {
    let entries;
    try {
      entries = await fs.readdir(root.dir, { withFileTypes: true });
    } catch (err) {
      problems.push({ rootLabel: root.label, problem: `根目录不可读：${err?.code || err?.message || err}` });
      continue;
    }

    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    if (dirs.length > MAX_PACKAGES_PER_ROOT) {
      problems.push({ rootLabel: root.label, problem: `皮肤包超过 ${MAX_PACKAGES_PER_ROOT} 个，多余的已忽略` });
    }
    for (const dir of dirs.slice(0, MAX_PACKAGES_PER_ROOT)) {
      if (dir === BUILTIN_SKIN_ID) {
        problems.push({ rootLabel: root.label, dir, problem: `目录名 "${BUILTIN_SKIN_ID}" 为内置保留 id，已跳过` });
        continue;
      }
      const result = await readSkinPackage({ rootLabel: root.label, rootDir: root.dir, packageDir: dir });
      if (!result.ok) {
        problems.push({ rootLabel: root.label, dir, problem: result.problem || '未知错误' });
        continue;
      }
      const { skin, absDir, declaredResources } = result;
      if (seenIds.has(skin.id)) {
        // 先见者保留：内置 root（electron/pet-skins）在前，因此 qq-agent-default
        // 等内置包不可被用户根（ROOT/pet-skins）同名包替换
        problems.push({
          rootLabel: root.label, dir, id: skin.id,
          problem: `id "${skin.id}" 与 ${seenIds.get(skin.id)} 重复，先见者保留，本包已跳过`,
        });
        continue;
      }
      seenIds.set(skin.id, `${root.label}/${dir}`);
      skins.push(skin);
      skin.__absDir = absDir;                 // 内部定位用；对外输出前由 toPublicSummary 剥离
      skin.__rootDir = root.dir;              // resolve 每次调用时重新校验包目录未逃出 root
      skin.__declaredResources = declaredResources; // resolve 白名单：仅 skin.json 声明且过检的资源
    }
  }
  return { skins, problems };
}

/** 剥离内部字段，得到可序列化、无绝对路径的档案。 */
export function toPublicSummary(skin) {
  if (!skin) return null;
  const { __absDir, __rootDir, __declaredResources, ...rest } = skin;
  return rest;
}

/**
 * 皮肤注册表：id → 皮肤。refresh() 重新扫描；get/list 面向渲染端与设置路由。
 * 内部保存绝对定位（absDir），对外一律走 toPublicSummary。
 */
export class SkinRegistry {
  /**
   * @param {{ roots?: Array<string|{label:string,dir:string}>, builtin?: boolean }} [options]
   *   builtin —— 是否在 list/get 中始终暴露内置 default 回退（默认 true）
   */
  constructor({ roots, builtin = true } = {}) {
    this.roots = normalizeRoots(roots);
    this.builtin = builtin;
    /** id -> { skin, absDir, rootDir, resources }（skin 无绝对路径；absDir/rootDir/resources 仅供核心读文件、resolve 白名单与每次调用的越界复查） */
    this.entries = new Map();
    this.lastProblems = [];
  }

  /** 重新扫描并整体替换注册内容。返回 { added, replaced, problems }。 */
  async refresh() {
    const previousIds = new Set(this.entries.keys());
    const { skins, problems } = await scanSkins({ roots: this.roots });
    this.entries.clear();
    for (const skin of skins) {
      this.entries.set(skin.id, {
        skin,
        absDir: skin.__absDir,
        rootDir: skin.__rootDir,
        resources: skin.__declaredResources instanceof Set ? skin.__declaredResources : new Set(),
      });
    }
    this.lastProblems = problems;
    const added = [...this.entries.keys()].filter((id) => !previousIds.has(id));
    const replaced = [...previousIds].filter((id) => this.entries.has(id));
    return { added, replaced, problems };
  }

  /** 按注册顺序返回可展示档案（内置 default 保持在首位）。 */
  list() {
    const out = [];
    if (this.builtin) out.push(BUILTIN_SKIN_SUMMARY);
    for (const { skin } of this.entries.values()) out.push(toPublicSummary(skin));
    return out;
  }

  /** 取皮肤档案；内置 default 返回 BUILTIN_SKIN_SUMMARY。 */
  get(id) {
    const key = String(id ?? '');
    if (key === BUILTIN_SKIN_ID) return this.builtin ? BUILTIN_SKIN_SUMMARY : null;
    const entry = this.entries.get(key);
    return entry ? toPublicSummary(entry.skin) : null;
  }

  has(id) {
    return this.get(String(id ?? '')) !== null;
  }

  /**
   * 解析皮肤某资源的绝对路径（仅供核心渲染端读取文件，切勿进入 API 响应）。
   * 防线（每次调用全部重走，防"注册后目录被替换"的 TOCTOU）：
   *   1) 白名单：只允许 skin.json 声明且通过校验的图片资源，其他文件拒绝；
   *   2) 包目录 realpath 必须仍位于 rootDir 之内（本次验证的 pkgReal 作为
   *      后续所有 containment 的锚点，防 packageDir 被整体替换成包外 symlink）；
   *   3) 资源先 realpath，canonical 路径必须位于 pkgReal 之内；
   *   4) 顺序执行：open(canonical) 后在同一 FileHandle 上 fstat，校验
   *      isFile / size ≤ LIMITS.resourceMaxBytes / nlink ≤ 1（nlink>1 报
   *      "疑似硬链接"）——锚定同一 inode，杜绝 realpath 校验与读取之间
   *      被替换的窗口。
   * 成功时返回 realPath（canonical 路径，仅作展示/扩展名判断——读取必须经
   * 返回的 FileHandle）、size 与**已打开的 FileHandle**：
   * 调用方应从该句柄流式读取（HEAD/错误/完成/客户端断开时负责关闭）；
   * 本函数内 open 之后的全部拒绝/异常分支都已 await close 后才返回。
   * @returns {Promise<{ ok: boolean, realPath?: string,
   *                     size?: number, handle?: object, problem?: string }>}
   */
  async resolveResourcePath(skinId, relPath) {
    if (skinId === BUILTIN_SKIN_ID) return { ok: false, problem: '内置旧图 fallback 的资源由核心直接提供，不经由此方法' };
    const entry = this.entries.get(String(skinId ?? ''));
    if (!entry) return { ok: false, problem: `未知皮肤 id：${skinId}` };
    const check = validatePackageRelativePath(relPath);
    if (!check.ok) return { ok: false, problem: check.problem };
    if (!entry.resources.has(check.path)) {
      return { ok: false, problem: `资源 "${check.path}" 未在 skin.json 中声明` };
    }

    // 2) 包目录未逃出 rootDir（rootReal/pkgReal 每次实时解析）
    let rootReal = path.resolve(entry.rootDir);
    try {
      rootReal = await fs.realpath(entry.rootDir);
    } catch {
      return { ok: false, problem: '皮肤根目录不可达' };
    }
    let pkgReal = entry.absDir;
    try {
      pkgReal = await fs.realpath(entry.absDir);
    } catch {
      return { ok: false, problem: `皮肤包目录不可达（skinId=${entry.skin.id}）` };
    }
    if (pkgReal !== rootReal && !pkgReal.startsWith(rootReal + path.sep)) {
      return { ok: false, problem: `皮肤包目录越界（realpath 已不在 rootDir 内），已拒绝` };
    }

    // 3) 先 realpath：得到本次校验的 canonical 路径
    const absPath = path.resolve(entry.absDir, check.path);
    let realRes = null;
    try {
      realRes = await fs.realpath(absPath);
    } catch {
      return { ok: false, problem: `资源 "${check.path}" 不存在` };
    }
    if (realRes !== pkgReal && !realRes.startsWith(pkgReal + path.sep)) {
      return { ok: false, problem: `资源 "${check.path}" 越界（符号链接指向包外）` };
    }

    // 4) 顺序执行：open(canonical) 后在同一 FileHandle 上 fstat 校验
    //    isFile / size / nlink —— 同一 inode，校验即所读
    let handle = null;
    try {
      handle = await fs.open(realRes, 'r');
    } catch {
      return { ok: false, problem: `资源 "${check.path}" 打开失败` };
    }
    try {
      const st = await handle.stat();
      if (!st.isFile()) {
        await handle.close();
        return { ok: false, problem: `资源 "${check.path}" 不是常规文件（目录或其他），已拒绝` };
      }
      if (st.size > LIMITS.resourceMaxBytes) {
        await handle.close();
        return { ok: false, problem: `资源 "${check.path}" ${st.size} 字节，超过单资源 ${LIMITS.resourceMaxBytes} 字节上限，已拒绝` };
      }
      if (st.nlink > 1) {
        await handle.close();
        return { ok: false, problem: `资源 "${check.path}" 疑似硬链接（nlink=${st.nlink}），已拒绝` };
      }
      // 成功：句柄移交调用方流式读取，响应结束/中断时由调用方关闭。
      // 不返回扫描期旧 absPath——读取必须经 handle；realPath 仅作展示/扩展名判断
      const etag = `W/"${st.size}-${Math.round(st.mtimeMs * 1000)}-${Math.round(st.ctimeMs * 1000)}-${st.ino}"`;
      return { ok: true, realPath: realRes, size: st.size, etag, handle };
    } catch (err) {
      try { await handle.close(); } catch { /* 已关闭 */ }
      return { ok: false, problem: `资源 "${check.path}" 校验失败：${err?.code || err?.message || err}` };
    }
  }

  get size() {
    return this.entries.size;
  }

  clear() {
    const ids = [...this.entries.keys()];
    this.entries.clear();
    this.lastProblems = [];
    return ids;
  }
}

export { LIMITS, SKIN_FORMAT };
