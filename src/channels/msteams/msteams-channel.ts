/**
 * Lifecycle orchestrator for the Microsoft Teams channel (ATO-506).
 *
 * Owns the local Bot Framework endpoint, the JWT verifier, the outbound
 * API client, the owner allowlist, the approval bridge, the
 * single-instance lock and the per-conversation session map. Presents
 * the shared `Channel` surface so the runtime starts, lists and stops it
 * like every other messenger.
 *
 * There is no connection to keep alive: Bot Framework calls us. "Up"
 * means the endpoint is listening on 127.0.0.1 and the credentials were
 * not rejected. A port that cannot be bound is retried with the shared
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
import { TeamsApi, TeamsApiError } from "./msteams-api.js";
import { TeamsApprovalBridge } from "./msteams-approval-bridge.js";
import { handleTeamsActivity } from "./msteams-inbound-handler.js";
import { TeamsJwtVerifier, normalizeServiceUrl } from "./msteams-jwt.js";
import { TeamsServer, type TeamsServerDeps } from "./msteams-server.js";
import {
  MSTEAMS_APP_ID_KEY,
  MSTEAMS_APP_PASSWORD_KEY,
  resolveTeamsSecret,
  scrubTeamsError,
  type TeamsActivity,
  type TeamsTarget,
} from "./msteams-types.js";

/** Service URLs remembered from authenticated activities (Teams uses a handful per region). */
const SERVICE_URL_CAP = 32;

export interface TeamsEndpoint {
  listen(): Promise<void>;
  close(): Promise<void>;
}

export interface TeamsChannelDeps {
  runtime: AgentRuntime;
  logger: StructuredLogger;
  approvals: ApprovalGate;
  approvalRouter: ApprovalRouter;
  enabled: boolean;
  ownerIds: readonly string[];
  port: number;
  tenantId: string | null;
  sessionMapPath: string;
  lock: { acquire(): void; release(): void };
  /** Explicit secrets win over the env: the test seam. */
  appId?: string | null;
  appPassword?: string | null;
  onStatus?: (status: ChannelStatus) => void;
  fetchImpl?: typeof fetch;
  openIdUrl?: string;
  tokenUrl?: string;
  /** Test seam: replaces the real `node:http` endpoint. */
  createEndpoint?: (deps: TeamsServerDeps) => TeamsEndpoint;
}

export class TeamsChannel implements Channel {
  readonly id = "msteams";
  private currentState: ChannelStatus["state"] = "disabled";
  private error: string | null = null;
  private endpoint: TeamsEndpoint | null = null;
  private bridge: TeamsApprovalBridge | null = null;
  private api: TeamsApi | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private lockHeld = false;
  private readonly ownerIds: readonly string[];
  private readonly inflight = new Map<string, AbortController>();
  private readonly seen = new Set<string>();
  private readonly serviceUrls = new Set<string>();
  private readonly sessions: ChatSessionMap;
  private readonly approvalBindings = new Map<string, { key: string; unsubscribe: () => void }>();

  constructor(private readonly deps: TeamsChannelDeps) {
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
   * Listen, unless switched off or a secret is missing (`disabled`).
   * Settles after one credential check and one bind attempt.
   */
  async start(): Promise<void> {
    if (this.currentState === "up" || this.currentState === "starting") return;
    if (this.endpoint !== null || this.lockHeld || this.retryTimer !== null) await this.stop();
    const appId = resolveTeamsSecret(MSTEAMS_APP_ID_KEY, this.deps.appId);
    const appPassword = resolveTeamsSecret(MSTEAMS_APP_PASSWORD_KEY, this.deps.appPassword);
    if (!this.deps.enabled || appId === null || appPassword === null) {
      this.setState("disabled");
      return;
    }
    const secrets = [appPassword];
    if (this.ownerIds.length === 0) {
      this.deps.logger.warn("msteams: no ownerIds configured; every message will be refused");
    }
    this.setState("starting");
    try {
      this.deps.lock.acquire();
      this.lockHeld = true;
    } catch (err) {
      this.fail(scrubTeamsError(err, secrets));
      return;
    }
    const api = new TeamsApi({
      appId,
      appPassword,
      tenantId: this.deps.tenantId,
      isAllowedServiceUrl: (url) => this.serviceUrls.has(url),
      ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }),
      ...(this.deps.tokenUrl === undefined ? {} : { tokenUrl: this.deps.tokenUrl }),
    });
    try {
      await api.getToken();
    } catch (err) {
      if (err instanceof TeamsApiError && err.code.startsWith("token_")) {
        this.releaseLock();
        this.fail(`${err.message} Check ${MSTEAMS_APP_ID_KEY}, ${MSTEAMS_APP_PASSWORD_KEY} and options.tenantId.`);
        return;
      }
      // Offline at boot is not fatal: the token is fetched again on the first reply.
      this.deps.logger.warn("msteams: could not reach Microsoft sign-in yet", { error: scrubTeamsError(err, secrets) });
    }
    // `stop()` ran while the credential check was in flight.
    if (this.state() !== "starting") return;
    this.api = api;
    this.bridge = new TeamsApprovalBridge({
      api,
      approvals: this.deps.approvals,
      logger: this.deps.logger,
      ownerIds: () => this.ownerIds,
    });
    const serverDeps: TeamsServerDeps = {
      port: this.deps.port,
      verifier: new TeamsJwtVerifier({
        appId,
        ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }),
        ...(this.deps.openIdUrl === undefined ? {} : { openIdUrl: this.deps.openIdUrl }),
      }),
      onActivity: (activity) => this.onActivity(activity),
      logger: { warn: (m, c) => this.deps.logger.warn(m, c) },
    };
    this.endpoint = this.deps.createEndpoint?.(serverDeps) ?? new TeamsServer(serverDeps);
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
          ? `Port ${this.deps.port} on 127.0.0.1 is already in use (set channels.msteams.options.port).`
          : scrubTeamsError(err),
      );
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.listen(attempt + 1);
      }, backoffMs(attempt));
      this.retryTimer.unref?.();
    }
  }

  private onActivity(activity: TeamsActivity): void {
    // Only authenticated activities reach here: their service URL is one
    // Bot Framework vouched for, so replies (and our token) may go there.
    if (typeof activity.serviceUrl === "string") {
      const url = normalizeServiceUrl(activity.serviceUrl);
      if (!this.serviceUrls.has(url)) {
        if (this.serviceUrls.size >= SERVICE_URL_CAP) {
          const oldest = this.serviceUrls.values().next().value;
          if (oldest !== undefined) this.serviceUrls.delete(oldest);
        }
        this.serviceUrls.add(url);
      }
    }
    if (this.api === null) return;
    void handleTeamsActivity(activity, {
      runtime: this.deps.runtime,
      api: this.api,
      sessions: this.sessions,
      logger: this.deps.logger,
      ownerIds: this.ownerIds,
      bridge: this.bridge,
      inflight: this.inflight,
      seen: this.seen,
      ensureApprovalSession: (sessionId, target) => this.bindApprovals(sessionId, target),
      releaseApprovalSession: (sessionId) => this.releaseApprovals(sessionId),
    });
  }

  /** Point approval prompts for `sessionId` at `target`. Idempotent. */
  private bindApprovals(sessionId: string, target: TeamsTarget): void {
    const key = `${target.conversationId}:${target.replyToId ?? ""}`;
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
    this.deps.onStatus?.({ channel: "msteams", state: next, ...(this.error ? { lastError: this.error } : {}) });
  }
}
