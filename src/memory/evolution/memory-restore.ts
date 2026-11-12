import type { MemoryEntry, MemoryStore } from "../memory-store.js";
import { isNameProfileKey } from "../profile-name-keys.js";
import type { ProfileFact, ProfileStore } from "../profile-store.js";
import type {
  MemoryChange,
  NoteSnapshot,
  ProfileSnapshot,
} from "./memory-change-log.js";

/**
 * ATO-1059. Undo one journaled memory change: put a deleted note or
 * profile fact back, or a note's old text. The undo is itself an
 * ordinary write (an edit is journaled again), so it can be undone too.
 * A value the person restores is their own call, so a restored name is
 * stored as grounded (ATO-199).
 */

export type RestoreOutcome =
  | { ok: true; change: MemoryChange; note?: MemoryEntry; fact?: ProfileFact }
  | {
      ok: false;
      status: 404 | 409;
      code: "change_not_found" | "already_restored" | "note_gone" | "version_not_found";
      message: string;
    };

export interface RestoreDeps {
  notes: MemoryStore;
  profile: ProfileStore;
}

export function restoreMemoryChange(
  changeId: number,
  deps: RestoreDeps,
  now: number = Date.now(),
): RestoreOutcome {
  const log = deps.notes.getChangeLog();
  const change = log.get(changeId);
  if (change === null) {
    return { ok: false, status: 404, code: "change_not_found", message: `memory change not found: ${changeId}` };
  }
  if (change.restoredAt !== null) {
    return { ok: false, status: 409, code: "already_restored", message: `memory change ${changeId} was already undone` };
  }
  let applied: { note?: MemoryEntry; fact?: ProfileFact };
  if (change.kind === "note" && change.op === "remove") {
    applied = { note: deps.notes.restoreNote(change.before as NoteSnapshot, now) };
  } else if (change.kind === "note") {
    const before = change.before as NoteSnapshot;
    const note = deps.notes.updateContent(Number(change.target), before.content, now, "user");
    if (note === null) {
      return { ok: false, status: 409, code: "note_gone", message: `note ${change.target} no longer exists` };
    }
    applied = { note };
  } else {
    applied = { fact: setProfileValue(deps.profile, change.before as ProfileSnapshot) };
  }
  log.markRestored(changeId, now);
  return { ok: true, change: { ...change, restoredAt: now }, ...applied };
}

/**
 * Make an earlier version of a profile fact the active one again (from
 * `history(key)`), as a new version: nothing in the chain is rewritten.
 */
export function restoreProfileVersion(
  profile: ProfileStore,
  key: string,
  versionId: number,
): { ok: true; fact: ProfileFact } | { ok: false; status: 404; code: "version_not_found"; message: string } {
  const version = profile.history(key).find((v) => v.id === versionId);
  if (version === undefined) {
    return { ok: false, status: 404, code: "version_not_found", message: `no version ${versionId} of ${key}` };
  }
  return { ok: true, fact: setProfileValue(profile, version) };
}

function setProfileValue(
  profile: ProfileStore,
  snapshot: Pick<ProfileSnapshot, "key" | "value" | "pinned" | "keywords">,
): ProfileFact {
  return profile.set(snapshot.key, snapshot.value, {
    pinned: snapshot.pinned,
    keywords: snapshot.keywords,
    ...(isNameProfileKey(snapshot.key) ? { nameGrounding: "grounded" as const } : {}),
  });
}
