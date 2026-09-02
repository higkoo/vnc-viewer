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
    private serverVersion;
    private fbWidth;
    private fbHeight;
    private pixelFormat;
    private desktopName;
    private preferredEncodings;
    private currentEncoding;
    private buffer;
    updateState(state: ConnectionState): void;
    getParams(): ConnectionParams;
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
     */
    private processData;
    /**
     * 处理服务器消息 (连接建立后)
     */
    private processServerMessage;
    /**
     * 处理 FramebufferUpdate 消息
     */
    private processFramebufferUpdate;
    /**
     * 处理伪编码
     */
    private handlePseudoEncoding;
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