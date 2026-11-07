/**
 * N-TRANSCRIBE（用户报「语音类消息只剩 [语音]」）：语音段 → 文字。
 *
 * 老树口径（逐条照搬）：
 *   · 老树 `src/app.js:928` 在**宿主层**（持有活 OneBot 客户端的那层）调
 *     `segmentsToText(segments, { onebot })`，其中 `src/onebot.js:523-537`
 *     `transcribeRecordSegment` 走 speech-to-text 插件的 `media.transcribe` 能力；
 *   · 软依赖：没装插件（能力不存在）/ 没配 whisper / 转写失败 / **25 秒超时**
 *     ⇒ 一律退回 `[语音]` 占位，行为与从前一致，绝不影响收消息；
 *   · 成功时老树输出 `[语音]${text}`（占位符紧跟转写文字）。
 *
 * 新树为什么放在 media 模块（而不是 M5 scenario）：
 *   · M5 是**纯函数模块**（selftest 静态断言：不 import 任何 modules/*、无时钟/随机/
 *     无 IO）⇒ 转写这种"动态 import 扩展 + 等 25 秒"的活不能住进 scenario；
 *   · media 模块本来就有这两条现成豁口：`vision-image.js:54` 动态 import
 *     `../extensions/index.js` 问能力；B1 白名单允许用协议端做"下载/取图"。
 *
 * 输出形状（关键）：转写成功时**在 record 段后面插一个 text 段**，record 段本身保留。
 *   `renderText` 会把 `[语音]`（record 占位）与插入的 text 段无缝拼成
 *   `[语音]转写文字` —— 与老树 `segmentsToText` 的最终字符串逐字一致；
 *   record 段保留 ⇒ 段结构不失真、`collectMedia` 对 record 的
 *   `media-type-unsupported` 诊断行为不变。
 */

/** 老树同款超时上限：转写本身是本地小模型，太长会把收消息链路堵住。 */
export const TRANSCRIBE_TIMEOUT_MS = 25000;

/**
 * 一条语音段 → 占位文字（老树 `src/onebot.js:523-537` 的同款逻辑，零 import）。
 *
 * @param {object} data record 段的 data（{file,url,...}）
 * @param {{call:Function}} onebotClient 活 OneBot 客户端（没有就退回占位）
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=25000]
 * @param {Function} [opts.getProviders] 能力提供者查询（测试注入；默认动态 import 扩展底座）
 * @returns {Promise<string>} `[语音]` 或 `[语音]转写文字`
 */
export async function transcribeRecordSegment(data, onebotClient, {
  timeoutMs = TRANSCRIBE_TIMEOUT_MS, getProviders = null
} = {}) {
  try {
    const providers = typeof getProviders === 'function'
      ? await getProviders('media.transcribe', {})
      : await defaultProviders('media.transcribe');
    const provider = Array.isArray(providers) ? providers[0] : null;
    if (!provider?.fn || !onebotClient?.call) return '[语音]';
    const record = { ...(data || {}) };
    const out = await Promise.race([
      Promise.resolve(provider.fn({ record, onebot: onebotClient })),
      new Promise((r) => { const t = setTimeout(() => r(null), Math.max(1, Number(timeoutMs) || TRANSCRIBE_TIMEOUT_MS)); t.unref?.(); })
    ]);
    const text = String(out?.text || '').trim();
    if (out?.ok !== false && text) return `[语音]${text}`;
  } catch { /* 转写失败不影响收消息（老树同款：静默退回占位） */ }
  return '[语音]';
}

/** 默认能力查询：动态 import 扩展底座（与 vision-image.js:54 同一套路；装不上就当没有）。 */
async function defaultProviders(capability) {
  try {
    const { skillManager } = await import('../extensions/index.js');
    const fn = skillManager?.getCapabilityProviders;
    return typeof fn === 'function' ? fn.call(skillManager, capability, {}) : [];
  } catch {
    return [];
  }
}

/**
 * 整批入站(rawBatch) → 转写后的**新** rawBatch（不改入参）。
 *
 * 只处理数组形态的 `message`/`segments`（老树同款：字符串形态的 CQ 消息不走转写）。
 * 没有 record 段 / 没有活客户端 / 没有插件能力 ⇒ 原样返回（连对象都不复制）。
 *
 * @param {object} batch eventToRawBatch 的产物
 * @param {{call:Function}} onebotClient 活 OneBot 客户端
 * @param {object} [opts] 透传给 transcribeRecordSegment + `log`
 * @returns {Promise<object>} 新 batch（无改动时与入参同一对象）
 */
export async function transcribeRecordSegments(batch, onebotClient, opts = {}) {
  if (!batch || typeof batch !== 'object' || !Array.isArray(batch.raw)) return batch;
  if (!onebotClient?.call) return batch;

  let touched = false;
  const raw = [];
  for (const item of batch.raw) {
    const segments = Array.isArray(item?.message) ? item.message
      : Array.isArray(item?.segments) ? item.segments : null;
    if (!segments || !segments.some((s) => s?.type === 'record')) {
      raw.push(item);
      continue;
    }
    const next = [];
    let changed = false;
    for (const seg of segments) {
      next.push(seg);
      if (seg?.type !== 'record') continue;
      const text = await transcribeRecordSegment(seg.data, onebotClient, opts);
      if (text === '[语音]') continue;               // 没转出来 ⇒ 一个字节都不加
      next.push({ type: 'text', data: { text: text.slice('[语音]'.length) } });
      changed = true;
    }
    if (changed) {
      touched = true;
      const key = Array.isArray(item.message) ? 'message' : 'segments';
      raw.push({ ...item, [key]: next });
    } else {
      raw.push(item);
    }
  }
  if (!touched) return batch;
  return { ...batch, raw };
}
