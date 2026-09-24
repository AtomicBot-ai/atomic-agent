import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "./tui-app.js";
import type { TuiSessionInfo } from "./tui-state.js";

/**
 * The abort chord as a terminal actually delivers it.
 *
 * Esc followed by a character inside Ink's flush window is not two
 * keystrokes: it is the Alt-prefix encoding, and Ink reports a single
 * `1` with `meta` set and no lone Esc at all. Typing the chord quickly
 * is the normal way to type it, so the binding has to complete on that
 * shape as well as on the armed-then-confirmed one — otherwise the
 * abort works or does not depending on how fast the operator types.
 */
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
/** What the terminal sends for Esc-then-1 typed as one gesture. */
const ALT_1 = `${ESC}1`;
const FLUSH_MS = 60;

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, FLUSH_MS));

function trackingCallbacks(counts: { abort: number }): TuiAppCallbacks {
  return {
    onApprovalDecision: () => {},
    onAbort: () => {
      counts.abort++;
    },
    onQuit: () => {},
    onMessageSubmitted: () => {},
  };
}

function mount(counts: { abort: number }) {
  const bus = makeTuiEventBus();
  const handle = render(
    <TuiApp
      session={SESSION}
      bus={bus}
      callbacks={trackingCallbacks(counts)}
    />,
  );
  return { bus, ...handle };
}

describe("the abort chord typed as one gesture", () => {
  it("aborts a running turn on the alt-prefixed 1", async () => {
    const counts = { abort: 0 };
    const { bus, stdin, unmount } = mount(counts);
    await settle();
    bus.emit({ type: "message_submitted" });
    await settle();

    stdin.write(ALT_1);
    await settle();

    expect(counts.abort).toBe(1);
    unmount();
  });

  it("leaves an idle session alone", async () => {
    // The chord is bounded by `status === "running"`, so the same bytes
    // on an idle session must not reach the abort at all.
    const counts = { abort: 0 };
    const { stdin, unmount } = mount(counts);
    await settle();

    stdin.write(ALT_1);
    await settle();

    expect(counts.abort).toBe(0);
    unmount();
  });

  it("does not abort on a bare 1 during a run", async () => {
    // Nothing armed it and there is no Alt prefix, so this is ordinary
    // input — the regression that would make every typed digit a hazard
    // while a turn is in flight.
    const counts = { abort: 0 };
    const { bus, stdin, unmount } = mount(counts);
    await settle();
    bus.emit({ type: "message_submitted" });
    await settle();

    stdin.write("1");
    await settle();

    expect(counts.abort).toBe(0);
    unmount();
  });
});
