import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import {
  makeTuiEventBus,
  TuiApp,
  type TuiAppCallbacks,
} from "./tui-app.js";
import type { TuiSessionInfo } from "./tui-state.js";

const SESSION: TuiSessionInfo = {
  sessionId: null,
  workingDir: "/tmp/smoke",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalRequired: false,
  maxSteps: 10,
  skillCount: 0,
};

function noopCallbacks(): TuiAppCallbacks {
  return {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {},
    onMessageSubmitted: () => {},
  };
}

function strip(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b\]8;;[^\u0007]*\u0007/g, "");
}

describe("TuiApp (smoke)", () => {
  it("renders the single-view chat surface with header + editor", () => {
    const bus = makeTuiEventBus();
    const { lastFrame, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("atomic-agent");
    expect(text).toContain("cwd");
    expect(text).toContain("local operator agent");
    expect(text).toContain("commands");
    unmount();
  });

  it("switches to the debug pane when ui_mode_set is emitted", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    // Let the subscribe effect run before emitting, then give React a
    // microtask to flush the re-render the action triggers.
    await new Promise((r) => setTimeout(r, 10));
    bus.emit({ type: "ui_mode_set", mode: "debug" });
    await new Promise((r) => setTimeout(r, 10));
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("Feed");
    expect(text).toContain("Logs");
    unmount();
  });
});
