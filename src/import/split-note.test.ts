import { describe, expect, it } from "vitest";

import { splitMemoryNote } from "./split-note.js";

describe("splitMemoryNote", () => {
  it("returns a fitting note whole, trimmed", () => {
    expect(splitMemoryNote("  short note \n", 100)).toEqual(["short note"]);
    expect(splitMemoryNote("   \n  ", 100)).toEqual([]);
  });

  it("splits on line boundaries under the cap", () => {
    const note = ["a".repeat(40), "b".repeat(40), "c".repeat(40)].join("\n");
    const chunks = splitMemoryNote(note, 90);
    expect(chunks).toEqual([
      `${"a".repeat(40)}\n${"b".repeat(40)}`,
      "c".repeat(40),
    ]);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(90);
  });

  it("hard-slices a single line longer than the cap", () => {
    const chunks = splitMemoryNote("x".repeat(250), 100);
    expect(chunks).toHaveLength(3);
    expect(chunks.join("")).toBe("x".repeat(250));
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
  });

  it("is deterministic, so re-runs dedup against the same chunks", () => {
    const note = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    expect(splitMemoryNote(note, 64)).toEqual(splitMemoryNote(note, 64));
  });

  it("never emits an over-cap or empty chunk", () => {
    const note = ["", "para one", "", "x".repeat(500), "tail"].join("\n");
    const chunks = splitMemoryNote(note, 120);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(120);
    }
  });
});
