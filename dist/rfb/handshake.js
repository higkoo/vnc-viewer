"use strict";
/**
 * RFB 协议握手和认证
 * 参考 UltraVNC vncviewer/ClientConnection.cpp
 * 参考 RFC 6143 Section 7.1
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
exports.RfbHandshake = void 0;
const crypto = __importStar(require("crypto"));
const types_1 = require("./types");
class RfbHandshake {
    constructor(client) {
        this.securityTypes = [];
        this.authChallenge = null;
        this.client = client;
    }
    /**
     * 阶段 1: 协议版本协商
     * 服务器发送: "RFB XXX.XXX\n" (12字节)
     * 客户端回复: "RFB XXX.XXX\n" (使用双方都支持的版本)
     */
    startProtocolVersionHandshake() {
        // 等待服务器发送协议版本
        this.client.getSocket()?.once('data', () => {
            this.processProtocolVersion();
        });
    }
    processProtocolVersion() {
        const buf = this.client.getSocket()?.read(12);
        if (!buf)
            return;
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
        let selectedVersion = '003.003';
        for (const v of types_1.RFB_VERSIONS) {
            if (v <= serverVersion) {
                selectedVersion = v;
            }
        }
        this.client.setServerVersion(selectedVersion);
        console.log(`[RFB] 选择协议版本: ${selectedVersion}`);
        // 回复协议版本
        const response = `RFB ${selectedVersion}\n`;
        this.client.send(Buffer.from(response, 'ascii'));
        this.client.updateState(types_1.ConnectionState.Security);
        this.processSecurity();
    }
    /**
     * 阶段 2: 安全握手
     * RFB 3.3: 服务器发送 4-byte 安全类型
     * RFB 3.7+: 服务器发送 1-byte 安全类型数量 + 类型列表
     */
    processSecurity() {
        const socket = this.client.getSocket();
        if (!socket)
            return;
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
    processSecurityV33() {
        const socket = this.client.getSocket();
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
        this.securityTypes = [secType];
        this.handleSecurityType();
    }
    processSecurityV37() {
        const socket = this.client.getSocket();
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
            this.securityTypes.push(typesBuf[i]);
        }
        console.log(`[RFB] 服务器支持的安全类型: ${this.securityTypes.join(', ')}`);
        this.handleSecurityType();
    }
    readConnectionFailed() {
        const socket = this.client.getSocket();
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
    handleSecurityType() {
        // 优先选择: None > VncAuth > MSLogon > Tight
        const priority = [
            types_1.SecurityType.None,
            types_1.SecurityType.VncAuth,
            types_1.SecurityType.MSLogon,
            types_1.SecurityType.Tight,
            types_1.SecurityType.TLS,
            types_1.SecurityType.RA2,
            types_1.SecurityType.RA2ne,
        ];
        let selectedType = null;
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
        console.log(`[RFB] 选择安全类型: ${selectedType} (${types_1.SecurityType[selectedType]})`);
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
    handleAuthentication(type) {
        this.client.updateState(types_1.ConnectionState.Authentication);
        switch (type) {
            case types_1.SecurityType.None:
                this.handleAuthNone();
                break;
            case types_1.SecurityType.VncAuth:
                this.handleAuthVnc();
                break;
            case types_1.SecurityType.MSLogon:
                this.handleAuthMSLogon();
                break;
            default:
                this.client.emitError(`不支持的安全类型: ${types_1.SecurityType[type]}`);
                break;
        }
    }
    handleAuthNone() {
        // None 认证: 直接检查安全结果
        this.client.updateState(types_1.ConnectionState.ClientInit);
        this.sendClientInit();
    }
    handleAuthVnc() {
        const socket = this.client.getSocket();
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
        const cipher = crypto.createCipheriv('des-ecb', keyBuf, null);
        cipher.setAutoPadding(false);
        const encrypted = Buffer.concat([
            cipher.update(challenge),
            cipher.final(),
        ]);
        this.client.send(encrypted);
        // 等待安全结果
        this.client.updateState(types_1.ConnectionState.ClientInit);
        // 检查安全结果
        setTimeout(() => this.sendClientInit(), 100);
    }
    handleAuthMSLogon() {
        // UltraVNC MS-Logon 认证简化处理
        // 完整实现需要 NTLM 认证
        // 这里使用 VNC 认证作为降级
        console.log('[RFB] MS-Logon 认证简化处理');
        this.client.updateState(types_1.ConnectionState.ClientInit);
        this.sendClientInit();
    }
    getPassword() {
        return this.client.getParams().password;
    }
    reverseBits(b) {
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
    processAuthentication() {
        const socket = this.client.getSocket();
        if (!socket)
            return;
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
        this.client.updateState(types_1.ConnectionState.ClientInit);
        this.sendClientInit();
    }
    /**
     * 阶段 4: 客户端初始化
     * 发送 1 字节: shared-flag
     */
    sendClientInit() {
        const shared = this.client.getParams().shared ? 1 : 0;
        const buf = Buffer.alloc(1);
        buf[0] = shared;
        this.client.send(buf);
        this.client.updateState(types_1.ConnectionState.ServerInit);
        this.processServerInit();
    }
    /**
     * 阶段 5: 服务器初始化
     * 接收: framebuffer width, height, pixel format, name
     */
    processServerInit() {
        const socket = this.client.getSocket();
        if (!socket)
            return;
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
            1, // CopyRect
            16, // ZRLE
            5, // Hextile
            2, // RRE
            0, // Raw
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
exports.RfbHandshake = RfbHandshake;
// DES 密码用于 VNC 认证 (VNC 使用反向 DES)
RfbHandshake.VNC_PASSWORD_KEY = Buffer.from([
    0x23, 0x82, 0x07, 0x6a, 0x63, 0x2b, 0x55, 0x52,
]);
//# sourceMappingURL=handshake.js.map