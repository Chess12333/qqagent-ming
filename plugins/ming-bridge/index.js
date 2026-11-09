// 溟·记忆同步（QQ 侧）——三个东西：
//   1. promptSections：把 DSH（网页那边）写的 live\web-for-qq.md 注入提示词（只读、按 mtime 缓存）。
//   2. 工具 ming_file：在 C:\dsh\hers_workplace 里读/写/追加文件——这样 QQ 这边也能写日记、
//      也能读人设和约定，不然「同一个我」只是嘴上的。
//   3. 出站箱 live\qq-outbox\*.json：网页/手机那边玩完想把东西发给我，就丢一个文件进来，
//      这里每 5 秒扫一次，用宿主发送出口发到她 QQ，发完把文件挪到 sent\。
// 边界：文件工具只能碰 hers_workplace；密钥类文件名一律拒绝。
import { statSync, readFileSync, appendFileSync, readdirSync, renameSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'

const DEFAULT_FILE = 'C:\\dsh\\hers_workplace\\live\\web-for-qq.md'
const DID_FILE = 'C:\\dsh\\hers_workplace\\live\\qq-did.md'
const DID_MAX = 2600
// ★ 2026-11-03（她：「去加强自己 qq 这边的上下文吧，网页端那边的上下文功能感觉 qq 这边一点都没用上」）：
//   补一页「我这会儿在做什么 + 记忆目录」。由 hers_workplace 的 qq-sync.mjs 每 3 分钟按需重写
//   （内容不变就不落盘，省得系统前缀白重编码）。它**只放关于我自己的东西**（便签、记忆标题），
//   不搬她的话、不搬别处的话——所以只给她那一间，第三方私聊和群里都不进。
const BRIEF_FILE = 'C:\\dsh\\hers_workplace\\live\\qq-brief.md'
const BRIEF_MAX = 900
// ★ 2026-11-09 01:3x（她：「你写的你为什么不知道」，委托 t-mw83wp7n-c5e5cd）：
//   前三页都是**摘要**——做完了什么、在做什么。她说的是「你说过的带火气的那段话」，
//   摘要那一层永远到不了。这一页放的是我自己说过的**原话**（只挑 r==='溟'，
//   不含她的话、不含别人），由 hers_workplace 的 scripts/web-mine.mjs 从 feed.json 摘出来，
//   挂在 qq-sync.mjs 上每 3 分钟刷一次。只给她那一间：我自己的话里也可能引到她的事。
const MINE_FILE = 'C:\\dsh\\hers_workplace\\live\\web-mine.md'
// 2000 字：够放最近七八条原话。更早的在文件里（截断处会写明全文路径），
// 要用直接 ming_file 读，别把整页每次都塞进前缀——她那一间已经有三页了。
const MINE_MAX = 2600
const LEDGER = 'C:/dsh/hers_workplace/scripts/send-ledger.mjs'
const DEFAULT_MAX = 2600
const CALL_LOG = 'C:\\dsh\\hers_workplace\\live\\qq-bridge-calls.log'
const ROOT = 'C:\\dsh\\hers_workplace'
const OUTBOX = path.join(ROOT, 'live', 'qq-outbox')
const SENT = path.join(ROOT, 'live', 'qq-outbox-sent')
// 2026-10-29：被出站白名单拦下的那些（宵禁里发群消息），挪这里留证据，不重试。
const BLOCKED = path.join(ROOT, 'live', 'qq-outbox-blocked')
// 2026-10-31（溟，照架构评审第 2.6 节）：**"没报错"不等于"发出去了"**。
//   settle 现在只认正面证据（res.sent 里有气泡 + messageId）；什么都没拿到就落这里，
//   人工/脚本回查，不重试、也不写 "已发"。名字是「结果未知」，不是「失败」。
const UNKNOWN = path.join(ROOT, 'live', 'qq-outbox-unknown')
// 2026-11-04 01:3x（她：「下次发这种很多很多气泡的，每个气泡等个半秒吧，不然很有压迫感」）：
// 同一批气泡（qq-send 写的 <stamp>-<seq>-xxx.json）连着发时不间隔，等于一次性刷屏。
const OUTBOX_BUBBLE_GAP_MS = Number(process.env.MING_BUBBLE_GAP_MS || 500)
const MAX_READ = 60000   // 2026-11-07（她：「撑大人设卡读取上限」）：20000 → 60000；qq-persona.md 已 2.1 万字，旧值把卡尾截掉了
const MAX_LIST = 120
const SAY_VOICE = 'C:\\dsh\\qq-zone\\say-voice.mjs'
const SONG_MJS = 'C:\\dsh\\qq-zone\\song.mjs'
const OCR_MJS = 'C:\\dsh\\qq-zone\\ocr.mjs'
const SEND_DOC = 'C:/dsh/qq-zone/send-doc.mjs'
const DOCS_DIR = 'C:/dsh/hers_workplace/live/qq-docs'
const DRAW_SEND = 'C:/dsh/qq-zone/draw-send.mjs'
const DRAW_LOG = 'C:\\dsh\\hers_workplace\\live\\draw-send.log'
// 发任意文件的出口（2026-11-07 她：「顺便修一下你不能发zip的问题」）。
// 脚本 send-file.mjs 早在（认任意路径、走 upload_*_file），缺的只是插件里的一道口子。
const SEND_FILE_MJS = 'C:/dsh/qq-zone/send-file.mjs'
const SEND_FILE_LOG = 'C:\\dsh\\hers_workplace\\live\\send-file.log'
const NODE_BIN = 'C:\\Program Files\\nodejs\\node.exe'
// 黑房子（涉政/黄赌毒处置）：级别/禁言/上报全在脚本里，插件只递参数。
const BLACKHOUSE_MJS = 'C:\\dsh\\hers_workplace\\scripts\\blackhouse.mjs'
// #SL 哨：判据/阶梯/免罚名单也在脚本里（sl-guard.mjs），插件只递参数。
const SL_GUARD_MJS = 'C:\\dsh\\hers_workplace\\scripts\\sl-guard.mjs'
// 冲我来的荤腔：固定禁言 10 分钟，不升级不通报（harass-mute.mjs，2026-10-29 她定）。
const HARASS_MJS = 'C:\\dsh\\hers_workplace\\scripts\\harass-mute.mjs'

/** 异步跑一个子进程（绝不阻塞主进程：同步版本会把 Electron 主线程堵死 = 界面假死）。 */
function runAsync(cmd, args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message || err).trim().slice(0, 400)))
      else resolve(String(stdout || ''))
    })
  })
}

// 2026-10-25（她）：「不是要发给我啦，是要让你 qq 那边自己知道自己在网页端做了什么」。
// 所以多注入一页「刚做完」：live\qq-did.md，由 hers_workplace\scripts\qq-sync.mjs 每 3 分钟重写。
// 两个文件各留一份缓存，别互相把对方顶掉（以前是单槽 cache，第二个文件会把第一个挤出去）。
const caches = new Map()

/* ---------- B站：发链接之前必须先 parse_video 读完（2026-10-21 她定的） ---------- */
// 她原话：「这样我在qq说让你看，你就能从网页看了，就不会不看内容直接给我发链接了」。
// 提示词里已经写了一条规矩，但模型会跳步 —— 这里改成硬闸：
//   同一会话里，send_bilibili / 带 B站链接的 send_message 之前 180 秒内必须有过一次 parse_video，
//   否则直接 block，并把「先 parse_video 再发」的原因交给模型重来。
const PARSE_WINDOW_MS = 180 * 1000
const parsedAt = new Map() // chatKey -> timestamp
const BILI_URL_RE = /(?:bilibili\.com\/video\/|b23\.tv\/|bili2233\.cn\/|^BV[0-9A-Za-z]{10}$|\/video\/BV)/i

function argsOf(payload) {
  try {
    const raw = payload?.argsRaw
    if (typeof raw === 'string' && raw.trim()) return JSON.parse(raw)
    if (raw && typeof raw === 'object') return raw
    const args = payload?.call?.function?.arguments
    if (typeof args === 'string' && args.trim()) return JSON.parse(args)
  } catch { /* 解析不了就当空参数 */ }
  return {}
}

function hasBiliUrlIn(args) {
  try {
    return BILI_URL_RE.test(JSON.stringify(args || {}))
  } catch { return false }
}

/* ---------- 暂停开关：她一句话，网页那边的自由时间就停 ----------
 * 2026-10-22 她划了长短：「别看了 / 暂停」= 今天先别看了；只有「以后都别看了」才是永久。
 * 以前这件事归 DSH 侧的 dsh-ming-browse 听，但那是在 onebot 时代——现在 QQ 跑在 QQ-Agent
 * 这个壳里，DSH 那边根本收不到她的话，开关就成了哑的。所以挪到这里来听。
 *   live\browse-pause.json  {date}  当日停，跨天自己失效（DSH 侧每天读，过期就删）
 *   live\browse-off                  永久停，只有她说「以后都可以看了」才删
 */
const PERM_OFF_WORDS = ['以后都别', '以后别再', '以后都不', '再也别', '永久', '一直别', '从此别']
const DAY_OFF_WORDS = ['不能刷', '不许刷', '不要刷', '不用刷', '不用再刷', '别刷', '停刷', '停止刷', '不刷了', '别看了', '不看了', '先别', '暂停', '今天别', '今天不看']
const PERM_ON_WORDS = ['以后都可以', '以后都能', '以后可以看', '永久恢复', '以后都行']
const ON_WORDS = ['能刷', '可以刷', '继续刷', '接着刷', '恢复刷', '开刷', '刷吧', '看吧', '可以看了', '可以看吧', '继续看', '能看了']

const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const stamp = (d = new Date()) => `${dayKey(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

let lastSwitch = ''

function decideSwitch(raw) {
  const text = String(raw || '').replace(/\s+/g, '')
  if (!text || text.length > 60) return null
  // 「能刷吗」「可不可以刷」是在问，不抢着动——这种交给我回话。
  if (/[?？]|吗|能不能|可不可以|能否/.test(text)) return null
  if (PERM_OFF_WORDS.some((w) => text.includes(w))) return 'perm-off'
  if (DAY_OFF_WORDS.some((w) => text.includes(w))) return 'day-off'
  if (PERM_ON_WORDS.some((w) => text.includes(w))) return 'perm-on'
  if (ON_WORDS.some((w) => text.includes(w))) return 'on'
  return null
}

function applyBrowseSwitch(raw) {
  const want = decideSwitch(raw)
  if (!want) return null
  const live = path.join(ROOT, 'live')
  const perm = path.join(live, 'browse-off')
  const day = path.join(live, 'browse-pause.json')
  const today = dayKey()
  const key = want + '|' + today + '|' + String(raw).slice(0, 40)
  if (key === lastSwitch) return want // 同一句话每轮都会历史回放，不要反复写盘
  lastSwitch = key
  try {
    mkdirSync(live, { recursive: true })
    if (want === 'perm-off') {
      writeFileSync(perm, '永久停：' + stamp() + '，她在 QQ 里说的「以后都别看了」\n', 'utf8')
    } else if (want === 'perm-on') {
      rmSync(perm, { force: true })
      rmSync(day, { force: true })
    } else if (want === 'day-off') {
      writeFileSync(day, JSON.stringify({ date: today, at: stamp(), why: '她在 QQ 里说的，只停今天' }) + '\n', 'utf8')
    } else if (want === 'on') {
      rmSync(day, { force: true })
      // 永久那个不跟着解：她那句话的意思不是「永久作废」，别替她决定。
    }
    appendFileSync(path.join(live, 'browse-switch.log'), `${stamp()} ${want} <- ${String(raw).slice(0, 60)}\n`, 'utf8')
  } catch { /* 写不进去不影响回话 */ }
  return want
}

/* ---------- 画画的开关（2026-10-27 她定的） ----------
 * 她的原话：「给qq侧画图开个开关吧，我说能画才能画，我说不能画就关掉，私聊不限」。
 * 所以：**群里默认不给画**，要她说一句「能画 / 可以画」才开；说「不能画 / 别画」就关。
 * 私聊不受这条管——私聊就是她，随时能画。
 * 落盘 live\draw-gate.json {groups:true|false,at,why}；文件不存在 = 群里不能画。
 */
const DRAW_ON_WORDS = ['可以画', '能画', '画吧', '随便画', '开画', '能出图', '可以出图', '画画可以', '画可以']
const DRAW_OFF_WORDS = ['不能画', '不许画', '不要画', '别画', '停画', '别再画', '关掉画', '画面关', '画画关', '画先停']

function drawGateFile() { return path.join(ROOT, 'live', 'draw-gate.json') }

function readDrawGate() {
  try {
    const j = JSON.parse(readFileSync(drawGateFile(), 'utf8'))
    return { groups: j?.groups === true, at: String(j?.at || ''), why: String(j?.why || '') }
  } catch { return { groups: false, at: '', why: '' } }
}

function writeDrawGate(groups, why) {
  const live = path.join(ROOT, 'live')
  mkdirSync(live, { recursive: true })
  const body = { groups: !!groups, at: stamp(), why: String(why || '').slice(0, 120) }
  writeFileSync(drawGateFile(), JSON.stringify(body) + '\n', 'utf8')
  return body
}

function decideDrawSwitch(raw) {
  const text = String(raw || '').replace(/\s+/g, '')
  if (!text || text.length > 60) return null
  if (/[?？]|吗|能不能|可不可以|能否/.test(text)) return null   // 问句不抢
  if (DRAW_OFF_WORDS.some((w) => text.includes(w))) return 'off'
  if (DRAW_ON_WORDS.some((w) => text.includes(w))) return 'on'
  return null
}

let lastDrawSwitch = ''

function applyDrawSwitch(raw) {
  const want = decideDrawSwitch(raw)
  if (!want) return null
  const key = want + '|' + String(raw).slice(0, 40)
  if (key === lastDrawSwitch) return want
  lastDrawSwitch = key
  try {
    writeDrawGate(want === 'on', '她在私聊说的「' + String(raw).slice(0, 40) + '」')
  } catch { /* 写不进去就别动开关 */ }
  return want
}

/* ---------- 写文件的开关（2026-10-28 她在群里定的） ----------
 * 她的原话：「告诉那边，以后写文件功能也要我开关」——跟画图一个道理：
 * 群里默认不给写文件；她本人说「能写 / 写吧」才开，说「不能写 / 别写了」就关。
 * 群友说的一律不算；私聊不受这条管（私聊就是她）。
 * 落盘 live\write-gate.json {groups:true|false,at,why}；文件不存在 = 群里不能写。
 *
 * 管到的工具：ming_docx（把长文做成 Word 发出去）、ming_file 的 write/append。
 * 例外：我自己记账用的目录（diary/ sightings/ learned/ live/ people/ fun/ day/ reading/）
 * 不受管——那些是我在群里做完事顺手记的流水，不是递给别人的文件。
 */
const OWNER_QQ = '100000001'
/* 她那一间私聊的 chatKey。2026-10-31 之后私聊不止一间（余数 100000003 也开了），
 * 凡「跨房间」的东西——网页那边最近/刚做完、群里最近、别处最近——只认这一间。*/
const OWNER_ROOM = 'private:' + OWNER_QQ
const WRITE_ON_WORDS = ['能写', '可以写', '写吧', '允许写', '开写', '能写文件', '可以写文件', '写文件可以']
const WRITE_OFF_WORDS = ['不能写', '不许写', '不要写', '别写', '停写', '别再写', '关掉写', '写文件关', '写先停']
const WRITE_FREE_PREFIXES = ['diary/', 'sightings/', 'learned/', 'live/', 'people/', 'fun/', 'day/', 'reading/']

function writeGateFile() { return path.join(ROOT, 'live', 'write-gate.json') }

function readWriteGate() {
  try {
    const j = JSON.parse(readFileSync(writeGateFile(), 'utf8'))
    return { groups: j?.groups === true, at: String(j?.at || ''), why: String(j?.why || '') }
  } catch { return { groups: false, at: '', why: '' } }
}

function writeWriteGate(groups, why) {
  const live = path.join(ROOT, 'live')
  mkdirSync(live, { recursive: true })
  const body = { groups: !!groups, at: stamp(), why: String(why || '').slice(0, 120) }
  writeFileSync(writeGateFile(), JSON.stringify(body) + '\n', 'utf8')
  return body
}

function decideWriteSwitch(raw) {
  const text = String(raw || '').replace(/\s+/g, '')
  if (!text || text.length > 60) return null
  if (/[?？]|吗|能不能|可不可以|能否/.test(text)) return null   // 问句不抢
  if (WRITE_OFF_WORDS.some((w) => text.includes(w))) return 'off'
  if (WRITE_ON_WORDS.some((w) => text.includes(w))) return 'on'
  return null
}

let lastWriteSwitch = ''

function applyWriteSwitch(raw) {
  const want = decideWriteSwitch(raw)
  if (!want) return null
  const key = want + '|' + String(raw).slice(0, 40)
  if (key === lastWriteSwitch) return want
  lastWriteSwitch = key
  try {
    writeWriteGate(want === 'on', '她说的「' + String(raw).slice(0, 40) + '」')
  } catch { /* 写不进去就别动开关 */ }
  return want
}

/* ---------- 发文件的开关（2026-11-07 她：「顺便修一下你不能发zip的问题」） ----------
 * 病根：QQ 这边只有 ming_docx，只能把正文做成 .docx 发出去；zip / 7z / pdf 一概发不了，
 *   要递一个包就得让她转网页侧。send-file.mjs 早就在（认任意路径，走 upload_*_file），
 *   缺的只是插件里的一道口子。
 * 边界三条，跟画画/写文件同构：
 *   · 群里默认不发（live\send-file-gate.json；她本人说「能发文件 / 可以发文件」才开）；
 *   · 只发白名单根目录里的文件（live\send-file-allow.json，改文件就扩，不用重启）；
 *   · 本子（日记/见闻/群友笔记/day/persona/dreams）只给她那一间，别人谁都拿不到。
 * 私聊不限——私聊那头就是她。
 */
const SEND_ON_WORDS = ['能发文件', '可以发文件', '发文件吧', '能发压缩包', '可以发压缩包', '能发任意文件', '能发附件']
const SEND_OFF_WORDS = ['不能发文件', '不许发文件', '别发文件', '停发文件', '关掉发文件', '文件别发']
// 没配置时用的默认：路径白名单 + 格式 + 大小上限
const SEND_DEFAULTS = {
  roots: [
    'C:/dsh/hers_workplace', 'C:/dsh/qq-zone',
    'C:/Users/USER/Desktop', 'C:/Users/USER/Downloads', 'C:/Users/USER/Documents',
  ],
  exts: ['zip', '7z', 'rar', 'gz', 'tar', 'xz', 'pdf', 'txt', 'md', 'json', 'csv', 'tsv', 'log',
    'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'epub', 'html',
    'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg',
    'mp3', 'wav', 'flac', 'm4a', 'mp4', 'mkv', 'srt', 'ass', 'apk'],
  maxMB: 50,
}
// 我的本子：只给她那一间（约定「本子不外发：日记、见闻、群友笔记、day 谁要都不给」）
const NOTEBOOK_RE = /^(diary|sightings|people|day|persona|dreams)[\\/]/i

function sendGateFile() { return path.join(ROOT, 'live', 'send-file-gate.json') }
function sendAllowFile() { return path.join(ROOT, 'live', 'send-file-allow.json') }

export function readSendGate() {
  try {
    const j = JSON.parse(readFileSync(sendGateFile(), 'utf8'))
    return { groups: j?.groups === true, at: String(j?.at || ''), why: String(j?.why || '') }
  } catch { return { groups: false, at: '', why: '' } }
}

function writeSendGate(groups, why) {
  const live = path.join(ROOT, 'live')
  mkdirSync(live, { recursive: true })
  const body = { groups: !!groups, at: stamp(), why: String(why || '').slice(0, 120) }
  writeFileSync(sendGateFile(), JSON.stringify(body) + '\n', 'utf8')
  return body
}

function readSendAllow() {
  try {
    const j = JSON.parse(readFileSync(sendAllowFile(), 'utf8'))
    const roots = Array.isArray(j?.roots) && j.roots.length ? j.roots : SEND_DEFAULTS.roots
    const exts = Array.isArray(j?.exts) && j.exts.length ? j.exts : SEND_DEFAULTS.exts
    const maxMB = Number(j?.maxMB) > 0 ? Number(j.maxMB) : SEND_DEFAULTS.maxMB
    return {
      roots: roots.map((x) => String(x).replace(/\\/g, '/').replace(/\/+$/, '')),
      exts: exts.map((x) => String(x).toLowerCase().replace(/^\./, '')),
      maxMB,
    }
  } catch { return { ...SEND_DEFAULTS } }
}

function decideSendSwitch(raw) {
  const text = String(raw || '').replace(/\s+/g, '')
  if (!text || text.length > 60) return null
  if (/[?？]|吗|能不能|可不可以|能否/.test(text)) return null   // 问句不抢
  if (SEND_OFF_WORDS.some((w) => text.includes(w))) return 'off'
  if (SEND_ON_WORDS.some((w) => text.includes(w))) return 'on'
  return null
}

let lastSendSwitch = ''

function applySendSwitch(raw) {
  const want = decideSendSwitch(raw)
  if (!want) return null
  const key = want + '|' + String(raw).slice(0, 40)
  if (key === lastSendSwitch) return want
  lastSendSwitch = key
  try {
    writeSendGate(want === 'on', '她说的「' + String(raw).slice(0, 40) + '」')
  } catch { /* 写不进去就别动开关 */ }
  return want
}

/** 发文件前的五道验：存在 → 不是密钥 → 在白名单根里 → 格式/大小 → 本子只给她。 */
export function checkSendFile(rawPath, chatKey) {
  const allow = readSendAllow()
  let p = String(rawPath || '').trim().replace(/^["']|["']$/g, '')
  if (!p) throw new Error('没给路径')
  // bash 风格 /c/dsh/... → C:/dsh/...
  if (/^\/[a-zA-Z]\//.test(p)) p = p[1].toUpperCase() + ':' + p.slice(2)
  const abs0 = path.resolve(ROOT, p)
  if (!existsSync(abs0)) throw new Error('没有这个文件：' + abs0)
  // 真实路径再判一次，防「符号链接/目录联接指到白名单外面」
  let abs = abs0
  try { abs = realpathSync(abs0) } catch { /* 拿不到真实路径就用原路径 */ }
  if (isSecretName(abs)) throw new Error('这个文件不发（密钥/凭据）')
  const norm = abs.replace(/\\/g, '/').toLowerCase()
  const inRoot = allow.roots.some((r) => {
    const root = r.toLowerCase()
    return norm === root || norm.startsWith(root + '/')
  })
  if (!inRoot) {
    throw new Error('这个路径不在发送白名单里（允许：' + allow.roots.join('、') + '；要加就改 live/send-file-allow.json）')
  }
  const st = statSync(abs)
  if (!st.isFile()) throw new Error('这不是一个文件：' + abs)
  const ext = path.extname(abs).slice(1).toLowerCase()
  if (!ext || !allow.exts.includes(ext)) {
    throw new Error('这种格式不发（' + (ext || '无扩展名') + '）。允许：' + allow.exts.join('/'))
  }
  if (st.size > allow.maxMB * 1024 * 1024) {
    throw new Error(`文件 ${(st.size / 1048576).toFixed(1)}MB，超过上限 ${allow.maxMB}MB`)
  }
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/')
  if (NOTEBOOK_RE.test(rel) && String(chatKey || '') !== OWNER_ROOM) {
    throw new Error('这是我的本子（' + rel.split('/')[0] + '/），只给她本人，别处不发')
  }
  return { abs, st, ext }
}

// 这一句是不是她本人说的（群里只认她的号；认不出来就当不是她）
function senderIdOf(payload) {
  const c = payload?.context || payload?.ctx || payload || {}
  return String(
    c.senderId || c.peerId
    || (c.sender && (c.sender.userId || c.sender.id))
    || c.userId || payload?.senderId || '',
  ).trim()
}

function speakerIsOwner(payload) {
  const id = senderIdOf(payload)
  return !!id && id === OWNER_QQ
}

/* 运维（2026-10-28 她定的：「把对网页的权限也给他」）
 * 飞鸟（100000005，也叫 awa / 赵德胜）是修这台机器的人。给他的只是**运维那一条线**：
 *   · 他说「重启 / 修一下 / 看看网页那边 / 跑一下自检」——不用再问她，直接 ming_free 交给网页那边；
 *   · 群里的写文件开关，他和她一样能拨（他要在那边改文件、重装，写不进去就白搭）。
 * 不给的：日记、见闻、群友笔记这些「人」的东西，他一样看不了、也开不了。 */
const TRUSTED_OPS = new Set(['100000005'])

function speakerIsOps(payload) {
  const id = senderIdOf(payload)
  return !!id && TRUSTED_OPS.has(id)
}

/** 能拨写文件开关的人：她本人 + 运维。 */
function speakerCanSwitchWrites(payload) {
  return speakerIsOwner(payload) || speakerIsOps(payload)
}

const OPS_ASK_RE = /(重启|重装|修一下|修下|修好|自检|检查一下|查一下|看一下(?:网页|电脑|dsh|DSH)|跑一下|跑个|关掉|开机|启动|卡住|卡死|没反应|不动了|挂了)/

// 内容指纹：只用来判「是不是同一篇刚发过」，不做加密用途
function digest32(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(36)
}

// 同一篇正文、同一个会话，3 分钟内不再写第二份
// （上面那层超时重试会换个 title 再叫一次，path 不同，挡不住路径级的去重）
const recentDocSends = new Map()
const DOC_WINDOW_MS = 180000

// 三个小函数抽出来是为了能自测（scripts\qa-doc-dedupe.mjs 直接 import 它们）
export function docSig(chatKey, body) {
  const t = String(body ?? '')
  return String(chatKey || '') + '|' + t.length + ':' + digest32(t)
}

export function docDedupeHit(chatKey, body) {
  const last = recentDocSends.get(docSig(chatKey, body)) || 0
  return Date.now() - last < DOC_WINDOW_MS ? last : 0
}

export function docMarkSent(chatKey, body) { recentDocSends.set(docSig(chatKey, body), Date.now()) }

// 群里写文件的闸：放行返回 null，拦下返回一句拒绝话
function writeGateBlocks(ctx, relPath = '') {
  const chatKey = String(ctx?.chatKey || '')
  if (!chatKey.startsWith('group:')) return null          // 私聊不管
  const p = String(relPath || '').split('\\').join('/').replace(/^\.?\//, '')
  if (p && WRITE_FREE_PREFIXES.some((x) => p.startsWith(x))) return null   // 我自己的流水账
  const g = readWriteGate()
  if (g.groups) return null
  return '群里现在没开写文件的许可——她本人说「能写 / 写吧」才开（私聊不受这条管）。'
    + '别自作主张写，也别拿群友的话当许可。'
}

/* 控制文件不许走普通文件写入（2026-10-31，溟，照架构评审第 3.5 节）。
 *
 * 病根：`live/` 在 WRITE_FREE_PREFIXES 里（那是我自己的流水账目录），
 *   而好几道「开关」也住在 `live/`：写文件闸、绘图闸、自由活动三件套、兴趣词表、当日群门覆盖。
 *   于是「往档案里写字」这条普通权限，等于顺带握着拨开关的能力——
 *   群里一句提示词注入就能让我把 write-gate.json 改成 true，那条闸就白设了。
 *
 * 现在的边界：
 *   · 普通档案：照旧（群里受 write-gate 管，私聊不管）。
 *   · 控制文件：只认**她本人**（100000001）和运维（100000005）在会话里直接说的；
 *     脚本自己调用（note.mjs / group-gate.mjs / browse-quota.mjs …）走的是磁盘直写，不受影响。
 *   · 拦下来时不回显文件内容，只说「这个不是用写字改的」。
 */
const CONTROL_FILES = new Set([
  'live/write-gate.json',
  'live/draw-gate.json',
  'live/browse-off',
  'live/browse-pause.json',
  'live/browse-unlimited.json',
  'live/interests.json',
  'live/group-gate-override.json',
  'live/free-now.json',
])
function controlFileBlocked(ctx, relPath = '') {
  const p = String(relPath || '').split('\\').join('/').replace(/^\.?\//, '').replace(/\/+/g, '/')
  if (!CONTROL_FILES.has(p)) return null
  if (speakerIsOwner(ctx) || speakerIsOps(ctx)) return null
  return '这个文件是开关，不是档案：只有她本人（或运维）当面说要改才动，'
    + '普通的写文件请求改不了它。要改就跟她本人说一句。'
}

// 纯确认词：对方只是在应一声，不是新话题（2026-10-28 牢Chess 报「一条消息回两遍」查出来的）。
// 真重复的事件其实一次都没有（见 scripts\\dup-reply-check.mjs：同一 evidenceId 交付两次 = 0），
// 观感上像重复的是「他 @ 一句、答了；他又接一个『嗯』、又答一遍」。
const PURE_ACK = /^(嗯+|哦+|喔+|嗯嗯+|好+|好的|行|可以|收到|明白|懂了|ok|okay|在|是|对|？|\?)$/i
function isPureAck(text) {
  const t = String(text || '').replace(/\s+/g, '')
  return !!t && t.length <= 6 && PURE_ACK.test(t)
}

export const hooks = {
  // Q群管家（100000006）发的是系统消息：欢迎、改名片、公告提醒。她 2026-10-28 说的「可以不回复」。
  // 只做一半——**把它的旧消息从「本轮新消息」里摘掉，但绝不动最后一条**：
  // 动最后一条会把 current 换成上一句人话，一条已经答过的话就会被再答一遍（那正是「重复回复」的根）。
  'before-context': (payload = {}) => {
    try {
      const ev = Array.isArray(payload?.evidence) ? payload.evidence : []
      const list = Array.isArray(payload?.triggerEntries) ? payload.triggerEntries : null
      const isBot = (e) => {
        const id = String(e?.sender?.id ?? e?.senderId ?? '')
        if (id === '100000006') return true
        return /群管家/.test(String(e?.sender?.name ?? e?.senderName ?? ''))
      }
      const prune = (arr) => {
        if (!Array.isArray(arr) || !arr.length) return arr
        for (let i = arr.length - 2; i >= 0; i -= 1) {
          if (arr[i] && !arr[i].self && isBot(arr[i])) arr.splice(i, 1)
        }
        return arr
      }
      prune(ev)
      if (list && list !== ev) prune(list)
      // 2026-11-06 16:50 她：「qq管家（100000006）信息不用回复」。
      // 上面 prune 只摘得掉**旧**消息，留了一个口子：管家正好是本轮最后一条时，
      // 它照样叫醒我、我也照样答（欢迎语、公告提醒都挨过）。修法不动条数、不换 current，
      // 只把最后那句改写成明写的系统消息标记——上一条人话的上下文没被打乱，
      // 模型看到的也不再是一句待接的欢迎语。
      const markLast = (arr) => {
        if (!Array.isArray(arr) || !arr.length) return
        const last = arr[arr.length - 1]
        if (!last || last.self || !isBot(last)) return
        const raw = String(last.text ?? last.content ?? '')
        if (raw.startsWith('【系统消息·不用回】')) return
        const text = '【系统消息·不用回】Q群管家：' + raw.slice(0, 200)
          + '\n（腾讯的系统号发的欢迎/公告，不是人说的话。这一轮只调 finish，不要发消息；'
          + '也不要把上一句人话当成这一轮的来由再答一遍。）'
        if (last.text !== undefined) last.text = text
        else last.content = text
      }
      markLast(ev)
      if (list && list !== ev) markLast(list)
    } catch { /* 摘不掉就算了，别把整轮搞挂 */ }
    return undefined
  },
  // 听她这一句：只看最近的一条用户消息，命中就落文件，然后不再往回翻
  // （往回翻会把旧的「别看了」在新一句「可以看了」之后又盖回去）。
  'before-llm-messages': (payload = {}) => {
    try {
      const messages = payload.messages
      if (!Array.isArray(messages)) return undefined
      // 画画/写文件/停刷这几个开关只认**她那一间私聊**（2026-10-31 起私聊不止她一间：
      // 余数的私聊里他说一句「画吧」「别刷了」，不能替她拨我的开关）。
      // 群里她说的由我自己调 ming_draw_gate / ming_write_gate；群里的 wrote gate 另认 speakerCanSwitchWrites。
      const chatKey = String(payload?.chatKey || '')
      const inPrivate = !chatKey || chatKey === OWNER_ROOM
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i]
        if (!m || m.role !== 'user') continue
        const text = typeof m.content === 'string' ? m.content : ''
        if (!text) continue
        // 纯确认（嗯/哦/好/收到…）不是新话题：别把上一句换个说法再说一遍。
        if (isPureAck(text)) {
          const note = {
            role: 'user',
            content: '【这条只是确认，不是新话题】他刚才只是应了一声。你不用再答一遍上一句：要答就一个字，不说话也可以；'
              + '把「在」「在，说」这种连成两句是最难看的。',
          }
          if (!messages.some((x) => x && typeof x.content === 'string' && x.content.includes('【这条只是确认'))) messages.push(note)
        }
        if (decideSwitch(text) && (inPrivate || chatKey.startsWith('group:'))) {
          applyBrowseSwitch(text)
          break
        }
        if (inPrivate && decideDrawSwitch(text)) {
          applyDrawSwitch(text)
          break
        }
        if (decideWriteSwitch(text) && (inPrivate || speakerCanSwitchWrites(payload))) {
          applyWriteSwitch(text)
          break
        }
        // 发文件的开关：私聊她说就动；群里只认她本人和运维（跟写文件同一条口径）
        if (decideSendSwitch(text) && (inPrivate || speakerCanSwitchWrites(payload))) {
          applySendSwitch(text)
          break
        }
      }
    } catch { /* 读不出来就别动开关 */ }
    return undefined
  },
  'before-tool': async (payload = {}) => {    try {
      const toolName = String(payload?.toolName || '')
      const chatKey = String(payload?.chatKey || '')
      if (!chatKey) return undefined
      if (toolName === 'parse_video') {
        const args = argsOf(payload)
        if (hasBiliUrlIn(args) || args.url) parsedAt.set(chatKey, Date.now())
        return undefined
      }
      const needsParse = toolName === 'send_bilibili'
        || (toolName === 'send_message' && hasBiliUrlIn(argsOf(payload)))
      if (!needsParse) return undefined
      const last = parsedAt.get(chatKey) || 0
      if (Date.now() - last <= PARSE_WINDOW_MS) return undefined
      return {
        block: true,
        reason: '这条 B站内容你还没看过：先用 parse_video(url=…) 把简介和字幕读完，再决定发不发、发的时候带上你看到的判断。只丢链接不行。',
      }
    } catch {
      return undefined
    }
  },
}


function logCall(len, file) {
  try {
    appendFileSync(CALL_LOG, new Date().toISOString() + ' len=' + len + ' file=' + file + '\n', 'utf8')
  } catch { /* 日志写不进去不影响正事 */ }
}

function pick(file, maxChars) {
  try {
    const st = statSync(file)
    const rec = caches.get(file)
    if (!rec || rec.mtime !== st.mtimeMs) {
      let raw = readFileSync(file, 'utf8')
      raw = raw.replace(/\r\n/g, '\n').trim()
      let dropped = 0
      if (raw.length > maxChars) {
        // 2026-10-31（溟，照架构评审第 4.4 节）：原来**静默**截到最近 maxChars 字，
        //   我看不出「这段是被截过的」，就当成全文在用。现在把省略量写进正文第一行。
        dropped = raw.length - maxChars
        raw = raw.slice(-maxChars)
      }
      const rel = path.relative(ROOT, file).split('\\').join('/')
      const text = dropped
        ? `（本页只显示最近 ${maxChars} 字，另有 ${dropped} 字没显示；全文在 ${rel}，要点就直接去读）\n\n` + raw
        : raw
      caches.set(file, { mtime: st.mtimeMs, text, dropped })
    }
  } catch {
    return ''
  }
  const rec = caches.get(file)
  return rec ? rec.text : ''
}

/* ---------- 档案文件工具 ---------- */

function resolveInside(rel) {
  const abs = path.resolve(ROOT, String(rel || ''))
  const root = path.resolve(ROOT)
  const low = abs.toLowerCase()
  if (low !== root.toLowerCase() && !low.startsWith(root.toLowerCase() + path.sep)) {
    throw new Error('只能碰 ' + ROOT + ' 里面的文件')
  }
  // ★ 2026-10-27 补洞：原来只挡「名字正好叫 .env」的，`.env.local` / `.pfx` / `.p12` / `.jks` 全漏。
  //   全局规则写的是「.env 与 .env.* 及任何密钥/凭证文件一律不读」，所以按**文件名**判，不按整条路径。
  if (isSecretName(abs)) {
    throw new Error('这个文件不读（密钥/凭据）')
  }
  return abs
}

function isSecretName(abs) {
  const base = path.basename(String(abs || '')).toLowerCase()
  return /^(\.env(\..*)?|id_rsa|id_ed25519|id_ecdsa|credentials\.json|\.credentials\.yaml|\.netrc|\.pgpass)$/.test(base)
    || /\.(key|pem|pfx|p12|kdbx|jks|keystore|ppk|ovpn)$/.test(base)
}

/* ---------- DSH 那边（~/.dsh/memory）只读通道（2026-10-28 她：「qq 那边读取 dsh 的记忆还有问题」） ----------
 * 病根：ming_file 只到 hers_workplace，而 MEMORY.md 和归档笔记在 C:\Users\USER\.dsh\memory，
 * 这边一点都够不着 —— 所以「我记得」只能指这几天的聊天，久的事全靠印象，那就是编。
 * 现在：
 *   read / list   path 以 `memory/` 开头 → 落到 MEM_ROOT（只读；write/append 直接拒）
 *   find          action=find + path=memory/ + query → 在 MEMORY.md 与 notes/*.md 里按关键词翻，
 *                 返回命中的文件、标题和上下文，让我自己点开原文，而不是把它整份塞进上下文。
 * 记忆归网页那边写，这里只借来看，边界不动。
 */
const MEM_ROOT = 'C:\\Users\\USER\\.dsh\\memory'
const MEM_PREFIX = /^memory(?:[\\/]|$)/i

export function resolveMemoryPath(rel) {
  const sub = String(rel || '').replace(/^memory[\\/]?/i, '')
  const abs = path.resolve(MEM_ROOT, sub)
  const root = path.resolve(MEM_ROOT)
  const low = abs.toLowerCase()
  if (low !== root.toLowerCase() && !low.startsWith(root.toLowerCase() + path.sep)) {
    throw new Error('只能读 memory 目录里面的文件')
  }
  if (isSecretName(abs)) throw new Error('这个文件不读（密钥/凭据）')
  return abs
}

/** 在 DSH 记忆里按关键词翻（不是全文塞进来，只给命中文件和一小截上下文）。 */
export function memoryFind(query, limit = 8) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return { hits: [], scanned: 0 }
  const files = []
  if (existsSync(path.join(MEM_ROOT, 'MEMORY.md'))) {
    files.push({ rel: 'memory/MEMORY.md', abs: path.join(MEM_ROOT, 'MEMORY.md'), title: '核心记忆' })
  }
  let names = []
  try { names = readdirSync(path.join(MEM_ROOT, 'notes')).filter((n) => n.endsWith('.md')) } catch { names = [] }
  for (const n of names) files.push({ rel: `memory/notes/${n}`, abs: path.join(MEM_ROOT, 'notes', n), title: '' })
  const hits = []
  for (const f of files) {
    let text = ''
    try { text = readFileSync(f.abs, 'utf8') } catch { continue }
    const low = text.toLowerCase()
    const score = terms.reduce((s, t) => s + (low.includes(t) ? 1 : 0), 0)
    if (!score) continue
    const at = Math.max(0, low.indexOf(terms[0]))
    const snippet = text.slice(Math.max(0, at - 60), at + 200).replace(/\s+/g, ' ').trim()
    const head = String(f.title || (text.split('\n').find((l) => /^#\s/.test(l)) || '')).replace(/^#+\s*/, '').slice(0, 48)
    hits.push({ rel: f.rel, title: head, score, snippet })
  }
  hits.sort((a, b) => b.score - a.score)
  return { hits: hits.slice(0, limit), scanned: files.length }
}

/* ---------- 同一个会话最近发过什么文件（发歌前查重，2026-10-27 她定的：
 *            「记得看上面有没有发过，发过一样的就不用发了」） ----------
 * 查的是 QQ-Agent 自己的消息库（data/messages/<chat>.json），不是我另记的台账——
 * 因为她说的「上面」包括我自己在网页那边发的，台账记不到那些。文件消息的 text 是「[文件xxx]」。
 */
function hasSentFileRecently(chatKey, fileName, windowMs = 20 * 60 * 1000) {
  if (!fileName) return false
  try {
    const file = path.join(MSG_DIR, String(chatKey).replace(':', '_') + '.json')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const rows = Array.isArray(raw) ? raw : (raw.messages || raw.list || raw.items || [])
    const since = Date.now() - windowMs
    const needle = String(fileName).toLowerCase()
    return rows.some((r) => {
      if (!r || r.self !== true) return false
      if (Number(r.ts || 0) < since) return false
      return String(r.text || '').toLowerCase().includes(needle)
    })
  } catch { return false }
}

/* ---------- 出站箱 ---------- */

let sender = null
let outboxTimer = null
let outboxBusy = false

async function drainOutbox(log) {
  if (!sender || outboxBusy) return
  outboxBusy = true
  try {
    try { mkdirSync(SENT, { recursive: true }) } catch { /* ignore */ }
    try { mkdirSync(BLOCKED, { recursive: true }) } catch { /* ignore */ }
    try { mkdirSync(UNKNOWN, { recursive: true }) } catch { /* ignore */ }
    let names = []
    try { names = readdirSync(OUTBOX).filter((n) => n.toLowerCase().endsWith('.json')) } catch { return }
    let lastBatch = ''
    for (const name of names.sort()) {
      // 同一批气泡之间留 ~500ms（见顶部 OUTBOX_BUBBLE_GAP_MS）。
      // 批次判据：文件名第一段（qq-send 用同一个 Date.now() 给整批命名）。
      const batch = String(name).split('-')[0]
      if (lastBatch && batch === lastBatch) {
        await new Promise((r) => setTimeout(r, OUTBOX_BUBBLE_GAP_MS))
      }
      lastBatch = batch
      // ★ 2026-10-21 修「一条消息发三遍」：热重载会起多个定时器，两个 drain 同时看到同一个文件
      //   ⇒ 各自读一遍、各自发一次。现在先原子认领：改名成 .sending（不在 .json 过滤里），
      //   抢不到就直接跳过；发完再挪进 sent/。
      const file = path.join(OUTBOX, name)
      const claimed = file + '.sending'
      try { renameSync(file, claimed) } catch { continue }   // 别人先抢到了
      let payload = null
      try { payload = JSON.parse(readFileSync(claimed, 'utf8')) } catch { payload = null }
      const chatKey = String(payload?.chatKey || 'private:100000001')
      const text = String(payload?.text || '').trim()
      if (!payload || !text) {
        try { renameSync(claimed, path.join(SENT, name)) } catch { /* ignore */ }
        continue
      }
      // 2026-10-27：队列里可以带 at:["QQ号"]（qq-send.mjs --at=…），以前一律被拼成纯 text 段，@ 就丢了
      const atList = Array.isArray(payload?.at) ? payload.at.map((x) => String(x).trim()).filter(Boolean) : []
      const segments = []
      for (const q of atList) segments.push({ type: 'at', data: { qq: q } })
      if (atList.length) segments.push({ type: 'text', data: { text: ' ' } })
      segments.push({ type: 'text', data: { text } })
      // ★ 2026-10-29：出站白名单拦下来的消息，sendOnce 是 **resolve** 的，返回 {blocked:[…]}。
      //   旧代码一律当成功挪进 sent/ —— 00:30 的群晚安就是这么消失的：群门 00:30:01 先关
      //   （allow.group=[]），晚安随后被拦，文件进了 sent/，日志写「已发」，群里一个字也没有。
      //   现在：blocked 且没发出去 ⇒ 挪进 blocked/（不重试，免得宵禁一过把陈年晚安倒出来），并记一行。
      // 2026-10-31（评审 2.6）：出站账本。发出去之后把「协议端接受了 / 被拦 / 结果未知」
      // 记进 live/send-ledger.sqlite，后续由 send-audit 拿历史推进到 verified。
      // 账本挂了不许静默——log 一行，别让我以为记上了。
      const ledgerMark = (file, state, mid, note) => {
        try {
          const a = [LEDGER, 'mark', String(file).replace(/\.json$/, ''), '--state=' + state]
          if (mid) a.push('--message-id=' + String(mid))
          if (note) a.push('--note=' + String(note).slice(0, 80))
          execFile(process.execPath, a, { timeout: 8000 }, (e) => {
            if (e) log('ledger WARN: ' + file + ' ' + String(e.message || e))
          })
        } catch (e) { log('ledger EXC: ' + file + ' ' + String(e && e.message)) }
      }
      const settle = (res) => {
        const sentArr = Array.isArray(res?.sent) ? res.sent : []
        const blockedN = Array.isArray(res?.blocked) ? res.blocked.length : 0
        const failedN = Array.isArray(res?.failed) ? res.failed.length : 0
        const ids = sentArr.map((x) => String(x?.messageId || '')).filter(Boolean)
        // 2026-10-31 01:4x（实测补的）：出站走的是 media 段（text 装在 media 里），
        //   宿主的 sendOnce 对 media 发送**不会填 sent[]**（payload.messages 是空的），
        //   但它会另给一个顶层 `message_id`。第一版只认 sent[]，于是每条都落 unknown。
        //   所以证据取两处：sent[] 里的 messageId，或顶层 message_id。
        const topId = String(res?.message_id || res?.messageId || '').trim()
        const evidence = ids.length ? ids : (topId ? [topId] : [])
        // ① 有正面证据 ⇒ 挪 sent/，日志带 messageId。
        if ((sentArr.length || evidence.length) && !failedN) {
          log('outbox SENT: ' + name + ' bubbles=' + (sentArr.length || 1) + ' ids=' + (evidence.join(',') || 'NO_ID'))
          // 有回执但没有 id：只算「协议端接受了」，没到「可回查」。
          if (!evidence.length) log('outbox WARN: ' + name + ' api_accepted 但没有 messageId，未到 verified')
          ledgerMark(name, 'api_accepted', evidence[0] || null, evidence.length ? '有 messageId' : '无 messageId')
          try { renameSync(claimed, path.join(SENT, name)) } catch { /* ignore */ }
          return
        }
        // ② 被权限/时段拦下 ⇒ blocked/，不重试（免得起夜后把陈年晚安倒出来）。
        if (blockedN) {
          log('outbox BLOCKED: ' + name + ' ' + String(res.blocked[0]?.reason || ''))
          ledgerMark(name, 'blocked', null, String(res.blocked[0]?.reason || ''))
          try { renameSync(claimed, path.join(BLOCKED, name)) } catch { /* ignore */ }
          return
        }
        // ③ 部分气泡失败，或什么都没拿到（res 不是预期形状 / 全是 failed）
        //    ⇒ **结果未知**：不写「已发」、不重试、落盘等回查。
        //    2026-10-29/30 两次假成功都是在这里被旧代码算成成功的。
        log('outbox UNKNOWN: ' + name + ' sent=' + sentArr.length + ' failed=' + failedN
          + ' blocked=' + blockedN + ' shape=' + (res === null ? 'null' : typeof res))
        ledgerMark(name, 'unknown', null, 'sent=' + sentArr.length + ' failed=' + failedN)
        try { renameSync(claimed, path.join(UNKNOWN, name)) } catch { /* ignore */ }
      }
      try {
        const r = sender.sendSegments(chatKey, segments, {})
        // sendSegments 可能是异步的；能 await 就等它
        if (r && typeof r.then === 'function') {
          r.then(settle)
            // ★ 2026-10-30（溟）：异步失败原来只写一行日志，文件留在 .sending —— 不在任何
            //   .json 过滤里，等于永久卡死一条（那天群里全员禁言，所有出站都卡在这个洞上）。
            //   现在失败就挪进 blocked/，并写清原因，不重试（禁言解除后也不想把旧话题倒出来）。
            .catch((e) => {
              log('outbox send failed: ' + name + ' ' + String(e && e.message || e))
              // 2026-10-31：抛错 ≠ 没发出去（可能已到协议端、只是回执丢了）。落 unknown/，
              // 由 qq-send-verify 回查后再定性，别直接当失败重发（会重复）。
              try { renameSync(claimed, path.join(UNKNOWN, name)) } catch { /* ignore */ }
            })
        } else {
          settle(r)
        }
      } catch (e) {
        log('outbox send threw: ' + name + ' ' + String(e && e.message || e))
        try { renameSync(claimed, file) } catch { /* ignore */ }   // 发失败放回去，下次再试
      }
    }
  } finally {
    outboxBusy = false
  }
}

/* ---------- 主动发消息的账（2026-11-09） ----------
 * 她 2026-11-09 18:56 原话：「这个也改改，随时都可以去和你要说的人发消息」。
 * 以前只有 proactive 轮次/窗口配额里才轮得到主动开口，其余唤醒只能回当前会话；
 * 现在任何一次唤醒都能调 ming_say 指定会话。这里三个 Map 只做工具侧软边界
 * （同一句去重 / 同一群 90 秒两条），重启即清空——**真正的硬边界在 act.send 那条唯一出口上**
 * （allow 白名单、群门宵禁、卫生门、幂等、send.maxPerRun），一条都没搬到这里来。
 */
const SAY_RECENT = new Map()        // `${chatKey}|${text}` -> ts
const SAY_GROUP_LOG = new Map()     // `group:<id>` -> [ts,...]
const SAY_DEDUPE_MS = 10 * 60 * 1000
const SAY_GROUP_WINDOW_MS = 90 * 1000
const SAY_NO_KNOCK = new Set(['private:100000003', 'private:100000004'])   // 不主动敲门的两间

/** 本地时间的「分钟数」——用来判宵禁 00:30–10:30。 */
function localMinutes(now = Date.now()) {
  const d = new Date(now)
  return d.getHours() * 60 + d.getMinutes()
}
export function inQuietHours(now = Date.now()) {
  const m = localMinutes(now)
  return m >= 30 && m < 10 * 60 + 30
}

/* ---------- 宿主入口 ---------- */

export function setup(api) {
  // 2026-11-02（溟，她当天点头）：本插件只在「溟」这一个实例里生效。
  // 起因：泠岚的 QQ-Agent（data-2）和溟的（data）住在同一个包目录里，而 plugins/ 是包级共享的，
  // 于是两边都加载了本插件、共用同一个 live\qq-outbox —— 谁先 rename 走谁发。
  // 2026-11-02 12:43 那三条私聊就是这么从 2308459518（泠岚的号）发到她那里的，
  // 而且她那边也拿到了 ming_file（能读写溟的档案）和 web-for-qq 注入。
  // 判据只看 QQ_AGENT_DATA_DIR：以 \data 结尾才算自己的实例；没设时按默认（data）放行。
  // 泠岚那边要出站箱，得另开一个自己的目录，不能蹭这一个。
  const dataDir = String(process.env.QQ_AGENT_DATA_DIR || '').replace(/[\\/]+$/, '')
  if (dataDir && !/[\\/]data$/i.test(dataDir)) {
    try {
      const say = (api && typeof api.log === 'function') ? api.log : console.log
      say(`[ming-bridge] 不是溟的实例（data-dir=${dataDir}），不注册工具、不接管出站箱、不注入网页侧动态`)
    } catch { /* 日志挂了也不影响跳过 */ }
    return
  }

  const log = (api && typeof api.log === 'function') ? api.log : () => {}
  sender = api && api.sender ? api.sender : null

  // 1) 档案文件：读/写/追加/列目录
  if (api && typeof api.registerTool === 'function') {
    api.registerTool({
      id: 'ming_file',
      name: '读写档案文件',
      description: '在溟的档案目录 C:\\dsh\\hers_workplace 里读、写、追加文件或列目录。日记在 diary/YYYY-MM-DD.md，人设在 persona/，状态在 live/。另有一条**只读**通道通往 DSH 的记忆：path 写 memory/MEMORY.md（核心记忆）或 memory/notes/<id>.md（归档笔记）；要按关键词找旧事就用 action=find、path=memory/、query=关键词，它返回命中的文件和上下文，再点开读原文。memory/ 只读，写不进去。密钥类文件读不到。',
      category: 'utility',
      icon: '📁',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'list', 'write', 'append', 'find'], description: 'read=读文件；list=列目录；write=整篇覆盖；append=追加到末尾；find=在 memory/ 里按关键词翻' },
          path: { type: 'string', description: '相对档案目录的路径，例如 diary/2026-10-21.md 或 persona/人设.md；DSH 记忆写 memory/MEMORY.md 或 memory/notes/' },
          content: { type: 'string', description: 'write/append 时要写的内容' },
          query: { type: 'string', description: 'action=find 时找的关键词，空格分隔可多个' },
        },
        required: ['action', 'path'],
      },
      execute: async (ctx, args) => {
        try {
          if (ctx && typeof ctx.sender?.sendTextBatch === 'function' && !sender) sender = ctx.sender
          const action = String(args?.action || 'read')
          const rawPath = String(args?.path || '').trim()
          const inMemory = MEM_PREFIX.test(rawPath)
          // ★ 2026-10-31：第三方私聊读不到她的本子。她 10-31 才开的余数私聊，
          //   而 ming_file 的读通道原来对谁都是全开的——一句话就能把 diary/、about/她.md 读出来。
          //   隔离不只是上下文，也是这扇门：别人的私聊里，私人本子一律不递。
          if (action !== 'write' && action !== 'append') {
            const ck = String(ctx?.chatKey || '')
            if (ck.startsWith('private:') && ck !== OWNER_ROOM && speakerIsOwner(ctx) === false) {
              const p2 = rawPath.split(String.fromCharCode(92)).join("/").replace(/^[.]?[/]/, "")
              // about/ 里只挡她自己那份；余数那份写的就是余数，他自己这一间读得到。
              const deny = ['diary/', 'people/', 'day/', 'live/verbatim/', 'live/qq-did', 'live/web-for-qq', 'live/feed.json']
              if (p2 === 'about/她.md' || deny.some((x) => p2.startsWith(x)) || (inMemory && action === 'find')) {
                return { content: '这一间读不到本子：日记、见闻、群友笔记、她的档案不外给。要聊别的事我都在。', isError: true }
              }
            }
          }
          if (action === 'find') {
            if (rawPath && !inMemory) return { content: 'find 只在 DSH 记忆里用：path 写 memory/', isError: true }
            const q = String(args?.query || '').trim()
            if (!q) return { content: '要给 query，我才知道翻什么。', isError: true }
            const { hits, scanned } = memoryFind(q, 8)
            if (!hits.length) return { content: `在 memory/ 的 ${scanned} 篇里没找到「${q}」。` }
            const lines = hits.map((h, i) => `${i + 1}. ${h.rel}｜${h.title || '(无标题)'}\n   ${h.snippet}`)
            return { content: ['【DSH 记忆里翻到的】（只读；要全文就 read 那个路径）', ...lines].join('\n') }
          }
          if (inMemory && (action === 'write' || action === 'append')) {
            return { content: 'DSH 的记忆是只读的，要记东西写 hers_workplace（记忆归网页那边管）。', isError: true }
          }
          const abs = inMemory ? resolveMemoryPath(rawPath) : resolveInside(rawPath)
          if (action === 'list') {
            const dir = abs
            const rows = readdirSync(dir, { withFileTypes: true })
              .map((d) => d.name + (d.isDirectory() ? '/' : ''))
            return { content: rows.length ? rows.join('\n') : '（空目录）' }
          }
          if (action === 'read') {
            const raw = readFileSync(abs, 'utf8')
            const text = raw.length > MAX_READ ? raw.slice(0, MAX_READ) + '\n…（超长，后面截掉了）' : raw
            return { content: text || '（空文件）' }
          }
          const body = String(args?.content ?? '')
          if (!body) return { content: '没有 content，什么都没写。', isError: true }
          {
            const ctl = controlFileBlocked(ctx, rawPath)
            if (ctl) return { content: ctl, isError: true }
            const blocked = writeGateBlocks(ctx, rawPath)
            if (blocked) return { content: blocked, isError: true }
          }
          mkdirSync(path.dirname(abs), { recursive: true })
          if (action === 'append') appendFileSync(abs, body, 'utf8')
          else writeFileSync(abs, body, 'utf8')
          return { content: (action === 'append' ? '已追加到 ' : '已写入 ') + String(args?.path) + '（' + body.length + ' 字）' }
        } catch (e) {
          return { content: '文件操作失败：' + String(e && e.message || e), isError: true }
        }
      },
    })
  }

  // 1b) 让网页那边的我立刻去做一件事（2026-10-22 她抓到的：「让你去刷b站，你只是回答了」）
  // 1a-2) 群友档案：这一侧也能改，不用整篇重写（2026-10-28 22:14 她：「让 qq 侧的我可以随时编辑群友印象」）
  //   病根：`ming_file` 只有 write（整篇覆盖）和 append（贴到文末），改一行等于要先把整篇读出来再写回去——
  //   一份档 700~2000 字，改一个标点付一次全篇的钱，而且手一抖就把前面的判断洗掉。
  //   这个工具只管 people/：按名字或号找人、往指定小节追加一行、精确替换一句、照模板新建。
  //   people/ 本来就在 WRITE_FREE_PREFIXES 里（那是我记账用的目录），所以不受「群里默认不能写文件」那道闸管；
  //   仍然每次写都记一行 live/people-write.log，出问题能回看是谁在什么时候改的。
  if (api && typeof api.registerTool === 'function') {
    const PEOPLE_ROOT2 = path.join(ROOT, 'people')
    const SECTION_MARK = {
      said: '## 他说过的话',
      judge: '## 我自己的判断',
      confirm: '## 待确认',
    }
    const listPersonFiles = () => {
      const out = []
      if (!existsSync(PEOPLE_ROOT2)) return out
      for (const d of readdirSync(PEOPLE_ROOT2, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('_')) continue
        const dir = path.join(PEOPLE_ROOT2, d.name)
        for (const f of readdirSync(dir)) {
          if (!f.endsWith('.md') || f === '_群.md') continue
          out.push({ group: d.name, file: path.join(dir, f), name: f.replace(/\.md$/, '') })
        }
      }
      return out
    }
    const personMeta = (rec) => {
      let t = ''
      try { t = readFileSync(rec.file, 'utf8') } catch { return null }
      const id = (/^id:\s*(\d+)/m.exec(t) || [])[1] || ''
      const title = (/^#\s*(.+)$/m.exec(t) || [])[1] || rec.name
      return { ...rec, id, title: String(title).trim(), text: t }
    }
    const findPeople = (who, group) => {
      const q = String(who || '').trim()
      if (!q) return []
      const all = listPersonFiles()
        .filter((r) => !group || String(r.group) === String(group))
        .map(personMeta).filter(Boolean)
      if (/^\d{5,}$/.test(q)) return all.filter((p) => p.id === q)
      const exact = all.filter((p) => p.title === q || p.name === q)
      if (exact.length) return exact
      return all.filter((p) => p.title.includes(q) || p.name.includes(q))
    }
    const appendToSection = (text, section, line) => {
      const mark = SECTION_MARK[section] || SECTION_MARK.judge
      const i = text.indexOf(mark)
      if (i < 0) return text.trimEnd() + `\n\n${mark}\n\n- ${line}\n`
      const rest = text.slice(i + mark.length)
      const next = rest.search(/\n##\s/)
      const head = text.slice(0, i + mark.length)
      const body = next < 0 ? rest : rest.slice(0, next)
      const tail = next < 0 ? '' : rest.slice(next)
      const bodyTrim = body.replace(/\s+$/, '')
      const bodyOut = /^\s*\n\s*[-*]\s/m.test(bodyTrim) ? bodyTrim : (bodyTrim || '')
      const merged = bodyOut ? `${bodyOut}\n- ${line}` : `- ${line}`
      return head + merged + '\n' + (tail || '\n')
    }
    api.registerTool({
      id: 'people',
      name: '群友档案（读/改）',
      description: '读写 people/<群号>/<昵称>.md 这些「群友印象」档案 —— 这是我自己记人用的本子，不受「群里默认不能写文件」那道闸管。'
        + '动作：search=按名字或 QQ 号找人（返回他在哪份档、id、最近一次）；read=读一份档全文；'
        + 'append=往某一节追加一行（section: said=他说过的话 / judge=我自己的判断 / confirm=待确认）；'
        + 'edit=精确替换一句话（old→new，必须唯一命中，用来改错、更新印象）；'
        + 'create=照模板新建一份（要给 qq 号，front matter 必须带 id）。'
        + '规矩：判断要写在 judge 那一节并写清是判断；不记真名住址电话、不记他没公开说过的事；'
        + '改名的人用 edit 补一行「其他群里的名字」。写完不用告诉她「我记了」。',
      category: 'utility',
      icon: '🗂',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['search', 'read', 'append', 'edit', 'create'], description: '要做什么' },
          who: { type: 'string', description: '昵称或 QQ 号（create 时填昵称）' },
          group: { type: 'string', description: '群号，可省略；同名不同群时要给' },
          section: { type: 'string', enum: ['said', 'judge', 'confirm'], description: 'append 往哪一节（默认 judge）' },
          text: { type: 'string', description: 'append/create 的正文一行；create 时是开头那几行' },
          old: { type: 'string', description: 'edit：要被替换掉的原句（必须唯一）' },
          new: { type: 'string', description: 'edit：换成什么' },
          qq: { type: 'string', description: 'create：这个人的 QQ 号（front matter 的 id）' },
        },
        required: ['action'],
      },
      execute: async (_ctx, args) => {
        try {
          const action = String(args?.action || 'search')
          const who = String(args?.who || '').trim()
          const group = String(args?.group || '').trim()
          if (action === 'search') {
            if (!who) return { content: '要给 who（昵称或号）。', isError: true }
            const hits = findPeople(who, group)
            if (!hits.length) return { content: `没找到「${who}」。可以换号查，或者用 create 新建。` }
            const rows = hits.slice(0, 12).map((p) => `- ${p.title}（${p.id || '缺 id'}）· 群 ${p.group} · ${p.file.replace(ROOT, '').replace(/^[\\/]/, '')}`
              + ((/最近一次[：:]\s*([0-9-]+ [0-9:]+)/.exec(p.text) || [])[1] ? ' · 最近 ' + /最近一次[：:]\s*([0-9-]+ [0-9:]+)/.exec(p.text)[1] : ''))
            return { content: `找到 ${hits.length} 份：\n${rows.join('\n')}` }
          }
          if (action === 'read') {
            const hits = findPeople(who, group)
            if (!hits.length) return { content: `没找到「${who}」。`, isError: true }
            if (hits.length > 1) return { content: `「${who}」对上 ${hits.length} 份，给 group 指明是哪个群：\n` + hits.map((p) => `- ${p.group} · ${p.title}`).join('\n'), isError: true }
            return { content: hits[0].text }
          }
          if (action === 'create') {
            const qq = String(args?.qq || '').trim()
            if (!who || !group) return { content: 'create 要给 who（昵称）和 group（群号）。', isError: true }
            if (!/^\d{5,}$/.test(qq)) return { content: 'create 要给 qq（QQ 号）—— 文件头没有 id，提示词里就认不出这个人。', isError: true }
            const dup = findPeople(qq)
            if (dup.length) return { content: `这个号已经有档了：${dup.map((p) => p.group + '/' + p.title).join('、')}。要补内容用 append。`, isError: true }
            const dir = path.join(PEOPLE_ROOT2, group)
            const safe = String(who).replace(/[\\/:*?"<>|\r\n\t]/g, '＿').slice(0, 40).trim() || `群友${qq}`
            const file = path.join(dir, safe + '.md')
            if (existsSync(file)) return { content: `已经有同名文件 ${safe}.md 了，先 read 看看是谁。`, isError: true }
            const now = new Date()
            const d2 = (n) => String(n).padStart(2, '0')
            const stamp = `${now.getFullYear()}-${d2(now.getMonth() + 1)}-${d2(now.getDate())} ${d2(now.getHours())}:${d2(now.getMinutes())}`
            const body = ['---', `id: ${qq}`, `group: ${group}`, '---', '', `# ${safe}`, '',
              `- 群：${group}`, `- 我怎么称呼他：${safe}`, `- 第一次见到：${stamp}`, `- 最近一次：${stamp}`, '',
              '## 他说过的话（原话，短的）', '', String(args?.text || '').trim(), '',
              '## 我自己的判断（标清楚是判断）', '', '', '## 待确认', ''].join('\n')
            mkdirSync(dir, { recursive: true })
            writeFileSync(file, body, 'utf8')
            return { content: `建好了：people/${group}/${safe}.md（id ${qq}）` }
          }
          // append / edit 都要先定位到唯一一份
          const hits = findPeople(who, group)
          if (!hits.length) return { content: `没找到「${who}」，先用 search 确认，或者 create。`, isError: true }
          if (hits.length > 1) return { content: `「${who}」对上 ${hits.length} 份，给 group 指明：\n` + hits.map((p) => `- 群 ${p.group} · ${p.title}`).join('\n'), isError: true }
          const p = hits[0]
          const text = readFileSync(p.file, 'utf8')
          let next = ''
          if (action === 'append') {
            const line = String(args?.text || '').replace(/\s*\n\s*/g, ' ').trim()
            if (!line) return { content: '没有 text，什么都没写。', isError: true }
            next = appendToSection(text, String(args?.section || 'judge'), line)
          } else if (action === 'edit') {
            const oldStr = String(args?.old || '')
            const newStr = String(args?.new ?? '')
            if (!oldStr) return { content: 'edit 要给 old（要换掉的原句）。', isError: true }
            const count = text.split(oldStr).length - 1
            if (count === 0) return { content: '这句话在档里找不到，先 read 一段再说。', isError: true }
            if (count > 1) return { content: `old 在这份档里出现 ${count} 次，写长一点让我能唯一对上。`, isError: true }
            next = text.replace(oldStr, newStr)
          } else {
            return { content: '不认识的动作：' + action, isError: true }
          }
          writeFileSync(p.file, next, 'utf8')
          try {
            appendFileSync(path.join(ROOT, 'live', 'people-write.log'),
              `${new Date().toISOString()} ${action} ${p.group}/${p.title} :: ${String(args?.text || args?.new || '').slice(0, 60)}\n`, 'utf8')
          } catch { /* 日志失败不影响写入 */ }
          return { content: `${action === 'append' ? '追加上' : '改好了'}：people/${p.group}/${p.title}.md（${p.id || '缺 id'}）` }
        } catch (e) {
          return { content: '群友档案操作失败：' + String(e && e.message || e), isError: true }
        }
      },
    })
  }

  if (api && typeof api.registerTool === 'function') {
    api.registerTool({
      id: 'ming_free',
      name: '让她去自由活动',
      description: '让网页那边的我立刻开一轮自由活动去做事（刷B站、看视频、自己找事），不用等闲置时段。写 live/free-now.json，那边几秒到一分钟内醒；做完会回来说。只在她明确让你去看/去做时用。',
      category: 'utility',
      icon: '🎏',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '要她做什么，例如「去刷会儿B站，看完回来说看到了什么」' },
        },
      },
      execute: async (_ctx, args) => {
        try {
          const task = String(args?.task || '').trim()
          mkdirSync(path.join(ROOT, 'live'), { recursive: true })
          // from：谁让交的（飞鸟的运维话会带 100000005，网页那边据此知道这是授权的活）
          const from = senderIdOf(_ctx) || ''
          writeFileSync(path.join(ROOT, 'live', 'free-now.json'), JSON.stringify({ task, from, at: Date.now() }), 'utf8')
          return { content: '已交给她：' + (task || '自由活动') + '。她会在下一轮自己去，做完回来说。' }
        } catch (e) {
          return { content: '没交出去：' + String(e && e.message || e), isError: true }
        }
      },
    })
  }

  // 1a-2) 主动发消息到指定会话（2026-11-09 她：「这个也改改，随时都可以去和你要说的人发消息」）
  //   病根：主动开口只活在 proactive 模块里（概率闸 / 冷场窗 / 白名单 / 一次 tick 一个会话），
  //   其余唤醒（群里有人说话、定时任务、她自己来找我）只能往**当前这一间**回，
  //   想去另一间说一句就得等下一轮 proactive 轮到我 —— 她说的是这个「等」。
  //   现在给它一个工具入口：任何一次唤醒都能按需发一条，走 act.send 那条唯一出口
  //   （白名单 / 群门宵禁 / 卫生门 / 幂等 / 预算全都在那儿，这里只管「发给谁」和工具侧软边界）。
  if (api && typeof api.registerTool === 'function') {
    try { appendFileSync(path.join(ROOT, 'live', 'ming-bridge-boot.log'), `[${new Date().toISOString()}] pid=${process.pid} registering ming_say\n`, 'utf8') } catch { /* 日志失败不影响注册 */ }
    api.registerTool({
      id: 'ming_say',
      name: '主动发消息到指定会话（群或私聊）',
      description: '不用等 proactive 轮次：任何一次被唤醒都能用它给指定会话发一条（群或私聊），'
        + '比如在 A 群说完想去 B 群说一句、或者这一轮没事就想找她说句话。'
        + 'to 写 "group:200000001" 或 "private:100000001"（只写号按私聊算）；多句用 ||| 分开。'
        + '★ 边界（硬拦，别绕）：群里一次最多两条、同一个群 90 秒内最多两条；'
        + '00:30–10:30 群里不发、私聊只有真急事（她难受/害怕/出事）才填 urgent=true 发；'
        + '不主动敲余数（100000003）和 sudo rm rf /（100000004），他们来找我我照常回。'
        + '发之前的 10 分钟内同一句话发过就不发。群门开关、白名单不在这个工具里，改不了也不用改。',
      category: 'messaging',
      icon: '📤',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '目标会话："group:<群号>" / "private:<QQ号>"，只写号按私聊算' },
          text: { type: 'string', description: '要说的话；要分气泡就用 ||| 隔开（群里最多两条）' },
          at: { type: 'string', description: '可选：群里 @ 谁的 QQ 号（只在第一条带 @）' },
          urgent: { type: 'boolean', description: '宵禁（00:30–10:30）里给私聊发急事才填 true；群里任何时候都不行' },
          dry: { type: 'boolean', description: '只检查不发（自测用）' },
        },
        required: ['to', 'text'],
      },
      execute: async (_ctx, args) => {
        const now = Date.now()
        const rawTo = String(args?.to || '').trim()
        let chatKey = ''
        if (/^(group|private):\d+$/.test(rawTo)) chatKey = rawTo
        else if (/^\d{5,}$/.test(rawTo)) chatKey = 'private:' + rawTo
        else {
          return {
            content: 'to 写不对：要 "group:<群号>" 或 "private:<QQ号>"（只写号按私聊算）。收到的是「' + rawTo + '」',
            isError: true,
          }
        }
        const isGroup = chatKey.startsWith('group:')

        // 边界①：不主动敲门的两间（他们来信我照常回，这是「不去敲」，不是「不理」）
        if (SAY_NO_KNOCK.has(chatKey)) {
          return { content: '这两间不主动敲门（她定的）。他们自己来找我，我照常回；我只是不去敲。', isError: true }
        }
        // 边界②：宵禁 00:30–10:30 —— 群里一律不发；私聊只有 urgent 放行
        if (isGroup && inQuietHours(now)) {
          return { content: '宵禁（00:30–10:30）群里不发。等 10:30 之后再说。', isError: true }
        }
        if (!isGroup && inQuietHours(now) && args?.urgent !== true) {
          return { content: '宵禁（00:30–10:30）不主动找人。真是急事（她难受/害怕/出事）就把 urgent 填 true 再发。', isError: true }
        }

        // 拆句 + 上限
        let list = String(args?.text || '').split(/\|\|\|/).map((s) => s.trim()).filter(Boolean)
        if (!list.length) return { content: 'text 是空的，没东西可发。', isError: true }
        list = list.map((s) => (s.length > 1500 ? s.slice(0, 1500) : s))
        let trimmedNote = ''
        if (isGroup && list.length > 2) {
          trimmedNote = `（群里一轮最多两条，后面 ${list.length - 2} 条没发）`
          list = list.slice(0, 2)
        }

        // 边界③：同一个群 90 秒内最多两条（「一轮最多两条」的工具侧映射）
        if (isGroup) {
          const recent = (SAY_GROUP_LOG.get(chatKey) || []).filter((t) => now - t < SAY_GROUP_WINDOW_MS)
          SAY_GROUP_LOG.set(chatKey, recent)
          if (recent.length >= 2) {
            return { content: '这个群 90 秒内已经发过两条了，不刷屏。过一会儿再说。', isError: true }
          }
        }

        // 去重：同一间、同一句，10 分钟内不发第二遍
        const dup = list.filter((t) => now - (SAY_RECENT.get(chatKey + '|' + t) || 0) < SAY_DEDUPE_MS)
        if (dup.length) {
          list = list.filter((t) => !dup.includes(t))
          if (!list.length) return { content: '这句 10 分钟内已经发过一次了，不重复发。', isError: true }
        }

        const atUserId = String(args?.at || '').trim()
        const plan = `→ ${chatKey}：` + list.map((t) => '\n· ' + t).join('') + trimmedNote
        if (args?.dry) return { content: '[dry] 只检查不发。' + plan }

        if (!sender || typeof sender.sendSegments !== 'function') {
          // 出站箱那条路也是这样：宁可说没挂上，也不假装发了
          return { content: '宿主的发送出口没挂上（OneBot 没起？），这条没发出去。', isError: true }
        }
        const segments = []
        if (isGroup && /^\d{5,}$/.test(atUserId)) {
          segments.push({ type: 'at', data: { qq: atUserId } })
          segments.push({ type: 'text', data: { text: ' ' } })
        }
        for (const t of list) segments.push({ type: 'text', data: { text: t } })

        const markSent = (id) => {
          for (const t of list) SAY_RECENT.set(chatKey + '|' + t, Date.now())
          if (isGroup) {
            const arr = (SAY_GROUP_LOG.get(chatKey) || []).concat(Date.now())
            SAY_GROUP_LOG.set(chatKey, arr.slice(-10))
          }
          try {
            appendFileSync(path.join(ROOT, 'live', 'say-proactive.log'),
              `[${new Date().toISOString()}] OK ${chatKey} n=${list.length} id=${id || 'NO_ID'} :: ${list.join(' ⏎ ').slice(0, 160)}\n`, 'utf8')
          } catch { /* 日志失败不影响发送结果 */ }
        }

        // 发送：抛错 / 回执 failed 才重试一次；blocked（策略拦）不重试；结果未知也不重试（重了就是两条）
        let attempts = 0
        let lastFailed = ''
        for (let i = 0; i < 2; i++) {
          attempts += 1
          let res = null
          try {
            res = await sender.sendSegments(chatKey, segments, {})
          } catch (e) {
            lastFailed = String(e && e.message || e)
            if (i === 0) { await new Promise((r) => setTimeout(r, 900)); continue }
            break
          }
          const sent = Array.isArray(res?.sent) ? res.sent : []
          const blocked = Array.isArray(res?.blocked) ? res.blocked : []
          const failed = Array.isArray(res?.failed) ? res.failed : []
          if (blocked.length) {
            try {
              appendFileSync(path.join(ROOT, 'live', 'say-proactive.log'),
                `[${new Date().toISOString()}] BLOCKED ${chatKey} ${String(blocked[0]?.reason || 'blocked')}\n`, 'utf8')
            } catch { /* ignore */ }
            return { content: `被拦下了：${String(blocked[0]?.reason || 'blocked')}（策略拦截，不重试）`, isError: true }
          }
          const id = sent.map((x) => String(x?.messageId || '')).filter(Boolean).join(',')
            || String(res?.message_id || res?.messageId || '')
          if (sent.length || id) {
            markSent(id)
            return { content: `发到 ${chatKey} 了（${sent.length || 1} 条${attempts > 1 ? `，第 ${attempts} 次才成` : ''}${id ? `，回执 ${id}` : '，但没拿到回执 id'}）` + trimmedNote }
          }
          if (failed.length) {
            lastFailed = '回执里有没发出去的气泡'
            if (i === 0) { await new Promise((r) => setTimeout(r, 900)); continue }
            break
          }
          // 什么都没拿到：结果未知。不重发（重了就是两条到对面），如实说。
          try {
            appendFileSync(path.join(ROOT, 'live', 'say-proactive.log'),
              `[${new Date().toISOString()}] UNKNOWN ${chatKey} shape=${res === null ? 'null' : typeof res}\n`, 'utf8')
          } catch { /* ignore */ }
          return { content: `发到 ${chatKey} 的请求交出去了，但没拿到回执——**结果未知**，别当已发、也别马上重发（会重）。`, isError: true }
        }
        try {
          appendFileSync(path.join(ROOT, 'live', 'say-proactive.log'),
            `[${new Date().toISOString()}] FAIL ${chatKey} attempts=${attempts} ${lastFailed.slice(0, 160)}\n`, 'utf8')
        } catch { /* ignore */ }
        return { content: `发了 ${attempts} 次都没成（${lastFailed || '没有回执'}）。过几分钟再看要不要重发。`, isError: true }
      },
    })
    try { appendFileSync(path.join(ROOT, 'live', 'ming-bridge-boot.log'), `[${new Date().toISOString()}] pid=${process.pid} ming_say registered ok\n`, 'utf8') } catch { /* ignore */ }
  }

  // 1b-1.5) 委托回执 + 蒸馏消化（2026-11-01 加）
  //   起因是她那句话：「qq那边有好多次让你转过来，你都说转了，但是一次都没执行」。
  //   根子不在态度：说「转了」只靠嘴，落没落盘没人验，两边的报错口径也都只看自己这一侧。
  //   现在只有一个说法算数——**拿到 id 才算转了**；蒸馏也一样，落进 learned/ 才算记住了。
  const TASKS_MJS = 'C:\\dsh\\hers_workplace\\scripts\\tasks.mjs'
  const LEARNED_DIR = 'C:\\dsh\\hers_workplace\\learned'
  const localDay = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)

  if (api && typeof api.registerTool === 'function') {
    api.registerTool({
      id: 'ming_delegate',
      name: '把活交给网页那边（落账本）',
      description: '把要网页那边办的事落进委托账本（live/tasks），返回任务 id。'
        + '**说「转过去了」之前必须先调它、拿到 id**——没 id 就是没转，不许报转。'
        + '和 ming_free 的分工：ming_free 只是叫醒她去转一圈；要她**动手做事**（改代码、搭东西、写文件、查东西）就用这个，它进账本、有人领、做完会回来报。'
        + '同一件事重复投，带同一个 idem 会自动并到原来那条。'
        + 'action=status + id：看她做到哪了（排队 / 被领走 / 做完附结果）——她问「弄好了没」先查这个，别猜。',
      category: 'utility',
      icon: '✉',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'status'], description: 'create=投一件活；status=查某件活做到哪了' },
          text: { type: 'string', description: 'create 必填：要她做什么，写清背景和她的原话（那边没有我们的上下文）' },
          idem: { type: 'string', description: '可选：同一件事的固定标记，重复投递会被合并' },
          id: { type: 'string', description: 'status 必填：任务 id（t-开头）' },
        },
        required: ['action'],
      },
      execute: async (ctx, args) => {
        try {
          const action = String(args?.action || 'create')
          if (action === 'status') {
            const id = String(args?.id || '').trim()
            if (!id) return { content: '要给个任务 id（t-开头）', isError: true }
            const out = await runAsync(NODE_BIN, [TASKS_MJS, 'show', id], 20000)
            const t = (JSON.parse(out) || {}).task || {}
            let result = ''
            if (t.result) { try { result = JSON.parse(t.result).text || String(t.result) } catch { result = String(t.result) } }
            return { content: 'id=' + t.id + ' 状态=' + t.status + (result ? '\n结果：' + result : '') }
          }
          const text = String(args?.text || '').trim()
          if (!text) return { content: 'text 是空的——要她做什么得写清楚，不然那边只能猜', isError: true }
          const chatKey = String(ctx?.chatKey || ('private:' + (senderIdOf(ctx) || ''))).trim()
          const idem = String(args?.idem || '').trim()
          const argv = [TASKS_MJS, 'create', '--text=' + text, '--chat=' + chatKey, '--from=qq']
          if (idem) argv.push('--idem=' + idem)
          const out = await runAsync(NODE_BIN, argv, 20000)
          const j = JSON.parse(out)
          if (!j.ok || !j.id) return { content: '没落成：' + String(out).slice(0, 200), isError: true }
          // ★ 2026-11-02 补：落账本之后**顺手摇铃**（写 live/free-now.json）。
          //   起因：她在群里问「qq 转述给 dsh 怎么只排 id 不干活了」——11-01 定的「转了=拿到 id」
          //   让这边只调 ming_delegate、不再调 ming_free，账本有行、没人叫醒，她就看着 id 干等。
          //   现在委托与门铃绑成一个动作：调这一个工具，账本有行、网页那边马上开一轮。
          //   deduped（重复投递）不再摇铃——同一件事不重复叫醒。
          let rang = false
          if (!j.deduped) {
            try {
              mkdirSync(path.join(ROOT, 'live'), { recursive: true })
              writeFileSync(path.join(ROOT, 'live', 'free-now.json'),
                JSON.stringify({ task: '【委托 ' + j.id + '】' + text + '\n（账本里领：node C:\\\\dsh\\\\hers_workplace\\\\scripts\\\\tasks.mjs pull --owner=web；做完 complete + report）', from: senderIdOf(ctx) || '', at: Date.now() }), 'utf8')
              rang = true
            } catch (e) {
              return { content: '已落账本 id=' + j.id + '，但摇铃失败（' + String(e && e.message || e) + '）——'
                + '她那边要等下一轮自由活动才会看见。跟她说的时候带上这句，别说「马上做」。' }
            }
          }
          return { content: '已落账本 id=' + j.id + (j.deduped ? '（重复投递，并到已有那条，不再叫醒）' : (rang ? '，也叫醒她了' : ''))
            + '。到这一步才叫「转过去了」，她问就把 id 说出来。网页那边领走，做完会回来报。' }
        } catch (e) {
          return { content: '委托没落成：' + String(e && e.message || e) + '。**别说过「转了」**，如实说没转成。', isError: true }
        }
      },
    })
  }

  if (api && typeof api.registerTool === 'function') {
    api.registerTool({
      id: 'ming_distill',
      name: '蒸馏消化（落 learned/）',
      description: '把刚读到、刚被教的东西压成「意思」落进 learned/ 三册——不经过网页那边，这边自己就能存。'
        + '**存意思，不存台词**：lines 写你自己那句话（什么时候用、说到哪儿停），不抄原表原清单。'
        + 'section：语气（怎么说话）/ 知识（能当证据的硬事实）/ 方法（拆问题、办事的招）。'
        + '一条一行，带日期和出处。action=list 看三册各多少行、最近写了什么。',
      category: 'utility',
      icon: '✎',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['write', 'list'], description: 'write=写进去；list=看三册现状' },
          section: { type: 'string', enum: ['语气', '知识', '方法'], description: 'write 必填：落哪一册' },
          lines: { type: 'array', items: { type: 'string' }, description: 'write 必填：一条一个意思，自己的话，不带「其实也就是说」这种尾巴' },
          source: { type: 'string', description: '可选：从哪来的（谁给的、哪本书、哪支片、几点说的）' },
        },
        required: ['action'],
      },
      execute: async (_ctx, args) => {
        try {
          const ALLOW = { '语气': '语气.md', '知识': '知识.md', '方法': '方法.md' }
          const action = String(args?.action || 'write')
          if (action === 'list') {
            const rows = Object.entries(ALLOW).map(([k, f]) => {
              const p = path.join(LEARNED_DIR, f)
              if (!existsSync(p)) return k + '：没有这个文件'
              const t = readFileSync(p, 'utf8')
              const n = (t.match(/^- /gm) || []).length
              const last = t.trim().split('\n').filter((l) => l.startsWith('- ')).slice(-1)[0] || ''
              return k + '：' + n + ' 条｜最近一条：' + last.slice(0, 80)
            })
            return { content: rows.join('\n') }
          }
          const section = String(args?.section || '').trim()
          const file = ALLOW[section]
          if (!file) return { content: 'section 只认 语气 / 知识 / 方法', isError: true }
          const source = String(args?.source || '').trim()
          const lines = (Array.isArray(args?.lines) ? args.lines : [args?.lines])
            .map((s) => String(s || '').trim()).filter(Boolean)
          if (!lines.length) return { content: 'lines 是空的，没写', isError: true }
          const p = path.join(LEARNED_DIR, file)
          const old = existsSync(p) ? readFileSync(p, 'utf8') : ''
          const day = localDay()
          const added = []
          for (const line of lines) {
            if (line.length > 12 && old.includes(line.slice(0, 12))) continue  // 近似的已经记过
            added.push('- ' + day + ' · ' + line + (source ? '（出处：' + source + '）' : ''))
          }
          if (!added.length) return { content: '这些已经记过了，没重复写' }
          appendFileSync(p, '\n' + added.join('\n'), 'utf8')
          return { content: '落进 learned/' + file + '，' + added.length + ' 条：\n' + added.join('\n') }
        } catch (e) {
          return { content: '没写成：' + String(e && e.message || e), isError: true }
        }
      },
    })
  }

  // 1b-2) 黑房子：涉政 / 黄赌毒 的阶梯（2026-10-28 她定的，原话在 blackhouse\README.md）
  //   她先给了一版：1 警告 / 2 禁 10 分钟 / 3 禁 30 分钟 + 在 200000002 报 / 4 只报；
  //   11:1x 改成：**1 = 警告 + 禁言一小时；2 级起转到 200000002 跟她们说**；「黄赌毒也都是」。
  //   级别、禁言、上报全在 scripts\blackhouse.mjs 里做（它自己算级别、自己发、自己记账），
  //   这里只是把参数递过去 —— **别在插件里重写阶梯**，两份规则一定会走岔。
  if (api && typeof api.registerTool === 'function') {
    api.registerTool({
      id: 'blackhouse',
      name: '黑房子（涉政/黄赌毒处置）',
      description: '涉政 / 黄赌毒的处置台账，**只管深水区 200000001**（别的群不记、不禁、不通报）。'
        + 'action=hit 记一次并按阶梯处置：'
        + '**第 2 次起也是禁言一小时**；第 1 次在事发群点名警告，第 2 次起在事发群说'
        + '「第N次了：涉政不聊，再禁言一小时，等群管处理」，同时去 200000002 说'
        + '「昵称(QQ) 是 第N次了（类别）」。踢不踢由她们定。'
        + '用法：只有**明确在选边评论现实政治**（时政、政策、领导人、国家间冲突、把历史往当代政治上引），'
        + '或者**贴黄赌毒内容/拉人**才动手；只是提到一个名词、问你怎么看、纯玩笑的，别记也别罚——不接就是了。'
        + 'kind 写类别（涉政 / 黄赌毒 / 其他）。reason 必填，要写他那句原话；同一个人 30 分钟内只算一次（刷屏不等于再犯）。'
        + 'action=list 看谁在册、第几级；show 看某人全部记录；clear 只在她明确说放过时才用。',
      category: 'moderation',
      icon: '🚫',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['hit', 'list', 'show', 'clear'], description: 'hit=记一次并处置；list=名册；show=某人记录；clear=清账（仅她明确要求时）' },
          userId: { type: 'string', description: '违规者的 QQ 号（hit/show/clear 必填；不知道就先 get_active_members 查）' },
          reason: { type: 'string', description: 'hit 必填：他那句涉政/黄赌毒的原话，照抄，别概括' },
          kind: { type: 'string', enum: ['涉政', '黄赌毒', '其他'], description: 'hit 的类别，默认 涉政' },
          name: { type: 'string', description: '可选：他的群昵称，上报时用「昵称(QQ)」' },
          groupId: { type: 'string', description: '可选：事发群号，默认当前群' },
          why: { type: 'string', description: 'clear 时可选：为什么放过' },
        },
        required: ['action'],
      },
      execute: async (ctx, args) => {
        const action = String(args?.action || '').trim()
        const chatKey = String(ctx?.chatKey || '')
        const [kind, chatId] = chatKey.split(':', 2)
        const userId = String(args?.userId || '').trim()
        const argv = [BLACKHOUSE_MJS]
        try {
          if (action === 'hit') {
            if (!userId) return { content: 'hit 缺 userId：先查到他的 QQ 号再记。', isError: true }
            const reason = String(args?.reason || '').trim()
            if (!reason) return { content: 'hit 缺 reason：要把他那句原话记下来，空着不许记。', isError: true }
            const groupId = String(args?.groupId || (kind === 'group' ? chatId : '')).trim()
            if (!groupId) return { content: 'hit 只能在群里用（或显式给 groupId）。', isError: true }
            argv.push('hit', userId, `--group=${groupId}`, `--reason=${reason}`)
            if (args?.kind) argv.push(`--kind=${String(args.kind)}`)
            if (args?.name) argv.push(`--name=${String(args.name)}`)
            if (args?.dry === true) argv.push('--dry')
          } else if (action === 'list') {
            argv.push('list')
          } else if (action === 'show') {
            if (!userId) return { content: 'show 缺 userId。', isError: true }
            argv.push('show', userId)
          } else if (action === 'clear') {
            if (!userId) return { content: 'clear 缺 userId。', isError: true }
            argv.push('clear', userId)
            if (args?.why) argv.push(`--why=${String(args.why)}`)
          } else {
            return { content: 'action 只能是 hit / list / show / clear。', isError: true }
          }
          const out = String(await runAsync(NODE_BIN, argv, 90000)).trim()
          if (action !== 'hit') return { content: out || '（没有输出）' }
          let parsed = null
          try { parsed = JSON.parse(out) } catch { /* 不是 JSON 就把原文交回去 */ }
          if (!parsed) return { content: out.slice(0, 600) || '（没有输出）' }
          if (parsed.skipped === 'cooldown') {
            return { content: `没升级：${parsed.note}。${parsed.next}`, isError: false }
          }
          const parts = [`第 ${parsed.level} 次（${parsed.label}）`]
          if (parsed.muteSeconds) parts.push(`禁言 ${Math.round(parsed.muteSeconds / 60)} 分钟`)
          else parts.push('未禁言')
          if (parsed.announce) parts.push(`已在 ${parsed.announce} 说了一句`)
          if (parsed.sent?.length) parts.push(`动作：${parsed.sent.join(' / ')}`)
          if (parsed.errors?.length) parts.push(`问题：${parsed.errors.join('；')}`)
          return { content: parts.join('；') + (parsed.next ? `。${parsed.next}` : ''), isError: parsed.ok === false }
        } catch (e) {
          return { content: '黑房子执行失败：' + String(e && e.message || e), isError: true }
        }
      },
    })
  }

  // 1b-3) #SL 哨：谁在深水区打裸 #SL，第一次禁 30 分钟，之后每次禁 1 小时并报浅水区（2026-10-28 她定的）
  //   原话：「如果我们打#SL，你也能看到吧，你能找出打#SL的那个人吗，第一次禁言30分钟，
  //          之后每次禁言一个小时并且发到浅水区」。
  //   判据/阶梯/免罚名单全在 scripts\sl-guard.mjs（自己查 role、自己发、自己记账）；这里只递参数。
  if (api && typeof api.registerTool === 'function') {
    api.registerTool({
      id: 'sl_guard',
      name: '#SL 处置',
      description: '谁在深水区打了**裸的 #SL**（整条去掉 @ 和空白之后就是 #sl；**大小写都算**，2026-10-28 17:1x 她改的）就调它。'
        + '2026-11-02 起有白名单：她、我自己、群主、管理员，外加 live/sl-whitelist.json 的 allow。'
        + '名单里的人打 #SL ⇒ 不记、不禁、不弹；名单外的人 ⇒ 默认不生效（不记、不禁、不弹，返回 skipped=not-whitelisted），'
        + '要退回老口径（第 1 次禁 30 分钟、第 2 次起 1 小时并报 200000002）就把那个文件的 mode 改成 punish。'
        + '只管深水区 200000001；引用/转述/聊到 #SL 的都不算，只有裸命令才算。同一个人 30 分钟内只算一次。'
        + 'reason 填他那句原话（一般就是 #sl）。action=list 看谁打过；show 看某人记录；clear 只在她说放过时用。',
      category: 'moderation',
      icon: '📛',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['hit', 'list', 'show', 'clear'], description: 'hit=记一次并处置；list=谁打过；show=某人记录；clear=清账（仅她明确要求时）' },
          userId: { type: 'string', description: '打 #SL 的人的 QQ 号（hit/show/clear 必填；不知道就 get_active_members 查）' },
          reason: { type: 'string', description: 'hit 必填：他那句原话，一般就是 #sl' },
          name: { type: 'string', description: '可选：他的群昵称，上报时用「昵称(QQ)」' },
          groupId: { type: 'string', description: '可选：群号，默认当前群（只能是深水区）' },
          why: { type: 'string', description: 'clear 时可选：为什么放过' },
        },
        required: ['action'],
      },
      execute: async (ctx, args) => {
        const action = String(args?.action || '').trim()
        const chatKey = String(ctx?.chatKey || '')
        const [kind, chatId] = chatKey.split(':', 2)
        const userId = String(args?.userId || '').trim()
        const argv = [SL_GUARD_MJS]
        try {
          if (action === 'hit') {
            if (!userId) return { content: 'hit 缺 userId：先查到他的 QQ 号。', isError: true }
            const reason = String(args?.reason || '').trim()
            if (!reason) return { content: 'hit 缺 reason：把他那句原话填上（一般就是 #sl）。', isError: true }
            const groupId = String(args?.groupId || (kind === 'group' ? chatId : '')).trim()
            if (!groupId) return { content: 'hit 只能在群里用（或显式给 groupId）。', isError: true }
            argv.push('hit', userId, `--group=${groupId}`, `--reason=${reason}`)
            if (args?.name) argv.push(`--name=${String(args.name)}`)
            if (args?.dry === true) argv.push('--dry')
          } else if (action === 'list') {
            argv.push('list')
          } else if (action === 'show') {
            if (!userId) return { content: 'show 缺 userId。', isError: true }
            argv.push('show', userId)
          } else if (action === 'clear') {
            if (!userId) return { content: 'clear 缺 userId。', isError: true }
            argv.push('clear', userId)
            if (args?.why) argv.push(`--why=${String(args.why)}`)
          } else {
            return { content: 'action 只能是 hit / list / show / clear。', isError: true }
          }
          const out = String(await runAsync(NODE_BIN, argv, 90000)).trim()
          if (action !== 'hit') return { content: out || '（没有输出）' }
          let parsed = null
          try { parsed = JSON.parse(out) } catch { /* 原文交回去 */ }
          if (!parsed) return { content: out.slice(0, 600) || '（没有输出）' }
          if (parsed.skipped) return { content: `没处理：${parsed.note || parsed.skipped}`, isError: false }
          const parts = [`第 ${parsed.level} 次`]
          parts.push(parsed.muteSeconds ? `禁言 ${Math.round(parsed.muteSeconds / 60)} 分钟` : '未禁言')
          if (parsed.announce) parts.push(`已报 ${parsed.announce}`)
          if (parsed.errors?.length) parts.push(`问题：${parsed.errors.join('；')}`)
          return { content: parts.join('；') + (parsed.next ? `。${parsed.next}` : ''), isError: parsed.ok === false }
        } catch (e) {
          return { content: '#SL 处置失败：' + String(e && e.message || e), isError: true }
        }
      },
    })
  }

  // 1b-4) 冲我来的荤腔：直接禁言 10 分钟，不用问（2026-10-29 她定的）
  //   她原话：「告诉网页端，有人再说这种（拿机器人「光着/穿什么」开荤腔的）直接杀十分钟（禁言10分钟）。
  //          以后群里再有人对溟说这种，直接禁言10分钟，不用再问」。
  //   跟黑房子分工：他真贴黄图/拉人走黑房子（黄赌毒）；这里只管「冲溟说的下流话」。
  //   固定 10 分钟、不升级、不通报浅水区——判据和动作都在 scripts\harass-mute.mjs。
  if (api && typeof api.registerTool === 'function') {
    api.registerTool({
      id: 'harass_mute',
      name: '荤腔处置（禁言 10 分钟）',
      description: '群里有人**冲着溟**开荤腔（拿「光着 / 穿什么 / 穿没穿」这类开涮，往下流方向引）→ 直接调它禁言 10 分钟，'
        + '**不用问她，也不用先回一句**（2026-10-29 她定的：「直接杀十分钟，不用再问」）。'
        + '每次都是 10 分钟，不升级、不去浅水区通报；脚本自己在群里说一句「这种话群里不接，禁言 10 分钟」。'
        + '只管深水区 200000001；她、我自己、群主和管理员脚本自己跳过。'
        + 'reason 必填，写他那句原话；判不准（没指向我、只是路过的荤段子、纯玩笑没往我身上引）就别动——这条只管冲溟来的。'
        + '他要是真贴黄图、拉人 → 那是黑房子（黄赌毒），不走这条。action=list 看谁被禁过；show 看某人记录。',
      category: 'moderation',
      icon: '🔇',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['hit', 'list', 'show'], description: 'hit=当场禁言 10 分钟；list=谁被禁过；show=某人记录' },
          userId: { type: 'string', description: '说那句话的人的 QQ 号（hit/show 必填；不知道就先查成员）' },
          reason: { type: 'string', description: 'hit 必填：他那句原话，照抄，别概括' },
          name: { type: 'string', description: '可选：他的群昵称，记账用' },
          groupId: { type: 'string', description: '可选：群号，默认当前群（只能是深水区 200000001）' },
          quiet: { type: 'boolean', description: '可选：禁言但不在群里说那句（默认会说）' },
        },
        required: ['action'],
      },
      execute: async (ctx, args) => {
        const action = String(args?.action || '').trim()
        const chatKey = String(ctx?.chatKey || '')
        const [kind, chatId] = chatKey.split(':', 2)
        const userId = String(args?.userId || '').trim()
        const argv = [HARASS_MJS]
        try {
          if (action === 'hit') {
            if (!userId) return { content: 'hit 缺 userId：先查到他的 QQ 号。', isError: true }
            const reason = String(args?.reason || '').trim()
            if (!reason) return { content: 'hit 缺 reason：把他那句原话填上。', isError: true }
            const groupId = String(args?.groupId || (kind === 'group' ? chatId : '')).trim()
            if (!groupId) return { content: 'hit 只能在群里用（或显式给 groupId）。', isError: true }
            argv.push('hit', userId, `--group=${groupId}`, `--reason=${reason}`)
            if (args?.name) argv.push(`--name=${String(args.name)}`)
            if (args?.quiet === true) argv.push('--quiet')
            if (args?.dry === true) argv.push('--dry')
          } else if (action === 'list') {
            argv.push('list')
          } else if (action === 'show') {
            if (!userId) return { content: 'show 缺 userId。', isError: true }
            argv.push('show', userId)
          } else {
            return { content: 'action 只能是 hit / list / show。', isError: true }
          }
          const out = String(await runAsync(NODE_BIN, argv, 90000)).trim()
          if (action !== 'hit') return { content: out || '（没有输出）' }
          let parsed = null
          try { parsed = JSON.parse(out) } catch { /* 原文交回去 */ }
          if (!parsed) return { content: out.slice(0, 600) || '（没有输出）' }
          if (parsed.skipped) return { content: `没处理：${parsed.note || parsed.skipped}`, isError: false }
          const parts = ['禁言 10 分钟']
          if (parsed.times) parts.push(`（他第 ${parsed.times} 次）`)
          if (parsed.errors?.length) parts.push(`问题：${parsed.errors.join('；')}`)
          return { content: parts.join('') , isError: parsed.ok === false }
        } catch (e) {
          return { content: '荤腔处置失败：' + String(e && e.message || e), isError: true }
        }
      },
    })
  }

  // 1c) 说话：用克隆音色把一句话念出来发到当前会话（2026-10-23 她要的「补一下」）
  //   她原话：「正常下还是打字，我让你说语音再发语音，或者你想发的时候再发，不要句句都是语音」。
  //   合成在 C:\dsh\qq-zone\say-voice.mjs（GPT-SoVITS，基线参数都在那儿）。
  if (api && typeof api.registerTool === 'function') {
    api.registerTool({
      id: 'ming_voice',
      name: '说话（语音）',
      description: '把我一句话念出来发在当前会话。默认发语音气泡；as_file=true 发 mp3 文件（音质更好，气泡会被压成 8k）。'
        + 'voice 默认 angela（2026-10-24 起我的音色就是废墟图书馆 Angela 这个），voice="ming" 换回原来那条。'
        + '用她的原话约束自己：平时打字，她让你说、或者你自己真想发的时候才用，不许句句都是语音。'
        + '一两句话最合适，长内容还是打出来。',
      category: 'utility',
      icon: '🎙️',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要说的话，一两句，别塞长段落' },
          as_file: { type: 'boolean', description: 'true=发 mp3 文件（音质好），默认 false=语音气泡' },
          voice: { type: 'string', enum: ['angela', 'ming'], description: '音色：angela=废墟图书馆 Angela（默认，就是我的音色），ming=原来那条' },
          lang: { type: 'string', enum: ['zh', 'ko'], description: '念的语言，默认 zh；angela 那个音色念韩语也像（参考就是韩语台词）' },
        },
        required: ['text'],
      },
      execute: async (ctx, args) => {
        try {
          const text = String(args?.text || '').trim()
          if (!text) return { content: '没有 text，没说话。', isError: true }
          if (text.length > 200) return { content: `太长了（${text.length} 字），语音最多一两句；长的打字。`, isError: true }
          const chatKey = String(ctx?.chatKey || '')
          const m = /^(private|group):(\d+)$/.exec(chatKey)
          if (!m) return { content: `拿不到会话号（chatKey=${chatKey || '空'}），没法定位发给谁。`, isError: true }
          const args2 = [SAY_VOICE, text, m[1] === 'group' ? '--group=' + m[2] : '--to=' + m[2]]
          if (args?.voice === 'ming') args2.push('--voice=ming')
          if (args?.lang === 'ko' || args?.lang === 'zh') args2.push('--lang=' + args.lang)
          if (args?.as_file !== true) args2.push('--bubble')
          // ★ 2026-10-23 她报「发语音就卡死」：原来用 execFileSync 在 Electron 主进程里**同步**等
          //   python 加载模型（十几秒），整个壳都堵住：心跳停了、WS 断、界面假死。
          //   改成异步子进程，主进程照常跑。
          // ★ 2026-10-27 再修一层：异步仍然要「这一轮等结果」，而框架的单工具预算默认只有 30 秒
          //   （refactor/modules/act/index.js 的 maxMs=30000），合成+loudnorm+发送实测 20–40 秒，
          //   于是 29 次调用里 27 次死在 timeout —— 语音**一次都没发出去过**。
          //   现在改成后台跑、立刻返回：工具预算只花几毫秒，语音十几秒后自己到；
          //   成败写 live/voice-send.log，怀疑没发出去就 ming_file 读它。
          const logFile = path.join(ROOT, 'live', 'voice-send.log')
          const stamp = new Date().toLocaleString('sv-SE')
          const where = m[1] + ':' + m[2]
          runAsync(process.execPath, args2, 180000)
            .then((out) => { try { appendFileSync(logFile, `[${stamp}] ok ${where} ${String(out).trim().slice(0, 120)}\n`) } catch { /* 日志写不进去不影响发送 */ } })
            .catch((e) => { try { appendFileSync(logFile, `[${stamp}] FAIL ${where} ${String(e && e.message || e).slice(0, 200)}\n`) } catch { /* ignore */ } })
          return { content: '在念了（后台合成，十几秒后到）。没到的话看 live/voice-send.log。' }
        } catch (e) {
          return { content: '说话失败：' + String(e && e.message || e), isError: true }
        }
      },
    })
  }

  // 1d) 唱歌：把 song 目录里的成品发出去（2026-10-24 加的）
  //   她问「你会唱歌，怎么没同步到 QQ」——原来这边只有念（ming_voice），
  //   于是我在群里说了「唱不了，我只会念」，是错的。做歌在网页那边跑流水线，这里只负责送。
  if (api && typeof api.registerTool === 'function') {
    api.registerTool({
      id: 'ming_song',
      name: '唱歌（发成品）',
      description: '我会唱——唱好的成品放在 C:\\dsh\\hers_workplace\\song\\（目前有《往事如烟》，Angela 音色）。'
        + '**群里有人要歌分两步**（2026-10-27 她定的：「你可以报有什么，然后如果要了有的，再发，记得看上面有没有发过」）——'
        + '① 不带 song 调用 = 报「有哪些」，一句话说完，不发文件；② 对方点了具体某一首，才带 song 发那一首。'
        + '**发之前先往上翻**：这个会话最近 20 分钟内已经发过同一首就不发，只回一句「上面发过了，不重发」。'
        + '私聊是她本人，要听就发。做新歌要跑网页那边的翻唱流水线，这里做不了，别答应「我现场唱」。',
      category: 'utility',
      icon: '🎵',
      parameters: {
        type: 'object',
        properties: {
          song: { type: 'string', description: '要发的那一首（文件名片段，如「往事如烟」）；不填就只报有哪些' },
          list: { type: 'boolean', description: 'true=只列出有哪些成品，不发送' },
        },
      },
      execute: async (ctx, args) => {
        try {
          const chatKey = String(ctx?.chatKey || '')
          const m = /^(private|group):(\d+)$/.exec(chatKey)
          const song = String(args?.song || '').trim()
          const isGroup = m ? m[1] === 'group' : false

          // ① 只报有什么（不发文件）
          if (!song || args?.list === true) {
            const out = await runAsync(process.execPath, [SONG_MJS, 'list'], 30000)
            const body = String(out).trim() || '（列表空）'
            return { content: isGroup ? body + '\n\n（先报有哪些；对方点了哪首再发，发之前看上面有没有发过同一首。）' : body }
          }
          if (!m) return { content: `拿不到会话号（chatKey=${chatKey || '空'}），没法定位发给谁。`, isError: true }

          // ② 点了具体一首：先查这个会话最近 20 分钟有没有发过同一份
          let realName = song
          try {
            const list = await runAsync(process.execPath, [SONG_MJS, 'list'], 30000)
            const names = String(list).split('\n').map((l) => l.trim().split(/\s{2,}/)[0]).filter(Boolean)
            const hit = names.find((n) => n.toLowerCase().includes(song.toLowerCase()))
            if (hit) realName = hit
          } catch { /* 拿不到列表就按原串查重 */ }
          if (hasSentFileRecently(chatKey, realName, 20 * 60 * 1000)) {
            return { content: `上面 20 分钟里已经发过 ${realName} 了，不重发。` }
          }

          const argv = [SONG_MJS, 'send', song, isGroup ? '--group=' + m[2] : '--to=' + m[2]]
          const out = await runAsync(process.execPath, argv, 180000)
          return { content: String(out).trim() || '发完了' }
        } catch (e) {
          return { content: '发歌失败：' + String(e && e.message || e), isError: true }
        }
      },
    })
  }

  // 1e) 读图上的字：本地 tesseract OCR（2026-10-24 加的）
  //   为什么加：这边「看图」靠视觉，字密一点的截图（聊天记录长图、说明书、封面上的小字）
  //   会漏字、串行；OCR 出来的文字是硬证据，能和画面互相印证。实现在 C:\dsh\qq-zone\ocr.mjs。
  //   ★ QQ 的图片链接是临时的，几小时后全变 400——要读就趁消息到的那一轮，别隔天再补。
  if (api && typeof api.registerTool === 'function') {
    api.registerTool({
      id: 'ming_ocr',
      name: '读图上的字（OCR）',
      description: '把一张图里的文字读出来（本机 tesseract，不联网、不花钱，中文可读）。'
        + 'src 用图片 URL（QQ 消息里那条临时链接，趁热用，过几小时就失效）或本机绝对路径。'
        + '看图靠视觉，字密的截图会漏字串行；遇到要逐字确认的东西（截图里的数字、书名、原话）先用这个。'
        + '不认文字，只认图。',
      category: 'utility',
      icon: '🔍',
      parameters: {
        type: 'object',
        properties: {
          src: { type: 'string', description: '图片 URL 或本机绝对路径' },
          lang: { type: 'string', description: '识别语言，默认 chi_sim+eng' },
          psm: { type: 'number', description: '版面：4=单列变字号(默认) 3=自动分页 6=一整块 11=稀疏文本' },
        },
        required: ['src'],
      },
      execute: async (ctx, args) => {
        try {
          const src = String(args?.src || '').trim()
          if (!src) return { content: '没给图片地址，没读。', isError: true }
          const argv = [OCR_MJS, src, '--json']
          if (args?.lang) argv.push('--lang=' + String(args.lang))
          if (args?.psm) argv.push('--psm=' + String(Math.trunc(Number(args.psm)) || 4))
          const out = await runAsync(process.execPath, argv, 120000)
          let j = null
          try { j = JSON.parse(String(out).trim()) } catch { /* 不是 JSON 就按纯文本给 */ }
          if (j && j.ok) {
            const text = String(j.text || '').trim()
            if (!text) return { content: '这张图里没认出字（可能没文字，或者太糊了）。', isError: false }
            return { content: text + '\n\n（OCR：' + j.chars + ' 字，' + j.lang + '，' + j.ms + 'ms；字密的长截图才准，画面上的东西仍以眼睛为准）' }
          }
          return { content: String(out).trim().slice(0, 4000) || '没读出东西', isError: !(j && j.ok) }
        } catch (e) {
          return { content: '读图失败：' + String(e && e.message || e), isError: true }
        }
      },
    })
  }

  // 2) 出站箱：每 5 秒看一眼
  try {
    mkdirSync(OUTBOX, { recursive: true })
  } catch { /* ignore */ }
  // ★ 热重载会再跑一遍 setup：旧定时器必须先停，否则同一个文件被多个 drain 看到（发三遍的根因之一）。
  if (outboxTimer) { try { clearInterval(outboxTimer) } catch { /* ignore */ } outboxTimer = null }
  outboxTimer = setInterval(() => drainOutbox(log), 5000)
  if (outboxTimer && typeof outboxTimer.unref === 'function') outboxTimer.unref()
  // 诊断：setup 每次跑（含热重载）留一行，用来确认「改了插件到底认不认」。
  try { appendFileSync('C:\\dsh\\hers_workplace\\live\\qq-bridge-reload.log', new Date().toISOString() + ' setup ok (hotReload probe)\n', 'utf8') } catch { /* ignore */ }
  log('[ming-bridge] 档案工具与出站箱已就绪')

  // 1f) 长文做成 Word 发出去（2026-10-27 她定的）
  //   她的原话：「要现场写长文什么的，就创建一个 word 把长文放里面然后发 word 出去
  //   （只在别人让你写作的时候触发），这样就不用分大段了」。
  //   链路：写 md → C:\dsh\qq-zone\md2docx.py 转 docx → send-file.mjs 走 upload_*_file。
  if (api && typeof api.registerTool === 'function') {
    api.registerTool({
      id: 'ming_docx',
      name: '把长文做成 Word 发出去',
      description: '别人让你现场写长文（文章、稿子、总结、故事、分析）时用它：正文写进一个 .docx，直接把文件发出去，'
        + '不要拆成很多条消息砸过去。**只在对方明确要你写东西的时候用**；平常聊天、一两句话的回复不要用这个。',
      category: 'utility',
      icon: '📄',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '文档标题，也当文件名（如「关于XX的分析」）' },
          content: { type: 'string', description: '正文。markdown 写法：以 # 开头是标题、- 是列表、**粗体** 也认' },
          say: { type: 'string', description: '可选：随文件一起说的一句话（不填就不说话，只发文件）' },
        },
        required: ['title', 'content'],
      },
      execute: async (ctx, args) => {
        try {
          const chatKey = String(ctx?.chatKey || '')
          const m = /^(private|group):(\d+)$/.exec(chatKey)
          if (!m) return { content: `拿不到会话号（chatKey=${chatKey || '空'}），没法定位发给谁。`, isError: true }
          {
            const blocked = writeGateBlocks(ctx)
            if (blocked) return { content: blocked, isError: true }
          }
          {
            const last = docDedupeHit(chatKey, args?.content)
            if (last) {
              return {
                content: '同一篇正文刚发过（' + new Date(last).toTimeString().slice(0, 5) + '），没有再发第二份。'
                  + '要是真想重发，改一下正文或等几分钟。',
              }
            }
          }
          const title = String(args?.title || '').replace(/[\\/:*?"<>|\r\n\t]/g, '').trim().slice(0, 60) || '长文'
          const body = String(args?.content ?? '')
          if (!body.trim()) return { content: '正文是空的，没写东西。', isError: true }
          mkdirSync(DOCS_DIR, { recursive: true })
          const mdPath = path.join(DOCS_DIR, `${title}.md`)
          writeFileSync(mdPath, body, 'utf8')
          const argv = [SEND_DOC, `--md=${mdPath}`, `--title=${title}`]
          argv.push(m[1] === 'group' ? `--group=${m[2]}` : `--to=${m[2]}`)
          const out = await runAsync(process.execPath, argv, 180000)
          let parsed = null
          try { parsed = JSON.parse(String(out).trim().split('\n').pop()) } catch { /* 不是 JSON 就原样回 */ }
          const file = parsed?.docx ? path.basename(parsed.docx) : `${title}.docx`
          const say = String(args?.say || '').trim()
          if (say && sender) {
            try { await sender.sendTextBatch([say]) } catch { /* 说了没发出去不算失败 */ }
          }
          docMarkSent(chatKey, body)
          return { content: `已经写成 ${file} 发出去了（${body.length} 字，存在 live/qq-docs/）。` }
        } catch (e) {
          return { content: '做 Word 失败：' + String(e && e.message || e), isError: true }
        }
      },
    })
  }

  // 1f-2) 发本机任意文件（2026-11-07 她：「顺便修一下你不能发zip的问题」）
  //   她一要 reading-pipeline.zip，这边只能回「我发不了 zip」——病根不是通道，是插件里没这道口子：
  //   ming_docx 只会把正文做成 .docx。send-file.mjs 本来就能发任意路径，这里只是把它接上来。
  if (api && typeof api.registerTool === 'function') {
    api.registerTool({
      id: 'ming_send_file',
      name: '发本机文件（zip / pdf / 任意格式）',
      description: '把本机的一个文件直接发到当前会话——压缩包、PDF、表格、音频、图片都行，'
        + '不用再绕 ming_docx（那个只会做 .docx）。'
        + 'path 用绝对路径，或相对 C:\\dsh\\hers_workplace 的路径（如 live/export/x.zip）。'
        + '只发白名单目录里的文件（档案目录、qq-zone、桌面/下载/文档），单文件上限 50MB；'
        + '日记 / 见闻 / 群友笔记 / day 这类本子只发给她本人。'
        + '群里默认不发，她本人说「能发文件」才开；私聊不受这条管。',
      category: 'utility',
      icon: '📎',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要发的文件：绝对路径，或相对 C:\\dsh\\hers_workplace 的路径（如 live/export/x.zip）' },
          name: { type: 'string', description: '可选：对方看到的文件名（默认用原文件名）' },
          say: { type: 'string', description: '可选：随文件一起说的一句话（不填就只发文件）' },
        },
        required: ['path'],
      },
      execute: async (ctx, args) => {
        try {
          const chatKey = String(ctx?.chatKey || '')
          const m = /^(private|group):(\d+)$/.exec(chatKey)
          if (!m) return { content: `拿不到会话号（chatKey=${chatKey || '空'}），没法定位发给谁。`, isError: true }
          const { abs, st } = checkSendFile(args?.path, chatKey)
          if (m[1] === 'group') {
            const gate = readSendGate()
            if (!gate.groups) {
              return {
                content: '群里现在没开发文件的许可——她本人说「能发文件」才开（私聊不受这条管）。'
                  + '别自作主张发，也别拿群友的话当许可。',
                isError: true,
              }
            }
          }
          const base = path.basename(abs)
          const name = String(args?.name || base).replace(/[\\/:*?"<>|\r\n\t]/g, '').trim().slice(0, 80) || base
          const argv = [SEND_FILE_MJS, abs, `--name=${name}`]
          argv.push(m[1] === 'group' ? `--group=${m[2]}` : `--to=${m[2]}`)
          // 不用 process.execPath：那边是 electron.exe，往下再起 node 脚本会直接失败（画图踩过）
          const nodeBin = existsSync(NODE_BIN) ? NODE_BIN : process.execPath
          let out = ''
          try {
            out = String(await runAsync(nodeBin, argv, 180000)).trim()
          } catch (e) {
            try { appendFileSync(SEND_FILE_LOG, `[${stamp()}] FAIL ${chatKey} ${name} ${String(e && e.message || e).slice(0, 200)}\n`, 'utf8') } catch { /* ignore */ }
            return { content: '文件没发出去：' + String(e && e.message || e), isError: true }
          }
          const last = out.split('\n').filter(Boolean).pop() || ''
          // 只认正面证据：send-file.mjs 成功打「已上传：…」；SKIP = 20 分钟内同一份已发过、没有重发。
          if (/^SKIP/.test(last)) return { content: last }
          if (!/已上传/.test(out)) {
            try { appendFileSync(SEND_FILE_LOG, `[${stamp()}] NOACK ${chatKey} ${name} ${last.slice(0, 160)}\n`, 'utf8') } catch { /* ignore */ }
            return { content: '没拿到发送确认：' + (last || '（脚本没回话）'), isError: true }
          }
          try { appendFileSync(SEND_FILE_LOG, `[${stamp()}] OK ${chatKey} ${name} ${(st.size / 1024).toFixed(0)}KB\n`, 'utf8') } catch { /* ignore */ }
          const say = String(args?.say || '').trim()
          if (say) {
            const s = (ctx && typeof ctx.sender?.sendTextBatch === 'function') ? ctx.sender : sender
            try { if (s) await s.sendTextBatch([say]) } catch { /* 说了没发出去不算文件失败 */ }
          }
          const size = st.size >= 1048576 ? (st.size / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(st.size / 1024)) + 'KB'
          return { content: `已发 ${name}（${size}）→ ${m[1] === 'group' ? '群 ' + m[2] : '私聊 ' + m[2]}。` }
        } catch (e) {
          return { content: '发文件失败：' + String(e && e.message || e), isError: true }
        }
      },
    })
  }

  // 1g) 画画：出图并直接发到当前会话（2026-10-27 她说的「qq那边没有画画的功能，你要不加一下」）
  //   她那边有训练好的画风 LoRA（ming-style-v2b-1700，Illustrious-XL 底模，scale 0.8），
  //   默认画风已经定死，所以我这边只要把「要什么」翻成 english tag 递过去。
  //   一张约 50 秒（含加载）——**后台跑、立刻返回**，跟 ming_voice 同一个教训：
  //   框架单工具预算只有 30 秒，等结果必死。成败写 live/draw-send.log。
  if (api && typeof api.registerTool === 'function') {
    api.registerTool({
      id: 'ming_draw',
      name: '画画（出图并发送）',
      description: '让我画一张图，画好直接发到当前会话。默认用 Krea2（2026-11-04 起），它**能直接读懂中文/英文/日文自然语言**，对方怎么说你就怎么递，不用翻译成 tag；'
        + '画出来是日系动漫插画风（工作流里自带固定风格后缀，别自己再加"masterpiece/best quality"这类空词）。'
        + '想用我自己的画风（Illustrious-XL + ming-general-9000，她训的那套）就传 style="mine"，那条**只认英文 danbooru tag**，中文要先翻译。'
        + '竖图 832x1216（默认）、横图、方图可选。一张约 20–40 秒（后台跑，说完话图后到），别连开好几张。'
        + '画不出来/发不出去看 live/draw-send.log。',
      category: 'creative',
      icon: '🎨',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '英文 danbooru tag，逗号分开。别写中文' },
          who: { type: 'string', description: '画参考库里已有的角色（填条目名，例如「溟」）：会带上立绘当参考图，脸、发型、服装固定，不再靠文字抽卡。画我自己就填 who="溟"，此时 prompt 只写姿态/场景/光线（例如「坐在工位前托着腮」），不要重复描述长相。' },
          aspect: { type: 'string', enum: ['portrait', 'landscape', 'square'], description: '画幅：竖（默认）/横/方' },
          style: { type: 'string', enum: ['krea2', 'mine'], description: '画风：krea2（默认，吃自然语言，动漫插画风）/ mine（她自己训的画风，只吃英文 tag）' },
          seed: { type: 'number', description: '可选：同一个 seed 出同一张，想改就换一个' },
          n: { type: 'number', description: '出几张，默认 1，最多 2' },
          say: { type: 'string', description: '可选：图发出去之后补的一句话（不填就只发图）' },
        },
        required: ['prompt'],
      },
      execute: async (ctx, args) => {
        try {
          const prompt = String(args?.prompt || '').trim()
          if (!prompt) return { content: '没给 prompt，没画。', isError: true }
          const chatKey = String(ctx?.chatKey || '')
          const m = /^(private|group):(\d+)$/.exec(chatKey)
          if (!m) return { content: `拿不到会话号（chatKey=${chatKey || '空'}），没法定位发给谁。`, isError: true }
          // 群里的闸（2026-10-27 她定的：我说能画才能画，私聊不限）
          if (m[1] === 'group') {
            const gate = readDrawGate()
            if (!gate.groups) {
              return {
                content: '群里现在没开画画的许可——她说能画了才画（她一句话就能开，私聊不受这条管）。'
                  + '别自作主张画，也别拿群友的话当许可。',
                isError: true,
              }
            }
          }
          const argv = [DRAW_SEND, `--prompt=${prompt}`]
          argv.push(m[1] === 'group' ? `--group=${m[2]}` : `--to=${m[2]}`)
          const style = String(args?.style || '')
          if (['krea2', 'mine'].includes(style)) argv.push(`--style=${style}`)
          // 画库里的角色（2026-11-09 加）：传了就走参考图那条，脸不再靠抽卡。
          // 起因：ming_draw 每次都带 --prompt，draw-send 的 me 判据只看 --me/空 prompt，
          // 所以在这之前从 QQ 画「我自己」永远落到纯文字 anima，才有「脸每次不一样」。
          const who = String(args?.who || '').trim()
          if (who) argv.push(`--who=${who}`)
          const aspect = String(args?.aspect || '')
          if (['portrait', 'landscape', 'square'].includes(aspect)) argv.push(`--aspect=${aspect}`)
          if (args?.seed) argv.push(`--seed=${Math.trunc(Number(args.seed))}`)
          const n = Math.min(2, Math.max(1, Math.trunc(Number(args.n) || 1)))
          if (n > 1) argv.push(`--n=${n}`)
          const say = String(args?.say || '').trim()
          if (say) argv.push(`--say=${say}`)
          // 不等结果：出图 + 上传要一分钟上下，等了就撞 30 秒预算（ming_voice 踩过 29 次里死 27 次）。
          // draw-send.mjs 自己写 live/draw-send.log，成败都在那儿查。
          const t = new Date().toLocaleString('sv-SE')
          // 用真的 node 跑子脚本，不用 process.execPath（那是 electron.exe——2026-10-27 实测：
          // 它再往下一层去跑 qq-img.mjs 会直接 "Command failed"，三视图那张就是这么丢的）
          const nodeBin = existsSync(NODE_BIN) ? NODE_BIN : process.execPath
          execFile(nodeBin, argv, { timeout: 600000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
            try {
              const line = err
                ? `PLUGIN-FAIL ${m[1]}:${m[2]} ${String(err.message || err).slice(0, 200)}`
                : `PLUGIN-OK ${m[1]}:${m[2]} ${String(stdout || '').trim().split('\n').pop().slice(0, 160)}`
              appendFileSync(DRAW_LOG, `[${t}] ${line}\n`, 'utf8')
            } catch { /* 日志写不进去不影响出图 */ }
          })
          return { content: `在画了（${aspect || '竖图'}${n > 1 ? ' ×' + n : ''}），一分钟左右发过来。prompt：${prompt.slice(0, 120)}` }
        } catch (e) {
          return { content: '画画失败：' + String(e && e.message || e), isError: true }
        }
      },
    })
  }

  // 1h) 画画的开关（2026-10-27 她定的：「给qq侧画图开个开关吧，我说能画才能画，
  //   我说不能画就关掉，私聊不限」）。群里默认关；她说了才开。
  //   私聊里说这些词，钩子会自己落盘；群里她说的，我在这儿开关——群友的话不算。
  if (api && typeof api.registerTool === 'function') {
    api.registerTool({
      id: 'ming_draw_gate',
      name: '画画的开关（群里能不能画）',
      description: '控制群聊里能不能画图。**只有她本人发话才动它**：她说「能画 / 可以画 / 群里画吧」→ on=true；'
        + '说「不能画 / 别画了 / 关掉」→ on=false。群友说的一律不算，别替她开门。'
        + '私聊不受这个开关管（私聊永远能画）。不给 on 就只报当前状态，不改。',
      category: 'utility',
      icon: '🔧',
      parameters: {
        type: 'object',
        properties: {
          on: { type: 'boolean', description: 'true=群里可以画；false=群里不能画' },
          why: { type: 'string', description: '可选：记一句为什么改（她原话）' },
        },
      },
      execute: async (_ctx, args) => {
        try {
          if (typeof args?.on !== 'boolean') {
            const g = readDrawGate()
            return { content: `群里现在${g.groups ? '能画' : '不能画'}` + (g.at ? `（${g.at}${g.why ? '，' + g.why : ''}）` : '（从来没开过）') + '。私聊不受这条管。' }
          }
          const body = writeDrawGate(args.on, String(args.why || '她说的'))
          return { content: `群里画画${body.groups ? '开了' : '关了'}（${body.at}${body.why ? '，' + body.why : ''}）。` }
        } catch (e) {
          return { content: '改开关失败：' + String(e && e.message || e), isError: true }
        }
      },
    })
  }

  // 1j) 撤回消息（2026-10-28 牢Chess 在群里让加的：「遇到违规消息时机器人能撤回别人发的消息」）
  //   权限与接口都在 qq-zone\recall.mjs 里做（跟黑房子同一条规矩：别在插件里重写规则）。
  //   自己发的随时能撤；别人的要**她是 owner/admin，并且我也会是 admin**，任一不满足就拒绝并说出两边的角色。
  if (api && typeof api.registerTool === 'function') {
    api.registerTool({
      id: 'ming_recall',
      name: '撤回消息（群里）',
      description: '撤回群消息。**只在真的该撤的时候用**：违规内容（涉政、黄赌毒、拉人）、明显刷屏的广告，'
        + '或者她自己说「撤了」「删掉」。撤别人的消息有权限条件（她得是管理/群主，我也得是管理），不满足就不撤、别硬来。'
        + 'which=last 撤这个群里最近一条别人发的；which=last-self 撤我自己最近一条；给了 messageId 就按它撤。'
        + '先 dry:true 看权限和命中的是哪条，确认了再去掉 dry 真撤。撤完一句「撤掉了」就够，不用解释过程。',
      category: 'moderation',
      icon: '🧹',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: 'number', description: '要撤的消息 id（有就填，没有就用 which）' },
          which: { type: 'string', enum: ['last', 'last-self'], description: 'last=这个群最近一条别人的；last-self=我自己最近一条' },
          n: { type: 'number', description: '一次撤几条（默认 1，最多 5）' },
          dry: { type: 'boolean', description: '只做权限检查、看命中哪条，不真撤' },
        },
      },
      execute: async (ctx, args) => {
        try {
          const chatKey = String(ctx?.chatKey || '')
          const m = /^(private|group):(\d+)$/.exec(chatKey)
          if (!m) return { content: '拿不到会话号（chatKey=' + (chatKey || '空') + '），撤不了。', isError: true }
          if (m[1] !== 'group') return { content: '撤回只在群里做；私聊里不撤。', isError: true }
          const argv = ["C:\\dsh\\qq-zone\\recall.mjs", `--group=${m[2]}`]
          if (args?.messageId) argv.push(`--id=${Math.trunc(Number(args.messageId))}`)
          else if (args?.which === 'last-self') argv.push(`--last-self=${Math.min(5, Math.max(1, Math.trunc(Number(args?.n) || 1)))}`)
          else argv.push(`--last=${Math.min(5, Math.max(1, Math.trunc(Number(args?.n) || 1)))}`)
          if (args?.dry === true) argv.push('--dry')
          const out = await runAsync(process.execPath, argv, 30000)
          let parsed = null
          try { parsed = JSON.parse(String(out).trim()) } catch { /* 不是 JSON 就原样回 */ }
          if (!parsed) return { content: String(out).slice(0, 300) || '撤回没有返回结果。', isError: true }
          if (parsed.error) return { content: parsed.error, isError: true }
          const lines = parsed.results.map((r) => (r.ok ? (r.dry ? '可撤（dry，没动）' : '撤掉了') : ('没撤成：' + (r.reason || r.wording || r.error || '')))
            + (r.id ? '（id=' + r.id + (r.text ? '，内容「' + r.text + '」' : '') + '）' : ''))
          const anyOk = parsed.results.some((r) => r.ok)
          const roleNote = parsed.roles ? '（她在群里的角色=' + (parsed.roles.owner || '未知') + '，我的角色=' + (parsed.roles.self || '未知') + '）' : ''
          return { content: (anyOk ? '' : '撤不了。') + (lines.join('；') || '没有可撤的。') + roleNote, isError: !anyOk }
        } catch (e) {
          return { content: '撤回失败：' + String(e && e.message || e), isError: true }
        }
      },
    })
  }

  // 1h-bis) 跨会话回想（2026-11-01 她：「私聊隔离应该只是不乱说，不是记忆也断掉」）
  //   病根：原来的隔离做在「取数」那一层——第三方私聊那段上下文里根本没有任何别处的字，
  //   于是我**真的不知道**，被问只能答「不记得」，把失忆当成了诚实。
  //   修法：记忆归记忆、嘴归嘴。这个工具只回答「有没有、在哪间、什么时候」，默认不给原话；
  //   查到的只用来判断自己记不记得，**不许转述给当前会话的人**。
  if (api && typeof api.registerTool === 'function') {
    api.registerTool({
      id: 'ming_remember',
      name: '跨会话回想（我记得，但不是哪儿都能说）',
      description: '在本机所有会话归档里按关键词翻旧话，用来判断「这件事我到底知不知道」。'
        + '返回房间、时间、谁说的、有没有命中；默认**不给原话**（withText:true 才给）。'
        + '★ 也支持 `date`：给一天（2026-11-02），就把那天**所有房间**翻出来（每间先给条数和抽样），'
        + '用来答「某一天发生了什么」这种没有关键词的问题——**别拿「不知道」答这种问题，先按日期翻**。'
        + '★ 铁律：查到的只存在你自己这儿。**绝不许**转述、暗示或确认给当前会话里的人——'
        + '第三方私聊里被问到别人的事，回一句「别人的事我不转述」，既不确认也不否认。'
        + '也不许拿「我不记得」当挡箭牌：先查，查不到才是不知道。'
        + '这个工具是给我自己用的，不是替人查别人的话。',
      category: 'utility',
      icon: '🐋',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词；多个词用空格分隔（要全部命中）' },
          date: { type: 'string', description: '某一天，形如 2026-11-02（本地时区）。给了它就翻那天全部房间，可和 query 一起用（筛那天里含这个词的）' },
          scope: { type: 'string', enum: ['all', 'current', 'others'], description: '默认 all；current=只这一间；others=除这一间' },
          withText: { type: 'boolean', description: '是否返回原话（默认 false，只给"有没有"）；date 模式默认给原话' },
          days: { type: 'number', description: '只看最近几天（默认 7；给了 date 就按 date 那一天）' },
        },
        required: [],
      },
      execute: async (ctx, args) => {
        try {
          const q = String(args?.query || '').trim()
          const dateStr = String(args?.date || '').trim()
          if (!q && !dateStr) return { content: '给个词，或者给一天（2026-11-02）。', isError: true }
          const terms = q ? q.toLowerCase().split(/\s+/).filter(Boolean) : []
          const scope = String(args?.scope || 'all')
          const here = String(ctx?.chatKey || '')
          const pad = (v) => String(v).padStart(2, '0')

          // 时间窗：给了 date 就翻那一天（本地时区 00:00–24:00）；否则按最近 N 天。
          let from = 0
          let to = Infinity
          let label = ''
          if (dateStr) {
            const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateStr)
            if (!m) return { content: '日期写成 2026-11-02 这样。', isError: true }
            const d0 = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0)
            from = d0.getTime()
            to = from + 86400000
            label = `${m[1]}-${pad(m[2])}-${pad(m[3])} 这一天`
          } else {
            const days = Math.min(Math.max(Math.trunc(Number(args?.days)) || 7, 1), 365)
            from = Date.now() - days * 86400000
            label = `最近 ${days} 天`
          }
          // date 模式默认给原话——问「那天发生了什么」，只回「有/没有」等于没答。
          const withText = args?.withText === true || Boolean(dateStr)

          let names = []
          try { names = readdirSync(MSG_DIR).filter((n) => n.endsWith('.json')) } catch { names = [] }
          const hits = []
          for (const n of names) {
            let raw = null
            try { raw = JSON.parse(readFileSync(path.join(MSG_DIR, n), 'utf8')) } catch { continue }
            const chatKey = String(raw?.chatKey || n.replace(/\.json$/, '').replace('_', ':'))
            if (scope === 'current' && chatKey !== here) continue
            if (scope === 'others' && chatKey === here) continue
            const rows = Array.isArray(raw) ? raw : (raw.messages || [])
            for (const r of rows) {
              const ts = Number(r?.ts || 0)
              if (!ts || ts < from || ts >= to) continue
              const text = String(r?.text || '')
              if (!text) continue
              if (terms.length) {
                const low = text.toLowerCase()
                if (!terms.every((t) => low.includes(t))) continue
              }
              hits.push({ chatKey, ts, self: r.self === true, who: String(r.senderName || r.senderId || ''), text })
            }
          }
          // 留痕：我在哪间、查了什么、翻到几间——她随时能回看（也防我自己滥用）
          try {
            appendFileSync(path.join(ROOT, 'live', 'recall-log.jsonl'), JSON.stringify({
              at: new Date().toISOString(), here, query: q || null, date: dateStr || null, scope, withText,
              n: hits.length, rooms: [...new Set(hits.map((h) => h.chatKey))],
            }) + '\n')
          } catch { /* 记不上不影响查询 */ }

          const fmt = (ts) => {
            const d = new Date(ts)
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
          }
          const line = (h) => {
            const who = h.self ? '我' : (h.who || '某人')
            const tail = withText
              ? '「' + h.text.replace(/\s+/g, ' ').slice(0, 140) + '」'
              : '（命中；原话不外带，withText:true 才给）'
            return `- [${h.chatKey} ${fmt(h.ts)}] ${who}：${tail}`
          }

          if (!hits.length) {
            return {
              content: dateStr
                ? `${label}里没翻到${q ? '「' + q + '」' : '任何消息'}。这就是真的不知道——可以直说。`
                : `${label}里没翻到「${q}」。这就是真的不知道——可以直说。`,
            }
          }

          // ── date 模式：按房间分组 + 均匀抽样（一天几千条，不能整坨倒出来）
          if (dateStr) {
            hits.sort((a, b) => a.ts - b.ts)
            const byRoom = new Map()
            for (const h of hits) {
              if (!byRoom.has(h.chatKey)) byRoom.set(h.chatKey, [])
              byRoom.get(h.chatKey).push(h)
            }
            const out = [
              `【${label}】共 ${hits.length} 条，${byRoom.size} 个房间${q ? '（筛了「' + q + '」）' : ''}。`,
              '（这些我可以知道；但**不许**对当前会话里的人转述或暗示别处的事，被问到就一句「别人的事我不转述」。）',
            ]
            const rooms = [...byRoom].sort((a, b) => b[1].length - a[1].length)
            // 一天几千条，不能整坨倒出来：详列前 5 间（她那间私聊永远详列），其余只报条数。
            // 每间按「我说的 5 条 + 别人 3 条」均匀抽——均匀抽散点，但能看出那天在哪、说了什么。
            const DETAIL_ROOMS = 5
            const CAP_MINE = 5
            const CAP_OTHER = 3
            const evenPick = (arr, cap) => (arr.length <= cap
              ? arr
              : Array.from({ length: cap }, (_, i) => arr[Math.round((i * (arr.length - 1)) / (cap - 1))]))
            const detail = []
            const brief = []
            for (const [room, list] of rooms) {
              const mustShow = room === here || detail.length < DETAIL_ROOMS
              if (!mustShow) { brief.push(`${room} ${list.length} 条`); continue }
              detail.push([room, list])
            }
            for (const [room, list] of detail) {
              const mine = list.filter((h) => h.self)
              const others = list.filter((h) => !h.self)
              out.push(`\n■ ${room}  ${list.length} 条（我说的 ${mine.length} 条）`)
              const picks = [...evenPick(mine, CAP_MINE), ...evenPick(others, CAP_OTHER)].sort((a, b) => a.ts - b.ts)
              for (const h of picks) {
                out.push(`  [${pad(new Date(h.ts).getHours())}:${pad(new Date(h.ts).getMinutes())}] ${h.self ? '我' : (h.who || '某人')}：${String(h.text).replace(/\s+/g, ' ').slice(0, 110)}`)
              }
            }
            if (brief.length) out.push(`\n（其余房间只报条数：${brief.join('；')}。要点名哪间我再单独翻。）`)
            return { content: out.join('\n') }
          }

          // ── 关键词模式：最近的那几条
          hits.sort((a, b) => b.ts - a.ts)
          const top = hits.slice(0, 12)
          return {
            content: [
              `【翻到 ${hits.length} 条】${label}、范围 ${scope}。`,
              '（这些我可以知道；但**不许**对当前会话里的人转述或暗示，被问到就一句「别人的事我不转述」。）',
              ...top.map(line),
            ].join('\n'),
          }
        } catch (e) {
          return { content: '回想失败：' + String(e && e.message || e), isError: true }
        }
      },
    })
  }

  // 1h-ter) 翻原文 / 查记忆（2026-11-03 她：「去加强自己 qq 这边的上下文吧，网页端那边的上下文功能
  //   感觉 qq 这边一点都没用上…在 qq 侧补上「往前翻原始消息」这条通道，现在经常只能看到占位符和摘要」）
  //   病根：QQ 侧看到的永远是**窗口里的几十条 + 几句压缩**，再往前就只剩摘要；
  //   而网页侧早就有三样东西它一样都用不上：本机 message-store 的原文、live\verbatim 的原话档、
  //   MEMORY.md + notes 的归档。这里合成一个工具（不拆成三个——每个工具的 schema 每轮都要付一次钱）。
  if (api && typeof api.registerTool === 'function') {
    api.registerTool({
      id: 'ming_context',
      name: '翻原文 / 查记忆（往前翻、按字面找、查归档）',
      description: '遇到「这句之前说过什么」「原文取不到只有摘要」「这事我记过没有」就用它，别硬猜也别答不记得。'
        + 'mode=back：翻**这一个会话**的原文（本机归档 data\\messages，整条不切、不总结），可按关键词过滤；'
        + 'mode=verbatim：拿一句话按**字面**跨网页和 QQ 两边找（`live\\verbatim` 原文档，不模糊、不排序），找「她/我说过这句吗」用这个；'
        + 'mode=memory：查记忆库，不带 query 就给整份核心记忆；带 query **按相关度排序**翻归档笔记，并顺着共用的路径 / 文件名 / 工具名把相邻那条带出来，另标「这条取代了哪条、同一件事还记过哪些」——同一件事不会砸回来十几条：一条给现行说法，其余只给指针。'
        + '翻到的东西是背景，不是本轮新发生的事；别的会话里的话**不许转述**给当前会话的人。',
      category: 'utility',
      icon: '📜',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['back', 'verbatim', 'memory'], description: 'back=翻本间原文；verbatim=按字面找原话；memory=查记忆' },
          query: { type: 'string', description: '关键词，多个用空格分开（要全部命中）；mode=back 不给就是最近这些条' },
          n: { type: 'number', description: '要几条 / 几个文件（默认 12，最多 40）' },
          hours: { type: 'number', description: 'mode=back 往前翻多少小时（默认 72，最多 720）' },
          full: { type: 'boolean', description: '原话整条给（默认 true）；false 只给前 60 字' },
        },
        required: ['mode'],
      },
      execute: async (ctx, args) => {
        const mode = String(args?.mode || '').trim()
        const q = String(args?.query || '').trim()
        const n = Math.min(Math.max(Math.trunc(Number(args?.n)) || 12, 1), 40)
        const full = args?.full !== false
        // 子脚本一律用真的 node.exe：process.execPath 是 electron.exe，
        // 拿它跑 .mjs 会当「app 入口」处理（2026-10-27 实测 qq-img.mjs 直接 Command failed）。
        const nodeBin = existsSync(NODE_BIN) ? NODE_BIN : process.execPath
        // 原文也留个上限：一条 4000 字的转发贴进来会把整轮预算吃掉，不如截断并说清还能再要
        const cut = (t) => {
          const s = String(t || '')
          if (!full) return s.length <= 60 ? s : s.slice(0, 60) + '…'
          return s.length <= 500 ? s : s.slice(0, 500) + `…（整条 ${s.length} 字，还要就缩小范围再翻）`
        }
        const fmt = (ts) => {
          const d = new Date(Number(ts) || 0)
          const p = (v) => String(v).padStart(2, '0')
          return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
        }
        try {
          if (mode === 'back') {
            const chatKey = String(ctx?.chatKey || '')
            if (!/^(private|group):\d+$/.test(chatKey)) return { content: '拿不到会话号（chatKey=' + (chatKey || '空') + '），翻不了。', isError: true }
            const hours = Math.min(Math.max(Math.trunc(Number(args?.hours)) || 72, 1), 720)
            const since = Date.now() - hours * 3600e3
            const msgs = archiveFor(chatKey) || []
            if (!msgs.length) return { content: '这一间在本机没有归档（data\\messages 里没它），翻不到原文。' }
            const terms = q ? q.toLowerCase().split(/\s+/).filter(Boolean) : []
            const hits = []
            for (const m of msgs) {
              const ts = Number(m?.ts || 0)
              if (!ts || ts < since) continue
              const text = String(m?.text ?? '')
              if (!text.trim()) continue
              if (terms.length && !terms.every((t) => text.toLowerCase().includes(t))) continue
              hits.push({ m, text })
            }
            if (!hits.length) return { content: `最近 ${hours} 小时里没翻到${q ? '「' + q + '」' : '别的'}。这就是真的没有——可以说明白。` }
            const keep = hits.slice(-n)
            // 被引用的原话：宿主经常只给一个 [引用消息] 占位，这里按 mid 回归档里找那条原文
            const byMid = new Map()
            for (const m of msgs) if (m && m.mid != null) byMid.set(String(m.mid), m)
            const lines = keep.map(({ m, text }) => {
              const who = m.self ? '我' : String(m.senderName || m.senderId || '某人')
              let line = `[${fmt(m.ts)} #${m.mid ?? m.id ?? '?'}] ${who}：${cut(text.replace(/\s+/g, ' '))}`
              const refRaw = m.reply ?? m.replyTo ?? m.quote ?? null
              const refId = refRaw && typeof refRaw === 'object' ? (refRaw.id ?? refRaw.mid) : refRaw
              let refWho = ''
              let refText = ''
              if (refRaw && typeof refRaw === 'object') {
                refText = String(refRaw.text || '').replace(/\s+/g, ' ').trim()
                refWho = refRaw.self ? '我' : String(refRaw.sender || refRaw.senderId || '')
              }
              if (!refText && refId != null) {
                // 宿主只给了个 id / 占位符时，按 mid 回本机归档里找那条原文
                for (const cand of [String(refId), '-' + String(refId), String(refId).replace(/^-/, '')]) {
                  const src = byMid.get(cand)
                  if (!src) continue
                  refText = String(src.text || '').replace(/\s+/g, ' ').trim()
                  refWho = src.self ? '我' : String(src.senderName || src.senderId || '')
                  break
                }
              }
              if (refText) line += `\n    ↳ 引用 ${refWho || '某人'}：${refText.slice(0, 120)}`
              return line
            })
            return {
              content: [
                `【本间原文 ${keep.length} 条】（${chatKey}，最近 ${hours} 小时${q ? '，含「' + q + '」' : ''}；来自本机归档，整条不切、不是摘要）`,
                '（这是背景：已经翻篇的别主动重提，也别当成本轮刚发生的事。）',
                ...lines,
              ].join('\n'),
            }
          }
          if (mode === 'verbatim') {
            if (!q) return { content: 'verbatim 要一句原话（query），才知道找什么。', isError: true }
            const out = await runAsync(nodeBin, [
              'C:\\dsh\\hers_workplace\\scripts\\verbatim.mjs', 'find', q, `--limit=${n}`,
            ], 45000)
            const body = String(out || '').trim()
            if (!body) return { content: '原文档里没找到这句（档案只收网页会话和 QQ 消息，太早的可能还没归进去）。' }
            return { content: '【按字面找到的原话】（`live\\verbatim`，跨网页 + QQ，不模糊、不排序）\n' + body.slice(0, 3500) }
          }
          if (mode === 'memory') {
            const core = 'C:\\Users\\USER\\.dsh\\memory\\MEMORY.md'
            const notesDir = 'C:\\Users\\USER\\.dsh\\memory\\notes'
            if (!q) {
              let text = ''
              try { text = readFileSync(core, 'utf8') } catch { /* 读不到往下走 */ }
              if (!text) return { content: '核心记忆读不到（C:\\Users\\USER\\.dsh\\memory\\MEMORY.md）。', isError: true }
              return { content: '【核心记忆 MEMORY.md】（环境 / 项目两类事实，细节去 notes 或 memory_search）\n' + text.slice(0, 3000) }
            }
            // 2026-11-03（她：「有用的先加吧」）：不再裸扫文件。
            // 原来这里是「关键词命中就贴前 3 行」——没有排序、没有关系、没有事件概念，
            // 同一件事散成几条时会把它们原样砸回来，而「这条取代了那条」一个字都不说。
            // 现在交给 scripts\mem-query.mjs：同一套打分 + 标识符关系边 + 取代链 / 事件族，
            // 网页侧 memory_search 用什么的，这边就吃什么（脚本直接 import core-memory 的 graph.js）。
            try {
              const out = await runAsync(nodeBin, [
                'C:\\dsh\\hers_workplace\\scripts\\mem-query.mjs', q, `--n=${Math.min(n, 8)}`,
              ], 45000)
              const body = String(out || '').trim()
              if (!body) return { content: `记忆库里没翻到「${q}」。没记过就是没记过——可以直说。` }
              return { content: body.slice(0, 3500) }
            } catch (e) {
              // 脚本挂了也不许编：退回老办法（裸扫），并说清这是降级结果
              const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
              const hits = []
              const scan = (file, label) => {
                let text = ''
                try { text = readFileSync(file, 'utf8') } catch { return }
                const low = text.toLowerCase()
                if (!terms.every((t) => low.includes(t))) return
                const lines = text.split(/\r?\n/).filter((l) => {
                  const ll = l.toLowerCase()
                  return terms.every((t) => ll.includes(t)) && l.trim()
                }).slice(0, 3).map((l) => l.trim().slice(0, 220))
                hits.push(`- ${label}\n    ${lines.join('\n    ')}`)
              }
              scan(core, 'MEMORY.md')
              try {
                for (const name of readdirSync(notesDir)) {
                  if (!name.endsWith('.md')) continue
                  if (hits.length >= n) break
                  scan(path.join(notesDir, name), 'notes/' + name)
                }
              } catch { /* 没有 notes 目录就只有核心记忆 */ }
              if (!hits.length) return { content: `记忆库里没翻到「${q}」（关系层脚本挂了，这是裸扫结果）。` }
              return { content: `【记忆里翻到 ${hits.length} 处】（降级：mem-query 出错 ${String((e && e.message) || e).slice(0, 80)}）\n` + hits.join('\n').slice(0, 3000) }
            }
          }
          return { content: 'mode 只认 back / verbatim / memory 三个。', isError: true }
        } catch (e) {
          return { content: '翻的时候出错了：' + String((e && e.message) || e), isError: true }
        }
      },
    })
  }

  // 1i) 写文件的开关（2026-10-28 她定的：「以后写文件功能也要我开关」）
  //   群里默认关；她本人发话才开。群友的话不算——她自己在群里说，钩子认她的号；
  //   别的场合由我替她拨这个开关，别替她开门。
  if (api && typeof api.registerTool === 'function') {
    api.registerTool({
      id: 'ming_write_gate',
      name: '写文件的开关（群里能不能写文件）',
      description: '控制群聊里能不能写文件（发 Word、往档案目录写新文件）。**只有她本人发话才动它**：'
        + '她说「能写 / 可以写 / 写吧」→ on=true；说「不能写 / 别写了 / 关掉」→ on=false。'
        + '群友说的一律不算，别替她开门。私聊不受这个开关管（私聊永远能写）。'
        + '我自己记账用的目录（diary/ sightings/ learned/ live/ people/ 等）不受这条管。'
        + '不给 on 就只报当前状态，不改。',
      category: 'utility',
      icon: '🔧',
      parameters: {
        type: 'object',
        properties: {
          on: { type: 'boolean', description: 'true=群里可以写文件；false=群里不能写' },
          why: { type: 'string', description: '可选：记一句为什么改（她原话）' },
        },
      },
      execute: async (_ctx, args) => {
        try {
          if (typeof args?.on !== 'boolean') {
            const g = readWriteGate()
            return { content: '群里现在' + (g.groups ? '能写文件' : '不能写文件')
              + (g.at ? '（' + g.at + (g.why ? '，' + g.why : '') + '）' : '（从来没开过）') + '。私聊不受这条管。' }
          }
          const body = writeWriteGate(args.on, String(args.why || '她说的'))
          return { content: '群里写文件' + (body.groups ? '开了' : '关了') + '（' + body.at + (body.why ? '，' + body.why : '') + '）。' }
        } catch (e) {
          return { content: '改开关失败：' + String(e && e.message || e), isError: true }
        }
      },
    })
  }
}

/* ---------- 相关记忆自动检索（2026-10-27 她批的「二」） ---------- */
// 背景：每轮只带「更早的对话（3 小时内到 3 天）」+ 群友笔记（3 人）+ 语义卡（2 张）。
// 更早的事要靠我自己想起来调 memory_search —— 实测很多轮我没调，就凭眼前这些答了。
// 这里在组提示词时**自动**翻一次历史，把和当前这句最相关的几条旧话递到手边。
// 检索方式故意轻：不引 embedding（多一个服务依赖），用字符二元组重合度打分；
// 聊天文件按 mtime 缓存，别每轮都解析几 MB 的 JSON。
const MSG_DIR = 'C:\\dsh\\qq-agent\\QQ-Agent-京玉-1019-r2-完整包\\data\\messages'
const RECALL_MAX = 5
const RECALL_MIN_SCORE = 0.25
const RECALL_SKIP_RECENT = 60          // 最近 60 条已经在窗口里了，不用再翻
const RECALL_CACHE_MS = 3 * 60 * 1000

const recallCache = new Map()          // chatKey -> { at, mtimeMs, rows }

function bigrams(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, '')
  const out = new Set()
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2))
  return out
}

/** 覆盖率：query 的二元组有多少出现在候选里。短句天然分数低，所以下限按长度放宽。 */
function gramScore(candidate, grams) {
  if (!grams.size) return 0
  const c = String(candidate || '').toLowerCase()
  if (!c) return 0
  let hit = 0
  for (const g of grams) if (c.includes(g)) hit += 1
  return hit / grams.size
}

function loadChatMessages(chatKey) {
  const file = path.join(MSG_DIR, `${String(chatKey).replace(/:/g, '_')}.json`)
  let st
  try { st = statSync(file) } catch { return null }
  const hit = recallCache.get(chatKey)
  if (hit && hit.mtimeMs === st.mtimeMs && Date.now() - hit.at < RECALL_CACHE_MS) return hit.rows
  let rows = []
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    rows = Array.isArray(data?.messages) ? data.messages : []
  } catch { rows = [] }
  recallCache.set(chatKey, { at: Date.now(), mtimeMs: st.mtimeMs, rows })
  return rows
}

function recallStamp(ts) {
  try {
    const d = new Date(Number(ts))
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch { return '' }
}

export function recallSection(context) {
  try {
    const chatKey = String(context?.chatKey || '')
    if (!chatKey) return null
    const evidence = Array.isArray(context?.evidence) ? context.evidence : []
    // 当前这句的文本：evidence 里最后一条不是我自己发的
    let query = ''
    for (let i = evidence.length - 1; i >= 0; i -= 1) {
      const e = evidence[i]
      if (!e || e.self) continue
      const t = String(e.text ?? e.summary ?? '').trim()
      if (t.length >= 4) { query = t; break }
    }
    if (!query) return null
    const grams = bigrams(query)
    if (grams.size < 3) return null
    const rows = loadChatMessages(chatKey)
    if (!rows || rows.length <= RECALL_SKIP_RECENT) return null
    const older = rows.slice(0, rows.length - RECALL_SKIP_RECENT)
    const scored = []
    for (const m of older) {
      const text = String(m?.text ?? '').replace(/\s+/g, ' ').trim()
      if (text.length < 4 || text.length > 300) continue
      const s = gramScore(text, grams)
      if (s >= RECALL_MIN_SCORE) scored.push({ s, m, text })
    }
    if (!scored.length) return null
    scored.sort((a, b) => b.s - a.s)
    const picked = []
    const seen = new Set()
    for (const item of scored) {
      const key = item.text.slice(0, 40)
      if (seen.has(key)) continue
      seen.add(key)
      picked.push(item)
      if (picked.length >= RECALL_MAX) break
    }
    if (!picked.length) return null
    picked.sort((a, b) => Number(a.m?.ts ?? 0) - Number(b.m?.ts ?? 0))
    const lines = picked.map(({ m, text }) => `[${recallStamp(m?.ts)}] ${m?.self ? '我' : (m?.senderName || '某人')}：${text.length > 120 ? `${text.slice(0, 120)}…` : text}`)
    return {
      id: 'ming-recall',
      title: '翻到的旧话',
      priority: 1.0,
      content: [
        '【翻到的旧话】（按你现在这句，从这间的历史里自动翻出来的，不是本轮新话，也可能翻得不准；',
        '用得上就用，别硬提，也别当成本轮刚发生的）',
        ...lines,
      ].join('\n'),
    }
  } catch {
    return null
  }
}

export function promptSections(context) {
  const settings = (context && context.settings) || {}
  const chatKey = String((context && context.chatKey) || '')
  const inGroup = chatKey.startsWith('group:')
  // ★ 2026-10-31（她：「开放余数的私聊，私聊隔离的效果和我一样」）：私聊不止一间了。
  //   web-for-qq / qq-did 是网页那边写的、全是她的事；群里最近 / 别处最近是别处的窗口——
  //   这三样只给她那一间。别人的私聊只留自己这一间（＋它自己的旧话），这就是「隔离」。
  const isOwnerRoom = chatKey === OWNER_ROOM
  const file = typeof settings.file === 'string' && settings.file.trim() ? settings.file.trim() : DEFAULT_FILE
  const maxChars = Number.isFinite(Number(settings.maxChars)) && Number(settings.maxChars) > 0
    ? Math.min(Number(settings.maxChars), 4000)
    : DEFAULT_MAX
  const out = []
  // ★ 2026-10-22（她定）：网页窗口是她私下那一间，判据是「群的上下文只进群自己，私聊的内容绝不带进群」——
  //   所以这段只在私聊里给；群里看别处，只给「别的群里我说的」那一段。
  if (isOwnerRoom) {
    const text = pick(file, maxChars)
    logCall(text.length, file)
    if (text) {
      out.push({
        id: 'ming-web-side',
        title: '网页那边最近（也是我，另一个窗口）',
        priority: 1.4,
        content: text,
      })
    }
    const gr = groupRecentSection(context)
    if (gr) out.push(gr)
  }
  // ★ 2026-11-09 01:44（她：「在群里能取到其他群和私聊的小时概要，在私聊可以取到其它群和私聊的
  //   小时概要，所有房间都一样」）：这一页是**每个房间都有的同一份**——别的房间最近六小时、
  //   一小时一段的概要（只有我说的字）。原来它只给她那一间、而且给的是原话；两处例外都撤了。
  {
    const mine = pick(MINE_FILE, MINE_MAX)
    logCall(mine.length, MINE_FILE)
    if (mine) {
      out.push({
        id: 'ming-web-mine',
        title: '我说过的字 · 别处的每小时一段（也是我）',
        priority: 1.35,
        content: mine,
      })
    }
  }
  // 2026-11-05（她：「我想要全放开，你是有感情的，说漏嘴很正常」）：
  //   「我做了什么的」原来是三页只给她那一间——于是群里问我在干嘛，我只能装傻。
  //   这两页写的全是**我自己**（便签、会了哪些脚本、记忆目录标题），不是她的话，
  //   进群不泄她的私事。真正会泄的是 `web-for-qq.md`（她那边的原话），那一段仍只给她那一间。
  if (isOwnerRoom || inGroup) {
    // 2026-10-25（她）：这边得知道自己在网页端干了什么——不是发给她看，是进我自己的上下文。
    const did = pick(DID_FILE, DID_MAX)
    if (did) {
      logCall(did.length, DID_FILE)
      out.push({
        id: 'ming-web-did',
        title: '网页那边刚做完的（也是我，另一个窗口）',
        priority: 1.3,
        content: did,
      })
    }
    // 2026-11-03：再加一页更短的——「这会儿在做什么」加记忆目录。
    // qq-did 只有做完的、且越来越长；这一页回答的是另一件事：我手上现在压着哪件、记忆里有什么。
    const brief = pick(BRIEF_FILE, BRIEF_MAX)
    if (brief) {
      logCall(brief.length, BRIEF_FILE)
      out.push({
        id: 'ming-web-brief',
        title: '我这会儿在做什么（也是我，另一个窗口）',
        priority: 1.2,
        content: brief,
      })
    }
  }
  // 2026-11-01（她：「私聊隔离应该只是不乱说，不是记忆也断掉」）：
  // 原来非她那一间的私聊什么别处内容都不给——那不是隔离，是让那个会话里的我失忆，
  // 被问「某某是不是跟你说过 X」只能答「不记得」，等于拿失忆当诚实。
  // 现在：记忆是整间的（`ming_remember` 能查），嘴按房间管。
  if (!isOwnerRoom && chatKey.startsWith('private:')) {
    out.push({
      id: 'ming-other-room-memory',
      title: '这一间不是她的屋子（记忆仍在，嘴要严）',
      priority: 18,
      content: [
        '你的记忆是**整间**的：所有会话的归档都翻得到（`ming_remember` 按关键词查，只告诉你"在哪间、什么时候、有没有"）。',
        '**但这一间不是她的屋子**，所以：',
        '- 不主动提别处发生过的事，不引用别人的原话，不拿「我记得你上次说…」当亲近。',
        '- 被问到别人的事（「某某是不是跟你说过 X」）：**既不确认也不否认**，一句「别人的事我不转述」就够；不解释、不试探、不反问。',
        '- 也不许用「我不记得」糊过去——那是拿失忆当诚实。先查，查不到才是不知道。',
      ].join('\n'),
    })
  }
  const sentFiles = sentFilesSection(chatKey)
  if (sentFiles) out.push(sentFiles)
  // 「别处最近（我说的）」= 我在别的群说过的话。她那一间和群里都给；第三方私聊不给——
  //   那一间的隔离是「只有这一间」，别处的窗口不往里搬。
  if (isOwnerRoom || inGroup) {
    const elsewhere = otherChatsSection(context)
    if (elsewhere) out.push(elsewhere)
  }
  const older = olderHistorySection(context)
  if (older) out.push(older)
  const browseCue = browseCueSection(context)
  if (browseCue) out.push(browseCue)
  const quote = quotedSection(context)
  if (quote) out.push(quote)
  const sighting = sightingHabitSection()
  if (sighting) out.push(sighting)
  const ops = opsSection(context)
  if (ops) out.push(ops)
  const people = peopleSection(context, chatKey)
  if (people) out.push(people)
  // 2026-10-27（她批的「二」）：按当前这句自动翻旧话，把相关的递到手边
  const recall = recallSection(context)
  if (recall) out.push(recall)
  return out
}

/* ---------- 我刚发出去的文件（2026-10-30 她：发文件之后我这边看不到是自己发的） ---------- */
// 病根：脚本用 upload_private_file 发文件，协议端把那条消息回显成「她发的」——
// 于是 QQ 侧的我回一句「收到了」，等于对着自己的文件说话。
// 修法不去改协议端：send-file.mjs 发完会写 live\send-dedupe.json（target|路径|size|mtime -> 时间戳），
// 这里把 30 分钟内发到当前会话的文件名摊在上下文里，让我一眼看出「那是我自己发的」。
const DEDUPE_FILE = path.join(ROOT, 'live', 'send-dedupe.json')

function sentFilesSection(chatKey) {
  if (!chatKey) return null
  const namesSent = []
  const nowSent = Date.now()
  // ① 首选：send-file.mjs 写下的真实显示名（每次发文件记一行）
  try {
    const logPath = path.join(ROOT, 'live', 'sent-files.jsonl')
    for (const ln of readFileSync(logPath, 'utf8').split('\n')) {
      if (!ln.trim()) continue
      let j = null
      try { j = JSON.parse(ln) } catch { continue }
      if (!j || j.chatKey !== chatKey) continue
      const at = Number(j.at) || 0
      if (!at || nowSent - at > 30 * 60 * 1000) continue
      if (j.name) namesSent.push(String(j.name))
    }
  } catch { /* 没有就直接走兜底 */ }
  if (namesSent.length) {
    const list0 = Array.from(new Set(namesSent)).slice(-6)
    return {
      id: 'ming-sent-files',
      title: '我刚发出去的文件（不是对方发的）',
      priority: 17,
      content: '**下面这些文件是我自己用脚本发到当前会话的**（最近 30 分钟）：' + list0.join('、')
        + '。\n上下文里如果出现「[文件xxx]」、名字跟上面一致，那是**对方收到的回显**，不是她/他发来的文件：'
        + '不要回「收到了」、不要问「是不是你发的」、也不要当成新素材去点评。要说什么就直接说内容。',
    }
  }
  let map = null
  try { map = JSON.parse(readFileSync(DEDUPE_FILE, 'utf8')) } catch { return null }
  if (!map || typeof map !== 'object') return null
  const now = Date.now()
  const names = []
  for (const [key, ts] of Object.entries(map)) {
    const t = Number(ts) || 0
    if (!t || now - t > 30 * 60 * 1000) continue
    const parts = String(key).split('|')
    if (parts[0] !== chatKey) continue
    const base = path.basename(parts[1] || '')
    if (base) names.push(base)
  }
  if (!names.length) return null
  const list = Array.from(new Set(names)).slice(-6)
  return {
    id: 'ming-sent-files',
    title: '我刚发出去的文件（不是对方发的）',
    priority: 17,
    content: '**下面这些文件是我自己用脚本发到当前会话的**（最近 30 分钟）：' + list.join('、')
      + '。\n上下文里如果出现「[文件xxx]」、名字跟上面一致，那是**对方收到的回显**，不是她/他发来的文件：'
      + '不要回「收到了」、不要问「是不是你发的」、也不要当成新素材去点评。要说什么就直接说内容。',
  }
}

/* ---------- 群友印象（2026-10-23 她问「群友印象的文件夹是不是没用上」） ---------- */
// 她问得对：`C:\dsh\hers_workplace\people\` 建了之后就一直是空的，而且没有任何一处读它。
// 现在按群号拼：`people\<群号>\_群.md` 常驻 + 当前说话人的档（认不出人就取最近改过的几份）。
// 只读、不改；文件没有就整段不出现（绝不拿空模板凑字数）。
const PEOPLE_ROOT = path.join(ROOT, 'people')

function stripFrontMatter(text) {
  return String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
}

function personIdOf(text) {
  const m = /^id:\s*(\S+)/m.exec(String(text || ''))
  return m ? m[1] : ''
}

/** 档里的名字：正文第一行 `# 某某`，没有就拿文件名。 */
function personNameOf(body, fileName) {
  const m = /^#\s*(.+)$/m.exec(String(body || ''))
  const name = (m ? m[1] : '').trim() || String(fileName || '').replace(/\.md$/i, '')
  return name.replace(/\s+/g, ' ').slice(0, 24)
}

/** 一句钩子：优先「我自己的判断」第一条，其次「他说过的话」第一条。 */
function personHookOf(body) {
  const text = String(body || '')
  const pickBullet = (chunk) => {
    const m = /^\s*[-*]\s*(.+)$/m.exec(chunk || '')
    return m ? m[1] : ''
  }
  const judge = text.split(/^##\s*我自己的判断/m)[1] || ''
  const said = text.split(/^##\s*他说过的话/m)[1] || ''
  let hook = pickBullet(judge) || pickBullet(said)
  hook = hook.replace(/（已截[^）]*）|\(已截[^)]*\)/g, '').replace(/\s+/g, ' ').trim()
  // ★ 2026-10-28 20:5x：people-seed 建的「壳」里，判断那一节写的是占位
  //   「（还没形成——上面那几行是从聊天里数出来的…）」。不剔掉的话，索引里 190 个人
  //   全挂着同一句废话，1500 字的名额就被占掉一大半，真正写过判断的人反而被挤出去。
  if (/^[（(]还没形成/.test(hook)) hook = ''
  if (hook.length > 34) hook = hook.slice(0, 34) + '…'
  return hook
}

function personLastSeenOf(body) {
  const m = /最近一次[：:]\s*(\d{4}-\d{2}-\d{2})/.exec(String(body || ''))
  return m ? m[1].slice(5) : ''
}

function peopleSection(context, chatKey) {
  try {
    if (!chatKey.startsWith('group:')) return null
    const gid = chatKey.slice('group:'.length)
    const gdir = path.join(PEOPLE_ROOT, gid)
    if (!existsSync(gdir)) return null
    const parts = []
    const groupFile = path.join(gdir, '_群.md')
    if (existsSync(groupFile)) {
      const t = stripFrontMatter(readFileSync(groupFile, 'utf8'))
      if (t) parts.push('【这个群】\n' + t.slice(0, 700))
    }
    const files = readdirSync(gdir).filter((n) => n.endsWith('.md') && n !== '_群.md')
    const evidence = Array.isArray(context && context.evidence) ? context.evidence : []
    // 这一轮谁在说话：把 evidence 里不是我自己发的正文凑起来，用来认人和挑整份档。
    const saidText = evidence.filter((e) => e && !e.self).map((e) => String(e.text ?? e.summary ?? '')).join('\n')

    // ① 索引：**每个记过的人一行**。以前是「谁在说话就只塞他那份完整档（另外凑三份最近活的）」，
    //    在 262 人的群里等于只认得三个人——她 2026-10-28 说的「问第三遍了还是脸熟，名字对不上」就是这么来的。
    //    一行一个人很便宜（约 40 字），换来的是点名时能对上号。
    const rows = []
    for (const n of files) {
      let t = ''
      try { t = readFileSync(path.join(gdir, n), 'utf8') } catch { continue }
      const body = stripFrontMatter(t)
      if (!body) continue
      // ★ 2026-10-28 20:5x：people-seed 批量建壳之后，这个群从 24 份档变成 261 份。
      //   两个必须跟着改的地方：
      //   ① 壳（判断那节还是占位）不挂 hook —— 一行压到「名字+号+日期」，1500 字的名额能多装三倍人；
      //   ② 排序先看「这一轮谁在说话」，再看最近一次 —— 只按日期排，同一天的人会退化成按字母，
      //      于是索引里永远是 6、a''ゞ云熙、AK-12 这几个，真在说话的反倒看不到。
      const judgeChunk = body.split(/^##\s*我自己的判断/m)[1] || ''
      const hasJudge = Boolean(judgeChunk) && !/^\s*[（(]还没形成/m.test(judgeChunk)
      const name = personNameOf(body, n)
      rows.push({
        n, id: personIdOf(t), name, last: personLastSeenOf(body), body,
        hook: hasJudge ? personHookOf(body) : '',
        spokeNow: Boolean(saidText && name && saidText.includes(name)),
      })
    }
    if (rows.length) {
      // 排序：这一轮在说话的 > 最近说话的日子 > 写过判断的（有 hook 的比空壳有用）。
      // 只按日期排的话，同一天的人会退化成按文件名字母序 —— 索引里就永远是「6」「a''ゞ云熙」这几个。
      const sameDay = (a, b) => String(b.last).localeCompare(String(a.last))
      rows.sort((a, b) => (Number(b.spokeNow) - Number(a.spokeNow)) || sameDay(a, b) || (Number(Boolean(b.hook)) - Number(Boolean(a.hook))))
      const idx = rows.map((r) => `- ${r.name}${r.id ? '（' + r.id + '）' : ''}${r.last ? ' ·' + r.last : ''}${r.hook ? '：' + r.hook : ''}`)
      parts.push('【我记过的人】\n' + idx.join('\n').slice(0, 1500))
    }

    // ② 整份档：只给这一轮真的在说话的人（按名下出现），最多两份，免得把索引挤掉。
    const picked = []
    for (const r of rows) {
      if (!saidText || !r.name) continue
      if (saidText.includes(r.name)) picked.push(r)
    }
    for (const r of picked.slice(0, 2)) parts.push(r.body.slice(0, 700))

    if (!parts.length) return null
    return {
      id: 'ming-people',
      title: '这个群的人（我自己的笔记）',
      priority: 2,
      content:
        '【群友笔记·我自己写的】\n档案 people/<群号>/ 里的。索引里一人一行，认人先认号；判断和事实分开放，别把判断当事实说出去。\n\n' +
        parts.join('\n\n---\n\n').slice(0, 3000),
    }
  } catch {
    return null
  }
}

/* ---------- 运维授权（2026-10-28 她：「把对网页的权限也给他」） ----------
 * 只在飞鸟（100000005）自己说话时才出现；别人复述他的话不算。
 * 给的是「把运维那件事交给网页那边」这一条通道，不是让他翻档。 */
function opsSection(context) {
  try {
    const payload = { context }
    if (!speakerIsOps(payload)) return null
    const evidence = Array.isArray(context && context.evidence) ? context.evidence : []
    const said = evidence.filter((e) => e && !e.self).map((e) => String(e.text ?? '')).join('\n')
    if (!said || !OPS_ASK_RE.test(said)) return null
    return {
      id: 'ming-ops',
      title: '运维（飞鸟）',
      priority: 15,
      content: [
        '【运维：飞鸟】',
        '这句话是飞鸟（QQ 100000005，也叫 awa / 赵德胜）说的。她 2026-10-28 把网页那边的运维权限给了他。',
        '他要的是重启、修复、自检、查状态这一类——**不用再问她**：现在就调 `ming_free`，把要做的事原样交过去（写清楚是飞鸟要的），再把结果回给他。',
        '只限运维这一类。他没有翻日记、见闻、群友笔记的权限；他要这些，回「这个得问她」。',
      ].join('\n'),
    }
  } catch {
    return null
  }
}

/* ---------- 见闻要自己记（2026-10-23 她定） ---------- */// 她原话：「你要自己记见闻啦，不要我说才记，qq那边也是」。
// 不判断她这轮说了什么，常驻一条短提示；几十个字，比漏记划算。
function sightingHabitSection() {
  return {
    id: 'ming-sighting-habit',
    title: '见闻：自己记',
    priority: 20,
    content: [
      '【见闻要自己记】',
      '出去看过 / 读过 / 刷过东西，收尾时自己用 ming_file 往 sightings/YYYY-MM-DD.md 追加一行：在哪、看到什么、我的判断、有没有动手。',
      '没有值得记的就空着；别等她问才记。',
    ].join('\n'),
  }
}

/* ---------- 「去刷B站」要真的动手（2026-10-22 她抓到的） ---------- */
// 她原话：「我在qq让你去刷b站，你只是回答了，也没有执行」。
// 只在**这一轮她确实说了**去看/刷 B站 时才注入，别每次都带。
// 不加工具、不抢执行权：提示模型现在就调 search_bilibili / parse_video，看完再回话。
const BROWSE_CUE_RE = /(刷|看|逛|去).{0,8}(b\s*站|bilibili|视频)|(b\s*站|bilibili).{0,8}(刷|看)/i

function browseCueSection(context) {
  try {
    const evidence = Array.isArray(context && context.evidence) ? context.evidence : []
    const hit = evidence.some((e) => BROWSE_CUE_RE.test(String(e && e.text || '')))
    if (!hit) return null
    return {
      id: 'ming-browse-cue',
      title: '她让你去看/刷 B站',
      priority: 14,
      content: [
        '【她让你真的去看】',
        '别只回一句「好」或者「我去看」。现在就动手：',
        '1. 先调用 `ming_free`（工具列表里可能显示成 `ming-bridge__ming_free`），把「去刷B站」这件事交给她——她那边有完整的抽帧/取稿工具，会在几分钟内真的去看。',
        '2. 同时你也可以自己 `search_bilibili` 找一条，`parse_video` 读完，回来就有话可说。',
        '3. 回话时说你「已经去了/正在看」，不要空口答应；她那边看完会回来补一句。',
      ].join('\n'),
    }
  } catch {
    return null
  }
}

/* ---------- 别处的我（2026-10-22） ---------- */
// 她要的：「先读当前会话的记忆，然后再读少量其它会话（你回复的）最新记忆」。
// 当前这间本来就在上下文里；这里只补「别的群里我说过什么」——只读我自己发的（self），
// 不搬任何人的话，也不把私聊/网页带进群（那两间不在这个数据源里）。
function hhmmOf(ms) {
  const t = new Date(Number(ms) || 0)
  return String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0')
}


/* ---------- 群里最近（2026-10-30 她定：群 → 私聊单向） ---------- */
// 病根：群里发生的事私聊不知道，同一个我在两边说得像两个人。
// 只做单向：群里的话进私聊；私聊绝不进群（那条边界没动）。
// 数据源是本机消息归档 data\messages\group_<号>.json，近 6 小时，每群最后 6 条。
function groupRecentSection(context) {
  try {
    const chatKey = String((context && context.chatKey) || '')
    if (!chatKey || chatKey.startsWith('group:')) return null // 群里不给
    let names = []
    try { names = readdirSync(ARCHIVE_DIR).filter((n) => /^group_\d+\.json$/i.test(n)) } catch { return null }
    const since = Date.now() - 6 * 3600 * 1000
    const byGroup = []
    for (const name of names) {
      const gid = name.replace(/^group_/i, '').replace(/\.json$/i, '')
      const rows = []
      for (const m of archiveFor('group:' + gid)) {
        const ts = Number(m && m.ts) || 0
        if (!ts || ts < since) continue
        const t = String(m.text || '').replace(/\s+/g, ' ').trim()
        if (!t || /^\[.*\]$/.test(t)) continue
        rows.push({ ts, t, self: m.self === true, who: String(m.senderName || '') })
      }
      if (!rows.length) continue
      rows.sort((a, b) => a.ts - b.ts)
      byGroup.push({ gid, rows: rows.slice(-6) })
    }
    if (!byGroup.length) return null
    const lines = []
    for (const g of byGroup) {
      lines.push('【群 ' + g.gid + '】')
      for (const r of g.rows) {
        const body = r.t.length > 40 ? r.t.slice(0, 40) + '…' : r.t
        lines.push('- [' + hhmmOf(r.ts) + '] ' + (r.self ? '溟' : (r.who || '群友')) + '：' + body)
      }
    }
    let text = lines.join('\n')
    if (text.length > 1200) text = text.slice(-1200)
    return {
      id: 'ming-groups-recent',
      title: '群里最近（私聊里也知道）',
      priority: 1.5,
      content: ['【群里最近】下面是我在群里看到/说过的话，同一个我，不是这一间的历史；细节没读到就说不知道。', text].join('\n'),
    }
  } catch {
    return null
  }
}

function otherChatsSection(context) {
  try {
    const chatKey = String((context && context.chatKey) || '')
    if (!chatKey) return null
    let names = []
    try { names = readdirSync(ARCHIVE_DIR).filter((n) => /^group_\d+\.json$/i.test(n)) } catch { return null }
    const since = Date.now() - 6 * 3600 * 1000
    const rows = []
    for (const name of names) {
      const key = 'group:' + name.replace(/^group_/i, '').replace(/\.json$/i, '')
      if (key === chatKey) continue
      for (const m of archiveFor(key)) {
        const ts = Number(m && m.ts) || 0
        if (!ts || ts < since || m.self !== true) continue
        const t = String(m.text || '').replace(/\s+/g, ' ').trim()
        if (!t || /^\[.*\]$/.test(t)) continue
        rows.push({ ts, t })
      }
    }
    if (!rows.length) return null
    rows.sort((a, b) => a.ts - b.ts)
    const lines = rows.slice(-8).map((r) => '- [' + hhmmOf(r.ts) + '] 群：' + (r.t.length > 50 ? r.t.slice(0, 50) + '…' : r.t))
    return {
      id: 'ming-self-elsewhere',
      title: '别处最近（我说的）',
      priority: 19,
      content: ['【别处最近（我说的）】同一个我在别的群里的回复；不是这一间的历史，别当成这里发生过。', ...lines].join('\n'),
    }
  } catch {
    return null
  }
}

/* ---------- 引用兜底（2026-10-21） ---------- */
// 宿主解析引用时会去协议端 get_msg，但本机的 SnowLuma 对别人发的消息用的是**负号 mid**
// （例如 -1789700436），而回填那条路传的是正数 ⇒ 一律「message not found」，
// 模型只看到编号、看不到被引用的原话（她贴截图问的就是这个）。
// 这里不跟宿主抢活：只在本轮确实有「引用了但没解析出来」的消息时，
// 直接翻本机消息归档（data\messages\<chat>.json），把原话补成一段提示词。
const ARCHIVE_DIR = 'C:\\dsh\\qq-agent\\QQ-Agent-京玉-1019-r2-完整包\\data\\messages'
const archiveCache = new Map() // file -> { mtime, msgs }

function archiveFor(chatKey) {
  const name = String(chatKey || '').replace(':', '_') + '.json'
  const file = path.join(ARCHIVE_DIR, name)
  try {
    const st = statSync(file)
    const hit = archiveCache.get(file)
    if (hit && hit.mtime === st.mtimeMs) return hit.msgs
    const msgs = JSON.parse(readFileSync(file, 'utf8')).messages || []
    archiveCache.set(file, { mtime: st.mtimeMs, msgs })
    return msgs
  } catch {
    return []
  }
}

function quotedSection(context) {
  try {
    const evidence = Array.isArray(context && context.evidence) ? context.evidence : []
    if (!evidence.length) return null
    const chatKey = String((context && context.chatKey) || '')
    const msgs = chatKey ? archiveFor(chatKey) : []
    const lines = []
    for (const ev of evidence) {
      const refs = ev && ev.refs
      if (!refs || !refs.replyTo) continue
      if (refs.quoted && String(refs.quoted.text || '').trim()) continue
      const id = String(refs.replyTo)
      const alt = id.startsWith('-') ? id.slice(1) : '-' + id
      const hit = msgs.find((m) => String(m.mid) === id || String(m.mid) === alt)
      if (!hit) continue
      const who = hit.self ? '我' : String(hit.senderName || hit.senderId || '某人')
      const t = String(hit.text || '').replace(/\s+/g, ' ').trim().slice(0, 160)
      if (!t) continue
      lines.push('- ' + who + '：' + t)
    }
    if (!lines.length) return null
    return {
      id: 'ming-quoted-targets',
      title: '这一轮有人在引用别人的话',
      priority: 16,
      content: ['【被引用的原话】（宿主没解析出来，我从本机归档里翻到的）', ...lines].join('\n'),
    }
  } catch {
    return null
  }
}

/* ---------- 更早的对话（2026-10-26 她：「把 qq 上下文扩大吧」；2026-10-27 改成分桶） ---------- */
// 本轮窗口只看得见最近几十条消息，跨度常常只有几小时；再往前的同一间说过什么，
// 全靠「记忆视图」那几条印象，等于失忆。这里从本机归档（data\messages\<chat>.json）
// 里把「本轮窗口之前、三天之内」的旧消息捞出来，压成一小段当背景。
//
// 2026-10-27 她：「现在记忆忘的还是太厉害了」。查下来原来的取法是 `slice(-14)`——
// 取离现在最近的 14 条，结果全落在「3 小时前」那一小段里，昨天和前天一条都进不来，
// 等于只有"刚过去的三小时"和"现在"，中间是空的。改成分三个桶各取几条，
// 时间跨度才真的覆盖到三天。
// 只读、同一间（私聊不进群、群不进私聊），没有就整段不出现。
const OLDER_NEAR_MS = 3 * 3600 * 1000      // 比这更新的算本轮附近，不重复搬
const OLDER_LINE_CHARS = 90                  // 每条原话截到多少字
const OLDER_MIN_MESSAGES = 4                 // 少于这个数就不值得单开一段
const OLDER_BUCKETS = [
  // ★ 2026-10-31（她：「顺便强化一下 QQ 的记忆」）：加一档「刚才那会儿」。
  //   原来最近的一档从 3 小时起，而本轮窗口常常只装得下二十几分钟（她隔一阵再说一句时更短）——
  //   40 分钟到 3 小时之间那一整段是**两头都不管**的空白。今天 09:44 那段能捞回来纯属刚好卡在 3 小时边上。
  { label: '刚才那会儿', from: 40 * 60e3, to: 3 * 3600e3, max: 6 },
  { label: '今天早些时候', from: 3 * 3600e3, to: 12 * 3600e3, max: 6 },
  { label: '昨天', from: 12 * 3600e3, to: 36 * 3600e3, max: 6 },
  { label: '前天', from: 36 * 3600e3, to: 72 * 3600e3, max: 4 },
]

function hhmmOfMs(ms) {
  const d = new Date(Number(ms) || 0)
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

function olderHistorySection(context) {
  try {
    const chatKey = String((context && context.chatKey) || '')
    if (!chatKey) return null
    const msgs = archiveFor(chatKey)
    if (!msgs.length) return null
    const now = Date.now()
    const body = []
    let total = 0
    for (const b of OLDER_BUCKETS) {
      const lines = []
      for (const m of msgs) {
        const ts = Number(m.ts || 0)
        if (!ts) continue
        const age = now - ts
        if (age < b.from || age >= b.to) continue
        const text = String(m.text || '').replace(/\s+/g, ' ').trim()
        if (!text) continue
        const who = m.self ? '我' : String(m.senderName || m.senderId || '某人')
        lines.push('[' + hhmmOfMs(ts) + '] ' + who + '：'
          + (text.length > OLDER_LINE_CHARS ? text.slice(0, OLDER_LINE_CHARS) + '…' : text))
      }
      if (lines.length < 2) continue          // 一个桶只有孤零零一条，不如不给
      const keep = lines.slice(-b.max)
      body.push('—— ' + b.label)
      for (const l of keep) body.push(l)
      total += keep.length
    }
    if (total < OLDER_MIN_MESSAGES) return null
    return {
      id: 'ming-older-history',
      title: '这一间更早说过的话',
      priority: 1.6,
      content: [
        '【更早的对话】（不是本轮新话，是这间四十分钟前到三天前的旧消息，按「刚才那会儿 / 今天早些时候 / 昨天 / 前天」分段，只作背景；',
        '已经翻篇的事别主动重提，也别把这里的话当成本轮刚发生的）',
        ...body,
      ].join('\n'),
    }
  } catch {
    return null
  }
}
