import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "../tui-app.js";
import type { TuiSessionInfo } from "../tui-state.js";
import { COMPOSER_ROWS } from "./debug-pane.js";
import {
  COMPOSER_CHROME_ROWS,
  maxComposerEditorLines,
} from "./composer-overlay.js";

const SESSION: TuiSessionInfo = {
  sessionId: "s1",
  workingDir: "/tmp/overlay",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

function callbacks(): TuiAppCallbacks {
  return {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {},
    onMessageSubmitted: () => {},
  };
}

const strip = (value: string): string =>
  value.replace(/\u001B\[[0-9;]*m/g, "");

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Frames commit on Ink's own throttle, so nothing here asserts against
 * a fixed wait: poll the frame until the condition holds, then assert.
 */
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

/** Frame row of the first line containing `needle`, or -1. */
function rowOf(frame: string, needle: string): number {
  return frame.split("\n").findIndex((line) => line.includes(needle));
}

/** Frame row of the LAST line containing `needle` — the composer's edge. */
function lastRowOf(frame: string, needle: string): number {
  const lines = frame.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line !== undefined && line.includes(needle)) return i;
  }
  return -1;
}

function mount() {
  const bus = makeTuiEventBus();
  const app = render(
    <TuiApp session={SESSION} bus={bus} callbacks={callbacks()} />,
  );
  return { bus, ...app, frame: () => strip(app.lastFrame() ?? "") };
}

/**
 * Two finalised replies fill the bottom of the chat viewport, so the
 * transcript has a line high in the pane (the reference that must not
 * move) and a line at the pane's bottom edge (the one the expanded
 * composer must occlude).
 */
function seedChat(bus: ReturnType<typeof makeTuiEventBus>): void {
  const reply = (text: string): void =>
    bus.emit({
      type: "agent_event",
      event: { type: "llm_event", event: { type: "assistant_reply", text } },
    });
  reply("REF-ALPHA anchor line");
  reply("OMEGA-COVERED bottom line");
}

describe("maxComposerEditorLines", () => {
  const CASES: ReadonlyArray<{ stageRows: number; expected: number }> = [
    // The default test terminal: 24 rows → an 11-row pane + a 9-row slot.
    { stageRows: 20, expected: 10 },
    // A 30-row terminal.
    { stageRows: 27, expected: 17 },
    // Boundary where the cap meets its floor of three lines.
    { stageRows: 13, expected: 3 },
    { stageRows: 14, expected: 4 },
    // Degenerate stages never push the floor below three.
    { stageRows: 10, expected: 3 },
    { stageRows: 0, expected: 3 },
  ];
  for (const { stageRows, expected } of CASES) {
    it(`caps a ${stageRows}-row stage at ${expected} editor lines`, () => {
      expect(maxComposerEditorLines(stageRows)).toBe(expected);
    });
  }

  it("the slot never exceeds the layout budget reserved for it", () => {
    // `COMPOSER_ROWS` (the debug-pane budget) errs generous on purpose;
    // the painted slot must fit inside it or the budgets upstream
    // (`appChromeRows`, `computeChatViewportRows`) stop covering us.
    expect(COMPOSER_CHROME_ROWS + 1).toBeLessThanOrEqual(COMPOSER_ROWS);
  });
});

describe("composer overlay growth", () => {
  it("grows upward over a still transcript and shrinks back", async () => {
    const app = mount();
    await waitUntil(() => app.frame().includes("send"), "composer on screen");
    seedChat(app.bus);
    await waitUntil(
      () =>
        app.frame().includes("REF-ALPHA") &&
        app.frame().includes("OMEGA-COVERED"),
      "seeded transcript",
    );

    app.stdin.write("abc");
    await waitUntil(() => app.frame().includes("abc"), "typed text");
    const before = app.frame();
    const refRowBefore = rowOf(before, "REF-ALPHA");
    const topBorderBefore = lastRowOf(before, "╭");
    const bottomBorderBefore = lastRowOf(before, "╰");
    expect(refRowBefore).toBeGreaterThanOrEqual(0);
    expect(topBorderBefore).toBeGreaterThan(refRowBefore);

    // Three newlines: the composer must grow three rows upward while
    // everything above it stays painted on the same rows.
    app.stdin.write("\n\n\n");
    await waitUntil(
      () => lastRowOf(app.frame(), "╭") === topBorderBefore - 3,
      "composer top border three rows higher",
    );
    const grown = app.frame();
    // The reference line did not move: the transcript was not reflowed
    // and its scroll position did not jump.
    expect(rowOf(grown, "REF-ALPHA")).toBe(refRowBefore);
    // The bottom edge did not move either — growth is upward only, the
    // hint strip under the composer stays where it is.
    expect(lastRowOf(grown, "╰")).toBe(bottomBorderBefore);
    // The frame is opaque: the second message's `[copy]` control sat on
    // a row the expanded frame now covers, so only the first message's
    // copy row survives. (The row directly above the frame still shows
    // through — that is the overlay's spacer row, deliberately open.)
    const copyRows = (frame: string): number =>
      frame.split("\n").filter((line) => line.includes("[copy]")).length;
    expect(copyRows(before)).toBe(2);
    expect(copyRows(grown)).toBe(1);

    // Delete the newlines: the original frame comes back byte for byte
    // — transcript, borders, everything. One backspace per write: Ink
    // folds a burst of DEL bytes into a single keypress, so a batched
    // write would only delete one character.
    for (let i = 0; i < 3; i += 1) {
      app.stdin.write("\u007F");
      await delay(30);
    }
    await waitUntil(
      () => app.frame() === before,
      "original frame after shrink",
    );
    app.unmount();
  });

  it("clamps to its slot while the menu is open and re-expands on close", async () => {
    const app = mount();
    await waitUntil(() => app.frame().includes("send"), "composer on screen");
    seedChat(app.bus);
    await waitUntil(
      () => app.frame().includes("OMEGA-COVERED"),
      "seeded transcript",
    );
    app.stdin.write("abc");
    await waitUntil(() => app.frame().includes("abc"), "typed text");
    const collapsedTop = lastRowOf(app.frame(), "╭");

    // Nine newlines: a ten-line draft, deep enough that the expanded
    // frame's rectangle overlaps the rows where the menu paints.
    app.stdin.write("\n".repeat(9));
    await waitUntil(
      () => lastRowOf(app.frame(), "╭") === collapsedTop - 9,
      "expanded composer",
    );

    // Open the menu the way that keeps the draft — the breadcrumb's
    // dispatch (from the keyboard, Esc would clear the draft first).
    // The menu owns the keyboard, so the overlay must stop fighting it
    // for the stage — the composer paints after the menu, and
    // un-clamped it would bury the menu's bottom rows while the raised
    // mouse floor kept routing clicks there.
    app.bus.emit({ type: "menu_opened" });
    await waitUntil(() => app.frame().includes("enter go"), "menu open");
    const withMenu = app.frame();
    // The composer fell back to its collapsed slot…
    expect(lastRowOf(withMenu, "╭")).toBe(collapsedTop);
    // …so the whole menu is on screen: its bottom border (the first ╰
    // from the top — the composer's own is the last) closes strictly
    // above the composer's frame instead of vanishing under it.
    const menuBottom = rowOf(withMenu, "╰");
    expect(menuBottom).toBeGreaterThan(0);
    expect(menuBottom).toBeLessThan(lastRowOf(withMenu, "╭"));

    // Esc: the modal is gone, the untouched draft re-expands.
    app.stdin.write("\u001b");
    await waitUntil(
      () => lastRowOf(app.frame(), "╭") === collapsedTop - 9,
      "composer re-expanded after the menu closed",
    );
    app.unmount();
  });

  it("never grows past its cap however many lines are typed", async () => {
    const app = mount();
    await waitUntil(() => app.frame().includes("send"), "composer on screen");
    app.stdin.write("x");
    await waitUntil(() => app.frame().includes("x"), "typed text");
    const statusRow = 0;

    // Far more newlines than the 24-row test terminal can seat: the
    // cap (10 lines here) must hold the frame's shape steady.
    app.stdin.write("\n".repeat(30));
    await delay(300);
    const frame = app.frame();
    const topBorder = lastRowOf(frame, "╭");
    // The status bar row is untouched and the composer's top border
    // sits strictly below it — the overlay stopped at its cap instead
    // of climbing the whole stage.
    expect(topBorder).toBeGreaterThan(statusRow + 1);
    // Frame height itself did not change: growth happened inside the
    // stage, not by pushing the root taller.
    const linesTyped = frame.split("\n").length;
    app.stdin.write("\n");
    await delay(200);
    expect(app.frame().split("\n").length).toBe(linesTyped);
    app.unmount();
  });
});
