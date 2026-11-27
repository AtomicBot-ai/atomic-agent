/**
 * Lifecycle orchestrator for the Linear channel (ATO-2324).
 *
 * Owns the local webhook endpoint, the GraphQL client, the owner
 * allowlist, the comment approval bridge, the loop guard, the
 * single-instance lock and the per-issue session map. Presents the
 * shared `Channel` surface so the runtime starts, lists and stops it like
 * every other messenger. Modelled on the Teams channel: Linear calls us,
 * so "up" means the endpoint listens on 127.0.0.1 and the API key was
 * not refused. A port that cannot be bound is retried with the shared
 * backoff on one unref'd timer.
 */

import type { ApprovalGate } from "../../approval/approval-gate.js";
import type { ApprovalRouter } from "../../approval/approval-router.js";
import type { ChannelStatus } from "../../runtime/channel-status.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { Channel } from "../channel.js";
import { ChatSessionMap } from "../chat-session-map.js";
import { backoffMs } from "../reconnect-backoff.js";
import { LinearApi, LinearApiError, fitCommentBody } from "./linear-api.js";
import { LinearApprovalBridge } from "./linear-approval-bridge.js";
import { handleLinearEvent } from "./linear-inbound-handler.js";
import { LinearOwnComments } from "./linear-own-comments.js";
import { LinearServer, type LinearServerDeps } from "./linear-server.js";
import {
  LINEAR_API_KEY_KEY,
  LINEAR_WEBHOOK_SECRET_KEY,
  resolveLinearSecret,
  scrubLinearError,
  type LinearTarget,
  type LinearWebhookPayload,
} from "./linear-types.js";

const DELIVERY_CAP = 500;
/** Issue pointers older than this are forgotten (the sessions stay on disk). */
const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export interface LinearEndpoint {
  listen(): Promise<void>;
  close(): Promise<void>;
}

export interface LinearChannelDeps {
  runtime: AgentRuntime;
  logger: StructuredLogger;
  approvals: ApprovalGate;
  approvalRouter: ApprovalRouter;
  enabled: boolean;
  ownerIds: readonly string[];
  port: number;
  handles: readonly string[];
  /** `options.onAssign`; `null` means "on unless the API key is an owner's own". */
  onAssign: boolean | null;
  sessionMapPath: string;
  lock: { acquire(): void; release(): void };
  /** Explicit secrets win over the env: the test seam. */
  apiKey?: string | null;
  webhookSecret?: string | null;
  onStatus?: (status: ChannelStatus) => void;
  fetchImpl?: typeof fetch;
  /** Test seam: replaces the real `node:http` endpoint. */
  createEndpoint?: (deps: LinearServerDeps) => LinearEndpoint;
}

export class LinearChannel implements Channel {
  readonly id = "linear";
  private currentState: ChannelStatus["state"] = "disabled";
  private error: string | null = null;
  private endpoint: LinearEndpoint | null = null;
  private api: LinearApi | null = null;
  private bridge: LinearApprovalBridge | null = null;
  private viewerId: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private lockHeld = false;
  private secrets: string[] = [];
  private readonly ownerIds: readonly string[];
  private readonly inflight = new Map<string, AbortController>();
  private readonly seen = new Set<string>();
  private readonly deliveries = new Set<string>();
  private readonly own = new LinearOwnComments();
  private readonly sessions: ChatSessionMap;
  private readonly approvalBindings = new Map<string, { key: string; unsubscribe: () => void }>();

  constructor(private readonly deps: LinearChannelDeps) {
    this.ownerIds = [...deps.ownerIds];
    this.sessions = new ChatSessionMap(deps.sessionMapPath, { prune: { maxAgeMs: SESSION_MAX_AGE_MS, maxEntries: 1000 } });
  }

  state(): ChannelStatus["state"] {
    return this.currentState;
  }

  lastError(): string | null {
    return this.error;
  }

  /** Listen, unless switched off or a secret is missing (`disabled`). */
  async start(): Promise<void> {
    if (this.currentState === "up" || this.currentState === "starting") return;
    if (this.endpoint !== null || this.lockHeld || this.retryTimer !== null) await this.stop();
    const apiKey = resolveLinearSecret(LINEAR_API_KEY_KEY, this.deps.apiKey);
    const secret = resolveLinearSecret(LINEAR_WEBHOOK_SECRET_KEY, this.deps.webhookSecret);
    if (!this.deps.enabled || apiKey === null || secret === null) {
      this.setState("disabled");
      return;
    }
    this.secrets = [apiKey, secret];
    if (this.ownerIds.length === 0) {
      this.deps.logger.warn("linear: no ownerIds configured; every mention will be refused");
    }
    this.setState("starting");
    try {
      this.deps.lock.acquire();
      this.lockHeld = true;
    } catch (err) {
      this.fail(scrubLinearError(err, this.secrets));
      return;
    }
    const api = new LinearApi({ apiKey, ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }) });
    try {
      this.viewerId = (await api.viewer()).id;
    } catch (err) {
      if (err instanceof LinearApiError && err.code === "auth") {
        this.releaseLock();
        this.fail(`Linear refused the API key. Check ${LINEAR_API_KEY_KEY}.`);
        return;
      }
      // Offline at boot is not fatal; without a viewer id assignment triggers stay off.
      this.deps.logger.warn("linear: could not reach the Linear API yet", { error: scrubLinearError(err, this.secrets) });
    }
    if (this.state() !== "starting") return;
    this.api = api;
    this.bridge = new LinearApprovalBridge({
      post: (target, body) => this.post(target, body),
      approvals: this.deps.approvals,
      logger: this.deps.logger,
    });
    const serverDeps: LinearServerDeps = {
      port: this.deps.port,
      secret,
      onEvent: (payload, delivery) => this.onEvent(payload, delivery),
      logger: { warn: (m, c) => this.deps.logger.warn(m, c) },
    };
    this.endpoint = this.deps.createEndpoint?.(serverDeps) ?? new LinearServer(serverDeps);
    await this.listen(0);
  }

  private async listen(attempt: number): Promise<void> {
    const endpoint = this.endpoint;
    if (endpoint === null) return;
    try {
      await endpoint.listen();
      if (this.endpoint === endpoint) this.setState("up");
    } catch (err) {
      if (this.endpoint !== endpoint) return;
      const code = (err as NodeJS.ErrnoException).code;
      this.fail(
        code === "EADDRINUSE"
          ? `Port ${this.deps.port} on 127.0.0.1 is already in use (set channels.linear.options.port).`
          : scrubLinearError(err, this.secrets),
      );
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.listen(attempt + 1);
      }, backoffMs(attempt));
      this.retryTimer.unref?.();
    }
  }

  /** Post a comment as the API key's user, recording it for the loop guard. */
  private async post(target: LinearTarget, body: string): Promise<void> {
    const api = this.api;
    if (api === null) return;
    const fitted = fitCommentBody(body);
    this.own.notePending(fitted);
    try {
      this.own.notePosted(await api.createComment(target, fitted));
    } catch (err) {
      throw new Error(scrubLinearError(err, this.secrets));
    }
  }

  private onEvent(payload: LinearWebhookPayload, delivery: string | undefined): void {
    if (delivery !== undefined) {
      // Linear redelivers on a slow answer; the same delivery id runs once.
      if (this.deliveries.has(delivery)) return;
      this.deliveries.add(delivery);
      if (this.deliveries.size > DELIVERY_CAP) {
        const oldest = this.deliveries.values().next().value;
        if (oldest !== undefined) this.deliveries.delete(oldest);
      }
    }
    if (this.api === null) return;
    const viewerIsOwner = this.viewerId !== null && this.ownerIds.includes(this.viewerId);
    void handleLinearEvent(payload, {
      runtime: this.deps.runtime,
      post: (target, body) => this.post(target, body),
      sessions: this.sessions,
      logger: this.deps.logger,
      ownerIds: this.ownerIds,
      handles: this.deps.handles,
      viewerId: this.viewerId,
      // With a personal key, assigning yourself an issue would start the agent: off unless asked for.
      onAssign: this.deps.onAssign ?? !viewerIsOwner,
      own: this.own,
      bridge: this.bridge,
      inflight: this.inflight,
      seen: this.seen,
      ensureApprovalSession: (sessionId, target) => this.bindApprovals(sessionId, target),
      releaseApprovalSession: (sessionId) => this.releaseApprovals(sessionId),
    });
  }

  /** Point approval prompts for `sessionId` at `target`. Idempotent. */
  private bindApprovals(sessionId: string, target: LinearTarget): void {
    const key = `${target.issueId}:${target.parentId ?? ""}`;
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

  /** Stop listening, abort in-flight turns, release the lock. Idempotent. */
  async stop(): Promise<void> {
    if (this.currentState === "disabled" && this.endpoint === null && !this.lockHeld && this.retryTimer === null) return;
    this.setState("stopping");
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
    for (const binding of this.approvalBindings.values()) binding.unsubscribe();
    this.approvalBindings.clear();
    this.bridge?.clear();
    this.bridge = null;
    this.api = null;
    const endpoint = this.endpoint;
    this.endpoint = null;
    await endpoint?.close();
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
    this.deps.onStatus?.({ channel: "linear", state: next, ...(this.error ? { lastError: this.error } : {}) });
  }
}
