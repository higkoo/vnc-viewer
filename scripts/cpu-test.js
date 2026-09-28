const net = require('net');
const { RfbClient } = require('../dist/rfb/client');

const W = 32, H = 24, PORT = 55931;
const PF = Buffer.from([32,24,0,1,0,0xff,0,0xff,0,0xff,16,8,0,0,0,0]);

function mkFrame(fc) {
  const px = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W*H*4; i++) px[i] = (i * 3 + fc * 7) % 256;
  const buf = Buffer.alloc(16 + px.length);
  buf[0] = 0; buf[1] = 0; buf.writeUInt16BE(1, 2);
  buf.writeUInt16BE(W, 8); buf.writeUInt16BE(H, 10); buf.writeUInt32BE(0, 12);
  px.copy(buf, 16);
  return buf;
}

let fc = 0;

// 独立的 loop checker —— 在主代码之外单独 setImmediate
let loopCount = 0;
const startT = Date.now();
function tick() {
  loopCount++;
  if (Date.now() - startT >= 4000) {
    console.log(`TICK DONE: count=${loopCount} elapsed=${Date.now()-startT}ms`);
    process.exit(0);
  }
  setImmediate(tick);
}
// 先 setImmediate 确保它在 event loop 中
setImmediate(tick);

const server = net.createServer(sock => {
  let state = 'version', recv = Buffer.alloc(0);
  sock.write(Buffer.from('RFB 003.008\n', 'ascii'));
  sock.on('data', c => { recv = Buffer.concat([recv, c]); pump(); });

  function pump() {
    let p = true;
    while (p) {
      p = false;
      if (state === 'version' && recv.length >= 12) {
        recv = recv.subarray(12); sock.write(Buffer.from([1, 1])); state = 'sec'; p = true;
      } else if (state === 'sec' && recv.length >= 1) {
        recv = recv.subarray(1); state = 'init'; p = true;
      } else if (state === 'init' && recv.length >= 1) {
        recv = recv.subarray(1); state = 'wait';
        const name = Buffer.from('mock');
        const h = Buffer.alloc(24);
        h.writeUInt16BE(W, 0); h.writeUInt16BE(H, 2); PF.copy(h, 4);
        h.writeUInt32BE(name.length, 20);
        sock.write(Buffer.concat([h, name]));
        p = true;
      } else if (state === 'wait') {
        while (recv.length >= 1) {
          if (recv[0] === 3 && recv.length >= 10) { recv = recv.subarray(10); sock.write(mkFrame(++fc)); }
          else if (recv[0] === 4 && recv.length >= 8) { recv = recv.subarray(8); }
          else if (recv[0] === 5 && recv.length >= 6) { recv = recv.subarray(6); }
          else { recv = recv.subarray(1); }
        }
        p = true;
      }
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('server on', PORT);
  const c = new RfbClient();
  let frames = 0;
  c.on('state', s => console.log('client state:', s));
  c.on('framebuffer-update', r => { frames++; });
  c.on('error', m => console.log('CLIENT ERROR:', m));
  c.connect({ host: '127.0.0.1', port: PORT, password: '', shared: false });
});

server.on('error', e => { console.log('server error:', e.message); process.exit(1); });
