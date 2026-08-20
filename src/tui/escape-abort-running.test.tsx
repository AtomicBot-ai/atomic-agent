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
const PAGE_UP = `${String.fromCharCode(27)}[5~`;
const FLUSH_MS = 60;
/** Comfortably past the 24-row `ink-testing-library` default viewport. */
const TALL_CHAT_LINES = 40;

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
    // or the advertised "[esc] abort" does nothing at all. Exactly once:
    // the editor's own Esc handler no longer carries a second copy of
    // the abort, which would double-fire once it stays live during a run.
    expect(counts.abort).toBe(1);
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
    expect(counts.abort).toBe(1);
    expect(counts.quit).toBe(0);
    unmount();
  });

  it("snaps a scrolled-back chat home first and keeps the turn alive", async () => {
    const counts = { quit: 0, abort: 0 };
    const bus = makeTuiEventBus();
    const { stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={trackingCallbacks(counts)} />,
    );
    await settle();
    bus.emit({ type: "message_submitted" });
    // A chat taller than the viewport, or `ChatLog` clamps the scroll
    // straight back to 0 and PageUp is a no-op.
    for (let i = 0; i < TALL_CHAT_LINES; i++) {
      bus.emit({ type: "system_message", text: `line ${i}` });
    }
    await settle();

    // Read back through the streaming answer, then press the Esc the
    // scroll-reset rung documents as "snap to the latest reply before
    // doing anything else".
    stdin.write(PAGE_UP);
    await settle();
    stdin.write(ESC);
    await settle();

    expect(counts.abort).toBe(0);

    // The offset is back at 0, so the next Esc means abort — which also
    // proves the first one consumed the scroll rather than falling
    // through and leaving the chat pinned mid-history.
    stdin.write(ESC);
    await settle();

    expect(counts.abort).toBe(1);
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
