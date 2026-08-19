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
const TAB = "\t";
const FLUSH_MS = 80;

/**
 * The menu popup's footer. Asserting on the word "Menu" would not do —
 * the rail carries a `menu / ctrl+p` affordance whether the popup is up
 * or not, so that assertion is already true before the key is pressed.
 */
const MENU_FOOTER = "↑↓ move";

const BEL = String.fromCharCode(7);
// Built from `ESC` rather than written as literals: a raw control byte in
// a regex source is exactly what it looks like — a stray escape sequence
// — and every frame is full of SGR runs and OSC-8 hyperlinks that a
// `.toContain` would otherwise trip over.
const SGR = new RegExp(ESC + "\\[[0-9;]*m", "g");
const OSC8 = new RegExp(ESC + "\\]8;;[^" + BEL + "]*" + BEL, "g");

const strip = (value: string): string =>
  value.replace(SGR, "").replace(OSC8, "");

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for Ink to finish reacting to whatever was just written.
 *
 * A flat sleep is not good enough here and the failure mode is nasty: the
 * splash screen is expensive to lay out, so under load a repaint can land
 * hundreds of milliseconds late, and a test that reads too early asserts
 * against the *previous* frame — which for a "did nothing happen?" case
 * passes for the wrong reason. So: clear Ink's Esc-disambiguation window
 * first, then wait until the frame has stopped moving.
 */
async function settleOn(read: () => string): Promise<void> {
  await sleep(FLUSH_MS);
  let quiet = 0;
  let previous = read();
  for (let i = 0; i < 25; i++) {
    await sleep(30);
    const current = read();
    if (current === previous) {
      if (++quiet === 3) return;
      continue;
    }
    quiet = 0;
    previous = current;
  }
}

/**
 * Poll until `predicate` holds. Used where the frame never goes quiet —
 * a running turn animates its waiting phrase forever, so `settleOn` would
 * burn its whole budget and still read a half-updated screen.
 */
async function waitUntil(predicate: () => boolean): Promise<void> {
  await sleep(FLUSH_MS);
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await sleep(25);
  }
}

function trackingCallbacks(counts: {
  quit: number;
  abort: number;
}): TuiAppCallbacks {
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

function mount() {
  const counts = { quit: 0, abort: 0 };
  const bus = makeTuiEventBus();
  const rendered = render(
    <TuiApp session={SESSION} bus={bus} callbacks={trackingCallbacks(counts)} />,
  );
  const frame = (): string => strip(rendered.lastFrame() ?? "");
  const menuIsOpen = (): boolean => frame().includes(MENU_FOOTER);
  const settle = (): Promise<void> => settleOn(frame);
  return { ...rendered, bus, counts, frame, menuIsOpen, settle, waitUntil };
}

/**
 * Esc reaching the bottom of its ladder opens the operator menu. Every
 * case below is one rung of that ladder holding, or the bottom being
 * reached. The rung that is *not* here is the scrolled-transcript one:
 * this harness starts on the splash screen, whose content measures zero
 * rows, so `ChatLog` self-corrects any scroll offset back to zero within
 * a frame or two and the state cannot be held open long enough to press
 * a key into. `escapeOpensMenu` covers that rung directly in
 * `app-key-bindings.test.ts`.
 */
describe("Esc opens the operator menu", () => {
  it("opens the menu on an idle, empty Run screen", async () => {
    const app = mount();
    await app.settle();
    expect(app.menuIsOpen()).toBe(false);

    app.stdin.write(ESC);
    await app.settle();

    expect(app.menuIsOpen()).toBe(true);
    expect(app.counts.quit).toBe(0);
    expect(app.counts.abort).toBe(0);
    app.unmount();
  });

  it("closes on the next Esc rather than toggling on the opening press", async () => {
    // Ink hands the same keypress to every live `useInput`, so the press
    // that opens the menu also reaches `handleAppKey`. If that layer saw
    // the fresh `menuOpen` it would close the popup in the same frame and
    // Esc would look inert.
    const app = mount();
    await app.settle();
    app.stdin.write(ESC);
    await app.settle();
    expect(app.menuIsOpen()).toBe(true);

    app.stdin.write(ESC);
    await app.settle();

    expect(app.menuIsOpen()).toBe(false);
    app.unmount();
  });

  it("lets a draft keep Esc, and opens the menu on the press after", async () => {
    const app = mount();
    await app.settle();
    app.stdin.write("half typed");
    await app.settle();
    expect(app.frame()).toContain("half typed");

    app.stdin.write(ESC);
    await app.settle();
    expect(app.frame()).not.toContain("half typed");
    expect(app.menuIsOpen()).toBe(false);

    app.stdin.write(ESC);
    await app.settle();
    expect(app.menuIsOpen()).toBe(true);
    app.unmount();
  });

  it("lets the slash palette keep Esc", async () => {
    const app = mount();
    await app.settle();
    app.stdin.write("/");
    await app.settle();
    // The palette's own hint row. The command names themselves are no
    // good as a marker — the splash screen lists half of them as tips.
    expect(app.frame()).toContain("tab/enter");

    app.stdin.write(ESC);
    await app.settle();
    expect(app.frame()).not.toContain("tab/enter");
    expect(app.menuIsOpen()).toBe(false);

    // Closing the palette leaves the `/` it was completing in the buffer,
    // so the draft rung is next and it takes a third press to reach the
    // menu. Two rungs, two presses — the point is that neither is skipped.
    app.stdin.write(ESC);
    await app.settle();
    expect(app.menuIsOpen()).toBe(false);

    app.stdin.write(ESC);
    await app.settle();
    expect(app.menuIsOpen()).toBe(true);
    app.unmount();
  });

  it("lets the run-mode dial keep Esc", async () => {
    const app = mount();
    await app.settle();
    app.bus.emit({ type: "run_mode_picker_opened" });
    await app.settle();
    expect(app.frame()).toContain("Run mode");

    app.stdin.write(ESC);
    await app.settle();

    expect(app.frame()).not.toContain("Run mode");
    expect(app.menuIsOpen()).toBe(false);
    app.unmount();
  });

  it("lets a focused sidebar keep Esc", async () => {
    const app = mount();
    await app.settle();
    app.stdin.write(TAB);
    await app.settle();
    // The rail's own hint row — proof focus really moved, so the Esc
    // below is being declined by the sidebar rather than by nothing.
    expect(app.frame()).toContain("back to editor");

    app.stdin.write(ESC);
    await app.settle();

    expect(app.frame()).not.toContain("back to editor");
    expect(app.menuIsOpen()).toBe(false);
    app.unmount();
  });

  it("lets a running turn keep Esc for the abort", async () => {
    const app = mount();
    await app.settle();
    app.bus.emitAgentEvent({ type: "turn_started", turnIndex: 0 });
    // The running screen animates its waiting phrase, so wait on the
    // hint strip flipping to the running row rather than on a quiet frame.
    await app.waitUntil(() => app.frame().includes("ctrl+t"));
    expect(app.frame()).toContain("ctrl+t");

    app.stdin.write(ESC);
    await app.waitUntil(() => app.counts.abort > 0);

    expect(app.counts.abort).toBeGreaterThan(0);
    expect(app.menuIsOpen()).toBe(false);
    app.unmount();
  });

  it("lets an open panel keep Esc for the way home to Run", async () => {
    const app = mount();
    await app.settle();
    app.bus.emit({ type: "ui_mode_set", mode: "debug" });
    app.bus.emit({ type: "tab_changed", tab: "skills" });
    await app.settle();

    app.stdin.write(ESC);
    await app.settle();
    expect(app.menuIsOpen()).toBe(false);
    // Back on Run — the run-mode strip only renders on the chat surface.
    expect(app.frame()).toContain("▸ Local");

    app.stdin.write(ESC);
    await app.settle();
    expect(app.menuIsOpen()).toBe(true);
    app.unmount();
  });

  it("still never quits, however many times Esc is pressed", async () => {
    const app = mount();
    await app.settle();
    for (let i = 0; i < 6; i++) {
      app.stdin.write(ESC);
      await app.settle();
    }
    expect(app.counts.quit).toBe(0);
    app.unmount();
  });

  it("keeps a stray key out of the prompt once Esc has opened the menu", async () => {
    // The menu takes focus off the editor — the only thing that stops a
    // key reaching it — so what the operator types next drives the menu's
    // search box and never lands in the message they were not writing.
    const app = mount();
    await app.settle();
    app.stdin.write(ESC);
    await app.settle();

    app.stdin.write("z");
    await app.settle();

    expect(app.menuIsOpen()).toBe(true);
    expect(app.frame()).toContain("Menu  ❯ z");
    app.unmount();
  });
});
