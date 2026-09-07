/**
 * Preload 脚本 - 安全地暴露 IPC 给渲染进程
 *
 * 注意：Electron 20+ 默认 sandbox: true，沙箱化的 preload 只能 require('electron')
 * 等内置模块，不能加载项目内文件（如 ../rfb/types），否则 preload 整体加载失败，
 * 渲染进程将拿不到 vncApi。因此这里内联 IPC 通道常量（与 src/rfb/types.ts 保持一致）。
 */

import { contextBridge, ipcRenderer } from 'electron';

// 与 src/rfb/types.ts 的 IPC_CHANNELS 保持一致
const IPC = {
  CONNECT: 'rfb:connect',
  DISCONNECT: 'rfb:disconnect',
  KEY_EVENT: 'rfb:key-event',
  POINTER_EVENT: 'rfb:pointer-event',
  CUT_TEXT: 'rfb:cut-text',
  FRAMEBUFFER_UPDATE: 'rfb:framebuffer-update',
  CONNECTION_STATE: 'rfb:connection-state',
  SERVER_INFO: 'rfb:server-info',
  BELL: 'rfb:bell',
  CLIPBOARD: 'rfb:clipboard',
  ERROR: 'rfb:error',
  SET_ENCODINGS: 'rfb:set-encodings',
  SET_PIXEL_FORMAT: 'rfb:set-pixel-format',
  SET_DESKTOP_SIZE: 'rfb:request-desktop-size',
  APP_LOG: 'app:log',
  LOG_GET: 'app:log:get',
  LOG_CLEAR: 'app:log:clear',
  GET_SETTINGS: 'app:settings:get',
  SET_SETTINGS: 'app:settings:set',
  MOBILE_PORT_CHANGED: 'app:mobile-port-changed',
} as const;

const api = {
  connect: (params: any) => ipcRenderer.invoke(IPC.CONNECT, params),
  disconnect: () => ipcRenderer.invoke(IPC.DISCONNECT),
  keyEvent: (keyCode: number, down: boolean) => ipcRenderer.invoke(IPC.KEY_EVENT, keyCode, down),
  pointerEvent: (buttonMask: number, x: number, y: number) => ipcRenderer.invoke(IPC.POINTER_EVENT, buttonMask, x, y),
  sendCutText: (text: string) => ipcRenderer.invoke(IPC.CUT_TEXT, text),
  setEncodings: (encodings: number[]) => ipcRenderer.invoke(IPC.SET_ENCODINGS, encodings),
  setPixelFormat: (format: any) => ipcRenderer.invoke(IPC.SET_PIXEL_FORMAT, format),
  requestDesktopSize: (width: number, height: number) => ipcRenderer.invoke(IPC.SET_DESKTOP_SIZE, width, height),

  // 实时日志
  getLogs: () => ipcRenderer.invoke(IPC.LOG_GET),
  clearLogs: () => ipcRenderer.invoke(IPC.LOG_CLEAR),
  onLog: (callback: (entry: { time: string; level: string; msg: string }) => void) => {
    ipcRenderer.on(IPC.APP_LOG, (_event, entry) => callback(entry));
  },

  // 设置
  getSettings: () => ipcRenderer.invoke(IPC.GET_SETTINGS),
  setSettings: (settings: any) => ipcRenderer.invoke(IPC.SET_SETTINGS, settings),
  onMobilePortChanged: (callback: (port: number) => void) => {
    ipcRenderer.on(IPC.MOBILE_PORT_CHANGED, (_event, port) => callback(port));
  },

  // 事件监听
  onFramebufferUpdate: (callback: (rect: any) => void) => {
    ipcRenderer.on(IPC.FRAMEBUFFER_UPDATE, (_event, rect) => callback(rect));
  },
  onConnectionState: (callback: (state: number) => void) => {
    ipcRenderer.on(IPC.CONNECTION_STATE, (_event, state) => callback(state));
  },
  onServerInfo: (callback: (info: any) => void) => {
    ipcRenderer.on(IPC.SERVER_INFO, (_event, info) => callback(info));
  },
  onError: (callback: (msg: string) => void) => {
    ipcRenderer.on(IPC.ERROR, (_event, msg) => callback(msg));
  },
  onBell: (callback: () => void) => {
    ipcRenderer.on(IPC.BELL, () => callback());
  },
  onClipboard: (callback: (text: string) => void) => {
    ipcRenderer.on(IPC.CLIPBOARD, (_event, text) => callback(text));
  },
  onDesktopSize: (callback: (size: { width: number; height: number }) => void) => {
    ipcRenderer.on(IPC.SET_DESKTOP_SIZE, (_event, size) => callback(size));
  },
  onMenuNewConnection: (callback: () => void) => {
    ipcRenderer.on('menu:new-connection', () => callback());
  },
  onMenuDisconnect: (callback: () => void) => {
    ipcRenderer.on('menu:disconnect', () => callback());
  },
  onMenuToggleFullscreen: (callback: () => void) => {
    ipcRenderer.on('menu:toggle-fullscreen', () => callback());
  },
  onMenuExitFullscreen: (callback: () => void) => {
    ipcRenderer.on('menu:exit-fullscreen', () => callback());
  },
  onMenuZoomFit: (callback: () => void) => {
    ipcRenderer.on('menu:zoom-fit', () => callback());
  },
  onMenuZoom100: (callback: () => void) => {
    ipcRenderer.on('menu:zoom-100', () => callback());
  },
  onMenuShowLogs: (callback: () => void) => {
    ipcRenderer.on('menu:show-logs', () => callback());
  },
  onMenuShowSettings: (callback: () => void) => {
    ipcRenderer.on('menu:show-settings', () => callback());
  },
};

contextBridge.exposeInMainWorld('vncApi', api);