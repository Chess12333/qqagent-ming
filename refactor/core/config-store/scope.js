// ─────────────────────────────────────────────────────────────────────────────
// 本文件由脚本从 `src/prompt.js 的 scopedStoreConfig` **逐字搬运**（生成器：.tmp-dispatch/_t-refactor-gen.mjs）
// 内容 = 会话作用域解析（perChat > private(仅 privateOverride) > store 本体），**逐字照搬**
// ★ 搬运原则：**一个字都没改**（含注释与空行），只改了 export 修饰与文件归属。
//   行为等价性靠 selftest.mjs 断言，见回执的「迁移逻辑逐条对照表」。
// ─────────────────────────────────────────────────────────────────────────────

export function scopedStoreConfig(store, kindOrOpts = 'group') {
  const base = store && typeof store === 'object' ? store : {};
  const opts = typeof kindOrOpts === 'string' ? { kind: kindOrOpts } : (kindOrOpts || {});
  const kind = opts.kind || 'group';
  const chatKey = String(opts.chatKey || '');
  // 1) 单个会话的单独设置优先
  if (chatKey && base.perChat && typeof base.perChat === 'object') {
    const per = base.perChat[chatKey];
    if (per && typeof per === 'object') return { ...base, ...per };
  }
  // 2) 私聊独立参数
  if (kind !== 'private' || !base.privateOverride) return base;
  const priv = base.private && typeof base.private === 'object' ? base.private : {};
  return { ...base, ...priv };
}

/** 搬运自 src/orchestrator.js 的 hasStoreField（逐字照搬的判定口径）。 */
export function hasStoreField(object, key) {
  return !!object && typeof object === 'object'
    && Object.prototype.hasOwnProperty.call(object, key)
    && object[key] !== undefined && object[key] !== null;
}

/**
 * 分层解析：给出某键在「默认 / 全局 / 会话覆盖」三层里各自的值与是否存在。
 * ★ 为什么只有 store 子树有"会话层"：现网里 perChat / private 这套作用域**只实现��� store 上**
 *   （src/prompt.js 的 scopedStoreConfig）；其它键（localJev.* 等）本来就没有会话级覆盖。
 *   搬的时候**不许凭空给别的键加一层**（那会是改产品）。
 */
export function resolveLayers(store, keyPath, { chatKey = '', kind = 'group' } = {}) {
  if (typeof keyPath !== 'string' || keyPath === '') {
    return { chat: undefined, private: undefined, global: undefined, hasChat: false, hasPrivate: false };
  }
  const root = keyPath.split('.')[0];
  const layers = { chat: undefined, private: undefined, global: undefined, hasChat: false, hasPrivate: false };
  if (root !== 'store') return layers;
  // ★ 会话层/私聊层里存的是**相对 store 的键**（scopedStoreConfig 就是把 perChat 的字段平铺到 store 上），
  //   而冻结接口给的 keyPath 是从根算起的（'store.maxMessagesPerChat'）⇒ 这里必须剥掉 'store.' 前缀。
  const subKey = keyPath.slice('store.'.length);
  if (!subKey) return layers;
  const per = chatKey ? (store?.perChat?.[chatKey] || null) : null;
  if (per && typeof per === 'object' && hasStoreField(per, subKey)) {
    layers.chat = per[subKey];
    layers.hasChat = true;
  }
  if (kind === 'private' && store?.privateOverride === true
      && store?.private && typeof store.private === 'object' && hasStoreField(store.private, subKey)) {
    layers.private = store.private[subKey];
    layers.hasPrivate = true;
  }
  return layers;
}
