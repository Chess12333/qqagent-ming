/**
 * M10 · messaging executors: poke / forward / feedback / turn-state signals.
 * Contract: ../../executors/index.js; platform and module dependencies are injected on ctx.
 * No tool here sends chat text. send_forward returns text payloads for send_message;
 * send_poke is the explicitly authorized protocol-action exception.
 */

const fail = (error) => ({ ok: false, error: String(error) });
const unavailable = (name) => fail(`依赖未就绪：${name}`);
const positiveId = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

async function sendPoke(ctx, args = {}) {
  const callProtocol = ctx?.modules?.act?.callProtocol;
  if (!ctx?.chatKey || typeof callProtocol !== 'function') return unavailable('ctx.modules.act.callProtocol');
  const emotion = ctx.modules?.emotion;
  if (typeof emotion?.isHypeMode !== 'function') return unavailable('ctx.modules.emotion.isHypeMode');

  const [kind, rawChatId] = String(ctx.chatKey).split(':', 2);
  if (!['group', 'private'].includes(kind)) return fail('戳人目标会话类型无效');
  const chatId = positiveId(rawChatId);
  if (!chatId) return fail('当前会话 ID 无效');
  let targetUserId = positiveId(args.targetUserId);
  if (kind === 'group' && !targetUserId) return fail('群聊戳人必须提供正整数 targetUserId');
  if (kind === 'private' && !targetUserId) targetUserId = chatId;
  if (!targetUserId) return fail('targetUserId 必须是正整数');

  let hype;
  try { hype = Boolean(emotion.isHypeMode()); }
  catch (error) { return fail(`亢奋模式状态读取失败：${error?.message ?? error}`); }
  if (hype) {
    if (typeof emotion.isHypeProtectedTarget !== 'function') {
      return unavailable('亢奋模式受保护目标检查出口（isHypeProtectedTarget）');
    }
    // 文案照老树 src/tools.js:1842：说「不能拍 <那个号>」并给出下一步，不是只回一个目标号。
    const lock = typeof emotion.getHypeProtectedQQ === 'function' ? String(emotion.getHypeProtectedQQ() || targetUserId) : String(targetUserId);
    if (emotion.isHypeProtectedTarget(targetUserId)) return fail(`亢奋模式硬锁：不能拍 ${lock}。换个人，或直接结束。`);
  }

  try {
    const payload = kind === 'group'
      ? { group_id: chatId, user_id: targetUserId }
      : { user_id: targetUserId };
    await callProtocol('send_poke', payload, ctx);
    return { ok: true, data: { poked: true, kind, targetUserId } };
  } catch (error) {
    return fail(`戳人失败：${error?.message ?? error}`);
  }
}

// send_forward（旧 src/tools.js 的合并转发）—— 2026-10-10 N48（用户批准放开）：**执行器仍然一次都不碰平台**
// （`executors/index.js` 契约第 5 条不变），由 act 拿"已准备"载荷复用 `send()` 投递 ⇒ 自动带上幂等键、
// 与 send_message **同一套**守卫链（心声剥离 / 内部分析硬拦 / send.maxPerRun 预算）和平台回执。
// ★ 放开的只有"投到当前会话"这一件事，两样东西**没有**顺手放宽：
//   · 协议端的**合并转发卡片**要 `platform.sendForward`（sender.js:399 → onebot.js:233），而 `ctx.platform`
//     是 apps 侧的冻结门面，只有 sendTextBatch/sendImage/sendSegments（apps/server/onebot-link.js:164-176）
//     ⇒ 卡片这条路还没接通，这里交付的是一条**文字消息**（一行一条），不是转发卡片。
//   · 跨会话投递要目标会话自己的限流/预算/准入 ⇒ 未授权，`targetChatKey` 已从 schema 摘掉。
// ★ 没走 `PROTOCOL_ACTIONS`：那条要 `ctx.platform.call`（门面没有 ⇒ 恒报「依赖未就绪」），
//   且它是绕过 SendQueue 的裸协议调用 —— 无幂等键、无守卫链、无回执，正是 P0-4 定的"不许这样发"。
async function sendForward(_ctx, args = {}) {
  let nodes = [];
  if (args.fromArchive === true) {
    const memory = _ctx.modules?.memory;
    const store = memory?.store;
    if (typeof store?.recent !== 'function') return unavailable('ctx.modules.memory.store.recent');
    if (typeof memory?.readMemory !== 'function') return unavailable('ctx.modules.memory.readMemory');
    const sourceChatKey = String(args.sourceChatKey || '').trim() || _ctx.chatKey;
    if (!sourceChatKey) return fail('缺少来源会话');
    const limit = Math.min(20, Math.max(1, Number(args.limit) || 10));
    const query = String(args.query || '').trim().toLowerCase();
    try {
      const read = await memory.readMemory({ route: 'sendForwardArchive', input: {
        store, sourceChatKey, query, limit,
      } });
      nodes = (read?.items || []).map((message) => ({
          name: String(message.self ? (_ctx.context?.botName || '我') : (message.senderName || message.senderId || '群友')).slice(0, 20),
          uin: String(message.self ? (_ctx.context?.selfId || '0') : (message.senderId || '0')),
          content: String(message.text || '').slice(0, 500)
        }));
    } catch (error) {
      return fail(`读取会话存档失败：${error?.message ?? error}`);
    }
  } else if (Array.isArray(args.nodes)) {
    nodes = args.nodes.slice(0, 20).map((node) => ({
      name: String(node?.name || '消息').slice(0, 20),
      uin: String(node?.uin || _ctx.context?.selfId || '0'),
      content: String(node?.content ?? '').slice(0, 500)
    }));
  }

  nodes = nodes.filter((node) => node.content.trim());
  if (!nodes.length) return fail('没有可整理的转发内容');
  const messages = nodes.map((node) => `${node.name}：${node.content}`);
  return {
    ok: true,
    data: {
      prepared: true,
      sent: false,
      chatKey: String(_ctx.chatKey || ''),
      nodeCount: nodes.length,
      messages,
      replyToMessageId: args.replyToMessageId ?? null,
      note: '已整理为一条待投递的文字；投递由 M10 受控发送出口完成（与 send_message 同一套守卫与回执），本执行器没有碰平台。'
    }
  };
}

/**
 * N84（旧 `src/tools.js:1910` 的 midHint）：miss 时把本会话真可见的 #短编号列给模型，
 * 否则它只能瞎编数字。⚠️ 不给原始 QQ message_id —— 老树实测那是"编造模板"。
 */
function refHint(ctx, store) {
  try {
    const msgRef = ctx?.modules?.memory?.msgRef;
    if (typeof msgRef !== 'function' || typeof store?.recent !== 'function') {
      return '只能填聊天记录里每条消息前的 #短编号，照抄，不要自己编数字';
    }
    const refs = [...new Set((store.recent(ctx.chatKey, { limit: 60 }) || [])
      .map((entry) => msgRef(entry))
      .filter(Boolean))].slice(-8);
    return refs.length
      ? `引用/看图只能填聊天记录里每条消息前的 #短编号（最近可见：${refs.join(' ')}），照抄，不要自己编数字`
      : '聊天记录里还没有带 #编号 的消息';
  } catch {
    return '引用只能填聊天记录里每条消息前的 #短编号';
  }
}

async function readForward(ctx, args = {}) {
  const store = ctx.modules?.memory?.store;
  if (typeof store?.findByRef !== 'function') return unavailable('ctx.modules.memory.store.findByRef');
  if (!ctx.chatKey) return fail('缺少当前会话');
  let entry;
  try { entry = await store.findByRef(ctx.chatKey, args.messageId); }
  catch (error) { return fail(`查找转发消息失败：${error?.message ?? error}`); }
  if (!entry) return fail(`当前会话找不到消息 ${args.messageId}。${refHint(ctx, store)}`);   // 旧 src/tools.js:1910（miss 要给可见 #编号，否则模型只能编）

  if (String(entry.text || '').startsWith('[合并转发 共')) {
    return {
      ok: true,
      data: { messageId: String(ctx.modules?.memory?.msgRef?.(entry) || args.messageId), text: entry.text, source: 'archive' }
    };
  }
  if (!/\[(?:合并转发聊天记录|forward)\]/iu.test(String(entry.text || ''))) {
    return fail(`消息 ${args.messageId} 没有可验证的合并转发标记`);
  }
  const callProtocol = ctx.modules?.act?.callProtocol;
  const expandForwardNodes = ctx.modules?.platform?.expandForwardNodes;
  if (typeof callProtocol !== 'function') return unavailable('ctx.modules.act.callProtocol');
  if (typeof expandForwardNodes !== 'function') return unavailable('ctx.modules.platform.expandForwardNodes');
  // 本仓老树 src/app.js:954-960 的 SnowLuma/NapCat 记录明确：get_forward_msg 只认 message_id，
  // forward 卡的 res_id 会过期；src/tools.js:1918 用同聊天存档 entry.mid（外层原消息号）。
  // 保留该本地合同，不从 segment data.id/res_id 猜资源映射，也不用 #号回退；可安全表示的 ID
  // 维持原 number 调用形状，超过安全整数的十进制 ID 用字符串保留精度。
  const rawMessageId = entry.mid == null ? '' : String(entry.mid).trim();
  if (!/^-?\d+$/.test(rawMessageId)) return fail('当前存档没有有效的原消息号，无法展开转发');
  if (typeof entry.mid === 'number' && !Number.isSafeInteger(entry.mid)) {
    return fail('存档中的转发原消息号已超出安全整数精度，不能可靠展开');
  }
  const numericMessageId = Number(rawMessageId);
  const messageId = Number.isSafeInteger(numericMessageId) ? numericMessageId : rawMessageId;

  /** 从 get_msg 返回的消息事件里挑出 forward 段的资源号（snowluma 的 data.id 就是它认的值）。 */
  const forwardResourceId = (event) => {
    const segs = Array.isArray(event?.message)
      ? event.message
      : (Array.isArray(event?.data?.message) ? event.data.message : []);
    for (const seg of segs) {
      if (!seg || typeof seg !== 'object' || seg.type !== 'forward') continue;
      const d = seg.data || {};
      const candidate = d.id || d.res_id || d.forward_id;
      if (candidate) return String(candidate);
    }
    return '';
  };

  const packets = (r) => (Array.isArray(r?.messages) ? r.messages : (Array.isArray(r?.data?.messages) ? r.data.messages : []));

  /** 展开成功就返回结果对象，空就 null。 */
  const tryExpand = async (response) => {
    const expanded = await expandForwardNodes(packets(response));
    if (!expanded?.text) return null;
    return {
      ok: true,
      data: {
        messageId: String(ctx.modules?.memory?.msgRef?.(entry) || args.messageId),
        text: expanded.text,
        images: Array.isArray(expanded.media) ? expanded.media.length : 0
      }
    };
  };

  // ★ 2026-10-22（溟）修「合并转发看得到卡片、看不到内容」：
  //   雪露玛的 get_forward_msg 只在 message_id **为正**时才去内存里找那条消息的 forward 段资源号；
  //   私聊（和部分群）的消息号是负数，它于是把负号当成资源号，回 retcode=100
  //   「download forward message payload is empty」——所以私聊里的合并转发永远展开不了。
  //   实测（2026-10-22 22:00，private:100000001）：先 get_msg 拿同一条消息，forward 段的 data.id
  //   才是 get_forward_msg 认的资源号；拿它单独请求，负号那几条全部 retcode=0（1/2/19/29 个节点）。
  //   所以顺序改成：① get_msg 取资源号 → get_forward_msg(id)；② 老路（正数 message_id）兜底。
  const notes = [];
  try {
    const event = await callProtocol('get_msg', { message_id: messageId }, ctx);
    const resourceId = forwardResourceId(event);
    if (!resourceId) {
      notes.push('get_msg 返回里没有 forward 资源号');
    } else {
      const done = await tryExpand(await callProtocol('get_forward_msg', { id: resourceId }, ctx));
      if (done) return done;
      notes.push('按资源号展开为空');
    }
  } catch (error) {
    notes.push(`get_msg 失败：${error?.message ?? error}`);
  }

  try {
    const done = await tryExpand(await callProtocol('get_forward_msg', { message_id: messageId }, ctx));
    if (done) return done;
    notes.push('转发内容为空或服务端已丢弃');
  } catch (error) {
    notes.push(`按 message_id 展开失败：${error?.message ?? error}`);
  }

  return fail(`展开转发失败：${notes.join(' / ')}`);
}

// report_feedback（旧 src/tools.js:2585-2589）—— 2026-10-09 N35 接通
// 旧实现两件事：`ctx.session.feedbacks.push(...)`（记档）+ `ctx.emit('feedback', {sessionId,chatKey,level,message})`（控制台通知）。
// ★ 修掉的病：本执行器原先只探 `ctx.modules.extensions.reportFeedback`，而这个出口**全仓不存在**
//   （assembly.js 的白名单里没有它，extensions 模块也没导出）⇒ 工具挂在那儿点了必失败。
// 现在的两级：① 有 `extensions.reportFeedback` 就优先走它（保留原来的前向兼容探测）；
//   ② 否则落到 M2 观测出口 —— `observability.log(level, …)` 记档（有界文本，UI 日志页读得到）
//   + `observability.emit('feedback', …)` 当"通知"的生产者。
//   `feedback` 本来就是 SSE 的在册 UI 事件名（apps/server/sse-bridge.js:25/28），
//   只是 bridge 那边还把它挂在 NOT_PORTED（:140-146）说"新树没有对应的 emit 出口"——
//   现在有了；bridge 的转发属 apps/server 域，已报给指挥位，本域不动。
async function reportFeedback(ctx, args = {}) {
  const level = ['info', 'warning', 'error'].includes(args.level) ? args.level : 'info';
  const message = String(args.message ?? '').slice(0, 500);
  if (!message.trim()) return fail('反馈内容不能为空');

  const report = ctx.modules?.extensions?.reportFeedback;
  if (typeof report === 'function') {
    try {
      const result = await report({ level, message, chatKey: ctx.chatKey });
      if (result?.ok === false) return fail(result.error || '反馈出口拒绝记录');
      return { ok: true, data: { reported: true, channel: 'extensions.reportFeedback' } };
    } catch (error) {
      return fail(`反馈记录失败：${error?.message ?? error}`);
    }
  }

  const obs = ctx.modules?.observability;
  if (typeof obs?.log !== 'function') return unavailable('ctx.modules.observability.log（反馈记档出口）');
  const at = Date.now();
  const chatKey = String(ctx.chatKey || '');
  try {
    obs.log(level === 'warning' ? 'warn' : level, `tool-feedback ${message}`, {
      tool: 'report_feedback', level, chatKey, evidenceId: ctx.evidenceId ?? null
    });
    const delivered = typeof obs.emit === 'function'
      ? Number(obs.emit('feedback', { chatKey, level, message, at })) > 0
      : false;
    return {
      ok: true,
      data: {
        reported: true,
        channel: 'observability.log+emit',
        level,
        message,
        // 有没有订阅者 ≠ 有没有记档：日志一定落了，通知要看 bridge 有没有挂上（见上面的说明）。
        notified: delivered,
        ...(delivered ? {} : { note: '已记入观测日志；UI 反馈通知还需 apps/server 的 sse-bridge 转发 `feedback`（当前挂在 NOT_PORTED）。' })
      }
    };
  } catch (error) {
    return fail(`反馈记录失败：${error?.message ?? error}`);
  }
}

// switch_back：请求在本轮收尾后切回常态人格 —— 只登记待退出意图（emotion.requestPersonaTwoExit），
// 由轮首（orchestrator 人格生命周期块）或心跳空闲时消费，下一轮生效。
// ★ 2026-10-12 现状（指挥位授权 mimo1 只清文字，**判定逻辑一字未动**）：
//   `requestPersonaTwoExit` 自 08531453（wire persona two lifecycle）起已存在；表项也已在
//   act/index.js 恢复，compose 仅在 persona2.enabled=true 时让它对模型可见。
//   历史存档：2026-10-09 N35 时出口确实不存在、故意留 fail-closed；2026-10-10 N48 按裁定摘表
//   （当时双人格被判为不做）；两条前提均已被 08531453 推翻，本注释随之更新。
async function switchBack(ctx) {
  const requestExit = ctx.modules?.emotion?.requestPersonaTwoExit;
  if (typeof requestExit !== 'function') return unavailable('ctx.modules.emotion.requestPersonaTwoExit（旧实现的切回消费出口）');
  try {
    const result = await requestExit('switch_back');
    if (result?.ok === false) return fail(result.error || '切回请求未被接受');
    return { ok: true, data: { requested: true, takesEffectBeforeNextPrompt: true } };
  } catch (error) {
    return fail(`切回请求失败：${error?.message ?? error}`);
  }
}

// switch_in：请求切到第二人格（回程的对称面，2026-10-13 用户口径：两向都掷骰、触发者是模型）。
//   骰子、"已在位就拒"、"功能没开就拒"全在 emotion 侧（`requestPersonaTwoEnter`）—— 这里**不掷第二次骰**、
//   也不判断该不该切，只把结果原样转给模型（失败文案照搬，模型看得懂才能决定下轮要不要再试）。
//   ★ 成功也不等于切换：只写挂起意图，下一轮轮首才生效（同一轮里提示词仍归当前人格）。
async function switchIn(ctx) {
  const requestEnter = ctx.modules?.emotion?.requestPersonaTwoEnter;
  if (typeof requestEnter !== 'function') return unavailable('ctx.modules.emotion.requestPersonaTwoEnter（进入方向的登记出口）');
  try {
    const result = await requestEnter('tool');
    if (result?.ok === false) return fail(result.error || '进入请求未被接受');
    return {
      ok: true,
      data: {
        requested: true,
        takesEffectBeforeNextPrompt: true,
        // 掷过骰才带这两个键（缺键 = 不掷必成，那时不凭空造数字给模型看）。
        ...(result?.rolled !== undefined ? { rolled: result.rolled, chance: result.chance } : {})
      }
    };
  } catch (error) {
    return fail(`进入请求失败：${error?.message ?? error}`);
  }
}

// mute_member（2026-10-28 加，她要的群禁言）：走 M10 的受控协议出口 callProtocol('set_group_ban')，
//   与 send_poke 同一条路 —— 但**不发消息**，所以没有 SendReceipt，成功只代表协议端收了这一条。
//   校验写在这边而不是只靠门面：门面挡的是"能不能叫这个动作"，这里挡的是"参数合不合规"。
const GROUP_BAN_MAX_SECONDS = 2592000; // 30 天
async function muteMember(ctx, args = {}) {
  const callProtocol = ctx?.modules?.act?.callProtocol;
  if (typeof callProtocol !== 'function') return unavailable('ctx.modules.act.callProtocol');

  const [kind, rawChatId] = String(ctx?.chatKey || '').split(':', 2);
  const rawGroupArg = args.groupId === undefined || args.groupId === null ? '' : String(args.groupId).trim();
  const argGroupId = positiveId(args.groupId);
  // 给了 groupId 但解析不出数字 ⇒ 直接拒。静默回落到"当前群"是最坏的错法：模型会以为禁在别处。
  if (rawGroupArg && !argGroupId) return fail(`groupId 不是合法群号：${rawGroupArg}`);
  const groupId = argGroupId || (kind === 'group' ? positiveId(rawChatId) : null);
  if (!groupId) return fail('禁言只能用在群里：当前会话不是群，也没给 groupId');
  if (kind === 'group' && argGroupId && argGroupId !== positiveId(rawChatId)) {
    return fail(`不许跨群禁言：当前会话是群 ${rawChatId}，给的 groupId 是 ${args.groupId}`);
  }

  const userId = positiveId(args.userId);
  if (!userId) return fail('必须给 userId（数字 QQ 号）；不知道号就先 get_active_members 查');

  const selfId = String(ctx?.context?.selfId ?? '').trim();
  if (selfId && String(userId) === selfId) return fail('不能禁言自己');

  let seconds;
  if (args.seconds === undefined || args.seconds === null || String(args.seconds).trim() === '') seconds = 600;
  else seconds = Number(args.seconds);
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds < 0) {
    return fail('seconds 必须是 0 或正整数（0 = 解除禁言）');
  }
  if (seconds > GROUP_BAN_MAX_SECONDS) return fail(`seconds 上限 ${GROUP_BAN_MAX_SECONDS}（30 天）`);

  try {
    await callProtocol('set_group_ban', { group_id: groupId, user_id: userId, duration: seconds }, ctx);
    return {
      ok: true,
      data: {
        groupId, userId, seconds,
        action: seconds === 0 ? 'unmuted' : 'muted',
        note: seconds === 0
          ? '禁言已解除（协议动作没有回执，以协议端未报错为准）'
          : `已禁言 ${userId} ${seconds} 秒（协议动作没有回执，以协议端未报错为准）`
      }
    };
  } catch (error) {
    const message = String(error?.message ?? error);
    const hint = /权限|permission|admin|not.?owner|403|retcode=(?:1\b|104|1200)/i.test(message)
      ? '（常见原因：机器人不是管理员，或对方是管理员/群主，或时长超上限）'
      : '';
    return fail(`禁言失败：${message}${hint}`);
  }
}

async function finish(_ctx, args = {}) {
  const rawSummary = String(args.summary ?? '').trim();
  const summary = rawSummary.slice(0, 300) || '本轮已收尾';
  // ★ 2026-10-11（指挥位派单第 4 条）：300 字上限是 `session.finishSummary` 的**存储边界**，保留；
  //   但 favorDelta 那条腿的落账理由**就取这条 summary** ⇒ 被腰斩的长判断若没人知道，就是另一种
  //   "看起来成功"（切掉尾巴常常正好切掉转折那句）。所以：截了就必须**看得出来**，没截则**不出这个键**。
  const summaryTruncated = rawSummary.length > 300;
  const mood = String(args.mood ?? '').trim().slice(0, 40) || '无事发生';
  const rawDelta = Number(args.favorDelta);
  const favorDelta = Number.isFinite(rawDelta) ? Math.max(-8, Math.min(8, Math.round(rawDelta))) : null;
  // Schema 只接受 boolean；漏填/非 boolean 按契约默认 false，合法 true/false 原样进入回执。
  const writeMemory = typeof args.writeMemory === 'boolean' ? args.writeMemory : false;
  // ★ 2026-10-11（指挥位派单 · 用户第 2 条）：mood / favorDelta **有消费方了** —— M15 在轮末
  //   从本回执派生情绪事件（emotion/mood-tags.js 的逐 kind 老树数值表 + favorDelta 正负调心情）。
  // ★★ B10（2026-10-11 用户裁定「好感改回老树语义」）：好感那条腿的理由就是 `summary` **原话**，
  //   原先这里借 M7 的 `classifyFavorReason` 当场预判"归不归得进七类"，归不进出 `favorChainBreak`
  //   并劝模型"改用可归类理由再调"⇒ 那是逼模型改写自己的评价（与 memory_favor 同一道闸，那边已撤）。
  //   ★ 方向与幅度只听模型的 favorDelta（这里只按 ±8 收幅度，不看文案）；落账最终判定在 M15/M7，
  //     本回执不许替它下结论 —— 只说"还没落账"。
  //   ★ `summary` 的 300 字上限是**会话收尾记录的存储边界**（compose.js 落 session.finishSummary），
  //     不是 B10 撤的那道类别闸，所以留着没动。
  return {
    ok: true,
    data: {
      finished: true,
      summary,
      mood,
      writeMemory,
      ...(favorDelta === null ? {} : { favorDelta }),
      consumed: true,
      consumer: 'M15 compose 收尾判定 + M15 自评消费方（mood/favorDelta/writeMemory）',
      // 消费方清单（照 orchestrator 现码核过）：
      //   · `data.finished === true` ⇒ compose.js 的 finishCompleted 与收尾判定消费；
      //   · `summary` ⇒ compose.js 读调用参数，落 session.finishSummary；
      //   · `mood` / `favorDelta` ⇒ M15 `selfEvalEventsFromFinish`（orchestrator/index.js）派生
      //     emotionEvidence（逐 kind 老树数值表）+ favorDelta 正负的心情腿；favorDelta 另派生
      //     relationDelta 写好感；`writeMemory` ⇒ M15 按本轮证据构造印象候选，与同轮 memory_append 去重后处理。
      note: '本轮结束信号已被 M15 收尾判定消费（finished/summary）。mood 与 favorDelta 由 M15 自评消费方落账：'
        + 'mood 照老树逐 kind 表推动情绪/心情；favorDelta 对心情 ±4/-3（只看正负），并对本轮主说话人写好感应为'
        + '（理由取本 summary **原话**：照实写你的判断就行，不要求字数、不要求格式、不必归进任何类别，'
        + '涨跌方向和幅度都听你这个 favorDelta。★ 此刻还没落账 —— 本轮结束时才由 M15 派生 relationDelta 交 M7 写库）。'
        + 'writeMemory 是长期印象自评信号，默认 false；这里只透传，不直接写记忆。M15 会按本轮证据处理，并跳过与同轮 memory_append 相同的主语、范围和规范化内容。'
        + (summaryTruncated
          ? ` ★ 另外：这条 summary 原长 ${rawSummary.length} 字，已按存储边界截到 300 —— favorDelta 的落账理由取的就是**截断后**这段，尾巴被切掉了。`
          : ''),
      // ★ 缺键不出键：没截就不加这个字段（调用方据此能区分"截过"与"没截"，而不是靠猜）。
      ...(summaryTruncated ? { summaryTruncated: true } : {})
    }
  };
}

export const executors = {
  send_poke: sendPoke,
  mute_member: muteMember,
  send_forward: sendForward,
  read_forward: readForward,
  report_feedback: reportFeedback,
  switch_back: switchBack,
  switch_in: switchIn,
  finish
};
