// 逢七过：群友从 1 开始数，轮到 7 的倍数、或数字里带 7，就必须喊「过」。
//
// ── 玩的就是"嘴瓢" ──
// 该过没过、不该过却过了 → 立刻结束，输家就是这个人；数字跳号 → 拒（局面不变）。
//
// ── 2026-09-22 修的坑（群里实测）──
// 旧版注入写的是"轮到 1（该报数）"，模型当成"该我报 1 了"，就自己调 game_move("1")、
// 再 "3"…… 群里变成"机器人自己跟自己玩，玩家报的 2/4/6 全被忽略"。
// 两处一起改：① 注入只报**状态**（"数字 1"），不写"该谁做什么"；
// ② 引擎层加了出处校验 —— 群里没人说过的那一步会被拒（见 lib/engine.js 的 groundMove）。
// 此外还封顶：数到 500 自动平局收摊，防死循环。
export default {
  id: 'seven',
  name: '逢七过',
  aliases: ['逢7过', '逢七', '数七', 'seven', '拍七'],
  desc: '从 1 轮流数，遇到 7 的倍数或带 7 的数就喊「过」，说错就输',
  MAX: 500,

  start() {
    return {
      board: { cur: 1, tries: 0 },
      say: '逢七过：从 1 开始轮流数，轮到 7 的倍数、或者数字里带 7，就喊「过」（拍手 / pass 也行）。该过没过、不该过却过了，就输。'
    };
  },

  move(cfg, state, { text, player }) {
    const b = state.board || {};
    const cur = Number(b.cur) || 1;
    const name = player?.name || '这位';
    const raw = String(text || '').trim();
    // 2026-09-29 修（严重）：原来是句中任意位置有「过」就算过——「我路过」「过奖了」
    // 这类闲聊会被当场判负结束。现在整句必须是"过"这个动作（拍手 / pass / p 同样整句判定），
    // 前缀口癖（我 / 来 / 要…）和句尾语气词放行，正文里夹带「过」不算。
    const isPass = /^(?:我|我们|咱|咱们|来|要|那就)?\s*[，,、]?\s*(?:过|拍手|pass|p)(?:吧|了|呗|嘛|么|啊|呀|哦)?[!?。！？\s…]*$/i.test(raw);
    const nums = raw.match(/\d{1,4}/g) || [];

    if (!isPass && !nums.length) {
      return { reject: true, forModel: `既不是数字也不是「过」。让他报 ${cur}，或者该过的时候说「过」。` };
    }
    const mustPass = cur % 7 === 0 || String(cur).includes('7');

    if (isPass) {
      if (!mustPass) {
        return {
          board: { ...b, over: true }, over: true, winner: '其他玩家',   // C4：输家是 name ⇒ 赢家没点名，契约要求非空
          say: `❌ ${name} 说了「过」，可 ${cur} 既不是 7 的倍数、也不带 7 —— 这里该报 ${cur}。${name} 输。`
        };
      }
      const next = cur + 1;
      if (next > (this.MAX || 500)) return { board: { ...b, cur: next, tries: (b.tries || 0) + 1 }, over: true, winner: '平局', say: `数到 ${cur} 了，够长了，这局算平局收摊。` };
      return { board: { ...b, cur: next, tries: (Number(b.tries) || 0) + 1 }, say: `${name} 过 ✓ 下一个 ${next}` };
    }

    const n = Number(nums[nums.length - 1]);
    if (n !== cur) {
      return { reject: true, forModel: `跳号了：现在该 ${cur}，他报的是 ${n}。让他报 ${cur}。` };
    }
    if (mustPass) {
      return {
        board: { ...b, over: true }, over: true, winner: '其他玩家',   // C4：输家是 name ⇒ 赢家没点名，契约要求非空
        say: `❌ ${name} 报了 ${cur} —— ${cur % 7 === 0 ? `${cur} 是 7 的倍数` : `${cur} 里带 7`}，这里要说「过」。${name} 输。`
      };
    }
    const next = cur + 1;
    if (next > (this.MAX || 500)) return { board: { ...b, cur: next, tries: (b.tries || 0) + 1 }, over: true, winner: '平局', say: `数到 ${cur} 了，够长了，这局算平局收摊。` };
    return { board: { ...b, cur: next, tries: (Number(b.tries) || 0) + 1 }, say: `${name} 报 ${cur} ✓ 下一个 ${next}` };
  },

  /** 只报状态（**不写"该谁说什么"**：那句会诱导模型替群友走这一步）。 */
  hint(cfg, state) {
    const cur = Number(state.board?.cur) || 1;
    // 2026-09-29 修（严重）：原来写「这一位要说「过」」——那是祈使句（v3 硬约束④点名的毛病），
    // 模型会照着替群友把「过」走掉。现在只报**数字本身的性质**，规则由开场白/静态提示词讲。
    const kind = cur % 7 === 0 ? '7 的倍数' : (String(cur).includes('7') ? '含 7' : '普通数字');
    return `数字 ${cur}（${kind}），已数 ${state.board?.tries || 0} 步`;
  },

  /** 没有隐藏信息。 */
  secretOf() { return []; }
};
