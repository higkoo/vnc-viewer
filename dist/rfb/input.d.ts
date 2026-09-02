/**
 * RFB 输入事件处理 (键盘/鼠标)
 * 参考 UltraVNC vncviewer 和 RFC 6143 Section 7.5
 */
import { RfbClient } from './client';
export declare class RfbInput {
    private client;
    private buttonMask;
    private static readonly KEY_MAP;
    constructor(client: RfbClient);
    /**
     * 发送键盘事件
     * 消息: 1-byte msg-type(4), 1-byte down-flag, 2-byte padding, 4-byte keysym
     */
    sendKeyEvent(keyCode: number, down: boolean): void;
    /**
     * 发送指针（鼠标）事件
     * 消息: 1-byte msg-type(5), 1-byte button-mask, 2-byte x, 2-byte y
     */
    sendPointerEvent(buttonMask: number, x: number, y: number): void;
    /**
     * 更新鼠标按键掩码
     */
    updateButtonMask(button: number, pressed: boolean): void;
    getButtonMask(): number;
    /**
     * 将键盘按键码映射为 RFB keysym
     */
    private mapKeyCode;
}
//# sourceMappingURL=input.d.ts.map