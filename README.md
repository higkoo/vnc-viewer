# VNC Viewer

跨平台 VNC 查看器，参考 [UltraVNC](https://github.com/ultravnc/UltraVNC) 实现，优先支持 macOS。

## 功能特性

- **RFB 协议** — 支持 RFB 3.3/3.7/3.8 协议版本
- **多种认证** — VNC 认证（DES 挑战-响应）、None 认证
- **编码支持** — Raw、CopyRect、RRE、Hextile、ZRLE（Zlib 解压）
- **伪编码** — 光标、RichCursor、PointerPos、LastRect、NewFBSize、DesktopName
- **输入转发** — 键盘事件（X11 Keysym 映射）、鼠标事件（5 键+滚轮）
- **Canvas 渲染** — 高性能像素渲染，支持缩放适配/实际大小
- **macOS 原生** — 原生菜单栏、全屏模式、深色主题、Retina 支持
- **跨平台** — 基于 Electron，可在 macOS / Windows / Linux 运行

## 项目架构

```
vnc-viewer/
├── src/
│   ├── main/              # Electron 主进程
│   │   ├── main.ts        #   窗口管理、IPC 通信
│   │   └── preload.ts     #   安全桥接（contextBridge）
│   ├── renderer/          # 渲染进程（UI）
│   │   ├── index.html     #   主界面
│   │   ├── styles/main.css #  macOS 深色风格样式
│   │   └── app.ts         #   UI 逻辑（Canvas 渲染、输入处理）
│   └── rfb/               # RFB 协议实现
│       ├── types.ts       #   类型定义（RFC 6143）
│       ├── client.ts      #   RFB 客户端核心
│       ├── handshake.ts   #   握手和认证
│       ├── encodings.ts   #   编码解码器
│       └── input.ts       #   键盘/鼠标事件映射
├── dist/                  # 编译输出
├── package.json
└── tsconfig.json
```

## 技术栈

| 层 | 技术 | 说明 |
|---|------|------|
| 桌面框架 | Electron | 跨平台桌面应用 |
| 协议层 | Node.js `net` | TCP 连接、RFB 协议 |
| 渲染层 | Canvas 2D API | 像素数据渲染 |
| 语言 | TypeScript | 全栈类型安全 |
| 编码 | Node.js `zlib` | ZRLE 解压 |
| 认证 | Node.js `crypto` | DES 加密 |

## 快速开始

```bash
# 安装依赖
npm install

# 编译 TypeScript
npm run build

# 启动应用
npm start
```

## 使用说明

1. 启动应用后，在弹出的连接对话框中输入：
   - **服务器地址** — VNC 服务器 IP 或主机名
   - **端口** — 默认 5900（可输入显示编号自动计算）
   - **密码** — VNC 认证密码（可选）
2. 点击「连接」按钮
3. 连接成功后，可通过工具栏或快捷键操作

### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Cmd/Ctrl + N` | 新建连接 |
| `Cmd/Ctrl + D` | 断开连接 |
| `Cmd/Ctrl + 0` | 缩放至窗口 |
| `Cmd/Ctrl + 1` | 实际大小 |
| `Cmd/Ctrl + Shift + F` | 切换全屏 |

## 参考实现

- [UltraVNC](https://github.com/ultravnc/UltraVNC) — Windows 平台 VNC 客户端/服务器
- [RFC 6143](https://datatracker.ietf.org/doc/html/rfc6143) — The Remote Framebuffer Protocol
- [RealVNC RFB Protocol](https://help.realvnc.com/hc/en-us/articles/360002720337-RFB-protocol-specification)

## 许可证

[MIT](LICENSE) © higkoo