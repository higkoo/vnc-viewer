/**
 * RFB 协议类型定义
 * 参考: RFC 6143 - The Remote Framebuffer Protocol
 * 参考: UltraVNC 实现 (rfb/rfbproto.h)
 */
export declare const RFB_VERSIONS: readonly ["003.003", "003.007", "003.008"];
export type RfbVersion = typeof RFB_VERSIONS[number];
export declare enum SecurityType {
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
    MSLogon = 129
}
export declare enum EncodingType {
    Raw = 0,
    CopyRect = 1,
    RRE = 2,
    Hextile = 5,
    ZRLE = 16,
    Cursor = 4294967056,// 伪编码: 光标
    RichCursor = 4294967057,// 伪编码: 彩色光标
    PointerPos = 4294967064,// 伪编码: 指针位置
    LastRect = 4294967072,// 伪编码: 最后一个矩形
    NewFBSize = 4294967073,// 伪编码: 新帧缓冲大小
    DesktopName = 4294967074,// 伪编码: 桌面名称
    UltraVNC_Ext = 4294967288
}
export declare enum ClientMsgType {
    SetPixelFormat = 0,
    SetEncodings = 2,
    FramebufferUpdateRequest = 3,
    KeyEvent = 4,
    PointerEvent = 5,
    ClientCutText = 6,
    FileTransfer = 7,// UltraVNC 扩展
    SetDesktopSize = 251
}
export declare enum ServerMsgType {
    FramebufferUpdate = 0,
    SetColorMapEntries = 1,
    Bell = 2,
    ServerCutText = 3,
    FileTransfer = 7,// UltraVNC 扩展
    DesktopSize = 251
}
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
export interface FramebufferRect {
    x: number;
    y: number;
    width: number;
    height: number;
    encoding: EncodingType;
    data: Buffer;
}
export interface ServerInitInfo {
    framebufferWidth: number;
    framebufferHeight: number;
    pixelFormat: PixelFormat;
    nameLength: number;
    name: string;
}
export interface ConnectionParams {
    host: string;
    port: number;
    password?: string;
    shared: boolean;
}
export declare enum ConnectionState {
    Disconnected = 0,
    Connecting = 1,
    ProtocolVersion = 2,
    Security = 3,
    Authentication = 4,
    ClientInit = 5,
    ServerInit = 6,
    Connected = 7,
    Error = 8
}
export declare const IPC_CHANNELS: {
    readonly CONNECT: "rfb:connect";
    readonly DISCONNECT: "rfb:disconnect";
    readonly KEY_EVENT: "rfb:key-event";
    readonly POINTER_EVENT: "rfb:pointer-event";
    readonly CUT_TEXT: "rfb:cut-text";
    readonly FRAMEBUFFER_UPDATE: "rfb:framebuffer-update";
    readonly CONNECTION_STATE: "rfb:connection-state";
    readonly SERVER_INFO: "rfb:server-info";
    readonly BELL: "rfb:bell";
    readonly CLIPBOARD: "rfb:clipboard";
    readonly ERROR: "rfb:error";
    readonly SET_ENCODINGS: "rfb:set-encodings";
    readonly SET_PIXEL_FORMAT: "rfb:set-pixel-format";
    readonly SET_DESKTOP_SIZE: "rfb:request-desktop-size";
};
//# sourceMappingURL=types.d.ts.map