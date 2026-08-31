import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { ClipboardProvider } from "../clipboard/clipboard-context.js";
import { makeMouseSource } from "../mouse/mouse-source.js";
import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "../tui-app.js";
import type { TuiSessionInfo } from "../tui-state.js";

/**
 * The composer overlay versus the mouse registry.
 *
 * The expanded composer paints over live chat controls (`[copy]` under
 * every reply). Terminals have no compositing and the registry resolves
 * clicks by painted rectangles, so the covered control's rectangle
 * still contains the click — the overlay's `MOUSE_LAYER_PANEL`
 * backstop is the only thing standing between a click on composer
 * pixels and a copy nobody asked for. These cases pin that down from
 * the outside: through `TuiApp`, real Ink layout, real hit-testing.
 */

const SESSION: TuiSessionInfo = {
  sessionId: "s1",
  workingDir: "/tmp/overlay-mouse",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

const strip = (value: string): string =>
  value.replace(/\[[0-9;]*m/g, "");

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
  const copied: string[] = [];
  const submitted: string[] = [];
  const clipboard = {
    copy: async (text: string) => {
      copied.push(text);
      return true;
    },
  };
  const callbacks: TuiAppCallbacks = {
    onApprovalDecision: () => {},
    onAbort: () => {},
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
  const reply = (text: string): void =>
    bus.emit({
      type: "agent_event",
      event: { type: "llm_event", event: { type: "assistant_reply", text } },
    });
  return {
    ...app,
    mouse,
    copied,
    submitted,
    reply,
    frame: () => strip(app.lastFrame() ?? ""),
  };
}

const copyRows = (frame: string): number =>
  frame.split("\n").filter((line) => line.includes("[copy]")).length;

describe("composer overlay mouse", () => {
  it("claims clicks over covered chat controls and releases them on shrink", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("send"), "composer on screen");
    app.reply("REF-ALPHA anchor line");
    app.reply("OMEGA-COVERED bottom line");
    await waitUntil(() => copyRows(app.frame()) === 2, "two copy rows");

    // Sanity: with the composer collapsed the second reply's `[copy]`
    // is clickable. Re-click until it lands — targets register a frame
    // after they first paint.
    const spot = locateLast(app.frame(), "[copy]");
    await waitUntil(() => {
      app.mouse.emit(click(spot.x + 1, spot.y));
      return app.copied.length > 0;
    }, "copy click to land while uncovered");
    expect(app.copied[0]).toBe("OMEGA-COVERED bottom line");
    const copiesBefore = app.copied.length;

    // Grow the composer over that control.
    app.stdin.write("abc");
    await waitUntil(() => app.frame().includes("abc"), "typed text");
    app.stdin.write("\n\n\n");
    await waitUntil(
      () => copyRows(app.frame()) === 1,
      "second copy row covered by the overlay",
    );

    // The control is still laid out under the overlay, its rectangle
    // still contains the click — the backstop must eat it.
    for (let i = 0; i < 5; i += 1) {
      app.mouse.emit(click(spot.x + 1, spot.y));
      await delay(40);
    }
    expect(app.copied.length).toBe(copiesBefore);

    // The composer's own controls stay clickable THROUGH the overlay:
    // Send sits inside the expanded frame and must win against the
    // backstop (smaller box, same layer).
    const send = locateLast(app.frame(), "send →");
    await waitUntil(() => {
      app.mouse.emit(click(send.x + 1, send.y));
      return app.submitted.length > 0;
    }, "send click to land on the expanded composer");
    expect(app.submitted[0]).toContain("abc");

    // Submit cleared the buffer, so the composer is collapsed again and
    // the covered control is back — intact and clickable.
    await waitUntil(() => copyRows(app.frame()) === 2, "copy rows restored");
    const restored = locateLast(app.frame(), "[copy]");
    await waitUntil(() => {
      app.mouse.emit(click(restored.x + 1, restored.y));
      return app.copied.length > copiesBefore;
    }, "copy click to land again after shrink");
    app.unmount();
  });

  it("keeps the see-through row above the frame clickable while expanded", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("send"), "composer on screen");
    app.reply("REF-ALPHA anchor line");
    app.reply("OMEGA-COVERED bottom line");
    await waitUntil(() => copyRows(app.frame()) === 2, "two copy rows");
    const collapsedTop = locateLast(app.frame(), "\u256d").y;

    // A two-line draft grows the frame exactly one row, which parks the
    // second reply's `[copy]` in the see-through spacer row directly
    // above the top border — live pixels, so they must take clicks.
    app.stdin.write("abc\n");
    await waitUntil(
      () => locateLast(app.frame(), "\u256d").y === collapsedTop - 1,
      "composer one row taller",
    );
    const spot = locateLast(app.frame(), "[copy]");
    expect(spot.y).toBe(collapsedTop - 2);

    // The backstop hugs the frame, not the whole overlay: a rectangle
    // that included the spacer row would eat this click at
    // MOUSE_LAYER_PANEL and the visible control would go dead.
    await waitUntil(() => {
      app.mouse.emit(click(spot.x + 1, spot.y));
      return app.copied.length > 0;
    }, "copy click to land in the spacer row");
    expect(app.copied[0]).toBe("OMEGA-COVERED bottom line");
    app.unmount();
  });

  it("keeps the open menu's rows visible and clickable over a tall draft", async () => {
    const app = mountApp();
    await waitUntil(() => app.frame().includes("send"), "composer on screen");
    app.stdin.write("abc");
    await waitUntil(() => app.frame().includes("abc"), "typed text");
    const collapsedTop = locateLast(app.frame(), "\u256d").y;
    app.stdin.write("\n".repeat(9));
    await waitUntil(
      () => locateLast(app.frame(), "\u256d").y === collapsedTop - 9,
      "expanded composer",
    );

    // Open the menu from the breadcrumb — the mouse route, and the one
    // that keeps the draft (Esc would clear it first). The menu owns
    // input; the overlay clamps to its slot, so every menu row is
    // painted — including `Manage`, which the ten-line frame's
    // rectangle used to bury. Re-click until it lands: targets register
    // a frame after they first paint.
    await waitUntil(() => {
      if (!app.frame().includes("enter go")) {
        const crumb = locateLast(app.frame(), "R U N");
        app.mouse.emit(click(crumb.x + 1, crumb.y));
      }
      return app.frame().includes("enter go");
    }, "menu open from the breadcrumb");
    // The row is visible at all — this locate is the half a regression
    // breaks first: un-clamped, `Manage` is overpainted and not on
    // screen, so there is nothing honest to click.
    const manage = locateLast(app.frame(), "Manage");
    // Wait out the backdrop's click grace so a click cannot be read as
    // "clicked outside" while the menu's own targets register.
    await delay(200);
    await waitUntil(() => {
      // Re-emit only while still on the root menu: once MANAGE opens,
      // more clicks at these coordinates would drill into its rows.
      if (!app.frame().includes("MANAGE")) {
        app.mouse.emit(click(manage.x + 1, manage.y));
      }
      return app.frame().includes("MANAGE");
    }, "the visible Manage row to take the click");
    // The click drove the menu, not the composer behind it: nothing
    // was submitted and the draft is intact for when the menu closes.
    expect(app.submitted.length).toBe(0);
    app.unmount();
  });
});
