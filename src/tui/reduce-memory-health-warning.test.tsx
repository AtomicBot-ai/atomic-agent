import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { formatSubcallHealthWarning } from "../memory/health/index.js";
import { reduceTuiState } from "./agent-event-reducer.js";
import { ChatLog } from "./components/chat-log.js";
import { fakeSession } from "./test-fixtures.js";
import { createInitialTuiState } from "./tui-state.js";
import type { TuiAction } from "./tui-action.js";

const MESSAGE = formatSubcallHealthWarning({
  kind: "reflection",
  outcome: "timeout",
  consecutive: 3,
});

function warningFor(sessionId: string): TuiAction {
  return {
    type: "agent_event",
    sessionId,
    event: {
      type: "memory_health_warning",
      kind: "reflection",
      outcome: "timeout",
      consecutive: 3,
      setting: "memory.reflection.timeoutMs",
      message: MESSAGE,
    },
  };
}

const ON_SCREEN = fakeSession({ sessionId: "s-on-screen" });

function strip(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b\]8;;[^\u0007]*\u0007/g, "");
}

describe("memory_health_warning in the TUI", () => {
  it("leaves one warn-styled system notice and a yellow feed line", () => {
    const initial = createInitialTuiState(ON_SCREEN);
    const next = reduceTuiState(initial, warningFor("s-on-screen"));

    expect(next.messages).toHaveLength(initial.messages.length + 1);
    const notice = next.messages.at(-1);
    expect(notice).toMatchObject({
      role: "system",
      variant: "warn",
      text: MESSAGE,
    });
    const feed = next.feed.at(-1);
    expect(feed?.color).toBe("yellow");
    expect(feed?.line).toBe(
      "» memory reflection timed out 3× in a row — memory.reflection.timeoutMs",
    );
    // A notice, not a turn: the composer state is untouched.
    expect(next.status).toBe(initial.status);
  });

  it("ignores a warning for a session that is not on screen", () => {
    const initial = createInitialTuiState(ON_SCREEN);
    const next = reduceTuiState(initial, warningFor("some-other-session"));
    expect(next).toBe(initial);
  });

  it("renders the notice with the setting to change", () => {
    const initial = createInitialTuiState(ON_SCREEN);
    const state = reduceTuiState(initial, warningFor("s-on-screen"));
    const { lastFrame, unmount } = render(<ChatLog state={state} />);
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("Memory reflection timed out 3 times in a row");
    expect(text).toContain("memory.reflection.timeoutMs");
    unmount();
  });
});
