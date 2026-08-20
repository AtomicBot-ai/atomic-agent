import { render } from "ink-testing-library";
import { createElement, useReducer, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { reduceTuiState } from "./agent-event-reducer.js";
import { MultiLineEditor } from "./components/multi-line-editor.js";
import { createInitialTuiState, type TuiSessionInfo } from "./tui-state.js";

const SESSION: TuiSessionInfo = {
  sessionId: "s1",
  workingDir: "/tmp",
  llamaUrl: "http://127.0.0.1:19091",
  browserChannel: "chromium",
  browserHeadless: true,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

const UP = "\u001b[A";
const DOWN = "\u001b[B";
const LEFT = "\u001b[D";
const RIGHT = "\u001b[C";

/**
 * Renders the real editor against the real reducer, wired exactly as
 * `tui-app` wires them, so these assertions exercise the true keystroke
 * path rather than a hand-rolled stand-in.
 */
function Harness(): ReactElement {
  const [state, dispatch] = useReducer(reduceTuiState, undefined, () => ({
    ...createInitialTuiState(SESSION),
    inputHistory: ["first", "second"],
  }));
  return createElement(MultiLineEditor, {
    value: state.inputValue,
    focus: true,
    onChange: (next: string) => dispatch({ type: "input_changed", value: next }),
    onSubmit: () => {},
    onHistoryPrev: () => dispatch({ type: "input_history_navigated", delta: -1 }),
    onHistoryNext: () => dispatch({ type: "input_history_navigated", delta: 1 }),
  });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("editor arrow keys vs input history", () => {
  it("restores the typed draft after Up then Down", async () => {
    const { stdin, lastFrame } = render(createElement(Harness));
    await settle();
    stdin.write("hello draft");
    await settle();
    expect(lastFrame()).toContain("hello draft");

    stdin.write(UP);
    await settle();
    expect(lastFrame()).toContain("second");

    stdin.write(DOWN);
    await settle();
    expect(lastFrame()).toContain("hello draft");
  });

  it("does not wipe the draft when Left/Right move the caret", async () => {
    const { stdin, lastFrame } = render(createElement(Harness));
    await settle();
    stdin.write("keep me");
    await settle();

    stdin.write(LEFT);
    await settle();
    expect(lastFrame()).toContain("keep me");

    stdin.write(RIGHT);
    await settle();
    expect(lastFrame()).toContain("keep me");
  });

  it("keeps walking further back when Left is pressed mid-recall", async () => {
    const { stdin, lastFrame } = render(createElement(Harness));
    await settle();
    stdin.write("draft");
    await settle();

    stdin.write(UP);
    await settle();
    expect(lastFrame()).toContain("second");

    // Caret movement must not drop the recall position.
    stdin.write(LEFT);
    await settle();
    stdin.write(UP);
    await settle();
    expect(lastFrame()).toContain("first");

    stdin.write(DOWN);
    await settle();
    expect(lastFrame()).toContain("second");
    stdin.write(DOWN);
    await settle();
    expect(lastFrame()).toContain("draft");
  });
});
