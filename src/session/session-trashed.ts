import type { SessionState } from "./session-state.js";

/*
 * ATO-2332: a chat the operator moved to the desktop's Trash. Delete… on a
 * desktop chat row keeps the chat in the store for 30 days (the desktop's
 * own list, `desktop/main/chat-trash.ts`, says when it goes there and
 * purges it after), so it can be restored. While it is in Trash the agent
 * treats it as deleted for search: `memory.sessions.search` and the hit
 * read never return it (`session-search.ts` `sessionTrashedForSearch`).
 *
 * `trashed: true` is the flag; a chat that is not in Trash carries no
 * `trashed` key, so every session from before this feature reads as not
 * in Trash. `trashedSetAt` is the epoch ms of the last move to or out of
 * Trash. `updatedAt` is not touched, so a restored chat keeps its place.
 */

export const SESSION_TRASHED_METADATA_KEY = "trashed";
export const SESSION_TRASHED_SET_AT_KEY = "trashedSetAt";

/** Whether the session is in Trash: only a literal `true` counts. */
export function readSessionTrashed(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return metadata?.[SESSION_TRASHED_METADATA_KEY] === true;
}

/** `state` moved to Trash (`trashed`) or out of it at `now`. */
export function withSessionTrashed(
  state: SessionState,
  trashed: boolean,
  now: number = Date.now(),
): SessionState {
  const next: Record<string, unknown> = { ...state.metadata };
  if (trashed) next[SESSION_TRASHED_METADATA_KEY] = true;
  else delete next[SESSION_TRASHED_METADATA_KEY];
  next[SESSION_TRASHED_SET_AT_KEY] = now;
  return { ...state, metadata: next };
}
