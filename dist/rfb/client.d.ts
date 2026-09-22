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
import * as net from 'net';
import { EventEmitter } from 'events';
import { RfbVersion, EncodingType, PixelFormat, ConnectionParams, ConnectionState } from './types';
export declare class RfbClient extends EventEmitter {
    private socket;
    private state;
    private params;
    private handshake;
    private encoders;
    private input;
    private connectTimer;
    private handshakeTimer;
    private idleTimer;
    private serverVersion;
    private fbWidth;
    private fbHeight;
    private pixelFormat;
    private desktopName;
    private preferredEncodings;
    private currentEncoding;
    private buffer;
    private coverageCols;
    private coverageRows;
    private coverageBits;
    private coverageRequestPending;
    private coverageRetries;
    private static readonly COVERAGE_BLOCK_SIZE;
    private static readonly COVERAGE_MAX_RETRIES;
    private bytesReceived;
    private bytesReceivedWindow;
    private bandwidthTimer;
    private lastBandwidth;
    /** Extended Clipboard 能力标志（从服务器 SetCutText 消息中解析） */
    private clipboardCapabilities;
    updateState(state: ConnectionState): void;
    getParams(): ConnectionParams;
    /** 从 buffer 中读取 n 字节，并移除已读部分 */
    readBuffer(n: number): Buffer | null;
    /** 获取 buffer 当前长度 */
    bufferLength(): number;
    constructor();
    getState(): ConnectionState;
    getFbWidth(): number;
    getFbHeight(): number;
    getDesktopName(): string;
    getServerVersion(): RfbVersion;
    getPixelFormat(): PixelFormat;
    /** 获取当前带宽（bytes/sec） */
    getBandwidth(): number;
    /**
     * 连接到 VNC 服务器
     */
    connect(params: ConnectionParams): void;
    /**
     * 断开连接
     */
    disconnect(): void;
    /**
     * 发送帧缓冲更新请求
     */
    requestFramebufferUpdate(incremental: boolean, x?: number, y?: number, width?: number, height?: number): void;
    /**
     * 设置编码类型
     */
    setEncodings(encodings: EncodingType[]): void;
    /**
     * 设置像素格式
     */
    setPixelFormat(format: PixelFormat): void;
    /**
     * 发送键盘事件
     */
    keyEvent(key: number, down: boolean): void;
    /**
     * 发送指针事件
     */
    pointerEvent(buttonMask: number, x: number, y: number): void;
    /**
     * 发送剪贴板文本 (Extended Clipboard 协议)
     * 支持 1024 字节以上的大文本，通过 GII 扩展分片
     */
    sendCutText(text: string): void;
    /**
     * 请求调整桌面大小 (Extended Desktop Size)
     * 参考 RFC 6143 Section 7.5.5
     */
    requestDesktopSize(width: number, height: number): void;
    private startConnectTimer;
    private cancelConnectTimer;
    private startHandshakeTimer;
    private cancelHandshakeTimer;
    private resetIdleTimer;
    private cancelIdleTimer;
    private startBandwidthMonitor;
    private stopBandwidthMonitor;
    private resetState;
    private setState;
    getSocket(): net.Socket | null;
    setServerVersion(v: RfbVersion): void;
    setFramebufferInfo(width: number, height: number, format: PixelFormat, name: string): void;
    setConnected(): void;
    emitError(msg: string): void;
    send(data: Buffer): void;
    /**
     * 处理接收到的数据
     */
    private processData;
    /**
     * 处理服务器消息 (连接建立后)
     */
    private processServerMessage;
    /** 连续解码失败计数，用于判断是否需要断线重连 */
    private consecutiveDecodeErrors;
    private static readonly MAX_CONSECUTIVE_DECODE_ERRORS;
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
    private processFramebufferUpdate;
    /** 帧解析主体 */
    private processFramebufferUpdateInner;
    private initCoverage;
    private markCoverage;
    private checkCoverageAndRequest;
    /**
     * 读取伪编码矩形的附加数据
     */
    private readPseudoEncodingPayload;
    /**
     * 应用伪编码的副作用
     */
    private applyPseudoEncoding;
    /**
     * 处理 SetColorMapEntries 消息
     */
    private processSetColorMapEntries;
    /**
     * 处理服务器剪贴板文本 (Extended Clipboard)
     * 标准格式: 1-byte msg-type(3), 3-byte padding, 4-byte flags, 4-byte length, text
     * 旧格式:   1-byte msg-type(3), 3-byte padding, 4-byte length, text
     */
    private processServerCutText;
    /**
     * 处理桌面大小变化 (Extended Desktop Size 响应)
     * 格式: 1-byte msg-type(251), 1-byte padding, 2-byte width, 2-byte height,
     *        1-byte number-of-screens(0xFF=unspecified), [screens...]
     */
    private processDesktopSize;
    /**
     * 处理 Client Redirect 消息 (服务器重定向)
     * 格式: 1-byte msg-type(252), 1-byte reserved,
     *        4-byte redirect-host-length, host-string,
     *        4-byte redirect-port
     *
     * 某些 VNC 服务器（如负载均衡器）会发送此消息让客户端连接到另一台服务器
     */
    private processClientRedirect;
    /**
     * 启动空闲超时检测
     */
    private startIdleTimer;
}
//# sourceMappingURL=client.d.ts.map