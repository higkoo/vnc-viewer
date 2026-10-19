/**
 * CoRRE / Hextile(UltraVNC 扩展) 解码器 sanity 测试
 * 验证 REA 反编译结论落地后的解码正确性。
 * 运行: node scripts/decoder-sanity-test.js
 *
 * 注意：px(b,g,r) 生成 32bpp BGRX 线序像素；解码器输出为 RGBA，
 * 因此 px(b,g,r) 对应 RGBA [r,g,b,255]。
 */
const zlib = require('zlib');
const path = require('path');

const { EncodingDecoders } = require(path.join(__dirname, '..', 'dist', 'rfb', 'encodings.js'));
const { EncodingType } = require(path.join(__dirname, '..', 'dist', 'rfb', 'types.js'));

const decoders = new EncodingDecoders();
const fmt = {
  bitsPerPixel: 32, depth: 24, bigEndian: false, trueColor: true,
  redMax: 255, greenMax: 255, blueMax: 255,
  redShift: 16, greenShift: 8, blueShift: 0,
};

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}
/** 写一个 32bpp BGRX 像素（线序 B,G,R,X） */
function px(b, g, r) { return Buffer.from([b, g, r, 0]); }
/** px(b,g,r) 解码后的期望 RGBA */
function rgba(b, g, r) { return [r, g, b, 255]; }

// ============ 1. CoRRE（UltraVNC 紧凑格式）============
console.log('== CoRRE (UltraVNC compact) ==');
{
  const w = 20, h = 10;
  // 背景 px(200,100,50) => RGBA [50,100,200]
  // 子矩形1: px(0,0,255) 红色 => RGBA [255,0,0], x=2,y=1,w=5,h=3
  // 子矩形2: px(0,255,0) 绿色 => RGBA [0,255,0], x=10,y=4,w=6,h=4
  const buf = Buffer.alloc(4 + 4 + 2 * (4 + 4));
  let o = 0;
  buf.writeUInt32BE(2, o); o += 4;
  px(200, 100, 50).copy(buf, o); o += 4;
  px(0, 0, 255).copy(buf, o); o += 4;
  buf[o++] = 2; buf[o++] = 1; buf[o++] = 5; buf[o++] = 3;
  px(0, 255, 0).copy(buf, o); o += 4;
  buf[o++] = 10; buf[o++] = 4; buf[o++] = 6; buf[o++] = 4;

  const res = decoders.decode(buf, 0, EncodingType.CoRRE, w, h, fmt);
  check('CoRRE 解码成功', res !== null);
  if (res) {
    check('CoRRE consumed 正确', res.consumed === 4 + 4 + 2 * 8);
    const at = (x, y) => { const i = (y * w + x) * 4; return [res.pixels[i], res.pixels[i + 1], res.pixels[i + 2], res.pixels[i + 3]]; };
    check('CoRRE 背景色 (0,0)', JSON.stringify(at(0, 0)) === JSON.stringify(rgba(200, 100, 50)));
    check('CoRRE 子矩形1 中心 (4,2)', JSON.stringify(at(4, 2)) === JSON.stringify(rgba(0, 0, 255)));
    check('CoRRE 子矩形2 中心 (13,6)', JSON.stringify(at(13, 6)) === JSON.stringify(rgba(0, 255, 0)));
    check('CoRRE 子矩形1 外 (8,1) 仍为背景', JSON.stringify(at(8, 1)) === JSON.stringify(rgba(200, 100, 50)));
    check('CoRRE 输出尺寸', res.pixels.length === w * h * 4);
  }
}

// ---- CoRRE: 0 子矩形（纯背景）----
{
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(0, 0);
  px(10, 20, 30).copy(buf, 4);
  const res = decoders.decode(buf, 0, EncodingType.CoRRE, 4, 4, fmt);
  check('CoRRE 零子矩形', res !== null && res.consumed === 8 &&
    JSON.stringify([res.pixels[0], res.pixels[1], res.pixels[2], res.pixels[3]]) === JSON.stringify(rgba(10, 20, 30)));
}

// ---- CoRRE: RFC zlib 格式应被拒绝（返回 null）----
{
  const w = 4, h = 4;
  const fakeZlib = Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
  const buf = Buffer.concat([Buffer.from([0, 0, 0, 1]), px(0, 0, 0), fakeZlib]);
  const res = decoders.decode(buf, 0, EncodingType.CoRRE, w, h, fmt);
  check('CoRRE 拒绝 RFC zlib 格式', res === null);
}

// ---- CoRRE: 子矩形坐标越界应被裁剪（不写越界、不抛异常）----
{
  const w = 8, h = 8;
  const buf = Buffer.alloc(4 + 4 + 4 + 4);
  buf.writeUInt32BE(1, 0);
  px(0, 0, 0).copy(buf, 4);
  px(1, 2, 3).copy(buf, 8);
  buf[12] = 6; buf[13] = 6; buf[14] = 10; buf[15] = 10;  // 超出 8x8
  const res = decoders.decode(buf, 0, EncodingType.CoRRE, w, h, fmt);
  check('CoRRE 越界裁剪', res !== null && res.consumed === 16);
}

// ============ 2. Hextile UltraVNC 扩展（0x20 zlibRaw / 0x40 zlibTile）============
console.log('== Hextile (UltraVNC zlib extensions) ==');
{
  const w = 16, h = 16;
  // 0x20: zlib 压缩的原始像素。UltraVNC 32bpp 变体每像素 4 字节（BGRX）
  const raw = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { raw[i * 4] = 111; raw[i * 4 + 1] = 122; raw[i * 4 + 2] = 133; raw[i * 4 + 3] = 0; }
  const comp = zlib.deflateSync(raw);
  const lenBuf = Buffer.alloc(2); lenBuf.writeUInt16BE(comp.length, 0);
  const buf = Buffer.concat([Buffer.from([0x20]), lenBuf, comp]);
  const res = decoders.decode(buf, 0, EncodingType.Hextile, w, h, fmt);
  check('Hextile 0x20 解码成功', res !== null);
  if (res) {
    check('Hextile 0x20 consumed', res.consumed === 3 + comp.length);
    check('Hextile 0x20 像素', JSON.stringify([res.pixels[0], res.pixels[1], res.pixels[2], res.pixels[3]]) === JSON.stringify(rgba(111, 122, 133)));
  }
}
{
  const w = 16, h = 16;
  // 0x40: zlib 压缩的标准 tile 体。subEnc = 0x42 (0x40|bgSpecified)，
  // 压缩数据仅含 bg 像素（不含子编码字节，与 UltraVNC 解码器一致）
  const tileBody = px(7, 8, 9);
  const comp = zlib.deflateSync(tileBody);
  const lenBuf = Buffer.alloc(2); lenBuf.writeUInt16BE(comp.length, 0);
  const buf = Buffer.concat([Buffer.from([0x42]), lenBuf, comp]);
  const res = decoders.decode(buf, 0, EncodingType.Hextile, w, h, fmt);
  check('Hextile 0x40 解码成功', res !== null);
  if (res) {
    check('Hextile 0x40 像素', JSON.stringify([res.pixels[0], res.pixels[1], res.pixels[2], res.pixels[3]]) === JSON.stringify(rgba(7, 8, 9)));
  }
}

// ---- Hextile 标准: bg 跨 tile 延续 ----
{
  const w = 32, h = 16;
  // tile0: bgSpecified(0x02) + bg(px(1,2,3) => RGBA [3,2,1])
  // tile1 (16,0): 无位（纯延续背景，应仍为该颜色）
  const buf = Buffer.concat([Buffer.from([0x02]), px(1, 2, 3), Buffer.from([0x00])]);
  const res = decoders.decode(buf, 0, EncodingType.Hextile, w, h, fmt);
  check('Hextile bg 跨 tile 延续', res !== null &&
    JSON.stringify([res.pixels[(1 * 32 + 17) * 4], res.pixels[(1 * 32 + 17) * 4 + 1], res.pixels[(1 * 32 + 17) * 4 + 2]]) ===
    JSON.stringify(rgba(1, 2, 3).slice(0, 3)));
}

// ---- Hextile 标准: Raw tile ----
{
  const w = 16, h = 16;
  const raw = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { raw[i * 4] = 5; raw[i * 4 + 1] = 6; raw[i * 4 + 2] = 7; }
  const buf = Buffer.concat([Buffer.from([0x01]), raw]);
  const res = decoders.decode(buf, 0, EncodingType.Hextile, w, h, fmt);
  check('Hextile Raw tile', res !== null && res.consumed === 1 + raw.length &&
    JSON.stringify([res.pixels[0], res.pixels[1], res.pixels[2], res.pixels[3]]) === JSON.stringify(rgba(5, 6, 7)));
}

// ============ 3. RRE（RFC 2 字节坐标）============
console.log('== RRE (RFC 6143) ==');
{
  const w = 20, h = 10;
  const buf = Buffer.alloc(4 + 4 + 1 * (4 + 8));
  let o = 0;
  buf.writeUInt32BE(1, o); o += 4;
  px(1, 1, 1).copy(buf, o); o += 4;
  px(9, 9, 9).copy(buf, o); o += 4;
  buf.writeUInt16BE(3, o); o += 2;
  buf.writeUInt16BE(2, o); o += 2;
  buf.writeUInt16BE(5, o); o += 2;
  buf.writeUInt16BE(4, o); o += 2;
  const res = decoders.decode(buf, 0, EncodingType.RRE, w, h, fmt);
  check('RRE 解码成功', res !== null);
  if (res) {
    const i = (2 * w + 3 + 1) * 4;
    check('RRE 子矩形像素', JSON.stringify([res.pixels[i], res.pixels[i + 1], res.pixels[i + 2]]) === JSON.stringify(rgba(9, 9, 9).slice(0, 3)));
    check('RRE 背景像素', JSON.stringify([res.pixels[0], res.pixels[1], res.pixels[2]]) === JSON.stringify(rgba(1, 1, 1).slice(0, 3)));
  }
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
