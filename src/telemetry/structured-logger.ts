import type { LogLevel } from "../config/index.js";

export type LogContext = Record<string, unknown>;

export interface LogRecord {
  level: LogLevel;
  message: string;
  context?: LogContext;
  timestamp: number;
}

export type LogSink = (record: LogRecord) => void;

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface StructuredLoggerOptions {
  level: LogLevel;
  sinks: LogSink[];
}

/**
 * Tiny structured logger. Designed to be wired to both stderr (for CLI)
 * and NDJSON `log` events (for sidecar mode) via its sink interface.
 */
export class StructuredLogger {
  constructor(private readonly options: StructuredLoggerOptions) {}

  debug(message: string, context?: LogContext): void {
    this.emit("debug", message, context);
  }
  info(message: string, context?: LogContext): void {
    this.emit("info", message, context);
  }
  warn(message: string, context?: LogContext): void {
    this.emit("warn", message, context);
  }
  error(message: string, context?: LogContext): void {
    this.emit("error", message, context);
  }

  private emit(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.options.level]) return;
    const record: LogRecord = {
      level,
      message,
      ...(context ? { context } : {}),
      timestamp: Date.now(),
    };
    for (const sink of this.options.sinks) {
      try {
        sink(record);
      } catch {
        // sinks must never break the caller; swallow errors.
      }
    }
  }
}

export function stderrSink(): LogSink {
  return (record) => {
    const context = record.context ? ` ${JSON.stringify(record.context)}` : "";
    process.stderr.write(
      `[${new Date(record.timestamp).toISOString()}] ${record.level.toUpperCase()} ${record.message}${context}\n`,
    );
  };
}
