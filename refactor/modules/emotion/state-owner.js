/**
 * E1 · 情绪状态唯一所有者（加载 / 读取 / 管理修改 / 保存）。
 *
 * ★ 2026-10-12（唯一指导 §7.1）：把 `apps/server/assembly.js` 情绪门面里与"状态"有关的四件事
 *   迁进情绪模块 —— **不是只搬纯 apply 函数**：加载的三条 fail-closed 规则、管理修改（面板
 *   setBotState 语义）、正式提交（flush 的四条规则）与失败回执，都在这里。
 *   装配层保留接线（谁在轮末调 flush、把 configStore 递进来），切换请求见
 *   `.tmp-dispatch/2026-10-12/mimo1/E1-接线请求.md`。
 *
 * ★ 数值保真：`manageEdit` 的分支逻辑逐条对齐 assembly 的 `replaceState`（固定输入对照见
 *   回执的基准读数）。**唯一有意的差异**：手动修改现在会落台账行（带 at/前后值/来源 admin）
 *   —— 改前一个字节都不记（架构评审 B1），且这不改变任何状态数值。
 *
 * 依赖注入：`dataDir`（为空 ⇒ 只在内存跑，不落盘——与装配层同口径）、`log`（警告回调）、
 * `configStore`（有效配置来源：persona.emotionProfile + emotion.* 覆盖；缺省 ⇒ 档位默认）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../../core/util/index.js';
import { EMOTION_PROFILES, POOLS, PERSON_DEFAULTS, initState, normalizePerson } from './state.js';
import { applyEvent, project } from './apply.js';
import { snapshot } from './view.js';
import { relationOf } from './relation.js';

const DEFAULT_EMOTION_PROFILE_ID = 't7';
/** 旧 6 档 id → 新 id（逐字搬自 assembly.js:621-624；装配层切换后那份删除）。 */
const LEGACY_EMOTION_PROFILE_ID = Object.freeze({
  extrovert_sunny: 't7', introvert_soft: 't2', calm_rational: 't5',
  optimist: 't7', sensitive: 't4', fiery: 't8'
});

/**
 * 档位 id 归一（与 assembly 的 `emotionProfileId` 同语义）。
 * 装配层 `currentEmotionConfig` 遇到本导出会优先用它（assembly.js:629 注释预留的出口）。
 */
export function normalizeId(rawId) {
  const raw = String(rawId || '').trim();
  if (Object.prototype.hasOwnProperty.call(EMOTION_PROFILES, raw)) return raw;
  if (LEGACY_EMOTION_PROFILE_ID[raw]) return LEGACY_EMOTION_PROFILE_ID[raw];
  if (/^t[1-9]$/.test(raw)) return raw;
  return DEFAULT_EMOTION_PROFILE_ID;
}

/** 点路径读：拿不到就 undefined，不猜、不喂默认值（与 assembly:661-663 同口径）。 */
function readConfigKey(configStore, key) {
  try { return configStore?.get?.(key); } catch { return undefined; }
}

/**
 * 当前有效情绪配置 = 归一后的档位参数 + 用户 `emotion.*` 覆盖
 * （与 assembly 的 `currentEmotionConfig` 同语义；defaults 的 emotion 块与档位键零重叠）。
 */
export function resolveConfig(configStore) {
  const profileId = normalizeId(readConfigKey(configStore, 'persona.emotionProfile'));
  const profile = EMOTION_PROFILES[profileId] || EMOTION_PROFILES[DEFAULT_EMOTION_PROFILE_ID] || {};
  const raw = readConfigKey(configStore, 'emotion');
  const overrides = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { profileId, config: { ...profile, ...overrides } };
}

const round1 = (x) => Math.round(Number(x) * 10) / 10;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, Number(x)));

/**
 * 管理修改（面板 setBotState 语义）：**纯函数**，只改请求明确给出的字段，
 * 不做时间投影（未提交字段保持原样）；`reset:true` 回默认但不动人格底子。
 * 返回形状与装配层 replaceState 一致：{ok:true, applied, unsupported, state} |
 * {ok:false, error, unsupported}（失败时不动调用方的状态）。
 *
 * ★ 台账（E1 有意差异）：每个实际改动的字段落一行 {at, target:'self', field, before, after,
 *   delta, source:'admin'} —— "没有时间的记录不算记录"（2026-10-11 裁定 A 同口径）。
 */
export function manageEdit(state, patch = {}, at = Date.now()) {
  const cur = state ?? initState({ at });
  const next = structuredClone(cur);
  // 单独把时间基准推到 now：后续投影不把旧的 0/过期时间当成长时间未结算（照装配层）。
  next.self.lastSettledAt = Math.max(Number(cur.self?.lastSettledAt) || 0, at);
  const self = next.self;
  const applied = [];
  const rows = [];
  const unsupported = [];
  /** 一行管理修改台账；`target` 默认 self（关系改动用 `person:<qq>`，见下方 relation 分支）。 */
  const row = (field, before, after, target = 'self') => rows.push({ target, field, before, after, delta: round1(Number(after) - Number(before)) });

  if (patch.reset === true) {
    const fresh = initState({ at, selfId: cur.selfId }).self;
    self.pools = { ...fresh.pools };
    self.affect = { ...fresh.affect };
    self.mood = fresh.mood;
    self.arousal = fresh.arousal;
    self.acuteStress = fresh.acuteStress;
    self.chronicStress = fresh.chronicStress;
    // targetOffsets / facts / preferences 属"人格底子"，老树 reset 不动它们 ⇒ 这里也不动（照装配层）
    applied.push('reset');
    rows.push({ field: 'reset', before: null, after: null, delta: 0 });
  } else {
    if (patch.energy !== undefined && patch.energy !== null) {
      const e = patch.energy;
      if (e && typeof e === 'object') {
        for (const k of POOLS) {
          if (e[k] !== undefined) {
            const before = self.pools[k];
            self.pools[k] = round1(clamp(e[k], 0, 100));
            row(`pools.${k}`, before, self.pools[k]);
          }
        }
      } else {
        // 老树口径：energy 给数字 ⇒ 四池同值
        const avg = clamp(Number(e) || 50, 0, 100);
        for (const k of POOLS) {
          const before = self.pools[k];
          self.pools[k] = round1(avg);
          row(`pools.${k}`, before, self.pools[k]);
        }
      }
      applied.push('energy');
    }
    if (patch.mood !== undefined && patch.mood !== null) {
      let m = Number(patch.mood);
      if (Number.isFinite(m)) {
        if (m < 0) m = 50 + m;                 // 老树：仍接受少量 v1 负偏移
        const before = self.mood;
        self.mood = round1(clamp(Math.round(m), 0, 100));
        row('mood', before, self.mood);
        applied.push('mood');
      }
    }
    if (patch.social !== undefined && patch.social !== null) {
      const s = clamp(Number(patch.social) || 2, 1, 3);
      const before = self.pools.emotional;
      self.pools.emotional = round1((s / 3) * 100);
      row('pools.emotional', before, self.pools.emotional);
      applied.push('social');
    }
    if (patch.acuteStress !== undefined && patch.acuteStress !== null) {
      const before = self.acuteStress;
      self.acuteStress = round1(clamp(Number(patch.acuteStress) || 0, 0, 100));
      row('acuteStress', before, self.acuteStress);
      applied.push('acuteStress');
    }
    if (patch.chronicStress !== undefined && patch.chronicStress !== null) {
      const before = self.chronicStress;
      self.chronicStress = round1(clamp(Number(patch.chronicStress) || 0, 0, 100));
      row('chronicStress', before, self.chronicStress);
      applied.push('chronicStress');
    }
  }

  // ── 关系字段（★ 2026-10-18 N2）：面板手动改好感。本轮只开放 favor（其它关系字段如实列 unsupported）。
  //   写点与自动关系变更（apply.js 的 onRelation）是同一份 `state.persons[pid]`，并落一行
  //   `target:'person:<qq>'`、`source:'admin'` 的台账 ⇒ 好感页签（memory-audit?kind=favor）读得到。
  //   0 与未知分开：before 缺数值时按 PERSON_DEFAULTS（中性 50）作为基线，但写进去的是用户明确给的值。
  let relationEdit = null;
  if (patch.relation !== undefined && patch.relation !== null) {
    const rel = patch.relation && typeof patch.relation === 'object' && !Array.isArray(patch.relation) ? patch.relation : null;
    if (!rel) return { ok: false, error: 'relation 必须是对象（{ personId, favor }）', unsupported: ['relation'] };
    const pid = String(rel.personId ?? rel.senderId ?? '').trim();
    if (!pid || pid.length > 64) return { ok: false, error: 'relation.personId 必须是非空字符串（≤64 字符）', unsupported: ['relation.personId'] };
    for (const key of Object.keys(rel)) {
      if (key !== 'personId' && key !== 'senderId' && key !== 'favor') unsupported.push(`relation.${key}`);
    }
    if (rel.favor !== undefined && rel.favor !== null) {
      const target = Number(rel.favor);
      if (!Number.isFinite(target)) return { ok: false, error: 'relation.favor 必须是 0–100 的数字', unsupported: ['relation.favor'] };
      if (!next.persons || typeof next.persons !== 'object') next.persons = {};
      // 新建记录时 `lastSeenAt` 传 0（未知）—— 面板改好感不等于"见过他"，不伪造最近见面时间。
      if (!next.persons[pid] || typeof next.persons[pid] !== 'object') next.persons[pid] = normalizePerson(pid, {}, 0);
      const personRecord = next.persons[pid];
      const before = Number.isFinite(Number(personRecord.favor)) ? Number(personRecord.favor) : PERSON_DEFAULTS.favor;
      personRecord.favor = round1(clamp(target, 0, 100));
      row('favor', before, personRecord.favor, `person:${pid}`);
      applied.push('relation.favor');
      relationEdit = { personId: pid, favor: personRecord.favor };
    }
  }

  if (patch.emotions !== undefined && patch.emotions !== null) unsupported.push('emotions');
  if (!applied.length) {
    return {
      ok: false,
      error: unsupported.length
        ? `not-supported: 老树 setBotState 的 ${unsupported.join('、')} 在新树没有对应字段（情绪迁移时已明确丢弃）——不假装改了`
        : '没有可改的字段（支持 energy / mood / social / acuteStress / chronicStress / relation.favor / reset）',
      unsupported
    };
  }

  for (const r of rows) {
    next.seq = (Number(next.seq) || 0) + 1;
    next.ledger.push({
      seq: next.seq, kind: 'event', deterministic: false, at,
      target: r.target || 'self', field: r.field, before: r.before, after: r.after, delta: r.delta,
      magnitude: Math.abs(r.delta) / 100, source: 'admin', evidenceIds: [], reason: '面板手动修改'
    });
  }
  return { ok: true, applied, unsupported, state: next, ...(relationEdit ? { relation: relationEdit } : {}) };
}

/**
 * 状态所有者。语义与 assembly 情绪门面逐条对齐（对照读数见回执基准）：
 *  - 加载三条 fail-closed：文件在但读不动 ⇒ **抛**；initState 抛 ⇒ 抛（向上冒泡）；
 *    没迁移（有 bot-state.json 无 emotion-state.json）⇒ 不落盘只警告 + blocked='unmigrated'。
 *  - flush 四条：无 dataDir ⇒ {ok:false,reason:'no-data-dir'}；blocked ⇒ 同形拒绝；
 *    不脏 ⇒ {ok:true,skipped:'clean'}；脏 ⇒ writeJsonAtomic 原子写后 dirty=false。
 *  - applyEvent：每调用即读有效配置（配置改动下一次调用生效），置 dirty —— 与装配层一致。
 */
export function createStateOwner({ dataDir = '', log = null, configStore = null } = {}) {
  const stateFile = dataDir ? path.join(dataDir, 'emotion-state.json') : '';
  let blocked = '';
  let dirty = false;
  let lastFlushError = null;   // 最近一次真写盘失败原因（成功刷盘即清；见 persistence()）
  let state;

  if (stateFile && fs.existsSync(stateFile)) {
    const raw = fs.readFileSync(stateFile, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    } catch (error) {
      throw new Error(`[emotion] 情绪状态文件读不动（${stateFile}）：${error?.message ?? error}`
        + ' —— 拒绝以"空白状态"启动（会静默清掉关系）。先备份/修复该文件。');
    }
    state = initState(parsed?.state ?? parsed ?? {});
  } else {
    state = initState({});
    if (stateFile && fs.existsSync(path.join(dataDir, 'bot-state.json'))) {
      blocked = 'unmigrated';
      log?.('[emotion] 检测到旧情绪状态 bot-state.json 但还没有 emotion-state.json：情绪/关系按默认值运行，且不落盘'
        + '（避免把空白写成正式状态）。迁移：node refactor/apps/server/migrate-emotion-state.mjs（默认 dry-run，--apply 才写）');
    }
  }

  const config = () => resolveConfig(configStore).config;
  return {
    /** 原始状态（runtime/提示词用；读侧不推进时间）。 */
    stateOf: () => state,
    /** 时间投影（只读：不动正式状态、不落盘）。 */
    project: (at) => project(state, at, config()),
    relationOf: ({ senderId } = {}) => relationOf(state, senderId),
    /** 只读快照（UI/trace 用）；入参显式给状态时投影它，不吞参数。 */
    snapshot: (input) => snapshot(input ?? state),
    /** 状态推进唯一入口（M7 纯函数外包一层生命周期）。 */
    applyEvent: (event) => {
      state = applyEvent(state, event, config());
      dirty = true;
      return state;
    },
    /** 管理修改（面板）；成功才提交 + 置脏，失败原样返回且不动状态。 */
    manageEdit: (patch = {}, opts = {}) => {
      const at = Number(opts.at) || Date.now();
      const result = manageEdit(state, patch, at);
      if (result?.ok !== true) return result;
      state = result.state;
      dirty = true;
      return result;
    },
    /** 正式提交到盘（M15 轮末与 stop 各调一次的那支笔）。 */
    flush: () => {
      if (!stateFile) return { ok: false, reason: 'no-data-dir' };
      if (blocked) return { ok: false, reason: blocked, file: stateFile };
      if (!dirty) return { ok: true, skipped: 'clean', file: stateFile };
      try {
        writeJsonAtomic(stateFile, state);
      } catch (error) {
        // ★ E3 缺口（2026-10-13）：权限型失败（EPERM rename 等）只抛不落字段 ⇒ 界面只见 pending。
        //   记下最近一次失败原因供 persistence() 暴露；**照旧向上抛**（M15/stop 的既有捕获路径不变）。
        //   取值：错误码 + 一句话（截 200 字）；Node 的 message 自带 "EPERM: " 前缀 ⇒ 已带就不再拼，
        //   免得出现 "EPERM: EPERM: …" 双前缀（mimo2 接视图时实测报过）；都取不到 ⇒ 字面"取不到"。
        const code = String(error?.code ?? '');
        const msg = String(error?.message ?? '');
        if (!code && !msg) lastFlushError = '取不到';
        else if (code && msg.startsWith(`${code}:`)) lastFlushError = msg.slice(0, 200);
        else lastFlushError = `${code || '无错误码'}: ${msg || '无消息'}`.slice(0, 200);
        throw error;
      }
      dirty = false;
      lastFlushError = null;   // ★ 清除时机：下一次成功刷盘即清
      return { ok: true, file: stateFile };
    },
    /**
     * 自述：文件在哪、为什么不落盘、有没有脏数据。
     * `lastFlushError`：最近一次**真写盘失败**的原因（成功刷盘即清；从未失败 = null；
     * 无 dataDir/blocked/clean 这三种"没到写盘"的回执不算失败、不动此字段）。
     */
    persistence: () => ({ file: stateFile, blocked: blocked || null, dirty, lastFlushError })
  };
}
