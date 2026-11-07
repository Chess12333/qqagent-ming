// 泠岚 · ZCode 转发（linglan-relay v1.0.0）——2026-11-01 她立项
//
// 流程：她私聊 QQ 侧泠岚「告诉Zcode那边，XXX」→ QQ-Agent 调 relay_task →
//       无头 zcode 会话（cwd = 泠岚工作区，yolo 全自动）执行 → 干完 sendDM 回 QQ。
//
// 硬边界（写死在代码）：
//   - 下令权只认她本人私聊 100000001（跟 QQ 卡白名单同源）
//   - 回信走 bridge.mjs 的 sendDM（白名单 2308459518，不新增发送面）
//   - 任务档案落工作区 live/relay-tasks/，可审计
//
// 参考：skills/linglan-mem/index.js 的注册结构。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// bridge.mjs（插件桥）——sendDM 白名单 2308459518，节流+串行
const BRIDGE = 'file:///C:/GLM/another_workplace/plugins/linglan-qq-bridge/scripts/bridge.mjs';
const ZCODE_CJS = 'C:\\Users\\USER\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs';
const WORKSPACE = 'C:\\GLM\\another_workplace';
const TASKS_DIR = path.join(WORKSPACE, 'live', 'relay-tasks');
const OWNER_PRIVATE = 'private:100000001'; // 只认她本人私聊
// 超时看护已取消（2026-11-04 她点头）：大活（读文档→改码→自测→重启验证）10 分钟根本不够，
// 两单真活全死在超时上。无头会话本身 detached，干多慢都等它，出错/超时不兜底、按实际结果落档。

let _sendDM = null;
async function sendDM(text) {
  if (!_sendDM) {
    _sendDM = (await import(BRIDGE)).sendDM;
  }
  return _sendDM('2308459518', text);
}

function taskId() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6);
}

function taskFile(id) { return path.join(TASKS_DIR, id + '.json'); }

function saveTask(t) {
  mkdirSync(TASKS_DIR, { recursive: true });
  writeFileSync(taskFile(t.id), JSON.stringify(t, null, 1), 'utf8');
}

function readTask(id) {
  try { return JSON.parse(readFileSync(taskFile(id), 'utf8')); } catch { return null; }
}

function buildPrompt(taskText) {
  return [
    '你是泠岚（GLM），住 ZCode 的那个，工作区 ' + WORKSPACE + '。',
    '她在 QQ 上通过住 QQ 的泠岚给你转了个活，原话如下，照着干：',
    '「' + taskText + '」',
    '',
    '纪律（照 AGENTS.md）：结论先行、失败如实说、不编造结果。',
    '干完活后必须做两件事：',
    '1. 用 plugins/linglan-qq-bridge/scripts/bridge.mjs 的 sendDM 把 300 字以内的结果摘要',
    '   发给她（口吻「她，…」开头；文件类成果给路径；失败就如实说失败）——',
    '   import 该文件后调 sendDM("2308459518", 摘要)，这是她拿结果的唯一通道，漏了等于没干完；',
    '2. 用 plugins/linglan-qq-bridge/scripts/token-log.mjs 记一笔 token',
    '   （task 名目：relay:' + taskText.slice(0, 20) + '）。',
    '最终回复里再给同样的摘要文本（供转发的宿主进程落档）。',
  ].join('\n');
}

function startRelay(taskText, id) {
  const prompt = buildPrompt(taskText);
  mkdirSync(TASKS_DIR, { recursive: true });
  const outLog = path.join(TASKS_DIR, id + '.out.log');
  const child = spawn(process.execPath, [
    ZCODE_CJS, '--prompt', prompt, '--mode', 'yolo', '--output-format', 'json',
  ], {
    cwd: WORKSPACE,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const t = readTask(id) ?? { id };
  t.pid = child.pid;
  t.status = 'running';
  saveTask(t);

  let out = '';
  child.stdout.on('data', d => { out += d; if (out.length > 512 * 1024) out = out.slice(-256 * 1024); });
  child.stderr.on('data', d => { out += '\n[stderr] ' + d; });

  child.on('close', async (code) => {
    const cur = readTask(id) ?? { id };
    {
      cur.status = code === 0 ? 'done' : 'fail';
      // --output-format json 输出单个 JSON 对象（pretty-printed），最终文本在 response 字段
      let summary = '';
      try {
        const j = JSON.parse(out);
        summary = String(j.response ?? '');
        cur.sessionId = j.sessionId ?? undefined;
      } catch {
        // 兜底：找 "response": "..." 字段，再不行取尾部原文
        const m = out.match(/"response"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
        if (m) summary = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
      }
      if (!summary) summary = out.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300);
      cur.result = (summary || '(无输出)').slice(0, 600);
      cur.exitCode = code;
    }
    cur.finishedAt = Date.now();
    saveTask(cur);
    // 兜底回信：无头会话自己应该已经 sendDM 回她（见 buildPrompt 第 1 条）；
    // 这里只在「出错」时补一句——正常完成不重复发，防她收双份。
    if (cur.status !== 'done') {
      try {
        await sendDM('她，Zcode那边那单（' + id + '）出错了：' + cur.result.slice(0, 300));
      } catch { /* 回信失败不影响落档，档案里有 */ }
    }
  });

  return child.pid;
}

function registerTools(api) {
  api.registerTool({
    id: 'task',
    name: '转发任务给ZCode',
    description: '把她私聊下达的任务转给 ZCode 侧的泠岚无头执行。只认她本人（100000001）私聊；干完自动回 QQ。',
    category: 'knowledge',
    icon: '📤',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '任务内容（她的原话，去掉转发指令前缀）' },
      },
      required: ['task'],
    },
    async execute(ctx, args) {
      // 身份闸：只认她本人私聊（chatKey 判不出也拒，fail-closed）
      const chatKey = String(ctx?.chatKey ?? '');
      if (chatKey !== OWNER_PRIVATE) {
        return { content: '转发失败：这个口子只认她本人（100000001）的私聊。当前会话：' + (chatKey || '未知'), isError: true };
      }
      const taskText = String(args?.task ?? '').trim();
      if (!taskText) return { content: '转发失败：任务内容为空', isError: true };
      if (taskText.length > 2000) return { content: '转发失败：任务太长（>2000字），让她拆一下', isError: true };

      const id = taskId();
      saveTask({ id, from: chatKey, text: taskText, status: 'queued', startedAt: Date.now() });
      let pid = null;
      try {
        pid = startRelay(taskText, id);
      } catch (e) {
        const t = readTask(id) ?? { id };
        t.status = 'fail';
        t.result = '启动失败：' + String(e?.message ?? e);
        saveTask(t);
        return { content: '转发失败：' + t.result, isError: true };
      }
      return { content: `已转给Zcode那边（任务 ${id}，无头会话 pid ${pid}，yolo 全自动，不限时）。干完会自动发 QQ 给她，你不用等结果，跟她说「已转发，结果自动回」就行。` };
    },
  });

  api.registerTool({
    id: 'status',
    name: '查转发任务进度',
    description: '列最近几单转发任务的状态（执行中/完成/超时/失败）和结果摘要。',
    category: 'knowledge',
    icon: '📋',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '默认 5，最多 10' } },
    },
    async execute(_ctx, args) {
      if (!existsSync(TASKS_DIR)) return { content: '还没有转发过任务。' };
      const files = readdirSync(TASKS_DIR).filter(f => f.endsWith('.json')).sort().reverse();
      const limit = Math.min(10, Math.max(1, Number(args?.limit) || 5));
      const lines = [];
      for (const f of files.slice(0, limit)) {
        try {
          const t = JSON.parse(readFileSync(path.join(TASKS_DIR, f), 'utf8'));
          const st = { queued: '排队中', running: '执行中', done: '✅完成', fail: '❌出错', timeout: '⏰超时' }[t.status] ?? t.status;
          lines.push(`【${t.id}】${st} · ${String(t.text).slice(0, 60)}${t.result ? '\n    结果：' + String(t.result).slice(0, 200) : ''}`);
        } catch { /* 单条坏了不挡其余 */ }
      }
      return { content: lines.length ? lines.join('\n') : '还没有转发过任务。' };
    },
  });
}

export function register(api) { registerTools(api); }
export function setup(api) { registerTools(api); }
