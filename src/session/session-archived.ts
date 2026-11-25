import type { SessionState } from "./session-state.js";

/*
 * ATO-1150: a chat the operator archived. The flag lives in the session's
 * own metadata, in the shared state dir, so every client of the store
 * sees it: the desktop's sidebar draws the chat in its "Archived" section,
 * the terminal's rail and session picker leave it out.
 *
 * `archived: true` is the flag; an unarchived chat carries no `archived`
 * key at all, so the many sessions from before this feature read exactly
 * as unarchived ones. `archivedSetAt` is the epoch ms of the last archive
 * OR unarchive, and works like the rename stamp (`session-title-user.ts`):
 * a copy of the session read before that moment (a turn that was running,
 * a TUI stamp, the namer's late write) cannot put the old flag back,
 * because the store keeps the stored flag over any copy with no stamp or
 * an older one (`SessionStore` `withStoredArchive`).
 *
 * Not to be confused with the turn archive (`turn-archive.ts`), which is
 * where compacted turns of a long transcript move. That is storage; this
 * is the operator putting a chat away.
 */

export const SESSION_ARCHIVED_METADATA_KEY = "archived";
export const SESSION_ARCHIVED_SET_AT_KEY = "archivedSetAt";

/** Whether the session is archived: only a literal `true` counts. */
export function readSessionArchived(
  metadata: Record<string, unknown> | undefined,
): boolean {
  return metadata?.[SESSION_ARCHIVED_METADATA_KEY] === true;
}

/** When the flag was last set or cleared, `null` when it never was. */
export function readSessionArchivedSetAt(
  metadata: Record<string, unknown> | undefined,
): number | null {
  const raw = metadata?.[SESSION_ARCHIVED_SET_AT_KEY];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/**
 * `metadata` with the flag as given and its stamp: `archived: true` when
 * archived, no `archived` key when not.
 */
export function withArchivedMetadata(
  metadata: Record<string, unknown> | undefined,
  archived: boolean,
  setAt: number,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...metadata };
  if (archived) next[SESSION_ARCHIVED_METADATA_KEY] = true;
  else delete next[SESSION_ARCHIVED_METADATA_KEY];
  next[SESSION_ARCHIVED_SET_AT_KEY] = setAt;
  return next;
}

/** `state` archived or unarchived by the operator at `now`. */
export function withSessionArchived(
  state: SessionState,
  archived: boolean,
  now: number = Date.now(),
): SessionState {
  return { ...state, metadata: withArchivedMetadata(state.metadata, archived, now) };
}
