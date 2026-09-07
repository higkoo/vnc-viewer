"use strict";
/**
 * RFB 协议客户端 - 核心实现
 * 参考 UltraVNC ClientConnection 和 RFB 协议规范 (RFC 6143)
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
    /**
     * 连接到 VNC 服务器
     */
    connect(params) {
        if (this.state !== types_1.ConnectionState.Disconnected) {
            this.disconnect();
        }
        this.params = params;
        this.setState(types_1.ConnectionState.Connecting);
        // 新连接重置持久化压缩流状态（ZRLE 可能跨矩形复用同一个 zlib 流）
        this.encoders.resetStreams();
        this.preferredEncodings = [
            types_1.EncodingType.CopyRect,
            types_1.EncodingType.ZRLE,
            types_1.EncodingType.Hextile,
            types_1.EncodingType.RRE,
            types_1.EncodingType.Raw,
            types_1.EncodingType.Cursor,
            types_1.EncodingType.RichCursor,
            types_1.EncodingType.PointerPos,
            types_1.EncodingType.LastRect,
            types_1.EncodingType.NewFBSize,
            types_1.EncodingType.DesktopName,
        ];
        this.socket = new net.Socket();
        this.socket.setNoDelay(true);
        this.socket.setKeepAlive(true);
        this.socket.on('connect', () => {
            this.buffer = Buffer.alloc(0);
            this.setState(types_1.ConnectionState.ProtocolVersion);
            // processData 会在 socket.on('data') 中自动调用
        });
        this.socket.on('data', (data) => {
            this.buffer = Buffer.concat([this.buffer, data]);
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
        if (this.socket) {
            try {
                this.socket.destroy();
            }
            catch (_) { /* ignore */ }
            this.socket = null;
        }
        this.setState(types_1.ConnectionState.Disconnected);
        this.buffer = Buffer.alloc(0);
    }
    /**
     * 发送帧缓冲更新请求
     */
    requestFramebufferUpdate(incremental, x = 0, y = 0, width = 0, height = 0) {
        if (!this.socket || this.state !== types_1.ConnectionState.Connected)
            return;
        // 使用实际帧缓冲大小
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
            // 伪编码（如 0xFFFFFF11）超过 int32 上限，必须用无符号写入
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
        msg[1] = 0; // padding
        msg[2] = 0; // padding
        msg[3] = 0; // padding
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
        msg.writeUInt8(0, 17); // padding
        msg.writeUInt16BE(0, 18); // padding
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
     * 发送剪贴板文本
     */
    sendCutText(text) {
        if (!this.socket)
            return;
        const utf8 = Buffer.from(text, 'utf8');
        const msg = Buffer.alloc(8 + utf8.length);
        msg[0] = types_1.ClientMsgType.ClientCutText; // 6
        msg[1] = 0;
        msg[2] = 0;
        msg[3] = 0; // padding
        msg.writeUInt32BE(utf8.length, 4);
        utf8.copy(msg, 8);
        this.send(msg);
    }
    /**
     * 请求调整桌面大小 (扩展)
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
        layout.writeUInt16BE(0, 4); // x
        layout.writeUInt16BE(0, 6); // y
        layout.writeUInt16BE(width, 8);
        layout.writeUInt16BE(height, 10);
        layout.writeUInt32BE(0, 12); // flags
        this.send(layout);
    }
    // ---- 内部方法 ----
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
    }
    setConnected() {
        this.setState(types_1.ConnectionState.Connected);
        this.emit('server-info', {
            width: this.fbWidth,
            height: this.fbHeight,
            pixelFormat: this.pixelFormat,
            name: this.desktopName,
            version: this.serverVersion,
        });
        // 请求首次全量更新
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
     * 循环处理，直到缓冲区数据不足或状态不再变化
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
            // 如果缓冲区没有变化，说明数据不足，等待下一次 data 事件
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
                default:
                    // 未知消息类型，跳过
                    this.buffer = this.buffer.subarray(1);
                    break;
            }
        }
    }
    /**
     * 处理 FramebufferUpdate 消息
     */
    processFramebufferUpdate() {
        // 消息结构: 1-byte msg-type(0), 1-byte padding, 2-byte number-of-rectangles
        if (this.buffer.length < 4)
            return false;
        const numRects = this.buffer.readUInt16BE(2);
        // numRects 为 0xFFFF 表示"持续更新"模式：一直读取矩形，直到 LastRect 伪编码
        const continuous = numRects === 0xFFFF;
        let offset = 4;
        let safeOffset = 4; // 已完整处理的数据末尾，用于增量推进缓冲区
        let handled = 0;
        let lastRect = false;
        /**
         * 推进已处理数据，等待后续分片。
         * 注意：一条消息可能跨多个 TCP 分片，推进时必须保留 4 字节消息头，
         * 否则后续分片会被当成新消息解析导致错位。
         */
        const flush = () => {
            if (safeOffset > 4) {
                const header = Buffer.from(this.buffer.subarray(0, 4));
                this.buffer = Buffer.concat([header, this.buffer.subarray(safeOffset)]);
            }
            safeOffset = 4;
            offset = 4;
            if (continuous && handled > 0)
                this.emit('framebuffer-done');
            return false;
        };
        while (continuous ? !lastRect : handled < numRects) {
            // 每个矩形: 2-byte x, 2-byte y, 2-byte width, 2-byte height, 4-byte encoding
            if (this.buffer.length < offset + 12)
                return flush();
            const x = this.buffer.readUInt16BE(offset);
            const y = this.buffer.readUInt16BE(offset + 2);
            const width = this.buffer.readUInt16BE(offset + 4);
            const height = this.buffer.readUInt16BE(offset + 6);
            // 必须按无符号读取：伪编码（如 0xFFFFFF11）用 readInt32BE 会得到负数
            const encoding = this.buffer.readUInt32BE(offset + 8);
            offset += 12;
            if (encoding >= 0xFFFFFF00) {
                const consumed = this.pseudoEncodingDataLength(encoding, width, height, offset);
                if (consumed < 0)
                    return flush(); // 数据不足
                if (encoding === types_1.EncodingType.LastRect)
                    lastRect = true;
                offset += consumed;
            }
            else if (encoding === types_1.EncodingType.ZRLE) {
                // ZRLE: 服务器可能跨矩形复用 zlib 流，喂入压缩数据后由解码器择机回调
                if (this.buffer.length < offset + 4)
                    return flush();
                const compressedLen = this.buffer.readUInt32BE(offset);
                if (this.buffer.length < offset + 4 + compressedLen)
                    return flush(); // 数据不足
                this.encoders.feedZrle(Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + compressedLen)), x, y, width, height, this.pixelFormat, (rect) => this.emit('framebuffer-update', rect));
                offset += 4 + compressedLen;
            }
            else {
                const result = this.encoders.decode(this.buffer, offset, encoding, width, height, this.pixelFormat);
                if (result === null)
                    return flush(); // 数据不足
                offset += result.consumed;
                this.currentEncoding = encoding;
                this.emit('framebuffer-update', {
                    x, y, width, height, encoding, data: result.pixels,
                });
            }
            handled++;
            safeOffset = offset;
        }
        if (safeOffset > 0)
            this.buffer = this.buffer.subarray(safeOffset);
        this.emit('framebuffer-done');
        return true;
    }
    /**
     * 计算伪编码矩形携带的数据长度（从 dataOffset 起）
     * @returns 数据字节数；-1 表示数据尚未收全
     */
    pseudoEncodingDataLength(encoding, width, height, dataOffset) {
        switch (encoding) {
            case types_1.EncodingType.LastRect:
                return 0;
            case types_1.EncodingType.NewFBSize:
                this.fbWidth = width;
                this.fbHeight = height;
                this.emit('desktop-size', { width, height });
                return 0;
            case types_1.EncodingType.PointerPos:
                // 指针位置伪编码，无附加数据
                return 0;
            case types_1.EncodingType.DesktopName: {
                if (this.buffer.length < dataOffset + 4)
                    return -1;
                const nameLen = this.buffer.readUInt32BE(dataOffset);
                if (this.buffer.length < dataOffset + 4 + nameLen)
                    return -1;
                this.desktopName = this.buffer.toString('utf8', dataOffset + 4, dataOffset + 4 + nameLen);
                this.emit('desktop-name', this.desktopName);
                return 4 + nameLen;
            }
            case types_1.EncodingType.Cursor:
            case types_1.EncodingType.RichCursor: {
                const bytesPerPixel = Math.max(1, Math.ceil(this.pixelFormat.bitsPerPixel / 8));
                // 光标像素 + 位掩码（每行按字节对齐）
                const pixelsLen = width * height * bytesPerPixel;
                const maskLen = Math.ceil(width / 8) * height;
                const total = pixelsLen + maskLen;
                if (this.buffer.length < dataOffset + total)
                    return -1;
                this.emit('cursor', { width, height });
                return total;
            }
            default:
                // 未知伪编码，无附加数据
                return 0;
        }
    }
    /**
     * 处理 SetColorMapEntries 消息
     */
    processSetColorMapEntries() {
        // 1-byte msg-type(1), 1-byte padding, 2-byte first-color, 2-byte num-colors, colors...
        if (this.buffer.length < 6)
            return false;
        const numColors = this.buffer.readUInt16BE(4);
        const totalSize = 6 + numColors * 6; // 每个颜色: 2-byte R, 2-byte G, 2-byte B
        if (this.buffer.length < totalSize)
            return false;
        this.buffer = this.buffer.subarray(totalSize);
        return true;
    }
    /**
     * 处理服务器剪贴板文本
     */
    processServerCutText() {
        // 1-byte msg-type(3), 3-byte padding, 4-byte length, text
        if (this.buffer.length < 8)
            return false;
        const len = this.buffer.readUInt32BE(4);
        if (this.buffer.length < 8 + len)
            return false;
        const text = this.buffer.subarray(8, 8 + len).toString('utf8');
        this.buffer = this.buffer.subarray(8 + len);
        this.emit('clipboard', text);
        return true;
    }
    /**
     * 处理桌面大小变化
     */
    processDesktopSize() {
        // 1-byte msg-type, 1-byte padding, 2-byte width, 2-byte height
        if (this.buffer.length < 6)
            return false;
        const width = this.buffer.readUInt16BE(2);
        const height = this.buffer.readUInt16BE(4);
        this.fbWidth = width;
        this.fbHeight = height;
        this.buffer = this.buffer.subarray(6);
        this.emit('desktop-size', { width, height });
        return true;
    }
}
exports.RfbClient = RfbClient;
//# sourceMappingURL=client.js.map