const { RfbClient } = require('../dist/rfb/client');
const { ConnectionState } = require('../dist/rfb/types');

const c = new RfbClient();

// 直接设置私有属性
c.state = ConnectionState.ServerInit; // state 6
c.buffer = Buffer.alloc(0);

console.log('state:', c.state, 'buffer len:', c.buffer.length);
console.log('calling processData with empty buffer...');

const start = Date.now();
c.processData();
console.log('processData returned in', Date.now() - start, 'ms (should be 0)');

// 模拟收到 ServerInit 数据
c.buffer = Buffer.alloc(24 + 4);
c.buffer.writeUInt16BE(32, 0);
c.buffer.writeUInt16BE(24, 2);
c.buffer[4] = 32; c.buffer[5] = 24; c.buffer[6] = 0; c.buffer[7] = 1;
c.buffer.writeUInt16BE(255, 8);
c.buffer.writeUInt16BE(255, 10);
c.buffer.writeUInt16BE(255, 12);
c.buffer[14] = 16; c.buffer[15] = 8; c.buffer[16] = 0;
c.buffer.writeUInt32BE(4, 20);
c.buffer.write('test', 24);

console.log('state before:', c.state, 'buffer len:', c.buffer.length);
c.processData();
console.log('state after:', c.state);

if (c.state === 7) {
  console.log('PASS: connected!');
  console.log('server info:', c.getFbWidth(), 'x', c.getFbHeight(), c.getDesktopName());
} else {
  console.log('FAIL: state is', c.state);
}

process.exit(0);
