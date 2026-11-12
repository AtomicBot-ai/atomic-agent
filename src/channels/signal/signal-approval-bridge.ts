/**
 * Approvals for Signal-originated turns, as text (ATO-629).
 *
 * Signal has no buttons, so the prompt carries a short code and an
 * owner answers `yes <code>` / `no <code>` (and `always <code>` when the
 * gate can save a rule). The code exists so a stray "yes" in the chat
 * can never approve anything, and so two prompts in flight are told
 * apart. It is not a secret: the gate is protected by the owner check,
 * which runs before a reply ever reaches this bridge.
 */

import { randomInt } from "node:crypto";

import type { ApprovalGate, ApprovalRequest } from "../../approval/approval-gate.js";
import { describeAlwaysRule } from "../../approval/approval-rules.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { SignalTarget } from "./signal-rpc.js";
import { scrubSignalError } from "./signal-types.js";

/** No 0/O, 1/I/L: the code is typed on a phone keyboard. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;
const PREVIEW_MAX_CHARS = 900;

const REPLY_RE = /^\s*(yes|y|approve|no|n|deny|always)\s+([a-z0-9]{4})\s*[.!]?\s*$/i;

export interface SignalApprovalBridgeDeps {
  send: (target: SignalTarget, text: string) => Promise<void>;
  approvals: Pick<ApprovalGate, "resolve"> & Partial<Pick<ApprovalGate, "canGrantAlways">>;
  logger: StructuredLogger;
  /** Test seam for the code generator. */
  randomCode?: () => string;
}

interface Pending {
  approvalId: string;
  target: SignalTarget;
  alwaysLabel?: string;
}

export class SignalApprovalBridge {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: SignalApprovalBridgeDeps) {}

  /** Handler for `ApprovalRouter.setForSession`; synchronous by contract. */
  handlerFor(target: SignalTarget): (request: ApprovalRequest) => void {
    return (request) => {
      const code = this.freshCode();
      const alwaysLabel =
        this.deps.approvals.canGrantAlways?.(request) === true
          ? describeAlwaysRule(request)
          : undefined;
      this.pending.set(code, {
        approvalId: request.approvalId,
        target,
        ...(alwaysLabel !== undefined ? { alwaysLabel } : {}),
      });
      void this.deps.send(target, formatSignalPrompt(request, code, alwaysLabel)).catch((err) => {
        this.deps.logger.warn("signal: failed to post approval prompt", {
          error: scrubSignalError(err),
        });
      });
    };
  }

  /**
   * Try to read `text` as an approval answer. Returns the reply to send
   * back, or `null` when the text is not an answer (route it as a normal
   * message). Callers pass only owner messages.
   */
  tryAnswer(text: string): string | null {
    const match = REPLY_RE.exec(text);
    if (!match) return null;
    const verb = (match[1] ?? "").toLowerCase();
    const code = (match[2] ?? "").toUpperCase();
    const posted = this.pending.get(code);
    if (!posted) {
      return `No pending approval with code ${code}. It may have expired or been answered elsewhere.`;
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
      ...(approved ? { reason: "approved from Signal" } : {}),
      ...(always ? { grant: "always" as const } : {}),
    });
    if (!settled) return "This request already expired or was answered elsewhere.";
    if (always) return `Approved. Saved: ${posted.alwaysLabel}.`;
    return approved ? "Approved." : "Denied.";
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
    // 31^4 codes; twenty collisions in a row means the seam is constant.
    return `${randomCode()}`;
  }
}

function randomCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** Plain text: Signal renders no markdown. */
export function formatSignalPrompt(
  request: ApprovalRequest,
  code: string,
  alwaysLabel?: string,
): string {
  const lines = [`Approval needed: ${request.tool} (${request.category})`, request.reason];
  if (request.preview) {
    const preview = request.preview.slice(0, PREVIEW_MAX_CHARS);
    lines.push("", preview, request.preview.length > PREVIEW_MAX_CHARS ? "(preview cut)" : "");
  }
  if (request.affectedResources?.length) {
    lines.push(`Affects: ${request.affectedResources.slice(0, 5).join(", ")}`);
  }
  lines.push("", `Reply "yes ${code}" to approve or "no ${code}" to deny.`);
  if (alwaysLabel !== undefined) lines.push(`Reply "always ${code}" to allow and save: ${alwaysLabel}.`);
  return lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n");
}
