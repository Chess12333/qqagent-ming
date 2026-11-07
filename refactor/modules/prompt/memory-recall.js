/**
 * M8b · 问旧事检测与预检索文案（纯函数，零 IO）。
 *
 * 出处（老树 `src/prompt.js`，只读参照）：
 *   `wantsMemoryRecall` :1694-1713 —— 判「本轮触发是不是在问很久以前的事」
 *   `memoryRecallQuery` :1716-1738 —— 从问句抠出适合 memory_search 的关键词
 *   硬要求文案        :2054（【问旧事·硬要求】）
 *   预检索文案        `src/orchestrator.js:2740-2746`（【预检索】）
 *
 * ★ 只做文本判定与拼装，不调模型、不读盘、不取时钟。
 *   是否真的去检索（以及跨群授权）归调用方（compose.js）。
 */

/** 本轮触发是不是在**问很久以前的事**（该翻长期记忆了）。逐字搬老树 `src/prompt.js:1694-1713`。 */
export function wantsMemoryRecall(text) {
  const t = String(text ?? '');
  if (!t) return false;
  // 近时指代优先当上下文已有，不强制考古（除非同时在问很久以前）
  if (/(刚才|刚刚|上一句|上面那句|我刚发|我发的)/.test(t)
    && !/(很久以前|上次说|以前说|还记得吗|说过多少次|提过没有|之前说)/.test(t)) {
    return false;
  }
  // 明确翻旧账
  if (/(还记得|记不记得|有没有印象|有没有说过|有没有提过|说过多少次|提过多少次|多少次了?|什么时候说的|啥时候说的|上次说|以前说|之前说|很久以前|好久以前|那会儿说|当时说|我们聊过|上次聊|我上次|你上次|之前是不是|是不是说过|是不是提过)/.test(t)) return true;
  // 上次/以前/之前 + 疑问或内容
  if (/(上次|以前|从前|之前|很久|好久|那天|那个时候|当时)[^。！？\n]{0,24}(吗|么|没|过|啥|什么|谁|哪|几|多少|怎么样|如何|喜欢|爱吃|说过|聊过|提过)/.test(t)) return true;
  if (/(说过|提过|聊过|谈过|讲过)[^。！？\n]{0,20}(吗|么|没|多少|几次|啥|什么)/.test(t)) return true;
  // 跨群/私聊问别处
  if (/(别的群|其他群|那个群|别的私聊|另一个群|隔壁群|私聊里)[^。！？\n]{0,28}(吗|么|聊|说|提|过|啥|什么|谁|怎么样)/.test(t)) return true;
  if (/(在|去|翻).{0,8}(别的群|其他群|那个群|私聊).{0,16}(搜|找|查|看|问)/.test(t)) return true;
  // 「你之前…」「我们之前…」带具体内容
  if (/(你|我|我们|大家)[^。！？\n]{0,4}(之前|以前|上次)[^。！？\n]{0,20}/.test(t) && t.length >= 8) return true;
  return false;
}

/** 从「问旧事」的句子里抠出适合 memory_search 的关键词。
 *  老树 `src/prompt.js:1716-1738` 主体逐字；**去掉末尾 `|| t.trim().slice(0,24)` 残渣兜底**——
 *  那截残渣只剩 1 字壳词（「说 好」这类），交给 chat-search 的 termsOf 会拆出通用单字/二字噪音，
 *  也违反「空关键词不伪造线索」：没有实词就如实回空串，调用方据此跳过预检索。
 */
export function memoryRecallQuery(text) {
  let t = String(text ?? '')
    .replace(/@\S+/g, ' ')
    .replace(/\[CQ:[^\]]*\]/g, ' ')
    .replace(/\[引用[^\]]*\]/g, ' ');
  t = t.replace(/[？?！!。,.，、~～：:；;'"“”'']/g, ' ');
  // 去掉问句外壳
  t = t.replace(/(还记得|记不记得|有没有|是不是|我们|你们|他们|上次|以前|之前|很久|好久|的时候|说过|提过|聊过|讲过|多少次|几次|什么时候|啥时候|对吧|是吗|吗|呢|吧|的|了|在|和|与|就|都|还|有|没|那个|这个|你|我|来着|啥|什么|怎么)/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  // 优先 2~4 字实词；长串切成短片
  const parts = [];
  for (const w of t.split(/\s+/)) {
    if (!w) continue;
    if (w.length <= 4) parts.push(w);
    else {
      for (let i = 0; i < w.length && parts.length < 10; i += 2) {
        parts.push(w.slice(i, i + 3));
      }
    }
  }
  const unique = [...new Set(parts.filter((w) => w.length >= 2))].slice(0, 6);
  return unique.join(' ');
}

/**
 * 【问旧事·硬要求】文案（老树 `src/prompt.js:2054` 逐字）。
 * @param {string} query `memoryRecallQuery` 的产物；空则不带具体词。
 * @returns {string}
 */
export function buildMemoryRecallReminder(query) {
  const q = String(query ?? '').trim();
  return '【问旧事·硬要求】对方在问以前的事。先 memory_search'
    + (q ? `("${q}")` : '("关键词")')
    + '；命中不够再 memory_archive(mode=day, day=那天)。当前聊天窗口没有的事实禁止瞎编；查不到就老实说想不起来。**尤其禁止**：把你自己「建议/推荐过」的东西说成对方「真的做过/吃过」。';
}

/**
 * 【预检索】文案（老树 `src/orchestrator.js:2740-2746` 口径）。
 * @param {string} query 检索词（`memoryRecallQuery` 产物；空串时调用方应跳过预检索，不走本函数）
 * @param {Array<{self?:boolean, senderName?:string, senderId?:string, text?:string, at?:number}>} hits
 *   同会话检索命中最简行（调用方已按跨群授权过滤、已排除本轮 evidence）。
 * @returns {string} 无命中时给"无命中"版；有命中时给线索版。
 */
export function buildMemoryPrefetchInject(query, hits) {
  const q = String(query ?? '').trim();
  const list = Array.isArray(hits) ? hits.filter((h) => h && typeof h === 'object').slice(0, 2) : [];
  if (!list.length) {
    return `【预检索】「${q}」无命中。可再 memory_search；没有就承认想不起来。`;
  }
  const brief = list.map((h) => {
    const who = h.self === true ? '我' : String(h.senderName ?? h.senderId ?? '？');
    const text = String(h.text ?? '').trim().slice(0, 40);
    return `${who}: ${text}`;
  }).join(' | ');
  return `【预检索】「${q}」→ ${brief}（线索；不够再 memory_search，别编旧事）`;
}
