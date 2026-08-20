import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "./tui-app.js";
import { OBSERVE_TABS } from "./section.js";
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
 * A lone Esc byte is held back by Ink's input parser for
 * `pendingInputFlushDelayMilliseconds` (20ms) so it can be disambiguated
 * from the start of a longer escape sequence. Every assertion therefore
 * has to wait past that flush window before reading the frame.
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

describe("Esc on the Observe tabs", () => {
  for (const tab of OBSERVE_TABS) {
    it(`returns to Run from "${tab}" instead of quitting the agent`, async () => {
      const counts = { quit: 0, abort: 0 };
      const bus = makeTuiEventBus();
      const { lastFrame, stdin, unmount } = render(
        <TuiApp session={SESSION} bus={bus} callbacks={trackingCallbacks(counts)} />,
      );
      await settle();
      bus.emit({ type: "ui_mode_set", mode: "debug" });
      bus.emit({ type: "tab_changed", tab });
      await settle();
      expect(strip(lastFrame() ?? "")).toContain("Observe ▸");

      stdin.write(ESC);
      await settle();

      // The hint strip promises "[esc] back to Run" on every debug tab.
      // These five have no panel key layer, so before the fix the keypress
      // reached the still-focused chat editor and quit the process.
      expect(counts.quit).toBe(0);
      expect(counts.abort).toBe(0);
      expect(strip(lastFrame() ?? "")).toContain("Run");
      unmount();
    });
  }

  it("does not quit when Esc is pressed twice from an Observe tab", async () => {
    const counts = { quit: 0, abort: 0 };
    const bus = makeTuiEventBus();
    const { stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={trackingCallbacks(counts)} />,
    );
    await settle();
    bus.emit({ type: "ui_mode_set", mode: "debug" });
    bus.emit({ type: "tab_changed", tab: "logs" });
    await settle();

    stdin.write(ESC);
    await settle();
    expect(counts.quit).toBe(0);
    unmount();
  });
});
