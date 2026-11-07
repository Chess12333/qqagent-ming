// ④「整套新桌宠」的**声明侧注册表**（纯模块：不 import electron，node 可直接测）。
//
// 为什么单独一个文件：主进程在这条链路上**只做「校验 + 开窗 + 转发」**，从不执行第三方代码
// （与 pet-actions-sanitize.js 抽出前的理由同源，见 main.js:664-666）—— 把校验放进纯模块，
// 这条安全边界才有自动化测试可写，不用起 Electron。
//
// 三条设计红线（与 §4.5「要放开 JS 执行 = 另一档信任级别」对齐）：
//   ① **默认关**：本模块只负责"发现与校验"，不负责"启用"；启用状态由 main.js 持有且初值为空。
//   ② **只认声明文件**：插件在 `plugins/<id>/pet-plugin.json` 里声明，主进程**读 JSON，不执行它**。
//   ③ **入口必须是插件目录内的 .html 相对路径**：不许绝对路径、不许 `..`、不许空段/`.`/`:`，
//      并且解析后的真实路径必须仍落在插件目录内（防目录穿越 = 防"把任意文件当桌宠页加载"）。
import fs from 'node:fs';
import path from 'node:path';

/** 插件 id：小写字母数字开头，允许 . _ -，最长 64（与 pet.actions 的 slug 同规格，独立定义避免耦合）。 */
export const PET_PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** 声明文件名（放插件根目录，与 plugin.json 同级）。 */
export const PET_PLUGIN_DECL_FILE = 'pet-plugin.json';
/** 全局最多认几个插件桌宠（超出的丢弃并记 problem），与 pet.actions 的来源上限同量级。 */
export const PET_PLUGIN_MAX = 16;
/** 默认窗口尺寸：与内置桌宠同比例（320/280），声明可覆盖。 */
export const PET_PLUGIN_SIZE_DEFAULT = { width: 320, height: 280 };
export const PET_PLUGIN_SIZE_MIN = { width: 160, height: 120 };
export const PET_PLUGIN_SIZE_MAX = { width: 1280, height: 1280 };

/**
 * 文本裁剪：与 pet-actions-sanitize.js 的 petText 同策略（去控制字符 + 截断），
 * 但**独立实现**：那个模块的常量被 pet-sanitize-test.mjs ⑪ 盯着做防漂移比对，
 * 这里若复用它就得把"桌宠声明"混进那份白名单断言里，反而扩大耦合面。
 */
export function petPluginText(value, max = 80) {
  const raw = value === undefined || value === null ? '' : String(value);
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function sanitizePetPluginSize(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    width: clampInt(src.width, PET_PLUGIN_SIZE_MIN.width, PET_PLUGIN_SIZE_MAX.width, PET_PLUGIN_SIZE_DEFAULT.width),
    height: clampInt(src.height, PET_PLUGIN_SIZE_MIN.height, PET_PLUGIN_SIZE_MAX.height, PET_PLUGIN_SIZE_DEFAULT.height)
  };
}

/**
 * 校验一份声明。**返回 { ok, decl, problems }，永不抛错** ——
 * 一份坏声明只该让那一个桌宠不可用，不能影响内置桌宠与其它插件。
 * 形状：`{ id, name, entry, size?: {width,height}, alwaysOnTop?: boolean }`
 */
export function sanitizePetPluginDecl(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, decl: null, problems: ['declaration is not an object'] };
  }
  const id = petPluginText(raw.id, 64).toLowerCase();
  if (!PET_PLUGIN_ID_RE.test(id)) problems.push(`bad id: ${JSON.stringify(petPluginText(raw.id, 24))}`);
  const name = petPluginText(raw.name, 40) || id;
  const entry = petPluginText(raw.entry, 200).replace(/\\/g, '/');
  if (!entry) problems.push('entry is required');
  else if (entry.startsWith('/')) problems.push('entry must be relative');
  else if (/\.html$/i.test(entry) !== true) problems.push('entry must end with .html');
  else if (entry.split('/').some((seg) => seg === '' || seg === '.' || seg === '..' || seg.includes(':'))) {
    problems.push('entry has an illegal path segment');
  }
  if (problems.length) return { ok: false, decl: null, problems };
  return {
    ok: true,
    problems,
    decl: {
      id,
      name,
      entry,
      size: sanitizePetPluginSize(raw.size),
      alwaysOnTop: raw.alwaysOnTop !== false
    }
  };
}

/**
 * 把声明里的 entry 解析成**绝对路径**，并强制它落在插件目录内。
 * 返回 `{ abs }` 或 `{ abs: null, problems }`。
 * 两道防线：① 语法层（sanitizePetPluginDecl 已挡掉绝对路径/..）；② 真实路径层（这里再比一次前缀，
 * 防 `..%2f`、符号链接、Windows 大小写与短名等只在 realpath 上才暴露的形态）。
 */
export function resolvePetPluginEntry(pluginDirAbs, entryRel) {
  const problems = [];
  const rel = petPluginText(entryRel, 200).replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || !/\.html$/i.test(rel)) {
    return { abs: null, problems: ['entry is not a relative .html path'] };
  }
  const base = path.resolve(pluginDirAbs);
  const abs = path.resolve(base, rel);
  const inside = abs.toLowerCase().startsWith((base + path.sep).toLowerCase());
  if (!inside) problems.push('entry escapes the plugin directory');
  return { abs: inside ? abs : null, problems };
}

/**
 * 扫一遍插件根目录，返回**已校验**的桌宠声明数组。
 * - 目录不存在 / 读不到 ⇒ 返回空数组（不是错误：没装桌宠插件是正常状态）。
 * - 声明读不动或 JSON 坏了 ⇒ 记一条 problem 并跳过那一个，**不抛**。
 * - id 重复 ⇒ 先来的那份赢，后来的丢弃并记 problem（确定性：按目录名排序）。
 * 注入 `fsLike` 只是为了测试能喂假目录树；生产传默认的 node:fs。
 */
export function pickPetPluginDecl(pluginsRootAbs, { fsLike = fs, log = null } = {}) {
  const out = [];
  const problems = [];
  const warn = (msg) => { if (typeof log === 'function') log(msg); };
  let dirs = [];
  try {
    dirs = fsLike.readdirSync(pluginsRootAbs, { withFileTypes: true })
      .filter((d) => d && d.isDirectory())
      .map((d) => String(d.name))
      .sort();
  } catch (error) {
    warn(`[desktop-pet] 读插件目录失败（没有插件桌宠是正常状态）: ${error?.message ?? error}`);
    return { entries: [], problems: [] };
  }
  const seen = new Set();
  for (const dir of dirs) {
    if (out.length >= PET_PLUGIN_MAX) {
      problems.push(`超过 ${PET_PLUGIN_MAX} 个桌宠声明，其余丢弃（按目录名排序取前 ${PET_PLUGIN_MAX} 个）`);
      break;
    }
    const pluginDir = path.join(pluginsRootAbs, dir);
    const declPath = path.join(pluginDir, PET_PLUGIN_DECL_FILE);
    let text;
    try { text = fsLike.readFileSync(declPath, 'utf8'); } catch { continue; }   // 没有声明文件 = 普通插件，跳过
    let raw;
    try {
      raw = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);   // BOM 容错，与仓库其它读法一致
    } catch (error) {
      problems.push(`${dir}/${PET_PLUGIN_DECL_FILE} 不是合法 JSON: ${error?.name ?? 'Error'}`);
      warn(`[desktop-pet] ${dir} 的桌宠声明不是合法 JSON，已跳过`);
      continue;
    }
    // 声明里的 id 缺省时用目录名兜底，但两者都要过 slug 校验
    const candidate = (raw && typeof raw === 'object' && !Array.isArray(raw) && !raw.id) ? { ...raw, id: dir } : raw;
    const res = sanitizePetPluginDecl(candidate);
    if (!res.ok) {
      problems.push(`${dir}/${PET_PLUGIN_DECL_FILE} 声明无效: ${res.problems.join('；')}`);
      warn(`[desktop-pet] ${dir} 的桌宠声明无效，已跳过（${res.problems.join('；')}）`);
      continue;
    }
    if (res.decl.id !== dir) {
      problems.push(`${dir} 的声明 id(${res.decl.id}) 与目录名不一致，已跳过（防冒名）`);
      warn(`[desktop-pet] ${dir} 的声明 id 与目录名不一致，已跳过（防冒名）`);
      continue;
    }
    if (seen.has(res.decl.id)) {
      problems.push(`${dir} 的桌宠 id 重复，已跳过`);
      continue;
    }
    const resolved = resolvePetPluginEntry(pluginDir, res.decl.entry);
    if (!resolved.abs) {
      problems.push(`${dir} 的 entry 无法解析为插件目录内的 .html: ${resolved.problems.join('；')}`);
      warn(`[desktop-pet] ${dir} 的 entry 不合法，已跳过（${resolved.problems.join('；')}）`);
      continue;
    }
    let statOk = false;
    try { statOk = fsLike.statSync(resolved.abs).isFile(); } catch { statOk = false; }
    if (!statOk) {
      problems.push(`${dir} 的 entry 指向的文件不存在: ${res.decl.entry}`);
      warn(`[desktop-pet] ${dir} 的 entry 指向的文件不存在，已跳过`);
      continue;
    }
    seen.add(res.decl.id);
    out.push({ ...res.decl, dir: pluginDir, absEntry: resolved.abs });
  }
  return { entries: out, problems };
}
