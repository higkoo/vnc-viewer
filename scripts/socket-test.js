// 最简单的 TCP socket 回环测试
const net = require('net');

const PORT = 55920;
let serverGotData = false;
let clientGotData = false;

const server = net.createServer(sock => {
  console.log('[SERVER] client connected');
  // 连接后立即发 28 字节
  const data = Buffer.alloc(28, 0xAB);
  sock.write(data, (err) => {
    if (err) console.log('[SERVER] write error:', err.message);
    else console.log('[SERVER] write 28 bytes OK');
  });
  
  sock.on('data', d => {
    serverGotData = true;
    console.log('[SERVER] got data:', d.length, 'bytes');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[SERVER] listening on', PORT);
  
  const client = net.connect(PORT, '127.0.0.1', () => {
    console.log('[CLIENT] connected');
    // 发 2 字节
    client.write(Buffer.from([0x01, 0x00]), (err) => {
      if (err) console.log('[CLIENT] write error:', err.message);
      else console.log('[CLIENT] write 2 bytes OK');
    });
  });
  
  client.on('data', d => {
    clientGotData = true;
    console.log('[CLIENT] got data:', d.length, 'bytes, first:', d[0].toString(16));
  });
  
  client.on('error', e => console.log('[CLIENT] error:', e.message));
  
  setTimeout(() => {
    console.log(`\nRESULT: serverGotData=${serverGotData} clientGotData=${clientGotData}`);
    client.destroy();
    server.close();
    process.exit(clientGotData && serverGotData ? 0 : 1);
  }, 2000);
});
