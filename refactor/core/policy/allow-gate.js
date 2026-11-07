/**
 * M-policy allow-gate：入站白名单准入门（W1，2026-10-06）。
 *
 * 判据本体对齐老树 `src/app.js:106-113 allowed(kind,id,cfg)` 的**顺序**：
 *   ① deny 先判，命中 ⇒ false（deny 压过 allowAllWhenEmpty，老树 `:109` 在 `:112` 之前 return）；
 *   ② allow 非空 ⇒ 只放行其中（老树 `:111`）；
 *   ③ allow 为空 ⇒ `allowAllWhenEmpty === true` 才放行（老树 `:112`）。
 * id 与列表项都 String() 再比（群号可能是 number，老树 `.map(String)` 同理）。
 *
 * ★★ N51 对账（2026-10-10）：头注原先写的是"语义**逐字**对齐"，**这句不成立**，已改成上面的"顺序对齐"。
 *   逐行核过老树 `src/app.js:106-113` + 它的 5 个调用点（`:913/:1081/:1151/:1169/:1182`）后，
 *   真实分歧有三条，前两条是**故意与老树不同**（都是"更严"的方向），第三条是老树的崩溃形态：
 *   · **单复数并存且单数为空**：老树用 `??`（只看 nullish）⇒ `allow={group:[], groups:['111']}` 会被算成
 *     "空 allow"，直接落到 `allowAllWhenEmpty` ⇒ **放行整张表之外的所有群**（`deny` 同形状则反过来谁都不拦）。
 *     本模块取**第一个非空列表**（`readList`）⇒ 只放 111。老树那个形态是**fail-open**，白名单形同没设。
 *     ★ 默认盘面单复数只给一份（老 `src/config.js:916-917` / 新 `core/config-store/defaults.js:817-818` 都是复数键），
 *     所以触发条件是"手工把两个键都写了且单数留空" —— 少见，但一旦撞上就是"机器人对着没授权的人群说话"。
 *   · **列表写成字符串**（`deny.group: "123"`）：老树 `:109` 的 `.map` 会对字符串抛 TypeError，
 *     被 `src/app.js:626` 的 `.catch` 兜住 ⇒ **整条事件被丢**：不是只拦这一个号，是**所有聊天都不回话、连档都不入**。
 *     本模块把它当单元素列表（`listOf`）⇒ 照常只拦 123。★ 这条**不照搬**：照搬等于把"一个键写错 ⇒ 全站静默"做成规格。
 *   · **分档作用域**：老树读的是 `getConfig()` 一张平表；这里由调用方注入 `read(keyPath)`，
 *     可以带 perChat/private 作用域 ⇒ 四次读可能解析到不同作用域的值。老树无此机制，属新树新增能力。
 * kind 值域：老树可达的只有 `'group'`/`'private'`（`:1081/:1146-1147/:1165-1166/:1180` 全是三元算出来的，
 *   第三值 `''` 在 `:1151/:1167` 被 `if (kind)` 挡在 allowed() 之前）⇒ 下面把非 private 一律当 group，
 *   就老树可达输入而言**不构成行为差异**。
 *
 * cfg 读取面（票面：跟 act/index.js:921-923 的 eff(key) 同风格，别自造第三套读法）：
 * 本模块不碰 config-store —— 取值器由调用方传入（`read(keyPath)`），读不到一律按缺省（不放行）。
 * ★ 四次读**全部**包 try（N51 补齐：原先 `read(base)`/`read(base.key)` 有 try、两个复数键路径没有，
 *   抛出会逃出本模块；这是道准入门，"读配置失败"不该变成上层的一记异常）。
 *   读失败一律当"这项没配"，最终落到 `allowAllWhenEmpty === true` 才放行 ⇒ **默认拒**。
 */

function listOf(value) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  // 标量也要认：`deny.group: "12345"` 与 `deny.group: 12345`（群号写成 number）都是"只有一条"的列表。
  // 老树这两种形态都会在 `.map` 上抛 TypeError ⇒ 整条事件被丢（见头注第二条分歧）。
  if (typeof value === 'string' && value.trim()) return [value];
  if (typeof value === 'number' && Number.isFinite(value)) return [String(value)];
  return [];
}

export function allowGate(kind, id, read = () => undefined) {
  const key = kind === 'private' ? 'private' : 'group';
  const safeRead = (keyPath) => {
    try { return read(keyPath); } catch { return undefined; }
  };
  const readList = (base) => {
    const bag = safeRead(base);
    const fromBase = bag && typeof bag === 'object' && !Array.isArray(bag) ? bag[key] : undefined;
    const fromBaseS = bag && typeof bag === 'object' && !Array.isArray(bag) ? bag[`${key}s`] : undefined;
    const fromPath = safeRead(`${base}.${key}`);
    const fromPathS = safeRead(`${base}.${key}s`);
    for (const raw of [fromBase, fromBaseS, fromPath, fromPathS]) {
      const list = listOf(raw);
      if (list.length) return list;
    }
    return [];
  };
  const s = String(id);
  if (readList('deny').includes(s)) return false;
  const allowList = readList('allow');
  if (allowList.length > 0) return allowList.includes(s);
  return safeRead('allowAllWhenEmpty') === true;
}
