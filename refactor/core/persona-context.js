/**
 * refactor/core/persona-context.js — 人设切换的**短期上下文分界**（2026-10-17 用户最终口径）
 *
 * 用户原话（已纠正先前方案）：「每次切换任意人设都可以隔离，隔离短期记忆就行了，长期不用隔离」
 * 「就发入上下文的隔离就可以了」。
 *
 * 所以本文件**只做一件事**：在每次**真实切换**（当前有效角色卡实质变化，或第一/第二人格维度变化）时
 * 推进一条**持久分界** `{epoch, changedAt}`；组模请求时据此过滤**短期**输入。
 *
 * 明确**不做**（长期共享，绝不打标签/不换命名空间）：
 *   · 人物印象、长期事实/偏好、语义卡、相关情节、向量索引、跨群授权 —— 全部按原规则召回；
 *   · 不清空/不复制/不重建任何长期数据，不重置好感/情绪/预算/全局知识；
 *   · 不给历史行批量改 id/打 personaContext 标签；不提供 tag/visible/subscribe 那套长期契约。
 *
 * ── 切换判定（2026-10-17 收口）────────────────────────────────────────────────
 *   身份签名 = **当前真正生效**的角色卡内容（归一化后）+ 第一/第二人格维度。
 *   · 优先用装配层注入的 `getEffectivePersona()`（第一人格 = persona.roleText；第二人格在位 =
 *     persona2.roleText）⇒ 后台编辑**当前未生效那张卡**不会改变签名、不假切；
 *   · 拿不到 getter 时才退回配置读取（旧行为，仅供无 emotion 实例的装配/自测）。
 *   · 不 hash 时间、不 hash 整份配置；同卡重复应用 / 改 API、价格、主题、刷新都不切。
 *
 * ── 签名迁移（纯升级算法不误切）───────────────────────────────────────────────
 *   v1（c455da5c）签名只看配置 `persona.roleText + persona2.enabled`。升级到 v2（有效卡）时，
 *   旧文件里只有 `version:1` 的签名 —— **无法**可靠重建旧算法输入（可能编辑过未生效卡）
 *   ⇒ v1 文件一次性**只迁移、不推进 epoch**（`migration:'legacy-v1-adopted'`）；
 *   之后 v2 签名变化才是真实切换。v2 文件重启时签名相同 ⇒ 继承，不每重启又切一次。
 *
 * ── 持久化 / 首次迁移 / 重启 ────────────────────────────────────────────────
 *   `<dataDir>/persona-boundary.json`：{version:2, signature, legacySignature, epoch, changedAt}。
 *   · 首次运行：只记录签名，`epoch=0, changedAt=0` ⇒ **不过滤**（不无端清掉现有上下文）；
 *   · 重启且签名相同：继承最后分界；
 *   · 签名不同（v2 文件）：`epoch+1`、`changedAt=真实切换时刻`（clock 给的毫秒），立即落盘；
 *   · 切回旧人设同样推进新分界（**不**恢复旧人设以前的短期聊天）。
 *
 * ── 过滤判据 ────────────────────────────────────────────────────────────────
 *   · 短期输入行只要**能证明发生时刻**（毫秒数 / Date / ISO 字符串）且 `at < changedAt` ⇒ 丢弃；
 *     `at` 晚于 `now`（时钟漂移）⇒ 保留；
 *   · **分界之后，时间未知的短期行一律不注入**（宁可少给，不让旧人设的块漏进来）。
 *     触发输入（本轮 evidence）不走这个 filter；长期来源（印象/事实/情节/语义卡）也不走。
 *   · `filterShortTerm(rows, { snapshot })` 允许调用方传入**本轮冻结的分界快照**（同一轮里历史、
 *     其它短期块、预算重画共用同一 epoch/changedAt，不因跨 await 时切卡而前后口径不一）。
 *   · 诊断只出 epoch/changedAt/过滤条数，不含任何原文或密钥。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const PERSONA_BOUNDARY_FILE = 'persona-boundary.json';
export const PERSONA_BOUNDARY_VERSION = 2;
const PERSONA_SIGNATURE_LEGACY_VERSION = 1;

/** 角色卡内容归一化：只做无害折叠（不改正文语义）。 */
export function normalizePersonaRoleText(raw) {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** v2 身份签名：**当前有效**角色卡内容 + 第一/第二人格维度（不含时间、不含整份配置）。 */
export function personaSignatureOf({ roleText = '', personaTwo = false } = {}) {
  const card = normalizePersonaRoleText(roleText) || 'builtin-default';
  const dim = personaTwo ? 'persona-two' : 'persona-one';
  return crypto.createHash('sha256')
    .update(`${PERSONA_BOUNDARY_VERSION}\u0000${dim}\u0000${card}`)
    .digest('hex').slice(0, 24);
}

/**
 * v1 签名（c455da5c 的算法）：输入是**配置里的** `persona.roleText + persona2.enabled`。
 * 只用于识别/迁移旧文件（见文件头"签名迁移"）；新判定不再用它。
 */
export function personaSignatureLegacyV1({ roleText = '', personaTwo = false } = {}) {
  const card = normalizePersonaRoleText(roleText) || 'builtin-default';
  const dim = personaTwo ? 'persona-two' : 'persona-one';
  return crypto.createHash('sha256')
    .update(`${PERSONA_SIGNATURE_LEGACY_VERSION}\u0000${dim}\u0000${card}`)
    .digest('hex').slice(0, 24);
}

/** 统一时刻解析：毫秒数 / Date / 数字串 / ISO 字符串；解析不出返回 null（不按当前时间猜）。 */
export function parseShortTermTime(value) {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) && t > 0 ? t : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const t = Date.parse(raw);
  return Number.isFinite(t) && t > 0 ? t : null;
}

const REGISTRY = new Map();

/** 取已注册实例（按规范化 dataDir）。没有实例 ⇒ null（旧兼容：不做任何过滤）。 */
export function getPersonaBoundary(dataDir) {
  const key = String(dataDir ?? '').trim();
  if (!key) return null;
  try { return REGISTRY.get(path.resolve(key)) ?? null; } catch { return null; }
}

function safeNow(clock) {
  try {
    const n = Number(typeof clock === 'function' ? clock() : clock);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : Date.now();
  } catch { return Date.now(); }
}

function atomicWriteJson(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * @param {{dataDir?:string, configStore?:object, clock?:function|null,
 *          getEffectivePersona?:function|null, deferSignature?:boolean}} p
 *   `getEffectivePersona`：返回“当前真正生效”的 `{roleText, personaTwo}`（或 emotion.effectivePersona()
 *   的完整对象；这里只读这两个字段）。装配层在 emotion 实例就绪后注入；拿不到时退回配置读取。
 *   `deferSignature`：true = 先只载入持久状态，等 `initSignature()`（emotion 就绪后）再做首次判定，
 *   避免用配置角色卡算出的签名把 v1 旧文件误判成一次切换。
 * @returns {{
 *   current: () => {epoch:number, changedAt:number, signature:string, signatureVersion:number, initialized:boolean},
 *   initSignature: () => object,
 *   refresh: () => object,
 *   isShortTermVisible: (row:object, now?:number|null, snapshot?:object|null) => boolean,
 *   filterShortTerm: (rows:Array, opts?:{atOf?:function, snapshot?:object|null, allowUnknown?:boolean}) => {rows:Array, filtered:number, unknown:number},
 *   close: () => void
 * }}
 */
export function createPersonaBoundary({
  dataDir = '', configStore = null, clock = null,
  getEffectivePersona = null, deferSignature = false
} = {}) {
  const dir = String(dataDir ?? '').trim();
  const file = dir ? path.join(dir, PERSONA_BOUNDARY_FILE) : '';
  const registryKey = dir ? path.resolve(dir) : '';

  const readConfigPersona = () => {
    let roleText = '';
    let personaTwo = false;
    try { roleText = configStore?.get?.('persona.roleText', '') ?? ''; } catch { roleText = ''; }
    try { personaTwo = configStore?.get?.('persona2.enabled', false) === true; } catch { personaTwo = false; }
    return { roleText: String(roleText ?? ''), personaTwo };
  };
  const readEffectivePersona = () => {
    if (typeof getEffectivePersona !== 'function') return null;
    try {
      const effective = getEffectivePersona();
      if (!effective || typeof effective !== 'object' || Array.isArray(effective)) return null;
      return {
        roleText: String(effective.roleText ?? ''),
        personaTwo: effective.personaTwo === true
      };
    } catch { return null; }
  };
  const readSignature = () => personaSignatureOf(readEffectivePersona() ?? readConfigPersona());
  const readLegacySignature = () => personaSignatureLegacyV1(readConfigPersona());

  const state = {
    signature: '',
    legacySignature: '',
    signatureVersion: 0,
    epoch: 0,
    changedAt: 0,
    migration: '',
    initialized: false
  };

  if (file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        state.signature = String(parsed.signature ?? '');
        state.legacySignature = String(parsed.legacySignature ?? '');
        state.signatureVersion = Number.isSafeInteger(parsed.version) && parsed.version >= 1
          ? parsed.version : (state.signature ? 1 : 0);
        state.epoch = Number.isSafeInteger(parsed.epoch) && parsed.epoch >= 0 ? parsed.epoch : 0;
        state.changedAt = Number.isFinite(Number(parsed.changedAt)) ? Math.max(0, Math.floor(Number(parsed.changedAt))) : 0;
      }
    } catch { /* 首次运行/损坏：按首次迁移语义（不过滤） */ }
  }

  const persist = () => {
    if (!file) return;
    try {
      atomicWriteJson(file, {
        version: PERSONA_BOUNDARY_VERSION,
        signature: state.signature,
        legacySignature: state.legacySignature,
        epoch: state.epoch,
        changedAt: state.changedAt
      });
    } catch (error) { console.error('[persona-boundary] 持久化失败：', error?.message ?? error); }
  };

  const current = () => ({
    epoch: state.epoch,
    changedAt: state.changedAt,
    signature: state.signature,
    signatureVersion: state.signatureVersion,
    initialized: state.initialized,
    // 只报"是否发生过一次性算法迁移"（不落盘、不含内容）；正常运行时为空。
    ...(state.migration ? { migration: state.migration } : {})
  });

  /**
   * 首次签名判定（幂等；装配层在 emotion 就绪后调用）。规则见文件头“签名迁移”：
   *   · 无旧签名 ⇒ 首次运行（epoch 0，不过滤）；
   *   · v2 签名相同 ⇒ 继承；
   *   · v1 旧签名（无论是否算得出同值）⇒ **只迁移、不推进 epoch**；
   *   · v2 签名不同 ⇒ 真实切换（含关机期间换卡）。
   */
  const initSignature = () => {
    if (state.initialized) return current();
    const next = readSignature();
    const legacyNow = readLegacySignature();
    if (!state.signature) {
      state.signature = next;
      state.epoch = 0;
      state.changedAt = 0;
    } else if (state.signature === next) {
      // 同一张有效卡：继承最后分界（不重复切）
    } else if (state.signatureVersion < 2) {
      // 旧算法文件：无法可靠重建旧输入（可能编辑过未生效卡）⇒ 不误判成切换。
      state.signature = next;
      state.migration = 'legacy-v1-adopted';
    } else {
      state.signature = next;
      state.epoch += 1;
      state.changedAt = safeNow(clock);
    }
    state.signatureVersion = PERSONA_BOUNDARY_VERSION;
    state.legacySignature = legacyNow;
    state.initialized = true;
    persist();
    return current();
  };

  let closed = false;
  const refresh = () => {
    if (closed) return current();
    // 还没完成首次判定（emotion 尚未就绪）⇒ 不拿配置兜底签名去推进 epoch；交给 initSignature。
    if (!state.initialized) return current();
    const next = readSignature();
    const legacyNow = readLegacySignature();
    state.legacySignature = legacyNow;
    if (next === state.signature) return current();
    state.signature = next;
    state.signatureVersion = PERSONA_BOUNDARY_VERSION;
    state.epoch += 1;
    state.changedAt = safeNow(clock);
    persist();
    return current();
  };

  let unsubscribeConfig = null;
  try {
    if (configStore && typeof configStore.subscribeConfigChange === 'function') {
      unsubscribeConfig = configStore.subscribeConfigChange(() => { try { refresh(); } catch { /* 不中断配置链 */ } });
    }
  } catch { unsubscribeConfig = null; }

  const snapshotChangedAt = (snapshot) => {
    if (snapshot && typeof snapshot === 'object') {
      const ms = parseShortTermTime(snapshot.changedAt);
      return ms === null ? 0 : ms;
    }
    return state.changedAt;
  };

  /**
   * 短期行是否可见。`snapshot` = 本轮冻结的分界（`current()` 的返回值）；缺省用 live state。
   * 分界之后：有可信时刻 ⇒ 早于分界丢弃；**时间未知 ⇒ 不注入**（调用方可显式 allowUnknown）。
   */
  const isShortTermVisible = (row, now = null, snapshot = null, { allowUnknown = false } = {}) => {
    const changedAt = snapshotChangedAt(snapshot);
    if (!changedAt) return true;
    const at = parseShortTermTime(row?.at ?? row?.ts);
    if (at === null) return allowUnknown === true;
    const nowMs = Number.isFinite(Number(now)) && Number(now) > 0 ? Number(now) : Date.now();
    if (at > nowMs) return true;
    return at >= changedAt;
  };

  const filterShortTerm = (rows, { atOf = null, snapshot = null, allowUnknown = false } = {}) => {
    const list = Array.isArray(rows) ? rows : [];
    const changedAt = snapshotChangedAt(snapshot);
    if (!changedAt) return { rows: list.slice(), filtered: 0, unknown: 0 };
    const pick = typeof atOf === 'function' ? atOf : (row) => row?.at ?? row?.ts;
    const nowMs = Date.now();
    const out = [];
    let filtered = 0;
    let unknown = 0;
    for (const row of list) {
      const at = parseShortTermTime(pick(row));
      if (at === null) {
        if (allowUnknown === true) { out.push(row); continue; }
        filtered += 1;
        unknown += 1;
        continue;
      }
      if (at <= nowMs && at < changedAt) { filtered += 1; continue; }
      out.push(row);
    }
    return { rows: out, filtered, unknown };
  };

  const close = () => {
    if (closed) return;
    closed = true;
    try { unsubscribeConfig?.(); } catch { /* ignore */ }
    unsubscribeConfig = null;
    if (registryKey && REGISTRY.get(registryKey) === manager) REGISTRY.delete(registryKey);
  };

  const manager = Object.freeze({
    current,
    initSignature,
    refresh,
    isShortTermVisible,
    filterShortTerm,
    close,
    file,
  });
  // 热装配/重复装配：同 dataDir 的旧 manager 必须先关（退订配置 + 让出 REGISTRY），否则
  // 每次 assemble 都会多一个活着的订阅并各自推进 epoch。进程退出时订阅随进程消失。
  if (registryKey) {
    const previous = REGISTRY.get(registryKey);
    if (previous && previous !== manager) {
      try { previous.close?.(); } catch { /* 旧实例关闭失败不阻断新实例 */ }
    }
  }
  if (registryKey) REGISTRY.set(registryKey, manager);
  if (deferSignature !== true) initSignature();
  return manager;
}
