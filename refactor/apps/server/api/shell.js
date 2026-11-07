/**
 * refactor/apps/server/api/shell.js — 控制台 API 分片 **S1「外壳与技能」**（qwen3 f04ac19b）
 *
 * 契约见 `.tmp-dispatch/ui-api-slices-brief.md` §一：只导出一个 async `handle()`，
 * 不认识的路径 **return null** 让下一片接。分发器归 mimo（`http.js`）。
 *
 * 依赖口径（§二.1）：只用 `ctx.modules.<模块>.<公开出口>` / `ctx.configStore` / `ctx.onebot`，
 * 外加 `node:*` 与本 app 自己的 `../paths.js`（`console-api.js` 也 import 它）。**不 import `src/**`。**
 *
 * ★ 响应形状**逐条照旧树 `src/app.js`**（UI 是旧 UI 的整份拷贝，形状不对它就崩）：
 *   旧 `GET /api/skills` 回的是 `{skills}`（**没有** ok 字段）、`GET /api/tools-list` 回
 *   `{tools,enabled,allEnabled,extensions,docs}` —— 都按原样回，不"顺手规范化"。
 * ★ 能力没就绪 ⇒ **501 + `not-ported: 缺哪个出口`**，绝不回空数组假装"没有数据"（§二.2）。
 *   旧行号一并写进 error，指挥位/后续席位才知道从哪儿搬。
 */

import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { REPO_ROOT, REFACTOR_ROOT, extensionRoots } from '../paths.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(status, obj) {
  const body = JSON.stringify(obj, null, 2);
  return { status, headers: { ...JSON_HEADERS, 'content-length': String(Buffer.byteLength(body)) }, body };
}

/** §二.2：没就绪就大声回 501，并把"缺哪个出口 + 旧实现在哪儿"写进 error。 */
function notPorted(what) {
  return json(501, { ok: false, error: `not-ported: ${what}` });
}

function fail(status, message) {
  return json(status, { ok: false, error: String(message ?? '') });
}

/**
 * T-THEMES-WIRE：`HEAD` = 与 `GET` **同样的头**（含真 content-length）+ **空正文**。
 * 照静态文件那段已有的做法（`http.js:139-147`：`body: method === 'HEAD' ? '' : …`）。
 *
 * ★ 为什么要在分片里做：http.js / index.js 都不归我（sb1），而"置空正文"必须在**返回形状**里做
 *   （index.js:169-171 是 `res.end(body)`）。**不许**为了让 HEAD 通过就把 501 改成 200 ——
 *   这里 status 与 content-length 都直接沿用 GET 的真值，正文才置空，语义是真的。
 * @param {{status:number, headers:object, body:string}} out GET 的正常返回
 */
function headOf(out) {
  // content-length 原样保留（= 同一个 GET 的真字节数），只把 body 清空。
  // `encoding:'base64'` 一并去掉：正文已空，没有 base64 可解。
  const { encoding, ...rest } = out;
  void encoding;
  return { ...rest, body: '' };
}

/**
 * T-THEMES-WIRE：**路径已知、方法不对** ⇒ 405 + `allow` 头。
 *
 * ★ 为什么必须区分 405 与 501（sb3 抓到的缺陷）：家族兜底那句
 *   `S1 未认领这条 …` 会把 `HEAD /api/themes/css?id=ok` 答成 501，**谎称这条路没实现** ——
 *   它明明实现了（只是不认 HEAD）。谎报比 501 本身更误导：会让人以为"主题没搬"。
 *   规矩：**已知路径 + 错方法 = 405；真正没认领的子路径才 501。**
 */
function methodNotAllowed(pathname, methods) {
  const allow = methods.join(', ');
  // ★ 文案里**刻意不出现**"未认领"三个字（连"不是未认领"这种否认句也不写）：
  //   任何基于子串的检查（探针、grep、UI 提示）都会把否认句也当成谎报，宁可让文案换一种说法。
  const out = json(405, {
    ok: false,
    error: `方法不对：${pathname} 只接受 ${allow}。这条路径**已经实现**，换个方法即可（不是"缺能力"）。`,
    allow
  });
  out.headers.allow = allow;
  return out;
}

/** 兼容 Map / 对象两种 ctx.modules 形状（照 console-api.js 的 getMod 口径）。 */
function getMod(ctx, name) {
  const mods = ctx?.modules;
  if (!mods) return null;
  if (typeof mods.get === 'function') return mods.get(`modules/${name}`) ?? mods.get(name) ?? null;
  return mods[name] ?? null;
}

function cfgGet(ctx, key, fallback) {
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  if (typeof cs?.get !== 'function') return fallback;
  try {
    const v = cs.get(key, fallback);
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * 写配置只走 M1 的原子落盘出口（§二.3），不自己写文件。
 * ★ P1 配置收敛（2026-10-12）：本函数原来叫 `updateConfig`，但 `updateConfig` 在
 *   core/config-store 里是「只改内存、不落盘」的意思，这个名字会误导后来人往只改内存的方向改。
 *   实际行为是「改内存 + 立刻落盘」，所以改名成 `updateConfigAndSave`，与它调用的出口同名。
 *   行为一个字没改（内部仍是一次 `cs.updateConfigAndSave`）。
 */
function updateConfigAndSave(ctx, patch) {
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  if (typeof cs?.updateConfigAndSave !== 'function') {
    throw new Error('缺出口：config-store.updateConfigAndSave（写配置没有原子落盘口）');
  }
  return cs.updateConfigAndSave(patch, { backup: true, force: false, log: ctx?.log ?? (() => {}) });
}

/** 技能生命周期上下文（旧树 `extensionContext()`）。新树没有这个出口 ⇒ 只给得出最小一份。 */
function extensionContext(ctx) {
  return { cfg: ctx?.configStore ?? null, log: ctx?.log ?? (() => {}) };
}

/**
 * ★ N57（2026-10-09）：宿主发送出口（老树 `src/app.js:632-635` 那个 SendQueue）。
 * 只用 `sendSegments` 一个签名判过 —— `modules/extensions/plugin-loader.js:47` 的
 * `setExtensionSender` 也只用它当准入条件（插件的 `api.sender` 就是它）。
 * ★ 2026-10-11（派单·热重载把 sender 换裸）：**首选装配层已注入的过闸适配器**
 *   （`assembly.js:1355` 的 `modulesObj.sender` ← `createExtensionSender()`，走 act.send 唯一出口）。
 *   原来的取值顺序从 `ctx.onebot.sender`（真 SendQueue）起 ⇒ **热重载/ZIP 导入会把插件
 *   `api.sender` 从过闸适配器换回裸 SendQueue**（限频 + before-send 还在，但**没有聊天白名单闸**），
 *   一直到重启才恢复。拿不到过闸那份才按老顺序回落。
 * 取值顺序：`modulesObj.sender`（过闸）→ `ctx.onebot.sender` → `ctx.onebot.platform` → `ctx.platform`。
 * 全拿不到 ⇒ null（调用方**如实不注入**，api.sender 保持空，不糊一个假发送器）。
 */
function extensionSenderOf(ctx) {
  const gated = ctx?.modulesObj?.sender ?? ctx?.sender;
  if (gated && typeof gated.sendSegments === 'function') return gated;
  const candidates = [ctx?.onebot?.sender, ctx?.onebot?.platform, ctx?.platform];
  for (const sender of candidates) {
    if (sender && typeof sender.sendSegments === 'function') return sender;
  }
  return null;
}

/**
 * 把宿主发送出口交给扩展层（老树 `src/app.js:673-674`，口径是**先注入再 initExtensions**）。
 * 不注入 ⇒ 插件 `api.sender` 恒 null（extensions/selftest ⑤-3 量过：`senderEmpty===true`）
 * ⇒ 插件发不出消息。
 * @returns {{attached: boolean, reason?: string}}
 */
function attachExtensionSender(ctx, ext) {
  if (typeof ext?.setExtensionSender !== 'function') {
    return { attached: false, reason: '缺出口 extensions.setExtensionSender' };
  }
  const sender = extensionSenderOf(ctx);
  if (!sender) return { attached: false, reason: '拿不到带 sendSegments 的宿主发送出口（OneBot 未起？）' };
  ext.setExtensionSender(sender);
  return { attached: true };
}

/**
 * 扩展 roots 的**只读自查**（qwen1 N44 从 `modules/extensions/index.js` 导出的
 * `extensionRootsStatus()`）。目录不存在 ⇒ 当场说出来：那种情况下 loader 末尾会按
 * "本轮加载成功的 id"对账，把已加载技能全部 `pruneMissing` 卸掉
 * （extensions/selftest ⑤-7 钉的就是这条）。只读常量 + existsSync，不扫 skills/ 目录。
 * @returns {{available:boolean, skills?:string, plugins?:string, skillsExists?:boolean, pluginsExists?:boolean, reason?:string}}
 */
function rootsSelfCheck(ext) {
  if (typeof ext?.extensionRootsStatus !== 'function') {
    return { available: false, reason: '缺出口 extensions.extensionRootsStatus' };
  }
  try {
    const st = ext.extensionRootsStatus();
    const roots = st?.roots ?? {};
    return {
      available: true,
      skills: String(roots.skills ?? ''),
      plugins: String(roots.plugins ?? ''),
      skillsExists: st?.skillsExists === true,
      pluginsExists: st?.pluginsExists === true
    };
  } catch (error) {
    return { available: false, reason: String(error?.message ?? error) };
  }
}

/** ZIP 上传的体积上限。`apps/server/index.js` 的 `ZIP_UPLOAD_MAX_BYTES` 必须与它**同一个数**（那边先拦一次）。 */
const ZIP_MAX_BYTES = 20 * 1024 * 1024;

/** ZIP 上传要读**原始字节**（旧 `readBinaryBody(req, 20MB)`）；分发器现在也会先递 `rawBody`（见 importSkillZip）。 */
async function readBinaryBody(req, maxBytes = ZIP_MAX_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`ZIP 不能超过 ${Math.round(maxBytes / 1024 / 1024)}MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const EXT_DIR_RE = /^(plugins|skills)([\\/]|$)/i;
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

// ────────────────────────────────────────────────────────────────────────────
// 技能 / 扩展
// ────────────────────────────────────────────────────────────────────────────

/** GET /api/skills —— 旧 src/app.js:1796（形状：`{skills}`，无 ok 字段） */
function listSkills(ctx) {
  const ext = getMod(ctx, 'extensions');
  if (typeof ext?.listExtensionStatus !== 'function') {
    return notPorted('ctx.modules.extensions.listExtensionStatus（M14 extensions 未注入或未导出）');
  }
  const skills = ext.listExtensionStatus(extensionContext(ctx)).map((s) => {
    let hasPanel = false;
    let settingsUi = s.settingsUi;
    if (s.dir) {
      try { hasPanel = fs.existsSync(path.join(REPO_ROOT, s.dir, 'panel.html')); } catch { /* 读不到就当没有面板，别把列表打挂 */ }
      if (!settingsUi && s.loaded) {
        try {
          const file = path.join(REPO_ROOT, s.dir, s.source === 'plugin' ? 'plugin.json' : 'skill.json');
          const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
          // 走公开出口 normalizeManifest（旧 src/app.js:1809 同一条路），不自己猜清单字段
          settingsUi = typeof ext.normalizeManifest === 'function'
            ? ext.normalizeManifest(raw, { fallbackId: s.id })?.manifest?.settingsUi || null
            : null;
        } catch { /* 清单坏了就保留已加载状态 */ }
      }
    }
    return { ...s, settingsUi, hasPanel };
  });
  return json(200, { skills });
}

/** POST /api/skills —— 旧 src/app.js:1855（形状：`{skill}`） */
function toggleSkill(ctx, body) {
  const ext = getMod(ctx, 'extensions');
  if (typeof ext?.setExtensionEnabled !== 'function') {
    return notPorted('ctx.modules.extensions.setExtensionEnabled（M14 extensions 未注入或未导出）');
  }
  const id = String(body?.id || '').trim();
  if (!id) return json(400, { error: '缺少 id' });
  try {
    const st = ext.setExtensionEnabled(id, body?.enabled !== false, extensionContext(ctx));
    return json(200, { skill: st });
  } catch (error) {
    return fail(500, error?.message ?? error);
  }
}

/**
 * GET /api/skills/settings?id=<技能id> —— 设置**读侧**。
 * 旧树没有这条 GET（`src/app.js:1904` 只有 POST），mimo 那版有、按「归 S1」删掉了 ⇒ 本片接上，别掉 404。
 * 响应形状照本片的 POST 成功响应 `{ok,id,settings}`；脱敏口径照旧 `src/skills/manager.js:323 settingsView`
 * （secret 字段回 '******'，写侧收到占位/空串视为不修改 —— 两边必须同一套）。
 */
function readSkillSettings(ctx, query) {
  const ext = getMod(ctx, 'extensions');
  if (!ext?.skillManager) {
    return notPorted('ctx.modules.extensions.skillManager（registry / settingsView 都挂它上面，M14 未注入或未导出）');
  }
  if (typeof ext.skillManager.settingsView !== 'function') {
    return notPorted('ctx.modules.extensions.skillManager.settingsView()（M14 未导出该出口；旧实现 src/skills/manager.js:323 —— 含 secret 脱敏，不能由 UI 自己拼）');
  }
  const id = String(query?.get?.('id') ?? '').trim();
  if (!id) return json(400, { error: '缺少 id' });
  const skill = ext.skillManager.registry?.get?.(id);
  if (!skill) return json(400, { error: `Skill 不存在：${id}` });
  try {
    return json(200, { ok: true, id, settings: ext.skillManager.settingsView(id) });
  } catch (error) {
    return fail(500, error?.message ?? error);
  }
}

/** POST /api/skills/settings —— 旧 src/app.js:1904：只认 configSchema 声明过的键；secret 收到脱敏占位=不改 */
function saveSkillSettings(ctx, body) {
  const ext = getMod(ctx, 'extensions');
  if (!ext?.skillManager || typeof ext?.setSkillConfig !== 'function') {
    return notPorted('ctx.modules.extensions.skillManager / setSkillConfig');
  }
  const id = String(body?.id || '').trim();
  if (!id) return json(400, { error: '缺少 id' });
  const skill = ext.skillManager.registry?.get?.(id);
  if (!skill) return json(400, { error: `Skill 不存在：${id}` });
  const schema = (skill.manifest?.configSchema && typeof skill.manifest.configSchema === 'object') ? skill.manifest.configSchema : {};
  const incoming = (body?.settings && typeof body.settings === 'object') ? body.settings : {};
  const patch = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (!(k in schema)) continue;
    if (schema[k]?.secret === true && (v === '******' || v === '')) continue;
    patch[k] = v;
  }
  try {
    ext.setSkillConfig(id, patch);
    return json(200, { ok: true, id, settings: ext.skillManager.settingsView(id) });
  } catch (error) {
    return fail(500, error?.message ?? error);
  }
}

/** POST /api/skills/import-zip —— 旧 src/app.js:1732（**二进制体**，content-type: application/zip） */
async function importSkillZip(ctx, { body, req, rawBody = null }) {
  const ext = getMod(ctx, 'extensions');
  if (typeof ext?.importExtensionZip !== 'function') {
    return notPorted('ctx.modules.extensions.importExtensionZip');
  }
  // ★ 2026-10-17（ds1 · 收口"导入 zip 恒 400"）：字节来源三级，顺序即语义 ——
  //   ① `rawBody`：分发器（`index.js` 收 body → `http.js` 转手）留下的**未经 JSON.parse 的原始字节**。
  //      这是正常生产路径。旧写法让分片自己 `for await (… of req)`，可那时流已被 JSON.parse 那一步读干
  //      ⇒ 恒 400「空的上传体」（面板上就是"导入没反应"）。
  //   ② `req` 流：老分发器形状 / 直接调分片的自测与探针，仍能自己读（同一个 20MB 上限）。
  //   ③ 都没有 ⇒ 如实 400 / 501 点名，绝不假装导入成功。
  //   体积与来源边界：上游 `index.js` 已按同一上限先拦（超限 400 + 关连接）；这里再核一次。
  let got = null;
  if (Buffer.isBuffer(rawBody) && rawBody.length) got = rawBody;
  if (got && got.length > ZIP_MAX_BYTES) {
    return fail(400, `ZIP 不能超过 ${Math.round(ZIP_MAX_BYTES / 1024 / 1024)}MB`);
  }
  if (!got) {
    if (!req || typeof req[Symbol.asyncIterator] !== 'function') {
      return notPorted('apps/server 未把原始字节传给分片（rawBody / req 都没有）：ZIP 要读二进制体（body 已被 JSON.parse，读不出内容）');
    }
    try {
      got = await readBinaryBody(req);
    } catch (error) {
      return fail(400, error?.message ?? error);
    }
  }
  if (!got || !got.length) return fail(400, '空的上传体');
  try {
    const result = await ext.importExtensionZip(got, { root: REPO_ROOT, ...extensionRoots() });
    for (const item of result.installed || []) ext.setSkillConfig(item.id, { enabled: false });
    if (result.installed?.length && typeof ext.initExtensions === 'function') {
      // ★★ N57（2026-10-09）补启动链三件（qwen1 在 N44 查出并量化过、按票没动）：
      //   ① **显式传 roots** —— 这里原来不传：老树 `src/app.js:1737` 也不传，但老树缺省 = 仓库根
      //      （对）；新树 `module-level` 缺省指到**不存在的** `refactor/modules/skills`，
      //      于是 `loadPlugins` 末尾的"与磁盘对齐"会把已加载技能全部卸掉。
      //      extensions/selftest ⑥ 为这一条立了牙（逐个 initExtensions 调用点查 roots）。
      //   ② **先注入 sender 再 initExtensions** —— 老树 `src/app.js:673-674` 的顺序。
      //      不注入 ⇒ 新装技能的 `api.sender` 恒 null ⇒ 发不出消息。
      //   ③ roots 自查（只读）—— 目录不存在就当场说出来，别等"技能全没了"再查。
      attachExtensionSender(ctx, ext);
      const roots = ctx?.extensionRoots ?? extensionRoots();
      const selfCheck = rootsSelfCheck(ext);
      if (selfCheck.available && (!selfCheck.skillsExists || !selfCheck.pluginsExists)) {
        ctx?.log?.(`[apps/server] ⚠ 扩展 roots 有目录不存在：skills=${selfCheck.skills}（${selfCheck.skillsExists ? '在' : '缺'}）`
          + ` plugins=${selfCheck.plugins}（${selfCheck.pluginsExists ? '在' : '缺'}）—— 那种情况下 loader 会按磁盘对账卸掉技能`);
      }
      await ext.initExtensions({ log: ctx?.log ?? console.log, context: extensionContext(ctx), roots });
    }
    return json(200, { ok: true, ...result });
  } catch (error) {
    return fail(400, error?.message ?? error);
  }
}

/**
 * GET /api/skills/paths —— 旧 `src/app.js:1725-1731`，形状逐字照旧：`{root, plugins, skills}`。
 *
 * ★ N31（2026-10-09）：改前**没有这个 handler** ⇒ 落到 `http.js:154` 的兜底 404「未找到」。
 *   老树回的是 `ROOT`（= 仓库根，`src/config.js:10` 的 `path.resolve(__dirname,'..')`）与两个
 *   扩展目录。
 *   ★ 取值顺序**必须是 ctx.extensionRoots → extensionRoots()**，**不能**优先用 `extensions.SKILL_DIRS`：
 *     `SKILL_DIRS` 是 plugin-loader 的**模块级默认值**，它的 `APP_ROOT = resolve(<modules/extensions>,'..')`
 *     = `refactor/modules/` ⇒ 指到 `refactor/modules/skills`（**这个目录不存在**，真实目录在仓库根 `skills/`）。
 *     装配层启动时传的是 `extensionRoots()`（仓库根）—— 所以"服务器实际加载自哪儿"只有 ctx.extensionRoots 知道。
 *     这正是 `paths.js` 里 PET_SKINS_ROOT 那段写过的迁移陷阱（同一个表达式在旧树/新树含义变了），**又发生了一次**。
 */
function skillPaths(ctx) {
  const dirs = ctx?.extensionRoots ?? extensionRoots();
  return json(200, {
    root: REPO_ROOT,
    plugins: String(dirs.plugins ?? ''),
    skills: String(dirs.skills ?? '')
  });
}

/**
 * POST /api/skills/:id —— 旧 `src/app.js:1865-1900` 的**契约路由**：同一路径上切开关 / 改设置。
 *
 * ★ N31：改前**没有这个 handler** ⇒ 404。旧插件面板与 0.4 契约按这个形状调它（老注释原文：
 *   "与拆开的 /api/skills、/api/skills/settings 并存，避免旧插件面板 404"）。
 *   出口 `extensions.setSkillEnabled` / `setSkillConfig` **本来就在**（`modules/extensions/index.js:62`），
 *   缺的只是这条路由。
 *
 * 语义照老树：① 开关**先写配置再跑生命周期**（activate 里读配置必须已生效）；生命周期失败**不阻塞**开关；
 * ② 设置只认清单声明过的键（`manifest.settings ∪ manifest.configSchema`），secret 收到
 * `'******'`/空串视为不修改；③ 回 `{ok, skill: status(id), settings: settingsView(id)}`。
 */
function skillIdContract(ctx, pathname, body) {
  const ext = getMod(ctx, 'extensions');
  if (!ext?.skillManager) return notPorted('ctx.modules.extensions.skillManager（旧 src/app.js:1868）');
  const id = decodeURIComponent(pathname.split('/').slice(3).join('/') || '');
  if (!id) return json(400, { ok: false, error: '缺少技能 id' });
  const skill = ext.skillManager.registry?.get?.(id);
  if (!skill) return json(404, { ok: false, error: `Skill 不存在：${id}` });
  const ectx = extensionContext(ctx);
  try {
    // ① 开关
    if (body?.enabled !== undefined) {
      if (typeof ext.setSkillEnabled !== 'function') return notPorted('ctx.modules.extensions.setSkillEnabled（旧 src/app.js:1876）');
      ext.setSkillEnabled(id, body.enabled !== false);
      try {
        if (body.enabled !== false) ext.skillManager.activate?.(id, ectx);
        else ext.skillManager.deactivate?.(id, ectx);
      } catch { /* 生命周期失败不阻塞开关（照旧树） */ }
    }
    // ② 设置（只认清单声明过的键）
    if (body?.settings && typeof body.settings === 'object') {
      if (typeof ext.setSkillConfig !== 'function') return notPorted('ctx.modules.extensions.setSkillConfig（旧 src/app.js:1889）');
      const schema = (skill.manifest?.configSchema && typeof skill.manifest.configSchema === 'object') ? skill.manifest.configSchema : {};
      const allowed = new Set([
        ...Object.keys(skill.manifest?.settings || {}),
        ...Object.keys(schema)
      ]);
      const patch = {};
      for (const [k, v] of Object.entries(body.settings)) {
        if (!allowed.has(k)) continue;
        if (schema[k]?.secret === true && (v === '******' || v === '')) continue;
        patch[k] = v;
      }
      if (Object.keys(patch).length) ext.setSkillConfig(id, patch);
    }
    return json(200, {
      ok: true,
      skill: typeof ext.skillManager.status === 'function' ? ext.skillManager.status(id, ectx) : null,
      settings: typeof ext.skillManager.settingsView === 'function' ? ext.skillManager.settingsView(id) : null
    });
  } catch (error) {
    return fail(500, error?.message ?? error);
  }
}
/** POST /api/skills/open-folder —— 旧 src/app.js:1743：路径必须落在程序目录内 */
function openExtensionFolder(ctx, body) {
  const rootResolved = path.resolve(REPO_ROOT);
  const roots = extensionRoots();
  const id = String(body?.id || '').trim();
  const kind = String(body?.kind || '').trim().toLowerCase();
  let dir = '';

  if (id) {
    if (!ID_RE.test(id)) return json(400, { ok: false, error: 'id 不合法' });
    const ext = getMod(ctx, 'extensions');
    const st = typeof ext?.listExtensionStatus === 'function' ? ext.listExtensionStatus(extensionContext(ctx)).find((s) => s.id === id) : null;
    const rel = String(st?.dir || '').replace(/\\/g, '/');
    if (EXT_DIR_RE.test(rel)) {
      dir = path.resolve(rootResolved, rel);
    } else {
      for (const base of [roots.plugins, roots.skills]) {
        const p = path.join(base, id);
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) { dir = p; break; }
      }
    }
    if (!dir) return json(400, { ok: false, error: `找不到扩展目录：${id}` });
  } else if (kind === 'plugins' || kind === 'skills') {
    dir = roots[kind];
  } else if (kind === 'themes') {
    dir = path.join(rootResolved, 'themes');
  } else if (kind === 'root' || kind === 'app') {
    dir = rootResolved;
  } else {
    return json(400, { ok: false, error: 'kind 需为 plugins / skills，或用 id 指定扩展' });
  }

  const resolved = path.resolve(dir || '');
  if (!resolved || (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep))) {
    return json(400, { ok: false, error: '路径不在程序目录内' });
  }
  if (!fs.existsSync(resolved)) {
    try { fs.mkdirSync(resolved, { recursive: true }); } catch (error) {
      return fail(500, `无法创建目录：${error?.message ?? error}`);
    }
  }
  try {
    const [cmd, args] = process.platform === 'win32'
      ? ['explorer.exe', [resolved]]
      : process.platform === 'darwin' ? ['open', [resolved]] : ['xdg-open', [resolved]];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    // ★ 2026-10-17（ds1）：spawn 失败是**异步** 'error' 事件 —— 没有监听器时 Node 会把它抛成
    //   未捕获异常（这条 try/catch 抓不到，最坏把整棵进程带下去）。只记一行、不动响应：
    //   目录已经在盘上，窗口没打开不算致命。
    child.on('error', (error) => {
      console.warn(`[api/shell] open-folder 起外部程序失败（${cmd}）：${error?.message ?? error}`);
    });
    child.unref();
    return json(200, { ok: true, path: resolved });
  } catch (error) {
    return json(500, { ok: false, error: String(error?.message ?? error), path: resolved });
  }
}

/** GET /api/tools-list —— 旧 src/app.js:3594（形状：`{tools,enabled,allEnabled,extensions,docs}`，无 ok 字段） */
function toolsList(ctx) {
  const act = getMod(ctx, 'act');
  const ext = getMod(ctx, 'extensions');
  if (typeof act?.listTools !== 'function') return notPorted('ctx.modules.act.listTools（M10 未注入或未导出）');
  if (typeof ext?.listExtensionStatus !== 'function') return notPorted('ctx.modules.extensions.listExtensionStatus');
  // 白名单开关页要看全表 ⇒ includeUnauthorized（旧 buildToolDefs() 本来就是未过滤的全集）
  const allTools = act.listTools({ includeUnauthorized: true });
  const tools = allTools.map((d) => ({
    name: String(d.name ?? ''),
    label: String(d.displayName || ''),
    description: String(d.description || '').slice(0, 160),
    skillId: d.skillId || null
  }));
  const extensions = ext.listExtensionStatus(extensionContext(ctx))
    .filter((s) => {
      // ★ 2026-10-11 sp4（指挥位批）：判据要**两种形状都认**。
      //   老树：APP_ROOT=仓库根 ⇒ relDir=`skills/<id>`；新树：plugin-loader 的 APP_ROOT 在
      //   refactor/modules 下 ⇒ relDir=`../../skills/<id>`（显式传外部 roots 时甚至是绝对路径）
      //   ⇒ 原来只认 `startsWith('skills/')` 会把全体滤空（用户报障"扩展读不到"的根因：
      //   /api/tools-list 的 extensions 恒 0，而 tools 数组不过滤所以"白名单里有"）。
      //   原意保留：**只收 plugins/skills 下的直接子项**（从后往前数两级），别放宽成什么都收。
      const d = String(s.dir || '').replace(/\\/g, '/');
      return !d || d === 'plugins' || d === 'skills'
        || /(?:^|\/)(?:plugins|skills)\/[^/]+$/.test(d);
    })
    .map((s) => {
      const skillTools = [];
      const toolLabels = {};
      for (const t of allTools) {
        if (t && t.skillId === s.id) {
          const tid = String(t.id || t.name || '');
          if (tid) skillTools.push(tid);
          if (tid && t.name) toolLabels[tid] = String(t.name);
        }
      }
      return {
        id: s.id,
        name: s.name,
        kind: s.kind || (String(s.dir || '').startsWith('plugins') ? 'plugin' : 'skill'),
        dir: s.dir || '',
        category: s.category || '',
        description: String(s.description || '').slice(0, 200),
        enabled: !!s.enabled,
        loaded: !!s.loaded,
        active: !!s.active,
        loadError: s.loadError || '',
        reason: s.reason || '',
        lastError: s.lastError || '',
        tools: skillTools,
        toolLabels,
        hasSettings: !!s.hasSettings,
        version: s.version || '',
        capabilities: Array.isArray(s.capabilities) ? s.capabilities : [],
        implementedCapabilities: Array.isArray(s.implementedCapabilities) ? s.implementedCapabilities : [],
        hooks: Array.isArray(s.hooks) ? s.hooks : [],
        settings: (s.settings && typeof s.settings === 'object') ? s.settings : {},
        configSchema: (s.configSchema && typeof s.configSchema === 'object') ? s.configSchema : {}
      };
    });
  const enabledTools = cfgGet(ctx, 'api.tools', []);
  return json(200, {
    tools,
    enabled: Array.isArray(enabledTools) ? enabledTools : [],
    allEnabled: !Array.isArray(enabledTools) || !enabledTools.length,
    extensions,
    docs: {
      pluginDir: 'plugins/<id>/',
      skillDir: 'skills/<id>/',
      rule: '规则能写死 → 插件（providers/hooks）；要模型理解人话 → 技能（registerTool）'
    }
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 人设模板
// ────────────────────────────────────────────────────────────────────────────

/** GET /api/persona-templates —— 旧 src/app.js:2144（内建表 PERSONAS 在新树没有公开出口） */
function personaTemplates(ctx) {
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  if (typeof cs?.get !== 'function') return notPorted('ctx.configStore.get（M1 未注入）');
  if (!cs.PERSONAS) {
    // 只回自定义那半 = 形状上"内建人设不存在"，UI 的人设下拉会少一整排 ⇒ 宁可比半成品诚实
    return notPorted('core/config-store/index.js 未再导出 PERSONAS（内建人设表，旧 src/app.js:2144 用它；新树 personas.js 已搬好，出口补一行即可点亮）');
  }
  const builtins = Object.entries(cs.PERSONAS).map(([id, p]) => ({ id, name: p.name, text: p.text, builtin: true }));
  const customs = (cs.get('customPersonas', []) || []).map((p, i) => ({
    id: `custom_${i}`,
    name: p.name,
    text: p.text,
    customRules: p.customRules || '',
    builtin: false
  }));
  return json(200, { templates: [...builtins, ...customs] });
}

/** POST /api/persona-templates —— 旧 src/app.js:2158 */
function addPersonaTemplate(ctx, body) {
  const name = String(body?.name ?? '').trim().slice(0, 50);
  const text = String(body?.text ?? '').trim();
  if (!name || !text) return json(400, { ok: false, error: '人设名称和角色设定都不能为空' });
  const entry = { name, text };
  if (String(body?.customRules ?? '').trim()) entry.customRules = String(body.customRules).trim();
  try {
    const next = [...(cfgGet(ctx, 'customPersonas', []) || []), entry];
    updateConfigAndSave(ctx, { customPersonas: next });
    return json(200, { ok: true, templates: next });
  } catch (error) {
    return fail(500, error?.message ?? error);
  }
}

/** DELETE /api/persona-templates/custom_<i> —— 旧 src/app.js:2171（只有自定义能删） */
function deletePersonaTemplate(ctx, index) {
  try {
    const next = (cfgGet(ctx, 'customPersonas', []) || []).filter((_, i) => i !== index);
    updateConfigAndSave(ctx, { customPersonas: next });
    return json(200, { ok: true });
  } catch (error) {
    return fail(500, error?.message ?? error);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 暂停 / 热重载 / 前端日志 / OneBot 通讯录
// ────────────────────────────────────────────────────────────────────────────

/** POST /api/pause · DELETE /api/pause —— 旧 src/app.js:3582 / :3667 */
function setPaused(ctx, wantPaused) {
  const runtime = ctx?.runtime;
  if (typeof runtime?.pause !== 'function' || typeof runtime?.resume !== 'function') {
    return notPorted('ctx.runtime.pause() / resume()（M15 运行时未起，或未注入到 HTTP ctx）');
  }
  try {
    // ★ N9（2026-10-09）：`runtime.resume()` **现在会返回真实数字**了 ——
    //   Luna1 的 `f8e4a8f1`（N1）给 orchestrator 补上了「恢复时唤醒有未读的会话」这个出口：
    //   `resume()` 内部 `wakeUnreadBacklog()` 扫 `memory.store.listChats()` + `peekUnread()`，
    //   并返回 `{resumed, paused, abortReason, backlogChatsQueued, backlogMessagesQueued}`。
    // ⇒ 所以这里**必须把真实数字报出来**，不许再写 `backlogWoken:false` ——
    //   那正是当初要消灭的"让 UI 以为积压没处理"的反面：现在积压**真处理了**却还报没处理。
    const outcome = wantPaused ? (runtime.pause('paused'), null) : runtime.resume();
    const paused = !!runtime.status?.().paused;
    const chatsQueued = Math.max(0, Number(outcome?.backlogChatsQueued) || 0);
    const messagesQueued = Math.max(0, Number(outcome?.backlogMessagesQueued) || 0);
    // 「标记已读」那一半仍**故意不做**：`memory.store.drainUnread` 存在（`chat-store.js:752`，
    //   `console.js:378` 的 mark-read 就在用），但「恢复 = 读完还是丢弃积压」是**产品语义**
    //   （旧树 DELETE 是"用户明确选择丢弃"），等用户拍板，不在本端点擅自决定。
    return json(200, {
      ok: true,
      paused,
      resumed: outcome?.resumed === true,
      // ★ 真实唤醒数（来自 runtime.resume() 的返回值，不再是硬编码 false）
      backlogWoken: messagesQueued > 0,
      backlogChatsQueued: chatsQueued,
      backlogMessagesQueued: messagesQueued,
      marked: null,
      pending: wantPaused
        ? '已暂停。暂停期间到达的消息会以未读形态留在 chat-store（onInbound 先 ingest 再 aborted），不会丢。'
        : (messagesQueued > 0
          ? `已恢复，并唤醒 ${chatsQueued} 个会话的 ${messagesQueued} 条未读消息。`
          : '已恢复；本次没有需要补处理的未读积压。')
        + '「标记已读」未执行：memory.store.drainUnread 已具备，但「恢复 = 读完还是丢弃积压」是产品语义，等拍板。'
    });
  } catch (error) {
    return fail(500, error?.message ?? error);
  }
}

/**
 * GET /api/logger/sink —— 旧 `src/app.js:2542-2550`：**日志落盘健康状态（只读）**。
 *
 * ★ N31（2026-10-09）：改前**没有这个 handler** ⇒ 落到 http.js 兜底 404。
 *   老树加这条的理由原文：「写盘失败此前被 catch{} 全静默（整天零落盘无痕迹），经此路由可读到
 *   sink 快照与 prune 次数」—— 新树有**同一个病**（`core/observability` 的写盘失败照样静默），
 *   而出口 `fileSinkStatus()` **本来就在**（`core/observability/index.js:341`）⇒ 只差这条路由。
 *   形状照旧树 `{ok:true, sink}`；出错 **500** + 截断到 160 字。
 *
 * 授权：老树这里是 `if (!authorize(req)) return 401`。**这里刻意不复制那道来源闸**，理由写清楚：
 *   `keyEndpointAllowed`（旧 `src/app.js:1395-1412` 的逐字搬运）住在 `api/console.js`，跨分片 import
 *   等于给分片之间加依赖；而这条端点返回的是**落盘健康**（观测目录、字节数、prune 次数），
 *   与**没设闸**的 `GET /api/instance-info`（返回 `dataDir` + 模块清单）是同一类信息，
 *   不含密钥 ⇒ 复制一份安全闸在这里只会制造第二份将来会分叉的实现。
 *   若将来 `/api/instance-info` 加闸，这里必须同步加（已在下面留了标记）。
 */
function loggerSink(ctx) {
  const obs = ctx?.obs;
  if (typeof obs?.fileSinkStatus !== 'function') {
    return notPorted('core/observability.fileSinkStatus（旧 src/app.js:2545 → src/logger.js）');
  }
  try {
    return json(200, { ok: true, sink: obs.fileSinkStatus() });
  } catch (error) {
    return json(500, { ok: false, error: String(error?.message ?? error).slice(0, 160) });
  }
}

/** POST /api/hot-reload —— 旧 src/app.js:3659（UI 只认 `r.ok`） */
async function hotReload(ctx, body) {
  const pending = [];
  const done = [];
  try {
    const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
    if (typeof cs?.load === 'function') {
      cs.load({ dataDir: ctx?.dataDir });
      done.push('config');
    } else pending.push('config（缺出口 config-store.load）');

    const ext = getMod(ctx, 'extensions');
    if (typeof ext?.initExtensions === 'function') {
      // ★★ N31（2026-10-09）**实测抓到的真 bug**：这里原来**不传 roots**。
      //   调用形状只有 `{log, context}` 时 → `resolveExtensionRoots(null)` → `loadPlugins({log, roots:null})`
      //   ★ 注释里刻意不出现那个入口名的调用形状写法：modules/extensions/selftest.mjs ⑥ 有一条
      //     "逐个调用点都传 roots"的静态牙，正则会连注释一起扫，写成调用形状会被算成一个不传 roots 的假调用点。
      //   → plugin-loader 回落到它的模块级默认 `SKILLS_DIR = <modules/extensions>/../skills`
      //     = **`refactor/modules/skills`**（不存在！真实目录在仓库根 `skills/`，18 个技能）
      //   → loader 的「与磁盘对齐：把已经不存在于任何目录里的 Skill 卸掉」这一步
      //     **把盘上全部技能/插件一次性卸载**。
      //   证据（临时 dataDir 起服务的实测输出）：
      //     `[skill] ⚠️ 目录不存在，已跳过：D:\qq-agent\qq-agent\refactor\modules\skills`
      //     `[skill] 已卸载磁盘上不存在的 Skill：anti-recall, calculator, …（33 个）`
      //   ⇒ 面板上点一次「热重载」，**所有技能静默失效**，重启才回得来。
      //   修法：传 roots —— 与装配层启动时同一份（`assembly.js:816-817` 就是这么传的），
      //     `ctx.extensionRoots` 由装配层挂在 ctx 上（`assembly.js:919`），拿不到才回落 `extensionRoots()`。
      // ★★ N57（2026-10-09）再补两件（同一条"技能/插件启动"线，assembly.js 归 s21，本片只做得到的部分）：
      //   · `setExtensionSender` —— 全树此前**零调用点** ⇒ 插件 `api.sender` 恒 null。
      //     这里与 initExtensions 同批接上（老树 `src/app.js:673-674` 也是先注入再 init）。
      //   · roots 自查（只读 `extensionRootsStatus()`）：目录不存在就喊出来，不静默。
      attachExtensionSender(ctx, ext);
      const roots = ctx?.extensionRoots ?? extensionRoots();
      const selfCheck = rootsSelfCheck(ext);
      if (selfCheck.available && (!selfCheck.skillsExists || !selfCheck.pluginsExists)) {
        ctx?.log?.(`[apps/server] ⚠ 扩展 roots 有目录不存在：skills=${selfCheck.skills}（${selfCheck.skillsExists ? '在' : '缺'}）`
          + ` plugins=${selfCheck.plugins}（${selfCheck.pluginsExists ? '在' : '缺'}）—— 那种情况下 loader 会按磁盘对账卸掉技能`);
      }
      await ext.initExtensions({ log: ctx?.log ?? console.log, context: extensionContext(ctx), roots });
      done.push('extensions');
    } else pending.push('extensions（缺出口 modules.extensions.initExtensions）');

    if (body?.reconnectOneBot !== false) {
      // ★ 2026-10-18：onebot-link 现已暴露 refreshCredentials()（重新读配置 → 应用进活 client →
      //   WS 侧变了且已连接才重连）⇒ 不再"缺出口"。先补一次 SnowLuma 令牌认领（用户可能刚在
      //   设置里改了目录/端口/令牌，或刚登录 SnowLuma），再把最终配置应用到活 client。
      const link = ctx?.onebot;
      if (typeof link?.syncTokens === 'function') {
        try {
          if (link.syncTokens('hot-reload')?.changed) done.push('snowluma-tokens');
        } catch (error) {
          pending.push(`snowluma-tokens（认领失败：${String(error?.message ?? error).slice(0, 120)}）`);
        }
      }
      if (typeof link?.refreshCredentials === 'function') {
        try {
          const r = link.refreshCredentials();
          if (r?.ok === false) pending.push('onebot-credentials（OneBot 未起：start() 之后才可热更新）');
          else if (r?.changed) done.push(`onebot-credentials（已按新配置更新${r.reconnected ? '并重连' : '（未连接，无需重连）'}）`);
          else done.push('onebot-credentials（无变化）');
        } catch (error) {
          pending.push(`onebot-credentials（失败：${String(error?.message ?? error).slice(0, 120)}）`);
        }
      } else {
        pending.push('onebot-credentials（缺出口：onebot-link.refreshCredentials）');
      }
    }
    return json(200, { ok: true, done, pending });
  } catch (error) {
    return fail(500, error?.message ?? error);
  }
}

/** POST /api/ui-log —— 旧 src/app.js:2556：限长 500 字、限 500 条，只写日志不落盘 */
let uiLogCount = 0;
function uiLog(ctx, body) {
  try {
    const msg = String(body?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const tag = String(body?.tag ?? 'ui').replace(/[^\w-]/g, '').slice(0, 32) || 'ui';
    if (msg && uiLogCount < 500) {
      uiLogCount += 1;
      ctx?.log?.(`[ui:${tag}] ${msg}`);
    }
    return json(200, { ok: true });
  } catch (error) {
    // 旧树这条刻意回 200（前端日志上报不许反过来打扰 UI）—— 形状照搬
    return json(200, { ok: false, error: String(error?.message ?? error).slice(0, 160) });
  }
}

/** GET /api/onebot/groups · /api/onebot/friends —— 旧 src/app.js:2122 / :2133（失败 502） */
async function onebotDirectory(ctx, kind) {
  const client = ctx?.onebot?.client;
  if (typeof client?.call !== 'function') {
    return notPorted('ctx.onebot.client.call（OneBot 未起或未注入到 HTTP ctx）');
  }
  const action = kind === 'groups' ? 'get_group_list' : 'get_friend_list';
  try {
    const list = await client.call(action);
    const rows = Array.isArray(list) ? list : (list?.data ?? []);
    if (kind === 'groups') {
      return json(200, { groups: rows.map((g) => ({ id: String(g.group_id), name: String(g.group_name ?? g.group_id) })) });
    }
    return json(200, { friends: rows.map((f) => ({ id: String(f.user_id), name: String(f.remark || f.nickname || f.user_id) })) });
  } catch (error) {
    return json(502, { error: String(error?.message ?? error) });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 当前实例视图（GET /api/instances）—— 指挥位 2026-10-05 给的 B 方案
// ────────────────────────────────────────────────────────────────────────────

/**
 * 本程序版本（旧 src/app.js:356 APP_VERSION 的等价物，读的是**新树自己**的 package.json）。
 * 懒取：分片加载期不碰盘（与 §二「模块加载期不做盘上动作」同口径）。
 */
let appVersionCache = null;
function readAppVersion() {
  if (appVersionCache === null) {
    try {
      appVersionCache = String(JSON.parse(fs.readFileSync(path.join(REFACTOR_ROOT, 'package.json'), 'utf8'))?.version || '');
    } catch {
      appVersionCache = '';   // 读不到就是"不知道版本"，回空串（旧树同样回空，UI 的同比对不上就不显示）
    }
  }
  return appVersionCache;
}

/**
 * GET /api/instances —— 旧 src/app.js:1926（形状：`{list}`，**没有** ok 字段）。
 *
 * ★ 为什么只有一条（B 方案，指挥位 2026-10-05）：旧实现是 `discoverInstances()`
 *   （src/app.js:396-428：扫 3210-3239 + QQ_AGENT_PEER_PORTS，再逐台问 `/api/instance-info`），
 *   新树**没有这套**（`refactor/modules/` 下没有实例发现模块，且 `apps/server/index.js:41`
 *   的真实监听端口没进 ctx）⇒ 这里**不假装"本机还有别的实例"**，只出「当前实例」这一条真实视图，
 *   peer 计数如实 0，并把没搬的那出口点名写进响应（A 方案搬完扫描后只需把 list 换成 [self, ...peers]）。
 * ★ 每个字段都只从 `ctx` / M1 公开出口取；拿不到的留空串或 null，不编。
 */
function instancesView(ctx) {
  const cs = ctx?.configStore ?? getMod(ctx, 'config-store');
  if (typeof cs?.describeInstance !== 'function') {
    return notPorted('ctx.configStore.describeInstance（M1 core/config-store/instance-lock.js:186；旧 src/app.js:349 instanceName() 的等价物）—— 连"我是哪个实例"都没有权威口径，不编名字');
  }
  const label = String(cs.describeInstance() || '');
  const name = String(cfgGet(ctx, 'server.instanceName', '') || '').trim() || label;
  // 配置端口 ≠ 实测监听端口（后者没出口）：给配置值，被占用改派时这条 url 会不准 —— A 方案的端口探测才是权威口径
  const port = Number(cfgGet(ctx, 'server.port', 0)) || 0;
  const link = ctx?.onebot ?? null;
  const client = link?.client ?? null;
  const self = {
    qqAgentInstance: true,
    self: true,
    app: 'qq-agent',
    version: readAppVersion(),
    profile: '',                 // M1 只把 describeInstance()（字符串）作为出口，PROFILE_ID 没从 index 再导出 ⇒ 如实留空
    name,
    port,
    dataDir: String(ctx?.dataDir ?? ''),
    url: port ? `http://127.0.0.1:${port}/` : '',
    // 与 console-api.js:44 getStatus 同一口径；ctx 没挂链路时如实给 null（= "不知道"），不写成 connected:false 假装"已确认没连上"
    onebot: link ? {
      connected: !!link.connected,
      self: client?.selfInfo ? { userId: client.selfInfo.user_id, nickname: client.selfInfo.nickname } : null,
      error: String(client?.lastConnectError || ''),
      warning: ''
    } : null,
    snowluma: {
      dir: String(cfgGet(ctx, 'snowluma.dir', '') || ''),      // 留空 = 旧树那个"自动探测项目内 ./snowluma"没搬
      wsUrl: String(cfgGet(ctx, 'snowluma.wsUrl', '') || '')
    }
  };
  return json(200, {
    list: [self],
    peers: 0,
    discovery: 'not-ported: discoverInstances（旧 src/app.js:396-428：扫 3210-3239 + 逐台 /api/instance-info）未搬 ⇒ 本条只列当前实例，其它实例的存在与否**未知**（不是"没有"）'
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 主题（2026-10-05 T-THEMES-PORT 已搬：旧 src/themes.js 313 行 → modules/themes）
// 下面 NOT_PORTED 里已**删掉** 5 条主题；这里接真实现（形状逐条照旧 src/app.js:2048-2110）
// ────────────────────────────────────────────────────────────────────────────

/** 主题模块 + 它要的目录解析出口（模块没挂 / 出口缺 ⇒ 501 点名，绝不空数组）。 */
function themesMod(ctx) {
  return getMod(ctx, 'themes');
}

function themesDirOf(ctx) {
  const t = themesMod(ctx);
  if (typeof t?.resolveThemesDir !== 'function') return '';
  try { return String(t.resolveThemesDir() || ''); } catch { return ''; }
}

/**
 * 主题 5 条路由的**方法表**（T-THEMES-WIRE）。
 * 用途只有一个：给"路径已知、方法不对"回 **405 + allow**，好过家族兜底那句谎报"未认领"的 501。
 * GET/HEAD 的那三条同时也驱动分发（HEAD = 同样的头 + 空正文，见 `headOf`）。
 */
const THEMES_METHODS = {
  '/api/themes': ['GET', 'HEAD'],
  '/api/themes/css': ['GET', 'HEAD'],
  '/api/themes/wallpaper': ['GET', 'HEAD'],
  '/api/themes/apply': ['POST'],
  '/api/themes/import': ['POST']
};

/** GET|HEAD /api/themes（旧 src/app.js:2048-2057） */
async function themesView(ctx, head = false) {
  const t = themesMod(ctx);
  if (typeof t?.listThemes !== 'function') {
    return notPorted('ctx.modules.themes.listThemes()（旧 src/themes.js:260 已搬；GET /api/themes 旧 src/app.js:2048）');
  }
  let themes;
  let themesDir = themesDirOf(ctx);
  let dirReadable = true;
  let dirError = '';
  try {
    // ★ T-THEMES-WIRE：模块侧若已提供**对象视图**出口就用它 —— "目录读不动"必须看得见。
    //   旧行为：`listThemes()` 在目录读不动时静默只回内置主题 ⇒ 外面看是"200 + 一份健康列表"，
    //   实际上主题目录坏了。模块侧现在把 dir/dirReadable/dirError 挂在返回值上，这里如实透出。
    //   （没有 listThemesView 的旧模块侧 ⇒ 退回 listThemes()，形状照旧，不假装知道可读性。）
    if (typeof t.listThemesView === 'function') {
      const view = t.listThemesView();
      themes = view.themes;
      themesDir = String(view.dir || themesDir || '');
      dirReadable = view.dirReadable !== false;
      dirError = String(view.dirError || '');
    } else {
      themes = t.listThemes();
    }
  } catch (error) {
    return json(500, { ok: false, error: String(error?.message ?? error) });
  }
  const out = json(200, {
    ok: true,
    dir: 'themes',            // ★ 旧字段**原样保留**（值就是常量 'themes'，UI 只认 themes 数组）
    themesDir,                // ★ 新增：真实目录路径（哪个目录坏了，要能一眼看出是哪个）
    dirReadable,              // ★ 新增：false = 目录存在但读不动（**别当成"空目录"**）
    dirError: dirError || null,   // ★ 新增：可读时为 null；不可读时是原因原文（非空）
    current: cfgGet(ctx, 'ui.customThemeId', ''),
    formatDoc: 'themes/THEME_FORMAT.txt',
    themes                     // ★ 数组形状**一个字节都没改**（UI:939 只认 Array.isArray(r.themes)）
  });
  return head ? headOf(out) : out;
}

/** POST /api/themes/apply（旧 src/app.js:2073-2081） */
async function themesApply(ctx, body) {
  const t = themesMod(ctx);
  if (typeof t?.getThemeById !== 'function' || typeof t?.buildThemeUiConfig !== 'function') {
    return notPorted('ctx.modules.themes.getThemeById()+buildThemeUiConfig()（旧 src/themes.js:310/125；POST /api/themes/apply 旧 src/app.js:2073）');
  }
  const id = String(body?.id ?? '').trim();
  const th = t.getThemeById(id);
  if (!th) return json(404, { ok: false, error: '找不到主题：' + id });
  let ui;
  try {
    ui = t.buildThemeUiConfig(cfgGet(ctx, 'ui', {}), th);
  } catch (error) {
    return json(400, { ok: false, error: String(error?.message ?? error) });
  }
  const saved = updateConfigAndSave(ctx, { ui });
  if (saved?.ok === false) return saved;
  return json(200, { ok: true, theme: th });
}

/** POST /api/themes/import（旧 src/app.js:2058-2072） */
async function themesImport(ctx, body) {
  const t = themesMod(ctx);
  if (typeof t?.importTheme !== 'function' || typeof t?.buildThemeUiConfig !== 'function') {
    return notPorted('ctx.modules.themes.importTheme()+buildThemeUiConfig()（旧 src/themes.js:302/125；POST /api/themes/import 旧 src/app.js:2058）');
  }
  let th;
  try {
    th = t.importTheme(String(body?.content ?? ''), {
      filename: String(body?.filename ?? ''),
      image: body?.image
    });
  } catch (error) {
    // 旧树这里就是 400 + 原文（解析失败 / 颜色不合法 / 文件名非法都在这里）
    return json(400, { ok: false, error: String(error?.message ?? error) });
  }
  let ui;
  try {
    ui = t.buildThemeUiConfig(cfgGet(ctx, 'ui', {}), th);
  } catch (error) {
    return json(400, { ok: false, error: String(error?.message ?? error) });
  }
  const saved = updateConfigAndSave(ctx, { ui });
  if (saved?.ok === false) return saved;
  return json(200, { ok: true, theme: th });
}

/**
 * GET|HEAD /api/themes/css · GET|HEAD /api/themes/wallpaper（旧 src/app.js:2103-2120 / :2083-2100）
 * 旧树是 res.writeHead + res.end(binary)，这里按本分片的返回形状给 `{status, headers, body}`；
 * 二进制体用 base64（shell.js 的形状是 JSON 字符串，见 §一）。
 *
 * ★ T-THEMES-WIRE：`HEAD` 与 `GET` 走**同一条**逻辑（同样的 status、同样真 content-length），
 *   只有正文被置空（`headOf`）。绝不为了 HEAD 通过而改 status 或伪造长度。
 */
async function themesAsset(ctx, kind, id, head = false) {
  const t = themesMod(ctx);
  const resolve = kind === 'css' ? 'resolveThemeCssRequest' : 'resolveThemeWallpaperRequest';
  if (typeof t?.[resolve] !== 'function') {
    return notPorted(`ctx.modules.themes.${resolve}()（旧 src/themes.js:${kind === 'css' ? '179' : '165'}；GET /api/themes/${kind} 旧 src/app.js:${kind === 'css' ? '2103' : '2083'}）`);
  }
  const dir = themesDirOf(ctx);
  if (!dir) {
    return notPorted('ctx.modules.themes.resolveThemesDir()（主题目录解析出口；没有它就没有 THEMES_DIR 的等价物）');
  }
  const asset = t[resolve](dir, id);
  if (asset?.status !== 200) {
    const out = json(asset?.status || 500, { ok: false, error: asset?.error || 'Unable to read asset' });
    return head ? headOf(out) : out;
  }
  try {
    const bytes = fs.readFileSync(asset.path);
    const out = {
      status: 200,
      headers: {
        'content-type': asset.mimeType,
        'content-length': String(bytes.length),   // ← 真字节数（HEAD 也用它，不许改成 0 或伪造值）
        // 旧树这两行照搬（nosniff 防 MIME 嗅探、cache-control 旧树 css=300 / 壁纸=3600）
        'x-content-type-options': 'nosniff',
        'cache-control': kind === 'css' ? 'public, max-age=300' : 'public, max-age=3600'
      },
      body: bytes.toString('base64'),
      encoding: 'base64'
    };
    return head ? headOf(out) : out;
  } catch {
    const out = json(404, { ok: false, error: kind === 'css' ? 'Theme CSS not found' : 'Wallpaper not found' });
    return head ? headOf(out) : out;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// SnowLuma 进程管理 + 会话清理 —— 2026-10-05 W3 已搬（模块：modules/snowluma）
// 端点形状逐条照旧树 src/app.js:2004-2045 / :2848-2863（见各 handler 注释里的旧行号）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 拿 `modules/snowluma`。
 *
 * ★ 为什么有懒加载兜底：`assembly.js` 的 `MODULE_LOAD_TABLE` 是**显式表**，新增模块要在那张表里加一行
 *   （`{ id:'modules/snowluma', specifier:'../../modules/snowluma/index.js', exports:[…] }`）。
 *   **那张表不是本票的文件**（assembly.js 归别人），所以这里做成"ctx.modules 里有就用它，
 *   没有就直接 import 模块的 index.js"——依赖方向仍然是 apps → modules（说明书允许的），
 *   并且**进程内只缓存一次 import**，因此不会出现两个实例把环形日志劈成两半。
 *   ★ 等那张表加上以后，这里自动优先用 ctx.modules 里的那一份（唯一实例），无需改本文件。
 */
let snowlumaModPromise = null;
async function snowlumaMod(ctx) {
  const injected = getMod(ctx, 'snowluma');
  if (injected) return injected;
  if (!snowlumaModPromise) {
    // ★ 相对路径从 `refactor/apps/server/api/` 数起：`../../../modules/snowluma/index.js`
    //   （我第一版写成 `../../modules/...` ⇒ 解析到 `refactor/apps/modules/...`，报 ERR_MODULE_NOT_FOUND。
    //   探针 B 段当场抓到，是真 bug 不是环境问题。）
    snowlumaModPromise = import('../../../modules/snowluma/index.js')
      .catch((error) => ({ __loadError: String(error?.message ?? error) }));
  }
  return snowlumaModPromise;
}

/** 模块真的能用吗（导出齐全才算）。不能 ⇒ 回一句"缺哪个出口"的 501，不假装能起进程。 */
function snowlumaApi(mod, needed) {
  if (!mod || mod.__loadError) {
    return notPorted(`modules/snowluma（${mod?.__loadError ?? '模块不存在'}）—— 需要 ${needed}`);
  }
  for (const name of needed) {
    if (typeof mod[name] !== 'function') {
      return notPorted(`modules/snowluma.${name}（模块缺这个出口；旧 src/app.js:2004-2045 的这条端点靠它）`);
    }
  }
  return null;
}

/** 把模块读成"当前配置"（照旧树 getConfig().snowluma 的字段：dir/wsUrl/webuiPassword/accountWhitelist/autoUnhookStrangers 共五个）。 */
function snowlumaConfig(ctx) {
  return {
    dir: String(cfgGet(ctx, 'snowluma.dir', '') || ''),
    // 正式控制台允许使用随包目录；模块独立使用时仍须显式授权。
    allowBundledDir: true,
    wsUrl: String(cfgGet(ctx, 'snowluma.wsUrl', '') || ''),
    webuiPassword: String(cfgGet(ctx, 'snowluma.webuiPassword', '') || ''),
    accountWhitelist: cfgGet(ctx, 'snowluma.accountWhitelist', []) || [],
    autoUnhookStrangers: cfgGet(ctx, 'snowluma.autoUnhookStrangers', true) !== false
  };
}

/** POST /api/snowluma/launch（旧 src/app.js:2004-2011） */
async function snowlumaLaunch(ctx) {
  const mod = await snowlumaMod(ctx);
  const miss = snowlumaApi(mod, ['launch']);
  if (miss) return miss;
  mod.configure(snowlumaConfig(ctx));
  try {
    const result = await mod.launch();
    return json(result.ok ? 200 : 400, result);
  } catch (error) {
    return json(500, { ok: false, error: String(error?.message ?? error) });
  }
}

/** GET /api/snowluma/logs（旧 :2013-2015：`{ logs: snowlumaLogs.slice(-200) }`） */
async function snowlumaLogs(ctx) {
  const mod = await snowlumaMod(ctx);
  const miss = snowlumaApi(mod, ['getLogs']);
  if (miss) return miss;
  return json(200, { logs: mod.getLogs(200) });
}

/**
 * GET /api/snowluma/token-status（★ 2026-10-18）—— 令牌自动认领/同步的当前状态。
 * 形状 `{ tokenSync: { state, reason, uin, dir, wsPort, httpPort, tokens:{ws,http}, why, at } }`，
 * **永不含令牌值**（状态来自 onebot-link 的 getTokenSyncState，见其"只填空、不覆盖"的认领口径）。
 */
function snowlumaTokenStatus(ctx) {
  const link = ctx?.onebot;
  const state = typeof link?.getTokenSyncState === 'function' ? link.getTokenSyncState() : null;
  if (!state) {
    return json(200, { tokenSync: { state: 'unknown', reason: 'OneBot 接线未起（ctx.onebot 未注入）' } });
  }
  return json(200, { tokenSync: state });
}

/** POST /api/snowluma/stop（旧 :2017-2024） */
async function snowlumaStop(ctx) {
  const mod = await snowlumaMod(ctx);
  const miss = snowlumaApi(mod, ['stop', 'status']);
  if (miss) return miss;
  try {
    const stopped = mod.stop();
    const st = mod.status();
    return json(200, { ok: true, stopped, embedded: st.embedded, pid: st.pid });
  } catch (error) {
    return json(500, { ok: false, error: String(error?.message ?? error) });
  }
}

/** POST /api/snowluma/check-accounts（旧 :2026-2031） */
async function snowlumaCheckAccounts(ctx) {
  const mod = await snowlumaMod(ctx);
  const miss = snowlumaApi(mod, ['checkAccounts', 'scanAccounts', 'getWarning']);
  if (miss) return miss;
  mod.configure(snowlumaConfig(ctx));
  try {
    // 旧树跑两次：checkBridgeAccounts() 里可能把陌生人自动卸载了，随后那次 scan 才是"卸载后的实况"。
    await mod.checkAccounts();
    const live = await mod.scanAccounts();
    return json(200, {
      ok: true,
      // ★ 附加字段（旧树形状没有）：把"扫的是哪个目录"说出来。
      //   没有它时，"目录坏了"与"没有配置白名单"返回的东西**一模一样**（空数组），
      //   运维看不出来。加一个字段不破坏 UI（它只读 whitelist/live/strangers/warning）。
      dir: live.dir,
      warning: mod.getWarning(),
      whitelist: live.whitelist,
      live: live.live,
      strangers: live.strangers
    });
  } catch (error) {
    return json(500, { ok: false, error: String(error?.message ?? error) });
  }
}

/** POST /api/snowluma/open-folder（旧 :2033-2038）—— L1：起外部程序，失败必须可见 */
async function snowlumaOpenFolder(ctx) {
  const mod = await snowlumaMod(ctx);
  const miss = snowlumaApi(mod, ['openFolder']);
  if (miss) return miss;
  mod.configure(snowlumaConfig(ctx));
  const result = await mod.openFolder();
  return json(result.ok ? 200 : 400, result.ok ? { ok: true } : result);
}

/** POST /api/snowluma/open-webui（旧 :2040-2045）—— L1 */
async function snowlumaOpenWebui(ctx) {
  const mod = await snowlumaMod(ctx);
  const miss = snowlumaApi(mod, ['openWebui']);
  if (miss) return miss;
  mod.configure(snowlumaConfig(ctx));
  const result = await mod.openWebui();
  return json(result.ok ? 200 : 400, result.ok ? { ok: true, webuiUrl: result.webuiUrl } : result);
}

// ── 会话清理（旧 :2848-2863）─────────────────────────────────────────────────
// ★ 旧树这里是 `if (!cleanup) return 503`：清理服务没就绪就 503，**不是** 501、也不是假装"没有垃圾"。
//   服务**已搬**（`modules/cleanup` 的工厂 + `modules/sessions` 的 registry，见下面 `cleanupService()`）；
//   只有"出口缺失 / 构造失败"时才真的回 503 —— 与旧树"未就绪"路径同义，**不是**"新树没搬"。

/**
 * 找清理服务。**优先级：注入 → 模块工厂 → 模块命名空间 → null**，四个分支全留；
 * 都拿不到 ⇒ 返回 null ⇒ 端点回 503（旧树同款"未就绪"语义，绝不假装服务可用）。
 *
 * ★ 2026-10-05（指挥位 recipe）**两半终于接上了**：新模块 `modules/cleanup` 导出的是**工厂**
 *   `createCleanupService({registry, dataDir})`，模块命名空间上**没有** `planCleanup` ⇒
 *   我原来那段"找带 planCleanup 的模块"永远找不到它，端点即使有表行也仍是 503。
 *   现在：拿 `modules/cleanup` 的工厂 + `modules/sessions` 的 `createSessionRegistry({dataDir})`
 *   **惰性构造一次并缓存**。
 *
 * ★★ **注入必须排在最前面**（指挥位 2026-10-05 复核抓到的真缺陷：我第一版把注入分支放在最后，
 *   注释与代码不一致）：`ctx.cleanup` 是**测试/探针的观察缝**。若工厂分支先命中，
 *   将来任何"注入假服务观察调用"的行为测试，拿到的会是**真的** `createCleanupService`
 *   ⇒ **测试直接打生产回收路径**（AGENTS.md 明令禁止），而且探针会以为自己测的是假服务。
 *   顺序即语义，这里钉死：注入 → 工厂 → 命名空间 → null。
 *
 * ⚠ 缓存**按 dataDir 分键**：dataDir 变了就重建。否则测试/多实例会把上一个 dataDir 的服务
 *   当成这一个用 ⇒ **跨目录误删**。不靠"生产只有一个 dataDir"来兜。
 */
let cachedCleanup = null;
let cachedCleanupDataDir = '';
let cachedCleanupSource = '';

/** 已接上清扫器的 dataDir（一个 dataDir 只扫一份，别两个分片各起一个 6 小时定时器）。 */
const armedSweepers = new Set();

/**
 * 只认"真有 `extractFromSessions`"的对象；拿不到就 null。
 * ★★ **不硬造 topicStore**：`modules/cleanup` 的 P4 闸门要它当"提过话题才准硬删"的凭证
 *   （index.js:396-405 / :517-529）。新树**没有** topics 模块 ⇒ 这里如实给 null ⇒
 *   回收站"到期也不删"（只记账：retries / keepForever），这正是 qwen1 在 N48 钉死的安全语义。
 *   谁把 topics 搬过来，这里自动就接上（不用再改本文件）。
 */
export function pickTopicStore(candidate) {
  return (candidate && typeof candidate.extractFromSessions === 'function') ? candidate : null;
}

/**
 * ★ N57（2026-10-09）接上**回收站清扫器**（老树 `src/app.js:3761-3764`：启动扫一次 + 每 6 小时扫一次，unref）。
 * 背景：`sweepTrash()` 由 qwen1 在 N48 从老树补搬回 `modules/cleanup`，但**全树零调用点**
 *   ⇒ 回收站只进不出。本函数是它的接线点。
 * ★★ 安全性：**没有注入 topicStore 时，sweepTrash 一个字节都不会删**（P4 fail-safe：
 *   提取失败 ⇒ retries++ ⇒ 连挂到上限转 keepForever）。所以这里即使接上也不会误删。
 * @param {{sweepTrash?:Function}} service
 * @param {{dataDir?:string, log?:Function}} opts
 * @returns {{armed:boolean, reason?:string}}
 */
export function armCleanupSweeper(service, { dataDir = '', log = null } = {}) {
  if (!service || typeof service.sweepTrash !== 'function') {
    return { armed: false, reason: '缺出口 service.sweepTrash' };
  }
  const key = String(dataDir || '');
  if (armedSweepers.has(key)) return { armed: false, reason: 'already-armed' };
  armedSweepers.add(key);
  const say = typeof log === 'function' ? log : () => {};

  // 单飞由模块自己保证（`sweeping` 闸门）；这里只负责"别让失败变成 unhandledRejection"。
  const run = (reason) => {
    try {
      const settled = service.sweepTrash();
      if (settled && typeof settled.then === 'function') {
        settled.then((out) => {
          say(`[apps/server] 回收站清扫（${reason}）：scanned=${out?.scanned ?? '?'} expired=${out?.expired ?? '?'}`
            + ` swept=${out?.swept ?? '?'} failed=${out?.failed ?? '?'} keepForever=${out?.keepForever ?? '?'}`
            + `—— 新树尚无 topics 模块 ⇒ topicStore 未注入 ⇒ 到期也不删（P4 fail-safe，只记账）`);
        }).catch((error) => say(`[apps/server] 回收站清扫失败（${reason}，不影响主流程）：${String(error?.message ?? error)}`));
      }
    } catch (error) {
      say(`[apps/server] 回收站清扫抛错（${reason}，不影响主流程）：${String(error?.message ?? error)}`);
    }
  };

  run('首次');
  const timer = setInterval(() => run('定时'), 6 * 3600e3);   // 老树同款节奏
  if (typeof timer.unref === 'function') timer.unref();       // 不许因为清扫器让进程退不掉
  return { armed: true, intervalMs: 6 * 3600e3 };
}

function cleanupService(ctx) {
  // ① 注入优先（测试/探针的观察缝；AGENTS.md：测试不得直接调用生产回收路径）
  const injected = ctx?.cleanup;
  if (injected && typeof injected.planCleanup === 'function') {
    if (cachedCleanupSource !== 'injected' || cachedCleanup !== injected) {
      cachedCleanup = injected;
      cachedCleanupSource = 'injected';
      cachedCleanupDataDir = String(ctx?.dataDir ?? '');
    }
    return cachedCleanup;
  }
  const dataDir = String(ctx?.dataDir ?? '');
  if (cachedCleanup && cachedCleanupDataDir === dataDir) return cachedCleanup;
  const cleanupMod = getMod(ctx, 'cleanup');
  const sessionsMod = getMod(ctx, 'sessions');
  cachedCleanup = null;
  cachedCleanupDataDir = dataDir;
  cachedCleanupSource = '';
  if (typeof cleanupMod?.createCleanupService === 'function'
    && typeof sessionsMod?.createSessionRegistry === 'function'
    && dataDir) {
    try {
      const registry = sessionsMod.createSessionRegistry({ dataDir });
      // ★ N57：① 传 `log`（qwen1 N48 补的 force 审计**第二通道**；不传则退回 stderr）
      //       ② 探 topicStore（拿不到就 null ⇒ 保持"到期也不删"，不硬造）
      cachedCleanup = cleanupMod.createCleanupService({
        registry,
        dataDir,
        topicStore: pickTopicStore(ctx?.topicStore ?? getMod(ctx, 'topics') ?? getMod(ctx, 'conversation-memory')),
        log: (line) => ctx?.log?.(line)
      });
      cachedCleanupSource = 'module-factory';
    } catch (error) {
      // 构造失败（dataDir 不可用等）⇒ 留 null ⇒ 端点 503，**不**假装服务可用
      process.stderr.write(`[shell] createCleanupService 失败 ⇒ 清理端点将回 503：${String(error?.message ?? error)}\n`);
    }
  } else if (typeof cleanupMod?.planCleanup === 'function') {
    cachedCleanup = cleanupMod;          // 旧分支：模块命名空间上直接带方法
    cachedCleanupSource = 'module-namespace';
  }
  // ★ N57：把清扫器接上（老树 src/app.js:3763-3764）。注入分支是测试缝，不给它起定时器。
  if (cachedCleanup && cachedCleanupSource !== 'injected') {
    armCleanupSweeper(cachedCleanup, { dataDir, log: (line) => ctx?.log?.(line) });
  }
  return cachedCleanup;
}

/** 自测/排障用：清掉缓存的清理服务（换 dataDir 或模块重载后调用）。 */
export function __resetCleanupServiceCache() {
  cachedCleanup = null;
  cachedCleanupDataDir = '';
  cachedCleanupSource = '';
  // 一并清掉"已接清扫器"的记忆：否则自测换一个 dataDir 再建服务时，arm 会被
  // 'already-armed' 挡住 ⇒ 看起来接上了其实没起定时器。测试要自己承担那一个多出来的定时器。
  armedSweepers.clear();
  return true;
}

/** 自测/排障用：当前缓存来自哪条分支（'injected' / 'module-factory' / 'module-namespace' / ''）。 */
export function __cleanupServiceSource() {
  return cachedCleanupSource;
}

/** POST /api/cleanup（旧 :2848-2854：keepDays 只收 7 / 30，否则 400；dryRun 走 planCleanup） */
async function cleanupPlan(ctx, body) {
  const service = cleanupService(ctx);
  if (!service) {
    return json(503, {
      ok: false,
      error: '会话清理服务尚未就绪：modules/cleanup 工厂或 modules/sessions registry 出口缺失 / 构造失败（见 cleanupService()；不是"没有垃圾"）'
    });
  }
  const keepDays = body?.keepDays;
  if (![7, 30].includes(keepDays)) return json(400, { ok: false, reason: 'bad-keepDays' });
  const dryRun = body?.dryRun;
  try {
    return json(200, dryRun ? await service.planCleanup(keepDays) : await service.applyCleanup(keepDays));
  } catch (error) {
    return json(500, { ok: false, error: String(error?.message ?? error) });
  }
}

/** GET /api/cleanup/trash（旧 :2855-2858：`{ ok:true, items:[…] }`） */
async function cleanupTrash(ctx) {
  const service = cleanupService(ctx);
  if (!service || typeof service.listTrash !== 'function') {
    return json(503, { ok: false, error: '会话清理服务尚未就绪，或模块缺 listTrash 出口（见 cleanupService()）' });
  }
  try {
    return json(200, { ok: true, items: service.listTrash() });
  } catch (error) {
    return json(500, { ok: false, error: String(error?.message ?? error) });
  }
}

/** POST /api/cleanup/trash/:id/purge-now（旧 :2859-2863：`await cleanup.purgeNow(id)`） */
async function cleanupPurgeNow(ctx, id, body) {
  const service = cleanupService(ctx);
  if (!service || typeof service.purgeNow !== 'function') {
    return json(503, { ok: false, error: `会话清理服务尚未就绪，或模块缺 purgeNow 出口（id=${id} —— 不可逆操作因此**没有**执行）` });
  }
  try {
    return json(200, await service.purgeNow(id, { dryRun: body?.dryRun === true }));
  } catch (error) {
    return json(500, { ok: false, error: String(error?.message ?? error) });
  }
}

/** GET /api/groups/:id/members（旧 :3537-3549，OneBot get_group_member_list） */
async function groupMembersView(ctx, groupId) {
  // ★ 只走门面 ctx.platform.call（W1 由 qwen3.8flash 加的只读白名单包装）。
  //   **不自己开第二条 call 通道**（那会绕过白名单闸）；门面不在 ⇒ 如实 notPorted。
  const platform = ctx?.platform;
  if (!platform || typeof platform.call !== 'function') {
    return notPorted('ctx.platform.call（W1 门面：apps/server/index.js 上那层只读白名单包装；没有它我不自己接 onebot 客户端）');
  }
  let list;
  try {
    list = await platform.call('get_group_member_list', { group_id: Number(groupId) });
  } catch (error) {
    return json(502, { error: String(error?.message ?? error) });
  }
  const members = (Array.isArray(list) ? list : (list?.data ?? []))
    .map((m) => ({ userId: String(m.user_id), nickname: String(m.nickname || ''), card: String(m.card || '') }))
    .sort((a, b) => String(a.card || a.nickname).localeCompare(String(b.card || b.nickname), 'zh-CN'));
  return json(200, { members });
}

// ★ 2026-10-05 W3：这 8 条（6 snowluma + cleanup / cleanup/trash）**已搬走**，由上面的
//   snowlumaXxx / cleanupXxx handler 接管 ⇒ 已从 NOT_PORTED（下面那张空表）摘掉。
//   ⚠ 下面这张表**不是**"未实现清单"：它只用来给"路径已知、方法不对"回 405 + allow。
//   留在 NOT_PORTED 里的才必须**真的**没实现。
/**
 * W3 新增两族的"已知路径 → 合法方法"表。
 * 理由与 `THEMES_METHODS` 同源：**路径已知但方法不对**要回 405 + allow，
 * 不能拿"未认领/未实现"那种话糊过去 —— 那比 501 本身更误导。
 */
const SNOWLUMA_CLEANUP_METHODS = {
  '/api/snowluma/launch': ['POST'],
  '/api/snowluma/logs': ['GET'],
  '/api/snowluma/token-status': ['GET'],
  '/api/snowluma/stop': ['POST'],
  '/api/snowluma/check-accounts': ['POST'],
  '/api/snowluma/open-folder': ['POST'],
  '/api/snowluma/open-webui': ['POST'],
  '/api/cleanup': ['POST'],
  '/api/cleanup/trash': ['GET']
};
/** 全部"已知路径"的并集（405 判定与"已实现清单"文案都用它）。 */
const KNOWN_METHODS = { ...THEMES_METHODS, ...SNOWLUMA_CLEANUP_METHODS };

const NOT_PORTED = {
  // （空表：SnowLuma 与清理族已搬；剩下的 501 由家族兜底点名，不静默变 404）
};

// ────────────────────────────────────────────────────────────────────────────
// 分发
// ────────────────────────────────────────────────────────────────────────────

/**
 * 分片唯一入口（契约见说明书 §一）。不认识 ⇒ `return null`。
 * @param {{method:string, pathname:string, query:URLSearchParams, body:any, ctx:object, req:object, res:object,
 *          rawBody?: Buffer|null}} args `rawBody` = 未经 JSON.parse 的原始字节（import-zip 用；见 importSkillZip）
 */
export async function handle({ method, pathname, query, body, ctx, req, res, rawBody = null } = {}) {
  void res;
  const m = String(method || '').toUpperCase();

  // ── 主题（2026-10-05 已搬：modules/themes；形状逐条照旧 src/app.js:2048-2110）──
  // ★ 必须排在下面 `/^\/api\/(themes|cleanup|snowluma)/` 那条家族兜底**之前**，
  //   否则这 5 条会被兜底当成"未认领" 501 掉。
  // ★ T-THEMES-WIRE：三条 GET 路由现在**也认 HEAD**（同样的头 + 空正文，见 headOf）。
  const head = m === 'HEAD';
  if (pathname === '/api/themes' && (m === 'GET' || head)) return themesView(ctx, head);
  if (pathname === '/api/themes/apply' && m === 'POST') return themesApply(ctx, body);
  if (pathname === '/api/themes/import' && m === 'POST') return themesImport(ctx, body);
  if (pathname === '/api/themes/css' && (m === 'GET' || head)) {
    return themesAsset(ctx, 'css', query?.get?.('id') ?? '', head);
  }
  if (pathname === '/api/themes/wallpaper' && (m === 'GET' || head)) {
    return themesAsset(ctx, 'wallpaper', query?.get?.('id') ?? '', head);
  }

  // ── 技能 / 扩展 ──
  if (pathname === '/api/skills' && m === 'GET') return listSkills(ctx);
  if (pathname === '/api/skills' && m === 'POST') return toggleSkill(ctx, body);
  if (pathname === '/api/skills/settings' && m === 'GET') return readSkillSettings(ctx, query);
  if (pathname === '/api/skills/settings' && m === 'POST') return saveSkillSettings(ctx, body);
  if (pathname === '/api/skills/import-zip' && m === 'POST') return importSkillZip(ctx, { body, req, rawBody });
  if (pathname === '/api/skills/open-folder' && m === 'POST') return openExtensionFolder(ctx, body);
  // ★ N31：`/api/skills/paths` 必须排在下面的 `:id` 宽匹配**之前**，
  //   否则 `paths` 会被当成技能 id（老树 `src/app.js:1867` 那句注释说的正是这类坑：
  //   "settings 本身也匹配 :id；必须让精确设置路由在下面处理"）。
  if (pathname === '/api/skills/paths' && m === 'GET') return skillPaths(ctx);
  const skillIdMatch = /^\/api\/skills\/([^/]+)$/.exec(pathname || '');
  if (skillIdMatch && m === 'POST' && pathname !== '/api/skills/settings') {
    return skillIdContract(ctx, pathname, body);
  }
  if (pathname === '/api/tools-list' && m === 'GET') return toolsList(ctx);

  // ── 人设模板 ──
  if (pathname === '/api/persona-templates' && m === 'GET') return personaTemplates(ctx);
  if (pathname === '/api/persona-templates' && m === 'POST') return addPersonaTemplate(ctx, body);
  const personaDelete = /^\/api\/persona-templates\/(custom_\d+)$/.exec(pathname || '');
  if (personaDelete && m === 'DELETE') {
    return deletePersonaTemplate(ctx, Number(personaDelete[1].replace('custom_', '')));
  }

  // ── 暂停 / 热重载 / 前端日志 / OneBot 通讯录 ──
  if (pathname === '/api/pause' && m === 'POST') return setPaused(ctx, body?.paused !== false);
  if (pathname === '/api/pause' && m === 'DELETE') return setPaused(ctx, false);
  if (pathname === '/api/hot-reload' && m === 'POST') return hotReload(ctx, body);
  // ★ N31：旧 src/app.js:2542（GET /api/logger/sink）—— 改前整条路由缺失（404「未找到」）。
  if (pathname === '/api/logger/sink' && (m === 'GET' || head)) return loggerSink(ctx);
  if (pathname === '/api/ui-log' && m === 'POST') return uiLog(ctx, body);
  const onebotKind = /^\/api\/onebot\/(groups|friends)$/.exec(pathname || '');
  if (onebotKind && m === 'GET') return onebotDirectory(ctx, onebotKind[1]);
  if (/^\/api\/onebot\/[^/]+$/.test(pathname || '') && m === 'GET') {
    return json(400, { ok: false, error: 'kind 需为 groups / friends' });
  }

  // ── SnowLuma 进程管理（W3 已搬：modules/snowluma；形状逐条照旧 src/app.js:2004-2045）──
  if (pathname === '/api/snowluma/launch' && m === 'POST') return snowlumaLaunch(ctx);
  if (pathname === '/api/snowluma/logs' && m === 'GET') return snowlumaLogs(ctx);
  if (pathname === '/api/snowluma/token-status' && m === 'GET') return snowlumaTokenStatus(ctx);
  if (pathname === '/api/snowluma/stop' && m === 'POST') return snowlumaStop(ctx);
  if (pathname === '/api/snowluma/check-accounts' && m === 'POST') return snowlumaCheckAccounts(ctx);
  if (pathname === '/api/snowluma/open-folder' && m === 'POST') return snowlumaOpenFolder(ctx);
  if (pathname === '/api/snowluma/open-webui' && m === 'POST') return snowlumaOpenWebui(ctx);

  // ── 会话清理（W3：端点已搬；**服务**未就绪时按旧树语义回 503，不是 501）──
  if (pathname === '/api/cleanup' && m === 'POST') return cleanupPlan(ctx, body);
  if (pathname === '/api/cleanup/trash' && m === 'GET') return cleanupTrash(ctx);
  const cleanupPurge = /^\/api\/cleanup\/trash\/([\w-]+)\/purge-now$/.exec(pathname || '');
  if (cleanupPurge && m === 'POST') return cleanupPurgeNow(ctx, cleanupPurge[1], body);

  // ── 群成员（旧 :3537；只走 ctx.platform 门面，白名单闸在那层）──
  const groupMembersMatch = /^\/api\/groups\/(\d+)\/members$/.exec(pathname || '');
  if (groupMembersMatch && m === 'GET') return groupMembersView(ctx, groupMembersMatch[1]);

  // ── 未搬的能力：大声 501，别用空数据骗 UI ──
  if (pathname === '/api/instances' && m === 'GET') return instancesView(ctx);
  if (NOT_PORTED[pathname]) return notPorted(NOT_PORTED[pathname]);

  // T-THEMES-WIRE：**主题路径已知、但方法不对** ⇒ 405 + allow（在家族兜底**之前**判）。
  // 少了这一段，`HEAD /api/themes/css?id=ok` 就会掉进下面那句 501，而它**谎称"未认领"**
  // —— 那条路明明已实现（只是不认 HEAD）。谎报比 501 本身更误导。
  if (KNOWN_METHODS[pathname]) {
    return methodNotAllowed(pathname, KNOWN_METHODS[pathname]);
  }

  // 这三族里**没在上面列出的**子路径：也要喊出来，别静默变 404 让 UI 以为"没有这个功能"。
  // ★ 到这里为止的都是**真的没认领**，所以说"未认领"是实话。
  // ★ 2026-10-05 W3 起这句话必须带上"已实现清单"：SnowLuma/清理已由 S1 搬走，
  //   对这两族更不准的说法就是"S1 未认领"。
  if (/^\/api\/(themes|cleanup|snowluma)(\/|$)/.test(pathname || '')) {
    return notPorted(
      `这条 ${m} ${pathname} 不在已实现清单里。已实现：${Object.keys(KNOWN_METHODS).join('、')}`
      + '、/api/cleanup/trash/:id/purge-now(POST)。若你确信它是另一条已实现路径，请指挥位确认归属——'
      + '别把它当 404 咽掉。'
    );
  }

  return null;
}
