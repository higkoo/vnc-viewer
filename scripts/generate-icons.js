/**
 * 应用图标生成器
 *
 * 设计：squircle 应用磁贴（深靛蓝→青渐变）+ 白色显示器剪影 + 屏内青色信号弧。
 * 输出：build/icons/*.png（16~1024）、build/icon.ico（Windows）、
 *       build/icon.icns（macOS）、build/icon.png（Linux/窗口图标）、
 *       src/renderer/favicon.png（网页图标）。
 *
 * 用法：node scripts/generate-icons.js
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const ICONS_DIR = path.join(ROOT, 'build', 'icons');

/** 主 SVG（1024×1024） */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#3730A3"/>
      <stop offset="0.55" stop-color="#2563EB"/>
      <stop offset="1" stop-color="#0891B2"/>
    </linearGradient>
    <radialGradient id="gloss" cx="0.28" cy="0.16" r="0.85">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.14"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <!-- 应用磁贴 -->
  <rect x="0" y="0" width="1024" height="1024" rx="229" fill="url(#bg)"/>
  <rect x="0" y="0" width="1024" height="1024" rx="229" fill="url(#gloss)"/>

  <!-- 显示器主体 -->
  <rect x="242" y="272" width="540" height="340" rx="46" fill="#FFFFFF"/>
  <rect x="272" y="302" width="480" height="280" rx="30" fill="#0C2D5E"/>

  <!-- 屏内信号弧（远程连接） -->
  <g fill="none" stroke="#22D3EE" stroke-width="18" stroke-linecap="round">
    <path d="M 431.4 377.4 A 114 114 0 0 1 592.6 377.4" opacity="0.45"/>
    <path d="M 455.4 401.4 A 80 80 0 0 1 568.6 401.4" opacity="0.72"/>
    <path d="M 479.5 425.5 A 46 46 0 0 1 544.5 425.5" opacity="1"/>
  </g>
  <circle cx="512" cy="458" r="21" fill="#22D3EE"/>

  <!-- 支架 -->
  <path d="M 462 612 L 562 612 L 544 668 L 480 668 Z" fill="#FFFFFF"/>
  <rect x="424" y="668" width="176" height="30" rx="15" fill="#FFFFFF"/>
</svg>`;

/** ICO 文件构造（PNG 压缩条目，Vista+ 支持） */
function buildIco(pngs) {
  const count = pngs.length;
  const headerSize = 6 + count * 16;
  let totalSize = headerSize;
  for (const p of pngs) totalSize += p.data.length;

  const buf = Buffer.alloc(totalSize);
  let o = 0;
  buf.writeUInt16LE(0, o); o += 2;              // reserved
  buf.writeUInt16LE(1, o); o += 2;              // type: icon
  buf.writeUInt16LE(count, o); o += 2;          // count

  let offset = headerSize;
  for (const p of pngs) {
    buf.writeUInt8(p.size >= 256 ? 0 : p.size, o); o += 1;  // width
    buf.writeUInt8(p.size >= 256 ? 0 : p.size, o); o += 1;  // height
    buf.writeUInt8(0, o); o += 1;                            // color count
    buf.writeUInt8(0, o); o += 1;                            // reserved
    buf.writeUInt16LE(1, o); o += 2;                         // planes
    buf.writeUInt16LE(32, o); o += 2;                        // bit count
    buf.writeUInt32LE(p.data.length, o); o += 4;             // bytes in res
    buf.writeUInt32LE(offset, o); o += 4;                    // offset
    offset += p.data.length;
  }
  for (const p of pngs) { p.data.copy(buf, o); o += p.data.length; }
  return buf;
}

/** ICNS 文件构造（PNG 数据块） */
const ICNS_TYPES = [
  { type: 'ic11', size: 64 },    // 32@2x
  { type: 'ic12', size: 128 },   // 64@2x
  { type: 'ic07', size: 128 },   // 128
  { type: 'ic13', size: 256 },   // 128@2x
  { type: 'ic08', size: 256 },   // 256
  { type: 'ic14', size: 1024 },  // 512@2x
  { type: 'ic09', size: 512 },   // 512
  { type: 'ic10', size: 1024 },  // 1024
];

function buildIcns(pngBySize) {
  const chunks = [];
  for (const { type, size } of ICNS_TYPES) {
    const data = pngBySize[size];
    if (!data) continue;
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    chunks.push(head, data);
  }
  const body = Buffer.concat(chunks);
  const out = Buffer.alloc(8 + body.length);
  out.write('icns', 0, 'ascii');
  out.writeUInt32BE(8 + body.length, 4);
  body.copy(out, 8);
  return out;
}

(async () => {
  fs.mkdirSync(ICONS_DIR, { recursive: true });

  // 1. 渲染各尺寸 PNG
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  const pngBySize = {};
  for (const s of sizes) {
    const out = path.join(ICONS_DIR, `${s}x${s}.png`);
    await sharp(Buffer.from(SVG)).resize(s, s).png().toFile(out);
    pngBySize[s] = fs.readFileSync(out);
    console.log(`  png ${s}x${s}`);
  }

  // 2. ICO（Windows）：16/24/32/48/64/128/256
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const ico = buildIco(icoSizes.map((s) => ({ size: s, data: pngBySize[s] })));
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico);
  console.log(`  ico ${ico.length} bytes (${icoSizes.join('/')})`);

  // 3. ICNS（macOS）
  const icns = buildIcns(pngBySize);
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.icns'), icns);
  console.log(`  icns ${icns.length} bytes`);

  // 4. Linux / 窗口图标（512）
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), pngBySize[512]);
  console.log('  icon.png 512x512');

  // 5. 渲染进程 favicon（32）
  fs.writeFileSync(path.join(ROOT, 'src', 'renderer', 'favicon.png'), pngBySize[32]);
  console.log('  favicon.png 32x32');

  console.log('图标生成完成');
})().catch((e) => { console.error('图标生成失败:', e); process.exit(1); });
