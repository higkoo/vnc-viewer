/**
 * Preload 脚本 - 安全地暴露 IPC 给渲染进程
 *
 * 注意：Electron 20+ 默认 sandbox: true，沙箱化的 preload 只能 require('electron')
 * 等内置模块，不能加载项目内文件（如 ../rfb/types），否则 preload 整体加载失败，
 * 渲染进程将拿不到 vncApi。因此这里内联 IPC 通道常量（与 src/rfb/types.ts 保持一致）。
 */
export {};
//# sourceMappingURL=preload.d.ts.map