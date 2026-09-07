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
  onBell: (callback: () => void) => void;
  onClipboard: (callback: (text: string) => void) => void;
  onDesktopSize: (callback: (size: any) => void) => void;
  onMenuNewConnection: (callback: () => void) => void;
  onMenuDisconnect: (callback: () => void) => void;
  onMenuToggleFullscreen: (callback: () => void) => void;
  onMenuExitFullscreen: (callback: () => void) => void;
  onMenuZoomFit: (callback: () => void) => void;
  onMenuZoom100: (callback: () => void) => void;
  onMenuShowLogs: (callback: () => void) => void;
  onMenuShowSettings: (callback: () => void) => void;
  getLogs: () => Promise<any>;
  clearLogs: () => Promise<any>;
  onLog: (callback: (entry: { time: string; level: string; msg: string }) => void) => void;
  getSettings: () => Promise<any>;
  setSettings: (settings: any) => Promise<any>;
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
const statusBar = getEl<HTMLDivElement>('status-bar');
const statusIndicator = getEl<HTMLSpanElement>('status-indicator');
const statusText = getEl<HTMLSpanElement>('status-text');
const serverInfoText = getEl<HTMLSpanElement>('server-info-text');
const qualityText = getEl<HTMLSpanElement>('quality-text');
const zoomText = getEl<HTMLSpanElement>('zoom-text');
const toolbarEl = getEl<HTMLDivElement>('toolbar');
const canvas = getEl<HTMLCanvasElement>('vnc-canvas');
const emptyState = getEl<HTMLDivElement>('empty-state');
const viewport = getEl<HTMLDivElement>('viewport-container');
const btnNewConn = getEl<HTMLButtonElement>('btn-new-conn');
const btnDisconnect = getEl<HTMLButtonElement>('btn-disconnect');
const btnZoomFit = getEl<HTMLButtonElement>('btn-zoom-fit');
const btnZoom100 = getEl<HTMLButtonElement>('btn-zoom-100');
const btnFullscreen = getEl<HTMLButtonElement>('btn-fullscreen');
const btnCtrlAltDel = getEl<HTMLButtonElement>('btn-ctrl-alt-del');
const btnClipboard = getEl<HTMLButtonElement>('btn-clipboard');
const btnLog = getEl<HTMLButtonElement>('btn-log');
const logPanel = getEl<HTMLDivElement>('log-panel');
const logBody = getEl<HTMLDivElement>('log-body');
const logAutoScroll = getEl<HTMLInputElement>('log-autoscroll');
const btnLogClear = getEl<HTMLButtonElement>('btn-log-clear');
const btnLogClose = getEl<HTMLButtonElement>('btn-log-close');

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

// 帧缓冲数据
let fbWidth = 0;
let fbHeight = 0;
let fbCanvas: ImageData | null = null;

// 背景填充计时器（x11vnc 等服务器不发送静态背景时，用邻近像素填充黑色区域）
let bgFillTimer: ReturnType<typeof setTimeout> | null = null;
let lastFrameTime = 0;
let bgFillDone = false;

// 鼠标状态
let mouseButtonMask = 0;
let lastMouseX = 0;
let lastMouseY = 0;
let isPointerInside = false;

// 连接状态
let currentState = ConnectionState.Disconnected;

// ---- 初始化 ----
function init(): void {
  setupEventListeners();
  setupIPCListeners();
  setupCanvasResize();

  // 聚焦到主机输入框
  hostInput.focus();
}

// ---- 事件监听 ----
function setupEventListeners(): void {
  // 连接按钮
  connectBtn.addEventListener('click', handleConnect);

  // 回车键触发连接
  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleConnect();
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
  btnDisconnect.addEventListener('click', handleDisconnect);
  btnZoomFit.addEventListener('click', () => setZoomMode('fit'));
  btnZoom100.addEventListener('click', () => setZoomMode('100'));
  btnFullscreen.addEventListener('click', toggleFullscreen);
  btnCtrlAltDel.addEventListener('click', () => sendCtrlAltDel());
  btnClipboard.addEventListener('click', () => {
    const text = prompt('输入要发送到远程的剪贴板文本:');
    if (text !== null) vncApi.sendCutText(text);
  });

  // 日志面板开关
  btnLog.addEventListener('click', toggleLogPanel);
  btnLogClose.addEventListener('click', toggleLogPanel);
  btnLogClear.addEventListener('click', clearLogView);

  // 设置对话框
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

  // 画布键盘事件
  canvas.addEventListener('keydown', handleKeyDown);
  canvas.addEventListener('keyup', handleKeyUp);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // 窗口大小变化
  window.addEventListener('resize', () => {
    if (zoomMode === 'fit') applyZoomFit();
  });
}

// ---- IPC 监听 ----
function setupIPCListeners(): void {
  // 实时接收主进程推送的日志
  vncApi.onLog((entry) => {
    appendLog(entry);
  });

  vncApi.onFramebufferUpdate((rect) => {
    renderRect(rect);
    lastFrameTime = Date.now();
    bgFillDone = false;
    // 重置背景填充计时器：如果 800ms 无新帧，触发背景填充
    // 使用较短延迟让首帧后快速填充，后续帧到来时重新触发
    if (bgFillTimer) clearTimeout(bgFillTimer);
    if (isConnected && fbCanvas) {
      bgFillTimer = setTimeout(() => {
        fillBackground();
      }, 800);
    }
  });

  vncApi.onConnectionState((state: number) => {
    currentState = state;
    updateStatusBar(state);
  });

  vncApi.onServerInfo((info) => {
    fbWidth = info.width;
    fbHeight = info.height;
    serverInfoText.textContent = `${info.name} (${info.width}×${info.height})`;
    setupCanvas();
    dialog.classList.add('hidden');
    toolbarEl.classList.remove('hidden');
    statusBar.classList.remove('hidden');
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
    // 系统响铃
    try {
      const ctx = new AudioContext();
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
  const host = hostInput.value.trim();
  if (!host) {
    errorMsg.textContent = '请输入服务器地址';
    return;
  }

  const port = parseInt(portInput.value) || 5900;
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
    statusBar.classList.add('hidden');
    emptyState.classList.remove('hidden');
    if (!isFullscreen) {
      dialog.classList.remove('hidden');
    }
    connectBtn.disabled = false;
    connectBtn.textContent = '连接';
    serverInfoText.textContent = '未连接';
  });
}

function showConnectionDialog(): void {
  dialog.classList.remove('hidden');
  hostInput.focus();
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
}

function applyZoomFit(): void {
  const container = viewport;
  const containerRect = container.getBoundingClientRect();
  const padding = 20;

  const availW = containerRect.width - padding * 2;
  const availH = containerRect.height - padding * 2;

  const scaleX = availW / fbWidth;
  const scaleY = availH / fbHeight;
  zoomLevel = Math.min(scaleX, scaleY, 1); // 不放大超过原始大小

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
  } else {
    applyZoomFit();
  }
}

function setupCanvasResize(): void {
  const ro = new ResizeObserver(() => {
    if (isConnected && zoomMode === 'fit') applyZoomFit();
  });
  ro.observe(viewport);
}

// ---- 渲染 ----
function renderRect(rect: { x: number; y: number; width: number; height: number; data: number[] | Buffer; encoding: number }): void {
  if (!fbCanvas) return;

  const ctx = canvas.getContext('2d')!;

  if (rect.encoding === 1) {
    // CopyRect: data 为大端序 srcX/srcY（各 2 字节）
    const srcX = (rect.data[0] << 8) | rect.data[1];
    const srcY = (rect.data[2] << 8) | rect.data[3];
    ctx.drawImage(
      canvas,
      srcX, srcY, rect.width, rect.height,
      rect.x, rect.y, rect.width, rect.height
    );
    // 更新 ImageData 缓存
    const imageData = ctx.getImageData(0, 0, fbWidth, fbHeight);
    fbCanvas = imageData;
    return;
  }

  // 直接写入像素数据
  const data = Array.isArray(rect.data)
    ? new Uint8ClampedArray(rect.data)
    : new Uint8ClampedArray(rect.data.buffer, rect.data.byteOffset, rect.data.byteLength);

  // 更新帧缓冲
  for (let row = 0; row < rect.height; row++) {
    for (let col = 0; col < rect.width; col++) {
      const srcOff = (row * rect.width + col) * 4;
      const dstOff = ((rect.y + row) * fbWidth + rect.x + col) * 4;

      fbCanvas.data[dstOff] = data[srcOff];
      fbCanvas.data[dstOff + 1] = data[srcOff + 1];
      fbCanvas.data[dstOff + 2] = data[srcOff + 2];
      fbCanvas.data[dstOff + 3] = 255;
    }
  }

  // 只渲染更新区域
  ctx.putImageData(fbCanvas, 0, 0, rect.x, rect.y, rect.width, rect.height);
}

/**
 * 背景填充：x11vnc 等服务器不发送静态背景区域，导致帧缓冲中保留黑色(0,0,0)。
 *
 * 策略：
 * 1. 采样边缘像素推断桌面背景色（未覆盖区域通常对应纯色桌面背景）
 * 2. 用推断的背景色填充isolated黑色块（小面积孤立黑点）
 * 3. 大面积黑色区域使用边缘扩散填充（扫描整行/列找最近的非黑像素）
 * 4. 支持多次触发：每次服务器补发新数据后重新评估
 */
function fillBackground(): void {
  if (!fbCanvas) return;

  const data = fbCanvas.data;
  const w = fbWidth;
  const h = fbHeight;
  const ctx = canvas.getContext('2d')!;

  // 标记所有纯黑像素
  const isBlack = new Uint8Array(w * h);
  let blackCount = 0;
  for (let i = 0; i < w * h; i++) {
    const off = i * 4;
    if (data[off] === 0 && data[off + 1] === 0 && data[off + 2] === 0) {
      isBlack[i] = 1;
      blackCount++;
    }
  }
  if (blackCount === 0) return; // 无黑块
  if (blackCount > w * h * 0.6) return; // 黑块过多，不处理（可能是正常暗色内容）

  // 推断桌面背景色：采样四边边缘的非黑像素，取众数
  const bgColor = inferBackgroundColor(data, w, h, isBlack);
  const bgR = bgColor[0], bgG = bgColor[1], bgB = bgColor[2];

  // 阶段1：如果推断出明确背景色，直接填充所有黑色像素
  // （适用于纯色桌面背景 —— x11vnc 最常见的场景）
  if (bgR >= 0) {
    for (let i = 0; i < w * h; i++) {
      if (isBlack[i]) {
        const off = i * 4;
        data[off] = bgR;
        data[off + 1] = bgG;
        data[off + 2] = bgB;
        data[off + 3] = 255;
      }
    }
    ctx.putImageData(fbCanvas, 0, 0);
    return;
  }

  // 阶段2：无法推断全局背景色，使用边缘扩散填充
  // 多轮扫描，每轮从四个方向扫描寻找最近的非黑像素
  const MAX_ROUNDS = 32; // 最多 32 轮，每轮可扩散一整行/列
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let filled = 0;

    // 从左到右扫描
    for (let y = 0; y < h; y++) {
      let lastR = -1, lastG = -1, lastB = -1;
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (!isBlack[idx]) {
          const off = idx * 4;
          lastR = data[off]; lastG = data[off + 1]; lastB = data[off + 2];
        } else if (lastR >= 0) {
          // 暂时记录左侧颜色（后续可能被右侧覆盖）
          const off = idx * 4;
          data[off] = lastR; data[off + 1] = lastG; data[off + 2] = lastB;
          isBlack[idx] = 0;
          filled++;
        }
      }
    }
    // 从右到左扫描
    for (let y = 0; y < h; y++) {
      let lastR = -1, lastG = -1, lastB = -1;
      for (let x = w - 1; x >= 0; x--) {
        const idx = y * w + x;
        if (!isBlack[idx]) {
          const off = idx * 4;
          lastR = data[off]; lastG = data[off + 1]; lastB = data[off + 2];
        } else if (lastR >= 0) {
          const off = idx * 4;
          data[off] = lastR; data[off + 1] = lastG; data[off + 2] = lastB;
          isBlack[idx] = 0;
          filled++;
        }
      }
    }
    // 从上到下扫描
    for (let x = 0; x < w; x++) {
      let lastR = -1, lastG = -1, lastB = -1;
      for (let y = 0; y < h; y++) {
        const idx = y * w + x;
        if (!isBlack[idx]) {
          const off = idx * 4;
          lastR = data[off]; lastG = data[off + 1]; lastB = data[off + 2];
        } else if (lastR >= 0) {
          const off = idx * 4;
          data[off] = lastR; data[off + 1] = lastG; data[off + 2] = lastB;
          isBlack[idx] = 0;
          filled++;
        }
      }
    }
    // 从下到上扫描
    for (let x = 0; x < w; x++) {
      let lastR = -1, lastG = -1, lastB = -1;
      for (let y = h - 1; y >= 0; y--) {
        const idx = y * w + x;
        if (!isBlack[idx]) {
          const off = idx * 4;
          lastR = data[off]; lastG = data[off + 1]; lastB = data[off + 2];
        } else if (lastR >= 0) {
          const off = idx * 4;
          data[off] = lastR; data[off + 1] = lastG; data[off + 2] = lastB;
          isBlack[idx] = 0;
          filled++;
        }
      }
    }

    if (filled === 0) break; // 无法继续填充
  }

  // 阶段3：剩余无法扩散到的纯黑像素（孤立黑点），用推断的背景色或中灰填充
  let remaining = 0;
  for (let i = 0; i < w * h; i++) {
    if (isBlack[i]) {
      const off = i * 4;
      // 尝试从更远的邻居采样
      const color = sampleNeighborColor(data, w, h, isBlack, i % w, Math.floor(i / w));
      data[off] = color[0];
      data[off + 1] = color[1];
      data[off + 2] = color[2];
      data[off + 3] = 255;
      remaining++;
    }
  }

  // 渲染修复后的帧缓冲
  ctx.putImageData(fbCanvas, 0, 0);
}

/**
 * 从帧缓冲边缘采样，推断桌面背景色。
 * x11vnc 未发送的区域通常对应纯色桌面背景。
 * 采样策略：取四边中间 1/3 区域的非黑像素众数。
 * 返回 [-1,-1,-1] 表示无法推断。
 */
function inferBackgroundColor(
  data: Uint8ClampedArray, w: number, h: number, isBlack: Uint8Array
): [number, number, number] {
  // 颜色量化桶（按 16 级量化以减少噪声）
  const colorFreq = new Map<number, { r: number; g: number; b: number; count: number }>();

  const addColor = (r: number, g: number, b: number) => {
    // 量化到 16 级
    const qr = r >> 4, qg = g >> 4, qb = b >> 4;
    const key = (qr << 8) | (qg << 4) | qb;
    const existing = colorFreq.get(key);
    if (existing) {
      existing.count++;
    } else {
      colorFreq.set(key, { r, g, b, count: 1 });
    }
  };

  // 采样四边边缘（取中间 1/3 部分，避开角落可能存在的窗口控制按钮）
  const yStart = Math.floor(h / 3);
  const yEnd = Math.floor(h * 2 / 3);
  const xStart = Math.floor(w / 3);
  const xEnd = Math.floor(w * 2 / 3);

  // 上边
  for (let x = xStart; x < xEnd; x++) {
    const idx = x;
    if (!isBlack[idx]) addColor(data[idx * 4], data[idx * 4 + 1], data[idx * 4 + 2]);
  }
  // 下边
  for (let x = xStart; x < xEnd; x++) {
    const idx = (h - 1) * w + x;
    if (!isBlack[idx]) addColor(data[idx * 4], data[idx * 4 + 1], data[idx * 4 + 2]);
  }
  // 左边
  for (let y = yStart; y < yEnd; y++) {
    const idx = y * w;
    if (!isBlack[idx]) addColor(data[idx * 4], data[idx * 4 + 1], data[idx * 4 + 2]);
  }
  // 右边
  for (let y = yStart; y < yEnd; y++) {
    const idx = y * w + (w - 1);
    if (!isBlack[idx]) addColor(data[idx * 4], data[idx * 4 + 1], data[idx * 4 + 2]);
  }

  if (colorFreq.size === 0) return [-1, -1, -1];

  // 找到出现频率最高的颜色群
  let maxCount = 0;
  let bestColor: { r: number; g: number; b: number; count: number } | null = null;
  for (const entry of colorFreq.values()) {
    if (entry.count > maxCount) {
      maxCount = entry.count;
      bestColor = entry;
    }
  }

  // 如果最高频颜色占总采样点的 50% 以上，认为是纯色背景
  const totalSampled = Array.from(colorFreq.values()).reduce((s, e) => s + e.count, 0);
  if (bestColor && maxCount >= totalSampled * 0.3) {
    return [bestColor.r, bestColor.g, bestColor.b];
  }

  return [-1, -1, -1];
}

/**
 * 从指定位置周围的更大范围采样颜色（距离 4-16 像素）
 * 用于填充扩散后仍剩余的孤立黑点
 */
function sampleNeighborColor(
  data: Uint8ClampedArray, w: number, h: number, isBlack: Uint8Array,
  x: number, y: number
): [number, number, number] {
  // 从外向内螺旋采样，找最近的非黑像素
  for (let dist = 4; dist <= 16; dist += 4) {
    let r = 0, g = 0, b = 0, count = 0;
    // 检查四个方向的端点
    const dirs: [number, number][] = [[-dist, 0], [dist, 0], [0, -dist], [0, dist]];
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
        const ni = ny * w + nx;
        if (!isBlack[ni]) {
          r += data[ni * 4]; g += data[ni * 4 + 1]; b += data[ni * 4 + 2];
          count++;
        }
      }
    }
    if (count > 0) {
      return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
    }
  }
  // 完全找不到邻居，返回深灰色
  return [48, 48, 48];
}

// ---- 鼠标事件 ----
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

function handleMouseMove(e: MouseEvent): void {
  if (!isConnected) return;
  const pos = getCanvasPosition(e);
  lastMouseX = pos.x;
  lastMouseY = pos.y;
  vncApi.pointerEvent(mouseButtonMask, pos.x, pos.y);
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

function getCanvasPosition(e: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: Math.round((e.clientX - rect.left) * scaleX),
    y: Math.round((e.clientY - rect.top) * scaleY),
  };
}

// ---- 键盘事件 ----
function handleKeyDown(e: KeyboardEvent): void {
  if (!isConnected) return;
  e.preventDefault();

  // 特殊键组合
  if (e.ctrlKey && e.key === 'n') { showConnectionDialog(); return; }
  if (e.ctrlKey && e.key === 'd') { handleDisconnect(); return; }
  if (e.ctrlKey && e.key === '0') { setZoomMode('fit'); return; }
  if (e.ctrlKey && e.key === '1') { setZoomMode('100'); return; }

  vncApi.keyEvent(e.keyCode, true);
}

function handleKeyUp(e: KeyboardEvent): void {
  if (!isConnected) return;
  e.preventDefault();
  vncApi.keyEvent(e.keyCode, false);
}

function sendCtrlAltDel(): void {
  if (!isConnected) return;
  // 发送 Ctrl+Alt+Del
  const ctrl = 17, alt = 18, del = 46;
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

// ---- 启动 ----
document.addEventListener('DOMContentLoaded', init);