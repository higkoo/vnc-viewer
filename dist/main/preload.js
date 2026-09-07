"use strict";
/**
 * Preload 脚本 - 安全地暴露 IPC 给渲染进程
 *
 * 注意：Electron 20+ 默认 sandbox: true，沙箱化的 preload 只能 require('electron')
 * 等内置模块，不能加载项目内文件（如 ../rfb/types），否则 preload 整体加载失败，
 * 渲染进程将拿不到 vncApi。因此这里内联 IPC 通道常量（与 src/rfb/types.ts 保持一致）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
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
};
const api = {
    connect: (params) => electron_1.ipcRenderer.invoke(IPC.CONNECT, params),
    disconnect: () => electron_1.ipcRenderer.invoke(IPC.DISCONNECT),
    keyEvent: (keyCode, down) => electron_1.ipcRenderer.invoke(IPC.KEY_EVENT, keyCode, down),
    pointerEvent: (buttonMask, x, y) => electron_1.ipcRenderer.invoke(IPC.POINTER_EVENT, buttonMask, x, y),
    sendCutText: (text) => electron_1.ipcRenderer.invoke(IPC.CUT_TEXT, text),
    setEncodings: (encodings) => electron_1.ipcRenderer.invoke(IPC.SET_ENCODINGS, encodings),
    setPixelFormat: (format) => electron_1.ipcRenderer.invoke(IPC.SET_PIXEL_FORMAT, format),
    requestDesktopSize: (width, height) => electron_1.ipcRenderer.invoke(IPC.SET_DESKTOP_SIZE, width, height),
    // 实时日志
    getLogs: () => electron_1.ipcRenderer.invoke(IPC.LOG_GET),
    clearLogs: () => electron_1.ipcRenderer.invoke(IPC.LOG_CLEAR),
    onLog: (callback) => {
        electron_1.ipcRenderer.on(IPC.APP_LOG, (_event, entry) => callback(entry));
    },
    // 设置
    getSettings: () => electron_1.ipcRenderer.invoke(IPC.GET_SETTINGS),
    setSettings: (settings) => electron_1.ipcRenderer.invoke(IPC.SET_SETTINGS, settings),
    onMobilePortChanged: (callback) => {
        electron_1.ipcRenderer.on(IPC.MOBILE_PORT_CHANGED, (_event, port) => callback(port));
    },
    // 事件监听
    onFramebufferUpdate: (callback) => {
        electron_1.ipcRenderer.on(IPC.FRAMEBUFFER_UPDATE, (_event, rect) => callback(rect));
    },
    onConnectionState: (callback) => {
        electron_1.ipcRenderer.on(IPC.CONNECTION_STATE, (_event, state) => callback(state));
    },
    onServerInfo: (callback) => {
        electron_1.ipcRenderer.on(IPC.SERVER_INFO, (_event, info) => callback(info));
    },
    onError: (callback) => {
        electron_1.ipcRenderer.on(IPC.ERROR, (_event, msg) => callback(msg));
    },
    onBell: (callback) => {
        electron_1.ipcRenderer.on(IPC.BELL, () => callback());
    },
    onClipboard: (callback) => {
        electron_1.ipcRenderer.on(IPC.CLIPBOARD, (_event, text) => callback(text));
    },
    onDesktopSize: (callback) => {
        electron_1.ipcRenderer.on(IPC.SET_DESKTOP_SIZE, (_event, size) => callback(size));
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
    onMenuShowSettings: (callback) => {
        electron_1.ipcRenderer.on('menu:show-settings', () => callback());
    },
};
electron_1.contextBridge.exposeInMainWorld('vncApi', api);
//# sourceMappingURL=preload.js.map