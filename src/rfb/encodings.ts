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

import * as zlib from 'zlib';
import { EncodingType, PixelFormat, FramebufferRect } from './types';

interface DecodeResult {
  pixels: Buffer;
  consumed: number;
}

export class EncodingDecoders {
  /**
   * ZRLE 持久化 zlib 流状态。
   *
   * 部分服务器（如 x11vnc/TigerVNC）对一个连接上的所有 ZRLE 矩形复用同一个 zlib 流：
   * 只有第一个矩形带 zlib 头（78 9c...），后续矩形是 deflate 续流，每块以 Z_SYNC_FLUSH 结束。
   * 由于 zlib 的 LZ77 会回溯 32KB 历史，这里用「raw deflate + 32KB 滑动字典」同步还原，
   * 既保持解析逻辑同步，又避免 O(n²) 的重解压。
   */
  private zrleStarted: boolean = false;
  private zrleHistory: Buffer = Buffer.alloc(0);
  /** 已累积但尚未解出完整 tile 数据的压缩数据 */
  private zrlePending: Buffer = Buffer.alloc(0);
  /** 已消费的解压输出字节数（相对当前累积解压结果） */
  private zrleOutConsumed: number = 0;
  /** 已喂入压缩数据、等待 tile 数据齐备的矩形 */
  private zrleQueue: {
    x: number; y: number; width: number; height: number; format: PixelFormat;
  }[] = [];
  private static readonly ZLIB_WINDOW = 32768;
  private static readonly MAX_OUTPUT = 64 * 1024 * 1024;

  /** 新建连接或重连时重置流状态 */
  resetStreams(): void {
    this.zrleStarted = false;
    this.zrleHistory = Buffer.alloc(0);
    this.zrlePending = Buffer.alloc(0);
    this.zrleOutConsumed = 0;
    this.zrleQueue = [];
  }

  /** 记录已解压输出，仅保留窗口需要的尾部数据 */
  private appendZrleHistory(out: Buffer): void {
    this.zrleHistory = Buffer.concat([this.zrleHistory, out]);
    const keep = EncodingDecoders.ZLIB_WINDOW * 2;
    if (this.zrleHistory.length > keep) {
      this.zrleHistory = this.zrleHistory.subarray(this.zrleHistory.length - keep);
    }
  }

  /**
   * 喂入一个 ZRLE 矩形的压缩数据。
   *
   * 由于服务器的 zlib flush 边界与矩形边界不一定对齐，单个矩形的压缩数据可能无法
   * 立刻解出完整 tile 数据。这里把压缩数据累积起来，能解出多少矩形就回调多少，
   * 剩下的等后续矩形的数据到达后再解（顺序不变）。
   */
  feedZrle(
    compressed: Buffer,
    x: number, y: number, width: number, height: number,
    format: PixelFormat,
    emit: (rect: FramebufferRect) => void
  ): void {
    this.zrlePending = Buffer.concat([this.zrlePending, compressed]);
    this.zrleQueue.push({ x, y, width, height, format });
    this.drainZrle(emit);
  }

  /** 解压当前累积的压缩数据 */
  private inflateZrlePending(): Buffer | null {
    if (!this.zrleStarted) {
      // 首个块带 zlib 头
      try {
        return zlib.inflateSync(this.zrlePending, {
          finishFlush: zlib.constants.Z_SYNC_FLUSH,
          maxOutputLength: EncodingDecoders.MAX_OUTPUT,
        });
      } catch (err) {
        return null;
      }
    }

    const win = this.zrleHistory.length > EncodingDecoders.ZLIB_WINDOW
      ? this.zrleHistory.subarray(this.zrleHistory.length - EncodingDecoders.ZLIB_WINDOW)
      : this.zrleHistory;
    try {
      return zlib.inflateRawSync(this.zrlePending, {
        finishFlush: zlib.constants.Z_SYNC_FLUSH,
        dictionary: win,
        maxOutputLength: EncodingDecoders.MAX_OUTPUT,
      });
    } catch (err) {
      // 兜底：个别服务器每个矩形都是独立 zlib 流
      try {
        return zlib.inflateSync(this.zrlePending, {
          finishFlush: zlib.constants.Z_SYNC_FLUSH,
          maxOutputLength: EncodingDecoders.MAX_OUTPUT,
        });
      } catch (e) {
        return null;
      }
    }
  }

  /** 尽可能多地解出积压矩形的 tile 数据 */
  private drainZrle(emit: (rect: FramebufferRect) => void): void {
    if (this.zrleQueue.length === 0) return;

    const out = this.inflateZrlePending();
    if (out === null) return;

    let cursor = this.zrleOutConsumed;
    let drained = 0;

    for (const q of this.zrleQueue) {
      const res = this.decodeZRLETiles(out, cursor, q.width, q.height, q.format);
      if (res === null) break; // tile 数据尚未解出，等待更多压缩数据
      emit({
        x: q.x, y: q.y, width: q.width, height: q.height,
        encoding: EncodingType.ZRLE, data: res.pixels,
      } as FramebufferRect);
      cursor += res.consumed;
      drained++;
    }

    if (drained === 0) return;

    this.appendZrleHistory(out.subarray(this.zrleOutConsumed, cursor));
    this.zrleOutConsumed = cursor;
    this.zrleQueue = this.zrleQueue.slice(drained);
    this.zrleStarted = true;

    // 全部解出且输出消费干净：重置累积，后续用字典续流，避免无界增长
    if (this.zrleQueue.length === 0 && this.zrleOutConsumed === out.length) {
      this.zrlePending = Buffer.alloc(0);
      this.zrleOutConsumed = 0;
    }
  }

  /**
   * 解码矩形数据
   */
  decode(
    buffer: Buffer, offset: number, encoding: number,
    width: number, height: number, format: PixelFormat
  ): DecodeResult | null {
    switch (encoding) {
      case EncodingType.Raw:
        return this.decodeRaw(buffer, offset, width, height, format);
      case EncodingType.CopyRect:
        return this.decodeCopyRect(buffer, offset);
      case EncodingType.RRE:
        return this.decodeRRE(buffer, offset, width, height, format);
      case EncodingType.Hextile:
        return this.decodeHextile(buffer, offset, width, height, format);
      // ZRLE 走 feedZrle(): 服务器可能跨矩形复用 zlib 流，需要累积解压后回调
      default:
        // 未知编码，尝试跳过
        return null;
    }
  }

  /**
   * Raw 编码: 最简编码，直接传输像素数据
   * 数据: width * height * bytesPerPixel
   */
  private decodeRaw(
    buffer: Buffer, offset: number,
    width: number, height: number, format: PixelFormat
  ): DecodeResult | null {
    const bytesPerPixel = format.bitsPerPixel / 8;
    const dataLen = width * height * bytesPerPixel;

    if (buffer.length < offset + dataLen) return null;

    const pixels = this.convertToRGBA(
      buffer.subarray(offset, offset + dataLen),
      width, height, format
    );

    return { pixels, consumed: dataLen };
  }

  /**
   * CopyRect 编码: 复制已存在的屏幕区域
   * 数据: 2-byte src-x, 2-byte src-y
   */
  private decodeCopyRect(buffer: Buffer, offset: number): DecodeResult | null {
    if (buffer.length < offset + 4) return null;

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
  private decodeRRE(
    buffer: Buffer, offset: number,
    width: number, height: number, format: PixelFormat
  ): DecodeResult | null {
    const bpp = format.bitsPerPixel / 8;

    if (buffer.length < offset + 4 + bpp) return null;

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
      if (buffer.length < offset + consumed + bpp + 8) return null;

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
  private decodeHextile(
    buffer: Buffer, offset: number,
    width: number, height: number, format: PixelFormat
  ): DecodeResult | null {
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

        if (remaining < 1) return null;

        const subEnc = buffer[offset + consumed];
        consumed++;
        remaining--;

        const isRaw = (subEnc & 0x01) !== 0;
        const bgSpec = (subEnc & 0x02) !== 0;
        const fgSpec = (subEnc & 0x04) !== 0;
        const anySub = (subEnc & 0x08) !== 0;
        const subCol = (subEnc & 0x10) !== 0;

        // 读取背景色
        let bgColor: number[] = [0, 0, 0, 255];
        if (bgSpec || isRaw) {
          if (remaining < bpp) return null;
          bgColor = this.readPixel(buffer, offset + consumed, format);
          consumed += bpp;
          remaining -= bpp;

          // 填充背景色
          this.fillRect(fb, tx, ty, tw, th, bgColor, width);
        }

        if (isRaw) {
          // Raw 子编码: 直接传输像素数据
          const rawLen = tw * th * bpp;
          if (remaining < rawLen) return null;
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
        } else {
          // 读取前景色
          let fgColor: number[] = [0, 0, 0, 255];
          if (fgSpec) {
            if (remaining < bpp) return null;
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
                if (remaining < bpp + 2) return null;
                scolor = this.readPixel(buffer, offset + consumed, format);
                consumed += bpp;
                remaining -= bpp;
              } else {
                if (remaining < 2) return null;
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
   * 解码 ZRLE tile 数据
   * ZRLE 使用 64x64 的 tile 和 CPIXEL (压缩像素) 格式
   */
  private decodeZRLETiles(
    buffer: Buffer, offset: number,
    width: number, height: number, format: PixelFormat
  ): DecodeResult | null {
    const totalPixels = width * height * 4;
    const fb = Buffer.alloc(totalPixels);
    let consumed = 0;
    // ZRLE 内部使用 CPIXEL：32bpp 且三分量均 <= 255 时为 3 字节 RGB
    const cpi = this.cpixelSize(format);

    // 处理 64x64 的 tile
    for (let ty = 0; ty < height; ty += 64) {
      for (let tx = 0; tx < width; tx += 64) {
        const tw = Math.min(64, width - tx);
        const th = Math.min(64, height - ty);

        // 读取 tile 编码类型
        if (buffer.length < offset + consumed + 1) return null;
        const tileType = buffer[offset + consumed];
        consumed++;

        const subType = tileType & 0x7F;
        const isRLE = (tileType & 0x80) !== 0;

        if (subType >= 1 && subType <= 127) {
          // 调色板 tile: subType 即调色板大小
          const paletteSize = subType;
          if (buffer.length < offset + consumed + paletteSize * cpi) return null;

          const palette: number[][] = [];
          for (let i = 0; i < paletteSize; i++) {
            palette.push(this.readCPixel(buffer, offset + consumed, format, cpi));
            consumed += cpi;
          }

          if (isRLE) {
            // RLE 编码的像素索引
            const result = this.decodeRLEPixels(buffer, offset + consumed, tw, th, palette);
            if (result === null) return null;
            consumed += result.consumed;

            // 复制到帧缓冲
            for (let row = 0; row < th; row++) {
              const srcOff = row * tw * 4;
              const dstOff = ((ty + row) * width + tx) * 4;
              result.pixels.copy(fb, dstOff, srcOff, srcOff + tw * 4);
            }
          } else if (paletteSize === 1) {
            // 纯色 tile: 无像素数据
            this.fillRect(fb, tx, ty, tw, th, palette[0], width);
          } else if (paletteSize <= 16) {
            // Plain palette 且调色板 <= 16 色时按位打包，每行按字节对齐
            const bits = paletteSize <= 2 ? 1 : (paletteSize <= 4 ? 2 : 4);
            const rowBytes = Math.ceil((tw * bits) / 8);
            const packedLen = rowBytes * th;
            if (buffer.length < offset + consumed + packedLen) return null;

            const mask = (1 << bits) - 1;
            for (let row = 0; row < th; row++) {
              for (let col = 0; col < tw; col++) {
                const bitIndex = col * bits;
                const byte = buffer[offset + consumed + row * rowBytes + (bitIndex >> 3)];
                const shift = 8 - bits - (bitIndex & 7);
                const color = palette[(byte >> shift) & mask] || [0, 0, 0, 255];
                const dstOff = ((ty + row) * width + tx + col) * 4;
                fb[dstOff] = color[0];
                fb[dstOff + 1] = color[1];
                fb[dstOff + 2] = color[2];
                fb[dstOff + 3] = 255;
              }
            }
            consumed += packedLen;
          } else {
            // 调色板 > 16 色: 每个像素 1 字节索引
            const pixelLen = tw * th;
            if (buffer.length < offset + consumed + pixelLen) return null;

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
        } else if (subType === 0) {
          // Raw tile: CPIXEL 序列
          const rawLen = tw * th * cpi;
          if (buffer.length < offset + consumed + rawLen) return null;

          for (let row = 0; row < th; row++) {
            for (let col = 0; col < tw; col++) {
              const color = this.readCPixel(
                buffer, offset + consumed + (row * tw + col) * cpi, format, cpi
              );
              const dstOff = ((ty + row) * width + tx + col) * 4;
              fb[dstOff] = color[0];
              fb[dstOff + 1] = color[1];
              fb[dstOff + 2] = color[2];
              fb[dstOff + 3] = 255;
            }
          }
          consumed += rawLen;
        } else if (subType >= 128 && subType <= 130) {
          // Packed palette tile: 调色板 + 位打包索引
          const bitsPerPixel = subType - 127; // 128 -> 1bit, 129 -> 2bit, 130 -> 4bit
          const paletteSize = 1 << bitsPerPixel;
          if (buffer.length < offset + consumed + paletteSize * cpi) return null;

          const palette: number[][] = [];
          for (let i = 0; i < paletteSize; i++) {
            palette.push(this.readCPixel(buffer, offset + consumed, format, cpi));
            consumed += cpi;
          }

          // 每行按字节对齐
          const rowBytes = Math.ceil((tw * bitsPerPixel) / 8);
          const packedLen = rowBytes * th;
          if (buffer.length < offset + consumed + packedLen) return null;

          const mask = paletteSize - 1;
          for (let row = 0; row < th; row++) {
            for (let col = 0; col < tw; col++) {
              const bitIndex = col * bitsPerPixel;
              const byte = buffer[offset + consumed + row * rowBytes + (bitIndex >> 3)];
              const shift = 8 - bitsPerPixel - (bitIndex & 7);
              const color = palette[(byte >> shift) & mask] || [0, 0, 0, 255];
              const dstOff = ((ty + row) * width + tx + col) * 4;
              fb[dstOff] = color[0];
              fb[dstOff + 1] = color[1];
              fb[dstOff + 2] = color[2];
              fb[dstOff + 3] = 255;
            }
          }
          consumed += packedLen;
        } else {
          // 未知 tile 类型
          return null;
        }
      }
    }

    return { pixels: fb, consumed };
  }

  private decodeRLEPixels(
    buffer: Buffer, offset: number,
    width: number, height: number, palette: number[][]
  ): { pixels: Buffer; consumed: number } | null {
    const totalPixels = width * height * 4;
    const fb = Buffer.alloc(totalPixels);
    let consumed = 0;
    let pixelIdx = 0;

    while (pixelIdx < width * height) {
      if (buffer.length < offset + consumed + 1) return null;

      const b = buffer[offset + consumed];
      consumed++;

      if (b & 0x80) {
        // RLE run: 重复 (b & 0x7F) + 1 次
        const runLen = (b & 0x7F) + 1;
        if (buffer.length < offset + consumed + 1) return null;
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
      } else {
        // 非 run: 后续 (b + 1) 个字节，每个都是调色板索引
        const count = b + 1;
        if (buffer.length < offset + consumed + count) return null;

        for (let i = 0; i < count && pixelIdx < width * height; i++) {
          const color = palette[buffer[offset + consumed]] || [0, 0, 0, 255];
          consumed++;
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
    }

    return { pixels: fb, consumed };
  }

  /**
   * CPIXEL 字节数 (RFC 6143 7.7.5)
   * - 8bpp: 1 字节
   * - 16bpp: 2 字节
   * - 32bpp: 三分量均不超过 255 时为 3 字节 RGB，否则 4 字节
   */
  private cpixelSize(format: PixelFormat): number {
    if (format.bitsPerPixel === 8) return 1;
    if (format.bitsPerPixel === 16) return 2;
    return (format.redMax <= 255 && format.greenMax <= 255 && format.blueMax <= 255) ? 3 : 4;
  }

  /**
   * 读取 CPIXEL (压缩像素)
   */
  private readCPixel(
    buffer: Buffer, offset: number, format: PixelFormat, size: number = 3
  ): number[] {
    if (size === 3) return [buffer[offset], buffer[offset + 1], buffer[offset + 2], 255];
    if (size === 1) return this.readPixel(buffer, offset, { ...format, bitsPerPixel: 8 });
    if (size === 2) return this.readPixel(buffer, offset, { ...format, bitsPerPixel: 16 });
    return this.readPixel(buffer, offset, format);
  }

  /**
   * 读取一个像素值
   */
  private readPixel(buffer: Buffer, offset: number, format: PixelFormat): number[] {
    const bpp = Math.ceil(format.bitsPerPixel / 8);

    let pixelValue: number;
    if (bpp === 1) {
      pixelValue = buffer[offset];
    } else if (bpp === 2) {
      pixelValue = format.bigEndian ? buffer.readUInt16BE(offset) : buffer.readUInt16LE(offset);
    } else {
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
  private convertToRGBA(
    data: Buffer, width: number, height: number, format: PixelFormat
  ): Buffer {
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
  private fillRect(
    fb: Buffer, x: number, y: number, w: number, h: number,
    color: number[], fbWidth: number
  ): void {
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