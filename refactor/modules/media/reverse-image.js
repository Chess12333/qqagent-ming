// 以图搜图（反查）：优先国内可达的百度识图，其次 IQDB（二次元）。
// 本地 data URL → 先试 QQ/原有 http 直链 → 否则上传 sm.ms/catbox 拿公网链。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function dataUrlToBuffer(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) throw new Error('不是 base64 data URL');
  return { mime: m[1], buf: Buffer.from(m[2], 'base64') };
}

/** 上传拿临时公网 URL。sm.ms 优先（国内相对可达），catbox 兜底。 */
async function uploadForReverse(buf, mime) {
  const ext = /png/i.test(mime) ? 'png' : /webp/i.test(mime) ? 'webp' : /gif/i.test(mime) ? 'gif' : 'jpg';
  const filename = `rev.${ext}`;

  // sm.ms
  try {
    const boundary = `----qq${Date.now().toString(36)}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="smfile"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
      buf,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    const res = await fetch('https://sm.ms/api/v2/upload', {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'user-agent': UA
      },
      body,
      signal: AbortSignal.timeout(40000)
    });
    const j = await res.json().catch(() => null);
    const link = j?.data?.url || j?.images;
    if (typeof link === 'string' && /^https?:/i.test(link)) return link;
    // sm.ms 重复图会返回 already exists
    if (j?.images && typeof j.images === 'string' && /^https?:/i.test(j.images)) return j.images;
  } catch { /* 换 catbox */ }

  // catbox
  const boundary = `----qqagent${Date.now().toString(36)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="fileToUpload"; filename="${filename}"\r\n`
    + `Content-Type: ${mime}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const res = await fetch('https://catbox.moe/user/api.php', {
    method: 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'user-agent': UA
    },
    body: Buffer.concat([head, buf, tail]),
    signal: AbortSignal.timeout(45000)
  });
  const text = (await res.text()).trim();
  if (!/^https?:\/\//i.test(text)) throw new Error(`上传失败：${text.slice(0, 80) || res.status}`);
  return text;
}

/** 百度识图（有公网 URL 时）。解析 HTML 里的相关结果标题/链接。 */
async function searchBaidu(publicUrl) {
  const u = new URL('https://graph.baidu.com/s');
  u.searchParams.set('newjson', '1');
  u.searchParams.set('fm', 'index');
  u.searchParams.set('app_id', '3001000001');
  u.searchParams.set('client_type', 'web');
  u.searchParams.set('force_pc', '1');
  u.searchParams.set('image', publicUrl);
  u.searchParams.set('op_type', '1');
  u.searchParams.set('similar', '1');
  const res = await fetch(u, {
    headers: {
      'user-agent': UA,
      referer: 'https://graph.baidu.com/',
      accept: 'text/html,application/xhtml+xml'
    },
    signal: AbortSignal.timeout(25000)
  });
  if (!res.ok) throw new Error(`百度识图 HTTP ${res.status}`);
  const html = await res.text();
  const matches = [];
  const seen = new Set();
  const push = (title, url = '') => {
    const t = String(title || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!t || t.length < 2 || seen.has(t)) return;
    // 过滤导航/无意义/失败文案
    if (/^(百度|首页|登录|设置|关于|更多|上一篇|下一篇|相关搜索|未找到|没有找到|暂无|抱歉)/i.test(t)) return;
    if (/未找到|没有相关|无结果/i.test(t)) return;
    seen.add(t);
    matches.push({ title: t.slice(0, 80), url: String(url || '').slice(0, 120), source: 'baidu' });
  };
  // 常见结构：data-title / title 属性 / 相关结果卡片
  for (const m of html.matchAll(/data-title="([^"]{4,80})"/g)) push(m[1]);
  for (const m of html.matchAll(/"title"\s*:\s*"([^"]{4,80})"/g)) push(m[1]);
  for (const m of html.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*title="([^"]{4,80})"/g)) push(m[2], m[1]);
  // generalData / similar
  const gm = html.match(/generalData[\s\S]{0,2000}?title['":\s]+['"]([^'"]{4,60})/i);
  if (gm) push(gm[1]);
  return { matches: matches.slice(0, 8), provider: 'baidu' };
}

/** IQDB（二次元向；国外源，有时连不上）。 */
async function searchIqdb(publicUrl) {
  const res = await fetch(`https://iqdb.org/?url=${encodeURIComponent(publicUrl)}`, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`IQDB HTTP ${res.status}`);
  const html = await res.text();
  const matches = [];
  const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>[\s\S]*?<strong>([^<]*)<\/strong>/gi;
  let m;
  while ((m = re.exec(html)) && matches.length < 5) {
    const title = String(m[2] || '').trim();
    if (!title || /iqdb\.org/i.test(m[1])) continue;
    matches.push({ title, url: m[1], source: 'iqdb' });
  }
  return { matches };
}

/**
 * 以图搜图入口。
 * @param {{ dataUrl?:string, url?:string }} input
 */
export async function reverseImageSearch({ dataUrl, url } = {}) {
  let publicUrl = String(url || '').trim();
  let uploaded = false;

  if (!publicUrl && dataUrl) {
    const { buf, mime } = dataUrlToBuffer(dataUrl);
    if (buf.length > 8 * 1024 * 1024) throw new Error('图片太大（>8MB）');
    publicUrl = await uploadForReverse(buf, mime);
    uploaded = true;
  }
  if (!publicUrl) throw new Error('需要 dataUrl 或 url');

  const providers = [];
  try {
    const b = await searchBaidu(publicUrl);
    providers.push({ name: 'baidu', count: b.matches.length, matches: b.matches });
  } catch (e) {
    providers.push({ name: 'baidu', error: String(e?.message ?? e), matches: [] });
  }
  try {
    const iq = await searchIqdb(publicUrl);
    providers.push({ name: 'iqdb', count: iq.matches.length, matches: iq.matches });
  } catch (e) {
    providers.push({ name: 'iqdb', error: String(e?.message ?? e), matches: [] });
  }

  const all = providers.flatMap((p) => p.matches || []);
  const seen = new Set();
  const matches = [];
  for (const m of all) {
    const k = `${m.title}|${m.url}`;
    if (seen.has(k)) continue;
    seen.add(k);
    matches.push(m);
  }

  return {
    publicUrl,
    uploaded,
    matches: matches.slice(0, 8),
    providers: providers.map((p) => ({
      name: p.name,
      count: (p.matches || []).length,
      ...(p.error ? { error: p.error } : {})
    }))
  };
}
