/**
 * Approvals for Linear-originated turns, as comments (ATO-2324).
 *
 * Linear comments have no buttons, so the prompt is a comment in the
 * issue thread carrying a short code, and an owner answers with a
 * comment `yes <code>` / `no <code>` (and `always <code>` when the gate
 * can save a rule). This is how "change the issue status only after
 * confirmation" holds: a status change is a tool call, the gate asks,
 * and nothing runs until the owner says yes. Copied from the Signal
 * bridge (ATO-629): the code keeps a stray "yes" from approving anything
 * and tells two prompts apart. It is not a secret; the owner check runs
 * before a reply reaches this bridge.
 */

import { randomInt } from "node:crypto";

import type { ApprovalGate, ApprovalRequest } from "../../approval/approval-gate.js";
import { describeAlwaysRule } from "../../approval/approval-rules.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { scrubLinearError, type LinearTarget } from "./linear-types.js";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;
const PREVIEW_MAX_CHARS = 1500;

const REPLY_RE = /^\s*(yes|y|approve|no|n|deny|always)\s+`?([a-z0-9]{4})`?\s*[.!]?\s*$/i;

export interface LinearApprovalBridgeDeps {
  post: (target: LinearTarget, body: string) => Promise<void>;
  approvals: Pick<ApprovalGate, "resolve"> & Partial<Pick<ApprovalGate, "canGrantAlways">>;
  logger: StructuredLogger;
  /** Test seam for the code generator. */
  randomCode?: () => string;
}

interface Pending {
  approvalId: string;
  issueId: string;
  alwaysLabel?: string;
}

export class LinearApprovalBridge {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: LinearApprovalBridgeDeps) {}

  /** Handler for `ApprovalRouter.setForSession`; synchronous by contract. */
  handlerFor(target: LinearTarget): (request: ApprovalRequest) => void {
    return (request) => {
      const code = this.freshCode();
      const alwaysLabel =
        this.deps.approvals.canGrantAlways?.(request) === true ? describeAlwaysRule(request) : undefined;
      this.pending.set(code, {
        approvalId: request.approvalId,
        issueId: target.issueId,
        ...(alwaysLabel !== undefined ? { alwaysLabel } : {}),
      });
      void this.deps.post(target, formatLinearPrompt(request, code, alwaysLabel)).catch((err) => {
        this.deps.logger.warn("linear: failed to post approval prompt", { error: scrubLinearError(err) });
      });
    };
  }

  /**
   * Read `text` as an approval answer on `issueId`. Returns the reply to
   * post, or `null` when the text is not an answer. Callers pass only
   * owner comments. A code from another issue is not accepted here.
   */
  tryAnswer(issueId: string, text: string): string | null {
    const match = REPLY_RE.exec(text);
    if (!match) return null;
    const verb = (match[1] ?? "").toLowerCase();
    const code = (match[2] ?? "").toUpperCase();
    const posted = this.pending.get(code);
    if (!posted || posted.issueId !== issueId) {
      return `No pending approval with code ${code} on this issue. It may have expired or been answered elsewhere.`;
    }
    const always = verb === "always";
    if (always && posted.alwaysLabel === undefined) {
      return `"always" is not offered for ${code}. Reply yes ${code} or no ${code}.`;
    }
    const approved = always || verb === "yes" || verb === "y" || verb === "approve";
    this.pending.delete(code);
    const settled = this.deps.approvals.resolve({
      approvalId: posted.approvalId,
      approved,
      ...(approved ? { reason: "approved from Linear" } : {}),
      ...(always ? { grant: "always" as const } : {}),
    });
    if (!settled) return "This request already expired or was answered elsewhere.";
    if (always) return `Approved. Saved: ${posted.alwaysLabel}.`;
    return approved ? "Approved." : "Denied.";
  }

  /** Prompts still waiting on `issueId`. */
  pendingIn(issueId: string): number {
    let n = 0;
    for (const p of this.pending.values()) if (p.issueId === issueId) n++;
    return n;
  }

  /** Forget outstanding prompts (channel stopping). */
  clear(): void {
    this.pending.clear();
  }

  private freshCode(): string {
    for (let i = 0; i < 20; i++) {
      const code = this.deps.randomCode?.() ?? randomCode();
      if (!this.pending.has(code)) return code;
    }
    return randomCode();
  }
}

function randomCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** Markdown: Linear renders it. */
export function formatLinearPrompt(request: ApprovalRequest, code: string, alwaysLabel?: string): string {
  const lines = [`**Approval needed:** \`${request.tool}\` (${request.category})`, request.reason];
  if (request.preview) {
    const preview = request.preview.slice(0, PREVIEW_MAX_CHARS).replace(/```/g, "'''");
    lines.push("", "```", preview, "```");
    if (request.preview.length > PREVIEW_MAX_CHARS) lines.push("(preview cut)");
  }
  if (request.affectedResources?.length) {
    lines.push(`Affects: ${request.affectedResources.slice(0, 5).join(", ")}`);
  }
  lines.push("", `Reply \`yes ${code}\` to approve or \`no ${code}\` to deny.`);
  if (alwaysLabel !== undefined) lines.push(`Reply \`always ${code}\` to allow and save: ${alwaysLabel}.`);
  return lines.join("\n");
}
