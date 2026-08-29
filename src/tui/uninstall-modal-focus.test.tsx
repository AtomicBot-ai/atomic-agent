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

const ESC = String.fromCharCode(27);
/** Ink defers a lone Esc for 20ms; read the frame well past that. */
const FLUSH_MS = 60;

const strip = (value: string): string => value.replace(/\[[0-9;]*m/g, "");

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, FLUSH_MS));

function callbacks(counts: { quit: number }): TuiAppCallbacks {
  return {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {
      counts.quit += 1;
    },
    onMessageSubmitted: () => {},
  };
}

/**
 * The uninstall ladder is a modal, and `handleAppKey` already returns
 * `true` for every key it sees while one is up. That alone never made it
 * modal: the app handler and the chat editor are two independent
 * `useInput` subscriptions, and returning `true` from the first does not
 * stop the second. Only naming the state in `editorFocus` does.
 *
 * Before that, the confirmation word an operator typed went into the
 * ladder *and* into the draft behind it, and Esc closed the ladder and
 * then fell through to the editor's idle branch, opening the operator
 * menu in the same keypress.
 */
describe("the uninstall ladder holds the keyboard", () => {
  it("keeps typed keys out of the composer behind it", async () => {
    const counts = { quit: 0 };
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={callbacks(counts)} />,
    );
    await settle();
    bus.emit({ type: "uninstall_opened" });
    await settle();

    stdin.write("zqx");
    await settle();

    // The composer draws the draft after its caret. Those letters belong
    // to the ladder's own field, never to the transcript's input.
    expect(strip(lastFrame() ?? "")).not.toContain("❯ zqx");
    unmount();
  });

  it("closes on Esc without also opening the operator menu", async () => {
    const counts = { quit: 0 };
    const bus = makeTuiEventBus();
    const { lastFrame, stdin, unmount } = render(
      <TuiApp session={SESSION} bus={bus} callbacks={callbacks(counts)} />,
    );
    await settle();
    bus.emit({ type: "uninstall_opened" });
    await settle();

    stdin.write(ESC);
    await settle();

    expect(strip(lastFrame() ?? "")).not.toContain("MENU");
    expect(counts.quit).toBe(0);
    unmount();
  });
});
