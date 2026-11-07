// 渲染进程 ↔ 主进程桥。仅暴露 B 站登录相关，最小权限。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qqAgent', {
  biliLogin: () => ipcRenderer.invoke('bili:login'),
  onBiliLoginStatus: (cb) => {
    const listener = (_e, status) => cb?.(status);
    ipcRenderer.on('bili:login-status', listener);
    return () => ipcRenderer.removeListener('bili:login-status', listener);
  },
  /** Windows titleBarOverlay：随主题改最小化/最大化/关闭图标颜色（兼容旧路径） */
  setTitleBarOverlay: (opts) => ipcRenderer.invoke('ui:set-titlebar', opts),
  /** 自绘窗口控制：最小化 / 最大化 / 关闭（关闭仍走托盘逻辑） */
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winMaximize: () => ipcRenderer.invoke('win:maximize'),
  winClose: () => ipcRenderer.invoke('win:close'),
  /** 界面缩放：Electron zoomFactor，整页（含 px 卡牌）等比放大 */
  setZoomFactor: (z) => ipcRenderer.invoke('ui:set-zoom', z),
  getZoomFactor: () => ipcRenderer.invoke('ui:get-zoom'),
  /** 显示/收起独立桌宠悬浮窗 */
  toggleDesktopPet: () => ipcRenderer.invoke('pet:toggle'),
  /**
   * 下发桌宠配置（desktopPetSize / desktopPetAutoActions / desktopPetShowUsage / desktopPetShowMood）。
   * 主进程校验字段、调窗口尺寸后把设置快照转给宠物页。
   */
  configureDesktopPet: (options) => ipcRenderer.invoke('pet:configure', options),
  /**
   * /api/status 轮询得到的最小摘要（用量 + 心情 + 忙闲布尔），主进程只挑白名单字段转给宠物页。
   * 隐藏桌宠时可以不调用：不新增任何网络请求。
   */
  updateDesktopPetStatus: (snapshot) => ipcRenderer.send('pet:status', snapshot),
  /**
   * 插件桌宠动作声明：宿主（ui/app.js）统一转发，sourceId 由宿主填、不采信插件。
   * 主进程只存 id + 规则（fromMainWindow 鉴权 + sanitizer），不执行任何第三方代码。
   */
  registerDesktopPetActions: (payload) => ipcRenderer.invoke('pet:register-actions', payload),
  /**
   * 桌宠动作触发回传：只回传 { sourceId, id, at } 这样的标识，
   * place:'overlay' 的面板由主进程点名。返回退订函数（与 onBiliLoginStatus 一致）。
   */
  onDesktopPetAction: (cb) => {
    const listener = (_e, action) => cb?.(action);
    ipcRenderer.on('pet:action', listener);
    return () => ipcRenderer.removeListener('pet:action', listener);
  }
});
