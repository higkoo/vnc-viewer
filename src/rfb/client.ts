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

  /** 连接/握手超时（毫秒），防止目标不可达或无响应时界面永久卡在“连接中” */
  private static readonly CONNECT_TIMEOUT = 15000;

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

  // 帧覆盖追踪：记录 32x32 块级别的覆盖状态，
  // 连接后首帧请求全屏时服务器可能只返回脏区域（x11vnc 行为），
  // 追踪未覆盖块并在 framebuffer-done 后补发请求
  private coverageCols = 0;
  private coverageRows = 0;
  private coverageBits: Uint8Array = new Uint8Array(0);
  private coverageRequestPending = false;
  private coverageRetries = 0;
  private static readonly COVERAGE_BLOCK_SIZE = 32;
  private static readonly COVERAGE_MAX_RETRIES = 8;

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
    // 新连接重置持久化压缩流状态（ZRLE 可能跨矩形复用同一个 zlib 流）
    this.encoders.resetStreams();
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

    // 连接/握手超时：目标不可达或无响应时主动报错并断开
    this.socket.setTimeout(RfbClient.CONNECT_TIMEOUT);

    this.socket.on('timeout', () => {
      if (this.state !== ConnectionState.Connected && this.state !== ConnectionState.Disconnected) {
        this.emitError('连接超时，服务器无响应');
        this.disconnect();
      }
    });

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
    this.coverageBits = new Uint8Array(0);
    this.coverageRequestPending = false;
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
      // 伪编码（如 0xFFFFFF11）超过 int32 上限，必须用无符号写入
      msg.writeUInt32BE(encodings[i] >>> 0, 4 + i * 4);
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
    // 桌面大小变化时重置覆盖追踪
    this.initCoverage(width, height);
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

    // 初始化覆盖追踪网格
    this.initCoverage(this.fbWidth, this.fbHeight);

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
  private processFramebufferUpdate(): boolean {
    try {
      return this.processFramebufferUpdateInner();
    } catch (err) {
      // 单帧解码异常（如服务器发送了非法/不支持的编码数据）不应拖垮整个连接：
      // 丢弃本帧与累积解压状态，请求一次全量刷新以重新同步画面。
      console.error('[RFB] 解码帧失败，请求全量刷新:', err);
      this.encoders.resetStreams();
      this.buffer = Buffer.alloc(0);
      this.emit('framebuffer-resync');
      return false;
    }
  }

  /** 帧解析主体（模型说明见 processFramebufferUpdate） */
  private processFramebufferUpdateInner(): boolean {
    // 消息结构: 1-byte msg-type(0), 1-byte padding, 2-byte number-of-rectangles
    if (this.buffer.length < 4) return false;

    const numRects = this.buffer.readUInt16BE(2);
    // numRects 为 0xFFFF 表示"持续更新"模式：一直读取矩形，直到 LastRect 伪编码
    const continuous = numRects === 0xFFFF;

    interface PendingRect {
      kind: 'pseudo' | 'zrle' | 'decode';
      x: number; y: number; width: number; height: number;
      encoding: number;
      payload?: Buffer;
      pixels?: Buffer;
    }

    const pending: PendingRect[] = [];
    let cursor = 4;
    let handled = 0;
    let lastRect = false;

    // ---- 第一阶段：扫描并确认整帧数据齐备（无副作用） ----
    while (continuous ? !lastRect : handled < numRects) {
      // 每个矩形: 2-byte x, 2-byte y, 2-byte width, 2-byte height, 4-byte encoding
      if (this.buffer.length < cursor + 12) return false;

      const x = this.buffer.readUInt16BE(cursor);
      const y = this.buffer.readUInt16BE(cursor + 2);
      const width = this.buffer.readUInt16BE(cursor + 4);
      const height = this.buffer.readUInt16BE(cursor + 6);
      // 必须按无符号读取：伪编码（如 0xFFFFFF11）用 readInt32BE 会得到负数
      const encoding = this.buffer.readUInt32BE(cursor + 8);
      cursor += 12;

      if (encoding >= 0xFFFFFF00) {
        // 伪编码：收齐其附加数据
        if (encoding === EncodingType.LastRect) {
          pending.push({ kind: 'pseudo', x, y, width, height, encoding });
          lastRect = true;
          continue;
        }
        const payload = this.readPseudoEncodingPayload(encoding, width, height, cursor);
        if (payload === null) return false; // 数据不足
        pending.push({ kind: 'pseudo', x, y, width, height, encoding, payload });
        cursor += payload.length;
      } else if (encoding === EncodingType.ZRLE) {
        // ZRLE: 压缩块长度由 4 字节前缀给定，可精确预知；累积解压留到第二阶段
        if (this.buffer.length < cursor + 4) return false;
        const compressedLen = this.buffer.readUInt32BE(cursor);
        if (this.buffer.length < cursor + 4 + compressedLen) return false; // 数据不足
        // 标记覆盖范围（x11vnc 首帧可能只发脏区域，跟踪未覆盖块以便补发请求）
        this.markCoverage(x, y, width, height);
        pending.push({
          kind: 'zrle', x, y, width, height, encoding,
          payload: Buffer.from(this.buffer.subarray(cursor + 4, cursor + 4 + compressedLen)),
        });
        cursor += 4 + compressedLen;
      } else {
        // 常规编码：数据长度需解码器确认（如 Hextile 依内容而定），不足则整帧等待
        const result = this.encoders.decode(
          this.buffer, cursor, encoding, width, height, this.pixelFormat
        );
        if (result === null) return false; // 数据不足
        // 标记覆盖范围
        this.markCoverage(x, y, width, height);
        pending.push({ kind: 'decode', x, y, width, height, encoding, pixels: result.pixels });
        cursor += result.consumed;
      }
      handled++;
    }

    // ---- 第二阶段：整帧齐备，按线序统一处理 ----
    for (const p of pending) {
      if (p.kind === 'zrle') {
        // 服务器可能跨矩形复用同一 zlib 流，按线序喂入后由解码器同步回调
        this.encoders.feedZrle(
          p.payload!, p.x, p.y, p.width, p.height, this.pixelFormat,
          (rect) => this.emit('framebuffer-update', rect)
        );
      } else if (p.kind === 'decode') {
        this.currentEncoding = p.encoding;
        this.emit('framebuffer-update', {
          x: p.x, y: p.y, width: p.width, height: p.height,
          encoding: p.encoding, data: p.pixels,
        } as FramebufferRect);
      } else {
        this.applyPseudoEncoding(p.encoding, p.x, p.y, p.width, p.height, p.payload!);
      }
    }

    this.buffer = this.buffer.subarray(cursor);
    this.emit('framebuffer-done');
    // 检查覆盖率，如有未覆盖区域则补发请求（x11vnc 首帧只发脏区域）
    this.checkCoverageAndRequest();
    return true;
  }

  // ---- 帧覆盖追踪 ----
  // x11vnc 等服务器在非增量 FramebufferUpdateRequest 时仍只发送脏区域，
  // 导致首帧后大量像素保持黑色。这里用 32x32 块的位图追踪覆盖，
  // 并在 framebuffer-done 后对未覆盖块补发非增量请求。

  private initCoverage(width: number, height: number): void {
    this.coverageCols = Math.ceil(width / RfbClient.COVERAGE_BLOCK_SIZE);
    this.coverageRows = Math.ceil(height / RfbClient.COVERAGE_BLOCK_SIZE);
    this.coverageBits = new Uint8Array(this.coverageCols * this.coverageRows);
    this.coverageRequestPending = false;
    this.coverageRetries = 0;
  }

  private markCoverage(x: number, y: number, w: number, h: number): void {
    if (this.coverageBits.length === 0) return;
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

  private checkCoverageAndRequest(): void {
    if (this.coverageBits.length === 0) return;
    if (this.coverageRequestPending) return;
    if (this.state !== ConnectionState.Connected) return;
    if (this.coverageRetries >= RfbClient.COVERAGE_MAX_RETRIES) return;

    const bs = RfbClient.COVERAGE_BLOCK_SIZE;
    let uncoveredCount = 0;
    // 收集所有未覆盖块，按行分组
    const uncoveredByRow = new Map<number, number[]>();
    for (let row = 0; row < this.coverageRows; row++) {
      for (let col = 0; col < this.coverageCols; col++) {
        if (!this.coverageBits[row * this.coverageCols + col]) {
          uncoveredCount++;
          if (!uncoveredByRow.has(row)) uncoveredByRow.set(row, []);
          uncoveredByRow.get(row)!.push(col);
        }
      }
    }
    if (uncoveredCount === 0) return; // 全屏已覆盖

    // 策略：重试次数少时请求整行连续区域，重试次数多时逐块请求
    // （某些服务器对大矩形不响应，但对小矩形或整行有响应）
    const rects: Array<[number, number, number, number]> = [];
    const maxRectsPerBatch = this.coverageRetries < 4 ? 16 : 4;

    if (this.coverageRetries % 2 === 0) {
      // 偶数次：按行合并连续块为大矩形
      for (const [row, cols] of uncoveredByRow) {
        cols.sort((a, b) => a - b);
        let start = cols[0], prev = cols[0];
        for (let i = 1; i <= cols.length; i++) {
          if (i < cols.length && cols[i] === prev + 1) {
            prev = cols[i];
          } else {
            const x = start * bs;
            const y = row * bs;
            const w = Math.min((prev + 1) * bs, this.fbWidth) - x;
            const h = Math.min(bs, this.fbHeight) - (y - row * bs);
            rects.push([x, y, w, h]);
            if (i < cols.length) { start = cols[i]; prev = cols[i]; }
          }
        }
      }
    } else {
      // 奇数次：每个未覆盖块独立请求
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

    if (rects.length === 0) return;

    this.coverageRequestPending = true;
    this.coverageRetries++;

    // 异步批量发送请求
    setTimeout(() => {
      this.coverageRequestPending = false;
      if (this.state !== ConnectionState.Connected) return;
      const batch = rects.slice(0, maxRectsPerBatch);
      for (const [rx, ry, rw, rh] of batch) {
        this.requestFramebufferUpdate(false, rx, ry, rw, rh);
      }
      // 如果还有更多未覆盖区域，下次 frame-done 继续
      if (rects.length > maxRectsPerBatch) {
        setTimeout(() => this.checkCoverageAndRequest(), 100);
      }
    }, 50);
  }

  /**
   * 读取伪编码矩形的附加数据（纯读取，不产生副作用）。
   * @returns 附加数据 Buffer；null 表示数据尚未收全
   */
  private readPseudoEncodingPayload(
    encoding: number, width: number, height: number, dataOffset: number
  ): Buffer | null {
    switch (encoding) {
      case EncodingType.LastRect:
      case EncodingType.NewFBSize:
      case EncodingType.PointerPos:
        // 无附加数据
        return Buffer.alloc(0);

      case EncodingType.DesktopName: {
        if (this.buffer.length < dataOffset + 4) return null;
        const nameLen = this.buffer.readUInt32BE(dataOffset);
        if (this.buffer.length < dataOffset + 4 + nameLen) return null;
        return Buffer.from(this.buffer.subarray(dataOffset + 4, dataOffset + 4 + nameLen));
      }

      case EncodingType.Cursor:
      case EncodingType.RichCursor: {
        // 光标像素 + 位掩码（每行按字节对齐）
        const bytesPerPixel = Math.max(1, Math.ceil(this.pixelFormat.bitsPerPixel / 8));
        const pixelsLen = width * height * bytesPerPixel;
        const maskLen = Math.ceil(width / 8) * height;
        const total = pixelsLen + maskLen;
        if (this.buffer.length < dataOffset + total) return null;
        return Buffer.from(this.buffer.subarray(dataOffset, dataOffset + total));
      }

      default:
        // 未知伪编码按无附加数据处理（保守推进，避免帧卡死）
        return Buffer.alloc(0);
    }
  }

  /**
   * 应用伪编码的副作用（整帧齐备后调用，保证副作用只发生一次）
   */
  private applyPseudoEncoding(
    encoding: number, x: number, y: number, width: number, height: number, payload: Buffer
  ): void {
    switch (encoding) {
      case EncodingType.LastRect:
        break;

      case EncodingType.NewFBSize:
        this.fbWidth = width;
        this.fbHeight = height;
        this.emit('desktop-size', { width, height });
        break;

      case EncodingType.DesktopName:
        this.desktopName = payload.toString('utf8');
        this.emit('desktop-name', this.desktopName);
        break;

      case EncodingType.Cursor:
      case EncodingType.RichCursor:
        this.emit('cursor', { width, height });
        break;

      default:
        break;
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