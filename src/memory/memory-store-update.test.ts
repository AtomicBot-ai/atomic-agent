import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryStore, MemoryValidationError } from "./memory-store.js";

describe("MemoryStore.updateContent (ATO-1124)", () => {
  let tmp: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-agent-notes-update-"));
    store = new MemoryStore({ dbFile: join(tmp, "memory.sqlite"), maxEntries: 100 });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("replaces the text, keeps where it came from, and moves the search index", () => {
    const original = store.store(
      { content: "the user lives in Lisbon", tags: ["place"], sessionId: "s1", source: "agent" },
      1_000,
    );
    const edited = store.updateContent(original.id, "  the user lives in Porto  ", 2_000);
    expect(edited).toMatchObject({
      id: original.id,
      content: "the user lives in Porto",
      createdAt: 1_000,
      updatedAt: 2_000,
      source: "agent",
      sessionId: "s1",
      tags: ["place"],
    });
    expect(store.recall("Lisbon")).toEqual([]);
    expect(store.recall("Porto").map((e) => e.id)).toEqual([original.id]);
  });

  it("returns null for an id that is not stored", () => {
    expect(store.updateContent(999, "anything")).toBeNull();
  });

  it("refuses empty text and a bad id", () => {
    const note = store.store({ content: "keep me" });
    expect(() => store.updateContent(note.id, "   ")).toThrow(MemoryValidationError);
    expect(() => store.updateContent(0, "text")).toThrow(MemoryValidationError);
    expect(store.get(note.id)?.content).toBe("keep me");
  });
});
