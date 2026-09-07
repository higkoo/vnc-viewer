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
     * 部分服务器（如 x11vnc/TigerVNC）对一个连接上的所有 ZRLE 矩形复用同一个 zlib 流：
     * 只有第一个矩形带 zlib 头（78 9c...），后续矩形是 deflate 续流，每块以 Z_SYNC_FLUSH 结束。
     * 由于 zlib 的 LZ77 会回溯 32KB 历史，这里用「raw deflate + 32KB 滑动字典」同步还原，
     * 既保持解析逻辑同步，又避免 O(n²) 的重解压。
     */
    private zrleStarted;
    private zrleHistory;
    /** 已累积但尚未解出完整 tile 数据的压缩数据 */
    private zrlePending;
    /** 已消费的解压输出字节数（相对当前累积解压结果） */
    private zrleOutConsumed;
    /** 已喂入压缩数据、等待 tile 数据齐备的矩形 */
    private zrleQueue;
    private static readonly ZLIB_WINDOW;
    private static readonly MAX_OUTPUT;
    /** 新建连接或重连时重置流状态 */
    resetStreams(): void;
    /** 记录已解压输出，仅保留窗口需要的尾部数据 */
    private appendZrleHistory;
    /**
     * 喂入一个 ZRLE 矩形的压缩数据。
     *
     * 由于服务器的 zlib flush 边界与矩形边界不一定对齐，单个矩形的压缩数据可能无法
     * 立刻解出完整 tile 数据。这里把压缩数据累积起来，能解出多少矩形就回调多少，
     * 剩下的等后续矩形的数据到达后再解（顺序不变）。
     */
    feedZrle(compressed: Buffer, x: number, y: number, width: number, height: number, format: PixelFormat, emit: (rect: FramebufferRect) => void): void;
    /** 解压当前累积的压缩数据 */
    private inflateZrlePending;
    /** 尽可能多地解出积压矩形的 tile 数据 */
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
     * 解码 ZRLE tile 数据
     * ZRLE 使用 64x64 的 tile 和 CPIXEL (压缩像素) 格式
     */
    private decodeZRLETiles;
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