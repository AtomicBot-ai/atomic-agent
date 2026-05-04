/**
 * Lifecycle status for a remote-control channel (Telegram today, more
 * later). The runtime emits a fresh `ChannelStatus` whenever the
 * channel's observable state changes — UIs (TUI panel, CLI stderr
 * line, sidecar host) subscribe via `RuntimeEventHandlers.onChannelStatus`.
 *
 * Kept narrow on purpose: a single string state and an optional
 * one-line error. Anything richer (uptime, last-message timestamp,
 * pending approvals) belongs in the channel-specific module — not in
 * the runtime contract — so adding a second messenger does not force
 * a schema change here.
 */
export type ChannelState =
  /** Channel is configured, started, and able to receive updates. */
  | "up"
  /** Channel attempted to start but failed (token, network, lockfile). */
  | "down"
  /** Channel is intentionally inactive (config flag off, missing token). */
  | "disabled"
  /** Channel is acquiring resources (token probe, lockfile, polling start). */
  | "starting"
  /** Channel is releasing resources (in-flight stop). */
  | "stopping";

export interface ChannelStatus {
  /** Stable identifier of the channel implementation, e.g. `"telegram"`. */
  channel: string;
  state: ChannelState;
  /**
   * One-line failure description when `state === "down"`. Token-shaped
   * substrings must be scrubbed by the channel before emission — the
   * runtime never inspects this field.
   */
  lastError?: string;
}
