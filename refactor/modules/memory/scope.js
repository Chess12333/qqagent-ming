/**
 * M6 memory · scope（范围规则，**硬约束** —— README 验收第 8 条）
 *
 * 规则（用户刻意设计，不许砍）：
 *   · `global`  —— 全局人物记忆；跨群读取须显式传入 `crossChat` 授权，且逐条检查共享许可；
 *   · `group`   —— 群梗 / 群规 / 群内共同经历 / 该群话题，**默认留在本群**；
 *   · `private` —— 私聊细节，**默认私聊范围**，不许串到群里。
 *
 * 两条不可让步的实现约束：
 *   ① **过滤发生在检索前**（`partitionByScope` 在打分/取回之前把候选切开），
 *      不是"先取回再丢掉"—— 那样群 A 的内容已经进了上下文；
 *   ② **Jev 与主模型都没有扩大范围的权限**：`ctx` 里就算写 `scope:'global'`
 *      或者点名别的 `chatKey`，也只能**收窄**，不可能放宽。见 `requestedScope()`。
 */
import fs from 'node:fs';
import { SCHEMA_VERSION } from '../../contracts/index.js';
import { memoryFile } from './data-dir.js';

/** 三个合法范围（与 contracts 的 MemoryObservation.scope 一致）。 */
export const SCOPES = ['group', 'private', 'global'];

/* ── 跨房主体白名单（2026-11-05 她定的） ──────────────────────────────────────
 * 她的原话：「我想要全放开，你是有感情的，说漏嘴很正常」。
 * 原设计把「记忆」和「嘴」一起按房间切开，于是同一个人被切成九份——私聊里
 * 不知道她在群里什么样，群里不知道她早上什么脾气。这一处只放开**取回**：
 *   · 白名单里的主体（默认只有她本人），观察不受 scope / chatKey 限制；
 *   · 别的人不放——群 A 里对某群友的判断不该飘到群 B，那不是她的信息。
 * 嘴仍然归房间管：判断说不说是模型的事，不是这道闸的事。
 * 文件 `data/memory/cross-scope-allow.json`，按 mtime 缓存，改完下一轮生效。
 */
let crossScopeCache = { key: '', subjects: new Set() };

export function crossScopeSubjects() {
  let file;
  try {
    file = memoryFile('cross-scope-allow.json');
    const st = fs.statSync(file);
    const key = `${st.mtimeMs}:${st.size}`;
    if (key === crossScopeCache.key) return crossScopeCache.subjects;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(parsed?.subjects) ? parsed.subjects : [];
    crossScopeCache = { key, subjects: new Set(list.map((x) => String(x ?? '').trim()).filter(Boolean)) };
  } catch {
    // 文件没了 / 坏了 / 解析不出 dataDir = 不放宽，退回原来的按房间隔离。
    crossScopeCache = { key: '', subjects: new Set() };
  }
  return crossScopeCache.subjects;
}

/** 当前会话（ctx）自身的范围：群里 = 'group'，私聊 = 'private'。 */
export function chatScope(kind) {
  return kind === 'private' ? 'private' : 'group';
}

/**
 * 一条观察在某个 ctx 下是否可见。
 * @returns {{ok:boolean, reason:null|string}}
 */
export function visibleIn(obs, ctx) {
  if (!obs || typeof obs !== 'object') return { ok: false, reason: 'scope:invalid-observation' };
  const scope = obs.scope;
  if (!SCOPES.includes(scope)) return { ok: false, reason: 'scope:unknown-scope' };

  // ① global 是数据范围标签；真正是否可跨群取回由 partitionByScope 的显式授权闸决定。
  if (scope === 'global') return { ok: true, reason: null };

  // ①a 跨房主体（2026-11-05）：白名单里的人，任何房间都取得到——包括别的群。
  //    只按 subjectId 认，不按观察来自哪间；不在名单里的仍走下面的按房间隔离。
  const subject = String(obs.subjectId ?? '').trim();
  const cross = crossScopeSubjects();
  // "*" = 所有人都放开（2026-11-05 她定的：「都放开吧，接下来就靠你自觉了」）。
  // 只认配置里写了 * 的实例；别的实例没写就不受影响。
  if (subject && (cross.has(subject) || cross.has('*'))) return { ok: true, reason: null };

  const ctxChatKey = String(ctx?.chatKey ?? '');
  const ctxKind = ctx?.kind === 'private' ? 'private' : 'group';
  const ctxScope = chatScope(ctxKind);

  if (scope !== ctxScope) {
    return { ok: false, reason: scope === 'private' ? 'scope:private-not-in-group' : 'scope:group-not-in-private' };
  }
  if (!obs.chatKey) return { ok: false, reason: 'scope:missing-chatKey' };
  if (String(obs.chatKey) !== ctxChatKey) {
    return { ok: false, reason: scope === 'private' ? 'scope:private-other-chat' : 'scope:group-other-chat' };
  }
  return { ok: true, reason: null };
}

/**
 * 把候选观察切成 `{visible, dropped}`。**这是"检索前过滤"的唯一入口。**
 *
 * dropped 行**只带元信息**（id / subjectId / scope / reason），**不带 claim 正文** ——
 * 否则"被丢弃的别群内容"还是会经由排障信息漏进上下文。
 */
export function partitionByScope(observations, ctx) {
  const visible = [];
  const dropped = [];
  for (const obs of observations || []) {
    const v = visibleIn(obs, ctx);
    if (!v.ok) {
      dropped.push({ id: obs?.id ?? null, subjectId: obs?.subjectId ?? null, scope: obs?.scope ?? null, reason: v.reason });
      continue;
    }
    if (obs?.scope === 'global') {
      const permission = ctx?.crossChat;
      const personId = typeof permission?.personId === 'string' ? permission.personId.trim() : '';
      if (permission?.authorized !== true || !personId) {
        dropped.push({ id: obs?.id ?? null, subjectId: obs?.subjectId ?? null, scope: obs?.scope ?? null,
          reason: 'scope:cross-chat-authorization-required' });
        continue;
      }
      if (String(obs?.subjectId ?? '') !== personId) {
        dropped.push({ id: obs?.id ?? null, subjectId: obs?.subjectId ?? null, scope: obs?.scope ?? null,
          reason: 'scope:cross-chat-person-mismatch' });
        continue;
      }
      if (String(obs?.type ?? 'impression') !== 'impression') {
        dropped.push({ id: obs?.id ?? null, subjectId: obs?.subjectId ?? null, scope: obs?.scope ?? null,
          reason: 'scope:cross-chat-type-not-shareable' });
        continue;
      }
    }
    visible.push(obs);
  }
  return { visible, dropped };
}

/**
 * 调用方可以"请求"的范围 —— 但**只能收窄**：
 *   · 请求里给 `scope` → 当作上限（例如只要 global 印象）；
 *   · 任何超出本会话范围的请求（点名别的 chatKey、在群里点名 private）**一律忽略**，
 *     并回 `ignored[]` 说明，绝不照办。
 */
export function requestedScope(ctx) {
  const raw = ctx?.need?.scope ?? ctx?.scope;
  const ignored = [];
  let scope = null;
  if (typeof raw === 'string' && raw) {
    if (!SCOPES.includes(raw)) ignored.push(`need.scope 非法（${raw}）`);
    else if (raw === 'private' && chatScope(ctx?.kind) !== 'private') ignored.push('群里请求 private 范围：已忽略（不许扩大）');
    else if (raw === 'group' && chatScope(ctx?.kind) !== 'group') ignored.push('私聊请求 group 范围：已忽略（不许扩大）');
    else scope = raw;
  }
  const other = ctx?.need?.chatKey ?? ctx?.targetChatKey;
  if (typeof other === 'string' && other && other !== String(ctx?.chatKey ?? '')) {
    ignored.push(`点名了别的 chatKey（${other}）：已忽略（不许扩大范围）`);
  }
  return { scope, ignored };
}

/** 交叉检查：contracts 的版本号（scope 规则跟着合同走）。 */
export const CONTRACTS_SCHEMA_VERSION = SCHEMA_VERSION;

// 2026-11-05 改（她定的）：加跨房主体白名单（`data/memory/cross-scope-allow.json`，
// 默认只有 100000001）。她在私聊里和群里是同一个人，原来被切成两套画像——私聊记得她撒娇、
// 群里记得她直话，两边互不相识。现在按主体放开取回，别人的观察仍按房间隔离。
// 回滚：把 cross-scope-allow.json 的 subjects 清空即可，不用改代码。
