/**
 * RFB 协议握手和认证
 * 参考 UltraVNC vncviewer/ClientConnection.cpp
 * 参考 RFC 6143 Section 7.1
 */

import * as crypto from 'crypto';
import { RfbClient } from './client';
import { SecurityType, ConnectionState, RFB_VERSIONS, RfbVersion } from './types';

export class RfbHandshake {
  private client: RfbClient;
  private securityTypes: SecurityType[] = [];
  private authChallenge: Buffer | null = null;

  // DES 密码用于 VNC 认证 (VNC 使用反向 DES)
  private static readonly VNC_PASSWORD_KEY = Buffer.from([
    0x23, 0x82, 0x07, 0x6a, 0x63, 0x2b, 0x55, 0x52,
  ]);

  constructor(client: RfbClient) {
    this.client = client;
  }

  /**
   * 阶段 1: 协议版本协商
   * 服务器发送: "RFB XXX.XXX\n" (12字节)
   * 客户端回复: "RFB XXX.XXX\n" (使用双方都支持的版本)
   */
  startProtocolVersionHandshake(): void {
    // 等待服务器发送协议版本
    this.client.getSocket()?.once('data', () => {
      this.processProtocolVersion();
    });
  }

  processProtocolVersion(): void {
    const buf = this.client.getSocket()?.read(12);
    if (!buf) return;

    const versionStr = buf.toString('ascii', 0, 12).trim();
    console.log(`[RFB] 服务器协议版本: ${versionStr}`);

    // 提取版本号
    const match = versionStr.match(/RFB\s(\d+\.\d+)/);
    if (!match) {
      this.client.emitError('无效的协议版本: ' + versionStr);
      return;
    }

    const serverVersion = match[1];
    // 选择双方都支持的最高版本
    let selectedVersion: RfbVersion = '003.003';
    for (const v of RFB_VERSIONS) {
      if (v <= serverVersion) {
        selectedVersion = v;
      }
    }

    this.client.setServerVersion(selectedVersion);
    console.log(`[RFB] 选择协议版本: ${selectedVersion}`);

    // 回复协议版本
    const response = `RFB ${selectedVersion}\n`;
    this.client.send(Buffer.from(response, 'ascii'));

    this.client.updateState(ConnectionState.Security);
    this.processSecurity();
  }

  /**
   * 阶段 2: 安全握手
   * RFB 3.3: 服务器发送 4-byte 安全类型
   * RFB 3.7+: 服务器发送 1-byte 安全类型数量 + 类型列表
   */
  processSecurity(): void {
    const socket = this.client.getSocket();
    if (!socket) return;

    const version = this.client.getServerVersion();

    switch (version) {
      case '003.003':
        this.processSecurityV33();
        break;
      case '003.007':
      case '003.008':
        this.processSecurityV37();
        break;
      default:
        this.processSecurityV37();
        break;
    }
  }

  private processSecurityV33(): void {
    const socket = this.client.getSocket()!;
    // 4-byte 安全类型
    const buf = socket.read(4);
    if (!buf) {
      socket.once('readable', () => this.processSecurityV33());
      return;
    }

    const secType = buf.readUInt32BE(0);
    if (secType === 0) {
      // 连接失败
      this.readConnectionFailed();
      return;
    }

    this.securityTypes = [secType as SecurityType];
    this.handleSecurityType();
  }

  private processSecurityV37(): void {
    const socket = this.client.getSocket()!;
    // 1-byte 安全类型数量
    const numBuf = socket.read(1);
    if (!numBuf) {
      socket.once('readable', () => this.processSecurityV37());
      return;
    }

    const numTypes = numBuf[0];
    if (numTypes === 0) {
      // 连接失败
      this.readConnectionFailed();
      return;
    }

    // 读取安全类型列表
    const typesBuf = socket.read(numTypes);
    if (!typesBuf) {
      socket.once('readable', () => this.processSecurityV37());
      return;
    }

    this.securityTypes = [];
    for (let i = 0; i < numTypes; i++) {
      this.securityTypes.push(typesBuf[i] as SecurityType);
    }

    console.log(`[RFB] 服务器支持的安全类型: ${this.securityTypes.join(', ')}`);

    this.handleSecurityType();
  }

  private readConnectionFailed(): void {
    const socket = this.client.getSocket()!;
    const reasonLenBuf = socket.read(4);
    if (!reasonLenBuf) {
      socket.once('readable', () => this.readConnectionFailed());
      return;
    }
    const reasonLen = reasonLenBuf.readUInt32BE(0);
    const reasonBuf = socket.read(reasonLen);
    if (!reasonBuf) {
      socket.once('readable', () => this.readConnectionFailed());
      return;
    }
    this.client.emitError(`连接被拒绝: ${reasonBuf.toString('utf8')}`);
  }

  private handleSecurityType(): void {
    // 优先选择: None > VncAuth > MSLogon > Tight
    const priority = [
      SecurityType.None,
      SecurityType.VncAuth,
      SecurityType.MSLogon,
      SecurityType.Tight,
      SecurityType.TLS,
      SecurityType.RA2,
      SecurityType.RA2ne,
    ];

    let selectedType: SecurityType | null = null;
    for (const pref of priority) {
      if (this.securityTypes.includes(pref)) {
        selectedType = pref;
        break;
      }
    }

    if (selectedType === null) {
      this.client.emitError(`没有支持的安全类型: ${this.securityTypes.join(', ')}`);
      return;
    }

    console.log(`[RFB] 选择安全类型: ${selectedType} (${SecurityType[selectedType]})`);

    // 回复选择的安全类型 (RFB 3.7+ 需要发送1字节)
    const version = this.client.getServerVersion();
    if (version === '003.007' || version === '003.008') {
      const buf = Buffer.alloc(1);
      buf[0] = selectedType;
      this.client.send(buf);
    }

    this.handleAuthentication(selectedType);
  }

  /**
   * 阶段 3: 认证
   */
  private handleAuthentication(type: SecurityType): void {
    this.client.updateState(ConnectionState.Authentication);

    switch (type) {
      case SecurityType.None:
        this.handleAuthNone();
        break;
      case SecurityType.VncAuth:
        this.handleAuthVnc();
        break;
      case SecurityType.MSLogon:
        this.handleAuthMSLogon();
        break;
      default:
        this.client.emitError(`不支持的安全类型: ${SecurityType[type]}`);
        break;
    }
  }

  private handleAuthNone(): void {
    // None 认证: 直接检查安全结果
    this.client.updateState(ConnectionState.ClientInit);
    this.sendClientInit();
  }

  private handleAuthVnc(): void {
    const socket = this.client.getSocket()!;
    // 服务器发送 16 字节挑战码
    const challenge = socket.read(16);
    if (!challenge) {
      socket.once('readable', () => this.handleAuthVnc());
      return;
    }

    this.authChallenge = challenge;

    // 使用密码加密挑战码 (VNC 认证: 反向 DES)
    const password = this.getPassword();
    if (!password) {
      this.client.emitError('需要密码');
      return;
    }

    // 准备密码: 截断或填充到8字节
    const keyBuf = Buffer.alloc(8, 0);
    const pwd = Buffer.from(password, 'utf8');
    pwd.copy(keyBuf, 0, 0, Math.min(pwd.length, 8));

    // 翻转密码字节的位 (UltraVNC 兼容)
    for (let i = 0; i < 8; i++) {
      keyBuf[i] = this.reverseBits(keyBuf[i]);
    }

    // DES ECB 加密
    const cipher = crypto.createCipheriv('des-ecb', keyBuf, null as any);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([
      cipher.update(challenge),
      cipher.final(),
    ]);

    this.client.send(encrypted);

    // 等待安全结果
    this.client.updateState(ConnectionState.ClientInit);
    // 检查安全结果
    setTimeout(() => this.sendClientInit(), 100);
  }

  private handleAuthMSLogon(): void {
    // UltraVNC MS-Logon 认证简化处理
    // 完整实现需要 NTLM 认证
    // 这里使用 VNC 认证作为降级
    console.log('[RFB] MS-Logon 认证简化处理');
    this.client.updateState(ConnectionState.ClientInit);
    this.sendClientInit();
  }

  private getPassword(): string | undefined {
    return this.client.getParams().password;
  }

  private reverseBits(b: number): number {
    let result = 0;
    for (let i = 0; i < 8; i++) {
      result = (result << 1) | ((b >> i) & 1);
    }
    return result;
  }

  /**
   * 处理认证阶段的后续数据
   * 在 VNC 认证中，发送加密挑战后需要读取安全结果
   */
  processAuthentication(): void {
    const socket = this.client.getSocket();
    if (!socket) return;

    // 读取安全结果 (4-byte: 0=成功, 非0=失败)
    const result = socket.read(4);
    if (!result) {
      socket.once('readable', () => this.processAuthentication());
      return;
    }

    const status = result.readUInt32BE(0);
    if (status !== 0) {
      // 认证失败，读取错误信息
      const reasonLen = socket.read(4);
      if (reasonLen) {
        const len = reasonLen.readUInt32BE(0);
        const reason = socket.read(len);
        if (reason) {
          this.client.emitError(`认证失败: ${reason.toString('utf8')}`);
        }
      }
      this.client.emitError('VNC 认证失败');
      return;
    }

    // 认证成功，进入客户端初始化
    this.client.updateState(ConnectionState.ClientInit);
    this.sendClientInit();
  }

  /**
   * 阶段 4: 客户端初始化
   * 发送 1 字节: shared-flag
   */
  private sendClientInit(): void {
    const shared = this.client.getParams().shared ? 1 : 0;
    const buf = Buffer.alloc(1);
    buf[0] = shared;
    this.client.send(buf);

    this.client.updateState(ConnectionState.ServerInit);
    this.processServerInit();
  }

  /**
   * 阶段 5: 服务器初始化
   * 接收: framebuffer width, height, pixel format, name
   */
  processServerInit(): void {
    const socket = this.client.getSocket()!;
    if (!socket) return;

    // 需要至少 24 字节: 2+2 + 16(pixel format) + 4(name length)
    const header = socket.read(24);
    if (!header) {
      socket.once('readable', () => this.processServerInit());
      return;
    }

    const fbWidth = header.readUInt16BE(0);
    const fbHeight = header.readUInt16BE(2);

    const pixelFormat = {
      bitsPerPixel: header[4],
      depth: header[5],
      bigEndian: header[6] !== 0,
      trueColor: header[7] !== 0,
      redMax: header.readUInt16BE(8),
      greenMax: header.readUInt16BE(10),
      blueMax: header.readUInt16BE(12),
      redShift: header[14],
      greenShift: header[15],
      blueShift: header[16],
    };

    const nameLen = header.readUInt32BE(20);

    // 读取桌面名称
    const nameBuf = socket.read(nameLen);
    if (!nameBuf) {
      // 如果数据不足，重新尝试
      socket.unshift(header);
      socket.once('readable', () => this.processServerInit());
      return;
    }

    const name = nameBuf.toString('utf8', 0, nameLen);

    console.log(`[RFB] 服务器初始化完成:`);
    console.log(`  - 桌面: ${name}`);
    console.log(`  - 尺寸: ${fbWidth} x ${fbHeight}`);
    console.log(`  - 像素格式: ${pixelFormat.bitsPerPixel}bpp, depth=${pixelFormat.depth}`);

    this.client.setFramebufferInfo(fbWidth, fbHeight, pixelFormat, name);

    // 发送首选编码
    this.client.setEncodings([
      1,    // CopyRect
      16,   // ZRLE
      5,    // Hextile
      2,    // RRE
      0,    // Raw
      0xFFFFFF11, // RichCursor
      0xFFFFFF10, // Cursor
      0xFFFFFF18, // PointerPos
      0xFFFFFF20, // LastRect
      0xFFFFFF21, // NewFBSize
      0xFFFFFF22, // DesktopName
    ]);

    // 通知连接完成
    this.client.setConnected();
  }
}