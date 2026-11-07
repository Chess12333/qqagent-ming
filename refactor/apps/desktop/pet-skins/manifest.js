// 桌宠皮肤包 manifest 规范化与校验（v1 契约）。
//
// 设计原则与 src/skills/manifest.js 一致：**软校验** —— 单个皮肤包写坏
// 不应该拖垮桌宠。normalizeSkinManifest 不做"必须合法否则抛错"，而是
// 逐项筛掉非法内容并收集 problems，由调用方决定是警告、拒绝加载还是
// 回退到内置 default 皮肤。
//
// 格式规范（人类可读版）：pet-skins/SKIN_FORMAT.txt
//
// 硬边界（安全红线，违者该包直接判废）：
//   - 包内只允许 JSON（skin.json）+ 图片（.svg/.png/.webp），包内不运行
//     任何 JS / CSS / HTML；动画只能是声明式的数值插值。
//   - 所有资源路径必须是包内相对路径：拒绝绝对路径、`..`、协议 URL、
//     控制字符、冒号；文件系统层（符号链接越界）由 registry.js 兜底。

export const SKIN_FORMAT = 'qq-agent.pet-skin';
export const SKIN_FORMAT_VERSION = 1;

/** v1 支持的渲染后端。layers 必须实现；sprite-sheet 是可选兼容后端。 */
export const RENDERERS = new Set(['layers', 'sprite-sheet']);

/**
 * 动画白名单：只允许对这 5 个数值属性做插值。
 * 语义（渲染端编译为 rAF 变换，不生成任何 CSS/脚本）：
 *   x / y      —— 相对图层初始位置的平移（逻辑像素）
 *   rotate     —— 顺时针角度
 *   scale      —— 等比缩放倍数
 *   opacity    —— 0..1
 */
export const ANIMATABLE_PROPERTIES = new Set(['x', 'y', 'rotate', 'scale', 'opacity']);

export const EASINGS = new Set(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'steps']);

/** 图层静态图扩展名；sprite-sheet 只允许位图（SVG 无帧概念）。 */
export const LAYER_IMAGE_EXTS = new Set(['.svg', '.png', '.webp']);
export const SHEET_IMAGE_EXTS = new Set(['.png', '.webp']);

/** 内置保留 id：default 专指"内置旧图 fallback"，第三方包不得占用。 */
export const RESERVED_SKIN_IDS = new Set(['default']);

/** 各字段/集合的硬上限。见 SKIN_FORMAT.txt"限制"一节。 */
export const LIMITS = {
  id: 64,
  name: 64,
  author: 64,
  description: 200,
  states: 16,
  layersPerState: 32,
  animationsPerState: 32,
  tracksPerAnimation: 5,
  keyframesPerTrack: 64,
  canvasSize: 512,
  frames: 1024,
  fpsMin: 1,
  fpsMax: 60,
  durationMsMin: 100,
  durationMsMax: 60000,
  totalResources: 128,        // 建议值（文档口径）
  totalResourcesHard: 512,    // 硬上限（extractResourcePaths 实际截断点；= 32 图层 × 16 状态）
  resourceMaxBytes: 8 * 1024 * 1024,          // 单资源 ≤8 MiB（registry 扫描与 resolve 双重检查）
  packageResourcesMaxBytes: 64 * 1024 * 1024,
  sheetMotionPeriodMin: 300,
  sheetMotionPeriodMax: 10000,
  sheetMotionOffsetMax: 32,
  sheetMotionRotateMax: 5,
  sheetMotionScaleMax: 0.05, // Whole-sprite breathing amplitude.
  translateMax: 2048,
  rotateMax: 1080,
  scaleMin: 0.01,
  scaleMax: 8,
};

/** 现有语义状态：idle / working 必须提供；其余键视为自定义扩展状态。 */
export const REQUIRED_STATES = new Set(['idle', 'working']);

/** id 安全 slug：小写字母/数字开头，仅小写字母数字与 - _，≤64。 */
export function isSafeSkinSlug(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

/**
 * 校验"包内相对路径"。合法即返回规范化后的 posix 风格路径。
 * 拒绝：绝对路径（/ 开头、盘符、UNC）、`..`、`.`、空段、协议 URL、
 * 冒号、控制字符、反斜杠之外的 trick 一律通过规范化排除。
 * @returns {{ ok: boolean, path?: string, problem?: string }}
 */
export function validatePackageRelativePath(raw) {
  const input = String(raw ?? '');
  if (!input || !input.trim()) return { ok: false, problem: '资源路径为空' };
  if (/[\u0000-\u001f\u007f]/.test(input)) return { ok: false, problem: '资源路径含控制字符' };
  if (input.includes(':')) return { ok: false, problem: '资源路径含冒号（协议/盘符）' };
  // 协议 URL（http: 等已在冒号规则中被拒，这里兜底 file:// 之类的变体写法）
  if (/^[/\\]{2}/.test(input)) return { ok: false, problem: '资源路径是 UNC/协议前缀' };
  const posix = input.replace(/\\/g, '/');
  if (posix.startsWith('/')) return { ok: false, problem: '资源路径是绝对路径' };
  if (/^[A-Za-z]:/.test(input)) return { ok: false, problem: '资源路径是盘符绝对路径' };
  const segments = posix.split('/');
  for (const seg of segments) {
    if (!seg) return { ok: false, problem: '资源路径含空段' };
    if (seg === '.' || seg === '..') return { ok: false, problem: '资源路径含 . / .. 段' };
  }
  return { ok: true, path: posix };
}

function asInt(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function cleanString(value, fallback = '') {
  const s = String(value ?? '').trim();
  return s || fallback;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// states 归一化（按 renderer 分两套结构）
// ---------------------------------------------------------------------------

function normalizeLayersState(state, problems, stateKey) {
  const ctx = `states.${stateKey}`;
  const known = new Set(['canvas', 'layers', 'animations']);
  for (const key of Object.keys(state)) {
    if (!known.has(key)) problems.push(`${ctx} 存在未知字段（已忽略）：${key}`);
  }
  const out = { layers: [], animations: [] };

  const canvas = plainObject(state.canvas) ? state.canvas : null;
  if (canvas) {
    const w = asInt(canvas.width);
    const h = asInt(canvas.height);
    if (w >= 1 && w <= LIMITS.canvasSize && h >= 1 && h <= LIMITS.canvasSize) {
      out.canvas = { width: w, height: h };
    } else {
      problems.push(`${ctx}.canvas 尺寸非法（需 1..${LIMITS.canvasSize}）`);
    }
  }

  // ---- layers ----
  const rawLayers = Array.isArray(state.layers) ? state.layers : [];
  if (!rawLayers.length) {
    problems.push(`${ctx}.layers 不能为空`);
  }
  const layerIds = new Set();
  for (const raw of rawLayers.slice(0, LIMITS.layersPerState)) {
    if (!plainObject(raw)) { problems.push(`${ctx}.layers 存在非对象项，已跳过`); continue; }
    const srcCheck = validatePackageRelativePath(raw.src);
    const ext = srcCheck.ok ? String(srcCheck.path).slice(String(srcCheck.path).lastIndexOf('.')).toLowerCase() : '';
    if (!srcCheck.ok) { problems.push(`${ctx}.layers 图层资源路径非法（${raw.src ?? ''}）：${srcCheck.problem}`); continue; }
    if (!LAYER_IMAGE_EXTS.has(ext)) { problems.push(`${ctx}.layers 图层 "${srcCheck.path}" 扩展名不支持（仅 .svg/.png/.webp）`); continue; }
    const layerId = cleanString(raw.id);
    if (!isSafeSkinSlug(layerId)) { problems.push(`${ctx}.layers 图层 id 非法（${layerId || '空'}），已跳过`); continue; }
    if (layerIds.has(layerId)) { problems.push(`${ctx}.layers 图层 id 重复（${layerId}），已跳过`); continue; }
    layerIds.add(layerId);
    const x = Number.isFinite(Number(raw.x)) ? Number(raw.x) : 0;
    const y = Number.isFinite(Number(raw.y)) ? Number(raw.y) : 0;
    const z = Number.isFinite(Number(raw.z)) ? asInt(raw.z) || 0 : 0;
    const opacity = clamp(Number.isFinite(Number(raw.opacity)) ? Number(raw.opacity) : 1, 0, 1);
    out.layers.push({ id: layerId, src: srcCheck.path, x, y, z, opacity });
  }
  if (rawLayers.length > LIMITS.layersPerState) {
    problems.push(`${ctx}.layers 超过上限 ${LIMITS.layersPerState}，多余项已丢弃`);
  }

  // ---- animations（声明式数值插值，白名单属性） ----
  const rawAnims = Array.isArray(state.animations) ? state.animations : [];
  for (const raw of rawAnims.slice(0, LIMITS.animationsPerState)) {
    if (!plainObject(raw)) { problems.push(`${ctx}.animations 存在非对象项，已跳过`); continue; }
    const target = cleanString(raw.target);
    if (!layerIds.has(target)) { problems.push(`${ctx}.animations target "${target}" 不存在，动画已跳过`); continue; }
    const duration = asInt(raw.durationMs);
    if (!(duration >= LIMITS.durationMsMin && duration <= LIMITS.durationMsMax)) {
      problems.push(`${ctx}.animations（target=${target}）durationMs 非法（需 ${LIMITS.durationMsMin}..${LIMITS.durationMsMax}），已跳过`);
      continue;
    }
    const easing = EASINGS.has(raw.easing) ? raw.easing : 'linear';
    const anim = { target, durationMs: duration, loop: raw.loop === undefined ? true : Boolean(raw.loop), easing, tracks: [] };

    const rawTracks = Array.isArray(raw.tracks) ? raw.tracks : [];
    if (!rawTracks.length) { problems.push(`${ctx}.animations（target=${target}）缺少 tracks，已跳过`); continue; }
    let trackOk = true;
    for (const tr of rawTracks.slice(0, LIMITS.tracksPerAnimation)) {
      if (!plainObject(tr)) { problems.push(`${ctx}.animations（target=${target}）track 非对象，已跳过`); trackOk = false; continue; }
      const property = cleanString(tr.property);
      if (!ANIMATABLE_PROPERTIES.has(property)) {
        problems.push(`${ctx}.animations（target=${target}）属性 "${property}" 不在白名单（x/y/rotate/scale/opacity），track 已跳过`);
        trackOk = false;
        continue;
      }
      const rawKfs = Array.isArray(tr.keyframes) ? tr.keyframes : [];
      if (!rawKfs.length) { problems.push(`${ctx}.animations（target=${target}, ${property}）缺少 keyframes，track 已跳过`); trackOk = false; continue; }
      const kfs = [];
      for (const kf of rawKfs.slice(0, LIMITS.keyframesPerTrack)) {
        if (!plainObject(kf)) continue;
        const t = asInt(kf.t);
        const value = Number(kf.value);
        if (!(t >= 0 && t <= duration) || !Number.isFinite(value)) {
          problems.push(`${ctx}.animations（target=${target}, ${property}）存在非法关键帧，已跳过`);
          continue;
        }
        let ok = true;
        if (property === 'opacity') ok = value >= 0 && value <= 1;
        else if (property === 'scale') ok = value >= LIMITS.scaleMin && value <= LIMITS.scaleMax;
        else if (property === 'rotate') ok = Math.abs(value) <= LIMITS.rotateMax;
        else ok = Math.abs(value) <= LIMITS.translateMax;
        if (!ok) { problems.push(`${ctx}.animations（target=${target}, ${property}）关键帧值越界（${value}），已跳过`); continue; }
        kfs.push({ t, value });
      }
      if (!kfs.length) { trackOk = false; continue; }
      kfs.sort((a, b) => a.t - b.t);
      anim.tracks.push({ property, keyframes: kfs });
      if (rawKfs.length > LIMITS.keyframesPerTrack) {
        problems.push(`${ctx}.animations（target=${target}, ${property}）关键帧超过 ${LIMITS.keyframesPerTrack}，多余项已丢弃`);
      }
    }
    if (rawTracks.length > LIMITS.tracksPerAnimation) {
      problems.push(`${ctx}.animations（target=${target}）tracks 超过 ${LIMITS.tracksPerAnimation}，多余项已丢弃`);
    }
    if (trackOk && anim.tracks.length) out.animations.push(anim);
  }
  if (rawAnims.length > LIMITS.animationsPerState) {
    problems.push(`${ctx}.animations 超过上限 ${LIMITS.animationsPerState}，多余项已丢弃`);
  }

  return out;
}

function normalizeSheetMotion(raw, problems, ctx) {
  if (raw === undefined || raw === null) return null;
  if (!plainObject(raw)) {
    problems.push(ctx + '.motion 不是对象，连续动作已忽略');
    return null;
  }

  const rawPeriod = asInt(raw.periodMs);
  const periodMs = rawPeriod >= LIMITS.sheetMotionPeriodMin && rawPeriod <= LIMITS.sheetMotionPeriodMax
    ? rawPeriod
    : 1800;
  if (periodMs !== rawPeriod) {
    problems.push(ctx + '.motion.periodMs 非法（需 ' + LIMITS.sheetMotionPeriodMin + '..' + LIMITS.sheetMotionPeriodMax + '），已回退到 1800');
  }

  const motion = { periodMs, x: 0, y: 0, rotate: 0, scale: 0 };
  const rules = {
    x: [-LIMITS.sheetMotionOffsetMax, LIMITS.sheetMotionOffsetMax],
    y: [-LIMITS.sheetMotionOffsetMax, LIMITS.sheetMotionOffsetMax],
    rotate: [-LIMITS.sheetMotionRotateMax, LIMITS.sheetMotionRotateMax],
    scale: [0, LIMITS.sheetMotionScaleMax],
  };
  for (const key of Object.keys(raw)) {
    if (key === 'periodMs' || Object.hasOwn(rules, key)) continue;
    problems.push(ctx + '.motion 未知字段 "' + key + '"，已忽略');
  }
  for (const key of Object.keys(rules)) {
    if (raw[key] === undefined) continue;
    const value = Number(raw[key]);
    if (!Number.isFinite(value)) {
      problems.push(ctx + '.motion.' + key + ' 不是有限数值，已忽略');
      continue;
    }
    const bounded = clamp(value, rules[key][0], rules[key][1]);
    if (bounded !== value) problems.push(ctx + '.motion.' + key + ' 超限，已限幅');
    motion[key] = bounded;
  }
  if (motion.x === 0 && motion.y === 0 && motion.rotate === 0 && motion.scale === 0) return null;
  return motion;
}

function normalizeSheetState(state, problems, stateKey) {
  const ctx = `states.${stateKey}`;
  const known = new Set(['sheet', 'frameWidth', 'frameHeight', 'frames', 'fps', 'row', 'loop', 'motion']);
  for (const key of Object.keys(state)) {
    if (!known.has(key)) problems.push(`${ctx} 存在未知字段（已忽略）：${key}`);
  }
  const out = {};
  const srcCheck = validatePackageRelativePath(state.sheet);
  const ext = srcCheck.ok ? String(srcCheck.path).slice(String(srcCheck.path).lastIndexOf('.')).toLowerCase() : '';
  if (!srcCheck.ok) { problems.push(`${ctx}.sheet 资源路径非法：${srcCheck.problem}`); return null; }
  if (!SHEET_IMAGE_EXTS.has(ext)) { problems.push(`${ctx}.sheet "${srcCheck.path}" 扩展名不支持（仅 .png/.webp）`); return null; }
  const fw = asInt(state.frameWidth);
  const fh = asInt(state.frameHeight);
  const frames = asInt(state.frames);
  if (!(fw >= 1 && fw <= LIMITS.canvasSize && fh >= 1 && fh <= LIMITS.canvasSize)) {
    problems.push(`${ctx}.frameWidth/frameHeight 非法（需 1..${LIMITS.canvasSize}）`); return null;
  }
  if (!(frames >= 1 && frames <= LIMITS.frames)) {
    problems.push(`${ctx}.frames 非法（需 1..${LIMITS.frames}）`); return null;
  }
  const fps = asInt(state.fps);
  out.sheet = srcCheck.path;
  out.frameWidth = fw;
  out.frameHeight = fh;
  out.frames = frames;
  out.fps = fps >= LIMITS.fpsMin && fps <= LIMITS.fpsMax ? fps : 8;
  out.row = Math.max(0, asInt(state.row) || 0);
  out.loop = state.loop === undefined ? true : Boolean(state.loop);
  const motion = normalizeSheetMotion(state.motion, problems, ctx);
  if (motion) out.motion = motion;
  return out;
}

// ---------------------------------------------------------------------------
// 顶层 normalize
// ---------------------------------------------------------------------------

/**
 * 规范化 skin.json：补默认值、筛掉非法项、收集 problems。
 * 返回 { manifest, problems }；manifest 为 null 表示该包不可恢复（判废）。
 */
export function normalizeSkinManifest(raw, { fallbackId = '' } = {}) {
  const problems = [];
  if (!plainObject(raw)) {
    return { manifest: null, problems: ['skin.json 不是 JSON 对象'] };
  }

  // 硬边界：format / version 不认识就没法解释，直接判废
  if (raw.format !== SKIN_FORMAT) {
    return { manifest: null, problems: [`format 必须为 "${SKIN_FORMAT}"（当前：${raw.format ?? '缺失'}）`] };
  }
  const version = asInt(raw.version);
  if (version !== SKIN_FORMAT_VERSION) {
    return { manifest: null, problems: [`version 只支持 ${SKIN_FORMAT_VERSION}（当前：${raw.version ?? '缺失'}）`] };
  }

  const id = cleanString(raw.id, fallbackId);
  if (!id) return { manifest: null, problems: ['缺少 id'] };
  if (!isSafeSkinSlug(id)) {
    return { manifest: null, problems: [`id 必须是小写 slug（[a-z0-9][a-z0-9_-]*，≤${LIMITS.id}），当前：${id}`] };
  }
  if (RESERVED_SKIN_IDS.has(id)) {
    return { manifest: null, problems: [`id "${id}" 为内置保留 id，第三方包不得占用`] };
  }

  const name = cleanString(raw.name);
  if (!name) return { manifest: null, problems: ['缺少 name（必填）'] };
  if (name.length > LIMITS.name) return { manifest: null, problems: [`name 超过 ${LIMITS.name} 字符`] };
  const author = cleanString(raw.author).slice(0, LIMITS.author);
  const description = cleanString(raw.description).slice(0, LIMITS.description);
  if (String(raw.author ?? '').trim().length > LIMITS.author) problems.push(`author 超过 ${LIMITS.author} 字符，已截断`);
  if (String(raw.description ?? '').trim().length > LIMITS.description) problems.push(`description 超过 ${LIMITS.description} 字符，已截断`);

  const renderer = raw.renderer;
  if (!RENDERERS.has(renderer)) {
    return { manifest: null, problems: [`renderer 必须是 layers 或 sprite-sheet（当前：${renderer ?? '缺失'}）`] };
  }

  // ---- states ----
  const rawStates = plainObject(raw.states) ? raw.states : null;
  if (!rawStates || !Object.keys(rawStates).length) {
    return { manifest: null, problems: ['states 缺失或为空'] };
  }
  const stateKeys = Object.keys(rawStates);
  if (stateKeys.length > LIMITS.states) problems.push(`states 数量超过上限 ${LIMITS.states}，多余项已丢弃`);
  for (const key of REQUIRED_STATES) {
    if (!stateKeys.includes(key)) return { manifest: null, problems: [`states 缺少必需状态 "${key}"`] };
  }

  // layers 渲染器需要全局画布尺寸
  let globalCanvas = null;
  if (renderer === 'layers') {
    const c = plainObject(raw.canvas) ? raw.canvas : null;
    const w = c ? asInt(c.width) : NaN;
    const h = c ? asInt(c.height) : NaN;
    if (w >= 1 && w <= LIMITS.canvasSize && h >= 1 && h <= LIMITS.canvasSize) {
      globalCanvas = { width: w, height: h };
    } else {
      return { manifest: null, problems: [`layers 渲染器需要顶层 canvas {width,height}（1..${LIMITS.canvasSize}）`] };
    }
  }

  const states = {};
  for (const key of stateKeys.slice(0, LIMITS.states)) {
    if (!isSafeSkinSlug(key)) { problems.push(`states 状态名 "${key}" 非法（需小写 slug），已跳过`); continue; }
    const st = rawStates[key];
    if (!plainObject(st)) { problems.push(`states.${key} 不是对象，已跳过`); continue; }
    const normalized = renderer === 'layers'
      ? normalizeLayersState(st, problems, key)
      : normalizeSheetState(st, problems, key);
    if (renderer === 'sprite-sheet' && !normalized) continue; // 帧图状态判废 → 缺失兜底
    if (renderer === 'layers' && !normalized.layers.length) { problems.push(`states.${key} 没有任何合法图层，已跳过`); continue; }
    states[key] = normalized;
  }
  for (const key of REQUIRED_STATES) {
    if (!states[key]) return { manifest: null, problems: [`必需状态 "${key}" 没有任何合法内容`] };
  }

  // 未知顶层字段：不拦截（v1 内前向兼容），但记录出来便于排查拼写错误
  const known = new Set(['format', 'version', 'id', 'name', 'author', 'description', 'renderer', 'canvas', 'states']);
  const unknownFields = Object.keys(raw).filter((k) => !known.has(k));
  if (unknownFields.length) problems.push(`存在未知顶层字段（已忽略）：${unknownFields.join(', ')}`);

  const manifest = {
    format: SKIN_FORMAT,
    version: SKIN_FORMAT_VERSION,
    id,
    name,
    author,
    description,
    renderer,
    canvas: globalCanvas,
    states,
  };
  return { manifest, problems };
}

/**
 * 从规范化后的 manifest 提取全部资源相对路径（去重），
 * 供 registry 做"文件存在 + 未越界"的文件系统级校验。
 */
export function extractResourcePaths(manifest) {
  const paths = new Set();
  if (!manifest?.states) return [];
  for (const state of Object.values(manifest.states)) {
    if (manifest.renderer === 'layers') {
      for (const layer of state.layers || []) paths.add(layer.src);
    } else if (state.sheet) {
      paths.add(state.sheet);
    }
  }
  return [...paths].slice(0, LIMITS.totalResourcesHard);
}
