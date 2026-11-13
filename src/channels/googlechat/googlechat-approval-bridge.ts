/**
 * Route approval requests raised by a Google Chat turn back into the
 * space that asked, and settle them from a text answer.
 *
 * Same scheme as Matrix and Signal: the prompt carries a short code and
 * an owner answers in plain text, `yes <code>`, `no <code>`, or
 * `always <code>` when "allow always" is offered. A bare `yes` / `no`
 * counts only when exactly one prompt is open in that space, so it can
 * never settle the wrong request. Card buttons would need a
 * `CARD_CLICKED` round trip and card JSON per surface; text works in
 * every Chat client and is the follow-up candidate, not a blocker.
 *
 * The bridge never approves anything on its own: a decision needs an
 * owner, in the space the prompt was posted to.
 */

import { randomBytes } from "node:crypto";

import type { ApprovalGate, ApprovalRequest } from "../../approval/approval-gate.js";
import { describeAlwaysRule } from "../../approval/approval-rules.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { GoogleChatUserRef } from "./googlechat-types.js";

export interface GoogleChatApprovalBridgeDeps {
  /** Post into `space`, in `thread` when given. */
  post: (space: string, text: string, thread?: string) => Promise<void>;
  approvals: Pick<ApprovalGate, "resolve"> & Partial<Pick<ApprovalGate, "canGrantAlways">>;
  logger: Pick<StructuredLogger, "warn">;
  /** Is this sender an owner? Read live. */
  isOwner: (user: GoogleChatUserRef | undefined) => boolean;
  /** Test seam for the prompt code. */
  makeCode?: () => string;
  now?: () => number;
}

interface Pending {
  approvalId: string;
  space: string;
  alwaysLabel?: string;
  postedAt: number;
}

/** Prompts nobody answered are forgotten after this; the gate has timed out long before. */
const PENDING_TTL_MS = 6 * 60 * 60_000;

const ANSWER_RE = /^\s*(yes|y|approve|no|n|deny|always)(?:\s+([0-9a-f]{6,12}))?\s*[.!]?\s*$/i;

export class GoogleChatApprovalBridge {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: GoogleChatApprovalBridgeDeps) {}

  /**
   * Handler for `ApprovalRouter.setForSession`. Synchronous by contract.
   * `thread` is read when the prompt is posted, so it lands next to the
   * message that started the turn.
   */
  handlerFor(space: string, thread: () => string | undefined): (request: ApprovalRequest) => void {
    return (request) => {
      void this.postPrompt(request, space, thread()).catch((err) => {
        this.deps.logger.warn("googlechat: failed to post approval prompt", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };
  }

  /** Open prompts in `space` (for `/status`). */
  pendingIn(space: string): number {
    return [...this.pending.values()].filter((p) => p.space === space).length;
  }

  /**
   * Read `text` as an approval answer. Returns the reply to post when it
   * was one (consumed), or `null` when it is an ordinary message.
   */
  tryAnswer(space: string, sender: GoogleChatUserRef | undefined, text: string): string | null {
    const match = ANSWER_RE.exec(text);
    if (!match) return null;
    const verb = (match[1] ?? "").toLowerCase();
    const code = match[2]?.toLowerCase();
    if (!this.deps.isOwner(sender)) {
      // Silent: the channel never talks back to accounts that are not owners.
      this.deps.logger.warn("googlechat: ignoring approval answer from non-owner", {
        senderId: sender?.name,
      });
      return null;
    }
    const inSpace = [...this.pending.entries()].filter(([, p]) => p.space === space);
    let entry: [string, Pending] | undefined;
    if (code !== undefined) {
      entry = inSpace.find(([c]) => c === code);
      // Nothing open here: "no facade" is a sentence, not a stale answer.
      if (!entry && inSpace.length === 0) return null;
      if (!entry) return "That approval code is unknown here or was already answered.";
    } else {
      // A bare "yes" with nothing open is just a message for the agent.
      if (inSpace.length === 0) return null;
      if (inSpace.length > 1) {
        return `${inSpace.length} approvals are open here; answer with the code, e.g. "yes ${inSpace[0]?.[0]}".`;
      }
      entry = inSpace[0];
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
      ...(approved ? { reason: "approved from Google Chat" } : {}),
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

  private async postPrompt(request: ApprovalRequest, space: string, thread?: string): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    for (const [code, p] of this.pending) {
      if (now - p.postedAt > PENDING_TTL_MS) this.pending.delete(code);
    }
    const alwaysLabel =
      this.deps.approvals.canGrantAlways?.(request) === true ? describeAlwaysRule(request) : undefined;
    const code = this.freshCode();
    this.pending.set(code, {
      approvalId: request.approvalId,
      space,
      postedAt: now,
      ...(alwaysLabel !== undefined ? { alwaysLabel } : {}),
    });
    await this.deps.post(space, formatGoogleChatPrompt(request, code, alwaysLabel), thread);
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

export function formatGoogleChatPrompt(
  request: ApprovalRequest,
  code: string,
  alwaysLabel?: string,
): string {
  const lines = [`*Approval needed:* ${request.tool} (${request.category})`, request.reason];
  if (request.preview) {
    lines.push("", "```", request.preview.slice(0, 1500).replace(/```/g, "'''"), "```", "");
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
