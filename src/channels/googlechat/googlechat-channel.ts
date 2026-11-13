/**
 * Lifecycle for the Google Chat remote-control channel (ATO-506).
 *
 * Owns the service-account token source, the Pub/Sub pull loop, the
 * owner allowlist, the approval bridge, the single-instance lock and the
 * per-space session map.
 *
 * Settings: `channels.googlechat` in `config.json` (`enabled`,
 * `ownerIds` as `users/<id>` or emails, `options.subscription` as
 * `projects/<p>/subscriptions/<s>`); the *path* to the service-account
 * JSON key in `<stateDir>/.env` as `GOOGLE_CHAT_CREDENTIALS`.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ApprovalGate } from "../../approval/approval-gate.js";
import type { ApprovalRouter } from "../../approval/approval-router.js";
import type { ExtraChannelConfig } from "../../config/extra-channel-config.js";
import type { ChannelState, ChannelStatus } from "../../runtime/channel-status.js";
import type { AgentRuntime } from "../../runtime/runtime-contract.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { Channel } from "../channel.js";
import { ChatSessionMap } from "../chat-session-map.js";
import { DiscordLockfile } from "../discord/discord-lockfile.js";
import { GoogleChatApi, type PubsubReceivedMessage } from "./googlechat-api.js";
import { GoogleChatApprovalBridge } from "./googlechat-approval-bridge.js";
import { GoogleTokenSource, parseServiceAccountKey, type ServiceAccountKey } from "./googlechat-auth.js";
import { decodeGoogleChatEvent } from "./googlechat-events.js";
import { handleGoogleChatEvent, type GoogleChatInboundContext } from "./googlechat-inbound-handler.js";
import { GoogleChatPullLoop } from "./googlechat-pull-loop.js";
import {
  GOOGLE_CHAT_SCOPES,
  isGoogleChatOwner,
  readGoogleChatOptions,
  resolveCredentialsPath,
  scrubGoogleChatError,
  type GoogleChatUserRef,
} from "./googlechat-types.js";

export interface GoogleChatChannelDeps {
  runtime: AgentRuntime;
  logger: StructuredLogger;
  approvals: ApprovalGate;
  approvalRouter: ApprovalRouter;
  channelConfig: ExtraChannelConfig;
  stateDir: string;
  emitStatus?: (status: ChannelStatus) => void;
  /** Lock guard; the generic pid lockfile at `<stateDir>/googlechat.lock` by default. */
  lock?: { acquire(): void; release(): void };
  /** Test seams. Explicit path wins over the env. */
  credentialsPath?: string | null;
  readFileImpl?: (path: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  pullTimeoutMs?: number;
  backoff?: (attempt: number) => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/** How many recent message names are remembered to drop Pub/Sub redeliveries. */
const SEEN_LIMIT = 500;

export class GoogleChatChannel implements Channel {
  readonly id = "googlechat";
  private currentState: ChannelState = "disabled";
  private error: string | null = null;
  private readonly ownerIds: readonly string[];
  private readonly lock: { acquire(): void; release(): void };
  private lockHeld = false;
  private loop: GoogleChatPullLoop | null = null;
  private bridge: GoogleChatApprovalBridge | null = null;
  private api: GoogleChatApi | null = null;
  private readonly sessions: ChatSessionMap;
  private readonly inflight = new Map<string, AbortController>();
  private readonly threads = new Map<string, string>();
  private readonly seen = new Set<string>();
  private readonly whoamiAnswered = new Map<string, number>();
  /** `sessionId -> approval binding` for spaces that run (or ran) a turn. */
  private readonly approvalBindings = new Map<string, { space: string; unsubscribe: () => void }>();
  /** Bumped by every start/stop, so a stale key read cannot revive a stopped channel. */
  private generation = 0;

  constructor(private readonly deps: GoogleChatChannelDeps) {
    // Copied: the allowlist must not change under the loop.
    this.ownerIds = [...deps.channelConfig.ownerIds];
    this.lock = deps.lock ?? new DiscordLockfile(resolve(deps.stateDir, "googlechat.lock"));
    this.sessions = new ChatSessionMap(resolve(deps.stateDir, "googlechat-session.json"));
  }

  state(): ChannelState {
    return this.currentState;
  }

  lastError(): string | null {
    return this.error;
  }

  /**
   * Connect, unless switched off or not configured. A missing key path or
   * subscription is `disabled`; an unreadable key is `down`. Settles once
   * the key is read; the first successful pull flips the state to `up`.
   */
  async start(): Promise<void> {
    if (this.currentState === "starting" || this.currentState === "up") return;
    const { subscription } = readGoogleChatOptions(this.deps.channelConfig);
    const keyPath = resolveCredentialsPath(this.deps.credentialsPath);
    if (!this.deps.channelConfig.enabled || keyPath === null || subscription === null) {
      if (this.deps.channelConfig.enabled && subscription === null) {
        this.deps.logger.warn(
          "googlechat: channels.googlechat.options.subscription is missing or not projects/<p>/subscriptions/<s>",
        );
      }
      this.setState("disabled");
      return;
    }
    const generation = ++this.generation;
    this.setState("starting");
    let key: ServiceAccountKey;
    try {
      const raw = await (this.deps.readFileImpl ?? ((p: string) => readFile(p, "utf8")))(keyPath);
      key = parseServiceAccountKey(raw);
    } catch (err) {
      if (generation !== this.generation) return;
      // Name the problem, never the contents: a read error carries only the path.
      const reason =
        err instanceof Error && err.message.startsWith("The Google Chat credentials")
          ? err.message
          : `Could not read the Google Chat credentials file (GOOGLE_CHAT_CREDENTIALS): ${
              (err as NodeJS.ErrnoException).code ?? "unreadable"
            }`;
      this.fail(reason);
      return;
    }
    if (generation !== this.generation) return;
    try {
      this.lock.acquire();
      this.lockHeld = true;
    } catch (err) {
      this.fail(scrubGoogleChatError(err));
      return;
    }
    if (this.ownerIds.length === 0) {
      this.deps.logger.warn("googlechat: channels.googlechat.ownerIds is empty; every message is refused");
    }
    const tokens = new GoogleTokenSource({
      key,
      scopes: GOOGLE_CHAT_SCOPES,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
    const api = new GoogleChatApi({
      tokens,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
    });
    this.api = api;
    const isOwner = (user: GoogleChatUserRef | undefined): boolean => isGoogleChatOwner(this.ownerIds, user);
    this.bridge = new GoogleChatApprovalBridge({
      post: (space, text, thread) => this.post(space, text, thread),
      approvals: this.deps.approvals,
      logger: this.deps.logger,
      isOwner,
    });
    this.loop = new GoogleChatPullLoop({
      api,
      subscription,
      logger: this.deps.logger,
      onUp: () => this.setState("up"),
      onBatch: (batch) => this.onBatch(batch),
      onFatal: (reason) => {
        this.fail(reason);
        this.releaseLock();
      },
      ...(this.deps.pullTimeoutMs !== undefined ? { pullTimeoutMs: this.deps.pullTimeoutMs } : {}),
      ...(this.deps.backoff ? { backoff: this.deps.backoff } : {}),
      ...(this.deps.wait ? { wait: this.deps.wait } : {}),
    });
    this.loop.start();
  }

  async stop(): Promise<void> {
    this.generation++;
    if (this.currentState === "disabled") return;
    this.setState("stopping");
    // Abort turns first: one finishing after the loop is gone would
    // post into a space we no longer watch.
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
    for (const binding of this.approvalBindings.values()) binding.unsubscribe();
    this.approvalBindings.clear();
    this.bridge?.clear();
    await this.loop?.stop();
    this.loop = null;
    this.bridge = null;
    this.api = null;
    this.threads.clear();
    this.releaseLock();
    this.setState("disabled");
  }

  /** Decode, dedupe and dispatch one pulled batch. Turns are not awaited. */
  private onBatch(batch: readonly PubsubReceivedMessage[]): void {
    const ctx = this.inboundContext();
    for (const received of batch) {
      const event = decodeGoogleChatEvent(received.message?.data);
      if (!event) {
        this.deps.logger.warn("googlechat: skipping a Pub/Sub message that is not a Chat event", {
          messageId: received.message?.messageId,
        });
        continue;
      }
      const name = event.message?.name;
      if (typeof name === "string") {
        if (this.seen.has(name)) continue;
        this.seen.add(name);
        if (this.seen.size > SEEN_LIMIT) {
          const oldest = this.seen.values().next().value;
          if (oldest !== undefined) this.seen.delete(oldest);
        }
      }
      // Not awaited: a long turn must not stall the pull (or the ack).
      void handleGoogleChatEvent(event, ctx);
    }
  }

  private inboundContext(): GoogleChatInboundContext {
    const bridge = this.bridge;
    return {
      runtime: this.deps.runtime,
      post: (space, text, thread) => this.post(space, text, thread),
      sessions: this.sessions,
      logger: this.deps.logger,
      isOwner: (user) => isGoogleChatOwner(this.ownerIds, user),
      ownerConfigured: this.ownerIds.length > 0,
      inflight: this.inflight,
      bridge: bridge ?? { tryAnswer: () => null, pendingIn: () => 0 },
      ensureApprovalSession: (sessionId, space) => this.bindApprovals(sessionId, space),
      releaseApprovalSession: (sessionId) => this.releaseApprovals(sessionId),
      noteThread: (space, thread) => {
        if (thread === undefined) this.threads.delete(space);
        else this.threads.set(space, thread);
      },
      whoamiAnswered: this.whoamiAnswered,
    };
  }

  private async post(space: string, text: string, thread?: string): Promise<void> {
    const api = this.api;
    if (!api) throw new Error("Google Chat channel is not running.");
    await api.createMessage(space, text, thread);
  }

  /** Point the approval router at `space` for `sessionId`. Idempotent. */
  private bindApprovals(sessionId: string, space: string): void {
    const existing = this.approvalBindings.get(sessionId);
    if (existing?.space === space) return;
    existing?.unsubscribe();
    this.approvalBindings.delete(sessionId);
    // A space has one current session; any other bound to it is stale.
    for (const [otherId, binding] of this.approvalBindings) {
      if (binding.space === space) {
        binding.unsubscribe();
        this.approvalBindings.delete(otherId);
      }
    }
    if (!this.bridge) return;
    const handler = this.bridge.handlerFor(space, () => this.threads.get(space));
    const unsubscribe = this.deps.approvalRouter.setForSession(sessionId, handler);
    this.approvalBindings.set(sessionId, { space, unsubscribe });
  }

  private releaseApprovals(sessionId: string): void {
    const existing = this.approvalBindings.get(sessionId);
    if (!existing) return;
    existing.unsubscribe();
    this.approvalBindings.delete(sessionId);
  }

  private releaseLock(): void {
    if (!this.lockHeld) return;
    this.lock.release();
    this.lockHeld = false;
  }

  private fail(message: string): void {
    this.error = message;
    this.setState("down");
  }

  private setState(next: ChannelState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    if (next !== "down") this.error = null;
    this.deps.emitStatus?.({
      channel: this.id,
      state: next,
      ...(this.error ? { lastError: this.error } : {}),
    });
  }
}
