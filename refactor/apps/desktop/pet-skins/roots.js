// 桌宠皮肤的「两个根」——**唯一真相在此**，两侧消费者都从这里取：
//   ① 桌宠渲染进程：refactor/apps/desktop/main.js
//   ② 服务端设置页列表：refactor/apps/server/api/media.js（经 apps/server/paths.js）
// 两边必须解析到**同一对目录、同一套标签**，否则用户会看到「设置里选了、桌宠上不生效」。
//
// ★ 为什么单独成文件而不是就地写在 main.js 里：
//   main.js 是 Electron 主进程入口，一 import 就会 app.whenReady()、抢实例锁、拉起 peer core，
//   **单元测试根本不能 import 它**。把常量抽到这里，才能被自检脚本安全 import ——
//   「交叉护栏」本身才是交付物，一行改动只是它的后果。
//
// ★ 2026-10-05 修的静默漂移（迁移期语义漂移，用户皮肤全丢且不报错）：
//   旧树 electron/main.js:49  const APP_ROOT = path.resolve(__dirname, '..')  而 __dirname = <repo>/electron
//        ⇒ APP_ROOT = <repo>            ⇒ user 根 = <repo>/pet-skins          ✅ 盘上有 example-soft/
//   新树 refactor/apps/desktop/main.js:50 同一行表达式，而 __dirname = refactor/apps/desktop
//        ⇒ APP_ROOT = refactor/apps      ⇒ user 根 = refactor/apps/pet-skins    ❌ 不存在
//   两边**逐行读起来一模一样**，因为表达式没变、__dirname 变了。
//   同族漂移：pet-skins/registry.js 的 DEFAULT_SKIN_ROOT 旧写 '../../pet-skins/'
//   （从 src/pet-skins/ 出发正好是 <repo>/pet-skins），在新深度解析成 refactor/apps/pet-skins。
//
// ★ 漂移为什么"不可能再犯"（本文件的三道闸）：
//   闸 1（单一真相）：两个根**直接 import apps/server/paths.js 的常量**，不再各算各的。
//                     桌面侧不再存在第二个算法，也就没有第二个会漂的答案。
//   闸 2（不再猜 __dirname）：仓库根由 paths.js 的 REPO_ROOT 提供，本文件对它做
//                     「必须同时含 package.json 与 refactor/」的存在性断言。
//                     任何 user-data 根都**不许**再由 path.resolve(__dirname,'..') 派生。
//   闸 3（fail-closed）：assertPetSkinRoots() 对每个声明的根做存在性断言；
//                     解析到不存在的目录 ⇒ 抛错，**绝不**安静地扫出空皮肤列表。
//                     （本仓库规矩：假绿比红更糟。）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REPO_ROOT as SERVER_REPO_ROOT,
  PET_SKINS_ROOT as SERVER_PET_SKINS_ROOT,
  PET_SKINS_USER_ROOT as SERVER_PET_SKINS_USER_ROOT
} from '../../server/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 本文件所在目录：refactor/apps/desktop/pet-skins */
export const PET_SKINS_MODULE_DIR = __dirname;
/**
 * 桌宠应用根：refactor/apps/desktop。
 * ⚠ 这里用 `..` 是**故意的、且安全的**，别把它当残留漂移：
 *   它是「应用自身目录」（preload / pet.html / 内置 pet-skins 旁边那一层），不是 user-data 根。
 *   本票的禁令只针对 **user-data 根**（pet-skins / plugins / data …）：那些必须来自 paths.js 的 REPO_ROOT。
 *   判据一句话：**凡是需要跨进程与 apps/server 对齐的目录，一律不许本地反推。**
 */
export const DESKTOP_DIR = path.resolve(__dirname, '..');

/**
 * 闸 2：仓库根不由本文件 __dirname 反推，而是取 paths.js 的 REPO_ROOT；
 * 再断言它确实长得像仓库根 —— 万一将来 paths.js 自己被改错，这里立刻炸，
 * 而不是带着错根静默启动。
 */
if (!fs.existsSync(path.join(SERVER_REPO_ROOT, 'package.json'))
  || !fs.existsSync(path.join(SERVER_REPO_ROOT, 'refactor'))) {
  throw new Error(
    `[pet-skin-roots] 仓库根识别失败：${SERVER_REPO_ROOT} 下缺 package.json 或 refactor/。`
    + '说明 apps/server/paths.js 的 REPO_ROOT 被改错了 —— 先修它，别在皮肤根上打补丁。'
  );
}

/** 仓库根（user-data 类目录的锚） */
export const REPO_ROOT = SERVER_REPO_ROOT;

/** 内置皮肤根 = refactor/apps/desktop/pet-skins（随应用发版，含 qq-agent-default + 资源） */
export const PET_SKINS_BUILTIN_ROOT = SERVER_PET_SKINS_ROOT;
/** 用户皮肤根 = <仓库根>/pet-skins（**不搬**，用户往里丢包，严禁进任何打包白名单） */
export const PET_SKINS_USER_DIR = SERVER_PET_SKINS_USER_ROOT;

/** 与旧树语义、标签一一对应（顺序即扫描优先级：builtin → user） */
export const PET_SKIN_ROOTS = Object.freeze([
  Object.freeze({ label: 'builtin', dir: PET_SKINS_BUILTIN_ROOT }),
  Object.freeze({ label: 'user', dir: PET_SKINS_USER_DIR })
]);

/**
 * 闸 3：fail-closed —— 所有声明的皮肤根必须存在且是目录，否则抛错。
 * 漂移的现场正是「user 根不存在 ⇒ 扫不到任何用户皮肤 ⇒ 桌宠只剩内置皮肤且**不报错**」；
 * 这里把它变成启动期的硬错误。
 * @param {{label:string,dir:string}[]} [roots]
 * @returns {{label:string,dir:string}[]} 原样返回，便于链式
 */
export function assertPetSkinRoots(roots = PET_SKIN_ROOTS) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new Error('[pet-skin-roots] 皮肤根数组为空/非法 —— 拒绝以空皮肤列表启动。');
  }
  const bad = [];
  for (const { label, dir } of roots) {
    let st = null;
    try { st = fs.statSync(dir); } catch { /* 不存在 */ }
    if (!st || !st.isDirectory()) bad.push({ label, dir });
  }
  if (bad.length) {
    throw new Error(
      '[pet-skin-roots] 皮肤根解析到了不存在的目录，拒绝启动（假绿比红更糟）：\n'
      + bad.map((b) => `  · ${b.label} → ${b.dir}`).join('\n')
      + `\n  期望：builtin = ${PET_SKINS_BUILTIN_ROOT}\n         user    = ${PET_SKINS_USER_DIR}\n`
      + '  若这两行看着眼熟，那是迁移期的 __dirname 语义漂移：请从 apps/server/paths.js 取根，不要本地反推。'
    );
  }
  return roots;
}
