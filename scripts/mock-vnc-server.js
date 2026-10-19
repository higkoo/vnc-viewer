/**
 * 本地测试用 Mock VNC 服务器
 *
 * 模拟 x11vnc/TigerVNC 行为（1280×800、RFB 3.8、None 认证、ZRLE 编码）：
 * - 整连接共用单一 zlib 流，逐矩形 Z_SYNC_FLUSH（RFC 6143 §7.7.6）；
 * - 全量帧拆分为 4 个水平带矩形；
 * - 增量请求时移动一个色块并只发送变化区域（验证持续更新链路）。
 *
 * 用法：node scripts/mock-vnc-server.js [端口]
 * 然后在 VNC Viewer 中连接 127.0.0.1:5977（无密码）。
 */
const net = require('net');
const zlib = require('zlib');

const PORT = parseInt(process.argv[2] || '5977', 10);
const W = 1280, H = 800;
const CPIXEL = 3;
const NAME = 'Mock Desktop (本地测试)';

// ---------- 真值帧缓冲 ----------
const truth = Buffer.alloc(W * H * 4);
function fillRect(x, y, w, h, r, g, b) {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      if (row < 0 || row >= H || col < 0 || col >= W) continue;
      const i = (row * W + col) * 4;
      truth[i] = r; truth[i + 1] = g; truth[i + 2] = b; truth[i + 3] = 255;
    }
  }
}
function drawScene() {
  for (let i = 0; i < truth.length; i += 4) {
    truth[i] = 0x10; truth[i + 1] = 0x14; truth[i + 2] = 0x1e; truth[i + 3] = 255;
  }
  fillRect(0, 0, W, 22, 0xe8, 0xe8, 0xe8);            // 顶部白条
  fillRect(0, 0, 300, 22, 0x35, 0x7c, 0xf0);          // 左上蓝色块
  fillRect(160, 390, 1080, 36, 0x35, 0x7c, 0xf0);     // 中部蓝色按钮
  fillRect(110, 450, 1130, 2, 0xff, 0xff, 0xff);      // 细白线
  fillRect(W - 12, 0, 12, H, 0xd0, 0xd0, 0xd0);       // 右侧滚动条
  // 移动色块（增量更新目标）
  fillRect(moverX, 120, 60, 60, 0x2e, 0xd5, 0x73);
}
let moverX = 100;

// ---------- ZRLE 编码（RFC 6143 格式）----------
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

function encodeTilesRaw(x, y, w, h) {
  const tiles = [];
  for (let ty = 0; ty < h; ty += 64) {
    for (let tx = 0; tx < w; tx += 64) {
      tiles.push(encodeTile(x + tx, y + ty, Math.min(64, w - tx), Math.min(64, h - ty)));
    }
  }
  return Buffer.concat(tiles);
}

// ---------- 共享 zlib 流（每连接一个，串行编码）----------
function createConnectionState() {
  const state = {
    deflate: zlib.createDeflate({ flush: zlib.constants.Z_NO_FLUSH }),
    pending: [],
    chain: Promise.resolve(),
  };
  state.deflate.on('data', (c) => state.pending.push(c));
  return state;
}

function zrleRect(st, x, y, w, h) {
  return new Promise((resolve) => {
    const before = st.pending.length;
    st.deflate.write(encodeTilesRaw(x, y, w, h));
    st.deflate.flush(zlib.constants.Z_SYNC_FLUSH, () => {
      setImmediate(() => setImmediate(() => {
        const chunks = st.pending.splice(before);
        const comp = Buffer.concat(chunks);
        const out = Buffer.alloc(4 + comp.length);
        out.writeUInt32BE(comp.length, 0);
        comp.copy(out, 4);
        resolve(out);
      }));
    });
  });
}

function sendUpdate(st, sock, rects) {
  st.chain = st.chain.then(async () => {
    const parts = [];
    const hdr = Buffer.alloc(4);
    hdr.writeUInt16BE(rects.length, 2);
    parts.push(hdr);
    for (const [x, y, w, h] of rects) {
      const rh = Buffer.alloc(12);
      rh.writeUInt16BE(x, 0); rh.writeUInt16BE(y, 2);
      rh.writeUInt16BE(w, 4); rh.writeUInt16BE(h, 6);
      rh.writeInt32BE(16, 8);
      parts.push(rh, await zrleRect(st, x, y, w, h));
    }
    sock.write(Buffer.concat(parts));
  }).catch(() => {});
  return st.chain;
}

// ---------- 服务器 ----------
const server = net.createServer((sock) => {
  const st = createConnectionState();
  let buf = Buffer.alloc(0);
  let stage = 'version';
  console.log(`[MOCK] 客户端连接 ${sock.remoteAddress}:${sock.remotePort}`);
  sock.write(Buffer.from('RFB 003.008\n', 'ascii'));

  sock.on('data', (data) => {
    buf = Buffer.concat([buf, data]);
    let progress = true;
    while (progress) {
      progress = false;
      if (stage === 'version' && buf.length >= 12) {
        buf = buf.subarray(12);
        sock.write(Buffer.from([1, 1])); // 1 个安全类型: None
        stage = 'init';
        progress = true;
      } else if (stage === 'init' && buf.length >= 1) {
        buf = buf.subarray(1);
        const name = Buffer.from(NAME);
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
            console.log(`[MOCK] SetEncodings (${n} 项)`);
            buf = buf.subarray(4 + n * 4);
          } else if (t === 0) {
            if (buf.length < 20) break;
            buf = buf.subarray(20);
          } else if (t === 3) {
            if (buf.length < 10) break;
            const incr = buf[1];
            buf = buf.subarray(10);
            if (incr === 0) {
              console.log('[MOCK] 全量帧请求 → 4 带 ZRLE');
              sendUpdate(st, sock, [[0, 0, W, 200], [0, 200, W, 200], [0, 400, W, 200], [0, 600, W, 200]]);
            } else {
              // 增量：移动色块，发送新旧位置的并集区域
              const oldX = moverX;
              moverX += 12;
              if (moverX > W - 80) moverX = 60;
              drawScene();
              const x0 = Math.max(0, Math.min(oldX, moverX) - 64);
              const x1 = Math.min(W, Math.max(oldX, moverX) + 60 + 64);
              sendUpdate(st, sock, [[x0, 56, x1 - x0, 128]]);
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
  sock.on('close', () => console.log('[MOCK] 客户端断开'));
});

drawScene();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[MOCK] VNC 服务器已启动: 127.0.0.1:${PORT}  (${W}x${H}, ZRLE, 无密码)`);
  console.log('[MOCK] 在 VNC Viewer 中连接该地址即可；绿色方块会随时间移动（验证增量更新）');
});
