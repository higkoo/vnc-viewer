"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.EncodingDecoders = void 0;
const zlib = __importStar(require("zlib"));
const types_1 = require("./types");
class EncodingDecoders {
    constructor() {
        this.inflatePool = new Map();
    }
    /**
     * 解码矩形数据
     */
    decode(buffer, offset, encoding, width, height, format) {
        switch (encoding) {
            case types_1.EncodingType.Raw:
                return this.decodeRaw(buffer, offset, width, height, format);
            case types_1.EncodingType.CopyRect:
                return this.decodeCopyRect(buffer, offset);
            case types_1.EncodingType.RRE:
                return this.decodeRRE(buffer, offset, width, height, format);
            case types_1.EncodingType.Hextile:
                return this.decodeHextile(buffer, offset, width, height, format);
            case types_1.EncodingType.ZRLE:
                return this.decodeZRLE(buffer, offset, width, height, format);
            default:
                // 未知编码，尝试跳过
                return null;
        }
    }
    /**
     * Raw 编码: 最简编码，直接传输像素数据
     * 数据: width * height * bytesPerPixel
     */
    decodeRaw(buffer, offset, width, height, format) {
        const bytesPerPixel = format.bitsPerPixel / 8;
        const dataLen = width * height * bytesPerPixel;
        if (buffer.length < offset + dataLen)
            return null;
        const pixels = this.convertToRGBA(buffer.subarray(offset, offset + dataLen), width, height, format);
        return { pixels, consumed: dataLen };
    }
    /**
     * CopyRect 编码: 复制已存在的屏幕区域
     * 数据: 2-byte src-x, 2-byte src-y
     */
    decodeCopyRect(buffer, offset) {
        if (buffer.length < offset + 4)
            return null;
        const srcX = buffer.readUInt16BE(offset);
        const srcY = buffer.readUInt16BE(offset + 2);
        // CopyRect 不包含像素数据，需要由调用方处理
        // 返回一个空的像素缓冲区，但标记为 CopyRect 类型
        const meta = Buffer.alloc(4);
        meta.writeUInt16BE(srcX, 0);
        meta.writeUInt16BE(srcY, 2);
        return { pixels: meta, consumed: 4 };
    }
    /**
     * RRE (Rise-and-Run-length Encoding) 编码
     * 数据: 4-byte num-subrects, bytesPerPixel bg-color, subrects...
     * 每个子矩形: bytesPerPixel fg-color, 2-byte x, 2-byte y, 2-byte w, 2-byte h
     */
    decodeRRE(buffer, offset, width, height, format) {
        const bpp = format.bitsPerPixel / 8;
        if (buffer.length < offset + 4 + bpp)
            return null;
        const numRects = buffer.readUInt32BE(offset);
        let consumed = 4;
        // 读取背景色
        const bgColor = this.readPixel(buffer, offset + consumed, format);
        consumed += bpp;
        // 创建帧缓冲
        const totalPixels = width * height * 4; // RGBA
        const fb = Buffer.alloc(totalPixels);
        // 填充背景色
        this.fillRect(fb, 0, 0, width, height, bgColor, width);
        // 读取每个子矩形
        for (let i = 0; i < numRects; i++) {
            if (buffer.length < offset + consumed + bpp + 8)
                return null;
            const fgColor = this.readPixel(buffer, offset + consumed, format);
            consumed += bpp;
            const rx = buffer.readUInt16BE(offset + consumed);
            const ry = buffer.readUInt16BE(offset + consumed + 2);
            const rw = buffer.readUInt16BE(offset + consumed + 4);
            const rh = buffer.readUInt16BE(offset + consumed + 6);
            consumed += 8;
            this.fillRect(fb, rx, ry, rw, rh, fgColor, width);
        }
        return { pixels: fb, consumed };
    }
    /**
     * Hextile 编码: 将图像分成 16x16 的块
     * 每个块有子编码位:
     *   bit 0: Raw
     *   bit 1: BackgroundSpecified
     *   bit 2: ForegroundSpecified
     *   bit 3: AnySubrects
     *   bit 4: SubrectsColoured
     */
    decodeHextile(buffer, offset, width, height, format) {
        const bpp = format.bitsPerPixel / 8;
        const totalPixels = width * height * 4;
        const fb = Buffer.alloc(totalPixels);
        let consumed = 0;
        let remaining = buffer.length - offset;
        // 处理 16x16 的块
        for (let ty = 0; ty < height; ty += 16) {
            for (let tx = 0; tx < width; tx += 16) {
                const tw = Math.min(16, width - tx);
                const th = Math.min(16, height - ty);
                if (remaining < 1)
                    return null;
                const subEnc = buffer[offset + consumed];
                consumed++;
                remaining--;
                const isRaw = (subEnc & 0x01) !== 0;
                const bgSpec = (subEnc & 0x02) !== 0;
                const fgSpec = (subEnc & 0x04) !== 0;
                const anySub = (subEnc & 0x08) !== 0;
                const subCol = (subEnc & 0x10) !== 0;
                // 读取背景色
                let bgColor = [0, 0, 0, 255];
                if (bgSpec || isRaw) {
                    if (remaining < bpp)
                        return null;
                    bgColor = this.readPixel(buffer, offset + consumed, format);
                    consumed += bpp;
                    remaining -= bpp;
                    // 填充背景色
                    this.fillRect(fb, tx, ty, tw, th, bgColor, width);
                }
                if (isRaw) {
                    // Raw 子编码: 直接传输像素数据
                    const rawLen = tw * th * bpp;
                    if (remaining < rawLen)
                        return null;
                    const rawData = buffer.subarray(offset + consumed, offset + consumed + rawLen);
                    const rgbaData = this.convertToRGBA(rawData, tw, th, format);
                    // 将 RGBA 数据复制到帧缓冲的对应位置
                    for (let row = 0; row < th; row++) {
                        const srcOff = row * tw * 4;
                        const dstOff = ((ty + row) * width + tx) * 4;
                        rgbaData.copy(fb, dstOff, srcOff, srcOff + tw * 4);
                    }
                    consumed += rawLen;
                    remaining -= rawLen;
                }
                else {
                    // 读取前景色
                    let fgColor = [0, 0, 0, 255];
                    if (fgSpec) {
                        if (remaining < bpp)
                            return null;
                        fgColor = this.readPixel(buffer, offset + consumed, format);
                        consumed += bpp;
                        remaining -= bpp;
                    }
                    // 处理子矩形
                    if (anySub) {
                        const numSubRects = buffer[offset + consumed];
                        consumed++;
                        remaining--;
                        for (let s = 0; s < numSubRects; s++) {
                            let scolor = fgColor;
                            if (subCol) {
                                if (remaining < bpp + 2)
                                    return null;
                                scolor = this.readPixel(buffer, offset + consumed, format);
                                consumed += bpp;
                                remaining -= bpp;
                            }
                            else {
                                if (remaining < 2)
                                    return null;
                            }
                            // 子矩形位置和大小编码在2字节中
                            const posByte = buffer[offset + consumed];
                            const sizeByte = buffer[offset + consumed + 1];
                            consumed += 2;
                            remaining -= 2;
                            const sx = (posByte >> 4) & 0x0F;
                            const sy = posByte & 0x0F;
                            const sw = (sizeByte >> 4) & 0x0F;
                            const sh = sizeByte & 0x0F;
                            // 限制子矩形在块范围内
                            const actualSw = Math.min(sw + 1, tw - sx);
                            const actualSh = Math.min(sh + 1, th - sy);
                            this.fillRect(fb, tx + sx, ty + sy, actualSw, actualSh, scolor, width);
                        }
                    }
                }
            }
        }
        return { pixels: fb, consumed };
    }
    /**
     * ZRLE (Zlib Run-Length Encoding) 编码
     * 数据: 4-byte length, zlib-compressed data
     * 解压后: tiles 使用 CPIXEL 格式
     */
    decodeZRLE(buffer, offset, width, height, format) {
        if (buffer.length < offset + 4)
            return null;
        const compressedLen = buffer.readUInt32BE(offset);
        if (buffer.length < offset + 4 + compressedLen)
            return null;
        const compressedData = buffer.subarray(offset + 4, offset + 4 + compressedLen);
        try {
            // 解压 Zlib 数据
            const decompressed = zlib.inflateSync(compressedData);
            return this.decodeZRLETiles(decompressed, 0, width, height, format);
        }
        catch (err) {
            return null;
        }
    }
    /**
     * 解码 ZRLE tile 数据
     * ZRLE 使用 64x64 的 tile 和 CPIXEL (压缩像素) 格式
     */
    decodeZRLETiles(buffer, offset, width, height, format) {
        const totalPixels = width * height * 4;
        const fb = Buffer.alloc(totalPixels);
        let consumed = 0;
        // 处理 64x64 的 tile
        for (let ty = 0; ty < height; ty += 64) {
            for (let tx = 0; tx < width; tx += 64) {
                const tw = Math.min(64, width - tx);
                const th = Math.min(64, height - ty);
                // 读取 tile 编码类型
                if (buffer.length < offset + consumed + 1)
                    return null;
                const tileType = buffer[offset + consumed];
                consumed++;
                const subType = tileType & 0x7F;
                const isRLE = (tileType & 0x80) !== 0;
                // 跳过 palette 模式
                // 简化处理: 使用 Raw 子类型
                if (subType >= 1 && subType <= 99) {
                    // Raw palette RLE
                    const paletteSize = subType;
                    const palette = [];
                    for (let i = 0; i < paletteSize; i++) {
                        if (buffer.length < offset + consumed + 3)
                            return null;
                        const cpixel = this.readCPixel(buffer, offset + consumed, format);
                        palette.push(cpixel);
                        consumed += 3; // CPIXEL 总是 3 字节
                    }
                    if (isRLE) {
                        // RLE 编码的像素索引
                        const result = this.decodeRLEPixels(buffer, offset + consumed, tw, th, palette);
                        if (result === null)
                            return null;
                        consumed += result.consumed;
                        // 复制到帧缓冲
                        for (let row = 0; row < th; row++) {
                            const srcOff = row * tw * 4;
                            const dstOff = ((ty + row) * width + tx) * 4;
                            result.pixels.copy(fb, dstOff, srcOff, srcOff + tw * 4);
                        }
                    }
                    else {
                        // Plain palette: 每个像素1字节索引
                        const pixelLen = tw * th;
                        if (buffer.length < offset + consumed + pixelLen)
                            return null;
                        for (let row = 0; row < th; row++) {
                            for (let col = 0; col < tw; col++) {
                                const idx = buffer[offset + consumed + row * tw + col];
                                const color = palette[idx] || [0, 0, 0, 255];
                                const dstOff = ((ty + row) * width + tx + col) * 4;
                                fb[dstOff] = color[0];
                                fb[dstOff + 1] = color[1];
                                fb[dstOff + 2] = color[2];
                                fb[dstOff + 3] = 255;
                            }
                        }
                        consumed += pixelLen;
                    }
                }
                else if (subType === 0) {
                    // Raw pixel data
                    const bpp = Math.min(format.bitsPerPixel / 8, 4);
                    const rawLen = tw * th * bpp;
                    if (buffer.length < offset + consumed + rawLen)
                        return null;
                    const rawData = buffer.subarray(offset + consumed, offset + consumed + rawLen);
                    const rgbaData = this.convertToRGBA(rawData, tw, th, format);
                    for (let row = 0; row < th; row++) {
                        const srcOff = row * tw * 4;
                        const dstOff = ((ty + row) * width + tx) * 4;
                        rgbaData.copy(fb, dstOff, srcOff, srcOff + tw * 4);
                    }
                    consumed += rawLen;
                }
                else if (subType >= 100 && subType <= 127) {
                    // Solid color tile: 只有一种颜色
                    const cpixel = this.readCPixel(buffer, offset + consumed, format);
                    consumed += 3;
                    this.fillRect(fb, tx, ty, tw, th, cpixel, width);
                }
                else {
                    // Packed palette tiles - 简化处理，跳过
                    return null;
                }
            }
        }
        return { pixels: fb, consumed: consumed + 4 + 4 }; // +4 for length +4 for consumed header
    }
    decodeRLEPixels(buffer, offset, width, height, palette) {
        const totalPixels = width * height * 4;
        const fb = Buffer.alloc(totalPixels);
        let consumed = 0;
        let pixelIdx = 0;
        while (pixelIdx < width * height) {
            if (buffer.length < offset + consumed + 1)
                return null;
            const b = buffer[offset + consumed];
            consumed++;
            if (b & 0x80) {
                // RLE run: 重复 (b & 0x7F) + 1 次
                const runLen = (b & 0x7F) + 1;
                if (buffer.length < offset + consumed + 1)
                    return null;
                const paletteIdx = buffer[offset + consumed];
                consumed++;
                const color = palette[paletteIdx] || [0, 0, 0, 255];
                for (let i = 0; i < runLen && pixelIdx < width * height; i++) {
                    const row = Math.floor(pixelIdx / width);
                    const col = pixelIdx % width;
                    const dstOff = (row * width + col) * 4;
                    fb[dstOff] = color[0];
                    fb[dstOff + 1] = color[1];
                    fb[dstOff + 2] = color[2];
                    fb[dstOff + 3] = 255;
                    pixelIdx++;
                }
            }
            else {
                // Single pixel + palette index (b & 0x3F) + 1 个单一像素
                // 简化: 将 b 直接作为 palette 索引（无重复）
                const color = palette[b & 0x7F] || [0, 0, 0, 255];
                const row = Math.floor(pixelIdx / width);
                const col = pixelIdx % width;
                const dstOff = (row * width + col) * 4;
                fb[dstOff] = color[0];
                fb[dstOff + 1] = color[1];
                fb[dstOff + 2] = color[2];
                fb[dstOff + 3] = 255;
                pixelIdx++;
            }
        }
        return { pixels: fb, consumed };
    }
    /**
     * 读取 CPIXEL (压缩像素，总是3字节 RGB)
     */
    readCPixel(buffer, offset, format) {
        return [buffer[offset], buffer[offset + 1], buffer[offset + 2], 255];
    }
    /**
     * 读取一个像素值
     */
    readPixel(buffer, offset, format) {
        const bpp = Math.ceil(format.bitsPerPixel / 8);
        let pixelValue;
        if (bpp === 1) {
            pixelValue = buffer[offset];
        }
        else if (bpp === 2) {
            pixelValue = format.bigEndian ? buffer.readUInt16BE(offset) : buffer.readUInt16LE(offset);
        }
        else {
            pixelValue = format.bigEndian ? buffer.readUInt32BE(offset) : buffer.readUInt32LE(offset);
        }
        if (format.trueColor) {
            const r = (pixelValue >> format.redShift) & format.redMax;
            const g = (pixelValue >> format.greenShift) & format.greenMax;
            const b = (pixelValue >> format.blueShift) & format.blueMax;
            // 缩放到 0-255
            return [
                Math.round((r / format.redMax) * 255),
                Math.round((g / format.greenMax) * 255),
                Math.round((b / format.blueMax) * 255),
                255,
            ];
        }
        // 非真彩色，返回原始值
        return [pixelValue & 0xFF, (pixelValue >> 8) & 0xFF, (pixelValue >> 16) & 0xFF, 255];
    }
    /**
     * 将像素数据转换为 RGBA 格式
     */
    convertToRGBA(data, width, height, format) {
        const bpp = format.bitsPerPixel / 8;
        const result = Buffer.alloc(width * height * 4);
        for (let i = 0; i < width * height; i++) {
            const srcOff = i * bpp;
            const dstOff = i * 4;
            const pixel = this.readPixel(data, srcOff, format);
            result[dstOff] = pixel[0];
            result[dstOff + 1] = pixel[1];
            result[dstOff + 2] = pixel[2];
            result[dstOff + 3] = pixel[3];
        }
        return result;
    }
    /**
     * 填充矩形区域
     */
    fillRect(fb, x, y, w, h, color, fbWidth) {
        for (let row = 0; row < h; row++) {
            for (let col = 0; col < w; col++) {
                const off = ((y + row) * fbWidth + x + col) * 4;
                fb[off] = color[0];
                fb[off + 1] = color[1];
                fb[off + 2] = color[2];
                fb[off + 3] = color[3];
            }
        }
    }
}
exports.EncodingDecoders = EncodingDecoders;
//# sourceMappingURL=encodings.js.map