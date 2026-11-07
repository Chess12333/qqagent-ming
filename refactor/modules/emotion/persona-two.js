/**
 * Durable persona-two lifecycle. Configuration is the single persisted state,
 * matching the legacy setPersonaTwo contract without importing legacy globals.
 *
 * ★ 2026-10-16（用户报「每次重启后都变第二人格，没有继承重启前的切换状态」·启动恢复）：
 *   进程重启只认盘上的 `persona2.enabled`（最后一次有效人格状态）；上一进程遗留的**进入意图**
 *   （pendingEnter）在启动时丢弃，且启动后的**首次**轮首预检只做恢复、不参与自动触发。
 *   轮内语义（模型 switch_in 骰后挂起、下一轮首消费；待退意图活过重启）一字未改。
 */
export function createPersonaTwoController({ configStore, getPlatform = () => null, getChatStore = () => null, getEmotionState = () => null, resolveAvatarArgs = (value) => [{ action: 'set_qq_avatar', file: value }], log = () => {}, random = () => Math.random() } = {}) {
  const read = (key, fallback) => {
    try { return configStore?.get?.(key, fallback) ?? fallback; } catch { return fallback; }
  };
  const save = (patch) => {
    if (typeof configStore?.updateConfigAndSave !== 'function') throw new Error('config-store.updateConfigAndSave unavailable');
    return configStore.updateConfigAndSave(patch, { backup: true, log });
  };
  let turnsThisRun = 0;
  let nextRandomAt = 0;
  let randomHitTimes = [];
  // ★ 2026-10-16 · 启动恢复（见文件头）：本进程启动时刻 + 「首次预检 = 恢复」标记。
  //   · 进入意图只认本进程写下的（`pendingEnterAt >= bootAt`）；跨进程残骸一律不采信。
  //   · 启动后的首次 maybeAutoEnter 只做恢复（盘上 enabled 即最后有效状态），不当新一轮触发。
  const bootAt = Date.now();
  let startupRecoveryPending = true;

  async function switchAvatar(on) {
    const target = String(read(on ? 'persona2.avatarOn' : 'persona2.avatarOff', '') || '').trim();
    if (!target) return { switched: false, skipped: true, reason: 'avatar path is empty' };
    const platform = getPlatform();
    if (typeof platform?.call !== 'function') return { switched: false, error: 'OneBot avatar action unavailable' };
    let lastError = null;
    const startedAt = Date.now();
    try {
      const attempts = resolveAvatarArgs(target);
      for (const attempt of attempts) {
        const remaining = 8000 - (Date.now() - startedAt);
        if (remaining <= 0) break;
        try {
          const data = await platform.call(attempt.action, { file: attempt.file }, Math.max(250, Math.min(2500, remaining)));
          return { switched: true, path: target, action: attempt.action, via: String(attempt.file).startsWith('base64:') ? 'base64' : 'file', data: data ?? null };
        } catch (error) { lastError = error; }
      }
    } catch (error) { lastError = error; }
    const message = String(lastError?.message ?? lastError ?? 'avatar attempt budget exhausted');
    log(`[persona2] avatar switch failed: ${message}`);
    return { switched: false, error: message };
  }

  async function setEnabled(enabled, { reason = 'manual', avatar = true } = {}) {
    const wants = enabled === true;
    const p2 = { ...(read('persona2', {}) || {}) };
    const persona = { ...(read('persona', {}) || {}) };
    if (p2.enabled === wants) return { ok: true, already: true, enabled: wants };
    if (wants) {
      const normalRole = String(persona.roleText ?? '');
      if (!normalRole.trim()) return { ok: false, error: 'normal persona roleText is empty; refusing to enter without a restorable snapshot' };
      const secondRole = String(p2.roleText ?? '');
      if (!secondRole.trim()) return { ok: false, error: 'persona2.roleText is empty; refusing to enter' };
      // ★ 方向 A（2026-10-12 指挥位裁定）：进入**不再写 persona.roleText/systemMode/compactSystemPrompt**
      //   —— 用户配置里的提示词一个字节不动；生效人设由组装层按 `effectivePersona()` 叠加。
      //   `persona2.saved` 仍照旧记快照：① 审计/回滚依据 ② 旧式残留（配置里还躺着第二人格卡）的修复源。
      p2.saved = {
        roleText: normalRole,
        systemMode: String(persona.systemMode || 'soft'),
        compactSystemPrompt: persona.compactSystemPrompt === true
      };
      p2.enabled = true;
      p2.stats = { enteredAt: Date.now(), reason: String(reason || 'manual') };
      p2.lastSwitchAt = Date.now();
      p2.onSpans = openSpan(p2.onSpans, p2.stats.enteredAt);
      // 进入即清两个挂起（2026-10-16 补对侧）：旧待退意图属于上一段在位期，留着的话
      // 下一轮轮首会立刻又把人退掉（进→退的幽灵切换）；旧进入意图在进入落定时同样已消费。
      p2.pendingExitReason = '';
      p2.pendingExitAt = 0;
      p2.pendingEnterReason = '';
      p2.pendingEnterAt = 0;
      save({ persona2: p2 });
      turnsThisRun = 0;
      startupRecoveryPending = false;   // 已发生过一次真实切换 ⇒ 启动恢复阶段结束
      const avatarResult = avatar ? await switchAvatar(true) : { switched: false, skipped: true, reason: 'avatar disabled' };
      return { ok: true, enabled: true, reason: p2.stats.reason, avatar: avatarResult };
    }

    // ── 退出（方向 A）──
    // 正常情况下 persona.* 全程没被我们动过 ⇒ 不还原、不覆盖（用户在位期间改过的编辑也保留）。
    // 只有**旧式残留**（当前 persona.roleText === 第二人格卡）才按快照修复一次；
    // 快照缺失 ⇒ 拒绝退出（与旧行为一致：不拿未知内容覆盖配置）。
    const secondCard = String(p2.roleText ?? '');
    const needsRepair = Boolean(secondCard.trim()) && String(persona.roleText ?? '') === secondCard;
    let repairedPersona = null;
    if (needsRepair) {
      const saved = p2.saved && typeof p2.saved === 'object' ? p2.saved : {};
      const restoreRole = String(saved.roleText ?? '');
      if (!restoreRole.trim()) return { ok: false, error: 'saved normal persona is missing; refusing to replace the current role' };
      repairedPersona = {
        ...persona,
        roleText: restoreRole,
        systemMode: String(saved.systemMode || 'soft'),
        compactSystemPrompt: saved.compactSystemPrompt === true
      };
    }
    const at = Date.now();
    p2.enabled = false;
    p2.saved = null;
    p2.stats = null;
    p2.lastSwitchAt = at;
    p2.onSpans = closeSpan(p2.onSpans, at);
    p2.pendingExitReason = '';
    p2.pendingExitAt = 0;
    save(repairedPersona ? { persona2: p2, persona: repairedPersona } : { persona2: p2 });
    turnsThisRun = 0;
    startupRecoveryPending = false;   // 已发生过一次真实切换 ⇒ 启动恢复阶段结束
    const avatarResult = avatar ? await switchAvatar(false) : { switched: false, skipped: true, reason: 'avatar disabled' };
    return { ok: true, enabled: false, reason: String(reason || 'manual'), avatar: avatarResult };
  }

  // ★ 方向 A · 存量修复（加载时一次性）：旧实现曾把第二人格卡写进 persona.*。
  //   盘上仍是那个状态（enabled + 当前 roleText === 第二人格卡 + 快照在）⇒ 构造时就按快照还原，
  //   不等退出 —— 不把已被改坏的配置留在那儿。修复失败不阻塞启动（退出路径还有一次修复机会）。
  try {
    const curPersona = read('persona', {}) || {};
    const bootP2 = read('persona2', {}) || {};
    const bootSecondCard = String(bootP2.roleText ?? '');
    if (bootP2.enabled === true && bootSecondCard.trim()
      && String(curPersona.roleText ?? '') === bootSecondCard
      && String(bootP2.saved?.roleText ?? '').trim()) {
      save({
        persona: {
          ...curPersona,
          roleText: String(bootP2.saved.roleText),
          systemMode: String(bootP2.saved.systemMode || 'soft'),
          compactSystemPrompt: bootP2.saved.compactSystemPrompt === true
        }
      });
      log('[persona2] 检测到旧式残留（配置 persona.roleText 是第二人格卡）：已按快照还原一次（方向 A）');
    }
  } catch (error) {
    log(`[persona2] 存量修复未执行（退出时还有一次机会）：${String(error?.message ?? error)}`);
  }

  // ★ 2026-10-16 · 启动恢复（用户报「每次重启后都变第二人格，没有继承重启前的切换状态」）：
  //   进程启动只认盘上的 `persona2.enabled` = 最后一次有效人格状态。上一进程遗留的**进入意图**
  //   是残骸：它设计上由"下一轮轮首"消费，没被消费就走到了重启 ⇒ 拿它在重启后切人，正是
  //   用户说的"启动时残留标记把用户切回第二人格"。⇒ 启动即丢弃（只记日志）。
  //   **待退意图不动**（T55／老树口径：switch_back 意图必须活过重启，重启后下一轮照退）。
  //   这里失败不阻塞启动：maybeAutoEnter 里还有一道"写入时刻 < bootAt 一律不采信"的兜底。
  try {
    const bootP2 = read('persona2', {}) || {};
    const staleEnter = String(bootP2.pendingEnterReason ?? '').trim();
    if (staleEnter) {
      save({ persona2: { ...bootP2, pendingEnterReason: '', pendingEnterAt: 0 } });
      log(`[persona2] 启动恢复：丢弃上一进程遗留的进入意图（${staleEnter}）—— 人格按盘上 enabled=${bootP2.enabled === true} 继续`);
    }
  } catch (error) {
    log(`[persona2] 启动恢复：遗留进入意图清理失败（轮首预检仍会按 bootAt 兜底拦截）：${String(error?.message ?? error)}`);
  }

  /**
   * ★ 方向 A 出口：给组装层的"当前生效人设"。
   *   不在位 ⇒ 原样返回 config persona（组装层照旧）；在位 ⇒ 第二人格卡 + soft2 + 不压缩，
   *   **config persona 全程只读不写**。组装时按这个取值即可，别再去改配置。
   */
  function effectivePersona() {
    const base = read('persona', {}) || {};
    const baseView = {
      personaTwo: false,
      roleText: String(base.roleText ?? ''),
      // ★ 2026-10-16：缺省不再硬编码 'soft'——空值原样透出，让 prompt/index.js:366 的
      //   `readCfg(cfg, 'persona.systemMode', 'full')` 统一兜底，否则 UI 所选风格在未设置时被吞成 soft。
      systemMode: String(base.systemMode ?? ''),
      compactSystemPrompt: base.compactSystemPrompt === true
    };
    if (read('persona2.enabled', false) !== true) return baseView;
    return {
      personaTwo: true,
      roleText: String(read('persona2.roleText', '') || '') || baseView.roleText,
      systemMode: 'soft2',
      compactSystemPrompt: false
    };
  }

  /**
   * ★ 进入方向 · LLM 触发（2026-10-13 用户口径：两向都掷骰、触发者是模型、不加自动兜底）。
   *   镜像 switch_back 的**挂起语义**：骰子通过也只写 `pendingEnter`，下一轮轮首由
   *   `maybeAutoEnter` 消费（避免同一轮里"提示词还在蓝、发送归属已打红"的错位）。
   *   概率键 `persona2.switchEnterChance`：缺键 = 不掷必成（与 switchBackChance 同约定；
   *   生产 0.5 由 defaults 提供）。只拦这一次调用——阈值/定时/hype 那些**自动**闸与本函数无关。
   */
  function requestPersonaTwoEnter(reason = 'tool') {
    if (read('persona2.enabled', false) === true) return { ok: false, error: '你已经在第二人格了，不用再切。' };
    if (read('persona2.featureEnabled', false) !== true) {
      return { ok: false, error: '第二人格功能没开（featureEnabled），进不去。' };
    }
    const chanceRaw = Number(read('persona2.switchEnterChance', 1));
    const chance = Number.isFinite(chanceRaw) ? Math.min(1, Math.max(0, chanceRaw)) : 1;
    let rolled = null;
    if (chance < 1) {
      const rawRoll = random();
      const roll = Number(rawRoll);
      if (!(roll >= 0 && roll < 1)) {
        log(`[persona2] switchEnterChance 随机源异常：实得 ${typeof rawRoll} ${Number.isNaN(roll) ? String(roll) : String(rawRoll)}，本轮不切入`);
        return { ok: false, error: '切回失败：这次骰子没能掷出来（随机数异常），保持现状；下轮可以再试。' };
      }
      rolled = roll;
      if (roll >= chance) {
        return {
          ok: false, rolled, chance,
          error: `掷骰没中（${roll.toFixed(2)} ≥ ${chance.toFixed(2)}）——这次不切进来，保持现状；想上可以下轮再调。`
        };
      }
    }
    const p2 = { ...(read('persona2', {}) || {}), pendingEnterReason: String(reason || 'tool'), pendingEnterAt: Date.now() };
    try {
      const result = { ok: true, requested: true, takesEffectBeforeNextPrompt: true };
      if (rolled !== null) { result.rolled = rolled; result.chance = chance; }
      save({ persona2: p2 });
      return result;
    } catch (error) { return { ok: false, error: `could not persist enter request: ${String(error?.message ?? error)}` }; }
  }

  function requestPersonaTwoExit(reason = 'switch_back') {
    if (read('persona2.enabled', false) !== true) return { ok: false, error: 'switch_back is only available while persona two is active' };
    // ★ 回程骰子（2026-10-12 用户裁定：切过去与切回来**两向都掷骰**；触发者是模型，骰子定成败）：
    //   只作用在"模型主动调 switch_back"这一条路 —— 自动兜底族（maxTurns/maxMinutes/recover）
    //   不走这里、也不受它影响（用户已明确不要自动兜底，那族保持默认关）。
    //   概率键 `persona2.switchBackChance`：**缺键 = 不掷、必成**（既有自测替身零随机；
    //   生产的 0.5 由 defaults 提供，见 config-store/defaults.js persona2 块）。
    //   掷法与随机进入同口径：roll ∈ [0,1)，roll < chance 才算中；rng 不合契约直接抛（fail-closed 保持原位）。
    const chanceRaw = Number(read('persona2.switchBackChance', 1));
    const chance = Number.isFinite(chanceRaw) ? Math.min(1, Math.max(0, chanceRaw)) : 1;
    let rolled = null;
    if (chance < 1) {
      const rawRoll = random();
      const roll = Number(rawRoll);
      if (!(roll >= 0 && roll < 1)) {
        // 随机源异常（注入坏值 / 默认值 bug）：fail-closed 保持原位 + 用户能看懂的文案，
        // 细节进日志给排障 —— 不把内部字段名与区间期望甩给用户（2026-10-13 用户实测口径）。
        log(`[persona2] switchBackChance 随机源异常：实得 ${typeof rawRoll} ${Number.isNaN(roll) ? String(roll) : String(rawRoll)}，本轮不切回`);
        return { ok: false, error: '切回失败：这次骰子没能掷出来（随机数异常），保持原位；下轮可以再试。' };
      }
      rolled = roll;
      if (roll >= chance) {
        return {
          ok: false, rolled, chance,
          error: `掷骰没中（${roll.toFixed(2)} ≥ ${chance.toFixed(2)}）——这次不切回，保持原位；想退可以下轮再调 switch_back。`
        };
      }
    }
    const p2 = { ...(read('persona2', {}) || {}), pendingExitReason: String(reason || 'switch_back'), pendingExitAt: Date.now() };
    try {
      const result = { ok: true, requested: true };
      if (rolled !== null) { result.rolled = rolled; result.chance = chance; }
      save({ persona2: p2 });
      return result;
    } catch (error) { return { ok: false, error: `could not persist exit request: ${String(error?.message ?? error)}` }; }
  }

  function consumePendingExit(state = null) {
    const reason = String(read('persona2.pendingExitReason', '') || '').trim();
    if (read('persona2.enabled', false) !== true) return { ok: true, consumed: false };
    const p2 = read('persona2', {}) || {};
    let exitReason = reason ? `self(${reason})` : '';
    const enteredAt = Number(p2.stats?.enteredAt) || 0;
    const dwellMs = enteredAt ? Date.now() - enteredAt : 0;
    if (!exitReason && Number(p2.maxTurns) > 0 && turnsThisRun >= Number(p2.maxTurns)) exitReason = `max-turns(${turnsThisRun})`;
    if (!exitReason && Number(p2.maxMinutes) > 0 && dwellMs >= Number(p2.maxMinutes) * 60000) exitReason = 'max-minutes';
    const trigger = p2.trigger || {};
    const minDwellMs = Math.max(0, Number(trigger.minDwellMin) || 0) * 60000;
    if (!exitReason && state && trigger.recoverExitEnabled === true && dwellMs >= minDwellMs) {
      const affect = state?.self?.affect || {};
      const load = ['anger', 'irk', 'irritation', 'anxiety', 'sadness', 'shame', 'loneliness', 'down', 'boredom']
        .reduce((sum, key) => sum + (Number(affect[key]) || 0), 0);
      const recoverThreshold = Number(trigger.recoverThreshold);
      if (Number.isFinite(recoverThreshold) && load <= recoverThreshold) exitReason = `recovered(${load}<=${recoverThreshold})`;
    }
    if (!exitReason) return { ok: true, consumed: false };
    return setEnabled(false, { reason: exitReason }).then((result) => ({ ...result, consumed: result.ok === true }));
  }

  function maybeAutoEnter(state) {
    const p2 = read('persona2', {}) || {};
    const trigger = p2.trigger || {};
    if (p2.enabled === true) {
      startupRecoveryPending = false;   // 启动时就在位 ⇒ 恢复已由盘上状态完成，往后全按常规语义
      return { enter: false, reason: 'disabled-or-already-active' };
    }
    // ★ LLM 触发的挂起进入（镜像 switch_back：骰在请求时已掷过，这里只等轮首消费）。
    //   用户口径"触发者是模型" ⇒ 不走阈值/冷却/hype/定时这些**自动**闸；只受总开关
    //   featureEnabled 约束。trigger.enabled=false（只手动切）也拦不住它——模型触发与
    //   面板手动同级。消费成功后由 setEnabled(true) 清 pendingEnter（失败则下轮重试）。
    //   ★ 2026-10-16 · 启动恢复：只认**本进程**写下的意图（`pendingEnterAt >= bootAt`）。
    //     重启后残留的旧意图不是"新一轮触发"，一律丢弃、不切人（构造期已清一次，这里是
    //     兜底：那次清理写盘失败时也不许把人切过去）。
    const pendingEnter = String(p2.pendingEnterReason ?? '').trim();
    if (pendingEnter) {
      const pendingAt = Number(p2.pendingEnterAt) || 0;
      if (pendingAt >= bootAt) {
        if (p2.featureEnabled !== true) return { enter: false, reason: 'disabled-or-already-active' };
        return { enter: true, reason: `tool(${pendingEnter})` };
      }
      try { save({ persona2: { ...p2, pendingEnterReason: '', pendingEnterAt: 0 } }); } catch { /* 清不掉也不切人 */ }
      log(`[persona2] 启动恢复：忽略上一进程遗留的进入意图（${pendingEnter}）`);
      startupRecoveryPending = false;
      return { enter: false, reason: 'startup-recovery' };
    }
    // ★ 2026-10-16 · 启动恢复 vs 新一轮触发：进程启动后的**首次**轮首预检只做恢复
    //   （盘上 enabled 即最后有效人格状态），不把"刚开机读到的旧情绪负载"当成新一轮触发；
    //   从第二次预检起，阈值/冷却/亢奋闸等自动触发语义逐字照旧（含随机与计时那两条独立路径）。
    if (startupRecoveryPending) {
      startupRecoveryPending = false;
      log('[persona2] 启动恢复：本次轮首预检不参与自动触发（下一条新消息起照旧）');
      return { enter: false, reason: 'startup-recovery' };
    }
    // ★ 2026-10-17（发行版默认关自动触发）：判据由 `trigger.enabled === false` 改成 `!== true`
    //   —— 缺键时**也保持关**（fail-closed）。旧判据把"没这个键"当成开，于是任何只写了
    //   `featureEnabled/trigger` 子对象的配置都会照常自动顶人；默认值 `false` 与消费方由此一致。
    if (p2.featureEnabled !== true || trigger.enabled !== true) return { enter: false, reason: 'disabled-or-already-active' };
    if (read('hypeMode.enabled', false) === true) return { enter: false, reason: 'hype-active' };
    const affect = state?.self?.affect || {};
    const load = ['anger', 'irk', 'irritation', 'anxiety', 'sadness', 'shame', 'loneliness', 'down', 'boredom']
      .reduce((sum, key) => sum + (Number(affect[key]) || 0), 0);
    const threshold = Number(trigger.threshold) || 40;
    if (load <= threshold) return { enter: false, reason: 'below-threshold', load, threshold };
    const cooldownMs = Math.max(0, Number(trigger.cooldownMin) || 0) * 60000;
    const last = Number(p2.lastSwitchAt) || 0;
    if (cooldownMs && last && Date.now() - last < cooldownMs) return { enter: false, reason: 'cooldown', load, threshold };
    return { enter: true, reason: `emotion(${load}>${threshold})`, load, threshold };
  }

  function status() {
    const p2 = read('persona2', {}) || {};
    return { enabled: p2.enabled === true, featureEnabled: p2.featureEnabled === true,
      enteredAt: p2.enabled === true ? Number(p2.stats?.enteredAt) || null : null,
      enterReason: p2.enabled === true ? String(p2.stats?.reason || '') : '',
      turns: p2.enabled === true ? turnsThisRun : null,
      lastSwitchAt: Number(p2.lastSwitchAt) || null,
      pendingExitReason: String(p2.pendingExitReason || ''), pendingExitAt: Number(p2.pendingExitAt) || null,
      pendingEnterReason: String(p2.pendingEnterReason || ''), pendingEnterAt: Number(p2.pendingEnterAt) || null,
      trigger: p2.trigger || {}, maxTurns: Number(p2.maxTurns) || 0, maxMinutes: Number(p2.maxMinutes) || 0,
      avatarOn: String(p2.avatarOn || ''), avatarOff: String(p2.avatarOff || ''),
      randomHitsLastHour: randomHitTimes.filter((at) => Date.now() - at < 3600000).length,
      occupancy: occupancy(p2, Date.now()) };
  }

  async function onTick(now, payload = {}) {
    const at = Number(now);
    const rng = payload.clock?.random;
    if (!Number.isFinite(at) || typeof rng !== 'function') return { skipped: true, reason: 'clock-or-random-unavailable' };
    const running = Array.isArray(payload.status?.running) ? payload.status.running : [];
    const pending = Array.isArray(payload.status?.pending) ? payload.status.pending : [];
    if (read('persona2.enabled', false) === true) {
      if (running.length === 0 && pending.length === 0) {
        const exit = await consumePendingExit(getEmotionState());
        if (exit.consumed === true) return { exited: true, reason: exit.reason || 'persona-two-exit' };
      }
      return { skipped: true, reason: 'persona-two-active' };
    }
    const p2 = read('persona2', {}) || {};
    const random = p2.trigger?.random || {};
    if (p2.featureEnabled !== true || random.enabled !== true || read('hypeMode.enabled', false) === true) {
      nextRandomAt = 0;
      return { skipped: true, reason: 'random-persona-disabled' };
    }
    if (running.length + pending.length >= Math.max(1, Number(read('maxConcurrentRuns', 2)) || 2)) return { skipped: true, reason: 'runtime-busy' };
    const minMinutes = Math.max(1, Number(random.intervalMinMin) || 20);
    const maxMinutes = Math.max(minMinutes, Number(random.intervalMaxMin) || 40);
    const scheduleNext = () => {
      const sample = Number(rng());
      if (!(sample >= 0 && sample < 1)) throw new Error('clock.random must return a number in [0, 1)');
      nextRandomAt = at + (minMinutes + Math.floor(sample * (maxMinutes - minMinutes + 1))) * 60000;
    };
    if (!nextRandomAt) { scheduleNext(); return { scheduled: true, nextAt: nextRandomAt }; }
    if (at < nextRandomAt) return { scheduled: false, nextAt: nextRandomAt };
    scheduleNext();
    const store = getChatStore();
    if (typeof store?.listChats !== 'function' || typeof store?.recent !== 'function') return { skipped: true, reason: 'chat-store-unavailable' };
    const allow = read('allow', {}) || {};
    const groups = Array.isArray(allow.groups) ? allow.groups.map(String) : [];
    const privates = Array.isArray(allow.private) ? allow.private.map(String) : [];
    const busyKeys = new Set([...running, ...pending].map((row) => String(row.chatKey || '')));
    let candidates = [];
    try {
      candidates = store.listChats().filter((key) => {
        const [kind, id] = String(key).split(':');
        if (busyKeys.has(String(key))) return false;
        if (kind === 'group' && !(groups.length ? groups.includes(id) : read('allowAllWhenEmpty', false) === true)) return false;
        if (kind === 'private' && !privates.includes(id)) return false;
        if (kind !== 'group' && kind !== 'private') return false;
        if (typeof store.unreadCount === 'function' && store.unreadCount(key) > 0) return false;
        return true;
      });
    } catch (error) { return { skipped: true, reason: `chat-candidate-read-failed:${String(error?.message ?? error)}` }; }
    if (!candidates.length) return { skipped: true, reason: 'no-allowed-chat' };
    const selection = Number(rng());
    if (!(selection >= 0 && selection < 1)) throw new Error('clock.random must return a number in [0, 1)');
    const chatKey = candidates[Math.floor(selection * candidates.length)];
    let lastSelfSpeakAt = 0;
    try {
      const recent = store.recent(chatKey, { limit: 240, includeSelf: true });
      lastSelfSpeakAt = recent.reduce((latest, row) => row?.self === true ? Math.max(latest, Number(row.ts) || 0) : latest, 0);
    } catch { /* missing history is treated as unknown, not a fabricated recent send */ }
    const afterSpeakMs = Math.max(0, Number(random.afterSpeakMin) || 0) * 60000;
    if (afterSpeakMs && lastSelfSpeakAt > 0 && at - lastSelfSpeakAt < afterSpeakMs) return { skipped: true, reason: 'recent-self-speech', chatKey };
    const occupancyMax = Number(random.occupancyMax);
    const currentOccupancy = occupancy(p2, at);
    if (Number.isFinite(occupancyMax) && currentOccupancy >= occupancyMax) return { skipped: true, reason: 'occupancy-limit', chatKey, occupancy: currentOccupancy };
    const cooldownMs = Math.max(0, Number(p2.trigger?.cooldownMin) || 0) * 60000;
    if (cooldownMs && Number(p2.lastSwitchAt) > 0 && at - Number(p2.lastSwitchAt) < cooldownMs) return { skipped: true, reason: 'cooldown', chatKey };
    const chance = Math.min(1, Math.max(0, Number(random.chancePerCheck) || 0));
    const roll = Number(rng());
    if (!(roll >= 0 && roll < 1)) throw new Error('clock.random must return a number in [0, 1)');
    if (roll >= chance) return { skipped: true, reason: 'random-miss', chatKey, roll };
    const entered = await setEnabled(true, { reason: 'random(timer)' });
    if (entered.ok !== true) return { skipped: true, reason: entered.error || 'entry-rejected', chatKey };
    randomHitTimes = randomHitTimes.filter((time) => at - time < 3600000);
    randomHitTimes.push(at);
    if (typeof payload.wake === 'function') await payload.wake({ chatKey, proactive: true, proactiveReason: 'random' });
    return { entered: true, chatKey, occupancy: currentOccupancy };
  }

  return Object.freeze({
    isPersonaTwo: () => read('persona2.enabled', false) === true,
    setEnabled, setPersonaTwo: setEnabled, requestPersonaTwoEnter, requestPersonaTwoExit, consumePendingExit, maybeAutoEnter,
    personaTwoStatus: status, effectivePersona,
    noteTurn: () => { if (read('persona2.enabled', false) === true) turnsThisRun += 1; return turnsThisRun; },
    onTick, status
  });
}

function openSpan(list, now) {
  const rows = Array.isArray(list) ? list.filter((row) => Array.isArray(row) && row.length >= 2).map((row) => [...row]) : [];
  if (!rows.some((row) => row[1] == null)) rows.push([now, null]);
  return rows;
}

function closeSpan(list, now) {
  const rows = Array.isArray(list) ? list.filter((row) => Array.isArray(row) && row.length >= 2).map((row) => [...row]) : [];
  for (let index = rows.length - 1; index >= 0; index--) {
    if (rows[index][1] == null) { rows[index][1] = now; break; }
  }
  return rows;
}

function occupancy(p2, now) {
  const windowMs = Math.max(0.1, Number(p2?.trigger?.random?.occupancyWindowH) || 6) * 3600000;
  const from = now - windowMs;
  let total = 0;
  for (const row of Array.isArray(p2?.onSpans) ? p2.onSpans : []) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const start = Math.max(Number(row[0]) || 0, from);
    const end = row[1] == null ? now : Math.min(Number(row[1]) || 0, now);
    if (end > start) total += end - start;
  }
  return Math.min(1, total / windowMs);
}
