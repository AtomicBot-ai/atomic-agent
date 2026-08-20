import { describe, expect, it } from "vitest";

import {
  isFailedSessionStatus,
  type SessionStatus,
} from "./session-state.js";

describe("isFailedSessionStatus", () => {
  it("treats failed and stalled as non-zero exits", () => {
    expect(isFailedSessionStatus("failed")).toBe(true);
    expect(isFailedSessionStatus("stalled")).toBe(true);
  });

  it("leaves every other status a success", () => {
    const rest: SessionStatus[] = [
      "pending",
      "running",
      "awaiting_approval",
      "awaiting_llm",
      "completed",
      "cancelled",
    ];
    for (const status of rest) {
      expect(isFailedSessionStatus(status)).toBe(false);
    }
  });

  it("covers every member of SessionStatus", () => {
    // Guards the list above: a new status added to the union without a
    // decision here would otherwise silently default to "success".
    const all: Record<SessionStatus, boolean> = {
      pending: false,
      running: false,
      awaiting_approval: false,
      awaiting_llm: false,
      completed: false,
      failed: true,
      cancelled: false,
      stalled: true,
    };
    for (const [status, expected] of Object.entries(all)) {
      expect(isFailedSessionStatus(status as SessionStatus)).toBe(expected);
    }
  });
});
