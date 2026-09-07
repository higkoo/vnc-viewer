import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as net from "net";
import { WebSocketServer, WebSocket } from "ws";
import { info, warn, error as logError } from "../main/logger";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
// 允许移动端页面引用的静态根目录（仅项目内的 web 资源），防止路径穿越读取任意文件
const MOBILE_ROOT = path.join(PROJECT_ROOT, "src", "mobile");

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

  constructor(port = 5933) {
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
    const pathname = (req.url || "/").split("?")[0];

    // 解析到允许的静态根目录内，规范化后校验真实路径，防止路径穿越
    let filePath: string;
    if (pathname === "/" || pathname === "/index.html") {
      filePath = path.join(MOBILE_ROOT, "index.html");
    } else if (pathname === "/app.js") {
      filePath = path.join(MOBILE_ROOT, "app.js");
    } else {
      // 仅允许移动端目录内的静态资源，并拒绝任何目录分隔符向上回溯
      const relative = pathname.replace(/^\/+/, "");
      filePath = path.resolve(MOBILE_ROOT, relative);
    }

    if (!filePath.startsWith(MOBILE_ROOT + path.sep)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
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
        // 静态资源允许跨域；但该页面为项目自托管，不鼓励放开 CORS，仅用于调试。
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
      info(`[手机代理] 新客户端接入，当前在线 ${sessions.size} 个`);

      ws.on("message", (data: Buffer) => {
        if (data[0] === 0x00) {
          // Connect command: 0x00 + host + 0x00 + port (2 bytes big-endian)
          this.handleConnectCommand(session, data);
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

  /**
   * 解析并校验 connect 命令，之后发起 TCP 连接。
   * 格式: 0x00 + host (非空, 含路径分隔符即拒绝) + 0x00 + port (2 bytes big-endian)
   */
  private handleConnectCommand(session: MobileSession, data: Buffer): void {
    const nullIdx1 = data.indexOf(0x00, 1);
    if (nullIdx1 <= 1 || data.length < nullIdx1 + 3) {
      this.sendError(session, "无效的连接命令");
      return;
    }

    const host = data.subarray(1, nullIdx1).toString("utf8");
    // 拒绝 host 里夹带路径分隔符，避免代理被当作任意端口跳板/路径
    if (!host || host.includes("/") || host.includes("..")) {
      this.sendError(session, "非法的目标主机");
      return;
    }

    const port = data.readUInt16BE(nullIdx1 + 1);
    if (port === 0 || port > 65535) {
      this.sendError(session, "非法的目标端口");
      return;
    }

    // 若当前已有活动连接，先关闭旧的再建立新连接，避免 socket 泄漏
    if (session.tcp) {
      session.tcp.destroy();
      session.tcp = null;
    }

    session.host = host;
    session.port = port;
    this.connectToVnc(session, host, port);
  }

  private sendError(session: MobileSession, msg: string): void {
    warn(`[手机代理] 命令错误: ${msg}`);
    if (session.ws.readyState !== WebSocket.OPEN) return;
    try {
      const errBytes = Buffer.byteLength(msg, "utf8");
      const errMsg = Buffer.alloc(2 + errBytes);
      errMsg[0] = 0x02; // Error signal
      errMsg.writeUInt8(errBytes, 1);
      errMsg.write(msg, 2, "utf8");
      session.ws.send(errMsg);
    } catch {
      // ignore
    }
  }

  private connectToVnc(session: MobileSession, host: string, port: number): void {
    const tcp = new net.Socket();
    session.tcp = tcp;
    info(`[手机代理] 转发到 VNC 服务器 ${host}:${port}`);

    tcp.connect(port, host, () => {
      info(`[手机代理] 已连接 ${host}:${port}`);
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(Buffer.from([0x01])); // Connected signal
      }
    });

    tcp.on("data", (data: Buffer) => {
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(data);
      }
    });

    tcp.on("error", (err) => {
      logError(`[手机代理] 连接 ${host}:${port} 失败: ${err.message}`);
      this.sendError(session, err.message);
    });

    tcp.on("close", () => {
      // 仅在当前 session 仍指向此 tcp 时发送关闭信号，避免旧连接关闭误报
      if (session.tcp === tcp) {
        session.tcp = null;
        if (session.ws.readyState === WebSocket.OPEN) {
          session.ws.send(Buffer.from([0x03])); // Closed signal
        }
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
          warn(`[手机代理] 端口 ${port} 被占用，尝试端口 ${port + 1}`);
          tryListen(attempt + 1);
        } else {
          logError(`[手机代理] 启动失败: ${err.message}`);
        }
      });
      this.httpServer.listen(port, "0.0.0.0", () => {
        this.port = port;
        info(`[手机代理] 运行在 http://0.0.0.0:${this.port}`);
        info(`[手机代理] 手机浏览器打开 http://<本机IP>:${this.port}`);
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