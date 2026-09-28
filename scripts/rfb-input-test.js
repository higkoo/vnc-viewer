/**
 * RFB 输入事件 + 持续帧接收测试
 * 
 * 模拟服务端：连接成功后持续推送变化的帧画面
 * 模拟客户端：发送键盘和鼠标事件
 * 
 * 验证：
 * 1. 服务端能持续推到多帧（验证帧请求机制正常）
 * 2. 客户端的输入事件能被服务端正确接收
 * 3. 长时间运行不会出现"卡住"的情况
 */

const net = require('net');
const assert = require('assert');
const { RfbClient } = require('../dist/rfb/client');

const WIDTH = 64;
const HEIGHT = 48;
const PORT = 55902;
const TEST_DURATION_MS = 5000; // 测试持续 5 秒

// 32bpp 小端真彩色
const PIXEL_FORMAT = Buffer.from([
  32, 24, 0, 1,
  0x00, 0xff, 0x00, 0xff, 0x00, 0xff,
  16, 8, 0, 0,
  0x00, 0x00,
]);

function buildPixel(r, g, b) {
  const v = (r << 16) | (g << 8) | b;
  return Buffer.from([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, 0xff]);
}

function buildPixelData(frameNum) {
  const data = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      // 让颜色随时间变化，验证画面确实在"刷新"
      const r = (frameNum * 3 + x * 4) % 256;
      const g = (frameNum * 5 + y * 3) % 256;
      const b = (frameNum * 7) % 256;
      const px = buildPixel(r, g, b);
      px.copy(data, (y * WIDTH + x) * 4);
    }
  }
  return data;
}

let receivedInputs = [];
let serverFrameCount = 0;

function startMockServer() {
  const server = net.createServer((sock) => {
    let state = 'version';
    let recv = Buffer.alloc(0);

    sock.write(Buffer.from('RFB 003.008\n', 'ascii'));

    sock.on('data', (chunk) => {
      recv = Buffer.concat([recv, chunk]);
      pump();
    });

    function sendServerInit() {
      const name = Buffer.from('test-server');
      const header = Buffer.alloc(24);
      header.writeUInt16BE(WIDTH, 0);
      header.writeUInt16BE(HEIGHT, 2);
      PIXEL_FORMAT.copy(header, 4);
      header.writeUInt32BE(name.length, 20);
      sock.write(Buffer.concat([header, name]));
    }

    function sendFrame() {
      serverFrameCount++;
      const numRects = 1;
      const pixels = buildPixelData(serverFrameCount);
      const buf = Buffer.alloc(1 + 1 + 2 + 12 + pixels.length);
      buf[0] = 0;
      buf[1] = 0;
      buf.writeUInt16BE(numRects, 2);
      buf.writeUInt16BE(0, 4);
      buf.writeUInt16BE(0, 6);
      buf.writeUInt16BE(WIDTH, 8);
      buf.writeUInt16BE(HEIGHT, 10);
      buf.writeUInt32BE(0, 12); // Raw
      pixels.copy(buf, 16);
      sock.write(buf);
    }

    function pump() {
      let progressed = true;
      while (progressed) {
        progressed = false;

        if (state === 'version' && recv.length >= 12) {
          recv = recv.subarray(12);
          sock.write(Buffer.from([1, 1])); // 1 个安全类型: None(1)
          state = 'secCount';
          progressed = true;

        } else if (state === 'secCount' && recv.length >= 1) {
          recv = recv.subarray(1);
          sock.write(Buffer.from([0, 0, 0, 0])); // 认证成功
          state = 'clientInit';
          progressed = true;

        } else if (state === 'clientInit' && recv.length >= 1) {
          recv = recv.subarray(1);
          state = 'waitingUpdate';
          sendServerInit();
          progressed = true;

        } else if (state === 'waitingUpdate') {
          // 解析所有消息
          while (recv.length >= 1) {
            const msgType = recv[0];
            
            if (msgType === 4 && recv.length >= 8) {
              // KeyEvent: type(1) + down(1) + pad(2) + keysym(4)
              const down = recv[1];
              const keysym = recv.readUInt32BE(4);
              receivedInputs.push({ type: 'key', down, keysym });
              console.log(`  [SERVER] 收到键盘事件: keysym=${keysym.toString(16)} down=${down}`);
              recv = recv.subarray(8);
              
            } else if (msgType === 5 && recv.length >= 6) {
              // PointerEvent: type(1) + mask(1) + x(2) + y(2)
              const mask = recv[1];
              const x = recv.readUInt16BE(2);
              const y = recv.readUInt16BE(4);
              receivedInputs.push({ type: 'pointer', mask, x, y });
              console.log(`  [SERVER] 收到鼠标事件: mask=${mask} pos=(${x},${y})`);
              recv = recv.subarray(6);
              
            } else if (msgType === 3 && recv.length >= 10) {
              // FramebufferUpdateRequest
              recv = recv.subarray(10);
              // 模拟服务端响应：发一帧
              sendFrame();
              
            } else {
              // 未知消息，跳一字节避免死循环
              console.log(`  [SERVER] 未知消息类型: ${msgType}`);
              recv = recv.subarray(1);
            }
          }
          progressed = true;
        }
      }
    }
  });
  return server;
}

async function main() {
  console.log('=== RFB 输入事件 + 持续帧接收测试 ===\n');
  
  const server = startMockServer();
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log(`[INFO] 模拟服务器监听 127.0.0.1:${PORT}`);

  const client = new RfbClient();
  
  let frameCount = 0;
  let lastFrameData = null;
  let connected = false;
  
  const results = {
    frames: 0,
    uniqueFrames: 0,
    keyEventsSent: 0,
    pointerEventsSent: 0,
    keyEventsReceived: 0,
    pointerEventsReceived: 0,
  };

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, TEST_DURATION_MS);

    client.on('state', (s) => {
      if (s === 7) {
        connected = true;
        console.log('[OK] 连接建立');
      }
    });

    client.on('server-info', (info) => {
      console.log(`[OK] ServerInfo: ${info.name} ${info.width}x${info.height}`);
    });

    client.on('framebuffer-update', (rect) => {
      frameCount++;
      results.frames++;
      
      // 检查画面有没有变化
      const dataHash = rect.data.subarray(0, 16).join(',');
      if (dataHash !== lastFrameData) {
        results.uniqueFrames++;
        lastFrameData = dataHash;
      }
      
      if (frameCount === 1 || frameCount % 50 === 0) {
        const firstPixel = [rect.data[0], rect.data[1], rect.data[2]];
        console.log(`[RECV] 帧 #${frameCount}: 首个像素 RGB=${firstPixel}`);
      }
    });

    client.on('error', (msg) => {
      console.error(`[ERROR] ${msg}`);
    });

    client.on('update-request', () => {
      // 帧请求发到服务端了
    });

    function cleanup() {
      clearTimeout(timeout);
      try { client.disconnect(); } catch(_) {}
      try { server.close(); } catch(_) {}
    }

    // 建立连接
    client.connect({ host: '127.0.0.1', port: PORT, password: '', shared: false });

    // 等连接建立后开始发送输入事件
    setTimeout(() => {
      if (!connected) {
        console.error('[FAIL] 连接未建立就超时了');
        cleanup();
        resolve();
        return;
      }

      console.log('\n[INFO] 开始发送输入事件...\n');

      // 模拟键盘事件：按 A 键（keyCode=65, keysym=0x41）
      setTimeout(() => {
        client.keyEvent(65, true);
        results.keyEventsSent++;
        console.log('[SEND] 键盘: A 按下');
      }, 100);

      setTimeout(() => {
        client.keyEvent(65, false);
        results.keyEventsSent++;
        console.log('[SEND] 键盘: A 释放');
      }, 300);

      // 模拟鼠标点击
      setTimeout(() => {
        client.pointerEvent(1, 100, 100); // 左键按下
        results.pointerEventsSent++;
        console.log('[SEND] 鼠标: 左键按下 (100,100)');
      }, 500);

      setTimeout(() => {
        client.pointerEvent(0, 100, 100); // 左键释放
        results.pointerEventsSent++;
        console.log('[SEND] 鼠标: 左键释放 (100,100)');
      }, 700);

      // 模拟鼠标移动
      setTimeout(() => {
        client.pointerEvent(0, 200, 150);
        results.pointerEventsSent++;
        console.log('[SEND] 鼠标: 移动 (200,150)');
      }, 900);

      // 模拟 Ctrl+C
      setTimeout(() => {
        client.keyEvent(17, true); // Ctrl down
        results.keyEventsSent++;
        console.log('[SEND] 键盘: Ctrl 按下');
      }, 1100);

      setTimeout(() => {
        client.keyEvent(67, true); // C down
        results.keyEventsSent++;
        console.log('[SEND] 键盘: C 按下');
      }, 1200);

      setTimeout(() => {
        client.keyEvent(67, false); // C up
        results.keyEventsSent++;
        console.log('[SEND] 键盘: C 释放');
      }, 1300);

      setTimeout(() => {
        client.keyEvent(17, false); // Ctrl up
        results.keyEventsSent++;
        console.log('[SEND] 键盘: Ctrl 释放');
      }, 1400);

    }, 500);

    // 测试完成后等待一点确保所有输入都被服务端收到
    setTimeout(() => {
      results.keyEventsReceived = receivedInputs.filter(i => i.type === 'key').length;
      results.pointerEventsReceived = receivedInputs.filter(i => i.type === 'pointer').length;
      
      console.log('\n=== 测试结果 ===');
      console.log(`总接收帧数: ${results.frames}`);
      console.log(`不重复帧数: ${results.uniqueFrames}`);
      console.log(`键盘事件发送: ${results.keyEventsSent}`);
      console.log(`服务端收到键盘事件: ${results.keyEventsReceived}`);
      console.log(`鼠标事件发送: ${results.pointerEventsSent}`);
      console.log(`服务端收到鼠标事件: ${results.pointerEventsReceived}`);
      
      // 断言
      let passed = true;
      if (results.frames < 10) {
        console.error(`[FAIL] 帧数过少(${results.frames})，可能帧请求未正常工作`);
        passed = false;
      }
      if (results.uniqueFrames < 2) {
        console.error(`[FAIL] 画面没有变化（仅 ${results.uniqueFrames} 个不同帧）`);
        passed = false;
      }
      if (results.keyEventsReceived < results.keyEventsSent) {
        console.error(`[FAIL] 键盘事件丢失：发送 ${results.keyEventsSent}，服务端收到 ${results.keyEventsReceived}`);
        passed = false;
      }
      if (results.pointerEventsReceived < results.pointerEventsSent) {
        console.error(`[FAIL] 鼠标事件丢失：发送 ${results.pointerEventsSent}，服务端收到 ${results.pointerEventsReceived}`);
        passed = false;
      }
      
      if (passed) {
        console.log('\n[OK] 所有测试通过！');
        cleanup();
        process.exit(0);
      } else {
        console.error('\n[FAIL] 测试未通过');
        cleanup();
        process.exit(1);
      }
    }, TEST_DURATION_MS);
  });
}

main().catch((err) => {
  console.error('致命错误:', err);
  process.exit(1);
});
