export declare class MobileServer {
    private httpServer;
    private wss;
    private port;
    constructor(port?: number);
    private handleHttp;
    private setupWebSocket;
    /**
     * 解析并校验 connect 命令，之后发起 TCP 连接。
     * 格式: 0x00 + host (非空, 含路径分隔符即拒绝) + 0x00 + port (2 bytes big-endian)
     */
    private handleConnectCommand;
    private sendError;
    private connectToVnc;
    start(): void;
    stop(): void;
    getPort(): number;
}
//# sourceMappingURL=mobileServer.d.ts.map