/**
 * ZRLE 链路单元调试：直接驱动 EncodingDecoders.feedZrle
 */
const zlib = require('zlib');
const path = require('path');
const { EncodingDecoders } = require(path.join(__dirname, '..', 'dist', 'rfb', 'encodings'));
const { EncodingType } = require(path.join(__dirname, '..', 'dist', 'rfb', 'types'));

const fmt = {
  bitsPerPixel: 32, depth: 24, bigEndian: false, trueColor: true,
  redMax: 255, greenMax: 255, blueMax: 255,
  redShift: 16, greenShift: 8, blueShift: 0,
};

const W = 128, H = 128; // 2x2 tiles
// 真值：左上 64x64 纯红，右上 64x64 纯绿，左下 64x64 纯蓝，右下 64x64 白
const truth = Buffer.alloc(W * H * 4);
function fill(x, y, w, h, r, g, b) {
  for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
    const i = (row * W + col) * 4;
    truth[i] = r; truth[i + 1] = g; truth[i + 2] = b; truth[i + 3] = 255;
  }
}
fill(0, 0, 64, 64, 255, 0, 0);
fill(64, 0, 64, 64, 0, 255, 0);
fill(0, 64, 64, 64, 0, 0, 255);
fill(64, 64, 64, 64, 255, 255, 255);

// 编码：全部用 solid tile
const tiles = [];
for (let ty = 0; ty < H; ty += 64) {
  for (let tx = 0; tx < W; tx += 64) {
    const i = (ty * W + tx) * 4;
    tiles.push(Buffer.from([1, truth[i + 2], truth[i + 1], truth[i]]));
  }
}
const comp = zlib.deflateSync(Buffer.concat(tiles));
// 注意：feedZrle 接收的是去掉 4 字节长度前缀的纯压缩数据（与 client.ts 一致）
const payload = comp;

console.log('ZRLE compressed payload:', payload.length, 'bytes');

const dec = new EncodingDecoders();
let emitted = [];
dec.feedZrle(payload, 0, 0, W, H, fmt, (rect) => emitted.push(rect));

// 解压输出异步到达，等待若干事件循环轮次
setTimeout(() => {
  console.log('emitted rects:', emitted.length);

  if (emitted.length) {
    const px = emitted[0].data;
    let ok = 0, bad = 0;
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      if (px[o] === truth[o] && px[o + 1] === truth[o + 1] && px[o + 2] === truth[o + 2] && px[o + 3] === 255) ok++;
      else { bad++; if (bad <= 3) console.log(`  差异 (${i % W},${Math.floor(i / W)}) got=[${px[o]},${px[o+1]},${px[o+2]}] want=[${truth[o]},${truth[o+1]},${truth[o+2]}]`); }
    }
    console.log(`像素: ${ok} 对, ${bad} 错`);
    console.log(bad === 0 ? '*** solid tile PASS ***' : '*** solid tile FAIL ***');
    process.exit(bad === 0 ? 0 : 1);
  } else {
    console.log('*** FAIL: 无 rect 输出 ***');
    process.exit(1);
  }
}, 500);
