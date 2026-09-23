import { describe, expect, it } from "vitest";

import {
  MEMORY_SUBCALL_STREAK_THRESHOLD,
  classifySubcallOutcome,
  createSubcallHealthTracker,
  type MemorySubcallKind,
  type MemorySubcallOutcome,
  type SubcallHealthTracker,
} from "./track-subcall-health.js";

function feed(
  tracker: SubcallHealthTracker,
  outcomes: readonly MemorySubcallOutcome[],
  kind: MemorySubcallKind = "reflection",
  sessionId = "s-1",
  reason?: string,
) {
  return outcomes.map((outcome) =>
    tracker.record({ sessionId, kind, outcome, ...(reason ? { reason } : {}) }),
  );
}

describe("createSubcallHealthTracker", () => {
  it("warns on the third consecutive timeout, not before", () => {
    const tracker = createSubcallHealthTracker();
    const results = feed(tracker, ["timeout", "timeout", "timeout"]);
    expect(results.slice(0, 2)).toEqual([null, null]);
    expect(results[2]).toMatchObject({
      kind: "reflection",
      outcome: "timeout",
      consecutive: 3,
      setting: "memory.reflection.timeoutMs",
    });
    expect(MEMORY_SUBCALL_STREAK_THRESHOLD).toBe(3);
  });

  it.each(["ok", "none", "skipped"] as const)(
    "a healthy %s resets the streak",
    (healthy) => {
      const tracker = createSubcallHealthTracker();
      const results = feed(
        tracker,
        ["failed", "failed", healthy, "failed", "failed"],
        "link_generator",
      );
      expect(results.every((r) => r === null)).toBe(true);
      // ...and the streak it restarted still reaches the threshold.
      expect(feed(tracker, ["failed"], "link_generator")[0]).not.toBeNull();
    },
  );

  it("a rewriter gate that declined to call the model resets the streak", () => {
    const tracker = createSubcallHealthTracker();
    const results = feed(
      tracker,
      ["timeout", "timeout", "skipped_not_referential", "timeout", "timeout"],
      "rewriter",
    );
    expect(results.every((r) => r === null)).toBe(true);
  });

  it("aborted is neutral: it neither counts nor resets", () => {
    const tracker = createSubcallHealthTracker();
    const results = feed(tracker, [
      "timeout",
      "aborted",
      "timeout",
      "aborted",
      "aborted",
      "timeout",
    ]);
    expect(results.slice(0, 5).every((r) => r === null)).toBe(true);
    expect(results[5]).toMatchObject({ outcome: "timeout", consecutive: 3 });
  });

  it("warns once per session and kind, however long the streak runs", () => {
    const tracker = createSubcallHealthTracker();
    const first = feed(tracker, Array(10).fill("failed"), "vote");
    expect(first.filter((r) => r !== null)).toHaveLength(1);
    // A recovery and a fresh streak do not re-arm it either.
    const second = feed(tracker, ["ok", "failed", "failed", "failed"], "vote");
    expect(second.every((r) => r === null)).toBe(true);
  });

  it("keeps each kind's streak separate", () => {
    const tracker = createSubcallHealthTracker();
    for (let i = 0; i < 2; i += 1) {
      expect(feed(tracker, ["timeout"], "reflection")[0]).toBeNull();
      expect(feed(tracker, ["timeout"], "vote")[0]).toBeNull();
    }
    expect(feed(tracker, ["ok"], "vote")[0]).toBeNull();
    expect(feed(tracker, ["timeout"], "reflection")[0]).toMatchObject({
      kind: "reflection",
    });
    expect(feed(tracker, ["timeout"], "vote")[0]).toBeNull();
  });

  it("keeps each session's streak and once-only flag separate", () => {
    const tracker = createSubcallHealthTracker();
    feed(tracker, ["failed", "failed"], "rewriter", "a");
    feed(tracker, ["failed", "failed"], "rewriter", "b");
    expect(feed(tracker, ["failed"], "rewriter", "a")[0]).not.toBeNull();
    // `a` having warned does not silence `b`.
    expect(feed(tracker, ["failed"], "rewriter", "b")[0]).not.toBeNull();
  });

  it("names the switch and quotes the last failure's reason", () => {
    const tracker = createSubcallHealthTracker();
    tracker.record({ sessionId: "s", kind: "vote", outcome: "failed", reason: "old" });
    tracker.record({ sessionId: "s", kind: "vote", outcome: "timeout" });
    const warning = tracker.record({
      sessionId: "s",
      kind: "vote",
      outcome: "failed",
      reason: "Invalid schema for response_format\n  'vote_output'",
    });
    expect(warning).toMatchObject({
      outcome: "failed",
      setting: "memory.voting.enabled",
      reason: "Invalid schema for response_format 'vote_output'",
    });
    expect(warning?.message).toContain("memory.voting.enabled");
    expect(warning?.message).toContain("Invalid schema for response_format");
  });

  it("falls back to an earlier reason when the tipping failure has none", () => {
    const tracker = createSubcallHealthTracker();
    feed(tracker, ["failed"], "rewriter", "s", "503 upstream");
    const warning = feed(tracker, ["failed", "failed"], "rewriter", "s")[1];
    expect(warning?.reason).toBe("503 upstream");
  });

  it("a streak ending in a timeout is a timeout warning, without a reason", () => {
    const tracker = createSubcallHealthTracker();
    feed(tracker, ["failed", "failed"], "link_generator", "s", "boom");
    const warning = feed(tracker, ["timeout"], "link_generator", "s")[0];
    expect(warning).toMatchObject({
      outcome: "timeout",
      setting: "memory.links.generatorTimeoutMs",
    });
    expect(warning?.reason).toBeUndefined();
  });

  it("honours a custom threshold", () => {
    const tracker = createSubcallHealthTracker({ threshold: 1 });
    expect(feed(tracker, ["timeout"])[0]).not.toBeNull();
  });
});

describe("classifySubcallOutcome", () => {
  it("sorts every runner outcome", () => {
    expect(classifySubcallOutcome("timeout")).toBe("unhealthy");
    expect(classifySubcallOutcome("failed")).toBe("unhealthy");
    expect(classifySubcallOutcome("aborted")).toBe("neutral");
    for (const healthy of [
      "ok",
      "none",
      "skipped",
      "skipped_no_history",
      "skipped_not_referential",
    ] as const) {
      expect(classifySubcallOutcome(healthy)).toBe("healthy");
    }
  });
});
