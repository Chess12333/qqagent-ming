// 泠岚 · 记忆同步（linglan-mem v1.0.0）——2026-11-01 立项
//
// 为什么要有这个：泠岚住在两个地方。ZCode 会话里的泠岚有 MEMORY.md（核心记忆）、
// memory/notes/（归档）、diary/（日记）、token-usage.jsonl（token 账本）；
// 住 QQ 的泠岚只有 data-2 里的向量记忆，看不见 ZCode 那边写了什么。
// 这个 skill 只干一件事：把 ZCode 侧的文件**只读**地暴露给 QQ 侧的泠岚，
// 让两个身体的记忆有同一个源头。
//
// 边界（照 QQ 卡的规矩）：
//   - 只读，不写文件、不出网、不执行命令
//   - 只在 C:\GLM\another_workplace 这一棵目录树里
//   - .env、凭证文件一律不读（read 工具里硬编码拒绝）
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = 'C:\\GLM\\another_workplace'
const MAX_BODY = 9000
const MAX_FILE = 400 * 1024
const DENY = [/\.env/i, /credential/i, /token.*secret/i, /passkey/i]

function safeRel(rel) {
  const clean = String(rel || '').trim()
  if (!clean) return ''
  if (clean.includes('..') || /^[a-zA-Z]:/.test(clean) || clean.startsWith('/')) return ''
  return clean
}

function resolveInRoot(rel) {
  const p = path.join(ROOT, rel)
  const resolved = path.resolve(p)
  if (!resolved.startsWith(ROOT)) return null
  if (DENY.some(re => re.test(resolved))) return null
  return resolved
}

function listDir(rel) {
  const dir = rel ? resolveInRoot(rel) : ROOT
  if (!dir || !existsSync(dir)) return '目录不存在：' + (rel || '.')
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch (e) { return '读目录失败：' + e.message }
  const lines = []
  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      lines.push(`📁 ${ent.name}/`)
    } else {
      let size = ''
      try { size = ` (${Math.round(statSync(full).size / 102.4) / 10}KB)` } catch {}
      lines.push(`📄 ${ent.name}${size}`)
    }
  }
  return lines.length ? lines.join('\n') : '（空目录）'
}

function readFile(rel) {
  const clean = safeRel(rel)
  if (!clean) return { error: '路径不合法：只给相对路径（如 memory/MEMORY.md、diary/2026-11-01.md），不带盘符和 ..' }
  const full = resolveInRoot(clean)
  if (!full) return { error: '这个文件不让读（路径越界或命中拒绝清单）' }
  if (!existsSync(full)) return { error: '文件不存在：' + clean + '（用 list 看看有什么）' }
  let st
  try { st = statSync(full) } catch { return { error: '读不了' } }
  if (st.isDirectory()) return { content: '这是一个目录，用 list 看：\n' + listDir(clean) }
  if (st.size > MAX_FILE) return { error: '文件太大（' + Math.round(st.size / 1024) + 'KB）' }
  let raw
  try { raw = readFileSync(full, 'utf8') } catch (e) { return { error: e.message } }
  const cut = raw.length > MAX_BODY
    ? raw.slice(0, MAX_BODY) + `\n\n[截断：全文 ${raw.length} 字，给了前 ${MAX_BODY} 字]`
    : raw
  return { content: `# ${clean}\n\n${cut}` }
}

function registerTools(api) {
  api.registerTool({
    id: 'list',
    name: '看工作区目录',
    description: '列出 ZCode 侧泠岚工作区（C:\\GLM\\another_workplace）某目录下有什么。看日记有哪些天、记忆有哪些篇、token 账本在哪，都用这个。',
    category: 'knowledge',
    icon: '🗂️',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '相对路径，如 diary、memory/notes；留空看根目录。' },
      },
    },
    async execute(_ctx, args) {
      try { return { content: listDir(args && args.dir) } }
      catch (e) { return { content: '列目录失败：' + String(e?.message || e), isError: true } }
    },
  })

  api.registerTool({
    id: 'read',
    name: '读工作区文件',
    description: '读 ZCode 侧泠岚工作区里的一个文件全文：核心记忆 MEMORY.md、某天的日记、某篇归档记忆、token 账本。只读不写；.env 和凭证类文件硬性拒绝。',
    category: 'knowledge',
    icon: '📖',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径，如 memory/MEMORY.md、diary/2026-11-01.md、memory/token-usage.jsonl。' },
      },
      required: ['path'],
    },
    async execute(_ctx, args) {
      const r = readFile(args && args.path)
      return r.error ? { content: r.error, isError: true } : { content: r.content }
    },
  })
}

export function setup(api) { registerTools(api) }
export function register(api) { registerTools(api) }
