// M11 media · 边界层（**新写**，不是搬运件；派单要求里唯一的"行为级"改动全部落在这里）
//
// ★ **只许 media 自己用。** 本文件不在 refactor/README.md §3.5 冻结面里，
//   别的模块**不许** import 它（裁定③，2026-10-04指挥位）。它不是纯数据结构（那归 `contracts/`），
//   是 media 的**边界守卫 + 行为断言**。
// ★ 本文件**零 import**（只用语言内建）—— 兄弟模块（core/*、modules/*）还没齐备时，
//   selftest 必须能照样真跑起来；也因为零依赖，才禁得住被别人偷用（见 MEDIA_MODULE_LOCAL 标记）。
//
// 为什么要单独一层：派单同时要求「9 个文件逐字节搬 + 只改 import」与「改 3 条边界」。
// 两条硬要求会在文件里互相打架（改了文件 = 破坏保真表）。本层的分工是：
//   ·9 个搬运文件保持**零行为改动**（保真表可以逐行证明）；
//   ·3 条边界以**可测的纯函数 + 静态守卫**的形式实现，由 index.js 一起对外；
//   ·下游（M5 scenario / M10 act / 装配层）必须走这一层，不许直接调搬运件的裸函数。
//
// ★ 本文件**零 import**（只用语言内建）—— 兄弟模块（core/*、modules/*）此刻还没齐备，
//   selftest 必须能在邻居缺失时照样真跑起来。
//
// ── 三条边界 ──
//   B1 媒体层不决定"发不发/发什么"：只提供「找 / 存 / 看」（返回候选 + 元信息）。
//      搬运件里不允许出现任何发送面符号；OneBotClient 只准用于下载/取图。
//   B2 不猜图中人：视觉产出的每条结论必须带 source（自述/转述/引用/模型推测/工具确认）。
//      这是验收第 6 条「图里动作不归因给发图人」的前置。
//   B3 失败要说失败：下载/解码/视觉调用失败 ⇒ { ok:false, reason }，
//      **不许**用空数组 / 空字符串冒充"没有图 / 空结果"。

// ══════════════════════════════════════════════════════════════════════
// B1 · 媒体层不含发送面
// ══════════════════════════════════════════════════════════════════════

/** 媒体层绝对不许出现的发送面符号（标识符级，不含注释）。 */
export const SEND_SURFACE_FORBIDDEN = Object.freeze([
  'sendGroupMsg',
  'sendPrivateMsg',
  'sendMsg',
  'sendMessage',
  'sendGroupForwardMsg',
  'sendPrivateForwardMsg',
  'sendGroupAiRecord',
  'sender.js',
]);

/** 出现即红、但可能只是注释里提了一嘴的词（只报告，不判红）。 */
export const SEND_SURFACE_SOFT = Object.freeze([
  'send_image',
  'sendImage',
  'sendRecord',
  'sendToGroup',
  'postMessage',
  'send-recovery.js',
]);

/**
 * 把注释抹成等长空格 —— 这样静态守卫只看**代码**，不会因为
 * 「用途：…检索后 send_image」这种说明性注释误判（image-lib.js:3 / :53 就有）。
 */
export function stripComments(code) {
  return String(code)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)));
}

function tokenHits(code, token) {
  const out = [];
  const re = new RegExp('(?<![\\w$.])' + token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  let m;
  while ((m = re.exec(code))) {
    const line = code.slice(0, m.index).split('\n').length;
    out.push({ token, line, text: code.split('\n')[line - 1].trim() });
  }
  return out;
}

/**
 * 静态扫描一批源文件里有没有发送面。返回可判定的结构，供 selftest / CI 断言。
 * @param {Array<{name:string, code:string}>} files
 */
export function scanSendSurface(files) {
  const violations = [];
  const soft = [];
  for (const f of files) {
    const code = stripComments(f.code);
    for (const t of SEND_SURFACE_FORBIDDEN) {
      for (const h of tokenHits(code, t)) violations.push({ file: f.name, ...h });
    }
    for (const t of SEND_SURFACE_SOFT) {
      for (const h of tokenHits(code, t)) soft.push({ file: f.name, ...h });
    }
  }
  return { violations, soft, clean: violations.length === 0 };
}

/** 断言式：媒体层出现发送面就抛。给装配层在 import 本模块时用。 */
export function assertNoSendSurface(files) {
  const r = scanSendSurface(files);
  if (!r.clean) {
    throw new Error(`[media/B1] 媒体层出现发送面符号：${r.violations.map((v) => `${v.file}:${v.line} ${v.token}`).join('; ')}`);
  }
  return true;
}

/**
 * B1 的另一半：OneBotClient 只准用于「下载/取图」。
 *   · 方法名白名单：只准读动作的方法；
 *   · `.call('<action>')` 里的 action 白名单：只准读动作（发送类 action 不在表里）。
 * 搬运件 sticker-manager.js 目前用到的方法/动作：call / getMsg / fetch_custom_face_detail / httpUrl。
 */
export const ONEBOT_READONLY_METHODS = Object.freeze([
  'call',      // 动态 action —— 真正的闸门在下面的 action 白名单
  'getMsg',
  'getMsgById',
  'downloadFile',
]);

export const ONEBOT_READONLY_ALLOWED = Object.freeze([
  'fetch_custom_face_detail',
  'get_msg',
  'get_image',
  'download_file',
]);

// ══════════════════════════════════════════════════════════════════════
// B2 · 不猜图中人：每条视觉结论必须带 source
// ══════════════════════════════════════════════════════════════════════

/** 视觉结论的来源枚举（机器码 → 人话）。**没有 source 的结论一律不许出模块。 */
export const VISION_SOURCE = Object.freeze({
  self_report: '自述',       // 画面里的人自己说了/文字里明写第一人称自述
  hearsay: '转述',           // 别人（机器人/第三方）转述的
  quote: '引用',             // 引用他人原话
  model_guess: '模型推测',   // 模型看图猜的
  tool_confirmed: '工具确认', // 工具/协议端给出的硬事实（OCR 命中、字节魔数等）
});

export const VISION_SOURCE_CODES = Object.freeze(Object.keys(VISION_SOURCE));

/** 结论的主体：图里的人 vs 发图的人。二者不可混。 */
export const VISION_SUBJECT = Object.freeze({ image: '图里的人', sender: '发图人', unknown: '不明' });

function isValidSource(s) {
  return typeof s === 'string' && Object.prototype.hasOwnProperty.call(VISION_SOURCE, s);
}

/**
 * 造一条视觉结论。**缺 source 直接抛**（§3.1「不许静默放过」的同一口径）。
 * @param {{text:string, source:string, subject?:string, confidence?:number, evidenceId?:string}} c
 */
export function visionConclusion(c) {
  if (!c || typeof c !== 'object') throw new TypeError('[media/B2] visionConclusion 需要一个对象');
  const text = String(c.text ?? '').trim();
  if (!text) throw new Error('[media/B2] 视觉结论必须有 text');
  if (!isValidSource(c.source)) {
    throw new Error(`[media/B2] 视觉结论必须带合法 source（${VISION_SOURCE_CODES.join('|')}），收到：${JSON.stringify(c.source)}`);
  }
  const hasSubject = c.subject !== undefined && c.subject !== null && c.subject !== '';
  if (hasSubject && !Object.prototype.hasOwnProperty.call(VISION_SUBJECT, c.subject)) {
    throw new Error(`[media/B2] 非法 subject：${JSON.stringify(c.subject)}（合法：${Object.keys(VISION_SUBJECT).join('|')}）`);
  }
  const subject = hasSubject ? c.subject : 'unknown';
  return {
    text,
    source: c.source,
    sourceLabel: VISION_SOURCE[c.source],
    subject,
    attributedToSender: subject === 'sender',
    confidence: typeof c.confidence === 'number' ? c.confidence : null,
    evidenceId: c.evidenceId ? String(c.evidenceId) : null,
  };
}

// 图里动作的动词 —— 命中就说明"这句话在描述动作"，主体默认归图里的人。
const ACTION_VERBS = [
  '抱', '抱着', '抱起', '拿着', '拿', '举', '举着', '站', '站着', '坐', '坐着', '躺', '躺着',
  '跑', '跑着', '跳', '跳着', '吃', '喝', '看', '看着', '笑', '笑着', '哭', '挥手', '指', '指着',
  '骑', '骑在', '背', '背着', '亲', '亲了', '打', '打着', '穿', '戴着', '搂', '扶着', '牵着',
];

/** 第一人称自述标记。只有它出现，才允许把结论归到「图里的人」的自述。 */
const FIRST_PERSON = /(我|俺|本人|自己)/;

/** 明确把动作扣到「发图的人 / 发送者 / 对方」头上的说法。 */
const SENDER_ATTRIBUTION = new RegExp(
  '(发图(的人|的)?|发[送传](者|的人)?|上传者|对方|.{0,6}(?:他|她|ta|TA))'
  + '[^。！？!?]{0,8}(' + ACTION_VERBS.join('|') + ')',
);

/** @typedef {{text:string, source:string, subject:string, attributedToSender:boolean}} RawClaim */

/**
 * 把模型/工具吐出的原始结论**规范化**成带 source 的结论列表。
 *
 * 规则（这是验收第 6 条「图里动作不归因给发图人」的前置）：
 *  R1 没给 source ⇒ 一律记 `model_guess`，**绝不允许**默认成 self_report；
 *  R2 文本里把动作扣到「发图的人 / 发送者 / 对方」⇒ 强制改判 `model_guess`
 *     且主体归 `image`，绝不生成 `attributedToSender:true`；
 *  R3 第一人称（「我抱了一只猫」）无法判定"我"是谁 ⇒ 主体归 `image`（图里的人），
 *     source 保持/降级为 `model_guess`；调用方显式声明"这确实是发图人自述"时才允许 self_report；
 *  R4 空结论列表**不算失败也不算成功**：交给 B3 的 settle 判成 ok:false。
 *
 * @param {RawClaim[]|string[]|string} raw
 * @param {{senderName?:string, senderId?:string, allowSelfReport?:boolean}} [ctx]
 */
export function normalizeVisionResult(raw, ctx = {}) {
  const allowSelfReport = ctx.allowSelfReport === true;
  const senderName = String(ctx.senderName || '').trim();
  let list = raw;
  if (typeof list === 'string') list = [list];
  if (!Array.isArray(list)) return { ok: false, reason: 'bad_input', detail: 'normalizeVisionResult 需要数组或字符串' };
  if (list.length === 0) return { ok: false, reason: 'empty_result', detail: '视觉返回 0 条结论（按 B3 不许冒充"没有内容"）' };

  const claims = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    const text = String(typeof item === 'string' ? item : (item && item.text) ?? '').trim();
    if (!text) continue;

    let source = typeof item === 'object' && item ? item.source : undefined;
    let subject = typeof item === 'object' && item ? item.subject : undefined;

    // R2 —— 把动作扣给发图人 ⇒ 改判"模型推测"，主体归图里的人。
    let senderAttributionStripped = false;
    if (SENDER_ATTRIBUTION.test(text)) {
      senderAttributionStripped = true;
      source = 'model_guess';
      subject = 'image';
    }
    if (senderName && new RegExp(senderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(text)
      && new RegExp('(' + ACTION_VERBS.join('|') + ')').test(text)) {
      senderAttributionStripped = true;
      source = 'model_guess';
      subject = 'image';
    }

    // R1 / R3 —— source 缺失一律 model_guess；自述要显式许可。
    const sawFirstPerson = FIRST_PERSON.test(text);
    if (!isValidSource(source)) source = 'model_guess';
    if (source === 'self_report' && !allowSelfReport) source = 'model_guess';
    if (source === 'self_report' && !sawFirstPerson) source = 'model_guess';

    // R3 —— 第一人称但没许可自述 ⇒ 主体归图里的人，绝不归发图人。
    if (subject !== 'sender' && (sawFirstPerson || senderAttributionStripped)) subject = 'image';
    if (subject === 'sender' && !allowSelfReport) subject = 'image';
    if (!isValidSource(source)) source = 'model_guess';

    claims.push({
      text,
      source,
      sourceLabel: VISION_SOURCE[source],
      subject: subject || 'unknown',
      subjectLabel: VISION_SUBJECT[subject || 'unknown'],
      attributedToSender: (subject || 'unknown') === 'sender',
      senderAttributionStripped,
      confidence: typeof item === 'object' && item && typeof item.confidence === 'number' ? item.confidence : null,
    });
  }
  if (claims.length === 0) return { ok: false, reason: 'empty_result', detail: '视觉结论里没有一条有正文' };
  return { ok: true, claims, count: claims.length };
}

/** 断言：任何一条结论都不得把图里的动作归给发图人（除非调用方显式许可自述）。 */
export function assertNoSenderAttribution(claims) {
  const bad = (Array.isArray(claims) ? claims : []).filter((c) => c && c.attributedToSender);
  if (bad.length) {
    throw new Error(`[media/B2] 有 ${bad.length} 条结论把图里的动作归给了发图人：${bad.map((c) => c.text).join(' | ')}`);
  }
  return true;
}

// ══════════════════════════════════════════════════════════════════════
// B3 · 失败要说失败
// ══════════════════════════════════════════════════════════════════════

/** 失败原因码（稳定，便于上游按码处理，不必去猜文案）。 */
export const MEDIA_FAILURE = Object.freeze({
  download_failed: '下载失败',
  decode_failed: '解码失败',
  vision_call_failed: '视觉调用失败',
  empty_result: '空结果（不等于成功，也不等于"没有图"）',
  bad_input: '入参不合法',
  unsupported: '不支持该输入',
  throwed: '调用抛异常',
  config_missing: '依赖的配置/邻居未就绪',
  third_party_upload_disabled: '第三方上传开关关着，本次没做（未向外部发出任何请求）',
});

export const MEDIA_FAILURE_CODES = Object.freeze(Object.keys(MEDIA_FAILURE));

/** 造失败结果。**永远带 reason**（不带 detail 也要有）。 */
export function fail(reason, detail = '') {
  if (!isFailureReason(reason)) {
    throw new Error(`[media/B3] 非法 reason：${JSON.stringify(reason)}（合法：${MEDIA_FAILURE_CODES.join('|')}）`);
  }
  return { ok: false, reason, reasonLabel: MEDIA_FAILURE[reason], ...(detail ? { detail: String(detail) } : {}) };
}

function isFailureReason(r) {
  return typeof r === 'string' && Object.prototype.hasOwnProperty.call(MEDIA_FAILURE, r);
}

export function ok(value, extra = {}) {
  return { ok: true, reason: null, value, ...extra };
}

/**
 * 把「可能失败 / 可能失败成空」的调用收敛成 {ok, reason} 形状。
 * 空数组 / 空字符串 / null / undefined 一律判失败 —— 这就是 B3 的核心。
 * @param {any} input promise / 函数 / 已知的值
 * @param {{reason?:string, detail?:string, allowEmpty?:boolean}} [opts]
 */
export async function settle(input, opts = {}) {
  const reason = isFailureReason(opts.reason) ? opts.reason : 'throwed';
  const detail = opts.detail || '';
  let value;
  try {
    value = typeof input === 'function' ? await input() : await input;
  } catch (err) {
    return fail('throwed', `${detail ? detail + ' :: ' : ''}${String(err && err.message ? err.message : err).slice(0, 200)}`);
  }
  if (!opts.allowEmpty && isEmptyish(value)) {
    return fail(isFailureReason(opts.reason) ? opts.reason : 'empty_result', `${detail ? detail + ' :: ' : ''}返回空值`);
  }
  return ok(value);
}

export function isEmptyish(v) {
  if (v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'string') return v.trim() === '';
  if (Buffer.isBuffer(v)) return v.length === 0;
  return false;
}

/**
 * 把搬运件的旧失败形状（image-lib.js 用的是 `{ ok:false, error }`）统一到新合同 `{ ok:false, reason }`。
 * **不改语义，只改字段名**；旧文案塞进 detail。
 */
export function fromLegacyResult(raw, { reason = 'download_failed' } = {}) {
  if (raw && raw.ok === false) {
    const detail = raw.error ?? raw.reason ?? raw.detail ?? '';
    return fail(isFailureReason(reason) ? reason : 'download_failed', detail);
  }
  return raw;
}

/**
 * B3 的读侧补丁：`image-lib.js` 的 `readIndex()` 是 `catch { return [] }` ——
 * 读盘失败（EACCES / 半截 JSON）与"库里确实一张图都没有"返回同一个 `[]`。
 * 这一层把两者分开：调用方拿到的失败形状里**不会**出现空数组。
 *
 * 裁定②：源码**不改**（改了就破坏保真表），债登记在 KNOWN_DEBTS；
 * 但失败态必须**可判** —— 所以这里带 `reason` + `reasonLabel`，并原样透传 `raw`（不丢原始信息）。
 *
 * @param {any[]} list 读到的列表（可能是失败时伪造出来的 []）
 * @param {{error?:string, raw?:any}} [meta] error 非空 = 读盘失败；raw = 原始错误对象，原样带出
 */
export function libResult(list, { error = '', raw = null } = {}) {
  if (error) {
    const r = fail('download_failed', error);
    return { ...r, kind: 'read_failed', libEmpty: isEmptyish(list), ...(raw !== null && raw !== undefined ? { raw } : {}) };
  }
  if (isEmptyish(list)) {
    const r = fail('empty_result', '图库读得到但确实是空的');
    return { ...r, kind: 'read_ok_but_empty', libEmpty: true };
  }
  return { ...ok(list), kind: 'read_ok', libEmpty: false };
}

/** 失败态可判（裁定②）：媒体层任何返回都能用这个判，判完还能拿到原始 reason。 */
export function isMediaFailure(x) {
  if (!x || typeof x !== 'object' || x.ok !== false) return false;
  return typeof x.reason === 'string' && x.reason.length > 0;
}

/** 取原始失败原因（可判 + 可取），便于上层按码处理而不必去猜文案。 */
export function mediaFailureReason(x) {
  return isMediaFailure(x) ? x.reason : null;
}

// ══════════════════════════════════════════════════════════════════════
// B4 · 第三方上传默认关（裁定①，2026-10-04 指挥位；L3 对外发送）
// ══════════════════════════════════════════════════════════════════════

/** ★ 本文件是 media 私有的。别的模块 import 它就是越界（裁定③）。 */
export const MEDIA_MODULE_LOCAL = Object.freeze({
  module: 'modules/media',
  importableBy: ['modules/media'],
  inFrozenSurface: false,          // 不在 README §3.5 冻结面里
  note: '边界守卫不是合同；需要"source 字段"这类合同语义请去 contracts/，需要边界请在 media 内部用本文件。',
});

/** 反向图搜的第三方上传开关（点路径）。默认 **false**。 */
export const REVERSE_IMAGE_UPLOAD_POLICY = 'media.reverseImage.allowThirdPartyUpload';

/** 默认关。改产品默认行为要用户点头 —— 指挥位已上报，本轮按"默认关"实现；翻开关只改这一个常量/配置值，结构不动。 */
export const DEFAULT_THIRD_PARTY_UPLOAD = false;

/**
 * 解析上传策略。**只认 `=== true`**：undefined / null / 0 / 'false' / 'true' / {} 一律按**关**处理。
 * 宁可少传，不猜用户意图（旧世界是静默开的，那正是要改的东西）。
 * @param {object|((key:string)=>any)|null} cfg 配置对象 / 取值器 / 什么都不给
 */
export function resolveUploadPolicy(cfg) {
  if (cfg === null || cfg === undefined) return DEFAULT_THIRD_PARTY_UPLOAD;
  const read = typeof cfg === 'function' ? cfg : (key) => cfg[key];
  let v;
  try { v = read(REVERSE_IMAGE_UPLOAD_POLICY); } catch { return DEFAULT_THIRD_PARTY_UPLOAD; }
  return v === true;
}

/**
 * 受控入口：以图搜图。**第三方上传默认关**；关着就**明说没做**，不许静默退化成"没找到图"。
 *
 * 为什么不改reverse-image.js 的源码：改了就破坏"逐字节搬 + 只改 import"的保真表（9/9 行数相等、
 * 11 处差异全在 import 行）。所以闸门加在这一层，搬运件保持原样（裁定①要求"开着时行为与旧实现一致"，
 * 由本函数在放行时原样委托给 deps.search 达成）。
 *
 * @param {{dataUrl?:string, url?:string}} input
 * @param {{cfg?:any, deps?:{search:Function}, label?:string}} [opts]
 *   cfg   —— 配置对象或取值器（不传 = 默认关）
 *   deps.search —— **必须注入** reverseImageSearch（边界层零import，不许自己去import 搬运件）
 */
export async function reverseImageSearchGuarded(input = {}, opts = {}) {
  const allowed = resolveUploadPolicy(opts.cfg);
  const label = String(opts.label || '以图搜图');
  if (!allowed) {
    const r = fail('third_party_upload_disabled',
      `${label}：第三方上传开关 ${REVERSE_IMAGE_UPLOAD_POLICY} 默认关，已跳过（未向 sm.ms / catbox / 百度识图 / IQDB 发出任何请求）`);
    // 让上层说明里能体现"没做反向图搜"，而不是让用户以为"搜了但没结果"
    return { ...r, didReverseImageSearch: false, policy: REVERSE_IMAGE_UPLOAD_POLICY, policyEnabled: false };
  }
  const search = opts.deps && opts.deps.search;
  if (typeof search !== 'function') {
    return { ...fail('bad_input', 'reverseImageSearchGuarded 需要注入 deps.search（边界层零 import）'), didReverseImageSearch: false, policyEnabled: true };
  }
  // 放行 ⇒ 行为与旧实现**逐字一致**（保真）：直接委托，不包一层、不改返回值
  return { ok: true, didReverseImageSearch: true, policyEnabled: true, value: await search(input) };
}

// ══════════════════════════════════════════════════════════════════════
// 受控出站入口：scanModelsVisionGuarded（默认关，指挥位裁定）
// ══════════════════════════════════════════════════════════════════════

const VISION_SCAN_POLICY = 'media.visionScan.allowOutbound';

/**
 * 默认开（I-2，2026-10-06 指挥位票面）：老树**没有这道闸**，POST /api/vision/scan 本来就要发探测图
 * （src/app.js:2379）⇒ 默认值恢复既有行为；默认键在 core/config-store/defaults.js `media.visionScan.allowOutbound`。
 * 闸本身保留可关：显式 false / 解析不到 ⇒ 关，且关时**显式失败**（third_party_upload_disabled），绝不静默空结果。
 */
export const DEFAULT_VISION_SCAN_OUTBOUND = true;

/**
 * 解析视觉扫描出站策略。**只认 `=== true`**：undefined/false/缺失 全部关；
 * 完全读不到配置（cfg 缺失/取值抛错）⇒ 也关（拿不到真相时宁可不开 —— 默认开走 defaults，不靠这里兜）。
 * ★ config-store 的 effective() 返回**包装对象** `{value, source, found}`（refactor/core/config-store/index.js:242），
 *   直判 `=== true` 会恒假 ⇒ 这里剥一层；同时兼容裸值取法（get / 测试替身）。
 */
export function resolveVisionScanPolicy(cfg) {
  if (cfg === null || cfg === undefined) return false;
  let raw;
  try {
    raw = cfg?.effective?.(VISION_SCAN_POLICY, { kind: 'global' });
  } catch {
    return false;
  }
  if (raw && typeof raw === 'object' && Object.hasOwn(raw, 'value')) raw = raw.found === false ? undefined : raw.value;
  if (raw === undefined) {
    try {
      raw = cfg?.get?.(VISION_SCAN_POLICY);
      if (raw && typeof raw === 'object' && Object.hasOwn(raw, 'value')) raw = raw.found === false ? undefined : raw.value;
    } catch { raw = undefined; }
  }
  return raw === true;
}

/**
 * 受控的模型视觉探测入口（指挥位裁定：默认关，出站前闸）。
 * 与 reverseImageSearchGuarded 同一形状：开关关 ⇒ **显式失败**（"not done"），绝不静默空结果。
 *
 * @param {object} input - { providers, emit, limit, timeoutMs, onlyProviderIds }
 * @param {object} opts - { cfg, label, deps: { scan } }（deps.scan 可缺省 ⇒ 默认用本模块 vision-scan.js 的实现；
 *   用**运行期懒 import**，保持本文件"零静态 import"的既有约束 —— 说明符 './vision-scan.js' 在 media 自检 F17 的同目录白名单内）
 */
export async function scanModelsVisionGuarded(input = {}, opts = {}) {
  const allowed = resolveVisionScanPolicy(opts.cfg);
  const label = String(opts.label || '模型视觉探测');
  if (!allowed) {
    return fail('third_party_upload_disabled',
      `${label}：出站开关 ${VISION_SCAN_POLICY} 关，已跳过（未向任何模型 provider 发出探测图）`);
  }
  let scan = opts?.deps?.scan;
  if (typeof scan !== 'function') {
    try {
      scan = (await import('./vision-scan.js')).scanModelsVision;
    } catch (error) {
      return fail('bad_input', `${label}：默认探测实现加载失败（${error?.message ?? error}）`);
    }
  }
  if (typeof scan !== 'function') {
    return fail('bad_input', 'scanModelsVisionGuarded 需要注入 deps.scan（边界层零 import）');
  }
  try {
    const result = await scan(input);
    return ok(result, { policy: VISION_SCAN_POLICY, policyEnabled: true });
  } catch (error) {
    return fail('provider_error', `${label}：${error?.message ?? error}`);
  }
}

// ══════════════════════════════════════════════════════════════════════
// 已知债登记（裁定②：readIndex() 吞失败 —— 不改源码，在边界层区分 + 登记）
// ══════════════════════════════════════════════════════════════════════

/**
 * 搬运保真与"不许吞失败"有冲突的地方，逐条登记。
 * 每条都必须写清：① 在哪② 旧行为是什么 ③ 边界层怎么补 ④ 谁在什么时候决定要不要动源码。
 */
export const KNOWN_DEBTS = Object.freeze([
  Object.freeze({
    id: 'image-lib.readIndex swallows failure',
    where: 'image-lib.js:24-26 readIndex()',
    legacy: 'catch { return [] } —— 读盘失败（EACCES / 半截 JSON）与"库里确实一张图都没有"返回同一个 []',
    mitigation: 'boundaries.libResult(list, {error, raw}) 把两者分开：读盘失败 ⇒ download_failed；真的空 ⇒ empty_result',
    decidedBy: '第 3 批决定是否收紧源码（本轮刻意不改，保真优先）',
  }),
  Object.freeze({
    id: 'reverse-image.search throws instead of returning ok:false',
    where: 'reverse-image.js:128 reverseImageSearch()',
    legacy: '失败用 throw 表示；且各 provider 失败只塞进 providers[].error，顶层 matches 仍是 []',
    mitigation: 'boundaries.settle() 把 throw 转成 {ok:false, reason}；调用方仍须自己读 providers[].error，不能只看 matches.length',
    decidedBy: '第 3 批',
  }),
  Object.freeze({
    id: 'reverse-image sm.ms failure silently swallowed',
    where: 'reverse-image.js:39 catch { /* 换 catbox */ }',
    legacy: 'sm.ms 上传失败被静默吞掉换 catbox ⇒ 第一个错误在最终返回里彻底看不到',
    mitigation: '无（仅登记）；上传本身已被 REVERSE_IMAGE_UPLOAD_POLICY 默认关挡住',
    decidedBy: '第 3 批',
  }),
  Object.freeze({
    id: 'image-lib legacy error field name',
    where: 'image-lib.js 全篇（{ok:false, error}）',
    legacy: '旧合同用 error 字段，新合同用 reason',
    mitigation: 'boundaries.fromLegacyResult() 只做字段名归一，语义不变',
    decidedBy: '第 3 批',
  }),
  Object.freeze({
    id: 'vision-image swallows extension-import failure',
    where: 'vision-image.js:56 extensionRejectsMime() 的 catch { /* 扩展判断失败时不阻断图片主流 */ }',
    legacy: 'await import("../extensions/index.js") 的解析/链接失败会被这个 catch 静默吞掉 ⇒ 说明符写错时**运行期也不报错**，只是永远返回 false（等于"扩展一律不禁用任何 MIME"）',
    mitigation: 'selftest.mjs F18 按文件所在目录**直接 import 那条说明符本身**来验（不信"跑一遍没抛"）；F17 静态判据 R1/R2 也能抓到',
    decidedBy: '第 3 批（建议：要么把该 catch 收窄成只吞 provider 异常，要么把 import 提到模块顶层）',
  }),
  Object.freeze({
    id: 'vision-scan egress probes are unreachable dead code',
    where: 'vision-scan.js:107 detectModelVision / :163 scanModelsVision',
    legacy: '收口后这两个出网探测函数**不在 index.js 公开出口上** ⇒ 有定义、零可达调用点 = 死代码',
    mitigation: '无（刻意不给受控入口）',
    decidedBy: '第 3 批：要么给受控入口（走 M4/装配层一次性调用），要么删',
  }),
  Object.freeze({
    id: 'StickerManager.annotateMissing 把表情图 dataURL 发给主视觉模型（**刻意不加闸**）',
    where: 'sticker-manager.js:295（await import(\'../llm/index.js\')）+ :344（chatCompletion({ … dataUrls … })）',
    legacy: '把**表情图 dataURL** 发给主视觉模型。**性质与 reverseImageSearch 不同**：发给的是用户自己配置的模型，'
      + '而主链本来就要把用户发的图发给模型（视觉能力就是产品核心功能）⇒ 不是异常外发。'
      + '触发方式是管理员显式点"批量补备注"，不是运行期自动行为。',
    mitigation: '无闸（刻意不加）；已在 README.md §2.2 与 KNOWN_EGRESS 第 2 条写明"这是本模块已知的对外发送面"',
    decidedBy: '**保持现状，不加新闸**（2026-10-04 指挥位裁定①）。'
      + '"不给模型看表情"是**产品决策** ⇒ 已列进给用户拍板的清单，**不是本模块现在要改的东西**。'
      + '注意：StickerManager 类仍在公开出口上（收口整个类会让 media 失去唯一主 API）⇒ 只能按方法粒度审。',
  }),
]);

/**
 * ★ 已知外发面（产品行为说明，不是 bug）。README.md §2 有同一份说明。
 *   公开出口已按 §3 收口：只有受控入口在出口上；这里登记"谁在发、发什么、闸门在哪"。
 */
export const KNOWN_EGRESS = Object.freeze([
  Object.freeze({
    id: 'reverseImageSearch → 第三方图床',
    where: 'reverse-image.js:128（内部 uploadForReverse：sm.ms → 失败退 catbox.moe；再把 URL 给百度识图 / IQDB）',
    what: '把**用户图片字节** POST 给匿名第三方图床',
    nature: 'L3 对外发送；与功能无关的第三方获取',
    gate: "boundaries.reverseImageSearchGuarded + 开关 media.reverseImage.allowThirdPartyUpload（默认 false，只认 === true）",
    onPublicExit: false,
    onPublicExitHow: "index.js 用 export {} from './reverse-image.js' —— 该文件唯一导出就是出网那个，没有干净出口，故整个不导出",
    ruledBy: '2026-10-04 指挥位裁定①（默认值变更待用户拍板）',
  }),
  Object.freeze({
    id: 'StickerManager.annotateMissing → 主视觉模型',
    where: 'sticker-manager.js:295（await import(\'../llm/index.js\')）+ :344（chatCompletion({ … dataUrls … })）',
    what: '把**表情图 dataURL** 发给主视觉模型',
    nature: '发给用户自己配置的模型；主链本来就要把用户发的图发给模型（视觉能力是产品核心功能）⇒ **不是异常外发**',
    gate: '**无闸，且刻意不加**（管理员显式点"批量补备注"才触发）',
    onPublicExit: true,
    onPublicExitHow: 'StickerManager 类仍在出口上（收口整个类会让 media 失去唯一主 API）⇒ 只能按方法粒度审',
    ruledBy: '2026-10-04 指挥位裁定①：**保持现状，不加新闸**；"不给模型看表情"是产品决策，待用户拍板',
  }),
  Object.freeze({
    id: 'detectModelVision / scanModelsVision → 模型 provider',
    where: 'vision-scan.js:107 / :163（内部 fetch(\'<baseUrl>/chat/completions\')）',
    what: '把**探测图**发给模型 provider',
    nature: '一次性"这个模型有没有视觉能力"探测 ⇒ 属 M4 / 装配期，不该由 media 运行期反复探',
    gate: '**不在公开出口上**（index.js 对 vision-scan.js 只导出 3 个纯读配置的）',
    onPublicExit: false,
    onPublicExitHow: 'index.js 对 vision-scan.js 改显式白名单：visionResults / modelVisionVerdict / modelImageVerdict',
    ruledBy: '2026-10-04 指挥位裁定②：**不给受控入口**，登记为债（见 KNOWN_DEBTS 第 6 条：当前是死代码）',
  }),
]);

export const MEDIA_BOUNDARIES = Object.freeze(['B1 不决定发不发', 'B2 不猜图中人', 'B3 失败要说失败', 'B4 第三方上传默认关']);