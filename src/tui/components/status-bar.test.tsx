import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { StatusBar } from "./status-bar.js";
import { fakeSession } from "../test-fixtures.js";
import {
  createInitialTuiState,
  type SessionPickerEntry,
  type TuiState,
} from "../tui-state.js";

const SESSION_ID = "s-f134037c";

function entry(preview: string): SessionPickerEntry {
  return {
    sessionId: SESSION_ID,
    workingDir: "/tmp",
    turnCount: 1,
    stepCount: 1,
    updatedAt: Date.now(),
    preview,
    pinned: false,
  };
}

function stateWithPreview(preview: string): TuiState {
  const base = createInitialTuiState(fakeSession({ sessionId: SESSION_ID }));
  return { ...base, recentSessions: [entry(preview)] };
}

/**
 * The bar's rows, colour codes and all. Nothing here matches across a
 * style change, so the frame is read raw rather than stripped: the
 * assertions are about how many rows there are and which run of plain
 * text sits inside one of them.
 */
function rowsOf(state: TuiState): string[] {
  const { lastFrame } = render(<StatusBar state={state} brand={false} />);
  return (lastFrame() ?? "").split("\n");
}

describe("StatusBar", () => {
  it("stays one row when the first prompt was multi-line", () => {
    // The bug: previews are stored as typed, so the newlines reached Ink
    // and it grew the bar to seven rows, pushing the rail, the chat and
    // the composer down the screen.
    const rows = rowsOf(stateWithPreview("ONE\none\n1\n1\n1\n1\n1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("ONE one 1 1 1 1 1");
  });

  it("still shows a single-line prompt unchanged", () => {
    const rows = rowsOf(stateWithPreview("How are you?"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("How are you?");
  });

  it("ellipsises a long prompt instead of running past the bar", () => {
    const rows = rowsOf(stateWithPreview("word ".repeat(40)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("…");
  });

  it("draws no title when the session has no readable preview", () => {
    const rows = rowsOf(stateWithPreview("   \n\n  "));
    expect(rows).toHaveLength(1);
    // The session id left the bar with the `RUN` badge: it is a lookup
    // key for a log, not something to read at a glance. What has to
    // stay true is that an unnamed session draws no title separator.
    expect(rows[0]).not.toContain("session ");
    expect(rows[0]).not.toContain("·");
  });
});

describe("the chat surface keeps its row without the RUN badge", () => {
  it("draws no section badge on the Run screen", () => {
    const rows = rowsOf(stateWithPreview("fix the abort chord"));
    expect(rows.join("\n")).not.toContain("R U N");
  });

  it("still occupies exactly one row when it has nothing to draw", () => {
    // An empty Box has no height, and losing the row moved the whole
    // app up a line — every mouse target with it.
    const rows = rowsOf(stateWithPreview(""));
    expect(rows).toHaveLength(1);
  });
});
