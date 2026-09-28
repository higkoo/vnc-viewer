const { RfbClient } = require('../dist/rfb/client');
const net = require('net');

const W = 32, H = 24;
const PF = Buffer.from([32,24,0,1,0,0xff,0,0xff,0,0xff,16,8,0,0,0,0]);

const server = net.createServer(sock => {
  console.log('[SERVER] client connected');
  sock.write(Buffer.from('RFB 003.008\n', 'ascii'));
  let done = false;
  sock.on('data', c => {
    console.log('[SERVER] got', c.length, 'bytes:', c.toString('hex'));
    if (!done) {
      done = true;
      sock.write(Buffer.from([1, 1])); // sec type None
      setTimeout(() => {
        const name = Buffer.from('mock');
        const h = Buffer.alloc(24);
        h.writeUInt16BE(W, 0); h.writeUInt16BE(H, 2); PF.copy(h, 4);
        h.writeUInt32BE(name.length, 20);
        const si = Buffer.concat([h, name]);
        console.log('[SERVER] sending ServerInit', si.length, 'bytes');
        sock.write(si);
      }, 50);
    }
  });
});

server.listen(55951, '127.0.0.1', () => {
  console.log('server ready');
  
  const c = new RfbClient();
  
  c.on('state', s => {
    console.log('state:', s);
    if (s === 6) {
      console.log('reached state 6, scheduling checks...');
      setImmediate(() => console.log('IMMEDIATE after state 6'));
      setTimeout(() => console.log('TIMEOUT 100ms after state 6'), 100);
      process.nextTick(() => console.log('NEXTTICK after state 6'));
    }
    if (s === 7) {
      console.log('CONNECTED!');
    }
  });
  
  c.on('error', m => console.log('ERROR:', m));
  c.on('server-info', i => console.log('SERVERINFO:', JSON.stringify(i)));
  
  c.connect({ host: '127.0.0.1', port: 55951, password: '', shared: false });
});

setTimeout(() => {
  console.log('FINAL TIMEOUT');
  process.exit(0);
}, 3000);
