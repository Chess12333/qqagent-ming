/**
 * refactor/modules/emotion/e2-teeth.mjs —— 票 E-2 的**本票牙**（情绪三条规格漂移）
 *
 * 跑法：node refactor/modules/emotion/e2-teeth.mjs     （EXIT 0 = 全过；1 = 有断言红）
 *
 * 它验的是什么（三条漂移 + 两条不许越界的线）：
 *   1 情绪池半衰 ≈ 4′   —— 12 分钟静置后残差必须 ≤ 0.125×初偏差 + 容差（改前 15′ ⇒ 残差 8.6，必红）
 *   2 意志池半衰 ≈ 25′  —— 25 分钟静置后残差必须落 8~12（改前 15′ ⇒ 6.3，必红）
 *   3 身体/认知**不受影响** —— 仍走 15′，且投影值与"按 15′ 手算"逐位相同（防"一改全改"）
 *   4 认知软地板 —— 同一轮成本，认知 10 起步的跌幅 ≤ 0.5×高起步的跌幅（消息本身不再扣池，
 *     成本走 `round` 事件按发送条数一次算，2026-10-15 用户裁定 · 情绪缺口第二组）
 *   5 不越界 —— 四池初值 65/60/60/55、情绪与意志的恢复目标恒 55（规格口径不许被顺手改掉）
 *   6 台账可回溯 —— 台账尾 10 行每行都有 source 与**非空** evidenceIds（P5 的副作用回归网）
 *   7 未知类别照旧抛错（`halfLifeOf` 与 `poolHalfLifeOf` 都不许兜底）
 *
 * 数据卫生：纯内存 + 合成证据（`contracts.makeMessageEvidence`），**不读不写真实 data/**。
 * 时间全部由入参给，模块自己不读时钟 ⇒ 本文件没有 Date.now()。
 */
import assert from 'node:assert';
import { makeMessageEvidence } from '../../contracts/index.js';
import {
  initState, applyEvent, project, snapshot, styleHint, DEFAULT_POOLS, targetsFor,
  cognitiveDrainScale, HALF_LIFE_MIN, poolHalfLifeOf, POOL_HALF_LIFE_CATEGORY
} from './index.js';
import { halfLifeOf, decayToward } from './half-life.js';

const MIN = 60 * 1000;
const AT0 = 1778853600000;
const RESID_TOL = 0.4;

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${String(e && e.message || e)}`); }
}

const evEv = (at, deltas, ev) => ({
  type: 'emotionEvidence', at, deltas, magnitude: 1, source: 'emotion-evidence', evidenceIds: [ev]
});
const msgAt = (at, id, text) => ({
  type: 'message', at,
  evidence: makeMessageEvidence({
    id, at, chatKey: 'e2-synthetic', kind: 'group', selfId: 'bot',
    sender: { id: 'u-e2', name: 'synthetic' }, text,
    mentions: [], refs: { toSelf: false, quoted: null, replyTo: null }, media: [], botSaidBefore: []
  })
});
// ★ 2026-10-15：池成本从"逐条消息"改为"整轮按发送条数一次算"（老树 applyRunToBotState:1157-1164）
//   ⇒ 下面凡是验池子消耗的用例都改用轮事件；addressed=true 用来把环境事件隔离开。
const roundAt = (at, fields = {}) => ({
  type: 'round', at, evidenceIds: [`e2-round-${at}`], addressed: true, kind: 'group',
  sentCount: 3, triggerCount: 1, ...fields
});
const poolOf = (st, k) => snapshot(st).self.pools[k].value;
const targetOf = (st, k) => snapshot(st).self.pools[k].restoreTarget;

console.log('E-2 情绪三条漂移 · 牙\n');

// ── 1 情绪池半衰 ≈ 4′ ────────────────────────────────────────────────────────
check('1a 情绪池 12 分钟残差 ≤ 2.9（规格 4′；15′ 会残 8.6）', () => {
  let s = initState({ at: AT0 });
  s = applyEvent(s, evEv(AT0, { 'pools.emotional': -20 }, 'e2-t1'));
  const T = targetOf(s, 'emotional');
  const v = poolOf(project(s, AT0 + 12 * MIN), 'emotional');
  const resid = Math.abs(v - T);
  assert.ok(resid <= 0.125 * 20 + RESID_TOL, `residual=${resid.toFixed(2)} bound=${(0.125 * 20 + RESID_TOL).toFixed(2)} T=${T} v=${v}`);
});
check('1b 情绪池半衰键是具名的 4（不是 energy 15）', () => {
  assert.strictEqual(HALF_LIFE_MIN.emotionPool, 4);
  assert.strictEqual(poolHalfLifeOf('emotional'), 4);
  assert.strictEqual(POOL_HALF_LIFE_CATEGORY.emotional, 'emotionPool');
});

// ── 2 意志池半衰 ≈ 25′ ───────────────────────────────────────────────────────
check('2a 意志池 25 分钟残差落 8~12（规格 25′；15′ 只残 6.3）', () => {
  let s = initState({ at: AT0 });
  s = applyEvent(s, evEv(AT0, { 'pools.will': -20 }, 'e2-t2'));
  const T = targetOf(s, 'will');
  const v = poolOf(project(s, AT0 + 25 * MIN), 'will');
  const resid = Math.abs(v - T);
  assert.ok(resid >= 0.4 * 20 - RESID_TOL && resid <= 0.6 * 20 + RESID_TOL,
    `residual=${resid.toFixed(2)} want=8-12 T=${T} v=${v}`);
});
check('2b 意志池半衰键是具名的 25（不是 energy 15）', () => {
  assert.strictEqual(HALF_LIFE_MIN.willPool, 25);
  assert.strictEqual(poolHalfLifeOf('will'), 25);
});

// ── 3 身体/认知不受影响（防"一改全改"） ──────────────────────────────────────
check('3a 身体/认知仍走 15 分钟', () => {
  assert.strictEqual(poolHalfLifeOf('physical'), 15);
  assert.strictEqual(poolHalfLifeOf('cognitive'), 15);
  assert.strictEqual(HALF_LIFE_MIN.energy, 15, '既有键 energy 不得被改名或改值');
});
check('3b 身体/认知投影值与"按 15′ 手算"逐位相同', () => {
  let s = initState({ at: AT0 });
  s = applyEvent(s, evEv(AT0, { 'pools.physical': -20, 'pools.cognitive': -20 }, 'e2-t3'));
  for (const k of ['physical', 'cognitive']) {
    const before = poolOf(s, k);
    const T = targetOf(s, k);
    const at = AT0 + 4 * MIN;
    const want = Math.round((T + (before - T) * Math.pow(0.5, 4 / halfLifeOf('energy'))) * 10) / 10;
    const got = poolOf(project(s, at), k);
    assert.strictEqual(got, want, `${k}: 投影 ${got} ≠ 按 15′ 手算 ${want}`);
  }
});
check('3c 认知涨（回血）不打折 —— 与改前逐位相同', () => {
  let s = initState({ at: AT0, self: { pools: { cognitive: 30 } } });
  s = applyEvent(s, evEv(AT0, { 'pools.cognitive': 20 }, 'e2-t3c'));
  assert.strictEqual(poolOf(s, 'cognitive'), 50, '涨 20 必须到 50（软地板只管扣）');
});

// ── 4 认知软地板 ─────────────────────────────────────────────────────────────
check('4a 同一轮成本：认知 10 起步的跌幅 ≤ 0.5× 高起步的跌幅', () => {
  const low = applyEvent(initState({ at: AT0, self: { pools: { physical: 65, cognitive: 10, emotional: 60, will: 55 } } }),
    roundAt(AT0, { sentCount: 3, evidenceIds: ['e2-low'] }));
  const high = applyEvent(initState({ at: AT0 }), roundAt(AT0, { sentCount: 3, evidenceIds: ['e2-high'] }));
  const dropLow = Math.round((10 - poolOf(low, 'cognitive')) * 10) / 10;
  const dropHigh = Math.round((60 - poolOf(high, 'cognitive')) * 10) / 10;
  assert.ok(dropLow <= 0.5 * dropHigh, `low=${dropLow} high=${dropHigh}（软地板：低起步折 0.25）`);
});
check('4b 软地板是公式不是开关：scale 随值单调不减、v≥60 恒 1、v→0 不为 0', () => {
  assert.strictEqual(cognitiveDrainScale(60), 1);
  assert.strictEqual(cognitiveDrainScale(100), 1);
  assert.strictEqual(cognitiveDrainScale(0), 0.25, '不许硬截断到 0（那会锁死）');
  assert.strictEqual(cognitiveDrainScale(20), 0.25);
  assert.strictEqual(cognitiveDrainScale(40), 0.5);
  assert.strictEqual(cognitiveDrainScale(NaN), 0.25, '读不到数值 ⇒ 走最保守');
  let prev = -Infinity;
  for (let v = 0; v <= 100; v += 1) {
    const s = cognitiveDrainScale(v);
    assert.ok(s >= prev, `scale 在 v=${v} 反而变小（值越高折扣越轻，必须单调不减）`);
    assert.ok(s >= 0.25 && s <= 1, `scale 越界：${s}`);
    prev = s;
  }
});
check('4c 只有认知被软地板打折：轮成本下身体/意志/情绪跌幅与起步值无关', () => {
  const lowAll = applyEvent(initState({ at: AT0, self: { pools: { physical: 20, cognitive: 10, emotional: 20, will: 20 } } }),
    roundAt(AT0, { sentCount: 6, evidenceIds: ['e2-nf-low'] }));
  const highAll = applyEvent(initState({ at: AT0 }), roundAt(AT0, { sentCount: 6, evidenceIds: ['e2-nf-high'] }));
  // 三条非认知池：低起步 20 vs 高起步 65/60/55 —— 跌幅必须相同（不打折），且必须真的动了
  assert.strictEqual(poolOf(lowAll, 'physical') - 20, poolOf(highAll, 'physical') - 65, '身体池跌幅被改了');
  assert.strictEqual(poolOf(lowAll, 'emotional') - 20, poolOf(highAll, 'emotional') - 60, '情绪池跌幅被改了');
  assert.strictEqual(poolOf(lowAll, 'will') - 20, poolOf(highAll, 'will') - 55, '意志池跌幅被改了');
  assert.ok(poolOf(lowAll, 'physical') < 20 && poolOf(lowAll, 'emotional') < 20 && poolOf(lowAll, 'will') < 20,
    '轮成本必须真的扣到身体/情绪/意志三池');
  // 认知相反：低起步跌幅被软地板压小
  const cogDropLow = Math.round((10 - poolOf(lowAll, 'cognitive')) * 10) / 10;
  const cogDropHigh = Math.round((60 - poolOf(highAll, 'cognitive')) * 10) / 10;
  assert.ok(cogDropLow < cogDropHigh, `认知低起步应扣得更少：low=${cogDropLow} high=${cogDropHigh}`);
});
check('4d 多轮成本仍能把精力压进"简短回答"档，少量轮不触发', () => {
  // 16 轮 × sentCount 3（认知 -2/轮，带软地板）⇒ 认知 ~44 （< 目标 64-18=46）⇒ 触发；
  // 3 轮 × sentCount 1 ⇒ ~58，不触发。addressed=true 隔离环境事件，只验成本路径。
  let s = initState({ at: AT0 });
  for (let i = 0; i < 16; i++) s = applyEvent(s, roundAt(AT0 + i * MIN, { sentCount: 3, evidenceIds: [`e2-rd${i}`] }));
  assert.ok(styleHint(s).includes('简短回答'), `十六轮后 hint=${JSON.stringify(styleHint(s))} cognitive=${poolOf(s, 'cognitive')}`);
  let t = initState({ at: AT0 });
  for (let i = 0; i < 3; i++) t = applyEvent(t, roundAt(AT0 + i * MIN, { sentCount: 1, evidenceIds: [`e2-rs${i}`] }));
  assert.ok(!styleHint(t).includes('简短回答'), `三轮不该触发：${JSON.stringify(styleHint(t))} cognitive=${poolOf(t, 'cognitive')}`);
});
check('4e 结算步长里"向下走"也要软（规格说"每个结算步长"）—— 夜里认知 55 回落比不打折时慢', () => {
  const at0 = Date.UTC(2026, 4, 15, 3, 0, 0);   // 夜里档：认知目标 45 < 55 ⇒ 这一步是向下走
  let s = initState({ at: at0, self: { pools: { cognitive: 55 } } });
  const T = targetOf(s, 'cognitive');
  assert.ok(T < 55, `前置条件不成立：夜里认知目标 ${T} 不低于 55，这一步不是向下走`);
  const before = poolOf(s, 'cognitive');
  const raw = T + (before - T) * Math.pow(0.5, 10 / halfLifeOf('energy'));  // 不打折的手算值
  const got = poolOf(project(s, at0 + 10 * MIN), 'cognitive');
  assert.ok(got > raw, `向下走没有被软化：得到 ${got} ≤ 不打折的 ${raw.toFixed(2)}`);
  assert.ok(got < before, `必须真的往下走：${got} !< ${before}`);
  assert.ok(got > T, `不许越过目标：${got} ≤ ${T}`);
  assert.strictEqual(cognitiveDrainScale(before), 0.875, 'v=55 的折扣系数应恰好是 0.875');
});
check('4f 认知向上（回血）不受结算步长软化影响 —— 与改前逐位相同', () => {
  const at0 = Date.UTC(2026, 4, 15, 14, 0, 0);  // 下午档：认知目标 64 > 30 ⇒ 这一步是向上走
  let s = initState({ at: at0, self: { pools: { cognitive: 30 } } });
  const before = poolOf(s, 'cognitive');
  const T = targetOf(s, 'cognitive');
  const at = at0 + 10 * MIN;
  const want = Math.round((T + (before - T) * Math.pow(0.5, 10 / halfLifeOf('energy'))) * 10) / 10;
  assert.strictEqual(poolOf(project(s, at), 'cognitive'), want, '向上走必须与改前逐位相同');
});

// ── 5 不越界：规格口径不许被顺手改掉 ──────────────────────────────────────────
check('5a 四池初值仍是 65/60/60/55', () => {
  assert.deepStrictEqual({ ...DEFAULT_POOLS }, { physical: 65, cognitive: 60, emotional: 60, will: 55 });
  const s = snapshot(initState({ at: AT0 })).self.pools;
  assert.deepStrictEqual(
    { physical: s.physical.value, cognitive: s.cognitive.value, emotional: s.emotional.value, will: s.will.value },
    { physical: 65, cognitive: 60, emotional: 60, will: 55 }
  );
});
check('5b 情绪与意志的恢复目标全天恒 55', () => {
  for (let h = 0; h < 24; h++) {
    const t = targetsFor(Date.UTC(2026, 4, 15, h));
    assert.strictEqual(t.emotional, 55, `${h} 点情绪目标被改了：${t.emotional}`);
    assert.strictEqual(t.will, 55, `${h} 点意志目标被改了：${t.will}`);
  }
});

// ── 6 台账可回溯 + 「聊天引起的」与「时间引起的」能一眼分开（裁定①） ────────────
// ⚠ 台账对外只投影 `snapshot().recentChanges`（尾 20 行，view.js），本组牙一律从那里读。
const ledgerOf = (state) => snapshot(state).recentChanges || [];
check('6a 台账尾 10 行每行都有 source 与非空 evidenceIds', () => {
  let s = initState({ at: AT0 });
  for (let i = 0; i < 10; i++) {
    const at = AT0 + i * MIN;
    s = applyEvent(s, {
      type: 'relationDelta', at, personId: 'u-e2', changes: { trust: 12 },
      idempotencyKey: `e2-rel-${at}`, roundId: `e2-round-${at}`, reason: 'help',
      source: 'emotion-evidence', evidenceIds: [`e2-ev-rel-${i}`]
    });
  }
  const tail = snapshot(s).recentChanges.slice(-10);
  assert.ok(tail.length > 0, '台账尾 10 行是空的');
  for (const r of tail) {
    assert.ok(r.source, `seq=${r.seq} field=${r.field} 没有 source`);
    assert.ok(Array.isArray(r.evidenceIds) && r.evidenceIds.length > 0,
      `seq=${r.seq} field=${r.field} 的 evidenceIds 是空的（变化必须可回溯）`);
  }
});
check('6b decay 行自报家门：kind=decay + deterministic=true + decay@ 重算键 + source=time', () => {
  let s = initState({ at: AT0 });
  s = applyEvent(s, evEv(AT0, { 'pools.emotional': -20 }, 'e2-decay-1'));
  s = project(s, AT0 + MIN);   // 再走一个结算步：情绪池 4′ 半衰 ⇒ 这一分钟就回落 ~3.2 ⇒ 必过 0.5 阈值
  const rows = ledgerOf(s).filter((r) => r.kind === 'decay');
  assert.ok(rows.length > 0, `推了 -20 的情绪池，走了一步结算却没有 decay 行（实际行：${JSON.stringify(ledgerOf(s).map((r) => r.field))}）`);
  for (const r of rows) {
    assert.strictEqual(r.deterministic, true, `decay 行必须标 deterministic（可重算）：seq=${r.seq}`);
    assert.strictEqual(r.source, 'time', `decay 行的 source 应是 time：${r.source}`);
    assert.ok(/^decay@/.test(r.evidenceIds[0]), `decay 行的证据槽必须是 decay@ 重算键：${JSON.stringify(r.evidenceIds)}`);
  }
});
check('6c 轮事件引起的行不许冒充 decay：kind=event + deterministic=false', () => {
  let s = initState({ at: AT0 });
  s = applyEvent(s, roundAt(AT0, { sentCount: 3, evidenceIds: ['e2-enum-round'] }));
  const rows = ledgerOf(s).filter((r) => r.field !== 'relax');
  assert.ok(rows.length > 0, '一轮成本至少该记一行池子变化');
  for (const r of rows) {
    assert.strictEqual(r.kind, 'event', `轮引起的行 kind 应是 event：${r.kind}`);
    assert.strictEqual(r.deterministic, false, '轮引起的行必须 deterministic=false（它依赖外部证据）');
  }
});
check('6d 两类行在同一本台账里能分开数（P3 同款场景两类都非零）', () => {
  let s = initState({ at: AT0 });
  for (let i = 0; i < 10; i++) {
    const at = AT0 + i * MIN;
    s = applyEvent(s, {
      type: 'relationDelta', at, personId: 'u-e2', changes: { trust: 12 },
      idempotencyKey: `e2-split-${at}`, roundId: `e2-split-r-${at}`, reason: 'help',
      source: 'emotion-evidence', evidenceIds: [`e2-split-ev-${i}`]
    });
  }
  const all = ledgerOf(s);
  const decay = all.filter((r) => r.kind === 'decay');
  const event = all.filter((r) => r.kind === 'event');
  assert.ok(event.length > 0, '没有 event 行');
  assert.ok(decay.length > 0, 'P3 同款场景里应当出现 decay 行（这正是顶红 EM-P3-1 的那批）');
});
check('6e kind 是封闭小集合、deterministic 是布尔（不许塞自由文本）', () => {
  let s = initState({ at: AT0 });
  s = applyEvent(s, msgAt(AT0, 'e2-enum', '嗯'));
  s = applyEvent(s, evEv(AT0, { 'pools.will': -5 }, 'e2-enum-2'));
  for (const r of ledgerOf(s)) {
    assert.ok(['event', 'decay'].includes(r.kind), `kind 越出封闭集合：${r.kind}`);
    assert.strictEqual(typeof r.deterministic, 'boolean', `deterministic 必须是布尔：${typeof r.deterministic}`);
  }
  const shown = snapshot(s).recentChanges;
  assert.ok(shown.length > 0 && shown.every((r) => 'kind' in r && 'deterministic' in r),
    'snapshot 投影里必须带 kind/deterministic，否则 UI 看不到分开的两类');
});

// ── 7 未知类别照旧抛错（不许把新键塞进 energy 的别名里蒙混） ────────────────────
check('7a 未知半衰期类别抛错', () => {
  assert.throws(() => halfLifeOf('nope'), /未知半衰期类别/);
  assert.throws(() => halfLifeOf('energyPool'), /未知半衰期类别/);
});
check('7b 未知精力池抛错', () => {
  assert.throws(() => poolHalfLifeOf('nope'), /未知精力池/);
  assert.throws(() => poolHalfLifeOf(''), /未知精力池/);
});

console.log(`\nE-2 牙：${failed ? `${failed} 条红` : '全绿'}`);
process.exitCode = failed ? 1 : 0;