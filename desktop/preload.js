'use strict';

// 预加载脚本：以 contextBridge 向阅读器页面暴露最小 IPC 面（自动更新用）。
// 不暴露任何 Node 能力，只放行 updater:* 通道。
//
// ⚠️ 这里必须是 exposeInMainWorld。v1.2.0~v1.4.0 误写成 exposeAsMainWorld（Electron 没有
// 这个方法），preload 直接抛 TypeError → window.pv 不存在 → 设置里的「检查更新」被隐藏、
// 菜单「检查更新…」发出的事件也没人接，用户只剩开机那一次原生弹窗能感知到新版本。
const { contextBridge, ipcRenderer } = require('electron');

// 只放行这几个通道，避免页面拿到任意 ipcRenderer.invoke
const INVOKE_ALLOWED = new Set([
  'updater:check',
  'updater:channels',
  'updater:download',
  'updater:install',
  'updater:version'
]);

contextBridge.exposeInMainWorld('pv', {
  invoke: (channel, ...args) => {
    if (!INVOKE_ALLOWED.has(channel)) {
      return Promise.reject(new Error('blocked channel: ' + channel));
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, cb) => {
    if (typeof cb !== 'function' || !/^updater:/.test(channel)) return;
    ipcRenderer.on(channel, (_event, ...args) => cb(...args));
  }
});
