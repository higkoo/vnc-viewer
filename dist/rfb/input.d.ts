/**
 * RFB 输入事件处理 (键盘/鼠标)
 * 参考 bVNC RfbProto.java 的事件缓冲合并机制
 * 参考 RFC 6143 Section 7.5
 *
 * 增强点：
 * 1. 事件缓冲合并 — 合并修饰键+按键事件为单次 write，减少网络包
 * 2. 远程修饰键状态追踪 — 避免冗余发送已按下的修饰键
 * 3. 可配置缓冲窗口 — 平衡延迟与吞吐量
 */
import { RfbClient } from './client';
export declare class RfbInput {
    private client;
    private buttonMask;
    /**
     * 远程修饰键状态追踪（bVNC 模式）
     * 记录服务器端当前按下的修饰键，避免重复发送
     */
    private remoteModifiers;
    /**
     * 事件缓冲队列
     * 在缓冲窗口内合并多个事件后一次性发送
     */
    private eventBuffer;
    private flushTimer;
    private static readonly FLUSH_INTERVAL_MS;
    private static readonly KEY_MAP;
    /** 修饰键集合（用于快速判断） */
    private static readonly MODIFIER_KEYSYMS;
    constructor(client: RfbClient);
    /**
     * 发送键盘事件 — 带修饰键追踪和缓冲合并
     *
     * 参考 bVNC writeKeyEvent 逻辑：
     * 1. 如果是按键按下(down=true)：先更新修饰键状态，再发送按键
     * 2. 如果是按键释放(down=false)：先发送按键，再更新修饰键状态
     * 3. 所有事件进入缓冲队列，在缓冲窗口内合并发送
     */
    sendKeyEvent(keyCode: number, down: boolean): void;
    /**
     * 立即发送键盘事件（绕过缓冲，用于紧急按键如 Ctrl+Alt+Del）
     */
    sendKeyEventImmediate(keysym: number, down: boolean): void;
    /**
     * 将按键事件加入缓冲队列
     */
    private enqueueKeyEvent;
    /**
     * 将修饰键事件加入缓冲队列（带状态追踪，避免冗余）
     */
    private enqueueModifierKey;
    /**
     * 构建按键事件消息
     * 消息格式: 1-byte msg-type(4), 1-byte down-flag, 2-byte padding, 4-byte keysym
     */
    private buildKeyEventMessage;
    /**
     * 调度缓冲队列刷新
     */
    private scheduleFlush;
    /**
     * 刷新缓冲队列 — 合并所有事件为单次 write
     */
    flushEventBuffer(): void;
    /**
     * 清空缓冲队列（连接断开时调用）
     */
    clearEventBuffer(): void;
    /**
     * 重置远程修饰键状态（如重新连接后）
     */
    resetModifierState(): void;
    /**
     * 获取远程修饰键状态对应的 button mask
     * 用于指针事件携带当前修饰键状态
     */
    getModifierButtonMask(): number;
    /**
     * 发送指针（鼠标）事件
     * 消息: 1-byte msg-type(5), 1-byte button-mask, 2-byte x, 2-byte y
     */
    sendPointerEvent(buttonMask: number, x: number, y: number): void;
    /**
     * 发送指针事件（不携带修饰键 — 用于精确控制）
     */
    sendPointerEventRaw(buttonMask: number, x: number, y: number): void;
    /**
     * 更新鼠标按键掩码
     */
    updateButtonMask(button: number, pressed: boolean): void;
    getButtonMask(): number;
    /**
     * 获取远程修饰键状态 (keysym 集合)
     */
    getRemoteModifiers(): Set<number>;
    /**
     * 将键盘按键码映射为 RFB keysym
     */
    private mapKeyCode;
}
//# sourceMappingURL=input.d.ts.map