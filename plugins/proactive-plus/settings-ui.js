// 更好的主动聊天插件 · 设置页
//
// 宿主用 /plugin-assets/proactive-plus/settings-ui.js 取回本模块，
// 在「设置 → 更好的主动聊天插件」里渲染。只写 data/config.json 的
// skills.proactive-plus；不写插件目录。
import {
  normalizeConfig,
  configForSave,
  parseHHMM,
  formatHHMM,
  isQuietAt,
  quietWindowText,
  anyShareEnabled
} from './logic.js';

const PLUGIN_ID = 'proactive-plus';
const VERSION = '1.0.0';

let state = null;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}[ch]));

const attr = (value) => esc(value).replace(/\n/g, '&#10;');

const QUIET_KEY_LABELS = {
  enabled: '群聊主动',
  privateIdleEnabled: '私聊冷场主动',
  privateScheduleEnabled: '私聊定时'
};

async function safeApi(ctx, url) {
  try {
    return await ctx.api(url);
  } catch (error) {
    return { __error: String(error?.message || error) };
  }
}

async function loadSkill(ctx) {
  const result = await safeApi(ctx, '/api/skills');
  const skills = Array.isArray(result?.skills) ? result.skills : [];
  return {
    skill: skills.find((item) => item?.id === PLUGIN_ID) || null,
    error: result?.__error || ''
  };
}

function makeState(ctx, skill, error) {
  const stored = skill?.settings && typeof skill.settings === 'object'
    ? skill.settings
    : (typeof ctx.config === 'function' ? ctx.config() : {});
  const config = normalizeConfig(stored);
  return {
    ctx,
    config,
    skill,
    quietSession: stored?.quietSession && typeof stored.quietSession === 'object' ? stored.quietSession : null,
    enabled: skill?.enabled === true,
    active: skill?.active === true,
    reason: skill?.reason || '',
    loadError: skill?.loadError || '',
    fetchError: error || '',
    dirty: false,
    busy: false,
    message: '',
    messageKind: ''
  };
}

// ── 渲染 ─────────────────────────────────────────────────────────────────

export async function render(ctx) {
  const result = await loadSkill(ctx);
  state = makeState(ctx, result.skill, result.error);
  return bodyHtml(state);
}

function bodyHtml(s) {
  return `
  <style>${CSS}</style>
  <div class="pp-wrap">
    ${headerHtml(s)}
    ${messageHtml(s)}
    ${quietSection(s)}
    ${capsSection(s)}
    ${shareSection(s)}
    ${footerHtml(s)}
  </div>`;
}

function headerHtml(s) {
  const statusText = s.loadError ? '加载失败'
    : !s.enabled ? '已关闭'
      : s.active ? '生效中' : '已启用';
  const statusClass = s.loadError ? 'bad' : !s.enabled ? 'off' : s.active ? 'ok' : 'warn';
  const toggle = s.enabled
    ? '<button type="button" class="btn btn-small" data-pp-action="toggle">关闭</button>'
    : '<button type="button" class="btn btn-small btn-primary" data-pp-action="toggle">启用</button>';
  const shell = s.quietSession?.active === true
    ? `<div class="pp-banner">当前处于静音时段：核心 proactive 已被临时关闭${quietKeysText(s.quietSession.applied)}；到 ${esc(s.config.quietEnd)} 恢复。你夜里手动改过的键不会被覆盖。</div>`
    : '';
  return `
  <div class="pp-head">
    <div class="pp-head-main">
      <h3>更好的主动聊天插件 <span class="pp-ver">v${VERSION}</span></h3>
      <p class="hint">夜间静音、主动发言额度，以及可选分享 B站视频 / 歌 / 网页链接。B站视频会发成封面图 + 标题链接。</p>
    </div>
    <div class="pp-head-side">
      <span class="pp-status ${statusClass}">${esc(statusText)}</span>
      ${toggle}
    </div>
  </div>
  ${s.loadError ? `<div class="pp-err">插件加载失败：${esc(s.loadError)}</div>` : ''}
  ${!s.loadError && s.enabled && !s.active && s.reason ? `<div class="pp-warn">当前不可用：${esc(s.reason)}</div>` : ''}
  ${s.fetchError ? `<div class="pp-warn">读取状态失败：${esc(s.fetchError)}</div>` : ''}
  ${shell}`;
}

function quietKeysText(applied) {
  if (!applied || typeof applied !== 'object') return '';
  const keys = Object.keys(applied).filter((key) => applied[key] === false);
  if (!keys.length) return '';
  return `（${keys.map((key) => QUIET_KEY_LABELS[key] || key).join('、')}）`;
}

function messageHtml(s) {
  const cls = s.message ? ` ${s.messageKind || 'ok'}` : '';
  return `<div id="pp-msg" class="pp-msg${cls}"${s.message ? '' : ' hidden'}>${esc(s.message)}</div>`;
}

function quietSection(s) {
  const c = s.config;
  const now = Date.now();
  const quietNow = isQuietAt(c, now);
  return `
  <section class="pp-sec">
    <div class="pp-sec-head">
      <h3>夜间静音</h3>
      <span class="pp-pill ${quietNow ? 'on' : ''}">${quietNow ? '现在处于静音时段' : '现在可主动'}</span>
    </div>
    <label class="pp-check">
      <input type="checkbox" data-pp-path="quietEnabled" data-pp-type="bool"${c.quietEnabled ? ' checked' : ''} />
      启用夜间静音
    </label>
    <div class="pp-grid2">
      <div class="form-field">
        <label>开始</label>
        <input type="time" data-pp-path="quietStart" value="${attr(c.quietStart)}" />
      </div>
      <div class="form-field">
        <label>结束（次日）</label>
        <input type="time" data-pp-path="quietEnd" value="${attr(c.quietEnd)}" />
      </div>
    </div>
    <div class="hint">当前窗口：${esc(quietWindowText(c))}。进入静音时，插件会临时把核心的
      <code>proactive.enabled</code>、<code>privateIdleEnabled</code>、<code>privateScheduleEnabled</code>
      写成 false（连唤醒一起停）；早上恢复。只在当前值仍是我们写的 false 时才恢复，
      你夜里手动改过就不会覆盖。</div>
  </section>`;
}

function capsSection(s) {
  const c = s.config;
  return `
  <section class="pp-sec">
    <div class="pp-sec-head"><h3>主动发言额度</h3></div>
    <label class="pp-check">
      <input type="checkbox" data-pp-path="capEnabled" data-pp-type="bool"${c.capEnabled ? ' checked' : ''} />
      启用主动发言额度
    </label>
    <div class="pp-grid3">
      <div class="form-field">
        <label>两次最小间隔（分钟）</label>
        <input type="number" min="0" max="1440" step="1" data-pp-path="minIntervalMin" data-pp-type="number" value="${attr(c.minIntervalMin)}" />
      </div>
      <div class="form-field">
        <label>每天最多几次</label>
        <input type="number" min="0" max="50" step="1" data-pp-path="maxPerDay" data-pp-type="number" value="${attr(c.maxPerDay)}" />
      </div>
      <div class="form-field">
        <label>同一轮最多几条</label>
        <input type="number" min="1" max="5" step="1" data-pp-path="maxPerRound" data-pp-type="number" value="${attr(c.maxPerRound)}" />
      </div>
    </div>
    <div class="hint">0 = 不限（单轮上限除外）。额度只作用于主动轮；日常聊天回复不占主动额度。
      同一轮里第一条发送才算一次主动，后面同轮最多补到“同一轮最多几条”。</div>
  </section>`;
}

function shareSection(s) {
  const c = s.config;
  return `
  <section class="pp-sec">
    <div class="pp-sec-head">
      <h3>分享内容</h3>
      <span class="pp-pill ${anyShareEnabled(c) ? 'on' : ''}">${anyShareEnabled(c) ? '已允许部分类型' : '全部关闭'}</span>
    </div>
    <p class="hint">默认全关。开启后，模型会先筛“值不值得占用对方一次注意力”，再决定发不发；没有额外小模型调用。</p>
    <div class="pp-checks">
      <label class="pp-check"><input type="checkbox" data-pp-path="allowBilibili" data-pp-type="bool"${c.allowBilibili ? ' checked' : ''} /> B站视频</label>
      <label class="pp-check"><input type="checkbox" data-pp-path="allowMusic" data-pp-type="bool"${c.allowMusic ? ' checked' : ''} /> 歌</label>
      <label class="pp-check"><input type="checkbox" data-pp-path="allowLink" data-pp-type="bool"${c.allowLink ? ' checked' : ''} /> 网页链接</label>
    </div>
    <div class="hint">B站开启后，<code>send_bilibili</code> 会被改成“封面图 + 标题链接”发送，不再发 QQ 卡片；
      歌走 <code>search_music</code> → <code>send_music</code>；网页走 <code>web_search</code>/<code>fetch_web</code> →
      <code>send_message</code> 带链接。关掉后只拦主动轮（机器人不会自己发）；你点名要时仍会发——B站仍会改成标题+链接。</div>
    <div class="pp-grid2">
      <div class="form-field">
        <label>两次主动分享最小间隔（分钟）</label>
        <input type="number" min="0" max="10080" step="1" data-pp-path="shareMinIntervalMin" data-pp-type="number" value="${attr(c.shareMinIntervalMin)}" />
      </div>
      <div class="form-field">
        <label>每天最多主动分享几次</label>
        <input type="number" min="0" max="20" step="1" data-pp-path="shareMaxPerDay" data-pp-type="number" value="${attr(c.shareMaxPerDay)}" />
      </div>
    </div>
    <div class="form-field">
      <label>自己的筛选口径（可选，追加在内置规则后面）</label>
      <textarea rows="3" maxlength="1200" data-pp-path="shareCriteria" placeholder="例如：只发和编程/猫有关的；不发动漫剪辑；同一位 UP 主一周内不重复。">${esc(c.shareCriteria)}</textarea>
    </div>
  </section>`;
}

function footerHtml(s) {
  return `
  <div class="pp-footer">
    <button type="button" class="btn btn-primary" id="pp-save" data-pp-action="save">保存设置</button>
    <span class="pp-muted">保存后下一条消息生效；不会写插件目录。</span>
    <span id="pp-dirty" class="pp-dirty"${s.dirty ? '' : ' hidden'}>有未保存改动</span>
  </div>`;
}

// ── 状态 ─────────────────────────────────────────────────────────────────

function writePath(target, path, value) {
  const parts = String(path || '').split('.').filter(Boolean);
  if (!parts.length) return;
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (cursor[key] === null || cursor[key] === undefined) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

function valueOf(el) {
  const type = el.getAttribute('data-pp-type') || 'string';
  if (type === 'bool') return Boolean(el.checked);
  if (type === 'number') return Number(el.value);
  return String(el.value);
}

function syncOne(el) {
  const path = el.getAttribute('data-pp-path');
  if (!path) return;
  writePath(state.config, path, valueOf(el));
}

function syncFromDom(root) {
  for (const el of root.querySelectorAll('[data-pp-path]')) syncOne(el);
}

function markDirty(root) {
  if (!state) return;
  state.dirty = true;
  try { state.ctx.setUnsavedChanges?.(true); } catch { /* ignore */ }
  const button = root.querySelector('#pp-save');
  if (button) button.classList.add('is-dirty');
  const pill = root.querySelector('#pp-dirty');
  if (pill) pill.hidden = false;
}

function setMessage(root, text, kind = 'ok') {
  if (!state) return;
  state.message = String(text || '');
  state.messageKind = kind;
  const el = root.querySelector('#pp-msg');
  if (!el) return;
  el.hidden = !state.message;
  el.className = `pp-msg${state.message ? ` ${kind}` : ''}`;
  el.textContent = state.message;
}

function captureOpen(root) {
  return new Set([...root.querySelectorAll('details[data-pp-key][open]')]
    .map((el) => el.getAttribute('data-pp-key'))
    .filter(Boolean));
}

function restoreOpen(root, open) {
  if (!open || !open.size) return;
  for (const el of root.querySelectorAll('details[data-pp-key]')) {
    if (open.has(el.getAttribute('data-pp-key'))) el.open = true;
  }
}

function renderBodyInPlace(root) {
  if (!state) return;
  const open = captureOpen(root);
  let y = 0;
  try { y = window.scrollY || 0; } catch { /* ignore */ }
  root.innerHTML = bodyHtml(state);
  restoreOpen(root, open);
  try { window.scrollTo(0, y); } catch { /* ignore */ }
}

function validate(config) {
  const errors = [];
  if (parseHHMM(config.quietStart) == null) errors.push('静音开始时间不合法（HH:MM）');
  if (parseHHMM(config.quietEnd) == null) errors.push('静音结束时间不合法（HH:MM）');
  if (parseHHMM(config.quietStart) != null && parseHHMM(config.quietStart) === parseHHMM(config.quietEnd)) {
    errors.push('静音开始和结束不能相同（相同 = 不静音）');
  }
  return errors;
}

async function doSave(root) {
  syncFromDom(root);
  const errors = validate(state.config);
  if (errors.length) {
    setMessage(root, errors[0], 'err');
    renderBodyInPlace(root);
    return;
  }
  const patch = configForSave(state.config);
  const result = await state.ctx.save(patch);
  if (result?.ok === false) throw new Error(result?.error || '保存失败');
  state.config = normalizeConfig(result?.settings || patch);
  state.dirty = false;
  try { state.ctx.setUnsavedChanges?.(false); } catch { /* ignore */ }
  await refreshSkill();
  setMessage(root, '已保存。下一条消息生效。', 'ok');
  renderBodyInPlace(root);
}

async function refreshSkill() {
  const result = await loadSkill(state.ctx);
  if (result.skill) {
    state.skill = result.skill;
    state.enabled = result.skill.enabled === true;
    state.active = result.skill.active === true;
    state.reason = result.skill.reason || '';
    state.loadError = result.skill.loadError || '';
    state.fetchError = result.error || '';
    const settings = result.skill.settings && typeof result.skill.settings === 'object' ? result.skill.settings : {};
    state.quietSession = settings.quietSession && typeof settings.quietSession === 'object' ? settings.quietSession : state.quietSession;
  } else if (result.error) {
    state.fetchError = result.error;
  }
}

async function doToggle(root) {
  if (state.dirty) {
    await doSave(root);
    if (state.dirty) return;
  }
  const next = !state.enabled;
  await state.ctx.setEnabled(next);
  await refreshSkill();
  setMessage(root, next ? '已启用。' : '已关闭。', 'ok');
  renderBodyInPlace(root);
}

export function bind(root, ctx) {
  if (!state || state.ctx !== ctx) state = makeState(ctx, null, '设置页状态未初始化，请刷新页面');

  const onClick = (event) => {
    const actionEl = event.target.closest('[data-pp-action]');
    if (!actionEl || !root.contains(actionEl) || state.busy) return;
    event.preventDefault();
    const action = actionEl.getAttribute('data-pp-action');
    if (action === 'save') {
      state.busy = true;
      doSave(root)
        .catch((error) => {
          setMessage(root, `保存失败：${error?.message || error}`, 'err');
          renderBodyInPlace(root);
        })
        .finally(() => { state.busy = false; });
      return;
    }
    if (action === 'toggle') {
      state.busy = true;
      doToggle(root)
        .catch((error) => {
          setMessage(root, `切换失败：${error?.message || error}`, 'err');
          renderBodyInPlace(root);
        })
        .finally(() => { state.busy = false; });
    }
  };

  const onChange = (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !root.contains(target)) return;
    if (!target.hasAttribute('data-pp-path')) return;
    syncOne(target);
    markDirty(root);
    if (target.matches('input[type="checkbox"]')) renderBodyInPlace(root);
  };

  const onInput = (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !root.contains(target)) return;
    if (!target.hasAttribute('data-pp-path')) return;
    if (target.matches('input[type="checkbox"]')) return;
    syncOne(target);
    markDirty(root);
  };

  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
    root.removeEventListener('input', onInput);
  };
}

export function read() {
  return null;
}

export function hasUnsavedChanges() {
  return state?.dirty === true;
}

// ── 样式 ─────────────────────────────────────────────────────────────────
const CSS = `
.pp-wrap { max-width: 980px; }
.pp-head { display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; margin-bottom: 12px; }
.pp-head h3 { margin: 0 0 4px; }
.pp-head-side { display: flex; align-items: center; gap: 8px; }
.pp-ver { font-size: 12px; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 1px 7px; vertical-align: middle; }
.pp-status { font-size: 12.5px; border-radius: 999px; padding: 3px 9px; border: 1px solid var(--border); }
.pp-status.ok { color: var(--green, #2e7d32); border-color: currentColor; }
.pp-status.warn { color: var(--orange, #b26a00); border-color: currentColor; }
.pp-status.off { color: var(--muted); }
.pp-status.bad { color: var(--red, #c62828); border-color: currentColor; }
.pp-msg { margin: 10px 0; padding: 8px 12px; border-radius: 8px; font-size: 13px; border: 1px solid var(--border); background: var(--inset-bg, rgba(127,127,127,.06)); }
.pp-msg.ok { border-left: 3px solid var(--green, #2e7d32); }
.pp-msg.err { border-left: 3px solid var(--red, #c62828); color: var(--red, #c62828); }
.pp-err, .pp-warn, .pp-banner { margin: 8px 0; padding: 8px 12px; border-radius: 8px; font-size: 13px; border: 1px solid var(--border); }
.pp-err { border-left: 3px solid var(--red, #c62828); color: var(--red, #c62828); }
.pp-warn { border-left: 3px solid var(--orange, #b26a00); color: var(--orange, #b26a00); }
.pp-banner { border-left: 3px solid var(--orange, #b26a00); background: var(--inset-bg, rgba(127,127,127,.06)); color: var(--muted); line-height: 1.6; }
.pp-sec { border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; margin: 14px 0; }
.pp-sec h3 { margin: 0 0 6px; font-size: 15px; }
.pp-sec-head { display: flex; align-items: center; gap: 10px; justify-content: space-between; }
.pp-wrap .hint { font-size: 12px; color: var(--muted); line-height: 1.6; margin: 6px 0; }
.pp-wrap code { font-size: 11.5px; }
.pp-grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.pp-grid3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
@media (max-width: 760px) { .pp-grid2, .pp-grid3 { grid-template-columns: 1fr; } }
.pp-wrap .form-field { margin: 8px 0; }
.pp-wrap .form-field > label { display: block; font-size: 12.5px; color: var(--muted); margin-bottom: 4px; }
.pp-wrap .form-field input, .pp-wrap .form-field textarea { width: 100%; box-sizing: border-box; }
.pp-wrap textarea { font-family: inherit; resize: vertical; }
.pp-check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; margin: 6px 0; cursor: pointer; }
.pp-checks { display: flex; gap: 18px; flex-wrap: wrap; }
.pp-pill { font-size: 11.5px; border-radius: 999px; padding: 1px 8px; border: 1px solid var(--border); color: var(--muted); }
.pp-pill.on { color: var(--green, #2e7d32); border-color: currentColor; }
.pp-muted { font-size: 12px; color: var(--muted); }
.pp-footer { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 18px 0 8px; padding-top: 12px; border-top: 1px solid var(--border); position: sticky; bottom: 0; background: var(--bg, transparent); }
.pp-footer .btn.is-dirty { box-shadow: 0 0 0 2px var(--orange, #b26a00) inset; }
.pp-dirty { font-size: 12px; color: var(--orange, #b26a00); }
`;
