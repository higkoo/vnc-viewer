"use strict";
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
exports.MobileServer = void 0;
const http = __importStar(require("http"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const net = __importStar(require("net"));
const ws_1 = require("ws");
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const sessions = new Map();
function getMimeType(ext) {
    const map = {
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".png": "image/png",
        ".ico": "image/x-icon",
    };
    return map[ext] || "application/octet-stream";
}
class MobileServer {
    constructor(port = 5800) {
        this.port = port;
        this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));
        this.wss = new ws_1.WebSocketServer({ noServer: true });
        this.setupWebSocket();
        this.httpServer.on("upgrade", (req, socket, head) => {
            const url = req.url || "";
            if (url.startsWith("/proxy")) {
                this.wss.handleUpgrade(req, socket, head, (ws) => {
                    this.wss.emit("connection", ws, req);
                });
            }
            else {
                socket.destroy();
            }
        });
    }
    handleHttp(req, res) {
        const url = req.url || "/";
        let filePath;
        if (url === "/" || url === "/index.html") {
            filePath = path.join(PROJECT_ROOT, "src", "mobile", "index.html");
        }
        else if (url === "/app.js") {
            filePath = path.join(PROJECT_ROOT, "src", "mobile", "app.js");
        }
        else if (url.startsWith("/node_modules/")) {
            filePath = path.join(PROJECT_ROOT, url);
        }
        else {
            filePath = path.join(PROJECT_ROOT, "src", "mobile", url);
        }
        const ext = path.extname(filePath);
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("Not Found");
                return;
            }
            res.writeHead(200, {
                "Content-Type": getMimeType(ext),
                "Access-Control-Allow-Origin": "*",
            });
            res.end(data);
        });
    }
    setupWebSocket() {
        this.wss.on("connection", (ws, req) => {
            const session = {
                ws,
                tcp: null,
                host: "",
                port: 0,
            };
            sessions.set(ws, session);
            ws.on("message", (data) => {
                if (data[0] === 0x00) {
                    // Connect command: 0x00 + host + 0x00 + port (2 bytes big-endian)
                    const nullIdx1 = data.indexOf(0x00, 1);
                    const host = data.subarray(1, nullIdx1).toString("utf8");
                    const port = data.readUInt16BE(nullIdx1 + 1);
                    session.host = host;
                    session.port = port;
                    this.connectToVnc(session, host, port);
                }
                else if (session.tcp) {
                    // Forward raw data to VNC server
                    session.tcp.write(data);
                }
            });
            ws.on("close", () => {
                if (session.tcp) {
                    session.tcp.destroy();
                }
                sessions.delete(ws);
            });
            ws.on("error", () => {
                if (session.tcp) {
                    session.tcp.destroy();
                }
                sessions.delete(ws);
            });
        });
    }
    connectToVnc(session, host, port) {
        const tcp = new net.Socket();
        session.tcp = tcp;
        tcp.connect(port, host, () => {
            session.ws.send(Buffer.from([0x01])); // Connected signal
        });
        tcp.on("data", (data) => {
            if (session.ws.readyState === ws_1.WebSocket.OPEN) {
                session.ws.send(data);
            }
        });
        tcp.on("error", (err) => {
            try {
                const errMsg = Buffer.alloc(2 + Buffer.byteLength(err.message, "utf8"));
                errMsg[0] = 0x02; // Error signal
                errMsg.writeUInt8(err.message.length, 1);
                errMsg.write(err.message, 2, "utf8");
                session.ws.send(errMsg);
            }
            catch {
                // ignore
            }
        });
        tcp.on("close", () => {
            if (session.ws.readyState === ws_1.WebSocket.OPEN) {
                session.ws.send(Buffer.from([0x03])); // Closed signal
            }
        });
    }
    start() {
        // 端口被占用时自动尝试下一个端口，避免 EADDRINUSE 导致主进程崩溃
        const tryListen = (attempt) => {
            const port = this.port + attempt;
            this.httpServer.removeAllListeners("error");
            this.httpServer.once("error", (err) => {
                if (err.code === "EADDRINUSE" && attempt < 20) {
                    console.warn(`[Mobile Server] 端口 ${port} 被占用，尝试端口 ${port + 1}`);
                    tryListen(attempt + 1);
                }
                else {
                    console.error(`[Mobile Server] 启动失败: ${err.message}`);
                }
            });
            this.httpServer.listen(port, "0.0.0.0", () => {
                this.port = port;
                console.log(`[Mobile Server] 运行在 http://0.0.0.0:${this.port}`);
                console.log(`[Mobile Server] 手机浏览器打开 http://<本机IP>:${this.port}`);
            });
        };
        tryListen(0);
    }
    stop() {
        for (const [, session] of sessions) {
            if (session.tcp)
                session.tcp.destroy();
            session.ws.close();
        }
        sessions.clear();
        this.wss.close();
        this.httpServer.close();
    }
    getPort() {
        return this.port;
    }
}
exports.MobileServer = MobileServer;
//# sourceMappingURL=mobileServer.js.map