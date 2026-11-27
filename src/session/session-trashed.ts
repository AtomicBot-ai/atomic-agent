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
 *
 * The stamp works like the archive one (`session-archived.ts`): a copy of
 * the session read before that moment (a turn that was running, a TUI
 * stamp, the namer's late write) cannot put the old flag back, because the
 * store keeps the stored flag over any copy with no stamp or an older one
 * (`withStoredTrashed`, applied by `SessionStore` on every payload write).
 */

export const SESSION_TRASHED_METADATA_KEY = "trashed";
export const SESSION_TRASHED_SET_AT_KEY = "trashedSetAt";

/** Whether the session is in Trash: only a literal `true` counts. */
export function readSessionTrashed(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return metadata?.[SESSION_TRASHED_METADATA_KEY] === true;
}

/** When the flag was last set or cleared, `null` when it never was. */
export function readSessionTrashedSetAt(
  metadata: Record<string, unknown> | undefined,
): number | null {
  const raw = metadata?.[SESSION_TRASHED_SET_AT_KEY];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** `metadata` with the flag as given and its stamp; no `trashed` key when not in Trash. */
export function withTrashedMetadata(
  metadata: Record<string, unknown> | undefined,
  trashed: boolean,
  setAt: number,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...metadata };
  if (trashed) next[SESSION_TRASHED_METADATA_KEY] = true;
  else delete next[SESSION_TRASHED_METADATA_KEY];
  next[SESSION_TRASHED_SET_AT_KEY] = setAt;
  return next;
}

/** `state` moved to Trash (`trashed`) or out of it at `now`. */
export function withSessionTrashed(
  state: SessionState,
  trashed: boolean,
  now: number = Date.now(),
): SessionState {
  return { ...state, metadata: withTrashedMetadata(state.metadata, trashed, now) };
}

/** What the stored row says about Trash (`SessionStore` reads it before each write). */
export interface StoredTrashed {
  chatTrashed: boolean;
  /** When the flag was last set or cleared, `null` when never. */
  chatTrashedSetAt: number | null;
}

/**
 * `next` with the stored Trash flag and stamp where `next` should not
 * replace them: a copy with no stamp, or one older than the stored stamp,
 * was read before the last move to or out of Trash. `setSessionTrashed`'s
 * own write carries the newest stamp and goes through as it is.
 */
export function withStoredTrashed(
  next: SessionState,
  stored: StoredTrashed | undefined,
): SessionState {
  if (stored === undefined || stored.chatTrashedSetAt === null) return next;
  const nextAt = readSessionTrashedSetAt(next.metadata);
  if (nextAt !== null && nextAt >= stored.chatTrashedSetAt) return next;
  return {
    ...next,
    metadata: withTrashedMetadata(next.metadata, stored.chatTrashed, stored.chatTrashedSetAt),
  };
}
