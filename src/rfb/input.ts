/**
 * RFB 输入事件处理 (键盘/鼠标)
 * 参考 UltraVNC vncviewer 和 RFC 6143 Section 7.5
 */

import { RfbClient } from './client';
import { ClientMsgType } from './types';

export class RfbInput {
  private client: RfbClient;

  // 鼠标按键状态
  private buttonMask: number = 0;

  // X11 键码映射 (keysym -> RFB 标准)
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
    220: 0x5C,  // \
    221: 0x5D,  // ]
    222: 0x27,  // '
  };

  constructor(client: RfbClient) {
    this.client = client;
  }

  /**
   * 发送键盘事件
   * 消息: 1-byte msg-type(4), 1-byte down-flag, 2-byte padding, 4-byte keysym
   */
  sendKeyEvent(keyCode: number, down: boolean): void {
    const keysym = this.mapKeyCode(keyCode);
    if (keysym === 0) return;

    const msg = Buffer.alloc(8);
    msg[0] = ClientMsgType.KeyEvent; // 4
    msg[1] = down ? 1 : 0;
    msg[2] = 0; // padding
    msg[3] = 0; // padding
    msg.writeUInt32BE(keysym, 4);
    this.client.send(msg);
  }

  /**
   * 发送指针（鼠标）事件
   * 消息: 1-byte msg-type(5), 1-byte button-mask, 2-byte x, 2-byte y
   */
  sendPointerEvent(buttonMask: number, x: number, y: number): void {
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
   * 将键盘按键码映射为 RFB keysym
   */
  private mapKeyCode(keyCode: number): number {
    return RfbInput.KEY_MAP[keyCode] || keyCode;
  }
}