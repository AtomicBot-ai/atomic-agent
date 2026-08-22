import { describe, expect, it } from "vitest";

import { DetachedTurns, droppedPreview } from "./detached-turns.js";

describe("DetachedTurns", () => {
  it("take removes and returns the parked controller", () => {
    const turns = new DetachedTurns();
    const controller = new AbortController();
    turns.park("s1", controller);
    expect(turns.has("s1")).toBe(true);
    expect(turns.take("s1")).toBe(controller);
    expect(turns.has("s1")).toBe(false);
    expect(turns.take("s1")).toBeNull();
  });

  it("release is identity-checked so a finished turn cannot release its successor", () => {
    const turns = new DetachedTurns();
    const first = new AbortController();
    const second = new AbortController();
    turns.park("s1", first);
    // The same session gets re-parked with a NEWER turn's controller
    // (switch back, run again, switch away again) before the first
    // turn's finally block runs.
    turns.park("s1", second);
    expect(turns.release("s1", first)).toBe(false);
    expect(turns.has("s1")).toBe(true);
    expect(turns.release("s1", second)).toBe(true);
    expect(turns.has("s1")).toBe(false);
  });

  it("abortAll aborts every parked turn and empties the registry", () => {
    const turns = new DetachedTurns();
    const a = new AbortController();
    const b = new AbortController();
    turns.park("s1", a);
    turns.park("s2", b);
    turns.abortAll();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(turns.size).toBe(0);
  });
});

describe("droppedPreview", () => {
  it.each([
    ["short text", "short text"],
    ["multi\n  line\ttext", "multi line text"],
    ["x".repeat(80), `${"x".repeat(59)}…`],
  ])("flattens and elides %j", (input, expected) => {
    expect(droppedPreview(input)).toBe(expected);
  });
});
