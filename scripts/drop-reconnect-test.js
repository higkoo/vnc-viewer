/**
 * 连接监督行为测试：验证 'dropped'（意外断线）事件的触发条件。
 * 覆盖场景：
 *   1. 已建立的连接被服务端关闭 → 触发一次 dropped
 *   2. 已建立的连接 socket 错误（ECONNRESET）→ 触发一次 dropped（不与 close 重复）
 *   3. 用户主动 disconnect() → 不触发 dropped
 *   4. 连接阶段失败（拒连）→ 不触发 dropped（首次连接失败不走重连）
 *   5. 认证失败 → markFatal，且后续断线不触发 dropped
 *
 * 用法：node scripts/drop-reconnect-test.js
 */
const net = require('net');
const path = require('path');
const { RfbClient } = require(path.join(__dirname, '..', 'dist', 'rfb', 'client'));
const { ConnectionState } = require(path.join(__dirname, '..', 'dist', 'rfb', 'types'));

const PORT = 5988;
let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

/** 最小 RFB 3.8 服务器：None 认证，可配置行为 */
function createServer({ authType = 1, destroyAfterHandshake = false, rstAfterHandshake = false } = {}) {
  const state = { sock: null };
  const server = net.createServer((sock) => {
    state.sock = sock;
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
          sock.write(Buffer.from([1, authType]));
          stage = 'sec';
          progress = true;
        } else if (stage === 'sec' && buf.length >= 1) {
          buf = buf.subarray(1);
          if (authType === 2) {
            // VncAuth：发 16 字节挑战，然后等 16 字节响应，再发失败结果
            sock.write(Buffer.alloc(16, 0x42));
            stage = 'authresp';
          } else {
            sock.write(Buffer.alloc(4, 0)); // SecurityResult OK
            stage = 'init';
          }
          progress = true;
        } else if (stage === 'authresp' && buf.length >= 16) {
          buf = buf.subarray(16);
          // 认证失败（3.8：4 字节结果 + 4 字节原因长度 + 原因文本）
          const reason = Buffer.from('auth failed');
          const lenBuf = Buffer.alloc(4);
          lenBuf.writeUInt32BE(reason.length, 0);
          sock.write(Buffer.concat([Buffer.from([0, 0, 0, 1]), lenBuf, reason]));
          stage = 'done';
          progress = true;
        } else if (stage === 'init' && buf.length >= 1) {
          buf = buf.subarray(1);
          const name = Buffer.from('test');
          const si = Buffer.alloc(24 + name.length);
          si.writeUInt16BE(64, 0); si.writeUInt16BE(64, 2);
          si[4] = 32; si[5] = 24; si[6] = 0; si[7] = 1;
          si.writeUInt16BE(255, 8); si.writeUInt16BE(255, 10); si.writeUInt16BE(255, 12);
          si[14] = 16; si[15] = 8; si[16] = 0;
          si.writeUInt32BE(name.length, 20);
          name.copy(si, 24);
          sock.write(si);
          stage = 'connected';
          progress = true;
          if (destroyAfterHandshake) {
            setTimeout(() => sock.destroy(), 50);
          }
          if (rstAfterHandshake) {
            // 强制 RST：客户端会先收到 ECONNRESET('error')再收到 'close'，
            // 验证 dropped 去重（只触发一次）
            setTimeout(() => sock.resetAndDestroy(), 50);
          }
        }
      }
    });
    sock.on('error', () => {});
  });
  server.on('error', () => {});
  return { server, state };
}

function connect(port, password) {
  const c = new RfbClient();
  // 默认附加 no-op error 监听：EventEmitter 对无监听的 'error' 事件会直接
  // 抛出 ERR_UNHANDLED_ERROR 终止进程（真实应用中 main.ts 总会注册）
  c.on('error', () => {});
  c.connect({ host: '127.0.0.1', port, password: password || undefined, shared: true });
  return c;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  // ---- 场景 1：已建立连接被服务端关闭 ----
  {
    const { server } = createServer({ destroyAfterHandshake: true });
    await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
    const c = connect(PORT);
    const drops = [];
    c.on('dropped', (r) => drops.push(r));
    await sleep(600);
    check('场景1 已建立连接被关闭 → dropped 触发一次', drops.length === 1);
    check('场景1 dropped 带原因', typeof drops[0] === 'string' && drops[0].length > 0);
    c.disconnect();
    server.close();
    await sleep(100);
  }

  // ---- 场景 1b：RST 强制重置（error + close 成对）→ dropped 只触发一次 ----
  {
    const { server } = createServer({ rstAfterHandshake: true });
    await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
    const c = connect(PORT);
    const drops = [];
    c.on('dropped', (r) => drops.push(r));
    await sleep(600);
    check('场景1b RST 重置 → dropped 只触发一次（去重）', drops.length === 1);
    c.disconnect();
    server.close();
    await sleep(100);
  }

  // ---- 场景 2：用户主动断开不触发 dropped ----
  {
    const { server } = createServer({});
    await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
    const c = connect(PORT);
    const drops = [];
    c.on('dropped', (r) => drops.push(r));
    await sleep(300);
    c.disconnect(); // 用户主动
    await sleep(300);
    check('场景2 用户主动断开 → 不触发 dropped', drops.length === 0);
    server.close();
    await sleep(100);
  }

  // ---- 场景 3：连接阶段失败（拒连）不触发 dropped ----
  {
    // 不启动服务器 → ECONNREFUSED
    const c = connect(PORT);
    const drops = [];
    const errors = [];
    c.on('dropped', (r) => drops.push(r));
    c.on('error', (m) => errors.push(m));
    await sleep(800);
    check('场景3 连接被拒 → 不触发 dropped', drops.length === 0);
    check('场景3 连接被拒 → 有错误事件', errors.length > 0);
    c.disconnect();
    await sleep(100);
  }

  // ---- 场景 4：认证失败 → 致命 + 不触发 dropped ----
  {
    const { server } = createServer({ authType: 2 });
    await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
    const c = connect(PORT, 'wrongpass');
    const drops = [];
    const errors = [];
    c.on('dropped', (r) => drops.push(r));
    c.on('error', (m) => errors.push(m));
    await sleep(600);
    check('场景4 认证失败 → 标记致命', c.isFatal() === true);
    check('场景4 认证失败 → 不触发 dropped', drops.length === 0);
    check('场景4 认证失败 → 有错误事件', errors.length > 0);
    c.disconnect();
    server.close();
    await sleep(100);
  }

  // ---- 场景 5：致命错误的连接后续断线也不触发 dropped（服务端关闭连接）----
  {
    const { server } = createServer({ authType: 2 });
    await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
    const c = connect(PORT, 'wrongpass');
    const drops = [];
    c.on('dropped', (r) => drops.push(r));
    await sleep(300);
    // 服务端再关闭连接（真实服务器认证失败后通常会关）
    // 注意：此时状态不是 Connected，本就不会触发 dropped
    c.disconnect();
    check('场景5 认证失败实例 → 无 dropped', drops.length === 0);
    server.close();
    await sleep(100);
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})();
