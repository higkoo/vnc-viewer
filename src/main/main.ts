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
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // 安全：禁止窗口通过 window.open 打开新窗口
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 安全：禁止页面导航到本地文件以外的地址（VNC Viewer 是本地应用，无需外跳）
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
    }
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

// ---- 连接监督：意外断线自动重连（指数退避）----
// 设计参考 TencentCloud/Octop 的会话管理哲学：仅对“已建立的活跃流”做有界
// 重试；用户主动断开、认证失败等致命错误不重试；退避 1s→2s→4s…（上限 30s），
// 最多 10 次后放弃并明确告知用户，避免无限重试耗尽资源。
let userInitiatedDisconnect = false;
let reconnectAttempts = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
/** 已为其安排重连的连接实例（同一连接的 error/dropped 成对触发只安排一次） */
let reconnectScheduledFor: RfbClient | null = null;
const RECONNECT_MAX_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;

function cancelReconnect(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function notifyReconnectStatus(status: {
  reconnecting: boolean; attempt?: number; maxAttempts?: number; delayMs?: number;
}): void {
  mainWindow?.webContents.send(IPC_CHANNELS.RECONNECT_STATUS, status);
}

/**
 * 安排一次自动重连（指数退避）。
 * @param reason 中断原因（日志/UI 用）
 * @param client 触发重连的连接实例；同一实例的重复触发（error 与 dropped
 *   成对出现）不会重复安排，避免退避级别被无谓跳过。
 */
function scheduleReconnect(reason: string, client?: RfbClient): void {
  if (client !== undefined && reconnectScheduledFor === client && reconnectTimer !== null) {
    return;
  }
  reconnectScheduledFor = client ?? null;
  cancelReconnect();
  if (userInitiatedDisconnect || !currentConnectionParams) return;

  if (reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
    const msg = `连接持续中断，自动重连已放弃（已尝试 ${RECONNECT_MAX_ATTEMPTS} 次）：${reason}`;
    error(msg);
    notifyReconnectStatus({ reconnecting: false });
    mainWindow?.webContents.send(IPC_CHANNELS.ERROR, msg);
    return;
  }

  reconnectAttempts++;
  const delayMs = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempts - 1),
    RECONNECT_MAX_DELAY_MS,
  );
  info(`连接意外中断（${reason}），${(delayMs / 1000).toFixed(1)}s 后进行第 ${reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS} 次重连`);
  notifyReconnectStatus({
    reconnecting: true, attempt: reconnectAttempts,
    maxAttempts: RECONNECT_MAX_ATTEMPTS, delayMs,
  });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (currentConnectionParams && !userInitiatedDisconnect) {
      startConnection(currentConnectionParams);
    }
  }, delayMs);
}

/** 建立 RFB 连接并挂接全部事件（首次连接与自动重连共用） */
function startConnection(params: ConnectionParams): void {
  if (rfbClient) {
    rfbClient.disconnect();
    rfbClient = null;
  }
  pendingFrameRects = [];
  rfbClient = new RfbClient();
  // 闭包捕获本次连接的实例：'state' handler 在断线时会把模块级 rfbClient
  // 置空，后续 dropped/error 回调需要仍能访问本实例
  const client = rfbClient;

  info(`正在连接 ${params.host}:${params.port} ${params.shared ? '(共享模式)' : ''}`);

  // 状态变更
  client.on('state', (state: ConnectionState) => {
      mainWindow?.webContents.send(IPC_CHANNELS.CONNECTION_STATE, state);
      info(`连接状态: ${connectionStateLabel(state)}`);
      // 断开后清空引用，让输入 handler 能准确诊断"连接已断开"
      if (state === ConnectionState.Disconnected) {
        rfbClient = null;
      }
    });

    // 帧缓冲更新：先累积到本帧，避免每个矩形都走一次 IPC
    client.on('framebuffer-update', (rect: FramebufferRect) => {
      pendingFrameRects.push(rect);
    });

    // 帧缓冲完成：整帧收齐后批量发给渲染进程（不再输出高频 [DIAG] 日志，避免拖慢主进程）
    client.on('framebuffer-done', () => {
      // --- 帧数据转发给渲染进程 ---
      // 注意：不在此处请求下一帧增量更新。
      // 帧请求由 RfbClient 内部的 pollTimer 统一调度，避免多路请求导致频率失控。
      if (rfbClient && rfbClient.getState() === ConnectionState.Connected) {
        if (pendingFrameRects.length > 0) {
          const rects = pendingFrameRects;
          pendingFrameRects = [];
          // IPC 传输前用零拷贝视图包装 Buffer（不复制数据，仅引用原 ArrayBuffer 的偏移区间），
          // Electron structured clone 会正确按视图边界序列化，避免共享 ArrayBuffer 的偏移问题
          mainWindow?.webContents.send(IPC_CHANNELS.FRAMEBUFFER_UPDATE, rects.map((r) => ({
            x: r.x, y: r.y, width: r.width, height: r.height,
            encoding: r.encoding,
            data: new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength),
          })));
        }
      }
    });

    // 服务器信息（握手完成）：重连成功则重置退避计数
    client.on('server-info', (info_: any) => {
      const pf = info_.pixelFormat;
      mainWindow?.webContents.send(IPC_CHANNELS.SERVER_INFO, info_);
      if (reconnectAttempts > 0) {
        info(`自动重连成功（第 ${reconnectAttempts} 次尝试）`);
        reconnectAttempts = 0;
        reconnectScheduledFor = null;
        cancelReconnect();
        notifyReconnectStatus({ reconnecting: false });
      }
      info(`[SERVER-INFO] ${info_.name} ${info_.width}x${info_.height}`);
      if (pf) {
        info(`[SERVER-INFO] 像素格式: ${pf.bitsPerPixel}bpp depth=${pf.depth} ${pf.trueColor ? 'true-color' : 'indexed'} ${pf.bigEndian ? 'BE' : 'LE'}`);
        info(`[SERVER-INFO] R: max=${pf.redMax} shift=${pf.redShift}  G: max=${pf.greenMax} shift=${pf.greenShift}  B: max=${pf.blueMax} shift=${pf.blueShift}`);
      }
    });

    // 解码异常后的画面重新同步：请求一次全量刷新
    client.on('framebuffer-resync', () => {
      if (rfbClient && rfbClient.getState() === ConnectionState.Connected) {
        pendingFrameRects = [];
        rfbClient.requestFramebufferUpdate(false);
      }
    });

    // 错误分两类：
    // 1. 致命错误（认证失败等）→ 直接通知用户，放弃重连；
    // 2. 非致命错误 → 若已在重连流程中（重连尝试本身连不上），安排下一次
    //    退避重试，保证重连链不断；首次连接的失败仍按立即报错处理。
    client.on('error', (msg: string) => {
      if (client.isFatal()) {
        mainWindow?.webContents.send(IPC_CHANNELS.ERROR, msg);
        error(msg);
      } else if (reconnectAttempts > 0) {
        warn(`重连尝试失败（${msg}），将按退避继续重试`);
        scheduleReconnect(msg, client);
      } else {
        mainWindow?.webContents.send(IPC_CHANNELS.ERROR, msg);
        error(msg);
      }
    });

    // 意外断线（已建立的连接非用户主动断开）：安排自动重连
    client.on('dropped', (reason: string) => {
      if (client.isFatal()) return; // 双保险：致命错误不重连
      scheduleReconnect(reason, client);
    });

    // 桌面大小变化
    client.on('desktop-size', (size: { width: number; height: number }) => {
      mainWindow?.webContents.send(IPC_CHANNELS.SET_DESKTOP_SIZE, size);
    });

    // 带宽测量（每秒 bytes/sec，供状态栏显示）
    client.on('bandwidth', (bytesPerSec: number) => {
      mainWindow?.webContents.send(IPC_CHANNELS.BANDWIDTH, bytesPerSec);
    });

    // 响铃
    client.on('bell', () => {
      mainWindow?.webContents.send(IPC_CHANNELS.BELL);
    });

    // 剪贴板
    client.on('clipboard', (text: string) => {
      mainWindow?.webContents.send(IPC_CHANNELS.CLIPBOARD, text);
    });

    // 连接
    client.connect(params);
}

function setupIPC(): void {
  ipcMain.handle(IPC_CHANNELS.CONNECT, async (_event, params: ConnectionParams) => {
    // 参数校验：host 必须非空字符串，port 必须为 1-65535 的整数，不合法直接拒绝
    const hostValid = typeof params?.host === 'string' && params.host.trim().length > 0;
    const portValid = Number.isInteger(params?.port) && (params as ConnectionParams).port >= 1 && (params as ConnectionParams).port <= 65535;
    if (!hostValid || !portValid) {
      warn(`连接参数非法: host=${JSON.stringify(params?.host)}, port=${JSON.stringify(params?.port)}`);
      return { success: false, error: '连接参数非法：host 不能为空，port 必须为 1-65535 的整数' };
    }

    // 用户主动发起的新连接：清零重连状态
    userInitiatedDisconnect = false;
    reconnectAttempts = 0;
    reconnectScheduledFor = null;
    cancelReconnect();
    currentConnectionParams = params;
    notifyReconnectStatus({ reconnecting: false });

    startConnection(params);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.DISCONNECT, async () => {
    // 用户主动断开：取消一切自动重连
    userInitiatedDisconnect = true;
    cancelReconnect();
    if (rfbClient) {
      if (currentConnectionParams) {
        info(`断开连接 ${currentConnectionParams.host}:${currentConnectionParams.port}`);
      }
      rfbClient.disconnect();
      rfbClient = null;
    }
    pendingFrameRects = [];
    notifyReconnectStatus({ reconnecting: false });
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
  // 窗口关闭：取消一切自动重连，避免后台重连泄漏连接
  userInitiatedDisconnect = true;
  cancelReconnect();
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