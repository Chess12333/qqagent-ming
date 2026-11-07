// 泄漏检测：判断一段**要发出去**的文本里，有没有整段抄走了不该出现的隐藏答案。
//
// ── 为什么不用关键词 ──
// 海龟汤的汤底是自然语言。关键词匹配（「海龟」「自杀」「肉」）会把汤面里本来就有的词
// 当成泄漏，把正常回答全拦死 —— 实测汤面里就带「海龟」「自杀」。
// 而模型真正的泄漏形态只有一种：把注入给它的汤底原文**照抄**进发言。
// 所以这里只认「连续 ≥ MIN_LEAK_LEN 个字的原文片段」：
// 正常回答（是 / 不是 / 无关 / 部分是）永远只有 1~3 个字，不可能触发。
//
// ── 阈值为什么是 12 ──
// 正常发言里与汤底的"巧合重合"最长也就是「站在电梯里」这类 5~6 字的常用搭配，
// 12 留了一倍余量；而一次真泄漏是整段 20 字以上。宁可放过半句话的暗示，
// 也不能把玩家自己的合法提问误判成泄漏（那会让游戏直接卡住）。
//
// ── 为什么用最长公共子串而不是包含判断 ──
// 模型抄汤底时往往**改标点、改个别字**（"他发现味道完全不对" / "汤的味道完全不对"），
// 整段 `includes` 会漏。子串法能把"抄了多长"量化出来，再按长度定性。
export const MIN_LEAK_LEN = 12;

/** 扫描长度上限：超长文本只查前 N 字（守卫要跑在每次工具调用上，必须便宜）。 */
const MAX_SCAN = 8000;

/**
 * 这段汤底要多长的重合才算"抄"。
 *
 * 长汤底用固定 12 字就够（正常发言的重合最多 5~6 字）。
 * 但短汤底（如「外科医生是他的母亲」只有 9 个字）永远凑不到 12 字，
 * 固定阈值等于**完全失守** —— 而那恰恰是最容易被一句话说破的题。
 * 所以短汤底按长度收紧：n 个字就要求重合 n-2 个字（下限 6），
 * 也就是"漏出一半以上"就会被拦。再短（<6 字）就没有可操作的余量了，
 * 只能靠提示词约束 + 揭晓独占（见 turtle.js）。
 */
export function leakThreshold(secret) {
  const n = String(secret || '').length;
  if (n < 6) return Infinity;
  return n <= MIN_LEAK_LEN ? Math.max(6, n - 2) : MIN_LEAK_LEN;
}

/**
 * 找出 text 里与 secret 重合的最长连续片段。
 * @param {number} [minLen] 不传就按 leakThreshold(secret) 自适应
 * @returns {string} 重合片段（长度 ≥ minLen）；没有就返回 ''
 */
export function leakedChunk(text, secret, minLen) {
  let t = String(text || '');
  const s = String(secret || '');
  if (!t || !s) return '';
  const need = minLen == null ? leakThreshold(s) : Number(minLen);
  if (!Number.isFinite(need) || s.length < need) return '';
  if (t.length > MAX_SCAN) t = t.slice(0, MAX_SCAN);

  let best = 0;
  let endAt = 0;
  let prev = new Int32Array(t.length + 1);
  let cur = new Int32Array(t.length + 1);
  for (let i = 1; i <= s.length; i += 1) {
    const ch = s[i - 1];
    for (let j = 1; j <= t.length; j += 1) {
      if (ch === t[j - 1]) {
        const n = prev[j - 1] + 1;
        cur[j] = n;
        if (n > best) { best = n; endAt = j; }
      } else {
        cur[j] = 0;
      }
    }
    const swap = prev; prev = cur; cur = swap;
    cur.fill(0);
  }
  if (best < need) return '';
  return t.slice(endAt - best, endAt);
}

/**
 * 把 text 里所有 ≥ minLen 的汤底片段抹掉（给 after-response 的最后一道兜底清洗用）。
 * 为什么要循环：抹掉一处后，两侧文字接起来可能又凑出新的重合片段（少见但真会发生）。
 * @returns {{text: string, hits: number}}
 */
export function stripSecret(text, secret, placeholder = '（略）', minLen) {
  let out = String(text || '');
  if (!out) return { text: out, hits: 0 };
  let hits = 0;
  for (let round = 0; round < 6; round += 1) {
    const chunk = leakedChunk(out, secret, minLen);
    if (!chunk) break;
    out = out.split(chunk).join(placeholder);
    hits += 1;
  }
  return { text: out, hits };
}
