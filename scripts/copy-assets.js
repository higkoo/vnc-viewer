/**
 * 复制渲染进程静态资源（HTML/CSS 等）到 dist
 *
 * tsc 只编译 TypeScript，不会复制 HTML/CSS。若不同步，dist 里的旧版 HTML
 * 会缺少新增的 DOM 元素，导致渲染端初始化崩溃（例如按钮找不到）。
 */
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src', 'renderer');
const outDir = path.join(__dirname, '..', 'dist', 'renderer');

/** 递归复制目录中除 .ts/.tsx 外的所有文件 */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dst);
    } else if (!/\.(ts|tsx)$/.test(entry.name)) {
      fs.copyFileSync(src, dst);
      console.log(`[copy-assets] ${path.relative(path.join(__dirname, '..'), dst)}`);
    }
  }
}

// 渲染进程资源
copyDir(srcDir, outDir);

// 移动端页面（供 Capacitor / 手机代理使用）
const mobileSrc = path.join(__dirname, '..', 'src', 'mobile');
const mobileOut = path.join(__dirname, '..', 'dist', 'mobile');
if (fs.existsSync(mobileSrc)) {
  copyDir(mobileSrc, mobileOut);
}
