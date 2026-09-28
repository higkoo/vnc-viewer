const net = require('net');

// 用 raw socket 模拟 RfbClient 的完整 RFB 握手
const PORT = 55932;
const W = 32, H = 24;
const PF = Buffer.from([32,24,0,1,0,0xff,0,0xff,0,0xff,16,8,0,0,0,0]);

let fc = 0;

const server = net.createServer(sock => {
  let state = 'version', recv = Buffer.alloc(0);
  sock.write(Buffer.from('RFB 003.008\n', 'ascii'));
  sock.on('data', c => {
    recv = Buffer.concat([recv, c]);
    while (true) {
      if (state === 'version' && recv.length >= 12) {
        console.log('[SERVER] version:', recv.subarray(0,12).toString('ascii').trim());
        recv = recv.subarray(12);
        sock.write(Buffer.from([1, 1])); // 1 type: None(1)
        state = 'sec';
      } else if (state === 'sec' && recv.length >= 1) {
        console.log('[SERVER] client auth choice:', recv[0]);
        recv = recv.subarray(1);
        state = 'init';
      } else if (state === 'init' && recv.length >= 1) {
        console.log('[SERVER] ClientInit shared=' + recv[0]);
        recv = recv.subarray(1);
        state = 'wait';
        // Send ServerInit
        const name = Buffer.from('mock');
        const h = Buffer.alloc(24);
        h.writeUInt16BE(W, 0); h.writeUInt16BE(H, 2); PF.copy(h, 4);
        h.writeUInt32BE(name.length, 20);
        const si = Buffer.concat([h, name]);
        console.log('[SERVER] sending ServerInit', si.length, 'bytes');
        const ok = sock.write(si);
        console.log('[SERVER] write returned:', ok, 'sock.bufferSize:', sock.bufferSize);
        state = 'sending_init';
      } else {
        break;
      }
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('server on', PORT);
  
  const client = net.connect(PORT, '127.0.0.1', () => {
    console.log('[CLIENT] connected');
  });
  
  let buf = Buffer.alloc(0);
  let state = 'version';
  let gotServerInit = false;
  let frames = 0;
  
  client.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    console.log('[CLIENT] data:', chunk.length, 'bytes, state:', state, 'total buf:', buf.length);
    
    while (true) {
      if (state === 'version' && buf.length >= 12) {
        console.log('[CLIENT] got version:', buf.subarray(0,12).toString('ascii').trim());
        buf = buf.subarray(12);
        // Send version response
        client.write(Buffer.from('RFB 003.008\n', 'ascii'));
        state = 'sec';
      } else if (state === 'sec' && buf.length >= 2) {
        console.log('[CLIENT] sec types:', buf[0], 'first type:', buf[1]);
        buf = buf.subarray(2);
        // Select None (1)
        client.write(Buffer.from([1])); // auth choice
        // Send ClientInit shared=0
        client.write(Buffer.from([0]));
        state = 'serverinit';
      } else if (state === 'serverinit' && buf.length >= 24) {
        const w = buf.readUInt16BE(0);
        const h = buf.readUInt16BE(2);
        const nameLen = buf.readUInt32BE(20);
        console.log('[CLIENT] ServerInit header:', w + 'x' + h + ' nameLen=' + nameLen);
        if (buf.length >= 24 + nameLen) {
          const name = buf.subarray(24, 24 + nameLen).toString('utf8');
          buf = buf.subarray(24 + nameLen);
          console.log('[CLIENT] ServerInit: ' + w + 'x' + h + ' name=' + name);
          gotServerInit = true;
          state = 'connected';
          // Request frame
          const req = Buffer.alloc(10);
          req[0] = 3; // FramebufferUpdateRequest
          req[1] = 0; // incremental
          req.writeUInt16BE(0, 2); // x
          req.writeUInt16BE(0, 4); // y
          req.writeUInt16BE(w, 6);
          req.writeUInt16BE(h, 8);
          client.write(req);
          console.log('[CLIENT] sent frame request');
        } else {
          break;
        }
      } else if (state === 'connected') {
        if (buf.length >= 4) {
          const numRects = buf.readUInt16BE(2);
          if (numRects === 1 && buf.length >= 16) {
            const rw = buf.readUInt16BE(8);
            const rh = buf.readUInt16BE(10);
            const enc = buf.readUInt32BE(12);
            console.log('[CLIENT] FrameUpdate numRects=1 ' + rw + 'x' + rh + ' enc=' + enc);
            const dataLen = rw * rh * 4;
            if (buf.length >= 16 + dataLen) {
              buf = buf.subarray(16 + dataLen);
              frames++;
              console.log('[CLIENT] Frame #' + frames + ' decoded, total buf:', buf.length);
              // Request next frame
              const req = Buffer.alloc(10);
              req[0] = 3;
              req.writeUInt16BE(0, 2);
              req.writeUInt16BE(0, 4);
              req.writeUInt16BE(W, 6);
              req.writeUInt16BE(H, 8);
              client.write(req);
            } else {
              break;
            }
          } else {
            break;
          }
        } else {
          break;
        }
      } else {
        break;
      }
    }
  });
  
  client.on('error', e => console.log('[CLIENT] error:', e.message));
  
  setTimeout(() => {
    console.log('\n=== RESULT: gotServerInit=' + gotServerInit + ' frames=' + frames + ' ===');
    client.destroy();
    server.close();
    process.exit(gotServerInit && frames > 0 ? 0 : 1);
  }, 3000);
});

server.on('error', e => { console.log('server error:', e.message); process.exit(1); });
