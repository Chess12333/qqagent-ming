// Skill 配置读写：所有 Skill 开关的唯一入口。
//
// 核心原则（防止"多个开关打架"）：
//   1. Skill 的启用状态**只**存在 config.skills[id].enabled 一处；
//      模块不允许再维护 config.xxx.enabled 之类的影子开关。
//   2. 旧配置里的历史字段（如 api.vision、webSearch.enabled）仍然由各自模块读取
//      （它们是"功能开关"，不是"Skill 开关"），但 Skill 自己不再复制一份。
//   3. 读取时用 manifest.settings 作为默认值补齐，保证 Skill 侧拿到的配置形状稳定。

// 搬运改动（第 10 行 import 之外仅此一处注释，无行为）：
//   原 `../config.js` 的 getConfig() / updateConfig(patch) 由 M1 core/config-store 承接。
//   这里刻意**没有**改动读取写法，是因为本文件是 Skill 开关的唯一入口，
//   行为必须与 src/ 完全一致（搬运任务硬规则：行为零变化）。
//   对应 M1 需要满足的两点（详见回执「未决/需 M1 承接」）：
//     · get('skills.<id>', undefined) 未 load() 也要能直接读盘，且不得把非法点路径静默归一；
//     · set('skills.<id>', value, { scope: 'global' }) 写入后 get('skills.<id>') 立即可读。
//
// ★ 2026-10-09 N44 登记的**故意偏离**（只动 import 绑定名，下面每一行逻辑与 src/ 逐字相同）：
//   上面那两点 M1 都满足了（实测：未 load() 也能读、写后立即可读、深合并不吃掉别的技能键）。
//   但还差第三点，而且它是**行为差异**：老树 `src/config.js:1551-1553` 的 `updateConfig(patch)`
//   **自己就落盘**（写 `<DATA_DIR>/config.json.tmp` 再改名）；M1 把它拆成了两个出口 ——
//     · `updateConfig(patch)`        = 只改内存（core/config-store/index.js:310-324）
//     · `updateConfigAndSave(patch)` = 改 + 原子落盘 + .bak（同文件 :441，返回 {file,bytes,changed,backedUp,config}）
//   M1 自己的文档就把话说明了（:435）：「UI 的 POST /api/config、**skill 开关**这类"用户点了就要
//   生效并留存"的路径走这里」。而本文件照原样 import 了不落盘的那个 ⇒
//   **用户在面板上开/关技能、改技能设置（含各技能自己的 API Key），重启后全部回到旧值**，
//   而且没有任何报错：`setSkillConfig` 返回的是内存里的新值，当轮看起来完全生效。
//   ⇒ 用 import 别名把**落盘版**绑回原名 `updateConfig`，逻辑行一字不改就恢复老树语义。
//   这处别名在 selftest.mjs 的 FIDELITY 白名单里登记为 `symbolAliases`（不登记就红），
//   以免将来有人当成笔误"修"回去。
//   ⚠ 唯一的形状差：落盘版返回 `{…, config}` 而不是配置对象本身，所以第 47 行
//     `cfg.skills?.[key] || next` 会走到 `|| next` 那一支。`next` = 该技能原有配置（已含
//     DEFAULT_CONFIG 的默认值，因为它读自 getConfig()）浅合并本次 patch，与老树返回的
//     `currentConfig.skills[key]` 等价；这里保持逻辑行不动，不做"顺手优化"。
import { getConfig, updateConfigAndSave as updateConfig } from '../../../core/config-store/index.js';

/** 取某个 Skill 的配置对象（已与 manifest 默认值合并）。 */
export function getSkillConfig(id, defaults = {}) {
  const raw = getConfig()?.skills?.[String(id)];
  const merged = { ...(defaults || {}) };
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (v !== undefined) merged[k] = v;
    }
  }
  return merged;
}

/**
 * Skill 是否被用户开启。
 * 未配置过时回退到 manifest 的 enabledByDefault（默认 true）。
 */
export function isSkillEnabledInConfig(id, enabledByDefault = true) {
  const raw = getConfig()?.skills?.[String(id)];
  if (!raw || raw.enabled === undefined) return enabledByDefault !== false;
  return raw.enabled !== false;
}

/** 写入某个 Skill 的配置（浅合并进该 Skill 的命名空间）。 */
export function setSkillConfig(id, patch) {
  const key = String(id);
  const current = getConfig()?.skills?.[key];
  const next = { ...(current && typeof current === 'object' ? current : {}), ...(patch || {}) };
  const cfg = updateConfig({ skills: { [key]: next } });
  return cfg.skills?.[key] || next;
}

/** 只切开关，保留该 Skill 的其它配置。 */
export function setSkillEnabled(id, enabled) {
  return setSkillConfig(id, { enabled: !!enabled });
}

/** 当前配置里已存在的 Skill 配置键（用于 UI 显示"已配置但未安装"的 Skill）。 */
export function listConfiguredSkillIds() {
  const skills = getConfig()?.skills;
  if (!skills || typeof skills !== 'object') return [];
  return Object.keys(skills);
}
