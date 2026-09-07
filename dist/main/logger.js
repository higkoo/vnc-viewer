"use strict";
/**
 * 简单的环形日志缓冲区
 * 记录主进程运行日志并实时推送给渲染进程，便于排查连接等问题
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.error = exports.warn = exports.info = void 0;
exports.log = log;
exports.setLogSender = setLogSender;
exports.getLogs = getLogs;
exports.clearLogs = clearLogs;
const MAX_LOGS = 500;
const buffer = [];
// 渲染进程收到新日志时的回调
let sender = null;
function formatTime(d) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function log(level, msg) {
    const entry = { time: formatTime(new Date()), level, msg };
    buffer.push(entry);
    if (buffer.length > MAX_LOGS)
        buffer.splice(0, buffer.length - MAX_LOGS);
    try {
        sender?.(entry);
    }
    catch {
        // ignore：渲染进程尚未就绪
    }
    // 也输出到主进程标准输出，方便从终端/日志文件查看
    console.log(`[${entry.time}] [${level.toUpperCase()}] ${msg}`);
}
const info = (msg) => log('info', msg);
exports.info = info;
const warn = (msg) => log('warn', msg);
exports.warn = warn;
const error = (msg) => log('error', msg);
exports.error = error;
function setLogSender(fn) {
    sender = fn;
}
function getLogs() {
    return buffer.slice();
}
function clearLogs() {
    buffer.length = 0;
}
//# sourceMappingURL=logger.js.map