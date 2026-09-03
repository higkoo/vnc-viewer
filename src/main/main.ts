/**
 * Electron 主进程
 * 管理窗口、IPC 通信、RFB 协议连接
 */

import { app, BrowserWindow, ipcMain, Menu, dialog, MenuItemConstructorOptions } from 'electron';
import * as path from 'path';
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

    info(`正在连接 ${params.host}:${params.port} ${params.shared ? '(共享模式)' : ''}`);

    // 状态变更
    rfbClient.on('state', (state: ConnectionState) => {
      mainWindow?.webContents.send(IPC_CHANNELS.CONNECTION_STATE, state);
      info(`连接状态: ${connectionStateLabel(state)}`);
    });

    // 帧缓冲更新
    rfbClient.on('framebuffer-update', (rect: FramebufferRect) => {
      mainWindow?.webContents.send(IPC_CHANNELS.FRAMEBUFFER_UPDATE, rect);
    });

    // 帧缓冲完成
    rfbClient.on('framebuffer-done', () => {
      // 请求增量更新
      if (rfbClient && rfbClient.getState() === ConnectionState.Connected) {
        rfbClient.requestFramebufferUpdate(true);
      }
    });

    // 服务器信息
    rfbClient.on('server-info', (info_: any) => {
      mainWindow?.webContents.send(IPC_CHANNELS.SERVER_INFO, info_);
      info(`收到服务器信息: ${info_.name} ${info_.width}x${info_.height}`);
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
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.KEY_EVENT, async (_event, keyCode: number, down: boolean) => {
    rfbClient?.keyEvent(keyCode, down);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.POINTER_EVENT, async (_event, buttonMask: number, x: number, y: number) => {
    rfbClient?.pointerEvent(buttonMask, x, y);
    return { success: true };
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

  // 启动手机代理服务器
  mobileServer = new MobileServer();
  mobileServer.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
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