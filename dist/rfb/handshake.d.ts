/**
 * RFB 协议握手和认证
 * 参考 UltraVNC vncviewer/ClientConnection.cpp
 * 参考 RFC 6143 Section 7.1
 *
 * 所有数据读取均通过 client.readBuffer() 从缓冲区读取，
 * 不再直接读取 socket，以兼容 client.ts 的 data 事件处理机制。
 */
import { RfbClient } from './client';
export declare class RfbHandshake {
    private client;
    private securityTypes;
    private authChallengeSent;
    constructor(client: RfbClient);
    /**
     * 阶段 1: 协议版本协商
     * 服务器发送: "RFB XXX.XXX\n" (12字节)
     * 客户端回复: "RFB XXX.XXX\n" (使用双方都支持的版本)
     */
    processProtocolVersion(): void;
    /**
     * 阶段 2: 安全握手
     * RFB 3.3: 服务器发送 4-byte 安全类型
     * RFB 3.7+: 服务器发送 1-byte 安全类型数量 + 类型列表
     */
    processSecurity(): void;
    private processSecurityV33;
    private processSecurityV37;
    private readConnectionFailed;
    private handleSecurityType;
    /**
     * 阶段 3: 认证
     */
    private handleAuthentication;
    private handleAuthMSLogon;
    private reverseBits;
    /**
     * 处理认证阶段数据，分两步：
     * 1. 读 16 字节挑战码 → 发送加密响应
     * 2. 读 4 字节安全结果 → 成功则进入 ClientInit
     */
    processAuthentication(): void;
    /**
     * 阶段 4: 客户端初始化
     * 发送 1 字节: shared-flag
     */
    private sendClientInit;
    /**
     * 阶段 5: 服务器初始化
     * 接收: framebuffer width, height, pixel format, name
     */
    processServerInit(): void;
}
//# sourceMappingURL=handshake.d.ts.map