import { describe, expect, it } from "vitest";

import { harness, spokenTo } from "./rail-session-harness.js";
import type { TuiAction } from "./tui-action.js";

/**
 * `start()` runs after Ink mounted and the rail refresh is its first
 * step. A store that cannot answer must cost the rail, not the boot.
 */
describe("rail session list — boot", () => {
  /**
   * Every `session list unavailable:` line, not just the first: the boot
   * has two reads of the same store and they share this line, so the
   * count is the assertion.
   */
  function unavailableLines(actions: readonly TuiAction[]): readonly string[] {
    return actions
      .filter(
        (a): a is Extract<TuiAction, { type: "runtime_info" }> =>
          a.type === "runtime_info",
      )
      .map((a) => a.line)
      .filter((line) => line.startsWith("session list unavailable:"));
  }

  it("boots with an empty rail and a notice when the store cannot list", async () => {
    const { orchestrator, rail, actions } = harness([], {
      listSummaryPage: () => {
        throw new Error("database disk image is malformed");
      },
    });
    try {
      expect(() => orchestrator.start()).not.toThrow();
      expect(rail()).toEqual([]);
      expect(unavailableLines(actions)).toEqual([
        "session list unavailable: database disk image is malformed",
      ]);
      // The boot went on past the rail: the tasks pane still got its data.
      expect(actions.some((a) => a.type === "tasks_refreshed")).toBe(true);
    } finally {
      await orchestrator.shutdown();
    }
  });

  it("says so when the unreadable-row count is the read that fails", async () => {
    // `countUnreadable()` is the boot's other read of the session table
    // and the only thing `start()`'s own catch still covers now that the
    // rail refresh reports itself.
    const { orchestrator, rail, actions } = harness(
      [spokenTo("s-old", "older")],
      {
        countUnreadable: () => {
          throw new Error("no such table: sessions_unreadable");
        },
      },
    );
    try {
      expect(() => orchestrator.start()).not.toThrow();
      // The rail read succeeded, so the list is painted either way.
      expect(rail().map((entry) => entry.sessionId)).toEqual(["s-old"]);
      expect(unavailableLines(actions)).toEqual([
        "session list unavailable: no such table: sessions_unreadable",
      ]);
      expect(actions.some((a) => a.type === "tasks_refreshed")).toBe(true);
    } finally {
      await orchestrator.shutdown();
    }
  });

  it("says it once, not twice, when both of the boot's reads fail", async () => {
    // `database disk image is malformed` is the failure that takes out
    // both reads. The rail refresh now reports its own failure and
    // `countUnreadable()` then throws the same message into `start()`'s
    // catch — one store fault, one line, the way it read before the rail
    // grew a guard of its own.
    const { orchestrator, actions } = harness([], {
      listSummaries: () => {
        throw new Error("database disk image is malformed");
      },
      countUnreadable: () => {
        throw new Error("database disk image is malformed");
      },
    });
    try {
      expect(() => orchestrator.start()).not.toThrow();
      expect(unavailableLines(actions)).toEqual([
        "session list unavailable: database disk image is malformed",
      ]);
      expect(actions.some((a) => a.type === "tasks_refreshed")).toBe(true);
    } finally {
      await orchestrator.shutdown();
    }
  });

  it("says how many rows it skipped when the store holds unreadable ones", async () => {
    const { orchestrator, rail, actions } = harness(
      [spokenTo("s-old", "older")],
      {
        countUnreadable: () => 2,
      },
    );
    try {
      orchestrator.start();
      expect(rail().map((entry) => entry.sessionId)).toEqual(["s-old"]);
      expect(actions).toContainEqual({
        type: "runtime_info",
        line: "2 unreadable session(s) skipped",
      });
    } finally {
      await orchestrator.shutdown();
    }
  });

  it("stays quiet about unreadable rows when there are none", async () => {
    const { orchestrator, actions } = harness([spokenTo("s-old", "older")]);
    try {
      orchestrator.start();
      expect(
        actions.some(
          (a) => a.type === "runtime_info" && a.line.includes("unreadable"),
        ),
      ).toBe(false);
    } finally {
      await orchestrator.shutdown();
    }
  });
});
