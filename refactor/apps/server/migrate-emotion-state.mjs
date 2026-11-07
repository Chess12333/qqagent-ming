/**
 * 情绪/关系状态迁移：旧树 `bot-state.json` + `memory/people/*.json` → 新树 `emotion-state.json`
 *
 * 依据：T-CUTOVER-4 回执 §B/§D（qwen2 4fef70f6）。
 *   能 1:1 搬的：`energy{pools}`（只差键名）、`mood`/`arousal`、`acuteStress`/`chronicStress`、
 *                以及 people 文件的 `favor`（两边都是 0~100、50 中性）
 *   搬不了的（**如实丢弃，不发明规则**）：`emotions{14}` → `affect{6}`、`attitude`/`impressions`/
 *                `surface`（自由文本）、`familiarity`（★ 2026-10-16 用户裁定已整体退役：
 *                本脚本从不写它；若任何输入里带了它，也一律忽略，不写入 emotion-state.json）
 *
 * 纪律：
 *   - **默认 dry-run**，只打印"会写什么"，不落盘；要写必须显式 `--apply`。
 *   - **不删不改旧文件**（旧树还在写它们；删属 L3，留给用户）。
 *   - 校验不过就拒绝落盘（人数/逐条 favor 相等/回灌 initState 不抛/roleStatement 不动池子）。
 *   - 生产数据目录需要显式 `--allow-production`（照抄 apps/server/paths.js 的闸语义）。
 *
 * 用法：
 *   node refactor/apps/server/migrate-emotion-state.mjs --data-dir <dir> [--apply] [--allow-production]
 *   不带 --data-dir 时用 QQ_AGENT_DATA_DIR。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as emotion from '../../modules/emotion/index.js';
import { writeJsonAtomic } from '../../core/util/index.js';

const { values: args } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    apply: { type: 'boolean', default: false },
    'allow-production': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false }
  }
});

if (args.help) {
  console.log(`用法: node refactor/apps/server/migrate-emotion-state.mjs --data-dir <dir> [--apply] [--allow-production]`);
  process.exit(0);
}

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '..');
const dataDirRaw = args['data-dir'] || process.env.QQ_AGENT_DATA_DIR || '';
if (!dataDirRaw) {
  console.error('缺少数据目录：请传 --data-dir，或设 QQ_AGENT_DATA_DIR');
  process.exit(2);
}
const dataDir = path.resolve(dataDirRaw);
const prodDirs = [path.join(REPO_ROOT, 'data'), path.join(REPO_ROOT, 'data-2')];
if (prodDirs.includes(dataDir) && !args['allow-production']) {
  console.error(`拒绝：${dataDir} 是生产数据目录。确认要迁移请加 --allow-production（脚本只新增 emotion-state.json，不动旧文件）`);
  process.exit(3);
}

const botStateFile = path.join(dataDir, 'bot-state.json');
const peopleDir = path.join(dataDir, 'memory', 'people');
const outFile = path.join(dataDir, 'emotion-state.json');

if (!fs.existsSync(dataDir)) { console.error(`数据目录不存在：${dataDir}`); process.exit(2); }
if (fs.existsSync(outFile)) {
  console.error(`已存在 ${outFile} —— 迁移不覆盖既有新状态。要重做请先手工备份并删除它。`);
  process.exit(4);
}

const warnings = [];
const input = { at: Date.now(), self: {}, persons: {} };

// ── ① 自身状态 ─────────────────────────────────────────────────────────
let oldSelf = null;
if (fs.existsSync(botStateFile)) {
  oldSelf = JSON.parse(fs.readFileSync(botStateFile, 'utf8'));
  const pools = oldSelf.energy || {};
  input.self = {
    pools: { physical: pools.physical, cognitive: pools.cognitive, emotional: pools.emotional, will: pools.will },
    mood: oldSelf.mood,
    arousal: oldSelf.arousal,
    acuteStress: oldSelf.acuteStress,
    chronicStress: oldSelf.chronicStress
  };
  if (oldSelf.emotions) {
    warnings.push(`旧 emotions 有 ${Object.keys(oldSelf.emotions).length} 类，新 M7 只有 6 类 affect 且无归并规则 ⇒ 如实丢弃（不发明映射）`);
  }
} else {
  warnings.push(`${botStateFile} 不存在 ⇒ 自身状态用默认值`);
}

// ── ② 关系（每人一个文件；只搬 favor）────────────────────────────────────
let peopleCount = 0;
const favors = new Map();
if (fs.existsSync(peopleDir)) {
  for (const file of fs.readdirSync(peopleDir)) {
    if (!file.endsWith('.json')) continue;
    let person;
    try {
      person = JSON.parse(fs.readFileSync(path.join(peopleDir, file), 'utf8'));
    } catch (error) {
      warnings.push(`${file} 读不动，跳过：${error?.message ?? error}`);
      continue;
    }
    const userId = String(person?.userId ?? path.basename(file, '.json'));
    if (!userId) { warnings.push(`${file} 没有 userId，跳过`); continue; }
    const favor = Number(person?.favor);
    if (!Number.isFinite(favor)) { warnings.push(`${file} 的 favor 不是数字，跳过`); continue; }
    favors.set(userId, favor);
    input.persons[userId] = { favor, lastSeenAt: Number(person?.updatedAt) || 0 };
    peopleCount += 1;
    for (const [field, note] of [['attitude', '自由文本'], ['impressions', '自由文本']]) {
      if (person?.[field] && (Array.isArray(person[field]) ? person[field].length : true)) {
        warnings.push(`${userId} 的 ${field}（${note}）不进 M7 —— 属 M6 的职责`);
      }
    }
  }
} else {
  warnings.push(`${peopleDir} 不存在 ⇒ 没有任何关系可搬`);
}

// ── ③ 构造 + 校验 ──────────────────────────────────────────────────────
let state;
try {
  state = emotion.initState(input);
} catch (error) {
  console.error('initState 失败，拒绝落盘：', error?.message ?? error);
  process.exit(5);
}

const problems = [];
if (Object.keys(state.persons).length !== peopleCount) {
  problems.push(`人数不一致：people 文件 ${peopleCount} / 迁移后 persons ${Object.keys(state.persons).length}`);
}
for (const [userId, favor] of favors) {
  const got = state.persons[userId]?.favor;
  if (Number(got) !== Number(favor)) problems.push(`${userId} favor 不等：旧 ${favor} → 新 ${got}`);
}
if (Number.isFinite(Number(input.self.mood)) && Number(state.self.mood) !== Number(input.self.mood)) {
  problems.push(`mood 不等：旧 ${input.self.mood} → 新 ${state.self.mood}`);
}
for (const pool of ['physical', 'cognitive', 'emotional', 'will']) {
  const old = Number(input.self.pools?.[pool]);
  if (Number.isFinite(old) && Number(state.self.pools[pool]) !== old) problems.push(`pools.${pool} 不等：旧 ${old} → 新 ${state.self.pools[pool]}`);
}
// roleStatement 不许动池子（验收 #13：模型自己说的话不改数值）
const beforePools = JSON.stringify(state.self.pools);
try {
  emotion.applyEvent(state, { type: 'roleStatement', at: Date.now(), claim: '我刚睡醒', evidenceIds: ['migration-probe'], source: 'emotion-evidence' });
} catch { /* roleStatement 不需要证据，抛了就是别的问题，下面用池子不变性判 */ }
const afterPools = JSON.stringify(state.self.pools);
if (beforePools !== afterPools) problems.push('roleStatement 改动了 pools（违反"说法不改数值"）');
try {
  emotion.snapshot(state);
} catch (error) {
  problems.push(`snapshot 抛错：${error?.message ?? error}`);
}

console.log('=== 情绪状态迁移（' + (args.apply ? 'APPLY' : 'DRY-RUN') + '）===');
console.log(`  数据目录   : ${dataDir}`);
console.log(`  旧自身状态 : ${fs.existsSync(botStateFile) ? '有' : '无'}`);
console.log(`  旧关系人数 : ${peopleCount}`);
console.log(`  目标文件   : ${outFile}`);
console.log(`  迁移后自身 : mood=${state.self.mood} arousal=${state.self.arousal} pools=${JSON.stringify(state.self.pools)}`);
console.log(`  迁移后关系 : ${Object.keys(state.persons).length} 人（favor 逐条核对）`);
for (const warning of warnings) console.log(`  ⚠ ${warning}`);
if (problems.length) {
  console.error('校验不过，拒绝落盘：');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(6);
}
console.log('  校验       : 通过（人数/逐条 favor/pools/roleStatement 不动池子/snapshot 不抛）');

if (!args.apply) {
  console.log('  （dry-run：没有写任何文件。确认真要写就加 --apply）');
  process.exit(0);
}
writeJsonAtomic(outFile, state);
console.log(`  ✅ 已写入 ${outFile}（旧文件一个都没动）`);
