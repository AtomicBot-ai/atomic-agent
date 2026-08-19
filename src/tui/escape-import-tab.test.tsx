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

describe("Esc on the Import tab", () => {
  it("returns to Run instead of being swallowed by the form", async () => {
    let quit = 0;
    const callbacks: TuiAppCallbacks = {
      onApprovalDecision: () => {},
      onAbort: () => {},
      onQuit: () => {
        quit++;
      },
      onMessageSubmitted: () => {},
    };
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={callbacks} />,
    );
    await settle();
    bus.emit({ type: "ui_mode_set", mode: "debug" });
    bus.emit({ type: "tab_changed", tab: "import" });
    await settle();
    expect(strip(lastFrame() ?? "")).toContain("\u25b8 Import");


    stdin.write(ESC);
    await settle();

    // The configure-mode handler ends in a catch-all `return true` that
    // swallows stray letters; before the fix it swallowed Esc too, so the
    // operator was stuck on the tab with no "back" gesture at all.
    // The rail dropped its breadcrumb row, so "on the Run screen" is now
    // the run-mode strip, which only renders on the chat surface.
    expect(strip(lastFrame() ?? "")).toContain("\u25b8 Local");
    expect(quit).toBe(0);
    unmount();
  });
});
