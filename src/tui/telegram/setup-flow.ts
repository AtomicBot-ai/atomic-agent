import type { TelegramChannel } from "../../channels/telegram/index.js";

/**
 * Pure decision tree for "advance the Telegram setup flow by one
 * step". Lives in its own file so the orchestrator stays a thin
 * adapter and the flow stays trivially unit-testable in isolation.
 *
 * Returns the next action to take. The caller (orchestrator) is
 * responsible for executing it; this function does no I/O.
 *
 * Locked invariants (pinned by `setup-flow.test.ts`):
 *  - Each call returns exactly one action. The orchestrator never
 *    chains its own follow-up — re-pressing Enter is the only way to
 *    advance further.
 *  - The `none` case is returned for both the terminal "ready" state
 *    and transient `starting` / `stopping` windows. The caller does
 *    not need to distinguish them — both quietly do nothing.
 */
export type ConnectAction =
  | { kind: "open_token_prompt" }
  | { kind: "set_enabled"; enabled: boolean }
  | { kind: "start_pairing" }
  | { kind: "none" };

export interface ConnectFlowInput {
  /** True iff `process.env.TELEGRAM_BOT_TOKEN` is currently populated. */
  tokenPresent: boolean;
  /** Live channel state from `TelegramChannel.state()`. */
  channelState: ReturnType<TelegramChannel["state"]>;
  /** Live owner mirror from `TelegramChannel.getOwnerUserId()`. */
  ownerUserId: number | null;
}

/**
 * Drive the flow purely off live channel state. Reading from
 * `getConfig()` would risk staleness — the user config file is
 * mutated by `setEnabled` / `setOwnerUserId` and the cache is reset
 * lazily — but `channel.state()` is always authoritative because
 * `TelegramChannel` owns its own lifecycle.
 */
export function decideConnectAction(input: ConnectFlowInput): ConnectAction {
  if (!input.tokenPresent) return { kind: "open_token_prompt" };
  // `disabled` and `down` both mean "the operator wants the channel
  // running and it isn't". Map both to `set_enabled(true)` so a
  // single Enter press recovers from a rejected token without a
  // detour through a separate `restart` verb that wouldn't actually
  // recover from `down` (TelegramChannel.restart() only re-starts
  // when the previous state was `up`).
  if (input.channelState === "disabled" || input.channelState === "down") {
    return { kind: "set_enabled", enabled: true };
  }
  if (input.channelState === "up" && input.ownerUserId === null) {
    return { kind: "start_pairing" };
  }
  return { kind: "none" };
}
