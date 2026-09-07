/**
 * RFB 编码解码器
 * 参考 UltraVNC vncEncoder 和 RFC 6143
 *
 * 支持的编码:
 * - Raw (0): 原始像素数据
 * - CopyRect (1): 复制已有区域
 * - RRE (2): 行程编码
 * - Hextile (5): 分块编码
 * - ZRLE (16): Zlib 游程编码
 */
import { PixelFormat, FramebufferRect } from './types';
interface DecodeResult {
    pixels: Buffer;
    consumed: number;
}
export declare class EncodingDecoders {
    /**
     * ZRLE 持久化 zlib 流状态。
     *
     * 服务器（x11vnc / TigerVNC）通常跨矩形复用同一个 zlib 流：首块带 zlib 头，
     * 后续块是 raw deflate 续流并以 Z_SYNC_FLUSH 结尾。
     *
     * 这里采用「全缓冲区重复解压」模型：
     * - 每到达一个矩形的压缩数据就追加到累积缓冲；
     * - 每次把累积的全部压缩数据交给 zlib 重新解压——zlib 自己维护滑动窗口与
     *   回溯引用状态，无需手动管理 32KB 字典，从根源消除字典失配导致的像素错位；
     * - 解压输出中只取「上次已消费位置之后」的新数据解析矩形，避免重复解析；
     * - 全部矩形解出后清空累积缓冲，防止无界增长。
     *
     * 复杂度 O(n²)（n = 矩形数），但 VNC 帧通常 < 30 矩形、累积压缩数据 < 1MB，
     * 重复解压耗时在毫秒级，可忽略。
     */
    /** 累积的全部压缩数据（从连接/帧开始） */
    private zrleAccumulated;
    /** 已解压输出中已被解析消费的字节数 */
    private zrleOutConsumed;
    /** 已喂入压缩数据、等待 tile 数据齐备的矩形 */
    private zrleQueue;
    private static readonly MAX_OUTPUT;
    /** 新建连接或重连时重置流状态 */
    resetStreams(): void;
    /**
     * 喂入一个 ZRLE 矩形的压缩数据。
     *
     * 把压缩块追加到累积缓冲，记录矩形元信息，然后尝试从解压输出中解出积压矩形。
     */
    feedZrle(compressed: Buffer, x: number, y: number, width: number, height: number, format: PixelFormat, emit: (rect: FramebufferRect) => void): void;
    /** 解压当前累积的全部压缩数据 */
    private inflateAll;
    /** 从解压输出中尽可能多地解出积压矩形的 tile 数据 */
    private drainZrle;
    /**
     * 解码矩形数据
     */
    decode(buffer: Buffer, offset: number, encoding: number, width: number, height: number, format: PixelFormat): DecodeResult | null;
    /**
     * Raw 编码: 最简编码，直接传输像素数据
     * 数据: width * height * bytesPerPixel
     */
    private decodeRaw;
    /**
     * CopyRect 编码: 复制已存在的屏幕区域
     * 数据: 2-byte src-x, 2-byte src-y
     */
    private decodeCopyRect;
    /**
     * RRE (Rise-and-Run-length Encoding) 编码
     * 数据: 4-byte num-subrects, bytesPerPixel bg-color, subrects...
     * 每个子矩形: bytesPerPixel fg-color, 2-byte x, 2-byte y, 2-byte w, 2-byte h
     */
    private decodeRRE;
    /**
     * Hextile 编码: 将图像分成 16x16 的块
     * 每个块有子编码位:
     *   bit 0: Raw
     *   bit 1: BackgroundSpecified
     *   bit 2: ForegroundSpecified
     *   bit 3: AnySubrects
     *   bit 4: SubrectsColoured
     */
    private decodeHextile;
    /**
     * 解码 ZRLE 的 packed palette 像素并写入帧缓冲。
     *
     * 打包布局以 RealVNC 官方授权实现为准（libvncserver zrleencodetemplate.c，
     * QEMU vnc-enc-zrle.c.inc 同源，neatvnc 同）：调色板 2..16 色时每个像素用
     * ceil(log2(paletteSize)) 位表示（2 色=1bit、3-4 色=2bit、5-16 色=4bit），
     * 每行独立成段：行内像素从字节 MSB 开始顺序取位，行尾不足一字节时左移
     * 补零凑整，故每行固定占用 ceil(tw*bits/8) 字节，行与行互不跨接。tile
     * 宽恰为 64 时位流模型与之等价，仅在右/下边缘的窄条 tile 有差异。
     *
     * @returns 消耗的字节数；数据不足返回 null
     */
    private blitPackedPalette;
    /**
     * 解码 ZRLE tile 数据
     * ZRLE 使用 64x64 的 tile 和 CPIXEL (压缩像素) 格式
     */
    private decodeZRLETiles;
    /**
     * 解码 ZRLE palette tile 的 RLE 像素流。
     *
     * 线上格式（RealVNC/libvncserver/QEMU/neatvnc 编码器一致）：
     * - 每个像素值为 1 字节 palette index（paletteSize ≤ 127，因此 index < 128）；
     * - 一段重复 run 编码为 [index | 0x80][len-1 拆段...]：
     *   先写「调色板索引 | 高位标记」，再写 (run长度-1)，超过 255 时拆成
     *   多个 255 字节后跟一个 ≤254 的余数；解码时累加这些长度字节；
     * - 单像素 run（长度 1..2）直接写裸 index，无高位标记。
     *
     * 注意：早先实现把 run 误解为 [长度|0x80][index]（与真实格式相反），
     * 导致含大段重复色的 ZRLE tile（如窗口底色、文字行）整块花屏。
     */
    private decodeRLEPixels;
    /**
     * CPIXEL 字节数 (RFC 6143 7.7.5)
     * - 8bpp: 1 字节
     * - 16bpp: 2 字节
     * - 32bpp: 三分量均不超过 255 时为 3 字节 RGB，否则 4 字节
     */
    private cpixelSize;
    /**
     * 读取 CPIXEL (压缩像素)
     * 3 字节 CPIXEL = 像素值的低 3 字节（最高字节省略，RFC 6143 §7.7.5）：
     * - 小端格式：线序为 [低,中,高] → value = b0 | b1<<8 | b2<<16
     * - 大端格式：线序为 [高,中,低] → value = b0<<16 | b1<<8 | b2
     * 取回像素值后仍需按 redShift/greenShift/blueShift 提取通道，
     * 不能直接把线序字节当 RGB（对 LE + redShift=16 的服务器会导致红蓝互换）。
     */
    private readCPixel;
    /**
     * 读取一个像素值
     */
    private readPixel;
    /**
     * 将像素数据转换为 RGBA 格式
     */
    private convertToRGBA;
    /**
     * 填充矩形区域
     */
    private fillRect;
}
export {};
//# sourceMappingURL=encodings.d.ts.map