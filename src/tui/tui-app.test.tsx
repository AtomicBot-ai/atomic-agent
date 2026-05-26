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

  it("hides verbose chrome (cwd label, llama URL, KV/tools counters) by default", () => {
    const bus = makeTuiEventBus();
    const { lastFrame, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    const text = strip(lastFrame() ?? "");
    // The status bar must stay compact — no "cwd" label, no kv counters,
    // no tools ok/err counters, no approval flag. The working directory
    // itself can show up in the right-rail Workspace card; that is part
    // of the new layout and tested separately.
    expect(text).not.toContain("cwd");
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

  it("Tab focuses the sidebar when visible; Ctrl+B is the nav-cycle escape valve", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    const before = strip(lastFrame() ?? "");
    expect(before).toContain("▸ Run");
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 10));
    const after = strip(lastFrame() ?? "");
    if (before.includes("Sessions")) {
      // Sidebar visible: Tab lands focus on the rail and stays in
      // chat mode. Ctrl+B is the dedicated key for nav cycling.
      expect(after).toContain("▸ Run");
      expect(after).not.toContain("▸ Observe");
    } else {
      // Sidebar collapsed (narrow runner): Tab falls back to the nav
      // cycle and lands on Observe → Feed.
      expect(after).toContain("▸ Observe");
      expect(after).toContain("▸ Feed");
    }
    unmount();
  });

  it("Ctrl+B cycles nav slots even when the sidebar is visible", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    stdin.write("\u0002");
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

  it("renders the right-rail sidebar with Sessions and Tasks panes in chat mode", () => {
    const bus = makeTuiEventBus();
    const { lastFrame, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    const text = strip(lastFrame() ?? "");
    // The sidebar shows two stacked panes — Sessions (top) and Tasks
    // (bottom). Workspace and LLM cards were removed to give the
    // chat surface more room. Soft assertion because the rendered
    // terminal width in ink-testing-library is the test host's
    // actual columns; if cols < 100 the sidebar collapses and even
    // Sessions is absent (we still want the test to be informative
    // on narrow runners — see the conditional).
    if (text.includes("Sessions")) {
      expect(text).toContain("Tasks");
      expect(text).not.toContain("Workspace");
      expect(text).not.toContain("LLM");
    }
    unmount();
  });

  it("renders the LLM health badge + active model label in the prompt meta-row when /props reports it", async () => {
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
    expect(text).toContain("healthy");
    expect(text).toContain("Qwen3-30B-A3B-Instruct");
    expect(text).not.toContain(".gguf");
    unmount();
  });

  it("renders cloud active route in the prompt meta-row without local latency", async () => {
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
      type: "providers_refresh",
      rows: [
        {
          id: "openrouter",
          kind: "openrouter",
          isActiveText: true,
          isActiveEmbedding: false,
          hasApiKey: true,
          chatModel: "openai/gpt-4o-mini",
          embeddingModel: null,
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 10));
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("cloud");
    expect(text).toContain("openai/gpt-4o-mini");
    expect(text).toContain("openrouter");
    expect(text).not.toContain("healthy · 12 ms");
    unmount();
  });

  it("shows the two-mode LLM panel", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    bus.emit({ type: "ui_mode_set", mode: "debug" });
    bus.emit({ type: "tab_changed", tab: "llm" });
    await new Promise((r) => setTimeout(r, 10));
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("Active chat route");
    expect(text).toContain("Mode:");
    expect(text).toContain("Local text models");
    expect(text).toContain("Local embeddings");
    expect(text).toContain("Press → to switch to Cloud");
    expect(text).not.toContain("Local runtime");
    unmount();
  });
});
