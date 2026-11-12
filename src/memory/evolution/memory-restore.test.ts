import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryStore } from "../memory-store.js";
import { ProfileStore } from "../profile-store.js";
import { MemoryChangeLog, MEMORY_CHANGE_LOG_MAX_AGE_MS } from "./memory-change-log.js";
import { restoreMemoryChange, restoreProfileVersion } from "./memory-restore.js";

describe("memory change journal and undo (ATO-1059)", () => {
  let tmp: string;
  let notes: MemoryStore;
  let profile: ProfileStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-memory-restore-"));
    const dbFile = join(tmp, "memory.sqlite");
    notes = new MemoryStore({ dbFile, maxEntries: 100 });
    profile = new ProfileStore({ dbFile });
  });

  afterEach(() => {
    notes.close();
    profile.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("journals a note deletion and puts the note back under its old id", () => {
    const note = notes.store({ content: "the user lives in Porto", tags: ["place"], sessionId: "s1" }, 1_000);
    expect(notes.remove(note.id, "user")).toBe(true);
    const [change] = notes.getChangeLog().list();
    expect(change).toMatchObject({ kind: "note", op: "remove", by: "user", target: String(note.id), restoredAt: null });

    const outcome = restoreMemoryChange(change!.id, { notes, profile }, 5_000);
    expect(outcome.ok).toBe(true);
    const back = notes.get(note.id);
    expect(back).toMatchObject({ content: "the user lives in Porto", tags: ["place"], sessionId: "s1", createdAt: 1_000 });
    expect(notes.recall("Porto").map((e) => e.id)).toEqual([note.id]);
  });

  it("refuses to undo the same change twice", () => {
    const note = notes.store({ content: "one" });
    notes.remove(note.id);
    const [change] = notes.getChangeLog().list();
    expect(restoreMemoryChange(change!.id, { notes, profile }).ok).toBe(true);
    expect(restoreMemoryChange(change!.id, { notes, profile })).toMatchObject({ ok: false, status: 409, code: "already_restored" });
    expect(notes.count()).toBe(1);
  });

  it("journals a text edit and brings the old text back", () => {
    const note = notes.store({ content: "likes tea" });
    notes.updateContent(note.id, "likes coffee", undefined, "user");
    const [change] = notes.getChangeLog().list();
    expect(change).toMatchObject({ op: "update", after: "likes coffee" });
    expect(restoreMemoryChange(change!.id, { notes, profile }).ok).toBe(true);
    expect(notes.get(note.id)?.content).toBe("likes tea");
    // The undo is an edit too, so it can itself be undone.
    expect(notes.getChangeLog().list()[0]).toMatchObject({ op: "update", after: "likes tea" });
  });

  it("answers note_gone when an edited note was deleted since", () => {
    const note = notes.store({ content: "a" });
    notes.updateContent(note.id, "b");
    const editId = notes.getChangeLog().list()[0]!.id;
    notes.remove(note.id);
    expect(restoreMemoryChange(editId, { notes, profile })).toMatchObject({ ok: false, status: 409, code: "note_gone" });
  });

  it("journals a profile deletion and restores the fact with its keywords", () => {
    profile.set("diet", "vegetarian", { pinned: false, keywords: ["food"] });
    expect(profile.remove("diet")).toBe(true);
    const [change] = notes.getChangeLog().list({ kind: "profile" });
    expect(change).toMatchObject({ kind: "profile", target: "diet", op: "remove", by: "agent" });
    const outcome = restoreMemoryChange(change!.id, { notes, profile });
    expect(outcome).toMatchObject({ ok: true, fact: { key: "diet", value: "vegetarian", pinned: false, keywords: ["food"] } });
    expect(profile.get("diet")?.value).toBe("vegetarian");
  });

  it("does not journal a delete of something that is not there", () => {
    expect(notes.remove(4242)).toBe(false);
    expect(profile.remove("nope")).toBe(false);
    expect(notes.getChangeLog().list()).toEqual([]);
  });

  it("makes an older profile version active again", () => {
    const first = profile.set("city", "Lisbon");
    profile.set("city", "Porto");
    const outcome = restoreProfileVersion(profile, "city", first.id);
    expect(outcome).toMatchObject({ ok: true, fact: { value: "Lisbon" } });
    expect(profile.history("city").map((v) => v.value)).toEqual(["Lisbon", "Porto", "Lisbon"]);
    expect(restoreProfileVersion(profile, "city", 99_999)).toMatchObject({ ok: false, code: "version_not_found" });
  });

  it("answers change_not_found for an unknown id", () => {
    expect(restoreMemoryChange(77, { notes, profile })).toMatchObject({ ok: false, status: 404 });
  });

  it("prunes journal rows older than the retention window when a store opens", () => {
    const now = 10 * MEMORY_CHANGE_LOG_MAX_AGE_MS;
    const db = notes.getDatabaseHandleForEmbeddings();
    const log = new MemoryChangeLog(db, now);
    const before = { key: "k", value: "v", pinned: true, keywords: [] };
    log.record({ kind: "profile", target: "k", op: "remove", by: "agent", before }, now - MEMORY_CHANGE_LOG_MAX_AGE_MS - 1);
    log.record({ kind: "profile", target: "k", op: "remove", by: "agent", before }, now);
    new MemoryChangeLog(db, now);
    expect(log.list().map((c) => c.at)).toEqual([now]);
  });
});
