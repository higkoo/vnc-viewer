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
// Electron 32.x：require('electron') 正常导出 API 命名空间
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
// 当前帧已解码但尚未发送到渲染进程的矩形（整帧收齐后批量发送，减少 IPC 次数）
let pendingFrameRects = [];
// ---- 配置管理 ----
// 注意：app.getPath 必须在 app.ready 之后调用，不能作为顶层 const 求值
let _configPath = null;
function getConfigPath() {
    if (!_configPath) {
        _configPath = path.join(electron_1.app.getPath('userData'), 'config.json');
    }
    return _configPath;
}
function loadConfig() {
    try {
        const configPath = getConfigPath();
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf8');
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
        const configPath = getConfigPath();
        const dir = path.dirname(configPath);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
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
        pendingFrameRects = [];
        (0, logger_1.info)(`正在连接 ${params.host}:${params.port} ${params.shared ? '(共享模式)' : ''}`);
        // 状态变更
        rfbClient.on('state', (state) => {
            mainWindow?.webContents.send(types_1.IPC_CHANNELS.CONNECTION_STATE, state);
            (0, logger_1.info)(`连接状态: ${connectionStateLabel(state)}`);
            // 断开后清空引用，让输入 handler 能准确诊断"连接已断开"
            if (state === types_1.ConnectionState.Disconnected) {
                rfbClient = null;
            }
        });
        // 帧缓冲更新：先累积到本帧，避免每个矩形都走一次 IPC
        rfbClient.on('framebuffer-update', (rect) => {
            // 诊断：每帧首矩形打印像素采样
            if (pendingFrameRects.length === 0 && rect.data.length >= 16) {
                const d = rect.data;
                (0, logger_1.info)(`[DIAG] 帧首矩形 rect=(${rect.x},${rect.y},${rect.width}x${rect.height}) enc=${rect.encoding} dataLen=${rect.data.length}`);
                (0, logger_1.info)(`[DIAG] 前16像素RGBA: ${Array.from({ length: 4 }, (_, i) => `(${d[i * 4]},${d[i * 4 + 1]},${d[i * 4 + 2]},${d[i * 4 + 3]})`).join(' ')}`);
            }
            pendingFrameRects.push(rect);
        });
        // 帧缓冲完成：整帧收齐后批量发给渲染进程，再请求下一帧增量更新
        // 同时在此处做诊断统计（帧率、更新请求频率），每秒输出一次汇总
        let frameCount = 0;
        let updateRequestCount = 0;
        let lastDiagAt = Date.now();
        rfbClient.on('framebuffer-done', () => {
            // --- 诊断统计 ---
            frameCount++;
            const now = Date.now();
            if (now - lastDiagAt >= 1000) {
                (0, logger_1.info)(`[DIAG] 帧率: ${frameCount}帧/秒, 更新请求: ${updateRequestCount}次/秒, pendingRects=${pendingFrameRects.length}`);
                frameCount = 0;
                updateRequestCount = 0;
                lastDiagAt = now;
            }
            // --- 帧数据转发给渲染进程 ---
            // 注意：不在此处请求下一帧增量更新。
            // 帧请求由 RfbClient 内部的 pollTimer 统一调度，避免多路请求导致频率失控。
            if (rfbClient && rfbClient.getState() === types_1.ConnectionState.Connected) {
                if (pendingFrameRects.length > 0) {
                    const rects = pendingFrameRects;
                    pendingFrameRects = [];
                    // IPC 传输前把每个矩形的 Buffer data 拷贝为新的 Uint8Array，
                    // 使用 Uint8Array.from 做拷贝以避免共享 ArrayBuffer 导致的偏移问题
                    mainWindow?.webContents.send(types_1.IPC_CHANNELS.FRAMEBUFFER_UPDATE, rects.map((r) => ({
                        x: r.x, y: r.y, width: r.width, height: r.height,
                        encoding: r.encoding,
                        data: Uint8Array.from(r.data),
                    })));
                }
            }
        });
        // 服务器信息
        rfbClient.on('server-info', (info_) => {
            const pf = info_.pixelFormat;
            mainWindow?.webContents.send(types_1.IPC_CHANNELS.SERVER_INFO, info_);
            (0, logger_1.info)(`[SERVER-INFO] ${info_.name} ${info_.width}x${info_.height}`);
            if (pf) {
                (0, logger_1.info)(`[SERVER-INFO] 像素格式: ${pf.bitsPerPixel}bpp depth=${pf.depth} ${pf.trueColor ? 'true-color' : 'indexed'} ${pf.bigEndian ? 'BE' : 'LE'}`);
                (0, logger_1.info)(`[SERVER-INFO] R: max=${pf.redMax} shift=${pf.redShift}  G: max=${pf.greenMax} shift=${pf.greenShift}  B: max=${pf.blueMax} shift=${pf.blueShift}`);
            }
        });
        // 诊断：帧请求发送计数
        rfbClient.on('update-request', () => {
            updateRequestCount++;
        });
        // 解码异常后的画面重新同步：请求一次全量更新
        rfbClient.on('framebuffer-resync', () => {
            if (rfbClient && rfbClient.getState() === types_1.ConnectionState.Connected) {
                pendingFrameRects = [];
                rfbClient.requestFramebufferUpdate(false);
            }
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
        pendingFrameRects = [];
        return { success: true };
    });
    // 输入事件用 ipcMain.on（非阻塞），避免被帧数据 IPC 排队阻塞
    electron_1.ipcMain.on(types_1.IPC_CHANNELS.KEY_EVENT, (_event, keyCode, down) => {
        if (!rfbClient) {
            (0, logger_1.warn)(`[INPUT-DIAG] keyEvent(${keyCode}, ${down}) 被忽略：rfbClient 为 null（连接可能已断开）`);
            return;
        }
        const sock = rfbClient.getSocket();
        if (!sock || sock.destroyed) {
            (0, logger_1.warn)(`[INPUT-DIAG] keyEvent(${keyCode}, ${down}) 被忽略：socket 已断开`);
            return;
        }
        rfbClient.keyEvent(keyCode, down);
    });
    electron_1.ipcMain.on(types_1.IPC_CHANNELS.POINTER_EVENT, (_event, buttonMask, x, y) => {
        if (!rfbClient) {
            (0, logger_1.warn)(`[INPUT-DIAG] pointerEvent(mask=${buttonMask}, ${x},${y}) 被忽略：rfbClient 为 null（连接可能已断开）`);
            return;
        }
        const sock = rfbClient.getSocket();
        if (!sock || sock.destroyed) {
            (0, logger_1.warn)(`[INPUT-DIAG] pointerEvent(mask=${buttonMask}, ${x},${y}) 被忽略：socket 已断开`);
            return;
        }
        rfbClient.pointerEvent(buttonMask, x, y);
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
            // macOS 关窗后 app 常驻，重新打开窗口时若手机代理已停止则按配置恢复
            if (!mobileServer) {
                restartMobileServer(loadConfig().mobilePort);
            }
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