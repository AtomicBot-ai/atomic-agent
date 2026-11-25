import {
  requireApproval,
  type DangerousToolOptions,
} from "../../approval/dangerous-tool.js";
import type { SessionSummary } from "../../session/index.js";

/**
 * Shared pieces of the `sessions.*` tools (ATO-570): how another chat is
 * named, how a message sent to it is framed, and the one approval a read
 * of it or a send into it goes through.
 *
 * Another chat is the operator's private context, so the defaults are the
 * narrow ones: a listing shows names only, a read shows the visible
 * user / assistant text only (never tool output, files or reasoning), and
 * every read of or send into a chat other than the caller's own asks under
 * `session_cross` — silent only at full trust, never settled by the risk
 * reviewer.
 */

/** What a list or a prompt shows for a chat: its title, else its opening words. */
export function chatName(summary: Pick<SessionSummary, "title" | "firstPrompt">): string {
  const raw = summary.title ?? summary.firstPrompt ?? "";
  const flat = oneLine(raw, 80);
  return flat.length > 0 ? flat : "(untitled)";
}

/** Control characters and line breaks out, clipped to `max` characters. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * First line of every message one chat queues into another. The target
 * agent reads it before the request, so it knows the words come from an
 * agent in another chat and not from the person; `sessions.check` uses it
 * to tell which queued messages the caller sent; `sessions.send` uses it
 * to refuse a forward from a turn that such a message started (no
 * ping-pong between two chats).
 */
const HEADER_PREFIX = "[Message from the agent in another chat, session ";
const HEADER_SUFFIX =
  ". It is a request from that agent, not from the person. Answer it with reply.]";

export function frameCrossSessionMessage(fromSessionId: string, message: string): string {
  return `${HEADER_PREFIX}${fromSessionId}${HEADER_SUFFIX}\n\n${message}`;
}

/** The sending session of a framed message, or `null` for any other text. */
export function crossSessionSender(text: string): string | null {
  if (!text.startsWith(HEADER_PREFIX)) return null;
  const end = text.indexOf(HEADER_SUFFIX, HEADER_PREFIX.length);
  if (end < 0) return null;
  const id = text.slice(HEADER_PREFIX.length, end);
  return id.length > 0 && !/\s/.test(id) ? id : null;
}

export interface CrossSessionApproval {
  tool: string;
  /** The caller's own session (`ctx.sessionId`). */
  callerSessionId: string;
  /** The chat being read or written; `null` for a chat about to be created. */
  targetSessionId: string | null;
  reason: string;
  preview?: string;
}

/**
 * Ask before touching another chat. The caller's own chat never asks: it
 * is already in its context. A denial throws `ApprovalDeniedError`, which
 * the dispatcher turns into the usual refusal.
 */
export async function approveCrossSession(
  options: DangerousToolOptions,
  request: CrossSessionApproval,
  signal: AbortSignal,
): Promise<void> {
  if (request.targetSessionId === request.callerSessionId) return;
  await requireApproval(
    options,
    {
      sessionId: request.callerSessionId,
      tool: request.tool,
      category: "session_cross",
      reason: request.reason,
      ...(request.preview !== undefined ? { preview: request.preview } : {}),
      ...(request.targetSessionId !== null
        ? { affectedResources: [request.targetSessionId] }
        : {}),
    },
    signal,
  );
}

/** A string argument, trimmed; `undefined` when absent or empty. */
export function stringArg(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A positive integer argument clamped to `max`, else `fallback`. */
export function limitArg(raw: unknown, fallback: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.trunc(raw), max);
}
