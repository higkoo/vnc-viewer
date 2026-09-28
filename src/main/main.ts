/**
 * Electron 主进程
 * 管理窗口、IPC 通信、RFB 协议连接
 */

// Electron 32.x：require('electron') 正常导出 API 命名空间
import { app, BrowserWindow, ipcMain, Menu, dialog, MenuItemConstructorOptions } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { RfbClient } from '../rfb/client';
import {
  IPC_CHANNELS, ConnectionState, ConnectionParams, FramebufferRect,
} from '../rfb/types';
import { MobileServer } from '../server/mobileServer';
import { info, warn, error, setLogSender, getLogs, clearLogs } from './logger';

let mainWindow: BrowserWindow | null = null;
let rfbClient: RfbClient | null = null;
let currentConnectionParams: ConnectionParams | null = null;
let mobileServer: MobileServer | null = null;
// 当前帧已解码但尚未发送到渲染进程的矩形（整帧收齐后批量发送，减少 IPC 次数）
let pendingFrameRects: FramebufferRect[] = [];

// ---- 配置管理 ----
// 注意：app.getPath 必须在 app.ready 之后调用，不能作为顶层 const 求值
let _configPath: string | null = null;
function getConfigPath(): string {
  if (!_configPath) {
    _configPath = path.join(app.getPath('userData'), 'config.json');
  }
  return _configPath;
}

interface AppConfig {
  mobilePort: number;
}

function loadConfig(): AppConfig {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    warn(`读取配置文件失败: ${e}`);
  }
  return { mobilePort: 5933 };
}

function saveConfig(config: AppConfig): void {
  try {
    const configPath = getConfigPath();
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    error(`保存配置文件失败: ${e}`);
  }
}

function restartMobileServer(port: number): void {
  if (mobileServer) {
    mobileServer.stop();
    mobileServer = null;
  }
  mobileServer = new MobileServer(port);
  mobileServer.start();
  info(`手机代理已重启，端口: ${port}`);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
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
    const menuTemplate: MenuItemConstructorOptions[] = [
      {
        label: 'VNC Viewer',
        submenu: [
          { role: 'about' as any, label: '关于 VNC Viewer' },
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
          }},
          { label: '退出全屏', accelerator: 'Escape', click: () => {
            mainWindow?.webContents.send('menu:exit-fullscreen');
          }},
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
                dialog.showMessageBox(mainWindow!, {
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
          }},
          { label: '实际大小', accelerator: 'CmdOrCtrl+1', click: () => {
            mainWindow?.webContents.send('menu:zoom-100');
          }},
          { type: 'separator' },
          { label: '查看实时日志', accelerator: 'CmdOrCtrl+L', click: () => {
            mainWindow?.webContents.send('menu:show-logs');
          }},
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

    const menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);
  } else {
    // 非 macOS 平台
    const menuTemplate: MenuItemConstructorOptions[] = [
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
          }},
          { label: '实际大小', accelerator: 'Ctrl+1', click: () => {
            mainWindow?.webContents.send('menu:zoom-100');
          }},
          { type: 'separator' },
          { label: '查看实时日志', accelerator: 'Ctrl+L', click: () => {
            mainWindow?.webContents.send('menu:show-logs');
          }},
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
                dialog.showMessageBox(mainWindow!, {
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
    const menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---- IPC 处理器 ----

function setupIPC(): void {
  ipcMain.handle(IPC_CHANNELS.CONNECT, async (_event, params: ConnectionParams) => {
    if (rfbClient) {
      rfbClient.disconnect();
    }

    currentConnectionParams = params;
    rfbClient = new RfbClient();
    pendingFrameRects = [];

    info(`正在连接 ${params.host}:${params.port} ${params.shared ? '(共享模式)' : ''}`);

    // 状态变更
    rfbClient.on('state', (state: ConnectionState) => {
      mainWindow?.webContents.send(IPC_CHANNELS.CONNECTION_STATE, state);
      info(`连接状态: ${connectionStateLabel(state)}`);
      // 断开后清空引用，让输入 handler 能准确诊断"连接已断开"
      if (state === ConnectionState.Disconnected) {
        rfbClient = null;
      }
    });

    // 帧缓冲更新：先累积到本帧，避免每个矩形都走一次 IPC
    rfbClient.on('framebuffer-update', (rect: FramebufferRect) => {
      // 诊断：每帧首矩形打印像素采样
      if (pendingFrameRects.length === 0 && rect.data.length >= 16) {
        const d = rect.data;
        info(`[DIAG] 帧首矩形 rect=(${rect.x},${rect.y},${rect.width}x${rect.height}) enc=${rect.encoding} dataLen=${rect.data.length}`);
        info(`[DIAG] 前16像素RGBA: ${
          Array.from({length: 4}, (_, i) => `(${d[i*4]},${d[i*4+1]},${d[i*4+2]},${d[i*4+3]})`).join(' ')
        }`);
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
        info(`[DIAG] 帧率: ${frameCount}帧/秒, 更新请求: ${updateRequestCount}次/秒, pendingRects=${pendingFrameRects.length}`);
        frameCount = 0;
        updateRequestCount = 0;
        lastDiagAt = now;
      }
      // --- 帧数据转发给渲染进程 ---
      // 注意：不在此处请求下一帧增量更新。
      // 帧请求由 RfbClient 内部的 pollTimer 统一调度，避免多路请求导致频率失控。
      if (rfbClient && rfbClient.getState() === ConnectionState.Connected) {
        if (pendingFrameRects.length > 0) {
          const rects = pendingFrameRects;
          pendingFrameRects = [];
          // IPC 传输前把每个矩形的 Buffer data 拷贝为新的 Uint8Array，
          // 使用 Uint8Array.from 做拷贝以避免共享 ArrayBuffer 导致的偏移问题
          mainWindow?.webContents.send(IPC_CHANNELS.FRAMEBUFFER_UPDATE, rects.map((r) => ({
            x: r.x, y: r.y, width: r.width, height: r.height,
            encoding: r.encoding,
            data: Uint8Array.from(r.data),
          })));
        }
      }
    });

    // 服务器信息
    rfbClient.on('server-info', (info_: any) => {
      const pf = info_.pixelFormat;
      mainWindow?.webContents.send(IPC_CHANNELS.SERVER_INFO, info_);
      info(`[SERVER-INFO] ${info_.name} ${info_.width}x${info_.height}`);
      if (pf) {
        info(`[SERVER-INFO] 像素格式: ${pf.bitsPerPixel}bpp depth=${pf.depth} ${pf.trueColor ? 'true-color' : 'indexed'} ${pf.bigEndian ? 'BE' : 'LE'}`);
        info(`[SERVER-INFO] R: max=${pf.redMax} shift=${pf.redShift}  G: max=${pf.greenMax} shift=${pf.greenShift}  B: max=${pf.blueMax} shift=${pf.blueShift}`);
      }
    });

    // 诊断：帧请求发送计数
    rfbClient.on('update-request', () => {
      updateRequestCount++;
    });

    // 解码异常后的画面重新同步：请求一次全量更新
    rfbClient.on('framebuffer-resync', () => {
      if (rfbClient && rfbClient.getState() === ConnectionState.Connected) {
        pendingFrameRects = [];
        rfbClient.requestFramebufferUpdate(false);
      }
    });

    // 错误
    rfbClient.on('error', (msg: string) => {
      mainWindow?.webContents.send(IPC_CHANNELS.ERROR, msg);
      error(msg);
    });

    // 桌面大小变化
    rfbClient.on('desktop-size', (size: { width: number; height: number }) => {
      mainWindow?.webContents.send(IPC_CHANNELS.SET_DESKTOP_SIZE, size);
    });

    // 响铃
    rfbClient.on('bell', () => {
      mainWindow?.webContents.send(IPC_CHANNELS.BELL);
    });

    // 剪贴板
    rfbClient.on('clipboard', (text: string) => {
      mainWindow?.webContents.send(IPC_CHANNELS.CLIPBOARD, text);
    });

    // 连接
    rfbClient.connect(params);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.DISCONNECT, async () => {
    if (rfbClient) {
      if (currentConnectionParams) {
        info(`断开连接 ${currentConnectionParams.host}:${currentConnectionParams.port}`);
      }
      rfbClient.disconnect();
      rfbClient = null;
    }
    pendingFrameRects = [];
    return { success: true };
  });

  // 输入事件用 ipcMain.on（非阻塞），避免被帧数据 IPC 排队阻塞
  ipcMain.on(IPC_CHANNELS.KEY_EVENT, (_event, keyCode: number, down: boolean) => {
    if (!rfbClient) {
      warn(`[INPUT-DIAG] keyEvent(${keyCode}, ${down}) 被忽略：rfbClient 为 null（连接可能已断开）`);
      return;
    }
    const sock = rfbClient.getSocket();
    if (!sock || sock.destroyed) {
      warn(`[INPUT-DIAG] keyEvent(${keyCode}, ${down}) 被忽略：socket 已断开`);
      return;
    }
    rfbClient.keyEvent(keyCode, down);
  });

  ipcMain.on(IPC_CHANNELS.POINTER_EVENT, (_event, buttonMask: number, x: number, y: number) => {
    if (!rfbClient) {
      warn(`[INPUT-DIAG] pointerEvent(mask=${buttonMask}, ${x},${y}) 被忽略：rfbClient 为 null（连接可能已断开）`);
      return;
    }
    const sock = rfbClient.getSocket();
    if (!sock || sock.destroyed) {
      warn(`[INPUT-DIAG] pointerEvent(mask=${buttonMask}, ${x},${y}) 被忽略：socket 已断开`);
      return;
    }
    rfbClient.pointerEvent(buttonMask, x, y);
  });

  ipcMain.handle(IPC_CHANNELS.CUT_TEXT, async (_event, text: string) => {
    rfbClient?.sendCutText(text);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.SET_ENCODINGS, async (_event, encodings: number[]) => {
    rfbClient?.setEncodings(encodings);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.SET_PIXEL_FORMAT, async (_event, format: any) => {
    rfbClient?.setPixelFormat(format);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.SET_DESKTOP_SIZE, async (_event, width: number, height: number) => {
    rfbClient?.requestDesktopSize(width, height);
    return { success: true };
  });

  // ---- 实时日志 ----
  ipcMain.handle(IPC_CHANNELS.LOG_GET, async () => getLogs());
  ipcMain.handle(IPC_CHANNELS.LOG_CLEAR, async () => {
    clearLogs();
    return { success: true };
  });

  // ---- 设置 ----
  ipcMain.handle(IPC_CHANNELS.GET_SETTINGS, async () => loadConfig());
  ipcMain.handle(IPC_CHANNELS.SET_SETTINGS, async (_event, settings: AppConfig) => {
    const old = loadConfig();
    saveConfig(settings);
    info(`设置已更新: 手机代理端口 ${old.mobilePort} → ${settings.mobilePort}`);
    if (settings.mobilePort !== old.mobilePort) {
      restartMobileServer(settings.mobilePort);
      mainWindow?.webContents.send(IPC_CHANNELS.MOBILE_PORT_CHANGED, settings.mobilePort);
    }
    return { success: true };
  });
}

// 连接状态的中文描述，便于日志查看
function connectionStateLabel(state: ConnectionState): string {
  switch (state) {
    case ConnectionState.Disconnected: return '已断开';
    case ConnectionState.Connecting: return '正在连接...';
    case ConnectionState.ProtocolVersion: return '协议握手 (版本协商)';
    case ConnectionState.Security: return '安全类型协商';
    case ConnectionState.Authentication: return '认证中...';
    case ConnectionState.ClientInit: return '客户端初始化';
    case ConnectionState.ServerInit: return '服务端初始化';
    case ConnectionState.Connected: return '已连接';
    case ConnectionState.Error: return '错误';
    default: return `未知(${state})`;
  }
}

// ---- 应用生命周期 ----

app.whenReady().then(() => {
  // 将主进程日志实时推送给渲染进程
  setLogSender((entry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.APP_LOG, entry);
    }
  });

  setupIPC();
  createWindow();

  info('VNC Viewer 已启动');
  info(`平台: ${process.platform} ${process.arch}`);

  // 启动手机代理服务器（使用配置中的端口）
  const config = loadConfig();
  mobileServer = new MobileServer(config.mobilePort);
  mobileServer.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // macOS 关窗后 app 常驻，重新打开窗口时若手机代理已停止则按配置恢复
      if (!mobileServer) {
        restartMobileServer(loadConfig().mobilePort);
      }
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (rfbClient) {
    rfbClient.disconnect();
    rfbClient = null;
  }
  if (mobileServer) {
    mobileServer.stop();
    mobileServer = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});