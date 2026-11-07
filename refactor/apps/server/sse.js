/**
 * refactor/apps/server/sse.js —— `/api/events` 的**传输层**（SSE 长连接中枢）
 *
 * 为什么单独一个文件（2026-10-05）：
 *   `apps/server/index.js:121-135` 那段内联块建了长连接、发了一条 `hello`，**然后全树没有任何一处
 *   往那集合里写过东西**（当时的尺子：`sseClients` 只出现在 `:43/:131/:132/:133`，唯一的 `res.write`
 *   是 `:129` 那句 hello）⇒ **通道建好了却从来没广播过一条消息**。旧树 `src/app.js:604-606` 是有
 *   广播的（`for (const res of sseClients) res.write(line)`），所以这是**新树漏掉的那一层**，不是设计上不要。
 *   本文件只管"把一条事件安全地送到所有活着的客户端"，**不决定送什么** —— 送什么由 `sse-bridge.js` 的表决定。
 *
 * 硬规矩（1–3 来自 2026-10-05 本票验收；4 来自 S08 第四批）：
 *   1. **一个坏客户端绝不许把调用方炸掉**：逐个 try/catch，写失败的从集合里摘掉（浏览器半开连接、
 *      中间代理掐断、Windows 上 socket 已销毁但 close 事件还没派发，都会让 `res.write` 抛）。
 *   2. **事件名必须是白名单里的字面量**：SSE 的帧头是文本，`name` 里塞换行就能往浏览器里注入任意帧
 *      （帧注入）。所以这里按 `allowedNames` 精确匹配，非法名**返回失败对象**，绝不 throw、绝不发送。
 *   3. **载荷不许带密钥类字段**：往浏览器推的每个字节都在本进程里，先脱敏再写（见 `redact`）。
 *   4. **写入必须过背压闸**（S08，2026-10-19 第四批）：`res.write` 返回 false 只说明"这一帧已进
 *      Node 缓冲"，**不许重发该帧**；之后的帧按客户端排队等 `drain`。每客户端队列按 UTF-8 字节设上限，
 *      超限 / 等 drain 超时都**明确断开**（重连后靠 Last-Event-ID 补取或 resync 追上）——
 *      绝不静默丢帧还假装补齐。hello / replay / resync / heartbeat / broadcast 全部走同一条发送路径。
 *
 * 依赖方向：apps（不 import 任何 modules/**，只吃注入的 log）
 */

/** 精确匹配（锚定）的密钥类字段名。刻意**不**用宽泛的 `/token/i`：`usage.totalTokens` 这类
 *  正常用量字段含 "token" 子串，宽匹配会把会话快照的用量打坏 —— 那比漏脱敏更难查。
 *  ★ 2026-10-17（ds1 安全审查）：补齐**驼峰/下划线混写**的既有配置键名 —— 它们此前不在表里
 *    （`webuiPassword`、`httpAccessToken` 等只按 'password'/'accesstoken' 精确比是对不上的）。
 *   仍然只做**整名**匹配：例如 `usage.totalTokens` 是 'tokens'，不命中任何一条。 */
const SECRET_KEYS = new Set([
  'apikey', 'api_key', 'api-key',
  'secret', 'clientsecret', 'client_secret', 'client-secret', 'secretkey', 'appsecret',
  'password', 'passwd', 'webuipassword', 'webui_password',
  'authorization', 'cookie', 'set-cookie',
  'token', 'accesstoken', 'access_token', 'access-token',
  'httpaccesstoken', 'http_access_token', 'httptoken', 'http_token',
  'refreshtoken', 'refresh_token', 'refresh-token',
  'bottoken', 'bot_token', 'bot-token',
  'dshproviderkeys', 'providerkeys',
  'privatekey', 'private_key'
]);

export const REDACTED = '[redacted]';

/** 深度上限：防环形引用与超深载荷把脱敏器变成 DOS 面（超限时按 [redacted] 处理，宁可少写不可写炸）。 */
const MAX_DEPTH = 8;

/**
 * 递归脱敏。**只改键名命中的那些值**，其余原样保留（载荷形状不能被我改坏）。
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redact(value, depth = 0) {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SECRET_KEYS.has(String(key).toLowerCase()) ? REDACTED : redact(val, depth + 1);
  }
  return out;
}

/** 一条 SSE 帧：字段名 + JSON 载荷。`data` 必须是单行（JSON.stringify 不会产出裸换行）。
 *  ★ S3（2026-10-14）：可选第三参 `id`（形如 `<pid>-<seq>`）写成 `id:` 行 —— 放在 data **之后**，
 *    既符合 SSE 规范（一个事件块内字段顺序不限），也不破坏既有对 `event+data` 子串的断言。
 *    浏览器会把它记进 Last-Event-ID，断线重连时自动回传 ⇒ 这就是补取的入参。 */
export function frame(name, data, id) {
  let json;
  try { json = JSON.stringify(data ?? {}); }
  catch { json = JSON.stringify({ error: 'payload-not-serializable' }); }
  // JSON.stringify 对 undefined 返回 undefined（不是字符串）⇒ 兜成 {}
  if (typeof json !== 'string') json = '{}';
  const idLine = typeof id === 'string' && id ? `id: ${id}\n` : '';
  return `event: ${name}\ndata: ${json}\n${idLine}\n`;
}

/**
 * 创建 SSE 中枢。
 *
 * @param {object} [opts]
 * @param {(msg: string, extra?: object) => void} [opts.log] - 日志出口（注入，不自己 console）
 * @param {string[]} [opts.allowedNames] - **事件名白名单**（字面量）。不在其中 ⇒ broadcast 拒发。
 * @param {number} [opts.heartbeatMs=20000] - 保活注释帧间隔；有客户端时才起定时器。
 * @returns {{
 *   handle: (req: object, res: object) => boolean,
 *   broadcast: (name: string, data?: unknown) => {ok: boolean, reason?: string, sent?: number, queued?: number, dropped?: number},
 *   count: () => number,
 *   names: () => string[],
 *   close: () => {ended: number},
 *   isClosed: () => boolean
 * }}
 */
export function createSseHub({
  log = () => {},
  allowedNames = [],
  heartbeatMs = 20000,
  // ★ S3（断线补取）：缓冲窗口 = 最多 2000 条 且 最长 10 分钟，先到先淘汰。
  //   2000 条：峰值时 chat-update 约每秒几条，2000 ≈ 覆盖几分钟的静默重连；单条帧通常几 KB
  //   ⇒ 最坏 ~几 MB，进程内可承受。10 分钟：覆盖网络闪断 / 合盖睡眠 / 换页签的常见时长；
  //   更久的断线走"需要重拉"（resync），不靠 SSE 缓冲扛。
  backfillMaxEvents = 2000,
  backfillMaxAgeMs = 10 * 60 * 1000,
  // ★ S08（2026-10-19，第四批 P1）：补取缓冲的**字节总预算**（全局）。与条数/时长同为"先到先淘汰"，
  //   默认 16MiB ≈ 2000 条 × 8KB 量级。被字节预算挤出去的事件照样走窗口判定 ⇒ 补不上就 resync，
  //   绝不假装补齐（判定逻辑与条数/时长淘汰完全同一条路）。
  backfillMaxBytes = 16 * 1024 * 1024,
  // ★ S08：**每客户端**积压上限（UTF-8 字节）。只在客户端写不动（write 返回 false）时累计；
  //   超限即明确断开（重连后靠补取/resync 追上），绝不静默丢帧。
  perClientMaxBytes = 4 * 1024 * 1024,
  // ★ S08：客户端一旦进入"等 drain"状态最多等这么久；到点还没 drain 就断开（防半死连接永久占坑）。
  //   0/负数 = 不设超时（此时只受 perClientMaxBytes 约束）。
  slowClientDrainMs = 30000
} = {}) {
  // 白名单用 Set：O(1) 精确匹配；构造时就把非字符串/空串剔掉（防 `''` 或 `undefined` 混进白名单）
  const whitelist = new Set(
    (Array.isArray(allowedNames) ? allowedNames : [])
      .filter((n) => typeof n === 'string' && n.length > 0)
  );
  /** @type {Map<object, object>} 活着的客户端：res → 每客户端发送状态（S08 背压队列） */
  const clients = new Map();
  /** S08 明确断开计数（只增不减，供 stats 排障；"掉线"三个字必须能看到为什么）。 */
  const counters = { dropped: 0, overflows: 0, slowDrops: 0 };
  let timer = null;
  let closed = false;
  let heartbeats = 0;
  // ★ S3：进程号 + 单调序号 + 补取环形缓冲（即使一个客户端都没有也要记 —— 断线期间的事件就靠它补）
  const PID = process.pid;
  let seq = 0;
  /** @type {Array<{seq: number, at: number, line: string, bytes: number}>} line 已含 id 行（整帧文本） */
  const buffer = [];
  let bufferBytes = 0;   // ★ S08：缓冲字节合计（与条数/时长一起参与淘汰）
  const ID_RE = /^(\d+)-(\d+)$/;

  function say(msg, extra) { try { log(`[sse] ${msg}`, extra ?? {}); } catch { /* 日志不许反噬 */ } }

  /** 保活：`:\n\n` 是注释帧，浏览器忽略但能保住连接；定时器 unref ⇒ 不许因为 SSE 起不来让进程退不掉。 */
  function startHeartbeat() {
    if (timer || closed || clients.size === 0) return;
    if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) return;
    timer = setInterval(() => {
      heartbeats += 1;
      // ★ S08：保活帧也走同一条背压队列（写不动就排队/到限即断开，不再裸写 socket）
      for (const c of [...clients.values()]) sendTo(c, ':\n\n');
    }, heartbeatMs);
    // ★ unref：SSE 定时器不许成为进程退不掉的唯一理由
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stopHeartbeat() {
    if (!timer) return;
    try { clearInterval(timer); } catch { /* ignore */ }
    timer = null;
  }

  // ── S08 每客户端发送路径（背压）────────────────────────────────────────
  //  契约：`res.write` 返回 false ≠ 失败 —— 帧已被 Node 接收，**不许重发这一帧**；
  //  但它以后的所有帧要进本中枢的队列，等 socket `drain` 再按序放行。
  //  队列按 UTF-8 字节设上限；超限或等 drain 超时都走 dropClient（明确断开）——
  //  客户端重连会带 Last-Event-ID，补取窗口兜底，兜不住则 resync。**任何情况下不静默丢帧。**

  /** UTF-8 字节数（积压预算按字节算，不按 UTF-16 码元）。 */
  function utf8Len(s) { return Buffer.byteLength(s, 'utf8'); }

  function armSlowTimer(c) {
    if (c.slowTimer || !(slowClientDrainMs > 0)) return;
    c.slowTimer = setTimeout(() => {
      c.slowTimer = null;
      dropClient(c, 'slow-drain-timeout');
    }, slowClientDrainMs);
    // 与 heartbeat 同一条纪律：定时器不许成为进程退不掉的唯一理由
    if (typeof c.slowTimer.unref === 'function') c.slowTimer.unref();
  }

  function clearSlowTimer(c) {
    if (!c.slowTimer) return;
    try { clearTimeout(c.slowTimer); } catch { /* ignore */ }
    c.slowTimer = null;
  }

  /** 把挂在这个客户端上的监听器全摘掉（drain/error/close 三类 + 慢客户端定时器）。 */
  function detach(c) {
    clearSlowTimer(c);
    const res = c.res;
    if (typeof res?.removeListener === 'function') {
      try { res.removeListener('drain', c.onDrain); } catch { /* ignore */ }
      try { res.removeListener('error', c.onError); } catch { /* ignore */ }
      try { res.removeListener('close', c.onResClose); } catch { /* ignore */ }
    }
    if (typeof c.req?.removeListener === 'function') {
      try { c.req.removeListener('close', c.onReqClose); } catch { /* ignore */ }
    }
  }

  /**
   * 把一个坏/慢客户端摘掉。
   * ★ 必须 `res.end()`：只从 Map 里删掉是**漏 socket** —— 服务端这一侧还挂着连接，
   *   于是 `server.close()` 会一直等它（实测：洪峰把客户端写坏后，stop() 15s 不返回），
   *   端口不释放、进程退不掉。摘干净 = 删 Map + 摘监听器 + 清定时器 + 结束这一侧的响应。
   *   end() 自己也可能抛（对端已死），所以照样 try/catch，不许把异常带回调用方。
   */
  function dropClient(c, why) {
    if (!c || c.dropped || !clients.delete(c.res)) return false;
    c.dropped = true;
    counters.dropped += 1;
    if (why === 'queue-overflow') counters.overflows += 1;
    else if (why === 'slow-drain-timeout') counters.slowDrops += 1;
    detach(c);
    // 队列里的帧不"倒回"缓冲：它们本来就在 buffer 里（broadcast 先登记再投递）⇒ 重连补取；
    // 唯一不进 buffer 的是保活注释帧，丢掉无影响。这里只如实记账。
    say(`客户端掉线：${why}`, { clients: clients.size, queued: c.queue.length, queueBytes: c.queueBytes });
    c.queue.length = 0;
    c.queueBytes = 0;
    try { c.res.end(); } catch { /* 对端已经没了:end 抛也要摘干净 */ }
    if (clients.size === 0) stopHeartbeat();
    return true;
  }

  /** drain 到了：把队列按序放行；中途再遇到 write=false 就继续等下一次 drain。 */
  function flushClient(c) {
    if (c.dropped) return;
    c.drainPending = false;
    clearSlowTimer(c);
    while (c.queue.length) {
      const item = c.queue.shift();
      c.queueBytes -= item.bytes;
      try {
        if (c.res.write(item.text) === false) {
          c.drainPending = true;   // 帧已被 Node 接收（不许重发这一帧），后面的继续排队
          armSlowTimer(c);
          return;
        }
      } catch (e) { dropClient(c, `flush-write-failed:${e?.message ?? e}`); return; }
    }
  }

  /** 接管时把发送状态与监听器一次装好（drain 驱动放行；error/close 驱动清理）。 */
  function attachClient(req, res) {
    const c = {
      res, req,
      queue: [],          // [{text, bytes}] 等 drain 的帧（FIFO，顺序 = seq 顺序）
      queueBytes: 0,
      drainPending: false,
      slowTimer: null,
      dropped: false,
      onDrain: null, onError: null, onResClose: null, onReqClose: null
    };
    c.onDrain = () => flushClient(c);
    c.onError = () => dropClient(c, 'stream-error');
    c.onResClose = () => dropClient(c, 'client-closed');
    c.onReqClose = () => dropClient(c, 'client-closed');
    try { res?.on?.('drain', c.onDrain); } catch { /* ignore */ }
    try { res?.on?.('error', c.onError); } catch { /* ignore */ }
    try { res?.on?.('close', c.onResClose); } catch { /* ignore */ }
    clients.set(res, c);
    return c;
  }

  /**
   * 把一帧送进某个客户端 —— **所有帧的唯一出口**（hello/replay/resync/heartbeat/broadcast 全走这里）。
   * @returns {'sent'|'queued'|'dropped'}
   *   sent   = 已交给 Node（含"write 返回 false"的那一帧：它已被接收，只是后面要等 drain）
   *   queued = 客户端正在等 drain，帧进了本中枢队列（按序，drain 后放行）
   *   dropped= 该客户端已被明确断开（队列超限 / 写失败 / 超时；原因在 dropClient 里记账）
   */
  function sendTo(c, text) {
    if (c.dropped) return 'dropped';
    const bytes = utf8Len(text);
    // 已在等 drain（或队列里还有积压）⇒ 不许再碰 socket，先排队
    if (c.drainPending || c.queue.length) {
      if (c.queueBytes + bytes > perClientMaxBytes) {
        // 超限 = 明确的"追不上"：断开让客户端走重连 + 补取/resync，而不是丢帧后假装送达
        dropClient(c, 'queue-overflow');
        return 'dropped';
      }
      c.queue.push({ text, bytes });
      c.queueBytes += bytes;
      // 等 drain 期间又进新帧：deadline 仍是"第一次写不动"时起的那个（整段积压期共用一个截止点），
      // 不因新帧刷新 —— 否则一直有新事件就会一直续命，慢客户端永远摘不掉。
      armSlowTimer(c);
      return 'queued';
    }
    try {
      if (c.res.write(text) === false) {
        c.drainPending = true;   // 帧已被 Node 接收；禁止重发，等 drain
        armSlowTimer(c);
      }
      return 'sent';
    } catch (e) {
      dropClient(c, `write-failed:${e?.message ?? e}`);
      return 'dropped';
    }
  }

  /**
   * ★ S3：按客户端给的 lastEventId 补取遗漏事件。
   *   三种"补不上"（id 格式坏 / 换了进程 / 起点已滑出窗口）都回一帧 `resync`，
   *   让客户端去持久接口重取 —— **绝不假装补齐**。
   *   ★ S08：补取帧同样走 sendTo；直写与入队分开记账，不把"已排队"说成"已送达"。
   */
  function replay(c, raw) {
    const m = ID_RE.exec(raw);
    if (!m) { writeResync(c, 'malformed-id'); return; }
    const fromPid = Number(m[1]);
    const fromSeq = Number(m[2]);
    if (fromPid !== PID) { writeResync(c, 'process-changed'); return; }  // 服务重启过：跨进程无从补
    if (!Number.isFinite(fromSeq) || fromSeq < 0) { writeResync(c, 'malformed-id'); return; }
    if (fromSeq > seq) { writeResync(c, 'seq-ahead'); return; }          // 客户端比本进程还新（防御分支）
    if (buffer.length === 0) {
      // 本进程一条事件都没记过：客户端却拿着本进程的 id ⇒ 要的东西不在窗口里
      if (fromSeq < seq) writeResync(c, 'window-exceeded');
      return;   // fromSeq === seq：正好相等，无事可补
    }
    const oldest = buffer[0].seq;
    if (fromSeq + 1 < oldest) { writeResync(c, 'window-exceeded'); return; }
    let direct = 0;
    let queued = 0;
    for (const entry of buffer) {
      if (entry.seq <= fromSeq) continue;
      const r = sendTo(c, entry.line);
      if (r === 'dropped') return;   // 已明确断开（原因已在 dropClient 记账）
      if (r === 'queued') queued += 1; else direct += 1;
    }
    say(`已补取 ${direct + queued} 条（直写 ${direct} / 入队等 drain ${queued}）`, { fromSeq, lastSeq: seq });
  }

  /**
   * 补不上时的显式信号：客户端据此走"持久接口重取"，而不是以为自己已经补齐。
   * ★ S08：window 里补报字节预算 —— 补取窗口 = min(条数, 时长, 字节)，三者任一超了都补不上。
   */
  function writeResync(c, reason) {
    const r = sendTo(c, frame('resync', {
      reason,
      pid: PID,
      lastSeq: seq,
      window: { maxEvents: backfillMaxEvents, maxAgeMs: backfillMaxAgeMs, maxBytes: backfillMaxBytes },
      hint: '去持久接口重取全量状态；取完把 lastEventId 设成你手上最新的 id（或 hello.lastSeq）再继续订阅'
    }));
    say(r === 'dropped'
      ? `补不上，且客户端已断开（resync 未能送达）：${reason}`
      : `补不上，已发 resync：${reason}`, { lastSeq: seq });
  }

  /**
   * 接管一个 SSE 连接。
   * @returns {boolean} true = 已接管（调用方必须**立刻 return**，不许再走一次性响应那条路）
   */
  function handle(req, res) {
    // 只认 GET /api/events（语义与旧内联块一致：`startsWith` 容忍 `?lastEventId=` 之类查询串）
    const method = String(req?.method || '').toUpperCase();
    const url = String(req?.url || '');
    if (method !== 'GET' || !url.startsWith('/api/events')) return false;
    if (closed) {
      // 关掉之后不再接新连接（否则 stop() 之后 UI 会拿到一条永远不来的流）
      try { res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' }); res.end('{"ok":false,"error":"sse-closed"}'); } catch { /* ignore */ }
      return true;
    }

    try {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // nginx 之类的反代会缓冲 SSE ⇒ 显式关掉。不加这条，事件会攒到缓冲区满了才吐出来。
        'x-accel-buffering': 'no'
      });
    } catch (e) {
      say(`写头失败：${e?.message ?? e}`);
      return true;   // 已经占了这个请求，不许再落进一次性响应（那会二次写头）
    }

    const c = attachClient(req, res);
    // ★ S3：hello 带上进程号 / 当前序号 / 补取窗口 —— 客户端据此决定"要不要补、补不补得上"。
    //   hello **不带 id 行**：它的 id 既不是业务事件、也不该被浏览器记进 Last-Event-ID
    //   （否则下次重连会拿一个"没有事件含义"的 id 来要补取）。业务帧的 id 由 broadcast 写。
    if (sendTo(c, frame('hello', {
      pid: PID,
      lastSeq: seq,
      window: { maxEvents: backfillMaxEvents, maxAgeMs: backfillMaxAgeMs, maxBytes: backfillMaxBytes }
    })) === 'dropped') return true;

    // ★ S3 断线补取：查询串 `?lastEventId=` 或浏览器自动回传的 `Last-Event-ID` 头
    //   （两者取其一，查询串优先 —— 调试时手打查询串更直观）。
    try {
      const url = String(req?.url || '');
      const qi = url.indexOf('?');
      const q = new URLSearchParams(qi >= 0 ? url.slice(qi + 1) : '');
      const headerId = req?.headers?.['last-event-id'] ?? req?.headers?.['Last-Event-ID'];
      const raw = String(q.get('lastEventId') || q.get('last_event_id') || headerId || '').trim();
      if (raw) replay(c, raw);
    } catch (e) {
      // 补取是尽力而为：解析/回放出任何问题都不许把连接打死（宁可少补，也不许把流搞挂）
      say(`补取阶段异常（连接保持）：${e?.message ?? e}`);
    }

    // 退登：req/res 两侧都挂上。中间代理掐断时往往只有其中一侧派发 close。
    // ★ S08：引用存在客户端状态里，dropClient/close 时逐根摘掉（不许泄漏监听器）。
    try { req?.on?.('close', c.onReqClose); } catch { /* ignore */ }
    try { res?.on?.('close', c.onResClose); } catch { /* ignore */ }

    startHeartbeat();
    say('新客户端接入', { clients: clients.size });
    return true;
  }

  /**
   * 向所有活客户端广播一条事件。
   * **绝不 throw**（调用方是 HTTP 主链与 bus 订阅，炸在这里等于整条主链下线）。
   * @returns {{ok: boolean, reason?: string, sent?: number, queued?: number, dropped?: number, seq?: number, id?: string}}
   */
  function broadcast(name, data) {
    if (closed) return { ok: false, reason: 'hub-closed' };
    if (typeof name !== 'string' || !name) return { ok: false, reason: 'name-not-a-string' };
    // 帧注入闸：名字必须在白名单里
    if (!whitelist.has(name)) return { ok: false, reason: 'name-not-allowed' };

    // ★ S3：**先登记再投递** —— 即使一个客户端都没有，断线期间的事件也必须进缓冲，
    //   重连时才补得上（这正是"断 30 秒还能补齐"的关键：那 30 秒里 clients 是空的）。
    seq += 1;
    const id = `${PID}-${seq}`;
    const line = frame(name, redact(data ?? {}), id);
    const at = Date.now();
    const bytes = utf8Len(line);
    buffer.push({ seq, at, line, bytes });
    bufferBytes += bytes;
    while (buffer.length > backfillMaxEvents) { bufferBytes -= buffer[0].bytes; buffer.shift(); }
    while (buffer.length > 1 && at - buffer[0].at > backfillMaxAgeMs) { bufferBytes -= buffer[0].bytes; buffer.shift(); }
    // ★ S08 字节总预算（全局）——与条数/时长同一套"先到先淘汰"；被挤出去的进不了补取窗口，
    //   重连时 win 判定自然走 resync（绝不假装补齐）。至少留最新一条，else 分支的窗口语义会失真。
    while (buffer.length > 1 && bufferBytes > backfillMaxBytes) { bufferBytes -= buffer[0].bytes; buffer.shift(); }

    if (clients.size === 0) return { ok: true, sent: 0, queued: 0, dropped: 0, seq, id };

    // ★ S08：sent = 已交给 Node（含 write 返回 false 的那一帧）；queued = 还在中枢队列等 drain；
    //   dropped = 明确断开。三个数分开报，不做"假装都送到了"的合并。
    let sent = 0;
    let queued = 0;
    let dropped = 0;
    for (const c of [...clients.values()]) {   // 复制一份：断开/摘除要动 Map
      const r = sendTo(c, line);
      if (r === 'sent') sent += 1;
      else if (r === 'queued') queued += 1;
      else dropped += 1;
    }
    return { ok: true, sent, queued, dropped, seq, id };
  }

  /** 结束所有连接 + 清定时器 + Map 清空。**幂等**（stop() 可能被调多次）。★ S08：连带摘监听器/清队列/清慢客户端定时器。 */
  function close() {
    if (closed) return { ended: 0 };
    closed = true;
    stopHeartbeat();
    let ended = 0;
    for (const c of [...clients.values()]) {
      c.dropped = true;
      detach(c);
      c.queue.length = 0;
      c.queueBytes = 0;
      try { c.res.end(); ended += 1; } catch { /* 客户端已经没了照样要摘干净 */ }
      clients.delete(c.res);
    }
    say(`已关闭，结束 ${ended} 条连接`, { heartbeats });
    return { ended };
  }

  return {
    handle,
    broadcast,
    count: () => clients.size,
    names: () => [...whitelist],
    close,
    isClosed: () => closed,
    /** 排障读数（不含载荷内容）。★ S3 增补：pid / 当前序号 / 缓冲条数 / 窗口参数。
     *  ★ S08 增补：队列字节合计 / 等 drain 客户端数 / 三类明确断开的计数。 */
    stats: () => {
      let queueBytes = 0;
      let drainPendingClients = 0;
      for (const c of clients.values()) {
        queueBytes += c.queueBytes;
        if (c.drainPending) drainPendingClients += 1;
      }
      return {
        clients: clients.size,
        allowed: whitelist.size,
        heartbeats,
        closed,
        heartbeatArmed: !!timer,
        pid: PID,
        seq,
        buffered: buffer.length,
        bufferedBytes: bufferBytes,
        window: { maxEvents: backfillMaxEvents, maxAgeMs: backfillMaxAgeMs, maxBytes: backfillMaxBytes },
        queueBytes,
        queueLimitBytes: perClientMaxBytes,
        drainPendingClients,
        slowDrainMs: slowClientDrainMs,
        droppedClients: counters.dropped,
        overflowDrops: counters.overflows,
        slowDrainDrops: counters.slowDrops
      };
    }
  };
}
