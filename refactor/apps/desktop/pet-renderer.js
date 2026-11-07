/**
 * 桌宠扩展契约（② 语义状态规则 + ③ pet.actions）—— 纯函数，不碰 DOM/window，
 * node 可直接 require 做断言（见本报告的最小断言输出）。
 *
 * 设计要点：
 *   · 皮肤包保持「零 JS」：只能**声明**规则与动作，由宿主评估/执行；
 *   · 宿主维护一张**语义状态优先级表**：多条同时命中时 priority 高者胜出，
 *     全不命中时回退 idle/working（与今天的行为完全一致）；
 *   · minHoldMs 防抖：上一个状态没待够时间就不切，避免状态来回抖；
 *   · 契约校验是软模式：坏项逐条丢弃并记 problems，绝不因为一条坏规则
 *     就把桌宠打回内置图。
 */
var PET_CONTRACT = (function () {
  'use strict';

  var SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
  var SIGNALS = { working: 'boolean', hour: 'number', weekday: 'number', mood: 'string', energy: 'string', tokens: 'number', runs: 'number' };
  var OPS = { eq: 1, neq: 1, gt: 1, gte: 1, lt: 1, lte: 1, in: 1, includes: 1, between: 1 };

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }
  function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max || 64) : ''; }

  function normalizeCondition(raw, problems, ctx) {
    if (!isObj(raw)) return null;
    if (Array.isArray(raw.all)) {
      var all = raw.all.slice(0, 8).map(function (c, i) {
        return normalizeCondition(c, problems, ctx + '.all[' + i + ']');
      }).filter(Boolean);
      return all.length ? { all: all } : null;
    }
    if (Array.isArray(raw.any)) {
      var any = raw.any.slice(0, 8).map(function (c, i) {
        return normalizeCondition(c, problems, ctx + '.any[' + i + ']');
      }).filter(Boolean);
      return any.length ? { any: any } : null;
    }
    var signal = str(raw.signal, 32);
    if (!SIGNALS[signal]) { problems.push(ctx + ' signal 不在白名单（working/hour/weekday/mood/energy/tokens/runs）：' + (signal || '空')); return null; }
    var op = str(raw.op, 16);
    if (!OPS[op]) { problems.push(ctx + ' op 不在白名单（eq/neq/gt/gte/lt/lte/in/includes/between）：' + (op || '空')); return null; }
    var kind = SIGNALS[signal];
    var value = raw.value;
    if (op === 'in') {
      if (!Array.isArray(value) || !value.length) { problems.push(ctx + ' in 需要非空数组'); return null; }
      value = value.slice(0, 16).map(function (v) { return kind === 'number' ? num(v) : str(v, 64); })
        .filter(function (v) { return v !== null && v !== ''; });
      if (!value.length) { problems.push(ctx + ' in 数组里没有合法项'); return null; }
    } else if (op === 'between') {
      if (!Array.isArray(value) || value.length !== 2) { problems.push(ctx + ' between 需要 [起, 止] 两个端点'); return null; }
      var a = num(value[0]), b = num(value[1]);
      if (a === null || b === null) { problems.push(ctx + ' between 端点必须是数字'); return null; }
      value = [a, b];
    } else if (kind === 'number') {
      var n = num(value);
      if (n === null) { problems.push(ctx + ' value 必须是数字'); return null; }
      value = n;
    } else if (kind === 'boolean') {
      value = value === true || value === 'true' || value === 1 || value === '1';
    } else {
      value = str(value, 64);
      if (!value) { problems.push(ctx + ' value 必须是非空字符串'); return null; }
    }
    return { signal: signal, op: op, value: value };
  }

  /** 规则表校验：state 必须是皮肤里**存在**的状态，否则整条丢弃（避免切到空状态）。 */
  function normalizeStateRules(raw, states) {
    var problems = [];
    var out = [];
    var list = Array.isArray(raw) ? raw.slice(0, 16) : [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!isObj(r)) { problems.push('stateRules[' + i + '] 不是对象，已跳过'); continue; }
      // 先算 when：**具体原因**（signal / op / value 哪儿不对）优先报出来。
      // 反过来先判「皮肤有没有这个状态」的话，一条规则同时有两种毛病时，
      // 真正的原因会被「该皮肤没有这个状态」盖掉，排查时会白查半天。
      var when = normalizeCondition(r.when, problems, 'stateRules[' + i + '].when');
      var stateKey = str(r.state, 64);
      if (!SLUG.test(stateKey)) { problems.push('stateRules[' + i + '].state 非法（需小写 slug），已跳过'); continue; }
      if (states && !states[stateKey]) { problems.push('stateRules[' + i + '].state "' + stateKey + '" 该皮肤没有这个状态，已跳过'); continue; }
      if (!when) { problems.push('stateRules[' + i + '] 缺少合法 when，已跳过'); continue; }
      var p = num(r.priority);
      out.push({
        state: stateKey,
        label: str(r.label, 24),
        priority: p === null ? 0 : Math.round(Math.max(-100000, Math.min(100000, p))),
        minHoldMs: Math.round(Math.max(0, Math.min(600000, num(r.minHoldMs) || 0))),
        when: when
      });
    }
    return { rules: out, problems: problems };
  }

  /**
   * 宿主内置规则（可被皮肤/插件声明的同名规则按 priority 覆盖）。
   * 只有「皮肤里真的有这个状态」时才生效 —— 没写 sleeping 的皮肤行为完全不变。
   */
  var BUILTIN_STATE_RULES = [
    { state: 'working', priority: 100, label: '', minHoldMs: 0, when: { signal: 'working', op: 'eq', value: true } },
    { state: 'sleeping', priority: 40, label: '睡着了', minHoldMs: 60000, when: { signal: 'hour', op: 'between', value: [22, 6] } }
  ];

  function evaluateCondition(cond, signals) {
    if (!cond || typeof cond !== 'object') return false;
    if (Array.isArray(cond.all)) {
      for (var i = 0; i < cond.all.length; i++) { if (!evaluateCondition(cond.all[i], signals)) return false; }
      return cond.all.length > 0;
    }
    if (Array.isArray(cond.any)) {
      for (var j = 0; j < cond.any.length; j++) { if (evaluateCondition(cond.any[j], signals)) return true; }
      return false;
    }
    var left = signals ? signals[cond.signal] : undefined;
    var v = cond.value;
    switch (cond.op) {
      case 'eq': return left === v;
      case 'neq': return left !== v;
      case 'gt': return Number(left) > Number(v);
      case 'gte': return Number(left) >= Number(v);
      case 'lt': return Number(left) < Number(v);
      case 'lte': return Number(left) <= Number(v);
      case 'in': return Array.isArray(v) && v.indexOf(left) >= 0;
      case 'includes': return typeof left === 'string' && typeof v === 'string' && left.indexOf(v) >= 0;
      case 'between': {
        var a = Number(v[0]), b = Number(v[1]), x = Number(left);
        // 起 > 止 视为跨零点时段（如 22 → 6）
        return a <= b ? (x >= a && x <= b) : (x >= a || x <= b);
      }
      default: return false;
    }
  }

  /**
   * 语义状态优先级表求值。
   * @returns {{key:string,label:string,minHoldMs:number}} 永远返回一个可用状态
   *   （最差回退 idle/working），调用方不需要再兜底。
   */
  function pickSemanticState(rules, signals, states, current, now) {
    var usable = [];
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (!r || !r.state) continue;
      if (states) { if (!states[r.state]) continue; }
      else if (r.state !== 'idle' && r.state !== 'working') continue;   // 旧图 fallback 只有这两个语义
      usable.push(r);
    }
    usable.sort(function (x, y) { return y.priority - x.priority; });
    var cur = current || null;
    for (var j = 0; j < usable.length; j++) {
      var rule = usable[j];
      if (!evaluateCondition(rule.when, signals)) continue;
      if (cur && cur.key === rule.state) return { key: rule.state, label: rule.label || '', minHoldMs: rule.minHoldMs };
      // 防抖：上一个状态还没待够它的 minHoldMs，就维持不动（即使它已不再命中）
      if (cur && cur.key && cur.at && cur.minHoldMs && (now - cur.at) < cur.minHoldMs) {
        return { key: cur.key, label: cur.label || '', minHoldMs: cur.minHoldMs };
      }
      return { key: rule.state, label: rule.label || '', minHoldMs: rule.minHoldMs };
    }
    return { key: signals && signals.working ? 'working' : 'idle', label: '', minHoldMs: 0 };
  }

  /** 悬浮面板的**声明式**规格（零 JS 路径）：宿主按白名单 DOM 渲染，不 innerHTML 第三方字符串。 */
  function normalizePanelSpec(raw, problems, ctx) {
    if (raw === undefined || raw === null) return null;
    if (!isObj(raw)) { problems.push(ctx + ' 不是对象，已忽略'); return null; }
    var spec = { title: str(raw.title, 24), lines: [], buttons: [] };
    var lines = Array.isArray(raw.lines) ? raw.lines.slice(0, 8) : [];
    for (var i = 0; i < lines.length; i++) {
      if (!isObj(lines[i])) continue;
      spec.lines.push({ label: str(lines[i].label, 16), value: str(lines[i].value, 40) });
    }
    var buttons = Array.isArray(raw.buttons) ? raw.buttons.slice(0, 4) : [];
    for (var j = 0; j < buttons.length; j++) {
      if (!isObj(buttons[j])) continue;
      var action = str(buttons[j].action, 64);
      if (!SLUG.test(action)) { problems.push(ctx + '.buttons[' + j + '].action 非法（需小写 slug），已跳过'); continue; }
      spec.buttons.push({ label: str(buttons[j].label, 16), action: action });
    }
    return spec;
  }

  /**
   * pet.actions 声明校验：{ id, label, place: 'context-menu'|'overlay', spec? }。
   * 一个来源最多 12 个动作；id 重复、place 非白名单、label 空 → 逐条丢弃。
   */
  function normalizePetActions(raw, sourceId) {
    var problems = [];
    var out = [];
    var list = Array.isArray(raw) ? raw.slice(0, 12) : [];
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!isObj(a)) { problems.push('actions[' + i + '] 不是对象，已跳过'); continue; }
      var id = str(a.id, 64);
      if (!SLUG.test(id)) { problems.push('actions[' + i + '].id 非法（需小写 slug），已跳过'); continue; }
      var label = str(a.label, 24);
      if (!label) { problems.push('actions[' + i + '].label 必填（≤24 字符），已跳过'); continue; }
      var place = str(a.place, 16);
      if (place !== 'context-menu' && place !== 'overlay') { problems.push('actions[' + i + '].place 必须是 context-menu 或 overlay，已跳过'); continue; }
      if (seen[id]) { problems.push('actions[' + i + '].id 重复：' + id + '，已跳过'); continue; }
      seen[id] = 1;
      out.push({
        id: id,
        label: label,
        place: place,
        source: str(a.source, 64) || str(sourceId, 64),
        spec: normalizePanelSpec(a.spec, problems, 'actions[' + i + '].spec')
      });
    }
    return { actions: out, problems: problems };
  }

  return {
    SIGNALS: SIGNALS,
    OPS: OPS,
    BUILTIN_STATE_RULES: BUILTIN_STATE_RULES,
    normalizeStateRules: normalizeStateRules,
    evaluateCondition: evaluateCondition,
    pickSemanticState: pickSemanticState,
    normalizePetActions: normalizePetActions,
    normalizePanelSpec: normalizePanelSpec
  };
})();
if (typeof module === 'object' && module.exports) module.exports = PET_CONTRACT;

function __petMain() {
  'use strict';

  var api = typeof window.qqAgentPet === 'object' && window.qqAgentPet !== null
    ? window.qqAgentPet
    : null;

  var btnHide = document.getElementById('btn-hide');
  var btnOnTop = document.getElementById('btn-on-top');
  var pet = document.getElementById('pet');
  var sprite = document.getElementById('pet-sprite');
  var stateLine = document.getElementById('state-line');
  var usageLine = document.getElementById('usage-line');
  var moodLine = document.getElementById('mood-line');
  var emotionLine = document.getElementById('emotion-line');

  var MODE_IDLE = 'idle';
  var MODE_WORK = 'work';
  var COMPACT_SIZE = 160;

  // 内置旧图 fallback（default）的固定几何参数 —— 只属于这两张历史 PNG，
  // 皮肤驱动路径一律改用 manifest 里的 canvas / 帧尺寸，不再有全局常量。
  var LEGACY = {
    idle: { frames: 24, columns: 6, rows: 4, fps: 6, baseRow: 0 },
    work: { frames: 8, columns: 4, rows: 4, fps: 6, baseRow: 2 }
  };

  var state = {
    settings: {
      desktopPetSize: 0,
      desktopPetAutoActions: true,
      desktopPetShowUsage: true,
      desktopPetShowMood: true,
      desktopPetSkin: ''
    },
    status: null,
    // 主进程解析好的皮肤档案（public summary，无绝对路径）与资源 URL base
    skin: null,
    fallbackSkin: null,
    assetRoot: '',
    legacy: null
  };

  var currentMode = MODE_IDLE;
  var frameIndex = 0;

  // 皮肤渲染状态：candidateIndex 指向 skin 链（skin → fallbackSkin → 旧图）
  var candidateIndex = 0;
  var rejectedSkinSignatures = Object.create(null);
  var buildSeq = 0;                // 重建代际：stale 的 load/error 回调不得再触发回退
  var skinStage = null;            // layers 模式的舞台外框（布局尺寸 = 适配后大小）
  var skinCanvas = null;           // 内层 canvas 坐标系（transform 缩放）
  var layerEls = {};               // layerId -> img 元素
  var layerTracks = [];            // 编译后的动画轨道
  var layerHasAnims = false;
  var sheetInfo = null;            // sprite-sheet 帧几何、节拍与可选连续 motion
  var rafId = null;
  var animStart = 0;
  var sheetPlaybackStart = 0;
  var sheetLastFrame = -1;
  var sheetFinished = false;
  var legacyProbeSeq = 0;         // 旧图探测代次：重建即 +1，晚到的 load/error 一律作废
  var legacyMissing = false;      // 旧图 404 可见占位是否在显示

  function call(name) {
    if (!api || typeof api[name] !== 'function') return;
    try {
      var result = api[name]();
      if (result && typeof result.catch === 'function') {
        result.catch(function () {});
      }
    } catch (error) {
      console.warn('[desktop-pet] ' + name + ' 调用失败:', error && error.message ? error.message : error);
    }
  }

  if (btnHide) {
    btnHide.addEventListener('click', function (event) {
      event.preventDefault();
      call('hide');
    });
  }

  if (btnOnTop) {
    btnOnTop.addEventListener('click', function (event) {
      event.preventDefault();
      call('toggleAlwaysOnTop');
    });
  }

  function setText(node, text) {
    if (!node) return;
    node.textContent = text;
  }

  function toggleLine(node, show, text) {
    if (!node) return;
    if (!show) {
      node.hidden = true;
      node.textContent = '';
      return;
    }
    node.hidden = false;
    node.textContent = text;
  }

  function formatNumber(value) {
    var num = Number(value);
    if (!isFinite(num) || num < 0) num = 0;
    return String(Math.floor(num));
  }

  function renderUsage(status) {
    var show = !!state.settings.desktopPetShowUsage;
    var usage = status && status.usage ? status.usage : null;
    if (!show || !usage) {
      toggleLine(usageLine, false, '');
      return;
    }
    var tokens = formatNumber(usage.totalTokens);
    var runs = formatNumber(usage.runs);
    toggleLine(usageLine, true, '今日 ' + tokens + ' tokens · ' + runs + ' 次调用');
  }

  function renderMood(status) {
    var show = !!state.settings.desktopPetShowMood;
    var botState = status && status.botState ? status.botState : null;
    if (!show || !botState) {
      toggleLine(moodLine, false, '');
      toggleLine(emotionLine, false, '');
      return;
    }

    var mood = typeof botState.moodLabel === 'string' ? botState.moodLabel.trim() : '';
    var energy = typeof botState.energyLabel === 'string' ? botState.energyLabel.trim() : '';
    var moodText = [];
    if (mood) moodText.push('心情 ' + mood);
    if (energy) moodText.push('精力 ' + energy);
    toggleLine(moodLine, moodText.length > 0, moodText.join(' · '));

    var phrases = botState.emotionPhrases;
    var emotionText = '';
    if (Array.isArray(phrases)) {
      emotionText = phrases
        .filter(function (item) { return typeof item === 'string' && item.trim() !== ''; })
        .map(function (item) { return item.trim(); })
        .join(' · ');
    } else if (typeof phrases === 'string') {
      emotionText = phrases.trim();
    }
    toggleLine(emotionLine, emotionText !== '', emotionText);
  }

  function applySize() {
    var raw = state.settings.desktopPetSize;
    var size = typeof raw === 'number' ? raw : parseInt(raw, 10);
    if (!isFinite(size) || size <= 0) {
      document.body.classList.remove('is-compact');
      return;
    }
    var width = Math.max(90, Math.round(size));
    var height = Math.round(width * (320 / 280));
    document.documentElement.style.setProperty('--pet-width', width + 'px');
    document.documentElement.style.setProperty('--pet-height', height + 'px');
    document.body.classList.toggle('is-compact', width <= COMPACT_SIZE);
  }

  function resolveMode() {
    var status = state.status;
    if (!status || typeof status !== 'object') return MODE_IDLE;
    return status.working ? MODE_WORK : MODE_IDLE;
  }

  // ── ② 语义状态：宿主信号 + 优先级表 ──────────────────────────────────
  // 第三方（皮肤/插件）**只声明**规则，不碰窗口内部；宿主负责求值并在状态之间切换。
  var semanticState = { key: 'idle', label: '', at: 0, minHoldMs: 0 };

  /** 宿主能给出的信号（规则里只能用这些 signal 名）。 */
  function petSignals() {
    var status = state.status && typeof state.status === 'object' ? state.status : {};
    var bot = status.botState && typeof status.botState === 'object' ? status.botState : {};
    var usage = status.usage && typeof status.usage === 'object' ? status.usage : {};
    var now = new Date();
    return {
      working: status.working === true,
      hour: now.getHours(),
      weekday: now.getDay(),
      mood: typeof bot.moodLabel === 'string' ? bot.moodLabel.trim() : '',
      energy: typeof bot.energyLabel === 'string' ? bot.energyLabel.trim() : '',
      tokens: Number(usage.totalTokens) || 0,
      runs: Number(usage.runs) || 0
    };
  }

  /** 规则来源：皮肤包声明的 stateRules（v1 清单放行后生效）+ 后续来源；内置规则兜底。 */
  function declaredStateRules() {
    var skinRules = state.skin && Array.isArray(state.skin.stateRules) ? state.skin.stateRules : null;
    var snapRules = Array.isArray(state.stateRules) ? state.stateRules : null;
    return skinRules || snapRules || [];
  }

  function resolveSemanticState() {
    var candidate = currentCandidate();
    var states = candidate && candidate.states && typeof candidate.states === 'object' ? candidate.states : null;
    var rules = PET_CONTRACT.BUILTIN_STATE_RULES.slice();
    try {
      var normalized = PET_CONTRACT.normalizeStateRules(declaredStateRules(), states);
      if (normalized.problems.length) {
        console.warn('[desktop-pet] 语义状态规则有问题（坏项已跳过）：' + normalized.problems.join('；'));
      }
      rules = rules.concat(normalized.rules);
    } catch (error) {
      console.warn('[desktop-pet] 语义状态规则解析失败，只用内置规则:', error && error.message ? error.message : error);
    }
    try {
      return PET_CONTRACT.pickSemanticState(rules, petSignals(), states, semanticState, Date.now());
    } catch (error) {
      // 求值出任何意外都回到「今天的行为」，绝不因为一条坏规则让桌宠变空白
      console.warn('[desktop-pet] 语义状态求值失败，回退 idle/working:', error && error.message ? error.message : error);
      return { key: currentMode === MODE_WORK ? 'working' : 'idle', label: '', minHoldMs: 0 };
    }
  }

  function modeStateKey() {
    return semanticState.key || (currentMode === MODE_WORK ? 'working' : 'idle');
  }

  function percent(value, cellCount) {
    var text = (value * 100 / Math.max(1, cellCount - 1)).toFixed(4);
    if (text.indexOf('.') !== -1) {
      text = text.replace(/0+$/, '').replace(/\.$/, '');
    }
    return text + '%';
  }

  // ── 皮肤链：skin → fallbackSkin → 内置旧图 ─────────────────────────────

  function isLoopbackUrl(url) {
    return typeof url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\//.test(url);
  }

  function legacyUrls() {
    var legacy = state.legacy && typeof state.legacy === 'object' ? state.legacy : null;
    var idle = legacy && isLoopbackUrl(legacy.idle) ? legacy.idle : '';
    var work = legacy && isLoopbackUrl(legacy.work) ? legacy.work : '';
    return { idle: idle, work: work };
  }

  function currentCandidate() {
    var chain = [];
    if (state.skin) chain.push(state.skin);
    if (state.fallbackSkin) chain.push(state.fallbackSkin);
    while (candidateIndex < chain.length) {
      var candidate = chain[candidateIndex];
      var rejected = candidate && typeof candidate.id === 'string' ? rejectedSkinSignatures[candidate.id] : '';
      if (!rejected) return candidate || null;
      if (rejected === skinGeometrySignature(candidate)) {
        candidateIndex += 1;
        continue;
      }
      delete rejectedSkinSignatures[candidate.id];
      return candidate || null;
    }
    return null;
  }

  function skinGeometrySignature(skin) {
    if (!skin || typeof skin !== 'object') return '';
    var parts = [state.assetRoot, skin.id || '', skin.renderer || ''];
    ['idle', 'working'].forEach(function (key) {
      var frame = skin.states && skin.states[key] && typeof skin.states[key] === 'object' ? skin.states[key] : {};
      parts.push([key, frame.sheet || '', frame.frameWidth || '', frame.frameHeight || '', frame.frames || '', frame.row || 0].join(':'));
    });
    return parts.join('|');
  }

  function assetUrl(skinId, rel) {
    if (!state.assetRoot || typeof rel !== 'string' || rel === '') return '';
    // rel 已在主进程按 manifest 白名单校验过；这里只做来源限定（skinId 同样来自主进程摘要）
    return state.assetRoot + encodeURIComponent(skinId) + '/' + rel.split('/').map(encodeURIComponent).join('/');
  }

  // ── 声明式动画编译：只认白名单数值属性，绝不执行皮肤代码/动态 CSS ──────

  var ANIMATABLE = { x: true, y: true, rotate: true, scale: true, opacity: true };
  var ANIM_LIMITS = { translate: 2048, rotate: 1080, scaleMin: 0.01, scaleMax: 8 };

  function clampAnimValue(prop, value) {
    var v = Number(value);
    if (!isFinite(v)) return null;
    if (prop === 'opacity') return Math.min(1, Math.max(0, v));
    if (prop === 'scale') return Math.min(ANIM_LIMITS.scaleMax, Math.max(ANIM_LIMITS.scaleMin, v));
    if (prop === 'rotate') return Math.min(ANIM_LIMITS.rotate, Math.max(-ANIM_LIMITS.rotate, v));
    return Math.min(ANIM_LIMITS.translate, Math.max(-ANIM_LIMITS.translate, v));
  }

  function makeCubicBezier(x1, y1, x2, y2) {
    // 二分逼近的 cubic-bezier（CSS 同名缓动的近似实现）
    var cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    var cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    function sampleX(t) { return ((ax * t + bx) * t + cx) * t; }
    function sampleY(t) { return ((ay * t + by) * t + cy) * t; }
    return function (p) {
      if (p <= 0) return 0;
      if (p >= 1) return 1;
      var lo = 0, hi = 1, t = p;
      for (var i = 0; i < 12; i++) {
        var x = sampleX(t);
        if (Math.abs(x - p) < 1e-4) break;
        if (x < p) lo = t; else hi = t;
        t = (lo + hi) / 2;
      }
      return sampleY(t);
    };
  }

  var EASINGS = {
    linear: function (p) { return p; },
    'ease-in': makeCubicBezier(0.42, 0, 1, 1),
    'ease-out': makeCubicBezier(0, 0, 0.58, 1),
    'ease-in-out': makeCubicBezier(0.42, 0, 0.58, 1),
    steps: function (p) { return p >= 1 ? 1 : Math.floor(p * 4) / 4; }
  };

  function compileAnimations(skinState) {
    var tracks = [];
    var anims = Array.isArray(skinState.animations) ? skinState.animations : [];
    for (var i = 0; i < anims.length; i++) {
      var anim = anims[i];
      if (!anim || typeof anim !== 'object') continue;
      var duration = Number(anim.durationMs);
      if (!isFinite(duration) || duration < 100) continue;
      var easing = EASINGS[anim.easing] ? anim.easing : 'linear';
      var tracksRaw = Array.isArray(anim.tracks) ? anim.tracks : [];
      for (var j = 0; j < tracksRaw.length; j++) {
        var track = tracksRaw[j];
        if (!track || typeof track !== 'object' || !ANIMATABLE[track.property]) continue;
        var kfs = (Array.isArray(track.keyframes) ? track.keyframes : [])
          .map(function (kf) {
            return { t: Math.max(0, Number(kf && kf.t) || 0), value: clampAnimValue(track.property, kf && kf.value) };
          })
          .filter(function (kf) { return kf.value !== null; })
          .sort(function (a, b) { return a.t - b.t; });
        if (!kfs.length) continue;
        tracks.push({
          target: anim.target,
          property: track.property,
          keyframes: kfs,
          duration: duration,
          loop: anim.loop !== false,
          ease: EASINGS[easing]
        });
      }
    }
    return tracks;
  }

  function sampleTrack(track, t) {
    var kfs = track.keyframes;
    var last = kfs[kfs.length - 1];
    if (t <= kfs[0].t) return kfs[0].value;
    if (t >= last.t) return last.value;
    for (var i = 1; i < kfs.length; i++) {
      if (t <= kfs[i].t) {
        var k0 = kfs[i - 1], k1 = kfs[i];
        var span = k1.t - k0.t;
        var p = span > 0 ? (t - k0.t) / span : 1;
        p = track.ease(p);
        return k0.value + (k1.value - k0.value) * p;
      }
    }
    return last.value;
  }

  // ── DOM 构建 ────────────────────────────────────────────────────────────

  function ensureSkinStage() {
    if (skinStage) return skinStage;
    skinStage = document.createElement('div');
    skinStage.className = 'pet__skin';
    skinStage.setAttribute('aria-hidden', 'true');
    skinCanvas = document.createElement('div');
    skinCanvas.className = 'pet__skin-canvas';
    skinStage.appendChild(skinCanvas);
    if (pet) pet.insertBefore(skinStage, sprite);
    return skinStage;
  }

  function clearSkinDom(preserveSpriteTransform) {
    if (rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafId);
    }
    rafId = null;
    animStart = 0;
    sheetPlaybackStart = 0;
    sheetLastFrame = -1;
    sheetFinished = false;
    if (sprite && !preserveSpriteTransform) sprite.style.transform = '';
    if (sprite) sprite.style.visibility = '';
    // 断开旧图层/探针的回调：detached img 的 load/error 仍可能晚到，不得触发回退
    for (var id in layerEls) {
      try { layerEls[id].onerror = null; layerEls[id].onload = null; } catch { /* ignore */ }
    }
    layerEls = {};
    layerTracks = [];
    layerHasAnims = false;
    sheetInfo = null;
    if (skinStage && skinStage.parentNode) skinStage.parentNode.removeChild(skinStage);
    skinStage = null;
    skinCanvas = null;
    legacyProbeSeq += 1;                 // 作废旧图探测：detached Image 的 load/error 可能晚到
    clearLegacyPlaceholder();
    if (sprite) sprite.style.display = '';
  }

  function degradeSkin() {
    candidateIndex += 1;
    buildActive();
    // Continue playback after replacing a failed skin with the next fallback.
    syncPlayback();
  }

  function applyLayerStatic() {
    applyLayerTime(0);
  }

  /** 按 manifest 的 x/y/z/opacity 摆好图层（无动画时的静止帧）。 */
  function applyLayerTime(elapsed) {
    for (var id in layerEls) {
      var el = layerEls[id];
      var base = el.__petBase;
      if (!base) continue;
      var dx = 0, dy = 0, rot = 0, scale = 1, opacity = base.opacity;
      for (var i = 0; i < layerTracks.length; i++) {
        var track = layerTracks[i];
        if (track.target !== id) continue;
        var t = track.loop ? (elapsed % track.duration) : Math.min(elapsed, track.duration);
        var v = sampleTrack(track, t);
        if (track.property === 'x') dx = v;
        else if (track.property === 'y') dy = v;
        else if (track.property === 'rotate') rot = v;
        else if (track.property === 'scale') scale = v;
        else if (track.property === 'opacity') opacity = v;
      }
      el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) rotate(' + rot + 'deg) scale(' + scale + ')';
      el.style.opacity = String(Math.min(1, Math.max(0, opacity)));
    }
  }

  function fitSkinStage(canvasW, canvasH) {
    if (!pet || !skinStage || !skinCanvas) return;
    var boxW = pet.clientWidth;
    var boxH = pet.clientHeight;
    if (!(boxW > 0 && boxH > 0 && canvasW > 0 && canvasH > 0)) return;
    var scale = Math.min(boxW / canvasW, boxH / canvasH);
    // 外框 = 适配后的布局尺寸；内层保持 canvas 原始坐标系，整体 transform 缩放
    skinStage.style.width = Math.max(1, Math.round(canvasW * scale)) + 'px';
    skinStage.style.height = Math.max(1, Math.round(canvasH * scale)) + 'px';
    skinCanvas.style.width = Math.round(canvasW) + 'px';
    skinCanvas.style.height = Math.round(canvasH) + 'px';
    skinCanvas.style.transform = 'scale(' + scale + ')';
    skinStage.style.overflow = 'visible';
  }

  function buildLayers(skin, skinState, seq) {
    var canvas = skinState.canvas || skin.canvas || { width: 128, height: 128 };
    var canvasW = Number(canvas.width), canvasH = Number(canvas.height);
    if (!(canvasW > 0 && canvasH > 0)) { degradeSkin(); return; }

    var stage = ensureSkinStage();
    stage.style.display = '';
    // layers 模式占住舞台，旧 sprite 元素隐藏（clearSkinDom 会复位）
    if (sprite) sprite.style.display = 'none';
    var layers = Array.isArray(skinState.layers) ? skinState.layers : [];
    if (!layers.length) { degradeSkin(); return; }

    layerTracks = compileAnimations(skinState);
    layerHasAnims = layerTracks.length > 0;

    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      if (!layer || typeof layer !== 'object' || typeof layer.id !== 'string' || !layer.id) continue;
      var url = assetUrl(skin.id, layer.src);
      if (!url) { degradeSkin(); return; }
      var img = document.createElement('img');
      img.alt = '';
      // v1 契约图层无独立尺寸字段：图片按 canvas 全幅绘制并映射进 canvas 坐标系，
      // x/y/z/opacity 与动画值均以 canvas 单位生效（否则自然尺寸大图会溢出坐标系）；
      // objectFit contain 保证非方形源图在 canvas 盒内等比缩放、居中、不拉伸变形
      img.style.width = canvasW + 'px';
      img.style.height = canvasH + 'px';
      img.style.objectFit = 'contain';
      img.__petBase = {
        x: Number(layer.x) || 0,
        y: Number(layer.y) || 0,
        opacity: Math.min(1, Math.max(0, isFinite(Number(layer.opacity)) ? Number(layer.opacity) : 1))
      };
      img.style.left = img.__petBase.x + 'px';
      img.style.top = img.__petBase.y + 'px';
      img.style.zIndex = String(Number(layer.z) || 0);
      img.onerror = function () { if (seq === buildSeq) degradeSkin(); };
      img.__petId = layer.id;
      img.src = url;
      layerEls[layer.id] = img;
      skinCanvas.appendChild(img);
    }
    fitSkinStage(canvasW, canvasH);
    applyLayerStatic();
  }

  function buildSheet(skin, skinState, seq, cachedLayout) {
    var url = assetUrl(skin.id, skinState.sheet);
    if (!url) { degradeSkin(); return; }
    var frameW = Number(skinState.frameWidth), frameH = Number(skinState.frameHeight);
    var frames = Number(skinState.frames) || 1;
    if (!(frameW > 0 && frameH > 0) || frames < 1) { degradeSkin(); return; }
    // 真实行列数在图片加载后按自然尺寸推导（skin 帧格几何不写死在代码里）
    var canReuseLayout = !!(cachedLayout && cachedLayout.url === url &&
      cachedLayout.frameW === frameW && cachedLayout.frameH === frameH &&
      cachedLayout.columns > 0 && cachedLayout.rows > 0 &&
      Number(skinState.row || 0) + Math.ceil(frames / cachedLayout.columns) <= cachedLayout.rows);
    sheetInfo = {
      url: url,
      frameW: frameW,
      frameH: frameH,
      frames: frames,
      row: Math.max(0, Number(skinState.row) || 0),
      fps: Math.min(60, Math.max(1, Number(skinState.fps) || 8)),
      loop: skinState.loop !== false,
      motion: skinState.motion && typeof skinState.motion === 'object' ? skinState.motion : null,
      columns: canReuseLayout ? cachedLayout.columns : frames,
      rows: canReuseLayout ? cachedLayout.rows : 1,
      ready: canReuseLayout
    };
    sheetFinished = false;
    var probe = new Image();
    probe.onload = function () {
      if (seq !== buildSeq || !sheetInfo || sheetInfo.url !== url) return;
      var cols = Math.max(1, Math.floor(probe.naturalWidth / sheetInfo.frameW));
      var rows = Math.max(1, Math.floor(probe.naturalHeight / sheetInfo.frameH));
      var requiredRows = Math.ceil(sheetInfo.frames / cols);
      if (!probe.naturalWidth || !probe.naturalHeight) {
        if (canReuseLayout) {
          console.warn('[desktop-pet] sprite-sheet 图片尺寸暂不可用，保留已验证画面；下次状态切换时可重试。');
        } else {
          console.warn('[desktop-pet] sprite-sheet 图片尺寸暂不可用，回退并允许稍后重试。');
          degradeSkin();
        }
        return;
      }
      if (sheetInfo.frameW > probe.naturalWidth || sheetInfo.frameH > probe.naturalHeight || sheetInfo.row + requiredRows > rows) {
        if (typeof skin.id === 'string') rejectedSkinSignatures[skin.id] = skinGeometrySignature(skin);
        console.warn('[desktop-pet] sprite-sheet 帧布局越界，已停用皮肤 ' + String(skin.id || '') + ' 并回退。');
        degradeSkin();
        return;
      }
      sheetInfo.columns = cols;
      sheetInfo.rows = rows;
      sheetInfo.ready = true;
      sheetLastFrame = -1;
      sheetFinished = false;
      applySheetFrame();
      syncPlayback();
    };
    probe.onerror = function () { if (seq === buildSeq && !canReuseLayout) degradeSkin(); };
    if (sprite && !canReuseLayout) sprite.style.visibility = 'hidden';
    showLegacyElementForSheet(url, frameW / frameH);
    if (canReuseLayout) applySheetFrame();
    probe.src = url;
    frameIndex = 0;
    syncPlayback();
  }

  /** sprite-sheet 复用旧 sprite 元素做背景帧格展示。 */
  function roundCssToDevicePixel(value) {
    var ratio = Number(window.devicePixelRatio) || 1;
    return Math.round(value * ratio) / ratio;
  }

  function showLegacyElementForSheet(url, aspect) {
    if (!sprite) return;
    sprite.style.display = '';
    sprite.classList.remove('is-work');
    sprite.style.backgroundImage = 'url("' + url + '")';
    sprite.style.backgroundRepeat = 'no-repeat';
    if (isFinite(aspect) && aspect > 0 && pet) {
      var boxW = pet.clientWidth, boxH = pet.clientHeight;
      var w = Math.min(boxW, boxH * aspect);
      var h = w / aspect;
      if (w > 0) {
        sprite.style.width = roundCssToDevicePixel(w) + 'px';
        sprite.style.height = roundCssToDevicePixel(h) + 'px';
      }
    }
  }

  function applySheetFrame() {
    if (!sprite || !sheetInfo || !sheetInfo.ready) return;
    var index = ((frameIndex % sheetInfo.frames) + sheetInfo.frames) % sheetInfo.frames;
    var col = index % sheetInfo.columns;
    var row = sheetInfo.row + Math.floor(index / sheetInfo.columns);
    sprite.style.backgroundSize = (sheetInfo.columns * 100) + '% ' + (sheetInfo.rows * 100) + '%';
    sprite.style.backgroundPosition = percent(col, sheetInfo.columns) + ' ' + percent(row, sheetInfo.rows);
    sprite.style.visibility = 'visible';
  }

  // ── 内置旧图 fallback ───────────────────────────────────────────────────

  /** 复位“旧图缺失”占位（只用 sprite 的内联样式/文本，不依赖 pet.css） */
  function clearLegacyPlaceholder() {
    if (!sprite || !legacyMissing) return;
    legacyMissing = false;
    sprite.textContent = '';
    sprite.style.display = '';
    sprite.style.fontSize = '';
    sprite.style.lineHeight = '';
    sprite.style.textAlign = '';
    sprite.style.color = '';
  }

  /**
   * 旧图加载探测（#18 做法①）：旧图走 CSS background，404 时 CSS 毫无反应 →
   * 页面留白。这里用 Image 先探一次：失败 = 清背景 + 可见占位 + console.warn；
   * 不把 `_trash-20260930-pet-old-art\` 的旧图资源搬回仓库（L3 需要用户点头）。
   * 没有 Image 构造器（node 测试夹具）→ 原样跳过，维持旧行为。
   */
  function probeLegacyImage(url) {
    if (typeof Image !== 'function') return;
    var seq = legacyProbeSeq;
    var img = new Image();
    img.onload = function () {
      if (seq !== legacyProbeSeq) return;
      clearLegacyPlaceholder();
    };
    img.onerror = function () {
      if (seq !== legacyProbeSeq) return;   // 已经重建过：这次失败作废
      if (!sprite || !sheetInfo || !sheetInfo.legacy || sheetInfo.url !== url) return;
      if (legacyMissing) return;
      legacyMissing = true;
      sprite.style.backgroundImage = '';
      sprite.style.backgroundSize = '';
      sprite.style.backgroundPosition = '';
      sprite.style.visibility = '';
      sprite.textContent = '图片缺失';
      sprite.style.display = 'flex';
      sprite.style.alignItems = 'center';
      sprite.style.justifyContent = 'center';
      sprite.style.fontSize = '12px';
      sprite.style.lineHeight = '1.4';
      sprite.style.textAlign = 'center';
      sprite.style.color = '#9aa3b2';
      console.warn('[desktop-pet] 旧图加载失败，已显示可见占位:', url);
    };
    img.src = url;
  }

  function buildLegacy() {
    clearSkinDom();
    var urls = legacyUrls();
    var isWork = currentMode === MODE_WORK;
    if (!sprite) return;
    var url = isWork ? urls.work : urls.idle;
    if (!url) return;   // 主进程还没给 URL：等下一次快照
    sprite.style.display = '';
    sprite.classList.toggle('is-work', isWork);
    var geo = isWork ? LEGACY.work : LEGACY.idle;
    sheetInfo = {
      url: url,
      frames: geo.frames,
      columns: geo.columns,
      rows: geo.rows,
      row: geo.baseRow,
      fps: geo.fps,
      loop: true,
      ready: true,
      legacy: true
    };
    sprite.style.backgroundImage = 'url("' + url + '")';
    sprite.style.backgroundSize = (geo.columns * 100) + '% ' + (geo.rows * 100) + '%';
    frameIndex = 0;
    applySheetFrame();
    probeLegacyImage(url);   // #18 做法①：URL 打不开 → 可见占位 + warn，不再留白
  }

  function sheetMotionSignature(motion) {
    if (!motion || typeof motion !== 'object') return '';
    return [motion.periodMs, motion.x, motion.y, motion.rotate, motion.scale].join('|');
  }

  function buildActive(preserveSheetVisuals) {
    buildSeq += 1;           // 使 stale 的 load/error 回调失效
    var previousSheet = sheetInfo && sheetInfo.ready && !sheetInfo.legacy ? {
      url: sheetInfo.url,
      frameW: sheetInfo.frameW,
      frameH: sheetInfo.frameH,
      columns: sheetInfo.columns,
      rows: sheetInfo.rows,
      motion: sheetInfo.motion
    } : null;
    var candidate = currentCandidate();
    var skinState = candidate && candidate.states ? candidate.states[modeStateKey()] : null;
    var nextUrl = candidate && candidate.renderer === 'sprite-sheet' && skinState
      ? assetUrl(candidate.id, skinState.sheet) : '';
    var canPreserveSheet = !!(preserveSheetVisuals && previousSheet && nextUrl === previousSheet.url &&
      Number(skinState.frameWidth) === previousSheet.frameW && Number(skinState.frameHeight) === previousSheet.frameH &&
      sheetMotionSignature(skinState.motion) === sheetMotionSignature(previousSheet.motion));
    clearSkinDom(canPreserveSheet);
    var seq = buildSeq;
    if (!candidate || candidate.renderer === 'builtin' || candidate.id === 'default') {
      buildLegacy();
      return;
    }
    if (!skinState || typeof skinState !== 'object') { degradeSkin(); return; }
    if (candidate.renderer === 'sprite-sheet') {
      buildSheet(candidate, skinState, seq, canPreserveSheet ? previousSheet : null);
      return;
    }
    if (candidate.renderer === 'layers') {
      buildLayers(candidate, skinState, seq);
      return;
    }
    degradeSkin();
  }

  // ── 播放控制 ────────────────────────────────────────────────────────────

  function shouldPlay() {
    // 桌宠设置里的动画开关是用户的显式选择；系统减少动态效果不再静默冻结桌宠。
    return !!state.settings.desktopPetAutoActions && !document.hidden;
  }

  function applySheetMotion(now) {
    if (!sprite || !sheetInfo || !sheetInfo.motion) {
      if (sprite) sprite.style.transform = '';
      return;
    }
    var motion = sheetInfo.motion;
    var period = Math.max(300, Number(motion.periodMs) || 1800);
    var phase = (Math.max(0, now) % period) / period * Math.PI * 2;
    var frameScale = sheetInfo.frameW > 0 ? sprite.clientWidth / sheetInfo.frameW : 1;
    var dx = (Number(motion.x) || 0) * frameScale * Math.sin(phase);
    var dy = (Number(motion.y) || 0) * frameScale * Math.sin(phase);
    var rotate = (Number(motion.rotate) || 0) * Math.sin(phase);
    var scale = 1 + (Number(motion.scale) || 0) * (0.5 - 0.5 * Math.cos(phase));
    sprite.style.transform = 'translate(' + dx.toFixed(2) + 'px,' + dy.toFixed(2) + 'px) rotate(' + rotate.toFixed(3) + 'deg) scale(' + scale.toFixed(4) + ')';
  }

  function tickSheetPlayback(now) {
    rafId = null;
    if (!sheetInfo || !sheetInfo.ready || !shouldPlay()) {
      sheetPlaybackStart = 0;
      sheetLastFrame = -1;
      sheetFinished = false;
      return;
    }
    if (!sheetPlaybackStart) sheetPlaybackStart = now || 1;
    var elapsed = Math.max(0, now - sheetPlaybackStart);
    var nextFrame = sheetFinished
      ? sheetInfo.frames - 1
      : Math.floor(elapsed * sheetInfo.fps / 1000);
    if (sheetInfo.loop) nextFrame %= sheetInfo.frames;
    else {
      nextFrame = Math.min(sheetInfo.frames - 1, nextFrame);
      if (nextFrame >= sheetInfo.frames - 1) sheetFinished = true;
    }
    if (nextFrame !== sheetLastFrame) {
      frameIndex = nextFrame;
      sheetLastFrame = nextFrame;
      applySheetFrame();
    }
    applySheetMotion(now);
    if (sheetInfo.loop || !sheetFinished || sheetInfo.motion) {
      rafId = requestAnimationFrame(tickSheetPlayback);
    }
  }

  function tickLayers(now) {
    rafId = null;
    if (!layerHasAnims || !shouldPlay()) {
      applyLayerStatic();
      syncPlayback();
      return;
    }
    if (!animStart) animStart = now;
    applyLayerTime(now - animStart);
    if (typeof requestAnimationFrame === 'function') {
      rafId = requestAnimationFrame(tickLayers);
    }
  }

  function syncPlayback() {
    if (layerHasAnims) {
      if (shouldPlay()) {
        if (rafId === null && typeof requestAnimationFrame === 'function') {
          rafId = requestAnimationFrame(tickLayers);
        }
        return;
      }
      if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
      rafId = null;
      animStart = 0;
      applyLayerStatic();
      return;
    }
    // sprite-sheet 与程序化连续动作共用一个 rAF 时间轴，避免 setTimeout 漂移。
    if (sheetInfo && sheetInfo.ready && shouldPlay()) {
      if (rafId === null && typeof requestAnimationFrame === 'function') {
        if (!sheetInfo.loop && sheetFinished && !sheetInfo.motion) return;
        if (!sheetPlaybackStart || sheetInfo.loop || !sheetFinished) {
          sheetPlaybackStart = 0;
          sheetLastFrame = -1;
          sheetFinished = false;
        }
        rafId = requestAnimationFrame(tickSheetPlayback);
      }
      return;
    }
    if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    rafId = null;
    animStart = 0;
    sheetPlaybackStart = 0;
    sheetLastFrame = -1;
    sheetFinished = false;
    if (sprite) sprite.style.transform = '';
    if (sheetInfo) {
      frameIndex = 0;
      applySheetFrame();
    }
    if (layerHasAnims) applyLayerStatic();
  }

  function updateMode() {
    var mode = resolveMode();
    var next = resolveSemanticState();
    var changed = false;
    if (mode !== currentMode) { currentMode = mode; changed = true; }
    if (next.key !== semanticState.key) {
      semanticState = { key: next.key, label: next.label || '', at: Date.now(), minHoldMs: next.minHoldMs || 0 };
      changed = true;
    }
    if (!changed) return false;
    frameIndex = 0;
    candidateIndex = 0;
    if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    rafId = null;
    animStart = 0;
    sheetPlaybackStart = 0;
    sheetLastFrame = -1;
    sheetFinished = false;
    skinSig = skinSignature();   // mode 是签名的一部分：这里手动重建并同步签名
    buildActive(true);
    return true;
  }

  // 状态行文案表（#6 做法①）：字面量集中一处；抽出前后输出必须逐字节一致
  var STATE_LINE_TEXT = { working: '干活中', idle: '发呆中', fallback: '发呆中' };

  function renderStateLine() {
    // 内置两个语义保持原文案；自定义状态优先用声明里的 label，没有就显示状态名
    if (semanticState.key === 'working') { setText(stateLine, STATE_LINE_TEXT.working); return; }
    if (semanticState.key === 'idle') { setText(stateLine, STATE_LINE_TEXT.idle); return; }
    setText(stateLine, semanticState.label || semanticState.key || STATE_LINE_TEXT.fallback);
  }

  function fitSprite() {
    if (!pet) return;
    if (skinStage) {
      var candidate = currentCandidate();
      var canvas = candidate && candidate.canvas ? candidate.canvas : null;
      var skinState = candidate && candidate.states ? candidate.states[modeStateKey()] : null;
      var c = (skinState && skinState.canvas) || canvas || { width: 128, height: 128 };
      fitSkinStage(Number(c.width) || 128, Number(c.height) || 128);
      return;
    }
    if (sheetInfo && !sheetInfo.legacy) {
      showLegacyElementForSheet(sheetInfo.url, sheetInfo.frameW / sheetInfo.frameH);
      return;
    }
    if (!sprite) return;
    var width = pet.clientWidth;
    var height = pet.clientHeight;
    var size = Math.min(width, height);
    if (!isFinite(size) || size <= 0) return;
    sprite.style.width = roundCssToDevicePixel(size) + 'px';
    sprite.style.height = roundCssToDevicePixel(size) + 'px';
  }

  function render() {
    applySize();
    renderUsage(state.status);
    renderMood(state.status);
    updateMode();
    renderStateLine();
    syncPlayback();
    fitSprite();
  }

  // ── ③ pet.actions：悬浮面板 ────────────────────────────────────────────
  // 复用已落地的 UI 插槽契约：provider.render(ctx) → HTML 字符串，
  // provider.bind(root, ctx) → cleanup；超时 + 世代号（seq）防迟到回调。
  // 与控制台插槽的差别只有 ctx：**桌宠版受限 ctx** 只给状态快照 + 白名单 DOM + close，
  // 不给 api / config / save 那套控制台能力。
  var OVERLAY_TIMEOUT_MS = 8000;
  var OVERLAY_HTML_MAX = 20000;
  var overlayHost = document.getElementById('overlay');
  var overlayState = { id: '', seq: 0, cleanup: null };
  var petActions = [];
  var overlayProviders = window.petOverlayProviders && typeof window.petOverlayProviders === 'object'
    ? window.petOverlayProviders
    : (window.petOverlayProviders = {});

  function nowMs() {
    return (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
  }

  function escText(value, limit) {
    var s = typeof value === 'string' ? value : String(value == null ? '' : value);
    return s.slice(0, limit || 64).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** 只给「状态快照」与 close —— 没有任何能改设置/发请求的入口。 */
  function petOverlayCtx() {
    var status = state.status && typeof state.status === 'object' ? state.status : {};
    var bot = status.botState && typeof status.botState === 'object' ? status.botState : {};
    var usage = status.usage && typeof status.usage === 'object' ? status.usage : {};
    return Object.freeze({
      signal: 'pet-overlay',
      close: closeOverlay,
      state: Object.freeze({
        working: status.working === true,
        mood: typeof bot.moodLabel === 'string' ? bot.moodLabel : '',
        energy: typeof bot.energyLabel === 'string' ? bot.energyLabel : '',
        tokens: Number(usage.totalTokens) || 0,
        runs: Number(usage.runs) || 0,
        skinId: state.skin && state.skin.id ? String(state.skin.id) : '',
        petState: semanticState.key
      })
    });
  }

  function setupOverlayHost() {
    if (!overlayHost) return;
    overlayHost.style.position = 'absolute';
    overlayHost.style.left = '8px';
    overlayHost.style.right = '8px';
    overlayHost.style.bottom = '32px';
    overlayHost.style.zIndex = '30';
    overlayHost.hidden = true;
    if (document.getElementById('pet-overlay-style')) return;
    var style = document.createElement('style');
    style.id = 'pet-overlay-style';
    // 样式走内联 <style>（pet.html 的 CSP style-src 含 'unsafe-inline'），不碰 pet.css
    style.textContent = '.pet-overlay__card{background:rgba(20,22,28,.92);color:#f2f4f8;border-radius:10px;padding:8px 10px;font-size:12px;line-height:1.5;box-shadow:0 6px 18px rgba(0,0,0,.35)}'
      + '.pet-overlay__title{font-weight:600;margin-bottom:4px}'
      + '.pet-overlay__meta{color:#9aa3b2;margin-bottom:4px}'
      + '.pet-overlay__line{display:flex;justify-content:space-between;gap:8px}'
      + '.pet-overlay__actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}'
      + '.pet-overlay__btn{font:inherit;font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid #3a4150;background:#22262f;color:#f2f4f8;cursor:pointer}';
    document.head.appendChild(style);
  }

  function closeOverlay() {
    overlayState.seq += 1;         // 世代号 +1：旧的/迟到的回调一律作废
    var cleanup = overlayState.cleanup;
    overlayState.cleanup = null;
    overlayState.id = '';
    if (typeof cleanup === 'function') {
      try { cleanup(); } catch (error) {
        console.warn('[desktop-pet] 面板 cleanup 抛错（已忽略）:', error && error.message ? error.message : error);
      }
    }
    if (overlayHost) {
      overlayHost.hidden = true;
      overlayHost.textContent = '';
    }
  }

  /** 声明式面板（零 JS 路径）：宿主按白名单 DOM 拼字符串，第三方值一律转义。 */
  function specProvider(spec) {
    return {
      render: function (ctx) {
        var s = ctx.state || {};
        var rows = ((spec && spec.lines) ? spec.lines : []).map(function (l) {
          return '<div class="pet-overlay__line"><span>' + escText(l.label, 16) + '</span><b>' + escText(l.value, 40) + '</b></div>';
        }).join('');
        var buttons = ((spec && spec.buttons) ? spec.buttons : []).map(function (b) {
          return '<button type="button" class="pet-overlay__btn" data-action="' + escText(b.action, 64) + '">'
            + escText(b.label || b.action, 16) + '</button>';
        }).join('');
        return '<div class="pet-overlay__card">'
          + ((spec && spec.title) ? '<div class="pet-overlay__title">' + escText(spec.title, 24) + '</div>' : '')
          + '<div class="pet-overlay__meta">皮肤 ' + escText(s.skinId, 32) + ' · 状态 ' + escText(s.petState, 24) + (s.working ? ' · 干活中' : '') + '</div>'
          + rows
          + '<div class="pet-overlay__actions">' + buttons + '<button type="button" class="pet-overlay__btn" data-action="__close">关闭</button></div>'
          + '</div>';
      },
      bind: function (root) {
        var onClick = function (event) {
          var el = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
          var id = el ? el.getAttribute('data-action') : '';
          if (!id) return;
          if (id === '__close') { closeOverlay(); return; }
          try {
            var p = api && typeof api.invokeAction === 'function' ? api.invokeAction(id) : null;
            if (p && typeof p.catch === 'function') p.catch(function () {});
          } catch (error) {
            console.warn('[desktop-pet] 面板按钮调用失败（已忽略）:', error && error.message ? error.message : error);
          }
        };
        root.addEventListener('click', onClick);
        return function () { root.removeEventListener('click', onClick); };
      }
    };
  }

  function dropOverlayRoot(root, id, reason) {
    if (root && root.parentNode) root.parentNode.removeChild(root);
    console.warn('[desktop-pet] 悬浮面板已卸载（' + reason + '）：' + id);
  }

  /** 打开一个面板：provider 优先，其次用声明式 spec；任何一步失败都只记日志。 */
  function openOverlay(action) {
    if (!overlayHost || !action || !action.id) return;
    closeOverlay();
    var seq = overlayState.seq;
    var provider = (overlayProviders && overlayProviders[action.id]) || (action.spec ? specProvider(action.spec) : null);
    if (!provider) { console.warn('[desktop-pet] 该动作没有可渲染的面板内容：' + action.id); return; }
    var root = document.createElement('div');
    overlayHost.appendChild(root);
    var started = nowMs();
    var html = '';
    try {
      html = provider.render(petOverlayCtx());
    } catch (error) {
      dropOverlayRoot(root, action.id, 'render 抛错：' + (error && error.message ? error.message : error));
      return;
    }
    if (typeof html !== 'string' || html.length > OVERLAY_HTML_MAX) {
      dropOverlayRoot(root, action.id, '内容不是字符串或超过 ' + OVERLAY_HTML_MAX + ' 字符');
      return;
    }
    // CSP 是这里的护栏：pet.html 的 script-src 只有 'self'（无 'unsafe-inline'），
    // 第三方 HTML 里的内联脚本/事件属性在本窗口里跑不起来。
    root.innerHTML = html;
    var cleanup = null;
    try {
      cleanup = provider.bind(root, petOverlayCtx());
    } catch (error) {
      root.innerHTML = '';
      dropOverlayRoot(root, action.id, 'bind 抛错：' + (error && error.message ? error.message : error));
      return;
    }
    if (seq !== overlayState.seq) {   // 期间又被关掉/重开过：这次结果作废
      if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
      root.innerHTML = '';
      dropOverlayRoot(root, action.id, '世代号已过期');
      return;
    }
    var elapsed = nowMs() - started;
    if (elapsed > OVERLAY_TIMEOUT_MS) {
      if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
      root.innerHTML = '';
      dropOverlayRoot(root, action.id, '渲染耗时 ' + Math.round(elapsed) + 'ms 超过 ' + OVERLAY_TIMEOUT_MS + 'ms 闸');
      return;
    }
    overlayState.id = action.id;
    overlayState.cleanup = typeof cleanup === 'function' ? cleanup : null;
    overlayHost.hidden = false;
  }

  function applyPetActions(list) {
    var normalized = PET_CONTRACT.normalizePetActions(list, '');
    if (normalized.problems.length) {
      console.warn('[desktop-pet] pet.actions 声明有问题（坏项已跳过）：' + normalized.problems.join('；'));
    }
    petActions = normalized.actions;
  }

  function findAction(id) {
    for (var i = 0; i < petActions.length; i++) {
      if (petActions[i].id === id) return petActions[i];
    }
    return null;
  }

  // 皮肤渲染链签名：skin/fallbackSkin/资源 base/旧图 URL/mode 任一变化才重建 DOM，
  // 避免 /api/status 轮询高频推送时反复重建导致闪烁。
  var skinSig = '';
  function skinSignature() {
    return [
      state.skin ? state.skin.id : '',
      state.fallbackSkin ? state.fallbackSkin.id : '',
      state.assetRoot,
      state.legacy ? state.legacy.idle : '',
      state.legacy ? state.legacy.work : '',
      currentMode,
      semanticState.key
    ].join('|');
  }

  function onSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    if (snapshot.settings && typeof snapshot.settings === 'object') {
      var next = snapshot.settings;
      if ('desktopPetSize' in next) state.settings.desktopPetSize = next.desktopPetSize;
      if ('desktopPetAutoActions' in next) state.settings.desktopPetAutoActions = !!next.desktopPetAutoActions;
      if ('desktopPetShowUsage' in next) state.settings.desktopPetShowUsage = !!next.desktopPetShowUsage;
      if ('desktopPetShowMood' in next) state.settings.desktopPetShowMood = !!next.desktopPetShowMood;
      if ('desktopPetSkin' in next) state.settings.desktopPetSkin = String(next.desktopPetSkin || '');
    }
    if (snapshot.status && typeof snapshot.status === 'object') {
      state.status = snapshot.status;
    }
    if ('skin' in snapshot) state.skin = snapshot.skin || null;
    if ('fallbackSkin' in snapshot) state.fallbackSkin = snapshot.fallbackSkin || null;
    if ('assetRoot' in snapshot) state.assetRoot = typeof snapshot.assetRoot === 'string' ? snapshot.assetRoot : '';
    if ('legacy' in snapshot && snapshot.legacy && typeof snapshot.legacy === 'object') state.legacy = snapshot.legacy;
    // 语义状态规则（②）：主进程/皮肤提供的规则表，纯数据，宿主求值
    if ('stateRules' in snapshot && Array.isArray(snapshot.stateRules)) state.stateRules = snapshot.stateRules;

    // 皮肤相关字段或状态变化 → 从链头重建（加载失败再逐级回退）
    var sig = skinSignature();
    if (sig !== skinSig) {
      skinSig = sig;
      candidateIndex = 0;
      buildActive();
    }
    render();
  }

  if (api && typeof api.onSnapshot === 'function') {
    try {
      api.onSnapshot(onSnapshot);
    } catch (error) {
      console.warn('[desktop-pet] onSnapshot 注册失败:', error && error.message ? error.message : error);
    }
  }

  setupOverlayHost();

  // pet.actions（③）：主进程聚合好的动作清单；开面板由主进程点名（pet:overlay）
  if (api && typeof api.onActions === 'function') {
    try {
      api.onActions(function (list) {
        try { applyPetActions(list); } catch (error) {
          console.warn('[desktop-pet] pet.actions 应用失败（已忽略）:', error && error.message ? error.message : error);
        }
      });
    } catch (error) {
      console.warn('[desktop-pet] onActions 注册失败:', error && error.message ? error.message : error);
    }
  }
  if (api && typeof api.onOverlay === 'function') {
    try {
      api.onOverlay(function (payload) {
        try {
          var id = payload && typeof payload.id === 'string' ? payload.id : '';
          if (!id) return;
          var action = findAction(id);
          if (!action && payload && payload.spec) action = { id: id, label: id, place: 'overlay', spec: payload.spec };
          if (action) openOverlay(action);
        } catch (error) {
          console.warn('[desktop-pet] 打开悬浮面板失败（已忽略）:', error && error.message ? error.message : error);
        }
      });
    } catch (error) {
      console.warn('[desktop-pet] onOverlay 注册失败:', error && error.message ? error.message : error);
    }
  }

  document.addEventListener('visibilitychange', function () {
    syncPlayback();
  });

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('resize', fitSprite);
  }

  if (typeof window.ResizeObserver === 'function' && pet) {
    try {
      var resizeObserver = new window.ResizeObserver(function () {
        fitSprite();
      });
      resizeObserver.observe(pet);
    } catch (error) {
      console.warn('[desktop-pet] ResizeObserver 注册失败:', error && error.message ? error.message : error);
    }
  }

  buildLegacy();
  skinSig = skinSignature();
  renderStateLine();
  syncPlayback();
  fitSprite();
}

// 浏览器里才跑主体；node require 本文件时只拿上面的 PET_CONTRACT 做契约断言。
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  __petMain();
}
