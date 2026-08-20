import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import {
  computeSidebarRowBudget,
  isSidebarVisible,
  SIDEBAR_CHROME_ROWS,
  SIDEBAR_MIN_COLUMNS,
  SIDEBAR_MIN_ROWS,
} from "../layout.js";
import type { TaskSummaryRow } from "../tasks/tasks-panel-state.js";
import type { SessionPickerEntry } from "../tui-state.js";
import { Sidebar } from "./sidebar.js";

/** Colour codes never carry a newline, so the raw frame counts fine. */
function frameRows(frame: string): number {
  return frame.split("\n").length;
}

/** Long enough that both panes always hide a tail and draw a footer. */
const SESSIONS: readonly SessionPickerEntry[] = Array.from(
  { length: 40 },
  (_, idx) => ({
    sessionId: `s-${idx}`,
    workingDir: "/tmp/fit",
    turnCount: 1,
    stepCount: 1,
    updatedAt: 0,
    preview: `session ${idx}`,
  }),
);

const TASKS: readonly TaskSummaryRow[] = Array.from(
  { length: 40 },
  (_, idx) => ({
    id: `t-${idx}`,
    status: "pending",
    origin: "tui",
    triggerSource: "user",
    sessionId: null,
    userMessage: `task ${idx}`,
    scheduleKind: null,
    scheduleLabel: "-",
    recurring: false,
    scheduledFor: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    completedAt: null,
    attempts: 0,
    maxAttempts: 3,
    lastError: null,
  }),
);

function renderRail(rows: number): number {
  const budget = computeSidebarRowBudget(rows);
  const { lastFrame } = render(
    <Sidebar
      width={30}
      maxSessionRows={budget.sessions}
      maxTaskRows={budget.tasks}
      sessions={SESSIONS}
      sessionsCursor={0}
      currentSessionId={null}
      tasks={TASKS}
      tasksCursor={0}
      activeSection="sessions"
      focused={false}
    />,
  );
  return frameRows(lastFrame() ?? "");
}

/**
 * Regression guard for "a wide but short terminal garbles the rail",
 * the sibling of `splash-fit.render.test.tsx`. Ink 7 does NOT clip a
 * frame taller than the terminal — it overlaps earlier lines — so the
 * row budget has to be a promise the rendered component keeps, and a
 * window too short to keep it must lose the rail entirely.
 *
 * The rail is drawn under a one-row status bar, so its own frame gets
 * `rows - 1` at most.
 */
describe("Sidebar fit", () => {
  it("renders inside every terminal height that still draws it", () => {
    // 24 rows is where the budget saturates at its 10/5 caps, so every
    // distinct split the arithmetic can produce is covered here. The
    // exact cost — two section headers, the blank row between the
    // panes and a "↓ N more" footer per pane — is asserted alongside
    // the fit so `SIDEBAR_CHROME_ROWS` cannot drift away from the
    // component it describes. The left border is the only border edge
    // the rail draws, so it costs columns, not rows.
    for (let rows = SIDEBAR_MIN_ROWS; rows <= 24; rows += 1) {
      expect(isSidebarVisible(SIDEBAR_MIN_COLUMNS, rows)).toBe(true);
      const budget = computeSidebarRowBudget(rows);
      const rendered = renderRail(rows);
      expect(rendered).toBe(
        budget.sessions + budget.tasks + SIDEBAR_CHROME_ROWS,
      );
      expect(rendered).toBeLessThanOrEqual(rows - 1);
    }
  });

  it("is dropped rather than squeezed in a wide but short window", () => {
    // 100x8 is a split tmux pane; 100x5 is a terminal docked under an
    // editor. Both used to budget three list rows into a rail that
    // rendered ten rows deep.
    for (const [columns, rows] of [
      [100, 8],
      [100, 5],
      [1, 1],
      [0, 0],
    ] as const) {
      expect(isSidebarVisible(columns, rows)).toBe(false);
    }
  });
});
