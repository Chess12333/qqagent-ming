// themes —— 控制台自定义主题：内置预设 + themes/ 目录导入。
//
// 逐字搬自 `src/themes.js`（313 行，2026-10-05 T-THEMES-PORT）。**模块只导出能力，不碰 HTTP**
// （旧树的 5 条路由在 `src/app.js:2048-2110`，现在由 `apps/server/api/shell.js` 调本模块实现）。
//
// ── 与旧实现的差异只有三处，其余算法/路径安全逐字照搬 ────────────────────────
// ① `THEMES_DIR` 的来源：旧树是模块级常量 `path.join(ROOT, 'themes')`（ROOT = 仓库根，
//    `src/config.js:10`）。新树**不 import** `apps/server/paths.js`（那是应用层，模块不该反向依赖），
//    改成**自解析 + 可注入**：显式 `configure({themesDir})` > 环境变量 `QQ_AGENT_THEMES_DIR`
//    > 默认 `refactor/modules/themes/../../..` 即**仓库根/themes**（与旧树同一位置，一个字没挪）。
//    **口径与 memory/data-dir.js 一致：调用期解析、fail-closed、不猜生产目录。**
// ② 旧树从 `./config.js` import 的 `isThemeCssColor` 在新树**没有对应出口**，照搬进来
//    （`src/config.js:11-33`，含颜色名表 / hex / 数字 / var() / 颜色函数四类判定）。
// ③ 旧树的 `importTheme` 用模块级 `THEMES_DIR`；这里改用调用期解析出来的同一个目录。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from '../../core/util/index.js';   // 原子落盘（tmp+rename，失败删 tmp 并重抛）

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（`refactor/modules/themes` 上溯三级）—— 旧树 `ROOT`（`src/config.js:10`）的等价物。 */
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..', '..');
const DEFAULT_THEMES_DIR = path.join(REPO_ROOT, 'themes');

/** 显式注入的目录（configure 优先，其次环境变量，都没有 ⇒ 回落默认）。 */
let injectedThemesDir = '';

export function configure({ themesDir = '', log = null } = {}) {
  injectedThemesDir = typeof themesDir === 'string' ? themesDir.trim() : '';
  return { themesDir: resolveThemesDir(), log: typeof log === 'function' };
}

/**
 * 主题目录（调用期解析 —— 注入 / 环境变量 / 仓库根默认，与旧树 `THEMES_DIR` 同一位置）。
 * 导出它是为了让自测/排障能断言"没在碰生产 themes/"。
 */
export function resolveThemesDir() {
  const env = String(process.env.QQ_AGENT_THEMES_DIR || '').trim();
  return injectedThemesDir || env || DEFAULT_THEMES_DIR;
}

/** 内置预设（机甲风等），始终可用，不依赖磁盘。 */
export const BUILTIN_THEMES = [
  {
    id: 'mech-orange',
    name: '机甲 · 黑橙',
    builtin: true,
    description: '近黑机甲底 + 琥珀橙强调（参考 Armoury Crate）',
    colors: {
      bg: '#0c0c0e',
      bg2: '#151517',
      bg3: '#222224',
      accent: '#f5a623',
      toolAccent: '#ff7a00',
      text: '#f4f4f5',
      muted: '#a8a8ad',
      faint: '#6e6e73'
    }
  },
  {
    id: 'deepseek-maid',
    name: 'DeepSeek 娘',
    builtin: true,
    description: '深蓝 + 鎏金 + 宫廷壁纸',
    colors: {
      bg: '#101c2e',
      bg2: '#16243a',
      bg3: '#1e3048',
      accent: '#4d8fc9',
      toolAccent: '#d4b56a',
      text: '#e8eef6',
      muted: '#9aafc4',
      faint: '#6d8199'
    }
  },
  {
    id: 'bijingyu-pixel',
    name: '白京玉 · 像素夜',
    builtin: true,
    description: '精致像素雨夜咖啡馆：暖夜蓝 + 灯火琥珀 + 奶油字（壁纸 bijingyu-bg.png）',
    colors: {
      bg: '#1a2438',
      bg2: '#24344f',
      bg3: '#2e4260',
      accent: '#e0a85c',
      toolAccent: '#9bb8d4',
      text: '#f0ebe2',
      muted: '#a8b4c4',
      faint: '#6e7c90'
    }
  },
  {
    id: 'classic-purple',
    name: '经典 · 紫',
    builtin: true,
    description: '原自定义起点：暗紫底 + 紫强调',
    colors: {
      bg: '#12101a',
      bg2: '#1c1930',
      bg3: '#262244',
      accent: '#8b5cf6',
      toolAccent: '#f59e0b',
      text: '#f3f0ff'
    }
  }
];

const COLOR_KEYS = ['bg', 'bg2', 'bg3', 'accent', 'toolAccent', 'text', 'muted', 'faint'];
const THEME_COLOR_UI_KEYS = Object.freeze({ bg3: 'customBg3', muted: 'customMuted', faint: 'customFaint' });
const WALLPAPER_MIME_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

// ── isThemeCssColor：照搬 src/config.js:11-33（新树原本没有这个出口）──────────
const THEME_CSS_COLOR_NAMES = new Set('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgrey darkgreen darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray grey green greenyellow honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgrey lightgreen lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent currentcolor'.split(/\s+/));
const THEME_CSS_COLOR_HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const THEME_CSS_COLOR_NUMBER = /^(?:none|[-+]?(?:\d+\.?\d*|\.\d+)(?:%|deg|rad|grad|turn)?)$/i;

export function isThemeCssColor(value) {
  if (typeof value !== 'string') return false;
  const color = value.trim();
  if (!color) return false;
  if (THEME_CSS_COLOR_HEX.test(color) || THEME_CSS_COLOR_NAMES.has(color.toLowerCase())) return true;
  if (/^var\(--[a-z0-9_-]+\)$/i.test(color)) return true;
  const fn = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\((.*)\)$/i.exec(color);
  if (fn) {
    const parts = fn[2].trim().split(/[\s,\/]+/).filter(Boolean);
    return parts.length >= 3 && parts.length <= 4 && parts.every((part) => THEME_CSS_COLOR_NUMBER.test(part));
  }
  const colorFn = /^color\(\s*([a-z0-9-]+)\s+(.+)\)$/i.exec(color);
  if (colorFn) {
    const spaces = new Set(['srgb', 'srgb-linear', 'display-p3', 'a98-rgb', 'prophoto-rgb', 'rec2020', 'xyz', 'xyz-d50', 'xyz-d65']);
    const parts = colorFn[2].trim().split(/[\s\/]+/).filter(Boolean);
    return spaces.has(colorFn[1].toLowerCase()) && parts.length >= 3 && parts.length <= 4
      && parts.every((part) => THEME_CSS_COLOR_NUMBER.test(part));
  }
  return false;
}

function normKey(k) {
  return String(k || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
}
function toCamel(key) {
  const k = normKey(key);
  if (k === 'tool-accent' || k === 'toolaccent') return 'toolAccent';
  return k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
function pickColor(val) {
  const color = String(val ?? '').trim();
  return isThemeCssColor(color) ? color : '';
}
function requireColor(value, key) {
  const color = pickColor(value);
  if (!color) throw new Error('Invalid CSS color value for theme key: ' + key);
  return color;
}
export function normalizeThemeImageName(value) {
  const name = String(value ?? '').trim();
  if (!name) return '';
  // ★ 白名单只有 png/jpg/webp，**故意不放开 .jpeg** —— 这是对 `src/themes.js:99`
  //   （`/\.(?:png|jpg|webp)$/i`）的**逐字照搬**，不是漏抄。
  //   2026-10-05 指挥位已核旧树并裁定：**裂缝在 UI 侧**（`ui/app.js` 的 `jpe?g` 写法更宽），
  //   由 UI 向服务端对齐，**服务端不放宽**。改这里等于单方面改变旧树语义。
  if (name.length > 255 || /[\\/:*?"<>|%\x00-\x1f]/.test(name) || path.basename(name) !== name || !/\.(?:png|jpg|webp)$/i.test(name)) {
    throw new Error('Invalid theme image filename');
  }
  return name;
}

export function themeColorsToUiPatch(colors) {
  const c = colors && typeof colors === 'object' ? colors : {};
  const patch = {
    customBg: c.bg || '',
    customBg2: c.bg2 || '',
    customAccent: c.accent || '',
    customText: c.text || '',
    customToolAccent: c.toolAccent || c.accent || ''
  };
  for (const [key, value] of Object.entries(c)) {
    if (!isThemeCssColor(value)) throw new Error('Invalid CSS color value for theme key: ' + key);
    if (!COLOR_KEYS.includes(toCamel(key))) setThemeEntry(patch, key, value);
  }
  for (const colorKey of ['bg3', 'muted', 'faint']) {
    const uiKey = THEME_COLOR_UI_KEYS[colorKey];
    if (Object.prototype.hasOwnProperty.call(c, colorKey)) patch[uiKey] = c[colorKey] || '';
  }
  return patch;
}

export function buildThemeUiConfig(currentUi, theme) {
  return { ...(currentUi || {}), ...themeColorsToUiPatch(theme.colors), theme: 'custom', customThemeId: theme.id };
}

export function buildThemeImportPayload(theme) {
  const payload = { format: 'qq-agent-theme', version: 1, id: theme.id, name: theme.name, colors: theme.colors };
  for (const [key, value] of Object.entries(theme || {})) {
    if (['id', 'name', 'colors', 'builtin', 'file'].includes(key)) continue;
    setThemeEntry(payload, key, key === 'image' ? normalizeThemeImageName(value) : value);
  }
  return payload;
}
function resolveThemeAssetRequest(themeDir, raw, { label, mimeTypes, normalizeName }) {
  const rawName = String(raw ?? '').trim();
  if (!rawName) return { status: 400, error: label + ' id is required' };
  let filename;
  try { filename = normalizeName(rawName); } catch { return { status: 400, error: 'Invalid ' + label.toLowerCase() + ' id' }; }
  const mimeType = mimeTypes[path.extname(filename).toLowerCase()];
  if (!mimeType) return { status: 400, error: 'Invalid ' + label.toLowerCase() + ' id' };
  const root = path.resolve(themeDir);
  const candidate = path.resolve(root, filename);
  const rel = path.relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    return { status: 400, error: label + ' path is outside themes directory' };
  }
  try {
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(candidate);
    const realRel = path.relative(realRoot, realFile);
    if (!realRel || realRel === '..' || realRel.startsWith('..' + path.sep) || path.isAbsolute(realRel)) {
      return { status: 400, error: label + ' path is outside themes directory' };
    }
    if (!fs.statSync(realFile).isFile()) return { status: 404, error: label + ' not found' };
    return { status: 200, path: realFile, mimeType };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { status: 404, error: label + ' not found' };
    return { status: 500, error: 'Unable to read ' + label.toLowerCase() };
  }
}

export function resolveThemeWallpaperRequest(themeDir, id) {
  return resolveThemeAssetRequest(themeDir, id, {
    label: 'Wallpaper',
    mimeTypes: WALLPAPER_MIME_TYPES,
    normalizeName: normalizeThemeImageName
  });
}

function normalizeThemeCssFilename(value) {
  const id = String(value ?? '').trim();
  if (!id || id.length > 48 || !/^[a-z0-9_-]+$/i.test(id)) throw new Error('Invalid theme CSS id');
  return id + '.css';
}

export function resolveThemeCssRequest(themeDir, id) {
  return resolveThemeAssetRequest(themeDir, id, {
    label: 'Theme CSS',
    mimeTypes: { '.css': 'text/css' },
    normalizeName: normalizeThemeCssFilename
  });
}

export function isThemeCssValueCandidate(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return s.startsWith('#') || /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|var)\(/.test(s);
}

function setThemeEntry(target, key, value) { Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true }); }

function canonicalThemeColorKey(key) {
  const canonical = toCamel(key);
  return COLOR_KEYS.includes(canonical) ? canonical : key;
}

function parseThemeColor(colors, key, value) {
  const colorKey = canonicalThemeColorKey(key);
  setThemeEntry(colors, colorKey, requireColor(value, key));
}
/** 解析 JSON 或 key=value / key: value 文本 → 统一主题对象。 */
export function parseThemeText(raw, fallbackName = '') {
  const text = String(raw || '').replace(/^﻿/, '');
  if (!text.trim()) throw new Error('Theme file is empty');
  const colors = {};
  let id = '';
  let name = fallbackName || '';
  const extra = {};
  const t = text.trim();
  if (t.startsWith('{')) {
    let obj;
    try { obj = JSON.parse(t); } catch (e) { throw new Error('Invalid theme JSON: ' + (e?.message || e)); }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Theme JSON must be an object');
    const hasColors = obj.colors && typeof obj.colors === 'object' && !Array.isArray(obj.colors);
    if (hasColors) {
      for (const [key, value] of Object.entries(obj.colors)) parseThemeColor(colors, key, value);
    } else {
      for (const [key, value] of Object.entries(obj)) {
        if (['id', 'name', 'title', 'colors', 'uiStyle', 'ui-style', 'image', 'description', 'format', 'version'].includes(key)) continue;
        if (COLOR_KEYS.includes(toCamel(key)) || isThemeCssColor(value) || isThemeCssValueCandidate(value)) parseThemeColor(colors, key, value);
        else setThemeEntry(extra, key, value);
      }
    }
    id = String(obj.id || '').trim();
    name = String(obj.name || obj.title || '').trim() || name;
    for (const [key, value] of Object.entries(obj)) {
      if (['id', 'name', 'colors', 'builtin', 'file'].includes(key)) continue;
      if (key === 'image') { if (value !== undefined && value !== null && String(value).trim()) extra[key] = normalizeThemeImageName(value); }
      else setThemeEntry(extra, key, value);
    }
  } else {
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#') || s.startsWith('//')) continue;
      const m = /^([a-zA-Z0-9_\- ]+)\s*[=:：]\s*(.+)$/.exec(s);
      if (!m) continue;
      const originalKey = m[1].trim();
      const key = normKey(originalKey);
      const value = String(m[2] || '').trim().replace(/^["']|["']$/g, '');
      if (key === 'id') id = value;
      else if (key === 'name' || key === 'title') { name = value; if (key === 'title') extra.title = value; }
      else if (key === 'uistyle' || key === 'ui-style') extra.uiStyle = value;
      else if (key === 'image') { if (value) extra.image = normalizeThemeImageName(value); }
      else if (key === 'description' || key === 'format' || key === 'version') setThemeEntry(extra, originalKey, value);
      else if (COLOR_KEYS.includes(toCamel(key)) || isThemeCssColor(value) || isThemeCssValueCandidate(value)) parseThemeColor(colors, originalKey, value);
      else setThemeEntry(extra, originalKey, value);
    }
  }
  if (!colors.bg || !colors.bg2 || !colors.accent || !colors.text) throw new Error('Theme requires bg / bg2 / accent / text CSS colors');
  const themeId = (id || fallbackName || 'imported-theme').replace(/[^\w\-]+/g, '-').slice(0, 48) || 'imported-theme';
  return { ...extra, id: themeId, name: name || themeId, colors, builtin: false };
}

function safeThemeName(name) {
  return String(name || 'theme').replace(/[^\w\-.]+/g, '-').replace(/^[-.]+/, '').slice(0, 48) || 'theme';
}

/**
 * 列出主题（内置 + `themes/` 目录里导入的）。
 *
 * ★ 2026-10-05（sb3 对抗复核 T-THEMES-FIX ①）两处改动，语义都往"诚实"方向走：
 *   ① **只读函数不再在盘上建目录**。旧实现（照搬 `src/themes.js:264`）里有
 *      `if (!fs.existsSync(themesDir)) fs.mkdirSync(themesDir, {recursive:true})`
 *      ⇒ **一次 GET 就能在盘上造出目录**。已删；"要保证目录存在"是**写**路径的义务
 *      （`importTheme` 里仍 `mkdirSync`，走 `writeJsonAtomic`）。
 *   ② **目录读不动不再完全静默**。旧实现那里是一个空 catch（注释写"目录不可读时只返回内置"）
 *      让「目录坏了」与「目录是空的」返回**完全一样**的东西 —— 正是本项目反复在抓的
 *      "空数据冒充成功"。现在把可读性与原因挂在返回值上（`dir` / `dirReadable` / `dirError`）。
 *
 * 形状说明：**返回的仍然是数组**（旧树形状，`api/shell.js` 直接当 `themes` 用，**不能改**），
 * 三个诊断字段以**不可枚举**属性挂在数组上（程序化调用方 `list.dirReadable` 可读；
 * JSON 序列化数组本来就丢非索引属性，所以线上响应不受影响）。
 * 要**对象形状**（HTTP 层透出这三个字段）请用 `listThemesView()`。
 */
export function listThemes(themesDir = resolveThemesDir()) {
  const dir = String(themesDir || '');
  const byId = new Map();
  for (const t of BUILTIN_THEMES) byId.set(t.id, { ...t });

  // 目录状态：不存在 = 合法的空目录（可读）；存在但读不动 = 不可读（必须报出来）
  let dirReadable = true;
  let dirError = '';
  let entries = [];
  if (!fs.existsSync(dir)) {
    dirReadable = true;                 // 空目录是合法状态，不是故障
  } else {
    try {
      entries = fs.readdirSync(dir);
    } catch (error) {
      dirReadable = false;
      dirError = String(error?.message ?? error);
      entries = [];
    }
  }
  for (const f of entries) {
    if (!/\.(json|txt)$/i.test(f)) continue;
    if (/THEME_FORMAT/i.test(f)) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const th = parseThemeText(raw, path.parse(f).name);
      byId.set(th.id, { ...th, file: f, builtin: !!byId.get(th.id)?.builtin });
    } catch { /* 单个文件坏了就跳过它（**这一层保持静默是旧树行为**：坏文件不该让整份列表失败） */ }
  }
  const listed = [...byId.values()];
  for (const theme of listed) {
    delete theme.css;
    delete theme.cssVersion;
    const asset = resolveThemeCssRequest(dir, theme.id);
    if (asset.status !== 200) continue;
    try {
      theme.css = true;
      theme.cssVersion = fs.statSync(asset.path).mtimeMs;
    } catch {
      delete theme.css;
      delete theme.cssVersion;
    }
  }
  // 诊断字段：不可枚举 ⇒ 不污染 JSON 形状（数组序列化只认索引）
  Object.defineProperties(listed, {
    dir: { value: dir, enumerable: false, configurable: true },
    dirReadable: { value: dirReadable, enumerable: false, configurable: true },
    dirError: { value: dirError, enumerable: false, configurable: true }
  });
  return listed;
}

/**
 * 对象形状的列表视图 —— 给 HTTP 层用（`api/shell.js` 的 GET /api/themes 透出这三个字段时改调它）。
 * `{ themes:[…], dir, dirReadable, dirError }`
 */
export function listThemesView(themesDir = resolveThemesDir()) {
  const themes = listThemes(themesDir);
  return {
    themes,
    dir: themes.dir,
    dirReadable: themes.dirReadable,
    dirError: themes.dirError
  };
}

/** Prepare theme data and its on-disk payload without writing files. */
export function prepareThemeImport(raw, { filename = '', image } = {}) {
  const base = filename ? path.parse(filename).name : '';
  const th = parseThemeText(raw, base);
  if (image !== undefined && image !== null && String(image).trim()) th.image = normalizeThemeImageName(image);
  const file = safeThemeName(th.id || base) + '.json';
  return { theme: th, file, payload: buildThemeImportPayload(th) };
}

/**
 * Import theme text into themes/ and return the normalized theme.
 *
 * ★ 2026-10-05（T-THEMES-FIX ②）改用 `core/util` 的 `writeJsonAtomic`（tmp + rename，
 *   失败**删 tmp 并把错误抛出来**），不再在模块里另抄一份 `writeFileSync` ——
 *   旧写法一旦进程在中途被杀会留下**截断的 json**，而装载端 `listThemes` 对坏文件是
 *   `catch { 跳过 }`（旧树行为，保留）⇒ 主题会**悄悄消失**、用户只看到"我存的主题没了"。
 */
export function importTheme(raw, options = {}) {
  const dir = resolveThemesDir();
  const { theme, file, payload } = prepareThemeImport(raw, options);
  const abs = path.join(dir, file);
  // ★ 目录创建是**写**路径的义务（只读路径已不再建目录，见 listThemes 的说明）。
  //   writeJsonAtomic 自己也会 mkdirSync(dirname)，这里显式留着是为了让"目录不存在"也走同一条路。
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(abs, payload, { indent: 2 });   // ← 原子写；失败会抛（不再静默）
  // ★ N52 对账：老树落盘是 `JSON.stringify(payload, null, 2) + '\n'`（`src/themes.js:306`），
  //   现网 `themes/*.json` 每一份都以 `}\n` 结尾；`writeJsonAtomic` 不带尾换行 ⇒ 新导入的主题
  //   与既有主题**混两种格式**（`git diff` 上表现为 "\ No newline at end of file"）。补齐这一字节。
  //   尾换行丢了不影响可解析性 ⇒ 追加失败**不许**把"已导入"改报成"没导入"。
  try { fs.appendFileSync(abs, '\n', 'utf8'); } catch { /* 纯格式字节，失败不改变结果 */ }
  return { ...theme, file };
}

export function getThemeById(id) {
  const sid = String(id || '').trim();
  return listThemes().find((t) => t.id === sid) || null;
}