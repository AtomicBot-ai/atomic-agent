import { describe, expect, it } from "vitest";
import { parseAutofixKey } from "./pr-autofix-store.js";
import { clampWatchMinutes, planWatchRound, startWatch, watchDue } from "./pr-autofix-watch-state.js";

const NOW = new Date("2026-11-27T12:00:00Z");

describe("the PR autofix watch state (ATO-2516)", () => {
  it("clamps the interval to 5..120 minutes, default 10, and drops an unknown report target", () => {
    expect(clampWatchMinutes(undefined)).toBe(10);
    expect(clampWatchMinutes(1)).toBe(5);
    expect(clampWatchMinutes(999)).toBe(120);
    expect(startWatch({ sessionId: "s", notify: "email", everyMinutes: 15 }, NOW)).toMatchObject({
      notify: null,
      everyMs: 15 * 60_000,
      feedbackSeenAt: NOW.toISOString(),
    });
  });

  it("is due at once, then every interval", () => {
    const w = startWatch({ sessionId: "s", notify: null, everyMinutes: 10 }, NOW);
    expect(watchDue(w, NOW.getTime())).toBe(true);
    const polled = { ...w, lastPollAt: NOW.toISOString() };
    expect(watchDue(polled, NOW.getTime() + 9 * 60_000)).toBe(false);
    expect(watchDue(polled, NOW.getTime() + 10 * 60_000)).toBe(true);
  });

  it("pending or green CI is never a round; red, a conflict and newer feedback are, once each", () => {
    const w = startWatch({ sessionId: "s", notify: null, everyMinutes: 10 }, NOW);
    const quiet = { headSha: "a", checks: "pending" as const, conflict: false, newestFeedbackAt: null };
    expect(planWatchRound(w, quiet, NOW).reasons).toEqual([]);
    const busy = { headSha: "a", checks: "failure" as const, conflict: true, newestFeedbackAt: "2026-11-27T12:05:00Z" };
    const first = planWatchRound(w, busy, NOW);
    expect(first.reasons).toEqual(["ci", "conflict", "review"]);
    expect(planWatchRound(first.next, busy, NOW).reasons).toEqual([]);
    expect(planWatchRound(first.next, { ...busy, headSha: "b" }, NOW).reasons).toEqual(["ci", "conflict"]);
  });

  it("reads a state key back, and nothing else", () => {
    expect(parseAutofixKey("acme/widgets#42")).toEqual({ slug: "acme/widgets", number: 42 });
    expect(parseAutofixKey("acme#42")).toBeNull();
    expect(parseAutofixKey("acme/widgets#0")).toBeNull();
    expect(parseAutofixKey("../x/y#1")).toBeNull();
  });
});
