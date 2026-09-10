import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { ChannelStatus } from "../../runtime/channel-status.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { AgentMetrics } from "../../tracing/agent-metrics.js";

import type { TelegramSettingsSink } from "./telegram-settings.js";
import type { InboundCallbackUpdate } from "./approval-bridge.js";
import type { InboundTextUpdate } from "./inbound-handler.js";
import type { TelegramApi } from "./outbound-sender.js";
import type { InboundFileUpdate } from "./telegram-file-update.js";
import type { ChannelLock } from "./telegram-lockfile.js";

/**
 * Narrow surface of a `grammy.Bot` consumed by the channel. The
 * default factory wraps grammy; tests can inject a fake that records
 * `start` / `stop` and invokes the registered text handler with
 * fabricated updates.
 */
/** Optional callbacks a bot factory may report through. */
export interface BotFactoryHooks {
  /** A failure inside grammy's own middleware / polling loop. */
  onError?: (error: Error) => void;
}

export interface BotInstance {
  readonly api: TelegramApi & {
    getMe(): Promise<{
      id: number;
      username?: string;
      /** `false` = privacy mode on: plain @mentions in groups are withheld. */
      can_read_all_group_messages?: boolean;
    }>;
    setMyCommands?(
      cmds: ReadonlyArray<{ command: string; description: string }>,
    ): Promise<unknown>;
  };
  setTextHandler(handler: (u: InboundTextUpdate) => void | Promise<void>): void;
  /**
   * Register the handler for file-bearing messages (photo, document,
   * video, audio, voice, animation, video note, sticker). Optional so
   * a fake bot that only exercises the text path still satisfies the
   * interface; the grammy adapter always provides it.
   */
  setFileHandler?(
    handler: (u: InboundFileUpdate) => void | Promise<void>,
  ): void;
  /**
   * Register the inline-keyboard callback handler. Optional because a
   * bot that never sends a keyboard does not need one — slice 1 ran
   * without it. Slice 2's `ApprovalBridge` requires it.
   */
  setCallbackHandler?(
    handler: (u: InboundCallbackUpdate) => void | Promise<void>,
  ): void;
  /**
   * Begin long-polling. Still fire-and-forget from the caller's point
   * of view — the loop runs in the background — but the loop's *death*
   * is now reported.
   *
   * `onStart` fires once the first `getUpdates` request has been
   * dispatched. `onStopped` fires when the polling loop ends for any
   * reason: a clean `stop()`, or a fatal error such as Telegram's 409
   * when a second process starts polling the same token. Without it the
   * channel had no way to learn its poller had died and went on
   * reporting `up` while silently receiving nothing.
   */
  start(onStart: () => void, onStopped?: (error?: unknown) => void): void;
  /** Stop polling. Resolves when the in-flight update settles. */
  stop(): Promise<void>;
}

export type BotFactory = (
  token: string,
  hooks?: BotFactoryHooks,
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
  /**
   * Test seam — override the user config path used by live-control
   * setters. Defaults to `<stateDir>/config.json` derived from
   * `config.paths.stateDir`. Tests point this at a tmp file.
   */
  userConfigPath?: string;
  /**
   * Owner override for a swarm unit. `undefined` (the primary channel)
   * reads `config.telegram.ownerUserId`; a unit passes its own.
   */
  ownerUserId?: number | null;
  /**
   * Where `setEnabled` / `setOwnerUserId` / `setToken` persist. Defaults
   * to `config.telegram` + `TELEGRAM_BOT_TOKEN`; a swarm unit supplies a
   * sink that writes its own config entry and `.env` key.
   */
  settings?: TelegramSettingsSink;
}

/**
 * Scrub anything that looks like a bot token from an error message
 * so logs and `lastError` strings never leak the secret.
 */
/**
 * Replace any Telegram bot-token-shaped substring with `<token>`.
 *
 * The shape is `<6..12 digits>:<≥30 [A-Za-z0-9_-] chars>`. The
 * regex deliberately omits `\b` boundaries because grammy and
 * fetch routinely embed the token directly inside a URL fragment
 * (`https://api.telegram.org/bot<token>/sendMessage`) where the
 * preceding char is `t` (\w), defeating word boundaries. The token
 * shape itself is unique enough that omitting boundaries is safe —
 * we have not observed a non-token substring matching this pattern
 * in production logs.
 */
export function scrubErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\d{6,12}:[A-Za-z0-9_-]{30,}/g, "<token>");
}

/**
 * Resolve the bot token at construction time. Explicit `deps.token`
 * (string or `null`) wins — that's the test seam. Otherwise read
 * `TELEGRAM_BOT_TOKEN` from the process environment, treating empty
 * string as "not configured" so a stray `TELEGRAM_BOT_TOKEN=` line in
 * `.env` does not show up as an `up` channel with an unauthenticated
 * bot.
 */
export function resolveTokenFromDeps(
  deps: Pick<TelegramChannelDeps, "token">,
): string | null {
  if (deps.token !== undefined) return deps.token;
  const fromEnv = process.env.TELEGRAM_BOT_TOKEN;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return null;
}
