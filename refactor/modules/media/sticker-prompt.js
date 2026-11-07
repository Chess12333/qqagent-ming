import { createHash } from 'node:crypto';

export const STICKER_PREFIX_COUNT = 10;
const RECENT_COUNT = 3;
const MAX_SCOPES = 32;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function availableEntries(entries) {
  const result = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = String(entry?.id ?? '').trim();
    if (!id || entry?.broken === true || entry?.broken === 'true') continue;
    const text = String(entry.localNote || entry.desc
      || (Array.isArray(entry.tags) ? entry.tags.join('、') : '')).replace(/[\r\n]+/g, ' ').trim();
    if (!text) continue;
    result.set(id, { id, label: text.length > 26 ? `${text.slice(0, 26)}…` : text });
  }
  return result;
}

function renderList(title, rows) {
  if (!rows.length) return '';
  return [`【${title}】id 可 send_sticker：`,
    ...rows.map((row) => `${row.label} id=${row.id}`),
    '需特定情绪用 list_stickers。'].join('\n');
}

/** 有界进程内候选：按账号/聊天/人格分界隔离，不落盘、不使用墙钟或定时器。 */
export function createStickerPromptPlanner() {
  const scopes = new Map();
  return function plan({ scope, block = null, entries = [] }) {
    const key = digest(JSON.stringify(scope));
    const previous = scopes.get(key);
    const current = availableEntries(entries);
    // 没有可证明的历史锚点时沿用上一批，不按每次调用或小时钟重新抽取。
    const nextBlock = block === null || block === undefined ? previous?.block ?? 'initial' : String(block);
    const rotated = !previous || nextBlock !== previous.block;
    const added = previous ? [...current.keys()].filter((id) => !previous.known.has(id)) : [];
    let roster;
    if (rotated) {
      roster = [...current.keys()].map((id) => ({ id, score: digest(`${key}\0${nextBlock}\0${id}`) }))
        .sort((a, b) => compare(a.score, b.score) || compare(a.id, b.id)).map((row) => row.id);
    } else {
      // 现有池内补位；新收藏不改当前大段。删除/失效立即移出，恢复后先走尾部补充。
      roster = previous.roster.filter((id) => current.has(id));
    }
    const selected = roster.slice(0, STICKER_PREFIX_COUNT);
    const selectedSet = new Set(selected);
    const pending = [...new Set([...added.slice().reverse(), ...(previous?.pending ?? [])])]
      .filter((id) => current.has(id) && !selectedSet.has(id)).slice(0, RECENT_COUNT);
    const prefixRows = selected.map((id) => current.get(id)).sort((a, b) => compare(a.id, b.id));
    const recentRows = pending.map((id) => current.get(id));
    scopes.delete(key);
    scopes.set(key, { block: nextBlock, roster, pending, known: new Set(current.keys()) });
    while (scopes.size > MAX_SCOPES) scopes.delete(scopes.keys().next().value);
    return {
      prefixText: renderList('表情库', prefixRows),
      recentText: renderList('新增可用表情', recentRows),
      prefixCount: prefixRows.length, recentCount: recentRows.length, rotated
    };
  };
}
