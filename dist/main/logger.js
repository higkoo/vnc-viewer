"use strict";
/**
 * 日志缓冲区
 * 记录主进程运行日志并实时推送给渲染进程，同时写入本地日志文件便于排查
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.error = exports.warn = exports.info = void 0;
exports.log = log;
exports.setLogSender = setLogSender;
exports.getLogs = getLogs;
exports.clearLogs = clearLogs;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const electron_1 = require("electron");
const MAX_LOGS = 500;
const buffer = [];
// 渲染进程收到新日志时的回调
let sender = null;
// 日志文件路径（在 app ready 之前不能调用 app.getPath，所以用懒初始化）
let _logFile = null;
function getLogFile() {
    if (!_logFile) {
        try {
            _logFile = path.join(electron_1.app.getPath('userData'), 'debug.log');
        }
        catch {
            _logFile = path.join(process.cwd(), 'debug.log');
        }
    }
    return _logFile;
}
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
    // 输出到控制台 + 日志文件
    const line = `[${entry.time}] [${level.toUpperCase()}] ${msg}`;
    console.log(line);
    try {
        fs.appendFileSync(getLogFile(), line + '\n');
    }
    catch {
        // ignore
    }
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