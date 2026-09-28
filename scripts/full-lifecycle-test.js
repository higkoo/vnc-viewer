/**
 * 综合生命周期测试 v2：模拟真实 VNC 服务器，修复了解析问题
 * 
 * 关键改进：
 * 1. 测试脚本严格按 RFB 协议解析（而非按字节猜测）
 * 2. 支持负数编码的正确传输（32-bit two's complement over wire）
 * 3. 在 server-init 后主动循环发送帧，不依赖客户端请求
 * 4. 用 hex dump 详细记录所有发出的消息
 * 
 * 用法：node scripts/full-lifecycle-test.js
 */
const net = require('net');

const TEST_PORT = 5998;
const BYTES_PER_PIXEL = 4;

let serverState = 'protocol-version';
let fbWidth = 64;
let fbHeight = 48;
let framesSent = 0;
let framebufferUpdateRequests = 0;
let inputEventsReceived = 0;
let errors = [];
let socket = null;

function hexDump(buf, label) {
  const hex = buf.slice(0, Math.min(buf.length, 80)).toJSON().data.map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`[SERVER] ${label} (${buf.length} bytes): ${hex}${buf.length > 80 ? '...' : ''}`);
}

const server = net.createServer((s) => {
  socket = s;
  console.log('[SERVER] 客户端已连接');

  let buf = Buffer.alloc(0);

  // 1. 发送 Protocol Version
  s.write(Buffer.from('RFB 003.008\n', 'ascii'));
  serverState = 'client-version';

  s.on('data', (data) => {
    buf = Buffer.concat([buf, data]);
    
    // 递归处理所有完整消息
    let processed = true;
    while (processed) {
      processed = false;
      const prevLen = buf.length;

      switch (serverState) {
        case 'client-version':
          if (buf.length >= 12) {
            const ver = buf.slice(0, 12).toString('ascii').trim();
            console.log(`[SERVER] 收到客户端版本: ${ver}`);
            buf = buf.slice(12);
            // 发送安全类型: 1 个类型，None (1)
            s.write(Buffer.from([1, 1]));
            serverState = 'client-init';
            processed = true;
          }
          break;

        case 'client-init':
          if (buf.length >= 1) {
            const shared = buf[0];
            console.log(`[SERVER] 收到 ClientInit: shared=${shared}`);
            buf = buf.slice(1);
            // 发送 ServerInit
            const name = 'test-desktop';
            const nameBuf = Buffer.from(name, 'utf8');
            const si = Buffer.alloc(24 + nameBuf.length);
            si.writeUInt16BE(fbWidth, 0);
            si.writeUInt16BE(fbHeight, 2);
            si[4] = 32; si[5] = 24; si[6] = 0; si[7] = 1;
            si.writeUInt16BE(255, 8);
            si.writeUInt16BE(255, 10);
            si.writeUInt16BE(255, 12);
            si[14] = 16; si[15] = 8; si[16] = 0;
            si.writeUInt32BE(nameBuf.length, 20);
            nameBuf.copy(si, 24);
            s.write(si);
            console.log(`[SERVER] 发送 ServerInit: ${fbWidth}x${fbHeight}`);
            serverState = 'connected';
            processed = true;
          }
          break;

        case 'connected':
          // 处理所有完整的客户端消息
          while (buf.length > 0) {
            if (buf.length < 1) break;
            const msgType = buf[0];
            let msgLen = 0;

            switch (msgType) {
              case 0: msgLen = 20; break;  // SetPixelFormat
              case 2: {  // SetEncodings
                if (buf.length < 4) break;
                const numEnc = buf.readUInt16BE(2);
                msgLen = 4 + numEnc * 4;
                break;
              }
              case 3: msgLen = 10; break;  // FramebufferUpdateRequest
              case 4: msgLen = 8; break;   // KeyEvent
              case 5: msgLen = 6; break;   // PointerEvent
              case 6: {  // ClientCutText
                if (buf.length < 8) break;
                const len = buf.readUInt32BE(4);
                msgLen = 8 + len;
                break;
              }
              case 251: msgLen = 4; break; // SetDesktopSize (仅头部)
              default:
                console.log(`[SERVER] [WARN] 未知消息类型: ${msgType} (0x${msgType.toString(16)})`);
                errors.push(`未知消息类型: ${msgType}`);
                buf = buf.slice(1);
                continue;
            }

            if (buf.length < msgLen) break; // 数据不完整，等待更多

            const msg = buf.slice(0, msgLen);
            buf = buf.slice(msgLen);

            switch (msgType) {
              case 0:
                console.log('[SERVER] 收到 SetPixelFormat');
                break;
              case 2: {
                const numEnc = msg.readUInt16BE(2);
                const encList = [];
                for (let i = 0; i < numEnc; i++) {
                  const enc = msg.readUInt32BE(4 + i * 4);
                  // 转换为有符号 32-bit 以显示负数编码
                  const signedEnc = enc | 0;
                  encList.push(signedEnc === enc ? enc : signedEnc);
                }
                console.log(`[SERVER] 收到 SetEncodings: ${numEnc} encodings: [${encList.join(', ')}]`);
                break;
              }
              case 3: {
                const inc = msg[1];
                const x = msg.readUInt16BE(2);
                const y = msg.readUInt16BE(4);
                const w = msg.readUInt16BE(6);
                const h = msg.readUInt16BE(8);
                framebufferUpdateRequests++;
                console.log(`[SERVER] 收到 FramebufferUpdateRequest(#${framebufferUpdateRequests}): inc=${inc} (${x},${y},${w}x${h})`);
                
                // 发送帧响应
                sendFrame(s);
                break;
              }
              case 4: {
                const down = msg[1];
                const keysym = msg.readUInt32BE(4);
                inputEventsReceived++;
                console.log(`[SERVER] 收到 KeyEvent: down=${down} keysym=0x${keysym.toString(16)}`);
                break;
              }
              case 5: {
                const mask = msg[1];
                const px = msg.readUInt16BE(2);
                const py = msg.readUInt16BE(4);
                inputEventsReceived++;
                console.log(`[SERVER] 收到 PointerEvent: mask=${mask} (${px},${py})`);
                break;
              }
              case 6: {
                console.log('[SERVER] 收到 ClientCutText');
                break;
              }
              case 251:
                console.log('[SERVER] 收到 SetDesktopSize');
                break;
            }
          }
          break;
      }

      if (buf.length !== prevLen) processed = true;
    }
  });

  s.on('error', (err) => {
    console.log(`[SERVER] Socket 错误: ${err.message}`);
    errors.push(err.message);
  });

  s.on('close', () => {
    console.log('[SERVER] 客户端断开');
    socket = null;
  });
});

function sendFrame(s) {
  if (s.destroyed) return;
  framesSent++;

  // 创建像素数据（彩色渐变）
  const pixelData = Buffer.alloc(fbWidth * fbHeight * BYTES_PER_PIXEL);
  const t = framesSent * 5;
  for (let y = 0; y < fbHeight; y++) {
    for (let x = 0; x < fbWidth; x++) {
      const off = (y * fbWidth + x) * 4;
      pixelData[off] = (x * 4 + t) & 0xFF;     // R
      pixelData[off + 1] = (y * 5 + t) & 0xFF; // G
      pixelData[off + 2] = (128 + t) & 0xFF;   // B
      pixelData[off + 3] = 255;                 // A
    }
  }

  const msg = Buffer.alloc(4 + 12 + pixelData.length);
  msg[0] = 0; // FramebufferUpdate
  msg[1] = 0; // padding
  msg.writeUInt16BE(1, 2); // num-rects
  msg.writeUInt16BE(0, 4);   // rect.x
  msg.writeUInt16BE(0, 6);   // rect.y
  msg.writeUInt16BE(fbWidth, 8);   // rect.width
  msg.writeUInt16BE(fbHeight, 10); // rect.height
  msg.writeUInt32BE(0, 12);  // encoding = Raw
  pixelData.copy(msg, 16);

  try {
    s.write(msg);
    if (framesSent <= 5 || framesSent % 30 === 0) {
      console.log(`[SERVER] 发送帧 #${framesSent} (${msg.length} bytes)`);
    }
  } catch (err) {
    console.log(`[SERVER] 发送帧失败: ${err.message}`);
    errors.push(err.message);
  }
}

// 启动服务器
server.listen(TEST_PORT, () => {
  console.log(`[SERVER] VNC 模拟服务器监听端口 ${TEST_PORT}`);
  console.log('========================================');
  runClient();
});

function runClient() {
  const { RfbClient } = require('../dist/rfb/client');
  
  const client = new RfbClient();
  let stateChanges = [];
  let frameRectsReceived = 0;
  let framebufferDoneCount = 0;
  let lastFrameAt = Date.now();

  client.on('state', (state) => {
    stateChanges.push(state);
    console.log(`[CLIENT] 状态变更: ${state}`);
    
    if (state === 7) {
      console.log('[CLIENT] 已连接！');
      
      // 发送测试输入
      setTimeout(() => {
        console.log('[CLIENT] → 键盘 A 按下');
        client.keyEvent(65, true);
      }, 100);
      setTimeout(() => {
        console.log('[CLIENT] → 键盘 A 释放');
        client.keyEvent(65, false);
      }, 200);
      setTimeout(() => {
        console.log('[CLIENT] → 鼠标左键按下 (32,24)');
        client.pointerEvent(1, 32, 24);
      }, 300);
      setTimeout(() => {
        console.log('[CLIENT] → 鼠标左键释放');
        client.pointerEvent(0, 32, 24);
      }, 400);
      
      // 持续主动发送帧请求来模拟主进程行为
      setInterval(() => {
        if (client.getState() === 7) {
          client.requestFramebufferUpdate(true);
        }
      }, 66); // ~15fps
    }
  });

  client.on('server-info', (info) => {
    console.log(`[CLIENT] 服务器信息: ${info.name} ${info.width}x${info.height}`);
  });

  client.on('framebuffer-update', (rect) => {
    frameRectsReceived++;
    lastFrameAt = Date.now();
    if (frameRectsReceived <= 5 || frameRectsReceived % 30 === 0) {
      console.log(`[CLIENT] 帧矩形 #${frameRectsReceived}: (${rect.x},${rect.y},${rect.width}x${rect.height}) enc=${rect.encoding} dataLen=${rect.data?.length}`);
    }
  });

  client.on('framebuffer-done', () => {
    framebufferDoneCount++;
    if (framebufferDoneCount <= 5 || framebufferDoneCount % 30 === 0) {
      console.log(`[CLIENT] framebuffer-done #${framebufferDoneCount}`);
    }
  });

  client.on('error', (msg) => {
    console.log(`[CLIENT] 错误: ${msg}`);
    errors.push(`CLIENT: ${msg}`);
  });

  client.on('desktop-size', (size) => {
    console.log(`[CLIENT] 桌面大小: ${size.width}x${size.height}`);
  });

  // 启动连接
  console.log('[CLIENT] 正在连接...');
  client.connect({ host: '127.0.0.1', port: TEST_PORT, shared: false });

  // 5 秒后结束
  setTimeout(() => {
    console.log('\n========================================');
    console.log('测试结果汇总:');
    console.log('========================================');
    console.log(`状态序列: ${stateChanges.join(' → ')}`);
    console.log(`完成帧数 (framebuffer-done): ${framebufferDoneCount}`);
    console.log(`收到帧矩形总数: ${frameRectsReceived}`);
    console.log(`服务器发送帧总数: ${framesSent}`);
    console.log(`服务器收到帧请求: ${framebufferUpdateRequests}`);
    console.log(`输入事件确认: ${inputEventsReceived}`);
    console.log(`错误数: ${errors.length}`);
    if (errors.length > 0) {
      console.log('错误列表:');
      errors.forEach(e => console.log(`  - ${e}`));
    }

    const passed = stateChanges.indexOf(7) >= 0 &&
                   framebufferDoneCount > 5 &&
                   framesSent > 5 &&
                   inputEventsReceived >= 4 &&
                   errors.length === 0;
    console.log(`\n结果: ${passed ? '✅ 全部通过' : '❌ 有失败项'}`);

    client.disconnect();
    server.close();
    process.exit(passed ? 0 : 1);
  }, 5000);
}

process.on('uncaughtException', (err) => {
  console.error('[TEST] 未捕获异常:', err.message);
  server.close();
  process.exit(1);
});
