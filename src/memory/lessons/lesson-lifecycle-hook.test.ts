import { describe, expect, it, vi } from "vitest";

import type { LessonStore } from "./lesson-store.js";

import { createLessonLifecycleHook } from "./lesson-lifecycle-hook.js";

/**
 * Phase 6 — `createLessonLifecycleHook` is the agent-loop seam that
 * translates terminal-verb outcomes into `LessonStore.bumpSuccess` /
 * `bumpFailure` calls. The hook itself owns no state; these tests
 * pin the once-per-id contract, the success/failure routing, and
 * the fire-safety guarantee.
 */

function makeMockStore(): {
  store: LessonStore;
  success: number[];
  failure: number[];
} {
  const success: number[] = [];
  const failure: number[] = [];
  const store = {
    bumpSuccess(id: number) {
      success.push(id);
      return true;
    },
    bumpFailure(id: number) {
      failure.push(id);
      return true;
    },
  } as unknown as LessonStore;
  return { store, success, failure };
}

describe("createLessonLifecycleHook (phase 6)", () => {
  it("routes 'success' to bumpSuccess for every id", () => {
    const m = makeMockStore();
    const hook = createLessonLifecycleHook({ lessonStore: m.store });
    hook.recordTurnOutcome({
      sessionId: "s",
      surfacedLessonIds: [1, 2, 3],
      outcome: "success",
    });
    expect(m.success).toEqual([1, 2, 3]);
    expect(m.failure).toEqual([]);
  });

  it("routes 'failure' to bumpFailure for every id", () => {
    const m = makeMockStore();
    const hook = createLessonLifecycleHook({ lessonStore: m.store });
    hook.recordTurnOutcome({
      sessionId: "s",
      surfacedLessonIds: [7, 8],
      outcome: "failure",
    });
    expect(m.failure).toEqual([7, 8]);
    expect(m.success).toEqual([]);
  });

  it("deduplicates ids defensively (callers may pass duplicates)", () => {
    const m = makeMockStore();
    const hook = createLessonLifecycleHook({ lessonStore: m.store });
    hook.recordTurnOutcome({
      sessionId: "s",
      surfacedLessonIds: [1, 1, 2, 1, 2],
      outcome: "success",
    });
    expect(m.success.sort()).toEqual([1, 2]);
  });

  it("is a no-op for empty surfacedLessonIds", () => {
    const m = makeMockStore();
    const hook = createLessonLifecycleHook({ lessonStore: m.store });
    hook.recordTurnOutcome({
      sessionId: "s",
      surfacedLessonIds: [],
      outcome: "success",
    });
    expect(m.success).toEqual([]);
    expect(m.failure).toEqual([]);
  });

  it("swallows bump errors and keeps processing siblings", () => {
    const success: number[] = [];
    const failed: number[] = [];
    const store = {
      bumpSuccess(id: number) {
        if (id === 2) throw new Error("boom");
        success.push(id);
        return true;
      },
      bumpFailure(id: number) {
        failed.push(id);
        return true;
      },
    } as unknown as LessonStore;
    const logger = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };
    const hook = createLessonLifecycleHook({
      lessonStore: store,
      logger: logger as never,
    });
    hook.recordTurnOutcome({
      sessionId: "s",
      surfacedLessonIds: [1, 2, 3],
      outcome: "success",
    });
    // `2` throws, but `1` and `3` still landed.
    expect(success.sort()).toEqual([1, 3]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
