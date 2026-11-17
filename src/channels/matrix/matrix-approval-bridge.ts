/**
 * Route approval requests raised by a Matrix-originated turn back into
 * the room that asked, and settle them from a text answer.
 *
 * Matrix has no buttons. Reactions would work in Element but are
 * awkward to type elsewhere and to target, so the prompt carries a
 * short code and the owner answers with plain text:
 * `yes <code>`, `no <code>`, or `always <code>` when "allow always" is
 * offered. A bare `yes` / `no` counts only when exactly one prompt is
 * open in that room, so it can never settle the wrong request.
 *
 * The bridge never approves anything on its own: a decision needs an
 * owner, in the room the prompt was posted to.
 */

import { randomBytes } from "node:crypto";

import type { ApprovalGate, ApprovalRequest } from "../../approval/approval-gate.js";
import { describeAlwaysRule } from "../../approval/approval-rules.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { MatrixApi } from "./matrix-api.js";

export interface MatrixApprovalBridgeDeps {
  api: Pick<MatrixApi, "sendNotice">;
  approvals: Pick<ApprovalGate, "resolve"> & Partial<Pick<ApprovalGate, "canGrantAlways">>;
  logger: Pick<StructuredLogger, "warn">;
  /** Mxids permitted to decide. Read live, so an edit lands at once. */
  ownerIds: () => readonly string[];
  /** Test seam for the prompt code. */
  makeCode?: () => string;
  now?: () => number;
}

interface Pending {
  approvalId: string;
  roomId: string;
  alwaysLabel?: string;
  postedAt: number;
}

/** Prompts nobody answered are forgotten after this; the gate has timed out long before. */
const PENDING_TTL_MS = 6 * 60 * 60_000;

const ANSWER_RE = /^\s*(yes|y|approve|no|n|deny|always)(?:\s+([0-9a-f]{6,12}))?\s*[.!]?\s*$/i;

export class MatrixApprovalBridge {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: MatrixApprovalBridgeDeps) {}

  /** Handler for `ApprovalRouter.setForSession`. Synchronous by contract. */
  handlerFor(roomId: string): (request: ApprovalRequest) => void {
    return (request) => {
      void this.post(request, roomId).catch((err) => {
        this.deps.logger.warn("matrix: failed to post approval prompt", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };
  }

  /** Open prompts in `roomId` (for `/status`). */
  pendingIn(roomId: string): number {
    return [...this.pending.values()].filter((p) => p.roomId === roomId).length;
  }

  /**
   * Read `text` as an approval answer. Returns the reply to post when it
   * was one (consumed), or `null` when it is an ordinary message.
   */
  tryAnswer(roomId: string, senderId: string, text: string): string | null {
    const match = ANSWER_RE.exec(text);
    if (!match) return null;
    const verb = (match[1] ?? "").toLowerCase();
    const code = match[2]?.toLowerCase();
    if (!this.deps.ownerIds().includes(senderId)) {
      // Silent: the channel never talks back to accounts that are not owners.
      this.deps.logger.warn("matrix: ignoring approval answer from non-owner", { senderId });
      return null;
    }
    const inRoom = [...this.pending.entries()].filter(([, p]) => p.roomId === roomId);
    let entry: [string, Pending] | undefined;
    if (code !== undefined) {
      entry = inRoom.find(([c]) => c === code);
      // Nothing open here: "no facade" is a sentence, not a stale answer.
      if (!entry && inRoom.length === 0) return null;
      if (!entry) return "That approval code is unknown here or was already answered.";
    } else {
      // A bare "yes" with nothing open is just a message for the agent.
      if (inRoom.length === 0) return null;
      if (inRoom.length > 1) {
        return `${inRoom.length} approvals are open here; answer with the code, e.g. "yes ${inRoom[0]?.[0]}".`;
      }
      entry = inRoom[0];
    }
    if (!entry) return null;
    const [entryCode, posted] = entry;
    const always = verb === "always";
    if (always && posted.alwaysLabel === undefined) {
      return "\"Allow always\" was not offered for this request; answer yes or no.";
    }
    const approved = always || verb === "yes" || verb === "y" || verb === "approve";
    this.pending.delete(entryCode);
    const settled = this.deps.approvals.resolve({
      approvalId: posted.approvalId,
      approved,
      ...(approved ? { reason: "approved from Matrix" } : {}),
      ...(always ? { grant: "always" as const } : {}),
    });
    if (!settled) return "This request already expired or was answered elsewhere.";
    if (always) return `Approved. Saved: ${posted.alwaysLabel}.`;
    return approved ? "Approved." : "Denied.";
  }

  /** Drop outstanding prompts (channel stopping). */
  clear(): void {
    this.pending.clear();
  }

  private async post(request: ApprovalRequest, roomId: string): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    for (const [code, p] of this.pending) {
      if (now - p.postedAt > PENDING_TTL_MS) this.pending.delete(code);
    }
    const alwaysLabel =
      this.deps.approvals.canGrantAlways?.(request) === true
        ? describeAlwaysRule(request)
        : undefined;
    const code = this.freshCode();
    this.pending.set(code, {
      approvalId: request.approvalId,
      roomId,
      postedAt: now,
      ...(alwaysLabel !== undefined ? { alwaysLabel } : {}),
    });
    await this.deps.api.sendNotice(roomId, formatMatrixPrompt(request, code, alwaysLabel));
  }

  private freshCode(): string {
    const make = this.deps.makeCode ?? (() => randomBytes(3).toString("hex"));
    for (let i = 0; i < 8; i++) {
      const code = make().toLowerCase();
      if (!this.pending.has(code)) return code;
    }
    return randomBytes(6).toString("hex");
  }
}

export function formatMatrixPrompt(
  request: ApprovalRequest,
  code: string,
  alwaysLabel?: string,
): string {
  const lines = [`Approval needed: ${request.tool} (${request.category})`, request.reason];
  if (request.preview) {
    const preview = request.preview.slice(0, 1500);
    lines.push("", preview, "");
  }
  if (request.affectedResources?.length) {
    lines.push(`Affects: ${request.affectedResources.slice(0, 5).join(", ")}`);
  }
  lines.push(`Reply "yes ${code}" to approve or "no ${code}" to deny.`);
  if (alwaysLabel !== undefined) {
    lines.push(`Reply "always ${code}" to approve and save: ${alwaysLabel}.`);
  }
  return lines.join("\n");
}
