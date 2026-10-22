# VNC Viewer

跨平台 VNC 查看器，参考 [UltraVNC](https://github.com/ultravnc/UltraVNC) 实现，优先支持 macOS。桌面端使用 Electron + TypeScript，手机端通过浏览器 WebSocket 代理连接远程桌面。

## 功能特性

- **RFB 协议** — 支持 RFB 3.3/3.7/3.8 协议版本
- **多种认证** — VNC 认证（DES 挑战-响应）、None 认证、MSLogon I/II（112/113，明文用户名+密码）
- **编码支持** — Raw、CopyRect、RRE、CoRRE（UltraVNC 紧凑变体）、Hextile（含 UltraVNC zlib 压缩 tile 扩展）、ZRLE（Zlib 解压）
- **伪编码** — 光标（单色：2 CPIXEL + mask）、RichCursor（像素 + mask）、PointerPos、LastRect、NewFBSize、DesktopName
- **扩展剪贴板** — UltraVNC Extended Clipboard（flags + data 格式）
- **输入转发** — 键盘事件（X11 Keysym 映射）、鼠标事件（5 键+滚轮）
- **Canvas 渲染** — 高性能像素渲染，支持缩放适配/实际大小
- **窗口自适应** — 远端画面随窗口双向缩放适配；也可一键让窗口按远端分辨率调整大小（1:1 像素映射）
- **macOS 原生** — 原生菜单栏、全屏模式、深色主题、Retina 支持
- **跨平台** — 基于 Electron，可在 macOS / Windows / Linux 运行
- **手机支持** — 内置 WebSocket 代理服务器，手机浏览器可直接连接和操控远程桌面

## UltraVNC 反编译重构（REA + Ghidra）

协议层细节经 REA（Ghidra 12.1.4）反编译 `UltraVNC vncviewer.exe`（x64 PE）逐项核对，
关键结论已落地到 `src/rfb/` 与 `src/mobile/`（两端逻辑保持一致）：

| 项目 | 反编译结论 | 重构内容 |
|------|-----------|---------|
| 编码值 | CoRRE=4、Zlib=6、Tight=7、ZlibHex=8、Ultra=9/10、ZYWRLE=17、XZ=18/19、ZSTD=25~29 | 修正 `TightZstd` 17→26（17 实为 ZYWRLE），补齐 CoRRE 及 UltraVNC 编码族 |
| CoRRE 格式 | UltraVNC 变体：计数(4)+背景(bpp)+[像素(bpp)+x/y/w/h 各 1 字节]，无 zlib（RFC 6143 的 zlib+2 字节坐标格式不被支持，已做检测拒绝） | 新增 CoRRE 解码器（桌面+移动） |
| Hextile | UltraVNC 扩展子编码 0x20（zlib 原始像素 tile）/0x40（zlib 标准 tile），后跟 2 字节压缩长度 | Hextile 解码器支持扩展子编码 |
| 安全类型 | MSLogon=112/113（非 129）；129/130 为 RSA-AES 变体；结果码 0xFFFFFFFF=继续协商下一类型、0xFFFFFFFA=尝试过多 | 修正安全类型枚举与优先级表，认证结果完整处理 |
| 认证失败 | RFB 3.7+ 失败附 4 字节原因长度+文本（原子性读取） | 修正扩展失败原因解析 |
| Cursor 伪编码 | 单色光标 = 2 个 CPIXEL（前/背景）+ mask；RichCursor = 像素 + mask | 修正单色光标解析（旧实现误按像素+mask） |
| 扩展剪贴板 | 载荷 = flags(4, BE) + data，**无内层长度字段** | 修正 ServerCutText 扩展格式解析 |
| RRE | 子矩形坐标为 2 字节大端（RFC 6143） | 修正移动端 RRE（旧实现误用 1 字节） |
| ZRLE | tileType 低 7 位=调色板大小、bit7=RLE；打包调色板逐行字节对齐 | 重写移动端 ZRLE（旧实现 tileType 映射错误） |
| 版本协商 | UltraVNC 另支持 minor 14/16/18（安全类型列表 4 字节计数） | 统一回退 3.8（兼容性更好），已注释说明 |

> UltraVNC 专属的 DSM 插件加密、SecureVNC 插件、文件传输等依赖 Windows 专有组件，
> 多平台项目不予移植（保持纯协议层跨平台）。

## 项目架构

```
vnc-viewer/
├── src/
│   ├── main/              # Electron 主进程
│   │   ├── main.ts        #   窗口管理、IPC 通信、手机代理服务器启动
│   │   └── preload.ts     #   安全桥接（contextBridge）
│   ├── renderer/          # 渲染进程（桌面端 UI）
│   │   ├── index.html     #   主界面
│   │   ├── styles/main.css #  macOS 深色风格样式
│   │   └── app.ts         #   UI 逻辑（Canvas 渲染、输入处理）
│   ├── server/            # 手机代理服务器
│   │   └── mobileServer.ts#   WebSocket-to-TCP 代理
│   ├── mobile/            # 移动端 Web 页面
│   │   └── index.html     #   触屏优化的 VNC 查看器（含内嵌 RFB 客户端）
│   └── rfb/               # RFB 协议实现
│       ├── types.ts       #   类型定义（RFC 6143）
│       ├── client.ts      #   RFB 客户端核心
│       ├── handshake.ts   #   握手和认证
│       ├── des.ts         #   纯 JS DES（VNC 认证，兼容 OpenSSL 3）
│       ├── encodings.ts   #   编码解码器
│       └── input.ts       #   键盘/鼠标事件映射
├── scripts/
│   └── copy-assets.js     # 构建后复制 HTML/CSS 到 dist（tsc 不会复制）
├── dist/                  # TypeScript 编译输出
├── package.json
└── tsconfig.json
```

## 架构流程

```
┌─────────────────────────────────────────────────────────┐
│ 桌面端 (Electron)                                        │
│  ┌──────────┐    IPC    ┌────────────┐    TCP    ┌─────┐│
│  │ 渲染进程  │◄────────►│  主进程    │◄─────────►│ VNC ││
│  │ Canvas   │           │ RfbClient  │           │ 服务器││
│  └──────────┘           └────────────┘           └─────┘│
│                         ┌────────────┐                   │
│                         │ MobileServer│── WebSocket ──┐   │
│                         │ :5933      │               │   │
│                         └────────────┘               │   │
└───────────────────────────────────────────────────────┼───┘
                                                        │
┌───────────────────────────────────────────────────────┘
│ 手机浏览器
│  ┌──────────────────┐
│  │ Mobile RFB Client│── WebSocket ──► MobileServer ──TCP──► VNC 服务器
│  │ (纯 JS, 内嵌)    │
│  └──────────────────┘
```

## 技术栈

| 层 | 技术 | 说明 |
|---|------|------|
| 桌面框架 | Electron | 跨平台桌面应用 |
| 协议层 | Node.js `net` | TCP 连接、RFB 协议 |
| 渲染层 | Canvas 2D API | 像素数据渲染 |
| 语言 | TypeScript | 全栈类型安全 |
| 编码 | Node.js `zlib` | ZRLE 解压（桌面端） |
| 认证 | 纯 JS DES（`src/rfb/des.ts`） | VNC 挑战-响应加密；OpenSSL 3（Node 17+）已禁用 `crypto` 的 DES（桌面端） |
| WebSocket | `ws` | 手机代理服务器 WebSocket 支持 |
| 浏览器解压 | `pako` | 手机端 ZRLE 解压 |
| 浏览器 DES | 纯 JS 实现 | 手机端 VNC 认证 |

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

### 桌面端

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
| `Cmd/Ctrl + 2` | 窗口适应远端（按远端分辨率调整窗口） |
| `Cmd/Ctrl + Shift + F` | 切换全屏 |

### 手机连接

启动应用后，应用会自动启动手机代理服务器（默认端口 5933）。

**使用步骤：**

1. 确保手机和电脑在同一个局域网
2. 在电脑上启动 VNC Viewer
3. 在电脑菜单栏中选择「手机」→「显示手机连接信息」
4. 在手机浏览器中打开显示的地址（如 `http://192.168.1.100:5933`）
5. 输入 VNC 服务器地址和密码，点击「连接」

**手机端特性：**

- 触屏优化界面，支持双指缩放
- 虚拟键盘面板（Ctrl+Alt+Del、F1-F12、修饰键等）
- 缩放适应/实际大小切换
- 横竖屏自适应
- 纯前端 RFB 协议实现（无需安装任何 App）

## 目录说明

| 目录 | 用途 |
|------|------|
| `src/main/` | Electron 主进程，窗口管理、IPC 通信 |
| `src/renderer/` | 桌面端 UI，Canvas 渲染 |
| `src/rfb/` | 桌面端 RFB 协议实现 |
| `src/server/` | 手机代理服务器（WebSocket ↔ TCP） |
| `src/mobile/` | 手机端 Web 页面（内嵌 RFB 客户端） |

## 平台验证状态

| 平台 | 状态 | 验证版本 | 说明 |
|------|------|----------|------|
| macOS (Apple Silicon) | ✅ 已验证 | 0.1.1 | RFB 3.8 + VncAuth 认证、ZRLE/RRE 解码、画面渲染均正常 |
| Windows (x64) | ✅ 已验证 | 0.1.0 | 修复连接后界面无响应 |
| Linux | ⏳ 待验证 | — | 基于 Electron，理论支持 |

## 版本历史

### 0.1.2

- 窗口自适应功能：
  - 「缩放至窗口」改为双向自适应：窗口小于远端时缩小、大于远端时放大，始终保持纵横比完整显示
  - 新增「窗口适应远端」（Ctrl+2 / 工具栏按钮）：窗口内容区按远端分辨率调整，实现 1:1 像素映射；超出屏幕时自动裁剪到工作区并居中

### 0.1.1

- macOS (Apple Silicon) 实机验证通过：连接 `dify:5900`（RFB 3.8 + VncAuth），DES 挑战-响应认证、ZRLE/RRE 全量解码、1280×800 画面渲染均正常，连续运行无停滞
- 确认 0.1.0 的关键修复在 macOS 同样生效（preload 沙箱内联常量、纯 JS DES、构建资源复制）
- README 修正：手机代理默认端口 5800 → 5933；DES 认证实现说明更新为纯 JS；项目架构补充 `des.ts` / `scripts/copy-assets.js`

### 0.1.0

- 修复 Windows 版连接后界面无响应：
  - 新增纯 JS DES 实现（OpenSSL 3 默认禁用 DES，原 `crypto.createCipheriv('des-ecb')` 认证必崩）
  - preload 内联 IPC 通道常量（Electron 20+ 沙箱禁止 require 项目文件）
  - 伪编码判定改用无符号读取；SetEncodings 用 `writeUInt32BE` 写入
  - 支持 numRects=0xFFFF 持续更新模式与 LastRect 终止标记
  - ZRLE 解码器全面修复（CPIXEL 动态尺寸、调色板位打包、跨矩形 zlib 流复用）
  - 构建流程新增 `scripts/copy-assets.js` 同步静态资源

## 参考实现

- [UltraVNC](https://github.com/ultravnc/UltraVNC) — Windows 平台 VNC 客户端/服务器
- [RFC 6143](https://datatracker.ietf.org/doc/html/rfc6143) — The Remote Framebuffer Protocol
- [RealVNC RFB Protocol](https://help.realvnc.com/hc/en-us/articles/360002720337-RFB-protocol-specification)

## 许可证

[MIT](LICENSE) © higkoo