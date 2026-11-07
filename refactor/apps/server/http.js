/**
 * refactor/apps/server/http.js — HTTP 路由分发
 *
 * 只做 IO/接线，不做决定。
 * API 路由 + 静态文件（apps/ui/）。
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tryServeStatic } from './static.js';
import { handleConsoleApi } from './console-api.js';

// ── 分片加载（S1/S2/S3…）：`api/*.js` 按文件名顺序问一遍，谁认领谁处理 ──────────
// ★ 2026-10-05 由指挥位补上：切片文件（`api/shell.js` / `api/media.js` / `api/console.js`）
//   早就交付了，但**没有任何代码去 import 它们**（`registerRoute` 那套没人注册 ⇒ 76 条 404 全堵在这 20 行）。
//   契约：`export async function handle({method, pathname, query, body, ctx, req, res})`，
//   **不认识就 return null**，返回 `{status, headers, body}` 即接管。
const API_DIR = new URL('./api/', import.meta.url);
let sliceModules = null;

async function loadSlices() {
  if (sliceModules) return sliceModules;
  let names = [];
  try {
    names = fs.readdirSync(fileURLToPath(API_DIR)).filter((f) => f.endsWith('.js')).sort();
  } catch {
    names = [];   // 没有 api/ 目录 = 正常的初始状态，不是错误
  }
  const loaded = [];
  for (const name of names) {
    try {
      loaded.push({ name, mod: await import(new URL(`./${name}`, API_DIR)) });
    } catch (error) {
      // 加载失败**不许静默**：喊出来（否则表现成"整片接口 404"，极难查）
      console.warn(`[http] 分片 api/${name} 加载失败：${error?.message ?? error}`);
    }
  }
  sliceModules = loaded;
  return loaded;
}

/** 预热并返回分片名单（装配/探针用；也可用于把加载失败提前暴露出来）。 */
export async function listSlices() {
  return (await loadSlices()).map((s) => s.name);
}

// ── 薄分发器：外部模块注册路由（S1/S2/S3 等切片挂载点）────────────────
const extraRoutes = [];

/**
 * 注册一条额外路由。调用方在装配期注册，不在模块加载期。
 * @param {object} route - { method, path, handler(method, pathname, body, ctx) }
 *   handler 返回 { status, headers, body } 或 null（未处理）。
 */
export function registerRoute(route) {
  if (!route?.path || typeof route.handler !== 'function') return false;
  extraRoutes.push(route);
  return true;
}

/** 批量注册 */
export function registerRoutes(routes) {
  let n = 0;
  for (const r of routes) { if (registerRoute(r)) n++; }
  return n;
}

/** 清空注册（自测用） */
export function clearRoutes() {
  extraRoutes.length = 0;
}

/**
 * 处理一个 HTTP 请求（不含网络 IO，纯路由）。
 * @param {string} method - GET / POST / …
 * @param {string} url - 请求路径
 * @param {object} [body] - 已解析的 JSON body（POST 用）
 * @param {object} ctx - 装配上下文（{ modules, configStore, obs, … }）
 * @param {object} [io] - `{req, res, rawBody}`；`rawBody` = 未经 JSON.parse 的原始字节（二进制上传端点用）
 * @returns {{ status: number, headers: Record<string,string>, body: Buffer|string }}
 */
export async function handleRequest(method, url, body, ctx, io = {}) {
  const [pathOnly, search = ''] = String(url || '/').split('?');
  const query = new URLSearchParams(search);

  // ── 健康检查 ──
  if (pathOnly === '/api/health' && method === 'GET') {
    const sink = ctx?.obs?.stats?.().sink ?? null;
    return json(200, {
      ok: true,
      modules: ctx?.modulesLoaded?.length ?? 0,
      observability: sink ? {
        droppedLines: sink.rowsDropped,
        writeRetries: sink.writeRetries,
        lastError: sink.recentError || '',
        lastErrorAt: sink.lastErrorAt || null,
        lastSuccessAt: sink.lastSuccessAt || null,
        lastFailure: sink.lastFailure || null,
        lastRetry: sink.lastRetry || null,
        integrity: { status: sink.integrityStatus, gaps: sink.integrityGaps },
        activeFile: sink.activeFile || '',
        files: sink.files
      } : null
    });
  }

  // ── 控制台 API（console-api.js 路由）──
  // ★ U4：`query` 过去在这里被**剥掉**（只传 `pathOnly`）⇒ `/api/sessions?limit=N` 的 N 到不了
  //   `getSessions()`，那里只能写死 1048576 ⇒ 前端改小 limit 也没用。现在把 query 一起传下去。
  //   纯增量第 5 个参数：既有调用方（自测、装配）不传就是 undefined，行为不变。
  const consoleResult = await handleConsoleApi(method, pathOnly, body, ctx, query);
  if (consoleResult) return consoleResult;

  // ── 外部模块注册的路由（S1/S2/S3 切片）──
  for (const route of extraRoutes) {
    if (route.method === method && route.path === pathOnly) {
      const result = route.handler(method, pathOnly, body, ctx);
      if (result) return result;
    }
    // 前缀匹配（路径以 / 开头）
    if (route.method === method && route.path.endsWith('*') && pathOnly.startsWith(route.path.slice(0, -1))) {
      const result = route.handler(method, pathOnly, body, ctx);
      if (result) return result;
    }
  }

  // ── 分片（S1/S2/S3…）：api/*.js 逐个问，认领即返回 ──
  for (const { name, mod } of await loadSlices()) {
    if (typeof mod.handle !== 'function') continue;
    try {
      // ★ 2026-10-17（ds1）：`rawBody` 一并递给分片 —— `io.rawBody` 是**未经 JSON.parse** 的原始字节
      //   （index.js 在收 body 时留的那一份）。`/api/skills/import-zip` 这类二进制上传端点要它；
      //   不认识的 `handle()` 忽略这个键，形状对既有分片不变。
      const out = await mod.handle({ method, pathname: pathOnly, query, body, ctx, req: io.req, res: io.res, rawBody: io.rawBody });
      if (out) return out;
    } catch (error) {
      // 分片自己抛 ⇒ 500 + 原文（不许吞成 404/200），且点名是哪一片
      return json(500, { ok: false, error: `分片 api/${name} 处理失败：${error?.message ?? error}` });
    }
  }

  // ── 实例信息 / 配置读取：★ P1 消重（2026-10-12）两处兜底已删 ──
  // 它们排在 console-api（http.js:93）与四个分片（:110）之后，正常永远到不了；
  // 而且 `/api/config` 那份回 `{ok, data}`（**多一层 data**），与 console-api 的扁平响应
  // 形状不同 —— 万一总分表让路，界面会静默换成另一种读法。保留生效者即可：
  //   GET /api/instance-info → console-api.js getInstanceInfo
  //   GET /api/config        → console-api.js getConfig（扁平，前端 17 处按这个读）
  // （`GET /api/health` 在 :85，luna1 窄加过 observability 字段，**保持不动**。）

  // ── 静态文件 ──
  if (method === 'GET' || method === 'HEAD') {
    const staticRes = tryServeStatic(pathOnly);
    if (staticRes) {
      return {
        status: staticRes.status,
        headers: staticRes.headers,
        body: method === 'HEAD' ? '' : staticRes.body
      };
    }
  }

  // ── 404 ──
  return json(404, { ok: false, error: `未找到 ${method} ${pathOnly}` });
}

function json(status, obj) {
  const body = JSON.stringify(obj, null, 2);
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(body)) },
    body
  };
}

/** 路由表（供自检） */
export function routeTable() {
  return [
    { method: 'GET', path: '/api/health', desc: '健康检查' },
    { method: 'GET', path: '/api/instance-info', desc: '实例信息' },
    { method: 'GET', path: '/api/config', desc: '配置快照' },
    { method: 'GET', path: '/(static)', desc: '静态文件（apps/ui/）' }
  ];
}
