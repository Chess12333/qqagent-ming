// W-3b(2)：面板词表（词 → 人话标签 → 颜色）**唯一一份**。
//
// 为什么要有这个文件：主人报"会话状态胶囊看不懂"的根因是**同一个"完成"盘上有 5 种说法，
// 而 UI 只认了一部分**，认不出来的就走 `|| s.status` 这条兜底 ⇒ 直接把英文原词印在胶囊上
// （`done` / `noreply` / `skipped`…），既不报错也不显示人话。
//
// 三条规矩（都有牙，见 ui-preview.selftest.mjs / status-vocab.selftest.mjs）：
//   1. **兜底必须显性**：词表外的值 ⇒ 显示「原词 + 未登记角标」，禁止显示成"完成/成功"或空白。
//   2. **没播报要一眼看出来**：`sent=0` 且没有原因 ⇒ 胶囊显示醒目的「未发送」，不许显示成正常结束。
//   3. **不许写"完成/成功"这种结论词**：段级/结果级 label 一律用「正常结束 / 通过」，
//      这样"未发送"的那一轮在整块面板里 grep 不到"完成/成功"字样（牙 2 的判据）。
//
// 词表**不是手编的**：每一组都注明真源头（盘上枚举 + 代码里的封闭枚举），来源写清楚才允许加词。
// classic script 形态（挂 globalThis）⇒ 浏览器 `<script src>` 直接吃，
// node 侧用 `vm` 跑**同一份代码**（不许维护两份词表，那正是"面板与实发对不上"的老路子）。

(function installStatusVocab(global) {
  'use strict';

  // ── 会话状态胶囊 ──────────────────────────────────────────────
  // 源头：盘上 `data/sessions/*.json` 的 status 实测 7 个值
  //   （aborted / completed / delivered / done / error / noreply / skip）
  //   + 新树代码还会写出 waiting / running / skipped / wait / stopped
  //   （modules/orchestrator/index.js:650-901 的 writeFinish、modules/sessions/index.js:322-327）。
  var SESSION = {
    waiting: { label: '等待中', tone: 'gray' },
    running: { label: '运行中', tone: 'blue' },
    done: { label: '已发言', tone: 'green' },
    delivered: { label: '已发送', tone: 'green' },
    completed: { label: '正常结束', tone: 'green' },
    noreply: { label: '未回复', tone: 'gray' },
    skip: { label: '已跳过', tone: 'gray' },
    skipped: { label: '已跳过', tone: 'gray' },
    wait: { label: '延后处理', tone: 'gray' },
    stopped: { label: '被熔断拦停', tone: 'orange' },
    aborted: { label: '已中止', tone: 'orange' },
    error: { label: '出错', tone: 'red' }
  };

  // ── 轮次追踪（turnTrace）───────────────────────────────────────
  // 源头：core/observability/trace.js 的 STAGE_STATUSES + 盘上 turnTrace.outcome 实测 7 个值。
  var STAGE_STATUS = {
    ok: { label: '正常结束', tone: 'green' },
    error: { label: '失败', tone: 'red' },
    skipped: { label: '跳过', tone: 'gray' },
    timeout: { label: '超时', tone: 'orange' },
    unknown: { label: '状态未知', tone: 'orange' },
    aborted: { label: '中止', tone: 'orange' }
  };
  var OUTCOME = {
    ok: { label: '通过', tone: 'green' },
    error: { label: '失败', tone: 'red' },
    blocked: { label: '被扩展拦下', tone: 'orange' },
    duplicate: { label: '重复调用，已跳过', tone: 'gray' },
    no_match: { label: '没选中', tone: 'gray' },
    selected: { label: '已选中', tone: 'green' },
    completed: { label: '正常结束', tone: 'green' },
    delivered: { label: '已发送', tone: 'green' },
    done: { label: '已发言', tone: 'green' },
    noreply: { label: '未回复', tone: 'gray' },
    skip: { label: '未放行', tone: 'gray' }
  };
  // 源头：apps/ui/app.js 旧内联 stageLabels（契约键名不许改）
  var STAGE_NAME = {
    participation_gate: '参与路径判定',
    context_build: '上下文准备',
    model_call: '主模型调用',
    model_attempt: '主模型请求',
    retry_wait: '重试等待',
    sticker_pick: '表情选择',
    state_update: '状态与记忆更新'
  };
  // 源头：core/observability/ledgers.js:14-23（LANES / SOURCES 封闭枚举）
  var LANE = {
    addressed: '被直接叫到',
    topic_follow: '话题续聊',
    free_interjection: '自由插话',
    proactive: '主动开场',
    scheduled: '定时主动',
    ambient: '常规响应'
  };
  var SOURCE = {
    fallback: '默认路径',
    preflight: '运行前检查',
    schedule: '定时触发',
    proactive_opportunity: '主动机会',
    topic_continuity: '话题连续性',
    topic_continuity_rule: '规则续聊',
    jev_gate: 'Jev 判定',
    probability_gate: '概率闸门',
    direct_address: '直接点名',
    direct_request: '明确请求',
    keyword: '关键词',
    private_keyword: '私聊关键词',
    private_request: '私聊明确请求',
    private_reply: '回复机器人',
    private_recent_followup: '近期私聊续聊',
    private_media: '私聊图片',
    private_addressed: '私聊明确指向',
    private_policy: '私聊路由',
    private_empty_or_reaction: '纯符号/纯反应已抑制',
    private_non_request: '私聊无明确请求',
    all_messages_policy: '全量响应设置',
    allow_list_policy: '白名单设置'
  };
  // 源头：core/observability/ledgers.js:24-51（DECISIONS / REASONS / AUTHORITIES /
  //   MODEL_OUTCOMES / POLICY_OUTCOMES / BLOCK_REASONS 封闭枚举）
  //   + 盘上 decision-ledger 实测出现过的值。
  var DECISION = {
    speak: '放行发言（旧版记录）',
    gate_open: '路由门已开',
    candidate_delivered: '已交给主模型',
    actually_spoke: '已实际发言',
    // ★ C9：老树这条只由「actuallySpoke=false」推出（src/orchestrator.js:1840-1841），
    //   不等于"模型主动选择沉默"——别在词表里替它下这个结论。
    llm_silent: '主模型没发言',
    llm_error: '主模型出错',
    defer: '稍后处理',
    skip: '未放行'
  };
  var AUTHORITY = {
    must_reply: '请求直达主模型',
    model_decides: '主模型决定是否发送',
    rule_continue: '规则续聊直达',
    probabilistic: '自由插话判定',
    quiet: '规则安静',
    unknown: '权限未知',
    other: '权限未登记'
  };
  var MODEL_OUTCOME = {
    empty: '模型返回空',
    text_only: '只给正文没调工具',
    tool_calls: '调了工具',
    error: '模型出错',
    timeout: '模型超时'
  };
  var POLICY_OUTCOME = {
    blocked: '策略拦下',
    error: '策略出错',
    other: '策略结果未登记'
  };
  var BLOCK_REASON = {
    tool_hook: '扩展钩子拦下',
    text_only_judge: '纯文本判定拦下',
    narration_guard: '旁白守卫拦下',
    tool_error: '工具报错',
    other: '拦截原因未登记'
  };
  var REASON = {
    unknown: '原因未记', paused: '程序已暂停', chat_busy: '同会话已有任务',
    model_missing: '未设置主模型', self_muted: '机器人在群内被禁言',
    global_concurrency: '并发名额已满', incoming_preempted_proactive: '入站消息优先处理',
    batch_already_consumed: '批次已被其他操作消费', late_gate_result: '迟到判定已丢弃',
    jev_unevaluated_retry: 'Jev 未评估，安排重试', unevaluated_dropped: 'Jev 未评估，重试耗尽',
    jev_yes: 'Jev 允许候选', jev_no_hard: 'Jev 高置信否决', jev_no_soft: 'Jev 软否',
    jev_no: 'Jev 判不接', jev_abstain: 'Jev 弃权', jev_rejected: 'Jev 未放行',
    jev_error: 'Jev 出错', jev_unavailable: 'Jev 不可用', jev_speak: 'Jev 允许候选',
    intent_miss: '意愿抽样未中', prefilter_shortcut: '规则预过滤',
    quota_chat: '会话频率上限', quota: '频率上限',
    probability_hit: '概率命中', probability_miss: '概率未命中',
    session_setup_retry: '会话初始化失败，安排重试',
    session_setup_dropped: '会话初始化失败，重试耗尽',
    llm_unevaluated_retry: '主模型故障，安排重试', llm_unevaluated_dropped: '主模型故障，重试耗尽',
    candidate_delivered: '已交给主模型', receipt_sent: '主模型已发言',
    llm_silent_no_tool: '主模型没发言（没调发送工具）', llm_silent: '主模型没发言', llm_error: '主模型出错',
    late_session_error: '迟到会话报错', topic_continue_rule: '规则确认续聊',
    topic_continuity_rule: '规则续聊', topic_continue: '话题继续', topic_pause: '话题暂歇',
    direct_request: '明确请求', direct_address: '直接点名', keyword: '关键词',
    private_keyword: '私聊关键词', private_request: '私聊明确请求', private_reply: '回复机器人',
    private_recent_followup: '近期私聊对话继续', private_media: '私聊图片交由主模型判断',
    private_addressed: '私聊明确指向', private_non_request: '私聊无明确请求',
    private_policy: '私聊路由', private_empty_or_reaction: '纯符号/纯反应已抑制',
    all_messages_policy: '全量响应设置', allow_list_policy: '白名单设置',
    allow_not_listed: '白名单没列到这个聊天',
    tier_restricted: '当前档位不参与插话', free_interjection: '自由插话',
    other: '其它（原因被枚举表改写）'
  };
  // 源头：新树大写码 —— 逐个可查：compose 的三个未发原因（COMPOSE_*）、
  //   orchestrator/index.js:719 PLAN_MISSING、:752/:875 REPEAT_BLOCK_CIRCUIT、
  //   老树在盘上留下的 PRIVATE_RULE / HOUR_LIMIT / MODEL_TOOL_CALLS / FALLBACK。
  //   盘上 stage.code 还混了一批小写码（reply / drafted / ready / state_updated / backoff_*），
  //   那些是"阶段自述"不是结论码 ⇒ 查不到的照样显示原词 + 未登记（不许静默）。
  var CODE = {
    COMPOSE_GUARD: { label: '正文被守卫拦下（一个字都没发）', tone: 'red' },
    // ★ C9：COMPOSE_SILENT 的三个子情形里只有 quiet-protocol 是"明确选择静默"，
    //   另外两个是"没输出正文 / 正文裁判判为内部思考"（orchestrator undeliveredReason :1937-1940）
    //   ⇒ 词表不替它断言主动意图；子情形明细在终态码原文里。
    COMPOSE_SILENT: { label: '本轮没发言（静默协议或无正文）', tone: 'gray' },
    // ★ C9：正文进了模型、写了出来，但没调用 send_message —— 与"选择沉默"是两件事（:1963-1964）。
    COMPOSE_BODY_INTERNAL: { label: '正文留在内部（未调发送工具）', tone: 'gray' },
    COMPOSE_FINISHED_NO_TEXT: { label: '模型声明收尾但没给正文', tone: 'orange' },
    // ★ 2026-10-19（N1）：这个码的文本里带**子原因**（预算耗尽：model-call-limit / tool-budget-closeout / …），
    //   单看码不能断言"模型轮数用完" ⇒ 标签改成中性事实；具体病因用 composeLimitCause() 出人话。
    COMPOSE_EMPTY: { label: '预算/收口用尽（没拿到正文；子原因见轮次详情）', tone: 'orange' },
    PLAN_MISSING: { label: '没拿到行动计划', tone: 'red' },
    REPEAT_BLOCK_CIRCUIT: { label: '重复被拦 3 次，熔断', tone: 'red' },
    PRIVATE_RULE: { label: '私聊规则直达', tone: 'gray' },
    HOUR_LIMIT: { label: '每小时条数上限', tone: 'gray' },
    MODEL_TOOL_CALLS: { label: '模型这轮调的是工具', tone: 'gray' },
    FALLBACK: { label: '走默认路径', tone: 'gray' },
    reply: { label: '准备发言', tone: 'gray' },
    response: { label: '模型已返回', tone: 'gray' },
    drafted: { label: '正文已起草', tone: 'gray' },
    ready: { label: '就绪', tone: 'gray' },
    finished_no_text: { label: '收尾但没正文', tone: 'orange' },
    state_updated: { label: '状态已更新', tone: 'gray' },
    empty: { label: '这一档没产出内容', tone: 'gray' },
    Error: { label: '报错', tone: 'red' },
    // ★ P1-a：`replyReason` 会**照抄**真源给过的码 ⇒ 这些是盘上实测出现过的规划层码
    //   （`.tmp-dispatch/probe-p1a-derive.mjs`，样本 400：PRIVATE_RULE 18 / PROACTIVE_OPPORTUNITY 7 /
    //   INTENT_MISS 17 / DIRECT_QUESTION 5 / FREE_INTERJECTION 5 / DIRECT_MENTION 3 /
    //   COMPOSE_EMPTY 17 / COMPOSE_FINISHED_NO_TEXT 3 / BOT_QUESTION_ANSWER 1）。
    //   小写的同类词在 REASON 表里已经有了，大写那一份是 planReason 的码前缀格式 ⇒ 这里补上。
    PROACTIVE_OPPORTUNITY: { label: '主动机会：由模型决定说不说', tone: 'gray' },
    DIRECT_MENTION: { label: '被直接点名', tone: 'gray' },
    DIRECT_QUESTION: { label: '被直接问到', tone: 'gray' },
    BOT_QUESTION_ANSWER: { label: '回答对机器人的提问', tone: 'gray' },
    INTENT_MISS: { label: '意愿抽样未中', tone: 'gray' },
    FREE_INTERJECTION: { label: '自由插话', tone: 'gray' }
  };

  // ── SnowLuma 运行态（W-3e）────────────────────────────────────────
  //   真源头：apps/server/console-api.js 的 snowlumaRuntimeStatus() —— 五个值都是它写出来的
  //   （`unknown` 在 :172 的 base 与 :232 的探针失败分支，`running/starting/dead/not_running` 在 :220-238）。
  //   ★ 为什么 `unknown` 单独是一条而不是"没有"：**探针没探到 ≠ 没在跑**
  //     （触发条件有两条：模块导出了 status 但缺 isPortOpen；wsUrl 为空且 webuiPort=0）。
  //     老写法 `running ? '运行中' : '未运行'` 把 `running=null` 演成"未运行"，就是主人报的那个"实际在跑却说没跑"。
  var SNOWLUMA_STATE = {
    running: { label: '运行中', tone: 'green' },
    starting: { label: '起了但未就绪（端口还没监听）', tone: 'orange' },
    dead: { label: '起了又死了', tone: 'red' },
    not_running: { label: '未运行', tone: 'gray' },
    unknown: { label: '未知（状态未取到）', tone: 'orange' }
  };

  // ── P1-a：结果口径（"为什么没发"/"为什么没调工具"）───────────────────
  //   真源头：`modules/sessions/index.js` 的 `REPLY_OUTCOMES` / `TOOL_OUTCOMES` / `REPLY_REASON_CODES`
  //   （值与名**照抄架构答复 §E.15**，面板不许自创）。三张表与那三个导出必须**逐词相等**
  //   ⇒ 由 status-vocab.selftest.mjs 的覆盖牙钉死（少一个词就红，别等印在胶囊上才发现）。
  //   ★ 口径分工，不许挤成一团：`replyOutcome` 说**发出去没有**，`toolOutcome` 说**工具有没有动**，
  //     `replyReason` 说**为什么**（真源给过码就照抄原码，没给才是那套派生码）。
  //   ★ 2026-10-08 订正：P1-a 的回执写的是「面板**只有一套**判据（列表/详情共用 deriveOutcomes）」—— **不成立**。
  //     本表（`outcomeChips`）确实只读 `replyOutcome`/`replyReason`，但胶囊那条路（`undeliveredFlag`，:334）
  //     自己判「算不算未发送」；**理由与实测见那段注释**（列表投影不带 turnTrace ⇒ 服务端对列表行恒判 unknown）。
  //     现在这两套**允许对同一行给出不同的话**（胶囊「未发送」+ 结论条「结果未知」）—— 这是**记录在案的对立**，
  //     不是没看见的漂移。要收成一套，先给列表投影补 turnTrace（`modules/sessions/**` 的活）。
  var REPLY_OUTCOME = {
    sent: { label: '已发出', tone: 'green' },
    partial: { label: '部分发出', tone: 'orange' },
    // ★ C9：这一栏只回答"发出去没有"（来源 deriveOutcomes 的 silent 分支：进了模型、没发出、也**没有**拦截记录）。
    //   病因可能多种（模型静默 / 正文留在内部 / 其它）⇒ 标签不再断言"模型主动选择沉默"，
    //   具体原因看紧邻的「原因：」码。
    silent: { label: '没发出去（未见拦截）', tone: 'gray' },
    skipped: { label: '没放行（规划/闸门）', tone: 'gray' },
    blocked: { label: '正文被拦下', tone: 'red' },
    failed: { label: '发送失败', tone: 'red' },
    unknown: { label: '结果未知', tone: 'orange' }
  };
  var TOOL_OUTCOME = {
    not_entered: { label: '没进模型', tone: 'gray' },
    no_tools_offered: { label: '这一轮没提供工具', tone: 'gray' },
    text_chosen: { label: '只选正文，没调工具', tone: 'gray' },
    tools_used: { label: '调了工具', tone: 'green' },
    unknown: { label: '工具情况未知', tone: 'orange' }
  };
  // 派生码的"简短解释"（§E.15 要求码 + 解释一起给）；真源码走下面的 CODE / REASON。
  var REPLY_REASON = {
    SENT_OK: '有回执计数：这一轮发出去了',
    SENT_PARTIAL: '有内容发出去了，但同一轮里仍有发送动作报错',
    SEND_FAILED: '一条没发出去，且发送动作全部报错（平台侧失败）',
    MODEL_ERROR: '模型调用报错或超时',
    ROUND_ERROR: '这一轮整体报错',
    TEXT_ONLY_JUDGE: '模型只给正文没调工具 ⇒ 被纯文本判定拦下（不是"模型没回答"）',
    TOOL_HOOK_BLOCK: '扩展钩子拦下了这轮动作',
    POLICY_BLOCK: '策略判定拦下了',
    CIRCUIT_BLOCK: '重复被拦 3 次，熔断',
    MODEL_SILENT: '进了模型，这一轮没有发出（未见拦截）',
    PLAN_SKIPPED: '没进模型：规划或闸门没放行',
    RUNNING: '这一轮还在跑，没有结论',
    ABORTED: '这一轮被中止（不等于"决定不说话"）',
    COUNT_UNKNOWN: '盘上没给发送数（既无 sent[] 也无回执计数）',
    NO_TRACE: '这一轮没有追踪记录',
    STATUS_SAYS_SENT: '状态说"已投递"、回执却说 0 条 ⇒ 两个真源打架，不裁定'
  };

  // stage.code 的第二站：盘上这一格混装了 reason/source 那类机器词（见 codeLabel 的注释）。
  var SECOND_PASS = [REPLY_REASON, REASON, SOURCE, DECISION, AUTHORITY, MODEL_OUTCOME, POLICY_OUTCOME, BLOCK_REASON, STAGE_STATUS, OUTCOME, LANE];

  var UNREGISTERED_LABEL = '未登记';

  // 面板全程 innerHTML 渲染 ⇒ 词表值也要转义。app.js 的 esc() 在词表之后才定义，
  // 这里自带一份（口径同 ui/app.js:1351）；有宿主的 esc 就用宿主的，别维护两份规则。
  function escapeHtml(value) {
    if (typeof global.esc === 'function') return global.esc(value);
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function text(value) {
    return value == null ? '' : String(value).trim();
  }

  /**
   * 形状词：运行时**拼出来**的码（不是封闭枚举），逐个登记必然漏。
   * 实测来源：data/sessions/*.json 的 turnTrace.stages[].code（见 .tmp-dispatch/probe-w3b-vocab-coverage.mjs）。
   */
  function shapeLabel(key) {
    var m = /^backoff_(\d+)ms$/.exec(key);
    if (m) return `退避 ${m[1]} 毫秒后重试`;
    return null;
  }

  /**
   * 通用查词：命中 ⇒ {label,tone,known:true}；没命中 ⇒ **原词 + 未登记**（known:false）。
   * 空值不给"完成"这种结论词，只给「没记这个字段」。
   */
  function lookup(table, value, emptyLabel) {
    var key = text(value);
    if (!key) return { label: emptyLabel || '没记这个字段', tone: 'gray', known: false, raw: '' };
    var hit = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
    // 表里可以是裸字符串（名称类词表），统一成 {label,tone}
    if (typeof hit === 'string') hit = { label: hit, tone: 'gray' };
    if (!hit) {
      var shaped = shapeLabel(key);
      if (shaped) return { label: shaped, tone: 'gray', known: true, raw: key };
      return { label: key, tone: 'orange', known: false, raw: key };
    }
    return { label: hit.label || key, tone: hit.tone || 'gray', known: true, raw: key };
  }

  /** 渲染用：词表外 ⇒ 原词后面挂一个「未登记」角标（这就是主人看得懂的地方）。 */
  function badgeHtml(info) {
    var out = escapeHtml(info.label);
    if (!info.known && info.raw) out += '<span class="vocab-unregistered" title="这个词没登记进面板词表：不要当成成功，去看原词">' + escapeHtml(UNREGISTERED_LABEL) + '</span>';
    return out;
  }

  // 「没发出去」里有一类是**明确失败**（出错/中止/熔断）：那一格的原因已经写在状态上了，
  //   别再叠一句「发送数未给」把两种信息搅在一起（主人看到的就该是「出错」）。
  function isErrorish(status) {
    return status === 'error' || status === 'aborted' || status === 'stopped';
  }

  /**
   * 发送数的**三个真源**，谁有数听谁的（取大）。★ 关键分别：**"数到 0" 与 "没给数" 不是一回事**。
   *   · `s.sentCount` —— 列表项带的那个（服务端扫盘时顺手算，S-2 方向 A）
   *   · `s.sent[]`    —— 详情接口的逐条留档
   *   · `s.turnTrace.receipt.sentCount` —— M15 回执计数（详情）
   * @returns {{known:boolean, count:number}}
   */
  function sentCountOf(s) {
    var cands = [];
    var direct = s && s.sentCount;
    if (typeof direct === 'number' && isFinite(direct)) cands.push(direct < 0 ? 0 : direct);
    if (s && Array.isArray(s.sent)) cands.push(s.sent.length);
    var rc = s && s.turnTrace && s.turnTrace.receipt;
    var fromRc = rc && rc.sentCount;
    if (typeof fromRc === 'number' && isFinite(fromRc)) cands.push(fromRc < 0 ? 0 : fromRc);
    if (!cands.length) return { known: false, count: 0 };
    var max = cands[0];
    for (var i = 1; i < cands.length; i++) if (cands[i] > max) max = cands[i];
    return { known: true, count: max };
  }

  /**
   * 这一轮到底发出去没有 —— **列表侧的判据**。
   *
   * ★ 2026-10-08（假证据整改 · 收口 P1-a）**这段注释原来写的是「口径只有一条：回执计数是唯一的真话」**，
   *   那句话有兩個问题，都已按代码改正：
   *   ① 「口径只有一条」是**假的** —— 服务端 `modules/sessions/index.js:382 deriveOutcomes()` 是另一套，
   *      `outcomeChips()`（:501）读的就是它。本函数是**第二套**，不是唯一口径。
   *   ② 「回执计数是唯一的真话」也过强 —— 服务端在**真源打架**时是**故意不裁定**的
   *      （`deriveOutcomes` 的 `claimsSentButZero`：`status=delivered` 而计数 0 ⇒ 判 `unknown/STATUS_SAYS_SENT`，
   *      理由写在 `sessions/index.js:421-424`：「说 sent 是撒谎，说 silent/skipped 也是撒谎」）。
   *
   * ★★ **为什么第二套必须留着（不许当重复实现删掉）** —— 实测（`.tmp-dispatch/量-P05-投影覆盖.mjs`）：
   *   **列表投影（`summaryOf` 的 21 键）不带 `turnTrace`、也不带 `sent[]`** ⇒ 对**列表行**调 `deriveOutcomes`
   *   会在 `sessions/index.js:442` 的 `else if (!trace)` 一律落到 **`unknown`**。实测三条"一条都没发"的行：
   *     `sent:[]` + delivered      → unknown/STATUS_SAYS_SENT
   *     `sent:[]` + done/COMPOSE_EMPTY → unknown/COMPOSE_EMPTY
   *     `sent:[]` + delivered/COMPOSE_FINISHED_NO_TEXT → unknown/COMPOSE_FINISHED_NO_TEXT
   *   ⇒ **列表侧永远判不出 `silent`/`skipped`/`blocked`**。**删掉本函数 = 面板列表里的「未发送」整块消失**
   *   （主人报的那条"详情说有、列表说没有"会变成两边都不说）。这不是重复实现，是**列表侧唯一能说这句话的东西**。
   *   详情对象（`console-api.js:1248` 把 `deriveOutcomes` 拼进去）才有完整真源，那边走 `outcomeChips`。
   * ★ 因此这两套**不是同一件事的两份拷贝**：一套答「这轮的结果口径是什么」，一套答「胶囊上要不要亮红字」。
   *   要收成一套，正确顺序是**先让列表投影带上 `turnTrace`/`sent[]`**（那是 `modules/sessions/**` 的活，
   *   不在本文件），收完之后本函数才可以删。**在那之前不许删。**
   *
   * ★ S-2 三态不变：有真源按数判（0 就是没发，照亮）/ 运行中算待播 /
   *   **一个真源都没有 = `unknown`**（面板说「发送数未给」，既不装成功，也不冤枉成未发送）。
   *   **不许**改成"status 是 delivered 就算发了" —— 那会把真病例一起吞掉。
   * @param {object} s - 会话对象（列表项或详情对象：{status, sentCount, sent, rounds, turnTrace, finishReason, error}）
   */
  function undeliveredFlag(s) {
    var truth = sentCountOf(s);
    var status = text(s && s.status);
    var reason = text(s && (s.finishReason || s.error || (s.turnTrace && s.turnTrace.reason)));
    var running = status === 'running' || status === 'waiting';
    if (!truth.known) {
      if (running) return { undelivered: false, sentCount: null, reason: reason, pending: true };
      return { undelivered: false, unknown: true, errorish: isErrorish(status), sentCount: null, reason: reason };
    }
    if (truth.count > 0) return { undelivered: false, sentCount: truth.count, reason: reason };
    if (running) return { undelivered: false, sentCount: 0, reason: reason, pending: true };
    // 没发出去：要么有原因（如实显示原因），要么连原因都没有 ⇒ 「未发送·没记原因」
    var errorish = isErrorish(status);
    return { undelivered: !errorish, sentCount: 0, reason: reason, silent: !reason, errorish: errorish };
  }

  /**
   * 会话胶囊：状态词 → 人话，并且**覆盖**掉"看着像成功其实没播"的情况。
   * 返回 {label, tone, known, undelivered, unregistered, sentCount}。
   */
  function sessionStatus(s) {
    var info = lookup(SESSION, s && s.status);
    var flag = undeliveredFlag(s);
    if (flag.undelivered) {
      return {
        label: flag.silent ? '未发送·没记原因' : '未发送',
        tone: 'red',
        known: info.known,
        raw: info.raw,
        undelivered: true,
        unregistered: !info.known,
        sentCount: flag.sentCount,
        reason: flag.reason
      };
    }
    if (flag.pending) return { label: info.label || '进行中', tone: info.tone, known: info.known, raw: info.raw, pending: true };
    if (flag.unknown) {
      // 数没给 ⇒ 不点亮成"确认发了"，也不冤枉成"未发送"（S-2 三态的第三态）。
      //   但**明确失败**（出错/中止/熔断）不叠这句：那一格该看到的就是"出错"，别把两种信息搅一起。
      if (flag.errorish) {
        return {
          label: info.label, tone: info.tone, known: info.known, raw: info.raw,
          undelivered: false, unregistered: !info.known, sentCount: null, reason: flag.reason
        };
      }
      return {
        label: `${info.label || '无状态'}·发送数未给`,
        tone: 'orange',
        known: info.known,
        raw: info.raw,
        undelivered: false,
        unknown: true,
        unregistered: !info.known,
        sentCount: null,
        reason: flag.reason
      };
    }
    return {
      label: info.label,
      tone: info.tone,
      known: info.known,
      raw: info.raw,
      undelivered: false,
      unregistered: !info.known,
      sentCount: flag.sentCount
    };
  }

  /**
   * 胶囊 HTML：词表外挂「未登记」，未发送单独给醒目样式（`<span class="status-* vocab-undelivered">未发送</span>`，
   * 浏览器 `closest('.vocab-undelivered')` 与文本判据都吃得到）。
   */
  function sessionStatusHtml(s) {
    var info = sessionStatus(s);
    var label = escapeHtml(info.label);
    if (info.unregistered) label += '<span class="vocab-unregistered" title="状态词没登记进面板词表：不要当成成功">' + escapeHtml(UNREGISTERED_LABEL) + '</span>';
    return {
      label: label,
      tone: info.tone,
      // 未发送单独带一个类名：面板整体是 innerHTML 重绘的，测不到 DOM，
      // 但渲染字符串里留下这个类名 ⇒ 样式（红色加粗）和测试都有抓手。
      statusClass: 'status-' + (info.raw || 'unknown')
        + (info.undelivered ? ' vocab-undelivered' : '')
        + (info.unknown ? ' vocab-unverified' : ''),
      undelivered: info.undelivered === true,
      unverified: info.unknown === true,
      info: info
    };
  }

  /**
   * SnowLuma 那一行怎么说（W-3e）。
   * ★ 判据只有一条：**只有服务端真探过的四个明确态才许下"运行中/未运行"的结论**（`conclusive`）。
   *   `unknown`、没有 state、词表外的新 state ⇒ 一律 conclusive=false，UI 就不许点那个绿/灰灯，
   *   也不许写成"未运行"；词表外的值仍然是「原词 + 未登记」，宁可显式看不懂也不装懂。
   * @param {object} sl - `/api/status` 的 snowluma 字段（{state, running, warning, pid, …}）
   */
  function snowlumaRuntime(sl) {
    var state = text(sl && sl.state);
    if (!state) return { label: '未知（状态未取到）', tone: 'orange', known: false, raw: '', conclusive: false, dot: '' };
    var info = lookup(SNOWLUMA_STATE, state);
    var conclusive = info.known === true && state !== 'unknown';
    var dot = '';
    if (conclusive) dot = sl.running === true ? 'on' : (sl.running === false ? 'off' : '');
    return { label: info.label, tone: info.tone, known: info.known, raw: info.raw, conclusive: conclusive, dot: dot };
  }

  /**
   * stage.code / replyReason 这类"机器码"格子怎么查。
   * ★ stage.code 在盘上装的不只有大写码：实测 data/sessions 里有 14 个取值属于 reason/source 那一类
   *   （keyword / direct_address / jev_gate / private_* / topic_continuity* / schedule / empty）。
   *   到别的表里能找到就说人话，**全都找不到**才挂「未登记」—— 别把已经认识的词演成不认识。
   */
  function codeLabelOf(value) {
    var direct = lookup(CODE, value, '没记码');
    if (direct.known || !text(value)) return direct;
    var key = text(value);
    for (var i = 0; i < SECOND_PASS.length; i++) {
      var other = lookup(SECOND_PASS[i], key, '');
      if (other.known) return { label: other.label, tone: other.tone, known: true, raw: key };
    }
    return direct;
  }

  /**
   * `replyReason` 怎么说：**先查 P1-a 的派生码表**，查不到再走 `codeLabel` 的多站口径
   * （派生码之外，这个字段会**照抄真源给过的码**：COMPOSE_* / PRIVATE_RULE / INTENT_MISS …）。
   */
  function replyReasonText(value) {
    var mine = lookup(REPLY_REASON, value, '没记原因码');
    if (mine.known) return mine;
    return codeLabelOf(value);
  }

  /**
   * ★ P1-a：把「为什么没发」「为什么没调工具」渲染成两个胶囊（**判据不在 UI**：
   *   三键由 `modules/sessions/index.js` 的 `deriveOutcomes()` 算，列表/详情同一份）。
   *   词表外的值照旧挂「未登记」—— 编排层将来换新词，面板先显式看不懂，不许静默装懂。
   * @param {object} s 会话对象（列表项或详情对象都行：两处都带这三键）
   */
  function outcomeChips(s) {
    var reply = lookup(REPLY_OUTCOME, s && s.replyOutcome, '没记发送结果');
    var tool = lookup(TOOL_OUTCOME, s && s.toolOutcome, '没记工具情况');
    var reason = replyReasonText(s && s.replyReason);
    return { reply: reply, tool: tool, reason: reason, known: reply.known && tool.known };
  }

  // ── N1（2026-10-19）：预算/收口类结束的**子原因**（不统一叫"预算耗尽"）─────────────────
  //   真源：orchestrator 的 `undeliveredReason()` —— compose 的 incomplete reason 会落成
  //   `COMPOSE_EMPTY: 模型没给出正文（预算耗尽：<inner>，轮数 N，工具 M 次）`；
  //   `<inner>` 才是病因（工具次数 / 模型往返轮次 / 收口机会被占用 / 空正文 …）。
  //   这里只按 `<inner>` 出人话；判不出来就如实标"子原因未记录/未登记"，绝不硬塞成同一种预算耗尽。
  var COMPOSE_LIMIT_CAUSES = {
    'model-call-limit': { kind: 'model-rounds', label: '模型往返轮次用尽' },
    'tool-budget-closeout': { kind: 'tool-budget', label: '工具调用把收口预算占满（收口轮没能产出正文）' },
    'tool-loop-without-reply-slot': { kind: 'tool-budget', label: '工具轮占满、没有留出发言位' },
    'closeout-requested-tools': { kind: 'closeout-tools', label: '收口轮里模型仍要调工具（收口机会被占用）' },
    'closeout-requested-non-send-tool': { kind: 'closeout-tools', label: '收口轮请求了非发送工具（收口机会被占用）' },
    'required-output-missing': { kind: 'closeout-missing', label: '收口时缺少必答输出' },
    'duplicate-completed-output-suppressed': { kind: 'dup-output', label: '重复的完成输出被抑制（没有新的正文）' },
    'empty-model-response': { kind: 'empty', label: '模型返回空正文（不是预算）' }
  };
  function composeLimitCause(finishReason) {
    var s = text(finishReason);
    if (!/^COMPOSE_EMPTY\b/.test(s)) return null;
    var m = /预算耗尽：([a-z][a-z0-9-]*)/.exec(s);
    if (!m) return { kind: 'unknown', label: '预算/收口用尽（子原因未记录）', raw: '' };
    var hit = Object.prototype.hasOwnProperty.call(COMPOSE_LIMIT_CAUSES, m[1]) ? COMPOSE_LIMIT_CAUSES[m[1]] : null;
    return hit
      ? { kind: hit.kind, label: hit.label, raw: m[1] }
      : { kind: 'unknown', label: '预算/收口用尽（未登记子原因：' + m[1] + '）', raw: m[1] };
  }

  global.STATUS_VOCAB = {
    tables: {
      session: SESSION, stageStatus: STAGE_STATUS, outcome: OUTCOME, stageName: STAGE_NAME,
      lane: LANE, source: SOURCE, decision: DECISION, authority: AUTHORITY,
      modelOutcome: MODEL_OUTCOME, policyOutcome: POLICY_OUTCOME, blockReason: BLOCK_REASON,
      reason: REASON, code: CODE, snowlumaState: SNOWLUMA_STATE,
      replyOutcome: REPLY_OUTCOME, toolOutcome: TOOL_OUTCOME, replyReason: REPLY_REASON
    },
    unregisteredLabel: UNREGISTERED_LABEL,
    lookup: lookup,
    badgeHtml: badgeHtml,
    sessionStatus: sessionStatus,
    sessionStatusHtml: sessionStatusHtml,
    snowlumaRuntime: snowlumaRuntime,
    undeliveredFlag: undeliveredFlag,
    sentCountOf: sentCountOf,
    statusLabel: function (v) { return lookup(SESSION, v); },
    stageStatusLabel: function (v) { return lookup(STAGE_STATUS, v, '没记状态'); },
    outcomeLabel: function (v) { return lookup(OUTCOME, v, '没记结果'); },
    stageNameLabel: function (v) { return lookup(STAGE_NAME, v, '未命名阶段'); },
    laneLabel: function (v) { return lookup(LANE, v, '未知路径'); },
    sourceLabel: function (v) { return lookup(SOURCE, v, '未知来源'); },
    decisionLabel: function (v) { return lookup(DECISION, v, '没记放行结果'); },
    authorityLabel: function (v) { return lookup(AUTHORITY, v, '没记权限'); },
    modelOutcomeLabel: function (v) { return lookup(MODEL_OUTCOME, v, '没记模型结果'); },
    policyOutcomeLabel: function (v) { return lookup(POLICY_OUTCOME, v, '没记策略结果'); },
    blockReasonLabel: function (v) { return lookup(BLOCK_REASON, v, '没记拦截原因'); },
    reasonLabel: function (v) { return lookup(REASON, v, '没记原因'); },
    // ★ P1-a：结果口径三档（值来自 `modules/sessions/index.js` 的 deriveOutcomes，面板只说人话不判据）
    replyOutcomeLabel: function (v) { return lookup(REPLY_OUTCOME, v, '没记发送结果'); },
    toolOutcomeLabel: function (v) { return lookup(TOOL_OUTCOME, v, '没记工具情况'); },
    replyReasonLabel: replyReasonText,
    outcomeChips: outcomeChips,
    codeLabel: codeLabelOf,
    // ★ N1：COMPOSE_EMPTY 的真实子原因（工具次数/模型轮次/收口机会/空正文…），查不到就如实报未记录。
    composeLimitCause: composeLimitCause,
    composeLimitCauses: COMPOSE_LIMIT_CAUSES
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
