// ④「整套新桌宠」的**协议出口**：用自定义 scheme 加载插件页，好让宿主能强制下发 CSP。
//
// 为什么需要它（上一批标为"最大的未闭环"）：`loadFile` 走 file://，**拿不到响应头**，
// 于是 CSP 只能由插件自己在 HTML 里写 meta —— 那等于"被保护方自己决定要不要被保护"。
// 换成 protocol.handle 之后，CSP 由**宿主**写在响应头上，第三方页面改不掉。
//
// 纯模块：**不 import electron**（与 pet-plugin-registry.js / pet-actions-sanitize.js 同风格），
// node 可直接测；主进程只负责把它接到 protocol.handle 上。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ★ 回退开关：万一自定义协议在某个平台跑不起来，把它改成 false 即退回上一批的 loadFile +
//   页面自带 meta CSP。**它只影响"用哪种方式加载"，不放宽任何安全判定**（下面的路径与
//   MIME 规则两条路都照样走）。
export const PET_PLUGIN_USE_CUSTOM_PROTOCOL = true;

export const PET_PLUGIN_SCHEME = 'pet-plugin';

/**
 * 宿主强制的 CSP。**故意不给 script 的 'unsafe-inline'** —— 插件页的脚本必须是外部 .js。
 * connect-src 'none' 是这一版的核心：它把页面的网络面整个关掉，
 * 于是"不自律的第三方桌宠页也能 fetch http://127.0.0.1:<端口>/api/status 读到本机路径与账号 id"
 * 这条路被**宿主**堵死，而不是靠插件自觉。
 */
export const PET_PLUGIN_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "media-src 'self' data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join('; ');

/** 给插件写在自己 HTML 里的 meta CSP 模板（宿主那份才是强制的，这份只是示例）。 */
export const PET_PLUGIN_CSP_META = "default-src 'none'; script-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'";

/**
 * MIME 映射。**未知扩展名一律拒绝**（返回 null，由主进程回 415）——
 * 刻意不做"兜底成 text/html"：那会让一个 .dat / .bin 之类的文件被当页面/脚本加载。
 */
export const PET_PLUGIN_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8'
};

export function petPluginMimeFor(filePath) {
  const lower = String(filePath || '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = lower.slice(dot);
  return Object.prototype.hasOwnProperty.call(PET_PLUGIN_MIME, ext) ? PET_PLUGIN_MIME[ext] : null;
}

/**
 * 把协议 URL 解析成"插件 id + 插件目录内的相对路径"。
 * 形态：pet-plugin://<pluginId>/<relative/path>
 * 拒：scheme 不符 / 缺 id / id 非法 / 空路径 / 绝对路径 / 盘符冒号 / 含 `..` 或空段 / `.` 段。
 * 纯字符串判定，不碰 fs —— "必须仍在插件目录内"由 resolveRequestPath 复核。
 */
export function parsePetPluginUrl(rawUrl) {
  const problems = [];
  const raw = String(rawUrl || '');
  const prefix = `${PET_PLUGIN_SCHEME}://`;
  if (!raw.toLowerCase().startsWith(prefix)) {
    return { ok: false, id: '', relPath: '', problems: ['scheme mismatch'] };
  }
  const rest = raw.slice(prefix.length).split('#')[0].split('?')[0];
  const slash = rest.indexOf('/');
  if (slash <= 0) return { ok: false, id: '', relPath: '', problems: ['missing path'] };
  const id = decodeURIComponent(rest.slice(0, slash)).toLowerCase();
  const relPath = decodeURIComponent(rest.slice(slash + 1)).replace(/\\/g, '/');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) problems.push('bad plugin id');
  if (!relPath) problems.push('empty path');
  else if (relPath.startsWith('/')) problems.push('absolute path');
  else if (relPath.includes(':')) problems.push('drive letter or colon');
  else if (relPath.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) problems.push('illegal path segment');
  if (problems.length) return { ok: false, id, relPath, problems };
  return { ok: true, id, relPath, problems: [] };
}

/**
 * 把"插件目录 + 相对路径"解析成绝对文件路径。
 *
 * ★ 这里**没有**复用 pet-plugin-registry.js 的 resolvePetPluginEntry ——
 *   那个函数是"**入口**校验"，它额外要求路径以 .html 结尾（入口必须是页面）。
 *   协议出口要服务的不只是入口，还有入口引用的 .js/.css/.png 等资源；
 *   照搬会把资源全判成非法（第一版就这么写，探针当场逮到：pet.js 被 403 挡掉，页面根本跑不起来）。
 *   所以这里**自己实现那两道防线**，规则与注册表逐条相同，**一条都没放宽**：
 *     ① 语法层：绝对路径 / 盘符冒号 / 空段 / `.` / `..` 一律拒；
 *     ② 真实路径层：path.resolve 后必须仍以「插件目录 + 分隔符」开头；再叠一层 realpath 防符号链接逃逸。
 *   「没有放宽」由 .tmp-dispatch/s8v-csp-probe.mjs 的 C/D 两组钉住。
 */
export function resolveRequestPath(pluginDirAbs, relPath, { realpathSync = null } = {}) {
  const problems = [];
  const rel = String(relPath || '').replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || rel.includes(':') || rel.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    return { abs: null, problems: ['illegal relative path'] };
  }
  const base = path.resolve(pluginDirAbs);
  const abs = path.resolve(base, rel);
  if (!abs.toLowerCase().startsWith((base + path.sep).toLowerCase())) {
    return { abs: null, problems: ['escapes the plugin directory'] };
  }
  if (typeof realpathSync === 'function') {
    try {
      const realBase = realpathSync(base);
      const realAbs = realpathSync(abs);
      if (!realAbs.toLowerCase().startsWith((realBase + path.sep).toLowerCase())) {
        return { abs: null, problems: ['escapes the real plugin directory'] };
      }
    } catch (error) {
      return { abs: null, problems: [`realpath failed: ${error?.code || 'ERR'}`] };
    }
  }
  return { abs, base, problems: [] };
}

/**
 * `will-navigate` 的放行判定：**"还在同一个插件自己的地盘里"吗？**
 *
 * 两条加载路径都要管（开关切过去/切回来都会走到）：
 *   ① `pet-plugin://<id>/…`：同一个插件 id 之内放行。parsePetPluginUrl 内部已 decode。
 *   ② `file://…`（回退路径）：**必须用 fileURLToPath 还原真实路径再比前缀**。
 *      Gemini 5f41268e 实测过：手写 `new URL(url).pathname` 会被 percent-encode，
 *      **含空格或中文的路径会被误判成"不同源"而误拦**（插件自己的页面跳转会直接被挡死）。
 *      这也是为什么这个判定放在纯模块里 —— 含空格/中文路径能被 node 探针真验，
 *      而不是只能"声称已验"（探针 F 组）。
 *
 * 其它一律 false：跨插件、跨源、data:、about:、javascript: …
 */
export function petPluginNavigationAllowed(rawUrl, { pluginId = '', pluginDirAbs = '', entryAbs = '' } = {}) {
  const raw = String(rawUrl || '');
  const parsed = parsePetPluginUrl(raw);
  if (parsed.ok) return !!pluginId && parsed.id === pluginId;
  if (/^file:\/\//i.test(raw)) {
    try {
      const real = path.resolve(fileURLToPath(raw));
      if (entryAbs && real === path.resolve(entryAbs)) return true;
      const base = path.resolve(pluginDirAbs || '');
      if (!base || base === path.parse(base).root) return false;
      return real.startsWith(base + path.sep);
    } catch {
      return false;   // fileURLToPath 对非 file/ 畸形 URL 会抛 ⇒ 一律当"不放行"
    }
  }
  return false;
}
