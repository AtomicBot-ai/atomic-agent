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
  approvalLevel: 5,
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

/**
 * Poll the rendered frame until it satisfies `match`, then return it. Ink
 * renders on its own schedule and a loaded runner stretches it, so a fixed
 * sleep is a coin flip for anything that also waits on a timer.
 */
async function waitForFrame(
  lastFrame: () => string | undefined,
  match: (text: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = strip(lastFrame() ?? "");
  while (!match(text) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
    text = strip(lastFrame() ?? "");
  }
  return text;
}

describe("TuiApp (smoke)", () => {
  it("renders the chat surface with the compact operator status bar", () => {
    const bus = makeTuiEventBus();
    const { lastFrame, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("atomic-agent");
    // The status bar shows where you are, not a menu of where you could go —
    // the three-section pill row moved into the ctrl+p menu.
    expect(text).toContain("Run");
    expect(text).not.toContain("Observe");
    expect(text).not.toContain("Manage");
    // The splash mark scales with the window; ink-testing-library's
    // 100-column stdout reports no rows, so the fallback 80x24 surface
    // gets the compact mark rather than the wordmark + tagline. Assert
    // on what every size keeps. See `components/splash-fit.render.test.tsx`.
    expect(text).toContain(":::");
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
    expect(before).toContain("Run");
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 10));
    const after = strip(lastFrame() ?? "");
    if (before.includes("Sessions")) {
      // Sidebar visible: Tab lands focus on the rail and stays in
      // chat mode. Ctrl+B is the dedicated key for nav cycling.
      expect(after).toContain("Run");
      expect(after).not.toContain("Observe \u25b8");
    } else {
      // Sidebar collapsed (narrow runner): Tab falls back to the nav
      // cycle and lands on Observe → Feed.
      expect(after).toContain("Observe \u25b8 Feed");
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
    expect(text).toContain("Observe \u25b8 Feed");
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
    expect(text).toContain("Manage \u25b8");
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
    expect(text).toContain("Press ←/→ to switch mode");
    expect(text).not.toContain("Local runtime");
    unmount();
  });

  it("a keypress landing between a tab switch and its focus teardown stays out of the chat buffer", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    await new Promise((r) => setTimeout(r, 30));

    // Switch to the Tasks panel via the bus (state update outside React's
    // event system), then yield exactly two immediates: the first lets the
    // render commit — panel active, editor focus computed false, useInput
    // handler refs updated — the second lands BEFORE the passive effect
    // that tears the editor's stale isActive subscription down. A key
    // written in that window used to be delivered to the panel AND the
    // editor at once: the tasks search row, the slash palette and a "/"
    // in the prompt all opened from one keystroke.
    bus.emit({ type: "ui_mode_set", mode: "debug" });
    bus.emit({ type: "tab_changed", tab: "tasks" });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    stdin.write("/");

    await new Promise((r) => setTimeout(r, 60));
    const text = strip(lastFrame() ?? "");
    // The panel owns the key: its search row opens…
    expect(text).toContain("Tasks");
    // …and nothing leaks into the chat surface: no seeded "/" in the
    // prompt, no slash palette riding along with it.
    expect(text).not.toMatch(/❯\s*\//);
    expect(text).not.toContain("/dump");
    unmount();
  });

  it("Esc from an idle Manage panel returns to the Run screen", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    bus.emit({ type: "ui_mode_set", mode: "debug" });
    bus.emit({ type: "tab_changed", tab: "tasks" });
    await new Promise((r) => setTimeout(r, 10));
    expect(strip(lastFrame() ?? "")).toContain("Manage \u25b8");

    stdin.write("\u001b");
    await new Promise((r) => setTimeout(r, 60));
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("Run");
    expect(text).not.toContain("Manage \u25b8");
    unmount();
  });

  it("ctrl+p opens the operator menu over the prompt", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    stdin.write(String.fromCharCode(16));
    await new Promise((r) => setTimeout(r, 20));
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("Menu");
    expect(text).toContain("GO");
    expect(text).toContain("Manage");
    expect(text).toContain("esc close");
    unmount();
  });

  it("typing in the menu searches instead of reaching the prompt", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    stdin.write(String.fromCharCode(16));
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("privacy");
    await new Promise((r) => setTimeout(r, 20));
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("Privacy");
    // The query lives in the menu, never in the editor buffer underneath.
    expect(text).not.toContain("> privacy");
    unmount();
  });

  it("ctrl+g then a chord jumps straight to a panel, and the chord letter never reaches the prompt", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    stdin.write(String.fromCharCode(7));
    await new Promise((r) => setTimeout(r, 30));
    stdin.write("t");
    await new Promise((r) => setTimeout(r, 30));
    const text = strip(lastFrame() ?? "");
    expect(text).toContain("Manage");
    expect(text).toContain("Tasks");
    // Ink delivers every key to every useInput, child first — so the editor
    // sees the chord letter too. If the leader did not disable it, a stray
    // "t" would be sitting in the prompt right now.
    expect(text).not.toMatch(/[>\u276f]\s+t\s*$/m);
    unmount();
  });

  it("an armed ctrl+g is visible in the hint strip and disarms itself when no chord follows", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    stdin.write(String.fromCharCode(7));
    const armed = await waitForFrame(lastFrame, (t) =>
      t.includes("waiting for a chord"),
    );
    expect(armed).toContain("waiting for a chord");

    // Nothing follows the leader. It must disarm on its own — while it is
    // armed the editor is unfocused and the next keystroke is swallowed.
    // No key is pressed here on purpose: only the timer can end this state.
    const idle = await waitForFrame(
      lastFrame,
      (t) => !t.includes("waiting for a chord"),
    );
    expect(idle).not.toContain("waiting for a chord");
    // Idle chips are back, and no chord fired on the way out. Matched on the
    // chip key, not its label: a narrow runner wraps the strip and can split
    // "menu" off its own chip.
    expect(idle).toContain("[ctrl+p]");
    expect(idle).not.toContain("Manage ▸");
    unmount();
  });

  it("esc closes the menu and leaves the screen it was opened over", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    stdin.write(String.fromCharCode(16));
    await new Promise((r) => setTimeout(r, 20));
    expect(strip(lastFrame() ?? "")).toContain("esc close");
    stdin.write(String.fromCharCode(27));
    await new Promise((r) => setTimeout(r, 20));
    const text = strip(lastFrame() ?? "");
    expect(text).not.toContain("esc close");
    expect(text).toContain("Run");
    unmount();
  });

  it("floats over the UI without moving it — the frame below is unchanged", async () => {
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={noopCallbacks()} />,
    );
    await new Promise((r) => setTimeout(r, 10));
    const before = strip(lastFrame() ?? "").split("\n");
    stdin.write(String.fromCharCode(16));
    await new Promise((r) => setTimeout(r, 25));
    const after = strip(lastFrame() ?? "").split("\n");

    // A popup composites on top; it must not add rows or push the prompt and
    // the hint strip down the way an inline panel would.
    expect(after.length).toBe(before.length);
    expect(after.at(-1)).toBe(before.at(-1));
    expect(after.some((line) => line.includes("Menu"))).toBe(true);
    unmount();
  });
});
