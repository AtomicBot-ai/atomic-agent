import type { FactCandidate } from "../../memory/import-facts/extract-fact-candidates.js";
import type { MemoryEntry, MemoryStoreInput } from "../../memory/memory-store.js";
import { findDuplicateFact, normaliseProfileValue } from "../../memory/profile-duplicates.js";
import { isNameProfileKey } from "../../memory/profile-name-keys.js";
import type { ProfileFact, ProfileSetOptions } from "../../memory/profile-store.js";
import type { ImportItemResult, ImportReport } from "../import-report.js";
import { buildReport } from "../import-report.js";

/**
 * ATO-1625. Write only the candidates the person ticked.
 *
 * - Profile facts (ATO-1617: "like USER.md": name, job, city, language,
 *   preferences) go to `ProfileStore`. A fact already known, under its key
 *   or a near-duplicate one (profile-duplicates.ts), is skipped. A key
 *   that already holds a DIFFERENT value is never overwritten: it is
 *   reported as a conflict "was / would be" and left alone; the person
 *   can change it by hand. Two ticked values for one key: the first wins,
 *   the second is a conflict.
 * - Notes go to `MemoryStore`, prefixed "From ChatGPT:" / "From Claude:"
 *   and tagged {@link importFactsTags} so everything one export brought
 *   can be listed and removed at once ({@link removeImportedFactNotes}).
 * - The result carries a receipt of exactly what was written, profile
 *   rows included (the profile table has no tags), for
 *   {@link undoImportedFacts}. Persisting the receipt is the caller's job.
 *
 * Writes go in as the person's own (`source: "user"`): they ticked each one.
 * A name fact is stored as grounded: extraction already checked it
 * against the person's own messages, and the person confirmed it.
 *
 * Lives in src/import (not src/memory) because it builds an
 * `ImportReport`; src/import already depends on src/memory, never back.
 */

export type ImportFactsSourceLabel = "claude" | "chatgpt";

export const IMPORTED_FACTS_TAG = "imported-facts";

/** Tags stamped on every note one export brought: the shared one plus the source. */
export function importFactsTags(source: ImportFactsSourceLabel): string[] {
  return [IMPORTED_FACTS_TAG, `from-${source}`];
}

const SOURCE_PREFIX: Record<ImportFactsSourceLabel, string> = {
  chatgpt: "From ChatGPT: ",
  claude: "From Claude: ",
};

/** The slice of `ProfileStore` this module uses (tests pass the real store). */
export interface ImportFactsProfileTarget {
  list(): ProfileFact[];
  get(key: string): ProfileFact | null;
  set(key: string, value: string, options?: ProfileSetOptions): ProfileFact;
  remove(key: string, by?: "user" | "agent"): boolean;
}

/** The slice of `MemoryStore` this module uses. */
export interface ImportFactsMemoryTarget {
  store(input: MemoryStoreInput, now?: number): MemoryEntry;
  hasContent(content: string): boolean;
  get(id: number): MemoryEntry | null;
  list(opts?: { scope?: "project" | "all"; limit?: number }): MemoryEntry[];
  remove(id: number, by?: "user" | "agent"): boolean;
}

export interface ImportFactsReceipt {
  source: ImportFactsSourceLabel;
  savedAt: number;
  /** Profile rows this import created: key + the row id it wrote. */
  profile: { key: string; id: number }[];
  /** Note ids this import created. */
  noteIds: number[];
}

export interface SaveFactCandidatesInput {
  candidates: readonly FactCandidate[];
  /** Ids the person ticked. Anything not listed is not written. */
  approvedIds: readonly string[];
  source: ImportFactsSourceLabel;
  profileStore: ImportFactsProfileTarget;
  memoryStore: ImportFactsMemoryTarget;
  now?: number;
}

export interface SaveFactCandidatesResult {
  report: ImportReport<"profile" | "note">;
  receipt: ImportFactsReceipt;
}

export function saveFactCandidates(input: SaveFactCandidatesInput): SaveFactCandidatesResult {
  const now = input.now ?? Date.now();
  const approved = new Set(input.approvedIds);
  const items: ImportItemResult<"profile" | "note">[] = [];
  const receipt: ImportFactsReceipt = { source: input.source, savedAt: now, profile: [], noteIds: [] };
  const tags = importFactsTags(input.source);

  for (const c of input.candidates) {
    if (!approved.has(c.id)) continue;
    if (c.kind === "profile" && c.key) {
      items.push(saveProfile(c.key, c, input.profileStore, receipt));
    } else {
      items.push(saveNote(c, input, tags, now, receipt));
    }
  }
  return { report: buildReport(items, true), receipt };
}

function saveProfile(
  key: string,
  c: FactCandidate,
  store: ImportFactsProfileTarget,
  receipt: ImportFactsReceipt,
): ImportItemResult<"profile"> {
  const base = { kind: "profile" as const, source: c.id, destination: key };
  const current = store.get(key);
  if (current && normaliseProfileValue(current.value) !== normaliseProfileValue(c.value)) {
    return {
      ...base,
      status: "conflict",
      reason: `already set: was "${current.value}", would be "${c.value}"; left as it was`,
    };
  }
  const dup = findDuplicateFact(store.list(), key, c.value);
  if (dup) {
    return { ...base, status: "skipped", reason: `already known as ${dup.fact.key}` };
  }
  try {
    const row = store.set(key, c.value, {
      pinned: c.pinned,
      ...(isNameProfileKey(key) ? { nameGrounding: "grounded" as const } : {}),
    });
    receipt.profile.push({ key: row.key, id: row.id });
    return { ...base, destination: row.key, status: "migrated" };
  } catch (err) {
    return { ...base, status: "error", reason: errorMessage(err) };
  }
}

function saveNote(
  c: FactCandidate,
  input: SaveFactCandidatesInput,
  tags: string[],
  now: number,
  receipt: ImportFactsReceipt,
): ImportItemResult<"note"> {
  const base = { kind: "note" as const, source: c.id };
  const content = `${SOURCE_PREFIX[input.source]}${c.value}`;
  if (input.memoryStore.hasContent(content)) {
    return { ...base, status: "skipped", reason: "already in memory" };
  }
  try {
    const entry = input.memoryStore.store({ content, tags, source: "user" }, now);
    // With dedup on, the store may merge into an older note instead of
    // inserting: that note is not ours and must never be undone.
    if (entry.createdAt !== now || !entry.tags.includes(IMPORTED_FACTS_TAG)) {
      return { ...base, destination: String(entry.id), status: "skipped", reason: "merged into an existing note" };
    }
    if (!receipt.noteIds.includes(entry.id)) receipt.noteIds.push(entry.id);
    return { ...base, destination: String(entry.id), status: "migrated" };
  } catch (err) {
    return { ...base, status: "error", reason: errorMessage(err) };
  }
}

export interface UndoImportedFactsResult {
  profileRemoved: number;
  /** Profile keys changed since the import (by the person or the agent): left alone. */
  profileKept: number;
  notesRemoved: number;
}

/**
 * Remove what one import wrote. A profile key is removed only while it
 * still holds the very row the import wrote; a later change by the
 * person or the agent is kept. Removals go through the stores' change
 * journal (`by: "user"`), so each one can still be undone there.
 */
export function undoImportedFacts(
  receipt: ImportFactsReceipt,
  profileStore: ImportFactsProfileTarget,
  memoryStore: ImportFactsMemoryTarget,
): UndoImportedFactsResult {
  let profileRemoved = 0;
  let profileKept = 0;
  for (const { key, id } of receipt.profile) {
    const active = profileStore.get(key);
    if (active && active.id === id) {
      if (profileStore.remove(key, "user")) profileRemoved += 1;
    } else {
      profileKept += 1;
    }
  }
  let notesRemoved = 0;
  for (const id of receipt.noteIds) {
    const note = memoryStore.get(id);
    if (!note || !note.tags.includes(IMPORTED_FACTS_TAG)) continue;
    if (memoryStore.remove(id, "user")) notesRemoved += 1;
  }
  return { profileRemoved, profileKept, notesRemoved };
}

/**
 * Remove every note an export of `source` brought, by tag, without a
 * receipt. Profile facts need the receipt ({@link undoImportedFacts}).
 */
export function removeImportedFactNotes(
  source: ImportFactsSourceLabel,
  memoryStore: ImportFactsMemoryTarget,
): number {
  const sourceTag = `from-${source}`;
  let removed = 0;
  for (const note of memoryStore.list({ scope: "all", limit: 100_000 })) {
    if (!note.tags.includes(IMPORTED_FACTS_TAG) || !note.tags.includes(sourceTag)) continue;
    if (memoryStore.remove(note.id, "user")) removed += 1;
  }
  return removed;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
