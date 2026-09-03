/**
 * 简单的环形日志缓冲区
 * 记录主进程运行日志并实时推送给渲染进程，便于排查连接等问题
 */

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

function formatTime(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function log(level: LogLevel, msg: string): void {
  const entry: LogEntry = { time: formatTime(new Date()), level, msg };
  buffer.push(entry);
  if (buffer.length > MAX_LOGS) buffer.splice(0, buffer.length - MAX_LOGS);
  try {
    sender?.(entry);
  } catch {
    // ignore：渲染进程尚未就绪
  }
  // 也输出到主进程标准输出，方便从终端/日志文件查看
  console.log(`[${entry.time}] [${level.toUpperCase()}] ${msg}`);
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