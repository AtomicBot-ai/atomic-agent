/**
 * The Matrix long-poll loop: `GET /sync?since=…&timeout=30000` forever,
 * handing each batch to the channel and persisting `next_batch` after it.
 *
 * - First run (no stored token): one initial sync with `timeout=0`,
 *   reported as `initial` so the channel skips the timeline (that is
 *   room history, not new requests) but still sees pending invites.
 * - A transient failure (network, 5xx, timeout) backs off with the
 *   shared full-jitter schedule and retries; the channel stays `up`.
 * - A dead token (401, `M_UNKNOWN_TOKEN`) is fatal: retrying would fail
 *   identically forever, so the loop ends and the channel reports it.
 * - A `since` the server no longer knows restarts from a fresh initial
 *   sync rather than wedging.
 *
 * `onBatch` must be quick: it dispatches turns without awaiting them,
 * so a long turn never stalls the poll (and `/cancel` can still arrive).
 * The token is saved after the batch was handed over, so a crash in
 * the middle replays at most that one batch.
 */

import { backoffMs } from "../reconnect-backoff.js";
import { MatrixApiError, type MatrixApi, type MatrixSyncResponse } from "./matrix-api.js";
import { MATRIX_SYNC_TIMEOUT_MS } from "./matrix-types.js";

export interface MatrixSyncLoopDeps {
  api: Pick<MatrixApi, "sync">;
  store: { load(userId: string): string | null; save(userId: string, nextBatch: string): void };
  userId: string;
  logger: {
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
  };
  /** First successful sync. Called once per `start()`. */
  onUp: () => void;
  onBatch: (batch: MatrixSyncResponse, info: { initial: boolean }) => void | Promise<void>;
  /** The loop ended for good (dead token). */
  onFatal: (reason: string) => void;
  timeoutMs?: number;
  /** Test seams. */
  backoff?: (attempt: number) => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class MatrixSyncLoop {
  private abort: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: MatrixSyncLoopDeps) {}

  /** Begin polling in the background. A second call while running is a no-op. */
  start(): void {
    if (this.running) return;
    const abort = new AbortController();
    this.abort = abort;
    this.running = this.run(abort.signal).finally(() => {
      if (this.abort === abort) {
        this.abort = null;
        this.running = null;
      }
    });
  }

  /** Abort the in-flight poll and wait for the loop to exit. Idempotent. */
  async stop(): Promise<void> {
    const running = this.running;
    this.abort?.abort();
    await running?.catch(() => undefined);
  }

  private async run(signal: AbortSignal): Promise<void> {
    const { api, store, userId, logger } = this.deps;
    let since = store.load(userId);
    let attempt = 0;
    let up = false;
    while (!signal.aborted) {
      const initial = since === null;
      let batch: MatrixSyncResponse;
      try {
        batch = await api.sync(
          since,
          initial ? 0 : (this.deps.timeoutMs ?? MATRIX_SYNC_TIMEOUT_MS),
          signal,
        );
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof MatrixApiError && err.fatal) {
          this.deps.onFatal(describeFatal(err));
          return;
        }
        if (err instanceof MatrixApiError && err.errcode === "M_UNKNOWN_POS") {
          logger.warn("matrix: stored sync position expired, starting fresh");
          since = null;
          continue;
        }
        attempt += 1;
        const delay = (this.deps.backoff ?? backoffMs)(attempt);
        logger.warn("matrix: sync failed, retrying", {
          attempt,
          delayMs: delay,
          error: err instanceof Error ? err.message : String(err),
        });
        await (this.deps.wait ?? abortableWait)(delay, signal);
        continue;
      }
      if (signal.aborted) return;
      attempt = 0;
      if (!up) {
        up = true;
        this.deps.onUp();
      }
      try {
        await this.deps.onBatch(batch, { initial });
      } catch (err) {
        // The handler must never throw; if it does, keep polling.
        logger.warn("matrix: batch handler failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      since = batch.next_batch;
      try {
        store.save(userId, since);
      } catch (err) {
        logger.warn("matrix: could not save the sync position", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

function describeFatal(err: MatrixApiError): string {
  if (err.errcode === "M_USER_DEACTIVATED") return "The Matrix bot account is deactivated.";
  return "The Matrix homeserver rejected the access token (MATRIX_ACCESS_TOKEN).";
}

/** One `unref`'d timer, cleared early when the loop is stopped. */
function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    timer.unref();
    signal.addEventListener("abort", done, { once: true });
  });
}
