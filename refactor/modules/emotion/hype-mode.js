/**
 * M7 emotion · 亢奋模式（**照老树 `src/hype-mode.js` 补齐**）
 *
 * 语义逐字保真自 src/hype-mode.js:51 —— `getConfig().hypeMode?.enabled === true`：
 * 只读、**只能手动切**、绝不由情绪自动判定。
 *
 * ★ 本模块唯一的一处越界：为兑现 §3.5 的冻结名，必须读 core/config-store。
 *   亢奋开关是「配置」不是「情绪状态」，所以它**不进** state、不参与衰减、不出现在 snapshot 里，
 *   避免两套真相。已在回执登记，等指挥位拍板（见 refactor/modules/emotion/README.md）。
 *
 * ★★ 票 N30 补齐（老树有、新树缺 ⇒ 一律照老树）：
 *   改前本文件只有 `isHypeMode()` 一个函数（20 行），老树 287 行里另有 5 个出口全部缺失：
 *   · `getHypeProtectedQQ()` —— 硬保护 QQ（`config.hypeMode.protectedQQ`）
 *   · `isHypeProtectedTarget()` / `sanitizeHypeProtectedArgs()` —— 亢奋时净化 @/拍一拍目标
 *   · `HYPE_TOOLS` —— 亢奋模式只保留的工具表
 *   · `hypeStatus()` —— 给 UI 的状态快照
 *   · `hypeAutoExitDue()` —— 情绪触发的「到点自动退」（用户 2026-10-03 口径）
 *   其中前四个是**纯读**（可直接用）；`setHypeMode()` 的三个副作用（换模型/换人设/砍工具）
 *   写的是 config + bot-state，**归属装配层**（`apps/server/console-api.js:904-967` 已在做），
 *   本模块**不重复实现**，避免两套真相。
 */
import { get } from '../../core/config-store/index.js';

/** 读 `hypeMode.<key>`；读不到/类型不符一律回落 `dflt`（**不抛** —— 亢奋是可选功能）。 */
function hypeCfg(key, dflt = undefined) {
  try {
    const v = get(`hypeMode.${key}`);
    return v === undefined || v === null ? dflt : v;
  } catch {
    return dflt;
  }
}

/** @returns {boolean} 当前是否处于亢奋模式（配置读不到时保守判 false） */
export function isHypeMode() {
  try {
    return get('hypeMode.enabled') === true;
  } catch {
    return false;
  }
}

/**
 * 亢奋模式硬保护 QQ。发行版默认空 = 不锁任何人。
 * 可在 config.hypeMode.protectedQQ 配置。
 * 逐字照老树 `src/hype-mode.js:59-67`（含 `^\d{5,15}$` 校验：只认纯数字 QQ 号）。
 */
export function getHypeProtectedQQ() {
  const s = String(hypeCfg('protectedQQ', '') ?? '').trim();
  return /^\d{5,15}$/.test(s) ? s : '';
}

/** @deprecated 兼容旧引用；请用 getHypeProtectedQQ()（老树同名字段，恒空） */
export const HYPE_PROTECTED_QQ = '';

/** 亢奋模式只保留的工具：会发言就行。逐字照老树 `src/hype-mode.js:73`。 */
export const HYPE_TOOLS = Object.freeze(['send_message', 'finish']);

/** 仅亢奋模式下判断目标是否受保护；关掉亢奋后不拦。逐字照老树 `src/hype-mode.js:76-82`。 */
export function isHypeProtectedTarget(id) {
  if (!isHypeMode()) return false;
  const lock = getHypeProtectedQQ();
  if (!lock) return false;
  const s = String(id ?? '').trim();
  return s === lock || s === `qq_${lock}`;
}

/**
 * 亢奋模式下净化 @/拍一拍目标：受保护账号直接剥掉。
 * 逐字照老树 `src/hype-mode.js:85-99`。
 * @returns {{args:object, strippedAt:boolean, blockedPoke:boolean}} 原样返回入参（未净化时）
 */
export function sanitizeHypeProtectedArgs(args = {}) {
  if (!isHypeMode()) return { args, strippedAt: false, blockedPoke: false };
  const next = { ...args };
  let strippedAt = false;
  let blockedPoke = false;
  if (isHypeProtectedTarget(next.atUserId)) {
    next.atUserId = null;
    strippedAt = true;
  }
  if (isHypeProtectedTarget(next.targetUserId)) {
    next.targetUserId = null;
    blockedPoke = true;
  }
  return { args: next, strippedAt, blockedPoke };
}

/**
 * 情绪触发的亢奋到点了没有（"5 分钟自动退"，用户口径 2026-10-03）。
 *
 * 关键点三条（老树 `src/hype-mode.js:248-268` 原注，逐字保留）：
 *   ① **只对情绪触发的那次生效** —— 手动开的亢奋（reason 不以 `emotion(` 开头）永不自动退；
 *   ② **群里没消息也退** —— 由 orchestrator 的独立心跳（30 秒一跳）调用，不依赖有没有人来消息；
 *   ③ 进入时刻存在 `hypeMode.stats` 里（写盘），所以重启后照样能算到点。
 *
 * ★ 本函数**只判不执行**：真正执行退出的写配置在装配层（`setHypeMode` 的三个副作用）。
 *   新树没有 `stats.reason` 的写入方（`console-api.js:928` 写死 `'manual'`）⇒
 *   情绪触发的亢奋目前**根本进不来**，这里恒返回 `manual(...)`。**这是缺口，不是 bug** ——
 *   触发侧属 `orchestrator`（别人域），本票不碰，已在回执点名。
 *
 * @param {number} [now]
 * @returns {{due:boolean, reason:string, leftMs?:number, overMs?:number}}
 */
export function hypeAutoExitDue(now = Date.now()) {
  if (hypeCfg('enabled') !== true) return { due: false, reason: 'off' };
  const stats = hypeCfg('stats', null) || {};
  const reason = String(stats.reason || '');
  if (!reason.startsWith('emotion(')) return { due: false, reason: `manual(${reason || 'unknown'})` };
  const min = Math.max(0, Number(hypeCfg('emotionAutoExitMin', 0)) || 0);
  if (min <= 0) return { due: false, reason: 'auto-exit-off' };
  const at = Number(stats.enteredAt) || 0;
  if (!at) return { due: false, reason: 'no-entered-at' };
  const leftMs = at + min * 60000 - now;
  if (leftMs > 0) return { due: false, reason: `wait(${Math.ceil(leftMs / 1000)}s)`, leftMs };
  return { due: true, reason: `emotion-auto-exit(${min}min)`, overMs: -leftMs };
}

/**
 * 给 UI 用的状态快照。逐字照老树 `src/hype-mode.js:270-286`。
 * 差别一处（已标注）：老树从 `getConfig()` 一次读全，这里逐键读 `hypeMode.*` / `persona.*` / `api.*`
 * —— 因为本模块只被允许读 config-store 的点接口（见文件头越界说明）。
 */
export function hypeStatus() {
  return {
    enabled: hypeCfg('enabled') === true,
    model: String(hypeCfg('model', '') || ''),
    restoreModel: String(hypeCfg('restoreModel', '') || '') || 'qwen3.8-flash',
    systemMode: String(hypeCfg('systemMode', '') || '') || 'full',
    hasRoleText: !!String(hypeCfg('roleText', '') || '').trim(),
    emotionThreshold: Number(hypeCfg('emotionThreshold', 70)) || 70,
    emotionAutoExitMin: Number(hypeCfg('emotionAutoExitMin', 0)) || 0,
    enteredAt: Number((hypeCfg('stats', null) || {}).enteredAt) || 0,
    enterReason: String((hypeCfg('stats', null) || {}).reason || ''),
    currentModel: String(safeGet('api.model', '') || ''),
    currentSystemMode: String(safeGet('persona.systemMode', '') || ''),
    tools: safeGet('api.tools', []) || []
  };
}

function safeGet(path, dflt) {
  try {
    const v = get(path);
    return v === undefined || v === null ? dflt : v;
  } catch {
    return dflt;
  }
}
