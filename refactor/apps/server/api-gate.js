/**
 * refactor/apps/server/api-gate.js —— `/api/**` 的**统一来源闸**（2026-10-17 · ds1 安全审查收口）
 *
 * 为什么要有这一层：`http.js` 的分发器与各分片**一条来源校验都没有**（只有三条明文 Key 端点与
 * `/api/jev/judge-models` 各带一道）。于是任何"能连到 127.0.0.1:<port> 的东西"——包括浏览器里的
 * 外部页面——都能调写配置 / 删数据 / 启停进程的接口。浏览器侧挡住它的是 CORS 预检，但：
 *   · **简单请求**（GET、`text/plain` POST）压根没有预检；
 *   · 分发器**无视 Content-Type 一律 JSON.parse**（`index.js` 的 body 收集段）⇒ 简单 POST 也能写；
 *   · DNS rebinding 下外部页面与 `evil.com:<port>` **同源**，连自定义头都不需要预检，响应还可读。
 *
 * 判据（**顺序即语义**，与 `api/console.js:keyEndpointAllowed` / `index.js:judgeModelsOriginAllowed` 同口径）：
 *   0. 配了 `server.token` 且请求带来**匹配**的 token（头 `x-console-token` 或查询串 `?token=`）⇒ 放行。
 *      这是远程/多用户那一档的**真认证**；没配 token 时本层不引入任何新密码（默认行为不变）。
 *   1. `Host` 必须是**回环**（127.0.0.0/8 / localhost / [::1]）且形状合法；缺失或畸形 = 拒。
 *      —— 这一条挡 DNS rebinding：攻击者页面无论怎么解析域名，Host 都是它自己的域名。
 *   2. `Origin` 若在：必须解析成 URL 且**主机是回环**；字面 `null`（file://、沙箱 iframe、data: 都能发）
 *      与解析失败一律拒。跨站页面的 Origin 是它自己的域名 ⇒ 拒。
 *   3. `Referer` 若在：同样必须解析且主机回环（老浏览器不发 Sec-Fetch-Site 时的兜底）。
 *   4. `Sec-Fetch-Site` 若在：只认 `same-origin` / `same-site` / `none`；`cross-site` 一律拒。
 *      —— 这一条挡**没有 Origin 的简单请求**（`<img src>`、表单 GET、`fetch(no-cors)`）：
 *      该头由浏览器强制写入、页面 JS 改不了，也不受 referrer-policy 影响。
 *   5. 以上都不适用（无 Origin / 无 Referer / 无 Sec-Fetch-Site）⇒ 放行 = **本机 CLI / 探针 / 桌面主进程**
 *      的形状（它们本来就在本机）。这是有意的残余面：没有 token 时，本机进程与"本机进程"无法区分，
 *      也不该区分 —— 能连上这个端口的本机进程本来就能读 `data/`。
 *
 * 明确**不做**的事（避免误伤，留档给用户/指挥裁定）：
 *   · 不要求"Origin 与 Host 严格相等"：回环**跨端口**的本地页面（例：3210 面板调 3221 面板、
 *     自建本地看板）按本口径放行 —— 远程页面拿不到回环 Origin，所以这不算放宽攻击面；真按严格相等，
 *     用户把面板开在 `localhost:3210`、服务监听 `127.0.0.1:3210` 这类"同一个服务两种写法"会被误伤。
 *   · 不动静态资源与非 `/api/**` 路由（桌宠皮肤图等由 file:// 页面用 img 加载，那些不是数据面）。
 *   · 不改 `server.token` 的语义、不新增密码、不改任何端点的请求/响应契约。
 */

/** 回环主机名判定。带方括号的 IPv6 先脱壳；只认 127.0.0.0/8、localhost、::1。 */
export function isLoopbackHostname(rawHostname) {
  const h = String(rawHostname ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return false;
  return parts[0] === 127;
}

/**
 * 解析 `Host` 头。畸形（空 / 空白 / 路径 / userinfo 混淆 / 缺端口 / 多冒号 / 端口非法）一律 `null`。
 * HTTP/1.1 打到非默认端口必然带端口，所以"缺端口"在本服务里不是合法形状（fail-closed）。
 */
export function parseHostHeader(raw) {
  const host = String(raw ?? '').trim();
  if (!host || /[\s/\\?#@]/.test(host)) return null;
  if (host.startsWith('[')) {                      // [::1]:3220
    const m = /^\[([^\]]+)\]:(\d{1,5})$/.exec(host);
    if (!m) return null;
    const port = Number(m[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { hostname: m[1], port };
  }
  const parts = host.split(':');
  if (parts.length !== 2) return null;             // 缺端口 / 多冒号（IPv6 必须带方括号）
  const port = Number(parts[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!/^[A-Za-z0-9.-]+$/.test(parts[0])) return null;
  return { hostname: parts[0], port };
}

function parseAbsoluteUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    const u = new URL(text);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch { return null; }
}

const FETCH_SITE_ALLOWED = new Set(['same-origin', 'same-site', 'none']);

/**
 * 同一个头出现几次（`rawHeaders` 是原始数组，**保留重复项**；`headers` 那份 Node 只会留一条）。
 * 桩对象没有 `rawHeaders` ⇒ 回 0（不假装查过）。
 */
export function rawHeaderCount(req, name) {
  const raw = req?.rawHeaders;
  if (!Array.isArray(raw)) return 0;
  let n = 0;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (String(raw[i] || '').toLowerCase() === name) n += 1;
  }
  return n;
}

/**
 * 判一条 `/api/**` 请求是否放行。
 * @param {object} req Node 的 IncomingMessage（或同形状的桩：`{headers, url}`）
 * @param {{token?: string}} [opts] `token` = 当前配置的 `server.token`（空串 = 未配置）
 * @returns {{ok: true, code: string} | {ok: false, code: string, message: string}}
 */
export function judgeApiRequest(req, { token = '' } = {}) {
  const headers = req?.headers || {};
  const deny = (code, message) => ({ ok: false, code, message });

  // 0) 真认证：配置了 token 且带来匹配值（头或查询串）⇒ 任意 Host/Origin 都放行（远程/多用户那一档）。
  const configured = String(token ?? '');
  if (configured) {
    let searchToken = '';
    try {
      searchToken = new URL(String(req?.url || '/'), 'http://127.0.0.1').searchParams.get('token') || '';
    } catch { searchToken = ''; }
    if (headers['x-console-token'] === configured || searchToken === configured) {
      return { ok: true, code: 'token-authenticated' };
    }
  }

  // 1) Host 必须是回环（挡 DNS rebinding）。
  //    ★ 先查"重复 Host"：Node 的 `headers.host` 只会留一条（后面那条被丢），只看它就看不见这种请求
  //      —— 而 RFC 7230 要求多 Host 必须拒（上游代理与 Node 对"用哪一条"的口径可能不同）。
  if (rawHeaderCount(req, 'host') > 1) {
    return deny('duplicate-host', '请求带了多个 Host 头，已拒绝。');
  }
  const host = parseHostHeader(headers.host);
  if (!host) {
    return deny('bad-host', '请求的 Host 头缺失或畸形，已拒绝。本接口只接受本机回环地址的调用。');
  }
  if (!isLoopbackHostname(host.hostname)) {
    return deny('host-not-loopback',
      `请求的 Host（${host.hostname}）不是本机回环地址，已拒绝。`
      + '（这条挡的是"外部网页把域名解析到 127.0.0.1 冒用控制台"这类 DNS rebinding。）');
  }

  // 2) Origin 若在，必须是回环主机；`null` 与解析失败都拒（外部/隔离页面能随便发 `null`）。
  const originRaw = headers.origin;
  if (originRaw !== undefined) {
    const originText = String(originRaw).trim().toLowerCase();
    if (originText === 'null') {
      return deny('null-origin', '请求带 Origin: null（file://、沙箱 iframe、data: 页面都能发），已拒绝。');
    }
    const origin = parseAbsoluteUrl(originRaw);
    if (!origin) return deny('bad-origin', '请求的 Origin 头无法解析，已拒绝。');
    if (!isLoopbackHostname(origin.hostname)) {
      return deny('origin-not-loopback',
        `请求来自外部站点（Origin: ${origin.origin}），已拒绝。控制台只接受本机页面与带 token 的调用。`);
    }
  }

  // 3) Referer 若在，同样必须回环（老浏览器不发 Sec-Fetch-Site 时的兜底）。
  const refererRaw = headers.referer;
  if (refererRaw !== undefined) {
    const referer = parseAbsoluteUrl(refererRaw);
    if (!referer) return deny('bad-referer', '请求的 Referer 头无法解析，已拒绝。');
    if (!isLoopbackHostname(referer.hostname)) {
      return deny('referer-not-loopback', `请求来自外部页面（Referer: ${referer.hostname}），已拒绝。`);
    }
  }

  // 4) Sec-Fetch-Site：浏览器强制写入、页面改不了。只管"没有 Origin 的简单请求"（img/表单 GET/no-cors）。
  const site = String(headers['sec-fetch-site'] ?? '').trim().toLowerCase();
  if (site) {
    if (site === 'cross-site') {
      return deny('cross-site', '请求被浏览器标记为跨站（Sec-Fetch-Site: cross-site），已拒绝。');
    }
    if (!FETCH_SITE_ALLOWED.has(site)) {
      return deny('unknown-fetch-site', `请求的 Sec-Fetch-Site（${site}）不是已知的本地来源，已拒绝。`);
    }
  }

  return { ok: true, code: originRaw !== undefined ? 'loopback-origin' : 'loopback-cli' };
}

/** `/api` 与 `/api/**` 都算数据面；静态资源与非 /api 前缀的资源路由不归本闸。 */
export function isApiPath(pathOnly) {
  const p = String(pathOnly ?? '');
  return p === '/api' || p.startsWith('/api/');
}

/**
 * 拒绝响应的统一形状（日志有上限：不给"刷日志"留放大面；响应体不含任何请求头原值）。
 * @returns {{status: number, headers: object, body: string, logLine: string}}
 */
export function denialResponse(verdict, { pathOnly = '', method = '' } = {}) {
  const body = JSON.stringify({
    ok: false,
    code: verdict?.code || 'denied',
    error: verdict?.message || '请求来源不被信任，已拒绝。'
  });
  return {
    status: 403,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      // 关连接：不给"拒绝之后还继续灌 body"留挂着的 socket（也避免未读 body 占内存）
      connection: 'close'
    },
    body,
    logLine: `[apps/server] API 来源闸拒绝 ${method} ${pathOnly}：${verdict?.code || 'denied'}`
  };
}
