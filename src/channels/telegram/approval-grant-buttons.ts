import type { ApprovalRequest } from "../../approval/index.js";
import {
  canGrantCategory,
  canGrantShape,
  describeCategoryGrant,
} from "../../approval/index.js";
import { describeMcpToolGrant } from "../../approval/approval-gate.js";
import { fitButtonText } from "./button-text.js";

/**
 * The session grants a Telegram approval prompt offers (GitHub #230):
 * the same `[s]` (this kind for the session) and `[a]` (this shell
 * command shape for the session) the TUI modal and the CLI prompt
 * offer, decided by the same `canGrantCategory` / `canGrantShape`, so
 * the three surfaces never disagree about what can be granted.
 *
 * Each field is the words of what the grant covers, or absent when the
 * request does not allow that grant. The bridge keeps this with the
 * pending prompt: an `s` or `a` callback counts only when its button
 * was sent, so a hand-made callback cannot grant what the prompt never
 * offered. The gate's own `recordGrant` checks the request again.
 */
export interface SessionGrantOffer {
  /** What `s` grants, e.g. `shell command` or `browser commit on example.com`. */
  category?: string;
  /** The command shape `a` grants, e.g. `git`. */
  shape?: string;
  /** A shell grant: dangerous commands still ask (ATO-1220). */
  shell: boolean;
}

/** Said after a shell grant, as the TUI does: risky commands still ask. */
const RISKY_STILL_ASK = " (risky commands still ask)";

/**
 * What this request may be granted for the session, in the TUI's words.
 * `null` when it allows neither grant (`trust_config`, a dangerous shell
 * command, e-mail, a browser request that names no single host, ...).
 */
export function sessionGrantOffer(
  request: ApprovalRequest,
): SessionGrantOffer | null {
  const category = canGrantCategory(request)
    ? (describeMcpToolGrant(request) ??
      `${describeCategoryGrant(request)}${request.grantKey !== undefined ? ` to ${request.grantKey}` : ""}`)
    : undefined;
  const shape =
    canGrantShape(request) && request.commandShape
      ? request.commandShape
      : undefined;
  if (category === undefined && shape === undefined) return null;
  return {
    ...(category !== undefined ? { category } : {}),
    ...(shape !== undefined ? { shape } : {}),
    shell: request.category === "shell",
  };
}

/**
 * One row per offered grant, under Approve / Deny and above "Allow
 * always": `appr:<id>:s` for the kind, `appr:<id>:a` for the shape.
 * With a UUID approval id that is 43 bytes, inside Telegram's 64-byte
 * `callback_data` limit.
 */
export function sessionGrantRows(
  prefix: string,
  approvalId: string,
  offer: SessionGrantOffer | null,
): Array<Array<{ text: string; callback_data: string }>> {
  if (offer === null) return [];
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  if (offer.category !== undefined) {
    rows.push([
      {
        text: fitButtonText(`Allow ${offer.category} this session`),
        callback_data: `${prefix}${approvalId}:s`,
      },
    ]);
  }
  if (offer.shape !== undefined) {
    rows.push([
      {
        text: fitButtonText(`Allow all ${offer.shape} this session`),
        callback_data: `${prefix}${approvalId}:a`,
      },
    ]);
  }
  return rows;
}

/**
 * The grant scope an `s` / `a` callback asks for, or `null` when the
 * prompt never offered that button (the callback is then dropped).
 */
export function sessionGrantScope(
  kind: "s" | "a",
  offer: SessionGrantOffer | undefined,
): "category" | "shape" | null {
  if (kind === "s") return offer?.category !== undefined ? "category" : null;
  return offer?.shape !== undefined ? "shape" : null;
}

/** The text the prompt is edited to once a session grant is chosen. */
export function sessionGrantFinalText(
  scope: "category" | "shape",
  offer: SessionGrantOffer,
): string {
  const what =
    scope === "shape" ? `all ${offer.shape} commands` : offer.category;
  const note = offer.shell ? RISKY_STILL_ASK : "";
  return `✅ approved · allowed this session: ${what}${note}`;
}
