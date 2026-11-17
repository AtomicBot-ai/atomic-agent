/**
 * Lifecycle for the Signal channel (ATO-629): lock, event stream,
 * owner allowlist, approval bindings, session map.
 *
 * States: `disabled` when switched off or `options.account` is missing
 * (an unconfigured integration is a resting state, not a failure);
 * `starting` while the first connect runs; `up` while the event stream
 * is open; `down` with a plain reason while the daemon is unreachable,
 * retrying in the background until `stop()`.
 */

import { join } from "node:path";

import type { ChannelState, ChannelStatus } from "../../runtime/channel-status.js";
import type { Channel, ChannelContext } from "../channel.js";
import { ChatSessionMap } from "../chat-session-map.js";
// The Discord lockfile is not Discord-specific: a PID file with stale
// reclaim, tagged with the shared `channel-locked:` reason.
import { DiscordLockfile } from "../discord/discord-lockfile.js";
import { SignalApprovalBridge } from "./signal-approval-bridge.js";
import { SignalEventStream } from "./signal-events.js";
import { handleSignalEnvelope } from "./signal-inbound-handler.js";
import { SignalRpc, type FetchLike, type SignalTarget } from "./signal-rpc.js";
import {
  SIGNAL_CHANNEL_ID,
  extractEnvelope,
  normalizeSignalId,
  readSignalOptions,
  scrubSignalError,
} from "./signal-types.js";

export interface SignalChannelSeams {
  fetch?: FetchLike;
  backoff?: (attempt: number) => number;
  lock?: Pick<DiscordLockfile, "acquire" | "release">;
  randomCode?: () => string;
}

export class SignalChannel implements Channel {
  readonly id = SIGNAL_CHANNEL_ID;
  private current: ChannelState = "disabled";
  private error: string | null = null;
  private stream: SignalEventStream | null = null;
  private bridge: SignalApprovalBridge | null = null;
  private lockHeld = false;
  private readonly lock: Pick<DiscordLockfile, "acquire" | "release">;
  private readonly sessionMap: ChatSessionMap;
  private readonly ownerIds: readonly string[];
  private readonly inflight = new Map<string, AbortController>();
  /** `sessionId -> unsubscribe` for the approval router. */
  private readonly approvalBindings = new Map<string, () => void>();

  constructor(
    private readonly ctx: ChannelContext,
    private readonly seams: SignalChannelSeams = {},
  ) {
    this.lock = seams.lock ?? new DiscordLockfile(join(ctx.stateDir, `${SIGNAL_CHANNEL_ID}.lock`));
    this.sessionMap = new ChatSessionMap(join(ctx.stateDir, "signal-session.json"));
    this.ownerIds = ctx.channelConfig.ownerIds.map(normalizeSignalId);
  }

  state(): ChannelState {
    return this.current;
  }

  lastError(): string | null {
    return this.current === "down" ? this.error : null;
  }

  async start(): Promise<void> {
    if (this.current === "up" || this.current === "starting" || this.stream !== null) return;
    const options = readSignalOptions(this.ctx.channelConfig);
    if (!this.ctx.channelConfig.enabled || options.account === null) {
      if (this.ctx.channelConfig.enabled) {
        this.ctx.logger.info("signal: channels.signal.options.account is not set; staying off");
      }
      this.setState("disabled");
      return;
    }
    if (this.ownerIds.length === 0) {
      this.ctx.logger.warn("signal: channels.signal.ownerIds is empty; every message will be refused");
    }
    this.setState("starting");
    try {
      this.lock.acquire();
      this.lockHeld = true;
    } catch (err) {
      this.fail(scrubSignalError(err));
      return;
    }

    const rpc = new SignalRpc({ url: options.url, ...(this.seams.fetch ? { fetch: this.seams.fetch } : {}) });
    const send = async (target: SignalTarget, text: string): Promise<void> => {
      await rpc.send(target, text);
    };
    const bridge = new SignalApprovalBridge({
      send,
      approvals: this.ctx.approvals,
      logger: this.ctx.logger,
      ...(this.seams.randomCode ? { randomCode: this.seams.randomCode } : {}),
    });
    this.bridge = bridge;
    const account = options.account;

    this.stream = new SignalEventStream({
      url: options.url,
      ...(this.seams.fetch ? { fetch: this.seams.fetch } : {}),
      ...(this.seams.backoff ? { backoff: this.seams.backoff } : {}),
      onUp: () => this.setState("up"),
      onDown: (reason) => {
        this.ctx.logger.warn("signal: event stream down, retrying", { error: reason });
        this.fail(scrubSignalError(reason));
      },
      onPayload: (payload) => {
        const extracted = extractEnvelope(payload);
        if (extracted === null) return;
        // A multi-account daemon streams every account; act on ours only.
        if (extracted.account !== null && normalizeSignalId(extracted.account) !== account) return;
        void handleSignalEnvelope(extracted.envelope, {
          runtime: this.ctx.runtime,
          logger: this.ctx.logger,
          sessionMap: this.sessionMap,
          ownerIds: this.ownerIds,
          account,
          allowGroups: options.allowGroups,
          bridge,
          send,
          sendTyping: (target, stop) => rpc.sendTyping(target, stop),
          inflight: this.inflight,
          ensureApprovalSession: (sessionId, target) => this.bindApprovals(sessionId, target),
          releaseApprovalSession: (sessionId) => this.releaseApprovals(sessionId),
        });
      },
    });
    await this.stream.start();
  }

  async stop(): Promise<void> {
    if (this.current === "disabled" && this.stream === null && !this.lockHeld) return;
    this.setState("stopping");
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
    for (const unsubscribe of this.approvalBindings.values()) unsubscribe();
    this.approvalBindings.clear();
    this.bridge?.clear();
    this.bridge = null;
    this.stream?.stop();
    this.stream = null;
    if (this.lockHeld) {
      this.lock.release();
      this.lockHeld = false;
    }
    this.setState("disabled");
  }

  /** Point approvals for `sessionId` at the chat its turn came from. */
  private bindApprovals(sessionId: string, target: SignalTarget): void {
    if (!this.bridge) return;
    this.approvalBindings.get(sessionId)?.();
    const unsubscribe = this.ctx.approvalRouter.setForSession(sessionId, this.bridge.handlerFor(target));
    this.approvalBindings.set(sessionId, unsubscribe);
  }

  private releaseApprovals(sessionId: string): void {
    this.approvalBindings.get(sessionId)?.();
    this.approvalBindings.delete(sessionId);
  }

  private fail(message: string): void {
    // A retry loop that keeps failing the same way must not flood hosts.
    if (this.current === "down" && this.error === message) return;
    this.error = message;
    this.setState("down", true);
  }

  /** `force` re-emits a `down` whose reason changed. */
  private setState(next: ChannelState, force = false): void {
    if (this.current === next && !force) return;
    this.current = next;
    if (next !== "down") this.error = null;
    const status: ChannelStatus = {
      channel: SIGNAL_CHANNEL_ID,
      state: next,
      ...(next === "down" && this.error !== null ? { lastError: this.error } : {}),
    };
    this.ctx.emitStatus(status);
  }
}
