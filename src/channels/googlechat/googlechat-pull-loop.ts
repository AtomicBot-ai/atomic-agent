/**
 * The Pub/Sub pull loop: `POST {subscription}:pull` forever, hand each
 * batch to the channel, then `:acknowledge` every message in it.
 *
 * - Every message is acknowledged, including the ones the channel
 *   ignored or could not decode: an unacked message is redelivered
 *   after the ack deadline, and a poison message would loop forever.
 * - The ack goes out once the batch was *dispatched*, not once the
 *   turns it started finished: a turn can run for minutes, far past any
 *   ack deadline, and a redelivered request would run twice. Delivery
 *   is therefore at most once; Pub/Sub may still redeliver on its own,
 *   which the channel dedupes by message name.
 * - A transient failure (network, 429, 5xx) backs off with the shared
 *   full-jitter schedule and retries; the channel stays `up`.
 * - A permanent one (bad key, no permission, no such subscription) is
 *   fatal: retrying would fail identically forever.
 */

import { backoffMs } from "../reconnect-backoff.js";
import { GoogleChatApiError, type GoogleChatApi, type PubsubReceivedMessage } from "./googlechat-api.js";
import { PULL_MAX_MESSAGES, PULL_TIMEOUT_MS } from "./googlechat-types.js";

export interface GoogleChatPullLoopDeps {
  api: Pick<GoogleChatApi, "pull" | "acknowledge">;
  subscription: string;
  logger: {
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
  };
  /** First successful pull. Called once per `start()`. */
  onUp: () => void;
  onBatch: (messages: readonly PubsubReceivedMessage[]) => void | Promise<void>;
  /** The loop ended for good. */
  onFatal: (reason: string) => void;
  /** Test seams. */
  pullTimeoutMs?: number;
  backoff?: (attempt: number) => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class GoogleChatPullLoop {
  private abort: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: GoogleChatPullLoopDeps) {}

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

  /** Abort the in-flight pull and wait for the loop to exit. Idempotent. */
  async stop(): Promise<void> {
    const running = this.running;
    this.abort?.abort();
    await running?.catch(() => undefined);
  }

  private async run(signal: AbortSignal): Promise<void> {
    const { api, subscription, logger } = this.deps;
    let attempt = 0;
    let up = false;
    while (!signal.aborted) {
      let batch: PubsubReceivedMessage[];
      try {
        batch = await api.pull(
          subscription,
          PULL_MAX_MESSAGES,
          signal,
          this.deps.pullTimeoutMs ?? PULL_TIMEOUT_MS,
        );
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof GoogleChatApiError && err.fatal) {
          this.deps.onFatal(describeFatal(err));
          return;
        }
        attempt += 1;
        const delay = (this.deps.backoff ?? backoffMs)(attempt);
        logger.warn("googlechat: pull failed, retrying", {
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
      if (batch.length === 0) continue;
      try {
        await this.deps.onBatch(batch);
      } catch (err) {
        // The handler must never throw; if it does, still ack and keep polling.
        logger.warn("googlechat: batch handler failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        await api.acknowledge(
          subscription,
          batch.map((m) => m.ackId),
        );
      } catch (err) {
        logger.warn("googlechat: acknowledge failed; Pub/Sub may redeliver", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

function describeFatal(err: GoogleChatApiError): string {
  if (err.status === 404) return "The Pub/Sub subscription in channels.googlechat.options.subscription does not exist.";
  if (err.status === 403) {
    return "The service account may not pull from the subscription (grant it Pub/Sub Subscriber on it).";
  }
  if (err.status === 401) return `Google rejected the service-account key (GOOGLE_CHAT_CREDENTIALS): ${err.message}`;
  return `Google Chat pull failed: ${err.message}`;
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
