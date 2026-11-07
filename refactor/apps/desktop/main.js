// Electron 桌面壳：启动核心服务器（同一进程），打开会话式控制台窗口。
// 傻瓜式：托盘常驻、关窗不退出、可选开机自启。
import { app, BrowserWindow, Tray, Menu, nativeImage, session, ipcMain, screen, dialog, protocol } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../core/observability/index.js';   // 号A 日志落盘（此前只走 console，从不落盘；2026-09-29）
import { getConfig, updateConfigAndSave } from '../../core/config-store/index.js';   // 裁定1：桌面壳直连 core 冻结出口（§3.5），无转发层；★ 2026-10-11：必须用 AndSave 版——updateConfig 只改内存，重启回退
import { REPO_ROOT, PET_SKIN_ROOTS, assertPetSkinRoots } from './pet-skins/roots.js';   // 皮肤两根的唯一真相（2026-10-05）

// Windows 上部分显卡驱动会导致渲染进程黑屏，所以这里历史上默认关掉了硬件加速。
//
// ⚠️ 2026-09-22（用户反馈"deepseek 主题毛玻璃不开太丑，但要开就别卡"）：
//   软件渲染是所有"主题卡顿"的总放大器 —— deepseek 主题有一百多处 backdrop-filter、
//   机甲主题把 box-shadow 拿来做无限动画，全在 CPU 上算，一屏能明显掉帧。
//   上一版我的做法是"把毛玻璃关掉换性能"，用户否了（太丑）。
//   现在改成**默认开硬件加速**（这才是根因），软件渲染只作为黑屏时的兜底开关：
//       set QQ_AGENT_GPU=0        → 回到软件渲染（老显卡黑屏/花屏时用这个）
//       不设 / 设 1               → 走硬件加速（默认，毛玻璃与机甲特效都能留住）
//   UI 侧只保留"动画改成可合成属性"这类**看不出差别**的优化，不再删视觉效果。
const FORCE_SOFT = String(process.env.QQ_AGENT_GPU || '').trim() === '0';
if (FORCE_SOFT) {
  app.disableHardwareAcceleration();
  // 再补一层：部分环境即使用软渲仍黑屏
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,HighTouchLatency');
app.commandLine.appendSwitch('force-color-profile', 'srgb');

// ④ 插件桌宠的自定义 scheme 必须在 app ready **之前**声明为 privileged，
// 否则它拿不到独立 origin（script-src 'self' 会失效）也拿不到 secure 标记。
// ★ bypassCSP 保持默认 false —— 本批要的就是"CSP 真的生效"，别把它打开。
protocol.registerSchemesAsPrivileged([{
  scheme: PET_PLUGIN_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
    bypassCSP: false,
    stream: true
  }
}]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// ★ 2026-10-05（T-DESKTOP-SKINROOT）语义漂移修复。
//   旧树 electron/main.js:49 是 `path.resolve(__dirname,'..')`，而旧 __dirname = <repo>/electron
//   ⇒ APP_ROOT 其实是**仓库根**。迁到 refactor/apps/desktop 后 __dirname 变深两级，APP_ROOT
//   悄悄变成 refactor/apps，于是下面 7 处路径**全部指到不存在的目录**（我逐条量过：
//   assets/icon.png、data、desktop-prefs.json、data-2、src/server.js、plugins、pet-skins ——
//   在 refactor/apps 下 7/7 全不存在，在仓库根 7/7 全存在）。
//   危害最直接的是 pet-skins（用户皮肤静默全丢、不报错）与 src/server.js（peer core 拉不起来）。
//   ⇒ 现在**不再本地反推**：仓库根来自 pet-skins/roots.js（它再取 apps/server/paths.js 的 REPO_ROOT），
//     并且 roots.js 里有"必须含 package.json + refactor/"的断言，认错就抛。
//   保留 APP_ROOT 这个名字是为了下面 7 处旧语义调用点原样继续按仓库根工作（旧树行为一致）。
const APP_ROOT = REPO_ROOT;
const ICON_PATH = path.join(APP_ROOT, 'assets', 'icon.png');
// 裁定2：照抄旧语义（旧世界 dataDir = QQ_AGENT_DATA_DIR || <APP_ROOT>/data）。
// APP_ROOT 的语义对齐留给第 3 批装配期；这里只把旧语义写实，不重新发明。
//
// 裁定3（求值时机）：**故意做成函数、不在模块顶层求值** —— 顶层 const 会在 main.js
// 被加载的那一刻就把 process.env.QQ_AGENT_DATA_DIR 读掉；若启动器是在加载之后才设
// 这个环境变量，壳就会永远用错目录（旧 core.getConfig() 是按需读的，没有这个问题）。
// 改成函数后每次启动都重新读一次；这与 D6（先 createServer() 内部 load({dataDir})、
// 再允许别的路径调 getConfig()）是同一件事的两面。
function resolveDataDir() {
  return process.env.QQ_AGENT_DATA_DIR || path.join(APP_ROOT, 'data');
}

// ── 多实例：QQ_AGENT_PROFILE=2（或 --qq-agent-profile=2）时，本实例与主实例完全隔离 ──
// 两种写法都支持：启动器 .bat 里设环境变量；开机自启走命令行参数（注册表项带不了环境变量）。
// 隔离的是：Electron 配置目录、数据目录（人设/白名单/存档/记忆）、控制台端口、OneBot 指向。
function resolveProfile() {
  const fromEnv = String(process.env.QQ_AGENT_PROFILE || '').trim();
  if (fromEnv) return fromEnv;
  const flag = process.argv.find((arg) => arg.startsWith('--qq-agent-profile'));
  if (!flag) return '';
  const inline = flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : '';
  return String(inline || process.argv[process.argv.indexOf(flag) + 1] || '').trim();
}

const PROFILE = resolveProfile();
if (PROFILE) process.env.QQ_AGENT_PROFILE = PROFILE;
const INSTANCE_LABEL = PROFILE ? `QQ Agent ${PROFILE}` : 'QQ Agent';

// 每个实例一份 Electron 配置目录：避免两份共用 %APPDATA%\qq-agent 互相踩缓存，
// 单实例锁也跟着按实例分开——同一个实例依旧只能开一个（否则会双份连 OneBot 重复回复）。
// 没设 profile 时按"程序目录指纹"取名：同一台机器上解压出来的多份副本（qq-agent、qq-agent-v0.2…）
// 各自一份配置目录，互不抢锁，才能真正同时跑起来。
function instanceUserDataDir() {
  const base = app.getPath('appData');
  const fingerprint = crypto.createHash('sha1').update(APP_ROOT.toLowerCase()).digest('hex').slice(0, 6);
  return path.join(base, PROFILE ? `qq-agent-${fingerprint}-${PROFILE}` : `qq-agent-${fingerprint}`);
}

const USER_DATA_DIR = instanceUserDataDir();
app.setPath('userData', USER_DATA_DIR);

// ── 崩溃兜底 ──────────────────────────────────────────────────────────
// 每个账号的核心服务器都运行在自己的 Electron 主进程中。
// 主进程此前没挂任何异常处理，于是一次未捕获异常或未处理 rejection（OneBot 推送、
// 定时器、HTTP 回调里的 Promise 都算）就会把整个应用带走 —— 表现就是"开着开着自己闪退"，
// 而且不留现场：.bat 启动时 stdout 没人看。这里补两层：
//   1) 出什么事都往 crash.log 追加一行带堆栈的记录（含实例与 pid），事后可查；
//   2) 记完继续跑，不退出 —— 机器人"少处理一条消息"远好过"整个不见了"。
const CRASH_LOG = path.join(USER_DATA_DIR, 'crash.log');
const crashTimes = [];
const RESOURCE_SAMPLE_INTERVAL_MS = 30_000;
let resourceSampleTimer = null;
let lastResourceSample = null;
let resourceSampleWarned = false;
let core = null;
let startupFailureError = null;
let startupFailureWindow = null;
let lastRuntimeStatus = { state: 'module-loading', at: new Date().toISOString() };

function setRuntimeStatus(state, fields = {}) {
  const next = { state: String(state || 'unknown').slice(0, 48), at: new Date().toISOString() };
  for (const key of ['reason', 'type', 'serviceName']) {
    const value = fields?.[key];
    if (typeof value === 'string' && value) next[key] = value.slice(0, 80);
  }
  for (const key of ['port', 'exitCode', 'webContentsId']) {
    const raw = fields?.[key];
    if (raw == null || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) next[key] = Math.trunc(value);
  }
  lastRuntimeStatus = next;
  return next;
}

function sumMetricMemory(metrics, type, field) {
  if (!Array.isArray(metrics)) return null;
  const matching = metrics.filter((item) => item?.type === type);
  if (!matching.length) return 0;
  let total = 0;
  for (const item of matching) {
    const value = Number(item?.memory?.[field]);
    if (!Number.isFinite(value) || value < 0) return null;
    total += value;
  }
  return Math.round(total);
}

function readRuntimeDiagnostics() {
  let nodeMemory = null;
  try { nodeMemory = process.memoryUsage(); } catch { /* best effort */ }

  let activeSessionCount = null;
  try {
    const value = core?.ctx?.modulesObj?.sessions?.getActiveSessionCount?.();
    if (Number.isSafeInteger(value) && value >= 0) activeSessionCount = value;
  } catch { /* best effort; missing stays unknown */ }

  let inFlightModelRequestCount = null;
  try {
    const value = core?.ctx?.modulesObj?.llm?.getInFlightRequestCount?.();
    if (Number.isSafeInteger(value) && value >= 0) inFlightModelRequestCount = value;
  } catch { /* best effort; missing stays unknown */ }

  let processMetrics = null;
  try {
    const value = app.getAppMetrics?.();
    if (Array.isArray(value)) processMetrics = value;
  } catch { /* Electron metrics may be unavailable during shutdown */ }

  const gpuProcesses = Array.isArray(processMetrics) ? processMetrics.filter((item) => item?.type === 'GPU') : null;
  const rendererProcesses = Array.isArray(processMetrics) ? processMetrics.filter((item) => item?.type === 'Tab') : null;
  return {
    at: new Date().toISOString(),
    rssBytes: Number.isFinite(nodeMemory?.rss) ? nodeMemory.rss : null,
    heapUsedBytes: Number.isFinite(nodeMemory?.heapUsed) ? nodeMemory.heapUsed : null,
    heapTotalBytes: Number.isFinite(nodeMemory?.heapTotal) ? nodeMemory.heapTotal : null,
    activeSessionCount,
    inFlightModelRequestCount,
    gpuProcessCount: gpuProcesses?.length ?? null,
    gpuWorkingSetKiB: sumMetricMemory(processMetrics, 'GPU', 'workingSetSize'),
    gpuPeakWorkingSetKiB: sumMetricMemory(processMetrics, 'GPU', 'peakWorkingSetSize'),
    rendererProcessCount: rendererProcesses?.length ?? null,
    rendererWorkingSetKiB: sumMetricMemory(processMetrics, 'Tab', 'workingSetSize'),
    rendererPeakWorkingSetKiB: sumMetricMemory(processMetrics, 'Tab', 'peakWorkingSetSize')
  };
}

function crashDiagnostics() {
  const current = readRuntimeDiagnostics();
  const previous = lastResourceSample;
  return {
    lastRuntimeStatus,
    current: {
      at: current.at,
      rssBytes: current.rssBytes,
      heapUsedBytes: current.heapUsedBytes,
      heapTotalBytes: current.heapTotalBytes,
      activeSessionCount: current.activeSessionCount,
      inFlightModelRequestCount: current.inFlightModelRequestCount,
      gpuProcessCount: current.gpuProcessCount,
      gpuWorkingSetKiB: current.gpuWorkingSetKiB,
      gpuPeakWorkingSetKiB: current.gpuPeakWorkingSetKiB,
      rendererProcessCount: current.rendererProcessCount,
      rendererWorkingSetKiB: current.rendererWorkingSetKiB,
      rendererPeakWorkingSetKiB: current.rendererPeakWorkingSetKiB
    },
    lastPeriodicSample: previous ? {
      at: previous.at,
      rssBytes: previous.rssBytes,
      heapUsedBytes: previous.heapUsedBytes,
      heapTotalBytes: previous.heapTotalBytes,
      activeSessionCount: previous.activeSessionCount,
      inFlightModelRequestCount: previous.inFlightModelRequestCount,
      gpuProcessCount: previous.gpuProcessCount,
      gpuWorkingSetKiB: previous.gpuWorkingSetKiB,
      gpuPeakWorkingSetKiB: previous.gpuPeakWorkingSetKiB,
      rendererProcessCount: previous.rendererProcessCount,
      rendererWorkingSetKiB: previous.rendererWorkingSetKiB,
      rendererPeakWorkingSetKiB: previous.rendererPeakWorkingSetKiB
    } : null
  };
}

function writeResourceSample() {
  const obs = core?.obs;
  if (typeof obs?.event !== 'function') return;
  const sample = readRuntimeDiagnostics();
  lastResourceSample = sample;
  const fields = {};
  for (const key of [
    'rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'activeSessionCount', 'inFlightModelRequestCount',
    'gpuProcessCount', 'gpuWorkingSetKiB', 'gpuPeakWorkingSetKiB',
    'rendererProcessCount', 'rendererWorkingSetKiB', 'rendererPeakWorkingSetKiB'
  ]) {
    if (Number.isFinite(sample[key])) fields[key] = sample[key];
  }
  try {
    const row = obs.event('runtime:resource-sample', fields, { echo: false });
    if (!row && !resourceSampleWarned) {
      resourceSampleWarned = true;
      console.warn('[resource-sample] observability event was not recorded');
    }
  } catch (error) {
    if (!resourceSampleWarned) {
      resourceSampleWarned = true;
      console.warn('[resource-sample] observability write failed:', error?.message ?? error);
    }
  }
}

function startResourceSampler() {
  if (resourceSampleTimer) return;
  writeResourceSample();
  resourceSampleTimer = setInterval(writeResourceSample, RESOURCE_SAMPLE_INTERVAL_MS);
  resourceSampleTimer.unref?.();
}

function stopResourceSampler() {
  if (!resourceSampleTimer) return;
  clearInterval(resourceSampleTimer);
  resourceSampleTimer = null;
}

function crashLog(kind, detail) {
  try {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    const stack = detail instanceof Error ? (detail.stack || detail.message)
      : (detail && typeof detail === 'object' ? JSON.stringify(detail) : String(detail ?? ''));
    // 单文件封顶 512KB：掐掉较旧的一半，别把盘写满
    try {
      if (fs.statSync(CRASH_LOG).size > 512 * 1024) {
        // 按**字符数**取后一半：statSync().size 是字节数，而日志正文多为中文（3 字节/字），
        // 拿字节数去 slice 字符串会切错位置，保留量对不上。
        const text = fs.readFileSync(CRASH_LOG, 'utf8');
        const keep = text.slice(Math.floor(text.length / 2));
        fs.writeFileSync(CRASH_LOG, '…（更早的记录已截断）\n' + keep, 'utf8');
      }
    } catch { /* 还没有日志文件 */ }
    const msg = String(stack).replace(/\s+$/, '').slice(0, 4000) || '(无信息)';
    fs.appendFileSync(
      CRASH_LOG,
      `[${new Date().toISOString()}] ${INSTANCE_LABEL} pid=${process.pid} ${kind}\n${msg}\n[diagnostics] ${JSON.stringify(crashDiagnostics())}\n\n`,
      'utf8'
    );
  } catch { /* 记录本身绝不能反过来弄崩应用 */ }
  try { console.error(`[${kind}]`, detail?.message ?? detail); } catch { /* ignore */ }
}

/** 10 秒内最多记 20 条：一个坏定时器反复抛错时，不至于把日志刷爆、CPU 全耗在写盘上。 */
function crashLimited() {
  const now = Date.now();
  while (crashTimes.length && now - crashTimes[0] > 10000) crashTimes.shift();
  crashTimes.push(now);
  return crashTimes.length > 20;
}

process.on('unhandledRejection', (reason) => {
  if (crashLimited()) return;
  setRuntimeStatus('unhandled-rejection');
  crashLog('unhandledRejection（已忽略，继续运行）', reason);
});
process.on('uncaughtException', (error) => {
  if (crashLimited()) return;
  setRuntimeStatus('uncaught-exception');
  crashLog('uncaughtException（已捕获，继续运行）', error);
});
// 只记最后一行，用来区分"用户主动关的"（上面会有 requestQuit 记录）和"自己没的"
process.on('exit', (code) => {
  setRuntimeStatus('process-exit', { exitCode: code });
  crashLog(`进程退出 code=${code}`, new Error('exit'));
});
app.on('child-process-gone', (_e, details) => {
  const type = String(details?.type ?? 'unknown');
  const reason = String(details?.reason ?? 'unknown');
  const exitCode = Number.isFinite(Number(details?.exitCode)) ? Number(details.exitCode) : null;
  setRuntimeStatus('child-process-gone', {
    type, reason, exitCode, serviceName: String(details?.serviceName ?? details?.name ?? '')
  });
  crashLog(`子进程消失 type=${type} reason=${reason} code=${exitCode ?? 'unknown'}`, details || {});
});
// Electron 的 app 级 renderer 事件覆盖主窗口、桌宠和插件窗口；child-process-gone 不包含 renderer。
app.on('render-process-gone', (_e, contents, details) => {
  const reason = String(details?.reason ?? 'unknown');
  const exitCode = Number.isFinite(Number(details?.exitCode)) ? Number(details.exitCode) : null;
  const isMainWindow = contents === mainWindow?.webContents;
  setRuntimeStatus('render-process-gone', {
    type: 'renderer', reason, exitCode, webContentsId: Number(contents?.id)
  });
  crashLog(`渲染进程消失 reason=${reason} code=${exitCode ?? 'unknown'}${isMainWindow ? ' window=main' : ''}`,
    { type: 'renderer', reason, exitCode, webContentsId: Number(contents?.id) || null });
  if (!isMainWindow || quitting) return;
  setTimeout(() => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(`http://127.0.0.1:${core?.port || 3210}/`).catch(() => {});
    } catch { /* ignore */ }
  }, 1000);
});

// 桌面端偏好两号共享文件：号B 改了开机自启也要反映到系统登录项
const DESKTOP_PREFS_FILE = path.join(APP_ROOT, 'desktop-prefs.json');
let lastAutoStartPref = null;
let prefsWatched = false;   // applyAutoStart 会被托盘复选框反复调用，监听器只挂一次
function readSharedAutoStart() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DESKTOP_PREFS_FILE, 'utf8'));
    return parsed?.server?.autoStart === true;
  } catch {
    return null;
  }
}
function watchDesktopPrefs() {
  if (prefsWatched) return;
  try {
    if (!fs.existsSync(DESKTOP_PREFS_FILE)) return;
    prefsWatched = true;
    fs.watchFile(DESKTOP_PREFS_FILE, { interval: 1000 }, () => {
      const next = readSharedAutoStart();
      if (next !== null && next !== lastAutoStartPref) {
        lastAutoStartPref = next;
        try {
          const args = app.isPackaged ? [] : [app.getAppPath()];
          if (PROFILE) args.push(`--qq-agent-profile=${PROFILE}`);
          app.setLoginItemSettings({ openAtLogin: next, path: process.execPath, args });
          console.log('[desktop-prefs] 开机自启已同步:', next);
        } catch (e) {
          console.error('[desktop-prefs] 同步自启失败:', e?.message ?? e);
        }
      }
    });
  } catch { /* ignore */ }
}

// 单实例锁：重复启动（双击 .bat）不产生第二个实例，而是唤出已有窗口。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // The existing instance owns the data lock. Do not continue module evaluation
  // and try to acquire that lock again while Electron is shutting down.
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (startupFailureError && !core?.lastPort) {
      // A failed ESM import remains failed in this process, even after its source
      // is fixed. Relaunch instead of opening an empty page on an unbound port.
      app.relaunch();
      app.quit();
      return;
    }
    showWindow();
  });
}

// 数据目录运行标记：连数据目录都一样时（例如桌面端和 npm run server 撞在一起）挡住第二份，
// 免得同一个 QQ 号被两个进程同时接管、消息被回复两遍。多实例各用各的目录，互不影响。
const { acquireInstanceLock, releaseInstanceLock } = await import('../../core/config-store/index.js');
const instanceLock = await acquireInstanceLock();
if (!instanceLock.ok) {
  console.error(`[instance] ${instanceLock.profile} 已在运行（pid=${instanceLock.pid}），本进程退出，避免同一 QQ 号被双份接管。`);
  console.error(`[instance] 确认没有其它实例在跑时，删掉这个文件再启动：${instanceLock.lockFile}`);
  app.exit(0);
}
if (instanceLock.tookOver) {
  console.error(`[instance] 接管了残留锁：pid=${instanceLock.tookOver.pid} 还在但不响应控制台（${instanceLock.tookOver.reason}）`);
}

// ── 桌宠皮肤注册表（main 侧；core 侧在 src/app.js 各自持有一份）──
// ★ 2026-10-05：PET_SKIN_ROOTS 不再在这里本地拼，改为从 ./pet-skins/roots.js 引入（见文件头 import）。
//   旧写法 `path.join(APP_ROOT,'pet-skins')` 在迁移后曾解析到不存在的 refactor/apps/pet-skins，
//   造成「用户安装的皮肤静默全丢、零报错」。现在两个根与 apps/server/paths.js 同源。
// roots 顺序：桌面内置 pet-skins（随应用发版）→ 仓库根 pet-skins/
// （用户第三方素材；该目录**严禁**加入任何打包白名单，保持用户可自由增删）。
export { PET_SKIN_ROOTS, REPO_ROOT };   // 供交叉护栏/自检 import（点 3：把两个根导出以便被对比）
// 闸 3（fail-closed）：皮肤根解析到不存在的目录 ⇒ 这里就抛，不给"空皮肤列表"的假绿机会。
assertPetSkinRoots(PET_SKIN_ROOTS);
const PET_DEFAULT_SKIN = 'qq-agent-default';   // 内置 SVG 皮肤包（refactor/apps/desktop/pet-skins/qq-agent-default/）
const PET_FALLBACK_SKIN = 'default';           // 内置旧图 fallback（registry 常驻条目）
let petSkinRegistry = null;

async function ensurePetSkinRegistry() {
  if (!petSkinRegistry) {
    const { SkinRegistry } = await import('./pet-skins/registry.js');
    petSkinRegistry = new SkinRegistry({ roots: PET_SKIN_ROOTS });
  }
  return petSkinRegistry;
}

async function refreshPetSkins() {
  const registry = await ensurePetSkinRegistry();
  await registry.refresh();
  return registry;
}

/** 控制台资源路由的回环 base（主进程唯一有权根据 core.lastPort 拼 URL 的地方）。 */
function petLoopbackBase() {
  const port = core?.lastPort || core?.port || 3210;
  return `http://127.0.0.1:${port}`;
}

/**
 * 解析当前设置应使用的皮肤档案（全部经 toPublicSummary，无绝对路径）。
 * 链条：配置 id → qq-agent-default → 内置旧图 default；逐级回落，永不返回 undefined。
 */
function resolvePetSkinSummary(id) {
  const list = petSkinRegistry ? petSkinRegistry.list() : [];
  const wanted = String(id ?? '').trim();
  for (const candidate of [wanted, PET_DEFAULT_SKIN, PET_FALLBACK_SKIN]) {
    if (!candidate) continue;
    const hit = list.find((s) => s && s.id === candidate);
    if (hit) return hit;
  }
  return null;
}

/** 旧内置精灵图（builtin default fallback）的固定回环 URL，pet.html CSP 已移除 file:。 */
function petLegacyAssetUrls() {
  const base = petLoopbackBase();
  return {
    idle: `${base}/pet-legacy-assets/desktop-pet-idle-24.png`,
    work: `${base}/pet-legacy-assets/desktop-pet-spritesheet.png`
  };
}

let mainWindow = null;
let petWindow = null;
let petMenuItem = null;
let petVisibleRequested = false;

// ── 桌宠：设置与状态快照的主进程缓存 ──
// 四项设置的**落盘真相**在 config.ui（由渲染进程走既有共享偏好机制保存），
// 这里只留运行时副本，好在宠物窗口创建/重载瞬间立刻推给它，不必等页面再问一次。
// 状态摘要来自渲染进程 /api/status 轮询的结果，主进程只保留白名单字段。
const PET_BASE_W = 280;                 // 出厂窗口宽度（高度 = 宽 × 320/280）
const PET_BASE_H = 320;
const PET_SIZE_MIN = 150;
const PET_SIZE_MAX = 420;
const PET_SETTING_BOOL_KEYS = ['desktopPetAutoActions', 'desktopPetShowUsage', 'desktopPetShowMood'];
const PET_TEXT_LIMIT = 24;              // moodLabel / energyLabel
const PET_PHRASE_LIMIT = 32;            // emotionPhrases 单条
const PET_PHRASES_MAX = 5;              // emotionPhrases 条数
const PET_COUNT_LIMIT = 1e15;           // token / 次数上限（防异常值）

let petSettings = {
  desktopPetSize: PET_BASE_W,
  desktopPetAutoActions: true,
  desktopPetShowUsage: true,
  desktopPetShowMood: true,
  desktopPetSkin: PET_DEFAULT_SKIN
};
let petSettingsSeeded = false;          // 已从 config.ui 读过一次（读过就不再覆盖运行时改动）
let petStatus = null;                   // 最后一次 pet:status 的白名单摘要 { working, usage, botState }

let tray = null;
let quitting = false;
let quitForceTimer = null;
let quitCheckInProgress = false;
let coreRestarting = false;
let appReloading = false;

async function inspectRendererChanges() {
  const win = mainWindow;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    return { known: false, coreDirty: false, pluginDirty: false };
  }
  let timer = null;
  try {
    const inspect = win.webContents.executeJavaScript(`(async () => {
      const canInspect = typeof flushSettingsSave === 'function'
        && typeof state !== 'undefined'
        && typeof activePluginSection !== 'undefined';
      if (!canInspect) return { known: false, coreDirty: false, pluginDirty: false };
      try { await flushSettingsSave(); } catch { /* 保留 dirty 状态供主进程提示 */ }
      return {
        known: true,
        coreDirty: state.settingsDirty === true,
        pluginDirty: activePluginSection?.dirty === true
      };
    })()`, true);
    const result = await Promise.race([
      inspect,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1800); })
    ]);
    if (timer) clearTimeout(timer);
    if (result && typeof result === 'object') return result;
  } catch (error) {
    if (timer) clearTimeout(timer);
    console.warn('[leave-guard] 无法读取渲染进程未保存状态:', error?.message ?? error);
  }
  return { known: false, coreDirty: false, pluginDirty: false };
}

async function confirmRendererLeave(action) {
  const pending = await inspectRendererChanges();
  if (pending.known && !pending.coreDirty && !pending.pluginDirty) return true;

  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (win && !win.isVisible()) showWindow();
  const changeSummary = pending.known
    ? [pending.coreDirty && '设置页修改', pending.pluginDirty && '插件草稿'].filter(Boolean).join('、')
    : '当前状态暂时无法确认';
  try {
    const options = {
      type: 'warning',
      title: '还有未保存的设置',
      message: `继续${action}可能会丢弃${changeSummary}。`,
      detail: '选择“取消”会留在当前界面，方便保存或检查修改。',
      buttons: [`继续${action}`, '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    };
    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    return response === 0;
  } catch (error) {
    console.error('[leave-guard] 无法显示离开确认框，已取消操作:', error?.message ?? error);
    return false;
  }
}

/**
 * 退出应用：先确认未保存修改，再走优雅退出；3 秒内没退成就强制结束。
 */
async function requestQuit(reason = 'tray') {
  if (quitting) {
    // 已经在退出流程里再点一次 → 直接强杀，避免二次点击也无效
    try { app.exit(0); } catch { /* ignore */ }
    return;
  }
  if (quitCheckInProgress) return;
  quitCheckInProgress = true;
  let canLeave = false;
  try { canLeave = await confirmRendererLeave('退出'); }
  catch (error) { console.error('[leave-guard] 退出确认失败:', error?.message ?? error); }
  if (!canLeave) {
    quitCheckInProgress = false;
    return;
  }
  quitCheckInProgress = false;
  quitting = true;
  setRuntimeStatus('shutdown-requested', { reason });
  console.log(`[quit] 开始退出（${reason}）…`);
  crashLog(`主动退出（${reason}）`, new Error('requestQuit'));

  // 已在主进程确认未保存状态；现在才放行 beforeunload。
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(
        'window.__APP_QUITTING__=true; try{state.settingsDirty=false;}catch(e){}', true
      ).catch(() => {});
    }
  } catch { /* ignore */ }

  // 2) 先拆托盘，避免退出过程中残留死图标
  try { tray?.destroy(); } catch { /* ignore */ }
  tray = null;

  // 3) 兜底强退
  if (quitForceTimer) clearTimeout(quitForceTimer);
  quitForceTimer = setTimeout(() => {
    console.warn('[quit] 优雅退出超时，强制结束进程');
    try { app.exit(0); } catch { /* ignore */ }
  }, 3000);
  try { quitForceTimer.unref?.(); } catch { /* ignore */ }

  app.quit();
}

function applyAutoStart() {
  if (!core) return;
  const cfg = getConfig();
  // 优先读两号共享的 desktop-prefs（号B 里改的也生效）
  const shared = readSharedAutoStart();
  const open = shared !== null ? shared : !!cfg.server?.autoStart;
  lastAutoStartPref = open;
  // 桌面端是从程序目录直接跑的（未打包）：自启项要带上程序目录，多实例再带上自己的 profile，
  // 否则开机后只会拉起一个默认实例。
  const args = app.isPackaged ? [] : [app.getAppPath()];
  if (PROFILE) args.push(`--qq-agent-profile=${PROFILE}`);
  app.setLoginItemSettings({
    openAtLogin: open,
    path: process.execPath,
    args
  });
  watchDesktopPrefs();
}

/**
 * 热重启核心：停掉 createServer 实例再原地拉起，窗口不关、Electron 不退。
 * 适合改了 JS 源码后要生效；改配置优先用 /api/hot-reload（软重载）。
 */
async function hotRestartCore(reason = 'tray') {
  if (coreRestarting) return;
  coreRestarting = true;
  try {
    if (!await confirmRendererLeave('热重启核心')) return;
    const reloadWindow = !!mainWindow && !mainWindow.isDestroyed();

    if (reloadWindow) {
      try {
        mainWindow.webContents.executeJavaScript(
          'window.__APP_NAVIGATING__=true; try{state.settingsDirty=false;}catch(e){}', true
        ).catch(() => {});
      } catch { /* 已由主进程确认，渲染层标记仅用于绕过 beforeunload */ }
    }
    setRuntimeStatus('core-restarting', { reason });
    console.log(`[hot-restart] 开始重启核心（${reason}）…`);
    if (core) {
      try { await core.stop(); } catch (error) {
        console.error('[hot-restart] stop 失败:', error?.message ?? error);
      }
    }
    core = null;
    // ⚠️ Node ESM 按完整 URL 缓存：`?t=` 只刷新 app.js 本身，
    // llm.js / tools.js 等稳定路径依赖仍可能是旧代码。
    // 改到这些文件后请**完全退出 Electron 再启动**，不要只靠热重启。
    const { createServer } = await import(`../server/index.js?t=${Date.now()}`);   // 裁定3：新树入口；?t= 保留用于破缓存
    // 裁定1：createServer 是 async ⇒ 必须 await。
    // 裁定2：显式传 allowProductionData —— 桌面壳是唯一合法的生产入口，它明确声明"我要写生产数据"。
    logger.mirrorConsole = true;   // 与初始启动同形：落盘 + console 双写
    logger.prune?.();              // 热重启也补一次旧日志清理（幂等，代价极小）
    core = await createServer({
      dataDir: resolveDataDir(),
      allowProductionData: true,
      log: (...args) => logger.info('app', args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '))
    }).catch((error) => {
      console.error('[entry] createServer 失败：', error?.message ?? error);
      throw error;   // 交给外层 try/catch 统一收尾，不静默
    });
    const port = await core.start();
    core.lastPort = port;
    setRuntimeStatus('running', { port });
    startResourceSampler();
    // 端口变了 → 宠物页手里的资源 URL base 全部失效，立刻重推快照
    sendPetSnapshot();
    if (reloadWindow && mainWindow && !mainWindow.isDestroyed()) {
      appReloading = true;
      mainWindow.loadURL(`http://127.0.0.1:${port}/`).catch((error) => {
        appReloading = false;
        console.error('[hot-restart] 界面重载失败:', error?.message ?? error);
      });
    }
    createTray();
    console.log(`[hot-restart] 核心已重启，端口 ${port}`);
    console.log('[hot-restart] 提示：若刚改过 llm.js/tools.js，请完全退出 Electron 再启动（ESM 依赖缓存）');
  } catch (error) {
    appReloading = false;
    setRuntimeStatus('core-restart-failed');
    console.error('[hot-restart] 失败:', error);
  } finally {
    coreRestarting = false;
  }
}

function showWindow() {
  if (startupFailureError && !core?.lastPort) {
    showStartupFailure(startupFailureError);
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  } else if (core?.lastPort) {
    createWindow(core.lastPort);
  }
}

function syncPetMenuItem() {
  if (!petMenuItem) return;
  try { petMenuItem.checked = !!petWindow && !petWindow.isDestroyed() && petWindow.isVisible(); } catch { /* tray may be rebuilding */ }
}

// ── 桌宠：设置校验 / 窗口尺寸 / 快照推送 ──

/** 宽度夹到 150~420；非法值退回 fallback（再非法退回出厂 280）。 */
function clampPetSize(value, fallback = PET_BASE_W) {
  const n = Number(value);
  const m = Number.isFinite(n) ? n : Number(fallback);
  const w = Number.isFinite(m) ? Math.round(m) : PET_BASE_W;
  return Math.min(PET_SIZE_MAX, Math.max(PET_SIZE_MIN, w));
}

/** 当前设置对应的窗口尺寸（高度按 320/280 比例推导）。 */
function petWindowSize() {
  const width = clampPetSize(petSettings.desktopPetSize, PET_BASE_W);
  return { width, height: Math.round(width * PET_BASE_H / PET_BASE_W) };
}

/**
 * 校验 pet:configure / config.ui 传进来的设置：只认这五个键，
 * 类型不对的一律丢弃（沿用 base 里的值），尺寸夹到合法区间。
 * desktopPetSkin 只接受与 manifest 一致的 id 语法（单段小写 slug），
 * 非法值保留 base 值——原始任意字符串/路径绝不进入快照与 IPC；
 * "包是否存在"由 resolvePetSkinSummary 在组装快照时逐级回落，
 * 语法合法但暂未安装的 id 允许通过（装好包后原 id 立即生效）。
 */
const PET_SKIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function sanitizePetSettings(patch, base = petSettings) {
  const src = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const next = { ...base };
  if (src.desktopPetSize !== undefined) next.desktopPetSize = clampPetSize(src.desktopPetSize, base.desktopPetSize);
  for (const key of PET_SETTING_BOOL_KEYS) {
    if (typeof src[key] === 'boolean') next[key] = src[key];
  }
  if (src.desktopPetSkin !== undefined) {
    const v = petText(src.desktopPetSkin, 64);
    if (v && PET_SKIN_ID_PATTERN.test(v)) next.desktopPetSkin = v;
  }
  return next;
}

function petCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(PET_COUNT_LIMIT, Math.floor(n));
}

// petText 与 pet.actions 的校验一起搬到了 ./pet-actions-sanitize.js（从那里 import），
// 这里不再自己留一份，免得两处裁剪规则漂移。

/**
 * pet:status 快照 → 只留宠物真正要用的白名单字段。
 * 聊天内容、QQ 昵称/号、token/凭据、完整 config 一律不进这个结构
 * （这里按字段取值，不在白名单里的键直接丢掉）。
 */
function sanitizePetStatus(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const usageRaw = raw.usage && typeof raw.usage === 'object' ? raw.usage : null;
  const botRaw = raw.botState && typeof raw.botState === 'object' ? raw.botState : null;
  const working = raw.working === true;
  const usage = usageRaw ? {
    totalTokens: petCount(usageRaw.totalTokens),
    runs: petCount(usageRaw.runs),
    promptTokens: petCount(usageRaw.promptTokens),
    completionTokens: petCount(usageRaw.completionTokens)
  } : null;
  const botState = botRaw ? {
    moodLabel: petText(botRaw.moodLabel, PET_TEXT_LIMIT),
    energyLabel: petText(botRaw.energyLabel, PET_TEXT_LIMIT),
    emotionPhrases: (Array.isArray(botRaw.emotionPhrases) ? botRaw.emotionPhrases : [])
      .slice(0, PET_PHRASES_MAX)
      .map((p) => petText(p, PET_PHRASE_LIMIT))
      .filter(Boolean)
  } : null;
  if (!usage && !botState && typeof raw.working !== 'boolean') return null;
  return { working, usage, botState };
}

/** 第一次用到设置时从 config.ui 读一次；被 pet:configure 改过就不再覆盖。 */
function seedPetSettings() {
  if (petSettingsSeeded) return;
  try {
    const ui = getConfig()?.ui;
    if (!ui || typeof ui !== 'object') return;
    petSettings = sanitizePetSettings(ui, petSettings);
    petSettingsSeeded = true;
  } catch { /* 核心还没起好：先用默认值，下次再读 */ }
}

/**
 * 当前快照：设置 + 最后一次状态摘要 + 已解析皮肤（宠物页收到的就是这个结构）。
 * skin/fallbackSkin 是 registry 的 public summary（无绝对路径）；资源一律由
 * 主进程按 core.lastPort 拼好的回环 URL base 提供，宠物页不接受/不回传任何路径。
 */
function petSnapshotPayload() {
  const skin = resolvePetSkinSummary(petSettings.desktopPetSkin);
  const isBuiltinLegacy = !skin || skin.renderer === 'builtin' || skin.id === PET_FALLBACK_SKIN;
  const fallbackSkin = skin && !isBuiltinLegacy && skin.id !== PET_DEFAULT_SKIN
    ? resolvePetSkinSummary(PET_DEFAULT_SKIN)
    : null;
  return {
    settings: { ...petSettings },
    status: petStatus,
    skin: isBuiltinLegacy ? null : skin,
    fallbackSkin: fallbackSkin && fallbackSkin.renderer !== 'builtin' ? fallbackSkin : null,
    assetRoot: `${petLoopbackBase()}/pet-skin-assets/`,
    legacy: petLegacyAssetUrls(),
    // 语义状态「何时播」的触发条件（②）：由声明方提交、主进程校验后下发，
    // 求值在桌宠窗口里做；没有声明方时是空数组，行为与今天完全一致。
    stateRules: petStateRulesPayload()
  };
}

function sendPetSnapshot() {
  if (!petWindow || petWindow.isDestroyed()) return false;
  try {
    petWindow.webContents.send('pet:snapshot', petSnapshotPayload());
    return true;
  } catch (error) {
    console.error('[desktop-pet] 推送快照失败:', error?.message ?? error);
    return false;
  }
}

// ── pet.actions 与语义状态规则：主进程只做「校验 + 聚合 + 转发」────────────
// 声明方（插件/技能，跑在控制台窗口里）走 pet:register-actions 提交：
//   · actions    → context-menu 项进桌宠右键菜单；overlay 项推给桌宠窗口按需开面板；
//   · stateRules → 语义状态「何时播」的触发条件，随快照下发给桌宠窗口求值。
// 点击只回传 id 给声明方（pet:action → 控制台窗口），主进程**从不执行**第三方代码。
// 这里的校验与 pet-renderer.js 里的 PET_CONTRACT 是同一份契约的两处实现：
// 信任边界不同（IPC 入口 vs 挂载前），各自校验，坏项一律丢弃只记日志。
// 校验实现抽到了 ./pet-actions-sanitize.js（不 import electron，node 可直接测）：
// 行为与抽取前一致，只是换了存放位置，好处是这条安全边界终于有自动化测试
// （test/pet-sanitize-test.mjs）。常量与白名单也从那里导出，避免两处各写一份。
import {
  PET_ACTION_SLUG, PET_ACTIONS_PER_SOURCE, PET_RULES_PER_SOURCE, PET_ACTION_SOURCES_MAX,
  petText, sanitizePetActions, sanitizePetStateRules
} from './pet-actions-sanitize.js';
// ④「整套新桌宠」的声明侧注册表（纯模块，node 可直接测）：主进程只读 JSON 声明，不执行第三方代码。
import { pickPetPluginDecl, sanitizePetPluginSize, PET_PLUGIN_MAX } from './pet-plugin-registry.js';
// ④ 协议出口：用自定义 scheme 加载插件页，**由宿主强制下发 CSP**（file:// 拿不到响应头 ⇒ CSP 只能靠插件自觉）。
import {
  PET_PLUGIN_USE_CUSTOM_PROTOCOL, PET_PLUGIN_SCHEME, PET_PLUGIN_CSP, petPluginMimeFor,
  parsePetPluginUrl, resolveRequestPath, petPluginNavigationAllowed
} from './pet-plugin-protocol.js';
const petActionSources = new Map();   // sourceId → { actions: [], stateRules: [] }

function petActionsPayload() {
  const out = [];
  for (const entry of petActionSources.values()) {
    for (const action of entry.actions) out.push(action);
  }
  return out;
}

function petStateRulesPayload() {
  const out = [];
  for (const entry of petActionSources.values()) {
    for (const rule of entry.stateRules) out.push(rule);
  }
  return out;
}

function findPetAction(id) {
  for (const [sourceId, entry] of petActionSources) {
    const action = entry.actions.find((a) => a.id === id);
    if (action) return { sourceId, action };
  }
  return null;
}

function pushPetActions() {
  if (!petWindow || petWindow.isDestroyed()) return false;
  try {
    petWindow.webContents.send('pet:actions', petActionsPayload());
    return true;
  } catch (error) {
    console.error('[desktop-pet] 推送 pet.actions 失败:', error?.message ?? error);
    return false;
  }
}

/** 执行一个动作：overlay 先开面板，再把 id 回传给声明方。任何一步失败只记日志。 */
function dispatchPetAction(id) {
  try {
    const hit = findPetAction(petText(id, 64));
    if (!hit) return { ok: false, error: 'unknown action' };
    if (hit.action.place === 'overlay' && petWindow && !petWindow.isDestroyed()) {
      try {
        petWindow.webContents.send('pet:overlay', { id: hit.action.id, spec: hit.action.spec || null });
      } catch (error) {
        console.error('[desktop-pet] 打开悬浮面板失败:', error?.message ?? error);
      }
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('pet:action', { sourceId: hit.sourceId, id: hit.action.id, at: Date.now() });
      } catch (error) {
        console.error('[desktop-pet] 转发动作给声明方失败:', error?.message ?? error);
      }
    }
    return { ok: true };
  } catch (error) {
    console.error('[desktop-pet] pet:invoke-action 失败:', error?.message ?? error);
    return { ok: false, error: 'internal' };
  }
}

/** 按当前设置调窗口尺寸，并把位置夹回所在显示器的 workArea 内。不动透明/置顶/拖动配置。 */
function applyPetWindowBounds() {
  if (!petWindow || petWindow.isDestroyed()) return false;
  const { width, height } = petWindowSize();
  try {
    const cur = petWindow.getBounds();
    // 先放宽上限再收紧，避免"缩小"被旧 maxWidth 卡住、"放大"被旧 minWidth 顶住
    petWindow.setMaximumSize(Math.max(cur.width, width), Math.max(cur.height, height));
    petWindow.setMinimumSize(width, height);
    petWindow.setMaximumSize(width, height);
    const area = screen.getDisplayNearestPoint({
      x: Math.round(cur.x + cur.width / 2),
      y: Math.round(cur.y + cur.height / 2)
    }).workArea;
    const x = Math.min(Math.max(cur.x, area.x), area.x + Math.max(0, area.width - width));
    const y = Math.min(Math.max(cur.y, area.y), area.y + Math.max(0, area.height - height));
    petWindow.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
    return true;
  } catch (error) {
    console.error('[desktop-pet] 调整尺寸失败:', error?.message ?? error);
    return false;
  }
}

/**
 * #9 做法① 位置持久化：把存档坐标放回窗口，再夹进当前 workArea。
 * 坐标来自用户配置 ui.desktopPetX/Y（只有有限数字才认；null/缺失 = 没存过 = 保持默认右下角）。
 * 夹屏复用 applyPetWindowBounds：按窗口中心找最近显示器，屏被拔掉/分辨率变化也不会丢到屏幕外。
 */
function restorePetWindowBounds() {
  if (!petWindow || petWindow.isDestroyed()) return false;
  try {
    const ui = getConfig()?.ui;
    const x = ui?.desktopPetX;
    const y = ui?.desktopPetY;
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
      petWindow.setPosition(Math.round(x), Math.round(y));
    }
  } catch { /* 读不到配置就走创建时的默认位置 */ }
  return applyPetWindowBounds();
}

let petPosSaveTimer = null;
/** 拖动结束后（防抖 400ms）把位置写进用户配置；坐标没变就不落盘 */
function schedulePetPositionSave() {
  if (petPosSaveTimer) clearTimeout(petPosSaveTimer);
  petPosSaveTimer = setTimeout(() => {
    petPosSaveTimer = null;
    if (!petWindow || petWindow.isDestroyed()) return;
    try {
      const b = petWindow.getBounds();
      const ui = getConfig()?.ui;
      if (ui?.desktopPetX === b.x && ui?.desktopPetY === b.y) return;
      // ★ 2026-10-11：updateConfig 只改内存 ⇒ 拖完重启位置回退。改走 updateConfigAndSave（现成落盘出口）。
      updateConfigAndSave({ ui: { desktopPetX: b.x, desktopPetY: b.y } });
    } catch (error) {
      console.error('[desktop-pet] 位置保存失败:', error?.message ?? error);
    }
  }, 400);
}

/** 这两个通道只接受主窗口的调用（宠物页/其它页面拿不到对应 preload 方法）。 */
function fromMainWindow(event) {
  try {
    return !!mainWindow && !mainWindow.isDestroyed() && event?.sender === mainWindow.webContents;
  } catch { return false; }
}

/**
 * ★ 2026-10-17（分发前安全审查）新增：桌宠窗口自己的来源判定。
 *
 * 为什么要单独一个：主窗口桥（preload.cjs）与宠物桥（pet-preload.cjs）**各自**暴露一组
 * IPC，而 Electron 的窗口是按 webContents 区分的 —— 桌宠窗口能调的 pet:hide /
 * pet:toggle-on-top / pet:invoke-action **不该**被主窗口以外的任何窗口调到，反过来也一样。
 * 此前这三个 handler 没有来源判定（只有 pet-plugin:* 与 pet:configure 有）。
 * 单独抽成函数而不是复用 fromMainWindow：两者判的是不同 webContents，混用会把
 * 「桌宠关自己」误判成越权。
 */
function fromPetWindow(event) {
  try {
    return !!petWindow && !petWindow.isDestroyed() && event?.sender === petWindow.webContents;
  } catch { return false; }
}

function hidePetWindow() {
  petVisibleRequested = false;
  if (!petWindow || petWindow.isDestroyed()) return false;
  petWindow.hide();
  syncPetMenuItem();
  return true;
}

function createPetWindow() {
  seedPetSettings();
  // ★ 不用光标所在屏（Gemini 复核第 4 条）：光标可能在另一块屏上，桌宠会"跳到另一块屏"。
  // 口径：**主屏**。取"目标窗口所在屏"在这里做不到（窗口还没建），主屏是确定性的、不会漂。
  const area = screen.getPrimaryDisplay().workArea;
  const { width, height } = petWindowSize();
  petWindow = new BrowserWindow({
    x: Math.round(area.x + area.width - width - 24),
    y: Math.round(area.y + area.height - height - 24),
    width,
    height,
    minWidth: width,
    maxWidth: width,
    minHeight: height,
    maxHeight: height,
    resizable: false,
    movable: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    title: '桌宠',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'pet-preload.cjs')
    }
  });
  petWindow.setAlwaysOnTop(true, 'floating', 1);
  // #9 做法①：有存档就放回原处（内部夹回 workArea）；拖动结束后防抖写回 ui.desktopPetX/Y
  restorePetWindowBounds();
  petWindow.on('move', schedulePetPositionSave);
  // 页面加载完立刻把缓存的设置 + 最后状态摘要推过去（pet:snapshot），
  // 再把已注册的 pet.actions 推过去（面板/右键菜单用）
  petWindow.webContents.on('did-finish-load', () => { sendPetSnapshot(); pushPetActions(); });
  petWindow.once('ready-to-show', () => {
    if (petVisibleRequested && petWindow && !petWindow.isDestroyed()) petWindow.showInactive();
    syncPetMenuItem();
  });
  // ★ 2026-10-17：内置桌宠页同样**一律不许开新窗口**。它不主动开窗，但这是个"默认关"的护栏 ——
  //   万一将来有人往 pet-renderer.js 里塞了一个跳转/开窗，那条路在今天就已经是堵死的。
  petWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  petWindow.webContents.on('context-menu', () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    const template = [
      { label: '显示主界面', click: () => showWindow() },
      { type: 'separator' },
      {
        label: '保持置顶',
        type: 'checkbox',
        checked: petWindow.isAlwaysOnTop(),
        click: (item) => petWindow?.setAlwaysOnTop(item.checked, item.checked ? 'floating' : 'normal', 1)
      },
      { label: '隐藏桌宠', click: () => hidePetWindow() }
    ];
    // pet.actions：第三方声明的 context-menu 项聚合在末尾（点击只回传 id）
    const extra = petActionsPayload().filter((a) => a.place === 'context-menu');
    if (extra.length) {
      template.push({ type: 'separator' });
      for (const action of extra) {
        template.push({ label: action.label, click: () => dispatchPetAction(action.id) });
      }
    }
    try {
      Menu.buildFromTemplate(template).popup({ window: petWindow });
    } catch (error) {
      console.error('[desktop-pet] 右键菜单构建失败:', error?.message ?? error);
    }
  });
  petWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      hidePetWindow();
    }
  });
  petWindow.on('closed', () => {
    petWindow = null;
    petVisibleRequested = false;
    syncPetMenuItem();
  });
  petWindow.loadFile(path.join(__dirname, 'pet.html')).catch((error) => {
    console.error('[desktop-pet] 加载失败:', error?.message ?? error);
    if (petWindow && !petWindow.isDestroyed()) petWindow.destroy();
  });
  return petWindow;
}

function showPetWindow() {
  petVisibleRequested = true;
  // ④ 互斥**双向**（Gemini 复核第 2 条）：原来只有"开插件桌宠会关内置"这一个方向，
  // 反向没做 ⇒ 两个桌宠能同时活着。开内置桌宠时把插件桌宠关掉：一个时刻只有一个桌宠。
  hidePetPluginWindow();
  if (!petWindow || petWindow.isDestroyed()) {
    createPetWindow();
  } else {
    applyPetWindowBounds();   // #9：显示前夹回当前 workArea（隐藏期间换屏/改分辨率不丢屏外）
    petWindow.showInactive();
  }
  syncPetMenuItem();
  return true;
}

function togglePetWindow() {
  return petVisibleRequested ? hidePetWindow() : showPetWindow();
}

function togglePetAlwaysOnTop() {
  if (!petWindow || petWindow.isDestroyed()) return false;
  const next = !petWindow.isAlwaysOnTop();
  petWindow.setAlwaysOnTop(next, next ? 'floating' : 'normal', 1);
  return next;
}

// ── ④「整套新桌宠」：插件自带窗口（默认关 · 需用户显式开启）──────────────────
// 与内置桌宠的边界（刻意写在这里，别让它日后被"顺手统一"掉）：
//   · 内置桌宠窗（petWindow）走 pet.html + pet-preload.cjs，**本块一行都不改它**；
//     没装任何桌宠插件时，本块的所有状态都是空/未启用 ⇒ 托盘菜单与窗口行为与今天逐字节一致。
//   · 插件桌宠是**另一个窗口**（petPluginWindow），跑第三方页面，桥只有 onSnapshot + configure。
//   · 两者**互斥**：启用插件桌宠时把内置的收起来；关掉插件桌宠不自动把内置的弹回来（由用户自己开）。
//   · 位置/尺寸**只在本进程内存里**，**不落盘**：落盘要写 data/config.json（越界，且会与内置桌宠
//     的 desktopPetX/Y 互相打架）。所以"拖动后下次启动回到默认位"是这一版的已知取舍。
let petPluginRegistry = { entries: [], problems: [] };
let petPluginWindow = null;
let petPluginActiveId = '';        // ★ 默认关：空串 = 没有启用任何插件桌宠
let petPluginBounds = null;         // { x, y, width, height } 仅内存
let petPluginAlwaysOnTop = true;
// ★ 自定义协议**真的注册上了**没有。刻意与 PET_PLUGIN_USE_CUSTOM_PROTOCOL 分开：
//   开关是"想用"，这个是"用成了"。注册失败（老 Electron 没有 protocol.handle / 没有 Response）
//   时这里保持 false，窗口加载照旧退回 loadFile —— 否则开关会说谎：
//   "我明明开了协议"，实际 handler 从没装上，页面直接加载失败、桌宠静默消失。
let petPluginProtocolReady = false;

function petPluginsRoot() {
  return path.join(APP_ROOT, 'plugins');
}

/** 重扫声明目录。**只在需要时调**（启动一次 + 用户从托盘点"刷新"），不轮询。 */
function refreshPetPluginRegistry() {
  const res = pickPetPluginDecl(petPluginsRoot(), { log: (m) => console.warn(m) });
  petPluginRegistry = res;
  return res;
}

function findPetPluginDecl(id) {
  return petPluginRegistry.entries.find((e) => e.id === id) || null;
}

/**
 * 插件桌宠拿到的快照：**刻意比内置桌宠窄**。
 * 内置的 petSnapshotPayload() 带 settings / skin / assetRoot / legacy（资源 URL），
 * 那些是给内置渲染页用的；第三方桌宠自带页面，不需要、也不该拿到本机路径与资源根。
 * 这里只给两样：已净化的状态摘要 + 声明方提交的语义状态规则。
 */
function petPluginSnapshotPayload() {
  return { status: petStatus, stateRules: petStateRulesPayload() };
}

function sendPetPluginSnapshot() {
  if (!petPluginWindow || petPluginWindow.isDestroyed()) return false;
  try {
    petPluginWindow.webContents.send('pet-plugin:snapshot', petPluginSnapshotPayload());
    return true;
  } catch (error) {
    console.error('[desktop-pet] 推送插件桌宠快照失败:', error?.message ?? error);
    return false;
  }
}

/** 这条通道只接受**插件桌宠窗口自己**的调用（configure / 首次取快照）。 */
function fromPetPluginWindow(event) {
  try {
    return !!petPluginWindow && !petPluginWindow.isDestroyed() && event?.sender === petPluginWindow.webContents;
  } catch { return false; }
}

function hidePetPluginWindow() {
  if (!petPluginWindow || petPluginWindow.isDestroyed()) {
    petPluginActiveId = '';
    return false;
  }
  try { petPluginWindow.destroy(); } catch { /* 已销毁 */ }
  petPluginWindow = null;
  petPluginActiveId = '';
  return true;
}

function applyPetPluginBounds(entry) {
  if (!petPluginWindow || petPluginWindow.isDestroyed()) return false;
  const size = entry?.size || { width: 320, height: 280 };
  try {
    // ★ 这里能用"目标窗口所在屏"（窗口已存在），所以就用它，取不到才回主屏（Gemini 复核第 4 条）。
    let area = null;
    try { area = screen.getDisplayMatching(petPluginWindow.getBounds()).workArea; } catch { area = null; }
    if (!area) area = screen.getPrimaryDisplay().workArea;
    const b = petPluginBounds || {};
    const x = Number.isFinite(b.x) ? b.x : Math.round(area.x + area.width - size.width - 24);
    const y = Number.isFinite(b.y) ? b.y : Math.round(area.y + area.height - size.height - 24);
    // 夹回当前 workArea：分辨率/任务栏变了也不能把窗口丢到屏幕外找不着
    petPluginWindow.setBounds({
      x: Math.min(Math.max(Math.round(x), area.x), Math.max(area.x, area.x + area.width - size.width)),
      y: Math.min(Math.max(Math.round(y), area.y), Math.max(area.y, area.y + area.height - size.height)),
      width: size.width,
      height: size.height
    });
    return true;
  } catch (error) {
    console.error('[desktop-pet] 应用插件桌宠窗口位置失败:', error?.message ?? error);
    return false;
  }
}

function createPetPluginWindow(entry) {
  hidePetPluginWindow();
  const size = entry.size || { width: 320, height: 280 };
  petPluginAlwaysOnTop = entry.alwaysOnTop !== false;
  petPluginWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: 160,
    minHeight: 120,
    resizable: true,
    movable: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: petPluginAlwaysOnTop,
    skipTaskbar: true,
    show: false,
    title: `桌宠 · ${entry.name}`,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'pet-plugin-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  // 桥是**按窗口**挂的：如果允许这个窗口导航到别的源，那张远端页面也会拿到 onSnapshot/configure。
  // ⇒ 两条都堵死：禁止新开窗口、禁止离开「同一个插件自己的页面」。
  petPluginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  petPluginWindow.webContents.on('will-navigate', (event, url) => {
    // 同插件的页面之间跳（相对链接、锚点）放行；跨插件 / 跨源 / data: / javascript: 一律拦。
    // 判定放在纯模块里（petPluginNavigationAllowed）：它同时管 pet-plugin:// 与回退的 file://
    // 两条路，且**用 fileURLToPath 还原 file URL** —— 手写 new URL().pathname 会把含空格/中文的
    // 路径 percent-encode 后误判成跨源，把插件自己的跳转全挡死（Gemini 实测过）。
    const allowed = petPluginNavigationAllowed(url, {
      pluginId: entry.id, pluginDirAbs: entry.dir, entryAbs: entry.absEntry
    });
    if (allowed) return;
    event.preventDefault();
    console.warn('[desktop-pet] 插件桌宠试图跳到其它页面，已拦下:', url);
  });
  petPluginWindow.on('move', () => {
    if (!petPluginWindow || petPluginWindow.isDestroyed()) return;
    try { petPluginBounds = petPluginWindow.getBounds(); } catch { /* ignore */ }
  });
  petPluginWindow.on('closed', () => { petPluginWindow = null; petPluginActiveId = ''; });
  petPluginWindow.webContents.on('did-finish-load', () => { sendPetPluginSnapshot(); });
  // 入口加载：**协议真的注册上了**才走 loadURL（宿主强制 CSP，见 pet-plugin-protocol.js）；
  // 否则退回 file://（上一批行为）。判据用 petPluginProtocolReady 而不是那个常量本身 ——
  // 否则"开关开着但注册失败"会变成：页面加载失败 → 桌宠静默消失。
  // 两条路的路径都经过注册表校验，协议出口还额外复查一遍 —— 协议不放宽既有防线。
  const loadPromise = petPluginProtocolReady
    ? petPluginWindow.loadURL(petPluginEntryUrl(entry))
    : petPluginWindow.loadFile(entry.absEntry);
  loadPromise.catch((error) => {
    console.error('[desktop-pet] 插件桌宠入口加载失败:', error?.message ?? error);
    hidePetPluginWindow();
  });
  petPluginActiveId = entry.id;
  petPluginWindow.once('ready-to-show', () => {
    try { petPluginWindow?.showInactive(); } catch { /* ignore */ }
    applyPetPluginBounds(entry);
  });
  return petPluginWindow;
}

/** 启用某个插件桌宠（唯一的"开启"入口，由托盘菜单 = 用户显式点击触发）。 */
function enablePetPlugin(id) {
  const entry = findPetPluginDecl(String(id || ''));
  if (!entry) return { ok: false, error: 'unknown pet plugin' };
  hidePetWindow();                 // 互斥：内置的先收起
  createPetPluginWindow(entry);
  return { ok: true, id: entry.id, name: entry.name };
}

function disablePetPlugin() {
  const was = petPluginActiveId;
  hidePetPluginWindow();
  return { ok: true, was };
}

/**
 * 托盘里的「插件桌宠」子菜单。**没装任何桌宠插件时返回空数组** ——
 * 菜单模板与今天逐字节一致，这是"默认关 = 零影响"的一部分。
 */
function petPluginTrayItems() {
  if (!petPluginRegistry.entries.length) return [];
  const active = petPluginActiveId;
  return [
    {
      label: '插件桌宠',
      submenu: [
        ...petPluginRegistry.entries.map((e) => ({
          id: `pet-plugin-${e.id}`,
          label: `${active === e.id ? '✓ ' : ''}${e.name}`,
          type: 'radio',
          checked: active === e.id,
          click: () => { enablePetPlugin(e.id); }
        })),
        { type: 'separator' },
        { label: '关闭插件桌宠', enabled: !!active, click: () => { disablePetPlugin(); } },
        { label: '重新扫描插件桌宠', click: () => { refreshPetPluginRegistry(); } },
        ...(petPluginRegistry.problems.length
          ? [{ label: `（${petPluginRegistry.problems.length} 条声明被跳过，看日志）`, enabled: false }]
          : [])
      ]
    }
  ];
  // ★ 这里**原来还多带了一个 `{ type: 'separator' }`**（Gemini 复核第 3 条）：
  //   托盘模板里 `...petPluginTrayItems()` 后面紧跟着自己的一条 separator，
  //   两个挨在一起 ⇒ 装了插件桌宠时菜单里出现连续两个分隔线。已删。
}

/** 插件 id + entry 相对路径 → 协议 URL（entry 已由注册表规范化过：相对、无 ..、.html）。 */
function petPluginEntryUrl(entry) {
  const rel = String(entry.entry || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return `${PET_PLUGIN_SCHEME}://${entry.id}/${rel}`;
}

/**
 * 注册插件桌宠的自定义协议。**必须在 app.whenReady() 之后调**（protocol.handle 的硬要求，
 * 上一批就是因为没有这一步、只做了纯 node 探针才没暴露出来 ⇒ 这里显式写进注释，别挪位置）。
 * 返回 true/false 表示是否真的接管了加载；失败时上层退回 file://。
 */
function registerPetPluginProtocol() {
  petPluginProtocolReady = false;
  if (!PET_PLUGIN_USE_CUSTOM_PROTOCOL) return false;
  if (typeof protocol?.handle !== 'function') {
    console.warn('[desktop-pet] 这个 Electron 版本没有 protocol.handle，跳过自定义协议（已退回 file://）');
    return false;
  }
  // handler 里要用 Response（主进程的 fetch/undici 全局）。没有就别注册 ——
  // 注册了反而会在第一个请求时抛异常，桌宠窗口加载失败后被静默隐藏，比退回 file:// 糟得多。
  if (typeof Response !== 'function') {
    console.warn('[desktop-pet] 这个运行时没有全局 Response，协议 handler 不可用（已退回 file://）');
    return false;
  }
  protocol.handle(PET_PLUGIN_SCHEME, async (request) => {
    const parsed = parsePetPluginUrl(request.url);
    if (!parsed.ok) {
      console.warn('[desktop-pet] 协议请求被拒（URL 不合法）:', request.url, parsed.problems.join('；'));
      return new Response('bad pet-plugin url', { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    const entry = findPetPluginDecl(parsed.id);
    if (!entry) return new Response('unknown pet plugin', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    // ★ 路径与 MIME 两道都在宿主这边判；不放宽注册表已有的防线（同一套规则，另见协议模块注释）。
    const resolved = resolveRequestPath(entry.dir, parsed.relPath, { realpathSync: fs.realpathSync });
    if (!resolved.abs) {
      console.warn('[desktop-pet] 协议请求被拒（路径越界）:', request.url, resolved.problems.join('；'));
      return new Response('forbidden', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    const mime = petPluginMimeFor(resolved.abs);
    if (!mime) {
      console.warn('[desktop-pet] 协议请求被拒（未知扩展名，不做 text/html 兜底）:', parsed.relPath);
      return new Response('unsupported media type', { status: 415, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    let body;
    try { body = fs.readFileSync(resolved.abs); } catch (error) {
      return new Response('read failed: ' + String(error?.code || ''), { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': mime,
        // ★ 本批的核心：这条 CSP 由宿主写在响应头上，第三方页面改不掉。
        'content-security-policy': PET_PLUGIN_CSP,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store'
      }
    });
  });
  petPluginProtocolReady = true;   // 真的接管了：从这一刻起窗口才走 loadURL
  return true;
}

function createTray() {
  // 热重启会再次调用：必须先销毁旧托盘，否则 Windows 上留下
  // 一个没有菜单/点不动的僵尸图标，右键「退出」就像没反应。
  try { tray?.destroy(); } catch { /* ignore */ }
  tray = null;

  const icon = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(icon);
  tray.setToolTip(INSTANCE_LABEL);

  let autoStartOn = null;
  try { autoStartOn = readSharedAutoStart(); } catch { /* ignore */ }
  if (autoStartOn === null) {
    try { autoStartOn = !!getConfig()?.server?.autoStart; } catch { autoStartOn = false; }
  }

  const menu = Menu.buildFromTemplate([
    { label: `显示主界面（${INSTANCE_LABEL}）`, click: () => showWindow() },
    { label: '暂停 / 恢复', click: () => {
      try { core?.ctx?.orchestrator?.setPaused(!core.ctx.orchestrator.paused); } catch (e) { console.error('[tray] 暂停失败:', e?.message ?? e); }
    } },
    {
      label: '热重启核心（不关窗口）',
      click: () => { hotRestartCore('tray'); }
    },
    {
      label: '重载配置（软）',
      click: async () => {
        try {
          const port = core?.lastPort || core?.port || 3210;
          const r = await fetch(`http://127.0.0.1:${port}/api/hot-reload`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reconnectOneBot: true })
          });
          console.log('[hot-reload] ', await r.text());
        } catch (error) {
          console.error('[hot-reload] 失败:', error?.message ?? error);
        }
      }
    },
    // ★ 2026-10-18 R13：原「切换到号B控制台」入口已移除 —— 它把目标页面写死为
    //   http://127.0.0.1:3221/，不是本实例（INSTANCE_LABEL/自身端口）的能力；
    //   多号使用不该依赖一个固定端口，需要时再按实际实例信息重做入口。
    {
      id: 'desktop-pet-toggle',
      label: '显示桌宠',
      type: 'checkbox',
      checked: !!petWindow && !petWindow.isDestroyed() && petWindow.isVisible(),
      click: (item) => item.checked ? showPetWindow() : hidePetWindow()
    },
    // ④ 插件桌宠：没装声明时 petPluginTrayItems() 返回 []，这一行不产生任何菜单项。
    ...petPluginTrayItems(),
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: autoStartOn,
      click: (item) => {
        try {
          // ★ 2026-10-11：updateConfig 只改内存 ⇒ 勾完重启自启回退。改走 updateConfigAndSave。
          updateConfigAndSave({ server: { autoStart: item.checked } });
          applyAutoStart();
        } catch (e) { console.error('[tray] 自启设置失败:', e?.message ?? e); }
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => requestQuit('tray-menu') }
  ]);
  petMenuItem = menu.getMenuItemById('desktop-pet-toggle');
  tray.setContextMenu(menu);
  tray.on('double-click', () => showWindow());
}

let biliLoginWin = null;
let biliLoginBusy = false;

/** 从 .bilibili.com 会话里拼 Cookie 串（解析视频用 SESSDATA 等）。 */
async function collectBiliCookieString() {
  const cookies = await session.fromPartition('persist:bili-login').cookies.get({ domain: '.bilibili.com' });
  const need = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];
  const map = new Map();
  for (const c of cookies) map.set(c.name, c.value);
  if (!map.get('SESSDATA')) return { cookie: '', hasSessdata: false };
  const parts = need.filter((k) => map.has(k)).map((k) => `${k}=${map.get(k)}`);
  // 顺带带上其它 bilibili 域 cookie，官方接口有时要一串
  for (const c of cookies) {
    if (need.includes(c.name)) continue;
    if (c.name === 'buvid3' || c.name === 'buvid4' || c.name === 'b_nut') {
      parts.push(`${c.name}=${c.value}`);
    }
  }
  return { cookie: parts.join('; '), hasSessdata: true, count: cookies.length };
}

function sendBiliStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('bili:login-status', status);
  }
}

/**
 * 打开 B 站登录窗：登录成功后抓 SESSDATA 写入 config.webSearch.bilibiliCookie。
 * 不需要用户再从浏览器拷 Cookie。
 */
async function openBiliLoginWindow() {
  if (biliLoginBusy) return { ok: false, error: '已有登录窗在打开' };
  biliLoginBusy = true;
  sendBiliStatus({ phase: 'opening' });
  try {
    if (biliLoginWin && !biliLoginWin.isDestroyed()) {
      biliLoginWin.focus();
      biliLoginBusy = false;
      return { ok: true, phase: 'already-open' };
    }
    const ses = session.fromPartition('persist:bili-login');
    biliLoginWin = new BrowserWindow({
      width: 920,
      height: 720,
      title: '登录 B 站',
      autoHideMenuBar: true,
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    });
    Menu.setApplicationMenu(null);
    // ★ 2026-10-17：**登录窗一律不许开子窗口**。这个窗用的是 persist:bili-login 持久分区
    //   （SESSDATA 等长期 cookie 都在里面），而没注册 handler 时子窗口会继承父窗的 session
    //   ⇒ 被登录页里任何一个 window.open 带出来的页面同样带着这些 cookie。这里堵死。
    biliLoginWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    let saved = false;
    const trySave = async (reason) => {
      if (saved) return;
      const { cookie, hasSessdata } = await collectBiliCookieString();
      if (!hasSessdata || !cookie) return;
      saved = true;
      try {
        // ★ 2026-10-11：updateConfig 只改内存 ⇒ 登录完重启 Cookie 回退。改走 updateConfigAndSave。
        updateConfigAndSave({ webSearch: { bilibiliCookie: cookie } });
        console.log(`[bili-login] 已写入 cookie（${cookie.length} 字符，来源 ${reason}）`);
        sendBiliStatus({ phase: 'saved', reason, at: Date.now() });
        if (biliLoginWin && !biliLoginWin.isDestroyed()) {
          setTimeout(() => { try { biliLoginWin.close(); } catch { /* ignore */ } }, 600);
        }
      } catch (error) {
        console.error('[bili-login] 写入配置失败:', error?.message ?? error);
        sendBiliStatus({ phase: 'error', error: String(error?.message ?? error) });
      }
    };

    const onCookieChanged = (_e, cookie, cause, removed) => {
      if (removed) return;
      if (cookie?.name === 'SESSDATA' && cookie?.domain?.includes('bilibili.com')) {
        trySave('cookie-changed');
      }
    };
    ses.cookies.on('changed', onCookieChanged);

    biliLoginWin.on('closed', () => {
      ses.cookies.removeListener('changed', onCookieChanged);
      biliLoginWin = null;
      biliLoginBusy = false;
      sendBiliStatus({ phase: saved ? 'saved' : 'closed' });
    });

    biliLoginWin.webContents.on('did-navigate', () => trySave('navigate'));
    biliLoginWin.webContents.on('did-navigate-in-page', () => trySave('navigate-in-page'));
    biliLoginWin.webContents.on('did-finish-load', () => trySave('did-finish-load'));

    await biliLoginWin.loadURL('https://passport.bilibili.com/login');
    sendBiliStatus({ phase: 'opened' });
    return { ok: true, phase: 'opened' };
  } catch (error) {
    biliLoginBusy = false;
    sendBiliStatus({ phase: 'error', error: String(error?.message ?? error) });
    return { ok: false, error: String(error?.message ?? error) };
  }
}

// ★ 2026-10-17：来源判定。此前 bili:login / ui:set-titlebar / win:* / ui:set-zoom /
//   pet:toggle 这 8 个 handler 谁都能 invoke。单独看每条都"只动界面"，但它们叠在一起
//   是一条可被复用的能力链（弹 B 站登录窗 → 改标题栏颜色 → 最小化/关窗 → 改缩放），
//   而窗口继承（见 createWindow 里的 setWindowOpenHandler 注释）会让**任何从本窗口开出来的
//   子窗口**都拿到同一个 preload 桥。现在统一只认主窗口的 webContents。
ipcMain.handle('bili:login', async (event) => {
  if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
  return openBiliLoginWindow();
});

// 标题栏系统按钮（最小化/最大化/关闭）：底色/图标色跟界面主题 + 亮度走
const TITLEBAR_OVERLAY_HEIGHT = 42;
const TITLEBAR_PRESETS = {
  // 与 ui/style.css 暗色 token 对齐（比系统默认再压一档）
  dark: { color: '#1c1c1f', symbolColor: '#ececf1' },
  light: { color: '#f0f0f3', symbolColor: '#1d1d1f' },
  // maid 液态玻璃顶栏渐变端色，系统按钮区与 #topbar 融为一体
  maid: { color: '#0c1830', symbolColor: '#eef4fb' }
};
function normalizeHexColor(val) {
  if (typeof val !== 'string') return null;
  const s = val.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  }
  if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s)) {
    return s.slice(0, 7).toLowerCase();
  }
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  if (m) {
    const hex = (n) => Math.min(255, Math.max(0, Number(n) || 0)).toString(16).padStart(2, '0');
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
  }
  return null;
}
function applyTitleBarOverlay(opts = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (process.platform !== 'win32') return false;
  const theme = opts.theme === 'light' ? 'light' : 'dark';
  const preset = TITLEBAR_PRESETS[theme] || TITLEBAR_PRESETS.dark;
  const color = normalizeHexColor(opts.color) || preset.color;
  const symbolColor = normalizeHexColor(opts.symbolColor) || preset.symbolColor;
  try {
    mainWindow.setTitleBarOverlay({
      color,
      symbolColor,
      height: TITLEBAR_OVERLAY_HEIGHT
    });
    return true;
  } catch (error) {
    console.error('[titlebar] setTitleBarOverlay 失败:', error?.message ?? error);
    return false;
  }
}
ipcMain.handle('ui:set-titlebar', async (event, opts) => {
  if (!fromMainWindow(event)) return false;
  return applyTitleBarOverlay(opts || {});
});
// 自绘窗口控制：系统 titleBarOverlay 压在网页之上，画不了鎏金线、也难与顶栏渐变对齐
ipcMain.handle('win:minimize', (event) => {
  if (!fromMainWindow(event)) return false;
  mainWindow?.minimize();
  return true;
});
ipcMain.handle('win:maximize', (event) => {
  if (!fromMainWindow(event)) return false;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMaximized()) { mainWindow.unmaximize(); return false; }
  mainWindow.maximize();
  return true;
});
ipcMain.handle('win:close', (event) => {
  if (!fromMainWindow(event)) return false;
  // 与标题栏关闭同一路径：closeToTray 时 hide，真正退出走托盘
  mainWindow?.close();
  return true;
});
ipcMain.handle('pet:hide', (event) => (fromPetWindow(event) ? hidePetWindow() : false));
ipcMain.handle('pet:toggle-on-top', (event) => (fromPetWindow(event) ? togglePetAlwaysOnTop() : false));
ipcMain.handle('pet:toggle', (event) => (fromMainWindow(event) ? togglePetWindow() : false));
// 桌宠设置：校验五项 → 调窗口尺寸（高宽比 320/280、位置夹在 workArea 内）→ 推新快照。
// 设置的落盘仍由渲染进程走既有 config.ui / 共享桌面偏好机制，这里只管运行时缓存。
// 换肤路径：configure 进来先重扫一遍皮肤根目录（新装的包立即可用），再按解析结果推快照。
ipcMain.handle('pet:configure', (event, options) => {
  if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
  seedPetSettings();
  petSettings = sanitizePetSettings(options);
  petSettingsSeeded = true;
  applyPetWindowBounds();
  refreshPetSkins()
    .catch((error) => console.error('[desktop-pet] 皮肤扫描失败:', error?.message ?? error))
    .finally(() => sendPetSnapshot());
  return { ok: true, settings: { ...petSettings } };
});
// pet.actions / 语义状态规则注册：只接受主窗口（声明方跑在控制台页面里）。
// 主进程**不执行**任何第三方代码，也不接受任何可执行内容：只有 id / label / place /
// 声明式 spec 与条件树。注册失败只影响该来源，桌宠照常跑。
ipcMain.handle('pet:register-actions', (event, payload) => {
  if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
  const src = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const sourceId = petText(src.sourceId, 64);
  if (!PET_ACTION_SLUG.test(sourceId)) return { ok: false, error: 'bad sourceId' };
  const actions = sanitizePetActions(src.actions, sourceId);
  const rules = sanitizePetStateRules(src.stateRules);
  const problems = actions.problems.concat(rules.problems);
  if (problems.length) console.warn(`[desktop-pet] ${sourceId} 的声明有问题（坏项已跳过）：${problems.join('；')}`);
  if (!actions.actions.length && !rules.rules.length) {
    petActionSources.delete(sourceId);
    pushPetActions();
    return { ok: true, count: 0, rules: 0, problems };
  }
  if (!petActionSources.has(sourceId) && petActionSources.size >= PET_ACTION_SOURCES_MAX) {
    return { ok: false, error: 'too many sources', problems };
  }
  petActionSources.set(sourceId, { actions: actions.actions, stateRules: rules.rules });
  pushPetActions();
  sendPetSnapshot();     // stateRules 走快照下发
  return { ok: true, count: actions.actions.length, rules: rules.rules.length, problems };
});
// 桌宠窗口点菜单/面板按钮 → 只回一个 id，实现在声明方那边
ipcMain.handle('pet:invoke-action', (event, id) => (fromPetWindow(event) ? dispatchPetAction(id) : false));
// /api/status 轮询的最小摘要：只留白名单字段后缓存，并转给宠物页。
// 不在这里发任何网络请求；桌宠隐藏时渲染进程也不必再调它。
ipcMain.on('pet:status', (event, snapshot) => {
  if (!fromMainWindow(event)) return;
  petStatus = sanitizePetStatus(snapshot);
  sendPetSnapshot();
  sendPetPluginSnapshot();   // ④：插件桌宠若开着，同一份已净化摘要也给它一份
});
// ── ④「整套新桌宠」的 IPC 面 ─────────────────────────────────────────────
// 三个通道，鉴权各不同，别混：
//   pet-plugin:list / enable / disable / refresh ← **只接受主窗口**（= 用户在托盘/设置里操作）
//   pet-plugin:configure                        ← **只接受插件桌宠窗口自己**（它调来改自己的尺寸/置顶）
//   pet-plugin:snapshot-request                 ← **只接受插件桌宠窗口自己**（注册时补第一帧）
ipcMain.handle('pet-plugin:list', (event) => {
  if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
  return {
    ok: true,
    active: petPluginActiveId,
    max: PET_PLUGIN_MAX,
    entries: petPluginRegistry.entries.map((e) => ({ id: e.id, name: e.name, size: e.size, alwaysOnTop: e.alwaysOnTop })),
    problems: petPluginRegistry.problems.slice(0, 20)
  };
});
ipcMain.handle('pet-plugin:refresh', (event) => {
  if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
  // 正在开着的那份若在重扫后没了（用户删了目录）⇒ 关掉它，不留一个指向空路径的窗口
  const res = refreshPetPluginRegistry();
  if (petPluginActiveId && !findPetPluginDecl(petPluginActiveId)) hidePetPluginWindow();
  return { ok: true, count: res.entries.length, problems: res.problems.slice(0, 20) };
});
ipcMain.handle('pet-plugin:enable', (event, id) => {
  if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
  return enablePetPlugin(id);
});
ipcMain.handle('pet-plugin:disable', (event) => {
  if (!fromMainWindow(event)) return { ok: false, error: 'unauthorized' };
  return disablePetPlugin();
});
ipcMain.handle('pet-plugin:configure', (event, options) => {
  if (!fromPetPluginWindow(event)) return { ok: false, error: 'unauthorized' };
  const src = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const entry = findPetPluginDecl(petPluginActiveId);
  if (!entry || !petPluginWindow || petPluginWindow.isDestroyed()) return { ok: false, error: 'no active pet plugin' };
  // 只看三个键：尺寸按注册表的同一套夹紧规则，置顶只接受布尔。
  const base = entry.size || { width: 320, height: 280 };
  const size = sanitizePetPluginSize({ width: src.width ?? base.width, height: src.height ?? base.height });
  const top = typeof src.alwaysOnTop === 'boolean' ? src.alwaysOnTop : petPluginAlwaysOnTop;
  petPluginAlwaysOnTop = top;
  try {
    petPluginWindow.setAlwaysOnTop(top, top ? 'floating' : 'normal', 1);
    applyPetPluginBounds({ size });
  } catch (error) {
    console.error('[desktop-pet] 插件桌宠 configure 失败:', error?.message ?? error);
    return { ok: false, error: 'apply failed' };
  }
  return { ok: true, size, alwaysOnTop: top };
});
ipcMain.on('pet-plugin:snapshot-request', (event) => {
  if (!fromPetPluginWindow(event)) return;
  sendPetPluginSnapshot();
});
// 界面缩放：整页 zoomFactor，解决「卡牌/控件全是 px、不跟缩放」
function clampZoom(z) {
  const n = Number(z);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(0.8, n));
}
ipcMain.handle('ui:set-zoom', async (event, z) => {
  if (!fromMainWindow(event)) return false;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    mainWindow.webContents.setZoomFactor(clampZoom(z));
    return true;
  } catch (error) {
    console.error('[zoom] setZoomFactor 失败:', error?.message ?? error);
    return false;
  }
});
ipcMain.handle('ui:get-zoom', (event) => {
  if (!fromMainWindow(event)) return 1;
  if (!mainWindow || mainWindow.isDestroyed()) return 1;
  try { return mainWindow.webContents.getZoomFactor() || 1; } catch { return 1; }
});

/**
 * 是不是"本机控制台自己"的页面。**只认回环地址 + 32xx 控制台端口**。
 *
 * 与 createWindow 里的 allowedNavRe 分工：那条管「能不能**导航**主窗口」（只放行首页形态，
 * 因为切号只需要换首页）；这条管「能不能从主窗口**开新窗口**」（插件面板这类要带子路径，
 * `/api/plugin/<id>/panel`，见 ui/app.js 的 window.open）。两条都只信 127.0.0.1 + 32\d{2}。
 *
 * 为什么按 URL 对象解析而不是正则通吃：正则挡不住 `http://127.0.0.1:3210@evil.com/` 这类
 * userinfo 混淆，也挡不住 `http://evil.com/?x=http://127.0.0.1:3210/`。判 hostname/port 本身
 * 才不会看错“谁是主机”。
 */
function isConsoleOrigin(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl || '')); } catch { return false; }
  return u.protocol === 'http:' && u.hostname === '127.0.0.1' && /^32\d{2}$/.test(u.port);
}

function createWindow(port) {
  // 本实例首页；账号胶囊切到号B后，加载失败不要无脑拽回号A
  const homeUrl = `http://127.0.0.1:${port}/`;
  // 允许在 3210~3239 控制台之间跳（账号标签页切换）
  const allowedNavRe = /^http:\/\/127\.0\.0\.1:32\d{2}\/?(\?.*)?$/;
  mainWindow = new BrowserWindow({
    // 以最小尺寸打开：不拉满屏幕、不最大化，需要时用户自己拖大。
    width: 960,
    height: 640,
    minWidth: 960,
    minHeight: 640,
    maximizable: true,
    fullscreenable: true,
    title: INSTANCE_LABEL,
    backgroundColor: '#1a1722',
    autoHideMenuBar: true,
    icon: ICON_PATH,
    show: false,
    // 无边框标题 + UI 自绘窗口按钮（可与顶栏鎏金线贯通、与藏青渐变同色）
    // 不用系统 titleBarOverlay：它叠在网页上，颜色/金线都管不住
    titleBarStyle: 'hidden',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });
  Menu.setApplicationMenu(null);
  // ready-to-show 可能永远不来 → 1s 强制亮相；窗口默认 show:true 也兜底
  let shown = false;
  const showOnce = () => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  };
  mainWindow.once('ready-to-show', showOnce);
  setTimeout(showOnce, 1000);
  mainWindow.webContents.on('did-finish-load', () => {
    showOnce();
  });
  // 加载超时也把窗口叫出来，避免一直黑屏
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) showOnce();
  }, 3000);
  // 账号切换：只放行本机控制台端口；其它导航（外链等）拦下
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!allowedNavRe.test(String(url || ''))) {
      console.warn('[window] 已拦截导航:', url);
      event.preventDefault();
    }
  });
  // ★ 2026-10-17（分发前安全审查新增）：**开新窗口**此前完全没有把关。
  //   Electron 官方文档（webContents#did-create-window）对合并规则的原文是
  //   「parsed options from the features string of window.open()、
  //     **security-related webPreferences inherited from the parent**、
  //     options given by webContents.setWindowOpenHandler」
  //   —— 不注册 handler 时，子窗口**继承父窗的安全相关 webPreferences**，本窗的
  //   preload.cjs 就在其中。也就是说：界面上任何一个 target="_blank" / window.open
  //   （ui/app.js 里有插件面板、模型给的链接、外链展示三处）开出来的页面，
  //   都拿到 `window.qqAgent` 这把桥，能弹 B 站登录窗、关主窗口、改缩放。
  //   这里两道一起上：
  //     ① 非本机控制台来源一律 deny（外链不再能开窗；界面上已有 href，用户自己复制也行）。
  //     ② 本机来源放行，但**显式覆盖掉继承来的 preload**（子窗只当普通页面，不给它桥）。
  //        插件面板仍能正常开（同一回环源），只是不再自动获得 IPC 桥 —— 它本来也没用过。
  //   双保险说明：即使将来 Electron 改了 overrideBrowserWindowOptions 的合并语义、
  //   preload:null 没真被清掉，上面那一批 ipcMain handler 也都有来源判定了（fromMainWindow /
  //   fromPetWindow），桥在被继承的窗口里只是一堆空操作。
  mainWindow.webContents.setWindowOpenHandler((details) => {
    const target = String(details?.url || '');
    if (isConsoleOrigin(target)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: {
            preload: null,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        }
      };
    }
    console.warn('[window] 已拦截新开窗口（非本机控制台来源）:', target);
    return { action: 'deny' };
  });
  // 程序化退出 / 核心热重启时，渲染进程的 beforeunload 若 preventDefault，
  // Electron 默认会弹「离开此页面?」把导航/关窗卡死。这里对这两种主动行为放行。
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    // ⚠️ Electron 该事件没有 allowUnload() 方法（2026-09-21 修：旧代码是幻觉 API，
    // 每次托盘退出都抛 TypeError 进 crash.log，且 unload 未被真正放行，
    // 只能靠 requestQuit 的 3 秒强退计时器兜底）。放行 = preventDefault()：
    // 阻止「beforeunload 的阻止行为」，导航/关窗即被允许。
    if (quitting || appReloading) event.preventDefault();
  });
  mainWindow.webContents.on('did-navigate', () => {
    appReloading = false;
  });
  // ★ 2026-10-17（白屏收口）：页面加载失败以前**只静默 2 秒重试** —— 服务没起来/端口不对/端口被占时，
  //   用户看到的就是一个纯底色空窗（就是本次截图里的实况），没有任何可定位信息。现在：
  //   前 3 次仍自动重试（瞬时启动竞态能自愈），之后把失败**摆进主窗口**并写 crash.log，停止空转重试。
  let loadFailures = 0;
  let loadFailureShown = false;
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    const failed = String(url || '');
    // 切到号B失败：提示一下，**不要**强行 loadURL 回号A（以前会“点了没反应/弹回来”）
    if (failed && failed !== homeUrl && allowedNavRe.test(failed)) {
      console.error(`[window] 实例页加载失败: ${failed} (${code} ${desc})。可在浏览器打开该地址。`);
      return;
    }
    loadFailures += 1;
    console.error(`[window] 页面加载失败(${loadFailures}):`, code, desc, url);
    if (loadFailures < 4) {
      setTimeout(() => mainWindow?.loadURL(homeUrl).catch(() => {}), 2000);
      return;
    }
    if (loadFailureShown) return;
    loadFailureShown = true;
    const failure = new Error(`界面加载失败（连续 ${loadFailures} 次）：HTTP 加载 ${code} ${desc} → ${failed || homeUrl}`);
    crashLog('界面加载失败', failure);
    showStartupFailure(failure, mainWindow);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    // ★ 2026-10-17（白屏收口）：渲染进程消失以前这里**没有**任何处理 ⇒ 窗口就一直停在纯底色空窗，
    //   用户完全不知道发生了什么。现在写 crash.log，并把原因摆进主窗口（不再静默装成"正常空页"）。
    crashLog(`渲染进程消失 reason=${details?.reason ?? ''} code=${details?.exitCode ?? ''}`, JSON.stringify(details || {}));
    if (quitting) return;
    showStartupFailure(
      new Error(`渲染进程消失（reason=${details?.reason ?? '未知'}，exitCode=${details?.exitCode ?? '未知'}）—— 界面已无法继续。`),
      mainWindow
    );
  });
  mainWindow.webContents.on('unresponsive', () => {
    crashLog('渲染进程无响应（可能 OOM 或主线程死循环）', new Error('unresponsive'));
  });
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  mainWindow.loadURL(homeUrl).catch((error) => console.error('[window] loadURL 失败:', error));
  // 关窗默认缩到托盘（真正退出走托盘菜单），符合"常驻机器人"的使用习惯
  mainWindow.on('close', (event) => {
    if (quitting) return;
    if (getConfig().server?.closeToTray !== false) {
      event.preventDefault();
      mainWindow.hide();
      return;
    }
    // closeToTray=false 时也要趁 renderer 还活着先检查草稿；等 window-all-closed 再检查已太迟。
    event.preventDefault();
    void requestQuit('window-close');
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

/**
 * 启动期失败必须**看得见**。
 *
 * ★ 2026-10-04 实测（用户报"新树的 UI 渲染不出来"）：`app.whenReady()` 的 catch 原本只
 *   `console.error + app.exit(1)` —— 而启动器的 console 是隐藏窗口，于是用户看到的只是
 *   **"双击了，什么都没发生"**；原因（例如"同一数据目录已有实例在跑"）只在 crash.log 里，
 *   没人会去看。这里开一个最小窗口把原因摆出来，并且**不立即退出**（读完再关）。
 */
function escapeHtmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showStartupFailure(error, targetWindow = null) {
  try {
    const text = String(error?.message ?? error ?? '未知错误');
    const hint = /已有实例在跑|同一数据目录/.test(text)
      ? '看起来已经有另一个实例占着同一个数据目录（旧机器人/另一个标签页）。把它停掉，或删掉它旁边那个 instance.lock 再来。'
      : /EADDRINUSE/.test(text)
        ? '控制台端口被占用：先关掉占用该端口的进程，再启动本程序。'
        : /dataDir|生产数据目录/.test(text)
          ? '数据目录被拒：检查 QQ_AGENT_DATA_DIR 指向哪儿（生产目录需要显式声明）。'
          : /界面加载失败|渲染进程消失/.test(text)
            ? '本地控制台页面没能加载成功：先看上面的错误码/地址；服务若在跑，可稍后重开本程序再试。'
            : '完整堆栈已写入 crash.log。';
    const html = '<!doctype html><meta charset="utf-8"><title>QQ Agent · 启动失败</title>'
      + '<body style="font:14px/1.7 system-ui;padding:26px;color:#e8e8ea;background:#1b1b1f">'
      + '<h2 style="margin:0 0 12px">QQ Agent 启动失败</h2>'
      + '<pre style="white-space:pre-wrap;word-break:break-all;background:#26262c;padding:12px;border-radius:8px">'
      + escapeHtmlText(text) + '</pre>'
      + `<p style="color:#b9b9c6">${escapeHtmlText(hint)}</p>`
      + `<p style="color:#7d7d8a;font-size:12px">日志：${escapeHtmlText(CRASH_LOG)}</p>`
      + '<p style="color:#7d7d8a;font-size:12px">关掉这个窗口即可退出（实例锁会随之释放）。</p></body>';
    // ★ 2026-10-17（白屏收口）：允许把这张失败页**直接装进现有窗口** —— 首屏（本地控制台页）
    //   加载失败时用主窗口本身展示原因，用户不用在一个纯底色空窗背后再去找 760×440 的小窗。
    const target = targetWindow && typeof targetWindow.isDestroyed === 'function' && !targetWindow.isDestroyed()
      ? targetWindow : null;
    const existing = startupFailureWindow && !startupFailureWindow.isDestroyed() ? startupFailureWindow : null;
    const win = target || existing || new BrowserWindow({ width: 760, height: 440, title: 'QQ Agent · 启动失败' });
    if (!target && !existing) {
      startupFailureWindow = win;
      win.once('closed', () => {
        if (startupFailureWindow === win) startupFailureWindow = null;
        if (startupFailureError && !quitting) app.quit();
      });
    }
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch((loadError) => {
      crashLog('启动失败页加载失败', loadError);
      dialog.showErrorBox('QQ Agent · 启动失败', text);
    });
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return win;
  } catch (e) {
    console.error('[entry] 连失败窗口都没开出来:', e?.message ?? e);
    return null;
  }
}

app.whenReady().then(async () => {
  try {
    console.log(`[instance] ${INSTANCE_LABEL} · 数据目录 ${instanceLock.dir} · Electron 配置目录 ${USER_DATA_DIR}`);
    // 应用只访问本机回环地址：强制直连，防止系统代理（Clash/加速器等）劫持 127.0.0.1 导致白/黑屏
    await session.defaultSession.setProxy({ mode: 'direct' });
    console.log('[window] 代理模式：direct（绕过系统代理）');
    const { createServer } = await import('../server/index.js');   // 裁定3：新树入口
    logger.mirrorConsole = true;   // log 既落盘又照旧进 console（logger 默认即 true，这里显式声明意图）
    logger.prune?.();              // 号A 此前从不跑 prune（只在 server.js 被调），7 天清理/256MB 截断从未生效
    core = await createServer({
      dataDir: resolveDataDir(),
      allowProductionData: true,   // 裁定2：桌面壳是生产启动器，显式声明
      log: (...args) => logger.info('app', args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '))
    }).catch((error) => {
      console.error('[entry] createServer 失败：', error?.message ?? error);
      throw error;   // 交给外层 try/catch（打 [electron] 启动失败 并 app.exit(1)）
    });
    // 先启动服务拿到真实端口，再开窗口。
    // 原先是 createWindow(core.lastPort ?? 3210) 在前、core.start() 在后 ——
    // 此时 lastPort 尚未赋值，窗口恒按 3210 加载；若端口被占用顺延到 3211+，
    // 首屏必然加载失败，只能靠 did-fail-load 2 秒重试兜底。
    const port = await core.start();
    core.lastPort = port;
    setRuntimeStatus('running', { port });
    startResourceSampler();
    // 皮肤根目录首扫（./pet-skins → 项目根 pet-skins）；失败不阻塞启动，
    // resolvePetSkinSummary 会逐级回落到内置旧图 default。
    await refreshPetSkins().catch((error) => console.error('[desktop-pet] 皮肤首扫失败:', error?.message ?? error));
    seedPetSettings();      // 桌宠设置先从 config.ui 读进缓存（后续 pet:configure 覆盖）
    // ④ 插件桌宠协议出口注册：**必须在 ready 之后**（protocol.handle 的硬要求）。
    // 失败只打日志并退回 file://，不影响任何既有功能。
    registerPetPluginProtocol();
    // ④ 插件桌宠声明首扫（plugins/*/pet-plugin.json）：失败不阻塞启动，
    // 没装任何桌宠插件时注册表是空的 ⇒ 托盘菜单与今天完全一致（默认关 = 零影响）。
    refreshPetPluginRegistry();
    await createWindow(port);
    applyAutoStart();
    createTray();
  } catch (error) {
    startupFailureError = error;
    setRuntimeStatus('startup-failed');
    console.error('[electron] 启动失败:', error);
    // 失败要留痕（crash.log）+ 要看得见（窗口）—— 见 showStartupFailure 的注释
    crashLog('启动失败', error);
    showStartupFailure(error);
  }
});

// 窗口全部真正关掉了（closeToTray 路径会 hide、不会走到这里）→ 直接退出。
app.on('window-all-closed', () => {
  if (!quitting) void requestQuit('window-all-closed');
});

app.on('before-quit', () => {
  quitting = true;
  setRuntimeStatus('before-quit');
  stopResourceSampler();
  try { releaseInstanceLock(); } catch { /* ignore */ }
  // stop() 是 async：这里不 await，避免卡住 Electron 的退出序列；
  // 卡住时由 requestQuit 设的强制超时兜底。
  try {
    const p = core?.stop?.();
    if (p && typeof p.catch === 'function') p.catch((e) => console.error('[quit] core.stop 失败:', e?.message ?? e));
  } catch (e) {
    console.error('[quit] core.stop 异常:', e?.message ?? e);
  }
});
