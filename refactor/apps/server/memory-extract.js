/**
 * `refactor/apps/server/memory-extract.js` — M6 的 **`extract` 依赖注入源**（N33 第二次追加）
 *
 * ## 为什么这个文件在 apps/server 而不是 modules/memory
 * 方案 §4.2 原话：**「`extract` 由装配层注入，M6 不直接依赖 llm 模块」**（bunny2 严格照做了，
 * `modules/memory/**` 零 llm import）。所以"谁来调模型做抽取"这件事天然落在**装配层**——也就是本目录。
 * ★ 走 `modules/llm/index.js` 的**公开出口** `chatCompletion`，**不改 `llm.js`**（它是受管副本，
 *   有逐行差异闸门）；因此**不需要**新建 EXTRA 文件来躲闸门，也不碰 `modules/llm/**`。
 *
 * ## 入参契约（2026-10-19 第五批 N4 起；coordinator.js 实际调用点逐项对齐）
 * ```
 * extract({ chatKey, kind, reason, sources, attempt, cursor, maxEpisodes: 8, maxImpressions: <n> })
 *   → { episodes: [{ id?, summary, sourceRefs:[{messageId, chatKey?, speakerId?, at?}],
 *                    sourceRange?, openTodoIds?, version?, validUntil? }],
 *       impressions?: [{ subjectId, claim, kind, sourceRefs:[{messageId}] }] }
 * ```
 * ★ N4：人物印象候选**搭同一次整理调用**产出（不新增模型调用次数）；`maxImpressions`
 *   是单批候选上限（coordinator `maxImpressionsPerRun`，0 = 本轮不收印象）。
 *   落盘前的逐条校验（subject/own-source/上限/编辑锁/幂等）全在 coordinator，本文件只做
 *   "messageId 必须原样来自本批、且依据必须是被写的人**自己**的发言"这一道本地预挡。
 * 硬约束（`coordinator.js` `validateEpisodes` / `validateImpressions`，逐条照它写）：
 *   ① `summary` 非空（**空摘要一律被拒** —— 这正是"不许编造"的闸）；
 *   ② `sourceRefs` 非空；
 *   ③ **每个 `sourceRefs[].messageId` 必须真实存在于证据账本**（`hasEvidenceRow`）——
 *      ⇒ 只能引用 `sources` 里**原样给出**的 messageId，**不许编**；
 *   ④ 不得超过 `maxEpisodes`；印象不超过 `maxImpressions`，且不能拿**别人**的发言当
 *      某个人的依据（"甲引用乙"也不能推成甲的长期事实）。
 *   ★ 本文件**另外**自己做一道 JSON 抽取防线（模型回的不是纯 JSON 就当失败，如实抛）——
 *     解析失败宁可抛给 coordinator 记 `extract-threw:`，也不塞一条半截摘要进去。
 *
 * ## 失败口径
 * 任何一步失败都**抛**（`throw`）—— coordinator 会把 job 标成失败并记 `extract-threw:<原因>`，
 * 这比"悄悄回空 episodes、让 job 显示 done"诚实得多。
 */

/** 从模型回复里抠出 JSON 对象（容忍 ```json 围栏与前后废话）→ { episodes, impressions }。 */
function parseExtract(reply) {
  const text = String(reply ?? '').trim();
  if (!text) throw new Error('extract-threw: 模型回复为空');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1].trim() : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('extract-threw: 回复里找不到 JSON 对象');
  let parsed;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch (e) {
    throw new Error(`extract-threw: 回复不是合法 JSON（${String(e?.message ?? e).slice(0, 80)}）`);
  }
  const episodes = Array.isArray(parsed?.episodes) ? parsed.episodes
    : Array.isArray(parsed) ? parsed : null;
  if (!episodes) throw new Error('extract-threw: JSON 里没有 episodes 数组');
  const impressions = Array.isArray(parsed?.impressions) ? parsed.impressions : [];
  return { episodes, impressions };
}

/** 抽取提示词。**只给必要的东西**，不塞整段聊天，不教模型写正文。 */
const EXTRACT_PROMPT = [
  '你在给一个长期记忆系统做一次整理。输入是一段聊天记录，每行前有 [序号] 发言人（QQ id）：内容。',
  '',
  '要输出两样：① 这段里发生的事（情节摘要）；② 对**说话人本人**的长期印象候选。',
  '',
  '请输出 JSON（只输出 JSON，不要解释）：',
  '{"episodes":[{"summary":"这段里发生了什么，一到三句人话","sourceRefs":[{"messageId":"原样照抄的 messageId"}],"openTodoIds":[]}],',
  ' "impressions":[{"subjectId":"原样照抄的发言人 id","claim":"对这个人一条长期印象（第三人称，一句话）","kind":"identity|preference|edge|style|event|attitude","sourceRefs":[{"messageId":"这个人自己发言的 messageId"}]}]}',
  '',
  '情节摘要的硬规则：',
  '1) summary 必须是这段记录里**真的发生/真的说过**的事；没有就返回 {"episodes":[]}。',
  '2) sourceRefs 里的 messageId **必须原样照抄**输入里的 messageId，不许改写、不许编。',
  '3) 条数上限（摘要/印象各几条）以用户消息里的数字为准；挑信息量最大的，别逐条复述。',
  '',
  '长期印象的硬规则：',
  '4) 只写"以后跟这个人打交道用得上"的稳定特征：身份/关系（identity）、长期喜好（preference）、雷点（edge）、说话与互动风格（style）、值得留住的明确事实或经历（event）、长期态度（attitude）。',
  '5) 不写：一次性闲聊、临时话题、流水账、工具计数、好感数值、纯重复刷屏、没有依据的猜测。',
  '6) 每条 sourceRefs 只能引用**这个人自己**在输入里的发言（messageId 原样照抄）；依据是别人的话就不写这条。',
  '7) claim 用第三人称、别超过 60 字；宁少勿错；没有就返回空数组。',
  '',
  '人称与身份（2026-10-28 加的，别写错）：',
  'a) QQ ' + OWNER_ID + ' 是主人，一律写「她」——不许写「他」，也不许写「他/她」这种含糊说法。',
  'b) QQ 100000002 是机器人自己，**不给她写印象**（不要出现在 impressions 里）。',
  'c) 其他发言人不确定性别，就别用「他」：写「TA」，或者干脆只写事（「跑团，还差一个高卢团没带完」）。',
  'd) 写具体的：这个人做过什么、爱说什么、跟谁怎么互动。别写「常@机器人问…」这类换个说法就空了的句子。',
  'e) 尽量分散：这一批里还没被写过印象的发言人优先；同一个人的印象别反复写同一件事。',
  '',
  '8) 只输出 JSON。'
].join('\n');

const OWNER_ID = process.env.QQAGENT_OWNER_QQ || '100000001';   // 主人：她（社区版改成环境变量）
const SELF_ID = process.env.QQAGENT_SELF_QQ || '100000002';   // 机器人自己：不写印象

/** 把模型爱用的「他/他/她」收拾干净：对她一律"她"，别人性别不明就"TA"。 */
export function normalizeClaim(subjectId, claim) {
  let c = String(claim ?? '').replace(/\s+/g, ' ').trim();
  if (!c) return '';
  if (String(subjectId) === OWNER_ID) {
    c = c.replace(/他\s*\/\s*她/g, '她')
      .replace(/他\s*或\s*她/g, '她')
      .replace(/他们/g, '她们')
      .replace(/(?<!其)他(?!们)/g, '她');
  } else {
    c = c.replace(/他\s*\/\s*她/g, 'TA').replace(/他\s*或\s*她/g, 'TA');
  }
  return c;
}

/** 解析记忆整理本轮使用的模型；专用模型不继承聊天模型的密钥。 */
export function resolveMemoryExtractModel(cfg) {
  if (typeof cfg?.get !== 'function') return { configured: true, overrides: null };
  const full = cfg.get() || {};
  const memory = full.memory || {};
  if (memory.useChatModel !== false) {
    const api = full.api || {};
    return { configured: Boolean(String(api.model ?? '').trim() && String(api.baseUrl ?? '').trim()), overrides: null };
  }
  const providerId = String(memory.provider ?? '').trim();
  const model = String(memory.model ?? '').trim();
  const provider = (Array.isArray(full.providers) ? full.providers : []).find((p) => String(p?.id ?? '') === providerId);
  const baseUrl = String(provider?.baseURL ?? '').trim();
  if (!providerId || !model || !baseUrl) return { configured: false, overrides: null };
  // 专用提供商的密钥只能从它自己取；不能回退到聊天模型的 api.apiKey。
  const storedKey = String(full.dshProviderKeys?.[providerId] ?? '').trim();
  const legacyKey = String(provider?.apiKey ?? '').trim();
  const apiKey = storedKey && storedKey !== '******' ? storedKey : legacyKey;
  return {
    configured: true,
    overrides: { provider: providerId, model, baseUrl, apiKey: apiKey === '******' ? '' : apiKey }
  };
}

/**
 * 造 extract 函数。
 * @param {object} deps
 * @param {object} deps.llm `modules/llm` 命名空间（用它的公开出口 `chatCompletion`）
 * @param {object} [deps.cfg] 只读配置访问器；每次抽取读取当前模型选择。
 * @param {number} [deps.maxCharsPerSource] 单条来源进提示词的上限
 * @param {(level:string, code:string, fields?:object)=>void} [deps.log]
 * @returns {null|((args:object)=>Promise<{episodes:Array}>>)} `llm` 不可用时返回 null（装配层如实降级）
 */
export function createMemoryExtract({ llm, cfg = null, maxCharsPerSource = 400, maxSources = 80, log = null } = {}) {
  if (typeof llm?.chatCompletion !== 'function') return null;
  const sourceLimit = Math.max(1, Math.floor(Number(maxSources) || 80));

  return async function extract({ chatKey = '', kind = 'group', sources = [], maxEpisodes = 8, maxImpressions = 3, subjectIds = null } = {}) {
    // ★ N38：`subjectIds` = 「只整理这一个人」的收窄。
    //   在**新架构**里 episode 队列是**按会话**排的（`requestConsolidation({chatKey,kind,reason})`），
    //   没有按人的一档 ⇒ 真正的收窄只能落在**抽取这一层**：只把那个人的消息喂给模型。
    //   ⚠ 如实说明它**不是**全部：队列游标仍会在成功后推进（`runNextJob` 里属于 coordinator），
    //     所以**没被选中的人的这段消息不会留到下次**。要做到底需要 coordinator 侧按 subjectId
    //     收窄 `collectSources` 并据此推进游标 —— 那是 `modules/memory/**`（bunny2）的域，本票不碰。
    const wanted = (Array.isArray(subjectIds) ? subjectIds : [])
      .map((x) => String(x ?? '').trim()).filter(Boolean);
    const all = Array.isArray(sources) ? sources : [];
    const picked = wanted.length ? all.filter((s) => wanted.includes(String(s?.speakerId ?? ''))) : all;
    const list = picked.slice(0, sourceLimit);
    if (!list.length) return { episodes: [], impressions: [], narrowedTo: wanted, skipped: all.length };

    // ★ N4（第五批）：上限。episodes 至少 1 条；impressions 允许 0（= 本轮整轮不收印象，
    //   与 coordinator `maxImpressionsPerRun: 0` 的回退开关同义）。
    const episodeLimit = Math.max(1, Math.floor(Number(maxEpisodes) || 8));
    const impressionLimit = Number.isFinite(Number(maxImpressions))
      ? Math.max(0, Math.floor(Number(maxImpressions)))
      : 3;

    const body = list.map((s, i) => {
      const who = String(s?.speakerId ?? '?');
      const text = String(s?.text ?? '').slice(0, maxCharsPerSource);
      return `[${i}] ${who}（messageId=${String(s?.messageId ?? '')}）：${text}`;
    }).join('\n');

    const scopeLine = wanted.length
      ? `只整理这些人（其他人本轮**不进模型**）：${wanted.join('、')}\n`
      : '';
    const selectedModel = resolveMemoryExtractModel(cfg);
    if (!selectedModel.configured) throw new Error('memory-extract-model-not-configured');
    const result = await llm.chatCompletion({
      messages: [
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: `会话：${chatKey}（${kind}）\n${scopeLine}待整理记录（最多 ${episodeLimit} 条摘要、最多 ${impressionLimit} 条长期印象）：\n${body}` }
      ],
      tools: null,
      temperature: 0,
      overrides: selectedModel.overrides
    });

    const { episodes, impressions } = parseExtract(result?.message?.content);

    // ★ 只保留**引用了本次 sources 里真实 messageId** 的摘要 ——
    //   `validateEpisodes` 会再查一次证据账本，但模型最容易在这里编 id，先自己挡一道。
    const allowed = new Set(list.map((s) => String(s?.messageId ?? '')).filter(Boolean));
    const kept = episodes
      .map((ep) => ({
        ...ep,
        sourceRefs: (Array.isArray(ep?.sourceRefs) ? ep.sourceRefs : [])
          .map((r) => ({ ...r, messageId: String(r?.messageId ?? r?.id ?? '') }))
          .filter((r) => allowed.has(r.messageId))
      }))
      .filter((ep) => ep.sourceRefs.length > 0 && String(ep?.summary ?? '').trim() !== '')
      .slice(0, episodeLimit);

    // ★ 印象候选：messageId 先挡一道（只认本批原样给出的），且必须引用说话人**自己**的发言
    //   （依据是别人的话 = 不算这个人的印象；"甲引用乙"同样不能推成甲的长期事实）。
    //   主体还必须是非机器人自己的说话人（与 coordinator `validateImpressions` 的 humanSpeakers
    //   同口径；bot 自己这行是它的经历，不是"人物印象"）。coordinator 写入前还会再过一遍同样的
    //   判据（subject 非 self / 上限 / 编辑锁 / 幂等）。
    const speakerByMsg = new Map(list.map((s) => [String(s?.messageId ?? ''), String(s?.speakerId ?? '')]));
    const humanSpeakers = new Set(list.filter((s) => s?.self !== true)
      .map((s) => String(s?.speakerId ?? '')).filter(Boolean));
    const keptImpressions = impressions
      .map((imp) => {
        const subjectId = String(imp?.subjectId ?? '').trim();
        const refs = (Array.isArray(imp?.sourceRefs) ? imp.sourceRefs : [])
          .map((r) => ({ ...r, messageId: String(r?.messageId ?? r?.id ?? '') }))
          .filter((r) => allowed.has(r.messageId));
        return {
          subjectId,
          claim: normalizeClaim(subjectId, imp?.claim),
          kind: String(imp?.kind ?? '').trim(),
          sourceRefs: refs.filter((r) => speakerByMsg.get(r.messageId) === subjectId),
        };
      })
      .filter((imp) => imp.subjectId && imp.subjectId !== SELF_ID && humanSpeakers.has(imp.subjectId) && imp.claim && imp.sourceRefs.length > 0)
      .slice(0, impressionLimit);

    const dropped = episodes.length - kept.length;
    const impressionsDropped = impressions.length - keptImpressions.length;
    if (dropped > 0 || impressionsDropped > 0) {
      try { log?.('info', 'memory-extract-dropped', { chatKey, dropped, impressionsDropped }); } catch { /* 日志不许拖垮抽取 */ }
    }
    // ★ 2026-10-28：原来报的是 `all.length - picked.length`（只算"收窄没选中"的那部分），
    //   被送料上限切掉的那些**报成 0** —— 跟收集端静默丢内容是同一个病。现在按真实未入库条数报。
    return { episodes: kept, impressions: keptImpressions, narrowedTo: wanted.length ? wanted : null, sourceCount: list.length, skippedSources: all.length - list.length };
  };
}
