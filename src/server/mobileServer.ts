import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as net from "net";
import { WebSocketServer, WebSocket } from "ws";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

interface MobileSession {
  ws: WebSocket;
  tcp: net.Socket | null;
  host: string;
  port: number;
}

const sessions = new Map<WebSocket, MobileSession>();

function getMimeType(ext: string): string {
  const map: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".ico": "image/x-icon",
  };
  return map[ext] || "application/octet-stream";
}

export class MobileServer {
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private port: number;

  constructor(port = 5800) {
    this.port = port;
    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.setupWebSocket();

    this.httpServer.on("upgrade", (req, socket, head) => {
      const url = req.url || "";
      if (url.startsWith("/proxy")) {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit("connection", ws, req);
        });
      } else {
        socket.destroy();
      }
    });
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || "/";
    let filePath: string;

    if (url === "/" || url === "/index.html") {
      filePath = path.join(PROJECT_ROOT, "src", "mobile", "index.html");
    } else if (url === "/app.js") {
      filePath = path.join(PROJECT_ROOT, "src", "mobile", "app.js");
    } else if (url.startsWith("/node_modules/")) {
      filePath = path.join(PROJECT_ROOT, url);
    } else {
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

  private setupWebSocket(): void {
    this.wss.on("connection", (ws: WebSocket, req) => {
      const session: MobileSession = {
        ws,
        tcp: null,
        host: "",
        port: 0,
      };
      sessions.set(ws, session);

      ws.on("message", (data: Buffer) => {
        if (data[0] === 0x00) {
          // Connect command: 0x00 + host + 0x00 + port (2 bytes big-endian)
          const nullIdx1 = data.indexOf(0x00, 1);
          const host = data.subarray(1, nullIdx1).toString("utf8");
          const port = data.readUInt16BE(nullIdx1 + 1);
          session.host = host;
          session.port = port;
          this.connectToVnc(session, host, port);
        } else if (session.tcp) {
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

  private connectToVnc(session: MobileSession, host: string, port: number): void {
    const tcp = new net.Socket();
    session.tcp = tcp;

    tcp.connect(port, host, () => {
      session.ws.send(Buffer.from([0x01])); // Connected signal
    });

    tcp.on("data", (data: Buffer) => {
      if (session.ws.readyState === WebSocket.OPEN) {
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
      } catch {
        // ignore
      }
    });

    tcp.on("close", () => {
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(Buffer.from([0x03])); // Closed signal
      }
    });
  }

  start(): void {
    // 端口被占用时自动尝试下一个端口，避免 EADDRINUSE 导致主进程崩溃
    const tryListen = (attempt: number) => {
      const port = this.port + attempt;
      this.httpServer.removeAllListeners("error");
      this.httpServer.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempt < 20) {
          console.warn(`[Mobile Server] 端口 ${port} 被占用，尝试端口 ${port + 1}`);
          tryListen(attempt + 1);
        } else {
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

  stop(): void {
    for (const [, session] of sessions) {
      if (session.tcp) session.tcp.destroy();
      session.ws.close();
    }
    sessions.clear();
    this.wss.close();
    this.httpServer.close();
  }

  getPort(): number {
    return this.port;
  }
}