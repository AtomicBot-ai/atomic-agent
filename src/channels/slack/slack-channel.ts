/**
 * Lifecycle orchestrator for the Slack channel (ATO-499).
 *
 * Owns the Socket Mode connection, the owner allowlist, the approval
 * bridge, the single-instance lock and the per-conversation session
 * map. Presents the shared `Channel` surface so the runtime starts,
 * lists and stops it like every other messenger.
 */

import type { ApprovalGate } from "../../approval/approval-gate.js";
import type { ApprovalRouter } from "../../approval/approval-router.js";
import type { ChannelStatus } from "../../runtime/channel-status.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { Channel } from "../channel.js";
import { ChatSessionMap } from "../chat-session-map.js";
import type { WebSocketLike } from "../discord/discord-gateway-transport.js";
import { SlackApi, SlackApiError } from "./slack-api.js";
import { SlackApprovalBridge } from "./slack-approval-bridge.js";
import { handleSlackEvent, type SlackInboundContext } from "./slack-inbound-handler.js";
import { handleSlackSlashCommand, type SlackSlashCommandPayload } from "./slack-slash-command.js";
import { SlackSocket } from "./slack-socket.js";
import {
  FATAL_SLACK_ERRORS,
  SLACK_APP_TOKEN_KEY,
  SLACK_BOT_TOKEN_KEY,
  describeSlackError,
  resolveSlackToken,
  scrubSlackError,
  type SlackBlockActionsPayload,
  type SlackEnvelope,
  type SlackMessageEvent,
  type SlackTarget,
} from "./slack-types.js";

export interface SlackChannelDeps {
  runtime: AgentRuntime;
  logger: StructuredLogger;
  approvals: ApprovalGate;
  approvalRouter: ApprovalRouter;
  enabled: boolean;
  ownerIds: readonly string[];
  /** Option `threadReplies` (default true). */
  threadReplies: boolean;
  sessionMapPath: string;
  lock: { acquire(): void; release(): void };
  /** Explicit tokens win over the env: the test seam. */
  botToken?: string | null;
  appToken?: string | null;
  onStatus?: (status: ChannelStatus) => void;
  createSocket?: (url: string) => WebSocketLike;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
}

export class SlackChannel implements Channel {
  readonly id = "slack";
  private currentState: ChannelStatus["state"] = "disabled";
  private error: string | null = null;
  private socket: SlackSocket | null = null;
  private bridge: SlackApprovalBridge | null = null;
  private lockHeld = false;
  private readonly ownerIds: readonly string[];
  private readonly inflight = new Map<string, AbortController>();
  private readonly seen = new Set<string>();
  private readonly sessions: ChatSessionMap;
  /** `sessionId -> binding`; dropped on `!new` and `stop()`. */
  private readonly approvalBindings = new Map<string, { key: string; unsubscribe: () => void }>();

  constructor(private readonly deps: SlackChannelDeps) {
    this.ownerIds = [...deps.ownerIds];
    this.sessions = new ChatSessionMap(deps.sessionMapPath);
  }

  state(): ChannelStatus["state"] {
    return this.currentState;
  }

  lastError(): string | null {
    return this.error;
  }

  /**
   * Connect, unless switched off or a token is missing. A missing token
   * is `disabled`, not `down`: an unconfigured integration is a resting
   * state. Settles once `auth.test` answered; the socket connects in the
   * background and flips the state to `up` on `hello`.
   */
  async start(): Promise<void> {
    if (this.currentState === "up" || this.currentState === "starting") return;
    // A `down` channel may still hold a finished socket and the lock.
    if (this.socket !== null || this.lockHeld) await this.stop();
    const botToken = resolveSlackToken(SLACK_BOT_TOKEN_KEY, this.deps.botToken);
    const appToken = resolveSlackToken(SLACK_APP_TOKEN_KEY, this.deps.appToken);
    if (!this.deps.enabled || botToken === null || appToken === null) {
      this.setState("disabled");
      return;
    }
    if (this.ownerIds.length === 0) {
      this.deps.logger.warn("slack: no ownerIds configured; every message will be refused");
    }
    this.setState("starting");
    try {
      this.deps.lock.acquire();
      this.lockHeld = true;
    } catch (err) {
      this.fail(scrubSlackError(err));
      return;
    }
    const api = new SlackApi({
      botToken,
      appToken,
      ...(this.deps.apiBaseUrl === undefined ? {} : { baseUrl: this.deps.apiBaseUrl }),
      ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }),
    });
    let botUserId: string;
    try {
      botUserId = (await api.authTest()).userId;
    } catch (err) {
      this.releaseLock();
      this.fail(
        err instanceof SlackApiError && FATAL_SLACK_ERRORS.has(err.code)
          ? describeSlackError(err.code)
          : scrubSlackError(err),
      );
      return;
    }
    this.bridge = new SlackApprovalBridge({
      api,
      approvals: this.deps.approvals,
      logger: this.deps.logger,
      ownerIds: () => this.ownerIds,
    });
    const socket = new SlackSocket({
      openUrl: () => api.openConnection(),
      logger: {
        info: (m, c) => this.deps.logger.info(m, c),
        warn: (m, c) => this.deps.logger.warn(m, c),
      },
      onReady: () => this.setState("up"),
      onReconnecting: () => {
        if (this.currentState === "up") this.setState("starting");
      },
      onClosed: (reason, fatal) => {
        if (fatal) this.fail(reason);
      },
      onEnvelope: (envelope) => this.onEnvelope(envelope, api, botUserId),
      ...(this.deps.createSocket === undefined ? {} : { createSocket: this.deps.createSocket }),
    });
    this.socket = socket;
    socket.start();
  }

  private onEnvelope(envelope: SlackEnvelope, api: SlackApi, botUserId: string): void {
    if (envelope.type === "interactive") {
      const interactive = envelope.payload as SlackBlockActionsPayload | undefined;
      if (interactive?.type === "block_actions") void this.bridge?.handleBlockActions(interactive);
      return;
    }
    if (envelope.type === "slash_commands") {
      const command = envelope.payload as SlackSlashCommandPayload | undefined;
      if (command) void handleSlackSlashCommand(command, this.inboundContext(api, botUserId));
      return;
    }
    const payload = envelope.payload as { event?: SlackMessageEvent } | undefined;
    const event = payload?.event;
    if (!event || typeof event.type !== "string") return;
    void handleSlackEvent(event, this.inboundContext(api, botUserId));
  }

  private inboundContext(api: SlackApi, botUserId: string): SlackInboundContext & { api: SlackApi } {
    return {
      runtime: this.deps.runtime,
      api,
      sessions: this.sessions,
      logger: this.deps.logger,
      ownerIds: this.ownerIds,
      botUserId,
      threadReplies: this.deps.threadReplies,
      inflight: this.inflight,
      seen: this.seen,
      ensureApprovalSession: (sessionId, target) => this.bindApprovals(sessionId, target),
      releaseApprovalSession: (sessionId) => this.releaseApprovals(sessionId),
    };
  }

  /** Point approval prompts for `sessionId` at `target`. Idempotent. */
  private bindApprovals(sessionId: string, target: SlackTarget): void {
    const key = `${target.channel}:${target.threadTs ?? ""}`;
    const existing = this.approvalBindings.get(sessionId);
    if (existing?.key === key) return;
    existing?.unsubscribe();
    this.approvalBindings.delete(sessionId);
    if (!this.bridge) return;
    const unsubscribe = this.deps.approvalRouter.setForSession(sessionId, this.bridge.handlerFor(target));
    this.approvalBindings.set(sessionId, { key, unsubscribe });
  }

  private releaseApprovals(sessionId: string): void {
    const existing = this.approvalBindings.get(sessionId);
    if (!existing) return;
    existing.unsubscribe();
    this.approvalBindings.delete(sessionId);
  }

  /** Disconnect, abort in-flight turns, release the lock. Idempotent. */
  async stop(): Promise<void> {
    if (this.currentState === "disabled" && this.socket === null && !this.lockHeld) return;
    this.setState("stopping");
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
    for (const binding of this.approvalBindings.values()) binding.unsubscribe();
    this.approvalBindings.clear();
    this.bridge?.clear();
    this.bridge = null;
    const socket = this.socket;
    this.socket = null;
    await socket?.stop();
    this.releaseLock();
    this.setState("disabled");
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
      channel: "slack",
      state: next,
      ...(this.error ? { lastError: this.error } : {}),
    });
  }
}
