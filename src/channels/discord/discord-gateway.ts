/**
 * Discord Gateway client over Node's built-in `WebSocket`.
 *
 * Implements the part of the protocol a bot actually needs: HELLO →
 * IDENTIFY → heartbeat loop → DISPATCH, plus RESUME after a droppable
 * disconnect and a fresh IDENTIFY after a fatal one. Everything else
 * (voice, sharding, compression, presence) is out of scope — this is a
 * single-operator remote control, not a bot framework.
 *
 * Reconnection is the whole reason this is a class. A laptop that
 * sleeps, a Wi-Fi change, or Discord's routine `op 7 RECONNECT` must
 * not silently end the channel, so drops are retried with exponential
 * backoff and full jitter. Codes Discord will never accept a retry for
 * (bad token, disallowed intents) stop the loop and surface instead.
 */

import {
  FATAL_CLOSE_CODES,
  OP,
  describeCloseCode,
  scrubDiscordError,
} from "./discord-channel-types.js";
import {
  backoffMs,
  defaultSleep,
  defaultSocket,
  type WebSocketLike,
} from "./discord-gateway-transport.js";

export interface GatewayLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface GatewayDeps {
  token: string;
  intents: number;
  /** Resolve the wss:// URL. Called again on a full reconnect. */
  gatewayUrl: () => Promise<string>;
  logger: GatewayLogger;
  /** One decoded DISPATCH payload. Never throws past the gateway. */
  onDispatch: (type: string, data: unknown) => void;
  /** Called when the socket is live and IDENTIFY/RESUME succeeded. */
  onReady?: () => void;
  /** Called when the loop gives up. `fatal` means do not retry. */
  onClosed?: (reason: string, fatal: boolean) => void;
  /** Test seam. Defaults to the global `WebSocket`. */
  createSocket?: (url: string) => WebSocketLike;
  /** Test seam for backoff. */
  sleep?: (ms: number) => Promise<void>;
}

export class DiscordGateway {
  private socket: WebSocketLike | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sequence: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private ackPending = false;
  private stopped = false;
  private attempt = 0;
  private running: Promise<void> | null = null;

  constructor(private readonly deps: GatewayDeps) {}

  /** Connect and keep reconnecting until `stop()`. Resolves immediately. */
  start(): void {
    if (this.running) return;
    this.stopped = false;
    this.running = this.loop().catch((err) => {
      this.deps.logger.warn("discord: gateway loop crashed", {
        error: scrubDiscordError(err),
      });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearHeartbeat();
    try {
      // 1000 tells Discord this is a clean close, which invalidates the
      // session -- correct here, because we do not intend to resume.
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
      let closeReason = "connection closed";
      let fatal = false;
      try {
        const outcome = await this.connectOnce();
        closeReason = outcome.reason;
        fatal = outcome.fatal;
      } catch (err) {
        closeReason = scrubDiscordError(err);
      }
      if (this.stopped) return;
      if (fatal) {
        this.deps.onClosed?.(closeReason, true);
        return;
      }
      this.attempt += 1;
      const delay = backoffMs(this.attempt);
      this.deps.logger.warn("discord: gateway disconnected, retrying", {
        reason: closeReason,
        attempt: this.attempt,
        delayMs: delay,
      });
      await (this.deps.sleep ?? defaultSleep)(delay);
    }
  }

  /** One socket lifetime. Resolves when it closes. */
  private connectOnce(): Promise<{ reason: string; fatal: boolean }> {
    return new Promise((resolve) => {
      void (async () => {
        let url: string;
        try {
          // A resume must go back to the URL READY handed us; a fresh
          // identify asks for a new one.
          url = this.sessionId
            ? (this.resumeUrl ?? (await this.deps.gatewayUrl()))
            : await this.deps.gatewayUrl();
        } catch (err) {
          resolve({ reason: scrubDiscordError(err), fatal: false });
          return;
        }
        const full = `${url}?v=10&encoding=json`;
        let socket: WebSocketLike;
        try {
          socket = (this.deps.createSocket ?? defaultSocket)(full);
        } catch (err) {
          resolve({ reason: scrubDiscordError(err), fatal: false });
          return;
        }
        this.socket = socket;
        let settled = false;
        const settle = (reason: string, fatal: boolean): void => {
          if (settled) return;
          settled = true;
          this.clearHeartbeat();
          resolve({ reason, fatal });
        };

        socket.addEventListener("error", (ev) => {
          this.deps.logger.warn("discord: gateway socket error", {
            error: scrubDiscordError(ev),
          });
        });
        socket.addEventListener("close", (ev) => {
          const fatal = FATAL_CLOSE_CODES.has(ev.code);
          if (fatal) {
            // The session is unusable; drop it so a retry (if the
            // operator fixes the token) identifies cleanly.
            this.sessionId = null;
          }
          settle(describeCloseCode(ev.code), fatal);
        });
        socket.addEventListener("message", (ev) => {
          try {
            this.handleFrame(String(ev.data), socket);
          } catch (err) {
            this.deps.logger.warn("discord: bad gateway frame", {
              error: scrubDiscordError(err),
            });
          }
        });
      })();
    });
  }

  private handleFrame(raw: string, socket: WebSocketLike): void {
    const frame = JSON.parse(raw) as {
      op: number;
      d?: unknown;
      s?: number | null;
      t?: string | null;
    };
    if (typeof frame.s === "number") this.sequence = frame.s;

    switch (frame.op) {
      case OP.HELLO: {
        const interval = (frame.d as { heartbeat_interval?: number })
          ?.heartbeat_interval;
        this.startHeartbeat(socket, interval ?? 41_250);
        if (this.sessionId) this.send(socket, OP.RESUME, {
          token: this.deps.token,
          session_id: this.sessionId,
          seq: this.sequence,
        });
        else this.identify(socket);
        return;
      }
      case OP.HEARTBEAT:
        // Discord may ask for one off-cycle.
        this.send(socket, OP.HEARTBEAT, this.sequence);
        return;
      case OP.HEARTBEAT_ACK:
        this.ackPending = false;
        return;
      case OP.RECONNECT:
        // Resumable: keep sessionId so the next connect sends RESUME.
        socket.close(4000, "reconnect requested");
        return;
      case OP.INVALID_SESSION: {
        // `d: true` means the session can still be resumed.
        const resumable = frame.d === true;
        if (!resumable) this.sessionId = null;
        socket.close(4000, "invalid session");
        return;
      }
      case OP.DISPATCH: {
        const type = frame.t ?? "";
        if (type === "READY") {
          const d = frame.d as {
            session_id?: string;
            resume_gateway_url?: string;
          };
          this.sessionId = d?.session_id ?? null;
          this.resumeUrl = d?.resume_gateway_url ?? null;
          this.attempt = 0;
          this.deps.onReady?.();
        }
        if (type === "RESUMED") {
          this.attempt = 0;
          this.deps.onReady?.();
        }
        this.deps.onDispatch(type, frame.d);
        return;
      }
      default:
        return;
    }
  }

  private identify(socket: WebSocketLike): void {
    this.send(socket, OP.IDENTIFY, {
      token: this.deps.token,
      intents: this.deps.intents,
      properties: { os: process.platform, browser: "atomic-agent", device: "atomic-agent" },
    });
  }

  private startHeartbeat(socket: WebSocketLike, intervalMs: number): void {
    this.clearHeartbeat();
    this.ackPending = false;
    this.heartbeatTimer = setInterval(() => {
      if (this.ackPending) {
        // A missed ACK means the connection is a zombie: the socket is
        // open but Discord is not listening. Closing with a non-1000
        // code keeps the session resumable.
        this.deps.logger.warn("discord: heartbeat not acknowledged, reconnecting");
        try {
          socket.close(4000, "zombie connection");
        } catch {
          // already closing
        }
        return;
      }
      this.ackPending = true;
      this.send(socket, OP.HEARTBEAT, this.sequence);
    }, intervalMs);
    // Never let the heartbeat keep a shutting-down process alive.
    this.heartbeatTimer.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private send(socket: WebSocketLike, op: number, d: unknown): void {
    try {
      socket.send(JSON.stringify({ op, d }));
    } catch (err) {
      this.deps.logger.warn("discord: gateway send failed", {
        error: scrubDiscordError(err),
      });
    }
  }
}
