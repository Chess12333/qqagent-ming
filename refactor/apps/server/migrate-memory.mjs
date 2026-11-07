/**
 * 记忆迁移脚本：老树「群友印象」（`data/memory/**`）→ 新树 M6 账本
 * （`data/memory/{evidence,observations}.jsonl`）。
 *
 * 纪律照抄同目录的 `migrate-emotion-state.mjs`：
 *   · **默认 dry-run**：只讲"会做什么"，不写一个字节；真写要 `--apply`
 *   · **两道闸**：目标目录是仓库 `data/` / `data-2` 时还要 `--allow-production`
 *   · **不删任何老文件**、不改任何老文件；本脚本只**追加**新树账本（append-only 是账本设计）
 *   · **校验不过就拒绝落盘**：写完立刻回读（reload → stats → brief），任一步抛错即报失败
 *
 * ★ 为什么需要它：老树记忆**还在盘上**（`data/memory/people/*.json` 110 个 + 逐群逐人 41 个），
 *   而新树 M6 账本几乎是空的（`evidence.jsonl` 仅 1 行，`observations.jsonl` 根本不存在），
 *   且 `orchestrator/index.js:1390` 已经改用 `modules.memory.retrieve()` 喂提示词
 *   ⇒ 「它不记得这些人」是真的。
 *
 * ── 映射（能 1:1 搬的搬，搬不了的**逐类计数**丢弃，不发明规则）────────────────
 * 老树文件头注释说得很清楚（`src/memory.js:1-4`）：
 *   「群友印象：**全局按 QQ 号（人），不再按群分裂**」
 *   `{ userId, name, chats:[], impressions:[{content,createdAt}], favor, attitude, updatedAt }`
 *
 *   A) `data/memory/<chatKey>/<userId>.json` —— **逐群逐人**，有真实 chatKey
 *      → scope = chatScope(chatKey)（`private:` 前缀 ⇒ private，否则 group），chatKey = 目录名
 *   B) `data/memory/people/<file>.json` —— **人级聚合**，`chats[]` 只是"在哪些群出现过"，
 *      **不是**印象的归属（所以把一条印象摊到每个 chat 就是发明规则，不做）
 *      → scope = `global`
 *      → ★ 依据不是我的发明：新树 `modules/memory/scope.js:34-35` 写着
 *        「① 全局人物印象：跨群可用（**这是刻意设计，不许砍**）」—— 正是给这类数据预留的口。
 *      → `chats[]` 只用来**核对**（人级文件里出现过的会话），不作为归属写进观察。
 *
 *   每条 impression 合成**一条证据**（M6 不变量①「没有证据不许写」，而老树格式没有 evidence id）：
 *     evidence: { id, at=createdAt, chatKey, kind, speakerId=userId, speakerName,
 *                 sourceType='message', subjectIds=[userId], text=content }
 *     ⚠ `sourceType` 用模块自己的缺省 `'message'`（`store.js:normalizeEvidence`）：老树**没有记录来源**，
 *       所以这里**不假装知道**它是自述/转述/模型推测——统一按 message 记，并在报告里单列一条说明。
 *
 *   **搬不了、逐类计数的**（不静默丢）：
 *     favor / attitude / name / manuallyEditedAt / lastConsolidatedAt / chats[]
 *     —— M6 的 `OBS_TYPES` 里没有这些形状。
 *     其中 `favor` **不是丢了**：老树的 `migrate-emotion-state.mjs` 已把它迁到
 *     `emotion-state.json` 的 energy 维度（本脚本在报告里指向那个文件）。
 *
 * ── 明确不碰 ──────────────────────────────────────────────────────────────
 *   · `data/memory-v2/`（1602 chunk / 12MB，老树长期会话记忆）：**不读不写不删**。
 *     新树用自己的 `semantic.js` 索引，不兼容老格式。
 *   · 老树任何文件：不删、不改、不移动。
 *
 * 用法
 *   node refactor/apps/server/migrate-memory.mjs --data-dir <dir> [--apply] [--allow-production]
 * 不给 --data-dir 时读环境变量 QQ_AGENT_DATA_DIR。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as memory from '../../modules/memory/index.js';

const { values: args } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    apply: { type: 'boolean', default: false },
    'allow-production': { type: 'boolean', default: false },
    'keep-global-dups': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false }
  }
});

if (args.help) {
  console.log('用法: node refactor/apps/server/migrate-memory.mjs --data-dir <dir> [--apply] [--allow-production] [--keep-global-dups]');
  process.exit(0);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/** 老树格式没有 confidence 字段，而 M6 的 MemoryObservation 要它。
 *  这里用一个**明确标注的固定值**，并在报告里单列——不假装那是老树给过的置信度。 */
const MIGRATION_CONFIDENCE = 0.5;
/** 人级证据的 chatKey 哨兵：老树聚合文件**没有**逐条 chat 归属（`chats[]` 只是"出现过哪些群"），
 *  所以这里用一个显式哨兵而不是编一个群号。scope=global 时 `visibleIn` 不看 chatKey（scope.js:35）。 */
const GLOBAL_CHAT_KEY = 'global';

const dataDirRaw = args['data-dir'] || process.env.QQ_AGENT_DATA_DIR || '';
if (!dataDirRaw) {
  console.error('缺数据目录：请传 --data-dir，或设环境变量 QQ_AGENT_DATA_DIR');
  process.exit(2);
}
const dataDir = path.resolve(dataDirRaw);
const prodDirs = [path.join(REPO_ROOT, 'data'), path.join(REPO_ROOT, 'data-2')];
if (prodDirs.includes(dataDir) && !args['allow-production']) {
  console.error(`拒绝：${dataDir} 是生产数据目录。真要迁移请显式加 --allow-production（脚本只追加新账本，不动老文件）`);
  process.exit(3);
}
if (!fs.existsSync(dataDir)) { console.error(`数据目录不存在：${dataDir}`); process.exit(2); }

// ★ 必须先显式 configure：M6 的 `data-dir.js:63` 明确**拒绝**回落到 workspace 的 `data/`
//   （"不许回落到 workspace data/"），没有注入就直接抛。
memory.configure({ dataDir });

const legacyRoot = path.join(dataDir, 'memory');
const peopleDir = path.join(legacyRoot, 'people');
const memoryV2 = path.join(dataDir, 'memory-v2');

// ── 读老树文件（只读；坏文件计数后跳过）────────────────────────────────────
function readJson(file) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
}
function chatScopeOf(chatKey) {
  return String(chatKey).startsWith('private:') ? 'private' : 'group';
}
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const claimKeyOfLocal = (subjectId, claim) => `${subjectId}||${norm(claim).toLowerCase()}`;

const loss = {
  badPersonFile: 0, badChatFile: 0, emptyImpression: 0, noUserId: 0,
  favorNoHome: 0, attitudeNoHome: 0, nameNoHome: 0,
  manuallyEditedAtNoHome: 0, lastConsolidatedAtNoHome: 0,
  dupGlobalOfPerChat: 0
};
const plan = [];             // { subjectId, claim, scope, chatKey, at, evId, obsId, src }
const seenPerChat = new Set();
let peopleFiles = 0; let chatFiles = 0; let persons = 0; const chatKeys = new Set();

// A) 逐群逐人（有真实 chatKey）
if (fs.existsSync(legacyRoot)) {
  for (const entry of fs.readdirSync(legacyRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'people' || entry.name === 'backups') continue;
    const chatKey = entry.name;
    const dir = path.join(legacyRoot, entry.name);
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== '_meta.json'); }
    catch { continue; }
    for (const fname of names) {
      const file = path.join(dir, fname);
      const r = readJson(file);
      chatFiles += 1;
      if (!r.ok) { loss.badChatFile += 1; continue; }
      const rec = r.value || {};
      const userId = String(rec.userId || path.basename(fname, '.json')).trim();
      if (!userId) { loss.noUserId += 1; continue; }
      persons += 1; chatKeys.add(chatKey);
      const imps = Array.isArray(rec.impressions) ? rec.impressions : [];
      imps.forEach((imp, i) => {
        const claim = norm(imp?.content);
        if (!claim) { loss.emptyImpression += 1; return; }
        const at = Number(imp?.createdAt);
        const key = claimKeyOfLocal(userId, claim);
        seenPerChat.add(key);
        plan.push({
          subjectId: userId, claim, scope: chatScopeOf(chatKey), chatKey,
          at: Number.isFinite(at) && at > 0 ? at : 0,
          evId: `mig-ev:chat:${chatKey}:${userId}:${i}`,
          obsId: `mig-ob:chat:${chatKey}:${userId}:${i}`,
          src: 'per-chat'
        });
      });
    }
  }
}

// B) 人级聚合（scope=global）
if (fs.existsSync(peopleDir)) {
  for (const fname of fs.readdirSync(peopleDir).filter((f) => f.endsWith('.json'))) {
    const file = path.join(peopleDir, fname);
    const r = readJson(file);
    peopleFiles += 1;
    if (!r.ok) { loss.badPersonFile += 1; continue; }
    const rec = r.value || {};
    const userId = String(rec.userId || '').trim();
    if (!userId) { loss.noUserId += 1; continue; }
    persons += 1;
    // 无 M6 对应形状的字段：逐类计数（favor 另有去处，见报告）
    if (rec.favor !== undefined && rec.favor !== null) loss.favorNoHome += 1;
    if (rec.attitude !== undefined && rec.attitude !== null) loss.attitudeNoHome += 1;
    if (rec.name) loss.nameNoHome += 1;
    if (rec.manuallyEditedAt) loss.manuallyEditedAtNoHome += 1;
    if (rec.lastConsolidatedAt) loss.lastConsolidatedAtNoHome += 1;

    const imps = Array.isArray(rec.impressions) ? rec.impressions : [];
    imps.forEach((imp, i) => {
      const claim = norm(imp?.content);
      if (!claim) { loss.emptyImpression += 1; return; }
      if (!args['keep-global-dups'] && seenPerChat.has(claimKeyOfLocal(userId, claim))) {
        loss.dupGlobalOfPerChat += 1;   // 逐群版本更具体，global 重复的不再写
        return;
      }
      const at = Number(imp?.createdAt);
      plan.push({
        subjectId: userId, claim, scope: 'global', chatKey: GLOBAL_CHAT_KEY,
        at: Number.isFinite(at) && at > 0 ? at : 0,
        evId: `mig-ev:person:${userId}:${i}`,
        obsId: `mig-ob:person:${userId}:${i}`,
        src: 'person-global'
      });
    });
  }
}

const before = memory.stats({ dataDir });
const byScope = plan.reduce((acc, p) => { acc[p.scope] = (acc[p.scope] || 0) + 1; return acc; }, {});

// ── 报告 ────────────────────────────────────────────────────────────────────
console.log(`数据目录：${dataDir}`);
console.log(`模式：${args.apply ? '★ APPLY（会写入新账本）' : 'dry-run（不写任何字节）'}`);
console.log(`老树来源：people/*.json ${peopleFiles} 个 · 逐群逐人 ${chatFiles} 个 · 涉及 ${persons} 个人次 / ${chatKeys.size} 个会话`);
console.log(`拟写：evidence ${plan.length} 行 · observation ${plan.length} 行 · 按 scope ${JSON.stringify(byScope)}`);
console.log(`新树账本现状：evidence ${before.evidence} · observations ${before.observations} · active ${before.active} · badLines ${before.badLines}`);
console.log('');
console.log('搬不了 / 被丢弃的（逐类计数，不静默丢）：');
for (const [k, v] of Object.entries(loss)) if (v) console.log(`  ${k}: ${v}`);
console.log(`  favor 的去处：不在这里 —— 老树的 migrate-emotion-state.mjs 已把它迁到 emotion-state.json 的 energy 维度`);
console.log('');
console.log('说明：');
console.log(`  · sourceType 一律记 'message'：老树格式**没有记录来源**，不假装知道是自述/转述/模型推测`);
console.log(`  · confidence 一律记 ${MIGRATION_CONFIDENCE}（占位）：老树没有这个字段，**不是**老树给过的置信度`);
console.log(`  · 人级证据的 chatKey 记哨兵 '${GLOBAL_CHAT_KEY}'：老树聚合文件没有逐条 chat 归属（chats[] 只是"出现过哪些群"）`);
console.log(`  · data/memory-v2/ **不读不写不删**（${fs.existsSync(memoryV2) ? '存在' : '不存在'}）；新树用自己的 semantic.js 索引`);

if (!args.apply) {
  console.log('\n（dry-run 结束。要真写：加 --apply；目标是仓库 data/ 的话还要 --allow-production）');
  process.exit(0);
}

// ── 写入（apply）────────────────────────────────────────────────────────────
console.log('\n写入中…');
const evRows = plan.map((p) => ({
  id: p.evId,
  at: p.at || Date.now(),          // 老数据没 createdAt 时才用现在（报告里已说明）
  chatKey: p.chatKey,
  kind: p.scope === 'private' ? 'private' : 'group',
  senderId: p.subjectId,
  senderName: '',
  sourceType: 'message',
  subjectIds: [p.subjectId],
  text: p.claim
}));
// ⚠ recordEvidence 是 **async**，必须 await：漏了 await 拿到的是 Promise，
//   `promise.ok` 是 undefined ⇒ 会误判成"入账失败"（这个闸门确实挡住了，但报错信息是错的）。
const evRes = await memory.recordEvidence(evRows, { dataDir });
if (!evRes?.ok) {
  console.error(`证据入账失败，拒绝继续：${JSON.stringify(evRes?.invalid ?? evRes ?? null).slice(0, 400)}`);
  process.exit(4);
}
console.log(`证据：新增 ${evRes.added.length} · 重复 ${evRes.duplicate.length} · 非法 ${evRes.invalid.length}`);

let ok = 0; let dup = 0; const failures = [];
for (const p of plan) {
  const res = await memory.commit({
    id: p.obsId, subjectId: p.subjectId, claim: p.claim,
    type: 'impression', scope: p.scope, chatKey: p.chatKey,
    evidenceIds: [p.evId], confidence: MIGRATION_CONFIDENCE,
    at: p.at || undefined
  }, { dataDir, idempotencyKey: p.obsId });
  if (res.ok) { if (res.duplicate) dup += 1; else ok += 1; }
  else failures.push({ id: p.obsId, errors: res.errors });
}
console.log(`观察：写入 ${ok} · 重复 ${dup} · 失败 ${failures.length}`);
if (failures.length) console.error(`失败样例：${JSON.stringify(failures.slice(0, 3)).slice(0, 500)}`);

// ── 校验（回灌 + 真的能被读出来）─────────────────────────────────────────────
memory.resetMemory(dataDir);
memory.reload(dataDir);
const after = memory.stats({ dataDir });
let briefOk = false; let briefItems = 0; let briefErr = null;
try {
  const b = await memory.brief({ dataDir, need: { limit: 50 } });
  briefItems = b?.items?.length || 0;
  briefOk = Array.isArray(b?.items);
} catch (error) { briefErr = String(error?.message ?? error); }
const people = new Set(plan.map((p) => p.subjectId)).size;

console.log('\n校验：');
console.log(`  reload + stats：evidence ${before.evidence} → ${after.evidence} · observations ${before.observations} → ${after.observations} · active ${before.active} → ${after.active}`);
console.log(`  brief() 可读：${briefOk ? '是' : '★否 ' + (briefErr || '')} · items ${briefItems}`);
console.log(`  迁移涉及的人：${people} 个（/api/memory-people 按 subjectId 分组列出）`);
console.log(`  ⚠ /api/memory-people 走 brief() 且**默认 limit=5**（console-api.js:756 调 brief() 不传 limit）`);
console.log(`     ⇒ 端点最多列 5 条 item；要看到全部 ${people} 个人得给 brief 传 need.limit（本票域外，未改）`);
console.log(`  ⚠ 语义索引：createSemanticIndex **强制要求注入真 embedder**（semantic.js:845 缺则抛 not-ready，`);
console.log(`     且明确拒绝自动替换；假 embedder 会污染索引）⇒ 本脚本**不重建**索引。`);
console.log(`     而且 rebuildSemanticIndex 在生产链路上**没有调用点**（只有 re-export 与 selftest）⇒ 属另一处缺口。`);
console.log(`     迁移后检索走关键词路径；要语义召回需另派活把索引接上。`);

const allOk = failures.length === 0 && briefOk && after.observations >= before.observations;
console.log(`\n结果：${allOk ? '迁移完成并通过校验' : '★ 有问题，见上（老文件一律未动）'}`);
process.exit(allOk ? 0 : 5);
