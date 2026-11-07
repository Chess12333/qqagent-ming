/**
 * J3 活动话题状态机（指导 §8.2；2026-10-12）
 *
 * 归属说明（照 §8.2 原文）：**话题状态由调用方（orchestrator）按账号+会话持有** ——
 * 本文件提供状态机本身（建立/续期/到期/结束 + 序列化），第一批作为 J 线内部实现与自测交付，
 * "确认发言后由 orchestrator 调用"的真实接线放第二批。
 *
 * 纯内存、无 I/O；时间全部由调用方注入（opts.now / 每次调用的 at），便于确定性自测。
 * 规则要点（§8.2）：
 *   · 只有角色**实际发送成功**才建立或刷新活动状态（本状态机不判断发送，由调用方保证调用时机）
 *   · 首版闲置 5 分钟到期（可调）；只在确认回复后续期，旁人刷屏与 unknown 不续期
 *   · continue=no、用户停用、到期 → 结束；重启优先从轮次记录恢复，无法确认则按未参与处理
 */

export const DEFAULT_TOPIC_IDLE_MS = 5 * 60 * 1000;

function keyOf(accountId, chatKey) {
  return `${String(accountId ?? '')}|${String(chatKey ?? '')}`;
}

function defaultTopicId({ chatKey, sourceId }) {
  // 程序生成、确定性（同锚点重开得到同 id，便于幂等与恢复）；只用锚点信息，不调模型。
  const raw = `topic:${chatKey ?? ''}#${sourceId ?? ''}`;
  return raw.replace(/[^\w.:#-]/g, '_').slice(0, 160);
}

function isExpired(topic, at, idleMs) {
  return !topic || !Number.isFinite(topic.expiresAt) || at >= topic.expiresAt;
}

/**
 * @param {{idleMs?:number, idFactory?:(x:{chatKey:string,sourceId:string})=>string, now?:()=>number}} [opts]
 */
export function createTopicRegistry(opts = {}) {
  const idleMs = Number.isFinite(Number(opts.idleMs)) && Number(opts.idleMs) > 0 ? Number(opts.idleMs) : DEFAULT_TOPIC_IDLE_MS;
  const idFactory = typeof opts.idFactory === 'function' ? opts.idFactory : defaultTopicId;
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
  /** key → topic 状态对象 */
  const topics = new Map();

  function snapshot(topic) {
    return topic ? { ...topic, participants: [...topic.participants] } : null;
  }

  return {
    idleMs,

    /**
     * 角色**确认发送成功**后建立（或按新锚点重建）话题。返回快照。
     * @param {{accountId?:string, chatKey:string, sourceId?:string, participant?:string, confirmedReplyId?:string, at?:number}} p
     */
    open({ accountId = '', chatKey, sourceId = '', participant = '', confirmedReplyId = '', at = nowFn() } = {}) {
      const k = keyOf(accountId, chatKey);
      const id = idFactory({ chatKey: String(chatKey ?? ''), sourceId: String(sourceId ?? '') });
      const prev = topics.get(k);
      const participants = new Set(prev && !isExpired(prev, at, idleMs) ? prev.participants : []);
      if (participant) participants.add(String(participant));
      const topic = {
        topicId: id,
        chatKey: String(chatKey ?? ''),
        accountId: String(accountId ?? ''),
        startedBySource: String(sourceId ?? ''),
        lastConfirmedReplyId: String(confirmedReplyId ?? ''),
        lastConfirmedAt: at,
        expiresAt: at + idleMs,
        participants: [...participants],
        ended: null
      };
      topics.set(k, topic);
      return snapshot(topic);
    },

    /**
     * 确认回复后续期（等价于"刷新活动状态"）。无活动话题时不新建（建立只有 open 一条路）。
     */
    renew({ accountId = '', chatKey, participant = '', confirmedReplyId = '', at = nowFn() } = {}) {
      const k = keyOf(accountId, chatKey);
      const topic = topics.get(k);
      if (!topic || topic.ended || isExpired(topic, at, idleMs)) return null;
      topic.lastConfirmedAt = at;
      topic.expiresAt = at + idleMs;
      if (confirmedReplyId != null && String(confirmedReplyId) !== '') {
        topic.lastConfirmedReplyId = String(confirmedReplyId);
      }
      if (participant && !topic.participants.includes(String(participant))) topic.participants.push(String(participant));
      return snapshot(topic);
    },

    /**
     * 当前状态（含到期判定）。reason：none=从未建立 / expired=已到期 / ended=已结束 / active=活动中。
     */
    check({ accountId = '', chatKey, at = nowFn() } = {}) {
      const topic = topics.get(keyOf(accountId, chatKey));
      if (!topic) return { active: false, reason: 'none', topic: null };
      if (topic.ended) return { active: false, reason: 'ended', topic: snapshot(topic) };
      if (isExpired(topic, at, idleMs)) return { active: false, reason: 'expired', topic: snapshot(topic) };
      return { active: true, reason: 'active', topic: snapshot(topic) };
    },

    /** 结束：continue=no / 用户停用 / 到期清理 / 换代。 */
    end({ accountId = '', chatKey, reason = 'ended', at = nowFn() } = {}) {
      const k = keyOf(accountId, chatKey);
      const topic = topics.get(k);
      if (!topic || topic.ended) return snapshot(topic ?? null);
      topic.ended = { reason: String(reason).slice(0, 64), at };
      topic.expiresAt = at;   // 结束即刻不再 active
      return snapshot(topic);
    },

    /** 活动话题锚点文本（给 judgeOnce 的 activeTopic 字段用；无活动返回 null）。 */
    activeTopicText({ accountId = '', chatKey, at = nowFn() } = {}) {
      const r = this.check({ accountId, chatKey, at });
      if (!r.active || !r.topic) return null;
      return String(r.topic.topicId ?? '');
    },

    /** 序列化（重启恢复用；§8.2：重启优先从有效轮次记录恢复，本导出供接线层携带状态）。 */
    serialize() {
      return { version: 1, idleMs, entries: [...topics.values()].map((t) => ({ ...t, participants: [...t.participants] })) };
    },

    /** 恢复（校验形状；无法确认的状态由调用方按未参与处理——本函数只接受本机 serialize 的产物）。 */
    restore(data) {
      topics.clear();
      if (!data || data.version !== 1 || !Array.isArray(data.entries)) return false;
      for (const e of data.entries) {
        if (!e || typeof e.topicId !== 'string' || typeof e.chatKey !== 'string') continue;
        topics.set(keyOf(e.accountId ?? '', e.chatKey), { ...e, participants: Array.isArray(e.participants) ? [...e.participants] : [] });
      }
      return true;
    },

    /** 测试/排障：清空。 */
    reset() { topics.clear(); return { ok: true }; }
  };
}
