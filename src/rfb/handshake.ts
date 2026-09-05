/**
 * RFB 协议握手和认证
 * 参考 UltraVNC vncviewer/ClientConnection.cpp
 * 参考 RFC 6143 Section 7.1
 *
 * 所有数据读取均通过 client.readBuffer() 从缓冲区读取，
 * 不再直接读取 socket，以兼容 client.ts 的 data 事件处理机制。
 */

import * as crypto from 'crypto';
import { RfbClient } from './client';
import { SecurityType, ConnectionState, RFB_VERSIONS, RfbVersion } from './types';

export class RfbHandshake {
  private client: RfbClient;
  private securityTypes: SecurityType[] = [];
  private authChallengeSent: boolean = false;

  constructor(client: RfbClient) {
    this.client = client;
  }

  /**
   * 阶段 1: 协议版本协商
   * 服务器发送: "RFB XXX.XXX\n" (12字节)
   * 客户端回复: "RFB XXX.XXX\n" (使用双方都支持的版本)
   */
  processProtocolVersion(): void {
    const buf = this.client.readBuffer(12);
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
    const buf = this.client.readBuffer(4);
    if (!buf) return;

    const secType = buf.readUInt32BE(0);
    if (secType === 0) {
      this.readConnectionFailed();
      return;
    }

    this.securityTypes = [secType as SecurityType];
    this.handleSecurityType();
  }

  private processSecurityV37(): void {
    const numBuf = this.client.readBuffer(1);
    if (!numBuf) return;

    const numTypes = numBuf[0];
    if (numTypes === 0) {
      this.readConnectionFailed();
      return;
    }

    const typesBuf = this.client.readBuffer(numTypes);
    if (!typesBuf) return;

    this.securityTypes = [];
    for (let i = 0; i < numTypes; i++) {
      this.securityTypes.push(typesBuf[i] as SecurityType);
    }

    console.log(`[RFB] 服务器支持的安全类型: ${this.securityTypes.join(', ')}`);

    this.handleSecurityType();
  }

  private readConnectionFailed(): void {
    const reasonLenBuf = this.client.readBuffer(4);
    if (!reasonLenBuf) return;
    const reasonLen = reasonLenBuf.readUInt32BE(0);
    const reasonBuf = this.client.readBuffer(reasonLen);
    if (!reasonBuf) return;
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
    switch (type) {
      case SecurityType.None:
        console.log('[RFB] None 认证');
        this.client.updateState(ConnectionState.ClientInit);
        this.sendClientInit();
        break;
      case SecurityType.VncAuth:
        console.log('[RFB] VNC 认证 - 等待挑战码');
        this.authChallengeSent = false;
        this.client.updateState(ConnectionState.Authentication);
        // processAuthentication 会在数据到达时由 processData 调用
        // 它会先读 16 字节挑战码，再读 4 字节安全结果
        break;
      case SecurityType.MSLogon:
        console.log('[RFB] MS-Logon 认证简化处理');
        this.client.updateState(ConnectionState.ClientInit);
        this.sendClientInit();
        break;
      default:
        this.client.emitError(`不支持的安全类型: ${SecurityType[type]}`);
        break;
    }
  }

  private handleAuthMSLogon(): void {
    console.log('[RFB] MS-Logon 认证简化处理');
    this.client.updateState(ConnectionState.ClientInit);
    this.sendClientInit();
  }

  private reverseBits(b: number): number {
    let result = 0;
    for (let i = 0; i < 8; i++) {
      result = (result << 1) | ((b >> i) & 1);
    }
    return result;
  }

  /**
   * 处理认证阶段数据，分两步：
   * 1. 读 16 字节挑战码 → 发送加密响应
   * 2. 读 4 字节安全结果 → 成功则进入 ClientInit
   */
  processAuthentication(): void {
    if (!this.authChallengeSent) {
      // 第一步：读 16 字节挑战码
      const challenge = this.client.readBuffer(16);
      if (!challenge) return;

      const password = this.client.getParams().password;
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
      this.authChallengeSent = true;
      console.log('[RFB] 已发送加密挑战码，等待安全结果');
      return;
    }

    // 第二步：读 4 字节安全结果
    const result = this.client.readBuffer(4);
    if (!result) return;

    const status = result.readUInt32BE(0);
    if (status !== 0) {
      const reasonLenBuf = this.client.readBuffer(4);
      if (reasonLenBuf) {
        const len = reasonLenBuf.readUInt32BE(0);
        const reason = this.client.readBuffer(len);
        if (reason) {
          this.client.emitError(`认证失败: ${reason.toString('utf8')}`);
          return;
        }
      }
      this.client.emitError('VNC 认证失败');
      return;
    }

    console.log('[RFB] VNC 认证成功');
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
    const header = this.client.readBuffer(24);
    if (!header) return;

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
    const nameBuf = this.client.readBuffer(nameLen);
    if (!nameBuf) return;

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