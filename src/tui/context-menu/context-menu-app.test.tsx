import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import {
  ClipboardProvider,
  ClipboardReaderProvider,
  createStaticClipboardReader,
} from "../clipboard/index.js";
import { makeMouseSource } from "../mouse/mouse-source.js";
import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "../tui-app.js";
import type { TuiSessionInfo } from "../tui-state.js";

/**
 * The right-click cut/copy/paste menu, end to end: real Ink layout,
 * real hit-testing, the real registry floor. What matters most here is
 * the part unit tests cannot see — that the menu opens ON TOP of a
 * composer that has NOT collapsed (its own floor, not
 * `modalOwnsInput`), and that its rows act through the same helpers the
 * keyboard chords use.
 */

const SESSION: TuiSessionInfo = {
  sessionId: "s1",
  workingDir: "/tmp/context-menu",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

const strip = (value: string): string => value.replace(/\[[0-9;]*m/g, "");

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

function press(button: "left" | "right", x: number, y: number): TuiMouseEvent {
  return {
    kind: "press",
    button,
    wheel: null,
    x,
    y,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

function motion(x: number, y: number): TuiMouseEvent {
  return { ...press("left", x, y), kind: "motion" };
}

function release(x: number, y: number): TuiMouseEvent {
  return { ...press("left", x, y), kind: "release", button: "none" };
}

function locate(frame: string, needle: string): { x: number; y: number } {
  const lines = frame.split("\n");
  for (const [y, line] of lines.entries()) {
    const x = line.indexOf(needle);
    if (x !== -1) return { x, y };
  }
  throw new Error(`"${needle}" is not on screen:\n${frame}`);
}

function mountApp(clipboardText: string) {
  const bus = makeTuiEventBus();
  const mouse = makeMouseSource();
  const copied: string[] = [];
  const writer = {
    copy: async (text: string) => {
      copied.push(text);
      return true;
    },
  };
  const callbacks: TuiAppCallbacks = {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {},
    onMessageSubmitted: () => {},
  };
  const app = render(
    <ClipboardProvider writer={writer}>
      <ClipboardReaderProvider
        reader={createStaticClipboardReader(clipboardText)}
      >
        <TuiApp session={SESSION} bus={bus} callbacks={callbacks} mouse={mouse} />
      </ClipboardReaderProvider>
    </ClipboardProvider>,
  );
  return {
    ...app,
    mouse,
    copied,
    frame: () => strip(app.lastFrame() ?? ""),
  };
}

/** True within `timeoutMs`, or false — never throws. */
async function poll(
  condition: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await delay(25);
  }
  return condition();
}

/**
 * Right-click `at` until the menu is visibly up. ONE press per settle
 * window: the test renderer paints at ~4fps, so a press emitted while
 * the previous open is still unpainted would land on the backdrop and
 * close the menu it cannot yet see.
 */
async function openMenuAt(
  app: ReturnType<typeof mountApp>,
  at: () => { x: number; y: number },
  opened: () => boolean,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (opened()) return;
    const { x, y } = at();
    app.mouse.emit(press("right", x, y));
    await poll(opened, 800);
  }
  throw new Error(`the context menu never opened:\n${app.frame()}`);
}

/**
 * Click the popup's `label` row until its action lands, re-opening the
 * menu (same anchor) if a click fell on the backdrop and dismissed it.
 */
async function actViaMenu(
  app: ReturnType<typeof mountApp>,
  at: () => { x: number; y: number },
  label: string,
  settled: () => boolean,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (settled()) return;
    if (!app.frame().includes(row(label))) {
      const { x, y } = at();
      app.mouse.emit(press("right", x, y));
      await poll(() => app.frame().includes(row(label)), 800);
      continue;
    }
    // The frame and the commit's passive effects land on the same
    // ~4fps tick here, so a click issued the instant the row is
    // visible can race the row's own registration. One tick of grace
    // mirrors a human, who cannot click a menu the same millisecond it
    // appears; the retry loop around this covers the residual window.
    await delay(120);
    const spot = locate(app.frame(), row(label));
    // +2 skips the border glyph and its gutter — the label's cell.
    app.mouse.emit(press("left", spot.x + 2, spot.y));
    await poll(settled, 500);
  }
  throw new Error(`the "${label}" row never acted:\n${app.frame()}`);
}

/**
 * A popup row carries the frame's left border glyph on the same line
 * ("│ cut") — which is what tells it apart from the hint strip's
 * "[ctrl+x] cut" and the chat's "[copy]" buttons.
 */
const row = (label: string): string => `│ ${label}`;
const menuOpen = (frame: string): boolean => frame.includes(row("paste"));

describe("right-click context menu", () => {
  it("caret-only: opens paste-only, and paste inserts at the caret", async () => {
    const app = mountApp("WORLD");
    await waitUntil(() => app.frame().includes("send"), "composer on screen");
    app.stdin.write("hello ");
    await waitUntil(() => app.frame().includes("hello"), "typed draft");

    const spot = () => locate(app.frame(), "hello");
    await openMenuAt(app, () => ({ x: spot().x + 2, y: spot().y }), () =>
      menuOpen(app.frame()),
    );
    // Caret only: no cut, no copy.
    expect(app.frame()).not.toContain(row("cut"));
    expect(app.frame()).not.toContain(row("copy"));

    await actViaMenu(
      app,
      () => ({ x: spot().x + 2, y: spot().y }),
      "paste",
      () => app.frame().includes("hello WORLD"),
    );
    expect(app.frame()).toContain("hello WORLD");
    app.unmount();
  });

  it("with a selection: offers cut/copy/paste and cut goes through the editor's own helpers", async () => {
    const app = mountApp("");
    await waitUntil(() => app.frame().includes("send"), "composer on screen");
    app.stdin.write("hello world");
    await waitUntil(() => app.frame().includes("hello world"), "typed draft");

    // Drag-select "hello": press at its first cell, drag five cells,
    // release — the same gesture the selection tests use. The hint
    // strip flips to the cut/copy chords when the app has folded the
    // selection in, which is the observable "the drag landed".
    const start = locate(app.frame(), "hello world");
    await waitUntil(() => {
      app.mouse.emit(press("left", start.x, start.y));
      app.mouse.emit(motion(start.x + 5, start.y));
      app.mouse.emit(release(start.x + 5, start.y));
      return app.frame().includes("[ctrl+x] cut");
    }, "the drag selection to land");

    await openMenuAt(
      app,
      () => ({ x: start.x + 2, y: start.y }),
      () => app.frame().includes(row("cut")),
    );
    expect(app.frame()).toContain(row("copy"));
    expect(app.frame()).toContain(row("paste"));

    // Cut = the Ctrl+X pair: copy through the clipboard writer, then
    // delete the span from the buffer.
    await actViaMenu(
      app,
      () => ({ x: start.x + 2, y: start.y }),
      "cut",
      () => app.copied.includes("hello"),
    );
    await waitUntil(
      () => !app.frame().includes("hello world"),
      "the selection to be deleted",
    );
    expect(app.copied).toContain("hello");
    app.unmount();
  });

  it("keeps a multi-line composer at full height while the menu is open (no modal clamp)", async () => {
    const app = mountApp("");
    await waitUntil(() => app.frame().includes("send"), "composer on screen");
    app.stdin.write("alpha\nbravo\ncharlie");
    await waitUntil(() => app.frame().includes("charlie"), "three-line draft");

    const spot = () => locate(app.frame(), "bravo");
    await openMenuAt(app, () => ({ x: spot().x + 2, y: spot().y }), () =>
      menuOpen(app.frame()),
    );
    // The modal clamp (`composerMaxEditorLines -> 1`) must NOT apply.
    // A collapsed viewport would show ONLY the caret's line (charlie),
    // so "alpha" still being painted is the exemption. ("charlie" may
    // legitimately be covered by the popup itself, which opens on the
    // row below the click.)
    expect(app.frame()).toContain("alpha");

    // Esc closes the menu and ONLY the menu: the draft survives because
    // the editor stood down while the menu was up.
    app.stdin.write("\u001b");
    await waitUntil(() => !menuOpen(app.frame()), "the menu to close");
    expect(app.frame()).toContain("alpha");
    expect(app.frame()).toContain("charlie");
    app.unmount();
  });

  it("paste-only on the composer switch's filter buffer, through its own key layer", async () => {
    const app = mountApp("PASTED");
    await waitUntil(() => app.frame().includes("send"), "composer on screen");
    // Ctrl+R opens the route switch; its filter line is a hand-rolled
    // append-only buffer — the paste-only target.
    app.stdin.write("\u0012");
    await waitUntil(
      () => app.frame().includes("type to filter"),
      "the switch popup",
    );

    const spot = () => locate(app.frame(), "filter:");
    await openMenuAt(app, () => ({ x: spot().x + 3, y: spot().y }), () =>
      menuOpen(app.frame()),
    );
    expect(app.frame()).not.toContain(row("cut"));

    await actViaMenu(
      app,
      () => ({ x: spot().x + 3, y: spot().y }),
      "paste",
      () => app.frame().includes("PASTED"),
    );
    // The text went through `handleComposerSwitchKey`, so it landed in
    // the filter — not in the composer buffer behind the popup.
    expect(app.frame()).toContain("PASTED");
    app.unmount();
  });

  it("a click outside the popup closes it without acting", async () => {
    const app = mountApp("NOPE");
    await waitUntil(() => app.frame().includes("send"), "composer on screen");
    app.stdin.write("draft");
    await waitUntil(() => app.frame().includes("draft"), "typed draft");

    const spot = () => locate(app.frame(), "draft");
    await openMenuAt(app, () => ({ x: spot().x + 2, y: spot().y }), () =>
      menuOpen(app.frame()),
    );
    app.mouse.emit(press("left", 0, 0));
    await waitUntil(() => !menuOpen(app.frame()), "the menu to close");
    expect(app.frame()).toContain("draft");
    expect(app.frame()).not.toContain("NOPE");
    app.unmount();
  });
});
