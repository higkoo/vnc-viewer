/**
 * 端到端复现测试：模拟 x11vnc/TigerVNC 服务器（1280×800、ZRLE 编码），
 * 驱动真实 RfbClient，装配渲染端帧缓冲并与服务器真值逐像素比对。
 *
 * 服务器行为严格按 RFC 6143 §7.7.6：
 * - 整个连接共用单一 zlib 流，逐矩形 Z_SYNC_FLUSH；
 * - tile RLE：长度 1 为裸索引，长度 >1 为 [索引|0x80] + (长度-1) 的 255 分段；
 * - 整帧拆分为多个 ZRLE 矩形（分带，真实服务器行为）。
 *
 * 用法：node scripts/e2e-render-test.js
 */
const net = require('net');
const zlib = require('zlib');
const path = require('path');

const { RfbClient } = require(path.join(__dirname, '..', 'dist', 'rfb', 'client'));

const PORT = 5977;
const W = 1280, H = 800;
const CPIXEL = 3;

// ---------- 服务器真值帧缓冲（RGBA）----------
const truth = Buffer.alloc(W * H * 4);
function fillRect(x, y, w, h, r, g, b) {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      const i = (row * W + col) * 4;
      truth[i] = r; truth[i + 1] = g; truth[i + 2] = b; truth[i + 3] = 255;
    }
  }
}
for (let i = 0; i < truth.length; i += 4) { truth[i] = 0x10; truth[i + 1] = 0x14; truth[i + 2] = 0x1e; truth[i + 3] = 255; }
fillRect(0, 0, W, 18, 0xee, 0xee, 0xee);          // 顶部白条
fillRect(160, 390, 1080, 32, 0x35, 0x7c, 0xf0);   // 中部蓝色按钮
fillRect(110, 440, 1130, 2, 0xff, 0xff, 0xff);    // 细白线
fillRect(W - 10, 0, 10, H, 0xd0, 0xd0, 0xd0);     // 右侧滚动条
for (let i = 0; i < 3000; i++) {                   // 噪点纹理
  const px = Math.floor(Math.random() * W), py = Math.floor(Math.random() * H);
  const idx = (py * W + px) * 4;
  truth[idx] = (truth[idx] + 37) & 0xff;
}

// ---------- ZRLE 编码器（服务端用，RFC 6143 §7.7.5/7.7.6 格式）----------
function cpixel(r, g, b) { return Buffer.from([b & 0xff, g & 0xff, r & 0xff]); }

function encodeTile(tx, ty, tw, th) {
  const colors = new Map();
  for (let row = 0; row < th; row++) {
    for (let col = 0; col < tw; col++) {
      const i = ((ty + row) * W + tx + col) * 4;
      const key = (truth[i] << 16) | (truth[i + 1] << 8) | truth[i + 2];
      colors.set(key, (colors.get(key) || 0) + 1);
    }
  }
  const distinct = [...colors.keys()];
  if (distinct.length === 1) {
    const key = distinct[0];
    return Buffer.concat([Buffer.from([1]), cpixel((key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff)]);
  }
  if (distinct.length <= 16) {
    // palette + RLE（RFC：长度 1 裸索引；>1 为 [索引|0x80]+(长度-1) 的 255 分段）
    const palette = distinct.map(k => cpixel((k >> 16) & 0xff, (k >> 8) & 0xff, k & 0xff));
    const indexOf = new Map(distinct.map((k, i) => [k, i]));
    const out = [Buffer.from([distinct.length | 0x80]), ...palette];
    let runIdx = -1, runLen = 0;
    const flushRun = () => {
      if (runLen === 0) return;
      if (runLen === 1) {
        out.push(Buffer.from([runIdx]));
      } else {
        out.push(Buffer.from([runIdx | 0x80]));
        const lenBuf = [];
        let v = runLen - 1;
        while (v >= 255) { lenBuf.push(255); v -= 255; }
        lenBuf.push(v);
        out.push(Buffer.from(lenBuf));
      }
    };
    for (let row = 0; row < th; row++) {
      for (let col = 0; col < tw; col++) {
        const i = ((ty + row) * W + tx + col) * 4;
        const key = (truth[i] << 16) | (truth[i + 1] << 8) | truth[i + 2];
        const idx = indexOf.get(key);
        if (idx === runIdx) { runLen++; }
        else { flushRun(); runIdx = idx; runLen = 1; }
      }
    }
    flushRun();
    return Buffer.concat(out);
  }
  // raw tile
  const pix = Buffer.alloc(tw * th * CPIXEL);
  for (let row = 0; row < th; row++) {
    for (let col = 0; col < tw; col++) {
      const i = ((ty + row) * W + tx + col) * 4;
      const o = (row * tw + col) * CPIXEL;
      pix[o] = truth[i + 2]; pix[o + 1] = truth[i + 1]; pix[o + 2] = truth[i];
    }
  }
  return Buffer.concat([Buffer.from([0]), pix]);
}

/** 编码一个矩形区域的 tile 数据（未压缩） */
function encodeTilesRaw(x, y, w, h) {
  const tiles = [];
  for (let ty = 0; ty < h; ty += 64) {
    for (let tx = 0; tx < w; tx += 64) {
      tiles.push(encodeTile(x + tx, y + ty, Math.min(64, w - tx), Math.min(64, h - ty)));
    }
  }
  return Buffer.concat(tiles);
}

// ---------- Mock 服务器 ----------
// 共享 zlib 流（RFC 6143 7.7.6：整连接单一流，逐矩形 Z_SYNC_FLUSH）
const deflate = zlib.createDeflate({ flush: zlib.constants.Z_NO_FLUSH });
const pendingChunks = [];   // 已产出但尚未发送的压缩字节（异步到达）
deflate.on('data', (c) => pendingChunks.push(c));

/** 写入一个 ZRLE 矩形：tile 数据过共享 deflate 流，flush 完成（回调）后取出压缩字节 */
function zrleRect(x, y, w, h) {
  return new Promise((resolve) => {
    const before = pendingChunks.length;
    deflate.write(encodeTilesRaw(x, y, w, h));
    deflate.flush(zlib.constants.Z_SYNC_FLUSH, () => {
      // flush 回调后再等两轮，确保 'data' 事件全部派发完毕
      setImmediate(() => setImmediate(() => {
        const chunks = pendingChunks.splice(before);
        const comp = Buffer.concat(chunks);
        const out = Buffer.alloc(4 + comp.length);
        out.writeUInt32BE(comp.length, 0);
        comp.copy(out, 4);
        resolve(out);
      }));
    });
  });
}

/** 发送一个 FramebufferUpdate（numRects 个 ZRLE 矩形）。
 *  共享 deflate 流上的编码必须串行（真实服务器行为），用队列保证顺序。 */
let sendChain = Promise.resolve();
function sendZrleUpdate(sock, rects) {
  sendChain = sendChain.then(async () => {
    const parts = [];
    const hdr = Buffer.alloc(4);
    hdr.writeUInt16BE(rects.length, 2);
    parts.push(hdr);
    for (const [x, y, w, h] of rects) {
      const rh = Buffer.alloc(12);
      rh.writeUInt16BE(x, 0); rh.writeUInt16BE(y, 2);
      rh.writeUInt16BE(w, 4); rh.writeUInt16BE(h, 6);
      rh.writeInt32BE(16, 8); // ZRLE
      parts.push(rh, await zrleRect(x, y, w, h));
    }
    sock.write(Buffer.concat(parts));
    console.log(`[SERVER] 已发送 ZRLE 更新: ${rects.length} 个矩形`);
  }).catch((e) => console.log('[SERVER] send error:', e.message));
  return sendChain;
}

const server = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  let stage = 'version';
  sock.write(Buffer.from('RFB 003.008\n', 'ascii'));

  sock.on('data', (data) => {
    buf = Buffer.concat([buf, data]);
    let progress = true;
    while (progress) {
      progress = false;
      if (stage === 'version' && buf.length >= 12) {
        buf = buf.subarray(12);
        sock.write(Buffer.from([1, 1]));
        stage = 'init';
        progress = true;
      } else if (stage === 'init' && buf.length >= 1) {
        buf = buf.subarray(1);
        const name = Buffer.from('Dify0 (root)');
        const si = Buffer.alloc(24 + name.length);
        si.writeUInt16BE(W, 0); si.writeUInt16BE(H, 2);
        si[4] = 32; si[5] = 24; si[6] = 0; si[7] = 1;
        si.writeUInt16BE(255, 8); si.writeUInt16BE(255, 10); si.writeUInt16BE(255, 12);
        si[14] = 16; si[15] = 8; si[16] = 0;
        si.writeUInt32BE(name.length, 20);
        name.copy(si, 24);
        sock.write(si);
        stage = 'connected';
        progress = true;
      } else if (stage === 'connected') {
        while (buf.length >= 1) {
          const t = buf[0];
          if (t === 2) {
            if (buf.length < 4) break;
            const n = buf.readUInt16BE(2);
            if (buf.length < 4 + n * 4) break;
            buf = buf.subarray(4 + n * 4);
          } else if (t === 0) {
            if (buf.length < 20) break;
            buf = buf.subarray(20);
          } else if (t === 3) {
            if (buf.length < 10) break;
            const incr = buf[1];
            const rx = buf.readUInt16BE(2), ry = buf.readUInt16BE(4);
            const rw = buf.readUInt16BE(6), rh = buf.readUInt16BE(8);
            buf = buf.subarray(10);
            console.log(`[SERVER] FBUR incr=${incr} rect=(${rx},${ry},${rw},${rh})`);
            if (incr === 0) {
              // 全量：分 4 个水平带（真实服务器的多矩形行为）
              sendZrleUpdate(sock, [[0, 0, W, 200], [0, 200, W, 200], [0, 400, W, 200], [0, 600, W, 200]]);
            } else {
              // 增量：细白线区域
              sendZrleUpdate(sock, [[110, 440, 1130, 2]]);
            }
          } else if (t === 4) {
            if (buf.length < 8) break;
            buf = buf.subarray(8);
          } else if (t === 5) {
            if (buf.length < 6) break;
            buf = buf.subarray(6);
          } else {
            buf = buf.subarray(1);
          }
        }
      }
    }
  });
  sock.on('error', () => {});
});

// ---------- 客户端 ----------
const client = new RfbClient();
let fbCanvas = null;
const rectStats = { total: 0, byEncoding: {} };
let frameDoneCount = 0;

client.on('framebuffer-update', (rect) => {
  if (!fbCanvas) fbCanvas = Buffer.alloc(W * H * 4);
  rectStats.total++;
  rectStats.byEncoding[rect.encoding] = (rectStats.byEncoding[rect.encoding] || 0) + 1;
  const data = rect.data instanceof Uint8Array ? rect.data : Buffer.from(rect.data);
  if (rect.encoding === 1) {
    const srcX = (data[0] << 8) | data[1], srcY = (data[2] << 8) | data[3];
    for (let row = 0; row < rect.height; row++) {
      const so = ((srcY + row) * W + srcX) * 4, dof = ((rect.y + row) * W + rect.x) * 4;
      fbCanvas.copyWithin(dof, so, so + rect.width * 4);
    }
    return;
  }
  const x = Math.max(0, rect.x), y = Math.max(0, rect.y);
  const w = Math.min(rect.width, W - x), h = Math.min(rect.height, H - y);
  const skipX = x - rect.x, skipY = y - rect.y;
  for (let row = 0; row < h; row++) {
    const srcStart = ((skipY + row) * rect.width + skipX) * 4;
    data.copy(fbCanvas, (y + row) * W * 4 + x * 4, srcStart, srcStart + w * 4);
  }
});
client.on('framebuffer-done', () => { frameDoneCount++; });
client.on('error', (e) => console.log('[CLIENT] error:', e));
client.on('server-info', (info) => {
  console.log(`[CLIENT] ServerInit: ${info.width}x${info.height} name="${info.name}"`);
  fbCanvas = Buffer.alloc(W * H * 4);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[TEST] mock server on ${PORT}（共享 zlib 流 + 多矩形 ZRLE）`);
  client.connect({ host: '127.0.0.1', port: PORT, password: '', shared: true });

  setTimeout(() => {
    console.log('\n===== 验证 =====');
    console.log(`framebuffer-done 次数: ${frameDoneCount}`);
    console.log(`渲染 rect 数: ${rectStats.total}, 按编码: ${JSON.stringify(rectStats.byEncoding)}`);
    if (!fbCanvas) { console.log('FATAL: fbCanvas 未初始化'); process.exit(1); }

    let diff = 0; const firstDiffs = [];
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      if (fbCanvas[o] !== truth[o] || fbCanvas[o + 1] !== truth[o + 1] || fbCanvas[o + 2] !== truth[o + 2]) {
        diff++;
        if (firstDiffs.length < 5) {
          firstDiffs.push(`(${i % W},${Math.floor(i / W)}) got=[${fbCanvas[o]},${fbCanvas[o+1]},${fbCanvas[o+2]}] want=[${truth[o]},${truth[o+1]},${truth[o+2]}]`);
        }
      }
    }
    console.log(`像素差异: ${diff}/${W * H} (${(100 * diff / (W * H)).toFixed(2)}%)`);
    if (firstDiffs.length) console.log('首批差异: ' + firstDiffs.join(' | '));

    let nonBlack = 0;
    for (let i = 0; i < fbCanvas.length; i += 4) {
      if (fbCanvas[i] || fbCanvas[i + 1] || fbCanvas[i + 2]) nonBlack++;
    }
    console.log(`帧缓冲非黑像素: ${nonBlack}/${W * H}`);

    const pass = diff === 0;
    console.log(pass ? '\n*** PASS: 帧缓冲与服务器真值完全一致 ***' : '\n*** FAIL ***');
    try { client.disconnect(); } catch (e) {}
    server.close();
    process.exit(pass ? 0 : 1);
  }, 6000);
});
