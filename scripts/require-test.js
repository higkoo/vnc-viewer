console.log('before require');
const { RfbClient } = require('../dist/rfb/client');
console.log('after require');

let count = 0;
const start = Date.now();
function tick() {
  count++;
  if (Date.now() - start >= 2000) {
    console.log(`TICK DONE: count=${count}`);
    process.exit(0);
  }
  setImmediate(tick);
}
setImmediate(tick);
