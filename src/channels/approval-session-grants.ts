import type { ApprovalRequest } from "../approval/index.js";
import {
  canGrantCategory,
  canGrantShape,
  describeCategoryGrant,
} from "../approval/index.js";
import { describeMcpToolGrant } from "../approval/approval-gate.js";

/**
 * The session grants a remote approval prompt offers (GitHub #230,
 * ATO-2509): the same `[s]` (this kind for the session) and `[a]` (this
 * shell command shape for the session) the TUI modal and the CLI prompt
 * offer, decided by the same `canGrantCategory` / `canGrantShape`, so
 * every surface agrees about what can be granted. Telegram, Discord,
 * Slack and Microsoft Teams all build their buttons from this file.
 *
 * Each field is the words of what the grant covers, or absent when the
 * request does not allow that grant. A bridge keeps this with the
 * pending prompt: a grant click counts only when its button was sent,
 * so a hand-made click cannot grant what the prompt never offered. The
 * gate's own `recordGrant` checks the request again.
 */
export interface SessionGrantOffer {
  /** What `s` grants, e.g. `shell command` or `browser commit on example.com`. */
  category?: string;
  /** The command shape `a` grants, e.g. `git`. */
  shape?: string;
  /** A shell grant: dangerous commands still ask (ATO-1220). */
  shell: boolean;
}

/** The grant scope a session-grant click asks the gate for. */
export type SessionGrantScope = "category" | "shape";

/**
 * Longest grant button text. Telegram cuts long buttons badly, and every
 * other bridge allows at least this much, so all four show the same words.
 */
const GRANT_BUTTON_MAX_CHARS = 60;

/** Said after a shell grant, as the TUI does: risky commands still ask. */
const RISKY_STILL_ASK = " (risky commands still ask)";

/**
 * What this request may be granted for the session, in the TUI's words.
 * `null` when it allows neither grant (`trust_config`, a dangerous shell
 * command, e-mail, a browser request that names no single host, ...) or
 * when the request is a question rather than an approval.
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
 * The button labels for an offer, already cut to the shared length:
 * "Allow <kind> this session" for `category`, "Allow all <shape> this
 * session" for `shape`. A field is absent when that grant is not offered.
 */
export function sessionGrantLabels(offer: SessionGrantOffer | null): {
  category?: string;
  shape?: string;
} {
  if (offer === null) return {};
  return {
    ...(offer.category !== undefined
      ? { category: clipGrantLabel(`Allow ${offer.category} this session`) }
      : {}),
    ...(offer.shape !== undefined
      ? { shape: clipGrantLabel(`Allow all ${offer.shape} this session`) }
      : {}),
  };
}

/**
 * The scope a grant click asks for, or `null` when the prompt never
 * offered that button (the click is then refused, never resolved).
 * `kind` is the wire letter: `s` for the kind, `a` for the shape.
 */
export function sessionGrantScope(
  kind: "s" | "a",
  offer: SessionGrantOffer | undefined,
): SessionGrantScope | null {
  if (kind === "s") return offer?.category !== undefined ? "category" : null;
  return offer?.shape !== undefined ? "shape" : null;
}

/**
 * What a chosen grant covers, for the message that replaces the prompt:
 * e.g. `all git commands (risky commands still ask)`.
 */
export function sessionGrantSummary(
  scope: SessionGrantScope,
  offer: SessionGrantOffer,
): string {
  const what =
    scope === "shape" ? `all ${offer.shape} commands` : offer.category;
  const note = offer.shell ? RISKY_STILL_ASK : "";
  return `${what}${note}`;
}

function clipGrantLabel(text: string): string {
  return text.length <= GRANT_BUTTON_MAX_CHARS
    ? text
    : `${text.slice(0, GRANT_BUTTON_MAX_CHARS - 1)}…`;
}
