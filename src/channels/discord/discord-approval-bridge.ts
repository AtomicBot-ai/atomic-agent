/**
 * Route approval requests raised by a Discord-originated turn back into
 * the Discord channel as a two-button prompt.
 *
 * Without this, `ApprovalRouter` falls through to the host handler —
 * the TUI dialog on the operator's machine. A turn driven from a phone
 * would then block on a prompt nobody is looking at until it times out.
 * The requester has to see the question, so the bridge posts it where
 * the turn came from.
 *
 * The bridge never approves anything on its own: every decision comes
 * from a button press by the paired owner, and an interaction from any
 * other account is ignored.
 */

import type {
  ApprovalGate,
  ApprovalRequest,
} from "../../approval/approval-gate.js";
import { describeAlwaysRule } from "../../approval/approval-rules.js";
import type { StructuredLogger } from "../../tracing/structured-logger.js";
import type { DiscordApi, DiscordComponentRow } from "./discord-api.js";
import { scrubDiscordError } from "./discord-channel-types.js";

/** Discord button styles. */
const STYLE_DANGER = 4;
const STYLE_SECONDARY = 2;
const STYLE_PRIMARY = 1;

/** Discord caps a button label at 80 characters. */
const BUTTON_LABEL_MAX_CHARS = 80;

/** Prefix on every custom_id this bridge owns. */
const CUSTOM_ID_PREFIX = "atomic:approve:";

export interface DiscordInteractionEvent {
  id: string;
  token: string;
  channel_id?: string;
  data?: { custom_id?: string };
  /** Guild interactions carry `member.user`; DM interactions carry `user`. */
  member?: { user?: { id?: string } };
  user?: { id?: string };
}

export interface DiscordApprovalBridgeDeps {
  api: DiscordApi;
  /** Resolves decisions; `canGrantAlways` decides the third button (ATO-1142). */
  approvals: Pick<ApprovalGate, "resolve"> &
    Partial<Pick<ApprovalGate, "canGrantAlways">>;
  logger: StructuredLogger;
  /** Snowflakes permitted to decide. Interactions from anyone else drop. */
  ownerUserIds: () => readonly string[];
}

interface Pending {
  approvalId: string;
  channelId: string;
  messageId: string | null;
  /** The "Allow always" label, when that button was posted (ATO-1142). */
  alwaysLabel?: string;
}

export class DiscordApprovalBridge {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: DiscordApprovalBridgeDeps) {}

  /**
   * Handler to register with `ApprovalRouter.setForSession`. Synchronous
   * by contract — the router never awaits — so the post is fired off
   * and its failure handled inside.
   */
  handlerFor(channelId: string): (request: ApprovalRequest) => void {
    return (request) => {
      void this.post(request, channelId).catch((err) => {
        this.deps.logger.warn("discord: failed to post approval prompt", {
          error: scrubDiscordError(err),
        });
      });
    };
  }

  private async post(
    request: ApprovalRequest,
    channelId: string,
  ): Promise<void> {
    const alwaysLabel =
      this.deps.approvals.canGrantAlways?.(request) === true
        ? describeAlwaysRule(request)
        : undefined;
    const messageId = await this.deps.api.sendMessage(
      channelId,
      formatPrompt(request),
      buttonsFor(request.approvalId, alwaysLabel),
    );
    this.pending.set(request.approvalId, {
      approvalId: request.approvalId,
      channelId,
      messageId,
      ...(alwaysLabel !== undefined ? { alwaysLabel } : {}),
    });
  }

  /**
   * Handle an INTERACTION_CREATE. Returns `true` when the interaction
   * belonged to this bridge (so the caller stops routing it).
   */
  async handleInteraction(event: DiscordInteractionEvent): Promise<boolean> {
    const customId = event.data?.custom_id;
    if (
      typeof customId !== "string" ||
      !customId.startsWith(CUSTOM_ID_PREFIX)
    ) {
      return false;
    }
    const actorId = event.member?.user?.id ?? event.user?.id;
    const owners = this.deps.ownerUserIds();
    if (actorId === undefined || !owners.includes(actorId)) {
      // Anyone in a shared guild can click a button. Only a paired
      // operator may decide whether a destructive tool runs — and
      // every owner is equally one, which is the whole point of the
      // list: an approval must not stall because the person who set
      // the bot up is asleep.
      this.deps.logger.warn("discord: ignoring approval click from non-owner", {
        actorId,
      });
      await this.ack(event, "Only a paired operator can answer this.");
      return true;
    }

    const [, , verb, approvalId] = customId.split(":");
    const posted = this.pending.get(approvalId ?? "");
    // "Allow always" counts only where this bridge posted that button: a
    // crafted custom_id cannot save a rule the prompt never offered.
    const always = verb === "always" && posted?.alwaysLabel !== undefined;
    if (verb === "always" && !always) {
      await this.ack(event, "This request already expired or was answered elsewhere.");
      return true;
    }
    const approved = verb === "yes" || always;
    const settled = this.deps.approvals.resolve({
      approvalId: approvalId ?? "",
      approved,
      // A button carries no words of the user's, so a deny has no reason.
      ...(approved ? { reason: "approved from Discord" } : {}),
      ...(always ? { grant: "always" as const } : {}),
    });
    this.pending.delete(approvalId ?? "");
    await this.ack(
      event,
      settled
        ? always
          ? `✅ Approved. Saved: ${posted?.alwaysLabel}.`
          : approved
            ? "✅ Approved."
            : "🚫 Denied."
        : // The gate already settled -- timeout, cancel, or a decision
          // taken on another surface. Say so rather than implying the
          // click did something.
          "This request already expired or was answered elsewhere.",
    );
    return true;
  }

  /** Drop any prompts still outstanding (channel stopping). */
  clear(): void {
    this.pending.clear();
  }

  private async ack(
    event: DiscordInteractionEvent,
    text: string,
  ): Promise<void> {
    try {
      await this.deps.api.updateInteraction(event.id, event.token, text);
    } catch (err) {
      this.deps.logger.warn("discord: failed to acknowledge interaction", {
        error: scrubDiscordError(err),
      });
    }
  }
}

/**
 * Two buttons, plus "Allow always" when `alwaysLabel` is given; ids
 * namespaced so foreign components never match.
 */
export function buttonsFor(
  approvalId: string,
  alwaysLabel?: string,
): DiscordComponentRow[] {
  const components: Array<DiscordComponentRow["components"][number]> = [
    {
      type: 2,
      style: STYLE_DANGER,
      label: "Approve",
      custom_id: `${CUSTOM_ID_PREFIX}yes:${approvalId}`,
    },
    {
      type: 2,
      style: STYLE_SECONDARY,
      label: "Deny",
      custom_id: `${CUSTOM_ID_PREFIX}no:${approvalId}`,
    },
  ];
  if (alwaysLabel !== undefined) {
    components.push({
      type: 2,
      style: STYLE_PRIMARY,
      label:
        alwaysLabel.length <= BUTTON_LABEL_MAX_CHARS
          ? alwaysLabel
          : `${alwaysLabel.slice(0, BUTTON_LABEL_MAX_CHARS - 1)}…`,
      custom_id: `${CUSTOM_ID_PREFIX}always:${approvalId}`,
    });
  }
  return [{ type: 1, components }];
}

export function formatPrompt(request: ApprovalRequest): string {
  const lines = [
    `**Approval needed** — \`${request.tool}\` (${request.category})`,
    request.reason,
  ];
  if (request.preview) {
    // Fence the preview: a shell command full of backticks or
    // underscores would otherwise be mangled by Discord's markdown.
    const preview = request.preview.slice(0, 900).replace(/```/g, "``​`");
    lines.push("```", preview, "```");
  }
  if (request.affectedResources?.length) {
    lines.push(`Affects: ${request.affectedResources.slice(0, 5).join(", ")}`);
  }
  return lines.join("\n");
}
