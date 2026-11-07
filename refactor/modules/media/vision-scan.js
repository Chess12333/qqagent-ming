// 模型图片输入能力探测（vision scan）。
// 做法：发 32×32 纯色图（红 / 绿），问"这张图整体是什么颜色"。
//   红、绿都答对            → vision
//   4xx 且报错与图片相关    → no-vision（网关明确拒绝图片内容）
//   答成别的颜色 / 说看不到 → no-vision（照收图片但其实看不见）
//   鉴权/模型名类错误       → unknown（不武断）
//
// 两个曾经踩过的坑（2026-09 修）：
//   1. 原来用 1×1 测试图，**真实的视觉模型反而会 400 拒绝**（"The image length and
//      width do not meet..."），于是 qwen3-vl-flash / qwen3.8-flash 被误判成不支持图片；
//      换成 32×32 后正常。纯文本模型则照收不误。
//   2. 只看 HTTP 200 会被"收图但看不见"的模型骗过 —— 实测 qwen-flash、
//      qwen3-30b-a3b-instruct 对纯红/纯绿都回答"白色"。所以必须校验颜色。
// 结果持久化在 config.modelVision["providerId|||model"]，运行时用它门控看图工具。
import { getConfig, updateConfig } from '../../core/config-store/index.js';
import { builtinVisionResults } from './model-vision-docs.js';

// 32×32 纯色图（红 / 绿）：既能被真实视觉模型接受，又能校验"是否真的看见"。
const SOLID_RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGO4IydHU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAJI2YD1ZaHIvAAAAAElFTkSuQmCC';
const SOLID_GREEN_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGOQ22JDU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAJPMOD10f/aNAAAAAElFTkSuQmCC';

const COLOR_QUESTION = '这张图片整体是什么颜色？只回答颜色。';
const COLOR_WORDS = /红|red|绿|green|白|black|黑|灰|gray|grey|蓝|blue|黄|yellow|紫|purple|橙|orange|粉|pink|棕|brown/i;

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}${path}`;
}

function authHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/** 读取已保存的探测结果（含未检测的模型不存在条目）。 */
export function visionResults() {
  return getConfig().modelVision || {};
}

/** 查询某个模型（providerId|||modelId）的探测结论：'vision' | 'no-vision' | 'unknown' | undefined。 */
export function modelVisionVerdict(providerId, modelId) {
  const key = `${providerId || ''}|||${modelId || ''}`;
  return getConfig().modelVision?.[key]?.verdict;
}

/** 查询某个模型的图片输入结论：优先已持久化结论，其次内置官方资料表。 */
export function modelImageVerdict(providerId, modelId) {
  const saved = modelVisionVerdict(providerId, modelId);
  if (saved === 'vision' || saved === 'no-vision') return saved;
  const doc = builtinVisionResults([{ id: providerId, models: [modelId] }]);
  return doc[`${providerId || ''}|||${modelId || ''}`]?.verdict ?? saved;
}

/** 发一张纯色图问颜色。返回 { ok, status, reply, errText }。 */
async function askColor({ baseUrl, apiKey, model }, pngBase64, timeoutMs, maxTokens = 24) {
  try {
    const res = await fetch(joinUrl(baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: COLOR_QUESTION },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${pngBase64}` } }
          ]
        }],
        max_tokens: maxTokens,
        stream: false
      }),
      signal: AbortSignal.timeout(Math.min(Number(timeoutMs) || 25000, 25000))
    });
    const body = await res.json().catch(() => ({}));
    return {
      ok: res.ok,
      status: res.status,
      reply: String(body?.choices?.[0]?.message?.content ?? '').trim(),
      errText: String(body?.error?.message ?? body?.message ?? body?.detail?.error?.message ?? '')
    };
  } catch (error) {
    return { ok: false, status: 0, reply: '', errText: String(error?.message ?? error) };
  }
}

/** 问一次颜色；思考型模型可能把小额度全花在思维链上导致正文为空 → 加大额度再试一次。 */
async function askColorWithRetry(ctx, pngBase64, timeoutMs) {
  const first = await askColor(ctx, pngBase64, timeoutMs, 24);
  if (!first.ok || first.reply) return first;
  return askColor(ctx, pngBase64, timeoutMs, 512);
}

/**
 * 探测单个模型。返回 { verdict, note, httpStatus, latencyMs }。
 *
 * 为什么不再用 1×1 小图：真实的视觉模型（qwen3-vl-flash / qwen3.8-flash）会直接
 * 400 拒绝它 —— "The image length and width do not meet ..."，于是真视觉模型反而
 * 被误判成不支持图片。现在统一用 32×32 纯色图，既能被正常接受，又能校验"是否真的看见"。
 *
 * 判定：
 *   4xx 且报错与图片相关 → no-vision（网关明确拒绝图片内容）
 *   红、绿两张纯色图都答对 → vision
 *   答成别的颜色 / 明确说看不到 → no-vision（照收图片但其实看不见，实测 qwen-flash 等）
 *   鉴权/模型名类错误 → unknown（不武断）
 *   颜色无法判定（如思考模型正文为空）→ vision，但 note 里注明未能校验
 */
export async function detectModelVision({ baseUrl, apiKey, model }, timeoutMs = 25000) {
  const started = Date.now();
  const base = { verdict: 'unknown', note: '', httpStatus: null, latencyMs: null };
  if (!baseUrl || !model) return { ...base, note: '缺端点地址或模型名' };

  const ctx = { baseUrl, apiKey, model };
  const red = await askColorWithRetry(ctx, SOLID_RED_PNG, timeoutMs);
  const latencyMs = Date.now() - started;

  if (!red.ok) {
    const errText = red.errText;
    const looksImageRelated = /image|图片|multimodal|multi-modal|visual|vision|modality|图像|看图|多模态|length and width|width and height/i.test(errText);
    const looksAuthOrModel = /unauthorized|api key|forbidden|quota|billing|余额|权限|密钥|not found|does not exist|不存在|无可用渠道|no available channel/i.test(errText);
    if (looksAuthOrModel && !looksImageRelated) {
      return { ...base, note: `无法判定：${errText.slice(0, 80) || `HTTP ${red.status}`}`, httpStatus: red.status, latencyMs };
    }
    if ([400, 404, 415, 422].includes(red.status) && !looksAuthOrModel) {
      return { verdict: 'no-vision', note: `HTTP ${red.status}${errText ? `：${errText.slice(0, 80)}` : ''}`, httpStatus: red.status, latencyMs };
    }
    return { ...base, note: `HTTP ${red.status}${errText ? `：${errText.slice(0, 80)}` : ''}`, httpStatus: red.status, latencyMs };
  }

  const green = await askColorWithRetry(ctx, SOLID_GREEN_PNG, timeoutMs);
  const totalLatency = Date.now() - started;
  const redOk = /红|red/i.test(red.reply);
  const greenOk = /绿|green/i.test(green.reply);
  if (redOk && greenOk) {
    return {
      verdict: 'vision',
      note: `接受图片且纯色图辨识正确（红→「${red.reply.slice(0, 10)}」，绿→「${green.reply.slice(0, 10)}」）`,
      httpStatus: 200,
      latencyMs: totalLatency
    };
  }
  const blind = /看不到|看不见|无法查看|无法显示|无法确定.{0,8}图|没有(提供)?图|未(能)?(提供|接收|获取|收到)图|没收到图|请(您)?(先)?提供(图|图片)|请上传(图|图片)|需要(您)?(提供|上传)(图|图片)|cannot see|can'?t see|unable to (see|view)|no image|not (been )?provided/i.test(red.reply + green.reply);
  const wrongColor = COLOR_WORDS.test(red.reply) || COLOR_WORDS.test(green.reply);
  if (blind || wrongColor) {
    return {
      verdict: 'no-vision',
      note: `接口接受图片但看不到内容：纯色图辨识失败（红→「${red.reply.slice(0, 12) || '空'}」，绿→「${green.reply.slice(0, 12) || '空'}」）`,
      httpStatus: 200,
      latencyMs: totalLatency
    };
  }
  return {
    verdict: 'vision',
    note: `接受图片，但颜色无法判定（红→「${red.reply.slice(0, 12) || '空'}」，绿→「${green.reply.slice(0, 12) || '空'}」）`,
    httpStatus: 200,
    latencyMs: totalLatency
  };
}

/**
 * 扫描目录（providerId 过滤可选）。并发受控，结果逐个写进 config 并通过 emit 汇报进度。
 * 返回 { total, results }。
 */
export async function scanModelsVision({ providers, emit = null, limit = 3, timeoutMs = 25000, onlyProviderIds = null } = {}) {
  const tasks = [];
  for (const p of providers || []) {
    if (onlyProviderIds && !onlyProviderIds.includes(p.id)) continue;
    if (!p.baseURL || !p.apiKey) continue; // 缺端点/密钥的提供商无从探测
    for (const model of p.models || []) {
      tasks.push({ providerId: p.id, model, baseURL: p.baseURL, apiKey: p.apiKey });
    }
  }
  const total = tasks.length;
  let done = 0;

  // 结果先在内存累积，扫描结束（或每满 5 条 / 每 2 秒）统一写一次盘。
  // 原先每个模型都调一次 updateConfig → 每次 deepMerge + structuredClone 全量配置
  // + fs.writeFileSync 同步落盘。扫 50 个模型 = 50 次全量序列化 + 50 次阻塞写盘，
  // 扫描期间主线程被 I/O 拖住，中途崩溃还会留下半写状态。
  const pending = new Map();
  const flushPending = () => {
    if (!pending.size) return;
    const patch = {};
    for (const [key, v] of pending) patch[key] = v;
    pending.clear();
    updateConfig({ modelVision: patch });
  };
  const flushTimer = setInterval(flushPending, 2000);

  const runTask = async (task) => {
    const key = `${task.providerId}|||${task.model}`;
    const r = await detectModelVision({ baseUrl: task.baseURL, apiKey: task.apiKey, model: task.model }, timeoutMs);
        pending.set(key, {
          providerId: task.providerId,
          model: task.model,
          verdict: r.verdict,
          note: r.note,
          httpStatus: r.httpStatus,
          latencyMs: r.latencyMs,
          source: 'probe',
          checkedAt: Date.now()
        });
        if (pending.size >= 5) flushPending();
    done += 1;
    emit?.('vision-scan', { key, providerId: task.providerId, model: task.model, verdict: r.verdict, done, total });
  };

  // 简单并发池
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length || 1)) }, async () => {
    while (index < tasks.length) {
      const task = tasks[index++];
      await runTask(task).catch((error) => {
        done += 1;
        emit?.('vision-scan', { key: `${task.providerId}|||${task.model}`, providerId: task.providerId, model: task.model, verdict: 'unknown', done, total, error: String(error?.message ?? error) });
      });
    }
  });
  await Promise.all(workers);
  clearInterval(flushTimer);
  flushPending();   // 收尾：剩余结果一次写盘，确保不丢
  return { total, results: { ...builtinVisionResults(providers || []), ...visionResults() } };
}
