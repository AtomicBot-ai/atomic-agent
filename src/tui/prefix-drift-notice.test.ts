import { describe, expect, it } from "vitest";

import type { PrefixDriftEvent } from "../agent/prefix-drift-warning.js";
import { reduceTuiState } from "./agent-event-reducer.js";
import { createInitialTuiState, type TuiSessionInfo, type TuiState } from "./tui-state.js";

/**
 * ATO-316. A stable-prefix change between steps reaches the TUI as a
 * short, non-blocking line: a chat warning when nothing explains it,
 * a dim feed line when the runtime rebuilt the prefix on purpose.
 */

function fakeSession(overrides: Partial<TuiSessionInfo> = {}): TuiSessionInfo {
  return {
    sessionId: null,
    workingDir: "/tmp",
    llamaUrl: "http://127.0.0.1:8080",
    browserChannel: "chrome",
    browserHeadless: false,
    approvalLevel: 5,
    maxSteps: 10,
    completionMaxTokens: 2048,
    skillCount: 0,
    localBackendConfigured: false,
    ...overrides,
  };
}

const drift = (over: Partial<PrefixDriftEvent> = {}): PrefixDriftEvent => ({
  type: "prefix_drift",
  stepIndex: 2,
  changedSections: ["tools"],
  expected: false,
  reasons: [],
  repeat: false,
  ...over,
});

function reduce(event: PrefixDriftEvent, sessionId = "s1"): { initial: TuiState; next: TuiState } {
  const initial = createInitialTuiState(fakeSession({ sessionId: "s1" }));
  const next = reduceTuiState(initial, { type: "agent_event", sessionId, event });
  return { initial, next };
}

describe("prefix drift notice (ATO-316)", () => {
  it("warns in the chat about unexpected drift, naming the section", () => {
    const { next } = reduce(drift());
    const last = next.messages.at(-1);
    expect(last?.role).toBe("system");
    expect(last?.text).toContain("Warning:");
    expect(last?.text).toContain("(tool catalog)");
  });

  it("keeps a repeat of the same drift out of the chat, as a yellow feed line", () => {
    const { initial, next } = reduce(drift({ repeat: true }));
    expect(next.messages).toEqual(initial.messages);
    expect(next.feed.at(-1)).toMatchObject({ kind: "runtime_info", color: "yellow", stepIndex: 2 });
  });

  it("shows expected drift only as a dim feed line with its reason", () => {
    const { initial, next } = reduce(
      drift({ changedSections: ["skills"], expected: true, reasons: ["skills refreshed"] }),
    );
    expect(next.messages).toEqual(initial.messages);
    expect(next.feed.at(-1)).toMatchObject({
      kind: "runtime_info",
      color: "gray",
      line: "» prompt prefix rebuilt (skills): skills refreshed",
    });
  });

  it("does not paint a background session's drift into the chat on screen", () => {
    const { initial, next } = reduce(drift(), "s2");
    expect(next.messages).toEqual(initial.messages);
  });
});
