import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LessonStore } from "../memory/lessons/lesson-store.js";
import { MemoryStore } from "../memory/memory-store.js";

import { forgetMemoryBefore, parseForgetDate } from "./memory-forget.js";

describe("parseForgetDate", () => {
  it("reads YYYY-MM-DD as local midnight", () => {
    expect(parseForgetDate("2026-10-15")).toBe(new Date(2026, 9, 15).getTime());
  });

  it("rejects anything else", () => {
    expect(parseForgetDate("2026-02-30")).toBeNull();
    expect(parseForgetDate("15.10.2026")).toBeNull();
    expect(parseForgetDate("yesterday")).toBeNull();
  });
});

describe("forgetMemoryBefore (ATO-321)", () => {
  let dir: string;
  let dbFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-memory-forget-"));
    dbFile = join(dir, "memory.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(): void {
    const notes = new MemoryStore({ dbFile, maxEntries: 100 });
    notes.store({ content: "I am Alex (old QA run)" }, 1_000);
    notes.store({ content: "prefer local_ok, avoid tool usage" }, 2_000);
    notes.store({ content: "real note from today" }, 10_000);
    notes.close();
    let t = 1_500;
    const lessons = new LessonStore({ dbFile, now: () => t });
    lessons.create({ activation: "when the user Alex asks", principle: "old lesson body", parentIds: [1] });
    t = 10_500;
    lessons.create({ activation: "when building", principle: "new lesson body", parentIds: [3] });
    lessons.close();
  }

  it("only counts without --yes", () => {
    seed();
    const result = forgetMemoryBefore({ dbFile, maxEntries: 100, cutoff: 5_000, apply: false });
    expect(result).toMatchObject({ applied: false, notes: 2, lessons: 1 });
    const notes = new MemoryStore({ dbFile, maxEntries: 100 });
    expect(notes.count()).toBe(3);
    notes.close();
  });

  it("deletes older notes and deprecates older lessons with --yes", () => {
    seed();
    const result = forgetMemoryBefore({ dbFile, maxEntries: 100, cutoff: 5_000, apply: true });
    expect(result).toMatchObject({ applied: true, notes: 2, lessons: 1 });
    const notes = new MemoryStore({ dbFile, maxEntries: 100 });
    expect(notes.list({ limit: 10 }).map((e) => e.content)).toEqual(["real note from today"]);
    notes.close();
    const lessons = new LessonStore({ dbFile });
    expect(lessons.countActive()).toBe(1);
    expect(lessons.countAll()).toBe(2);
    lessons.close();
  });
});
