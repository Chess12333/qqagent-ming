/**
 * M6 memory · 引用/历史行的**发言人标签**（`quoteAuthorLabel`）
 *
 * 为什么单独一个文件（2026-10-13，历史消息格式）：这条标签同时被三方要走去
 *   · `prompt/history-format.js`（历史行行首、引用行）
 *   · `act/executors/query.js`（`get_message_detail` 的工具回执）
 *   · `memory/index.js`（对外出口）
 * 原来它定义在 `chat-store.js` 里。那个文件带 `node:fs` 与存档读写，而提示词模块的硬边界是
 * "纯函数、不读盘、不 import 带副作用的兄弟模块" ⇒ 抽到这个零依赖文件里，`chat-store.js` 原样再导出。
 * ★ 全树**只此一处实现**（`msgRef` 的同一条教训：不许有第二份）。
 */

/**
 * 一条消息的发言人标签。
 * · 有自己的 QQ 号 ⇒ `名字(QQ号)`，管理员备注（`memberNotes`）优先于群名片。
 * · 自己的行 ⇒ 光杆 `我`（不写"机器人"，那是认知锚点的削减）。
 * · 什么都没有 ⇒ `未知作者`，由调用方决定怎么兜底。
 */
export function quoteAuthorLabel(reply, notes = {}) {
  if (!reply || typeof reply !== 'object') return '未知作者';
  const name = String(reply.sender ?? '').trim();
  const id = String(reply.senderId ?? '').replace(/\D/g, '');
  const hasValidId = /^\d{5,15}$/.test(id);
  // ★ 2026-10-11（用户令）：这条标签会被注入给模型（提示词的引用块 + `get_message_detail` 的工具回执），
  //   原先写着 `我（机器人）` —— 角色不该被称作"机器人"，那是认知锚点的削减。收成光杆 `我`；
  //   读端（`prompt/blocks.js` 的引用分支）认得出"被引的是你自己"，并据此把归属说明写对。
  if (reply.self === true || (reply.self !== false && !hasValidId && name === '我')) return '我';
  if (hasValidId) {
    const rawNote = notes?.[id];
    const note = typeof rawNote === 'string' ? rawNote.trim() : '';
    const label = note || name;
    return label ? `${label}(QQ${id})` : `QQ${id}`;
  }
  if (reply.self === false && name === '我') return '群友「我」';
  return name || '未知作者';
}
