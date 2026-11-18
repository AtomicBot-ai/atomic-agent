/**
 * Approvals for WhatsApp-originated turns, as text (ATO-502).
 *
 * WhatsApp Web has no buttons a bot can rely on, so the prompt carries a
 * short code and an owner answers `yes <code>` / `no <code>` (and
 * `always <code>` when the gate can save a rule), the same scheme as the
 * Signal channel. The code keeps a stray "yes" from approving anything
 * and tells two prompts apart; the owner check runs before a reply ever
 * reaches this bridge. An answer only counts in the chat the prompt was
 * posted to.
 */

import { randomInt } from "node:crypto";

import type { ApprovalGate, ApprovalRequest } from "../../approval/approval-gate.js";
import { describeAlwaysRule } from "../../approval/approval-rules.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import { normalizeWhatsAppId, scrubWhatsAppError } from "./whatsapp-types.js";

/** No 0/O, 1/I/L: the code is typed on a phone keyboard. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 4;
const PREVIEW_MAX_CHARS = 900;

const REPLY_RE = /^\s*(yes|y|approve|no|n|deny|always)\s+([a-z0-9]{4})\s*[.!]?\s*$/i;

export interface WhatsAppApprovalBridgeDeps {
  send: (chatJid: string, text: string) => Promise<void>;
  approvals: Pick<ApprovalGate, "resolve"> & Partial<Pick<ApprovalGate, "canGrantAlways">>;
  logger: StructuredLogger;
  /** Test seam for the code generator. */
  randomCode?: () => string;
}

interface Pending {
  approvalId: string;
  chatJid: string;
  alwaysLabel?: string;
}

export class WhatsAppApprovalBridge {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: WhatsAppApprovalBridgeDeps) {}

  /** Handler for `ApprovalRouter.setForSession`; synchronous by contract. */
  handlerFor(chatJid: string): (request: ApprovalRequest) => void {
    return (request) => {
      const code = this.freshCode();
      const alwaysLabel =
        this.deps.approvals.canGrantAlways?.(request) === true
          ? describeAlwaysRule(request)
          : undefined;
      this.pending.set(code, {
        approvalId: request.approvalId,
        chatJid,
        ...(alwaysLabel !== undefined ? { alwaysLabel } : {}),
      });
      void this.deps.send(chatJid, formatWhatsAppPrompt(request, code, alwaysLabel)).catch((err) => {
        this.deps.logger.warn("whatsapp: failed to post approval prompt", {
          error: scrubWhatsAppError(err),
        });
      });
    };
  }

  /**
   * Try to read `text` (sent in `chatJid`) as an approval answer. Returns
   * the reply to send back, or `null` when the text is not an answer.
   * Callers pass only owner messages.
   */
  tryAnswer(text: string, chatJid: string): string | null {
    const match = REPLY_RE.exec(text);
    if (!match) return null;
    const verb = (match[1] ?? "").toLowerCase();
    const code = (match[2] ?? "").toUpperCase();
    const posted = this.pending.get(code);
    if (!posted || normalizeWhatsAppId(posted.chatJid) !== normalizeWhatsAppId(chatJid)) {
      return `No pending approval with code ${code} in this chat. It may have expired or been answered elsewhere.`;
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
      ...(approved ? { reason: "approved from WhatsApp" } : {}),
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
    return randomCode();
  }
}

function randomCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** Plain text: the agent does not rely on WhatsApp's own markup. */
export function formatWhatsAppPrompt(
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
