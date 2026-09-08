/**
 * Lifecycle orchestrator for the Discord remote-control channel.
 *
 * Owns the gateway connection, the owner allowlist, the approval
 * bridge, the single-instance lock, and the session pointer. Presents
 * the same `ChannelStatus` surface as the Telegram channel so the
 * runtime, the TUI and the Integrations hub treat both alike.
 */

import type { ApprovalGate } from "../../approval/approval-gate.js";
import type { ApprovalRouter } from "../../approval/approval-router.js";
import type { ChannelStatus } from "../../runtime/channel-status.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { DiscordApi } from "./discord-api.js";
import { DiscordApprovalBridge, type DiscordInteractionEvent } from "./discord-approval-bridge.js";
import {
  DISCORD_INTENTS,
  resolveDiscordToken,
  scrubDiscordError,
} from "./discord-channel-types.js";
import { DiscordGateway } from "./discord-gateway.js";
import type { WebSocketLike } from "./discord-gateway-transport.js";
import {
  handleDiscordMessage,
  type DiscordMessageEvent,
} from "./discord-inbound-handler.js";
import type { DiscordLockfile } from "./discord-lockfile.js";
import { DiscordSessionPointer } from "./discord-session-pointer.js";

export interface DiscordChannelDeps {
  runtime: AgentRuntime;
  logger: StructuredLogger;
  approvals: ApprovalGate;
  approvalRouter: ApprovalRouter;
  enabled: boolean;
  ownerUserId: string | null;
  sessionPointerPath: string;
  lock: DiscordLockfile;
  /** Explicit token wins over the env — the test seam. */
  token?: string | null;
  onStatus?: (status: ChannelStatus) => void;
  /** Test seam handed through to the gateway. */
  createSocket?: (url: string) => WebSocketLike;
  apiBaseUrl?: string;
}

export class DiscordChannel {
  private currentState: ChannelStatus["state"] = "disabled";
  private error: string | null = null;
  private gateway: DiscordGateway | null = null;
  private bridge: DiscordApprovalBridge | null = null;
  private botUserId: string | null = null;
  private botUsername: string | null = null;
  private ownerId: string | null;
  /**
   * Live kill switch. `deps.enabled` is only the value at construction:
   * reading it in `start()` meant an operator who switched the channel
   * on from the Integrations hub got a silent `disabled` until the next
   * launch, because the boot-time `false` outlived the config write.
   */
  private enabled: boolean;
  private lockHeld = false;
  private readonly inflight = new Map<string, AbortController>();
  private readonly pointer: DiscordSessionPointer;
  /**
   * `sessionId -> approval binding`. One per channel that is (or recently
   * was) talking to the bot: with per-channel sessions several channels
   * can run turns at once and each needs its buttons in its own channel.
   * Dropped on `/new`, `/switch`, and `stop()`.
   */
  private readonly approvalBindings = new Map<
    string,
    { channelId: string; unsubscribe: () => void }
  >();

  constructor(private readonly deps: DiscordChannelDeps) {
    this.ownerId = deps.ownerUserId;
    this.enabled = deps.enabled;
    this.pointer = new DiscordSessionPointer(deps.sessionPointerPath);
  }

  /** Same accessor name as `TelegramChannel.state()`. */
  state(): ChannelStatus["state"] {
    return this.currentState;
  }

  lastError(): string | null {
    return this.error;
  }

  getOwnerUserId(): string | null {
    return this.ownerId;
  }

  /** Whether a bot token resolves right now (explicit dep or env). */
  hasToken(): boolean {
    return resolveDiscordToken(this.deps.token) !== null;
  }

  getBotIdentity(): { id: string; username: string | null } | null {
    return this.botUserId
      ? { id: this.botUserId, username: this.botUsername }
      : null;
  }

  /**
   * Connect, unless the channel is switched off or has no token.
   *
   * "No token" is `disabled`, not `down`: an unconfigured integration
   * is a resting state, and reporting it as a failure would train the
   * operator to ignore a red badge that is usually meaningless.
   */
  async start(): Promise<void> {
    const token = resolveDiscordToken(this.deps.token);
    if (!this.enabled || token === null) {
      this.setState("disabled");
      return;
    }
    this.setState("starting");
    try {
      this.deps.lock.acquire();
      this.lockHeld = true;
    } catch (err) {
      this.fail(scrubDiscordError(err));
      return;
    }

    const api = new DiscordApi({
      token,
      ...(this.deps.apiBaseUrl === undefined
        ? {}
        : { baseUrl: this.deps.apiBaseUrl }),
    });
    try {
      const me = await api.currentUser();
      this.botUserId = me.id;
      this.botUsername = me.username;
    } catch (err) {
      this.releaseLock();
      this.fail(scrubDiscordError(err));
      return;
    }

    this.bridge = new DiscordApprovalBridge({
      api,
      approvals: this.deps.approvals,
      logger: this.deps.logger,
      ownerUserId: () => this.ownerId,
    });

    this.gateway = new DiscordGateway({
      token,
      intents: DISCORD_INTENTS,
      gatewayUrl: () => api.gatewayUrl(),
      logger: {
        info: (m, c) => this.deps.logger.info(m, c),
        warn: (m, c) => this.deps.logger.warn(m, c),
      },
      onReady: () => this.setState("up"),
      onClosed: (reason, fatal) => {
        if (fatal) this.fail(reason);
      },
      onDispatch: (type, data) => {
        void this.onDispatch(type, data, api);
      },
      ...(this.deps.createSocket === undefined
        ? {}
        : { createSocket: this.deps.createSocket }),
    });
    this.gateway.start();
  }

  private async onDispatch(
    type: string,
    data: unknown,
    api: DiscordApi,
  ): Promise<void> {
    if (type === "INTERACTION_CREATE") {
      await this.bridge?.handleInteraction(data as DiscordInteractionEvent);
      return;
    }
    if (type !== "MESSAGE_CREATE" || this.botUserId === null) return;
    // Logged before any drop decision: when a bot "does not answer",
    // the first thing to establish is whether the message reached us at
    // all (gateway/intents) or was deliberately ignored (not addressed,
    // not the owner). Without this the two are indistinguishable.
    const msg = data as DiscordMessageEvent;
    this.deps.logger.info("discord: message received", {
      channelId: msg.channel_id,
      authorId: msg.author?.id,
      isDm: msg.guild_id === undefined,
      mentionsBot: msg.mentions?.some((m) => m.id === this.botUserId) === true,
    });
    await handleDiscordMessage(data as DiscordMessageEvent, {
      runtime: this.deps.runtime,
      api,
      sessionPointer: this.pointer,
      logger: this.deps.logger,
      ownerUserId: this.ownerId,
      botUserId: this.botUserId,
      inflight: this.inflight,
      ensureApprovalSession: (sessionId, channelId) => {
        this.bindApprovals(sessionId, channelId);
      },
      releaseApprovalSession: (sessionId) => {
        this.releaseApprovals(sessionId);
      },
    });
  }

  /**
   * Point the approval router at `channelId` for `sessionId`.
   * Idempotent: re-binding the same pair is a no-op; a session that
   * moved to another channel via `/switch` is re-pointed so its prompts
   * follow the conversation.
   */
  private bindApprovals(sessionId: string, channelId: string): void {
    const existing = this.approvalBindings.get(sessionId);
    if (existing?.channelId === channelId) return;
    existing?.unsubscribe();
    this.approvalBindings.delete(sessionId);
    // A channel has exactly one current session, so any other session
    // still bound to this channel is stale and would leak.
    for (const [otherId, binding] of this.approvalBindings) {
      if (binding.channelId === channelId) {
        binding.unsubscribe();
        this.approvalBindings.delete(otherId);
      }
    }
    if (!this.bridge) return;
    const unsubscribe = this.deps.approvalRouter.setForSession(
      sessionId,
      this.bridge.handlerFor(channelId),
    );
    this.approvalBindings.set(sessionId, { channelId, unsubscribe });
  }

  /** Drop the binding for a session no channel talks to anymore. */
  private releaseApprovals(sessionId: string): void {
    const existing = this.approvalBindings.get(sessionId);
    if (!existing) return;
    existing.unsubscribe();
    this.approvalBindings.delete(sessionId);
  }

  async stop(): Promise<void> {
    if (this.currentState === "disabled") return;
    this.setState("stopping");
    // Abort in-flight turns first: a turn that finishes after the
    // socket is gone would post into a channel we can no longer reach.
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
    for (const binding of this.approvalBindings.values()) binding.unsubscribe();
    this.approvalBindings.clear();
    this.bridge?.clear();
    await this.gateway?.stop();
    this.gateway = null;
    this.releaseLock();
    this.setState("disabled");
  }

  /** Persist a new owner and re-evaluate. */
  setOwnerUserId(ownerUserId: string | null): void {
    this.ownerId = ownerUserId;
  }

  /**
   * Flip the kill switch and reconcile the lifecycle, the way
   * `TelegramChannel.setEnabled` does. Persisting `discord.enabled`
   * is the caller's job -- the hub already writes config -- but the
   * running channel has to be told, or the switch does nothing until
   * the next launch.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    if (!enabled) {
      await this.stop();
      return;
    }
    // `start()` has no already-running guard of its own, and a second
    // gateway on one token would receive every event twice.
    if (this.currentState === "up" || this.currentState === "starting") return;
    // A `down` channel still holds a half-built gateway and possibly
    // the lock; tear it down before rebuilding.
    if (this.currentState !== "disabled") await this.stop();
    await this.start();
  }

  private releaseLock(): void {
    if (!this.lockHeld) return;
    this.deps.lock.release();
    this.lockHeld = false;
  }

  private fail(message: string): void {
    this.error = message;
    this.setState("down");
  }

  private setState(next: ChannelStatus["state"]): void {
    if (this.currentState === next) return;
    this.currentState = next;
    if (next !== "down") this.error = null;
    this.deps.onStatus?.({
      channel: "discord",
      state: next,
      ...(this.error ? { lastError: this.error } : {}),
    });
  }
}
