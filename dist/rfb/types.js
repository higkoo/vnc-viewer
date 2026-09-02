"use strict";
/**
 * RFB 协议类型定义
 * 参考: RFC 6143 - The Remote Framebuffer Protocol
 * 参考: UltraVNC 实现 (rfb/rfbproto.h)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.IPC_CHANNELS = exports.ConnectionState = exports.ServerMsgType = exports.ClientMsgType = exports.EncodingType = exports.SecurityType = exports.RFB_VERSIONS = void 0;
// ---- 协议版本 ----
exports.RFB_VERSIONS = ['003.003', '003.007', '003.008'];
// ---- 安全类型 ----
var SecurityType;
(function (SecurityType) {
    SecurityType[SecurityType["Invalid"] = 0] = "Invalid";
    SecurityType[SecurityType["None"] = 1] = "None";
    SecurityType[SecurityType["VncAuth"] = 2] = "VncAuth";
    SecurityType[SecurityType["RA2"] = 5] = "RA2";
    SecurityType[SecurityType["RA2ne"] = 6] = "RA2ne";
    SecurityType[SecurityType["Tight"] = 16] = "Tight";
    SecurityType[SecurityType["Ultra"] = 17] = "Ultra";
    SecurityType[SecurityType["TLS"] = 18] = "TLS";
    SecurityType[SecurityType["VeNCrypt"] = 19] = "VeNCrypt";
    SecurityType[SecurityType["GTK_VNC_SASL"] = 20] = "GTK_VNC_SASL";
    SecurityType[SecurityType["MD5"] = 21] = "MD5";
    SecurityType[SecurityType["ColinDeanXVP"] = 22] = "ColinDeanXVP";
    SecurityType[SecurityType["MSLogon"] = 129] = "MSLogon";
})(SecurityType || (exports.SecurityType = SecurityType = {}));
// ---- 编码类型 ----
var EncodingType;
(function (EncodingType) {
    EncodingType[EncodingType["Raw"] = 0] = "Raw";
    EncodingType[EncodingType["CopyRect"] = 1] = "CopyRect";
    EncodingType[EncodingType["RRE"] = 2] = "RRE";
    EncodingType[EncodingType["Hextile"] = 5] = "Hextile";
    EncodingType[EncodingType["ZRLE"] = 16] = "ZRLE";
    EncodingType[EncodingType["Cursor"] = 4294967056] = "Cursor";
    EncodingType[EncodingType["RichCursor"] = 4294967057] = "RichCursor";
    EncodingType[EncodingType["PointerPos"] = 4294967064] = "PointerPos";
    EncodingType[EncodingType["LastRect"] = 4294967072] = "LastRect";
    EncodingType[EncodingType["NewFBSize"] = 4294967073] = "NewFBSize";
    EncodingType[EncodingType["DesktopName"] = 4294967074] = "DesktopName";
    EncodingType[EncodingType["UltraVNC_Ext"] = 4294967288] = "UltraVNC_Ext";
})(EncodingType || (exports.EncodingType = EncodingType = {}));
// ---- 消息类型 (客户端→服务器) ----
var ClientMsgType;
(function (ClientMsgType) {
    ClientMsgType[ClientMsgType["SetPixelFormat"] = 0] = "SetPixelFormat";
    ClientMsgType[ClientMsgType["SetEncodings"] = 2] = "SetEncodings";
    ClientMsgType[ClientMsgType["FramebufferUpdateRequest"] = 3] = "FramebufferUpdateRequest";
    ClientMsgType[ClientMsgType["KeyEvent"] = 4] = "KeyEvent";
    ClientMsgType[ClientMsgType["PointerEvent"] = 5] = "PointerEvent";
    ClientMsgType[ClientMsgType["ClientCutText"] = 6] = "ClientCutText";
    ClientMsgType[ClientMsgType["FileTransfer"] = 7] = "FileTransfer";
    ClientMsgType[ClientMsgType["SetDesktopSize"] = 251] = "SetDesktopSize";
})(ClientMsgType || (exports.ClientMsgType = ClientMsgType = {}));
// ---- 消息类型 (服务器→客户端) ----
var ServerMsgType;
(function (ServerMsgType) {
    ServerMsgType[ServerMsgType["FramebufferUpdate"] = 0] = "FramebufferUpdate";
    ServerMsgType[ServerMsgType["SetColorMapEntries"] = 1] = "SetColorMapEntries";
    ServerMsgType[ServerMsgType["Bell"] = 2] = "Bell";
    ServerMsgType[ServerMsgType["ServerCutText"] = 3] = "ServerCutText";
    ServerMsgType[ServerMsgType["FileTransfer"] = 7] = "FileTransfer";
    ServerMsgType[ServerMsgType["DesktopSize"] = 251] = "DesktopSize";
})(ServerMsgType || (exports.ServerMsgType = ServerMsgType = {}));
// ---- 连接状态 ----
var ConnectionState;
(function (ConnectionState) {
    ConnectionState[ConnectionState["Disconnected"] = 0] = "Disconnected";
    ConnectionState[ConnectionState["Connecting"] = 1] = "Connecting";
    ConnectionState[ConnectionState["ProtocolVersion"] = 2] = "ProtocolVersion";
    ConnectionState[ConnectionState["Security"] = 3] = "Security";
    ConnectionState[ConnectionState["Authentication"] = 4] = "Authentication";
    ConnectionState[ConnectionState["ClientInit"] = 5] = "ClientInit";
    ConnectionState[ConnectionState["ServerInit"] = 6] = "ServerInit";
    ConnectionState[ConnectionState["Connected"] = 7] = "Connected";
    ConnectionState[ConnectionState["Error"] = 8] = "Error";
})(ConnectionState || (exports.ConnectionState = ConnectionState = {}));
// ---- IPC 通道 ----
exports.IPC_CHANNELS = {
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
};
//# sourceMappingURL=types.js.map