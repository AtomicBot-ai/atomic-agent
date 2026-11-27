import type { SessionStore } from "../../session/session-store.js";
import type { TrashedSessionSummary } from "../../session/session-trash-list.js";

/**
 * ATO-2474: `/sessions --deleted` and `/sessions --restore <n|id>`.
 *
 * A chat moved to Trash (from the desktop's sidebar, or
 * `POST /api/sessions/{id}/trashed`) is left out of the rail, the picker,
 * search and every other list, as a deleted chat would be. This is the one
 * place the terminal shows them, and the way back: like Gemini CLI's
 * `/chat list` and `/chat resume <tag>`, a numbered list in the chat and a
 * command that takes a number from it (or the id, or a unique start of it).
 * Restore clears the flag only; the chat keeps its place, title and folder.
 */

export type SessionsTrashRequest =
  | { readonly verb: "list" }
  | { readonly verb: "restore"; readonly target: string };

export const SESSIONS_USAGE =
  "usage: /sessions (switch chats) · /sessions --deleted (chats in Trash) · /sessions --restore <number or id>";

/**
 * What `/sessions <args>` asks for: the picker (no args), a Trash request,
 * or the usage line for anything else.
 */
export function parseSessionsArgs(
  args: string,
): { picker: true } | { trash: SessionsTrashRequest } | { usage: string } {
  const words = args.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return { picker: true };
  const flag = words[0]!.toLowerCase();
  if ((flag === "--deleted" || flag === "--trash") && words.length === 1) {
    return { trash: { verb: "list" } };
  }
  if (flag === "--restore") {
    if (words.length !== 2) return { usage: "usage: /sessions --restore <number or id> (see /sessions --deleted)" };
    return { trash: { verb: "restore", target: words[1]! } };
  }
  return { usage: SESSIONS_USAGE };
}

type TrashStore = Pick<SessionStore, "listTrashed" | "setSessionTrashed">;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The name a list shows: the title, else the first message, else the id. */
export function trashedChatName(row: TrashedSessionSummary): string {
  const raw = row.title ?? row.firstPrompt ?? "";
  const line = raw.replace(/\s+/g, " ").trim();
  if (!line) return `chat ${row.id.slice(0, 8)}`;
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** "today", "yesterday", "5 days ago"; "" for an unknown date. */
export function trashedAgo(trashedAt: number | null, now: number): string {
  if (trashedAt === null) return "";
  const days = Math.floor(Math.max(0, now - trashedAt) / DAY_MS);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** The text `/sessions --deleted` writes in the chat. */
export function formatTrashList(rows: readonly TrashedSessionSummary[], now: number): string {
  if (rows.length === 0) return "Trash is empty.";
  const head = rows.length === 1 ? "1 chat in Trash:" : `${rows.length} chats in Trash, newest first:`;
  const lines = rows.map((row, i) => {
    const ago = trashedAgo(row.trashedAt, now);
    return `  ${i + 1}. ${trashedChatName(row)}${ago ? ` · moved ${ago}` : ""} · ${row.id.slice(0, 8)}`;
  });
  return [
    head,
    ...lines,
    "Restore one with /sessions --restore <number or id>.",
    "The desktop app deletes a chat for good 30 days after it went to Trash.",
  ].join("\n");
}

/**
 * The chat `target` names: a number from the list as it reads now, the
 * whole id, or a start of it that only one chat in Trash has.
 */
export function resolveTrashTarget(
  rows: readonly TrashedSessionSummary[],
  target: string,
): TrashedSessionSummary | { error: string } {
  if (/^\d+$/.test(target)) {
    const n = Number.parseInt(target, 10);
    const row = rows[n - 1];
    if (row) return row;
    return { error: rows.length === 0 ? "Trash is empty." : `There is no chat ${target} in Trash; /sessions --deleted lists ${rows.length}.` };
  }
  const exact = rows.find((row) => row.id === target);
  if (exact) return exact;
  const matches = rows.filter((row) => row.id.startsWith(target));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) return { error: `More than one chat in Trash starts with ${target}; give more of the id.` };
  return { error: `No chat in Trash matches ${target}; /sessions --deleted lists them.` };
}

/** Run one request against the store: the chat text, and the id brought back, if any. */
export function runSessionsTrash(
  store: TrashStore,
  request: SessionsTrashRequest,
  now: number = Date.now(),
): { text: string; restoredId?: string } {
  let rows: TrashedSessionSummary[];
  try {
    rows = store.listTrashed();
  } catch {
    return { text: "Could not read Trash just now. Try again in a moment." };
  }
  if (request.verb === "list") return { text: formatTrashList(rows, now) };
  const found = resolveTrashTarget(rows, request.target);
  if ("error" in found) return { text: found.error };
  let saved: ReturnType<TrashStore["setSessionTrashed"]>;
  try {
    saved = store.setSessionTrashed(found.id, false, now);
  } catch {
    return { text: `Could not restore ${trashedChatName(found)}. Try again in a moment.` };
  }
  if (saved === null) return { text: `${trashedChatName(found)} is no longer on this machine.` };
  return { text: `Restored ${trashedChatName(found)}. It is back in your chats.`, restoredId: found.id };
}
