import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LessonStore } from "../lessons/lesson-store.js";
import { MemoryStore } from "../memory-store.js";
import { ProcedureStore } from "../procedures/procedure-store.js";
import { ProfileStore } from "../profile-store.js";
import type { MergeSnapshot } from "./memory-change-log.js";
import { restoreMemoryChange } from "./memory-restore.js";

/**
 * ATO-1059 follow-up: the store's own housekeeping goes into the same
 * journal (eviction, dedup merges, consolidation archives, lessons and
 * procedures), and each entry can be undone.
 */
describe("memory change journal: housekeeping (ATO-1059)", () => {
  let tmp: string;
  let dbFile: string;
  let clock: number;
  const stores: Array<{ close(): void }> = [];

  const open = <T extends { close(): void }>(store: T): T => {
    stores.push(store);
    return store;
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-memory-housekeeping-"));
    dbFile = join(tmp, "memory.sqlite");
    clock = Date.now();
  });

  afterEach(() => {
    while (stores.length > 0) stores.pop()!.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const notesWith = (opts: Partial<ConstructorParameters<typeof MemoryStore>[0]> = {}): MemoryStore =>
    open(new MemoryStore({ dbFile, maxEntries: 100, now: () => clock++, ...opts }));

  it("journals a note evicted over the cap and puts it back", () => {
    const notes = notesWith({ maxEntries: 2 });
    const profile = open(new ProfileStore({ dbFile }));
    const oldest = notes.store({ content: "oldest note about Lisbon", tags: ["place"] });
    notes.store({ content: "second note" });
    notes.store({ content: "third note" });
    expect(notes.get(oldest.id)).toBeNull();

    const [change] = notes.getChangeLog().list({ kind: "note" });
    expect(change).toMatchObject({ kind: "note", op: "evict", by: "agent", target: String(oldest.id) });
    expect(change!.before).toMatchObject({ content: "oldest note about Lisbon", tags: ["place"] });

    const outcome = restoreMemoryChange(change!.id, { notes, profile });
    expect(outcome.ok).toBe(true);
    expect(notes.get(oldest.id)?.content).toBe("oldest note about Lisbon");
    // Still at the cap: putting it back evicts the next oldest, journaled too.
    expect(notes.count()).toBe(2);
    expect(notes.getChangeLog().list({ kind: "note" })[0]).toMatchObject({ op: "evict" });
  });

  it("journals a dedup merge and splits the folded note back out", () => {
    const notes = notesWith({ dedup: { enabled: true, fts5Threshold: 0.5 } });
    const profile = open(new ProfileStore({ dbFile }));
    const kept = notes.store({ content: "the user prefers dark roast coffee", tags: ["food"] });
    const merged = notes.store({
      content: "the user prefers dark roast coffee beans",
      tags: ["food"],
      sessionId: "s2",
    });
    expect(merged.id).toBe(kept.id);
    expect(notes.count()).toBe(1);

    const [change] = notes.getChangeLog().list();
    expect(change).toMatchObject({
      kind: "note",
      op: "merge",
      target: String(kept.id),
      after: "the user prefers dark roast coffee beans",
    });
    expect((change!.before as MergeSnapshot).absorbed).toMatchObject({
      content: "the user prefers dark roast coffee beans",
      sessionId: "s2",
    });

    const outcome = restoreMemoryChange(change!.id, { notes, profile });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.note?.id).not.toBe(kept.id);
    expect(outcome.note).toMatchObject({ content: "the user prefers dark roast coffee beans", sessionId: "s2" });
    expect(notes.get(kept.id)?.content).toBe("the user prefers dark roast coffee");
    expect(notes.count()).toBe(2);
  });

  it("journals a note archived into a lesson and shows it again", () => {
    const notes = notesWith();
    const profile = open(new ProfileStore({ dbFile }));
    const note = notes.store({ content: "ran the tests with vitest" });
    notes.archiveInto([note.id], 42);
    expect(notes.getConsolidatedInto(note.id)).toBe(42);

    const [change] = notes.getChangeLog().list();
    expect(change).toMatchObject({ kind: "note", op: "archive", target: String(note.id), after: "42" });

    expect(restoreMemoryChange(change!.id, { notes, profile }).ok).toBe(true);
    expect(notes.getConsolidatedInto(note.id)).toBeNull();
    expect(notes.get(note.id)?.updatedAt).toBe(note.updatedAt);
    // A second undo of the same archive is refused.
    expect(restoreMemoryChange(change!.id, { notes, profile })).toMatchObject({ ok: false, code: "already_restored" });
  });

  it("journals an unpinned profile fact evicted over the cap and puts it back", () => {
    const notes = notesWith();
    const profile = open(new ProfileStore({ dbFile, maxEntries: 1 }));
    profile.set("city", "Porto", { pinned: false, keywords: ["travel"] });
    profile.set("drink", "tea", { pinned: false, keywords: ["tea"] });
    expect(profile.get("city")).toBeNull();

    const [change] = notes.getChangeLog().list({ kind: "profile" });
    expect(change).toMatchObject({ kind: "profile", op: "evict", by: "agent", target: "city" });
    expect(change!.before).toMatchObject({ key: "city", value: "Porto", pinned: false, keywords: ["travel"] });

    expect(restoreMemoryChange(change!.id, { notes, profile }).ok).toBe(true);
    expect(profile.get("city")?.value).toBe("Porto");
  });

  it("journals lesson creation and deprecation, and undoes each", () => {
    const notes = notesWith();
    const profile = open(new ProfileStore({ dbFile }));
    const lessons = open(new LessonStore({ dbFile }));
    const lesson = lessons.create({
      activation: "When a build fails on a missing type",
      principle: "Read the compiler output before editing.",
      tags: ["build"],
      parentIds: [1, 2],
    });

    const created = notes.getChangeLog().list({ kind: "lesson" });
    expect(created[0]).toMatchObject({ kind: "lesson", op: "create", target: String(lesson.id) });

    // Undoing the creation retires the lesson.
    expect(restoreMemoryChange(created[0]!.id, { notes, profile, lessons }).ok).toBe(true);
    expect(lessons.getById(lesson.id)?.status).toBe("deprecated");

    // That retirement is journaled; undoing it brings the lesson back.
    const [retired] = notes.getChangeLog().list({ kind: "lesson" });
    expect(retired).toMatchObject({ op: "deprecate", after: "undone" });
    expect(restoreMemoryChange(retired!.id, { notes, profile, lessons }).ok).toBe(true);
    expect(lessons.getById(lesson.id)).toMatchObject({ status: "active", deprecatedAt: null });
  });

  it("journals procedure deprecation and reactivates it on undo", () => {
    const notes = notesWith();
    const profile = open(new ProfileStore({ dbFile }));
    const procedures = open(new ProcedureStore({ dbFile }));
    const proc = procedures.create({
      activation: "find exported functions",
      steps: [
        { description: "glob TypeScript files", toolHint: "os.fs.glob" },
        { description: "grep for export", toolHint: "os.fs.grep" },
      ],
      tags: ["code-search"],
      parentLessonIds: [1],
      parentMemoryIds: [1, 2],
    });
    expect(procedures.markDeprecated(proc.id, "aged_out")).toBe(true);

    const [change] = notes.getChangeLog().list({ kind: "procedure" });
    expect(change).toMatchObject({ kind: "procedure", op: "deprecate", after: "aged_out", target: String(proc.id) });
    expect(change!.before).toMatchObject({ status: "active", activation: "find exported functions" });

    // Without the procedure store the undo is refused, not half-done.
    expect(restoreMemoryChange(change!.id, { notes, profile })).toMatchObject({
      ok: false,
      status: 409,
      code: "store_unavailable",
    });
    expect(restoreMemoryChange(change!.id, { notes, profile, procedures }).ok).toBe(true);
    expect(procedures.getById(proc.id)?.status).toBe("active");
  });
});
