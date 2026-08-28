import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { Sidebar } from "./sidebar.js";
import {
  countRunningTasks,
  selectSidebarTasks,
} from "../sidebar-tasks-selector.js";
import type { TaskSummaryRow } from "../tasks/tasks-panel-state.js";
import type { SessionPickerEntry } from "../tui-state.js";

const ANSI = /[\u001b\u009b][[()#;?]*.{0,2}(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function strip(text: string): string {
  return text.replace(ANSI, "");
}

const SESSIONS: readonly SessionPickerEntry[] = [
  {
    sessionId: "abcdef1234",
    workingDir: "/tmp/foo",
    turnCount: 3,
    stepCount: 5,
    updatedAt: Date.now() - 60_000,
    preview: "first ever message in the session",
  },
  {
    sessionId: "ghijkl5678",
    workingDir: "/tmp/bar",
    turnCount: 1,
    stepCount: 2,
    updatedAt: Date.now() - 600_000,
    preview: "another conversation",
  },
];

function taskRow(overrides: Partial<TaskSummaryRow>): TaskSummaryRow {
  return {
    id: "t-1",
    status: "pending",
    origin: "tui",
    triggerSource: "user",
    sessionId: null,
    userMessage: "do the thing",
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
    ...overrides,
  };
}

const TASKS: readonly TaskSummaryRow[] = [
  taskRow({ id: "t-running", status: "running", userMessage: "running task" }),
  taskRow({ id: "t-pending", status: "pending", userMessage: "pending task" }),
];

describe("Sidebar", () => {
  it("renders both Sessions and Tasks section headers", () => {
    const { lastFrame } = render(
      <Sidebar
        width={32}
        sessions={SESSIONS}
        sessionsCursor={0}
        currentSessionId="abcdef1234"
        tasks={TASKS}
        tasksCursor={0}
        activeSection="sessions"
        focused={false}
      />,
    );
    const text = strip(lastFrame() ?? "");
    // Upper-case since the rail became the app frame — it carries the
    // brand, the version and the menu button now, so its own headings
    // read as labels rather than as content.
    expect(text).toContain("SESSIONS");
    expect(text).toContain("TASKS");
    expect(text).not.toContain("Workspace");
    expect(text).not.toContain("LLM");
  });

  it("puts a + new chip on the Tasks header with the counter mid-gap", () => {
    const { lastFrame } = render(
      <Sidebar
        width={32}
        sessions={SESSIONS}
        sessionsCursor={0}
        currentSessionId="abcdef1234"
        tasks={TASKS}
        tasksCursor={0}
        activeSection="sessions"
        focused={false}
      />,
    );
    const line = strip(lastFrame() ?? "")
      .split("\n")
      .find((candidate) => candidate.includes("TASKS"));
    // Both headers carry the control, so minting a task is exactly as
    // discoverable as minting a session. The trailing literal space
    // pins the chip's own padding cell, leaving the groups with the
    // spacers alone.
    const match = /TASKS(\s+)1 running(\s+) \+ new/.exec(line ?? "");
    expect(match).not.toBeNull();
    // The counter sits in the MIDDLE of the gap: real air on both
    // sides, split evenly give or take the cell Yoga cannot halve.
    const [, before, after] = match!;
    expect(before!.length).toBeGreaterThanOrEqual(2);
    expect(after!.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(before!.length - after!.length)).toBeLessThanOrEqual(1);
  });

  it("counts running tasks over the full snapshot, not the visible slice", () => {
    // Seven running, five rows on the rail: the header must still say
    // seven. The count travels as its own prop because the `tasks`
    // prop is the projected slice — counting it is how "5 running"
    // got printed under seven live tasks.
    const rows = Array.from({ length: 7 }, (_, idx) =>
      taskRow({ id: `run-${idx}`, status: "running", userMessage: `run ${idx}` }),
    );
    const { lastFrame } = render(
      <Sidebar
        width={32}
        sessions={SESSIONS}
        sessionsCursor={0}
        currentSessionId={null}
        tasks={selectSidebarTasks(rows)}
        tasksCursor={0}
        activeSection="sessions"
        focused={false}
        runningTaskCount={countRunningTasks(rows)}
      />,
    );
    expect(strip(lastFrame() ?? "")).toContain("7 running");
  });

  it("shows the empty state when there are no sessions", () => {
    const { lastFrame } = render(
      <Sidebar
        width={32}
        sessions={[]}
        sessionsCursor={0}
        currentSessionId={null}
        tasks={[]}
        tasksCursor={0}
        activeSection="sessions"
        focused={false}
      />,
    );
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("(no sessions yet)");
    expect(text).toContain("(no active tasks)");
  });

  it("highlights the cursor in Sessions only when focused on the Sessions pane", () => {
    const focused = render(
      <Sidebar
        width={32}
        sessions={SESSIONS}
        sessionsCursor={1}
        currentSessionId="abcdef1234"
        tasks={TASKS}
        tasksCursor={0}
        activeSection="sessions"
        focused={true}
      />,
    );
    const focusedText = strip(focused.lastFrame() ?? "");
    expect(focusedText).toContain("▸ ");
    const tasksFocused = render(
      <Sidebar
        width={32}
        sessions={SESSIONS}
        sessionsCursor={1}
        currentSessionId="abcdef1234"
        tasks={TASKS}
        tasksCursor={0}
        activeSection="tasks"
        focused={true}
      />,
    );
    // Tasks pane focused: chevron belongs to a task row, not a
    // session row — exactly one chevron in the frame.
    const tasksFocusedText = strip(tasksFocused.lastFrame() ?? "");
    const chevronCount = (tasksFocusedText.match(/▸/g) ?? []).length;
    expect(chevronCount).toBe(1);
  });

  it("puts the close mark on the selected session row only", () => {
    // An `x` on every row is a mis-click waiting to happen, so it rides
    // the row the cursor is already on.
    const focused = render(
      <Sidebar
        width={32}
        sessions={SESSIONS}
        sessionsCursor={0}
        currentSessionId="abcdef1234"
        tasks={TASKS}
        tasksCursor={0}
        activeSection="sessions"
        focused={true}
      />,
    );
    const text = strip(focused.lastFrame() ?? "");
    expect((text.match(/\[x\]/g) ?? []).length).toBe(1);

    const blurred = render(
      <Sidebar
        width={32}
        sessions={SESSIONS}
        sessionsCursor={0}
        currentSessionId="abcdef1234"
        tasks={TASKS}
        tasksCursor={0}
        activeSection="sessions"
        focused={false}
      />,
    );
    expect(strip(blurred.lastFrame() ?? "")).not.toContain("[x]");
  });

  it("renders task rows with status badges", () => {
    const { lastFrame } = render(
      <Sidebar
        width={32}
        sessions={SESSIONS}
        sessionsCursor={0}
        currentSessionId="abcdef1234"
        tasks={TASKS}
        tasksCursor={0}
        activeSection="sessions"
        focused={false}
      />,
    );
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("running task");
    expect(text).toContain("pending task");
  });
  it("honours the per-pane row budget instead of a fixed 10/5 split", () => {
    const manySessions = Array.from({ length: 12 }, (_, idx) => ({
      ...SESSIONS[0]!,
      sessionId: `s-${idx}`,
      preview: `session number ${idx}`,
    }));
    const manyTasks = Array.from({ length: 8 }, (_, idx) =>
      taskRow({ id: `t-${idx}`, userMessage: `task number ${idx}` }),
    );
    const { lastFrame } = render(
      <Sidebar
        width={32}
        sessions={manySessions}
        sessionsCursor={0}
        currentSessionId={null}
        tasks={manyTasks}
        tasksCursor={0}
        activeSection="sessions"
        focused={false}
        maxSessionRows={3}
        maxTaskRows={2}
      />,
    );
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("session number 2");
    expect(text).not.toContain("session number 3");
    expect(text).toContain("task number 1");
    expect(text).not.toContain("task number 2");
    // Both panes admit what they are hiding.
    expect(text).toContain("9 more");
    expect(text).toContain("6 more");
    // Two headers + 3 sessions + 2 tasks + 2 "more" rows + spacers, plus
    // the brand block (mark, wordmark, version), the menu button and the
    // breadcrumb slot the rail gained when it replaced the top bar.
    expect(strip(lastFrame() ?? "").split("\n").length).toBeLessThanOrEqual(22);
  });

  it("scrolls the Tasks pane to keep the cursor visible", () => {
    const manyTasks = Array.from({ length: 8 }, (_, idx) =>
      taskRow({ id: `t-${idx}`, userMessage: `task number ${idx}` }),
    );
    const { lastFrame } = render(
      <Sidebar
        width={32}
        sessions={SESSIONS}
        sessionsCursor={0}
        currentSessionId={null}
        tasks={manyTasks}
        tasksCursor={7}
        activeSection="tasks"
        focused={true}
        maxTaskRows={2}
      />,
    );
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("task number 7");
    expect(text).not.toContain("task number 0");
    // The chevron sits on the selected row, not on whatever row 0 is.
    expect(text).toMatch(/▸ [^\n]*task number 7/);
  });

  it("narrows the previews with the rail rather than overflowing it", () => {
    const long = [{ ...SESSIONS[0]!, preview: "a very long session preview indeed" }];
    const { lastFrame } = render(
      <Sidebar
        width={24}
        sessions={long}
        sessionsCursor={0}
        currentSessionId={null}
        tasks={[]}
        tasksCursor={0}
        activeSection="sessions"
        focused={false}
      />,
    );
    const widest = strip(lastFrame() ?? "")
      .split("\n")
      .reduce((acc, line) => Math.max(acc, line.replace(/\s+$/, "").length), 0);
    expect(widest).toBeLessThanOrEqual(24);
    expect(strip(lastFrame() ?? "")).toContain("…");
  });
});
