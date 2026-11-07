/**
 * refactor/apps/server/store-caps.js — 存储上限（store.maxMessagesPerChat / store.hotMessagesPerChat）的
 * **唯一接线点**：初值 + 热更新都从这里走（老树 src/app.js:615 构造注入 / :2680-2681 配置变更热更新）。
 *
 * 为什么单独成文件（复核回执 .tmp-dispatch/2026-10-15/39ddbb0d §五 V2）：
 *   生产上 store 有两条建路：① `assembly.buildRuntimeModules` 主分支；② `onebot-link.resolveStore` 兜底。
 *   两条建出的通常是**同一个单例**（chat-store.js 按 dataDir 单例，:1240-1271 的复用分支用 hasOwn 更新），
 *   但订阅此前只挂在① ⇒ 主分支没进时兜底 store 吃得到初值、吃不到后续配置变更（运行时改上限要重启）。
 *   ⇒ 把"初值 + 订阅"收成这里一个函数，`WeakSet` 保证**同一实例只订阅一次**（两条路都调用也不重复订阅）。
 *
 * 边界与纪律：
 *   · 拿不到配置访问器（无 get）⇒ **不猜、不覆盖**，直接 return false
 *     （复核 §三 那条"传 null 会把上限冲成不限"的隐患在这里堵死）。
 *   · 数值收口全在 ChatStore（构造 :414-415 / setter :431/:434 一律 `Math.max(0, Number(..)||0)`）——本模块不夹取。
 *   · **只调 setter 改字段**：真正的裁剪只发生在 store 自己的写入路径（chat-store.js #trim，缩容后要等
 *     该会话下一条新消息进来才裁）——本模块不主动裁剪、不删数据；UI 侧护栏（非零下限 100 + 下调二次确认）保持不变。
 */

const WIRED_STORES = new WeakSet();

/** hotPerChat 兜底：与 config-store `DEFAULT_CONFIG.store.hotMessagesPerChat`、chat-store.js 的常量同为 3000。 */
const HOT_FALLBACK = 3000;

function hotDefaultOf(configStore) {
  return Number(configStore?.DEFAULT_CONFIG?.store?.hotMessagesPerChat) || HOT_FALLBACK;
}

/** 把一个 store 配置块收成两个收口好的数值（只读，不写）。 */
function capsFromStoreBlock(storeBlock, hotDefault) {
  const block = storeBlock && typeof storeBlock === 'object' ? storeBlock : {};
  return {
    maxPerChat: block.maxMessagesPerChat ?? 0,
    hotPerChat: block.hotMessagesPerChat ?? hotDefault
  };
}

/**
 * 把配置里的两个上限写给 store，并（每个实例第一次）挂上配置变更热更新。
 * @param {object} store ChatStore 实例（带 setMaxPerChat / setHotPerChat）
 * @param {object} configStore core/config-store 命名空间或它的窄代理（用 get / subscribeConfigChange）
 * @param {function} [log]
 * @returns {boolean} 真接上了（缺 store 出口或配置访问器 ⇒ false，调用方自行决定怎么记账）
 */
export function wireStoreCaps(store, configStore, log = null) {
  if (!store || typeof store.setMaxPerChat !== 'function' || typeof store.setHotPerChat !== 'function') return false;
  // 没有配置访问器 ⇒ 不猜、不覆盖（宁可不接，也不把上限冲成默认值）。
  if (typeof configStore?.get !== 'function') return false;
  const hotDefault = hotDefaultOf(configStore);

  // ── 初值：合并视图（defaults 已在其中；整块取不到时按老树兜底 0 / 3000）──
  try {
    const caps = capsFromStoreBlock(configStore.get('store'), hotDefault);
    store.setMaxPerChat(caps.maxPerChat);
    store.setHotPerChat(caps.hotPerChat);
  } catch (error) {
    log?.(`[apps/server] 存储上限初值应用失败（保持 store 构造值）：${error?.message ?? error}`);
  }

  if (WIRED_STORES.has(store)) return true;   // 同一实例只订阅一次（两条建 store 的路径共用本函数）
  WIRED_STORES.add(store);
  if (typeof configStore.subscribeConfigChange === 'function') {
    configStore.subscribeConfigChange((_patch, fullConfig) => {
      try {
        if (!fullConfig || typeof fullConfig !== 'object') return;
        if (!fullConfig.store || typeof fullConfig.store !== 'object') return;
        // 直接属性访问（publish 给的就是 getConfig() 的活合并视图）——这两条键路径在这里是真读取点，
        // 生成器（gen-config-truth.mjs）按点号 grep 也认这两处字面量。
        store.setMaxPerChat(fullConfig.store.maxMessagesPerChat ?? 0);
        store.setHotPerChat(fullConfig.store.hotMessagesPerChat ?? hotDefault);
      } catch (error) {
        try { log?.(`[apps/server] 存储上限热更新失败（保持旧值）：${error?.message ?? error}`); } catch { /* 日志不许反噬 */ }
      }
    });
  }
  return true;
}
