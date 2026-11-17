/**
 * Server-Sent Events reader for `GET /api/v1/events` on a local
 * signal-cli daemon (ATO-629), with reconnect.
 *
 * The daemon keeps its last 1000 events and replays the ones after a
 * `Last-Event-ID`, so a reconnect after a daemon blip loses nothing we
 * already acknowledged by id. A refused connection (daemon not running)
 * is reported as `down` with a plain reason and retried on the shared
 * full-jitter backoff; one `unref`'d timer at a time, so a channel that
 * waits for the daemon never keeps the process alive on its own.
 */

import { backoffMs } from "../reconnect-backoff.js";
import { describeFetchError, type FetchLike } from "./signal-rpc.js";

/** How long a connect may take before it counts as unreachable. */
const CONNECT_TIMEOUT_MS = 10_000;

export interface SignalEventStreamDeps {
  url: string;
  /** One parsed `data:` payload (JSON). Must not throw; errors are swallowed. */
  onPayload: (payload: unknown) => void;
  /** The stream is open. */
  onUp: () => void;
  /** The stream failed or closed; a reconnect is already scheduled. */
  onDown: (reason: string) => void;
  fetch?: FetchLike;
  /** Test seam for the reconnect delay. */
  backoff?: (attempt: number) => number;
  connectTimeoutMs?: number;
}

/** One SSE event as the parser assembles it. */
export interface SseEvent {
  event: string;
  data: string;
  id: string | null;
}

/**
 * Incremental SSE line parser. Feed it decoded text in any chunking;
 * it calls `emit` once per blank-line-terminated event.
 */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private id: string | null = null;

  constructor(private readonly emit: (event: SseEvent) => void) {}

  push(text: string): void {
    this.buffer += text;
    let nl = this.buffer.search(/\r\n|\r|\n/);
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl);
      const sepLen = this.buffer.startsWith("\r\n", nl) ? 2 : 1;
      this.buffer = this.buffer.slice(nl + sepLen);
      this.line(line);
      nl = this.buffer.search(/\r\n|\r|\n/);
    }
  }

  private line(line: string): void {
    if (line.length === 0) {
      if (this.data.length > 0) {
        this.emit({ event: this.event || "message", data: this.data.join("\n"), id: this.id });
      }
      this.event = "";
      this.data = [];
      return;
    }
    if (line.startsWith(":")) return; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id") this.id = value;
  }
}

export class SignalEventStream {
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = true;
  private lastEventId: string | null = null;

  constructor(private readonly deps: SignalEventStreamDeps) {}

  /**
   * Begin streaming. Resolves once the first attempt settles (open or
   * failed), so the caller's `start()` reports a real state; later
   * reconnects run in the background.
   */
  start(): Promise<void> {
    this.stopped = false;
    this.attempt = 0;
    return new Promise((resolve) => {
      void this.connect(resolve);
    });
  }

  /** Abort the stream and any pending reconnect. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
  }

  private async connect(settled?: () => void): Promise<void> {
    if (this.stopped) {
      settled?.();
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    const connectTimer = setTimeout(
      () => controller.abort(new Error("timed out")),
      this.deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    );
    connectTimer.unref?.();
    const doFetch = this.deps.fetch ?? fetch;
    let reason: string;
    try {
      const res = await doFetch(`${this.deps.url}/api/v1/events`, {
        headers: {
          accept: "text/event-stream",
          ...(this.lastEventId !== null ? { "last-event-id": this.lastEventId } : {}),
        },
        signal: controller.signal,
      });
      clearTimeout(connectTimer);
      if (!res.ok || !res.body) {
        reason = `signal-cli event stream returned HTTP ${res.status}`;
      } else {
        this.attempt = 0;
        this.deps.onUp();
        settled?.();
        settled = undefined;
        await this.read(res.body);
        reason = "signal-cli event stream closed";
      }
    } catch (err) {
      clearTimeout(connectTimer);
      reason =
        this.controller === controller && !this.stopped
          ? `signal-cli daemon not reachable at ${this.deps.url} (${describeFetchError(err)})`
          : "";
    }
    if (this.stopped || this.controller !== controller) {
      settled?.();
      return;
    }
    this.deps.onDown(reason);
    settled?.();
    this.schedule();
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const parser = new SseParser((event) => this.dispatch(event));
    const reader = body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
    }
  }

  private dispatch(event: SseEvent): void {
    if (event.id !== null) this.lastEventId = event.id;
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return; // not JSON: nothing this channel acts on
    }
    try {
      this.deps.onPayload(payload);
    } catch {
      // The handler promises not to throw; this keeps the stream alive if it does.
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    const delay = (this.deps.backoff ?? backoffMs)(this.attempt++);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
    this.timer.unref?.();
  }
}
