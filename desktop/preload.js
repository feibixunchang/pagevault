'use strict';

// 预加载脚本：以 contextBridge 向阅读器页面暴露最小 IPC 面（自动更新用）。
// 不暴露任何 Node 能力，只放行 updater:* 通道。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeAsMainWorld('pv', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, cb) => {
    ipcRenderer.on(channel, (_event, ...args) => cb(...args));
  }
});
