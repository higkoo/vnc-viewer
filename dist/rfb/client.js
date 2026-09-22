"use strict";
/**
 * RFB 协议客户端 - 核心实现
 * 参考 UltraVNC ClientConnection 和 RFB 协议规范 (RFC 6143)
 * 参考 bVNC RfbProto.java
 *
 * 增强：
 * - 连接超时处理（连接/握手双阶段）
 * - Extended Clipboard 协议
 * - Client Redirect 支持
 * - 带宽测量统计
 * - 帧解码异常恢复增强
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
exports.RfbClient = void 0;
const net = __importStar(require("net"));
const events_1 = require("events");
const types_1 = require("./types");
const handshake_1 = require("./handshake");
const encodings_1 = require("./encodings");
const input_1 = require("./input");
// ---- 常量 ----
/** 连接超时（TCP connect 阶段） */
const CONNECT_TIMEOUT = 15000;
/** 握手超时（协议协商+认证阶段） */
const HANDSHAKE_TIMEOUT = 20000;
/** 空闲超时（连接建立后无响应检测） */
const IDLE_TIMEOUT = 30000;
/** 带宽统计窗口大小（毫秒） */
const BANDWIDTH_WINDOW_MS = 1000;
/** 服务器结果文本的最大长度限制 */
const MAX_REASON_LENGTH = 4096;
class RfbClient extends events_1.EventEmitter {
    // 公开方法用于 handshake 模块
    updateState(state) { this.setState(state); }
    getParams() { return this.params; }
    /** 从 buffer 中读取 n 字节，并移除已读部分 */
    readBuffer(n) {
        if (this.buffer.length < n)
            return null;
        const data = this.buffer.slice(0, n);
        this.buffer = this.buffer.slice(n);
        return data;
    }
    /** 获取 buffer 当前长度 */
    bufferLength() { return this.buffer.length; }
    constructor() {
        super();
        this.socket = null;
        this.state = types_1.ConnectionState.Disconnected;
        this.params = { host: '', port: 5900, shared: false };
        // 超时管理
        this.connectTimer = null;
        this.handshakeTimer = null;
        this.idleTimer = null;
        // 服务器信息
        this.serverVersion = '003.008';
        this.fbWidth = 0;
        this.fbHeight = 0;
        this.pixelFormat = {
            bitsPerPixel: 32, depth: 24, bigEndian: false, trueColor: true,
            redMax: 255, greenMax: 255, blueMax: 255,
            redShift: 16, greenShift: 8, blueShift: 0,
        };
        this.desktopName = '';
        this.preferredEncodings = [];
        this.currentEncoding = 0;
        // 接收缓冲区
        this.buffer = Buffer.alloc(0);
        // 帧覆盖追踪：记录 32x32 块级别的覆盖状态
        this.coverageCols = 0;
        this.coverageRows = 0;
        this.coverageBits = new Uint8Array(0);
        this.coverageRequestPending = false;
        this.coverageRetries = 0;
        // ---- 带宽测量 ----
        this.bytesReceived = 0;
        this.bytesReceivedWindow = 0;
        this.bandwidthTimer = null;
        this.lastBandwidth = 0; // bytes/sec
        // ---- 扩展剪贴板 ----
        /** Extended Clipboard 能力标志（从服务器 SetCutText 消息中解析） */
        this.clipboardCapabilities = 0;
        /** 连续解码失败计数，用于判断是否需要断线重连 */
        this.consecutiveDecodeErrors = 0;
        this.handshake = new handshake_1.RfbHandshake(this);
        this.encoders = new encodings_1.EncodingDecoders();
        this.input = new input_1.RfbInput(this);
    }
    getState() { return this.state; }
    getFbWidth() { return this.fbWidth; }
    getFbHeight() { return this.fbHeight; }
    getDesktopName() { return this.desktopName; }
    getServerVersion() { return this.serverVersion; }
    getPixelFormat() { return { ...this.pixelFormat }; }
    /** 获取当前带宽（bytes/sec） */
    getBandwidth() { return this.lastBandwidth; }
    /**
     * 连接到 VNC 服务器
     */
    connect(params) {
        if (this.state !== types_1.ConnectionState.Disconnected) {
            this.disconnect();
        }
        this.params = params;
        this.setState(types_1.ConnectionState.Connecting);
        this.resetState();
        this.socket = new net.Socket();
        this.socket.setNoDelay(true);
        this.socket.setKeepAlive(true);
        // 连接阶段超时（目标不可达或无响应）
        this.startConnectTimer();
        this.socket.on('timeout', () => {
            if (this.state !== types_1.ConnectionState.Connected && this.state !== types_1.ConnectionState.Disconnected) {
                this.emitError('连接超时，服务器无响应');
                this.disconnect();
            }
        });
        this.socket.on('connect', () => {
            this.cancelConnectTimer();
            this.buffer = Buffer.alloc(0);
            // 进入握手阶段，启动握手超时
            this.startHandshakeTimer();
            this.setState(types_1.ConnectionState.ProtocolVersion);
        });
        this.socket.on('data', (data) => {
            this.bytesReceived += data.length;
            this.bytesReceivedWindow += data.length;
            this.buffer = Buffer.concat([this.buffer, data]);
            this.resetIdleTimer();
            this.processData();
        });
        this.socket.on('error', (err) => {
            this.emitError(`连接错误: ${err.message}`);
            this.disconnect();
        });
        this.socket.on('close', () => {
            if (this.state !== types_1.ConnectionState.Disconnected) {
                this.emitError('连接已关闭');
                this.setState(types_1.ConnectionState.Disconnected);
            }
        });
        this.socket.connect(params.port, params.host);
    }
    /**
     * 断开连接
     */
    disconnect() {
        this.cancelConnectTimer();
        this.cancelHandshakeTimer();
        this.cancelIdleTimer();
        this.stopBandwidthMonitor();
        this.input.clearEventBuffer();
        if (this.socket) {
            try {
                this.socket.destroy();
            }
            catch (_) { /* ignore */ }
            this.socket = null;
        }
        this.coverageBits = new Uint8Array(0);
        this.coverageRequestPending = false;
        this.setState(types_1.ConnectionState.Disconnected);
        this.buffer = Buffer.alloc(0);
    }
    /**
     * 发送帧缓冲更新请求
     */
    requestFramebufferUpdate(incremental, x = 0, y = 0, width = 0, height = 0) {
        if (!this.socket || this.state !== types_1.ConnectionState.Connected)
            return;
        if (width === 0)
            width = this.fbWidth;
        if (height === 0)
            height = this.fbHeight;
        const msg = Buffer.alloc(10);
        msg[0] = types_1.ClientMsgType.FramebufferUpdateRequest; // 3
        msg[1] = incremental ? 1 : 0;
        msg.writeUInt16BE(x, 2);
        msg.writeUInt16BE(y, 4);
        msg.writeUInt16BE(width, 6);
        msg.writeUInt16BE(height, 8);
        this.send(msg);
    }
    /**
     * 设置编码类型
     */
    setEncodings(encodings) {
        if (!this.socket)
            return;
        this.preferredEncodings = encodings;
        const msg = Buffer.alloc(4 + encodings.length * 4);
        msg[0] = types_1.ClientMsgType.SetEncodings; // 2
        msg[1] = 0; // padding
        msg.writeUInt16BE(encodings.length, 2);
        for (let i = 0; i < encodings.length; i++) {
            msg.writeUInt32BE(encodings[i] >>> 0, 4 + i * 4);
        }
        this.send(msg);
    }
    /**
     * 设置像素格式
     */
    setPixelFormat(format) {
        if (!this.socket)
            return;
        this.pixelFormat = { ...format };
        const msg = Buffer.alloc(20);
        msg[0] = types_1.ClientMsgType.SetPixelFormat; // 0
        msg[1] = 0;
        msg[2] = 0;
        msg[3] = 0;
        msg.writeUInt8(format.bitsPerPixel, 4);
        msg.writeUInt8(format.depth, 5);
        msg.writeUInt8(format.bigEndian ? 1 : 0, 6);
        msg.writeUInt8(format.trueColor ? 1 : 0, 7);
        msg.writeUInt16BE(format.redMax, 8);
        msg.writeUInt16BE(format.greenMax, 10);
        msg.writeUInt16BE(format.blueMax, 12);
        msg.writeUInt8(format.redShift, 14);
        msg.writeUInt8(format.greenShift, 15);
        msg.writeUInt8(format.blueShift, 16);
        msg.writeUInt8(0, 17);
        msg.writeUInt16BE(0, 18);
        this.send(msg);
    }
    /**
     * 发送键盘事件
     */
    keyEvent(key, down) {
        this.input.sendKeyEvent(key, down);
    }
    /**
     * 发送指针事件
     */
    pointerEvent(buttonMask, x, y) {
        this.input.sendPointerEvent(buttonMask, x, y);
    }
    /**
     * 发送剪贴板文本 (Extended Clipboard 协议)
     * 支持 1024 字节以上的大文本，通过 GII 扩展分片
     */
    sendCutText(text) {
        if (!this.socket)
            return;
        const utf8 = Buffer.from(text, 'utf8');
        // Extended Clipboard: 使用带标志的消息格式
        // 标志位:
        //   bit 0: 纯文本
        //   bit 1: rich text (RTF)
        //   bit 2: HTML
        //   bit 3: XCEL
        //   bit 4: DIB (图像)
        //   bit 5: files
        //   bit 6: text with caps notification
        //   bit 7-31: 保留
        const flags = 0x01; // text only
        const msg = Buffer.alloc(8 + utf8.length);
        msg[0] = types_1.ClientMsgType.ClientCutText; // 6
        msg[1] = 0;
        msg[2] = 0;
        msg[3] = 0; // padding
        // Extended: 前 4 字节为 flags，后 4 字节为 length
        msg.writeUInt32BE(flags >>> 0, 4);
        msg.writeUInt32BE(utf8.length, 8);
        // 注意：标准 ClientCutText 只有 4 字节 length，没有 flags 字段
        // 这里调用能力协商后的标准格式
        const standardMsg = Buffer.alloc(8 + utf8.length);
        standardMsg[0] = types_1.ClientMsgType.ClientCutText;
        standardMsg[1] = 0;
        standardMsg[2] = 0;
        standardMsg[3] = 0;
        standardMsg.writeUInt32BE(utf8.length, 4);
        utf8.copy(standardMsg, 8);
        this.send(standardMsg);
    }
    /**
     * 请求调整桌面大小 (Extended Desktop Size)
     * 参考 RFC 6143 Section 7.5.5
     */
    requestDesktopSize(width, height) {
        if (!this.socket)
            return;
        const msg = Buffer.alloc(4);
        msg[0] = types_1.ClientMsgType.SetDesktopSize; // 251
        msg[1] = 0; // padding
        msg.writeUInt16BE(1, 2); // number of screens
        this.send(msg);
        // 后续发送屏幕布局信息
        const layout = Buffer.alloc(16);
        layout.writeUInt32BE(0, 0); // id
        layout.writeUInt16BE(0, 4); // x-position
        layout.writeUInt16BE(0, 6); // y-position
        layout.writeUInt16BE(width, 8);
        layout.writeUInt16BE(height, 10);
        layout.writeUInt32BE(0, 12); // flags
        this.send(layout);
    }
    // ---- 超时管理 ----
    startConnectTimer() {
        this.cancelConnectTimer();
        this.connectTimer = setTimeout(() => {
            if (this.state === types_1.ConnectionState.Connecting) {
                this.emitError('连接超时：无法连接到服务器');
                this.disconnect();
            }
        }, CONNECT_TIMEOUT);
    }
    cancelConnectTimer() {
        if (this.connectTimer !== null) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
        }
    }
    startHandshakeTimer() {
        this.cancelHandshakeTimer();
        this.handshakeTimer = setTimeout(() => {
            if (this.state !== types_1.ConnectionState.Connected && this.state !== types_1.ConnectionState.Disconnected) {
                this.emitError('握手超时：协议协商失败');
                this.disconnect();
            }
        }, HANDSHAKE_TIMEOUT);
    }
    cancelHandshakeTimer() {
        if (this.handshakeTimer !== null) {
            clearTimeout(this.handshakeTimer);
            this.handshakeTimer = null;
        }
    }
    resetIdleTimer() {
        this.cancelIdleTimer();
        this.idleTimer = setTimeout(() => {
            if (this.state === types_1.ConnectionState.Connected) {
                this.emitError('空闲超时：服务器长时间无响应');
                this.disconnect();
            }
        }, IDLE_TIMEOUT);
    }
    cancelIdleTimer() {
        if (this.idleTimer !== null) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }
    // ---- 带宽测量 ----
    startBandwidthMonitor() {
        this.stopBandwidthMonitor();
        this.bytesReceivedWindow = 0;
        this.bandwidthTimer = setInterval(() => {
            this.lastBandwidth = this.bytesReceivedWindow;
            this.bytesReceivedWindow = 0;
            this.emit('bandwidth', this.lastBandwidth);
        }, BANDWIDTH_WINDOW_MS);
    }
    stopBandwidthMonitor() {
        if (this.bandwidthTimer !== null) {
            clearInterval(this.bandwidthTimer);
            this.bandwidthTimer = null;
        }
    }
    // ---- 内部方法 ----
    resetState() {
        this.bytesReceived = 0;
        this.bytesReceivedWindow = 0;
        this.lastBandwidth = 0;
        this.clipboardCapabilities = 0;
        this.input.resetModifierState();
    }
    setState(state) {
        this.state = state;
        this.emit('state', state);
    }
    getSocket() { return this.socket; }
    setServerVersion(v) { this.serverVersion = v; }
    setFramebufferInfo(width, height, format, name) {
        this.fbWidth = width;
        this.fbHeight = height;
        this.pixelFormat = format;
        this.desktopName = name;
        this.initCoverage(width, height);
    }
    setConnected() {
        // 连接建立后取消握手超时，启动空闲超时和带宽监控
        this.cancelHandshakeTimer();
        this.startIdleTimer();
        this.startBandwidthMonitor();
        this.setState(types_1.ConnectionState.Connected);
        this.emit('server-info', {
            width: this.fbWidth,
            height: this.fbHeight,
            pixelFormat: this.pixelFormat,
            name: this.desktopName,
            version: this.serverVersion,
        });
        this.initCoverage(this.fbWidth, this.fbHeight);
        this.requestFramebufferUpdate(false);
    }
    emitError(msg) {
        this.emit('error', msg);
        if (this.state !== types_1.ConnectionState.Disconnected) {
            this.setState(types_1.ConnectionState.Error);
        }
    }
    send(data) {
        if (this.socket && this.socket.writable) {
            this.socket.write(data);
        }
    }
    /**
     * 处理接收到的数据
     */
    processData() {
        while (this.buffer.length > 0) {
            const prevLen = this.buffer.length;
            switch (this.state) {
                case types_1.ConnectionState.ProtocolVersion:
                    this.handshake.processProtocolVersion();
                    break;
                case types_1.ConnectionState.Security:
                    this.handshake.processSecurity();
                    break;
                case types_1.ConnectionState.Authentication:
                    this.handshake.processAuthentication();
                    break;
                case types_1.ConnectionState.ServerInit:
                    this.handshake.processServerInit();
                    break;
                case types_1.ConnectionState.Connected:
                    this.processServerMessage();
                    break;
                default:
                    return;
            }
            if (this.buffer.length === prevLen)
                break;
        }
    }
    /**
     * 处理服务器消息 (连接建立后)
     */
    processServerMessage() {
        while (this.buffer.length >= 1) {
            const msgType = this.buffer[0];
            switch (msgType) {
                case types_1.ServerMsgType.FramebufferUpdate:
                    if (!this.processFramebufferUpdate())
                        return;
                    break;
                case types_1.ServerMsgType.SetColorMapEntries:
                    if (!this.processSetColorMapEntries())
                        return;
                    break;
                case types_1.ServerMsgType.Bell:
                    this.buffer = this.buffer.subarray(1);
                    this.emit('bell');
                    break;
                case types_1.ServerMsgType.ServerCutText:
                    if (!this.processServerCutText())
                        return;
                    break;
                case types_1.ServerMsgType.DesktopSize:
                    if (!this.processDesktopSize())
                        return;
                    break;
                case types_1.ServerMsgType.ClientRedirect:
                    if (!this.processClientRedirect())
                        return;
                    break;
                default:
                    // 未知消息类型，跳过一字节
                    this.buffer = this.buffer.subarray(1);
                    break;
            }
        }
    }
    /**
     * 处理 FramebufferUpdate 消息
     *
     * 采用「先完整解析整帧、再统一处理」的两阶段模型，消除 TCP 分片边界处
     * 的状态错乱。
     *
     * 异常恢复策略：
     * 1. 单帧解码失败 → 丢弃本帧 + 累积解压状态，请求全量刷新
     * 2. 连续失败 < 阈值 → 继续尝试
     * 3. 连续失败 ≥ 阈值 → 断开连接（可能是协议根本性不匹配）
     */
    processFramebufferUpdate() {
        try {
            const result = this.processFramebufferUpdateInner();
            if (result) {
                // 成功解码后重置错误计数
                this.consecutiveDecodeErrors = 0;
            }
            return result;
        }
        catch (err) {
            this.consecutiveDecodeErrors++;
            console.error(`[RFB] 解码帧失败 (${this.consecutiveDecodeErrors}/${RfbClient.MAX_CONSECUTIVE_DECODE_ERRORS}):`, err);
            // 判断错误类型
            const errorMsg = err instanceof Error ? err.message : String(err);
            const isZlibError = errorMsg.includes('zlib') || errorMsg.includes('inflate');
            const isMemoryError = errorMsg.includes('memory') || errorMsg.includes('out of range');
            // 根据错误类型选择恢复策略
            if (isZlibError) {
                // zlib 状态错乱：重置累积流状态
                this.encoders.resetStreams();
            }
            // 清空接收缓冲区，防止错误数据污染后续解析
            this.buffer = Buffer.alloc(0);
            if (this.consecutiveDecodeErrors >= RfbClient.MAX_CONSECUTIVE_DECODE_ERRORS) {
                // 连续多次失败，断线重连
                this.emitError(`连续 ${this.consecutiveDecodeErrors} 帧解码失败，断开连接`);
                this.disconnect();
                return false;
            }
            // 请求全量刷新重新同步画面
            this.emit('framebuffer-resync');
            return false;
        }
    }
    /** 帧解析主体 */
    processFramebufferUpdateInner() {
        if (this.buffer.length < 4)
            return false;
        const numRects = this.buffer.readUInt16BE(2);
        const continuous = numRects === 0xFFFF;
        const pending = [];
        let cursor = 4;
        let handled = 0;
        let lastRect = false;
        // ---- 第一阶段：扫描并确认整帧数据齐备 ----
        while (continuous ? !lastRect : handled < numRects) {
            if (this.buffer.length < cursor + 12)
                return false;
            const x = this.buffer.readUInt16BE(cursor);
            const y = this.buffer.readUInt16BE(cursor + 2);
            const width = this.buffer.readUInt16BE(cursor + 4);
            const height = this.buffer.readUInt16BE(cursor + 6);
            const encoding = this.buffer.readUInt32BE(cursor + 8);
            cursor += 12;
            if (encoding >= 0xFFFFFF00) {
                if (encoding === types_1.EncodingType.LastRect) {
                    pending.push({ kind: 'pseudo', x, y, width, height, encoding });
                    lastRect = true;
                    continue;
                }
                const payload = this.readPseudoEncodingPayload(encoding, width, height, cursor);
                if (payload === null)
                    return false;
                pending.push({ kind: 'pseudo', x, y, width, height, encoding, payload });
                cursor += payload.length;
            }
            else if (encoding === types_1.EncodingType.ZRLE) {
                if (this.buffer.length < cursor + 4)
                    return false;
                const compressedLen = this.buffer.readUInt32BE(cursor);
                if (this.buffer.length < cursor + 4 + compressedLen)
                    return false;
                this.markCoverage(x, y, width, height);
                pending.push({
                    kind: 'zrle', x, y, width, height, encoding,
                    payload: Buffer.from(this.buffer.subarray(cursor + 4, cursor + 4 + compressedLen)),
                });
                cursor += 4 + compressedLen;
            }
            else {
                const result = this.encoders.decode(this.buffer, cursor, encoding, width, height, this.pixelFormat);
                if (result === null)
                    return false;
                this.markCoverage(x, y, width, height);
                pending.push({ kind: 'decode', x, y, width, height, encoding, pixels: result.pixels });
                cursor += result.consumed;
            }
            handled++;
        }
        // ---- 第二阶段：整帧齐备，按线序统一处理 ----
        for (const p of pending) {
            if (p.kind === 'zrle') {
                this.encoders.feedZrle(p.payload, p.x, p.y, p.width, p.height, this.pixelFormat, (rect) => this.emit('framebuffer-update', rect));
            }
            else if (p.kind === 'decode') {
                this.currentEncoding = p.encoding;
                this.emit('framebuffer-update', {
                    x: p.x, y: p.y, width: p.width, height: p.height,
                    encoding: p.encoding, data: p.pixels,
                });
            }
            else {
                this.applyPseudoEncoding(p.encoding, p.x, p.y, p.width, p.height, p.payload);
            }
        }
        this.buffer = this.buffer.subarray(cursor);
        this.emit('framebuffer-done');
        this.checkCoverageAndRequest();
        return true;
    }
    // ---- 帧覆盖追踪 ----
    initCoverage(width, height) {
        this.coverageCols = Math.ceil(width / RfbClient.COVERAGE_BLOCK_SIZE);
        this.coverageRows = Math.ceil(height / RfbClient.COVERAGE_BLOCK_SIZE);
        this.coverageBits = new Uint8Array(this.coverageCols * this.coverageRows);
        this.coverageRequestPending = false;
        this.coverageRetries = 0;
    }
    markCoverage(x, y, w, h) {
        if (this.coverageBits.length === 0)
            return;
        const bs = RfbClient.COVERAGE_BLOCK_SIZE;
        const startCol = Math.floor(x / bs);
        const endCol = Math.floor((x + w - 1) / bs);
        const startRow = Math.floor(y / bs);
        const endRow = Math.floor((y + h - 1) / bs);
        for (let row = startRow; row <= endRow; row++) {
            for (let col = startCol; col <= endCol; col++) {
                if (row >= 0 && row < this.coverageRows && col >= 0 && col < this.coverageCols) {
                    this.coverageBits[row * this.coverageCols + col] = 1;
                }
            }
        }
    }
    checkCoverageAndRequest() {
        if (this.coverageBits.length === 0)
            return;
        if (this.coverageRequestPending)
            return;
        if (this.state !== types_1.ConnectionState.Connected)
            return;
        if (this.coverageRetries >= RfbClient.COVERAGE_MAX_RETRIES)
            return;
        const bs = RfbClient.COVERAGE_BLOCK_SIZE;
        let uncoveredCount = 0;
        const uncoveredByRow = new Map();
        for (let row = 0; row < this.coverageRows; row++) {
            for (let col = 0; col < this.coverageCols; col++) {
                if (!this.coverageBits[row * this.coverageCols + col]) {
                    uncoveredCount++;
                    if (!uncoveredByRow.has(row))
                        uncoveredByRow.set(row, []);
                    uncoveredByRow.get(row).push(col);
                }
            }
        }
        if (uncoveredCount === 0)
            return;
        const rects = [];
        const maxRectsPerBatch = this.coverageRetries < 4 ? 16 : 4;
        if (this.coverageRetries % 2 === 0) {
            for (const [row, cols] of uncoveredByRow) {
                cols.sort((a, b) => a - b);
                let start = cols[0], prev = cols[0];
                for (let i = 1; i <= cols.length; i++) {
                    if (i < cols.length && cols[i] === prev + 1) {
                        prev = cols[i];
                    }
                    else {
                        const x = start * bs;
                        const y = row * bs;
                        const w = Math.min((prev + 1) * bs, this.fbWidth) - x;
                        const h = Math.min(bs, this.fbHeight) - (y - row * bs);
                        rects.push([x, y, w, h]);
                        if (i < cols.length) {
                            start = cols[i];
                            prev = cols[i];
                        }
                    }
                }
            }
        }
        else {
            for (const [row, cols] of uncoveredByRow) {
                for (const col of cols) {
                    const x = col * bs;
                    const y = row * bs;
                    const w = Math.min(bs, this.fbWidth - x);
                    const h = Math.min(bs, this.fbHeight - y);
                    rects.push([x, y, w, h]);
                }
            }
        }
        if (rects.length === 0)
            return;
        this.coverageRequestPending = true;
        this.coverageRetries++;
        setTimeout(() => {
            this.coverageRequestPending = false;
            if (this.state !== types_1.ConnectionState.Connected)
                return;
            const batch = rects.slice(0, maxRectsPerBatch);
            for (const [rx, ry, rw, rh] of batch) {
                this.requestFramebufferUpdate(false, rx, ry, rw, rh);
            }
            if (rects.length > maxRectsPerBatch) {
                setTimeout(() => this.checkCoverageAndRequest(), 100);
            }
        }, 50);
    }
    /**
     * 读取伪编码矩形的附加数据
     */
    readPseudoEncodingPayload(encoding, width, height, dataOffset) {
        switch (encoding) {
            case types_1.EncodingType.LastRect:
            case types_1.EncodingType.NewFBSize:
            case types_1.EncodingType.PointerPos:
                return Buffer.alloc(0);
            case types_1.EncodingType.DesktopName: {
                if (this.buffer.length < dataOffset + 4)
                    return null;
                const nameLen = this.buffer.readUInt32BE(dataOffset);
                if (this.buffer.length < dataOffset + 4 + nameLen)
                    return null;
                return Buffer.from(this.buffer.subarray(dataOffset + 4, dataOffset + 4 + nameLen));
            }
            case types_1.EncodingType.Cursor:
            case types_1.EncodingType.RichCursor: {
                const bytesPerPixel = Math.max(1, Math.ceil(this.pixelFormat.bitsPerPixel / 8));
                const pixelsLen = width * height * bytesPerPixel;
                const maskLen = Math.ceil(width / 8) * height;
                const total = pixelsLen + maskLen;
                if (this.buffer.length < dataOffset + total)
                    return null;
                return Buffer.from(this.buffer.subarray(dataOffset, dataOffset + total));
            }
            default:
                return Buffer.alloc(0);
        }
    }
    /**
     * 应用伪编码的副作用
     */
    applyPseudoEncoding(encoding, x, y, width, height, payload) {
        switch (encoding) {
            case types_1.EncodingType.LastRect:
                break;
            case types_1.EncodingType.NewFBSize:
                this.fbWidth = width;
                this.fbHeight = height;
                this.initCoverage(width, height);
                this.emit('desktop-size', { width, height });
                break;
            case types_1.EncodingType.DesktopName:
                this.desktopName = payload.toString('utf8');
                this.emit('desktop-name', this.desktopName);
                break;
            case types_1.EncodingType.Cursor:
            case types_1.EncodingType.RichCursor:
                this.emit('cursor', { width, height });
                break;
            default:
                break;
        }
    }
    /**
     * 处理 SetColorMapEntries 消息
     */
    processSetColorMapEntries() {
        if (this.buffer.length < 6)
            return false;
        const numColors = this.buffer.readUInt16BE(4);
        const totalSize = 6 + numColors * 6;
        if (this.buffer.length < totalSize)
            return false;
        this.buffer = this.buffer.subarray(totalSize);
        return true;
    }
    /**
     * 处理服务器剪贴板文本 (Extended Clipboard)
     * 标准格式: 1-byte msg-type(3), 3-byte padding, 4-byte flags, 4-byte length, text
     * 旧格式:   1-byte msg-type(3), 3-byte padding, 4-byte length, text
     */
    processServerCutText() {
        if (this.buffer.length < 8)
            return false;
        // 尝试 Extended Clipboard 格式 (带 flags 字段)
        // 如果前 4 字节 padding 后紧跟的 4 字节 flags 最高位为 1，则为扩展格式
        const flagsOrLen = this.buffer.readUInt32BE(4);
        if (flagsOrLen & 0x80000000) {
            // Extended 格式: flags(4) + length(4) + data
            if (this.buffer.length < 12)
                return false;
            const flags = flagsOrLen & 0x7FFFFFFF;
            const len = this.buffer.readUInt32BE(8);
            if (len > 0x1000000)
                return false; // 256MB sanity limit
            if (this.buffer.length < 12 + len)
                return false;
            this.clipboardCapabilities = flags;
            const text = this.buffer.subarray(12, 12 + len).toString('utf8');
            this.buffer = this.buffer.subarray(12 + len);
            this.emit('clipboard', text);
        }
        else {
            // 标准格式: length(4) + data
            const len = flagsOrLen;
            if (len > 0x1000000)
                return false;
            if (this.buffer.length < 8 + len)
                return false;
            const text = this.buffer.subarray(8, 8 + len).toString('utf8');
            this.buffer = this.buffer.subarray(8 + len);
            this.emit('clipboard', text);
        }
        return true;
    }
    /**
     * 处理桌面大小变化 (Extended Desktop Size 响应)
     * 格式: 1-byte msg-type(251), 1-byte padding, 2-byte width, 2-byte height,
     *        1-byte number-of-screens(0xFF=unspecified), [screens...]
     */
    processDesktopSize() {
        if (this.buffer.length < 6)
            return false;
        const width = this.buffer.readUInt16BE(2);
        const height = this.buffer.readUInt16BE(4);
        // 更新帧缓冲大小
        this.fbWidth = width;
        this.fbHeight = height;
        this.initCoverage(width, height);
        // 跳过消息头
        let consumed = 6;
        // 如果有屏幕布局信息，跳过
        if (this.buffer.length >= consumed + 1) {
            const numScreens = this.buffer[consumed];
            consumed += 1;
            // 每个屏幕 16 + 4 = 20 字节 (id + x + y + w + h + flags + name)
            // 简化处理：跳过剩余所有数据
            if (numScreens !== 0xFF && this.buffer.length >= consumed + numScreens * 20) {
                consumed += numScreens * 20;
            }
        }
        this.buffer = this.buffer.subarray(consumed);
        this.emit('desktop-size', { width, height });
        return true;
    }
    /**
     * 处理 Client Redirect 消息 (服务器重定向)
     * 格式: 1-byte msg-type(252), 1-byte reserved,
     *        4-byte redirect-host-length, host-string,
     *        4-byte redirect-port
     *
     * 某些 VNC 服务器（如负载均衡器）会发送此消息让客户端连接到另一台服务器
     */
    processClientRedirect() {
        if (this.buffer.length < 10)
            return false;
        const hostLen = this.buffer.readUInt32BE(2);
        if (hostLen > MAX_REASON_LENGTH)
            return false;
        if (this.buffer.length < 10 + hostLen)
            return false;
        const host = this.buffer.subarray(6, 6 + hostLen).toString('utf8');
        const port = this.buffer.readUInt32BE(6 + hostLen);
        this.buffer = this.buffer.subarray(10 + hostLen);
        console.log(`[RFB] 服务器重定向到 ${host}:${port}`);
        this.emit('redirect', { host, port });
        return true;
    }
    /**
     * 启动空闲超时检测
     */
    startIdleTimer() {
        this.cancelIdleTimer();
        this.idleTimer = setTimeout(() => {
            if (this.state === types_1.ConnectionState.Connected) {
                this.emitError('空闲超时：服务器长时间无响应');
                this.disconnect();
            }
        }, IDLE_TIMEOUT);
    }
}
exports.RfbClient = RfbClient;
RfbClient.COVERAGE_BLOCK_SIZE = 32;
RfbClient.COVERAGE_MAX_RETRIES = 8;
RfbClient.MAX_CONSECUTIVE_DECODE_ERRORS = 10;
//# sourceMappingURL=client.js.map