/**
 * M6 chat-model bridge for memory extraction (episodes + person impressions).
 *
 * The module still does not import `modules/llm`: the caller supplies a
 * `chatModel` function (or `{ chatCompletion }`) that has already selected the
 * configured provider/model. The bridge passes those names through as routing
 * metadata and turns the model's JSON reply into the coordinator's extract
 * contract — **一次调用产两样**：情节摘要（episodes）+ 人物印象候选（impressions）。
 * 第五批 N4（2026-10-19）：原来只产 episodes ⇒ 自动链永远不写人物印象；
 * 印象候选**搭同一次整理调用**，不新增"每条消息一次云调用"。
 */

const EXTRACT_PROMPT = [
  '你在给一个长期记忆系统做一次整理。输入是一段聊天记录，每行前有 [序号] 发言人（QQ id）：内容。',
  '',
  '要输出两样：① 这段里发生的事（情节摘要）；② 对**说话人本人**的长期印象候选。',
  '',
  '请输出 JSON（只输出 JSON，不要解释）：',
  '{"episodes":[{"summary":"一到三句人话","sourceRefs":[{"messageId":"原样照抄的 messageId"}],"openTodoIds":[]}],',
  ' "impressions":[{"subjectId":"原样照抄的发言人 id","claim":"对这个人一条长期印象（第三人称，一句话）","kind":"identity|preference|edge|style|event|attitude","sourceRefs":[{"messageId":"这个人自己发言的 messageId"}]}]}',
  '',
  '情节摘要的硬规则：',
  '1) summary 必须是这段记录里真的发生/真的说过的事；没有就返回空数组。',
  '2) sourceRefs 里的 messageId 必须原样照抄输入里的 messageId，不许改写、不许编。',
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

function parseExtract(reply) {
  const text = String(reply ?? '').trim();
  if (!text) throw new Error('模型回复为空');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1].trim() : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('回复里找不到 JSON 对象');
  let parsed;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch (error) {
    throw new Error(`回复不是合法 JSON（${String(error?.message ?? error).slice(0, 80)}）`);
  }
  const episodes = Array.isArray(parsed?.episodes) ? parsed.episodes
    : Array.isArray(parsed) ? parsed : null;
  if (!episodes) throw new Error('JSON 里没有 episodes 数组');
  return { episodes, impressions: Array.isArray(parsed?.impressions) ? parsed.impressions : [] };
}

function replyText(result) {
  if (typeof result === 'string') return result;
  if (typeof result?.message?.content === 'string') return result.message.content;
  if (typeof result?.content === 'string') return result.content;
  return '';
}

/**
 * Build an `extract` function for `createMemoryCoordinator`.
 *
 * `chatModel` is called as:
 *   chatModel({ messages, tools: null, temperature: 0, provider, model, purpose: 'memory-extract' })
 * It may return a string or the usual `{ message: { content } }` response.
 * A raw LLM function that needs provider-specific overrides should be wrapped
 * by the assembly layer so it resolves `provider`/`model` before calling it.
 */
export function createMemoryExtractor({
  chatModel,
  provider = '',
  model = '',
  maxCharsPerSource = 400,
  maxSources = 80,
  log = null,
} = {}) {
  const call = typeof chatModel === 'function'
    ? chatModel
    : typeof chatModel?.chatCompletion === 'function'
      ? (request) => chatModel.chatCompletion(request)
      : null;
  if (!call) return null;

  const providerName = String(provider ?? '').trim();
  const modelName = String(model ?? '').trim();
  const sourceCharLimit = Math.max(1, Math.floor(Number(maxCharsPerSource) || 400));
  const sourceLimit = Math.max(1, Math.floor(Number(maxSources) || 80));

  return async function extract({ chatKey = '', kind = 'group', sources = [], maxEpisodes = 8, maxImpressions = 3 } = {}) {
    const all = Array.isArray(sources) ? sources : [];
    const list = all.slice(0, sourceLimit);
    if (!list.length) return { episodes: [], impressions: [], sourceCount: 0, skippedSources: all.length };

    const body = list.map((source, index) => {
      const speakerId = String(source?.speakerId ?? '?');
      const messageId = String(source?.messageId ?? '');
      const text = String(source?.text ?? '').slice(0, sourceCharLimit);
      return `[${index}] ${speakerId}（messageId=${messageId}）：${text}`;
    }).join('\n');
    const episodeLimit = Math.max(1, Math.floor(Number(maxEpisodes) || 8));
    const impressionLimit = Number.isFinite(Number(maxImpressions))
      ? Math.max(0, Math.floor(Number(maxImpressions)))
      : 3;
    const response = await call({
      messages: [
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: `会话：${chatKey}（${kind}）\n待整理记录（最多 ${episodeLimit} 条摘要、最多 ${impressionLimit} 条长期印象）：\n${body}` }
      ],
      tools: null,
      temperature: 0,
      provider: providerName,
      model: modelName,
      purpose: 'memory-extract',
    });

    const { episodes, impressions } = parseExtract(replyText(response));
    const allowed = new Set(list.map((source) => String(source?.messageId ?? '')).filter(Boolean));
    const kept = episodes
      .map((episode) => ({
        ...episode,
        sourceRefs: (Array.isArray(episode?.sourceRefs) ? episode.sourceRefs : [])
          .map((ref) => ({ ...ref, messageId: String(ref?.messageId ?? ref?.id ?? '') }))
          .filter((ref) => allowed.has(ref.messageId))
      }))
      .filter((episode) => episode.sourceRefs.length > 0 && String(episode?.summary ?? '').trim() !== '')
      .slice(0, episodeLimit);

    // ★ 印象候选：messageId 先挡一道（只认本批原样给出的），且**必须引用说话人自己的发言**
    //   （依据是别人的话 = 不算这个人的印象）。coordinator 侧还会再过一遍同样的判据 + 证据账本复核。
    const speakerByMsg = new Map(list.map((source) => [String(source?.messageId ?? ''), String(source?.speakerId ?? '')]));
    const keptImpressions = impressions
      .map((imp) => {
        const subjectId = String(imp?.subjectId ?? '').trim();
        const refs = (Array.isArray(imp?.sourceRefs) ? imp.sourceRefs : [])
          .map((ref) => ({ ...ref, messageId: String(ref?.messageId ?? ref?.id ?? '') }))
          .filter((ref) => allowed.has(ref.messageId));
        return {
          subjectId,
          claim: normalizeClaim(subjectId, imp?.claim),
          kind: String(imp?.kind ?? '').trim(),
          sourceRefs: refs.filter((ref) => speakerByMsg.get(ref.messageId) === subjectId),
        };
      })
      .filter((imp) => imp.subjectId && imp.subjectId !== SELF_ID && imp.claim && imp.sourceRefs.length > 0)
      .slice(0, impressionLimit);

    const dropped = episodes.length - kept.length;
    const impressionsDropped = impressions.length - keptImpressions.length;
    if (dropped > 0 || impressionsDropped > 0) {
      try { log?.('info', 'memory-extract-dropped', { chatKey, dropped, impressionsDropped }); } catch { /* logging must not break extraction */ }
    }
    return { episodes: kept, impressions: keptImpressions, sourceCount: list.length, skippedSources: all.length - list.length };
  };
}
