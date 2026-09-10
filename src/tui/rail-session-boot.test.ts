import { describe, expect, it } from "vitest";

import { harness, spokenTo } from "./rail-session-harness.js";

/**
 * `start()` runs after Ink mounted and the rail refresh is its first
 * step. A store that cannot answer must cost the rail, not the boot.
 */
describe("rail session list — boot", () => {
  it("boots with an empty rail and a notice when the store cannot list", async () => {
    const { orchestrator, rail, actions } = harness([], {
      listSummaries: () => {
        throw new Error("database disk image is malformed");
      },
    });
    try {
      expect(() => orchestrator.start()).not.toThrow();
      expect(rail()).toEqual([]);
      const notice = actions.find(
        (a) => a.type === "runtime_info" && a.line.startsWith("session list unavailable:"),
      );
      expect(notice).toMatchObject({
        line: "session list unavailable: database disk image is malformed",
      });
      // The boot went on past the rail: the tasks pane still got its data.
      expect(actions.some((a) => a.type === "tasks_refreshed")).toBe(true);
    } finally {
      await orchestrator.shutdown();
    }
  });

  it("says how many rows it skipped when the store holds unreadable ones", async () => {
    const { orchestrator, rail, actions } = harness([spokenTo("s-old", "older")], {
      countUnreadable: () => 2,
    });
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
        actions.some((a) => a.type === "runtime_info" && a.line.includes("unreadable")),
      ).toBe(false);
    } finally {
      await orchestrator.shutdown();
    }
  });
});
