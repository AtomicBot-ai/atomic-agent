import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { DebugDiagnosticsLine } from "./components/debug-diagnostics-line.js";
import { reduceTuiState } from "./agent-event-reducer.js";
import {
  createInitialTuiState,
  type TuiSessionInfo,
  type TuiState,
} from "./tui-state.js";

const SESSION: TuiSessionInfo = {
  sessionId: "abc",
  workingDir: "/tmp",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  completionMaxTokens: 2048,
  skillCount: 12,
  localBackendConfigured: false,
};

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

function diagnosticsLine(state: TuiState): string {
  const { lastFrame } = render(createElement(DebugDiagnosticsLine, { state }));
  return (lastFrame() ?? "").replace(ANSI, "");
}

/**
 * The diagnostics row counts `skillCount`, which is the catalog the
 * prompt got — `skills.catalogTokenBudget` may have cut most of the
 * install out of it. PR #471 taught the prompt to say so; this row
 * still showed the clipped number as the install (issue #466).
 */
describe("the debug diagnostics skills field", () => {
  it("flags the skills the catalog budget left out", () => {
    const state: TuiState = {
      ...createInitialTuiState(SESSION),
      session: { ...SESSION, skillCountDropped: 28 },
    };
    expect(diagnosticsLine(state)).toContain("skills 12 (+28 not shown)");
  });

  it("is byte-identical to the pre-fix field when nothing was dropped", () => {
    // Both spellings of "nothing dropped": an explicit 0, and a state
    // built before the field existed at all.
    for (const session of [
      { ...SESSION, skillCountDropped: 0 },
      SESSION,
    ] as TuiSessionInfo[]) {
      const line = diagnosticsLine({
        ...createInitialTuiState(SESSION),
        session,
      });
      expect(line).toContain("skills 12");
      expect(line).not.toContain("not shown");
    }
  });

  it("keeps the dropped count live when the skill registry changes", () => {
    // An install can push the catalog over the budget, so the number
    // this row shows has to be able to stop growing and say why.
    const state = reduceTuiState(createInitialTuiState(SESSION), {
      type: "skill_count_changed",
      count: 13,
      dropped: 30,
    });
    expect(state.session.skillCount).toBe(13);
    expect(state.session.skillCountDropped).toBe(30);
    expect(diagnosticsLine(state)).toContain("skills 13 (+30 not shown)");
  });
});
