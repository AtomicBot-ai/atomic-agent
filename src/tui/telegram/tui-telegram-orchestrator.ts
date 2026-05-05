import { getConfig } from "../../config/index.js";
import { TELEGRAM_BOT_TOKEN_KEY } from "../../channels/telegram/index.js";
import type { ChannelStatus } from "../../runtime/channel-status.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { TuiEventBus } from "../tui-app.js";
import { decideConnectAction } from "./setup-flow.js";

const PAIRING_DEFAULT_TIMEOUT_MS = 60_000;
const PAIRING_TICK_MS = 1_000;
const PAIRING_RESULT_DISMISS_MS = 4_000;

/**
 * Only TUI module that touches `runtime.telegramChannel`; mirrors
 * channel state into UI actions and owns the pairing countdown.
 * The bot token never leaves this file.
 */
export class TuiTelegramOrchestrator {
  private pairingTimer: NodeJS.Timeout | null = null;
  private dismissTimer: NodeJS.Timeout | null = null;
  private statusUnsubscribe: (() => void) | null = null;
  /** Mutex on `advanceConnect` / `submitToken`; inner recursion uses `_runConnectChain` to bypass it. */
  private advancing = false;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly bus: TuiEventBus & { emit(action: unknown): void },
  ) {}

  /** Push the initial settings + status snapshot. Idempotent. */
  start(): void {
    this.refreshSettings();
    const channel = this.runtime.telegramChannel;
    if (channel) {
      this.bus.emit({
        type: "telegram_status_changed",
        channelState: channel.state(),
        lastError: channel.lastError(),
      });
    }
  }

  /** Advance setup by exactly one step. Idempotent + concurrency-safe. */
  async advanceConnect(): Promise<void> {
    if (this.advancing) return;
    this.advancing = true;
    try {
      await this._runConnectChain();
    } finally {
      this.advancing = false;
    }
  }

  /** Inner workhorse for the connect flow; no concurrency guard here. */
  private async _runConnectChain(): Promise<void> {
    const channel = this.runtime.telegramChannel;
    if (!channel) {
      this.emitInfo("telegram channel unavailable in this runtime");
      return;
    }
    const action = decideConnectAction({
      tokenPresent: hasEnvToken(),
      channelState: channel.state(),
      ownerUserId: channel.getOwnerUserId(),
    });
    switch (action.kind) {
      case "open_token_prompt":
        this.bus.emit({ type: "telegram_token_prompt_opened" });
        return;
      case "set_enabled":
        await this.setEnabled(action.enabled);
        // Re-enter only on `up` so a rejected token (`down`) cannot
        // loop — each press becomes one user-driven retry attempt.
        if (this.runtime.telegramChannel?.state() === "up") {
          await this._runConnectChain();
        }
        return;
      case "start_pairing":
        await this.startPairing();
        return;
      case "none":
        return;
    }
  }

  /** Forward telegram-only `ChannelStatus`; returns `false` otherwise. */
  forwardStatus(status: ChannelStatus): boolean {
    if (status.channel !== "telegram") return false;
    this.bus.emit({
      type: "telegram_status_changed",
      channelState: status.state,
      lastError: status.lastError ?? null,
    });
    if (status.state === "down" || status.state === "up") {
      this.refreshSettings();
    }
    return true;
  }

  shutdown(): void {
    this.clearPairingTimer();
    this.clearDismissTimer();
    this.statusUnsubscribe?.();
    this.statusUnsubscribe = null;
  }

  /** One-shot refresh: re-read config + env + channel, dispatch `telegram_settings_synced`. */
  refreshSettings(): void {
    const config = getConfig();
    const channel = this.runtime.telegramChannel;
    const ownerFromChannel = channel ? channel.getOwnerUserId() : null;
    const identity = channel?.getBotIdentity() ?? null;
    this.bus.emit({
      type: "telegram_settings_synced",
      enabled: config.telegram.enabled,
      ownerUserId: ownerFromChannel ?? config.telegram.ownerUserId,
      hasToken: hasEnvToken(),
      botId: identity?.id ?? null,
      botUsername: identity?.username ?? null,
    });
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.runMutation(
      "setEnabled",
      enabled ? "telegram enabled" : "telegram disabled",
      (channel) => channel.setEnabled(enabled),
      { refresh: true },
    );
  }

  async restart(): Promise<void> {
    await this.runMutation(
      "restart",
      "telegram restarted",
      (channel) => channel.restart(),
      { refresh: false },
    );
  }

  async clearOwnerUserId(): Promise<void> {
    await this.runMutation(
      "setOwnerUserId",
      "owner cleared — telegram now ignores all DMs",
      (channel) => channel.setOwnerUserId(null),
      { refresh: true },
    );
  }

  /** Submit a token from the modal buffer. Empty / whitespace fails locally. */
  async submitToken(buffer: string): Promise<void> {
    if (this.advancing) return;
    const channel = this.runtime.telegramChannel;
    if (!channel) {
      this.bus.emit({
        type: "telegram_token_prompt_error_set",
        error: "telegram channel unavailable",
      });
      return;
    }
    const trimmed = buffer.trim();
    if (trimmed.length === 0) {
      this.bus.emit({
        type: "telegram_token_prompt_error_set",
        error: "token is empty",
      });
      return;
    }
    this.advancing = true;
    this.bus.emit({ type: "telegram_token_prompt_submitting_started" });
    this.bus.emit({ type: "telegram_action_started" });
    try {
      await channel.setToken(trimmed);
      this.bus.emit({ type: "telegram_token_prompt_closed" });
      this.bus.emit({
        type: "telegram_action_settled",
        message: "token saved",
      });
      this.refreshSettings();
      // Clean-install auto-advance: setEnabled(true) → start_pairing.
      // Step failures land on the chain's own action events; an
      // unexpected throw falls through to the surrounding catch.
      await this._runConnectChain();
    } catch (err) {
      const msg = errMsg(err);
      this.bus.emit({
        type: "telegram_token_prompt_error_set",
        error: msg,
      });
      this.bus.emit({
        type: "telegram_action_settled",
        error: `setToken failed: ${msg}`,
      });
    } finally {
      this.advancing = false;
    }
  }

  async clearToken(): Promise<void> {
    await this.runMutation(
      "clearToken",
      "token cleared",
      (channel) => channel.setToken(null),
      { refresh: true },
    );
  }

  async startPairing(timeoutMs: number = PAIRING_DEFAULT_TIMEOUT_MS): Promise<void> {
    const channel = this.runtime.telegramChannel;
    if (!channel) {
      this.emitInfo("telegram channel unavailable; cannot pair");
      return;
    }
    if (channel.state() !== "up") {
      this.emitInfo(
        "pairing requires the channel to be `up` — enable telegram and start it first",
      );
      return;
    }
    this.clearPairingTimer();
    const expiresAt = Date.now() + timeoutMs;
    this.bus.emit({
      type: "telegram_pairing_started",
      expiresAt,
      nowMs: Date.now(),
    });
    this.pairingTimer = setInterval(() => {
      this.bus.emit({ type: "telegram_pairing_tick", nowMs: Date.now() });
    }, PAIRING_TICK_MS);
    try {
      const outcome = await channel.startPairing(timeoutMs);
      this.bus.emit({
        type: "telegram_pairing_resolved",
        result: outcome
          ? {
              userId: outcome.claim.userId,
              chatId: outcome.claim.chatId,
              welcomeDelivered: outcome.welcomeDelivered,
            }
          : null,
      });
      if (outcome) {
        this.refreshSettings();
        this.scheduleResultDismiss();
      }
    } catch (err) {
      this.bus.emit({
        type: "telegram_pairing_resolved",
        result: null,
      });
      this.emitInfo(`pairing failed: ${errMsg(err)}`);
    } finally {
      this.clearPairingTimer();
    }
  }

  cancelPairing(): void {
    this.clearPairingTimer();
    const channel = this.runtime.telegramChannel;
    channel?.cancelPairing();
  }

  dismissPairingResult(): void {
    this.clearDismissTimer();
    this.bus.emit({ type: "telegram_pairing_modal_dismissed" });
  }

  toggleAdvanced(): void {
    this.bus.emit({ type: "telegram_advanced_toggled" });
  }

  private clearPairingTimer(): void {
    if (this.pairingTimer) {
      clearInterval(this.pairingTimer);
      this.pairingTimer = null;
    }
  }

  private clearDismissTimer(): void {
    if (this.dismissTimer) {
      clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
  }

  private scheduleResultDismiss(): void {
    this.clearDismissTimer();
    this.dismissTimer = setTimeout(() => {
      this.bus.emit({ type: "telegram_pairing_modal_dismissed" });
      this.dismissTimer = null;
    }, PAIRING_RESULT_DISMISS_MS);
  }

  private emitInfo(line: string): void {
    this.bus.emit({ type: "runtime_info", line });
  }

  /** Press → call channel → emit started/settled with shared busy + error surface. */
  private async runMutation(
    label: string,
    successMessage: string,
    op: (
      channel: NonNullable<AgentRuntime["telegramChannel"]>,
    ) => Promise<void>,
    options: { refresh: boolean },
  ): Promise<void> {
    const channel = this.runtime.telegramChannel;
    if (!channel) {
      this.emitInfo("telegram channel unavailable in this runtime");
      return;
    }
    this.bus.emit({ type: "telegram_action_started" });
    try {
      await op(channel);
      this.bus.emit({
        type: "telegram_action_settled",
        message: successMessage,
      });
      if (options.refresh) this.refreshSettings();
    } catch (err) {
      const msg = errMsg(err);
      this.bus.emit({
        type: "telegram_action_settled",
        error: `${label} failed: ${msg}`,
      });
      this.emitInfo(`telegram ${label} failed: ${msg}`);
    }
  }
}

function hasEnvToken(): boolean {
  const value = process.env[TELEGRAM_BOT_TOKEN_KEY];
  return typeof value === "string" && value.trim().length > 0;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
