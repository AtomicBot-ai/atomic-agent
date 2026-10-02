/**
 * PostHog over plain `fetch`: events batch in memory, flush every 10 s and
 * on quit (with a short timeout). Never throws, never retries forever — a
 * failed batch is dropped, because analytics must not be the thing that
 * grows without bound or holds the app open.
 *
 * Key and host are copied from `src/analytics/posthog-config.ts` (same
 * PostHog project, 506070): the desktop build cannot import from `src/`.
 */

export const POSTHOG_PROJECT_KEY = "phc_vUYmW2qixSnPt4qTZBTWaVFw3JXxyZi8iEiG5TCDYkoH";
export const POSTHOG_HOST = "https://us.i.posthog.com";
const POSTHOG_PLACEHOLDER_KEY = "PLACEHOLDER";

const FLUSH_EVERY_MS = 10_000;
const MAX_QUEUE = 500;
const MAX_BATCH = 100;

export interface QueuedEvent {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

export interface TransportDeps {
  /** True when sending is allowed right now (analytics on, not a test run). */
  canSend: () => boolean;
  distinctId: () => string | null;
  fetchImpl?: typeof fetch;
  /** Optional stderr echo of what would be sent (ATOMIC_DESKTOP_ANALYTICS_LOG=1). */
  echo?: (e: QueuedEvent) => void;
}

export class PostHogTransport {
  private queue: QueuedEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: TransportDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_EVERY_MS);
    // Never the reason the process stays alive.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  enqueue(event: string, properties: Record<string, unknown>): void {
    const e: QueuedEvent = { event, properties, timestamp: new Date().toISOString() };
    try {
      this.deps.echo?.(e);
    } catch {
      /* echo is a debugging aid only */
    }
    if (!this.deps.canSend()) return;
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push(e);
  }

  /** Throw away what is queued (the switch went off: nothing more may leave). */
  clear(): void {
    this.queue = [];
  }

  /**
   * Send what is queued: up to `maxBatches` batches of 100. The WHOLE call —
   * waiting out a batch already on the wire included — resolves within
   * `timeoutMs` whatever the network does; each request is aborted at that
   * same deadline.
   */
  flush(timeoutMs = 5_000, maxBatches = 1): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const work = (async () => {
      for (let i = 0; i < maxBatches; i++) {
        // A batch already on the wire finishes first; what was queued since goes next.
        if (this.inFlight) await this.inFlight;
        if (!this.queue.length) return;
        const left = deadline - Date.now();
        if (left <= 0) return;
        await this.sendOne(left);
      }
    })().catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    return Promise.race([work, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /** One batch on the wire, aborted after `timeoutMs`. */
  private sendOne(timeoutMs: number): Promise<void> {
    if (!this.deps.canSend() || (POSTHOG_PROJECT_KEY as string) === POSTHOG_PLACEHOLDER_KEY) {
      this.queue = [];
      return Promise.resolve();
    }
    const distinctId = this.deps.distinctId();
    if (!distinctId) return Promise.resolve();
    const batch = this.queue.splice(0, MAX_BATCH);
    const body = JSON.stringify({
      api_key: POSTHOG_PROJECT_KEY,
      batch: batch.map((e) => ({
        event: e.event,
        distinct_id: distinctId,
        timestamp: e.timestamp,
        properties: {
          ...e.properties,
          $ip: "0.0.0.0",
          $geoip_disable: true,
          $lib: "atomic-agent-desktop",
        },
      })),
    });
    const doFetch = this.deps.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let sending: Promise<void> | null = null;
    sending = (async () => {
      try {
        // Yield once, so `sending` is assigned before anything below can finish.
        await Promise.resolve();
        await doFetch(`${POSTHOG_HOST}/batch/`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: controller.signal,
        });
      } catch {
        /* dropped: analytics never retries into a growing queue */
      } finally {
        clearTimeout(timer);
        if (this.inFlight === sending) this.inFlight = null;
      }
    })();
    this.inFlight = sending;
    return sending;
  }
}
