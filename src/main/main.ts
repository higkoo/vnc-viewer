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

let mainWindow: BrowserWindow | null = null;
let rfbClient: RfbClient | null = null;
let currentConnectionParams: ConnectionParams | null = null;

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
        label: '视图',
        submenu: [
          { label: '缩放至窗口', accelerator: 'CmdOrCtrl+0', click: () => {
            mainWindow?.webContents.send('menu:zoom-fit');
          }},
          { label: '实际大小', accelerator: 'CmdOrCtrl+1', click: () => {
            mainWindow?.webContents.send('menu:zoom-100');
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
          { role: 'toggleDevTools' },
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

    // 状态变更
    rfbClient.on('state', (state: ConnectionState) => {
      mainWindow?.webContents.send(IPC_CHANNELS.CONNECTION_STATE, state);
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
    rfbClient.on('server-info', (info: any) => {
      mainWindow?.webContents.send(IPC_CHANNELS.SERVER_INFO, info);
    });

    // 错误
    rfbClient.on('error', (msg: string) => {
      mainWindow?.webContents.send(IPC_CHANNELS.ERROR, msg);
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
}

// ---- 应用生命周期 ----

app.whenReady().then(() => {
  setupIPC();
  createWindow();

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
  if (process.platform !== 'darwin') {
    app.quit();
  }
});