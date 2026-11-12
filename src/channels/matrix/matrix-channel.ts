/**
 * Lifecycle for the Matrix remote-control channel (ATO-632).
 *
 * Owns the sync loop, the owner allowlist, the approval bridge, the
 * single-instance lock and the per-room session map. Unencrypted rooms
 * only; see `matrix-types.ts` for why and what an encrypted room gets.
 *
 * Settings: `channels.matrix` in `config.json` (`enabled`, `ownerIds`,
 * `options.homeserver`, optional `options.userId`); the access token in
 * `<stateDir>/.env` as `MATRIX_ACCESS_TOKEN`.
 */

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
import { MatrixApi, type MatrixSyncResponse } from "./matrix-api.js";
import { MatrixApprovalBridge } from "./matrix-approval-bridge.js";
import { handleMatrixEvent, type MatrixInboundContext } from "./matrix-inbound-handler.js";
import { MatrixSyncLoop } from "./matrix-sync-loop.js";
import { MatrixSyncStore } from "./matrix-sync-store.js";
import { readMatrixOptions, resolveMatrixToken, scrubMatrixError } from "./matrix-types.js";

export interface MatrixChannelDeps {
  runtime: AgentRuntime;
  logger: StructuredLogger;
  approvals: ApprovalGate;
  approvalRouter: ApprovalRouter;
  channelConfig: ExtraChannelConfig;
  stateDir: string;
  emitStatus?: (status: ChannelStatus) => void;
  /** Lock guard; the generic pid lockfile at `<stateDir>/matrix.lock` by default. */
  lock?: { acquire(): void; release(): void };
  /** Test seams. Explicit token wins over the env. */
  token?: string | null;
  fetchImpl?: typeof fetch;
  syncTimeoutMs?: number;
  backoff?: (attempt: number) => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class MatrixChannel implements Channel {
  readonly id = "matrix";
  private currentState: ChannelState = "disabled";
  private error: string | null = null;
  private readonly ownerIds: readonly string[];
  private readonly lock: { acquire(): void; release(): void };
  private lockHeld = false;
  private loop: MatrixSyncLoop | null = null;
  private bridge: MatrixApprovalBridge | null = null;
  private api: MatrixApi | null = null;
  private botUserId: string | null = null;
  private readonly sessions: ChatSessionMap;
  private readonly syncStore: MatrixSyncStore;
  private readonly inflight = new Map<string, AbortController>();
  private readonly encryptedNotices = new Map<string, number>();
  private readonly handledInvites = new Set<string>();
  /** `sessionId -> approval binding` for rooms that run (or ran) a turn. */
  private readonly approvalBindings = new Map<string, { roomId: string; unsubscribe: () => void }>();
  /** Bumped by every start/stop, so a stale `whoami` cannot revive a stopped channel. */
  private generation = 0;

  constructor(private readonly deps: MatrixChannelDeps) {
    // Copied: the allowlist must not change under the loop because
    // something else edited the config array.
    this.ownerIds = [...deps.channelConfig.ownerIds];
    this.lock = deps.lock ?? new DiscordLockfile(resolve(deps.stateDir, "matrix.lock"));
    this.sessions = new ChatSessionMap(resolve(deps.stateDir, "matrix-session.json"));
    this.syncStore = new MatrixSyncStore(resolve(deps.stateDir, "matrix-sync.json"));
  }

  state(): ChannelState {
    return this.currentState;
  }

  lastError(): string | null {
    return this.error;
  }

  /**
   * Connect, unless switched off or not configured. A missing token or
   * homeserver is `disabled` (a resting state), not `down`. Settles once
   * the token is checked; the first sync then flips the state to `up`.
   */
  async start(): Promise<void> {
    if (this.currentState === "starting" || this.currentState === "up") return;
    const options = readMatrixOptions(this.deps.channelConfig);
    const token = resolveMatrixToken(this.deps.token);
    if (!this.deps.channelConfig.enabled || token === null || options.homeserver === null) {
      if (this.deps.channelConfig.enabled && options.homeserver === null) {
        this.deps.logger.warn("matrix: channels.matrix.options.homeserver is missing or not https");
      }
      this.setState("disabled");
      return;
    }
    const generation = ++this.generation;
    this.setState("starting");
    try {
      this.lock.acquire();
      this.lockHeld = true;
    } catch (err) {
      this.fail(scrubMatrixError(err, token));
      return;
    }
    const api = new MatrixApi({
      homeserver: options.homeserver,
      token,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
    let userId: string;
    try {
      userId = await api.whoami();
    } catch (err) {
      if (generation !== this.generation) return;
      this.releaseLock();
      this.fail(scrubMatrixError(err, token));
      return;
    }
    if (generation !== this.generation) return;
    if (options.userId !== null && options.userId !== userId) {
      this.releaseLock();
      this.fail(`The access token belongs to ${userId}, not ${options.userId}.`);
      return;
    }
    if (this.ownerIds.length === 0) {
      this.deps.logger.warn("matrix: channels.matrix.ownerIds is empty; every message is refused");
    }
    this.api = api;
    this.botUserId = userId;
    this.bridge = new MatrixApprovalBridge({
      api,
      approvals: this.deps.approvals,
      logger: this.deps.logger,
      ownerIds: () => this.ownerIds,
    });
    this.loop = new MatrixSyncLoop({
      api,
      store: this.syncStore,
      userId,
      logger: this.deps.logger,
      onUp: () => this.setState("up"),
      onBatch: (batch, info) => this.onBatch(batch, info),
      onFatal: (reason) => {
        this.fail(reason);
        this.releaseLock();
      },
      ...(this.deps.syncTimeoutMs !== undefined ? { timeoutMs: this.deps.syncTimeoutMs } : {}),
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
    // post into a room we no longer watch.
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
    for (const binding of this.approvalBindings.values()) binding.unsubscribe();
    this.approvalBindings.clear();
    this.bridge?.clear();
    await this.loop?.stop();
    this.loop = null;
    this.bridge = null;
    this.api = null;
    this.handledInvites.clear();
    this.releaseLock();
    this.setState("disabled");
  }

  private async onBatch(batch: MatrixSyncResponse, info: { initial: boolean }): Promise<void> {
    const api = this.api;
    const userId = this.botUserId;
    if (!api || !userId) return;
    for (const [roomId, room] of Object.entries(batch.rooms?.invite ?? {})) {
      await this.onInvite(api, userId, roomId, room.invite_state?.events ?? []);
    }
    // The initial sync's timeline is history, not requests: skip it.
    if (info.initial) return;
    const ctx = this.inboundContext(api, userId);
    for (const [roomId, room] of Object.entries(batch.rooms?.join ?? {})) {
      for (const event of room.timeline?.events ?? []) {
        // Not awaited: a long turn must not stall the poll.
        void handleMatrixEvent(roomId, event, ctx);
      }
    }
  }

  /** Join when an owner invited us; reject anyone else's invite. */
  private async onInvite(
    api: MatrixApi,
    userId: string,
    roomId: string,
    events: ReadonlyArray<{ type: string; sender?: string; state_key?: string; content?: Record<string, unknown> }>,
  ): Promise<void> {
    if (this.handledInvites.has(roomId)) return;
    this.handledInvites.add(roomId);
    const invite = events.find(
      (e) => e.type === "m.room.member" && e.state_key === userId && e.content?.membership === "invite",
    );
    const inviter = invite?.sender;
    try {
      if (typeof inviter === "string" && this.ownerIds.includes(inviter)) {
        await api.joinRoom(roomId);
        this.deps.logger.info("matrix: joined room on owner invite", { roomId, inviter });
      } else {
        await api.leaveRoom(roomId);
        this.deps.logger.warn("matrix: rejected invite from non-owner", { roomId, inviter });
      }
    } catch (err) {
      this.handledInvites.delete(roomId);
      this.deps.logger.warn("matrix: could not answer invite", { roomId, error: scrubMatrixError(err) });
    }
  }

  private inboundContext(api: MatrixApi, userId: string): MatrixInboundContext {
    const bridge = this.bridge;
    return {
      runtime: this.deps.runtime,
      api,
      sessions: this.sessions,
      logger: this.deps.logger,
      ownerIds: this.ownerIds,
      botUserId: userId,
      inflight: this.inflight,
      bridge: bridge ?? { tryAnswer: () => null, pendingIn: () => 0 },
      ensureApprovalSession: (sessionId, roomId) => this.bindApprovals(sessionId, roomId),
      releaseApprovalSession: (sessionId) => this.releaseApprovals(sessionId),
      encryptedNotices: this.encryptedNotices,
    };
  }

  /** Point the approval router at `roomId` for `sessionId`. Idempotent. */
  private bindApprovals(sessionId: string, roomId: string): void {
    const existing = this.approvalBindings.get(sessionId);
    if (existing?.roomId === roomId) return;
    existing?.unsubscribe();
    this.approvalBindings.delete(sessionId);
    // A room has one current session; any other bound to it is stale.
    for (const [otherId, binding] of this.approvalBindings) {
      if (binding.roomId === roomId) {
        binding.unsubscribe();
        this.approvalBindings.delete(otherId);
      }
    }
    if (!this.bridge) return;
    const unsubscribe = this.deps.approvalRouter.setForSession(sessionId, this.bridge.handlerFor(roomId));
    this.approvalBindings.set(sessionId, { roomId, unsubscribe });
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
