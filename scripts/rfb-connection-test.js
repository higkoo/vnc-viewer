/**
 * RFB 客户端核心链路集成测试（无需 Electron / 真实 VNC 服务器）。
 *
 * 在本机启动极简 RFB 3.8 模拟服务器，用真实 RfbClient 连接，串行验证：
 *   - None 认证握手 → ServerInit → Raw 编码 FramebufferUpdate 解码
 *   - VncAuth（密码）认证握手（16B 挑战/16B 响应/4B 结果）→ ServerInit → 解码
 *
 * 运行方式：node scripts/rfb-connection-test.js
 */

const net = require('net');
const crypto = require('crypto');
const assert = require('assert');
const { RfbClient } = require('../dist/rfb/client');
const { desEcbEncrypt } = require('../dist/rfb/des');

const WIDTH = 32;
const HEIGHT = 24;
const PORT = 55900;
// 32bpp 小端真彩色, redShift=16, greenShift=8, blueShift=0
const PIXEL_FORMAT = Buffer.from([
  32, 24, 0, 1,                        // bpp, depth, bigEndian=0, trueColor=1
  0x00, 0xff, 0x00, 0xff, 0x00, 0xff,  // redMax, greenMax, blueMax (255, 大端)
  16, 8, 0, 0,                         // redShift, greenShift, blueShift, pad
  0x00, 0x00,                          // pad
]);

function makePixel(r, g, b) {
  // 32bpp 真彩色 little-endian: value = (r<<16)|(g<<8)|b
  const v = (r << 16) | (g << 8) | b;
  return Buffer.from([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, 0xff]);
}

function buildPixelData() {
  // 渐变，便于断言：首个像素纯红，第二个纯绿，第三个纯蓝
  const data = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      let px;
      if (x === 0 && y === 0) px = makePixel(255, 0, 0);
      else if (x === 1 && y === 0) px = makePixel(0, 255, 0);
      else if (x === 2 && y === 0) px = makePixel(0, 0, 255);
      else px = makePixel((y * 10) % 256, (x * 7) % 256, 128);
      px.copy(data, (y * WIDTH + x) * 4);
    }
  }
  return data;
}

function buildRawFrame() {
  const numRects = 1;
  const enc = 0; // Raw
  const pixels = buildPixelData();
  const buf = Buffer.alloc(1 + 1 + 2 + 12 + pixels.length);
  buf[0] = 0;                // server msg type = FramebufferUpdate
  buf[1] = 0;                // padding
  buf.writeUInt16BE(numRects, 2);
  buf.writeUInt16BE(0, 4);   // x
  buf.writeUInt16BE(0, 6);   // y
  buf.writeUInt16BE(WIDTH, 8);
  buf.writeUInt16BE(HEIGHT, 10);
  buf.writeUInt32BE(enc, 12);
  pixels.copy(buf, 16);
  return buf;
}

/**
 * 启动一个模拟 RFB 3.8 服务器。
 * @param auth 'none' | 'vnc'
 * @param password VncAuth 期望的密码（用于校验响应）
 */
function startMockServer(auth, password) {
  const server = net.createServer((sock) => {
    let state = 'version';
    let recv = Buffer.alloc(0);
    let challenge = null;

    sock.write(Buffer.from('RFB 003.008\n', 'ascii'));

    // 客户端一次可能并发多条消息，必须循环消化 recv 才能推进状态，否则死锁。
    sock.on('data', (chunk) => {
      recv = Buffer.concat([recv, chunk]);
      pump();
    });

    function sendServerInit() {
      const name = Buffer.from('mock');
      const header = Buffer.alloc(24);
      header.writeUInt16BE(WIDTH, 0);
      header.writeUInt16BE(HEIGHT, 2);
      PIXEL_FORMAT.copy(header, 4);
      header.writeUInt32BE(name.length, 20);
      sock.write(Buffer.concat([header, name]));
    }

    function reverseBits(b) {
      let r = 0;
      for (let i = 0; i < 8; i++) r = (r << 1) | ((b >> i) & 1);
      return r;
    }

    function pump() {
      let progressed = true;
      while (progressed) {
        progressed = false;

        if (state === 'version' && recv.length >= 12) {
          assert.strictEqual(recv.subarray(0, 12).toString('ascii'),
            'RFB 003.008\n', '客户端应协商 3.8');
          recv = recv.subarray(12);
          state = 'secCount';
          const types = auth === 'vnc' ? [2] : [1];
          sock.write(Buffer.from([types.length, ...types]));
          progressed = true;

        } else if (state === 'secCount' && recv.length >= 1) {
          const expectSel = auth === 'vnc' ? 2 : 1;
          assert.strictEqual(recv[0], expectSel, '客户端所选安全类型不匹配');
          recv = recv.subarray(1);
          if (auth === 'vnc') {
            state = 'challenge';
            // 服务器发送 16 字节挑战码
            challenge = crypto.randomBytes(16);
            sock.write(challenge);
          } else {
            state = 'clientInit';
          }
          progressed = true;

        } else if (state === 'challenge' && recv.length >= 16) {
          // 用标准 VNC DES 认证算法重算响应，与客户端发送值精确比对
          const resp = recv.subarray(0, 16);
          recv = recv.subarray(16);
          const key = Buffer.alloc(8);
          Buffer.from(password, 'utf8').copy(key, 0, 0, Math.min(password.length, 8));
          for (let i = 0; i < 8; i++) key[i] = reverseBits(key[i]);
          const expected = desEcbEncrypt(key, challenge);
          assert.deepStrictEqual([...resp], [...expected],
            '客户端 DES 认证响应与标准算法计算结果不一致');
          sock.write(Buffer.from([0, 0, 0, 0])); // 4 字节认证成功
          state = 'clientInit';
          progressed = true;

        } else if (state === 'clientInit' && recv.length >= 1) {
          recv = recv.subarray(1);
          state = 'waitingUpdate';
          sendServerInit();
          progressed = true;

        } else if (state === 'waitingUpdate') {
          // 忽略普通消息，直到见到 FramebufferUpdateRequest(type=3)
          const idx = recv.indexOf(3);
          if (idx === -1) { recv = Buffer.alloc(0); break; }
          recv = recv.subarray(idx + 10);
          state = 'done';
          sock.write(buildRawFrame());
          progressed = true;
        }
      }
    }
  });
  return server;
}

/** 运行一个认证场景，返回 Promise。在收到并校验 framebuffer 后 resolve。 */
async function testScenario(auth, password, label) {
  const server = startMockServer(auth, password);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  return await new Promise((resolve, reject) => {
    const client = new RfbClient();
    let gotServerInfo = false;
    let gotUpdate = false;

    const timer = setTimeout(() => reject(new Error('超时：未收到 framebuffer')), 8000);

    client.on('state', (s) => {
      if (s === 7) console.log('  [OK] 状态切换到 Connected (7)');
    });
    client.on('server-info', (info) => {
      gotServerInfo = true;
      assert.strictEqual(info.width, WIDTH);
      assert.strictEqual(info.height, HEIGHT);
      assert.strictEqual(info.name, 'mock');
    });
    client.on('framebuffer-update', (rect) => {
      clearTimeout(timer);
      gotUpdate = true;
      const data = rect.data;
      assert.deepStrictEqual([...data.subarray(0, 3)], [255, 0, 0], '第0像素应为红');
      assert.deepStrictEqual([...data.subarray(4, 7)], [0, 255, 0], '第1像素应为绿');
      assert.deepStrictEqual([...data.subarray(8, 11)], [0, 0, 255], '第2像素应为蓝');
      cleanup();
      console.log(`  [OK] ${label}：握手/ServerInit/Raw 解码链路正常。`);
      resolve(true);
    });
    client.on('error', (msg) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`${label} 连接失败: ${msg}`));
    });

    function cleanup() {
      try { server.close(); } catch (_) { /* ignore */ }
      try { client.disconnect(); } catch (_) { /* ignore */ }
    }

    client.connect({ host: '127.0.0.1', port: PORT, password, shared: false });
  });
}

async function main() {
  console.log('\n场景 1: RFB 3.8 + None 认证');
  await testScenario('none', '', 'None');

  console.log('\n场景 2: RFB 3.8 + VncAuth 密码认证');
  await testScenario('vnc', 'secret', 'VncAuth');

  console.log('\n全部断言通过。');
  process.exit(0);
}

main().catch((err) => {
  console.error('  [FAIL]', err.message);
  process.exit(1);
});