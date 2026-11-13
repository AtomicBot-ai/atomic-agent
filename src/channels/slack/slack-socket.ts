/**
 * Slack Socket Mode client over Node's built-in `WebSocket`.
 *
 * The protocol is small: `apps.connections.open` hands out a single-use
 * wss URL; the server greets with `hello`; every frame that carries an
 * `envelope_id` must be acknowledged by sending `{ envelope_id }` back
 * within three seconds or Slack retries it; `disconnect` asks the client
 * to reconnect (a routine refresh every few hours). Pings are WebSocket
 * control frames that the runtime answers on its own.
 *
 * Reconnection is why this is a class: a laptop that sleeps or changes
 * networks must not silently end the channel, so drops back off with
 * the shared full-jitter schedule. An error no retry fixes (bad token,
 * Socket Mode switched off for the app) stops the loop and reports.
 */

import { backoffMs } from "../reconnect-backoff.js";
import type { WebSocketLike } from "../discord/discord-gateway-transport.js";
import { SlackApiError } from "./slack-api.js";
import {
  FATAL_SLACK_ERRORS,
  describeSlackError,
  scrubSlackError,
  type SlackEnvelope,
} from "./slack-types.js";

export interface SlackSocketLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface SlackSocketDeps {
  /** Fresh wss URL; called again on every reconnect (URLs are single-use). */
  openUrl: () => Promise<string>;
  logger: SlackSocketLogger;
  /** One `events_api`, `interactive` or `slash_commands` envelope, already acknowledged. */
  onEnvelope: (envelope: SlackEnvelope) => void;
  /** `hello` received: the connection is live. */
  onReady?: () => void;
  /** A live connection dropped and the loop is about to retry. */
  onReconnecting?: () => void;
  /** The loop gave up. `fatal` means retrying would not help. */
  onClosed?: (reason: string, fatal: boolean) => void;
  /** Test seam; defaults to the global `WebSocket`. */
  createSocket?: (url: string) => WebSocketLike;
  /** Test seam for the jitter. */
  random?: () => number;
}

interface Outcome {
  reason: string;
  fatal: boolean;
}

export class SlackSocket {
  private socket: WebSocketLike | null = null;
  private stopped = false;
  private attempt = 0;
  private running: Promise<void> | null = null;
  /** The one backoff timer, `unref`'d; `stop()` cuts it short. */
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly deps: SlackSocketDeps) {}

  /** Connect and keep reconnecting until `stop()`. Returns immediately. */
  start(): void {
    if (this.running) return;
    this.stopped = false;
    this.running = this.loop().catch((err) => {
      this.deps.logger.warn("slack: socket loop crashed", { error: scrubSlackError(err) });
    });
  }

  /** Close the socket and end the loop. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    this.wake?.();
    this.wake = null;
    try {
      this.socket?.close(1000, "shutting down");
    } catch {
      // already gone
    }
    this.socket = null;
    const running = this.running;
    this.running = null;
    if (running) await running;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let outcome: Outcome;
      try {
        const url = await this.deps.openUrl();
        if (this.stopped) return;
        outcome = await this.connectOnce(url);
      } catch (err) {
        outcome = classify(err);
      }
      if (this.stopped) return;
      if (outcome.fatal) {
        this.deps.onClosed?.(outcome.reason, true);
        return;
      }
      this.deps.onReconnecting?.();
      this.attempt += 1;
      const delay = backoffMs(this.attempt, this.deps.random);
      this.deps.logger.warn("slack: socket disconnected, retrying", {
        reason: outcome.reason,
        attempt: this.attempt,
        delayMs: delay,
      });
      await this.sleep(delay);
    }
  }

  /** One socket lifetime; resolves when it closes. */
  private connectOnce(url: string): Promise<Outcome> {
    return new Promise((resolve) => {
      const socket = (this.deps.createSocket ?? defaultSocket)(url);
      this.socket = socket;
      let outcome: Outcome = { reason: "connection closed", fatal: false };
      socket.addEventListener("message", (ev) => {
        const next = this.onFrame(socket, ev.data);
        if (next) {
          outcome = next;
          try {
            socket.close(1000, "reconnecting");
          } catch {
            // already closing
          }
        }
      });
      socket.addEventListener("error", () => {
        // A `close` always follows; the reason is reported there.
      });
      socket.addEventListener("close", (ev) => {
        if (this.socket === socket) this.socket = null;
        if (outcome.reason === "connection closed" && ev.code !== 1000) {
          outcome = { reason: `socket closed with code ${ev.code}`, fatal: false };
        }
        resolve(outcome);
      });
    });
  }

  /**
   * Handle one frame. Returns an outcome when the frame ends this
   * connection (`disconnect`), otherwise `null`.
   */
  private onFrame(socket: WebSocketLike, data: unknown): Outcome | null {
    let envelope: SlackEnvelope;
    try {
      envelope = JSON.parse(typeof data === "string" ? data : String(data)) as SlackEnvelope;
    } catch {
      this.deps.logger.warn("slack: dropped a frame that is not JSON");
      return null;
    }
    // Ack first, before any work: Slack redelivers an envelope that is
    // not acknowledged within 3 s, and a turn takes far longer.
    if (typeof envelope.envelope_id === "string") {
      try {
        socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      } catch (err) {
        this.deps.logger.warn("slack: ack failed", { error: scrubSlackError(err) });
      }
    }
    switch (envelope.type) {
      case "hello":
        this.attempt = 0;
        this.deps.onReady?.();
        return null;
      case "disconnect":
        // `link_disabled`: Socket Mode was switched off for the app.
        // Reconnecting would be refused the same way forever.
        if (envelope.reason === "link_disabled") {
          return { reason: "Socket Mode is disabled for this Slack app.", fatal: true };
        }
        return { reason: `Slack asked to reconnect (${envelope.reason ?? "unknown"})`, fatal: false };
      case "events_api":
      case "interactive":
      case "slash_commands":
        try {
          this.deps.onEnvelope(envelope);
        } catch (err) {
          this.deps.logger.warn("slack: envelope handler threw", { error: scrubSlackError(err) });
        }
        return null;
      default:
        // Anything newer: acknowledged, ignored.
        return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.sleepTimer = setTimeout(() => {
        this.sleepTimer = null;
        this.wake = null;
        resolve();
      }, ms);
      this.sleepTimer.unref?.();
    });
  }
}

/** A failed `apps.connections.open` (or socket construction). */
function classify(err: unknown): Outcome {
  if (err instanceof SlackApiError && FATAL_SLACK_ERRORS.has(err.code)) {
    return { reason: describeSlackError(err.code), fatal: true };
  }
  return { reason: scrubSlackError(err), fatal: false };
}

function defaultSocket(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}
