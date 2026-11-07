// 记忆变更审计：好感/印象写了什么，随时能翻。
// 追加写 data/memory/audit.jsonl，不进提示词，默认只给 UI。
//
// ★ 搬运说明（README §3.5 的归口决定：memory-audit 归 M6 memory）：
//   本文件是 `src/memory-audit.js` 的**真拷贝**（fs.copyFileSync + nlink===1 断言，
//   见回执），只改了下面两处 —— 语义（NON_MEMORY_TYPES 过滤 / 200 行上限 / memory·favor·all
//   分类 / userId 过滤 / 坏行跳过 / 失败不影响主流程）**一个字没改**：
//     ① import 路径：`./config.js` 的 `DATA_DIR` → 本模块 `./data-dir.js` 的解析
//        （**只认显式注入**：调用参数 / configure / `QQ_AGENT_DATA_DIR`；都没有就抛错）。
//        为什么不直接具名导入 `core/config-store` 的 `DATA_DIR`：① M1 还没导出它，具名 import 会
//        链接期 SyntaxError，整个 memory 模块都起不来；② 更要紧的是 —— 经 `snapshot()` 走
//        config-store 会**懒加载**出仓库根 `data/` 这个生产目录（2026-10-04 的真实事故），
//        所以 `data-dir.js` 里连这两条兜底都删了。详见该文件顶部复盘。
//        也不给测试注入 `.tmp-refactor/` 之外的任何目录（铁律：测试只写 .tmp-refactor/）。
//     ② FILE 从"模块加载期常量"改为"调用期解析"（同一个 `<dataDir>/memory/audit.jsonl`），
//        否则注入 dataDir 对已加载的模块无意义。
import fs from 'node:fs';
import { memoryFile, ensureMemoryDir } from './data-dir.js';

const FILE_NAME = 'audit.jsonl';
const MAX_ROWS = 200;
const NON_MEMORY_TYPES = new Set([
  'image_lib_save', 'favor_view',
  'knowledge_expire', 'knowledge_pin', 'knowledge_unpin', 'knowledge_save', 'knowledge_adopt'
]);

function ensure() {
  ensureMemoryDir();
}

/** 追加一条审计。source: manual | favor_tool | consolidator | append | remove | import */
export function logMemoryChange(entry) {
  try {
    ensure();
    const row = {
      ts: Date.now(),
      at: new Date().toISOString(),
      ...entry
    };
    fs.appendFileSync(memoryFile(FILE_NAME), `${JSON.stringify(row)}\n`, 'utf8');
  } catch { /* 审计失败不影响主流程 */ }
}

/** 按类别读取最近 N 条；memory 只含人物记忆，favor 单独列出好感变化。 */
export function readAuditLog({ userId = '', limit = 50, kind = 'memory' } = {}) {
  try {
    const file = memoryFile(FILE_NAME);
    if (!fs.existsSync(file)) return [];
    const cap = Math.max(1, Math.min(MAX_ROWS, Math.floor(Number(limit) || 50)));
    const category = ['memory', 'favor', 'all'].includes(String(kind)) ? String(kind) : 'memory';
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const rows = [];
    for (let i = lines.length - 1; i >= 0 && rows.length < cap; i -= 1) {
      try {
        const r = JSON.parse(lines[i]);
        if (userId && String(r.userId || '') !== String(userId)) continue;
        if (category === 'favor' && r.type !== 'favor') continue;
        if (category === 'memory' && (r.type === 'favor' || NON_MEMORY_TYPES.has(String(r.type || '')))) continue;
        rows.push(r);
      } catch { /* skip bad line */ }
    }
    return rows;
  } catch {
    return [];
  }
}
