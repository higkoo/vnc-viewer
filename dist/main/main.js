"use strict";
/**
 * Electron 主进程
 * 管理窗口、IPC 通信、RFB 协议连接
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const client_1 = require("../rfb/client");
const types_1 = require("../rfb/types");
const mobileServer_1 = require("../server/mobileServer");
const logger_1 = require("./logger");
let mainWindow = null;
let rfbClient = null;
let currentConnectionParams = null;
let mobileServer = null;
// ---- 配置管理 ----
const CONFIG_PATH = path.join(electron_1.app.getPath('userData'), 'config.json');
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const data = fs.readFileSync(CONFIG_PATH, 'utf8');
            return JSON.parse(data);
        }
    }
    catch (e) {
        (0, logger_1.warn)(`读取配置文件失败: ${e}`);
    }
    return { mobilePort: 5933 };
}
function saveConfig(config) {
    try {
        const dir = path.dirname(CONFIG_PATH);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    }
    catch (e) {
        (0, logger_1.error)(`保存配置文件失败: ${e}`);
    }
}
function restartMobileServer(port) {
    if (mobileServer) {
        mobileServer.stop();
        mobileServer = null;
    }
    mobileServer = new mobileServer_1.MobileServer(port);
    mobileServer.start();
    (0, logger_1.info)(`手机代理已重启，端口: ${port}`);
}
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1024,
        height: 768,
        minWidth: 640,
        minHeight: 480,
        title: 'VNC Viewer',
        backgroundColor: '#1a1a2e',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    // macOS 原生菜单
    if (process.platform === 'darwin') {
        const menuTemplate = [
            {
                label: 'VNC Viewer',
                submenu: [
                    { role: 'about', label: '关于 VNC Viewer' },
                    { type: 'separator' },
                    { role: 'hide', label: '隐藏' },
                    { role: 'hideOthers', label: '隐藏其他' },
                    { role: 'unhide', label: '全部显示' },
                    { type: 'separator' },
                    { role: 'quit', label: '退出' },
                ],
            },
            {
                label: '连接',
                submenu: [
                    {
                        label: '新建连接...',
                        accelerator: 'CmdOrCtrl+N',
                        click: () => mainWindow?.webContents.send('menu:new-connection'),
                    },
                    {
                        label: '断开连接',
                        accelerator: 'CmdOrCtrl+D',
                        click: () => mainWindow?.webContents.send('menu:disconnect'),
                    },
                    { type: 'separator' },
                    { label: '全屏', accelerator: 'CmdOrCtrl+Shift+F', click: () => {
                            mainWindow?.webContents.send('menu:toggle-fullscreen');
                        } },
                    { label: '退出全屏', accelerator: 'Escape', click: () => {
                            mainWindow?.webContents.send('menu:exit-fullscreen');
                        } },
                ],
            },
            {
                label: '手机',
                submenu: [
                    {
                        label: '显示手机连接信息',
                        click: () => {
                            if (mobileServer) {
                                const port = mobileServer.getPort();
                                electron_1.dialog.showMessageBox(mainWindow, {
                                    type: 'info',
                                    title: '手机连接信息',
                                    message: '在手机浏览器中打开以下地址：',
                                    detail: `http://<本机IP>:${port}\n\n确保手机和电脑在同一网络下。`,
                                });
                            }
                        },
                    },
                    { type: 'separator' },
                    {
                        label: '查看实时日志',
                        accelerator: 'CmdOrCtrl+L',
                        click: () => mainWindow?.webContents.send('menu:show-logs'),
                    },
                    { type: 'separator' },
                    {
                        label: '设置...',
                        accelerator: 'CmdOrCtrl+,',
                        click: () => mainWindow?.webContents.send('menu:show-settings'),
                    },
                ],
            },
            {
                label: '视图',
                submenu: [
                    { label: '缩放至窗口', accelerator: 'CmdOrCtrl+0', click: () => {
                            mainWindow?.webContents.send('menu:zoom-fit');
                        } },
                    { label: '实际大小', accelerator: 'CmdOrCtrl+1', click: () => {
                            mainWindow?.webContents.send('menu:zoom-100');
                        } },
                    { type: 'separator' },
                    { label: '查看实时日志', accelerator: 'CmdOrCtrl+L', click: () => {
                            mainWindow?.webContents.send('menu:show-logs');
                        } },
                    { type: 'separator' },
                    { role: 'toggleDevTools', label: '开发者工具' },
                ],
            },
            {
                label: '窗口',
                submenu: [
                    { role: 'minimize', label: '最小化' },
                    { role: 'zoom', label: '缩放' },
                    { role: 'close', label: '关闭窗口' },
                ],
            },
        ];
        const menu = electron_1.Menu.buildFromTemplate(menuTemplate);
        electron_1.Menu.setApplicationMenu(menu);
    }
    else {
        // 非 macOS 平台
        const menuTemplate = [
            {
                label: '连接',
                submenu: [
                    {
                        label: '新建连接',
                        accelerator: 'Ctrl+N',
                        click: () => mainWindow?.webContents.send('menu:new-connection'),
                    },
                    {
                        label: '断开连接',
                        accelerator: 'Ctrl+D',
                        click: () => mainWindow?.webContents.send('menu:disconnect'),
                    },
                    { type: 'separator' },
                    { label: '退出', role: 'quit' },
                ],
            },
            {
                label: '视图',
                submenu: [
                    { label: '缩放至窗口', accelerator: 'Ctrl+0', click: () => {
                            mainWindow?.webContents.send('menu:zoom-fit');
                        } },
                    { label: '实际大小', accelerator: 'Ctrl+1', click: () => {
                            mainWindow?.webContents.send('menu:zoom-100');
                        } },
                    { type: 'separator' },
                    { label: '查看实时日志', accelerator: 'Ctrl+L', click: () => {
                            mainWindow?.webContents.send('menu:show-logs');
                        } },
                    { type: 'separator' },
                    { role: 'toggleDevTools' },
                ],
            },
            {
                label: '手机',
                submenu: [
                    {
                        label: '显示手机连接信息',
                        click: () => {
                            if (mobileServer) {
                                const port = mobileServer.getPort();
                                electron_1.dialog.showMessageBox(mainWindow, {
                                    type: 'info',
                                    title: '手机连接信息',
                                    message: '在手机浏览器中打开以下地址：',
                                    detail: `http://<本机IP>:${port}\n\n确保手机和电脑在同一网络下。`,
                                });
                            }
                        },
                    },
                    { type: 'separator' },
                    {
                        label: '查看实时日志',
                        accelerator: 'Ctrl+L',
                        click: () => mainWindow?.webContents.send('menu:show-logs'),
                    },
                    { type: 'separator' },
                    {
                        label: '设置',
                        accelerator: 'Ctrl+,',
                        click: () => mainWindow?.webContents.send('menu:show-settings'),
                    },
                ],
            },
        ];
        const menu = electron_1.Menu.buildFromTemplate(menuTemplate);
        electron_1.Menu.setApplicationMenu(menu);
    }
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}
// ---- IPC 处理器 ----
function setupIPC() {
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.CONNECT, async (_event, params) => {
        if (rfbClient) {
            rfbClient.disconnect();
        }
        currentConnectionParams = params;
        rfbClient = new client_1.RfbClient();
        (0, logger_1.info)(`正在连接 ${params.host}:${params.port} ${params.shared ? '(共享模式)' : ''}`);
        // 状态变更
        rfbClient.on('state', (state) => {
            mainWindow?.webContents.send(types_1.IPC_CHANNELS.CONNECTION_STATE, state);
            (0, logger_1.info)(`连接状态: ${connectionStateLabel(state)}`);
        });
        // 帧缓冲更新
        rfbClient.on('framebuffer-update', (rect) => {
            mainWindow?.webContents.send(types_1.IPC_CHANNELS.FRAMEBUFFER_UPDATE, rect);
        });
        // 帧缓冲完成
        rfbClient.on('framebuffer-done', () => {
            // 请求增量更新
            if (rfbClient && rfbClient.getState() === types_1.ConnectionState.Connected) {
                rfbClient.requestFramebufferUpdate(true);
            }
        });
        // 服务器信息
        rfbClient.on('server-info', (info_) => {
            mainWindow?.webContents.send(types_1.IPC_CHANNELS.SERVER_INFO, info_);
            (0, logger_1.info)(`收到服务器信息: ${info_.name} ${info_.width}x${info_.height}`);
        });
        // 错误
        rfbClient.on('error', (msg) => {
            mainWindow?.webContents.send(types_1.IPC_CHANNELS.ERROR, msg);
            (0, logger_1.error)(msg);
        });
        // 桌面大小变化
        rfbClient.on('desktop-size', (size) => {
            mainWindow?.webContents.send(types_1.IPC_CHANNELS.SET_DESKTOP_SIZE, size);
        });
        // 响铃
        rfbClient.on('bell', () => {
            mainWindow?.webContents.send(types_1.IPC_CHANNELS.BELL);
        });
        // 剪贴板
        rfbClient.on('clipboard', (text) => {
            mainWindow?.webContents.send(types_1.IPC_CHANNELS.CLIPBOARD, text);
        });
        // 连接
        rfbClient.connect(params);
        return { success: true };
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.DISCONNECT, async () => {
        if (rfbClient) {
            if (currentConnectionParams) {
                (0, logger_1.info)(`断开连接 ${currentConnectionParams.host}:${currentConnectionParams.port}`);
            }
            rfbClient.disconnect();
            rfbClient = null;
        }
        return { success: true };
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.KEY_EVENT, async (_event, keyCode, down) => {
        rfbClient?.keyEvent(keyCode, down);
        return { success: true };
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.POINTER_EVENT, async (_event, buttonMask, x, y) => {
        rfbClient?.pointerEvent(buttonMask, x, y);
        return { success: true };
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.CUT_TEXT, async (_event, text) => {
        rfbClient?.sendCutText(text);
        return { success: true };
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SET_ENCODINGS, async (_event, encodings) => {
        rfbClient?.setEncodings(encodings);
        return { success: true };
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SET_PIXEL_FORMAT, async (_event, format) => {
        rfbClient?.setPixelFormat(format);
        return { success: true };
    });
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SET_DESKTOP_SIZE, async (_event, width, height) => {
        rfbClient?.requestDesktopSize(width, height);
        return { success: true };
    });
    // ---- 实时日志 ----
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LOG_GET, async () => (0, logger_1.getLogs)());
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.LOG_CLEAR, async () => {
        (0, logger_1.clearLogs)();
        return { success: true };
    });
    // ---- 设置 ----
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.GET_SETTINGS, async () => loadConfig());
    electron_1.ipcMain.handle(types_1.IPC_CHANNELS.SET_SETTINGS, async (_event, settings) => {
        const old = loadConfig();
        saveConfig(settings);
        (0, logger_1.info)(`设置已更新: 手机代理端口 ${old.mobilePort} → ${settings.mobilePort}`);
        if (settings.mobilePort !== old.mobilePort) {
            restartMobileServer(settings.mobilePort);
            mainWindow?.webContents.send(types_1.IPC_CHANNELS.MOBILE_PORT_CHANGED, settings.mobilePort);
        }
        return { success: true };
    });
}
// 连接状态的中文描述，便于日志查看
function connectionStateLabel(state) {
    switch (state) {
        case types_1.ConnectionState.Disconnected: return '已断开';
        case types_1.ConnectionState.Connecting: return '正在连接...';
        case types_1.ConnectionState.ProtocolVersion: return '协议握手 (版本协商)';
        case types_1.ConnectionState.Security: return '安全类型协商';
        case types_1.ConnectionState.Authentication: return '认证中...';
        case types_1.ConnectionState.ClientInit: return '客户端初始化';
        case types_1.ConnectionState.ServerInit: return '服务端初始化';
        case types_1.ConnectionState.Connected: return '已连接';
        case types_1.ConnectionState.Error: return '错误';
        default: return `未知(${state})`;
    }
}
// ---- 应用生命周期 ----
electron_1.app.whenReady().then(() => {
    // 将主进程日志实时推送给渲染进程
    (0, logger_1.setLogSender)((entry) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(types_1.IPC_CHANNELS.APP_LOG, entry);
        }
    });
    setupIPC();
    createWindow();
    (0, logger_1.info)('VNC Viewer 已启动');
    (0, logger_1.info)(`平台: ${process.platform} ${process.arch}`);
    // 启动手机代理服务器（使用配置中的端口）
    const config = loadConfig();
    mobileServer = new mobileServer_1.MobileServer(config.mobilePort);
    mobileServer.start();
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
electron_1.app.on('window-all-closed', () => {
    if (rfbClient) {
        rfbClient.disconnect();
        rfbClient = null;
    }
    if (mobileServer) {
        mobileServer.stop();
        mobileServer = null;
    }
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
//# sourceMappingURL=main.js.map