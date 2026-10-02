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

/** Where `createStderrSink` writes: stderr, unless a test hands in another. */
export type LineWriter = Pick<NodeJS.WritableStream, "write">;

/**
 * A sink that writes each record as one line:
 *
 *   [2026-10-02T07:15:29.123Z] WARN message {"context":"as JSON"}
 *
 * The desktop app reads the level back out of this shape (its agent.log
 * and Diagnostics label `atag serve`'s lines by it), so the shape is a
 * contract, pinned by `tracing.test.ts`.
 *
 * A factory, and named like one, because of how it was once misused:
 * `serve` handed the runtime the factory itself instead of the sink it
 * returns, and every record "written" built a sink and threw it away.
 * The parameter is what makes that a compile error: a `LogRecord` is
 * not a stream, so the factory does not type-check where a `LogSink`
 * is wanted.
 */
export function createStderrSink(
  stream: LineWriter = process.stderr,
): LogSink {
  return (record) => {
    const context = record.context ? ` ${JSON.stringify(record.context)}` : "";
    stream.write(
      `[${new Date(record.timestamp).toISOString()}] ${record.level.toUpperCase()} ${record.message}${context}\n`,
    );
  };
}
