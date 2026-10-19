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
import {
  RfbVersion, SecurityType, EncodingType, ClientMsgType, ServerMsgType,
  PixelFormat, FramebufferRect, ServerInitInfo, ConnectionParams, ConnectionState,
} from './types';
import { RfbHandshake } from './handshake';
import { EncodingDecoders } from './encodings';
import { RfbInput } from './input';

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

export class RfbClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private state: ConnectionState = ConnectionState.Disconnected;
  private params: ConnectionParams = { host: '', port: 5900, shared: false };
  private handshake: RfbHandshake;
  private encoders: EncodingDecoders;
  private input: RfbInput;

  // 超时管理
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  // 持续帧请求轮询：即使服务器不主动推送，也会定期请求增量更新，
  // 防止画面"卡死"（某些 VNC 服务器在无画面变化时停止推送 FramebufferUpdate）
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly POLL_INTERVAL_MS = 100; // 10fps 轮询

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
  /** buffer 中已消费的前缀偏移（惰性消费，避免频繁拷贝） */
  private readOffset: number = 0;

  // 帧覆盖追踪：记录 32x32 块级别的覆盖状态
  private coverageCols = 0;
  private coverageRows = 0;
  private coverageBits: Uint8Array = new Uint8Array(0);
  private coverageRequestPending = false;
  private coverageRetries = 0;
  private static readonly COVERAGE_BLOCK_SIZE = 32;
  private static readonly COVERAGE_MAX_RETRIES = 8;

// ---- 带宽测量 ----
private bytesReceived: number = 0;
private bytesReceivedWindow: number = 0;
private lastDataAt: number = 0; // 上次收到服务端数据的时间戳
private bandwidthTimer: ReturnType<typeof setInterval> | null = null;
private lastBandwidth: number = 0; // bytes/sec

  // ---- 扩展剪贴板 ----
  /** Extended Clipboard 能力标志（从服务器 SetCutText 消息中解析） */
  private clipboardCapabilities: number = 0;

  // 公开方法用于 handshake 模块
  updateState(state: ConnectionState): void { this.setState(state); }
  getParams(): ConnectionParams { return this.params; }
  /** 从 buffer 中读取 n 字节，并移除已读部分。
   * 返回内部缓冲区的零拷贝视图，调用方应立即使用，勿长期持有。 */
  readBuffer(n: number): Buffer | null {
    if (this.buffer.length - this.readOffset < n) return null;
    const data = this.buffer.subarray(this.readOffset, this.readOffset + n);
    this.readOffset += n;
    return data;
  }
  /** 获取未消费数据长度 */
  bufferLength(): number { return this.buffer.length - this.readOffset; }

  /** 查看缓冲区前 n 字节（不消费）；数据不足返回 null。
   *  返回内部缓冲区的零拷贝视图，调用方应立即使用，勿长期持有。 */
  peekBuffer(n: number): Buffer | null {
    if (this.buffer.length - this.readOffset < n) return null;
    return this.buffer.subarray(this.readOffset, this.readOffset + n);
  }

  /** 消费 n 字节：惰性推进偏移，超过 1MB 且已消费过半时压缩缓冲区释放内存 */
  private consume(n: number): void {
    this.readOffset += n;
    if (this.readOffset > 1024 * 1024 && this.readOffset * 2 > this.buffer.length) {
      this.buffer = Buffer.from(this.buffer.subarray(this.readOffset));
      this.readOffset = 0;
    }
  }

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
  /** 获取当前带宽（bytes/sec） */
  getBandwidth(): number { return this.lastBandwidth; }

  /**
   * 连接到 VNC 服务器
   */
  connect(params: ConnectionParams): void {
    if (this.state !== ConnectionState.Disconnected) {
      this.disconnect();
    }

    this.params = params;
    this.setState(ConnectionState.Connecting);
    this.resetState();

    this.socket = new net.Socket();
    this.socket.setNoDelay(true);
    this.socket.setKeepAlive(true);

    // 连接阶段超时（目标不可达或无响应）
    this.startConnectTimer();

    this.socket.on('timeout', () => {
      if (this.state !== ConnectionState.Connected && this.state !== ConnectionState.Disconnected) {
        this.emitError('连接超时，服务器无响应');
        this.disconnect();
      }
    });

    this.socket.on('connect', () => {
      this.cancelConnectTimer();
      this.buffer = Buffer.alloc(0);
      this.readOffset = 0;
      // 进入握手阶段，启动握手超时
      this.startHandshakeTimer();
      this.setState(ConnectionState.ProtocolVersion);
    });

    this.socket.on('data', (data: Buffer) => {
      this.bytesReceived += data.length;
      this.bytesReceivedWindow += data.length;
      this.lastDataAt = Date.now();
      // 快路径：旧数据已全部消费时直接接管新块，避免 concat 拷贝；
      // 否则仅拼接未消费的剩余部分（配合 readOffset 惰性消费，减少大帧下的 O(n²) 拷贝）
      if (this.readOffset === this.buffer.length) {
        this.buffer = data;
        this.readOffset = 0;
      } else if (this.readOffset > 0) {
        this.buffer = Buffer.concat([this.buffer.subarray(this.readOffset), data]);
        this.readOffset = 0;
      } else {
        this.buffer = Buffer.concat([this.buffer, data]);
      }
      this.resetIdleTimer();
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
    this.cancelConnectTimer();
    this.cancelHandshakeTimer();
    this.cancelIdleTimer();
    this.stopPollTimer();
    this.stopBandwidthMonitor();
    this.input.clearEventBuffer();

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
    this.readOffset = 0;
  }

  /**
   * 发送帧缓冲更新请求
   */
  requestFramebufferUpdate(incremental: boolean, x: number = 0, y: number = 0,
    width: number = 0, height: number = 0): void {
    if (!this.socket || this.state !== ConnectionState.Connected) return;

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
    this.emit('update-request');
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
    msg[1] = 0; msg[2] = 0; msg[3] = 0;
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
   * 发送剪贴板文本 (Extended Clipboard 协议)
   * 支持 1024 字节以上的大文本，通过 GII 扩展分片
   */
  sendCutText(text: string): void {
    if (!this.socket) return;
    const utf8 = Buffer.from(text, 'utf8');

    // 标准 ClientCutText 格式: type(1) + padding(3) + length(4) + text
    const standardMsg = Buffer.alloc(8 + utf8.length);
    standardMsg[0] = ClientMsgType.ClientCutText;
    standardMsg[1] = 0; standardMsg[2] = 0; standardMsg[3] = 0;
    standardMsg.writeUInt32BE(utf8.length, 4);
    utf8.copy(standardMsg, 8);
    this.send(standardMsg);
  }

  /**
   * 请求调整桌面大小 (Extended Desktop Size)
   * 参考 RFC 6143 Section 7.5.5
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
    layout.writeUInt16BE(0, 4); // x-position
    layout.writeUInt16BE(0, 6); // y-position
    layout.writeUInt16BE(width, 8);
    layout.writeUInt16BE(height, 10);
    layout.writeUInt32BE(0, 12); // flags
    this.send(layout);
  }

  // ---- 超时管理 ----

  private startConnectTimer(): void {
    this.cancelConnectTimer();
    this.connectTimer = setTimeout(() => {
      if (this.state === ConnectionState.Connecting) {
        this.emitError('连接超时：无法连接到服务器');
        this.disconnect();
      }
    }, CONNECT_TIMEOUT);
  }

  private cancelConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private startHandshakeTimer(): void {
    this.cancelHandshakeTimer();
    this.handshakeTimer = setTimeout(() => {
      if (this.state !== ConnectionState.Connected && this.state !== ConnectionState.Disconnected) {
        this.emitError('握手超时：协议协商失败');
        this.disconnect();
      }
    }, HANDSHAKE_TIMEOUT);
  }

  private cancelHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private resetIdleTimer(): void {
    this.cancelIdleTimer();
    // 空闲预警定时器：仅打印诊断日志，【不断开连接】。
    //
    // 背景：RFC 6143 规定服务器对"无画面变化"的增量更新请求可以不发送任何
    // 响应。静态屏幕（用户阅读远程内容）是正常场景，此前据此断开连接
    // （IDLE_TIMEOUT 后 emitError + disconnect）导致用户每 40 秒被踢线。
    // 真实断线（服务器进程退出/网络中断）由 socket 的 close/error 事件捕获，
    // 配合 setKeepAlive 的 TCP 保活兜底，无需应用层空闲判定。
    this.idleTimer = setTimeout(() => {
      if (this.state !== ConnectionState.Connected) return;
      const idleMs = Date.now() - this.lastDataAt;
      if (idleMs >= IDLE_TIMEOUT) {
        console.warn(`[RFB] [IDLE-WARN] 已 ${(idleMs / 1000).toFixed(0)}s 未收到服务器数据（静态屏幕属正常，保持连接）`);
      }
      this.resetIdleTimer();
    }, IDLE_TIMEOUT);
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // ---- 带宽测量 ----

  private startBandwidthMonitor(): void {
    this.stopBandwidthMonitor();
    this.bytesReceivedWindow = 0;
    this.bandwidthTimer = setInterval(() => {
      this.lastBandwidth = this.bytesReceivedWindow;
      this.bytesReceivedWindow = 0;
      this.emit('bandwidth', this.lastBandwidth);
    }, BANDWIDTH_WINDOW_MS);
  }

  private stopBandwidthMonitor(): void {
    if (this.bandwidthTimer !== null) {
      clearInterval(this.bandwidthTimer);
      this.bandwidthTimer = null;
    }
  }

  // ---- 持续帧轮询 ----

  private startPollTimer(): void {
    this.stopPollTimer();
    // 立即发一次增量请求，确保连接后有画面
    this.requestFramebufferUpdate(true);
    this.pollTimer = setInterval(() => {
      if (this.state === ConnectionState.Connected) {
        // 距上次收到数据超过 1 秒才主动请求（避免与服务器的主动推送冲突）
        if (Date.now() - this.lastDataAt > 1000) {
          this.requestFramebufferUpdate(true);
        }
      }
    }, RfbClient.POLL_INTERVAL_MS);
  }

  private stopPollTimer(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ---- 内部方法 ----

  private resetState(): void {
    this.bytesReceived = 0;
    this.bytesReceivedWindow = 0;
    this.lastBandwidth = 0;
    this.clipboardCapabilities = 0;
    this.input.resetModifierState();
  }

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
    this.initCoverage(width, height);
  }

  setConnected(): void {
    // 连接建立后取消握手超时，启动空闲超时和带宽监控
    this.cancelHandshakeTimer();
    this.startIdleTimer();
    this.startBandwidthMonitor();

    // 重要：必须先将 state 设为 Connected，再调用 requestFramebufferUpdate，
    // 否则 requestFramebufferUpdate 中的状态检查会拒绝发送。
    this.setState(ConnectionState.Connected);
    this.emit('server-info', {
      width: this.fbWidth,
      height: this.fbHeight,
      pixelFormat: this.pixelFormat,
      name: this.desktopName,
      version: this.serverVersion,
    });

    this.initCoverage(this.fbWidth, this.fbHeight);
    // 请求全量帧（非增量），获取完整画面
    this.requestFramebufferUpdate(false);
    // 启动持续轮询，即使服务器不主动推送也会定期请求增量更新
    this.startPollTimer();
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
    } else {
      console.warn(`[RFB] [INPUT-DIAG] send 被丢弃！socket=${this.socket ? '存在' : 'null'} writable=${this.socket?.writable} state=${this.state} dataLen=${data.length} msgType=${data[0]}`);
    }
  }

  /**
   * 处理接收到的数据
   */
  private processData(): void {
    let iterations = 0;
    let hitIterationCap = false;
    while (this.bufferLength() > 0) {
      if (++iterations > 100) {
        hitIterationCap = true;
        console.warn('[RFB] processData 超过 100 次迭代，让出事件循环后续跑。state=', this.state, 'bufferLen=', this.bufferLength());
        break;
      }
      const prevLen = this.bufferLength();
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
      if (this.bufferLength() === prevLen) {
        break;
      }
    }
    // 迭代超限时残余数据可能长时间滞留（若无后续 data 事件），
    // 让出事件循环后主动续跑，而不是被动等待下一个数据包
    if (hitIterationCap && this.bufferLength() > 0 && this.state === ConnectionState.Connected) {
      setImmediate(() => this.processData());
    }
  }

  /**
   * 处理服务器消息 (连接建立后)
   */
  private processServerMessage(): void {
    while (this.bufferLength() >= 1) {
      const msgType = this.buffer[this.readOffset] as ServerMsgType;

      switch (msgType) {
        case ServerMsgType.FramebufferUpdate:
          if (!this.processFramebufferUpdate()) return;
          break;
        case ServerMsgType.SetColorMapEntries:
          if (!this.processSetColorMapEntries()) return;
          break;
        case ServerMsgType.Bell:
          this.consume(1);
          this.emit('bell');
          break;
        case ServerMsgType.ServerCutText:
          if (!this.processServerCutText()) return;
          break;
        case ServerMsgType.DesktopSize:
          if (!this.processDesktopSize()) return;
          break;
        case ServerMsgType.ClientRedirect:
          if (!this.processClientRedirect()) return;
          break;
        default:
          // 未知消息类型，跳过一字节
          this.consume(1);
          break;
      }
    }
  }

  /** 连续解码失败计数，用于判断是否需要断线重连 */
  private consecutiveDecodeErrors: number = 0;
  private static readonly MAX_CONSECUTIVE_DECODE_ERRORS = 10;

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
  private processFramebufferUpdate(): boolean {
    try {
      const result = this.processFramebufferUpdateInner();
      if (result) {
        // 成功解码后重置错误计数
        this.consecutiveDecodeErrors = 0;
      }
      return result;
    } catch (err) {
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
      this.readOffset = 0;

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
  private processFramebufferUpdateInner(): boolean {
    if (this.bufferLength() < 4) return false;

    const numRects = this.buffer.readUInt16BE(this.readOffset + 2);
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

    // ---- 第一阶段：扫描并确认整帧数据齐备 ----
    while (continuous ? !lastRect : handled < numRects) {
      if (this.bufferLength() < cursor + 12) return false;

      const x = this.buffer.readUInt16BE(this.readOffset + cursor);
      const y = this.buffer.readUInt16BE(this.readOffset + cursor + 2);
      const width = this.buffer.readUInt16BE(this.readOffset + cursor + 4);
      const height = this.buffer.readUInt16BE(this.readOffset + cursor + 6);
      const encoding = this.buffer.readUInt32BE(this.readOffset + cursor + 8);
      cursor += 12;

      if (encoding >= 0xFFFFFF00) {
        if (encoding === EncodingType.LastRect) {
          pending.push({ kind: 'pseudo', x, y, width, height, encoding });
          lastRect = true;
          continue;
        }
        const payload = this.readPseudoEncodingPayload(encoding, width, height, this.readOffset + cursor);
        if (payload === null) return false;
        pending.push({ kind: 'pseudo', x, y, width, height, encoding, payload });
        cursor += payload.length;
      } else if (encoding === EncodingType.ZRLE) {
        if (this.bufferLength() < cursor + 4) return false;
        const compressedLen = this.buffer.readUInt32BE(this.readOffset + cursor);
        if (this.bufferLength() < cursor + 4 + compressedLen) return false;
        this.markCoverage(x, y, width, height);
        pending.push({
          kind: 'zrle', x, y, width, height, encoding,
          payload: Buffer.from(this.buffer.subarray(this.readOffset + cursor + 4, this.readOffset + cursor + 4 + compressedLen)),
        });
        cursor += 4 + compressedLen;
      } else {
        const result = this.encoders.decode(
          this.buffer, this.readOffset + cursor, encoding, width, height, this.pixelFormat
        );
        if (result === null) return false;
        this.markCoverage(x, y, width, height);
        pending.push({ kind: 'decode', x, y, width, height, encoding, pixels: result.pixels });
        cursor += result.consumed;
      }
      handled++;
    }

    // ---- 第二阶段：整帧齐备，按线序统一处理 ----
    // 先消费接收缓冲区（ZRLE 解码为异步，payload 已拷贝到 pending）
    this.consume(cursor);

    // ZRLE 矩形的 tile 数据经异步解压流产出，需等全部解齐再发 framebuffer-done，
    // 否则静态屏幕下（服务器不再响应增量请求）首帧会永远卡在待转发队列
    let zrleRemaining = 0;
    let frameDoneSent = false;
    const finishFrame = (): void => {
      if (frameDoneSent) return;
      frameDoneSent = true;
      this.emit('framebuffer-done');
      this.checkCoverageAndRequest();
    };

    for (const p of pending) {
      if (p.kind === 'zrle') {
        zrleRemaining++;
        this.encoders.feedZrle(
          p.payload!, p.x, p.y, p.width, p.height, this.pixelFormat,
          (rect) => this.emit('framebuffer-update', rect),
          () => {
            if (--zrleRemaining === 0) finishFrame();
          }
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

    if (zrleRemaining === 0) finishFrame();
    return true;
  }

  // ---- 帧覆盖追踪 ----

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
    if (uncoveredCount === 0) return;

    const rects: Array<[number, number, number, number]> = [];
    const maxRectsPerBatch = this.coverageRetries < 4 ? 16 : 4;

    if (this.coverageRetries % 2 === 0) {
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

    setTimeout(() => {
      this.coverageRequestPending = false;
      if (this.state !== ConnectionState.Connected) return;
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
   * CPIXEL 字节数 (RFC 6143 §7.7.5)：8bpp=1, 16bpp=2, 32bpp=3（三分量均 ≤255）
   */
  private cpixelSize(): number {
    const f = this.pixelFormat;
    if (f.bitsPerPixel === 8) return 1;
    if (f.bitsPerPixel === 16) return 2;
    return (f.redMax <= 255 && f.greenMax <= 255 && f.blueMax <= 255) ? 3 : 4;
  }

  /**
   * 读取伪编码矩形的附加数据
   */
  private readPseudoEncodingPayload(
    encoding: number, width: number, height: number, dataOffset: number
  ): Buffer | null {
    switch (encoding) {
      case EncodingType.LastRect:
      case EncodingType.NewFBSize:
      case EncodingType.PointerPos:
        return Buffer.alloc(0);

      case EncodingType.DesktopName: {
        if (this.buffer.length < dataOffset + 4) return null;
        const nameLen = this.buffer.readUInt32BE(dataOffset);
        if (this.buffer.length < dataOffset + 4 + nameLen) return null;
        return Buffer.from(this.buffer.subarray(dataOffset + 4, dataOffset + 4 + nameLen));
      }

      case EncodingType.Cursor:
      case EncodingType.RichCursor: {
        // RichCursor (0xFFFFFF11): 像素 (bpp*w*h) + mask (ceil(w/8)*h)
        // Cursor/XCursor (0xFFFFFF10): 2 个 CPIXEL 颜色（前景/背景）+ mask
        //   —— 经 REA 反编译 UltraVNC vncviewer.exe 光标处理器确认，
        //      旧实现误将两者都按「像素+mask」解析。
        if (encoding === EncodingType.Cursor) {
          const cpi = this.cpixelSize();
          const colorsLen = cpi * 2;
          const maskLen = Math.ceil(width / 8) * height;
          const total = colorsLen + maskLen;
          if (this.buffer.length < dataOffset + total) return null;
          return Buffer.from(this.buffer.subarray(dataOffset, dataOffset + total));
        }
        const bytesPerPixel = Math.max(1, Math.ceil(this.pixelFormat.bitsPerPixel / 8));
        const pixelsLen = width * height * bytesPerPixel;
        const maskLen = Math.ceil(width / 8) * height;
        const total = pixelsLen + maskLen;
        if (this.buffer.length < dataOffset + total) return null;
        return Buffer.from(this.buffer.subarray(dataOffset, dataOffset + total));
      }

      default:
        return Buffer.alloc(0);
    }
  }

  /**
   * 应用伪编码的副作用
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
        this.initCoverage(width, height);
        this.emit('desktop-size', { width, height });
        break;

      case EncodingType.DesktopName:
        this.desktopName = payload.toString('utf8');
        this.emit('desktop-name', this.desktopName);
        break;

      case EncodingType.Cursor:
      case EncodingType.RichCursor:
        // 透传光标数据：Cursor 载荷 = 2 CPIXEL + mask；RichCursor = 像素 + mask
        this.emit('cursor', { width, height, encoding, data: payload });
        break;

      default:
        break;
    }
  }

  /**
   * 处理 SetColorMapEntries 消息
   */
  private processSetColorMapEntries(): boolean {
    if (this.bufferLength() < 6) return false;
    const numColors = this.buffer.readUInt16BE(this.readOffset + 4);
    const totalSize = 6 + numColors * 6;
    if (this.bufferLength() < totalSize) return false;
    this.consume(totalSize);
    return true;
  }

  /**
   * 处理服务器剪贴板文本
   * 标准格式: 1-byte msg-type(3), 3-byte padding, 4-byte length, text
   * Extended Clipboard (UltraVNC 扩展，经 REA 反编译确认):
   *   长度字段高位 (0x80000000) 置位；载荷 = flags(4, BE) + data，
   *   **无内层长度字段**（旧实现误读 4 字节内层长度，导致与 UltraVNC
   *   服务器 clipboard 同步错位）。
   *   flags 高位字节为动作：0x02=请求客户端剪贴板, 0x08=能力通告,
   *   0x10=提供剪贴板数据（文本）; 低位为格式掩码。
   */
  private processServerCutText(): boolean {
    if (this.bufferLength() < 8) return false;

    const flagsOrLen = this.buffer.readUInt32BE(this.readOffset + 4);

    if (flagsOrLen & 0x80000000) {
      // Extended Clipboard 格式
      const payloadLen = flagsOrLen & 0x7FFFFFFF;
      if (payloadLen < 4 || payloadLen > 0x1000000) {
        // 畸形长度：等待只会永久卡死，直接报错断开
        this.emitError(`剪贴板数据长度异常: ${payloadLen} 字节`);
        this.disconnect();
        return false;
      }
      if (this.bufferLength() < 8 + payloadLen) return false;
      const extFlags = this.buffer.readUInt32BE(this.readOffset + 8);
      const action = (extFlags >>> 24) & 0xFF;
      this.clipboardCapabilities = extFlags & 0x00FFFFFF;
      const dataLen = payloadLen - 4;

      if (action === 0x02) {
        // 服务端请求客户端剪贴板：仅记录，不主动回送（避免隐私外泄）
        console.log('[RFB] [CLIPBOARD] 服务端请求客户端剪贴板（未自动回送）');
      } else if (dataLen > 0) {
        // 0x10（提供数据）等：载荷为剪贴板文本
        const text = this.buffer.subarray(this.readOffset + 12, this.readOffset + 12 + dataLen).toString('utf8');
        this.emit('clipboard', text);
      }
      this.consume(8 + payloadLen);
      return true;
    }

    // 标准格式: length(4) + data
    const len = flagsOrLen;
    if (len > 0x1000000) {
      this.emitError(`剪贴板数据长度异常: ${len} 字节`);
      this.disconnect();
      return false;
    }
    if (this.bufferLength() < 8 + len) return false;
    const text = this.buffer.subarray(this.readOffset + 8, this.readOffset + 8 + len).toString('utf8');
    this.consume(8 + len);
    this.emit('clipboard', text);
    return true;
  }

  /**
   * 处理桌面大小变化 (Extended Desktop Size 响应)
   * 格式: 1-byte msg-type(251), 1-byte padding, 2-byte width, 2-byte height,
   *        1-byte number-of-screens(0xFF=unspecified), [screens...]
   */
  private processDesktopSize(): boolean {
    // 消息头: type(1) + padding(1) + width(2) + height(2) + numScreens(1)
    if (this.bufferLength() < 7) return false;
    const width = this.buffer.readUInt16BE(this.readOffset + 2);
    const height = this.buffer.readUInt16BE(this.readOffset + 4);
    const numScreens = this.buffer[this.readOffset + 6];

    // 屏幕布局项固定 16 字节（id 4 + x/y/w/h 各 2 + flags 4），
    // 必须等完整消息到达后再消费，否则会协议失步
    let consumed = 7;
    if (numScreens !== 0xFF) {
      if (this.bufferLength() < consumed + numScreens * 16) return false;
      consumed += numScreens * 16;
    }

    // 更新帧缓冲大小
    this.fbWidth = width;
    this.fbHeight = height;
    this.initCoverage(width, height);

    this.consume(consumed);
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
  private processClientRedirect(): boolean {
    if (this.bufferLength() < 10) return false;
    const hostLen = this.buffer.readUInt32BE(this.readOffset + 2);
    if (hostLen > MAX_REASON_LENGTH) {
      this.emitError(`重定向消息长度异常: ${hostLen} 字节`);
      this.disconnect();
      return false;
    }
    if (this.bufferLength() < 10 + hostLen) return false;
    const host = this.buffer.subarray(this.readOffset + 6, this.readOffset + 6 + hostLen).toString('utf8');
    const port = this.buffer.readUInt32BE(this.readOffset + 6 + hostLen);
    this.consume(10 + hostLen);

    console.log(`[RFB] 服务器重定向到 ${host}:${port}`);
    this.emit('redirect', { host, port });
    return true;
  }

  /**
   * 启动空闲超时检测（复用 resetIdleTimer 的预警机制）
   */
  private startIdleTimer(): void {
    this.resetIdleTimer();
  }
}
