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
import { ClientMsgType } from './types';

/**
 * 修饰键的 RFB keysym 定义
 * 用于追踪远程修饰键状态，避免冗余发送
 */
const ModifierKeys = {
  Shift_L: 0xFFE1,
  Shift_R: 0xFFE2,
  Control_L: 0xFFE3,
  Control_R: 0xFFE4,
  Alt_L: 0xFFE9,
  Alt_R: 0xFFE7,
  Meta_L: 0xFFEB,
  Meta_R: 0xFFEC,
  Super_L: 0xFFEB,
  Super_R: 0xFFEC,
} as const;

/** 从 keysym 到 button mask bit 的映射（供指针事件修饰键使用） */
const ModifierToButtonMask: Record<number, number> = {
  [ModifierKeys.Shift_L]: 1 << 0,
  [ModifierKeys.Shift_R]: 1 << 0,
  [ModifierKeys.Control_L]: 1 << 2,
  [ModifierKeys.Control_R]: 1 << 2,
  [ModifierKeys.Alt_L]: 1 << 3,
  [ModifierKeys.Alt_R]: 1 << 3,
  [ModifierKeys.Meta_L]: 1 << 6,
  [ModifierKeys.Meta_R]: 1 << 6,
};

export class RfbInput {
  private client: RfbClient;

  // 鼠标按键状态
  private buttonMask: number = 0;

  /**
   * 远程修饰键状态追踪（bVNC 模式）
   * 记录服务器端当前按下的修饰键，避免重复发送
   */
  private remoteModifiers: Set<number> = new Set();

  /**
   * 事件缓冲队列
   * 在缓冲窗口内合并多个事件后一次性发送
   */
  private eventBuffer: Buffer[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly FLUSH_INTERVAL_MS = 8; // ~120Hz 的刷新率

  // X11 键码映射 (keyCode -> RFB keysym)
  private static readonly KEY_MAP: Record<number, number> = {
    // 字母
    65: 0x41,   // A
    66: 0x42,   // B
    67: 0x43,   // C
    68: 0x44,   // D
    69: 0x45,   // E
    70: 0x46,   // F
    71: 0x47,   // G
    72: 0x48,   // H
    73: 0x49,   // I
    74: 0x4A,   // J
    75: 0x4B,   // K
    76: 0x4C,   // L
    77: 0x4D,   // M
    78: 0x4E,   // N
    79: 0x4F,   // O
    80: 0x50,   // P
    81: 0x51,   // Q
    82: 0x52,   // R
    83: 0x53,   // S
    84: 0x54,   // T
    85: 0x55,   // U
    86: 0x56,   // V
    87: 0x57,   // W
    88: 0x58,   // X
    89: 0x59,   // Y
    90: 0x5A,   // Z

    // 数字
    48: 0x30,   // 0
    49: 0x31,   // 1
    50: 0x32,   // 2
    51: 0x33,   // 3
    52: 0x34,   // 4
    53: 0x35,   // 5
    54: 0x36,   // 6
    55: 0x37,   // 7
    56: 0x38,   // 8
    57: 0x39,   // 9

    // 功能键
    112: 0xFFBE, // F1
    113: 0xFFBF, // F2
    114: 0xFFC0, // F3
    115: 0xFFC1, // F4
    116: 0xFFC2, // F5
    117: 0xFFC3, // F6
    118: 0xFFC4, // F7
    119: 0xFFC5, // F8
    120: 0xFFC6, // F9
    121: 0xFFC7, // F10
    122: 0xFFC8, // F11
    123: 0xFFC9, // F12

    // 控制键
    8: 0xFF08,  // Backspace
    9: 0xFF09,  // Tab
    13: 0xFF0D, // Enter
    16: 0xFFE1, // Shift (左)
    17: 0xFFE3, // Control (左)
    18: 0xFFE9, // Alt (左)
    20: 0xFFE5, // CapsLock
    27: 0xFF1B, // Escape
    32: 0x0020, // Space
    33: 0xFF55, // PageUp
    34: 0xFF56, // PageDown
    35: 0xFF57, // End
    36: 0xFF50, // Home
    37: 0xFF51, // Left Arrow
    38: 0xFF52, // Up Arrow
    39: 0xFF53, // Right Arrow
    40: 0xFF54, // Down Arrow
    45: 0xFF63, // Insert
    46: 0xFFFF, // Delete
    91: 0xFFEB, // Meta (左)
    93: 0xFF67, // Menu
    144: 0xFF7F, // NumLock
    145: 0xFF14, // ScrollLock
    186: 0x3B,  // ;
    187: 0x3D,  // =
    188: 0x2C,  // ,
    189: 0x2D,  // -
    190: 0x2E,  // .
    191: 0x2F,  // /
    192: 0x60,  // `
    219: 0x5B,  // [
    220: 0x5C,  // backslash
    221: 0x5D,  // ]
    222: 0x27,  // '

    // 小键盘
    96: 0xFFB0,  // KP_0
    97: 0xFFB1,  // KP_1
    98: 0xFFB2,  // KP_2
    99: 0xFFB3,  // KP_3
    100: 0xFFB4, // KP_4
    101: 0xFFB5, // KP_5
    102: 0xFFB6, // KP_6
    103: 0xFFB7, // KP_7
    104: 0xFFB8, // KP_8
    105: 0xFFB9, // KP_9
    106: 0xFFAA, // KP_Multiply
    107: 0xFFAB, // KP_Add
    109: 0xFFAD, // KP_Subtract
    110: 0xFFAE, // KP_Decimal
    111: 0xFFAF, // KP_Divide
  };

  /** 修饰键集合（用于快速判断） */
  private static readonly MODIFIER_KEYSYMS = new Set<number>([
    ModifierKeys.Shift_L, ModifierKeys.Shift_R,
    ModifierKeys.Control_L, ModifierKeys.Control_R,
    ModifierKeys.Alt_L, ModifierKeys.Alt_R,
    ModifierKeys.Meta_L, ModifierKeys.Meta_R,
    0xFFE5, // CapsLock
    0xFF7F, // NumLock
    0xFF14, // ScrollLock
  ]);

  constructor(client: RfbClient) {
    this.client = client;
  }

  /**
   * 发送键盘事件 — 带修饰键追踪和缓冲合并
   *
   * 参考 bVNC writeKeyEvent 逻辑：
   * 1. 如果是按键按下(down=true)：先更新修饰键状态，再发送按键
   * 2. 如果是按键释放(down=false)：先发送按键，再更新修饰键状态
   * 3. 所有事件进入缓冲队列，在缓冲窗口内合并发送
   */
  sendKeyEvent(keyCode: number, down: boolean): void {
    const keysym = this.mapKeyCode(keyCode);
    if (keysym === 0) return;

    const isModifier = RfbInput.MODIFIER_KEYSYMS.has(keysym);

    if (down) {
      // 按下事件：先更新修饰键，再发送按键
      if (isModifier) {
        this.enqueueModifierKey(keysym, true);
      }
      this.enqueueKeyEvent(keysym, true);
    } else {
      // 释放事件：先发送按键，再更新修饰键
      this.enqueueKeyEvent(keysym, false);
      if (isModifier) {
        this.enqueueModifierKey(keysym, false);
      }
    }
  }

  /**
   * 立即发送键盘事件（绕过缓冲，用于紧急按键如 Ctrl+Alt+Del）
   */
  sendKeyEventImmediate(keysym: number, down: boolean): void {
    // 先刷新缓冲队列，保证事件顺序
    this.flushEventBuffer();
    const msg = this.buildKeyEventMessage(keysym, down);
    this.client.send(msg);
  }

  /**
   * 将按键事件加入缓冲队列
   */
  private enqueueKeyEvent(keysym: number, down: boolean): void {
    const msg = this.buildKeyEventMessage(keysym, down);
    this.eventBuffer.push(msg);
    this.scheduleFlush();
  }

  /**
   * 将修饰键事件加入缓冲队列（带状态追踪，避免冗余）
   */
  private enqueueModifierKey(keysym: number, down: boolean): void {
    if (down) {
      if (this.remoteModifiers.has(keysym)) return; // 已按下，跳过
      this.remoteModifiers.add(keysym);
    } else {
      if (!this.remoteModifiers.has(keysym)) return; // 已释放，跳过
      this.remoteModifiers.delete(keysym);
    }

    const msg = this.buildKeyEventMessage(keysym, down);
    this.eventBuffer.push(msg);
    this.scheduleFlush();
  }

  /**
   * 构建按键事件消息
   * 消息格式: 1-byte msg-type(4), 1-byte down-flag, 2-byte padding, 4-byte keysym
   */
  private buildKeyEventMessage(keysym: number, down: boolean): Buffer {
    const msg = Buffer.alloc(8);
    msg[0] = ClientMsgType.KeyEvent; // 4
    msg[1] = down ? 1 : 0;
    msg[2] = 0; // padding
    msg[3] = 0; // padding
    msg.writeUInt32BE(keysym, 4);
    return msg;
  }

  /**
   * 调度缓冲队列刷新
   */
  private scheduleFlush(): void {
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushEventBuffer();
      }, RfbInput.FLUSH_INTERVAL_MS);
    }
  }

  /**
   * 刷新缓冲队列 — 合并所有事件为单次 write
   */
  flushEventBuffer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.eventBuffer.length === 0) return;

    // 合并所有事件为单个 buffer，减少 write 系统调用和 TCP 包数
    const totalLength = this.eventBuffer.reduce((sum, b) => sum + b.length, 0);
    const merged = Buffer.alloc(totalLength);
    let offset = 0;
    for (const buf of this.eventBuffer) {
      buf.copy(merged, offset);
      offset += buf.length;
    }

    this.eventBuffer = [];
    this.client.send(merged);
  }

  /**
   * 清空缓冲队列（连接断开时调用）
   */
  clearEventBuffer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.eventBuffer = [];
    this.remoteModifiers.clear();
  }

  /**
   * 重置远程修饰键状态（如重新连接后）
   */
  resetModifierState(): void {
    this.remoteModifiers.clear();
  }

  /**
   * 获取远程修饰键状态对应的 button mask
   * 用于指针事件携带当前修饰键状态
   */
  getModifierButtonMask(): number {
    let mask = 0;
    for (const keysym of this.remoteModifiers) {
      const bit = ModifierToButtonMask[keysym];
      if (bit !== undefined) {
        mask |= bit;
      }
    }
    return mask;
  }

  /**
   * 发送指针（鼠标）事件
   * 消息: 1-byte msg-type(5), 1-byte button-mask, 2-byte x, 2-byte y
   */
  sendPointerEvent(buttonMask: number, x: number, y: number): void {
    // 合并远程修饰键状态到 button mask
    const fullMask = buttonMask | this.getModifierButtonMask();
    const msg = Buffer.alloc(6);
    msg[0] = ClientMsgType.PointerEvent; // 5
    msg[1] = fullMask & 0xFF;
    msg.writeUInt16BE(Math.max(0, x), 2);
    msg.writeUInt16BE(Math.max(0, y), 4);
    this.client.send(msg);
  }

  /**
   * 发送指针事件（不携带修饰键 — 用于精确控制）
   */
  sendPointerEventRaw(buttonMask: number, x: number, y: number): void {
    const msg = Buffer.alloc(6);
    msg[0] = ClientMsgType.PointerEvent; // 5
    msg[1] = buttonMask;
    msg.writeUInt16BE(Math.max(0, x), 2);
    msg.writeUInt16BE(Math.max(0, y), 4);
    this.client.send(msg);
  }

  /**
   * 更新鼠标按键掩码
   */
  updateButtonMask(button: number, pressed: boolean): void {
    if (pressed) {
      this.buttonMask |= button;
    } else {
      this.buttonMask &= ~button;
    }
  }

  getButtonMask(): number {
    return this.buttonMask;
  }

  /**
   * 获取远程修饰键状态 (keysym 集合)
   */
  getRemoteModifiers(): Set<number> {
    return new Set(this.remoteModifiers);
  }

  /**
   * 将键盘按键码映射为 RFB keysym
   */
  private mapKeyCode(keyCode: number): number {
    return RfbInput.KEY_MAP[keyCode] || keyCode;
  }
}
