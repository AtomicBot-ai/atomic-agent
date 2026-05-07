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
  it("renders the chat surface with the compact operator status bar", () => {
    const bus = makeTuiEventBus();
    const { lastFrame, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("atomic-agent");
    expect(text).toContain("Run");
    expect(text).toContain("Observe");
    expect(text).toContain("Manage");
    expect(text).toContain("local operator agent");
    expect(text).toContain("commands");
    unmount();
  });

  it("hides verbose chrome (cwd, llama URL, KV/tools counters) by default", () => {
    const bus = makeTuiEventBus();
    const { lastFrame, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    const text = strip(lastFrame() ?? "");
    expect(text).not.toContain("cwd");
    expect(text).not.toContain("/tmp/smoke");
    expect(text).not.toContain("kv");
    expect(text).not.toContain("tools 0ok/0err");
    expect(text).not.toContain("approval");
    unmount();
  });

  it("switches to the Observe section when ui_mode_set is emitted", async () => {
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
    expect(text).toContain("Observe");
    expect(text).toContain("Feed");
    expect(text).toContain("Logs");
    // Manage-only tabs should not be in the Observe sub-tab strip.
    expect(text).not.toContain("Tasks");
    expect(text).not.toContain("Telegram");
    unmount();
  });

  it("shows Manage sub-tabs when the Manage section is active", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    bus.emit({ type: "ui_mode_set", mode: "debug" });
    bus.emit({ type: "tab_changed", tab: "tasks" });
    await new Promise((r) => setTimeout(r, 10));
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("Manage");
    expect(text).toContain("Tasks");
    expect(text).toContain("Skills");
    expect(text).toContain("Telegram");
    // Observe-only tabs should be hidden from the Manage sub-tab strip.
    expect(text).not.toContain("Feed");
    expect(text).not.toContain("Reasoning");
    unmount();
  });

  it("cycles Observe sub-tabs from the focused editor with Tab", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    bus.emit({ type: "ui_mode_set", mode: "debug" });
    await new Promise((r) => setTimeout(r, 10));
    expect(strip(lastFrame() ?? "")).toContain("▸ Feed");

    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 10));
    expect(strip(lastFrame() ?? "")).toContain("▸ World");
    unmount();
  });

  it("cycles Observe sub-tabs backwards from the focused editor with Shift+Tab", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    bus.emit({ type: "ui_mode_set", mode: "debug" });
    bus.emit({ type: "tab_changed", tab: "world" });
    await new Promise((r) => setTimeout(r, 10));
    expect(strip(lastFrame() ?? "")).toContain("▸ World");

    stdin.write("\u001b[Z");
    await new Promise((r) => setTimeout(r, 10));
    expect(strip(lastFrame() ?? "")).toContain("▸ Feed");
    unmount();
  });

  it("jumps from chat into the Observe section on Tab", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(strip(lastFrame() ?? "")).toContain("▸ Run");
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 10));
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("▸ Observe");
    expect(text).toContain("▸ Feed");
    unmount();
  });

  it("returns to chat when Shift+Tab is pressed from the Run screen", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("\u001b[Z");
    await new Promise((r) => setTimeout(r, 10));
    const text = strip(lastFrame() ?? "");
    // Shift+Tab from Run wraps to the last Manage sub-tab (Telegram).
    expect(text).toContain("▸ Manage");
    expect(text).toContain("▸ Telegram");
    unmount();
  });

  it("renders the active model label in the status bar when /props reports it", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    bus.emit({
      type: "llm_health_updated",
      status: "healthy",
      latencyMs: 12,
      error: null,
      checkedAt: Date.now(),
    });
    bus.emit({
      type: "llm_model_updated",
      model: "Qwen3-30B-A3B-Instruct.gguf",
    });
    await new Promise((r) => setTimeout(r, 10));
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("llm");
    expect(text).toContain("Qwen3-30B-A3B-Instruct");
    unmount();
  });
});
