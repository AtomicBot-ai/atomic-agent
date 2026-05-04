import { resolve } from "node:path";

import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { ChannelStatus } from "../../runtime/channel-status.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { AgentMetrics } from "../../tracing/agent-metrics.js";

import {
  handleInboundText,
  type InboundTextUpdate,
} from "./inbound-handler.js";
import { ApprovalBridge, type InboundCallbackUpdate } from "./approval-bridge.js";
import type { TelegramApi } from "./outbound-sender.js";
import { TelegramSessionPointer } from "./telegram-session-pointer.js";
import { TelegramLockfile, type ChannelLock } from "./telegram-lockfile.js";
import { defaultGrammyBotFactory } from "./telegram-bot-factory.js";

export type { ChannelLock } from "./telegram-lockfile.js";

/**
 * Narrow surface of a `grammy.Bot` consumed by the channel. The
 * default factory wraps grammy; tests can inject a fake that records
 * `start` / `stop` and invokes the registered text handler with
 * fabricated updates.
 */
export interface BotInstance {
  readonly api: TelegramApi & {
    getMe(): Promise<{ id: number; username?: string }>;
    setMyCommands?(
      cmds: ReadonlyArray<{ command: string; description: string }>,
    ): Promise<unknown>;
  };
  setTextHandler(handler: (u: InboundTextUpdate) => void | Promise<void>): void;
  /**
   * Register the inline-keyboard callback handler. Optional because a
   * bot that never sends a keyboard does not need one — slice 1 ran
   * without it. Slice 2's `ApprovalBridge` requires it.
   */
  setCallbackHandler?(
    handler: (u: InboundCallbackUpdate) => void | Promise<void>,
  ): void;
  /**
   * Begin long-polling. Implementations are fire-and-forget — the
   * polling loop runs in the background until `stop()` is called and
   * any internal promise from grammy's `bot.start()` is left unawaited.
   * `onStart` fires once the first `getUpdates` request has been
   * dispatched.
   */
  start(onStart: () => void): void;
  /** Stop polling. Resolves when the in-flight update settles. */
  stop(): Promise<void>;
}

export type BotFactory = (
  token: string,
) => BotInstance | Promise<BotInstance>;

export interface TelegramChannelDeps {
  runtime: AgentRuntime;
  config: AtomicAgentConfig;
  /**
   * Bot token. Three forms:
   *   - `string`  — explicit token (production wiring rarely uses this; tests do).
   *   - `null`    — explicitly "no token configured" (overrides env).
   *   - omitted   — read `process.env.TELEGRAM_BOT_TOKEN` at construction time.
   * The channel is the single source of truth for token resolution; the
   * runtime bootstrap deliberately does not look at the env var so it
   * stays agnostic of telegram-specific naming.
   */
  token?: string | null;
  logger: StructuredLogger;
  metrics?: AgentMetrics;
  emitStatus?: (status: ChannelStatus) => void;
  /** Test seam — swap the grammy adapter. */
  botFactory?: BotFactory;
  /** Test seam — swap the lockfile. Defaults to `<stateDir>/telegram.lock`. */
  lock?: ChannelLock;
  /** Test seam — override the pointer path. Defaults to `<stateDir>/telegram-session.json`. */
  sessionPointerPath?: string;
}

const CHANNEL_NAME = "telegram";

/**
 * Lifecycle orchestrator for the Telegram remote-control channel.
 * Slice 1 surface only: constructor + `start` / `stop` / `state` /
 * `lastError`. Live-control setters (`setToken`, `setEnabled`,
 * `setOwnerUserId`, `restart`, pairing) ship in slice 3.
 */
export class TelegramChannel {
  private readonly deps: TelegramChannelDeps;
  private readonly sessionPointer: TelegramSessionPointer;
  private readonly lock: ChannelLock;
  private readonly inflight = new Map<number, AbortController>();
  private readonly token: string | null;
  private bot: BotInstance | null = null;
  private approvalBridge: ApprovalBridge | null = null;
  /**
   * The approval router subscription for the currently active
   * Telegram session. Re-bound by `ensureApprovalSession` whenever
   * the inbound handler swaps to a different session (lazy creation,
   * `/new` rotation, missing-pointer recovery).
   */
  private approvalSubscription: {
    sessionId: string;
    chatId: number;
    unsubscribe: () => void;
  } | null = null;
  private currentState: ChannelStatus["state"] = "disabled";
  private currentError: string | null = null;
  private startInFlight = false;

  constructor(deps: TelegramChannelDeps) {
    this.deps = deps;
    this.token = resolveToken(deps);
    const stateDir = deps.config.paths.stateDir;
    this.sessionPointer = new TelegramSessionPointer(
      deps.sessionPointerPath ?? resolve(stateDir, "telegram-session.json"),
    );
    this.lock =
      deps.lock ?? new TelegramLockfile(resolve(stateDir, "telegram.lock"));
  }

  state(): ChannelStatus["state"] {
    return this.currentState;
  }

  lastError(): string | null {
    return this.currentError;
  }

  /**
   * Acquire the lock, validate the token via `getMe`, register the
   * inbound handler, and begin polling. Idempotent: a second `start()`
   * while already up is a no-op. Failures emit `down` with a single-
   * line error and never throw past this boundary — the runtime
   * bootstrap should not be torn down because Telegram is unreachable.
   */
  async start(): Promise<void> {
    if (this.currentState === "up" || this.startInFlight) return;
    if (!this.token) {
      this.transition("down", "missing TELEGRAM_BOT_TOKEN");
      return;
    }
    this.startInFlight = true;
    this.transition("starting", null);
    try {
      this.lock.acquire();
      const factory = this.deps.botFactory ?? defaultGrammyBotFactory;
      const bot = await factory(this.token);
      const me = await bot.api.getMe();
      this.deps.logger.info("telegram: getMe ok", {
        botId: me.id,
        botUsername: me.username,
      });
      const bridge = new ApprovalBridge({
        api: bot.api,
        approvals: this.deps.runtime.approvals,
        ownerUserId: this.deps.config.telegram.ownerUserId,
        logger: this.deps.logger,
      });
      this.approvalBridge = bridge;
      bot.setTextHandler((update) =>
        handleInboundText(update, {
          runtime: this.deps.runtime,
          api: bot.api,
          sessionPointer: this.sessionPointer,
          logger: this.deps.logger,
          ownerUserId: this.deps.config.telegram.ownerUserId,
          inflight: this.inflight,
          ensureApprovalSession: (sessionId, chatId) =>
            this.ensureApprovalSession(sessionId, chatId),
        }),
      );
      bot.setCallbackHandler?.((update) => bridge.handleCallback(update));
      try {
        await bot.api.setMyCommands?.([
          { command: "start", description: "Show help" },
          { command: "help", description: "Show help" },
          { command: "status", description: "Show active session" },
          { command: "new", description: "Start a fresh session" },
          { command: "cancel", description: "Cancel the current turn" },
        ]);
      } catch (err) {
        this.deps.logger.warn("telegram: setMyCommands failed (non-fatal)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      bot.start(() => {
        this.deps.logger.info("telegram: polling started");
      });
      this.bot = bot;
      this.transition("up", null);
    } catch (err) {
      try {
        this.lock.release();
      } catch {
        // ignore — we are in the failure path already
      }
      this.transition("down", scrubErrorMessage(err));
    } finally {
      this.startInFlight = false;
    }
  }

  /**
   * Stop polling, abort any in-flight turn the channel started, and
   * release the lockfile. Idempotent: a second `stop()` is a no-op.
   * Always ends in `disabled` regardless of how `stop()` itself fares.
   */
  async stop(): Promise<void> {
    if (this.currentState === "disabled" && !this.bot) return;
    this.transition("stopping", null);
    for (const controller of this.inflight.values()) {
      try {
        controller.abort();
      } catch {
        // never let an aborted controller fail the shutdown sequence
      }
    }
    this.inflight.clear();
    // Drop the approval subscription before tearing down the bot so a
    // late-arriving approval request lands on the host fallback
    // instead of a no-op closure.
    this.approvalSubscription?.unsubscribe();
    this.approvalSubscription = null;
    this.approvalBridge?.cancelAll();
    this.approvalBridge = null;
    if (this.bot) {
      try {
        await this.bot.stop();
      } catch (err) {
        this.deps.logger.warn("telegram: bot.stop() failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.bot = null;
    }
    try {
      this.lock.release();
    } catch (err) {
      this.deps.logger.warn("telegram: lock.release() failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.transition("disabled", null);
  }

  /**
   * Bind (or re-bind) the approval router so requests for the active
   * Telegram session land on the inline-keyboard bridge with the
   * right `chatId`. Called by the inbound handler every time it
   * acquires a session — no-op when the binding is already current.
   * `chatId` enters the closure because a request only ever needs to
   * reach the chat that originated the latest turn, not the session
   * that was current at request-creation time.
   */
  private ensureApprovalSession(sessionId: string, chatId: number): void {
    if (
      this.approvalSubscription &&
      this.approvalSubscription.sessionId === sessionId &&
      this.approvalSubscription.chatId === chatId
    ) {
      return;
    }
    this.approvalSubscription?.unsubscribe();
    this.approvalSubscription = null;
    const bridge = this.approvalBridge;
    if (!bridge) return;
    const unsubscribe = this.deps.runtime.setApprovalHandlerForSession(
      sessionId,
      (request) => {
        void bridge.dispatch(request, chatId);
      },
    );
    this.approvalSubscription = { sessionId, chatId, unsubscribe };
  }

  private transition(
    next: ChannelStatus["state"],
    error: string | null,
  ): void {
    if (
      this.currentState === next &&
      (this.currentError ?? null) === (error ?? null)
    ) {
      return;
    }
    this.currentState = next;
    this.currentError = error;
    const status: ChannelStatus = {
      channel: CHANNEL_NAME,
      state: next,
      ...(error !== null ? { lastError: error } : {}),
    };
    try {
      this.deps.emitStatus?.(status);
    } catch (err) {
      this.deps.logger.warn("telegram: status sink threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Scrub anything that looks like a bot token from an error message
 * so logs and `lastError` strings never leak the secret.
 */
export function scrubErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, "<token>");
}

/**
 * Resolve the bot token. Explicit `deps.token` (string or `null`) wins
 * — that's the test seam. Otherwise read `TELEGRAM_BOT_TOKEN` from the
 * process environment, treating empty string as "not configured" so a
 * stray `TELEGRAM_BOT_TOKEN=` line in `.env` does not show up as an
 * `up` channel with an unauthenticated bot.
 */
function resolveToken(deps: TelegramChannelDeps): string | null {
  if (deps.token !== undefined) return deps.token;
  const fromEnv = process.env.TELEGRAM_BOT_TOKEN;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return null;
}
