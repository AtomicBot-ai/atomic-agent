/**
 * Lifecycle for the iMessage channel (ATO-630, macOS only).
 *
 * The Mac's owner texts the agent from Messages on their iPhone. The
 * transport is the external `imsg` CLI (steipete/imsg, MIT, macOS 14+)
 * that the operator installs: `imsg watch --json` streams new messages
 * out of `~/Library/Messages/chat.db`, `imsg send` answers through
 * Messages.app. Nothing is bundled; see ../docs/adapters.md.
 *
 * States: no owners or not enabled -> `disabled`; `imsg` missing ->
 * `disabled` with an install hint in `lastError`; watcher running ->
 * `up`; watcher exited or a permission is missing -> `down` with a hint,
 * while the watcher keeps retrying with the shared backoff.
 */

import { join } from "node:path";

import type { ApprovalGate } from "../../approval/approval-gate.js";
import type { ApprovalRouter } from "../../approval/approval-router.js";
import type { ChannelState, ChannelStatus } from "../../runtime/channel-status.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { Channel } from "../channel.js";
import { ChatSessionMap } from "../chat-session-map.js";
import { DiscordLockfile } from "../discord/discord-lockfile.js";
import { ImessageApprovalBridge } from "./imessage-approval-bridge.js";
import { normalizeOwnerIds } from "./imessage-handle.js";
import { handleImessageMessage } from "./imessage-inbound-handler.js";
import { parseImessageOptions } from "./imessage-options.js";
import { classifyImsgFailure, scrubImessageError, type ImsgFailure } from "./imsg-errors.js";
import { createImsgSender, ImsgSendError, type ExecFileLike, type ImessageTarget } from "./imsg-send.js";
import { ImsgWatcher, type SpawnLike } from "./imsg-watch.js";

/** The lock's surface; `DiscordLockfile` is a generic pid file despite its name. */
export interface ImessageLock {
  acquire(): void;
  release(): void;
}

export interface ImessageChannelDeps {
  runtime: AgentRuntime;
  logger: StructuredLogger;
  approvals: ApprovalGate;
  approvalRouter: ApprovalRouter;
  enabled: boolean;
  ownerIds: readonly string[];
  options: Readonly<Record<string, string | number | boolean>>;
  stateDir: string;
  onStatus?: (status: ChannelStatus) => void;
  /** Test seams. */
  lock?: ImessageLock;
  spawnImpl?: SpawnLike;
  execFileImpl?: ExecFileLike;
  watchDelayMs?: (attempt: number) => number;
}

export class ImessageChannel implements Channel {
  readonly id = "imessage";
  private currentState: ChannelState = "disabled";
  private error: string | null = null;
  private readonly owners: readonly string[];
  private readonly lock: ImessageLock;
  private lockHeld = false;
  private watcher: ImsgWatcher | null = null;
  private bridge: ImessageApprovalBridge | null = null;
  private readonly sessions: ChatSessionMap;
  private readonly inflight = new Map<string, AbortController>();
  private readonly approvalBindings = new Map<string, { chatId: number; unsubscribe: () => void }>();

  constructor(private readonly deps: ImessageChannelDeps) {
    this.owners = normalizeOwnerIds(deps.ownerIds);
    this.lock = deps.lock ?? new DiscordLockfile(join(deps.stateDir, "imessage.lock"));
    this.sessions = new ChatSessionMap(join(deps.stateDir, "imessage-session.json"));
  }

  state(): ChannelState {
    return this.currentState;
  }

  lastError(): string | null {
    return this.error;
  }

  async start(): Promise<void> {
    // A watcher that is retrying after an exit is still ours; a second one
    // would answer every message twice.
    if (this.watcher !== null || this.currentState === "starting") return;
    if (!this.deps.enabled) {
      this.setState("disabled", null);
      return;
    }
    if (this.owners.length === 0) {
      // Unpaired: refusing every message is the rule, and not running
      // the watcher at all is the cheapest way to keep it.
      this.setState("disabled", "No owner set: add your phone number or Apple ID e-mail to channels.imessage.ownerIds.");
      return;
    }
    const options = parseImessageOptions(this.deps.options);
    if (!options.ok) {
      this.setState("down", options.error);
      return;
    }
    this.setState("starting", null);
    try {
      this.lock.acquire();
      this.lockHeld = true;
    } catch (err) {
      this.setState("down", scrubImessageError(err));
      return;
    }

    const sender = createImsgSender({
      binary: options.value.binary,
      ...(this.deps.execFileImpl ? { execFileImpl: this.deps.execFileImpl } : {}),
    });
    const send = (target: ImessageTarget, text: string): Promise<void> => this.sendSafely(sender.send, target, text);
    const bridge = new ImessageApprovalBridge({ approvals: this.deps.approvals, logger: this.deps.logger, send });
    this.bridge = bridge;

    this.watcher = new ImsgWatcher({
      binary: options.value.binary,
      onRunning: () => this.setState("up", null),
      onExit: (failure) => {
        this.deps.logger.warn("imessage: imsg watch exited, restarting", { kind: failure.kind });
        this.setState("down", failure.message);
      },
      onFatal: (failure) => this.onFatal(failure),
      onMessage: (message) => {
        void handleImessageMessage(message, {
          runtime: this.deps.runtime,
          logger: this.deps.logger,
          sessions: this.sessions,
          ownerIds: () => this.owners,
          allowGroups: options.value.allowGroups,
          bridge,
          inflight: this.inflight,
          send,
          ensureApprovalSession: (sessionId, chatId, target) => this.bindApprovals(sessionId, chatId, target),
          releaseApprovalSession: (sessionId) => this.releaseApprovals(sessionId),
        });
      },
      ...(this.deps.spawnImpl ? { spawnImpl: this.deps.spawnImpl } : {}),
      ...(this.deps.watchDelayMs ? { delayMs: this.deps.watchDelayMs } : {}),
    });
    this.watcher.start();
  }

  async stop(): Promise<void> {
    if (this.currentState === "stopping") return;
    const wasRunning = this.watcher !== null || this.lockHeld;
    if (!wasRunning && this.currentState === "disabled") return;
    this.setState("stopping", null);
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
    for (const binding of this.approvalBindings.values()) binding.unsubscribe();
    this.approvalBindings.clear();
    this.bridge?.clear();
    this.bridge = null;
    this.watcher?.stop();
    this.watcher = null;
    this.releaseLock();
    this.setState("disabled", null);
  }

  /** `imsg` is not installed: a resting state with an install hint, not a red failure. */
  private onFatal(failure: ImsgFailure): void {
    this.watcher = null;
    this.releaseLock();
    this.setState(failure.kind === "missing" ? "disabled" : "down", failure.message);
  }

  /**
   * Send, never throw. A permission failure turns the channel `down`
   * with the Automation hint (inbound still works, so the watcher keeps
   * running); the next successful send brings it back `up`.
   */
  private async sendSafely(
    send: (target: ImessageTarget, text: string) => Promise<void>,
    target: ImessageTarget,
    text: string,
  ): Promise<void> {
    try {
      await send(target, text);
      if (this.currentState === "down" && this.watcher !== null) this.setState("up", null);
    } catch (err) {
      const failure =
        err instanceof ImsgSendError ? classifyImsgFailure(err.original, err.stderr) : classifyImsgFailure(err);
      this.deps.logger.warn("imessage: outbound send failed", { kind: failure.kind, error: failure.message });
      if (failure.kind === "missing") this.onFatal(failure);
      else if (failure.kind !== "other" && this.watcher !== null) this.setState("down", failure.message);
    }
  }

  private bindApprovals(sessionId: string, chatId: number, target: ImessageTarget): void {
    const existing = this.approvalBindings.get(sessionId);
    if (existing?.chatId === chatId) return;
    existing?.unsubscribe();
    this.approvalBindings.delete(sessionId);
    if (!this.bridge) return;
    const unsubscribe = this.deps.approvalRouter.setForSession(sessionId, this.bridge.handlerFor(chatId, target));
    this.approvalBindings.set(sessionId, { chatId, unsubscribe });
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

  private setState(next: ChannelState, error: string | null): void {
    if (this.currentState === next && this.error === error) return;
    this.currentState = next;
    this.error = error;
    this.deps.onStatus?.({ channel: this.id, state: next, ...(error !== null ? { lastError: error } : {}) });
  }
}
