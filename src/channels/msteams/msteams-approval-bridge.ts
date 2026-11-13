/**
 * Route approval requests raised by a Teams-originated turn back into
 * the conversation that asked, as an Adaptive Card with Approve / Deny
 * (and "Allow always" when offered).
 *
 * A click arrives as a `message` activity whose `value` is the button's
 * `Action.Submit` data (`atomicApproval`, `verdict`). Typing
 * `yes <code>` / `no <code>` / `always <code>` works too, for clients
 * that do not render cards; a bare `yes` counts only when exactly one
 * prompt is open in that conversation.
 *
 * The bridge never decides anything on its own: only a configured
 * owner, in the conversation the card was posted to, settles the gate.
 * After a decision the card is replaced (PUT activity) so the buttons
 * disappear and the thread shows what was decided.
 */

import { randomBytes } from "node:crypto";

import type { ApprovalGate, ApprovalRequest } from "../../approval/approval-gate.js";
import { describeAlwaysRule } from "../../approval/approval-rules.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { TeamsApi } from "./msteams-api.js";
import { scrubTeamsError, type TeamsTarget } from "./msteams-types.js";

const PREVIEW_MAX_CHARS = 2500;
const PENDING_TTL_MS = 6 * 60 * 60_000;
const ANSWER_RE = /^\s*(yes|y|approve|no|n|deny|always)(?:\s+([0-9a-f]{6,12}))?\s*[.!]?\s*$/i;

export interface TeamsApprovalBridgeDeps {
  api: Pick<TeamsApi, "sendActivity" | "updateActivity">;
  approvals: Pick<ApprovalGate, "resolve"> & Partial<Pick<ApprovalGate, "canGrantAlways">>;
  logger: Pick<StructuredLogger, "warn">;
  /** AAD object ids permitted to decide. Read on every answer. */
  ownerIds: () => readonly string[];
  makeCode?: () => string;
  now?: () => number;
}

interface Pending {
  approvalId: string;
  target: TeamsTarget;
  activityId: string | null;
  headline: string;
  alwaysLabel?: string;
  postedAt: number;
}

/** The conversation without Teams' `;messageid=` thread suffix. */
export function conversationRoot(conversationId: string): string {
  return conversationId.split(";")[0] ?? conversationId;
}

export class TeamsApprovalBridge {
  /** `code -> prompt`. */
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: TeamsApprovalBridgeDeps) {}

  /** Handler for `ApprovalRouter.setForSession`; synchronous by contract. */
  handlerFor(target: TeamsTarget): (request: ApprovalRequest) => void {
    return (request) => {
      void this.post(request, target).catch((err) => {
        this.deps.logger.warn("msteams: failed to post approval card", { error: scrubTeamsError(err) });
      });
    };
  }

  /**
   * A card button click (`activity.value`). Returns the text to post back
   * when the value was one of our cards and the sender may answer, `""`
   * when it was ours but refused (non-owner), `null` when it is not ours.
   */
  async handleSubmit(value: unknown, senderId: string | undefined, conversationId: string): Promise<string | null> {
    if (value === null || typeof value !== "object") return null;
    const data = value as { atomicApproval?: unknown; verdict?: unknown };
    if (typeof data.atomicApproval !== "string" || typeof data.verdict !== "string") return null;
    if (senderId === undefined || !this.deps.ownerIds().includes(senderId)) {
      // Anyone in a team can press a button. Only an owner decides.
      this.deps.logger.warn("msteams: ignoring approval click from non-owner", { senderId });
      return "";
    }
    const entry = [...this.pending.entries()].find(
      ([, p]) =>
        p.approvalId === data.atomicApproval &&
        conversationRoot(p.target.conversationId) === conversationRoot(conversationId),
    );
    if (!entry) return "This request already expired or was answered elsewhere.";
    return this.settle(entry, String(data.verdict).toLowerCase());
  }

  /** A typed `yes <code>`. `null` when the text is not an answer (or the sender is not an owner). */
  async tryAnswer(conversationId: string, senderId: string | undefined, text: string): Promise<string | null> {
    const match = ANSWER_RE.exec(text);
    if (!match) return null;
    if (senderId === undefined || !this.deps.ownerIds().includes(senderId)) return null;
    const verb = (match[1] ?? "").toLowerCase();
    const code = match[2]?.toLowerCase();
    const root = conversationRoot(conversationId);
    const here = [...this.pending.entries()].filter(([, p]) => conversationRoot(p.target.conversationId) === root);
    if (here.length === 0) return null;
    let entry: [string, Pending] | undefined;
    if (code !== undefined) {
      entry = here.find(([c]) => c === code);
      if (!entry) return "That approval code is unknown here or was already answered.";
    } else {
      if (here.length > 1) {
        return `${here.length} approvals are open here; answer with the code, e.g. "yes ${here[0]?.[0]}".`;
      }
      entry = here[0];
    }
    if (!entry) return null;
    const normalized = verb === "always" ? "always" : verb.startsWith("y") || verb === "approve" ? "yes" : "no";
    return this.settle(entry, normalized);
  }

  /** Open prompts in this conversation (for `/status`). */
  pendingIn(conversationId: string): number {
    const root = conversationRoot(conversationId);
    return [...this.pending.values()].filter((p) => conversationRoot(p.target.conversationId) === root).length;
  }

  /** Drop outstanding prompts (channel stopping). */
  clear(): void {
    this.pending.clear();
  }

  private async settle([code, posted]: [string, Pending], verdict: string): Promise<string> {
    const always = verdict === "always";
    if (always && posted.alwaysLabel === undefined) {
      // A forged submit cannot save a rule the card never offered.
      return "\"Allow always\" was not offered for this request; answer yes or no.";
    }
    const approved = always || verdict === "yes";
    this.pending.delete(code);
    const settled = this.deps.approvals.resolve({
      approvalId: posted.approvalId,
      approved,
      ...(approved ? { reason: "approved from Microsoft Teams" } : {}),
      ...(always ? { grant: "always" as const } : {}),
    });
    const outcome = !settled
      ? "This request already expired or was answered elsewhere."
      : always
        ? `Approved. Saved: ${posted.alwaysLabel}.`
        : approved
          ? "Approved."
          : "Denied.";
    if (posted.activityId !== null) {
      try {
        await this.deps.api.updateActivity(posted.target, posted.activityId, cardActivity(answeredCard(posted.headline, outcome)));
      } catch (err) {
        this.deps.logger.warn("msteams: could not update the approval card", { error: scrubTeamsError(err) });
      }
    }
    return outcome;
  }

  private async post(request: ApprovalRequest, target: TeamsTarget): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    for (const [c, p] of this.pending) {
      if (now - p.postedAt > PENDING_TTL_MS) this.pending.delete(c);
    }
    const alwaysLabel =
      this.deps.approvals.canGrantAlways?.(request) === true ? describeAlwaysRule(request) : undefined;
    const code = this.freshCode();
    const headline = `Approval needed: ${request.tool} (${request.category})`;
    const entry: Pending = {
      approvalId: request.approvalId,
      target,
      activityId: null,
      headline,
      postedAt: now,
      ...(alwaysLabel !== undefined ? { alwaysLabel } : {}),
    };
    this.pending.set(code, entry);
    try {
      entry.activityId = await this.deps.api.sendActivity(
        target,
        cardActivity(approvalCard(request, headline, code, alwaysLabel)),
      );
    } catch (err) {
      // Nobody saw the code; do not leave an answerable prompt behind.
      this.pending.delete(code);
      throw err;
    }
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

function text(value: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "TextBlock", text: value, wrap: true, ...extra };
}

function submit(title: string, approvalId: string, verdict: string, style?: string): Record<string, unknown> {
  return { type: "Action.Submit", title, data: { atomicApproval: approvalId, verdict }, ...(style ? { style } : {}) };
}

/** The prompt card: headline, reason, preview, Approve / Deny (+ Allow always), typed fallback. */
export function approvalCard(
  request: ApprovalRequest,
  headline: string,
  code: string,
  alwaysLabel?: string,
): Record<string, unknown> {
  const body: Array<Record<string, unknown>> = [text(headline, { weight: "Bolder" }), text(request.reason)];
  if (request.preview) {
    body.push(text(request.preview.slice(0, PREVIEW_MAX_CHARS), { fontType: "Monospace" }));
  }
  if (request.affectedResources?.length) {
    body.push(text(`Affects: ${request.affectedResources.slice(0, 5).join(", ")}`, { isSubtle: true }));
  }
  body.push(text(`Or reply "yes ${code}" / "no ${code}".`, { isSubtle: true, size: "Small" }));
  const id = request.approvalId;
  const actions = [submit("Approve", id, "yes", "positive"), submit("Deny", id, "no", "destructive")];
  if (alwaysLabel !== undefined) actions.push(submit(alwaysLabel.slice(0, 80), id, "always"));
  return { type: "AdaptiveCard", $schema: "http://adaptivecards.io/schemas/adaptive-card.json", version: "1.4", body, actions };
}

function answeredCard(headline: string, outcome: string): Record<string, unknown> {
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
    body: [text(headline, { weight: "Bolder" }), text(outcome)],
  };
}

function cardActivity(card: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "message",
    attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }],
  };
}
