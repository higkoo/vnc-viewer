/**
 * VNC Viewer 渲染进程 - UI 逻辑
 * 参考 UltraVNC vncviewer 界面设计
 */
interface VncApi {
    connect: (params: any) => Promise<any>;
    disconnect: () => Promise<any>;
    keyEvent: (keyCode: number, down: boolean) => Promise<any>;
    pointerEvent: (buttonMask: number, x: number, y: number) => Promise<any>;
    sendCutText: (text: string) => Promise<any>;
    onFramebufferUpdate: (callback: (rect: any) => void) => void;
    onConnectionState: (callback: (state: number) => void) => void;
    onServerInfo: (callback: (info: any) => void) => void;
    onError: (callback: (msg: string) => void) => void;
    onBell: (callback: () => void) => void;
    onClipboard: (callback: (text: string) => void) => void;
    onDesktopSize: (callback: (size: any) => void) => void;
    onMenuNewConnection: (callback: () => void) => void;
    onMenuDisconnect: (callback: () => void) => void;
    onMenuToggleFullscreen: (callback: () => void) => void;
    onMenuExitFullscreen: (callback: () => void) => void;
    onMenuZoomFit: (callback: () => void) => void;
    onMenuZoom100: (callback: () => void) => void;
}
declare var vncApi: VncApi;
declare enum ConnectionState {
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
declare function getEl<T extends HTMLElement>(id: string): T;
declare const dialog: HTMLDivElement;
declare const hostInput: HTMLInputElement;
declare const portInput: HTMLInputElement;
declare const displayInput: HTMLInputElement;
declare const passwordInput: HTMLInputElement;
declare const sharedCheck: HTMLInputElement;
declare const connectBtn: HTMLButtonElement;
declare const errorMsg: HTMLDivElement;
declare const statusBar: HTMLDivElement;
declare const statusIndicator: HTMLSpanElement;
declare const statusText: HTMLSpanElement;
declare const serverInfoText: HTMLSpanElement;
declare const qualityText: HTMLSpanElement;
declare const zoomText: HTMLSpanElement;
declare const toolbarEl: HTMLDivElement;
declare const canvas: HTMLCanvasElement;
declare const emptyState: HTMLDivElement;
declare const viewport: HTMLDivElement;
declare const btnNewConn: HTMLButtonElement;
declare const btnDisconnect: HTMLButtonElement;
declare const btnZoomFit: HTMLButtonElement;
declare const btnZoom100: HTMLButtonElement;
declare const btnFullscreen: HTMLButtonElement;
declare const btnCtrlAltDel: HTMLButtonElement;
declare const btnClipboard: HTMLButtonElement;
declare let isConnected: boolean;
declare let isFullscreen: boolean;
declare let zoomLevel: number;
declare let zoomMode: 'fit' | '100';
declare let fbWidth: number;
declare let fbHeight: number;
declare let fbCanvas: ImageData | null;
declare let mouseButtonMask: number;
declare let lastMouseX: number;
declare let lastMouseY: number;
declare let isPointerInside: boolean;
declare let currentState: ConnectionState;
declare function init(): void;
declare function setupEventListeners(): void;
declare function setupIPCListeners(): void;
declare function handleConnect(): void;
declare function handleDisconnect(): void;
declare function showConnectionDialog(): void;
declare function setupCanvas(): void;
declare function applyZoomFit(): void;
declare function setZoomMode(mode: 'fit' | '100'): void;
declare function setupCanvasResize(): void;
declare function renderRect(rect: {
    x: number;
    y: number;
    width: number;
    height: number;
    data: number[] | Buffer;
    encoding: number;
}): void;
declare function handleMouseDown(e: MouseEvent): void;
declare function handleMouseUp(e: MouseEvent): void;
declare function handleMouseMove(e: MouseEvent): void;
declare function handleMouseWheel(e: WheelEvent): void;
declare function getCanvasPosition(e: MouseEvent): {
    x: number;
    y: number;
};
declare function handleKeyDown(e: KeyboardEvent): void;
declare function handleKeyUp(e: KeyboardEvent): void;
declare function sendCtrlAltDel(): void;
declare function toggleFullscreen(): void;
declare function exitFullscreen(): void;
declare function updateStatusBar(state: number): void;
//# sourceMappingURL=app.d.ts.map