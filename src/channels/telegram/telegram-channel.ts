import { resolve } from "node:path";

import type { ChannelStatus } from "../../runtime/channel-status.js";
import { getUserConfigPath } from "../../config/index.js";

import {
  handleInboundText,
  type InboundTextUpdate,
} from "./inbound-handler.js";
import { ApprovalBridge } from "./approval-bridge.js";
import { TelegramSessionPointer } from "./telegram-session-pointer.js";
import { TelegramLockfile, type ChannelLock } from "./telegram-lockfile.js";
import { defaultGrammyBotFactory } from "./telegram-bot-factory.js";
import {
  DefaultPairingMode,
  type ClaimedPairing,
  type PairingMode,
} from "./pairing-mode.js";
import {
  writeTelegramSettings,
  writeTelegramToken,
} from "./telegram-settings.js";
import { sendWelcomeMessage } from "./welcome-message.js";
import {
  resolveTokenFromDeps,
  scrubErrorMessage,
  type BotInstance,
  type TelegramChannelDeps,
} from "./telegram-channel-types.js";

export type { ChannelLock } from "./telegram-lockfile.js";
export type {
  BotFactory,
  BotInstance,
  TelegramChannelDeps,
} from "./telegram-channel-types.js";
export { scrubErrorMessage } from "./telegram-channel-types.js";

const CHANNEL_NAME = "telegram";

export interface PairingStateSnapshot {
  active: boolean;
  expiresAt: number | null;
}

/**
 * Outcome of a successful pairing claim. `claim` is what the operator
 * "won"; `welcomeDelivered` reports whether the post-persistence
 * confirmation DM was actually accepted by Telegram. The TUI reads
 * the second field so it never claims delivery when the welcome was
 * skipped (bot null after a failed restart) or rejected (sendMessage
 * threw and was swallowed).
 */
export interface PairingOutcome {
  claim: ClaimedPairing;
  welcomeDelivered: boolean;
}

/**
 * Lifecycle orchestrator for the Telegram remote-control channel.
 * Owns: polling lifecycle, status transitions, approval-bridge wiring,
 * pairing-mode state, and live-control writes. Settings persistence
 * delegates to `telegram-settings.ts`; pairing logic to
 * `pairing-mode.ts`.
 */
export class TelegramChannel {
  private readonly deps: TelegramChannelDeps;
  private readonly sessionPointer: TelegramSessionPointer;
  private readonly lock: ChannelLock;
  private readonly inflight = new Map<number, AbortController>();
  private readonly userConfigPath: string;
  private readonly stateDir: string;
  private readonly pairing: PairingMode;
  private currentToken: string | null;
  /**
   * Live owner-id mirror. Mutated by `setOwnerUserId` / pairing claim.
   * Inbound handler + approval bridge re-capture it on each `start()`.
   */
  private currentOwnerUserId: number | null;
  /**
   * Bot identity captured from `getMe` on every successful start.
   * `null` until the channel reaches `up` for the first time. Cleared
   * on stop so `down` panels never show a stale `@username`.
   */
  private currentBotIdentity: { id: number; username: string | null } | null =
    null;
  private bot: BotInstance | null = null;
  private approvalBridge: ApprovalBridge | null = null;
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
    this.currentToken = resolveTokenFromDeps(deps);
    this.currentOwnerUserId = deps.config.telegram.ownerUserId;
    this.stateDir = deps.config.paths.stateDir;
    this.userConfigPath =
      deps.userConfigPath ?? getUserConfigPath(this.stateDir);
    this.sessionPointer = new TelegramSessionPointer(
      deps.sessionPointerPath ?? resolve(this.stateDir, "telegram-session.json"),
    );
    this.lock =
      deps.lock ?? new TelegramLockfile(resolve(this.stateDir, "telegram.lock"));
    this.pairing = new DefaultPairingMode();
  }

  state(): ChannelStatus["state"] {
    return this.currentState;
  }

  lastError(): string | null {
    return this.currentError;
  }

  /** Live owner id. Reflects mutations from `setOwnerUserId` / pairing. */
  getOwnerUserId(): number | null {
    return this.currentOwnerUserId;
  }

  /** Live bot identity from the last successful `getMe`. */
  getBotIdentity(): { id: number; username: string | null } | null {
    return this.currentBotIdentity;
  }

  pairingState(): PairingStateSnapshot {
    return {
      active: this.pairing.isActive(),
      expiresAt: this.pairing.expiresAt(),
    };
  }

  /**
   * Acquire the lock, validate the token via `getMe`, register
   * handlers, and begin polling. Idempotent. Failures land in `down`
   * and never throw past this boundary.
   */
  async start(): Promise<void> {
    if (this.currentState === "up" || this.startInFlight) return;
    if (!this.currentToken) {
      this.transition("down", "missing TELEGRAM_BOT_TOKEN");
      return;
    }
    this.startInFlight = true;
    this.transition("starting", null);
    try {
      this.lock.acquire();
      const factory = this.deps.botFactory ?? defaultGrammyBotFactory;
      const bot = await factory(this.currentToken);
      const me = await bot.api.getMe();
      this.currentBotIdentity = {
        id: me.id,
        username: me.username ?? null,
      };
      this.deps.logger.info("telegram: getMe ok", {
        botId: me.id,
        botUsername: me.username,
      });
      const bridge = new ApprovalBridge({
        api: bot.api,
        approvals: this.deps.runtime.approvals,
        ownerUserId: this.currentOwnerUserId,
        logger: this.deps.logger,
      });
      this.approvalBridge = bridge;
      bot.setTextHandler((update) =>
        handleInboundText(update, {
          runtime: this.deps.runtime,
          api: bot.api,
          sessionPointer: this.sessionPointer,
          logger: this.deps.logger,
          ownerUserId: this.currentOwnerUserId,
          inflight: this.inflight,
          ensureApprovalSession: (sessionId, chatId) =>
            this.ensureApprovalSession(sessionId, chatId),
          tryClaimForPairing: (u) => this.handlePairingClaim(u),
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

  /** Stop polling, abort in-flight turns, cancel pairing, release the lock. Idempotent. */
  async stop(): Promise<void> {
    if (this.currentState === "disabled" && !this.bot) {
      // Still cancel pairing — the operator may have started a window
      // before stop() landed and we don't want a stale promise.
      this.pairing.cancel();
      return;
    }
    this.transition("stopping", null);
    this.pairing.cancel();
    for (const controller of this.inflight.values()) {
      try {
        controller.abort();
      } catch {
        // never let an aborted controller fail the shutdown sequence
      }
    }
    this.inflight.clear();
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
    this.currentBotIdentity = null;
    try {
      this.lock.release();
    } catch (err) {
      this.deps.logger.warn("telegram: lock.release() failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.transition("disabled", null);
  }

  /** Stop then start. No-op when the channel was already stopped. */
  async restart(): Promise<void> {
    const wasUp = this.currentState === "up";
    await this.stop();
    if (wasUp) await this.start();
  }

  /**
   * Persist `enabled` to user config and reconcile lifecycle (start
   * when true, stop when false). With a missing token, `enabled=true`
   * still persists; `start()` lands in `down`. TUI surfaces the
   * outcome via `state()` + `lastError()`.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    writeTelegramSettings(
      { userConfigPath: this.userConfigPath, stateDir: this.stateDir },
      { enabled },
    );
    if (enabled) {
      await this.start();
    } else {
      await this.stop();
    }
  }

  /**
   * Persist `ownerUserId` to user config; restart when up so the
   * inbound handler + approval bridge re-capture the new value.
   */
  async setOwnerUserId(ownerUserId: number | null): Promise<void> {
    writeTelegramSettings(
      { userConfigPath: this.userConfigPath, stateDir: this.stateDir },
      { ownerUserId },
    );
    this.currentOwnerUserId = ownerUserId;
    if (this.currentState === "up") {
      await this.restart();
    }
  }

  /**
   * Persist a new bot token to `<stateDir>/.env` (mode 0600) and
   * restart when up. `null` clears the token; the next `start()`
   * lands in `down`. Never logs the value.
   */
  async setToken(token: string | null): Promise<void> {
    writeTelegramToken(
      { userConfigPath: this.userConfigPath, stateDir: this.stateDir },
      token,
    );
    this.currentToken = token;
    if (this.currentState === "up") {
      await this.restart();
    }
  }

  /**
   * Open a pairing window. The next eligible private DM (any
   * `from.id`) within `timeoutMs` is captured as the new owner:
   * `ownerUserId` is persisted, the channel restarts, and the
   * returned promise resolves with the claim. Resolves to `null` on
   * timeout or `cancelPairing()`.
   *
   * Pairing requires the channel to be `up` so updates can arrive.
   * Calling it while down resolves to `null` immediately and emits
   * a warn log — the TUI is expected to enable + start first.
   */
  async startPairing(timeoutMs?: number): Promise<PairingOutcome | null> {
    if (this.currentState !== "up") {
      this.deps.logger.warn(
        "telegram: pairing requested while channel not up",
        { state: this.currentState },
      );
      return null;
    }
    const claim = await this.pairing.start(timeoutMs);
    if (!claim) return null;
    // Persist first; only after the new owner is durably stored do
    // we attempt the user-visible Telegram confirmation. The welcome
    // is best-effort — a failed sendMessage never reverts the claim
    // — but we DO report delivery status to the caller so the TUI
    // can tell the operator whether a confirmation actually landed.
    await this.setOwnerUserId(claim.userId);
    let welcomeDelivered = false;
    if (this.bot) {
      welcomeDelivered = await sendWelcomeMessage({
        api: this.bot.api,
        chatId: claim.chatId,
        logger: this.deps.logger,
      });
    }
    return { claim, welcomeDelivered };
  }

  cancelPairing(): void {
    this.pairing.cancel();
  }

  private handlePairingClaim(update: InboundTextUpdate): boolean {
    return this.pairing.tryClaim(update);
  }

  /**
   * Bind/re-bind the approval router so requests for the active
   * Telegram session land on the inline-keyboard bridge with the
   * right `chatId`. No-op when binding is already current.
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
    // Lifecycle counters: only the terminal-ish states (`up`, `down`)
    // are recorded; `starting`/`stopping`/`disabled` are pass-through
    // transitions whose dashboards-of-record are the same `up`/`down`
    // counters bracketing them.
    if (next === "up") {
      this.deps.metrics?.recordTelegramUp();
    } else if (next === "down") {
      this.deps.metrics?.recordTelegramDown({
        outcome: "error",
        ...(error ? { reason: shortReason(error) } : {}),
      });
    }
  }
}

/**
 * Collapse a free-form `lastError` string into a short, low-cardinality
 * `reason` tag for the down-counter. Anything we don't recognise lands
 * as `other` so dashboards stay bounded.
 */
function shortReason(error: string): string {
  if (error.includes("missing TELEGRAM_BOT_TOKEN")) return "missing_token";
  if (error.toLowerCase().includes("lock")) return "lock_held";
  if (error.toLowerCase().includes("getme")) return "getme_failed";
  if (error.toLowerCase().includes("token")) return "token_invalid";
  return "other";
}
