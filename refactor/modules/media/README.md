# M11 media（`refactor/modules/media/`）

> 表情 / 图片 / 视觉 / 表情库。本模块是「**搬 + 改边界**」：9 个搬运件（逐字节搬，只改 import 路径）
> + 1 个边界层（`boundaries.js`，新写）+ 本文件。
> 冻结面与目录约定见 `refactor/README.md`（§2 模块表 / §3 冻结接口 / §3.5 搬运层兼容面 / §4 目录）。

---

## 1. 这个模块只做「找 / 存 / 看」

**不决定"发不发 / 发什么"**（B1）。发不发由 M8 plan 定意图、M10 act 执行并核验回执；
媒体层返回候选 + 元信息，不碰发送面。`OneBotClient` 只准用于**下载 / 取图**
（白名单 `ONEBOT_READONLY_METHODS` / `ONEBOT_READONLY_ALLOWED`，只读动作）。

---

## 2. ⚠️ 已知外发面（**这一节是产品行为说明，不是 bug**）

本模块有**三个**能把数据发出去的地方。**公开出口已按 §3 收口**（只有受控入口在出口上），
但"谁能发、发什么"必须写清楚：

### 2.1 `reverseImageSearch` —— 把**用户图片 POST 给第三方图床**（默认关）

- 落点：`reverse-image.js:128`，内部 `uploadForReverse()` 会把图片字节 POST 到
  **`sm.ms`**（失败再退 **`catbox.moe`**）换临时公网 URL，再把该 URL 交给**百度识图** / **IQDB**。
- **性质**：匿名第三方拿到了用户的图，与功能无关 ⇒ **L3（对外发送）**。
- **闸门**：`boundaries.reverseImageSearchGuarded()`，开关
  **`media.reverseImage.allowThirdPartyUpload`，默认 `false`**（只认 `=== true`）。
  关着时返回 `{ ok:false, reason:'third_party_upload_disabled', didReverseImageSearch:false }` ——
  **不会**静默退化成"没找到图"，上层说明里能看到"没做反向图搜"。
  传了公网 `url` 也照样关（百度识图 / IQDB 本身也是第三方）。
- **出口**：裸 `reverseImageSearch` **不在 `index.js` 上**（`export {} from './reverse-image.js';`）——
  那个文件唯一的导出就是出网那个，没有干净出口，所以整个不导出。
- **默认值变更待用户拍板**；要翻回开只改 `DEFAULT_THIRD_PARTY_UPLOAD` 一个常量，结构不动。

### 2.2 `StickerManager.annotateMissing()` —— 把**表情图 dataURL 发给主视觉模型**（**保持现状，不加闸**）

- 落点：`sticker-manager.js:295`（`await import('../llm/index.js')`）+ `:344`（`chatCompletion({ … dataUrls … })`）。
- **性质与 2.1 不同**：发给的是**用户自己配置的模型**，而且**主链本来就要把用户发的图发给模型**
  （视觉能力就是这个产品的核心功能）⇒ "给模型看用户发的图"**不是异常外发**。
- **裁定（2026-10-04 指挥位）**：**不加新的默认关开关**。
  如果用户以后要"不给模型看表情"，那是**产品决策**，由用户拍板，**不是**本模块现在要改的东西。
- 触发方式是管理员显式点"批量补备注"，不是运行期自动行为。

### 2.3 `detectModelVision` / `scanModelsVision` —— 把**探测图发给模型 provider**（**不在出口上**）

- 落点：`vision-scan.js:107` / `:163`，内部 `fetch('<baseUrl>/chat/completions')`。
- **性质**：一次性的"这个模型有没有视觉能力"探测 ⇒ 属 M4 / 装配期的事，不该由 media 在运行期反复探。
- **出口**：`index.js` 对 `vision-scan.js` 只导出 3 个纯读配置的
  （`visionResults` / `modelVisionVerdict` / `modelImageVerdict`）；
  这两个**不在出口上**。
- ⚠️ **因此它们当前是死代码（有定义、零可达调用点）** —— 已登记为债（`KNOWN_DEBTS` 第 6 条）。
  第 3 批二选一：给受控入口（走 M4 / 装配层一次性调用）**或**删掉。
  **不许**为了让它们可达而临时加一个默认关开关 —— 那等于新增一个产品开关，要用户点头。

---

## 3. 边界层 `boundaries.js`

B1 不决定发不发 / B2 不猜图中人 / B3 失败要说失败 / B4 第三方上传默认关。

- **只许 media 自己用**（不在 §3.5 冻结面里）。需要"source 字段"这类**纯合同语义**请去 `contracts/`。
- 视觉产出的每条结论**必须带 `source`**（自述 / 转述 / 引用 / 模型推测 / 工具确认）；
  **图里的动作不归因给发图人**（验收第 6 条的前置）。
- 下载 / 解码 / 视觉失败 ⇒ `{ ok:false, reason }`，**不许**空数组 / 空字符串冒充"没有图"。

---

## 4. 自检

```
node refactor/modules/media/selftest.mjs        # EXIT=0 才是过
```
19+ 用例 / 260+ 断言，含：搬运保真表（差异只允许落在 import 行）· 3+1 条边界 ·
说明符合法性（`./x.js` 必须存在 / 跨模块必须指向对方 `index.js` / 白名单外红）·
**公开出口收口**（出网函数不许挂在 `index.js` 上）· **真 `import ./index.js`** ·
禁网哨兵（`fetch` 真实调用必须 0）· 写入面记账（临时产物只写 `os.tmpdir()`，**读写真 `data/` 必须 0 次**）。

临时产物一律写 `os.tmpdir()`，**不许在仓库里建临时目录**（README 铁律 2）。