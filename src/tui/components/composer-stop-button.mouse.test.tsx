import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { ClipboardProvider } from "../clipboard/clipboard-context.js";
import { makeMouseSource } from "../mouse/mouse-source.js";
import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "../tui-app.js";
import type { TuiSessionInfo } from "../tui-state.js";

/**
 * The stop chip versus the running turn.
 *
 * Esc, Ctrl+C and `/abort` all stop the agent, but they are keyboard
 * lore; the chip is the one *visible* control. These cases pin down the
 * whole loop from the outside — through `TuiApp`, real Ink layout, real
 * hit-testing: absent while idle, present while a turn is in flight,
 * a click on it lands on `onAbort` (the same callback Esc reaches),
 * and it leaves the field when the run ends.
 */

const SESSION: TuiSessionInfo = {
  sessionId: "s1",
  workingDir: "/tmp/stop-button-mouse",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

/** The chip's on-screen label — glyph included, so a hint strip's plain
 * "stop" wording can never satisfy the assertions below. */
const STOP_LABEL = "■ stop";

const strip = (value: string): string => value.replace(/\[[0-9;]*m/g, "");

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(
  condition: () => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function click(x: number, y: number): TuiMouseEvent {
  return {
    kind: "press",
    button: "left",
    wheel: null,
    x,
    y,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

/** Screen cell of the LAST line containing `needle`. */
function locateLast(
  frame: string,
  needle: string,
): { x: number; y: number } {
  const lines = frame.split("\n");
  for (let y = lines.length - 1; y >= 0; y -= 1) {
    const x = (lines[y] ?? "").indexOf(needle);
    if (x !== -1) return { x, y };
  }
  throw new Error(`"${needle}" is not on screen:\n${frame}`);
}

function mountApp() {
  const bus = makeTuiEventBus();
  const mouse = makeMouseSource();
  const submitted: string[] = [];
  let aborted = 0;
  const clipboard = {
    copy: async () => true,
  };
  const callbacks: TuiAppCallbacks = {
    onApprovalDecision: () => {},
    onAbort: () => {
      aborted += 1;
    },
    onQuit: () => {},
    onMessageSubmitted: (message) => {
      submitted.push(message);
    },
  };
  const app = render(
    <ClipboardProvider writer={clipboard}>
      <TuiApp session={SESSION} bus={bus} callbacks={callbacks} mouse={mouse} />
    </ClipboardProvider>,
  );
  return {
    ...app,
    mouse,
    submitted,
    aborted: () => aborted,
    finishRun: () =>
      bus.emit({
        type: "agent_event",
        event: { type: "loop_completed", reason: "reply" },
      }),
    frame: () => strip(app.lastFrame() ?? ""),
  };
}

describe("composer stop button", () => {
  it("appears while a turn runs, aborts on click, leaves when the run ends", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("send"), "composer on screen");
    // Idle: no run to stop, so no chip to press.
    expect(app.frame()).not.toContain(STOP_LABEL);

    // Submitting a message starts a turn; the chip must come with it.
    app.stdin.write("do the thing");
    await waitUntil(() => app.frame().includes("do the thing"), "typed text");
    app.stdin.write("\r");
    await waitUntil(() => app.submitted.length === 1, "message submitted");
    await waitUntil(
      () => app.frame().includes(STOP_LABEL),
      "stop chip on screen while running",
    );

    // A click on the chip is exactly Esc: `onAbort`, once per press.
    // Re-click until it lands — targets register a frame after they
    // first paint.
    const spot = locateLast(app.frame(), STOP_LABEL);
    await waitUntil(() => {
      app.mouse.emit(click(spot.x + 1, spot.y));
      return app.aborted() > 0;
    }, "stop click to land");
    const landed = app.aborted();
    // The click stopped at the chip: it must not have doubled as a
    // submit / steer of the (empty) buffer.
    expect(app.submitted.length).toBe(1);

    // One settled press must not have queued extra aborts behind the
    // first that landed.
    await delay(100);
    expect(app.aborted()).toBe(landed);

    // Run over: the chip has nothing left to act on and leaves the field.
    app.finishRun();
    await waitUntil(
      () => !app.frame().includes(STOP_LABEL),
      "stop chip gone after the run ended",
    );
    app.unmount();
  });
});
