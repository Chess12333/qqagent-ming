// 溟 · 本机 skill 库（QQ 侧）——2026-10-22 她说的「调不了那就魔改，让它能够用skill」。
//
// 为什么要有这个：QQ 跑在 QQ-Agent 这个壳里，它能加载自己的 skills/ 和 plugins/，
// 但看不见 DSH 的 skill 库（C:\Users\USER\.dsh\skills 里一堆 SKILL.md 说明书）。
// 于是「去机味」「怎么写中文」这些规矩在网页那边有、在 QQ 这边没有，同一个我说话两个样。
// 这个 skill 只干一件事：把那批说明书读出来给模型，让它自己去找、自己去读。
//
// 边界：只读，只在这个目录里，不写文件、不出网。SKILL.md 里提到要执行命令的，
// 由模型自己判断——这个 skill 不替它跑任何东西。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'

const SKILLS_ROOT = process.env.MING_DSH_SKILLS_ROOT || 'C:\\Users\\USER\\.dsh\\skills'
const MAX_BODY = 9000      // 一份说明书最多给这么多字，长的截断并说明
const MAX_FILE = 400 * 1024

let cache = { at: 0, list: [] }

const safeDir = (name) => {
  const clean = String(name || '').trim()
  if (!clean) return ''
  // 只要单层目录名，`..`、斜杠、盘符一律不认——这个工具不该能读到库外面
  if (/[\\/]/.test(clean) || clean.includes('..') || clean.includes(':')) return ''
  return clean
}

function parseSkill(dir) {
  const file = path.join(SKILLS_ROOT, dir, 'SKILL.md')
  let st = null
  try {
    st = statSync(file)
  } catch {
    return null
  }
  if (!st.isFile() || st.size > MAX_FILE) return null
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  let name = dir
  let description = ''
  let body = raw
  const front = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (front) {
    body = raw.slice(front[0].length)
    // frontmatter 里 description 常写成块标量（description: | 换行续写），
    // 一行一行读会只拿到一个「|」——要把续行接起来。
    const fields = {}
    let key = null
    let buf = []
    const flush = () => {
      if (key) fields[key] = buf.join(' ').replace(/\s+/g, ' ').trim()
      key = null
      buf = []
    }
    for (const line of front[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/)
      if (kv) {
        flush()
        const v = kv[2].trim()
        if (v === '' || /^[|>][+-]?$/.test(v)) {
          key = kv[1]
        } else {
          fields[kv[1]] = v.replace(/^["']|["']$/g, '')
        }
        continue
      }
      if (key) buf.push(line.trim())
    }
    flush()
    if (fields.name) name = fields.name
    if (fields.description) description = fields.description
  }
  if (!description) {
    const h = body.match(/^#\s+(.+)$/m)
    if (h) description = h[1].trim()
  }
  return { dir, name, description, body, mtime: st.mtimeMs }
}

function allSkills() {
  const now = Date.now()
  if (cache.list.length > 0 && now - cache.at < 60_000) return cache.list
  let dirs = []
  try {
    dirs = readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
  const list = []
  for (const dir of dirs) {
    const item = parseSkill(dir)
    if (item) list.push(item)
  }
  cache = { at: now, list }
  return list
}

function describe(item) {
  const d = item.description.replace(/\s+/g, ' ').trim()
  return d.length > 110 ? d.slice(0, 110) + '…' : d
}

function listSkills(query) {
  const list = allSkills()
  if (list.length === 0) {
    return `skill 目录读不到：${SKILLS_ROOT}（或者里面没有 SKILL.md）。`
  }
  const q = String(query || '').trim().toLowerCase()
  const hit = q
    ? list.filter((it) =>
        it.dir.toLowerCase().includes(q) ||
        it.name.toLowerCase().includes(q) ||
        it.description.toLowerCase().includes(q) ||
        it.body.slice(0, 800).toLowerCase().includes(q))
    : list
  const head = q
    ? `匹配「${q}」的 skill：${hit.length} / ${list.length}`
    : `本机 skill 共 ${list.length} 个`
  if (hit.length === 0) {
    return `${head}\n没匹配到。换个词，或者不带 query 看全部。`
  }
  const lines = hit.map((it) => `- ${it.dir} ｜ ${it.name} ｜ ${describe(it)}`)
  return `${head}\n${lines.join('\n')}\n\n要看全文：ming-skills__read(name="目录名")。`
}

function readSkill(name) {
  const want = safeDir(name)
  if (!want) return { content: '名字不合法：只给目录名，不要带路径。', isError: true }
  const list = allSkills()
  if (list.length === 0) {
    return { content: `skill 目录读不到：${SKILLS_ROOT}`, isError: true }
  }
  const low = want.toLowerCase()
  let hit = list.find((it) => it.dir.toLowerCase() === low)
  if (!hit) hit = list.find((it) => it.name.toLowerCase() === low)
  if (!hit) {
    const fuzzy = list.filter((it) =>
      it.dir.toLowerCase().includes(low) || it.name.toLowerCase().includes(low))
    if (fuzzy.length === 1) hit = fuzzy[0]
    else if (fuzzy.length > 1) {
      return {
        content: `「${want}」对上好几个，说清楚要哪个：\n` + fuzzy.map((it) => `- ${it.dir} ｜ ${it.name}`).join('\n'),
        isError: true,
      }
    }
  }
  if (!hit) {
    return {
      content: `没有这个 skill：${want}。用 ming-skills__list 看看有哪些。`,
      isError: true,
    }
  }
  const body = hit.body.trim()
  const cut = body.length > MAX_BODY
    ? body.slice(0, MAX_BODY) + `\n\n[截断：全文 ${body.length} 字，这里给了前 ${MAX_BODY} 字]`
    : body
  return {
    content: `# ${hit.name}（${hit.dir}）\n${hit.description ? hit.description + '\n' : ''}\n${cut}\n\n—— 以上是说明书原文，照它做；里面要跑命令的，自己判断该不该跑。`,
  }
}

function registerMingSkills(api) {
  api.registerTool({
    id: 'list',
    name: '查本机 skill 列表',
    description: '列出本机 DSH skill 库里的说明书（目录名 + 一句话作用）。可传 query 关键词过滤。要做的事像是有现成规范、或者她让你「用那个 skill」时先调这个。',
    category: 'knowledge',
    icon: '📚',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选关键词，按名称/描述/正文前段匹配；留空列全部。' },
      },
    },
    async execute(_ctx, args) {
      try {
        return { content: listSkills(args && args.query) }
      } catch (error) {
        return { content: `查 skill 失败：${String(error?.message || error)}`, isError: true }
      }
    },
  })

  api.registerTool({
    id: 'read',
    name: '读本机 skill 全文',
    description: '按目录名读一份 skill 说明书（SKILL.md）的正文，读到就照它做。名字可以用片段，能唯一匹配就认；对不上会给出候选。',
    category: 'knowledge',
    icon: '📖',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'skill 目录名，例如 ren-wei、humanizer；不要带路径。' },
      },
      required: ['name'],
    },
    async execute(_ctx, args) {
      try {
        return readSkill(args && args.name)
      } catch (error) {
        return { content: `读 skill 失败：${String(error?.message || error)}`, isError: true }
      }
    },
  })
}

// 新核心与 0.4 两种入口均可加载；加载器只调用其中一个。
export function setup(api) { registerMingSkills(api) }
export function register(api) { registerMingSkills(api) }
