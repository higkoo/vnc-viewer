/**
 * RFB 协议客户端 - 核心实现
 * 参考 UltraVNC ClientConnection 和 RFB 协议规范 (RFC 6143)
 */

import * as net from 'net';
import { EventEmitter } from 'events';
import {
  RfbVersion, SecurityType, EncodingType, ClientMsgType, ServerMsgType,
  PixelFormat, FramebufferRect, ServerInitInfo, ConnectionParams, ConnectionState,
} from './types';
import { RfbHandshake } from './handshake';
import { EncodingDecoders } from './encodings';
import { RfbInput } from './input';

export class RfbClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private state: ConnectionState = ConnectionState.Disconnected;
  private params: ConnectionParams = { host: '', port: 5900, shared: false };
  private handshake: RfbHandshake;
  private encoders: EncodingDecoders;
  private input: RfbInput;

  // 服务器信息
  private serverVersion: RfbVersion = '003.008';
  private fbWidth: number = 0;
  private fbHeight: number = 0;
  private pixelFormat: PixelFormat = {
    bitsPerPixel: 32, depth: 24, bigEndian: false, trueColor: true,
    redMax: 255, greenMax: 255, blueMax: 255,
    redShift: 16, greenShift: 8, blueShift: 0,
  };
  private desktopName: string = '';
  private preferredEncodings: EncodingType[] = [];
  private currentEncoding: number = 0;

  // 接收缓冲区
  private buffer: Buffer = Buffer.alloc(0);

  // 公开方法用于 handshake 模块
  updateState(state: ConnectionState): void { this.setState(state); }
  getParams(): ConnectionParams { return this.params; }
  /** 从 buffer 中读取 n 字节，并移除已读部分 */
  readBuffer(n: number): Buffer | null {
    if (this.buffer.length < n) return null;
    const data = this.buffer.slice(0, n);
    this.buffer = this.buffer.slice(n);
    return data;
  }
  /** 获取 buffer 当前长度 */
  bufferLength(): number { return this.buffer.length; }

  constructor() {
    super();
    this.handshake = new RfbHandshake(this);
    this.encoders = new EncodingDecoders();
    this.input = new RfbInput(this);
  }

  getState(): ConnectionState { return this.state; }
  getFbWidth(): number { return this.fbWidth; }
  getFbHeight(): number { return this.fbHeight; }
  getDesktopName(): string { return this.desktopName; }
  getServerVersion(): RfbVersion { return this.serverVersion; }
  getPixelFormat(): PixelFormat { return { ...this.pixelFormat }; }

  /**
   * 连接到 VNC 服务器
   */
  connect(params: ConnectionParams): void {
    if (this.state !== ConnectionState.Disconnected) {
      this.disconnect();
    }

    this.params = params;
    this.setState(ConnectionState.Connecting);
    this.preferredEncodings = [
      EncodingType.CopyRect,
      EncodingType.ZRLE,
      EncodingType.Hextile,
      EncodingType.RRE,
      EncodingType.Raw,
      EncodingType.Cursor,
      EncodingType.RichCursor,
      EncodingType.PointerPos,
      EncodingType.LastRect,
      EncodingType.NewFBSize,
      EncodingType.DesktopName,
    ];

    this.socket = new net.Socket();
    this.socket.setNoDelay(true);
    this.socket.setKeepAlive(true);

    this.socket.on('connect', () => {
      this.buffer = Buffer.alloc(0);
      this.setState(ConnectionState.ProtocolVersion);
      // processData 会在 socket.on('data') 中自动调用
    });

    this.socket.on('data', (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.processData();
    });

    this.socket.on('error', (err: Error) => {
      this.emitError(`连接错误: ${err.message}`);
      this.disconnect();
    });

    this.socket.on('close', () => {
      if (this.state !== ConnectionState.Disconnected) {
        this.emitError('连接已关闭');
        this.setState(ConnectionState.Disconnected);
      }
    });

    this.socket.connect(params.port, params.host);
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch (_) { /* ignore */ }
      this.socket = null;
    }
    this.setState(ConnectionState.Disconnected);
    this.buffer = Buffer.alloc(0);
  }

  /**
   * 发送帧缓冲更新请求
   */
  requestFramebufferUpdate(incremental: boolean, x: number = 0, y: number = 0,
    width: number = 0, height: number = 0): void {
    if (!this.socket || this.state !== ConnectionState.Connected) return;

    // 使用实际帧缓冲大小
    if (width === 0) width = this.fbWidth;
    if (height === 0) height = this.fbHeight;

    const msg = Buffer.alloc(10);
    msg[0] = ClientMsgType.FramebufferUpdateRequest; // 3
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
  setEncodings(encodings: EncodingType[]): void {
    if (!this.socket) return;

    this.preferredEncodings = encodings;
    const msg = Buffer.alloc(4 + encodings.length * 4);
    msg[0] = ClientMsgType.SetEncodings; // 2
    msg[1] = 0; // padding
    msg.writeUInt16BE(encodings.length, 2);

    for (let i = 0; i < encodings.length; i++) {
      msg.writeInt32BE(encodings[i], 4 + i * 4);
    }
    this.send(msg);
  }

  /**
   * 设置像素格式
   */
  setPixelFormat(format: PixelFormat): void {
    if (!this.socket) return;

    this.pixelFormat = { ...format };
    const msg = Buffer.alloc(20);
    msg[0] = ClientMsgType.SetPixelFormat; // 0
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
  keyEvent(key: number, down: boolean): void {
    this.input.sendKeyEvent(key, down);
  }

  /**
   * 发送指针事件
   */
  pointerEvent(buttonMask: number, x: number, y: number): void {
    this.input.sendPointerEvent(buttonMask, x, y);
  }

  /**
   * 发送剪贴板文本
   */
  sendCutText(text: string): void {
    if (!this.socket) return;
    const utf8 = Buffer.from(text, 'utf8');
    const msg = Buffer.alloc(8 + utf8.length);
    msg[0] = ClientMsgType.ClientCutText; // 6
    msg[1] = 0; msg[2] = 0; msg[3] = 0; // padding
    msg.writeUInt32BE(utf8.length, 4);
    utf8.copy(msg, 8);
    this.send(msg);
  }

  /**
   * 请求调整桌面大小 (扩展)
   */
  requestDesktopSize(width: number, height: number): void {
    if (!this.socket) return;
    const msg = Buffer.alloc(4);
    msg[0] = ClientMsgType.SetDesktopSize; // 251
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

  private setState(state: ConnectionState): void {
    this.state = state;
    this.emit('state', state);
  }

  getSocket(): net.Socket | null { return this.socket; }

  setServerVersion(v: RfbVersion): void { this.serverVersion = v; }
  setFramebufferInfo(width: number, height: number, format: PixelFormat, name: string): void {
    this.fbWidth = width;
    this.fbHeight = height;
    this.pixelFormat = format;
    this.desktopName = name;
  }

  setConnected(): void {
    this.setState(ConnectionState.Connected);
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

  emitError(msg: string): void {
    this.emit('error', msg);
    if (this.state !== ConnectionState.Disconnected) {
      this.setState(ConnectionState.Error);
    }
  }

  send(data: Buffer): void {
    if (this.socket && this.socket.writable) {
      this.socket.write(data);
    }
  }

  /**
   * 处理接收到的数据
   * 循环处理，直到缓冲区数据不足或状态不再变化
   */
  private processData(): void {
    while (this.buffer.length > 0) {
      const prevLen = this.buffer.length;
      switch (this.state) {
        case ConnectionState.ProtocolVersion:
          this.handshake.processProtocolVersion();
          break;
        case ConnectionState.Security:
          this.handshake.processSecurity();
          break;
        case ConnectionState.Authentication:
          this.handshake.processAuthentication();
          break;
        case ConnectionState.ServerInit:
          this.handshake.processServerInit();
          break;
        case ConnectionState.Connected:
          this.processServerMessage();
          break;
        default:
          return;
      }
      // 如果缓冲区没有变化，说明数据不足，等待下一次 data 事件
      if (this.buffer.length === prevLen) break;
    }
  }

  /**
   * 处理服务器消息 (连接建立后)
   */
  private processServerMessage(): void {
    while (this.buffer.length >= 1) {
      const msgType = this.buffer[0] as ServerMsgType;

      switch (msgType) {
        case ServerMsgType.FramebufferUpdate:
          if (!this.processFramebufferUpdate()) return;
          break;
        case ServerMsgType.SetColorMapEntries:
          if (!this.processSetColorMapEntries()) return;
          break;
        case ServerMsgType.Bell:
          this.buffer = this.buffer.subarray(1);
          this.emit('bell');
          break;
        case ServerMsgType.ServerCutText:
          if (!this.processServerCutText()) return;
          break;
        case ServerMsgType.DesktopSize:
          if (!this.processDesktopSize()) return;
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
  private processFramebufferUpdate(): boolean {
    // 消息结构: 1-byte msg-type(0), 1-byte padding, 2-byte number-of-rectangles
    if (this.buffer.length < 4) return false;

    const numRects = this.buffer.readUInt16BE(2);
    let offset = 4;

    for (let i = 0; i < numRects; i++) {
      // 每个矩形: 2-byte x, 2-byte y, 2-byte width, 2-byte height, 4-byte encoding
      if (this.buffer.length < offset + 12) return false;

      const x = this.buffer.readUInt16BE(offset);
      const y = this.buffer.readUInt16BE(offset + 2);
      const width = this.buffer.readUInt16BE(offset + 4);
      const height = this.buffer.readUInt16BE(offset + 6);
      const encoding = this.buffer.readInt32BE(offset + 8);

      offset += 12;

      // 处理伪编码
      const isPseudoEncoding = encoding >= 0xFFFFFF00;

      if (isPseudoEncoding) {
        const handled = this.handlePseudoEncoding(encoding, width, height);
        if (!handled) return false;
        continue;
      }

      // 解码矩形数据
      const result = this.encoders.decode(
        this.buffer, offset, encoding, width, height, this.pixelFormat
      );

      if (result === null) return false; // 数据不足

      offset += result.consumed;
      this.currentEncoding = encoding;

      this.emit('framebuffer-update', {
        x, y, width, height, encoding, data: result.pixels,
      } as FramebufferRect);
    }

    this.buffer = this.buffer.subarray(offset);
    this.emit('framebuffer-done');
    return true;
  }

  /**
   * 处理伪编码
   */
  private handlePseudoEncoding(encoding: number, width: number, height: number): boolean {
    switch (encoding) {
      case EncodingType.LastRect:
        // 无数据，仅标记
        return true;

      case EncodingType.NewFBSize:
        this.fbWidth = width;
        this.fbHeight = height;
        this.emit('desktop-size', { width, height });
        return true;

      case EncodingType.DesktopName:
        if (this.buffer.length < 4) return false;
        // 实际上这里需要处理不同实现
        return true;

      case EncodingType.Cursor:
      case EncodingType.RichCursor:
        // 光标数据 - 需要解析光标像素和掩码
        // 简单实现: 跳过光标数据
        const cursorDataLen = width * height * (this.pixelFormat.bitsPerPixel / 8);
        // 光标掩码 (按行对齐到4字节)
        const maskLen = Math.ceil(width / 8) * height;
        const totalLen = cursorDataLen + maskLen;
        if (this.buffer.length < totalLen) return false;
        this.buffer = this.buffer.subarray(totalLen);
        this.emit('cursor', { width, height });
        return true;

      default:
        return true;
    }
  }

  /**
   * 处理 SetColorMapEntries 消息
   */
  private processSetColorMapEntries(): boolean {
    // 1-byte msg-type(1), 1-byte padding, 2-byte first-color, 2-byte num-colors, colors...
    if (this.buffer.length < 6) return false;
    const numColors = this.buffer.readUInt16BE(4);
    const totalSize = 6 + numColors * 6; // 每个颜色: 2-byte R, 2-byte G, 2-byte B
    if (this.buffer.length < totalSize) return false;
    this.buffer = this.buffer.subarray(totalSize);
    return true;
  }

  /**
   * 处理服务器剪贴板文本
   */
  private processServerCutText(): boolean {
    // 1-byte msg-type(3), 3-byte padding, 4-byte length, text
    if (this.buffer.length < 8) return false;
    const len = this.buffer.readUInt32BE(4);
    if (this.buffer.length < 8 + len) return false;
    const text = this.buffer.subarray(8, 8 + len).toString('utf8');
    this.buffer = this.buffer.subarray(8 + len);
    this.emit('clipboard', text);
    return true;
  }

  /**
   * 处理桌面大小变化
   */
  private processDesktopSize(): boolean {
    // 1-byte msg-type, 1-byte padding, 2-byte width, 2-byte height
    if (this.buffer.length < 6) return false;
    const width = this.buffer.readUInt16BE(2);
    const height = this.buffer.readUInt16BE(4);
    this.fbWidth = width;
    this.fbHeight = height;
    this.buffer = this.buffer.subarray(6);
    this.emit('desktop-size', { width, height });
    return true;
  }
}