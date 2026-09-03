/**
 * RFB 协议类型定义
 * 参考: RFC 6143 - The Remote Framebuffer Protocol
 * 参考: UltraVNC 实现 (rfb/rfbproto.h)
 */

// ---- 协议版本 ----
export const RFB_VERSIONS = ['003.003', '003.007', '003.008'] as const;
export type RfbVersion = typeof RFB_VERSIONS[number];

// ---- 安全类型 ----
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
  MSLogon = 129,
}

// ---- 编码类型 ----
export enum EncodingType {
  Raw = 0,
  CopyRect = 1,
  RRE = 2,
  Hextile = 5,
  ZRLE = 16,
  Cursor = 0xFFFFFF10,       // 伪编码: 光标
  RichCursor = 0xFFFFFF11,   // 伪编码: 彩色光标
  PointerPos = 0xFFFFFF18,   // 伪编码: 指针位置
  LastRect = 0xFFFFFF20,     // 伪编码: 最后一个矩形
  NewFBSize = 0xFFFFFF21,    // 伪编码: 新帧缓冲大小
  DesktopName = 0xFFFFFF22,  // 伪编码: 桌面名称
  UltraVNC_Ext = 0xFFFFFFF8, // UltraVNC 扩展
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
  // 应用日志
  APP_LOG: 'app:log',
  LOG_GET: 'app:log:get',
  LOG_CLEAR: 'app:log:clear',
  // 设置
  GET_SETTINGS: 'app:settings:get',
  SET_SETTINGS: 'app:settings:set',
  MOBILE_PORT_CHANGED: 'app:mobile-port-changed',
} as const;