/**
 * Approvals over iMessage, answered by text.
 *
 * iMessage has no buttons an outside program can attach, so a prompt
 * carries a short code and the owner replies `yes <code>` or
 * `no <code>`. The code (four digits, unique among open prompts) is
 * what makes a reply unambiguous: a bare "yes" could just as well be
 * the owner answering a question the agent asked in its reply, and
 * must never approve a shell command.
 *
 * Only replies from an owner handle reach `handleReply`; the inbound
 * handler drops everyone else first. The bridge never decides anything
 * itself, and a code that is unknown or already settled is answered as
 * such rather than silently ignored.
 */

import { randomInt } from "node:crypto";

import type { ApprovalGate, ApprovalRequest } from "../../approval/approval-gate.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { scrubImessageError } from "./imsg-errors.js";
import type { ImessageTarget } from "./imsg-send.js";

/** `yes 4821`, `no 4821`, `Yes, 4821`: verb, optional comma, code. Nothing else on the line. */
const REPLY_RE = /^\s*(yes|y|approve|no|n|deny)[\s,:]+(\d{4})\s*[.!]?\s*$/i;

/** Longest preview a prompt quotes; the rest is cut with a marker. */
const PREVIEW_MAX_CHARS = 900;

export interface ImessageApprovalBridgeDeps {
  approvals: Pick<ApprovalGate, "resolve">;
  logger: StructuredLogger;
  send: (target: ImessageTarget, text: string) => Promise<void>;
  /** Test seam for code generation. */
  randomCode?: () => string;
}

interface Pending {
  approvalId: string;
  /** chat.db chat rowid the prompt was posted to; replies count only there. */
  chatId: number;
}

export class ImessageApprovalBridge {
  /** `code -> pending prompt`. */
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: ImessageApprovalBridgeDeps) {}

  /**
   * Handler for `ApprovalRouter.setForSession`. Synchronous by contract
   * (the router never awaits), so the send is fired off here.
   */
  handlerFor(chatId: number, target: ImessageTarget): (request: ApprovalRequest) => void {
    return (request) => {
      const code = this.allocateCode();
      this.pending.set(code, { approvalId: request.approvalId, chatId });
      void this.deps.send(target, formatApprovalPrompt(request, code)).catch((err) => {
        this.deps.logger.warn("imessage: failed to post approval prompt", {
          error: scrubImessageError(err),
        });
      });
    };
  }

  /**
   * Try `text` as an approval reply from an owner in `chatId`. Returns
   * the confirmation to send back, or `null` when the text is not an
   * approval reply (the caller then treats it as a normal message).
   */
  handleReply(chatId: number, text: string): string | null {
    const match = REPLY_RE.exec(text);
    if (!match) return null;
    const verb = (match[1] ?? "").toLowerCase();
    const code = match[2] ?? "";
    const entry = this.pending.get(code);
    // A code from another chat is treated as unknown: in a group the
    // prompt was not shown here, so the reply cannot be informed.
    if (!entry || entry.chatId !== chatId) {
      return `No open approval with code ${code}. It may have expired or been answered elsewhere.`;
    }
    this.pending.delete(code);
    const approved = verb === "yes" || verb === "y" || verb === "approve";
    const settled = this.deps.approvals.resolve({
      approvalId: entry.approvalId,
      approved,
      ...(approved ? { reason: "approved from iMessage" } : {}),
    });
    if (!settled) return "This request already expired or was answered elsewhere.";
    return approved ? `Approved (${code}).` : `Denied (${code}).`;
  }

  /** Drop every open prompt (channel stopping). */
  clear(): void {
    this.pending.clear();
  }

  /** Number of open prompts. Diagnostic and tests. */
  size(): number {
    return this.pending.size;
  }

  private allocateCode(): string {
    const next = this.deps.randomCode ?? (() => String(randomInt(1000, 10_000)));
    // 9000 codes and at most a handful open at once: a clash is rare
    // and a retry loop is bounded in practice. The cap keeps it bounded
    // in theory too; a repeated code just replaces the older prompt.
    for (let i = 0; i < 50; i += 1) {
      const code = next();
      if (!this.pending.has(code)) return code;
    }
    return next();
  }
}

/** Plain text: Messages shows Markdown characters literally. */
export function formatApprovalPrompt(request: ApprovalRequest, code: string): string {
  const lines = [`Approval needed: ${request.tool} (${request.category})`];
  if (request.reason) lines.push(request.reason);
  if (request.preview) {
    const preview =
      request.preview.length > PREVIEW_MAX_CHARS
        ? `${request.preview.slice(0, PREVIEW_MAX_CHARS)}\n… (preview cut)`
        : request.preview;
    lines.push("", preview);
  }
  if (request.affectedResources?.length) {
    lines.push("", `Affects: ${request.affectedResources.slice(0, 5).join(", ")}`);
  }
  lines.push("", `Reply "yes ${code}" to approve or "no ${code}" to deny.`);
  return lines.join("\n");
}
