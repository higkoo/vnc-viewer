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
export declare function log(level: LogLevel, msg: string): void;
export declare const info: (msg: string) => void;
export declare const warn: (msg: string) => void;
export declare const error: (msg: string) => void;
export declare function setLogSender(fn: (entry: LogEntry) => void): void;
export declare function getLogs(): LogEntry[];
export declare function clearLogs(): void;
//# sourceMappingURL=logger.d.ts.map