export declare class MobileServer {
    private httpServer;
    private wss;
    private port;
    constructor(port?: number);
    private handleHttp;
    private setupWebSocket;
    private connectToVnc;
    start(): void;
    stop(): void;
    getPort(): number;
}
//# sourceMappingURL=mobileServer.d.ts.map