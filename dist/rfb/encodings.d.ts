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
import { PixelFormat } from './types';
interface DecodeResult {
    pixels: Buffer;
    consumed: number;
}
export declare class EncodingDecoders {
    private inflatePool;
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
     * ZRLE (Zlib Run-Length Encoding) 编码
     * 数据: 4-byte length, zlib-compressed data
     * 解压后: tiles 使用 CPIXEL 格式
     */
    private decodeZRLE;
    /**
     * 解码 ZRLE tile 数据
     * ZRLE 使用 64x64 的 tile 和 CPIXEL (压缩像素) 格式
     */
    private decodeZRLETiles;
    private decodeRLEPixels;
    /**
     * 读取 CPIXEL (压缩像素，总是3字节 RGB)
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