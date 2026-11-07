// ④「整套新桌宠」窗口的**专用 preload**。
//
// 与 ./preload.cjs（主窗口桥，B 站登录/缩放/窗口控制/桌宠配置）**刻意分开**：
// 主窗口桥要服务整个控制台页面，暴露面大；桌宠插件页是**第三方代码**，只需要两件事——
//   ① 订阅主进程下发的状态快照（onSnapshot）
//   ② 调一次窗口配置（configure：尺寸/置顶）
// 除此之外**一律不暴露**：没有 ipcRenderer、没有 require、没有 fs/path/child_process、
// 也没有主窗口桥里的任何方法。第三方桌宠页拿不到 Node、拿不到主窗口、拿不到文件。
//
// 窗口侧的三件套由 main.js 负责：contextIsolation:true / nodeIntegration:false / sandbox:true。
// 本文件不做任何参数校验（那是主进程的事，见 main.js 的 pet-plugin:configure）——
// 这里只做"把回调接上、把参数原样送过去"，不解释、不执行、不落盘。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qqAgentPet', {
  /**
   * 订阅状态快照。返回**退订函数**（幂等），与仓库既有桥的形状一致。
   * 语义与插件侧 onPetSnapshot 一致：注册瞬间会**同步回放最新一帧**；
   * 还没有任何快照时回放的是 null（插件自己判空）。
   * 注意：快照是**深冻结**的普通对象，插件改它会直接 TypeError（刻意如此）。
   */
  onSnapshot: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_event, snapshot) => { try { cb(snapshot); } catch { /* 插件回调抛错不影响宿主 */ } };
    ipcRenderer.on('pet-plugin:snapshot', listener);
    // 立刻补一帧：避免插件必须等下一次状态刷新才画得出第一帧
    try { ipcRenderer.send('pet-plugin:snapshot-request'); } catch { /* 忽略 */ }
    return () => { ipcRenderer.removeListener('pet-plugin:snapshot', listener); };
  },
  /**
   * 请求调整本窗口（尺寸 / 置顶）。参数由主进程校验并夹紧，非法值会被忽略或夹回默认；
   * 返回 { ok, applied } —— ok=false 表示主进程拒绝了这次请求。
   * 只接受 { width, height, alwaysOnTop } 三个数字/布尔，其余键主进程一律不看。
   */
  configure: (options) => ipcRenderer.invoke('pet-plugin:configure', options)
});
