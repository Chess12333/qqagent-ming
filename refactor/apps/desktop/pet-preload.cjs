const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qqAgentPet', {
  hide: () => ipcRenderer.invoke('pet:hide'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('pet:toggle-on-top'),
  /**
   * 订阅主进程推送的桌宠快照 { settings, status, skin, fallbackSkin, assetRoot, legacy }。
   * settings = 桌宠五项配置（含 desktopPetSkin）；status = /api/status 的白名单摘要
   * （用量 + 心情 + 忙闲布尔），可能为 null；skin/fallbackSkin = 主进程解析好的皮肤
   * public summary（无绝对路径），assetRoot = 主进程按 core.lastPort 拼好的回环资源
   * URL base；legacy = 内置旧图 fallback 的固定回环 URL。渲染页不接受/不回传任何路径。
   * 返回解除监听的函数。
   */
  onSnapshot: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_e, snapshot) => {
      try { callback(snapshot); } catch { /* 页面回调抛错不能弄断通道 */ }
    };
    ipcRenderer.on('pet:snapshot', listener);
    return () => ipcRenderer.removeListener('pet:snapshot', listener);
  },
  /**
   * pet.actions（③）：主进程聚合好的动作清单 [{ id, label, place, source, spec? }]。
   * 页面只负责「显示悬浮面板」，右键菜单由主进程聚合（页面拿不到原生菜单）。
   */
  onActions: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_e, actions) => {
      try { callback(actions || []); } catch { /* 同上：页面抛错不影响通道 */ }
    };
    ipcRenderer.on('pet:actions', listener);
    return () => ipcRenderer.removeListener('pet:actions', listener);
  },
  /** 主进程点名打开某个 overlay 动作（面板内容由主进程给的 spec 或页内 provider 提供）。 */
  onOverlay: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_e, payload) => {
      try { callback(payload || null); } catch { /* ignore */ }
    };
    ipcRenderer.on('pet:overlay', listener);
    return () => ipcRenderer.removeListener('pet:overlay', listener);
  },
  /**
   * 点击动作 → 回主进程（主进程再转给声明方）。**只传 id**：
   * 桌宠窗口不认识任何动作的实现，也不能带参数进去。
   */
  invokeAction: (id) => ipcRenderer.invoke('pet:invoke-action', String(id || '').slice(0, 64))
});
