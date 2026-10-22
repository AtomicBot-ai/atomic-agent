import { getConfig } from "../../config/index.js";
import {
  DEFAULT_PAIRING_TIMEOUT_MS,
  pairedOwnerLine,
  pairingInstruction,
  replaceOwnerPrompt,
  TELEGRAM_BOT_TOKEN_KEY,
  type OpenedPairingWindow,
} from "../../channels/telegram/index.js";
import type { ChannelStatus } from "../../runtime/channel-status.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { TuiEventBus } from "../tui-app.js";
import { decideConnectAction } from "./setup-flow.js";

const PAIRING_TICK_MS = 1_000;
const PAIRING_RESULT_DISMISS_MS = 4_000;
/** How long asking to pair again counts as confirming the replacement of a paired owner. */
export const REPLACE_OWNER_CONFIRM_MS = 15_000;

/** What a pairing claim looks like to the TUI. */
export interface PairingClaimSummary {
  userId: number;
  chatId: number;
  username: string | null;
  welcomeDelivered: boolean;
}

/**
 * The answer to "open a pairing window" (ATO-718):
 *  - `opened`: the window is open; show `code` to the operator.
 *    `outcome` settles when it closes, with the claim or `null`.
 *  - `confirm_replace`: an owner is paired; nothing was opened. Asking
 *    again within `REPLACE_OWNER_CONFIRM_MS` replaces them.
 *  - `unavailable`: no window could open; `reason` says why.
 */
export type PairingRequest =
  | {
      kind: "opened";
      code: string;
      expiresAt: number;
      timeoutMs: number;
      botUsername: string | null;
      outcome: Promise<PairingClaimSummary | null>;
    }
  | { kind: "confirm_replace"; ownerUserId: number }
  | { kind: "unavailable"; reason: string };

/**
 * Only TUI module that touches `runtime.telegramChannel`; mirrors
 * channel state into UI actions and owns the pairing countdown.
 * The bot token never leaves this file.
 */
export class TuiTelegramOrchestrator {
  private pairingTimer: NodeJS.Timeout | null = null;
  private dismissTimer: NodeJS.Timeout | null = null;
  /** When pairing was first asked for while an owner was paired. */
  private replaceArmedAt: number | null = null;
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

  /**
   * Hub seam: a credential writer has already persisted the token to
   * `<stateDir>/.env`; push it into the live channel and bring the
   * channel up, the way `submitToken` does for the token it writes
   * itself.
   *
   * Without this the hub's save was inert in the running process --
   * the channel resolved its token at construction, and its `restart()`
   * only re-starts a channel that was already `up`, so a token pasted
   * into a fresh install left the channel `disabled` with no poller
   * and no way to pair until the next launch.
   */
  async adoptToken(): Promise<void> {
    const channel = this.runtime.telegramChannel;
    if (!channel) throw new Error("telegram channel unavailable");
    channel.adoptTokenFromEnv();
    this.refreshSettings();
    if (!hasEnvToken()) {
      // Token cleared: stop the channel rather than leaving a poller
      // running on a credential the operator has just removed.
      await this.setEnabled(false);
      return;
    }
    // Start the channel, but deliberately NOT the connect chain: that
    // chain ends in a pairing window, and the hub offers
    // pairing as its own `p` action. Saving a token means "run this
    // bot", not "claim an owner right now".
    await this.setEnabled(true);
  }

  /**
   * Bring the channel up so a pairing window can actually claim a DM.
   * Throws with the channel's own reason when it cannot -- the caller
   * shows that to the operator instead of an optimistic "DM your bot
   * now" that nothing is listening for.
   */
  async ensureUpForPairing(): Promise<void> {
    const channel = this.runtime.telegramChannel;
    if (!channel) throw new Error("telegram channel unavailable");
    if (channel.state() === "up") return;
    channel.adoptTokenFromEnv();
    await this.setEnabled(true);
    if (this.runtime.telegramChannel?.state() === "up") return;
    const reason = this.runtime.telegramChannel?.lastError();
    throw new Error(
      reason
        ? `channel is not running: ${reason}`
        : "channel is not running — set Channel to on first",
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

  /**
   * Open a pairing window, or say why not. Returns as soon as the
   * window is open (the code is known then); `outcome` settles when it
   * closes. While an owner is paired the first call only arms the
   * confirmation, and a second call within `REPLACE_OWNER_CONFIRM_MS`
   * opens a window that may replace them. The code goes only to the
   * caller, for the operator's screen; it is not put in panel state
   * or logged.
   */
  requestPairing(timeoutMs: number = DEFAULT_PAIRING_TIMEOUT_MS): PairingRequest {
    const channel = this.runtime.telegramChannel;
    if (!channel) {
      return { kind: "unavailable", reason: "telegram channel unavailable; cannot pair" };
    }
    if (channel.state() !== "up") {
      return {
        kind: "unavailable",
        reason: "pairing requires the channel to be `up`: enable telegram and start it first",
      };
    }
    const owner = channel.getOwnerUserId();
    let replaceOwner = false;
    if (owner !== null) {
      const now = Date.now();
      if (
        this.replaceArmedAt === null ||
        now - this.replaceArmedAt > REPLACE_OWNER_CONFIRM_MS
      ) {
        this.replaceArmedAt = now;
        return { kind: "confirm_replace", ownerUserId: owner };
      }
      replaceOwner = true;
    }
    this.replaceArmedAt = null;
    let opened: OpenedPairingWindow | null = null;
    const outcome = this.runPairing(channel, timeoutMs, replaceOwner, (pairingWindow) => {
      opened = pairingWindow;
    });
    // `onOpened` runs synchronously inside `channel.startPairing`, so
    // the window is known here or it never opened.
    const openedWindow = opened as OpenedPairingWindow | null;
    if (openedWindow === null) {
      return { kind: "unavailable", reason: "the pairing window did not open" };
    }
    return {
      kind: "opened",
      code: openedWindow.code,
      expiresAt: openedWindow.expiresAt,
      timeoutMs,
      botUsername: channel.getBotIdentity()?.username ?? null,
      outcome,
    };
  }

  /**
   * `/telegram pair` and the connect flow: open a window and narrate it
   * as info lines (the code, then who became the owner).
   */
  async startPairing(
    timeoutMs: number = DEFAULT_PAIRING_TIMEOUT_MS,
  ): Promise<void> {
    const request = this.requestPairing(timeoutMs);
    switch (request.kind) {
      case "unavailable":
        this.emitInfo(request.reason);
        return;
      case "confirm_replace":
        this.emitInfo(
          replaceOwnerPrompt({
            ownerUserId: request.ownerUserId,
            confirmSeconds: REPLACE_OWNER_CONFIRM_MS / 1000,
            again: "Run /telegram pair again",
          }),
        );
        return;
      case "opened": {
        this.emitInfo(pairingInstruction(request));
        const claim = await request.outcome;
        this.emitInfo(
          claim ? pairedOwnerLine(claim) : "Pairing window closed without a claim.",
        );
        return;
      }
    }
  }

  /** The window itself: countdown, channel call, resolution actions. */
  private async runPairing(
    channel: NonNullable<AgentRuntime["telegramChannel"]>,
    timeoutMs: number,
    replaceOwner: boolean,
    onOpened: (pairingWindow: OpenedPairingWindow) => void,
  ): Promise<PairingClaimSummary | null> {
    this.clearPairingTimer();
    try {
      const outcome = await channel.startPairing(timeoutMs, {
        replaceOwner,
        onOpened: (opened) => {
          onOpened(opened);
          this.bus.emit({
            type: "telegram_pairing_started",
            expiresAt: opened.expiresAt,
            nowMs: Date.now(),
          });
          this.pairingTimer = setInterval(() => {
            this.bus.emit({ type: "telegram_pairing_tick", nowMs: Date.now() });
          }, PAIRING_TICK_MS);
        },
      });
      const result: PairingClaimSummary | null = outcome
        ? {
            userId: outcome.claim.userId,
            chatId: outcome.claim.chatId,
            username: outcome.claim.username,
            welcomeDelivered: outcome.welcomeDelivered,
          }
        : null;
      this.bus.emit({ type: "telegram_pairing_resolved", result });
      if (result) {
        this.refreshSettings();
        this.scheduleResultDismiss();
      }
      return result;
    } catch (err) {
      this.bus.emit({
        type: "telegram_pairing_resolved",
        result: null,
      });
      this.emitInfo(`pairing failed: ${errMsg(err)}`);
      return null;
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
