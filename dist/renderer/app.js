"use strict";
/**
 * VNC Viewer 渲染进程 - UI 逻辑
 * 参考 UltraVNC vncviewer 界面设计
 */
// ---- 状态 ----
var ConnectionState;
(function (ConnectionState) {
    ConnectionState[ConnectionState["Disconnected"] = 0] = "Disconnected";
    ConnectionState[ConnectionState["Connecting"] = 1] = "Connecting";
    ConnectionState[ConnectionState["ProtocolVersion"] = 2] = "ProtocolVersion";
    ConnectionState[ConnectionState["Security"] = 3] = "Security";
    ConnectionState[ConnectionState["Authentication"] = 4] = "Authentication";
    ConnectionState[ConnectionState["ClientInit"] = 5] = "ClientInit";
    ConnectionState[ConnectionState["ServerInit"] = 6] = "ServerInit";
    ConnectionState[ConnectionState["Connected"] = 7] = "Connected";
    ConnectionState[ConnectionState["Error"] = 8] = "Error";
})(ConnectionState || (ConnectionState = {}));
// ---- DOM 引用 ----
function getEl(id) {
    return document.getElementById(id);
}
const dialog = getEl('connection-dialog');
const hostInput = getEl('host');
const portInput = getEl('port');
const displayInput = getEl('display');
const passwordInput = getEl('password');
const sharedCheck = getEl('shared');
const connectBtn = getEl('connect-btn');
const errorMsg = getEl('error-msg');
const statusBar = getEl('status-bar');
const statusIndicator = getEl('status-indicator');
const statusText = getEl('status-text');
const serverInfoText = getEl('server-info-text');
const qualityText = getEl('quality-text');
const zoomText = getEl('zoom-text');
const toolbarEl = getEl('toolbar');
const canvas = getEl('vnc-canvas');
const emptyState = getEl('empty-state');
const viewport = getEl('viewport-container');
const btnNewConn = getEl('btn-new-conn');
const btnDisconnect = getEl('btn-disconnect');
const btnZoomFit = getEl('btn-zoom-fit');
const btnZoom100 = getEl('btn-zoom-100');
const btnFullscreen = getEl('btn-fullscreen');
const btnCtrlAltDel = getEl('btn-ctrl-alt-del');
const btnClipboard = getEl('btn-clipboard');
const btnLog = getEl('btn-log');
const logPanel = getEl('log-panel');
const logBody = getEl('log-body');
const logAutoScroll = getEl('log-autoscroll');
const btnLogClear = getEl('btn-log-clear');
const btnLogClose = getEl('btn-log-close');
// 设置对话框
const settingsDialog = getEl('settings-dialog');
const settingsPortInput = getEl('settings-mobile-port');
const settingsErrorMsg = getEl('settings-error-msg');
const btnSettingsSave = getEl('btn-settings-save');
const btnSettingsCancel = getEl('btn-settings-cancel');
// ---- 状态变量 ----
let isConnected = false;
let isFullscreen = false;
let zoomLevel = 1;
let zoomMode = 'fit';
// 帧缓冲数据
let fbWidth = 0;
let fbHeight = 0;
let fbCanvas = null;
// 鼠标状态
let mouseButtonMask = 0;
let lastMouseX = 0;
let lastMouseY = 0;
let isPointerInside = false;
// 连接状态
let currentState = ConnectionState.Disconnected;
// ---- 初始化 ----
function init() {
    setupEventListeners();
    setupIPCListeners();
    setupCanvasResize();
    // 聚焦到主机输入框
    hostInput.focus();
}
// ---- 事件监听 ----
function setupEventListeners() {
    // 连接按钮
    connectBtn.addEventListener('click', handleConnect);
    // 回车键触发连接
    passwordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')
            handleConnect();
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
        if (text !== null)
            vncApi.sendCutText(text);
    });
    // 日志面板开关
    btnLog.addEventListener('click', toggleLogPanel);
    btnLogClose.addEventListener('click', toggleLogPanel);
    btnLogClear.addEventListener('click', clearLogView);
    // 设置对话框
    btnSettingsSave.addEventListener('click', saveSettings);
    btnSettingsCancel.addEventListener('click', closeSettings);
    settingsPortInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')
            saveSettings();
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
        if (zoomMode === 'fit')
            applyZoomFit();
    });
}
// ---- IPC 监听 ----
function setupIPCListeners() {
    // 实时接收主进程推送的日志
    vncApi.onLog((entry) => {
        appendLog(entry);
    });
    vncApi.onFramebufferUpdate((rect) => {
        renderRect(rect);
    });
    vncApi.onConnectionState((state) => {
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
        if (zoomMode === 'fit')
            applyZoomFit();
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
        }
        catch (_) { /* ignore */ }
    });
    vncApi.onClipboard((text) => {
        navigator.clipboard.writeText(text).catch(() => { });
    });
    vncApi.onDesktopSize((size) => {
        fbWidth = size.width;
        fbHeight = size.height;
        serverInfoText.textContent = serverInfoText.textContent?.replace(/\d+×\d+/, `${size.width}×${size.height}`) || '';
        setupCanvas();
        if (zoomMode === 'fit')
            applyZoomFit();
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
function toggleLogPanel() {
    const isHidden = logPanel.classList.contains('hidden');
    logPanel.classList.toggle('hidden', !isHidden);
    if (isHidden) {
        // 打开时重新从主进程拉取最新日志
        vncApi.getLogs().then((entries) => {
            logBody.innerHTML = '';
            for (const e of entries)
                appendLog(e);
            scrollLogToBottom();
        });
    }
}
function clearLogView() {
    vncApi.clearLogs();
    logBody.innerHTML = '';
}
function appendLog(entry) {
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
    if (logAutoScroll.checked)
        scrollLogToBottom();
}
function scrollLogToBottom() {
    logBody.scrollTop = logBody.scrollHeight;
}
// ---- 设置对话框 ----
function showSettings() {
    settingsErrorMsg.textContent = '';
    // 从主进程加载当前配置
    vncApi.getSettings().then((config) => {
        settingsPortInput.value = String(config.mobilePort || 5933);
    });
    settingsDialog.classList.remove('hidden');
    settingsPortInput.focus();
    settingsPortInput.select();
}
function closeSettings() {
    settingsDialog.classList.add('hidden');
    settingsErrorMsg.textContent = '';
}
function saveSettings() {
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
    }).catch((err) => {
        settingsErrorMsg.textContent = `保存失败: ${err.message}`;
    }).finally(() => {
        btnSettingsSave.disabled = false;
        btnSettingsSave.textContent = '保存';
    });
}
// ---- 连接管理 ----
function handleConnect() {
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
    vncApi.connect({ host, port, password, shared }).catch((err) => {
        errorMsg.textContent = `连接失败: ${err.message}`;
        connectBtn.disabled = false;
        connectBtn.textContent = '连接';
    });
}
function handleDisconnect() {
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
function showConnectionDialog() {
    dialog.classList.remove('hidden');
    hostInput.focus();
}
// ---- 画布管理 ----
function setupCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = fbWidth;
    canvas.height = fbHeight;
    canvas.style.width = `${fbWidth}px`;
    canvas.style.height = `${fbHeight}px`;
    const ctx = canvas.getContext('2d');
    fbCanvas = ctx.createImageData(fbWidth, fbHeight);
    // 初始化为黑色
    for (let i = 0; i < fbCanvas.data.length; i++) {
        fbCanvas.data[i] = 0;
    }
}
function applyZoomFit() {
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
function setZoomMode(mode) {
    zoomMode = mode;
    if (mode === '100') {
        zoomLevel = 1;
        canvas.style.width = `${fbWidth}px`;
        canvas.style.height = `${fbHeight}px`;
        zoomText.textContent = '100%';
    }
    else {
        applyZoomFit();
    }
}
function setupCanvasResize() {
    const ro = new ResizeObserver(() => {
        if (isConnected && zoomMode === 'fit')
            applyZoomFit();
    });
    ro.observe(viewport);
}
// ---- 渲染 ----
function renderRect(rect) {
    if (!fbCanvas)
        return;
    const ctx = canvas.getContext('2d');
    if (rect.encoding === 1) {
        // CopyRect: 从源位置复制
        // rect.data 包含 srcX, srcY
        // 无法用 ImageData 直接实现，使用 drawImage
        const srcX = rect.data[0] + rect.data[1] * 256;
        const srcY = rect.data[2] + rect.data[3] * 256;
        ctx.drawImage(canvas, srcX, srcY, rect.width, rect.height, rect.x, rect.y, rect.width, rect.height);
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
// ---- 鼠标事件 ----
function handleMouseDown(e) {
    if (!isConnected)
        return;
    canvas.focus();
    const btn = e.button;
    let mask = 0;
    if (btn === 0)
        mask = 1; // 左键
    else if (btn === 1)
        mask = 4; // 中键
    else if (btn === 2)
        mask = 2; // 右键
    mouseButtonMask |= mask;
    const pos = getCanvasPosition(e);
    vncApi.pointerEvent(mouseButtonMask, pos.x, pos.y);
}
function handleMouseUp(e) {
    if (!isConnected)
        return;
    const btn = e.button;
    let mask = 0;
    if (btn === 0)
        mask = 1;
    else if (btn === 1)
        mask = 4;
    else if (btn === 2)
        mask = 2;
    mouseButtonMask &= ~mask;
    const pos = getCanvasPosition(e);
    vncApi.pointerEvent(mouseButtonMask, pos.x, pos.y);
}
function handleMouseMove(e) {
    if (!isConnected)
        return;
    const pos = getCanvasPosition(e);
    lastMouseX = pos.x;
    lastMouseY = pos.y;
    vncApi.pointerEvent(mouseButtonMask, pos.x, pos.y);
}
function handleMouseWheel(e) {
    if (!isConnected)
        return;
    e.preventDefault();
    const delta = Math.sign(e.deltaY);
    let mask = mouseButtonMask;
    if (delta < 0) {
        // 滚轮上
        mask |= 8; // 按钮4
        const pos = getCanvasPosition(e);
        vncApi.pointerEvent(mask, pos.x, pos.y);
        mask &= ~8;
        vncApi.pointerEvent(mask, pos.x, pos.y);
    }
    else {
        // 滚轮下
        mask |= 16; // 按钮5
        const pos = getCanvasPosition(e);
        vncApi.pointerEvent(mask, pos.x, pos.y);
        mask &= ~16;
        vncApi.pointerEvent(mask, pos.x, pos.y);
    }
}
function getCanvasPosition(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
        x: Math.round((e.clientX - rect.left) * scaleX),
        y: Math.round((e.clientY - rect.top) * scaleY),
    };
}
// ---- 键盘事件 ----
function handleKeyDown(e) {
    if (!isConnected)
        return;
    e.preventDefault();
    // 特殊键组合
    if (e.ctrlKey && e.key === 'n') {
        showConnectionDialog();
        return;
    }
    if (e.ctrlKey && e.key === 'd') {
        handleDisconnect();
        return;
    }
    if (e.ctrlKey && e.key === '0') {
        setZoomMode('fit');
        return;
    }
    if (e.ctrlKey && e.key === '1') {
        setZoomMode('100');
        return;
    }
    vncApi.keyEvent(e.keyCode, true);
}
function handleKeyUp(e) {
    if (!isConnected)
        return;
    e.preventDefault();
    vncApi.keyEvent(e.keyCode, false);
}
function sendCtrlAltDel() {
    if (!isConnected)
        return;
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
function toggleFullscreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().then(() => {
            isFullscreen = true;
        }).catch(() => { });
    }
    else {
        exitFullscreen();
    }
}
function exitFullscreen() {
    if (document.fullscreenElement) {
        document.exitFullscreen().then(() => {
            isFullscreen = false;
        }).catch(() => { });
    }
}
// ---- 状态栏更新 ----
function updateStatusBar(state) {
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
//# sourceMappingURL=app.js.map