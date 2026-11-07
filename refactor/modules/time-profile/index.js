/**
 * 峰期 / 谷期独立回复概率（2026-10-22 她要的：「群内峰期谷期独立回复概率」）
 *
 * 为什么单开一层：QQ-Agent 原来的群回复概率只有一条来源 —— `store.contextSliderPos`
 * 派生的 `store.randomPercent`（档 3）。一个值管全天，晚上群里人多和凌晨只剩两个人时
 * 用的是一样的意愿。这里给它加一条「按时段」的覆写：命中峰期窗口用 `peakPercent`，
 * 其余时间用 `offPeakPercent`。
 *
 * 边界写死在这里，免得散到两个调用点各自解释：
 *   · 只作用于群聊（caller 负责判断 kind），私聊永远不经过本模块；
 *   · `enabled !== true` 时返回 null，调用方原样沿用滑条派生值（等于没装）；
 *   · 窗口可以跨零点（如 19:00 → 01:00），按「起点 ≤ 现在 < 终点」判定，左闭右开；
 *   · 概率一律夹在 0..100，坏值走 fallback，不抛。
 *
 * 配置形状（`store.timeProfile`，可在 perChat[chatKey] 里覆盖同名字段）：
 *   { enabled, peakStart: '19:00', peakEnd: '23:45', peakPercent, offPeakPercent, perChat: {} }
 */

const DEFAULTS = {
  peakStart: '19:00',
  peakEnd: '23:45',
  peakPercent: 35,
  offPeakPercent: 8
}

function toMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

function clampPercent(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(100, n))
}

/** 左闭右开；起点 > 终点 视为跨零点 */
function inWindow(nowMin, startMin, endMin) {
  if (startMin === endMin) return true
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin
  return nowMin >= startMin || nowMin < endMin
}

/**
 * 解析某个群的时段概率。
 *
 * @param {(keyPath: string, fallback?: any) => any} readCfg 读配置的函数（注入 cfg.get 的闭包）
 * @param {string} chatKey  形如 'group:123456'
 * @param {number} [nowMs]  便于测试的时间注入
 * @returns {{ percent: number, phase: 'peak'|'offPeak', source: string } | null}
 *          null = 这一层不生效，调用方原样用滑条派生值
 */
export function resolveGroupReplyPercent(readCfg, chatKey, nowMs = Date.now()) {
  if (typeof readCfg !== 'function') return null
  // ★ 整块读出来再取字段，别用 'store.timeProfile.peakPercent' 这种点号子键：
  //   config-store 的 get() 是否解析到「默认表里的对象的子字段」不由我们说了算，
  //   整块读只依赖一个键，稳妥得多（自测里就踩到过子键取不到）。
  let profile = null
  try { profile = readCfg('store.timeProfile', null) } catch { profile = null }
  if (!profile || typeof profile !== 'object') return null
  if (profile.enabled !== true) return null

  const perChat = profile.perChat && typeof profile.perChat === 'object' ? profile.perChat : null
  const per = perChat && chatKey && perChat[chatKey] && typeof perChat[chatKey] === 'object' ? perChat[chatKey] : null

  const pick = (key) => {
    if (per && Object.hasOwn(per, key)) return per[key]
    if (Object.hasOwn(profile, key)) return profile[key]
    return DEFAULTS[key]
  }

  const startMin = toMinutes(pick('peakStart'))
  const endMin = toMinutes(pick('peakEnd'))
  const peakPercent = clampPercent(pick('peakPercent'), DEFAULTS.peakPercent)
  const offPeakPercent = clampPercent(pick('offPeakPercent'), DEFAULTS.offPeakPercent)
  if (startMin === null || endMin === null) return null

  const at = new Date(nowMs)
  const nowMin = at.getHours() * 60 + at.getMinutes()
  const peak = inWindow(nowMin, startMin, endMin)
  return {
    percent: peak ? peakPercent : offPeakPercent,
    phase: peak ? 'peak' : 'offPeak',
    source: per ? 'timeProfile.perChat' : 'timeProfile'
  }
}
