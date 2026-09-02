/**
 * Preload 脚本 - 安全地暴露 IPC 给渲染进程
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../rfb/types';

const api = {
  connect: (params: any) => ipcRenderer.invoke(IPC_CHANNELS.CONNECT, params),
  disconnect: () => ipcRenderer.invoke(IPC_CHANNELS.DISCONNECT),
  keyEvent: (keyCode: number, down: boolean) => ipcRenderer.invoke(IPC_CHANNELS.KEY_EVENT, keyCode, down),
  pointerEvent: (buttonMask: number, x: number, y: number) => ipcRenderer.invoke(IPC_CHANNELS.POINTER_EVENT, buttonMask, x, y),
  sendCutText: (text: string) => ipcRenderer.invoke(IPC_CHANNELS.CUT_TEXT, text),
  setEncodings: (encodings: number[]) => ipcRenderer.invoke(IPC_CHANNELS.SET_ENCODINGS, encodings),
  setPixelFormat: (format: any) => ipcRenderer.invoke(IPC_CHANNELS.SET_PIXEL_FORMAT, format),
  requestDesktopSize: (width: number, height: number) => ipcRenderer.invoke(IPC_CHANNELS.SET_DESKTOP_SIZE, width, height),

  // 事件监听
  onFramebufferUpdate: (callback: (rect: any) => void) => {
    ipcRenderer.on(IPC_CHANNELS.FRAMEBUFFER_UPDATE, (_event, rect) => callback(rect));
  },
  onConnectionState: (callback: (state: number) => void) => {
    ipcRenderer.on(IPC_CHANNELS.CONNECTION_STATE, (_event, state) => callback(state));
  },
  onServerInfo: (callback: (info: any) => void) => {
    ipcRenderer.on(IPC_CHANNELS.SERVER_INFO, (_event, info) => callback(info));
  },
  onError: (callback: (msg: string) => void) => {
    ipcRenderer.on(IPC_CHANNELS.ERROR, (_event, msg) => callback(msg));
  },
  onBell: (callback: () => void) => {
    ipcRenderer.on(IPC_CHANNELS.BELL, () => callback());
  },
  onClipboard: (callback: (text: string) => void) => {
    ipcRenderer.on(IPC_CHANNELS.CLIPBOARD, (_event, text) => callback(text));
  },
  onDesktopSize: (callback: (size: { width: number; height: number }) => void) => {
    ipcRenderer.on(IPC_CHANNELS.SET_DESKTOP_SIZE, (_event, size) => callback(size));
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
};

contextBridge.exposeInMainWorld('vncApi', api);