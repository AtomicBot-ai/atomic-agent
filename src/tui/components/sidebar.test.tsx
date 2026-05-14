import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { Sidebar } from "./sidebar.js";
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
    expect(text).toContain("Sessions");
    expect(text).toContain("Tasks");
    expect(text).not.toContain("Workspace");
    expect(text).not.toContain("LLM");
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
});
