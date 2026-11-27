/**
 * Route approval requests raised by a Slack-originated turn back into
 * the Slack thread that asked, as a Block Kit prompt with buttons.
 *
 * Without this, `ApprovalRouter` falls through to the host handler (the
 * TUI dialog) and a turn driven from a phone blocks on a prompt nobody
 * sees. The bridge never decides anything itself: only a click by a
 * configured owner resolves the gate; anyone else in the channel gets
 * an ephemeral "not yours" and the request stays open.
 *
 * After a decision the prompt is rewritten with `chat.update` so the
 * buttons disappear and the thread shows what was decided.
 */

import type { ApprovalGate, ApprovalRequest } from "../../approval/approval-gate.js";
import { describeAlwaysRule } from "../../approval/approval-rules.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import {
  sessionGrantLabels,
  sessionGrantOffer,
  sessionGrantScope,
  sessionGrantSummary,
  type SessionGrantOffer,
} from "../approval-session-grants.js";
import type { SlackApi } from "./slack-api.js";
import { escapeSlackText } from "./slack-format.js";
import { scrubSlackError, type SlackBlockActionsPayload, type SlackTarget } from "./slack-types.js";

/** Prefix on every `action_id` this bridge owns: `atomic_approve:<verb>:<approvalId>`. */
export const ACTION_ID_PREFIX = "atomic_approve:";

/** Slack caps a button's text at 75 characters. */
const BUTTON_TEXT_MAX_CHARS = 75;
/** Preview cap inside the prompt's section block (3000 max per block). */
const PREVIEW_MAX_CHARS = 2500;

export interface SlackApprovalBridgeDeps {
  api: Pick<SlackApi, "postMessage" | "updateMessage" | "postEphemeral">;
  approvals: Pick<ApprovalGate, "resolve"> & Partial<Pick<ApprovalGate, "canGrantAlways">>;
  logger: StructuredLogger;
  /** Slack member ids allowed to decide. Read on every click. */
  ownerIds: () => readonly string[];
}

interface Pending {
  target: SlackTarget;
  ts: string | null;
  headline: string;
  alwaysLabel?: string;
  /** The session grants whose buttons were posted (ATO-2509). */
  sessionGrants?: SessionGrantOffer;
}

export class SlackApprovalBridge {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: SlackApprovalBridgeDeps) {}

  /** Handler for `ApprovalRouter.setForSession`; synchronous by contract. */
  handlerFor(target: SlackTarget): (request: ApprovalRequest) => void {
    return (request) => {
      void this.post(request, target).catch((err) => {
        this.deps.logger.warn("slack: failed to post approval prompt", {
          error: scrubSlackError(err),
        });
      });
    };
  }

  private async post(request: ApprovalRequest, target: SlackTarget): Promise<void> {
    const alwaysLabel =
      this.deps.approvals.canGrantAlways?.(request) === true
        ? describeAlwaysRule(request)
        : undefined;
    // The same "this session" grants Telegram and the TUI offer (ATO-2509).
    const sessionGrants = request.question ? null : sessionGrantOffer(request);
    const headline = `Approval needed: \`${escapeSlackText(request.tool)}\` (${request.category})`;
    const ts = await this.deps.api.postMessage(
      target,
      headline,
      approvalBlocks(request, headline, alwaysLabel, sessionGrants),
    );
    this.pending.set(request.approvalId, {
      target,
      ts,
      headline,
      ...(alwaysLabel !== undefined ? { alwaysLabel } : {}),
      ...(sessionGrants !== null ? { sessionGrants } : {}),
    });
  }

  /**
   * Handle one `block_actions` payload. Returns `true` when the click
   * was on one of this bridge's buttons.
   */
  async handleBlockActions(payload: SlackBlockActionsPayload): Promise<boolean> {
    const action = payload.actions?.find(
      (a) => typeof a.action_id === "string" && a.action_id.startsWith(ACTION_ID_PREFIX),
    );
    if (!action?.action_id) return false;
    const [, verb, approvalId = ""] = action.action_id.split(":");
    const actorId = payload.user?.id;
    const channel = payload.container?.channel_id ?? payload.channel?.id;
    const messageTs = payload.container?.message_ts ?? payload.message?.ts;
    const threadTs = payload.container?.thread_ts ?? payload.message?.thread_ts;
    if (actorId === undefined || !this.deps.ownerIds().includes(actorId)) {
      // Anyone in a shared channel can click a button. Only an owner may
      // decide whether a destructive tool runs.
      this.deps.logger.warn("slack: ignoring approval click from non-owner", { actorId });
      if (actorId !== undefined && channel !== undefined) {
        await this.quietly(() =>
          this.deps.api.postEphemeral(
            { channel, ...(threadTs ? { threadTs } : {}) },
            actorId,
            "Only a paired operator can answer this.",
          ),
        );
      }
      return true;
    }
    const posted = this.pending.get(approvalId);
    // "Allow always" counts only where this bridge offered it: a forged
    // action_id cannot save a rule the prompt never showed.
    const always = verb === "always" && posted?.alwaysLabel !== undefined;
    // A session grant likewise counts only where its button was posted.
    const grantKind = verb === "session" ? "s" : verb === "shape" ? "a" : null;
    const sessionGrant =
      grantKind === null ? null : sessionGrantScope(grantKind, posted?.sessionGrants);
    const forged = (verb === "always" && !always) || (grantKind !== null && sessionGrant === null);
    if (forged && posted !== undefined) {
      // A choice this prompt never offered (ATO-2778): ignore it. The
      // request is still open, so its message and buttons stay as they
      // are and Approve / Deny still work.
      this.deps.logger.warn("slack: ignoring an approval choice the prompt did not offer", { verb });
      return true;
    }
    const approved = verb === "yes" || always || sessionGrant !== null;
    const settled = forged
      ? false
      : this.deps.approvals.resolve({
          approvalId,
          approved,
          ...(approved ? { reason: "approved from Slack" } : {}),
          ...(always ? { grant: "always" as const } : {}),
          ...(sessionGrant !== null ? { grant: sessionGrant } : {}),
        });
    this.pending.delete(approvalId);
    const outcome = !settled
      ? "This request already expired or was answered elsewhere."
      : always
        ? `Approved by <@${actorId}>. Saved: ${escapeSlackText(posted?.alwaysLabel ?? "")}.`
        : sessionGrant !== null && posted?.sessionGrants
          ? `Approved by <@${actorId}> for this session: ${escapeSlackText(sessionGrantSummary(sessionGrant, posted.sessionGrants))}.`
          : approved
            ? `Approved by <@${actorId}>.`
            : `Denied by <@${actorId}>.`;
    if (channel !== undefined && messageTs !== undefined) {
      const headline = posted?.headline ?? "Approval";
      await this.quietly(() =>
        this.deps.api.updateMessage(channel, messageTs, `${headline}: ${outcome}`, [
          section(`${headline}\n${outcome}`),
        ]),
      );
    }
    return true;
  }

  /** Drop outstanding prompts (channel stopping). */
  clear(): void {
    this.pending.clear();
  }

  private async quietly(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.deps.logger.warn("slack: approval follow-up failed", { error: scrubSlackError(err) });
    }
  }
}

function section(text: string): Record<string, unknown> {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function button(text: string, actionId: string, approvalId: string, style?: string) {
  return {
    type: "button",
    text: {
      type: "plain_text",
      text: text.length <= BUTTON_TEXT_MAX_CHARS ? text : `${text.slice(0, BUTTON_TEXT_MAX_CHARS - 1)}…`,
    },
    action_id: actionId,
    value: approvalId,
    ...(style ? { style } : {}),
  };
}

/**
 * The prompt: headline, reason, fenced preview, Approve / Deny, then the
 * offered session grants with Telegram's labels (`session` for the kind,
 * `shape` for the command shape; ATO-2509), then Allow always.
 */
export function approvalBlocks(
  request: ApprovalRequest,
  headline: string,
  alwaysLabel?: string,
  sessionGrants: SessionGrantOffer | null = null,
): Array<Record<string, unknown>> {
  const lines = [`*${headline}*`, escapeSlackText(request.reason)];
  if (request.preview) {
    const preview = request.preview.slice(0, PREVIEW_MAX_CHARS).replace(/```/g, "`​``");
    lines.push("```", escapeSlackText(preview), "```");
  }
  if (request.affectedResources?.length) {
    lines.push(`Affects: ${escapeSlackText(request.affectedResources.slice(0, 5).join(", "))}`);
  }
  const id = request.approvalId;
  const elements = [
    button("Approve", `${ACTION_ID_PREFIX}yes:${id}`, id, "danger"),
    button("Deny", `${ACTION_ID_PREFIX}no:${id}`, id),
  ];
  const grants = sessionGrantLabels(sessionGrants);
  if (grants.category !== undefined) {
    elements.push(button(grants.category, `${ACTION_ID_PREFIX}session:${id}`, id));
  }
  if (grants.shape !== undefined) {
    elements.push(button(grants.shape, `${ACTION_ID_PREFIX}shape:${id}`, id));
  }
  if (alwaysLabel !== undefined) {
    elements.push(button(alwaysLabel, `${ACTION_ID_PREFIX}always:${id}`, id, "primary"));
  }
  return [section(lines.join("\n")), { type: "actions", elements }];
}
