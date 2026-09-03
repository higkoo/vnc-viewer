"use strict";
/**
 * Preload 脚本 - 安全地暴露 IPC 给渲染进程
 */
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const types_1 = require("../rfb/types");
const api = {
    connect: (params) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.CONNECT, params),
    disconnect: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.DISCONNECT),
    keyEvent: (keyCode, down) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.KEY_EVENT, keyCode, down),
    pointerEvent: (buttonMask, x, y) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.POINTER_EVENT, buttonMask, x, y),
    sendCutText: (text) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.CUT_TEXT, text),
    setEncodings: (encodings) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SET_ENCODINGS, encodings),
    setPixelFormat: (format) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SET_PIXEL_FORMAT, format),
    requestDesktopSize: (width, height) => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.SET_DESKTOP_SIZE, width, height),
    // 实时日志
    getLogs: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LOG_GET),
    clearLogs: () => electron_1.ipcRenderer.invoke(types_1.IPC_CHANNELS.LOG_CLEAR),
    onLog: (callback) => {
        electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.APP_LOG, (_event, entry) => callback(entry));
    },
    // 事件监听
    onFramebufferUpdate: (callback) => {
        electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.FRAMEBUFFER_UPDATE, (_event, rect) => callback(rect));
    },
    onConnectionState: (callback) => {
        electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.CONNECTION_STATE, (_event, state) => callback(state));
    },
    onServerInfo: (callback) => {
        electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.SERVER_INFO, (_event, info) => callback(info));
    },
    onError: (callback) => {
        electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.ERROR, (_event, msg) => callback(msg));
    },
    onBell: (callback) => {
        electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.BELL, () => callback());
    },
    onClipboard: (callback) => {
        electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.CLIPBOARD, (_event, text) => callback(text));
    },
    onDesktopSize: (callback) => {
        electron_1.ipcRenderer.on(types_1.IPC_CHANNELS.SET_DESKTOP_SIZE, (_event, size) => callback(size));
    },
    onMenuNewConnection: (callback) => {
        electron_1.ipcRenderer.on('menu:new-connection', () => callback());
    },
    onMenuDisconnect: (callback) => {
        electron_1.ipcRenderer.on('menu:disconnect', () => callback());
    },
    onMenuToggleFullscreen: (callback) => {
        electron_1.ipcRenderer.on('menu:toggle-fullscreen', () => callback());
    },
    onMenuExitFullscreen: (callback) => {
        electron_1.ipcRenderer.on('menu:exit-fullscreen', () => callback());
    },
    onMenuZoomFit: (callback) => {
        electron_1.ipcRenderer.on('menu:zoom-fit', () => callback());
    },
    onMenuZoom100: (callback) => {
        electron_1.ipcRenderer.on('menu:zoom-100', () => callback());
    },
    onMenuShowLogs: (callback) => {
        electron_1.ipcRenderer.on('menu:show-logs', () => callback());
    },
};
electron_1.contextBridge.exposeInMainWorld('vncApi', api);
//# sourceMappingURL=preload.js.map