/**
 * refactor/modules/pet-skins —— 桌宠皮肤注册表（服务端侧；`GET /api/pet-skins` 的数据源）
 *
 * 搬运来源：`src/pet-skins/registry.js`（435 行）+ `src/pet-skins/manifest.js`（428 行，
 * 已同目录照搬为 `./manifest.js`）。
 *
 * ★★ 2026-10-10 N52 对账：此前的 113 行版本**不是**旧树的搬运，是一份"看着像"的简化重写，
 *   把旧树刻意建起来的几道东西全丢了（逐条差异见回执 §C）：
 *   ① **对外不携带绝对路径**（旧 :68-72 契约 + :272-276 `toPublicSummary`）—— 旧版把
 *      `dir: path.resolve(...)` 直接放进 skin 返回给 `GET /api/pet-skins` ⇒ 泄露文件系统布局；
 *      而且 `...meta` 摊在**最后** ⇒ 皮肤包自己的 skin.json 能覆盖 `id` / `dir`（同 id 冒名、路径注入）。
 *   ② **manifest 校验**（旧 `manifest.js` 整块）—— 旧版只要 `skin.json` 能 `JSON.parse` 就收录，
 *      `format` / `version` / `renderer` / 必需状态 idle|working / 资源路径白名单 / 各类上限**一条都不查**。
 *   ③ **fs 级安全兜底**（旧 :81-119 / :138-188）—— 没有 realpath 越界复查、没有 lstat"普通文件"、
 *      没有 256 KiB manifest 上限、没有单资源 8 MiB / 整包 64 MiB、没有"目录名必须等于 manifest.id"、
 *      没有保留 id `default` 跳过、没有每根 64 包上限、没有"id 先见者保留"（内置包可被用户根同名包替换）。
 *   ④ **problems 形状**：旧版 `{type,label,id,dir,detail}`，旧树是 `{rootLabel,dir,id,problem}`
 *      —— 控制台 `apps/ui/app.js:14268` 逐字读 `.problem` / `.rootLabel` / `.dir` ⇒ 皮肤坏了**一条提示都不出**。
 *   ⑤ **内置回退**：旧树 `list()` 首位恒为 `BUILTIN_SKIN_SUMMARY`（旧 :36-46 / :317），旧版没有 ⇒
 *      第三方皮肤全被拒时，前端拿不到"回退到内置旧图"这一项。
 *   现在按旧树逐条补齐。
 *
 * ★ 与旧树的**唯一**实现差异（其余判据/文案/形状逐条照搬）：旧树用 `fs.promises`（异步），这里同步。
 *   原因：消费方 `apps/server/api/media.js:503/520` 是 `new SkinRegistry({roots})` + `petSkinsView(registry)`
 *   **同步**取视图；改成异步要动 `apps/**`（不是本轮我的域）。同步不放松任何一道闸，只是不换执行外壳。
 *   ⚠ **没有**搬 `resolveResourcePath`（旧 :352-421，返回**已打开的 FileHandle** + etag，锚定同一 inode 防 TOCTOU）：
 *     同步版本做不到"句柄移交"（只能返回路径 ⇒ 校验与读取之间留下可被替换的窗口），而服务端这条路由
 *     现在由 `api/media.js:563-578` 自己实现（realpath 越界 + skin.json 存在 + 图像类型白名单 + 8 MiB）。
 *     ⇒ 这里**不给一个"看着像旧树、实际弱一档"的安全原语**；差异如实上报，由指挥位决定是路由改走注册表
 *     还是保持自建。（渲染侧的完整异步版在 `apps/desktop/pet-skins/registry.js`，本模块不反向依赖 apps/**。）
 * ★ 短 TTL：旧树把这个闭包放在 `src/app.js:213-222`（`ensurePetSkinsFresh(3000)`，列表用 0 = 每次重扫，
 *   图片路由用 3s TTL）。新树没有那一层 ⇒ 收进注册表内部，默认值同为 3000ms，`list()` 仍每次重扫（旧口径）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeSkinManifest,
  extractResourcePaths,
  validatePackageRelativePath,
  LIMITS,
  SKIN_FORMAT
} from './manifest.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（`refactor/modules/pet-skins` 上溯三级）—— 旧树 `src/config.js:10` 的 `ROOT` 等价物。 */
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..', '..');

/**
 * 默认扫描根：<仓库根>/pet-skins/（**用户根**）。
 * 旧树写 `new URL('../../pet-skins/')`（从 `src/pet-skins/` 出发正好落在仓库根）；
 * 本模块深度差一级 ⇒ 必须是 `../../../`。`apps/desktop/pet-skins/registry.js:26-33` 记的
 * 是同一个"深度漂移"坑，别再按旧字面抄。
 */
export const DEFAULT_SKIN_ROOT = fileURLToPath(new URL('../../../pet-skins/', import.meta.url));

/** 内置回退皮肤 id：专指"内置旧图 fallback"，由核心渲染器用应用自带旧图兜底。 */
export const BUILTIN_SKIN_ID = 'default';

const MANIFEST_FILE = 'skin.json';
const MANIFEST_MAX_BYTES = 256 * 1024;
const MAX_PACKAGES_PER_ROOT = 64;
const DEFAULT_TTL_MS = 3000;   // 旧 src/app.js:215 ensurePetSkinsFresh(3000)

/** 内置 default 皮肤的对外档案：第三方皮肤不可用/被拒时回退到此。旧 :36-46。 */
export const BUILTIN_SKIN_SUMMARY = Object.freeze({
  id: BUILTIN_SKIN_ID,
  name: '默认桌宠（内置旧图 fallback）',
  author: '',
  description: '内置旧图 fallback：应用自带旧图资源渲染，第三方皮肤不可用/被拒时回退到此',
  renderer: 'builtin',
  version: SKIN_FORMAT,
  builtin: true,
  source: { root: 'builtin', dir: BUILTIN_SKIN_ID },
  problems: []
});

/** roots 归一化：接受字符串数组或 { label, dir } 数组，返回统一结构。旧 :49-61。 */
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
 * 读取并校验一个皮肤包目录。旧 :74-210（逐条照搬，fs 调用换成同步）。
 * @param {{ rootLabel: string, rootDir: string, packageDir: string }} pkg
 *   packageDir 是 rootDir 下的一级目录名（只允许单段安全目录名），且必须与 manifest.id 完全一致，
 *   否则整包拒绝。
 * @returns {{ ok: boolean, skin?: object, problem?: string, absDir?: string,
 *             rootDir?: string, declaredResources?: Set<string> }}
 *   skin 内不含任何绝对路径；absDir / rootDir / declaredResources 由调用方内部保存，
 *   绝不出现在对外响应里。
 */
export function readSkinPackage({ rootLabel, rootDir, packageDir }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(packageDir) || packageDir === '.' || packageDir === '..') {
    return { ok: false, problem: `皮肤包目录名非法：${packageDir}` };
  }
  const absDir = path.resolve(rootDir, packageDir);
  const manifestPath = path.join(absDir, MANIFEST_FILE);

  // 本函数是导出 API，不能依赖扫描器先过滤 symlink 目录：realpath 复核包目录本身必须位于 rootDir 内。
  let rootReal = path.resolve(rootDir);
  try { rootReal = fs.realpathSync(rootDir); } catch { /* 根目录缺失时由下方 lstat 报"缺少 skin.json" */ }
  let pkgReal = absDir;
  try { pkgReal = fs.realpathSync(absDir); } catch { /* 包目录异常时由下方 lstat/realpath 兜住 */ }
  if (pkgReal !== rootReal && !pkgReal.startsWith(rootReal + path.sep)) {
    return { ok: false, problem: `皮肤包目录越界（"${packageDir}" 经 realpath 定位到 rootDir 之外），已拒绝` };
  }

  // lstat 不跟随符号链接：skin.json 必须是包内普通文件，防 symlink 指向包外 JSON
  let lst;
  try {
    lst = fs.lstatSync(manifestPath);
  } catch {
    return { ok: false, problem: `缺少 ${MANIFEST_FILE}` };
  }
  if (lst.isSymbolicLink() || !lst.isFile()) {
    return { ok: false, problem: `${MANIFEST_FILE} 必须是包内普通文件（禁止符号链接/目录等非常规文件）` };
  }
  if (lst.size > MANIFEST_MAX_BYTES) {
    return { ok: false, problem: `${MANIFEST_FILE} 超过 ${MANIFEST_MAX_BYTES} 字节上限` };
  }

  // realpath 复核 manifest 本体未逃出包目录；后续读取使用已验证的 canonical 路径
  let realManifest = null;
  try {
    realManifest = fs.realpathSync(manifestPath);
  } catch {
    return { ok: false, problem: `${MANIFEST_FILE} 不可读` };
  }
  if (realManifest !== pkgReal && !realManifest.startsWith(pkgReal + path.sep)) {
    return { ok: false, problem: `${MANIFEST_FILE} 越界（符号链接指向包外）` };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(realManifest, 'utf8'));
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
      realRes = fs.realpathSync(absRes);
    } catch {
      resourceProblems.push(`资源 "${check.path}" 不存在`);
      continue;
    }
    if (realRes !== pkgReal && !realRes.startsWith(pkgReal + path.sep)) {
      resourceProblems.push(`资源 "${check.path}" 越界（符号链接指向包外），已拒绝`);
      continue;
    }
    let st = null;
    try {
      st = fs.statSync(realRes);
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
      problems
    },
    absDir,
    rootDir,
    declaredResources: validResources
  };
}

/**
 * 扫描多个根目录下的全部皮肤包。旧 :220-269。
 * @returns {{ skins: object[], problems: object[] }}
 *   skins —— 合法包档案（不含绝对路径，按 root 顺序、目录名排序；同 id 先到先得，重复包不入列）
 *   problems —— 逐包/逐根问题：{ rootLabel, dir?, id?, problem }
 */
export function scanSkins({ roots } = {}) {
  const skins = [];
  const problems = [];
  // 先到先得：roots 按 builtin → user 排序，先见者保留，重复包记 problem 并跳过，
  // 兜底链不可被用户根同名包替换（旧 :223）
  const seenIds = new Map();

  for (const root of normalizeRoots(roots)) {
    let entries;
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
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
      const result = readSkinPackage({ rootLabel: root.label, rootDir: root.dir, packageDir: dir });
      if (!result.ok) {
        problems.push({ rootLabel: root.label, dir, problem: result.problem || '未知错误' });
        continue;
      }
      const { skin, absDir, rootDir, declaredResources } = result;
      if (seenIds.has(skin.id)) {
        problems.push({
          rootLabel: root.label, dir, id: skin.id,
          problem: `id "${skin.id}" 与 ${seenIds.get(skin.id)} 重复，先见者保留，本包已跳过`
        });
        continue;
      }
      seenIds.set(skin.id, `${root.label}/${dir}`);
      skins.push(skin);
      skin.__absDir = absDir;                     // 内部定位用；对外输出前由 toPublicSummary 剥离
      skin.__rootDir = rootDir;                   // 每次调用重新校验包目录未逃出 root
      skin.__declaredResources = declaredResources;  // 白名单：仅 skin.json 声明且过检的资源
    }
  }
  return { skins, problems };
}

/** 剥离内部字段，得到可序列化、无绝对路径的档案。旧 :272-276。 */
export function toPublicSummary(skin) {
  if (!skin) return null;
  const { __absDir, __rootDir, __declaredResources, ...rest } = skin;
  return rest;
}

/**
 * 皮肤注册表：id → 皮肤。refresh() 重新扫描；list/get 面向渲染端与设置路由。
 * 内部保存绝对定位（absDir），对外一律走 toPublicSummary。旧 :282-433。
 */
export class SkinRegistry {
  /**
   * @param {{ roots?: Array<string|{label:string,dir:string}>, builtin?: boolean, ttlMs?: number }} [options]
   *   builtin —— 是否在 list/get 中始终暴露内置 default 回退（默认 true）
   */
  constructor({ roots, builtin = true, ttlMs } = {}) {
    this.roots = normalizeRoots(roots);
    this.builtin = builtin;
    this.ttlMs = Number.isFinite(Number(ttlMs)) && Number(ttlMs) >= 0 ? Number(ttlMs) : DEFAULT_TTL_MS;
    /** id -> { skin, absDir, rootDir, resources }（skin 无绝对路径；其余仅供内部定位） */
    this.entries = new Map();
    this.lastProblems = [];
    this._scannedAt = 0;
  }

  /** 重新扫描并整体替换注册内容。返回 { added, replaced, problems }。旧 :296-312。 */
  refresh() {
    const previousIds = new Set(this.entries.keys());
    const { skins, problems } = scanSkins({ roots: this.roots });
    this.entries.clear();
    for (const skin of skins) {
      this.entries.set(skin.id, {
        skin,
        absDir: skin.__absDir,
        rootDir: skin.__rootDir,
        resources: skin.__declaredResources instanceof Set ? skin.__declaredResources : new Set()
      });
    }
    this.lastProblems = problems;
    this._scannedAt = Date.now();
    const added = [...this.entries.keys()].filter((id) => !previousIds.has(id));
    const replaced = [...previousIds].filter((id) => this.entries.has(id));
    return { added, replaced, problems };
  }

  /** 短 TTL 重扫（旧 src/app.js:215-222 的 ensurePetSkinsFresh；maxAgeMs=0 ⇒ 强制重扫）。 */
  _ensureFresh(maxAgeMs = this.ttlMs) {
    if (this._scannedAt && Date.now() - this._scannedAt < maxAgeMs) return;
    this.refresh();
  }

  /** 按注册顺序返回可展示档案（内置 default 保持在首位）。旧 :315-320。 */
  list() {
    // 旧树设置页口径：listPetSkins() = ensurePetSkinsFresh(0) ⇒ 每次打开都重扫（频率低，可接受）
    this._ensureFresh(0);
    const out = [];
    if (this.builtin) out.push(BUILTIN_SKIN_SUMMARY);
    for (const { skin } of this.entries.values()) out.push(toPublicSummary(skin));
    return out;
  }

  /** 取皮肤档案；内置 default 返回 BUILTIN_SKIN_SUMMARY。旧 :323-328。 */
  get(id) {
    // 旧树图片路由口径：ensurePetSkinsFresh() 用 3s TTL，避免每张图都全量扫盘
    this._ensureFresh(this.ttlMs);
    const key = String(id ?? '');
    if (key === BUILTIN_SKIN_ID) return this.builtin ? BUILTIN_SKIN_SUMMARY : null;
    const entry = this.entries.get(key);
    return entry ? toPublicSummary(entry.skin) : null;
  }

  has(id) {
    return this.get(String(id ?? '')) !== null;
  }

  /** 该皮肤"skin.json 声明且过检"的资源相对路径白名单（内部定位用，不外泄绝对路径）。 */
  resources(id) {
    const entry = this.entries.get(String(id ?? ''));
    return entry ? new Set(entry.resources) : new Set();
  }

  get size() {
    return this.entries.size;
  }

  clear() {
    const ids = [...this.entries.keys()];
    this.entries.clear();
    this.lastProblems = [];
    this._scannedAt = 0;
    return ids;
  }
}

/**
 * 构造注册表。roots 顺序与旧树 `src/app.js:205-209` 一致：内置包 → 用户手放目录。
 *
 * ★ 缺省根**从模块自身位置反推**（`REPO_ROOT`），不再回落 `process.cwd()` ——
 *   cwd 不是仓库根时会扫不到目录、返回 `{skins:[],problems:[]}` 的 **200 空表**（假绿比 501 更毒，
 *   `apps/server/assembly.js:178-181` 记的就是这一条）。显式传 `repoRoot` 的调用方行为不变。
 */
export function createSkinRegistry({ repoRoot, builtin = true, ttlMs } = {}) {
  const root = String(repoRoot || '').trim() || REPO_ROOT;
  return new SkinRegistry({
    roots: [
      { label: 'builtin', dir: path.join(root, 'electron', 'pet-skins') },
      { label: 'user', dir: path.join(root, 'pet-skins') }
    ],
    builtin,
    ttlMs
  });
}

/** GET /api/pet-skins 的响应形状（旧 src/app.js:1600-1607）：`{ skins, problems }`，无 ok/source。 */
export function petSkinsView(registry) {
  const skins = registry.list();
  return { skins, problems: Array.isArray(registry.lastProblems) ? registry.lastProblems : [] };
}

export { LIMITS, SKIN_FORMAT };
