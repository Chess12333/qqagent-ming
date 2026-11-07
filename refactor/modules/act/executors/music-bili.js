/**
 * M10 · 执行器切片 `music-bili`（音乐/B站）—— 契约见 ./index.js
 *
 * 归属工具（5 个，旧实现 `src/tools.js`）：
 *   search_music L1555–1612 · send_music L1418–1554
 *   search_bilibili L3080–3120 · list_bili_fav L3121–3178 · send_bilibili L3179–3242
 *
 * ★ 依赖口径（搬运说明书 §一.4 / §四）：本片**零 import**，能力一律走 `ctx.modules.internet`（M14）。
 *   出口不在 → 显式返回「依赖未就绪」并点名缺什么，不在 act 里重写解析或出网实现。
 * ★ 本片**自己永不发送**：卡片类工具只把整理好的内容放进 `data`（**已准备**），**不带 sent/delivered 语义**。
 *   投递由 act 统一消费这份卡片、复用 `send()` 完成（见 `act/index.js` 的 `deliverPreparedMedia()`）。
 *   协议端动作仍是旧的 `ctx.sender.sendMusic` / `sendBilibiliCard`（新树在 M3
 *   `modules/platform/sender.js:625` / `:668`，是 sender 实例方法而非模块级出口；
 *   活门面自 G16 起把它们收在 `sendSegments` 后面暴露给 M10）⇒ 本片执行器一次都不碰平台，
 *   成败**只看平台回执**（`deliveryState`）。
 * ★ 「已播放」记账（近期避重 `rememberMusicPlayed`）**只在投递被平台确认之后**写：
 *   本片只交出 `playLedger:{ songId }`，由 act 在拿到回执后记账；未确认前 `playedRecorded` 一律 false。
 * ★ 错误口径（§一.5「抛错=工具失败，不许吞错」）：依赖调用失败一律让它抛给 M10，
 *   只有「元信息预取」这类旧树本来允许降级的地方才 catch，且把原因写进 `data` 里，不静默。
 */

const ok = (data) => ({ ok: true, data });
const no = (error) => ({ ok: false, error });

/**
 * S10（2026-10-19）：取消类错误判定 —— 与 `act/index.js:1725` 同口径
 * （`AbortError` / `ABORT_ERR` / 本工具信号已中止）。
 * 本片零 import：不引 internet 的 isAbortError，按同一组标记本地判定。
 * 取消**不是**降级理由：本片各"可降级"catch 一律原样上抛，由 act 记 unknown。
 */
function isAbortLike(ctx, error) {
  return ctx?.signal?.aborted === true
    || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR';
}

/**
 * 网易云侧要的 **M14 公开出口**（`ctx.modules.internet.*`，实现在 `modules/internet/music.js`）。
 * 分三组：探测按"这次调用真的会走哪一支"给，缺谁就只点名谁 —— 不要把用不到的出口也报成缺。
 *   搜索支（旧 src/tools.js:1565-1610 内联）      ：search / 两个形状判断 / 类型词扩写
 *   发卡-挑歌支（旧 :1449-1501）                  ：再要 滤垃圾、挑歌、播过记账
 *   发卡-songId·链接支（旧 :1504-1511 / :1547）   ：补全标题歌手、播过记账
 *      ★ :1547 的"播过记账"现在由 act 在投递确认后调（P0-4）；本片仍需点名这个出口，
 *        否则 act 拿到 playLedger 却没出口可记 ⇒ 趁早报"依赖未就绪"，别留到投递之后才发现。
 */
const NETEASE_SEARCH_EXPORTS = ['searchNeteaseSong', 'isVagueMusicQuery', 'isRandomMusicQuery', 'pickGenreQueries'];
const NETEASE_PICK_EXPORTS = NETEASE_SEARCH_EXPORTS.concat(
  ['shouldDropForCasualPlay', 'pickSongFromHits', 'rememberMusicPlayed']
);
const NETEASE_CARD_EXPORTS = ['fetchNeteaseSongDetail', 'rememberMusicPlayed'];

/** 随机模式的种子池（旧 :1459-1464 与 :1573 两份，逐字照搬；send 用大池、search 用小池）。 */
const RANDOM_SEED_POOL = [
  '周杰伦 晴天', '周杰伦 稻香', 'Beyond 海阔天空', '五月天 突然好想你',
  '陈奕迅 富士山下', '林俊杰 江南', '薛之谦 演员',
  '邓紫棋 光年之外', '李荣浩 年少有为', '毛不易 消愁',
  '夜空中最亮的星', '成都 赵雷', '孙燕姿 遇见', '朴树 平凡之路'
];
const SEARCH_SEED_POOL = ['周杰伦 晴天', 'Beyond 海阔天空', '陈奕迅 富士山下', '五月天 温柔', '林俊杰 修炼爱情'];

function notReady(tool, gaps) {
  return no(`依赖未就绪：${tool} 缺出口 —— ${gaps.join('；')}。`
    + '本片不许自己重写解析或出网实现（搬运说明书 §四）；请指挥位把出口补进 ctx.modules.internet 后再接。');
}

/** 逐个核公开出口：缺谁就报谁，不含糊。 */
function missingInternet(ctx, names) {
  const it = ctx?.modules?.internet;
  if (!it) return ['ctx.modules.internet（M14 命名空间未注入）'];
  return names.filter((n) => typeof it[n] !== 'function').map((n) => `ctx.modules.internet.${n}`);
}

function biliCookie(ctx) {
  const fromCfg = typeof ctx?.cfg?.get === 'function' ? ctx.cfg.get('webSearch.bilibiliCookie', '') : '';
  return String(fromCfg ?? '').trim() || String(globalThis.process?.env?.BILIBILI_COOKIE ?? '').trim();
}

const UNSENT = '执行器只整卡、没有发送任何东西（这是"已准备"）：投递由 act 统一走受控发送出口完成，成败看 deliveryState。';

/**
 * ★ #8（2026-10-18，用户报「发 b 站会是卡片格式，换成缩略图加链接的形式」）：
 *   封面以**行内图段**（`base64://…`）交给 act 的投递链，和标题+链接一起发；不再拼
 *   QQ JSON 分享卡（群里/私聊根本点不开）。
 *   sender 侧实测：请求体 1.6MB 能过、3.17MB 被 ECONNRESET ⇒ 封面 base64 压到
 *   ≤1.25MiB 字符（≈0.9MB 原图）以内留余量；超了/取不到就**不附封面**，标题链接照发，
 *   原因写进结果（不假装图发出去了）。
 */
const COVER_BASE64_MAX_CHARS = 1.25 * 1024 * 1024;

async function searchBilibili(ctx, args) {
  const gaps = missingInternet(ctx, ['searchBilibiliVideos']);
  if (gaps.length) return notReady('search_bilibili', gaps);
  const query = String(args?.query ?? '').trim();
  if (!query) return no('query 不能为空');
  const limit = Math.max(1, Math.min(20, Number(args?.limit) || 8));
  const r = await ctx.modules.internet.searchBilibiliVideos(query, { limit, cookie: biliCookie(ctx), signal: ctx.signal ?? null });
  const videos = Array.isArray(r?.videos) ? r.videos : [];
  if (!videos.length) return ok({ query, videos: [], note: '没搜到。换个更具体的词，或让用户丢个链接。' });
  return ok({
    query,
    count: videos.length,
    videos: videos.map((v, i) => ({
      index: i + 1, bvid: v.bvid, url: v.url, title: v.title, author: v.author, play: v.play, duration: v.duration, tag: v.tag
    })),
    note: '挑一条用 send_bilibili(url=…) 发出去（它调用即发送，url 整条照抄）。搜索本身不发送。'
  });
}

async function listBiliFav(ctx, args) {
  const gaps = missingInternet(ctx, ['listBiliFavVideos', 'resolveBiliFavFolder']);
  if (gaps.length) return notReady('list_bili_fav', gaps);
  const internet = ctx.modules.internet;
  const cookie = biliCookie(ctx);
  const folderName = String(ctx?.cfg?.get?.('webSearch.biliFavFolderName', '小鲸鱼专用') ?? '小鲸鱼专用').trim() || '小鲸鱼专用';
  let mediaId = String(args?.mediaId ?? '').trim();
  let folder = folderName;
  if (!mediaId) {
    const cfgId = String(ctx?.cfg?.get?.('webSearch.biliFavMediaId', '') ?? '').trim();
    const resolved = await internet.resolveBiliFavFolder({ cookie, folderName, mediaId: cfgId, signal: ctx.signal ?? null });
    if (!resolved?.ok) return no(resolved?.error || `找不到收藏夹「${folderName}」`);
    mediaId = String(resolved.mediaId);
    folder = resolved.title || folderName;
  }
  const page = Math.max(1, Number(args?.page) || 1);
  const pageSize = Math.max(1, Math.min(20, Number(args?.limit) || 12));
  const r = await internet.listBiliFavVideos({ mediaId, cookie, page, pageSize, signal: ctx.signal ?? null });
  if (!r?.ok) return no(r?.error || '读收藏失败');
  const videos = Array.isArray(r.videos) ? r.videos : [];
  return ok({
    mediaId,
    folder,
    page: r.page ?? page,
    total: r.total ?? videos.length,
    count: videos.length,
    videos: videos.map((v, i) => ({ index: i + 1, bvid: v.bvid, url: v.url, title: v.title, author: v.author, intro: v.intro })),
    note: `仅限收藏夹「${folder}」。send_bilibili(url=…) 发出去（它调用即发送）；要先看内容用 parse_video。不要翻其它夹。`
  });
}

async function sendBilibili(ctx, args) {
  const gaps = missingInternet(ctx, ['parseBilibiliIds', 'looksLikeBilibili', 'parseBilibiliVideo']);
  if (gaps.length) return notReady('send_bilibili', gaps);
  const internet = ctx.modules.internet;
  const raw = String(args?.url ?? '').trim().replace(/^["'“”]+|["'“”。，、）)]+$/g, '');
  if (!raw) return no('需要 B 站视频链接或 BV 号');
  let url = raw;
  if (!/^https?:\/\//i.test(raw)) {
    const ids = internet.parseBilibiliIds(raw);
    if (ids?.bvid) url = `https://www.bilibili.com/video/${ids.bvid}`;
    else if (ids?.aid) url = `https://www.bilibili.com/video/av${ids.aid}`;
    else return no('需要 bilibili.com/video 链接、b23.tv 短链，或 BV/av 号');
  }
  const ids = internet.parseBilibiliIds(url);
  if (!internet.looksLikeBilibili(url) && !ids?.bvid && !ids?.aid) {
    return no('看起来不是 B 站视频地址。要分析内容用 parse_video，要发文字用 send_message（它只发文本）。');
  }
  const card = { kind: 'bilibili_card', url, title: ids?.bvid || raw, desc: '', cover: '' };
  try {
    // ★ #8：显式要封面 data URL —— 原来只有"没字幕"才下载封面，转发支永远拿不到。
    const meta = await internet.parseBilibiliVideo(url, { maxTranscriptChars: 100, cookie: biliCookie(ctx), wantCoverDataUrl: true, signal: ctx.signal ?? null });
    if (meta?.url) url = meta.url;
    card.url = url;
    card.title = meta?.title || card.title;
    card.desc = String(meta?.desc || '').slice(0, 60);
    const coverDataUrl = String(meta?.cover || '').trim();
    const b64 = /^data:[^;]+;base64,(.+)$/i.exec(coverDataUrl)?.[1] || '';
    if (b64.length && b64.length <= COVER_BASE64_MAX_CHARS) {
      card.cover = `base64://${b64}`;   // 已是可直接投递的图段 file 形态（act 侧不再转换）
      card.coverBytes = Math.floor(b64.length * 3 / 4);
    } else if (b64.length) {
      card.coverNote = `封面图太大（base64 ${Math.round(b64.length / 1024)}KB），这轮只发标题+链接`;
    } else if (String(meta?.coverUrl || '').trim()) {
      card.coverNote = '封面图没下下来，这轮只发标题+链接';
    }
  } catch (error) {
    // S10：取消不许被降级成"只发链接"（那会当作正常结果投递出去）
    if (isAbortLike(ctx, error)) throw error;
    card.metaNote = `元信息预取失败（仍可只发链接）：${String(error?.message ?? error).slice(0, 160)}`;
  }
  return ok({
    ...card,
    prepared: true,
    note: `${UNSENT} 配一句话请在同一次调用里另用 send_message 发文本；引用不能加在卡上（会被 QQ 吞）。`
      + `${card.cover ? ' 封面图会和标题+链接一起发出。' : ''}`
  });
}

/**
 * `search_music`（旧 src/tools.js:1555-1611）：只出候选、**永不发送**。
 * 三条支路照搬旧口径：「随机」→ 小种子池 + 大 offset；纯类型词 → 扩写后取前两个词合并去重按分排；
 * 其它 → 直接搜（limit+2）。
 */
async function searchMusic(ctx, args) {
  const q = String(args?.query ?? '').trim();
  if (!q) return no('query 不能为空');   // 参数检查先做（不依赖出口）
  const gaps = missingInternet(ctx, NETEASE_SEARCH_EXPORTS);
  if (gaps.length) return notReady('search_music', gaps);
  const it = ctx.modules.internet;
  const lim = Math.min(12, Math.max(3, Number(args?.limit) || 6));   // 旧 :1569
  let searchQ = q;
  let hits = [];
  let hopNote = '';
  if (it.isRandomMusicQuery(q)) {
    searchQ = SEARCH_SEED_POOL[Math.floor(Math.random() * SEARCH_SEED_POOL.length)];
    hits = await it.searchNeteaseSong(searchQ, { limit: lim + 4, offset: Math.floor(Math.random() * 30), signal: ctx.signal ?? null });
  } else if (it.isVagueMusicQuery(q)) {
    const expanded = it.pickGenreQueries(q);
    if (!expanded.length) {
      return ok({ query: q, searched: '', results: [], note: `「${q}」太笼统。可改「随机」，或给「歌名 歌手」。示例候选见 send_music 直接传类型词。` });
    }
    searchQ = expanded.join(' / ');
    const merged = [];
    for (const term of expanded.slice(0, 2)) {
      try {
        merged.push(...await it.searchNeteaseSong(term, { limit: 5, offset: Math.floor(Math.random() * 8), signal: ctx.signal ?? null }));
      } catch (error) {
        // S10：取消不是"这一跳失败"，不许继续用其余跳的结果
        if (isAbortLike(ctx, error)) throw error;
        // 旧 :1586 是 `catch { /* skip */ }` 静默跳过；新口径（§一.5 不许吞错）⇒ 照样继续，但把原因带回去
        hopNote = `${hopNote}「${term}」这一跳失败（已用其余跳的结果）：${String(error?.message ?? error).slice(0, 120)}；`;
      }
    }
    const seen = new Set();
    hits = merged.filter((h) => {
      if (seen.has(h.id)) return false;
      seen.add(h.id);
      return true;
    }).sort((a, b) => b.score - a.score).slice(0, lim + 4);
  } else {
    hits = await it.searchNeteaseSong(q, { limit: lim + 2, offset: 0, signal: ctx.signal ?? null });
  }
  if (!hits.length) return ok({ query: q, searched: searchQ, results: [], note: `网易云无结果：${q}。换更具体歌名/歌手。` });
  const results = hits.slice(0, lim).map((h, i) =>   // 旧 :1598-1600 的行形状（模型要照抄 id）
    `${i + 1}. ${h.name}${h.artist ? ' - ' + h.artist : ''}${h.album ? `（${h.album}）` : ''} · id=${h.id}`);
  return ok({
    query: q,
    searched: searchQ,
    count: results.length,
    hint: '挑一首最贴的，用 send_music(songId=其id) 发卡。也可直接 send_music(query="随机") 自动避重挑一首。',
    results,
    ...(hopNote ? { searchNote: hopNote } : {})
  });
}

/**
 * `send_music`（旧 src/tools.js:1418-1553）。两条入口：
 *   songId / musicUrl → 直接整卡（缺标题歌手时补全，旧 :1504-1511）
 *   query（歌名 / 类型词 / 随机）→ 搜 + 挑（旧 :1449-1501，逐条口径照搬）
 * ★ 本片**自己不发送**：旧 :1533-1548 的 `ctx.sender.sendMusic` / `session.sent` / 引用文字先发，
 *   全都不在 act 切片的权限里（§一.5），只把整理好的卡放进 `data`（**已准备**，不带 sent 语义）。
 *   旧副作用 `rememberMusicPlayed`（旧 :1547，纯记账、不出网、不发东西）**不在备卡时记** ——
 *   它是"已播放"语义，只能在**投递被平台确认之后**记（P0-4）⇒ 本片只交出 `playLedger:{ songId }`。
 */
async function sendMusic(ctx, args) {
  let songId = String(args?.songId ?? '').trim().replace(/^["']|["']$/g, '');
  let title = String(args?.title ?? '').trim().slice(0, 80);
  let artist = String(args?.artist ?? '').trim().slice(0, 40);
  const urlHint = String(args?.musicUrl ?? '').trim();
  let searched = '';
  // 旧 :1440-1447 的三段抠 id：链接里 id=/song/ 的数字 → 整串非数字剔除后是纯数字且含 163 → 纯数字 musicUrl
  if (!songId && urlHint) {
    const m = /(?:id=|song\/)(\d+)/i.exec(urlHint);
    if (m) songId = m[1];
    else if (/^\d+$/.test(urlHint.replace(/\D/g, '')) && urlHint.includes('163')) songId = urlHint.replace(/\D/g, '');
  }
  if (!songId && /^\d+$/.test(urlHint)) songId = urlHint;

  if (!songId) {
    const gaps = missingInternet(ctx, NETEASE_PICK_EXPORTS);
    if (gaps.length) return notReady('send_music（query 挑歌支路）', gaps);
    const it = ctx.modules.internet;
    const q = String(args?.query ?? '').trim();
    if (!q) return no('需要 query=歌名、随机、古典/摇滚等类型、网易云链接，或 songId。');   // 旧 :1451
    const randomMode = it.isRandomMusicQuery(q) || args?.random === true;
    const vagueMode = it.isVagueMusicQuery(q);
    let hits = [];
    if (randomMode) {
      // 旧 :1457-1471：最多三次换种子词，直到攒够；干净候选不足 2 条就退回整批
      let termUsed = '';
      for (let attempt = 0; attempt < 3 && !hits.length; attempt++) {
        termUsed = RANDOM_SEED_POOL[Math.floor(Math.random() * RANDOM_SEED_POOL.length)];
        const offset = Math.floor(Math.random() * 12);
        const batch = await it.searchNeteaseSong(termUsed, { limit: 14, offset, signal: ctx.signal ?? null });
        const clean = batch.filter((h) => !h.junk && !it.shouldDropForCasualPlay(h));
        hits = clean.length >= 2 ? clean : batch;
      }
      searched = termUsed;   // 旧树没回种子词；这里回"实际搜的那一条"，不编字段
    } else if (vagueMode) {
      const expanded = it.pickGenreQueries(q);
      if (!expanded.length) return no(`「${q}」太笼统。可填「随机」，或给具体歌名/歌手，或先 search_music。`);   // 旧 :1476
      const term = expanded[Math.floor(Math.random() * expanded.length)];
      searched = term;
      hits = await it.searchNeteaseSong(term, { limit: 12, offset: Math.floor(Math.random() * 6), signal: ctx.signal ?? null });
      const clean = hits.filter((h) => !h.junk && !it.shouldDropForCasualPlay(h));
      if (clean.length) hits = clean;
    } else {
      hits = await it.searchNeteaseSong(q, { limit: 10, offset: 0, signal: ctx.signal ?? null });
    }
    if (!hits.length) return no(`网易云没搜到「${searched || q}」。换更具体歌名/歌手，或给 musicUrl。`);   // 旧 :1487
    const best = it.pickSongFromHits(hits, { random: randomMode || vagueMode });
    if (!best) return no('没挑到可用歌曲，换关键词再试。');   // 旧 :1490
    // 旧 :1493-1496：具体歌名但相关度过低 ⇒ 不硬发，把候选摊回去让模型改口
    // ★ 有意与旧树不同（指挥位 2026-10-05 裁定）：旧口径在 score 缺失时是 `NaN < 1`＝**静默放过**，那是缺陷不是契约 ⇒ 这里 `?? 0` 走 fail-closed。
    if (!randomMode && !vagueMode && (best.score ?? 0) < 1 && hits.length > 1) {
      const list = hits.slice(0, 5).map((h, i) => `${i + 1}. ${h.name} - ${h.artist} (id=${h.id})`).join('\n');
      return no(`没搜准「${q}」。候选：\n${list}\n请改成「歌名 歌手」再 send_music，或用 songId 选一首。`);
    }
    songId = String(best.id);
    if (!title) title = best.name;
    if (!artist) artist = best.artist;
  } else {
    // 纯参数检查先做（不依赖任何出口）：坏 id 不该被报成「依赖未就绪」
    if (!/^\d{1,16}$/.test(songId)) return no(`歌曲 id 不合法：${songId}`);   // 旧 :1502
    const gaps = missingInternet(ctx, NETEASE_CARD_EXPORTS);
    if (gaps.length) return notReady('send_music（songId/链接支路）', gaps);
  }
  if (!/^\d{1,16}$/.test(songId)) return no(`歌曲 id 不合法：${songId}`);   // 旧 :1502（挑歌支路回来的 id 也要过这一道）

  const it = ctx.modules.internet;
  let detailNote = '';
  if (!title || !artist) {
    try {
      const detail = await it.fetchNeteaseSongDetail(songId, { signal: ctx.signal ?? null });
      if (detail) {
        if (!title) title = detail.name;
        if (!artist) artist = detail.artist;
      } else detailNote = '详情没补到（网易云没返回这首歌），发出去可能是空白卡。';
    } catch (error) {
      // S10：取消不许被降级成"空白卡照发"
      if (isAbortLike(ctx, error)) throw error;
      // 旧 :1511 静默 catch；这里同样不挡整卡，但原因写进 data
      detailNote = `标题/歌手补全失败（不挡卡片）：${String(error?.message ?? error).slice(0, 160)}`;
    }
  }
  // 近期避重记账（旧 :1547，纯记账）。★ P0-4（2026-10-08）：它是"已播放"语义 ⇒ **备卡时绝不记**，
  //   只把 songId 交给 act，由它在**平台回执确认投递之后**记（`data.playLedger`）。
  //   未确认 ⇒ `playedRecorded:false`，不静默、也不提前算"已播放"。
  const playLedger = { songId };
  // 旧 :1513-1532 会"先发一条带引用的文字再发无引用卡"；那是发送动作，本切片没权限做 ⇒ 明说被丢了
  const wantedReply = args?.replyToMessageId != null && String(args.replyToMessageId).trim() !== ''
    && String(args.replyToMessageId).trim() !== 'null';
  return ok({
    kind: 'music_card',
    platform: '163',
    songId,
    title: title || `歌曲 ${songId}`,
    artist,
    url: `https://music.163.com/#/song?id=${songId}`,
    audio: `https://music.163.com/song/media/outer/url?id=${songId}.mp3`,
    replyToMessageId: null,
    prepared: true,
    playLedger,
    playedRecorded: false,
    ...(searched ? { searched } : {}),
    ...(detailNote ? { detailNote } : {}),
    ...(wantedReply ? { replyDropped: true } : {}),
    note: `${UNSENT}${searched ? ` 搜的词：${searched}。` : ''}`
      + `${title && artist ? '' : ' 标题/歌手仍没给全，发出去会是空白卡。'}`
      + `${detailNote ? ` ${detailNote}` : ''}`
      + ' 近期避重（"已播放"）要等投递被平台确认之后才记，未确认前不算播过。'
      + `${wantedReply ? ' 你传的 replyToMessageId 被丢掉了（旧树会先单独发一条带引用的文字，本切片不许发送）。' : ''}`
      + ' 音乐卡不能带引用（会被 QQ 吞），要配一句话请在同一次调用里另用 send_message。'
  });
}

export const executors = {
  search_music: searchMusic,
  send_music: sendMusic,
  search_bilibili: searchBilibili,
  list_bili_fav: listBiliFav,
  send_bilibili: sendBilibili
};
