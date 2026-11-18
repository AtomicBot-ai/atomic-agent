import type { LessonStore } from "../lessons/lesson-store.js";
import type { MemoryEntry, MemoryStore } from "../memory-store.js";
import type { ProcedureStore } from "../procedures/procedure-store.js";
import { isNameProfileKey } from "../profile-name-keys.js";
import type { ProfileFact, ProfileStore } from "../profile-store.js";
import type {
  MemoryChange,
  MergeSnapshot,
  NoteSnapshot,
  ProfileSnapshot,
} from "./memory-change-log.js";

/**
 * ATO-1059. Undo one journaled memory change: put a deleted note or
 * profile fact back, or a note's old text. The undo is itself an
 * ordinary write (an edit is journaled again), so it can be undone too.
 * A value the person restores is their own call, so a restored name is
 * stored as grounded (ATO-199).
 *
 * The store's housekeeping undoes the same way: an evicted note or fact
 * comes back like a deleted one; a dedup merge is split (the folded text
 * becomes its own note again, the kept note gets its old tags); an
 * archived note leaves its lesson and shows again; a lesson or procedure
 * the agent created is retired, one it retired is active again.
 */

export type RestoreOutcome =
  | { ok: true; change: MemoryChange; note?: MemoryEntry; fact?: ProfileFact }
  | {
      ok: false;
      status: 404 | 409;
      code:
        | "change_not_found"
        | "already_restored"
        | "note_gone"
        | "version_not_found"
        | "already_current"
        | "store_unavailable";
      message: string;
    };

export interface RestoreDeps {
  notes: MemoryStore;
  profile: ProfileStore;
  /** Needed only to undo a lesson change; without it that undo is a 409. */
  lessons?: LessonStore;
  /** Needed only to undo a procedure change; without it that undo is a 409. */
  procedures?: ProcedureStore;
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
  if (change.kind === "lesson" || change.kind === "procedure") {
    const failed = undoLessonOrProcedure(change, deps);
    if (failed !== null) return failed;
    applied = {};
  } else if (change.kind === "note" && (change.op === "remove" || change.op === "evict")) {
    applied = { note: deps.notes.restoreNote(change.before as NoteSnapshot, now) };
  } else if (change.kind === "note" && change.op === "merge") {
    const before = change.before as MergeSnapshot;
    deps.notes.setTags(before.id, before.tags);
    applied = { note: deps.notes.restoreNote(absorbedAsSnapshot(before), now) };
  } else if (change.kind === "note" && change.op === "archive") {
    const before = change.before as NoteSnapshot;
    if (!deps.notes.unarchive(before.id, before.updatedAt)) {
      return { ok: false, status: 409, code: "note_gone", message: `note ${change.target} is gone or no longer archived` };
    }
    const note = deps.notes.get(before.id);
    applied = note !== null ? { note } : {};
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

/** `null` when undone; otherwise the refusal. */
function undoLessonOrProcedure(
  change: MemoryChange,
  deps: RestoreDeps,
): Extract<RestoreOutcome, { ok: false }> | null {
  const store = change.kind === "lesson" ? deps.lessons : deps.procedures;
  if (store === undefined) {
    return { ok: false, status: 409, code: "store_unavailable", message: `${change.kind}s are not open here` };
  }
  const id = Number(change.target);
  const done =
    change.op === "create"
      ? store.markDeprecated(id, "undone")
      : change.op === "deprecate"
        ? store.reactivate(id)
        : false;
  if (done) return null;
  return {
    ok: false,
    status: 409,
    code: "already_current",
    message: `${change.kind} ${change.target} is already ${change.op === "create" ? "retired" : "active"}`,
  };
}

/**
 * The folded write as a note to put back. Its id is the kept note's, which
 * is taken, so `restoreNote` gives it a new one.
 */
function absorbedAsSnapshot(before: MergeSnapshot): NoteSnapshot {
  return {
    id: before.id,
    content: before.absorbed.content,
    createdAt: before.absorbed.at,
    updatedAt: before.absorbed.at,
    source: before.absorbed.source,
    sessionId: before.absorbed.sessionId,
    workingDir: before.absorbed.workingDir,
    tags: before.absorbed.tags,
  };
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
