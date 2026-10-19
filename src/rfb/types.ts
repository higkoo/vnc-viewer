/**
 * RFB 协议类型定义
 * 参考: RFC 6143 - The Remote Framebuffer Protocol
 * 参考: UltraVNC 实现 (rfb/rfbproto.h)
 */

// ---- 协议版本 ----
export const RFB_VERSIONS = ['003.003', '003.007', '003.008'] as const;
export type RfbVersion = typeof RFB_VERSIONS[number];

// ---- 安全类型 ----
// 线缆值经 REA 反编译 UltraVNC vncviewer.exe 的 AuthSecurityType switch 核对：
//   0=Invalid, 1=None, 2=VncAuth, 5=RA2, 6=RA2ne, 16=Tight, 17=Ultra(DSM),
//   18=TLS, 19=VeNCrypt, 104/105=UltraVNC 扩展, 112=UltraVNC VNC 认证+用户名
//   (AuthMsLogonI), 113=MSLogon II(时间戳挑战), 114/115=SecureVNC 插件,
//   129/130=RSA-AES(256 位变体), 256=Plain(VeNCrypt 子类型)
// 注意：MSLogon 实际是 112/113（旧实现误作 129）。
export enum SecurityType {
  Invalid = 0,
  None = 1,
  VncAuth = 2,
  RA2 = 5,
  RA2ne = 6,
  Tight = 16,
  Ultra = 17,
  TLS = 18,
  VeNCrypt = 19,
  GTK_VNC_SASL = 20,
  MD5 = 21,
  ColinDeanXVP = 22,
  UltraVNC_Ext = 104,        // UltraVNC 服务器扩展认证
  UltraVNC_Dialog = 105,     // UltraVNC 对话框认证（发送 4 字节结果）
  MSLogonI = 112,            // UltraVNC VNC 认证 + 用户名（旧实现缺失）
  MSLogonII = 113,           // UltraVNC MSLogon II（时间戳挑战）
  SecureVNC = 114,           // SecureVNC 插件 (RSA)
  SecureVNC_ne = 115,        // SecureVNC 插件 (ne)
  RSAAES256 = 129,           // RSA-AES 256 位变体（旧实现误标为 MSLogon）
  RSAAES256_ne = 130,
  Plain = 256,      // VeNCrypt Plain 子类型 (UltraVNC 扩展)
}

// ---- 编码类型 ----
// 线缆值经 REA 反编译 UltraVNC vncviewer.exe (x64 PE) 逐项核对：
//   Raw=0, CopyRect=1, RRE=2, CoRRE=4, Hextile=5, Zlib=6, Tight=7,
//   ZlibHex=8, Ultra=9, Ultra2=10, ZRLE=16, ZYWRLE=17, XZ=18, XZYW=19,
//   ZSTD=25, TightZstd=26, ZstdHex=27, ZSTDRLE=28, ZSTDYWRLE=29
// 注意：17 是 ZYWRLE 而非 TightZstd（旧实现误作 TightZstd，已修正）；
//       CoRRE=4 为 RFC 6143 标准编码，旧实现缺失，已补齐。
export enum EncodingType {
  Raw = 0,
  CopyRect = 1,
  RRE = 2,
  CoRRE = 4,
  Hextile = 5,
  Zlib = 6,
  Tight = 7,
  ZlibHex = 8,
  Ultra = 9,          // UltraVNC 私有编码（子矩形 + zlib）
  Ultra2 = 10,        // UltraVNC 私有编码
  ZRLE = 16,
  ZYWRLE = 17,        // TightVNC ZYWRLE（旧实现误占为 TightZstd）
  XZ = 18,            // UltraVNC Tight+XZ
  XZYW = 19,          // UltraVNC Tight+XZ+ZYWRLE
  ZSTD = 25,          // UltraVNC Tight+Zstd（旧实现误作 17）
  TightZstd = 26,     // Tight + Zstd
  ZstdHex = 27,
  ZSTDRLE = 28,
  ZSTDYWRLE = 29,
  // ---- 伪编码（负值）----
  Cursor = 0xFFFFFF10,       // 伪编码: 单色光标（2 个 CPIXEL + mask）
  RichCursor = 0xFFFFFF11,   // 伪编码: 彩色光标（像素 + mask）
  PointerPos = 0xFFFFFF18,   // 伪编码: 指针位置
  LastRect = 0xFFFFFF20,     // 伪编码: 最后一个矩形
  NewFBSize = 0xFFFFFF21,    // 伪编码: 分辨率变化
  DesktopName = 0xFFFFFF22,  // 伪编码: 桌面名称
  // ---- UltraVNC 扩展伪编码 ----
  UltraVNC_ServerScale = 0xFFFFFECD,   // -307: 单窗口缩放（坐标除以缩放因子）
  ExtendedDesktopSize = 0xFFFFFECC,    // -308: 扩展桌面大小（屏幕布局）
  // UltraVNC "Cache" 系列伪编码（Ultra 编码带缓存变体）
  Ultra_Cache = 0xFFFF0008,
  Ultra2_Cache = 0xFFFF0009,
  // Extended Clipboard 伪编码
  ExtClipboard_Caps = 0xFFFFFEC0,
  ExtClipboard_Request = 0xFFFFFEC1,
  ExtClipboard_Peek = 0xFFFFFEC2,
  ExtClipboard_Notify = 0xFFFFFEC3,
}

// ---- 安全结果码 (SecurityResult, RFB 3.7+ 为 4 字节大端) ----
// 经 REA 反编译 UltraVNC vncviewer.exe 核对：
//   0=OK; 1/2/3=失败; 0xFFFFFFFF=服务端要求继续尝试列表中的下一个安全类型;
//   0xFFFFFFFA=尝试次数过多。RFB < 3.7 时失败不附带原因文本。
export enum SecurityResult {
  Ok = 0,
  Failed = 1,
  FailedTooMany = 2,       // RFB 3.3 语义：过多尝试
  FailedLegacy = 3,        // 旧版失败码
  Continue = 0xFFFFFFFF,   // 继续协商下一个安全类型
  TooManyTries = 0xFFFFFFFA,
}

// ---- 消息类型 (客户端→服务器) ----
export enum ClientMsgType {
  SetPixelFormat = 0,
  SetEncodings = 2,
  FramebufferUpdateRequest = 3,
  KeyEvent = 4,
  PointerEvent = 5,
  ClientCutText = 6,
  FileTransfer = 7,         // UltraVNC 扩展
  SetDesktopSize = 251,     // 扩展
}

// ---- 消息类型 (服务器→客户端) ----
export enum ServerMsgType {
  FramebufferUpdate = 0,
  SetColorMapEntries = 1,
  Bell = 2,
  ServerCutText = 3,
  FileTransfer = 7,         // UltraVNC 扩展
  DesktopSize = 251,        // 扩展
  ClientRedirect = 252,     // 扩展: 服务器重定向
}

// ---- 像素格式 ----
export interface PixelFormat {
  bitsPerPixel: number;
  depth: number;
  bigEndian: boolean;
  trueColor: boolean;
  redMax: number;
  greenMax: number;
  blueMax: number;
  redShift: number;
  greenShift: number;
  blueShift: number;
}

// ---- 帧缓冲更新矩形 ----
export interface FramebufferRect {
  x: number;
  y: number;
  width: number;
  height: number;
  encoding: EncodingType;
  data: Buffer;
}

// ---- 服务器初始化信息 ----
export interface ServerInitInfo {
  framebufferWidth: number;
  framebufferHeight: number;
  pixelFormat: PixelFormat;
  nameLength: number;
  name: string;
}

// ---- 连接参数 ----
export interface ConnectionParams {
  host: string;
  port: number;
  password?: string;
  shared: boolean;
}

// ---- 连接状态 ----
export enum ConnectionState {
  Disconnected = 0,
  Connecting = 1,
  ProtocolVersion = 2,
  Security = 3,
  Authentication = 4,
  ClientInit = 5,
  ServerInit = 6,
  Connected = 7,
  Error = 8,
}

// ---- IPC 通道 ----
export const IPC_CHANNELS = {
  CONNECT: 'rfb:connect',
  DISCONNECT: 'rfb:disconnect',
  KEY_EVENT: 'rfb:key-event',
  POINTER_EVENT: 'rfb:pointer-event',
  CUT_TEXT: 'rfb:cut-text',
  FRAMEBUFFER_UPDATE: 'rfb:framebuffer-update',
  CONNECTION_STATE: 'rfb:connection-state',
  SERVER_INFO: 'rfb:server-info',
  BELL: 'rfb:bell',
  CLIPBOARD: 'rfb:clipboard',
  ERROR: 'rfb:error',
  SET_ENCODINGS: 'rfb:set-encodings',
  SET_PIXEL_FORMAT: 'rfb:set-pixel-format',
  SET_DESKTOP_SIZE: 'rfb:request-desktop-size',
  // 带宽统计
  BANDWIDTH: 'rfb:bandwidth',
  // 服务器重定向
  REDIRECT: 'rfb:redirect',
  // 应用日志
  APP_LOG: 'app:log',
  LOG_GET: 'app:log:get',
  LOG_CLEAR: 'app:log:clear',
  // 设置
  GET_SETTINGS: 'app:settings:get',
  SET_SETTINGS: 'app:settings:set',
  MOBILE_PORT_CHANGED: 'app:mobile-port-changed',
} as const;