/**
 * 接话聚焦 · 批次与"连续 NO"状态机（用户 2026-10-16 C10 规格；**独立模块**，未接线）
 *
 * 规格逐条落地（阈值与语义都来自用户裁定，**不要在本模块里再调**）：
 *   · **开窗**：机器人**每次实际发言（已确认投递）之后**开一个**至多 20 秒**的接话聚焦窗口；
 *     活跃期再调 `open()` = 只刷新到期时间。
 *   · ★ **判中即刷新（用户 2026-10-16 更正）**：`YES` 判定**本身就**把连续 NO 计数清零，
 *     并把窗口截止时间刷新为**判中时刻 + 20 秒** —— **不等待 QQ 实际发出回复**。
 *     若随后确实回复，按"实际发言后"规则可再 `open()` 一次（续窗）。
 *     到点且没有新消息/没有判中 ⇒ 自然关闭（`check().reason === 'expired'`）。
 *   · **收集**：窗口内**所有人的新消息**都收（按发言人分桶）；判定用消息自己的时间比 `openedAt`，
 *     **早于开窗的旧消息不收**（`reason='before-window'` —— 调用方应把它走正常队列，别静默丢弃）；
 *     窗口不活跃时 `collect()` 一律忽略
 *     —— **关闭后不靠普通消息自启**（等下一次已有触发——尤其直接 @——让机器人发言之后才重开）。
 *   · **分批**：同一发言人的消息攒成一个**短批次**（默认 1.5 秒静默 / 条数上限 8）；
 *     `dueBatch(at)` 给出"到点可判"的批次 + **下一次到点时刻 `dueAt`**，调用方据此起**一个延迟唤醒**
 *     ⇒ **绝不无消息轮询，也绝不每条消息各发一次云调用**。**一个批次只含一个发言人的原文**
 *     （不同人的消息不合并进同一次判定；判定输入按发言人隔离）。
 *   · **容量上限（全部有界，防内存/请求失控）**：单批 ≤8 条（超出取最新、其余计 `dropped`）；
 *     单发言人未到点队列 ≤32（超出丢最旧、计 `droppedPending`）；单窗跟踪 ≤64 个发言人
 *     （超出 `reason='too-many-speakers'`）；"已处理过"的 id 近期集合 ≤256（FIFO，防同一消息重复判定）。
 *     **被容量丢弃的消息与 SKIP 一样不计入连续 NO**。
 *   · **连续 NO（全局、跨发言人；用户 2026-10-16 更正：按"实际消息条数"计）**：
 *     一个批次里若有 N 条**真的被判定了**的消息、整批判 NO ⇒ 连续计数 **+N**（不是 +1）；
 *     `YES` ⇒ 清零（并即刻刷新窗口）；连续计数达到 `noLimit`（默认 **5**）⇒ **立即关窗**。
 *     被容量丢弃的（`dropped` / `droppedPending`）与 `SKIP`（超时 / 预算拒绝 / 解析失败 / 尚在队列）
 *     **一律不计数**。
 *   · **SKIP（不计入 NO）**：超时 / 预算拒绝 / 解析失败 / 尚在队列 —— 记 `SKIP`：**既不 +1、也不清零**；
 *     它们照样**占用并释放顺序号**，以免后面的结果被卡住。
 *   · **顺序**：批次在 `dueBatch()` 发出时拿 `seq`（= 消息到达顺序，单调、**跨窗口连续**）；
 *     判定结果允许**乱序返回**：只有按顺序号连续时才推进计数，先到的后序结果先缓冲 ——
 *     **并发返回顺序不得篡改"实际发言顺序"的连续计数**。关窗/到期后迟到的旧结果按 `stale-seq` 丢弃。
 *
 * 本模块**纯内存 + 纯状态**：无 I/O、无定时器、无云调用；时间一律由调用方注入 `at`（便于确定性核对）。
 * 接线（何时开窗 / 何时唤醒 / 用哪个角色调云判定 / YES 之后怎么回复）在 orchestrator —— 见文件尾 + 回执的接口方案。
 */

export const FOLLOWUP_WINDOW_MS = 20 * 1000;        // 聚焦窗口上限（用户裁定：20 秒）
export const FOLLOWUP_BATCH_MS = 1500;              // 同发言人短批次静默（用户裁定：约 1–2 秒）
export const FOLLOWUP_NO_LIMIT = 5;                 // 连续实际 NO 达 5 ⇒ 立即关窗（用户裁定）
export const FOLLOWUP_MAX_MESSAGES_PER_BATCH = 8;   // 单批条数上限（超出的取**最新**的，其余计 dropped）
export const FOLLOWUP_MAX_PENDING_PER_SPEAKER = 32; // 单发言人未到点队列上限（超出丢最旧 ⇒ 计 droppedPending、不计 NO）
export const FOLLOWUP_MAX_SPEAKERS = 64;            // 单窗跟踪的发言人上限（超出不再收新发言人，reason='too-many-speakers'）
export const FOLLOWUP_RECENT_ID_CAP = 256;          // "已处理过"的消息 id 近期集合上限（防同一消息被重复判定）

const VALID_VERDICTS = new Set(['YES', 'NO', 'SKIP']);

function keyOf(accountId, chatKey) {
  return `${String(accountId ?? '')}|${String(chatKey ?? '')}`;
}

/**
 * @param {{now?:()=>number, windowMs?:number, batchMs?:number, noLimit?:number}} [opts]
 *   `now/windowMs/batchMs/noLimit` 只是**便于核对时注入**；生产用上面常量（用户裁定的阈值）。
 */
export function createFollowupRegistry(opts = {}) {
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const windowMs = Number.isFinite(Number(opts.windowMs)) && Number(opts.windowMs) > 0 ? Number(opts.windowMs) : FOLLOWUP_WINDOW_MS;
  const batchMs = Number.isFinite(Number(opts.batchMs)) && Number(opts.batchMs) >= 0 ? Number(opts.batchMs) : FOLLOWUP_BATCH_MS;
  const noLimit = Number.isInteger(Number(opts.noLimit)) && Number(opts.noLimit) >= 1 ? Number(opts.noLimit) : FOLLOWUP_NO_LIMIT;
  /** key → 会话状态（每账号 × 每会话一份；与 focus.js 的 mention/keyword 窗口互不干扰）。 */
  const chats = new Map();

  function ensure(accountId, chatKey) {
    const k = keyOf(accountId, chatKey);
    let st = chats.get(k);
    if (!st) {
      st = {
        accountId: String(accountId ?? ''), chatKey: String(chatKey ?? ''),
        opened: false, openedAt: 0, refreshedAt: 0, expiresAt: 0, openCount: 0,
        openReason: '', closedReason: '', closedAt: undefined,
        yesRefreshAt: 0, yesRefreshes: 0,   // ★ 判中刷新（YES ⇒ 截止时间 = 判中时刻 + 20 秒，不等回复）
        noStreak: 0, awaitingReplyAfterYes: false,
        seq: 0,                 // 已下发的最大顺序号（跨窗口连续，关窗**不重置**）
        resolvedThrough: 0,     // 已按顺序连续应用到的最大 seq
        discardThrough: 0,      // 关窗/到期时作废的下发号上限（迟到结果 ⇒ stale-seq）
        pending: new Map(),     // speakerId → [{ id, at }]（未到点、未下发）
        inFlight: new Map(),    // seq → { speakerId, count }（已下发、等结果）
        buffered: new Map(),    // seq → { verdict, at, judgedCount }（乱序先到、等前序）
        recentIds: new Map()    // id → at：**已进过批次 或 被容量丢弃**的消息（有界 FIFO，防重复判定）
      };
      chats.set(k, st);
    }
    return st;
  }

  /**
   * 显式关窗（no-streak / 手动）：**清掉在途与缓冲**并推进 `discardThrough` —— 关窗后迟到的结果一律
   * `stale-seq`（用户裁定：关窗后不自动重开，等下一次实际发言）。
   */
  function abandon(st, at, reason) {
    st.opened = false;
    st.closedReason = String(reason ?? 'manual').slice(0, 64);
    st.closedAt = at;
    st.expiresAt = Math.min(st.expiresAt || at, at);
    st.pending.clear();
    st.inFlight.clear();
    st.buffered.clear();
    st.noStreak = 0;                 // 关窗后从 0 起（用户裁定：等新触发重开）
    st.awaitingReplyAfterYes = false;
    st.discardThrough = Math.max(st.discardThrough, st.seq);
    st.resolvedThrough = Math.max(st.resolvedThrough, st.seq);
  }

  /**
   * ★ 自然到期的**惰性**处理（用户 2026-10-16 更正后的口径）：
   * 只清"还没下发的 `pending`"，**保留在途/缓冲** —— 因为**判中（YES）本身就要刷新窗口**，
   * 而判定可能在窗口到期后才返回；提前把在途结果作废会把该刷新的 YES 一起丢掉。
   */
  function expireLazy(st, at) {
    if (st.opened !== true || at < st.expiresAt) return st;
    st.opened = false;
    st.closedReason = 'expired';
    st.closedAt = at;
    st.expiresAt = Math.min(st.expiresAt, at);
    st.pending.clear();
    // 在途/缓冲**不清**，`discardThrough`/`resolvedThrough` 也不推进 ⇒ 迟到的 NO/YES 仍按序应用
    return st;
  }

  /** 若已到期 ⇒ 先做一次自然关窗清理（幂等；迟到消息不会漏进下一窗）。 */
  function expireIfNeeded(st, at) {
    return expireLazy(st, at);
  }

  /**
   * ★ 记一条"已经处理过"的消息 id（**进过批次** 或 **被容量丢弃**）—— 防它在同一窗/下一窗被重复判定。
   * 有界 FIFO（`FOLLOWUP_RECENT_ID_CAP`）：Map 的键序即插入序，超限时删最旧。
   */
  function rememberId(st, id, at) {
    const key = String(id ?? '').trim();
    if (!key) return;
    st.recentIds.delete(key);
    st.recentIds.set(key, at);
    while (st.recentIds.size > FOLLOWUP_RECENT_ID_CAP) {
      const oldest = st.recentIds.keys().next();
      if (oldest.done) break;
      st.recentIds.delete(oldest.value);
    }
  }

  function activeOf(accountId, chatKey, at) {
    const st = expireIfNeeded(ensure(accountId, chatKey), at);
    const active = st.opened === true && at < st.expiresAt;
    const reason = st.opened ? 'active' : (st.closedReason || 'none');
    return { st, active, reason };
  }

  function snapshot(st, at) {
    return {
      accountId: st.accountId, chatKey: st.chatKey,
      opened: st.opened === true, openedAt: st.openedAt, refreshedAt: st.refreshedAt,
      expiresAt: st.expiresAt, openCount: st.openCount,
      remainingMs: st.opened === true ? Math.max(0, st.expiresAt - at) : 0,
      openReason: st.openReason, closeReason: st.closedReason || '',
      yesRefreshAt: st.yesRefreshAt, yesRefreshes: st.yesRefreshes,
      noStreak: st.noStreak, noLimit,
      awaitingReplyAfterYes: st.awaitingReplyAfterYes === true,
      issuedSeq: st.seq, resolvedThrough: st.resolvedThrough,
      pendingSpeakers: st.pending.size, trackedRecentIds: st.recentIds.size,
      pendingBySpeaker: [...st.pending.entries()].map(([speakerId, rows]) => ({ speakerId, count: rows.length })),
      inFlight: [...st.inFlight.entries()].map(([seq, meta]) => ({ seq, speakerId: meta.speakerId, count: meta.count })),
      buffered: [...st.buffered.keys()]
    };
  }

  return {
    /**
     * 开窗 / 刷新（**只在"实际发言已确认投递"之后调用**）。
     * 活跃期再调 = **只刷新到期时间**（用户裁定："判中并回复后重新开启 20 秒"）：不清 pending、不动 noStreak；
     * 非活跃（从未开 / 已到期 / 已关）再调 = 开**新窗**：清掉上一窗残留、noStreak 从 0 起。
     * @param {{accountId?:string, chatKey:string, at?:number, reason?:string}} p
     */
    open({ accountId = '', chatKey, at = nowFn(), reason = 'after-reply' } = {}) {
      const st = expireIfNeeded(ensure(accountId, chatKey), at);
      const wasActive = st.opened === true && at < st.expiresAt;
      if (!wasActive) {
        st.pending.clear(); st.inFlight.clear(); st.buffered.clear();
        // ★ 新窗：把**上一窗**的在途下发号一并作废 —— 旧窗迟到的判定结果不许改新窗的计数/截止时间
        st.discardThrough = Math.max(st.discardThrough, st.seq);
        st.resolvedThrough = Math.max(st.resolvedThrough, st.seq);
        st.noStreak = 0;
        st.openedAt = at;
        st.openCount = 1;
      } else {
        st.openCount += 1;
      }
      st.opened = true;
      st.closedReason = '';
      st.closedAt = undefined;
      st.refreshedAt = at;
      st.expiresAt = at + windowMs;
      st.openReason = String(reason ?? '').slice(0, 64);
      st.awaitingReplyAfterYes = false;     // 已实际发言 ⇒ 上一条 YES 的"待回复"结束
      return { opened: true, refreshed: wasActive, window: snapshot(st, at) };
    },

    /**
     * 收集一条**窗口内的新消息**（所有人的都收；按发言人分桶）。
     * 窗口不活跃（从未开/到期/已关）⇒ **一律忽略**（不自动开窗 —— 用户裁定）。
     * @param {{accountId?:string, chatKey:string, speakerId:string, messageId:string, at?:number}} p
     */
    collect({ accountId = '', chatKey, speakerId, messageId, at = nowFn() } = {}) {
      const { st, active, reason } = activeOf(accountId, chatKey, at);
      const speaker = String(speakerId ?? '').trim();
      const id = String(messageId ?? '').trim();
      if (!id || !speaker) return { collected: false, reason: 'invalid-message' };
      if (!active) return { collected: false, reason };
      // ★ 2026-10-16（联调核对）：只收**开窗之后**的新消息 —— 判据用消息自己的 `at` 对 `openedAt`。
      //   早于开窗的消息不属于"发言后的接话"，若收进来会被判 NO、污染连续计数（用户裁定的计数单位是
      //   "窗口内实际消息"）。**调用方义务**：收到本 reason 时把这条走**正常队列**（不要静默丢弃）。
      if (Number.isFinite(Number(at)) && Number(at) < Number(st.openedAt)) {
        return { collected: false, reason: 'before-window' };
      }
      // ★ 已进过批次 / 被容量丢弃过的 id：不再收（重复消息不重复判定、也不进计数）
      if (st.recentIds.has(id)) return { collected: false, reason: 'duplicate' };
      const rows = st.pending.get(speaker) ?? [];
      if (rows.some((row) => row.id === id)) return { collected: false, reason: 'duplicate' };
      // ★ 内存上限：单窗跟踪的发言人数量
      if (!st.pending.has(speaker) && st.pending.size >= FOLLOWUP_MAX_SPEAKERS) {
        return { collected: false, reason: 'too-many-speakers' };
      }
      // ★ 队列上限：超出丢**最旧**的（它们没被判定 ⇒ 计入 recentIds，但**不计 NO**）
      let droppedPending = 0;
      if (rows.length >= FOLLOWUP_MAX_PENDING_PER_SPEAKER) {
        const overflow = rows.length - FOLLOWUP_MAX_PENDING_PER_SPEAKER + 1;
        const dropped = rows.splice(0, overflow);
        for (const row of dropped) rememberId(st, row.id, at);
        droppedPending = dropped.length;
      }
      rows.push({ id, at });
      st.pending.set(speaker, rows);
      return { collected: true, pending: rows.length, ...(droppedPending ? { droppedPending } : {}) };
    },

    /**
     * 取"到点可判"的短批次（同发言人合并；**事件驱动**：给 `nextDueAt`，不要求调用方轮询）。
     * 返回的批次已分配顺序号 `seq` 并转入在途；一个批次只含**一个发言人**的原文 id 列表。
     * @param {{accountId?:string, chatKey:string, at?:number}} p
     */
    dueBatch({ accountId = '', chatKey, at = nowFn() } = {}) {
      const { st, active, reason } = activeOf(accountId, chatKey, at);
      if (!active) return { active: false, reason, due: [], nextDueAt: null };
      const due = [];
      let nextDueAt = null;
      for (const [speakerId, rows] of [...st.pending.entries()]) {
        if (!rows.length) { st.pending.delete(speakerId); continue; }
        const lastAt = rows[rows.length - 1].at;
        const readyAt = lastAt + batchMs;
        if (at < readyAt) {
          if (nextDueAt === null || readyAt < nextDueAt) nextDueAt = readyAt;
          continue;
        }
        const keep = rows.slice(-FOLLOWUP_MAX_MESSAGES_PER_BATCH);
        st.seq += 1;
        st.inFlight.set(st.seq, { speakerId, count: keep.length });
        st.pending.delete(speakerId);
        for (const row of keep) rememberId(st, row.id, at);   // ★ 进过批次的 id 不再重复收
        due.push({
          speakerId, seq: st.seq, messageIds: keep.map((row) => row.id),
          judgedCount: keep.length,          // ★ 判 NO 时按**这个条数**累加连续计数（不是按批）
          firstAt: keep[0]?.at ?? lastAt, lastAt, dropped: rows.length - keep.length, readyAt
        });
      }
      return { active: true, reason: 'active', due, nextDueAt, window: snapshot(st, at) };
    },

    /**
     * 记一条判定结果（**必须带 dueBatch 给的 seq**）。允许乱序到达：只有顺序号连续时才推进计数。
     *   · `YES`  ⇒ noStreak 清零 + **判中即刷新**：窗口截止时间 = **判中时刻 + 20 秒**（若窗口已到期，
     *              一并重开；**不等待 QQ 实际发出回复**）；随后确实回复时按"发言后"规则可再 `open()` 续窗；
     *   · `NO`   ⇒ 连续计数 += **该批实际被判定的消息条数**（`judgedCount`，不是 +1）；达到 `noLimit`
     *              （默认 5 条）⇒ **立即关窗**（reason='no-streak'）；
     *   · `SKIP` ⇒ 超时/预算拒绝/解析失败/尚在队列：**既不 +1 也不清零**（用户裁定，不算 NO），
     *              但照样占用并释放顺序号（后序结果不会被它卡住）。
     * @param {{accountId?:string, chatKey:string, seq:number, verdict:'YES'|'NO'|'SKIP', at?:number}} p
     */
    recordVerdict({ accountId = '', chatKey, seq, verdict, at = nowFn() } = {}) {
      const st = ensure(accountId, chatKey);
      const n = Number(seq);
      const v = String(verdict ?? '').toUpperCase();
      if (!Number.isInteger(n) || !VALID_VERDICTS.has(v)) return { applied: false, reason: 'invalid-verdict' };
      if (n <= st.discardThrough) return { applied: false, reason: 'stale-seq', noStreak: st.noStreak };
      if (n > st.seq) return { applied: false, reason: 'unknown-seq', noStreak: st.noStreak };
      if (n <= st.resolvedThrough) return { applied: false, reason: 'duplicate-seq', noStreak: st.noStreak };
      const meta = st.inFlight.get(n) ?? null;
      // ★ 判 NO 时按**实际被判定的消息条数**累加（用户 2026-10-16 更正）：条数在 `dueBatch` 下发时定死，
      //   这里捕获后随缓冲一起带进顺序应用；meta 缺失（不该发生）时退化为 1 条，保持旧行为。
      const judgedCount = Math.max(1, Math.trunc(Number(meta?.count)) || 0);
      st.inFlight.delete(n);
      st.buffered.set(n, { verdict: v, at, judgedCount });
      let applied = 0;
      let closed = false;
      let closeReason = '';
      let yesRefreshed = false;
      while (st.buffered.has(st.resolvedThrough + 1)) {
        const step = st.resolvedThrough + 1;
        const row = st.buffered.get(step);
        const atRow = Number.isFinite(Number(row.at)) ? Number(row.at) : at;
        st.buffered.delete(step);
        st.resolvedThrough = step;
        applied += 1;
        if (row.verdict === 'NO') st.noStreak += Math.max(1, Math.trunc(Number(row.judgedCount)) || 0);
        else if (row.verdict === 'YES') {
          // ★ 判中即刷新（用户 2026-10-16 更正）：清零 + 截止时间 = **判中时刻 + 20 秒**，
          //   **不等待 QQ 实际发出回复**；窗口若已到期也一并重开（这条判定针对的就是窗口内的消息）。
          st.noStreak = 0;
          st.opened = true;
          st.closedReason = '';
          st.closedAt = undefined;
          st.expiresAt = atRow + windowMs;
          st.refreshedAt = atRow;
          st.yesRefreshAt = atRow;
          st.yesRefreshes += 1;
          st.awaitingReplyAfterYes = true;
          yesRefreshed = true;
        }
        // SKIP：不动计数、不刷窗
        if (row.verdict === 'NO' && st.noStreak >= noLimit && st.opened === true && atRow < st.expiresAt) {
          abandon(st, atRow, 'no-streak');
          closed = true;
          closeReason = 'no-streak';
          break;
        }
      }
      expireIfNeeded(st, at);       // 结果处理完之后再判一次自然到期（幂等；不碰在途/缓冲）
      return { applied: applied > 0, appliedCount: applied, noStreak: st.noStreak, noLimit, closed, closeReason, yesRefreshed, window: snapshot(st, at) };
    },

    /** 当前状态（含 noStreak / 各发言人待判条数 / 在途 / 乱序缓冲）。 */
    check({ accountId = '', chatKey, at = nowFn() } = {}) {
      const { st, active, reason } = activeOf(accountId, chatKey, at);
      return { active, reason, window: snapshot(st, at) };
    },

    /** 手动关闭（清 pending 与在途；关窗后**不自动重开**）。 */
    close({ accountId = '', chatKey, at = nowFn(), reason = 'manual' } = {}) {
      const st = expireIfNeeded(ensure(accountId, chatKey), at);
      const wasOpen = st.opened === true;
      abandon(st, at, reason);
      return { closed: wasOpen, window: snapshot(st, at) };
    },

    reset() { chats.clear(); return { ok: true }; }
  };
}

/**
 * ⚠ 未接线（本单只交付**独立模块**；接线点在 orchestrator，属 C9/编排域 ⇒ 只给接口方案，不越界）：
 *   1. 直接 @ ⇒ **不进云判定**，走原发言链（在 orchestrator 的 judging 前判 `addressed`）；
 *   2. 实际发言确认投递之后 ⇒ `open({accountId, chatKey, at, reason:'after-reply'})`；
 *   3. 窗口内每条新消息 ⇒ `collect({speakerId, messageId, at})`（**所有人**）；返回
 *      `'before-window'` / `'duplicate'` / `'too-many-speakers'` 时按调用方义务处理：
 *      **把这条走正常队列**，不要静默丢弃（`before-window` 的旧消息尤其如此）。
 *      ⚠ **直接 @ 的消息必须照常走原发言链**（`DIRECT_MENTION` 必需回复）：本窗"收不收集"都不影响
 *      它拿到 required 回复 —— 编排不能因为窗口活跃就把 @ 也分流掉（联调核对见回执）。
 *   4. `dueBatch().nextDueAt` ⇒ 起**一个延迟唤醒**（不是定时轮询）；`due[]` 里每项**一个发言人一次判定**；
 *   5. 判定结束 ⇒ `recordVerdict({seq, verdict})`，`verdict ∈ YES|NO|SKIP`
 *      （超时/预算拒绝/解析失败/尚在队列 = SKIP，**不算 NO**；`NO` 按该批**实际被判定的消息条数**累加）；
 *   6. `YES` ⇒ **窗口已由判定本身刷新为"判中时刻 + 20 秒"**（不等回复）；随后实际回复且确认投递时，
 *      按"发言后"规则再 `open()` 一次（续窗 —— 语义上等价于延长到"回复时刻 + 20 秒"）；
 *   7. `recordVerdict` 报 `closed`（no-streak / expired）⇒ 停止本窗一切调度；关窗后**不靠普通消息自启**。
 */
