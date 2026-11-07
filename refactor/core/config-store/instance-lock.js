// 运行标记：同一个数据目录（= 同一个 QQ 号 + 同一份配置）只允许一个 QQ Agent 进程在跑。
// 为什么需要：两个进程同时连同一个 OneBot，群消息会被处理两次、回复也会发两遍。
// 多实例的正确姿势是每个实例独立数据目录（QQ_AGENT_PROFILE / QQ_AGENT_DATA_DIR），
// 那样各自的 instance.lock 互不干扰，可以同时运行。
//
// ⚠️ 2026-09-22：加了**心跳**，因为"进程还在"并不等于"实例还在跑"。
//   踩过的坑：一夜里重启几次后，号B 连续 5 次启动失败（data-2/logs 里刷着
//   「[启动失败] 2 已在运行（pid=…）」），但那个 pid 是上一次被 taskkill 掉的残留
//   （或 pid 被复用），锁却早没人管了 —— 表现就是"双击了 .bat，只有号A起来了"。
//   现在锁里记 `beatAt`，运行中的实例每 45 秒续一次；冲突时只有
//   「pid 活着 **且** 心跳不超过 90 秒」才算真占用，否则接管并在日志里说明。
//   （刻意不用"探测控制台端口"那招：控制台端口是启动时才定的，锁写在前头，
//     猜错了就会把真在跑的实例判成残留 —— 反而更危险。）
//
// ★ 搬运自 src/instance-lock.js（2026-10-04，M1）。**行为逐字保真**，只改三处适配：
//   ① `import { DATA_DIR, PROFILE_ID } from './config.js'` → 改成从 `./data-dir.js` 取（同一套解析，不依赖 src/**）；
//   ② 模块级的 `const LOCK_FILE = path.join(DATA_DIR, 'instance.lock')` → 改成 `lockFile()` **函数**，
//      **每次调用时**才解析 —— 这样 `load({dataDir})` 换了目录后实例锁跟着换，
//      且**模块加载期不做任何盘上动作**（票面硬要求）；
//   ③ 其余逻辑、常量（BEAT_MS / STALE_MS / CONFLICT_*）、返回形状、错误兜底**一个字没改**。
//   锁文件的**格式与路径规则没动**（仍是 `<dataDir>/instance.lock`，线上实例正在用它做心跳）。
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './data-dir.js';
import { PROFILE_ID } from './defaults.js';

const BEAT_MS = 45_000;        // 心跳间隔
const STALE_MS = 90_000;       // 超过这个没心跳 = 残留锁（是心跳间隔的 2 倍，容忍一次丢拍）
// 冲突时最多盯着锁看这么久，判断"主人到底还在不在续心跳"。
const CONFLICT_WAIT_MS = 50_000;   // 略大于一个心跳周期：活着的主人必定会在这里面续一次
const CONFLICT_POLL_MS = 5_000;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** ★ 适配②：锁文件路径**调用时**才解析（不碰盘、也不是模块级常量）。 */
function lockFile() { return path.join(resolveDataDir(), 'instance.lock'); }

/**
 * 读锁。兼容两种格式：
 *   · 新：`{"pid":123,"port":3220,"profile":"","at":169…,"beatAt":169…}`
 *   · 旧：纯 pid 字符串 `123`
 */
function readLock() {
  try {
    const raw = String(fs.readFileSync(lockFile(), 'utf8')).trim();
    if (!raw) return { pid: 0, port: 0, profile: '', at: 0, beatAt: 0, legacy: false };
    if (raw.startsWith('{')) {
      const j = JSON.parse(raw);
      return {
        pid: Number(j?.pid) || 0,
        port: Number(j?.port) || 0,
        profile: String(j?.profile ?? ''),
        at: Number(j?.at) || 0,
        beatAt: Number(j?.beatAt) || 0,
        legacy: false
      };
    }
    return { pid: Number(raw) || 0, port: 0, profile: '', at: 0, beatAt: 0, legacy: true };
  } catch {
    return { pid: 0, port: 0, profile: '', at: 0, beatAt: 0, legacy: false };
  }
}

/** 进程是否还活着（signal 0 只做存在性探测；EPERM 表示存在但不属于我们）。 */
function isAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function writeLock(port = 0) {
  const now = Date.now();
  fs.writeFileSync(lockFile(), JSON.stringify({
    pid: process.pid,
    port: Number(port) || 0,
    profile: PROFILE_ID || '',
    at: now,
    beatAt: now
  }), 'utf8');
}

/**
 * 盯一会儿看心跳会不会前进 —— 这是唯一能识破"pid 被复用"的判据。
 *
 * 为什么需要（2026-10-03 实测，号B 整晚没起来）：
 *   重启时旧号B 的 pid 9840 被系统分给了**新起的 llama-server.exe**，于是
 *   `isAlive(9840)` 为真、心跳又只过去 55 秒（< 90 秒）→ 判成"已有实例在跑"→ `exit(1)`。
 *   而真正活着的主人每 45 秒会续一次 beatAt；被复用的那个进程永远不会碰这个文件。
 *   所以：冲突时最多等 CONFLICT_WAIT_MS，看 beatAt 有没有前进 —— 动了才让路。
 *
 * @returns {Promise<{alive: boolean, beat: number}>}
 */
async function watchHeartbeat(beat, { waitMs = CONFLICT_WAIT_MS, pollMs = CONFLICT_POLL_MS } = {}) {
  const started = Date.now();
  const deadline = started + Math.max(0, Number(waitMs) || 0);
  while (Date.now() < deadline) {
    await sleep(Math.max(50, Number(pollMs) || CONFLICT_POLL_MS));
    const now = readLock();
    if (!isAlive(now.pid)) return { alive: false, beat: 0 };            // 主人死了
    const nowBeat = now.beatAt || now.at || 0;
    if (nowBeat > beat) return { alive: true, beat: nowBeat };          // 心跳动了 = 真在跑
  }
  return { alive: false, beat: 0 };
}

/**
 * 占住当前数据目录。返回 { ok:true } 表示可以继续启动；
 * { ok:false, pid } 表示已有同数据目录的实例**确实在跑**，调用方应当退出。
 *
 * @param {{conflictWaitMs?: number, conflictPollMs?: number}} [opts]
 *   冲突观察窗口（只为测试可调；生产用默认值）。
 */
export async function acquireInstanceLock(opts = {}) {
  const info = { lockFile: lockFile(), profile: PROFILE_ID || '默认', dir: resolveDataDir() };
  try {
    fs.mkdirSync(resolveDataDir(), { recursive: true });
    const lock = readLock();
    if (isAlive(lock.pid)) {
      // 老格式锁没有任何时间信息 → 保守挡住（宁可让人手动删锁，也不冒险双开）；
      // 新格式看心跳：超时没续命就是残留锁，接管。
      if (lock.legacy) return { ...info, ok: false, pid: lock.pid };
      const beat = lock.beatAt || lock.at || 0;
      const fresh = beat > 0 && Date.now() - beat < STALE_MS;
      if (fresh) {
        // 心跳"新鲜"还不够 —— pid 会被复用（见 watchHeartbeat 注释）。
        // 盯一个心跳周期：还在续 = 真有实例在跑，让路；一直不动 = 残留/pid 被复用，接管。
        const seen = await watchHeartbeat(beat, {
          waitMs: opts.conflictWaitMs,
          pollMs: opts.conflictPollMs
        });
        if (seen.alive) return { ...info, ok: false, pid: lock.pid };
        info.waitedMs = CONFLICT_WAIT_MS;
        info.tookOver = {
          pid: lock.pid,
          reason: `pid 活着但心跳 ${Math.round((Date.now() - beat) / 1000)}s 没动（pid 可能已被复用）`
        };
      } else {
        info.tookOver = {
          pid: lock.pid,
          reason: `进程还在但 ${Math.round((Date.now() - beat) / 1000)}s 没心跳`
        };
      }
    }
    writeLock(0);
    return { ...info, ok: true, pid: process.pid };
  } catch (error) {
    // 锁只是保险丝：数据目录写不进去时不要拦住启动
    return { ...info, ok: true, degraded: true, error: error?.message ?? String(error) };
  }
}

/**
 * 续心跳（运行中的实例定时调用；顺便把真实控制台端口写进锁里，方便排查）。
 * 只有锁还是自己的才写，免得把别人的锁覆盖掉。
 */
export function touchInstanceLock(port = 0) {
  try {
    const lock = readLock();
    if (lock.pid !== process.pid) return false;
    writeLock(Number(port) || lock.port || 0);
    return true;
  } catch {
    return false;
  }
}

/** 心跳定时器（unref，不挡住退出）。 */
export function startInstanceHeartbeat(getPort = () => 0) {
  const t = setInterval(() => { touchInstanceLock(typeof getPort === 'function' ? getPort() : 0); }, BEAT_MS);
  t.unref?.();
  return t;
}

/** 退出时释放（只删自己写的那份，避免误删别的实例的标记）。 */
export function releaseInstanceLock() {
  try {
    if (readLock().pid === process.pid) fs.unlinkSync(lockFile());
  } catch { /* ignore */ }
}

/** 给日志/界面用的一句话说明。 */
export function describeInstance() {
  return PROFILE_ID ? `实例 ${PROFILE_ID}` : '主实例';
}