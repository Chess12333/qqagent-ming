/**
 * 自动看图（N42）—— 老树 `src/orchestrator.js:3058-3121` 的同款能力，新树补上。
 *
 * 为什么需要：新树原来**完全没有**这一环 —— 触发消息里的图只以 `〔图片 · 媒体 id〕`
 * 出现在提示词里（`modules/prompt/blocks.js`），模型能不能看见全看它想不想得起来调
 * `get_message_images` / `identify_image`。老树则是**直接把图挂进本轮 user 消息**：
 * 小模型经常想不起来/协议失败，所以这一步不能省。用户实机报的「识图看不了动图」
 * 一半就在这里（没有自动附图 ⇒ 只剩一个占位符号）。
 *
 * 口径逐条照老树：
 *   · 触发条件：`api.vision !== false` 且当前模型没被探测成 `no-vision`，且不是主动轮
 *   · 取哪几张：触发证据里的图片，最多 3 张；每张 GIF 抽帧上限 6（抽多帧不另花钱 ——
 *     `vision-image.tileFrames` 会把多帧拼成一张 PNG）
 *   · 成功：图片挂在本轮**最后一条 user 消息**上，配一段"这是什么图、该怎么接"的说明
 *   · 失败：**明说看不到**（照老树 `:3107-3116`：`【图没取到】…你现在看不到它们`），
 *     宁可让她承认看不清，也不许她描述一张没看见的图 —— 与
 *     `act/executors/media.js`（N26）的"失败要给明确事实 + 原因"同一口径
 *   · 任何异常都不许冒泡：自动看图是可选能力，坏了也不能让整轮回不了话
 *
 * ★ 本文件**零 import**：下载 / 视觉归一化全部由调用方注入（装配层把
 *   `modules.internet.safeFetchBinary` 与 `modules.media.toVisionDataUrls` 传进来），
 *   与 M5 的"协议端形状由入参适配、不 import 别人的实现"同一套路。
 *   `modules/media/index.js` 只把它当一个公开出口透出（真逻辑不碰别的模块）。
 *
 * ★ N85（用户批准「加，没事」= 批准引入依赖做缩放）：**没装依赖也能修** ——
 *   PNG 走纯 JS 解码 + 缩放（`./image-scale.js`，零依赖）；GIF 走 vision-image 的抽帧
 *   （`tileFrames` 本来就把多帧拼图缩到 ≤1024）；JPEG/WEBP 交给调用方注入的
 *   `decodeForeign`（例如 sharp 的动态 import）。**装不上就退回"超限不附 + 明说原因"**
 *   —— 绝不会变成"什么都看不见"。
 */

export const AUTO_VISION_LIMIT = 3;
// ★ 2026-10-27（溟）6 → 4：六帧拼成 3×2 时每格只有 341px，动图里的小动作（眨眼、抖一下）
//   缩到那个尺寸就跟邻格糊成一片，她的原话是「看 gif 是叠在一起的」。四帧排 2×2 每格 512px，
//   动作反而看得清；帧少了也不至于丢掉"变了哪一下"。
export const AUTO_VISION_MAX_FRAMES = 4;
/**
 * ★ N79（用户实测"这下连图片都看不见了"）：**单张原图字节上限**。
 * 老树/新树的 `toVisionDataUrls` 对 png/jpeg 是**原样透传**（不转码、不缩尺寸）⇒
 * 用户发一张手机原图/长截图（实测真机 8.6MB ⇒ base64 11.5M 字符）整张挂进 user 消息，
 * 那一轮模型直接废掉（实测：0 字输出、模型转头去发表情，用户侧就是"图看不见了"）。
 * 这不是"看图失败"，是"图太大把这一轮撑爆" ⇒ **明说不附 + 原因**，不许假装看见。
 */
export const AUTO_VISION_MAX_BYTES = 2 * 1024 * 1024;
/** 附进提示词的 base64 字符总量上限（超过就停止附后面的，已附的不撤回）。 */
export const AUTO_VISION_MAX_TOTAL_CHARS = 3 * 1024 * 1024;

/**
 * ★ #14（2026-10-18，用户实机报「模型看到有图但是没收到」）：**模型单次请求附图的总合同**。
 *
 * 为什么要有这组常量：每个模型请求前还有一道出站闸（编排层 `boundModelImages`），
 * 它按"最多 3 张 image_url / data: URL 合计 2 MiB 字符"裁剪。而自动看图这边原先默认
 * 总量 3 MiB 字符 —— 两边**预算各写各的**：3 张中等照片这边全附、用户消息里写
 * "已附上 3 张原图"，出站闸再按自己的上限丢 1 张并补一句"本轮有图片未附" ⇒
 * 模型同时看到两条互相矛盾的事实。act 执行器的图片工具（get_message_images 等）
 * 当时也不受任何请求侧预算约束，同样会被出站闸中途丢掉。
 *
 * 口径：以**更保守的出站闸**为唯一天花板。本模块、act 执行器、编排层共用这一组数字
 * （经 `modules/media/index.js` 透出；编排层接线见交接文档「B 侧接线」）。
 * 改这里 = 改全局合同，三个消费方一起变；`api.autoVisionMaxTotalChars` 这类配置只能
 * 在合同以内收紧，不能突破（见 `effectiveVisionLimits`）。
 */
export const MODEL_REQUEST_IMAGE_LIMITS = Object.freeze({ maxCount: 3, maxDataChars: 2 * 1024 * 1024 });

/**
 * 把任意来源的预算收进全局合同的天花板（配置/默认值都可能比出站闸宽松），返回**有效值**。
 * act 执行器与自动看图都用它，各处不再自己 hand-roll 数字。
 * ★ 只收"张数"和"base64 总字符"两个维度 —— 这两条正是出站闸会**中途丢图**的维度。
 *   单张字节上限（`maxBytes`）是"下载/附不附"的用户旋钮，保持原样：超它的图仍按既有
 *   N79/N85 口径先缩、缩不动才不附；只是附上后如果撞上总量闸，也会由本模块如实说"没附"
 *   （而不是先写"已附上"再被出站闸删掉）。编排层 selftest 的 `above-old-download-cap`
 *   用例固定了"配置能把单张上限抬到 10MB"这一条，所以这里**不动** maxBytes。
 * @param {{maxBytes?:number, maxTotalChars?:number, maxCount?:number}} [limits]
 * @returns {{maxCount:number, maxBytes:number, maxTotalChars:number}}
 */
export function effectiveVisionLimits({ maxBytes, maxTotalChars, maxCount } = {}) {
  const capCount = MODEL_REQUEST_IMAGE_LIMITS.maxCount;
  const capChars = MODEL_REQUEST_IMAGE_LIMITS.maxDataChars;
  const pick = (v, fallback, cap) => {
    const n = (Number.isFinite(v) && v > 0) ? v : fallback;
    return Math.floor(Math.min(n, cap));
  };
  return {
    maxCount: pick(maxCount, AUTO_VISION_LIMIT, capCount),
    maxBytes: pick(maxBytes, AUTO_VISION_MAX_BYTES, Infinity),
    maxTotalChars: pick(maxTotalChars, AUTO_VISION_MAX_TOTAL_CHARS, capChars)
  };
}

/**
 * 按全局合同从一组 data URL 里裁出"这次能附的"（保序，先到先得）。
 * 与出站闸 `boundModelImages` 同口径：data URL 按**字符**计，非 data: URL 不占字符预算（但计张数）。
 * @returns {{dataUrls:string[], dropped:Array, chars:number, maxCount:number, maxDataChars:number}}
 */
export function fitVisionDataUrls(dataUrls, limits = MODEL_REQUEST_IMAGE_LIMITS) {
  const maxCount = Math.max(1, Number(limits?.maxCount) || MODEL_REQUEST_IMAGE_LIMITS.maxCount);
  const maxDataChars = (Number.isFinite(limits?.maxDataChars) && limits.maxDataChars > 0)
    ? limits.maxDataChars
    : MODEL_REQUEST_IMAGE_LIMITS.maxDataChars;
  const kept = [];
  const dropped = [];
  let chars = 0;
  for (const url of Array.isArray(dataUrls) ? dataUrls : []) {
    const len = String(url ?? '').length;
    if (!len || kept.length >= maxCount || chars + len > maxDataChars) {
      dropped.push(url);
      continue;
    }
    kept.push(url);
    chars += len;
  }
  return { dataUrls: kept, dropped, chars, maxCount, maxDataChars };
}

/** 把字节数打印成模型看得懂的短串（整数不带小数；1.5MiB 这类保留一位）。 */
export function formatMB(bytes) {
  const v = (Number(bytes) || 0) / 1024 / 1024;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/**
 * 从 cfg 读数值上限（兜底路径，给"独立调用、没传 limits"用）。
 * 非法值（非有限数或 ≤0）⇒ 回落默认值（照 defaults.js 口径，不当作"不限制"）。
 * @param {null|((key:string, fallback?:any)=>any)} get `cfg.get`
 * @param {string} key 点路径键名
 * @param {number} fallback 无效时的回落值
 */
function cfgLimit(get, key, fallback) {
  try {
    const v = get ? get(key, fallback) : fallback;
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

/** 主动轮不附图（老树同款：`!proactive`）；主动轮没有"刚发图的群友"可接。 */
export function autoVisionRuns({ proactive = false } = {}) {
  return proactive !== true;
}

/**
 * 当前模型能不能收图片。
 * @param {(key:string, fallback?:any)=>any} get 配置读法（`cfg.get`）
 * @param {()=>string} verdictOf 返回当前 (providerId,modelId) 的视觉结论：'vision' | 'no-vision' | 'unknown'
 */
export function autoVisionEnabled(get, verdictOf) {
  let on = true;
  try { on = get ? get('api.vision', true) !== false : true; } catch { on = true; }
  if (!on) return false;
  try { return verdictOf ? verdictOf() !== 'no-vision' : true; } catch { return true; }
}

/**
 * 触发证据里的图片地址（去重、保序、带上限）。
 * 证据的 `media[]` 只有 `{type,id}`（契约不存 url）⇒ 优先回落调用方给的
 * `resolveUrl(evidenceEntry)`（装配层用 `memory.store.findByMid` 拿真 url，与
 * `get_message_images` 同一条路）；解析不到再退到 "id 本身是个 URL" 的情形。
 */
export function triggerImageUrls(evidence, { limit = AUTO_VISION_LIMIT, resolveUrl = null } = {}) {
  const cap = Math.max(1, Number(limit) || AUTO_VISION_LIMIT);
  const urls = [];
  const push = (u) => {
    const s = String(u ?? '').trim();
    if (!s || urls.includes(s)) return;
    urls.push(s);
  };
  for (const e of Array.isArray(evidence) ? evidence : []) {
    for (const m of Array.isArray(e?.media) ? e.media : []) {
      if (m?.type !== 'image') continue;
      let url = typeof resolveUrl === 'function' ? resolveUrl(e, m) : null;
      if (!url && /^https?:\/\//i.test(String(m?.id ?? ''))) url = m.id;
      push(url);
      if (urls.length >= cap) return urls;
    }
  }
  return urls;
}

/** 本轮的"最后一条 user 消息"下标（老树 `messages[dynamicUserIndex]` 的同一种找法）。 */
export function lastUserIndex(messages) {
  for (let i = (Array.isArray(messages) ? messages.length : 0) - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

/**
 * "对方点名要图"判据（2026-10-13 收窄，qwen1 `1b73dec` 发现撞词后归本席修）：
 * ★ 只对本轮 `evidence[].text`（用户真正发来的文本）求值 —— 以前跑在整块装配好的
 *   user 提示词上，昵称/历史行/待办/梗 cue 甚至手册常驻句里的撞词都会命中 ⇒ 带图轮
 *   一律被判成点名要图，mediaOnly 与默认"接情绪"两支永远走不到。
 * ★ 词表补最直白的「看图」（原先缺）；判定范围之外的文本一律到不了这个函数。
 */
export function explicitImageTask(evidence) {
  const evidenceText = (Array.isArray(evidence) ? evidence : [])
    .map((entry) => String(entry?.text ?? '')).join('\n');
  return /看看|看图|看下|瞧|这是(啥|什么|谁)|这图|这张图|图片里|图里|图中|这个表情|这张表情|表情里|认一下|认认|分析(下|一下)?|啥角色|哪来的图|什么图|(?:啥|什么)动作|动作(是啥|是什么|什么意思)|识字|认字|识别文字|图中文字|图片文字|写了什么|写的什么|翻译|读一下|描述一下|解释图片|什么意思|啥意思/.test(evidenceText);
}

/**
 * 说明文字：三种情况分开说（照老树 `:3092-3096`）。
 * @param {{count:number, notes?:string[], skipped?:number, failed?:string[], explicitTask?:boolean, mediaOnly?:boolean}} r
 */
export function autoVisionNote({ count, notes = [], skipped = 0, failed = [], explicitTask = false, mediaOnly = false }) {
  const head = `【触发消息附图】已附上 ${count} 张原图${skipped ? `（另有 ${skipped} 张格式本机不支持已跳过）` : ''}${notes.length ? ` ${notes.join(' ')}` : ''}。`;
  if (explicitTask) {
    // 2026-10-13（用户报"看完图变客服腔"）：去掉"先说清…再单列…要说明不确定"的步骤腔 ——
    // 老树 :3088-3090 注释自证同族措辞曾致"每次回报画面、正常人不会这么说话"；
    // 四条实质约束（说主体动作文字 / 水印不猜出处 / 拿不准就直说）全保留，只是不再列成流程。
    return `${head}按对方要求看图：把看清的主体、动作/表情和图中文字自然说出来就行；水印、logo、账号名只当水印，不据此猜出处或情节，拿不准的就直说拿不准。`;
  }
  if (mediaOnly) {
    return `${head}他这轮**只发了表情/图，一个字都没配** —— 这张图就是他要说的话本身，是在表达情绪（得意、无语、装死、撒娇、挑衅、单纯分享个乐子都算）。你要接的是这个情绪，或者把这个梗变奏着丢回去；不用说出图里画了什么，不用报主体、动作、配色和图上文字。`;
  }
  return `${head}这是群友刚发的图或表情，**他在表达此刻的情绪、不是在给你出看图题**：接他那句话的情绪就够了。不用解说画面里有什么、不用报主体动作配色、不用逐条列细节；他没让你看图就别去描述图。`;
}

/**
 * 可选的 JPEG/WEBP 解码器（N85）：**动态 import sharp，装不上就当没有**。
 * ★ 刻意不做静态 import：本文件保持零 import 的规矩；sharp 是可选依赖，
 *   没装 / ABI 不匹配（electron 里用 node 版 sharp 要 electron-rebuild）都不该让本模块起不来。
 * @returns {Promise<null|Function>} null = 没有解码器（调用方据此退回"不附 + 明说"）
 */
/**
 * 可选的 JPEG/WEBP 解码器（N85）：**先 jpeg-js、后 sharp**，两条都没有 ⇒ null（调用方退回 N79 两态）。
 * ★ 两条都走**动态 import + catch**：没装 / ABI 不匹配 / 抛错，都不该让本模块起不来，
 *   更不许把"装了但用不了"演变成"什么都看不见"（退回 N79 的明说文案）。
 * @param {object} [deps] jpeg-js 分支要用 media 的缩放/编码器（不给就跳过 jpeg-js，不影响 sharp 分支）
 * @returns {Promise<null|Function>} 返回与 sharp 分支同形状的 (buf, mime, {maxSide}) => {ok, buffer?, mime?, note?, reason?}
 */
export async function loadForeignDecoder({ scaleRgba = null, encodePng = null } = {}) {
  // ① jpeg-js（首选：74KB · 0 依赖 · 无 rebuild；真机 4500×4500 级 JPEG 全程 ~304ms）
  try {
    const mod = await import('jpeg-js');
    const jpeg = mod?.default ?? mod;
    if (typeof jpeg?.decode === 'function' && typeof scaleRgba === 'function' && typeof encodePng === 'function') {
      return async (buf, mime, { maxSide = 1024 } = {}) => {
        try {
          const dec = jpeg.decode(buf);                       // ★ 吃 Buffer（不是 {data}）
          if (!dec?.width || !dec?.height || !dec.data) return { ok: false, reason: 'jpeg-js 解不出这张图' };
          const small = scaleRgba({ rgba: Buffer.from(dec.data), width: dec.width, height: dec.height }, maxSide);
          if (!small) return { ok: false, reason: 'jpeg-js 解码后缩放失败' };
          const out = encodePng(small.rgba, small.width, small.height);
          if (!out?.length) return { ok: false, reason: 'jpeg-js 解码后重新编码失败' };
          return {
            ok: true, buffer: out, mime: 'image/png',
            note: `（原图 ${(buf.length / 1024 / 1024).toFixed(1)}MB 的 ${mime || 'jpeg'} 太大，已用 jpeg-js 缩到 ${small.width}×${small.height} 再送模型：`
              + '看得清主体和动作就行，别把压缩噪点当画面内容）'
          };
        } catch (error) {
          return { ok: false, reason: `jpeg-js 解码失败（${String(error?.message ?? error).slice(0, 60)}）` };
        }
      };
    }
  } catch { /* 没装 jpeg-js ⇒ 试 sharp */ }

  // ② sharp（备选：win32-x64 19.8MB + 要 electron-rebuild；装着就用，没装/ABI 不匹配就当没有）
  try {
    const mod = await import('sharp');
    const sharp = mod?.default ?? mod;
    if (typeof sharp !== 'function') return null;
    return async (buf, mime, { maxSide = 1024 } = {}) => {
      try {
        const out = await sharp(buf, { failOn: 'none' })
          .rotate()                     // 按 EXIF 转正，否则侧躺图缩完还是侧躺
          .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer();
        if (!out?.length) return { ok: false, reason: 'sharp 输出了空 buffer' };
        return {
          ok: true, buffer: out, mime: 'image/png',
          note: `（原图 ${(buf.length / 1024 / 1024).toFixed(1)}MB 的 ${mime} 太大，已用 sharp 缩到最长边 ${maxSide} 再送模型：`
            + '看得清主体和动作就行，别把压缩噪点当画面内容）'
        };
      } catch (error) {
        return { ok: false, reason: `sharp 缩放失败（${String(error?.message ?? error).slice(0, 60)}）` };
      }
    };
  } catch {
    return null;
  }
}
/** 图一张都没附上时说什么（照老树 `:3112`）；`tooBig` 优先 —— 那是"下到了但太大"，不是"没下到"。
 *  ★ N-GIF6：`notes`（如"这是动图、抽了几帧、拼成一张"）在**全丢弃支**也要带上 ——
 *    否则被闸掉的动图只剩"太大没附"，模型得不到"这是动图"的任何引导。 */
export function autoVisionMissNote({ count, failed = [], skipped = 0, tooBig = [], notes = [], maxBytes = AUTO_VISION_MAX_BYTES, maxTotalChars = AUTO_VISION_MAX_TOTAL_CHARS }) {
  const extra = Array.isArray(notes) && notes.length ? ` ${notes.filter(Boolean).join(' ')}` : '';
  if (tooBig.length) {
    // 2026-10-13：尾巴上"教用户做事"的句子去掉（老树没有这句；那种建议口吻会带出客服腔）。
    return `【图没附上】这轮的 ${count} 张图下载成功了，但附进去会把整轮撑爆（单张上限 ${formatMB(maxBytes)}MB`
      + ` / 本轮 base64 总量上限 ${formatMB(maxTotalChars)}MB；实测 ${tooBig.slice(0, 3).join('、')}）`
      + ` —— 所以这轮**没附**。你现在看不到这几张的画面，别描述、别猜。${extra}`;
  }
  const why = failed?.length ? `（${String(failed[0]).slice(0, 60)}）` : (skipped ? '（格式本机不支持）' : '');
  // 2026-10-14（收敛）：这句是本轮唯一一处"看不到"陈述 —— 去掉第二处（"看不清的表情"），
  // 约束合并成一条（别照占位符描述、别猜）；别照抄用户原话、别教用户做事的口径同 qwen1 那单。
  return `【图没取到】这轮的 ${count} 张图/表情没能下载下来${why}，你现在**看不到它们**、只看到 [图片] 占位符。`
    + '想看就调 get_message_images 再试一次；不试就当他发了个表情，别照占位符描述、也别猜图里是什么。' + extra;
}

/**
 * ★ N-NOURL（用户原话「什么都看不见还不说为什么」）：证据里**明明有图**，却一条可下载
 *   地址都没解析出来（协议端只给了文件编号 / CQ 码形态 / 合并转发节点 / 有的 OneBot
 *   实现不给 url）—— 以前这条路径**静默返回**（无 note、无日志），模型只能看到提示词里
 *   "没有识别出画面内容（动图、解析失败或画面不可读）"，把"根本没拿到地址"误导成
 *   "解析失败"。四种失败（取不到 / 太大 / 没解码器 / 模型没看）不许混成一句话。
 */
export function autoVisionNoUrlNote({ count }) {
  // 2026-10-13：只留"看不到 + 自己可再试"（老树 miss 口吻），去掉"让对方重发"这类教用户的话。
  return `【图没附上】这轮的 ${count} 张图/表情在消息里只有文件编号、没有可下载的地址（协议端没给 url），本机取不到原图`
    + ' —— 你现在看不到画面，别描述、别猜；要看就调 get_message_images 再试。';
}

/**
 * ★ #14（2026-10-18）：装配层没把「下载 / 视觉归一化」出口接上时原来**静默返回**
 *   （只留一条 log）—— 模型只看到 [图片] 占位符、没有任何"看不到"的说明。
 *   这是"有图但没收到"的又一条来源 ⇒ 与 N-NOURL 同口径：明说看不到 + 自己可再试。
 */
export function autoVisionDepsNote({ count }) {
  return `【图没附上】这轮的 ${count} 张图/表情没能取到：本机缺少可用的图片下载或视觉归一化出口`
    + ' —— 你现在看不到画面，别描述、别猜；要看就调 get_message_images 再试。';
}

/** 证据里 type==='image' 的媒体条数（不是"有几条媒体"——表情/视频不算）。 */
export function countImageEntries(evidence) {
  let n = 0;
  for (const e of Array.isArray(evidence) ? evidence : []) {
    for (const m of Array.isArray(e?.media) ? e.media : []) {
      if (m?.type === 'image') n += 1;
    }
  }
  return n;
}

/**
 * 主编排：把触发图挂进 messages（返回**新** messages，不改入参）。
 *
 * @param {object} p
 * @param {Array}  p.evidence     本轮证据（`MessageEvidence[]`）
 * @param {Array}  p.messages     已组好的 messages（`prompt.buildMessages` 的产出）
 * @param {object} p.modules      `{ internet?: {safeFetchBinary}, media?: {toVisionDataUrls, detectImageMime} }`
 * @param {object} [p.cfg]        `{ get(key, fallback) }`
 * @param {boolean}[p.proactive]   主动轮
 * @param {Function}[p.verdictOf]  当前模型视觉结论
 * @param {Function}[p.resolveUrl] 证据条目 → 图片真 url（装配层用 chat store）
 * @param {Function}[p.log]        观测日志（不传就静默）
 * @param {{maxBytes?:number, maxTotalChars?:number}} [p.limits]
 *   体积上限（compose 侧校验后传入，单位：字节 / 字符）。不传或非法 ⇒ 回落常量默认。
 * @returns {Promise<{messages:Array, attached:number, urls:number, skipped:number, failed:string[], notes:string[]}>}
 */
export async function attachTriggerImages({
  evidence = [], messages, modules = {}, cfg = null, proactive = false,
  verdictOf = null, resolveUrl = null, log = null, decodeForeign = null, limits = null,
  // ★ 2026-10-27（溟）：「邻图」——最近几十秒里别人刚发、但本身没触发我的图片消息
  //   （形状与 evidence 条目一致：{ id: mid, media: [{ type: 'image', id: url }] }）。
  //   现场：群友先甩一张图、隔二十秒再发「@溟 我朋友的鱼这样了」，以前图那条整条被
  //   attachment-only 吞掉，这一轮只剩半句话。由 compose 侧从 chat store 取，这里只当补位：
  //   本轮触发的图优先，邻图填不满 maxCount 时才补。不传 = 行为与以前完全一致。
  extraEvidence = []
} = {}) {
  // ★ N83 契约（口径统一）：优先消费 compose 传入的 limits（字节/字符）；
  //   没传就兜底读 cfg（`api.autoVisionMaxBytesMB` 单位 MB → 转字节；`api.autoVisionMaxTotalChars` 直接用）；
  //   两边回落口径一致：非有限数或 ≤0 ⇒ 回落常量默认（照 defaults.js）。
  // ★ #14（2026-10-18）：再收进 `MODEL_REQUEST_IMAGE_LIMITS` 天花板 —— 配置/默认值只许
  //   在这个"模型单次请求附图"合同以内收紧，不许突破；否则"这边附上、出站闸再丢"的老毛病会回来。
  const eff = effectiveVisionLimits({
    maxBytes: (Number.isFinite(limits?.maxBytes) && limits.maxBytes > 0)
      ? limits.maxBytes
      : cfgLimit(cfg?.get, 'api.autoVisionMaxBytesMB', AUTO_VISION_MAX_BYTES / 1024 / 1024) * 1024 * 1024,
    maxTotalChars: (Number.isFinite(limits?.maxTotalChars) && limits.maxTotalChars > 0)
      ? limits.maxTotalChars
      : cfgLimit(cfg?.get, 'api.autoVisionMaxTotalChars', AUTO_VISION_MAX_TOTAL_CHARS),
    maxCount: limits?.maxCount
  });
  const maxBytes = eff.maxBytes;
  const maxTotalChars = eff.maxTotalChars;
  const maxBytesMB = formatMB(maxBytes);
  const list = Array.isArray(messages) ? messages : [];
  const out = { messages: list, attached: 0, urls: 0, skipped: 0, failed: [], notes: [], effectiveLimits: { ...eff } };
  try {
    if (!list.length) return out;
    if (!autoVisionRuns({ proactive })) return out;
    if (!autoVisionEnabled(cfg?.get, verdictOf)) return out;

    const extra = Array.isArray(extraEvidence) ? extraEvidence : [];
    // 本轮触发的图排在前面，邻图顺延补入；总数仍受 eff.maxCount 合同约束（不因多一个来源放宽）。
    const urls = [];
    for (const src of [evidence, extra]) {
      if (urls.length >= eff.maxCount) break;
      for (const u of triggerImageUrls(src, { limit: eff.maxCount, resolveUrl })) {
        if (urls.length >= eff.maxCount) break;
        if (!urls.includes(u)) urls.push(u);
      }
    }
    out.urls = urls.length;
    out.extraUrls = extra.length ? urls.length - triggerImageUrls(evidence, { limit: eff.maxCount, resolveUrl }).length : 0;
    const imageEntries = countImageEntries(evidence) + countImageEntries(extra);
    out.imageEntries = imageEntries;
    if (!urls.length) {
      // ★ N-NOURL：有图但一条地址都没解析出来 ⇒ 明说"没拿到地址"，不许静默
      //   （提示词里那句"没有识别出画面内容"会把原因讲错，见 autoVisionNoUrlNote）。
      //   一条图都没有的正常轮次（纯文字/纯表情/视频）依旧什么都不说，不加噪音。
      if (imageEntries > 0) {
        const idx = lastUserIndex(list);
        if (idx >= 0) {
          const current = list[idx];
          const textPart = Array.isArray(current.content)
            ? (current.content.find((p) => p?.type === 'text')?.text ?? '')
            : String(current.content ?? '');
          const next = list.slice();
          // 本轮图片状态放在稳定上下文之后，避免带图/不带图切换截断历史前缀。
          next[idx] = { role: 'user', content: `${textPart}\n\n${autoVisionNoUrlNote({ count: imageEntries })}` };
          out.messages = next;
        }
        log?.('compose-auto-vision-no-url', { imageEntries });
      }
      return out;
    }

    const idx = lastUserIndex(list);
    if (idx < 0) return out;

    const shrinkImage = typeof modules?.media?.shrinkImageForVision === 'function' ? modules.media.shrinkImageForVision : null;
    const encodePng = typeof modules?.media?.encodePng === 'function' ? modules.media.encodePng : null;
    const safeFetchBinary = modules?.internet?.safeFetchBinary;
    const toVisionDataUrls = modules?.media?.toVisionDataUrls;
    const detectMime = modules?.media?.detectImageMime;
    if (typeof safeFetchBinary !== 'function' || typeof toVisionDataUrls !== 'function') {
      // 依赖没就绪：如实说，不许假装看见（与 N26 的"失败要给明确事实"同一口径）。
      // ★ #14（2026-10-18）：这条路径原来**静默**（只有一条 log）—— 模型只看到 [图片]
      //   占位符、一句"看不到"都没有；现在与 N-NOURL 同口径，把事实写进 user 消息。
      log?.('compose-auto-vision-deps-missing', { urls: urls.length });
      const idx0 = lastUserIndex(list);
      if (idx0 >= 0) {
        const current = list[idx0];
        const textPart = Array.isArray(current.content)
          ? (current.content.find((p) => p?.type === 'text')?.text ?? '')
          : String(current.content ?? '');
        const next = list.slice();
        next[idx0] = { role: 'user', content: `${textPart}\n\n${autoVisionDepsNote({ count: imageEntries > 0 ? imageEntries : urls.length })}` };
        out.messages = next;
      }
      return out;
    }

    const dataUrls = [];
    const notes = [];
    const failed = [];
    const tooBig = [];
    let skipped = 0;
    let totalChars = 0;
    // ★ 2026-10-26（识图修复）：URL → 消息 mid 的映射（收图字节缓存按 mid 落盘）。
    const urlMidPairs = (function buildPairs() {
      const pairs = [];
      const seen = new Set();
      for (const e of [...(Array.isArray(evidence) ? evidence : []), ...extra]) {
        for (const m of Array.isArray(e?.media) ? e.media : []) {
          if (m?.type !== 'image') continue;
          const url = typeof resolveUrl === 'function' ? (resolveUrl(e, m) || (/^https?:\/\//i.test(String(m?.id ?? '')) ? m.id : null)) : (/^https?:\/\//i.test(String(m?.id ?? '')) ? m.id : null);
          if (!url || seen.has(url)) continue;
          seen.add(url);
          pairs.push({ url, mid: String(e?.id ?? '') });
        }
      }
      return pairs;
    })();
    for (const url of urls) {
      try {
        let buffer = null;
        let contentType = null;
        // 先试收图瞬间的本地字节缓存（prefetchImageBytesForIncoming 落的盘），
        // 没命中再走网络下载 —— QQ 图 URL 是短命资源，死链时缓存是唯一还看得见的原图。
        const readCache = typeof modules?.media?.readIncomingImageCache === 'function'
          ? modules.media.readIncomingImageCache
          : null;
        if (readCache) {
          const pair = urlMidPairs.find((p) => p.url === url);
          if (pair?.mid) {
            const hit = readCache(pair.mid, url);
            if (hit?.buf?.length) { buffer = hit.buf; contentType = null; }
          }
        }
        if (!buffer?.length) {
          ({ buffer, contentType } = await safeFetchBinary(url, Math.max(8 * 1024 * 1024, maxBytes), { browseLocked: true }));
        }
        if (!buffer?.length) throw new Error('图片内容为空');
        const mime = (typeof detectMime === 'function' ? detectMime(buffer) : null) || String(contentType || 'image/jpeg').split(';')[0];
        // ★ N85（用户批准「加，没事」）：**先试着缩到 1024 再附**，缩不动才"不附 + 明说"。
        //   纯 JS 只解 PNG；GIF 由 toVisionDataUrls 自己抽帧（tileFrames 已会缩到 1024）；
        //   JPEG/WEBP 靠注入的 decodeForeign（sharp 之类），没有就如实说"没有可用解码器"。
        // ★ N-GIF（用户报「动图看不见」，2026-10-11 探针实测）：**GIF 不走这道原图字节闸** ——
        //   抽帧拼图本身就把输出压到 ≤1024²（tileFrames），"原图大"不等于"输出大"；
        //   而 shrinkImageForVision 对 GIF 没有分支（纯 JS 只解 PNG；真机没装 sharp、
        //   jpeg-js 解不了 GIF）⇒ 2.4MB 的真 GIF 实测被整张丢掉（attached=0、只留"太大没附"），
        //   能动却看不到。GIF 放行后由 toVisionDataUrls 抽帧 + 3MB 总量闸兜底。
        let useBuffer = buffer;
        let useMime = mime;
        let extraNote = '';
        const isGif = /^image\/gif$/i.test(String(mime));
        if (!isGif && buffer.length > maxBytes) {
          if (!shrinkImage) {
            tooBig.push(`${(buffer.length / 1024 / 1024).toFixed(1)}MB（没有缩放器：modules.media.shrinkImageForVision 未注入）`);
            continue;
          }
          const shrunk = await shrinkImage(buffer, mime, { encodePng, decodeForeign, maxSide: 1024 });
          if (!shrunk?.ok) {
            tooBig.push(`${(buffer.length / 1024 / 1024).toFixed(1)}MB${shrunk?.reason ? `（缩不动：${shrunk.reason}）` : ''}`);
            continue;
          }
          useBuffer = shrunk.buffer;
          useMime = shrunk.mime;
          extraNote = shrunk.note;
        }
        const prepared = await toVisionDataUrls(useBuffer, { mime: useMime, maxFrames: AUTO_VISION_MAX_FRAMES });
        if (prepared?.skipped || !prepared?.dataUrls?.length) {
          skipped += 1;
          if (prepared?.note) notes.push(prepared.note);
          continue;
        }
        // 总量闸：已附的不撤回，但不再继续附（后面的图明说"这轮没附"）
        const addChars = prepared.dataUrls.reduce((n, u) => n + String(u).length, 0);
        if (totalChars + addChars > maxTotalChars) {
          tooBig.push('拼图 base64 超出本轮总量上限');
          // ★ N-GIF6（用户实机报"动图…没有引导说是一个动图"）：被总量闸丢掉的也可能是
          //   "动图抽帧拼图"——**note 不能跟着丢**。否则模型只看到"太大没附"，
          //   完全不知道这是一张动图、抽了几帧、该按连续画面看。
          if (prepared.note) notes.push(prepared.note);
          continue;
        }
        totalChars += addChars;
        dataUrls.push(...prepared.dataUrls);
        if (extraNote) notes.push(extraNote);   // ★ 缩过的必须说明"这是缩图"，别让模型猜
        if (prepared.note) notes.push(prepared.note);
      } catch (error) {
        failed.push(String(error?.message ?? error));
      }
    }
    if (tooBig.length) {
      // 2026-10-13：去掉"让对方发小一点的图/让他直接说"的教用户句（客服腔来源之一）；只留事实与别猜。
      notes.push(`（另有 ${tooBig.length} 张因为太大这轮没附：单张上限 ${maxBytesMB}MB、`
        + `本轮 base64 总量上限 ${formatMB(maxTotalChars)}MB。`
        + '你现在看不到这几张，别描述也别猜。）');
      log?.('compose-auto-vision-too-big', { tooBig: tooBig.length, maxBytes, maxTotalChars });
    }
    out.skipped = skipped;
    out.failed = failed;
    out.notes = notes;
    out.attached = dataUrls.length;
    out.tooBig = tooBig.length;
    if (!dataUrls.length) {
      // ★ 老树 `:3107-3116`：一张都没取到时，把"你看不到这些图"写进 user 消息 ——
      //   宁可让她承认看不清，也不许她照着 [图片] 占位符编画面。
      const current = list[idx];
      const textPart = Array.isArray(current.content)
        ? (current.content.find((p) => p?.type === 'text')?.text ?? '')
        : String(current.content ?? '');
      const next = list.slice();
      // 2026-10-14（收敛"看不到"叠处）：全丢走 miss 句时，括注里那句"看不到这几张"与 miss 的
      // tooBig 支说的是同一件事 ⇒ 只留 miss 句这一处（括注仍留给"部分附上"的 head，不删约束）。
      const missNotes = tooBig.length
        ? notes.filter((n) => !String(n ?? '').includes('看不到这几张'))
        : notes;
      next[idx] = { role: 'user', content: `${textPart}\n\n${autoVisionMissNote({ count: urls.length, failed, skipped, tooBig, notes: missNotes, maxBytes, maxTotalChars })}` };
      out.messages = next;
      log?.('compose-auto-vision-missed', { urls: urls.length, skipped, failed: failed.length, tooBig: tooBig.length });
      return out;
    }

    const current = list[idx];
    const textPart = Array.isArray(current.content)
      ? (current.content.find((p) => p?.type === 'text')?.text ?? '')
      : String(current.content ?? '');
    // 2026-10-13：判据范围收窄到本轮 evidence 文本（不再扫整块 user 提示词）；词表含「看图」。
    const explicitTask = explicitImageTask(evidence);
    const mediaOnly = (Array.isArray(evidence) ? evidence : []).every((e) => !String(e?.text ?? '')
      .replace(/\[图片\]|\[表情\]|\[语音\]|\[视频\]|\[文件\]|\[卡片消息\]|\[CQ:[^\]]*\]/g, '').trim());
    const note = autoVisionNote({ count: dataUrls.length, notes, skipped, failed, explicitTask, mediaOnly });
    const next = list.slice();
    next[idx] = { role: 'user', content: [{ type: 'text', text: `${textPart}\n\n${note}` }, ...dataUrls.map((u) => ({ type: 'image_url', image_url: { url: u } }))] };
    out.messages = next;
    log?.('compose-auto-vision-attached', { count: dataUrls.length, skipped, failed: failed.length });
    return out;
  } catch (error) {
    // 自动看图失败绝不影响本轮回话（老树同款：catch 后忽略）
    log?.('compose-auto-vision-failed', { reason: String(error?.message ?? error) });
    return out;
  }
}
