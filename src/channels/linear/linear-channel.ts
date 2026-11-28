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
 * backoff on one unref'd timer. With no webhook secret (or `mode: "poll"`)
 * the poller runs instead; "up" means its first poll was not refused.
 */

import { dirname, resolve } from "node:path";

import type { ApprovalGate } from "../../approval/approval-gate.js";
import type { ApprovalRouter } from "../../approval/approval-router.js";
import type { ChannelStatus } from "../../runtime/channel-status.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { createAttachmentInbox, type AttachmentInbox } from "../attachments/inbox.js";
import type { Channel } from "../channel.js";
import { ChatSessionMap } from "../chat-session-map.js";
import { backoffMs } from "../reconnect-backoff.js";
import { LinearApi, LinearApiError, fitCommentBody } from "./linear-api.js";
import { LinearApprovalBindings } from "./linear-approval-bindings.js";
import { LinearApprovalBridge } from "./linear-approval-bridge.js";
import { downloadLinearUpload } from "./linear-attachments.js";
import { handleLinearEvent } from "./linear-inbound-handler.js";
import { LinearOwnComments } from "./linear-own-comments.js";
import { createLinearEndpoint, type LinearEndpoint } from "./linear-endpoint.js";
import { LINEAR_KEY_REFUSED, type LinearPollerDeps } from "./linear-poller.js";
import type { LinearServerDeps } from "./linear-server.js";
import { LinearTurnQueue } from "./linear-turn-queue.js";
import {
  LINEAR_API_KEY_KEY,
  LINEAR_WEBHOOK_SECRET_KEY,
  resolveLinearMode,
  resolveLinearSecret,
  scrubLinearError,
  type LinearActivityKind, type LinearMode, type LinearTarget, type LinearWebhookPayload,
} from "./linear-types.js";

const DELIVERY_CAP = 500;
/** Issue pointers older than this are forgotten (the sessions stay on disk). */
const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export type { LinearEndpoint } from "./linear-endpoint.js";

export interface LinearChannelDeps {
  runtime: AgentRuntime;
  logger: StructuredLogger;
  approvals: ApprovalGate;
  approvalRouter: ApprovalRouter;
  enabled: boolean;
  ownerIds: readonly string[];
  port: number;
  /** `options.mode`; `null` means webhook when its secret is saved, else polling. */
  mode?: LinearMode | null;
  /** Polling mode: interval in ms, and `<stateDir>/linear-poll-cursor.json`. */
  pollMs?: number;
  pollCursorPath?: string;
  handles: readonly string[];
  /** `options.onAssign`; `null` means "on unless the API key is an owner's own". */
  onAssign: boolean | null;
  sessionMapPath: string;
  /** `<stateDir>/inbox/linear`: where files attached to a comment land. Absent: attachments are not read. */
  inboxDir?: string;
  lock: { acquire(): void; release(): void };
  /** Explicit secrets win over the env: the test seam. */
  apiKey?: string | null;
  webhookSecret?: string | null;
  /** App installs: renews an expired token (`linearTokenRefresher`). */
  refreshToken?: (() => Promise<string | null>) | null;
  onStatus?: (status: ChannelStatus) => void;
  fetchImpl?: typeof fetch;
  /** Test seam: replaces the real `node:http` endpoint. */
  createEndpoint?: (deps: LinearServerDeps) => LinearEndpoint;
  /** Test seam: replaces the real poller. */
  createPoller?: (deps: LinearPollerDeps) => LinearEndpoint;
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
  private readonly turns = new LinearTurnQueue();
  private inbox: AttachmentInbox | null = null;
  private readonly seen = new Set<string>();
  private readonly deliveries = new Set<string>();
  private readonly own = new LinearOwnComments();
  private readonly sessions: ChatSessionMap;
  private readonly approvalBindings: LinearApprovalBindings;

  constructor(private readonly deps: LinearChannelDeps) {
    this.ownerIds = [...deps.ownerIds];
    this.sessions = new ChatSessionMap(deps.sessionMapPath, { prune: { maxAgeMs: SESSION_MAX_AGE_MS, maxEntries: 1000 } });
    this.approvalBindings = new LinearApprovalBindings(deps.approvalRouter, () => this.bridge);
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
    const mode = resolveLinearMode(this.deps.mode ?? null, secret !== null);
    if (!this.deps.enabled || apiKey === null || (mode === "webhook" && secret === null)) {
      this.setState("disabled");
      return;
    }
    this.secrets = secret === null ? [apiKey] : [apiKey, secret];
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
    const api = new LinearApi({
      apiKey,
      ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }),
      ...(this.deps.refreshToken ? { refresh: this.deps.refreshToken } : {}),
    });
    try {
      this.viewerId = (await api.viewer()).id;
    } catch (err) {
      if (err instanceof LinearApiError && err.code === "auth") {
        this.releaseLock();
        this.fail(LINEAR_KEY_REFUSED);
        return;
      }
      // Offline at boot is not fatal; without a viewer id assignment triggers stay off.
      this.deps.logger.warn("linear: could not reach the Linear API yet", { error: scrubLinearError(err, this.secrets) });
    }
    if (this.state() !== "starting") return;
    this.api = api;
    this.inbox = this.deps.inboxDir === undefined ? null : createAttachmentInbox({ dir: this.deps.inboxDir });
    this.bridge = new LinearApprovalBridge({
      post: (target, body, kind) => this.post(target, body, kind),
      approvals: this.deps.approvals,
      logger: this.deps.logger,
    });
    this.endpoint = createLinearEndpoint({
      secret: mode === "poll" ? null : secret,
      api,
      port: this.deps.port,
      ...(this.deps.pollMs === undefined ? {} : { pollMs: this.deps.pollMs }),
      cursorPath: this.deps.pollCursorPath ?? resolve(dirname(this.deps.sessionMapPath), "linear-poll-cursor.json"),
      onEvent: (payload, delivery) => this.onEvent(payload, delivery),
      assignee: () => (this.assignOn() ? this.viewerId : null),
      onFatal: (message) => this.fail(message),
      logger: this.deps.logger,
      ...(this.deps.createEndpoint ? { createEndpoint: this.deps.createEndpoint } : {}),
      ...(this.deps.createPoller ? { createPoller: this.deps.createPoller } : {}),
    });
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
      if (err instanceof Error && err.message === LINEAR_KEY_REFUSED) {
        // Retrying a refused key changes nothing; a new key needs a restart anyway.
        this.endpoint = null;
        this.releaseLock();
        this.fail(LINEAR_KEY_REFUSED);
        return;
      }
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

  /** Post a comment (or an agent activity) as the key's user, recording it for the loop guard. */
  private async post(target: LinearTarget, body: string, kind: LinearActivityKind = "response"): Promise<void> {
    const api = this.api;
    if (api === null) return;
    const fitted = fitCommentBody(body);
    this.own.notePending(fitted);
    try {
      if (target.agentSessionId) await api.createAgentActivity(target.agentSessionId, kind, fitted);
      else this.own.notePosted(await api.createComment(target, fitted));
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
    const api = this.api;
    const inbox = this.inbox;
    if (api === null) return;
    void handleLinearEvent(payload, {
      runtime: this.deps.runtime,
      post: (target, body, kind) => this.post(target, body, kind),
      sessions: this.sessions,
      logger: this.deps.logger,
      ownerIds: this.ownerIds,
      handles: this.deps.handles,
      viewerId: this.viewerId,
      onAssign: this.assignOn(),
      own: this.own,
      bridge: this.bridge,
      turns: this.turns,
      ...(inbox !== null
        ? { attachments: { inbox, download: (url: string) => downloadLinearUpload(url, api.currentKey(), this.deps.fetchImpl) } }
        : {}),
      seen: this.seen,
      ensureApprovalSession: (sessionId, target) => this.approvalBindings.bind(sessionId, target),
      releaseApprovalSession: (sessionId) => this.approvalBindings.release(sessionId),
    });
  }

  /** With a personal key, assigning yourself an issue would start the agent: off unless asked for. */
  private assignOn(): boolean {
    const viewerIsOwner = this.viewerId !== null && this.ownerIds.includes(this.viewerId);
    return this.deps.onAssign ?? !viewerIsOwner;
  }

  /** Stop listening, abort in-flight turns, release the lock. Idempotent. */
  async stop(): Promise<void> {
    if (this.currentState === "disabled" && this.endpoint === null && !this.lockHeld && this.retryTimer === null) return;
    this.setState("stopping");
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.turns.cancelAll();
    this.approvalBindings.clear();
    this.bridge?.clear();
    this.bridge = null;
    this.api = null;
    this.inbox = null;
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
