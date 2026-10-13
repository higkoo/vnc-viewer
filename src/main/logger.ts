/**
 * 日志缓冲区
 * 记录主进程运行日志并实时推送给渲染进程，同时写入本地日志文件便于排查
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  time: string;
  level: LogLevel;
  msg: string;
}

const MAX_LOGS = 500;

const buffer: LogEntry[] = [];

// 渲染进程收到新日志时的回调
let sender: ((entry: LogEntry) => void) | null = null;

// 日志文件路径（在 app ready 之前不能调用 app.getPath，所以用懒初始化）
let _logFile: string | null = null;
function getLogFile(): string {
  if (!_logFile) {
    try {
      _logFile = path.join(app.getPath('userData'), 'debug.log');
    } catch {
      _logFile = path.join(process.cwd(), 'debug.log');
    }
  }
  return _logFile;
}

function formatTime(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// 日志文件写入：缓冲批量异步写（累计超 4KB 或每 2s flush 一次），避免高频日志同步阻塞主进程
const WRITE_BUF_LIMIT = 4 * 1024;
const WRITE_FLUSH_INTERVAL = 2000;
let writeBuf: string[] = [];
let writeBufBytes = 0;
let flushTimer: NodeJS.Timeout | null = null;

function flushLogs(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (writeBuf.length === 0) return;
  const data = writeBuf.join('') + '\n';
  writeBuf = [];
  writeBufBytes = 0;
  try {
    fs.appendFile(getLogFile(), data, () => {
      // ignore：异步写失败不影响运行
    });
  } catch {
    // ignore
  }
}

function appendLogLine(line: string): void {
  writeBuf.push(line);
  writeBufBytes += Buffer.byteLength(line, 'utf8') + 1;
  if (writeBufBytes >= WRITE_BUF_LIMIT) {
    flushLogs();
  } else if (!flushTimer) {
    flushTimer = setTimeout(flushLogs, WRITE_FLUSH_INTERVAL);
    // 定时器不阳止进程退出
    flushTimer.unref();
  }
}

// 进程退出前把缓冲内的日志落盘
process.on('exit', () => {
  if (writeBuf.length > 0) {
    try {
      fs.appendFileSync(getLogFile(), writeBuf.join('') + '\n');
    } catch {
      // ignore
    }
    writeBuf = [];
    writeBufBytes = 0;
  }
});

export function log(level: LogLevel, msg: string): void {
  const entry: LogEntry = { time: formatTime(new Date()), level, msg };
  buffer.push(entry);
  if (buffer.length > MAX_LOGS) buffer.splice(0, buffer.length - MAX_LOGS);
  try {
    sender?.(entry);
  } catch {
    // ignore：渲染进程尚未就绪
  }
  // 输出到控制台 + 缓冲异步写入日志文件
  const line = `[${entry.time}] [${level.toUpperCase()}] ${msg}`;
  console.log(line);
  try {
    appendLogLine(line);
  } catch {
    // ignore
  }
}

export const info = (msg: string) => log('info', msg);
export const warn = (msg: string) => log('warn', msg);
export const error = (msg: string) => log('error', msg);

export function setLogSender(fn: (entry: LogEntry) => void): void {
  sender = fn;
}

export function getLogs(): LogEntry[] {
  return buffer.slice();
}

export function clearLogs(): void {
  buffer.length = 0;
}
