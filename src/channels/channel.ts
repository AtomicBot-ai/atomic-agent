/**
 * The shared shape of a chat channel (ATO-1169).
 *
 * Telegram and Discord grew as two hand-wired classes, and every place
 * that starts, stops or reports a channel named both. A third messenger
 * would have meant touching bootstrap, shutdown, the runtime contract
 * and the config loader again. `Channel` is the small surface they
 * already share; `ChannelDefinition` is how a new adapter plugs in
 * without any of those edits: one entry in `channel-catalog.ts`.
 *
 * What stays adapter-specific on purpose: transport, reconnect policy,
 * formatting and length limits, pairing, approval buttons. The interface
 * only covers lifecycle and status, because that is all the runtime
 * needs to own a channel.
 */

import type { ApprovalGate } from "../approval/approval-gate.js";
import type { ApprovalRouter } from "../approval/approval-router.js";
import type { AtomicAgentConfig } from "../config/index.js";
import type { ExtraChannelConfig } from "../config/extra-channel-config.js";
import type { ChannelState, ChannelStatus } from "../runtime/channel-status.js";
import type { AgentRuntime } from "../runtime/runtime-contract.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";

/** Lifecycle and status every chat channel exposes. */
export interface Channel {
  /** Stable id, the same string as `ChannelStatus.channel` (e.g. `"slack"`). */
  readonly id: string;
  /** Current lifecycle state. */
  state(): ChannelState;
  /** One-line failure while `down`, token-shaped substrings scrubbed; else `null`. */
  lastError(): string | null;
  /**
   * Connect when enabled and configured. Must settle (never hang on the
   * network forever) and must not throw for an expected failure: a
   * missing token is `disabled`, a refused connection is `down`.
   */
  start(): Promise<void>;
  /** Disconnect, abort in-flight turns, release locks. Idempotent. */
  stop(): Promise<void>;
}

/** Everything a channel adapter may need from the runtime to build itself. */
export interface ChannelContext {
  runtime: AgentRuntime;
  config: AtomicAgentConfig;
  /** This channel's own `channels.<id>` block (defaults when absent). */
  channelConfig: ExtraChannelConfig;
  logger: StructuredLogger;
  approvals: ApprovalGate;
  approvalRouter: ApprovalRouter;
  /** `<stateDir>`; adapters keep pointers, locks and sessions under it. */
  stateDir: string;
  /** Inbound files land here: `<stateDir>/inbox/<id>`. */
  inboxDir: string;
  /** Publish a status change to hosts (`RuntimeEventHandlers.onChannelStatus`). */
  emitStatus: (status: ChannelStatus) => void;
}

/** How a channel adapter registers itself in `channel-catalog.ts`. */
export interface ChannelDefinition {
  /** Matches the `channels.<id>` config key and `Channel.id`. */
  readonly id: string;
  /** Human name for hosts and logs, e.g. `"Slack"`. */
  readonly label: string;
  /**
   * Platforms the adapter can run on (`process.platform` values). Omit
   * for every platform. iMessage, for example, is darwin-only.
   */
  readonly platforms?: readonly NodeJS.Platform[];
  /** Construct the channel. Must be side-effect free: no network, no files. */
  create(ctx: ChannelContext): Channel;
}

/** Narrow a status-shaped value for hosts that only hold a `Channel`. */
export function channelStatusOf(channel: Channel): ChannelStatus {
  const error = channel.lastError();
  return {
    channel: channel.id,
    state: channel.state(),
    ...(error !== null && channel.state() === "down" ? { lastError: error } : {}),
  };
}
