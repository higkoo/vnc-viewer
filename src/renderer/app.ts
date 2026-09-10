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

  // 画布外释放 / 窗口失焦时清掉残留按键，防止远程鼠标键一直处于按下状态
  // （拖拽移出窗口后松键是鼠标操作的常见失效场景）
  window.addEventListener('mouseup', handleWindowMouseUp);
  window.addEventListener('blur', handleWindowBlur);

  // 画布右键菜单
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // 键盘事件提升到 window 级：即使画布因点击工具栏等操作失焦，
  // 键盘仍能送达远程（此前画布失焦后按键会"消失"，表现为无法操作）。
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);

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

  // 主进程按帧批量推送矩形（数组），兼容旧版单个矩形
  vncApi.onFramebufferUpdate((rect: any) => {
    if (Array.isArray(rect)) {
      for (const r of rect) renderRect(r);
    } else {
      renderRect(rect);
    }
    lastFrameTime = Date.now();
    // 重置背景填充计时器：如果 800ms 无新帧，触发背景填充
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
    ctx.putImageData(fbCanvas, 0, 0, rect.x, rect.y, rect.width, rect.height);
    return;
  }

  const data = Array.isArray(rect.data)
    ? new Uint8ClampedArray(rect.data)
    : new Uint8ClampedArray(rect.data.buffer, rect.data.byteOffset, rect.data.byteLength);

  // 裁剪到帧缓冲范围，防止越界
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const w = Math.min(rect.width, fbWidth - x);
  const h = Math.min(rect.height, fbHeight - y);
  if (w <= 0 || h <= 0) return;
  const skipX = x - rect.x;
  const skipY = y - rect.y;

  // 用 32 位视图按行整块拷贝（解码器已保证 alpha=255），比逐像素循环快一个数量级
  const src32 = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2);
  const dst32 = new Uint32Array(fbCanvas.data.buffer);
  for (let row = 0; row < h; row++) {
    const srcStart = (skipY + row) * rect.width + skipX;
    const dstStart = (y + row) * fbWidth + x;
    dst32.set(src32.subarray(srcStart, srcStart + w), dstStart);
  }

  // 只渲染更新区域
  ctx.putImageData(fbCanvas, 0, 0, x, y, w, h);
}

/**
 * 背景填充：x11vnc 等服务器不发送静态背景区域，导致帧缓冲中保留黑色(0,0,0)。
 *
 * 三段式策略：
 * 1. 纯色推断：从边缘采样推断背景主色调，直接填充所有黑块（适合纯色桌面）
 * 2. 扫描线扩散：32 轮四方向扫描，用最近非黑像素填充（适合渐变/纹理背景）
 * 3. 孤立点修复：对仍未修复的黑点做螺旋采样，取 4-16px 范围内最近非黑像素
 */
function fillBackground(): void {
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

// 窗口失焦（如切换应用/Alt-Tab）时释放全部鼠标键
function handleWindowBlur(): void {
  if (!isConnected || mouseButtonMask === 0) return;
  mouseButtonMask = 0;
  vncApi.pointerEvent(0, lastMouseX, lastMouseY);
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
// 焦点在输入控件/按钮上时按键归控件所有，不应转发给远程
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    || tag === 'BUTTON' || el.isContentEditable;
}

function handleKeyDown(e: KeyboardEvent): void {
  if (!isConnected || isTypingTarget(e.target)) return;
  e.preventDefault();

  // 特殊键组合
  if (e.ctrlKey && e.key === 'n') { showConnectionDialog(); return; }
  if (e.ctrlKey && e.key === 'd') { handleDisconnect(); return; }
  if (e.ctrlKey && e.key === '0') { setZoomMode('fit'); return; }
  if (e.ctrlKey && e.key === '1') { setZoomMode('100'); return; }

  vncApi.keyEvent(e.keyCode, true);
}

function handleKeyUp(e: KeyboardEvent): void {
  if (!isConnected || isTypingTarget(e.target)) return;
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