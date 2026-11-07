/**
 * 聚焦窗口状态机（用户 2026-10-12 补充规格；2026-10-12 实现）
 *
 * 两条入口：
 *   · mention（@ 触发）：最长 5 分钟（保底）；**只有第一次 @ 建立窗口**（活跃期内重复 @ 不重置计时）；
 *     到点暂停，须再次 @ 才重新打开；窗口内必须回复的对象只有 @ 它的那个人。
 *   · keyword（关键词唤醒）：窗口 1 分钟；同样"必回"（不走抽样闸），判定更严（与角色本身相关才接）；
 *     话题转移立刻截止（由判定结果驱动 close）。
 *
 * 归属同话题状态机（§8.2 口径）：状态由调用方（orchestrator）按账号+会话持有；
 * 本模块提供纯内存实现 + 序列化，"命中后开窗/到点关窗"的调用时机在接线请求里（luna2）。
 * 纯内存、无 I/O；时间全部由调用方注入，便于确定性自测。
 */

export const MENTION_WINDOW_MS = 5 * 60 * 1000;   // @ 窗口：最长 5 分钟（保底）
export const KEYWORD_WINDOW_MS = 60 * 1000;       // 关键词窗口：1 分钟

function keyOf(accountId, chatKey) {
  return `${String(accountId ?? '')}|${String(chatKey ?? '')}`;
}

/**
 * @param {{now?:()=>number}} [opts]
 */
export function createFocusRegistry(opts = {}) {
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const windows = new Map();   // key → { kind, target, trigger, openedAt, expiresAt }

  function snapshot(w) {
    return w ? { ...w } : null;
  }

  return {
    /**
     * @param {{accountId?:string, chatKey:string, target?:string, at?:number}} p
     *   target = @ 它的那个人的平台身份（窗口的唯一回复对象）。
     *   指挥位裁定（2026-10-12）：同目标的 mention 窗口活跃期内重复 @ 不重置（只有第一次建立）；
     *   但**他人 @ / 关键词窗期间的 @ → 开（接管）新 mention 窗**——被 @ 是明确点名，任何时候都成立。
     * @returns {{opened:boolean, reason?:string, window:object|null}}
     */
    openMention({ accountId = '', chatKey, target = '', at = nowFn() } = {}) {
      const k = keyOf(accountId, chatKey);
      const t = String(target ?? '');
      const existing = windows.get(k);
      if (existing && at < existing.expiresAt && existing.kind === 'mention' && existing.target === t) {
        // 同一窗口的重复 @：不重置、不延长、不换目标。
        return { opened: false, reason: 'already-active', window: snapshot(existing) };
      }
      // 其余情形（他人 @ 换目标 / 关键词窗被 @ 接管 / 已过期）→ 重开 mention 窗
      const w = { kind: 'mention', accountId: String(accountId ?? ''), chatKey: String(chatKey ?? ''), target: t, trigger: '', openedAt: at, expiresAt: at + MENTION_WINDOW_MS };
      windows.set(k, w);
      return { opened: true, window: snapshot(w) };
    },

    /**
     * @param {{accountId?:string, chatKey:string, target?:string, trigger?:string, at?:number}} p
     *   target = 触发关键词的发起人（裁定：关键词窗口**只回发起人**）。
     *   任何活跃窗口（mention 或 keyword）期内重复命中都不重置；**mention 活跃期不会被关键词缩短**。
     */
    openKeyword({ accountId = '', chatKey, target = '', trigger = '', at = nowFn() } = {}) {
      const k = keyOf(accountId, chatKey);
      const existing = windows.get(k);
      if (existing && at < existing.expiresAt) {
        return { opened: false, reason: 'already-active', window: snapshot(existing) };
      }
      const w = { kind: 'keyword', accountId: String(accountId ?? ''), chatKey: String(chatKey ?? ''), target: String(target ?? ''), trigger: String(trigger ?? '').slice(0, 120), openedAt: at, expiresAt: at + KEYWORD_WINDOW_MS };
      windows.set(k, w);
      return { opened: true, window: snapshot(w) };
    },

    /**
     * 当前状态。active=false 时 reason：none=从未开 / expired=到点（**超时暂停，须再次触发**）/
     * closed=判定提前退出（或手动关）。
     */
    check({ accountId = '', chatKey, at = nowFn() } = {}) {
      const w = windows.get(keyOf(accountId, chatKey));
      if (!w) return { active: false, reason: 'none', window: null };
      // 提前退出（closedAt）优先于到期判定：close 会把 expiresAt 收到关闭时刻，
      // 否则下一次 check 会把它误报成 expired（两种停用原因必须可区分）。
      if (w.closedAt != null) return { active: false, reason: 'closed', window: snapshot(w) };
      if (at >= w.expiresAt) return { active: false, reason: 'expired', window: snapshot(w) };
      return { active: true, reason: 'active', window: snapshot(w), remainingMs: w.expiresAt - at };
    },

    /** 云判定提前退出（"这件事过去了"/话题转移/手动）。 */
    close({ accountId = '', chatKey, reason = 'judged-ended', at = nowFn() } = {}) {
      const k = keyOf(accountId, chatKey);
      const w = windows.get(k);
      if (!w) return null;
      const closed = { ...w, closedAt: at, closeReason: String(reason).slice(0, 64), expiresAt: Math.min(w.expiresAt, at) };
      windows.set(k, closed);
      return snapshot(closed);
    },

    /** 这条消息的发送者是不是本窗口"必须回复的对象"？（裁定：mention=@ 它的人；keyword=发起人；两者都只回这一个人）*/
    isReplyTarget({ accountId = '', chatKey, senderId } = {}) {
      const st = this.check({ accountId, chatKey });
      if (!st.active) return false;
      return String(senderId ?? '') !== '' && String(senderId) === String(st.window.target ?? '');
    },

    serialize() {
      return { version: 1, windows: [...windows.values()].map((w) => ({ ...w })) };
    },

    restore(data) {
      windows.clear();
      if (!data || data.version !== 1 || !Array.isArray(data.windows)) return false;
      for (const w of data.windows) {
        if (!w || (w.kind !== 'mention' && w.kind !== 'keyword') || typeof w.expiresAt !== 'number') continue;
        windows.set(keyOf(w.accountId, w.chatKey), { ...w });
      }
      return true;
    },

    reset() { windows.clear(); return { ok: true }; }
  };
}
