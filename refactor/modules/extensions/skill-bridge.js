// 扩展底座桥接：在 0.2 架构上接 skills/plugins，不换核心。
// plugin-loader 懒加载：tools.js 引本文件时不会立刻拖进 500 行加载器。

import { skillManager } from './skills/manager.js';
import { listTools as listSkillTools } from '../act/index.js';
import { setSkillConfig, isSkillEnabledInConfig } from './skills/config.js';

export { skillManager };

let loadedOnce = false;
let pluginLoader = null;

async function ensureLoader() {
  if (!pluginLoader) {
    pluginLoader = await import('./plugin-loader.js');
  }
  return pluginLoader;
}

/** Explicit roots win; optional env overrides keep the repository defaults untouched. */
function resolveExtensionRoots(roots = null) {
  const pick = (explicit, envName) => {
    if (typeof explicit === 'string' && explicit.trim()) return explicit;
    const fromEnv = process.env[envName];
    return typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv : null;
  };
  const skills = pick(roots?.skills, 'QQ_AGENT_SKILLS_DIR');
  const plugins = pick(roots?.plugins, 'QQ_AGENT_PLUGINS_DIR');
  return skills || plugins ? { skills, plugins } : null;
}

/**
 * 启动时扫 skills/ + plugins/。幂等。
 * @param {{log?:Function, context?:()=>object, roots?:{skills?:string,plugins?:string}}} opts
 *   context：激活时递给插件的"外部世界"（sender/orchestrator/config…），
 *   由 app.js 提供；不传就是 `{}`（与 0.4 行为一致，只是那类插件发不出消息）。
 */
export async function initExtensions({ log = console.log, context = null, roots: rootsOpt = null } = {}) {
  try {
    const { loadPlugins } = await ensureLoader();
    const roots = resolveExtensionRoots(rootsOpt);
    const result = await loadPlugins({ log, roots });
    const ctx = typeof context === 'function' ? (context() || {}) : (context || {});
    for (const s of skillManager.registry.list()) {
      const id = s.manifest?.id;
      if (!id) continue;
      if (isSkillEnabledInConfig(id, s.manifest?.enabledByDefault !== false)) {
        try { skillManager.activate(id, ctx); } catch (e) {
          log(`[skill] activate ${id} 失败:`, e?.message ?? e);
        }
      }
    }
    loadedOnce = true;
    return result;
  } catch (e) {
    log('[skill] 加载扩展底座失败（主流程继续）:', e?.message ?? e);
    return { loaded: [], failed: [] };
  }
}

export async function startExtensionWatch({ log = console.log, context = null, onReloadComplete = null, roots: rootsOpt = null } = {}) {
  try {
    const { watchPlugins } = await ensureLoader();
    const roots = resolveExtensionRoots(rootsOpt);
    return watchPlugins({ log, roots, onReload: (result) => {
      const ctx = typeof context === 'function' ? (context() || {}) : (context || {});
      for (const item of result.loaded || []) {
        const skill = skillManager.registry.get(item.id);
        if (!skill || !isSkillEnabledInConfig(item.id, skill.manifest?.enabledByDefault !== false)) continue;
        try { skillManager.activate(item.id, ctx); } catch (error) {
          log(`[skill] 热重载后 activate ${item.id} 失败:`, error?.message ?? error);
        }
      }
      if (typeof onReloadComplete === 'function') {
        try { onReloadComplete(result); } catch (error) {
          log('[skill] 热重载完成通知失败:', error?.message ?? error);
        }
      }
    } });
  } catch {
    return null;
  }
}

export function setExtensionEnabled(id, enabled, context = {}) {
  setSkillConfig(id, { enabled: !!enabled });
  try {
    if (enabled) skillManager.activate(id, context);
    else skillManager.deactivate(id, context);
  } catch { /* 生命周期失败不阻塞开关 */ }
  return skillManager.status(id, context);
}

/** 把 Skill 注册的工具并进核心 toolDefs。 */
export function mergeSkillTools(coreDefs = []) {
  if (!loadedOnce) return coreDefs;
  const list = listSkillTools();
  if (!list.length) return coreDefs;
  const out = [...coreDefs];
  const have = new Set(coreDefs.map((d) => d.name));
  for (const t of list) {
    if (have.has(t.id)) continue;
    if (!skillManager.isActive(t.skillId, {}).active) continue;
    out.push({
      name: t.id,
      // 展示名仅用于控制台/会话记录，OpenAI function name 继续用稳定的扩展 ID。
      displayName: String(t.name || ''),
      description: t.description,
      parameters: t.parameters || { type: 'object', properties: {} },
      category: t.category || 'system',
      skillId: t.skillId || null,
      execute: async (ctx, args) => t.execute(ctx, args)
    });
    have.add(t.id);
  }
  return out;
}

async function safeHook(name, payload) {
  if (!loadedOnce) return [];
  try {
    return await skillManager.runHook(name, payload);
  } catch (e) {
    try { skillManager.recordError(name, e); } catch { /* ignore */ }
    return [];
  }
}

export async function hookBeforeContext(payload) {
  await safeHook('before-context', payload);
}

export async function hookBeforeLlmMessages(payload) {
  await safeHook('before-llm-messages', payload);
}

export async function hookAfterResponse(payload) {
  await safeHook('after-response', payload);
}

export async function hookBeforeTool(payload) {
  const results = await safeHook('before-tool', payload);
  for (const r of results) {
    const v = r?.value;
    if (v && typeof v === 'object' && v.block) return v;
  }
  return undefined;
}

export async function hookAfterTool(payload) {
  await safeHook('after-tool', payload);
}

export function listExtensionStatus(context = {}) {
  return skillManager.list(context);
}

/** 扩展提示词片段（system 尾部可选注入）。 */
export function getExtensionPromptSections(context = {}) {
  try {
    return skillManager.getPromptSections(context);
  } catch {
    return [];
  }
}
