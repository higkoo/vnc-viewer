/**
 * Electron 开发模式入口 Shim
 * 
 * 问题原因：TypeScript 编译为 CommonJS 后，
 * import { app } from 'electron' 变成了 require("electron")。
 * 但 node_modules/electron/index.js 导出的是 Electron 可执行文件路径字符串，
 * 不是 API 命名空间。
 * 
 * 解决方案：通过清除 Module._cache 并替换为 Electron 内置模块，
 * 让后续的 require('electron') 返回真正的 API 对象。
 * 
 * 在 electron-builder 打包的应用中，不存在 node_modules/electron，
 * 该 shim 不会被使用（package.json 的 main 指向 dist/main/main.js）。
 */

const path = require('path');
const Module = require('module');

// 检测是否在 Electron 运行时中
if (!process.versions.electron) {
  console.error('This entry point must be run with Electron');
  process.exit(1);
}

// 检测 require('electron') 是否返回字符串（需要修复的情况）
// 使用 Module._load 直接加载模块（绕过缓存和电子钩子）
const origLoad = Module._load;
const electronPath = origLoad('electron', null, false);

if (typeof electronPath === 'string') {
  // 需要修复：require('electron') 返回了路径字符串
  // 通过 process.moduleLoadList 查找 Electron 内置模块
  // 或尝试直接加载 Electron dist 中的内部模块
  
  // 方法：将 node_modules/electron/index.js 的缓存替换为真正的 API
  // 使用 Electron 的 C++ 内部模块注册
  const fs = require('fs');
  const electronIndex = require.resolve('electron');
  
  // 创建一个新的模块对象，提供正确的 API
  const electronApi = {};
  
  // 通过已知的 Electron 内部绑定名称获取 API
  // Electron 注册了 electron_common_*、electron_renderer_*、electron_browser_* 等内部模块
  const internalModules = [
    'electron_common_app',
    'electron_common_browser_window', 
    'electron_common_web_contents',
    'electron_common_ipc_main',
    'electron_common_menu',
    'electron_common_dialog',
    'electron_common_native_image',
    'electron_common_tray',
    'electron_common_notification',
    'electron_common_screen',
    'electron_common_display',
    'electron_common_power_monitor',
    'electron_common_crash_reporter',
    'electron_common_global_shortcut',
    'electron_common_session',
    'electron_common_auto_updater',
    'electron_common_clipboard',
    'electron_common_protocol',
    'electron_common_shell',
    'electron_common_native_theme',
    'electron_common_web_frame_main',
    'electron_common_base_window',
    'electron_common_tray',
    'electron_common_net',
    'electron_common_safe_storage',
  ];
  
  // 尝试通过 process._linkedBinding 获取关键对象
  const electronCommon = {};
  for (const name of internalModules) {
    try {
      const binding = process._linkedBinding(name);
      electronCommon[name] = binding;
    } catch (e) {
      // 某些绑定可能不存在或已被重命名
    }
  }
  
  if (Object.keys(electronCommon).length > 0) {
    // 构建兼容的 electron 模块
    Object.assign(electronApi, electronCommon);
    
    // 缓存修复后的模块
    const m = new Module('electron');
    m.filename = electronIndex;
    m.exports = electronApi;
    m.loaded = true;
    require.cache[electronIndex] = m;
  } else {
    console.error('[electron-shim] 无法获取 Electron API。请使用 npm run pack 打包后运行。');
    console.error('错误：require("electron") 返回的是路径字符串:', electronPath);
    process.exit(1);
  }
}

// 加载主模块
require('./main.js');
