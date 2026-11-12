/**
 * Batched OTLP/HTTP JSON exporter over the global `fetch`.
 *
 * Spans wait in a bounded queue and go out in batches: when a batch
 * fills, on a timer, and once more on shutdown. Every failure is
 * contained here — a refused connection, a 4xx/5xx, a timeout, a full
 * queue — so export can never slow a turn down or end it. A full queue
 * drops the oldest spans and counts them; a failed batch is dropped, not
 * retried, and a warning is logged once per run of failures rather than
 * once per batch.
 */
import {
  buildExportRequest,
  type OtlpKeyValue,
  type OtlpSpan,
} from "./otlp-json.js";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  /** Released unread so the connection goes back to the pool. */
  body?: { cancel(): Promise<void> } | null;
}>;

export interface OtlpExporterLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface OtlpExporterOptions {
  tracesUrl: string;
  headers: Readonly<Record<string, string>>;
  resource: OtlpKeyValue[];
  scope: { name: string; version?: string };
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  logger?: OtlpExporterLogger;
  /** Spans kept waiting at most; the oldest are dropped beyond it. */
  maxQueueSize?: number;
  /** Spans per request. */
  maxBatchSize?: number;
  /** How long a span may wait before its batch is sent. */
  scheduledDelayMs?: number;
  /** Per-request timeout. */
  exportTimeoutMs?: number;
}

export interface OtlpExporterStats {
  exported: number;
  dropped: number;
  failedBatches: number;
  queued: number;
}

export interface OtlpExporter {
  enqueue(span: OtlpSpan): void;
  /** Send everything queued now. Never rejects. */
  flush(): Promise<void>;
  /** Flush, then stop accepting spans. Bounded by `timeoutMs`. Never rejects. */
  shutdown(timeoutMs?: number): Promise<void>;
  stats(): OtlpExporterStats;
}

const DEFAULT_MAX_QUEUE = 2048;
const DEFAULT_MAX_BATCH = 512;
const DEFAULT_DELAY_MS = 5000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_MS = 3000;

export function createOtlpExporter(options: OtlpExporterOptions): OtlpExporter {
  const maxQueue = Math.max(1, options.maxQueueSize ?? DEFAULT_MAX_QUEUE);
  const maxBatch = Math.max(1, Math.min(options.maxBatchSize ?? DEFAULT_MAX_BATCH, maxQueue));
  const delayMs = options.scheduledDelayMs ?? DEFAULT_DELAY_MS;
  const timeoutMs = options.exportTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch: FetchLike | undefined =
    options.fetch ?? (typeof fetch === "function" ? (fetch as unknown as FetchLike) : undefined);
  const headers: Record<string, string> = {
    ...options.headers,
    "Content-Type": "application/json",
  };

  const queue: OtlpSpan[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let stopped = false;
  let failing = false;
  let droppedSinceWarn = 0;
  const counters = { exported: 0, dropped: 0, failedBatches: 0 };

  const warn = (message: string, context?: Record<string, unknown>): void => {
    try {
      options.logger?.warn(message, context);
    } catch {
      // logging is best-effort
    }
  };

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const send = async (batch: OtlpSpan[]): Promise<void> => {
    if (!doFetch) {
      counters.dropped += batch.length;
      return;
    }
    const body = JSON.stringify(buildExportRequest(batch, options.resource, options.scope));
    try {
      const response = await doFetch(options.tracesUrl, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      response.body?.cancel().catch(() => {});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      counters.exported += batch.length;
      if (failing) failing = false;
    } catch (err) {
      counters.failedBatches += 1;
      counters.dropped += batch.length;
      if (!failing) {
        failing = true;
        // The URL, never the headers: they hold the credentials.
        warn("otel: span export failed; spans dropped until the endpoint answers", {
          url: options.tracesUrl,
          spans: batch.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  /** Drain the queue batch by batch, one request at a time. */
  const drain = (): Promise<void> => {
    clearTimer();
    const run = inFlight.then(async () => {
      while (queue.length > 0) {
        await send(queue.splice(0, maxBatch));
      }
    });
    inFlight = run.catch(() => {});
    return inFlight;
  };

  const schedule = (): void => {
    if (timer !== null || stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, delayMs);
    // Never hold the process open just to send telemetry.
    (timer as { unref?: () => void }).unref?.();
  };

  return {
    enqueue(span) {
      if (stopped) return;
      if (queue.length >= maxQueue) {
        queue.shift();
        counters.dropped += 1;
        droppedSinceWarn += 1;
        if (droppedSinceWarn === 1) {
          warn("otel: span queue full; dropping the oldest spans", { maxQueueSize: maxQueue });
        }
      } else {
        droppedSinceWarn = 0;
      }
      queue.push(span);
      if (queue.length >= maxBatch) void drain();
      else schedule();
    },
    flush: () => drain(),
    async shutdown(limitMs = DEFAULT_SHUTDOWN_MS) {
      if (stopped) return inFlight;
      const flushed = drain();
      stopped = true;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        flushed,
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, limitMs);
          (deadline as { unref?: () => void }).unref?.();
        }),
      ]);
      if (deadline !== undefined) clearTimeout(deadline);
    },
    stats: () => ({ ...counters, queued: queue.length }),
  };
}
