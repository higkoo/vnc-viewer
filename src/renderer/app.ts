/**
 * VNC Viewer 渲染进程 - UI 逻辑
 * 参考 UltraVNC vncviewer 界面设计
 */

// ---- 类型声明 ----
interface VncApi {
  connect: (params: any) => Promise<any>;
  disconnect: () => Promise<any>;
  keyEvent: (keyCode: number, down: boolean) => Promise<any>;
  pointerEvent: (buttonMask: number, x: number, y: number) => Promise<any>;
  sendCutText: (text: string) => Promise<any>;
  onFramebufferUpdate: (callback: (rect: any) => void) => void;
  onConnectionState: (callback: (state: number) => void) => void;
  onServerInfo: (callback: (info: any) => void) => void;
  onError: (callback: (msg: string) => void) => void;
  onReconnectStatus: (callback: (status: { reconnecting: boolean; attempt?: number; maxAttempts?: number; delayMs?: number }) => void) => void;
  onBell: (callback: () => void) => void;
  onClipboard: (callback: (text: string) => void) => void;
  onBandwidth: (callback: (bytesPerSec: number) => void) => void;
  onDesktopSize: (callback: (size: any) => void) => void;
  onMenuNewConnection: (callback: () => void) => void;
  onMenuDisconnect: (callback: () => void) => void;
  onMenuToggleFullscreen: (callback: () => void) => void;
  onMenuExitFullscreen: (callback: () => void) => void;
  onMenuZoomFit: (callback: () => void) => void;
  onMenuZoom100: (callback: () => void) => void;
  onMenuResizeWindowToRemote: (callback: () => void) => void;
  onMenuShowLogs: (callback: () => void) => void;
  onMenuShowSettings: (callback: () => void) => void;
  getLogs: () => Promise<any>;
  clearLogs: () => Promise<any>;
  onLog: (callback: (entry: { time: string; level: string; msg: string }) => void) => void;
  getSettings: () => Promise<any>;
  setSettings: (settings: any) => Promise<any>;
  resizeWindowToContent: (width: number, height: number) => Promise<any>;
  onMobilePortChanged: (callback: (port: number) => void) => void;
}

declare var vncApi: VncApi;

// ---- 状态 ----
enum ConnectionState {
  Disconnected = 0,
  Connecting = 1,
  ProtocolVersion = 2,
  Security = 3,
  Authentication = 4,
  ClientInit = 5,
  ServerInit = 6,
  Connected = 7,
  Error = 8,
}

// 响铃用的 AudioContext 单例：首次使用时才创建，之后复用（浏览器对 AudioContext 数量有限制）
let audioContext: AudioContext | null = null;
function getAudioContext(): AudioContext {
  if (!audioContext) {
    audioContext = new AudioContext();
  }
  return audioContext;
}

// ---- DOM 引用 ----
function getEl<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const dialog = getEl<HTMLDivElement>('connection-dialog');
const hostInput = getEl<HTMLInputElement>('host');
const portInput = getEl<HTMLInputElement>('port');
const displayInput = getEl<HTMLInputElement>('display');
const passwordInput = getEl<HTMLInputElement>('password');
const sharedCheck = getEl<HTMLInputElement>('shared');
const connectBtn = getEl<HTMLButtonElement>('connect-btn');
const errorMsg = getEl<HTMLDivElement>('error-msg');
const optionsToggle = getEl<HTMLButtonElement>('options-toggle');
const optionsPanel = getEl<HTMLDivElement>('options-panel');
const statusIndicator = getEl<HTMLSpanElement>('status-indicator');
const statusText = getEl<HTMLSpanElement>('status-text');
const serverInfoText = getEl<HTMLSpanElement>('server-info-text');
const statsText = getEl<HTMLSpanElement>('stats-text');
const zoomText = getEl<HTMLSpanElement>('zoom-text');
const zoomIconFit = getEl<HTMLElement>('zoom-icon-fit');
const zoomIcon100 = getEl<HTMLElement>('zoom-icon-100');
const toolbarEl = getEl<HTMLDivElement>('toolbar');
const canvas = getEl<HTMLCanvasElement>('vnc-canvas');
const emptyState = getEl<HTMLDivElement>('empty-state');
const viewport = getEl<HTMLDivElement>('viewport-container');
const btnNewConn = getEl<HTMLButtonElement>('btn-new-conn');
const btnDisconnect = getEl<HTMLButtonElement>('btn-disconnect');
const btnZoomToggle = getEl<HTMLButtonElement>('btn-zoom-toggle');
const btnWindowFit = getEl<HTMLButtonElement>('btn-window-fit');
const btnFullscreen = getEl<HTMLButtonElement>('btn-fullscreen');
const btnMore = getEl<HTMLButtonElement>('btn-more');
const moreMenu = getEl<HTMLDivElement>('more-menu');
const btnEmptyConnect = getEl<HTMLButtonElement>('btn-empty-connect');
const btnCtrlAltDel = getEl<HTMLButtonElement>('btn-ctrl-alt-del');
const btnClipboard = getEl<HTMLButtonElement>('btn-clipboard');
const btnLog = getEl<HTMLButtonElement>('btn-log');
const logPanel = getEl<HTMLDivElement>('log-panel');
const logBody = getEl<HTMLDivElement>('log-body');
const logAutoScroll = getEl<HTMLInputElement>('log-autoscroll');
const btnLogClear = getEl<HTMLButtonElement>('btn-log-clear');
const btnLogClose = getEl<HTMLButtonElement>('btn-log-close');
const btnSettings = getEl<HTMLButtonElement>('btn-settings');

// 设置对话框
const settingsDialog = getEl<HTMLDivElement>('settings-dialog');
const settingsPortInput = getEl<HTMLInputElement>('settings-mobile-port');
const settingsErrorMsg = getEl<HTMLDivElement>('settings-error-msg');
const btnSettingsSave = getEl<HTMLButtonElement>('btn-settings-save');
const btnSettingsCancel = getEl<HTMLButtonElement>('btn-settings-cancel');

// ---- 状态变量 ----
let isConnected = false;
let isFullscreen = false;
let zoomLevel = 1;
let zoomMode: 'fit' | '100' = 'fit';

// ---- 本地修饰键状态跟踪 ----
// 作为 e.shiftKey 的后备数据源，某些平台/Electron 版本中 e.shiftKey 可能存在延迟
let localShiftDown = false;
let localCtrlDown = false;
let localAltDown = false;
let localMetaDown = false;

// 帧缓冲数据
let fbWidth = 0;
let fbHeight = 0;
let fbCanvas: ImageData | null = null;

// 背景填充：已禁用以保留真实黑色像素（VNC 服务器应在首帧发送完整画面）
let lastFrameTime = 0;
// 渲染统计（状态栏帧率显示）
let frameCount = 0;
let lastFpsAt = 0;

// 鼠标状态
let mouseButtonMask = 0;
let lastMouseX = 0;
let lastMouseY = 0;
let isPointerInside = false;

// 连接状态
let currentState = ConnectionState.Disconnected;
// 连接监督是否正在安排自动重连（重连期间不断线拆除界面）
let reconnectInProgress = false;

// ---- 初始化 ----
function init(): void {
  setupEventListeners();
  setupIPCListeners();
  setupCanvasResize();

  // 聚焦到主机输入框
  hostInput.focus();

  // 自动连接：当 host 和 password 都有预填值时，自动发起连接
  if (hostInput.value && passwordInput.value) {
    console.log(`[AUTO] host=${hostInput.value}，password 已设置，1s 后自动连接`);
    setTimeout(handleConnect, 1000);
  }
}

// ---- 事件监听 ----
function setupEventListeners(): void {
  // 连接按钮
  connectBtn.addEventListener('click', handleConnect);

  // 回车键触发连接（服务器/密码框）
  hostInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleConnect();
  });
  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleConnect();
  });

  // 选项折叠面板
  optionsToggle.addEventListener('click', () => {
    const expanded = optionsToggle.getAttribute('aria-expanded') === 'true';
    optionsToggle.setAttribute('aria-expanded', String(!expanded));
    optionsPanel.classList.toggle('hidden', expanded);
  });

  // 端口和显示编号联动
  displayInput.addEventListener('change', () => {
    const display = parseInt(displayInput.value) || 0;
    portInput.value = String(5900 + display);
  });

  portInput.addEventListener('change', () => {
    const port = parseInt(portInput.value) || 5900;
    displayInput.value = String(Math.max(0, port - 5900));
  });

  // 工具栏按钮
  btnNewConn.addEventListener('click', showConnectionDialog);
  btnEmptyConnect.addEventListener('click', showConnectionDialog);
  btnDisconnect.addEventListener('click', handleDisconnect);
  btnZoomToggle.addEventListener('click', toggleZoomMode);
  btnWindowFit.addEventListener('click', resizeWindowToRemote);
  btnFullscreen.addEventListener('click', toggleFullscreen);
  btnCtrlAltDel.addEventListener('click', () => sendCtrlAltDel());
  btnClipboard.addEventListener('click', () => {
    const text = prompt('输入要发送到远程的剪贴板文本:');
    if (text !== null) vncApi.sendCutText(text);
  });
  btnLog.addEventListener('click', toggleLogPanel);

  // 更多菜单：开合 + 点击外部关闭
  btnMore.addEventListener('click', (e) => {
    e.stopPropagation();
    moreMenu.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (moreMenu.classList.contains('hidden')) return;
    if (!moreMenu.contains(e.target as Node) && e.target !== btnMore) {
      moreMenu.classList.add('hidden');
    }
  });

  // 日志面板开关
  btnLogClose.addEventListener('click', toggleLogPanel);
  btnLogClear.addEventListener('click', clearLogView);

  // 设置对话框
  btnSettings.addEventListener('click', showSettings);
  btnSettingsSave.addEventListener('click', saveSettings);
  btnSettingsCancel.addEventListener('click', closeSettings);
  settingsPortInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveSettings();
  });

  // 画布鼠标事件
  canvas.addEventListener('mousedown', handleMouseDown);
  canvas.addEventListener('mouseup', handleMouseUp);
  canvas.addEventListener('mousemove', handleMouseMove);
  canvas.addEventListener('wheel', handleMouseWheel);
  canvas.addEventListener('mouseenter', () => { isPointerInside = true; });
  canvas.addEventListener('mouseleave', () => { isPointerInside = false; });

  // 画布外释放 / 窗口失焦时清掉残留按键，防止远程鼠标键一直处于按下状态
  // （拖拽移出窗口后松键是鼠标操作的常见失效场景）
  window.addEventListener('mouseup', handleWindowMouseUp);
  window.addEventListener('blur', handleWindowBlur);

  // 画布右键菜单
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // 键盘事件提升到 window 级：即使画布因点击工具栏等操作失焦，
  // 键盘仍能送达远程（此前画布失焦后按键会"消失"，表现为无法操作）。
  // 使用捕获阶段监听器，确保 Tab 等默认焦点切换键能被 preventDefault 阻止
  window.addEventListener('keydown', handleKeyDown, true);
  window.addEventListener('keyup', handleKeyUp, true);

  // 窗口大小变化
  window.addEventListener('resize', () => {
    if (zoomMode === 'fit') applyZoomFit();
  });

  // 工具栏自动隐藏：鼠标在视口移动时显示，空闲 2.5s 后淡出
  // （参考 Chrome Remote Desktop / TigerVNC 的悬浮工具栏行为）
  viewport.addEventListener('mousemove', onViewportActivity);
  viewport.addEventListener('mousedown', onViewportActivity);
  viewport.addEventListener('wheel', onViewportActivity, { passive: true });
}

// ---- 工具栏自动隐藏 ----
let toolbarHideTimer: ReturnType<typeof setTimeout> | null = null;
const TOOLBAR_IDLE_MS = 2500;

function showToolbar(): void {
  if (!isConnected) return;
  toolbarEl.classList.remove('toolbar-hidden');
  if (toolbarHideTimer !== null) clearTimeout(toolbarHideTimer);
  toolbarHideTimer = setTimeout(hideToolbar, TOOLBAR_IDLE_MS);
}

function hideToolbar(): void {
  toolbarEl.classList.add('toolbar-hidden');
  moreMenu.classList.add('hidden');
}

function onViewportActivity(): void {
  if (isConnected) showToolbar();
}

// ---- IPC 监听 ----
function setupIPCListeners(): void {
  // 实时接收主进程推送的日志
  vncApi.onLog((entry) => {
    appendLog(entry);
  });

  // 主进程按帧批量推送矩形（数组），兼容旧版单个矩形
  vncApi.onFramebufferUpdate((rect: any) => {
    if (Array.isArray(rect)) {
      for (const r of rect) renderRect(r);
    } else {
      renderRect(rect);
    }
    lastFrameTime = Date.now();
    // 整帧只做一次 GPU 上传（脏区合并 + rAF 节律，参考 Octop 流媒体层的帧节流设计）
    schedulePaint();
    // 背景填充已禁用：x11vnc 等服务器首帧即发完整画面，bf 时机不对会覆盖真实黑色像素
  });

  vncApi.onConnectionState((state: number) => {
    currentState = state;
    updateStatusBar(state);
    // 连接意外断开时自动重置 UI 状态。
    // 例外：连接监督正在安排自动重连时保留界面（黑屏片刻后会自动恢复），
    // 不弹连接对话框、不清帧缓冲——重连成功后服务器会重发全量帧。
    if (state === ConnectionState.Disconnected && isConnected && !reconnectInProgress) {
      console.log('[INPUT-DIAG] 连接已断开，重置 UI 状态，停止发送输入事件');
      isConnected = false;
      fbCanvas = null;
      if (statsText) statsText.textContent = '';
      toolbarEl.classList.add('hidden');
      toolbarEl.classList.add('toolbar-hidden');
      emptyState.classList.remove('hidden');
      if (!isFullscreen) {
        dialog.classList.remove('hidden');
      }
      connectBtn.disabled = false;
      connectBtn.textContent = '连接';
      serverInfoText.textContent = '';
    }
  });

  // 自动重连状态：重连期间保留远程画面，状态栏显示退避进度
  vncApi.onReconnectStatus((status) => {
    reconnectInProgress = status.reconnecting;
    showReconnectStatus(status);
  });

  vncApi.onServerInfo((info) => {
    fbWidth = info.width;
    fbHeight = info.height;
    serverInfoText.textContent = `${info.name} (${info.width}×${info.height})`;
    setupCanvas();
    dialog.classList.add('hidden');
    toolbarEl.classList.remove('hidden');
    showToolbar();
    emptyState.classList.add('hidden');
    isConnected = true;

    // 连接成功后聚焦画布，否则键盘事件无法到达 canvas
    canvas.focus();

    if (zoomMode === 'fit') applyZoomFit();
  });

  vncApi.onError((msg) => {
    if (currentState < ConnectionState.Connected) {
      errorMsg.textContent = msg;
    }
    console.error('[VNC]', msg);
  });

  vncApi.onBell(() => {
    // 系统响铃（复用模块级单例 AudioContext，避免每次响铃新建导致资源泄漏）
    try {
      const ctx = getAudioContext();
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 800;
      osc.connect(ctx.destination);
      osc.start();
      setTimeout(() => osc.stop(), 100);
    } catch (_) { /* ignore */ }
  });

  vncApi.onClipboard((text) => {
    navigator.clipboard.writeText(text).catch(() => {});
  });

  // 带宽统计（主进程每秒上报，状态栏显示）
  let lastBandwidth = 0;
  vncApi.onBandwidth((bytesPerSec: number) => {
    lastBandwidth = bytesPerSec;
    updateStatsDisplay();
  });

  // 帧率统计：本地统计每秒实际上屏帧数（rAF 合并后的真实帧率）
  lastFpsAt = Date.now();
  setInterval(() => {
    const now = Date.now();
    const elapsed = (now - lastFpsAt) / 1000;
    if (elapsed <= 0) return;
    const fps = frameCount / elapsed;
    frameCount = 0;
    lastFpsAt = now;
    updateStatsDisplay(fps, lastBandwidth);
  }, 1000);

  vncApi.onDesktopSize((size) => {
    fbWidth = size.width;
    fbHeight = size.height;
    serverInfoText.textContent = serverInfoText.textContent?.replace(/\d+×\d+/, `${size.width}×${size.height}`) || '';
    setupCanvas();
    if (zoomMode === 'fit') applyZoomFit();
  });

  // 菜单事件
  vncApi.onMenuNewConnection(() => showConnectionDialog());
  vncApi.onMenuDisconnect(() => handleDisconnect());
  vncApi.onMenuToggleFullscreen(() => toggleFullscreen());
  vncApi.onMenuExitFullscreen(() => exitFullscreen());
  vncApi.onMenuZoomFit(() => setZoomMode('fit'));
  vncApi.onMenuZoom100(() => setZoomMode('100'));
  vncApi.onMenuResizeWindowToRemote(() => resizeWindowToRemote());
  vncApi.onMenuShowLogs(() => toggleLogPanel());
  vncApi.onMenuShowSettings(() => showSettings());

  // 端口变化通知（主进程重启后）
  vncApi.onMobilePortChanged((port) => {
    settingsPortInput.value = String(port);
  });
}

// ---- 实时日志面板 ----
function toggleLogPanel(): void {
  const isHidden = logPanel.classList.contains('hidden');
  logPanel.classList.toggle('hidden', !isHidden);
  if (isHidden) {
    // 打开时重新从主进程拉取最新日志
    vncApi.getLogs().then((entries: { time: string; level: string; msg: string }[]) => {
      logBody.innerHTML = '';
      for (const e of entries) appendLog(e);
      scrollLogToBottom();
    });
  }
}

function clearLogView(): void {
  vncApi.clearLogs();
  logBody.innerHTML = '';
}

function appendLog(entry: { time: string; level: string; msg: string }): void {
  const line = document.createElement('div');
  line.className = `log-line log-${entry.level}`;
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = entry.time;
  const level = document.createElement('span');
  level.className = 'log-level';
  level.textContent = entry.level.toUpperCase();
  const msg = document.createElement('span');
  msg.className = 'log-msg';
  msg.textContent = entry.msg;
  line.appendChild(time);
  line.appendChild(level);
  line.appendChild(msg);
  logBody.appendChild(line);
  if (logAutoScroll.checked) scrollLogToBottom();
}

function scrollLogToBottom(): void {
  logBody.scrollTop = logBody.scrollHeight;
}

// ---- 设置对话框 ----
function showSettings(): void {
  settingsErrorMsg.textContent = '';
  // 从主进程加载当前配置
  vncApi.getSettings().then((config: any) => {
    settingsPortInput.value = String(config.mobilePort || 5933);
  });
  settingsDialog.classList.remove('hidden');
  settingsPortInput.focus();
  settingsPortInput.select();
}

function closeSettings(): void {
  settingsDialog.classList.add('hidden');
  settingsErrorMsg.textContent = '';
}

function saveSettings(): void {
  const port = parseInt(settingsPortInput.value);
  if (isNaN(port) || port < 1024 || port > 65535) {
    settingsErrorMsg.textContent = '端口范围: 1024-65535';
    return;
  }
  settingsErrorMsg.textContent = '';
  btnSettingsSave.disabled = true;
  btnSettingsSave.textContent = '保存中...';
  vncApi.setSettings({ mobilePort: port }).then(() => {
    closeSettings();
  }).catch((err: any) => {
    settingsErrorMsg.textContent = `保存失败: ${err.message}`;
  }).finally(() => {
    btnSettingsSave.disabled = false;
    btnSettingsSave.textContent = '保存';
  });
}

// ---- 连接管理 ----
function handleConnect(): void {
  // 服务器字段支持简写：`地址` / `地址:端口` / `地址::显示编号`（VNC 经典写法）
  const raw = hostInput.value.trim();
  if (!raw) {
    errorMsg.textContent = '请输入服务器地址';
    return;
  }

  let host = raw;
  let port = parseInt(portInput.value) || 5900;
  const doubleColon = raw.indexOf('::');
  const singleColon = raw.indexOf(':');
  if (doubleColon !== -1) {
    // host::display → 端口 5900+display
    host = raw.slice(0, doubleColon);
    const display = parseInt(raw.slice(doubleColon + 2), 10);
    if (!isNaN(display)) port = 5900 + display;
  } else if (singleColon !== -1 && !raw.includes(']')) {
    // host:port（IPv6 地址含多个冒号，不做解析）
    host = raw.slice(0, singleColon);
    const p = parseInt(raw.slice(singleColon + 1), 10);
    if (!isNaN(p)) port = p;
  }
  // 解析结果回填，保持选项面板与输入框一致
  hostInput.value = host;
  portInput.value = String(port);
  displayInput.value = String(Math.max(0, port - 5900));

  const password = passwordInput.value || undefined;
  const shared = sharedCheck.checked;

  errorMsg.textContent = '';
  connectBtn.disabled = true;
  connectBtn.textContent = '连接中...';

  try {
    vncApi.connect({ host, port, password, shared }).catch((err: any) => {
      errorMsg.textContent = `连接失败: ${err.message}`;
      connectBtn.disabled = false;
      connectBtn.textContent = '连接';
    });
  } catch (err: any) {
    // preload 未加载等异常场景，避免按钮永久卡在“连接中...”
    errorMsg.textContent = `连接失败: ${err?.message || err}`;
    connectBtn.disabled = false;
    connectBtn.textContent = '连接';
  }
}

function handleDisconnect(): void {
  vncApi.disconnect().then(() => {
    isConnected = false;
    fbCanvas = null;
    toolbarEl.classList.add('hidden');
    toolbarEl.classList.add('toolbar-hidden');
    emptyState.classList.remove('hidden');
    if (!isFullscreen) {
      dialog.classList.remove('hidden');
    }
    connectBtn.disabled = false;
    connectBtn.textContent = '连接';
    serverInfoText.textContent = '';
  });
}

function showConnectionDialog(): void {
  dialog.classList.remove('hidden');
  hostInput.focus();
  hostInput.select();
}

// ---- 画布管理 ----
function setupCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = fbWidth;
  canvas.height = fbHeight;
  canvas.style.width = `${fbWidth}px`;
  canvas.style.height = `${fbHeight}px`;

  const ctx = canvas.getContext('2d')!;
  fbCanvas = ctx.createImageData(fbWidth, fbHeight);
  // 初始化为黑色
  for (let i = 0; i < fbCanvas.data.length; i++) {
    fbCanvas.data[i] = 0;
  }
  // 立即全屏绘制一次黑色底，避免残留上一连接的画面
  markDirty(0, 0, fbWidth, fbHeight);
  schedulePaint();
}

function applyZoomFit(): void {
  const container = viewport;
  const containerRect = container.getBoundingClientRect();
  const padding = 20;

  const availW = containerRect.width - padding * 2;
  const availH = containerRect.height - padding * 2;

  const scaleX = availW / fbWidth;
  const scaleY = availH / fbHeight;
  // 双向自适应：窗口小则缩小，窗口大则放大，保持纵横比完整显示远端画面
  zoomLevel = Math.min(scaleX, scaleY);

  canvas.style.width = `${fbWidth * zoomLevel}px`;
  canvas.style.height = `${fbHeight * zoomLevel}px`;
  zoomText.textContent = `${Math.round(zoomLevel * 100)}%`;
}

function setZoomMode(mode: 'fit' | '100'): void {
  zoomMode = mode;
  if (mode === '100') {
    zoomLevel = 1;
    canvas.style.width = `${fbWidth}px`;
    canvas.style.height = `${fbHeight}px`;
    zoomText.textContent = '100%';
    zoomIconFit.classList.add('hidden');
    zoomIcon100.classList.remove('hidden');
  } else {
    applyZoomFit();
    zoomIconFit.classList.remove('hidden');
    zoomIcon100.classList.add('hidden');
  }
  if (isConnected) showToolbar();
}

/** 缩放模式切换：适配窗口 ↔ 实际大小 */
function toggleZoomMode(): void {
  setZoomMode(zoomMode === 'fit' ? '100' : 'fit');
}

/** 窗口适应远端：把窗口内容区调整为与远端分辨率一致，实现 1:1 像素映射 */
function resizeWindowToRemote(): void {
  if (!isConnected || fbWidth === 0 || fbHeight === 0) return;
  if (isFullscreen) return; // 全屏下无法调整窗口大小
  // 本地 UI 额外占用 = 当前窗口尺寸 - 视口尺寸（工具栏、内边距、边框等）
  const extraW = window.innerWidth - viewport.clientWidth;
  const extraH = window.innerHeight - viewport.clientHeight;
  const w = Math.round(fbWidth + extraW);
  const h = Math.round(fbHeight + extraH);
  // 切到 100% 模式：窗口匹配后无需缩放；若远端超出屏幕被主进程裁剪，
  // ResizeObserver 会因视口变化触发（fit 模式下会自动重新适配，100% 模式下可滚动查看）
  setZoomMode('100');
  vncApi.resizeWindowToContent(w, h);
}

function setupCanvasResize(): void {
  const ro = new ResizeObserver(() => {
    if (isConnected && zoomMode === 'fit') applyZoomFit();
  });
  ro.observe(viewport);
}

// ---- 渲染 ----
// 帧内累积脏区，整帧只做一次 putImageData：
// - 避免每矩形一次 GPU 上传（40 矩形帧 = 40 次上传 → 1 次）；
// - requestAnimationFrame 节律：帧数据到达快于屏幕刷新时自动合并，
//   丢弃中间帧只画最新状态（参考 Octop 流媒体层的帧节流设计）。
let dirtyX0 = 0, dirtyY0 = 0, dirtyX1 = -1, dirtyY1 = -1;
let paintScheduled = false;

function markDirty(x: number, y: number, w: number, h: number): void {
  if (dirtyX1 < dirtyX0) {
    dirtyX0 = x; dirtyY0 = y; dirtyX1 = x + w; dirtyY1 = y + h;
  } else {
    if (x < dirtyX0) dirtyX0 = x;
    if (y < dirtyY0) dirtyY0 = y;
    if (x + w > dirtyX1) dirtyX1 = x + w;
    if (y + h > dirtyY1) dirtyY1 = y + h;
  }
}

function schedulePaint(): void {
  if (paintScheduled) return;
  paintScheduled = true;
  requestAnimationFrame(() => {
    paintScheduled = false;
    if (!fbCanvas || dirtyX1 < dirtyX0) return;
    // 钳制到帧缓冲范围，取帧内所有 rect 的外接矩形一次上传
    const x = Math.max(0, dirtyX0);
    const y = Math.max(0, dirtyY0);
    const w = Math.min(dirtyX1, fbWidth) - x;
    const h = Math.min(dirtyY1, fbHeight) - y;
    dirtyX1 = dirtyX0 - 1; // 重置脏区
    if (w <= 0 || h <= 0) return;
    canvas.getContext('2d')!.putImageData(fbCanvas, 0, 0, x, y, w, h);
    frameCount++;
  });
}

function renderRect(rect: { x: number; y: number; width: number; height: number; data: number[] | Buffer; encoding: number }): void {
  if (!fbCanvas) {
    console.error('[RENDER] fbCanvas 为 null，跳过渲染');
    return;
  }

  if (rect.encoding === 1) {
    // CopyRect: data 为大端序 srcX/srcY（各 2 字节）
    // 直接在帧缓冲内按行复制（copyWithin 为 memmove 语义，重叠区域安全，
    // 且避免 drawImage + 全屏 getImageData 的高开销）
    if (rect.data.length < 4) return;
    const srcX = (rect.data[0] << 8) | rect.data[1];
    const srcY = (rect.data[2] << 8) | rect.data[3];
    const px = fbCanvas.data;
    const copyW = Math.min(rect.width, fbWidth - Math.max(srcX, rect.x));
    for (let row = 0; row < rect.height; row++) {
      const sy = srcY + row;
      const dy = rect.y + row;
      if (sy < 0 || sy >= fbHeight || dy < 0 || dy >= fbHeight) continue;
      const srcOff = (sy * fbWidth + srcX) * 4;
      const dstOff = (dy * fbWidth + rect.x) * 4;
      px.copyWithin(dstOff, srcOff, srcOff + copyW * 4);
    }
    markDirty(rect.x, rect.y, rect.width, rect.height);
    return;
  }

  // 统一转为 Uint8Array（兼容 Buffer、Uint8Array、number[] 等 IPC 传输后的格式）
  let data: Uint8Array;
  if (Array.isArray(rect.data)) {
    data = new Uint8Array(rect.data as number[]);
  } else if (rect.data instanceof Uint8Array) {
    data = rect.data;
  } else {
    // Buffer 或其他 ArrayBufferView
    const d = rect.data as any;
    data = new Uint8Array(d.buffer, d.byteOffset || 0, d.byteLength);
  }

  // 裁剪到帧缓冲范围，防止越界
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const w = Math.min(rect.width, fbWidth - x);
  const h = Math.min(rect.height, fbHeight - y);
  if (w <= 0 || h <= 0) return;
  const skipX = x - rect.x;
  const skipY = y - rect.y;

  // 按行逐字节拷贝（避免 Uint32Array 视图在跨平台时的字节序隐患）
  const dst = fbCanvas.data;
  for (let row = 0; row < h; row++) {
    const srcStart = ((skipY + row) * rect.width + skipX) * 4;
    const dstStart = ((y + row) * fbWidth + x) * 4;
    dst.set(data.subarray(srcStart, srcStart + w * 4), dstStart);
  }

  markDirty(x, y, w, h);
}

/**
 * 【已禁用】背景填充：会覆盖画面中合法的黑色像素导致黑屏。
 *
 * 背景填充逻辑的三段式策略：
 * 1. 纯色推断：从边缘采样推断背景主色调，直接填充所有黑块（适合纯色桌面）
 * 2. 扫描线扩散：32 轮四方向扫描，用最近非黑像素填充（适合渐变/纹理背景）
 * 3. 孤立点修复：对仍未修复的黑点做螺旋采样，取 4-16px 范围内最近非黑像素
 *
 * 禁用原因：VNC 服务器应在首帧发送完整画面，bf 时机不对会覆盖真实黑色像素。
 * 若确有服务器不发背景的问题，应在协议层通过 coverage 追踪补发请求处理。
 */
function _fillBackgroundDisabled(): void {
  if (!fbCanvas) return;

  const data = fbCanvas.data;
  const w = fbWidth;
  const h = fbHeight;
  const ctx = canvas.getContext('2d')!;

  // ---- 标记黑色像素 ----
  const isBlack = new Uint8Array(w * h);
  let blackCount = 0;
  for (let i = 0; i < w * h; i++) {
    const off = i * 4;
    if (data[off] === 0 && data[off + 1] === 0 && data[off + 2] === 0) {
      isBlack[i] = 1;
      blackCount++;
    }
  }
  if (blackCount === 0 || blackCount > w * h * 0.5) return;

  // ---- 阶段 1: 纯色推断 ----
  // 从四边向内采样非黑像素，量化后取众数作为推断的"背景色"
  const quantize = (v: number) => Math.floor(v / 16) * 16; // 16 级量化减少噪声
  const colorFreq = new Map<number, number>();

  const sampleEdge = (x0: number, y0: number, x1: number, y1: number) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    if (steps === 0) return;
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(x0 + ((x1 - x0) * s) / steps);
      const y = Math.round(y0 + ((y1 - y0) * s) / steps);
      const idx = y * w + x;
      if (!isBlack[idx]) {
        const off = idx * 4;
        const key = (quantize(data[off]) << 16) | (quantize(data[off + 1]) << 8) | quantize(data[off + 2]);
        colorFreq.set(key, (colorFreq.get(key) || 0) + 1);
      }
    }
  };

  // 采样四条边 + 对角线（扩大采样范围到 1/4 区域）
  const margin = Math.min(w, h) >> 2;
  for (let i = 0; i < margin; i++) {
    sampleEdge(i, i, w - 1 - i, i);               // 上边
    sampleEdge(i, h - 1 - i, w - 1 - i, h - 1 - i); // 下边
    sampleEdge(i, i, i, h - 1 - i);               // 左边
    sampleEdge(w - 1 - i, i, w - 1 - i, h - 1 - i); // 右边
  }

  if (colorFreq.size > 0) {
    // 找到最高频的量化色
    let bestKey = 0, bestFreq = 0;
    for (const [key, freq] of colorFreq) {
      if (freq > bestFreq) { bestFreq = freq; bestKey = key; }
    }
    const bgR = (bestKey >> 16) & 0xFF;
    const bgG = (bestKey >> 8) & 0xFF;
    const bgB = bestKey & 0xFF;

    // 置信度检查：如果采样众数占比足够高，直接用纯色填充（适合纯色桌面）
    const totalSamples = [...colorFreq.values()].reduce((a, b) => a + b, 0);
    if (bestFreq / totalSamples > 0.35) {
      for (let i = 0; i < w * h; i++) {
        if (isBlack[i]) {
          const off = i * 4;
          data[off] = bgR; data[off + 1] = bgG; data[off + 2] = bgB; data[off + 3] = 255;
          isBlack[i] = 0;
          blackCount--;
        }
      }
    }
  }

  if (blackCount === 0) {
    ctx.putImageData(fbCanvas, 0, 0);
    return;
  }

  // ---- 阶段 2: 扫描线扩散（32 轮，最大覆盖 ~96px） ----
  for (let round = 0; round < 32; round++) {
    let filled = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (!isBlack[idx]) continue;

        let r = 0, g = 0, b = 0, count = 0;
        // 四方向扫描，最大距离 3px
        for (let dx = 1; dx <= 3 && x - dx >= 0; dx++) {
          const ni = idx - dx;
          if (!isBlack[ni]) { const no = ni * 4; r += data[no]; g += data[no + 1]; b += data[no + 2]; count++; break; }
        }
        for (let dx = 1; dx <= 3 && x + dx < w; dx++) {
          const ni = idx + dx;
          if (!isBlack[ni]) { const no = ni * 4; r += data[no]; g += data[no + 1]; b += data[no + 2]; count++; break; }
        }
        for (let dy = 1; dy <= 3 && y - dy >= 0; dy++) {
          const ni = idx - dy * w;
          if (!isBlack[ni]) { const no = ni * 4; r += data[no]; g += data[no + 1]; b += data[no + 2]; count++; break; }
        }
        for (let dy = 1; dy <= 3 && y + dy < h; dy++) {
          const ni = idx + dy * w;
          if (!isBlack[ni]) { const no = ni * 4; r += data[no]; g += data[no + 1]; b += data[no + 2]; count++; break; }
        }

        if (count > 0) {
          const off = idx * 4;
          data[off] = Math.round(r / count);
          data[off + 1] = Math.round(g / count);
          data[off + 2] = Math.round(b / count);
          data[off + 3] = 255;
          isBlack[idx] = 0;
          filled++;
          blackCount--;
        }
      }
    }
    if (filled === 0) break;
    if (blackCount === 0) break;
  }

  if (blackCount === 0) {
    ctx.putImageData(fbCanvas, 0, 0);
    return;
  }

  // ---- 阶段 3: 孤立点修复（螺旋采样，4-16px 范围） ----
  // 阶段 2 结束后剩余的黑点通常是"岛状"区域，距离已知像素较远；
  // 用螺旋搜索在更大范围内找最近非黑像素，避免大块黑色残留。
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!isBlack[idx]) continue;

      let foundR = -1, foundG = 0, foundB = 0, foundDist = Infinity;
      // 螺旋搜索：半径 4..16px，每隔 45°采样一次
      for (let radius = 4; radius <= 16; radius += 2) {
        for (let angle = 0; angle < 8; angle++) {
          const theta = (angle * Math.PI) / 4;
          const sx = Math.round(x + radius * Math.cos(theta));
          const sy = Math.round(y + radius * Math.sin(theta));
          if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
          const ni = sy * w + sx;
          if (!isBlack[ni]) {
            const dist = radius;
            if (dist < foundDist) {
              foundDist = dist;
              const no = ni * 4;
              foundR = data[no]; foundG = data[no + 1]; foundB = data[no + 2];
            }
          }
        }
        if (foundR >= 0) break; // 找到就停，避免远处像素污染
      }

      if (foundR >= 0) {
        const off = idx * 4;
        data[off] = foundR; data[off + 1] = foundG; data[off + 2] = foundB; data[off + 3] = 255;
        isBlack[idx] = 0;
      }
    }
  }

  // 渲染修复后的帧缓冲
  ctx.putImageData(fbCanvas, 0, 0);
}

// ---- 鼠标事件 ----
let inputEventCount = 0;
function handleMouseDown(e: MouseEvent): void {
  if (!isConnected) return;
  canvas.focus();

  const btn = e.button;
  let mask = 0;
  if (btn === 0) mask = 1;      // 左键
  else if (btn === 1) mask = 4; // 中键
  else if (btn === 2) mask = 2; // 右键

  mouseButtonMask |= mask;
  const pos = getCanvasPosition(e);
  inputEventCount++;
  if (inputEventCount <= 10 || inputEventCount % 20 === 0) {
    console.log(`[INPUT-DIAG] mousedown btn=${btn} mask=${mouseButtonMask} pos=(${pos.x},${pos.y})`);
  }
  vncApi.pointerEvent(mouseButtonMask, pos.x, pos.y);
}

function handleMouseUp(e: MouseEvent): void {
  if (!isConnected) return;

  const btn = e.button;
  let mask = 0;
  if (btn === 0) mask = 1;
  else if (btn === 1) mask = 4;
  else if (btn === 2) mask = 2;

  mouseButtonMask &= ~mask;
  const pos = getCanvasPosition(e);
  vncApi.pointerEvent(mouseButtonMask, pos.x, pos.y);
}

// 在画布外释放鼠标：使用最后一次画布内坐标发送抬起，避免掩码残留
function handleWindowMouseUp(e: MouseEvent): void {
  if (!isConnected) return;

  const btn = e.button;
  let mask = 0;
  if (btn === 0) mask = 1;
  else if (btn === 1) mask = 4;
  else if (btn === 2) mask = 2;

  if (mask === 0 || (mouseButtonMask & mask) === 0) return; // 画布内已处理
  mouseButtonMask &= ~mask;
  vncApi.pointerEvent(mouseButtonMask, lastMouseX, lastMouseY);
}

// 窗口失焦（如切换应用/Alt-Tab）时释放全部鼠标键和修饰键
function handleWindowBlur(): void {
  // 释放可能残留的本地修饰键
  if (localShiftDown) { localShiftDown = false; vncApi.keyEvent(0x1000000 | 0xffe1, false); }
  if (localCtrlDown) { localCtrlDown = false; vncApi.keyEvent(0x1000000 | 0xffe3, false); }
  if (localAltDown) { localAltDown = false; vncApi.keyEvent(0x1000000 | 0xffe9, false); }
  if (localMetaDown) { localMetaDown = false; vncApi.keyEvent(0x1000000 | 0xffeb, false); }
  // 释放鼠标键
  if (mouseButtonMask !== 0) {
    mouseButtonMask = 0;
    vncApi.pointerEvent(0, lastMouseX, lastMouseY);
  }
}

// 鼠标移动节流：mousemove 触发频率远高于屏幕刷新率，逐条走 IPC 会拖垮渲染与主进程
const MOUSE_MOVE_INTERVAL = 15;
let lastMoveSentAt = 0;
let moveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingMove: { mask: number; x: number; y: number } | null = null;

function handleMouseMove(e: MouseEvent): void {
  if (!isConnected) return;
  const pos = getCanvasPosition(e);
  lastMouseX = pos.x;
  lastMouseY = pos.y;
  pendingMove = { mask: mouseButtonMask, x: pos.x, y: pos.y };
  scheduleMouseMove();
}

function scheduleMouseMove(): void {
  if (moveTimer !== null) return;
  const wait = Math.max(0, MOUSE_MOVE_INTERVAL - (Date.now() - lastMoveSentAt));
  moveTimer = setTimeout(() => {
    moveTimer = null;
    if (!pendingMove) return;
    vncApi.pointerEvent(pendingMove.mask, pendingMove.x, pendingMove.y);
    lastMoveSentAt = Date.now();
    pendingMove = null;
  }, wait);
}

function handleMouseWheel(e: WheelEvent): void {
  if (!isConnected) return;
  e.preventDefault();

  const delta = Math.sign(e.deltaY);
  let mask = mouseButtonMask;

  if (delta < 0) {
    // 滚轮上
    mask |= 8;  // 按钮4
    const pos = getCanvasPosition(e);
    vncApi.pointerEvent(mask, pos.x, pos.y);
    mask &= ~8;
    vncApi.pointerEvent(mask, pos.x, pos.y);
  } else {
    // 滚轮下
    mask |= 16; // 按钮5
    const pos = getCanvasPosition(e);
    vncApi.pointerEvent(mask, pos.x, pos.y);
    mask &= ~16;
    vncApi.pointerEvent(mask, pos.x, pos.y);
  }
}

let coordDiagCounter = 0;
function getCanvasPosition(e: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  
  // 安全检查：如果 canvas 还没正确渲染（rect 为 0）或 fbWidth 未初始化，
  // 则返回 (0, 0) 避免发送无效坐标给 VNC 服务器
  if (!rect.width || !rect.height || !canvas.width || !canvas.height) {
    console.warn(`[COORD-DIAG] 无法计算坐标: rect=(${rect.left},${rect.top},${rect.width}x${rect.height}) canvas=${canvas.width}x${canvas.height}`);
    return { x: 0, y: 0 };
  }
  
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const rawX = (e.clientX - rect.left) * scaleX;
  const rawY = (e.clientY - rect.top) * scaleY;
  
  // 坐标钳制到 VNC 桌面范围内，防止越界
  const result = {
    x: Math.max(0, Math.min(fbWidth - 1, Math.round(rawX))),
    y: Math.max(0, Math.min(fbHeight - 1, Math.round(rawY))),
  };
  
  coordDiagCounter++;
  if (coordDiagCounter <= 5 || coordDiagCounter % 50 === 0) {
    console.log(`[COORD-DIAG] client=(${e.clientX},${e.clientY}) rect=(${rect.left.toFixed(1)},${rect.top.toFixed(1)},${rect.width.toFixed(1)}x${rect.height.toFixed(1)}) scale=(${scaleX.toFixed(4)},${scaleY.toFixed(4)}) fb=${fbWidth}x${fbHeight} => pos=(${result.x},${result.y}) raw=(${rawX.toFixed(1)},${rawY.toFixed(1)})`);
  }
  return result;
}

// ---- 键盘事件 ----
// 焦点在输入控件/按钮上时按键归控件所有，不应转发给远程
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    || tag === 'BUTTON' || el.isContentEditable;
}

// X11 keysym 映射表
const KEYSYM: Record<string, number> = {
  'Backspace': 0xff08, 'Tab': 0xff09, 'Enter': 0xff0d, 'Escape': 0xff1b,
  'F1': 0xffbe, 'F2': 0xffbf, 'F3': 0xffc0, 'F4': 0xffc1,
  'F5': 0xffc2, 'F6': 0xffc3, 'F7': 0xffc4, 'F8': 0xffc5,
  'F9': 0xffc6, 'F10': 0xffc7, 'F11': 0xffc8, 'F12': 0xffc9,
  'Shift': 0xffe1, 'Shift_L': 0xffe1, 'Shift_R': 0xffe2,
  'Control': 0xffe3, 'Ctrl': 0xffe3, 'Control_L': 0xffe3, 'Control_R': 0xffe4,
  'Alt': 0xffe9, 'Alt_L': 0xffe9, 'Alt_R': 0xffea,
  'Meta': 0xffeb, 'Super_L': 0xffeb, 'Super_R': 0xffec,
  'CapsLock': 0xffe5, 'Caps_Lock': 0xffe5,
  'Delete': 0xffff, 'Insert': 0xff63, 'Home': 0xff50, 'End': 0xff57,
  'PageUp': 0xff55, 'PageDown': 0xff56,
  'ArrowUp': 0xff52, 'ArrowDown': 0xff54, 'ArrowLeft': 0xff51, 'ArrowRight': 0xff53,
  ' ': 0x20,
  // 数字键
  '`': 0x60, '-': 0x2d, '=': 0x3d,
  '[': 0x5b, ']': 0x5d, '\\': 0x5c,
  ';': 0x3b, "'": 0x27, ',': 0x2c, '.': 0x2e, '/': 0x2f,
};

// 需要 Shift 才能输入的符号映射
// 注意：标准 ASCII 字符的 keysym 等于其 ASCII 码，大部分不需要此表。
// 仅列出需要特殊处理的符号映射（大部分是冗余的 ASCII 映射，保留是为了兼容性）
const SHIFT_SYMBOLS: Record<string, number> = {
  '~': 0x7e, '!': 0x21, '@': 0x40, '#': 0x23, '$': 0x24, '%': 0x25,
  '^': 0x5e, '&': 0x26, '*': 0x2a, '(': 0x28, ')': 0x29,
  '_': 0x5f, '+': 0x2b, '{': 0x7b, '}': 0x7d, '|': 0x7c,
  ':': 0x3a, '"': 0x22, '<': 0x3c, '>': 0x3e, '?': 0x3f,
};

// 从按键解析 X11 keysym：直接使用 e.key 对应的 "视觉" keysym
// 关键原理：e.key 已经反映了 Shift/Caps Lock 的最终视觉效果
//   - 'A' → XK_A (0x41)          服务器直接输出 A
//   - 'a' → XK_a (0x61)          服务器直接输出 a
//   - '?' → XK_question (0x3f)   通过 SHIFT_SYMBOLS 查表
// 不再依赖服务器端 Shift 修饰 — 避免不同 VNC 服务器 Shift 处理差异
function keysymFromKey(key: string): number {
  // 查表（功能键、特殊字符、符号等）
  if (KEYSYM[key] !== undefined) return KEYSYM[key];
  if (key.length !== 1) return 0;

  const code = key.charCodeAt(0);
  // 字母键：直接使用 e.key 对应的 X11 keysym
  // 'A' → 0x41 (XK_A), 'a' → 0x61 (XK_a), 'Z' → 0x5A (XK_Z), etc.
  if (code >= 65 && code <= 90) return code;   // A-Z → XK_A-XK_Z (0x41-0x5A)
  if (code >= 97 && code <= 122) return code;  // a-z → XK_a-XK_z (0x61-0x7a)
  // Shift 符号
  if (SHIFT_SYMBOLS[key] !== undefined) return SHIFT_SYMBOLS[key];
  // 数字等其他 ASCII 字符
  return code;
}

function handleKeyDown(e: KeyboardEvent): void {
  if (!isConnected) return;
  if (isTypingTarget(e.target)) return;

  // 跳过修饰键的自动重复事件（OS 按住不放时生成的重复 keydown）
  // 使用本地状态判断：如果本地已记录该修饰键为按下，跳过重复事件
  if (e.repeat) {
    if (e.key === 'Shift' && localShiftDown) return;
    if (e.key === 'Control' && localCtrlDown) return;
    if (e.key === 'Alt' && localAltDown) return;
    if (e.key === 'Meta' && localMetaDown) return;
  }

  // 快捷键：Cmd(Mac) 或 Ctrl(其他) 组合键触发本地操作
  const mod = e.metaKey || e.ctrlKey;
  if (mod) {
    if (e.key === 'n' || e.key === 'N') { showConnectionDialog(); e.preventDefault(); return; }
    if (e.key === 'd' || e.key === 'D') { handleDisconnect(); e.preventDefault(); return; }
    if (e.key === '0') { setZoomMode('fit'); e.preventDefault(); return; }
    if (e.key === '1') { setZoomMode('100'); e.preventDefault(); return; }
    if (e.key === '2') { resizeWindowToRemote(); e.preventDefault(); return; }
  }

  // 焦点切换到 canvas, 阻止默认行为（含 Tab 焦点切换）
  canvas.focus();
  e.preventDefault();

  // 修饰键按下 — 发送对应的 X11 keysym + 更新本地状态
  if (e.key === 'Shift') { localShiftDown = true; vncApi.keyEvent(0x1000000 | 0xffe1, true); return; }
  if (e.key === 'Control') { localCtrlDown = true; vncApi.keyEvent(0x1000000 | 0xffe3, true); return; }
  if (e.key === 'Alt') { localAltDown = true; vncApi.keyEvent(0x1000000 | 0xffe9, true); return; }
  if (e.key === 'Meta') { localMetaDown = true; vncApi.keyEvent(0x1000000 | 0xffeb, true); return; }
  if (e.key === 'CapsLock') {
    // Caps Lock 不需要发送到远程 — 远程状态应保持不变
    return;
  }

  // 解析字符 keysym
  const keysym = keysymFromKey(e.key);
  if (keysym === 0) return;

  // 直接发送 e.keysym — keysymFromKey 已返回对应的大小写 keysym
  inputEventCount++;
  console.log(`[INPUT-DIAG] keydown #${inputEventCount} key="${e.key}" code="${e.code}" shiftKey=${e.shiftKey} keysym=0x${keysym.toString(16)}`);

  vncApi.keyEvent(0x1000000 | keysym, true);
}

function handleKeyUp(e: KeyboardEvent): void {
  if (!isConnected || isTypingTarget(e.target)) return;
  e.preventDefault();

  // 修饰键释放 + 更新本地状态
  if (e.key === 'Shift') { localShiftDown = false; vncApi.keyEvent(0x1000000 | 0xffe1, false); return; }
  if (e.key === 'Control') { localCtrlDown = false; vncApi.keyEvent(0x1000000 | 0xffe3, false); return; }
  if (e.key === 'Alt') { localAltDown = false; vncApi.keyEvent(0x1000000 | 0xffe9, false); return; }
  if (e.key === 'Meta') { localMetaDown = false; vncApi.keyEvent(0x1000000 | 0xffeb, false); return; }
  if (e.key === 'CapsLock' || e.code === 'CapsLock') return;

  const keysym = keysymFromKey(e.key);
  if (keysym === 0) return;

  vncApi.keyEvent(0x1000000 | keysym, false);
}

// 点击工具栏按钮后自动把焦点还给 canvas，避免按键"丢失"
function ensureCanvasFocus(): void {
  if (isConnected && document.activeElement !== canvas) {
    canvas.focus();
  }
}

function sendCtrlAltDel(): void {
  if (!isConnected) return;
  // 发送 Ctrl+Alt+Del（使用 X11 keysym + 标记位）
  const ctrl = 0x1000000 | 0xffe3;  // Control_L
  const alt = 0x1000000 | 0xffe9;   // Alt_L
  const del = 0x1000000 | 0xffff;    // Delete
  vncApi.keyEvent(ctrl, true);
  vncApi.keyEvent(alt, true);
  vncApi.keyEvent(del, true);
  setTimeout(() => {
    vncApi.keyEvent(del, false);
    vncApi.keyEvent(alt, false);
    vncApi.keyEvent(ctrl, false);
  }, 100);
}

// ---- 全屏 ----
function toggleFullscreen(): void {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().then(() => {
      isFullscreen = true;
    }).catch(() => {});
  } else {
    exitFullscreen();
  }
}

function exitFullscreen(): void {
  if (document.fullscreenElement) {
    document.exitFullscreen().then(() => {
      isFullscreen = false;
    }).catch(() => {});
  }
}

// ---- 状态栏更新 ----
function updateStatusBar(state: number): void {
  statusIndicator.className = 'status-indicator';

  switch (state) {
    case ConnectionState.Disconnected:
      statusIndicator.classList.add('disconnected');
      statusText.textContent = '未连接';
      break;
    case ConnectionState.Connecting:
    case ConnectionState.ProtocolVersion:
    case ConnectionState.Security:
    case ConnectionState.Authentication:
    case ConnectionState.ClientInit:
    case ConnectionState.ServerInit:
      statusIndicator.classList.add('connecting');
      statusText.textContent = '连接中...';
      break;
    case ConnectionState.Connected:
      statusIndicator.classList.add('connected');
      statusText.textContent = '已连接';
      if (connectBtn) {
        connectBtn.disabled = false;
        connectBtn.textContent = '连接';
      }
      break;
    case ConnectionState.Error:
      statusIndicator.classList.add('error');
      statusText.textContent = '错误';
      break;
  }
}

// ---- 自动重连状态（连接监督：意外断线后指数退避重连）----
// 重连期间状态栏显示进度；重连成功/取消后恢复由 updateStatusBar 接管
function showReconnectStatus(status: {
  reconnecting: boolean; attempt?: number; maxAttempts?: number; delayMs?: number;
}): void {
  if (status.reconnecting && status.attempt) {
    statusIndicator.className = 'status-indicator connecting';
    const secs = status.delayMs ? (status.delayMs / 1000).toFixed(0) : '?';
    statusText.textContent = `重连中 ${status.attempt}/${status.maxAttempts ?? '?'}（${secs}s 后）`;
    if (connectBtn) {
      connectBtn.disabled = true;
      connectBtn.textContent = '重连中';
    }
  } else if (isConnected) {
    updateStatusBar(ConnectionState.Connected);
  } else {
    updateStatusBar(ConnectionState.Disconnected);
  }
}

// ---- 状态栏统计：帧率 + 带宽（参考 Octop 的状态探测/可观测性设计）----
function updateStatsDisplay(fps?: number, bytesPerSec?: number): void {
  if (!statsText) return;
  if (!isConnected) {
    statsText.textContent = '';
    return;
  }
  const parts: string[] = [];
  if (fps !== undefined) parts.push(`${fps.toFixed(0)} fps`);
  if (bytesPerSec !== undefined && bytesPerSec > 0) {
    parts.push(bytesPerSec >= 1024 * 1024
      ? `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`
      : `${(bytesPerSec / 1024).toFixed(0)} KB/s`);
  }
  statsText.textContent = parts.join(' · ');
}

// ---- 启动 ----
document.addEventListener('DOMContentLoaded', init);