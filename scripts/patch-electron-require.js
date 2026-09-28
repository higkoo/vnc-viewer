/**
 * 修复开发模式下 require('electron') 返回路径字符串的问题
 * 
 * 在 electron npm 包中，index.js 导出的是 Electron 可执行文件路径字符串，
 * 而不是 API 命名空间。打包后应用能正常工作是因为 electron-builder 
 * 排除了 node_modules/electron，Electron 运行时从内置模块系统
 * 解析 'electron' 得到正确的 API。
 * 
 * 本脚本在编译后的 main.js 和 preload.js 文件开头注入一段前置代码，
 * 用 process._linkedBinding 构造 API 对象并填入 Module._cache，
 * 让后续的 require('electron') 能得到正确结果。
 */

const fs = require('fs');
const path = require('path');

const SHIM = `
// [PATCHED-ELECTRON-require shim - 开发模式补丁]
(function () {
  const Module = require('module');
  const fs = require('fs');
  const path = require('path');

  // 检测是否处于 Electron 运行时
  if (!process.versions.electron) return;

  // 检查缓存中已有 electron 模块
  const electronPkgPath = (function () {
    try { return require.resolve('electron'); } catch (e) { return null; }
  })();

  if (!electronPkgPath || !require.cache[electronPkgPath]) return;

  // 如果导出的已经是对象（打包后环境），无需修复
  if (typeof require.cache[electronPkgPath].exports === 'object') return;

  // 修复：用 _linkedBinding 获取内部模块 API，构建兼容的 electron 模块
  function linkedBinding(name) {
    if (process._linkedBinding) return process._linkedBinding(name);
    if (process.binding) return process.binding(name);
    return undefined;
  }

  const app = linkedBinding('electron_common_app');
  if (!app) {
    console.error('[patch-electron] 无法获取 electron API，请使用 npm run pack 打包后运行');
    return;
  }

  const api = {
    app,
    BrowserWindow: linkedBinding('electron_common_browser_window'),
    ipcMain: linkedBinding('electron_common_ipc_main'),
    Menu: linkedBinding('electron_common_menu'),
    dialog: linkedBinding('electron_common_dialog'),
    Notification: linkedBinding('electron_common_notification'),
    Tray: linkedBinding('electron_common_tray'),
    clipboard: linkedBinding('electron_common_clipboard'),
    nativeImage: linkedBinding('electron_common_native_image'),
    shell: linkedBinding('electron_common_shell'),
    screen: linkedBinding('electron_common_screen'),
    systemPreferences: linkedBinding('electron_common_system_preferences'),
    powerMonitor: linkedBinding('electron_common_power_monitor'),
    session: linkedBrowserBinding ? linkedBrowserBinding('electron_browser_session') : undefined,
    autoUpdater: linkedBinding('electron_common_auto_updater'),
    globalShortcut: linkedBinding('electron_common_global_shortcut'),
    nativeTheme: linkedBinding('electron_common_native_theme'),
    safeStorage: linkedBinding('electron_common_safe_storage'),
    net: linkedBinding('electron_common_net'),
    protocol: linkedBinding('electron_common_protocol'),
    netLog: linkedBinding('electron_common_net_log'),
    IncomingMessage: linkedBinding('electron_common_incoming_message'),
    Notification: linkedBinding('electron_common_notification'),
    WebContentsView: linkedBinding('electron_common_web_contents_view'),
    View: linkedBinding('electron_common_view'),
    webContents: linkedBinding('electron_common_web_contents'),
    WebContentsView: linkedBinding('electron_common_web_contents_view'),
    BrowserView: linkedBinding('electron_common_browser_view'),
    ipcRenderer: (function() {
      // preload 脚本中用 electron/renderer 的 ipcRenderer
      try {
        const elecRenderer = process._linkedBinding('electron_renderer_ipc');
        return elecRenderer;
      } catch(e) { return undefined; }
    })(),
    contextBridge: (function() {
      try {
        return process._linkedBinding('electron_renderer_context_bridge');
      } catch(e) { return undefined; }
    })(),
  };

  // 清理 undefined 中不需要的属性
  for (const key of Object.keys(api)) {
    if (api[key] === undefined) delete api[key];
  }

  require.cache[electronPkgPath].exports = api;
  require.cache[electronPkgPath].loaded = true;
})();
// [/PATCHED-ELECTRON-require]
`;

function patchFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  
  let content = fs.readFileSync(filePath, 'utf8');
  
  // 已经注入过就不再注入
  if (content.includes('[PATCHED-ELECTRON-require]')) return;
  
  // 在文件最开头注入 shim（在任何 require 之前）
  content = SHIM + '\n' + content;
  
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`[patch-electron] 已修补: ${path.basename(filePath)}`);
}

function main() {
  const distDir = path.join(__dirname, '..', 'dist', 'main');
  const files = ['main.js', 'preload.js'];
  
  for (const f of files) {
    const fp = path.join(distDir, f);
    if (fs.existsSync(fp)) {
      patchFile(fp);
    }
  }
}

main();
