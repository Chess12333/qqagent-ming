/**
 * pet.actions / 语义状态规则的**声明校验**（主进程侧的唯一入口）。
 *
 * 为什么单独成文件：这是第三方动作进入主进程的**安全边界**（每来源 12 动作 / 8 规则 /
 * 16 来源的上限、slug / label / place 白名单、值域裁剪），但原来它埋在 electron/main.js
 * 里——那里 `import 'electron'`，node 起不来，所以**一行都测不到**，只能靠真机眼验。
 * 现在这里**不 import 任何 electron 模块**，纯数据进纯数据出，node 可以直接 import 做断言
 * （见 test/pet-sanitize-test.mjs）。
 *
 * 抽取原则：**行为一字不变**（同样的输入 → 同样的输出与 problems），只换了存放位置；
 * 抽取前后的行为对照用输入矩阵逐条跑过，见测试脚本里的对照注释。
 *
 * 与桌宠窗口里的 PET_CONTRACT（./pet-renderer.js）是**同一份契约的两处实现**：
 * 信任边界不同（这里是 IPC 入口，那里是挂载前），所以两边各自校验一次。
 * 两边没法在运行时共用一份常量（pet.html 以普通 <script> 加载渲染端，没有模块加载器），
 * 因此改用**行为级防漂移**：test/pet-sanitize-test.mjs 拿同一批输入喂两边，要求
 * 截断上限与白名单判定**结果完全一致**，一旦某处改了阈值而另一处没跟上，测试立刻红。
 */
export const PET_ACTION_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const PET_ACTIONS_PER_SOURCE = 12;
export const PET_RULES_PER_SOURCE = 8;
export const PET_ACTION_SOURCES_MAX = 16;

/** 值域裁剪：非字符串一律空串，其余去首尾空格后截断（不转义——转义是渲染端的事）。 */
export function petText(value, limit) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, limit);
}

export function sanitizePetActionSpec(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const spec = { title: petText(raw.title, 24), lines: [], buttons: [] };
  for (const line of Array.isArray(raw.lines) ? raw.lines.slice(0, 8) : []) {
    if (!line || typeof line !== 'object') continue;
    spec.lines.push({ label: petText(line.label, 16), value: petText(line.value, 40) });
  }
  for (const btn of Array.isArray(raw.buttons) ? raw.buttons.slice(0, 4) : []) {
    if (!btn || typeof btn !== 'object') continue;
    const action = petText(btn.action, 64);
    if (!PET_ACTION_SLUG.test(action)) continue;
    spec.buttons.push({ label: petText(btn.label, 16), action });
  }
  return spec;
}

/** pet.actions 声明校验：只认 { id, label, place }，坏项丢弃并记 problems。 */
export function sanitizePetActions(raw, sourceId) {
  const problems = [];
  const actions = [];
  for (const item of Array.isArray(raw) ? raw.slice(0, PET_ACTIONS_PER_SOURCE) : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { problems.push('存在非对象动作，已跳过'); continue; }
    const id = petText(item.id, 64);
    const label = petText(item.label, 24);
    const place = petText(item.place, 16);
    if (!PET_ACTION_SLUG.test(id)) { problems.push(`id 非法（需小写 slug）：${id || '空'}`); continue; }
    if (!label) { problems.push(`${id} 缺 label（必填，≤24 字符）`); continue; }
    if (place !== 'context-menu' && place !== 'overlay') { problems.push(`${id}.place 必须是 context-menu 或 overlay`); continue; }
    if (actions.some((a) => a.id === id)) { problems.push(`id 重复：${id}`); continue; }
    actions.push({ id, label, place, source: sourceId, spec: sanitizePetActionSpec(item.spec) });
  }
  return { actions, problems };
}

/** 语义状态规则校验（②）：只留「信号白名单 + 操作白名单」能解释的条件，坏项丢弃。 */
export const PET_RULE_SIGNALS = new Set(['working', 'hour', 'weekday', 'mood', 'energy', 'tokens', 'runs']);
export const PET_RULE_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'includes', 'between']);

export function sanitizePetStateRules(raw) {
  const problems = [];
  const rules = [];
  for (const item of Array.isArray(raw) ? raw.slice(0, PET_RULES_PER_SOURCE) : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { problems.push('存在非对象规则，已跳过'); continue; }
    const state = petText(item.state, 64);
    const when = item.when && typeof item.when === 'object' && !Array.isArray(item.when) ? item.when : null;
    const signal = when ? petText(when.signal, 32) : '';
    const op = when ? petText(when.op, 16) : '';
    if (!PET_ACTION_SLUG.test(state)) { problems.push(`规则 state 非法（需小写 slug）：${state || '空'}`); continue; }
    if (!PET_RULE_SIGNALS.has(signal)) { problems.push(`规则 ${state} 的 signal 不在白名单：${signal || '空'}`); continue; }
    if (!PET_RULE_OPS.has(op)) { problems.push(`规则 ${state} 的 op 不在白名单：${op || '空'}`); continue; }
    rules.push({
      state,
      label: petText(item.label, 24),
      priority: Number.isFinite(Number(item.priority)) ? Math.round(Number(item.priority)) : 0,
      minHoldMs: Math.max(0, Math.min(600000, Number(item.minHoldMs) || 0)),
      when: { signal, op, value: when.value }
    });
  }
  return { rules, problems };
}
