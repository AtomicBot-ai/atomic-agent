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

describe("Esc while a turn is running", () => {
  it("aborts the run from the chat surface", async () => {
    const counts = { quit: 0, abort: 0 };
    const bus = makeTuiEventBus();
    const { stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={trackingCallbacks(counts)} />,
    );
    await settle();
    bus.emit({ type: "message_submitted" });
    await settle();

    stdin.write(ESC);
    await settle();

    // The editor is `disabled` for the whole run, which switches its
    // `useInput` off — so this has to be claimed by the global key layer
    // or the advertised "[esc] abort" does nothing at all.
    expect(counts.abort).toBeGreaterThan(0);
    expect(counts.quit).toBe(0);
    unmount();
  });

  it("aborts the run from a debug tab too", async () => {
    const counts = { quit: 0, abort: 0 };
    const bus = makeTuiEventBus();
    const { stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={trackingCallbacks(counts)} />,
    );
    await settle();
    bus.emit({ type: "ui_mode_set", mode: "debug" });
    bus.emit({ type: "tab_changed", tab: "logs" });
    bus.emit({ type: "message_submitted" });
    await settle();

    stdin.write(ESC);
    await settle();

    // The hint strip checks `running` before `uiMode === "debug"`, so a
    // run in flight aborts rather than navigating back to Run.
    expect(counts.abort).toBeGreaterThan(0);
    expect(counts.quit).toBe(0);
    unmount();
  });

  it("leaves an idle session alone", async () => {
    const counts = { quit: 0, abort: 0 };
    const bus = makeTuiEventBus();
    const { stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={trackingCallbacks(counts)} />,
    );
    await settle();
    bus.emit({ type: "ui_mode_set", mode: "debug" });
    bus.emit({ type: "tab_changed", tab: "tasks" });
    await settle();

    stdin.write(ESC);
    await settle();

    expect(counts.abort).toBe(0);
    unmount();
  });
});
