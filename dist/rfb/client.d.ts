/**
 * RFB 协议客户端 - 核心实现
 * 参考 UltraVNC ClientConnection 和 RFB 协议规范 (RFC 6143)
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
    /** 连接/握手超时（毫秒），防止目标不可达或无响应时界面永久卡在“连接中” */
    private static readonly CONNECT_TIMEOUT;
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
     * 发送剪贴板文本
     */
    sendCutText(text: string): void;
    /**
     * 请求调整桌面大小 (扩展)
     */
    requestDesktopSize(width: number, height: number): void;
    private setState;
    getSocket(): net.Socket | null;
    setServerVersion(v: RfbVersion): void;
    setFramebufferInfo(width: number, height: number, format: PixelFormat, name: string): void;
    setConnected(): void;
    emitError(msg: string): void;
    send(data: Buffer): void;
    /**
     * 处理接收到的数据
     * 循环处理，直到缓冲区数据不足或状态不再变化
     */
    private processData;
    /**
     * 处理服务器消息 (连接建立后)
     */
    private processServerMessage;
    /**
     * 处理 FramebufferUpdate 消息
     *
     * 采用「先完整解析整帧、再统一处理」的两阶段模型，消除 TCP 分片边界处
     * 的状态错乱：
     *
     * 旧模型按数据到达即时消费矩形，并把已处理前缀从接收缓冲区移除；若某
     * 个矩形恰好被 TCP 分片截断，会保留消息头等剩余分片，但消息头里的
     * numRects 是整帧矩形总数，重解析时矩形数会与剩余数据不匹配，导致漏帧、
     * 花屏甚至永久卡死；已喂入 ZRLE 累积流的压缩数据也可能被重复喂入而
     * 解码错乱。
     *
     * 新模型第一阶段只确认每个矩形（含 ZRLE 压缩块、伪编码附加数据）已
     * 完整到达并暂存，任一矩形不完整就返回 false，不做任何消费或副作用，
     * 等后续分片补齐后重头解析；第二阶段整帧齐备后统一解码/派发，最后
     * 一次性消费整帧字节。代价是帧要收齐才渲染，但 VNC 帧远小于 TCP 窗口，
     * 实际延迟影响可忽略。
     */
    private processFramebufferUpdate;
    /** 帧解析主体（模型说明见 processFramebufferUpdate） */
    private processFramebufferUpdateInner;
    private initCoverage;
    private markCoverage;
    private checkCoverageAndRequest;
    /**
     * 读取伪编码矩形的附加数据（纯读取，不产生副作用）。
     * @returns 附加数据 Buffer；null 表示数据尚未收全
     */
    private readPseudoEncodingPayload;
    /**
     * 应用伪编码的副作用（整帧齐备后调用，保证副作用只发生一次）
     */
    private applyPseudoEncoding;
    /**
     * 处理 SetColorMapEntries 消息
     */
    private processSetColorMapEntries;
    /**
     * 处理服务器剪贴板文本
     */
    private processServerCutText;
    /**
     * 处理桌面大小变化
     */
    private processDesktopSize;
}
//# sourceMappingURL=client.d.ts.map