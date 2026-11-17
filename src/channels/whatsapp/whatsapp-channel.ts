/**
 * Lifecycle for the WhatsApp channel (ATO-502): lock, WhatsApp Web
 * socket, QR pairing, owner allowlist, approval bindings, session map.
 *
 * States: `disabled` when switched off, or when the protocol library
 * cannot be loaded in this build (with a `lastError` saying so); `starting`
 * while the first connect runs; `down` while waiting for the QR code to
 * be scanned (the `lastError` says where the QR is) or while the
 * connection is lost and retrying; `up` while linked and online.
 *
 * A logged-out device (the owner removed it under Linked devices, or
 * WhatsApp did) deletes the saved keys, goes `down` with "pair again"
 * and does not reconnect: reconnecting would only print new QR codes
 * that nobody is waiting for. The same holds for a QR that timed out,
 * a session taken over by another WhatsApp Web client and a 403.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ChannelState, ChannelStatus } from "../../runtime/channel-status.js";
import type { Channel, ChannelContext } from "../channel.js";
import { ChatSessionMap } from "../chat-session-map.js";
// A PID file with stale reclaim, tagged with the shared `channel-locked:` reason.
import { DiscordLockfile as PidLockfile } from "../discord/discord-lockfile.js";
import { backoffMs } from "../reconnect-backoff.js";
import { WhatsAppApprovalBridge } from "./whatsapp-approval-bridge.js";
import { loadBaileysConnector } from "./whatsapp-baileys.js";
import { handleWhatsAppMessage } from "./whatsapp-inbound-handler.js";
import type {
  LoadWhatsAppConnector,
  WhatsAppConnector,
  WhatsAppSocket,
} from "./whatsapp-transport.js";
import {
  WHATSAPP_CHANNEL_ID,
  WHATSAPP_MODULE_MISSING,
  WHATSAPP_UNOFFICIAL_WARNING,
  classifyClose,
  normalizeWhatsAppId,
  readWhatsAppOptions,
  scrubWhatsAppError,
} from "./whatsapp-types.js";

export interface WhatsAppChannelSeams {
  /** Load the protocol connector; defaults to the lazy baileys loader. */
  load?: LoadWhatsAppConnector;
  backoff?: (attempt: number) => number;
  lock?: Pick<PidLockfile, "acquire" | "release">;
  randomCode?: () => string;
}

export class WhatsAppChannel implements Channel {
  readonly id = WHATSAPP_CHANNEL_ID;
  private current: ChannelState = "disabled";
  private error: string | null = null;
  private running = false;
  private lockHeld = false;
  private connector: WhatsAppConnector | null = null;
  private socket: WhatsAppSocket | null = null;
  private bridge: WhatsAppApprovalBridge | null = null;
  /** Bumped on every connect and on stop, so a stale socket's events are ignored. */
  private generation = 0;
  private attempt = 0;
  /** True once this connection showed a QR code and has not opened yet. */
  private pairing = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly lock: Pick<PidLockfile, "acquire" | "release">;
  private readonly sessionMap: ChatSessionMap;
  private readonly ownerIds: readonly string[];
  private readonly inflight = new Map<string, AbortController>();
  private readonly seen = new Set<string>();
  /** `sessionId -> unsubscribe` for the approval router. */
  private readonly approvalBindings = new Map<string, () => void>();
  readonly authDir: string;
  readonly qrPath: string;

  constructor(
    private readonly ctx: ChannelContext,
    private readonly seams: WhatsAppChannelSeams = {},
  ) {
    this.lock = seams.lock ?? new PidLockfile(join(ctx.stateDir, `${WHATSAPP_CHANNEL_ID}.lock`));
    this.sessionMap = new ChatSessionMap(join(ctx.stateDir, "whatsapp-session.json"));
    this.ownerIds = ctx.channelConfig.ownerIds.map(normalizeWhatsAppId);
    this.authDir = join(ctx.stateDir, "whatsapp-auth");
    this.qrPath = join(ctx.stateDir, "whatsapp-qr.txt");
  }

  state(): ChannelState {
    return this.current;
  }

  lastError(): string | null {
    return this.current === "down" || this.current === "disabled" ? this.error : null;
  }

  async start(): Promise<void> {
    if (this.running || this.current === "starting") return;
    if (!this.ctx.channelConfig.enabled) {
      this.setState("disabled");
      return;
    }
    if (this.ownerIds.length === 0) {
      this.ctx.logger.warn("whatsapp: channels.whatsapp.ownerIds is empty; every message will be refused");
    }
    this.setState("starting");
    try {
      this.lock.acquire();
      this.lockHeld = true;
    } catch (err) {
      this.fail(scrubWhatsAppError(err));
      return;
    }

    let connector: WhatsAppConnector;
    try {
      connector = await (this.seams.load ?? loadBaileysConnector)();
    } catch (err) {
      this.ctx.logger.warn("whatsapp: protocol library could not be loaded", {
        error: scrubWhatsAppError(err),
      });
      this.releaseLock();
      this.setState("disabled", WHATSAPP_MODULE_MISSING);
      return;
    }

    this.ctx.logger.warn(`whatsapp: ${WHATSAPP_UNOFFICIAL_WARNING}`);
    this.connector = connector;
    this.bridge = new WhatsAppApprovalBridge({
      send: (chat, text) => this.sendText(chat, text),
      approvals: this.ctx.approvals,
      logger: this.ctx.logger,
      ...(this.seams.randomCode ? { randomCode: this.seams.randomCode } : {}),
    });
    this.running = true;
    await this.connect();
  }

  async stop(): Promise<void> {
    if (!this.running && this.current === "disabled" && !this.lockHeld) return;
    this.setState("stopping");
    this.running = false;
    this.generation++;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
    for (const unsubscribe of this.approvalBindings.values()) unsubscribe();
    this.approvalBindings.clear();
    this.bridge?.clear();
    this.bridge = null;
    this.closeSocket();
    this.connector = null;
    this.removeQrFile();
    this.releaseLock();
    this.setState("disabled");
  }

  private async connect(): Promise<void> {
    const connector = this.connector;
    if (!this.running || connector === null) return;
    const gen = ++this.generation;
    this.pairing = false;
    const stale = (): boolean => gen !== this.generation || !this.running;
    let socket: WhatsAppSocket;
    try {
      mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
      socket = await connector.connect({
        authDir: this.authDir,
        events: {
          onQr: (qr) => {
            if (stale()) return;
            this.pairing = true;
            void this.showQr(connector, qr);
          },
          onOpen: () => {
            if (stale()) return;
            this.attempt = 0;
            this.pairing = false;
            this.removeQrFile();
            this.ctx.logger.info("whatsapp: linked and online");
            this.setState("up");
          },
          onClose: ({ statusCode, reason }) => {
            if (stale()) return;
            this.socket = null;
            this.onClosed(statusCode, reason);
          },
          onMessage: (raw) => {
            if (stale() || this.bridge === null) return;
            void handleWhatsAppMessage(raw, {
              runtime: this.ctx.runtime,
              logger: this.ctx.logger,
              sessionMap: this.sessionMap,
              ownerIds: this.ownerIds,
              allowGroups: readWhatsAppOptions(this.ctx.channelConfig).allowGroups,
              bridge: this.bridge,
              send: (chat, text) => this.sendText(chat, text),
              sendTyping: (chat, on) => this.sendTyping(chat, on),
              inflight: this.inflight,
              seen: this.seen,
              ensureApprovalSession: (sessionId, chat) => this.bindApprovals(sessionId, chat),
              releaseApprovalSession: (sessionId) => this.releaseApprovals(sessionId),
            });
          },
        },
      });
    } catch (err) {
      if (stale()) return;
      this.ctx.logger.warn("whatsapp: connect failed, retrying", { error: scrubWhatsAppError(err) });
      this.scheduleRetry(`WhatsApp connect failed: ${scrubWhatsAppError(err)}`);
      return;
    }
    if (stale()) {
      socket.close();
      return;
    }
    this.socket = socket;
  }

  private onClosed(statusCode: number | null, reason: string): void {
    const decision = classifyClose(statusCode, reason, this.pairing);
    if (decision.clearAuth) {
      // Only when WhatsApp itself says this device is no longer linked:
      // the keys are useless then, and keeping them would fail forever.
      try {
        rmSync(this.authDir, { recursive: true, force: true });
      } catch (err) {
        this.ctx.logger.warn("whatsapp: could not delete stale session keys", {
          error: scrubWhatsAppError(err),
        });
      }
      this.removeQrFile();
    }
    switch (decision.action) {
      case "reconnect-now":
        this.ctx.logger.info("whatsapp: reconnecting", { reason: decision.message });
        void this.connect();
        return;
      case "reconnect-later":
        this.ctx.logger.warn("whatsapp: connection closed, retrying", { reason: decision.message });
        this.scheduleRetry(decision.message);
        return;
      case "stop":
        this.ctx.logger.warn(`whatsapp: ${decision.message}`);
        this.removeQrFile();
        this.fail(decision.message);
        return;
    }
  }

  private scheduleRetry(message: string): void {
    this.fail(message);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    const delay = (this.seams.backoff ?? backoffMs)(this.attempt++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  /** Write the QR where the operator can scan it, and say so in the status. */
  private async showQr(connector: WhatsAppConnector, qr: string): Promise<void> {
    let drawn: string | null = null;
    try {
      drawn = await connector.renderQr(qr);
    } catch {
      drawn = null;
    }
    // Linked (or stopped) while the QR was being drawn: nothing to show.
    if (!this.running || !this.pairing) return;
    const body = [
      "Link Atomic Agent to WhatsApp",
      "",
      "On the phone with the bot's number: WhatsApp > Settings > Linked devices > Link a device,",
      "then scan this code. It changes about every 20 seconds; this file is rewritten each time.",
      "",
      WHATSAPP_UNOFFICIAL_WARNING,
      "",
      drawn ?? `Could not draw the QR code. Paste this text into any QR generator and scan it:\n${qr}`,
      "",
    ].join("\n");
    try {
      writeFileSync(this.qrPath, body, { encoding: "utf8", mode: 0o600 });
    } catch (err) {
      this.ctx.logger.warn("whatsapp: could not write the QR file", { error: scrubWhatsAppError(err) });
    }
    const message =
      `Not paired yet. Scan the QR code in ${this.qrPath} with WhatsApp on the bot's phone ` +
      "(Settings > Linked devices > Link a device).";
    if (this.current !== "down" || this.error !== message) {
      this.ctx.logger.info(`whatsapp: ${message}`);
    }
    this.fail(message);
  }

  private async sendText(chat: string, text: string): Promise<void> {
    const socket = this.socket;
    if (socket === null) throw new Error("WhatsApp is not connected");
    await socket.sendText(chat, text);
  }

  private async sendTyping(chat: string, on: boolean): Promise<void> {
    await this.socket?.sendTyping?.(chat, on);
  }

  /** Point approvals for `sessionId` at the chat its turn came from. */
  private bindApprovals(sessionId: string, chat: string): void {
    if (!this.bridge) return;
    this.approvalBindings.get(sessionId)?.();
    const unsubscribe = this.ctx.approvalRouter.setForSession(sessionId, this.bridge.handlerFor(chat));
    this.approvalBindings.set(sessionId, unsubscribe);
  }

  private releaseApprovals(sessionId: string): void {
    this.approvalBindings.get(sessionId)?.();
    this.approvalBindings.delete(sessionId);
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      // Closing a dead socket is not an error worth reporting.
    }
  }

  private removeQrFile(): void {
    try {
      rmSync(this.qrPath, { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }

  private releaseLock(): void {
    if (!this.lockHeld) return;
    this.lock.release();
    this.lockHeld = false;
  }

  private fail(message: string): void {
    // A retry loop or a rotating QR must not flood hosts with the same line.
    if (this.current === "down" && this.error === message) return;
    this.setState("down", message);
  }

  private setState(next: ChannelState, error: string | null = null): void {
    if (this.current === next && this.error === error) return;
    this.current = next;
    this.error = error;
    const status: ChannelStatus = {
      channel: WHATSAPP_CHANNEL_ID,
      state: next,
      ...(error !== null ? { lastError: error } : {}),
    };
    this.ctx.emitStatus(status);
  }
}
