import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "./tui-app.js";
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

/**
 * Ink holds a lone Esc byte for `pendingInputFlushDelayMilliseconds`
 * (20ms) to disambiguate it from a longer escape sequence, so every
 * assertion waits past that flush window before reading the frame.
 */
const ESC = String.fromCharCode(27);
const FLUSH_MS = 60;

const strip = (value: string): string =>
  value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b\]8;;[^\u0007]*\u0007/g, "");

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, FLUSH_MS));

function trackingCallbacks(counts: { quit: number; abort: number }): TuiAppCallbacks {
  return {
    onApprovalDecision: () => {},
    onAbort: () => {
      counts.abort++;
    },
    onQuit: () => {
      counts.quit++;
    },
    onMessageSubmitted: () => {},
  };
}

describe("Esc in the chat editor", () => {
  it("does not quit an idle agent", async () => {
    const counts = { quit: 0, abort: 0 };
    const bus = makeTuiEventBus();
    const { stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={trackingCallbacks(counts)} />,
    );
    await settle();

    stdin.write(ESC);
    await settle();

    expect(counts.quit).toBe(0);
    expect(counts.abort).toBe(0);
    unmount();
  });

  it("clears a half-typed draft instead of killing the agent", async () => {
    const counts = { quit: 0, abort: 0 };
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={trackingCallbacks(counts)} />,
    );
    await settle();
    stdin.write("draft message");
    await settle();
    expect(strip(lastFrame() ?? "")).toContain("draft message");

    stdin.write(ESC);
    await settle();

    expect(strip(lastFrame() ?? "")).not.toContain("draft message");
    expect(counts.quit).toBe(0);
    unmount();
  });

  it("survives leaving a Manage panel and pressing Esc again", async () => {
    // The reported trap: Esc walks back from the panel to Run, and the
    // next Esc — the natural "and back out of here too" press — used to
    // terminate the agent.
    const counts = { quit: 0, abort: 0 };
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={trackingCallbacks(counts)} />,
    );
    await settle();
    bus.emit({ type: "ui_mode_set", mode: "debug" });
    bus.emit({ type: "tab_changed", tab: "skills" });
    await settle();

    stdin.write(ESC);
    await settle();
    expect(strip(lastFrame() ?? "")).toContain("▸ Run");
    expect(counts.quit).toBe(0);

    stdin.write(ESC);
    await settle();
    expect(counts.quit).toBe(0);

    stdin.write(ESC);
    await settle();
    expect(counts.quit).toBe(0);
    unmount();
  });
});
